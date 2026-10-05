// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Linux calls of the `bun-runner.ts` test double. Run as a script, the file is a fixture process that records itself and lingers.

import { dlopen, FFIType } from "bun:ffi";
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { ptr: P, u32, i32 } = FFIType;
const open = () => dlopen("libc.so.6", { mkfifo: { args: [P, u32], returns: i32 } }).symbols;
let symbols: ReturnType<typeof open> | undefined;

// `libc.so.6` and `/proc` exist only on Linux. The import of this file must not open or read them (tests/git/portable-imports.test.ts).
function linux(): void {
  if (process.platform !== "linux") throw new Error("tests/git/linux.ts needs Linux");
}

function libc(): ReturnType<typeof open> {
  linux();
  return (symbols ??= open());
}

// pipe(7): a new pipe holds 16 pages. That is 64 KiB with the 4 KiB pages of x86-64.
const PIPE_BYTES = 64 * 1024;
const TERMINATE_POLL_MS = 10;
const TERMINATE_WAIT_MS = 5000;

export interface InboundPipe {
  name: string;
  // The nonblocking read end, or -1 after `closePipe`.
  fd: number;
  // `peekPipe` reads into `buffer`. `readPipe` takes the bytes from `start` to `end`.
  buffer: Uint8Array;
  start: number;
  end: number;
  ended: boolean;
}

// A FIFO under the fixture root. A child writes to the end that `Bun.file(name)` opens.
// The read end must be open before `Bun.spawn`. Otherwise the child blocks in its open, and `Bun.spawn` hangs in `vfork`.
export function createInboundPipe(bufferBytes: number): InboundPipe {
  if (bufferBytes !== PIPE_BYTES) throw new Error(`tests/git/linux.ts gives only ${PIPE_BYTES}-byte pipes, not ${bufferBytes}`);
  const { FIXTURE_ROOT } = require("./fixture-root") as typeof import("./fixture-root");
  const directory = join(FIXTURE_ROOT, "pipes");
  if (!existsSync(directory)) mkdirSync(directory);
  const name = join(directory, `${process.pid}-${crypto.randomUUID()}`);
  if (libc().mkfifo(Buffer.from(`${name}\0`), 0o600) !== 0) throw new Error(`mkfifo failed for ${name}`);
  try {
    const fd = openSync(name, constants.O_RDONLY | constants.O_NONBLOCK);
    return { name, fd, buffer: new Uint8Array(PIPE_BYTES), start: 0, end: 0, ended: false };
  } catch (error) {
    rmSync(name, { force: true });
    throw error;
  }
}

// The bytes that the pipe holds, or null at end-of-file. One call reads at most 64 KiB and keeps the bytes for `readPipe`.
// Before a writer opens the FIFO, `read` gives a false end-of-file. So call it only after `Bun.spawn` returns.
export function peekPipe(pipe: InboundPipe): number | null {
  if (pipe.end > pipe.start) return pipe.end - pipe.start;
  if (pipe.ended) return null;
  let read: number;
  try {
    read = readSync(pipe.fd, pipe.buffer, 0, PIPE_BYTES, null);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EAGAIN") return 0;
    throw error;
  }
  if (read === 0) {
    pipe.ended = true;
    return null;
  }
  pipe.start = 0;
  pipe.end = read;
  return read;
}

// Takes at most `buffer.length` of the bytes that `peekPipe` kept. The call never reads the FIFO.
export function readPipe(pipe: InboundPipe, buffer: Uint8Array): number {
  const count = Math.min(buffer.length, pipe.end - pipe.start);
  buffer.set(pipe.buffer.subarray(pipe.start, pipe.start + count));
  pipe.start += count;
  return count;
}

// A later `peekPipe` gives null, so a closed descriptor number is never read again.
export function closePipe(pipe: InboundPipe): void {
  if (pipe.fd < 0) return;
  closeSync(pipe.fd);
  pipe.fd = -1;
  pipe.start = pipe.end = 0;
  pipe.ended = true;
  rmSync(pipe.name, { force: true });
}

export type FileIdentity = { volumeSerial: string; fileId: string } | { code: "UNSUPPORTED_REPOSITORY"; reason?: "absent" };

// `dev` and `ino` from `stat`. The 16 identity bytes are `ino` in big-endian order.
// ENOENT and ENOTDIR are the not-found results, as `ERROR_FILE_NOT_FOUND` and `ERROR_PATH_NOT_FOUND` are in `win32.ts`.
export function readIdentity(path: string, fileIdOverride?: Uint8Array): FileIdentity {
  const refused = { code: "UNSUPPORTED_REPOSITORY" } as const;
  let stat;
  try {
    stat = statSync(path, { bigint: true });
  } catch (error) {
    return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") ? { ...refused, reason: "absent" } : refused;
  }
  const fileId = fileIdOverride ?? Buffer.from(stat.ino.toString(16).padStart(32, "0"), "hex");
  // As in `win32.ts`, the all-zero and the all-ones file ID name no file (research R2).
  if (fileId.every((b) => b === 0) || fileId.every((b) => b === 0xff)) return refused;
  return { volumeSerial: stat.dev.toString(16).padStart(16, "0"), fileId: fileId.toHex() };
}

// proc(5) field 22: the start time in clock ticks after boot. A zombie or a missing process gives null.
export function processCreationTime(pid: number): bigint | null {
  linux();
  // `kill` signals a process group or every process for a PID below 1.
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  let line: string;
  try {
    line = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
  // The command name can hold spaces and `)`. So the fields start after the last `)`.
  const last = line.lastIndexOf(")");
  if (last < 0) return null;
  const fields = line.slice(last + 2).split(" ");
  return fields[0] === "Z" || fields[0] === "X" ? null : BigInt(fields[19]!);
}

// Ends the process only when its start time still matches.
// ponytail: the start-time check and the kill are two steps. A PID reused between them can be hit. `pidfd_open` closes this window but needs FFI.
// `kill(pid, 0)` succeeds for a zombie, so only the start time shows the end.
export function terminateRecorded(pid: number, created: bigint): boolean {
  if (processCreationTime(pid) !== created) return false;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return false;
  }
  const deadline = performance.now() + TERMINATE_WAIT_MS;
  while (processCreationTime(pid) === created && performance.now() < deadline) Bun.sleepSync(TERMINATE_POLL_MS);
  return true;
}

// The record name is `<pid>-<start time>`. `bun-runner.ts` counts these records as the live descendants of an operation.
export function recordProcess(directory: string): void {
  writeFileSync(join(directory, `${process.pid}-${processCreationTime(process.pid)}`), "");
}

// Script mode: `bun linux.ts <records> <hold ms> <ready file>`. The process inherits the pipes of its parent and holds them.
if (import.meta.main) {
  const [records, holdMs, ready] = process.argv.slice(2);
  recordProcess(records);
  writeFileSync(ready, "");
  await Bun.sleep(Number(holdMs));
  process.stderr.write("late\n");
}
