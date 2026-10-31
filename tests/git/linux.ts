// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Linux calls of the `bun-runner.ts` test double. Run as a script, the file is a fixture process that records itself and lingers.

import { dlopen, FFIType, ptr } from "bun:ffi";
import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TRUST_DIGEST_FILE_BYTES, TRUST_DIGEST_TOTAL_BYTES } from "../../src/contracts/limits";
import type { FileFact, FileFactsRequest } from "../../src/git-service/git-runner";

const { ptr: P, u32, u64, i32, i64 } = FFIType;
const open = () =>
  dlopen("libc.so.6", { mkfifo: { args: [P, u32], returns: i32 }, ioctl: { args: [i32, u64, P], returns: i32 }, listxattr: { args: [P, P, u64], returns: i64 } }).symbols;
let symbols: ReturnType<typeof open> | undefined;

// `libc.so.6` and `/proc` exist only on Linux. The import of this file must not open or read them (tests/git/portable-imports.test.ts).
function linux(): void {
  if (process.platform !== "linux") throw new Error("tests/git/linux.ts needs Linux");
}

function libc(): ReturnType<typeof open> {
  linux();
  return (symbols ??= open());
}

// One `peekPipe` call keeps at most this many bytes. pipe(7): a writer can change the pipe capacity with F_SETPIPE_SZ.
const PIPE_BYTES = 64 * 1024;
// include/uapi/asm-generic/ioctls.h: FIONREAD is 0x541B. x86-64 and arm64 use the generic value.
const FIONREAD = 0x541b;
const TERMINATE_POLL_MS = 10;
const TERMINATE_WAIT_MS = 5000;
const STREAM_CHUNK_BYTES = 1024 * 1024;

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
  if (!GENERIC_FCNTL_ARCHES.includes(process.arch)) throw new Error(`tests/git/linux.ts has no FIONREAD value for ${process.arch}`);
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

// pipe(7): FIONREAD gives the count of unread bytes in the pipe.
function unread(fd: number): number {
  const count = new Int32Array(1);
  if (libc().ioctl(fd, FIONREAD, ptr(count)) !== 0) throw new Error(`ioctl FIONREAD failed for descriptor ${fd}`);
  return count[0]!;
}

// The bytes that the pipe holds, or null at end-of-file: the kept bytes plus the unread bytes in the pipe.
// One call reads at most 64 KiB and keeps the bytes for `readPipe`.
// Before a writer opens the FIFO, `read` gives a false end-of-file. So call it only after `Bun.spawn` returns.
export function peekPipe(pipe: InboundPipe): number | null {
  if (pipe.end === pipe.start) {
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
  }
  return pipe.end - pipe.start + unread(pipe.fd);
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

// proc(5) fields 4 and 22: the parent PID and the start time in clock ticks after boot. A zombie or a missing process gives null.
function procStat(pid: number): { parent: number; created: bigint } | null {
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
  return fields[0] === "Z" || fields[0] === "X" ? null : { parent: Number(fields[1]), created: BigInt(fields[19]!) };
}

export function processCreationTime(pid: number): bigint | null {
  return procStat(pid)?.created ?? null;
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

export interface ProcessTree {
  // Ends every process of the tree and waits a bounded time for their exits.
  end(): void;
  close(): void;
}

// The shell Job of contract §6, as a walk of the live descendants. Linux moves an orphan to its reaper, so a parent PID is never stale.
// ponytail: an orphan of an ended root, and a child created during the walk, escape. A cgroup per run closes both.
export function ownTree(pid: number): ProcessTree {
  const created = processCreationTime(pid);
  return {
    end() {
      if (created === null || processCreationTime(pid) !== created) return;
      const children = new Map<number, { pid: number; created: bigint }[]>();
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        const stat = procStat(Number(name));
        if (stat) children.set(stat.parent, [...(children.get(stat.parent) ?? []), { pid: Number(name), created: stat.created }]);
      }
      const tree = [{ pid, created }];
      for (let i = 0; i < tree.length; i++) tree.push(...(children.get(tree[i]!.pid) ?? []));
      for (const p of tree) terminateRecorded(p.pid, p.created);
    },
    close() {},
  };
}

// The record name is `<pid>-<start time>`. `bun-runner.ts` counts these records as the live descendants of an operation.
export function recordProcess(directory: string): void {
  writeFileSync(join(directory, `${process.pid}-${processCreationTime(process.pid)}`), "");
}

// POSIX.1-2024 <sys/stat.h>: the owner execute bit is 0100. Git `run-command.c` `is_executable` tests it.
const S_IXUSR = 0o100n;
// include/uapi/asm-generic/fcntl.h: `O_PATH` is 010000000. x86-64 and arm64 use the generic value. Node exports no `O_PATH`.
const O_PATH = 0o10000000;
// This list also guards the FIONREAD ioctl value.
const GENERIC_FCNTL_ARCHES = ["x64", "arm64"];

type FactRoot = FileFactsRequest["files"][number]["root"];
export type FileFactsResult = { facts: FileFact[]; bytesRead: number[] };

// Contract §6 "File facts" `error` codes by POSIX `errno`. A thrown value without an errno is no open result.
function errnoCode(error: unknown): string {
  const { code, errno } = error as NodeJS.ErrnoException;
  if (typeof code !== "string" || typeof errno !== "number") throw error;
  return code;
}

function errorFact(error: unknown, component: number): FileFact {
  const code = errnoCode(error);
  return { kind: "error", component, code: code === "EACCES" ? "access-denied" : code === "EIO" ? "io-error" : "other-error" };
}

// Contract §6 "File facts" `absent`: only the open results ENOENT and ENOTDIR.
function failed(error: unknown, component: number): FileFact {
  const code = errnoCode(error);
  return code === "ENOENT" || code === "ENOTDIR" ? { kind: "absent" } : errorFact(error, component);
}

// POSIX.1-2024 XBD 4.16: a pathname that begins with a slash is absolute. Text that is no well-formed UTF-8 gives tag `other`.
function link(parent: number, name: string, component: number): FileFact {
  let bytes: Buffer;
  try {
    bytes = readlinkSync(`/proc/self/fd/${parent}/${name}`, { encoding: "buffer" });
  } catch (error) {
    return errorFact(error, component);
  }
  let target: string;
  try {
    target = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { kind: "link", component, tag: "other" };
  }
  if (target.includes("\0")) return { kind: "link", component, tag: "other" };
  return { kind: "link", component, tag: "symlink", target, relative: !target.startsWith("/") };
}

// access(2) `X_OK` on the opened object. Only `EACCES` means "not executable".
function executable(fd: number, component: number): { executable: boolean } | FileFact {
  try {
    accessSync(`/proc/self/fd/${fd}`, constants.X_OK);
    return { executable: true };
  } catch (error) {
    return errnoCode(error) === "EACCES" ? { executable: false } : errorFact(error, component);
  }
}

// Reads at most `limit` bytes. `/proc/self/fd/<fd>` reopens the `O_PATH` object itself and resolves no name again.
// `O_NONBLOCK` keeps the open from a wait. Only a regular file comes here.
function readData(fd: number, limit: number): Uint8Array {
  const data = openSync(`/proc/self/fd/${fd}`, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const bytes = new Uint8Array(limit);
    let filled = 0;
    while (filled < limit) {
      const n = readSync(data, bytes, filled, limit - filled, null);
      if (n === 0) break;
      filled += n;
    }
    return bytes.subarray(0, filled);
  } finally {
    closeSync(data);
  }
}

// One fact per entry, in request order (src-tauri/src/file_facts.rs `walk`). `bytesRead` counts the file data bytes of each entry.
// Each component opens relative to its parent descriptor with `O_PATH | O_NOFOLLOW`. That open never follows a link.
// It calls no driver open, so a FIFO, a socket, or a device opens without a wait. `fstat` gives the type.
export function readFileFacts(roots: Record<FactRoot, string>, digest: boolean, files: FileFactsRequest["files"], options: { detail?: boolean; stream?: boolean } = {}): FileFactsResult {
  linux();
  if (!GENERIC_FCNTL_ARCHES.includes(process.arch)) throw new Error(`tests/git/linux.ts has no O_PATH value for ${process.arch}`);
  // The digested bytes that the request can still take. null after the first file that passed the total.
  let budget: number | null = TRUST_DIGEST_TOTAL_BYTES;
  const facts: FileFact[] = [];
  const bytesRead: number[] = [];
  for (const { root, path } of files) {
    const read = { bytes: 0 };
    facts.push(entryFact(roots[root], path, read));
    bytesRead.push(read.bytes);
  }
  return { facts, bytesRead };

  // `component` counts the components of `path` from 1. Component 0 is the root.
  function entryFact(rootPath: string, path: readonly string[], read: { bytes: number }): FileFact {
    const opened: number[] = [];
    try {
      try {
        opened.push(openSync(rootPath, constants.O_RDONLY | constants.O_DIRECTORY));
      } catch (error) {
        return failed(error, 0);
      }
      for (const [index, name] of path.entries()) {
        const component = index + 1;
        const parent = opened.at(-1)!;
        let fd: number;
        try {
          fd = openSync(`/proc/self/fd/${parent}/${name}`, O_PATH | constants.O_NOFOLLOW);
        } catch (error) {
          return failed(error, component);
        }
        opened.push(fd);
        const stat = fstatSync(fd, { bigint: true });
        if (stat.isSymbolicLink()) return link(parent, name, component);
        // A middle component that is no directory makes the next open fail with ENOTDIR.
        if (component < path.length) continue;
        if (stat.isDirectory()) {
          const mode = executable(fd, component);
          return "kind" in mode ? mode : { kind: "directory", ...mode };
        }
        if (!stat.isFile()) return { kind: "other" };
        const mode = executable(fd, component);
        if ("kind" in mode) return mode;
        const size = Number(stat.size);
        let fact: FileFact = { kind: "file", size, lastWrite: stat.mtimeNs.toString(), ...mode, ownerExecute: (stat.mode & S_IXUSR) !== 0n };
        // Feature 008 contract Δ6 `detail`: the WSL facts. `mode` is the full `st_mode` with the file type bits.
        // listxattr(2) with size 0 gives the length of the name list; 0 means no name.
        if (options.detail === true) {
          const names = Number(libc().listxattr(ptr(Buffer.from(`/proc/self/fd/${fd}\0`)), null, 0));
          if (names < 0) return { kind: "error", component, code: "other-error" };
          fact = { ...fact, links: Number(stat.nlink), mode: Number(stat.mode), uid: Number(stat.uid), gid: Number(stat.gid), xattr: names > 0 };
        }
        if (!digest) return fact;
        // Feature 008 contract Δ6 `stream`: the whole file in chunks, without the per-file bound and the request total.
        if (options.stream === true) {
          const hash = createHash("sha256");
          let data: number;
          try {
            data = openSync(`/proc/self/fd/${fd}`, constants.O_RDONLY | constants.O_NONBLOCK);
          } catch (error) {
            return errorFact(error, component);
          }
          try {
            const chunk = new Uint8Array(STREAM_CHUNK_BYTES);
            for (let n = readSync(data, chunk); n > 0; n = readSync(data, chunk)) {
              read.bytes += n;
              hash.update(chunk.subarray(0, n));
            }
          } catch (error) {
            return errorFact(error, component);
          } finally {
            closeSync(data);
          }
          return { ...fact, digest: hash.digest("hex") };
        }
        // Contract §6 "File facts": the per-file bound comes first. Only files within it count toward the request total.
        if (size > TRUST_DIGEST_FILE_BYTES) return { ...fact, bound: "file-bytes" };
        if (budget === null) return { ...fact, bound: "total-bytes" };
        let bytes: Uint8Array;
        try {
          bytes = readData(fd, TRUST_DIGEST_FILE_BYTES + 1);
        } catch (error) {
          return errorFact(error, component);
        }
        read.bytes = bytes.length;
        if (bytes.length > TRUST_DIGEST_FILE_BYTES) return { ...fact, bound: "file-bytes" };
        if (bytes.length > budget) {
          budget = null;
          return { ...fact, bound: "total-bytes" };
        }
        budget -= bytes.length;
        return { ...fact, digest: createHash("sha256").update(bytes).digest("hex") };
      }
      throw new Error("a file-fact entry holds no component");
    } finally {
      for (const fd of opened) closeSync(fd);
    }
  }
}

// Script mode: `bun linux.ts <records> <hold ms> <ready file>`. The process inherits the pipes of its parent and holds them.
if (import.meta.main) {
  const [records, holdMs, ready] = process.argv.slice(2);
  recordProcess(records);
  writeFileSync(ready, "");
  await Bun.sleep(Number(holdMs));
  process.stderr.write("late\n");
}
