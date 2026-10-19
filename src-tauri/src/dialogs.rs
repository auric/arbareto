// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::Instant;

use serde_json::{Value, json};
use tauri::{AppHandle, Manager, WebviewWindow};
use windows::Win32::Foundation::{ERROR_CANCELLED, HWND, LPARAM, S_OK, WPARAM};
use windows::Win32::Storage::FileSystem::SearchPathW;
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoCreateInstance,
    CoInitializeEx, CoTaskMemFree, CoUninitialize,
};
use windows::Win32::UI::Controls::{
    TASKDIALOG_BUTTON, TASKDIALOG_NOTIFICATIONS, TASKDIALOGCONFIG, TDF_ALLOW_DIALOG_CANCELLATION,
    TDF_POSITION_RELATIVE_TO_WINDOW, TDM_CLICK_BUTTON, TDN_CREATED, TDN_DESTROYED,
    TaskDialogIndirect,
};
use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
use windows::Win32::UI::Shell::{
    FILEOPENDIALOGOPTIONS, FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS, FileOpenDialog, IFileOpenDialog,
    SIGDN_FILESYSPATH,
};
use windows::Win32::UI::WindowsAndMessaging::{IDCANCEL, PostMessageW};
use windows::core::{HRESULT, HSTRING, PCWSTR, w};

use crate::bootstrap::{ContextKind, Contexts, is_absent};
use crate::file_facts::is_wsl_path;
use crate::ipc::MAIN_WINDOW;
use crate::process_requests::{PATH_UNITS, native_path};
use crate::schema::process_reply::RegisterResultResult;
use crate::schema::reply;
use crate::settings::{Confirm, Damaged, Marker, SavedGit, Settings};
use crate::wsl;

/// Escape, Alt+F4, and the close button return `IDCANCEL`, so the Cancel button carries that ID.
const CANCEL: i32 = IDCANCEL.0;
/// Custom button IDs stay clear of the common button IDs 1 to 11.
const ACCEPT: i32 = 100;
const ANOTHER: i32 = 101;

const INVALID: &str = "INVALID_REQUEST";

/// Feature 004 plan.md D14: the texts of the trust dialog.
const TRUST_INSTRUCTION: &str = "Do you trust this repository?";
const TRUST_ADVICE: &str = "Trust it if you or your team set it up. Do not trust a folder from an unknown source, such as a downloaded archive.";
const TRUST_REMEMBERS: &str = "Arbareto remembers your choice for this folder.";
/// Plan D14: the text of a name that `shown` refuses.
const UNSHOWN_NAME: &str = "a name that Arbareto cannot show";
const SHOW_DETAILS: &str = "Show details";
const HIDE_DETAILS: &str = "Hide details";

/// One button of a `TaskDialogIndirect` confirmation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Button {
    pub id: i32,
    pub label: &'static str,
}

/// One native confirmation. Only `accept_button` accepts. The lifecycle dialogs default to their action button.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Confirmation {
    /// `pszMainInstruction`. `None` shows the content only.
    pub instruction: Option<String>,
    /// `pszContent`.
    pub text: String,
    /// `pszExpandedInformation`, collapsed behind Show details. `None` shows no expander.
    pub details: Option<String>,
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
        instruction: None,
        text,
        details: None,
        buttons,
        default_button: CANCEL,
        accept_button: ACCEPT,
    }
}

/// Feature 003 contract Δ3: the files of `chooseSyncPath` and of the clone key picker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileKind {
    Plink,
    Key,
}

impl FileKind {
    /// The name and the pattern of the file type filter.
    fn filter(self) -> (PCWSTR, PCWSTR) {
        match self {
            FileKind::Plink => (w!("plink"), w!("*.exe")),
            FileKind::Key => (w!("PuTTY key"), w!("*.ppk")),
        }
    }
}

/// The native pickers and confirmations. T183 injects them, so the tests run without a window.
pub trait Native {
    /// The executable picker. `Ok(None)` is Cancel. `Err` is a picker call failure.
    fn pick_executable(&self) -> Result<Option<PathBuf>, &'static str>;
    /// The folder picker. `Ok(None)` is Cancel. `Err` is a picker call failure.
    fn pick_folder(&self) -> Result<Option<PathBuf>, &'static str>;
    /// The file picker of one `FileKind`. `Ok(None)` is Cancel. `Err` is a picker call failure.
    fn pick_file(&self, kind: FileKind) -> Result<Option<PathBuf>, &'static str>;
    /// The button ID that `TaskDialogIndirect` returns. `None` is a call failure.
    fn confirm(&self, confirmation: &Confirmation) -> Option<i32>;
    /// `SearchPathW` for `git.exe` with the shell `PATH` value as `lpPath`.
    fn search_path(&self) -> Option<PathBuf>;
    /// The `%ProgramFiles%` folder.
    fn program_files(&self) -> Option<PathBuf>;
}

/// The native step of `chooseGit`, `chooseRepository`, `restoreWorkspace`, and `openRecentRepository`.
#[derive(Debug, PartialEq, Eq)]
pub enum Chosen {
    /// The shell answers `canceled`, and no frame reaches the service.
    Canceled,
    /// A new bootstrap context for `path`.
    Context { bootstrap_id: String, path: PathBuf },
    /// The shell cannot read the identity of the selected path. The renderer gets `rejected` with the code.
    Refused(&'static str),
    /// The identity open of a stored Windows root failed with `ERROR_FILE_NOT_FOUND` or `ERROR_PATH_NOT_FOUND` (contract §3 "Recent repositories").
    Absent(PathBuf),
}

/// A path whose identity the shell cannot read is refused with the code of that read (contract §6 "Registration bootstrap").
fn context(contexts: &Contexts, kind: ContextKind, path: PathBuf, now: Instant) -> Chosen {
    match contexts.create(kind, &path, now) {
        Ok(bootstrap_id) => Chosen::Context { bootstrap_id, path },
        Err(code) => Chosen::Refused(code),
    }
}

/// A picker call failure is a refusal, not a Cancel.
fn picked(
    pick: Result<Option<PathBuf>, &'static str>,
    contexts: &Contexts,
    kind: ContextKind,
    now: Instant,
) -> Chosen {
    match pick {
        Ok(Some(path)) => context(contexts, kind, path, now),
        Ok(None) => Chosen::Canceled,
        Err(code) => Chosen::Refused(code),
    }
}

fn pick_git(native: &dyn Native, contexts: &Contexts, now: Instant) -> Chosen {
    picked(
        native.pick_executable(),
        contexts,
        ContextKind::GitProbe,
        now,
    )
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
    picked(
        native.pick_folder(),
        contexts,
        ContextKind::RepositoryDiscovery,
        now,
    )
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

/// Creates a `repositoryDiscovery` context for the stored root of a recent entry.
/// A WSL root reads no identity and starts no process at creation (gaps.md W1).
pub fn open_recent(path: PathBuf, contexts: &Contexts, now: Instant) -> Chosen {
    match context(
        contexts,
        ContextKind::RepositoryDiscovery,
        path.clone(),
        now,
    ) {
        Chosen::Refused(_) if is_absent(&path) => Chosen::Absent(path),
        chosen => chosen,
    }
}

/// The two contexts of one clone (feature 003 contract Δ3 `clone`).
#[derive(Debug, PartialEq, Eq)]
pub struct Cloned {
    pub clone_id: String,
    pub bootstrap_id: String,
    pub destination: PathBuf,
}

/// Feature 003 contract Δ3 `clone` native step: the path text by the 001 Windows rules or the §11 route,
/// then the `.ppk` picker for `keyFile: "picked"`, then one `clone` and one `repositoryDiscovery` context.
/// `Ok(None)` is a canceled picker.
pub fn choose_clone(
    native: &dyn Native,
    contexts: &Contexts,
    payload: &Value,
    now: Instant,
) -> Result<Option<Cloned>, &'static str> {
    let (Some(url), Some(destination), Some(key_file)) = (
        payload["url"].as_str(),
        payload["destination"].as_str(),
        payload["keyFile"].as_str(),
    ) else {
        return Err(INVALID);
    };
    let destination = native_path(destination).map_err(|_| INVALID)?;
    if !routed(&destination) {
        return Err(INVALID);
    }
    let key = match key_file {
        "none" => None,
        "picked" => match native.pick_file(FileKind::Key)? {
            None => return Ok(None),
            Some(key) if key.to_str().is_some() => Some(key),
            Some(_) => return Err(INVALID),
        },
        _ => return Err(INVALID),
    };
    let (clone_id, bootstrap_id) = contexts.create_clone(&destination, url, key, now);
    Ok(Some(Cloned {
        clone_id,
        bootstrap_id,
        destination,
    }))
}

/// Contract §11 "Route": a WSL path names a distro, and each segment has a Linux form (reason `wsl-path`).
fn routed(path: &Path) -> bool {
    if !is_wsl_path(path) {
        return true;
    }
    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return false;
    };
    let Prefix::UNC(_, distro) = prefix.kind() else {
        return false;
    };
    distro
        .to_str()
        .is_some_and(|distro| !distro.is_empty() && wsl::linux_path(path, distro).is_some())
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
    /// `executable_path` is a file whose identity the context read, so it is a native path.
    pub fn reply(&self, call_id: &str) -> Value {
        match self {
            Registered::Approved => reply::register(call_id, RegisterResultResult::Approved),
            Registered::Declined => reply::register(call_id, RegisterResultResult::Declined),
            Registered::Another {
                bootstrap_id,
                executable_path,
            } => reply::register_another(call_id, bootstrap_id, &executable_path.to_string_lossy()),
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
            Chosen::Canceled | Chosen::Refused(_) | Chosen::Absent(_) => Registered::Declined,
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

/// The sentence that names a contract Δ6 action. The frame schema admits no other action.
fn action_sentence(action: &str) -> Option<&'static str> {
    Some(match action {
        "commit" => "Git runs them when you commit.",
        "read" => "Git runs them when Arbareto reads your changes.",
        "fetch" => "Git runs them when you fetch.",
        "pull" => "Git runs them when you pull.",
        "push" => "Git runs them when you push.",
        "switch" => "Git runs them when you switch branches.",
        "branch" => "Git runs them when you create, rename, or delete a branch.",
        "merge" => "Git runs them when you merge.",
        "rebase" => "Git runs them when you rebase.",
        "resolve" => "Git runs them when you resolve a conflict.",
        "mergetool" => "Git runs them when you open the merge tool.",
        "worktree" => "Git runs them when you add or remove a worktree.",
        "submodules" => "Git runs them when you update submodules.",
        "repository" => "Git runs them for the actions that need them.",
        _ => return None,
    })
}

/// Plan D14: the Unicode general categories Cc, Cf, Zl, and Zp. A character such as U+202E can make a name read differently from its bytes.
/// `regress` reads these ECMAScript classes as the service does (`src/git-service/trust.ts` `shownName`).
static UNSHOWN_CHARACTER: LazyLock<regress::Regex> = LazyLock::new(|| {
    regress::Regex::with_flags(r"[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]", "u").expect("a valid character class")
});

/// The text of one repository value. Plan D14: an empty value, or one with a character of `UNSHOWN_CHARACTER`, shows as a fixed text.
/// A `str` holds valid UTF-8 and no lone surrogate.
fn shown(text: &str) -> String {
    if text.is_empty() || UNSHOWN_CHARACTER.find(text).is_some() {
        UNSHOWN_NAME.to_string()
    } else {
        text.to_string()
    }
}

/// The contract §7 configuration scope names.
fn scope_text(scope: &str) -> &'static str {
    match scope {
        "system" => "system settings",
        "global" => "global settings",
        "local" => "repository settings",
        "worktree" => "worktree settings",
        "command" => "command-line settings",
        "submodule" => "submodule settings",
        _ => "unknown settings",
    }
}

/// The contract Δ6 `details` kinds in their dialog order, with the singular and the plural label.
const DETAIL_KINDS: [(&str, &str, &str); 7] = [
    ("hooks", "Hook", "Hooks"),
    ("filters", "File filter", "File filters"),
    ("monitors", "File system monitor", "File system monitors"),
    ("mergeDrivers", "Merge driver", "Merge drivers"),
    ("mergeTools", "Merge tool", "Merge tools"),
    ("signing", "Signing program", "Signing programs"),
    ("other", "Other program", "Other programs"),
];

/// Plan D14: an `unlisted` hooks item names a folder that the listing cannot read.
fn unlisted(item: &Value) -> bool {
    item["unlisted"].as_bool() == Some(true)
}

/// The name and the group of one `details` item. A monitor item names only its scope.
fn detail_item(item: &Value) -> (String, String) {
    if unlisted(item) {
        return (
            "the hooks folder cannot be listed".to_string(),
            format!(
                "folder {}",
                shown(item["folder"].as_str().unwrap_or_default())
            ),
        );
    }
    let name = ["event", "driver", "tool", "key"]
        .iter()
        .find_map(|field| item[*field].as_str())
        .map_or_else(|| "core.fsmonitor".to_string(), shown);
    let group = match item["folder"].as_str() {
        Some(folder) => format!("folder {}", shown(folder)),
        None => scope_text(item["scope"].as_str().unwrap_or_default()).to_string(),
    };
    (name, group)
}

/// One details line, such as `Hooks: pre-commit, post-commit (folder C:\repo\.git\hooks)`. `None` for an empty kind.
/// Consecutive names of one group share the group text. A `more` count adds "and <n> more" (plan.md D14).
fn detail_line(kind: &Value, one: &str, many: &str) -> Option<String> {
    let names = kind["names"].as_array()?;
    let more = kind["more"].as_u64().unwrap_or(0);
    if names.is_empty() && more == 0 {
        return None;
    }
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    for (name, group) in names.iter().map(detail_item) {
        match groups.last_mut() {
            Some((last, list)) if *last == group => list.push(name),
            _ => groups.push((group, vec![name])),
        }
    }
    let mut text = groups
        .iter()
        .map(|(group, list)| format!("{} ({group})", list.join(", ")))
        .collect::<Vec<_>>()
        .join("; ");
    if more > 0 {
        let joint = if text.is_empty() { "" } else { ", and " };
        text.push_str(&format!("{joint}{more} more"));
    }
    // An unlisted folder can hold several hooks, so its line takes the plural label.
    let label = if names.len() as u64 + more == 1 && !names.iter().any(unlisted) {
        one
    } else {
        many
    };
    Some(format!("{label}: {text}"))
}

/// The trust task dialog of feature 004 plan.md D14: Trust and Not now, the default.
/// The details name only folders, names, and scopes, never a configuration value or a fingerprint (spec FR-070).
pub fn trust_confirmation(request: &Confirm) -> Confirmation {
    let action =
        action_sentence(&request.action).map_or(String::new(), |sentence| format!(" {sentence}"));
    let mut details = vec![format!(
        "Folder: {}",
        shown(&request.worktree_root.to_string_lossy())
    )];
    details.extend(
        DETAIL_KINDS
            .iter()
            .filter_map(|(key, one, many)| detail_line(&request.details[*key], one, many)),
    );
    details.push(TRUST_REMEMBERS.to_string());
    Confirmation {
        instruction: Some(TRUST_INSTRUCTION.to_string()),
        text: format!("This repository has its own programs.{action}\n\n{TRUST_ADVICE}"),
        details: Some(details.join("\n")),
        buttons: vec![
            Button {
                id: ACCEPT,
                label: "Trust",
            },
            Button {
                id: CANCEL,
                label: "Not now",
            },
        ],
        default_button: CANCEL,
        accept_button: ACCEPT,
    }
}

/// True only for the Trust button.
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

/// Contract §12 "Trust": `<paths>` names at most 10 paths and then the count of the others.
const RUN_PATHS: usize = 10;

/// A path below the worktree root as Git names it, with `/` between the names. A path outside the root keeps its native form.
fn relative_path(root: &Path, path: &str) -> String {
    let relative = Path::new(path)
        .strip_prefix(root)
        .ok()
        .filter(|relative| relative.components().next().is_some());
    shown(&relative.map_or_else(
        || path.to_string(),
        |relative| {
            relative
                .components()
                .map(|name| name.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/")
        },
    ))
}

/// The `confirmRun` confirmation: Run and Cancel, the default (contract §12 "Trust", feature 004 contract Δ12).
/// It names the submodule paths relative to `root`, such as "lib/a and lib/b".
pub fn run_confirmation(
    root: &Path,
    paths: &[String],
    program_count: u64,
    unchecked_count: u64,
) -> Confirmation {
    let names: Vec<String> = paths
        .iter()
        .take(RUN_PATHS)
        .map(|path| relative_path(root, path))
        .collect();
    let named = match (names.as_slice(), paths.len().saturating_sub(RUN_PATHS)) {
        ([one], 0) => one.clone(),
        ([first, second], 0) => format!("{first} and {second}"),
        ([head @ .., last], 0) => format!("{}, and {last}", head.join(", ")),
        (_, 1) => format!("{}, and 1 other", names.join(", ")),
        (_, others) => format!("{}, and {others} others", names.join(", ")),
    };
    let programs = if program_count == 1 {
        "program"
    } else {
        "programs"
    };
    let mut text = format!(
        "Update submodules runs {program_count} {programs} from {named}. Run them only if you trust these submodules."
    );
    if unchecked_count > 0 {
        text.push_str(&format!(
            " Arbareto cannot check {unchecked_count} of them first."
        ));
    }
    Confirmation {
        instruction: Some("Run the programs of these submodules?".to_string()),
        ..confirmation(text, "Run", None)
    }
}

/// True only for the Run button. It reads and writes no trust record.
pub fn confirm_run(
    native: &dyn Native,
    root: &Path,
    paths: &[String],
    program_count: u64,
    unchecked_count: u64,
) -> bool {
    let confirmation = run_confirmation(root, paths, program_count, unchecked_count);
    native.confirm(&confirmation) == Some(confirmation.accept_button)
}

/// The startup failure dialog without a `Service`. No restart can run then.
pub fn service_stopped() -> Confirmation {
    Confirmation {
        instruction: None,
        text: "Git service stopped.".to_string(),
        details: None,
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

    fn owner_hwnd(&self) -> isize {
        self.owner()
            .and_then(|window| window.hwnd().ok())
            .map_or(0, |hwnd| hwnd.0 as isize)
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
    // SAFETY: `show_confirmation` passes `open`, and that borrow outlives the dialog.
    let open = unsafe { &*(data as *const Mutex<Vec<isize>>) };
    match notification {
        TDN_CREATED => lock(open).push(hwnd.0 as isize),
        TDN_DESTROYED => lock(open).retain(|&open| open != hwnd.0 as isize),
        _ => {}
    }
    S_OK
}

/// The texts that one `TASKDIALOGCONFIG` points to. They live until the modal call returns.
struct TaskTexts {
    title: HSTRING,
    instruction: Option<HSTRING>,
    text: HSTRING,
    details: Option<HSTRING>,
    show: HSTRING,
    hide: HSTRING,
    labels: Vec<HSTRING>,
}

impl TaskTexts {
    fn new(confirmation: &Confirmation) -> TaskTexts {
        TaskTexts {
            title: HSTRING::from("Arbareto"),
            instruction: confirmation.instruction.as_deref().map(HSTRING::from),
            text: HSTRING::from(confirmation.text.as_str()),
            details: confirmation.details.as_deref().map(HSTRING::from),
            show: HSTRING::from(SHOW_DETAILS),
            hide: HSTRING::from(HIDE_DETAILS),
            labels: confirmation
                .buttons
                .iter()
                .map(|button| HSTRING::from(button.label))
                .collect(),
        }
    }

    fn buttons(&self, confirmation: &Confirmation) -> Vec<TASKDIALOG_BUTTON> {
        confirmation
            .buttons
            .iter()
            .zip(&self.labels)
            .map(|(button, label)| TASKDIALOG_BUTTON {
                nButtonID: button.id,
                pszButtonText: PCWSTR(label.as_ptr()),
            })
            .collect()
    }
}

/// A null pointer for an absent text.
fn text_or_null(text: Option<&HSTRING>) -> PCWSTR {
    text.map_or(PCWSTR::null(), |text| PCWSTR(text.as_ptr()))
}

/// The `TASKDIALOGCONFIG` of one confirmation (research R17).
/// `TDF_ALLOW_DIALOG_CANCELLATION` makes Escape, Alt+F4, and the close button return `IDCANCEL`.
/// No flag enables hyperlinks, because the texts hold repository values (plan.md D14).
fn task_config(
    owner: HWND,
    confirmation: &Confirmation,
    texts: &TaskTexts,
    buttons: &[TASKDIALOG_BUTTON],
    open: &Mutex<Vec<isize>>,
) -> TASKDIALOGCONFIG {
    let control = |text: &HSTRING| text_or_null(texts.details.as_ref().and(Some(text)));
    TASKDIALOGCONFIG {
        cbSize: size_of::<TASKDIALOGCONFIG>() as u32,
        hwndParent: owner,
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW,
        pszWindowTitle: PCWSTR(texts.title.as_ptr()),
        pszMainInstruction: text_or_null(texts.instruction.as_ref()),
        pszContent: PCWSTR(texts.text.as_ptr()),
        pszExpandedInformation: text_or_null(texts.details.as_ref()),
        pszCollapsedControlText: control(&texts.show),
        pszExpandedControlText: control(&texts.hide),
        cButtons: buttons.len() as u32,
        pButtons: buttons.as_ptr(),
        nDefaultButton: confirmation.default_button,
        pfCallback: Some(track),
        lpCallbackData: std::ptr::from_ref(open) as isize,
        ..Default::default()
    }
}

/// Shows one confirmation and returns the ID of the pressed button. `None` is a call failure.
fn show_confirmation(
    owner: HWND,
    confirmation: &Confirmation,
    open: &Mutex<Vec<isize>>,
) -> Option<i32> {
    let texts = TaskTexts::new(confirmation);
    let buttons = texts.buttons(confirmation);
    let config = task_config(owner, confirmation, &texts, &buttons, open);
    let mut pressed = 0;
    // SAFETY: `texts`, `buttons`, and `open` outlive the modal call.
    unsafe { TaskDialogIndirect(&config, Some(&mut pressed), None, None) }.ok()?;
    Some(pressed)
}

/// The `rejected` code of a picker call that failed (contract §3).
pub const PICKER_FAILED: &str = "PICKER_FAILED";

/// What one picker shows. `Git` is the executable picker of `chooseGit`.
#[derive(Clone, Copy)]
enum Picker {
    Folder,
    Git,
    File(FileKind),
}

/// Shows an `IFileOpenDialog` on a new STA thread. `owner` is the raw `HWND`, because `HWND` is not `Send`.
fn pick(owner: isize, picker: Picker) -> Result<Option<PathBuf>, &'static str> {
    std::thread::spawn(move || {
        // SAFETY: this new thread has no COM apartment yet. The dialog object needs an STA.
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }
            .ok()
            .map_err(|error| failed("CoInitializeEx", error.code()))?;
        let picked =
            show(HWND(owner as _), picker).map_err(|(step, error)| failed(step, error.code()));
        // SAFETY: `show` released every COM object, and the initialize call above succeeded.
        unsafe { CoUninitialize() };
        picked
    })
    .join()
    .unwrap_or(Err(PICKER_FAILED))
}

/// Logs only the step and the HRESULT. A path can hold user data.
fn failed(step: &str, code: HRESULT) -> &'static str {
    eprintln!("Picker step {step} failed: HRESULT 0x{:08X}", code.0 as u32);
    PICKER_FAILED
}

/// The name of the failed call.
fn at(step: &'static str) -> impl Fn(windows::core::Error) -> (&'static str, windows::core::Error) {
    move |error| (step, error)
}

/// Only `ERROR_CANCELLED` from `IModalWindow::Show` is Cancel.
/// `FOS_FORCEFILESYSTEM` keeps the dialog open for an item without `SFGAO_FILESYSTEM`, such as Search Results.
fn show(
    owner: HWND,
    picker: Picker,
) -> Result<Option<PathBuf>, (&'static str, windows::core::Error)> {
    // SAFETY: the calling thread is in an STA, and `FileOpenDialog` is an in-process class.
    let dialog: IFileOpenDialog =
        unsafe { CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER) }
            .map_err(at("CoCreateInstance"))?;
    let (picks, filter) = match picker {
        Picker::Folder => (FOS_PICKFOLDERS, None),
        Picker::Git => (FILEOPENDIALOGOPTIONS(0), Some((w!("Git"), w!("*.exe")))),
        Picker::File(kind) => (FILEOPENDIALOGOPTIONS(0), Some(kind.filter())),
    };
    // SAFETY: `dialog` is a live interface on this thread.
    let options = unsafe { dialog.GetOptions() }.map_err(at("GetOptions"))?;
    // SAFETY: `dialog` is a live interface on this thread.
    unsafe { dialog.SetOptions(options | FOS_FORCEFILESYSTEM | picks) }
        .map_err(at("SetOptions"))?;
    if let Some((name, spec)) = filter {
        let filter = [COMDLG_FILTERSPEC {
            pszName: name,
            pszSpec: spec,
        }];
        // SAFETY: the dialog copies the filter strings, which are static.
        unsafe { dialog.SetFileTypes(&filter) }.map_err(at("SetFileTypes"))?;
    }
    // SAFETY: `owner` is null or a window handle. A destroyed owner makes `Show` fail, and that failure is no memory access.
    if let Err(error) = unsafe { dialog.Show(Some(owner)) } {
        return if error.code() == ERROR_CANCELLED.to_hresult() {
            Ok(None)
        } else {
            Err(("Show", error))
        };
    }
    // SAFETY: `Show` succeeded, so the dialog holds one result item.
    let item = unsafe { dialog.GetResult() }.map_err(at("GetResult"))?;
    // SAFETY: on success the callee allocates the string with the COM allocator, so the caller frees it with `CoTaskMemFree`.
    let name = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) }.map_err(at("GetDisplayName"))?;
    // SAFETY: `name` is a null-terminated string that lives until the free below.
    let path = PathBuf::from(OsString::from_wide(unsafe { name.as_wide() }));
    // SAFETY: the COM allocator allocated `name`, and nothing reads it after this call.
    unsafe { CoTaskMemFree(Some(name.0 as _)) };
    Ok(Some(path))
}

impl Native for Dialogs {
    fn pick_executable(&self) -> Result<Option<PathBuf>, &'static str> {
        pick(self.owner_hwnd(), Picker::Git)
    }

    fn pick_folder(&self) -> Result<Option<PathBuf>, &'static str> {
        pick(self.owner_hwnd(), Picker::Folder)
    }

    fn pick_file(&self, kind: FileKind) -> Result<Option<PathBuf>, &'static str> {
        pick(self.owner_hwnd(), Picker::File(kind))
    }

    fn confirm(&self, confirmation: &Confirmation) -> Option<i32> {
        let owner = self
            .owner()
            .and_then(|window| window.hwnd().ok())
            .unwrap_or_default();
        show_confirmation(owner, confirmation, &self.open)
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
    const CALL: &str = "0f0f0f0f-0000-4000-8000-0000000000cc";

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
        /// The answer of `pick_file` for each `FileKind`.
        pub(crate) file: Option<PathBuf>,
        /// A picker call failure code. It overrides `executable`, `folder`, and `file`.
        pub(crate) pick_failure: Option<&'static str>,
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

        pub(crate) fn calls(&self) -> Vec<&'static str> {
            self.calls.borrow().clone()
        }
    }

    impl Native for Fake {
        fn pick_executable(&self) -> Result<Option<PathBuf>, &'static str> {
            self.calls.borrow_mut().push("pick_executable");
            self.pick_failure.map_or(Ok(self.executable.clone()), Err)
        }

        fn pick_folder(&self) -> Result<Option<PathBuf>, &'static str> {
            self.calls.borrow_mut().push("pick_folder");
            self.pick_failure.map_or(Ok(self.folder.clone()), Err)
        }

        fn pick_file(&self, kind: FileKind) -> Result<Option<PathBuf>, &'static str> {
            self.calls.borrow_mut().push(match kind {
                FileKind::Plink => "pick_file plink",
                FileKind::Key => "pick_file key",
            });
            self.pick_failure.map_or(Ok(self.file.clone()), Err)
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

    /// The contract Δ6 `details` with no name in any kind.
    fn no_details() -> Value {
        let none = json!({ "names": [], "more": 0 });
        json!({ "hooks": none, "filters": none, "monitors": none, "mergeDrivers": none, "mergeTools": none, "signing": none, "other": none })
    }

    fn trust_request(worktree: &str, action: &str, details: Value) -> Confirm {
        Confirm {
            worktree_root: PathBuf::from(worktree),
            admin_directory: PathBuf::from(format!("{worktree}\\.git")),
            common_directory: PathBuf::from(format!("{worktree}\\.git")),
            git_selected_path: PathBuf::from("C:\\Program Files\\Git\\cmd\\git.exe"),
            action: action.to_string(),
            details,
        }
    }

    /// The details of the plan.md D14 example: two folder hooks and the local `lfs` filter.
    fn sample_details() -> Value {
        let mut details = no_details();
        details["hooks"] = json!({ "names": [
            { "event": "pre-commit", "folder": "C:\\Repos\\sample-repo\\.git\\hooks" },
            { "event": "post-commit", "folder": "C:\\Repos\\sample-repo\\.git\\hooks" },
        ], "more": 0 });
        details["filters"] = json!({ "names": [{ "driver": "lfs", "scope": "local" }], "more": 0 });
        details
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
    fn a_failed_folder_pick_is_a_refusal_not_a_cancel() {
        let contexts = Contexts::new(SESSION);
        let native = Fake {
            pick_failure: Some(PICKER_FAILED),
            ..Fake::default()
        };
        assert_eq!(
            choose_repository(&native, &contexts, Instant::now()),
            Chosen::Refused(PICKER_FAILED)
        );
        assert_eq!(
            choose_git(&native, None, &contexts, Instant::now()),
            Chosen::Refused(PICKER_FAILED),
            "a failed executable pick"
        );
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
    fn the_trust_dialog_shows_the_plan_d14_texts_with_trust_100_and_not_now_idcancel_as_the_default()
     {
        let confirmation = trust_confirmation(&trust_request(
            "C:\\Repos\\sample-repo",
            "commit",
            sample_details(),
        ));
        assert_eq!(
            confirmation.instruction.as_deref(),
            Some("Do you trust this repository?")
        );
        assert_eq!(
            confirmation.text,
            "This repository has its own programs. Git runs them when you commit.\n\nTrust it if you or your team set it up. Do not trust a folder from an unknown source, such as a downloaded archive."
        );
        assert_eq!(
            confirmation.details.as_deref(),
            Some(
                "Folder: C:\\Repos\\sample-repo\nHooks: pre-commit, post-commit (folder C:\\Repos\\sample-repo\\.git\\hooks)\nFile filter: lfs (repository settings)\nArbareto remembers your choice for this folder."
            )
        );
        assert_eq!(labels(&confirmation), ["Trust", "Not now"]);
        assert_eq!(
            confirmation.buttons,
            [
                Button {
                    id: 100,
                    label: "Trust"
                },
                Button {
                    id: IDCANCEL.0,
                    label: "Not now"
                }
            ]
        );
        assert_eq!(
            (confirmation.default_button, confirmation.accept_button),
            (IDCANCEL.0, 100)
        );
    }

    #[test]
    fn the_trust_dialog_names_each_action_and_shows_no_fingerprint() {
        for (action, sentence) in [
            ("commit", "Git runs them when you commit."),
            ("read", "Git runs them when Arbareto reads your changes."),
            ("fetch", "Git runs them when you fetch."),
            ("pull", "Git runs them when you pull."),
            ("push", "Git runs them when you push."),
            ("switch", "Git runs them when you switch branches."),
            (
                "branch",
                "Git runs them when you create, rename, or delete a branch.",
            ),
            ("merge", "Git runs them when you merge."),
            ("rebase", "Git runs them when you rebase."),
            ("resolve", "Git runs them when you resolve a conflict."),
            ("mergetool", "Git runs them when you open the merge tool."),
            (
                "worktree",
                "Git runs them when you add or remove a worktree.",
            ),
            ("submodules", "Git runs them when you update submodules."),
            (
                "repository",
                "Git runs them for the actions that need them.",
            ),
        ] {
            let confirmation = trust_confirmation(&trust_request("C:\\repo", action, no_details()));
            assert!(
                confirmation.text.starts_with(&format!(
                    "This repository has its own programs. {sentence}\n\n"
                )),
                "{action}: {}",
                confirmation.text
            );
            assert!(
                !format!("{confirmation:?}")
                    .to_lowercase()
                    .contains("fingerprint"),
                "{action}"
            );
        }
    }

    #[test]
    fn an_unlisted_hooks_folder_is_named_so_the_dialog_never_names_no_program() {
        let mut details = no_details();
        details["hooks"] = json!({ "names": [{ "folder": "C:\\repo\\.git\\hooks", "unlisted": true }], "more": 0 });
        let shown = trust_confirmation(&trust_request("C:\\repo", "commit", details))
            .details
            .expect("details");
        assert_eq!(
            shown.lines().collect::<Vec<_>>(),
            [
                "Folder: C:\\repo",
                "Hooks: the hooks folder cannot be listed (folder C:\\repo\\.git\\hooks)",
                "Arbareto remembers your choice for this folder.",
            ]
        );
    }

    #[test]
    fn the_trust_details_name_each_kind_by_name_and_scope_and_group_one_folder() {
        let mut details = no_details();
        details["hooks"] = json!({ "names": [
            { "event": "pre-commit", "folder": "C:\\repo\\.git\\hooks" },
            { "event": "pre-push", "scope": "global" },
        ], "more": 0 });
        details["monitors"] = json!({ "names": [{ "scope": "worktree" }], "more": 0 });
        details["mergeDrivers"] = json!({ "names": [{ "driver": "union", "scope": "system" }, { "driver": "ours", "scope": "system" }], "more": 0 });
        details["mergeTools"] =
            json!({ "names": [{ "tool": "fixture", "scope": "command" }], "more": 0 });
        details["signing"] =
            json!({ "names": [{ "key": "gpg.program", "scope": "submodule" }], "more": 0 });
        details["other"] =
            json!({ "names": [{ "key": "core.sshcommand", "scope": "unknown" }], "more": 0 });
        let shown = trust_confirmation(&trust_request("C:\\repo", "fetch", details))
            .details
            .expect("details");
        assert_eq!(
            shown.lines().collect::<Vec<_>>(),
            [
                "Folder: C:\\repo",
                "Hooks: pre-commit (folder C:\\repo\\.git\\hooks); pre-push (global settings)",
                "File system monitor: core.fsmonitor (worktree settings)",
                "Merge drivers: union, ours (system settings)",
                "Merge tool: fixture (command-line settings)",
                "Signing program: gpg.program (submodule settings)",
                "Other program: core.sshcommand (unknown settings)",
                "Arbareto remembers your choice for this folder.",
            ]
        );
    }

    #[test]
    fn the_trust_details_show_20_names_per_kind_then_the_count_of_the_others() {
        let names: Vec<Value> = (0..20)
            .map(|n| json!({ "driver": format!("f{n:02}"), "scope": "local" }))
            .collect();
        let mut details = no_details();
        details["filters"] = json!({ "names": names, "more": 5 });
        let shown = trust_confirmation(&trust_request("C:\\repo", "read", details))
            .details
            .expect("details");
        let filters = shown.lines().nth(1).expect("filter line");
        let listed = (0..20)
            .map(|n| format!("f{n:02}"))
            .collect::<Vec<_>>()
            .join(", ");
        assert_eq!(
            filters,
            format!("File filters: {listed} (repository settings), and 5 more")
        );
        // Contract Δ6: the frame itself holds at most 20 names per kind.
        let mut frame = json!({
            "type": "confirm", "callId": CALL, "worktreeRoot": "C:\\repo", "adminDirectory": "C:\\repo\\.git", "commonDirectory": "C:\\repo\\.git",
            "gitSelectedPath": "C:\\Git\\cmd\\git.exe", "policyVersion": 2, "action": "read", "details": no_details(),
        });
        frame["details"]["filters"] = json!({ "names": (0..20).map(|n| json!({ "driver": format!("f{n}"), "scope": "local" })).collect::<Vec<_>>(), "more": 5 });
        assert!(crate::schema::trust_request(&frame).is_ok(), "20 names");
        frame["details"]["filters"]["names"]
            .as_array_mut()
            .expect("names")
            .push(json!({ "driver": "f20", "scope": "local" }));
        assert!(crate::schema::trust_request(&frame).is_err(), "21 names");
        frame["details"]["filters"]["names"]
            .as_array_mut()
            .expect("names")
            .pop();
        frame["policyVersion"] = json!(1);
        assert!(crate::schema::trust_request(&frame).is_err(), "version 1");
        frame["policyVersion"] = json!(2);
        frame["details"]["filters"]["more"] = json!(-1);
        assert!(
            crate::schema::trust_request(&frame).is_err(),
            "a negative count"
        );
    }

    #[test]
    fn a_value_with_a_control_character_or_an_empty_value_shows_a_fixed_text() {
        let mut details = no_details();
        details["filters"] = json!({ "names": [{ "driver": "lfs\u{1b}[31m", "scope": "local" }, { "driver": "", "scope": "local" }, { "driver": "caf\u{e9}", "scope": "local" }], "more": 0 });
        let shown = trust_confirmation(&trust_request("C:\\repo", "commit", details))
            .details
            .expect("details");
        assert_eq!(
            shown.lines().nth(1),
            Some(
                "File filters: a name that Arbareto cannot show, a name that Arbareto cannot show, caf\u{e9} (repository settings)"
            )
        );
        assert!(!shown.contains('\u{1b}'));
    }

    /// Plan D14: each general category of the rule, with U+202E RIGHT-TO-LEFT OVERRIDE and the U+2066 to U+2069 isolates.
    #[test]
    fn a_name_with_a_format_or_separator_character_shows_a_fixed_text_in_every_details_line() {
        let hidden = [
            "lfs\u{202e}exe.sh",
            "\u{2066}lfs\u{2069}",
            "a\u{2067}b",
            "a\u{2068}b",
            "a\u{200b}b",
            "a\u{feff}b",
            "a\u{2028}b",
            "a\u{2029}b",
            "a\u{85}b",
        ];
        for name in hidden {
            assert_eq!(
                shown(name),
                UNSHOWN_NAME,
                "{:?}",
                name.escape_unicode().to_string()
            );
        }
        // Other letters, marks, and spaces stay as they are.
        for name in [
            "caf\u{e9}",
            "\u{540d}\u{524d}",
            "e\u{301}",
            "a b",
            "a\u{a0}b",
        ] {
            assert_eq!(shown(name), name);
        }
        let mut details = no_details();
        details["hooks"] = json!({ "names": [{ "event": "pre\u{202e}commit", "scope": "local" }, { "event": "pre-commit", "folder": "C:\\repo\\.git\\hooks\u{2066}" }], "more": 0 });
        details["filters"] =
            json!({ "names": [{ "driver": "\u{2066}lfs\u{2069}", "scope": "local" }], "more": 0 });
        details["signing"] =
            json!({ "names": [{ "key": "gpg\u{202e}.program", "scope": "local" }], "more": 0 });
        details["other"] =
            json!({ "names": [{ "key": "core.sshcommand\u{2029}", "scope": "local" }], "more": 0 });
        let text = trust_confirmation(&trust_request("C:\\repo\u{202e}x", "commit", details))
            .details
            .expect("details");
        assert_eq!(
            text.lines().collect::<Vec<_>>(),
            [
                "Folder: a name that Arbareto cannot show",
                "Hooks: a name that Arbareto cannot show (repository settings); pre-commit (folder a name that Arbareto cannot show)",
                "File filter: a name that Arbareto cannot show (repository settings)",
                "Signing program: a name that Arbareto cannot show (repository settings)",
                "Other program: a name that Arbareto cannot show (repository settings)",
                "Arbareto remembers your choice for this folder.",
            ]
        );
        assert!(
            !text
                .chars()
                .any(|c| matches!(c, '\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{2029}')),
            "{text}"
        );
    }

    #[test]
    fn only_trust_accepts_the_trust_dialog() {
        let request = trust_request("C:\\repo", "commit", sample_details());
        assert!(confirm_trust(
            &Fake::pressing(&[Press::Label("Trust")]),
            &request
        ));
        // Enter on the default, Escape, Alt+F4, the close button, Not now, an unknown ID, and a call failure.
        for press in [
            Press::Label("Not now"),
            CANCELS[0],
            CANCELS[1],
            CANCELS[3],
            CANCELS[4],
        ] {
            assert!(!confirm_trust(&Fake::pressing(&[press]), &request));
        }
    }

    #[test]
    fn the_task_config_allows_cancellation_enables_no_hyperlinks_and_defaults_to_idcancel() {
        use windows::Win32::UI::Controls::TDF_ENABLE_HYPERLINKS;
        let open = Mutex::new(Vec::new());
        let confirmation = trust_confirmation(&trust_request(
            "C:\\Repos\\sample-repo",
            "commit",
            sample_details(),
        ));
        let texts = TaskTexts::new(&confirmation);
        let buttons = texts.buttons(&confirmation);
        let config = task_config(HWND::default(), &confirmation, &texts, &buttons, &open);
        assert_eq!(
            config.dwFlags & TDF_ALLOW_DIALOG_CANCELLATION,
            TDF_ALLOW_DIALOG_CANCELLATION
        );
        assert_eq!(config.dwFlags & TDF_ENABLE_HYPERLINKS, Default::default());
        // TASKDIALOGCONFIG is packed, so each field is copied before use.
        assert_eq!({ config.nDefaultButton }, IDCANCEL.0);
        assert_eq!(
            buttons.iter().map(|b| b.nButtonID).collect::<Vec<_>>(),
            [100, IDCANCEL.0]
        );
        // SAFETY: each pointer is null or points into `texts`, which lives to the end of the test.
        let read =
            |text: PCWSTR| (!text.is_null()).then(|| unsafe { text.to_string() }.expect("UTF-16"));
        assert_eq!(read(config.pszWindowTitle).as_deref(), Some("Arbareto"));
        assert_eq!(
            read(config.pszMainInstruction).as_deref(),
            Some("Do you trust this repository?")
        );
        assert_eq!(read(config.pszContent), Some(confirmation.text.clone()));
        assert_eq!(
            read(config.pszExpandedInformation),
            confirmation.details.clone()
        );
        assert_eq!(
            read(config.pszCollapsedControlText).as_deref(),
            Some("Show details")
        );
        assert_eq!(
            read(config.pszExpandedControlText).as_deref(),
            Some("Hide details")
        );
        // A confirmation without details shows no expander and no main instruction.
        let plain = service_stopped();
        let texts = TaskTexts::new(&plain);
        let config = task_config(
            HWND::default(),
            &plain,
            &texts,
            &texts.buttons(&plain),
            &open,
        );
        assert!({ config.pszMainInstruction }.is_null());
        assert!({ config.pszExpandedInformation }.is_null());
        assert!({ config.pszCollapsedControlText }.is_null());
        assert!({ config.pszExpandedControlText }.is_null());
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

    // ---- confirmRun (contract §12 "Trust") ----

    const RUN_ROOT: &str = r"C:\repo";

    fn paths(count: usize) -> Vec<String> {
        (1..=count).map(|n| format!(r"{RUN_ROOT}\sub{n}")).collect()
    }

    fn run_text(paths: &[String], program_count: u64, unchecked_count: u64) -> String {
        run_confirmation(Path::new(RUN_ROOT), paths, program_count, unchecked_count).text
    }

    #[test]
    fn the_run_confirmation_shows_the_contract_delta_12_text_with_run_and_a_cancel_default() {
        let lib = [format!(r"{RUN_ROOT}\lib\a"), format!(r"{RUN_ROOT}\lib\b")];
        let confirmation = run_confirmation(Path::new(RUN_ROOT), &lib, 4, 0);
        assert_eq!(
            confirmation.instruction.as_deref(),
            Some("Run the programs of these submodules?")
        );
        assert_eq!(
            confirmation.text,
            "Update submodules runs 4 programs from lib/a and lib/b. Run them only if you trust these submodules."
        );
        assert_eq!(confirmation.details, None);
        assert_eq!(labels(&confirmation), ["Run", "Cancel"]);
        assert_eq!(confirmation.default_button, id_of(&confirmation, "Cancel"));
        assert_eq!(confirmation.accept_button, id_of(&confirmation, "Run"));
        assert_eq!(
            run_text(&paths(1), 1, 1),
            "Update submodules runs 1 program from sub1. Run them only if you trust these submodules. Arbareto cannot check 1 of them first."
        );
        assert!(run_text(&paths(1), 5, 2).ends_with(" Arbareto cannot check 2 of them first."));
        assert!(
            run_text(&paths(3), 3, 0).contains("from sub1, sub2, and sub3. Run"),
            "three paths"
        );
    }

    #[test]
    fn the_run_confirmation_names_each_path_relative_to_the_worktree_root_or_in_full_outside_it() {
        // A kept Git directory of a linked worktree lies outside its worktree root.
        let paths = [
            format!(r"{RUN_ROOT}\.git\modules\lib"),
            r"D:\common\.git\modules\x".to_string(),
        ];
        assert_eq!(
            run_text(&paths, 2, 0),
            r"Update submodules runs 2 programs from .git/modules/lib and D:\common\.git\modules\x. Run them only if you trust these submodules."
        );
        // A WSL root and its paths have the UNC form.
        let wsl = r"\\wsl.localhost\Ubuntu-26.04\home\u\r";
        let text = run_confirmation(Path::new(wsl), &[format!(r"{wsl}\lib\a")], 1, 0).text;
        assert!(text.contains("from lib/a. Run"), "{text}");
        // Plan.md D14: a path with a character of the categories Cc, Cf, Zl, or Zp shows as a fixed text.
        for name in ["sub\u{1b}[31m", "lib\u{202e}a", "\u{2066}lib\u{2069}"] {
            let text = run_text(&[format!("{RUN_ROOT}\\{name}")], 1, 0);
            assert!(
                text.contains("from a name that Arbareto cannot show. Run"),
                "{text}"
            );
        }
    }

    #[test]
    fn the_run_confirmation_names_at_most_ten_paths_and_then_the_count_of_the_others() {
        let named = (1..=10)
            .map(|n| format!("sub{n}"))
            .collect::<Vec<_>>()
            .join(", ");
        let text = run_text(&paths(12), 12, 0);
        assert!(
            text.contains(&format!("from {named}, and 2 others. Run")),
            "{text}"
        );
        assert!(!text.contains("sub11"));
        let text = run_text(&paths(11), 11, 0);
        assert!(text.contains(", and 1 other. Run"), "{text}");
        let text = run_text(&paths(10), 10, 0);
        let (head, last) = named.rsplit_once(", ").expect("ten names");
        assert!(
            text.contains(&format!("from {head}, and {last}. Run")),
            "{text}"
        );
    }

    #[test]
    fn only_run_accepts_the_run_confirmation() {
        let paths = paths(1);
        let root = Path::new(RUN_ROOT);
        assert!(confirm_run(
            &Fake::pressing(&[Press::Label("Run")]),
            root,
            &paths,
            1,
            0
        ));
        for press in CANCELS {
            assert!(!confirm_run(&Fake::pressing(&[press]), root, &paths, 1, 0));
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
            recent: Vec::new(),
            sync: Default::default(),
            switch_choice: Default::default(),
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
            recent: Vec::new(),
            sync: Default::default(),
            switch_choice: Default::default(),
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
            recent: Vec::new(),
            sync: Default::default(),
            switch_choice: Default::default(),
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
            recent: Vec::new(),
            sync: Default::default(),
            switch_choice: Default::default(),
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
            recent: Vec::new(),
            sync: Default::default(),
            switch_choice: Default::default(),
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
            recent: Vec::new(),
            sync: Default::default(),
            switch_choice: Default::default(),
        };
        let chosen = restore_workspace(&settings, &contexts, Instant::now());
        assert_eq!(
            context(&contexts, &chosen),
            (ContextKind::RepositoryDiscovery, repository)
        );
    }

    // ---- Recent repositories (contract §3 "Recent repositories") ----

    #[test]
    fn an_open_binds_a_discovery_context_to_the_stored_root() {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let repository = folder(&fixture, "repo");
        let chosen = open_recent(repository.clone(), &contexts, Instant::now());
        assert_eq!(
            context(&contexts, &chosen),
            (ContextKind::RepositoryDiscovery, repository)
        );
    }

    #[test]
    fn an_open_of_a_not_found_windows_folder_gives_absent() {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        // `ERROR_FILE_NOT_FOUND` for the folder, `ERROR_PATH_NOT_FOUND` for a missing parent.
        for missing in [fixture.path("gone"), fixture.path("gone\\deeper")] {
            assert_eq!(
                open_recent(missing.clone(), &contexts, Instant::now()),
                Chosen::Absent(missing)
            );
        }
        // `ERROR_INVALID_NAME` is no not-found fact, so the open keeps the refusal code.
        assert_eq!(
            open_recent(fixture.path("bad?name"), &contexts, Instant::now()),
            Chosen::Refused("UNSUPPORTED_REPOSITORY")
        );
    }

    /// No WSL process runs: a WSL root binds a context without an identity read (gaps.md W1).
    #[test]
    fn an_open_of_a_wsl_root_binds_a_context_without_an_identity_read() {
        let contexts = Contexts::new(SESSION);
        let root = PathBuf::from(r"\\wsl.localhost\NoSuchDistro-T343\home\me\repo");
        let chosen = open_recent(root.clone(), &contexts, Instant::now());
        let Chosen::Context { bootstrap_id, .. } = &chosen else {
            panic!("a context: {chosen:?}");
        };
        let bound = contexts
            .get(bootstrap_id, Instant::now())
            .expect("live context");
        assert_eq!(
            (bound.kind, bound.path, bound.identity),
            (
                ContextKind::RepositoryDiscovery,
                root,
                crate::bootstrap::ContextIdentity::Wsl
            )
        );
    }
    // ---- Feature 003 contract Δ3 `clone` native step (T028) ----

    fn clone_payload(destination: &str, key_file: &str) -> Value {
        json!({ "url": "ssh://git@example.test/team/repo.git", "destination": destination, "keyFile": key_file })
    }

    #[test]
    fn a_clone_binds_a_clone_and_a_discovery_context_for_the_checked_path_and_an_absent_destination_binds()
     {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let native = Fake::default();
        let destination = fixture.path(r"absent\repo");
        let text = destination.to_str().expect("path");
        let cloned = choose_clone(
            &native,
            &contexts,
            &clone_payload(text, "none"),
            Instant::now(),
        )
        .expect("checked")
        .expect("contexts");
        assert!(native.calls().is_empty(), "no picker without a key file");
        assert_eq!(cloned.destination, destination);
        let now = Instant::now();
        let clone = contexts.get(&cloned.clone_id, now).expect("clone context");
        let discovery = contexts
            .get(&cloned.bootstrap_id, now)
            .expect("discovery context");
        let pending = crate::bootstrap::ContextIdentity::Pending { wsl: false };
        assert_eq!(
            (clone.kind, clone.path.clone(), clone.identity),
            (ContextKind::Clone, destination.clone(), pending)
        );
        assert_eq!(
            (discovery.kind, discovery.path.clone(), discovery.identity),
            (ContextKind::RepositoryDiscovery, destination, pending)
        );
        assert_eq!(clone.peer.as_deref(), Some(cloned.bootstrap_id.as_str()));
        assert_eq!(discovery.peer.as_deref(), Some(cloned.clone_id.as_str()));
        assert_eq!(
            clone.url.as_deref(),
            Some("ssh://git@example.test/team/repo.git")
        );
        assert_eq!(clone.key, None);
        let wsl = choose_clone(
            &native,
            &contexts,
            &clone_payload(r"\\wsl$\Ubuntu-24.04\home\u\new", "none"),
            now,
        )
        .expect("a WSL route")
        .expect("contexts");
        assert_eq!(
            contexts
                .get(&wsl.bootstrap_id, now)
                .expect("context")
                .identity,
            crate::bootstrap::ContextIdentity::Pending { wsl: true }
        );
    }

    #[test]
    fn a_clone_path_outside_the_windows_rules_or_the_wsl_route_is_refused_before_any_picker() {
        let contexts = Contexts::new(SESSION);
        let native = Fake::default();
        for destination in [
            "repo",
            r"C:repo",
            r"\\?\C:\src\repo",
            r"\\.\pipe\repo",
            "\\\\wsl$\\Ubuntu-24.04\\home\\a\u{f05c}b",
            r"\\wsl.localhost\",
        ] {
            assert_eq!(
                choose_clone(
                    &native,
                    &contexts,
                    &clone_payload(destination, "picked"),
                    Instant::now()
                ),
                Err("INVALID_REQUEST"),
                "{destination}"
            );
        }
        assert!(native.calls().is_empty(), "no picker");
    }

    #[test]
    fn with_a_picked_key_file_a_canceled_picker_cancels_and_binds_nothing() {
        let fixture = Fixture::new();
        let contexts = Contexts::new(SESSION);
        let destination = fixture.path("repo");
        let payload = clone_payload(destination.to_str().expect("path"), "picked");
        let canceled = Fake::default();
        assert_eq!(
            choose_clone(&canceled, &contexts, &payload, Instant::now()),
            Ok(None)
        );
        assert_eq!(canceled.calls(), ["pick_file key"]);
        let failed = Fake {
            pick_failure: Some(PICKER_FAILED),
            ..Fake::default()
        };
        assert_eq!(
            choose_clone(&failed, &contexts, &payload, Instant::now()),
            Err(PICKER_FAILED)
        );
        let key = fixture.path("id.ppk");
        let picked = Fake {
            file: Some(key.clone()),
            ..Fake::default()
        };
        let cloned = choose_clone(&picked, &contexts, &payload, Instant::now())
            .expect("checked")
            .expect("contexts");
        assert_eq!(
            contexts
                .get(&cloned.clone_id, Instant::now())
                .expect("context")
                .key,
            Some(key)
        );
    }
}
