// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T006: the peak private bytes of each Git process of the history view on H1M (plan.md P0.4, spec SC-002, FR-043). `Local: Windows`.
// T061: the same peak up to the first-step stop row S₀, and the time to output lines 1, S₀, 500,000, and 1,000,000 (plan.md D2, FR-054).
// The numbers are measurements for research.md R13, R14, and plan.md O-1. They are no pass condition.

import { dlopen, FFIType, ptr } from "bun:ffi";
import { expect } from "bun:test";
import { basename, relative } from "node:path";
import { HISTORY_LOAD_MARGIN } from "../../src/contracts/limits";
import { useFixtureRoot, fixtureEnv, FIXED_TIMESTAMPS, ownedPath } from "../git/fixture-root";
import { describeGit } from "../git/git-binary";
import { H1M, largeCase, largeFixture, MARKER_WORD, startPoints } from "../git/history-fixtures";
import { searchArgs, VIEW } from "../git/history-order-facts";
import { PERF_CACHE_ROOT } from "./perf-fixtures";

// This file imports no `src/` module. `fixture-root.ts` and `history-fixtures.ts` print the ORIGIN lines of the contract files they read.

const TASK = "T006";
const RUNS = 5;
const SAMPLE_MS = 100;
const TIMEOUT_MS = 60 * 60_000;
// Contract Δ3 `loadHistory` and `searchHistory`. The `search` policy adds `LC_ALL=C.UTF-8` to the `read` policy.
const COMMANDS = [
  { name: "topology", args: VIEW, env: {}, rows: H1M.commits },
  {
    name: "search",
    args: searchArgs(MARKER_WORD),
    env: { LC_ALL: "C.UTF-8" },
    // Every 50th large-fixture commit has the marker word (`history-fixtures.ts` `largeMessage`).
    rows: Math.ceil(H1M.commits / 50),
  },
] as const;
// plan.md D2: S₀ = n + 1 + 2·M for n = 40 and M = `HISTORY_LOAD_MARGIN`.
const FIRST_STEP = 40 + 1 + 2 * HISTORY_LOAD_MARGIN;
const MARKS = [1, FIRST_STEP, 500_000, 1_000_000] as const;
const END_WAIT_MS = 10_000;

// Microsoft Learn: OpenProcess, TerminateProcess, WaitForSingleObject, CreateToolhelp32Snapshot, PROCESSENTRY32W, GetProcessTimes, GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS (x64 layout).
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_VM_READ = 0x0010;
const PROCESS_TERMINATE = 0x0001;
const SYNCHRONIZE = 0x0010_0000;
const WAIT_OBJECT_0 = 0;
const TH32CS_SNAPPROCESS = 0x2;
const INVALID_HANDLE_VALUE = 0xffff_ffff_ffff_ffffn;
const ENTRY_BYTES = 568;
const ENTRY_PID = 8;
const ENTRY_PARENT = 32;
const ENTRY_EXE = 44;
const ENTRY_EXE_CHARS = 260;
const COUNTERS_BYTES = 72;
const COUNTERS_PEAK_PAGEFILE = 64;

const { u64, u32, i32, ptr: P } = FFIType;
const open = () => ({
  kernel32: dlopen("kernel32.dll", {
    OpenProcess: { args: [u32, i32, u32], returns: u64 },
    CloseHandle: { args: [u64], returns: i32 },
    CreateToolhelp32Snapshot: { args: [u32, u32], returns: u64 },
    Process32FirstW: { args: [u64, P], returns: i32 },
    Process32NextW: { args: [u64, P], returns: i32 },
    GetProcessTimes: { args: [u64, P, P, P, P], returns: i32 },
    TerminateProcess: { args: [u64, u32], returns: i32 },
    WaitForSingleObject: { args: [u64, u32], returns: u32 },
  }).symbols,
  psapi: dlopen("psapi.dll", { GetProcessMemoryInfo: { args: [u64, P, u32], returns: i32 } }).symbols,
});
let symbols: ReturnType<typeof open> | undefined;
// `kernel32.dll` exists only on Windows, so the import of this file must not open it.
const win = () => (symbols ??= open());

interface Watched {
  pid: number;
  exe: string;
  handle: bigint;
  created: bigint;
  peak: number;
}

function creationTime(handle: bigint): bigint {
  const times = new BigUint64Array(4);
  if (win().kernel32.GetProcessTimes(handle, ptr(times), ptr(times, 8), ptr(times, 16), ptr(times, 24)) === 0) throw new Error("GetProcessTimes failed");
  return times[0]!;
}

function peakPagefile(handle: bigint): number {
  const counters = new Uint8Array(COUNTERS_BYTES);
  const view = new DataView(counters.buffer);
  view.setUint32(0, COUNTERS_BYTES, true);
  if (win().psapi.GetProcessMemoryInfo(handle, ptr(counters), COUNTERS_BYTES) === 0) throw new Error("GetProcessMemoryInfo failed");
  return Number(view.getBigUint64(COUNTERS_PEAK_PAGEFILE, true));
}

function watch(pid: number, exe: string): Watched | null {
  const handle = win().kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ | PROCESS_TERMINATE | SYNCHRONIZE, 0, pid);
  return handle === 0n ? null : { pid, exe, handle, created: creationTime(handle), peak: 0 };
}

// The process records of the snapshot: pid, parent pid, and image name.
function snapshot(): { pid: number; parent: number; exe: string }[] {
  const snap = win().kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap === INVALID_HANDLE_VALUE) throw new Error("CreateToolhelp32Snapshot failed");
  const entry = new Uint8Array(ENTRY_BYTES);
  const view = new DataView(entry.buffer);
  view.setUint32(0, ENTRY_BYTES, true);
  const out: { pid: number; parent: number; exe: string }[] = [];
  try {
    for (let ok = win().kernel32.Process32FirstW(snap, ptr(entry)); ok !== 0; ok = win().kernel32.Process32NextW(snap, ptr(entry))) {
      const name = Buffer.from(entry.buffer, ENTRY_EXE, ENTRY_EXE_CHARS * 2).toString("utf16le");
      out.push({ pid: view.getUint32(ENTRY_PID, true), parent: view.getUint32(ENTRY_PARENT, true), exe: name.slice(0, name.indexOf("\0")) });
    }
  } finally {
    win().kernel32.CloseHandle(snap);
  }
  return out;
}

// Adds each new descendant of a watched process. A child holds its parent's pid and starts after its parent, so a reused pid does not count.
function addChildren(watched: Map<number, Watched>): void {
  for (const record of snapshot()) {
    const parent = watched.get(record.parent);
    if (parent === undefined || watched.has(record.pid)) continue;
    const child = watch(record.pid, record.exe);
    if (child === null) continue;
    if (child.created >= parent.created) watched.set(child.pid, child);
    else win().kernel32.CloseHandle(child.handle);
  }
}

function sample(watched: Map<number, Watched>): void {
  for (const w of watched.values()) w.peak = Math.max(w.peak, peakPagefile(w.handle));
}

// The service closes the Job of the load, and that ends each process of the Job (plan.md D2). TerminateProcess fails on a process that already exited.
function end(watched: Map<number, Watched>): void {
  addChildren(watched);
  const k = win().kernel32;
  for (const w of watched.values()) if (k.TerminateProcess(w.handle, 1) === 0 && k.WaitForSingleObject(w.handle, 0) !== WAIT_OBJECT_0) throw new Error(`TerminateProcess failed for pid ${w.pid}`);
  for (const w of watched.values()) if (k.WaitForSingleObject(w.handle, END_WAIT_MS) !== WAIT_OBJECT_0) throw new Error(`pid ${w.pid} did not exit in ${END_WAIT_MS} ms`);
}

// One run. `stopAt` ends the processes at that output line. `marks` gives the ms from the start to each listed output line. The open handle keeps the counters of an exited process readable, so the last read gives the final peak.
async function measure(git: string, repo: string, args: readonly string[], env: Record<string, string>, input: Buffer, opts: { stopAt?: number; marks?: readonly number[] } = {}): Promise<{ exit: number; rows: number; processes: Watched[]; marks: number[] }> {
  const t0 = performance.now();
  const proc = Bun.spawn([git, ...args], { cwd: ownedPath(PERF_CACHE_ROOT, relative(PERF_CACHE_ROOT, repo)), env: fixtureEnv({ ...FIXED_TIMESTAMPS, ...env }), stdin: input, stdout: "pipe", stderr: "pipe" });
  const root = watch(proc.pid, basename(git));
  if (root === null) throw new Error(`OpenProcess failed for pid ${proc.pid}`);
  const watched = new Map([[root.pid, root]]);
  const timer = setInterval(() => {
    addChildren(watched);
    sample(watched);
  }, SAMPLE_MS);
  let rows = 0;
  const marks: number[] = [];
  try {
    read: for await (const chunk of proc.stdout)
      for (const b of chunk) {
        if (b !== 0x0a) continue;
        rows++;
        if (rows === opts.marks?.[marks.length]) marks.push(performance.now() - t0);
        if (rows === opts.stopAt) {
          end(watched);
          break read;
        }
      }
    const stderr = await new Response(proc.stderr).text();
    const exit = await proc.exited;
    if (rows !== opts.stopAt && exit !== 0) throw new Error(`git ${args.join(" ")} exited ${exit}: ${stderr}`);
    clearInterval(timer);
    sample(watched);
    return { exit, rows, processes: [...watched.values()], marks };
  } finally {
    clearInterval(timer);
    for (const w of watched.values()) win().kernel32.CloseHandle(w.handle);
  }
}

const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const count = (n: number) => n.toLocaleString("en-US");

describeGit("history Git peak memory", (git) => {
  useFixtureRoot();
  if (process.platform !== "win32") {
    console.log(`SKIP ${TASK}: missing capability windows-process-memory (unverified)`);
    return;
  }

  largeCase(TASK, "H1M: peak private bytes of each Git process of the topology and the search commands, with and without a commit-graph", H1M, async () => {
    for (const commitGraph of [false, true]) {
      const f = largeFixture(git, H1M, commitGraph);
      const input = Buffer.from(startPoints(git, PERF_CACHE_ROOT, f.repo).map((s) => `${s}\n`).join(""));
      for (const command of COMMANDS) {
        const label = `H1M ${commitGraph ? "with" : "without"} commit-graph, ${command.name}`;
        const peaks: number[] = [];
        for (let run = 1; run <= RUNS; run++) {
          const m = await measure(git, f.repo, command.args, command.env, input);
          expect({ label, rows: m.rows }).toEqual({ label, rows: command.rows });
          expect(m.processes.every((p) => p.peak > 0)).toBe(true);
          const peak = Math.max(...m.processes.map((p) => p.peak));
          peaks.push(peak);
          console.log(`OBSERVATION ${TASK}: ${label}, run ${run}: ${m.processes.map((p) => `${p.exe} pid ${p.pid} peak ${mib(p.peak)} MiB`).join("; ")} (experiment)`);
        }
        console.log(`OBSERVATION ${TASK}: ${label}: largest Git process peaks ${peaks.map(mib).join(", ")} MiB; median ${mib(median(peaks))} MiB (experiment)`);
      }
    }
  }, TIMEOUT_MS);

  largeCase("T061", `H1M: peak private bytes of the topology Git processes up to the first-step stop row ${count(FIRST_STEP)}, and the time to output lines ${MARKS.map(count).join(", ")}, with and without a commit-graph`, H1M, async () => {
    const topology = COMMANDS[0];
    for (const commitGraph of [false, true]) {
      const f = largeFixture(git, H1M, commitGraph);
      const input = Buffer.from(startPoints(git, PERF_CACHE_ROOT, f.repo).map((s) => `${s}\n`).join(""));
      const variant = `H1M ${commitGraph ? "with" : "without"} commit-graph`;
      const label = `${variant}, first step (${count(FIRST_STEP)} lines)`;
      const peaks: number[] = [];
      for (let run = 1; run <= RUNS; run++) {
        const m = await measure(git, f.repo, topology.args, topology.env, input, { stopAt: FIRST_STEP });
        expect({ label, rows: m.rows }).toEqual({ label, rows: FIRST_STEP });
        expect(m.processes.every((p) => p.peak > 0)).toBe(true);
        const peak = Math.max(...m.processes.map((p) => p.peak));
        peaks.push(peak);
        console.log(`OBSERVATION T061: ${label}, run ${run}: ${m.processes.map((p) => `${p.exe} pid ${p.pid} peak ${mib(p.peak)} MiB`).join("; ")} (experiment)`);
      }
      console.log(`OBSERVATION T061: ${label}: largest Git process peaks ${peaks.map(mib).join(", ")} MiB; median ${mib(median(peaks))} MiB (experiment)`);

      const times: number[][] = MARKS.map(() => []);
      for (let run = 1; run <= RUNS; run++) {
        const m = await measure(git, f.repo, topology.args, topology.env, input, { marks: MARKS });
        expect({ variant, rows: m.rows, marks: m.marks.length }).toEqual({ variant, rows: H1M.commits, marks: MARKS.length });
        m.marks.forEach((ms, i) => times[i]!.push(ms));
        console.log(`OBSERVATION T061: ${variant}, time to output line, run ${run}: ${MARKS.map((n, i) => `line ${count(n)} ${m.marks[i]!.toFixed(0)} ms`).join("; ")} (experiment)`);
      }
      console.log(`OBSERVATION T061: ${variant}, time to output line: ${MARKS.map((n, i) => `line ${count(n)} ${times[i]!.map((ms) => ms.toFixed(0)).join(", ")} ms, median ${median(times[i]!).toFixed(0)} ms`).join("; ")} (experiment)`);
    }
  }, TIMEOUT_MS);
});
