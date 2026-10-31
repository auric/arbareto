// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

//! Feature 005 contract Δ6 `fileReplace`: one atomic replace of `.gitignore` or `info/exclude` (plan.md D10).
//! Feature 008 contract Δ6: the target `working` and `tempRemove` (plan.md D5a, D8).
//! The walk opens each component relative to its parent with `OBJ_DONT_REPARSE`. A complete temporary file renames over the target.

use std::os::windows::io::OwnedHandle;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use windows::Wdk::Storage::FileSystem::{
    FILE_BASIC_INFORMATION, FILE_CREATE, FILE_DELETE_ON_CLOSE, FILE_DIRECTORY_FILE,
    FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT, FILE_RENAME_INFORMATION,
    FILE_RENAME_POSIX_SEMANTICS, FILE_RENAME_REPLACE_IF_EXISTS, FILE_SYNCHRONOUS_IO_NONALERT,
    FileAttributeTagInformation, FileBasicInformation, FileRenameInformationEx,
    FileStandardInformation, NtSetInformationFile,
};
use windows::Wdk::System::SystemServices::FILE_ATTRIBUTE_TAG_INFORMATION;
use windows::Win32::Foundation::{
    ERROR_DISK_FULL, ERROR_WRITE_PROTECT, NTSTATUS, STATUS_DISK_FULL, STATUS_FILE_IS_A_DIRECTORY,
    STATUS_MEDIA_WRITE_PROTECTED, STATUS_OBJECT_NAME_COLLISION, STATUS_OBJECT_NAME_NOT_FOUND,
    STATUS_OBJECT_PATH_NOT_FOUND,
};
use windows::Win32::Security::{
    DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SE_DACL_AUTO_INHERIT_REQ,
    SetKernelObjectSecurity, SetSecurityDescriptorControl,
};
use windows::Win32::Storage::FileSystem::{
    DELETE, FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY, FILE_ATTRIBUTE_ARCHIVE, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_ENCRYPTED, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_READONLY,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_DISPOSITION_FLAG_DO_NOT_DELETE,
    FILE_DISPOSITION_FLAG_ON_CLOSE, FILE_DISPOSITION_INFO_EX, FILE_DISPOSITION_INFO_EX_FLAGS,
    FILE_ID_INFO, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA,
    FileDispositionInfoEx, FileIdInfo, FlushFileBuffers, GetFileInformationByHandleEx,
    READ_CONTROL, SYNCHRONIZE, SetFileInformationByHandle, WRITE_DAC, WriteFile,
};
use windows::Win32::System::IO::IO_STATUS_BLOCK;

use crate::file_facts::{
    Pour, StandardInformation, create_relative, error_code, is_reparse_point,
    open as open_relative, open_root, pour, query, raw, read, sddl, security, set_disposition,
    win32_code,
};
use crate::process_requests::{Code, native_path};
use crate::schema::process_reply::{
    FileFactErrorCode, FileReplaceErrorCode as ErrorCode, FileReplaceRefusedReason as Reason,
};
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
    /// Feature 008 contract Δ6: a `working` refusal other than `not-regular`.
    Refused(Reason),
    Error(ErrorCode),
    /// A stop came before the write, so nothing changed.
    Stopped,
    /// A WSL `replace` process could run during a stop, so the shell does not know the outcome.
    Interrupted,
    /// Feature 008 contract Δ6: a folder of the path is the Git directory or the common directory by identity.
    Invalid,
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
    ReplaceResult::Error(status_code(status))
}

/// Feature 008 contract Δ6: the reply code of a status. `disk-full` and `read-only-volume` add to the file fact codes.
fn status_code(status: NTSTATUS) -> ErrorCode {
    match status {
        STATUS_DISK_FULL => ErrorCode::DiskFull,
        STATUS_MEDIA_WRITE_PROTECTED => ErrorCode::ReadOnlyVolume,
        status => fact_code(error_code(status)),
    }
}

/// The reply code of a Win32 error, as `status_code` maps the status of the same failure.
fn win32_reply_code(error: &windows::core::Error) -> ErrorCode {
    match error.code() {
        code if code == ERROR_DISK_FULL.to_hresult() => ErrorCode::DiskFull,
        code if code == ERROR_WRITE_PROTECT.to_hresult() => ErrorCode::ReadOnlyVolume,
        _ => fact_code(win32_code(error)),
    }
}

fn fact_code(code: FileFactErrorCode) -> ErrorCode {
    match code {
        FileFactErrorCode::AccessDenied => ErrorCode::AccessDenied,
        FileFactErrorCode::SharingViolation => ErrorCode::SharingViolation,
        FileFactErrorCode::IoError => ErrorCode::IoError,
        FileFactErrorCode::OtherError => ErrorCode::OtherError,
    }
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
        .ok_or(ReplaceResult::Error(ErrorCode::OtherError))?;
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
        let Some(temp) = temp_name() else {
            return ReplaceResult::Error(ErrorCode::OtherError);
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

/// A random temporary name beside the target. Its create fails if the name exists.
fn temp_name() -> Option<String> {
    crate::settings::random_id()
        .ok()
        .map(|id| format!(".arbareto-{}.tmp", id.replace('-', "")))
}

/// Writes `bytes` and flushes the handle.
fn write_bytes(temp: &OwnedHandle, bytes: &[u8]) -> Result<(), ReplaceResult> {
    let mut written = 0u32;
    // SAFETY: `temp` is an open handle, and `bytes` and `written` are live locals.
    let wrote = unsafe { WriteFile(raw(temp), Some(bytes), Some(&raw mut written), None) };
    // SAFETY: `temp` is open.
    let flushed = wrote.and_then(|()| unsafe { FlushFileBuffers(raw(temp)) });
    match flushed {
        Ok(()) if written as usize == bytes.len() => Ok(()),
        Ok(()) => Err(ReplaceResult::Error(ErrorCode::OtherError)),
        Err(error) => Err(ReplaceResult::Error(win32_reply_code(&error))),
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
    if let Err(result) = write_bytes(temp, bytes) {
        return result;
    }
    rename(parent, temp, name, replace_existing)
}

/// Renames the temporary handle over `name` in `parent`. A failed rename is not tried again (feature 008 spec FR-037).
fn rename(
    parent: &OwnedHandle,
    temp: &OwnedHandle,
    name: &str,
    replace_existing: bool,
) -> ReplaceResult {
    #[cfg(test)]
    tests::RENAMES.with(|count| count.set(count.get() + 1));
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

// ---- Feature 008 contract Δ6 `fileReplace` `working` and `tempRemove` (plan.md D5a, D8) ----

/// The new bytes of a `working` replace: the bytes of a line revert, or Git's temporary file in the worktree root.
#[derive(Debug)]
pub(crate) enum Content {
    Bytes(Vec<u8>),
    Source(Source),
}

/// Data-model §8a: Git's temporary file of `checkout-index --temp`, one name component in the worktree root.
#[derive(Clone, Debug)]
pub(crate) struct Source {
    pub(crate) name: String,
    pub(crate) size: u64,
    pub(crate) sha256: String,
}

/// Data-model §3 `working` on Windows: the bound facts beside the size and the SHA-256. `owner`, `group`, and `dacl` are SDDL.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WindowsFacts {
    pub(crate) attributes: u32,
    pub(crate) links: u64,
    pub(crate) owner: String,
    pub(crate) group: String,
    pub(crate) dacl: String,
    pub(crate) creation_time: i64,
}

/// Data-model §3 `working` on WSL. `mode` holds `st_mode & 07777`, the bits that the replace copies (plan.md D9).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WslFacts {
    pub(crate) mode: u32,
    pub(crate) uid: u32,
    pub(crate) gid: u32,
    pub(crate) links: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Facts {
    Windows(WindowsFacts),
    Wsl(WslFacts),
}

/// An existing target: `expected` and `facts` of the frame.
#[derive(Clone, Debug)]
pub(crate) struct Present {
    pub(crate) size: u64,
    pub(crate) sha256: String,
    pub(crate) facts: Facts,
}

/// Feature 008 contract Δ6: the reply facts of one `working` replace beside its result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Written {
    pub(crate) result: ReplaceResult,
    /// The folders that the write created, also before a later failure. They stay.
    pub(crate) folders: Vec<String>,
    /// `replaced` only: the delete of Git's temporary file failed, so it stays at its name.
    pub(crate) source_kept: bool,
}

impl From<ReplaceResult> for Written {
    fn from(result: ReplaceResult) -> Written {
        Written {
            result,
            folders: Vec::new(),
            source_kept: false,
        }
    }
}

/// The checked fields of a `fileReplace` `working` frame. It reads no file.
#[derive(Debug)]
pub(crate) struct Working<'a> {
    pub(crate) operation_id: &'a str,
    pub(crate) repository_id: &'a str,
    pub(crate) path: PathBuf,
    /// `None` is `absent`.
    pub(crate) present: Option<Present>,
    pub(crate) content: Content,
    /// The missing folders below the deepest existing folder, top first. Only with `absent`.
    pub(crate) folders: Vec<String>,
    /// Contract Δ6 `mode` of an absent target: true for `100755`.
    pub(crate) executable: bool,
}

/// `schema::working_replace` keeps the field rules that typify drops. The handler checks the path and the marker.
pub(crate) fn parse_working(request: &FileReplace) -> Result<Working<'_>, Code> {
    use crate::schema::process_request::FileReplaceFacts as F;
    crate::schema::working_replace(request)?;
    let present = match (&request.expected, request.facts.as_ref()) {
        (FileReplaceExpected::String(_), _) => None,
        (FileReplaceExpected::FileReplaceExpected { sha256, size }, Some(facts)) => {
            let facts = match facts {
                F::WindowsWorkingFacts {
                    attributes,
                    creation_time,
                    dacl,
                    group,
                    links,
                    owner,
                    ..
                } => Facts::Windows(WindowsFacts {
                    attributes: *attributes,
                    links: links.get(),
                    owner: owner.to_string(),
                    group: group.to_string(),
                    dacl: dacl.to_string(),
                    creation_time: creation_time.parse().map_err(|_| INVALID)?,
                }),
                F::WslWorkingFacts {
                    gid,
                    links,
                    mode,
                    uid,
                    ..
                } => Facts::Wsl(WslFacts {
                    mode: *mode,
                    uid: *uid,
                    gid: *gid,
                    links: links.get(),
                }),
                F::String(_) => return Err(INVALID),
            };
            Some(Present {
                size: u64::try_from(*size).map_err(|_| INVALID)?,
                sha256: sha256.to_string(),
                facts,
            })
        }
        (FileReplaceExpected::FileReplaceExpected { .. }, None) => return Err(INVALID),
    };
    let content = match (&request.bytes, &request.source) {
        (Some(bytes), None) => Content::Bytes(
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, bytes.as_str())
                .ok()
                .filter(|bytes| bytes.len() <= crate::schema::REVERT_FILE_BYTES)
                .ok_or(INVALID)?,
        ),
        (None, Some(source)) => Content::Source(Source {
            name: source.name.to_string(),
            size: u64::try_from(source.size).map_err(|_| INVALID)?,
            sha256: source.sha256.to_string(),
        }),
        _ => return Err(INVALID),
    };
    Ok(Working {
        operation_id: &request.operation_id,
        repository_id: &request.repository_id,
        path: native_path(&request.path)?,
        present,
        content,
        folders: request
            .folders
            .iter()
            .map(|name| name.to_string())
            .collect(),
        executable: matches!(
            request.git_mode,
            Some(crate::schema::process_request::FileReplaceGitMode::X100755)
        ),
    })
}

/// Contract Δ3 and Δ6: 1 s for each started 64 MiB of `bytes`.
pub(crate) fn size_rule(bytes: u64) -> std::time::Duration {
    std::time::Duration::from_secs(bytes.div_ceil(64 << 20))
}

/// The facts of the existing target that the check read under its held handle.
struct Held {
    /// Open without write sharing until the write, so no other writer changes the target before the rename.
    handle: OwnedHandle,
    basic: FILE_BASIC_INFORMATION,
    /// The owner, group, and DACL as one self-relative descriptor.
    descriptor: Vec<u8>,
    sddl: [String; 3],
}

/// One `working` replace after its check. It holds the worktree root, the parent folder, and the existing target until the write.
pub(crate) struct WorkingChecked {
    root: OwnedHandle,
    /// `None` when the deepest existing folder is the root.
    parent: Option<OwnedHandle>,
    name: String,
    /// The missing folder names, top first.
    folders: Vec<String>,
    target: Option<Held>,
}

/// The `FileIdInfo` identity of a handle (contract §6 "Process fields").
fn file_id(handle: &OwnedHandle) -> Option<(u64, [u8; 16])> {
    let mut info = FILE_ID_INFO::default();
    // SAFETY: `handle` is open, and `info` has the passed size.
    unsafe {
        GetFileInformationByHandleEx(
            raw(handle),
            FileIdInfo,
            (&raw mut info).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    }
    .ok()?;
    Some((info.VolumeSerialNumber, info.FileId.Identifier))
}

/// True when `name` in `parent` opens the file of `held`, by `FileIdInfo`. A failed open or query gives false.
fn same_file(parent: &OwnedHandle, name: &str, held: &OwnedHandle) -> bool {
    let now = create_relative(
        raw(parent),
        name,
        FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        FILE_OPEN,
        FILE_OPEN_REPARSE_POINT | FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
    );
    match (now.ok().as_ref().and_then(file_id), file_id(held)) {
        (Some(now), Some(held)) => now == held,
        _ => false,
    }
}

/// A missing component of a bound path means that the state changed since the review.
fn walked(status: NTSTATUS) -> ReplaceResult {
    match status {
        STATUS_OBJECT_NAME_NOT_FOUND | STATUS_OBJECT_PATH_NOT_FOUND => ReplaceResult::Stale,
        status => failed(status),
    }
}

/// The attribute bits that a new file gets from the write or reports for no other bit (research.md R15, probe W1).
const UNCOMPARED: u32 = FILE_ATTRIBUTE_ARCHIVE.0 | FILE_ATTRIBUTE_NORMAL.0;

/// Walks to the deepest existing folder of `names` below `root` and checks the target against `present`.
/// `folders` is the count of the missing folders before the last name. It writes nothing and respects `stop`.
/// A folder on the way with the identity of a `git` folder gives `Invalid`.
pub(crate) fn check_working(
    root: &Path,
    git: &[&Path],
    names: &[String],
    present: Option<(u64, &str, &WindowsFacts)>,
    folders: usize,
    stop: &AtomicBool,
) -> Result<WorkingChecked, ReplaceResult> {
    let other = ReplaceResult::Error(ErrorCode::OtherError);
    let (last, middle) = names.split_last().ok_or(other.clone())?;
    let existing = middle.len().checked_sub(folders).ok_or(other.clone())?;
    let guards = git
        .iter()
        .map(|path| {
            open_root(path, stop)
                .map_err(failed)
                .and_then(|handle| file_id(&handle).ok_or(other.clone()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let guard = |handle: &OwnedHandle| match file_id(handle) {
        Some(id) if guards.contains(&id) => Err(ReplaceResult::Invalid),
        Some(_) => Ok(()),
        None => Err(other.clone()),
    };
    let top = open_root(root, stop).map_err(walked)?;
    guard(&top)?;
    let mut parent: Option<OwnedHandle> = None;
    for name in &middle[..existing] {
        let next = open_relative(parent.as_ref().unwrap_or(&top), name, false, false, stop)
            .map_err(walked)?;
        guard(&next)?;
        parent = Some(next);
    }
    let target = match present {
        None => None,
        Some((size, sha, facts)) => Some(held(
            parent.as_ref().unwrap_or(&top),
            last,
            (size, sha),
            facts,
            stop,
        )?),
    };
    Ok(WorkingChecked {
        root: top,
        parent,
        name: last.clone(),
        folders: middle[existing..].to_vec(),
        target,
    })
}

/// Opens the existing target without write sharing and checks it against the frame (research.md R8).
fn held(
    parent: &OwnedHandle,
    name: &str,
    (size, sha): (u64, &str),
    facts: &WindowsFacts,
    stop: &AtomicBool,
) -> Result<Held, ReplaceResult> {
    let handle = create_relative(
        raw(parent),
        name,
        FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_DELETE,
        FILE_OPEN,
        FILE_OPEN_REPARSE_POINT | FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
    )
    .map_err(|status| match status {
        STATUS_FILE_IS_A_DIRECTORY => ReplaceResult::NotRegular,
        status => walked(status),
    })?;
    let tag = query::<FILE_ATTRIBUTE_TAG_INFORMATION>(&handle, FileAttributeTagInformation, stop)
        .map_err(failed)?;
    let kind = FILE_ATTRIBUTE_DIRECTORY.0 | FILE_ATTRIBUTE_REPARSE_POINT.0;
    if tag.ReparseTag != 0 || tag.FileAttributes & kind != 0 {
        return Err(ReplaceResult::NotRegular);
    }
    let standard =
        query::<StandardInformation>(&handle, FileStandardInformation, stop).map_err(failed)?;
    if standard.number_of_links != 1 {
        return Err(ReplaceResult::Refused(Reason::HardLink));
    }
    let basic =
        query::<FILE_BASIC_INFORMATION>(&handle, FileBasicInformation, stop).map_err(failed)?;
    let descriptor =
        security(&handle).map_err(|error| ReplaceResult::Error(win32_reply_code(&error)))?;
    let sddl = sddl(&descriptor).map_err(|error| ReplaceResult::Error(win32_reply_code(&error)))?;
    let bound = [&facts.owner, &facts.group, &facts.dacl];
    if u64::try_from(standard.end_of_file) != Ok(size)
        || facts.links != 1
        || basic.FileAttributes != facts.attributes
        || basic.CreationTime != facts.creation_time
        || sddl.iter().zip(bound).any(|(read, bound)| read != bound)
    {
        return Err(ReplaceResult::Stale);
    }
    // The digest streams through the held handle, so this target has no read bound.
    let (read, digest) =
        pour(raw(&handle), None, stop).map_err(|failure| failed(failure.status()))?;
    if read != size || digest != sha {
        return Err(ReplaceResult::Stale);
    }
    if basic.FileAttributes & FILE_ATTRIBUTE_READONLY.0 != 0 {
        return Err(ReplaceResult::Refused(Reason::ReadOnly));
    }
    if basic.FileAttributes & FILE_ATTRIBUTE_ENCRYPTED.0 != 0 {
        return Err(ReplaceResult::Refused(Reason::Encrypted));
    }
    Ok(Held {
        handle,
        basic,
        descriptor,
        sddl,
    })
}

impl WorkingChecked {
    fn parent(&self) -> &OwnedHandle {
        self.parent.as_ref().unwrap_or(&self.root)
    }

    /// Creates the folders, copies the facts to a temporary file, writes `content`, and renames it over the target. It does not stop.
    pub(crate) fn write(self, content: &Content) -> Written {
        let source = match content {
            Content::Bytes(_) => None,
            Content::Source(source) => match open_source(&self.root, source) {
                Ok(handle) => Some(handle),
                Err(result) => return result.into(),
            },
        };
        let mut made: Vec<String> = Vec::new();
        let mut verified = false;
        let result = match &source {
            Some(handle) => match check_source(handle, content) {
                Ok(()) => self.finish(content, source.as_ref(), &mut made, &mut verified),
                Err(result) => result,
            },
            None => self.finish(content, None, &mut made, &mut verified),
        };
        // Contract Δ6 (batch 1 review): only a matched digest proves Git's temporary file, so only then the source goes.
        let deleted = match &source {
            Some(handle) if verified => set_disposition(handle).is_ok(),
            _ => true,
        };
        Written {
            source_kept: result == ReplaceResult::Replaced && !deleted,
            result,
            folders: made,
        }
    }

    fn finish(
        &self,
        content: &Content,
        source: Option<&OwnedHandle>,
        made: &mut Vec<String>,
        verified: &mut bool,
    ) -> ReplaceResult {
        let mut created: Option<OwnedHandle> = None;
        for name in &self.folders {
            let at = created.as_ref().unwrap_or(self.parent());
            match create_relative(
                raw(at),
                name,
                FILE_LIST_DIRECTORY
                    | FILE_TRAVERSE
                    | FILE_ADD_FILE
                    | FILE_ADD_SUBDIRECTORY
                    | SYNCHRONIZE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                FILE_CREATE,
                FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
            ) {
                Ok(handle) => {
                    made.push(name.clone());
                    created = Some(handle);
                }
                Err(STATUS_OBJECT_NAME_COLLISION) => return ReplaceResult::Stale,
                Err(status) => return failed(status),
            }
        }
        let parent = created.as_ref().unwrap_or(self.parent());
        let Some(temp_name) = temp_name() else {
            return ReplaceResult::Error(ErrorCode::OtherError);
        };
        // Probe W6: a crash before the clear of the delete disposition leaves no file.
        let temp = match create_relative(
            raw(parent),
            &temp_name,
            DELETE
                | FILE_WRITE_DATA
                | FILE_WRITE_ATTRIBUTES
                | FILE_READ_ATTRIBUTES
                | READ_CONTROL
                | WRITE_DAC
                | SYNCHRONIZE,
            FILE_SHARE_READ,
            FILE_CREATE,
            FILE_SYNCHRONOUS_IO_NONALERT | FILE_NON_DIRECTORY_FILE | FILE_DELETE_ON_CLOSE,
        ) {
            Ok(handle) => handle,
            Err(status) => return failed(status),
        };
        let mut cleared = false;
        let result = (|| {
            if let Some(held) = &self.target {
                copy_facts(&temp, held)?;
            }
            match (content, source) {
                (Content::Source(from), Some(source)) => {
                    let (read, digest) = pour(
                        raw(source),
                        Some(raw(&temp)),
                        &AtomicBool::new(false),
                    )
                    .map_err(|failure| match failure {
                        Pour::Read(status) => failed(status),
                        Pour::Write(error) => ReplaceResult::Error(win32_reply_code(&error)),
                    })?;
                    if read != from.size || digest != from.sha256 {
                        return Err(ReplaceResult::Stale);
                    }
                    *verified = true;
                    // SAFETY: `temp` is open.
                    unsafe { FlushFileBuffers(raw(&temp)) }
                        .map_err(|error| ReplaceResult::Error(win32_reply_code(&error)))?;
                }
                (Content::Bytes(bytes), _) => write_bytes(&temp, bytes)?,
                (Content::Source(_), None) => {
                    return Err(ReplaceResult::Error(ErrorCode::OtherError));
                }
            }
            // Batch 1 review S1: the target name must still name the held file, else another file took the name after the check.
            if let Some(held) = &self.target
                && !same_file(parent, &self.name, &held.handle)
            {
                return Err(ReplaceResult::Stale);
            }
            clear_disposition(&temp)
                .map_err(|error| ReplaceResult::Error(win32_reply_code(&error)))?;
            cleared = true;
            match rename(parent, &temp, &self.name, self.target.is_some()) {
                ReplaceResult::Replaced => Ok(ReplaceResult::Replaced),
                other => Err(other),
            }
        })();
        match result {
            Ok(result) => result,
            Err(result) => {
                // After the clear, only a delete disposition removes the temporary file.
                if cleared {
                    let _ = set_disposition(&temp);
                }
                result
            }
        }
    }
}

/// Research.md R8 (probes W1, W2, W3): the attributes, the creation time, and the DACL of the old file on the temporary file.
fn copy_facts(temp: &OwnedHandle, held: &Held) -> Result<(), ReplaceResult> {
    let info = FILE_BASIC_INFORMATION {
        CreationTime: held.basic.CreationTime,
        FileAttributes: held.basic.FileAttributes,
        ..Default::default()
    };
    let mut io = IO_STATUS_BLOCK::default();
    // SAFETY: `temp` is open with `FILE_WRITE_ATTRIBUTES`, and `info` is a live local of the passed size.
    let status = unsafe {
        NtSetInformationFile(
            raw(temp),
            &raw mut io,
            (&raw const info).cast(),
            size_of::<FILE_BASIC_INFORMATION>() as u32,
            FileBasicInformation,
        )
    };
    if status.is_err() {
        return Err(failed(status));
    }
    let run = AtomicBool::new(false);
    let copied =
        query::<FILE_BASIC_INFORMATION>(temp, FileBasicInformation, &run).map_err(failed)?;
    // Probe W1: the copy does not set compressed or sparse and reports no error.
    if copied.FileAttributes & !UNCOMPARED != held.basic.FileAttributes & !UNCOMPARED {
        return Err(ReplaceResult::Refused(Reason::FileAttributes));
    }
    let code = |error: windows::core::Error| ReplaceResult::Error(win32_reply_code(&error));
    // Probe W2 (user decision 2026-10-27): `SE_DACL_AUTO_INHERIT_REQ` keeps `SE_DACL_AUTO_INHERITED` on the copy.
    let mut descriptor = held.descriptor.clone();
    let pointer = PSECURITY_DESCRIPTOR(descriptor.as_mut_ptr().cast());
    // SAFETY: `descriptor` is a live self-relative descriptor from `GetKernelObjectSecurity`.
    unsafe {
        SetSecurityDescriptorControl(pointer, SE_DACL_AUTO_INHERIT_REQ, SE_DACL_AUTO_INHERIT_REQ)
    }
    .map_err(code)?;
    // SAFETY: `temp` is open with `WRITE_DAC`, and `descriptor` stays live for the call.
    unsafe { SetKernelObjectSecurity(raw(temp), DACL_SECURITY_INFORMATION, pointer) }
        .map_err(code)?;
    let copy = sddl(&security(temp).map_err(code)?).map_err(code)?;
    match security_refusal(&held.sddl, &copy) {
        Some(reason) => Err(ReplaceResult::Refused(reason)),
        None => Ok(()),
    }
}

/// Plan.md D8 and research.md R8: the owner, group, and DACL texts of the temporary file after the DACL copy against the old file.
pub(crate) fn security_refusal(old: &[String; 3], copy: &[String; 3]) -> Option<Reason> {
    if old[0] != copy[0] {
        Some(Reason::Owner)
    } else if old[1..] != copy[1..] {
        Some(Reason::Security)
    } else {
        None
    }
}

/// `FileDispositionInformationEx` with `FILE_DISPOSITION_FLAG_DO_NOT_DELETE | FILE_DISPOSITION_FLAG_ON_CLOSE` (probe W6).
fn clear_disposition(handle: &OwnedHandle) -> windows::core::Result<()> {
    let info = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_INFO_EX_FLAGS(
            FILE_DISPOSITION_FLAG_DO_NOT_DELETE.0 | FILE_DISPOSITION_FLAG_ON_CLOSE.0,
        ),
    };
    // SAFETY: `handle` is open with `DELETE`, and `info` is a live local of the passed size.
    unsafe {
        SetFileInformationByHandle(
            raw(handle),
            FileDispositionInfoEx,
            (&raw const info).cast(),
            size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
        )
    }
}

/// Opens Git's temporary file relative to the worktree root without following a link. A failure here leaves it to `tempRemove`.
fn open_source(root: &OwnedHandle, source: &Source) -> Result<OwnedHandle, ReplaceResult> {
    create_relative(
        raw(root),
        &source.name,
        FILE_READ_DATA | FILE_READ_ATTRIBUTES | DELETE | SYNCHRONIZE,
        FILE_SHARE_READ,
        FILE_OPEN,
        FILE_OPEN_REPARSE_POINT | FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
    )
    .map_err(|status| match status {
        STATUS_FILE_IS_A_DIRECTORY => ReplaceResult::NotRegular,
        status => walked(status),
    })
}

/// Contract Δ6 `source`: a regular file with one link and the requested size.
fn check_source(handle: &OwnedHandle, content: &Content) -> Result<(), ReplaceResult> {
    let Content::Source(source) = content else {
        return Err(ReplaceResult::Error(ErrorCode::OtherError));
    };
    let run = AtomicBool::new(false);
    let tag = query::<FILE_ATTRIBUTE_TAG_INFORMATION>(handle, FileAttributeTagInformation, &run)
        .map_err(failed)?;
    if tag.ReparseTag != 0 || tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        return Err(ReplaceResult::NotRegular);
    }
    let standard =
        query::<StandardInformation>(handle, FileStandardInformation, &run).map_err(failed)?;
    if standard.number_of_links != 1 {
        return Err(ReplaceResult::Refused(Reason::HardLink));
    }
    if u64::try_from(standard.end_of_file) != Ok(source.size) {
        return Err(ReplaceResult::Stale);
    }
    Ok(())
}

/// The result of one `tempRemove` (contract Δ6).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TempResult {
    Removed,
    Stale,
    Absent,
    /// A Windows stop or deadline before the delete, so nothing was removed.
    Stopped,
    /// A WSL stop, deadline, or broken output, so the shell does not know the outcome.
    Interrupted,
    Error(ErrorCode),
}

/// Opens Git's temporary file `name` in the worktree root and checks its facts. It removes nothing and respects `stop`.
pub(crate) fn check_temp(
    root: &Path,
    name: &str,
    (size, sha): (u64, &str),
    stop: &AtomicBool,
) -> Result<OwnedHandle, TempResult> {
    let error = |status: NTSTATUS| TempResult::Error(status_code(status));
    let top = open_root(root, stop).map_err(error)?;
    let handle = create_relative(
        raw(&top),
        name,
        FILE_READ_DATA | FILE_READ_ATTRIBUTES | DELETE | SYNCHRONIZE,
        FILE_SHARE_READ,
        FILE_OPEN,
        FILE_OPEN_REPARSE_POINT | FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
    )
    .map_err(|status| match status {
        STATUS_OBJECT_NAME_NOT_FOUND | STATUS_OBJECT_PATH_NOT_FOUND => TempResult::Absent,
        STATUS_FILE_IS_A_DIRECTORY => TempResult::Stale,
        status => error(status),
    })?;
    let tag = query::<FILE_ATTRIBUTE_TAG_INFORMATION>(&handle, FileAttributeTagInformation, stop)
        .map_err(error)?;
    let standard =
        query::<StandardInformation>(&handle, FileStandardInformation, stop).map_err(error)?;
    if tag.ReparseTag != 0
        || tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
        || standard.number_of_links != 1
        || u64::try_from(standard.end_of_file) != Ok(size)
    {
        return Err(TempResult::Stale);
    }
    let (read, digest) =
        pour(raw(&handle), None, stop).map_err(|failure| error(failure.status()))?;
    if read != size || digest != sha {
        return Err(TempResult::Stale);
    }
    Ok(handle)
}

/// Deletes the checked temporary file through its handle.
pub(crate) fn remove_temp(handle: OwnedHandle) -> TempResult {
    match set_disposition(&handle) {
        Ok(()) => TempResult::Removed,
        Err(error) => TempResult::Error(win32_reply_code(&error)),
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

    thread_local! {
        /// The rename calls of this thread (feature 008 spec FR-037).
        pub(super) static RENAMES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

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

    /// Feature 008 T012 and T013: the Windows `working` replace and `tempRemove` (contract Δ6, plan.md D5a, D8, research.md R8, R15).
    mod working {
        use std::os::windows::fs::MetadataExt;
        use std::os::windows::io::OwnedHandle;
        use std::path::{Path, PathBuf};
        use std::process::{Command, Stdio};
        use std::sync::atomic::AtomicBool;

        use serde_json::{Value, json};
        use windows::Win32::Security::{
            DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SetKernelObjectSecurity,
        };
        use windows::Win32::Storage::FileSystem::{
            EncryptFileW, FILE_ATTRIBUTE_ARCHIVE, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_NORMAL,
            FILE_ATTRIBUTE_NOT_CONTENT_INDEXED, FILE_ATTRIBUTE_READONLY, FILE_ATTRIBUTE_SYSTEM,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
            READ_CONTROL, WRITE_DAC,
        };
        use windows::Win32::System::IO::DeviceIoControl;
        use windows::Win32::System::Ioctl::{FSCTL_SET_COMPRESSION, FSCTL_SET_SPARSE};
        use windows::core::HSTRING;

        use super::super::{
            Content, ErrorCode, Reason, ReplaceResult, Source, TempResult, WindowsFacts, Written,
            check_temp, check_working, parse_working, remove_temp, security_refusal, size_rule,
        };
        use super::revert_facts::{
            OLD_CREATION, attributes, descriptor_at, security, set_attributes, set_basic,
        };
        use super::{RENAMES, RUN, digest, names};
        use crate::file_facts::tests::set_private_tag;
        use crate::file_facts::{Read, raw, sddl, walk_read};
        use crate::jobs::tests::Fixture;
        use crate::process_requests::tests::junction;
        use crate::schema::process_reply::FileFactsReplyFactsItem as Fact;
        use crate::schema::typed;

        const MIB: usize = 1 << 20;
        static STOPPED: AtomicBool = AtomicBool::new(true);

        struct Repo {
            root: PathBuf,
            git: PathBuf,
            outside: PathBuf,
            _fixture: Fixture,
        }

        fn repo() -> Repo {
            let fixture = Fixture::new();
            let root = fixture.path("repo");
            let git = root.join(".git");
            std::fs::create_dir_all(&git).expect("repository");
            let outside = fixture.path("outside");
            std::fs::create_dir(&outside).expect("outside");
            Repo {
                root,
                git,
                outside,
                _fixture: fixture,
            }
        }

        /// The bound facts of `path` below `root`, as a `fileFacts` read with `digest`, `detail`, and `stream` gives them.
        fn bound(root: &Path, path: &[&str]) -> (u64, String, WindowsFacts) {
            let facts = walk_read(
                [root, root, root],
                true,
                Read {
                    detail: true,
                    stream: true,
                },
                &[(0, names(path))],
                &RUN,
                &|_| {},
            );
            match &facts[0] {
                Fact::File {
                    size,
                    digest: Some(sha),
                    attributes: Some(attributes),
                    links: Some(links),
                    owner: Some(owner),
                    group: Some(group),
                    dacl: Some(dacl),
                    creation_time: Some(creation),
                    ..
                } => (
                    u64::try_from(*size).expect("size"),
                    sha.to_string(),
                    WindowsFacts {
                        attributes: *attributes,
                        links: links.get(),
                        owner: owner.to_string(),
                        group: group.to_string(),
                        dacl: dacl.to_string(),
                        creation_time: creation.parse().expect("creation time"),
                    },
                ),
                other => panic!("a file fact with detail: {other:?}"),
            }
        }

        fn write_in(
            root: &Path,
            git: &[&Path],
            path: &[&str],
            present: Option<&(u64, String, WindowsFacts)>,
            folders: usize,
            content: &Content,
        ) -> Written {
            let present = present.map(|(size, sha, facts)| (*size, sha.as_str(), facts));
            check_working(root, git, &names(path), present, folders, &RUN)
                .map_or_else(Written::from, |checked| checked.write(content))
        }

        fn replace_in(
            root: &Path,
            git: &[&Path],
            path: &[&str],
            present: Option<&(u64, String, WindowsFacts)>,
            folders: usize,
            content: &Content,
        ) -> ReplaceResult {
            write_in(root, git, path, present, folders, content).result
        }

        fn written(result: ReplaceResult, folders: &[&str], source_kept: bool) -> Written {
            Written {
                result,
                folders: names(folders),
                source_kept,
            }
        }

        fn replace(
            repo: &Repo,
            path: &[&str],
            present: Option<&(u64, String, WindowsFacts)>,
            content: &Content,
        ) -> ReplaceResult {
            replace_in(
                &repo.root,
                &[&repo.git, &repo.git],
                path,
                present,
                0,
                content,
            )
        }

        fn bytes(bytes: &[u8]) -> Content {
            Content::Bytes(bytes.to_vec())
        }

        /// The names of the replace temporary files in `dir`.
        fn temps(dir: &Path) -> Vec<String> {
            std::fs::read_dir(dir)
                .expect("dir")
                .filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with(".arbareto-"))
                .collect()
        }

        fn icacls(path: &Path, arguments: &[&str]) {
            let status = Command::new("icacls")
                .arg(path)
                .args(arguments)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("icacls");
            assert!(status.success(), "icacls {arguments:?}");
        }

        /// The SDDL texts of the owner, group, and DACL of `path`.
        fn sddl_at(path: &Path) -> [String; 3] {
            sddl(&descriptor_at(path)).expect("SDDL")
        }

        /// `FSCTL_SET_COMPRESSION` or `FSCTL_SET_SPARSE` on `path`, as probe W1 sets them.
        fn set_storage(path: &Path, compressed: bool) -> bool {
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(path)
                .expect("open");
            let handle = OwnedHandle::from(file);
            let format = 1u16;
            let mut returned = 0u32;
            let (code, input, size) = if compressed {
                (FSCTL_SET_COMPRESSION, Some((&raw const format).cast()), 2)
            } else {
                (FSCTL_SET_SPARSE, None, 0)
            };
            // SAFETY: `handle` is open, and `format` and `returned` are live locals.
            unsafe {
                DeviceIoControl(
                    raw(&handle),
                    code,
                    input,
                    size,
                    None,
                    0,
                    Some(&raw mut returned),
                    None,
                )
            }
            .is_ok()
        }

        /// Contract Δ6 and research.md R8: a `working` replace gives the new bytes and keeps hidden, system, not-content-indexed,
        /// the creation time, the owner, the group, and the DACL. The rename sets the archive attribute (research.md R15).
        #[test]
        fn a_working_replace_writes_the_bytes_and_keeps_the_r8_facts() {
            let repo = repo();
            let path = repo.root.join("a.txt");
            std::fs::write(&path, b"old\n").expect("old");
            let file = std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .expect("open");
            assert!(
                set_basic(&OwnedHandle::from(file), OLD_CREATION, 0).is_ok(),
                "creation time"
            );
            let kept = FILE_ATTRIBUTE_HIDDEN.0
                | FILE_ATTRIBUTE_SYSTEM.0
                | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED.0;
            assert!(set_attributes(&path, kept), "attributes");
            let old_sddl = sddl_at(&path);
            let old_descriptor = descriptor_at(&path);
            let old_write = std::fs::metadata(&path)
                .expect("metadata")
                .last_write_time();
            let facts = bound(&repo.root, &["a.txt"]);
            assert_eq!(
                replace(&repo, &["a.txt"], Some(&facts), &bytes(b"new\n")),
                ReplaceResult::Replaced
            );
            assert_eq!(std::fs::read(&path).expect("read"), b"new\n");
            assert_eq!(
                attributes(&path) & (kept | FILE_ATTRIBUTE_ARCHIVE.0),
                kept | FILE_ATTRIBUTE_ARCHIVE.0
            );
            assert_eq!(
                std::fs::metadata(&path).expect("metadata").creation_time() as i64,
                OLD_CREATION
            );
            assert!(
                std::fs::metadata(&path)
                    .expect("metadata")
                    .last_write_time()
                    > old_write,
                "the last write time is the time of the write"
            );
            assert_eq!(sddl_at(&path), old_sddl);
            assert_eq!(descriptor_at(&path), old_descriptor);
            assert!(temps(&repo.root).is_empty(), "no temporary file stays");
            set_attributes(&path, FILE_ATTRIBUTE_NORMAL.0);
        }

        /// Contract Δ6: each bound fact and the digest take part in the check. A difference gives `stale`, and nothing changes.
        #[test]
        fn a_target_whose_facts_or_digest_differ_from_the_frame_is_stale() {
            let repo = repo();
            let path = repo.root.join("a.txt");
            std::fs::write(&path, b"old\n").expect("old");
            let facts = bound(&repo.root, &["a.txt"]);
            let changed = |change: &dyn Fn(&mut (u64, String, WindowsFacts))| {
                let mut facts = facts.clone();
                change(&mut facts);
                facts
            };
            for (name, frame) in [
                ("size", changed(&|f| f.0 += 1)),
                ("sha256", changed(&|f| f.1 = digest(b"other\n"))),
                (
                    "attributes",
                    changed(&|f| f.2.attributes ^= FILE_ATTRIBUTE_HIDDEN.0),
                ),
                ("creation time", changed(&|f| f.2.creation_time += 1)),
                ("owner", changed(&|f| f.2.owner = "O:SY".to_string())),
                ("group", changed(&|f| f.2.group = "G:SY".to_string())),
                (
                    "dacl",
                    changed(&|f| f.2.dacl = "D:(A;;FA;;;SY)".to_string()),
                ),
            ] {
                assert_eq!(
                    replace(&repo, &["a.txt"], Some(&frame), &bytes(b"new\n")),
                    ReplaceResult::Stale,
                    "{name}"
                );
                assert_eq!(std::fs::read(&path).expect("read"), b"old\n", "{name}");
            }
            std::fs::remove_file(&path).expect("remove");
            assert_eq!(
                replace(&repo, &["a.txt"], Some(&facts), &bytes(b"new\n")),
                ReplaceResult::Stale,
                "absent"
            );
            assert!(!path.exists(), "absent stays absent");
            assert!(temps(&repo.root).is_empty());
        }

        /// Contract Δ6 refusals: a folder and a reparse point give `not-regular`, and a second link gives `hard-link` (probe W4).
        #[test]
        fn a_folder_a_reparse_point_or_a_second_link_refuses() {
            let repo = repo();
            std::fs::create_dir(repo.root.join("folder")).expect("folder");
            let some = (0, digest(b""), bound_any());
            assert_eq!(
                replace(&repo, &["folder"], Some(&some), &bytes(b"x")),
                ReplaceResult::NotRegular,
                "a folder"
            );
            let tagged = repo.root.join("tagged");
            std::fs::write(&tagged, b"").expect("tagged");
            if set_private_tag(&tagged) {
                assert_eq!(
                    replace(&repo, &["tagged"], Some(&some), &bytes(b"x")),
                    ReplaceResult::NotRegular,
                    "a reparse tag"
                );
            } else {
                println!("SKIP working reparse tag: missing capability reparse-tag (unverified)");
            }
            if junction(&repo.root.join("j"), &repo.outside) {
                assert_eq!(
                    replace(&repo, &["j"], Some(&some), &bytes(b"x")),
                    ReplaceResult::NotRegular,
                    "a junction"
                );
            } else {
                println!("SKIP working junction: missing capability ntfs-junction (unverified)");
            }
            let other = repo.outside.join("other.txt");
            std::fs::write(&other, b"old\n").expect("other");
            let linked = repo.root.join("linked.txt");
            if std::fs::hard_link(&other, &linked).is_ok() {
                let facts = bound(&repo.root, &["linked.txt"]);
                assert_eq!(facts.2.links, 2);
                assert_eq!(
                    replace(&repo, &["linked.txt"], Some(&facts), &bytes(b"new\n")),
                    ReplaceResult::Refused(Reason::HardLink)
                );
                assert_eq!(std::fs::read(&other).expect("read"), b"old\n");
                assert_eq!(std::fs::read(&linked).expect("read"), b"old\n");
            } else {
                println!("SKIP working hard link: missing capability hard-link (unverified)");
            }
            assert!(temps(&repo.root).is_empty());
        }

        /// Facts for a target that the check refuses before it compares them.
        fn bound_any() -> WindowsFacts {
            WindowsFacts {
                attributes: 0,
                links: 1,
                owner: "O:SY".to_string(),
                group: "G:SY".to_string(),
                dacl: "D:".to_string(),
                creation_time: 0,
            }
        }

        /// Research.md R8: a read-only target refuses with `read-only`, and an EFS target with `encrypted` (probe W11).
        #[test]
        fn a_read_only_or_an_encrypted_target_refuses() {
            let repo = repo();
            let path = repo.root.join("ro.txt");
            std::fs::write(&path, b"old\n").expect("old");
            assert!(
                set_attributes(&path, FILE_ATTRIBUTE_READONLY.0),
                "read-only"
            );
            let facts = bound(&repo.root, &["ro.txt"]);
            assert_eq!(
                replace(&repo, &["ro.txt"], Some(&facts), &bytes(b"new\n")),
                ReplaceResult::Refused(Reason::ReadOnly)
            );
            set_attributes(&path, FILE_ATTRIBUTE_NORMAL.0);
            assert_eq!(std::fs::read(&path).expect("read"), b"old\n");
            let encrypted = repo.root.join("efs.txt");
            std::fs::write(&encrypted, b"old\n").expect("old");
            // SAFETY: the path is a live wide string for the call.
            if unsafe { EncryptFileW(&HSTRING::from(encrypted.as_path())) }.is_ok() {
                let facts = bound(&repo.root, &["efs.txt"]);
                assert_eq!(
                    replace(&repo, &["efs.txt"], Some(&facts), &bytes(b"new\n")),
                    ReplaceResult::Refused(Reason::Encrypted)
                );
                assert_eq!(std::fs::read(&encrypted).expect("read"), b"old\n");
            } else {
                println!("SKIP working encrypted: missing capability efs (unverified)");
            }
            assert!(temps(&repo.root).is_empty());
        }

        /// Research.md R8 and R15 (probe W1): the attribute copy does not set compressed or sparse, so such a target refuses
        /// with `file-attributes`, and no temporary file stays.
        #[test]
        fn a_compressed_or_sparse_target_refuses_with_file_attributes() {
            let repo = repo();
            for (name, compressed) in [("compressed.txt", true), ("sparse.txt", false)] {
                let path = repo.root.join(name);
                std::fs::write(&path, b"old\n").expect("old");
                if !set_storage(&path, compressed) {
                    println!("SKIP working {name}: missing capability ntfs-{name} (unverified)");
                    continue;
                }
                let facts = bound(&repo.root, &[name]);
                assert_eq!(
                    replace(&repo, &[name], Some(&facts), &bytes(b"new\n")),
                    ReplaceResult::Refused(Reason::FileAttributes),
                    "{name}"
                );
                assert_eq!(std::fs::read(&path).expect("read"), b"old\n");
            }
            assert!(
                temps(&repo.root).is_empty(),
                "no temporary file after a failed write"
            );
        }

        /// Plan.md D8: another owner of the copy refuses with `owner`; another group or DACL after the DACL copy with `security`.
        /// No probed fixture gives such a copy (research.md R15), so this case checks the compare itself.
        #[test]
        fn the_security_compare_refuses_another_owner_group_or_dacl() {
            let old = [
                "O:S-1-5-21-1".to_string(),
                "G:S-1-5-21-2".to_string(),
                "D:AI(A;ID;FA;;;SY)".to_string(),
            ];
            assert_eq!(security_refusal(&old, &old.clone()), None);
            for (part, reason) in [
                (0, Reason::Owner),
                (1, Reason::Security),
                (2, Reason::Security),
            ] {
                let mut copy = old.clone();
                copy[part].push('X');
                assert_eq!(security_refusal(&old, &copy), Some(reason), "part {part}");
            }
            let mut copy = old.clone();
            copy[0].push('X');
            copy[2].push('X');
            assert_eq!(
                security_refusal(&old, &copy),
                Some(Reason::Owner),
                "the owner comes first"
            );
        }

        /// Contract Δ6 `folders` and probe W10: the missing folders come below the held parent. An existing folder or name gives
        /// `stale`, and a reparse point at a folder name gives `not-regular`.
        #[test]
        fn an_absent_target_creates_its_folders_and_a_reparse_point_at_a_folder_name_refuses() {
            let repo = repo();
            let git: &[&Path] = &[&repo.git];
            assert_eq!(
                write_in(
                    &repo.root,
                    git,
                    &["a", "b", "n.txt"],
                    None,
                    2,
                    &bytes(b"new\n")
                ),
                written(ReplaceResult::Replaced, &["a", "b"], false)
            );
            assert_eq!(
                std::fs::read(repo.root.join("a").join("b").join("n.txt")).expect("read"),
                b"new\n"
            );
            assert!(temps(&repo.root.join("a").join("b")).is_empty());
            assert_eq!(
                replace_in(&repo.root, git, &["a", "c", "n.txt"], None, 2, &bytes(b"x")),
                ReplaceResult::Stale,
                "an existing folder"
            );
            assert!(
                !repo.root.join("a").join("c").exists(),
                "no folder below an existing one"
            );
            assert_eq!(
                replace_in(&repo.root, git, &["a", "b", "n.txt"], None, 0, &bytes(b"x")),
                ReplaceResult::Stale,
                "an existing name"
            );
            assert_eq!(
                std::fs::read(repo.root.join("a").join("b").join("n.txt")).expect("read"),
                b"new\n"
            );
            if junction(&repo.root.join("j"), &repo.outside) {
                assert_eq!(
                    replace_in(&repo.root, git, &["j", "n.txt"], None, 0, &bytes(b"x")),
                    ReplaceResult::NotRegular,
                    "a junction at a folder name"
                );
                assert_eq!(
                    replace_in(&repo.root, git, &["j", "d", "n.txt"], None, 1, &bytes(b"x")),
                    ReplaceResult::NotRegular,
                    "a folder create through a junction"
                );
                assert_eq!(
                    std::fs::read_dir(&repo.outside).expect("outside").count(),
                    0,
                    "nothing in the junction target"
                );
            } else {
                println!(
                    "SKIP working junction folder: missing capability ntfs-junction (unverified)"
                );
            }
        }

        /// Contract Δ6: a folder of the path that is the Git directory by identity gives `INVALID_REQUEST`, in any letter case.
        #[test]
        fn a_path_through_the_git_directory_by_identity_is_invalid() {
            let repo = repo();
            let store = repo.root.join("store");
            std::fs::create_dir(&store).expect("separate Git directory");
            std::fs::write(store.join("config"), b"[core]\n").expect("config");
            let config = (
                7,
                digest(b"[core]\n"),
                bound(&repo.root, &["store", "config"]).2,
            );
            for names in [&["store", "config"][..], &["STORE", "config"][..]] {
                assert_eq!(
                    replace_in(
                        &repo.root,
                        &[&store, &repo.git],
                        names,
                        Some(&config),
                        0,
                        &bytes(b"x")
                    ),
                    ReplaceResult::Invalid,
                    "{names:?}"
                );
            }
            assert_eq!(
                std::fs::read(store.join("config")).expect("read"),
                b"[core]\n"
            );
            assert_eq!(
                replace_in(&repo.root, &[&repo.root], &["n.txt"], None, 0, &bytes(b"x")),
                ReplaceResult::Invalid,
                "the root itself"
            );
        }

        /// Research.md R8 (probes W5 and W8) and spec FR-037: a held target gives `sharing-violation`, and a read-only attribute
        /// that appears after the check gives `access-denied`. The rename runs once, and no temporary file stays.
        #[test]
        fn a_held_target_or_a_late_read_only_attribute_fails_with_its_code_and_one_rename() {
            use std::os::windows::fs::OpenOptionsExt;
            let repo = repo();
            let path = repo.root.join("a.txt");
            std::fs::write(&path, b"old\n").expect("old");
            let facts = bound(&repo.root, &["a.txt"]);
            let all = (FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).0;
            {
                let _writer = std::fs::OpenOptions::new()
                    .write(true)
                    .share_mode(all)
                    .open(&path)
                    .expect("writer");
                RENAMES.with(|c| c.set(0));
                assert_eq!(
                    replace(&repo, &["a.txt"], Some(&facts), &bytes(b"new\n")),
                    ReplaceResult::Error(ErrorCode::SharingViolation),
                    "a writer fails the check open"
                );
                assert_eq!(RENAMES.with(|c| c.get()), 0);
            }
            {
                let _holder = std::fs::OpenOptions::new()
                    .read(true)
                    .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE).0)
                    .open(&path)
                    .expect("holder");
                RENAMES.with(|c| c.set(0));
                assert_eq!(
                    replace(&repo, &["a.txt"], Some(&facts), &bytes(b"new\n")),
                    ReplaceResult::Error(ErrorCode::SharingViolation),
                    "a holder without delete sharing fails the rename"
                );
                assert_eq!(RENAMES.with(|c| c.get()), 1, "no second rename");
            }
            let checked = check_working(
                &repo.root,
                &[&repo.git],
                &names(&["a.txt"]),
                Some((facts.0, &facts.1, &facts.2)),
                0,
                &RUN,
            )
            .unwrap_or_else(|result| panic!("check: {result:?}"));
            assert!(
                set_attributes(&path, FILE_ATTRIBUTE_READONLY.0),
                "read-only after the check"
            );
            RENAMES.with(|c| c.set(0));
            assert_eq!(
                checked.write(&bytes(b"new\n")).result,
                ReplaceResult::Error(ErrorCode::AccessDenied)
            );
            assert_eq!(RENAMES.with(|c| c.get()), 1, "no second rename");
            set_attributes(&path, FILE_ATTRIBUTE_NORMAL.0);
            assert_eq!(std::fs::read(&path).expect("read"), b"old\n");
            assert!(
                temps(&repo.root).is_empty(),
                "no temporary file after a failed write"
            );
        }

        /// Contract §6 "Walks": a stopped check opens nothing more, so the write never runs.
        #[test]
        fn a_stopped_check_writes_nothing() {
            let repo = repo();
            let path = repo.root.join("a.txt");
            std::fs::write(&path, b"old\n").expect("old");
            let facts = bound(&repo.root, &["a.txt"]);
            assert!(
                check_working(
                    &repo.root,
                    &[&repo.git],
                    &names(&["a.txt"]),
                    Some((facts.0, &facts.1, &facts.2)),
                    0,
                    &STOPPED
                )
                .is_err()
            );
            assert_eq!(std::fs::read(&path).expect("read"), b"old\n");
            assert!(
                check_working(
                    &repo.root,
                    &[&repo.git],
                    &names(&["a.txt"]),
                    Some((facts.0, &facts.1, &facts.2)),
                    0,
                    &RUN
                )
                .is_ok(),
                "the same check without the stop"
            );
        }

        fn source(repo: &Repo, name: &str, bytes: &[u8]) -> Source {
            std::fs::write(repo.root.join(name), bytes).expect("source");
            Source {
                name: name.to_string(),
                size: bytes.len() as u64,
                sha256: digest(bytes),
            }
        }

        /// Plan.md D5a step 5 and contract Δ6 `source`: a 40 MiB Git temporary file copies beside the target with a streamed
        /// digest, and the source goes through its handle after the rename.
        #[test]
        fn a_source_copies_with_a_streamed_digest_and_goes_after_the_rename() {
            let repo = repo();
            std::fs::create_dir(repo.root.join("sub")).expect("sub");
            let target = repo.root.join("sub").join("big.bin");
            std::fs::write(&target, b"old\n").expect("old");
            let data: Vec<u8> = (0..40 * MIB).map(|i| (i % 251) as u8).collect();
            let from = source(&repo, ".merge_file_t012aa", &data);
            let facts = bound(&repo.root, &["sub", "big.bin"]);
            assert_eq!(
                replace(
                    &repo,
                    &["sub", "big.bin"],
                    Some(&facts),
                    &Content::Source(from)
                ),
                ReplaceResult::Replaced
            );
            assert_eq!(
                digest(&std::fs::read(&target).expect("read")),
                digest(&data)
            );
            assert!(
                !repo.root.join(".merge_file_t012aa").exists(),
                "the source goes"
            );
            assert!(temps(&repo.root.join("sub")).is_empty());
        }

        /// Contract Δ6 `source` (batch 1 review): another digest or size gives `stale`, and a reparse point or a second link at the
        /// source refuses. The source then stays for `tempRemove`, because only a matched digest proves that it is Git's temporary file.
        #[test]
        fn a_changed_or_linked_source_refuses_and_stays() {
            let repo = repo();
            let target = repo.root.join("a.txt");
            std::fs::write(&target, b"old\n").expect("old");
            let facts = bound(&repo.root, &["a.txt"]);
            let run =
                |from: Source| replace(&repo, &["a.txt"], Some(&facts), &Content::Source(from));
            let mut wrong = source(&repo, ".merge_file_digest", b"new\n");
            wrong.sha256 = digest(b"other\n");
            assert_eq!(run(wrong), ReplaceResult::Stale, "another digest");
            assert!(
                repo.root.join(".merge_file_digest").exists(),
                "another digest stays"
            );
            let mut size = source(&repo, ".merge_file_size", b"new\n");
            size.size += 1;
            assert_eq!(run(size), ReplaceResult::Stale, "another size");
            assert!(
                repo.root.join(".merge_file_size").exists(),
                "another size stays"
            );
            assert_eq!(
                run(Source {
                    name: ".merge_file_gone".to_string(),
                    size: 4,
                    sha256: digest(b"new\n")
                }),
                ReplaceResult::Stale,
                "a missing source"
            );
            let linked = source(&repo, ".merge_file_link", b"new\n");
            let other = repo.outside.join("other");
            if std::fs::hard_link(repo.root.join(".merge_file_link"), &other).is_ok() {
                assert_eq!(
                    run(linked),
                    ReplaceResult::Refused(Reason::HardLink),
                    "a second link"
                );
                assert_eq!(
                    [
                        std::fs::read(repo.root.join(".merge_file_link")).ok(),
                        std::fs::read(&other).ok()
                    ],
                    [Some(b"new\n".to_vec()), Some(b"new\n".to_vec())],
                    "a hard-linked source keeps both names"
                );
            } else {
                println!(
                    "SKIP working source hard link: missing capability hard-link (unverified)"
                );
            }
            let tagged = source(&repo, ".merge_file_tag", b"new\n");
            if set_private_tag(&repo.root.join(".merge_file_tag")) {
                assert_eq!(run(tagged), ReplaceResult::NotRegular, "a reparse point");
                assert!(
                    repo.root.join(".merge_file_tag").exists(),
                    "a reparse point stays"
                );
            } else {
                println!(
                    "SKIP working source reparse tag: missing capability reparse-tag (unverified)"
                );
            }
            // A gitfile under another name with a wrong digest proves nothing, so it stays.
            std::fs::write(repo.root.join(".git-file"), b"gitdir: x\n").expect("gitfile");
            let gitfile = Source {
                name: ".git-file".to_string(),
                size: 10,
                sha256: digest(b"other bytes"),
            };
            assert_eq!(run(gitfile), ReplaceResult::Stale);
            assert_eq!(
                std::fs::read(repo.root.join(".git-file")).expect("read"),
                b"gitdir: x\n"
            );
            assert_eq!(std::fs::read(&target).expect("read"), b"old\n");
            assert!(temps(&repo.root).is_empty());
        }

        /// Contract Δ6 `source`: after its digest matched, the source goes also after a later failure. A matched source that the
        /// shell cannot delete stays, and the `replaced` reply says `source: kept`.
        #[test]
        fn a_matched_source_goes_after_a_later_failure_and_a_kept_source_shows_in_the_reply() {
            use std::os::windows::fs::OpenOptionsExt;
            let repo = repo();
            let target = repo.root.join("a.txt");
            std::fs::write(&target, b"old\n").expect("old");
            let facts = bound(&repo.root, &["a.txt"]);
            let from = source(&repo, ".merge_file_rename", b"new\n");
            {
                let _holder = std::fs::OpenOptions::new()
                    .read(true)
                    .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE).0)
                    .open(&target)
                    .expect("holder");
                assert_eq!(
                    replace(&repo, &["a.txt"], Some(&facts), &Content::Source(from)),
                    ReplaceResult::Error(ErrorCode::SharingViolation)
                );
            }
            assert!(
                !repo.root.join(".merge_file_rename").exists(),
                "a matched source goes after the failed rename"
            );
            let from = source(&repo, ".merge_file_kept", b"new\n");
            assert!(
                set_attributes(
                    &repo.root.join(".merge_file_kept"),
                    FILE_ATTRIBUTE_READONLY.0
                ),
                "read-only source"
            );
            assert_eq!(
                write_in(
                    &repo.root,
                    &[&repo.git],
                    &["a.txt"],
                    Some(&facts),
                    0,
                    &Content::Source(from)
                ),
                written(ReplaceResult::Replaced, &[], true)
            );
            assert_eq!(std::fs::read(&target).expect("read"), b"new\n");
            assert!(
                repo.root.join(".merge_file_kept").exists(),
                "the kept source stays"
            );
            set_attributes(&repo.root.join(".merge_file_kept"), FILE_ATTRIBUTE_NORMAL.0);
        }

        /// Contract Δ6 `folders`: the folders that a write created before a later failure come back in the reply, and they stay.
        #[test]
        fn the_folders_of_a_failed_write_come_back_in_the_reply() {
            let repo = repo();
            let mut from = source(&repo, ".merge_file_folders", b"new\n");
            from.sha256 = digest(b"other\n");
            assert_eq!(
                write_in(
                    &repo.root,
                    &[&repo.git],
                    &["a", "b", "n.txt"],
                    None,
                    2,
                    &Content::Source(from)
                ),
                written(ReplaceResult::Stale, &["a", "b"], false)
            );
            assert!(repo.root.join("a").join("b").is_dir(), "the folders stay");
            assert!(!repo.root.join("a").join("b").join("n.txt").exists());
            assert!(
                repo.root.join(".merge_file_folders").exists(),
                "an unmatched source stays"
            );
            assert_eq!(
                write_in(
                    &repo.root,
                    &[&repo.git],
                    &["a", "c", "d", "n.txt"],
                    None,
                    3,
                    &bytes(b"x")
                ),
                written(ReplaceResult::Stale, &[], false),
                "an existing first folder creates nothing"
            );
        }

        /// Batch 1 review S1: just before the rename, the target name must still name the held file. A file renamed over it
        /// after the check gives `stale`, and no rename runs.
        #[test]
        fn a_target_swapped_after_the_check_gives_stale_and_no_rename() {
            let repo = repo();
            let target = repo.root.join("a.txt");
            std::fs::write(&target, b"old\n").expect("old");
            let facts = bound(&repo.root, &["a.txt"]);
            let checked = check_working(
                &repo.root,
                &[&repo.git],
                &names(&["a.txt"]),
                Some((facts.0, &facts.1, &facts.2)),
                0,
                &RUN,
            )
            .unwrap_or_else(|result| panic!("check: {result:?}"));
            std::fs::write(repo.root.join("other.txt"), b"other\n").expect("other");
            std::fs::rename(repo.root.join("other.txt"), &target)
                .expect("a rename over the held target");
            RENAMES.with(|c| c.set(0));
            assert_eq!(checked.write(&bytes(b"new\n")).result, ReplaceResult::Stale);
            assert_eq!(RENAMES.with(|c| c.get()), 0, "no rename");
            assert_eq!(std::fs::read(&target).expect("read"), b"other\n");
            assert!(temps(&repo.root).is_empty());
        }

        /// Contract Δ6 `tempRemove`: the file goes only when its facts equal `expected`.
        #[test]
        fn a_temp_remove_deletes_only_a_matching_regular_file() {
            let repo = repo();
            let remove = |name: &str, expected: (u64, &str)| {
                check_temp(&repo.root, name, expected, &RUN)
                    .map_or_else(|result| result, remove_temp)
            };
            std::fs::write(repo.root.join(".merge_file_a"), b"new\n").expect("temp");
            let sha = digest(b"new\n");
            assert_eq!(
                remove(".merge_file_a", (4, &digest(b"old\n"))),
                TempResult::Stale,
                "another digest"
            );
            assert_eq!(
                remove(".merge_file_a", (5, &sha)),
                TempResult::Stale,
                "another size"
            );
            assert!(
                repo.root.join(".merge_file_a").exists(),
                "a stale file stays"
            );
            assert_eq!(remove(".merge_file_a", (4, &sha)), TempResult::Removed);
            assert!(!repo.root.join(".merge_file_a").exists());
            assert_eq!(remove(".merge_file_a", (4, &sha)), TempResult::Absent);
            std::fs::create_dir(repo.root.join(".merge_file_d")).expect("folder");
            assert_eq!(
                remove(".merge_file_d", (0, &digest(b""))),
                TempResult::Stale,
                "a folder"
            );
            std::fs::write(repo.root.join(".merge_file_l"), b"new\n").expect("temp");
            if std::fs::hard_link(repo.root.join(".merge_file_l"), repo.outside.join("l")).is_ok() {
                assert_eq!(
                    remove(".merge_file_l", (4, &sha)),
                    TempResult::Stale,
                    "a second link"
                );
                assert!(repo.root.join(".merge_file_l").exists());
            }
            assert!(
                check_temp(&repo.root, ".merge_file_l", (4, &sha), &STOPPED).is_err(),
                "a stopped check"
            );
        }

        /// Contract Δ3 and Δ6: 1 s for each started 64 MiB.
        #[test]
        fn the_size_rule_adds_one_second_per_started_64_mib() {
            let mib64 = 64u64 << 20;
            for (bytes, seconds) in [(0, 0), (1, 1), (mib64, 1), (mib64 + 1, 2), (1 << 30, 16)] {
                assert_eq!(
                    size_rule(bytes),
                    std::time::Duration::from_secs(seconds),
                    "{bytes}"
                );
            }
        }

        /// Contract Δ6 and Δ10: the field rules of a `working` frame that typify drops.
        #[test]
        fn the_working_frame_rules_refuse_each_field_outside_the_contract() {
            let sha = "b".repeat(64);
            let facts = json!({ "size": 4, "sha256": sha, "attributes": 32, "links": 1, "owner": "O:SY", "group": "G:SY", "dacl": "D:", "creationTime": "5" });
            let frame = |fields: Value| {
                let mut frame = json!({
                    "type": "fileReplace", "callId": "0f0f0f0f-0000-4000-8000-000000000001",
                    "operationId": "0f0f0f0f-0000-4000-8000-000000000004", "repositoryId": "0f0f0f0f-0000-4000-8000-000000000005",
                    "target": "working", "path": "C:\\repo\\a.txt", "expected": { "size": 4, "sha256": sha }, "facts": facts, "bytes": "bmV3Cg==",
                });
                let object = frame.as_object_mut().expect("frame");
                for (key, value) in fields.as_object().expect("fields") {
                    if value.is_null() {
                        object.remove(key);
                    } else {
                        object.insert(key.clone(), value.clone());
                    }
                }
                typed(&frame)
                    .ok_or(super::super::INVALID)
                    .and_then(|request| {
                        parse_working(&request).map(|w| {
                            (
                                w.present.map(|p| p.size),
                                w.folders.len(),
                                matches!(w.content, Content::Source(_)),
                                w.executable,
                            )
                        })
                    })
            };
            assert_eq!(frame(json!({})), Ok((Some(4), 0, false, false)));
            let source = json!({ "name": ".merge_file_x", "size": 9, "sha256": sha });
            assert_eq!(
                frame(
                    json!({ "bytes": null, "source": source, "expected": "absent", "facts": "absent", "folders": ["a", "b"], "gitMode": "100644" })
                ),
                Ok((None, 2, true, false))
            );
            assert_eq!(
                frame(
                    json!({ "bytes": null, "source": source, "expected": "absent", "facts": "absent", "gitMode": "100755" })
                ),
                Ok((None, 0, true, true)),
                "gitMode 100755"
            );
            let big = crate::process_requests::encode_base64(&vec![
                b'x';
                crate::schema::REVERT_FILE_BYTES
                    + 1
            ]);
            for (name, fields) in [
                ("bytes above REVERT_FILE_BYTES", json!({ "bytes": big })),
                ("bytes and source", json!({ "source": source })),
                ("neither bytes nor source", json!({ "bytes": null })),
                (
                    "facts of another size",
                    json!({ "facts": { "size": 5, "sha256": sha, "attributes": 32, "links": 1, "owner": "O:SY", "group": "G:SY", "dacl": "D:", "creationTime": "5" } }),
                ),
                ("no facts", json!({ "facts": null })),
                ("folders with a present target", json!({ "folders": ["a"] })),
                (
                    "a source name with a separator",
                    json!({ "bytes": null, "source": { "name": "a\\b", "size": 9, "sha256": sha } }),
                ),
                ("a relative path", json!({ "path": "a.txt" })),
                ("an ignore target", json!({ "target": "gitignore" })),
                (
                    "an absent target without gitMode",
                    json!({ "bytes": null, "source": source, "expected": "absent", "facts": "absent" }),
                ),
                (
                    "gitMode with a present target",
                    json!({ "gitMode": "100644" }),
                ),
                (
                    "another gitMode",
                    json!({ "bytes": null, "source": source, "expected": "absent", "facts": "absent", "gitMode": "100664" }),
                ),
                (
                    "a .git source name",
                    json!({ "bytes": null, "source": { "name": ".GIT", "size": 9, "sha256": sha } }),
                ),
            ] {
                assert_eq!(frame(fields), Err(super::super::INVALID), "{name}");
            }
        }

        /// A folder handle with `READ_CONTROL` and `WRITE_DAC`.
        fn folder(path: &Path) -> OwnedHandle {
            use std::os::windows::fs::OpenOptionsExt;
            let file = std::fs::OpenOptions::new()
                .access_mode(READ_CONTROL.0 | WRITE_DAC.0)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
                .open(path)
                .expect("open the folder for WRITE_DAC");
            OwnedHandle::from(file)
        }

        /// T013: the DACL copy of probe W2 (research.md R15, user decision 2026-10-27) in the ten W2 cases, with the copy before
        /// the write (plan.md D8). Each result has the owner, group, and DACL bytes and the SDDL of the old file.
        #[test]
        fn the_dacl_copy_before_the_write_keeps_the_descriptor_in_the_ten_w2_cases() {
            let fixture = Fixture::new();
            // `AU` (S-1-5-11) is in no other fixture ACE, so a copy that keeps or drops its inherited ACE shows in the bytes.
            const OTHER: &[&str] = &["/grant", "*S-1-5-11:(OI)(CI)(RX)"];
            let mut cases = 0;
            for (folder_kind, folder_acl) in [
                ("plain", None),
                (
                    "auto-inherited",
                    Some(&["/grant", "*S-1-5-32-545:(OI)(CI)(RX)"][..]),
                ),
            ] {
                let made = |name: &str, other: bool| {
                    let dir = fixture.path(&format!("t013-{folder_kind}-{name}"));
                    std::fs::create_dir(&dir).expect("folder");
                    if let Some(arguments) = folder_acl {
                        icacls(&dir, arguments);
                    }
                    if other {
                        icacls(&dir, OTHER);
                    }
                    dir
                };
                let from = made("source", true);
                let changed = made("changed", true);
                for (kind, file_acl) in [
                    ("inherited-only", None),
                    ("explicit-ace", Some(&["/grant", "*S-1-5-32-545:(R)"][..])),
                    ("protected", Some(&["/inheritance:d"][..])),
                    ("renamed-in", None),
                    ("folder-ace-after", None),
                ] {
                    let dir = made(kind, false);
                    let path = dir.join("f.txt");
                    if kind == "renamed-in" {
                        std::fs::write(from.join("f.txt"), b"old\n").expect("old");
                        std::fs::rename(from.join("f.txt"), &path).expect("rename in");
                    } else {
                        std::fs::write(&path, b"old\n").expect("old");
                    }
                    if let Some(arguments) = file_acl {
                        icacls(&path, arguments);
                    }
                    if kind == "folder-ace-after" {
                        let mut descriptor = security(&folder(&changed), DACL_SECURITY_INFORMATION);
                        // SAFETY: the handle has `WRITE_DAC`, and `descriptor` is a live self-relative descriptor.
                        unsafe {
                            SetKernelObjectSecurity(
                                raw(&folder(&dir)),
                                DACL_SECURITY_INFORMATION,
                                PSECURITY_DESCRIPTOR(descriptor.as_mut_ptr().cast()),
                            )
                        }
                        .expect("set the folder DACL");
                    }
                    let old = descriptor_at(&path);
                    let old_sddl = sddl_at(&path);
                    let facts = bound(&dir, &["f.txt"]);
                    assert_eq!(
                        replace_in(&dir, &[], &["f.txt"], Some(&facts), 0, &bytes(b"new\n")),
                        ReplaceResult::Replaced,
                        "{folder_kind} {kind}"
                    );
                    assert_eq!(std::fs::read(&path).expect("read"), b"new\n");
                    assert_eq!(
                        descriptor_at(&path),
                        old,
                        "{folder_kind} {kind}: owner, group, and DACL bytes"
                    );
                    assert_eq!(sddl_at(&path), old_sddl, "{folder_kind} {kind}: SDDL");
                    cases += 1;
                }
            }
            assert_eq!(cases, 10);
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
            FILE_DISPOSITION_INFO_EX_FLAGS, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAGS_AND_ATTRIBUTES,
            FILE_LIST_DIRECTORY,
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
        pub(super) const OLD_CREATION: i64 = 132_223_104_000_000_000;

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

        pub(super) fn attributes(path: &Path) -> u32 {
            let name = wide(path);
            // SAFETY: `name` is a live, NUL-terminated wide string.
            unsafe { GetFileAttributesW(PCWSTR(name.as_ptr())) }
        }

        pub(super) fn set_attributes(path: &Path, bits: u32) -> bool {
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

        pub(super) fn set_basic(handle: &OwnedHandle, creation: i64, attributes: u32) -> NTSTATUS {
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

        pub(super) fn security(handle: &OwnedHandle, info: OBJECT_SECURITY_INFORMATION) -> Vec<u8> {
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
        pub(super) fn descriptor_at(path: &Path) -> Vec<u8> {
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
        /// `copy_first` runs the attribute and DACL copy before the write, in the plan.md D8 order.
        fn replace(
            dir: &Path,
            name: &str,
            basic: bool,
            dacl: Dacl,
            delete_on_close: bool,
            copy_first: bool,
        ) -> Value {
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
            let mut copy = || -> Option<Value> {
                if basic {
                    let status = set_basic(&temp, old.CreationTime, old.FileAttributes);
                    if status.is_err() {
                        return Some(fail("basic", status_text(status)));
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
                            return Some(fail("control", format!("{:?}", error.code())));
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
                        return Some(fail("dacl", format!("{:?}", error.code())));
                    }
                }
                None
            };
            let result = (|| {
                if copy_first && let Some(failed) = copy() {
                    return failed;
                }
                if !write(&temp, NEW) {
                    return fail("write", String::new());
                }
                if !copy_first && let Some(failed) = copy() {
                    return failed;
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
                for (sequence, basic, copy_first) in
                    [("005", false, false), ("copy", true, false), ("copy-first", true, true)]
                {
                    let name = format!("{id}-{sequence}.txt");
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
                    let result = replace(&dir, &name, basic, Dacl::None, false, copy_first);
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
            // A folder handle with `READ_CONTROL` and `WRITE_DAC`. `FILE_FLAG_BACKUP_SEMANTICS` opens a folder.
            let folder = |path: &Path| {
                use std::os::windows::fs::OpenOptionsExt;
                let file = std::fs::OpenOptions::new()
                    .access_mode(READ_CONTROL.0 | WRITE_DAC.0)
                    .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
                    .open(path)
                    .expect("open the folder for WRITE_DAC");
                OwnedHandle::from(file)
            };
            // `AU` (S-1-5-11) is in no other fixture ACE, so a copy that keeps or drops its inherited ACE shows in the bytes.
            const OTHER: &[&str] = &["/grant", "*S-1-5-11:(OI)(CI)(RX)"];
            let fixture = Fixture::new();
            let methods = [
                ("none", Dacl::None, false),
                ("kernel", Dacl::Kernel, false),
                ("kernel-flag", Dacl::KernelFlag, false),
                ("kernel-auto-inherit", Dacl::KernelAutoInherit, false),
                ("kernel-auto-inherit-first", Dacl::KernelAutoInherit, true),
            ];
            // `auto-inherited`: an icacls grant rewrites the folder DACL with inheritable ACEs and `SE_DACL_AUTO_INHERITED`.
            for (folder_kind, folder_acl) in [
                ("plain", None),
                ("auto-inherited", Some(&["/grant", "*S-1-5-32-545:(OI)(CI)(RX)"][..])),
            ] {
                let made = |name: &str, other: bool| {
                    let dir = fixture.path(&format!("w2-{folder_kind}-{name}"));
                    std::fs::create_dir(&dir).expect("w2");
                    if let Some(arguments) = folder_acl {
                        icacls(&dir, arguments);
                    }
                    if other {
                        icacls(&dir, OTHER);
                    }
                    dir
                };
                // `renamed-in`: each file comes from a folder with the extra inheritable ACE, and NTFS keeps its descriptor on the rename.
                // `folder-ace-after`: the kernel call sets the extra ACE on the folder after the files exist, so no ACE reaches them.
                let source = made("source", true);
                let changed = made("changed", true);
                for (kind, file_acl) in [
                    ("inherited-only", None),
                    ("explicit-ace", Some(&["/grant", "*S-1-5-32-545:(R)"][..])),
                    ("protected", Some(&["/inheritance:d"][..])),
                    ("renamed-in", None),
                    ("folder-ace-after", None),
                ] {
                    let dir = made(kind, false);
                    for (method, _, _) in methods {
                        let path = dir.join(format!("{method}.txt"));
                        if kind == "renamed-in" {
                            let from = source.join(format!("{method}.txt"));
                            std::fs::write(&from, OLD).expect("old");
                            std::fs::rename(&from, &path).expect("rename in");
                        } else {
                            std::fs::write(&path, OLD).expect("old");
                        }
                        if let Some(arguments) = file_acl {
                            icacls(&path, arguments);
                        }
                    }
                    let created: Vec<Vec<u8>> = methods.iter().map(|(method, _, _)| descriptor_at(&dir.join(format!("{method}.txt")))).collect();
                    if kind == "folder-ace-after" {
                        let mut descriptor = security(&folder(&changed), DACL_SECURITY_INFORMATION);
                        // SAFETY: the handle has `WRITE_DAC`, and `descriptor` is a live self-relative descriptor.
                        unsafe {
                            SetKernelObjectSecurity(
                                raw(&folder(&dir)),
                                DACL_SECURITY_INFORMATION,
                                PSECURITY_DESCRIPTOR(descriptor.as_mut_ptr().cast()),
                            )
                        }
                        .expect("set the folder DACL");
                    }
                    // Per method: `same` when the owner, group, and DACL descriptor bytes equal the old file.
                    let mut results = serde_json::Map::new();
                    for ((method, dacl, copy_first), created) in methods.into_iter().zip(&created) {
                        let name = format!("{method}.txt");
                        let path = dir.join(&name);
                        let before = descriptor_at(&path);
                        if &before != created {
                            results.insert(format!("{method}-old-changed"), json!(true));
                        }
                        let result = replace(&dir, &name, false, dacl, false, copy_first);
                        let after = descriptor_at(&path);
                        let value = if result["step"] != "renamed" {
                            result
                        } else {
                            json!(if before == after { "same" } else { "differs" })
                        };
                        results.insert(method.to_string(), value);
                    }
                    record(&format!("W2.{folder_kind}.{kind}"), Value::Object(results));
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
            for (sequence, basic, copy_first) in
                [("005", false, false), ("copy", true, false), ("copy-first", true, true)]
            {
                let name = format!("c-{sequence}.txt");
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
                let result = replace(&dir, &name, basic, Dacl::None, false, copy_first);
                let after = query::<FILE_BASIC_INFORMATION>(&hold(&parent, &name), FileBasicInformation, &RUN)
                    .expect("FileBasicInformation");
                let observed = json!({ "set": set, "result": result, "keepsOldCreation": after.CreationTime == OLD_CREATION });
                if basic {
                    observe(
                        &format!("W3.creation.{sequence}"),
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
            let result = replace(&dir, "ro.txt", false, Dacl::None, false, false);
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
            let result = replace(&dir, "target.txt", false, Dacl::None, true, false);
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
