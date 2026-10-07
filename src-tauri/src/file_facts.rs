// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

//! Contract §6 "File facts": the facts of files below the three Git-resolved roots.
//! The walk opens each component relative to its parent handle. It never follows a reparse point below a root.

use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Component, Path, Prefix};
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;

use windows::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows::Wdk::Storage::FileSystem::{
    FILE_BASIC_INFORMATION, FILE_INFORMATION_CLASS, FILE_OPEN_REPARSE_POINT,
    FILE_SYNCHRONOUS_IO_NONALERT, FileAttributeTagInformation, FileBasicInformation,
    FileStandardInformation, NtFsControlFile, NtOpenFile, NtQueryInformationFile, NtReadFile,
    SYMLINK_FLAG_RELATIVE,
};
use windows::Wdk::System::SystemServices::FILE_ATTRIBUTE_TAG_INFORMATION;
use windows::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_IO_DEVICE, ERROR_PATH_NOT_FOUND,
    ERROR_SHARING_VIOLATION, HANDLE, NTSTATUS, OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE,
    STATUS_ACCESS_DENIED, STATUS_CANCELLED, STATUS_END_OF_FILE, STATUS_IO_DEVICE_ERROR,
    STATUS_IO_REPARSE_TAG_NOT_HANDLED, STATUS_OBJECT_NAME_NOT_FOUND, STATUS_OBJECT_PATH_NOT_FOUND,
    STATUS_REPARSE_POINT_ENCOUNTERED, STATUS_SHARING_VIOLATION, STATUS_UNSUCCESSFUL,
    UNICODE_STRING, WIN32_ERROR,
};
use windows::Win32::Storage::FileSystem::{
    FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    MAXIMUM_REPARSE_DATA_BUFFER_SIZE, SYNCHRONIZE,
};
use windows::Win32::System::IO::IO_STATUS_BLOCK;
use windows::Win32::System::Ioctl::FSCTL_GET_REPARSE_POINT;
use windows::Win32::System::SystemServices::{IO_REPARSE_TAG_MOUNT_POINT, IO_REPARSE_TAG_SYMLINK};
use windows::core::PWSTR;

use crate::bootstrap::open as open_for_identity;
use crate::process_requests::Code;
use crate::schema::process_reply::{
    FileFactErrorCode, FileFactFileBound, FileFactLinkTag, FileFactLinkTarget,
    FileFactsReplyFactsItem as Fact,
};
use crate::schema::process_request::{
    FileFacts, FileFactsFilesItem, FileFactsFilesItemRoot, WslFilesDigestBound,
    WslFilesDigestFilesItemRoot, WslFilesGroup,
};
use crate::schema::reply::{digest as digest_text, error_fact, last_write, link_fact};
use crate::settings::{hex, sha256};
use crate::wsl::{FactEntry, FileBound, FilesRequest};

const INVALID: Code = Code::InvalidRequest;
/// Contract §5 "File facts".
const ENTRIES: usize = 64;
const COMPONENT_UNITS: usize = 255;
const FILE_BYTES: u64 = 1 << 20;
const TOTAL_BYTES: u64 = 8 << 20;
/// Microsoft Learn "Reparse Point Tags": bit 29 is the name surrogate bit (`IsReparseTagNameSurrogate`).
const NAME_SURROGATE: u32 = 0x2000_0000;

pub(crate) struct Request<'a> {
    pub(crate) operation_id: &'a str,
    pub(crate) digest: bool,
    /// The index of the `walk` root and the name components of each entry.
    pub(crate) files: Vec<(usize, Vec<String>)>,
    /// WSL only: `Some` with the shared index hash of `index` (contract §6 "Index digest in a read").
    pub(crate) index: Option<Option<&'a str>>,
}

/// The fields of a `fileFacts` frame. It reads no file.
pub(crate) fn parse(request: &FileFacts) -> Result<Request<'_>, Code> {
    // typify drops the `contextKind` const, the array bounds, and the `index` rule.
    if request.context_kind != "registeredOperation"
        || !(1..=ENTRIES).contains(&request.files.len())
        || (request.index.is_some() && request.digest)
    {
        return Err(INVALID);
    }
    Ok(Request {
        operation_id: &request.operation_id,
        digest: request.digest,
        files: request.files.iter().map(entry).collect::<Result<_, _>>()?,
        index: request
            .index
            .as_ref()
            .map(|index| index.shared_index.as_deref().map(String::as_str)),
    })
}

/// Contract §5 "Whole-file stage input": the largest `catFile` size.
const WHOLE_BYTES: i64 = 536_870_912;
/// Contract §6 "Channel frames" `indexFile`: the candidate name prefix.
const CANDIDATE_PREFIX: &str = "arbareto-candidate-";

/// The name components of one entry by the component rule.
fn names<T: std::ops::Deref<Target = String>>(path: &[T]) -> Result<Vec<String>, Code> {
    if path.is_empty() || !path.iter().all(|name| is_component(name)) {
        return Err(INVALID);
    }
    Ok(path.iter().map(|name| name.to_string()).collect())
}

/// One `worktreeRoot` entry of `hashObject` or `catFile`.
fn worktree_entry<T: std::ops::Deref<Target = String>>(
    root: &str,
    path: &[T],
) -> Result<FactEntry, Code> {
    if root != "worktreeRoot" {
        return Err(INVALID);
    }
    Ok(FactEntry {
        root: 0,
        path: names(path)?,
    })
}

/// A candidate name: one component with the candidate prefix, in the Git directory.
fn candidate(name: &str) -> Result<String, Code> {
    if !is_component(name) || !name.starts_with(CANDIDATE_PREFIX) {
        return Err(INVALID);
    }
    Ok(name.to_string())
}

/// The fields of a `wslFiles` frame: the operation, Git, and repository IDs, and the checked request. It reads no file.
/// `value` is the frame that `typed` read into `request`, so the ID fields hold valid text.
/// typify drops the `contextKind`, `bound`, and `root` constants, the array bounds, the 64-bit bound of the lock texts, and the candidate rule.
pub(crate) fn wsl_files_request<'a>(
    value: &'a Value,
    request: &WslFilesGroup,
) -> Result<([&'a str; 3], FilesRequest), Code> {
    use WslFilesGroup as G;
    let text = |key: &str| value.get(key).and_then(Value::as_str).ok_or(INVALID);
    if text("contextKind")? != "registeredOperation" {
        return Err(INVALID);
    }
    let ids = [
        text("operationId")?,
        text("gitInstallationId")?,
        text("repositoryId")?,
    ];
    let only =
        |bound: &str, wanted: FileBound| (bound == wanted.name()).then_some(wanted).ok_or(INVALID);
    let files = |mode, bound, entries, fields| FilesRequest {
        mode,
        bound,
        entries,
        fields,
        shared: false,
    };
    let request = match request {
        G::Digest {
            bound,
            files: entries,
            ..
        } => {
            let whole = matches!(bound, WslFilesDigestBound::WholeFileStageInputBytes);
            let most = if whole { 1 } else { ENTRIES };
            if !(1..=most).contains(&entries.len()) {
                return Err(INVALID);
            }
            let entries = entries
                .iter()
                .map(|entry| {
                    let root = match entry.root {
                        WslFilesDigestFilesItemRoot::WorktreeRoot => 0,
                        WslFilesDigestFilesItemRoot::GitDirectory => 1,
                        WslFilesDigestFilesItemRoot::CommonDirectory => 2,
                    };
                    Ok(FactEntry {
                        root,
                        path: names(&entry.path)?,
                    })
                })
                .collect::<Result<_, Code>>()?;
            let bound = if whole {
                FileBound::Whole
            } else {
                FileBound::Compared
            };
            files("digest", bound, entries, vec![])
        }
        G::IndexDigest {
            bound,
            shared_index,
            ..
        } => {
            let fields: Vec<String> = shared_index.iter().map(|hash| hash.to_string()).collect();
            let mut request = files(
                "indexDigest",
                only(bound, FileBound::Index)?,
                vec![],
                fields,
            );
            request.shared = shared_index.is_some();
            request
        }
        G::HashObject {
            bound,
            files: [entry],
            ..
        } => {
            let entry = worktree_entry(&entry.root, &entry.path)?;
            files(
                "hashObject",
                only(bound, FileBound::Whole)?,
                vec![entry],
                vec![],
            )
        }
        G::CatFile {
            bound,
            files: [entry],
            oid,
            size,
            ..
        } => {
            if !(0..=WHOLE_BYTES).contains(size) {
                return Err(INVALID);
            }
            let entry = worktree_entry(&entry.root, &entry.path)?;
            let fields = vec![oid.to_string(), size.to_string()];
            files(
                "catFile",
                only(bound, FileBound::Whole)?,
                vec![entry],
                fields,
            )
        }
        G::Lock { bound, token, .. } => files(
            "lock",
            only(bound, FileBound::Index)?,
            vec![],
            vec![token.to_string()],
        ),
        G::Candidate {
            bound,
            candidate: name,
            ..
        } => files(
            "candidate",
            only(bound, FileBound::Index)?,
            vec![],
            vec![candidate(name)?],
        ),
        G::Publish {
            bound,
            candidate: name,
            lock,
            token,
            expected,
            ..
        } => {
            // The pattern keeps the decimal form. The value must fit in 64 bits.
            if lock.device.parse::<u64>().is_err() || lock.inode.parse::<u64>().is_err() {
                return Err(INVALID);
            }
            let fields = vec![
                candidate(name)?,
                lock.device.to_string(),
                lock.inode.to_string(),
                token.to_string(),
                expected.to_string(),
            ];
            files("publish", only(bound, FileBound::Index)?, vec![], fields)
        }
    };
    Ok((ids, request))
}

/// The index of the `walk` root and the name components of one entry.
fn entry(entry: &FileFactsFilesItem) -> Result<(usize, Vec<String>), Code> {
    let root = match entry.root {
        FileFactsFilesItemRoot::WorktreeRoot => 0,
        FileFactsFilesItemRoot::GitDirectory => 1,
        FileFactsFilesItemRoot::CommonDirectory => 2,
    };
    if entry.path.is_empty() || !entry.path.iter().all(|name| is_component(name)) {
        return Err(INVALID);
    }
    Ok((
        root,
        entry.path.iter().map(|name| name.to_string()).collect(),
    ))
}

/// The Windows rule of `isComponent` in `src/contracts/native-path.ts`, within 1 to 255 UTF-16 units.
pub(crate) fn is_component(name: &str) -> bool {
    // A reserved device name decides by the part before the first period, with ASCII letters folded.
    let stem = name.split('.').next().unwrap_or(name).to_ascii_lowercase();
    let numbered = |rest: &str| {
        let mut chars = rest.chars();
        matches!(
            (chars.next(), chars.next()),
            (Some('1'..='9' | '¹' | '²' | '³'), None)
        )
    };
    let reserved = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || stem
            .strip_prefix("com")
            .or_else(|| stem.strip_prefix("lpt"))
            .is_some_and(numbered);
    (1..=COMPONENT_UNITS).contains(&name.encode_utf16().count())
        && !name.chars().any(|c| c < ' ' || r#"<>:"/\|?*"#.contains(c))
        && !name.ends_with(['.', ' '])
        && !reserved
}

/// Contract §11 "Route": a WSL path is a UNC path on the server `wsl$` or `wsl.localhost` in any letter case.
/// The prefix parser takes `\` and `/` as separators.
pub(crate) fn is_wsl_path(path: &Path) -> bool {
    match path.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::UNC(server, _) => {
                server.eq_ignore_ascii_case("wsl$") || server.eq_ignore_ascii_case("wsl.localhost")
            }
            _ => false,
        },
        _ => false,
    }
}

/// One fact per entry, in request order.
/// After `stop` is set, each open, query, and read fails with `STATUS_CANCELLED`, and the shell sends no fact (contract §6 "Walks").
pub(crate) fn walk(
    roots: [&Path; 3],
    digest: bool,
    files: &[(usize, Vec<String>)],
    stop: &AtomicBool,
) -> Vec<Fact> {
    // The digested bytes that the request can still take. `None` after the first file that passed the total.
    let mut budget = Some(TOTAL_BYTES);
    files
        .iter()
        .map(|(root, path)| fact(roots[*root], path, digest, &mut budget, stop))
        .collect()
}

/// `component` counts the components of `path` from 1. Component 0 is the root.
fn fact(
    root: &Path,
    path: &[String],
    digest: bool,
    budget: &mut Option<u64>,
    stop: &AtomicBool,
) -> Fact {
    let (last, middle) = path.split_last().expect("parse gives 1 or more components");
    let mut parent = match open_root(root, stop) {
        Ok(handle) => handle,
        Err(status) => return not_opened(status, 0),
    };
    for (component, name) in (1..).zip(middle) {
        parent = match open(&parent, name, false, false, stop) {
            Ok(handle) => handle,
            Err(status) if is_reparse_point(status) => {
                return reparse_point(&parent, name, component, None, stop);
            }
            Err(status) => return not_opened(status, component),
        };
    }
    let component = path.len();
    match open(&parent, last, false, false, stop) {
        Ok(handle) => file_fact(&handle, component, digest, budget, stop),
        Err(status) if is_reparse_point(status) => {
            reparse_point(&parent, last, component, Some(digest), stop)
        }
        Err(status) => not_opened(status, component),
    }
}

/// Contract §6 "Walks": a stopped walk opens, queries, and reads nothing more.
fn check(stop: &AtomicBool) -> Result<(), NTSTATUS> {
    if stop.load(Ordering::SeqCst) {
        return Err(STATUS_CANCELLED);
    }
    Ok(())
}

/// `OBJ_DONT_REPARSE` stops the open at a reparse point that the I/O manager would follow.
/// A tag that no file system filter handles fails the open with `STATUS_IO_REPARSE_TAG_NOT_HANDLED` (T302).
fn is_reparse_point(status: NTSTATUS) -> bool {
    status == STATUS_REPARSE_POINT_ENCOUNTERED || status == STATUS_IO_REPARSE_TAG_NOT_HANDLED
}

/// Opens a root as the identity request opens a path.
fn open_root(root: &Path, stop: &AtomicBool) -> Result<OwnedHandle, NTSTATUS> {
    check(stop)?;
    open_for_identity(root)
        .map(OwnedHandle::from)
        // Contract §6 "File facts" pairs each of these Win32 errors with its status.
        .map_err(
            |error| match error.raw_os_error().map(|code| WIN32_ERROR(code as u32)) {
                Some(ERROR_FILE_NOT_FOUND) => STATUS_OBJECT_NAME_NOT_FOUND,
                Some(ERROR_PATH_NOT_FOUND) => STATUS_OBJECT_PATH_NOT_FOUND,
                Some(ERROR_ACCESS_DENIED) => STATUS_ACCESS_DENIED,
                Some(ERROR_SHARING_VIOLATION) => STATUS_SHARING_VIOLATION,
                Some(ERROR_IO_DEVICE) => STATUS_IO_DEVICE_ERROR,
                _ => STATUS_UNSUCCESSFUL,
            },
        )
}

fn raw(handle: &OwnedHandle) -> HANDLE {
    HANDLE(handle.as_raw_handle())
}

/// Opens `name` relative to `parent`. `OBJ_DONT_REPARSE` fails the open at each reparse point that the I/O manager would follow.
fn open(
    parent: &OwnedHandle,
    name: &str,
    read: bool,
    reparse_point: bool,
    stop: &AtomicBool,
) -> Result<OwnedHandle, NTSTATUS> {
    check(stop)?;
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
        // Win32 file names ignore letter case, and Git opens hooks through Win32.
        Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        ..Default::default()
    };
    let mut access = FILE_READ_ATTRIBUTES | SYNCHRONIZE;
    if read {
        access |= FILE_READ_DATA;
    }
    let mut options = FILE_SYNCHRONOUS_IO_NONALERT;
    if reparse_point {
        options |= FILE_OPEN_REPARSE_POINT;
    }
    let mut handle = HANDLE::default();
    let mut io = IO_STATUS_BLOCK::default();
    // SAFETY: each pointer refers to a live local, and `parent` keeps its handle open.
    let status = unsafe {
        NtOpenFile(
            &raw mut handle,
            access.0,
            &raw const attributes,
            &raw mut io,
            (FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).0,
            options.0,
        )
    };
    if status.is_err() {
        return Err(status);
    }
    // SAFETY: a successful open returns a new handle that nothing else owns.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle.0) })
}

/// `FILE_STANDARD_INFORMATION` with its `BOOLEAN` fields as bytes. A Rust `bool` must hold 0 or 1.
#[repr(C)]
#[derive(Default)]
struct StandardInformation {
    allocation_size: i64,
    end_of_file: i64,
    number_of_links: u32,
    delete_pending: u8,
    directory: u8,
}

/// Reads one information class. `T` must be the structure of `class`.
fn query<T: Default>(
    handle: &OwnedHandle,
    class: FILE_INFORMATION_CLASS,
    stop: &AtomicBool,
) -> Result<T, NTSTATUS> {
    check(stop)?;
    let mut info = T::default();
    let mut io = IO_STATUS_BLOCK::default();
    // SAFETY: `handle` is open, and `info` is a live local of the passed size.
    let status = unsafe {
        NtQueryInformationFile(
            raw(handle),
            &raw mut io,
            (&raw mut info).cast(),
            size_of::<T>() as u32,
            class,
        )
    };
    if status.is_err() {
        return Err(status);
    }
    Ok(info)
}

/// Only `STATUS_OBJECT_NAME_NOT_FOUND` and `STATUS_OBJECT_PATH_NOT_FOUND` mean absent.
fn not_opened(status: NTSTATUS, component: usize) -> Fact {
    match status {
        STATUS_OBJECT_NAME_NOT_FOUND | STATUS_OBJECT_PATH_NOT_FOUND => Fact::Absent,
        _ => error(component, status),
    }
}

/// Contract §6 "File facts": the `error` code of each status.
fn error(component: usize, status: NTSTATUS) -> Fact {
    let code = match status {
        STATUS_ACCESS_DENIED => FileFactErrorCode::AccessDenied,
        STATUS_SHARING_VIOLATION => FileFactErrorCode::SharingViolation,
        STATUS_IO_DEVICE_ERROR => FileFactErrorCode::IoError,
        _ => FileFactErrorCode::OtherError,
    };
    error_fact(component, code)
}

/// The fact of a final component that the walk opened with attribute access only.
/// With `digest`, a file within the per-file bound is opened again for its data, and the read takes at most the bound plus one byte.
fn file_fact(
    handle: &OwnedHandle,
    component: usize,
    digest: bool,
    budget: &mut Option<u64>,
    stop: &AtomicBool,
) -> Fact {
    let standard = match query::<StandardInformation>(handle, FileStandardInformation, stop) {
        Ok(standard) => standard,
        Err(status) => return error(component, status),
    };
    if standard.directory != 0 {
        return Fact::Directory { executable: None };
    }
    let basic = match query::<FILE_BASIC_INFORMATION>(handle, FileBasicInformation, stop) {
        Ok(basic) => basic,
        Err(status) => return error(component, status),
    };
    let file = |digest, bound| Fact::File {
        bound,
        digest,
        executable: None,
        last_write: last_write(basic.LastWriteTime),
        owner_execute: None,
        size: standard.end_of_file,
    };
    if !digest {
        return file(None, None);
    }
    // An empty name relative to the handle opens the same file again, as `ReOpenFile` does.
    let data = || {
        open(handle, "", true, false, stop)
            .and_then(|data| read(raw(&data), FILE_BYTES as usize + 1, stop))
    };
    let bound = match *budget {
        _ if standard.end_of_file as u64 > FILE_BYTES => FileFactFileBound::FileBytes,
        None => FileFactFileBound::TotalBytes,
        Some(left) => match data() {
            Err(status) => return error(component, status),
            Ok(bytes) if bytes.len() as u64 > FILE_BYTES => FileFactFileBound::FileBytes,
            Ok(bytes) if bytes.len() as u64 > left => {
                *budget = None;
                FileFactFileBound::TotalBytes
            }
            Ok(bytes) => {
                *budget = Some(left - bytes.len() as u64);
                return file(Some(digest_text(&hex(&sha256(&bytes)))), None);
            }
        },
    };
    file(None, Some(bound))
}

/// Reads at most `limit` bytes from the current position of a synchronous handle.
fn read(handle: HANDLE, limit: usize, stop: &AtomicBool) -> Result<Vec<u8>, NTSTATUS> {
    let mut bytes = vec![0u8; limit];
    let mut filled = 0;
    while filled < limit {
        check(stop)?;
        let rest = &mut bytes[filled..];
        let mut io = IO_STATUS_BLOCK::default();
        // SAFETY: the caller keeps the synchronous handle open, and `rest` has the passed length.
        let status = unsafe {
            NtReadFile(
                handle,
                None,
                None,
                None,
                &raw mut io,
                rest.as_mut_ptr().cast(),
                rest.len() as u32,
                None,
                None,
            )
        };
        if status == STATUS_END_OF_FILE || (status.is_ok() && io.Information == 0) {
            break;
        }
        if status.is_err() {
            return Err(status);
        }
        filled += io.Information;
    }
    bytes.truncate(filled);
    Ok(bytes)
}

/// A component whose open stopped at a reparse point. `last` holds `digest` for the final component.
fn reparse_point(
    parent: &OwnedHandle,
    name: &str,
    component: usize,
    last: Option<bool>,
    stop: &AtomicBool,
) -> Fact {
    let handle = match open(parent, name, false, true, stop) {
        Ok(handle) => handle,
        Err(status) => return not_opened(status, component),
    };
    let tag =
        match query::<FILE_ATTRIBUTE_TAG_INFORMATION>(&handle, FileAttributeTagInformation, stop) {
            Ok(info) => info.ReparseTag,
            Err(status) => return error(component, status),
        };
    if tag & NAME_SURROGATE != 0 {
        return link(&handle, tag, component, stop);
    }
    match last {
        None => Fact::Other,
        Some(digest) => {
            let fact = file_fact(&handle, component, false, &mut None, stop);
            // Logical bytes need an open that follows the reparse point, so a digest is not possible.
            if digest && matches!(fact, Fact::File { .. }) {
                error(component, STATUS_REPARSE_POINT_ENCOUNTERED)
            } else {
                fact
            }
        }
    }
}

/// A name-surrogate reparse point. Only a symlink or a junction with well-formed text carries `target` and `relative`.
fn link(handle: &OwnedHandle, tag: u32, component: usize, stop: &AtomicBool) -> Fact {
    let name = match tag {
        IO_REPARSE_TAG_SYMLINK => FileFactLinkTag::Symlink,
        IO_REPARSE_TAG_MOUNT_POINT => FileFactLinkTag::Junction,
        _ => return link_fact(component, None),
    };
    if let Err(status) = check(stop) {
        return error(component, status);
    }
    let mut data = vec![0u8; MAXIMUM_REPARSE_DATA_BUFFER_SIZE as usize];
    let mut io = IO_STATUS_BLOCK::default();
    // SAFETY: `handle` is open and synchronous, and `data` has the passed length.
    let status = unsafe {
        NtFsControlFile(
            raw(handle),
            None,
            None,
            None,
            &raw mut io,
            FSCTL_GET_REPARSE_POINT,
            None,
            0,
            Some(data.as_mut_ptr().cast()),
            data.len() as u32,
        )
    };
    if status.is_err() {
        return error(component, status);
    }
    data.truncate(io.Information);
    let target = target(&data, tag).and_then(|(target, relative)| {
        FileFactLinkTarget::try_from(target)
            .ok()
            .map(|target| (name, target, relative))
    });
    link_fact(component, target)
}

/// `SubstituteName` and the relative flag from `REPARSE_DATA_BUFFER` (Microsoft Learn, MS-FSCC 2.1.2.4 and 2.1.2.5).
/// `None` for another tag, data out of bounds, text that is no well-formed UTF-16, or a NUL.
fn target(data: &[u8], tag: u32) -> Option<(String, bool)> {
    // The 8-byte header holds `ReparseTag` and `ReparseDataLength`.
    let length = data.get(4..6).map(|b| u16::from_le_bytes([b[0], b[1]]))?;
    let data = data.get(..8 + usize::from(length))?;
    let u16_at = |at: usize| {
        data.get(at..at + 2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
    };
    let u32_at = |at: usize| {
        data.get(at..at + 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    };
    if u32_at(0)? != tag {
        return None;
    }
    let (path_buffer, relative) = if tag == IO_REPARSE_TAG_SYMLINK {
        (20, u32_at(16)? & SYMLINK_FLAG_RELATIVE != 0)
    } else {
        (16, false)
    };
    let start = path_buffer + usize::from(u16_at(8)?);
    let (pairs, odd) = data
        .get(start..start + usize::from(u16_at(10)?))?
        .as_chunks::<2>();
    if !odd.is_empty() {
        return None;
    }
    let units: Vec<u16> = pairs.iter().map(|&pair| u16::from_le_bytes(pair)).collect();
    let text = String::from_utf16(&units)
        .ok()
        .filter(|text| !text.contains('\0'))?;
    Some((text, relative))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    use std::io::Seek;
    use std::os::windows::fs::MetadataExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    use serde_json::{Value, json};
    use windows::Win32::Storage::FileSystem::{WOF_PROVIDER_FILE, WofIsExternalFile};
    use windows::core::{BOOL, HSTRING};

    use crate::jobs::tests::Fixture;
    use crate::process_requests::tests::junction;
    use crate::settings::{hex, sha256};

    /// The facts of `super::walk` in their wire form.
    fn walk(
        roots: [&Path; 3],
        digest: bool,
        files: &[(usize, Vec<String>)],
        stop: &AtomicBool,
    ) -> Vec<Value> {
        let facts = super::walk(roots, digest, files, stop);
        facts.iter().map(|fact| json!(fact)).collect()
    }

    /// FIPS 180-2 Appendix B.1: the SHA-256 of "abc".
    pub(crate) const ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const MIB: usize = 1 << 20;
    const WORKTREE: usize = 0;
    const GIT: usize = 1;
    /// A stop flag that no test sets.
    static RUN: AtomicBool = AtomicBool::new(false);

    /// A worktree with `.git/hooks/pre-commit` ("abc"), and a folder outside the roots with its own `pre-commit`.
    struct Repo {
        worktree: PathBuf,
        git: PathBuf,
        outside: PathBuf,
        _fixture: Fixture,
    }

    impl Repo {
        fn new() -> Repo {
            let fixture = Fixture::new();
            let worktree = fixture.path("repo");
            let git = worktree.join(".git");
            std::fs::create_dir_all(git.join("hooks")).expect("hooks");
            std::fs::write(git.join("hooks").join("pre-commit"), "abc").expect("hook");
            let outside = fixture.path("outside");
            std::fs::create_dir(&outside).expect("outside");
            std::fs::write(outside.join("pre-commit"), "outside").expect("outside hook");
            Repo {
                worktree,
                git,
                outside,
                _fixture: fixture,
            }
        }

        fn hook(&self, name: &str) -> PathBuf {
            self.git.join("hooks").join(name)
        }

        fn facts(&self, digest: bool, files: &[(usize, &[&str])]) -> Vec<Value> {
            let files: Vec<(usize, Vec<String>)> = files
                .iter()
                .map(|(root, path)| (*root, path.iter().map(|name| name.to_string()).collect()))
                .collect();
            walk([&self.worktree, &self.git, &self.git], digest, &files, &RUN)
        }
    }

    /// The `file` fact of `path` without `digest` and `bound`, from the Win32 file metadata.
    fn file(path: &Path) -> Value {
        let metadata = std::fs::metadata(path).expect("metadata");
        json!({ "kind": "file", "size": metadata.len(), "lastWrite": metadata.last_write_time().to_string() })
    }

    fn with(mut fact: Value, key: &str, value: Value) -> Value {
        fact[key] = value;
        fact
    }

    #[test]
    fn a_file_gives_its_size_last_write_and_sha256_and_each_other_kind_follows_the_open_result() {
        let repo = Repo::new();
        let hook = repo.hook("pre-commit");
        let digested = with(file(&hook), "digest", json!(ABC));
        assert_eq!(
            repo.facts(
                true,
                &[
                    (GIT, &["hooks", "pre-commit"]),
                    (GIT, &["hooks", "PRE-COMMIT"]),
                    (GIT, &["hooks"]),
                    (GIT, &["hooks", "missing"]),
                    (GIT, &["missing", "pre-commit"]),
                    (GIT, &["hooks", "pre-commit", "x"]),
                ]
            ),
            vec![
                digested.clone(),
                digested,
                json!({ "kind": "directory" }),
                json!({ "kind": "absent" }),
                json!({ "kind": "absent" }),
                json!({ "kind": "absent" }),
            ],
            "Win32 names ignore letter case, and a file as a parent gives STATUS_OBJECT_PATH_NOT_FOUND"
        );
        assert_eq!(
            repo.facts(false, &[(GIT, &["hooks", "pre-commit"])]),
            vec![file(&hook)],
            "digest false reads no file data"
        );
        let gone = repo.worktree.join("gone");
        assert_eq!(
            walk(
                [&gone, &gone, &gone],
                true,
                &[(GIT, vec!["hooks".to_string()])],
                &RUN
            ),
            vec![json!({ "kind": "absent" })],
            "a missing root"
        );
        // CreateFileW refuses `<` with ERROR_INVALID_NAME.
        let invalid = repo.worktree.join("a<b");
        assert_eq!(
            walk(
                [&invalid, &invalid, &invalid],
                true,
                &[(GIT, vec!["hooks".to_string()])],
                &RUN
            ),
            vec![json!({ "kind": "error", "component": 0, "code": "other-error" })],
            "component 0 is the root"
        );
    }

    #[test]
    fn the_per_file_bound_comes_first_and_only_files_within_it_count_toward_the_total() {
        let repo = Repo::new();
        let one_mib = vec![b'a'; MIB];
        let mut names = Vec::new();
        let mut write = |name: &str, bytes: &[u8]| {
            std::fs::write(repo.hook(name), bytes).expect("fixture file");
            names.push(name.to_string());
        };
        write("big", &[one_mib.as_slice(), b"a"].concat());
        for n in 0..8 {
            write(&format!("m{n}"), &one_mib);
        }
        write("two-before", &vec![b'a'; 2 * MIB]);
        write("m8", &one_mib);
        write("two-after", &vec![b'a'; 2 * MIB]);
        write("tiny", b"abc");
        let paths: Vec<[&str; 2]> = names.iter().map(|name| ["hooks", name]).collect();
        let files: Vec<(usize, &[&str])> = paths.iter().map(|path| (GIT, &path[..])).collect();

        let bound = |name: &str, bound: &str| with(file(&repo.hook(name)), "bound", json!(bound));
        let mut expected = vec![bound("big", "file-bytes")];
        for n in 0..8 {
            expected.push(with(
                file(&repo.hook(&format!("m{n}"))),
                "digest",
                json!(hex(&sha256(&one_mib))),
            ));
        }
        expected.extend([
            bound("two-before", "file-bytes"),
            bound("m8", "total-bytes"),
            bound("two-after", "file-bytes"),
            bound("tiny", "total-bytes"),
        ]);
        assert_eq!(repo.facts(true, &files), expected);
    }

    /// Adds a deny ACE for Everyone with `rights` (an `icacls` rights list), and removes it on drop.
    struct Denied(PathBuf);

    fn icacls(path: &Path, change: &[&str]) {
        let status = Command::new("icacls")
            .arg(path)
            .args(change)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("start icacls");
        assert!(status.success(), "icacls {change:?}: {status}");
    }

    impl Denied {
        fn new(path: PathBuf, rights: &str) -> Denied {
            icacls(&path, &["/deny", &format!("*S-1-1-0:({rights})")]);
            Denied(path)
        }
    }

    impl Drop for Denied {
        fn drop(&mut self) {
            icacls(&self.0, &["/remove:d", "*S-1-1-0"]);
        }
    }

    #[test]
    fn the_type_comes_from_attribute_access_and_only_a_file_is_opened_for_its_data() {
        let repo = Repo::new();
        std::fs::create_dir(repo.hook("unlisted")).expect("folder");
        std::fs::write(repo.hook("unreadable"), "abc").expect("file");
        let _folder = Denied::new(repo.hook("unlisted"), "RD");
        let _file = Denied::new(repo.hook("unreadable"), "RD");
        assert_eq!(
            repo.facts(
                true,
                &[
                    (GIT, &["hooks", "unlisted"]),
                    (GIT, &["hooks", "unreadable"]),
                ]
            ),
            vec![
                json!({ "kind": "directory" }),
                json!({ "kind": "error", "component": 2, "code": "access-denied" }),
            ],
            "Everyone may not list the folder or read the file"
        );
        assert_eq!(
            repo.facts(false, &[(GIT, &["hooks", "unreadable"])]),
            vec![file(&repo.hook("unreadable"))],
            "digest false needs only attribute access"
        );
    }

    #[test]
    fn the_reader_stops_after_the_bound_plus_one_byte() {
        let fixture = Fixture::new();
        let path = fixture.path("large");
        std::fs::write(&path, vec![b'a'; 2 * MIB]).expect("large file");
        let mut file = std::fs::File::open(&path).expect("open");
        let bytes =
            read(HANDLE(file.as_raw_handle()), FILE_BYTES as usize + 1, &RUN).expect("read");
        assert_eq!(bytes.len(), MIB + 1);
        assert_eq!(
            file.stream_position().expect("position"),
            MIB as u64 + 1,
            "no read past the bound"
        );
    }

    #[test]
    fn a_junction_gives_link_with_its_index_and_target_and_the_walk_stops_there() {
        let repo = Repo::new();
        let scripts = repo.worktree.join("scripts");
        if !junction(&repo.hook("linked"), &repo.outside) || !junction(&scripts, &repo.outside) {
            println!("SKIP junction: missing capability ntfs-junction (unverified)");
            return;
        }
        let link = |component: usize| json!({ "kind": "link", "component": component, "tag": "junction", "target": format!(r"\??\{}", repo.outside.display()), "relative": false });
        assert_eq!(
            repo.facts(
                true,
                &[
                    (GIT, &["hooks", "linked"]),
                    (GIT, &["hooks", "linked", "pre-commit"]),
                    (WORKTREE, &["scripts", "pre-commit"]),
                ]
            ),
            vec![link(2), link(2), link(1)],
            "no target digest"
        );
    }

    #[test]
    fn a_symlink_gives_link_with_its_stored_text_and_a_unc_target_is_never_opened() {
        let repo = Repo::new();
        let share = repo.worktree.join("share");
        if std::os::windows::fs::symlink_dir(r"\\nonexistent.invalid\share", &share).is_err()
            || std::os::windows::fs::symlink_file("pre-commit", repo.hook("relative")).is_err()
        {
            println!("SKIP symlink: missing capability symlink (unverified)");
            return;
        }
        let unc = json!({ "kind": "link", "component": 1, "tag": "symlink", "target": r"\??\UNC\nonexistent.invalid\share", "relative": false });
        assert_eq!(
            repo.facts(
                true,
                &[
                    (WORKTREE, &["share"]),
                    (WORKTREE, &["share", "hooks"]),
                    (GIT, &["hooks", "relative"]),
                ]
            ),
            vec![
                unc.clone(),
                unc,
                json!({ "kind": "link", "component": 2, "tag": "symlink", "target": "pre-commit", "relative": true }),
            ],
            "each fact comes from the link object. An open of the UNC target gives a network status instead."
        );
    }

    /// `WofIsExternalFile` reports the WOF file provider.
    fn is_wof(path: &Path) -> bool {
        let mut external = BOOL(0);
        let mut provider = 0u32;
        // SAFETY: the out pointers are live locals, and no other buffer is passed.
        let read = unsafe {
            WofIsExternalFile(
                &HSTRING::from(path),
                Some(&raw mut external),
                Some(&raw mut provider),
                None,
                None,
            )
        };
        read.is_ok() && external.as_bool() && provider == WOF_PROVIDER_FILE
    }

    #[test]
    fn a_wof_compressed_hook_gives_the_sha256_of_its_logical_bytes() {
        let repo = Repo::new();
        let hook = repo.hook("compressed");
        let bytes = b"#!/bin/sh\nexit 0\n".repeat(4096);
        std::fs::write(&hook, &bytes).expect("hook");
        let compacted = Command::new("compact")
            .args(["/c", "/exe:xpress4k"])
            .arg(&hook)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        if !compacted || !is_wof(&hook) {
            println!("SKIP wof: missing capability wof (unverified)");
            return;
        }
        println!(
            "OBSERVATION T302: WofIsExternalFile reports WOF_PROVIDER_FILE for the compact /exe:xpress4k hook"
        );
        assert_eq!(
            repo.facts(true, &[(GIT, &["hooks", "compressed"])]),
            vec![with(file(&hook), "digest", json!(hex(&sha256(&bytes))))]
        );
    }

    #[test]
    fn the_component_rule_is_the_windows_rule_of_native_path() {
        for name in [
            "pre-commit",
            "a.b",
            "é",
            "conx",
            "com0",
            "nul-x",
            ".x",
            "x y",
        ] {
            assert!(is_component(name), "{name}");
        }
        for name in [
            "",
            ".",
            "..",
            r"a\b",
            "a/b",
            "x:y",
            "a<b",
            "a>b",
            "a\"b",
            "a|b",
            "a?b",
            "a*b",
            "nul",
            "NUL",
            "COM1.txt",
            "com¹",
            "LPT9",
            "aux.tar.gz",
            "x.",
            "x ",
            "\u{1}",
            "x\u{1f}",
        ] {
            assert!(!is_component(name), "{name:?}");
        }
    }

    #[test]
    fn a_wsl_path_starts_with_either_wsl_prefix_in_any_letter_case() {
        for path in [
            r"\\wsl$\Ubuntu\repo",
            r"\\WSL.LOCALHOST\Ubuntu\repo",
            "//wsl$/x",
            r"\\wsl.localhost/x",
            r"\\wsl$/Ubuntu/repo",
            r"/\Wsl$\Ubuntu/repo",
            r"//WSL.localhost\Ubuntu\repo",
        ] {
            assert!(is_wsl_path(Path::new(path)), "{path}");
        }
        for path in [
            r"\\server\share\repo",
            "//server/share/repo",
            r"C:\wsl.localhost\repo",
            r"\\wsl.localhost2\x",
            "//wsl$x/Ubuntu",
        ] {
            assert!(!is_wsl_path(Path::new(path)), "{path}");
        }
    }

    /// A symbolic link `REPARSE_DATA_BUFFER` (MS-FSCC 2.1.2.4) with `SubstituteName` at `offset`.
    fn symlink_buffer(tag: u32, offset: u16, name: &[u16], data_length: Option<u16>) -> Vec<u8> {
        let path: Vec<u8> = name.iter().flat_map(|unit| unit.to_le_bytes()).collect();
        let length = (name.len() * 2) as u16;
        let data_length = data_length.unwrap_or(12 + offset + length);
        let mut data = Vec::new();
        data.extend(tag.to_le_bytes());
        data.extend(data_length.to_le_bytes());
        data.extend(0u16.to_le_bytes());
        for field in [offset, length, 0, 0] {
            data.extend(field.to_le_bytes());
        }
        data.extend(SYMLINK_FLAG_RELATIVE.to_le_bytes());
        data.extend(vec![0u8; usize::from(offset)]);
        data.extend(path);
        data
    }

    #[test]
    fn crafted_reparse_data_gives_no_target() {
        let name: Vec<u16> = "h.sh".encode_utf16().collect();
        assert_eq!(
            target(
                &symlink_buffer(IO_REPARSE_TAG_SYMLINK, 0, &name, None),
                IO_REPARSE_TAG_SYMLINK
            ),
            Some(("h.sh".to_string(), true)),
            "the well-formed buffer"
        );
        let mut odd = symlink_buffer(IO_REPARSE_TAG_SYMLINK, 0, &name, None);
        odd[10] = 7;
        for (case, data, tag) in [
            (
                "SubstituteNameOffset past ReparseDataLength",
                symlink_buffer(IO_REPARSE_TAG_SYMLINK, 8, &name, Some(12)),
                IO_REPARSE_TAG_SYMLINK,
            ),
            ("an odd SubstituteNameLength", odd, IO_REPARSE_TAG_SYMLINK),
            (
                "a lone surrogate",
                symlink_buffer(IO_REPARSE_TAG_SYMLINK, 0, &[0x68, 0xD800], None),
                IO_REPARSE_TAG_SYMLINK,
            ),
            (
                "an embedded NUL",
                symlink_buffer(IO_REPARSE_TAG_SYMLINK, 0, &[0x68, 0, 0x68], None),
                IO_REPARSE_TAG_SYMLINK,
            ),
            (
                "another tag in the buffer",
                symlink_buffer(IO_REPARSE_TAG_MOUNT_POINT, 0, &name, None),
                IO_REPARSE_TAG_SYMLINK,
            ),
            (
                "a short header",
                vec![0x0c, 0, 0, 0xa0, 4],
                IO_REPARSE_TAG_SYMLINK,
            ),
        ] {
            assert_eq!(target(&data, tag), None, "{case}");
        }
    }

    /// A third-party tag without the name-surrogate bit (Microsoft Learn "Reparse Point Tags").
    const PRIVATE_TAG: u32 = 0x0000_7A5E;

    /// Sets `PRIVATE_TAG` with `FSCTL_SET_REPARSE_POINT` and a `REPARSE_GUID_DATA_BUFFER`. A folder must be empty.
    fn set_private_tag(path: &Path) -> bool {
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        };
        use windows::Win32::System::IO::DeviceIoControl;
        use windows::Win32::System::Ioctl::FSCTL_SET_REPARSE_POINT;

        let Ok(file) = std::fs::OpenOptions::new()
            .write(true)
            .custom_flags((FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS).0)
            .open(path)
        else {
            return false;
        };
        let payload = [1u8, 2, 3, 4];
        let mut data = Vec::new();
        data.extend(PRIVATE_TAG.to_le_bytes());
        data.extend((payload.len() as u16).to_le_bytes());
        data.extend(0u16.to_le_bytes());
        data.extend(*b"arbareto-fixture");
        data.extend(payload);
        // SAFETY: `file` keeps the handle open, and `data` is a live local of the passed length.
        unsafe {
            DeviceIoControl(
                HANDLE(file.as_raw_handle()),
                FSCTL_SET_REPARSE_POINT,
                Some(data.as_ptr().cast()),
                data.len() as u32,
                None,
                0,
                None,
                None,
            )
        }
        .is_ok()
    }

    #[test]
    fn a_reparse_point_without_the_name_surrogate_bit_gives_other_or_the_fact_of_its_type() {
        let repo = Repo::new();
        let folder = repo.hook("tagged-folder");
        let file_path = repo.hook("tagged-file");
        std::fs::create_dir(&folder).expect("folder");
        std::fs::write(&file_path, "abc").expect("file");
        if !set_private_tag(&folder) || !set_private_tag(&file_path) {
            println!("SKIP private reparse tag: missing capability reparse-tag (unverified)");
            return;
        }
        let metadata = std::fs::symlink_metadata(&file_path).expect("metadata");
        let file_fact = json!({ "kind": "file", "size": 3, "lastWrite": metadata.last_write_time().to_string() });
        let files: &[(usize, &[&str])] = &[
            (GIT, &["hooks", "tagged-folder", "x"]),
            (GIT, &["hooks", "tagged-file", "x"]),
            (GIT, &["hooks", "tagged-folder"]),
            (GIT, &["hooks", "tagged-file"]),
        ];
        assert_eq!(
            repo.facts(true, files),
            vec![
                json!({ "kind": "other" }),
                json!({ "kind": "other" }),
                json!({ "kind": "directory" }),
                json!({ "kind": "error", "component": 2, "code": "other-error" }),
            ],
            "digest true"
        );
        assert_eq!(
            repo.facts(false, &files[2..]),
            vec![json!({ "kind": "directory" }), file_fact],
            "digest false"
        );
    }
}
