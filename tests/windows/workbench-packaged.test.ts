// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T082: the feature 004 checks in the installed package (SC-003, SC-010, SC-014, FR-070, FR-085, research.md R21 N1 to N6).
// The cases without input use UI Automation patterns only. They send no keyboard or pointer input.
// The cases with keyboard or pointer input run only with ARBARETO_LIVE_INPUT=1 in the measurement account. Otherwise they print SKIP with the reason live-input.
// Injected input reaches the foreground window, so each send first checks that the app owns the foreground.

import { afterAll, describe, expect, test } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { basename, join } from "node:path";
import { KEYS } from "../../src/frontend/keyboard/shortcuts";
import { printOrigin } from "../origin";
import { fixtureDir, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { processCreationTime, terminateRecorded } from "../git/win32";
import { buildWorkbench, repoOf, wb, type WbFixture, type WbFixtureName } from "../git/workbench-fixtures";
import { CaptureError, DISPLAY_OFF, displayState, encodePng, keepDisplayOn, openDuplication, releaseDisplay } from "./capture";
import { connectPage, freePort, keyEvents, type Cdp } from "./cdp";
import { decodePng, formatMeasurement, measure, THRESHOLD, type Image } from "./contrast";
import { encodeInputs, INPUT_BYTES, keystroke } from "./inject";
import { appEnv, COMMIT_VIEW, explorerReveal, explorerWindows, findInstalledApp, localRow, PROBE_TIMEOUT_MS, processRecords, startInstalledApp, WAIT_MS, waitExit, type OwnedProcess } from "./installed-app";
import { running, TOOL_NAME, TOOL_READY_MS, toolCommand, waitEnded, waitReady, writeGuiCopy, type Member } from "./merge-tool-fixture";
import {
  acceleratorKey,
  boundingRect,
  close,
  expand,
  ControlType,
  find,
  focus,
  foregroundPid,
  foregroundSkip,
  inputDesktopSkip,
  invoke,
  isEnabled,
  isSelected,
  MAX_CALL_MS,
  MAX_WAIT_MS,
  readValue,
  select,
  setValue,
  showContextMenu,
  UiaError,
  waitFocus,
  type Element,
  type Rect,
} from "./uia";

for (const helper of ["./uia.ts", "./installed-app.ts", "./inject.ts", "./capture.ts", "./contrast.ts", "./cdp.ts", "./merge-tool-fixture.ts", "./native-facts.test.ts", "../git/win32.ts", "../git/workbench-fixtures.ts", "../../src/frontend/keyboard/shortcuts.ts"]) printOrigin(helper, import.meta.dir);

const TASK = "T082";
console.log(`OS ${TASK}: os=${release()}`);
const LIVE = process.env.ARBARETO_LIVE_INPUT === "1";
// One wait of a UIA step can pass its bound by one call.
const STEP_MS = MAX_WAIT_MS + MAX_CALL_MS;
const caseTimeout = (steps: number) => steps * STEP_MS + 2 * PROBE_TIMEOUT_MS + 2 * WAIT_MS;
// A Git result after an app action. A hook run and the service round trips stay far below it.
const GIT_WAIT_MS = 30_000;
const POLL_MS = 50;

// ---- App texts (the source of each value is named) ----

// `OPEN_FOLDER` in src/frontend/app/RepositorySwitcher.tsx.
const OPEN_FOLDER = "Open folder… (Ctrl+O)";
// src/frontend/commit/CommitTray.tsx.
const COMMIT = "Commit (Ctrl+Enter)";
const MESSAGE = "Commit message";
const AMEND = "Amend last commit";
const amendStatement = (oid: string) => `Commit replaces commit ${oid.slice(0, 12)}.`;
// src/frontend/changes/ChangesPane.tsx: the Changes list header button. A file row has the path as its name (`aria-label={entry.path}`).
const STAGE_ALL = "Stage all changes";
// src/frontend/branches/BranchButton.tsx: the text, then the counts label of the current branch, which is "No upstream" here.
const BRANCH_BUTTON = "main, No upstream";
// src-tauri/src/dialogs.rs `trust_confirmation` (plan.md D14).
const TRUST_MAIN = "Do you trust this repository?";
const TRUST = "Trust";
const NOT_NOW = "Not now";
const SHOW_DETAILS = "Show details";
const HIDE_DETAILS = "Hide details";
// src/frontend/trust/TrustChip.tsx.
const NOT_TRUSTED_CHIP = "Not trusted. Git does not run this repository's own programs.";
const TRUST_ITEM = "Trust this repository…";
const COMMIT_TRUST_TEXT = "Commit needs trust. Select Not trusted in the status bar to trust this repository.";
// src/frontend/branches/texts.ts and BranchActions.tsx `menuGroups`.
const DELETE_BUTTON = "Delete";
const BRANCH_FILTER = "Find a branch";
const BRANCH_NAME = "Branch name";
const NEW_NAME = "New name";
const SHOW_BRANCH_HISTORY = "Show only this branch's history";
// src/frontend/integrate/texts.ts.
const CLOSE_MERGE = "Close merge panel";
// src/frontend/changes/ChangesPane.tsx.
const SHOW_IN_EXPLORER = "Show in Explorer";
// src/frontend/resolve/texts.ts `openTool` and `cancel`.
const OPEN_TOOL = "Open in merge tool";
const CANCEL_TOOL = "Cancel";
// The MenubarTrigger text of src/frontend/app/RepositoryMenu.tsx. The trigger is a menu item with a popup, so UIA gives it ExpandCollapse and no Invoke.
const REPOSITORY = "Repository";

// Spec FR-085: the UIA Name is the label, and AcceleratorKey is the `aria-keyshortcuts` value (research.md R17). An item without a key has an empty AcceleratorKey.
function branchMenu(row: string, current: string, currentRow: boolean): [string, string][] {
  const items: [string, string][] = [
    ["Switch", KEYS.switch.aria],
    [`Merge into current branch (${current})…`, KEYS.merge.aria],
    [`Rebase current branch (${current}) onto ${row}…`, KEYS.rebase.aria],
    ["Create branch here…", KEYS.createBranch.aria],
    ["Rename…", KEYS.rename.aria],
    ["Delete…", KEYS.delete.aria],
    ["Push", ""],
    ["Copy branch name", ""],
  ];
  return currentRow ? [...items, [SHOW_BRANCH_HISTORY, "Control+Shift+B"]] : items;
}
// ChangesPane.tsx `menuGroups` and `ROW_LABEL` for a changed tracked file.
const FILE_MENU: [string, string][] = [["Stage file", KEYS.stageEntry.aria], ["Copy path", ""], [SHOW_IN_EXPLORER, ""]];
// src/frontend/app/RepositoryMenu.tsx.
const REPOSITORY_MENU: [string, string][] = [["Open folder…", "Control+O"], ["Recent repositories", "Control+R"], ["Clone…", ""], ["Select Git", ""], ["Settings…", ""], ["Update submodules", ""]];

// quickstart.md "Manual checks in the packaged build", and the SC-014 visible focus. The tester confirms each line in the package.
const MANUAL = [
  "the trust dialog: Not now is the default button, and Show details lists the folder, the hooks, and the filters by name",
  "the branch button, the branch list search, and the switch confirmation next to a sidebar row, with Cancel focused first",
  "the context menus on branch rows, history labels, Untracked folders, and submodule rows, by right-click and Shift+F10",
  "the merge and rebase panels in the dock, Ctrl+Enter, and Escape",
  "the commit view: the stage button on hover and focus, the hunk buttons, the line selection bar on the left, the 72-column guide, and the counter",
  "the worktree button and the Settings view with its scope bar and Close",
  "SC-014: each control shows visible focus",
];

// ---- Win32 calls that tests/windows/uia.ts and inject.ts do not export ----

const { ptr: P, i32, u32, i64 } = FFIType;
const open = () =>
  dlopen("user32.dll", {
    SendInput: { args: [u32, P, i32], returns: u32 },
    SetCursorPos: { args: [i32, i32], returns: i32 },
    WindowFromPoint: { args: [i64], returns: P },
    GetAncestor: { args: [P, u32], returns: P },
    GetWindowThreadProcessId: { args: [P, P], returns: u32 },
    SetProcessDpiAwarenessContext: { args: [i64], returns: i32 },
  }).symbols;
let user32: ReturnType<typeof open> | undefined;

// The DLLs exist only on Windows, so the import of this file must not open them.
function win(): ReturnType<typeof open> {
  if (process.platform !== "win32") throw new Error("the packaged workbench test needs Windows");
  return (user32 ??= open());
}

// Microsoft Learn `GetAncestor`: GA_ROOT. `WindowFromPoint` takes a POINT by value, which x64 passes as one 64-bit register.
const GA_ROOT = 2;
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4n;

// True when the top-level window under each corner and the center of `rect` belongs to process `pid`.
function ownsPixels(pid: number, rect: Rect): boolean {
  const owner = new Uint32Array(1);
  const right = rect.x + rect.width - 1;
  const bottom = rect.y + rect.height - 1;
  const points = [[rect.x, rect.y], [right, rect.y], [rect.x, bottom], [right, bottom], [rect.x + (rect.width >> 1), rect.y + (rect.height >> 1)]];
  return points.every(([x, y]) => {
    const hwnd = win().WindowFromPoint((BigInt(y!) << 32n) | (BigInt(x!) & 0xffff_ffffn));
    if (hwnd === null) return false;
    const root = win().GetAncestor(hwnd, GA_ROOT);
    if (root === null) return false;
    win().GetWindowThreadProcessId(root, ptr(owner));
    return owner[0] === pid;
  });
}

// ---- Live input (ARBARETO_LIVE_INPUT=1 only) ----

function insert(events: number, bytes: Buffer, what: string): void {
  // SendInput returns the number of events that it inserted. UIPI blocks give a lower count (Microsoft Learn "SendInput").
  const inserted = win().SendInput(events, ptr(bytes), INPUT_BYTES);
  if (inserted !== events) throw new Error(`SendInput inserted ${inserted} of ${events} events for ${what}`);
}

// Input goes to the foreground window, so a foreground window of another process stops the case before any input.
function requireForeground(pid: number): void {
  const owner = foregroundPid();
  if (owner !== pid) throw new Error(`the app (PID ${pid}) does not own the foreground window (PID ${owner}), so the case sends no input`);
}

// Each argument is a keystroke of tests/windows/inject.ts: a key, a chord such as `Ctrl+B`, or `text:<characters>`.
function keys(pid: number, ...strokes: string[]): void {
  for (const stroke of strokes) {
    requireForeground(pid);
    const events = keystroke(stroke);
    insert(events.length, encodeInputs(events), stroke);
    console.log(`INPUT ${TASK}: ${JSON.stringify(stroke)}`);
  }
}

// winuser.h, x64: INPUT has `type` at 0 and MOUSEINPUT at 8, with `dwFlags` at 12 in MOUSEINPUT.
const INPUT_MOUSE = 0;
const MOUSEEVENTF_RIGHTDOWN = 0x8;
const MOUSEEVENTF_RIGHTUP = 0x10;

// The click goes to the window under the pointer, so that pixel must belong to the app.
function rightClick(pid: number, rect: Rect): void {
  requireForeground(pid);
  const x = rect.x + (rect.width >> 1);
  const y = rect.y + (rect.height >> 1);
  if (!ownsPixels(pid, { x, y, width: 1, height: 1 })) throw new Error(`the app (PID ${pid}) does not own the pixel ${x},${y}, so the case sends no input`);
  if (!win().SetCursorPos(x, y)) throw new Error(`SetCursorPos(${x}, ${y}) failed`);
  const bytes = Buffer.alloc(2 * INPUT_BYTES);
  for (const [i, flags] of [MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP].entries()) {
    bytes.writeUInt32LE(INPUT_MOUSE, i * INPUT_BYTES);
    bytes.writeUInt32LE(flags, i * INPUT_BYTES + 8 + 12);
  }
  insert(2, bytes, "right-click");
  console.log(`INPUT ${TASK}: right-click at ${x},${y}`);
}

// ---- Fixture helpers ----

const git = (f: WbFixture, args: readonly string[]) => wb(repoOf(f), args).stdout.toString().trimEnd();
const head = (f: WbFixture) => git(f, ["rev-parse", "--verify", "HEAD"]);
const branchOid = (f: WbFixture, name: string) => git(f, ["for-each-ref", "--format=%(objectname)", `refs/heads/${name}`]);

// A pre-commit hook that appends one line to its marker file for each run (plan.md D19 canary).
function addHook(f: WbFixture): string {
  const marker = join(f.root, "pre-commit.marker");
  writeFileSync(join(f.repo, ".git", "hooks", "pre-commit"), `#!/bin/sh\necho pre-commit >> '${marker.replaceAll("\\", "/")}'\n`);
  return marker;
}
const hookRuns = (marker: string) => (existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter((l) => l !== "").length : 0);

async function waitFor<T>(what: string, ms: number, probe: () => T | null | undefined | false): Promise<T> {
  for (const end = performance.now() + ms; ; await Bun.sleep(POLL_MS)) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (performance.now() >= end) throw new Error(`${what} did not happen within ${ms} ms`);
  }
}
const waitGit = (what: string, probe: () => boolean) => waitFor(what, GIT_WAIT_MS, probe);

// ---- UIA helpers ----

async function use<T>(element: Promise<Element>, body: (element: Element) => T | Promise<T>): Promise<T> {
  const found = await element;
  try {
    return await body(found);
  } finally {
    found.release();
  }
}

function found(pid: number, name: string, controlType?: number): Promise<void>;
function found<T>(pid: number, name: string, controlType: number | undefined, body: (element: Element) => T | Promise<T>): Promise<T>;
function found(pid: number, name: string, controlType?: number, body: (element: Element) => unknown = () => {}) {
  return use(find(pid, name, MAX_WAIT_MS, controlType), body);
}

// A search with a zero bound reads the tree once.
async function present(pid: number, name: string, controlType?: number): Promise<boolean> {
  try {
    (await find(pid, name, 0, controlType)).release();
    return true;
  } catch (error) {
    if (error instanceof UiaError && error.code === "TIMEOUT") return false;
    throw error;
  }
}

async function gone(pid: number, name: string, controlType?: number): Promise<void> {
  for (const end = performance.now() + MAX_WAIT_MS; await present(pid, name, controlType); await Bun.sleep(10)) {
    if (performance.now() >= end) throw new Error(`${JSON.stringify(name)} stays ${MAX_WAIT_MS} ms`);
  }
}

// UIA_E_ELEMENTNOTAVAILABLE: a render replaced the element.
const UIA_E_ELEMENTNOTAVAILABLE = 0x8004_0201;

// As in uia.test.ts T241: a render can replace an element, so each poll finds it again. `act` runs until `done` holds.
async function actUntil(pid: number, name: string, controlType: number | undefined, done: (element: Element) => boolean, act: (element: Element) => void): Promise<void> {
  for (const end = performance.now() + MAX_WAIT_MS; ; await Bun.sleep(10)) {
    const element = await find(pid, name, Math.max(0, Math.ceil(end - performance.now())), controlType);
    try {
      if (done(element)) return;
      act(element);
      if (done(element)) return;
    } catch (error) {
      if (!(error instanceof UiaError && error.hresult === UIA_E_ELEMENTNOTAVAILABLE)) throw error;
    } finally {
      element.release();
    }
    if (performance.now() >= end) throw new Error(`${JSON.stringify(name)} did not reach its state after ${MAX_WAIT_MS} ms`);
  }
}

function invokeEnabled(pid: number, name: string, controlType: number = ControlType.Button): Promise<void> {
  let invoked = false;
  return actUntil(pid, name, controlType, () => invoked, (element) => {
    if (!isEnabled(element)) return;
    invoke(element);
    invoked = true;
  });
}

// Keyboard focus sits only in a window of the foreground process. Null means the focus check cannot run, and the SKIP line names the facts.
async function focusedOrSkip(pid: number, name: string, label: string): Promise<true | null> {
  try {
    await waitFocus(pid, name, MAX_WAIT_MS);
    return true;
  } catch (error) {
    const skip = error instanceof UiaError && error.code === "TIMEOUT" ? foregroundSkip(pid) : null;
    if (skip === null) throw error;
    console.log(`SKIP ${label}: ${skip}`);
    return null;
  }
}

// Moves the UIA focus to `name` and waits until it holds it.
async function focusOn(pid: number, name: string, label: string, controlType?: number): Promise<true | null> {
  await found(pid, name, controlType, focus);
  return focusedOrSkip(pid, name, label);
}

// A render can replace the row between the search and the call, and then no menu opens. A menu item of that menu in the tree is the open state.
async function openRowMenu(pid: number, row: string, item: string): Promise<void> {
  for (const end = performance.now() + MAX_WAIT_MS; ; ) {
    expect(await found(pid, row, undefined, showContextMenu)).toBe(0);
    try {
      return (await find(pid, item, Math.min(MAX_WAIT_MS, 1_000), ControlType.MenuItem)).release();
    } catch (error) {
      if (!(error instanceof UiaError && error.code === "TIMEOUT") || performance.now() >= end) throw error;
    }
  }
}

// The index entry of `file` holds the working bytes of `file`.
const staged = (f: WbFixture, file: string) => git(f, ["ls-files", "-s", "-z", "--", file]).startsWith(`100644 ${git(f, ["hash-object", "--", file])} 0\t`);

// Opens the Commit view, stages every change of the one changed `file`, and commits `message` through UIA patterns. It returns after the Commit invoke.
async function commitByUia(pid: number, f: WbFixture, file: string, message: string): Promise<void> {
  await found(pid, COMMIT_VIEW, ControlType.Button, invoke);
  await invokeEnabled(pid, STAGE_ALL);
  await waitGit(`the stage of ${file}`, () => staged(f, file));
  await actUntil(pid, MESSAGE, ControlType.Edit, (field) => readValue(field) === message, (field) => setValue(field, message));
  await invokeEnabled(pid, COMMIT);
}

// winnt.h `JOB_OBJECT_LIMIT_*`. The shell Job of src-tauri/src/jobs.rs is kill-on-close and allows no breakaway (plan.md D14).
const JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x800;
const JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x1000;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

describe.skipIf(process.platform !== "win32")("T082 packaged workbench", () => {
  // Bun 1.4.4 runs `afterAll` hooks in declaration order, also when a test timeout leaves its body running. This hook must come before the fixture root removal.
  const owned = new Set<OwnedProcess>();
  afterAll(() => {
    for (const app of owned) app.stop();
    close();
  });
  useFixtureRoot();
  // UIA rectangles, SetCursorPos, and desktop duplication then share physical pixels.
  win().SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  const discovery = findInstalledApp();
  const installed = "app" in discovery ? discovery.app : null;
  const others = installed === null ? [] : processRecords().filter((r) => r.name.toLowerCase() === installed.mainBinaryName.toLowerCase());
  const reason =
    installed === null ? (discovery as { skip: string }).skip : GIT === null ? "Git executable absent" : others.length > 0 ? `another-instance: ${installed.mainBinaryName} runs as PID ${others.map((r) => r.pid).join(", ")}` : null;
  if (reason !== null) console.log(`SKIP installed app: ${reason}`);
  const liveReason = LIVE ? (reason ?? inputDesktopSkip()) : "live-input: set ARBARETO_LIVE_INPUT=1 in the measurement account";
  if (liveReason !== null) console.log(`SKIP live-input cases: ${liveReason}`);
  for (const line of MANUAL) console.log(`MANUAL ${TASK}: ${line}`);

  async function start(fixture: WbFixture, label: string): Promise<OwnedProcess> {
    const app = startInstalledApp(installed!, appEnv(fixtureDir(`${label}-app`), false));
    owned.add(app);
    // A new profile holds no Git selection, so the boot view offers Select Git (uia.test.ts T241).
    await found(app.pid, "Select Git", ControlType.Button, invoke);
    await found(app.pid, "Use this Git", undefined, invoke);
    await found(app.pid, OPEN_FOLDER, undefined, invoke);
    // The Windows folder picker: the Edit has the Name of its label, and its dialog window has the Name of the OK button.
    await found(app.pid, "Folder:", ControlType.Edit, (field) => setValue(field, fixture.repo));
    await found(app.pid, "Select Folder", ControlType.Button, invoke);
    // `RepositorySwitcher.tsx`: the trigger label is the folder name and the Git worktree root.
    const top = git(fixture, ["rev-parse", "--show-toplevel"]);
    await found(app.pid, `${basename(top)}, ${top}`, ControlType.Button);
    return app;
  }

  async function stop(app: OwnedProcess): Promise<void> {
    app.stop();
    owned.delete(app);
    expect(await waitExit(app)).not.toBeNull();
  }

  const fixture = (name: WbFixtureName, folder: string) => buildWorkbench(GIT!, name, folder);

  test.skipIf(reason !== null)(
    "FR-085: each item of the branch, file row, and Repository menus has its label as UIA Name and its shortcut as AcceleratorKey",
    async () => {
      const branches = fixture("branches", "menu-repo");
      const changed = fixture("amend-no-upstream", "menu-file-repo");
      writeFileSync(join(changed.repo, "m.txt"), "3\n");
      const menus = [
        { menu: "merged", f: branches, open: (pid: number) => found(pid, localRow("merged"), undefined, showContextMenu).then((hr) => expect(hr).toBe(0)), items: branchMenu("merged", "main", false) },
        { menu: "main", f: branches, open: (pid: number) => found(pid, localRow("main", true), undefined, showContextMenu).then((hr) => expect(hr).toBe(0)), items: branchMenu("main", "main", true) },
        {
          menu: "m.txt",
          f: changed,
          open: async (pid: number) => {
            await found(pid, COMMIT_VIEW, ControlType.Button, invoke);
            await openRowMenu(pid, "m.txt", "Copy path");
          },
          items: FILE_MENU,
        },
        { menu: REPOSITORY, f: branches, open: (pid: number) => found(pid, REPOSITORY, ControlType.MenuItem, expand), items: REPOSITORY_MENU },
      ];
      // A Base UI menu is modal, and its close needs input, so each menu gets its own session.
      for (const [i, { menu, f, open, items }] of menus.entries()) {
        const app = await start(f, `menu-${i}`);
        try {
          await open(app.pid);
          for (const [label, key] of items) {
            const got = await found(app.pid, label, ControlType.MenuItem, acceleratorKey);
            console.log(`MENU_ITEM ${TASK}: ${JSON.stringify({ menu, name: label, acceleratorKey: got })}`);
            expect({ menu, name: label, acceleratorKey: got }).toEqual({ menu, name: label, acceleratorKey: key });
          }
        } finally {
          await stop(app);
        }
      }
    },
    caseTimeout(4 * 18),
  );

  test.skipIf(reason !== null)(
    "SC-014: the Delete confirmation focuses Cancel first, and its buttons have a contrast of at least 4.5:1",
    async () => {
      const f = fixture("branches", "danger-repo");
      const before = branchOid(f, "merged");
      const app = await start(f, "danger");
      keepDisplayOn();
      try {
        expect(await found(app.pid, localRow("merged"), undefined, showContextMenu)).toBe(0);
        await found(app.pid, "Delete…", ControlType.MenuItem, invoke);
        await found(app.pid, DELETE_BUTTON, ControlType.Button);
        await focusedOrSkip(app.pid, "Cancel", "Delete confirmation focus");
        const display = (await displayState()) === DISPLAY_OFF ? "display-off" : null;
        for (const [pair, name] of [["danger button", DELETE_BUTTON], ["cancel button", "Cancel"]] as const) {
          const rect = await found(app.pid, name, ControlType.Button, boundingRect);
          const skip = display ?? (ownsPixels(app.pid, rect) ? null : `the app window does not cover the ${pair} at ${JSON.stringify(rect)}`);
          if (skip !== null) {
            console.log(`SKIP ${pair} contrast: missing capability ${skip}`);
            continue;
          }
          let opened: ReturnType<typeof openDuplication>;
          try {
            opened = openDuplication(rect);
          } catch (error) {
            if (!(error instanceof CaptureError)) throw error;
            opened = { skip: error.message, hresult: error.hresult ?? null };
          }
          if ("skip" in opened) {
            console.log(`SKIP ${pair} contrast: missing capability ${opened.skip}`);
            continue;
          }
          let frame = null;
          try {
            // `acquire` skips a pointer-only frame. 20 waits of 100 ms bound the first frame.
            for (let i = 0; i < 20 && frame === null; i++) frame = opened.dup.acquire(100);
          } finally {
            opened.dup.close();
          }
          if (frame === null) throw new Error(`no desktop frame of the ${pair}`);
          const png = join(fixtureDir("evidence"), `${pair.replaceAll(" ", "-")}.png`);
          writeFileSync(png, encodePng(frame.image, rect.width, rect.height));
          console.log(`CAPTURE_PNG ${TASK}: ${png}`);
          // The duplicated image is BGRA.
          const rgb = new Uint8Array(rect.width * rect.height * 3);
          for (let p = 0; p < rect.width * rect.height; p++) rgb.set([frame.image[p * 4 + 2]!, frame.image[p * 4 + 1]!, frame.image[p * 4]!], p * 3);
          const image: Image = { width: rect.width, height: rect.height, rgb };
          const m = measure(image, { pair, kind: "text", box: { x: 0, y: 0, width: rect.width, height: rect.height } });
          console.log(`CONTRAST ${TASK}: ${formatMeasurement(m)}`);
          expect(m.ratio).toBeGreaterThanOrEqual(THRESHOLD.text);
        }
        await found(app.pid, "Cancel", ControlType.Button, invoke);
        await gone(app.pid, DELETE_BUTTON, ControlType.Button);
        expect(branchOid(f, "merged")).toBe(before);
      } finally {
        releaseDisplay();
        await stop(app);
      }
    },
    caseTimeout(20),
  );

  test.skipIf(reason !== null)(
    "SC-010: a session without repository programs shows no trust prompt",
    async () => {
      const f = fixture("amend-no-upstream", "plain-repo");
      writeFileSync(join(f.repo, "m.txt"), "3\n");
      const before = head(f);
      const app = await start(f, "plain");
      try {
        await commitByUia(app.pid, f, "m.txt", "T082 plain");
        // The trust dialog is modal for the commit, so a moved HEAD means that no prompt waited.
        await waitGit("the commit", () => head(f) !== before);
        expect(git(f, ["rev-parse", "HEAD^"])).toBe(before);
        expect(await present(app.pid, TRUST_MAIN)).toBe(false);
      } finally {
        await stop(app);
      }
    },
    caseTimeout(14),
  );

  test.skipIf(reason !== null)(
    "SC-010, FR-070, N1: the first commit with a pre-commit hook shows exactly one prompt, and the hook runs only after Trust",
    async () => {
      const f = fixture("amend-no-upstream", "hook-repo");
      const marker = addHook(f);
      writeFileSync(join(f.repo, "m.txt"), "3\n");
      const first = head(f);
      const app = await start(f, "hook");
      try {
        await commitByUia(app.pid, f, "m.txt", "T082 first");
        await found(app.pid, TRUST_MAIN);
        expect(hookRuns(marker)).toBe(0);
        expect(head(f)).toBe(first);
        // N1 in the package: Not now holds the first focus, and Show details expands the details.
        await focusedOrSkip(app.pid, NOT_NOW, "N1 initial focus");
        await found(app.pid, SHOW_DETAILS, undefined, invoke);
        await found(app.pid, HIDE_DETAILS);
        await found(app.pid, TRUST, ControlType.Button, invoke);
        await waitGit("the first commit", () => head(f) !== first);
        expect(hookRuns(marker)).toBe(1);
        expect(await present(app.pid, TRUST_MAIN)).toBe(false);
        // The second commit asks nothing: the modal dialog would hold HEAD.
        writeFileSync(join(f.repo, "m.txt"), "4\n");
        const second = head(f);
        await commitByUia(app.pid, f, "m.txt", "T082 second");
        await waitGit("the second commit", () => head(f) !== second);
        expect(hookRuns(marker)).toBe(2);
        expect(await present(app.pid, TRUST_MAIN)).toBe(false);
      } finally {
        await stop(app);
      }
    },
    caseTimeout(30),
  );

  test.skipIf(reason !== null)(
    "N5: Show in Explorer on a changed file opens its folder with the file selected",
    async () => {
      const f = fixture("amend-no-upstream", "reveal-repo");
      const target = join(f.repo, "m.txt");
      writeFileSync(target, "3\n");
      const app = await start(f, "reveal");
      try {
        await found(app.pid, COMMIT_VIEW, ControlType.Button, invoke);
        // ChangesPane.tsx `menuGroups`: every file row menu holds Copy path.
        await openRowMenu(app.pid, "m.txt", "Copy path");
        const before = explorerWindows();
        await found(app.pid, SHOW_IN_EXPLORER, ControlType.MenuItem, invoke);
        const state = explorerReveal(f.repo, before);
        if (state.preexisting) console.log(`NOTE ${TASK}: the reveal opened a tab in an existing Explorer window. The test leaves that window open.`);
        // Windows paths ignore case.
        expect({ window: state.found, selected: state.selected.map((p) => p.toLowerCase()) }).toEqual({ window: true, selected: [target.toLowerCase()] });
      } finally {
        await stop(app);
      }
    },
    caseTimeout(12) + 2 * PROBE_TIMEOUT_MS,
  );

  // ---- T135: conflict guidance (spec FR-102 to FR-106, SC-017) ----
  // The keys go through CDP `Input.dispatchKeyEvent`, as tests/windows/inspection-packaged.test.ts does. They send no OS input.
  // Dark and Light are the System theme under the CDP `prefers-color-scheme` emulation. Forced colors is the CDP `forced-colors` emulation.

  // One real stop: both sides add `a.txt` and `b.txt` with other bytes, so each path is a porcelain v2 `u AA` record.
  function conflictFixture(variant: "merge" | "rebase", folder: string): { f: WbFixture; paths: string[] } {
    const f = fixture("amend-no-upstream", folder);
    const paths = variant === "merge" ? ["a.txt", "b.txt"] : ["a.txt"];
    const commit = (side: string) => {
      for (const p of paths) writeFileSync(join(f.repo, p), `${side}\n`);
      git(f, ["add", "--", ...paths]);
      git(f, ["commit", "-q", "-m", side]);
    };
    git(f, ["switch", "-q", "-c", "topic"]);
    commit("topic");
    git(f, ["switch", "-q", "main"]);
    commit("main");
    if (variant === "merge") wb(repoOf(f), ["merge", "--no-edit", "topic"], { allowExit: [1] });
    else wb(repoOf(f), ["rebase", "main"], { allowExit: [1] });
    expect(git(f, ["status", "--porcelain=v2", "-z"]).split("\0").filter((r) => r.startsWith("u ")).map((r) => r.split(" ").at(-1))).toEqual(paths);
    return { f, paths };
  }

  async function cdpStart(fixture: WbFixture, label: string): Promise<{ app: OwnedProcess; c: Cdp }> {
    const env = appEnv(fixtureDir(`${label}-app`), false);
    const port = freePort();
    env.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port}`;
    const app = startInstalledApp(installed!, env);
    owned.add(app);
    await found(app.pid, "Select Git", ControlType.Button, invoke);
    await found(app.pid, "Use this Git", undefined, invoke);
    await found(app.pid, OPEN_FOLDER, undefined, invoke);
    await found(app.pid, "Folder:", ControlType.Edit, (field) => setValue(field, fixture.repo));
    await found(app.pid, "Select Folder", ControlType.Button, invoke);
    const top = git(fixture, ["rev-parse", "--show-toplevel"]);
    await found(app.pid, `${basename(top)}, ${top}`, ControlType.Button);
    const c = await connectPage(port, MAX_WAIT_MS);
    sockets.add(c);
    return { app, c };
  }
  const sockets = new Set<Cdp>();
  afterAll(() => {
    for (const c of sockets) c.close();
  });

  const js = (value: unknown) => JSON.stringify(value);
  async function until<T>(c: Cdp, what: string, expression: string, done: (value: T) => boolean): Promise<T> {
    const value = await c.poll<T>(expression, done, MAX_WAIT_MS);
    if (!done(value)) throw new Error(`${what} did not happen within ${MAX_WAIT_MS} ms: ${js(value)}`);
    return value;
  }
  // cdp.ts has no Space key. These are the CDP parameters of one typed Space press.
  async function press(c: Cdp, name: string, modifiers = 0): Promise<void> {
    const events =
      name === "Space"
        ? [
            { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 0x20, modifiers: 0, text: " ", unmodifiedText: " " },
            { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 0x20, modifiers: 0 },
          ]
        : keyEvents(name, modifiers, { typed: true });
    for (const params of events) await c.send("Input.dispatchKeyEvent", params);
    console.log(`KEY T135: ${name} mods=${modifiers}`);
  }
  const ACTIVE = `(() => { const a = document.activeElement; return { label: a?.getAttribute('aria-label') ?? null, text: a?.textContent?.trim() ?? null, section: a?.closest('[data-section]')?.dataset.section ?? null, dock: a?.closest('section[aria-label="Dock"]') !== null, band: a?.closest('[data-slot="conflict-row"]') !== null, tree: a?.closest('[data-file-tree]')?.dataset.fileTree ?? null }; })()`;
  type Active = { label: string | null; text: string | null; section: string | null; dock: boolean; band: boolean; tree: string | null };
  const active = (c: Cdp) => c.evaluate<Active>(ACTIVE);
  // Presses `key` until `done` holds for the focused element. One pass over 40 presses bounds the walk.
  async function keyTo(c: Cdp, key: string, what: string, done: (a: Active) => boolean, modifiers = 0): Promise<void> {
    for (let i = 0; i < 40; i++) {
      if (done(await active(c))) return;
      await press(c, key, modifiers);
    }
    throw new Error(`${what}: 40 presses of ${key} did not reach it, the focus is on ${js(await active(c))}`);
  }
  const RESOLVE_BUTTON = "Resolve conflicts";
  const OPERATION_REASON = "A merge or a rebase is in progress. Finish it with Mark resolved and the actions in the Notices band.";
  // The Chromium accessibility description is the UIA FullDescription of the control.
  async function description(c: Cdp, expression: string): Promise<string | null> {
    await c.send("Accessibility.enable");
    const handle = (await c.send("Runtime.evaluate", { expression, returnByValue: false })) as { result: { objectId?: string } };
    if (handle.result.objectId === undefined) throw new Error(`no element for ${expression}`);
    const { nodes } = (await c.send("Accessibility.getPartialAXTree", { objectId: handle.result.objectId, fetchRelatives: false })) as { nodes: { description?: { value?: string } }[] };
    return nodes[0]?.description?.value ?? null;
  }
  const buttonNamed = (name: string, scope = "document") => `[...${scope}.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent.trim()) === ${js(name)})`;
  type Scheme = "dark" | "light" | "forced";
  const FOCUS_STYLE = `(() => { const s = getComputedStyle(document.activeElement); return { outline: s.outlineStyle, width: s.outlineWidth, shadow: s.boxShadow }; })()`;
  async function contrastOf(c: Cdp, scheme: Scheme, targets: [string, string][]): Promise<void> {
    const features = scheme === "forced" ? [{ name: "forced-colors", value: "active" }] : [{ name: "prefers-color-scheme", value: scheme }, { name: "forced-colors", value: "none" }];
    await c.send("Emulation.setEmulatedMedia", { features });
    await c.evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))`);
    const focus = await c.evaluate<{ outline: string; width: string; shadow: string }>(FOCUS_STYLE);
    expect({ scheme, focusVisible: (focus.outline !== "none" && Number.parseFloat(focus.width) > 0) || focus.shadow !== "none" }).toEqual({ scheme, focusVisible: true });
    const shot = (await c.send("Page.captureScreenshot", { format: "png" })) as { data: string };
    const png = Buffer.from(shot.data, "base64");
    const file = join(fixtureDir("evidence"), `t135-${scheme}-${crypto.randomUUID()}.png`);
    writeFileSync(file, png);
    console.log(`CAPTURE_PNG T135: ${file}`);
    const image = decodePng(new Uint8Array(png));
    for (const [pair, expression] of targets) {
      const r = await c.evaluate<{ x: number; y: number; width: number; height: number; dpr: number } | null>(`(() => { const e = ${expression}; if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, dpr: devicePixelRatio }; })()`);
      if (r === null) throw new Error(`no element for ${pair}`);
      const x = Math.max(0, Math.round(r.x * r.dpr));
      const y = Math.max(0, Math.round(r.y * r.dpr));
      const box = { x, y, width: Math.min(image.width - x, Math.floor(r.width * r.dpr)), height: Math.min(image.height - y, Math.floor(r.height * r.dpr)) };
      const m = measure(image, { pair: `${scheme} ${pair}`, kind: "text", box });
      console.log(`CONTRAST T135: ${formatMeasurement(m)}`);
      expect({ scheme, pair, pass: m.ratio >= THRESHOLD.text }).toEqual({ scheme, pair, pass: true });
    }
  }

  test.skipIf(reason !== null)(
    "T135, SC-017: by keyboard, Resolve conflicts in the dock and in the band focuses the first Conflicted row with its resolve view; no visible operation reason; Mark resolved of each file shows Continue again",
    async () => {
      for (const variant of ["merge", "rebase"] as const) {
        const { f, paths } = conflictFixture(variant, `t135-${variant}-repo`);
        const firstName = `${paths[0]}, conflicted, both added`;
        const { app, c } = await cdpStart(f, `t135-${variant}`);
        // The first Conflicted row has the page focus and the UIA focus, and its resolve view shows.
        const expectFirstRow = async (from: string) => {
          const a = await until<Active>(c, `${from}: the first Conflicted row focus`, ACTIVE, (v) => v.label === firstName);
          expect({ from, tree: a.tree, section: a.section }).toEqual({ from, tree: "conflicted", section: "conflicted" });
          await focusedOrSkip(app.pid, firstName, `T135 ${variant} ${from} UIA focus`);
          await found(app.pid, `Resolve ${paths[0]}`);
          console.log(`FOCUS T135: ${variant} ${from} ${firstName}`);
        };
        const toHistory = async () => {
          await keyTo(c, "F6", "the header", (a) => a.section === "header");
          await keyTo(c, "Tab", "the History view button", (a) => a.text === "History" && a.section === "header");
          await press(c, "Enter");
          await until<boolean>(c, "the History view", `!document.querySelector('[data-view="history"]')?.hidden`, (v) => v);
        };
        try {
          await until<boolean>(c, "the conflict row", `${buttonNamed(RESOLVE_BUTTON, "document.querySelector('[data-slot=\"conflict-row\"]')")} !== undefined`, (v) => v);
          // Dock: the Working directory row is the first row of the History list.
          await keyTo(c, "F6", "the History list", (a) => a.section === "historyList");
          await press(c, "Home");
          await keyTo(c, "Tab", "the dock Resolve conflicts", (a) => a.dock && a.text === RESOLVE_BUTTON);
          await press(c, "Enter");
          await expectFirstRow("dock");
          // Band: the notice heading, then the first band control.
          await toHistory();
          await keyTo(c, "F6", "the notice band", (a) => a.section === "noticeHeading");
          await keyTo(c, "Tab", "the band Resolve conflicts", (a) => a.band && a.text === RESOLVE_BUTTON);
          await press(c, "Enter");
          await expectFirstRow("band");
          // Spec FR-105: no visible reason line, and each unavailable control describes the reason.
          expect(await c.evaluate<boolean>(`document.querySelector('[data-view="commit"]').innerText.includes(${js(OPERATION_REASON)})`)).toBe(false);
          for (const name of ["Stage all changes", "Commit (Ctrl+Enter)"]) {
            const got = await description(c, buttonNamed(name, "document.querySelector('[data-view=\"commit\"]')"));
            console.log(`DESCRIPTION T135: ${js({ variant, name, description: got })}`);
            // FilesButton describes "<action> is unavailable: <reason>" (plan D15 "Commit view texts").
            expect({ name, described: got?.includes(OPERATION_REASON) }).toEqual({ name, described: true });
          }
          const amend = await description(c, `document.querySelector('[data-view="commit"] input[type="checkbox"]')`);
          expect({ name: AMEND, description: amend }).toEqual({ name: AMEND, description: OPERATION_REASON });
          for (const scheme of ["dark", "light", "forced"] as const) {
            await contrastOf(c, scheme, [
              ["Resolve conflicts", buttonNamed(RESOLVE_BUTTON, "document.querySelector('[data-slot=\"conflict-row\"]')")],
              ["focused Conflicted row", "document.activeElement"],
            ]);
          }
          await c.send("Emulation.setEmulatedMedia", { features: [] });
          // Space on the focused row is Mark resolved. Focus then moves to the next Conflicted row.
          for (const path of paths) {
            await until<Active>(c, `the focus on ${path}`, ACTIVE, (v) => v.label === `${path}, conflicted, both added`);
            await press(c, "Space");
            await waitGit(`Mark resolved of ${path}`, () => git(f, ["ls-files", "-u", "-z", "--", path]) === "");
          }
          const band = await until<string[]>(c, "Continue in the band", `[...document.querySelectorAll('[data-slot="conflict-row"] button')].map((b) => b.textContent.trim())`, (v) => v.includes("Continue"));
          expect(band.includes(RESOLVE_BUTTON)).toBe(false);
          expect(git(f, ["ls-files", "-u", "-z"])).toBe("");
        } finally {
          c.close();
          sockets.delete(c);
          await stop(app);
        }
      }
    },
    2 * (caseTimeout(60) + 2 * GIT_WAIT_MS),
  );

  // ---- Live input ----

  test.skipIf(liveReason !== null)(
    "N1, FR-070: Enter and Escape on the trust dialog choose Not now, and the hook does not run",
    async () => {
      const f = fixture("amend-no-upstream", "live-trust-repo");
      const marker = addHook(f);
      writeFileSync(join(f.repo, "m.txt"), "3\n");
      const before = head(f);
      const app = await start(f, "live-trust");
      const openFromChip = async () => {
        await found(app.pid, NOT_TRUSTED_CHIP, ControlType.Button, invoke);
        await invokeEnabled(app.pid, TRUST_ITEM, ControlType.MenuItem);
        await found(app.pid, TRUST_MAIN);
      };
      try {
        await commitByUia(app.pid, f, "m.txt", "T082 live");
        await found(app.pid, TRUST_MAIN);
        if ((await focusedOrSkip(app.pid, NOT_NOW, "N1 Enter")) === null) return;
        keys(app.pid, "Enter");
        await gone(app.pid, TRUST_MAIN);
        // Spec US7 scenario 4: only Not now gives the Commit trust reason and an unavailable Commit.
        await found(app.pid, COMMIT_TRUST_TEXT);
        await actUntil(app.pid, COMMIT, ControlType.Button, (button) => !isEnabled(button), () => {});
        expect({ key: "Enter", hookRuns: hookRuns(marker), head: head(f) }).toEqual({ key: "Enter", hookRuns: 0, head: before });
        // Commit is unavailable now, so the second dialog comes from the trust chip.
        await openFromChip();
        if ((await focusedOrSkip(app.pid, NOT_NOW, "N1 Escape")) === null) return;
        keys(app.pid, "Escape");
        await gone(app.pid, TRUST_MAIN);
        // Workbench.tsx `approveTrust`: after Trust, the chip shows Trusted and its Trust item is unavailable. Only Not now gives a new dialog here.
        await openFromChip();
        await found(app.pid, NOT_NOW, ControlType.Button, invoke);
        await gone(app.pid, TRUST_MAIN);
        expect({ key: "Escape", hookRuns: hookRuns(marker), head: head(f) }).toEqual({ key: "Escape", hookRuns: 0, head: before });
      } finally {
        await stop(app);
      }
    },
    caseTimeout(30),
  );

  test.skipIf(liveReason !== null)(
    "N2, FR-014: a right-click and Shift+F10 open the action menu on a branch row, and Shift+F10 focuses its first item",
    async () => {
      const f = fixture("branches", "live-menu-repo");
      const row = localRow("merged");
      const app = await start(f, "live-menu");
      try {
        if ((await focusOn(app.pid, row, "N2 right-click")) === null) return;
        rightClick(app.pid, await found(app.pid, row, undefined, boundingRect));
        await found(app.pid, "Switch", ControlType.MenuItem);
        keys(app.pid, "Escape");
        await gone(app.pid, "Switch", ControlType.MenuItem);
        if ((await focusOn(app.pid, row, "N2 Shift+F10")) === null) return;
        keys(app.pid, "Shift+F10");
        await waitFocus(app.pid, "Switch", MAX_WAIT_MS);
        keys(app.pid, "Escape");
        await gone(app.pid, "Switch", ControlType.MenuItem);
      } finally {
        await stop(app);
      }
    },
    caseTimeout(16),
  );

  test.skipIf(liveReason !== null)(
    "N3, N4, N6: Open in merge tool runs the fixture tool in the operation Job, Cancel ends the tree, and the tool window comes to the front",
    async () => {
      const f = fixture("conflict-merge", "live-tool-repo");
      const tool = join(fixtureDir("live-tool"), TOOL_NAME);
      writeGuiCopy(process.execPath, tool);
      const ready = fixtureDir("live-tool-ready");
      // A local `mergetool.<tool>.cmd` is a repository program of the class `mergetool` (src/git-service/trust.ts `programKey`), so the first run asks.
      git(f, ["config", "merge.tool", "window"]);
      git(f, ["config", "mergetool.window.cmd", toolCommand(tool, ready)]);
      const app = await start(f, "live-tool");
      const tools: Member[] = [];
      try {
        await found(app.pid, COMMIT_VIEW, ControlType.Button, invoke);
        // The Conflicted row selection opens the resolve view (ResolveView.tsx).
        await actUntil(app.pid, "uu.txt", ControlType.TreeItem, isSelected, select);
        await invokeEnabled(app.pid, OPEN_TOOL);
        await found(app.pid, TRUST_MAIN);
        // Plan.md D14: the user starts the tool from the Arbareto window, so the app must hold the foreground at the start.
        const noForeground = foregroundSkip(app.pid);
        await found(app.pid, TRUST, ControlType.Button, invoke);
        const facts = await waitReady(ready, TOOL_READY_MS);
        if (facts === null) throw new Error(`the fixture tool did not start within ${TOOL_READY_MS} ms`);
        tools.push({ pid: facts.pid, name: TOOL_NAME, created: processCreationTime(facts.pid) });
        const names = new Map(processRecords().map((r) => [r.pid, r.name]));
        const members: Member[] = facts.job.members.map((m) => ({ pid: m.pid, name: names.get(m.pid) ?? null, created: m.created === null ? null : BigInt(m.created) }));
        const listed = [...new Set(members.map((m) => m.name))].sort();
        const flags = facts.job.limitFlags;
        console.log(`JOB ${TASK}: ${JSON.stringify({ members: members.map((m) => ({ pid: m.pid, name: m.name })), limitFlags: flags })}`);
        // N3: the immediate Job of the tool holds Git, its shell, and the tool, but not the app.
        expect({ tool: members.some((m) => m.pid === facts.pid), app: members.some((m) => m.pid === app.pid), git: listed.includes("git.exe"), sh: listed.includes("sh.exe"), killOnClose: (flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) !== 0, breakaway: (flags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)) !== 0 }).toEqual({
          tool: true,
          app: false,
          git: true,
          sh: true,
          killOnClose: true,
          breakaway: false,
        });
        // N6: the tool records the foreground window right after its `ShowWindow`.
        if (noForeground !== null) console.log(`SKIP N6 ${TASK}: ${noForeground}`);
        else {
          const owner = foregroundPid();
          console.log(`N6 ${TASK}: ${JSON.stringify({ foreground: facts.foreground, foregroundOwnerAtReady: owner === null ? null : (names.get(owner) ?? `pid ${owner}`) })}`);
          expect(facts.foreground).toBe(true);
        }
        // N4: Cancel closes the operation Job, so every member ends.
        await invokeEnabled(app.pid, CANCEL_TOOL);
        const left = await waitEnded(members, WAIT_MS);
        expect({ remaining: left.map((m) => m.name) }).toEqual({ remaining: [] });
      } finally {
        await stop(app);
        // The fixture root holds the tool image, so its removal needs every tool process gone.
        for (const m of await waitEnded(tools, WAIT_MS)) {
          console.log(`LEFT ${TASK}: fixture tool PID ${m.pid} still runs`);
          terminateRecorded(m.pid, m.created!);
        }
        expect(running(tools)).toEqual([]);
      }
    },
    caseTimeout(16) + TOOL_READY_MS + 2 * WAIT_MS,
  );

  test.skipIf(liveReason !== null)(
    "SC-003, SC-014 US1 and US2: a toolbar switch in three inputs, then create, rename, and delete a branch by keyboard",
    async () => {
      const f = fixture("branches", "live-branch-repo");
      const app = await start(f, "live-branch");
      try {
        // SC-003: open the list, type, and press Enter. The UIA focus on the branch button is the start state, not an input.
        if ((await focusOn(app.pid, BRANCH_BUTTON, "SC-003", ControlType.Button)) === null) return;
        keys(app.pid, "Enter");
        await waitFocus(app.pid, BRANCH_FILTER, MAX_WAIT_MS);
        keys(app.pid, "text:feature", "Enter");
        await waitGit("the switch to feature/a/b", () => git(f, ["symbolic-ref", "HEAD"]) === "refs/heads/feature/a/b");
        // US2: Ctrl+B on a row creates a branch there and switches to it (the default of the create popover).
        if ((await focusOn(app.pid, localRow("merged"), "US2 create")) === null) return;
        keys(app.pid, "Ctrl+B");
        await waitFocus(app.pid, BRANCH_NAME, MAX_WAIT_MS);
        keys(app.pid, "text:t082-new", "Enter");
        await waitGit("the new branch", () => branchOid(f, "t082-new") === f.oids.second && git(f, ["symbolic-ref", "HEAD"]) === "refs/heads/t082-new");
        // F2 renames the row branch.
        if ((await focusOn(app.pid, localRow("merged"), "US2 rename")) === null) return;
        keys(app.pid, "F2");
        await waitFocus(app.pid, NEW_NAME, MAX_WAIT_MS);
        keys(app.pid, "Ctrl+A", "text:t082-renamed", "Enter");
        await waitGit("the rename", () => branchOid(f, "merged") === "" && branchOid(f, "t082-renamed") === f.oids.second);
        // Delete opens the confirmation with Cancel focused. Tab moves to Delete.
        if ((await focusOn(app.pid, localRow("t082-renamed"), "US2 delete")) === null) return;
        keys(app.pid, "Delete");
        await waitFocus(app.pid, "Cancel", MAX_WAIT_MS);
        keys(app.pid, "Tab");
        await waitFocus(app.pid, DELETE_BUTTON, MAX_WAIT_MS);
        keys(app.pid, "Enter");
        await waitGit("the delete", () => branchOid(f, "t082-renamed") === "");
      } finally {
        await stop(app);
      }
    },
    caseTimeout(30) + 4 * GIT_WAIT_MS,
  );

  test.skipIf(liveReason !== null)(
    "SC-014 US3: Ctrl+M on a branch row opens the merge panel, and Ctrl+Enter fast-forwards",
    async () => {
      const f = fixture("merge-ff", "live-merge-repo");
      const app = await start(f, "live-merge");
      try {
        if ((await focusOn(app.pid, localRow("topic"), "US3 merge")) === null) return;
        keys(app.pid, "Ctrl+M");
        await found(app.pid, CLOSE_MERGE, ControlType.Button);
        keys(app.pid, "Ctrl+Enter");
        await waitGit("the merge", () => branchOid(f, "main") === f.oids.topic);
        expect(git(f, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
      } finally {
        await stop(app);
      }
    },
    caseTimeout(12) + GIT_WAIT_MS,
  );

  test.skipIf(liveReason !== null)(
    "SC-014 US4 and US11: Space stages a file, Ctrl+Enter commits, and the amend replaces the commit by keyboard",
    async () => {
      const f = fixture("amend-no-upstream", "live-commit-repo");
      writeFileSync(join(f.repo, "m.txt"), "3\n");
      const base = head(f);
      const app = await start(f, "live-commit");
      try {
        await found(app.pid, COMMIT_VIEW, ControlType.Button, invoke);
        if ((await focusOn(app.pid, "m.txt", "US4 stage")) === null) return;
        keys(app.pid, "Space");
        await waitGit("the stage", () => staged(f, "m.txt"));
        if ((await focusOn(app.pid, MESSAGE, "US4 commit", ControlType.Edit)) === null) return;
        keys(app.pid, "text:T082 keyboard", "Ctrl+Enter");
        await waitGit("the commit", () => head(f) !== base);
        const committed = head(f);
        expect({ parent: git(f, ["rev-parse", "HEAD^"]), subject: git(f, ["log", "-1", "--format=%s"]) }).toEqual({ parent: base, subject: "T082 keyboard" });
        // US11: Space checks Amend last commit. The amend statement names the replaced commit.
        if ((await focusOn(app.pid, AMEND, "US11 amend")) === null) return;
        keys(app.pid, "Space");
        await found(app.pid, amendStatement(committed));
        if ((await focusOn(app.pid, MESSAGE, "US11 message", ControlType.Edit)) === null) return;
        keys(app.pid, "Ctrl+A", "text:T082 amended", "Ctrl+Enter");
        await waitGit("the amend", () => head(f) !== committed);
        expect({ parent: git(f, ["rev-parse", "HEAD^"]), subject: git(f, ["log", "-1", "--format=%s"]), tree: git(f, ["rev-parse", "HEAD^{tree}"]) }).toEqual({
          parent: base,
          subject: "T082 amended",
          tree: git(f, ["rev-parse", `${committed}^{tree}`]),
        });
      } finally {
        await stop(app);
      }
    },
    caseTimeout(20) + 3 * GIT_WAIT_MS,
  );
});
