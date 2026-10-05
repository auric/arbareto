// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};
use windows::Win32::Foundation::{
    CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows::Win32::Security::Cryptography::{
    BCRYPT_SHA256_ALG_HANDLE, BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom, BCryptHash,
};
use windows::Win32::Storage::FileSystem::{
    DELETE, FILE_DISPOSITION_INFO, FILE_RENAME_INFO, FILE_SHARE_READ, FileDispositionInfo,
    FileRenameInfo, SetFileInformationByHandle,
};
use windows::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};
use windows::core::HSTRING;

use crate::bootstrap::{Identity, read_identity};
use crate::process_requests::{VERSION_BYTES, is_identifier, path};
use crate::schema;

// ---- Settings file (data-model §1) ----

/// The native settings. A missing or invalid entry is `None`, its documented default. This slice has no migration.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Settings {
    pub git: Option<SavedGit>,
    /// The last explicitly opened repository.
    pub last_repository: Option<PathBuf>,
    /// The window bounds in DIPs.
    pub window: Option<Bounds>,
    /// The approved Linux Git of each distro GUID, beside the Windows Git (contract §11 "Git per distro").
    pub wsl_gits: Vec<SavedWslGit>,
}

/// One approved WSL Git. A later probe with another identity gives `GIT_CHANGED`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SavedWslGit {
    /// The registration key name, such as `{c6d24ae9-40f2-40bf-b35d-bf0b6ca4ea00}`.
    pub guid: String,
    pub distro: String,
    /// The absolute Linux path of the approved Git.
    pub git: String,
    pub version: String,
    /// `<file-system ID>:<inode>:<size>:<modification time>` of the Git file (contract §11 "Git per distro").
    pub identity: String,
}

/// Use this Git replaces the entry of the same distro GUID.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "T212 wires the WSL register frame")
)]
pub fn remember_wsl_git(settings: &mut Settings, git: SavedWslGit) {
    settings.wsl_gits.retain(|saved| saved.guid != git.guid);
    settings.wsl_gits.push(git);
}

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "T212 wires the WSL register frame")
)]
pub fn saved_wsl_git<'a>(settings: &'a Settings, guid: &str) -> Option<&'a SavedWslGit> {
    settings.wsl_gits.iter().find(|saved| saved.guid == guid)
}

fn is_version(text: &str) -> bool {
    text.len() <= VERSION_BYTES && text.bytes().all(|b| (0x20..0x7f).contains(&b))
}

/// The registry form of a GUID: braces around 8, 4, 4, 4, and 12 hex digits.
fn is_guid(text: &str) -> bool {
    let Some(inner) = text.strip_prefix('{').and_then(|t| t.strip_suffix('}')) else {
        return false;
    };
    let groups: Vec<&str> = inner.split('-').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(group, length)| {
            group.len() == length && group.bytes().all(|b| b.is_ascii_hexdigit())
        })
}

fn is_git_identity(text: &str) -> bool {
    let parts: Vec<&str> = text.split(':').collect();
    let digits = |part: &str, hex: bool| {
        !part.is_empty()
            && part
                .bytes()
                .all(|b| b.is_ascii_digit() || (hex && matches!(b, b'a'..=b'f')))
    };
    parts.len() == 4 && digits(parts[0], true) && parts[1..].iter().all(|part| digits(part, false))
}

fn saved_wsl_gits(value: &Value) -> Vec<SavedWslGit> {
    let mut gits: Vec<SavedWslGit> = Vec::new();
    for entry in value.as_array().map(Vec::as_slice).unwrap_or_default() {
        let text = |key: &str| entry[key].as_str();
        let (Some(guid), Some(distro), Some(git), Some(version), Some(identity)) = (
            text("guid"),
            text("distro"),
            text("git"),
            text("version"),
            text("identity"),
        ) else {
            continue;
        };
        let valid = is_guid(guid)
            && !distro.is_empty()
            && !distro.chars().any(char::is_control)
            && git.starts_with('/')
            && !git.chars().any(char::is_control)
            && is_version(version)
            && is_git_identity(identity);
        if valid && !gits.iter().any(|saved| saved.guid == guid) {
            gits.push(SavedWslGit {
                guid: guid.to_string(),
                distro: distro.to_string(),
                git: git.to_string(),
                version: version.to_string(),
                identity: identity.to_string(),
            });
        }
    }
    gits
}

/// The selected Git. Unknown or invalid values give no saved Git.
#[derive(Clone, Debug, PartialEq)]
pub struct SavedGit {
    /// The absolute path that the user selected, such as the Git for Windows wrapper `cmd\git.exe`.
    pub selected_path: PathBuf,
    /// The absolute path of the file that runs: `git.exe` in the folder that `--exec-path` printed (contract §3 "Git proposal").
    pub executable_path: PathBuf,
    /// The approved parsed version text: printable ASCII, at most 64 bytes (contract §6 "Context rules").
    pub version: String,
    /// The SHA-256 of the executable: 64 lowercase hex digits.
    pub digest: String,
}

/// A rectangle in DIPs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// The native minimum window size (plan.md "Chosen layout, sizes, and DPI").
pub const MINIMUM_SIZE: (i32, i32) = (720, 480);

/// The size without stored bounds: the normal measurement workspace (plan.md "Chosen layout, sizes, and DPI").
pub const DEFAULT_SIZE: (i32, i32) = (1280, 800);

/// The work area cannot fit `MINIMUM_SIZE`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InsufficientWorkArea;

/// Reads the settings file. A missing, unreadable, or unparseable file gives `Settings::default()`.
pub fn load(path: &Path) -> Settings {
    let file = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let Some(Value::Object(file)) = file else {
        return Settings::default();
    };
    Settings {
        git: file.get("git").and_then(saved_git),
        last_repository: file.get("lastRepository").and_then(channel_path),
        window: file.get("window").and_then(bounds),
        wsl_gits: file.get("wslGits").map(saved_wsl_gits).unwrap_or_default(),
    }
}

fn saved_git(value: &Value) -> Option<SavedGit> {
    let version = value["version"]
        .as_str()
        .filter(|version| is_version(version))?;
    let digest = value["digest"]
        .as_str()
        .filter(|digest| is_hex(digest, 64))?;
    let executable_path = channel_path(&value["executablePath"])?;
    // A file from before `selectedPath` existed holds only the resolved path.
    let selected_path = match value.get("selectedPath") {
        Some(selected) => channel_path(selected)?,
        None => executable_path.clone(),
    };
    Some(SavedGit {
        selected_path,
        executable_path,
        version: version.to_string(),
        digest: digest.to_string(),
    })
}

fn bounds(value: &Value) -> Option<Bounds> {
    let number = |key: &str| value[key].as_i64().and_then(|n| i32::try_from(n).ok());
    Some(Bounds {
        x: number("x")?,
        y: number("y")?,
        width: number("width")?,
        height: number("height")?,
    })
}

/// Replaces the whole file. A failed write leaves the previous file.
pub fn save(path: &Path, settings: &Settings) -> std::io::Result<()> {
    save_with(path, settings, None)
}

fn save_with(path: &Path, settings: &Settings, fault: Fault) -> io::Result<()> {
    let mut file = Map::new();
    if let Some(git) = &settings.git {
        file.insert(
            "git".to_string(),
            json!({
                "selectedPath": text(&git.selected_path)?,
                "executablePath": text(&git.executable_path)?,
                "version": git.version,
                "digest": git.digest,
            }),
        );
    }
    if let Some(repository) = &settings.last_repository {
        file.insert("lastRepository".to_string(), json!(text(repository)?));
    }
    if let Some(window) = settings.window {
        file.insert(
            "window".to_string(),
            json!({ "x": window.x, "y": window.y, "width": window.width, "height": window.height }),
        );
    }
    if !settings.wsl_gits.is_empty() {
        let gits: Vec<Value> = settings
            .wsl_gits
            .iter()
            .map(|git| {
                json!({
                    "guid": git.guid,
                    "distro": git.distro,
                    "git": git.git,
                    "version": git.version,
                    "identity": git.identity,
                })
            })
            .collect();
        file.insert("wslGits".to_string(), Value::Array(gits));
    }
    write_file(
        path,
        Value::Object(file).to_string().as_bytes(),
        true,
        fault,
    )
    .map(drop)
}

/// Clamps the stored bounds, or `DEFAULT_SIZE` without them, into `work_area` (plan.md "Chosen layout, sizes, and DPI").
pub fn clamp(stored: Option<Bounds>, work_area: Bounds) -> Result<Bounds, InsufficientWorkArea> {
    let (minimum_width, minimum_height) = MINIMUM_SIZE;
    if work_area.width < minimum_width || work_area.height < minimum_height {
        return Err(InsufficientWorkArea);
    }
    let placed = match stored {
        Some(stored) => Bounds {
            width: stored.width.clamp(minimum_width, work_area.width),
            height: stored.height.clamp(minimum_height, work_area.height),
            ..stored
        },
        None => {
            let width = DEFAULT_SIZE.0.min(work_area.width);
            let height = DEFAULT_SIZE.1.min(work_area.height);
            Bounds {
                x: work_area.x + (work_area.width - width) / 2,
                y: work_area.y + (work_area.height - height) / 2,
                width,
                height,
            }
        }
    };
    Ok(Bounds {
        x: placed
            .x
            .clamp(work_area.x, work_area.x + work_area.width - placed.width),
        y: placed
            .y
            .clamp(work_area.y, work_area.y + work_area.height - placed.height),
        ..placed
    })
}

// ---- Injected write faults ----

/// The write step that an injected fault fails.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Write,
    Flush,
}

type Fault = Option<(Stage, i32)>;

fn inject(fault: Fault, stage: Stage) -> io::Result<()> {
    match fault {
        Some((at, os_error)) if at == stage => Err(io::Error::from_raw_os_error(os_error)),
        _ => Ok(()),
    }
}

// ---- File writes ----

/// Writes `bytes` to a new temporary file beside `target`, flushes it, and renames it to `target` through the same handle.
/// The returned handle shares only reading, so no other process can delete, rename, or write the file while it is open.
/// On failure, the temporary file goes and `target` stays unchanged.
fn write_file(target: &Path, bytes: &[u8], replace: bool, fault: Fault) -> io::Result<File> {
    // ponytail: a crash between create and rename leaves the `.tmp` file; no scan reads it.
    let temporary = target.with_file_name(format!("{}.tmp", random_id()?));
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .access_mode(GENERIC_READ.0 | GENERIC_WRITE.0 | DELETE.0)
        .share_mode(FILE_SHARE_READ.0)
        .open(&temporary)?;
    let written = inject(fault, Stage::Write)
        .and_then(|()| file.write_all(bytes))
        .and_then(|()| inject(fault, Stage::Flush))
        .and_then(|()| file.sync_all())
        .and_then(|()| rename(&file, target, replace));
    match written {
        Ok(()) => Ok(file),
        Err(error) => {
            let _ = delete(&file);
            Err(error)
        }
    }
}

/// Renames the open file. Its handle needs `DELETE` access.
fn rename(file: &File, target: &Path, replace: bool) -> io::Result<()> {
    let name: Vec<u16> = std::path::absolute(target)?
        .as_os_str()
        .encode_wide()
        .collect();
    let name_bytes = name.len() * size_of::<u16>();
    let size = size_of::<FILE_RENAME_INFO>() + name_bytes;
    // `u64` units give the structure its 8-byte alignment.
    let mut buffer = vec![0u64; size.div_ceil(size_of::<u64>())];
    let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    // SAFETY: `buffer` is zeroed, aligned, and holds the structure and the name. The handle stays open for the call.
    unsafe {
        (*info).Anonymous.ReplaceIfExists = replace;
        (*info).FileNameLength = name_bytes as u32;
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            (&raw mut (*info).FileName).cast::<u16>(),
            name.len(),
        );
        SetFileInformationByHandle(
            HANDLE(file.as_raw_handle()),
            FileRenameInfo,
            info.cast_const().cast(),
            (buffer.len() * size_of::<u64>()) as u32,
        )
    }
    .map_err(io::Error::other)
}

/// Marks the open file for deletion. The file goes when its last handle closes. The handle needs `DELETE` access.
fn delete(file: &File) -> io::Result<()> {
    let info = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: `info` is a live local of the passed size, and the handle stays open for the call.
    unsafe {
        SetFileInformationByHandle(
            HANDLE(file.as_raw_handle()),
            FileDispositionInfo,
            (&raw const info).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    }
    .map_err(io::Error::other)
}

/// Opens an existing file without sharing, as contract §6 "Recovery markers" requires, and reads at most `limit` + 1 bytes.
fn open_exclusive(path: &Path, limit: usize) -> io::Result<(File, Vec<u8>)> {
    let file = OpenOptions::new()
        .read(true)
        .access_mode(GENERIC_READ.0 | DELETE.0)
        .share_mode(0)
        .open(path)?;
    let mut bytes = Vec::new();
    (&file).take(limit as u64 + 1).read_to_end(&mut bytes)?;
    Ok((file, bytes))
}

/// Reads at most `limit` + 1 bytes with full sharing.
fn read_bounded(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// The `.json` files of `folder`. A missing folder has none.
fn json_files(folder: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let stem = name.strip_suffix(".json")?.to_string();
            Some((stem, entry.path()))
        })
        .collect()
}

/// The failure class of contract §6 "Channel frames".
fn failure_class(error: &io::Error) -> &'static str {
    match error.kind() {
        io::ErrorKind::StorageFull => "disk-full",
        io::ErrorKind::PermissionDenied => "access-denied",
        _ => "other",
    }
}

fn text(path: &Path) -> io::Result<&str> {
    path.to_str()
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidData))
}

// ---- Shared value rules ----

pub(crate) fn is_hex(text: &str, digits: usize) -> bool {
    text.len() == digits
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A channel path (contract §6 "Channel frames"), with the rule of every path key in a channel frame.
fn channel_path(value: &Value) -> Option<PathBuf> {
    path(value).ok()
}

/// An identity reply (contract §6 "Process fields").
fn identity(value: &Value) -> Option<Identity> {
    let object = value.as_object().filter(|object| object.len() == 2)?;
    let serial = object
        .get("volumeSerial")?
        .as_str()
        .filter(|serial| is_hex(serial, 16))?;
    let id = object.get("fileId")?.as_str().filter(|id| is_hex(id, 32))?;
    let mut file_id = [0; 16];
    for (i, byte) in file_id.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&id[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(Identity {
        volume_serial: u64::from_str_radix(serial, 16).ok()?,
        file_id,
    })
}

/// The identity text `volumeSerial` then `fileId`, as the identity reply writes them, without a separator.
fn identity_text(identity: &Identity) -> String {
    format!("{:016x}{}", identity.volume_serial, hex(&identity.file_id))
}

/// A UTC time in RFC 3339 form, as `src/contracts/channel.ts` `UtcTime` checks it. Returns the sort key.
pub(crate) fn utc_time(text: &str) -> Option<(&str, u32)> {
    let b = text.as_bytes();
    if b.len() < 20
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let number = |at: usize, digits: usize| -> Option<u32> {
        let part = &b[at..at + digits];
        part.iter()
            .all(u8::is_ascii_digit)
            .then(|| part.iter().fold(0, |n, d| n * 10 + u32::from(d - b'0')))
    };
    let (year, month, day) = (number(0, 4)?, number(5, 2)?, number(8, 2)?);
    let (hour, minute, second) = (number(11, 2)?, number(14, 2)?, number(17, 2)?);
    let nanos = match text[19..].strip_suffix('Z')? {
        "" => 0,
        fraction => {
            let digits = fraction.strip_prefix('.')?;
            if digits.is_empty() || !digits.bytes().all(|d| d.is_ascii_digit()) {
                return None;
            }
            let kept = &digits[..digits.len().min(9)];
            kept.parse::<u32>().ok()? * 10u32.pow(9 - kept.len() as u32)
        }
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    // `Date.UTC` maps the years 0 to 99 to 1900 to 1999, so the service refuses them. RFC 3339 §5.6 permits the leap second 60.
    let valid = year >= 100
        && (1..=12).contains(&month)
        && (1..=days[month as usize - 1]).contains(&day)
        && hour < 24
        && minute < 60
        && second <= 60;
    valid.then_some((&text[..19], nanos))
}

/// The current UTC time in RFC 3339 form with nanoseconds.
fn utc_now() -> String {
    let since = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = since.as_secs();
    let (year, month, day) = civil_from_days((seconds / 86_400) as i64);
    let time = seconds % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:09}Z",
        time / 3600,
        time / 60 % 60,
        time % 60,
        since.subsec_nanos()
    )
}

/// Howard Hinnant, "chrono-Compatible Low-Level Date Algorithms", `civil_from_days`: days since 1970-01-01 to a civil date.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

/// The SHA-256 of `bytes` through Windows CNG.
pub(crate) fn sha256(bytes: &[u8]) -> [u8; 32] {
    let mut digest = [0; 32];
    // SAFETY: the pseudo handle needs no open or close, and both slices are live.
    let status = unsafe { BCryptHash(BCRYPT_SHA256_ALG_HANDLE, None, bytes, &mut digest) };
    // The SHA-256 pseudo handle exists from Windows 10, and the output has the SHA-256 size, so no failure applies.
    assert!(status.is_ok(), "BCryptHash SHA-256: {status:?}");
    digest
}

/// A random UUID-shaped version 4 identifier from the system RNG.
fn random_id() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    // SAFETY: `bytes` is a live local.
    let status = unsafe { BCryptGenRandom(None, &mut bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
    if status.is_err() {
        return Err(io::Error::other(format!("BCryptGenRandom: {status:?}")));
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let h = hex(&bytes);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    ))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---- Recovery markers (contract §6 "Recovery markers") ----

/// At most 4 KiB per marker file (contract §5).
pub const MARKER_BYTES: usize = 4096;
/// At most 64 markers per handshake (contract §5).
pub const MARKER_LIMIT: usize = 64;

/// The mutation names of contract §3, as `src/contracts/operations.ts` `MUTATIONS` lists them.
pub(crate) const MUTATIONS: [&str; 4] = ["applyHunk", "applyFile", "commit", "updateSubmodules"];

/// One recovery marker. Its file is `<markerId>.json` in the `recovery` folder and holds the handshake form.
#[derive(Clone, Debug, PartialEq)]
pub struct Marker {
    pub marker_id: String,
    /// One mutation name of contract §3.
    pub kind: String,
    /// A UTC time in RFC 3339 form.
    pub started_at: String,
    pub worktree_root: PathBuf,
    pub common_directory: PathBuf,
    pub common_identity: Identity,
}

impl Marker {
    /// The handshake form: exactly `markerId`, `kind`, `startedAt`, `worktreeRoot`, `commonDirectory`, and `commonIdentity`.
    pub fn handshake(&self) -> Value {
        json!({
            "markerId": self.marker_id,
            "kind": self.kind,
            "startedAt": self.started_at,
            "worktreeRoot": self.worktree_root.to_string_lossy(),
            "commonDirectory": self.common_directory.to_string_lossy(),
            "commonIdentity": self.common_identity.reply(),
        })
    }

    /// The handshake form as `src/contracts/channel.ts` `Marker` checks it. Another value would fail the whole handshake.
    fn parse(value: &Value) -> Option<Marker> {
        let object = value.as_object().filter(|object| object.len() == 6)?;
        let field = |key: &str| object.get(key).and_then(Value::as_str);
        Some(Marker {
            marker_id: field("markerId")
                .filter(|id| is_identifier(id))?
                .to_string(),
            kind: field("kind")
                .filter(|kind| MUTATIONS.contains(kind))?
                .to_string(),
            started_at: field("startedAt")
                .filter(|time| utc_time(time).is_some())?
                .to_string(),
            worktree_root: channel_path(object.get("worktreeRoot")?)?,
            common_directory: channel_path(object.get("commonDirectory")?)?,
            common_identity: identity(object.get("commonIdentity")?)?,
        })
    }
}

/// A marker file that the scan cannot load (contract §6 "Damaged markers").
#[derive(Clone, Debug, PartialEq)]
pub struct Damaged {
    /// Issued by the shell. The file name need not hold an ID.
    pub marker_id: String,
    pub file_name: String,
}

impl Damaged {
    /// The handshake form: exactly `markerId` and `fileName`.
    pub fn handshake(&self) -> Value {
        json!({ "markerId": self.marker_id, "fileName": self.file_name })
    }
}

/// The `started` mutation frame (contract §6 "Channel frames").
pub struct Started<'a> {
    pub operation_id: &'a str,
    pub kind: &'a str,
    pub worktree_root: &'a Path,
    pub common_directory: &'a Path,
}

#[derive(Debug, PartialEq)]
pub enum StartedReply {
    /// `identity` is the common-directory identity that named the mutex.
    Marker {
        marker_id: String,
        identity: Identity,
    },
    Busy,
    /// `failure` is `disk-full`, `access-denied`, or `other`. `folder` is the `recovery` folder.
    Failure {
        failure: &'static str,
        folder: PathBuf,
    },
}

impl StartedReply {
    pub fn reply(&self, call_id: &str) -> Value {
        match self {
            StartedReply::Marker { marker_id, .. } => {
                json!({ "type": "started", "callId": call_id, "markerId": marker_id })
            }
            StartedReply::Busy => json!({ "type": "started", "callId": call_id, "busy": true }),
            StartedReply::Failure { failure, folder } => json!({
                "type": "started",
                "callId": call_id,
                "failure": failure,
                "folder": folder.to_string_lossy(),
            }),
        }
    }
}

/// The markers of one handshake scan.
#[derive(Debug, PartialEq)]
pub struct Scan {
    pub markers: Vec<Marker>,
    /// The marker files above the 64-marker limit. A nonzero count is the limit result.
    pub unloaded: u32,
    /// At most 64, in file-name order.
    pub damaged: Vec<Damaged>,
}

/// The name `Local\Arbareto-mutation-<SHA-256 of the identity>` (contract §6 "Recovery markers").
pub fn mutex_name(identity: &Identity) -> String {
    format!(
        "Local\\Arbareto-mutation-{}",
        hex(&sha256(identity_text(identity).as_bytes()))
    )
}

enum Taken {
    Yes,
    Busy,
    Failed,
}

enum Command {
    Take {
        operation_id: String,
        name: String,
        reply: Sender<Taken>,
    },
    /// `None` releases every held mutex.
    Release {
        operation_id: Option<String>,
        done: Sender<()>,
    },
}

/// A Windows mutex belongs to the thread that takes it, so this one thread takes and releases every mutex.
fn mutex_thread(commands: Receiver<Command>) {
    let mut held: HashMap<String, (String, HANDLE)> = HashMap::new();
    for command in commands {
        match command {
            Command::Take {
                operation_id,
                name,
                reply,
            } => {
                // This thread owns a held mutex already, and a second wait would succeed at once.
                let taken = if held.contains_key(&operation_id)
                    || held.values().any(|(held_name, _)| *held_name == name)
                {
                    Taken::Busy
                } else {
                    take_mutex(&name).map_or(Taken::Failed, |handle| match handle {
                        Some(handle) => {
                            held.insert(operation_id, (name, handle));
                            Taken::Yes
                        }
                        None => Taken::Busy,
                    })
                };
                let _ = reply.send(taken);
            }
            Command::Release { operation_id, done } => {
                let released: Vec<String> = match operation_id {
                    Some(operation_id) => vec![operation_id],
                    None => held.keys().cloned().collect(),
                };
                for operation_id in released {
                    if let Some((_, handle)) = held.remove(&operation_id) {
                        release_mutex(handle);
                    }
                }
                let _ = done.send(());
            }
        }
    }
    for (_, handle) in held.into_values() {
        release_mutex(handle);
    }
}

/// Takes the named mutex without waiting. `WAIT_ABANDONED` counts as taken. `Ok(None)` means that another owner holds it.
fn take_mutex(name: &str) -> Result<Option<HANDLE>, ()> {
    // SAFETY: the name is a live HSTRING for the call.
    let handle = unsafe { CreateMutexW(None, false, &HSTRING::from(name)) }.map_err(drop)?;
    // SAFETY: `handle` is a live mutex handle.
    let wait = unsafe { WaitForSingleObject(handle, 0) };
    if wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED {
        return Ok(Some(handle));
    }
    // SAFETY: `handle` is live, and this thread does not own the mutex.
    let _ = unsafe { CloseHandle(handle) };
    if wait == WAIT_TIMEOUT {
        Ok(None)
    } else {
        Err(())
    }
}

fn release_mutex(handle: HANDLE) {
    // SAFETY: this thread owns the mutex, and `handle` is live until the close.
    unsafe {
        let _ = ReleaseMutex(handle);
        let _ = CloseHandle(handle);
    }
}

/// A marker file that this shell owns. The open handle denies delete sharing (contract §6 "Recovery markers").
struct Owned {
    file: File,
    marker: Marker,
}

struct MarkerState {
    owned: HashMap<String, Owned>,
    /// Keyed by the shell-issued `markerId`. The open handle denies delete sharing, as for an owned marker.
    damaged: HashMap<String, (Damaged, File)>,
    fault: Fault,
}

/// The marker store of the `recovery` folder. One dedicated thread takes and releases every mutex.
pub struct Markers {
    folder: PathBuf,
    state: Mutex<MarkerState>,
    mutexes: Option<Sender<Command>>,
    thread: Option<JoinHandle<()>>,
}

impl Markers {
    /// Creates the folder when it is absent.
    pub fn open(folder: &Path) -> Markers {
        let _ = std::fs::create_dir_all(folder);
        let (sender, receiver) = mpsc::channel();
        Markers {
            folder: folder.to_path_buf(),
            state: Mutex::new(MarkerState {
                owned: HashMap::new(),
                damaged: HashMap::new(),
                fault: None,
            }),
            mutexes: Some(sender),
            thread: Some(std::thread::spawn(move || mutex_thread(receiver))),
        }
    }

    fn take(&self, operation_id: &str, name: String) -> Taken {
        let (reply, taken) = mpsc::channel();
        let command = Command::Take {
            operation_id: operation_id.to_string(),
            name,
            reply,
        };
        match self.mutexes.as_ref().map(|mutexes| mutexes.send(command)) {
            Some(Ok(())) => taken.recv().unwrap_or(Taken::Failed),
            _ => Taken::Failed,
        }
    }

    fn release(&self, operation_id: Option<&str>) {
        let (done, released) = mpsc::channel();
        let command = Command::Release {
            operation_id: operation_id.map(str::to_string),
            done,
        };
        if let Some(Ok(())) = self.mutexes.as_ref().map(|mutexes| mutexes.send(command)) {
            let _ = released.recv();
        }
    }

    pub fn started(&self, request: &Started) -> StartedReply {
        let failure = |failure| StartedReply::Failure {
            failure,
            folder: self.folder.clone(),
        };
        let Ok(identity) = read_identity(request.common_directory) else {
            return failure("other");
        };
        match self.take(request.operation_id, mutex_name(&identity)) {
            Taken::Yes => {}
            Taken::Busy => return StartedReply::Busy,
            Taken::Failed => return failure("other"),
        }
        match self.write(request, identity) {
            Ok(marker_id) => StartedReply::Marker {
                marker_id,
                identity,
            },
            Err(error) => {
                self.release(Some(request.operation_id));
                failure(failure_class(&error))
            }
        }
    }

    fn write(&self, request: &Started, identity: Identity) -> io::Result<String> {
        let marker = Marker {
            marker_id: random_id()?,
            kind: request.kind.to_string(),
            started_at: utc_now(),
            worktree_root: request.worktree_root.to_path_buf(),
            common_directory: request.common_directory.to_path_buf(),
            common_identity: identity,
        };
        let form = marker.handshake();
        let bytes = form.to_string().into_bytes();
        // The next scan would list a marker that it cannot load as damaged (contract §6 "Damaged markers").
        if bytes.len() > MARKER_BYTES || Marker::parse(&form).as_ref() != Some(&marker) {
            return Err(io::Error::from(io::ErrorKind::InvalidData));
        }
        let mut state = lock(&self.state);
        let target = self.folder.join(format!("{}.json", marker.marker_id));
        let file = write_file(&target, &bytes, false, state.fault.take())?;
        let marker_id = marker.marker_id.clone();
        state
            .owned
            .insert(marker_id.clone(), Owned { file, marker });
        Ok(marker_id)
    }

    /// Releases the mutex of the operation. The marker file stays.
    pub fn ended(&self, operation_id: &str) {
        self.release(Some(operation_id));
    }

    /// Releases every mutex after a service exit, when the operation Jobs close. The marker files stay.
    pub fn service_exited(&self) {
        self.release(None);
    }

    /// Deletes the marker file.
    pub fn resolved(&self, marker_id: &str) {
        let mut state = lock(&self.state);
        if let Some(owned) = state.owned.remove(marker_id)
            && delete(&owned.file).is_err()
        {
            state.owned.insert(marker_id.to_string(), owned);
        }
    }

    /// Rescans the folder. Takes ownership of each file that no running instance holds.
    pub fn scan(&self) -> Scan {
        let mut state = lock(&self.state);
        let mut unloaded = 0;
        let mut found = HashSet::new();
        let mut files = json_files(&self.folder);
        // File-name order decides which 64 damaged files the scan lists.
        files.sort_by(|a, b| a.1.cmp(&b.1));
        for (stem, path) in files {
            let file_name = format!("{stem}.json");
            if state.owned.contains_key(&stem)
                || state
                    .damaged
                    .values()
                    .any(|(damaged, _)| damaged.file_name == file_name)
            {
                continue;
            }
            // A sharing violation means that a running instance owns the file. Another failure skips the file until the next scan.
            let Ok((file, bytes)) = open_exclusive(&path, MARKER_BYTES) else {
                continue;
            };
            let marker = (bytes.len() <= MARKER_BYTES)
                .then(|| serde_json::from_slice::<Value>(&bytes).ok())
                .flatten()
                .and_then(|value| Marker::parse(&value))
                .filter(|marker| marker.marker_id == stem);
            match marker {
                Some(marker) => {
                    found.insert(stem.clone());
                    state.owned.insert(stem, Owned { file, marker });
                }
                None if state.damaged.len() < MARKER_LIMIT => {
                    if let Ok(marker_id) = random_id() {
                        let damaged = Damaged {
                            marker_id: marker_id.clone(),
                            file_name,
                        };
                        state.damaged.insert(marker_id, (damaged, file));
                    }
                }
                // Above 64 damaged files, the handle closes, and a later scan lists the file.
                None => {}
            }
        }
        let mut markers: Vec<Marker> = state
            .owned
            .values()
            .map(|owned| owned.marker.clone())
            .collect();
        markers.sort_by(|a, b| {
            (utc_time(&a.started_at), &a.marker_id).cmp(&(utc_time(&b.started_at), &b.marker_id))
        });
        // Above the limit, the shell loads the 64 oldest markers (contract §5).
        for newer in markers.split_off(markers.len().min(MARKER_LIMIT)) {
            unloaded += 1;
            if found.contains(&newer.marker_id) {
                state.owned.remove(&newer.marker_id);
            }
        }
        let mut damaged: Vec<Damaged> = state
            .damaged
            .values()
            .map(|(damaged, _)| damaged.clone())
            .collect();
        damaged.sort_by(|a, b| a.file_name.cmp(&b.file_name));
        Scan {
            markers,
            unloaded,
            damaged,
        }
    }

    /// The damaged marker with this ID.
    pub fn damaged(&self, marker_id: &str) -> Option<Damaged> {
        lock(&self.state)
            .damaged
            .get(marker_id)
            .map(|(damaged, _)| damaged.clone())
    }

    /// Deletes the damaged file only when `confirm` accepts. Returns true when the file is deleted.
    pub fn dismiss_damaged(&self, marker_id: &str, confirm: impl FnOnce(&Damaged) -> bool) -> bool {
        let Some(damaged) = self.damaged(marker_id) else {
            return false;
        };
        // The confirmation is a native dialog, so the store stays unlocked while it shows.
        if !confirm(&damaged) {
            return false;
        }
        let mut state = lock(&self.state);
        let Some((damaged, file)) = state.damaged.remove(marker_id) else {
            return false;
        };
        if delete(&file).is_ok() {
            return true;
        }
        state.damaged.insert(marker_id.to_string(), (damaged, file));
        false
    }

    /// The owned marker with this ID.
    pub fn get(&self, marker_id: &str) -> Option<Marker> {
        lock(&self.state)
            .owned
            .get(marker_id)
            .map(|owned| owned.marker.clone())
    }

    /// Deletes the marker file only when `confirm` accepts. Returns true when the file is deleted.
    pub fn dismiss(&self, marker_id: &str, confirm: impl FnOnce(&Marker) -> bool) -> bool {
        let Some(marker) = lock(&self.state)
            .owned
            .get(marker_id)
            .map(|owned| owned.marker.clone())
        else {
            return false;
        };
        // The confirmation is a native dialog, so the store stays unlocked while it shows.
        if !confirm(&marker) {
            return false;
        }
        let mut state = lock(&self.state);
        let Some(owned) = state.owned.remove(marker_id) else {
            return false;
        };
        if delete(&owned.file).is_ok() {
            return true;
        }
        state.owned.insert(marker_id.to_string(), owned);
        false
    }

    /// Fails the next marker write at `stage` with the OS error code `os_error`.
    #[cfg_attr(not(test), expect(dead_code, reason = "test hook"))]
    pub fn fail_next(&self, stage: Stage, os_error: i32) {
        lock(&self.state).fault = Some((stage, os_error));
    }
}

impl Drop for Markers {
    fn drop(&mut self) {
        // The closed channel ends the mutex thread, and the thread releases each held mutex.
        self.mutexes.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

// ---- Trust records (contract §7 "Trust approval store") ----

/// At most 4 KiB per record (contract §5).
pub const TRUST_RECORD_BYTES: usize = 4096;
/// At most 256 records. A new record above 256 replaces the oldest (contract §5).
pub const TRUST_RECORD_LIMIT: usize = 256;

/// The `confirm` trust frame (contract §6 "Channel frames").
#[derive(Clone, Debug, PartialEq)]
pub struct Confirm {
    pub worktree_root: PathBuf,
    pub git_directory: PathBuf,
    pub common_directory: PathBuf,
    pub git_selected_path: PathBuf,
    pub fingerprint: String,
    pub persist: bool,
    /// `file-count`, `file-bytes`, or `total-bytes`. Present only with `persist: false`.
    pub bound: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum Confirmed {
    /// `record` is the stored record in the handshake form. `None` means `stored: false`.
    Approved {
        record: Option<Value>,
    },
    Declined,
}

impl Confirmed {
    pub fn reply(&self, call_id: &str) -> Value {
        match self {
            Confirmed::Approved {
                record: Some(record),
            } => json!({
                "type": "confirm",
                "callId": call_id,
                "result": "approved",
                "stored": true,
                "record": record,
            }),
            Confirmed::Approved { record: None } => json!({
                "type": "confirm",
                "callId": call_id,
                "result": "approved",
                "stored": false,
            }),
            Confirmed::Declined => {
                json!({ "type": "confirm", "callId": call_id, "result": "declined" })
            }
        }
    }
}

/// One stored record. `stem` is its file name without `.json`.
struct Record {
    stem: String,
    value: Value,
}

impl Record {
    fn order(&self) -> (Option<(&str, u32)>, &str) {
        (
            self.value["approvedAt"].as_str().and_then(utc_time),
            &self.stem,
        )
    }
}

/// The common-directory identity and the worktree identity of one `confirm` frame, in the record form.
struct Identities {
    common: Value,
    worktree: Value,
    /// The record file name: the SHA-256 of the three identity texts.
    stem: String,
}

impl Identities {
    fn read(request: &Confirm) -> Option<Identities> {
        let common = read_identity(&request.common_directory).ok()?;
        let root = read_identity(&request.worktree_root).ok()?;
        let git_directory = read_identity(&request.git_directory).ok()?;
        let key = [common, root, git_directory].map(|identity| identity_text(&identity));
        Some(Identities {
            common: common.reply(),
            worktree: json!([root.reply(), git_directory.reply()]),
            stem: hex(&sha256(key.concat().as_bytes())),
        })
    }
}

/// A record of the same worktree: both identities match, or both paths match (contract §7 "Trust approval store").
fn same_worktree(record: &Value, request: &Confirm, identities: Option<&Identities>) -> bool {
    let paths = record["commonDirectory"].as_str() == request.common_directory.to_str()
        && record["worktreeRoot"].as_str() == request.worktree_root.to_str();
    paths
        || identities.is_some_and(|ids| {
            record["commonIdentity"] == ids.common && record["worktreeIdentity"] == ids.worktree
        })
}

/// Loads every valid record, oldest first. Above the limit, it keeps the newest records.
fn load_records(folder: &Path) -> Vec<Record> {
    let mut records: Vec<Record> = json_files(folder)
        .into_iter()
        .filter_map(|(stem, path)| {
            let bytes = read_bounded(&path, TRUST_RECORD_BYTES)
                .ok()
                .filter(|bytes| bytes.len() <= TRUST_RECORD_BYTES)?;
            let value: Value = serde_json::from_slice(&bytes).ok()?;
            schema::trust_record(&value).then_some(Record { stem, value })
        })
        .collect();
    records.sort_by(|a, b| a.order().cmp(&b.order()));
    let excess = records.len().saturating_sub(TRUST_RECORD_LIMIT);
    records.drain(..excess);
    records
}

struct TrustState {
    /// Oldest first.
    records: Vec<Record>,
    fault: Fault,
}

/// The record store of the `trust` folder.
pub struct Trust {
    folder: PathBuf,
    state: Mutex<TrustState>,
}

impl Trust {
    /// Creates the folder when it is absent.
    pub fn open(folder: &Path) -> Trust {
        let _ = std::fs::create_dir_all(folder);
        Trust {
            folder: folder.to_path_buf(),
            state: Mutex::new(TrustState {
                records: load_records(folder),
                fault: None,
            }),
        }
    }

    fn path(&self, stem: &str) -> PathBuf {
        self.folder.join(format!("{stem}.json"))
    }

    /// Deletes each record that `matches` selects. A record whose file stays also stays in the store.
    fn remove(&self, state: &mut TrustState, matches: impl Fn(&Record) -> bool) {
        state.records.retain(|record| {
            !matches(record) || std::fs::remove_file(self.path(&record.stem)).is_err()
        });
    }

    /// Shows the confirmation through `accept`, then writes or deletes records.
    pub fn confirm(&self, request: &Confirm, accept: impl FnOnce(&Confirm) -> bool) -> Confirmed {
        if !accept(request) {
            return Confirmed::Declined;
        }
        let identities = Identities::read(request);
        let mut state = lock(&self.state);
        if !request.persist {
            self.remove(&mut state, |record| {
                same_worktree(&record.value, request, identities.as_ref())
            });
            return Confirmed::Approved { record: None };
        }
        let record = identities
            .as_ref()
            .and_then(|identities| self.store(&mut state, request, identities));
        Confirmed::Approved { record }
    }

    /// Writes the record, then deletes the other records of the same worktree. `None` leaves the stored records unchanged.
    fn store(
        &self,
        state: &mut TrustState,
        request: &Confirm,
        identities: &Identities,
    ) -> Option<Value> {
        let record = json!({
            "commonDirectory": request.common_directory.to_str()?,
            "commonIdentity": identities.common,
            "worktreeRoot": request.worktree_root.to_str()?,
            "gitDirectory": request.git_directory.to_str()?,
            "worktreeIdentity": identities.worktree,
            "configurationFingerprint": request.fingerprint,
            "approvedAt": utc_now(),
            "gitSelectedPath": request.git_selected_path.to_str()?,
        });
        let bytes = record.to_string().into_bytes();
        // A record above 4 KiB gets the reply of a failed write: the approval holds for the session only.
        if !schema::trust_record(&record) {
            return None;
        }
        let fault = state.fault.take();
        write_file(&self.path(&identities.stem), &bytes, true, fault).ok()?;
        state.records.retain(|old| old.stem != identities.stem);
        self.remove(state, |old| {
            same_worktree(&old.value, request, Some(identities))
        });
        state.records.push(Record {
            stem: identities.stem.clone(),
            value: record.clone(),
        });
        while state.records.len() > TRUST_RECORD_LIMIT {
            let oldest = state.records.remove(0);
            let _ = std::fs::remove_file(self.path(&oldest.stem));
        }
        Some(record)
    }

    /// Deletes the records of every worktree of the common directory.
    /// `close` closes the lingering Jobs with that identity tag and returns the ended process count.
    pub fn revoke(&self, common_directory: &Path, close: impl FnOnce(&Identity) -> u32) -> u32 {
        let identity = read_identity(common_directory).ok();
        let common = identity.map(|identity| identity.reply());
        {
            let mut state = lock(&self.state);
            self.remove(&mut state, |record| {
                record.value["commonDirectory"].as_str() == common_directory.to_str()
                    || common
                        .as_ref()
                        .is_some_and(|common| record.value["commonIdentity"] == *common)
            });
        }
        identity.map_or(0, |identity| close(&identity))
    }

    /// Every record in the handshake form. Each call rereads the folder, so records of other instances also appear.
    pub fn records(&self) -> Vec<Value> {
        let mut state = lock(&self.state);
        state.records = load_records(&self.folder);
        state
            .records
            .iter()
            .map(|record| record.value.clone())
            .collect()
    }

    /// Fails the next record write at `stage` with the OS error code `os_error`.
    #[cfg_attr(not(test), expect(dead_code, reason = "test hook"))]
    pub fn fail_next(&self, stage: Stage, os_error: i32) {
        lock(&self.state).fault = Some((stage, os_error));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::ffi::OsString;
    use std::io::{BufRead, Write};
    use std::os::windows::fs::OpenOptionsExt;
    use std::process::{Command, Stdio};

    use serde_json::json;
    use windows::Win32::Foundation::{CloseHandle, WAIT_ABANDONED, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};
    use windows::core::HSTRING;

    use crate::bootstrap::read_identity;
    use crate::jobs::tests::{Fixture, Lines, Started as Child, WAIT, exits_within, test_exe};
    use crate::process_requests::is_identifier;

    const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const FINGERPRINT: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    const GIT_PATH: &str = "C:\\Program Files\\Git\\cmd\\git.exe";

    // Win32 error codes (winerror.h). Rust std maps 39 and 112 to `StorageFull` and 5 to `PermissionDenied`.
    const ERROR_ACCESS_DENIED: i32 = 5;
    const ERROR_HANDLE_DISK_FULL: i32 = 39;
    const ERROR_INVALID_PARAMETER: i32 = 87;
    const ERROR_DISK_FULL: i32 = 112;

    // ---- Re-executed child ----

    const CHILD_PREFIX: [&str; 6] = [
        "settings::tests::child_entry",
        "--exact",
        "--ignored",
        "--nocapture",
        "--test-threads=1",
        "--",
    ];

    fn start(mode: &[&str]) -> Child {
        let mut child = Command::new(test_exe())
            .args(CHILD_PREFIX.iter().chain(mode))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn child");
        let stdin = child.stdin.take();
        let lines = Lines::new(child.stdout.take().expect("stdout"));
        Child {
            child,
            stdin,
            lines,
        }
    }

    fn print_line(line: &str) {
        let mut stdout = std::io::stdout();
        writeln!(stdout, "{line}").expect("stdout");
        stdout.flush().expect("flush");
    }

    /// Takes the mutex without waiting. Returns true for `WAIT_OBJECT_0` and `WAIT_ABANDONED`.
    fn take(name: &str) -> Option<windows::Win32::Foundation::HANDLE> {
        // SAFETY: the name is a live HSTRING.
        let handle = unsafe { CreateMutexW(None, false, &HSTRING::from(name)) }.expect("mutex");
        // SAFETY: `handle` is a live mutex handle.
        let wait = unsafe { WaitForSingleObject(handle, 0) };
        if wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED {
            Some(handle)
        } else {
            // SAFETY: `handle` is live and owned here.
            unsafe { CloseHandle(handle) }.expect("close");
            None
        }
    }

    /// True when another thread can take the mutex now. The probe thread releases it again.
    fn mutex_is_free(name: &str) -> bool {
        let name = name.to_string();
        std::thread::spawn(move || {
            take(&name).is_some_and(|handle| {
                // SAFETY: this thread owns the mutex, and `handle` is live.
                unsafe { ReleaseMutex(handle) }.expect("release");
                unsafe { CloseHandle(handle) }.expect("close");
                true
            })
        })
        .join()
        .expect("probe thread")
    }

    fn run_child(mode: &str, args: &[String]) -> ! {
        match mode {
            // mutex <name> <hold|exit>: takes the mutex without waiting. `exit` ends without a release.
            "mutex" => {
                let taken = take(&args[0]).is_some();
                print_line(&format!("MUTEX {}", if taken { "taken" } else { "busy" }));
                if args[1] == "hold" {
                    let mut line = String::new();
                    let _ = std::io::stdin().lock().read_line(&mut line);
                }
            }
            // file <path>: opens the file without sharing and holds it.
            "file" => {
                let _file = std::fs::OpenOptions::new()
                    .read(true)
                    .share_mode(0)
                    .open(&args[0])
                    .expect("open without sharing");
                print_line("FILE open");
                let mut line = String::new();
                let _ = std::io::stdin().lock().read_line(&mut line);
            }
            _ => panic!("unknown child mode {mode}"),
        }
        std::process::exit(0)
    }

    #[test]
    #[ignore = "child process entry for re-executed tests"]
    fn child_entry() {
        let args: Vec<OsString> = std::env::args_os().collect();
        let Some(split) = args.iter().position(|a| a == "--") else {
            return;
        };
        let payload: Vec<String> = args[split + 1..]
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let Some((mode, rest)) = payload.split_first() else {
            return;
        };
        run_child(mode, rest)
    }

    // ---- Helpers ----

    fn folder(fixture: &Fixture, name: &str) -> PathBuf {
        let path = fixture.path(name);
        std::fs::create_dir_all(&path).expect("create folder");
        path
    }

    fn entries(folder: &Path) -> Vec<String> {
        let mut names: Vec<String> = match std::fs::read_dir(folder) {
            Ok(read) => read
                .map(|entry| {
                    entry
                        .expect("entry")
                        .file_name()
                        .to_string_lossy()
                        .into_owned()
                })
                .collect(),
            Err(_) => Vec::new(),
        };
        names.sort();
        names
    }

    fn keys(value: &Value) -> Vec<String> {
        let mut keys: Vec<String> = value.as_object().expect("object").keys().cloned().collect();
        keys.sort();
        keys
    }

    fn sorted(names: &[&str]) -> Vec<String> {
        let mut names: Vec<String> = names.iter().map(|s| s.to_string()).collect();
        names.sort();
        names
    }

    /// RFC 3339 UTC: `YYYY-MM-DDTHH:MM:SS`, an optional fraction, then `Z` or `+00:00`.
    fn is_utc_time(text: &str) -> bool {
        let b = text.as_bytes();
        let digits = |mut range: std::ops::Range<usize>| {
            range.all(|i| b.get(i).is_some_and(u8::is_ascii_digit))
        };
        if b.len() < 20
            || !(digits(0..4)
                && digits(5..7)
                && digits(8..10)
                && digits(11..13)
                && digits(14..16)
                && digits(17..19))
            || b[4] != b'-'
            || b[7] != b'-'
            || b[10] != b'T'
            || b[13] != b':'
            || b[16] != b':'
        {
            return false;
        }
        let mut rest = &text[19..];
        if let Some(fraction) = rest.strip_prefix('.') {
            let end = fraction
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(fraction.len());
            if end == 0 {
                return false;
            }
            rest = &fraction[end..];
        }
        rest == "Z" || rest == "+00:00"
    }

    fn identity_reply(path: &Path) -> Value {
        read_identity(path).expect("identity").reply()
    }

    // ---- Settings file ----

    fn full_settings(fixture: &Fixture) -> Settings {
        Settings {
            git: Some(SavedGit {
                selected_path: fixture.path("cmd\\git.exe"),
                executable_path: fixture.path("git.exe"),
                version: "2.55.0.windows.3".to_string(),
                digest: DIGEST.to_string(),
            }),
            last_repository: Some(fixture.path("repo")),
            window: Some(Bounds {
                x: 40,
                y: 30,
                width: 1280,
                height: 800,
            }),
            wsl_gits: Vec::new(),
        }
    }

    /// The file form: `git` with `selectedPath`, `executablePath`, `version`, and `digest`; `lastRepository`; `window` with `x`, `y`, `width`, and `height`.
    fn settings_json(fixture: &Fixture) -> Value {
        json!({
            "git": {
                "selectedPath": fixture.path("cmd\\git.exe"),
                "executablePath": fixture.path("git.exe"),
                "version": "2.55.0.windows.3",
                "digest": DIGEST,
            },
            "lastRepository": fixture.path("repo"),
            "window": { "x": 40, "y": 30, "width": 1280, "height": 800 },
        })
    }

    #[test]
    fn saved_settings_load_with_the_git_digest_the_last_repository_and_the_window_bounds() {
        let fixture = Fixture::new();
        let path = fixture.path("settings.json");
        let settings = full_settings(&fixture);
        save(&path, &settings).expect("save");
        assert_eq!(load(&path), settings);
    }

    #[test]
    fn the_file_form_holds_the_documented_keys() {
        let fixture = Fixture::new();
        let path = fixture.path("settings.json");
        std::fs::write(&path, settings_json(&fixture).to_string()).expect("write");
        assert_eq!(load(&path), full_settings(&fixture));
    }

    #[test]
    fn the_saved_git_round_trips_the_selected_path_beside_the_resolved_path() {
        let fixture = Fixture::new();
        let path = fixture.path("settings.json");
        save(&path, &full_settings(&fixture)).expect("save");
        let file: Value =
            serde_json::from_slice(&std::fs::read(&path).expect("read")).expect("JSON");
        assert_eq!(file["git"], settings_json(&fixture)["git"]);
        assert_eq!(load(&path), full_settings(&fixture));
    }

    #[test]
    fn a_git_entry_without_a_selected_path_loads_with_the_resolved_path_as_the_selected_path() {
        let fixture = Fixture::new();
        let path = fixture.path("settings.json");
        let mut file = settings_json(&fixture);
        file["git"]
            .as_object_mut()
            .expect("git")
            .remove("selectedPath");
        std::fs::write(&path, file.to_string()).expect("write");
        let git = load(&path).git.expect("saved Git");
        assert_eq!(git.selected_path, fixture.path("git.exe"));
        assert_eq!(git.executable_path, fixture.path("git.exe"));
    }

    const WSL_GUID: &str = "{c6d24ae9-40f2-40bf-b35d-bf0b6ca4ea00}";
    const OTHER_WSL_GUID: &str = "{8f51b15e-5f05-4b6d-8d78-5765530f558a}";

    fn wsl_git(guid: &str, git: &str) -> SavedWslGit {
        SavedWslGit {
            guid: guid.to_string(),
            distro: "Ubuntu-24.04".to_string(),
            git: git.to_string(),
            version: "2.55.0".to_string(),
            identity: "fedc9aa3bd65bc57:43750:4066232:1751487822".to_string(),
        }
    }

    #[test]
    fn the_approved_wsl_git_of_each_distro_guid_round_trips() {
        let fixture = Fixture::new();
        let path = fixture.path("settings.json");
        let settings = Settings {
            wsl_gits: vec![
                wsl_git(WSL_GUID, "/usr/local/bin/git"),
                wsl_git(OTHER_WSL_GUID, "/opt/git a$b/bin/git"),
            ],
            ..full_settings(&fixture)
        };
        save(&path, &settings).expect("save");
        assert_eq!(load(&path), settings);
        let file: Value =
            serde_json::from_slice(&std::fs::read(&path).expect("read")).expect("JSON");
        assert_eq!(
            file["wslGits"][0],
            json!({
                "guid": WSL_GUID,
                "distro": "Ubuntu-24.04",
                "git": "/usr/local/bin/git",
                "version": "2.55.0",
                "identity": "fedc9aa3bd65bc57:43750:4066232:1751487822",
            })
        );
        assert_eq!(
            file["git"],
            settings_json(&fixture)["git"],
            "beside the Windows Git"
        );
    }

    #[test]
    fn approving_a_wsl_git_replaces_only_the_entry_of_its_guid() {
        let mut settings = Settings::default();
        remember_wsl_git(&mut settings, wsl_git(WSL_GUID, "/usr/bin/git"));
        remember_wsl_git(&mut settings, wsl_git(OTHER_WSL_GUID, "/usr/bin/git"));
        remember_wsl_git(&mut settings, wsl_git(WSL_GUID, "/usr/local/bin/git"));
        assert_eq!(
            settings.wsl_gits,
            [
                wsl_git(OTHER_WSL_GUID, "/usr/bin/git"),
                wsl_git(WSL_GUID, "/usr/local/bin/git")
            ]
        );
        assert_eq!(
            saved_wsl_git(&settings, WSL_GUID),
            Some(&wsl_git(WSL_GUID, "/usr/local/bin/git"))
        );
        assert_eq!(
            saved_wsl_git(&settings, "{00000000-0000-4000-8000-000000000000}"),
            None
        );
    }

    #[test]
    fn an_invalid_wsl_git_entry_is_dropped_and_the_other_entries_stay() {
        let fixture = Fixture::new();
        let path = fixture.path("settings.json");
        let valid = json!({
            "guid": OTHER_WSL_GUID,
            "distro": "Ubuntu",
            "git": "/usr/bin/git",
            "version": "2.55.0",
            "identity": "fedc9aa3bd65bc57:1:2:3",
        });
        let cases: [(&str, Value); 12] = [
            ("guid", json!("c6d24ae9-40f2-40bf-b35d-bf0b6ca4ea00")),
            ("guid", json!("{c6d24ae9-40f2-40bf-b35d-bf0b6ca4ea0}")),
            ("distro", json!("")),
            ("distro", json!("Ubu\u{1}ntu")),
            ("git", json!("usr/bin/git")),
            ("git", json!("/usr/bin/g\u{0}it")),
            // `dialogs.rs` prints the path into the confirmation.
            ("git", json!("/usr/bin/g\u{1b}it")),
            ("git", json!("/usr/bin/git\nUse this Git")),
            ("git", json!("/usr/bin/g\u{85}it")),
            ("version", json!("2".repeat(65))),
            ("identity", json!("fedc9aa3bd65bc57:1:2")),
            ("identity", json!("xyz:1:2:3")),
        ];
        for (field, value) in cases {
            let mut entry = valid.clone();
            entry["guid"] = json!(WSL_GUID);
            entry[field] = value.clone();
            let mut file = settings_json(&fixture);
            file["wslGits"] = json!([entry, valid]);
            std::fs::write(&path, file.to_string()).expect("write");
            let loaded = load(&path);
            assert_eq!(loaded.wsl_gits.len(), 1, "{field} {value}");
            assert_eq!(loaded.wsl_gits[0].guid, OTHER_WSL_GUID);
            assert_eq!(
                loaded.git,
                full_settings(&fixture).git,
                "the Windows Git stays"
            );
        }
        let mut file = settings_json(&fixture);
        file["wslGits"] = json!([valid, valid]);
        std::fs::write(&path, file.to_string()).expect("write");
        assert_eq!(load(&path).wsl_gits.len(), 1, "one entry for each GUID");
    }

    #[test]
    fn a_missing_or_unparseable_file_gives_the_defaults() {
        let fixture = Fixture::new();
        let path = fixture.path("settings.json");
        assert_eq!(load(&path), Settings::default(), "missing");
        for text in ["", "{", "not json", "[]", "null", "\"text\""] {
            std::fs::write(&path, text).expect("write");
            assert_eq!(load(&path), Settings::default(), "{text:?}");
        }
    }

    #[test]
    fn an_invalid_git_entry_gives_no_saved_git_and_keeps_the_other_settings() {
        let fixture = Fixture::new();
        let path = fixture.path("settings.json");
        let cases: [(&str, &str, Value); 10] = [
            (
                "an uppercase digest",
                "digest",
                json!(DIGEST.to_uppercase()),
            ),
            ("a 63-digit digest", "digest", json!(&DIGEST[1..])),
            (
                "a non-hex digest",
                "digest",
                json!(DIGEST.replace('a', "g")),
            ),
            ("a relative path", "executablePath", json!("git.exe")),
            ("a version above 64 bytes", "version", json!("2".repeat(65))),
            (
                "a version with a control byte",
                "version",
                json!("2.55.0\u{1}"),
            ),
            ("a number path", "executablePath", json!(7)),
            ("a relative selected path", "selectedPath", json!("git.exe")),
            ("a number selected path", "selectedPath", json!(7)),
            (
                "a device selected path",
                "selectedPath",
                json!(r"\\.\pipe\git.exe"),
            ),
        ];
        for (name, key, value) in cases {
            let mut file = settings_json(&fixture);
            file["git"][key] = value;
            std::fs::write(&path, file.to_string()).expect("write");
            let loaded = load(&path);
            assert_eq!(loaded.git, None, "{name}");
            assert_eq!(loaded.last_repository, Some(fixture.path("repo")), "{name}");
            assert_eq!(loaded.window, full_settings(&fixture).window, "{name}");
        }
    }

    #[test]
    fn an_invalid_last_repository_or_window_uses_its_default() {
        let fixture = Fixture::new();
        let path = fixture.path("settings.json");
        let mut file = settings_json(&fixture);
        file["lastRepository"] = json!("relative\\repo");
        file["window"]["width"] = json!("wide");
        std::fs::write(&path, file.to_string()).expect("write");
        let loaded = load(&path);
        assert_eq!(loaded.last_repository, None);
        assert_eq!(loaded.window, None);
        assert_eq!(loaded.git, full_settings(&fixture).git);
    }

    #[test]
    fn an_unknown_key_is_ignored() {
        let fixture = Fixture::new();
        let path = fixture.path("settings.json");
        let mut file = settings_json(&fixture);
        file["futureSetting"] = json!({ "any": true });
        std::fs::write(&path, file.to_string()).expect("write");
        assert_eq!(load(&path), full_settings(&fixture));
    }

    #[test]
    fn each_write_replaces_the_whole_file_and_leaves_no_temporary_file() {
        let fixture = Fixture::new();
        let path = fixture.path("settings.json");
        std::fs::write(&path, "x".repeat(64 * 1024)).expect("write");
        let settings = full_settings(&fixture);
        save(&path, &settings).expect("save");
        assert_eq!(load(&path), settings);
        let cleared = Settings {
            git: None,
            ..settings
        };
        save(&path, &cleared).expect("save");
        assert_eq!(load(&path), cleared, "a cleared entry does not survive");
        assert_eq!(entries(&fixture.0), ["settings.json"]);
    }

    #[test]
    fn a_failed_write_leaves_the_previous_file_and_no_temporary_file() {
        let fixture = Fixture::new();
        let path = fixture.path("settings.json");
        let previous = full_settings(&fixture);
        save(&path, &previous).expect("save");
        let bytes = std::fs::read(&path).expect("read");
        let writable = std::fs::metadata(&path).expect("metadata").permissions();
        let mut read_only = writable.clone();
        read_only.set_readonly(true);
        std::fs::set_permissions(&path, read_only).expect("read-only");
        let result = save(&path, &Settings::default());
        std::fs::set_permissions(&path, writable).expect("writable");
        assert!(result.is_err(), "a read-only file refuses the replacement");
        assert_eq!(std::fs::read(&path).expect("read"), bytes);
        assert_eq!(entries(&fixture.0), ["settings.json"]);
    }

    // ---- Window bounds ----

    const WORK_AREA: Bounds = Bounds {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
    };

    fn bounds(x: i32, y: i32, width: i32, height: i32) -> Bounds {
        Bounds {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn bounds_inside_the_work_area_stay_unchanged() {
        let stored = bounds(100, 50, 1280, 800);
        assert_eq!(clamp(Some(stored), WORK_AREA), Ok(stored));
    }

    #[test]
    fn bounds_larger_than_the_work_area_shrink_to_it() {
        let area = bounds(-1920, 0, 1600, 900);
        assert_eq!(clamp(Some(bounds(-1900, 10, 2400, 1400)), area), Ok(area));
    }

    #[test]
    fn bounds_outside_the_work_area_move_into_it() {
        assert_eq!(
            clamp(Some(bounds(1500, 900, 1280, 800)), WORK_AREA),
            Ok(bounds(640, 240, 1280, 800)),
            "past the right and bottom edges"
        );
        assert_eq!(
            clamp(Some(bounds(-3000, -500, 1280, 800)), WORK_AREA),
            Ok(bounds(0, 0, 1280, 800)),
            "on a display that is gone"
        );
    }

    #[test]
    fn bounds_below_the_native_minimum_grow_to_it() {
        assert_eq!(
            clamp(Some(bounds(10, 10, 300, 200)), WORK_AREA),
            Ok(bounds(10, 10, 720, 480))
        );
    }

    #[test]
    fn without_stored_bounds_the_default_size_fits_into_the_work_area() {
        let placed = clamp(None, WORK_AREA).expect("fits");
        assert_eq!((placed.width, placed.height), DEFAULT_SIZE);
        let small = bounds(100, 0, 1000, 700);
        let placed = clamp(None, small).expect("fits");
        assert_eq!((placed.width, placed.height), (1000, 700));
        assert!(placed.x >= small.x && placed.y >= small.y);
        assert!(placed.x + placed.width <= small.x + small.width);
        assert!(placed.y + placed.height <= small.y + small.height);
    }

    #[test]
    fn a_work_area_that_cannot_fit_720_by_480_is_insufficient() {
        assert_eq!(MINIMUM_SIZE, (720, 480));
        let stored = Some(bounds(0, 0, 1280, 800));
        assert_eq!(
            clamp(stored, bounds(0, 0, 719, 1000)),
            Err(InsufficientWorkArea)
        );
        assert_eq!(
            clamp(stored, bounds(0, 0, 1000, 479)),
            Err(InsufficientWorkArea)
        );
        assert_eq!(
            clamp(None, bounds(0, 0, 719, 479)),
            Err(InsufficientWorkArea)
        );
        assert_eq!(
            clamp(stored, bounds(0, 0, 720, 480)),
            Ok(bounds(0, 0, 720, 480))
        );
    }

    // ---- Recovery markers ----

    struct Repository {
        worktree: PathBuf,
        common: PathBuf,
    }

    fn repository(fixture: &Fixture, name: &str) -> Repository {
        let worktree = folder(fixture, name);
        let common = folder(fixture, &format!("{name}\\.git"));
        Repository { worktree, common }
    }

    fn started<'a>(repository: &'a Repository, operation_id: &'a str) -> Started<'a> {
        Started {
            operation_id,
            kind: "commit",
            worktree_root: &repository.worktree,
            common_directory: &repository.common,
        }
    }

    fn marker_id(reply: StartedReply) -> String {
        match reply {
            StartedReply::Marker { marker_id, .. } => marker_id,
            other => panic!("expected a marker ID, got {other:?}"),
        }
    }

    fn name_of(repository: &Repository) -> String {
        mutex_name(&read_identity(&repository.common).expect("identity"))
    }

    /// A marker file in the handshake form, written as another instance would leave it.
    fn write_marker(recovery: &Path, repository: &Repository, n: u32, padding: usize) -> String {
        let id = format!("0f0f0f0f-0000-4000-8000-{n:012}");
        let marker = json!({
            "markerId": id,
            "kind": "applyHunk",
            "startedAt": format!("2026-01-01T00:{:02}:{:02}Z", n / 60, n % 60),
            "worktreeRoot": repository.worktree,
            "commonDirectory": repository.common,
            "commonIdentity": identity_reply(&repository.common),
        });
        let text = format!("{marker}{}", " ".repeat(padding));
        std::fs::write(recovery.join(format!("{id}.json")), text).expect("write marker");
        id
    }

    #[test]
    fn the_mutex_name_is_local_and_holds_a_sha_256_of_the_identity() {
        let first = Identity {
            volume_serial: 1,
            file_id: [2; 16],
        };
        let second = Identity {
            volume_serial: 1,
            file_id: [3; 16],
        };
        let name = mutex_name(&first);
        let hex = name
            .strip_prefix("Local\\Arbareto-mutation-")
            .expect("the Local prefix");
        assert_eq!(hex.len(), 64);
        assert!(
            hex.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
        assert_eq!(mutex_name(&first), name, "stable");
        assert_ne!(mutex_name(&second), name, "another identity");
    }

    #[test]
    fn started_writes_one_marker_file_with_the_common_directory_identity() {
        let fixture = Fixture::new();
        let repository = repository(&fixture, "repo");
        let recovery = fixture.path("recovery");
        let markers = Markers::open(&recovery);
        let id = marker_id(markers.started(&started(&repository, "op-1")));
        assert!(is_identifier(&id), "{id}");
        assert_eq!(entries(&recovery), [format!("{id}.json")]);
        let file: Value = serde_json::from_slice(
            &std::fs::read(recovery.join(format!("{id}.json"))).expect("read marker"),
        )
        .expect("marker JSON");
        assert_eq!(
            keys(&file),
            sorted(&[
                "markerId",
                "kind",
                "startedAt",
                "worktreeRoot",
                "commonDirectory",
                "commonIdentity"
            ])
        );
        assert_eq!(file["markerId"], json!(id));
        assert_eq!(file["kind"], json!("commit"));
        assert_eq!(file["worktreeRoot"], json!(repository.worktree));
        assert_eq!(file["commonDirectory"], json!(repository.common));
        assert_eq!(file["commonIdentity"], identity_reply(&repository.common));
        assert!(is_utc_time(file["startedAt"].as_str().expect("startedAt")));
        let scan = markers.scan();
        assert_eq!(scan.unloaded, 0);
        assert_eq!(scan.markers.len(), 1);
        assert_eq!(scan.markers[0].handshake(), file);
        assert!(
            std::fs::remove_file(recovery.join(format!("{id}.json"))).is_err(),
            "the shell keeps the file open without delete sharing"
        );
    }

    #[test]
    fn a_mutex_that_another_process_holds_gives_busy_and_no_file() {
        let fixture = Fixture::new();
        let repository = repository(&fixture, "repo");
        let recovery = fixture.path("recovery");
        let markers = Markers::open(&recovery);
        let holder = start(&["mutex", &name_of(&repository), "hold"]);
        assert_eq!(holder.lines.wait("MUTEX", WAIT), "taken");
        assert_eq!(
            markers.started(&started(&repository, "op-1")),
            StartedReply::Busy
        );
        assert_eq!(entries(&recovery), Vec::<String>::new());
    }

    #[test]
    fn an_abandoned_mutex_counts_as_taken() {
        let fixture = Fixture::new();
        let repository = repository(&fixture, "repo");
        let markers = Markers::open(&fixture.path("recovery"));
        let holder = start(&["mutex", &name_of(&repository), "exit"]);
        assert_eq!(holder.lines.wait("MUTEX", WAIT), "taken");
        assert!(
            exits_within(holder.handle(), WAIT),
            "the holder exits without a release"
        );
        marker_id(markers.started(&started(&repository, "op-1")));
    }

    #[test]
    fn ended_releases_the_mutex_and_keeps_the_marker_file() {
        let fixture = Fixture::new();
        let repository = repository(&fixture, "repo");
        let recovery = fixture.path("recovery");
        let markers = Markers::open(&recovery);
        let name = name_of(&repository);
        let first = marker_id(markers.started(&started(&repository, "op-1")));
        assert!(!mutex_is_free(&name), "started holds the mutex");
        markers.ended("op-1");
        assert!(mutex_is_free(&name), "ended releases the mutex");
        assert_eq!(entries(&recovery), [format!("{first}.json")]);
        let second = marker_id(markers.started(&started(&repository, "op-2")));
        assert_ne!(first, second);
        markers.ended("op-2");
    }

    #[test]
    fn a_marker_that_a_running_instance_holds_is_skipped_until_it_exits() {
        let fixture = Fixture::new();
        let repository = repository(&fixture, "repo");
        let recovery = folder(&fixture, "recovery");
        let id = write_marker(&recovery, &repository, 1, 0);
        let path = recovery.join(format!("{id}.json"));
        let holder = start(&["file", &path.to_string_lossy()]);
        assert_eq!(holder.lines.wait("FILE", WAIT), "open");
        let markers = Markers::open(&recovery);
        let scan = markers.scan();
        assert_eq!(
            scan.markers,
            Vec::new(),
            "the running instance owns the file"
        );
        assert_eq!(scan.unloaded, 0);
        drop(holder);
        let scan = markers.scan();
        assert_eq!(scan.markers.len(), 1);
        assert_eq!(scan.markers[0].marker_id, id);
        assert_eq!(scan.markers[0].kind, "applyHunk");
        assert_eq!(scan.markers[0].worktree_root, repository.worktree);
        assert_eq!(scan.markers[0].common_directory, repository.common);
        assert_eq!(
            scan.markers[0].common_identity,
            read_identity(&repository.common).expect("identity")
        );
        assert!(
            std::fs::remove_file(&path).is_err(),
            "this shell now owns the file"
        );
    }

    #[test]
    fn resolved_deletes_the_marker_file() {
        let fixture = Fixture::new();
        let repository = repository(&fixture, "repo");
        let recovery = fixture.path("recovery");
        let markers = Markers::open(&recovery);
        let id = marker_id(markers.started(&started(&repository, "op-1")));
        markers.ended("op-1");
        markers.resolved(&id);
        assert_eq!(entries(&recovery), Vec::<String>::new());
        assert_eq!(markers.scan().markers, Vec::new());
    }

    #[test]
    fn sixty_five_markers_load_the_64_oldest_and_report_one_unloaded_file() {
        assert_eq!((MARKER_LIMIT, MARKER_BYTES), (64, 4096));
        let fixture = Fixture::new();
        let repository = repository(&fixture, "repo");
        let recovery = folder(&fixture, "recovery");
        let ids: Vec<String> = (0..65)
            .map(|n| write_marker(&recovery, &repository, n, 0))
            .collect();
        let markers = Markers::open(&recovery);
        let scan = markers.scan();
        assert_eq!(scan.unloaded, 1, "the limit result");
        let mut loaded: Vec<String> = scan.markers.iter().map(|m| m.marker_id.clone()).collect();
        loaded.sort();
        assert_eq!(loaded, ids[..64], "the newest marker stays unloaded");
        markers.resolved(&ids[0]);
        let scan = markers.scan();
        assert_eq!(scan.unloaded, 0, "the rescan finds 64 files");
        assert_eq!(scan.markers.len(), 64);
    }

    #[test]
    fn a_marker_above_4_kib_is_damaged_and_not_unloaded() {
        let fixture = Fixture::new();
        let repository = repository(&fixture, "repo");
        let recovery = folder(&fixture, "recovery");
        let small = write_marker(&recovery, &repository, 1, 0);
        let large = write_marker(&recovery, &repository, 2, MARKER_BYTES);
        let scan = Markers::open(&recovery).scan();
        assert_eq!(scan.unloaded, 0, "a damaged marker is not the limit result");
        assert_eq!(scan.markers.len(), 1);
        assert_eq!(scan.markers[0].marker_id, small);
        assert_eq!(scan.damaged.len(), 1);
        assert_eq!(scan.damaged[0].file_name, format!("{large}.json"));
        assert!(is_identifier(&scan.damaged[0].marker_id));
        assert_eq!(
            scan.damaged[0].handshake(),
            json!({ "markerId": scan.damaged[0].marker_id, "fileName": format!("{large}.json") })
        );
    }

    #[test]
    fn a_damaged_marker_keeps_its_id_and_its_file_in_a_rescan() {
        let fixture = Fixture::new();
        let recovery = folder(&fixture, "recovery");
        std::fs::write(recovery.join("broken.json"), "{").expect("write");
        let markers = Markers::open(&recovery);
        let first = markers.scan().damaged;
        assert_eq!(first.len(), 1);
        assert_eq!(markers.scan().damaged, first, "the same ID in the rescan");
        assert!(
            std::fs::remove_file(recovery.join("broken.json")).is_err(),
            "the shell keeps the damaged file open without delete sharing"
        );
    }

    #[test]
    fn above_64_damaged_files_the_scan_lists_64_in_file_name_order() {
        let fixture = Fixture::new();
        let recovery = folder(&fixture, "recovery");
        let names: Vec<String> = (0..65).map(|n| format!("damaged-{n:02}.json")).collect();
        for name in names.iter().rev() {
            std::fs::write(recovery.join(name), "not JSON").expect("write");
        }
        let markers = Markers::open(&recovery);
        let scan = markers.scan();
        assert_eq!(scan.unloaded, 0);
        let listed: Vec<&str> = scan.damaged.iter().map(|d| d.file_name.as_str()).collect();
        assert_eq!(listed, names[..64]);
        assert!(markers.dismiss_damaged(&scan.damaged[0].marker_id, |_| true));
        let listed: Vec<String> = markers
            .scan()
            .damaged
            .into_iter()
            .map(|d| d.file_name)
            .collect();
        assert_eq!(listed, names[1..], "a dismissal frees a place");
    }

    #[test]
    fn a_damaged_marker_is_deleted_only_after_an_accepted_confirmation() {
        let fixture = Fixture::new();
        let recovery = folder(&fixture, "recovery");
        std::fs::write(recovery.join("broken.json"), "{").expect("write");
        let markers = Markers::open(&recovery);
        let damaged = markers.scan().damaged.remove(0);
        assert_eq!(markers.damaged(&damaged.marker_id), Some(damaged.clone()));
        assert_eq!(markers.get(&damaged.marker_id), None, "not a loaded marker");
        assert!(
            !markers.dismiss_damaged(&damaged.marker_id, |_| false),
            "declined"
        );
        assert_eq!(entries(&recovery), ["broken.json"]);
        let mut shown = None;
        assert!(
            markers.dismiss_damaged(&damaged.marker_id, |shown_damaged| {
                shown = Some(shown_damaged.file_name.clone());
                true
            })
        );
        assert_eq!(shown.as_deref(), Some("broken.json"));
        assert_eq!(entries(&recovery), Vec::<String>::new());
        assert_eq!(markers.damaged(&damaged.marker_id), None);
        assert!(markers.scan().damaged.is_empty());
    }

    #[test]
    fn an_injected_write_or_flush_failure_gives_its_class_and_no_file() {
        let fixture = Fixture::new();
        let repository = repository(&fixture, "repo");
        let recovery = fixture.path("recovery");
        let markers = Markers::open(&recovery);
        let name = name_of(&repository);
        let cases = [
            (ERROR_DISK_FULL, "disk-full"),
            (ERROR_HANDLE_DISK_FULL, "disk-full"),
            (ERROR_ACCESS_DENIED, "access-denied"),
            (ERROR_INVALID_PARAMETER, "other"),
        ];
        for stage in [Stage::Write, Stage::Flush] {
            for (os_error, failure) in cases {
                markers.fail_next(stage, os_error);
                assert_eq!(
                    markers.started(&started(&repository, "op-1")),
                    StartedReply::Failure {
                        failure,
                        folder: recovery.clone()
                    },
                    "{stage:?} {os_error}"
                );
                assert_eq!(
                    entries(&recovery),
                    Vec::<String>::new(),
                    "{stage:?} {os_error}"
                );
                assert!(mutex_is_free(&name), "a failure releases the mutex");
            }
        }
    }

    #[test]
    fn an_unreadable_common_directory_identity_gives_failure_other() {
        let fixture = Fixture::new();
        let recovery = fixture.path("recovery");
        let markers = Markers::open(&recovery);
        let absent = Repository {
            worktree: fixture.path("gone"),
            common: fixture.path("gone\\.git"),
        };
        assert_eq!(
            markers.started(&started(&absent, "op-1")),
            StartedReply::Failure {
                failure: "other",
                folder: recovery.clone()
            }
        );
        assert_eq!(entries(&recovery), Vec::<String>::new());
    }

    #[test]
    fn the_marker_reply_carries_the_identity_that_named_the_mutex() {
        let fixture = Fixture::new();
        let repository = repository(&fixture, "repo");
        let markers = Markers::open(&fixture.path("recovery"));
        let StartedReply::Marker { identity, .. } = markers.started(&started(&repository, "op-1"))
        else {
            panic!("expected a marker");
        };
        assert_eq!(
            identity,
            read_identity(&repository.common).expect("identity")
        );
        assert_eq!(mutex_name(&identity), name_of(&repository));
        markers.ended("op-1");
    }

    #[test]
    fn a_stored_path_with_a_device_prefix_is_refused() {
        for device in [
            r"\\.\pipe\git",
            "//./pipe/git",
            r"\/.\C:\repo",
            r"\\?\C:\repo",
            r"\\?\UNC\server\share\repo",
            r"\\server",
            r"\\server\",
            r"\\.",
        ] {
            assert_eq!(channel_path(&json!(device)), None, "{device}");
        }
        for accepted in [
            r"C:\repo",
            "C:/repo",
            r"\\server\share\repo",
            "//server/share/repo",
        ] {
            assert!(channel_path(&json!(accepted)).is_some(), "{accepted}");
        }
    }

    #[test]
    fn the_started_replies_have_the_contract_shapes() {
        let call = "0f0f0f0f-0000-4000-8000-0000000000aa";
        assert_eq!(
            StartedReply::Marker {
                marker_id: "m-1".to_string(),
                identity: Identity {
                    volume_serial: 1,
                    file_id: [2; 16]
                }
            }
            .reply(call),
            json!({ "type": "started", "callId": call, "markerId": "m-1" })
        );
        assert_eq!(
            StartedReply::Busy.reply(call),
            json!({ "type": "started", "callId": call, "busy": true })
        );
        assert_eq!(
            StartedReply::Failure {
                failure: "disk-full",
                folder: PathBuf::from("C:\\data\\recovery")
            }
            .reply(call),
            json!({ "type": "started", "callId": call, "failure": "disk-full", "folder": "C:\\data\\recovery" })
        );
    }

    #[test]
    fn a_dismissal_deletes_the_marker_only_after_an_accepted_confirmation() {
        let fixture = Fixture::new();
        let repository = repository(&fixture, "repo");
        let recovery = fixture.path("recovery");
        let markers = Markers::open(&recovery);
        let id = marker_id(markers.started(&started(&repository, "op-1")));
        markers.ended("op-1");
        assert!(!markers.dismiss(&id, |_| false), "declined");
        assert_eq!(entries(&recovery), [format!("{id}.json")]);
        let mut shown = None;
        assert!(markers.dismiss(&id, |marker| {
            shown = Some(marker.worktree_root.clone());
            true
        }));
        assert_eq!(shown, Some(repository.worktree.clone()));
        assert_eq!(entries(&recovery), Vec::<String>::new());
        let mut asked = false;
        assert!(
            !markers.dismiss("0f0f0f0f-0000-4000-8000-0000000000ff", |_| {
                asked = true;
                true
            })
        );
        assert!(!asked, "an unknown marker shows no confirmation");
    }

    // ---- Trust records ----

    struct Worktree {
        root: PathBuf,
        git_directory: PathBuf,
        common: PathBuf,
    }

    /// A main worktree: the Git directory is the common directory.
    fn main_worktree(fixture: &Fixture, name: &str) -> Worktree {
        let repository = repository(fixture, name);
        Worktree {
            root: repository.worktree,
            git_directory: repository.common.clone(),
            common: repository.common,
        }
    }

    /// A linked worktree of `main`: its Git directory is `<common>\worktrees\<name>`.
    fn linked_worktree(fixture: &Fixture, main: &Worktree, name: &str) -> Worktree {
        let git_directory = main.common.join("worktrees").join(name);
        std::fs::create_dir_all(&git_directory).expect("linked Git directory");
        Worktree {
            root: folder(fixture, name),
            git_directory,
            common: main.common.clone(),
        }
    }

    fn confirm(worktree: &Worktree, fingerprint: &str, persist: bool) -> Confirm {
        Confirm {
            worktree_root: worktree.root.clone(),
            git_directory: worktree.git_directory.clone(),
            common_directory: worktree.common.clone(),
            git_selected_path: PathBuf::from(GIT_PATH),
            fingerprint: fingerprint.to_string(),
            persist,
            bound: (!persist).then(|| "file-count".to_string()),
        }
    }

    fn approved(trust: &Trust, request: &Confirm) -> Option<Value> {
        match trust.confirm(request, |_| true) {
            Confirmed::Approved { record } => record,
            Confirmed::Declined => panic!("an accepted confirmation approves"),
        }
    }

    fn roots(trust: &Trust) -> Vec<String> {
        let mut roots: Vec<String> = trust
            .records()
            .iter()
            .map(|record| {
                record["worktreeRoot"]
                    .as_str()
                    .expect("worktreeRoot")
                    .to_string()
            })
            .collect();
        roots.sort();
        roots
    }

    fn text(path: &Path) -> String {
        path.to_str().expect("UTF-8 path").to_string()
    }

    #[test]
    fn an_accepted_confirm_writes_one_record_with_only_the_contract_fields() {
        assert_eq!((TRUST_RECORD_BYTES, TRUST_RECORD_LIMIT), (4096, 256));
        let fixture = Fixture::new();
        let worktree = main_worktree(&fixture, "repo");
        let folder = fixture.path("trust");
        let trust = Trust::open(&folder);
        let request = confirm(&worktree, FINGERPRINT, true);
        let mut shown = None;
        let reply = trust.confirm(&request, |shown_request| {
            shown = Some(shown_request.clone());
            true
        });
        assert_eq!(shown, Some(request.clone()));
        let Confirmed::Approved {
            record: Some(record),
        } = reply
        else {
            panic!("expected a stored record, got {reply:?}");
        };
        assert_eq!(
            keys(&record),
            sorted(&[
                "commonDirectory",
                "commonIdentity",
                "worktreeRoot",
                "gitDirectory",
                "worktreeIdentity",
                "configurationFingerprint",
                "approvedAt",
                "gitSelectedPath",
            ])
        );
        assert_eq!(record["commonDirectory"], json!(worktree.common));
        assert_eq!(record["commonIdentity"], identity_reply(&worktree.common));
        assert_eq!(record["worktreeRoot"], json!(worktree.root));
        assert_eq!(record["gitDirectory"], json!(worktree.git_directory));
        assert_eq!(
            record["worktreeIdentity"],
            json!([
                identity_reply(&worktree.root),
                identity_reply(&worktree.git_directory)
            ])
        );
        assert_eq!(record["configurationFingerprint"], json!(FINGERPRINT));
        assert_eq!(record["gitSelectedPath"], json!(GIT_PATH));
        assert!(is_utc_time(
            record["approvedAt"].as_str().expect("approvedAt")
        ));
        assert_eq!(trust.records(), vec![record.clone()]);
        let files = entries(&folder);
        assert_eq!(files.len(), 1, "one record file");
        let stored: Value =
            serde_json::from_slice(&std::fs::read(folder.join(&files[0])).expect("read record"))
                .expect("record JSON");
        assert_eq!(
            stored, record,
            "the file holds the handshake form and no other field"
        );
    }

    #[test]
    fn a_declined_confirmation_writes_nothing() {
        let fixture = Fixture::new();
        let worktree = main_worktree(&fixture, "repo");
        let folder = fixture.path("trust");
        let trust = Trust::open(&folder);
        assert_eq!(
            trust.confirm(&confirm(&worktree, FINGERPRINT, true), |_| false),
            Confirmed::Declined
        );
        assert_eq!(trust.records(), Vec::<Value>::new());
        assert_eq!(entries(&folder), Vec::<String>::new());
    }

    #[test]
    fn a_second_approval_of_a_worktree_replaces_its_record() {
        let fixture = Fixture::new();
        let worktree = main_worktree(&fixture, "repo");
        let trust = Trust::open(&fixture.path("trust"));
        approved(&trust, &confirm(&worktree, FINGERPRINT, true)).expect("stored");
        let second = approved(&trust, &confirm(&worktree, DIGEST, true)).expect("stored");
        assert_eq!(trust.records(), vec![second.clone()]);
        assert_eq!(second["configurationFingerprint"], json!(DIGEST));
    }

    #[test]
    fn a_linked_worktree_adds_a_record_and_keeps_the_first() {
        let fixture = Fixture::new();
        let main = main_worktree(&fixture, "repo");
        let linked = linked_worktree(&fixture, &main, "linked");
        let trust = Trust::open(&fixture.path("trust"));
        approved(&trust, &confirm(&main, FINGERPRINT, true)).expect("stored");
        approved(&trust, &confirm(&linked, FINGERPRINT, true)).expect("stored");
        assert_eq!(
            roots(&trust),
            sorted(&[&text(&main.root), &text(&linked.root)])
        );
    }

    #[test]
    fn an_approval_without_persist_writes_no_record_and_deletes_the_records_of_the_worktree() {
        let fixture = Fixture::new();
        let main = main_worktree(&fixture, "repo");
        let linked = linked_worktree(&fixture, &main, "linked");
        let trust = Trust::open(&fixture.path("trust"));
        approved(&trust, &confirm(&main, FINGERPRINT, true)).expect("stored");
        approved(&trust, &confirm(&linked, FINGERPRINT, true)).expect("stored");
        assert_eq!(approved(&trust, &confirm(&main, DIGEST, false)), None);
        assert_eq!(
            roots(&trust),
            [text(&linked.root)],
            "another worktree keeps its record"
        );
    }

    #[test]
    fn revoke_deletes_every_worktree_record_of_the_common_directory_and_returns_the_closed_count() {
        let fixture = Fixture::new();
        let main = main_worktree(&fixture, "repo");
        let linked = linked_worktree(&fixture, &main, "linked");
        let other = main_worktree(&fixture, "other");
        let trust = Trust::open(&fixture.path("trust"));
        for worktree in [&main, &linked, &other] {
            approved(&trust, &confirm(worktree, FINGERPRINT, true)).expect("stored");
        }
        let mut tag = None;
        let ended = trust.revoke(&main.common, |identity| {
            tag = Some(*identity);
            3
        });
        assert_eq!(ended, 3, "the reply carries the count of the close by tag");
        assert_eq!(tag, Some(read_identity(&main.common).expect("identity")));
        assert_eq!(roots(&trust), [text(&other.root)]);
    }

    #[test]
    fn revoke_with_an_unreadable_identity_returns_0() {
        let fixture = Fixture::new();
        let main = main_worktree(&fixture, "repo");
        let trust = Trust::open(&fixture.path("trust"));
        approved(&trust, &confirm(&main, FINGERPRINT, true)).expect("stored");
        let mut closed = false;
        let ended = trust.revoke(&fixture.path("gone\\.git"), |_| {
            closed = true;
            5
        });
        assert_eq!(ended, 0);
        assert!(!closed, "no tag, no close");
        assert_eq!(trust.records().len(), 1);
    }

    #[test]
    fn a_moved_repository_keeps_its_identity_for_revoke_and_replacement() {
        let fixture = Fixture::new();
        let trust = Trust::open(&fixture.path("trust"));
        let first = main_worktree(&fixture, "repo-a");
        approved(&trust, &confirm(&first, FINGERPRINT, true)).expect("stored");
        std::fs::rename(&first.root, fixture.path("repo-b")).expect("move within the volume");
        let moved = Worktree {
            root: fixture.path("repo-b"),
            git_directory: fixture.path("repo-b\\.git"),
            common: fixture.path("repo-b\\.git"),
        };
        trust.revoke(&moved.common, |_| 0);
        assert_eq!(
            trust.records(),
            Vec::<Value>::new(),
            "revoke from the new path"
        );
        approved(&trust, &confirm(&moved, FINGERPRINT, true)).expect("stored");
        std::fs::rename(&moved.root, fixture.path("repo-c")).expect("move within the volume");
        let again = Worktree {
            root: fixture.path("repo-c"),
            git_directory: fixture.path("repo-c\\.git"),
            common: fixture.path("repo-c\\.git"),
        };
        approved(&trust, &confirm(&again, DIGEST, true)).expect("stored");
        assert_eq!(
            roots(&trust),
            [text(&again.root)],
            "the new approval replaces the record"
        );
    }

    #[test]
    fn a_257th_record_replaces_the_oldest() {
        let fixture = Fixture::new();
        let main = main_worktree(&fixture, "repo");
        let trust = Trust::open(&fixture.path("trust"));
        let worktrees: Vec<Worktree> = (0..=TRUST_RECORD_LIMIT)
            .map(|n| linked_worktree(&fixture, &main, &format!("w{n:03}")))
            .collect();
        for worktree in &worktrees {
            approved(&trust, &confirm(worktree, FINGERPRINT, true)).expect("stored");
        }
        let roots = roots(&trust);
        assert_eq!(roots.len(), TRUST_RECORD_LIMIT);
        assert!(
            !roots.contains(&text(&worktrees[0].root)),
            "the oldest record goes"
        );
        assert!(roots.contains(&text(&worktrees[1].root)));
        assert!(roots.contains(&text(&worktrees[TRUST_RECORD_LIMIT].root)));
    }

    #[test]
    fn a_record_above_4_kib_is_refused() {
        let fixture = Fixture::new();
        let mut root = fixture.path("long");
        for _ in 0..21 {
            root.push("d".repeat(200));
        }
        std::fs::create_dir_all(root.join(".git")).expect("long worktree");
        let worktree = Worktree {
            git_directory: root.join(".git"),
            common: root.join(".git"),
            root,
        };
        let folder = fixture.path("trust");
        let trust = Trust::open(&folder);
        assert_eq!(
            approved(&trust, &confirm(&worktree, FINGERPRINT, true)),
            None,
            "the approval holds for the session only"
        );
        assert_eq!(trust.records(), Vec::<Value>::new());
        assert_eq!(entries(&folder), Vec::<String>::new());
    }

    #[test]
    fn a_failed_record_write_gives_stored_false_and_keeps_the_records() {
        let fixture = Fixture::new();
        let worktree = main_worktree(&fixture, "repo");
        let trust = Trust::open(&fixture.path("trust"));
        let first = approved(&trust, &confirm(&worktree, FINGERPRINT, true)).expect("stored");
        for stage in [Stage::Write, Stage::Flush] {
            trust.fail_next(stage, ERROR_DISK_FULL);
            assert_eq!(
                approved(&trust, &confirm(&worktree, DIGEST, true)),
                None,
                "{stage:?}"
            );
            assert_eq!(trust.records(), vec![first.clone()], "{stage:?}");
        }
    }

    #[test]
    fn the_confirm_replies_have_the_contract_shapes() {
        let call = "0f0f0f0f-0000-4000-8000-0000000000bb";
        let record = json!({ "worktreeRoot": "C:\\repo" });
        assert_eq!(
            Confirmed::Approved {
                record: Some(record.clone())
            }
            .reply(call),
            json!({ "type": "confirm", "callId": call, "result": "approved", "stored": true, "record": record })
        );
        assert_eq!(
            Confirmed::Approved { record: None }.reply(call),
            json!({ "type": "confirm", "callId": call, "result": "approved", "stored": false })
        );
        assert_eq!(
            Confirmed::Declined.reply(call),
            json!({ "type": "confirm", "callId": call, "result": "declined" })
        );
    }

    #[test]
    fn the_handshake_carries_every_record() {
        let fixture = Fixture::new();
        let main = main_worktree(&fixture, "repo");
        let linked = linked_worktree(&fixture, &main, "linked");
        let folder = fixture.path("trust");
        {
            let first = Trust::open(&folder);
            approved(&first, &confirm(&main, FINGERPRINT, true)).expect("stored");
            approved(&first, &confirm(&linked, FINGERPRINT, true)).expect("stored");
        }
        let reopened = Trust::open(&folder);
        assert_eq!(
            roots(&reopened),
            sorted(&[&text(&main.root), &text(&linked.root)])
        );
    }

    // ---- Added with T059 ----

    #[test]
    fn an_injected_write_or_flush_failure_leaves_the_previous_settings_file() {
        let fixture = Fixture::new();
        let path = fixture.path("settings.json");
        save(&path, &full_settings(&fixture)).expect("save");
        let bytes = std::fs::read(&path).expect("read");
        for stage in [Stage::Write, Stage::Flush] {
            let result = save_with(&path, &Settings::default(), Some((stage, ERROR_DISK_FULL)));
            assert!(result.is_err(), "{stage:?}");
            assert_eq!(std::fs::read(&path).expect("read"), bytes, "{stage:?}");
            assert_eq!(entries(&fixture.0), ["settings.json"], "{stage:?}");
        }
    }

    #[test]
    fn a_service_exit_releases_every_mutex_and_keeps_the_marker_files() {
        let fixture = Fixture::new();
        let first = repository(&fixture, "repo");
        let second = repository(&fixture, "other");
        let recovery = fixture.path("recovery");
        let markers = Markers::open(&recovery);
        let a = marker_id(markers.started(&started(&first, "op-1")));
        let b = marker_id(markers.started(&started(&second, "op-2")));
        markers.service_exited();
        assert!(mutex_is_free(&name_of(&first)));
        assert!(mutex_is_free(&name_of(&second)));
        assert_eq!(
            entries(&recovery),
            sorted(&[&format!("{a}.json"), &format!("{b}.json")])
        );
    }

    #[test]
    fn a_marker_that_the_handshake_decoder_refuses_is_damaged() {
        let fixture = Fixture::new();
        let repository = repository(&fixture, "repo");
        let recovery = folder(&fixture, "recovery");
        let id = write_marker(&recovery, &repository, 1, 0);
        let path = recovery.join(format!("{id}.json"));
        let valid: Value =
            serde_json::from_slice(&std::fs::read(&path).expect("read")).expect("JSON");
        let cases: [(&str, &str, Value); 7] = [
            (
                "a markerId that differs from the file name",
                "markerId",
                json!("0f0f0f0f-0000-4000-8000-0000000000ff"),
            ),
            (
                "a day that does not exist",
                "startedAt",
                json!("2026-02-29T00:00:00Z"),
            ),
            ("an offset", "startedAt", json!("2026-01-01T00:00:00+00:00")),
            (
                "a two-digit year",
                "startedAt",
                json!("0099-01-01T00:00:00Z"),
            ),
            ("an unknown kind", "kind", json!("merge")),
            ("a root-relative path", "worktreeRoot", json!("\\repo")),
            (
                "an uppercase identity",
                "commonIdentity",
                json!({ "volumeSerial": "00000000000000AB", "fileId": "0".repeat(32) }),
            ),
        ];
        for (name, key, value) in cases {
            let mut marker = valid.clone();
            marker[key] = value;
            std::fs::write(&path, marker.to_string()).expect("write");
            let scan = Markers::open(&recovery).scan();
            assert_eq!(
                (scan.markers.len(), scan.unloaded, scan.damaged.len()),
                (0, 0, 1),
                "{name}"
            );
        }
    }

    #[test]
    fn civil_from_days_gives_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(civil_from_days(20_729), (2026, 10, 3));
        assert!(is_utc_time(&utc_now()));
    }
}
