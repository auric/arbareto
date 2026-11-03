// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T002: the Windows facts W1 to W11 of research.md R14 through `bun:ffi` on NTFS files below the owned fixture root. `Local: Windows`.
// A fact prints `OBSERVATION T002: <Wn>.<fact> expected=... observed=... match=... os=<build>`. A `match=false` line is a finding for research.md R15, not a failure.
// The replace sequence is the 005 one of `src-tauri/src/file_replace.rs`: a new file beside the target, a write, a flush, and `FileRenameInformationEx` with POSIX semantics.
// SIDs of local accounts print with the machine part replaced, so no OBSERVATION line names this machine.

import { afterAll, describe, expect, test } from "bun:test";
import { dlopen, FFIType, ptr, read, toArrayBuffer, type Pointer } from "bun:ffi";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { obs, observationLine, type Observation } from "../git/fact-runner";
import { fixtureDir, useFixtureRoot } from "../git/fixture-root";

const TASK = "T002";
const CHILD_MS = 30_000;
const FACT_MS = 300_000;

const { ptr: P, u16, u32, i32, i64, u64 } = FFIType;
const open = () => ({
  kernel32: dlopen("kernel32.dll", {
    CreateFileW: { args: [P, u32, u32, P, u32, u32, P], returns: P },
    WriteFile: { args: [P, P, u32, P, P], returns: i32 },
    FlushFileBuffers: { args: [P], returns: i32 },
    CloseHandle: { args: [P], returns: i32 },
    GetLastError: { args: [], returns: u32 },
    SetFileAttributesW: { args: [P, u32], returns: i32 },
    GetFileAttributesW: { args: [P], returns: u32 },
    SetFileInformationByHandle: { args: [P, i32, P, u32], returns: i32 },
    GetFileInformationByHandleEx: { args: [P, i32, P, u32], returns: i32 },
    DeviceIoControl: { args: [P, u32, P, u32, P, u32, P, P], returns: i32 },
    CreateHardLinkW: { args: [P, P, P], returns: i32 },
    GetVolumeInformationByHandleW: { args: [P, P, u32, P, P, P, P, u32], returns: i32 },
    OpenProcess: { args: [u32, i32, u32], returns: P },
    TerminateProcess: { args: [P, u32], returns: i32 },
    GetCurrentProcess: { args: [], returns: i64 },
    LocalFree: { args: [P], returns: P },
  }).symbols,
  advapi32: dlopen("advapi32.dll", {
    GetKernelObjectSecurity: { args: [P, u32, P, u32, P], returns: i32 },
    SetKernelObjectSecurity: { args: [P, u32, P], returns: i32 },
    ConvertSecurityDescriptorToStringSecurityDescriptorW: { args: [P, u32, u32, P, P], returns: i32 },
    GetSecurityDescriptorDacl: { args: [P, P, P, P], returns: i32 },
    GetSecurityDescriptorControl: { args: [P, P, P], returns: i32 },
    SetSecurityDescriptorControl: { args: [P, u16, u16], returns: i32 },
    SetSecurityInfo: { args: [P, u32, u32, P, P, P, P], returns: u32 },
    OpenProcessToken: { args: [i64, u32, P], returns: i32 },
    GetTokenInformation: { args: [P, u32, P, u32, P], returns: i32 },
    ConvertSidToStringSidW: { args: [P, P], returns: i32 },
    RegGetValueW: { args: [u64, P, P, u32, P, P, P], returns: i32 },
    EncryptFileW: { args: [P], returns: i32 },
  }).symbols,
  // The Win32 `SetFileInformationByHandle` rejects a relative rename name with a `RootDirectory`, so the rename uses the NT call, as the shell does.
  ntdll: dlopen("ntdll.dll", {
    NtSetInformationFile: { args: [P, P, P, u32, i32], returns: i32 },
    NtCreateFile: { args: [P, u32, P, P, P, u32, u32, u32, u32, P, u32], returns: i32 },
  }).symbols,
});
type Dlls = ReturnType<typeof open>;
let dlls: Dlls | undefined;
const win = (): Dlls => (dlls ??= open());

// Win32 and NT constants (winnt.h, winbase.h, ntifs.h, ntstatus.h, winioctl.h, winreg.h).
const GENERIC_READ = 0x8000_0000;
const GENERIC_WRITE = 0x4000_0000;
const DELETE = 0x0001_0000;
const READ_CONTROL = 0x0002_0000;
const WRITE_DAC = 0x0004_0000;
const SYNCHRONIZE = 0x0010_0000;
const ACCESS_SYSTEM_SECURITY = 0x0100_0000;
const FILE_READ_DATA = 0x1;
const FILE_WRITE_DATA = 0x2;
const FILE_LIST_DIRECTORY = 0x1;
const FILE_TRAVERSE = 0x20;
const FILE_READ_ATTRIBUTES = 0x80;
const FILE_WRITE_ATTRIBUTES = 0x100;
const SHARE_READ = 1;
const SHARE_WRITE = 2;
const SHARE_DELETE = 4;
const SHARE_ALL = SHARE_READ | SHARE_WRITE | SHARE_DELETE;
const CREATE_NEW = 1;
const CREATE_ALWAYS = 2;
const OPEN_EXISTING = 3;
const FILE_FLAG_BACKUP_SEMANTICS = 0x0200_0000;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x0020_0000;
const FILE_FLAG_DELETE_ON_CLOSE = 0x0400_0000;
const ATTR = { readOnly: 0x1, hidden: 0x2, system: 0x4, archive: 0x20, normal: 0x80, sparse: 0x200, compressed: 0x800, notContentIndexed: 0x2000, encrypted: 0x4000, integrityStream: 0x8000 } as const;
const FileBasicInfo = 0;
const FileStandardInfo = 1;
const FileDispositionInfoEx = 21;
const FileRenameInformationEx = 65;
const FSCTL_SET_COMPRESSION = 0x9c040;
const FSCTL_SET_SPARSE = 0x900c4;
const RENAME_REPLACE_IF_EXISTS = 1;
const RENAME_POSIX_SEMANTICS = 2;
const DISPOSITION_DELETE = 1;
const DISPOSITION_POSIX = 2;
const DISPOSITION_ON_CLOSE = 8;
const OWNER_SI = 1;
const GROUP_SI = 2;
const DACL_SI = 4;
const PROTECTED_DACL_SI = 0x8000_0000;
const UNPROTECTED_DACL_SI = 0x2000_0000;
const SE_DACL_PROTECTED = 0x1000;
const SE_DACL_AUTO_INHERIT_REQ = 0x0100;
const SE_FILE_OBJECT = 1;
const SDDL_REVISION_1 = 1;
const TOKEN_QUERY = 8;
const TokenUser = 1;
const TokenElevation = 20;
const PROCESS_TERMINATE = 1;
const NT_FILE_OPEN = 1;
const NT_FILE_CREATE = 2;
const FILE_DIRECTORY_FILE = 0x1;
const FILE_SYNCHRONOUS_IO_NONALERT = 0x20;
const FILE_NON_DIRECTORY_FILE = 0x40;
const OBJ_CASE_INSENSITIVE = 0x40;
const OBJ_DONT_REPARSE = 0x1000;
const RRF_RT_REG_DWORD = 0x10;
const RRF_RT_ANY = 0xffff;
const HKEY_CURRENT_USER = 0xffff_ffff_8000_0001n;
const HKEY_LOCAL_MACHINE = 0xffff_ffff_8000_0002n;
const ERROR_INSUFFICIENT_BUFFER = 122;

// `INVALID_HANDLE_VALUE` comes back as a bigint, and a null handle as null. A valid handle is a number.
type Handle = Pointer | bigint | null;
const valid = (handle: Handle): handle is Pointer => typeof handle === "number" && handle !== 0;
const hex = (status: number) => `0x${(status >>> 0).toString(16)}`;

const pinned: Uint8Array[] = [];
const pin = (bytes: Uint8Array | Uint16Array | Uint32Array | Int32Array | BigInt64Array | BigUint64Array | Buffer) => {
  pinned.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return ptr(bytes);
};
const wide = (text: string) => new Uint8Array(Buffer.from(`${text}\0`, "utf16le"));
const lastError = () => win().kernel32.GetLastError() as number;

function createFile(path: string, access: number, share: number, disposition: number, flags: number): Handle {
  return win().kernel32.CreateFileW(pin(wide(path)), access, share, null, disposition, flags, null) as Handle;
}
function mustOpen(path: string, access: number, share: number, disposition: number, flags: number): Pointer {
  const h = createFile(path, access, share, disposition, flags);
  if (!valid(h)) throw new Error(`CreateFileW failed with ${lastError()}`);
  return h;
}
const close = (h: Pointer) => void win().kernel32.CloseHandle(h);

function writeAll(h: Pointer, bytes: Uint8Array): boolean {
  if (bytes.length === 0) return win().kernel32.FlushFileBuffers(h) !== 0;
  const written = new Uint32Array(1);
  const ok = win().kernel32.WriteFile(h, pin(bytes), bytes.length, pin(written), null) !== 0;
  return ok && written[0] === bytes.length && win().kernel32.FlushFileBuffers(h) !== 0;
}

// FILE_BASIC_INFO: four LARGE_INTEGER times, then the attributes, padded to 40 bytes.
interface Basic {
  creation: bigint;
  lastWrite: bigint;
  attributes: number;
}
function basic(h: Pointer): Basic {
  const info = new BigInt64Array(5);
  if (win().kernel32.GetFileInformationByHandleEx(h, FileBasicInfo, pin(info), 40) === 0) throw new Error(`FileBasicInfo ${lastError()}`);
  return { creation: info[0]!, lastWrite: info[2]!, attributes: Number(BigInt.asUintN(32, info[4]!)) };
}
function setBasic(h: Pointer, creation: bigint, attributes: number, lastWrite = 0n): boolean {
  const info = new BigInt64Array(5);
  info[0] = creation;
  info[2] = lastWrite;
  new DataView(info.buffer).setUint32(32, attributes, true);
  return win().kernel32.SetFileInformationByHandle(h, FileBasicInfo, pin(info), 40) !== 0;
}
// FILE_STANDARD_INFO: AllocationSize, EndOfFile, NumberOfLinks.
function links(path: string): number {
  const h = mustOpen(path, FILE_READ_ATTRIBUTES, SHARE_ALL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT);
  const info = new BigInt64Array(3);
  const ok = win().kernel32.GetFileInformationByHandleEx(h, FileStandardInfo, pin(info), 24) !== 0;
  close(h);
  if (!ok) throw new Error(`FileStandardInfo ${lastError()}`);
  return Number(BigInt.asUintN(32, info[2]!));
}
function setDisposition(h: Pointer, flags: number): { ok: boolean; error: number } {
  const info = new Uint32Array([flags]);
  const ok = win().kernel32.SetFileInformationByHandle(h, FileDispositionInfoEx, pin(info), 4) !== 0;
  return { ok, error: ok ? 0 : lastError() };
}
function attributesOf(path: string): number {
  return win().kernel32.GetFileAttributesW(pin(wide(path))) as number;
}

// FILE_RENAME_INFORMATION: Flags at 0, RootDirectory at 8, FileNameLength at 16, FileName at 20.
function renameRelative(h: Pointer, parent: Pointer, name: string, replace: boolean): number {
  const units = new Uint8Array(Buffer.from(name, "utf16le"));
  const words = new BigUint64Array(Math.ceil((20 + units.length) / 8));
  const info = new Uint8Array(words.buffer);
  const view = new DataView(words.buffer);
  view.setUint32(0, RENAME_POSIX_SEMANTICS | (replace ? RENAME_REPLACE_IF_EXISTS : 0), true);
  view.setBigUint64(8, BigInt(parent), true);
  view.setUint32(16, units.length, true);
  info.set(units, 20);
  const io = new BigUint64Array(2);
  return win().ntdll.NtSetInformationFile(h, pin(io), pin(info), 20 + units.length, FileRenameInformationEx) as number;
}

// ---- Security descriptors ----

const SID_MACHINE = /S-1-5-21-\d+-\d+-\d+/g;
let userSid: string | undefined;
// Replaces the machine part of each local account SID, and the token user with `<user>`.
const redact = (sddl: string) => sddl.replaceAll(userSid ?? "\0", "<user>").replace(SID_MACHINE, "S-1-5-21-<machine>");

function securityOf(h: Pointer, info: number): Uint8Array {
  const needed = new Uint32Array(1);
  win().advapi32.GetKernelObjectSecurity(h, info, null, 0, pin(needed));
  if (lastError() !== ERROR_INSUFFICIENT_BUFFER && needed[0] === 0) throw new Error(`GetKernelObjectSecurity ${lastError()}`);
  const sd = new Uint8Array(needed[0]!);
  if (win().advapi32.GetKernelObjectSecurity(h, info, pin(sd), sd.length, pin(needed)) === 0) throw new Error(`GetKernelObjectSecurity ${lastError()}`);
  return sd;
}
function sddlOf(sd: Uint8Array, info: number): string {
  const out = new BigUint64Array(1);
  const length = new Uint32Array(1);
  if (win().advapi32.ConvertSecurityDescriptorToStringSecurityDescriptorW(pin(sd), SDDL_REVISION_1, info, pin(out), pin(length)) === 0) throw new Error(`ConvertSecurityDescriptorToStringSecurityDescriptorW ${lastError()}`);
  const p = Number(out[0]!) as Pointer;
  const text = Buffer.from(toArrayBuffer(p, 0, length[0]! * 2)).toString("utf16le").replace(/\0+$/, "");
  win().kernel32.LocalFree(p);
  return text;
}
function controlOf(sd: Uint8Array): number {
  const control = new Uint16Array(1);
  const revision = new Uint32Array(1);
  if (win().advapi32.GetSecurityDescriptorControl(pin(sd), pin(control), pin(revision)) === 0) throw new Error(`GetSecurityDescriptorControl ${lastError()}`);
  return control[0]!;
}
function daclPointer(sd: Uint8Array): Pointer {
  const present = new Int32Array(1);
  const dacl = new BigUint64Array(1);
  const defaulted = new Int32Array(1);
  if (win().advapi32.GetSecurityDescriptorDacl(pin(sd), pin(present), pin(dacl), pin(defaulted)) === 0 || present[0] === 0) throw new Error(`GetSecurityDescriptorDacl ${lastError()}`);
  return Number(dacl[0]!) as Pointer;
}
// The owner, group, and DACL of a path as SDDL.
function sddlAt(path: string): { owner: string; group: string; dacl: string } {
  const h = mustOpen(path, READ_CONTROL, SHARE_ALL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT);
  const text = sddlOf(securityOf(h, OWNER_SI | GROUP_SI | DACL_SI), OWNER_SI | GROUP_SI | DACL_SI);
  close(h);
  const m = /^O:(.*?)G:(.*?)D:(.*)$/.exec(text);
  if (m === null) throw new Error(`SDDL refused: ${text}`);
  return { owner: redact(m[1]!), group: redact(m[2]!), dacl: redact(m[3]!) };
}

function tokenFacts(): { elevated: boolean; user: string } {
  const token = new BigUint64Array(1);
  const process = win().kernel32.GetCurrentProcess() as bigint;
  if (win().advapi32.OpenProcessToken(process, TOKEN_QUERY, pin(token)) === 0) throw new Error(`OpenProcessToken ${lastError()}`);
  const t = Number(token[0]!) as Pointer;
  const elevation = new Uint32Array(1);
  const length = new Uint32Array(1);
  const elevatedOk = win().advapi32.GetTokenInformation(t, TokenElevation, pin(elevation), 4, pin(length)) !== 0;
  const user = new BigUint64Array(64);
  const userOk = win().advapi32.GetTokenInformation(t, TokenUser, pin(user), user.byteLength, pin(length)) !== 0;
  close(t);
  if (!elevatedOk || !userOk) throw new Error(`GetTokenInformation ${lastError()}`);
  // TOKEN_USER: SID_AND_ATTRIBUTES with the SID pointer first.
  const sidText = new BigUint64Array(1);
  if (win().advapi32.ConvertSidToStringSidW(Number(user[0]!) as Pointer, pin(sidText)) === 0) throw new Error(`ConvertSidToStringSidW ${lastError()}`);
  const p = Number(sidText[0]!) as Pointer;
  let text = "";
  for (let at = 0, unit = read.u16(p, 0); unit !== 0; at += 2, unit = read.u16(p, at)) text += String.fromCharCode(unit);
  win().kernel32.LocalFree(p);
  return { elevated: elevation[0] !== 0, user: text };
}

// ---- Registry and host facts ----

function regDword(root: bigint, key: string, value: string): number | { error: number } {
  const data = new Uint32Array(1);
  const size = new Uint32Array([4]);
  const status = win().advapi32.RegGetValueW(root, pin(wide(key)), pin(wide(value)), RRF_RT_REG_DWORD, null, pin(data), pin(size)) as number;
  return status === 0 ? data[0]! : { error: status };
}
function regExists(root: bigint, key: string, value: string): number {
  const size = new Uint32Array(1);
  return win().advapi32.RegGetValueW(root, pin(wide(key)), pin(wide(value)), RRF_RT_ANY, null, null, pin(size)) as number;
}

let hostText: string | undefined;
function host(): string {
  if (hostText !== undefined) return hostText;
  const ubr = regDword(HKEY_LOCAL_MACHINE, "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", "UBR");
  return (hostText = `os=${release()}.${typeof ubr === "number" ? ubr : "unknown"}`);
}
const print = (observations: Observation[]) => {
  expect(observations.length).toBeGreaterThan(0);
  for (const o of observations) console.log(observationLine(TASK, o, host()));
};
const unverified = (fact: string, capability: string) => console.log(`OBSERVATION ${TASK}: unverified ${fact} (missing capability ${capability})`);

function fileSystemOf(dir: string): string {
  const h = mustOpen(dir, FILE_READ_ATTRIBUTES, SHARE_ALL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS);
  const name = new Uint16Array(64);
  const ok = win().kernel32.GetVolumeInformationByHandleW(h, null, 0, null, null, null, pin(name), name.length) !== 0;
  close(h);
  if (!ok) throw new Error(`GetVolumeInformationByHandleW ${lastError()}`);
  return String.fromCharCode(...name.subarray(0, name.indexOf(0)));
}

// ---- The replace sequence ----

interface ReplaceOptions {
  // R8: the attribute set and the creation time through `FileBasicInformation`.
  copyBasic?: boolean;
  // R8: the DACL copy. `kernel` sets DACL only; `kernel-flag` adds the protection flag of the old file; `kernel-auto-inherit` sets
  // `SE_DACL_AUTO_INHERIT_REQ` in the copied descriptor; `set-security-info` uses `SetSecurityInfo`; `set-security-info-if-differs` uses it only when the DACL of the new file differs.
  dacl?: "kernel" | "kernel-flag" | "kernel-auto-inherit" | "set-security-info" | "set-security-info-if-differs";
  // R8: the delete disposition on close, cleared just before the rename.
  deleteOnClose?: boolean;
  // Hold the target as `check` does in `file_replace.rs`.
  holdTarget?: boolean;
  // Run the attribute and DACL copy before the write, in the plan.md D8 order.
  copyFirst?: boolean;
}
interface ReplaceResult {
  step: string;
  status: number;
}

let tempCounter = 0;
function replaceFile(dir: string, name: string, bytes: Uint8Array, options: ReplaceOptions = {}): ReplaceResult {
  const target = join(dir, name);
  const parent = mustOpen(dir, FILE_LIST_DIRECTORY | FILE_TRAVERSE | SYNCHRONIZE, SHARE_ALL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS);
  let held: Handle = null;
  let old: { basic: Basic; sd: Uint8Array | null } | null = null;
  try {
    if (options.holdTarget || options.copyBasic || options.dacl) {
      held = createFile(target, FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE, SHARE_READ | SHARE_DELETE, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT);
      if (!valid(held)) return { step: "check-open", status: lastError() };
      old = { basic: basic(held), sd: options.dacl ? securityOf(held, DACL_SI) : null };
    }
    const tempName = `.arbareto-w${process.pid}-${++tempCounter}.tmp`;
    const access = DELETE | FILE_WRITE_DATA | FILE_WRITE_ATTRIBUTES | READ_CONTROL | WRITE_DAC | SYNCHRONIZE;
    const temp = createFile(join(dir, tempName), access, SHARE_READ, CREATE_NEW, ATTR.normal | (options.deleteOnClose ? FILE_FLAG_DELETE_ON_CLOSE : 0));
    if (!valid(temp)) return { step: "temp-create", status: lastError() };
    let result: ReplaceResult = { step: "renamed", status: 0 };
    const fail = (step: string, status: number) => (result = { step, status });
    const copy = () => {
      if (old !== null && options.copyBasic && !setBasic(temp, old.basic.creation, old.basic.attributes)) fail("basic", lastError());
      else if (old?.sd && options.dacl) copyDacl(temp, old.sd, options.dacl, fail);
    };
    if (options.copyFirst) copy();
    if (result.status === 0 && !writeAll(temp, bytes)) fail("write", lastError());
    if (result.status === 0 && !options.copyFirst) copy();
    if (result.status === 0 && options.deleteOnClose) {
      const cleared = setDisposition(temp, DISPOSITION_ON_CLOSE);
      if (!cleared.ok) fail("clear", cleared.error);
    }
    if (result.status === 0) {
      const status = renameRelative(temp, parent, name, true);
      if (status !== 0) fail("rename", status);
    }
    if (result.status !== 0) setDisposition(temp, DISPOSITION_DELETE | DISPOSITION_POSIX);
    close(temp);
    return result;
  } finally {
    if (valid(held)) close(held);
    close(parent);
  }
}

// R8: the DACL copy of `ReplaceOptions.dacl` from the old descriptor `sd` to the handle `temp`.
function copyDacl(temp: Pointer, sd: Uint8Array, method: NonNullable<ReplaceOptions["dacl"]>, fail: (step: string, status: number) => void): void {
  const flag = (controlOf(sd) & SE_DACL_PROTECTED) !== 0 ? PROTECTED_DACL_SI : UNPROTECTED_DACL_SI;
  const differs = () => sddlOf(securityOf(temp, DACL_SI), DACL_SI) !== sddlOf(sd, DACL_SI);
  if (method === "set-security-info" || (method === "set-security-info-if-differs" && differs())) {
    const status = win().advapi32.SetSecurityInfo(temp, SE_FILE_OBJECT, DACL_SI | flag, null, null, daclPointer(sd), null) as number;
    if (status !== 0) fail("set-security-info", status);
  } else if (method === "kernel-auto-inherit") {
    const copy = sd.slice();
    if (win().advapi32.SetSecurityDescriptorControl(pin(copy), SE_DACL_AUTO_INHERIT_REQ, SE_DACL_AUTO_INHERIT_REQ) === 0) fail("control", lastError());
    else if (win().advapi32.SetKernelObjectSecurity(temp, DACL_SI, pin(copy)) === 0) fail("kernel-auto-inherit", lastError());
  } else if (method !== "set-security-info-if-differs" && win().advapi32.SetKernelObjectSecurity(temp, DACL_SI | (method === "kernel-flag" ? flag : 0), pin(sd)) === 0) fail(method, lastError());
}

// ---- Child processes for W6 and W8 ----

const CHILD = String.raw`
import { dlopen, FFIType, ptr } from "bun:ffi";
const { ptr: P, u32, i32, u64 } = FFIType;
const k = dlopen("kernel32.dll", {
  CreateFileW: { args: [P, u32, u32, P, u32, u32, P], returns: P },
  WriteFile: { args: [P, P, u32, P, P], returns: i32 },
  SetFileInformationByHandle: { args: [P, i32, P, u32], returns: i32 },
  CreateFileMappingW: { args: [P, P, u32, u32, u32, P], returns: P },
  MapViewOfFile: { args: [P, u32, u32, u32, u64], returns: P },
  GetLastError: { args: [], returns: u32 },
}).symbols;
const keep = [];
const w = (t) => { const b = new Uint8Array(Buffer.from(t + "\0", "utf16le")); keep.push(b); return ptr(b); };
const [mode, path, arg] = process.argv.slice(2);
const ok = (h) => typeof h === "number" && h !== 0;
let h = null;
let detail = "";
if (mode === "w6") {
  h = k.CreateFileW(w(path), 0x10000 | 0x40000000 | 0x100000, 1 | 4, null, 1, 0x80 | 0x04000000, null);
  if (ok(h)) {
    const data = new Uint8Array(Buffer.from("temp\n"));
    keep.push(data);
    const n = new Uint32Array(1);
    k.WriteFile(h, ptr(data), data.length, ptr(n), null);
    if (arg === "clear") {
      const flags = new Uint32Array([8]);
      detail = k.SetFileInformationByHandle(h, 21, ptr(flags), 4) !== 0 ? "cleared" : "clear-failed-" + k.GetLastError();
    }
  }
} else if (mode === "w8") {
  const [access, share] = arg === "write-read" ? [0x40000000, 1] : arg === "no-delete-share" ? [0x80000000, 1 | 2] : [0x80000000, 1 | 2 | 4];
  h = k.CreateFileW(w(path), access, share, null, 3, 0x80, null);
  if (ok(h) && arg === "section") {
    const map = k.CreateFileMappingW(h, null, 2, 0, 0, null);
    const view = ok(map) ? k.MapViewOfFile(map, 4, 0, 0, 0) : null;
    detail = ok(view) ? "mapped" : "map-failed-" + k.GetLastError();
  }
}
console.log("READY " + (ok(h) ? "held" : "open-failed-" + k.GetLastError()) + " " + detail);
await Bun.sleep(60_000);
`;

let childScript: string | undefined;
// Starts the child, waits for its READY line, runs `during`, then ends the child by `TerminateProcess`.
async function withChild<T>(args: string[], during: (ready: string) => T): Promise<T> {
  childScript ??= (() => {
    const path = join(fixtureDir("revert-w-child"), "child.ts");
    writeFileSync(path, CHILD);
    return path;
  })();
  const proc = Bun.spawn([process.execPath, childScript, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  try {
    const reader = proc.stdout.getReader();
    const deadline = Date.now() + CHILD_MS;
    let text = "";
    while (!/^READY .*$/m.test(text)) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no READY line within ${CHILD_MS} ms: ${JSON.stringify(text)}`);
      const chunk = await Promise.race([reader.read(), Bun.sleep(left).then(() => null)]);
      if (chunk === null) continue;
      if (chunk.done) throw new Error(`child ended before READY: ${JSON.stringify(text)} ${await new Response(proc.stderr).text()}`);
      text += Buffer.from(chunk.value).toString("utf8");
    }
    reader.releaseLock();
    const result = during(/^READY (.*)$/m.exec(text)![1]!.trim());
    terminate(proc.pid);
    const ended = await Promise.race([proc.exited.then(() => true), Bun.sleep(CHILD_MS).then(() => false)]);
    if (!ended) throw new Error(`child ${proc.pid} did not end within ${CHILD_MS} ms`);
    return result;
  } finally {
    proc.kill();
  }
}
function terminate(pid: number): void {
  const h = win().kernel32.OpenProcess(PROCESS_TERMINATE, 0, pid) as Handle;
  if (!valid(h)) throw new Error(`OpenProcess ${pid} ${lastError()}`);
  const ok = win().kernel32.TerminateProcess(h, 1) !== 0;
  close(h);
  if (!ok) throw new Error(`TerminateProcess ${pid} ${lastError()}`);
}

// ---- NT relative creates for W10 ----

interface NtResult {
  status: number;
  handle: Pointer | null;
}
function ntCreate(parent: Pointer, name: string, disposition: number, options: number, access: number): NtResult {
  const units = new Uint8Array(Buffer.from(name, "utf16le"));
  // UNICODE_STRING: Length, MaximumLength, then the buffer pointer at 8.
  const unicode = new BigUint64Array(2);
  const uview = new DataView(unicode.buffer);
  uview.setUint16(0, units.length, true);
  uview.setUint16(2, units.length, true);
  uview.setBigUint64(8, BigInt(pin(units)), true);
  // OBJECT_ATTRIBUTES: Length, RootDirectory at 8, ObjectName at 16, Attributes at 24, then two null pointers.
  const attributes = new BigUint64Array(6);
  const aview = new DataView(attributes.buffer);
  aview.setUint32(0, 48, true);
  aview.setBigUint64(8, BigInt(parent), true);
  aview.setBigUint64(16, BigInt(pin(unicode)), true);
  aview.setUint32(24, OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE, true);
  const handle = new BigUint64Array(1);
  const io = new BigUint64Array(2);
  const status = win().ntdll.NtCreateFile(pin(handle), access, pin(attributes), pin(io), null, ATTR.normal, SHARE_ALL, disposition, options | FILE_SYNCHRONOUS_IO_NONALERT, null, 0) as number;
  return { status, handle: status === 0 ? (Number(handle[0]!) as Pointer) : null };
}

const NEW = new Uint8Array(Buffer.from("new\n"));
const OLD = "old\n";

describe.skipIf(process.platform !== "win32")("T002 Windows facts W1 to W11 for revert", () => {
  useFixtureRoot();
  afterAll(() => void pinned.splice(0));

  test("host: the file system of the fixture root and the token", () => {
    const dir = fixtureDir("revert-host");
    const token = tokenFacts();
    userSid = token.user;
    print([obs("host.file-system", "NTFS", fileSystemOf(dir)), obs("host.token-elevated", "record", token.elevated, true)]);
  });

  test("W1: attributes after the 005 replace and with the FileBasicInformation copy", () => {
    const dir = fixtureDir("revert-w1");
    const observations: Observation[] = [];
    const cases: [string, number, "attributes" | "compression" | "sparse"][] = [
      ["hidden", ATTR.hidden, "attributes"],
      ["system", ATTR.system, "attributes"],
      ["archive-clear", 0, "attributes"],
      ["not-content-indexed", ATTR.notContentIndexed, "attributes"],
      ["compressed", ATTR.compressed, "compression"],
      ["sparse", ATTR.sparse, "sparse"],
    ];
    const mask = ATTR.hidden | ATTR.system | ATTR.archive | ATTR.notContentIndexed | ATTR.compressed | ATTR.sparse;
    for (const [id, bit, how] of cases) {
      for (const sequence of ["005", "copy", "copy-first"] as const) {
        const name = `${id}-${sequence}.txt`;
        const path = join(dir, name);
        writeFileSync(path, OLD);
        let setOk = true;
        if (how === "attributes") setOk = win().kernel32.SetFileAttributesW(pin(wide(path)), bit === 0 ? ATTR.normal : bit) !== 0;
        else {
          const h = mustOpen(path, GENERIC_READ | GENERIC_WRITE, SHARE_ALL, OPEN_EXISTING, 0);
          const input = how === "compression" ? new Uint16Array([1]) : null;
          const returned = new Uint32Array(1);
          setOk = win().kernel32.DeviceIoControl(h, how === "compression" ? FSCTL_SET_COMPRESSION : FSCTL_SET_SPARSE, input ? pin(input) : null, input ? 2 : 0, null, 0, pin(returned), null) !== 0;
          close(h);
        }
        const before = attributesOf(path) & mask;
        const r = replaceFile(dir, name, NEW, { copyBasic: sequence !== "005", copyFirst: sequence === "copy-first" });
        const after = attributesOf(path) & mask;
        observations.push(obs(`W1.${id}.${sequence}`, { set: true, step: "renamed", attributes: hex(before) }, { set: setOk, step: r.step === "renamed" ? r.step : `${r.step}:${hex(r.status)}`, attributes: hex(after) }));
      }
    }
    print(observations);
  }, FACT_MS);

  test("W2: owner, group, and DACL after the replace, with each DACL copy; the SACL privilege", () => {
    const icacls = (path: string, args: string[]) => {
      const r = Bun.spawnSync(["icacls", path, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      if (r.exitCode !== 0) throw new Error(`icacls ${args.join(" ")} exited ${r.exitCode}`);
    };
    const observations: Observation[] = [];
    // `plain`: the fixture folder as created below the temporary folder. `auto-inherited`: an icacls(1) grant rewrites the folder DACL with
    // inheritable ACEs and `SE_DACL_AUTO_INHERITED`, as a folder of a user worktree usually has.
    const folders: [string, string[] | null][] = [
      ["plain", null],
      ["auto-inherited", ["/grant", "*S-1-5-32-545:(OI)(CI)(RX)"]],
    ];
    const kinds: [string, string[] | null][] = [
      ["inherited-only", null],
      // icacls(1): an explicit read ACE for BUILTIN\Users, and a protected DACL with the inherited ACEs copied as explicit ACEs.
      ["explicit-ace", ["/grant", "*S-1-5-32-545:(R)"]],
      ["protected", ["/inheritance:d"]],
      // NTFS keeps the descriptor of a file renamed in from a folder with another inheritable ACE.
      ["renamed-in", null],
      // The kernel call sets another inheritable ACE on the folder after the file exists, so the ACE reaches no existing file.
      ["folder-ace-after", null],
    ];
    // `AU` (S-1-5-11) is in no other fixture ACE.
    const OTHER = ["/grant", "*S-1-5-11:(OI)(CI)(RX)"];
    const methods: [string, ReplaceOptions][] = [
      ["none", {}],
      ["kernel", { dacl: "kernel" }],
      ["kernel-flag", { dacl: "kernel-flag" }],
      ["kernel-auto-inherit", { dacl: "kernel-auto-inherit" }],
      ["kernel-auto-inherit-first", { dacl: "kernel-auto-inherit", copyFirst: true }],
      ["set-security-info", { dacl: "set-security-info" }],
      ["set-security-info-if-differs", { dacl: "set-security-info-if-differs" }],
    ];
    for (const [folder, folderAcl] of folders) {
      const made = (kind: string, other: boolean) => {
        const dir = fixtureDir(`revert-w2-${folder}-${kind}`);
        if (folderAcl !== null) icacls(dir, folderAcl);
        if (other) icacls(dir, OTHER);
        return dir;
      };
      const source = made("source", true);
      const changed = made("changed", true);
      for (const [kind, fileAcl] of kinds) {
        const dir = made(kind, false);
        for (const [method] of methods) {
          const path = join(dir, `${method}.txt`);
          if (kind === "renamed-in") {
            const from = join(source, `${method}.txt`);
            writeFileSync(from, OLD);
            renameSync(from, path);
          } else writeFileSync(path, OLD);
          if (fileAcl !== null) icacls(path, fileAcl);
        }
        const created = methods.map(([method]) => JSON.stringify(sddlAt(join(dir, `${method}.txt`))));
        if (kind === "folder-ace-after") {
          const from = mustOpen(changed, READ_CONTROL, SHARE_ALL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS);
          const sd = securityOf(from, DACL_SI);
          close(from);
          const to = mustOpen(dir, READ_CONTROL | WRITE_DAC, SHARE_ALL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS);
          const set = win().advapi32.SetKernelObjectSecurity(to, DACL_SI, pin(sd)) !== 0;
          close(to);
          if (!set) throw new Error(`SetKernelObjectSecurity on the folder ${lastError()}`);
        }
        // Per method: `same` when the owner, group, and DACL SDDL equal the old file, else the new DACL SDDL or the failed step.
        const results: Record<string, string | boolean> = {};
        let old = "";
        for (const [i, [method, options]] of methods.entries()) {
          const name = `${method}.txt`;
          const path = join(dir, name);
          const before = sddlAt(path);
          old = before.dacl;
          if (JSON.stringify(before) !== created[i]) results[`${method}-old-changed`] = true;
          const r = replaceFile(dir, name, NEW, options);
          const after = sddlAt(path);
          results[method] = r.step !== "renamed" ? `${r.step}:${hex(r.status)}` : JSON.stringify(after) === JSON.stringify(before) ? "same" : `owner=${after.owner === before.owner} group=${after.group === before.group} D:${after.dacl}`;
        }
        if (kind === "folder-ace-after") {
          const h = mustOpen(dir, READ_CONTROL, SHARE_ALL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS);
          results.folderDacl = redact(sddlOf(securityOf(h, DACL_SI), DACL_SI));
          close(h);
        }
        observations.push(obs(`W2.${folder}.${kind}`, "record", { oldDacl: `D:${old}`, ...results }, true));
      }
    }
    const dir = fixtureDir("revert-w2-plain");
    // The owner of a new file in this run. The elevated-helper case needs a second, elevated process.
    const fresh = join(dir, "fresh.txt");
    writeFileSync(fresh, OLD);
    const token = tokenFacts();
    observations.push(obs("W2.new-file-owner", "record", { elevated: token.elevated, owner: sddlAt(fresh).owner }, true));
    unverified("W2.elevated-created-owner", "elevated-helper");
    // The SACL needs `SeSecurityPrivilege` (Microsoft Learn "SACL Access Right"). winerror.h: ERROR_PRIVILEGE_NOT_HELD is 1314.
    const sacl = createFile(fresh, ACCESS_SYSTEM_SECURITY | READ_CONTROL, SHARE_ALL, OPEN_EXISTING, 0);
    const saclError = valid(sacl) ? 0 : lastError();
    if (valid(sacl)) close(sacl);
    observations.push(obs("W2.sacl-open", 1314, saclError));
    print(observations);
  }, FACT_MS);

  test("W3: the creation time with and without the FileBasicInformation copy; the last write time", () => {
    const dir = fixtureDir("revert-w3");
    const observations: Observation[] = [];
    const maxEntries = regDword(HKEY_LOCAL_MACHINE, "SYSTEM\\CurrentControlSet\\Control\\FileSystem", "MaximumTunnelEntries");
    const maxAge = regDword(HKEY_LOCAL_MACHINE, "SYSTEM\\CurrentControlSet\\Control\\FileSystem", "MaximumTunnelEntryAgeInSeconds");
    // winerror.h: ERROR_FILE_NOT_FOUND (2) means the value is absent, so the file system default applies.
    observations.push(obs("W3.tunnel-registry", "record", { MaximumTunnelEntries: maxEntries, MaximumTunnelEntryAgeInSeconds: maxAge }, true));
    // 2020-01-01T00:00:00Z and 2020-01-02T00:00:00Z as FILETIME.
    const OLD_CREATION = 132_223_104_000_000_000n;
    const OLD_WRITE = 132_223_968_000_000_000n;
    for (const sequence of ["005", "copy", "copy-first"] as const) {
      const name = `c-${sequence}.txt`;
      const path = join(dir, name);
      writeFileSync(path, OLD);
      const h = mustOpen(path, FILE_WRITE_ATTRIBUTES | FILE_READ_ATTRIBUTES, SHARE_ALL, OPEN_EXISTING, 0);
      const setOk = setBasic(h, OLD_CREATION, 0, OLD_WRITE);
      const oldLastWrite = basic(h).lastWrite;
      close(h);
      // The file system time is coarser than `Date.now()`, so the window has 1 s on each side. The old times lie in 2020.
      const start = BigInt(Date.now() - 1000) * 10_000n + 116_444_736_000_000_000n;
      const r = replaceFile(dir, name, NEW, { copyBasic: sequence !== "005", copyFirst: sequence === "copy-first" });
      const end = BigInt(Date.now() + 1000) * 10_000n + 116_444_736_000_000_000n;
      const after = (() => {
        const n = mustOpen(path, FILE_READ_ATTRIBUTES, SHARE_ALL, OPEN_EXISTING, 0);
        const b = basic(n);
        close(n);
        return b;
      })();
      const observed = { set: setOk, step: r.step, keepsOldCreation: after.creation === OLD_CREATION };
      // Without the copy, tunneling decides the creation time, so the probe records it.
      observations.push(sequence === "005" ? obs("W3.creation.005", "record", observed, true) : obs(`W3.creation.${sequence}`, { set: true, step: "renamed", keepsOldCreation: true }, observed));
      observations.push(obs(`W3.last-write-is-write-time.${sequence}`, { oldIs2020: true, recent: true, equalsOld: false }, { oldIs2020: oldLastWrite === OLD_WRITE, recent: after.lastWrite >= start && after.lastWrite <= end, equalsOld: after.lastWrite === oldLastWrite }));
    }
    print(observations);
  }, FACT_MS);

  test("W4: a file with two hard links refuses by its link count; an unchecked replace splits the names", () => {
    const dir = fixtureDir("revert-w4");
    const a = join(dir, "a.txt");
    const b = join(dir, "b.txt");
    writeFileSync(a, OLD);
    const linked = win().kernel32.CreateHardLinkW(pin(wide(b)), pin(wide(a)), null) !== 0;
    const count = links(a);
    const refusedBytes = { a: readFileSync(a, "utf8"), b: readFileSync(b, "utf8") };
    // Without the refusal, the 005 rename replaces one name only.
    const r = replaceFile(dir, "a.txt", NEW);
    print([
      obs("W4.link-count", { linked: true, links: 2, bytes: { a: OLD, b: OLD } }, { linked, links: count, bytes: refusedBytes }),
      obs("W4.unchecked-replace", { step: "renamed", a: "new\n", b: OLD, linksAfter: 1 }, { step: r.step, a: readFileSync(a, "utf8"), b: readFileSync(b, "utf8"), linksAfter: links(a) }),
    ]);
  }, FACT_MS);

  test("W5: the rename over a read-only target fails with its NT status, and the target keeps its bytes", () => {
    const dir = fixtureDir("revert-w5");
    const path = join(dir, "ro.txt");
    writeFileSync(path, OLD);
    win().kernel32.SetFileAttributesW(pin(wide(path)), ATTR.readOnly);
    const r = replaceFile(dir, "ro.txt", NEW);
    const bytes = readFileSync(path, "utf8");
    win().kernel32.SetFileAttributesW(pin(wide(path)), ATTR.normal);
    // ntstatus.h: STATUS_ACCESS_DENIED is 0xc0000022.
    print([obs("W5.read-only-target", { step: "rename", status: "0xc0000022", bytes: OLD }, { step: r.step, status: hex(r.status), bytes }), obs("W5.no-temporary-file", [], readdirSync(dir).filter((n) => n.startsWith(".arbareto-")))]);
  }, FACT_MS);

  test("W6: the delete disposition on close, its clear, and TerminateProcess before and after the clear", async () => {
    const dir = fixtureDir("revert-w6");
    const observations: Observation[] = [];
    // Control: a handle with the delete disposition on close leaves no file after CloseHandle.
    const control = join(dir, "control.tmp");
    const h = mustOpen(control, DELETE | GENERIC_WRITE | SYNCHRONIZE, SHARE_READ | SHARE_DELETE, CREATE_NEW, ATTR.normal | FILE_FLAG_DELETE_ON_CLOSE);
    writeAll(h, NEW);
    close(h);
    observations.push(obs("W6.control-close-deletes", false, existsSync(control)));
    for (const stage of ["before-clear", "after-clear"] as const) {
      const temp = join(dir, `${stage}.tmp`);
      const ready = await withChild(["w6", temp, stage === "after-clear" ? "clear" : "keep"], (line) => line);
      observations.push(obs(`W6.terminate-${stage}`, { ready: stage === "after-clear" ? "held cleared" : "held", exists: stage === "after-clear" }, { ready, exists: existsSync(temp) }));
    }
    const target = join(dir, "target.txt");
    writeFileSync(target, OLD);
    const r = replaceFile(dir, "target.txt", NEW, { deleteOnClose: true });
    observations.push(obs("W6.rename-after-clear", { step: "renamed", bytes: "new\n", temps: [] }, { step: r.step === "renamed" ? r.step : `${r.step}:${hex(r.status)}`, bytes: readFileSync(target, "utf8"), temps: readdirSync(dir).filter((n) => n.startsWith(".arbareto-")) }));
    print(observations);
  }, FACT_MS);

  test("W7: alternate data streams of the old file after the replace", () => {
    const dir = fixtureDir("revert-w7");
    const path = join(dir, "ads.txt");
    writeFileSync(path, OLD);
    const streams = ["Zone.Identifier", "user.stream"];
    for (const s of streams) {
      const h = mustOpen(`${path}:${s}`, GENERIC_WRITE, SHARE_ALL, CREATE_ALWAYS, 0);
      writeAll(h, new Uint8Array(Buffer.from(s === "Zone.Identifier" ? "[ZoneTransfer]\r\nZoneId=3\r\n" : "user\n")));
      close(h);
    }
    const present = (s: string) => {
      const h = createFile(`${path}:${s}`, GENERIC_READ, SHARE_ALL, OPEN_EXISTING, 0);
      if (valid(h)) {
        close(h);
        return "present";
      }
      return `error-${lastError()}`;
    };
    const before = Object.fromEntries(streams.map((s) => [s, present(s)]));
    const r = replaceFile(dir, "ads.txt", NEW);
    // winerror.h: ERROR_FILE_NOT_FOUND is 2.
    print([obs("W7.streams", { before: { "Zone.Identifier": "present", "user.stream": "present" }, step: "renamed", after: { "Zone.Identifier": "error-2", "user.stream": "error-2" } }, { before, step: r.step, after: Object.fromEntries(streams.map((s) => [s, present(s)])) })]);
  }, FACT_MS);

  test("W8: the check open and the rename while another process holds the target", async () => {
    const dir = fixtureDir("revert-w8");
    const observations: Observation[] = [];
    for (const mode of ["write-read", "no-delete-share", "section"] as const) {
      const name = `${mode}.txt`;
      const path = join(dir, name);
      writeFileSync(path, OLD);
      const result = await withChild(["w8", path, mode], (ready) => {
        const check = createFile(path, FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE, SHARE_READ | SHARE_DELETE, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT);
        const checkError = valid(check) ? 0 : lastError();
        if (valid(check)) close(check);
        const r = replaceFile(dir, name, NEW);
        return { ready, checkError, step: r.step, status: hex(r.status) };
      });
      observations.push(obs(`W8.${mode}`, "record", { ...result, bytes: readFileSync(path, "utf8") }, true));
    }
    print(observations);
  }, FACT_MS);

  test("W9: 1,000 replaces of fresh files with Windows Defender real-time protection on, and the streamed copy throughput", () => {
    const dir = fixtureDir("revert-w9");
    // Get-MpComputerStatus `RealTimeProtectionEnabled` decides the exit code, so no output text is parsed.
    const defender = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "if ((Get-MpComputerStatus).RealTimeProtectionEnabled) { exit 10 } else { exit 11 }"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 60_000 });
    const realTime = defender.exitCode === 10 ? "on" : defender.exitCode === 11 ? "off" : `unknown-${defender.exitCode}`;
    const failures: string[] = [];
    const started = performance.now();
    for (let i = 0; i < 1000; i++) {
      const name = `f${i}.txt`;
      writeFileSync(join(dir, name), `old ${i}\n`);
      const r = replaceFile(dir, name, new Uint8Array(Buffer.from(`new ${i}\n`)));
      if (r.step !== "renamed") failures.push(`${i}:${r.step}:${hex(r.status)}`);
    }
    const ms = performance.now() - started;
    const wrong = readdirSync(dir).filter((n) => n.startsWith("f") && readFileSync(join(dir, n), "utf8") !== `new ${n.slice(1, -4)}\n`);
    // A streamed copy with SHA-256 in 1 MiB chunks, as plan.md D8 copies Git's temporary file.
    const MIB = 1024 * 1024;
    const source = join(dir, "source.bin");
    writeFileSync(source, Buffer.alloc(256 * MIB, 0x5a));
    const fd = openSync(source, "r");
    const copy = mustOpen(join(dir, "copy.bin"), GENERIC_WRITE, SHARE_READ, CREATE_NEW, ATTR.normal);
    const hasher = new Bun.CryptoHasher("sha256");
    const buffer = Buffer.alloc(MIB);
    const written = new Uint32Array(1);
    const copyStart = performance.now();
    let copied = 0;
    for (let n = readSync(fd, buffer); n > 0; n = readSync(fd, buffer)) {
      hasher.update(buffer.subarray(0, n));
      if (win().kernel32.WriteFile(copy, pin(buffer), n, pin(written), null) === 0 || written[0] !== n) throw new Error(`copy write ${lastError()}`);
      copied += n;
    }
    const flushed = win().kernel32.FlushFileBuffers(copy) !== 0;
    const copyMs = performance.now() - copyStart;
    close(copy);
    closeSync(fd);
    hasher.digest("hex");
    // research.md R11: the deadline rule assumes at least 64 MiB/s of local disk throughput.
    const mibps = copied / MIB / (copyMs / 1000);
    print([
      obs("W9.defender-real-time", "on", realTime),
      obs("W9.replaces", { failures: [], wrongBytes: [] }, { failures, wrongBytes: wrong }),
      obs("W9.replace-time", "record", { count: 1000, totalMs: Math.round(ms), perReplaceMs: Number((ms / 1000).toFixed(2)) }, true),
      obs("W9.streamed-copy-at-least-64-MiBps", { flushed: true, atLeast: true }, { flushed, atLeast: mibps >= 64 }),
      obs("W9.streamed-copy-time", "record", { MiB: copied / MIB, ms: Math.round(copyMs), MiBps: Number(mibps.toFixed(1)) }, true),
    ]);
  }, FACT_MS);

  test("W10: a missing folder chain below the held parent; a reparse point at a folder name refuses", () => {
    const dir = fixtureDir("revert-w10");
    const parent = mustOpen(dir, FILE_LIST_DIRECTORY | FILE_TRAVERSE | SYNCHRONIZE, SHARE_ALL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS);
    const folderAccess = FILE_LIST_DIRECTORY | FILE_TRAVERSE | SYNCHRONIZE;
    const a = ntCreate(parent, "a", NT_FILE_CREATE, FILE_DIRECTORY_FILE, folderAccess);
    const b = a.handle ? ntCreate(a.handle, "b", NT_FILE_CREATE, FILE_DIRECTORY_FILE, folderAccess) : { status: -1, handle: null };
    const again = ntCreate(parent, "a", NT_FILE_CREATE, FILE_DIRECTORY_FILE, folderAccess);
    for (const h of [a.handle, b.handle, again.handle]) if (h) close(h);
    // A junction at a folder name of the path (Microsoft Learn `mklink /J`).
    const outside = fixtureDir("revert-w10-outside");
    const junction = Bun.spawnSync(["cmd", "/d", "/c", "mklink", "/J", join(dir, "j"), outside], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const j = ntCreate(parent, "j", NT_FILE_OPEN, FILE_DIRECTORY_FILE, folderAccess);
    if (j.handle) close(j.handle);
    const jFile = ntCreate(parent, "j\\x.txt", NT_FILE_CREATE, FILE_NON_DIRECTORY_FILE, GENERIC_WRITE | SYNCHRONIZE);
    if (jFile.handle) close(jFile.handle);
    close(parent);
    // ntstatus.h: STATUS_OBJECT_NAME_COLLISION is 0xc0000035, STATUS_REPARSE_POINT_ENCOUNTERED is 0xc000050b.
    print([
      obs("W10.folder-chain", { a: "0x0", b: "0x0", exists: true }, { a: hex(a.status), b: hex(b.status), exists: existsSync(join(dir, "a", "b")) && statSync(join(dir, "a", "b")).isDirectory() }),
      obs("W10.existing-folder-create", "0xc0000035", hex(again.status)),
      obs("W10.junction-at-folder-name", { junction: 0, open: "0xc000050b", create: "0xc000050b", outside: [] }, { junction: junction.exitCode, open: hex(j.status), create: hex(jFile.status), outside: readdirSync(outside) }),
    ]);
  }, FACT_MS);

  test("W11: the encrypted attribute of an EFS file through FileBasicInformation", () => {
    // EncryptFileW creates an EFS key for the user when none exists. The probe runs only with an existing key, so it changes no user certificate store.
    const key = regExists(HKEY_CURRENT_USER, "Software\\Microsoft\\Windows NT\\CurrentVersion\\EFS\\CurrentKeys", "CertificateHash");
    if (key !== 0) {
      unverified(`W11.encrypted-attribute (no EFS key of the user, RegGetValueW ${key})`, "efs");
      return;
    }
    const dir = fixtureDir("revert-w11");
    const path = join(dir, "efs.txt");
    writeFileSync(path, OLD);
    const encrypted = win().advapi32.EncryptFileW(pin(wide(path))) !== 0;
    if (!encrypted) {
      unverified(`W11.encrypted-attribute (EncryptFileW ${lastError()})`, "efs");
      return;
    }
    const h = mustOpen(path, FILE_READ_ATTRIBUTES, SHARE_ALL, OPEN_EXISTING, 0);
    const attrs = basic(h).attributes;
    close(h);
    print([obs("W11.encrypted-attribute", true, (attrs & ATTR.encrypted) !== 0)]);
  }, FACT_MS);
});
