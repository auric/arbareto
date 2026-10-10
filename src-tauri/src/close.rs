// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use serde_json::Value;
use windows::Win32::UI::WindowsAndMessaging::IDCANCEL;

use crate::dialogs::{Button, Confirmation, Native};
use crate::process_requests::is_identifier;
use crate::schema::mutation_request::StartedKind;

/// Escape, Alt+F4, the close button, and Enter on the default return `IDCANCEL`, so Stay open carries that ID.
const STAY_OPEN: i32 = IDCANCEL.0;
/// Custom button IDs stay clear of the common button IDs 1 to 11.
const INTERRUPT: i32 = 100;

const INVALID: &str = "INVALID_REQUEST";
const ENVELOPE_KEYS: [&str; 5] = ["version", "sessionId", "requestId", "operation", "payload"];

/// One close request: a renderer `requestClose` choice (contract §3), or a close of the main window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Request {
    Stay,
    CloseIfIdle,
    InterruptAndClose,
    /// The title-bar close button or Alt+F4 on the main window.
    Window,
}

impl Request {
    /// The renderer envelope of `requestClose`. The shell never forwards it.
    pub fn parse(envelope: &Value) -> Result<Request, &'static str> {
        let fields = envelope.as_object().ok_or(INVALID)?;
        match fields.get("version") {
            None => return Err(INVALID),
            Some(version) if version.as_u64() != Some(1) => return Err("PROTOCOL_VERSION"),
            Some(_) => {}
        }
        let identifier = |key| {
            fields
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(is_identifier)
        };
        let payload = fields
            .get("payload")
            .and_then(Value::as_object)
            .ok_or(INVALID)?;
        if fields.len() != ENVELOPE_KEYS.len()
            || !ENVELOPE_KEYS.iter().all(|key| fields.contains_key(*key))
            || !identifier("sessionId")
            || !identifier("requestId")
            || fields.get("operation").and_then(Value::as_str) != Some("requestClose")
            || payload.len() != 1
        {
            return Err(INVALID);
        }
        match payload.get("choice").and_then(Value::as_str) {
            Some("stay") => Ok(Request::Stay),
            Some("closeIfIdle") => Ok(Request::CloseIfIdle),
            Some("interruptAndClose") => Ok(Request::InterruptAndClose),
            _ => Err(INVALID),
        }
    }
}

/// The result of one close request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// A `stay` request. No prompt showed.
    Stay,
    /// The prompt gave any result other than Interrupt and close.
    StayOpen,
    /// The application closes.
    Close,
}

/// The mutations from their `started` reply with a marker ID to `ended` (contract §6 "Recovery markers").
/// Lingering Jobs never enter it.
#[derive(Default)]
pub struct Running(Mutex<HashMap<String, StartedKind>>);

impl Running {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, StartedKind>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn started(&self, operation_id: &str, kind: StartedKind) {
        self.lock().insert(operation_id.to_string(), kind);
    }

    pub fn ended(&self, operation_id: &str) {
        self.lock().remove(operation_id);
    }

    /// After a service exit, once the operation Jobs close. `ended` never arrives then.
    pub fn service_exited(&self) {
        self.lock().clear();
    }

    /// The kinds of the running mutations, sorted and without repeats.
    pub fn kinds(&self) -> Vec<StartedKind> {
        let mut kinds: Vec<StartedKind> = self.lock().values().copied().collect();
        kinds.sort();
        kinds.dedup();
        kinds
    }
}

/// The native close prompt for the running mutations (plan.md "Close during mutation").
pub fn prompt(kinds: &[StartedKind]) -> Confirmation {
    let names: Vec<&str> = kinds.iter().map(|kind| name(*kind)).collect();
    let (names, verb, object) = match names.as_slice() {
        [one] => (one.to_string(), "is", "it"),
        [first @ .., last] => (format!("{} and {last}", first.join(", ")), "are", "them"),
        [] => (String::new(), "is", "it"),
    };
    Confirmation {
        text: format!(
            "{names} {verb} running. Arbareto cannot guarantee a rollback if you interrupt {object}. The repository can keep a part of the change."
        ),
        buttons: vec![
            Button {
                id: INTERRUPT,
                label: "Interrupt and close",
            },
            Button {
                id: STAY_OPEN,
                label: "Stay open",
            },
        ],
        default_button: STAY_OPEN,
        accept_button: INTERRUPT,
    }
}

/// The operation names of contract §3 mutations. The `started` frame carries no hunk or file direction.
fn name(kind: StartedKind) -> &'static str {
    match kind {
        StartedKind::ApplyHunk => "Hunk staging",
        StartedKind::ApplyFile => "File staging",
        StartedKind::Commit => "Commit",
        StartedKind::UpdateSubmodules => "Update submodules",
    }
}

/// Decides one close request. Only the Interrupt and close button ID closes during a running mutation.
pub fn decide(request: Request, running: &Running, native: &dyn Native) -> Decision {
    if request == Request::Stay {
        return Decision::Stay;
    }
    let kinds = running.kinds();
    if kinds.is_empty() {
        return Decision::Close;
    }
    if native.confirm(&prompt(&kinds)) == Some(INTERRUPT) {
        Decision::Close
    } else {
        Decision::StayOpen
    }
}

/// The owned Jobs that an application close ends (contract §6 "Lingering Jobs").
pub trait Owner {
    fn close_operation_jobs(&self);
    fn close_lingering_jobs(&self);
    fn close_service_job(&self);
}

/// Closes the operation Jobs, then the lingering Jobs, then the service Job.
pub fn shut_down(owner: &dyn Owner) {
    owner.close_operation_jobs();
    owner.close_lingering_jobs();
    owner.close_service_job();
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::cell::RefCell;

    use serde_json::json;
    use windows::Win32::UI::WindowsAndMessaging::IDCANCEL;

    use crate::bootstrap::{PhysicalIdentity, read_identity};
    use crate::dialogs::tests::{Fake, Press};
    use crate::jobs::tests::Fixture;
    use crate::settings::{Markers, Started, StartedReply};

    const OPERATION: &str = "0f0f0f0f-0000-4000-8000-000000000001";
    const OTHER: &str = "0f0f0f0f-0000-4000-8000-000000000002";
    const INTERRUPT: &str = "Interrupt and close";
    const STAY_OPEN: &str = "Stay open";

    const CLOSING: [Request; 3] = [
        Request::CloseIfIdle,
        Request::InterruptAndClose,
        Request::Window,
    ];

    /// Enter on the default, Escape, Alt+F4, and the close button, Stay open, an unknown ID, and a call failure.
    const STAYS: [Press; 5] = [
        Press::Default,
        Press::Id(IDCANCEL.0),
        Press::Label(STAY_OPEN),
        Press::Id(0),
        Press::Fail,
    ];

    /// A `Fake` with no scripted press. A prompt panics.
    fn no_prompt() -> Fake {
        Fake::pressing(&[])
    }

    fn running(kinds: &[(&str, StartedKind)]) -> Running {
        let running = Running::default();
        for &(operation_id, kind) in kinds {
            running.started(operation_id, kind);
        }
        running
    }

    fn envelope(payload: Value) -> Value {
        json!({
            "version": 1,
            "sessionId": "0f0f0f0f-0000-4000-8000-0000000000aa",
            "requestId": "0f0f0f0f-0000-4000-8000-0000000000bb",
            "operation": "requestClose",
            "payload": payload,
        })
    }

    #[derive(Default)]
    struct Recorder(RefCell<Vec<&'static str>>);

    impl Owner for Recorder {
        fn close_operation_jobs(&self) {
            self.0.borrow_mut().push("operation");
        }
        fn close_lingering_jobs(&self) {
            self.0.borrow_mut().push("lingering");
        }
        fn close_service_job(&self) {
            self.0.borrow_mut().push("service");
        }
    }

    #[test]
    fn the_three_choices_parse() {
        for (choice, request) in [
            ("stay", Request::Stay),
            ("closeIfIdle", Request::CloseIfIdle),
            ("interruptAndClose", Request::InterruptAndClose),
        ] {
            assert_eq!(
                Request::parse(&envelope(json!({ "choice": choice }))),
                Ok(request)
            );
        }
    }

    #[test]
    fn another_payload_or_envelope_is_invalid() {
        for payload in [
            json!({}),
            json!({ "choice": "close" }),
            json!({ "choice": "Stay" }),
            json!({ "choice": true }),
            json!({ "choice": "stay", "extra": 1 }),
            json!(["stay"]),
        ] {
            assert_eq!(
                Request::parse(&envelope(payload.clone())),
                Err("INVALID_REQUEST"),
                "{payload}"
            );
        }
        let mut extra = envelope(json!({ "choice": "stay" }));
        extra["repositoryId"] = json!("0f0f0f0f-0000-4000-8000-0000000000cc");
        assert_eq!(Request::parse(&extra), Err("INVALID_REQUEST"));
        let mut session = envelope(json!({ "choice": "stay" }));
        session["sessionId"] = json!("not an id");
        assert_eq!(Request::parse(&session), Err("INVALID_REQUEST"));
    }

    #[test]
    fn another_version_is_a_protocol_error() {
        let mut version = envelope(json!({ "choice": "stay" }));
        version["version"] = json!(2);
        assert_eq!(Request::parse(&version), Err("PROTOCOL_VERSION"));
        version.as_object_mut().expect("object").remove("version");
        assert_eq!(Request::parse(&version), Err("INVALID_REQUEST"));
    }

    #[test]
    fn stay_never_prompts_with_or_without_a_running_mutation() {
        for running in [
            Running::default(),
            running(&[(OPERATION, StartedKind::Commit)]),
        ] {
            let native = no_prompt();
            assert_eq!(decide(Request::Stay, &running, &native), Decision::Stay);
            assert!(native.calls.borrow().is_empty(), "no prompt");
        }
    }

    #[test]
    fn without_a_running_mutation_each_close_request_closes_without_the_prompt() {
        for request in CLOSING {
            let native = no_prompt();
            assert_eq!(
                decide(request, &Running::default(), &native),
                Decision::Close,
                "{request:?}"
            );
            assert!(native.calls.borrow().is_empty(), "no prompt");
        }
    }

    #[test]
    fn during_a_mutation_only_the_interrupt_button_closes() {
        for request in CLOSING {
            let running = running(&[(OPERATION, StartedKind::Commit)]);
            let native = Fake::pressing(&[Press::Label(INTERRUPT)]);
            assert_eq!(
                decide(request, &running, &native),
                Decision::Close,
                "{request:?}"
            );
            assert_eq!(*native.calls.borrow(), ["confirm"], "one prompt");
        }
    }

    #[test]
    fn during_a_mutation_every_other_prompt_result_stays_open() {
        for request in CLOSING {
            for press in STAYS {
                let running = running(&[(OPERATION, StartedKind::UpdateSubmodules)]);
                let native = Fake::pressing(&[press]);
                assert_eq!(
                    decide(request, &running, &native),
                    Decision::StayOpen,
                    "{request:?}"
                );
                assert_eq!(*native.calls.borrow(), ["confirm"], "one prompt");
            }
        }
    }

    #[test]
    fn the_prompt_defaults_to_stay_open_and_escape_gives_stay_open() {
        let prompt = prompt(&[StartedKind::Commit]);
        let labels: Vec<&str> = prompt.buttons.iter().map(|button| button.label).collect();
        assert_eq!(labels, [INTERRUPT, STAY_OPEN]);
        let stay_open = prompt.buttons[1].id;
        assert_eq!(prompt.default_button, stay_open);
        assert_eq!(
            stay_open, IDCANCEL.0,
            "Escape, Alt+F4, and the close button"
        );
        assert_eq!(prompt.accept_button, prompt.buttons[0].id);
        assert_ne!(prompt.accept_button, IDCANCEL.0);
    }

    #[test]
    fn the_prompt_names_the_operation_and_the_rollback_limit() {
        for (kind, name) in [
            (StartedKind::Commit, "Commit"),
            (StartedKind::ApplyHunk, "Hunk staging"),
            (StartedKind::ApplyFile, "File staging"),
            (StartedKind::UpdateSubmodules, "Update submodules"),
        ] {
            let text = prompt(&[kind]).text;
            assert!(text.starts_with(&format!("{name} is running.")), "{text}");
            assert!(text.contains("cannot guarantee a rollback"), "{text}");
        }
        let both = prompt(&[StartedKind::Commit, StartedKind::UpdateSubmodules]).text;
        assert!(
            both.starts_with("Commit and Update submodules are running."),
            "{both}"
        );
    }

    #[test]
    fn the_running_kinds_are_sorted_without_repeats() {
        let running = running(&[
            (OPERATION, StartedKind::UpdateSubmodules),
            (OTHER, StartedKind::Commit),
            ("0f0f0f0f-0000-4000-8000-000000000003", StartedKind::Commit),
        ]);
        assert_eq!(
            running.kinds(),
            [StartedKind::Commit, StartedKind::UpdateSubmodules]
        );
        running.ended(OPERATION);
        assert_eq!(running.kinds(), [StartedKind::Commit]);
    }

    #[test]
    fn with_only_lingering_jobs_close_if_idle_closes_every_job_without_the_prompt() {
        // A Job that outlives `ended` lingers. The mutation still ended.
        let running = running(&[(OPERATION, StartedKind::Commit)]);
        running.ended(OPERATION);
        let native = no_prompt();
        assert_eq!(
            decide(Request::CloseIfIdle, &running, &native),
            Decision::Close
        );
        assert!(native.calls.borrow().is_empty(), "no prompt");
        let owner = Recorder::default();
        shut_down(&owner);
        assert!(owner.0.borrow().contains(&"lingering"));
    }

    #[test]
    fn interrupt_and_close_closes_the_operation_then_the_lingering_then_the_service_jobs() {
        let owner = Recorder::default();
        shut_down(&owner);
        assert_eq!(*owner.0.borrow(), ["operation", "lingering", "service"]);
    }

    #[test]
    fn after_a_service_exit_without_ended_close_if_idle_closes_and_the_marker_stays() {
        let fixture = Fixture::new();
        let common = fixture.path("repo/.git");
        std::fs::create_dir_all(&common).expect("common directory");
        let recovery = fixture.path("recovery");
        let markers = Markers::open(&recovery);
        let identity =
            |path: &std::path::Path| read_identity(path).ok().map(PhysicalIdentity::Windows);
        let reply = markers.started_with(
            &Started {
                operation_id: OPERATION,
                kind: "commit",
                worktree_root: &fixture.path("repo"),
                common_directory: &common,
            },
            markers.epoch(),
            &identity,
        );
        assert!(matches!(reply, StartedReply::Marker { .. }), "{reply:?}");
        let running = running(&[(OPERATION, StartedKind::Commit)]);

        // The shell closes the operation Jobs at the exit. Then the registry forgets the mutation.
        markers.service_exited();
        running.service_exited();

        let native = no_prompt();
        assert_eq!(
            decide(Request::CloseIfIdle, &running, &native),
            Decision::Close
        );
        assert!(native.calls.borrow().is_empty(), "no prompt");
        let files = std::fs::read_dir(&recovery).expect("recovery").count();
        assert_eq!(files, 1, "the marker file stays");
    }
}
