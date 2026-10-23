// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use serde_json::Value;
use windows::Win32::UI::WindowsAndMessaging::IDCANCEL;

use crate::dialogs::{Button, Confirmation, Native};
use crate::process_requests::is_identifier;
use crate::schema::mutation_request::{StartedAction, StartedDirection, StartedKind};

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

/// One running mutation by its plan.md "Status and fallback texts" mutation name.
/// Feature 003 plan.md D12: a `sync` takes the name of its action, and `integrate` is "Pull".
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Mutation {
    HunkStaging,
    HunkUnstaging,
    FileStaging,
    FileUnstaging,
    MarkResolved,
    Commit,
    UpdateSubmodules,
    Fetch,
    FetchAll,
    Pull,
    Push,
    ForcePush,
    Abort,
    Continue,
    Skip,
    /// Feature 003 plan.md D12: a clone has no `started` frame. The shell names it from its own clone contexts.
    Clone,
    // Feature 004 contract Δ6: kind `workbench` takes the name of its action, and kind `applyFiles` that of its direction.
    Switch,
    CreateBranch,
    RenameBranch,
    DeleteBranch,
    Merge,
    Rebase,
    ChooseOurs,
    ChooseTheirs,
    MergeTool,
    AddWorktree,
    RemoveWorktree,
    PruneWorktrees,
    SaveGitSettings,
    StageFiles,
    UnstageFiles,
    // Feature 005 contract Δ6.
    DeleteFiles,
    SaveGitignore,
    SaveExclude,
}

impl Mutation {
    /// The mutation of a `started` frame (contract §6 "Mutation frames", feature 003 and feature 004 contract Δ6).
    /// `None`: a hunk or file action without a direction, another kind with one, `resolve` outside a file action,
    /// `action` outside kinds `sync` and `workbench`, kind `sync` or `workbench` without an action of its own list,
    /// or kind `applyFiles` without `stage` or `unstage`.
    pub fn of(
        kind: StartedKind,
        direction: Option<StartedDirection>,
        action: Option<StartedAction>,
    ) -> Option<Mutation> {
        use StartedAction as A;
        use StartedDirection::{Resolve, Stage, Unstage};
        Some(match (kind, direction, action) {
            (StartedKind::ApplyHunk, Some(Stage), None) => Mutation::HunkStaging,
            (StartedKind::ApplyHunk, Some(Unstage), None) => Mutation::HunkUnstaging,
            (StartedKind::ApplyFile, Some(Stage), None) => Mutation::FileStaging,
            (StartedKind::ApplyFile, Some(Unstage), None) => Mutation::FileUnstaging,
            (StartedKind::ApplyFile, Some(Resolve), None) => Mutation::MarkResolved,
            (StartedKind::ApplyFiles, Some(Stage), None) => Mutation::StageFiles,
            (StartedKind::ApplyFiles, Some(Unstage), None) => Mutation::UnstageFiles,
            (StartedKind::Commit, None, None) => Mutation::Commit,
            (StartedKind::UpdateSubmodules, None, None) => Mutation::UpdateSubmodules,
            (StartedKind::Sync, None, Some(action)) => match action {
                A::Fetch => Mutation::Fetch,
                A::FetchAll => Mutation::FetchAll,
                A::Pull | A::Integrate => Mutation::Pull,
                A::Push => Mutation::Push,
                A::ForcePush => Mutation::ForcePush,
                A::Abort => Mutation::Abort,
                A::Continue => Mutation::Continue,
                A::Skip => Mutation::Skip,
                _ => return None,
            },
            (StartedKind::Workbench, None, Some(action)) => match action {
                A::Switch => Mutation::Switch,
                A::CreateBranch => Mutation::CreateBranch,
                A::RenameBranch => Mutation::RenameBranch,
                A::DeleteBranch => Mutation::DeleteBranch,
                A::Merge => Mutation::Merge,
                A::Rebase => Mutation::Rebase,
                A::ChooseOurs => Mutation::ChooseOurs,
                A::ChooseTheirs => Mutation::ChooseTheirs,
                A::Mergetool => Mutation::MergeTool,
                A::WorktreeAdd => Mutation::AddWorktree,
                A::WorktreeRemove => Mutation::RemoveWorktree,
                A::WorktreePrune => Mutation::PruneWorktrees,
                A::ConfigSave => Mutation::SaveGitSettings,
                A::DeleteFiles => Mutation::DeleteFiles,
                A::IgnoreSaveGitignore => Mutation::SaveGitignore,
                A::IgnoreSaveExclude => Mutation::SaveExclude,
                _ => return None,
            },
            _ => return None,
        })
    }

    /// The `started` kind of the mutation. A clone has no `started` frame.
    pub fn kind(self) -> Option<StartedKind> {
        use Mutation as M;
        Some(match self {
            M::HunkStaging | M::HunkUnstaging => StartedKind::ApplyHunk,
            M::FileStaging | M::FileUnstaging | M::MarkResolved => StartedKind::ApplyFile,
            M::Commit => StartedKind::Commit,
            M::UpdateSubmodules => StartedKind::UpdateSubmodules,
            M::Fetch
            | M::FetchAll
            | M::Pull
            | M::Push
            | M::ForcePush
            | M::Abort
            | M::Continue
            | M::Skip => StartedKind::Sync,
            M::Switch
            | M::CreateBranch
            | M::RenameBranch
            | M::DeleteBranch
            | M::Merge
            | M::Rebase
            | M::ChooseOurs
            | M::ChooseTheirs
            | M::MergeTool
            | M::AddWorktree
            | M::RemoveWorktree
            | M::PruneWorktrees
            | M::SaveGitSettings
            | M::DeleteFiles
            | M::SaveGitignore
            | M::SaveExclude => StartedKind::Workbench,
            M::StageFiles | M::UnstageFiles => StartedKind::ApplyFiles,
            M::Clone => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            Mutation::HunkStaging => "Hunk staging",
            Mutation::HunkUnstaging => "Hunk unstaging",
            Mutation::FileStaging => "File staging",
            Mutation::FileUnstaging => "File unstaging",
            Mutation::MarkResolved => "Mark resolved",
            Mutation::Commit => "Commit",
            Mutation::UpdateSubmodules => "Update submodules",
            Mutation::Fetch => "Fetch",
            Mutation::FetchAll => "Fetch all remotes",
            Mutation::Pull => "Pull",
            Mutation::Push => "Push",
            Mutation::ForcePush => "Force push with lease",
            Mutation::Abort => "Abort",
            Mutation::Continue => "Continue",
            Mutation::Skip => "Skip",
            Mutation::Clone => "Clone",
            Mutation::Switch => "Switch",
            Mutation::CreateBranch => "Create branch",
            Mutation::RenameBranch => "Rename branch",
            Mutation::DeleteBranch => "Delete branch",
            Mutation::Merge => "Merge",
            Mutation::Rebase => "Rebase",
            Mutation::ChooseOurs => "Choose ours",
            Mutation::ChooseTheirs => "Choose theirs",
            Mutation::MergeTool => "Merge tool",
            Mutation::AddWorktree => "Add worktree",
            Mutation::RemoveWorktree => "Remove worktree",
            Mutation::PruneWorktrees => "Prune worktrees",
            Mutation::SaveGitSettings => "Save Git settings",
            Mutation::StageFiles => "Stage files",
            Mutation::UnstageFiles => "Unstage files",
            Mutation::DeleteFiles => "Delete files",
            Mutation::SaveGitignore => "Save .gitignore",
            Mutation::SaveExclude => "Save info/exclude",
        }
    }
}

/// The mutations from their `started` reply with a marker ID to `ended` (contract §6 "Recovery markers").
/// A clone counts from the first request that owns its contexts to its `closeJob` (feature 003 contract Δ6).
/// Lingering Jobs never enter it.
#[derive(Default)]
pub struct Running(Mutex<HashMap<String, Mutation>>);

impl Running {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Mutation>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn started(&self, operation_id: &str, mutation: Mutation) {
        self.lock().insert(operation_id.to_string(), mutation);
    }

    pub fn ended(&self, operation_id: &str) {
        self.lock().remove(operation_id);
    }

    /// After a service exit, once the operation Jobs close. `ended` never arrives then.
    pub fn service_exited(&self) {
        self.lock().clear();
    }

    /// The running mutations, sorted and without repeats.
    pub fn mutations(&self) -> Vec<Mutation> {
        let mut mutations: Vec<Mutation> = self.lock().values().copied().collect();
        mutations.sort();
        mutations.dedup();
        mutations
    }
}

/// The native close prompt for the running mutations (plan.md "Close during mutation").
pub fn prompt(mutations: &[Mutation]) -> Confirmation {
    let names: Vec<&str> = mutations.iter().map(|mutation| mutation.name()).collect();
    let (names, verb, object) = match names.as_slice() {
        [one] => (one.to_string(), "is", "it"),
        [first @ .., last] => (format!("{} and {last}", first.join(", ")), "are", "them"),
        [] => (String::new(), "is", "it"),
    };
    Confirmation {
        instruction: None,
        details: None,
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
        shield: false,
    }
}

/// Decides one close request. Only the Interrupt and close button ID closes during a running mutation.
pub fn decide(request: Request, running: &Running, native: &dyn Native) -> Decision {
    if request == Request::Stay {
        return Decision::Stay;
    }
    let mutations = running.mutations();
    if mutations.is_empty() {
        return Decision::Close;
    }
    if native.confirm(&prompt(&mutations)) == Some(INTERRUPT) {
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

    fn running(mutations: &[(&str, Mutation)]) -> Running {
        let running = Running::default();
        for &(operation_id, mutation) in mutations {
            running.started(operation_id, mutation);
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
            running(&[(OPERATION, Mutation::Commit)]),
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
            let running = running(&[(OPERATION, Mutation::Commit)]);
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
                let running = running(&[(OPERATION, Mutation::UpdateSubmodules)]);
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
        let prompt = prompt(&[Mutation::Commit]);
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

    /// plan.md "Status and fallback texts" and feature 003 plan.md D12: the mutation names.
    #[test]
    fn the_prompt_names_the_operation_and_its_direction_and_the_rollback_limit() {
        use StartedAction as A;
        use StartedDirection::{Resolve, Stage, Unstage};
        for (kind, direction, action, name) in [
            (StartedKind::Commit, None, None, "Commit"),
            (StartedKind::ApplyHunk, Some(Stage), None, "Hunk staging"),
            (
                StartedKind::ApplyHunk,
                Some(Unstage),
                None,
                "Hunk unstaging",
            ),
            (StartedKind::ApplyFile, Some(Stage), None, "File staging"),
            (
                StartedKind::ApplyFile,
                Some(Unstage),
                None,
                "File unstaging",
            ),
            (StartedKind::ApplyFile, Some(Resolve), None, "Mark resolved"),
            (
                StartedKind::UpdateSubmodules,
                None,
                None,
                "Update submodules",
            ),
            (StartedKind::Sync, None, Some(A::Fetch), "Fetch"),
            (
                StartedKind::Sync,
                None,
                Some(A::FetchAll),
                "Fetch all remotes",
            ),
            (StartedKind::Sync, None, Some(A::Pull), "Pull"),
            (StartedKind::Sync, None, Some(A::Integrate), "Pull"),
            (StartedKind::Sync, None, Some(A::Push), "Push"),
            (
                StartedKind::Sync,
                None,
                Some(A::ForcePush),
                "Force push with lease",
            ),
            (StartedKind::Sync, None, Some(A::Abort), "Abort"),
            (StartedKind::Sync, None, Some(A::Continue), "Continue"),
            (StartedKind::Sync, None, Some(A::Skip), "Skip"),
        ] {
            let mutation = Mutation::of(kind, direction, action).expect("a valid frame");
            let text = prompt(&[mutation]).text;
            assert_eq!(
                text,
                format!(
                    "{name} is running. Arbareto cannot guarantee a rollback if you interrupt it. The repository can keep a part of the change."
                )
            );
        }
        let both = prompt(&[Mutation::Commit, Mutation::UpdateSubmodules]).text;
        assert_eq!(
            both,
            "Commit and Update submodules are running. Arbareto cannot guarantee a rollback if you interrupt them. The repository can keep a part of the change."
        );
        let pulls = running(&[
            (
                OPERATION,
                Mutation::of(StartedKind::Sync, None, Some(StartedAction::Pull)).expect("pull"),
            ),
            (
                OTHER,
                Mutation::of(StartedKind::Sync, None, Some(StartedAction::Integrate))
                    .expect("integrate"),
            ),
        ]);
        assert_eq!(
            prompt(&pulls.mutations()).text,
            "Pull is running. Arbareto cannot guarantee a rollback if you interrupt it. The repository can keep a part of the change."
        );
    }

    /// Feature 004 contract Δ6: the close prompt names each `workbench` action and each `applyFiles` direction.
    #[test]
    fn the_prompt_names_each_feature_004_action() {
        use StartedAction as A;
        use StartedDirection::{Stage, Unstage};
        let workbench = [
            (A::Switch, "Switch"),
            (A::CreateBranch, "Create branch"),
            (A::RenameBranch, "Rename branch"),
            (A::DeleteBranch, "Delete branch"),
            (A::Merge, "Merge"),
            (A::Rebase, "Rebase"),
            (A::ChooseOurs, "Choose ours"),
            (A::ChooseTheirs, "Choose theirs"),
            (A::Mergetool, "Merge tool"),
            (A::WorktreeAdd, "Add worktree"),
            (A::WorktreeRemove, "Remove worktree"),
            (A::WorktreePrune, "Prune worktrees"),
            (A::ConfigSave, "Save Git settings"),
            // Feature 005 contract Δ6.
            (A::DeleteFiles, "Delete files"),
            (A::IgnoreSaveGitignore, "Save .gitignore"),
            (A::IgnoreSaveExclude, "Save info/exclude"),
        ];
        let cases = workbench
            .map(|(action, name)| (StartedKind::Workbench, None, Some(action), name))
            .into_iter()
            .chain([
                (StartedKind::ApplyFiles, Some(Stage), None, "Stage files"),
                (
                    StartedKind::ApplyFiles,
                    Some(Unstage),
                    None,
                    "Unstage files",
                ),
            ]);
        for (kind, direction, action, name) in cases {
            let mutation = Mutation::of(kind, direction, action).expect("a valid frame");
            assert_eq!(mutation.kind(), Some(kind), "{name}");
            assert_eq!(
                prompt(&[mutation]).text,
                format!(
                    "{name} is running. Arbareto cannot guarantee a rollback if you interrupt it. The repository can keep a part of the change."
                )
            );
        }
        assert_eq!(Mutation::Clone.kind(), None, "a clone has no started frame");
    }

    /// Feature 005 contract Δ2 and Δ6: the actions `ignore-gitignore` and `ignore-exclude` go, so a `started` frame
    /// with one fails the generated type and gets INVALID_REQUEST. The close prompt names neither.
    #[test]
    fn the_004_ignore_actions_are_no_started_action() {
        for action in ["ignore-gitignore", "ignore-exclude"] {
            assert!(
                serde_json::from_value::<StartedAction>(json!(action)).is_err(),
                "{action}"
            );
        }
    }

    /// Feature 004 contract Δ6: a `workbench` frame carries a workbench action, a `sync` frame a sync action,
    /// and an `applyFiles` frame `stage` or `unstage`.
    #[test]
    fn a_feature_004_frame_outside_its_kind_rule_names_no_mutation() {
        use StartedAction as A;
        use StartedDirection::{Resolve, Stage};
        for (kind, direction, action) in [
            (StartedKind::Workbench, None, None),
            (StartedKind::Workbench, None, Some(A::Fetch)),
            (StartedKind::Workbench, Some(Stage), Some(A::Switch)),
            (StartedKind::Sync, None, Some(A::Switch)),
            (StartedKind::Sync, None, Some(A::Mergetool)),
            (StartedKind::ApplyFiles, None, None),
            (StartedKind::ApplyFiles, Some(Resolve), None),
            (StartedKind::ApplyFiles, Some(Stage), Some(A::Switch)),
            (StartedKind::Commit, None, Some(A::ConfigSave)),
        ] {
            assert_eq!(
                Mutation::of(kind, direction, action),
                None,
                "{kind:?} {direction:?} {action:?}"
            );
        }
    }

    /// Feature 003 plan.md D12: a running clone is "Clone", and a running clone with a sync names both.
    #[test]
    fn a_running_clone_is_named_clone() {
        assert_eq!(
            prompt(&running(&[(OPERATION, Mutation::Clone)]).mutations()).text,
            "Clone is running. Arbareto cannot guarantee a rollback if you interrupt it. The repository can keep a part of the change."
        );
        let fetch =
            Mutation::of(StartedKind::Sync, None, Some(StartedAction::Fetch)).expect("fetch");
        assert_eq!(
            prompt(&running(&[(OPERATION, Mutation::Clone), (OTHER, fetch)]).mutations()).text,
            "Fetch and Clone are running. Arbareto cannot guarantee a rollback if you interrupt them. The repository can keep a part of the change."
        );
    }

    /// Contract §6 "Mutation frames": only a hunk or file action carries a direction, and only a file action takes `resolve`.
    /// Feature 003 contract Δ6: only and always a `sync` frame carries `action`.
    #[test]
    fn a_kind_and_a_direction_that_do_not_match_name_no_mutation() {
        use StartedDirection::{Resolve, Stage, Unstage};
        let fetch = Some(StartedAction::Fetch);
        for (kind, direction, action) in [
            (StartedKind::ApplyHunk, None, None),
            (StartedKind::ApplyFile, None, None),
            (StartedKind::Commit, Some(Stage), None),
            (StartedKind::UpdateSubmodules, Some(Unstage), None),
            (StartedKind::ApplyHunk, Some(Resolve), None),
            (StartedKind::Commit, Some(Resolve), None),
            (StartedKind::Sync, None, None),
            (StartedKind::Sync, Some(Stage), fetch),
            (StartedKind::Sync, Some(Resolve), None),
            (StartedKind::Commit, None, fetch),
            (StartedKind::UpdateSubmodules, None, fetch),
            (StartedKind::ApplyFile, Some(Resolve), fetch),
            (StartedKind::ApplyHunk, Some(Stage), fetch),
        ] {
            assert_eq!(
                Mutation::of(kind, direction, action),
                None,
                "{kind:?} {direction:?} {action:?}"
            );
        }
    }

    #[test]
    fn the_running_mutations_are_sorted_without_repeats() {
        let running = running(&[
            (OPERATION, Mutation::UpdateSubmodules),
            (OTHER, Mutation::HunkUnstaging),
            (
                "0f0f0f0f-0000-4000-8000-000000000003",
                Mutation::HunkUnstaging,
            ),
            (
                "0f0f0f0f-0000-4000-8000-000000000004",
                Mutation::HunkStaging,
            ),
        ]);
        assert_eq!(
            running.mutations(),
            [
                Mutation::HunkStaging,
                Mutation::HunkUnstaging,
                Mutation::UpdateSubmodules
            ]
        );
        running.ended(OPERATION);
        assert_eq!(
            running.mutations(),
            [Mutation::HunkStaging, Mutation::HunkUnstaging]
        );
    }

    #[test]
    fn with_only_lingering_jobs_close_if_idle_closes_every_job_without_the_prompt() {
        // A Job that outlives `ended` lingers. The mutation still ended.
        let running = running(&[(OPERATION, Mutation::Commit)]);
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
        let running = running(&[(OPERATION, Mutation::Commit)]);

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
