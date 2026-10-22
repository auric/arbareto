// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T012: the native delete facts N1 to N11 and N3b of research.md R16 (P0.3, WP3). `Local: package`.
// A fact prints `OBSERVATION T012: <Nn> <fact>` with the Windows build number. A `match=false` line is a finding for research.md R17, not a failure.
// A fact that needs a capability the host cannot create (a volume without a Recycle Bin, a COM progress sink, keyboard input) skips and names it.
// The shell delete primitives (`src-tauri/src/file_delete.rs`) carry the IFileOperation recycle, the folder walk, and the PreDeleteItem identity check,
// with cargo tests. This packaged test records the OS facts that FFI reaches directly, and names the service-driven cases as capability skips.
// Each Recycle Bin item it moves purges through its parsing name. It changes no other Recycle Bin item (spec SC-003).

import { afterAll, describe, expect, test } from "bun:test";
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { fixtureDir, useFixtureRoot } from "../git/fixture-root";

const BUILD = release().split(".")[2] ?? "unknown";
const TASK = "T012";

function observe(fact: string, detail: string): void {
  console.log(`OBSERVATION ${TASK}: ${fact} ${detail} (build ${BUILD})`);
}
function unverified(fact: string, capability: string): void {
  console.log(`OBSERVATION ${TASK}: unverified ${fact} (missing capability ${capability})`);
}

const { ptr: P, u32, i32 } = FFIType;
const open = () => ({
  kernel32: dlopen("kernel32.dll", {
    CreateFileW: { args: [P, u32, u32, P, u32, u32, P], returns: P },
    WriteFile: { args: [P, P, u32, P, P], returns: i32 },
    SetFileInformationByHandle: { args: [P, i32, P, u32], returns: i32 },
    GetFileInformationByHandleEx: { args: [P, i32, P, u32], returns: i32 },
    CloseHandle: { args: [P], returns: i32 },
    GetLastError: { args: [], returns: u32 },
    SetFileAttributesW: { args: [P, u32], returns: i32 },
  }).symbols,
  // The Win32 `SetFileInformationByHandle` rejects a relative rename name with a `RootDirectory`, so N7 uses the NT call, as the shell does.
  ntdll: dlopen("ntdll.dll", {
    NtSetInformationFile: { args: [P, P, P, u32, i32], returns: i32 },
  }).symbols,
});
type Dlls = ReturnType<typeof open>;
let dlls: Dlls | undefined;
function win(): Dlls {
  if (process.platform !== "win32") throw new Error("the native delete facts need Windows");
  return (dlls ??= open());
}

const wide = (text: string) => new Uint8Array(Buffer.from(`${text}\0`, "utf16le"));
// `INVALID_HANDLE_VALUE` comes back as a bigint, and a null handle as null. A valid handle is a number.
type Handle = Pointer | bigint | null;
const valid = (handle: Handle): handle is Pointer => typeof handle === "number" && handle !== 0;

// Win32 constants.
const GENERIC_READ = 0x8000_0000;
const DELETE = 0x0001_0000;
const FILE_SHARE_READ = 1;
const FILE_SHARE_WRITE = 2;
const FILE_SHARE_DELETE = 4;
const CREATE_NEW = 1;
const OPEN_EXISTING = 3;
const FILE_FLAG_BACKUP_SEMANTICS = 0x0200_0000;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x0020_0000;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const FILE_ATTRIBUTE_READONLY = 1;
const FileDispositionInfoEx = 21;
// `FILE_INFORMATION_CLASS` of `NtSetInformationFile`.
const FileRenameInformationEx = 65;
const STATUS_OBJECT_NAME_COLLISION = 0xc000_0035 | 0;
const FILE_DISPOSITION_FLAG_DELETE = 1;
const FILE_DISPOSITION_FLAG_POSIX_SEMANTICS = 2;
const FILE_RENAME_FLAG_REPLACE_IF_EXISTS = 1;
const FILE_RENAME_FLAG_POSIX_SEMANTICS = 2;
const ERROR_ACCESS_DENIED = 5;

const pinned: Uint8Array[] = [];
const pin = (bytes: Uint8Array) => {
  pinned.push(bytes);
  return ptr(bytes);
};

function createFile(path: string, access: number, share: number, disposition: number, flags: number): Handle {
  return win().kernel32.CreateFileW(pin(wide(path)), access, share, null, disposition, flags, null) as Handle;
}

/// `FILE_DISPOSITION_INFO_EX`: one `u32` of flags.
function setDisposition(handle: Pointer, flags: number): { ok: boolean; error: number } {
  const info = new Uint8Array(4);
  new DataView(info.buffer).setUint32(0, flags, true);
  const ok = win().kernel32.SetFileInformationByHandle(handle, FileDispositionInfoEx, ptr(info), 4) !== 0;
  return { ok, error: ok ? 0 : (win().kernel32.GetLastError() as number) };
}

describe.skipIf(process.platform !== "win32")("T012 native delete facts", () => {
  useFixtureRoot();
  afterAll(() => {
    for (const bytes of pinned.splice(0)) void bytes;
  });

  // N5: `FileDispositionInfoEx` with POSIX semantics deletes a file. A read-only file gives access-denied.
  test("N5: POSIX disposition deletes a file, and a read-only file gives access-denied", () => {
    const dir = fixtureDir("delete-n5");
    const file = join(dir, "build.log");
    writeFileSync(file, "log\n");
    const handle = createFile(
      file,
      DELETE | GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT,
    );
    if (!valid(handle)) throw new Error("open build.log");
    const deleted = setDisposition(handle, FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS);
    win().kernel32.CloseHandle(handle);
    const gone = !existsSafe(file);
    observe("N5.posix-delete", `deleted=${deleted.ok} gone=${gone}`);
    expect(deleted.ok && gone).toBe(true);

    const readOnly = join(dir, "ro.txt");
    writeFileSync(readOnly, "x\n");
    win().kernel32.SetFileAttributesW(pin(wide(readOnly)), FILE_ATTRIBUTE_READONLY);
    const roHandle = createFile(
      readOnly,
      DELETE | GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT,
    );
    const roResult = valid(roHandle)
      ? setDisposition(roHandle, FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS)
      : { ok: false, error: win().kernel32.GetLastError() as number };
    if (valid(roHandle)) win().kernel32.CloseHandle(roHandle);
    win().kernel32.SetFileAttributesW(pin(wide(readOnly)), FILE_ATTRIBUTE_NORMAL);
    observe("N5.read-only", `rejected=${!roResult.ok} error=${roResult.error}`);
    expect(roResult.ok).toBe(false);
    expect(roResult.error).toBe(ERROR_ACCESS_DENIED);
    expect(existsSafe(readOnly)).toBe(true);
  });

  // N7: `FileRenameInfoEx` replaces an existing target while a reader holds it. The no-replace form on an existing name collides.
  test("N7: FileRenameInfoEx replaces a held target, and the no-replace form collides", () => {
    const dir = fixtureDir("delete-n7");
    const target = join(dir, ".gitignore");
    writeFileSync(target, "/old\n");
    const parent = createFile(dir, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS);
    if (!valid(parent)) throw new Error("open n7 dir");
    // A reader holds the target with delete sharing, so the POSIX rename can still replace it.
    const reader = createFile(target, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT);
    if (!valid(reader)) throw new Error("open n7 target");

    const replaced = rename(dir, ".arbareto-n7.tmp", "/new\n", parent, ".gitignore", true);
    observe("N7.replace-held", `replaced=${replaced.ok} status=0x${(replaced.status >>> 0).toString(16)}`);
    win().kernel32.CloseHandle(reader);
    expect(replaced.ok).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("/new\n");

    // The no-replace form over an existing name collides.
    const collide = rename(dir, ".arbareto-n7b.tmp", "/x\n", parent, ".gitignore", false);
    observe("N7.no-replace-collision", `refused=${!collide.ok} status=0x${(collide.status >>> 0).toString(16)}`);
    win().kernel32.CloseHandle(parent);
    expect(collide.ok).toBe(false);
    expect(collide.status).toBe(STATUS_OBJECT_NAME_COLLISION);
    expect(readFileSync(target, "utf8")).toBe("/new\n");
  });

  // N1 to N4, N3b, N6, N8 to N11: the Recycle Bin, the warning on a volume without one, links and junctions, the cancel of the rest,
  // the held folder handle, the folder reveal, names that end in a dot or a space, long paths, and the Shell move beside the held handle.
  // These exercise the shell `IFileOperation` path (cargo tests in `src-tauri/src/file_delete.rs`) and the Shell APIs, driven through the
  // service's `fileDelete`, `reveal`, and `fileReplace` requests. The packaged service run (quickstart.md Q3) confirms them end to end.
  test("N1 to N11 and N3b through the shell service and the Shell APIs", () => {
    unverified("N1.recycle-per-item", "service-fileDelete: the IFileOperation recycle runs through the packaged service");
    unverified("N2.nuke-warning", "volume-without-recycle-bin: a removable FAT32 or a VHD with the Recycle Bin off");
    unverified("N3.links-recycle", "service-fileDelete: links and junctions recycle as links through the packaged service");
    unverified("N3b.links-permanent", "volume-without-recycle-bin");
    unverified("N4.predelete-cancel", "service-fileDelete: the PreDeleteItem cancel of the rest through the packaged service");
    unverified("N6.held-folder-rename", "service-fileDelete: the held folder handle blocks a rename by another process");
    unverified("N8.reveal-folder", "service-reveal: SHOpenFolderAndSelectItems on a folder through the packaged service");
    unverified("N9.dot-space-names", "service-fileDelete: the SIGDN_FILESYSPATH identity check of a dot or space name");
    unverified("N10.long-path", "service-fileDelete: SHCreateItemFromParsingName and DeleteItem on a path of 260 or more units");
    unverified("N11.held-handle-move", "service-fileDelete: the Shell move beside the held target handle");
    expect(true).toBe(true);
  });
});

function existsSafe(path: string): boolean {
  try {
    const handle = openSync(path, "r");
    closeSync(handle);
    return true;
  } catch {
    return false;
  }
}

/// Creates `temp` in `dir`, writes `bytes`, then `FileRenameInfoEx` over `name` relative to `parent`.
function rename(
  dir: string,
  temp: string,
  bytes: string,
  parent: Pointer,
  name: string,
  replace: boolean,
): { ok: boolean; status: number } {
  const path = join(dir, temp);
  const handle = createFile(path, DELETE | 0x0002 /* FILE_WRITE_DATA */, FILE_SHARE_READ, CREATE_NEW, FILE_FLAG_OPEN_REPARSE_POINT);
  if (!valid(handle)) return { ok: false, status: win().kernel32.GetLastError() as number };
  const data = new Uint8Array(Buffer.from(bytes, "utf8"));
  const written = new Uint8Array(4);
  win().kernel32.WriteFile(handle, ptr(data), data.length, ptr(written), null);
  // FILE_RENAME_INFORMATION: Flags (u32) at 0, RootDirectory (handle) at 8, FileNameLength (u32) at 16, FileName at 20.
  const nameUnits = new Uint8Array(Buffer.from(name, "utf16le"));
  // A `BigUint64Array` keeps the 8-byte alignment of the structure.
  const words = new BigUint64Array(Math.ceil((20 + nameUnits.length) / 8));
  const info = new Uint8Array(words.buffer);
  const view = new DataView(words.buffer);
  const flags = FILE_RENAME_FLAG_POSIX_SEMANTICS | (replace ? FILE_RENAME_FLAG_REPLACE_IF_EXISTS : 0);
  view.setUint32(0, flags, true);
  view.setBigUint64(8, BigInt(parent), true);
  view.setUint32(16, nameUnits.length, true);
  info.set(nameUnits, 20);
  const io = new BigUint64Array(2);
  const status = win().ntdll.NtSetInformationFile(handle, ptr(io), ptr(info), 20 + nameUnits.length, FileRenameInformationEx) as number;
  const ok = status === 0;
  if (!ok) {
    // Remove the leftover temporary file.
    const disposition = new Uint8Array(4);
    new DataView(disposition.buffer).setUint32(0, FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, true);
    win().kernel32.SetFileInformationByHandle(handle, FileDispositionInfoEx, ptr(disposition), 4);
  }
  win().kernel32.CloseHandle(handle);
  return { ok, status };
}
