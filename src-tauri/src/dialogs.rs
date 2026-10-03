// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "T060 implements the native dialogs, and T063 wires them"
    )
)]
#![cfg_attr(
    test,
    expect(
        dead_code,
        reason = "the T060 stubs read no input until T060 implements them"
    )
)]

use std::path::{Path, PathBuf};
use std::time::Instant;

use serde_json::Value;

use crate::bootstrap::Contexts;
use crate::settings::{Confirm, Marker, SavedGit, Settings};

/// One button of a `TaskDialogIndirect` confirmation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Button {
    pub id: i32,
    pub label: &'static str,
}

/// One native confirmation. Cancel is the default button. Only `accept_button` accepts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Confirmation {
    pub text: String,
    pub buttons: Vec<Button>,
    pub default_button: i32,
    pub accept_button: i32,
}

/// The native pickers and confirmations. T183 injects them, so the tests run without a window.
pub trait Native {
    /// The dialog plugin executable picker. `None` is Cancel.
    fn pick_executable(&self) -> Option<PathBuf>;
    /// The dialog plugin folder picker. `None` is Cancel.
    fn pick_folder(&self) -> Option<PathBuf>;
    /// The button ID that `TaskDialogIndirect` returns. `None` is a call failure.
    fn confirm(&self, confirmation: &Confirmation) -> Option<i32>;
    /// `SearchPathW` for `git.exe` with the shell `PATH` value as `lpPath`.
    fn search_path(&self) -> Option<PathBuf>;
    /// The `%ProgramFiles%` folder.
    fn program_files(&self) -> Option<PathBuf>;
}

/// The native step of `chooseGit`, `chooseRepository`, and `restoreWorkspace`.
#[derive(Debug, PartialEq, Eq)]
pub enum Chosen {
    /// The shell answers `canceled`, and no frame reaches the service.
    Canceled,
    /// A new bootstrap context for `path`.
    Context { bootstrap_id: String, path: PathBuf },
}

/// Creates a `gitProbe` context for the contract §3 "Git proposal" candidate: the saved path,
/// then the `PATH` search result, then `%ProgramFiles%\Git\cmd\git.exe`. Without a candidate, it opens the picker.
pub fn choose_git(
    _native: &dyn Native,
    _saved: Option<&SavedGit>,
    _contexts: &Contexts,
    _now: Instant,
) -> Chosen {
    todo!("T060")
}

/// Opens the folder picker and creates a `repositoryDiscovery` context.
pub fn choose_repository(_native: &dyn Native, _contexts: &Contexts, _now: Instant) -> Chosen {
    todo!("T060")
}

/// Creates a `repositoryDiscovery` context for the stored last repository.
pub fn restore_workspace(_settings: &Settings, _contexts: &Contexts, _now: Instant) -> Chosen {
    todo!("T060")
}

/// The probed candidate of a `register` request with `confirm: true`.
pub struct Proposal<'a> {
    pub executable_path: &'a Path,
    pub version: &'a str,
    /// The stored version after `GIT_CHANGED` at the saved path (data-model §1).
    pub stored_version: Option<&'a str>,
}

/// The Git selection confirmation: Use this Git, Choose another Git, and Cancel.
pub fn git_confirmation(_proposal: &Proposal) -> Confirmation {
    todo!("T060")
}

/// The `register` reply `result` (contract §6 "Channel frames").
#[derive(Debug, PartialEq, Eq)]
pub enum Registered {
    Approved,
    Declined,
    /// A new `gitProbe` context for the picked file.
    Another {
        bootstrap_id: String,
        executable_path: PathBuf,
    },
}

impl Registered {
    pub fn reply(&self, _call_id: &str) -> Value {
        todo!("T060")
    }
}

/// Shows the Git selection confirmation. Choose another Git opens the executable picker.
pub fn confirm_git(
    _native: &dyn Native,
    _proposal: &Proposal,
    _contexts: &Contexts,
    _now: Instant,
) -> Registered {
    todo!("T060")
}

/// The trust confirmation: Approve and Cancel.
pub fn trust_confirmation(_request: &Confirm) -> Confirmation {
    todo!("T060")
}

/// True only for the Approve button.
pub fn confirm_trust(_native: &dyn Native, _request: &Confirm) -> bool {
    todo!("T060")
}

/// The marker dismissal confirmation: Dismiss and Cancel.
pub fn dismissal_confirmation(_marker: &Marker) -> Confirmation {
    todo!("T060")
}

/// True only for the Dismiss button.
pub fn confirm_dismissal(_native: &dyn Native, _marker: &Marker) -> bool {
    todo!("T060")
}

/// The renderer payload of a native-first operation. `dismissRecoveryMarker` holds exactly `markerId`; the others are empty.
/// Any other field gives `INVALID_REQUEST`.
pub fn check_renderer_payload(_operation: &str, _payload: &Value) -> Result<(), &'static str> {
    todo!("T060")
}

/// Binds a `repositoryDiscovery` context to the stored worktree path of the marker.
pub fn dismissal_context(
    _marker: &Marker,
    _contexts: &Contexts,
    _now: Instant,
) -> Result<String, &'static str> {
    todo!("T060")
}

/// The handshake `savedGit` object for the saved Git path (contract §6 "Startup contexts").
/// Without a saved Git path, there is no context.
pub fn startup_context(_settings: &Settings, _contexts: &Contexts, _now: Instant) -> Option<Value> {
    todo!("T060")
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::cell::RefCell;

    use serde_json::json;
    use windows::Win32::UI::WindowsAndMessaging::IDCANCEL;

    use crate::bootstrap::{ContextKind, read_identity};
    use crate::jobs::tests::Fixture;

    const SESSION: &str = "11111111-1111-4111-8111-111111111111";
    const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const FINGERPRINT: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    const CALL: &str = "0f0f0f0f-0000-4000-8000-0000000000cc";
    /// Contract §7 "Program file digests": the session-only text.
    const SESSION_ONLY: &str = "Arbareto cannot check these program files for later edits. This approval lasts until Arbareto closes or its Git service restarts.";

    /// How the injected confirmation answers.
    #[derive(Clone, Copy)]
    enum Press {
        /// The button with this label.
        Label(&'static str),
        /// Enter on the default button.
        Default,
        /// A raw ID: `IDCANCEL` for Escape, Alt+F4, and the close button.
        Id(i32),
        /// A failed `TaskDialogIndirect` call.
        Fail,
    }

    /// Escape, Alt+F4, the close button, Enter on the default, Cancel, an unknown ID, and a call failure.
    const CANCELS: [Press; 5] = [
        Press::Default,
        Press::Id(IDCANCEL.0),
        Press::Label("Cancel"),
        Press::Id(0),
        Press::Fail,
    ];

    #[derive(Default)]
    struct Fake {
        executable: Option<PathBuf>,
        folder: Option<PathBuf>,
        search: Option<PathBuf>,
        program_files: Option<PathBuf>,
        presses: RefCell<Vec<Press>>,
        calls: RefCell<Vec<&'static str>>,
    }

    impl Fake {
        fn pressing(presses: &[Press]) -> Fake {
            Fake {
                presses: RefCell::new(presses.iter().rev().copied().collect()),
                ..Fake::default()
            }
        }

        fn calls(&self) -> Vec<&'static str> {
            self.calls.borrow().clone()
        }
    }

    impl Native for Fake {
        fn pick_executable(&self) -> Option<PathBuf> {
            self.calls.borrow_mut().push("pick_executable");
            self.executable.clone()
        }

        fn pick_folder(&self) -> Option<PathBuf> {
            self.calls.borrow_mut().push("pick_folder");
            self.folder.clone()
        }

        fn confirm(&self, confirmation: &Confirmation) -> Option<i32> {
            self.calls.borrow_mut().push("confirm");
            match self.presses.borrow_mut().pop().expect("a scripted press") {
                Press::Label(label) => Some(id_of(confirmation, label)),
                Press::Default => Some(confirmation.default_button),
                Press::Id(id) => Some(id),
                Press::Fail => None,
            }
        }

        fn search_path(&self) -> Option<PathBuf> {
            self.calls.borrow_mut().push("search_path");
            self.search.clone()
        }

        fn program_files(&self) -> Option<PathBuf> {
            self.calls.borrow_mut().push("program_files");
            self.program_files.clone()
        }
    }

    fn id_of(confirmation: &Confirmation, label: &str) -> i32 {
        confirmation
            .buttons
            .iter()
            .find(|button| button.label == label)
            .unwrap_or_else(|| panic!("no {label} button"))
            .id
    }

    fn labels(confirmation: &Confirmation) -> Vec<&'static str> {
        confirmation.buttons.iter().map(|b| b.label).collect()
    }

    fn file(fixture: &Fixture, name: &str) -> PathBuf {
        let path = fixture.path(name);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("folder");
        std::fs::write(&path, name).expect("file");
        path
    }

    fn folder(fixture: &Fixture, name: &str) -> PathBuf {
        let path = fixture.path(name);
        std::fs::create_dir_all(&path).expect("folder");
        path
    }

    fn saved(path: &Path) -> SavedGit {
        SavedGit {
            executable_path: path.to_path_buf(),
            version: "2.55.0.windows.3".to_string(),
            digest: DIGEST.to_string(),
        }
    }

    fn context(contexts: &Contexts, chosen: &Chosen) -> (ContextKind, PathBuf) {
        match chosen {
            Chosen::Context { bootstrap_id, path } => {
                let context = contexts
                    .get(bootstrap_id, Instant::now())
                    .expect("live context");
                assert_eq!(&context.path, path);
                (context.kind, context.path)
            }
            Chosen::Canceled => panic!("expected a context, got Canceled"),
        }
    }

    fn marker(fixture: &Fixture) -> Marker {
        let worktree = folder(fixture, "repo");
        let common = folder(fixture, "repo\\.git");
        Marker {
            marker_id: "0f0f0f0f-0000-4000-8000-000000000001".to_string(),
            kind: "applyFile".to_string(),
            started_at: "2026-10-03T09:15:00Z".to_string(),
            worktree_root: worktree,
            common_identity: read_identity(&common).expect("identity"),
            common_directory: common,
        }
    }

    fn trust_request(fixture: &Fixture, persist: bool, bound: Option<&str>) -> Confirm {
        Confirm {
            worktree_root: folder(fixture, "repo"),
            git_directory: folder(fixture, "repo\\.git"),
            common_directory: fixture.path("repo\\.git"),
            git_installation_digest: DIGEST.to_string(),
            fingerprint: FINGERPRINT.to_string(),
            persist,
            bound: bound.map(str::to_string),
        }
    }

    fn display(path: &Path) -> String {
        path.display().to_string()
    }

    // ---- chooseGit candidate and picker ----

    #[test]
    fn a_saved_path_is_the_candidate_and_no_picker_opens() {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let saved_git = file(&fixture, "saved\\git.exe");
        let native = Fake {
            search: Some(file(&fixture, "path\\git.exe")),
            ..Fake::default()
        };
        let chosen = choose_git(&native, Some(&saved(&saved_git)), &contexts, Instant::now());
        assert_eq!(
            context(&contexts, &chosen),
            (ContextKind::GitProbe, saved_git)
        );
        assert!(!native.calls().contains(&"pick_executable"));
        assert!(
            !native.calls().contains(&"confirm"),
            "the confirmation follows the probe"
        );
    }

    #[test]
    fn without_a_saved_path_the_path_search_result_is_the_candidate() {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let found = file(&fixture, "path\\git.exe");
        let native = Fake {
            search: Some(found.clone()),
            program_files: Some(folder(&fixture, "pf")),
            ..Fake::default()
        };
        file(&fixture, "pf\\Git\\cmd\\git.exe");
        let chosen = choose_git(&native, None, &contexts, Instant::now());
        assert_eq!(context(&contexts, &chosen), (ContextKind::GitProbe, found));
        assert!(!native.calls().contains(&"pick_executable"));
    }

    #[test]
    fn without_a_path_search_result_the_program_files_git_is_the_candidate() {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let program_files_git = file(&fixture, "pf\\Git\\cmd\\git.exe");
        let native = Fake {
            program_files: Some(fixture.path("pf")),
            ..Fake::default()
        };
        let chosen = choose_git(&native, None, &contexts, Instant::now());
        assert_eq!(
            context(&contexts, &chosen),
            (ContextKind::GitProbe, program_files_git)
        );
        assert!(!native.calls().contains(&"pick_executable"));
    }

    #[test]
    fn without_any_candidate_the_picker_opens_and_an_accepted_executable_creates_a_git_probe_context()
     {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let picked = file(&fixture, "picked\\git.exe");
        let native = Fake {
            executable: Some(picked.clone()),
            program_files: Some(folder(&fixture, "pf-without-git")),
            ..Fake::default()
        };
        let chosen = choose_git(&native, None, &contexts, Instant::now());
        assert_eq!(context(&contexts, &chosen), (ContextKind::GitProbe, picked));
        assert_eq!(
            native
                .calls()
                .iter()
                .filter(|c| **c == "pick_executable")
                .count(),
            1
        );
    }

    #[test]
    fn a_canceled_picker_returns_canceled() {
        let contexts = Contexts::new(SESSION);
        let native = Fake::default();
        assert_eq!(
            choose_git(&native, None, &contexts, Instant::now()),
            Chosen::Canceled
        );
        assert!(native.calls().contains(&"pick_executable"));
        assert_eq!(
            choose_repository(&native, &contexts, Instant::now()),
            Chosen::Canceled
        );
        assert!(native.calls().contains(&"pick_folder"));
    }

    #[test]
    fn an_accepted_folder_creates_a_repository_discovery_context() {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let repository = folder(&fixture, "repo");
        let native = Fake {
            folder: Some(repository.clone()),
            ..Fake::default()
        };
        let chosen = choose_repository(&native, &contexts, Instant::now());
        assert_eq!(
            context(&contexts, &chosen),
            (ContextKind::RepositoryDiscovery, repository)
        );
    }

    // ---- Git selection confirmation ----

    #[test]
    fn the_git_confirmation_names_the_probed_path_and_version_with_a_cancel_default() {
        let fixture = Fixture::new();
        let path = file(&fixture, "path\\git.exe");
        let confirmation = git_confirmation(&Proposal {
            executable_path: &path,
            version: "2.55.0.windows.3",
            stored_version: None,
        });
        assert!(
            confirmation.text.contains(&display(&path)),
            "{}",
            confirmation.text
        );
        assert!(confirmation.text.contains("2.55.0.windows.3"));
        assert_eq!(
            labels(&confirmation),
            ["Use this Git", "Choose another Git", "Cancel"]
        );
        assert_eq!(confirmation.default_button, id_of(&confirmation, "Cancel"));
        assert_eq!(
            confirmation.accept_button,
            id_of(&confirmation, "Use this Git")
        );
    }

    #[test]
    fn after_git_changed_the_confirmation_also_names_the_stored_version() {
        let fixture = Fixture::new();
        let path = file(&fixture, "saved\\git.exe");
        let confirmation = git_confirmation(&Proposal {
            executable_path: &path,
            version: "2.56.0.windows.1",
            stored_version: Some("2.55.0.windows.3"),
        });
        assert!(confirmation.text.contains("2.56.0.windows.1"));
        assert!(confirmation.text.contains("2.55.0.windows.3"));
    }

    #[test]
    fn only_use_this_git_registers_the_candidate() {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let path = file(&fixture, "path\\git.exe");
        let proposal = Proposal {
            executable_path: &path,
            version: "2.55.0.windows.3",
            stored_version: None,
        };
        let native = Fake::pressing(&[Press::Label("Use this Git")]);
        assert_eq!(
            confirm_git(&native, &proposal, &contexts, Instant::now()),
            Registered::Approved
        );
        for press in CANCELS {
            let native = Fake::pressing(&[press]);
            assert_eq!(
                confirm_git(&native, &proposal, &contexts, Instant::now()),
                Registered::Declined
            );
            assert!(!native.calls().contains(&"pick_executable"));
        }
    }

    #[test]
    fn choose_another_git_opens_the_picker_and_replies_another_with_the_new_context() {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let path = file(&fixture, "path\\git.exe");
        let picked = file(&fixture, "picked\\git.exe");
        let proposal = Proposal {
            executable_path: &path,
            version: "2.55.0.windows.3",
            stored_version: None,
        };
        let native = Fake {
            executable: Some(picked.clone()),
            ..Fake::pressing(&[Press::Label("Choose another Git")])
        };
        let registered = confirm_git(&native, &proposal, &contexts, Instant::now());
        let Registered::Another {
            bootstrap_id,
            executable_path,
        } = &registered
        else {
            panic!("expected another, got {registered:?}");
        };
        assert_eq!(executable_path, &picked);
        let context = contexts
            .get(bootstrap_id, Instant::now())
            .expect("live context");
        assert_eq!(
            (context.kind, context.path),
            (ContextKind::GitProbe, picked.clone())
        );
        assert_eq!(
            registered.reply(CALL),
            json!({ "type": "register", "callId": CALL, "result": "another", "bootstrapId": bootstrap_id, "executablePath": picked })
        );
    }

    #[test]
    fn a_canceled_picker_after_choose_another_git_registers_nothing() {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let path = file(&fixture, "path\\git.exe");
        let proposal = Proposal {
            executable_path: &path,
            version: "2.55.0.windows.3",
            stored_version: None,
        };
        let native = Fake::pressing(&[Press::Label("Choose another Git")]);
        assert_eq!(
            confirm_git(&native, &proposal, &contexts, Instant::now()),
            Registered::Declined
        );
        assert!(native.calls().contains(&"pick_executable"));
    }

    #[test]
    fn the_register_replies_have_the_contract_shapes() {
        assert_eq!(
            Registered::Approved.reply(CALL),
            json!({ "type": "register", "callId": CALL, "result": "approved" })
        );
        assert_eq!(
            Registered::Declined.reply(CALL),
            json!({ "type": "register", "callId": CALL, "result": "declined" })
        );
    }

    // ---- Trust and dismissal confirmations ----

    #[test]
    fn the_trust_confirmation_names_the_worktree_and_the_fingerprint_with_a_cancel_default() {
        let fixture = Fixture::new();
        let request = trust_request(&fixture, true, None);
        let confirmation = trust_confirmation(&request);
        assert!(confirmation.text.contains(&display(&request.worktree_root)));
        assert!(confirmation.text.contains(FINGERPRINT));
        assert!(!confirmation.text.contains(SESSION_ONLY));
        assert_eq!(labels(&confirmation), ["Approve", "Cancel"]);
        assert_eq!(confirmation.default_button, id_of(&confirmation, "Cancel"));
        assert_eq!(confirmation.accept_button, id_of(&confirmation, "Approve"));
    }

    #[test]
    fn without_persist_the_trust_confirmation_names_the_bound_and_the_session_only_text() {
        let fixture = Fixture::new();
        // Contract §7 "Program file digests": the bound names map to the §5 row.
        for (bound, named) in [
            ("file-count", "64 files"),
            ("file-bytes", "1 MiB per file"),
            ("total-bytes", "8 MiB total"),
        ] {
            let confirmation = trust_confirmation(&trust_request(&fixture, false, Some(bound)));
            assert!(
                confirmation.text.contains(named),
                "{bound}: {}",
                confirmation.text
            );
            assert!(confirmation.text.contains(SESSION_ONLY), "{bound}");
        }
    }

    #[test]
    fn only_approve_accepts_the_trust_confirmation() {
        let fixture = Fixture::new();
        let request = trust_request(&fixture, true, None);
        assert!(confirm_trust(
            &Fake::pressing(&[Press::Label("Approve")]),
            &request
        ));
        for press in CANCELS {
            assert!(!confirm_trust(&Fake::pressing(&[press]), &request));
        }
    }

    #[test]
    fn the_dismissal_confirmation_names_the_worktree_the_kind_and_the_start_time() {
        let fixture = Fixture::new();
        let marker = marker(&fixture);
        let confirmation = dismissal_confirmation(&marker);
        assert!(confirmation.text.contains(&display(&marker.worktree_root)));
        assert!(confirmation.text.contains("applyFile"));
        assert!(confirmation.text.contains("2026-10-03T09:15:00Z"));
        assert!(
            confirmation.text.to_lowercase().contains("unknown"),
            "the outcome stays unknown"
        );
        assert_eq!(labels(&confirmation), ["Dismiss", "Cancel"]);
        assert_eq!(confirmation.default_button, id_of(&confirmation, "Cancel"));
        assert_eq!(confirmation.accept_button, id_of(&confirmation, "Dismiss"));
    }

    #[test]
    fn only_dismiss_accepts_the_dismissal_confirmation() {
        let fixture = Fixture::new();
        let marker = marker(&fixture);
        assert!(confirm_dismissal(
            &Fake::pressing(&[Press::Label("Dismiss")]),
            &marker
        ));
        for press in CANCELS {
            assert!(!confirm_dismissal(&Fake::pressing(&[press]), &marker));
        }
    }

    // ---- Renderer input ----

    #[test]
    fn a_renderer_payload_with_any_field_is_rejected() {
        for operation in ["chooseGit", "chooseRepository", "restoreWorkspace"] {
            assert_eq!(
                check_renderer_payload(operation, &json!({})),
                Ok(()),
                "{operation}"
            );
            for payload in [
                json!({ "executablePath": "C:\\Git\\cmd\\git.exe" }),
                json!({ "path": "C:\\repo" }),
                json!({ "fingerprint": FINGERPRINT }),
                json!([]),
                json!(null),
            ] {
                assert_eq!(
                    check_renderer_payload(operation, &payload),
                    Err("INVALID_REQUEST"),
                    "{operation} {payload}"
                );
            }
        }
        let marker_id = "0f0f0f0f-0000-4000-8000-000000000001";
        assert_eq!(
            check_renderer_payload("dismissRecoveryMarker", &json!({ "markerId": marker_id })),
            Ok(())
        );
        for payload in [
            json!({ "markerId": marker_id, "worktreeRoot": "C:\\elsewhere" }),
            json!({ "markerId": marker_id, "bootstrapId": marker_id }),
            json!({}),
        ] {
            assert_eq!(
                check_renderer_payload("dismissRecoveryMarker", &payload),
                Err("INVALID_REQUEST"),
                "{payload}"
            );
        }
    }

    #[test]
    fn a_dismissal_binds_a_discovery_context_to_the_stored_worktree_path() {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let marker = marker(&fixture);
        let bootstrap_id = dismissal_context(&marker, &contexts, Instant::now()).expect("context");
        let context = contexts
            .get(&bootstrap_id, Instant::now())
            .expect("live context");
        assert_eq!(
            (context.kind, context.path),
            (ContextKind::RepositoryDiscovery, marker.worktree_root)
        );
    }

    // ---- Startup contexts ----

    #[test]
    fn a_saved_git_path_gives_one_startup_git_probe_context() {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let git = file(&fixture, "saved\\git.exe");
        let settings = Settings {
            git: Some(saved(&git)),
            last_repository: Some(folder(&fixture, "repo")),
            window: None,
        };
        let saved_git = startup_context(&settings, &contexts, Instant::now()).expect("savedGit");
        let bootstrap_id = saved_git["bootstrapId"].as_str().expect("bootstrapId");
        assert_eq!(
            saved_git,
            json!({ "bootstrapId": bootstrap_id, "executablePath": git, "version": "2.55.0.windows.3", "digest": DIGEST })
        );
        let context = contexts
            .get(bootstrap_id, Instant::now())
            .expect("live context");
        assert_eq!((context.kind, context.path), (ContextKind::GitProbe, git));
    }

    #[test]
    fn without_a_saved_git_path_the_startup_creates_no_context() {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let settings = Settings {
            git: None,
            last_repository: Some(folder(&fixture, "repo")),
            window: None,
        };
        assert_eq!(startup_context(&settings, &contexts, Instant::now()), None);
    }

    #[test]
    fn restore_workspace_creates_a_discovery_context_for_the_stored_path() {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let repository = folder(&fixture, "repo");
        let settings = Settings {
            git: None,
            last_repository: Some(repository.clone()),
            window: None,
        };
        let chosen = restore_workspace(&settings, &contexts, Instant::now());
        assert_eq!(
            context(&contexts, &chosen),
            (ContextKind::RepositoryDiscovery, repository)
        );
    }
}
