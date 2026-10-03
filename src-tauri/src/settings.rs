// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "T059 implements the native settings and stores, and T063 wires them"
    )
)]
#![cfg_attr(
    test,
    expect(
        dead_code,
        reason = "the T059 stubs read no input until T059 implements them"
    )
)]

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::bootstrap::Identity;

// ---- Settings file (data-model §1) ----

/// The native settings. A missing or invalid entry is `None`, its documented default. This slice has no migration.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Settings {
    pub git: Option<SavedGit>,
    /// The last explicitly opened repository.
    pub last_repository: Option<PathBuf>,
    /// The window bounds in DIPs.
    pub window: Option<Bounds>,
}

/// The selected Git. Unknown or invalid values give no saved Git.
#[derive(Clone, Debug, PartialEq)]
pub struct SavedGit {
    /// An absolute path.
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
pub fn load(_path: &Path) -> Settings {
    todo!("T059")
}

/// Replaces the whole file. A failed write leaves the previous file.
pub fn save(_path: &Path, _settings: &Settings) -> std::io::Result<()> {
    todo!("T059")
}

/// Clamps the stored bounds, or `DEFAULT_SIZE` without them, into `work_area` (plan.md "Chosen layout, sizes, and DPI").
pub fn clamp(_stored: Option<Bounds>, _work_area: Bounds) -> Result<Bounds, InsufficientWorkArea> {
    todo!("T059")
}

// ---- Injected write faults ----

/// The write step that an injected fault fails.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Write,
    Flush,
}

// ---- Recovery markers (contract §6 "Recovery markers") ----

/// At most 4 KiB per marker file (contract §5).
pub const MARKER_BYTES: usize = 4096;
/// At most 64 markers per handshake (contract §5).
pub const MARKER_LIMIT: usize = 64;

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
        todo!("T059")
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
    Marker(String),
    Busy,
    /// `failure` is `disk-full`, `access-denied`, or `other`. `folder` is the `recovery` folder.
    Failure {
        failure: &'static str,
        folder: PathBuf,
    },
}

impl StartedReply {
    pub fn reply(&self, _call_id: &str) -> Value {
        todo!("T059")
    }
}

/// The markers of one handshake scan.
#[derive(Debug, PartialEq)]
pub struct Scan {
    pub markers: Vec<Marker>,
    /// The marker files that the shell did not load. A nonzero count is the limit result.
    pub unloaded: u32,
}

/// The name `Local\Arbareto-mutation-<SHA-256 of the identity>` (contract §6 "Recovery markers").
pub fn mutex_name(_identity: &Identity) -> String {
    todo!("T059")
}

/// The marker store of the `recovery` folder. One dedicated thread takes and releases every mutex.
pub struct Markers {}

impl Markers {
    /// Creates the folder when it is absent.
    pub fn open(_folder: &Path) -> Markers {
        todo!("T059")
    }

    pub fn started(&self, _request: &Started) -> StartedReply {
        todo!("T059")
    }

    /// Releases the mutex of the operation. The marker file stays.
    pub fn ended(&self, _operation_id: &str) {
        todo!("T059")
    }

    /// Deletes the marker file.
    pub fn resolved(&self, _marker_id: &str) {
        todo!("T059")
    }

    /// Rescans the folder. Takes ownership of each file that no running instance holds.
    pub fn scan(&self) -> Scan {
        todo!("T059")
    }

    /// Deletes the marker file only when `confirm` accepts. Returns true when the file is deleted.
    pub fn dismiss(&self, _marker_id: &str, _confirm: impl FnOnce(&Marker) -> bool) -> bool {
        todo!("T059")
    }

    /// Fails the next marker write at `stage` with the OS error code `os_error`.
    pub fn fail_next(&self, _stage: Stage, _os_error: i32) {
        todo!("T059")
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
    pub git_installation_digest: String,
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
    pub fn reply(&self, _call_id: &str) -> Value {
        todo!("T059")
    }
}

/// The record store of the `trust` folder.
pub struct Trust {}

impl Trust {
    /// Creates the folder when it is absent.
    pub fn open(_folder: &Path) -> Trust {
        todo!("T059")
    }

    /// Shows the confirmation through `accept`, then writes or deletes records.
    pub fn confirm(&self, _request: &Confirm, _accept: impl FnOnce(&Confirm) -> bool) -> Confirmed {
        todo!("T059")
    }

    /// Deletes the records of every worktree of the common directory.
    /// `close` closes the lingering Jobs with that identity tag and returns the ended process count.
    pub fn revoke(&self, _common_directory: &Path, _close: impl FnOnce(&Identity) -> u32) -> u32 {
        todo!("T059")
    }

    /// Every record in the handshake form.
    pub fn records(&self) -> Vec<Value> {
        todo!("T059")
    }

    /// Fails the next record write at `stage` with the OS error code `os_error`.
    pub fn fail_next(&self, _stage: Stage, _os_error: i32) {
        todo!("T059")
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
        }
    }

    /// The file form: `git` with `executablePath`, `version`, and `digest`; `lastRepository`; `window` with `x`, `y`, `width`, and `height`.
    fn settings_json(fixture: &Fixture) -> Value {
        json!({
            "git": {
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
        let cases: [(&str, &str, Value); 7] = [
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
            StartedReply::Marker(id) => id,
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
    fn a_marker_above_4_kib_stays_unloaded() {
        let fixture = Fixture::new();
        let repository = repository(&fixture, "repo");
        let recovery = folder(&fixture, "recovery");
        let small = write_marker(&recovery, &repository, 1, 0);
        write_marker(&recovery, &repository, 2, MARKER_BYTES);
        let scan = Markers::open(&recovery).scan();
        assert_eq!(scan.unloaded, 1);
        assert_eq!(scan.markers.len(), 1);
        assert_eq!(scan.markers[0].marker_id, small);
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
    fn the_started_replies_have_the_contract_shapes() {
        let call = "0f0f0f0f-0000-4000-8000-0000000000aa";
        assert_eq!(
            StartedReply::Marker("m-1".to_string()).reply(call),
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
            git_installation_digest: DIGEST.to_string(),
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
                "gitInstallationDigest",
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
        assert_eq!(record["gitInstallationDigest"], json!(DIGEST));
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
}
