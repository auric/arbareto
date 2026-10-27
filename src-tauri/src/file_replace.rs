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
    // Feature 008 contract Δ6: this replace serves only the ignore targets, which take none of the `working` fields.
    if matches!(request.target, FileReplaceTarget::Working)
        || request.facts.is_some()
        || request.source.is_some()
        || !request.folders.is_empty()
    {
        return Err(INVALID);
    }
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
        request.bytes.as_ref().ok_or(INVALID)?.as_str(),
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
}
