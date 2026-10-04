// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

//! The shell side of contract §11 "WSL repositories": distro checks, `wsl.exe` process requests,
//! the mutation anchor, and the WSL identity probes.
//!
//! Proposed §6 frames for T212 (the T206 double in `tests/git/bun-runner.ts` answers the same shapes):
//! - `wslDistros` with a `repositoryDiscovery` context: the context path, `distros` facts, and the saved Git of each listed GUID.
//!   The service holds only the bootstrap ID, so it routes that path.
//! - `wslProbe` with that context and a listed `distro`: `probe_command`, deadline at most 60 seconds.
//!   The shell parses the probe output itself and binds the `Installation` and the Git identity to the context.
//!   Output that fails a §11 rule binds nothing. The service still gets the output for its own §11 refusals.
//! - `register` WSL form: only the context ID, the issued `gitInstallationId`, and `confirm`.
//!   The shell issues the ID only from the bound facts. The service never names a Linux program.
//! - `run` and `identity` against a WSL Git: `git_command` and `identity`. A mutation starts its anchor first.

// No frame handler calls this module yet. T212 wires the WSL frames into `process_requests.rs` and `bootstrap.rs`.
#![cfg_attr(not(test), expect(dead_code, reason = "T212 wires the WSL frames"))]

use std::ffi::OsString;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use windows::Win32::Foundation::{ERROR_SUCCESS, HANDLE, WAIT_OBJECT_0};
use windows::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_READ, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegCloseKey, RegEnumKeyExW,
    RegGetValueW, RegOpenKeyExW,
};
use windows::Win32::System::SystemInformation::GetSystemWindowsDirectoryW;
use windows::Win32::System::Threading::{
    GetExitCodeProcess, TerminateProcess, WaitForSingleObject,
};
use windows::core::{HSTRING, PWSTR, w};

use crate::process_requests::{BOOTSTRAP_DEADLINE_MS, Code, is_identifier};
use crate::spawn::{Input, SpawnError, SpawnRequest, spawn};

/// Contract §11 "Paths and file access": the identity probes run this fixed path.
pub const STAT: &str = "/usr/bin/stat";
/// Contract §5 "Diagnostic bytes retained": 64 KiB per stream. A list call or a `stat` probe prints far less.
const RETAINED_BYTES: usize = 64 * 1024;
/// Contract §11 "Distro checks": the list calls use the §5 probe deadline. The identity probes and the anchor answer use it too.
const PROBE_DEADLINE: Duration = Duration::from_millis(BOOTSTRAP_DEADLINE_MS);
const INVALID: Code = "INVALID_REQUEST";
/// The registration key of the WSL distros (contract §11 "Distro checks").
const LXSS: &str = r"Software\Microsoft\Windows\CurrentVersion\Lxss";

/// The texts of `src/contracts/wsl-process.json`. The service and the T206 double read the same file.
pub struct Texts {
    pub wrapper: String,
    pub anchor: String,
    pub probe: String,
}

pub fn texts() -> &'static Texts {
    static TEXTS: OnceLock<Texts> = OnceLock::new();
    TEXTS.get_or_init(|| {
        let file: Value =
            serde_json::from_str(include_str!("../../src/contracts/wsl-process.json"))
                .expect("wsl-process.json is valid JSON");
        let text = |name: &str| {
            file[name]
                .as_array()
                .expect("a line array")
                .iter()
                .map(|line| line.as_str().expect("a line"))
                .collect::<Vec<_>>()
                .join("\n")
        };
        Texts {
            wrapper: text("wrapper"),
            anchor: text("anchor"),
            probe: text("probe"),
        }
    })
}

/// `%SystemRoot%\System32\wsl.exe`. `GetSystemWindowsDirectoryW` gives `%SystemRoot%` without the process environment.
pub fn wsl_program() -> PathBuf {
    let mut buffer = [0u16; 260];
    // SAFETY: the call writes at most the buffer length and returns the written length or the needed size.
    let length = unsafe { GetSystemWindowsDirectoryW(Some(&mut buffer)) } as usize;
    let windows = if length > 0 && length < buffer.len() {
        PathBuf::from(OsString::from_wide(&buffer[..length]))
    } else {
        PathBuf::new()
    };
    windows.join(r"System32\wsl.exe")
}

/// Contract §11 "Process launch": `WSL_UTF8=1` and an empty `WSLENV`, so no Windows variable reaches Linux.
pub fn environment(base: &[(OsString, OsString)]) -> Vec<(OsString, OsString)> {
    let mut environment: Vec<(OsString, OsString)> = base
        .iter()
        .filter(|(name, _)| {
            !name.eq_ignore_ascii_case("WSL_UTF8") && !name.eq_ignore_ascii_case("WSLENV")
        })
        .cloned()
        .collect();
    environment.push(("WSL_UTF8".into(), "1".into()));
    environment.push(("WSLENV".into(), OsString::new()));
    environment
}

/// The stdin of a `wsl.exe` process (contract §6 "Console and input").
#[derive(Clone, Debug)]
pub enum Stdin {
    Closed,
    Bytes(Vec<u8>),
    /// Only the anchor keeps its stdin open until `ended`.
    Open,
}

/// One `wsl.exe` process. `program` is always `wsl_program()` in the product.
#[derive(Clone, Debug)]
pub struct Command {
    pub program: PathBuf,
    pub arguments: Vec<String>,
    pub environment: Vec<(OsString, OsString)>,
    pub stdin: Stdin,
}

impl Command {
    /// `wsl: true` gives `CREATE_NO_WINDOW` (contract §6 "Console and input").
    pub fn spawn_request<'a>(&'a self, current_dir: &'a Path) -> SpawnRequest<'a> {
        SpawnRequest {
            program: &self.program,
            arguments: &self.arguments,
            environment: &self.environment,
            current_dir,
            wsl: true,
            input: match &self.stdin {
                Stdin::Closed => Input::Closed,
                Stdin::Bytes(bytes) => Input::Bytes(bytes),
                Stdin::Open => Input::Stream,
            },
        }
    }
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| s.to_string()).collect()
}

/// `wsl.exe --distribution <distro> --cd / --exec /bin/sh -c <text> sh <rest>`.
fn shell_command(
    distro: &str,
    text: &str,
    rest: &[&str],
    base: &[(OsString, OsString)],
    stdin: Stdin,
) -> Command {
    let mut arguments = strings(&[
        "--distribution",
        distro,
        "--cd",
        "/",
        "--exec",
        "/bin/sh",
        "-c",
        text,
        "sh",
    ]);
    arguments.extend(strings(rest));
    Command {
        program: wsl_program(),
        arguments,
        environment: environment(base),
        stdin,
    }
}

// ---- Distro checks ----

/// A `WSL_UNAVAILABLE` reason that the shell decides (contract §9).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    WslMissing,
    DistroMissing,
    NotWsl2,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::WslMissing => "wsl-missing",
            Reason::DistroMissing => "distro-missing",
            Reason::NotWsl2 => "not-wsl2",
        }
    }
}

/// One `HKCU\...\Lxss\{GUID}` key with its `DistributionName` and `Version`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Key {
    pub guid: String,
    pub name: String,
    pub version: u32,
}

/// The two list calls and the keys of the listed names.
#[derive(Debug)]
pub struct Distros {
    pub listed: Vec<String>,
    pub running: Vec<String>,
    pub keys: Vec<Key>,
}

/// The end of one `wsl.exe` process. `exit_code` is `None` when the process did not end by itself.
pub struct Output {
    pub exit_code: Option<u32>,
    pub stdout: Vec<u8>,
}

/// The process and registry calls of this module. Tests inject them.
pub trait Host {
    /// Runs one `wsl.exe` process to its end. `None`: it did not start or did not end within the probe deadline.
    fn run(&self, command: &Command) -> Option<Output>;
    fn keys(&self) -> Vec<Key>;
}

pub fn list_command(running: bool, base: &[(OsString, OsString)]) -> Command {
    let arguments = if running {
        strings(&["--list", "--running", "--quiet"])
    } else {
        strings(&["--list", "--quiet"])
    };
    Command {
        program: wsl_program(),
        arguments,
        environment: environment(base),
        stdin: Stdin::Closed,
    }
}

/// Strict UTF-8, one name per line (contract §11 "Distro checks"). A name holds no control character.
pub fn parse_list(bytes: &[u8]) -> Option<Vec<String>> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut names = Vec::new();
    for line in text.split('\n') {
        let name = line.strip_suffix('\r').unwrap_or(line);
        if name.chars().any(char::is_control) {
            return None;
        }
        if !name.is_empty() {
            names.push(name.to_string());
        }
    }
    Some(names)
}

/// The key whose `DistributionName` equals the listed name.
pub fn lookup<'a>(keys: &'a [Key], name: &str) -> Result<&'a Key, Reason> {
    let key = keys
        .iter()
        .find(|key| key.name == name)
        .ok_or(Reason::DistroMissing)?;
    if key.version == 2 {
        Ok(key)
    } else {
        Err(Reason::NotWsl2)
    }
}

/// A missing `wsl.exe` or a failed list call gives `wsl-missing`.
pub fn distros(host: &dyn Host, base: &[(OsString, OsString)]) -> Result<Distros, Reason> {
    let list = |running| {
        host.run(&list_command(running, base))
            .filter(|out| out.exit_code == Some(0))
            .and_then(|out| parse_list(&out.stdout))
            .ok_or(Reason::WslMissing)
    };
    let listed = list(false)?;
    let running = list(true)?;
    let keys = host
        .keys()
        .into_iter()
        .filter(|key| listed.contains(&key.name))
        .collect();
    Ok(Distros {
        listed,
        running,
        keys,
    })
}

// ---- Process launch ----

/// The approved Linux Git of one distro and its helper paths (data-model §1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Installation {
    pub distro: String,
    pub guid: String,
    pub git: String,
    pub systemd_run: String,
    pub systemctl: String,
    pub setsid: String,
}

/// The wrapper `<mode>` (contract §11 "Process launch").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Probe,
    Read,
    Mutation,
    Network,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Mode::Probe => "probe",
            Mode::Read => "read",
            Mode::Mutation => "mutation",
            Mode::Network => "network",
        }
    }
}

/// The anchor matches `arbareto-<operation ID>-*.scope`, so the ID must hold no glob character.
pub fn unit_name(operation_id: &str, n: u32) -> Result<String, Code> {
    if !is_identifier(operation_id) {
        return Err(INVALID);
    }
    Ok(format!("arbareto-{operation_id}-{n}.scope"))
}

/// The bootstrap Git probe. It runs without the wrapper (contract §11 "Git per distro").
pub fn probe_command(distro: &str, base: &[(OsString, OsString)]) -> Command {
    shell_command(distro, &texts().probe, &[], base, Stdin::Closed)
}

/// One program through the wrapper, in its own scope.
#[allow(clippy::too_many_arguments)]
pub fn wrapped(
    installation: &Installation,
    mode: Mode,
    unit: &str,
    index: Option<&str>,
    program: &str,
    arguments: &[String],
    base: &[(OsString, OsString)],
    stdin: Stdin,
) -> Command {
    let mut rest = vec![
        unit,
        mode.as_str(),
        index.unwrap_or(""),
        &installation.systemd_run,
        &installation.systemctl,
        &installation.setsid,
        program,
    ];
    rest.extend(arguments.iter().map(String::as_str));
    shell_command(&installation.distro, &texts().wrapper, &rest, base, stdin)
}

/// A Git process. `arguments` are the service arguments, `--no-lazy-fetch` first. `-C` takes the Linux directory.
/// Only a mutation passes an index file (contract §11 "Process launch").
#[allow(clippy::too_many_arguments)]
pub fn git_command(
    installation: &Installation,
    mode: Mode,
    unit: &str,
    index: Option<&str>,
    directory: &str,
    arguments: &[String],
    base: &[(OsString, OsString)],
    stdin: Stdin,
) -> Result<Command, Code> {
    let [first, rest @ ..] = arguments else {
        return Err(INVALID);
    };
    // A directory that starts with `-` would become a Git option.
    if first != "--no-lazy-fetch"
        || !directory.starts_with('/')
        || (index.is_some() && mode != Mode::Mutation)
    {
        return Err(INVALID);
    }
    let mut git = strings(&["--no-lazy-fetch", "-C", directory]);
    git.extend(rest.iter().cloned());
    Ok(wrapped(
        installation,
        mode,
        unit,
        index,
        &installation.git,
        &git,
        base,
        stdin,
    ))
}

/// The anchor runs without the wrapper and without `setsid` (contract §11 "Process ownership").
pub fn anchor_command(
    installation: &Installation,
    operation_id: &str,
    base: &[(OsString, OsString)],
) -> Result<Command, Code> {
    if !is_identifier(operation_id) {
        return Err(INVALID);
    }
    Ok(shell_command(
        &installation.distro,
        &texts().anchor,
        &[&installation.systemctl, operation_id],
        base,
        Stdin::Open,
    ))
}

/// A request for another distro or Git path than the registered installation is refused.
pub fn pinned(installation: &Installation, distro: &str, git: &str) -> Result<(), Code> {
    if installation.distro == distro && installation.git == git {
        Ok(())
    } else {
        Err(INVALID)
    }
}

// ---- Identity ----

/// A WSL identity: the distro GUID, the `statfs` ID, and the inode. It holds no device number (contract §11).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WslIdentity {
    pub guid: String,
    pub file_system_id: String,
    pub inode: String,
    pub file_system_type: String,
}

impl WslIdentity {
    pub fn reply(&self) -> Value {
        json!({
            "distroGuid": self.guid,
            "fileSystemId": self.file_system_id,
            "inode": self.inode,
            "fileSystemType": self.file_system_type,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Every type except `ef53` and `v9fs`, or an ID of 0.
    NoFsUuid,
    /// Type `v9fs`, magic `1021997`: a Windows drive.
    MixedLocation,
    /// A failed or malformed probe, as a failed `FileIdInfo` call (contract §6).
    Failed,
    /// An operation ID or a path that the request rules refuse.
    Invalid,
}

impl Refusal {
    pub fn reply(self) -> Value {
        match self {
            Refusal::NoFsUuid => {
                json!({ "code": "UNSUPPORTED_REPOSITORY", "reason": "no-fs-uuid" })
            }
            Refusal::MixedLocation => {
                json!({ "code": "UNSUPPORTED_REPOSITORY", "reason": "mixed-location" })
            }
            Refusal::Failed => json!({ "code": "UNSUPPORTED_REPOSITORY" }),
            Refusal::Invalid => json!({ "code": INVALID }),
        }
    }
}

fn is_hex(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_decimal(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// One output line with its line end.
fn line(bytes: &[u8]) -> Option<&str> {
    std::str::from_utf8(bytes)
        .ok()?
        .strip_suffix('\n')
        .filter(|line| !line.contains('\n'))
}

/// GNU `stat --file-system` prints `%t` and `%i` in lowercase hex. Only type `ef53` derives its ID from the UUID (research R13 P7).
pub fn classify(guid: &str, inode: &[u8], file_system: &[u8]) -> Result<WslIdentity, Refusal> {
    let inode = line(inode)
        .filter(|i| is_decimal(i))
        .ok_or(Refusal::Failed)?;
    let (kind, id) = line(file_system)
        .and_then(|fs| fs.split_once(':'))
        .filter(|(kind, id)| is_hex(kind) && is_hex(id))
        .ok_or(Refusal::Failed)?;
    match kind {
        "1021997" => Err(Refusal::MixedLocation),
        "ef53" if id.bytes().any(|b| b != b'0') => Ok(WslIdentity {
            guid: guid.to_string(),
            file_system_id: id.to_string(),
            inode: inode.to_string(),
            file_system_type: kind.to_string(),
        }),
        _ => Err(Refusal::NoFsUuid),
    }
}

/// The two `stat` probes through the wrapper in `probe` mode. They use the units `n` and `n + 1`.
pub fn identity(
    host: &dyn Host,
    installation: &Installation,
    operation_id: &str,
    n: u32,
    path: &str,
    base: &[(OsString, OsString)],
) -> Result<WslIdentity, Refusal> {
    // A path that starts with `-` would become a `stat` option.
    if !path.starts_with('/') {
        return Err(Refusal::Invalid);
    }
    let probe = |unit: u32, options: &[&str]| {
        let unit = unit_name(operation_id, unit).map_err(|_| Refusal::Invalid)?;
        let mut arguments = strings(options);
        arguments.push(path.to_string());
        let command = wrapped(
            installation,
            Mode::Probe,
            &unit,
            None,
            STAT,
            &arguments,
            base,
            Stdin::Closed,
        );
        host.run(&command)
            .filter(|out| out.exit_code == Some(0))
            .map(|out| out.stdout)
            .ok_or(Refusal::Failed)
    };
    let inode = probe(n, &["--dereference", "--format=%i"])?;
    let file_system = probe(n + 1, &["--dereference", "--file-system", "--format=%t:%i"])?;
    classify(&installation.guid, &inode, &file_system)
}

/// The identity of the Git file from the probe lines `gitfs` and `gitfile` (contract §11 "Git per distro").
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitIdentity {
    pub file_system_id: String,
    pub inode: String,
    pub size: String,
    pub modified: String,
}

/// A Git file without a stable file-system ID gives `GIT_UNSUPPORTED` with reason `no-fs-uuid`.
pub fn git_identity(file_system: &str, file: &str) -> Result<GitIdentity, (Code, &'static str)> {
    const REFUSED: (Code, &str) = ("GIT_UNSUPPORTED", "no-fs-uuid");
    let (kind, id) = file_system
        .split_once(':')
        .filter(|(kind, id)| is_hex(kind) && is_hex(id))
        .ok_or(REFUSED)?;
    if kind != "ef53" || id.bytes().all(|b| b == b'0') {
        return Err(REFUSED);
    }
    let parts: Vec<&str> = file.split(':').collect();
    let [inode, size, modified] = parts.as_slice() else {
        return Err(REFUSED);
    };
    if ![inode, size, modified].iter().all(|part| is_decimal(part)) {
        return Err(REFUSED);
    }
    Ok(GitIdentity {
        file_system_id: id.to_string(),
        inode: inode.to_string(),
        size: size.to_string(),
        modified: modified.to_string(),
    })
}

// ---- The mutation anchor ----

/// `<count> <I/O sum>`, both decimal (contract §11 "Process ownership").
pub fn parse_anchor_line(line: &str) -> Option<(u32, u64)> {
    let (count, io) = line.split_once(' ')?;
    if !is_decimal(count) || !is_decimal(io) {
        return None;
    }
    Some((count.parse().ok()?, io.parse().ok()?))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The anchor process of one WSL mutation. Its Job holds it, and its stdin stays open until `close`.
pub struct Anchor {
    process: OwnedHandle,
    stdin: Option<File>,
    answers: Receiver<(u32, u64)>,
    /// The last line. After `close`, the anchor prints one line each second, so it is at most 1 second old.
    last: Arc<Mutex<Option<(u32, u64)>>>,
}

impl Anchor {
    pub fn start(command: &Command, job: HANDLE, current_dir: &Path) -> Result<Anchor, SpawnError> {
        let spawned = spawn(&command.spawn_request(current_dir), job)?;
        // SAFETY: `spawn` returned an open process handle that the caller owns.
        let process = unsafe { OwnedHandle::from_raw_handle(spawned.process.0) };
        let (sender, answers) = mpsc::channel();
        let last = Arc::new(Mutex::new(None));
        let shared = Arc::clone(&last);
        let stdout = spawned.stdout;
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Some(answer) = parse_anchor_line(&line) {
                    *lock(&shared) = Some(answer);
                    let _ = sender.send(answer);
                }
            }
        });
        let mut stderr = spawned.stderr;
        std::thread::spawn(move || std::io::copy(&mut stderr, &mut std::io::sink()));
        Ok(Anchor {
            process,
            stdin: spawned.stdin,
            answers,
            last,
        })
    }

    /// Writes one line and waits for its answer.
    pub fn exchange(&mut self) -> Option<(u32, u64)> {
        while self.answers.try_recv().is_ok() {}
        let stdin = self.stdin.as_mut()?;
        stdin.write_all(b"\n").ok()?;
        self.answers.recv_timeout(PROBE_DEADLINE).ok()
    }

    pub fn last(&self) -> Option<(u32, u64)> {
        *lock(&self.last)
    }

    /// `ended` closes the stdin of the anchor.
    pub fn close(&mut self) {
        self.stdin = None;
    }

    pub fn running(&self) -> bool {
        // SAFETY: `process` keeps the handle open for the call.
        unsafe { WaitForSingleObject(HANDLE(self.process.as_raw_handle()), 0) != WAIT_OBJECT_0 }
    }
}

/// The anchor state of one WSL mutation (contract §11 "Process ownership").
#[derive(Default)]
pub struct Mutation {
    anchor: Option<Anchor>,
}

impl Mutation {
    /// Starts the anchor before the first execution process of the mutation.
    pub fn before_execution(
        &mut self,
        start: impl FnOnce() -> Result<Anchor, SpawnError>,
    ) -> Result<(), SpawnError> {
        if self.anchor.is_none() {
            self.anchor = Some(start()?);
        }
        Ok(())
    }

    /// The anchor count after an execution process exits. It becomes `activeDescendants`.
    pub fn after_exit(&mut self) -> u32 {
        let Some(anchor) = self.anchor.as_mut() else {
            return 0;
        };
        anchor
            .exchange()
            .or_else(|| anchor.last())
            .map_or(0, |(count, _)| count)
    }

    /// The lingering count of a WSL Job is the last anchor count.
    pub fn lingering_count(&self) -> u32 {
        self.last().map_or(0, |(count, _)| count)
    }

    pub fn last(&self) -> Option<(u32, u64)> {
        self.anchor.as_ref().and_then(Anchor::last)
    }

    pub fn ended(&mut self) {
        if let Some(anchor) = self.anchor.as_mut() {
            anchor.close();
        }
    }

    pub fn anchor_running(&self) -> bool {
        self.anchor.as_ref().is_some_and(Anchor::running)
    }
}

// ---- The host of the product ----

/// Runs each `wsl.exe` process in one operation Job and reads the registration keys.
pub struct JobHost<'a> {
    pub job: HANDLE,
    pub current_dir: &'a Path,
}

/// Reads at most `RETAINED_BYTES` and discards the rest until end-of-file, so the writer never blocks.
fn retain(mut pipe: File) -> Arc<Mutex<Vec<u8>>> {
    let kept = Arc::new(Mutex::new(Vec::new()));
    let shared = Arc::clone(&kept);
    std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        while let Ok(read) = pipe.read(&mut buffer) {
            if read == 0 {
                break;
            }
            let mut kept = lock(&shared);
            let room = RETAINED_BYTES.saturating_sub(kept.len());
            kept.extend_from_slice(&buffer[..read.min(room)]);
        }
    });
    kept
}

impl Host for JobHost<'_> {
    fn run(&self, command: &Command) -> Option<Output> {
        let spawned = spawn(&command.spawn_request(self.current_dir), self.job).ok()?;
        // SAFETY: `spawn` returned an open process handle that this call owns.
        let process = unsafe { OwnedHandle::from_raw_handle(spawned.process.0) };
        let handle = HANDLE(process.as_raw_handle());
        let started = Instant::now();
        let stdout = retain(spawned.stdout);
        let _stderr = retain(spawned.stderr);
        let wait_ms = u32::try_from(PROBE_DEADLINE.as_millis()).unwrap_or(u32::MAX - 1);
        // SAFETY: `process` keeps the handle open for the call.
        if unsafe { WaitForSingleObject(handle, wait_ms) } != WAIT_OBJECT_0 {
            // The trap of the wrapper ends the scope when `wsl.exe` ends (contract §11 "Process launch").
            // SAFETY: `process` keeps the handle open for the call.
            let _ = unsafe { TerminateProcess(handle, 1) };
            return None;
        }
        let mut code = 0u32;
        // SAFETY: `process` keeps the handle open, and `code` is a live local.
        unsafe { GetExitCodeProcess(handle, &mut code) }.ok()?;
        // The pipe ends when `wsl.exe` ends. The deadline bounds the wait for the last bytes.
        while Arc::strong_count(&stdout) > 1 && started.elapsed() < PROBE_DEADLINE {
            std::thread::sleep(Duration::from_millis(10));
        }
        let stdout = lock(&stdout).clone();
        Some(Output {
            exit_code: Some(code),
            stdout,
        })
    }

    fn keys(&self) -> Vec<Key> {
        read_keys()
    }
}

/// The subkeys of `HKCU\...\Lxss` with a `DistributionName` string and a `Version` number.
fn read_keys() -> Vec<Key> {
    let mut lxss = HKEY::default();
    // SAFETY: `lxss` receives the opened key, and the call below closes it.
    if unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            &HSTRING::from(LXSS),
            Some(0),
            KEY_READ,
            &mut lxss,
        )
    } != ERROR_SUCCESS
    {
        return Vec::new();
    }
    let mut keys = Vec::new();
    for index in 0.. {
        // A key name has at most 255 characters (Microsoft Learn "Registry element size limits").
        let mut name = [0u16; 256];
        let mut length = name.len() as u32;
        // SAFETY: `name` holds `length` units, and `lxss` is open.
        let status = unsafe {
            RegEnumKeyExW(
                lxss,
                index,
                Some(PWSTR(name.as_mut_ptr())),
                &mut length,
                None,
                None,
                None,
                None,
            )
        };
        if status != ERROR_SUCCESS {
            break;
        }
        let Ok(guid) = String::from_utf16(&name[..length as usize]) else {
            continue;
        };
        if let (Some(name), Some(version)) = (string_value(lxss, &guid), version_value(lxss, &guid))
        {
            keys.push(Key {
                guid,
                name,
                version,
            });
        }
    }
    // SAFETY: `lxss` is open and closed once.
    let _ = unsafe { RegCloseKey(lxss) };
    keys
}

fn string_value(lxss: HKEY, guid: &str) -> Option<String> {
    let subkey = HSTRING::from(guid);
    let mut size = 0u32;
    // SAFETY: a size query without a buffer.
    let status = unsafe {
        RegGetValueW(
            lxss,
            &subkey,
            w!("DistributionName"),
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&raw mut size),
        )
    };
    if status != ERROR_SUCCESS || size < 2 {
        return None;
    }
    let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
    // SAFETY: `buffer` holds `size` bytes.
    let status = unsafe {
        RegGetValueW(
            lxss,
            &subkey,
            w!("DistributionName"),
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&raw mut size),
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    // `RRF_RT_REG_SZ` ends the string with a null unit.
    let units = &buffer[..(size as usize / 2).saturating_sub(1)];
    String::from_utf16(units).ok()
}

fn version_value(lxss: HKEY, guid: &str) -> Option<u32> {
    let mut value = 0u32;
    let mut size = size_of::<u32>() as u32;
    // SAFETY: `value` holds `size` bytes.
    let status = unsafe {
        RegGetValueW(
            lxss,
            &HSTRING::from(guid),
            w!("Version"),
            RRF_RT_REG_DWORD,
            None,
            Some((&raw mut value).cast()),
            Some(&raw mut size),
        )
    };
    (status == ERROR_SUCCESS).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::ffi::OsString;
    use std::io::{BufRead, Write};
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use serde_json::{Value, json};
    use windows::Win32::System::Threading::{CREATE_NO_WINDOW, DETACHED_PROCESS};

    use crate::jobs::Job;
    use crate::jobs::tests::{Fixture, test_exe};
    use crate::spawn::{Input, creation_flags};

    const OPERATION: &str = "0f0f0f0f-0000-4000-8000-0000000000aa";
    const GUID: &str = "{c6d24ae9-40f2-40bf-b35d-bf0b6ca4ea00}";
    const OTHER_GUID: &str = "{8f51b15e-5f05-4b6d-8d78-5765530f558a}";
    const WAIT: Duration = Duration::from_secs(10);

    fn installation() -> Installation {
        Installation {
            distro: "Ubuntu-24.04".to_string(),
            guid: GUID.to_string(),
            git: "/usr/local/bin/git".to_string(),
            systemd_run: "/usr/bin/systemd-run".to_string(),
            systemctl: "/usr/bin/systemctl".to_string(),
            setsid: "/usr/bin/setsid".to_string(),
        }
    }

    fn base() -> Vec<(OsString, OsString)> {
        [
            ("Path", r"C:\Windows\system32"),
            ("SystemRoot", r"C:\Windows"),
            ("wslenv", "GIT_TRACE/u:GIT_DIR/up"),
            ("Wsl_Utf8", "0"),
            ("GIT_TRACE", "1"),
        ]
        .iter()
        .map(|(name, value)| (OsString::from(name), OsString::from(value)))
        .collect()
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }

    /// A text of `src/contracts/wsl-process.json`, read here without `texts()`.
    fn json_text(name: &str) -> String {
        let file: Value =
            serde_json::from_str(include_str!("../../src/contracts/wsl-process.json"))
                .expect("JSON");
        file[name]
            .as_array()
            .expect("lines")
            .iter()
            .map(|line| line.as_str().expect("line"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn output(exit_code: u32, stdout: &str) -> Option<Output> {
        Some(Output {
            exit_code: Some(exit_code),
            stdout: stdout.as_bytes().to_vec(),
        })
    }

    /// Answers each `run` with the next scripted output and records the command.
    struct FakeHost {
        outputs: RefCell<VecDeque<Option<Output>>>,
        commands: RefCell<Vec<Command>>,
        keys: Vec<Key>,
    }

    impl FakeHost {
        fn new(outputs: Vec<Option<Output>>, keys: Vec<Key>) -> FakeHost {
            FakeHost {
                outputs: RefCell::new(outputs.into()),
                commands: RefCell::new(Vec::new()),
                keys,
            }
        }
    }

    impl Host for FakeHost {
        fn run(&self, command: &Command) -> Option<Output> {
            self.commands.borrow_mut().push(command.clone());
            self.outputs
                .borrow_mut()
                .pop_front()
                .expect("scripted output")
        }

        fn keys(&self) -> Vec<Key> {
            self.keys.clone()
        }
    }

    fn key(guid: &str, name: &str, version: u32) -> Key {
        Key {
            guid: guid.to_string(),
            name: name.to_string(),
            version,
        }
    }

    fn values<'a>(environment: &'a [(OsString, OsString)], name: &str) -> Vec<&'a OsString> {
        environment
            .iter()
            .filter(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v)
            .collect()
    }

    fn every_kind_of_command() -> Vec<Command> {
        let inst = installation();
        let read = strings(&["--no-lazy-fetch", "status"]);
        vec![
            list_command(false, &base()),
            list_command(true, &base()),
            probe_command("Ubuntu-24.04", &base()),
            git_command(
                &inst,
                Mode::Read,
                "arbareto-x-1.scope",
                None,
                "/r",
                &read,
                &base(),
                Stdin::Closed,
            )
            .expect("read"),
            wrapped(
                &inst,
                Mode::Probe,
                "arbareto-x-2.scope",
                None,
                STAT,
                &strings(&["--dereference", "--format=%i", "/"]),
                &base(),
                Stdin::Closed,
            ),
            anchor_command(&inst, OPERATION, &base()).expect("anchor"),
        ]
    }

    // ---- T205: distro checks ----

    #[test]
    fn the_list_parser_accepts_strict_utf8_only() {
        assert_eq!(
            parse_list(b"Ubuntu-24.04\r\nUbuntu\r\n"),
            Some(strings(&["Ubuntu-24.04", "Ubuntu"]))
        );
        assert_eq!(parse_list(b"Debian\n"), Some(strings(&["Debian"])));
        assert_eq!(
            parse_list("Ubuntu-\u{e9}\r\n".as_bytes()),
            Some(strings(&["Ubuntu-\u{e9}"]))
        );
        assert_eq!(parse_list(b""), Some(Vec::new()));
        // Research R13 P3: without WSL_UTF8=1, wsl.exe printed UTF-16LE.
        let utf16: Vec<u8> = "\u{feff}Ubuntu\r\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert_eq!(parse_list(&utf16), None);
        let no_bom: Vec<u8> = "Ubuntu\r\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert_eq!(parse_list(&no_bom), None, "NUL is no name character");
        assert_eq!(parse_list(b"Ubu\xc3\x28ntu\r\n"), None);
        assert_eq!(parse_list(b"Ubuntu\xff\r\n"), None);
    }

    #[test]
    fn the_registry_lookup_finds_the_guid_and_version_of_the_listed_name() {
        let keys = vec![key(GUID, "Ubuntu-24.04", 2), key(OTHER_GUID, "Legacy", 1)];
        assert_eq!(lookup(&keys, "Ubuntu-24.04"), Ok(&keys[0]));
        assert_eq!(lookup(&keys, "Legacy"), Err(Reason::NotWsl2));
        assert_eq!(lookup(&keys, "ubuntu-24.04"), Err(Reason::DistroMissing));
        assert_eq!(lookup(&keys, "Fedora"), Err(Reason::DistroMissing));
        assert_eq!(Reason::NotWsl2.as_str(), "not-wsl2");
        assert_eq!(Reason::DistroMissing.as_str(), "distro-missing");
        assert_eq!(Reason::WslMissing.as_str(), "wsl-missing");
    }

    #[test]
    fn the_distro_facts_come_from_the_two_list_calls_and_the_registration_keys() {
        let keys = vec![key(GUID, "Ubuntu-24.04", 2), key(OTHER_GUID, "Ubuntu", 2)];
        let host = FakeHost::new(
            vec![
                output(0, "Ubuntu-24.04\r\nUbuntu\r\n"),
                output(0, "Ubuntu-24.04\r\n"),
            ],
            keys.clone(),
        );
        let facts = distros(&host, &base()).expect("facts");
        assert_eq!(facts.listed, strings(&["Ubuntu-24.04", "Ubuntu"]));
        assert_eq!(facts.running, strings(&["Ubuntu-24.04"]));
        assert_eq!(facts.keys, keys);
        let commands = host.commands.borrow();
        assert_eq!(commands[0].arguments, strings(&["--list", "--quiet"]));
        assert_eq!(
            commands[1].arguments,
            strings(&["--list", "--running", "--quiet"])
        );
        assert!(
            commands
                .iter()
                .all(|c| !c.arguments.iter().any(|a| a == "--verbose"))
        );
    }

    #[test]
    fn a_missing_wsl_exe_or_a_failed_list_call_gives_wsl_missing() {
        let keys = vec![key(GUID, "Ubuntu-24.04", 2)];
        let cases = [
            vec![None],
            vec![output(1, "")],
            vec![Some(Output {
                exit_code: None,
                stdout: Vec::new(),
            })],
            vec![output(0, "Ubuntu-24.04\r\n"), None],
            vec![output(0, "Ubuntu-24.04\r\n"), output(4294967295, "")],
            vec![output(0, "Ubu\u{0}ntu\r\n")],
        ];
        for outputs in cases {
            let host = FakeHost::new(outputs, keys.clone());
            assert_eq!(
                distros(&host, &base()).err(),
                Some(Reason::WslMissing),
                "{:?}",
                host.commands.borrow().len()
            );
        }
    }

    // ---- T205: process launch ----

    #[test]
    fn each_wsl_exe_process_gets_utf8_an_empty_wslenv_no_window_and_the_system32_program() {
        let system_root = std::env::var_os("SystemRoot").expect("SystemRoot");
        let expected = Path::new(&system_root).join(r"System32\wsl.exe");
        assert!(
            wsl_program()
                .as_os_str()
                .eq_ignore_ascii_case(expected.as_os_str()),
            "{:?}",
            wsl_program()
        );
        let directory = std::env::temp_dir();
        for command in every_kind_of_command() {
            assert_eq!(command.program, wsl_program());
            let environment = &command.environment;
            assert_eq!(values(environment, "WSL_UTF8"), [&OsString::from("1")]);
            assert_eq!(values(environment, "WSLENV"), [&OsString::new()]);
            assert_eq!(
                values(environment, "SystemRoot"),
                [&OsString::from(r"C:\Windows")]
            );
            assert_eq!(values(environment, "GIT_TRACE"), [&OsString::from("1")]);
            let request = command.spawn_request(&directory);
            assert_eq!(request.program, wsl_program().as_path());
            assert!(request.wsl, "a wsl.exe request");
            let flags = creation_flags(request.wsl);
            assert!(flags.contains(CREATE_NO_WINDOW), "CREATE_NO_WINDOW");
            assert!(!flags.contains(DETACHED_PROCESS), "no DETACHED_PROCESS");
        }
    }

    #[test]
    fn the_array_starts_with_the_distribution_and_the_wrapper_text_equals_the_contract_file() {
        let command = git_command(
            &installation(),
            Mode::Read,
            "arbareto-op-1.scope",
            None,
            "/home/user/r a$b",
            &strings(&["--no-lazy-fetch", "status", "--porcelain=v2"]),
            &base(),
            Stdin::Closed,
        )
        .expect("read");
        let wrapper = json_text("wrapper");
        let expected = [
            "--distribution",
            "Ubuntu-24.04",
            "--cd",
            "/",
            "--exec",
            "/bin/sh",
            "-c",
            wrapper.as_str(),
            "sh",
            "arbareto-op-1.scope",
            "read",
            "",
            "/usr/bin/systemd-run",
            "/usr/bin/systemctl",
            "/usr/bin/setsid",
            "/usr/local/bin/git",
            "--no-lazy-fetch",
            "-C",
            "/home/user/r a$b",
            "status",
            "--porcelain=v2",
        ];
        assert_eq!(command.arguments, strings(&expected));
        assert_eq!(texts().wrapper, wrapper);
        assert_eq!(texts().anchor, json_text("anchor"));
        assert_eq!(texts().probe, json_text("probe"));
    }

    #[test]
    fn every_mode_passes_the_setsid_path_and_only_a_mutation_passes_an_index_file() {
        let inst = installation();
        let arguments = strings(&["--no-lazy-fetch", "status"]);
        for (mode, name) in [
            (Mode::Probe, "probe"),
            (Mode::Read, "read"),
            (Mode::Mutation, "mutation"),
            (Mode::Network, "network"),
        ] {
            let command = git_command(
                &inst,
                mode,
                "arbareto-op-3.scope",
                None,
                "/r",
                &arguments,
                &base(),
                Stdin::Closed,
            )
            .expect("command");
            assert_eq!(command.arguments[10], name);
            assert_eq!(command.arguments[11], "");
            assert_eq!(command.arguments[14], "/usr/bin/setsid");
        }
        let index = "/r/.git/arbareto-candidate-1";
        let mutation = git_command(
            &inst,
            Mode::Mutation,
            "arbareto-op-4.scope",
            Some(index),
            "/r",
            &arguments,
            &base(),
            Stdin::Closed,
        )
        .expect("mutation");
        assert_eq!(mutation.arguments[11], index);
        for mode in [Mode::Probe, Mode::Read, Mode::Network] {
            assert_eq!(
                git_command(
                    &inst,
                    mode,
                    "arbareto-op-5.scope",
                    Some(index),
                    "/r",
                    &arguments,
                    &base(),
                    Stdin::Closed
                )
                .err(),
                Some("INVALID_REQUEST")
            );
        }
    }

    #[test]
    fn the_wrapper_sets_no_prompt_and_runs_setsid_wait_inside_the_scope_in_every_mode() {
        let wrapper = json_text("wrapper");
        let lines: Vec<&str> = wrapper.lines().collect();
        let case = lines
            .iter()
            .position(|l| l.starts_with("case $mode in"))
            .expect("mode case");
        let esac = lines.iter().position(|l| *l == "esac").expect("esac");
        let prompt = lines
            .iter()
            .position(|l| *l == "export GIT_TERMINAL_PROMPT=0")
            .expect("GIT_TERMINAL_PROMPT=0");
        assert!(prompt < case, "outside the mode branches");
        let scope = lines
            .iter()
            .position(|l| l.contains("--user --scope --quiet --collect --unit=\"$unit\""))
            .expect("scope line");
        assert!(scope > esac, "outside the mode branches");
        assert!(lines[scope].contains("-- \"$setsid\" --wait \"$@\""));
        assert!(lines[scope].ends_with('&'), "the background start");
        assert!(lines.contains(&"wait $!"));
        assert!(lines.contains(&"trap 'end; exit 129' HUP"));
        assert!(lines.contains(&"probe) export LC_ALL=C ;;"));
        assert!(lines.contains(&"network) export GIT_PROTOCOL_FROM_USER=0 ;;"));
        assert!(lines.contains(&"case $mode in probe | read) end ;; esac"));
        assert!(
            !json_text("anchor").contains("setsid"),
            "no setsid in the anchor"
        );
        let probe = json_text("probe");
        assert!(
            !probe.contains("findmnt"),
            "the Git probe starts no findmnt"
        );
        assert!(
            !probe.contains("--wait"),
            "the Git probe runs without the wrapper"
        );
    }

    #[test]
    fn for_git_no_lazy_fetch_is_the_first_program_argument_and_c_follows() {
        let inst = installation();
        let command = git_command(
            &inst,
            Mode::Mutation,
            "arbareto-op-1.scope",
            None,
            "/home/user/r",
            &strings(&["--no-lazy-fetch", "commit", "--quiet", "--file=-"]),
            &base(),
            Stdin::Bytes(b"message".to_vec()),
        )
        .expect("mutation");
        let program = command
            .arguments
            .iter()
            .position(|a| a == "/usr/local/bin/git")
            .expect("program");
        assert_eq!(
            command.arguments[program + 1..],
            strings(&[
                "--no-lazy-fetch",
                "-C",
                "/home/user/r",
                "commit",
                "--quiet",
                "--file=-"
            ])
        );
        for arguments in [strings(&["status"]), strings(&[]), strings(&["-C", "/x"])] {
            assert_eq!(
                git_command(
                    &inst,
                    Mode::Read,
                    "arbareto-op-2.scope",
                    None,
                    "/r",
                    &arguments,
                    &base(),
                    Stdin::Closed
                )
                .err(),
                Some("INVALID_REQUEST")
            );
        }
    }

    #[test]
    fn a_request_with_another_distro_or_git_path_is_refused() {
        let inst = installation();
        assert_eq!(pinned(&inst, "Ubuntu-24.04", "/usr/local/bin/git"), Ok(()));
        for (distro, git) in [
            ("Ubuntu", "/usr/local/bin/git"),
            ("ubuntu-24.04", "/usr/local/bin/git"),
            ("Ubuntu-24.04", "/usr/bin/git"),
            ("Ubuntu-24.04", "/usr/local/bin/git/"),
        ] {
            assert_eq!(pinned(&inst, distro, git), Err("INVALID_REQUEST"));
        }
    }

    #[test]
    fn each_wrapper_process_closes_stdin_after_its_input_and_the_anchor_keeps_it_open() {
        let inst = installation();
        let arguments = strings(&["--no-lazy-fetch", "status"]);
        let directory = std::env::temp_dir();
        let with_input = git_command(
            &inst,
            Mode::Read,
            "arbareto-op-1.scope",
            None,
            "/r",
            &arguments,
            &base(),
            Stdin::Bytes(b"input".to_vec()),
        )
        .expect("read");
        assert!(matches!(
            with_input.spawn_request(&directory).input,
            Input::Bytes(b"input")
        ));
        let without = git_command(
            &inst,
            Mode::Read,
            "arbareto-op-2.scope",
            None,
            "/r",
            &arguments,
            &base(),
            Stdin::Closed,
        )
        .expect("read");
        assert!(matches!(
            without.spawn_request(&directory).input,
            Input::Closed
        ));
        let anchor = anchor_command(&inst, OPERATION, &base()).expect("anchor");
        assert!(matches!(
            anchor.spawn_request(&directory).input,
            Input::Stream
        ));
        let probe = probe_command("Ubuntu-24.04", &base());
        assert!(matches!(
            probe.spawn_request(&directory).input,
            Input::Closed
        ));
    }

    #[test]
    fn the_unit_name_counts_the_processes_of_the_operation() {
        assert_eq!(
            unit_name(OPERATION, 1),
            Ok(format!("arbareto-{OPERATION}-1.scope"))
        );
        assert_eq!(
            unit_name(OPERATION, 27),
            Ok(format!("arbareto-{OPERATION}-27.scope"))
        );
    }

    #[test]
    fn the_unit_name_the_anchor_and_the_identity_refuse_an_operation_id_that_is_not_an_identifier()
    {
        let inst = installation();
        for operation in [
            "*",
            "0f0f0f0f-0000-4000-8000-0000000000a*",
            "0F0F0F0F-0000-4000-8000-0000000000AA",
            "--all",
            "",
        ] {
            assert_eq!(
                unit_name(operation, 1),
                Err("INVALID_REQUEST"),
                "{operation:?}"
            );
            assert!(
                matches!(
                    anchor_command(&inst, operation, &base()),
                    Err("INVALID_REQUEST")
                ),
                "{operation:?}"
            );
            let host = FakeHost::new(Vec::new(), Vec::new());
            assert_eq!(
                identity(&host, &inst, operation, 1, "/r", &base()).err(),
                Some(Refusal::Invalid),
                "{operation:?}"
            );
            assert!(host.commands.borrow().is_empty());
        }
    }

    // ---- T205: the anchor ----

    #[test]
    fn the_anchor_runs_without_the_wrapper_and_answers_each_line_with_the_count_and_the_io_sum() {
        let command = anchor_command(&installation(), OPERATION, &base()).expect("anchor");
        let anchor = json_text("anchor");
        assert_eq!(
            command.arguments,
            strings(&[
                "--distribution",
                "Ubuntu-24.04",
                "--cd",
                "/",
                "--exec",
                "/bin/sh",
                "-c",
                anchor.as_str(),
                "sh",
                "/usr/bin/systemctl",
                OPERATION
            ])
        );
        for needle in [
            "arbareto-$2-*.scope",
            "--signal=SIGKILL",
            "HUP",
            "cgroup.procs",
            "/proc/$pid/io",
            "rchar:",
            "wchar:",
            "sleep 1",
        ] {
            assert!(anchor.contains(needle), "{needle}");
        }
        assert_eq!(parse_anchor_line("3 35440"), Some((3, 35440)));
        assert_eq!(parse_anchor_line("0 0"), Some((0, 0)));
        assert_eq!(
            parse_anchor_line("1 18446744073709551615"),
            Some((1, u64::MAX))
        );
        for line in [
            "", "3", "3 ", "a b", "3 4 5", "-1 2", "1 -2", " 1 2", "1  2",
        ] {
            assert_eq!(parse_anchor_line(line), None, "{line:?}");
        }
    }

    /// libtest runs only `anchor_child_entry`. Its arguments follow the final `--`.
    const ANCHOR_CHILD: [&str; 6] = [
        "wsl::tests::anchor_child_entry",
        "--exact",
        "--ignored",
        "--nocapture",
        "--test-threads=1",
        "--",
    ];

    /// A stand-in anchor: each stdin line gets `<lines read> <lines read * 100>`.
    /// At end-of-file, it writes the line count to the file argument, prints `0 0`, and exits.
    #[test]
    #[ignore = "child process entry for re-executed tests"]
    fn anchor_child_entry() {
        let args: Vec<String> = std::env::args().collect();
        let Some(split) = args.iter().position(|a| a == "--") else {
            return;
        };
        let Some(file) = args.get(split + 1) else {
            return;
        };
        let mut out = std::io::stdout();
        // libtest prints the test name without a line end before this output.
        let _ = writeln!(out);
        let mut lines = 0u64;
        for line in std::io::stdin().lock().lines() {
            if line.is_err() {
                break;
            }
            lines += 1;
            let _ = writeln!(out, "{lines} {}", lines * 100);
            let _ = out.flush();
        }
        std::fs::write(file, lines.to_string()).expect("write line count");
        let _ = writeln!(out, "0 0");
        let _ = out.flush();
        std::process::exit(0);
    }

    fn stand_in_anchor(file: &Path) -> Command {
        let mut arguments: Vec<String> = ANCHOR_CHILD.iter().map(|s| s.to_string()).collect();
        arguments.push(file.to_string_lossy().into_owned());
        let mut command = anchor_command(&installation(), OPERATION, &base()).expect("anchor");
        command.program = test_exe();
        command.arguments = arguments;
        command.environment = std::env::vars_os().collect();
        command
    }

    #[test]
    fn a_mutation_of_three_git_processes_keeps_the_anchor_from_before_the_first_process_until_ended()
     {
        let fixture = Fixture::new();
        let lines_file = fixture.path("lines");
        let job = Job::create().expect("Job");
        let directory = std::env::temp_dir();
        let mut mutation = Mutation::default();
        let mut starts = 0;
        assert_eq!(mutation.lingering_count(), 0);
        for n in 1..=3u32 {
            mutation
                .before_execution(|| {
                    starts += 1;
                    Anchor::start(&stand_in_anchor(&lines_file), job.handle(), &directory)
                })
                .expect("anchor");
            assert!(
                mutation.anchor_running(),
                "the anchor runs before process {n}"
            );
            // An injected Git process in the same Job: the test binary in its child sleep mode.
            let git = crate::jobs::tests::start_child(&["sleep", "50"]);
            job.assign(git.handle()).expect("assign");
            let mut git = git;
            let _ = git.child.wait();
            assert!(
                mutation.anchor_running(),
                "the anchor runs after process {n}"
            );
            assert_eq!(mutation.after_exit(), n, "the count after process {n}");
            assert_eq!(mutation.lingering_count(), n);
        }
        assert_eq!(starts, 1, "one anchor for the mutation");
        assert!(!lines_file.exists(), "stdin stays open until ended");
        assert!(mutation.anchor_running());
        mutation.ended();
        let deadline = Instant::now() + WAIT;
        while mutation.anchor_running() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!mutation.anchor_running(), "the anchor ends after ended");
        assert_eq!(
            std::fs::read_to_string(&lines_file).expect("line count"),
            "3"
        );
        let deadline = Instant::now() + WAIT;
        while mutation.lingering_count() != 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(mutation.lingering_count(), 0, "the last anchor count");
    }

    #[test]
    fn a_mutation_without_an_anchor_reports_zero_and_a_failed_start_is_refused() {
        let mut mutation = Mutation::default();
        assert_eq!(mutation.after_exit(), 0);
        let mut missing = stand_in_anchor(Path::new("unused"));
        missing.program = PathBuf::from(r"C:\arbareto-absent\wsl.exe");
        let job = Job::create().expect("Job");
        let directory = std::env::temp_dir();
        assert!(
            mutation
                .before_execution(|| Anchor::start(&missing, job.handle(), &directory))
                .is_err()
        );
        assert!(!mutation.anchor_running());
        mutation.ended();
    }

    // ---- T205: identity requests ----

    #[test]
    fn the_identity_request_runs_the_two_stat_probes_and_returns_no_device_number() {
        let host = FakeHost::new(
            vec![output(0, "123456\n"), output(0, "ef53:fedc9aa3bd65bc57\n")],
            Vec::new(),
        );
        let inst = installation();
        let found =
            identity(&host, &inst, OPERATION, 7, "/home/user/r a$b", &base()).expect("identity");
        assert_eq!(
            found.reply(),
            json!({
                "distroGuid": GUID,
                "fileSystemId": "fedc9aa3bd65bc57",
                "inode": "123456",
                "fileSystemType": "ef53",
            })
        );
        let commands = host.commands.borrow();
        let expected = |unit: u32, stat: &[&str]| {
            wrapped(
                &inst,
                Mode::Probe,
                &unit_name(OPERATION, unit).expect("unit"),
                None,
                "/usr/bin/stat",
                &strings(stat),
                &base(),
                Stdin::Closed,
            )
            .arguments
        };
        assert_eq!(
            commands[0].arguments,
            expected(7, &["--dereference", "--format=%i", "/home/user/r a$b"])
        );
        assert_eq!(
            commands[1].arguments,
            expected(
                8,
                &[
                    "--dereference",
                    "--file-system",
                    "--format=%t:%i",
                    "/home/user/r a$b"
                ]
            )
        );
        assert!(
            commands
                .iter()
                .flat_map(|c| &c.arguments)
                .all(|a| !a.contains("%d") && !a.contains("%D"))
        );
    }

    #[test]
    fn only_type_ef53_with_a_nonzero_id_gives_an_identity() {
        assert!(classify(GUID, b"2\n", b"ef53:fedc9aa3bd65bc57\n").is_ok());
        assert!(classify(GUID, b"2\n", b"ef53:1\n").is_ok());
        assert_eq!(
            classify(GUID, b"2\n", b"1021997:100000000\n").err(),
            Some(Refusal::MixedLocation)
        );
        for file_system in [
            &b"1021994:abc\n"[..],
            b"58465342:fd00\n",
            b"9123683e:1\n",
            b"ef53:0\n",
            b"ef53:0000000000000000\n",
        ] {
            assert_eq!(
                classify(GUID, b"2\n", file_system).err(),
                Some(Refusal::NoFsUuid),
                "{}",
                String::from_utf8_lossy(file_system)
            );
        }
        for (inode, file_system) in [
            (&b""[..], &b"ef53:1\n"[..]),
            (b"x\n", b"ef53:1\n"),
            (b"1 2\n", b"ef53:1\n"),
            (b"2\n", b""),
            (b"2\n", b"ef53\n"),
            (b"2\n", b"ef53:xyz\n"),
            (b"2\n", b"ef53:1\nextra\n"),
        ] {
            assert_eq!(
                classify(GUID, inode, file_system).err(),
                Some(Refusal::Failed)
            );
        }
        assert_eq!(
            Refusal::NoFsUuid.reply(),
            json!({ "code": "UNSUPPORTED_REPOSITORY", "reason": "no-fs-uuid" })
        );
        assert_eq!(
            Refusal::MixedLocation.reply(),
            json!({ "code": "UNSUPPORTED_REPOSITORY", "reason": "mixed-location" })
        );
        assert_eq!(
            Refusal::Failed.reply(),
            json!({ "code": "UNSUPPORTED_REPOSITORY" })
        );
    }

    #[test]
    fn a_failed_stat_probe_refuses_the_identity() {
        let inst = installation();
        for outputs in [
            vec![None],
            vec![output(1, "2\n")],
            vec![output(0, "2\n"), output(1, "ef53:1\n")],
            vec![output(0, "2\n"), None],
        ] {
            let host = FakeHost::new(outputs, Vec::new());
            assert_eq!(
                identity(&host, &inst, OPERATION, 1, "/r", &base()).err(),
                Some(Refusal::Failed)
            );
        }
    }

    #[test]
    fn a_directory_or_an_identity_path_without_a_leading_slash_is_refused_before_any_process() {
        let inst = installation();
        let arguments = strings(&["--no-lazy-fetch", "status"]);
        for directory in ["-x", "r", "", "--version", "\\r", "~/r"] {
            assert_eq!(
                git_command(
                    &inst,
                    Mode::Read,
                    "arbareto-op-1.scope",
                    None,
                    directory,
                    &arguments,
                    &base(),
                    Stdin::Closed
                )
                .err(),
                Some("INVALID_REQUEST"),
                "{directory:?}"
            );
            let host = FakeHost::new(Vec::new(), Vec::new());
            assert_eq!(
                identity(&host, &inst, OPERATION, 1, directory, &base()).err(),
                Some(Refusal::Invalid),
                "{directory:?}"
            );
            assert!(
                host.commands.borrow().is_empty(),
                "no stat for {directory:?}"
            );
        }
        assert_eq!(
            Refusal::Invalid.reply(),
            json!({ "code": "INVALID_REQUEST" })
        );
    }

    // ---- T205: the Git probe ----

    #[test]
    fn the_git_probe_runs_the_contract_text_without_the_wrapper() {
        let probe = json_text("probe");
        assert_eq!(
            probe_command("Ubuntu-24.04", &base()).arguments,
            strings(&[
                "--distribution",
                "Ubuntu-24.04",
                "--cd",
                "/",
                "--exec",
                "/bin/sh",
                "-c",
                probe.as_str(),
                "sh"
            ])
        );
        for needle in [
            "export LC_ALL=C",
            "command -v",
            "readlink -f",
            "head -c 2",
            "--version",
            "/usr/bin/stat",
            "/usr/bin/env",
            "--dereference --file-system --format=%t:%i",
            "--dereference --format=%i:%s:%Y",
            "--user --scope",
        ] {
            assert!(probe.contains(needle), "{needle}");
        }
        assert!(!probe.contains("--no-lazy-fetch"), "contract §7 exception");
    }

    #[test]
    fn a_git_file_without_a_stable_file_system_id_gives_git_unsupported_no_fs_uuid() {
        assert_eq!(
            git_identity("ef53:fedc9aa3bd65bc57", "43750:4066232:1751487822"),
            Ok(GitIdentity {
                file_system_id: "fedc9aa3bd65bc57".to_string(),
                inode: "43750".to_string(),
                size: "4066232".to_string(),
                modified: "1751487822".to_string(),
            })
        );
        for (file_system, file) in [
            ("1021997:100000000", "1:2:3"),
            ("1021994:abc", "1:2:3"),
            ("ef53:0", "1:2:3"),
            ("", "1:2:3"),
            ("ef53:1", ""),
            ("ef53:1", "1:2"),
        ] {
            assert_eq!(
                git_identity(file_system, file),
                Err(("GIT_UNSUPPORTED", "no-fs-uuid")),
                "{file_system} {file}"
            );
        }
    }

    // ---- Reference distro checks. They skip without WSL. ----

    /// A skipped check passes in libtest, so it prints the fixed line `SKIP <capability>` with the `tests/wsl` capability name.
    /// libtest shows that line only with `--nocapture`. The batch check runs
    /// `cargo test --locked --manifest-path src-tauri/Cargo.toml -- wsl::tests::the_real --nocapture --test-threads=1`
    /// and counts the lines that match `^SKIP `.
    fn skip(capability: &str) {
        // libtest can print the test name without a line end before this output.
        println!("\nSKIP {capability}");
    }

    /// The host Job and the distro of the WSL tests (test harness rules: `ARBARETO_WSL_DISTRO` or the default distro).
    struct Reference {
        job: Job,
        directory: PathBuf,
        distro: String,
    }

    impl Reference {
        fn host(&self) -> JobHost<'_> {
            JobHost {
                job: self.job.handle(),
                current_dir: &self.directory,
            }
        }
    }

    fn reference() -> Option<Reference> {
        if !wsl_program().is_file() {
            skip("wsl");
            return None;
        }
        let reference = Reference {
            job: Job::create().expect("Job"),
            directory: std::env::temp_dir(),
            distro: String::new(),
        };
        let distro = match std::env::var("ARBARETO_WSL_DISTRO") {
            Ok(distro) => distro,
            Err(_) => {
                let mut command = list_command(false, &std::env::vars_os().collect::<Vec<_>>());
                command.arguments = strings(&["--exec", "/usr/bin/printenv", "WSL_DISTRO_NAME"]);
                let found = reference
                    .host()
                    .run(&command)
                    .filter(|o| o.exit_code == Some(0));
                match found {
                    Some(o) => String::from_utf8(o.stdout)
                        .expect("UTF-8")
                        .trim()
                        .to_string(),
                    None => {
                        skip("wsl2-distro");
                        return None;
                    }
                }
            }
        };
        Some(Reference {
            distro,
            ..reference
        })
    }

    fn probe_fact<'a>(output: &'a str, prefix: &str) -> Option<&'a str> {
        output.lines().find_map(|line| line.strip_prefix(prefix))
    }

    /// The reference installation from the real Git probe. `None` skips with a capability name.
    fn probed(reference: &Reference) -> Option<Installation> {
        let environment: Vec<(OsString, OsString)> = std::env::vars_os().collect();
        let out = reference
            .host()
            .run(&probe_command(&reference.distro, &environment))
            .expect("probe ran");
        assert_eq!(out.exit_code, Some(0), "probe exit");
        let text = String::from_utf8(out.stdout).expect("UTF-8");
        println!(
            "OBSERVATION T205: probe of {} {:?}",
            reference.distro,
            text.lines()
                .filter(|l| !l.starts_with("pathenv "))
                .collect::<Vec<_>>()
        );
        if probe_fact(&text, "scope ") != Some("0") {
            skip("systemd-user-manager");
            return None;
        }
        let Some(setsid) = probe_fact(&text, "path setsid ") else {
            skip("setsid");
            return None;
        };
        Some(Installation {
            distro: reference.distro.clone(),
            guid: GUID.to_string(),
            git: probe_fact(&text, "path git ")
                .unwrap_or("/usr/bin/git")
                .to_string(),
            systemd_run: probe_fact(&text, "path systemd-run ")
                .expect("systemd-run")
                .to_string(),
            systemctl: probe_fact(&text, "path systemctl ")
                .expect("systemctl")
                .to_string(),
            setsid: setsid.to_string(),
        })
    }

    #[test]
    fn the_real_list_calls_decode_as_utf8_and_each_listed_name_has_a_wsl2_key() {
        let Some(reference) = reference() else {
            return;
        };
        let environment: Vec<(OsString, OsString)> = std::env::vars_os().collect();
        let facts = distros(&reference.host(), &environment).expect("distro facts");
        println!(
            "OBSERVATION T205: listed {:?}, running {:?}",
            facts.listed, facts.running
        );
        assert!(facts.listed.contains(&reference.distro));
        let key = lookup(&facts.keys, &reference.distro).expect("WSL2 key");
        assert!(
            key.guid.starts_with('{') && key.guid.ends_with('}'),
            "{}",
            key.guid
        );
    }

    #[test]
    fn the_real_identity_of_the_distro_root_is_ef53_with_inode_2() {
        let Some(reference) = reference() else {
            return;
        };
        let Some(inst) = probed(&reference) else {
            return;
        };
        let environment: Vec<(OsString, OsString)> = std::env::vars_os().collect();
        let operation = "0f0f0f0f-0000-4000-8000-0000000000bb";
        match identity(&reference.host(), &inst, operation, 1, "/", &environment) {
            Ok(found) => {
                println!("OBSERVATION T205: identity of / {}", found.reply());
                assert_eq!(found.inode, "2");
                assert_eq!(found.file_system_type, "ef53");
            }
            Err(Refusal::NoFsUuid) => skip("wsl-fixture-fs-id"),
            Err(other) => panic!("identity refused: {other:?}"),
        }
    }

    #[test]
    fn the_real_anchor_counts_a_lingering_child_and_the_job_close_ends_its_scope() {
        let Some(reference) = reference() else {
            return;
        };
        let Some(inst) = probed(&reference) else {
            return;
        };
        let environment: Vec<(OsString, OsString)> = std::env::vars_os().collect();
        let operation = format!("0f0f0f0f-0000-4000-8000-{:012x}", std::process::id());
        let job = Job::create().expect("Job");
        let mut mutation = Mutation::default();
        mutation
            .before_execution(|| {
                Anchor::start(
                    &anchor_command(&inst, &operation, &environment).expect("anchor"),
                    job.handle(),
                    &reference.directory,
                )
            })
            .expect("anchor");
        let host = JobHost {
            job: job.handle(),
            current_dir: &reference.directory,
        };
        let child = wrapped(
            &inst,
            Mode::Mutation,
            &unit_name(&operation, 1).expect("unit"),
            None,
            "/bin/sh",
            &strings(&["-c", "sleep 60 & echo started"]),
            &environment,
            Stdin::Closed,
        );
        let out = host.run(&child).expect("mutation process");
        assert_eq!(out.exit_code, Some(0));
        assert_eq!(out.stdout, b"started\n");
        let count = mutation.after_exit();
        println!(
            "OBSERVATION T205: anchor count after the process exit {count}, last {:?}",
            mutation.last()
        );
        assert_eq!(count, 1, "the lingering sleep");
        drop(job);
        // Contract §11 "Process ownership": the Job close ends the scopes within 1 second (P1). The check allows 5 seconds.
        let list = |reference: &Reference| {
            let mut command = list_command(false, &environment);
            command.arguments = strings(&[
                "--distribution",
                reference.distro.as_str(),
                "--cd",
                "/",
                "--exec",
                inst.systemctl.as_str(),
                "--user",
                "list-units",
                "--all",
                "--no-legend",
                "--plain",
                format!("arbareto-{operation}-*").as_str(),
            ]);
            let out = reference.host().run(&command).expect("list-units");
            String::from_utf8(out.stdout).expect("UTF-8")
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut left = list(&reference);
        while !left.trim().is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(200));
            left = list(&reference);
        }
        assert_eq!(left.trim(), "", "no scope of the operation remains");
    }
}
