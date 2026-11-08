// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T144 (feature 004 WP32, plan D20): the Submodules group tree and its branch marks in the installed package. `Local: package`. Quickstart Q30.
// Spec FR-107 to FR-111, SC-018, SC-019. T145 runs this file on a fresh package and records the result in research.md R31.
// The cases drive the page through the WebView2 CDP endpoint and UI Automation patterns. They send no OS input and never move the pointer.
// Page timing uses the page clock: from the `timeStamp` of the input event to the first animation frame whose page holds the result.
// With ARBARETO_TREE_SHOTS_DIR set, the Q30 case writes the PNG files of the board states Main, BranchMarks, Dark, and Collapsed there.
// T145 records without a budget (`RECORD` lines): the Job CPU and peak committed memory of the app tree, the long tasks of each timed span, and the app cold runs.
// T164 (WP42, plan D20 "Keys in the tree", spec FR-116): the panel forms, heights, keys, stored state, contrast, shots, and widths. A scout runs it in its own packaged session after T145.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { SUBMODULE_TREE_FOLDERS } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import { REPO } from "../groups";
import { fixtureDir, FIXTURE_ROOT, ownedGit, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { connectPage, freePort, MOD, watchIpc, type Cdp, type IpcLog } from "./cdp";
import { decodePng, formatMeasurement, measure, THRESHOLD } from "./contrast";
import type { JobAccounting } from "../git/win32";
import { appEnv, descendants, findInstalledApp, powershellJson, PROBE_TIMEOUT_MS, processRecords, startInstalledApp, WAIT_MS, waitExit, type OwnedProcess } from "./installed-app";
import { BOARD_TOP, BOARD_TREE, boardWorld, folderCount, folderWorld, ICONS, markParts, marksShown, otherRepo, replyMarks, sameMarks, twinWorlds, VIRTUAL_MIN, wideWorld } from "./submodule-tree-fixture";
import { close, closeWindow, ControlType, expand, find, findWindow, invoke, MAX_CALL_MS, MAX_WAIT_MS, setValue, type Element } from "./uia";
import { metrics, type Density } from "../../src/frontend/layout/profiles";
import { keyHintsForm, type KeyHintsForm } from "../../src/frontend/submodules/TreeKeyHints";

for (const helper of ["./cdp.ts", "./uia.ts", "./installed-app.ts", "./contrast.ts", "./submodule-tree-fixture.ts", "../../src/contracts/limits.ts", "../../src/frontend/layout/profiles.ts", "../../src/frontend/submodules/TreeKeyHints.tsx"]) printOrigin(helper, import.meta.dir);

const TASK = "T144";
console.log(`OS ${TASK}: os=${release()}`);
const STEP_MS = MAX_WAIT_MS + MAX_CALL_MS;
const caseTimeout = (steps: number, extraMs = 0) => steps * STEP_MS + 2 * PROBE_TIMEOUT_MS + 2 * WAIT_MS + extraMs;
// A key response, a view change, or a service round trip after a key stays far below it.
const KEY_WAIT_MS = 10_000;
// Research R31 "List time": the SC-020 budget for 256 rows is 55 s, and build ba095f87 took 107.8 s. The budget for 1,024 rows is 190 s.
const LIST_WAIT_MS = 600_000;

// ---- Budgets and sample counts (spec SC-018, SC-019; 001 SC-005). Fixed before the first measured run (constitution VII). ----

// Spec SC-018: warm, median of 10 counted runs after one warm-up run, with 20 and 256 checked-out submodules.
const RUNS = 10;
const SIZES = [20, 256] as const;
// Spec SC-020, amended 2026-11-04 (T161): the twins of 1,024 rows have a list budget and no SC-018 budget.
const LIST_SIZES = [...SIZES, 1_024] as const;
// Spec SC-018: (median time to the last branch mark) - (median time to the last row of the detached twin), per submodule row. The value can be negative. The T144 control sets it to -Infinity, in a run without the LIST_MS control.
const MARK_MS_PER_ROW = 30;
// Spec SC-020: the median time from the Enter keydown to the last branch mark, for each twin. The T150 and T161 controls set each value to 1.
const LIST_MS: Record<(typeof LIST_SIZES)[number], number> = { 20: 6_500, 256: 55_000, 1_024: 190_000 };
// Spec SC-019 and 001 SC-005: 95% of inputs within 100 ms, every input within 500 ms. The T144 and T161 controls set INPUT_P95_MS to 1.
const INPUT_P95_MS = 100;
const INPUT_MAX_MS = 500;
// One uncounted warm-up cycle, then the counted cycles. Each cycle sends the 10 keys of `CYCLE`, so the p95 counts 200 inputs.
const INPUT_WARMUP_CYCLES = 1;
const INPUT_CYCLES = 20;
// T145, the feature 010 rule (commit-menu-perf.test.ts): app cold is the first timed run after a new app start. The OS file cache stays warm. A record without a budget.
const COLD_SIZES: readonly number[] = SIZES;

// ---- App texts (the source of each value is named) ----

// `OPEN_FOLDER` in src/frontend/app/RepositorySwitcher.tsx.
const OPEN_FOLDER = "Open folder… (Ctrl+O)";
// src/frontend/submodules/SubmodulesGroup.tsx, plan D15 "Tree rows".
const TREE_BOUND = `The submodule paths have more than ${SUBMODULE_TREE_FOLDERS.toLocaleString("en-US")} folders, so the group shows no folder rows.`;
const NO_BRANCH = "no branch";
// Contract Δ12 "Branch marks" of the twin rows, without `rowId`. git-clone(1) sets `origin/main` as the upstream of `main`. The fixture check gives 0 ahead, 0 behind.
const TWIN_MARK: Record<string, object> = {
  main: { state: "branch", ref: "refs/heads/main", upstream: "refs/remotes/origin/main", track: { state: "counts", ahead: 0, behind: 0 } },
  [NO_BRANCH]: { state: "detached" },
};

// ---- CDP keys ----

// DOM `key` and `code`, and the winuser.h virtual-key code. `cdp.ts` has no End, O, R, or Space key.
const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", vk: 0x0d, text: "\r" },
  Home: { key: "Home", code: "Home", vk: 0x24 },
  End: { key: "End", code: "End", vk: 0x23 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 0x25 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 0x26 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 0x27 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 0x28 },
  o: { key: "o", code: "KeyO", vk: 0x4f, text: "o" },
  r: { key: "r", code: "KeyR", vk: 0x52, text: "r" },
  Space: { key: " ", code: "Space", vk: 0x20, text: " " },
  Escape: { key: "Escape", code: "Escape", vk: 0x1b },
};
const CTRL = { key: "Control", code: "ControlLeft", vk: 0x11 };
async function press(c: Cdp, name: string, modifiers = 0): Promise<void> {
  const k = KEYS[name];
  if (k === undefined) throw new Error(`no key ${JSON.stringify(name)}`);
  const ctrl = (modifiers & MOD.Ctrl) !== 0;
  const typed = k.text !== undefined && modifiers === 0;
  if (ctrl) await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: CTRL.key, code: CTRL.code, windowsVirtualKeyCode: CTRL.vk, modifiers });
  await c.send("Input.dispatchKeyEvent", { type: typed ? "keyDown" : "rawKeyDown", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers, ...(typed ? { text: k.text, unmodifiedText: k.text } : {}) });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers });
  if (ctrl) await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: CTRL.key, code: CTRL.code, windowsVirtualKeyCode: CTRL.vk, modifiers: 0 });
}

const js = (value: unknown) => JSON.stringify(value);
async function until<T>(c: Cdp, what: string, expression: string, done: (value: T) => boolean, ms = KEY_WAIT_MS): Promise<T> {
  const value = await c.poll<T>(expression, done, ms);
  if (!done(value)) throw new Error(`${what} did not happen within ${ms} ms: ${js(value)}`);
  return value;
}

const median = (xs: number[]) => {
  const s = xs.toSorted((a, b) => a - b);
  return s.length % 2 === 1 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
// 001 plan.md "Responsiveness metrics": the nearest-rank p95.
const p95 = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.max(0, Math.ceil(0.95 * xs.length) - 1)]!;
const rounded = (xs: number[]) => xs.map((x) => Math.round(x * 10) / 10);

// ---- T145 records without a budget: UI stalls and the Job accounting of the app tree ----

// The Long Tasks API reports each main thread task above 50 ms. One observer per page.
const LONG_TASKS = `(window.__t145Long === undefined && (window.__t145Long = [], window.__t145LongObserver = new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__t145Long.push({ start: e.startTime, duration: e.duration }); }), window.__t145LongObserver.observe({ type: 'longtask' })), window.__t145Long.length = 0, true)`;
type Stalls = { count: number; max: number; sum: number };
// The long tasks that overlap the span from `start` to `end` of the page clock.
async function stalls(c: Cdp, start: number, end: number): Promise<Stalls> {
  const all = await c.evaluate<{ start: number; duration: number }[]>(`(window.__t145Long.push(...window.__t145LongObserver.takeRecords().map((e) => ({ start: e.startTime, duration: e.duration }))), window.__t145Long)`);
  const d = all.filter((l) => l.start + l.duration >= start && l.start <= end).map((l) => l.duration);
  return { count: d.length, max: d.length === 0 ? 0 : Math.max(...d), sum: d.reduce((a, b) => a + b, 0) };
}
const stallText = (x: Stalls) => `long tasks ${x.count}, max ${x.max.toFixed(1)} ms, sum ${x.sum.toFixed(1)} ms`;
const cpuText = (before: JobAccounting, after: JobAccounting) => `CPU user ${(after.userMs - before.userMs).toFixed(1)} ms, kernel ${(after.kernelMs - before.kernelMs).toFixed(1)} ms, new processes ${after.processes - before.processes}`;

// ---- Page facts of the Submodules group ----

const GROUP = `document.querySelector('[data-slot=submodules-group]')`;
// T147, plan D20 "Group": above 200 shown rows, only the mounted rows are in the DOM.
const ITEMS = `[...(${GROUP}?.querySelectorAll('[role=tree] [role=treeitem]') ?? [])]`;
// The facts of one row that hold for a virtual tree: the full path (`data-path` of a submodule row, the description of a folder row), the label, and the ARIA tree state.
type RowFacts = { path: string | null; label: string | null; level: number; pos: number; size: number; expanded: string | null };
const factsOf = (element: string) =>
  `((e) => e ? { path: e.dataset.path ?? e.getAttribute('aria-description'), label: e.querySelector('[data-slot=row-label]')?.textContent ?? null, level: Number(e.getAttribute('aria-level')), pos: Number(e.getAttribute('aria-posinset')), size: Number(e.getAttribute('aria-setsize')), expanded: e.getAttribute('aria-expanded') } : null)(${element})`;
// [kind, label, level, folder count] of each shown row, as BOARD_TREE.
const SHAPE = `${ITEMS}.map((e) => [e.dataset.path === undefined ? 'folder' : 'submodule', e.querySelector('[data-slot=row-label]')?.textContent ?? '', Number(e.getAttribute('aria-level')), e.dataset.path === undefined ? Number((e.querySelector('[data-slot=folder-count]')?.textContent ?? '').replaceAll(',', '')) : null])`;
const NAMES = `Object.fromEntries(${ITEMS}.filter((e) => e.dataset.path !== undefined).map((e) => [e.dataset.path, e.getAttribute('aria-label')]))`;
const BOUND_LINE = `${GROUP}?.querySelector('[data-slot=tree-bound]')?.textContent ?? null`;
const rowNamed = (label: string) => `${ITEMS}.find((e) => e.getAttribute('aria-label') === ${js(label)})`;
const rowAt = (path: string) => `${ITEMS}.find((e) => e.dataset.path === ${js(path)})`;
// Plan D15 "Tree rows": "<full path>, <branch or no branch>, <count part>, <state>, <observed line>", without empty parts.
const nameMatches = (name: string | undefined, parts: string[]) => name !== undefined && (name === parts.join(", ") || name.startsWith(`${parts.join(", ")}, `));

describe.skipIf(process.platform !== "win32")("T144 packaged Submodules tree and branch marks", () => {
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

  const shotsDir = process.env.ARBARETO_TREE_SHOTS_DIR || null;
  if (shotsDir !== null && (!isAbsolute(shotsDir) || !relative(REPO, shotsDir).startsWith(".."))) throw new Error(`ARBARETO_TREE_SHOTS_DIR must be an absolute folder outside the repository: ${js(shotsDir)}`);
  if (shotsDir === null) console.log(`SKIP ${TASK} screenshots: ARBARETO_TREE_SHOTS_DIR is not set`);

  const git = (repo: string, args: string[]) => ownedGit(GIT!, FIXTURE_ROOT, repo, args).toString("utf8");
  const top = (repo: string) => git(repo, ["rev-parse", "--show-toplevel"]).trim();
  // `RepositorySwitcher.tsx`: the trigger label is the folder name and the Git worktree root.
  const switcher = `document.querySelector('button[aria-keyshortcuts="Control+R"]')?.getAttribute('aria-label') ?? null`;
  const switcherLabel = (repo: string) => `${basename(top(repo))}, ${top(repo)}`;

  async function use<T>(element: Promise<Element>, body: (element: Element) => T): Promise<T> {
    const found = await element;
    try {
      return body(found);
    } finally {
      found.release();
    }
  }
  const uia = <T>(pid: number, name: string, type: number | undefined, body: (element: Element) => T) => use(find(pid, name, MAX_WAIT_MS, type), body);

  type Session = { app: OwnedProcess; c: Cdp; ipc: IpcLog; label: string };
  // One app on the profile of `label` below the fixture root (ARBARETO_PROFILE_ROOT, `appEnv`), with the CDP endpoint on a free port.
  function launch(label: string): { app: OwnedProcess; port: number } {
    const env = appEnv(fixtureDir(`${label}-app`), false);
    const port = freePort();
    env.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port}`;
    const app = startInstalledApp(installed!, env);
    owned.add(app);
    console.log(`STARTED ${TASK}: ${app.pid} ${label} port=${port} profile=${env.set.ARBARETO_PROFILE_ROOT}`);
    return { app, port };
  }
  async function ready(label: string, app: OwnedProcess, port: number, repo: string, what: string): Promise<Session> {
    const c = await connectPage(port, MAX_WAIT_MS);
    sockets.add(c);
    await until<string | null>(c, what, switcher, (v) => v === switcherLabel(repo), LIST_WAIT_MS);
    // A hidden page runs no animation frame, so page timing needs the visible window.
    expect(await c.evaluate<string>("document.visibilityState")).toBe("visible");
    // T145: the WebView2 processes below the app root (PID and creation time) and the Job membership of each msedgewebview2.exe process.
    const records = processRecords();
    const webview = (r: { name: string }) => r.name.toLowerCase() === "msedgewebview2.exe";
    const all = records.filter(webview);
    console.log(`RECORD ${TASK}: ${label} WebView2 below the app [pid, in Job] ${js(descendants(app.pid, records).filter(webview).map((r) => [r.pid, app.holds(r.pid)]))}; msedgewebview2.exe in the Job ${all.filter((r) => app.holds(r.pid)).length} of ${all.length}`);
    return { app, c, ipc: await watchIpc(c), label };
  }
  async function session(label: string, repo: string): Promise<Session> {
    const { app, port } = launch(label);
    // A new profile holds no Git selection, so the boot view offers Select Git (uia.test.ts T241).
    await uia(app.pid, "Select Git", ControlType.Button, invoke);
    await uia(app.pid, "Use this Git", undefined, invoke);
    await uia(app.pid, OPEN_FOLDER, undefined, invoke);
    await pickFolder(app.pid, repo);
    return ready(label, app, port, repo, "the open repository");
  }
  // T145 app cold: a new app on the profile of `label`. The profile keeps the Git selection and the recent entries. The app restores the last chosen repository `repo` (001 contract §3 `restoreWorkspace`).
  async function restart(label: string, repo: string): Promise<Session> {
    const { app, port } = launch(label);
    return ready(label, app, port, repo, "the restored repository");
  }
  // The Windows folder picker: the Edit has the Name of its label, and its dialog window has the Name of the OK button.
  async function pickFolder(pid: number, repo: string): Promise<void> {
    if (!isAbsolute(repo) || relative(FIXTURE_ROOT, repo).startsWith("..")) throw new Error(`the repository is outside the fixture root: ${js(repo)}`);
    await uia(pid, "Folder:", ControlType.Edit, (field) => setValue(field, repo));
    await uia(pid, "Select Folder", ControlType.Button, invoke);
  }
  async function end(s: Session): Promise<void> {
    s.c.close();
    sockets.delete(s.c);
    if (owned.has(s.app)) {
      // T145: the totals of the app tree for the session. The peaks are committed bytes, not the working set.
      const a = s.app.accounting();
      console.log(`RECORD ${TASK}: ${s.label} session end: CPU user ${a.userMs.toFixed(1)} ms, kernel ${a.kernelMs.toFixed(1)} ms, processes ${a.processes}, peak Job committed bytes ${a.peakJobBytes}, peak process committed bytes ${a.peakProcessBytes}`);
    }
    s.app.stop();
    owned.delete(s.app);
    expect(await waitExit(s.app)).not.toBeNull();
  }
  // The keyboard handler takes Ctrl+O and Ctrl+R only outside an editable element (src/frontend/keyboard/shortcuts.ts).
  const blur = (c: Cdp) => c.evaluate(`(document.activeElement?.blur?.(), true)`);
  // Ctrl+O, then the folder picker. The open registers the repository as a recent entry.
  async function openFolder(s: Session, repo: string): Promise<void> {
    await blur(s.c);
    await press(s.c, "o", MOD.Ctrl);
    await pickFolder(s.app.pid, repo);
    await until<string | null>(s.c, `the open ${repo}`, switcher, (v) => v === switcherLabel(repo), LIST_WAIT_MS);
  }
  const RECENT_FILTER = `document.querySelector('[role=combobox][aria-label="Filter recent repositories"]')`;
  const activeOption = `document.getElementById(${RECENT_FILTER}?.getAttribute('aria-activedescendant') ?? '')?.getAttribute('aria-label') ?? null`;
  // Ctrl+R, then the arrow keys to the recent entry of `repo`. Enter opens it.
  async function toRecent(s: Session, repo: string): Promise<string> {
    const label = switcherLabel(repo);
    await blur(s.c);
    await press(s.c, "r", MOD.Ctrl);
    await until<boolean>(s.c, "the recent repositories filter", `document.activeElement === ${RECENT_FILTER}`, (v) => v);
    await until<boolean>(s.c, `the recent entry ${label}`, `[...document.querySelectorAll('[role=listbox][aria-label="Recent repositories"] [role=option]')].some((e) => e.getAttribute('aria-label') === ${js(label)})`, (v) => v);
    for (let i = 0; i < 8 && (await s.c.evaluate<string | null>(activeOption)) !== label; i++) await press(s.c, "ArrowDown");
    expect(await s.c.evaluate<string | null>(activeOption)).toBe(label);
    return label;
  }
  async function switchTo(s: Session, repo: string): Promise<void> {
    const label = await toRecent(s, repo);
    await press(s.c, "Enter");
    await until<string | null>(s.c, `the open ${repo}`, switcher, (v) => v === label, LIST_WAIT_MS);
  }
  // No list review and no submodule marks read has a pending IPC call, so a run starts with no read of the last repository in flight.
  async function idle(s: Session): Promise<void> {
    for (const stop = performance.now() + LIST_WAIT_MS; s.ipc.pending("review_submodules").length + s.ipc.pending("read_submodule_work").length > 0; await Bun.sleep(50)) {
      if (performance.now() >= stop) throw new Error(`a submodule read still runs after ${LIST_WAIT_MS} ms`);
    }
  }
  // Opens `repo` from the recent entries by Enter. The time runs from the Enter `keydown` to the first animation frame in which `check` holds.
  // `record` holds the T145 records: the Job CPU from before the Enter key to the result in the test, and the long tasks of the timed span.
  async function timedSwitch(s: Session, repo: string, check: string): Promise<{ ms: number; record: string }> {
    await toRecent(s, repo);
    expect(await s.c.evaluate<boolean>(check)).toBe(false);
    await s.c.evaluate(LONG_TASKS);
    await s.c.evaluate(`(() => {
      window.__t144 = null;
      addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const start = e.timeStamp;
        const step = () => {
          const now = performance.now();
          if (${check}) return void (window.__t144 = { ok: true, ms: now - start, start, end: now });
          if (now - start > ${LIST_WAIT_MS}) return void (window.__t144 = { ok: false, ms: now - start, start, end: now });
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }, { capture: true, once: true });
      return true;
    })()`);
    const before = s.app.accounting();
    await press(s.c, "Enter");
    const r = (await until<{ ok: boolean; ms: number; start: number; end: number } | null>(s.c, "the timed open", "window.__t144", (v) => v !== null, LIST_WAIT_MS + 10_000))!;
    const after = s.app.accounting();
    if (!r.ok) throw new Error(`the check did not hold within ${LIST_WAIT_MS} ms of the Enter keydown: ${check}`);
    return { ms: r.ms, record: `${cpuText(before, after)}; ${stallText(await stalls(s.c, r.start, r.end))}` };
  }
  // Each mounted row name of `paths` holds the mark parts that Git gives for its folder (spec SC-018, plan D15 "Tree rows").
  // Up to `VIRTUAL_MIN` of `shown` rows, every row is mounted, so every row of `paths` must have a name.
  async function expectMarks(s: Session, repo: string, paths: readonly string[], shown: number): Promise<Record<string, string>> {
    const names = await s.c.evaluate<Record<string, string>>(NAMES);
    const mounted = paths.filter((p) => names[p] !== undefined);
    const wrong = mounted.map((p) => ({ path: p, name: names[p], parts: markParts(GIT!, join(repo, ...p.split("/"))) })).filter((r) => !nameMatches(r.name, [r.path, ...r.parts]));
    expect({ some: mounted.length > 0, all: shown > VIRTUAL_MIN || mounted.length === paths.length, wrong }).toEqual({ some: true, all: true, wrong: [] });
    return names;
  }
  async function shot(c: Cdp, state: string): Promise<void> {
    if (shotsDir === null) return;
    await c.evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))`);
    const png = (await c.send("Page.captureScreenshot", { format: "png" })) as { data: string };
    mkdirSync(shotsDir, { recursive: true });
    const file = join(shotsDir, `t144-${state}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    writeFileSync(file, Buffer.from(png.data, "base64"));
    console.log(`CAPTURE_PNG ${TASK}: ${state} ${file}`);
  }
  const scheme = (c: Cdp, value: "light" | "dark") => c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }, { name: "forced-colors", value: "none" }] });

  // ---- Fixtures (no app) ----

  test.skipIf(GIT === null)(
    "T144 and T161 fixtures: the board set, the SC-018 twins of 20 and 256 rows, the 1,024 and 1,025 folder sets, and the 1,024 rows at f<i>/s give the expected gitlinks, marks, and folder counts",
    () => {
      const gitlinkPaths = (repo: string) =>
        git(repo, ["ls-files", "-s", "-z"])
          .split("\0")
          .filter((r) => r.startsWith("160000 "))
          .map((r) => r.slice(r.indexOf("\t") + 1));
      const b = boardWorld(GIT!, fixtureDir("check-board"));
      expect(gitlinkPaths(b.repo).toSorted()).toEqual([...BOARD_TOP].sort());
      expect(gitlinkPaths(join(b.repo, "app-shared")).toSorted()).toEqual(["third_party/contrib/minizip", "third_party/zlib"]);
      const marks = Object.fromEntries(b.checkedOut.map((p) => [p, markParts(GIT!, join(b.repo, ...p.split("/")))]));
      console.log(`FIXTURE ${TASK}: board marks ${js(marks)}`);
      expect(marks).toEqual({
        "libs/net/http": ["main", "0 ahead, 0 behind"],
        "libs/core": [NO_BRANCH],
        "libs/ui": ["main", "1 ahead, 0 behind"],
        "vendor/tools/fmt": ["release/2.x", "0 ahead, 3 behind"],
        "vendor/tools/lint": ["lint", "upstream gone"],
        "app-shared": ["main", "2 ahead, 1 behind"],
        "docs-theme": ["draft", "No upstream"],
        "app-shared/third_party/zlib": ["main", "0 ahead, 0 behind"],
        "app-shared/third_party/contrib/minizip": ["refs/tags/v1", "No upstream"],
      });
      for (const n of SIZES) {
        const t = twinWorlds(GIT!, fixtureDir(`check-twins-${n}`), n);
        expect({ n, branch: gitlinkPaths(t.branch).length, detached: gitlinkPaths(t.detached).length, folders: folderCount(t.paths) }).toEqual({ n, branch: n, detached: n, folders: 17 });
        const branch = new Set(t.paths.map((p) => js(markParts(GIT!, join(t.branch, ...p.split("/"))))));
        const detached = new Set(t.paths.map((p) => js(markParts(GIT!, join(t.detached, ...p.split("/"))))));
        const heads = new Set(t.paths.flatMap((p) => [join(t.branch, ...p.split("/")), join(t.detached, ...p.split("/"))].map((d) => git(d, ["rev-parse", "HEAD"]).trim())));
        console.log(`FIXTURE ${TASK}: twins ${n} branch marks ${js([...branch])}, detached marks ${js([...detached])}, HEAD commits ${heads.size}`);
        expect({ n, branch: [...branch], detached: [...detached], heads: heads.size }).toEqual({ n, branch: [js(["main", "0 ahead, 0 behind"])], detached: [js([NO_BRANCH])], heads: 1 });
      }
      for (const folders of [1_024, 1_025] as const) {
        const f = folderWorld(GIT!, fixtureDir(`check-folders-${folders}`), folders);
        const paths = gitlinkPaths(f.repo);
        // No folder of a gitlink exists, so Git cloned nothing.
        const cloned = paths.filter((p) => existsSync(join(f.repo, p.split("/")[0]!)));
        expect({ folders, gitlinks: paths.length, count: folderCount(paths), cloned }).toEqual({ folders, gitlinks: 256, count: folders, cloned: [] });
      }
      const w = wideWorld(GIT!, fixtureDir("check-wide"));
      const wide = gitlinkPaths(w.repo);
      const wideCloned = wide.filter((p) => existsSync(join(w.repo, p.split("/")[0]!)));
      expect({ gitlinks: wide.length, first: wide[0], last: wide.at(-1), count: folderCount(wide), cloned: wideCloned }).toEqual({ gitlinks: 1_024, first: "f0000/s", last: "f1023/s", count: 1_024, cloned: [] });
    },
    20 * 60_000,
  );

  // ---- Q30: the board set, the marks, the closed state across a switch, and the bound line ----

  test.skipIf(reason !== null)(
    "Q30, FR-107 to FR-111: the board set shows folders first with the counts of all rows below, each mark equals the Git status headers in the DOM and through UIA, a closed folder stays closed after a switch, and 1,025 folders give the bound line",
    async () => {
      const b = boardWorld(GIT!, fixtureDir("q30-board"));
      const bound = folderWorld(GIT!, fixtureDir("q30-bound"), 1_025);
      const other = otherRepo(GIT!, fixtureDir("q30-other"));
      const s = await session("q30", other);
      try {
        await openFolder(s, b.repo);
        await until<number>(s.c, "the board rows", `${ITEMS}.length`, (v) => v === BOARD_TREE.length, LIST_WAIT_MS);
        expect(await s.c.evaluate<unknown>(SHAPE)).toEqual(BOARD_TREE);
        const names = await expectMarks(s, b.repo, b.checkedOut, BOARD_TREE.length);
        console.log(`NAMES ${TASK}: ${js(names)}`);
        // ICONS has no clone, so its row has no mark (data-model §15).
        expect(await s.c.evaluate<boolean>(`${rowAt(ICONS)}?.querySelector('[data-slot=branch-mark]') === null`)).toBe(true);
        // Chromium gives each treeitem its aria-label as the UIA Name.
        for (const name of Object.values(names)) await uia(s.app.pid, name, ControlType.TreeItem, () => {});
        await scheme(s.c, "light");
        await shot(s.c, "main");
        await shot(s.c, "branchmarks");
        await scheme(s.c, "dark");
        await shot(s.c, "dark");
        await scheme(s.c, "light");
        // Spec FR-108: ArrowLeft closes an open row. The state lasts per repository for the window session.
        for (const row of [rowNamed("libs, folder, 3"), rowAt("app-shared")]) {
          await s.c.evaluate(`(${row}).focus(); true`);
          await until<boolean>(s.c, "the row focus", `document.activeElement === (${row})`, (v) => v);
          await press(s.c, "ArrowLeft");
          await until<string | null>(s.c, "the closed row", `(${row})?.getAttribute('aria-expanded') ?? null`, (v) => v === "false");
        }
        const collapsed = BOARD_TREE.filter(([, label, level]) => !(["net", "http", "core", "ui", "third_party", "contrib", "minizip", "zlib"].includes(label) && level > 1));
        expect(await s.c.evaluate<unknown>(SHAPE)).toEqual(collapsed);
        await switchTo(s, other);
        await switchTo(s, b.repo);
        await until<number>(s.c, "the board rows after the switch", `${ITEMS}.length`, (v) => v === collapsed.length, LIST_WAIT_MS);
        expect(await s.c.evaluate<unknown>(SHAPE)).toEqual(collapsed);
        // The switcher keeps the focus after Enter, and its tooltip covers the group. The board Collapsed has no tooltip.
        await blur(s.c);
        await until<boolean>(s.c, "the closed tooltip", `document.querySelector('[data-slot=tooltip-content]') === null`, (v) => v);
        await shot(s.c, "collapsed");
        await s.c.send("Emulation.setEmulatedMedia", { features: [] });
        // Spec FR-111: above 1,024 folders, no folder row shows, and the bound line shows. The 256 rows are one flat level.
        await openFolder(s, bound.repo);
        const firstBound = factsOf(`${ITEMS}[0]`);
        await until<RowFacts | null>(s.c, "the bound rows", firstBound, (v) => v?.path === bound.paths[0], LIST_WAIT_MS);
        expect({
          line: await s.c.evaluate<string | null>(BOUND_LINE),
          folders: await s.c.evaluate<number>(`${ITEMS}.filter((e) => e.dataset.path === undefined).length`),
          first: await s.c.evaluate<RowFacts | null>(firstBound),
        }).toEqual({ line: TREE_BOUND, folders: 0, first: { path: bound.paths[0]!, label: bound.paths[0]!, level: 1, pos: 1, size: 256, expanded: null } });
      } finally {
        await end(s);
      }
    },
    caseTimeout(80, 4 * LIST_WAIT_MS),
  );

  // ---- SC-018: the A/B time to the last mark ----

  for (const n of LIST_SIZES) {
    const sc018 = (SIZES as readonly number[]).includes(n);
    test.skipIf(reason !== null)(
      `${sc018 ? `SC-018: with ${n} checked-out submodules, the time to the last branch mark minus the time to the last row of the detached twin is at most ${MARK_MS_PER_ROW} ms per row, and ` : ""}SC-020: with ${n.toLocaleString("en-US")} checked-out submodules, each twin shows its last mark within ${LIST_MS[n]} ms (medians of ${RUNS} after one warm-up run)`,
      async () => {
        const t = twinWorlds(GIT!, fixtureDir(`sc018-${n}`), n);
        const other = otherRepo(GIT!, fixtureDir(`sc018-${n}-other`));
        let s = await session(`sc018-${n}`, other);
        try {
          // Each open registers a recent entry. Each fixture opens once before the runs, and its marks equal the Git status headers.
          for (const [repo, text] of [[t.branch, "main"], [t.detached, NO_BRANCH]] as const) {
            await openFolder(s, repo);
            await until<boolean>(s.c, `the marks of ${repo}`, marksShown(t.paths, text), (v) => v, LIST_WAIT_MS);
            await expectMarks(s, repo, t.paths, n + folderCount(t.paths));
            // Above `VIRTUAL_MIN` shown rows, the DOM holds only the mounted marks. The reply holds all of them.
            await idle(s);
            expect(await replyMarks(s.ipc)).toEqual(sameMarks(t.paths, TWIN_MARK[text]!));
            await switchTo(s, other);
            await idle(s);
          }
          const times = { branch: [] as number[], detached: [] as number[] };
          // Run 0 is the warm-up run. A and B alternate, so a drift of the host reaches both.
          for (let run = 0; run <= RUNS; run++) {
            for (const [key, repo, text] of [["branch", t.branch, "main"], ["detached", t.detached, NO_BRANCH]] as const) {
              const { ms, record } = await timedSwitch(s, repo, marksShown(t.paths, text));
              if (run > 0) times[key].push(ms);
              else console.log(`OBSERVATION ${TASK}: SC-018 ${n} ${key} warm-up run ${ms.toFixed(1)} ms`);
              console.log(`RECORD ${TASK}: SC-018 ${n} ${key} run ${run}: ${ms.toFixed(1)} ms; ${record}`);
              await switchTo(s, other);
              await idle(s);
            }
          }
          const a = median(times.branch);
          const b = median(times.detached);
          const perRow = (a - b) / n;
          console.log(`OBSERVATION ${TASK}: SC-018 ${n} rows: branch runs ${js(rounded(times.branch))} ms, median ${a.toFixed(1)} ms; detached runs ${js(rounded(times.detached))} ms, median ${b.toFixed(1)} ms; ${perRow.toFixed(2)} ms per row, budget ${MARK_MS_PER_ROW} ms`);
          console.log(`OBSERVATION ${TASK}: SC-020 ${n} rows: branch median ${a.toFixed(1)} ms, detached median ${b.toFixed(1)} ms, budget ${LIST_MS[n]} ms`);
          // T145 app cold: one run per twin, each the first timed run of a new app. The app ends with `other` open, so the next app restores it.
          if (COLD_SIZES.includes(n)) {
            for (const [key, repo, text] of [["branch", t.branch, "main"], ["detached", t.detached, NO_BRANCH]] as const) {
              await end(s);
              s = await restart(`sc018-${n}`, other);
              await idle(s);
              const { ms, record } = await timedSwitch(s, repo, marksShown(t.paths, text));
              console.log(`RECORD ${TASK}: SC-018 ${n} ${key} cold (app cold, OS file cache warm, no budget): ${ms.toFixed(1)} ms; ${record}`);
              await switchTo(s, other);
              await idle(s);
            }
          }
          expect({ n, perRow: !sc018 || perRow <= MARK_MS_PER_ROW, branch: a <= LIST_MS[n], detached: b <= LIST_MS[n] }).toEqual({ n, perRow: true, branch: true, detached: true });
        } finally {
          await end(s);
        }
      },
      caseTimeout(80, (2 * RUNS + 10) * 3 * LIST_WAIT_MS),
    );
  }

  // ---- SC-019: the key response with 1,024 open folders, and 256 or 1,024 submodule rows ----

  type KeyCase = { rows: number; build: () => { repo: string }; first: RowFacts; cycle: [string, RowFacts][] };
  // The focus that each key must give (plan D15 keyboard map). A step names the key and the focused row after it.
  const folder = (path: string, level: number, expanded: string, pos = 1, size = level === 1 ? 256 : 1): RowFacts => ({ path, label: path.split("/").at(-1)!, level, pos, size, expanded });
  const leaf = (path: string, level: number): RowFacts => ({ path, label: "s", level, pos: 1, size: 1, expanded: null });
  const fRow = (i: number, expanded: string) => folder(`f${String(i).padStart(4, "0")}`, 1, expanded, i + 1, 1_024);
  const KEY_CASES: KeyCase[] = [
    // T144: the tree starts with `t000`, `t000/a`, `t000/a/b`, `t000/a/b/c`, and the row `s`, and ends with `t255/a/b/c` and its row `s`.
    {
      rows: 256,
      build: () => folderWorld(GIT!, fixtureDir("sc019"), 1_024),
      first: folder("t000", 1, "true"),
      cycle: [
        ["Home", folder("t000", 1, "true")],
        ["ArrowDown", folder("t000/a", 2, "true")],
        ["ArrowDown", folder("t000/a/b", 3, "true")],
        ["ArrowRight", folder("t000/a/b/c", 4, "true")],
        ["ArrowLeft", folder("t000/a/b/c", 4, "false")],
        ["ArrowRight", folder("t000/a/b/c", 4, "true")],
        ["Enter", folder("t000/a/b/c", 4, "false")],
        ["Enter", folder("t000/a/b/c", 4, "true")],
        ["End", leaf("t255/a/b/c/s", 5)],
        ["ArrowUp", folder("t255/a/b/c", 4, "true")],
      ],
    },
    // T161: the tree holds `f0000`, `f0000/s`, `f0001`, `f0001/s`, and so on to `f1023/s`.
    {
      rows: 1_024,
      build: () => wideWorld(GIT!, fixtureDir("sc019-wide")),
      first: fRow(0, "true"),
      cycle: [
        ["Home", fRow(0, "true")],
        ["ArrowDown", leaf("f0000/s", 2)],
        ["ArrowDown", fRow(1, "true")],
        ["ArrowLeft", fRow(1, "false")],
        ["ArrowRight", fRow(1, "true")],
        ["ArrowRight", leaf("f0001/s", 2)],
        ["ArrowLeft", fRow(1, "true")],
        ["Enter", fRow(1, "false")],
        ["Enter", fRow(1, "true")],
        ["End", leaf("f1023/s", 2)],
        ["ArrowUp", fRow(1_023, "true")],
      ],
    },
  ];

  for (const k of KEY_CASES) {
    test.skipIf(reason !== null)(
      `SC-019: with ${k.rows.toLocaleString("en-US")} submodule rows and 1,024 open folder rows, ${INPUT_P95_MS} ms for 95% of the tree keys and ${INPUT_MAX_MS} ms for every key (${INPUT_CYCLES * k.cycle.length} inputs after ${INPUT_WARMUP_CYCLES} warm-up cycle)`,
      async () => {
        const f = k.build();
        const other = otherRepo(GIT!, fixtureDir(`sc019-${k.rows}-other`));
        const s = await session(`sc019-${k.rows}`, other);
        try {
          // The IPC log starts in `session`, so the review of the fixture runs after it.
          await openFolder(s, f.repo);
          // T147: the tree mounts only the rows in view. The first row and the root set size show that the top folders are listed.
          const head = factsOf(`${ITEMS}[0]`);
          await until<RowFacts | null>(s.c, "the tree rows", head, (v) => v?.path === k.first.path, LIST_WAIT_MS);
          expect({ line: await s.c.evaluate<string | null>(BOUND_LINE), first: await s.c.evaluate<RowFacts | null>(head) }).toEqual({ line: null, first: k.first });
          console.log(`OBSERVATION ${TASK}: SC-019 ${k.rows} rows: mounted rows ${await s.c.evaluate<number>(`${ITEMS}.length`)} of ${k.rows + 1_024}`);
          // T145 pass condition: the review ends without `OUTPUT_LIMIT`, as the response code or as the code of an `unread` mark (contract §9, Δ12 "Branch marks").
          await idle(s);
          const call = s.ipc.calls().findLast((c) => c.command === "review_submodules");
          if (call === undefined || call.end === null) throw new Error("no review_submodules reply arrived");
          const reply = await s.ipc.body<{ state: string; code?: string; result?: { rows: unknown[]; branches: { code?: string }[] } }>(call);
          const review = { state: reply.state, code: reply.code ?? null, rows: reply.result?.rows.length ?? null, unreadLimit: (reply.result?.branches ?? []).filter((b) => b.code === "OUTPUT_LIMIT").length };
          console.log(`RECORD ${TASK}: SC-019 ${k.rows} rows review reply ${js(review)}`);
          expect(review).toEqual({ state: "succeeded", code: null, rows: k.rows, unreadLimit: 0 });
          await s.c.evaluate(LONG_TASKS);
          // `__t144Arm(check, limit)`: the time from the next keydown `timeStamp` to the first animation frame in which `check` holds.
          // A check that holds at the arm, or no such frame within `limit`, gives `ok: false`.
          await s.c.evaluate(`(() => {
            window.__t144Keys = [];
            window.__t144Press = null;
            addEventListener('keydown', (e) => window.__t144Keys.push(e.timeStamp), { capture: true });
            window.__t144Arm = (check, limit) => {
              window.__t144Press = null;
              if (check()) return void (window.__t144Press = { ok: false, why: 'the focus held before the press' });
              addEventListener('keydown', (e) => {
                const start = e.timeStamp;
                const step = () => {
                  const now = performance.now();
                  if (check()) return void (window.__t144Press = { ok: true, ms: now - start });
                  if (now - start > limit) return void (window.__t144Press = { ok: false, why: 'no frame held the focus within ' + limit + ' ms' });
                  requestAnimationFrame(step);
                };
                requestAnimationFrame(step);
              }, { capture: true, once: true });
            };
            return true;
          })()`);
          // The focused treeitem of the group tree, or null.
          const FOCUS = factsOf(`(${GROUP}?.querySelector('[role=tree]')?.contains(document.activeElement) && document.activeElement?.getAttribute('role') === 'treeitem' ? document.activeElement : null)`);
          const first = `${GROUP}.querySelector('[role=treeitem][tabindex="0"]')`;
          await s.c.evaluate(`(${first}).focus(); true`);
          await until<boolean>(s.c, "the tree focus", `document.activeElement === (${first})`, (v) => v);
          // The untimed last two steps of the cycle give its end state, so the first Home moves the focus as in every later cycle.
          for (const [key, want] of k.cycle.slice(-2)) {
            await press(s.c, key);
            await until<RowFacts | null>(s.c, `the start state ${key}`, FOCUS, (v) => js(v) === js(want));
          }
          const durations: number[] = [];
          for (let cycle = 0; cycle < INPUT_WARMUP_CYCLES + INPUT_CYCLES; cycle++) {
            await s.c.evaluate(`(window.__t144Keys = [], ${LONG_TASKS})`);
            const before = s.app.accounting();
            const cycleDurations: number[] = [];
            for (const [key, want] of k.cycle) {
              await s.c.evaluate(`(window.__t144Arm(() => JSON.stringify(${FOCUS}) === ${js(js(want))}, ${KEY_WAIT_MS}), true)`);
              await press(s.c, key);
              const r = (await until<{ ok: boolean; ms?: number; why?: string } | null>(s.c, `cycle ${cycle} ${key}`, "window.__t144Press", (v) => v !== null, KEY_WAIT_MS + 5_000))!;
              // A press without its frame has no time, so the case fails. No default value stands in.
              if (!r.ok || r.ms === undefined) throw new Error(`cycle ${cycle} ${key}: ${r.why ?? "no time"}`);
              cycleDurations.push(r.ms);
            }
            const after = s.app.accounting();
            const { keys, now } = await s.c.evaluate<{ keys: number[]; now: number }>("({ keys: window.__t144Keys, now: performance.now() })");
            expect({ cycle, keys: keys.length }).toEqual({ cycle, keys: k.cycle.length });
            console.log(`RECORD ${TASK}: SC-019 ${k.rows} rows cycle ${cycle}${cycle < INPUT_WARMUP_CYCLES ? " (warm-up)" : ""}: ${cpuText(before, after)}; ${stallText(await stalls(s.c, keys[0]!, now))}`);
            if (cycle >= INPUT_WARMUP_CYCLES) durations.push(...cycleDurations);
          }
          console.log(`OBSERVATION ${TASK}: SC-019 ${k.rows} rows: ${durations.length} inputs, p95 ${p95(durations)} ms, max ${Math.max(...durations)} ms, durations ${js(durations)}`);
          expect(durations.length).toBe(INPUT_CYCLES * k.cycle.length);
          expect({ p95: p95(durations) <= INPUT_P95_MS, max: Math.max(...durations) <= INPUT_MAX_MS }).toEqual({ p95: true, max: true });
        } finally {
          await end(s);
        }
      },
      caseTimeout(40 + (INPUT_WARMUP_CYCLES + INPUT_CYCLES) * k.cycle.length, 4 * LIST_WAIT_MS),
    );
  }

  // ---- T164: the "Keys in the tree" panel (plan D20 "Keys in the tree", spec FR-116) ----

  // T164 controls, each applied alone; its case must fail:
  // - Case 1: set the third `T164_TEXTS` entry (`HINT_MOVE`) to the board text "Move to the next row.".
  // - Case 2: set `want` of the first `OPEN_LAYOUTS` entry (1280x800 compact, 240 DIPs) to "hidden".
  // - Case 3: set `AFTER_SPACE` to "true".
  // - Case 4: set `CLOSED_DESK.compact` to 49.
  // - Case 5: set `AFTER_CLOSE_RESTART` to "open".
  // - Case 6: set `NO_ROOM_WANT` to "open".
  // - Case 7: set `FIRST_TAB_AFTER_TREE` to `SPLITTER`.
  // - Case 10: set `widthLimit` to `() => 100`.
  // The T164 cases need no control for (8), (9), and the profile switch record.

  const T164 = "T164";
  // The 13 D20 texts of `TreeKeyHints.tsx` in table order: HINTS_HEADING, then each HINT_*_KEYS text and its HINT_* text.
  const T164_TEXTS = [
    "Keys in the tree",
    "Up, Down",
    "Go to the previous or the next row.",
    "Right",
    "Open a closed row. On an open row, go to the first child.",
    "Left",
    "Close an open row. On another row, go to the parent.",
    "Home, End",
    "Go to the first or the last row.",
    "Enter",
    "Open the submodule. On a folder row, open or close the folder.",
    "Shift+F10, Menu key",
    "Open the row menu: Open submodule, Update, Copy path. A failed row adds Retry, and Show output when it has output. Folder rows have no menu.",
  ];
  const HINTS_NO_ROOM = "Make the sidebar wider or the window taller to show the keys.";
  // Plan D20 "Height": P_closed is 21 DIPs plus the button height (`CLOSED_EXTRA` in TreeKeyHints.tsx).
  const CLOSED_EXTRA = 21;
  // Plan D20 "Desk heights", P_closed at 240 DIPs and 100% text. Case 4 allows 0.5 px.
  const CLOSED_DESK: Record<Density, number> = { compact: 45, comfortable: 49 };
  const DESK_TOLERANCE = 0.5;
  const AFTER_SPACE = "false";
  const AFTER_CLOSE_RESTART: KeyHintsForm = "closed";
  const NO_ROOM_WANT: KeyHintsForm = "noRoom";
  // Workbench.tsx: the "Compact" and "Comfortable" items of the View menu. index.css: an absent `data-density` means Compact.
  const DENSITY_ITEM: Record<Density, string> = { compact: "Compact", comfortable: "Comfortable" };
  const DENSITY = `(document.documentElement.getAttribute('data-density') ?? 'compact')`;
  // src/frontend/state/preferences.ts `KEY`. D20 "Stored state": a missing `keyHintsOpen` reads as true.
  const PREFERENCES = `localStorage.getItem('arbareto.preferences.v1')`;
  const STORED_DEFAULT = true;
  // Workbench.tsx: the splitter label, the slot, and the `data-profile` root.
  const SPLITTER = `document.querySelector('[role=separator][aria-label="Resize references sidebar"]')`;
  const HINTS = `document.querySelector('[data-slot=key-hints]')`;
  const HINTS_BUTTON = `${HINTS}?.querySelector('[data-slot=key-hints-content] button')`;
  const TREE = `${GROUP}?.querySelector('[role=tree]')`;
  const TAB_ROW = `${GROUP}?.querySelector('[role=tree] [role=treeitem][tabindex="0"]')`;
  const FIRST_TAB_AFTER_TREE = HINTS_BUTTON;
  // The form that the DOM shows (plan D20 "Forms").
  const FORM = `((o, b) => !o || !b ? null : getComputedStyle(o).visibility === 'hidden' ? 'hidden' : b.getAttribute('aria-disabled') === 'true' ? 'noRoom' : b.getAttribute('aria-expanded') === 'true' ? 'open' : 'closed')(${HINTS}, ${HINTS_BUTTON})`;
  type Hints = {
    profile: string | null;
    density: Density;
    form: KeyHintsForm | null;
    H: number | null;
    open: number | null;
    button: number | null;
    outer: number | null;
    group: number | null;
    groupHolds: boolean;
    refs: number | null;
    expanded: string | null;
    disabled: string | null;
    tracks: number | null;
    sidebar: number | null;
    scroll: number;
    innerHeight: number;
    stored: string | null;
  };
  // Plan D20 "Height": H is the slot parent, P_open the content block. The inner column holds the references region and then the group wrapper.
  const HINT_FACTS = `(() => {
    const outer = ${HINTS};
    const content = outer?.querySelector('[data-slot=key-hints-content]') ?? null;
    const button = content?.querySelector('button') ?? null;
    const slot = document.querySelector('[data-slot=key-hints-slot]');
    const inner = slot?.previousElementSibling ?? null;
    const h = (e) => e ? e.getBoundingClientRect().height : null;
    const list = button ? document.getElementById(button.getAttribute('aria-controls')) : null;
    const columns = list ? getComputedStyle(list).gridTemplateColumns : null;
    return {
      profile: document.querySelector('[data-profile]')?.getAttribute('data-profile') ?? null,
      density: ${DENSITY},
      form: ${FORM},
      H: h(slot?.parentElement),
      open: h(content),
      button: h(button),
      outer: h(outer),
      group: h(inner?.lastElementChild),
      groupHolds: !!inner?.lastElementChild?.contains(${GROUP}),
      refs: h(inner?.firstElementChild),
      expanded: button?.getAttribute('aria-expanded') ?? null,
      disabled: button?.getAttribute('aria-disabled') ?? null,
      tracks: columns === null ? null : columns === 'none' ? 0 : columns.trim().split(/\\s+/).length,
      sidebar: Number(${SPLITTER}?.getAttribute('aria-valuenow') ?? NaN),
      scroll: document.scrollingElement.scrollHeight,
      innerHeight,
      stored: ${PREFERENCES},
    };
  })()`;
  const storedOpen = (f: Hints) => {
    const value = f.stored === null ? undefined : (JSON.parse(f.stored) as { keyHintsOpen?: unknown }).keyHintsOpen;
    return typeof value === "boolean" ? value : STORED_DEFAULT;
  };
  // The DOM form on 10 animation frames in a row.
  const TEN_FRAMES = `new Promise((done) => { const forms = []; const step = () => { forms.push(${FORM}); if (forms.length === 10) done(forms); else requestAnimationFrame(step); }; requestAnimationFrame(step); })`;
  // Two animation frames: React commits, then the next frame paints.
  const FRAMES = `new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))`;

  // Microsoft Learn "Make text bigger": HKCU\Software\Microsoft\Accessibility `TextScaleFactor` (DWORD, 100 to 225). An absent value is 100.
  const textScale = () =>
    powershellJson(`$v = (Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Accessibility' -Name TextScaleFactor -ErrorAction SilentlyContinue).TextScaleFactor
ConvertTo-Json -Compress -InputObject $(if ($null -eq $v) { 100 } else { [int]$v })`) as number;
  const scale = reason === null ? textScale() : null;
  if (scale !== null) console.log(`OBSERVATION ${T164}: Windows text size ${scale}%`);
  const skip100 = reason ?? (scale === 100 ? null : "missing capability text-scale-100");
  const skip225 = reason ?? (scale === 225 ? null : "missing capability text-scale-225");
  if (reason === null && skip100 !== null) console.log("SKIP T164: missing capability text-scale-100");
  if (reason === null && skip225 !== null) console.log("SKIP T164 (10) at 225%: missing capability text-scale-225");

  // Fixture (a) with n = 20 (T144 (a), `twinWorlds` branch twin), and a second copy for case 5.
  let t164World: { a: string; copy: string } | null = null;
  const t164Fixture = () => (t164World ??= { a: twinWorlds(GIT!, fixtureDir("t164-a"), 20).branch, copy: twinWorlds(GIT!, fixtureDir("t164-a-copy"), 20).branch });

  // Chromium commits localStorage up to 5 s after a write, and a Job end loses an uncommitted write. A restart case closes the window as a user does.
  async function quit(s: Session): Promise<void> {
    const title = await s.c.evaluate<string>("document.title");
    await use(findWindow(s.app.pid, title, MAX_WAIT_MS), closeWindow);
    expect(await waitExit(s.app)).not.toBeNull();
    await end(s);
  }
  async function hintsSession(label: string): Promise<Session> {
    const s = await session(`t164-${label}`, t164Fixture().a);
    await until<boolean>(s.c, "the Keys in the tree panel", `${HINTS} !== null`, (v) => v, LIST_WAIT_MS);
    return s;
  }
  async function clickAt(c: Cdp, expression: string): Promise<void> {
    const p = await c.evaluate<{ x: number; y: number }>(`(() => { const b = (${expression}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none", buttons: 0 });
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1 });
    await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", buttons: 0, clickCount: 1 });
  }
  async function setDensity(s: Session, want: Density): Promise<void> {
    if ((await s.c.evaluate<string>(DENSITY)) === want) return;
    await uia(s.app.pid, "View", ControlType.MenuItem, expand);
    const item = `[...document.querySelectorAll('[role="menuitemradio"]')].find((e) => e.textContent.trim() === ${js(DENSITY_ITEM[want])})`;
    await until<boolean>(s.c, `the ${DENSITY_ITEM[want]} item`, `!!(${item})`, (v) => v);
    await s.c.evaluate(`(${item}).focus(); true`);
    await press(s.c, "Enter");
    await until<string>(s.c, `the ${want} density`, DENSITY, (v) => v === want);
    // A Base UI radio item keeps the menu open (remote-delete-packaged.test.ts T019 density case).
    await press(s.c, "Escape");
    await until<boolean>(s.c, "the unmounted View menu", "document.querySelector('[role=menu]') === null", (v) => v);
  }
  // Splitter.tsx: Home gives the 180 DIP minimum. The 8 DIP and 32 DIP key steps reach no other D20 width from 180, so a pointer drag gives the rest.
  async function setSidebar(s: Session, width: number): Promise<void> {
    await s.c.evaluate(`(${SPLITTER}).focus(); true`);
    await press(s.c, "Home");
    await until<string | null>(s.c, "the 180 DIP sidebar", `${SPLITTER}?.getAttribute('aria-valuenow') ?? null`, (v) => v === "180");
    if (width !== 180) {
      const p = await s.c.evaluate<{ x: number; y: number }>(`(() => { const b = (${SPLITTER}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
      await s.c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none", buttons: 0 });
      await s.c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1 });
      await s.c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x + width - 180, y: p.y, button: "left", buttons: 1 });
      await s.c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x + width - 180, y: p.y, button: "left", buttons: 0, clickCount: 1 });
      await until<string | null>(s.c, `the ${width} DIP sidebar`, `${SPLITTER}?.getAttribute('aria-valuenow') ?? null`, (v) => v === String(width));
    }
    console.log(`RECORD ${T164}: sidebar ${width} DIPs, references section width ${await s.c.evaluate<number>(`document.querySelector('[data-section=references]').getBoundingClientRect().width`)} px`);
  }
  // The viewport in DIPs (CSS px), then the density, then the sidebar width. `width` null leaves the sidebar, as in the constrained profile.
  async function layout(s: Session, w: number, h: number, density: Density, width: number | null): Promise<void> {
    await s.c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 0, mobile: false });
    await until<number[]>(s.c, `the ${w}x${h} viewport`, "[innerWidth, innerHeight]", (v) => v[0] === w && v[1] === h);
    await setDensity(s, density);
    if (width !== null) await setSidebar(s, width);
  }
  // The form shows, stays for 10 frames, and equals `keyHintsForm` of the read values (case 6 rule, used in each case).
  async function expectForm(s: Session, want: KeyHintsForm, what: string): Promise<Hints> {
    const f = await until<Hints>(s.c, `the ${want} form (${what})`, HINT_FACTS, (v) => v.form === want);
    const frames = await s.c.evaluate<(string | null)[]>(TEN_FRAMES);
    const rule = f.H === null || f.open === null || f.button === null ? null : keyHintsForm(f.H, f.open, CLOSED_EXTRA + f.button, metrics(f.density, 1).reducedPaneMin, storedOpen(f));
    console.log(`RECORD ${T164}: ${what}: ${js({ ...f, stored: undefined, rule, frames })}`);
    expect({ what, frames, rule }).toEqual({ what, frames: Array(10).fill(want), rule: f.profile === "constrained" ? null : want });
    return f;
  }
  // CDP Accessibility domain: the computed node of one element.
  async function axNode(c: Cdp, expression: string): Promise<{ role: string | null; name: string | null; description: string | null; ignored: boolean } | null> {
    await c.send("Accessibility.enable");
    const handle = (await c.send("Runtime.evaluate", { expression, returnByValue: false })) as { result: { objectId?: string } };
    if (handle.result.objectId === undefined) return null;
    const { nodes } = (await c.send("Accessibility.getPartialAXTree", { objectId: handle.result.objectId, fetchRelatives: false })) as { nodes: { role?: { value?: string }; name?: { value?: string }; description?: { value?: string }; ignored?: boolean }[] };
    const n = nodes[0];
    return n === undefined ? null : { role: n.role?.value ?? null, name: n.name?.value ?? null, description: n.description?.value ?? null, ignored: n.ignored === true };
  }
  async function expectDescription(s: Session, what: string): Promise<void> {
    const node = await axNode(s.c, TREE);
    console.log(`RECORD ${T164}: tree description (${what}) ${js(node?.description ?? null)}`);
    expect({ what, description: node?.description ?? null }).toEqual({ what, description: T164_TEXTS.join(" ") });
  }
  const ACTIVE_FACTS = `((e) => e === null ? null : { tag: e.tagName.toLowerCase(), role: e.getAttribute('role'), label: e.getAttribute('aria-label'), text: (e.textContent ?? '').trim().slice(0, 80), body: e === document.body, slot: e.closest('[data-slot]')?.getAttribute('data-slot') ?? null, section: e.closest('[data-section]')?.getAttribute('data-section') ?? null })(document.activeElement)`;

  type Scheme = "light" | "dark" | "forced";
  async function emulate(c: Cdp, value: Scheme): Promise<void> {
    await c.send("Emulation.setEmulatedMedia", { features: value === "forced" ? [{ name: "forced-colors", value: "active" }] : [{ name: "prefers-color-scheme", value }, { name: "forced-colors", value: "none" }] });
    await c.evaluate(FRAMES);
  }
  // The commit-menu-packaged.test.ts method: one capture, then the `tests/windows/contrast.ts` measure of each element box.
  async function contrastOf(c: Cdp, scheme: Scheme, targets: [string, string][]): Promise<void> {
    const capture = (await c.send("Page.captureScreenshot", { format: "png" })) as { data: string };
    const png = Buffer.from(capture.data, "base64");
    const file = join(fixtureDir("t164-evidence"), `${scheme}-${crypto.randomUUID()}.png`);
    writeFileSync(file, png);
    console.log(`CAPTURE_PNG ${T164}: ${file}`);
    const image = decodePng(new Uint8Array(png));
    for (const [pair, expression] of targets) {
      const r = await c.evaluate<{ x: number; y: number; width: number; height: number; dpr: number } | null>(`(() => { const e = ${expression}; if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, dpr: devicePixelRatio }; })()`);
      if (r === null) throw new Error(`no element for ${pair}`);
      const x = Math.max(0, Math.round(r.x * r.dpr));
      const y = Math.max(0, Math.round(r.y * r.dpr));
      const box = { x, y, width: Math.min(image.width - x, Math.floor(r.width * r.dpr)), height: Math.min(image.height - y, Math.floor(r.height * r.dpr)) };
      const m = measure(image, { pair: `${scheme} ${pair}`, kind: "text", box });
      console.log(`CONTRAST ${T164}: ${formatMeasurement(m)}`);
      expect({ scheme, pair, pass: m.ratio >= THRESHOLD.text }).toEqual({ scheme, pair, pass: true });
    }
  }

  test.skipIf(skip100 !== null)(
    "T164 (1) and the profile switch record: the tree description is the 13 D20 texts in the open, closed, noRoom, and constrained forms; the focus after a switch to the constrained profile is recorded",
    async () => {
      const s = await hintsSession("1");
      try {
        const version = (await s.c.send("Browser.getVersion")) as { product?: string };
        console.log(`RECORD ${T164}: environment ${js({ os: release(), webview: version.product ?? null, git: git(t164Fixture().a, ["--version"]).trim(), devicePixelRatio: await s.c.evaluate<number>("devicePixelRatio"), textScale: scale })}`);
        await layout(s, 1280, 800, "compact", 240);
        await expectForm(s, "open", "case 1 open");
        await expectDescription(s, "open");
        await clickAt(s.c, HINTS_BUTTON);
        await expectForm(s, "closed", "case 1 closed");
        await expectDescription(s, "closed");
        await clickAt(s.c, HINTS_BUTTON);
        await expectForm(s, "open", "case 1 open again");
        await layout(s, 1280, 800, "comfortable", 180);
        await expectForm(s, "noRoom", "case 1 noRoom");
        await expectDescription(s, "noRoom");
        // The gap that T163 found: the constrained profile remounts the group in `SidebarAfter`, and the references section starts collapsed. A record, no assertion.
        await layout(s, 1280, 800, "compact", 240);
        await expectForm(s, "open", "profile switch start");
        await s.c.evaluate(`(${HINTS_BUTTON}).focus(); true`);
        await until<boolean>(s.c, "the panel button focus", `document.activeElement === (${HINTS_BUTTON})`, (v) => v);
        await s.c.send("Emulation.setDeviceMetricsOverride", { width: 960, height: 640, deviceScaleFactor: 0, mobile: false });
        await until<boolean>(s.c, "the constrained profile without the slot", `document.querySelector('[data-profile]')?.getAttribute('data-profile') === 'constrained' && document.querySelector('[data-slot=key-hints-slot]') === null`, (v) => v);
        await s.c.evaluate(FRAMES);
        console.log(`RECORD T164 focus after profile switch: ${js({ dom: await s.c.evaluate<unknown>(ACTIVE_FACTS), ax: await axNode(s.c, "document.activeElement") })}`);
        // Case 1 in the constrained profile: the group mounts only while the references section shows.
        // ReferencesSidebar.tsx: the toggle has `aria-expanded`, so UI Automation gives it no Invoke pattern (remote-delete-packaged.test.ts `showRemotes`).
        await s.c.evaluate(`document.querySelector('button[aria-label="Show references"][aria-expanded=false]').focus(); true`);
        await press(s.c, "Enter");
        await until<boolean>(s.c, "the constrained tree", `!!(${TREE})`, (v) => v, LIST_WAIT_MS);
        await expectForm(s, "hidden", "case 1 constrained 960x640 compact");
        await expectDescription(s, "constrained 960x640 compact");
      } finally {
        await end(s);
      }
    },
    caseTimeout(60, LIST_WAIT_MS),
  );

  // Plan D20 "Desk heights" at 100% text. `desk` is recorded beside P_open, not asserted. `min` is the reduced pane minimum.
  const OPEN_LAYOUTS: { w: number; h: number; density: Density; width: number; profile: string; desk: number | null; tracks: number; want: KeyHintsForm }[] = [
    { w: 1280, h: 800, density: "compact", width: 240, profile: "wide", desk: 441, tracks: 1, want: "open" },
    { w: 960, h: 800, density: "compact", width: 240, profile: "narrow", desk: null, tracks: 1, want: "open" },
    { w: 1280, h: 800, density: "comfortable", width: 240, profile: "wide", desk: 483, tracks: 1, want: "open" },
    { w: 1280, h: 800, density: "compact", width: 360, profile: "wide", desk: 305, tracks: 2, want: "open" },
    { w: 1280, h: 800, density: "comfortable", width: 360, profile: "wide", desk: 394, tracks: 2, want: "open" },
  ];
  test.skipIf(skip100 !== null)(
    "T164 (2): the open form fits in the wide and narrow profiles at 240 and 360 DIPs: the group and references regions keep their minima, the page does not scroll, and the key list has one or two columns",
    async () => {
      const s = await hintsSession("2");
      try {
        for (const l of OPEN_LAYOUTS) {
          const what = `case 2 ${l.w}x${l.h} ${l.density} ${l.width} DIPs`;
          await layout(s, l.w, l.h, l.density, l.width);
          const f = await expectForm(s, l.want, what);
          const min = metrics(l.density, 1).reducedPaneMin;
          console.log(`RECORD ${T164}: ${what}: P_open ${f.open} (desk ${l.desk ?? "none"}), H ${f.H}, group ${f.group}, references ${f.refs}`);
          expect({
            what,
            profile: f.profile,
            groupHolds: f.groupHolds,
            groupMin: f.group! >= min,
            groupMax: f.group! <= 0.4 * (f.H! - f.open!) + 1,
            refsMin: f.refs! >= 1.5 * min,
            scroll: f.scroll === f.innerHeight,
            tracks: f.tracks,
          }).toEqual({ what, profile: l.profile, groupHolds: true, groupMin: true, groupMax: true, refsMin: true, scroll: true, tracks: l.tracks });
        }
      } finally {
        await end(s);
      }
    },
    caseTimeout(80, LIST_WAIT_MS),
  );

  test.skipIf(skip100 !== null)(
    "T164 (3) and (4): a click, Enter, Space, and Enter toggle the panel, and the closed outer block is 21 DIPs plus the button, 45 DIPs compact and 49 comfortable at 240 DIPs",
    async () => {
      const s = await hintsSession("3");
      try {
        await layout(s, 1280, 800, "compact", 240);
        await expectForm(s, "open", "case 3 start");
        const matches = (f: Hints) => (f.expanded === "true" ? Math.abs(f.outer! - f.open!) : Math.abs(f.outer! - (CLOSED_EXTRA + f.button!))) <= DESK_TOLERANCE;
        const step = async (input: string, act: () => Promise<void>, expanded: string) => {
          await act();
          const f = await until<Hints>(s.c, `case 3 after ${input}`, HINT_FACTS, (v) => v.expanded === expanded);
          await s.c.evaluate(FRAMES);
          const settled = await s.c.evaluate<Hints>(HINT_FACTS);
          console.log(`RECORD ${T164}: case 3 after ${input}: expanded ${settled.expanded}, outer ${settled.outer}, P_open ${settled.open}, button ${settled.button}`);
          expect({ input, expanded: f.expanded, matches: matches(settled) }).toEqual({ input, expanded, matches: true });
        };
        const focusButton = async () => {
          await s.c.evaluate(`(${HINTS_BUTTON}).focus(); true`);
          await until<boolean>(s.c, "the panel button focus", `document.activeElement === (${HINTS_BUTTON})`, (v) => v);
        };
        await step("click", () => clickAt(s.c, HINTS_BUTTON), "false");
        await step("Enter", async () => (await focusButton(), await press(s.c, "Enter")), "true");
        await step("Space", async () => (await focusButton(), await press(s.c, "Space")), AFTER_SPACE);
        await step("Enter again", async () => (await focusButton(), await press(s.c, "Enter")), "true");
        // Case 4: the closed form at 240 DIPs in both densities.
        await clickAt(s.c, HINTS_BUTTON);
        for (const density of ["compact", "comfortable"] as const) {
          await layout(s, 1280, 800, density, 240);
          const f = await expectForm(s, "closed", `case 4 ${density}`);
          console.log(`RECORD ${T164}: case 4 ${density}: outer ${f.outer}, button ${f.button}, desk ${CLOSED_DESK[density]}, H ${f.H}, group ${f.group}`);
          expect({
            density,
            rule: Math.abs(f.outer! - (CLOSED_EXTRA + f.button!)) <= DESK_TOLERANCE,
            desk: Math.abs(f.outer! - CLOSED_DESK[density]) <= DESK_TOLERANCE,
            group: density === "comfortable" || f.group! <= 0.4 * (f.H! - CLOSED_DESK.compact) + 1,
          }).toEqual({ density, rule: true, desk: true, group: true });
        }
      } finally {
        await end(s);
      }
    },
    caseTimeout(60, LIST_WAIT_MS),
  );

  test.skipIf(skip100 !== null)(
    "T164 (5): the stored state survives an app restart on the same profile, and a second copy of fixture (a) shows it too",
    async () => {
      const { a, copy } = t164Fixture();
      let s = await hintsSession("5");
      try {
        await layout(s, 1280, 800, "compact", 240);
        await expectForm(s, "open", "case 5 new profile");
        await clickAt(s.c, HINTS_BUTTON);
        const closed = await expectForm(s, "closed", "case 5 after the close");
        expect(closed.stored?.includes(`"keyHintsOpen":false`)).toBe(true);
        await quit(s);
        s = await restart("t164-5", a);
        await until<boolean>(s.c, "the panel after the restart", `${HINTS} !== null`, (v) => v, LIST_WAIT_MS);
        await layout(s, 1280, 800, "compact", 240);
        await expectForm(s, AFTER_CLOSE_RESTART, "case 5 restart after the close");
        await openFolder(s, copy);
        await until<boolean>(s.c, "the panel of the copy", `${HINTS} !== null`, (v) => v, LIST_WAIT_MS);
        await expectForm(s, "closed", "case 5 copy after the close");
        await clickAt(s.c, HINTS_BUTTON);
        const open = await expectForm(s, "open", "case 5 after the open");
        expect(open.stored?.includes(`"keyHintsOpen":true`)).toBe(true);
        await quit(s);
        s = await restart("t164-5", copy);
        await until<boolean>(s.c, "the panel after the second restart", `${HINTS} !== null`, (v) => v, LIST_WAIT_MS);
        await layout(s, 1280, 800, "compact", 240);
        await expectForm(s, "open", "case 5 restart after the open");
        await openFolder(s, a);
        await until<boolean>(s.c, "the panel of fixture (a)", `${HINTS} !== null`, (v) => v, LIST_WAIT_MS);
        await expectForm(s, "open", "case 5 fixture (a) after the open");
      } finally {
        await end(s);
      }
    },
    caseTimeout(80, 4 * LIST_WAIT_MS),
  );

  test.skipIf(skip100 !== null)(
    "T164 (6): with the stored state open, 1280x800 comfortable at 180 DIPs gives the noRoom form; Enter and a click change nothing; 1280x1100 gives the open form without an input",
    async () => {
      const s = await hintsSession("6");
      try {
        await layout(s, 1280, 800, "comfortable", 180);
        const first = await expectForm(s, NO_ROOM_WANT, "case 6 noRoom");
        expect({ expanded: first.expanded, disabled: first.disabled }).toEqual({ expanded: "false", disabled: "true" });
        // A page listener counts the activations of the button. Enter on a native button also fires `click`, so each check runs after its input.
        await s.c.evaluate(`(window.__t164Inputs = 0, (${HINTS_BUTTON}).addEventListener('click', () => window.__t164Inputs++), true)`);
        await s.c.evaluate(`(${HINTS_BUTTON}).focus(); true`);
        await until<boolean>(s.c, "the panel button focus", `document.activeElement === (${HINTS_BUTTON})`, (v) => v);
        await press(s.c, "Enter");
        await until<number>(s.c, "the Enter on the button", "window.__t164Inputs", (v) => v >= 1);
        const afterEnter = await expectForm(s, "noRoom", "case 6 after Enter");
        await clickAt(s.c, HINTS_BUTTON);
        await until<number>(s.c, "the click on the button", "window.__t164Inputs", (v) => v >= 2);
        const afterClick = await expectForm(s, "noRoom", "case 6 after the click");
        for (const f of [afterEnter, afterClick]) expect(f.stored?.includes(`"keyHintsOpen":true`)).toBe(true);
        await layout(s, 1280, 1100, "comfortable", null);
        const tall = await expectForm(s, "open", "case 6 1280x1100 comfortable");
        console.log(`RECORD ${T164}: case 6 P_open ${first.open} at 1280x800, ${tall.open} at 1280x1100 (desk 623)`);
        expect({ sidebar: tall.sidebar, delta: Math.abs(tall.open! - first.open!) <= DESK_TOLERANCE }).toEqual({ sidebar: 180, delta: true });
        await layout(s, 1280, 800, "comfortable", null);
        await expectForm(s, "noRoom", "case 6 back at 1280x800");
      } finally {
        await end(s);
      }
    },
    caseTimeout(60, LIST_WAIT_MS),
  );

  test.skipIf(skip100 !== null)(
    "T164 (7): Tab goes from the tree row to the panel button and then to the splitter, Shift+Tab goes back to the row, and no Tab enters the key list",
    async () => {
      const s = await hintsSession("7");
      try {
        await layout(s, 1280, 800, "compact", 240);
        await expectForm(s, "open", "case 7");
        const at = (expression: string) => `document.activeElement === (${expression})`;
        const inList = `!!document.getElementById((${HINTS_BUTTON}).getAttribute('aria-controls'))?.contains(document.activeElement)`;
        await s.c.evaluate(`(${TAB_ROW}).focus(); true`);
        await until<boolean>(s.c, "the tree row focus", at(TAB_ROW), (v) => v);
        await s.c.key("Tab");
        const first = await until<boolean>(s.c, "the first Tab stop after the tree", at(FIRST_TAB_AFTER_TREE), (v) => v);
        const firstInList = await s.c.evaluate<boolean>(inList);
        const name = (await axNode(s.c, "document.activeElement"))?.name ?? null;
        await s.c.key("Tab");
        const second = await until<boolean>(s.c, "the splitter after the button", at(SPLITTER), (v) => v);
        const secondInList = await s.c.evaluate<boolean>(inList);
        await s.c.evaluate(`(${HINTS_BUTTON}).focus(); true`);
        await until<boolean>(s.c, "the panel button focus", at(HINTS_BUTTON), (v) => v);
        await s.c.key("Tab", MOD.Shift);
        const back = await until<boolean>(s.c, "the tree row after Shift+Tab", at(TAB_ROW), (v) => v);
        expect({ first, name, firstInList, second, secondInList, back }).toEqual({ first: true, name: T164_TEXTS[0], firstInList: false, second: true, secondInList: false, back: true });
      } finally {
        await end(s);
      }
    },
    caseTimeout(40, LIST_WAIT_MS),
  );

  test.skipIf(skip100 !== null)(
    "T164 (8) and (9): the panel texts, the button, and the unavailable button pass the contrast check in light, dark, and forced colors; the shots at 360 and 240 DIPs and of the noRoom tooltip",
    async () => {
      const s = await hintsSession("8");
      const list = `document.getElementById((${HINTS_BUTTON}).getAttribute('aria-controls'))`;
      try {
        await layout(s, 1280, 800, "compact", 240);
        await expectForm(s, "open", "case 8 open");
        await blur(s.c);
        for (const scheme of ["light", "dark", "forced"] as const) {
          await emulate(s.c, scheme);
          await contrastOf(s.c, scheme, [
            ["button text", HINTS_BUTTON],
            ["key name", `${list}.querySelector('kbd')`],
            ["key text", `${list}.querySelector('dd')`],
          ]);
        }
        await emulate(s.c, "light");
        await layout(s, 1280, 800, "comfortable", 180);
        await expectForm(s, "noRoom", "case 8 noRoom");
        await blur(s.c);
        for (const scheme of ["light", "dark", "forced"] as const) {
          await emulate(s.c, scheme);
          await contrastOf(s.c, scheme, [["unavailable button text", HINTS_BUTTON]]);
        }
        await s.c.send("Emulation.setEmulatedMedia", { features: [] });
        // Case 9: the shots for the compare with the Collapsed board.
        for (const width of [360, 240]) {
          await layout(s, 1280, 800, "compact", width);
          for (const form of ["open", "closed"] as const) {
            if ((await s.c.evaluate<string | null>(FORM)) !== form) await clickAt(s.c, HINTS_BUTTON);
            await expectForm(s, form, `case 9 ${width} DIPs ${form}`);
            await blur(s.c);
            for (const theme of ["light", "dark"] as const) {
              await scheme(s.c, theme);
              await shot(s.c, `t164-${width}-${form}-${theme}`);
            }
          }
          if ((await s.c.evaluate<string | null>(FORM)) !== "open") await clickAt(s.c, HINTS_BUTTON);
          await expectForm(s, "open", `case 9 ${width} DIPs reopened`);
        }
        await scheme(s.c, "light");
        await layout(s, 1280, 800, "comfortable", 180);
        await expectForm(s, "noRoom", "case 9 noRoom");
        const p = await s.c.evaluate<{ x: number; y: number }>(`(() => { const b = (${HINTS_BUTTON}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
        await s.c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none", buttons: 0 });
        await until<string | null>(s.c, "the noRoom tooltip", `document.querySelector('[data-slot=tooltip-content]')?.textContent ?? null`, (v) => v === HINTS_NO_ROOM);
        await shot(s.c, "t164-noroom-tooltip");
        await s.c.send("Emulation.setEmulatedMedia", { features: [] });
      } finally {
        await end(s);
      }
    },
    caseTimeout(80, LIST_WAIT_MS),
  );

  // Case 10: the content box is the content block rect without its borders and paddings.
  const widthLimit = (w: { clientWidth: number }) => w.clientWidth;
  const WIDTH_FACTS = `((content) => {
    const s = getComputedStyle(content);
    const r = content.getBoundingClientRect();
    const left = r.left + Number.parseFloat(s.borderLeftWidth) + Number.parseFloat(s.paddingLeft);
    const right = r.right - Number.parseFloat(s.borderRightWidth) - Number.parseFloat(s.paddingRight);
    const parts = [content.querySelector('button'), ...content.querySelectorAll('kbd')].map((e) => { const b = e.getBoundingClientRect(); return { text: e.textContent, left: b.left, right: b.right }; });
    return { scrollWidth: content.scrollWidth, clientWidth: content.clientWidth, left, right, outside: parts.filter((p) => p.left < left || p.right > right) };
  })(${HINTS}.querySelector('[data-slot=key-hints-content]'))`;
  type Widths = { scrollWidth: number; clientWidth: number; left: number; right: number; outside: unknown[] };
  for (const size of [100, 225] as const) {
    test.skipIf((size === 100 ? skip100 : skip225) !== null)(
      `T164 (10) at ${size}%: at 180 DIPs in both densities, no panel line is wider than the content box`,
      async () => {
        const s = await hintsSession(`10-${size}`);
        try {
          const [w, h] = size === 100 ? [1280, 800] : [1280, 1300];
          for (const density of ["compact", "comfortable"] as const) {
            await layout(s, w, h, density, 180);
            const f = await until<Hints>(s.c, `case 10 ${size}% ${density} form`, HINT_FACTS, (v) => v.form !== null);
            await s.c.evaluate(FRAMES);
            const r = await s.c.evaluate<Widths>(WIDTH_FACTS);
            console.log(`RECORD ${T164}: case 10 ${size}% ${density}: profile ${f.profile}, form ${f.form}, P_open ${f.open}, button ${f.button}, ${js(r)}`);
            expect({ size, density, profile: f.profile, scroll: r.scrollWidth <= widthLimit(r), outside: r.outside }).toEqual({ size, density, profile: "wide", scroll: true, outside: [] });
          }
        } finally {
          await end(s);
        }
      },
      caseTimeout(40, LIST_WAIT_MS),
    );
  }
});
