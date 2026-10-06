// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher, RandomState};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, HANDLE};
use windows::Win32::Storage::FileSystem::{
    FILE_FLAG_BACKUP_SEMANTICS, FILE_ID_INFO, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FileIdInfo, GetFileInformationByHandleEx,
};

/// A bootstrap context lasts at most 60 seconds (contract §6 "Registration bootstrap").
pub const CONTEXT_LIFETIME: Duration = Duration::from_secs(60);

/// A native physical identity: the 64-bit volume serial number and the 128-bit file ID of `FILE_ID_INFO` (contract §6).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Identity {
    pub volume_serial: u64,
    pub file_id: [u8; 16],
}

impl Identity {
    /// Refuses the all-zero and the all-ones file ID with `UNSUPPORTED_REPOSITORY` (MS-FSCC, research R2).
    pub fn checked(volume_serial: u64, file_id: [u8; 16]) -> Result<Identity, &'static str> {
        if file_id == [0; 16] || file_id == [0xff; 16] {
            return Err("UNSUPPORTED_REPOSITORY");
        }
        Ok(Identity {
            volume_serial,
            file_id,
        })
    }

    /// The identity reply `{"volumeSerial":"<16 hex>","fileId":"<32 hex>"}` (contract §6 "Process fields").
    pub fn reply(&self) -> serde_json::Value {
        let file_id: String = self.file_id.iter().map(|b| format!("{b:02x}")).collect();
        serde_json::json!({
            "volumeSerial": format!("{:016x}", self.volume_serial),
            "fileId": file_id,
        })
    }
}

/// Opens `path` with `FILE_READ_ATTRIBUTES`, full sharing, and `FILE_FLAG_BACKUP_SEMANTICS`.
pub(crate) fn open(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES.0)
        .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
        .open(path)
}

/// True for an open error of `ERROR_FILE_NOT_FOUND` or `ERROR_PATH_NOT_FOUND`.
fn not_found(error: &std::io::Error) -> bool {
    error.raw_os_error().is_some_and(|code| {
        code == ERROR_FILE_NOT_FOUND.0 as i32 || code == ERROR_PATH_NOT_FOUND.0 as i32
    })
}

/// True when the identity open of `path` fails with `ERROR_FILE_NOT_FOUND` or `ERROR_PATH_NOT_FOUND`.
pub fn is_absent(path: &Path) -> bool {
    open(path).is_err_and(|error| not_found(&error))
}

/// Opens `path` as `open` does, then reads `FileIdInfo`.
pub fn read_identity(path: &Path) -> Result<Identity, &'static str> {
    file_identity(&open(path).map_err(|_| "UNSUPPORTED_REPOSITORY")?)
}

/// One entry of an identity reply (contract §6 "Process fields"). Only a not-found open adds `reason` `absent`.
/// `None` when `stop` is set after the open (contract §6 "Walks").
pub fn identity_reply(path: &Path, stop: &AtomicBool) -> Option<serde_json::Value> {
    Some(match open(path) {
        Ok(_) if stop.load(Ordering::SeqCst) => return None,
        Ok(file) => file_identity(&file).map_or_else(
            |code| serde_json::json!({ "code": code }),
            |identity| identity.reply(),
        ),
        Err(error) if not_found(&error) => {
            serde_json::json!({ "code": "UNSUPPORTED_REPOSITORY", "reason": "absent" })
        }
        Err(_) => serde_json::json!({ "code": "UNSUPPORTED_REPOSITORY" }),
    })
}

/// Reads `FileIdInfo` through the handle of `file`.
fn file_identity(file: &std::fs::File) -> Result<Identity, &'static str> {
    let mut info = FILE_ID_INFO::default();
    // SAFETY: `file` keeps the handle open, and `info` has the passed size.
    unsafe {
        GetFileInformationByHandleEx(
            HANDLE(file.as_raw_handle()),
            FileIdInfo,
            (&raw mut info).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    }
    .map_err(|_| "UNSUPPORTED_REPOSITORY")?;
    Identity::checked(info.VolumeSerialNumber, info.FileId.Identifier)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContextKind {
    GitProbe,
    RepositoryDiscovery,
}

#[derive(Clone, Debug)]
pub struct Context {
    pub kind: ContextKind,
    pub path: PathBuf,
    pub identity: Identity,
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "only tests read the session of a context")
    )]
    pub session_id: String,
    pub expires_at: Instant,
    /// The path that the user selected. A `resolveGit` move keeps it (contract §3 "Git proposal").
    pub selected: PathBuf,
    /// A startup `gitProbe` context registers without Use this Git (contract §6 "Startup contexts").
    /// The service admits only a resolved file inside the installation root of the selected path.
    pub startup: bool,
}

/// The options that a discovery `symbolic-ref` permits besides the one name `HEAD` (contract §6 "Registration bootstrap").
const SYMBOLIC_REF_OPTIONS: [&str; 3] = ["-q", "--quiet", "--short"];

/// The two configuration path reads of a `gitProbe` context (contract §7 "Configuration file paths").
/// The shell holds no admission state. The service runs them only after its admission checks.
const CONFIGURATION_PATH_READS: [[&str; 3]; 2] = [
    ["--no-lazy-fetch", "var", "GIT_CONFIG_SYSTEM"],
    ["--no-lazy-fetch", "var", "GIT_CONFIG_GLOBAL"],
];

/// A `refs/` name that `git check-ref-format` without options accepts.
/// The rules are the list in the git-check-ref-format(1) "DESCRIPTION" section of Git 2.56.0.
/// The `refs/` prefix also refuses `@`, a leading `/`, and option-like names such as `--foo`.
fn is_ref_name(name: &str) -> bool {
    name.starts_with("refs/")
        && !name.ends_with('/')
        && !name.ends_with('.')
        && !name.contains("..")
        && !name.contains("@{")
        && name.split('/').all(|component| {
            !component.is_empty() && !component.starts_with('.') && !component.ends_with(".lock")
        })
        && name
            .bytes()
            .all(|b| b >= 0x20 && b != 0x7f && !b" ~^:?*[\\".contains(&b))
}

/// The native bootstrap contexts of one service session.
pub struct Contexts {
    state: Mutex<State>,
}

struct State {
    session_id: String,
    contexts: HashMap<String, Context>,
    /// `RandomState` takes its keys from the OS random source.
    keys: RandomState,
    issued: u64,
}

impl State {
    /// A UUID-shaped ID: 64 keyed SipHash bits of the issue count, then the count itself, so no ID repeats in a process.
    fn next_id(&mut self) -> String {
        self.issued += 1;
        let mut hasher = self.keys.build_hasher();
        hasher.write_u64(self.issued);
        let random = hasher.finish();
        format!(
            "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
            random >> 32,
            (random >> 16) & 0xffff,
            random & 0xfff,
            0x8000 | ((self.issued >> 48) & 0x3fff),
            self.issued & 0xffff_ffff_ffff,
        )
    }

    fn live(&self, bootstrap_id: &str, now: Instant) -> Result<&Context, &'static str> {
        self.contexts
            .get(bootstrap_id)
            .filter(|context| now < context.expires_at)
            .ok_or("UNKNOWN_TARGET")
    }
}

impl Contexts {
    pub fn new(session_id: &str) -> Contexts {
        Contexts {
            state: Mutex::new(State {
                session_id: session_id.to_string(),
                contexts: HashMap::new(),
                keys: RandomState::new(),
                issued: 0,
            }),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Binds a new context to the selected path and its identity. Returns its UUID-shaped `bootstrapId`.
    pub fn create(
        &self,
        kind: ContextKind,
        path: &Path,
        now: Instant,
    ) -> Result<String, &'static str> {
        self.insert(kind, path, path, false, now)
    }

    /// Creates the startup `gitProbe` context for the saved selected path.
    pub fn create_startup(&self, selected: &Path, now: Instant) -> Result<String, &'static str> {
        self.insert(ContextKind::GitProbe, selected, selected, true, now)
    }

    /// Creates the `gitProbe` context of a `resolveGit` move. It keeps the selected path and the startup state of `from`.
    pub fn create_moved(
        &self,
        from: &Context,
        resolved: &Path,
        now: Instant,
    ) -> Result<String, &'static str> {
        self.insert(
            ContextKind::GitProbe,
            resolved,
            &from.selected,
            from.startup,
            now,
        )
    }

    fn insert(
        &self,
        kind: ContextKind,
        path: &Path,
        selected: &Path,
        startup: bool,
        now: Instant,
    ) -> Result<String, &'static str> {
        let identity = read_identity(path).map_err(|code| match kind {
            ContextKind::GitProbe => "GIT_UNAVAILABLE",
            ContextKind::RepositoryDiscovery => code,
        })?;
        let mut state = self.state();
        state.contexts.retain(|_, context| now < context.expires_at);
        let id = state.next_id();
        let context = Context {
            kind,
            path: path.to_path_buf(),
            identity,
            session_id: state.session_id.clone(),
            expires_at: now + CONTEXT_LIFETIME,
            selected: selected.to_path_buf(),
            startup,
        };
        state.contexts.insert(id.clone(), context);
        Ok(id)
    }

    /// A live context. An unknown, destroyed, or expired ID gives `UNKNOWN_TARGET`.
    pub fn get(&self, bootstrap_id: &str, now: Instant) -> Result<Context, &'static str> {
        self.state().live(bootstrap_id, now).cloned()
    }

    /// Checks the arguments against the permitted probe of the context. A refused array gives `INVALID_REQUEST`.
    pub fn permits(
        &self,
        bootstrap_id: &str,
        arguments: &[String],
        now: Instant,
    ) -> Result<(), &'static str> {
        let permitted = match self.get(bootstrap_id, now)?.kind {
            ContextKind::GitProbe => {
                arguments == ["--exec-path"]
                    || arguments == ["version", "--build-options"]
                    || CONFIGURATION_PATH_READS
                        .iter()
                        .any(|read| arguments == read)
            }
            ContextKind::RepositoryDiscovery => match arguments {
                [prefix, command, rest @ ..] if prefix == "--no-lazy-fetch" => {
                    match command.as_str() {
                        "rev-parse" => true,
                        "show-ref" => match rest {
                            [head, verify, name] => {
                                head == "--head" && verify == "--verify" && name == "HEAD"
                            }
                            [exists, name] => exists == "--exists" && is_ref_name(name),
                            _ => false,
                        },
                        "symbolic-ref" => {
                            rest.iter().filter(|a| *a == "HEAD").count() == 1
                                && rest.iter().all(|a| {
                                    a == "HEAD" || SYMBOLIC_REF_OPTIONS.contains(&a.as_str())
                                })
                        }
                        _ => false,
                    }
                }
                _ => false,
            },
        };
        if permitted {
            Ok(())
        } else {
            Err("INVALID_REQUEST")
        }
    }

    /// Reads the identity of the selected path again. A changed identity destroys the context.
    /// The code is `GIT_CHANGED` for `gitProbe` and `UNKNOWN_TARGET` for `repositoryDiscovery`.
    pub fn revalidate(&self, bootstrap_id: &str, now: Instant) -> Result<(), &'static str> {
        let context = self.get(bootstrap_id, now)?;
        if read_identity(&context.path) == Ok(context.identity) {
            return Ok(());
        }
        self.destroy(bootstrap_id);
        Err(match context.kind {
            ContextKind::GitProbe => "GIT_CHANGED",
            ContextKind::RepositoryDiscovery => "UNKNOWN_TARGET",
        })
    }

    /// Cancel, failure, and completion destroy the context.
    pub fn destroy(&self, bootstrap_id: &str) {
        self.state().contexts.remove(bootstrap_id);
    }

    /// A service restart destroys every context and starts a new session.
    pub fn restart(&self, session_id: &str) {
        let mut state = self.state();
        state.contexts.clear();
        state.session_id = session_id.to_string();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;

    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_ID_INFO, FileIdInfo, GetFileInformationByHandleEx,
    };

    use crate::jobs::tests::Fixture;

    const SESSION: &str = "11111111-1111-4111-8111-111111111111";
    const NEXT_SESSION: &str = "22222222-2222-4222-8222-222222222222";

    fn strings(arguments: &[&str]) -> Vec<String> {
        arguments.iter().map(|s| s.to_string()).collect()
    }

    /// An independent `FileIdInfo` read through a `std::fs::File` handle.
    fn oracle(path: &Path) -> (u64, [u8; 16]) {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
            .open(path)
            .expect("open");
        let mut info = FILE_ID_INFO::default();
        let size = size_of::<FILE_ID_INFO>() as u32;
        unsafe {
            GetFileInformationByHandleEx(
                HANDLE(file.as_raw_handle()),
                FileIdInfo,
                (&raw mut info).cast(),
                size,
            )
        }
        .expect("FileIdInfo");
        (info.VolumeSerialNumber, info.FileId.Identifier)
    }

    fn uuid_shaped(id: &str) -> bool {
        id.len() == 36
            && id.char_indices().all(|(i, c)| {
                if [8, 13, 18, 23].contains(&i) {
                    c == '-'
                } else {
                    c.is_ascii_hexdigit() && !c.is_ascii_uppercase()
                }
            })
    }

    fn file(fixture: &Fixture, name: &str) -> PathBuf {
        let path = fixture.path(name);
        std::fs::write(&path, name).expect("write fixture file");
        path
    }

    #[test]
    fn the_identity_is_the_volume_serial_and_the_128_bit_file_id_of_an_open_handle() {
        let fixture = Fixture::new();
        let directory = fixture.path("selected");
        std::fs::create_dir(&directory).expect("mkdir");
        let other = file(&fixture, "other.txt");
        let identity = read_identity(&directory).expect("directory identity");
        let (serial, file_id) = oracle(&directory);
        assert_eq!(
            identity,
            Identity {
                volume_serial: serial,
                file_id
            },
            "FileIdInfo of the directory"
        );
        assert_eq!(
            read_identity(&directory).expect("again"),
            identity,
            "stable"
        );
        let other_identity = read_identity(&other).expect("file identity");
        assert_ne!(
            other_identity, identity,
            "another object has another identity"
        );
        assert_eq!(
            other_identity.volume_serial, identity.volume_serial,
            "same volume"
        );
    }

    #[test]
    fn a_set_stop_flag_gives_no_identity_entry_after_the_open() {
        let fixture = Fixture::new();
        let path = fixture.path("file");
        std::fs::write(&path, "abc").expect("fixture file");
        let expected = read_identity(&path).expect("identity").reply();
        assert_eq!(
            identity_reply(&path, &AtomicBool::new(false)),
            Some(expected)
        );
        assert_eq!(
            identity_reply(&path, &AtomicBool::new(true)),
            None,
            "the walk queries no identity after a stop (contract §6 \"Walks\")"
        );
    }

    #[test]
    fn the_identity_reply_uses_lowercase_hex_in_array_order() {
        let mut file_id = [0u8; 16];
        for (i, byte) in file_id.iter_mut().enumerate() {
            *byte = (i as u8) * 0x11;
        }
        let identity = Identity {
            volume_serial: 0x4474_2150_7421_4650,
            file_id,
        };
        let expected = serde_json::json!({ "volumeSerial": "4474215074214650", "fileId": "00112233445566778899aabbccddeeff" });
        assert_eq!(identity.reply(), expected);
        let small = Identity {
            volume_serial: 0xab,
            file_id: [0; 16],
        };
        assert_eq!(
            small.reply()["volumeSerial"],
            "00000000000000ab",
            "16 digits"
        );
    }

    #[test]
    fn a_context_binds_the_path_identity_session_probe_and_a_60_second_expiry() {
        let fixture = Fixture::new();
        let git = file(&fixture, "git.exe");
        let contexts = Contexts::new(SESSION);
        let now = Instant::now();
        let id = contexts
            .create(ContextKind::GitProbe, &git, now)
            .expect("create");
        assert!(uuid_shaped(&id), "UUID-shaped bootstrapId: {id}");
        let context = contexts.get(&id, now).expect("get");
        assert_eq!(context.kind, ContextKind::GitProbe);
        assert_eq!(context.path, git);
        assert_eq!(context.identity, read_identity(&git).expect("identity"));
        assert_eq!(context.session_id, SESSION);
        assert_eq!(context.expires_at, now + CONTEXT_LIFETIME);
        assert!(
            contexts.get(&id, now + Duration::from_secs(59)).is_ok(),
            "live at 59 s"
        );
        assert_eq!(
            contexts.get(&id, now + CONTEXT_LIFETIME).err(),
            Some("UNKNOWN_TARGET"),
            "expired at 60 s"
        );
        let unknown = "33333333-3333-4333-8333-333333333333";
        assert_eq!(contexts.get(unknown, now).err(), Some("UNKNOWN_TARGET"));
    }

    #[test]
    fn cancel_failure_completion_and_service_restart_destroy_the_context() {
        let fixture = Fixture::new();
        let directory = fixture.path("selected");
        std::fs::create_dir(&directory).expect("mkdir");
        let contexts = Contexts::new(SESSION);
        let now = Instant::now();
        let ended = contexts
            .create(ContextKind::RepositoryDiscovery, &directory, now)
            .expect("create");
        contexts.destroy(&ended);
        assert_eq!(
            contexts.get(&ended, now).err(),
            Some("UNKNOWN_TARGET"),
            "destroyed by cancel, failure, or completion"
        );
        let before = contexts
            .create(ContextKind::RepositoryDiscovery, &directory, now)
            .expect("create");
        contexts.restart(NEXT_SESSION);
        assert_eq!(
            contexts.get(&before, now).err(),
            Some("UNKNOWN_TARGET"),
            "destroyed by a service restart"
        );
        let after = contexts
            .create(ContextKind::RepositoryDiscovery, &directory, now)
            .expect("create");
        assert_eq!(
            contexts.get(&after, now).expect("get").session_id,
            NEXT_SESSION
        );
    }

    #[test]
    fn a_changed_target_identity_requires_a_new_selection() {
        let fixture = Fixture::new();
        let git = file(&fixture, "git.exe");
        let directory = fixture.path("selected");
        std::fs::create_dir(&directory).expect("mkdir");
        let contexts = Contexts::new(SESSION);
        let now = Instant::now();
        let probe = contexts
            .create(ContextKind::GitProbe, &git, now)
            .expect("create");
        let discovery = contexts
            .create(ContextKind::RepositoryDiscovery, &directory, now)
            .expect("create");
        assert_eq!(
            contexts.revalidate(&probe, now),
            Ok(()),
            "an unchanged executable"
        );
        assert_eq!(
            contexts.revalidate(&discovery, now),
            Ok(()),
            "an unchanged directory"
        );
        std::fs::remove_file(&git).expect("remove");
        std::fs::write(&git, "replaced").expect("replace");
        std::fs::remove_dir(&directory).expect("remove");
        std::fs::create_dir(&directory).expect("replace");
        assert_eq!(
            contexts.revalidate(&probe, now),
            Err("GIT_CHANGED"),
            "a changed executable identity"
        );
        assert!(
            contexts.revalidate(&discovery, now).is_err(),
            "a changed directory identity"
        );
        assert_eq!(
            contexts.get(&probe, now).err(),
            Some("UNKNOWN_TARGET"),
            "the old selection is gone"
        );
        assert_eq!(
            contexts.get(&discovery, now).err(),
            Some("UNKNOWN_TARGET"),
            "the old selection is gone"
        );
    }

    #[test]
    fn a_git_probe_context_permits_only_the_exec_path_and_version_probes() {
        let fixture = Fixture::new();
        let git = file(&fixture, "git.exe");
        let contexts = Contexts::new(SESSION);
        let now = Instant::now();
        let id = contexts
            .create(ContextKind::GitProbe, &git, now)
            .expect("create");
        assert_eq!(
            contexts.permits(&id, &strings(&["version", "--build-options"]), now),
            Ok(())
        );
        assert_eq!(
            contexts.permits(&id, &strings(&["--exec-path"]), now),
            Ok(())
        );
        for refused in [
            &["version"][..],
            &["version", "--build-options", "--verbose"],
            &["--no-lazy-fetch", "version", "--build-options"],
            &["--build-options", "version"],
            &["--exec-path=C:\\other"],
            &["--exec-path", "version"],
            &["--no-lazy-fetch", "--exec-path"],
            &["--no-lazy-fetch", "rev-parse", "--show-toplevel"],
            &[],
        ] {
            assert_eq!(
                contexts.permits(&id, &strings(refused), now),
                Err("INVALID_REQUEST"),
                "{refused:?}"
            );
        }
    }

    #[test]
    fn a_git_probe_context_permits_exactly_the_two_configuration_path_reads() {
        let fixture = Fixture::new();
        let git = file(&fixture, "git.exe");
        let contexts = Contexts::new(SESSION);
        let now = Instant::now();
        let id = contexts
            .create(ContextKind::GitProbe, &git, now)
            .expect("create");
        for permitted in [
            &["--no-lazy-fetch", "var", "GIT_CONFIG_SYSTEM"][..],
            &["--no-lazy-fetch", "var", "GIT_CONFIG_GLOBAL"],
        ] {
            assert_eq!(
                contexts.permits(&id, &strings(permitted), now),
                Ok(()),
                "{permitted:?}"
            );
        }
        for refused in [
            &["--no-lazy-fetch", "var", "GIT_DIR"][..],
            &["--no-lazy-fetch", "var", "GIT_EDITOR"],
            &["--no-lazy-fetch", "var", "-l"],
            &["--no-lazy-fetch", "var", "git_config_system"],
            &[
                "--no-lazy-fetch",
                "var",
                "GIT_CONFIG_SYSTEM",
                "GIT_CONFIG_GLOBAL",
            ],
            &["--no-lazy-fetch", "var", "GIT_CONFIG_GLOBAL", "-l"],
            &["--no-lazy-fetch", "var"],
            &["var", "GIT_CONFIG_SYSTEM"],
        ] {
            assert_eq!(
                contexts.permits(&id, &strings(refused), now),
                Err("INVALID_REQUEST"),
                "{refused:?}"
            );
        }
    }

    #[test]
    fn a_discovery_context_permits_only_the_two_show_ref_forms() {
        let fixture = Fixture::new();
        let directory = fixture.path("selected");
        std::fs::create_dir(&directory).expect("mkdir");
        let contexts = Contexts::new(SESSION);
        let now = Instant::now();
        let id = contexts
            .create(ContextKind::RepositoryDiscovery, &directory, now)
            .expect("create");
        for permitted in [
            &["--no-lazy-fetch", "show-ref", "--head", "--verify", "HEAD"][..],
            &["--no-lazy-fetch", "show-ref", "--exists", "refs/heads/main"],
            &[
                "--no-lazy-fetch",
                "show-ref",
                "--exists",
                "refs/heads/feature/x-1",
            ],
        ] {
            assert_eq!(
                contexts.permits(&id, &strings(permitted), now),
                Ok(()),
                "{permitted:?}"
            );
        }
        for refused in [
            &["--no-lazy-fetch", "show-ref", "refs/heads/main"][..],
            &["--no-lazy-fetch", "show-ref", "--verify", "refs/heads/main"],
            &[
                "--no-lazy-fetch",
                "show-ref",
                "--head",
                "--verify",
                "HEAD",
                "-d",
            ],
            &["--no-lazy-fetch", "show-ref", "--verify", "--head", "HEAD"],
            &["--no-lazy-fetch", "show-ref"],
            &["--no-lazy-fetch", "show-ref", "--exists"],
            &[
                "--no-lazy-fetch",
                "show-ref",
                "--exists",
                "refs/heads/a",
                "refs/heads/b",
            ],
            &["--no-lazy-fetch", "show-ref", "refs/heads/main", "--exists"],
            &["--no-lazy-fetch", "show-ref", "--exists", "HEAD"],
            &["--no-lazy-fetch", "show-ref", "--exists", "heads/main"],
            &["--no-lazy-fetch", "show-ref", "--exists", "main"],
            &["--no-lazy-fetch", "show-ref", "--exists", "refs/"],
            &["--no-lazy-fetch", "show-ref", "--exists", "refs/heads/a..b"],
            &["--no-lazy-fetch", "show-ref", "--exists", "refs/heads/a\0b"],
            &["--no-lazy-fetch", "show-ref", "--exists", "--foo"],
            &["--no-lazy-fetch", "show-ref", "--exists", "--verify"],
            &[
                "--no-lazy-fetch",
                "show-ref",
                "--exists",
                "refs/heads/.hidden",
            ],
            &[
                "--no-lazy-fetch",
                "show-ref",
                "--exists",
                "refs/heads/x.lock",
            ],
            &["--no-lazy-fetch", "show-ref", "--exists", "refs/heads//x"],
            &["--no-lazy-fetch", "show-ref", "--exists", "refs/heads/x/"],
            &["--no-lazy-fetch", "show-ref", "--exists", "refs/heads/x."],
            &[
                "--no-lazy-fetch",
                "show-ref",
                "--exists",
                "refs/heads/x@{1}",
            ],
            &["--no-lazy-fetch", "show-ref", "--exists", "refs/heads/a b"],
            &["--no-lazy-fetch", "show-ref", "--exists", "refs/heads/a\\b"],
            &["--no-lazy-fetch", "show-ref", "--exists", "refs/heads/a~1"],
            &["--no-lazy-fetch", "show-ref", "--exists", "refs/heads/a^"],
            &["--no-lazy-fetch", "show-ref", "--exists", "refs/heads/a:b"],
            &["--no-lazy-fetch", "show-ref", "--exists", "refs/heads/a?"],
            &["--no-lazy-fetch", "show-ref", "--exists", "refs/heads/a*"],
            &["--no-lazy-fetch", "show-ref", "--exists", "refs/heads/a[b"],
            &[
                "--no-lazy-fetch",
                "show-ref",
                "--exists",
                "refs/heads/a\x7f",
            ],
            &["--no-lazy-fetch", "show-ref", "--exists", "refs/heads/a\tb"],
        ] {
            assert_eq!(
                contexts.permits(&id, &strings(refused), now),
                Err("INVALID_REQUEST"),
                "{refused:?}"
            );
        }
    }

    #[test]
    fn a_discovery_context_permits_only_rev_parse_symbolic_ref_and_show_ref() {
        let fixture = Fixture::new();
        let directory = fixture.path("selected");
        std::fs::create_dir(&directory).expect("mkdir");
        let contexts = Contexts::new(SESSION);
        let now = Instant::now();
        let id = contexts
            .create(ContextKind::RepositoryDiscovery, &directory, now)
            .expect("create");
        for permitted in [
            &[
                "--no-lazy-fetch",
                "rev-parse",
                "--is-bare-repository",
                "--is-inside-git-dir",
            ][..],
            &[
                "--no-lazy-fetch",
                "rev-parse",
                "--show-toplevel",
                "--absolute-git-dir",
                "--git-common-dir",
            ],
            &["--no-lazy-fetch", "symbolic-ref", "-q", "HEAD"],
            &["--no-lazy-fetch", "show-ref", "--head", "--verify", "HEAD"],
        ] {
            assert_eq!(
                contexts.permits(&id, &strings(permitted), now),
                Ok(()),
                "{permitted:?}"
            );
        }
        for refused in [
            &["rev-parse", "--show-toplevel"][..],
            &["version", "--build-options"],
            &["--no-lazy-fetch", "status", "--porcelain=v2"],
            &["--no-lazy-fetch", "config", "list", "--show-scope"],
            &[
                "--no-lazy-fetch",
                "-c",
                "core.fsmonitor=calc",
                "rev-parse",
                "--show-toplevel",
            ],
            &["--no-lazy-fetch"],
        ] {
            assert_eq!(
                contexts.permits(&id, &strings(refused), now),
                Err("INVALID_REQUEST"),
                "{refused:?}"
            );
        }
    }

    #[test]
    fn a_discovery_context_permits_only_read_forms_of_symbolic_ref() {
        let fixture = Fixture::new();
        let directory = fixture.path("selected");
        std::fs::create_dir(&directory).expect("mkdir");
        let contexts = Contexts::new(SESSION);
        let now = Instant::now();
        let id = contexts
            .create(ContextKind::RepositoryDiscovery, &directory, now)
            .expect("create");
        for refused in [
            &["--no-lazy-fetch", "symbolic-ref", "HEAD", "refs/heads/x"][..],
            &["--no-lazy-fetch", "symbolic-ref", "-d", "HEAD"],
            &["--no-lazy-fetch", "symbolic-ref", "--delete", "HEAD"],
            &[
                "--no-lazy-fetch",
                "symbolic-ref",
                "-m",
                "msg",
                "HEAD",
                "refs/heads/x",
            ],
            &["--no-lazy-fetch", "symbolic-ref", "HEAD", "HEAD"],
            &["--no-lazy-fetch", "symbolic-ref"],
        ] {
            assert_eq!(
                contexts.permits(&id, &strings(refused), now),
                Err("INVALID_REQUEST"),
                "{refused:?}"
            );
        }
        for permitted in [
            &["--no-lazy-fetch", "symbolic-ref", "HEAD"][..],
            &["--no-lazy-fetch", "symbolic-ref", "-q", "HEAD"],
            &["--no-lazy-fetch", "symbolic-ref", "--short", "HEAD"],
            &[
                "--no-lazy-fetch",
                "symbolic-ref",
                "--quiet",
                "--short",
                "HEAD",
            ],
        ] {
            assert_eq!(
                contexts.permits(&id, &strings(permitted), now),
                Ok(()),
                "{permitted:?}"
            );
        }
    }

    #[test]
    fn no_context_permits_a_mutation() {
        let fixture = Fixture::new();
        let git = file(&fixture, "git.exe");
        let directory = fixture.path("selected");
        std::fs::create_dir(&directory).expect("mkdir");
        let contexts = Contexts::new(SESSION);
        let now = Instant::now();
        let probe = contexts
            .create(ContextKind::GitProbe, &git, now)
            .expect("create");
        let discovery = contexts
            .create(ContextKind::RepositoryDiscovery, &directory, now)
            .expect("create");
        for mutation in [
            &["--no-lazy-fetch", "commit", "--quiet", "--file=-"][..],
            &["--no-lazy-fetch", "update-index", "--add", "--", "a"],
            &[
                "--no-lazy-fetch",
                "update-ref",
                "HEAD",
                "0000000000000000000000000000000000000000",
            ],
            &["--no-lazy-fetch", "apply", "--cached"],
            &["--no-lazy-fetch", "checkout", "main"],
            &["--no-lazy-fetch", "submodule", "update", "--init"],
            &["--no-lazy-fetch", "config", "--add", "safe.directory", "*"],
            &["--no-lazy-fetch", "worktree", "add", "x"],
        ] {
            for id in [&probe, &discovery] {
                assert_eq!(
                    contexts.permits(id, &strings(mutation), now),
                    Err("INVALID_REQUEST"),
                    "{mutation:?}"
                );
            }
        }
    }
}
