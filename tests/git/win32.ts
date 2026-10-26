// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Win32 calls of the `bun-runner.ts` test double. Run as a script, the file is a fixture process that records itself and lingers.

import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { TRUST_DIGEST_FILE_BYTES, TRUST_DIGEST_TOTAL_BYTES } from "../../src/contracts/limits";
import type { FileFact, FileFactsRequest } from "../../src/git-service/git-runner";

const { ptr: P, u32, i32 } = FFIType;
const open = () =>
  dlopen("kernel32.dll", {
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
    GetExitCodeProcess: { args: [P, P], returns: i32 },
    SetFileTime: { args: [P, P, P, P], returns: i32 },
    GetLastError: { args: [], returns: u32 },
    CreateJobObjectW: { args: [P, P], returns: P },
    AssignProcessToJobObject: { args: [P, P], returns: i32 },
    TerminateJobObject: { args: [P, u32], returns: i32 },
    QueryInformationJobObject: { args: [P, i32, P, u32, P], returns: i32 },
    SetInformationJobObject: { args: [P, i32, P, u32], returns: i32 },
    IsProcessInJob: { args: [P, P, P], returns: i32 },
    WaitForMultipleObjects: { args: [u32, P, i32, u32], returns: u32 },
    CreateProcessW: { args: [P, P, P, P, i32, u32, P, P, P, P], returns: i32 },
    ResumeThread: { args: [P], returns: u32 },
    CompareStringOrdinal: { args: [P, i32, P, i32, i32], returns: i32 },
  }).symbols;
let symbols: ReturnType<typeof open> | undefined;

// `kernel32.dll` exists only on Windows, so the import of this file must not open it (tests/git/portable-imports.test.ts).
function kernel32(): ReturnType<typeof open> {
  if (process.platform !== "win32") throw new Error("tests/git/win32.ts needs Windows");
  return (symbols ??= open());
}

// Microsoft Learn constants of `CreateNamedPipeW`, `CreateFileW`, `OpenProcess`, `WaitForSingleObject`, and `GetExitCodeProcess`.
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
const PROCESS_SET_QUOTA = 0x100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x0010_0000;
const WAIT_TIMEOUT = 0x102;
const STILL_ACTIVE = 259;
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
  const handle = kernel32().CreateNamedPipeW(wide(name), PIPE_ACCESS_INBOUND, PIPE_REJECT_REMOTE_CLIENTS, 1, bufferBytes, bufferBytes, 0, null);
  if (!valid(handle)) throw new Error(`CreateNamedPipeW failed for ${name}`);
  return { name, handle };
}

// The bytes that the pipe holds, or null at end-of-file.
export function peekPipe(pipe: InboundPipe): number | null {
  const available = new Uint32Array(1);
  return kernel32().PeekNamedPipe(pipe.handle, null, 0, null, ptr(available), null) ? available[0] : null;
}

// Reads at most `buffer.length` bytes. The caller reads only bytes that `peekPipe` reported, so the call never blocks.
export function readPipe(pipe: InboundPipe, buffer: Uint8Array): number {
  const read = new Uint32Array(1);
  return kernel32().ReadFile(pipe.handle, ptr(buffer), buffer.length, ptr(read), null) ? read[0] : 0;
}

export function closePipe(pipe: InboundPipe): void {
  kernel32().CloseHandle(pipe.handle);
}

export type FileIdentity = { volumeSerial: string; fileId: string } | { code: "UNSUPPORTED_REPOSITORY"; reason?: "absent" };

// Microsoft Learn "System Error Codes (0-499)": the two not-found results of `CreateFileW`.
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;

// Contract §6 "Process fields": `FILE_ID_INFO` read through a handle with `FILE_READ_ATTRIBUTES`, full sharing, and `FILE_FLAG_BACKUP_SEMANTICS`.
// Only a not-found open gives `reason` `absent`. `GetLastError` must run right after `CreateFileW`.
export function readIdentity(path: string, fileIdOverride?: Uint8Array): FileIdentity {
  const refused = { code: "UNSUPPORTED_REPOSITORY" } as const;
  const handle = kernel32().CreateFileW(wide(path), FILE_READ_ATTRIBUTES, FILE_SHARE_ALL, null, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, null);
  if (!valid(handle)) {
    const error = kernel32().GetLastError();
    return error === ERROR_FILE_NOT_FOUND || error === ERROR_PATH_NOT_FOUND ? { ...refused, reason: "absent" } : refused;
  }
  try {
    const info = new Uint8Array(FILE_ID_INFO_BYTES);
    if (!kernel32().GetFileInformationByHandleEx(handle, FILE_ID_INFO_CLASS, ptr(info), FILE_ID_INFO_BYTES)) return refused;
    const fileId = fileIdOverride ?? info.subarray(8);
    // MS-FSCC: the all-zero and the all-ones file ID name no file (research R2).
    if (fileId.every((b) => b === 0) || fileId.every((b) => b === 0xff)) return refused;
    const volumeSerial = new DataView(info.buffer).getBigUint64(0, true).toString(16).padStart(16, "0");
    return { volumeSerial, fileId: fileId.toHex() };
  } finally {
    kernel32().CloseHandle(handle);
  }
}

// `FILETIME` counts 100 ns intervals from 1601-01-01 UTC.
const FILETIME_UNIX_OFFSET_SECONDS = 11_644_473_600n;

// Sets the creation and last-write times. Git for Windows stores them as the index `ctime` and `mtime`.
export function setFileTimes(path: string, unixSeconds: number): void {
  const handle = kernel32().CreateFileW(wide(path), FILE_WRITE_ATTRIBUTES, FILE_SHARE_ALL, null, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, null);
  if (!valid(handle)) throw new Error(`CreateFileW failed for ${path}`);
  try {
    const time = new BigUint64Array([(BigInt(unixSeconds) + FILETIME_UNIX_OFFSET_SECONDS) * 10_000_000n]);
    if (!kernel32().SetFileTime(handle, ptr(time), null, ptr(time))) throw new Error(`SetFileTime failed for ${path}`);
  } finally {
    kernel32().CloseHandle(handle);
  }
}

function openProcess(pid: number, access: number): Pointer | null {
  const handle = kernel32().OpenProcess(access | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid);
  return valid(handle) ? handle : null;
}

function exitCode(handle: Pointer): number | null {
  const code = new Uint32Array(1);
  return kernel32().GetExitCodeProcess(handle, ptr(code)) ? code[0]! : null;
}

// The `FILETIME` of the process start, or null when no live process has this PID.
function creationTime(handle: Pointer): bigint | null {
  const times = new BigUint64Array(4);
  if (!kernel32().GetProcessTimes(handle, ptr(times), ptr(times, 8), ptr(times, 16), ptr(times, 24))) return null;
  return kernel32().WaitForSingleObject(handle, 0) === WAIT_TIMEOUT ? times[0] : null;
}

export function processCreationTime(pid: number): bigint | null {
  const handle = openProcess(pid, 0);
  if (!handle) return null;
  try {
    return creationTime(handle);
  } finally {
    kernel32().CloseHandle(handle);
  }
}

// Ends the process only when its creation time still matches, so a reused PID is never ended.
export function terminateRecorded(pid: number, created: bigint): boolean {
  const handle = openProcess(pid, PROCESS_TERMINATE);
  if (!handle) return false;
  try {
    if (creationTime(handle) !== created || !kernel32().TerminateProcess(handle, 1)) return false;
    kernel32().WaitForSingleObject(handle, TERMINATE_WAIT_MS);
    return true;
  } finally {
    kernel32().CloseHandle(handle);
  }
}

// Microsoft Learn `JOBOBJECTINFOCLASS` and `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION`: `ActiveProcesses` is at byte 40 of 48.
const JOB_ACCOUNTING_CLASS = 1;
const JOB_ACCOUNTING_BYTES = 48;
const JOB_ACTIVE_OFFSET = 40;
const JOB_POLL_MS = 10;
// Microsoft Learn `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`: 144 bytes on x64, `BasicLimitInformation.LimitFlags` at byte 16.
const JOB_EXTENDED_LIMIT_CLASS = 9;
const JOB_EXTENDED_LIMIT_BYTES = 144;
const JOB_LIMIT_FLAGS_OFFSET = 16;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
// Microsoft Learn `JOBOBJECT_BASIC_PROCESS_ID_LIST`: two DWORD counts, then one ULONG_PTR per PID from byte 8 on x64.
const JOB_PID_LIST_CLASS = 3;
const JOB_PID_LIST_OFFSET = 8;
const ERROR_MORE_DATA = 234;
// Microsoft Learn `WaitForMultipleObjects`.
const MAXIMUM_WAIT_OBJECTS = 64;
const WAIT_FAILED = 0xffff_ffff;

export interface ProcessTree {
  // True when the live process `pid` is in the Job (`IsProcessInJob`).
  holds(pid: number): boolean;
  // Ends every process of the tree and waits a bounded time for their exits.
  end(): void;
  // Ends the Job and waits on the process handles of its members until the Job lists none. Returns the PIDs that the Job still lists at the bound.
  endAndWait(timeoutMs: number): number[];
  close(): void;
}

// The shell Job of contract §6 (src-tauri/src/jobs.rs). A process that the root creates joins the Job, also after the root ends.
// By default no `KILL_ON_JOB_CLOSE`: a child that outlives its root lingers until `end`, as a lingering Job does. With `killOnClose`, the close of the last Job handle also ends the tree, so an ended test process leaves no member.
// A root that runs before the assignment can create a child outside the Job. Assign a root from `createSuspended` before its resume.
export function ownTree(pid: number, killOnClose = false): ProcessTree {
  const job = kernel32().CreateJobObjectW(null, null);
  if (!valid(job)) throw new Error(`CreateJobObjectW failed: ${kernel32().GetLastError()}`);
  if (killOnClose) {
    const limits = new Uint8Array(JOB_EXTENDED_LIMIT_BYTES);
    new DataView(limits.buffer).setUint32(JOB_LIMIT_FLAGS_OFFSET, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
    if (!kernel32().SetInformationJobObject(job, JOB_EXTENDED_LIMIT_CLASS, ptr(limits), JOB_EXTENDED_LIMIT_BYTES)) {
      const error = kernel32().GetLastError();
      kernel32().CloseHandle(job);
      throw new Error(`SetInformationJobObject failed: ${error}`);
    }
  }
  const handle = openProcess(pid, PROCESS_SET_QUOTA | PROCESS_TERMINATE);
  const assigned = handle !== null && kernel32().AssignProcessToJobObject(job, handle) !== 0;
  const error = kernel32().GetLastError();
  // A root that already exited has no tree to own. Per Microsoft Learn, `GetExitCodeProcess` returns STILL_ACTIVE until the process terminates, so a root that exits with 259 is refused.
  const code = handle !== null && !assigned ? exitCode(handle) : null;
  const exited = code !== null && code !== STILL_ACTIVE;
  if (handle) kernel32().CloseHandle(handle);
  if (!assigned && !exited) {
    kernel32().CloseHandle(job);
    throw new Error(`AssignProcessToJobObject failed for ${pid}: ${error}`);
  }
  const active = () => {
    const info = new Uint8Array(JOB_ACCOUNTING_BYTES);
    if (!kernel32().QueryInformationJobObject(job, JOB_ACCOUNTING_CLASS, ptr(info), JOB_ACCOUNTING_BYTES, null)) return 0;
    return new DataView(info.buffer).getUint32(JOB_ACTIVE_OFFSET, true);
  };
  const listed = (): number[] => {
    for (let capacity = MAXIMUM_WAIT_OBJECTS; ; ) {
      const info = new BigUint64Array(1 + capacity);
      if (kernel32().QueryInformationJobObject(job, JOB_PID_LIST_CLASS, ptr(info), info.byteLength, null)) {
        const count = new DataView(info.buffer).getUint32(4, true);
        return [...info.subarray(JOB_PID_LIST_OFFSET / 8, JOB_PID_LIST_OFFSET / 8 + count)].map(Number);
      }
      const error = kernel32().GetLastError();
      if (error !== ERROR_MORE_DATA) throw new Error(`QueryInformationJobObject failed: ${error}`);
      capacity = new DataView(info.buffer).getUint32(0, true);
    }
  };
  return {
    holds(pid) {
      const handle = openProcess(pid, 0);
      if (handle === null) return false;
      try {
        const member = new Int32Array(1);
        return kernel32().IsProcessInJob(handle, job, ptr(member)) !== 0 && member[0] !== 0;
      } finally {
        kernel32().CloseHandle(handle);
      }
    },
    end() {
      if (!kernel32().TerminateJobObject(job, 1)) return;
      for (const until = performance.now() + TERMINATE_WAIT_MS; active() > 0 && performance.now() < until; ) Bun.sleepSync(JOB_POLL_MS);
    },
    endAndWait(timeoutMs) {
      if (!kernel32().TerminateJobObject(job, 1)) throw new Error(`TerminateJobObject failed: ${kernel32().GetLastError()}`);
      const until = performance.now() + timeoutMs;
      for (let pids = listed(); pids.length > 0; pids = listed()) {
        const left = until - performance.now();
        if (left <= 0) return pids;
        // A listed PID can name a process that already left, or a newer process. `IsProcessInJob` checks the handle.
        const handles: Pointer[] = [];
        try {
          for (const pid of pids.slice(0, MAXIMUM_WAIT_OBJECTS)) {
            const handle = openProcess(pid, 0);
            if (handle === null) continue;
            const member = new Int32Array(1);
            if (kernel32().IsProcessInJob(handle, job, ptr(member)) && member[0] !== 0) handles.push(handle);
            else kernel32().CloseHandle(handle);
          }
          if (handles.length === 0) {
            Bun.sleepSync(JOB_POLL_MS);
            continue;
          }
          const result = kernel32().WaitForMultipleObjects(handles.length, ptr(new BigUint64Array(handles.map(BigInt))), 1, Math.ceil(left));
          if (result === WAIT_FAILED) throw new Error(`WaitForMultipleObjects failed: ${kernel32().GetLastError()}`);
        } finally {
          for (const handle of handles) kernel32().CloseHandle(handle);
        }
      }
      return [];
    },
    close() {
      kernel32().CloseHandle(job);
    },
  };
}

// Microsoft Learn constants of `CreateProcessW`, `STARTUPINFOW`, `CreateFileW`, and `CompareStringOrdinal`.
const CREATE_SUSPENDED = 0x4;
const CREATE_UNICODE_ENVIRONMENT = 0x400;
const STARTF_USESTDHANDLES = 0x100;
const GENERIC_READ_WRITE = 0xc000_0000;
const CSTR_EQUAL = 2;
const RESUME_FAILED = 0xffff_ffff;
// x64 layouts: `STARTUPINFOW` is 104 bytes with `dwFlags` at 60 and the three standard handles from 80. `PROCESS_INFORMATION` is 24 bytes with `dwProcessId` at 16.
// `SECURITY_ATTRIBUTES` is 24 bytes with `bInheritHandle` at 16.
const STARTUPINFO_BYTES = 104;
const PROCESS_INFORMATION_BYTES = 24;
const SECURITY_ATTRIBUTES_BYTES = 24;
// The `CreateProcessW` command-line limit in UTF-16 units, with the terminating null (src-tauri/src/spawn.rs `COMMAND_LINE_UNITS`).
const COMMAND_LINE_UNITS = 32_767;
const EXIT_POLL_MS = 20;

// The rules of src-tauri/src/spawn.rs `command_line` (Rust std `make_command_line`), which `CommandLineToArgvW` parses back.
export function commandLine(argv: readonly string[]): string {
  const [program, ...args] = argv;
  if (program === undefined || program.includes('"') || program.includes("\0")) throw new Error(`the program name is not valid: ${JSON.stringify(program)}`);
  let line = `"${program}"`;
  for (const arg of args) {
    if (arg.includes("\0")) throw new Error("an argument holds NUL");
    const quote = arg === "" || arg.includes(" ") || arg.includes("\t");
    line += quote ? ' "' : " ";
    let backslashes = 0;
    for (const unit of arg) {
      if (unit === "\\") backslashes++;
      else {
        if (unit === '"') line += "\\".repeat(backslashes + 1);
        backslashes = 0;
      }
      line += unit;
    }
    if (quote) line += `${"\\".repeat(backslashes)}"`;
  }
  if (line.length + 1 > COMMAND_LINE_UNITS) throw new Error("the command line is too long");
  return line;
}

// Microsoft Learn "Changing Environment Variables": the block is sorted by name without case, in Unicode order, not by locale.
function environmentBlock(env: Record<string, string>): Buffer {
  const entries = Object.entries(env);
  for (const [name, value] of entries) if (name === "" || name.slice(1).includes("=") || name.includes("\0") || value.includes("\0")) throw new Error(`the environment entry ${JSON.stringify(name)} is not valid`);
  const names = new Map(entries.map(([name]) => [name, Buffer.from(name, "utf16le")]));
  entries.sort(([a], [b]) => kernel32().CompareStringOrdinal(ptr(names.get(a)!), names.get(a)!.length / 2, ptr(names.get(b)!), names.get(b)!.length / 2, 1) - CSTR_EQUAL);
  keepAlive = names;
  return Buffer.from(`${entries.map(([name, value]) => `${name}=${value}\0`).join("") || "\0"}\0`, "utf16le");
}

export interface SuspendedProcess {
  pid: number;
  // The exit code. Polled, because no Bun API waits on a raw process handle.
  exited: Promise<number>;
  // Starts the primary thread. A failed resume ends the process and throws.
  resume(): void;
  // Ends the process before its resume.
  terminate(): void;
}

// Starts `argv` with no thread running, so the caller can assign a Job first, as src-tauri/src/spawn.rs `create_suspended` does.
// The standard handles are `NUL`, as Bun `stdio: "ignore"` gives. `argv[0]` must be an absolute path: no search runs.
export function createSuspended(argv: readonly string[], cwd: string, env: Record<string, string>): SuspendedProcess {
  if (!isAbsolute(argv[0] ?? "")) throw new Error(`the program is not an absolute path: ${JSON.stringify(argv[0])}`);
  const application = Buffer.from(`${argv[0]}\0`, "utf16le");
  const line = Buffer.from(`${commandLine(argv)}\0`, "utf16le");
  const directory = Buffer.from(`${cwd}\0`, "utf16le");
  const block = environmentBlock(env);
  const security = new Uint8Array(SECURITY_ATTRIBUTES_BYTES);
  new DataView(security.buffer).setUint32(0, SECURITY_ATTRIBUTES_BYTES, true);
  new DataView(security.buffer).setInt32(16, 1, true);
  const nulName = Buffer.from("NUL\0", "utf16le");
  const nul = kernel32().CreateFileW(ptr(nulName), GENERIC_READ_WRITE, FILE_SHARE_ALL, ptr(security), OPEN_EXISTING, 0, null);
  if (!valid(nul)) throw new Error(`CreateFileW failed for NUL: ${kernel32().GetLastError()}`);
  const startup = new Uint8Array(STARTUPINFO_BYTES);
  const view = new DataView(startup.buffer);
  view.setUint32(0, STARTUPINFO_BYTES, true);
  view.setUint32(60, STARTF_USESTDHANDLES, true);
  for (const at of [80, 88, 96]) view.setBigUint64(at, BigInt(nul), true);
  const info = new Uint8Array(PROCESS_INFORMATION_BYTES);
  const created = kernel32().CreateProcessW(ptr(application), ptr(line), null, null, 1, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, ptr(block), ptr(directory), ptr(startup), ptr(info));
  const error = kernel32().GetLastError();
  keepAlive = [application, line, directory, block, security, nulName, startup, info];
  kernel32().CloseHandle(nul);
  if (!created) throw new Error(`CreateProcessW failed for ${argv[0]}: ${error}`);
  const out = new DataView(info.buffer);
  // Null after the exit poll closed the handle, so a later call never reaches a reused handle value.
  let handle: Pointer | null = Number(out.getBigUint64(0, true)) as Pointer;
  let thread: Pointer | null = Number(out.getBigUint64(8, true)) as Pointer;
  const closeThread = () => {
    if (thread !== null) kernel32().CloseHandle(thread);
    thread = null;
  };
  const exited = new Promise<number>((resolve, reject) => {
    const timer = setInterval(() => {
      if (handle === null || kernel32().WaitForSingleObject(handle, 0) === WAIT_TIMEOUT) return;
      clearInterval(timer);
      const code = exitCode(handle);
      closeThread();
      kernel32().CloseHandle(handle);
      handle = null;
      if (code === null) reject(new Error(`GetExitCodeProcess failed: ${kernel32().GetLastError()}`));
      else resolve(code);
    }, EXIT_POLL_MS);
  });
  return {
    pid: out.getUint32(16, true),
    exited,
    resume() {
      if (thread === null || handle === null) throw new Error("the process was already resumed or ended");
      const failed = kernel32().ResumeThread(thread) === RESUME_FAILED;
      const error = kernel32().GetLastError();
      closeThread();
      if (failed) {
        kernel32().TerminateProcess(handle, 1);
        throw new Error(`ResumeThread failed: ${error}`);
      }
    },
    terminate() {
      if (handle !== null) kernel32().TerminateProcess(handle, 1);
    },
  };
}

const openNt = () =>
  dlopen("ntdll.dll", {
    NtOpenFile: { args: [P, u32, P, P, u32, u32], returns: u32 },
    NtQueryInformationFile: { args: [P, P, P, u32, u32], returns: u32 },
    NtReadFile: { args: [P, P, P, P, P, P, u32, P, P], returns: u32 },
    NtFsControlFile: { args: [P, P, P, P, P, u32, P, u32, P, u32], returns: u32 },
  }).symbols;
let ntSymbols: ReturnType<typeof openNt> | undefined;

// As `kernel32()`: the import of this file must not open `ntdll.dll`.
function ntdll(): ReturnType<typeof openNt> {
  if (process.platform !== "win32") throw new Error("tests/git/win32.ts needs Windows");
  return (ntSymbols ??= openNt());
}

// MS-ERREF 2.3.1 NTSTATUS values, as the unsigned 32-bit numbers that the `u32` returns give.
const STATUS_UNSUCCESSFUL = 0xc000_0001;
const STATUS_END_OF_FILE = 0xc000_0011;
const STATUS_ACCESS_DENIED = 0xc000_0022;
const STATUS_OBJECT_NAME_NOT_FOUND = 0xc000_0034;
const STATUS_OBJECT_PATH_NOT_FOUND = 0xc000_003a;
const STATUS_SHARING_VIOLATION = 0xc000_0043;
const STATUS_IO_DEVICE_ERROR = 0xc000_0185;
const STATUS_IO_REPARSE_TAG_NOT_HANDLED = 0xc000_0279;
const STATUS_REPARSE_POINT_ENCOUNTERED = 0xc000_050b;
// `NT_SUCCESS` is false for a warning or an error status.
const failed = (status: number) => status >= 0x8000_0000;
// Contract §6 "File facts": the open results that mark a reparse point.
const REPARSE = new Set([STATUS_REPARSE_POINT_ENCOUNTERED, STATUS_IO_REPARSE_TAG_NOT_HANDLED]);
// Contract §6 "File facts" pairs each of these Win32 errors of the root open with its status. Microsoft Learn "System Error Codes".
const ERROR_ACCESS_DENIED = 5;
const ERROR_SHARING_VIOLATION = 32;
const ERROR_IO_DEVICE = 1117;
const ROOT_STATUS = new Map([
  [ERROR_FILE_NOT_FOUND, STATUS_OBJECT_NAME_NOT_FOUND],
  [ERROR_PATH_NOT_FOUND, STATUS_OBJECT_PATH_NOT_FOUND],
  [ERROR_ACCESS_DENIED, STATUS_ACCESS_DENIED],
  [ERROR_SHARING_VIOLATION, STATUS_SHARING_VIOLATION],
  [ERROR_IO_DEVICE, STATUS_IO_DEVICE_ERROR],
]);

// Microsoft Learn constants of `NtOpenFile`, `FILE_INFORMATION_CLASS`, `FSCTL_GET_REPARSE_POINT`, and "Reparse Point Tags".
const OBJ_CASE_INSENSITIVE = 0x40;
const OBJ_DONT_REPARSE = 0x1000;
const FILE_READ_DATA = 0x1;
const FILE_SYNCHRONOUS_IO_NONALERT = 0x20;
const FILE_OPEN_REPARSE_POINT = 0x0020_0000;
const FILE_BASIC_INFORMATION = 4;
const FILE_STANDARD_INFORMATION = 5;
const FILE_ATTRIBUTE_TAG_INFORMATION = 35;
const FSCTL_GET_REPARSE_POINT = 0x0009_00a8;
const MAXIMUM_REPARSE_DATA_BUFFER_SIZE = 16 * 1024;
const IO_REPARSE_TAG_MOUNT_POINT = 0xa000_0003;
const IO_REPARSE_TAG_SYMLINK = 0xa000_000c;
const SYMLINK_FLAG_RELATIVE = 0x1;
// Bit 29 is the name surrogate bit (`IsReparseTagNameSurrogate`).
const NAME_SURROGATE = 0x2000_0000;
// x64 layouts: `UNICODE_STRING` is 16 bytes, `OBJECT_ATTRIBUTES` 48 bytes, and `IO_STATUS_BLOCK` 16 bytes with `Information` at 8.
const UNICODE_STRING_BYTES = 16;
const OBJECT_ATTRIBUTES_BYTES = 48;

type FactRoot = FileFactsRequest["files"][number]["root"];
type Opened = { handle: Pointer } | { status: number };
let keepAlive: unknown;
// The raw NTSTATUS of the last `error` fact. Test diagnostics only; the contract reply holds no status.
let errorStatus: number | null = null;

// Opens `name` relative to `parent`, as src-tauri/src/file_facts.rs `open` does. An empty name opens the same file again.
// `OBJ_DONT_REPARSE` fails the open at each reparse point that the I/O manager would follow.
function ntOpen(parent: Pointer, name: string, read: boolean, reparsePoint: boolean): Opened {
  const units = Buffer.from(`${name}\0`, "utf16le");
  const objectName = new Uint8Array(UNICODE_STRING_BYTES);
  const nameView = new DataView(objectName.buffer);
  nameView.setUint16(0, name.length * 2, true);
  nameView.setUint16(2, name.length * 2, true);
  nameView.setBigUint64(8, BigInt(ptr(units)), true);
  const attributes = new Uint8Array(OBJECT_ATTRIBUTES_BYTES);
  const view = new DataView(attributes.buffer);
  view.setUint32(0, OBJECT_ATTRIBUTES_BYTES, true);
  view.setBigUint64(8, BigInt(parent), true);
  view.setBigUint64(16, BigInt(ptr(objectName)), true);
  // Win32 file names ignore letter case, and Git opens hooks through Win32.
  view.setUint32(24, OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE, true);
  const handle = new BigUint64Array(1);
  const access = FILE_READ_ATTRIBUTES | SYNCHRONIZE | (read ? FILE_READ_DATA : 0);
  const options = FILE_SYNCHRONOUS_IO_NONALERT | (reparsePoint ? FILE_OPEN_REPARSE_POINT : 0);
  const io = new BigUint64Array(2);
  const status = ntdll().NtOpenFile(ptr(handle), access, ptr(attributes), ptr(io), FILE_SHARE_ALL, options);
  // `ptr()` returns a plain number, and `bun:ffi` does not manage memory (Bun docs "FFI", "Memory management").
  // The call reaches `units` and `objectName` only through raw pointers. A store to module state keeps every buffer reachable until the call returns.
  keepAlive = [units, objectName, attributes, io];
  return failed(status) ? { status } : { handle: Number(handle[0]) as Pointer };
}

function query(handle: Pointer, info: Uint8Array, infoClass: number): number {
  const io = new BigUint64Array(2);
  const status = ntdll().NtQueryInformationFile(handle, ptr(io), ptr(info), info.length, infoClass);
  keepAlive = io;
  return status;
}

// Reads at most `limit` bytes from the current position of a synchronous handle.
function readData(handle: Pointer, limit: number): Uint8Array | { status: number } {
  const bytes = new Uint8Array(limit);
  let filled = 0;
  while (filled < limit) {
    const io = new BigUint64Array(2);
    const status = ntdll().NtReadFile(handle, null, null, null, ptr(io), ptr(bytes, filled), limit - filled, null, null);
    if (status === STATUS_END_OF_FILE || (!failed(status) && io[1] === 0n)) break;
    if (failed(status)) return { status };
    filled += Number(io[1]);
  }
  return bytes.subarray(0, filled);
}

// Contract §6 "File facts": the `error` code of each status.
function errorFact(component: number, status: number): FileFact {
  errorStatus = status;
  const code = status === STATUS_ACCESS_DENIED ? "access-denied" : status === STATUS_SHARING_VIOLATION ? "sharing-violation" : status === STATUS_IO_DEVICE_ERROR ? "io-error" : "other-error";
  return { kind: "error", component, code };
}

// Only `STATUS_OBJECT_NAME_NOT_FOUND` and `STATUS_OBJECT_PATH_NOT_FOUND` mean absent.
function notOpened(status: number, component: number): FileFact {
  return status === STATUS_OBJECT_NAME_NOT_FOUND || status === STATUS_OBJECT_PATH_NOT_FOUND ? { kind: "absent" } : errorFact(component, status);
}

// `SubstituteName` and the relative flag from `REPARSE_DATA_BUFFER` (MS-FSCC 2.1.2.4 and 2.1.2.5).
// Null for data out of bounds, text that is no well-formed UTF-16, or a NUL.
function linkTarget(data: Uint8Array, tag: number): { target: string; relative: boolean } | null {
  if (data.length < 8) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // The 8-byte header holds `ReparseTag` and `ReparseDataLength`.
  const end = 8 + view.getUint16(4, true);
  if (end > data.length || view.getUint32(0, true) !== tag) return null;
  const symlink = tag === IO_REPARSE_TAG_SYMLINK;
  // A symlink holds `Flags` at 16 and its `PathBuffer` at 20. A mount point holds its `PathBuffer` at 16.
  if (end < (symlink ? 20 : 12)) return null;
  const start = (symlink ? 20 : 16) + view.getUint16(8, true);
  const length = view.getUint16(10, true);
  if (start + length > end || length % 2 !== 0) return null;
  let target = "";
  for (let at = start; at < start + length; at += 2) target += String.fromCharCode(view.getUint16(at, true));
  if (!target.isWellFormed() || target.includes("\0")) return null;
  return { target, relative: symlink && (view.getUint32(16, true) & SYMLINK_FLAG_RELATIVE) !== 0 };
}

// A name-surrogate reparse point. Only a symlink or a junction with well-formed text carries `target` and `relative`.
function link(handle: Pointer, tag: number, component: number): FileFact {
  const name = tag === IO_REPARSE_TAG_SYMLINK ? "symlink" : tag === IO_REPARSE_TAG_MOUNT_POINT ? "junction" : null;
  if (name === null) return { kind: "link", component, tag: "other" };
  const data = new Uint8Array(MAXIMUM_REPARSE_DATA_BUFFER_SIZE);
  const io = new BigUint64Array(2);
  const status = ntdll().NtFsControlFile(handle, null, null, null, ptr(io), FSCTL_GET_REPARSE_POINT, null, 0, ptr(data), data.length);
  if (failed(status)) return errorFact(component, status);
  const found = linkTarget(data.subarray(0, Number(io[1])), tag);
  return found === null ? { kind: "link", component, tag: "other" } : { kind: "link", component, tag: name, ...found };
}

// Contract §6 "File facts", by the rules of src-tauri/src/file_facts.rs `walk`. One fact per entry, in request order.
// `bytesRead` counts the file data bytes of each entry. Each component opens relative to its parent handle, so no link below a root is followed.
// `statuses` holds the raw NTSTATUS of each `error` fact, and null for other facts. A root open maps its Win32 error through `ROOT_STATUS`.
export function readFileFacts(roots: Record<FactRoot, string>, digest: boolean, files: FileFactsRequest["files"]): { facts: FileFact[]; bytesRead: number[]; statuses: (number | null)[] } {
  // The digested bytes that the request can still take. Null after the first file that passed the total.
  let budget: number | null = TRUST_DIGEST_TOTAL_BYTES;
  const facts: FileFact[] = [];
  const bytesRead: number[] = [];
  const statuses: (number | null)[] = [];
  for (const { root, path } of files) {
    const opened: Pointer[] = [];
    const read = { bytes: 0 };
    errorStatus = null;
    try {
      facts.push(entryFact(roots[root], path, opened, read));
    } finally {
      for (const handle of opened) kernel32().CloseHandle(handle);
    }
    bytesRead.push(read.bytes);
    statuses.push(facts.at(-1)!.kind === "error" ? errorStatus : null);
  }
  return { facts, bytesRead, statuses };

  // `component` counts the components of `path` from 1. Component 0 is the root, opened as the identity request opens a path.
  function entryFact(rootPath: string, path: readonly string[], opened: Pointer[], read: { bytes: number }): FileFact {
    const root = kernel32().CreateFileW(wide(rootPath), FILE_READ_ATTRIBUTES, FILE_SHARE_ALL, null, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, null);
    if (!valid(root)) return notOpened(ROOT_STATUS.get(kernel32().GetLastError()) ?? STATUS_UNSUCCESSFUL, 0);
    opened.push(root);
    let parent = root;
    for (const [index, name] of path.entries()) {
      const component = index + 1;
      const last = component === path.length;
      const result = ntOpen(parent, name, false, false);
      if ("status" in result) {
        if (REPARSE.has(result.status)) return reparsePoint(parent, name, component, last ? digest : null, opened, read);
        return notOpened(result.status, component);
      }
      opened.push(result.handle);
      if (last) return fileFact(result.handle, component, digest, opened, read);
      parent = result.handle;
    }
    throw new Error("a file-fact entry holds no component");
  }

  // The fact of a final component that the walk opened with attribute access only.
  // With `digest`, a file within the per-file bound is opened again for its data, and the read takes at most the bound plus one byte.
  function fileFact(handle: Pointer, component: number, digest: boolean, opened: Pointer[], read: { bytes: number }): FileFact {
    // `FILE_STANDARD_INFORMATION`: `EndOfFile` at 8, `Directory` at 21. `FILE_BASIC_INFORMATION`: `LastWriteTime` at 16.
    const standard = new Uint8Array(24);
    let status = query(handle, standard, FILE_STANDARD_INFORMATION);
    if (failed(status)) return errorFact(component, status);
    if (standard[21] !== 0) return { kind: "directory" };
    const basic = new Uint8Array(40);
    status = query(handle, basic, FILE_BASIC_INFORMATION);
    if (failed(status)) return errorFact(component, status);
    const size = Number(new DataView(standard.buffer).getBigInt64(8, true));
    const fact: FileFact = { kind: "file", size, lastWrite: new DataView(basic.buffer).getBigInt64(16, true).toString() };
    if (!digest) return fact;
    // Contract §6 "File facts": the per-file bound comes first. Only files within it count toward the request total.
    if (size > TRUST_DIGEST_FILE_BYTES) return { ...fact, bound: "file-bytes" };
    if (budget === null) return { ...fact, bound: "total-bytes" };
    const data = ntOpen(handle, "", true, false);
    if ("status" in data) return errorFact(component, data.status);
    opened.push(data.handle);
    const bytes = readData(data.handle, TRUST_DIGEST_FILE_BYTES + 1);
    if (!(bytes instanceof Uint8Array)) return errorFact(component, bytes.status);
    read.bytes = bytes.length;
    if (bytes.length > TRUST_DIGEST_FILE_BYTES) return { ...fact, bound: "file-bytes" };
    if (bytes.length > budget) {
      budget = null;
      return { ...fact, bound: "total-bytes" };
    }
    budget -= bytes.length;
    return { ...fact, digest: createHash("sha256").update(bytes).digest("hex") };
  }

  // A component whose open stopped at a reparse point. `last` holds `digest` for the final component, and null for a middle one.
  function reparsePoint(parent: Pointer, name: string, component: number, last: boolean | null, opened: Pointer[], read: { bytes: number }): FileFact {
    const result = ntOpen(parent, name, false, true);
    if ("status" in result) return notOpened(result.status, component);
    opened.push(result.handle);
    const info = new Uint8Array(8);
    const status = query(result.handle, info, FILE_ATTRIBUTE_TAG_INFORMATION);
    if (failed(status)) return errorFact(component, status);
    const tag = new DataView(info.buffer).getUint32(4, true);
    if ((tag & NAME_SURROGATE) !== 0) return link(result.handle, tag, component);
    if (last === null) return { kind: "other" };
    const fact = fileFact(result.handle, component, false, opened, read);
    // Logical bytes need an open that follows the reparse point, so a digest is not possible.
    return last && fact.kind === "file" ? errorFact(component, STATUS_REPARSE_POINT_ENCOUNTERED) : fact;
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
