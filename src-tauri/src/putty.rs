// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

//! Feature 003 plan.md D9: the PuTTY pair, the PuTTY programs in the plink folder, Pageant, PuTTYgen, the connect terminal,
//! and the six shell-only settings operations (contract Δ3, Δ6). Nothing here writes Git configuration,
//! the Windows environment, or the registry (FR-033).

use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VS_FIXEDFILEINFO, VerQueryValueW,
};
use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows::Win32::System::Threading::{
    CREATE_NEW_CONSOLE, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, GetExitCodeProcess,
    PROCESS_CREATION_FLAGS, PROCESS_INFORMATION, STARTUPINFOW, WaitForInputIdle,
    WaitForSingleObject,
};
use windows::core::{HSTRING, PCWSTR, PWSTR, w};

use crate::bootstrap::Identity;
use crate::dialogs::{FileKind, Native};
use crate::env_sanitize::name_is;
use crate::ipc::Ended;
use crate::process_requests::{PATH_UNITS, native_path};
use crate::settings::{
    self, KEY_FILE_ENTRIES, KeyFile, PULL_ACTIONS, SshClient, SyncSettings, hex, sha256,
};
use crate::spawn::{SpawnError, command_line, environment_block, null_terminated};

/// Contract Δ5: the Pageant readiness bound.
pub const PAGEANT_READY: Duration = Duration::from_secs(30);

/// O-6: `pageant --encrypted` needs PuTTY 0.75 or later. PuTTY writes `BINARY_VERSION` `0,<minor>,0,0` into the fixed file version.
const MINIMUM_PAGEANT: (u32, u32) = (0, 75);

/// `VS_FIXEDFILEINFO.dwSignature` (Microsoft Learn `VS_FIXEDFILEINFO`).
const FIXED_SIGNATURE: u32 = 0xFEEF_04BD;

/// One poll of the readiness wait. Only `limit` decides `not-ready`.
const SLICE: Duration = Duration::from_millis(100);

/// Contract Δ6 `terminal`: the constant script. The values pass only in the environment.
pub const TERMINAL_SCRIPT: &str = "if ($env:ARBARETO_DIR) { & $env:ARBARETO_GIT --no-lazy-fetch -C $env:ARBARETO_DIR ls-remote --heads -- $env:ARBARETO_TARGET } else { & $env:ARBARETO_GIT --no-lazy-fetch ls-remote --heads -- $env:ARBARETO_TARGET }";

const SSH_COMMAND: &str = "GIT_SSH_COMMAND";
const SSH_VARIANT: &str = "GIT_SSH_VARIANT";
const INVALID: &str = "INVALID_REQUEST";
const UNAVAILABLE: &str = "PUTTY_UNAVAILABLE";

/// Contract Δ9: the programs of `PUTTY_UNAVAILABLE`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Program {
    Plink,
    Pageant,
    Puttygen,
}

impl Program {
    pub fn name(self) -> &'static str {
        match self {
            Program::Plink => "plink",
            Program::Pageant => "pageant",
            Program::Puttygen => "puttygen",
        }
    }
}

/// Contract Δ9: the reasons of `PUTTY_UNAVAILABLE`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    Missing,
    Unreadable,
    Version,
    Exit,
    NotReady,
}

impl Reason {
    pub fn name(self) -> &'static str {
        match self {
            Reason::Missing => "missing",
            Reason::Unreadable => "unreadable",
            Reason::Version => "version",
            Reason::Exit => "exit",
            Reason::NotReady => "not-ready",
        }
    }
}

/// Contract Δ9 `PUTTY_UNAVAILABLE` with the program and its path (FR-037).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unavailable {
    pub reason: Reason,
    pub program: Program,
    pub path: PathBuf,
}

impl Unavailable {
    fn new(reason: Reason, program: Program, path: &Path) -> Unavailable {
        Unavailable {
            reason,
            program,
            path: path.to_path_buf(),
        }
    }

    /// The `PUTTY_UNAVAILABLE` result.
    pub fn result(&self) -> Value {
        json!({ "reason": self.reason.name(), "program": self.program.name(), "path": self.path.to_string_lossy() })
    }
}

impl From<Unavailable> for Ended {
    fn from(unavailable: Unavailable) -> Ended {
        Ended::Failed(UNAVAILABLE, unavailable.result())
    }
}

/// O-7: Pageant and PuTTYgen sit in the plink folder.
pub fn program_path(plink: &Path, program: Program) -> PathBuf {
    match program {
        Program::Plink => plink.to_path_buf(),
        Program::Pageant => plink.with_file_name("pageant.exe"),
        Program::Puttygen => plink.with_file_name("puttygen.exe"),
    }
}

/// FR-037 from an OS fact: a regular file. A not-found error is `missing`. Another error or file type is `unreadable`.
pub fn present(program: Program, path: &Path) -> Result<(), Unavailable> {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(Unavailable::new(Reason::Missing, program, path))
        }
        _ => Err(Unavailable::new(Reason::Unreadable, program, path)),
    }
}

/// O-6: the major and the minor part of `dwFileVersionMS` are at least 0.75.
pub fn admitted(file_version_ms: u32) -> bool {
    (file_version_ms >> 16, file_version_ms & 0xffff) >= MINIMUM_PAGEANT
}

/// `dwFileVersionMS` of the fixed file version resource. `None`: the file has no readable fixed version.
pub fn file_version(path: &Path) -> Option<u32> {
    let name = HSTRING::from(path.as_os_str());
    // SAFETY: `name` lives for the call.
    let size = unsafe { GetFileVersionInfoSizeW(&name, None) };
    if size == 0 {
        return None;
    }
    let mut data = vec![0u8; size as usize];
    // SAFETY: `data` holds `size` bytes.
    unsafe { GetFileVersionInfoW(&name, None, size, data.as_mut_ptr().cast()) }.ok()?;
    let mut info: *mut core::ffi::c_void = std::ptr::null_mut();
    let mut length = 0u32;
    // SAFETY: `data` holds the version block. On success, `info` points into `data` with `length` bytes.
    let found =
        unsafe { VerQueryValueW(data.as_ptr().cast(), w!("\\"), &mut info, &mut length) }.as_bool();
    if !found || info.is_null() || (length as usize) < size_of::<VS_FIXEDFILEINFO>() {
        return None;
    }
    // SAFETY: `info` points to one `VS_FIXEDFILEINFO` inside `data`, which lives here. The read takes no alignment.
    let fixed = unsafe { info.cast::<VS_FIXEDFILEINFO>().read_unaligned() };
    (fixed.dwSignature == FIXED_SIGNATURE).then_some(fixed.dwFileVersionMS)
}

/// The Pageant check of `chooseSyncPath` and `pageant`: a present file with a readable fixed version of 0.75 or later.
pub fn check_pageant(plink: &Path) -> Result<PathBuf, Unavailable> {
    let path = program_path(plink, Program::Pageant);
    present(Program::Pageant, &path)?;
    match file_version(&path) {
        Some(version) if admitted(version) => Ok(path),
        Some(_) => Err(Unavailable::new(Reason::Version, Program::Pageant, &path)),
        None => Err(Unavailable::new(
            Reason::Unreadable,
            Program::Pageant,
            &path,
        )),
    }
}

/// Contract Δ6: the plink path in POSIX single quotes, U+0027 written as `'\''`. Git runs the command through its shell (connect.c).
pub fn ssh_command(plink: &Path, batch: bool) -> String {
    let quoted = format!("'{}'", plink.to_string_lossy().replace('\'', r"'\''"));
    if batch {
        format!("{quoted} -batch")
    } else {
        quoted
    }
}

/// Sets each name to its value. An inherited value of the same name leaves first. Names match without ASCII case.
fn set(environment: &mut Vec<(OsString, OsString)>, values: &[(&str, OsString)]) {
    environment.retain(|(name, _)| !values.iter().any(|(set, _)| name_is(name, set)));
    environment.extend(
        values
            .iter()
            .map(|(name, value)| (OsString::from(name), value.clone())),
    );
}

/// Contract Δ6: the PuTTY pair of a `remote` run on a Windows context. Only `plink` adds it.
pub fn add_pair(environment: &mut Vec<(OsString, OsString)>, sync: &SyncSettings) {
    if let (SshClient::Plink, Some(plink)) = (sync.ssh_client, &sync.plink_path) {
        set(
            environment,
            &[
                (SSH_COMMAND, ssh_command(plink, true).into()),
                (SSH_VARIANT, "plink".into()),
            ],
        );
    }
}

/// Contract §3 "Worktree key" of a Windows worktree: SHA-256 of the 8 big-endian volume serial bytes, then the 16 file ID bytes.
pub fn worktree_key(identity: &Identity) -> String {
    let mut bytes = identity.volume_serial.to_be_bytes().to_vec();
    bytes.extend_from_slice(&identity.file_id);
    hex(&sha256(&bytes))
}

/// Starts `program` outside every Job of Arbareto, with no inherited handle. The caller owns the process handle.
/// Pageant must keep running after the operation and after Arbareto closes (plan.md D9).
pub fn start_free(
    program: &Path,
    arguments: &[String],
    environment: &[(OsString, OsString)],
    current_dir: &Path,
    console: PROCESS_CREATION_FLAGS,
) -> Result<OwnedHandle, SpawnError> {
    let mut line = command_line(program, arguments)?;
    let application = null_terminated(program.as_os_str())?;
    let directory = null_terminated(current_dir.as_os_str())?;
    let block = environment_block(environment)?;
    let startup = STARTUPINFOW {
        cb: size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    let mut info = PROCESS_INFORMATION::default();
    // SAFETY: each string ends with NUL and outlives the call. `line` is writable. The block ends with two NULs.
    unsafe {
        CreateProcessW(
            PCWSTR(application.as_ptr()),
            Some(PWSTR(line.as_mut_ptr())),
            None,
            None,
            false,
            console | CREATE_UNICODE_ENVIRONMENT,
            Some(block.as_ptr().cast()),
            PCWSTR(directory.as_ptr()),
            &startup,
            &mut info,
        )
    }
    .map_err(|_| SpawnError::OwnershipFailed)?;
    // SAFETY: CreateProcessW returned both handles, and this function owns them. The thread handle closes here.
    let (process, _thread) = unsafe {
        (
            OwnedHandle::from_raw_handle(info.hProcess.0),
            OwnedHandle::from_raw_handle(info.hThread.0),
        )
    };
    Ok(process)
}

/// The end of the readiness wait (contract Δ6 `pageant`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wait {
    Ready,
    Exit,
    NotReady,
}

/// `Ready` when the process exits with status 0, or when `WaitForInputIdle` returns 0 while the process runs.
/// Another exit status, or an unreadable one, gives `Exit`. `limit` without either gives `NotReady`. The process keeps running.
pub fn wait_ready(process: HANDLE, limit: Duration) -> Wait {
    let deadline = Instant::now() + limit;
    // SAFETY: the caller keeps `process` open for the call.
    let running = || unsafe { WaitForSingleObject(process, 0) } == WAIT_TIMEOUT;
    loop {
        // SAFETY: as above.
        if unsafe { WaitForSingleObject(process, 0) } == WAIT_OBJECT_0 {
            let mut code = 1u32;
            // SAFETY: as above, and `code` is a live local.
            let read = unsafe { GetExitCodeProcess(process, &mut code) }.is_ok();
            return if read && code == 0 {
                Wait::Ready
            } else {
                Wait::Exit
            };
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Wait::NotReady;
        }
        let slice = left.min(SLICE).as_millis() as u32;
        // SAFETY: as above. A process without a message queue gives `WAIT_FAILED` at once.
        match unsafe { WaitForInputIdle(process, slice) } {
            0 if running() => return Wait::Ready,
            0 => {}
            idle if idle == WAIT_TIMEOUT.0 => {}
            // SAFETY: as above.
            _ => {
                let _ = unsafe { WaitForSingleObject(process, slice) };
            }
        }
    }
}

/// Contract Δ6 `pageant`: `pageant.exe --encrypted <key>` outside every Job, then the readiness wait.
pub fn start_pageant(
    plink: &Path,
    key: &Path,
    base: &[(OsString, OsString)],
    limit: Duration,
) -> Result<(), Unavailable> {
    let path = check_pageant(plink)?;
    let failed = |reason| Unavailable::new(reason, Program::Pageant, &path);
    let arguments = [
        "--encrypted".to_string(),
        key.to_string_lossy().into_owned(),
    ];
    let folder = path.parent().unwrap_or(&path);
    let process = start_free(&path, &arguments, base, folder, PROCESS_CREATION_FLAGS(0))
        .map_err(|_| failed(Reason::Unreadable))?;
    match wait_ready(HANDLE(process.as_raw_handle()), limit) {
        Wait::Ready => Ok(()),
        Wait::Exit => Err(failed(Reason::Exit)),
        Wait::NotReady => Err(failed(Reason::NotReady)),
    }
}

/// The program, the arguments, and the environment of the connect terminal (contract Δ6 `terminal`).
#[derive(Clone, Debug, PartialEq)]
pub struct Terminal {
    pub program: PathBuf,
    pub arguments: Vec<String>,
    pub environment: Vec<(OsString, OsString)>,
}

/// Windows PowerShell 5.1 from the system folder with `-NoProfile -NoExit` and the constant script.
/// Each value passes only in the environment, so no value lands on the command line. `GIT_SSH_COMMAND` holds no `-batch`.
pub fn terminal(
    system: &Path,
    base: &[(OsString, OsString)],
    git: &Path,
    directory: Option<&Path>,
    target: &str,
    plink: &Path,
) -> Terminal {
    let mut environment = base.to_vec();
    set(
        &mut environment,
        &[
            ("ARBARETO_GIT", git.as_os_str().to_owned()),
            (
                "ARBARETO_DIR",
                directory.map_or_else(OsString::new, |d| d.as_os_str().to_owned()),
            ),
            ("ARBARETO_TARGET", target.into()),
            (SSH_COMMAND, ssh_command(plink, false).into()),
            (SSH_VARIANT, "plink".into()),
        ],
    );
    Terminal {
        program: system.join(r"WindowsPowerShell\v1.0\powershell.exe"),
        arguments: ["-NoProfile", "-NoExit", "-Command", TERMINAL_SCRIPT]
            .map(String::from)
            .to_vec(),
        environment,
    }
}

/// Starts the terminal in a new console, outside every Job.
pub fn start_terminal(terminal: &Terminal, current_dir: &Path) -> Result<(), SpawnError> {
    start_free(
        &terminal.program,
        &terminal.arguments,
        &terminal.environment,
        current_dir,
        CREATE_NEW_CONSOLE,
    )
    .map(drop)
}

/// The system folder (`GetSystemDirectoryW`).
pub fn system_folder() -> Option<PathBuf> {
    let mut buffer = vec![0u16; PATH_UNITS + 1];
    // SAFETY: the call writes at most the slice length.
    let length = unsafe { GetSystemDirectoryW(Some(&mut buffer)) } as usize;
    (length > 0 && length < buffer.len())
        .then(|| PathBuf::from(OsString::from_wide(&buffer[..length])))
}

/// The `readSyncSettings` result: data-model §10 with `programs` (contract Δ3).
pub fn settings_result(sync: &SyncSettings) -> Value {
    let text = |path: &Option<PathBuf>| {
        path.as_ref()
            .map(|path| path.to_string_lossy().into_owned())
    };
    let programs: Vec<Value> = sync
        .plink_path
        .iter()
        .flat_map(|plink| {
            [Program::Plink, Program::Pageant, Program::Puttygen].map(|program| {
                let path = program_path(plink, program);
                json!({ "program": program.name(), "path": path.to_string_lossy(), "present": present(program, &path).is_ok() })
            })
        })
        .collect();
    let files: Vec<Value> = sync
        .remote_key_files
        .iter()
        .map(|file| json!({ "worktreeKey": file.worktree_key, "remote": file.remote, "path": file.path.to_string_lossy() }))
        .collect();
    json!({
        "sshClient": match sync.ssh_client { SshClient::Git => "git", SshClient::Plink => "plink" },
        "defaultPullAction": sync.default_pull_action,
        "plinkPath": text(&sync.plink_path),
        "programs": programs,
        "remoteKeyFiles": files,
        "defaultCloneFolder": text(&sync.default_clone_folder),
        "lastCloneParent": text(&sync.last_clone_parent),
    })
}

/// A picked path that a channel path can hold. A failed picker call is a refusal, not a Cancel (contract §3).
fn picked(pick: Result<Option<PathBuf>, &'static str>) -> Result<Option<PathBuf>, Ended> {
    match pick? {
        None => Ok(None),
        Some(path) if path.to_str().is_some_and(|text| native_path(text).is_ok()) => Ok(Some(path)),
        Some(_) => Err(INVALID.into()),
    }
}

/// The six shell-only settings operations (contract Δ3). `Ok(false)`: a canceled picker changed nothing.
/// `base` is the environment of a started PuTTYgen.
pub fn settings_operation(
    sync: &mut SyncSettings,
    native: &dyn Native,
    base: &[(OsString, OsString)],
    operation: &str,
    payload: &Value,
) -> Result<bool, Ended> {
    let text = |key: &str| payload[key].as_str().ok_or(Ended::Rejected(INVALID));
    match (operation, payload["target"].as_str()) {
        ("readSyncSettings", None) => {}
        ("setSshClient", None) => match text("kind")? {
            "git" => sync.ssh_client = SshClient::Git,
            // FR-033: the user selects the plink program first.
            "plink" if sync.plink_path.is_some() => sync.ssh_client = SshClient::Plink,
            _ => return Err(INVALID.into()),
        },
        ("setDefaultPullAction", None) => {
            let action = text("action")?;
            sync.default_pull_action = PULL_ACTIONS
                .into_iter()
                .find(|known| *known == action)
                .ok_or(Ended::Rejected(INVALID))?;
        }
        ("chooseSyncPath", Some("plink")) => {
            let Some(plink) = picked(native.pick_file(FileKind::Plink))? else {
                return Ok(false);
            };
            check_pageant(&plink)?;
            sync.plink_path = Some(plink);
        }
        ("chooseSyncPath", Some("remoteKey")) => {
            let (worktree_key, remote) = (text("worktreeKey")?, text("remote")?);
            let known = settings::key_file(sync, worktree_key, remote).is_some();
            if !known && sync.remote_key_files.len() >= KEY_FILE_ENTRIES {
                return Err(INVALID.into());
            }
            let Some(path) = picked(native.pick_file(FileKind::Key))? else {
                return Ok(false);
            };
            settings::set_key_file(
                sync,
                KeyFile {
                    worktree_key: worktree_key.to_string(),
                    remote: remote.to_string(),
                    path,
                },
            );
        }
        ("chooseSyncPath", Some("cloneFolder")) => {
            let Some(folder) = picked(native.pick_folder())? else {
                return Ok(false);
            };
            sync.default_clone_folder = Some(folder);
        }
        // FR-033: `plink` keeps its program.
        ("clearSyncPath", Some("plink")) if sync.ssh_client == SshClient::Plink => {
            return Err(INVALID.into());
        }
        ("clearSyncPath", Some("plink")) => sync.plink_path = None,
        ("clearSyncPath", Some("remoteKey")) => {
            let (worktree_key, remote) = (text("worktreeKey")?, text("remote")?);
            sync.remote_key_files
                .retain(|file| file.worktree_key != worktree_key || file.remote != remote);
        }
        ("clearSyncPath", Some("cloneFolder")) => sync.default_clone_folder = None,
        ("launchPuttygen", None) => {
            let plink = sync.plink_path.as_deref().ok_or(Ended::Rejected(INVALID))?;
            let path = program_path(plink, Program::Puttygen);
            present(Program::Puttygen, &path)?;
            let folder = path.parent().unwrap_or(&path);
            start_free(&path, &[], base, folder, PROCESS_CREATION_FLAGS(0))
                .map_err(|_| Unavailable::new(Reason::Unreadable, Program::Puttygen, &path))?;
        }
        _ => return Err(INVALID.into()),
    }
    Ok(true)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    use std::os::windows::io::AsRawHandle;
    use std::time::Instant;

    use serde_json::json;
    use windows::Win32::Foundation::WAIT_TIMEOUT;
    use windows::Win32::System::JobObjects::IsProcessInJob;
    use windows::Win32::System::Threading::{
        DETACHED_PROCESS, TerminateProcess, WaitForSingleObject,
    };
    use windows::core::BOOL;

    use crate::dialogs::tests::Fake;
    use crate::jobs::Supervisor;
    use crate::jobs::tests::{Fixture, child_arguments, test_exe};
    use crate::settings::{KEY_FILE_ENTRIES, KeyFile, SshClient, hex, sha256};
    use crate::spawn::command_line;

    const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    /// The PuTTY folder of the host. Without it, the check prints the skip line of the capability `putty`.
    pub(crate) fn installed() -> Option<PathBuf> {
        let folder = PathBuf::from(std::env::var_os("ProgramFiles")?).join("PuTTY");
        let found = ["plink.exe", "pageant.exe", "puttygen.exe"]
            .iter()
            .all(|name| folder.join(name).is_file());
        if !found {
            println!("\nSKIP putty: no PuTTY in %ProgramFiles%\\PuTTY (unverified)");
        }
        found.then_some(folder)
    }

    /// Feature 003 plan.md P0.3: a case that starts plink, Pageant, or PuTTYgen runs only in Windows Sandbox.
    pub(crate) fn sandbox() -> bool {
        let inside = std::env::var_os("ARBARETO_SANDBOX").is_some_and(|value| value == "1");
        if !inside {
            println!(
                "\nSKIP sandbox: set ARBARETO_SANDBOX=1 only inside Windows Sandbox (unverified)"
            );
        }
        inside
    }

    pub(crate) fn plink_settings(plink: &Path) -> SyncSettings {
        SyncSettings {
            ssh_client: SshClient::Plink,
            plink_path: Some(plink.to_path_buf()),
            ..SyncSettings::default()
        }
    }

    fn pairs(values: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        values
            .iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value)))
            .collect()
    }

    fn operate(
        sync: &mut SyncSettings,
        native: &Fake,
        operation: &str,
        payload: Value,
    ) -> Result<bool, Ended> {
        settings_operation(sync, native, &[], operation, &payload)
    }

    fn refused(code: &'static str) -> Result<bool, Ended> {
        Err(Ended::Rejected(code))
    }

    fn unavailable(reason: &str, program: &str, path: &Path) -> Result<bool, Ended> {
        Err(Ended::Failed(
            "PUTTY_UNAVAILABLE",
            json!({ "reason": reason, "program": program, "path": path }),
        ))
    }

    // ---- The PuTTY pair (contract Δ6) ----

    #[test]
    fn the_plink_command_is_the_path_in_posix_single_quotes_then_batch() {
        let plink = Path::new(r"C:\Program Files\it's PuTTY\plink.exe");
        assert_eq!(
            ssh_command(plink, true),
            r"'C:\Program Files\it'\''s PuTTY\plink.exe' -batch"
        );
        assert_eq!(
            ssh_command(plink, false),
            r"'C:\Program Files\it'\''s PuTTY\plink.exe'"
        );
    }

    #[test]
    fn only_plink_adds_the_pair_and_the_pair_replaces_an_inherited_value() {
        let base = pairs(&[
            ("git_ssh_command", "ssh -i C:/keys/id"),
            ("Git_Ssh_Variant", "ssh"),
            ("PATH", r"C:\bin"),
        ]);
        let mut git = base.clone();
        add_pair(&mut git, &SyncSettings::default());
        assert_eq!(git, base, "Git's own configuration adds nothing");
        let mut environment = base.clone();
        add_pair(
            &mut environment,
            &plink_settings(Path::new(r"C:\PuTTY 0.85\plink.exe")),
        );
        assert_eq!(
            environment,
            pairs(&[
                ("PATH", r"C:\bin"),
                ("GIT_SSH_COMMAND", r"'C:\PuTTY 0.85\plink.exe' -batch"),
                ("GIT_SSH_VARIANT", "plink"),
            ])
        );
    }

    // ---- The programs (FR-037, O-6, O-7) ----

    #[test]
    fn pageant_and_puttygen_resolve_in_the_plink_folder() {
        let plink = Path::new(r"D:\tools\putty 0.85\PLINK.EXE");
        assert_eq!(program_path(plink, Program::Plink), plink);
        assert_eq!(
            program_path(plink, Program::Pageant),
            Path::new(r"D:\tools\putty 0.85\pageant.exe")
        );
        assert_eq!(
            program_path(plink, Program::Puttygen),
            Path::new(r"D:\tools\putty 0.85\puttygen.exe")
        );
    }

    #[test]
    fn a_missing_program_gives_missing_and_another_file_type_gives_unreadable_with_the_program_and_the_path()
     {
        let fixture = Fixture::new();
        let missing = fixture.path("plink.exe");
        let refusal = present(Program::Plink, &missing).expect_err("missing");
        assert_eq!(
            refusal.result(),
            json!({ "reason": "missing", "program": "plink", "path": missing })
        );
        let folder = fixture.path("pageant.exe");
        std::fs::create_dir(&folder).expect("folder");
        assert_eq!(
            present(Program::Pageant, &folder)
                .expect_err("a folder")
                .result(),
            json!({ "reason": "unreadable", "program": "pageant", "path": folder })
        );
        let parent = fixture.path(r"gone\puttygen.exe");
        assert_eq!(
            present(Program::Puttygen, &parent).map_err(|refusal| refusal.reason),
            Err(Reason::Missing)
        );
        assert_eq!(present(Program::Plink, &test_exe()), Ok(()));
    }

    #[test]
    fn pageant_needs_a_fixed_file_version_of_0_75_or_later() {
        assert!(!admitted(0x0000_004a), "0.74");
        assert!(admitted(0x0000_004b), "0.75");
        assert!(admitted(0x0000_0055), "0.85");
        assert!(admitted(0x0001_0000), "1.0");
        let fixture = Fixture::new();
        let pageant = fixture.path("pageant.exe");
        std::fs::write(&pageant, "no version resource").expect("file");
        assert_eq!(
            check_pageant(&fixture.path("plink.exe")).map_err(|refusal| refusal.result()),
            Err(json!({ "reason": "unreadable", "program": "pageant", "path": pageant }))
        );
        let Some(folder) = installed() else {
            return;
        };
        let version = file_version(&folder.join("pageant.exe")).expect("a fixed file version");
        assert!(admitted(version), "{version:#x}");
        assert_eq!(
            check_pageant(&folder.join("plink.exe")),
            Ok(folder.join("pageant.exe"))
        );
    }

    // ---- Pageant start and wait (contract Δ6 `pageant`) ----

    /// Starts `program` in a child `mode` as `start_pageant` starts Pageant. `DETACHED_PROCESS` keeps its lines off the test console.
    fn free_child(program: &Path, mode: &[&str]) -> OwnedHandle {
        let environment: Vec<(OsString, OsString)> = std::env::vars_os().collect();
        start_free(
            program,
            &child_arguments(mode),
            &environment,
            &std::env::temp_dir(),
            DETACHED_PROCESS,
        )
        .expect("start outside every Job")
    }

    /// A copy of the test binary with the GUI subsystem. `WaitForInputIdle` fails for each console-subsystem process,
    /// also with a message loop (observed with Windows PowerShell 5.1). PE format: `Subsystem` is at offset 68 of the optional header.
    fn gui_test_exe(fixture: &Fixture) -> PathBuf {
        let mut image = std::fs::read(test_exe()).expect("test binary");
        let pe = u32::from_le_bytes(image[0x3c..0x40].try_into().expect("e_lfanew")) as usize;
        assert_eq!(&image[pe..pe + 4], b"PE\0\0", "PE signature");
        let subsystem = pe + 24 + 68;
        assert_eq!(
            u16::from_le_bytes([image[subsystem], image[subsystem + 1]]),
            3,
            "IMAGE_SUBSYSTEM_WINDOWS_CUI"
        );
        image[subsystem..subsystem + 2].copy_from_slice(&2u16.to_le_bytes());
        let path = fixture.path("gui-probe.exe");
        std::fs::write(&path, image).expect("GUI copy");
        path
    }

    fn raw(process: &OwnedHandle) -> HANDLE {
        HANDLE(process.as_raw_handle())
    }

    fn in_job(process: &OwnedHandle, job: HANDLE) -> bool {
        let mut member = BOOL(0);
        unsafe { IsProcessInJob(raw(process), Some(job), &mut member) }.expect("IsProcessInJob");
        member.as_bool()
    }

    fn end(process: &OwnedHandle) {
        let _ = unsafe { TerminateProcess(raw(process), 1) };
    }

    /// The probe GUI child stands in for a new Pageant agent. The case with real Pageant runs only in Windows Sandbox.
    #[test]
    fn the_wait_gives_ready_at_exit_status_0_or_at_input_idle_and_exit_or_not_ready_otherwise() {
        let fixture = Fixture::new();
        let jobs = Supervisor::start().expect("supervisor");
        jobs.open("op-free").expect("open");
        let job = jobs.job_handle("op-free").expect("Job");
        let gui = free_child(&gui_test_exe(&fixture), &["gui", "20000"]);
        assert!(!in_job(&gui, job), "outside the operation Job");
        assert_eq!(
            wait_ready(raw(&gui), Duration::from_secs(10)),
            Wait::Ready,
            "idle"
        );
        assert_eq!(
            unsafe { WaitForSingleObject(raw(&gui), 0) },
            WAIT_TIMEOUT,
            "the agent keeps running"
        );
        end(&gui);
        for (code, ready) in [("0", Wait::Ready), ("3", Wait::Exit)] {
            let child = free_child(&test_exe(), &["emit", "", code]);
            assert_eq!(
                wait_ready(raw(&child), Duration::from_secs(10)),
                ready,
                "exit {code}"
            );
        }
        // A console child has no message queue, so only the limit ends the wait.
        let console = free_child(&test_exe(), &["sleep", "20000"]);
        let start = Instant::now();
        assert_eq!(
            wait_ready(raw(&console), Duration::from_millis(700)),
            Wait::NotReady
        );
        assert!(start.elapsed() >= Duration::from_millis(700));
        end(&console);
        jobs.close_all();
        jobs.shutdown();
    }

    #[test]
    fn a_real_pageant_starts_outside_every_job_and_an_unreadable_key_gives_exit() {
        if !sandbox() {
            return;
        }
        let Some(folder) = installed() else {
            return;
        };
        let fixture = Fixture::new();
        let environment: Vec<(OsString, OsString)> = std::env::vars_os().collect();
        let started = start_pageant(
            &folder.join("plink.exe"),
            &fixture.path("missing.ppk"),
            &environment,
            PAGEANT_READY,
        );
        assert_eq!(started.map_err(|refusal| refusal.reason), Err(Reason::Exit));
    }

    // ---- Connect in a terminal (contract Δ6 `terminal`) ----

    #[test]
    fn the_terminal_passes_each_value_only_in_its_environment() {
        assert_eq!(
            TERMINAL_SCRIPT,
            "if ($env:ARBARETO_DIR) { & $env:ARBARETO_GIT --no-lazy-fetch -C $env:ARBARETO_DIR ls-remote --heads -- $env:ARBARETO_TARGET } else { & $env:ARBARETO_GIT --no-lazy-fetch ls-remote --heads -- $env:ARBARETO_TARGET }",
            "the contract Δ6 script"
        );
        let system = Path::new(r"C:\Windows\System32");
        let base = pairs(&[
            ("PATH", r"C:\bin"),
            ("arbareto_dir", r"C:\stale"),
            ("GIT_SSH_COMMAND", "ssh"),
        ]);
        let git = Path::new(r"C:\Program Files\Git\mingw64\bin\git.exe");
        let plink = Path::new(r"C:\Program Files\PuTTY\plink.exe");
        let target = "ssh://git@example.test:2222/team/repo.git";
        let worktree = Path::new(r"C:\src\it's repo");
        let opened = terminal(system, &base, git, Some(worktree), target, plink);
        assert_eq!(
            opened.program,
            Path::new(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
        );
        assert_eq!(
            opened.arguments,
            ["-NoProfile", "-NoExit", "-Command", TERMINAL_SCRIPT]
        );
        let line = String::from_utf16(
            &command_line(&opened.program, &opened.arguments).expect("command line"),
        )
        .expect("UTF-16");
        for value in [
            r"C:\Program Files\Git",
            r"C:\src",
            "example.test",
            "PuTTY",
            "-batch",
        ] {
            assert!(!line.contains(value), "{value} on the command line");
        }
        assert_eq!(
            opened.environment,
            pairs(&[
                ("PATH", r"C:\bin"),
                ("ARBARETO_GIT", r"C:\Program Files\Git\mingw64\bin\git.exe"),
                ("ARBARETO_DIR", r"C:\src\it's repo"),
                ("ARBARETO_TARGET", target),
                ("GIT_SSH_COMMAND", r"'C:\Program Files\PuTTY\plink.exe'"),
                ("GIT_SSH_VARIANT", "plink"),
            ])
        );
        let clone = terminal(system, &base, git, None, target, plink);
        let directory: Vec<&OsString> = clone
            .environment
            .iter()
            .filter(|(name, _)| name == "ARBARETO_DIR")
            .map(|(_, value)| value)
            .collect();
        assert_eq!(directory, [&OsString::new()], "empty without repositoryId");
    }

    #[test]
    fn the_terminal_runs_windows_powershell_from_the_system_folder() {
        let system = system_folder().expect("system folder");
        assert!(
            system.join("kernel32.dll").is_file(),
            "{}",
            system.display()
        );
        if !sandbox() {
            return;
        }
        let Some(folder) = installed() else {
            return;
        };
        let environment: Vec<(OsString, OsString)> = std::env::vars_os().collect();
        let opened = terminal(
            &system,
            &environment,
            &test_exe(),
            None,
            "origin",
            &folder.join("plink.exe"),
        );
        assert_eq!(start_terminal(&opened, &std::env::temp_dir()), Ok(()));
    }

    // ---- The settings operations (contract Δ3, data-model §10) ----

    #[test]
    fn the_default_pull_action_is_pull_and_each_action_round_trips() {
        let mut sync = SyncSettings::default();
        let native = Fake::default();
        assert_eq!(settings_result(&sync)["defaultPullAction"], "pull");
        for action in ["pull-merge", "pull-rebase", "fetch", "fetch-all", "pull"] {
            assert_eq!(
                operate(
                    &mut sync,
                    &native,
                    "setDefaultPullAction",
                    json!({ "action": action })
                ),
                Ok(true)
            );
            assert_eq!(settings_result(&sync)["defaultPullAction"], action);
        }
        assert_eq!(
            operate(
                &mut sync,
                &native,
                "setDefaultPullAction",
                json!({ "action": "rebase" })
            ),
            refused("INVALID_REQUEST")
        );
        assert!(native.calls().is_empty(), "no picker");
    }

    #[test]
    fn plink_needs_its_program_first_and_keeps_it_while_selected() {
        let mut sync = SyncSettings::default();
        let native = Fake::default();
        let plink = json!({ "kind": "plink" });
        assert_eq!(
            operate(&mut sync, &native, "setSshClient", plink.clone()),
            refused("INVALID_REQUEST")
        );
        assert_eq!(sync.ssh_client, SshClient::Git);
        let path = PathBuf::from(r"C:\PuTTY\plink.exe");
        sync.plink_path = Some(path.clone());
        assert_eq!(operate(&mut sync, &native, "setSshClient", plink), Ok(true));
        assert_eq!(settings_result(&sync)["sshClient"], "plink");
        let clear = json!({ "target": "plink" });
        assert_eq!(
            operate(&mut sync, &native, "clearSyncPath", clear.clone()),
            refused("INVALID_REQUEST")
        );
        assert_eq!(sync.plink_path, Some(path));
        assert_eq!(
            operate(&mut sync, &native, "setSshClient", json!({ "kind": "git" })),
            Ok(true)
        );
        assert_eq!(
            operate(&mut sync, &native, "clearSyncPath", clear),
            Ok(true)
        );
        assert_eq!(settings_result(&sync)["plinkPath"], Value::Null);
        assert_eq!(settings_result(&sync)["programs"], json!([]));
    }

    #[test]
    fn choosing_plink_reads_the_pageant_version_before_it_stores_the_path() {
        let fixture = Fixture::new();
        let target = json!({ "target": "plink" });
        let mut sync = SyncSettings::default();
        let lone = Fake {
            file: Some(fixture.path("plink.exe")),
            ..Fake::default()
        };
        assert_eq!(
            operate(&mut sync, &lone, "chooseSyncPath", target.clone()),
            unavailable("missing", "pageant", &fixture.path("pageant.exe"))
        );
        assert_eq!(lone.calls(), ["pick_file plink"]);
        assert_eq!(sync.plink_path, None, "nothing stored");
        assert_eq!(
            operate(
                &mut sync,
                &Fake::default(),
                "chooseSyncPath",
                target.clone()
            ),
            Ok(false),
            "a canceled picker"
        );
        let broken = Fake {
            pick_failure: Some("PICKER_FAILED"),
            ..Fake::default()
        };
        assert_eq!(
            operate(&mut sync, &broken, "chooseSyncPath", target.clone()),
            refused("PICKER_FAILED")
        );
        let Some(folder) = installed() else {
            return;
        };
        let picked = Fake {
            file: Some(folder.join("plink.exe")),
            ..Fake::default()
        };
        assert_eq!(
            operate(&mut sync, &picked, "chooseSyncPath", target),
            Ok(true)
        );
        let result = settings_result(&sync);
        assert_eq!(result["plinkPath"], json!(folder.join("plink.exe")));
        assert_eq!(
            result["programs"],
            json!([
                { "program": "plink", "path": folder.join("plink.exe"), "present": true },
                { "program": "pageant", "path": folder.join("pageant.exe"), "present": true },
                { "program": "puttygen", "path": folder.join("puttygen.exe"), "present": true },
            ])
        );
    }

    #[test]
    fn a_key_file_belongs_to_one_worktree_and_remote_and_a_257th_is_refused_before_the_picker() {
        let fixture = Fixture::new();
        let mut sync = SyncSettings::default();
        let native = Fake {
            file: Some(fixture.path("id.ppk")),
            ..Fake::default()
        };
        let key = |n: usize| format!("{n:064x}");
        for n in 0..KEY_FILE_ENTRIES {
            let payload =
                json!({ "target": "remoteKey", "worktreeKey": key(n), "remote": "origin" });
            assert_eq!(
                operate(&mut sync, &native, "chooseSyncPath", payload),
                Ok(true)
            );
        }
        let again = json!({ "target": "remoteKey", "worktreeKey": key(0), "remote": "origin" });
        assert_eq!(
            operate(&mut sync, &native, "chooseSyncPath", again.clone()),
            Ok(true),
            "the same pair replaces its entry"
        );
        assert_eq!(sync.remote_key_files.len(), KEY_FILE_ENTRIES);
        let picks = native.calls().len();
        let another = json!({ "target": "remoteKey", "worktreeKey": key(0), "remote": "upstream" });
        assert_eq!(
            operate(&mut sync, &native, "chooseSyncPath", another),
            refused("INVALID_REQUEST")
        );
        assert_eq!(native.calls().len(), picks, "no picker for a refused entry");
        assert_eq!(
            operate(&mut sync, &native, "clearSyncPath", again),
            Ok(true)
        );
        assert_eq!(sync.remote_key_files.len(), KEY_FILE_ENTRIES - 1);
        assert_eq!(
            settings_result(&sync)["remoteKeyFiles"][0],
            json!({ "worktreeKey": key(1), "remote": "origin", "path": fixture.path("id.ppk") })
        );
    }

    #[test]
    fn the_settings_hold_only_the_data_model_fields_and_programs_from_os_facts() {
        let fixture = Fixture::new();
        let plink = fixture.path("plink.exe");
        std::fs::write(fixture.path("puttygen.exe"), "a file").expect("file");
        let folder = fixture.path("folder");
        let mut sync = SyncSettings {
            default_pull_action: "fetch-all",
            remote_key_files: vec![KeyFile {
                worktree_key: KEY.to_string(),
                remote: "origin".to_string(),
                path: fixture.path("id.ppk"),
            }],
            last_clone_parent: Some(fixture.path("clones")),
            ..plink_settings(&plink)
        };
        let picked = Fake {
            folder: Some(folder.clone()),
            ..Fake::default()
        };
        assert_eq!(
            operate(
                &mut sync,
                &picked,
                "chooseSyncPath",
                json!({ "target": "cloneFolder" })
            ),
            Ok(true)
        );
        assert_eq!(picked.calls(), ["pick_folder"]);
        assert_eq!(
            operate(&mut sync, &Fake::default(), "readSyncSettings", json!({})),
            Ok(true)
        );
        assert_eq!(
            settings_result(&sync),
            json!({
                "sshClient": "plink",
                "defaultPullAction": "fetch-all",
                "plinkPath": plink,
                "programs": [
                    { "program": "plink", "path": plink, "present": false },
                    { "program": "pageant", "path": fixture.path("pageant.exe"), "present": false },
                    { "program": "puttygen", "path": fixture.path("puttygen.exe"), "present": true },
                ],
                "remoteKeyFiles": [{ "worktreeKey": KEY, "remote": "origin", "path": fixture.path("id.ppk") }],
                "defaultCloneFolder": folder,
                "lastCloneParent": fixture.path("clones"),
            })
        );
        assert_eq!(
            operate(
                &mut sync,
                &Fake::default(),
                "clearSyncPath",
                json!({ "target": "cloneFolder" })
            ),
            Ok(true)
        );
        assert_eq!(sync.default_clone_folder, None);
    }

    #[test]
    fn launch_puttygen_refuses_a_missing_puttygen_and_starts_it_only_in_sandbox() {
        let fixture = Fixture::new();
        let native = Fake::default();
        let mut sync = SyncSettings::default();
        assert_eq!(
            operate(&mut sync, &native, "launchPuttygen", json!({})),
            refused("INVALID_REQUEST"),
            "no plink folder"
        );
        sync.plink_path = Some(fixture.path("plink.exe"));
        assert_eq!(
            operate(&mut sync, &native, "launchPuttygen", json!({})),
            unavailable("missing", "puttygen", &fixture.path("puttygen.exe"))
        );
        if !sandbox() {
            return;
        }
        let Some(folder) = installed() else {
            return;
        };
        sync.plink_path = Some(folder.join("plink.exe"));
        assert_eq!(
            operate(&mut sync, &native, "launchPuttygen", json!({})),
            Ok(true)
        );
    }

    #[test]
    fn the_worktree_key_hashes_the_big_endian_volume_serial_then_the_file_id() {
        let identity = Identity {
            volume_serial: 0x0102_0304_0506_0708,
            file_id: [0xaa; 16],
        };
        let mut bytes = vec![1, 2, 3, 4, 5, 6, 7, 8];
        bytes.extend([0xaa; 16]);
        assert_eq!(worktree_key(&identity), hex(&sha256(&bytes)));
        assert_ne!(
            worktree_key(&identity),
            hex(&sha256(identity_text(&identity).as_bytes())),
            "the hash input is bytes, not the hex text"
        );
    }

    fn identity_text(identity: &Identity) -> String {
        crate::bootstrap::PhysicalIdentity::Windows(*identity).text()
    }
}
