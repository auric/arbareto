// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 010 T018: the commit menu budgets in the installed package (plan.md D9; spec SC-010a to SC-010d, SC-011, FR-080). `Local: package`.
// The cases drive the page through the WebView2 CDP endpoint and UI Automation patterns. They send no OS input and never move the pointer.
// Page timing: the time from the `timeStamp` of the input event to the start of the first animation frame whose page holds the result (as T048).
// A right-click is the UIA ShowContextMenu call, which Chromium sends to the page as a `contextmenu` event (uia.ts `showContextMenu`).
// Run 0 of each series is the warm-up run. It counts for the every-run bound, never for the median (001 spec.md:95).
// The cold run is the first sample of a new app session. Its budget is 2 times the median (SC-010a: p95) budget of its measure (plan.md D9 "cold").
// CPU seconds and private bytes are records without a budget. They sum the live processes of the app tree before and after each run.
// The per-process private bytes and the renderer heap figures are also records without a budget.
// shortcut: a Git child that ends during the run leaves the CPU sum; read the Job accounting of installed-app.ts when the record needs it.
// The WSL cases are records without a budget (spec SC-010 "WSL times"). They run only when `ARBARETO_WSL_DISTRO` names `Ubuntu-26.04`. `Local: WSL`, alone.

import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { FIXED_IDENTITY, fixtureDir, FIXTURE_ROOT, ownedGit, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { sha256 } from "../git/git-oracle";
import type { GitHost } from "../git/remote-fixtures";
import { printOrigin } from "../origin";
import { distroGitHost, sh } from "../wsl/fixtures";
import { missingCapability, uncPath, useWslFolder, wslExec, wslHost, type WslHost } from "../wsl/wsl-host";
import { connectPage, freePort, MOD, watchIpc, type Cdp, type IpcLog } from "./cdp";
import { copyMr, ensureMr, MR_CHANGED_PATHS, MR_FILES_PER_COMMIT, type MrFacts } from "./commit-menu-fixture";
import { appEnv, descendants, findInstalledApp, HISTORY_VIEW, powershellJson, PROBE_TIMEOUT_MS, processRecords, startInstalledApp, WAIT_MS, waitExit, type OwnedProcess } from "./installed-app";
import { copyPerfFixture, ensurePerfFixture, PERF_CACHE_ROOT, PERF_L, PERF_M, type CachedPerfFixture } from "./perf-fixtures";
import { close, ControlType, find, invoke, MAX_CALL_MS, MAX_WAIT_MS, setValue, showContextMenu, UiaError, type Element } from "./uia";

for (const helper of ["./cdp.ts", "./installed-app.ts", "./uia.ts", "./perf-fixtures.ts", "./commit-menu-fixture.ts", "../wsl/wsl-host.ts", "../wsl/fixtures.ts"]) printOrigin(helper, import.meta.dir);
// The package under test holds these sources. The `ORIGIN` line of `findInstalledApp` names the installed binary and its SHA-256.
for (const source of ["../../src/frontend/history/CommitActions.tsx", "../../src/frontend/history/commit-texts.ts", "../../src/frontend/history/HistoryList.tsx", "../../src/git-service/commit-actions.ts"]) printOrigin(source, import.meta.dir);

const TASK = "T018";
const STEP_MS = MAX_WAIT_MS + MAX_CALL_MS;
const caseTimeout = (steps: number, extraMs = 0) => steps * STEP_MS + 2 * PROBE_TIMEOUT_MS + 2 * WAIT_MS + extraMs;
// Plan.md D9: 10 warm runs and 1 warm-up run per action.
const RUNS = 10;
// Plan.md D9 SC-010a: 20 right-click opens and 20 Shift+F10 opens per run, on distinct rows.
const OPENS = 20;
// The page waits for each step at most this long. A step past it fails the case.
const STEP_LIMIT_MS = 60_000;
const OPEN_WAIT_MS = 300_000;
const IDLE_POLL_MS = 10;
// Spec SC-011: at least 20 inputs per run. The probe sends one input to the history filter every PROBE_INTERVAL_MS.
const MIN_INPUTS = 20;
// The probe timer period. The loop does not wait for CDP replies, so the 20-input minimum also holds for runs near 400 ms.
const PROBE_INTERVAL_MS = 10;
// The Event Timing API reports no entry below its 16 ms minimum `durationThreshold`, so such an input counts as 16 ms.
const EVENT_THRESHOLD_MS = 16;
// One keyboard walk ends after this many presses. Target row 100 of M-R lies about 104 rows down.
const WALK = 200;

// ---- Budgets (plan.md D9, fixed before any run) ----

// SC-010a (001 SC-005): p95 at most 100 ms; every open at most 500 ms.
const OPEN_P95_MS = 100;
const OPEN_MAX_MS = 500;
// SC-010b: median at most 300 ms; every run at most 500 ms.
const POPOVER_MEDIAN_MS = 300;
const POPOVER_MAX_MS = 500;
// SC-010c: median at most 1 s; every run at most 2 s.
const HARD_REVIEW_MEDIAN_MS = 1_000;
const HARD_REVIEW_MAX_MS = 2_000;
// SC-010d medians. Every run: at most 2 times its budget.
const RUN_MEDIAN_MS = { soft: 1_000, mixed: 2_000, tag: 1_000, hard: 4_000, pick: 2_000, revert: 2_000, abort: 2_000, continue: 2_000, checkout: 4_000 } as const;
const RUN_MAX_FACTOR = 2;
// Plan.md D9 "cold": 2 times the warm budget.
const COLD_FACTOR = 2;
// SC-011 (001 SC-005 targets).
const INPUT_P95_MS = 100;
const INPUT_MAX_MS = 500;

// ---- App texts (the source of each value is named) ----

// src/frontend/app/RepositorySwitcher.tsx `OPEN_FOLDER`.
const OPEN_FOLDER = "Open folder… (Ctrl+O)";
// src/frontend/status/OperationStatus.tsx `shortId`: the first 12 hex digits.
const short = (oid: string) => oid.slice(0, 12);
// Plan.md D11 (src/frontend/history/commit-texts.ts).
const MENU_NAME = (oid: string) => `Actions for commit ${short(oid)}`;
const ITEM = { checkout: "Check out this commit (detached HEAD)…", tag: "Create tag here…", pick: "Cherry-pick commit…", revert: "Revert commit…", reset: "Reset current branch (main) to here…" } as const;
const CHECKOUT_TITLE = (oid: string) => `Check out commit ${short(oid)}?`;
const TAG_TITLE = (oid: string) => `Create tag at ${short(oid)}`;
const TAG_BUTTON = "Create tag";
const TAG_DONE = (name: string, oid: string) => `Created tag ${name} at ${short(oid)}. Arbareto does not push tags.`;
const RESET_TITLE = (oid: string) => `Reset main to ${short(oid)}?`;
const RESET_BUTTON = "Reset";
const HARD_BUTTON = "Reset hard…";
const HARD_CONFIRM = "Reset hard";
const RESET_DONE = (oid: string) => `Reset main to ${short(oid)}.`;
const PICK_TITLE = (pick: boolean, oid: string) => (pick ? `Cherry-pick ${short(oid)} to main?` : `Revert ${short(oid)} on main?`);
const PICK_BUTTON = (pick: boolean) => (pick ? "Cherry-pick" : "Revert");
const PICK_DONE = (pick: boolean, oid: string) => (pick ? `Cherry-picked ${short(oid)} to main.` : `Reverted ${short(oid)} on main.`);
// src/frontend/branches/texts.ts `OUTCOME.detached` with the short ID.
const CHECKOUT_BUTTON = "Check out";
const CHECKOUT_DONE = (oid: string) => `Checked out ${short(oid)}. HEAD is detached.`;
// src/frontend/sync/ConflictActions.tsx `KINDS["cherry-picking"]`, and OperationStatus.tsx `SYNC_NAMES` with the succeeded line "<name> completed".
const ABORT_ITEM = "Abort cherry-pick…";
const ABORT_BUTTON = "Abort cherry-pick";
const CONTINUE_BUTTON = "Continue";
const ABORT_DONE = "Abort completed";
const CONTINUE_DONE = "Continue completed";
// src/frontend/history/HistoryFilter.tsx `FILTER_LABEL`.
const FILTER_LABEL = "Filter commit messages";

// ---- CDP keys (as tests/windows/revert-perf.test.ts) ----

const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", vk: 0x0d, text: "\r" },
  Escape: { key: "Escape", code: "Escape", vk: 0x1b },
  Tab: { key: "Tab", code: "Tab", vk: 0x09 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 0x08 },
  Home: { key: "Home", code: "Home", vk: 0x24 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 0x26 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 0x28 },
  F5: { key: "F5", code: "F5", vk: 0x74 },
  F10: { key: "F10", code: "F10", vk: 0x79 },
  x: { key: "x", code: "KeyX", vk: 0x58, text: "x" },
};
const MODIFIER_KEYS = [
  { bit: MOD.Alt, key: "Alt", code: "AltLeft", vk: 0x12 },
  { bit: MOD.Ctrl, key: "Control", code: "ControlLeft", vk: 0x11 },
  { bit: MOD.Shift, key: "Shift", code: "ShiftLeft", vk: 0x10 },
];
function keyParams(name: string, modifiers = 0): object[] {
  const k = KEYS[name];
  if (k === undefined) throw new Error(`no key ${JSON.stringify(name)}`);
  const held = MODIFIER_KEYS.filter((m) => modifiers & m.bit);
  const typed = k.text !== undefined && modifiers === 0;
  return [
    ...held.map((m) => ({ type: "rawKeyDown", key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, modifiers })),
    { type: typed ? "keyDown" : "rawKeyDown", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers, ...(typed ? { text: k.text, unmodifiedText: k.text } : {}) },
    { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers },
    ...held.toReversed().map((m) => ({ type: "keyUp", key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, modifiers: 0 })),
  ];
}
async function press(c: Cdp, name: string, modifiers = 0): Promise<void> {
  for (const params of keyParams(name, modifiers)) await c.send("Input.dispatchKeyEvent", params);
}
// Sends all events of one press at once. CDP keeps the send order, and the result settles when each reply arrives.
const queue = (c: Cdp, name: string) => Promise.all(keyParams(name).map((params) => c.send("Input.dispatchKeyEvent", params))).then(() => undefined);

const js = (value: unknown) => JSON.stringify(value);

// ---- Page expressions ----

const footer = `document.querySelector('[data-slot=status-region] footer')`;
// The workbench notice cell (the 004 switch outcome) and the operation line (every other outcome) are `role=status` cells of the footer.
const outcomeShown = (text: string, changed = false) => `[...((${footer})?.querySelectorAll('[role=status]') ?? [])].some((e) => e.textContent.trim() === ${js(text)}${changed ? " && window.__t018.changed.has(e)" : ""})`;
// src/frontend/app/Workbench.tsx `statusText`: the first status cell shows these texts while a read runs or the state is blocked.
// A reconcile block shows counts there. The Remote sync group then holds its reason (SyncToolbar.tsx `quietText`).
const settled = `!['Refreshing…', 'State unknown'].includes(((${footer})?.querySelector('span[role=status]:not([tabindex])')?.textContent ?? '').trim()) && !(document.querySelector('[role=group][aria-label="Remote sync"]')?.textContent ?? '').includes('The status read after the last operation is still running.')`;
const list = `document.querySelector('[data-history-list]')`;
const selectedRow = `(document.querySelector('[data-history-list] [role=option][aria-selected=true]')?.dataset.rowId ?? null)`;
// HistoryList.tsx: the checkout row holds the HEAD badge.
const headRow = `(document.querySelector('[data-history-list] [role=option] .badge')?.closest('[role=option]')?.dataset.rowId ?? null)`;
const rowById = (oid: string) => `document.querySelector('[data-history-list] [role=option][data-row-id="${oid}"]')`;
const open = (selector: string) => `[...document.querySelectorAll(${js(selector)})].filter((e) => !e.hasAttribute('data-closed') && !e.hasAttribute('data-ending-style'))`;
const menuOpen = (oid: string) => `${open("[role=menu]")}.some((m) => m.getAttribute('aria-label') === ${js(MENU_NAME(oid))})`;
const anyMenu = `${open("[role=menu]")}.length > 0`;
const popover = (title: string) => `${open("[data-slot=popover-content]")}.find((p) => p.textContent.includes(${js(title)}))`;
const anyPopover = `${open("[data-slot=popover-content]")}.length > 0`;
const enabledButton = (scope: string, text: string) => `[...((${scope})?.querySelectorAll('button') ?? [])].some((b) => b.textContent.trim() === ${js(text)} && !b.disabled && b.getAttribute('aria-disabled') !== 'true')`;
// A review ends with its plan (an available confirm button) or with its refusal (a `role=alert` line).
const reviewed = (title: string, button: string) => `!!(${popover(title)}) && (!!(${popover(title)}).querySelector('[role=alert]') || ${enabledButton(popover(title), button)})`;
const dialogWith = (title: string) => `${open("[role=alertdialog],[role=dialog]")}.find((d) => d.textContent.includes(${js(title)}))`;
const anyDialog = `${open("[role=alertdialog],[role=dialog]")}.length > 0`;
const buttonIn = (scope: string, text: string) => `[...((${scope})?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === ${js(text)})`;
const bandButton = (text: string) => `[...document.querySelectorAll('[data-slot="conflict-row"] button')].find((b) => b.textContent.trim() === ${js(text)} && !b.disabled && b.getAttribute('aria-disabled') !== 'true')`;
const menuItem = (label: string) => `${open("[role=menu]")}.flatMap((m) => [...m.querySelectorAll('[role=menuitem]')]).find((i) => i.querySelector('[data-slot=menu-label]')?.textContent === ${js(label)})`;
const filterField = `document.querySelector(${js(`input[aria-label="${FILTER_LABEL}"]`)})`;

// `arm` records the `timeStamp` of the next `kind` event and resolves with the time at which each check first holds in an animation frame callback.
// The time is `performance.now()` in the callback (as T048). A check that holds at `arm`, an event before `arm`, or a negative time gives `ok: false`.
// `changed` holds each `role=status` cell of the status region that changed after `arm`, so an outcome text equal to the last one still needs a new render of its cell.
// The key log of SC-011 holds each probe keydown whose target is the history filter.
// With `probe`, the first `click` after `arm` (the run button activation) moves the focus to the filter in a later task.
// The later task lets the default action of the click (a form submit) run first. A `focusout` of the filter then puts the focus back in a later task, until the result holds.
// The end calls the CDP binding DONE_BINDING, so the probe loop stops without a page poll.
const DONE_BINDING = "__t018Done";
const PAGE = `(() => {
  if (window.__t018 !== undefined) return true;
  window.__t018Keys = [];
  window.__t018Events = [];
  addEventListener('keydown', (e) => { if (e.target?.getAttribute?.('aria-label') === ${js(FILTER_LABEL)}) window.__t018Keys.push(e.timeStamp); }, { capture: true });
  new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.name === 'keydown') window.__t018Events.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'event', durationThreshold: ${EVENT_THRESHOLD_MS} });
  window.__t018 = {
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
    popovers: [...document.querySelectorAll('[data-slot=popover-content]')].map(text),
    dialogs: [...document.querySelectorAll('[role=alertdialog],[role=dialog]')].map(text),
    band: [...document.querySelectorAll('[data-slot="conflict-row"]')].map(text),
    selected: ${selectedRow},
    head: ${headRow},
    scrollTop: document.querySelector('[data-history-list]')?.scrollTop ?? null,
    rows: [...document.querySelectorAll('[data-history-list] [role=option]')].slice(0, 4).map((o) => (o.dataset.item ?? '') + ':' + (o.dataset.rowId ?? '').slice(0, 12) + (o.querySelector('.badge') ? ' badge' : '')),
  };
})()`;

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
// Arms the page, runs `act`, and calls `during` until the page holds the result. `kind` is the DOM event that starts the time.
// `during` starts together with `act`. CDP sends its input events in order, so each probe input reaches the page after the run press.
// The key loop calls `during` on a fixed timer and waits for no CDP reply, so an input also waits in the queue of a main-thread task. Event Timing then holds that wait.
// The loop awaits all `during` results after the window ends.
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
    await c.evaluate(`(window.__t018Keys = [], window.__t018Events = [], window.__t018.arm([${checks.map((check) => `() => (${check})`).join(", ")}], ${STEP_LIMIT_MS}, ${js(kind)}, ${during !== undefined}))`);
    const acting = act();
    acting.catch(() => (ended = true));
    if (during !== undefined) {
      const sent: Promise<void>[] = [];
      for (const end = Date.now() + STEP_LIMIT_MS + 5_000; !ended && Date.now() < end; await Bun.sleep(PROBE_INTERVAL_MS)) {
        const p = during();
        p.catch(() => (ended = true));
        sent.push(p);
      }
      ended = true;
      await Promise.all(sent);
    }
    await acting;
    if (during !== undefined && !signalled) throw new Error(`the page gave no ${DONE_BINDING} call within ${STEP_LIMIT_MS + 5_000} ms: ${js(await c.evaluate<unknown>(FACTS))}`);
  } finally {
    off();
  }
  const r = (await until<Timed | null>(c, "the timed step", "window.__t018.value", (v) => v !== null, STEP_LIMIT_MS + 5_000))!;
  if (!r.ok || r.start === null || !r.times.every((t) => t !== null && t >= 0)) throw new Error(`a timed step is not valid: ${js(r)} ${js(await c.evaluate<unknown>(FACTS))}`);
  const ms = Math.max(...(r.times as number[]));
  // Record, no budget. The start offset compares the CDP `wallTime` with the page `timeOrigin`, two wall clocks. The duration uses the CDP `MonotonicTime` only.
  const press = r.origin + r.start;
  const split = s.ipc
    .calls()
    .slice(from)
    .filter((t) => t.wall * 1000 <= press + ms)
    .map((t) => `${t.command} at ${r1(t.wall * 1000 - press)} ms for ${t.end === null ? "open" : `${r1((t.end - t.sent) * 1000)} ms`}`);
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

// `type` is the Chromium `--type=` switch of a `msedgewebview2.exe` command line, or `none` without it (the browser process). Other images have null.
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

// ---- SC-011 inputs (W3C Event Timing) ----

type Inputs = { label: string; count: number; p95: number; max: number };
async function inputs(c: Cdp, label: string): Promise<Inputs> {
  await c.evaluate("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))");
  const { keys, events, start } = await c.evaluate<{ keys: number[]; events: { start: number; duration: number }[]; start: number }>("({ keys: window.__t018Keys, events: window.__t018Events, start: window.__t018.value.start })");
  const durations = keys.map((k) => events.find((e) => e.start === k)?.duration ?? EVENT_THRESHOLD_MS);
  const r = { label, count: durations.length, p95: durations.length === 0 ? 0 : p95(durations), max: durations.length === 0 ? 0 : Math.max(...durations) };
  // Offsets count from the `timeStamp` of the run press. `measured` lists each input at or above the Event Timing threshold as [offset, duration].
  const offset = (k: number) => r1(k - start);
  const spacing = keys.length < 2 ? null : r1(median(keys.slice(1).map((k, i) => k - keys[i]!)));
  const measured = keys.flatMap((k) => events.filter((e) => e.start === k).map((e) => [offset(k), e.duration]));
  console.log(`OBSERVATION ${TASK}: SC-011 ${label}: ${r.count} inputs, p95 ${r.p95} ms, max ${r.max} ms; first input at ${keys.length === 0 ? null : offset(keys[0]!)} ms, median spacing ${spacing} ms, measured ${js(measured)}`);
  return r;
}

describe.skipIf(process.platform !== "win32")("T018 packaged commit menu budgets", () => {
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

  // WSL detection starts the distro, so it runs only for a WSL run. The cases use the distro of spec SC-010 "WSL times".
  const WSL_DISTRO = "Ubuntu-26.04";
  const wslWanted = process.env.ARBARETO_WSL_DISTRO;
  const host = reason === null && wslWanted !== undefined && wslWanted !== "" ? wslHost() : null;
  const wslReason =
    reason ?? (host === null ? "ARBARETO_WSL_DISTRO unset" : (missingCapability(["wsl-fixture-fs-id", "distro-git-2.55"]) ?? (host.distro === WSL_DISTRO ? null : `ubuntu-26.04: the test distro is ${host.distro}`)));
  if (wslReason === null) useWslFolder();
  else console.log(`SKIP ${TASK} WSL: ${wslReason}`);

  const under = (root: string, repo: string) => !relative(root, repo).startsWith("..") && !isAbsolute(relative(root, repo));
  // One repository of the cases: `folder` is the path that the folder dialog gets. Each Git call runs on the side of the repository.
  type Repo = {
    folder: string;
    wsl: boolean;
    git(args: string[], allowExit?: number[], input?: Uint8Array): string;
    // The SHA-256 of the Git output. A distro repository computes it in the distro.
    digest(args: string[]): string;
    exists(path: string): boolean;
    write(path: string, text: string): void;
    copy(from: string, to: string): void;
  };
  function winRepo(dir: string): Repo {
    if (!under(FIXTURE_ROOT, dir)) throw new Error(`the repository is outside the fixture root: ${dir}`);
    const git = (args: string[], allowExit = [0], input?: Uint8Array) => ownedGit(GIT!, FIXTURE_ROOT, dir, args, { allowExit, ...(input === undefined ? {} : { input }) }).toString("utf8");
    return { folder: dir, wsl: false, git, digest: (args) => sha256(Buffer.from(git(args), "utf8")), exists: existsSync, write: (path, text) => writeFileSync(join(dir, ...path.split("/")), text), copy: copyFileSync };
  }
  const rev = (repo: Repo, name: string) => repo.git(["rev-parse", "--verify", "--end-of-options", `${name}^{commit}`]).trim();
  const tree = (repo: Repo, name: string) => repo.git(["rev-parse", "--verify", "--end-of-options", `${name}^{tree}`]).trim();

  // ---- WSL repositories (as tests/windows/revert-perf.test.ts: a Windows tar stream to tar in the distro) ----

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
  // A distro copy of the cached repository `cachedRepo` (read only). Its refs and status must equal those of the cache, computed with Windows Git.
  function distroRepo(cachedRepo: string, name: string): Repo {
    const w = host!;
    wslGit ??= distroGitHost(w, "t018", WSL_GLOBAL);
    const h = wslGit;
    const root = `${h.root}/${name}`;
    const dir = `${root}/${basename(cachedRepo)}`;
    sh(w, 'mkdir -- "$1"', [root]);
    toDistro(w, dirname(cachedRepo), basename(cachedRepo), root);
    const git = (args: string[], allowExit = [0], input?: Uint8Array) => {
      const r = h.run(dir, args, { timeoutMs: WSL_CALL_MS, ...(input === undefined ? {} : { input }) });
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
    const repo: Repo = { folder: uncPath(w, dir), wsl: true, git, digest, exists: (path) => h.existing([path]).length === 1, write: (path, text) => h.write(`${dir}/${path}`, text), copy: (from, to) => h.copy(from, to) };
    // Git for Windows writes these keys at `init`, so the distro copy drops them (as revert-perf.test.ts).
    for (const key of ["core.symlinks", "core.ignorecase", "core.filemode"]) git(["config", "--local", "--unset", key], [0, 5]);
    // The app's distro Git gets no fixture environment (empty WSLENV), so its commits read the identity from the repository config.
    git(["config", "--local", "user.name", FIXED_IDENTITY.name]);
    git(["config", "--local", "user.email", FIXED_IDENTITY.email]);
    expect(git(["config", "--local", "--get", "user.name"]).trim()).toBe(FIXED_IDENTITY.name);
    expect(git(["config", "--local", "--get", "user.email"]).trim()).toBe(FIXED_IDENTITY.email);
    // The `wsl.exe` environment of the app: empty WSLENV and no GIT_CONFIG_* variable. The distro Git has no user.name at another scope.
    const ident = wslExec(["--distribution", w.distro, "--cd", "/", "--exec", w.probe.paths.git!, "-C", dir, "var", "GIT_COMMITTER_IDENT"], { timeoutMs: WSL_CALL_MS });
    console.log(`WSL ${TASK}: app-environment GIT_COMMITTER_IDENT exit ${ident.exitCode}: ${js(ident.stdout.trim() || ident.stderr.trim())}`);
    expect({ exit: ident.exitCode, ident: ident.stdout.startsWith(`${FIXED_IDENTITY.name} <${FIXED_IDENTITY.email}> `) }).toEqual({ exit: 0, ident: true });
    git(["update-index", "-q", "--refresh"], [0, 1]);
    const shape = [
      ["for-each-ref", "--format=%(objectname) %(refname)"],
      ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
    ].map((args) => ({ args: args.join(" "), windows: sha256(ownedGit(GIT!, PERF_CACHE_ROOT, cachedRepo, ["--no-optional-locks", ...args])), distro: digest(args) }));
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
  // `uia.ts` `find` waits at most MAX_WAIT_MS, so a longer wait repeats it until `ms` passes (as revert-packaged.test.ts).
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
    // The switcher label of a distro repository is not fixed by a 001 text, so a WSL session waits for a label that names the folder (as revert-perf.test.ts).
    const shown = (v: string | null) => (repo.wsl ? v !== null && v.startsWith(`${basename(top)}, `) : v === `${basename(top)}, ${top}`);
    // Each start has a new profile folder (appEnv sets ARBARETO_PROFILE_ROOT below it).
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
      // A WSL folder asks for its distro Git in a native confirmation with Use this Git and Cancel (src-tauri/src/dialogs.rs `wsl_git_confirmation`). The first open can start the distro.
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
      await refreshed(s, rev(repo, "HEAD"));
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
  // F5 reads the workspace again after a change outside the app. The HEAD row then names `head`.
  async function refreshed(s: Session, head: string, extra = "true"): Promise<void> {
    await focusOn(s.c, list, "the History list");
    await press(s.c, "F5");
    await idle(s);
    // The list renders only the rows near its scroll position. Each poll scrolls it to the top, where the HEAD row of each fixture lies. A later read can scroll it back to the selection.
    await until<boolean>(s.c, `the HEAD row ${short(head)}`, `((${list}).scrollTop = 0, ${headRow} === ${js(head)} && (${extra}) && ${settled})`, (v) => v);
    await idle(s);
  }
  // Selects the row `oid` by keyboard: Home, then Down until it is the selected row.
  async function selectRow(s: Session, oid: string): Promise<void> {
    await focusOn(s.c, list, "the History list");
    if ((await s.c.evaluate<string | null>(selectedRow)) === oid) return;
    await press(s.c, "Home");
    for (let i = 0; i < WALK; i++) {
      if ((await s.c.evaluate<string | null>(selectedRow)) === oid) return;
      await press(s.c, "ArrowDown");
    }
    await until<string | null>(s.c, `the selected row ${short(oid)}`, selectedRow, (v) => v === oid, 1_000);
  }
  // Shift+F10 on the selected row opens its menu, and Down moves to `label`. The focus is then on the item.
  async function toItem(s: Session, oid: string, label: string): Promise<void> {
    await selectRow(s, oid);
    await press(s.c, "F10", MOD.Shift);
    await until<boolean>(s.c, "the commit menu", menuOpen(oid), (v) => v);
    for (let i = 0; i < 12 && !(await s.c.evaluate<boolean>(`document.activeElement === (${menuItem(label)})`)); i++) await press(s.c, "ArrowDown");
    await until<boolean>(s.c, `the focus on ${label}`, `document.activeElement === (${menuItem(label)})`, (v) => v, 1_000);
  }
  async function closeAll(s: Session): Promise<void> {
    for (let i = 0; i < 3 && (await s.c.evaluate<boolean>(`${anyMenu} || ${anyPopover} || ${anyDialog}`)); i++) await press(s.c, "Escape");
    await until<boolean>(s.c, "no open menu, popover, or dialog", `!(${anyMenu}) && !(${anyPopover}) && !(${anyDialog})`, (v) => v);
    await idle(s);
  }
  // One SC-011 probe: an x or a Backspace in the history filter. The pair keeps the field short. The page moves the focus (`arm` with `probe`).
  const probe = (c: Cdp) => {
    let n = 0;
    return () => queue(c, n++ % 2 === 0 ? "x" : "Backspace");
  };
  const clearFilter = (c: Cdp) => c.evaluate(`(() => { const f = ${filterField}; if (f && f.value !== '') { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, ''); f.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`);

  // U3 (research.md R5): the cached L and M have the D9 shape. The counts come from Git on the cached repository, read-only.
  function checkShape(cached: CachedPerfFixture, spec: typeof PERF_M): void {
    const g = (args: string[]) => ownedGit(GIT!, PERF_CACHE_ROOT, cached.repo, ["--no-optional-locks", ...args]).toString("utf8");
    const shape = {
      name: spec.name,
      commits: Number(g(["rev-list", "--count", "--all"]).trim()),
      refs: g(["for-each-ref", "--format=%(refname)"]).trim().split("\n").length,
      files: g(["ls-files", "-z"]).split("\0").filter((p) => p !== "").length,
      commitGraph: cached.manifest.facts.commitGraph,
    };
    console.log(`OBSERVATION ${TASK}: fixture ${spec.name} ${cached.reused ? "reused" : "built"} at ${cached.folder}: ${js(shape)}`);
    expect(shape).toEqual({ name: spec.name, commits: spec.commits, refs: spec.refs, files: spec.files, commitGraph: true });
  }

  // ---- SC-010a: input to menu paint on L ----

  test.skipIf(reason !== null)(
    "SC-010a, U3: on L (100,000 commits, 256 refs) with History open, 20 right-click and 20 Shift+F10 opens on distinct rows paint the commit menu with p95 at most 100 ms and each open at most 500 ms; the cold open at most 200 ms",
    async () => {
      const cached = ensurePerfFixture(GIT!, PERF_L);
      checkShape(cached, PERF_L);
      const repo = winRepo(copyPerfFixture(GIT!, cached, "t018-l"));
      const s = await session("sc010a", repo);
      try {
        // Commit row k is the option with data-item k + 2 (HistoryList.tsx: the Working directory and Index rows come first).
        const rowAt = (k: number) => `document.querySelector('[data-history-list] [role=option][data-item="${k + 2}"]')`;
        const oidAt = async (k: number) => {
          for (let i = 0; i < WALK && (await s.c.evaluate<string | null>(`(${rowAt(k)})?.dataset.rowId ?? null`)) === null; i++) await press(s.c, "ArrowDown");
          return until<string | null>(s.c, `commit row ${k}`, `(${rowAt(k)})?.dataset.rowId ?? null`, (v) => v !== null);
        };
        const opened: string[] = [];
        const byKey = async (k: number) => {
          const oid = (await oidAt(k))!;
          await selectRow(s, oid);
          const ms = await timed(s, `shift-f10 row ${k}`, [menuOpen(oid)], () => press(s.c, "F10", MOD.Shift));
          opened.push(oid);
          await closeAll(s);
          return ms;
        };
        // The list scrolls its selected row into view. A row that meets the list box is on screen, also when the box cuts it.
        const visible = (oid: string) => `(() => { const r = ${rowById(oid)}; const l = ${list}; if (!r || !l) return false; const a = r.getBoundingClientRect(), b = l.getBoundingClientRect(); return a.bottom > b.top && a.top < b.bottom; })()`;
        const byMouse = async (k: number) => {
          const oid = (await oidAt(k))!;
          if (!(await s.c.evaluate<boolean>(visible(oid)))) await selectRow(s, oid);
          await until<boolean>(s.c, `row ${k} on screen`, visible(oid), (v) => v);
          const name = (await s.c.evaluate<string | null>(`(${rowById(oid)})?.getAttribute('aria-label') ?? null`))!;
          const element = await find(s.app.pid, name, MAX_WAIT_MS);
          let hr = 0;
          try {
            const ms = await timed(s, `right-click row ${k}`, [menuOpen(oid)], async () => void (hr = showContextMenu(element)), "contextmenu");
            expect(hr).toBe(0);
            // Spec FR-010: a right-click selects the row as a click does.
            expect(await s.c.evaluate<string | null>(selectedRow)).toBe(oid);
            opened.push(oid);
            await closeAll(s);
            return ms;
          } finally {
            element.release();
          }
        };
        const coldMs = await byKey(0);
        const warmUp = await byMouse(1);
        const mouse: number[] = [];
        for (let k = 2; k < 2 + OPENS; k++) mouse.push(await byMouse(k));
        const keys: number[] = [];
        for (let k = 2 + OPENS; k < 2 + 2 * OPENS; k++) keys.push(await byKey(k));
        const counted = [...mouse, ...keys];
        expect(new Set(opened).size).toBe(opened.length);
        console.log(`OBSERVATION ${TASK}: SC-010a right-click ${js(mouse.map(r1))} ms, Shift+F10 ${js(keys.map(r1))} ms, warm-up ${r1(warmUp)} ms, cold ${r1(coldMs)} ms`);
        console.log(`OBSERVATION ${TASK}: SC-010a p95 ${r1(p95(counted))} ms (budget ${OPEN_P95_MS}), every-open max ${r1(Math.max(warmUp, ...counted))} ms (budget ${OPEN_MAX_MS}); right-click p95 ${r1(p95(mouse))} ms, Shift+F10 p95 ${r1(p95(keys))} ms`);
        expect({ opens: counted.length, p95: p95(counted) <= OPEN_P95_MS, every: Math.max(warmUp, ...counted) <= OPEN_MAX_MS, ...cold("SC-010a", coldMs, COLD_FACTOR * OPEN_P95_MS) }).toEqual({ opens: 2 * OPENS, p95: true, every: true, name: "SC-010a", cold: true });
      } finally {
        await end(s);
      }
    },
    caseTimeout(30 + 12 * (2 * OPENS + 2), OPEN_WAIT_MS + 30 * 60_000),
  );

  // ---- SC-010b: item activation to the popover with its plan or refusal on M ----

  // The SC-010b series on `repo` (a copy of M). It gives the verdicts; a WSL case records them only.
  async function sc010b(label: string, repo: Repo): Promise<unknown[]> {
    const target = rev(repo, "HEAD~1");
    const s = await session(label, repo);
    const tag = repo.wsl ? "SC-010b WSL" : "SC-010b";
    try {
      // Pick and Revert of an ancestor on M give a refusal; Reset, Check out, and Create tag give the popover with its plan.
      const actions = [
        { name: "Reset", item: ITEM.reset, done: reviewed(RESET_TITLE(target), RESET_BUTTON) },
        { name: "Check out", item: ITEM.checkout, done: reviewed(CHECKOUT_TITLE(target), CHECKOUT_BUTTON) },
        // The Tag popover shows no plan, so its end is the shown popover with the focused name field (CommitActions.tsx `TagPopover`).
        { name: "Create tag", item: ITEM.tag, done: `!!(${popover(TAG_TITLE(target))}) && document.activeElement === (${popover(TAG_TITLE(target))}).querySelector('input')` },
        { name: "Cherry-pick", item: ITEM.pick, done: reviewed(PICK_TITLE(true, target), PICK_BUTTON(true)) },
        { name: "Revert", item: ITEM.revert, done: reviewed(PICK_TITLE(false, target), PICK_BUTTON(false)) },
      ];
      const sample = async (a: (typeof actions)[number], label: string) => {
        await toItem(s, target, a.item);
        const before = usage(s.app.pid);
        const ms = await timed(s, label, [a.done], () => press(s.c, "Enter"));
        const after = usage(s.app.pid);
        const reply = await s.ipc.body<{ state?: string; code?: string; result?: { reason?: string } }>(s.ipc.finished("review_workbench").at(-1)!).catch(() => null);
        console.log(`REVIEW ${TASK}: ${label}: ${js({ state: reply?.state, code: reply?.code, reason: reply?.result?.reason })}`);
        await closeAll(s);
        return { ms, before, after };
      };
      const results: unknown[] = [];
      const first = await sample(actions[0]!, "cold Reset");
      results.push(cold(`${tag} Reset`, first.ms, COLD_FACTOR * POPOVER_MEDIAN_MS));
      for (const a of actions) {
        const series = newSeries(`${tag} ${a.name}`);
        await metrics(s.c, `${series.name} start`);
        for (let run = 0; run <= RUNS; run++) {
          const r = await sample(a, `${a.name} run ${run}`);
          await recordRun(s.c, series, run, r.ms, r.before, r.after);
        }
        await metrics(s.c, `${series.name} end`);
        results.push(verdict(series, POPOVER_MEDIAN_MS, POPOVER_MAX_MS));
      }
      return results;
    } finally {
      await end(s);
    }
  }

  test.skipIf(reason !== null)(
    "SC-010b, U3: on M (5,000 commits, 10,000 files) each item activation shows its popover with the plan or the refusal with a median of at most 300 ms and each run at most 500 ms; the cold run at most 600 ms",
    async () => {
      const cached = ensurePerfFixture(GIT!, PERF_M);
      checkShape(cached, PERF_M);
      const results = await sc010b("sc010b", winRepo(copyPerfFixture(GIT!, cached, "t018-m-b")));
      expect(results).toEqual([{ name: "SC-010b Reset", cold: true }, ...["Reset", "Check out", "Create tag", "Cherry-pick", "Revert"].map((a) => ({ name: `SC-010b ${a}`, median: true, every: true }))]);
    },
    caseTimeout(30 + 12 * 6 * (RUNS + 1), OPEN_WAIT_MS + 60 * 60_000),
  );

  // ---- SC-010c: the Hard review with the in-the-way check on M-R ----

  test.skipIf(reason !== null)(
    "SC-010c: on M-R the Hard review of the target 100 commits back with 1,000 changed paths ends with a median of at most 1 s and each run at most 2 s; the cold run at most 2 s",
    async () => {
      const cached = ensureMr(GIT!);
      console.log(`OBSERVATION ${TASK}: fixture M-R ${cached.reused ? "reused" : "built"} ${js(cached.facts)}`);
      const repo = winRepo(copyMr(GIT!, cached, "t018-mr-c"));
      const f = cached.facts;
      expect(repo.git(["diff", "--no-renames", "--name-only", "-z", f.target, f.tip, "--"]).split("\0").filter((p) => p !== "").length).toBe(MR_CHANGED_PATHS);
      const s = await session("sc010c", repo);
      try {
        const title = RESET_TITLE(f.target);
        const sample = async (label: string) => {
          await toItem(s, f.target, ITEM.reset);
          await press(s.c, "Enter");
          // User decision 2026-11-04: Mixed is preselected, and its radio has the first focus (CommitActions.tsx `startReset`).
          await until<boolean>(s.c, "the Mixed plan", reviewed(title, RESET_BUTTON), (v) => v);
          await until<boolean>(s.c, "the focus on Mixed", `document.activeElement?.type === 'radio' && document.activeElement.checked`, (v) => v, 1_000);
          const before = usage(s.app.pid);
          // The next radio of the group is Hard. Down checks it, and the change starts the Hard review.
          const ms = await timed(s, label, [reviewed(title, HARD_BUTTON)], () => press(s.c, "ArrowDown"));
          const after = usage(s.app.pid);
          const reply = await s.ipc.body<{ state?: string; code?: string; result?: { plan?: { mode?: string; trackedChanges?: number; ignoredReplaced?: number } } }>(s.ipc.finished("review_workbench").at(-1)!);
          console.log(`REVIEW ${TASK}: ${label}: ${js({ state: reply.state, code: reply.code, plan: reply.result?.plan })}`);
          expect({ state: reply.state, mode: reply.result?.plan?.mode }).toEqual({ state: "succeeded", mode: "hard" });
          await closeAll(s);
          return { ms, before, after };
        };
        const first = await sample("cold Hard review");
        const results: unknown[] = [cold("SC-010c", first.ms, COLD_FACTOR * HARD_REVIEW_MEDIAN_MS)];
        const series = newSeries("SC-010c Hard review");
        await metrics(s.c, `${series.name} start`);
        for (let run = 0; run <= RUNS; run++) {
          const r = await sample(`Hard review run ${run}`);
          await recordRun(s.c, series, run, r.ms, r.before, r.after);
        }
        await metrics(s.c, `${series.name} end`);
        results.push(verdict(series, HARD_REVIEW_MEDIAN_MS, HARD_REVIEW_MAX_MS));
        expect(results).toEqual([{ name: "SC-010c", cold: true }, { name: "SC-010c Hard review", median: true, every: true }]);
      } finally {
        await end(s);
      }
    },
    caseTimeout(30 + 14 * (RUNS + 2), OPEN_WAIT_MS + 30 * 60_000),
  );

  // ---- SC-010d and SC-011: run button to outcome text ----

  type Run = { name: keyof typeof RUN_MEDIAN_MS; label: string; setup(run: number): Promise<{ done: string; check(): void }>; trigger(): Promise<void>; restore(): Promise<void> };
  // One run: the setup up to the focused run button, then the timed Enter with the SC-011 probe, then the Git oracle and the restore.
  async function runSeries(s: Session, r: Run, results: unknown[], coldFirst: boolean): Promise<void> {
    const sc = s.repo.wsl ? "WSL " : "";
    const series = newSeries(`SC-010d ${sc}${r.label}`);
    const sc011: Inputs[] = [];
    await metrics(s.c, `${series.name} start`);
    for (let run = coldFirst ? -1 : 0; run <= RUNS; run++) {
      const tag = run < 0 ? "cold" : `run ${run}`;
      await clearFilter(s.c);
      const { done, check } = await r.setup(run);
      const before = usage(s.app.pid);
      const ms = await timed(s, `${sc}${r.label} ${tag}`, [outcomeShown(done, true)], r.trigger, "keydown", probe(s.c));
      const after = usage(s.app.pid);
      sc011.push(await inputs(s.c, `${sc}${r.label} ${tag}`));
      check();
      await idle(s);
      await r.restore();
      if (run < 0) {
        console.log(`RUN ${TASK}: ${series.name} cold: ${r1(ms)} ms, CPU ${(after.cpu - before.cpu).toFixed(3)} s, private bytes ${after.privateBytes}`);
        console.log(`PROCESSES ${TASK}: ${series.name} cold: ${processLine(after)}`);
        await heap(s.c, `${series.name} cold`);
        results.push(cold(series.name, ms, COLD_FACTOR * RUN_MEDIAN_MS[r.name]));
      } else await recordRun(s.c, series, run, ms, before, after);
    }
    await metrics(s.c, `${series.name} end`);
    results.push(verdict(series, RUN_MEDIAN_MS[r.name], RUN_MAX_FACTOR * RUN_MEDIAN_MS[r.name]));
    results.push({ name: `SC-011 ${sc}${r.label}`, inputs: sc011.every((x) => x.count >= MIN_INPUTS), p95: sc011.every((x) => x.p95 <= INPUT_P95_MS), max: sc011.every((x) => x.max <= INPUT_MAX_MS) });
  }
  const expectedRuns = (runs: Run[], coldLabel: string) => [
    ...runs.flatMap((r) => [
      ...(r.label === coldLabel ? [{ name: `SC-010d ${r.label}`, cold: true }] : []),
      { name: `SC-010d ${r.label}`, median: true, every: true },
      { name: `SC-011 ${r.label}`, inputs: true, p95: true, max: true },
    ]),
  ];
  // Focuses the enabled button `text` in `scope` and waits until it has the focus.
  async function focusButton(s: Session, scope: string, text: string): Promise<void> {
    const button = buttonIn(scope, text);
    await until<boolean>(s.c, `the available ${text} button`, `!!(${button}) && !(${button}).disabled && (${button}).getAttribute('aria-disabled') !== 'true'`, (v) => v);
    await focusOn(s.c, button, `the ${text} button`);
  }

  // The SC-010d series on `repo` (a copy of M). It gives the verdicts; a WSL case records them only.
  async function sc010dM(label: string, repo: Repo): Promise<{ runs: Run[]; results: unknown[] }> {
    const git = repo.git;
    const tip = rev(repo, "HEAD");
    const target = rev(repo, "HEAD~1");
    const indexPath = git(["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim();
    const saved = `${indexPath}.t018`;
    repo.copy(indexPath, saved);
    const indexHash = () => repo.digest(["ls-files", "-s", "-z"]);
    const indexBefore = indexHash();
    const s = await session(label, repo);
    // The reset moves main only. The restore moves it back and writes the saved index; the refresh then gives fresh stat data.
    const restoreReset = async () => {
      git(["update-ref", "refs/heads/main", tip]);
      repo.copy(saved, indexPath);
      git(["update-index", "-q", "--refresh"], [0, 1]);
      expect({ tip: rev(repo, "HEAD"), index: indexHash() }).toEqual({ tip, index: indexBefore });
      await refreshed(s, tip);
    };
    const reset = (mode: "soft" | "mixed"): Run => ({
      name: mode,
      label: mode === "soft" ? "Soft" : "Mixed",
      async setup() {
        await toItem(s, target, ITEM.reset);
        await press(s.c, "Enter");
        await until<boolean>(s.c, "the Mixed plan", reviewed(RESET_TITLE(target), RESET_BUTTON), (v) => v);
        if (mode === "soft") {
          await press(s.c, "ArrowUp");
          await until<boolean>(s.c, "the Soft plan", `(${popover(RESET_TITLE(target))})?.querySelector('input[type=radio]')?.checked === true && ${reviewed(RESET_TITLE(target), RESET_BUTTON)}`, (v) => v);
        }
        await focusButton(s, popover(RESET_TITLE(target)), RESET_BUTTON);
        return {
          done: RESET_DONE(target),
          check: () => {
            expect(rev(repo, "refs/heads/main")).toBe(target);
            // Git-reset(1): Soft keeps the index; Mixed sets it to the target tree.
            if (mode === "soft") expect(indexHash()).toBe(indexBefore);
            else expect(git(["diff-index", "--cached", "--name-only", "-z", "HEAD", "--"])).toBe("");
          },
        };
      },
      trigger: () => press(s.c, "Enter"),
      restore: restoreReset,
    });
    let name = "";
    const createTag: Run = {
      name: "tag",
      label: "Create tag",
      async setup(run) {
        name = `t018-${run < 0 ? "cold" : run}`;
        await toItem(s, target, ITEM.tag);
        await press(s.c, "Enter");
        const field = `(${popover(TAG_TITLE(target))})?.querySelector('input')`;
        await until<boolean>(s.c, "the tag name field", `document.activeElement === ${field}`, (v) => v);
        await s.c.send("Input.insertText", { text: name });
        await until<string | null>(s.c, "the typed tag name", `${field}?.value ?? null`, (v) => v === name);
        await focusButton(s, popover(TAG_TITLE(target)), TAG_BUTTON);
        return { done: TAG_DONE(name, target), check: () => expect(rev(repo, `refs/tags/${name}`)).toBe(target) };
      },
      trigger: () => press(s.c, "Enter"),
      async restore() {
        git(["update-ref", "-d", `refs/tags/${name}`]);
        await refreshed(s, tip, `!document.querySelector('[data-history-list] [data-chip-name]') || ![...document.querySelectorAll('[data-history-list] [data-chip-name]')].some((e) => e.textContent === ${js(name)})`);
      },
    };
    const runs = [reset("soft"), reset("mixed"), createTag];
    try {
      const results: unknown[] = [];
      for (const [i, r] of runs.entries()) await runSeries(s, r, results, i === 0);
      return { runs, results };
    } finally {
      await end(s);
    }
  }

  test.skipIf(reason !== null)(
    "SC-010d, SC-011 on M: Soft, Mixed, and Create tag end within their medians (1 s, 2 s, 1 s) and each run within 2 times; typing in the history filter keeps p95 100 ms and max 500 ms with at least 20 inputs per run",
    async () => {
      const { runs, results } = await sc010dM("sc010d-m", winRepo(copyPerfFixture(GIT!, ensurePerfFixture(GIT!, PERF_M), "t018-m-d")));
      expect(results).toEqual(expectedRuns(runs, "Soft"));
    },
    caseTimeout(40 + 25 * 3 * (RUNS + 2), OPEN_WAIT_MS + 90 * 60_000),
  );

  // The SC-010d series on `repo` (a copy of M-R with the facts `f`). It gives the verdicts; a WSL case records them only.
  async function sc010dMr(label: string, repo: Repo, f: MrFacts): Promise<{ runs: Run[]; results: unknown[] }> {
    const git = repo.git;
    const s = await session(label, repo);
    const cherryHead = () => git(["rev-parse", "--path-format=absolute", "--git-path", "CHERRY_PICK_HEAD"]).trim();
    const clean = () => git(["diff-index", "--name-only", "-z", "HEAD", "--"]) === "" && git(["ls-files", "-u", "-z"]) === "";
    const resetToTip = async () => {
      git(["reset", "-q", "--hard", f.tip]);
      expect({ head: rev(repo, "HEAD"), clean: clean() }).toEqual({ head: f.tip, clean: true });
      await refreshed(s, f.tip);
    };
    // A cherry-pick of `conflict` stops with one conflicted path (commit-menu-fixture.ts). The state, not the exit code, proves the stop.
    const stopped = () => {
      git(["cherry-pick", f.conflict], [0, 1]);
      expect({ head: rev(repo, "HEAD"), stopped: repo.exists(cherryHead()), unmerged: git(["ls-files", "-u", "-z", "--", f.conflictPath]) !== "" }).toEqual({ head: f.tip, stopped: true, unmerged: true });
    };
    const resolved = "resolved\n";
    const reset: Run = {
      name: "hard",
      label: "Hard",
      async setup() {
        await toItem(s, f.target, ITEM.reset);
        await press(s.c, "Enter");
        await until<boolean>(s.c, "the Mixed plan", reviewed(RESET_TITLE(f.target), RESET_BUTTON), (v) => v);
        await press(s.c, "ArrowDown");
        await until<boolean>(s.c, "the Hard plan", reviewed(RESET_TITLE(f.target), HARD_BUTTON), (v) => v);
        await focusButton(s, popover(RESET_TITLE(f.target)), HARD_BUTTON);
        await press(s.c, "Enter");
        const dialog = dialogWith(`Reset main hard to ${short(f.target)}?`);
        await until<boolean>(s.c, "the Hard dialog", `!!(${dialog})`, (v) => v);
        await focusButton(s, dialog, HARD_CONFIRM);
        return { done: RESET_DONE(f.target), check: () => expect({ head: rev(repo, "HEAD"), clean: clean() }).toEqual({ head: f.target, clean: true }) };
      },
      trigger: () => press(s.c, "Enter"),
      restore: resetToTip,
    };
    const pick = (isPick: boolean): Run => {
      const commit = isPick ? f.pick : f.tip;
      return {
        name: isPick ? "pick" : "revert",
        label: isPick ? "Cherry-pick" : "Revert",
        async setup() {
          await toItem(s, commit, isPick ? ITEM.pick : ITEM.revert);
          await press(s.c, "Enter");
          await until<boolean>(s.c, "the pick plan", reviewed(PICK_TITLE(isPick, commit), PICK_BUTTON(isPick)), (v) => v);
          await focusButton(s, popover(PICK_TITLE(isPick, commit)), PICK_BUTTON(isPick));
          return {
            done: PICK_DONE(isPick, commit),
            check: () => {
              // Git's own trees are the oracle: the pick of a child of the tip gives its tree, and the revert of the tip gives the tree of its parent.
              expect({ parent: rev(repo, "HEAD~1"), tree: tree(repo, "HEAD"), files: git(["diff", "--no-renames", "--name-only", "-z", f.tip, "HEAD", "--"]).split("\0").filter((p) => p !== "").length }).toEqual({
                parent: f.tip,
                tree: tree(repo, isPick ? f.pick : `${f.tip}~1`),
                files: MR_FILES_PER_COMMIT,
              });
            },
          };
        },
        trigger: () => press(s.c, "Enter"),
        restore: resetToTip,
      };
    };
    const abort: Run = {
      name: "abort",
      label: "Abort",
      async setup() {
        stopped();
        await refreshed(s, f.tip, `!!(${bandButton(ABORT_ITEM)})`);
        await focusOn(s.c, bandButton(ABORT_ITEM), ABORT_ITEM);
        await press(s.c, "Enter");
        const dialog = dialogWith(ABORT_BUTTON);
        await until<boolean>(s.c, "the Abort dialog", `!!(${dialog})`, (v) => v);
        await focusButton(s, dialog, ABORT_BUTTON);
        return { done: ABORT_DONE, check: () => expect({ head: rev(repo, "HEAD"), stopped: repo.exists(cherryHead()), clean: clean() }).toEqual({ head: f.tip, stopped: false, clean: true }) };
      },
      trigger: () => press(s.c, "Enter"),
      restore: () => refreshed(s, f.tip, `document.querySelectorAll('[data-slot="conflict-row"]').length === 0`),
    };
    const continued: Run = {
      name: "continue",
      label: "Continue",
      async setup() {
        stopped();
        repo.write(f.conflictPath, resolved);
        git(["add", "--", f.conflictPath]);
        await refreshed(s, f.tip, `!!(${bandButton(CONTINUE_BUTTON)})`);
        await focusOn(s.c, bandButton(CONTINUE_BUTTON), CONTINUE_BUTTON);
        return {
          done: CONTINUE_DONE,
          check: () => {
            // The fixture sets `* -text`, so the blob holds the resolved bytes.
            const expected = git(["hash-object", "--stdin"], [0], Buffer.from(resolved)).trim();
            expect({ parent: rev(repo, "HEAD~1"), stopped: repo.exists(cherryHead()), blob: git(["rev-parse", "--verify", `HEAD:${f.conflictPath}`]).trim() }).toEqual({ parent: f.tip, stopped: false, blob: expected });
          },
        };
      },
      trigger: () => press(s.c, "Enter"),
      restore: resetToTip,
    };
    const checkout: Run = {
      name: "checkout",
      label: "Detached checkout",
      async setup() {
        await toItem(s, f.target, ITEM.checkout);
        await press(s.c, "Enter");
        await until<boolean>(s.c, "the checkout plan", reviewed(CHECKOUT_TITLE(f.target), CHECKOUT_BUTTON), (v) => v);
        await focusButton(s, popover(CHECKOUT_TITLE(f.target)), CHECKOUT_BUTTON);
        // Git-symbolic-ref(1) `-q`: no output for a detached HEAD.
        return { done: CHECKOUT_DONE(f.target), check: () => expect({ head: rev(repo, "HEAD"), symbolic: git(["symbolic-ref", "-q", "HEAD"], [0, 1]), clean: clean() }).toEqual({ head: f.target, symbolic: "", clean: true }) };
      },
      trigger: () => press(s.c, "Enter"),
      async restore() {
        git(["switch", "-q", "main"]);
        expect({ symbolic: git(["symbolic-ref", "-q", "HEAD"]).trim(), head: rev(repo, "HEAD"), clean: clean() }).toEqual({ symbolic: "refs/heads/main", head: f.tip, clean: true });
        await refreshed(s, f.tip);
      },
    };
    const runs = [reset, pick(true), pick(false), abort, continued, checkout];
    try {
      const results: unknown[] = [];
      for (const [i, r] of runs.entries()) await runSeries(s, r, results, i === 0);
      return { runs, results };
    } finally {
      await end(s);
    }
  }

  test.skipIf(reason !== null)(
    "SC-010d, SC-011 on M-R: Hard (4 s), Cherry-pick and Revert of a 10-file commit (2 s), Abort and Continue (2 s), and the detached checkout (4 s) end within their medians and each run within 2 times; typing in the history filter keeps p95 100 ms and max 500 ms with at least 20 inputs per run",
    async () => {
      const cached = ensureMr(GIT!);
      const { runs, results } = await sc010dMr("sc010d-mr", winRepo(copyMr(GIT!, cached, "t018-mr-d")), cached.facts);
      expect(results).toEqual(expectedRuns(runs, "Hard"));
    },
    caseTimeout(40 + 25 * 6 * (RUNS + 2), OPEN_WAIT_MS + 180 * 60_000),
  );

  // ---- WSL records (spec SC-010 "WSL times"): the same series in the owned folder of Ubuntu-26.04, from the Windows package. No budget. ----

  const record = (name: string, results: unknown[]) => console.log(`RECORD ${TASK}: ${name}: ${js(results)}`);

  test.skipIf(wslReason !== null)(
    "WSL record SC-010b: on a distro copy of M, the SC-010b series (10 + 1 runs per action), no budget",
    async () => {
      const cached = ensurePerfFixture(GIT!, PERF_M);
      checkShape(cached, PERF_M);
      record("SC-010b WSL", await sc010b("wsl-sc010b", distroRepo(cached.repo, "m-b")));
    },
    caseTimeout(30 + 12 * 6 * (RUNS + 1), 2 * OPEN_WAIT_MS + 120 * 60_000),
  );

  test.skipIf(wslReason !== null)(
    "WSL record SC-010d, SC-011 on M: Soft, Mixed, and Create tag (10 + 1 runs each), no budget",
    async () => {
      const cached = ensurePerfFixture(GIT!, PERF_M);
      checkShape(cached, PERF_M);
      record("SC-010d WSL M", (await sc010dM("wsl-sc010d-m", distroRepo(cached.repo, "m-d"))).results);
    },
    caseTimeout(40 + 25 * 3 * (RUNS + 2), 2 * OPEN_WAIT_MS + 180 * 60_000),
  );

  test.skipIf(wslReason !== null)(
    "WSL record SC-010d, SC-011 on M-R: Hard, Cherry-pick, Revert, Abort, Continue, and the detached checkout (10 + 1 runs each), no budget",
    async () => {
      const cached = ensureMr(GIT!);
      record("SC-010d WSL M-R", (await sc010dMr("wsl-sc010d-mr", distroRepo(cached.repo, "mr-d"), cached.facts)).results);
    },
    caseTimeout(40 + 25 * 6 * (RUNS + 2), 2 * OPEN_WAIT_MS + 360 * 60_000),
  );
});
