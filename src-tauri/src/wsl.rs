// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

//! The shell side of contract §11 "WSL repositories": distro checks, `wsl.exe` process requests,
//! the mutation anchor, the bootstrap probe, the identity probe, the `fileFacts` probe, and the `wslFiles` text.
//!
//! The §6 WSL frames (`WslRequest` in `src/contracts/channel.ts`; the double in `tests/git/bun-runner.ts` answers the same shapes):
//! - `wslDistros` with a `repositoryDiscovery` context: the context path, and for a WSL prefix the `distros` facts,
//!   `wsl.exe`, and the saved Git of each listed GUID. The service holds only the bootstrap ID, so it routes that path.
//! - `wslProbe` with that context and a listed `distro`: `probe_command` with the Linux path of the context, deadline at most 60 seconds.
//!   The shell binds the `bind_probe` facts and the context identity once. Output that fails a §11 rule binds nothing.
//! - `register` WSL form: only the context ID, the issued `gitInstallationId`, and `confirm: true`.
//!   The shell issues the ID only from the bound facts. The service never names a Linux program.
//! - `register` repository form in a WSL context: the shell reads the context identity again with `identities` first.
//! - `run`, `identity`, `fileFacts`, and `wslFiles` against a WSL Git: `git_command`, `identities`, `file_facts_command`, and `wsl_files_command`.
//!   A mutation starts its anchor before its first Git process.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::num::NonZeroU64;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;
use windows::Win32::Foundation::{ERROR_SUCCESS, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_READ, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegCloseKey, RegEnumKeyExW,
    RegGetValueW, RegOpenKeyExW,
};
use windows::Win32::System::SystemInformation::GetSystemWindowsDirectoryW;
use windows::Win32::System::Threading::{
    GetExitCodeProcess, TerminateProcess, WaitForMultipleObjects, WaitForSingleObject,
};
use windows::core::{HSTRING, PWSTR, w};

use crate::jobs::Supervisor;
use crate::process_requests::{BOOTSTRAP_DEADLINE_MS, Code, is_identifier};
use crate::schema::process_reply::{
    FileFactErrorCode, FileFactFileBound, FileFactLinkTag, FileFactLinkTarget,
    FileFactsReplyFactsItem as Fact, IdentityRefusedReason, WslExit,
    WslFilesResultsResultsItem as FileResult, WslIndexPart, WslIndexResult,
};
use crate::schema::reply;
use crate::settings::SavedWslGit;
use crate::spawn::{Input, SpawnError, SpawnRequest, Spawned, spawn};

/// Contract §11 "Paths and file access": the identity probes run this fixed path.
pub const STAT: &str = "/usr/bin/stat";
/// gaps.md W3 and W4: the `fileFacts` probe and the identity probe run this fixed path. The bootstrap probe checks it.
pub const PERL: &str = "/usr/bin/perl";
/// Contract §5 "Diagnostic bytes retained": 64 KiB per stream. A list call or a probe prints far less.
pub const RETAINED_BYTES: usize = 64 * 1024;
/// Contract §11 "Distro checks": the list calls use the §5 probe deadline. The identity probes and the anchor answer use it too.
const PROBE_DEADLINE: Duration = Duration::from_millis(BOOTSTRAP_DEADLINE_MS);
const INVALID: Code = Code::InvalidRequest;
/// The registration key of the WSL distros (contract §11 "Distro checks").
const LXSS: &str = r"Software\Microsoft\Windows\CurrentVersion\Lxss";

/// The texts of `src/contracts/wsl-process.json`. The service and the T206 double read the same file.
pub struct Texts {
    pub wrapper: String,
    pub anchor: String,
    pub probe: String,
    /// gaps.md W4: the identity probe, a `/bin/sh` text with `stat`, `perl`, and the paths as arguments.
    pub identity: String,
    /// gaps.md W3: the Perl `fileFacts` probe.
    pub file_facts: String,
    /// Contract §6 "WSL file work": the Perl `wslFiles` text.
    pub wsl_files: String,
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
        // The Perl texts start with the shared `perlHead` lines. `tests/wsl/wsl-host.ts` `perlText` joins them the same way.
        let perl = |name: &str| format!("{}\n{}", text("perlHead"), text(name));
        Texts {
            wrapper: text("wrapper"),
            anchor: text("anchor"),
            probe: text("probe"),
            identity: text("identity"),
            file_facts: perl("fileFacts"),
            wsl_files: perl("wslFiles"),
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

/// The end of one process with its own deadline. `deadline`: the deadline ended it, and `output` is `None`.
pub struct Ended {
    pub output: Option<Output>,
    pub deadline: bool,
}

/// The process and registry calls of this module. Tests inject them.
pub trait Host {
    /// Runs one `wsl.exe` process to its end. `None`: it did not start or did not end within the probe deadline.
    fn run(&self, command: &Command) -> Option<Output>;
    fn keys(&self) -> Vec<Key>;
    /// As `run`, with at most `cap` bytes of stdout and the given deadline. An injected host answers as `run`.
    fn run_until(&self, command: &Command, _cap: usize, _deadline: Duration) -> Ended {
        Ended {
            output: self.run(command),
            deadline: false,
        }
    }
    /// The process of one walk (contract §6 "Walks"): as `run_until`, and the set `stop` Event ends that process at once.
    /// It has no default body, so each host decides how a stop ends its process.
    fn run_walk(&self, command: &Command, cap: usize, deadline: Duration, stop: HANDLE) -> Ended;
    /// Starts one streamed Git process of a `run` (contract §11 "Process launch").
    fn start(&self, _command: &Command) -> Result<Spawned, SpawnError> {
        Err(SpawnError::OwnershipFailed)
    }
    /// Starts the anchor of a mutation before its first Git process (contract §11 "Process ownership").
    fn anchor(&self, _command: &Command) -> Result<(), SpawnError> {
        Err(SpawnError::OwnershipFailed)
    }
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
    /// The approved `/usr/bin/sha256sum` target (contract §11 "Git per distro").
    pub sha256sum: String,
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

/// Contract §11 "Route": the Linux path of a UNC path in `distro`. Both prefixes, both separators, and the
/// letter case of the prefix and of the distro name do not matter. `wslpath -u` drops empty and `.` segments and resolves `..`.
/// `None`: no WSL path of that distro, or a segment with a character in U+F000 to U+F0FF (reason `wsl-path`).
pub fn linux_path(path: &Path, distro: &str) -> Option<String> {
    let text = path.to_str()?;
    let separator = |c: char| c == '\\' || c == '/';
    let mut chars = text.chars();
    if !(chars.next().is_some_and(separator) && chars.next().is_some_and(separator)) {
        return None;
    }
    let mut parts = chars.as_str().split(separator);
    let server = parts.next()?;
    let named = parts.next()?;
    if !(server.eq_ignore_ascii_case("wsl$") || server.eq_ignore_ascii_case("wsl.localhost"))
        || !named.eq_ignore_ascii_case(distro)
    {
        return None;
    }
    let mut segments: Vec<&str> = Vec::new();
    for segment in parts {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            _ if segment
                .chars()
                .any(|c| ('\u{f000}'..='\u{f0ff}').contains(&c)) =>
            {
                return None;
            }
            _ => segments.push(segment),
        }
    }
    Some(format!("/{}", segments.join("/")))
}

/// The bootstrap Git probe. It runs without the wrapper (contract §11 "Git per distro").
/// gaps.md W1: the one argument is the Linux path of the context, which the shell computes by the §11 "Route" rule.
pub fn probe_command(distro: &str, linux_path: &str, base: &[(OsString, OsString)]) -> Command {
    shell_command(distro, &texts().probe, &[linux_path], base, Stdin::Closed)
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

// ---- Identity ----

/// A WSL identity: the distro GUID, the `statfs` ID, and the inode. It holds no device number (contract §11).
/// A WSL identity in the canonical form of gaps.md W2: the lowercase braced GUID, the GNU `stat -f %i` hex, and the decimal inode.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct WslIdentity {
    pub guid: String,
    pub file_system_id: String,
    pub inode: String,
}

impl WslIdentity {
    /// The identity reply `{"distroGuid","fileSystemId","inode"}` (gaps.md W2).
    #[cfg(test)]
    pub fn reply(&self) -> Value {
        crate::bootstrap::PhysicalIdentity::Wsl(self.clone()).reply()
    }

    /// The identity text `<distroGuid>:<fileSystemId>:<inode>`.
    pub fn text(&self) -> String {
        format!("{}:{}:{}", self.guid, self.file_system_id, self.inode)
    }

    /// The reply form. Any other text is no identity.
    pub fn parse(value: &Value) -> Option<WslIdentity> {
        let object = value.as_object().filter(|object| object.len() == 3)?;
        let field = |key: &str| object.get(key).and_then(Value::as_str);
        let (guid, id, inode) = (
            field("distroGuid")?,
            field("fileSystemId")?,
            field("inode")?,
        );
        (is_guid(guid) && is_file_system_id(id) && is_inode(inode)).then(|| WslIdentity {
            guid: guid.to_string(),
            file_system_id: id.to_string(),
            inode: inode.to_string(),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Every type except `ef53` and `v9fs`, or an ID of 0.
    NoFsUuid,
    /// Type `v9fs`, magic `1021997`: a Windows drive.
    MixedLocation,
    /// Perl `stat` set `ENOENT` or `ENOTDIR` (gaps.md W4).
    Absent,
    /// A failed or malformed probe, as a failed `FileIdInfo` call (contract §6).
    Failed,
    /// An operation ID or a path that the request rules refuse.
    Invalid,
}

impl Refusal {
    /// The `reason` of the identity entry. A failed probe and a refused path carry none, as a failed `FileIdInfo` call.
    pub fn reason(self) -> Option<IdentityRefusedReason> {
        match self {
            Refusal::NoFsUuid => Some(IdentityRefusedReason::NoFsUuid),
            Refusal::MixedLocation => Some(IdentityRefusedReason::MixedLocation),
            Refusal::Absent => Some(IdentityRefusedReason::Absent),
            Refusal::Failed | Refusal::Invalid => None,
        }
    }
}

fn is_hex(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_decimal(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// The `Lxss` subkey form with `A` to `F` folded to lowercase: braces around 8-4-4-4-12 hex digits (gaps.md W2).
pub fn is_guid(text: &str) -> bool {
    let Some(inner) = text.strip_prefix('{').and_then(|t| t.strip_suffix('}')) else {
        return false;
    };
    let groups: Vec<&str> = inner.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(group, length)| group.len() == length && is_hex(group))
}

/// GNU `stat -f %i` prints `f_fsid` with `%jx`, so the canonical text has 1 to 16 digits and no leading zero.
fn is_file_system_id(text: &str) -> bool {
    is_hex(text) && text.len() <= 16 && !text.starts_with('0')
}

/// A 64-bit inode number in decimal without a leading zero.
fn is_inode(text: &str) -> bool {
    is_decimal(text) && !text.starts_with('0') && text.parse::<u64>().is_ok()
}

/// One `stat %i` and `stat -f %t:%i` pair. Only type `ef53` derives its ID from the UUID (research R13 P7).
/// Other text than the canonical form is a failed probe (gaps.md W2).
pub fn classify(guid: &str, inode: &str, file_system: &str) -> Result<WslIdentity, Refusal> {
    let (kind, id) = file_system
        .split_once(':')
        .filter(|(kind, id)| is_hex(kind) && is_hex(id))
        .ok_or(Refusal::Failed)?;
    match kind {
        "1021997" => return Err(Refusal::MixedLocation),
        "ef53" if id.bytes().any(|b| b != b'0') => {}
        _ => return Err(Refusal::NoFsUuid),
    }
    if !is_guid(guid) || !is_file_system_id(id) || !is_inode(inode) {
        return Err(Refusal::Failed);
    }
    Ok(WslIdentity {
        guid: guid.to_string(),
        file_system_id: id.to_string(),
        inode: inode.to_string(),
    })
}

/// One output line of the identity probe: `id <inode> <type>:<ID>`, or the Perl `stat` result `absent` or `fail`.
fn identity_line(guid: &str, line: &str) -> Result<WslIdentity, Refusal> {
    if line == "absent" {
        return Err(Refusal::Absent);
    }
    let mut parts = line.split(' ');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some("id"), Some(inode), Some(file_system), None) => classify(guid, inode, file_system),
        _ => Err(Refusal::Failed),
    }
}

/// gaps.md W4: one identity probe for every path of a request, through the wrapper in `probe` mode, in the unit `n`.
/// A path without a leading slash gets `Invalid` and no process sees it. A failed probe gives `Failed` for each other path.
/// `walk`: the stop Event and the deadline of a walk (contract §6 "Walks"). Without it, the probe deadline applies.
pub fn identities(
    host: &dyn Host,
    installation: &Installation,
    operation_id: &str,
    n: u32,
    paths: &[String],
    base: &[(OsString, OsString)],
    walk: Option<(HANDLE, Duration)>,
) -> Vec<Result<WslIdentity, Refusal>> {
    // A path that starts with `-` would become an option.
    let probed: Vec<&String> = paths.iter().filter(|path| path.starts_with('/')).collect();
    let mut lines: Vec<Result<WslIdentity, Refusal>> = Vec::new();
    if !probed.is_empty() {
        let Ok(unit) = unit_name(operation_id, n) else {
            return paths.iter().map(|_| Err(Refusal::Invalid)).collect();
        };
        let mut arguments = strings(&["-c", &texts().identity, "sh", STAT, PERL]);
        arguments.extend(probed.iter().map(|path| (*path).clone()));
        let command = wrapped(
            installation,
            Mode::Probe,
            &unit,
            None,
            "/bin/sh",
            &arguments,
            base,
            Stdin::Closed,
        );
        let output = match walk {
            Some((stop, deadline)) => {
                host.run_walk(&command, RETAINED_BYTES, deadline, stop)
                    .output
            }
            None => host.run(&command),
        };
        let text = output
            .filter(|out| out.exit_code == Some(0))
            .and_then(|out| String::from_utf8(out.stdout).ok());
        let found: Vec<&str> = text
            .as_deref()
            .and_then(|text| text.strip_suffix('\n'))
            .map(|text| text.split('\n').collect())
            .unwrap_or_default();
        lines = if found.len() == probed.len() {
            found
                .iter()
                .map(|line| identity_line(&installation.guid, line))
                .collect()
        } else {
            probed.iter().map(|_| Err(Refusal::Failed)).collect()
        };
    }
    let mut lines = lines.into_iter();
    paths
        .iter()
        .map(|path| {
            if path.starts_with('/') {
                lines.next().unwrap_or(Err(Refusal::Failed))
            } else {
                Err(Refusal::Invalid)
            }
        })
        .collect()
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
pub fn git_identity(
    file_system: &str,
    file: &str,
) -> Result<GitIdentity, (&'static str, &'static str)> {
    const REFUSED: (&str, &str) = ("GIT_UNSUPPORTED", "no-fs-uuid");
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

/// The facts that the shell binds from one probe that passes every §11 rule (contract §11 "Git per distro").
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bound {
    pub installation: Installation,
    /// The version token of `git version <token>`.
    pub version: String,
    pub git_identity: GitIdentity,
    /// The identity of the context path (gaps.md W1).
    pub identity: WslIdentity,
}

/// The programs that the probe of `src/contracts/wsl-process.json` resolves.
const PROBED: [&str; 8] = [
    "git",
    "systemd-run",
    "systemctl",
    "setsid",
    "stat",
    "env",
    "perl",
    "sha256sum",
];
/// The other line kinds of that probe.
const PROBE_FACTS: [&str; 9] = [
    "pathenv", "osid", "version", "gitfs", "gitfile", "scope", "selfs", "selino", "selstat",
];
/// Contract §11 "Git per distro": the Git floor.
const MINIMUM_GIT: [u64; 3] = [2, 55, 0];

/// `<major>.<minor>.<patch>` and a suffix without white space, at least the floor, and no `.windows.` text.
fn admitted_version(text: &str) -> Option<&str> {
    let token = text.strip_prefix("git version ")?;
    if token.is_empty() || token.contains(char::is_whitespace) || token.contains(".windows.") {
        return None;
    }
    let mut parts = token.splitn(3, '.');
    let mut numbers = [0u64; 3];
    for (index, number) in numbers.iter_mut().enumerate() {
        let part = parts.next()?;
        // The patch part can carry a suffix, such as `0.rc1`.
        let digits = if index == 2 {
            &part[..part
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(part.len())]
        } else {
            part
        };
        if !is_decimal(digits) {
            return None;
        }
        *number = digits.parse().ok()?;
    }
    (numbers >= MINIMUM_GIT).then_some(token)
}

/// Parses the probe output and applies the §11 rules. Output that fails a rule binds nothing.
/// Each line kind appears at most once, so a line end inside a value cannot replace a fact.
pub fn bind_probe(distro: &str, guid: &str, output: &[u8]) -> Option<Bound> {
    let text = std::str::from_utf8(output).ok()?;
    let mut facts: HashMap<String, &str> = HashMap::new();
    for line in text.strip_suffix('\n')?.split('\n') {
        let (kind, rest) = line.split_once(' ')?;
        let (key, value) = match kind {
            "path" | "magic" => {
                let (name, value) = rest.split_once(' ')?;
                (
                    PROBED.contains(&name).then(|| format!("{kind} {name}"))?,
                    value,
                )
            }
            "absent" => (
                PROBED.contains(&rest).then(|| format!("absent {rest}"))?,
                "",
            ),
            _ => (PROBE_FACTS.contains(&kind).then(|| kind.to_string())?, rest),
        };
        if facts.insert(key, value).is_some() {
            return None;
        }
    }
    // The probe prints `absent` only for a program without `path` and `magic` lines.
    let both = |name: &&str| {
        ["path", "magic"]
            .iter()
            .any(|kind| facts.contains_key(&format!("{kind} {name}")))
    };
    if PROBED
        .iter()
        .any(|name| facts.contains_key(&format!("absent {name}")) && both(name))
    {
        return None;
    }
    // Contract §11: a resolved path under `/mnt/` or a file that starts with `MZ` is a Windows program.
    let program = |name: &str| -> Option<String> {
        let path = *facts.get(&format!("path {name}"))?;
        let native = path.starts_with('/') && !path.starts_with("/mnt/");
        (native && facts.get(&format!("magic {name}")) == Some(&"-")).then(|| path.to_string())
    };
    let [
        git,
        systemd_run,
        systemctl,
        setsid,
        stat,
        env,
        perl,
        sha256sum,
    ] = PROBED.map(program);
    if stat.is_none()
        || env.is_none()
        || perl.is_none()
        || sha256sum.is_none()
        || facts.get("scope") != Some(&"0")
    {
        return None;
    }
    let version = admitted_version(facts.get("version")?)?.to_string();
    let git_identity = git_identity(facts.get("gitfs")?, facts.get("gitfile")?).ok()?;
    // gaps.md W1: the context identity binds with the Git facts, or nothing binds.
    if facts.get("selstat") != Some(&"ok") {
        return None;
    }
    let identity = classify(guid, facts.get("selino")?, facts.get("selfs")?).ok()?;
    Some(Bound {
        installation: Installation {
            distro: distro.to_string(),
            guid: guid.to_string(),
            git: git?,
            systemd_run: systemd_run?,
            systemctl: systemctl?,
            setsid: setsid?,
            sha256sum: sha256sum?,
        },
        version,
        git_identity,
        identity,
    })
}

// ---- WSL `fileFacts` (gaps.md W3) ----

/// Contract §5 "File facts": 1 MiB per file and 8 MiB per request.
const FACT_FILE_BYTES: usize = 1_048_576;
const FACT_TOTAL_BYTES: usize = 8_388_608;
/// A Linux link text has at most `PATH_MAX` − 1 bytes.
const LINK_TARGET_BYTES: usize = 4_095;
/// The stdout cap of one request: the data bytes, and 64 entries of a link text and their record tokens.
pub const FACTS_OUTPUT_BYTES: usize = FACT_TOTAL_BYTES + 64 * (LINK_TARGET_BYTES + 64);
/// The `error` codes of contract §6 "File facts".
const FACT_ERRORS: [&str; 3] = ["access-denied", "io-error", "other-error"];

/// One request entry: the root index (0 worktree root, 1 Git directory, 2 common directory) and the components.
pub struct FactEntry {
    pub root: usize,
    pub path: Vec<String>,
}

/// The Perl probe through the wrapper in `probe` mode. The arguments are `digest` and the three Linux roots.
/// With `index`, they also hold the approved `sha256sum` and the shared index hash (contract §6 "Index digest in a read").
/// Stdin holds each entry as its root index, its component count, and its components, each ended by NUL.
pub fn file_facts_command(
    installation: &Installation,
    unit: &str,
    digest: bool,
    roots: &[String; 3],
    entries: &[FactEntry],
    index: Option<Option<&str>>,
    base: &[(OsString, OsString)],
) -> Command {
    let mut input = Vec::new();
    for entry in entries {
        let head = [entry.root.to_string(), entry.path.len().to_string()];
        for token in head.iter().chain(&entry.path) {
            input.extend_from_slice(token.as_bytes());
            input.push(0);
        }
    }
    let mut arguments = strings(&[
        "-e",
        &texts().file_facts,
        "--",
        if digest { "1" } else { "0" },
    ]);
    arguments.extend(roots.iter().cloned());
    if let Some(shared) = index {
        arguments.push(installation.sha256sum.clone());
        arguments.extend(shared.map(str::to_string));
    }
    wrapped(
        installation,
        Mode::Probe,
        unit,
        None,
        PERL,
        &arguments,
        base,
        Stdin::Bytes(input),
    )
}

/// The record grammar: NUL-ended ASCII tokens, and `N` raw bytes after a length token.
struct Records<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Records<'a> {
    fn token(&mut self) -> Option<&'a str> {
        let end = self.at + self.bytes[self.at..].iter().position(|&b| b == 0)?;
        let token = std::str::from_utf8(&self.bytes[self.at..end]).ok()?;
        self.at = end + 1;
        (!token.is_empty() && token.bytes().all(|b| b.is_ascii_graphic())).then_some(token)
    }

    fn number<T: std::str::FromStr>(&mut self) -> Option<T> {
        let text = self.token()?;
        let digits = text.strip_prefix('-').unwrap_or(text);
        (is_decimal(digits) && (digits == "0" || !digits.starts_with('0')) && text != "-0")
            .then(|| text.parse().ok())
            .flatten()
    }

    fn flag(&mut self) -> Option<bool> {
        match self.token()? {
            "1" => Some(true),
            "0" => Some(false),
            _ => None,
        }
    }

    fn raw(&mut self, length: usize) -> Option<&'a [u8]> {
        let end = self
            .at
            .checked_add(length)
            .filter(|&end| end <= self.bytes.len())?;
        let raw = &self.bytes[self.at..end];
        self.at = end;
        Some(raw)
    }
}

/// One fact of contract §6 "File facts" from one record. `total` counts the digested bytes of the request.
fn fact(records: &mut Records, components: usize, digest: bool, total: &mut usize) -> Option<Fact> {
    Some(match records.token()? {
        "absent" => Fact::Absent,
        "other" => Fact::Other,
        "directory" => Fact::Directory {
            executable: Some(records.flag()?),
        },
        "link" => {
            let component: usize = records.number()?;
            let length: usize = records.number()?;
            if !(1..=components).contains(&component) || !(1..=LINK_TARGET_BYTES).contains(&length)
            {
                return None;
            }
            match std::str::from_utf8(records.raw(length)?) {
                // A target outside the `Text` rule is malformed output.
                Ok(target) => {
                    let relative = !target.starts_with('/');
                    let target = FileFactLinkTarget::try_from(target).ok()?;
                    reply::link_fact(
                        component,
                        Some((FileFactLinkTag::Symlink, target, relative)),
                    )
                }
                Err(_) => reply::link_fact(component, None),
            }
        }
        "file" => {
            let size: u64 = records.number().filter(|&size| size < (1 << 53))?;
            // Perl `lstat` gives `st_mtime` in seconds only.
            let modified: i64 = records.number()?;
            let last_write = modified.checked_mul(1_000_000_000)?;
            let (owner, executable) = (records.flag()?, records.flag()?);
            let (bound, digested) = match (records.token()?, digest) {
                ("none", false) => (None, None),
                ("file-bytes", true) => (Some(FileFactFileBound::FileBytes), None),
                ("total-bytes", true) => (Some(FileFactFileBound::TotalBytes), None),
                ("data", true) => {
                    let length: usize = records.number().filter(|&n| n <= FACT_FILE_BYTES)?;
                    *total = total
                        .checked_add(length)
                        .filter(|&n| n <= FACT_TOTAL_BYTES)?;
                    let sha256 = crate::settings::sha256(records.raw(length)?);
                    (None, Some(reply::digest(&crate::settings::hex(&sha256))))
                }
                _ => return None,
            };
            Fact::File {
                bound,
                digest: digested,
                executable: Some(executable),
                last_write: reply::last_write(last_write),
                owner_execute: Some(owner),
                size: i64::try_from(size).ok()?,
            }
        }
        "error" => {
            let component: usize = records.number().filter(|&c| c <= components)?;
            let code = records.token().filter(|code| FACT_ERRORS.contains(code))?;
            let code = code.parse::<FileFactErrorCode>().ok()?;
            reply::error_fact(component, code)
        }
        _ => return None,
    })
}

/// Maps the probe output to one fact per entry, and with `index` (`Some(shared)`) to the index result after them.
/// A failed check, an exit status other than 0, or output past the cap gives each entry and the index `error` with component 0
/// and code `other-error` (gaps.md W3). The shell never parses stderr.
pub fn file_facts_reply(
    output: Option<Output>,
    entries: &[FactEntry],
    digest: bool,
    index: Option<bool>,
) -> (Vec<Fact>, Option<WslIndexResult>) {
    let parsed = output
        .filter(|out| out.exit_code == Some(0) && out.stdout.len() <= FACTS_OUTPUT_BYTES)
        .and_then(|out| {
            let mut records = Records {
                bytes: &out.stdout,
                at: 0,
            };
            let mut total = 0;
            let facts: Vec<Fact> = entries
                .iter()
                .map(|entry| fact(&mut records, entry.path.len(), digest, &mut total))
                .collect::<Option<_>>()?;
            let found = match index {
                Some(shared) => {
                    let kind = records.token()?;
                    Some(index_record(&mut records, kind, shared)?)
                }
                None => None,
            };
            (records.at == out.stdout.len()).then_some((facts, found))
        });
    parsed.unwrap_or_else(|| {
        let facts = entries
            .iter()
            .map(|_| reply::error_fact(0, FileFactErrorCode::OtherError))
            .collect();
        (facts, index.map(|_| reply::index_failed(0, "other-error")))
    })
}

// ---- WSL `wslFiles` (contract §6 "WSL file work") ----

/// The §5 bound of a `wslFiles` request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileBound {
    Compared,
    Whole,
    Index,
}

impl FileBound {
    pub fn name(self) -> &'static str {
        match self {
            FileBound::Compared => "COMPARED_RAW_VERSION_BYTES",
            FileBound::Whole => "WHOLE_FILE_STAGE_INPUT_BYTES",
            FileBound::Index => "MUTATION_RAW_INDEX_BYTES",
        }
    }

    /// Contract §5: the byte value of the bound.
    fn bytes(self) -> u64 {
        match self {
            FileBound::Compared => 1_048_576,
            FileBound::Whole => 536_870_912,
            FileBound::Index => 67_108_864,
        }
    }
}

/// The stdout cap of one `wslFiles` request: 64 link texts and their record tokens.
pub const WSL_FILES_OUTPUT_BYTES: usize = 64 * (LINK_TARGET_BYTES + 256);

/// One checked `wslFiles` request. `entries` hold the walked entries, and `fields` the mode fields after them, in stdin order.
pub struct FilesRequest {
    pub mode: &'static str,
    pub bound: FileBound,
    pub entries: Vec<FactEntry>,
    pub fields: Vec<String>,
    /// `indexDigest` with `sharedIndex`: the result holds a shared part.
    pub shared: bool,
}

/// The Perl text through the wrapper in `probe` mode. The arguments are the mode, the three Linux roots, the approved Git, and the approved `sha256sum`.
/// Stdin holds the bound in bytes, the entries, and the mode fields, each ended by NUL.
pub fn wsl_files_command(
    installation: &Installation,
    unit: &str,
    roots: &[String; 3],
    request: &FilesRequest,
    base: &[(OsString, OsString)],
) -> Command {
    let mut tokens = vec![request.bound.bytes().to_string()];
    for entry in &request.entries {
        tokens.push(entry.root.to_string());
        tokens.push(entry.path.len().to_string());
        tokens.extend(entry.path.iter().cloned());
    }
    tokens.extend(request.fields.iter().cloned());
    let mut input = Vec::new();
    for token in &tokens {
        input.extend_from_slice(token.as_bytes());
        input.push(0);
    }
    let mut arguments = strings(&["-e", &texts().wsl_files, "--", request.mode]);
    arguments.extend(roots.iter().cloned());
    arguments.push(installation.git.clone());
    arguments.push(installation.sha256sum.clone());
    wrapped(
        installation,
        Mode::Probe,
        unit,
        None,
        PERL,
        &arguments,
        base,
        Stdin::Bytes(input),
    )
}

fn hex64(records: &mut Records) -> Option<String> {
    let text = records.token()?;
    (text.len() == 64 && is_hex(text)).then(|| text.to_string())
}

fn safe_size(records: &mut Records) -> Option<i64> {
    records
        .number::<i64>()
        .filter(|&n| (0..(1 << 53)).contains(&n))
}

fn code_token(records: &mut Records) -> Option<&'static str> {
    let code = records.token()?;
    FACT_ERRORS.iter().copied().find(|&known| known == code)
}

fn error_result(records: &mut Records, components: usize) -> Option<FileResult> {
    let component: usize = records.number().filter(|&c| c <= components)?;
    let code = code_token(records)?;
    Some(reply::wsl_error(component, code))
}

/// `exit <n>` or `signal <n>`: `$?` after `close` (perlvar).
fn exit_form(records: &mut Records) -> Option<WslExit> {
    let form = records.token()?;
    let n: u64 = records.number()?;
    match form {
        "exit" => Some(WslExit::ExitCode(u8::try_from(n).ok()?)),
        "signal" if (1..=127).contains(&n) => Some(WslExit::Signal(NonZeroU64::new(n)?)),
        _ => None,
    }
}

fn index_part(records: &mut Records) -> Option<WslIndexPart> {
    Some(match records.token()? {
        "absent" => WslIndexPart::Absent,
        "bound" => WslIndexPart::Bound,
        "digest" => {
            let size = safe_size(records)?;
            reply::index_digest(size, &hex64(records)?)
        }
        "error" => reply::index_error(code_token(records)?),
        _ => return None,
    })
}

/// The `index` record of `indexDigest` and of a `fileFacts` request with `index`. `kind` is its first token.
fn index_record(records: &mut Records, kind: &str, shared: bool) -> Option<WslIndexResult> {
    match kind {
        "error" => {
            let component: usize = records.number().filter(|&c| c == 0)?;
            Some(reply::index_failed(component, code_token(records)?))
        }
        "index" => {
            let index = index_part(records)?;
            let shared = if shared {
                Some(index_part(records)?)
            } else {
                None
            };
            Some(WslIndexResult::Index {
                index,
                shared_index: shared,
            })
        }
        _ => None,
    }
}

/// One result of a walked entry: a fact kind, or a file with its digest or the bound name.
fn entry_result(
    records: &mut Records,
    kind: &str,
    components: usize,
    bound: &str,
) -> Option<FileResult> {
    Some(match kind {
        "absent" => FileResult::Absent,
        "other" => FileResult::Other,
        "directory" => FileResult::Directory,
        "error" => return error_result(records, components),
        "link" => {
            let component: usize = records.number()?;
            let length: usize = records.number()?;
            if !(1..=components).contains(&component) || !(1..=LINK_TARGET_BYTES).contains(&length)
            {
                return None;
            }
            let target = records.raw(length)?;
            reply::wsl_link(component, (component == components).then_some(target))
        }
        "file" => {
            let size = safe_size(records)?;
            let changed = records.flag()?;
            match records.token()? {
                "bound" => reply::wsl_file(size, changed, Err(bound)),
                "sha256" => reply::wsl_file(size, changed, Ok(&hex64(records)?)),
                _ => return None,
            }
        }
        _ => return None,
    })
}

/// One record of a mode (contract §6 "WSL file work"). `None`: the record breaks its form.
fn files_result(records: &mut Records, request: &FilesRequest, at: usize) -> Option<FileResult> {
    let kind = records.token()?;
    let components = request.entries.get(at).map_or(0, |entry| entry.path.len());
    match (request.mode, kind) {
        ("digest", _) => entry_result(records, kind, components, request.bound.name()),
        ("hashObject", "object") => {
            let size = safe_size(records)?;
            let sha256 = hex64(records)?;
            let oid = records.token()?;
            let oid = match oid {
                "none" => None,
                _ if (oid.len() == 40 || oid.len() == 64) && is_hex(oid) => Some(oid),
                _ => return None,
            };
            let (git, hash) = (exit_form(records)?, exit_form(records)?);
            Some(reply::wsl_object(size, &sha256, oid, git, hash))
        }
        // A file result of `hashObject` holds only the bound.
        ("hashObject", _) => entry_result(records, kind, components, request.bound.name())
            .filter(|result| !matches!(result, FileResult::File { bound: None, .. })),
        ("catFile", "blob") => {
            let size = safe_size(records)?;
            let sha256 = hex64(records)?;
            let over = records.flag()?;
            let (git, hash) = (exit_form(records)?, exit_form(records)?);
            Some(reply::wsl_blob(size, &sha256, over, git, hash))
        }
        ("indexDigest", _) => match index_record(records, kind, request.shared)? {
            WslIndexResult::Index {
                index,
                shared_index,
            } => Some(FileResult::Index {
                index,
                shared_index,
            }),
            WslIndexResult::Error { code, component } => Some(reply::wsl_error(
                usize::try_from(component).ok()?,
                &code.to_string(),
            )),
        },
        ("lock", "lock") => {
            let device: u64 = records.number()?;
            let inode: u64 = records.number()?;
            Some(reply::wsl_lock(device, inode))
        }
        ("lock", "locked") => Some(FileResult::Locked),
        ("candidate", "candidate") => {
            let mut copy = || -> Option<(i64, String, i64)> {
                Some((safe_size(records)?, hex64(records)?, records.number()?))
            };
            let (index, candidate) = (copy()?, copy()?);
            Some(reply::wsl_candidate(index, candidate))
        }
        ("candidate", "absent") => Some(FileResult::Absent),
        ("candidate", "bound") => Some(FileResult::Bound),
        ("publish", "published") => {
            let size = safe_size(records)?;
            Some(reply::wsl_published(size, &hex64(records)?))
        }
        ("publish", "mismatch") => Some(FileResult::Mismatch),
        ("publish" | "remove", "notOwned") => Some(FileResult::NotOwned),
        ("remove", "removed") => Some(FileResult::Removed),
        (_, "error") => error_result(records, 0),
        _ => None,
    }
}

/// One result per `digest` entry, or one result for another mode. A failed check, an exit status other than 0, or output past the cap
/// gives each result `error` with component 0 and code `other-error` (contract §6 "WSL file work"). The shell never parses stderr.
pub fn wsl_files_reply(output: Option<Output>, request: &FilesRequest) -> Vec<FileResult> {
    let count = if request.mode == "digest" {
        request.entries.len()
    } else {
        1
    };
    let parsed = output
        .filter(|out| out.exit_code == Some(0) && out.stdout.len() <= WSL_FILES_OUTPUT_BYTES)
        .and_then(|out| {
            let mut records = Records {
                bytes: &out.stdout,
                at: 0,
            };
            let results: Option<Vec<FileResult>> = (0..count)
                .map(|at| files_result(&mut records, request, at))
                .collect();
            results.filter(|_| records.at == out.stdout.len())
        });
    parsed.unwrap_or_else(|| {
        (0..count)
            .map(|_| reply::wsl_error(0, "other-error"))
            .collect()
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

/// An anchor line holds two decimal numbers: at most 31 bytes. A longer line is malformed, and the reader keeps no more.
const ANCHOR_LINE_BYTES: usize = 64;

/// The answer state of an anchor. It keeps only the last line, so a lingering anchor uses fixed memory.
#[derive(Default)]
struct Answers {
    /// The count of answer lines. `exchange` waits for a change.
    lines: u64,
    last: Option<(u32, u64)>,
    /// The stdout of the anchor reached end-of-file.
    closed: bool,
    /// Test hook: the largest capacity of the line buffer.
    #[cfg(test)]
    line_capacity: usize,
}

/// The anchor process of one WSL mutation. Its Job holds it, and its stdin stays open until `close`.
/// `exchange` waits up to the probe deadline, so `close` and `last` do not take its lock.
pub struct Anchor {
    process: OwnedHandle,
    stdin: Mutex<Option<File>>,
    /// Lets one exchange run at a time.
    exchange: Mutex<()>,
    /// After `close`, the anchor prints one line each second, so `last` is at most 1 second old.
    answers: Arc<(Mutex<Answers>, Condvar)>,
}

impl Anchor {
    pub fn start(command: &Command, job: HANDLE, current_dir: &Path) -> Result<Anchor, SpawnError> {
        let spawned = spawn(&command.spawn_request(current_dir), job)?;
        // SAFETY: `spawn` returned an open process handle that the caller owns.
        let process = unsafe { OwnedHandle::from_raw_handle(spawned.process.0) };
        let answers = Arc::new((Mutex::new(Answers::default()), Condvar::new()));
        let shared = Arc::clone(&answers);
        let stdout = spawned.stdout;
        std::thread::spawn(move || {
            let (state, changed) = &*shared;
            let mut reader = BufReader::new(stdout);
            let mut line = Vec::with_capacity(ANCHOR_LINE_BYTES);
            let mut malformed = false;
            loop {
                let (used, ends) = match reader.fill_buf() {
                    Ok([]) | Err(_) => break,
                    Ok(bytes) => {
                        let end = bytes.iter().position(|&b| b == b'\n');
                        let part = &bytes[..end.unwrap_or(bytes.len())];
                        if line.len() + part.len() > ANCHOR_LINE_BYTES {
                            malformed = true;
                        }
                        if !malformed {
                            line.extend_from_slice(part);
                        }
                        (end.map_or(bytes.len(), |end| end + 1), end.is_some())
                    }
                };
                reader.consume(used);
                #[cfg(test)]
                {
                    let mut state = lock(state);
                    state.line_capacity = state.line_capacity.max(line.capacity());
                }
                if !ends {
                    continue;
                }
                let text = std::str::from_utf8(&line).ok();
                let answer = text
                    .filter(|_| !malformed)
                    .and_then(|text| parse_anchor_line(text.strip_suffix('\r').unwrap_or(text)));
                if let Some(answer) = answer {
                    let mut state = lock(state);
                    state.lines += 1;
                    state.last = Some(answer);
                    changed.notify_all();
                }
                line.clear();
                malformed = false;
            }
            lock(state).closed = true;
            changed.notify_all();
        });
        let mut stderr = spawned.stderr;
        std::thread::spawn(move || std::io::copy(&mut stderr, &mut std::io::sink()));
        Ok(Anchor {
            process,
            stdin: Mutex::new(spawned.stdin),
            exchange: Mutex::new(()),
            answers,
        })
    }

    /// Writes one line and waits for its answer.
    pub fn exchange(&self) -> Option<(u32, u64)> {
        let _one = lock(&self.exchange);
        let (state, changed) = &*self.answers;
        let before = lock(state).lines;
        lock(&self.stdin).as_mut()?.write_all(b"\n").ok()?;
        let state = changed
            .wait_timeout_while(lock(state), PROBE_DEADLINE, |s| {
                s.lines == before && !s.closed
            })
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .0;
        if state.lines == before {
            None
        } else {
            state.last
        }
    }

    pub fn last(&self) -> Option<(u32, u64)> {
        lock(&self.answers.0).last
    }

    /// Ends an anchor that no Job entry keeps.
    pub fn end(&self) {
        // SAFETY: `process` keeps the handle open for the call.
        let _ = unsafe { TerminateProcess(HANDLE(self.process.as_raw_handle()), 1) };
    }

    /// `ended` closes the stdin of the anchor.
    pub fn close(&self) {
        *lock(&self.stdin) = None;
    }

    #[cfg(test)]
    pub fn running(&self) -> bool {
        // SAFETY: `process` keeps the handle open for the call.
        unsafe { WaitForSingleObject(HANDLE(self.process.as_raw_handle()), 0) != WAIT_OBJECT_0 }
    }

    /// Test hook: the largest capacity of the line buffer, and the count of answer lines.
    #[cfg(test)]
    fn line_facts(&self) -> (usize, u64) {
        let state = lock(&self.answers.0);
        (state.line_capacity, state.lines)
    }
}

/// The anchor state of one WSL mutation (contract §11 "Process ownership").
/// A clone shares the anchor, so a caller can wait for `after_exit` without the lock of its owner.
#[derive(Clone, Default)]
pub struct Mutation {
    anchor: Option<Arc<Anchor>>,
}

impl Mutation {
    /// Starts the anchor before the first execution process of the mutation.
    pub fn before_execution(
        &mut self,
        start: impl FnOnce() -> Result<Anchor, SpawnError>,
    ) -> Result<(), SpawnError> {
        if self.anchor.is_none() {
            self.anchor = Some(Arc::new(start()?));
        }
        Ok(())
    }

    /// A Job with an anchor takes its counts from the anchor, not from the Job accounting.
    pub fn has_anchor(&self) -> bool {
        self.anchor.is_some()
    }

    /// The anchor count after an execution process exits. It becomes `activeDescendants`.
    pub fn after_exit(&self) -> u32 {
        let Some(anchor) = self.anchor.as_ref() else {
            return 0;
        };
        anchor
            .exchange()
            .or_else(|| anchor.last())
            .map_or(0, |(count, _)| count)
    }

    /// One anchor line while a tracked process runs. The answer gives the I/O sum (contract §6 "Activity and stall notice").
    pub fn activity_sum(&self) -> Option<u64> {
        self.anchor.as_ref()?.exchange().map(|(_, io)| io)
    }

    /// The lingering count of a WSL Job is the last anchor count.
    pub fn lingering_count(&self) -> u32 {
        self.last().map_or(0, |(count, _)| count)
    }

    pub fn last(&self) -> Option<(u32, u64)> {
        self.anchor.as_ref().and_then(|anchor| anchor.last())
    }

    pub fn ended(&self) {
        if let Some(anchor) = self.anchor.as_ref() {
            anchor.close();
        }
    }

    #[cfg(test)]
    pub fn anchor_running(&self) -> bool {
        self.anchor.as_ref().is_some_and(|anchor| anchor.running())
    }

    /// Test hook: the largest capacity of the line buffer, and the count of answer lines.
    #[cfg(test)]
    pub fn line_facts(&self) -> (usize, u64) {
        self.anchor
            .as_ref()
            .map_or((0, 0), |anchor| anchor.line_facts())
    }
}

// ---- The hosts ----

/// Test host: runs each `wsl.exe` process in one given Job and reads the registration keys.
#[cfg(test)]
pub struct JobHost<'a> {
    pub job: HANDLE,
    pub current_dir: &'a Path,
}

/// Reads at most `cap` bytes and discards the rest until end-of-file, so the writer never blocks.
fn retain(mut pipe: File, cap: usize) -> Arc<Mutex<Vec<u8>>> {
    let kept = Arc::new(Mutex::new(Vec::new()));
    let shared = Arc::clone(&kept);
    std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        while let Ok(read) = pipe.read(&mut buffer) {
            if read == 0 {
                break;
            }
            let mut kept = lock(&shared);
            let room = cap.saturating_sub(kept.len());
            kept.extend_from_slice(&buffer[..read.min(room)]);
        }
    });
    kept
}

#[cfg(test)]
impl Host for JobHost<'_> {
    fn run(&self, command: &Command) -> Option<Output> {
        self.run_until(command, RETAINED_BYTES, PROBE_DEADLINE)
            .output
    }

    fn run_until(&self, command: &Command, cap: usize, deadline: Duration) -> Ended {
        let start = || spawn(&command.spawn_request(self.current_dir), self.job);
        start_and_collect(start, cap, deadline, None)
    }

    fn run_walk(&self, command: &Command, cap: usize, deadline: Duration, stop: HANDLE) -> Ended {
        let start = || spawn(&command.spawn_request(self.current_dir), self.job);
        start_and_collect(start, cap, deadline, Some(stop))
    }

    fn keys(&self) -> Vec<Key> {
        read_keys()
    }
}

/// Runs each `wsl.exe` process in the Job of one operation. The Job lock covers only the start.
pub struct OperationHost {
    pub jobs: Arc<Supervisor>,
    pub operation_id: String,
    pub current_dir: PathBuf,
}

impl Host for OperationHost {
    fn run(&self, command: &Command) -> Option<Output> {
        self.run_until(command, RETAINED_BYTES, PROBE_DEADLINE)
            .output
    }

    fn run_until(&self, command: &Command, cap: usize, deadline: Duration) -> Ended {
        start_and_collect(|| self.start(command), cap, deadline, None)
    }

    fn run_walk(&self, command: &Command, cap: usize, deadline: Duration, stop: HANDLE) -> Ended {
        start_and_collect(|| self.start(command), cap, deadline, Some(stop))
    }

    fn keys(&self) -> Vec<Key> {
        read_keys()
    }

    fn start(&self, command: &Command) -> Result<Spawned, SpawnError> {
        let request = command.spawn_request(&self.current_dir);
        self.jobs
            .with_job(&self.operation_id, |job| spawn(&request, job))
            .unwrap_or(Err(SpawnError::OwnershipFailed))
    }

    fn anchor(&self, command: &Command) -> Result<(), SpawnError> {
        self.jobs
            .start_anchor(&self.operation_id, command, &self.current_dir)
    }
}

/// Contract §6 `wslDistros`: the list results, the keys of the listed names, `wsl.exe`, and the saved Git of each listed GUID.
/// A missing `wsl.exe` or a failed list call gives `WSL_UNAVAILABLE` with reason `wsl-missing` (contract §11 "Distro checks").
/// `path` is the context path. Each name passed `parse_list`, and each saved Git passed the settings checks.
pub fn distros_reply(
    call_id: &str,
    path: &str,
    facts: Result<Distros, Reason>,
    saved: &[SavedWslGit],
) -> Value {
    let (Ok(facts), Some(program)) = (facts, wsl_program().to_str().map(str::to_string)) else {
        return reply::wsl_distros_unavailable(call_id, path);
    };
    let keys = facts
        .keys
        .iter()
        .map(|key| reply::wsl_distros_key(&key.guid, &key.name, key.version))
        .collect();
    let saved = saved
        .iter()
        .filter(|git| facts.keys.iter().any(|key| key.guid == git.guid))
        .map(|git| {
            reply::wsl_distros_saved(
                &git.guid,
                &git.distro,
                &git.git,
                &git.version,
                &git.identity,
            )
        })
        .collect();
    reply::wsl_distros_facts(
        call_id,
        path,
        &program,
        &facts.listed,
        &facts.running,
        keys,
        saved,
    )
}

/// A process that did not start or did not end, without output.
const NO_OUTPUT: Ended = Ended {
    output: None,
    deadline: false,
};

/// Starts one `wsl.exe` with `start` and collects it. A walk whose stop Event is already set starts no process (contract §6 "Walks").
fn start_and_collect(
    start: impl FnOnce() -> Result<Spawned, SpawnError>,
    cap: usize,
    deadline: Duration,
    stop: Option<HANDLE>,
) -> Ended {
    // SAFETY: the caller keeps the Event open for the call.
    if stop.is_some_and(|stop| unsafe { WaitForSingleObject(stop, 0) } == WAIT_OBJECT_0) {
        return NO_OUTPUT;
    }
    start().map_or(NO_OUTPUT, |spawned| collect(spawned, cap, deadline, stop))
}

/// Waits for one `wsl.exe` process within the probe deadline and keeps at most `cap` bytes of its stdout.
/// A set `stop` Event ends the process as the deadline does. It ends only this `wsl.exe`, never its Job (contract §6 "Walks").
pub(crate) fn collect(
    spawned: Spawned,
    cap: usize,
    deadline: Duration,
    stop: Option<HANDLE>,
) -> Ended {
    // SAFETY: `spawn` returned an open process handle that this call owns.
    let process = unsafe { OwnedHandle::from_raw_handle(spawned.process.0) };
    let handle = HANDLE(process.as_raw_handle());
    let started = Instant::now();
    let stdout = retain(spawned.stdout, cap);
    let _stderr = retain(spawned.stderr, RETAINED_BYTES);
    let wait_ms = u32::try_from(deadline.as_millis()).unwrap_or(u32::MAX - 1);
    let waited = match stop {
        // SAFETY: `process` and the caller keep both handles open for the call.
        Some(stop) => unsafe { WaitForMultipleObjects(&[handle, stop], false, wait_ms) },
        // SAFETY: `process` keeps the handle open for the call.
        None => unsafe { WaitForSingleObject(handle, wait_ms) },
    };
    if waited != WAIT_OBJECT_0 {
        // The trap of the wrapper ends the scope when `wsl.exe` ends (contract §11 "Process launch").
        // SAFETY: `process` keeps the handle open for the call.
        let _ = unsafe { TerminateProcess(handle, 1) };
        return Ended {
            output: None,
            deadline: waited == WAIT_TIMEOUT,
        };
    }
    let mut code = 0u32;
    // SAFETY: `process` keeps the handle open, and `code` is a live local.
    if unsafe { GetExitCodeProcess(handle, &mut code) }.is_err() {
        return Ended {
            output: None,
            deadline: false,
        };
    }
    // The pipe ends when `wsl.exe` ends. The probe deadline bounds the wait for the last bytes. A set stop Event ends the wait.
    while Arc::strong_count(&stdout) > 1 && started.elapsed() < deadline + PROBE_DEADLINE {
        match stop {
            // SAFETY: the caller keeps the Event open for the call.
            Some(stop) if unsafe { WaitForSingleObject(stop, 10) } == WAIT_OBJECT_0 => {
                return NO_OUTPUT;
            }
            Some(_) => {}
            None => std::thread::sleep(Duration::from_millis(10)),
        }
    }
    let stdout = lock(&stdout).clone();
    Ended {
        output: Some(Output {
            exit_code: Some(code),
            stdout,
        }),
        deadline: false,
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
        // Registry key names ignore letter case, so folding `A` to `F` is exact. Another name form is no distro key (gaps.md W2).
        let Ok(key) = String::from_utf16(&name[..length as usize]) else {
            continue;
        };
        let guid = key.to_ascii_lowercase();
        if !is_guid(&guid) {
            continue;
        }
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

    use crate::jobs::tests::{Fixture, eventually, start_child, test_exe, wait_file};
    use crate::jobs::{Job, Supervisor};
    use crate::spawn::{Input, creation_flags};

    /// The facts of `super::file_facts_reply` in their wire form.
    fn file_facts_reply(output: Option<Output>, entries: &[FactEntry], digest: bool) -> Vec<Value> {
        let (facts, index) = super::file_facts_reply(output, entries, digest, None);
        assert!(index.is_none());
        facts.iter().map(|fact| json!(fact)).collect()
    }

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
            sha256sum: "/usr/bin/sha256sum".to_string(),
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

        fn run_walk(
            &self,
            command: &Command,
            _cap: usize,
            _deadline: Duration,
            _stop: HANDLE,
        ) -> Ended {
            Ended {
                output: self.run(command),
                deadline: false,
            }
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
            probe_command("Ubuntu-24.04", "/home/user/r a$b", &base()),
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

    // ---- T212 decision W9: the stop Event of a walk ----

    /// A manual-reset Event without a name, owned by the caller.
    fn walk_event() -> OwnedHandle {
        // SAFETY: no name and no security attributes. The returned handle is open and owned.
        let event =
            unsafe { windows::Win32::System::Threading::CreateEventW(None, true, false, None) }
                .expect("event");
        // SAFETY: `CreateEventW` returned an open handle that nothing else owns.
        unsafe { OwnedHandle::from_raw_handle(event.0) }
    }

    fn set(event: &OwnedHandle) {
        // SAFETY: `event` keeps the handle open for the call.
        unsafe { windows::Win32::System::Threading::SetEvent(HANDLE(event.as_raw_handle())) }
            .expect("set event");
    }

    /// Review V1: after `wsl.exe` ends, a set stop Event also ends the wait for the last stdout bytes.
    #[test]
    fn a_set_stop_ends_the_wait_for_stdout_after_the_process_ended() {
        use std::os::windows::io::IntoRawHandle;
        let child = std::process::Command::new(test_exe())
            .args(crate::jobs::tests::child_arguments(&["sleep", "0"]))
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("child");
        // The writers stay open, so the readers never see end-of-file.
        let (stdout, _stdout_writer) = std::io::pipe().expect("pipe");
        let (stderr, _stderr_writer) = std::io::pipe().expect("pipe");
        let spawned = Spawned {
            process: HANDLE(child.into_raw_handle()),
            pid: 0,
            stdin: None,
            stdout: File::from(OwnedHandle::from(stdout)),
            stderr: File::from(OwnedHandle::from(stderr)),
        };
        let event = walk_event();
        let stop = HANDLE(event.as_raw_handle());
        let started = Instant::now();
        let ended = std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(500));
                set(&event);
            });
            collect(spawned, 64, Duration::from_secs(5), Some(stop))
        });
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "the stop ends the stdout wait: {:?}",
            started.elapsed()
        );
        assert!(ended.output.is_none(), "a stopped walk keeps no output");
    }

    /// Review S3: a walk whose stop Event is already set starts no `wsl.exe`.
    #[test]
    fn a_walk_with_a_set_stop_starts_no_process() {
        let job = Job::create().expect("Job");
        let directory = std::env::temp_dir();
        let host = JobHost {
            job: job.handle(),
            current_dir: &directory,
        };
        let command = Command {
            program: test_exe(),
            arguments: crate::jobs::tests::child_arguments(&["sleep", "60000"]),
            environment: std::env::vars_os().collect(),
            stdin: Stdin::Closed,
        };
        let event = walk_event();
        set(&event);
        let ended = host.run_walk(
            &command,
            64,
            Duration::from_secs(5),
            HANDLE(event.as_raw_handle()),
        );
        assert!(ended.output.is_none());
        assert_eq!(
            job.total_processes().expect("accounting"),
            0,
            "no process started"
        );
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
                Some(INVALID)
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
                Some(INVALID)
            );
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
        let probe = probe_command("Ubuntu-24.04", "/home/user/r a$b", &base());
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
            assert_eq!(unit_name(operation, 1), Err(INVALID), "{operation:?}");
            assert!(
                matches!(anchor_command(&inst, operation, &base()), Err(INVALID)),
                "{operation:?}"
            );
            let host = FakeHost::new(Vec::new(), Vec::new());
            assert_eq!(
                identities(&host, &inst, operation, 1, &strings(&["/r"]), &base(), None),
                vec![Err(Refusal::Invalid)],
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

    /// The lines that the stand-in anchor prints after `ended` while it lingers.
    const LINGER_LINES: u64 = 1000;

    /// The long line of the stand-in anchor: 1 MiB of `x`, then `3 999` and a 300 ms pause before its line end.
    /// A reader that restarts a line at each 64-byte cap would read `3 999` as an answer.
    const LONG_LINE_BYTES: usize = 1 << 20;

    /// A stand-in anchor: each stdin line gets `<lines read> <lines read * 100>`.
    /// At end-of-file, it writes the line count to the file argument, prints `0 0`, and exits.
    /// With a second file argument, it first lingers: it prints `<lines read> <i>` for `i` from 1 to `LINGER_LINES`.
    /// Then it waits until that file exists, for at most 60 seconds.
    /// With a third argument `long`, it lingers with one `LONG_LINE` line in place of those lines.
    /// With a third argument `banner`, it prints `banner text` and a 300 ms pause before its answer to the second stdin line.
    /// With a third argument `constant`, each answer holds the I/O sum 500. A second argument `-` means no release file.
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
        let release = args.get(split + 2).filter(|a| *a != "-").map(PathBuf::from);
        let mode = args.get(split + 3).map(String::as_str);
        let long = mode == Some("long");
        let mut out = std::io::stdout();
        // libtest prints the test name without a line end before this output.
        let _ = writeln!(out);
        let mut lines = 0u64;
        for line in std::io::stdin().lock().lines() {
            if line.is_err() {
                break;
            }
            lines += 1;
            if mode == Some("banner") && lines == 2 {
                let _ = writeln!(out, "banner text");
                let _ = out.flush();
                std::thread::sleep(Duration::from_millis(300));
            }
            let io = if mode == Some("constant") {
                500
            } else {
                lines * 100
            };
            let _ = writeln!(out, "{lines} {io}");
            let _ = out.flush();
        }
        std::fs::write(file, lines.to_string()).expect("write line count");
        if let Some(release) = release {
            if long {
                let _ = out.write_all(&vec![b'x'; LONG_LINE_BYTES]);
                let _ = out.write_all(b"3 999");
                let _ = out.flush();
                std::thread::sleep(Duration::from_millis(300));
                let _ = writeln!(out);
                let _ = writeln!(out, "{lines} 777");
            } else {
                for i in 1..=LINGER_LINES {
                    let _ = writeln!(out, "{lines} {i}");
                }
            }
            let _ = out.flush();
            let deadline = Instant::now() + Duration::from_secs(60);
            while !release.exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        let _ = writeln!(out, "0 0");
        let _ = out.flush();
        std::process::exit(0);
    }

    fn stand_in_anchor(file: &Path, release: Option<&Path>) -> Command {
        let mut arguments: Vec<String> = ANCHOR_CHILD.iter().map(|s| s.to_string()).collect();
        arguments.push(file.to_string_lossy().into_owned());
        arguments.extend(release.map(|path| path.to_string_lossy().into_owned()));
        let mut command = anchor_command(&installation(), OPERATION, &base()).expect("anchor");
        command.program = test_exe();
        command.arguments = arguments;
        command.environment = std::env::vars_os().collect();
        command
    }

    // ---- T225, T228: activity of a WSL Job (contract §6 "Activity and stall notice") ----

    /// A WSL Job takes its activity sum only from the anchor. A Job child changes the Job `IO_COUNTERS` every 100 ms.
    /// With a constant anchor sum, the tracker still stalls. With a changing anchor sum, it never stalls.
    /// The anchor gets one line each second while the process is tracked.
    #[test]
    fn a_wsl_job_takes_its_activity_only_from_one_anchor_line_each_second() {
        use crate::jobs::Tracker;
        use crate::jobs::tests::{kinds, recorder};

        let fixture = Fixture::new();
        let directory = std::env::temp_dir();
        for (mode, stalls) in [("constant", true), ("count", false)] {
            let supervisor = Supervisor::start().expect("supervisor");
            supervisor.open(OPERATION).expect("open");
            let lines_file = fixture.path(&format!("lines-{mode}"));
            let mut anchor = stand_in_anchor(&lines_file, None);
            anchor.arguments.extend(["-".to_string(), mode.to_string()]);
            supervisor
                .start_anchor(OPERATION, &anchor, &directory)
                .expect("anchor");
            let io_file = fixture.path(&format!("io-{mode}"));
            let mut child = start_child(&["io", &io_file.to_string_lossy(), "0", "100", "60"]);
            supervisor
                .assign(OPERATION, child.handle())
                .expect("assign");
            let (events, sink) = recorder();
            let tracker = Tracker::new(
                Duration::from_millis(1500),
                Some(Duration::from_secs(60)),
                sink,
            );
            assert!(supervisor.track(OPERATION, &tracker));
            std::thread::sleep(Duration::from_millis(4500));
            let expected: &[crate::jobs::Event] = if stalls {
                &[crate::jobs::Event::Stalled]
            } else {
                &[]
            };
            assert_eq!(kinds(&events), expected, "{mode}");
            supervisor.untrack(OPERATION, &tracker);
            supervisor.ended(OPERATION, false);
            let lines = wait_file(&lines_file, "", WAIT).expect("the anchor ends after ended");
            let lines: u64 = lines.parse().expect("line count");
            assert!((3..=5).contains(&lines), "{mode}: {lines} anchor lines");
            supervisor.close(OPERATION);
            let _ = child.child.wait();
            supervisor.shutdown();
        }
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
                    Anchor::start(
                        &stand_in_anchor(&lines_file, None),
                        job.handle(),
                        &directory,
                    )
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
        let mut missing = stand_in_anchor(Path::new("unused"), None);
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

    // ---- T211: the anchor in the operation Job ----

    fn wsl_tag() -> crate::bootstrap::PhysicalIdentity {
        crate::bootstrap::PhysicalIdentity::Wsl(WslIdentity {
            guid: GUID.to_string(),
            file_system_id: "fedc9aa3bd65bc57".to_string(),
            inode: "2".to_string(),
        })
    }

    /// A WSL mutation Job with its anchor and three injected Git processes.
    /// After each exit, the Job holds the anchor and its console host, so the Job accounting would give 2.
    fn three_git_processes(supervisor: &Supervisor, anchor: &Command) {
        let directory = std::env::temp_dir();
        supervisor.open(OPERATION).expect("open");
        supervisor.tag(OPERATION, wsl_tag());
        for n in 1..=3u32 {
            supervisor
                .start_anchor(OPERATION, anchor, &directory)
                .expect("anchor");
            let mut git = start_child(&["sleep", "50"]);
            supervisor.assign(OPERATION, git.handle()).expect("assign");
            let _ = git.child.wait();
            // One anchor answers every line, so its count reaches 3.
            assert_eq!(
                supervisor.active_processes(OPERATION),
                Some(n),
                "activeDescendants after process {n}"
            );
        }
    }

    #[test]
    fn a_wsl_mutation_job_takes_active_descendants_and_the_lingering_count_from_its_anchor() {
        let fixture = Fixture::new();
        let lines_file = fixture.path("lines");
        let release = fixture.path("release");
        let supervisor = Supervisor::start().expect("start");
        three_git_processes(&supervisor, &stand_in_anchor(&lines_file, Some(&release)));
        assert!(!lines_file.exists(), "stdin stays open until ended");
        assert_eq!(
            supervisor.lingering_count(&wsl_tag()),
            0,
            "no lingering Job"
        );
        supervisor.ended(OPERATION, false);
        assert_eq!(
            wait_file(&lines_file, "3", WAIT).as_deref(),
            Some("3"),
            "ended closes the stdin of the anchor"
        );
        assert!(supervisor.is_lingering(OPERATION), "the anchor counts 3");
        assert_eq!(
            supervisor.lingering_count(&wsl_tag()),
            3,
            "the last anchor count"
        );
        std::fs::write(&release, "").expect("release");
        assert!(
            eventually(WAIT, || supervisor.job_handle(OPERATION).is_none()),
            "the anchor exits at count 0, and the empty Job closes"
        );
        assert_eq!(supervisor.lingering_count(&wsl_tag()), 0);
        supervisor.shutdown();
    }

    #[test]
    fn revoke_reports_the_last_anchor_count_and_closes_the_wsl_job() {
        let fixture = Fixture::new();
        let lines_file = fixture.path("lines");
        let never = fixture.path("never");
        let supervisor = Supervisor::start().expect("start");
        three_git_processes(&supervisor, &stand_in_anchor(&lines_file, Some(&never)));
        supervisor.ended(OPERATION, false);
        wait_file(&lines_file, "3", WAIT).expect("ended closes the stdin of the anchor");
        assert_eq!(supervisor.revoke(&wsl_tag()), 3);
        assert!(
            supervisor.job_handle(OPERATION).is_none(),
            "revoke closes the Job"
        );
        supervisor.shutdown();
    }

    #[test]
    fn after_ended_a_lingering_anchor_keeps_only_its_last_line() {
        let fixture = Fixture::new();
        let lines_file = fixture.path("lines");
        let release = fixture.path("release");
        let job = Job::create().expect("Job");
        let directory = std::env::temp_dir();
        let mut mutation = Mutation::default();
        mutation
            .before_execution(|| {
                Anchor::start(
                    &stand_in_anchor(&lines_file, Some(&release)),
                    job.handle(),
                    &directory,
                )
            })
            .expect("anchor");
        for n in 1..=3u32 {
            assert_eq!(mutation.after_exit(), n);
        }
        mutation.ended();
        // The stream keeps its order, so the last lingering line arrives after every other line.
        assert!(
            eventually(WAIT, || mutation.last() == Some((3, LINGER_LINES))),
            "the anchor printed {LINGER_LINES} lines after ended: {:?}",
            mutation.last()
        );
        assert_eq!(mutation.lingering_count(), 3, "the last anchor count");
        std::fs::write(&release, "").expect("release");
        assert!(
            eventually(WAIT, || !mutation.anchor_running()),
            "the anchor exits"
        );
        assert!(eventually(WAIT, || mutation.lingering_count() == 0));
    }

    #[test]
    fn an_anchor_line_above_the_cap_is_dropped_and_the_next_line_is_read() {
        let fixture = Fixture::new();
        let lines_file = fixture.path("lines");
        let release = fixture.path("release");
        let mut command = stand_in_anchor(&lines_file, Some(&release));
        command.arguments.push("long".to_string());
        let job = Job::create().expect("Job");
        let directory = std::env::temp_dir();
        let mut mutation = Mutation::default();
        mutation
            .before_execution(|| Anchor::start(&command, job.handle(), &directory))
            .expect("anchor");
        for n in 1..=3u32 {
            assert_eq!(mutation.after_exit(), n);
        }
        mutation.ended();
        assert!(
            eventually(WAIT, || mutation.last() == Some((3, 777))),
            "the line after the long line is read: {:?}",
            mutation.last()
        );
        let (capacity, answers) = mutation.line_facts();
        assert!(
            capacity <= ANCHOR_LINE_BYTES,
            "the line buffer stays at most {ANCHOR_LINE_BYTES} bytes: {capacity}"
        );
        assert_eq!(answers, 4, "the long line gives no answer");
        std::fs::write(&release, "").expect("release");
        assert!(
            eventually(WAIT, || !mutation.anchor_running()),
            "the anchor exits"
        );
    }

    #[test]
    fn an_exchange_skips_a_malformed_line_and_returns_its_own_answer() {
        let fixture = Fixture::new();
        let lines_file = fixture.path("lines");
        let release = fixture.path("release");
        let mut command = stand_in_anchor(&lines_file, Some(&release));
        command.arguments.push("banner".to_string());
        let job = Job::create().expect("Job");
        let directory = std::env::temp_dir();
        let mut mutation = Mutation::default();
        mutation
            .before_execution(|| Anchor::start(&command, job.handle(), &directory))
            .expect("anchor");
        assert_eq!(mutation.after_exit(), 1);
        let anchor = mutation.anchor.clone().expect("anchor");
        let start = Instant::now();
        let answer = anchor.exchange();
        let elapsed = start.elapsed();
        assert_eq!(answer, Some((2, 200)), "the answer after the banner line");
        assert!(
            elapsed < Duration::from_secs(2),
            "the answer ends the exchange: {elapsed:?}"
        );
        assert_eq!(mutation.after_exit(), 3, "the counts stay in step");
        mutation.ended();
        std::fs::write(&release, "").expect("release");
        assert!(
            eventually(WAIT, || !mutation.anchor_running()),
            "the anchor exits"
        );
    }

    // ---- Identity requests (gaps.md W2 and W4) ----

    #[test]
    fn the_identity_request_runs_one_probe_for_all_paths_and_returns_no_device_number() {
        let host = FakeHost::new(
            vec![output(
                0,
                "id 123456 ef53:fedc9aa3bd65bc57\nabsent\nfail\nid 7 1021997:abc\n",
            )],
            Vec::new(),
        );
        let inst = installation();
        let paths = strings(&["/home/user/r a$b", "/gone", "/denied", "/mnt/c/r"]);
        let found = identities(&host, &inst, OPERATION, 7, &paths, &base(), None);
        assert_eq!(
            found[0].as_ref().expect("identity").reply(),
            json!({ "distroGuid": GUID, "fileSystemId": "fedc9aa3bd65bc57", "inode": "123456" })
        );
        assert_eq!(
            found[1..].to_vec(),
            vec![
                Err(Refusal::Absent),
                Err(Refusal::Failed),
                Err(Refusal::MixedLocation)
            ]
        );
        let commands = host.commands.borrow();
        assert_eq!(commands.len(), 1, "one wsl.exe start for the request");
        let mut arguments = strings(&["-c", &json_text("identity"), "sh", STAT, PERL]);
        arguments.extend(paths.iter().cloned());
        let expected = wrapped(
            &inst,
            Mode::Probe,
            &unit_name(OPERATION, 7).expect("unit"),
            None,
            "/bin/sh",
            &arguments,
            &base(),
            Stdin::Closed,
        );
        assert_eq!(commands[0].arguments, expected.arguments);
        assert!(
            commands
                .iter()
                .flat_map(|c| &c.arguments)
                .all(|a| !a.contains("%d") && !a.contains("%D"))
        );
    }

    #[test]
    fn only_type_ef53_with_a_nonzero_id_in_the_canonical_form_gives_an_identity() {
        assert!(classify(GUID, "2", "ef53:fedc9aa3bd65bc57").is_ok());
        assert!(classify(GUID, "18446744073709551615", "ef53:1").is_ok());
        assert_eq!(
            classify(GUID, "2", "1021997:100000000").err(),
            Some(Refusal::MixedLocation)
        );
        for file_system in [
            "1021994:abc",
            "58465342:fd00",
            "9123683e:1",
            "ef53:0",
            "ef53:0000000000000000",
        ] {
            assert_eq!(
                classify(GUID, "2", file_system).err(),
                Some(Refusal::NoFsUuid),
                "{file_system}"
            );
        }
        let upper = GUID.to_ascii_uppercase();
        for (guid, inode, file_system) in [
            (GUID, "", "ef53:1"),
            (GUID, "x", "ef53:1"),
            (GUID, "0", "ef53:1"),
            (GUID, "018", "ef53:1"),
            (GUID, "18446744073709551616", "ef53:1"),
            (GUID, "2", ""),
            (GUID, "2", "ef53"),
            (GUID, "2", "ef53:xyz"),
            (GUID, "2", "ef53:0fedc9aa3bd65bc57"),
            (GUID, "2", "ef53:fedc9aa3bd65bc57a"),
            (upper.as_str(), "2", "ef53:1"),
            ("c6d24ae9-40f2-40bf-b35d-bf0b6ca4ea00", "2", "ef53:1"),
        ] {
            assert_eq!(
                classify(guid, inode, file_system).err(),
                Some(Refusal::Failed),
                "{guid} {inode} {file_system}"
            );
        }
        let entry = |refusal: Refusal| json!(reply::identity_refused(refusal.reason()));
        assert_eq!(
            entry(Refusal::NoFsUuid),
            json!({ "code": "UNSUPPORTED_REPOSITORY", "reason": "no-fs-uuid" })
        );
        assert_eq!(
            entry(Refusal::MixedLocation),
            json!({ "code": "UNSUPPORTED_REPOSITORY", "reason": "mixed-location" })
        );
        assert_eq!(
            entry(Refusal::Absent),
            json!({ "code": "UNSUPPORTED_REPOSITORY", "reason": "absent" })
        );
        assert_eq!(
            entry(Refusal::Failed),
            json!({ "code": "UNSUPPORTED_REPOSITORY" })
        );
    }

    #[test]
    fn a_failed_identity_probe_refuses_every_path() {
        let inst = installation();
        let paths = strings(&["/r", "/s"]);
        for outputs in [
            vec![None],
            vec![output(1, "id 2 ef53:1\nid 3 ef53:1\n")],
            vec![output(0, "id 2 ef53:1\n")],
            vec![output(0, "id 2 ef53:1\nid 3 ef53:1\nid 4 ef53:1\n")],
            vec![output(0, "id 2 ef53:1\nid 3 ef53:1")],
        ] {
            let host = FakeHost::new(outputs, Vec::new());
            assert_eq!(
                identities(&host, &inst, OPERATION, 1, &paths, &base(), None),
                vec![Err(Refusal::Failed), Err(Refusal::Failed)]
            );
        }
        // A malformed line fails only its own path.
        let host = FakeHost::new(
            vec![output(0, "id 2 ef53:1\nid 3 ef53:1 extra\n")],
            Vec::new(),
        );
        let found = identities(&host, &inst, OPERATION, 1, &paths, &base(), None);
        assert!(found[0].is_ok());
        assert_eq!(found[1], Err(Refusal::Failed));
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
                Some(INVALID),
                "{directory:?}"
            );
            let host = FakeHost::new(Vec::new(), Vec::new());
            assert_eq!(
                identities(
                    &host,
                    &inst,
                    OPERATION,
                    1,
                    &strings(&[directory]),
                    &base(),
                    None
                ),
                vec![Err(Refusal::Invalid)],
                "{directory:?}"
            );
            assert!(
                host.commands.borrow().is_empty(),
                "no probe for {directory:?}"
            );
        }
        // An identity reply carries a refused path as a failed probe.
        assert_eq!(
            json!(reply::identity_refused(Refusal::Invalid.reason())),
            json!({ "code": "UNSUPPORTED_REPOSITORY" })
        );
    }

    // ---- The `fileFacts` probe (gaps.md W3) ----

    fn entries(paths: &[(usize, &[&str])]) -> Vec<FactEntry> {
        paths
            .iter()
            .map(|(root, path)| FactEntry {
                root: *root,
                path: strings(path),
            })
            .collect()
    }

    fn facts_output(bytes: &[u8]) -> Option<Output> {
        Some(Output {
            exit_code: Some(0),
            stdout: bytes.to_vec(),
        })
    }

    #[test]
    fn the_file_facts_command_runs_perl_through_the_wrapper_with_the_entries_on_stdin() {
        let inst = installation();
        let roots = [
            "/home/u/r".to_string(),
            "/home/u/r/.git".to_string(),
            "/home/u/r/.git".to_string(),
        ];
        let command = file_facts_command(
            &inst,
            "arbareto-x-3.scope",
            true,
            &roots,
            &entries(&[(1, &["hooks", "pre-commit"]), (0, &["a b"])]),
            None,
            &base(),
        );
        let perl = format!("{}\n{}", json_text("perlHead"), json_text("fileFacts"));
        let mut arguments = strings(&["-e", &perl, "--", "1"]);
        arguments.extend(roots.iter().cloned());
        let expected = wrapped(
            &inst,
            Mode::Probe,
            "arbareto-x-3.scope",
            None,
            PERL,
            &arguments,
            &base(),
            Stdin::Closed,
        );
        assert_eq!(command.arguments, expected.arguments);
        let Stdin::Bytes(input) = &command.stdin else {
            panic!("stdin bytes");
        };
        assert_eq!(
            input.as_slice(),
            b"1\x002\x00hooks\x00pre-commit\x000\x001\x00a b\x00"
        );
    }

    #[test]
    fn each_record_maps_to_its_fact_and_the_shell_computes_each_digest() {
        let mut out = Vec::new();
        out.extend_from_slice(b"absent\0other\0directory\x001\0");
        out.extend_from_slice(b"link\x002\x009\0plain.txt");
        out.extend_from_slice(b"link\x001\x002\0/x");
        out.extend_from_slice(b"link\x001\x001\0\xff");
        out.extend_from_slice(b"file\x006\x00-2\x001\x000\x00data\x006\0plain\n");
        out.extend_from_slice(b"file\x002097152\x001751487822\x000\x000\x00file-bytes\0");
        out.extend_from_slice(b"error\x000\x00access-denied\0");
        let list = entries(&[
            (0, &["a"]),
            (0, &["b"]),
            (0, &["c"]),
            (0, &["d", "e"]),
            (0, &["f"]),
            (0, &["g"]),
            (0, &["h"]),
            (0, &["i"]),
            (2, &["j"]),
        ]);
        let facts = file_facts_reply(facts_output(&out), &list, true);
        assert_eq!(
            facts,
            vec![
                json!({ "kind": "absent" }),
                json!({ "kind": "other" }),
                json!({ "kind": "directory", "executable": true }),
                json!({ "kind": "link", "component": 2, "tag": "symlink", "target": "plain.txt", "relative": true }),
                json!({ "kind": "link", "component": 1, "tag": "symlink", "target": "/x", "relative": false }),
                json!({ "kind": "link", "component": 1, "tag": "other" }),
                json!({ "kind": "file", "size": 6, "lastWrite": "-2000000000", "executable": false, "ownerExecute": true,
                    "digest": crate::settings::hex(&crate::settings::sha256(b"plain\n")) }),
                json!({ "kind": "file", "size": 2097152, "lastWrite": "1751487822000000000", "executable": false, "ownerExecute": false, "bound": "file-bytes" }),
                json!({ "kind": "error", "component": 0, "code": "access-denied" }),
            ]
        );
        let without = file_facts_reply(
            facts_output(b"file\x006\x001\x000\x001\x00none\0"),
            &entries(&[(0, &["a"])]),
            false,
        );
        assert_eq!(
            without,
            vec![
                json!({ "kind": "file", "size": 6, "lastWrite": "1000000000", "executable": true, "ownerExecute": false })
            ]
        );
    }

    #[test]
    fn a_probe_output_that_breaks_a_check_gives_each_entry_other_error() {
        let one = entries(&[(0, &["a"])]);
        let failed = vec![json!({ "kind": "error", "component": 0, "code": "other-error" })];
        let mut big = b"file\x001\x001\x000\x000\x00data\x001048577\0".to_vec();
        big.resize(big.len() + 1_048_577, b'a');
        let overflow = format!("file\x001\x00{}\x000\x000\x00none\0", i64::MAX);
        for (output, digest) in [
            (None, false),
            (
                Some(Output {
                    exit_code: Some(3),
                    stdout: b"absent\0".to_vec(),
                }),
                false,
            ),
            (
                Some(Output {
                    exit_code: Some(255),
                    stdout: b"absent\0".to_vec(),
                }),
                false,
            ),
            (facts_output(b"absent\0absent\0"), false),
            (facts_output(b"absent\0trailing"), false),
            (facts_output(b"absent"), false),
            (facts_output(b""), false),
            (facts_output(b"link\x002\x001\0x"), false),
            (facts_output(b"link\x001\x004096\0x"), false),
            (facts_output(b"error\x002\x00io-error\0"), false),
            (facts_output(b"error\x000\x00EACCES\0"), false),
            (
                facts_output(b"file\x001\x001\x000\x000\x00data\x001\0a"),
                false,
            ),
            (facts_output(b"file\x001\x001\x000\x000\x00none\0"), true),
            (facts_output(b"file\x001\x0001\x000\x000\x00none\0"), false),
            (facts_output(b"directory\x002\0"), false),
            (facts_output(overflow.as_bytes()), false),
            (facts_output(&big), true),
            // A link text has at least one byte.
            (facts_output(b"link\x001\x000\0"), false),
            // Output past the cap.
            (facts_output(&vec![0; FACTS_OUTPUT_BYTES + 1]), false),
        ] {
            assert_eq!(file_facts_reply(output, &one, digest), failed);
        }
        // A data length above the file bound fails before it counts toward the total, so the sum cannot overflow.
        let two = entries(&[(0, &["a"]), (0, &["b"])]);
        let huge = format!(
            "file\x001\x001\x000\x000\x00data\x001\0afile\x001\x001\x000\x000\x00data\x00{}\0",
            usize::MAX
        );
        assert_eq!(
            file_facts_reply(facts_output(huge.as_bytes()), &two, true),
            vec![json!({ "kind": "error", "component": 0, "code": "other-error" }); 2]
        );
        // The data of one request stays within 8 MiB in request order.
        let nine = entries(&[
            (0, &["1"]),
            (0, &["2"]),
            (0, &["3"]),
            (0, &["4"]),
            (0, &["5"]),
            (0, &["6"]),
            (0, &["7"]),
            (0, &["8"]),
            (0, &["9"]),
        ]);
        let mut sum = Vec::new();
        for _ in 0..9 {
            sum.extend_from_slice(b"file\x001048576\x001\x000\x000\x00data\x001048576\0");
            sum.resize(sum.len() + 1_048_576, 0);
        }
        assert_eq!(
            file_facts_reply(facts_output(&sum), &nine, true),
            vec![json!({ "kind": "error", "component": 0, "code": "other-error" }); 9]
        );
    }

    // ---- T205: the Git probe ----

    #[test]
    fn the_git_probe_runs_the_contract_text_without_the_wrapper() {
        let probe = json_text("probe");
        assert_eq!(
            probe_command("Ubuntu-24.04", "/home/user/r a$b", &base()).arguments,
            strings(&[
                "--distribution",
                "Ubuntu-24.04",
                "--cd",
                "/",
                "--exec",
                "/bin/sh",
                "-c",
                probe.as_str(),
                "sh",
                "/home/user/r a$b"
            ])
        );
        for needle in [
            "export LC_ALL=C",
            "sel=$1",
            "command -v",
            "readlink -f",
            "head -c 2",
            "--version",
            "/usr/bin/stat",
            "/usr/bin/env",
            "/usr/bin/perl",
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
            .run(&probe_command(&reference.distro, "/", &environment))
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
            sha256sum: probe_fact(&text, "path sha256sum ")
                .expect("sha256sum")
                .to_string(),
        })
    }

    // ---- The `wslDistros` reply (contract §6 "Channel frames") ----

    fn saved_git(guid: &str) -> SavedWslGit {
        SavedWslGit {
            guid: guid.to_string(),
            distro: "Ubuntu-24.04".to_string(),
            git: "/usr/bin/git".to_string(),
            version: "2.55.0".to_string(),
            identity: "fedc9aa3bd65bc57:43750:4066232:1751487822".to_string(),
        }
    }

    #[test]
    fn the_wsl_distros_reply_holds_the_lists_the_keys_wsl_exe_and_only_the_saved_git_of_a_listed_guid()
     {
        let path = json!({ "type": "wslDistros", "callId": OPERATION, "path": r"\\wsl.localhost\Ubuntu-24.04\home\u\r" });
        let facts = Distros {
            listed: vec!["Ubuntu-24.04".to_string(), "Debian".to_string()],
            running: vec!["Debian".to_string()],
            keys: vec![Key {
                guid: GUID.to_string(),
                name: "Ubuntu-24.04".to_string(),
                version: 2,
            }],
        };
        let text = path["path"].as_str().expect("path");
        let reply = distros_reply(
            OPERATION,
            text,
            Ok(facts),
            &[saved_git(GUID), saved_git(OTHER_GUID)],
        );
        let mut expected = path.clone();
        expected["wslExecutable"] = json!(wsl_program().to_str().expect("UTF-8"));
        expected["listed"] = json!(["Ubuntu-24.04", "Debian"]);
        expected["running"] = json!(["Debian"]);
        expected["keys"] = json!([{ "guid": GUID, "name": "Ubuntu-24.04", "version": 2 }]);
        expected["saved"] = json!([{ "guid": GUID, "distro": "Ubuntu-24.04", "git": "/usr/bin/git", "version": "2.55.0", "gitIdentity": "fedc9aa3bd65bc57:43750:4066232:1751487822" }]);
        assert_eq!(reply, expected);
        let refused = distros_reply(OPERATION, text, Err(Reason::WslMissing), &[saved_git(GUID)]);
        let mut expected = path.clone();
        expected["code"] = json!("WSL_UNAVAILABLE");
        expected["reason"] = json!("wsl-missing");
        assert_eq!(refused, expected);
    }

    // ---- The Git probe parse (contract §11 "Git per distro") ----

    /// The reference distro output of the `src/contracts/wsl-process.json` probe on 2026-10-06, with Git 2.55.0.
    fn probe_output(change: &[(&str, Option<&str>)]) -> String {
        let mut lines: Vec<(String, String)> = [
            ("path git", "/usr/bin/git"),
            ("magic git", "-"),
            ("path systemd-run", "/usr/bin/systemd-run"),
            ("magic systemd-run", "-"),
            ("path systemctl", "/usr/bin/systemctl"),
            ("magic systemctl", "-"),
            ("path setsid", "/usr/bin/setsid"),
            ("magic setsid", "-"),
            ("path stat", "/usr/bin/stat"),
            ("magic stat", "-"),
            ("path env", "/usr/bin/env"),
            ("magic env", "-"),
            ("path perl", "/usr/bin/perl"),
            ("magic perl", "-"),
            ("path sha256sum", "/usr/bin/sha256sum"),
            ("magic sha256sum", "-"),
            ("pathenv", "/usr/local/bin:/usr/bin:/mnt/c/Windows/system32"),
            ("osid", "ubuntu"),
            ("version", "git version 2.55.0"),
            ("gitfs", "ef53:fedc9aa3bd65bc57"),
            ("gitfile", "43750:4066232:1751487822"),
            ("selfs", "ef53:fedc9aa3bd65bc57"),
            ("selino", "123456"),
            ("selstat", "ok"),
            ("scope", "0"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        for (key, value) in change {
            match value {
                Some(value) => match lines.iter_mut().find(|(k, _)| k == key) {
                    Some(line) => line.1 = value.to_string(),
                    None => lines.push((key.to_string(), value.to_string())),
                },
                None => lines.retain(|(k, _)| k != key),
            }
        }
        lines.iter().map(|(k, v)| format!("{k} {v}\n")).collect()
    }

    fn bound(change: &[(&str, Option<&str>)]) -> Option<Bound> {
        bind_probe("Ubuntu-24.04", GUID, probe_output(change).as_bytes())
    }

    #[test]
    fn a_probe_that_passes_every_section_11_rule_binds_the_installation_version_and_git_identity() {
        let bound = bound(&[]).expect("bound");
        assert_eq!(
            bound.installation,
            Installation {
                distro: "Ubuntu-24.04".to_string(),
                guid: GUID.to_string(),
                git: "/usr/bin/git".to_string(),
                systemd_run: "/usr/bin/systemd-run".to_string(),
                systemctl: "/usr/bin/systemctl".to_string(),
                setsid: "/usr/bin/setsid".to_string(),
                sha256sum: "/usr/bin/sha256sum".to_string(),
            }
        );
        assert_eq!(bound.version, "2.55.0");
        assert_eq!(
            bound.git_identity,
            GitIdentity {
                file_system_id: "fedc9aa3bd65bc57".to_string(),
                inode: "43750".to_string(),
                size: "4066232".to_string(),
                modified: "1751487822".to_string(),
            }
        );
    }

    #[test]
    fn the_probe_parse_accepts_an_osid_line_in_any_os_release_form_and_without_one() {
        for osid in [
            Some("ubuntu"),
            Some("\"ubuntu\""),
            Some("debian"),
            Some(""),
            None,
        ] {
            assert!(bound(&[("osid", osid)]).is_some(), "{osid:?}");
        }
    }

    #[test]
    fn a_probe_that_fails_a_section_11_rule_binds_nothing() {
        let refused: &[&[(&str, Option<&str>)]] = &[
            &[("path git", None)],
            &[("path setsid", None)],
            &[("path stat", None)],
            &[("path env", None)],
            &[("path systemctl", None)],
            &[("magic git", Some("MZ"))],
            &[("magic setsid", Some("MZ"))],
            &[("path git", Some("/mnt/c/Git/cmd/git.exe"))],
            &[("path systemd-run", Some("relative/systemd-run"))],
            &[("scope", Some("1"))],
            &[("scope", None)],
            &[("version", Some("git version 2.43.0"))],
            &[("version", Some("git version 2.55.0.windows.1"))],
            &[("version", Some("git version two"))],
            &[("gitfs", Some("1021994:9a8b7c6d5e4f3021"))],
            &[("gitfile", None)],
            &[("unknown", Some("line"))],
            &[("osid", Some("ubuntu\nversion git version 9.0.0"))],
            // gaps.md W1: the context path lines.
            &[("selfs", None)],
            &[("selfs", Some("ef53"))],
            &[("selfs", Some("EF53:fedc9aa3bd65bc57"))],
            &[("selfs", Some("ef53:0fedc9aa3bd65bc57"))],
            &[("selino", None)],
            &[("selino", Some("0042"))],
            &[("selino", Some("18446744073709551616"))],
            &[("selstat", Some("error"))],
            &[("selstat", Some("absent"))],
            &[("selstat", None)],
            // gaps.md W3: `/usr/bin/perl`.
            &[("path perl", None)],
            &[("magic perl", Some("MZ"))],
            // T325: `/usr/bin/sha256sum` (contract §11 "Git per distro").
            &[("path sha256sum", None)],
            &[("magic sha256sum", Some("MZ"))],
            &[("path sha256sum", Some("/mnt/c/Tools/sha256sum.exe"))],
            &[("absent", Some("sha256sum"))],
            // A program is either absent or found, never both.
            &[("absent", Some("perl"))],
            &[("absent", Some("git"))],
            &[("path setsid", None), ("absent", Some("setsid"))],
        ];
        for change in refused.iter().copied() {
            assert!(bound(change).is_none(), "{change:?}");
        }
        // A repeated line binds nothing, so an embedded line end cannot replace a fact.
        let doubled = format!("{}version git version 3.0.0\n", probe_output(&[]));
        assert!(bind_probe("Ubuntu-24.04", GUID, doubled.as_bytes()).is_none());
        // Strict UTF-8 (contract §11 "Distro checks").
        let mut bytes = probe_output(&[]).into_bytes();
        bytes.extend_from_slice(b"osid \xff\n");
        assert!(bind_probe("Ubuntu-24.04", GUID, &bytes).is_none());
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
        let found = identities(
            &reference.host(),
            &inst,
            operation,
            1,
            &strings(&["/"]),
            &environment,
            None,
        );
        match found[0].clone() {
            Ok(found) => {
                println!("OBSERVATION T212: identity of / {}", found.reply());
                assert_eq!(found.inode, "2");
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
