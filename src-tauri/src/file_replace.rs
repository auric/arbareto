// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

//! Feature 005 contract Δ6 `fileReplace`: one atomic replace of `.gitignore` or `info/exclude` (plan.md D10).
//! The walk opens each component relative to its parent with `OBJ_DONT_REPARSE`. A complete temporary file renames over the target.

use std::os::windows::io::OwnedHandle;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use windows::Wdk::Storage::FileSystem::{
    FILE_CREATE, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT,
    FILE_RENAME_INFORMATION, FILE_RENAME_POSIX_SEMANTICS, FILE_RENAME_REPLACE_IF_EXISTS,
    FILE_SYNCHRONOUS_IO_NONALERT, FileAttributeTagInformation, FileRenameInformationEx,
    FileStandardInformation, NtSetInformationFile,
};
use windows::Wdk::System::SystemServices::FILE_ATTRIBUTE_TAG_INFORMATION;
use windows::Win32::Foundation::{
    NTSTATUS, STATUS_FILE_IS_A_DIRECTORY, STATUS_OBJECT_NAME_COLLISION,
    STATUS_OBJECT_NAME_NOT_FOUND,
};
use windows::Win32::Storage::FileSystem::{
    DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_READ_ATTRIBUTES,
    FILE_READ_DATA, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_WRITE_DATA, FlushFileBuffers,
    SYNCHRONIZE, WriteFile,
};
use windows::Win32::System::IO::IO_STATUS_BLOCK;

use crate::file_facts::{
    StandardInformation, create_relative, error_code, is_reparse_point, open as open_relative,
    open_root, query, raw, read, set_disposition, win32_code,
};
use crate::process_requests::{Code, native_path};
use crate::schema::process_reply::FileFactErrorCode;
use crate::schema::process_request::{FileReplace, FileReplaceExpected};
use crate::settings::{hex, sha256};

const INVALID: Code = Code::InvalidRequest;
/// Contract Δ5 "Ignore target file": the largest target and the largest new bytes.
pub(crate) const IGNORE_TARGET_BYTES: u64 = 1_048_576;

/// The result of one replace (contract Δ6 `fileReplace` reply).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ReplaceResult {
    Replaced,
    /// The target differs from `expected`, or a new file appeared before the rename.
    Stale,
    /// The target is a reparse point, a folder, or a file with more than one link.
    NotRegular,
    Error(FileFactErrorCode),
    /// A stop came before the write, so nothing changed.
    Stopped,
    /// A WSL `replace` process could run during a stop, so the shell does not know the outcome.
    Interrupted,
}

/// The checked fields of a `fileReplace` frame. It reads no file.
#[derive(Debug)]
pub(crate) struct Request<'a> {
    pub(crate) operation_id: &'a str,
    pub(crate) repository_id: &'a str,
    /// `.gitignore` of the worktree root, else `info/exclude` of the common directory.
    pub(crate) gitignore: bool,
    pub(crate) path: PathBuf,
    /// `None` is `absent`.
    pub(crate) expected: Option<(u64, String)>,
    pub(crate) bytes: Vec<u8>,
}

/// typify drops the byte bounds of `bytes` and `size` and has no native path rule.
pub(crate) fn parse(request: &FileReplace) -> Result<Request<'_>, Code> {
    use crate::schema::process_request::FileReplaceTarget;
    let expected = match &request.expected {
        FileReplaceExpected::String(_) => None,
        FileReplaceExpected::FileReplaceExpected { sha256, size } => {
            let size = u64::try_from(*size)
                .ok()
                .filter(|size| *size <= IGNORE_TARGET_BYTES)
                .ok_or(INVALID)?;
            Some((size, sha256.to_string()))
        }
    };
    // The editor text crosses as base64; 0 to 1 MiB of bytes (contract Δ5, Δ6).
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        request.bytes.as_str(),
    )
    .ok()
    .filter(|bytes| bytes.len() as u64 <= IGNORE_TARGET_BYTES)
    .ok_or(INVALID)?;
    Ok(Request {
        operation_id: &request.operation_id,
        repository_id: &request.repository_id,
        gitignore: matches!(request.target, FileReplaceTarget::Gitignore),
        path: native_path(&request.path)?,
        expected,
        bytes,
    })
}

fn failed(status: NTSTATUS) -> ReplaceResult {
    if is_reparse_point(status) {
        return ReplaceResult::NotRegular;
    }
    ReplaceResult::Error(error_code(status))
}

/// One replace after its check (plan.md D10). It holds the parent folder and the existing target until the write.
pub(crate) struct Checked {
    parent: OwnedHandle,
    name: String,
    /// The existing target, open with no write sharing, so no other writer changes it before the rename.
    target: Option<OwnedHandle>,
}

/// Walks to the parent of `names` below `root` and checks the target against `expected`. It writes nothing and respects `stop`.
/// A reparse point on the way or at the target gives `NotRegular`. A different state gives `Stale`.
pub(crate) fn check(
    root: &Path,
    names: &[String],
    expected: Option<(u64, &str)>,
    stop: &AtomicBool,
) -> Result<Checked, ReplaceResult> {
    let (last, middle) = names
        .split_last()
        .ok_or(ReplaceResult::Error(FileFactErrorCode::OtherError))?;
    let mut parent = open_root(root, stop).map_err(failed)?;
    for name in middle {
        parent = open_relative(&parent, name, false, false, stop).map_err(failed)?;
    }
    let target = match expected {
        Some((size, sha)) => {
            // `FILE_READ_ATTRIBUTES` serves the reparse tag and link count queries below.
            let target = create_relative(
                raw(&parent),
                last,
                FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                FILE_SHARE_READ | FILE_SHARE_DELETE,
                FILE_OPEN,
                FILE_OPEN_REPARSE_POINT | FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
            )
            .map_err(|status| match status {
                STATUS_OBJECT_NAME_NOT_FOUND => ReplaceResult::Stale,
                STATUS_FILE_IS_A_DIRECTORY => ReplaceResult::NotRegular,
                status => failed(status),
            })?;
            let tag =
                query::<FILE_ATTRIBUTE_TAG_INFORMATION>(&target, FileAttributeTagInformation, stop)
                    .map_err(failed)?;
            let kind = FILE_ATTRIBUTE_DIRECTORY.0 | FILE_ATTRIBUTE_REPARSE_POINT.0;
            if tag.ReparseTag != 0 || tag.FileAttributes & kind != 0 {
                return Err(ReplaceResult::NotRegular);
            }
            let standard = query::<StandardInformation>(&target, FileStandardInformation, stop)
                .map_err(failed)?;
            if standard.number_of_links != 1 {
                return Err(ReplaceResult::NotRegular);
            }
            if u64::try_from(standard.end_of_file) != Ok(size) {
                return Err(ReplaceResult::Stale);
            }
            // One byte past the size shows a longer file. `parse` bounds the size.
            let read_bytes = read(raw(&target), size as usize + 1, stop).map_err(failed)?;
            if read_bytes.len() as u64 != size || hex(&sha256(&read_bytes)) != sha {
                return Err(ReplaceResult::Stale);
            }
            Some(target)
        }
        None => None,
    };
    Ok(Checked {
        parent,
        name: last.clone(),
        target,
    })
}

impl Checked {
    /// Writes `bytes` to a new temporary file beside the target and renames it over the target. It does not stop.
    pub(crate) fn write(self, bytes: &[u8]) -> ReplaceResult {
        // A random temporary name beside the target. The create fails if it already exists.
        let temp = match crate::settings::random_id() {
            Ok(id) => format!(".arbareto-{}.tmp", id.replace('-', "")),
            Err(_) => return ReplaceResult::Error(FileFactErrorCode::OtherError),
        };
        let temp_handle = match create_relative(
            raw(&self.parent),
            &temp,
            DELETE | FILE_WRITE_DATA | SYNCHRONIZE,
            FILE_SHARE_READ,
            FILE_CREATE,
            FILE_SYNCHRONOUS_IO_NONALERT | FILE_NON_DIRECTORY_FILE,
        ) {
            Ok(handle) => handle,
            Err(status) => return failed(status),
        };
        let result = write_and_rename(
            &self.parent,
            &temp_handle,
            &self.name,
            bytes,
            self.target.is_some(),
        );
        if result != ReplaceResult::Replaced {
            // A failure after the create removes the temporary file by disposition on its handle.
            let _ = set_disposition(&temp_handle);
        }
        result
    }
}

/// Writes `bytes`, flushes, then renames the temporary handle over `name` in `parent`.
fn write_and_rename(
    parent: &OwnedHandle,
    temp: &OwnedHandle,
    name: &str,
    bytes: &[u8],
    replace_existing: bool,
) -> ReplaceResult {
    let mut written = 0u32;
    // SAFETY: `temp` is an open handle, and `bytes` and `written` are live locals.
    let wrote = unsafe { WriteFile(raw(temp), Some(bytes), Some(&raw mut written), None) };
    // SAFETY: `temp` is open.
    let flushed = wrote.and_then(|()| unsafe { FlushFileBuffers(raw(temp)) });
    match flushed {
        Ok(()) if written as usize == bytes.len() => {}
        Ok(()) => return ReplaceResult::Error(FileFactErrorCode::OtherError),
        Err(error) => return ReplaceResult::Error(win32_code(&error)),
    }
    // The Win32 `SetFileInformationByHandle` rejects a relative `FileName` with a `RootDirectory` (ERROR_INVALID_PARAMETER),
    // so the rename uses `NtSetInformationFile(FileRenameInformationEx)`, which resolves the name under the held parent.
    let units: Vec<u16> = name.encode_utf16().collect();
    let name_bytes = units.len() * 2;
    let header = std::mem::offset_of!(FILE_RENAME_INFORMATION, FileName);
    // A `u64` buffer keeps the 8-byte alignment of `FILE_RENAME_INFORMATION`.
    let mut buffer = vec![0u64; (header + name_bytes).div_ceil(8)];
    let mut flags = FILE_RENAME_POSIX_SEMANTICS;
    if replace_existing {
        flags |= FILE_RENAME_REPLACE_IF_EXISTS;
    }
    // SAFETY: the aligned buffer holds a `FILE_RENAME_INFORMATION` followed by the name, and `parent` keeps its handle open.
    unsafe {
        let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
        (*info).Anonymous.Flags = flags;
        (*info).RootDirectory = raw(parent);
        (*info).FileNameLength = name_bytes as u32;
        std::ptr::copy_nonoverlapping(
            units.as_ptr().cast::<u8>(),
            buffer.as_mut_ptr().cast::<u8>().add(header),
            name_bytes,
        );
    }
    let mut io = IO_STATUS_BLOCK::default();
    // SAFETY: `temp` is open, and the buffer is live with the passed length.
    let status = unsafe {
        NtSetInformationFile(
            raw(temp),
            &raw mut io,
            buffer.as_ptr().cast(),
            (header + name_bytes) as u32,
            FileRenameInformationEx,
        )
    };
    match status {
        status if status.is_ok() => ReplaceResult::Replaced,
        // A name that appeared since the check, or an existing name without the replace flag, collides (N7).
        STATUS_OBJECT_NAME_COLLISION => ReplaceResult::Stale,
        status => failed(status),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::{Path, PathBuf};
    use std::sync::atomic::AtomicBool;

    use serde_json::{Value, json};

    use crate::file_facts::tests::set_private_tag;
    use crate::jobs::tests::Fixture;
    use crate::process_requests::tests::junction;
    use crate::schema::typed;
    use crate::settings::{hex, sha256};

    static RUN: AtomicBool = AtomicBool::new(false);

    fn digest(bytes: &[u8]) -> String {
        hex(&sha256(bytes))
    }

    /// The check of the walk, then the write of the finish.
    fn replace(
        root: &Path,
        names: &[String],
        expected: Option<(u64, &str)>,
        bytes: &[u8],
        stop: &AtomicBool,
    ) -> ReplaceResult {
        check(root, names, expected, stop)
            .map_or_else(|result| result, |checked| checked.write(bytes))
    }

    fn names(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    fn do_replace(
        root: &Path,
        path: &[&str],
        expected: Option<&[u8]>,
        bytes: &[u8],
    ) -> ReplaceResult {
        let expected = expected.map(|old| (old.len() as u64, digest(old)));
        let expected = expected.as_ref().map(|(size, sha)| (*size, sha.as_str()));
        replace(root, &names(path), expected, bytes, &RUN)
    }

    fn repository() -> (Fixture, PathBuf) {
        let fixture = Fixture::new();
        let root = fixture.path("repo");
        std::fs::create_dir_all(root.join(".git").join("info")).expect("repository");
        (fixture, root)
    }

    /// Contract Δ6 `fileReplace`: a present target replaces atomically, and nothing else on the way changes.
    #[test]
    fn an_existing_target_is_replaced_and_leaves_no_temporary_file() {
        let (_fixture, root) = repository();
        let file = root.join(".gitignore");
        std::fs::write(&file, b"/old\n").expect("gitignore");
        assert_eq!(
            do_replace(&root, &[".gitignore"], Some(b"/old\n"), b"/new\n"),
            ReplaceResult::Replaced
        );
        assert_eq!(std::fs::read(&file).expect("read"), b"/new\n");
        let temps: Vec<_> = std::fs::read_dir(&root)
            .expect("dir")
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with(".arbareto-"))
            .collect();
        assert!(temps.is_empty(), "no temporary file remains");
    }

    /// Contract Δ6: an absent target writes a new file. An existing name then gives `stale`.
    #[test]
    fn an_absent_target_creates_the_file_and_an_existing_name_is_stale() {
        let (_fixture, root) = repository();
        let git = root.join(".git");
        let exclude = git.join("info").join("exclude");
        assert_eq!(
            replace(&git, &names(&["info", "exclude"]), None, b"/x\n", &RUN),
            ReplaceResult::Replaced
        );
        assert_eq!(std::fs::read(&exclude).expect("read"), b"/x\n");
        assert_eq!(
            replace(&git, &names(&["info", "exclude"]), None, b"/y\n", &RUN),
            ReplaceResult::Stale,
            "an existing name with an absent expectation"
        );
        assert_eq!(std::fs::read(&exclude).expect("read"), b"/x\n", "no change");
    }

    /// Contract Δ6: a size or SHA-256 other than `expected` gives `stale`, and nothing changes.
    #[test]
    fn a_target_that_differs_from_expected_is_stale() {
        let (_fixture, root) = repository();
        let file = root.join(".gitignore");
        std::fs::write(&file, b"/old\n").expect("gitignore");
        for (name, old) in [
            ("another size", &b"/older\n"[..]),
            ("the same size and another SHA-256", &b"/new\n"[..]),
            ("an absent file", &b""[..]),
        ] {
            let old = if name == "an absent file" {
                std::fs::remove_file(&file).ok();
                b"".as_slice()
            } else {
                old
            };
            assert_eq!(
                do_replace(&root, &[".gitignore"], Some(old), b"/z\n"),
                ReplaceResult::Stale,
                "{name}"
            );
            if name != "an absent file" {
                assert_eq!(std::fs::read(&file).expect("read"), b"/old\n");
            }
            std::fs::write(&file, b"/old\n").ok();
        }
    }

    /// Contract Δ6: a reparse tag, a folder, or more than one link gives `refused not-regular`.
    #[test]
    fn a_reparse_point_a_folder_or_a_second_link_is_not_regular() {
        let (fixture, root) = repository();
        std::fs::create_dir(root.join("folder")).expect("folder");
        assert_eq!(
            do_replace(&root, &["folder"], Some(b""), b"/a\n"),
            ReplaceResult::NotRegular,
            "a folder"
        );
        let tagged = root.join("tagged");
        std::fs::write(&tagged, b"").expect("tagged");
        if set_private_tag(&tagged) {
            assert_eq!(
                do_replace(&root, &["tagged"], Some(b""), b"/a\n"),
                ReplaceResult::NotRegular,
                "a reparse tag"
            );
        } else {
            println!("SKIP fileReplace reparse tag: missing capability reparse-tag (unverified)");
        }
        let outside = fixture.path("outside");
        std::fs::write(&outside, b"/a\n").expect("outside");
        if std::fs::hard_link(&outside, root.join(".gitignore")).is_ok() {
            assert_eq!(
                do_replace(&root, &[".gitignore"], Some(b"/a\n"), b"/b\n"),
                ReplaceResult::NotRegular,
                "a second link"
            );
            assert_eq!(std::fs::read(&outside).expect("read"), b"/a\n");
        } else {
            println!("SKIP fileReplace hard link: missing capability hard-link (unverified)");
        }
    }

    /// Contract Δ6: a junction as the target is a reparse point, so the replace refuses it.
    #[test]
    fn a_junction_target_is_not_regular() {
        let (fixture, root) = repository();
        let outside = fixture.path("outside");
        std::fs::create_dir(&outside).expect("outside");
        if junction(&root.join(".gitignore"), &outside) {
            assert_eq!(
                do_replace(&root, &[".gitignore"], Some(b""), b"/a\n"),
                ReplaceResult::NotRegular
            );
        } else {
            println!("SKIP fileReplace junction: missing capability ntfs-junction (unverified)");
        }
    }

    /// Contract Δ6: the request rules refuse a relative path and bytes above 1 MiB.
    #[test]
    fn the_request_rules_refuse_a_relative_path_and_oversized_bytes() {
        let frame = |fields: Value| {
            let mut frame = json!({
                "type": "fileReplace", "callId": "0f0f0f0f-0000-4000-8000-000000000001",
                "operationId": "0f0f0f0f-0000-4000-8000-000000000004", "repositoryId": "0f0f0f0f-0000-4000-8000-000000000005",
                "target": "gitignore", "path": "C:\\repo\\.gitignore", "expected": "absent", "bytes": "L2EK",
            });
            frame
                .as_object_mut()
                .expect("frame")
                .extend(fields.as_object().expect("fields").clone());
            let request = typed(&frame).expect("generated type");
            parse(&request).map(|parsed| (parsed.gitignore, parsed.expected, parsed.bytes.len()))
        };
        let sha = "b".repeat(64);
        assert_eq!(frame(json!({})), Ok((true, None, 3)));
        assert_eq!(
            frame(
                json!({ "target": "exclude", "expected": { "size": 1_048_576, "sha256": sha }, "bytes": "" })
            ),
            Ok((false, Some((1_048_576, sha.clone())), 0)),
            "an empty replacement is valid"
        );
        let big = crate::process_requests::encode_base64(&vec![b'x'; 1_048_577]);
        for (name, fields) in [
            ("a relative path", json!({ "path": ".gitignore" })),
            (
                "a device path",
                json!({ "path": "\\\\?\\C:\\repo\\.gitignore" }),
            ),
            ("bytes above 1 MiB", json!({ "bytes": big })),
            (
                "an expected size above 1 MiB",
                json!({ "expected": { "size": 1_048_577, "sha256": sha } }),
            ),
            (
                "a negative expected size",
                json!({ "expected": { "size": -1, "sha256": sha } }),
            ),
        ] {
            assert_eq!(frame(fields), Err(INVALID), "{name}");
        }
    }

    /// Feature 008 T003: the replace-sequence probes of research.md R14 (`Local: Rust`). Each prints `OBSERVATION T003` lines.
    /// Run: `cargo test --locked --manifest-path src-tauri/Cargo.toml -- --ignored --test-threads=1 file_replace::tests::revert_facts`.
    /// A `match=false` line is a finding for research.md R15, not a failure.
    mod revert_facts {
        use std::io::{BufRead, BufReader, Write};
        use std::os::windows::ffi::OsStrExt;
        use std::os::windows::io::OwnedHandle;
        use std::path::Path;
        use std::process::{Command, Stdio};
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        use serde_json::{Value, json};
        use windows::Wdk::Storage::FileSystem::{
            FILE_BASIC_INFORMATION, FILE_CREATE, FILE_DELETE_ON_CLOSE, FILE_DIRECTORY_FILE,
            FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT, FILE_RENAME_INFORMATION,
            FILE_RENAME_POSIX_SEMANTICS, FILE_RENAME_REPLACE_IF_EXISTS,
            FILE_SYNCHRONOUS_IO_NONALERT, FileBasicInformation, FileRenameInformationEx,
            NtSetInformationFile,
        };
        use windows::Wdk::System::SystemServices::RtlGetVersion;
        use windows::Win32::Foundation::NTSTATUS;
        use windows::Win32::Security::{
            DACL_SECURITY_INFORMATION, GROUP_SECURITY_INFORMATION, GetKernelObjectSecurity,
            GetSecurityDescriptorControl, OBJECT_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
            PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SE_DACL_AUTO_INHERIT_REQ,
            SE_DACL_PROTECTED, SetKernelObjectSecurity, SetSecurityDescriptorControl,
            UNPROTECTED_DACL_SECURITY_INFORMATION,
        };
        use windows::Win32::Storage::FileSystem::{
            DELETE, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_NORMAL,
            FILE_ATTRIBUTE_NOT_CONTENT_INDEXED, FILE_ATTRIBUTE_READONLY,
            FILE_ATTRIBUTE_SPARSE_FILE, FILE_ATTRIBUTE_SYSTEM, FILE_DISPOSITION_FLAG_DO_NOT_DELETE,
            FILE_DISPOSITION_FLAG_ON_CLOSE, FILE_DISPOSITION_INFO_EX,
            FILE_DISPOSITION_INFO_EX_FLAGS, FILE_FLAGS_AND_ATTRIBUTES, FILE_LIST_DIRECTORY,
            FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE, FILE_SHARE_READ,
            FILE_SHARE_WRITE, FILE_TRAVERSE, FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA,
            FileDispositionInfoEx, FlushFileBuffers, GetFileAttributesW, READ_CONTROL,
            SYNCHRONIZE, SetFileAttributesW, SetFileInformationByHandle, WRITE_DAC, WriteFile,
        };
        use windows::Win32::System::IO::{DeviceIoControl, IO_STATUS_BLOCK};
        use windows::Win32::System::Ioctl::{FSCTL_SET_COMPRESSION, FSCTL_SET_SPARSE};
        use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
        use windows::core::PCWSTR;

        use super::RUN;
        use crate::file_facts::{create_relative, is_reparse_point, open_root, query, raw};
        use crate::jobs::tests::Fixture;
        use crate::process_requests::tests::junction;

        const CHILD_ENV: &str = "ARBARETO_T003_W6";
        const CHILD_WAIT: Duration = Duration::from_secs(30);
        const OLD: &[u8] = b"old\n";
        const NEW: &[u8] = b"new\n";
        /// 2020-01-01T00:00:00Z as FILETIME.
        const OLD_CREATION: i64 = 132_223_104_000_000_000;

        fn os() -> String {
            let mut info = OSVERSIONINFOW {
                dwOSVersionInfoSize: size_of::<OSVERSIONINFOW>() as u32,
                ..Default::default()
            };
            // SAFETY: `info` is a live local with its size set.
            let status = unsafe { RtlGetVersion(&raw mut info) };
            if status.is_err() {
                return "unknown".to_string();
            }
            format!(
                "{}.{}.{}",
                info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber
            )
        }

        /// JSON without spaces, so each `key=value` field is one token (the `tests/git/fact-runner.ts` form).
        fn token(value: &Value) -> String {
            value.to_string().replace(' ', "\\u0020")
        }

        fn observe(fact: &str, expected: Value, observed: Value) {
            let matched = expected == observed;
            println!(
                "OBSERVATION T003: {fact} expected={} observed={} match={matched} os={}",
                token(&expected),
                token(&observed),
                os()
            );
        }

        fn record(fact: &str, observed: Value) {
            println!(
                "OBSERVATION T003: {fact} expected=\"record\" observed={} match=true os={}",
                token(&observed),
                os()
            );
        }

        fn status_text(status: NTSTATUS) -> String {
            format!("0x{:08x}", status.0 as u32)
        }

        fn wide(path: &Path) -> Vec<u16> {
            path.as_os_str().encode_wide().chain(Some(0)).collect()
        }

        fn attributes(path: &Path) -> u32 {
            let name = wide(path);
            // SAFETY: `name` is a live, NUL-terminated wide string.
            unsafe { GetFileAttributesW(PCWSTR(name.as_ptr())) }
        }

        fn set_attributes(path: &Path, bits: u32) -> bool {
            let name = wide(path);
            // SAFETY: `name` is a live, NUL-terminated wide string.
            unsafe { SetFileAttributesW(PCWSTR(name.as_ptr()), FILE_FLAGS_AND_ATTRIBUTES(bits)) }
                .is_ok()
        }

        fn parent(dir: &Path) -> OwnedHandle {
            open_root(dir, &RUN).expect("open the probe folder")
        }

        /// The held target of `check`, with `READ_CONTROL` for the security read.
        fn hold(parent: &OwnedHandle, name: &str) -> OwnedHandle {
            create_relative(
                raw(parent),
                name,
                FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
                FILE_SHARE_READ | FILE_SHARE_DELETE,
                FILE_OPEN,
                FILE_OPEN_REPARSE_POINT | FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
            )
            .expect("hold the target")
        }

        fn temp(
            parent: &OwnedHandle,
            name: &str,
            delete_on_close: bool,
        ) -> Result<OwnedHandle, NTSTATUS> {
            let mut options = FILE_SYNCHRONOUS_IO_NONALERT | FILE_NON_DIRECTORY_FILE;
            if delete_on_close {
                options |= FILE_DELETE_ON_CLOSE;
            }
            create_relative(
                raw(parent),
                name,
                DELETE | FILE_WRITE_DATA | FILE_WRITE_ATTRIBUTES | READ_CONTROL | WRITE_DAC | SYNCHRONIZE,
                FILE_SHARE_READ,
                FILE_CREATE,
                options,
            )
        }

        fn write(handle: &OwnedHandle, bytes: &[u8]) -> bool {
            let mut written = 0u32;
            // SAFETY: `handle` is open, and `bytes` and `written` are live locals.
            let wrote = unsafe { WriteFile(raw(handle), Some(bytes), Some(&raw mut written), None) };
            // SAFETY: `handle` is open.
            wrote.and_then(|()| unsafe { FlushFileBuffers(raw(handle)) }).is_ok()
                && written as usize == bytes.len()
        }

        fn set_basic(handle: &OwnedHandle, creation: i64, attributes: u32) -> NTSTATUS {
            let info = FILE_BASIC_INFORMATION {
                CreationTime: creation,
                FileAttributes: attributes,
                ..Default::default()
            };
            let mut io = IO_STATUS_BLOCK::default();
            // SAFETY: `handle` is open, and `info` is a live local of the passed size.
            unsafe {
                NtSetInformationFile(
                    raw(handle),
                    &raw mut io,
                    (&raw const info).cast(),
                    size_of::<FILE_BASIC_INFORMATION>() as u32,
                    FileBasicInformation,
                )
            }
        }

        fn clear_disposition(handle: &OwnedHandle) -> windows::core::Result<()> {
            let info = FILE_DISPOSITION_INFO_EX {
                Flags: FILE_DISPOSITION_INFO_EX_FLAGS(
                    FILE_DISPOSITION_FLAG_DO_NOT_DELETE.0 | FILE_DISPOSITION_FLAG_ON_CLOSE.0,
                ),
            };
            // SAFETY: `handle` is open, and `info` is a live local of the passed size.
            unsafe {
                SetFileInformationByHandle(
                    raw(handle),
                    FileDispositionInfoEx,
                    (&raw const info).cast(),
                    size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
                )
            }
        }

        /// `FileRenameInformationEx` with POSIX semantics and replace, as `write_and_rename` builds it, with the raw status.
        fn rename(temp: &OwnedHandle, parent: &OwnedHandle, name: &str) -> NTSTATUS {
            let units: Vec<u16> = name.encode_utf16().collect();
            let name_bytes = units.len() * 2;
            let header = std::mem::offset_of!(FILE_RENAME_INFORMATION, FileName);
            let mut buffer = vec![0u64; (header + name_bytes).div_ceil(8)];
            // SAFETY: the aligned buffer holds a `FILE_RENAME_INFORMATION` followed by the name.
            unsafe {
                let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
                (*info).Anonymous.Flags = FILE_RENAME_POSIX_SEMANTICS | FILE_RENAME_REPLACE_IF_EXISTS;
                (*info).RootDirectory = raw(parent);
                (*info).FileNameLength = name_bytes as u32;
                std::ptr::copy_nonoverlapping(
                    units.as_ptr().cast::<u8>(),
                    buffer.as_mut_ptr().cast::<u8>().add(header),
                    name_bytes,
                );
            }
            let mut io = IO_STATUS_BLOCK::default();
            // SAFETY: `temp` is open, and the buffer is live with the passed length.
            unsafe {
                NtSetInformationFile(
                    raw(temp),
                    &raw mut io,
                    buffer.as_ptr().cast(),
                    (header + name_bytes) as u32,
                    FileRenameInformationEx,
                )
            }
        }

        fn security(handle: &OwnedHandle, info: OBJECT_SECURITY_INFORMATION) -> Vec<u8> {
            let mut needed = 0u32;
            // SAFETY: a null buffer of length 0 asks for the needed length only.
            let _ = unsafe { GetKernelObjectSecurity(raw(handle), info.0, None, 0, &raw mut needed) };
            let mut buffer = vec![0u8; needed as usize];
            // SAFETY: `buffer` is live with the passed length.
            unsafe {
                GetKernelObjectSecurity(
                    raw(handle),
                    info.0,
                    Some(PSECURITY_DESCRIPTOR(buffer.as_mut_ptr().cast())),
                    needed,
                    &raw mut needed,
                )
            }
            .expect("GetKernelObjectSecurity");
            buffer
        }

        fn protected(descriptor: &mut [u8]) -> bool {
            let mut control = 0u16;
            let mut revision = 0u32;
            // SAFETY: `descriptor` holds a self-relative descriptor from `GetKernelObjectSecurity`.
            unsafe {
                GetSecurityDescriptorControl(
                    PSECURITY_DESCRIPTOR(descriptor.as_mut_ptr().cast()),
                    &raw mut control,
                    &raw mut revision,
                )
            }
            .expect("GetSecurityDescriptorControl");
            control & SE_DACL_PROTECTED.0 != 0
        }

        /// The owner, group, and DACL of a path as the self-relative descriptor bytes.
        fn descriptor_at(path: &Path) -> Vec<u8> {
            // `GENERIC_READ` of `File::open` includes `READ_CONTROL`.
            let file = std::fs::File::open(path).expect("open for READ_CONTROL");
            security(
                &OwnedHandle::from(file),
                OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            )
        }

        #[derive(Clone, Copy, PartialEq)]
        enum Dacl {
            None,
            Kernel,
            KernelFlag,
            /// The copied descriptor carries `SE_DACL_AUTO_INHERIT_REQ`.
            KernelAutoInherit,
        }

        /// The 005 replace sequence with the R8 additions that `basic`, `dacl`, and `delete_on_close` select.
        fn replace(dir: &Path, name: &str, basic: bool, dacl: Dacl, delete_on_close: bool) -> Value {
            let parent = parent(dir);
            let held = hold(&parent, name);
            let old = query::<FILE_BASIC_INFORMATION>(&held, FileBasicInformation, &RUN)
                .expect("FileBasicInformation");
            let mut old_dacl = (dacl != Dacl::None).then(|| security(&held, DACL_SECURITY_INFORMATION));
            let temp_name = format!(".arbareto-t003-{}.tmp", std::process::id());
            let temp = match temp(&parent, &temp_name, delete_on_close) {
                Ok(handle) => handle,
                Err(status) => return json!({ "step": "temp-create", "status": status_text(status) }),
            };
            let fail = |step: &str, status: String| json!({ "step": step, "status": status });
            let result = (|| {
                if !write(&temp, NEW) {
                    return fail("write", String::new());
                }
                if basic {
                    let status = set_basic(&temp, old.CreationTime, old.FileAttributes);
                    if status.is_err() {
                        return fail("basic", status_text(status));
                    }
                }
                if let Some(descriptor) = old_dacl.as_mut() {
                    let mut info = DACL_SECURITY_INFORMATION;
                    if dacl == Dacl::KernelAutoInherit {
                        // SAFETY: `descriptor` is a live self-relative descriptor.
                        let set = unsafe {
                            SetSecurityDescriptorControl(
                                PSECURITY_DESCRIPTOR(descriptor.as_mut_ptr().cast()),
                                SE_DACL_AUTO_INHERIT_REQ,
                                SE_DACL_AUTO_INHERIT_REQ,
                            )
                        };
                        if let Err(error) = set {
                            return fail("control", format!("{:?}", error.code()));
                        }
                    }
                    if dacl == Dacl::KernelFlag {
                        info |= if protected(descriptor) {
                            PROTECTED_DACL_SECURITY_INFORMATION
                        } else {
                            UNPROTECTED_DACL_SECURITY_INFORMATION
                        };
                    }
                    // SAFETY: `temp` is open with `WRITE_DAC`, and `descriptor` is a live self-relative descriptor.
                    let set = unsafe {
                        SetKernelObjectSecurity(
                            raw(&temp),
                            info,
                            PSECURITY_DESCRIPTOR(descriptor.as_mut_ptr().cast()),
                        )
                    };
                    if let Err(error) = set {
                        return fail("dacl", format!("{:?}", error.code()));
                    }
                }
                if delete_on_close && let Err(error) = clear_disposition(&temp) {
                    return fail("clear", format!("{:?}", error.code()));
                }
                let status = rename(&temp, &parent, name);
                if status.is_err() {
                    return fail("rename", status_text(status));
                }
                json!({ "step": "renamed" })
            })();
            if result["step"] != "renamed" {
                let _ = crate::file_facts::set_disposition(&temp);
            }
            result
        }

        /// R8 W1: the attributes after the 005 replace and with the `FileBasicInformation` copy.
        #[test]
        #[ignore = "feature 008 T003 probe, Local: Rust"]
        fn w1_attribute_copy() {
            let fixture = Fixture::new();
            let dir = fixture.path("w1");
            std::fs::create_dir(&dir).expect("w1");
            let mask = 0x2 | 0x4 | 0x20 | 0x2000 | 0x800 | 0x200;
            for (id, bits) in [
                ("hidden", FILE_ATTRIBUTE_HIDDEN.0),
                ("system", FILE_ATTRIBUTE_SYSTEM.0),
                ("archive-clear", FILE_ATTRIBUTE_NORMAL.0),
                ("not-content-indexed", FILE_ATTRIBUTE_NOT_CONTENT_INDEXED.0),
                ("compressed", 0),
                ("sparse", FILE_ATTRIBUTE_SPARSE_FILE.0),
            ] {
                for basic in [false, true] {
                    let name = format!("{id}-{}.txt", if basic { "copy" } else { "005" });
                    let path = dir.join(&name);
                    std::fs::write(&path, OLD).expect("old");
                    let set = match id {
                        "compressed" | "sparse" => {
                            let file = std::fs::OpenOptions::new()
                                .read(true)
                                .write(true)
                                .open(&path)
                                .expect("open");
                            let handle = OwnedHandle::from(file);
                            let format = 1u16;
                            let mut returned = 0u32;
                            let (code, input) = if id == "compressed" {
                                (FSCTL_SET_COMPRESSION, Some((&raw const format).cast()))
                            } else {
                                (FSCTL_SET_SPARSE, None)
                            };
                            // SAFETY: `handle` is open, and `format` and `returned` are live locals.
                            unsafe {
                                DeviceIoControl(
                                    raw(&handle),
                                    code,
                                    input,
                                    if input.is_some() { 2 } else { 0 },
                                    None,
                                    0,
                                    Some(&raw mut returned),
                                    None,
                                )
                            }
                            .is_ok()
                        }
                        _ => set_attributes(&path, bits),
                    };
                    let before = attributes(&path) & mask;
                    let result = replace(&dir, &name, basic, Dacl::None, false);
                    let after = attributes(&path) & mask;
                    observe(
                        &format!("W1.{name}"),
                        json!({ "set": true, "result": { "step": "renamed" }, "attributes": format!("0x{before:x}") }),
                        json!({ "set": set, "result": result, "attributes": format!("0x{after:x}") }),
                    );
                }
            }
        }

        /// R8 W2: the descriptor after the replace and with the `SetKernelObjectSecurity` DACL copy.
        /// `SetSecurityInfo` and the SDDL conversion need the `windows` feature `Win32_Security_Authorization`, so this probe compares the descriptor bytes.
        #[test]
        #[ignore = "feature 008 T003 probe, Local: Rust"]
        fn w2_dacl_copy() {
            observe(
                "W2.set-security-info-feature",
                json!({ "Win32_Security_Authorization": "enabled" }),
                json!({ "Win32_Security_Authorization": "not enabled in src-tauri/Cargo.toml" }),
            );
            let icacls = |path: &Path, arguments: &[&str]| {
                let status = Command::new("icacls")
                    .arg(path)
                    .args(arguments)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .expect("icacls");
                assert!(status.success(), "icacls {arguments:?}");
            };
            let fixture = Fixture::new();
            // `auto-inherited`: an icacls grant rewrites the folder DACL with inheritable ACEs and `SE_DACL_AUTO_INHERITED`.
            for (folder, folder_acl) in [
                ("plain", None),
                ("auto-inherited", Some(&["/grant", "*S-1-5-32-545:(OI)(CI)(RX)"][..])),
            ] {
                let dir = fixture.path(&format!("w2-{folder}"));
                std::fs::create_dir(&dir).expect("w2");
                if let Some(arguments) = folder_acl {
                    icacls(&dir, arguments);
                }
                for (kind, file_acl) in [
                    ("inherited-only", None),
                    ("explicit-ace", Some(&["/grant", "*S-1-5-32-545:(R)"][..])),
                    ("protected", Some(&["/inheritance:d"][..])),
                ] {
                    // Per method: `same` when the owner, group, and DACL descriptor bytes equal the old file.
                    let mut results = serde_json::Map::new();
                    for (method, dacl) in [
                        ("none", Dacl::None),
                        ("kernel", Dacl::Kernel),
                        ("kernel-flag", Dacl::KernelFlag),
                        ("kernel-auto-inherit", Dacl::KernelAutoInherit),
                    ] {
                        let name = format!("{kind}-{method}.txt");
                        let path = dir.join(&name);
                        std::fs::write(&path, OLD).expect("old");
                        if let Some(arguments) = file_acl {
                            icacls(&path, arguments);
                        }
                        let before = descriptor_at(&path);
                        let result = replace(&dir, &name, false, dacl, false);
                        let after = descriptor_at(&path);
                        let value = if result["step"] != "renamed" {
                            result
                        } else {
                            json!(if before == after { "same" } else { "differs" })
                        };
                        results.insert(method.to_string(), value);
                    }
                    record(&format!("W2.{folder}.{kind}"), Value::Object(results));
                }
            }
        }

        /// R8 W3: the creation time without a copy (tunneling) and with the `FileBasicInformation` copy.
        #[test]
        #[ignore = "feature 008 T003 probe, Local: Rust"]
        fn w3_creation_time() {
            let fixture = Fixture::new();
            let dir = fixture.path("w3");
            std::fs::create_dir(&dir).expect("w3");
            for basic in [false, true] {
                let name = format!("c-{}.txt", if basic { "copy" } else { "005" });
                std::fs::write(dir.join(&name), OLD).expect("old");
                let parent = parent(&dir);
                let set = {
                    let handle = create_relative(
                        raw(&parent),
                        &name,
                        FILE_WRITE_ATTRIBUTES | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                        FILE_OPEN,
                        FILE_SYNCHRONOUS_IO_NONALERT | FILE_NON_DIRECTORY_FILE,
                    )
                    .expect("open");
                    set_basic(&handle, OLD_CREATION, 0).is_ok()
                };
                let result = replace(&dir, &name, basic, Dacl::None, false);
                let after = query::<FILE_BASIC_INFORMATION>(&hold(&parent, &name), FileBasicInformation, &RUN)
                    .expect("FileBasicInformation");
                let observed = json!({ "set": set, "result": result, "keepsOldCreation": after.CreationTime == OLD_CREATION });
                if basic {
                    observe(
                        "W3.creation.copy",
                        json!({ "set": true, "result": { "step": "renamed" }, "keepsOldCreation": true }),
                        observed,
                    );
                } else {
                    record("W3.creation.005", observed);
                }
            }
        }

        /// R8 W5: the rename over a read-only target fails with its NT status, and the target keeps its bytes.
        #[test]
        #[ignore = "feature 008 T003 probe, Local: Rust"]
        fn w5_read_only_target() {
            let fixture = Fixture::new();
            let dir = fixture.path("w5");
            std::fs::create_dir(&dir).expect("w5");
            let path = dir.join("ro.txt");
            std::fs::write(&path, OLD).expect("old");
            assert!(set_attributes(&path, FILE_ATTRIBUTE_READONLY.0), "read-only");
            let result = replace(&dir, "ro.txt", false, Dacl::None, false);
            let bytes = std::fs::read(&path).expect("read");
            set_attributes(&path, FILE_ATTRIBUTE_NORMAL.0);
            let temps: Vec<String> = std::fs::read_dir(&dir)
                .expect("dir")
                .filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with(".arbareto-"))
                .collect();
            // ntstatus.h: STATUS_ACCESS_DENIED is 0xc0000022.
            observe(
                "W5.read-only-target",
                json!({ "result": { "step": "rename", "status": "0xc0000022" }, "bytes": "old\n", "temps": [] }),
                json!({ "result": result, "bytes": String::from_utf8_lossy(&bytes), "temps": temps }),
            );
        }

        /// The W6 child: creates the temporary file with the delete disposition on close, optionally clears it, and waits to be terminated.
        #[test]
        #[ignore = "child of w6_delete_on_close_and_terminate"]
        fn w6_child() {
            let Ok(spec) = std::env::var(CHILD_ENV) else {
                return;
            };
            let (dir, rest) = spec.split_once('|').expect("dir|name|clear");
            let (name, clear) = rest.split_once('|').expect("name|clear");
            let parent = parent(Path::new(dir));
            let handle = temp(&parent, name, true).expect("temporary file");
            assert!(write(&handle, b"temp\n"), "write");
            let mut line = "READY held".to_string();
            if clear == "1" {
                line.push_str(if clear_disposition(&handle).is_ok() { " cleared" } else { " clear-failed" });
            }
            println!("{line}");
            std::io::stdout().flush().expect("flush");
            std::thread::sleep(Duration::from_secs(60));
            drop(handle);
        }

        /// Starts `w6_child`, waits for its READY line, ends it by `TerminateProcess` (`Child::kill`), and returns the line.
        fn terminate_child(dir: &Path, name: &str, clear: bool) -> String {
            let mut child = Command::new(std::env::current_exe().expect("test binary"))
                .args([
                    "file_replace::tests::revert_facts::w6_child",
                    "--exact",
                    "--ignored",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env(CHILD_ENV, format!("{}|{name}|{}", dir.display(), if clear { 1 } else { 0 }))
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn the child");
            let stdout = child.stdout.take().expect("stdout");
            let (send, receive) = mpsc::channel();
            // libtest prints `test <name> ... ` without a line end before the test runs, so the READY text can follow it on one line.
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if let Some(at) = line.find("READY") {
                        let _ = send.send(line[at..].to_string());
                        return;
                    }
                }
            });
            let line = receive.recv_timeout(CHILD_WAIT);
            child.kill().expect("TerminateProcess");
            let deadline = Instant::now() + CHILD_WAIT;
            while child.try_wait().expect("try_wait").is_none() {
                assert!(Instant::now() < deadline, "the child did not end");
                std::thread::sleep(Duration::from_millis(50));
            }
            line.expect("READY line")
        }

        /// R8 W6: the delete disposition on close, its clear with `FileDispositionInformationEx`, and `TerminateProcess` before and after the clear.
        #[test]
        #[ignore = "feature 008 T003 probe, Local: Rust"]
        fn w6_delete_on_close_and_terminate() {
            let fixture = Fixture::new();
            let dir = fixture.path("w6");
            std::fs::create_dir(&dir).expect("w6");
            for (stage, clear) in [("before-clear", false), ("after-clear", true)] {
                let name = format!("{stage}.tmp");
                let line = terminate_child(&dir, &name, clear);
                observe(
                    &format!("W6.terminate-{stage}"),
                    json!({ "ready": if clear { "READY held cleared" } else { "READY held" }, "exists": clear }),
                    json!({ "ready": line, "exists": dir.join(&name).exists() }),
                );
            }
            std::fs::write(dir.join("target.txt"), OLD).expect("old");
            let result = replace(&dir, "target.txt", false, Dacl::None, true);
            observe(
                "W6.rename-after-clear",
                json!({ "result": { "step": "renamed" }, "bytes": "new\n" }),
                json!({ "result": result, "bytes": String::from_utf8_lossy(&std::fs::read(dir.join("target.txt")).expect("read")) }),
            );
        }

        /// R8 W10: a missing folder chain below the held parent; a reparse point at a folder name refuses.
        #[test]
        #[ignore = "feature 008 T003 probe, Local: Rust"]
        fn w10_folders_and_reparse_point() {
            let fixture = Fixture::new();
            let dir = fixture.path("w10");
            std::fs::create_dir(&dir).expect("w10");
            let parent = parent(&dir);
            let folder = |at: &OwnedHandle, name: &str| {
                create_relative(
                    raw(at),
                    name,
                    FILE_LIST_DIRECTORY | FILE_TRAVERSE | SYNCHRONIZE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    FILE_CREATE,
                    FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
                )
            };
            let a = folder(&parent, "a");
            let b = a.as_ref().map(|a| folder(a, "b"));
            let chain = json!({
                "a": a.as_ref().map(|_| "0x00000000".to_string()).unwrap_or_else(|s| status_text(*s)),
                "b": match &b { Ok(Ok(_)) => "0x00000000".to_string(), Ok(Err(s)) => status_text(*s), Err(_) => "not-run".to_string() },
                "exists": dir.join("a").join("b").is_dir(),
            });
            observe("W10.folder-chain", json!({ "a": "0x00000000", "b": "0x00000000", "exists": true }), chain);
            let outside = fixture.path("w10-outside");
            std::fs::create_dir(&outside).expect("outside");
            if junction(&dir.join("j"), &outside) {
                let open = create_relative(
                    raw(&parent),
                    "j",
                    FILE_LIST_DIRECTORY | SYNCHRONIZE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    FILE_OPEN,
                    FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
                );
                observe(
                    "W10.junction-at-folder-name",
                    json!({ "refused": true, "reparse": true }),
                    json!({ "refused": open.is_err(), "reparse": open.as_ref().err().is_some_and(|s| is_reparse_point(*s)) }),
                );
            } else {
                println!("OBSERVATION T003: unverified W10.junction-at-folder-name (missing capability ntfs-junction)");
            }
        }
    }
}
