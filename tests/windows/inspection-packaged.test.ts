// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T060: the feature 005 checks in the installed package (plan.md P9, WP8). Quickstart.md Q11, Q12, Q31, and "Manual checks in the packaged build".
// Spec FR-018, FR-024, FR-028, FR-051, FR-067, SC-003, SC-007, SC-010. `Local: package`.
// The cases drive the page through the WebView2 CDP endpoint and UI Automation patterns. They send no OS input and never move the pointer.
// CDP keys go through `Input.dispatchKeyEvent`, as tests/windows/keys-cdp.test.ts does (T124). They do not replace one live-input check of the native key path.
// Dark and Light are the System theme under the CDP `prefers-color-scheme` emulation. Forced colors is the CDP `forced-colors` emulation, not a Windows contrast theme.
// A case that moves a Recycle Bin item purges it through the `recycledPath` of the `runWorkbench` reply. A hook on the page invoke records that reply.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { printOrigin } from "../origin";
import { buildFiles, buildSubmodules, faGit } from "../git/file-actions-fixtures";
import { fixtureDir, FIXTURE_ROOT, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { workingFileDigests } from "../git/git-oracle";
import { buildHistory } from "../git/history-diff-fixtures";
import { connectPage, freePort, keyEvents, MOD, type Cdp } from "./cdp";
import { decodePng, formatMeasurement, measure, THRESHOLD } from "./contrast";
import { appEnv, COMMIT_VIEW, explorerReveal, explorerWindows, findInstalledApp, PROBE_TIMEOUT_MS, processRecords, startInstalledApp, WAIT_MS, waitExit, type OwnedProcess } from "./installed-app";
import { close, ControlType, expand, find, invoke, MAX_CALL_MS, MAX_WAIT_MS, setValue, type Element } from "./uia";

for (const helper of ["./cdp.ts", "./uia.ts", "./installed-app.ts", "./contrast.ts", "../git/file-actions-fixtures.ts", "../git/history-diff-fixtures.ts"]) printOrigin(helper, import.meta.dir);

const TASK = "T060";
// One wait of a UIA step can pass its bound by one call.
const STEP_MS = MAX_WAIT_MS + MAX_CALL_MS;
const caseTimeout = (steps: number) => steps * STEP_MS + 2 * PROBE_TIMEOUT_MS + 2 * WAIT_MS;
// A view change, a status read, and a service round trip after a key stay far below it.
const KEY_WAIT_MS = 10_000;
// A Recycle Bin batch or a Git read after an action.
const ACTION_WAIT_MS = 30_000;
// SC-007 compares the medians of this many opens of each kind.
const OPEN_RUNS = 3;

// ---- App texts (the source of each value is named) ----

// `OPEN_FOLDER` in src/frontend/app/RepositorySwitcher.tsx.
const OPEN_FOLDER = "Open folder… (Ctrl+O)";
// src/frontend/app/RepositoryMenu.tsx: the MenubarTrigger text and the item text.
const REPOSITORY = "Repository";
const OPEN_FOLDER_ITEM = "Open folder…";
// src/frontend/changes/ChangesPane.tsx `menuGroups` and src/frontend/changes/file-actions.ts `IGNORE_LABEL`.
const SHOW_IN_EXPLORER = "Show in Explorer";
const DELETE_ITEM = "Delete…";
const DELETE_PERMANENTLY_ITEM = "Delete permanently…";
const ADD_TO_GITIGNORE = "Add to .gitignore…";
// src/frontend/changes/DeleteConfirm.tsx.
const recycleTitle = (n: number) => `Move ${n} files to the Recycle Bin?`;
const RECYCLE_BUTTON = "Move to Recycle Bin";
// src/frontend/changes/file-actions.ts `reveal`.
const absentText = (path: string) => `${path} does not exist. Select Refresh (F5).`;
// src/frontend/state/workbench.ts: the discard modal of the ignore editor (D15 "Ignore editor texts").
const DISCARD_TITLE = "Discard changes to .gitignore?";
const DISCARD = "Discard";

// quickstart.md "Manual checks in the packaged build". The tester confirms each line in the package.
const MANUAL = [
  "History: the three regions with splitters, the parent picker of a merge commit, the two tabs in the constrained window profile",
  "Blame: the gutter, the age shades, the legend, the marks, and Alt+Left; no browser back navigation",
  "Commit view: the Delete from disk group, Del and Shift+Del only in the Changes list, the confirmation with Cancel focused first",
  "the Windows permanent-delete warning on a volume without a Recycle Bin, owned by the Arbareto window",
  "the ignore editor: line numbers, the selected new line, Updating preview…, the discard modal, and Ctrl+S",
  "the parent button after Open submodule, its tooltip with the full path, and one click back",
  "the branch card on hover and on focus, and Escape",
  "forced colors (Aquatic) and Light for the row menu, the card, and the blame view",
];

// ---- CDP keys ----

// `cdp.ts` `keyEvents` with `typed`: Enter goes as `keyDown` with its text, so Chromium also fires the activation of a focused button.
async function press(c: Cdp, name: string, modifiers = 0): Promise<void> {
  for (const params of keyEvents(name, modifiers, { typed: true })) await c.send("Input.dispatchKeyEvent", params);
  console.log(`KEY ${TASK}: ${name} mods=${modifiers}`);
}

const js = (value: unknown) => JSON.stringify(value);
// Polls a page expression until `done` holds, or fails at the bound with the last value.
async function until<T>(c: Cdp, what: string, expression: string, done: (value: T) => boolean, ms = KEY_WAIT_MS): Promise<T> {
  const value = await c.poll<T>(expression, done, ms);
  if (!done(value)) throw new Error(`${what} did not happen within ${ms} ms: ${js(value)}`);
  return value;
}
// The page waits for the end of every running animation, then for one frame. A closed Base UI popup stays in the DOM until its exit animation ends.
const settle = (c: Cdp) => c.evaluate(`Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))).then(() => new Promise((done) => requestAnimationFrame(() => done(true))))`);

const ACTIVE = `(() => { const a = document.activeElement; return { tag: a?.tagName ?? null, role: a?.getAttribute('role') ?? null, label: a?.getAttribute('aria-label') ?? null, text: a?.textContent?.trim().slice(0, 80) ?? null, section: a?.closest('[data-section]')?.dataset.section ?? null }; })()`;
type Active = { tag: string | null; role: string | null; label: string | null; text: string | null; section: string | null };

// The rows of the Commit view Changes tree (src/frontend/changes/ChangesPane.tsx `Row`): a file row has its path as its name, a folder row `<path>, <count>`.
const changesRow = (name: string) => `[...document.querySelectorAll('[data-file-tree=changes] [role=treeitem]')].find((e) => e.getAttribute('aria-label') === ${js(name)} || e.getAttribute('aria-label')?.startsWith(${js(`${name}, `)}))`;
const menuItem = (label: string) => `[...document.querySelectorAll('[role=menu] [role=menuitem]')].find((e) => e.querySelector('[data-slot=menu-label]')?.textContent === ${js(label)})`;
const dialogWith = (text: string) => `[...document.querySelectorAll('[role=dialog],[role=alertdialog]')].find((d) => d.textContent.includes(${js(text)}) && !d.hasAttribute('data-closed') && !d.hasAttribute('data-ending-style'))`;

async function focusOn(c: Cdp, expression: string, what: string): Promise<void> {
  await until<boolean>(c, `${what} shows`, `!!(${expression})`, (v) => v);
  await c.evaluate(`(${expression}).focus(); true`);
  await until<boolean>(c, `${what} has focus`, `document.activeElement === (${expression})`, (v) => v);
}

// Opens the Untracked section, then each closed folder row on the way to `path`, by keyboard. A folder with one folder child
// joins it into one row, as "deep/nested/inner" (src/frontend/changes/file-tree.ts `treeRows`), so the rows come from the page.
const CLOSED_FOLDERS = `[...document.querySelectorAll('[data-file-tree=changes] [role=treeitem][aria-expanded=false]:not([data-section-row])')].map((e) => e.getAttribute('aria-label').replace(/, [\\d,]+$/, ''))`;
async function revealRow(c: Cdp, path: string): Promise<void> {
  const section = `document.querySelector('[data-file-tree=changes] [data-section-row=untracked]')`;
  await focusOn(c, section, "the Untracked section");
  if ((await c.evaluate<string | null>(`${section}.getAttribute('aria-expanded')`)) !== "true") {
    await press(c, "ArrowRight");
    await until<string | null>(c, "the open Untracked section", `${section}.getAttribute('aria-expanded')`, (v) => v === "true");
  }
  for (let i = 0; i < 8 && !(await c.evaluate<boolean>(`!!(${changesRow(path)})`)); i++) {
    const folder = (await c.evaluate<string[]>(CLOSED_FOLDERS)).filter((p) => path.startsWith(`${p}/`)).sort((a, b) => b.length - a.length)[0];
    if (folder === undefined) throw new Error(`no row and no closed folder row above ${path}`);
    await focusOn(c, changesRow(folder), `the folder row ${folder}`);
    await press(c, "ArrowRight");
    await until<string | null>(c, "the open folder", `(${changesRow(folder)}).getAttribute('aria-expanded')`, (v) => v === "true");
  }
  await until<boolean>(c, `the row ${path}`, `!!(${changesRow(path)})`, (v) => v);
}

// Shift+F10 on the focused row opens its menu with the focus on the first item (spec FR-014). Arrow keys then reach `label`.
async function menuAction(c: Cdp, row: string, label: string): Promise<void> {
  await focusOn(c, row, "the row");
  await press(c, "F10", MOD.Shift);
  await until<boolean>(c, `the menu item ${label}`, `!!(${menuItem(label)})`, (v) => v);
  for (let i = 0; i < 12 && !(await c.evaluate<boolean>(`document.activeElement === (${menuItem(label)})`)); i++) await press(c, "ArrowDown");
  await until<boolean>(c, `the focus on ${label}`, `document.activeElement === (${menuItem(label)})`, (v) => v);
  await press(c, "Enter");
}

// ---- Accessibility, focus, and contrast through CDP (SC-010) ----

// The Chromium accessibility tree gives each computed name. A control of these roles without a name breaks SC-010.
const NAMED_ROLES = ["button", "menuitem", "textbox", "treeitem", "checkbox", "radio", "tab"];
async function unnamed(c: Cdp, root: string): Promise<string[]> {
  await c.send("Accessibility.enable");
  const handle = (await c.send("Runtime.evaluate", { expression: root, returnByValue: false })) as { result: { objectId?: string } };
  const objectId = handle.result.objectId;
  if (objectId === undefined) throw new Error(`no element for ${root}`);
  const missing: string[] = [];
  for (const role of NAMED_ROLES) {
    const { nodes } = (await c.send("Accessibility.queryAXTree", { objectId, role })) as { nodes: { role?: { value?: string }; name?: { value?: string }; ignored?: boolean }[] };
    for (const node of nodes) if (!node.ignored && (node.name?.value ?? "").trim() === "") missing.push(role);
  }
  return missing;
}

// Visible focus: the focused control draws an outline or a box shadow.
const FOCUS_STYLE = `(() => { const s = getComputedStyle(document.activeElement); return { outline: s.outlineStyle, width: s.outlineWidth, shadow: s.boxShadow }; })()`;
const focusVisible = (s: { outline: string; width: string; shadow: string }) => (s.outline !== "none" && Number.parseFloat(s.width) > 0) || s.shadow !== "none";

type Scheme = "dark" | "light" | "forced";
async function emulate(c: Cdp, scheme: Scheme): Promise<void> {
  const features = scheme === "forced" ? [{ name: "forced-colors", value: "active" }] : [{ name: "prefers-color-scheme", value: scheme }, { name: "forced-colors", value: "none" }];
  await c.send("Emulation.setEmulatedMedia", { features });
  await settle(c);
}

// The contrast of the text in each element, measured in a CDP screenshot of the page at device pixels (T179 `measure`).
async function contrast(c: Cdp, scheme: Scheme, targets: [string, string][]): Promise<void> {
  const shot = (await c.send("Page.captureScreenshot", { format: "png" })) as { data: string };
  const png = Buffer.from(shot.data, "base64");
  const file = join(fixtureDir("evidence"), `${scheme}-${crypto.randomUUID()}.png`);
  writeFileSync(file, png);
  console.log(`CAPTURE_PNG ${TASK}: ${file}`);
  const image = decodePng(new Uint8Array(png));
  for (const [pair, expression] of targets) {
    const r = await c.evaluate<{ x: number; y: number; width: number; height: number; dpr: number } | null>(`(() => { const e = ${expression}; if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, dpr: devicePixelRatio }; })()`);
    if (r === null) throw new Error(`no element for ${pair}`);
    const x = Math.max(0, Math.round(r.x * r.dpr));
    const y = Math.max(0, Math.round(r.y * r.dpr));
    const box = { x, y, width: Math.min(image.width - x, Math.floor(r.width * r.dpr)), height: Math.min(image.height - y, Math.floor(r.height * r.dpr)) };
    const m = measure(image, { pair: `${scheme} ${pair}`, kind: "text", box });
    console.log(`CONTRAST ${TASK}: ${formatMeasurement(m)}`);
    expect({ scheme, pair, pass: m.ratio >= THRESHOLD.text }).toEqual({ scheme, pair, pass: true });
  }
}

// ---- The Recycle Bin hook and purge ----

// `@tauri-apps/api` `invoke` reads `window.__TAURI_INTERNALS__.invoke` at each call, so the wrapper sees each `runWorkbench` reply.
const HOOK = `(() => {
  const internals = window.__TAURI_INTERNALS__;
  if (internals.__t060 !== true) {
    const original = internals.invoke.bind(internals);
    window.__t060Replies = [];
    internals.invoke = async (cmd, args, options) => {
      const reply = await original(cmd, args, options);
      if (cmd === "run_workbench") window.__t060Replies.push(reply);
      return reply;
    };
    internals.__t060 = true;
  }
  return internals.__t060 === true;
})()`;
type DeleteReply = { state: string; result?: { action: string; entries: { entryId: string; outcome: string; recycledPath?: string }[] } };

// Data-model §5: the test removes each item that it moved, and its `$I` partner beside the `$R` item, below `<drive>\$Recycle.Bin\<SID>\`.
function purge(recycled: string): { inBin: boolean; partner: boolean } {
  const parts = recycled.split("\\");
  if (parts.length !== 4 || parts[1]!.toLowerCase() !== "$recycle.bin" || !basename(recycled).startsWith("$R")) throw new Error(`not a Recycle Bin item: ${recycled}`);
  const inBin = existsSync(recycled);
  rmSync(recycled, { recursive: true, force: true });
  const partner = join(dirname(recycled), `$I${basename(recycled).slice(2)}`);
  const hadPartner = existsSync(partner);
  rmSync(partner, { force: true });
  console.log(`PURGE ${TASK}: item=${inBin} partner=${hadPartner}`);
  return { inBin, partner: hadPartner };
}

describe.skipIf(process.platform !== "win32")("T060 packaged inspection and file actions", () => {
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
  for (const line of MANUAL) console.log(`MANUAL ${TASK}: ${line}`);

  const git = (repo: string, args: string[]) => faGit(GIT!, repo, args).toString("utf8");
  const top = (repo: string) => git(repo, ["rev-parse", "--show-toplevel"]).trim();
  // `RepositorySwitcher.tsx`: the trigger label is the folder name and the Git worktree root.
  const switcher = `document.querySelector('button[aria-keyshortcuts="Control+R"]')?.getAttribute('aria-label') ?? null`;
  const switcherLabel = (root: string) => `${basename(root)}, ${root}`;

  async function use<T>(element: Promise<Element>, body: (element: Element) => T): Promise<T> {
    const found = await element;
    try {
      return body(found);
    } finally {
      found.release();
    }
  }
  const uia = <T>(pid: number, name: string, type: number | undefined, body: (element: Element) => T) => use(find(pid, name, MAX_WAIT_MS, type), body);

  // One app session on `repo`: Select Git, then the folder picker. The page then gets a CDP connection.
  async function session(label: string, repo: string): Promise<{ app: OwnedProcess; c: Cdp }> {
    if (repo === "" || !isAbsolute(repo) || relative(FIXTURE_ROOT, repo).startsWith("..")) throw new Error(`the repository is outside the fixture root: ${JSON.stringify(repo)}`);
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
    // The Windows folder picker: the Edit has the Name of its label, and its dialog window has the Name of the OK button.
    await uia(app.pid, "Folder:", ControlType.Edit, (field) => setValue(field, repo));
    await uia(app.pid, "Select Folder", ControlType.Button, invoke);
    await uia(app.pid, "References", ControlType.Tree, () => {});
    const c = await connectPage(port, MAX_WAIT_MS);
    sockets.add(c);
    await until<string | null>(c, "the open repository", switcher, (v) => v === switcherLabel(top(repo)), ACTION_WAIT_MS);
    return { app, c };
  }

  async function end(s: { app: OwnedProcess; c: Cdp }): Promise<void> {
    s.c.close();
    sockets.delete(s.c);
    s.app.stop();
    owned.delete(s.app);
    expect(await waitExit(s.app)).not.toBeNull();
  }

  const toCommitView = (pid: number) => uia(pid, COMMIT_VIEW, ControlType.Button, invoke);

  test.skipIf(reason !== null)(
    "Q11, FR-018, FR-019: Show in Explorer on a nested folder, a non-ASCII folder, and a folder link opens the parent with the item selected; a folder deleted after the status read gives the absent text and no window",
    async () => {
      const f = buildFiles(GIT!, "t060-reveal");
      for (const path of ["deep/nested/inner/f.txt", "é dir/f.txt", "gone/f.txt"]) {
        mkdirSync(join(f.repo, dirname(path)), { recursive: true });
        writeFileSync(join(f.repo, path), `${path}\n`);
      }
      // A junction needs no privilege, so it is the folder link of every host.
      symlinkSync(String(f.notes.outside), join(f.repo, "linkdir"), "junction");
      const s = await session("reveal", f.repo);
      try {
        await toCommitView(s.app.pid);
        const cases: [rowPath: string, parent: string, selected: string][] = [
          ["deep/nested/inner", join(f.repo, "deep", "nested"), join(f.repo, "deep", "nested", "inner")],
          ["é dir", f.repo, join(f.repo, "é dir")],
          ["linkdir", f.repo, join(f.repo, "linkdir")],
        ];
        for (const [rowPath, parent, selected] of cases) {
          await revealRow(s.c, rowPath);
          const before = explorerWindows();
          await menuAction(s.c, changesRow(rowPath), SHOW_IN_EXPLORER);
          const state = explorerReveal(parent, before);
          if (state.preexisting) console.log(`NOTE ${TASK}: the reveal opened a tab in an existing Explorer window. The test leaves that window open.`);
          // Windows paths ignore case.
          expect({ rowPath, window: state.found, selected: state.selected.map((p) => p.toLowerCase()) }).toEqual({ rowPath, window: true, selected: [selected.toLowerCase()] });
        }
        // The folder goes after the status read, so the reveal finds no entry (contract Δ6 `reveal` reply `absent`).
        await revealRow(s.c, "gone");
        rmSync(join(f.repo, "gone"), { recursive: true });
        const before = explorerWindows();
        await menuAction(s.c, changesRow("gone"), SHOW_IN_EXPLORER);
        await until<boolean>(s.c, "the absent text", `document.body.innerText.includes(${js(absentText("gone"))})`, (v) => v, ACTION_WAIT_MS);
        expect(explorerReveal(f.repo, before).found).toBe(false);
      } finally {
        await end(s);
      }
    },
    caseTimeout(40) + 8 * PROBE_TIMEOUT_MS,
  );

  test.skipIf(reason !== null)(
    "Q12, SC-003, US2 by keyboard: three marked untracked files go to the Recycle Bin after the confirmation with Cancel focused first; each item is in the Recycle Bin, then purged through recycledPath; the index and every other byte stay",
    async () => {
      const f = buildFiles(GIT!, "t060-recycle");
      const files = ["u1.txt", "u2.txt", "u3.txt"];
      const before = workingFileDigests(f.repo);
      const index = readFileSync(join(f.repo, ".git", "index"));
      const s = await session("recycle", f.repo);
      const recycled: string[] = [];
      try {
        expect(await s.c.evaluate<boolean>(HOOK)).toBe(true);
        await toCommitView(s.app.pid);
        await revealRow(s.c, "u1.txt");
        await focusOn(s.c, changesRow("u1.txt"), "u1.txt");
        await press(s.c, "Enter");
        await press(s.c, "ArrowDown", MOD.Shift);
        await press(s.c, "ArrowDown", MOD.Shift);
        const marked = `[...document.querySelectorAll('[data-file-tree=changes] [role=treeitem][aria-selected=true]')].map((e) => e.getAttribute('aria-label'))`;
        expect(await until<string[]>(s.c, "three marked rows", marked, (v) => v.length === 3)).toEqual(files);
        await press(s.c, "Delete");
        await until<boolean>(s.c, "the Delete confirmation", `!!(${dialogWith(recycleTitle(3))})`, (v) => v, ACTION_WAIT_MS);
        expect((await until<Active>(s.c, "the first focus on Cancel", ACTIVE, (a) => a.text === "Cancel")).text).toBe("Cancel");
        expect(await unnamed(s.c, dialogWith(recycleTitle(3)))).toEqual([]);
        expect(focusVisible(await s.c.evaluate(FOCUS_STYLE))).toBe(true);
        await press(s.c, "Tab");
        expect((await until<Active>(s.c, "the focus on the danger button", ACTIVE, (a) => a.text === RECYCLE_BUTTON)).text).toBe(RECYCLE_BUTTON);
        expect(focusVisible(await s.c.evaluate(FOCUS_STYLE))).toBe(true);
        await press(s.c, "Enter");
        const replies = await until<DeleteReply[]>(s.c, "the runWorkbench reply", "window.__t060Replies", (v) => v.length > 0, ACTION_WAIT_MS);
        const reply = replies[0]!;
        for (const e of reply.result?.entries ?? []) if (e.recycledPath !== undefined) recycled.push(e.recycledPath);
        console.log(`DELETE_REPLY ${TASK}: state=${reply.state} outcomes=${js(reply.result?.entries.map((e) => e.outcome))}`);
        expect({ state: reply.state, outcomes: reply.result?.entries.map((e) => e.outcome), paths: recycled.length }).toEqual({ state: "succeeded", outcomes: ["recycled", "recycled", "recycled"], paths: 3 });
        expect(files.map((p) => existsSync(join(f.repo, p)))).toEqual([false, false, false]);
        expect(recycled.map((p) => purge(p).inBin)).toEqual([true, true, true]);
        recycled.length = 0;
        expect(readFileSync(join(f.repo, ".git", "index")).equals(index)).toBe(true);
        expect(workingFileDigests(f.repo)).toEqual(Object.fromEntries(Object.entries(before).filter(([p]) => !files.includes(p))));
      } finally {
        for (const p of recycled) purge(p);
        await end(s);
      }
    },
    caseTimeout(30),
  );

  // Spec FR-028, research.md R16 N2: the warning needs a volume without a Recycle Bin. No probe creates and mounts one without elevation.
  console.log(`SKIP ${TASK} FR-028 N2: missing capability volume-without-recycle-bin (unverified)`);
  test.skip("FR-028, N2: the Windows permanent-delete warning on a volume without a Recycle Bin is owned by the Arbareto window (SKIP: volume-without-recycle-bin)", () => {});

  test.skipIf(reason !== null)(
    "US1 by keyboard: a commit, Changed files, the next file, and its diff; Blame opens with the focus on Back; Alt+Left runs no back navigation; Escape returns to the History list",
    async () => {
      const b = buildHistory(GIT!, "t060-history");
      const s = await session("history", b.repo);
      try {
        const list = `document.querySelector('[data-history-list]')`;
        const activeRow = `document.getElementById(${list}.getAttribute('aria-activedescendant'))?.dataset.rowId ?? null`;
        await focusOn(s.c, list, "the History list");
        await press(s.c, "Home");
        for (let i = 0; i < 20 && (await s.c.evaluate<string | null>(activeRow)) !== b.oids.normal; i++) await press(s.c, "ArrowDown");
        expect(await s.c.evaluate<string | null>(activeRow)).toBe(b.oids.normal!);
        const heading = `document.querySelector('[data-section=changedFiles] h3')?.textContent ?? null`;
        await until<string | null>(s.c, "the Changed files heading", heading, (v) => v === "Changed files (6)", ACTION_WAIT_MS);
        for (let i = 0; i < 6 && (await s.c.evaluate<Active>(ACTIVE)).section !== "changedFiles"; i++) await press(s.c, "F6");
        expect((await s.c.evaluate<Active>(ACTIVE)).section).toBe("changedFiles");
        const header = `document.querySelector('[data-section=historyDiff] [data-slot=diff-header]')?.textContent ?? ''`;
        const first = await until<string>(s.c, "the first diff", header, (v) => v !== "", ACTION_WAIT_MS);
        // Spec FR-007: a move to another file shows its diff at once.
        const tree = `document.querySelector('[data-section=changedFiles] [role=tree]')`;
        await focusOn(s.c, `${tree}.querySelector('[role=treeitem][aria-selected=true]')`, "the selected changed file");
        await press(s.c, "ArrowDown");
        const second = await until<string>(s.c, "the next diff", header, (v) => v !== "" && v !== first, ACTION_WAIT_MS);
        console.log(`DIFF_HEADERS ${TASK}: ${js([first, second])}`);
        expect(await unnamed(s.c, `document.querySelector('[data-section=changedFiles]')`)).toEqual([]);
        // The Blame button of the diff header (plan.md D3) opens the blame view, and Back gets the focus (spec FR-054).
        const blame = `[...document.querySelectorAll('[data-section=historyDiff] button')].find((e) => e.textContent.trim() === 'Blame')`;
        await focusOn(s.c, blame, "Blame");
        await press(s.c, "Enter");
        await until<boolean>(s.c, "the blame view", `!!document.querySelector('[data-slot=blame-view]')`, (v) => v, ACTION_WAIT_MS);
        expect((await until<Active>(s.c, "the focus on Back", ACTIVE, (a) => a.label === "Back")).label).toBe("Back");
        expect(await unnamed(s.c, `document.querySelector('[data-slot=blame-view]')`)).toEqual([]);
        // Plan.md D15 "Blame keys": WebView2 maps Alt+Left to back navigation, so the blame view takes the key. A navigation would drop the page state.
        const mark = crypto.randomUUID();
        const url = await s.c.evaluate<string>(`(window.__t060Mark = ${js(mark)}, location.href)`);
        await press(s.c, "ArrowLeft", MOD.Alt);
        await settle(s.c);
        expect({ mark: await s.c.evaluate<string | null>("window.__t060Mark ?? null"), url: await s.c.evaluate<string>("location.href"), blame: await s.c.evaluate<boolean>(`!!document.querySelector('[data-slot=blame-view]')`) }).toEqual({ mark, url, blame: true });
        // Spec FR-054 and T071: Escape returns to the History list, and the list holds the focus.
        await press(s.c, "Escape");
        await until<boolean>(s.c, "the History list", `!document.querySelector('[data-slot=blame-view]') && document.activeElement === ${list}`, (v) => v, ACTION_WAIT_MS);
      } finally {
        await end(s);
      }
    },
    caseTimeout(30),
  );

  test.skipIf(reason !== null)(
    "US5 by keyboard: Add to .gitignore opens the editor with the line selected, and Ctrl+S saves those bytes; with unsaved text, Escape keeps the discard dialog open (T067), and Discard closes the editor without a save",
    async () => {
      const f = buildFiles(GIT!, "t060-ignore");
      const target = join(f.repo, ".gitignore");
      const s = await session("ignore", f.repo);
      try {
        await toCommitView(s.app.pid);
        await revealRow(s.c, "u1.txt");
        await menuAction(s.c, changesRow("u1.txt"), ADD_TO_GITIGNORE);
        const field = `document.querySelector('[data-slot=ignore-editor] textarea')`;
        const editor = await until<{ value: string; selected: string } | null>(
          s.c,
          "the editor with the selected line",
          `document.activeElement === ${field} ? { value: ${field}.value, selected: ${field}.value.slice(${field}.selectionStart, ${field}.selectionEnd) } : null`,
          (v) => v !== null && v.selected === "/u1.txt",
          ACTION_WAIT_MS,
        );
        expect(await unnamed(s.c, `document.querySelector('[data-slot=ignore-editor]')`)).toEqual([]);
        // The file has LF line ends, so Save writes the editor text as it stands (plan.md D10).
        const saved = editor!.value;
        await press(s.c, "s", MOD.Ctrl);
        await until<boolean>(s.c, "the save", "true", () => existsSync(target) && readFileSync(target, "utf8") === saved, ACTION_WAIT_MS);
        // T067: with unsaved text, the Escape that mounts the discard modal must not close it.
        await s.c.send("Input.insertText", { text: "# t060\n" });
        await press(s.c, "Escape");
        await settle(s.c);
        expect(await s.c.evaluate<boolean>(`!!(${dialogWith(DISCARD_TITLE)})`)).toBe(true);
        for (let i = 0; i < 3 && (await s.c.evaluate<Active>(ACTIVE)).text !== DISCARD; i++) await press(s.c, "Tab");
        expect((await s.c.evaluate<Active>(ACTIVE)).text).toBe(DISCARD);
        await press(s.c, "Enter");
        await until<boolean>(s.c, "the closed editor", `!${field}`, (v) => v, ACTION_WAIT_MS);
        expect(readFileSync(target, "utf8")).toBe(saved);
      } finally {
        await end(s);
      }
    },
    caseTimeout(30),
  );

  test.skipIf(reason !== null)(
    "SC-010: the row menu and the Delete confirmation have names, visible focus, and a text contrast of at least 4.5:1 in Dark, Light, and forced colors, also for the danger items",
    async () => {
      const f = buildFiles(GIT!, "t060-contrast");
      const s = await session("contrast", f.repo);
      try {
        await toCommitView(s.app.pid);
        await revealRow(s.c, "u1.txt");
        await focusOn(s.c, changesRow("u1.txt"), "u1.txt");
        await press(s.c, "F10", MOD.Shift);
        await until<boolean>(s.c, "the row menu", `!!(${menuItem(DELETE_ITEM)})`, (v) => v);
        expect(await unnamed(s.c, `document.querySelector('[role=menu]')`)).toEqual([]);
        expect(focusVisible(await s.c.evaluate(FOCUS_STYLE))).toBe(true);
        const label = (item: string) => `(${menuItem(item)})?.querySelector('[data-slot=menu-label]')`;
        for (const scheme of ["dark", "light", "forced"] as const) {
          await emulate(s.c, scheme);
          await contrast(s.c, scheme, [
            ["menu item Show in Explorer", label(SHOW_IN_EXPLORER)],
            ["danger item Delete…", label(DELETE_ITEM)],
            ["danger item Delete permanently…", label(DELETE_PERMANENTLY_ITEM)],
          ]);
        }
        await emulate(s.c, "dark");
        await press(s.c, "Escape");
        await until<boolean>(s.c, "the closed menu", `!document.querySelector('[role=menu]')`, (v) => v);
        await focusOn(s.c, changesRow("u1.txt"), "u1.txt");
        await press(s.c, "Delete");
        const dialog = dialogWith("Move 1 file to the Recycle Bin?");
        await until<boolean>(s.c, "the Delete confirmation", `!!(${dialog})`, (v) => v, ACTION_WAIT_MS);
        const button = (text: string) => `[...(${dialog}).querySelectorAll('button')].find((b) => b.textContent.trim() === ${js(text)})`;
        for (const scheme of ["dark", "light", "forced"] as const) {
          await emulate(s.c, scheme);
          await contrast(s.c, scheme, [
            ["dialog title", `(${dialog}).querySelector('h2')`],
            ["Cancel button", button("Cancel")],
            ["danger button", button(RECYCLE_BUTTON)],
          ]);
        }
        await s.c.send("Emulation.setEmulatedMedia", { features: [] });
        await press(s.c, "Escape");
        await until<boolean>(s.c, "the closed confirmation", `!(${dialog})`, (v) => v);
        expect(existsSync(join(f.repo, "u1.txt"))).toBe(true);
      } finally {
        await end(s);
      }
    },
    caseTimeout(30),
  );

  test.skipIf(reason !== null)(
    "SC-007, FR-051: Open submodule and Open parent repository each take at most the time of a normal open of that repository through Open folder",
    async () => {
      const w = buildSubmodules(GIT!, "t060-submodule");
      const sub = join(w.sup, "solo");
      const s = await session("submodule", w.sup);
      // A normal open: Repository ▸ Open folder…, the folder picker, and the first read. The picker runs by UIA patterns without human time,
      // so it is the fastest normal open that a user can make.
      async function normalOpen(repo: string): Promise<number> {
        const start = performance.now();
        await uia(s.app.pid, REPOSITORY, ControlType.MenuItem, expand);
        await uia(s.app.pid, OPEN_FOLDER_ITEM, ControlType.MenuItem, invoke);
        await uia(s.app.pid, "Folder:", ControlType.Edit, (field) => setValue(field, repo));
        await uia(s.app.pid, "Select Folder", ControlType.Button, invoke);
        await until<string | null>(s.c, `the open ${repo}`, switcher, (v) => v === switcherLabel(top(repo)), ACTION_WAIT_MS);
        return performance.now() - start;
      }
      async function keyOpen(target: string, expression: string, repo: string): Promise<number> {
        await focusOn(s.c, expression, target);
        const start = performance.now();
        await press(s.c, "Enter");
        await until<string | null>(s.c, `the open ${repo}`, switcher, (v) => v === switcherLabel(top(repo)), ACTION_WAIT_MS);
        return performance.now() - start;
      }
      const times = { normalParent: [] as number[], submodule: [] as number[], parentButton: [] as number[], normalSubmodule: [] as number[] };
      try {
        // Each open changes the open repository, so the switcher label marks its end. The session starts on the parent.
        for (let i = 0; i < OPEN_RUNS; i++) {
          times.submodule.push(await keyOpen("the Submodules row solo", `document.querySelector('[data-slot=submodules-group] [role=treeitem][data-path="solo"]')`, sub));
          times.parentButton.push(await keyOpen("the parent button", `document.querySelector('[data-slot=parent-button]')`, w.sup));
          times.normalSubmodule.push(await normalOpen(sub));
          times.normalParent.push(await normalOpen(w.sup));
        }
        const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]!;
        const report = Object.fromEntries(Object.entries(times).map(([k, v]) => [k, { runs: v.map((ms) => Math.round(ms)), median: Math.round(median(v)) }]));
        console.log(`OBSERVATION ${TASK}: SC-007 open times in ms ${js(report)}`);
        expect({ submodule: median(times.submodule) <= median(times.normalSubmodule), parent: median(times.parentButton) <= median(times.normalParent) }).toEqual({ submodule: true, parent: true });
      } finally {
        await end(s);
      }
    },
    caseTimeout(30 * OPEN_RUNS),
  );
});
