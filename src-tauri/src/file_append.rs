// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

//! Feature 004 contract Δ6 `fileAppend`: one append to `.gitignore` or `info/exclude` after the expected-state check.
//! Each component opens relative to its parent handle with `OBJ_DONT_REPARSE`, so the target lies below the root by identity.

use std::os::windows::io::{FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::AtomicBool;

use windows::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows::Wdk::Storage::FileSystem::{
    FILE_CREATE, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT,
    FILE_SYNCHRONOUS_IO_NONALERT, FileAttributeTagInformation, FileStandardInformation,
    NTCREATEFILE_CREATE_DISPOSITION, NtCreateFile,
};
use windows::Wdk::System::SystemServices::FILE_ATTRIBUTE_TAG_INFORMATION;
use windows::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_IO_DEVICE, ERROR_SHARING_VIOLATION, HANDLE, NTSTATUS,
    OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE, STATUS_FILE_IS_A_DIRECTORY,
    STATUS_OBJECT_NAME_COLLISION, STATUS_OBJECT_NAME_NOT_FOUND, UNICODE_STRING,
};
use windows::Win32::Storage::FileSystem::{
    FILE_APPEND_DATA, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_READ,
    FlushFileBuffers, SYNCHRONIZE, WriteFile,
};
use windows::Win32::System::IO::{IO_STATUS_BLOCK, OVERLAPPED};
use windows::core::PWSTR;

use crate::file_facts::{
    StandardInformation, error_code, is_reparse_point, open as open_relative, open_root, query,
    raw, read,
};
use crate::process_requests::{Code, INLINE_INPUT_BYTES, native_path};
use crate::schema::process_reply::FileAppendErrorCode;
use crate::schema::process_request::{FileAppend, FileAppendExpected};
use crate::settings::{hex, sha256};
const INVALID: Code = Code::InvalidRequest;
/// Contract Δ5 "Ignore target file": the largest target that the check reads.
pub(crate) const IGNORE_TARGET_BYTES: u64 = 1_048_576;

/// The result of one append (contract Δ6 `fileAppend` reply).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AppendResult {
    Appended,
    /// The target differs from `expected`.
    Stale,
    /// The target or a component on the way is a reparse point, or the target is no regular file or has more than one link.
    NotRegular,
    Error(FileAppendErrorCode),
}

/// The checked fields of a `fileAppend` frame. It reads no file.
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

/// typify drops the bounds of `bytes` and `size` and has no native path rule.
/// The expected size stays within the contract Δ5 ignore target bound, so the check reads at most 1 MiB.
pub(crate) fn parse(request: &FileAppend) -> Result<Request<'_>, Code> {
    use crate::schema::process_request::FileAppendTarget;
    let expected = match &request.expected {
        FileAppendExpected::String(_) => None,
        FileAppendExpected::FileAppendExpected { sha256, size } => {
            let size = u64::try_from(*size)
                .ok()
                .filter(|size| *size <= IGNORE_TARGET_BYTES)
                .ok_or(INVALID)?;
            Some((size, sha256.to_string()))
        }
    };
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        request.bytes.as_str(),
    )
    .ok()
    .filter(|bytes| (1..=INLINE_INPUT_BYTES).contains(&bytes.len()))
    .ok_or(INVALID)?;
    Ok(Request {
        operation_id: &request.operation_id,
        repository_id: &request.repository_id,
        gitignore: matches!(request.target, FileAppendTarget::Gitignore),
        path: native_path(&request.path)?,
        expected,
        bytes,
    })
}

/// A target that passed its check. Only `append` writes.
pub(crate) enum Opened {
    /// The parent folder and the name of a target that `expected` names absent.
    Absent(OwnedHandle, String),
    /// The target with the expected size and SHA-256. The handle denies write sharing until the append ends.
    Present(OwnedHandle),
}

fn failed(status: NTSTATUS) -> AppendResult {
    if is_reparse_point(status) {
        return AppendResult::NotRegular;
    }
    let code = error_code(status).to_string();
    AppendResult::Error(
        FileAppendErrorCode::from_str(&code).unwrap_or(FileAppendErrorCode::OtherError),
    )
}

/// Opens `name` relative to `parent` for the read and the append (contract Δ6: `FILE_APPEND_DATA` without `FILE_WRITE_DATA`).
fn create(
    parent: &OwnedHandle,
    name: &str,
    disposition: NTCREATEFILE_CREATE_DISPOSITION,
) -> Result<OwnedHandle, NTSTATUS> {
    let mut units: Vec<u16> = name.encode_utf16().collect();
    // `is_component` keeps the name within 255 units, so the byte length fits a `u16`.
    let length = (units.len() * 2) as u16;
    let object_name = UNICODE_STRING {
        Length: length,
        MaximumLength: length,
        Buffer: PWSTR(units.as_mut_ptr()),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: raw(parent),
        ObjectName: &raw const object_name,
        Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        ..Default::default()
    };
    let mut handle = HANDLE::default();
    let mut io = IO_STATUS_BLOCK::default();
    // SAFETY: each pointer refers to a live local, and `parent` keeps its handle open.
    let status = unsafe {
        NtCreateFile(
            &raw mut handle,
            FILE_READ_DATA | FILE_APPEND_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            &raw const attributes,
            &raw mut io,
            None,
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ,
            disposition,
            FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT | FILE_NON_DIRECTORY_FILE,
            None,
            0,
        )
    };
    if status.is_err() {
        return Err(status);
    }
    // SAFETY: a successful open returns a new handle that nothing else owns.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle.0) })
}

/// Walks `names` below `root` without a reparse point and checks the target against `expected`. It writes nothing.
pub(crate) fn open(
    root: &Path,
    names: &[String],
    expected: Option<(u64, &str)>,
    stop: &AtomicBool,
) -> Result<Opened, AppendResult> {
    let (last, middle) = names
        .split_last()
        .ok_or(AppendResult::Error(FileAppendErrorCode::OtherError))?;
    let mut parent = open_root(root, stop).map_err(failed)?;
    for name in middle {
        parent = open_relative(&parent, name, false, false, stop).map_err(failed)?;
    }
    let Some((size, sha)) = expected else {
        return Ok(Opened::Absent(parent, last.clone()));
    };
    let target = match create(&parent, last, FILE_OPEN) {
        Ok(target) => target,
        Err(STATUS_OBJECT_NAME_NOT_FOUND) => return Err(AppendResult::Stale),
        Err(STATUS_FILE_IS_A_DIRECTORY) => return Err(AppendResult::NotRegular),
        Err(status) => return Err(failed(status)),
    };
    let tag = query::<FILE_ATTRIBUTE_TAG_INFORMATION>(&target, FileAttributeTagInformation, stop)
        .map_err(failed)?;
    let kind = FILE_ATTRIBUTE_DIRECTORY.0 | FILE_ATTRIBUTE_REPARSE_POINT.0;
    if tag.ReparseTag != 0 || tag.FileAttributes & kind != 0 {
        return Err(AppendResult::NotRegular);
    }
    let standard =
        query::<StandardInformation>(&target, FileStandardInformation, stop).map_err(failed)?;
    if standard.number_of_links != 1 {
        return Err(AppendResult::NotRegular);
    }
    if u64::try_from(standard.end_of_file) != Ok(size) {
        return Err(AppendResult::Stale);
    }
    // One byte past the size shows a longer file. `parse` bounds the size.
    let bytes = read(raw(&target), size as usize + 1, stop).map_err(failed)?;
    if bytes.len() as u64 != size || hex(&sha256(&bytes)) != sha {
        return Err(AppendResult::Stale);
    }
    Ok(Opened::Present(target))
}

impl Opened {
    /// One `WriteFile` at the end of the file, then `FlushFileBuffers`. An absent target is created first.
    pub(crate) fn append(self, bytes: &[u8]) -> AppendResult {
        let target = match self {
            Opened::Present(target) => target,
            Opened::Absent(parent, name) => match create(&parent, &name, FILE_CREATE) {
                Ok(target) => target,
                Err(STATUS_OBJECT_NAME_COLLISION | STATUS_FILE_IS_A_DIRECTORY) => {
                    return AppendResult::Stale;
                }
                Err(status) => return failed(status),
            },
        };
        // Microsoft Learn `WriteFile`: both offsets 0xFFFFFFFF write to the end of the file.
        let mut at = OVERLAPPED::default();
        at.Anonymous.Anonymous.Offset = u32::MAX;
        at.Anonymous.Anonymous.OffsetHigh = u32::MAX;
        let mut written = 0u32;
        // SAFETY: `target` is an open synchronous handle, and `bytes`, `written`, and `at` are live for the call.
        let wrote = unsafe {
            WriteFile(
                raw(&target),
                Some(bytes),
                Some(&raw mut written),
                Some(&raw mut at),
            )
        };
        // SAFETY: `target` is open.
        let flushed = wrote.and_then(|()| unsafe { FlushFileBuffers(raw(&target)) });
        // Contract §6 "File facts" pairs each of these Win32 errors with its code.
        let code = |error: &windows::core::Error| match error.code() {
            code if code == ERROR_ACCESS_DENIED.to_hresult() => FileAppendErrorCode::AccessDenied,
            code if code == ERROR_SHARING_VIOLATION.to_hresult() => {
                FileAppendErrorCode::SharingViolation
            }
            code if code == ERROR_IO_DEVICE.to_hresult() => FileAppendErrorCode::IoError,
            _ => FileAppendErrorCode::OtherError,
        };
        match flushed {
            Ok(()) if written as usize == bytes.len() => AppendResult::Appended,
            Ok(()) => AppendResult::Error(FileAppendErrorCode::OtherError),
            Err(error) => AppendResult::Error(code(&error)),
        }
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
    use crate::schema::process_reply::FileAppendErrorCode as E;
    use crate::schema::typed;
    use crate::settings::{hex, sha256};

    /// A stop flag that no test sets.
    static RUN: AtomicBool = AtomicBool::new(false);

    fn digest(bytes: &[u8]) -> String {
        hex(&sha256(bytes))
    }

    fn names(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    /// The open and the append of one request. A refused open gives its result.
    fn append(root: &Path, path: &[&str], expected: Option<&[u8]>, bytes: &[u8]) -> AppendResult {
        let expected = expected.map(|old| (old.len() as u64, digest(old)));
        let expected = expected.as_ref().map(|(size, sha)| (*size, sha.as_str()));
        match open(root, &names(path), expected, &RUN) {
            Ok(opened) => opened.append(bytes),
            Err(refused) => refused,
        }
    }

    fn repository() -> (Fixture, PathBuf) {
        let fixture = Fixture::new();
        let root = fixture.path("repo");
        std::fs::create_dir_all(root.join(".git").join("info")).expect("repository");
        (fixture, root)
    }

    #[test]
    fn an_absent_target_is_created_once_and_an_existing_one_is_stale() {
        let (_fixture, root) = repository();
        let file = root.join(".gitignore");
        assert_eq!(
            append(&root, &[".gitignore"], None, b"/a\n"),
            AppendResult::Appended
        );
        assert_eq!(std::fs::read(&file).expect("read"), b"/a\n");
        assert_eq!(
            append(&root, &[".gitignore"], None, b"/b\n"),
            AppendResult::Stale
        );
        assert_eq!(
            std::fs::read(&file).expect("read"),
            b"/a\n",
            "no second write"
        );
        // A missing folder on the way is no state that `expected` names.
        assert_eq!(
            append(&root, &["missing", ".gitignore"], None, b"/a\n"),
            AppendResult::Error(E::OtherError)
        );
    }

    #[test]
    fn a_target_with_the_expected_size_and_sha256_takes_the_bytes_once() {
        let (_fixture, root) = repository();
        let git = root.join(".git");
        let exclude = git.join("info").join("exclude");
        std::fs::write(&exclude, b"# x\n").expect("exclude");
        assert_eq!(
            append(&git, &["info", "exclude"], Some(b"# x\n"), b"/build/\n"),
            AppendResult::Appended
        );
        assert_eq!(std::fs::read(&exclude).expect("read"), b"# x\n/build/\n");
        for (name, old) in [
            ("an earlier size", &b"# x\n"[..]),
            ("the same size and another SHA-256", &b"# y\n/build/\n"[..]),
            ("an empty file", &b""[..]),
        ] {
            assert_eq!(
                append(&git, &["info", "exclude"], Some(old), b"/out/\n"),
                AppendResult::Stale,
                "{name}"
            );
        }
        assert_eq!(
            append(&git, &["info", "absent"], Some(b""), b"/out/\n"),
            AppendResult::Stale,
            "an absent file"
        );
        assert_eq!(std::fs::read(&exclude).expect("read"), b"# x\n/build/\n");
    }

    #[test]
    fn a_reparse_point_or_a_folder_is_refused_as_not_regular_and_nothing_changes() {
        let (fixture, root) = repository();
        let outside = fixture.path("outside");
        std::fs::create_dir(&outside).expect("outside");
        let target = outside.join("exclude");
        std::fs::write(&target, b"").expect("outside file");
        std::fs::create_dir(root.join("folder")).expect("folder");
        assert_eq!(
            append(&root, &["folder"], Some(b""), b"/a\n"),
            AppendResult::NotRegular,
            "a folder"
        );
        assert_eq!(
            append(&root, &["folder"], None, b"/a\n"),
            AppendResult::Stale,
            "a folder where absent is expected"
        );
        let git = root.join(".git");
        if junction(&git.join("linked"), &outside) {
            for expected in [Some(&b""[..]), None] {
                assert_eq!(
                    append(&git, &["linked", "exclude"], expected, b"/a\n"),
                    AppendResult::NotRegular,
                    "a junction on the way"
                );
            }
            assert_eq!(
                append(&git, &["linked"], Some(b""), b"/a\n"),
                AppendResult::NotRegular,
                "a junction as the target"
            );
        } else {
            println!("SKIP fileAppend junction: missing capability ntfs-junction (unverified)");
        }
        let link = root.join(".gitignore");
        if std::os::windows::fs::symlink_file(&target, &link).is_ok() {
            assert_eq!(
                append(&root, &[".gitignore"], Some(b""), b"/a\n"),
                AppendResult::NotRegular,
                "a file symlink"
            );
        } else {
            println!("SKIP fileAppend symlink: missing capability symlink (unverified)");
        }
        let tagged = root.join("tagged");
        std::fs::write(&tagged, b"").expect("tagged");
        if set_private_tag(&tagged) {
            assert_eq!(
                append(&root, &["tagged"], Some(b""), b"/a\n"),
                AppendResult::NotRegular,
                "a reparse tag without the name-surrogate bit"
            );
        } else {
            println!("SKIP fileAppend reparse tag: missing capability reparse-tag (unverified)");
        }
        assert_eq!(
            std::fs::read(&target).expect("read"),
            b"",
            "the outside file"
        );
        assert!(!outside.join(".gitignore").exists());
    }

    /// Contract Δ6: a target with more than one link gives `not-regular`, so the append never writes another name of the file.
    #[test]
    fn a_target_with_a_second_link_is_refused_as_not_regular_and_nothing_changes() {
        let (fixture, root) = repository();
        let outside = fixture.path("outside");
        std::fs::write(&outside, b"/a\n").expect("outside file");
        if std::fs::hard_link(&outside, root.join(".gitignore")).is_err() {
            println!("SKIP fileAppend hard link: missing capability hard-link (unverified)");
            return;
        }
        assert_eq!(
            append(&root, &[".gitignore"], Some(b"/a\n"), b"/b\n"),
            AppendResult::NotRegular
        );
        assert_eq!(std::fs::read(&outside).expect("read"), b"/a\n");
    }

    /// The open denies write sharing, so no other writer changes the file between the check and the append.
    #[test]
    fn another_open_writer_gives_sharing_violation_and_no_change() {
        let (_fixture, root) = repository();
        let file = root.join(".gitignore");
        std::fs::write(&file, b"/a\n").expect("file");
        let writer = std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .expect("writer");
        assert_eq!(
            append(&root, &[".gitignore"], Some(b"/a\n"), b"/b\n"),
            AppendResult::Error(E::SharingViolation)
        );
        drop(writer);
        assert_eq!(std::fs::read(&file).expect("read"), b"/a\n");
        assert_eq!(
            append(&root, &[".gitignore"], Some(b"/a\n"), b"/b\n"),
            AppendResult::Appended
        );
    }

    /// Contract Δ6: an absolute channel path, 1 to 64 KiB of bytes, and an expected size within the 1 MiB ignore target bound (Δ5).
    #[test]
    fn the_request_rules_refuse_a_relative_path_bytes_outside_their_bound_and_a_large_expected_size()
     {
        let frame = |fields: Value| {
            let mut frame = json!({
                "type": "fileAppend", "callId": "0f0f0f0f-0000-4000-8000-000000000001", "operationId": "0f0f0f0f-0000-4000-8000-000000000004",
                "repositoryId": "0f0f0f0f-0000-4000-8000-000000000005", "target": "gitignore", "path": "C:\\repo\\.gitignore",
                "expected": "absent", "bytes": "L2EK",
            });
            frame
                .as_object_mut()
                .expect("frame")
                .extend(fields.as_object().expect("fields").clone());
            let request = typed(&frame).expect("generated type");
            parse(&request).map(|parsed| (parsed.gitignore, parsed.expected, parsed.bytes))
        };
        let sha = "b".repeat(64);
        assert_eq!(frame(json!({})), Ok((true, None, b"/a\n".to_vec())));
        assert_eq!(
            frame(json!({ "target": "exclude", "expected": { "size": 1_048_576, "sha256": sha } })),
            Ok((false, Some((1_048_576, sha.clone())), b"/a\n".to_vec()))
        );
        let big = crate::process_requests::encode_base64(&vec![b'x'; 65_537]);
        for (name, fields) in [
            ("a relative path", json!({ "path": ".gitignore" })),
            (
                "a device path",
                json!({ "path": "\\\\?\\C:\\repo\\.gitignore" }),
            ),
            ("empty bytes", json!({ "bytes": "" })),
            ("bytes above 64 KiB", json!({ "bytes": big })),
            (
                "an expected size above 1 MiB",
                json!({ "expected": { "size": 1_048_577, "sha256": sha } }),
            ),
            (
                "a negative expected size",
                json!({ "expected": { "size": -1, "sha256": sha } }),
            ),
        ] {
            assert_eq!(
                frame(fields),
                Err(crate::process_requests::Code::InvalidRequest),
                "{name}"
            );
        }
    }
}
