// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T048: the feature 008 revert budgets in the installed package (plan.md P7, WP7; research.md R11, R12). `Local: package`. The WSL case is also `Local: WSL`.
// Spec SC-007, SC-011, FR-037, FR-048. Each timing is the median of the counted runs after one warm-up run. The budgets are fixed in spec SC-007 before the measurement.
// The cases drive the page through the WebView2 CDP endpoint and UI Automation patterns. They send no OS input and never move the pointer.
// Page timing: the time from the `timeStamp` of the input event to the start of the first animation frame whose page holds the result (as T061).
// It leaves out the OS input path and the compositor, so it is not the 001 visible response of the capture source (001 plan.md "Capture source").
// SC-011 takes each input duration from the W3C Event Timing API: the time from the event to the next paint after its handlers (as T061 SC-009).
// Probe W9: a run that gives `failed` with `access-denied` and keeps the old bytes is a typed outcome. The case asserts it, prints an OBSERVATION line, and leaves the run out of the median (spec FR-037: no retry).

import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, cpSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { sizeDeadlineMs } from "../../src/git-service/git-runner";
import { faGit } from "../git/file-actions-fixtures";
import { fixtureDir, FIXTURE_ROOT, ownedGit, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { sha256 } from "../git/git-oracle";
import { printOrigin } from "../origin";
import { inDistro, missingCapability, uncPath, useWslFolder, wslExec, wslHost } from "../wsl/wsl-host";
import { connectPage, freePort, MOD, watchIpc, type Cdp, type IpcLog } from "./cdp";
import { appEnv, COMMIT_VIEW, descendants, findInstalledApp, PROBE_TIMEOUT_MS, processRecords, startInstalledApp, WAIT_MS, waitExit, type OwnedProcess } from "./installed-app";
import { applyRevertChanges, ensureRevertFixture, RV_BINARY, RV_BOTH, RV_SMALL, RV_TEXT, rvBinary, rvBothPath, rvSmall, rvSmallPath, rvText } from "./revert-fixtures";
import { close, ControlType, find, invoke, MAX_CALL_MS, MAX_WAIT_MS, setValue, type Element } from "./uia";

// tests/windows/measure-ram-split.ps1 gives the total of scripts/windows/measure-ram.ps1 -Json and the bytes of each process kind.
const SAMPLER = printOrigin("./measure-ram-split.ps1", import.meta.dir);
for (const helper of ["./cdp.ts", "./installed-app.ts", "./uia.ts", "./revert-fixtures.ts", "./perf-fixtures.ts", "../wsl/wsl-host.ts", "../git/file-actions-fixtures.ts", "../../src/git-service/git-runner.ts"]) printOrigin(helper, import.meta.dir);

const TASK = "T048";
const STEP_MS = MAX_WAIT_MS + MAX_CALL_MS;
const caseTimeout = (steps: number, extraMs = 0) => steps * STEP_MS + 2 * PROBE_TIMEOUT_MS + 2 * WAIT_MS + extraMs;
// "Warm, median of 10 runs" (research.md R12): one warm-up run, then the counted runs.
const RUNS = 10;
// The page waits for each step at most this long. A step past it fails the case.
const STEP_LIMIT_MS = 60_000;
const OPEN_WAIT_MS = 120_000;
// The sampler interval of scripts/windows/measure-ram.ps1 `-IntervalMs`.
const SAMPLE_MS = 250;
// The retained growth is read this long after the run end (T048 RCA request of 2026-11-02).
const RETAIN_MS = 30_000;
const MIB = 1024 * 1024;

// ---- Budgets (spec SC-007, SC-011; research.md R11) ----

const BUSY_MS = 100;
const CONFIRM_MS = 500;
const CONFIRM_1000_MS = 3_000;
const REFRESH_MS = 500;
const FILES_100_MS = 3_000;
const UNSTAGED_1000_MS = 10_000;
const UNSTAGED_1000_WSL_MS = 30_000;
const GIB_MS = 30_000;
const CANCEL_MS = 1_000;
const MEMORY_BYTES = 64 * MIB;
const INPUT_P95_MS = 100;
const INPUT_MAX_MS = 500;
// Research.md R11: the deadline rule of whole files assumes at least 64 MiB/s of local disk throughput.
const DISK_MIBPS = 64;
// The Event Timing API reports no entry below its 16 ms minimum `durationThreshold`, so such an input counts as 16 ms.
const EVENT_THRESHOLD_MS = 16;
// The 001 probe interval during a workload (001 plan.md "Responsiveness metrics").
const PROBE_INTERVAL_MS = 100;
// Spec SC-007 "the 004 multi-file limit": src/contracts/limits.ts `MULTI_FILE_ACTION_FILES`.
const LIMIT_FILES = 10_000;
// A bound of the test, not a budget. It holds a run at the limit, which has no SC-007 end time, and a WSL run, whose budget the record still checks.
const LIMIT_RUN_MS = 15 * 60_000;
const GIB = 1024 * MIB;

// ---- App texts (the source of each value is named) ----

const OPEN_FOLDER = "Open folder… (Ctrl+O)";
// src/frontend/changes/revert-text.ts.
const NO_UNDO = "You cannot undo this.";
const MORE_ACTIONS = "More actions";
const REVERT_UNSTAGED_LABEL = "Revert all unstaged changes…";
const UNAVAILABLE = " is unavailable.";
const CHECKING = "Checking ";
// src/frontend/app/Workbench.tsx `statusText`.
const REFRESHING = "Refreshing…";
const STATE_UNKNOWN = "State unknown";
const NO_HUNK = "No hunk is selected.";
// src/frontend/changes/PatchView.tsx annotation text.
const SELECTED_HUNK = "Selected hunk";
const REVERTING = "Reverting ";
// src/frontend/commit/CommitTray.tsx.
const MESSAGE = "Commit message";
// src/frontend/changes/ChangesPane.tsx layout buttons.
const FLAT_LAYOUT = "Flat layout";
// The service binary of the package (scripts/windows/measure-ram.ps1 group "Bun").
const SERVICE_EXE = "arbareto-git.exe";

// ---- CDP keys (as tests/windows/inspection-perf.test.ts) ----

const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", vk: 0x0d, text: "\r" },
  Escape: { key: "Escape", code: "Escape", vk: 0x1b },
  Home: { key: "Home", code: "Home", vk: 0x24 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 0x26 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 0x28 },
  F5: { key: "F5", code: "F5", vk: 0x74 },
  r: { key: "r", code: "KeyR", vk: 0x52, text: "r" },
  x: { key: "x", code: "KeyX", vk: 0x58, text: "x" },
};
const MODIFIER_KEYS = [
  { bit: MOD.Alt, key: "Alt", code: "AltLeft", vk: 0x12 },
  { bit: MOD.Ctrl, key: "Control", code: "ControlLeft", vk: 0x11 },
  { bit: MOD.Shift, key: "Shift", code: "ShiftLeft", vk: 0x10 },
];
async function press(c: Cdp, name: string, modifiers = 0): Promise<void> {
  const k = KEYS[name];
  if (k === undefined) throw new Error(`no key ${JSON.stringify(name)}`);
  const held = MODIFIER_KEYS.filter((m) => modifiers & m.bit);
  const typed = k.text !== undefined && modifiers === 0;
  for (const m of held) await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, modifiers });
  await c.send("Input.dispatchKeyEvent", { type: typed ? "keyDown" : "rawKeyDown", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers, ...(typed ? { text: k.text, unmodifiedText: k.text } : {}) });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers });
  for (const m of held.toReversed()) await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, modifiers: 0 });
}

const js = (value: unknown) => JSON.stringify(value);
async function until<T>(c: Cdp, what: string, expression: string, done: (value: T) => boolean, ms = STEP_LIMIT_MS): Promise<T> {
  const value = await c.poll<T>(expression, done, ms);
  if (!done(value)) throw new Error(`${what} did not happen within ${ms} ms: ${js(value)} ${js(await c.evaluate<unknown>(FACTS).catch((e) => String(e)))}`);
  return value;
}
async function focusOn(c: Cdp, expression: string, what: string): Promise<void> {
  await until<boolean>(c, `${what} shows`, `!!(${expression})`, (v) => v);
  await c.evaluate(`(${expression}).focus(); true`);
  await until<boolean>(c, `${what} has focus`, `document.activeElement === (${expression})`, (v) => v);
}

// ---- Page timing (the T061 helpers of tests/windows/inspection-perf.test.ts) ----

// `arm` records the `timeStamp` of the next input event and resolves with the time at which each check first holds in an animation frame callback.
// That time is `performance.now()` in the callback, not its argument: the argument is the vsync time, which can precede a long task of that frame.
// A check that holds at `arm`, an event before `arm`, or a negative time gives `ok: false`. The frame loop runs only while the page is visible.
const PAGE = `(() => {
  if (window.__t048 !== undefined) return true;
  window.__t048Keys = [];
  window.__t048Events = [];
  addEventListener('keydown', (e) => window.__t048Keys.push(e.timeStamp), { capture: true });
  new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.name === 'keydown') window.__t048Events.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'event', durationThreshold: ${EVENT_THRESHOLD_MS} });
  window.__t048 = {
    arm(checks, limit) {
      const armed = performance.now();
      let start = null;
      const onInput = (e) => { if (start === null) start = e.timeStamp; };
      addEventListener('keydown', onInput, { capture: true });
      const done = checks.map(() => null);
      this.value = null;
      const end = (ok, why) => {
        removeEventListener('keydown', onInput, { capture: true });
        const times = done.map((t) => (t === null || start === null ? null : t - start));
        const valid = ok && start >= armed && times.every((t) => t !== null && t >= 0);
        this.value = { ok: valid, why: valid ? null : why ?? 'the event time lies before arm or after a check', armed, start, times };
      };
      const held = checks.findIndex((check) => check());
      if (held >= 0) {
        end(false, 'check ' + held + ' held before the event');
        return true;
      }
      const step = () => {
        const now = performance.now();
        if (start !== null) checks.forEach((check, i) => { if (done[i] === null && check()) done[i] = now; });
        if (start !== null && done.every((t) => t !== null)) return end(true);
        if (start !== null && now - start > limit) return end(false, 'a check did not hold within the limit');
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      return true;
    },
  };
  return true;
})()`;

// The DOM facts that a failed step prints, so the failure names its cause.
const FACTS = `(() => {
  const text = (e) => (e?.textContent ?? '').trim().slice(0, 300);
  const active = document.activeElement;
  return {
    active: active === null ? null : (active.getAttribute('aria-label') ?? active.tagName + ' ' + text(active).slice(0, 60)),
    footer: text(document.querySelector('[data-slot=status-region] footer')),
    statusLine: text(document.querySelector('[data-slot=status-region] footer span[role=status][tabindex="-1"]')),
    footerButtons: [...(document.querySelector('[data-slot=status-region] footer')?.querySelectorAll('button') ?? [])].map(text),
    footers: document.querySelectorAll('[data-slot=status-region] footer').length,
    statuses: [...document.querySelectorAll('[role=status]')].map(text).filter((t) => t !== ''),
    dialogs: [...document.querySelectorAll('[role=alertdialog],[role=dialog]')].map(text),
    menus: [...document.querySelectorAll('[role=menu]')].map(text),
    changes: text(document.querySelector('[data-list-heading=Changes] .num')),
    staged: text(document.querySelector('[data-list-heading=Staged] .num')),
    heading: document.querySelector('[data-section=comparison] h2')?.getAttribute('aria-label') ?? null,
    lineAction: [...document.querySelectorAll('[data-section=comparison] [data-slot=line-action]')].map((b) => text(b) + (b.disabled ? ' (disabled)' : '')),
    rows: [...document.querySelectorAll('[data-file-tree=changes] [role=treeitem]')].slice(0, 4).map((r) => r.getAttribute('aria-label') + (r.getAttribute('aria-selected') === 'true' ? ' (selected)' : '')),
  };
})()`;
async function facts(c: Cdp, checks: string[]): Promise<string> {
  const values = await c.evaluate<unknown[]>(`[${checks.map((check) => `(() => { try { return !!(${check}); } catch (e) { return String(e); } })()`).join(", ")}]`);
  return js({ checks: values, dom: await c.evaluate<unknown>(FACTS) });
}

// One line per timed step and per run, so a later check of host sleep can place the events.
const step = (name: string) => console.log(`STEP ${name} ${new Date().toISOString()}`);

// `limit` bounds the wait for the checks. A check past it fails the step.
async function timed(c: Cdp, name: string, checks: string[], act: () => Promise<void>, limit = STEP_LIMIT_MS): Promise<number[]> {
  step(name);
  await c.evaluate(`window.__t048.arm([${checks.map((check) => `() => (${check})`).join(", ")}], ${limit})`);
  await act();
  // `cdp.ts` ends one call after 10 s, so the page sets `value` and the test polls it up to the limit.
  const r = (await until<{ ok: boolean; why: string | null; armed: number; start: number | null; times: (number | null)[] } | null>(c, "the timed step", "window.__t048.value", (v) => v !== null, limit + 5_000))!;
  if (!r.ok || r.start === null || r.start < r.armed || !r.times.every((t) => t !== null && t >= 0)) throw new Error(`a timed step is not valid: ${js(r)} ${await facts(c, checks)}`);
  return r.times as number[];
}

const median = (xs: number[]) => {
  const s = xs.toSorted((a, b) => a - b);
  return s.length % 2 === 1 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
// 001 plan.md "Responsiveness metrics": the nearest-rank p95.
const p95 = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.max(0, Math.ceil(0.95 * xs.length) - 1)]!;
const rounded = (xs: number[]) => xs.map((x) => Math.round(x * 10) / 10);
// A typed W9 run leaves the series, so a series can hold fewer than RUNS values. An empty series fails the case.
function record(what: string, runs: number[], budget?: number): number {
  if (runs.length === 0) throw new Error(`${what}: no counted run`);
  const m = median(runs);
  console.log(`OBSERVATION ${TASK}: ${what}: ${runs.length} counted runs ${js(rounded(runs))} ms, median ${m.toFixed(1)} ms${budget === undefined ? "" : `, budget ${budget} ms`}`);
  return m;
}

// ---- SC-011 inputs (W3C Event Timing) ----

const openWindow = (c: Cdp) => c.evaluate("(window.__t048Keys = [], window.__t048Events = [], true)");
async function closeWindow(c: Cdp, label: string): Promise<void> {
  await c.evaluate("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))");
  const { keys, events } = await c.evaluate<{ keys: number[]; events: { start: number; duration: number }[] }>("({ keys: window.__t048Keys, events: window.__t048Events })");
  const durations = keys.map((k) => events.find((e) => e.start === k)?.duration ?? EVENT_THRESHOLD_MS);
  console.log(`OBSERVATION ${TASK}: SC-011 ${label}: ${durations.length} inputs, p95 ${durations.length === 0 ? "-" : p95(durations)} ms, max ${durations.length === 0 ? "-" : Math.max(...durations)} ms, durations ${js(durations)}`);
  expect(durations.length).toBeGreaterThan(0);
  expect({ label, p95: p95(durations) <= INPUT_P95_MS, max: Math.max(...durations) <= INPUT_MAX_MS }).toEqual({ label, p95: true, max: true });
}
// `trigger` sends the input that starts the review or the run. Then a probe input goes to the page every 100 ms until `finish` resolves.
async function probing<T>(c: Cdp, label: string, probe: () => Promise<void>, trigger: () => Promise<void>, finish: () => Promise<T>): Promise<T> {
  await openWindow(c);
  await trigger();
  let finished = false;
  // A rejection must stay handled until `await running`: Bun 1.4.4 fails the case at an unhandled rejection and starts the next case first.
  const running = finish();
  running.then(
    () => void (finished = true),
    () => void (finished = true),
  );
  while (!finished) {
    await probe();
    await Bun.sleep(PROBE_INTERVAL_MS);
  }
  const value = await running;
  await closeWindow(c, label);
  return value;
}

// ---- Memory (the scripts/windows/measure-ram.ps1 -Json counter with a split by process kind, as tests/windows/spelling-perf.test.ts T042) ----

const KINDS = ["shell", "service", "git", "wvBrowser", "wvRenderer", "wvGpu", "wvOther", "other"] as const;
type Kind = (typeof KINDS)[number];
type Sample = { timeMs: number; rootPid: number; processes: number; webView2PrivateBytes: number; totalPrivateBytes: number; gitCount: number } & Record<Kind, number>;
interface Sampler {
  samples: Sample[];
  stop(): Promise<void>;
}
// One JSON line per sample on stdout. The sampler is a child of this process, so `kill` ends it by its own handle.
function startSampler(rootPid: number): Sampler {
  const ps = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const proc = Bun.spawn([ps, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SAMPLER, "-RootPid", String(rootPid), "-IntervalMs", String(SAMPLE_MS)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const samples: Sample[] = [];
  const reading = (async () => {
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of proc.stdout) {
      rest += decoder.decode(chunk, { stream: true });
      for (let i = rest.indexOf("\n"); i >= 0; i = rest.indexOf("\n")) {
        const line = rest.slice(0, i).trim();
        rest = rest.slice(i + 1);
        if (line !== "") samples.push(JSON.parse(line) as Sample);
      }
    }
  })();
  return {
    samples,
    async stop() {
      proc.kill();
      await proc.exited;
      await reading;
      const err = await new Response(proc.stderr).text();
      if (err.trim() !== "") console.log(`SAMPLER_STDERR ${TASK}: ${err.trim()}`);
    },
  };
}
// Waits for the first sample after `timeMs` (Unix ms), at most STEP_LIMIT_MS.
async function sampleAfter(s: Sampler, timeMs: number): Promise<Sample> {
  for (const end = Date.now() + STEP_LIMIT_MS; Date.now() < end; await Bun.sleep(SAMPLE_MS / 2)) {
    const found = s.samples.find((x) => x.timeMs > timeMs);
    if (found !== undefined) return found;
  }
  throw new Error(`no memory sample after ${timeMs} within ${STEP_LIMIT_MS} ms`);
}
// The growth from the last sample before `from` to the peak sample up to the first sample after `to`.
// `split` is the growth of each kind at that peak sample. `retained` is the growth at the first sample RETAIN_MS after `to`.
async function growth(s: Sampler, from: number, to: number): Promise<{ before: number; peak: number; growth: number; split: Record<Kind, number>; retained: number; retainedSplit: Record<Kind, number> }> {
  const after = await sampleAfter(s, to);
  const before = s.samples.filter((x) => x.timeMs <= from).at(-1);
  if (before === undefined) throw new Error("no memory sample before the run");
  const peakSample = s.samples.filter((x) => x.timeMs > from && x.timeMs <= after.timeMs).reduce((a, b) => (b.totalPrivateBytes > a.totalPrivateBytes ? b : a));
  const later = await sampleAfter(s, to + RETAIN_MS);
  const split = (x: Sample) => Object.fromEntries(KINDS.map((k) => [k, x[k] - before[k]])) as Record<Kind, number>;
  return { before: before.totalPrivateBytes, peak: peakSample.totalPrivateBytes, growth: peakSample.totalPrivateBytes - before.totalPrivateBytes, split: split(peakSample), retained: later.totalPrivateBytes - before.totalPrivateBytes, retainedSplit: split(later) };
}
const mib = (n: number) => (n / MIB).toFixed(1);
const splitText = (x: Record<Kind, number>) => KINDS.map((k) => `${k} ${mib(x[k])}`).join(", ");
// The memory line of one run: the counted peak growth, its split by process kind, and the retained growth.
const memoryLine = (what: string, run: number, g: Awaited<ReturnType<typeof growth>>) =>
  `OBSERVATION ${TASK}: ${what} run ${run}: private bytes before ${g.before}, peak ${g.peak}, growth ${mib(g.growth)} MiB, budget 64 MiB; peak split MiB: ${splitText(g.split)}; retained ${RETAIN_MS / 1000} s after the end ${mib(g.retained)} MiB: ${splitText(g.retainedSplit)}`;

// ---- Host facts ----

// Get-MpComputerStatus `RealTimeProtectionEnabled` decides the exit code, so no output text is parsed (as probe W9).
function defenderRealTime(): "on" | "off" | string {
  const p = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "if ((Get-MpComputerStatus).RealTimeProtectionEnabled) { exit 10 } else { exit 11 }"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 60_000 });
  return p.exitCode === 10 ? "on" : p.exitCode === 11 ? "off" : `unknown-${p.exitCode}`;
}

// A streamed copy in 1 MiB chunks with SHA-256 and a final flush, as plan.md D8 copies Git's temporary file (probe W9 method without FFI).
// Node `fsyncSync` calls FlushFileBuffers on Windows.
function streamedCopyMiBps(dir: string, mib: number): { mib: number; ms: number; mibps: number } {
  const source = join(dir, "source.bin");
  writeFileSync(source, Buffer.alloc(mib * MIB, 0x5a));
  const input = openSync(source, "r");
  const output = openSync(join(dir, "copy.bin"), "wx");
  const hasher = new Bun.CryptoHasher("sha256");
  const buffer = Buffer.alloc(MIB);
  const start = performance.now();
  try {
    for (let n = readSync(input, buffer); n > 0; n = readSync(input, buffer)) {
      hasher.update(buffer.subarray(0, n));
      if (writeSync(output, buffer, 0, n) !== n) throw new Error("a short copy write");
    }
    fsyncSync(output);
  } finally {
    closeSync(output);
    closeSync(input);
  }
  const ms = performance.now() - start;
  hasher.digest("hex");
  return { mib, ms, mibps: mib / (ms / 1000) };
}

// ---- Run replies and the W9 outcome ----

type FileOutcome = { entryId: string; outcome: string; code?: string; reason?: string };
type RunReply = { state: string; code?: string; result?: { files?: FileOutcome[] } };
// `old` is the SHA-256 of the working bytes before the run.
type Target = { path: string; old: string };

async function runReply(ipc: IpcLog, before: number): Promise<RunReply> {
  const calls = await ipc.wait("run_workbench", before + 1, STEP_LIMIT_MS);
  return ipc.body<RunReply>(calls[before]!);
}
// Probe W9 (research.md R15): `failed`, each missed file `error` with `access-denied`, and exactly that many targets keep their old bytes.
// The reply names no step, so the case cannot assert that the rename failed. It asserts the code and the old bytes.
function isW9(reply: RunReply, read: (path: string) => Buffer, targets: readonly Target[]): boolean {
  const missed = (reply.result?.files ?? []).filter((o) => o.outcome !== "reverted");
  if (reply.state !== "failed" || missed.length === 0 || !missed.every((o) => o.code === "error" && o.reason === "access-denied")) return false;
  return targets.filter((t) => sha256(read(t.path)) === t.old).length === missed.length;
}
// True for a counted run. A W9 run prints its OBSERVATION line and gives false. Any other reply fails the case.
function counted(label: string, reply: RunReply, read: (path: string) => Buffer, targets: readonly Target[], expected = "succeeded"): boolean {
  if (reply.state === expected) return true;
  if (isW9(reply, read, targets)) {
    const missed = (reply.result?.files ?? []).filter((o) => o.outcome !== "reverted");
    console.log(`OBSERVATION ${TASK}: W9 ${label}: state=failed ${missed.length} files ${js(missed.map((o) => `${o.outcome}:${o.code}:${o.reason}`))}, old bytes kept; the run leaves the median (spec FR-037)`);
    return false;
  }
  throw new Error(`${label}: the run gave ${js({ state: reply.state, code: reply.code, files: (reply.result?.files ?? []).filter((o) => o.outcome !== "reverted").slice(0, 5) })}`);
}

describe.skipIf(process.platform !== "win32")("T048 packaged revert budgets", () => {
  // Bun 1.4.4 runs `afterAll` hooks in declaration order. This hook must come before the fixture root removal.
  const owned = new Set<OwnedProcess>();
  const sockets = new Set<Cdp>();
  afterAll(() => {
    for (const c of sockets) c.close();
    for (const app of owned) app.stop();
    close();
  });
  useFixtureRoot();

  const discovery = findInstalledApp();
  const installed = "app" in discovery ? discovery.app : null;
  const others = installed === null ? [] : processRecords().filter((r) => r.name.toLowerCase() === installed.mainBinaryName.toLowerCase());
  const defender = process.platform === "win32" ? defenderRealTime() : "off";
  console.log(`OBSERVATION ${TASK}: defender-real-time ${defender}`);
  const reason =
    installed === null ? (discovery as { skip: string }).skip
    : GIT === null ? "Git executable absent"
    : others.length > 0 ? `another-instance: ${installed.mainBinaryName} runs as PID ${others.map((r) => r.pid).join(", ")}`
    // Research.md R12: the method needs Windows Defender real-time protection on.
    : defender !== "on" ? `defender-real-time: ${defender}`
    : null;
  if (reason !== null) console.log(`SKIP installed app: ${reason}`);
  // WSL detection starts the distro, so it runs only when the cases can run.
  if (reason === null) useWslFolder();

  const git = (repo: string, args: string[], input?: Uint8Array) => faGit(GIT!, repo, args, input === undefined ? {} : { input });
  const under = (root: string, repo: string) => !relative(root, repo).startsWith("..") && !isAbsolute(relative(root, repo));
  const winRead = (repo: string) => (path: string) => readFileSync(join(repo, path));

  async function use<T>(element: Promise<Element>, body: (element: Element) => T): Promise<T> {
    const found = await element;
    try {
      return body(found);
    } finally {
      found.release();
    }
  }
  const uia = <T>(pid: number, name: string, type: number | undefined, body: (element: Element) => T) => use(find(pid, name, MAX_WAIT_MS, type), body);

  type Session = { app: OwnedProcess; c: Cdp; ipc: IpcLog };
  // `folder` is the path that the folder dialog gets. `shown` is the switcher label of the open repository.
  async function session(label: string, folder: string, shown: (label: string | null) => boolean, wslGit = false): Promise<Session> {
    // Each start has a new profile folder (appEnv sets ARBARETO_PROFILE_ROOT below it).
    const env = appEnv(fixtureDir(`${label}-app`), false);
    const port = freePort();
    env.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port}`;
    const app = startInstalledApp(installed!, env);
    owned.add(app);
    console.log(`STARTED ${TASK}: ${app.pid} ${label} port=${port}`);
    await uia(app.pid, "Select Git", ControlType.Button, invoke);
    await uia(app.pid, "Use this Git", undefined, invoke);
    // The IPC record starts before the folder choice, so a refused open names its reply.
    const c = await connectPage(port, MAX_WAIT_MS);
    sockets.add(c);
    const ipc = await watchIpc(c);
    // CDP `Network.enable` keeps response bodies in a bounded inspector buffer. The reply of a 10,000-file run outgrew the default, so the case raises the bounds.
    await c.send("Network.enable", { maxTotalBufferSize: 512 * MIB, maxResourceBufferSize: 256 * MIB });
    await uia(app.pid, OPEN_FOLDER, undefined, invoke);
    await uia(app.pid, "Folder:", ControlType.Edit, (field) => setValue(field, folder));
    await uia(app.pid, "Select Folder", ControlType.Button, invoke);
    // A WSL folder asks for its distro Git in a native confirmation with Use this Git and Cancel (src-tauri/src/dialogs.rs `wsl_git_confirmation`).
    if (wslGit) await uia(app.pid, "Use this Git", undefined, invoke);
    try {
      await until<string | null>(c, "the open repository", `document.querySelector('button[aria-keyshortcuts="Control+R"]')?.getAttribute('aria-label') ?? null`, shown, OPEN_WAIT_MS);
    } catch (e) {
      const replies = await Promise.all(["choose_repository", "read_workspace"].flatMap((command) => ipc.finished(command).map(async (call) => ({ command, reply: await ipc.body<unknown>(call) }))));
      const tree = descendants(app.pid).map((r) => `${r.pid} ${r.name} ${(r.commandLine ?? "").slice(0, 160)}`);
      throw new Error(`${(e as Error).message} replies=${js(replies).slice(0, 4000)} pending=${js(["choose_repository", "read_workspace"].map((command) => ipc.pending(command).length))} tree=${js(tree)}`);
    }
    expect(await c.evaluate<string>("document.visibilityState")).toBe("visible");
    expect(await c.evaluate<boolean>(PAGE)).toBe(true);
    await uia(app.pid, COMMIT_VIEW, ControlType.Button, invoke);
    // Each new profile starts in the tree layout. The flat layout puts the revert files at fixed row positions (folders first, tree-order.ts).
    await focusOn(c, `document.querySelector('button[aria-label=${js(FLAT_LAYOUT)}]')`, FLAT_LAYOUT);
    await press(c, "Enter");
    await until<boolean>(c, "the flat layout", `document.querySelector('button[aria-label=${js(FLAT_LAYOUT)}]')?.getAttribute('aria-pressed') === 'true'`, (v) => v);
    return { app, c, ipc };
  }
  const windowsSession = (label: string, repo: string) => {
    if (!under(FIXTURE_ROOT, repo)) throw new Error(`the repository is outside the fixture root: ${repo}`);
    const root = ownedGit(GIT!, FIXTURE_ROOT, repo, ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
    return session(label, repo, (v) => v === `${basename(root)}, ${root}`);
  };
  // Only the owned Job of this case ends (installed-app.ts `stop`).
  async function end(s: Session): Promise<void> {
    s.c.close();
    sockets.delete(s.c);
    s.app.stop();
    owned.delete(s.app);
    expect(await waitExit(s.app)).not.toBeNull();
  }

  // ---- Page expressions ----

  const footer = `document.querySelector('[data-slot=status-region] footer')`;
  const statusText = `(${footer}?.querySelector('span[role=status][tabindex="-1"]')?.textContent ?? '')`;
  const cancelButton = `[...(${footer}?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Cancel')`;
  const dialog = `[...document.querySelectorAll('[role=alertdialog],[role=dialog]')].find((d) => d.textContent.includes(${js(NO_UNDO)}))`;
  const revertButton = `(${dialog})?.querySelector('button[data-danger=true]')`;
  const refused = `[...(${footer}?.querySelectorAll('[role=status]') ?? [])].some((s) => s.textContent.includes(${js(UNAVAILABLE)}) || s.textContent.trim() === ${js(NO_HUNK)})`;
  // Spec SC-007 busy state: the REVERT_CHECKING line, or the review result when it renders in the same frame.
  const busy = `${statusText}.startsWith(${js(CHECKING)}) || !!(${dialog}) || ${refused}`;
  const reviewed = `!!(${dialog}) || ${refused}`;
  // The run ended: no Cancel in the status bar, and an outcome line. A succeeded review leaves an empty line (Workbench.tsx `trackRevertReview`).
  const ended = `!(${cancelButton}) && ${statusText} !== ''`;
  const row = (path: string) => `document.querySelector(${js(`[data-file-tree=changes] [role=treeitem][aria-label="${path}"]`)})`;
  const heading = `(document.querySelector('[data-section=comparison] h2')?.getAttribute('aria-label') ?? '')`;
  const count = (list: "Changes" | "Staged") => `(document.querySelector('[data-list-heading=${list}] .num')?.textContent ?? '')`;
  const diffBody = `document.querySelector('[data-section=comparison] [data-slot=diff-body]')`;
  const lineAction = `document.querySelector('[data-section=comparison] [data-slot=line-action]')`;
  const headerMore = `document.querySelector(${js(`[data-section=workingChanges] button[aria-label="${MORE_ACTIONS}"]`)})`;
  // src/frontend/app/Workbench.tsx `statusText`: the first status cell of the footer shows these texts while a read runs or the state is blocked.
  const settled = `![${js(REFRESHING)}, ${js(STATE_UNKNOWN)}].includes((${footer}?.querySelector('span[role=status]:not([tabindex])')?.textContent ?? '').trim())`;
  const menuItem = (label: string) => `[...document.querySelectorAll('[role=menu] [role=menuitem]')].find((e) => e.textContent.includes(${js(label)}))`;
  const fmt = new Intl.NumberFormat("en-US");

  const messageProbe = (c: Cdp) => async () => {
    const message = `document.querySelector('[aria-label=${js(MESSAGE)}]')`;
    if (!(await c.evaluate<boolean>(`document.activeElement === ${message}`))) await c.evaluate(`${message}?.focus(); true`);
    await press(c, "x");
  };

  // Waits for the reviewed state after an external restore. F5 reads the workspace again.
  async function refreshed(c: Cdp, what: string, expression: string): Promise<void> {
    await press(c, "F5");
    // A reconcile read can end during the F5 read with `recoveryState: "refreshing"`. Then R refuses with BLOCKED_TEXT.unknown, so the wait also needs the settled status cell.
    await until<boolean>(c, what, `(${expression}) && ${settled}`, (v) => v);
  }
  async function select(c: Cdp, path: string): Promise<void> {
    await focusOn(c, row(path), path);
    await press(c, "Enter");
    await until<string>(c, `the diff of ${path}`, heading, (v) => v.startsWith(path));
  }
  // A new diff has no selected hunk, and R then gives NO_HUNK. Alt+Down selects the next hunk (shortcuts.ts `selectHunk`).
  async function selectHunk(c: Cdp): Promise<void> {
    await focusOn(c, diffBody, "the diff");
    await press(c, "ArrowDown", MOD.Alt);
    await until<boolean>(c, "the selected hunk", `(document.querySelector('[data-section=comparison]')?.textContent ?? '').includes(${js(SELECTED_HUNK)})`, (v) => v);
  }
  // R, then the revert button. `shownCheck` holds when the refreshed state shows. The probed run measures SC-011 only.
  // `title` is the expected dialog title (revert-text.ts `revertFilesTexts`), or undefined for no check.
  async function revertRun(s: Session, opener: string, shownCheck: string, probe: boolean, title?: string): Promise<{ busy: number; confirm: number; shown: number; reply: RunReply }> {
    const reviews = s.ipc.finished("run_workbench").length;
    await focusOn(s.c, opener, "the revert opener");
    let busyMs = 0;
    let confirmMs = 0;
    if (probe) await probing(s.c, "a review", messageProbe(s.c), () => press(s.c, "r"), () => until<boolean>(s.c, "the review", reviewed, (v) => v));
    else [busyMs, confirmMs] = await timed(s.c, "r-to-review", [busy, reviewed], () => press(s.c, "r"));
    if (!(await s.c.evaluate<boolean>(`!!(${dialog})`))) throw new Error(`the review refused: ${await facts(s.c, [])}`);
    if (title !== undefined && !(await s.c.evaluate<boolean>(`(${dialog}).textContent.includes(${js(title)})`))) throw new Error(`the dialog does not hold ${js(title)}: ${await facts(s.c, [])}`);
    await focusOn(s.c, revertButton, "the revert button");
    let shownMs = 0;
    if (probe) await probing(s.c, "a run", messageProbe(s.c), () => press(s.c, "Enter"), () => until<boolean>(s.c, "the run", `${ended} && (${shownCheck})`, (v) => v));
    else {
      const reads = s.ipc.finished("read_comparison").length;
      try {
        [shownMs] = await timed(s.c, "revert-to-shown", [`${ended} && (${shownCheck})`], () => press(s.c, "Enter"));
      } catch (e) {
        // The comparison reads after the confirmation tell a missing refresh from a missing render.
        type Read = { state?: string; result?: { comparisonId?: string; patch?: string } };
        const after = s.ipc.finished("read_comparison");
        const bodies = await Promise.all(after.slice(Math.max(0, reads - 1)).map((call) => s.ipc.body<Read>(call)));
        const brief = bodies.map((b) => ({ ...b, result: b.result === undefined ? undefined : { ...b.result, patch: b.result.patch?.length } }));
        throw new Error(`${(e as Error).message} parts ended, shown: ${await facts(s.c, [ended, shownCheck, ...shownCheck.split(" && ")])} shown=${shownCheck} read_comparison before=${reads} after=${after.length} ${js(brief).slice(0, 4000)}`);
      }
    }
    return { busy: busyMs!, confirm: confirmMs!, shown: shownMs!, reply: await runReply(s.ipc, reviews) };
  }
  // A copy of the cached R fixture under the fixture root. `update-index --refresh` restores the stat data of a fresh checkout.
  function revertCopy(name: string): string {
    const cached = ensureRevertFixture(GIT!);
    console.log(`OBSERVATION ${TASK}: R fixture ${cached.reused ? "reused" : "built"} ${js(cached.facts)}`);
    const dest = join(fixtureDir(name), "repo");
    cpSync(cached.repo, dest, { recursive: true });
    ownedGit(GIT!, FIXTURE_ROOT, dest, ["update-index", "-q", "--refresh"], { allowExit: [0, 1] });
    return dest;
  }
  const smallTargets = () => Array.from({ length: RV_SMALL }, (_, i) => ({ path: rvSmallPath(i), old: sha256(Buffer.from(rvSmall(rvSmallPath(i), "unstaged"))) }));

  test.skipIf(reason !== null)(
    "SC-007, SC-011: on the 1 MiB file with a 2,000-line diff, R shows a busy state within 100 ms, the confirmation within 500 ms, and lines, hunk, and file reverts the refreshed diff within 500 ms; the 8 MiB binary Revert file too (median of 10)",
    async () => {
      const repo = revertCopy("t048-single");
      const s = await windowsSession("single", repo);
      try {
        await until<string>(s.c, "the R counts", `${count("Changes")} + '/' + ${count("Staged")}`, (v) => v === `${fmt.format(RV_SMALL + RV_BOTH + 2)}/${fmt.format(RV_BOTH)}`);
        const textOld = [{ path: RV_TEXT, old: sha256(Buffer.from(rvText(true))) }];
        const binaryOld = [{ path: RV_BINARY, old: sha256(Buffer.from(rvBinary(true))) }];
        const textGone = `!${row(RV_TEXT)} && !${heading}.startsWith(${js(RV_TEXT)})`;
        // Proof of the new comparison after a lines revert: the first changed line is a removed row before the revert and a context row after it.
        // The selection starts at that row, so the revert restores it. Pierre renders the rows in an open shadow root with `data-line-type` (@pierre/diffs FileDiff).
        const headLines = rvText(false).split("\n");
        const changedLines = rvText(true).split("\n");
        const firstChanged = headLines[headLines.findIndex((l, k) => l !== changedLines[k])]!;
        const restoredContext = `[...document.querySelectorAll('[data-section=comparison] *')].some((h) => h.shadowRoot !== null && [...h.shadowRoot.querySelectorAll('[data-line-type=context]')].some((r) => (r.textContent ?? '').includes(${js(firstChanged)})))`;
        // Each restore starts from a state without the text row, so the wait for the row proves the new read.
        const restoreText = () => {
          writeFileSync(join(repo, RV_TEXT), rvText(true));
          return refreshed(s.c, "the restored text file", `!!${row(RV_TEXT)}`);
        };
        const series: Record<string, { busy: number[]; confirm: number[]; shown: number[] }> = {};
        const add = (kind: string, r: { busy: number; confirm: number; shown: number }) => {
          const x = (series[kind] ??= { busy: [], confirm: [], shown: [] });
          x.busy.push(r.busy);
          x.confirm.push(r.confirm);
          x.shown.push(r.shown);
        };
        for (const probe of [false, true]) {
          for (let run = 0; run <= (probe ? 0 : RUNS); run++) {
            step(`single-run-${run}${probe ? "-probed" : ""}`);
            // Revert file of the text file from its row.
            const file = await revertRun(s, row(RV_TEXT), textGone, probe);
            if (counted("text file", file.reply, winRead(repo), textOld) && !probe && run > 0) add("text file", file);
            await restoreText();
            // Hunk: R without a line selection reverts the selected hunk, the only hunk of the file.
            await select(s.c, RV_TEXT);
            await selectHunk(s.c);
            const hunk = await revertRun(s, diffBody, textGone, probe);
            if (counted("hunk", hunk.reply, winRead(repo), textOld) && !probe && run > 0) add("hunk", hunk);
            await restoreText();
            // Revert file of the 8 MiB binary file. Its refreshed state is the row removal.
            const binary = await revertRun(s, row(RV_BINARY), `!${row(RV_BINARY)} && !${heading}.startsWith(${js(RV_BINARY)})`, probe);
            if (counted("binary file", binary.reply, winRead(repo), binaryOld) && !probe && run > 0) add("binary file", binary);
            writeFileSync(join(repo, RV_BINARY), rvBinary(true));
            await refreshed(s.c, "the restored binary file", `!!${row(RV_BINARY)}`);
          }
        }
        // Lines run after the other kinds: a restore gives the same patch text, and the view keeps a line selection of an equal patch (ComparisonView.tsx `lines`).
        // A failed lines step stays a case failure. The case records it and stops the lines runs, so the other kinds keep their values.
        let linesFailure: string | null = null;
        for (const probe of [false, true]) {
          for (let run = 0; run <= (probe ? 0 : RUNS) && linesFailure === null; run++) {
            step(`single-lines-run-${run}${probe ? "-probed" : ""}`);
            try {
              // Shift+Down from the selected hunk selects rows of the one hunk. A new patch clears the line selection (data-model §14).
              await select(s.c, RV_TEXT);
              await selectHunk(s.c);
              for (let i = 0; i < 10; i++) await press(s.c, "ArrowDown", MOD.Shift);
              await until<boolean>(s.c, "the line selection", `!!${lineAction}`, (v) => v);
              const lines = await revertRun(s, diffBody, `!${lineAction} && ${heading}.startsWith(${js(RV_TEXT)}) && ${restoredContext}`, probe);
              if (counted("lines", lines.reply, winRead(repo), textOld) && !probe && run > 0) add("lines", lines);
            } catch (e) {
              linesFailure = `run ${run}${probe ? " (probed)" : ""}: ${(e as Error).message} git diff --numstat: ${git(repo, ["diff", "--numstat", "--", RV_TEXT]).toString("utf8").trim()}`;
              console.log(`OBSERVATION ${TASK}: lines step failed, the lines runs stop: ${linesFailure}`);
              if (await s.c.evaluate<boolean>(`!!(${dialog})`)) await press(s.c, "Escape");
            }
            // The text row stays after a lines revert. The HEAD bytes remove it, so the restore wait stays definitive.
            writeFileSync(join(repo, RV_TEXT), rvText(false));
            await refreshed(s.c, "the clean text file", `!${row(RV_TEXT)}`);
            await restoreText();
          }
        }
        const verdict: Record<string, boolean> = {};
        for (const [kind, x] of Object.entries(series)) {
          verdict[`${kind} busy`] = record(`SC-007 ${kind}: R to the busy state`, x.busy, BUSY_MS) <= BUSY_MS;
          // Spec SC-007 sets the confirmation budget for a file of up to 1 MiB, so the 8 MiB binary review is recorded only.
          const confirm = record(`SC-007 ${kind}: R to the confirmation`, x.confirm, kind === "binary file" ? undefined : CONFIRM_MS);
          if (kind !== "binary file") verdict[`${kind} confirm`] = confirm <= CONFIRM_MS;
          verdict[`${kind} refreshed`] = record(`SC-007 ${kind}: the revert button to the refreshed diff`, x.shown, REFRESH_MS) <= REFRESH_MS;
        }
        expect({ verdict, linesFailure }).toEqual({ verdict: Object.fromEntries(Object.keys(verdict).map((k) => [k, true])), linesFailure: null });
      } finally {
        await end(s);
      }
    },
    caseTimeout(80, (RUNS + 2) * 4 * 3 * STEP_LIMIT_MS),
  );

  test.skipIf(reason !== null)(
    "SC-007, SC-011: Revert file of 100 files with staged and unstaged changes ends within 3 s (median of 10)",
    async () => {
      const repo = revertCopy("t048-files");
      const s = await windowsSession("files", repo);
      try {
        const paths = Array.from({ length: RV_BOTH }, (_, i) => rvBothPath(i));
        const targets = paths.map((path) => ({ path, old: sha256(Buffer.from(rvSmall(path, "unstaged"))) }));
        const first = row(paths[0]!);
        const ends: number[] = [];
        for (let run = 0; run <= RUNS + 1; run++) {
          step(`files-100-run-${run}`);
          const probe = run === RUNS + 1;
          // Plan.md D15 "Multi-select": Shift+Down marks the range from the selected row (ChangesPane.tsx `onMark` "range"), so Enter selects the first row.
          // The list is virtual, so Home brings the first row back into the DOM after a scroll.
          await focusOn(s.c, `document.querySelector('[data-file-tree=changes] [role=treeitem]')`, "a Changes row");
          await press(s.c, "Home");
          await select(s.c, paths[0]!);
          for (let i = 1; i < RV_BOTH; i++) await press(s.c, "ArrowDown", MOD.Shift);
          const r = await revertRun(s, `document.activeElement?.getAttribute('aria-label') === ${js(paths.at(-1)!)} ? document.activeElement : null`, `!${first} && ${count("Staged")} === '0'`, probe, `Revert ${fmt.format(RV_BOTH)} files?`);
          if (counted("100 files", r.reply, winRead(repo), targets) && !probe && run > 0) ends.push(r.shown);
          applyRevertChanges(GIT!, FIXTURE_ROOT, repo, { both: true });
          // The run left 0 staged files, so 100 staged files prove the new read.
          await refreshed(s.c, "the restored 100 files", `${count("Staged")} === ${js(fmt.format(RV_BOTH))}`);
        }
        expect(record("SC-007 Revert file of 100 files: the revert button to the end", ends, FILES_100_MS)).toBeLessThanOrEqual(FILES_100_MS);
      } finally {
        await end(s);
      }
    },
    caseTimeout(40, (RUNS + 3) * 3 * STEP_LIMIT_MS),
  );

  // A disabled item ignores Enter. Base UI marks it with `aria-disabled` and `data-disabled` (action-menu.tsx `disabled={reason !== null}`).
  async function enabledItem(c: Cdp): Promise<void> {
    const item = menuItem(REVERT_UNSTAGED_LABEL);
    await until<boolean>(c, `${REVERT_UNSTAGED_LABEL} enabled`, `!!(${item}) && !(${item}).hasAttribute('disabled') && !(${item}).hasAttribute('data-disabled') && (${item}).getAttribute('aria-disabled') !== 'true'`, (v) => v);
    await focusOn(c, item, REVERT_UNSTAGED_LABEL);
  }
  // The header item of the Changes list (plan.md D12 "Changes header"). It has no key, so the menu item gets Enter.
  async function revertAll(s: Session, probe: boolean, limit = STEP_LIMIT_MS): Promise<{ busy: number; confirm: number; end: number; reply: RunReply; confirmAt: number; endAt: number }> {
    const before = s.ipc.finished("run_workbench").length;
    await focusOn(s.c, headerMore, MORE_ACTIONS);
    await press(s.c, "Enter");
    await enabledItem(s.c);
    let busyMs = 0;
    let confirmMs = 0;
    if (probe) await probing(s.c, "the review of all unstaged changes", messageProbe(s.c), () => press(s.c, "Enter"), () => until<boolean>(s.c, "the review", reviewed, (v) => v));
    else [busyMs, confirmMs] = await timed(s.c, "menu-to-review", [busy, reviewed], () => press(s.c, "Enter"));
    if (!(await s.c.evaluate<boolean>(`!!(${dialog})`))) throw new Error(`the review refused: ${await s.c.evaluate<string>(statusText)}`);
    await focusOn(s.c, revertButton, "the revert button");
    const confirmAt = Date.now();
    let endMs = 0;
    if (probe) await probing(s.c, "the run of all unstaged changes", messageProbe(s.c), () => press(s.c, "Enter"), () => until<boolean>(s.c, "the run", ended, (v) => v, limit));
    else [endMs] = await timed(s.c, "revert-to-end", [ended], () => press(s.c, "Enter"), limit);
    const endAt = Date.now();
    return { busy: busyMs!, confirm: confirmMs!, end: endMs!, reply: await runReply(s.ipc, before), confirmAt, endAt };
  }
  // Only the 1,000 small files keep unstaged changes. The both files keep their staged change (git-checkout(1) `-- <pathspec>` copies the index).
  function onlySmall(repo: string): void {
    git(repo, ["--literal-pathspecs", "checkout", "--", "rv/a", "rv/b"]);
  }

  test.skipIf(reason !== null)(
    "SC-007, SC-011: Revert all unstaged changes of 1,000 files shows the confirmation within 3 s and ends within 10 s on Windows (median of 10)",
    async () => {
      const repo = revertCopy("t048-unstaged");
      onlySmall(repo);
      const s = await windowsSession("unstaged", repo);
      try {
        const n = fmt.format(RV_SMALL);
        await until<string>(s.c, "1,000 unstaged files", count("Changes"), (v) => v === n);
        const series = { busy: [] as number[], confirm: [] as number[], end: [] as number[] };
        for (let run = 0; run <= RUNS + 1; run++) {
          step(`unstaged-1000-run-${run}`);
          const probe = run === RUNS + 1;
          const r = await revertAll(s, probe);
          if (counted("1,000 unstaged files", r.reply, winRead(repo), smallTargets()) && !probe && run > 0) {
            series.busy.push(r.busy);
            series.confirm.push(r.confirm);
            series.end.push(r.end);
          }
          applyRevertChanges(GIT!, FIXTURE_ROOT, repo, { small: true });
          await refreshed(s.c, "the restored 1,000 files", `${count("Changes")} === ${js(n)}`);
        }
        record("SC-007 Revert all unstaged changes of 1,000 files: the menu item to the busy state", series.busy);
        const m = { confirm: record("SC-007 Revert all unstaged changes of 1,000 files: the menu item to the confirmation", series.confirm, CONFIRM_1000_MS), end: record("SC-007 Revert all unstaged changes of 1,000 files on Windows: the revert button to the end", series.end, UNSTAGED_1000_MS) };
        expect({ confirm: m.confirm <= CONFIRM_1000_MS, end: m.end <= UNSTAGED_1000_MS }).toEqual({ confirm: true, end: true });
      } finally {
        await end(s);
      }
    },
    caseTimeout(60, (RUNS + 3) * 3 * STEP_LIMIT_MS),
  );

  test.skipIf(reason !== null)(
    "SC-007, SC-011: at the 004 multi-file limit of 10,000 files the process tree rises by at most 64 MiB during a run, and Cancel stops a run within 1 s (median of 10)",
    async () => {
      const repo = revertCopy("t048-limit");
      onlySmall(repo);
      // 9,000 more tracked M files get one added line, so exactly LIMIT_FILES files have unstaged changes.
      const extra = git(repo, ["ls-files", "-z", "--", "src"]).toString("utf8").split("\0").filter((p) => p !== "").slice(0, LIMIT_FILES - RV_SMALL);
      if (extra.length !== LIMIT_FILES - RV_SMALL) throw new Error(`M has only ${extra.length} files below src`);
      const heads = new Map(extra.map((p) => [p, readFileSync(join(repo, p))]));
      const changedOf = (p: string) => Buffer.concat([heads.get(p)!, Buffer.from("// t048 limit\n")]);
      const restore = () => {
        applyRevertChanges(GIT!, FIXTURE_ROOT, repo, { small: true });
        for (const p of extra) writeFileSync(join(repo, p), changedOf(p));
      };
      restore();
      const targets = [...smallTargets(), ...extra.map((path) => ({ path, old: sha256(changedOf(path)) }))];
      const n = fmt.format(LIMIT_FILES);
      const s = await windowsSession("limit", repo);
      const sampler = startSampler(s.app.pid);
      // PowerShell starts in about a second. A run needs one sample before its start.
      await sampleAfter(sampler, 0);
      try {
        await until<string>(s.c, "10,000 unstaged files", count("Changes"), (v) => v === n);
        const grown: number[] = [];
        const ends: number[] = [];
        for (let run = 0; run <= RUNS + 1; run++) {
          step(`limit-10000-run-${run}`);
          const probe = run === RUNS + 1;
          const r = await revertAll(s, probe, LIMIT_RUN_MS);
          const g = await growth(sampler, r.confirmAt, r.endAt);
          console.log(memoryLine("SC-007 limit, process tree", run, g));
          if (counted("10,000 unstaged files", r.reply, winRead(repo), targets) && !probe && run > 0) {
            grown.push(g.growth);
            ends.push(r.end);
          }
          restore();
          await refreshed(s.c, "the restored 10,000 files", `${count("Changes")} === ${js(n)}`);
        }
        record("SC-007 Revert all unstaged changes of 10,000 files: the revert button to the end", ends);
        // Cancel after the first REVERT_PROGRESS line. A run that ends before the Cancel measures nothing and fails the case.
        const cancels: number[] = [];
        for (let run = 0; run <= RUNS; run++) {
          step(`limit-cancel-run-${run}`);
          const before = s.ipc.finished("run_workbench").length;
          await focusOn(s.c, headerMore, MORE_ACTIONS);
          await press(s.c, "Enter");
          await enabledItem(s.c);
          await press(s.c, "Enter");
          await until<boolean>(s.c, "the review", reviewed, (v) => v);
          await focusOn(s.c, revertButton, "the revert button");
          await press(s.c, "Enter");
          await until<boolean>(s.c, "the first progress", `${statusText}.startsWith(${js(REVERTING)})`, (v) => v);
          await focusOn(s.c, cancelButton, "Cancel");
          const [stopped] = await timed(s.c, "cancel-to-end", [ended], () => press(s.c, "Enter"));
          const reply = await runReply(s.ipc, before);
          if (reply.state !== "canceled") throw new Error(`the Cancel run gave ${reply.state}`);
          if (run > 0) cancels.push(stopped!);
          restore();
          await refreshed(s.c, "the restored 10,000 files", `${count("Changes")} === ${js(n)}`);
        }
        const cancel = record("SC-007 Cancel of a 10,000-file run: Cancel to the end", cancels, CANCEL_MS);
        console.log(`OBSERVATION ${TASK}: SC-007 limit growth: ${grown.length} counted runs, max ${(Math.max(...grown) / MIB).toFixed(1)} MiB, budget 64 MiB`);
        expect({ memory: grown.length > 0 && grown.every((x) => x <= MEMORY_BYTES), cancel: cancel <= CANCEL_MS }).toEqual({ memory: true, cancel: true });
      } finally {
        await sampler.stop();
        await end(s);
      }
    },
    caseTimeout(120, (RUNS + 2) * LIMIT_RUN_MS + (2 * RUNS + 4) * 3 * STEP_LIMIT_MS),
  );

  test.skipIf(reason !== null)(
    "SC-007, SC-011, R11: Revert file of one 1 GiB binary file ends within 30 s with at most 64 MiB more service memory, and the disk gives at least 64 MiB/s (median of 10)",
    async () => {
      // Research.md R11: the measured throughput for the deadline rule, on the volume of the fixture root.
      const disk = streamedCopyMiBps(fixtureDir("t048-disk"), 256);
      const deadline = sizeDeadlineMs(GIB);
      console.log(`OBSERVATION ${TASK}: R11 streamed copy ${disk.mib} MiB in ${disk.ms.toFixed(0)} ms, ${disk.mibps.toFixed(1)} MiB/s, rule ${DISK_MIBPS} MiB/s; the 1 GiB deadline is ${deadline} ms, and 1 GiB at this rate takes ${((1024 / disk.mibps) * 1000).toFixed(0)} ms`);
      // A 1 GiB file of 1,024 equal random 1 MiB blocks. The changed form inverts the first block in place, so a restore writes 1 MiB.
      const repo = join(fixtureDir("t048-gib"), "repo");
      mkdirSync(repo, { recursive: true });
      git(repo, ["init", "-q", "-b", "main"]);
      for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"]] as const) git(repo, ["config", key, value]);
      const block = new Uint8Array(MIB);
      crypto.getRandomValues(block.subarray(0, 65_536));
      for (let i = 65_536; i < MIB; i += 65_536) block.set(block.subarray(0, 65_536), i);
      // getRandomValues gives at most 65,536 bytes per call, so the 1 MiB block repeats one 64 KiB part. Git sees NUL bytes, so the file is binary.
      const path = "huge.bin";
      const write = (changed: boolean) => {
        const fd = openSync(join(repo, path), changed ? "r+" : "w");
        try {
          const first = changed ? block.map((b) => b ^ 0xff) : block;
          writeSync(fd, first, 0, MIB, 0);
          if (!changed) for (let i = 1; i < GIB / MIB; i++) writeSync(fd, block, 0, MIB, i * MIB);
        } finally {
          closeSync(fd);
        }
      };
      const built = performance.now();
      write(false);
      git(repo, ["add", "--", path]);
      git(repo, ["commit", "-q", "--no-verify", "-m", "1 GiB"]);
      write(true);
      console.log(`OBSERVATION ${TASK}: the 1 GiB repository took ${((performance.now() - built) / 1000).toFixed(1)} s to build`);
      const old = [{ path, old: sha256(readFileSync(join(repo, path))) }];
      const s = await windowsSession("gib", repo);
      try {
        const services = descendants(s.app.pid).filter((r) => r.name.toLowerCase() === SERVICE_EXE);
        if (services.length !== 1) throw new Error(`the app has ${services.length} ${SERVICE_EXE} processes`);
        const sampler = startSampler(services[0]!.pid);
        await sampleAfter(sampler, 0);
        try {
          const ends: number[] = [];
          const grown: number[] = [];
          for (let run = 0; run <= RUNS + 1; run++) {
            step(`gib-run-${run}`);
            const probe = run === RUNS + 1;
            const from = Date.now();
            const r = await revertRun(s, row(path), `!${row(path)}`, probe);
            const g = await growth(sampler, from, Date.now());
            console.log(memoryLine("SC-007 1 GiB, service tree", run, g));
            if (!probe) console.log(`OBSERVATION ${TASK}: SC-007 1 GiB run ${run}: ${(1024 / (r.shown / 1000)).toFixed(1)} MiB/s from the revert button to the end`);
            if (counted("1 GiB file", r.reply, winRead(repo), old) && !probe && run > 0) {
              ends.push(r.shown);
              grown.push(g.growth);
            }
            write(true);
            await refreshed(s.c, "the restored 1 GiB file", `!!${row(path)}`);
          }
          const m = record("SC-007 Revert file of one 1 GiB binary file: the revert button to the end", ends, GIB_MS);
          expect({ end: m <= GIB_MS, memory: grown.length > 0 && grown.every((x) => x <= MEMORY_BYTES), disk: disk.mibps >= DISK_MIBPS }).toEqual({ end: true, memory: true, disk: true });
        } finally {
          await sampler.stop();
        }
      } finally {
        await end(s);
      }
    },
    caseTimeout(60, (RUNS + 3) * 2 * STEP_LIMIT_MS + 10 * 60_000),
  );

  // ---- WSL (research.md R12: the same fixture in the owned distro folder, measured from the Windows package) ----

  const host = reason === null ? wslHost() : null;
  const wslMissing = reason === null ? missingCapability(["wsl-fixture-fs-id", "distro-git-2.55"]) : null;
  // The 008 WSL rows use Ubuntu-26.04 (tasks.md T047, T049).
  const wslReason = reason ?? wslMissing ?? (host?.distro === "Ubuntu-26.04" ? null : `ubuntu-26.04: the test distro is ${host?.distro ?? "absent"}`);
  if (wslReason !== null) console.log(`SKIP ${TASK} WSL: ${wslReason}`);
  const TAR = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  // The Windows `tar` stream goes to `tar -x` in the distro (tests/wsl/workbench-wsl-harness.ts `toDistro`).
  function toDistro(from: string, entry: string, linuxDir: string): void {
    const tar = Bun.spawnSync([TAR, "--no-acls", "--no-xattrs", "--no-fflags", "-c", "-f", "-", "-C", from, entry], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 300_000 });
    if (tar.exitCode !== 0) throw new Error(`tar -c of ${from} exited ${tar.exitCode}: ${tar.stderr.toString()}`);
    const x = wslExec(["--distribution", host!.distro, "--cd", "/", "--exec", "/usr/bin/tar", "-x", "-f", "-", "-C", linuxDir], { input: new Uint8Array(tar.stdout), timeoutMs: 300_000 });
    if (x.exitCode !== 0) throw new Error(`tar -x into ${linuxDir} exited ${x.exitCode}: ${x.stderr}`);
  }

  test.skipIf(wslReason !== null)(
    "SC-007, SC-011: Revert all unstaged changes of 1,000 files in the owned Ubuntu-26.04 folder ends within 30 s from the Windows package (median of 10)",
    async () => {
      const winRepo = revertCopy("t048-wsl");
      onlySmall(winRepo);
      const linuxRoot = `${host!.folder}/t048`;
      inDistro(host!.distro, ["/usr/bin/mkdir", "--", linuxRoot]);
      toDistro(join(winRepo, ".."), "repo", linuxRoot);
      const linuxRepo = `${linuxRoot}/repo`;
      const dgit = (args: string[], allowExit = [0]) => inDistro(host!.distro, ["/usr/bin/git", "-C", linuxRepo, ...args], { allowExit, timeoutMs: 300_000 });
      // Git for Windows writes these keys at `init`, so the distro copy drops them (as `toDistro`).
      for (const key of ["core.symlinks", "core.ignorecase", "core.filemode"]) dgit(["config", "--local", "--unset", key], [0, 5]);
      dgit(["update-index", "-q", "--refresh"], [0, 1]);
      // The restore source: the unstaged forms of the 1,000 files below `rv/u`, sent by one tar stream per run.
      const restoreRoot = fixtureDir("t048-wsl-restore");
      mkdirSync(join(restoreRoot, "rv", "u"), { recursive: true });
      for (let i = 0; i < RV_SMALL; i++) writeFileSync(join(restoreRoot, rvSmallPath(i)), rvSmall(rvSmallPath(i), "unstaged"));
      const distroRead = (path: string) => Buffer.from(inDistro(host!.distro, ["/usr/bin/cat", "--", `${linuxRepo}/${path}`]), "utf8");
      const folder = uncPath(host!, linuxRepo);
      // The switcher label of a distro repository is not fixed by a 001 text. The case waits for a label that names the folder.
      const s = await session("wsl", folder, (v) => v !== null && v.startsWith("repo, "), true);
      try {
        const n = fmt.format(RV_SMALL);
        await until<string>(s.c, "1,000 unstaged files", count("Changes"), (v) => v === n);
        const ends: number[] = [];
        for (let run = 0; run <= RUNS + 1; run++) {
          step(`wsl-1000-run-${run}`);
          const probe = run === RUNS + 1;
          // Run 7 reached 155 of 1,000 files in 60 s, so the step bound is the test bound of the limit case. A miss stays a budget failure.
          const r = await revertAll(s, probe, LIMIT_RUN_MS);
          if (counted("WSL 1,000 unstaged files", r.reply, distroRead, smallTargets()) && !probe && run > 0) ends.push(r.end);
          toDistro(restoreRoot, "rv", linuxRepo);
          await refreshed(s.c, "the restored 1,000 files", `${count("Changes")} === ${js(n)}`);
        }
        expect(record("SC-007 Revert all unstaged changes of 1,000 files on WSL: the revert button to the end", ends, UNSTAGED_1000_WSL_MS)).toBeLessThanOrEqual(UNSTAGED_1000_WSL_MS);
      } finally {
        await end(s);
      }
    },
    caseTimeout(60, (RUNS + 2) * LIMIT_RUN_MS + (RUNS + 3) * 3 * STEP_LIMIT_MS + 10 * 60_000),
  );
});
