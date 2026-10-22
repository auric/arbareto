// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

//! Feature 005 contract Δ6 `fileDelete`: Recycle Bin and permanent delete of reviewed working files (plan.md D7).
//! The walk holds each folder on the way open without `FILE_SHARE_DELETE`, so no other process renames it.
//! A permanent delete sets `FileDispositionInfoEx` with POSIX semantics on the checked handle. The Recycle Bin uses
//! `IFileOperation` on a COM apartment thread, with a progress sink that checks each item's file ID before the Shell deletes it.

use std::collections::HashMap;
use std::ffi::c_void;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use windows::Wdk::Storage::FileSystem::{
    FILE_BASIC_INFORMATION, FILE_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT,
    FILE_SYNCHRONOUS_IO_NONALERT, FileAttributeTagInformation, FileBasicInformation,
    FileStandardInformation,
};
use windows::Wdk::System::SystemServices::FILE_ATTRIBUTE_TAG_INFORMATION;
use windows::Win32::Foundation::{
    ERROR_CANCELLED, ERROR_DIR_NOT_EMPTY, HANDLE, HWND, NTSTATUS, STATUS_CANCELLED,
    STATUS_FILE_IS_A_DIRECTORY, STATUS_NOT_A_DIRECTORY, STATUS_OBJECT_NAME_NOT_FOUND,
    STATUS_OBJECT_PATH_NOT_FOUND,
};
use windows::Win32::Storage::FileSystem::{
    DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_ID_INFO, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FileIdInfo, GetFileInformationByHandleEx, SYNCHRONIZE,
};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance,
    CoInitializeEx, CoTaskMemFree, CoUninitialize,
};
use windows::Win32::System::SystemServices::{IO_REPARSE_TAG_MOUNT_POINT, IO_REPARSE_TAG_SYMLINK};
use windows::Win32::UI::Shell::{
    FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FOF_WANTNUKEWARNING,
    FOFX_RECYCLEONDELETE, FileOperation, IFileOperation, IFileOperationProgressSink,
    IFileOperationProgressSink_Impl, IShellItem, SHCreateItemFromParsingName, SIGDN,
    SIGDN_DESKTOPABSOLUTEPARSING, SIGDN_FILESYSPATH,
};
use windows::core::{PCWSTR, Ref, implement};

use crate::file_facts::{
    FILE_BYTES, StandardInformation, create_relative, error_code, is_reparse_point, open_root,
    query, raw, read, reparse_target, set_disposition, win32_code,
};
use crate::process_requests::{Code, native_path};
use crate::schema::process_reply::FileFactErrorCode;
use crate::schema::process_request::{DeleteExpectedLinkTag, FileDelete, FileDeleteEntryExpected};

const INVALID: Code = Code::InvalidRequest;
/// Contract §5 "File facts": at most 64 entries and 64 folders per request.
pub(crate) const ENTRIES: usize = 64;
/// `MAX_PATH`: a `recycle` path of 260 or more UTF-16 units refuses first (plan.md D6, N10).
pub(crate) const MAX_PATH: usize = 260;

/// The delete mode of one request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Mode {
    Recycle,
    Permanent,
}

/// The review fact of one entry (contract Δ6 `DeleteExpected`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Expected {
    /// `digest` is `None` for a file above the 1 MiB digest bound.
    File {
        size: u64,
        last_write: i64,
        digest: Option<String>,
    },
    Link {
        tag: DeleteExpectedLinkTag,
        target: Option<String>,
    },
}

/// One request entry: the path below the worktree root and its review fact.
#[derive(Clone, Debug)]
pub(crate) struct Entry {
    pub(crate) path: PathBuf,
    pub(crate) expected: Expected,
}

/// The checked fields of a `fileDelete` frame. It reads no file.
#[derive(Debug)]
pub(crate) struct Request<'a> {
    pub(crate) operation_id: &'a str,
    pub(crate) repository_id: &'a str,
    pub(crate) mode: Mode,
    pub(crate) entries: Vec<Entry>,
    /// Absolute folder paths, deepest first.
    pub(crate) folders: Vec<PathBuf>,
}

/// typify drops the array bounds, the `kind` tag, the digest bound, and the native path rule.
/// Contract Δ6: one of `entries` and `folders` is not empty, and each holds at most 64 items.
pub(crate) fn parse(request: &FileDelete) -> Result<Request<'_>, Code> {
    use crate::schema::process_request::FileDeleteMode;
    if request.entries.len() > ENTRIES
        || request.folders.len() > ENTRIES
        || request.entries.is_empty() && request.folders.is_empty()
    {
        return Err(INVALID);
    }
    let entries = request
        .entries
        .iter()
        .map(|entry| {
            let expected = match &entry.expected {
                FileDeleteEntryExpected::File {
                    size,
                    last_write,
                    digest,
                } => Expected::File {
                    // Contract Δ5: a digest binds a file of at most 1 MiB, so the check reads at most the bound and one byte.
                    size: u64::try_from(*size)
                        .ok()
                        .filter(|size| digest.is_none() || *size <= FILE_BYTES)
                        .ok_or(INVALID)?,
                    last_write: last_write.parse().map_err(|_| INVALID)?,
                    digest: digest.as_ref().map(|d| d.to_string()),
                },
                FileDeleteEntryExpected::Link { tag, target } => Expected::Link {
                    tag: *tag,
                    target: target.as_ref().map(|t| t.to_string()),
                },
            };
            Ok(Entry {
                path: native_path(&entry.path)?,
                expected,
            })
        })
        .collect::<Result<_, Code>>()?;
    let folders: Vec<PathBuf> = request
        .folders
        .iter()
        .map(|folder| native_path(folder))
        .collect::<Result<_, Code>>()?;
    // Contract Δ6: each folder is the shallowest folder or lies below it, so the folder phase walks below one held chain.
    let shallowest = folders
        .iter()
        .min_by_key(|folder| folder.components().count());
    if shallowest.is_some_and(|top| !folders.iter().all(|folder| folder.starts_with(top))) {
        return Err(INVALID);
    }
    Ok(Request {
        operation_id: &request.operation_id,
        repository_id: &request.repository_id,
        mode: match request.mode {
            FileDeleteMode::Recycle => Mode::Recycle,
            FileDeleteMode::Permanent => Mode::Permanent,
        },
        entries,
        folders,
    })
}

/// The per-entry outcome (contract Δ6 `fileDelete` reply).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum EntryResult {
    Recycled(String),
    Deleted,
    Kept(u32),
    Stale,
    Absent,
    NotRegular,
    Error(FileFactErrorCode),
    Stopped,
}

/// The per-folder outcome (contract Δ6 `fileDelete` reply).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum FolderResult {
    Removed,
    Kept,
    Absent,
    NotRegular,
    Error(FileFactErrorCode),
}

fn failed(status: NTSTATUS) -> EntryResult {
    match status {
        STATUS_OBJECT_NAME_NOT_FOUND | STATUS_OBJECT_PATH_NOT_FOUND => EntryResult::Absent,
        _ if is_reparse_point(status) => EntryResult::NotRegular,
        _ => EntryResult::Error(error_code(status)),
    }
}

/// The root handle and the ancestor folders that one request holds open without `FILE_SHARE_DELETE` (plan.md D7, N6).
/// The checks open each parent chain; the delete reuses the held handles, so no other process renames a folder meanwhile.
struct Held {
    root: OwnedHandle,
    folders: HashMap<Vec<String>, OwnedHandle>,
}

impl Held {
    /// Opens and holds each ancestor of `names.last()` below the root, and returns the parent handle.
    fn open_parents(
        &mut self,
        names: &[String],
        stop: &std::sync::atomic::AtomicBool,
    ) -> Result<HANDLE, NTSTATUS> {
        let mut parent = raw(&self.root);
        for depth in 1..names.len() {
            parent = match self.folders.get(&names[..depth]) {
                Some(handle) => raw(handle),
                None => {
                    let handle = open_folder(parent, &names[depth - 1], false, stop)?;
                    let opened = raw(&handle);
                    self.folders.insert(names[..depth].to_vec(), handle);
                    opened
                }
            };
        }
        Ok(parent)
    }

    /// The held handle of `prefix`, or the root for an empty prefix. `None` when the prefix is not held.
    fn parent(&self, prefix: &[String]) -> Option<HANDLE> {
        if prefix.is_empty() {
            Some(raw(&self.root))
        } else {
            self.folders.get(prefix).map(raw)
        }
    }
}

/// Opens a folder relative to `parent`. `delete` adds `DELETE` to the access. The share never includes `FILE_SHARE_DELETE`.
/// `OBJ_DONT_REPARSE` fails the open at a reparse point, so a link on the way or at a candidate gives `not-regular`.
fn open_folder(
    parent: HANDLE,
    name: &str,
    delete: bool,
    stop: &std::sync::atomic::AtomicBool,
) -> Result<OwnedHandle, NTSTATUS> {
    if stop.load(Ordering::SeqCst) {
        return Err(STATUS_CANCELLED);
    }
    // NT records the share mode only for an open with read, write, or delete access (`IoSetShareAccess`).
    // So the held folder takes `FILE_LIST_DIRECTORY`; with attribute access only, its missing `FILE_SHARE_DELETE` blocks no rename.
    let access = if delete {
        FILE_READ_ATTRIBUTES | SYNCHRONIZE | DELETE
    } else {
        FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE
    };
    create_relative(
        parent,
        name,
        access,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        FILE_OPEN,
        FILE_SYNCHRONOUS_IO_NONALERT | FILE_DIRECTORY_FILE,
    )
}

/// The target of an entry, opened under its held parent: a file or a reparse point (`FILE_OPEN_REPARSE_POINT`, no `FILE_NON_DIRECTORY_FILE`).
/// `Err` names the open or compare result. A difference from `expected` gives `Stale`.
fn check_entry(
    parent: HANDLE,
    name: &str,
    expected: &Expected,
    stop: &std::sync::atomic::AtomicBool,
) -> Result<Checked, EntryResult> {
    let handle = create_relative(
        parent,
        name,
        DELETE | FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        FILE_OPEN,
        FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
    )
    .map_err(failed)?;
    let error = |status| EntryResult::Error(error_code(status));
    let tag = query::<FILE_ATTRIBUTE_TAG_INFORMATION>(&handle, FileAttributeTagInformation, stop)
        .map_err(error)?;
    let is_directory = tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0;
    if tag.ReparseTag != 0 {
        return match expected {
            Expected::Link {
                tag: etag,
                target: etarget,
            } => {
                let kind = match tag.ReparseTag {
                    t if t == IO_REPARSE_TAG_SYMLINK => DeleteExpectedLinkTag::Symlink,
                    t if t == IO_REPARSE_TAG_MOUNT_POINT => DeleteExpectedLinkTag::Junction,
                    _ => DeleteExpectedLinkTag::Other,
                };
                let target = reparse_target(&handle, tag.ReparseTag, stop).map(|(text, _)| text);
                if kind == *etag && target.as_deref() == etarget.as_deref() {
                    Ok(Checked { handle })
                } else {
                    Err(EntryResult::Stale)
                }
            }
            Expected::File { .. } => Err(EntryResult::Stale),
        };
    }
    if is_directory {
        return Err(EntryResult::NotRegular);
    }
    match expected {
        Expected::Link { .. } => Err(EntryResult::Stale),
        Expected::File {
            size,
            last_write,
            digest,
        } => {
            let standard = query::<StandardInformation>(&handle, FileStandardInformation, stop)
                .map_err(error)?;
            let basic = query::<FILE_BASIC_INFORMATION>(&handle, FileBasicInformation, stop)
                .map_err(error)?;
            if u64::try_from(standard.end_of_file) != Ok(*size)
                || basic.LastWriteTime != *last_write
            {
                return Err(EntryResult::Stale);
            }
            if let Some(digest) = digest {
                // `parse` keeps a digested size within `FILE_BYTES`.
                let bytes = read(raw(&handle), *size as usize + 1, stop).map_err(error)?;
                if bytes.len() as u64 != *size
                    || crate::settings::hex(&crate::settings::sha256(&bytes)) != *digest
                {
                    return Err(EntryResult::Stale);
                }
            }
            Ok(Checked { handle })
        }
    }
}

/// A target that passed its review check. The handle stays open during the delete, so no other process renames it.
struct Checked {
    handle: OwnedHandle,
}

impl Checked {
    /// The `FILE_ID_INFO` of the checked handle, for the `PreDeleteItem` compare.
    fn id(&self) -> Option<FILE_ID_INFO> {
        file_id(HANDLE(self.handle.as_raw_handle()))
    }

    /// `FileDispositionInfoEx` with POSIX delete and no read-only override. A read-only file gives `access-denied`.
    fn delete_permanent(&self) -> EntryResult {
        match set_disposition(&self.handle) {
            Ok(()) => EntryResult::Deleted,
            Err(error) => EntryResult::Error(win32_code(&error)),
        }
    }
}

/// The `FILE_ID_INFO` of a handle. `None` on a failed query.
fn file_id(handle: HANDLE) -> Option<FILE_ID_INFO> {
    let mut info = FILE_ID_INFO::default();
    // SAFETY: `handle` is open, and `info` is a live local of the passed size.
    unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileIdInfo,
            (&raw mut info).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    }
    .ok()
    .map(|()| info)
}

/// The reviewed request after its checks (plan.md D7). It holds every opened handle until `run` finishes the delete.
/// A stop during the checks reaches here; the delete in `run` never starts, so nothing changes.
pub(crate) struct Plan {
    held: Option<Held>,
    root_status: NTSTATUS,
    mode: Mode,
    results: Vec<Option<EntryResult>>,
    proceeding: Vec<(usize, PathBuf, Checked)>,
    folders: Vec<(Vec<String>, Option<FolderResult>)>,
}

/// Opens each parent chain and checks each entry (plan.md D7). It respects `stop`. The delete runs later in `Plan::run`.
pub(crate) fn check(
    root: &Path,
    mode: Mode,
    entries: &[(Vec<String>, PathBuf, Expected)],
    folders: &[(Vec<String>, PathBuf)],
    stop: &std::sync::atomic::AtomicBool,
) -> Plan {
    let mut results: Vec<Option<EntryResult>> = vec![None; entries.len()];
    let root_handle = match open_root(root, stop) {
        Ok(handle) => handle,
        Err(status) => {
            for result in &mut results {
                *result = Some(failed(status));
            }
            return Plan {
                held: None,
                root_status: status,
                mode,
                results,
                proceeding: Vec::new(),
                folders: folders
                    .iter()
                    .map(|(names, _)| (names.clone(), None))
                    .collect(),
            };
        }
    };
    let mut held = Held {
        root: root_handle,
        folders: HashMap::new(),
    };
    let mut proceeding = Vec::new();
    for (index, (names, absolute, expected)) in entries.iter().enumerate() {
        match held.open_parents(names, stop) {
            Ok(parent) => {
                match check_entry(parent, names.last().expect("one component"), expected, stop) {
                    Ok(checked) => proceeding.push((index, absolute.clone(), checked)),
                    Err(result) => results[index] = Some(result),
                }
            }
            Err(status) => results[index] = Some(failed(status)),
        }
    }
    // The candidates are the selected folder and the emptied folders below it (plan.md D6). Hold only the chain
    // above the selected folder, without `FILE_SHARE_DELETE`. The delete opens each candidate with `DELETE` once.
    let plan_folders: Vec<(Vec<String>, Option<FolderResult>)> = if folders.is_empty() {
        Vec::new()
    } else {
        let shallowest = folders
            .iter()
            .min_by_key(|(names, _)| names.len())
            .expect("a non-empty folder list");
        let pre = held
            .open_parents(&shallowest.0, stop)
            .err()
            .map(folder_failed);
        folders
            .iter()
            .map(|(names, _)| (names.clone(), pre.clone()))
            .collect()
    };
    Plan {
        held: Some(held),
        root_status: NTSTATUS(0),
        mode,
        results,
        proceeding,
        folders: plan_folders,
    }
}

impl Plan {
    /// Finishes the reviewed request: the permanent or Recycle Bin delete, then the folder phase (plan.md D7).
    /// `owner` is the main window handle for the Recycle Bin operation.
    pub(crate) fn run(mut self, owner: Option<isize>) -> (Vec<EntryResult>, Vec<FolderResult>) {
        let Some(held) = self.held.as_ref() else {
            // The root did not open, so every entry and folder failed with its status.
            let folders = self
                .folders
                .iter()
                .map(|_| folder_failed(self.root_status))
                .collect();
            return (
                self.results
                    .into_iter()
                    .map(|result| result.expect("one result per entry"))
                    .collect(),
                folders,
            );
        };
        match self.mode {
            Mode::Permanent => {
                for (index, _, checked) in &self.proceeding {
                    self.results[*index] = Some(checked.delete_permanent());
                }
            }
            Mode::Recycle => {
                use std::os::windows::ffi::OsStrExt;
                let items: Vec<(Vec<u16>, FILE_ID_INFO)> = self
                    .proceeding
                    .iter()
                    .map(|(_, path, checked)| {
                        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
                        wide.push(0);
                        (wide, checked.id().unwrap_or_default())
                    })
                    .collect();
                let outcomes = recycle(items, owner);
                for ((index, _, _), outcome) in self.proceeding.iter().zip(outcomes) {
                    self.results[*index] = Some(outcome);
                }
            }
        }
        // Open each candidate with `DELETE` under its parent, parents before children, so a parent candidate's handle
        // serves its children. Then dispose deepest first, so POSIX close removes the names bottom up (plan.md D7).
        let mut folders: Vec<Option<FolderResult>> =
            self.folders.iter().map(|(_, pre)| pre.clone()).collect();
        let mut order: Vec<usize> = (0..self.folders.len())
            .filter(|&i| folders[i].is_none())
            .collect();
        order.sort_by_key(|&i| self.folders[i].0.len());
        let mut opened: HashMap<Vec<String>, OwnedHandle> = HashMap::new();
        let mut between: HashMap<Vec<String>, OwnedHandle> = HashMap::new();
        for &index in &order {
            let names = &self.folders[index].0;
            let parent = way(held, &opened, &mut between, &names[..names.len() - 1]);
            folders[index] = match parent.and_then(|parent| {
                open_folder(parent, names.last().expect("one component"), true, &NEVER)
            }) {
                Ok(handle) => {
                    opened.insert(names.clone(), handle);
                    None
                }
                Err(status) => Some(folder_failed(status)),
            };
        }
        // Deepest first: dispose and close, so each parent is empty by its own step.
        let mut deepest: Vec<usize> = order
            .iter()
            .copied()
            .filter(|&i| opened.contains_key(&self.folders[i].0))
            .collect();
        deepest.sort_by_key(|&i| std::cmp::Reverse(self.folders[i].0.len()));
        for index in deepest {
            let handle = opened.remove(&self.folders[index].0).expect("opened");
            folders[index] = Some(match set_disposition(&handle) {
                Ok(()) => {
                    drop(handle);
                    FolderResult::Removed
                }
                Err(error) if error.code() == ERROR_DIR_NOT_EMPTY.to_hresult() => {
                    FolderResult::Kept
                }
                Err(error) => FolderResult::Error(win32_code(&error)),
            });
        }
        let folders: Vec<FolderResult> = folders
            .into_iter()
            .map(|result| result.expect("one result per folder"))
            .collect();
        (
            self.results
                .into_iter()
                .map(|result| result.expect("one result per entry"))
                .collect(),
            folders,
        )
    }
}

/// The handle of the folder `prefix` in the folder phase: a held folder, an opened candidate, or a folder between two
/// candidates. A folder between opens here without `DELETE` and stays held until the phase ends (plan.md D7).
fn way(
    held: &Held,
    opened: &HashMap<Vec<String>, OwnedHandle>,
    between: &mut HashMap<Vec<String>, OwnedHandle>,
    prefix: &[String],
) -> Result<HANDLE, NTSTATUS> {
    if let Some(handle) = held.parent(prefix) {
        return Ok(handle);
    }
    if let Some(handle) = opened.get(prefix).or_else(|| between.get(prefix)) {
        return Ok(raw(handle));
    }
    // `held.parent` serves the empty prefix, so `prefix` has a last name here.
    let (last, up) = prefix.split_last().expect("a folder below the root");
    let parent = way(held, opened, between, up)?;
    let handle = open_folder(parent, last, false, &NEVER)?;
    let folder = raw(&handle);
    between.insert(prefix.to_vec(), handle);
    Ok(folder)
}

/// The delete phase never stops, as the append write never stops (plan.md D7, contract Δ6). A stop before it gives `stopped`.
static NEVER: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn folder_failed(status: NTSTATUS) -> FolderResult {
    match status {
        STATUS_OBJECT_NAME_NOT_FOUND | STATUS_OBJECT_PATH_NOT_FOUND => FolderResult::Absent,
        STATUS_FILE_IS_A_DIRECTORY | STATUS_NOT_A_DIRECTORY => FolderResult::NotRegular,
        _ if is_reparse_point(status) => FolderResult::NotRegular,
        _ => FolderResult::Error(error_code(status)),
    }
}

// ---- Recycle Bin (plan.md D7, N1 to N4, N8 to N11) ----

/// The `IFileOperation` progress sink: it checks each item's file ID before the delete and records the result after it.
/// An item that the Shell never reaches keeps its first result, `Stopped`.
#[implement(IFileOperationProgressSink)]
struct Sink {
    checked: Vec<FILE_ID_INFO>,
    outcomes: Arc<Mutex<Vec<EntryResult>>>,
    cursor: AtomicUsize,
}

/// The parsing name of a Shell item, or `None` for an item without a file-system path or a failed call.
fn display_name(item: &IShellItem, kind: SIGDN) -> Option<String> {
    // SAFETY: `item` is a live interface pointer, and the returned buffer frees below.
    let pwstr = unsafe { item.GetDisplayName(kind) }.ok()?;
    if pwstr.is_null() {
        return None;
    }
    // SAFETY: `GetDisplayName` returns a NUL-ended wide string that `CoTaskMemFree` frees.
    let text = unsafe { pwstr.to_string() }.ok();
    unsafe { CoTaskMemFree(Some(pwstr.0 as *const c_void)) };
    text
}

/// The `FILE_ID_INFO` of a Win32 path opened without following a link, as the Shell resolves the path (plan.md D7, N9).
fn path_id(path: &str) -> Option<FILE_ID_INFO> {
    use std::os::windows::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES.0)
        .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).0)
        .custom_flags((FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS).0)
        .open(path)
        .ok()?;
    file_id(HANDLE(file.as_raw_handle()))
}

impl IFileOperationProgressSink_Impl for Sink_Impl {
    fn StartOperations(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn FinishOperations(&self, _: windows::core::HRESULT) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreRenameItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostRenameItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: windows::core::HRESULT,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreMoveItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostMoveItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: windows::core::HRESULT,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreCopyItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostCopyItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: windows::core::HRESULT,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    /// Contract Δ6 (N9): the item's file-system path opens without following a link, and its ID must equal the checked ID.
    /// A failure cancels this and every later item (Microsoft Learn `IFileOperationProgressSink::PreDeleteItem`).
    fn PreDeleteItem(&self, _: u32, psiitem: Ref<IShellItem>) -> windows::core::Result<()> {
        let index = self.cursor.load(Ordering::SeqCst);
        let cancel = || windows::core::Error::from_hresult(ERROR_CANCELLED.to_hresult());
        let item = psiitem.ok().map_err(|_| cancel())?;
        let path = display_name(item, SIGDN_FILESYSPATH).ok_or_else(cancel)?;
        let id = path_id(&path).ok_or_else(cancel)?;
        if self.checked.get(index) == Some(&id) {
            Ok(())
        } else {
            Err(cancel())
        }
    }
    /// A non-null `psiNewlyCreated` means the item moved to the Recycle Bin. A null one means a full delete (Microsoft Learn).
    fn PostDeleteItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        hrdelete: windows::core::HRESULT,
        psinewlycreated: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        let index = self.cursor.fetch_add(1, Ordering::SeqCst);
        let outcome = if hrdelete.is_ok() {
            match psinewlycreated.ok() {
                // The item moved, but its Recycle Bin name is unknown, so the fresh read decides (plan.md D6).
                Ok(created) => display_name(created, SIGDN_DESKTOPABSOLUTEPARSING).map_or(
                    EntryResult::Error(FileFactErrorCode::OtherError),
                    EntryResult::Recycled,
                ),
                Err(_) => EntryResult::Deleted,
            }
        } else {
            EntryResult::Kept(hrdelete.0 as u32)
        };
        let mut outcomes = self.outcomes.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(slot) = outcomes.get_mut(index) {
            *slot = outcome;
        }
        Ok(())
    }
    fn PreNewItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostNewItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: &PCWSTR,
        _: u32,
        _: windows::core::HRESULT,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn UpdateProgress(&self, _: u32, _: u32) -> windows::core::Result<()> {
        Ok(())
    }
    fn ResetTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn PauseTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn ResumeTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
}

/// One `IFileOperation` on a COM apartment thread (plan.md D7). It deletes each checked item through the Recycle Bin.
/// A failed thread can end after some items moved, so each item gives `error other-error`, and the fresh read decides (plan.md D6).
fn recycle(items: Vec<(Vec<u16>, FILE_ID_INFO)>, owner: Option<isize>) -> Vec<EntryResult> {
    let count = items.len();
    std::thread::spawn(move || recycle_sta(items, owner))
        .join()
        .unwrap_or_else(|_| vec![EntryResult::Error(FileFactErrorCode::OtherError); count])
}

/// The COM apartment thread. A failed COM init moves nothing, so each item keeps its file (contract Δ6 per-entry `kept`).
fn recycle_sta(items: Vec<(Vec<u16>, FILE_ID_INFO)>, owner: Option<isize>) -> Vec<EntryResult> {
    // SAFETY: a successful init pairs with `CoUninitialize` on this thread before it ends.
    let init = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if init.is_err() {
        return vec![EntryResult::Kept(init.0 as u32); items.len()];
    }
    let outcomes = perform(&items, owner);
    // SAFETY: the init above succeeded on this thread, and `perform` released each COM object.
    unsafe { CoUninitialize() };
    outcomes
}

fn perform(items: &[(Vec<u16>, FILE_ID_INFO)], owner: Option<isize>) -> Vec<EntryResult> {
    let outcomes = Arc::new(Mutex::new(vec![EntryResult::Stopped; items.len()]));
    let sink: IFileOperationProgressSink = Sink {
        checked: items.iter().map(|(_, id)| *id).collect(),
        outcomes: Arc::clone(&outcomes),
        cursor: AtomicUsize::new(0),
    }
    .into();
    // Nothing moves before `PerformOperations`, so a failed step before it keeps each item with that HRESULT.
    let (operation, cookie) = match queue(items, owner, &sink) {
        Ok(queued) => queued,
        Err(error) => return vec![EntryResult::Kept(error.code().0 as u32); items.len()],
    };
    // A cancel or a failed item can make `PerformOperations` fail after other items moved.
    // So its HRESULT decides nothing, and the sink results are the outcome (plan.md D7).
    // SAFETY: the queued items run under the progress sink.
    let _ = unsafe { operation.PerformOperations() };
    // SAFETY: the cookie came from `Advise`.
    let _ = unsafe { operation.Unadvise(cookie) };
    drop(operation);
    drop(sink);
    std::mem::take(&mut *outcomes.lock().unwrap_or_else(PoisonError::into_inner))
}

/// Creates the operation, queues each checked item, and advises `sink`. The caller keeps `sink` alive until `Unadvise`.
fn queue(
    items: &[(Vec<u16>, FILE_ID_INFO)],
    owner: Option<isize>,
    sink: &IFileOperationProgressSink,
) -> windows::core::Result<(IFileOperation, u32)> {
    // SAFETY: COM is initialized on this thread.
    let operation: IFileOperation = unsafe {
        CoCreateInstance(
            &FileOperation,
            None,
            CLSCTX_INPROC_SERVER | CLSCTX_LOCAL_SERVER,
        )
    }?;
    // No `FOFX_EARLYFAILURE`, so one failed item does not cancel the others (plan.md O-7).
    let flags = FOF_NOCONFIRMATION
        | FOF_SILENT
        | FOF_NOERRORUI
        | FOF_WANTNUKEWARNING
        | FOF_ALLOWUNDO
        | FOFX_RECYCLEONDELETE;
    // SAFETY: `operation` is a live interface pointer.
    unsafe { operation.SetOperationFlags(flags) }?;
    if let Some(owner) = owner {
        // SAFETY: `owner` is the main window handle.
        unsafe { operation.SetOwnerWindow(HWND(owner as *mut c_void)) }?;
    }
    for (wide, _) in items {
        // SAFETY: `wide` is a NUL-ended wide path.
        let item: IShellItem = unsafe { SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None) }?;
        // SAFETY: `item` is a live interface pointer.
        unsafe { operation.DeleteItem(&item, None) }?;
    }
    // SAFETY: the caller keeps `sink` alive until `Unadvise`.
    let cookie = unsafe { operation.Advise(sink) }?;
    Ok((operation, cookie))
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::{Path, PathBuf};
    use std::sync::atomic::AtomicBool;

    use serde_json::{Value, json};

    use crate::jobs::tests::Fixture;
    use crate::process_requests::tests::junction;
    use crate::schema::typed;
    use crate::settings::{hex, sha256};

    static RUN: AtomicBool = AtomicBool::new(false);

    fn below(root: &Path, path: &Path) -> Vec<String> {
        crate::file_facts::below(root, path).expect("below the root")
    }

    fn file_expected(bytes: &[u8], path: &Path) -> Expected {
        use std::os::windows::fs::MetadataExt;
        let meta = std::fs::symlink_metadata(path).expect("metadata");
        Expected::File {
            size: bytes.len() as u64,
            last_write: meta.last_write_time() as i64,
            digest: Some(hex(&sha256(bytes))),
        }
    }

    fn repository() -> (Fixture, PathBuf) {
        let fixture = Fixture::new();
        let root = fixture.path("repo");
        std::fs::create_dir_all(&root).expect("repository");
        (fixture, root)
    }

    fn run_permanent(root: &Path, entries: &[(PathBuf, Expected)]) -> Vec<EntryResult> {
        let built: Vec<_> = entries
            .iter()
            .map(|(path, expected)| (below(root, path), path.clone(), expected.clone()))
            .collect();
        check(root, Mode::Permanent, &built, &[], &RUN).run(None).0
    }

    /// Contract Δ6: a permanent delete removes a checked file, and a changed file gives `stale`.
    #[test]
    fn a_permanent_delete_removes_a_checked_file_and_a_change_is_stale() {
        let (_fixture, root) = repository();
        let file = root.join("build.log");
        std::fs::write(&file, b"log\n").expect("file");
        let expected = file_expected(b"log\n", &file);
        assert_eq!(
            run_permanent(&root, &[(file.clone(), expected.clone())]),
            vec![EntryResult::Deleted]
        );
        assert!(!file.exists());
        std::fs::write(&file, b"other bytes\n").expect("file");
        assert_eq!(
            run_permanent(&root, &[(file.clone(), expected)]),
            vec![EntryResult::Stale]
        );
        assert!(file.exists(), "a stale entry stays");
    }

    /// Contract Δ6: a read-only file gives `error access-denied`, because POSIX delete keeps the read-only rule.
    #[test]
    fn a_read_only_file_gives_access_denied() {
        let (_fixture, root) = repository();
        let file = root.join("ro.txt");
        std::fs::write(&file, b"x\n").expect("file");
        let expected = file_expected(b"x\n", &file);
        let mut perms = std::fs::metadata(&file).expect("metadata").permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&file, perms).expect("read-only");
        assert_eq!(
            run_permanent(&root, &[(file.clone(), expected)]),
            vec![EntryResult::Error(FileFactErrorCode::AccessDenied)]
        );
        assert!(file.exists(), "the read-only file stays");
        let mut perms = std::fs::metadata(&file).expect("metadata").permissions();
        perms.set_readonly(false);
        std::fs::set_permissions(&file, perms).ok();
    }

    /// Contract Δ6: a directory without a reparse tag gives `not-regular`, and an absent entry gives `absent`.
    #[test]
    fn a_directory_is_not_regular_and_an_absent_entry_is_absent() {
        let (_fixture, root) = repository();
        let folder = root.join("folder");
        std::fs::create_dir(&folder).expect("folder");
        let expected = Expected::File {
            size: 0,
            last_write: 0,
            digest: None,
        };
        assert_eq!(
            run_permanent(&root, &[(folder, expected.clone())]),
            vec![EntryResult::NotRegular]
        );
        assert_eq!(
            run_permanent(&root, &[(root.join("gone.txt"), expected)]),
            vec![EntryResult::Absent]
        );
    }

    /// Contract Δ6: a holder without `FILE_SHARE_DELETE` makes the target open fail with `sharing-violation`.
    #[test]
    fn a_held_file_without_delete_sharing_gives_sharing_violation() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_fixture, root) = repository();
        let file = root.join("held.txt");
        std::fs::write(&file, b"x\n").expect("file");
        let expected = file_expected(b"x\n", &file);
        let holder = std::fs::OpenOptions::new()
            .read(true)
            .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE).0)
            .open(&file)
            .expect("holder");
        assert_eq!(
            run_permanent(&root, &[(file.clone(), expected)]),
            vec![EntryResult::Error(FileFactErrorCode::SharingViolation)]
        );
        drop(holder);
        assert!(file.exists());
    }

    /// Contract Δ6 (clarify 7): a folder link opens as a directory reparse point, so a permanent delete removes the link and the target stays.
    #[test]
    fn a_folder_link_deletes_the_link_and_keeps_the_target() {
        let (fixture, root) = repository();
        let outside = fixture.path("target");
        std::fs::create_dir(&outside).expect("target");
        std::fs::write(outside.join("keep.txt"), b"keep\n").expect("inside");
        let link = root.join("ln");
        if !junction(&link, &outside) {
            println!("SKIP fileDelete junction: missing capability ntfs-junction (unverified)");
            return;
        }
        let expected = Expected::Link {
            tag: DeleteExpectedLinkTag::Junction,
            target: reparse_of(&link),
        };
        let built = vec![(below(&root, &link), link.clone(), expected)];
        let results = check(&root, Mode::Permanent, &built, &[], &RUN).run(None).0;
        assert_eq!(results, vec![EntryResult::Deleted]);
        assert!(!link.exists(), "the link went");
        assert!(outside.join("keep.txt").exists(), "the target stays");
    }

    fn reparse_of(link: &Path) -> Option<String> {
        use std::os::windows::fs::OpenOptionsExt;
        let handle = std::fs::OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES.0)
            .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).0)
            .custom_flags((FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS).0)
            .open(link)
            .expect("open link");
        let owned: OwnedHandle = handle.into();
        reparse_target(&owned, IO_REPARSE_TAG_MOUNT_POINT, &RUN).map(|(text, _)| text)
    }

    /// Contract Δ6 (plan.md D7): the folder step removes `a` with only the empty folders `a/b/c` below it, deepest first.
    #[test]
    fn the_folder_step_removes_nested_empty_folders() {
        let (_fixture, root) = repository();
        std::fs::create_dir_all(root.join("a").join("b").join("c")).expect("nested");
        let candidates = [
            root.join("a").join("b").join("c"),
            root.join("a").join("b"),
            root.join("a"),
        ];
        let built: Vec<_> = candidates
            .iter()
            .map(|path| (below(&root, path), path.clone()))
            .collect();
        let results = check(&root, Mode::Permanent, &[], &built, &RUN).run(None).1;
        assert_eq!(
            results,
            vec![
                FolderResult::Removed,
                FolderResult::Removed,
                FolderResult::Removed
            ]
        );
        assert!(!root.join("a").exists(), "the whole subtree went");
    }

    /// Contract Δ6: a non-empty folder gives `kept`, and the folder stays.
    #[test]
    fn a_non_empty_folder_is_kept() {
        let (_fixture, root) = repository();
        let folder = root.join("keep");
        std::fs::create_dir(&folder).expect("folder");
        std::fs::write(folder.join("inside.txt"), b"x\n").expect("inside");
        let built = vec![(below(&root, &folder), folder.clone())];
        let results = check(&root, Mode::Permanent, &[], &built, &RUN).run(None).1;
        assert_eq!(results, vec![FolderResult::Kept]);
        assert!(folder.exists(), "the folder stays");
    }

    /// Contract Δ6 (plan.md D6): an emptied folder below a folder that keeps a file is a candidate.
    /// The folder phase opens the kept folder on the way, so the candidate below it goes.
    #[test]
    fn a_candidate_below_a_kept_folder_is_removed() {
        let (_fixture, root) = repository();
        let kept = root.join("a").join("b");
        let deep = kept.join("c");
        std::fs::create_dir_all(&deep).expect("nested");
        std::fs::write(kept.join("keep.txt"), b"x\n").expect("kept file");
        let built: Vec<_> = [deep.clone(), root.join("a")]
            .iter()
            .map(|path| (below(&root, path), path.clone()))
            .collect();
        let results = check(&root, Mode::Permanent, &[], &built, &RUN).run(None).1;
        assert_eq!(results, vec![FolderResult::Removed, FolderResult::Kept]);
        assert!(!deep.exists(), "the emptied folder went");
        assert!(kept.join("keep.txt").exists(), "the kept file stays");
    }

    /// The walk holds a folder on the way without `FILE_SHARE_DELETE`, so another process cannot rename it (N6).
    /// A folder request holds only the chain above the selected folder, so no open child handle blocks the rename by itself.
    #[test]
    fn the_walk_holds_a_folder_without_delete_sharing() {
        let (_fixture, root) = repository();
        let middle = root.join("mid");
        let selected = middle.join("deep");
        std::fs::create_dir_all(&selected).expect("nested");
        let built = vec![(below(&root, &selected), selected.clone())];
        let plan = check(&root, Mode::Permanent, &[], &built, &RUN);
        // A rename opens the folder for `DELETE`, which the held `mid` handle does not share.
        let rename = std::fs::rename(&middle, root.join("renamed"));
        assert!(rename.is_err(), "a held folder cannot be renamed");
        drop(plan);
        // Without the hold, the same rename succeeds.
        assert!(std::fs::rename(&middle, root.join("renamed")).is_ok());
        assert!(root.join("renamed").join("deep").is_dir());
    }

    /// Contract Δ6: the request rules refuse a relative path, a negative size, and more than 64 items.
    #[test]
    fn the_request_rules_refuse_a_relative_path_and_an_over_full_request() {
        let frame = |fields: Value| {
            let mut frame = json!({
                "type": "fileDelete", "callId": "0f0f0f0f-0000-4000-8000-000000000001",
                "operationId": "0f0f0f0f-0000-4000-8000-000000000004", "repositoryId": "0f0f0f0f-0000-4000-8000-000000000005",
                "mode": "permanent",
                "entries": [{ "path": "C:\\repo\\a", "expected": { "kind": "file", "size": 1, "lastWrite": "1" } }],
                "folders": [],
            });
            frame
                .as_object_mut()
                .expect("frame")
                .extend(fields.as_object().expect("fields").clone());
            let request = typed(&frame).ok_or(INVALID)?;
            parse(&request).map(|parsed| (parsed.mode, parsed.entries.len(), parsed.folders.len()))
        };
        assert_eq!(frame(json!({})), Ok((Mode::Permanent, 1, 0)));
        let link = json!([{ "path": "C:\\repo\\ln", "expected": { "kind": "link", "tag": "junction", "target": "C:\\out" } }]);
        assert_eq!(
            frame(json!({ "entries": link })),
            Ok((Mode::Permanent, 1, 0))
        );
        let digest = "a".repeat(64);
        let sized = |size: u64, digest: Option<&str>| {
            let mut expected = json!({ "kind": "file", "size": size, "lastWrite": "1" });
            if let Some(digest) = digest {
                expected["digest"] = json!(digest);
            }
            json!({ "entries": [{ "path": "C:\\repo\\a", "expected": expected }] })
        };
        assert_eq!(
            frame(sized(1_048_576, Some(&digest))),
            Ok((Mode::Permanent, 1, 0)),
            "a digest of 1 MiB"
        );
        assert_eq!(
            frame(sized(5 << 30, None)),
            Ok((Mode::Permanent, 1, 0)),
            "a large file without a digest"
        );
        let nested = json!({ "entries": [], "folders": ["C:\\repo\\a\\b", "C:\\repo\\a"] });
        assert_eq!(
            frame(nested),
            Ok((Mode::Permanent, 0, 2)),
            "a folder below the shallowest folder"
        );
        let many: Vec<Value> = (0..65)
            .map(|n| json!({ "path": format!("C:\\repo\\f{n}"), "expected": { "kind": "file", "size": 0, "lastWrite": "0" } }))
            .collect();
        for (name, fields) in [
            (
                "a relative path",
                json!({ "entries": [{ "path": "a", "expected": { "kind": "file", "size": 1, "lastWrite": "1" } }] }),
            ),
            (
                "a negative size",
                json!({ "entries": [{ "path": "C:\\repo\\a", "expected": { "kind": "file", "size": -1, "lastWrite": "1" } }] }),
            ),
            ("both empty", json!({ "entries": [], "folders": [] })),
            ("more than 64 entries", json!({ "entries": many })),
            // Contract Δ5: the digest bound is 1 MiB, so the check reads at most 1 MiB and one byte.
            ("a digest above 1 MiB", sized(1_048_577, Some(&digest))),
            ("a digest of a 5 GiB file", sized(5 << 30, Some(&digest))),
            (
                "a folder beside the shallowest folder",
                json!({ "entries": [], "folders": ["C:\\repo\\a", "C:\\repo\\b"] }),
            ),
            (
                "a deeper folder outside the shallowest folder",
                json!({ "entries": [], "folders": ["C:\\repo\\a\\x", "C:\\repo\\b\\x\\y", "C:\\repo\\b"] }),
            ),
        ] {
            assert_eq!(frame(fields), Err(INVALID), "{name}");
        }
    }

    // ---- Recycle Bin facts (research.md R16). Each test moves only its own fixture items and purges them. ----

    /// Removes one Recycle Bin item that a test moved, and its `$I` partner beside the `$R` item.
    fn purge(recycled: &Path) {
        let link =
            std::fs::symlink_metadata(recycled).is_ok_and(|meta| meta.file_type().is_symlink());
        let removed = if link || recycled.is_file() {
            std::fs::remove_file(recycled).or_else(|_| std::fs::remove_dir(recycled))
        } else {
            std::fs::remove_dir_all(recycled)
        };
        let partner = recycled
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix("$R"))
            .map(|rest| recycled.with_file_name(format!("$I{rest}")));
        println!(
            "PURGE item={} partner={}",
            removed.is_ok(),
            partner
                .as_ref()
                .is_some_and(|partner| std::fs::remove_file(partner).is_ok())
        );
    }

    /// Purges every `recycled` result, then returns the results. A failed assertion after it leaves no item in the Recycle Bin.
    fn purged(results: Vec<EntryResult>) -> Vec<EntryResult> {
        for result in &results {
            if let EntryResult::Recycled(path) = result {
                let bin = Path::new(path)
                    .components()
                    .nth(2)
                    .is_some_and(|part| part.as_os_str().eq_ignore_ascii_case("$Recycle.Bin"));
                println!(
                    "OBSERVATION T012: N1 recycledPath is a file system path in $Recycle.Bin: {bin}"
                );
                purge(Path::new(path));
            }
        }
        results
    }

    fn recycle(root: &Path, entries: &[(Vec<String>, PathBuf, Expected)]) -> Vec<EntryResult> {
        purged(check(root, Mode::Recycle, entries, &[], &RUN).run(None).0)
    }

    fn entry(root: &Path, path: &Path, bytes: &[u8]) -> (Vec<String>, PathBuf, Expected) {
        std::fs::write(path, bytes).expect("file");
        (
            below(root, path),
            path.to_path_buf(),
            file_expected(bytes, path),
        )
    }

    /// N1 and N11: each checked item moves to the Recycle Bin while its checked handle stays open.
    #[test]
    #[ignore = "moves fixture files through the Recycle Bin; run on demand by exact name"]
    fn recycle_moves_each_checked_item_while_its_handle_stays_open() {
        let (_fixture, root) = repository();
        let entries = [
            entry(&root, &root.join("one.txt"), b"one\n"),
            entry(&root, &root.join("two.txt"), b"two\n"),
        ];
        let results = recycle(&root, &entries);
        assert!(
            results
                .iter()
                .all(|result| matches!(result, EntryResult::Recycled(_))),
            "{results:?}"
        );
        assert!(!root.join("one.txt").exists() && !root.join("two.txt").exists());
    }

    /// The `PostDeleteItem` HRESULT of an item that `PreDeleteItem` cancels (N4, 2026-10-22).
    const CANCELLED: EntryResult = EntryResult::Kept(0x8007_04C7);

    /// N4 (plan.md D7): a file that another file replaced after the check cancels its item and every later item.
    /// The results of the items that the Shell moved before the cancel stay.
    #[test]
    #[ignore = "moves fixture files through the Recycle Bin; run on demand by exact name"]
    fn a_cancel_keeps_the_result_of_each_item_that_the_shell_moved_before_it() {
        let (_fixture, root) = repository();
        let (first, second) = (root.join("one.txt"), root.join("two.txt"));
        let entries = [
            entry(&root, &first, b"one\n"),
            entry(&root, &second, b"two\n"),
        ];
        let plan = check(&root, Mode::Recycle, &entries, &[], &RUN);
        // The checked handle shares `DELETE`, so the rename moves the checked file, and a new file takes its name.
        std::fs::rename(&second, root.join("two.old")).expect("rename the checked file");
        std::fs::write(&second, b"new\n").expect("a new file");
        let results = purged(plan.run(None).0);
        assert!(
            matches!(results[0], EntryResult::Recycled(_)),
            "{results:?}"
        );
        assert_eq!(results[1], CANCELLED, "{results:?}");
        assert_eq!(std::fs::read(&second).expect("the new file"), b"new\n");
        assert_eq!(
            std::fs::read(root.join("two.old")).expect("the checked file"),
            b"two\n"
        );
    }

    /// N4: a cancel at the first item moves nothing. The item gives `kept` with the cancel HRESULT, and each later item `stopped`.
    /// `PerformOperations` fails here, and the sink results still decide.
    #[test]
    #[ignore = "moves fixture files through the Recycle Bin; run on demand by exact name"]
    fn a_cancel_at_the_first_item_moves_nothing() {
        let (_fixture, root) = repository();
        let (first, second) = (root.join("one.txt"), root.join("two.txt"));
        let entries = [
            entry(&root, &first, b"one\n"),
            entry(&root, &second, b"two\n"),
        ];
        let plan = check(&root, Mode::Recycle, &entries, &[], &RUN);
        std::fs::rename(&first, root.join("one.old")).expect("rename the checked file");
        std::fs::write(&first, b"new\n").expect("a new file");
        let results = purged(plan.run(None).0);
        assert_eq!(results, vec![CANCELLED, EntryResult::Stopped]);
        assert_eq!(std::fs::read(&first).expect("the new file"), b"new\n");
        assert_eq!(std::fs::read(&second).expect("the later item"), b"two\n");
    }

    /// N3: a junction goes to the Recycle Bin as a link, and its target stays.
    #[test]
    #[ignore = "moves fixture files through the Recycle Bin; run on demand by exact name"]
    fn recycle_moves_a_junction_as_a_link() {
        let (fixture, root) = repository();
        let outside = fixture.path("target");
        std::fs::create_dir(&outside).expect("target");
        std::fs::write(outside.join("keep.txt"), b"keep\n").expect("inside");
        let link = root.join("ln");
        if !junction(&link, &outside) {
            println!(
                "SKIP fileDelete junction recycle: missing capability ntfs-junction (unverified)"
            );
            return;
        }
        let expected = Expected::Link {
            tag: DeleteExpectedLinkTag::Junction,
            target: reparse_of(&link),
        };
        let results = recycle(&root, &[(below(&root, &link), link.clone(), expected)]);
        assert!(
            matches!(results[0], EntryResult::Recycled(_)),
            "{results:?}"
        );
        assert!(std::fs::symlink_metadata(&link).is_err(), "the link went");
        assert_eq!(
            std::fs::read(outside.join("keep.txt")).expect("target"),
            b"keep\n"
        );
    }

    /// N9 (plan.md D7 "Reason"): the Shell parse removes a final dot or space, so the item names `x`.
    /// The file ID compare cancels the item. `x.` and `x` stay.
    #[test]
    #[ignore = "moves fixture files through the Recycle Bin; run on demand by exact name"]
    fn recycle_never_moves_a_name_that_ends_with_a_dot_or_a_space() {
        let (_fixture, root) = repository();
        let plain = root.join("x");
        std::fs::write(&plain, b"tracked\n").expect("x");
        for name in ["x.", "x "] {
            // Only a `\\?\` path keeps the final dot or space.
            let verbatim = PathBuf::from(format!(r"\\?\{}", root.join(name).display()));
            std::fs::write(&verbatim, b"untracked\n").expect("verbatim file");
            let expected = file_expected(b"untracked\n", &verbatim);
            let results = recycle(
                &root,
                &[(vec![name.to_string()], root.join(name), expected)],
            );
            println!("OBSERVATION T012: N9 {name:?} gives {results:?}");
            assert!(
                !matches!(results[0], EntryResult::Recycled(_) | EntryResult::Deleted),
                "{name:?}: {results:?}"
            );
            assert_eq!(
                std::fs::read(&verbatim).expect("the untracked file"),
                b"untracked\n"
            );
            assert_eq!(std::fs::read(&plain).expect("x"), b"tracked\n");
            std::fs::remove_file(&verbatim).expect("remove the verbatim file");
        }
    }
}
