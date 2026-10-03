// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Win32 calls of the `bun-runner.ts` test double. Run as a script, the file is a fixture process that records itself and lingers.

import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const { ptr: P, u32, i32 } = FFIType;
const kernel32 = dlopen("kernel32.dll", {
  CreateNamedPipeW: { args: [P, u32, u32, u32, u32, u32, u32, P], returns: P },
  PeekNamedPipe: { args: [P, P, u32, P, P, P], returns: i32 },
  ReadFile: { args: [P, P, u32, P, P], returns: i32 },
  CloseHandle: { args: [P], returns: i32 },
  CreateFileW: { args: [P, u32, u32, P, u32, u32, P], returns: P },
  GetFileInformationByHandleEx: { args: [P, i32, P, u32], returns: i32 },
  OpenProcess: { args: [u32, i32, u32], returns: P },
  GetProcessTimes: { args: [P, P, P, P, P], returns: i32 },
  TerminateProcess: { args: [P, u32], returns: i32 },
  WaitForSingleObject: { args: [P, u32], returns: u32 },
  SetFileTime: { args: [P, P, P, P], returns: i32 },
}).symbols;

// Microsoft Learn constants of `CreateNamedPipeW`, `CreateFileW`, `OpenProcess`, and `WaitForSingleObject`.
const PIPE_ACCESS_INBOUND = 0x1;
const PIPE_REJECT_REMOTE_CLIENTS = 0x8;
const FILE_READ_ATTRIBUTES = 0x80;
const FILE_WRITE_ATTRIBUTES = 0x100;
const FILE_SHARE_ALL = 0x7;
const OPEN_EXISTING = 3;
const FILE_FLAG_BACKUP_SEMANTICS = 0x0200_0000;
const FILE_ID_INFO_CLASS = 18;
const FILE_ID_INFO_BYTES = 24;
const PROCESS_TERMINATE = 0x1;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x0010_0000;
const WAIT_TIMEOUT = 0x102;
const TERMINATE_WAIT_MS = 5000;

// `INVALID_HANDLE_VALUE` comes back as a bigint, and a null handle as null.
const valid = (handle: unknown): handle is Pointer => typeof handle === "number" && handle !== 0;
const wide = (text: string) => ptr(Buffer.from(`${text}\0`, "utf16le"));

export interface InboundPipe {
  name: string;
  handle: Pointer;
}

// A byte-mode server end. A child writes to the client end that `Bun.file(name)` opens.
export function createInboundPipe(bufferBytes: number): InboundPipe {
  const name = `\\\\.\\pipe\\arbareto-bun-runner-${process.pid}-${crypto.randomUUID()}`;
  const handle = kernel32.CreateNamedPipeW(wide(name), PIPE_ACCESS_INBOUND, PIPE_REJECT_REMOTE_CLIENTS, 1, bufferBytes, bufferBytes, 0, null);
  if (!valid(handle)) throw new Error(`CreateNamedPipeW failed for ${name}`);
  return { name, handle };
}

// The bytes that the pipe holds, or null at end-of-file.
export function peekPipe(pipe: InboundPipe): number | null {
  const available = new Uint32Array(1);
  return kernel32.PeekNamedPipe(pipe.handle, null, 0, null, ptr(available), null) ? available[0] : null;
}

// Reads at most `buffer.length` bytes. The caller reads only bytes that `peekPipe` reported, so the call never blocks.
export function readPipe(pipe: InboundPipe, buffer: Uint8Array): number {
  const read = new Uint32Array(1);
  return kernel32.ReadFile(pipe.handle, ptr(buffer), buffer.length, ptr(read), null) ? read[0] : 0;
}

export function closePipe(pipe: InboundPipe): void {
  kernel32.CloseHandle(pipe.handle);
}

export type FileIdentity = { volumeSerial: string; fileId: string } | { code: "UNSUPPORTED_REPOSITORY" };

// Contract §6 "Process fields": `FILE_ID_INFO` read through a handle with `FILE_READ_ATTRIBUTES`, full sharing, and `FILE_FLAG_BACKUP_SEMANTICS`.
export function readIdentity(path: string, fileIdOverride?: Uint8Array): FileIdentity {
  const refused = { code: "UNSUPPORTED_REPOSITORY" } as const;
  const handle = kernel32.CreateFileW(wide(path), FILE_READ_ATTRIBUTES, FILE_SHARE_ALL, null, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, null);
  if (!valid(handle)) return refused;
  try {
    const info = new Uint8Array(FILE_ID_INFO_BYTES);
    if (!kernel32.GetFileInformationByHandleEx(handle, FILE_ID_INFO_CLASS, ptr(info), FILE_ID_INFO_BYTES)) return refused;
    const fileId = fileIdOverride ?? info.subarray(8);
    // MS-FSCC: the all-zero and the all-ones file ID name no file (research R2).
    if (fileId.every((b) => b === 0) || fileId.every((b) => b === 0xff)) return refused;
    const volumeSerial = new DataView(info.buffer).getBigUint64(0, true).toString(16).padStart(16, "0");
    return { volumeSerial, fileId: fileId.toHex() };
  } finally {
    kernel32.CloseHandle(handle);
  }
}

// `FILETIME` counts 100 ns intervals from 1601-01-01 UTC.
const FILETIME_UNIX_OFFSET_SECONDS = 11_644_473_600n;

// Sets the creation and last-write times. Git for Windows stores them as the index `ctime` and `mtime`.
export function setFileTimes(path: string, unixSeconds: number): void {
  const handle = kernel32.CreateFileW(wide(path), FILE_WRITE_ATTRIBUTES, FILE_SHARE_ALL, null, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, null);
  if (!valid(handle)) throw new Error(`CreateFileW failed for ${path}`);
  try {
    const time = new BigUint64Array([(BigInt(unixSeconds) + FILETIME_UNIX_OFFSET_SECONDS) * 10_000_000n]);
    if (!kernel32.SetFileTime(handle, ptr(time), null, ptr(time))) throw new Error(`SetFileTime failed for ${path}`);
  } finally {
    kernel32.CloseHandle(handle);
  }
}

function openProcess(pid: number, access: number): Pointer | null {
  const handle = kernel32.OpenProcess(access | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid);
  return valid(handle) ? handle : null;
}

// The `FILETIME` of the process start, or null when no live process has this PID.
function creationTime(handle: Pointer): bigint | null {
  const times = new BigUint64Array(4);
  if (!kernel32.GetProcessTimes(handle, ptr(times), ptr(times, 8), ptr(times, 16), ptr(times, 24))) return null;
  return kernel32.WaitForSingleObject(handle, 0) === WAIT_TIMEOUT ? times[0] : null;
}

export function processCreationTime(pid: number): bigint | null {
  const handle = openProcess(pid, 0);
  if (!handle) return null;
  try {
    return creationTime(handle);
  } finally {
    kernel32.CloseHandle(handle);
  }
}

// Ends the process only when its creation time still matches, so a reused PID is never ended.
export function terminateRecorded(pid: number, created: bigint): boolean {
  const handle = openProcess(pid, PROCESS_TERMINATE);
  if (!handle) return false;
  try {
    if (creationTime(handle) !== created || !kernel32.TerminateProcess(handle, 1)) return false;
    kernel32.WaitForSingleObject(handle, TERMINATE_WAIT_MS);
    return true;
  } finally {
    kernel32.CloseHandle(handle);
  }
}

// The record name is `<pid>-<creation time>`. `bun-runner.ts` counts these records as the live descendants of a Job.
export function recordProcess(directory: string): void {
  writeFileSync(join(directory, `${process.pid}-${processCreationTime(process.pid)}`), "");
}

// Script mode: `bun win32.ts <records> <hold ms> <ready file>`. The process inherits the pipes of its parent and holds them.
if (import.meta.main) {
  const [records, holdMs, ready] = process.argv.slice(2);
  recordProcess(records);
  writeFileSync(ready, "");
  await Bun.sleep(Number(holdMs));
  process.stderr.write("late\n");
}
