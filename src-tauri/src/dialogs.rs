// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Instant;

use serde_json::{Value, json};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use windows::Win32::Foundation::{HWND, LPARAM, S_OK, WPARAM};
use windows::Win32::Storage::FileSystem::SearchPathW;
use windows::Win32::UI::Controls::{
    TASKDIALOG_BUTTON, TASKDIALOG_NOTIFICATIONS, TASKDIALOGCONFIG, TDF_ALLOW_DIALOG_CANCELLATION,
    TDF_POSITION_RELATIVE_TO_WINDOW, TDM_CLICK_BUTTON, TDN_CREATED, TDN_DESTROYED,
    TaskDialogIndirect,
};
use windows::Win32::UI::WindowsAndMessaging::{IDCANCEL, PostMessageW};
use windows::core::{HRESULT, HSTRING, PCWSTR, w};

use crate::bootstrap::{ContextKind, Contexts, is_absent};
use crate::ipc::MAIN_WINDOW;
use crate::process_requests::PATH_UNITS;
use crate::settings::{Confirm, Damaged, Marker, SavedGit, Settings};

/// Escape, Alt+F4, and the close button return `IDCANCEL`, so the Cancel button carries that ID.
const CANCEL: i32 = IDCANCEL.0;
/// Custom button IDs stay clear of the common button IDs 1 to 11.
const ACCEPT: i32 = 100;
const ANOTHER: i32 = 101;

/// Contract §7 "Program file digests": the text of an approval over a digest bound.
const SESSION_APPROVAL: &str = "Arbareto cannot check these program files for later edits. This approval lasts until Arbareto closes or its Git service restarts.";

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

/// `extra` goes between the accept button and Cancel.
fn confirmation(text: String, accept: &'static str, extra: Option<Button>) -> Confirmation {
    let mut buttons = vec![Button {
        id: ACCEPT,
        label: accept,
    }];
    buttons.extend(extra);
    buttons.push(Button {
        id: CANCEL,
        label: "Cancel",
    });
    Confirmation {
        text,
        buttons,
        default_button: CANCEL,
        accept_button: ACCEPT,
    }
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
    /// The shell cannot read the identity of the selected path. The renderer gets `rejected` with the code.
    Refused(&'static str),
}

/// A path whose identity the shell cannot read is refused with the code of that read (contract §6 "Registration bootstrap").
fn context(contexts: &Contexts, kind: ContextKind, path: PathBuf, now: Instant) -> Chosen {
    match contexts.create(kind, &path, now) {
        Ok(bootstrap_id) => Chosen::Context { bootstrap_id, path },
        Err(code) => Chosen::Refused(code),
    }
}

fn pick_git(native: &dyn Native, contexts: &Contexts, now: Instant) -> Chosen {
    native.pick_executable().map_or(Chosen::Canceled, |path| {
        context(contexts, ContextKind::GitProbe, path, now)
    })
}

/// Creates a `gitProbe` context for the contract §3 "Git proposal" candidate: the saved selected path,
/// then the `PATH` search result, then `%ProgramFiles%\Git\cmd\git.exe`. Without a candidate, it opens the picker.
/// A path whose identity cannot be read is no candidate.
pub fn choose_git(
    native: &dyn Native,
    saved: Option<&SavedGit>,
    contexts: &Contexts,
    now: Instant,
) -> Chosen {
    let probe = |path: PathBuf| match context(contexts, ContextKind::GitProbe, path, now) {
        chosen @ Chosen::Context { .. } => Some(chosen),
        _ => None,
    };
    saved
        .and_then(|git| probe(git.selected_path.clone()))
        .or_else(|| native.search_path().and_then(probe))
        .or_else(|| {
            native
                .program_files()
                .and_then(|folder| probe(folder.join(r"Git\cmd\git.exe")))
        })
        .unwrap_or_else(|| pick_git(native, contexts, now))
}

/// Opens the folder picker and creates a `repositoryDiscovery` context.
pub fn choose_repository(native: &dyn Native, contexts: &Contexts, now: Instant) -> Chosen {
    native.pick_folder().map_or(Chosen::Canceled, |path| {
        context(contexts, ContextKind::RepositoryDiscovery, path, now)
    })
}

/// Creates a `repositoryDiscovery` context for the stored last repository.
pub fn restore_workspace(settings: &Settings, contexts: &Contexts, now: Instant) -> Chosen {
    settings
        .last_repository
        .clone()
        .map_or(Chosen::Canceled, |path| {
            context(contexts, ContextKind::RepositoryDiscovery, path, now)
        })
}

/// The probed candidate of a `register` request with `confirm: true`.
pub struct Proposal<'a> {
    /// The path that the user selected. `resolveGit` can move the probe to another file.
    pub selected_path: &'a Path,
    /// The file that runs (contract §3 "Git proposal").
    pub executable_path: &'a Path,
    pub version: &'a str,
    /// The stored version when the probed file is the saved resolved path (data-model §1).
    pub stored_version: Option<&'a str>,
}

/// The Git selection confirmation: Use this Git, Choose another Git, and Cancel.
pub fn git_confirmation(proposal: &Proposal) -> Confirmation {
    let mut text = format!("Use this Git?\nPath: {}", proposal.selected_path.display());
    if proposal.executable_path != proposal.selected_path {
        text.push_str(&format!("\nRuns: {}", proposal.executable_path.display()));
    }
    text.push_str(&format!("\nVersion: {}", proposal.version));
    if let Some(stored) = proposal.stored_version {
        text.push_str(&format!("\nStored version: {stored}"));
    }
    confirmation(
        text,
        "Use this Git",
        Some(Button {
            id: ANOTHER,
            label: "Choose another Git",
        }),
    )
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
    pub fn reply(&self, call_id: &str) -> Value {
        match self {
            Registered::Approved => {
                json!({ "type": "register", "callId": call_id, "result": "approved" })
            }
            Registered::Declined => {
                json!({ "type": "register", "callId": call_id, "result": "declined" })
            }
            Registered::Another {
                bootstrap_id,
                executable_path,
            } => json!({
                "type": "register",
                "callId": call_id,
                "result": "another",
                "bootstrapId": bootstrap_id,
                "executablePath": executable_path.to_string_lossy(),
            }),
        }
    }
}

/// Shows the Git selection confirmation. Choose another Git opens the executable picker.
pub fn confirm_git(
    native: &dyn Native,
    proposal: &Proposal,
    contexts: &Contexts,
    now: Instant,
) -> Registered {
    let confirmation = git_confirmation(proposal);
    match native.confirm(&confirmation) {
        Some(id) if id == confirmation.accept_button => Registered::Approved,
        Some(ANOTHER) => match pick_git(native, contexts, now) {
            Chosen::Context { bootstrap_id, path } => Registered::Another {
                bootstrap_id,
                executable_path: path,
            },
            // The `register` reply has no refusal form.
            Chosen::Canceled | Chosen::Refused(_) => Registered::Declined,
        },
        _ => Registered::Declined,
    }
}

/// The probed Git of one distro (contract §11 "Git per distro").
pub struct WslProposal<'a> {
    pub distro: &'a str,
    /// The absolute Linux path of the Git file.
    pub git: &'a str,
    pub version: &'a str,
}

/// The WSL Git confirmation: Use this Git and Cancel, the default.
pub fn wsl_git_confirmation(proposal: &WslProposal) -> Confirmation {
    let text = format!(
        "Use this Git?\nDistro: {}\nPath: {}\nVersion: {}",
        proposal.distro, proposal.git, proposal.version
    );
    confirmation(text, "Use this Git", None)
}

/// Only Use this Git approves. Enter on the default, Escape, Alt+F4, the close button, and a call failure mean Cancel.
pub fn confirm_wsl_git(native: &dyn Native, proposal: &WslProposal) -> bool {
    let confirmation = wsl_git_confirmation(proposal);
    native.confirm(&confirmation) == Some(confirmation.accept_button)
}

/// The contract §7 "Program file digests" text of a `bound` name.
fn bound_text(bound: &str) -> Option<&'static str> {
    match bound {
        "file-count" => Some("64 files"),
        "file-bytes" => Some("1 MiB per file"),
        "total-bytes" => Some("8 MiB total"),
        "link" => Some("a link that Arbareto cannot follow"),
        "name" => Some("a file name that Arbareto cannot check"),
        _ => None,
    }
}

/// The trust confirmation: Approve and Cancel.
pub fn trust_confirmation(request: &Confirm) -> Confirmation {
    let mut text = format!(
        "Approve this repository?\nWorktree: {}\nFingerprint: {}\nApproval lets Git run the programs that this repository's configuration names.",
        request.worktree_root.display(),
        request.fingerprint
    );
    if !request.persist {
        if let Some(bound) = request.bound.as_deref().and_then(bound_text) {
            text.push_str(&format!("\nReached bound: {bound}."));
        }
        text.push_str(&format!(
            "\n{SESSION_APPROVAL} An edit of an unchecked file keeps this approval."
        ));
    }
    confirmation(text, "Approve", None)
}

/// True only for the Approve button.
pub fn confirm_trust(native: &dyn Native, request: &Confirm) -> bool {
    let confirmation = trust_confirmation(request);
    native.confirm(&confirmation) == Some(confirmation.accept_button)
}

/// The marker dismissal confirmation: Dismiss and Cancel.
pub fn dismissal_confirmation(marker: &Marker) -> Confirmation {
    let text = format!(
        "Dismiss this recovery marker?\nWorktree: {}\nOperation: {}\nStarted: {}\nThe operation outcome stays unknown.",
        marker.worktree_root.display(),
        marker.kind,
        marker.started_at
    );
    confirmation(text, "Dismiss", None)
}

/// True only for the Dismiss button.
pub fn confirm_dismissal(native: &dyn Native, marker: &Marker) -> bool {
    let confirmation = dismissal_confirmation(marker);
    native.confirm(&confirmation) == Some(confirmation.accept_button)
}

/// The damaged marker dismissal confirmation: Dismiss and Cancel (contract §6 "Dismissal").
pub fn damaged_dismissal_confirmation(damaged: &Damaged) -> Confirmation {
    let text = format!(
        "Dismiss this damaged recovery marker?
Damaged recovery marker: {}
Arbareto cannot read this file. The operation outcome stays unknown.",
        damaged.file_name
    );
    confirmation(text, "Dismiss", None)
}

/// True only for the Dismiss button.
pub fn confirm_damaged_dismissal(native: &dyn Native, damaged: &Damaged) -> bool {
    let confirmation = damaged_dismissal_confirmation(damaged);
    native.confirm(&confirmation) == Some(confirmation.accept_button)
}

/// The startup failure dialog. T142 adds Restart service.
pub fn service_stopped() -> Confirmation {
    Confirmation {
        text: "Git service stopped.".to_string(),
        buttons: vec![Button {
            id: ACCEPT,
            label: "Close Arbareto",
        }],
        default_button: ACCEPT,
        accept_button: ACCEPT,
    }
}

/// Binds a `repositoryDiscovery` context to the stored worktree path of the marker.
/// A worktree path that does not exist gives no context (contract §6 "Dismissal").
pub fn dismissal_context(
    marker: &Marker,
    contexts: &Contexts,
    now: Instant,
) -> Result<Option<String>, &'static str> {
    match contexts.create(ContextKind::RepositoryDiscovery, &marker.worktree_root, now) {
        Ok(bootstrap_id) => Ok(Some(bootstrap_id)),
        Err(_) if is_absent(&marker.worktree_root) => Ok(None),
        Err(code) => Err(code),
    }
}

/// The handshake `savedGit` object for the saved Git selection (contract §6 "Startup contexts").
/// The context binds the selected path. Without a saved Git, there is no object.
/// Without a readable file at the selected path, the object has no `bootstrapId`, and the service reports the path.
pub fn startup_context(settings: &Settings, contexts: &Contexts, now: Instant) -> Option<Value> {
    let git = settings.git.as_ref()?;
    let mut saved = json!({
        "selectedPath": git.selected_path.to_string_lossy(),
        "executablePath": git.executable_path.to_string_lossy(),
        "version": git.version,
        "digest": git.digest,
    });
    if let Ok(bootstrap_id) = contexts.create_startup(&git.selected_path, now) {
        saved["bootstrapId"] = json!(bootstrap_id);
    }
    Some(saved)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The product pickers and confirmations. The pickers block, so no caller runs on the main thread.
pub struct Dialogs {
    app: AppHandle,
    /// The open confirmation windows.
    open: Mutex<Vec<isize>>,
}

impl Dialogs {
    pub fn new(app: AppHandle) -> Dialogs {
        Dialogs {
            app,
            open: Mutex::new(Vec::new()),
        }
    }

    fn owner(&self) -> Option<WebviewWindow> {
        self.app.get_webview_window(MAIN_WINDOW)
    }

    /// Clicks Cancel in each open confirmation. A service exit closes each open trust dialog as Cancel (contract §6).
    pub fn cancel_open(&self) {
        for &hwnd in lock(&self.open).iter() {
            // SAFETY: TDN_DESTROYED removes each handle before its window goes, and the list lock is held.
            let _ = unsafe {
                PostMessageW(
                    Some(HWND(hwnd as _)),
                    TDM_CLICK_BUTTON.0 as u32,
                    WPARAM(CANCEL as usize),
                    LPARAM(0),
                )
            };
        }
    }
}

/// Records each open confirmation window. `data` points to `Dialogs::open`.
unsafe extern "system" fn track(
    hwnd: HWND,
    notification: TASKDIALOG_NOTIFICATIONS,
    _: WPARAM,
    _: LPARAM,
    data: isize,
) -> HRESULT {
    // SAFETY: `Dialogs::confirm` passes `&self.open`, and that borrow outlives the dialog.
    let open = unsafe { &*(data as *const Mutex<Vec<isize>>) };
    match notification {
        TDN_CREATED => lock(open).push(hwnd.0 as isize),
        TDN_DESTROYED => lock(open).retain(|&open| open != hwnd.0 as isize),
        _ => {}
    }
    S_OK
}

impl Native for Dialogs {
    fn pick_executable(&self) -> Option<PathBuf> {
        let mut picker = self.app.dialog().file().add_filter("Git", &["exe"]);
        if let Some(owner) = self.owner() {
            picker = picker.set_parent(&owner);
        }
        picker.blocking_pick_file()?.into_path().ok()
    }

    fn pick_folder(&self) -> Option<PathBuf> {
        let mut picker = self.app.dialog().file();
        if let Some(owner) = self.owner() {
            picker = picker.set_parent(&owner);
        }
        picker.blocking_pick_folder()?.into_path().ok()
    }

    fn confirm(&self, confirmation: &Confirmation) -> Option<i32> {
        let owner = self
            .owner()
            .and_then(|window| window.hwnd().ok())
            .unwrap_or_default();
        let title = HSTRING::from("Arbareto");
        let text = HSTRING::from(confirmation.text.as_str());
        let labels: Vec<HSTRING> = confirmation
            .buttons
            .iter()
            .map(|button| HSTRING::from(button.label))
            .collect();
        let buttons: Vec<TASKDIALOG_BUTTON> = confirmation
            .buttons
            .iter()
            .zip(&labels)
            .map(|(button, label)| TASKDIALOG_BUTTON {
                nButtonID: button.id,
                pszButtonText: PCWSTR(label.as_ptr()),
            })
            .collect();
        let config = TASKDIALOGCONFIG {
            cbSize: size_of::<TASKDIALOGCONFIG>() as u32,
            hwndParent: owner,
            dwFlags: TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW,
            pszWindowTitle: PCWSTR(title.as_ptr()),
            pszContent: PCWSTR(text.as_ptr()),
            cButtons: buttons.len() as u32,
            pButtons: buttons.as_ptr(),
            nDefaultButton: confirmation.default_button,
            pfCallback: Some(track),
            lpCallbackData: (&raw const self.open) as isize,
            ..Default::default()
        };
        let mut pressed = 0;
        // SAFETY: the strings, the button array, and `self.open` outlive the modal call.
        unsafe { TaskDialogIndirect(&config, Some(&mut pressed), None, None) }.ok()?;
        Some(pressed)
    }

    fn search_path(&self) -> Option<PathBuf> {
        // An empty `lpPath` would not search; a null one would search other directories.
        let path = std::env::var_os("PATH").filter(|path| !path.is_empty())?;
        let mut found = vec![0u16; PATH_UNITS + 1];
        // SAFETY: both strings live for the call, and the buffer length is its slice length.
        let length = unsafe {
            SearchPathW(
                &HSTRING::from(path.as_os_str()),
                w!("git.exe"),
                PCWSTR::null(),
                Some(&mut found),
                None,
            )
        } as usize;
        // A length at or above the buffer size is the size that the call needs.
        if length == 0 || length >= found.len() {
            return None;
        }
        let found = PathBuf::from(OsString::from_wide(&found[..length]));
        found.is_absolute().then_some(found)
    }

    fn program_files(&self) -> Option<PathBuf> {
        std::env::var_os("ProgramFiles").map(PathBuf::from)
    }
}

#[cfg(test)]
pub(crate) mod tests {
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
    pub(crate) enum Press {
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
    pub(crate) struct Fake {
        pub(crate) executable: Option<PathBuf>,
        pub(crate) folder: Option<PathBuf>,
        pub(crate) search: Option<PathBuf>,
        pub(crate) program_files: Option<PathBuf>,
        pub(crate) presses: RefCell<Vec<Press>>,
        pub(crate) calls: RefCell<Vec<&'static str>>,
    }

    impl Fake {
        pub(crate) fn pressing(presses: &[Press]) -> Fake {
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
            selected_path: path.to_path_buf(),
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
            other => panic!("expected a context, got {other:?}"),
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
            common_identity: crate::bootstrap::PhysicalIdentity::Windows(
                read_identity(&common).expect("identity"),
            ),
            common_directory: common,
        }
    }

    fn trust_request(fixture: &Fixture, persist: bool, bound: Option<&str>) -> Confirm {
        Confirm {
            worktree_root: folder(fixture, "repo"),
            git_directory: folder(fixture, "repo\\.git"),
            common_directory: fixture.path("repo\\.git"),
            git_selected_path: PathBuf::from("C:\\Program Files\\Git\\cmd\\git.exe"),
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
    fn the_saved_selected_path_is_the_candidate_not_the_saved_resolved_path() {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let wrapper = file(&fixture, "Git\\cmd\\git.exe");
        let saved_git = SavedGit {
            selected_path: wrapper.clone(),
            ..saved(&file(&fixture, "Git\\mingw64\\libexec\\git-core\\git.exe"))
        };
        let native = Fake::default();
        let chosen = choose_git(&native, Some(&saved_git), &contexts, Instant::now());
        assert_eq!(
            context(&contexts, &chosen),
            (ContextKind::GitProbe, wrapper)
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
            selected_path: &path,
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
    fn the_git_confirmation_names_the_selected_path_and_a_runs_line_only_for_another_resolved_path()
    {
        let wrapper = Path::new(r"C:\Git\cmd\git.exe");
        let resolved = Path::new(r"C:\Git\mingw64\libexec\git-core\git.exe");
        let text = |selected_path, stored_version| {
            git_confirmation(&Proposal {
                selected_path,
                executable_path: resolved,
                version: "2.56.0.windows.1",
                stored_version,
            })
            .text
        };
        assert_eq!(
            text(wrapper, None),
            "Use this Git?\nPath: C:\\Git\\cmd\\git.exe\nRuns: C:\\Git\\mingw64\\libexec\\git-core\\git.exe\nVersion: 2.56.0.windows.1"
        );
        assert_eq!(
            text(resolved, None),
            "Use this Git?\nPath: C:\\Git\\mingw64\\libexec\\git-core\\git.exe\nVersion: 2.56.0.windows.1"
        );
        assert_eq!(
            text(wrapper, Some("2.55.0.windows.3")),
            "Use this Git?\nPath: C:\\Git\\cmd\\git.exe\nRuns: C:\\Git\\mingw64\\libexec\\git-core\\git.exe\nVersion: 2.56.0.windows.1\nStored version: 2.55.0.windows.3"
        );
    }

    #[test]
    fn after_git_changed_the_confirmation_also_names_the_stored_version() {
        let fixture = Fixture::new();
        let path = file(&fixture, "saved\\git.exe");
        let confirmation = git_confirmation(&Proposal {
            selected_path: &path,
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
            selected_path: &path,
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
    fn the_wsl_git_confirmation_names_the_distro_path_and_version_and_only_use_this_git_approves() {
        let proposal = WslProposal {
            distro: "Ubuntu-24.04",
            git: "/usr/local/bin/git",
            version: "2.55.0",
        };
        let confirmation = wsl_git_confirmation(&proposal);
        assert_eq!(
            confirmation.text,
            "Use this Git?\nDistro: Ubuntu-24.04\nPath: /usr/local/bin/git\nVersion: 2.55.0"
        );
        assert_eq!(labels(&confirmation), ["Use this Git", "Cancel"]);
        assert_eq!(confirmation.default_button, id_of(&confirmation, "Cancel"));
        assert_eq!(
            confirmation.accept_button,
            id_of(&confirmation, "Use this Git")
        );
        let native = Fake::pressing(&[Press::Label("Use this Git")]);
        assert!(confirm_wsl_git(&native, &proposal));
        for press in CANCELS {
            let native = Fake::pressing(&[press]);
            assert!(!confirm_wsl_git(&native, &proposal));
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
            selected_path: &path,
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
            selected_path: &path,
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
            ("link", "a link that Arbareto cannot follow"),
            ("name", "a file name that Arbareto cannot check"),
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

    #[test]
    fn the_damaged_marker_confirmation_names_the_file_and_only_dismiss_accepts_it() {
        let damaged = Damaged {
            marker_id: "0f0f0f0f-0000-4000-8000-000000000002".to_string(),
            file_name: "broken.json".to_string(),
        };
        let confirmation = damaged_dismissal_confirmation(&damaged);
        assert!(confirmation.text.contains("Damaged recovery marker"));
        assert!(confirmation.text.contains("broken.json"));
        assert!(
            confirmation.text.to_lowercase().contains("unknown"),
            "the outcome stays unknown"
        );
        assert_eq!(labels(&confirmation), ["Dismiss", "Cancel"]);
        assert_eq!(confirmation.default_button, id_of(&confirmation, "Cancel"));
        assert_eq!(confirmation.accept_button, id_of(&confirmation, "Dismiss"));
        assert!(confirm_damaged_dismissal(
            &Fake::pressing(&[Press::Label("Dismiss")]),
            &damaged
        ));
        for press in CANCELS {
            assert!(!confirm_damaged_dismissal(
                &Fake::pressing(&[press]),
                &damaged
            ));
        }
    }

    #[test]
    fn a_dismissal_binds_a_discovery_context_to_the_stored_worktree_path() {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let marker = marker(&fixture);
        let bootstrap_id = dismissal_context(&marker, &contexts, Instant::now())
            .expect("context")
            .expect("an existing worktree gets a context");
        let context = contexts
            .get(&bootstrap_id, Instant::now())
            .expect("live context");
        assert_eq!(
            (context.kind, context.path),
            (ContextKind::RepositoryDiscovery, marker.worktree_root)
        );
    }

    #[test]
    fn a_dismissal_of_a_deleted_or_moved_worktree_needs_no_context() {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let deleted = marker(&fixture);
        std::fs::remove_dir_all(&deleted.worktree_root).expect("delete the worktree");
        assert_eq!(
            dismissal_context(&deleted, &contexts, Instant::now()),
            Ok(None),
            "a deleted worktree folder"
        );
        let moved = Marker {
            worktree_root: fixture.path("moved\\repo"),
            ..marker(&fixture)
        };
        assert_eq!(
            dismissal_context(&moved, &contexts, Instant::now()),
            Ok(None),
            "a worktree whose parent folder is gone"
        );
        // ERROR_INVALID_NAME: the read fails, but not because the path is absent.
        let unreadable = Marker {
            worktree_root: fixture.path("bad<name"),
            ..marker(&fixture)
        };
        assert_eq!(
            dismissal_context(&unreadable, &contexts, Instant::now()),
            Err("UNSUPPORTED_REPOSITORY"),
            "another identity failure keeps the refusal"
        );
    }

    // ---- Identity refusals ----

    #[test]
    fn a_missing_saved_git_path_is_no_candidate_and_the_path_search_result_follows() {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let found = file(&fixture, "path\\git.exe");
        let native = Fake {
            search: Some(found.clone()),
            program_files: Some(folder(&fixture, "pf")),
            ..Fake::default()
        };
        file(&fixture, "pf\\Git\\cmd\\git.exe");
        let missing = saved(&fixture.path("moved\\git.exe"));
        let chosen = choose_git(&native, Some(&missing), &contexts, Instant::now());
        assert_eq!(context(&contexts, &chosen), (ContextKind::GitProbe, found));
        assert!(!native.calls().contains(&"pick_executable"));
    }

    #[test]
    fn a_picked_path_whose_identity_cannot_be_read_is_refused_not_canceled() {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let native = Fake {
            folder: Some(fixture.path("deleted-after-pick")),
            executable: Some(fixture.path("deleted-after-pick.exe")),
            program_files: Some(folder(&fixture, "pf-without-git")),
            ..Fake::default()
        };
        assert_eq!(
            choose_repository(&native, &contexts, Instant::now()),
            Chosen::Refused("UNSUPPORTED_REPOSITORY")
        );
        assert_eq!(
            choose_git(&native, None, &contexts, Instant::now()),
            Chosen::Refused("GIT_UNAVAILABLE")
        );
    }

    #[test]
    fn restore_workspace_for_a_deleted_repository_is_refused_not_canceled() {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let repository = folder(&fixture, "repo");
        std::fs::remove_dir(&repository).expect("delete the repository");
        let settings = Settings {
            git: None,
            last_repository: Some(repository),
            window: None,
            wsl_gits: Vec::new(),
        };
        assert_eq!(
            restore_workspace(&settings, &contexts, Instant::now()),
            Chosen::Refused("UNSUPPORTED_REPOSITORY")
        );
        let none = Settings {
            last_repository: None,
            ..settings
        };
        assert_eq!(
            restore_workspace(&none, &contexts, Instant::now()),
            Chosen::Canceled,
            "without a last repository"
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
            wsl_gits: Vec::new(),
        };
        let saved_git = startup_context(&settings, &contexts, Instant::now()).expect("savedGit");
        let bootstrap_id = saved_git["bootstrapId"].as_str().expect("bootstrapId");
        assert_eq!(
            saved_git,
            json!({ "bootstrapId": bootstrap_id, "selectedPath": git, "executablePath": git, "version": "2.55.0.windows.3", "digest": DIGEST })
        );
        let context = contexts
            .get(bootstrap_id, Instant::now())
            .expect("live context");
        assert_eq!((context.kind, context.path), (ContextKind::GitProbe, git));
    }

    #[test]
    fn a_saved_wrapper_selection_gives_a_startup_context_for_the_wrapper() {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let wrapper = file(&fixture, "Git\\cmd\\git.exe");
        let resolved = file(&fixture, "Git\\mingw64\\libexec\\git-core\\git.exe");
        let settings = Settings {
            git: Some(SavedGit {
                selected_path: wrapper.clone(),
                ..saved(&resolved)
            }),
            last_repository: None,
            window: None,
            wsl_gits: Vec::new(),
        };
        let saved_git = startup_context(&settings, &contexts, Instant::now()).expect("savedGit");
        let bootstrap_id = saved_git["bootstrapId"].as_str().expect("bootstrapId");
        assert_eq!(
            saved_git,
            json!({ "bootstrapId": bootstrap_id, "selectedPath": wrapper, "executablePath": resolved, "version": "2.55.0.windows.3", "digest": DIGEST })
        );
        let context = contexts
            .get(bootstrap_id, Instant::now())
            .expect("live context");
        assert_eq!(context.path, wrapper);
        assert_eq!(context.selected, wrapper);
        assert!(
            context.startup,
            "the context registers without Use this Git"
        );
    }

    #[test]
    fn a_missing_selected_file_gives_a_saved_git_without_a_bootstrap_id_and_no_context() {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let missing = fixture.path("Git\\mingw64\\bin\\git.exe");
        let settings = Settings {
            git: Some(saved(&missing)),
            last_repository: None,
            window: None,
            wsl_gits: Vec::new(),
        };
        assert_eq!(
            startup_context(&settings, &contexts, Instant::now()),
            Some(
                json!({ "selectedPath": missing, "executablePath": missing, "version": "2.55.0.windows.3", "digest": DIGEST })
            )
        );
    }

    #[test]
    fn without_a_saved_git_path_the_startup_creates_no_context() {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let settings = Settings {
            git: None,
            last_repository: Some(folder(&fixture, "repo")),
            window: None,
            wsl_gits: Vec::new(),
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
            wsl_gits: Vec::new(),
        };
        let chosen = restore_workspace(&settings, &contexts, Instant::now());
        assert_eq!(
            context(&contexts, &chosen),
            (ContextKind::RepositoryDiscovery, repository)
        );
    }
}
