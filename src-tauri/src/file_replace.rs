// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

//! Feature 005 contract Δ6 `fileReplace`: one atomic replace of `.gitignore` or `info/exclude` (plan.md D10).
//! The walk opens each component relative to its parent with `OBJ_DONT_REPARSE`. A complete temporary file renames over the target.

use std::os::windows::io::{FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::AtomicBool;

use windows::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows::Wdk::Storage::FileSystem::{
    FILE_CREATE, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT,
    FILE_RENAME_INFORMATION, FILE_RENAME_POSIX_SEMANTICS, FILE_RENAME_REPLACE_IF_EXISTS,
    FILE_SYNCHRONOUS_IO_NONALERT, FileAttributeTagInformation, FileRenameInformationEx,
    FileStandardInformation, NTCREATEFILE_CREATE_DISPOSITION, NtCreateFile, NtSetInformationFile,
};
use windows::Wdk::System::SystemServices::FILE_ATTRIBUTE_TAG_INFORMATION;
use windows::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_IO_DEVICE, ERROR_SHARING_VIOLATION, HANDLE, NTSTATUS,
    OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE, STATUS_FILE_IS_A_DIRECTORY,
    STATUS_OBJECT_NAME_COLLISION, STATUS_OBJECT_NAME_NOT_FOUND, UNICODE_STRING,
};
use windows::Win32::Storage::FileSystem::{
    DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO_EX,
    FILE_DISPOSITION_INFO_EX_FLAGS, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_WRITE_DATA, FileDispositionInfoEx, FlushFileBuffers, SYNCHRONIZE,
    SetFileInformationByHandle, WriteFile,
};
use windows::Win32::System::IO::IO_STATUS_BLOCK;
use windows::core::PWSTR;

use crate::file_append::IGNORE_TARGET_BYTES;
use crate::file_facts::{
    StandardInformation, error_code, is_reparse_point, open as open_relative, open_root, query,
    raw, read,
};
use crate::process_requests::{Code, native_path};
use crate::schema::process_reply::FileFactErrorCode;
use crate::schema::process_request::{FileReplace, FileReplaceExpected};
use crate::settings::{hex, sha256};

const INVALID: Code = Code::InvalidRequest;

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
    let code = error_code(status).to_string();
    ReplaceResult::Error(FileFactErrorCode::from_str(&code).unwrap_or(FileFactErrorCode::OtherError))
}

/// Opens `name` relative to `parent` with `access`, `share`, and `options`, and `disposition`.
fn create(
    parent: &OwnedHandle,
    name: &str,
    access: windows::Win32::Storage::FileSystem::FILE_ACCESS_RIGHTS,
    share: windows::Win32::Storage::FileSystem::FILE_SHARE_MODE,
    options: windows::Wdk::Storage::FileSystem::NTCREATEFILE_CREATE_OPTIONS,
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
            access,
            &raw const attributes,
            &raw mut io,
            None,
            FILE_ATTRIBUTE_NORMAL,
            share,
            disposition,
            options,
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

/// Sets `FileDispositionInfoEx` with POSIX delete on `handle`, so the name goes when the last handle closes.
fn dispose(handle: &OwnedHandle) -> NTSTATUS {
    let info = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_INFO_EX_FLAGS(
            FILE_DISPOSITION_FLAG_DELETE.0 | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS.0,
        ),
    };
    set_information(handle, FileDispositionInfoEx, unsafe {
        std::slice::from_raw_parts(
            (&raw const info).cast::<u8>(),
            size_of::<FILE_DISPOSITION_INFO_EX>(),
        )
    })
}

/// `SetFileInformationByHandle` with `class` and the raw `info` bytes.
fn set_information(
    handle: &OwnedHandle,
    class: windows::Win32::Storage::FileSystem::FILE_INFO_BY_HANDLE_CLASS,
    info: &[u8],
) -> NTSTATUS {
    // SAFETY: `handle` is open, and `info` is a live buffer of the passed length.
    match unsafe {
        SetFileInformationByHandle(raw(handle), class, info.as_ptr().cast(), info.len() as u32)
    } {
        Ok(()) => NTSTATUS(0),
        Err(error) => NTSTATUS(error.code().0),
    }
}

/// Replaces the target `names` below `root` with `bytes` in one rename. It checks `expected` first.
/// A reparse point on the way or at the target gives `NotRegular`. A different state gives `Stale`.
pub(crate) fn replace(
    root: &Path,
    names: &[String],
    expected: Option<(u64, &str)>,
    bytes: &[u8],
    stop: &AtomicBool,
) -> ReplaceResult {
    let (last, middle) = match names.split_last() {
        Some(parts) => parts,
        None => return ReplaceResult::Error(FileFactErrorCode::OtherError),
    };
    let mut parent = match open_root(root, stop) {
        Ok(handle) => handle,
        Err(status) => return failed(status),
    };
    for name in middle {
        parent = match open_relative(&parent, name, false, false, stop) {
            Ok(handle) => handle,
            Err(status) => return failed(status),
        };
    }
    // Hold the existing target open with no write sharing until the rename, so no other writer changes it.
    let replace_existing = match expected {
        Some((size, sha)) => {
            // `FILE_READ_ATTRIBUTES` serves the reparse tag and link count queries below.
            let target = match create(
                &parent,
                last,
                FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                FILE_SHARE_READ | FILE_SHARE_DELETE,
                FILE_OPEN_REPARSE_POINT | FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
                FILE_OPEN,
            ) {
                Ok(target) => target,
                Err(STATUS_OBJECT_NAME_NOT_FOUND) => return ReplaceResult::Stale,
                Err(STATUS_FILE_IS_A_DIRECTORY) => return ReplaceResult::NotRegular,
                Err(status) => return failed(status),
            };
            let tag = match query::<FILE_ATTRIBUTE_TAG_INFORMATION>(
                &target,
                FileAttributeTagInformation,
                stop,
            ) {
                Ok(tag) => tag,
                Err(status) => return failed(status),
            };
            let kind = FILE_ATTRIBUTE_DIRECTORY.0 | FILE_ATTRIBUTE_REPARSE_POINT.0;
            if tag.ReparseTag != 0 || tag.FileAttributes & kind != 0 {
                return ReplaceResult::NotRegular;
            }
            let standard =
                match query::<StandardInformation>(&target, FileStandardInformation, stop) {
                    Ok(standard) => standard,
                    Err(status) => return failed(status),
                };
            if standard.number_of_links != 1 {
                return ReplaceResult::NotRegular;
            }
            if u64::try_from(standard.end_of_file) != Ok(size) {
                return ReplaceResult::Stale;
            }
            // One byte past the size shows a longer file. The caller bounds the size.
            let read_bytes = match read(raw(&target), size as usize + 1, stop) {
                Ok(bytes) => bytes,
                Err(status) => return failed(status),
            };
            if read_bytes.len() as u64 != size || hex(&sha256(&read_bytes)) != sha {
                return ReplaceResult::Stale;
            }
            Some(target)
        }
        None => None,
    };
    // A random temporary name beside the target. The create fails if it already exists.
    let temp = match crate::settings::random_id() {
        Ok(id) => format!(".arbareto-{}.tmp", id.replace('-', "")),
        Err(_) => return ReplaceResult::Error(FileFactErrorCode::OtherError),
    };
    let temp_handle = match create(
        &parent,
        &temp,
        DELETE | FILE_WRITE_DATA | SYNCHRONIZE,
        FILE_SHARE_READ,
        FILE_SYNCHRONOUS_IO_NONALERT | FILE_NON_DIRECTORY_FILE,
        FILE_CREATE,
    ) {
        Ok(handle) => handle,
        Err(status) => return failed(status),
    };
    let result = write_and_rename(&parent, &temp_handle, last, bytes, replace_existing.is_some());
    if result != ReplaceResult::Replaced {
        // A failure after the create removes the temporary file by disposition on its handle.
        let _ = dispose(&temp_handle);
    }
    drop(temp_handle);
    drop(replace_existing);
    result
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
    let code = |error: &windows::core::Error| match error.code() {
        code if code == ERROR_ACCESS_DENIED.to_hresult() => FileFactErrorCode::AccessDenied,
        code if code == ERROR_SHARING_VIOLATION.to_hresult() => FileFactErrorCode::SharingViolation,
        code if code == ERROR_IO_DEVICE.to_hresult() => FileFactErrorCode::IoError,
        _ => FileFactErrorCode::OtherError,
    };
    match flushed {
        Ok(()) if written as usize == bytes.len() => {}
        Ok(()) => return ReplaceResult::Error(FileFactErrorCode::OtherError),
        Err(error) => return ReplaceResult::Error(code(&error)),
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

    fn names(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    fn do_replace(root: &Path, path: &[&str], expected: Option<&[u8]>, bytes: &[u8]) -> ReplaceResult {
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
            frame(json!({ "target": "exclude", "expected": { "size": 1_048_576, "sha256": sha }, "bytes": "" })),
            Ok((false, Some((1_048_576, sha.clone())), 0)),
            "an empty replacement is valid"
        );
        let big = crate::process_requests::encode_base64(&vec![b'x'; 1_048_577]);
        for (name, fields) in [
            ("a relative path", json!({ "path": ".gitignore" })),
            ("a device path", json!({ "path": "\\\\?\\C:\\repo\\.gitignore" })),
            ("bytes above 1 MiB", json!({ "bytes": big })),
            ("an expected size above 1 MiB", json!({ "expected": { "size": 1_048_577, "sha256": sha } })),
            ("a negative expected size", json!({ "expected": { "size": -1, "sha256": sha } })),
        ] {
            assert_eq!(frame(fields), Err(INVALID), "{name}");
        }
    }
}
