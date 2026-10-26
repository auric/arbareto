// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T061: the feature 005 timing and memory budgets in the installed package (plan.md P9, WP8). Quickstart.md Q6, Q21, Q29, and Q32. `Local: package`.
// Spec FR-004, FR-007, FR-012, FR-039, FR-063, SC-001, SC-002, SC-005, SC-006, SC-009. Each timing is the median of 10 counted runs after one warm-up run.
// The cases drive the page through the WebView2 CDP endpoint and UI Automation patterns. They send no OS input and never move the pointer.
// Page timing: the time from the `timeStamp` of the input event to the start of the first animation frame whose page holds the result.
// It leaves out the OS input path and the compositor, so it is not the 001 visible response of the capture source (001 plan.md "Capture source").
// SC-009 takes each input duration from the W3C Event Timing API: the time from the event to the next paint after its handlers.
// The 001 capture check of the same steps needs the qualified 001 measurement tools. Until then it is a recorded capability skip, and the task stays open.

import { afterAll, describe, expect, test } from "bun:test";
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { printOrigin } from "../origin";
import { buildPathsBound, faGit } from "../git/file-actions-fixtures";
import { fixtureDir, FIXTURE_ROOT, ownedGit, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { blameLarge, buildWide, wideLarge } from "../git/history-diff-fixtures";
import { untrackedFixture } from "../git/workbench-fixtures";
import { connectPage, freePort, MOD, watchIpc, type Cdp, type IpcLog } from "./cdp";
import { appEnv, COMMIT_VIEW, descendants, findInstalledApp, powershellJson, PROBE_TIMEOUT_MS, processRecords, startInstalledApp, WAIT_MS, waitExit, type OwnedProcess, type ProcessRecord } from "./installed-app";
import { PERF_CACHE_ROOT } from "./perf-fixtures";
import { goneAt, seen, startPoller, type Sample } from "./process-poller";
import { close, ControlType, expand, find, invoke, MAX_CALL_MS, MAX_WAIT_MS, setValue, type Element } from "./uia";

for (const helper of ["./cdp.ts", "./process-poller.ts", "./uia.ts", "./installed-app.ts", "../git/file-actions-fixtures.ts", "../git/history-diff-fixtures.ts", "../git/workbench-fixtures.ts"]) printOrigin(helper, import.meta.dir);

const TASK = "T061";
const STEP_MS = MAX_WAIT_MS + MAX_CALL_MS;
const caseTimeout = (steps: number, extraMs = 0) => steps * STEP_MS + 2 * PROBE_TIMEOUT_MS + 2 * WAIT_MS + extraMs;
// "Warm package, median of 10": one warm-up run, then the counted runs.
const RUNS = 10;
// The page waits for each step at most this long. A step past it fails the case.
const STEP_LIMIT_MS = 60_000;
const OPEN_WAIT_MS = 120_000;
// Contract Δ3 `readBlame`: the blame step has the history process deadline (120 s).
const BLAME_WAIT_MS = 120_000;
// The poller loop ends by itself after this time. One blame run lasts far less.
const POLLER_LIFETIME_MS = 5 * 60_000;

// ---- Budgets (spec SC-001, SC-002, SC-005, SC-006, SC-009; 001 SC-005; 004 SC-007) ----

const LIST_MS = 300;
const FIRST_DIFF_MS = 150;
const NEXT_FILE_MS = 150;
const PREVIEW_MS = 5_000;
const FIRST_PROGRESS_MS = 500;
const CANCEL_MS = 1_000;
const MEMORY_BYTES = 64 * 1024 * 1024;
const INPUT_P95_MS = 100;
const INPUT_MAX_MS = 500;
// The Event Timing API reports no entry below its 16 ms minimum `durationThreshold`, so such an input counts as 16 ms.
const EVENT_THRESHOLD_MS = 16;
// The 001 probe interval during a workload (001 plan.md "Responsiveness metrics").
const PROBE_INTERVAL_MS = 100;

// ---- App texts (the source of each value is named) ----

const OPEN_FOLDER = "Open folder… (Ctrl+O)";
// src/frontend/app/RepositoryMenu.tsx.
const REPOSITORY = "Repository";
const EDIT_GITIGNORE = "Edit .gitignore";
// src/frontend/history/CommitChanges.tsx `limitText`; its `Intl.NumberFormat` groups the digits.
const count = new Intl.NumberFormat("en-US");
const limitText = (n: number) => `This commit changes more files than Arbareto shows. Arbareto shows the first ${count.format(n)}.`;
// src/frontend/history/HistoryFilter.tsx `FILTER_LABEL`: only Enter starts a search, so a typed probe starts no read.
const HISTORY_FILTER = "Filter commit messages";
// src/frontend/commit/CommitTray.tsx.
const MESSAGE = "Commit message";

// ---- CDP keys (as tests/windows/inspection-packaged.test.ts) ----

const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", vk: 0x0d, text: "\r" },
  Escape: { key: "Escape", code: "Escape", vk: 0x1b },
  Tab: { key: "Tab", code: "Tab", vk: 0x09 },
  Delete: { key: "Delete", code: "Delete", vk: 0x2e },
  Home: { key: "Home", code: "Home", vk: 0x24 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 0x26 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 0x27 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 0x28 },
  F5: { key: "F5", code: "F5", vk: 0x74 },
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
  if (!done(value)) throw new Error(`${what} did not happen within ${ms} ms: ${js(value)}`);
  return value;
}
async function focusOn(c: Cdp, expression: string, what: string): Promise<void> {
  await until<boolean>(c, `${what} shows`, `!!(${expression})`, (v) => v);
  await c.evaluate(`(${expression}).focus(); true`);
  await until<boolean>(c, `${what} has focus`, `document.activeElement === (${expression})`, (v) => v);
}

// ---- Page timing ----

// The page helpers. `arm` records the `timeStamp` of the next input event and resolves with the frame time at which each check first holds.
// The frame loop runs only while the page is visible (HTML "update the rendering"). `__t061Previews` is the count of `preview_ignore` replies.
// The CDP `Network` record of the calls sets it (`session`), because `window.__TAURI_INTERNALS__.invoke` is read-only and non-configurable.
const PAGE = `(() => {
  if (window.__t061 !== undefined) return true;
  window.__t061Previews = 0;
  window.__t061Keys = [];
  window.__t061Events = [];
  addEventListener('keydown', (e) => window.__t061Keys.push(e.timeStamp), { capture: true });
  new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.name === 'keydown') window.__t061Events.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'event', durationThreshold: ${EVENT_THRESHOLD_MS} });
  window.__t061 = {
    arm(checks, limit) {
      let start = null;
      const onInput = (e) => { if (start === null) start = e.timeStamp; };
      for (const type of ['keydown', 'beforeinput']) addEventListener(type, onInput, { capture: true });
      const done = checks.map(() => null);
      this.value = null;
      const end = (ok) => {
        for (const type of ['keydown', 'beforeinput']) removeEventListener(type, onInput, { capture: true });
        this.value = { ok, start, times: done.map((t) => (t === null || start === null ? null : t - start)) };
      };
      const step = (now) => {
        if (start !== null) checks.forEach((check, i) => { if (done[i] === null && check()) done[i] = now; });
        if (start !== null && done.every((t) => t !== null)) return end(true);
        if (start !== null && now - start > limit) return end(false);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      return true;
    },
  };
  return true;
})()`;

// Arms the page, runs `act` (which sends the input), and returns the time of each check after the input, in ms.
async function timed(c: Cdp, checks: string[], act: () => Promise<void>): Promise<number[]> {
  await c.evaluate(`window.__t061.arm([${checks.map((check) => `() => (${check})`).join(", ")}], ${STEP_LIMIT_MS})`);
  await act();
  // `cdp.ts` ends one call after 10 s, so the page sets `value` and the test polls it up to the step limit.
  const r = (await until<{ ok: boolean; start: number | null; times: (number | null)[] } | null>(c, "the timed step", "window.__t061.value", (v) => v !== null, STEP_LIMIT_MS + 5_000))!;
  if (!r.ok) throw new Error(`a step did not show within ${STEP_LIMIT_MS} ms: ${js(r)}`);
  return r.times as number[];
}

const median = (xs: number[]) => {
  const s = xs.toSorted((a, b) => a - b);
  return s.length % 2 === 1 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
// 001 plan.md "Responsiveness metrics": the nearest-rank p95.
const p95 = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.max(0, Math.ceil(0.95 * xs.length) - 1)]!;
const rounded = (xs: number[]) => xs.map((x) => Math.round(x * 10) / 10);
function record(what: string, runs: number[], budget?: number): number {
  const m = median(runs);
  console.log(`OBSERVATION ${TASK}: ${what}: runs ${js(rounded(runs))} ms, median ${m.toFixed(1)} ms${budget === undefined ? "" : `, budget ${budget} ms`}`);
  return m;
}

// ---- SC-009 inputs (W3C Event Timing) ----

// Starts a new input window: every keydown after it counts.
const openWindow = (c: Cdp) => c.evaluate("(window.__t061Keys = [], window.__t061Events = [], true)");
// The duration of each keydown since `openWindow`, after the observer got the entries of the last paint.
async function closeWindow(c: Cdp, label: string): Promise<void> {
  await c.evaluate("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))");
  const { keys, events } = await c.evaluate<{ keys: number[]; events: { start: number; duration: number }[] }>("({ keys: window.__t061Keys, events: window.__t061Events })");
  const durations = keys.map((k) => events.find((e) => e.start === k)?.duration ?? EVENT_THRESHOLD_MS);
  console.log(`OBSERVATION ${TASK}: SC-009 ${label}: ${durations.length} inputs, p95 ${durations.length === 0 ? "-" : p95(durations)} ms, max ${durations.length === 0 ? "-" : Math.max(...durations)} ms, durations ${js(durations)}`);
  expect(durations.length).toBeGreaterThan(0);
  expect({ label, p95: p95(durations) <= INPUT_P95_MS, max: Math.max(...durations) <= INPUT_MAX_MS }).toEqual({ label, p95: true, max: true });
}

// `trigger` sends the input that starts the read or action. Then a probe input goes to the page every 100 ms until `finish` resolves.
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

// ---- Process facts ----

type Sized = ProcessRecord & { privateBytes: number };
function sizedRecords(): Sized[] {
  return powershellJson(
    `$r = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; name = $_.Name; commandLine = $_.CommandLine; created = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc().ToString() } else { $null }; privateBytes = [int64]$_.PrivatePageCount } })
ConvertTo-Json -Compress -InputObject $r`,
  ) as Sized[];
}
// Spec SC-002: the private bytes of the app and of every process below it (001 plan.md: sum private bytes, never working sets).
function treeBytes(root: number): number {
  const records = sizedRecords();
  const tree = [records.find((r) => r.pid === root), ...(descendants(root, records) as Sized[])].filter((r): r is Sized => r !== undefined);
  return tree.reduce((n, r) => n + r.privateBytes, 0);
}

const { ptr: P, u32, i32 } = FFIType;
const openKernel = () =>
  dlopen("kernel32.dll", {
    OpenProcess: { args: [u32, i32, u32], returns: P },
    WaitForSingleObject: { args: [P, u32], returns: u32 },
    GetProcessTimes: { args: [P, P, P, P, P], returns: i32 },
    GetSystemTimePreciseAsFileTime: { args: [P], returns: FFIType.void },
    CloseHandle: { args: [P], returns: i32 },
  }).symbols;
let kernel: ReturnType<typeof openKernel> | undefined;
// The DLL exists only on Windows, so the import of this file must not open it.
const k32 = () => (kernel ??= openKernel());
// winnt.h `SYNCHRONIZE` and `PROCESS_QUERY_LIMITED_INFORMATION`; winbase.h `WAIT_OBJECT_0`.
const SYNCHRONIZE = 0x0010_0000;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const WAIT_OBJECT_0 = 0;
// The system time as a FILETIME, the time base of `GetProcessTimes`.
function systemTime(): bigint {
  const ft = new BigUint64Array(1);
  k32().GetSystemTimePreciseAsFileTime(ptr(ft));
  return ft[0]!;
}
// Opens each process before the event that should end it, so a process that ends at once still gives its exit time.
function holdProcesses(pids: number[]): { exits(ms: number): (bigint | null)[] } {
  const handles = pids.map((pid) => k32().OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) as Pointer | null);
  return {
    // Microsoft Learn `GetProcessTimes`: the exit time of an ended process. A process that does not end within `ms` gives null.
    exits(ms: number) {
      try {
        return handles.map((h) => {
          if (h === null || k32().WaitForSingleObject(h, ms) !== WAIT_OBJECT_0) return null;
          const times = new BigUint64Array(4);
          return k32().GetProcessTimes(h, ptr(times, 0), ptr(times, 8), ptr(times, 16), ptr(times, 24)) !== 0 ? times[1]! : null;
        });
      } finally {
        for (const h of handles) if (h !== null) k32().CloseHandle(h);
      }
    },
  };
}

describe.skipIf(process.platform !== "win32")("T061 packaged inspection timing and memory", () => {
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
  const reason =
    installed === null ? (discovery as { skip: string }).skip : GIT === null ? "Git executable absent" : others.length > 0 ? `another-instance: ${installed.mainBinaryName} runs as PID ${others.map((r) => r.pid).join(", ")}` : null;
  if (reason !== null) console.log(`SKIP installed app: ${reason}`);

  const git = (repo: string, args: string[]) => faGit(GIT!, repo, args).toString("utf8");
  const under = (root: string, repo: string) => !relative(root, repo).startsWith("..") && !isAbsolute(relative(root, repo));
  // A read-only case opens a PERF_CACHE_ROOT repository in place. `faGit` accepts only FIXTURE_ROOT.
  const top = (repo: string) => ownedGit(GIT!, under(PERF_CACHE_ROOT, repo) ? PERF_CACHE_ROOT : FIXTURE_ROOT, repo, ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  const switcher = `document.querySelector('button[aria-keyshortcuts="Control+R"]')?.getAttribute('aria-label') ?? null`;

  async function use<T>(element: Promise<Element>, body: (element: Element) => T): Promise<T> {
    const found = await element;
    try {
      return body(found);
    } finally {
      found.release();
    }
  }
  const uia = <T>(pid: number, name: string, type: number | undefined, body: (element: Element) => T) => use(find(pid, name, MAX_WAIT_MS, type), body);

  // A read-only session may open the 001 fixture cache in place, as tests/git/file-actions-facts.test.ts reads it.
  async function session(label: string, repo: string): Promise<{ app: OwnedProcess; c: Cdp; ipc: IpcLog }> {
    if (repo === "" || !isAbsolute(repo) || !(under(FIXTURE_ROOT, repo) || under(PERF_CACHE_ROOT, repo))) throw new Error(`the repository is outside the fixture roots: ${JSON.stringify(repo)}`);
    const env = appEnv(fixtureDir(`${label}-app`), false);
    const port = freePort();
    env.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port}`;
    const app = startInstalledApp(installed!, env);
    owned.add(app);
    console.log(`STARTED ${TASK}: ${app.pid} ${label} port=${port}`);
    await uia(app.pid, "Select Git", ControlType.Button, invoke);
    await uia(app.pid, "Use this Git", undefined, invoke);
    await uia(app.pid, OPEN_FOLDER, undefined, invoke);
    await uia(app.pid, "Folder:", ControlType.Edit, (field) => setValue(field, repo));
    await uia(app.pid, "Select Folder", ControlType.Button, invoke);
    const c = await connectPage(port, MAX_WAIT_MS);
    sockets.add(c);
    const root = top(repo);
    await until<string | null>(c, "the open repository", switcher, (v) => v === `${basename(root)}, ${root}`, OPEN_WAIT_MS);
    // A hidden page runs no animation frame, so page timing needs the visible window.
    expect(await c.evaluate<string>("document.visibilityState")).toBe("visible");
    expect(await c.evaluate<boolean>(PAGE)).toBe(true);
    let previews = 0;
    // A preview reply arrives after "Updating preview…" renders, so a late count update only delays the check. A lost update fails it at its limit.
    const ipc = await watchIpc(c, (call) => void (call.command === "preview_ignore" && c.evaluate(`window.__t061Previews = ${++previews}`).catch(() => {})));
    return { app, c, ipc };
  }
  async function end(s: { app: OwnedProcess; c: Cdp }): Promise<void> {
    s.c.close();
    sockets.delete(s.c);
    s.app.stop();
    owned.delete(s.app);
    expect(await waitExit(s.app)).not.toBeNull();
  }

  const list = `document.querySelector('[data-history-list]')`;
  const activeRow = `document.getElementById(${list}.getAttribute('aria-activedescendant'))?.dataset.rowId ?? null`;
  const heading = `(document.querySelector('[data-section=changedFiles] h3')?.textContent ?? '')`;
  const diffHeader = `(document.querySelector('[data-section=historyDiff] [data-slot=diff-header]')?.textContent ?? '')`;
  const changedRows = `document.querySelectorAll('[data-section=changedFiles] [role=tree] [role=treeitem]').length`;
  const historyProbe = (c: Cdp) => async () => {
    if ((await c.evaluate<string | null>("document.activeElement?.getAttribute('aria-label') ?? null")) !== HISTORY_FILTER) await c.evaluate(`document.querySelector('[aria-label=${js(HISTORY_FILTER)}]').focus(); true`);
    await press(c, "x");
  };
  const messageProbe = (c: Cdp) => async () => {
    const message = `document.querySelector('[aria-label=${js(MESSAGE)}]')`;
    if (!(await c.evaluate<boolean>(`document.activeElement === ${message}`))) await c.evaluate(`${message}.focus(); true`);
    await press(c, "x");
  };

  // Moves the History selection to `oid` with Home and the arrow keys. The History list keeps the focus.
  async function selectRow(c: Cdp, oid: string): Promise<void> {
    await focusOn(c, list, "the History list");
    // HistoryList.tsx: an arrow move to a row that is not loaded selects it only when its page arrives.
    await until<boolean>(c, `the row ${oid}`, `!!${list}?.querySelector(${js(`[data-row-id="${oid}"]`)})`, (v) => v);
    await press(c, "Home");
    for (let i = 0; i < 8 && (await c.evaluate<string | null>(activeRow)) !== oid; i++) await press(c, "ArrowDown");
    if ((await c.evaluate<string | null>(activeRow)) !== oid) throw new Error(`the History list did not reach ${oid}`);
  }

  test.skipIf(reason !== null)(
    "Q6 SC-001, FR-007: on the 1,000-file commit the list shows within 300 ms, the first diff within 150 ms more, and the next file within 150 ms (median of 10)",
    async () => {
      const b = buildWide(GIT!, "t061-wide");
      const s = await session("wide", b.repo);
      try {
        const list1000 = `${heading} === 'Changed files (1,000)' && ${changedRows} > 0`;
        const selected = `document.querySelector('[data-section=changedFiles] [role=treeitem][aria-selected=true]')`;
        const series = { list: [] as number[], firstDiff: [] as number[], next: [] as number[] };
        // History holds the rows Working directory, Index, wide, and base. The base commit lists one file, so each run reads the 1,000-file listing again.
        for (let run = 0; run <= RUNS; run++) {
          await selectRow(s.c, b.oids.base!);
          await until<string>(s.c, "the base listing", heading, (v) => v === "Changed files (1)");
          const [listed, first] = await timed(s.c, [list1000, `${list1000} && ${diffHeader}.includes('w/f0000.txt')`], () => press(s.c, "ArrowUp"));
          await focusOn(s.c, selected, "the selected changed file");
          const [next] = await timed(s.c, [`${diffHeader}.includes('w/f0001.txt')`], () => press(s.c, "ArrowDown"));
          if (run === 0) continue;
          series.list.push(listed!);
          series.firstDiff.push(first! - listed!);
          series.next.push(next!);
        }
        const m = { list: record("SC-001 list", series.list, LIST_MS), firstDiff: record("SC-001 first diff after the list", series.firstDiff, FIRST_DIFF_MS), next: record("SC-001 next file", series.next, NEXT_FILE_MS) };
        expect({ list: m.list <= LIST_MS, firstDiff: m.firstDiff <= FIRST_DIFF_MS, next: m.next <= NEXT_FILE_MS }).toEqual({ list: true, firstDiff: true, next: true });
        // SC-009 during the 1,000-file read: the probes type into the History filter.
        await selectRow(s.c, b.oids.base!);
        await until<string>(s.c, "the base listing", heading, (v) => v === "Changed files (1)");
        await probing(s.c, "the 1,000-file read", historyProbe(s.c), () => press(s.c, "ArrowUp"), () => until<boolean>(s.c, "the 1,000-file listing", list1000, (v) => v));
      } finally {
        await end(s);
      }
    },
    caseTimeout(40, (RUNS + 2) * 3 * STEP_LIMIT_MS),
  );

  test.skipIf(reason !== null)(
    "Q6 SC-002, FR-012: the 100,001-file commit shows exactly the first files up to the bound with the limit text, and the process tree uses at most 64 MiB more than before the selection",
    async () => {
      const cached = wideLarge(GIT!);
      const repo = join(fixtureDir("t061-wide-large"), "repo");
      cpSync(cached.repo, repo, { recursive: true });
      const s = await session("wide-large", repo);
      try {
        // The selection starts on the Index row, so the measured key selects the commit and starts the read.
        await selectRow(s.c, "index");
        const before = treeBytes(s.app.pid);
        const samples: number[] = [];
        const shown = await probing(
          s.c,
          "the 100,001-file read",
          historyProbe(s.c),
          async () => {
            await focusOn(s.c, list, "the History list");
            await press(s.c, "ArrowDown");
          },
          async () => {
            for (const end = performance.now() + STEP_LIMIT_MS; ; ) {
              samples.push(treeBytes(s.app.pid));
              const m = /^Changed files \(([\d,]+)\)$/.exec(await s.c.evaluate<string>(heading));
              if (m !== null) return Number(m[1]!.replaceAll(",", ""));
              if (performance.now() >= end) throw new Error("the limited listing did not show");
            }
          },
        );
        expect(await s.c.evaluate<string | null>(activeRow)).toBe(cached.oids.wide!);
        for (let i = 0; i < 3; i++) samples.push(treeBytes(s.app.pid));
        const peak = Math.max(...samples);
        console.log(`OBSERVATION ${TASK}: SC-002 process tree private bytes before ${before}, peak ${peak}, growth ${((peak - before) / 1048576).toFixed(1)} MiB, ${shown} files shown`);
        expect(await until<boolean>(s.c, "the limit text", `document.querySelector('[data-section=changedFiles]').textContent.includes(${js(limitText(shown))})`, (v) => v)).toBe(true);
        expect({ bounded: shown > 0 && shown < 100_001, growth: peak - before <= MEMORY_BYTES }).toEqual({ bounded: true, growth: true });
      } finally {
        await end(s);
      }
    },
    caseTimeout(30, 4 * STEP_LIMIT_MS),
  );

  // Edit .gitignore through the Repository menu (spec FR-034). The menu switches to the Commit view and opens the editor.
  async function openEditor(pid: number, c: Cdp): Promise<string> {
    await uia(pid, REPOSITORY, ControlType.MenuItem, expand);
    await uia(pid, EDIT_GITIGNORE, ControlType.MenuItem, invoke);
    const field = `document.querySelector('[data-slot=ignore-editor] textarea')`;
    await until<boolean>(c, "the ignore editor", `!!${field}`, (v) => v, OPEN_WAIT_MS);
    return field;
  }
  const previewText = `(document.querySelector('[data-section=ignorePreview]')?.textContent ?? '')`;
  // A new `previewIgnore` reply, rendered: the groups show and "Updating preview…" is gone (src/frontend/ignore/IgnoreEditor.tsx `Preview`).
  const previewShown = (replies: number) => `window.__t061Previews > ${replies} && !${previewText}.includes('Updating preview') && ${previewText}.includes('Newly ignored')`;
  // A typed line at the end of the editor text starts one preview after the 400 ms pause of the renderer (contract Δ3 `previewIgnore`).
  async function typeLine(c: Cdp, ipc: IpcLog, field: string, n: number): Promise<number> {
    const replies = ipc.finished("preview_ignore").length;
    await c.evaluate(`${field}.focus(); ${field}.setSelectionRange(${field}.value.length, ${field}.value.length); true`);
    await c.send("Input.insertText", { text: `# t061 ${n}\n` });
    return replies;
  }
  // Runs `act` and waits for the reply of a read with a new snapshot and, when it has a cursor, for its last `readEntries` page.
  // The renderer commits a paged snapshot only after its last page (src/frontend/state/requests.ts `fetchPage`).
  // The preview starts 400 ms after the typed line, so it names the committed snapshot.
  async function newSnapshot(ipc: IpcLog, act: () => Promise<void>): Promise<void> {
    type Reply = { result?: { snapshotId?: string; cursor?: string | null } };
    const reads = ipc.finished("read_workspace");
    const before = reads.length === 0 ? null : (await ipc.body<Reply>(reads.at(-1)!)).result?.snapshotId;
    let pages = ipc.finished("read_entries").length;
    await act();
    const end = performance.now() + STEP_LIMIT_MS;
    let paged: boolean | null = null;
    for (let seen = reads.length; ; await Bun.sleep(50)) {
      if (performance.now() >= end) throw new Error(`no new snapshot within ${STEP_LIMIT_MS} ms`);
      const next = ipc.finished("read_workspace");
      for (; paged === null && seen < next.length; seen++) {
        const r = (await ipc.body<Reply>(next[seen]!)).result;
        if (r?.snapshotId !== undefined && r.snapshotId !== before) paged = r.cursor !== null && r.cursor !== undefined;
      }
      if (paged === false) return;
      if (paged === null) continue;
      const list = ipc.finished("read_entries");
      for (; pages < list.length; pages++) if ((await ipc.body<Reply>(list[pages]!)).result?.cursor === null) return;
    }
  }
  async function previewRun(c: Cdp, ipc: IpcLog, field: string, n: number): Promise<number> {
    const replies = ipc.finished("preview_ignore").length;
    const [shown] = await timed(c, [previewShown(replies)], () => typeLine(c, ipc, field, n).then(() => {}));
    return shown!;
  }

  test.skipIf(reason !== null)(
    "Q21 SC-005, FR-039: every preview of 100,000 paths shows within 5 s, the first preview of a snapshot and the later previews recorded apart (median of 10 each)",
    async () => {
      const f = buildPathsBound(GIT!, "t061-preview");
      const s = await session("preview", f.repo);
      try {
        await uia(s.app.pid, COMMIT_VIEW, ControlType.Button, invoke);
        const field = await openEditor(s.app.pid, s.c);
        const first: number[] = [];
        const later: number[] = [];
        let n = 0;
        for (let run = 0; run <= RUNS; run++) {
          // Plan.md D9: a new snapshot builds a new base, so the next preview is the first one of that snapshot.
          // 001 data-model §4: an equal full read keeps the snapshot. So each run adds or removes the `.M` entry of the tracked `t/.gitignore`.
          // A comment line keeps its rules, and a tracked file adds no preview input. A new untracked file would pass PREVIEW_PATHS.
          writeFileSync(join(f.repo, "t", ".gitignore"), run % 2 === 0 ? "x\n# t061\n" : "x\n");
          await s.c.evaluate(`${field}.blur(); true`);
          await newSnapshot(s.ipc, () => press(s.c, "F5"));
          const a = await previewRun(s.c, s.ipc, field, ++n);
          const b = await previewRun(s.c, s.ipc, field, ++n);
          if (run === 0) continue;
          first.push(a);
          later.push(b);
        }
        const m = { first: record("SC-005 first preview of a snapshot", first, PREVIEW_MS), later: record("SC-005 later preview", later, PREVIEW_MS) };
        expect({ first: Math.max(...first) <= PREVIEW_MS, later: Math.max(...later) <= PREVIEW_MS, firstMedian: m.first <= PREVIEW_MS, laterMedian: m.later <= PREVIEW_MS }).toEqual({ first: true, later: true, firstMedian: true, laterMedian: true });
        // SC-009 during a preview: the probes type into the commit message field.
        let replies = 0;
        await probing(
          s.c,
          "the 100,000-path preview",
          messageProbe(s.c),
          async () => void (replies = await typeLine(s.c, s.ipc, field, ++n)),
          () => until<boolean>(s.c, "the preview", previewShown(replies), (v) => v),
        );
      } finally {
        await end(s);
      }
    },
    caseTimeout(30, (2 * RUNS + 4) * STEP_LIMIT_MS),
  );

  test.skipIf(reason !== null)(
    "Q29 SC-006, FR-063: the first blame progress of the 10,000-line, 5,000-commit file shows within 500 ms, and Cancel ends Git within 1 s, with and without an ignore list (median of 10)",
    async () => {
      const cached = blameLarge(GIT!);
      const repo = join(fixtureDir("t061-blame"), "repo");
      cpSync(cached.repo, repo, { recursive: true });
      const s = await session("blame", repo);
      try {
        const blameButton = `[...document.querySelectorAll('[data-section=historyDiff] button')].find((e) => e.textContent.trim() === 'Blame')`;
        const status = `(document.querySelector('[data-slot=blame-view] [role=status]')?.textContent ?? '')`;
        const cancel = `[...document.querySelectorAll('[data-slot=blame-view] button')].find((e) => e.textContent.trim() === 'Cancel')`;
        // A Git blame process below the app, created at or after `start`. `base` holds the app tree before the blame.
        const blameGit = (base: ProcessRecord[], start: bigint) => (r: ProcessRecord, sample: Sample) =>
          / blame /.test(r.commandLine ?? "") && r.created !== null && BigInt(r.created) >= start && descendants(s.app.pid, [...base, ...sample.records]).includes(r);
        // One run: Blame from the History diff, then Cancel. The exit time of each Git blame process gives the Cancel time.
        async function run(ignoreList: boolean): Promise<{ progress: number | null; cancel: number }> {
          await selectRow(s.c, cached.oids.tip!);
          await until<string>(s.c, "the big.txt diff", diffHeader, (v) => v.includes("big.txt"));
          await focusOn(s.c, blameButton, "Blame");
          const base = processRecords().filter((r) => r.name.toLowerCase() !== "git.exe");
          const poller = await startPoller("git.exe", POLLER_LIFETIME_MS, PROBE_TIMEOUT_MS);
          try {
            const start = systemTime();
            // Spec FR-063: without an ignore list Git gives counts, so the first progress is the first "Blaming… <n> of <total> lines".
            let progress: number | null = null;
            if (ignoreList) {
              await press(s.c, "Enter");
              await until<string>(s.c, "the busy state", status, (v) => v === "Blaming…");
            } else progress = (await timed(s.c, [`/^Blaming… [\\d,]+ of [\\d,]+ lines$/.test(${status})`], () => press(s.c, "Enter")))[0]!;
            const procs = await poller.until((samples) => {
              const found = seen(samples, blameGit(base, start));
              return found.length > 0 ? found : null;
            }, STEP_LIMIT_MS);
            const held = holdProcesses(procs.map((r) => r.pid));
            await focusOn(s.c, cancel, "Cancel");
            expect((await s.c.evaluate<string>(status)).startsWith("Blaming")).toBe(true);
            const at = systemTime();
            await press(s.c, "Enter");
            const ended = held.exits(10 * CANCEL_MS);
            expect(ended.every((t) => t !== null)).toBe(true);
            const last = (ended as bigint[]).reduce((a, b) => (a > b ? a : b));
            // FILETIME counts 100 ns units. A negative time means that Git ended before the Cancel, so the run measures nothing.
            const cancelMs = Number(last - at) / 10_000;
            expect(cancelMs).toBeGreaterThanOrEqual(0);
            await press(s.c, "Escape");
            await until<boolean>(s.c, "the History list", `!document.querySelector('[data-slot=blame-view]')`, (v) => v);
            // A sample after the Cancel holds none of the blame processes.
            await poller.until((samples) => goneAt(samples, procs, at), 10 * CANCEL_MS);
            return { progress, cancel: cancelMs };
          } finally {
            poller.stop();
          }
        }
        const plain = { progress: [] as number[], cancel: [] as number[] };
        for (let i = 0; i <= RUNS; i++) {
          const r = await run(false);
          if (i === 0) continue;
          plain.progress.push(r.progress!);
          plain.cancel.push(r.cancel);
        }
        // Each non-empty `blame.ignoreRevsFile` value gives an effective list (plan.md D12 step 4), and blame reads the value at each start.
        writeFileSync(join(repo, ".revs"), `${cached.oids.tip}\n`);
        git(repo, ["config", "blame.ignoreRevsFile", ".revs"]);
        const listed: number[] = [];
        for (let i = 0; i <= RUNS; i++) {
          const r = await run(true);
          if (i > 0) listed.push(r.cancel);
        }
        const m = { progress: record("SC-006 first progress", plain.progress, FIRST_PROGRESS_MS), cancel: record("SC-006 Cancel to the Git exit", plain.cancel, CANCEL_MS), listed: record("SC-006 Cancel to the Git exit with an ignore list", listed, CANCEL_MS) };
        expect({ progress: m.progress <= FIRST_PROGRESS_MS, cancel: Math.max(...plain.cancel) <= CANCEL_MS, listed: Math.max(...listed) <= CANCEL_MS }).toEqual({ progress: true, cancel: true, listed: true });
        // SC-009 during a blame: the probes move the focus between two blame option buttons and press none of them.
        await selectRow(s.c, cached.oids.tip!);
        await focusOn(s.c, blameButton, "Blame");
        const toggles = `[...document.querySelectorAll('[data-slot=blame-view] [role=toolbar] button')]`;
        await probing(
          s.c,
          "the blame of the 10,000-line file",
          async () => {
            if (!(await s.c.evaluate<boolean>(`${toggles}.includes(document.activeElement)`))) await s.c.evaluate(`${toggles}[0]?.focus(); true`);
            await press(s.c, "Tab", (await s.c.evaluate<boolean>(`document.activeElement === ${toggles}[0]`)) ? 0 : MOD.Shift);
          },
          () => press(s.c, "Enter"),
          () => until<boolean>(s.c, "the blame result", `!!document.querySelector('[data-slot=blame-view]') && !${status}.startsWith('Blaming')`, (v) => v, BLAME_WAIT_MS),
        );
      } finally {
        await end(s);
      }
    },
    caseTimeout(60, (2 * RUNS + 4) * 2 * STEP_LIMIT_MS + BLAME_WAIT_MS),
  );

  test.skipIf(reason !== null)(
    "Q32 SC-009 and 004 SC-007: a permanent Delete of 1,000 files keeps the input targets; the name-case fileFacts cost and the 100,000-row sort stay inside the 004 SC-007 budget",
    async () => {
      // 2,000 tracked folders without a .gitignore give 2,000 `name-case` entries (plan.md D9). 1,000 untracked files in `drop` go by Delete.
      const repo = join(fixtureDir("t061-actions"), "repo");
      mkdirSync(repo, { recursive: true });
      git(repo, ["init", "-q", "-b", "main"]);
      for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"]] as const) git(repo, ["config", key, value]);
      for (let i = 0; i < 2000; i++) {
        mkdirSync(join(repo, "cases", `c${String(i).padStart(4, "0")}`), { recursive: true });
        writeFileSync(join(repo, "cases", `c${String(i).padStart(4, "0")}`, "f.txt"), `${i}\n`);
      }
      git(repo, ["add", "--", "cases"]);
      git(repo, ["commit", "-q", "--no-verify", "-m", "cases"]);
      mkdirSync(join(repo, "drop"));
      for (let i = 0; i < 1000; i++) writeFileSync(join(repo, "drop", `d${String(i).padStart(4, "0")}.txt`), `${i}\n`);
      const s = await session("actions", repo);
      try {
        await uia(s.app.pid, COMMIT_VIEW, ControlType.Button, invoke);
        const field = await openEditor(s.app.pid, s.c);
        let replies = 0;
        const start = performance.now();
        await probing(
          s.c,
          "the name-case preview",
          messageProbe(s.c),
          async () => void (replies = await typeLine(s.c, s.ipc, field, 1)),
          () => until<boolean>(s.c, "the preview", previewShown(replies), (v) => v),
        );
        console.log(`OBSERVATION ${TASK}: name-case fileFacts cost: the first preview with 2,000 name-case entries ended ${(performance.now() - start).toFixed(0)} ms after the typed line, the 400 ms pause included`);
        // A permanent Delete of the folder row `drop` with its 1,000 files (spec FR-022).
        const section = `document.querySelector('[data-file-tree=changes] [data-section-row=untracked]')`;
        await focusOn(s.c, section, "the Untracked section");
        if ((await s.c.evaluate<string | null>(`${section}.getAttribute('aria-expanded')`)) !== "true") await press(s.c, "ArrowRight");
        const drop = `[...document.querySelectorAll('[data-file-tree=changes] [role=treeitem]')].find((e) => e.getAttribute('aria-label')?.startsWith('drop, '))`;
        await focusOn(s.c, drop, "the folder row drop");
        await press(s.c, "Delete", MOD.Shift);
        const dialog = `[...document.querySelectorAll('[role=dialog]')].find((d) => d.textContent.includes('Delete 1,000 files permanently?'))`;
        await until<boolean>(s.c, "the Delete confirmation", `!!(${dialog})`, (v) => v);
        await focusOn(s.c, `[...(${dialog}).querySelectorAll('button')].find((b) => b.textContent.trim() === 'Delete permanently')`, "Delete permanently");
        await probing(s.c, "the permanent Delete of 1,000 files", messageProbe(s.c), () => press(s.c, "Enter"), () =>
          until<boolean>(s.c, "the end of the Delete", `![...document.querySelectorAll('[data-file-tree=changes] [role=treeitem]')].some((e) => e.getAttribute('aria-label')?.startsWith('drop, '))`, (v) => v),
        );
      } finally {
        await end(s);
      }
      // The 100,000-row sort runs once per snapshot when the Untracked section opens (plan.md D4). The open is one input of the 004 SC-007 budget.
      const big = untrackedFixture(GIT!);
      const t = await session("sort", big.repo);
      try {
        await uia(t.app.pid, COMMIT_VIEW, ControlType.Button, invoke);
        const section = `document.querySelector('[data-file-tree=changes] [data-section-row=untracked]')`;
        await focusOn(t.c, section, "the Untracked section");
        expect(await t.c.evaluate<string | null>(`${section}.getAttribute('aria-expanded')`)).toBe("false");
        await openWindow(t.c);
        const [opened] = await timed(t.c, [`document.querySelectorAll('[data-file-tree=changes] [role=treeitem]').length > 1`], () => press(t.c, "ArrowRight"));
        console.log(`OBSERVATION ${TASK}: 100,000-row sort: the open of the Untracked section showed its rows ${opened!.toFixed(1)} ms after the key`);
        await closeWindow(t.c, "the open of 100,000 untracked rows");
        expect(opened!).toBeLessThanOrEqual(INPUT_MAX_MS);
      } finally {
        await end(t);
      }
    },
    caseTimeout(60, 10 * STEP_LIMIT_MS),
  );

  // 001 plan.md "Capture source": the visible response comes from DXGI capture after injected input in the measurement account.
  // The 001 tools (inject.ts, capture.ts, uia.ts, external-change.ts) wait for their qualification (001 T165, T240, T242, T244), as 004 T083 does.
  const toolSkip = process.env.ARBARETO_LIVE_INPUT === "1" ? "001-measurement-tools" : "live-input";
  console.log(`SKIP ${TASK} the 001 capture check of SC-001, SC-005, SC-006, and SC-009: missing capability ${toolSkip} (unverified; 001 T165, T240, T242, and T244 are open)`);
  test.skip(`the 001 capture check of SC-001, SC-005, SC-006, and SC-009 (SKIP: ${toolSkip})`, () => {});
});
