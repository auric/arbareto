// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T144 (feature 004 WP32, plan D20): the Submodules group tree and its branch marks in the installed package. `Local: package`. Quickstart Q30.
// Spec FR-107 to FR-111, SC-018, SC-019. T145 runs this file on a fresh package and records the result in research.md R31.
// The cases drive the page through the WebView2 CDP endpoint and UI Automation patterns. They send no OS input and never move the pointer.
// Page timing uses the page clock: from the `timeStamp` of the input event to the first animation frame whose page holds the result.
// With ARBARETO_TREE_SHOTS_DIR set, the Q30 case writes the PNG files of the board states Main, BranchMarks, Dark, and Collapsed there.

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
import { appEnv, findInstalledApp, PROBE_TIMEOUT_MS, processRecords, startInstalledApp, WAIT_MS, waitExit, type OwnedProcess } from "./installed-app";
import { BOARD_TOP, BOARD_TREE, boardWorld, folderCount, folderWorld, ICONS, markParts, otherRepo, twinWorlds } from "./submodule-tree-fixture";
import { close, ControlType, find, invoke, MAX_CALL_MS, MAX_WAIT_MS, setValue, type Element } from "./uia";

for (const helper of ["./cdp.ts", "./uia.ts", "./installed-app.ts", "./submodule-tree-fixture.ts", "../../src/contracts/limits.ts"]) printOrigin(helper, import.meta.dir);

const TASK = "T144";
console.log(`OS ${TASK}: os=${release()}`);
const STEP_MS = MAX_WAIT_MS + MAX_CALL_MS;
const caseTimeout = (steps: number, extraMs = 0) => steps * STEP_MS + 2 * PROBE_TIMEOUT_MS + 2 * WAIT_MS + extraMs;
// A key response, a view change, or a service round trip after a key stays far below it.
const KEY_WAIT_MS = 10_000;
// Research R31 "List time": the SC-020 budget for 256 rows is 55 s, and build ba095f87 took 107.8 s.
const LIST_WAIT_MS = 300_000;

// ---- Budgets and sample counts (spec SC-018, SC-019; 001 SC-005). Fixed before the first measured run (constitution VII). ----

// Spec SC-018: warm, median of 10 counted runs after one warm-up run, with 20 and 256 checked-out submodules.
const RUNS = 10;
const SIZES = [20, 256] as const;
// Spec SC-018: (median time to the last branch mark) - (median time to the last row of the detached twin), per submodule row. The T144 control sets it to 1.
const MARK_MS_PER_ROW = 30;
// Spec SC-020: the median time from the Enter keydown to the last branch mark, for each twin. The T150 control sets each value to 1.
const LIST_MS: Record<(typeof SIZES)[number], number> = { 20: 6_500, 256: 55_000 };
// Spec SC-019 and 001 SC-005: 95% of inputs within 100 ms, every input within 500 ms. The T144 control sets INPUT_P95_MS to 1.
const INPUT_P95_MS = 100;
const INPUT_MAX_MS = 500;
// One uncounted warm-up cycle, then the counted cycles. Each cycle sends the 10 keys of `CYCLE`, so the p95 counts 200 inputs.
const INPUT_WARMUP_CYCLES = 1;
const INPUT_CYCLES = 20;
// The Event Timing API reports no entry below its 16 ms minimum `durationThreshold`, so such an input counts as 16 ms.
const EVENT_THRESHOLD_MS = 16;

// ---- App texts (the source of each value is named) ----

// `OPEN_FOLDER` in src/frontend/app/RepositorySwitcher.tsx.
const OPEN_FOLDER = "Open folder… (Ctrl+O)";
// src/frontend/submodules/SubmodulesGroup.tsx, plan D15 "Tree rows".
const TREE_BOUND = `The submodule paths have more than ${SUBMODULE_TREE_FOLDERS.toLocaleString("en-US")} folders, so the group shows no folder rows.`;
const NO_BRANCH = "no branch";

// ---- CDP keys ----

// DOM `key` and `code`, and the winuser.h virtual-key code. `cdp.ts` has no End, O, or R key.
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
// True when `n` submodule rows show and each one has the branch mark `text` (spec FR-109). The marks come with the rows (FR-110).
const marksShown = (n: number, text: string) =>
  `(() => { const m = [...(${GROUP}?.querySelectorAll('[role=tree] [role=treeitem][data-path] [data-slot=branch-mark]') ?? [])]; return m.length === ${n} && m.every((e) => e.textContent === ${js(text)}); })()`;
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

  type Session = { app: OwnedProcess; c: Cdp; ipc: IpcLog };
  // One app on its own profile below the fixture root (ARBARETO_PROFILE_ROOT, `appEnv`), with the CDP endpoint on a free port.
  async function session(label: string, repo: string): Promise<Session> {
    const env = appEnv(fixtureDir(`${label}-app`), false);
    const port = freePort();
    env.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port}`;
    const app = startInstalledApp(installed!, env);
    owned.add(app);
    console.log(`STARTED ${TASK}: ${app.pid} ${label} port=${port} profile=${env.set.ARBARETO_PROFILE_ROOT}`);
    // A new profile holds no Git selection, so the boot view offers Select Git (uia.test.ts T241).
    await uia(app.pid, "Select Git", ControlType.Button, invoke);
    await uia(app.pid, "Use this Git", undefined, invoke);
    await uia(app.pid, OPEN_FOLDER, undefined, invoke);
    await pickFolder(app.pid, repo);
    const c = await connectPage(port, MAX_WAIT_MS);
    sockets.add(c);
    await until<string | null>(c, "the open repository", switcher, (v) => v === switcherLabel(repo), LIST_WAIT_MS);
    // A hidden page runs no animation frame, so page timing needs the visible window.
    expect(await c.evaluate<string>("document.visibilityState")).toBe("visible");
    return { app, c, ipc: await watchIpc(c) };
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
  async function timedSwitch(s: Session, repo: string, check: string): Promise<number> {
    await toRecent(s, repo);
    expect(await s.c.evaluate<boolean>(check)).toBe(false);
    await s.c.evaluate(`(() => {
      window.__t144 = null;
      addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const start = e.timeStamp;
        const step = () => {
          const now = performance.now();
          if (${check}) return void (window.__t144 = { ok: true, ms: now - start });
          if (now - start > ${LIST_WAIT_MS}) return void (window.__t144 = { ok: false, ms: now - start });
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }, { capture: true, once: true });
      return true;
    })()`);
    await press(s.c, "Enter");
    const r = (await until<{ ok: boolean; ms: number } | null>(s.c, "the timed open", "window.__t144", (v) => v !== null, LIST_WAIT_MS + 10_000))!;
    if (!r.ok) throw new Error(`the check did not hold within ${LIST_WAIT_MS} ms of the Enter keydown: ${check}`);
    return r.ms;
  }
  // Each submodule row name holds the mark parts that Git gives for its folder (spec SC-018, plan D15 "Tree rows").
  async function expectMarks(s: Session, repo: string, paths: readonly string[]): Promise<Record<string, string>> {
    const names = await s.c.evaluate<Record<string, string>>(NAMES);
    const wrong = paths.map((p) => ({ path: p, name: names[p], parts: markParts(GIT!, join(repo, ...p.split("/"))) })).filter((r) => !nameMatches(r.name, [r.path, ...r.parts]));
    expect(wrong).toEqual([]);
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
    "T144 fixtures: the board set, the SC-018 twins of 20 and 256 rows, and the 1,024 and 1,025 folder sets give the expected gitlinks, marks, and folder counts",
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
        const names = await expectMarks(s, b.repo, b.checkedOut);
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

  for (const n of SIZES) {
    test.skipIf(reason !== null)(
      `SC-018: with ${n} checked-out submodules, the time to the last branch mark minus the time to the last row of the detached twin is at most ${MARK_MS_PER_ROW} ms per row, and SC-020: each twin shows its last mark within ${LIST_MS[n]} ms (medians of ${RUNS} after one warm-up run)`,
      async () => {
        const t = twinWorlds(GIT!, fixtureDir(`sc018-${n}`), n);
        const other = otherRepo(GIT!, fixtureDir(`sc018-${n}-other`));
        const s = await session(`sc018-${n}`, other);
        try {
          // Each open registers a recent entry. Each fixture opens once before the runs, and its marks equal the Git status headers.
          for (const [repo, text] of [[t.branch, "main"], [t.detached, NO_BRANCH]] as const) {
            await openFolder(s, repo);
            await until<boolean>(s.c, `the marks of ${repo}`, marksShown(n, text), (v) => v, LIST_WAIT_MS);
            await expectMarks(s, repo, t.paths);
            await switchTo(s, other);
            await idle(s);
          }
          const times = { branch: [] as number[], detached: [] as number[] };
          // Run 0 is the warm-up run. A and B alternate, so a drift of the host reaches both.
          for (let run = 0; run <= RUNS; run++) {
            for (const [key, repo, text] of [["branch", t.branch, "main"], ["detached", t.detached, NO_BRANCH]] as const) {
              const ms = await timedSwitch(s, repo, marksShown(n, text));
              if (run > 0) times[key].push(ms);
              else console.log(`OBSERVATION ${TASK}: SC-018 ${n} ${key} warm-up run ${ms.toFixed(1)} ms`);
              await switchTo(s, other);
              await idle(s);
            }
          }
          const a = median(times.branch);
          const b = median(times.detached);
          const perRow = (a - b) / n;
          console.log(`OBSERVATION ${TASK}: SC-018 ${n} rows: branch runs ${js(rounded(times.branch))} ms, median ${a.toFixed(1)} ms; detached runs ${js(rounded(times.detached))} ms, median ${b.toFixed(1)} ms; ${perRow.toFixed(2)} ms per row, budget ${MARK_MS_PER_ROW} ms`);
          console.log(`OBSERVATION ${TASK}: SC-020 ${n} rows: branch median ${a.toFixed(1)} ms, detached median ${b.toFixed(1)} ms, budget ${LIST_MS[n]} ms`);
          expect({ n, perRow: perRow <= MARK_MS_PER_ROW, branch: a <= LIST_MS[n], detached: b <= LIST_MS[n] }).toEqual({ n, perRow: true, branch: true, detached: true });
        } finally {
          await end(s);
        }
      },
      caseTimeout(40, (2 * RUNS + 4) * 3 * LIST_WAIT_MS),
    );
  }

  // ---- SC-019: the key response with 256 rows and 1,024 open folders ----

  test.skipIf(reason !== null)(
    `SC-019: with 256 submodule rows and 1,024 open folder rows, ${INPUT_P95_MS} ms for 95% of the tree keys and ${INPUT_MAX_MS} ms for every key (${INPUT_CYCLES * 10} inputs after ${INPUT_WARMUP_CYCLES} warm-up cycle)`,
    async () => {
      const f = folderWorld(GIT!, fixtureDir("sc019"), 1_024);
      const s = await session("sc019", f.repo);
      try {
        // T147: the tree mounts only the rows in view. The first row and the root set size show that the 256 folders `t000` to `t255` are listed.
        const head = factsOf(`${ITEMS}[0]`);
        await until<RowFacts | null>(s.c, "the tree rows", head, (v) => v?.path === "t000", LIST_WAIT_MS);
        expect({ line: await s.c.evaluate<string | null>(BOUND_LINE), first: await s.c.evaluate<RowFacts | null>(head) }).toEqual({ line: null, first: { path: "t000", label: "t000", level: 1, pos: 1, size: 256, expanded: "true" } });
        console.log(`OBSERVATION ${TASK}: SC-019 mounted rows ${await s.c.evaluate<number>(`${ITEMS}.length`)} of ${256 + 1_024}`);
        // W3C Event Timing: the duration of each keydown runs from the event to the next paint after its handlers.
        await s.c.evaluate(`(() => {
          window.__t144Keys = [];
          window.__t144Events = [];
          addEventListener('keydown', (e) => window.__t144Keys.push(e.timeStamp), { capture: true });
          window.__t144Take = (entries) => { for (const e of entries) if (e.name === 'keydown') window.__t144Events.push({ start: e.startTime, duration: e.duration }); };
          window.__t144Observer = new PerformanceObserver((list) => window.__t144Take(list.getEntries()));
          window.__t144Observer.observe({ type: 'event', durationThreshold: ${EVENT_THRESHOLD_MS} });
          return true;
        })()`);
        // The focused treeitem of the group tree, or null.
        const FOCUS = factsOf(`(${GROUP}?.querySelector('[role=tree]')?.contains(document.activeElement) && document.activeElement?.getAttribute('role') === 'treeitem' ? document.activeElement : null)`);
        const folder = (path: string, level: number, expanded: string) => ({ path, label: path.split("/").at(-1)!, level, pos: 1, size: level === 1 ? 256 : 1, expanded });
        // The tree starts with `t000`, `t000/a`, `t000/a/b`, `t000/a/b/c`, and the row `s`, and ends with `t255/a/b/c` and its row `s`. Each step names the key and the focus that it must give (plan D15 keyboard map).
        const CYCLE: [string, RowFacts][] = [
          ["Home", folder("t000", 1, "true")],
          ["ArrowDown", folder("t000/a", 2, "true")],
          ["ArrowDown", folder("t000/a/b", 3, "true")],
          ["ArrowRight", folder("t000/a/b/c", 4, "true")],
          ["ArrowLeft", folder("t000/a/b/c", 4, "false")],
          ["ArrowRight", folder("t000/a/b/c", 4, "true")],
          ["Enter", folder("t000/a/b/c", 4, "false")],
          ["Enter", folder("t000/a/b/c", 4, "true")],
          ["End", { path: "t255/a/b/c/s", label: "s", level: 5, pos: 1, size: 1, expanded: null }],
          ["ArrowUp", folder("t255/a/b/c", 4, "true")],
        ];
        const first = `${GROUP}.querySelector('[role=treeitem][tabindex="0"]')`;
        await s.c.evaluate(`(${first}).focus(); true`);
        await until<boolean>(s.c, "the tree focus", `document.activeElement === (${first})`, (v) => v);
        const durations: number[] = [];
        for (let cycle = 0; cycle < INPUT_WARMUP_CYCLES + INPUT_CYCLES; cycle++) {
          await s.c.evaluate("(window.__t144Keys = [], window.__t144Events = [], true)");
          for (const [key, want] of CYCLE) {
            await press(s.c, key);
            await until<RowFacts | null>(s.c, `cycle ${cycle} ${key}`, FOCUS, (v) => js(v) === js(want));
          }
          await s.c.evaluate("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))");
          const { keys, events } = await s.c.evaluate<{ keys: number[]; events: { start: number; duration: number }[] }>("(window.__t144Take(window.__t144Observer.takeRecords()), { keys: window.__t144Keys, events: window.__t144Events })");
          expect({ cycle, keys: keys.length }).toEqual({ cycle, keys: CYCLE.length });
          if (cycle >= INPUT_WARMUP_CYCLES) durations.push(...keys.map((k) => events.find((e) => e.start === k)?.duration ?? EVENT_THRESHOLD_MS));
        }
        console.log(`OBSERVATION ${TASK}: SC-019 ${durations.length} inputs, p95 ${p95(durations)} ms, max ${Math.max(...durations)} ms, durations ${js(durations)}`);
        expect(durations.length).toBe(INPUT_CYCLES * CYCLE.length);
        expect({ p95: p95(durations) <= INPUT_P95_MS, max: Math.max(...durations) <= INPUT_MAX_MS }).toEqual({ p95: true, max: true });
      } finally {
        await end(s);
      }
    },
    caseTimeout(30 + (INPUT_WARMUP_CYCLES + INPUT_CYCLES) * 10, LIST_WAIT_MS),
  );
});
