// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The shell does not use these items yet. T037 removes this attribute.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

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
    pub fn checked(_volume_serial: u64, _file_id: [u8; 16]) -> Result<Identity, &'static str> {
        todo!("T034")
    }

    /// The identity reply `{"volumeSerial":"<16 hex>","fileId":"<32 hex>"}` (contract §6 "Process fields").
    pub fn reply(&self) -> serde_json::Value {
        todo!("T034")
    }
}

/// Opens `path` with `FILE_READ_ATTRIBUTES`, full sharing, and `FILE_FLAG_BACKUP_SEMANTICS`, then reads `FileIdInfo`.
pub fn read_identity(_path: &Path) -> Result<Identity, &'static str> {
    todo!("T034")
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
    pub session_id: String,
    pub expires_at: Instant,
}

/// The native bootstrap contexts of one service session.
pub struct Contexts {
    _private: (),
}

impl Contexts {
    pub fn new(_session_id: &str) -> Contexts {
        todo!("T034")
    }

    /// Binds a new context to the selected path and its identity. Returns its UUID-shaped `bootstrapId`.
    pub fn create(
        &self,
        _kind: ContextKind,
        _path: &Path,
        _now: Instant,
    ) -> Result<String, &'static str> {
        todo!("T034")
    }

    /// A live context. An unknown, destroyed, or expired ID gives `UNKNOWN_TARGET`.
    pub fn get(&self, _bootstrap_id: &str, _now: Instant) -> Result<Context, &'static str> {
        todo!("T034")
    }

    /// Checks the arguments against the permitted probe of the context. A refused array gives `INVALID_REQUEST`.
    pub fn permits(
        &self,
        _bootstrap_id: &str,
        _arguments: &[String],
        _now: Instant,
    ) -> Result<(), &'static str> {
        todo!("T034")
    }

    /// Reads the identity of the selected path again. A changed identity destroys the context.
    pub fn revalidate(&self, _bootstrap_id: &str, _now: Instant) -> Result<(), &'static str> {
        todo!("T034")
    }

    /// Cancel, failure, and completion destroy the context.
    pub fn destroy(&self, _bootstrap_id: &str) {
        todo!("T034")
    }

    /// A service restart destroys every context and starts a new session.
    pub fn restart(&self, _session_id: &str) {
        todo!("T034")
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
    fn a_git_probe_context_permits_only_version_build_options() {
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
        for refused in [
            &["version"][..],
            &["version", "--build-options", "--verbose"],
            &["--no-lazy-fetch", "version", "--build-options"],
            &["--build-options", "version"],
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
