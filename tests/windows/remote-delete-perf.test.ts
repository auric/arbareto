// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 011 T020: the remote branch delete budgets in the installed package (plan.md D11; spec SC-009a to SC-009e). `Local: package`.
// The cases drive the page through the WebView2 CDP endpoint and UI Automation patterns. They send no OS input and never move the pointer.
// Page timing: the time from the `timeStamp` of the input event to the start of the first animation frame whose page holds the result (as 010 T018).
// A right-click is the UIA ShowContextMenu call, which Chromium sends to the page as a `contextmenu` event (uia.ts `showContextMenu`).
// Run 0 of each series is the warm-up run. It counts for the every-run bound, never for the median (001 spec.md:95).
// The cold run is the first sample of a new app session. Its budget is 2 times the median (SC-009a: p95) budget of its measure (plan.md D11 "cold").
// CPU seconds and private bytes are records without a budget. They sum the live processes of the app tree before and after each run.
// shortcut: a Git child that ends during the run leaves the CPU sum; read the Job accounting of installed-app.ts when the record needs it.
// Each timed delete removes its own branch. The restore pushes it again outside the timed part (plan.md D11 "Fixture M-D").
// The WSL cases are records without a budget (plan.md D11 "record"). They run only when `ARBARETO_WSL_DISTRO` names `Ubuntu-26.04`. `Local: WSL`, alone.
// Control: set OPEN_MAX_MS to 1 in a scratch copy; the SC-009a case must fail.

import { afterAll, describe, expect, test } from "bun:test";
import { basename, isAbsolute, join, relative } from "node:path";
import { FIXED_IDENTITY, fixtureDir, FIXTURE_ROOT, ownedGit, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { sha256 } from "../git/git-oracle";
import type { GitHost } from "../git/remote-fixtures";
import { printOrigin } from "../origin";
import { distroGitHost, sh } from "../wsl/fixtures";
import { missingCapability, uncPath, useWslFolder, wslExec, wslHost, type WslHost } from "../wsl/wsl-host";
import { connectPage, freePort, MOD, watchIpc, type Cdp, type IpcLog } from "./cdp";
import { appEnv, descendants, findInstalledApp, HISTORY_VIEW, powershellJson, PROBE_TIMEOUT_MS, processRecords, startInstalledApp, WAIT_MS, waitExit, type OwnedProcess } from "./installed-app";
import { ensurePerfFixture, PERF_CACHE_ROOT, PERF_M, type CachedPerfFixture } from "./perf-fixtures";
import { copyRd, ensureRd, RD_BRANCHES, RD_COMBINED_RUNS, RD_NAMES, RD_ONLY_COMMITS, RD_REMOTE, RD_REMOTE_RUNS, RD_RUNS, type CachedRd } from "./remote-delete-fixture";
import { close, ControlType, find, invoke, MAX_CALL_MS, MAX_WAIT_MS, setValue, showContextMenu, UiaError, type Element } from "./uia";

for (const helper of ["./cdp.ts", "./installed-app.ts", "./uia.ts", "./perf-fixtures.ts", "./remote-delete-fixture.ts", "../wsl/wsl-host.ts", "../wsl/fixtures.ts"]) printOrigin(helper, import.meta.dir);
// The package under test holds these sources. The `ORIGIN` line of `findInstalledApp` names the installed binary and its SHA-256.
for (const source of ["../../src/frontend/branches/BranchActions.tsx", "../../src/frontend/branches/RemoteDeleteConfirm.tsx", "../../src/frontend/branches/texts.ts", "../../src/frontend/refs/ReferencesSidebar.tsx", "../../src/frontend/status/OperationStatus.tsx"]) printOrigin(source, import.meta.dir);

const TASK = "T020";
const STEP_MS = MAX_WAIT_MS + MAX_CALL_MS;
const caseTimeout = (steps: number, extraMs = 0) => steps * STEP_MS + 2 * PROBE_TIMEOUT_MS + 2 * WAIT_MS + extraMs;
// Plan.md D11: 10 warm runs and 1 warm-up run per measure and form.
const RUNS = 10;
// Plan.md D11 SC-009a: 20 right-click opens and 20 Shift+F10 opens per run, on distinct rows.
const OPENS = 20;
// The page waits for each step at most this long. A step past it fails the case.
const STEP_LIMIT_MS = 60_000;
const OPEN_WAIT_MS = 300_000;
const IDLE_POLL_MS = 10;
// Spec SC-009e: at least 20 inputs per run. The probe sends one input to the history filter every PROBE_INTERVAL_MS.
const MIN_INPUTS = 20;
const PROBE_INTERVAL_MS = 2;
// The Event Timing API reports no entry below its 16 ms minimum `durationThreshold`, so such an input counts as 16 ms.
const EVENT_THRESHOLD_MS = 16;
// One menu walk ends after this many presses.
const WALK = 12;

// ---- Budgets (plan.md D11, fixed before any run) ----

// SC-009a (001 SC-005): p95 at most 100 ms; every open at most 500 ms.
const OPEN_P95_MS = 100;
const OPEN_MAX_MS = 500;
// SC-009b: median at most 500 ms; every run at most 1 s.
const REVIEW_MEDIAN_MS = 500;
const REVIEW_MAX_MS = 1_000;
// SC-009c: median at most 1.5 s; every run at most 3 s. SC-009d: median at most 2 s; every run at most 4 s.
const REMOTE_MEDIAN_MS = 1_500;
const REMOTE_MAX_MS = 3_000;
const BOTH_MEDIAN_MS = 2_000;
const BOTH_MAX_MS = 4_000;
// Plan.md D11 "cold": 2 times the warm budget.
const COLD_FACTOR = 2;
// SC-009e (001 SC-005 targets).
const INPUT_P95_MS = 100;
const INPUT_MAX_MS = 500;

// ---- App texts (the source of each value is named) ----

// src/frontend/app/RepositorySwitcher.tsx `OPEN_FOLDER`.
const OPEN_FOLDER = "Open folder… (Ctrl+O)";
// src/frontend/refs/ReferencesSidebar.tsx `GROUPS` nouns and the row name.
const remoteRowName = (tracking: string) => `${tracking}, remote-tracking branch`;
const LOCAL_NOUN = "local branch";
// src/frontend/branches/texts.ts `T.menu`, `T.deleteTitle`, `T.deleteButton`, and `RD` (plan.md D13).
const MENU_NAME = (branch: string) => `Actions for ${branch}`;
const DELETE_TITLE = (branch: string) => `Delete ${branch}?`;
const DELETE_BUTTON = "Delete";
const RD = {
  item: "Delete remote branch…",
  title: (tracking: string) => `Delete the remote branch ${tracking}?`,
  lost: (n: number) => `${n.toLocaleString("en-US")} commits are on no other branch, tag, or remote-tracking branch here:`,
  button: "Delete remote branch",
  bothLost: (branch: string, tracking: string, n: number) => `${branch} and ${tracking} have ${n.toLocaleString("en-US")} commits that no other branch, tag, or remote-tracking branch has. The delete loses them.`,
  bothNoneLost: (branch: string, tracking: string) => `Deleting ${branch} and ${tracking} loses no commit.`,
} as const;
// src/frontend/status/OperationStatus.tsx `deleteOutcome`.
const REMOTE_DONE = (tracking: string) => `Deleted the remote branch ${tracking}.`;
const BOTH_DONE = (branch: string, tracking: string) => `Deleted ${branch} and the remote branch ${tracking}.`;
// src/frontend/history/HistoryFilter.tsx `FILTER_LABEL`.
const FILTER_LABEL = "Filter commit messages";
const tracking = (name: string) => `${RD_REMOTE}/${name}`;

// ---- CDP keys (as tests/windows/commit-menu-perf.test.ts) ----

const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", vk: 0x0d, text: "\r" },
  Escape: { key: "Escape", code: "Escape", vk: 0x1b },
  Space: { key: " ", code: "Space", vk: 0x20, text: " " },
  Backspace: { key: "Backspace", code: "Backspace", vk: 0x08 },
  Delete: { key: "Delete", code: "Delete", vk: 0x2e },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 0x28 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 0x27 },
  F5: { key: "F5", code: "F5", vk: 0x74 },
  F10: { key: "F10", code: "F10", vk: 0x79 },
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

// ---- Page expressions ----

const footer = `document.querySelector('[data-slot=status-region] footer')`;
// The `role=status` cells of the footer. `changed` needs a new render of the cell after `arm`.
const outcomeShown = (text: string) => `[...((${footer})?.querySelectorAll('[role=status]') ?? [])].some((e) => e.textContent.trim() === ${js(text)} && window.__t020.changed.has(e))`;
// src/frontend/app/Workbench.tsx `statusText`: the first status cell shows these texts while a read runs or the state is blocked.
// A reconcile block shows counts there. The Remote sync group then holds its reason (SyncToolbar.tsx `quietText`).
const settled = `!['Refreshing…', 'State unknown'].includes(((${footer})?.querySelector('span[role=status]:not([tabindex])')?.textContent ?? '').trim()) && !(document.querySelector('[role=group][aria-label="Remote sync"]')?.textContent ?? '').includes('The status read after the last operation is still running.')`;
const list = `document.querySelector('[data-history-list]')`;
const open = (selector: string) => `[...document.querySelectorAll(${js(selector)})].filter((e) => !e.hasAttribute('data-closed') && !e.hasAttribute('data-ending-style'))`;
const menuOpen = (branch: string) => `${open("[role=menu]")}.some((m) => m.getAttribute('aria-label') === ${js(MENU_NAME(branch))})`;
const anyMenu = `${open("[role=menu]")}.length > 0`;
const anyDialog = `${open("[role=alertdialog],[role=dialog]")}.length > 0`;
const dialogWith = (title: string) => `${open("[role=alertdialog],[role=dialog]")}.find((d) => d.querySelector('[data-slot=dialog-title]')?.textContent.trim() === ${js(title)})`;
const buttonIn = (scope: string, text: string) => `[...((${scope})?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === ${js(text)})`;
const enabled = (button: string) => `(!!(${button}) && !(${button}).disabled && (${button}).getAttribute('aria-disabled') !== 'true')`;
const checkboxIn = (scope: string) => `(${scope})?.querySelector('input[type=checkbox]')`;
const menuItem = (label: string) => `${open("[role=menu]")}.flatMap((m) => [...m.querySelectorAll('[role=menuitem]')]).find((i) => i.querySelector('[data-slot=menu-label]')?.textContent === ${js(label)})`;
const filterField = `document.querySelector(${js(`input[aria-label="${FILTER_LABEL}"]`)})`;
// The References tree: its `aria-labelledby` heading reads "References" (ReferencesSidebar.tsx).
const REFS = `[...document.querySelectorAll('[role=tree]')].find((t) => document.getElementById(t.getAttribute('aria-labelledby') ?? '')?.textContent.trim() === 'References')`;
const treeRow = (test: string) => `[...((${REFS})?.querySelectorAll('[role=treeitem]') ?? [])].find((e) => { const n = e.getAttribute('aria-label') ?? ''; return ${test}; })`;
const remoteRow = (t: string) => treeRow(`n === ${js(remoteRowName(t))}`);
// A local row name continues with the upstream and the track label (ReferencesSidebar.tsx `name`).
const localRow = (branch: string) => treeRow(`n === ${js(`${branch}, ${LOCAL_NOUN}`)} || n.startsWith(${js(`${branch}, ${LOCAL_NOUN}, `)})`);
const groupRow = (prefix: string) => treeRow(`n.startsWith(${js(prefix)})`);
// The remote plan: the alert dialog with its available danger button and the X4 count.
const remotePlan = (t: string, lost: number) => `${enabled(buttonIn(dialogWith(RD.title(t)), RD.button))} && (${dialogWith(RD.title(t))}).textContent.includes(${js(RD.lost(lost))})`;
// The combined plan: X9 checked, Delete available, and the X10 or X11 text.
const combinedPlan = (branch: string, text: string) => `(${checkboxIn(dialogWith(DELETE_TITLE(branch)))})?.checked === true && ${enabled(buttonIn(dialogWith(DELETE_TITLE(branch)), DELETE_BUTTON))} && (${dialogWith(DELETE_TITLE(branch))}).textContent.includes(${js(text)})`;

// `arm` records the `timeStamp` of the next `kind` event and resolves with the time at which each check first holds in an animation frame callback (as 010 T018).
// A check that holds at `arm`, an event before `arm`, or a negative time gives `ok: false`.
// `changed` holds each `role=status` cell of the status region that changed after `arm`.
// The key log of SC-009e holds each probe keydown whose target is the history filter.
// With `probe`, the first `click` after `arm` (the Delete button activation) moves the focus to the filter in a later task.
// A `focusout` of the filter then puts the focus back in a later task, until the result holds. The end calls the CDP binding DONE_BINDING.
const DONE_BINDING = "__t020Done";
const PAGE = `(() => {
  if (window.__t020 !== undefined) return true;
  window.__t020Keys = [];
  window.__t020Events = [];
  addEventListener('keydown', (e) => { if (e.target?.getAttribute?.('aria-label') === ${js(FILTER_LABEL)}) window.__t020Keys.push(e.timeStamp); }, { capture: true });
  new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.name === 'keydown') window.__t020Events.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'event', durationThreshold: ${EVENT_THRESHOLD_MS} });
  window.__t020 = {
    changed: new Set(),
    observer: null,
    unprobe: null,
    arm(checks, limit, kind, probe) {
      const armed = performance.now();
      let start = null;
      const onInput = (e) => { if (start === null) start = e.timeStamp; };
      addEventListener(kind, onInput, { capture: true });
      this.unprobe?.();
      this.unprobe = null;
      if (probe) {
        const keep = () => { const f = ${filterField}; if (this.value === null && f !== null && document.activeElement !== f) f.focus(); };
        const onFocusOut = (e) => { if (e.target?.getAttribute?.('aria-label') === ${js(FILTER_LABEL)}) setTimeout(keep, 0); };
        const onClick = () => { removeEventListener('click', onClick, { capture: true }); setTimeout(() => { if (this.value !== null) return; addEventListener('focusout', onFocusOut, { capture: true }); keep(); }, 0); };
        addEventListener('click', onClick, { capture: true });
        this.unprobe = () => { removeEventListener('click', onClick, { capture: true }); removeEventListener('focusout', onFocusOut, { capture: true }); };
      }
      this.changed = new Set();
      this.observer?.disconnect();
      const region = document.querySelector('[data-slot=status-region]');
      this.observer = new MutationObserver((records) => { const add = (e) => { if (e) this.changed.add(e); }; for (const r of records) { add((r.target.nodeType === 1 ? r.target : r.target.parentElement)?.closest('[role=status]')); for (const n of r.addedNodes) { if (n.nodeType !== 1) continue; add(n.closest('[role=status]')); n.querySelectorAll('[role=status]').forEach(add); } } });
      if (region !== null) this.observer.observe(region, { subtree: true, childList: true, characterData: true });
      const done = checks.map(() => null);
      this.value = null;
      const end = (ok, why) => {
        removeEventListener(kind, onInput, { capture: true });
        this.observer?.disconnect();
        this.unprobe?.();
        this.unprobe = null;
        const times = done.map((t) => (t === null || start === null ? null : t - start));
        const valid = ok && start >= armed && times.every((t) => t !== null && t >= 0);
        this.value = { ok: valid, why: valid ? null : why ?? 'the event time lies before arm or after a check', armed, start, times, origin: performance.timeOrigin };
        if (typeof window.${DONE_BINDING} === 'function') window.${DONE_BINDING}('');
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

const FACTS = `(() => {
  const text = (e) => (e?.textContent ?? '').trim().slice(0, 300);
  const a = document.activeElement;
  return {
    active: a === null ? null : (a.getAttribute('aria-label') ?? a.tagName + ' ' + text(a).slice(0, 60)),
    status: text(document.querySelector('[data-slot=status-region] footer')),
    menus: [...document.querySelectorAll('[role=menu]')].map((m) => m.getAttribute('aria-label') + ': ' + text(m)),
    dialogs: [...document.querySelectorAll('[role=alertdialog],[role=dialog]')].map(text),
  };
})()`;

async function until<T>(c: Cdp, what: string, expression: string, done: (value: T) => boolean, ms = STEP_LIMIT_MS): Promise<T> {
  const value = await c.poll<T>(expression, done, ms);
  if (!done(value)) throw new Error(`${what} did not happen within ${ms} ms: ${js(value)} ${js(await c.evaluate<unknown>(FACTS).catch((e) => String(e)))}`);
  return value;
}
async function focusOn(c: Cdp, expression: string, what: string): Promise<void> {
  await until<boolean>(c, `${what} shows`, `!!(${expression})`, (v) => v);
  await c.evaluate(`(${expression}).scrollIntoView({ block: 'nearest' }); (${expression}).focus(); true`);
  await until<boolean>(c, `${what} has focus`, `document.activeElement === (${expression})`, (v) => v);
}
// A check is one JavaScript expression. A fragment that does not parse fails the whole CDP evaluate, so each check parses in Bun first.
function parses(check: string): string {
  try {
    new Function(`return (${check});`);
  } catch (e) {
    throw new Error(`a page check does not parse (${(e as Error).message}): ${check}`);
  }
  return check;
}
const step = (name: string) => console.log(`STEP ${TASK} ${name} ${new Date().toISOString()}`);

type Timed = { ok: boolean; why: string | null; armed: number; start: number | null; times: (number | null)[]; origin: number };
// Arms the page, runs `act`, and calls `during` until the page holds the result. `kind` is the DOM event that starts the time (as 010 T018 `timed`).
async function timed(s: { c: Cdp; ipc: IpcLog }, name: string, checks: string[], act: () => Promise<void>, kind: "keydown" | "contextmenu" = "keydown", during?: () => Promise<void>): Promise<number> {
  const c = s.c;
  step(name);
  checks.forEach(parses);
  const from = s.ipc.calls().length;
  let ended = false;
  let signalled = false;
  const off = c.on("Runtime.bindingCalled", (p) => {
    if (p.name === DONE_BINDING) signalled = ended = true;
  });
  try {
    await c.evaluate(`(window.__t020Keys = [], window.__t020Events = [], window.__t020.arm([${checks.map((check) => `() => (${check})`).join(", ")}], ${STEP_LIMIT_MS}, ${js(kind)}, ${during !== undefined}))`);
    const acting = act();
    acting.catch(() => (ended = true));
    if (during !== undefined) {
      for (const end = Date.now() + STEP_LIMIT_MS + 5_000; !ended && Date.now() < end; await Bun.sleep(PROBE_INTERVAL_MS)) await during();
      ended = true;
    }
    await acting;
    if (during !== undefined && !signalled) throw new Error(`the page gave no ${DONE_BINDING} call within ${STEP_LIMIT_MS + 5_000} ms: ${js(await c.evaluate<unknown>(FACTS))}`);
  } finally {
    off();
  }
  const r = (await until<Timed | null>(c, "the timed step", "window.__t020.value", (v) => v !== null, STEP_LIMIT_MS + 5_000))!;
  if (!r.ok || r.start === null || !r.times.every((t) => t !== null && t >= 0)) throw new Error(`a timed step is not valid: ${js(r)} ${js(await c.evaluate<unknown>(FACTS))}`);
  const ms = Math.max(...(r.times as number[]));
  // Record, no budget. The start offset compares the CDP `wallTime` with the page `timeOrigin`, two wall clocks. The duration uses the CDP `MonotonicTime` only.
  const pressAt = r.origin + r.start;
  const split = s.ipc
    .calls()
    .slice(from)
    .filter((t) => t.wall * 1000 <= pressAt + ms)
    .map((t) => `${t.command} at ${r1(t.wall * 1000 - pressAt)} ms for ${t.end === null ? "open" : `${r1((t.end - t.sent) * 1000)} ms`}`);
  console.log(`IPC ${TASK}: ${name}: ${r1(ms)} ms; ${split.length === 0 ? "no call" : split.join("; ")}`);
  return ms;
}

const median = (xs: number[]) => {
  const s = xs.toSorted((a, b) => a - b);
  return s.length % 2 === 1 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
// 001 plan.md "Responsiveness metrics": the nearest-rank p95.
const p95 = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.max(0, Math.ceil(0.95 * xs.length) - 1)]!;
const r1 = (x: number) => Math.round(x * 10) / 10;

// ---- Records: CPU seconds and process-tree private bytes (no budget) ----

type ProcessUsage = { pid: number; name: string; privateBytes: number; type: string | null };
type Usage = { cpu: number; privateBytes: number; processes: number; list: ProcessUsage[] };
// The tree rule of tests/windows/measure-ram-split.ps1: a child starts after its parent. Get-Process gives TotalProcessorTime and PrivateMemorySize64.
function usage(rootPid: number): Usage {
  return powershellJson(`$all = Get-CimInstance Win32_Process
$tree = [System.Collections.Generic.List[object]]::new(); $root = $all | Where-Object ProcessId -eq ${rootPid}
if ($root) { $tree.Add($root) }
for ($i = 0; $i -lt $tree.Count; $i++) { $p = $tree[$i]; $all | Where-Object { $_.ParentProcessId -eq $p.ProcessId -and $_.ProcessId -ne $p.ProcessId -and $_.CreationDate -ge $p.CreationDate } | ForEach-Object { $tree.Add($_) } }
$cpu = 0.0; $bytes = [int64]0; $list = [System.Collections.Generic.List[object]]::new()
foreach ($p in $tree) {
  $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if ($gp) {
    $cpu += $gp.TotalProcessorTime.TotalSeconds; $bytes += [int64]$gp.PrivateMemorySize64
    $type = $null
    if ($p.Name -eq 'msedgewebview2.exe') { $type = if ("$($p.CommandLine)" -match '(?:^|\\s)--type=([^\\s"]+)') { $Matches[1] } else { 'none' } }
    $list.Add([ordered]@{ pid = [int]$p.ProcessId; name = $p.Name; privateBytes = [int64]$gp.PrivateMemorySize64; type = $type })
  }
}
ConvertTo-Json -Compress -Depth 4 -InputObject ([ordered]@{ cpu = $cpu; privateBytes = $bytes; processes = $tree.Count; list = @($list) })`) as Usage;
}
const processLine = (u: Usage) => u.list.map((p) => `${p.pid} ${p.name}${p.type === null ? "" : `(${p.type})`} ${p.privateBytes}`).join("; ");

// CDP `Runtime.getHeapUsage` after each run, and `Performance.getMetrics` at the start and the end of each series. Records, no budget.
async function heap(c: Cdp, label: string): Promise<void> {
  const h = (await c.send("Runtime.getHeapUsage")) as { usedSize: number; totalSize: number };
  console.log(`HEAP ${TASK}: ${label}: usedSize ${h.usedSize}, totalSize ${h.totalSize}`);
}
const METRICS = ["JSHeapUsedSize", "Nodes", "JSEventListeners"];
async function metrics(c: Cdp, label: string): Promise<void> {
  const { metrics: all } = (await c.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] };
  console.log(`METRICS ${TASK}: ${label}: ${METRICS.map((name) => `${name} ${all.find((m) => m.name === name)?.value ?? "absent"}`).join(", ")}`);
}

type Series = { name: string; runs: number[]; cpu: number[]; bytes: number[] };
const newSeries = (name: string): Series => ({ name, runs: [], cpu: [], bytes: [] });
async function recordRun(c: Cdp, s: Series, run: number, ms: number, before: Usage, after: Usage): Promise<void> {
  s.runs.push(ms);
  s.cpu.push(after.cpu - before.cpu);
  s.bytes.push(after.privateBytes);
  console.log(`RUN ${TASK}: ${s.name} run ${run}${run === 0 ? " (warm-up)" : ""}: ${r1(ms)} ms, CPU ${(after.cpu - before.cpu).toFixed(3)} s, private bytes ${after.privateBytes} (${after.processes} processes)`);
  console.log(`PROCESSES ${TASK}: ${s.name} run ${run}: ${processLine(after)}`);
  await heap(c, `${s.name} run ${run}`);
}
function recordCold(name: string, ms: number, before: Usage, after: Usage): void {
  console.log(`RUN ${TASK}: ${name} cold: ${r1(ms)} ms, CPU ${(after.cpu - before.cpu).toFixed(3)} s, private bytes ${after.privateBytes} (${after.processes} processes)`);
  console.log(`PROCESSES ${TASK}: ${name} cold: ${processLine(after)}`);
}
// Run 0 is the warm-up run: in the every-run bound, never in the median.
function verdict(s: Series, medianBudget: number, maxBudget: number): { name: string; median: boolean; every: boolean } {
  const counted = s.runs.slice(1);
  const m = median(counted);
  const max = Math.max(...s.runs);
  console.log(`OBSERVATION ${TASK}: ${s.name}: counted ${js(counted.map(r1))} ms, median ${r1(m)} ms (budget ${medianBudget}), every-run max ${r1(max)} ms (budget ${maxBudget}), warm-up ${r1(s.runs[0]!)} ms; CPU s ${js(s.cpu.map((x) => Number(x.toFixed(3))))}; private bytes ${js(s.bytes)}`);
  return { name: s.name, median: counted.length === RUNS && m <= medianBudget, every: max <= maxBudget };
}
function cold(name: string, ms: number, budget: number): { name: string; cold: boolean } {
  console.log(`OBSERVATION ${TASK}: cold ${name}: ${r1(ms)} ms (budget ${budget})`);
  return { name, cold: ms <= budget };
}

// ---- SC-009e inputs (W3C Event Timing) ----

type Inputs = { label: string; count: number; p95: number; max: number };
async function inputs(c: Cdp, label: string): Promise<Inputs> {
  await c.evaluate("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))");
  const { keys, events, start } = await c.evaluate<{ keys: number[]; events: { start: number; duration: number }[]; start: number }>("({ keys: window.__t020Keys, events: window.__t020Events, start: window.__t020.value.start })");
  const durations = keys.map((k) => events.find((e) => e.start === k)?.duration ?? EVENT_THRESHOLD_MS);
  const r = { label, count: durations.length, p95: durations.length === 0 ? 0 : p95(durations), max: durations.length === 0 ? 0 : Math.max(...durations) };
  const offset = (k: number) => r1(k - start);
  const spacing = keys.length < 2 ? null : r1(median(keys.slice(1).map((k, i) => k - keys[i]!)));
  const measured = keys.flatMap((k) => events.filter((e) => e.start === k).map((e) => [offset(k), e.duration]));
  console.log(`OBSERVATION ${TASK}: SC-009e ${label}: ${r.count} inputs, p95 ${r.p95} ms, max ${r.max} ms; first input at ${keys.length === 0 ? null : offset(keys[0]!)} ms, median spacing ${spacing} ms, measured ${js(measured)}`);
  return r;
}

describe.skipIf(process.platform !== "win32")("T020 packaged remote branch delete budgets", () => {
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
  if (installed !== null) console.log(`APP ${TASK}: exe=${installed.exe} sha256=${installed.sha256}`);
  const others = installed === null ? [] : processRecords().filter((r) => r.name.toLowerCase() === installed.mainBinaryName.toLowerCase());
  const reason =
    installed === null ? (discovery as { skip: string }).skip : GIT === null ? "Git executable absent" : others.length > 0 ? `another-instance: ${installed.mainBinaryName} runs as PID ${others.map((r) => r.pid).join(", ")}` : null;
  if (reason !== null) console.log(`SKIP installed app: ${reason}`);

  // WSL detection starts the distro, so it runs only for a WSL run. The cases use the distro of plan.md D11 "record".
  const WSL_DISTRO = "Ubuntu-26.04";
  const wslWanted = process.env.ARBARETO_WSL_DISTRO;
  const host = reason === null && wslWanted !== undefined && wslWanted !== "" ? wslHost() : null;
  const wslReason =
    reason ?? (host === null ? "ARBARETO_WSL_DISTRO unset" : (missingCapability(["wsl-fixture-fs-id", "distro-git-2.55"]) ?? (host.distro === WSL_DISTRO ? null : `ubuntu-26.04: the test distro is ${host.distro}`)));
  if (wslReason === null) useWslFolder();
  else console.log(`SKIP ${TASK} WSL: ${wslReason}`);

  const under = (root: string, repo: string) => !relative(root, repo).startsWith("..") && !isAbsolute(relative(root, repo));
  // One repository of the cases: `folder` is the path that the folder dialog gets. Each Git call runs on the side of the repository.
  type Repo = { folder: string; wsl: boolean; git(args: string[], allowExit?: number[]): string };
  function winRepo(copy: { repo: string; remote: string }): Repo {
    if (!under(FIXTURE_ROOT, copy.repo)) throw new Error(`the repository is outside the fixture root: ${copy.repo}`);
    return { folder: copy.repo, wsl: false, git: (args, allowExit = [0]) => ownedGit(GIT!, FIXTURE_ROOT, copy.repo, args, { allowExit }).toString("utf8") };
  }
  const rev = (repo: Repo, name: string) => repo.git(["rev-parse", "--verify", "--end-of-options", `${name}^{commit}`]).trim();

  // ---- WSL repositories (as tests/windows/commit-menu-perf.test.ts: a Windows tar stream to tar in the distro) ----

  const WSL_GLOBAL = "[user]\n\tname = Arbareto Fixture\n\temail = fixture@arbareto.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n";
  const WSL_CALL_MS = 300_000;
  let wslGit: GitHost | null = null;
  const TAR = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  function toDistro(w: WslHost, from: string, entry: string, linuxDir: string): void {
    const tar = Bun.spawnSync([TAR, "--no-acls", "--no-xattrs", "--no-fflags", "-c", "-f", "-", "-C", from, entry], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: WSL_CALL_MS });
    if (tar.exitCode !== 0) throw new Error(`tar -c of ${from} exited ${tar.exitCode}: ${tar.stderr.toString()}`);
    const x = wslExec(["--distribution", w.distro, "--cd", "/", "--exec", "/usr/bin/tar", "-x", "-f", "-", "-C", linuxDir], { input: new Uint8Array(tar.stdout), timeoutMs: WSL_CALL_MS });
    if (x.exitCode !== 0) throw new Error(`tar -x into ${linuxDir} exited ${x.exitCode}: ${x.stderr}`);
  }
  // A distro copy of the cached work repository and its bare remote (read only). Its refs and status must equal those of the cache, computed with Windows Git.
  function distroRepo(cached: CachedRd, name: string): Repo {
    const w = host!;
    wslGit ??= distroGitHost(w, "t020", WSL_GLOBAL);
    const h = wslGit;
    const root = `${h.root}/${name}`;
    const dir = `${root}/repo`;
    sh(w, 'mkdir -- "$1"', [root]);
    toDistro(w, cached.folder, "repo", root);
    toDistro(w, cached.folder, "remote.git", root);
    const git = (args: string[], allowExit = [0]) => {
      const r = h.run(dir, args, { timeoutMs: WSL_CALL_MS });
      if (!allowExit.includes(r.exitCode)) throw new Error(`distro git ${args.join(" ")} exited ${r.exitCode}: ${r.stderr.toString()}`);
      return r.stdout.toString("utf8");
    };
    // The same environment as `distroGitHost` `run`. GNU sha256sum prints the digest first.
    const vars = [`HOME=${w.folder}/home`, "PATH=/usr/local/bin:/usr/bin:/bin", `GIT_CONFIG_GLOBAL=${h.globalConfig}`, `GIT_CONFIG_SYSTEM=${h.systemConfig}`, "GIT_CONFIG_NOSYSTEM=1"];
    const digest = (args: string[]) => {
      const out = `${root}/digest.out`;
      const r = sh(w, 'o="$1"; shift; /usr/bin/env -i "$@" > "$o" && sha256sum < "$o"; s=$?; rm -f -- "$o"; exit $s', [out, ...vars, w.probe.paths.git!, "-C", dir, ...args]);
      const m = /^([0-9a-f]{64}) /.exec(r.stdout);
      if (m === null) throw new Error(`sha256sum output refused: ${js(r.stdout)}`);
      return m[1]!;
    };
    // Git for Windows writes these keys at `init`, so the distro copy drops them (as commit-menu-perf.test.ts).
    for (const key of ["core.symlinks", "core.ignorecase", "core.filemode"]) git(["config", "--local", "--unset", key], [0, 5]);
    git(["config", "--local", "user.name", FIXED_IDENTITY.name]);
    git(["config", "--local", "user.email", FIXED_IDENTITY.email]);
    // Plan.md D11 "record": the bare remote lies in the distro.
    git(["remote", "set-url", RD_REMOTE, `${root}/remote.git`]);
    git(["update-index", "-q", "--refresh"], [0, 1]);
    const shape = [
      ["for-each-ref", "--format=%(objectname) %(refname)"],
      ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
    ].map((args) => ({ args: args.join(" "), windows: sha256(ownedGit(GIT!, PERF_CACHE_ROOT, cached.repo, ["--no-optional-locks", ...args])), distro: digest(args) }));
    const repo: Repo = { folder: uncPath(w, dir), wsl: true, git };
    console.log(`WSL ${TASK}: distro=${w.distro} folder=${repo.folder} shape=${js(shape)}`);
    expect(shape.every((x) => x.windows === x.distro)).toBe(true);
    return repo;
  }

  async function use<T>(element: Promise<Element>, body: (element: Element) => T): Promise<T> {
    const found = await element;
    try {
      return body(found);
    } finally {
      found.release();
    }
  }
  const uia = <T>(pid: number, name: string, type: number | undefined, body: (element: Element) => T) => use(find(pid, name, MAX_WAIT_MS, type), body);
  // `uia.ts` `find` waits at most MAX_WAIT_MS, so a longer wait repeats it until `ms` passes (as commit-menu-perf.test.ts).
  async function findWithin(pid: number, name: string, ms: number): Promise<Element> {
    for (const end = performance.now() + ms; ; ) {
      try {
        return await find(pid, name, Math.max(0, Math.min(MAX_WAIT_MS, Math.ceil(end - performance.now()))));
      } catch (error) {
        if (!(error instanceof UiaError && error.code === "TIMEOUT") || performance.now() >= end) throw error;
      }
    }
  }

  type Session = { app: OwnedProcess; c: Cdp; ipc: IpcLog; repo: Repo };
  async function session(label: string, repo: Repo): Promise<Session> {
    const top = repo.git(["rev-parse", "--show-toplevel"]).trim();
    const shown = (v: string | null) => (repo.wsl ? v !== null && v.startsWith(`${basename(top)}, `) : v === `${basename(top)}, ${top}`);
    const env = appEnv(fixtureDir(`${label}-app`), false);
    const port = freePort();
    env.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port}`;
    const app = startInstalledApp(installed!, env);
    owned.add(app);
    console.log(`STARTED ${TASK}: ${app.pid} ${label} port=${port} profile=${env.set.ARBARETO_PROFILE_ROOT}`);
    // A failed start stops its app, so the next case can start one.
    try {
      await uia(app.pid, "Select Git", ControlType.Button, invoke);
      await uia(app.pid, "Use this Git", undefined, invoke);
      const c = await connectPage(port, MAX_WAIT_MS);
      sockets.add(c);
      const ipc = await watchIpc(c);
      await uia(app.pid, OPEN_FOLDER, undefined, invoke);
      await uia(app.pid, "Folder:", ControlType.Edit, (field) => setValue(field, repo.folder));
      await uia(app.pid, "Select Folder", ControlType.Button, invoke);
      // A WSL folder asks for its distro Git in a native confirmation (src-tauri/src/dialogs.rs `wsl_git_confirmation`). The first open can start the distro.
      if (repo.wsl) await use(findWithin(app.pid, "Use this Git", OPEN_WAIT_MS), invoke);
      try {
        await until<string | null>(c, "the open repository", `document.querySelector('button[aria-keyshortcuts="Control+R"]')?.getAttribute('aria-label') ?? null`, shown, OPEN_WAIT_MS);
      } catch (e) {
        const tree = descendants(app.pid).map((r) => `${r.pid} ${r.name} ${(r.commandLine ?? "").slice(0, 160)}`);
        throw new Error(`${(e as Error).message} tree=${js(tree)}`);
      }
      expect(await c.evaluate<string>("document.visibilityState")).toBe("visible");
      await c.send("Runtime.enable");
      await c.send("Runtime.addBinding", { name: DONE_BINDING });
      expect(await c.evaluate<boolean>(PAGE)).toBe(true);
      if (await c.evaluate<boolean>(`document.querySelector('[data-view="history"]')?.hidden !== false`)) await uia(app.pid, HISTORY_VIEW, ControlType.Button, invoke);
      await until<boolean>(c, "the History view", `document.querySelector('[data-view="history"]')?.hidden === false`, (v) => v);
      await c.send("Performance.enable");
      const s = { app, c, ipc, repo };
      await idle(s);
      await showRemotes(s);
      await idle(s);
      return s;
    } catch (e) {
      app.stop();
      owned.delete(app);
      await waitExit(app);
      throw e;
    }
  }
  async function end(s: Session): Promise<void> {
    s.c.close();
    sockets.delete(s.c);
    s.app.stop();
    owned.delete(s.app);
    expect(await waitExit(s.app)).not.toBeNull();
  }

  // The reads and runs of the page (src-tauri/src/ipc.rs command names in the snake case of the IPC path).
  const IDLE = ["read_workspace", "read_entries", "open_history", "read_history_rows", "read_refs", "read_tracking", "read_branches", "read_worktrees", "read_comparison", "read_commit_changes", "review_workbench", "run_workbench", "review_sync", "sync"] as const;
  async function idle(s: Session): Promise<void> {
    const end = Date.now() + STEP_LIMIT_MS;
    while (IDLE.some((command) => s.ipc.pending(command).length > 0) || !(await s.c.evaluate<boolean>(settled))) {
      if (Date.now() >= end) throw new Error(`the app is not idle after ${STEP_LIMIT_MS} ms: ${IDLE.map((command) => `${command}=${s.ipc.pending(command).length}`).join(", ")} ${js(await s.c.evaluate<unknown>(FACTS))}`);
      await Bun.sleep(IDLE_POLL_MS);
    }
  }
  // F5 reads the workspace again after a change outside the app. `extra` then holds, for example the restored row.
  async function refreshed(s: Session, extra: string): Promise<void> {
    await focusOn(s.c, list, "the History list");
    await press(s.c, "F5");
    await idle(s);
    await until<boolean>(s.c, "the refreshed state", `(${extra}) && ${settled}`, (v) => v);
    await idle(s);
  }
  // ReferencesSidebar.tsx `defaultExpansion`: Remotes and its folders start closed. A narrow window hides the sidebar behind "Show references".
  async function showRemotes(s: Session): Promise<void> {
    const show = `[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Show references' && b.getAttribute('aria-expanded') === 'false')`;
    if (await s.c.evaluate<boolean>(`!!(${show})`)) {
      await focusOn(s.c, show, "Show references");
      await press(s.c, "Enter");
    }
    for (const prefix of ["Remotes, ", `${RD_REMOTE}, folder, `]) {
      const row = groupRow(prefix);
      if ((await s.c.evaluate<string | null>(`(${row})?.getAttribute('aria-expanded') ?? null`)) !== "true") {
        await focusOn(s.c, row, `the ${prefix} row`);
        await press(s.c, "ArrowRight");
      }
      await until<string | null>(s.c, `the open ${prefix} row`, `(${row})?.getAttribute('aria-expanded') ?? null`, (v) => v === "true");
    }
    await until<boolean>(s.c, "the d01 row", `!!(${remoteRow(tracking("d01"))})`, (v) => v);
  }
  async function closeAll(s: Session): Promise<void> {
    for (let i = 0; i < 3 && (await s.c.evaluate<boolean>(`${anyMenu} || ${anyDialog}`)); i++) await press(s.c, "Escape");
    await until<boolean>(s.c, "no open menu or dialog", `!(${anyMenu}) && !(${anyDialog})`, (v) => v);
    await idle(s);
  }
  async function focusButton(s: Session, scope: string, text: string): Promise<void> {
    const button = buttonIn(scope, text);
    await until<boolean>(s.c, `the available ${text} button`, enabled(button), (v) => v);
    await focusOn(s.c, button, `the ${text} button`);
  }
  // One SC-009e probe: an x or a Backspace in the history filter. The pair keeps the field short. The page moves the focus (`arm` with `probe`).
  const probe = (c: Cdp) => {
    let n = 0;
    return () => press(c, n++ % 2 === 0 ? "x" : "Backspace");
  };
  const clearFilter = (c: Cdp) => c.evaluate(`(() => { const f = ${filterField}; if (f && f.value !== '') { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, ''); f.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`);

  // Plan.md D11: the cached M has 5,000 commits, 10,000 files, and 32 refs. U5 (research.md R5): M holds no remote-tracking ref.
  function checkM(cached: CachedPerfFixture): void {
    const g = (args: string[]) => ownedGit(GIT!, PERF_CACHE_ROOT, cached.repo, ["--no-optional-locks", ...args]).toString("utf8");
    const shape = {
      commits: Number(g(["rev-list", "--count", "--all"]).trim()),
      refs: g(["for-each-ref", "--format=%(refname)"]).trim().split("\n").length,
      files: g(["ls-files", "-z"]).split("\0").filter((p) => p !== "").length,
      tracking: g(["for-each-ref", "--format=%(refname)", "refs/remotes/"]),
      commitGraph: cached.manifest.facts.commitGraph,
    };
    console.log(`OBSERVATION ${TASK}: fixture M ${cached.reused ? "reused" : "built"} at ${cached.folder}: ${js(shape)}`);
    expect(shape).toEqual({ commits: PERF_M.commits, refs: PERF_M.refs, files: PERF_M.files, tracking: "", commitGraph: true });
  }
  // U5: the copy of RD adds the remote-tracking refs of plan.md D11. Git's own reads of the copy give the shape.
  function checkRd(repo: Repo, cached: CachedRd): void {
    const lines = (text: string) => text.split("\n").filter((l) => l !== "").length;
    const shape = {
      tracking: lines(repo.git(["for-each-ref", "--format=%(refname)", `refs/remotes/${RD_REMOTE}/`])),
      only: Number(repo.git(["rev-list", "--count", cached.facts.d01, "--not", `--exclude=${RD_REMOTE}/d01`, "--remotes", "--branches", "--tags"]).trim()),
      remote: lines(repo.git(["ls-remote", "--heads", RD_REMOTE])),
    };
    console.log(`OBSERVATION ${TASK}: fixture RD ${cached.reused ? "reused" : "built"} at ${cached.folder}: ${js({ ...shape, facts: cached.facts })}`);
    expect(shape).toEqual({ tracking: 1 + 1 + RD_BRANCHES + 2 * RD_RUNS, only: RD_ONLY_COMMITS, remote: 1 + RD_BRANCHES + 2 * RD_RUNS });
  }
  function rdCopy(label: string): { repo: Repo; cached: CachedRd } {
    checkM(ensurePerfFixture(GIT!, PERF_M));
    const cached = ensureRd(GIT!);
    const repo = winRepo(copyRd(GIT!, cached, label));
    checkRd(repo, cached);
    return { repo, cached };
  }

  // ---- SC-009a: input to menu paint on a remote-tracking row ----

  test.skipIf(reason !== null)(
    "SC-009a, U5: on M-D with History open, 20 right-click and 20 Shift+F10 opens on distinct remote-tracking rows paint the branch menu with p95 at most 100 ms and each open at most 500 ms; the cold open at most 200 ms",
    async () => {
      const { repo } = rdCopy("t020-a");
      const s = await session("sc009a", repo);
      try {
        const opened: string[] = [];
        const byKey = async (name: string) => {
          const t = tracking(name);
          await focusOn(s.c, remoteRow(t), `the ${t} row`);
          const ms = await timed(s, `shift-f10 ${t}`, [menuOpen(t)], () => press(s.c, "F10", MOD.Shift));
          opened.push(t);
          await closeAll(s);
          return ms;
        };
        const byMouse = async (name: string) => {
          const t = tracking(name);
          await s.c.evaluate(`(${remoteRow(t)}).scrollIntoView({ block: 'nearest' }); true`);
          const element = await find(s.app.pid, remoteRowName(t), MAX_WAIT_MS, ControlType.TreeItem);
          let hr = 0;
          try {
            const ms = await timed(s, `right-click ${t}`, [menuOpen(t)], async () => void (hr = showContextMenu(element)), "contextmenu");
            expect(hr).toBe(0);
            opened.push(t);
            await closeAll(s);
            return ms;
          } finally {
            element.release();
          }
        };
        // d02 to d43: the cold open, the warm-up open, 20 right-click opens, and 20 Shift+F10 opens.
        const rows = RD_NAMES.slice(1, 3 + 2 * OPENS);
        const coldMs = await byKey(rows[0]!);
        const warmUp = await byMouse(rows[1]!);
        const mouse: number[] = [];
        for (const name of rows.slice(2, 2 + OPENS)) mouse.push(await byMouse(name));
        const keys: number[] = [];
        for (const name of rows.slice(2 + OPENS)) keys.push(await byKey(name));
        const counted = [...mouse, ...keys];
        expect(new Set(opened).size).toBe(opened.length);
        console.log(`OBSERVATION ${TASK}: SC-009a right-click ${js(mouse.map(r1))} ms, Shift+F10 ${js(keys.map(r1))} ms, warm-up ${r1(warmUp)} ms, cold ${r1(coldMs)} ms`);
        console.log(`OBSERVATION ${TASK}: SC-009a p95 ${r1(p95(counted))} ms (budget ${OPEN_P95_MS}), every-open max ${r1(Math.max(warmUp, ...counted))} ms (budget ${OPEN_MAX_MS}); right-click p95 ${r1(p95(mouse))} ms, Shift+F10 p95 ${r1(p95(keys))} ms`);
        expect({ opens: counted.length, p95: p95(counted) <= OPEN_P95_MS, every: Math.max(warmUp, ...counted) <= OPEN_MAX_MS, ...cold("SC-009a", coldMs, COLD_FACTOR * OPEN_P95_MS) }).toEqual({ opens: 2 * OPENS, p95: true, every: true, name: "SC-009a", cold: true });
      } finally {
        await end(s);
      }
    },
    caseTimeout(30 + 12 * (2 * OPENS + 2), OPEN_WAIT_MS + 30 * 60_000),
  );

  // ---- SC-009b: item activation or check-box click to the confirmation with its plan ----

  // The SC-009b series on `repo` (a copy of M-D). It gives the verdicts; a WSL case records them only.
  async function sc009b(label: string, repo: Repo): Promise<unknown[]> {
    const s = await session(label, repo);
    const tag = repo.wsl ? "SC-009b WSL" : "SC-009b";
    const t = tracking("d01");
    try {
      const forms = [
        {
          name: "remote",
          // X1 on the origin/d01 row: Shift+F10, then Down to X1. Enter starts the review.
          async setup() {
            await focusOn(s.c, remoteRow(t), `the ${t} row`);
            await press(s.c, "F10", MOD.Shift);
            await until<boolean>(s.c, "the branch menu", menuOpen(t), (v) => v);
            for (let i = 0; i < WALK && !(await s.c.evaluate<boolean>(`document.activeElement === (${menuItem(RD.item)})`)); i++) await press(s.c, "ArrowDown");
            await until<boolean>(s.c, `the focus on ${RD.item}`, `document.activeElement === (${menuItem(RD.item)})`, (v) => v, 1_000);
          },
          key: "Enter",
          done: remotePlan(t, RD_ONLY_COMMITS),
        },
        {
          name: "combined",
          // Del on the local d01 row opens the 004 dialog. Space on the focused X9 starts the combined review.
          async setup() {
            await focusOn(s.c, localRow("d01"), "the d01 row");
            await press(s.c, "Delete");
            const dialog = dialogWith(DELETE_TITLE("d01"));
            await until<boolean>(s.c, "the local dialog with X9", `${enabled(buttonIn(dialog, DELETE_BUTTON))} && (${checkboxIn(dialog)})?.checked === false`, (v) => v);
            await focusOn(s.c, checkboxIn(dialog), "X9");
          },
          key: "Space",
          done: combinedPlan("d01", RD.bothLost("d01", t, RD_ONLY_COMMITS)),
        },
      ];
      const sample = async (f: (typeof forms)[number], name: string) => {
        await f.setup();
        await idle(s);
        const before = usage(s.app.pid);
        const ms = await timed(s, name, [f.done], () => press(s.c, f.key));
        const after = usage(s.app.pid);
        const reply = await s.ipc.body<{ state?: string; code?: string; result?: { reason?: string } }>(s.ipc.finished("review_sync").at(-1)!).catch(() => null);
        console.log(`REVIEW ${TASK}: ${name}: ${js({ state: reply?.state, code: reply?.code, reason: reply?.result?.reason })}`);
        await closeAll(s);
        return { ms, before, after };
      };
      const results: unknown[] = [];
      const first = await sample(forms[0]!, "cold remote");
      recordCold(`${tag} remote`, first.ms, first.before, first.after);
      results.push(cold(`${tag} remote`, first.ms, COLD_FACTOR * REVIEW_MEDIAN_MS));
      for (const f of forms) {
        const series = newSeries(`${tag} ${f.name}`);
        await metrics(s.c, `${series.name} start`);
        for (let run = 0; run <= RUNS; run++) {
          const r = await sample(f, `${f.name} run ${run}`);
          await recordRun(s.c, series, run, r.ms, r.before, r.after);
        }
        await metrics(s.c, `${series.name} end`);
        results.push(verdict(series, REVIEW_MEDIAN_MS, REVIEW_MAX_MS));
      }
      return results;
    } finally {
      await end(s);
    }
  }

  test.skipIf(reason !== null)(
    "SC-009b: on M-D the review of d01 (150 commits that only it holds) shows the confirmation with its plan, for X1 and for the X9 click, with a median of at most 500 ms and each run at most 1 s; the cold run at most 1 s",
    async () => {
      const results = await sc009b("sc009b", rdCopy("t020-b").repo);
      expect(results).toEqual([{ name: "SC-009b remote", cold: true }, ...["remote", "combined"].map((f) => ({ name: `SC-009b ${f}`, median: true, every: true }))]);
    },
    caseTimeout(30 + 14 * (2 * (RUNS + 1) + 1), OPEN_WAIT_MS + 30 * 60_000),
  );

  // ---- SC-009c, SC-009d, SC-009e: Delete button to outcome text ----

  type Run = { name: "remote" | "combined"; label: string; medianMs: number; maxMs: number; names: readonly string[]; setup(name: string): Promise<string>; check(name: string): void; restore(name: string): Promise<void> };
  // The cold run and run 0 both delete the first run branch; the restore between them pushes it again. Run k deletes run branch k + 1.
  async function runSeries(s: Session, r: Run, sc: string): Promise<unknown[]> {
    const series = newSeries(`${sc} ${r.label}`);
    const sc009e: Inputs[] = [];
    const results: unknown[] = [];
    await metrics(s.c, `${series.name} start`);
    for (let run = -1; run <= RUNS; run++) {
      const tag = run < 0 ? "cold" : `run ${run}`;
      const name = r.names[Math.max(0, run)]!;
      await clearFilter(s.c);
      const done = await r.setup(name);
      const before = usage(s.app.pid);
      const ms = await timed(s, `${r.label} ${tag} ${name}`, [outcomeShown(done)], () => press(s.c, "Enter"), "keydown", probe(s.c));
      const after = usage(s.app.pid);
      sc009e.push(await inputs(s.c, `${r.label} ${tag}`));
      await idle(s);
      r.check(name);
      await r.restore(name);
      if (run < 0) {
        recordCold(series.name, ms, before, after);
        await heap(s.c, `${series.name} cold`);
        results.push(cold(series.name, ms, COLD_FACTOR * r.medianMs));
      } else await recordRun(s.c, series, run, ms, before, after);
    }
    await metrics(s.c, `${series.name} end`);
    results.push(verdict(series, r.medianMs, r.maxMs));
    results.push({ name: `SC-009e ${sc} ${r.label}`, inputs: sc009e.every((x) => x.count >= MIN_INPUTS), p95: sc009e.every((x) => x.p95 <= INPUT_P95_MS), max: sc009e.every((x) => x.max <= INPUT_MAX_MS) });
    return results;
  }

  // The SC-009c or SC-009d series on `repo` (a copy of M-D). It gives the verdicts; a WSL case records them only.
  async function deletes(label: string, repo: Repo, form: Run["name"]): Promise<unknown[]> {
    const git = repo.git;
    const mTip = rev(repo, "refs/heads/main");
    const s = await session(label, repo);
    // Git's own listings: the bare remote has no branch `name`, and the repository has no ref `refs`.
    const gone = (name: string, refs: string[]) => {
      expect({ name, remote: git(["ls-remote", RD_REMOTE, `refs/heads/${name}`]), refs: git(["for-each-ref", "--format=%(refname)", ...refs]) }).toEqual({ name, remote: "", refs: "" });
    };
    const push = (name: string) => git(["push", "-q", RD_REMOTE, `${mTip}:refs/heads/${name}`]);
    const remote: Run = {
      name: "remote",
      label: "remote only",
      medianMs: REMOTE_MEDIAN_MS,
      maxMs: REMOTE_MAX_MS,
      names: RD_REMOTE_RUNS,
      async setup(name) {
        const t = tracking(name);
        await focusOn(s.c, remoteRow(t), `the ${t} row`);
        await press(s.c, "Delete");
        const dialog = dialogWith(RD.title(t));
        await until<boolean>(s.c, "the remote dialog with its plan", enabled(buttonIn(dialog, RD.button)), (v) => v);
        await focusButton(s, dialog, RD.button);
        await idle(s);
        return REMOTE_DONE(t);
      },
      check: (name) => gone(name, [`refs/remotes/${tracking(name)}`]),
      async restore(name) {
        // git-push(1): a push to a remote with a fetch refspec also updates the remote-tracking ref.
        push(name);
        await refreshed(s, `!!(${remoteRow(tracking(name))})`);
      },
    };
    const combined: Run = {
      name: "combined",
      label: "combined",
      medianMs: BOTH_MEDIAN_MS,
      maxMs: BOTH_MAX_MS,
      names: RD_COMBINED_RUNS,
      async setup(name) {
        const t = tracking(name);
        await focusOn(s.c, localRow(name), `the ${name} row`);
        await press(s.c, "Delete");
        const dialog = dialogWith(DELETE_TITLE(name));
        await until<boolean>(s.c, "the local dialog with X9", `${enabled(buttonIn(dialog, DELETE_BUTTON))} && (${checkboxIn(dialog)})?.checked === false`, (v) => v);
        await focusOn(s.c, checkboxIn(dialog), "X9");
        await press(s.c, "Space");
        await until<boolean>(s.c, "the combined plan", combinedPlan(name, RD.bothNoneLost(name, t)), (v) => v);
        await focusButton(s, dialog, DELETE_BUTTON);
        await idle(s);
        return BOTH_DONE(name, t);
      },
      check: (name) => gone(name, [`refs/remotes/${tracking(name)}`, `refs/heads/${name}`]),
      async restore(name) {
        push(name);
        git(["branch", "-q", "--track", name, `refs/remotes/${tracking(name)}`]);
        await refreshed(s, `!!(${localRow(name)}) && !!(${remoteRow(tracking(name))})`);
      },
    };
    try {
      return await runSeries(s, form === "remote" ? remote : combined, repo.wsl ? "WSL" : form === "remote" ? "SC-009c" : "SC-009d");
    } finally {
      await end(s);
    }
  }

  test.skipIf(reason !== null)(
    "SC-009c, SC-009e: on M-D the remote-only delete through the local bare remote ends at its outcome text with a median of at most 1.5 s and each run at most 3 s; the cold run at most 3 s; typing in the history filter keeps p95 100 ms and max 500 ms with at least 20 inputs per run",
    async () => {
      const results = await deletes("sc009c", rdCopy("t020-c").repo, "remote");
      expect(results).toEqual([{ name: "SC-009c remote only", cold: true }, { name: "SC-009c remote only", median: true, every: true }, { name: "SC-009e SC-009c remote only", inputs: true, p95: true, max: true }]);
    },
    caseTimeout(40 + 25 * (RUNS + 2), OPEN_WAIT_MS + 30 * 60_000),
  );

  test.skipIf(reason !== null)(
    "SC-009d, SC-009e: on M-D the combined delete ends at its outcome text with a median of at most 2 s and each run at most 4 s; the cold run at most 4 s; typing in the history filter keeps p95 100 ms and max 500 ms with at least 20 inputs per run",
    async () => {
      const results = await deletes("sc009d", rdCopy("t020-d").repo, "combined");
      expect(results).toEqual([{ name: "SC-009d combined", cold: true }, { name: "SC-009d combined", median: true, every: true }, { name: "SC-009e SC-009d combined", inputs: true, p95: true, max: true }]);
    },
    caseTimeout(40 + 25 * (RUNS + 2), OPEN_WAIT_MS + 30 * 60_000),
  );

  // ---- WSL records (plan.md D11 "record"): the same series in the owned folder of Ubuntu-26.04 with the bare remote in the distro. No budget. ----

  const record = (name: string, results: unknown[]) => console.log(`RECORD ${TASK}: ${name}: ${js(results)}`);
  const wslRd = (name: string) => {
    checkM(ensurePerfFixture(GIT!, PERF_M));
    return distroRepo(ensureRd(GIT!), name);
  };

  test.skipIf(wslReason !== null)(
    "WSL record SC-009b: on a distro copy of M-D, the SC-009b series (10 + 1 runs per form), no budget",
    async () => {
      record("SC-009b WSL", await sc009b("wsl-sc009b", wslRd("rd-b")));
    },
    caseTimeout(30 + 14 * (2 * (RUNS + 1) + 1), 2 * OPEN_WAIT_MS + 60 * 60_000),
  );

  test.skipIf(wslReason !== null)(
    "WSL record SC-009c, SC-009e: on a distro copy of M-D with the bare remote in the distro, the remote-only delete (10 + 1 runs), no budget",
    async () => {
      record("SC-009c WSL", await deletes("wsl-sc009c", wslRd("rd-c"), "remote"));
    },
    caseTimeout(40 + 25 * (RUNS + 2), 2 * OPEN_WAIT_MS + 60 * 60_000),
  );

  test.skipIf(wslReason !== null)(
    "WSL record SC-009d, SC-009e: on a distro copy of M-D with the bare remote in the distro, the combined delete (10 + 1 runs), no budget",
    async () => {
      record("SC-009d WSL", await deletes("wsl-sc009d", wslRd("rd-d"), "combined"));
    },
    caseTimeout(40 + 25 * (RUNS + 2), 2 * OPEN_WAIT_MS + 60 * 60_000),
  );
});
