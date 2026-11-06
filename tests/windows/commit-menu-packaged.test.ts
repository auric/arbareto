// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 010 T017: the History commit menu in the installed package. Spec FR-010, FR-014, FR-020, FR-044, SC-009; research.md R5 U2. `Local: package`.
// The cases drive the page through the WebView2 CDP endpoint and UI Automation patterns. They send no OS input and never move the pointer.
// A right-click is the UIA ShowContextMenu call, which Chromium sends to the page as a `contextmenu` event (uia.ts `showContextMenu`).
// Dark and Light are the System theme under the CDP `prefers-color-scheme` emulation. Forced colors is the CDP `forced-colors` emulation, not a Windows contrast theme.
// Each expected text is a plan.md D11 text. Each expected Git result comes from Git's own command on a copy.
// Control: let `AlertConfirm` focus the danger button first; the Hard Cancel focus case must fail.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { fixtureDir, FIXTURE_ROOT, ownedGit, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { sha256 } from "../git/git-oracle";
import { printOrigin } from "../origin";
import { connectPage, freePort, keyEvents, MOD, watchIpc, type Cdp, type IpcLog } from "./cdp";
import { decodePng, formatMeasurement, measure, THRESHOLD } from "./contrast";
import { appEnv, descendants, findInstalledApp, HISTORY_VIEW, powershellJson, PROBE_TIMEOUT_MS, processRecords, startInstalledApp, WAIT_MS, waitExit, type OwnedProcess } from "./installed-app";
import { close, ControlType, find, findAll, foregroundSkip, hasKeyboardFocus, invoke, MAX_CALL_MS, MAX_WAIT_MS, setValue, showContextMenu, waitFocus, type Element } from "./uia";

for (const helper of ["./cdp.ts", "./uia.ts", "./installed-app.ts", "./contrast.ts"]) printOrigin(helper, import.meta.dir);
// The package under test holds these sources. The `ORIGIN` line of `findInstalledApp` names the installed binary and its SHA-256.
for (const source of ["../../src/frontend/history/CommitActions.tsx", "../../src/frontend/history/commit-texts.ts", "../../src/frontend/history/HistoryList.tsx", "../../src/frontend/changes/RevertConfirm.tsx", "../../src/frontend/branches/BranchActions.tsx"]) printOrigin(source, import.meta.dir);

const TASK = "T017";
const STEP_MS = MAX_WAIT_MS + MAX_CALL_MS;
const caseTimeout = (steps: number) => steps * STEP_MS + 2 * PROBE_TIMEOUT_MS + 2 * WAIT_MS;
const KEY_WAIT_MS = 10_000;
// A review, a run, and its reconcile reads.
const ACTION_WAIT_MS = 30_000;
// One keyboard walk ends after this many presses.
const WALK = 40;
// Spec FR-014 and SC-009: the Windows text sizes of the check.
const SCALES = [150, 225] as const;

// ---- App texts (plan.md D11, src/frontend/history/commit-texts.ts) ----

const OPEN_FOLDER = "Open folder… (Ctrl+O)";
// src/frontend/status/OperationStatus.tsx `shortId`: the first 12 hex digits.
const short = (oid: string) => oid.slice(0, 12);
const MENU_NAME = (oid: string) => `Actions for commit ${short(oid)}`;
const ITEM_CHECKOUT = "Check out this commit (detached HEAD)…";
const ITEM_BRANCH = "Create branch here…";
const ITEM_TAG = "Create tag here…";
const ITEM_PICK = "Cherry-pick commit…";
const ITEM_REVERT = "Revert commit…";
const ITEM_RESET = "Reset current branch (main) to here…";
const ITEM_COPY = "Copy commit ID";
const GROUPS = [[ITEM_CHECKOUT, ITEM_BRANCH, ITEM_TAG], [ITEM_PICK, ITEM_REVERT], [ITEM_RESET], [ITEM_COPY]];
const CHECKOUT_TITLE = (oid: string) => `Check out commit ${short(oid)}?`;
const CHECKOUT_BUTTON = "Check out";
const CHECKOUT_DONE = (oid: string) => `Checked out ${short(oid)}. HEAD is detached.`;
const TAG_TITLE = (oid: string) => `Create tag at ${short(oid)}`;
const TAG_BUTTON = "Create tag";
const TAG_DONE = (name: string, oid: string) => `Created tag ${name} at ${short(oid)}. Arbareto does not push tags.`;
const RESET_TITLE = (oid: string) => `Reset main to ${short(oid)}?`;
const RESET_BUTTON = "Reset";
const HARD_BUTTON = "Reset hard…";
const HARD_TITLE = (oid: string) => `Reset main hard to ${short(oid)}?`;
const HARD_CONFIRM = "Reset hard";
const RESET_DONE = (oid: string) => `Reset main to ${short(oid)}.`;
const PICK_TITLE = (oid: string) => `Cherry-pick ${short(oid)} to main?`;
const PICK_BUTTON = "Cherry-pick";
const PICK_DONE = (oid: string) => `Cherry-picked ${short(oid)} to main.`;
// src/frontend/changes/revert-text.ts `NO_UNDO`.
const NO_UNDO = "You cannot undo this.";

// ---- CDP keys ----

async function press(c: Cdp, name: string, modifiers = 0): Promise<void> {
  for (const params of keyEvents(name, modifiers, { typed: true })) await c.send("Input.dispatchKeyEvent", params);
  console.log(`KEY ${TASK}: ${name} mods=${modifiers}`);
}

const js = (value: unknown) => JSON.stringify(value);
async function until<T>(c: Cdp, what: string, expression: string, done: (value: T) => boolean, ms = KEY_WAIT_MS): Promise<T> {
  const value = await c.poll<T>(expression, done, ms);
  if (!done(value)) throw new Error(`${what} did not happen within ${ms} ms: ${js(value)} ${js(await c.evaluate<unknown>(FACTS).catch((e) => String(e)))}`);
  return value;
}
// The page waits for the end of every running animation, then for one frame. A closed Base UI popup stays in the DOM until its exit animation ends.
const settle = (c: Cdp) => c.evaluate(`Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))).then(() => new Promise((done) => requestAnimationFrame(() => done(true))))`);

const open = (selector: string) => `[...document.querySelectorAll(${js(selector)})].filter((e) => !e.hasAttribute('data-closed') && !e.hasAttribute('data-ending-style'))`;
const MENU = `${open("[role=menu]")}[0]`;
const popover = (title: string) => `${open("[data-slot=popover-content]")}.find((p) => p.textContent.includes(${js(title)}))`;
const dialogWith = (title: string) => `${open("[role=alertdialog],[role=dialog]")}.find((d) => d.textContent.includes(${js(title)}))`;
const nothingOpen = `${open("[role=menu]")}.length === 0 && ${open("[data-slot=popover-content]")}.length === 0 && ${open("[role=alertdialog],[role=dialog]")}.length === 0`;
const enabledButton = (scope: string, text: string) => `[...((${scope})?.querySelectorAll('button') ?? [])].some((b) => b.textContent.trim() === ${js(text)} && !b.disabled && b.getAttribute('aria-disabled') !== 'true')`;
const buttonIn = (scope: string, text: string) => `[...((${scope})?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === ${js(text)})`;
const reviewed = (title: string, button: string) => `!!(${popover(title)}) && (!!(${popover(title)}).querySelector('[role=alert]') || ${enabledButton(popover(title), button)})`;
const menuItem = (label: string) => `[...((${MENU})?.querySelectorAll('[role=menuitem]') ?? [])].find((i) => i.querySelector('[data-slot=menu-label]')?.textContent === ${js(label)})`;
const list = `document.querySelector('[data-history-list]')`;
const selectedRow = `(document.querySelector('[data-history-list] [role=option][aria-selected=true]')?.dataset.rowId ?? null)`;
const headRow = `(document.querySelector('[data-history-list] [role=option] .badge')?.closest('[role=option]')?.dataset.rowId ?? null)`;
const rowById = (oid: string) => `document.querySelector('[data-history-list] [role=option][data-row-id="${oid}"]')`;
// OperationStatus.tsx footer: the workbench notice cell (the 004 switch outcome) and the operation line (every other outcome) are `role=status` cells.
const statusTexts = `[...(document.querySelector('[data-slot=status-region] footer')?.querySelectorAll('[role=status]') ?? [])].map((e) => e.textContent.trim())`;
const GROUP_LABELS = `[...((${MENU})?.querySelectorAll('[data-slot=dropdown-menu-group]') ?? [])].map((g) => [...g.querySelectorAll('[role=menuitem]')].map((i) => i.querySelector('[data-slot=menu-label]')?.textContent ?? null))`;
// Every item has its icon (plan.md D1).
const ICONS = `[...((${MENU})?.querySelectorAll('[role=menuitem]') ?? [])].map((i) => !!i.querySelector('[data-slot=menu-icon] svg'))`;
const inside = `const inside = (b) => b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight;`;

const FACTS = `(() => {
  const text = (e) => (e?.textContent ?? '').trim().slice(0, 300);
  const a = document.activeElement;
  return {
    active: a === null ? null : (a.getAttribute('aria-label') ?? a.tagName + ' ' + text(a).slice(0, 60)),
    status: text(document.querySelector('[data-slot=status-region] footer')),
    menus: [...document.querySelectorAll('[role=menu]')].map((m) => m.getAttribute('aria-label') + ': ' + text(m)),
    popovers: [...document.querySelectorAll('[data-slot=popover-content]')].map(text),
    dialogs: [...document.querySelectorAll('[role=alertdialog],[role=dialog]')].map(text),
    selected: ${selectedRow},
    head: ${headRow},
  };
})()`;

async function focusOn(c: Cdp, expression: string, what: string): Promise<void> {
  await until<boolean>(c, `${what} shows`, `!!(${expression})`, (v) => v);
  await c.evaluate(`(${expression}).focus(); true`);
  await until<boolean>(c, `${what} has focus`, `document.activeElement === (${expression})`, (v) => v);
}

// ---- Accessibility, focus, and contrast through CDP (SC-009) ----

const NAMED_ROLES = ["button", "menuitem", "radio", "textbox"];
async function unnamed(c: Cdp, root: string): Promise<string[]> {
  await c.send("Accessibility.enable");
  const handle = (await c.send("Runtime.evaluate", { expression: root, returnByValue: false })) as { result: { objectId?: string } };
  const objectId = handle.result.objectId;
  if (objectId === undefined) throw new Error(`no element for ${root}`);
  const missing: string[] = [];
  for (const role of NAMED_ROLES) {
    const { nodes } = (await c.send("Accessibility.queryAXTree", { objectId, role })) as { nodes: { name?: { value?: string }; ignored?: boolean }[] };
    for (const node of nodes) if (!node.ignored && (node.name?.value ?? "").trim() === "") missing.push(role);
  }
  return missing;
}

const FOCUS_STYLE = `(() => { const s = getComputedStyle(document.activeElement); return { outline: s.outlineStyle, width: s.outlineWidth, shadow: s.boxShadow }; })()`;
const focusVisible = (s: { outline: string; width: string; shadow: string }) => (s.outline !== "none" && Number.parseFloat(s.width) > 0) || s.shadow !== "none";

type Scheme = "dark" | "light" | "forced";
async function emulate(c: Cdp, scheme: Scheme): Promise<void> {
  const features = scheme === "forced" ? [{ name: "forced-colors", value: "active" }] : [{ name: "prefers-color-scheme", value: scheme }, { name: "forced-colors", value: "none" }];
  await c.send("Emulation.setEmulatedMedia", { features });
  await settle(c);
}

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

// Microsoft Learn "Make text bigger": HKCU\Software\Microsoft\Accessibility `TextScaleFactor` (DWORD, 100 to 225). An absent value is 100.
const textScale = () => (powershellJson(`$v = (Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Accessibility' -Name TextScaleFactor -ErrorAction SilentlyContinue).TextScaleFactor
ConvertTo-Json -Compress -InputObject $(if ($null -eq $v) { 100 } else { [int]$v })`) as number);

// ---- UI Automation focus on Cancel (the 008 T047 method) ----

// GetFocusedElement gives the system focus, which exists only in the foreground window. An agent session never owns the foreground.
// Chromium `AXPlatformNodeWin` sets HasKeyboardFocus on the element with the DOM focus, with no window focus check.
async function uiaFocusOnCancel(processId: number, what: string, other: string): Promise<void> {
  const foreground = foregroundSkip(processId);
  if (foreground === null) {
    await waitFocus(processId, "Cancel", MAX_WAIT_MS);
    return;
  }
  const left = (end: number) => Math.max(0, Math.min(MAX_WAIT_MS, Math.ceil(end - performance.now())));
  let seen: unknown = null;
  for (const end = performance.now() + MAX_WAIT_MS; ; await Bun.sleep(50)) {
    const buttons: Element[] = [];
    try {
      buttons.push(...(await findAll(processId, "Cancel", left(end), ControlType.Button)));
      buttons.push(...(await findAll(processId, other, left(end), ControlType.Button)));
      const count = { cancel: buttons.filter((b) => b.name === "Cancel").length, other: buttons.filter((b) => b.name === other).length };
      if (count.cancel !== 1 || count.other !== 1) throw new Error(`${what}: the confirmation needs one Cancel and one ${js(other)} button; process ${processId} has ${js(count)}`);
      seen = buttons.map((b) => ({ name: b.name, hasKeyboardFocus: hasKeyboardFocus(b) }));
      if (js(seen) === js([{ name: "Cancel", hasKeyboardFocus: true }, { name: other, hasKeyboardFocus: false }])) break;
    } finally {
      for (const b of buttons) b.release();
    }
    if (performance.now() >= end) throw new Error(`${what}: no UIA HasKeyboardFocus on Cancel alone after ${MAX_WAIT_MS} ms: ${js(seen)}`);
  }
  console.log(`OBSERVATION ${TASK}: ${what}: UIA HasKeyboardFocus on Cancel (provider focus, the DOM focus source); system focus unverified: ${foreground}`);
}

describe.skipIf(process.platform !== "win32")("T017 packaged commit menu", () => {
  // Bun 1.4.4 runs `afterAll` hooks in declaration order. This hook must come before the fixture root removal.
  const owned = new Set<OwnedProcess>();
  const sockets = new Set<Cdp>();
  // Each case ends its own app, also after a failure, so the next start finds no other instance.
  const stopOwned = async () => {
    for (const c of sockets) c.close();
    sockets.clear();
    for (const app of owned) {
      owned.delete(app);
      app.stop();
      if ((await waitExit(app)) === null) throw new Error(`the app PID ${app.pid} did not exit within ${WAIT_MS} ms of the end`);
    }
  };
  afterEach(stopOwned, 2 * WAIT_MS + PROBE_TIMEOUT_MS);
  afterAll(async () => {
    await stopOwned();
    close();
  }, 2 * WAIT_MS + PROBE_TIMEOUT_MS);
  useFixtureRoot();

  const discovery = findInstalledApp();
  const installed = "app" in discovery ? discovery.app : null;
  if (installed !== null) console.log(`APP ${TASK}: exe=${installed.exe} sha256=${installed.sha256}`);
  const others = installed === null ? [] : processRecords().filter((r) => r.name.toLowerCase() === installed.mainBinaryName.toLowerCase());
  const reason =
    installed === null ? (discovery as { skip: string }).skip : GIT === null ? "Git executable absent" : others.length > 0 ? `another-instance: ${installed.mainBinaryName} runs as PID ${others.map((r) => r.pid).join(", ")}` : null;
  if (reason !== null) console.log(`SKIP installed app: ${reason}`);

  const g = (repo: string, args: string[], allowExit = [0], env: Record<string, string> = {}) => ownedGit(GIT!, FIXTURE_ROOT, repo, args, { allowExit, env }).toString("utf8");
  const rev = (repo: string, name: string) => g(repo, ["rev-parse", "--verify", "--end-of-options", `${name}^{commit}`]).trim();
  // The Git facts that a run changes: HEAD, its symbolic ref, the refs, the index, and the working bytes of the fixture files.
  const FILES = ["a.txt", "b.txt", "t.txt", "u.txt"];
  const state = (repo: string) => ({
    head: rev(repo, "HEAD"),
    symbolic: g(repo, ["symbolic-ref", "-q", "HEAD"], [0, 1]).trim(),
    refs: g(repo, ["for-each-ref", "--format=%(objectname) %(refname)"]),
    index: g(repo, ["ls-files", "-s", "-z"]),
    files: Object.fromEntries(FILES.map((p) => [p, (() => { try { return sha256(readFileSync(join(repo, p))); } catch { return null; } })()])),
  });

  type World = { repo: string; c1: string; c2: string; c3: string; t1: string };
  let builds = 0;
  // main: c1 (a.txt, b.txt) → c2 (a.txt) → c3 (b.txt). topic: t1 (t.txt) on c1. One untracked u.txt. Each commit has its own date.
  function build(name: string): World {
    const repo = join(fixtureDir(`${name}-${++builds}`), "repo");
    mkdirSync(repo, { recursive: true });
    g(repo, ["init", "-q", "-b", "main"]);
    for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"]] as const) g(repo, ["config", key, value]);
    let day = 0;
    const commit = (files: Record<string, string>, message: string) => {
      for (const [path, text] of Object.entries(files)) writeFileSync(join(repo, path), text);
      g(repo, ["add", "--", ...Object.keys(files)]);
      const date = `2026-01-0${++day}T00:00:00+0000`;
      g(repo, ["commit", "-q", "--no-verify", "-m", message], [0], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
      return rev(repo, "HEAD");
    };
    const c1 = commit({ "a.txt": "a1\n", "b.txt": "b1\n" }, "c1");
    const c2 = commit({ "a.txt": "a2\n" }, "c2");
    const c3 = commit({ "b.txt": "b3\n" }, "c3");
    g(repo, ["switch", "-q", "-c", "topic", c1]);
    const t1 = commit({ "t.txt": "t\n" }, "t1");
    g(repo, ["switch", "-q", "main"]);
    writeFileSync(join(repo, "u.txt"), "untracked\n");
    return { repo, c1, c2, c3, t1 };
  }
  // An oracle copy of `w`. A copy gets new stat data, so the refresh restores the stat data of a fresh checkout.
  function oracle(w: World): string {
    const copy = join(fixtureDir(`oracle-${++builds}`), "repo");
    cpSync(w.repo, copy, { recursive: true });
    g(copy, ["update-index", "-q", "--refresh"], [0, 1]);
    return copy;
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

  type Session = { app: OwnedProcess; c: Cdp; ipc: IpcLog; w: World };
  let starts = 0;
  async function session(label: string, w: World): Promise<Session> {
    if (!isAbsolute(w.repo) || relative(FIXTURE_ROOT, w.repo).startsWith("..")) throw new Error(`the repository is outside the fixture root: ${js(w.repo)}`);
    const top = g(w.repo, ["rev-parse", "--show-toplevel"]).trim();
    const env = appEnv(fixtureDir(`${label}-${++starts}-app`), false);
    const port = freePort();
    env.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port}`;
    const app = startInstalledApp(installed!, env);
    owned.add(app);
    console.log(`STARTED ${TASK}: ${app.pid} ${label} port=${port} profile=${env.set.ARBARETO_PROFILE_ROOT}`);
    await uia(app.pid, "Select Git", ControlType.Button, invoke);
    const c = await connectPage(port, MAX_WAIT_MS);
    sockets.add(c);
    const ipc = await watchIpc(c);
    await uia(app.pid, "Use this Git", undefined, invoke);
    await uia(app.pid, OPEN_FOLDER, undefined, invoke);
    await uia(app.pid, "Folder:", ControlType.Edit, (field) => setValue(field, w.repo));
    await uia(app.pid, "Select Folder", ControlType.Button, invoke);
    try {
      await until<string | null>(c, "the open repository", `document.querySelector('button[aria-keyshortcuts="Control+R"]')?.getAttribute('aria-label') ?? null`, (v) => v === `${basename(top)}, ${top}`, ACTION_WAIT_MS);
    } catch (error) {
      for (const r of descendants(app.pid)) console.log(`CHILD ${TASK}: ${r.pid} ${r.name} ${js(r.commandLine?.slice(0, 400) ?? null)}`);
      throw error;
    }
    if (await c.evaluate<boolean>(`document.querySelector('[data-view="history"]')?.hidden !== false`)) await uia(app.pid, HISTORY_VIEW, ControlType.Button, invoke);
    await until<boolean>(c, "the History rows", `document.querySelector('[data-view="history"]')?.hidden === false && ${headRow} === ${js(rev(w.repo, "HEAD"))}`, (v) => v, ACTION_WAIT_MS);
    return { app, c, ipc, w };
  }
  async function end(s: Session): Promise<void> {
    s.c.close();
    sockets.delete(s.c);
    s.app.stop();
    owned.delete(s.app);
    expect(await waitExit(s.app)).not.toBeNull();
  }

  // Selects the row `oid` by keyboard: Home, then Down until it is the selected row.
  async function selectRow(s: Session, oid: string): Promise<void> {
    await focusOn(s.c, list, "the History list");
    await press(s.c, "Home");
    for (let i = 0; i < WALK && (await s.c.evaluate<string | null>(selectedRow)) !== oid; i++) await press(s.c, "ArrowDown");
    await until<string | null>(s.c, `the selected row ${short(oid)}`, selectedRow, (v) => v === oid);
  }
  // Shift+F10 opens the menu with the focus on its first item (spec FR-010). Down moves to `label`.
  async function menuByKey(s: Session, oid: string): Promise<void> {
    await selectRow(s, oid);
    await press(s.c, "F10", MOD.Shift);
    await until<string | null>(s.c, "the commit menu", `(${MENU})?.getAttribute('aria-label') ?? null`, (v) => v === MENU_NAME(oid));
  }
  async function toItem(s: Session, oid: string, label: string): Promise<void> {
    await menuByKey(s, oid);
    for (let i = 0; i < 12 && !(await s.c.evaluate<boolean>(`document.activeElement === (${menuItem(label)})`)); i++) await press(s.c, "ArrowDown");
    await until<boolean>(s.c, `the focus on ${label}`, `document.activeElement === (${menuItem(label)})`, (v) => v);
    await press(s.c, "Enter");
  }
  async function focusButton(s: Session, scope: string, text: string): Promise<void> {
    const button = buttonIn(scope, text);
    await until<boolean>(s.c, `the available ${text} button`, `!!(${button}) && !(${button}).disabled && (${button}).getAttribute('aria-disabled') !== 'true'`, (v) => v, ACTION_WAIT_MS);
    await focusOn(s.c, button, `the ${text} button`);
  }
  // Escape closes the open layer. The focus then returns to the History list (spec FR-010, FR-014).
  async function escapeToList(s: Session): Promise<void> {
    await press(s.c, "Escape");
    await until<boolean>(s.c, "the closed layer and the focus on the list", `${nothingOpen} && document.activeElement === ${list}`, (v) => v);
  }
  // The Reset popover on `oid` with the Hard plan, then the Hard dialog.
  async function hardDialog(s: Session, oid: string): Promise<string> {
    await toItem(s, oid, ITEM_RESET);
    await until<boolean>(s.c, "the Mixed plan", reviewed(RESET_TITLE(oid), RESET_BUTTON), (v) => v, ACTION_WAIT_MS);
    // The Mixed radio has the first focus. Down checks Hard, the next radio of the group.
    await press(s.c, "ArrowDown");
    await until<boolean>(s.c, "the Hard plan", reviewed(RESET_TITLE(oid), HARD_BUTTON), (v) => v, ACTION_WAIT_MS);
    await focusButton(s, popover(RESET_TITLE(oid)), HARD_BUTTON);
    await press(s.c, "Enter");
    const dialog = dialogWith(HARD_TITLE(oid));
    await until<boolean>(s.c, "the Hard dialog", `!!(${dialog})`, (v) => v);
    return dialog;
  }
  async function outcome(s: Session, text: string): Promise<void> {
    await until<string[]>(s.c, `the outcome ${text}`, statusTexts, (v) => v.includes(text), ACTION_WAIT_MS);
  }

  // ---- FR-010, FR-014, U2: the menu, its names, its keys, and its place ----

  test.skipIf(reason !== null)(
    "FR-010, FR-014, U2: Shift+F10 and a right-click open the menu named MENU_NAME beside the full-width row and inside the window; UIA names of the menu and its items; the first item has the focus; Escape returns the focus to the list",
    async () => {
      const w = build("t017-menu");
      const s = await session("menu", w);
      try {
        const place = async (path: string) => {
          await settle(s.c);
          const geometry = await s.c.evaluate<{ menu: { left: number; right: number; top: number; bottom: number }; window: { width: number; height: number }; inside: boolean; items: { label: string | null; inside: boolean }[] }>(
            `(() => { ${inside} const m = ${MENU}; const b = m.getBoundingClientRect(); return { menu: { left: b.left, right: b.right, top: b.top, bottom: b.bottom }, window: { width: innerWidth, height: innerHeight }, inside: inside(b), items: [...m.querySelectorAll('[role=menuitem]')].map((i) => ({ label: i.querySelector('[data-slot=menu-label]')?.textContent ?? null, inside: inside(i.getBoundingClientRect()) })) }; })()`,
          );
          console.log(`GEOMETRY ${TASK}: ${path} ${js(geometry)}`);
          expect({ path, inside: geometry.inside, outside: geometry.items.filter((i) => !i.inside).map((i) => i.label) }).toEqual({ path, inside: true, outside: [] });
        };
        const names = async (oid: string, path: string) => {
          await uia(s.app.pid, MENU_NAME(oid), undefined, () => {});
          for (const label of GROUPS.flat()) await uia(s.app.pid, label, ControlType.MenuItem, () => {});
          expect({ path, groups: await s.c.evaluate<string[][]>(GROUP_LABELS), icons: await s.c.evaluate<boolean[]>(ICONS), unnamed: await unnamed(s.c, MENU) }).toEqual({ path, groups: GROUPS, icons: GROUPS.flat().map(() => true), unnamed: [] });
        };
        // Shift+F10: the focus goes to the first item (spec FR-010).
        await menuByKey(s, w.c2);
        await until<boolean>(s.c, "the focus on the first item", `document.activeElement === (${menuItem(ITEM_CHECKOUT)})`, (v) => v);
        await names(w.c2, "Shift+F10");
        await place("Shift+F10");
        await escapeToList(s);
        // A right-click selects the row as a click does, then opens the menu at it.
        const name = (await s.c.evaluate<string | null>(`(${rowById(w.c1)})?.getAttribute('aria-label') ?? null`))!;
        await uia(s.app.pid, name, undefined, (row) => expect(showContextMenu(row)).toBe(0));
        await until<string | null>(s.c, "the right-click menu", `(${MENU})?.getAttribute('aria-label') ?? null`, (v) => v === MENU_NAME(w.c1));
        expect(await s.c.evaluate<string | null>(selectedRow)).toBe(w.c1);
        await names(w.c1, "right-click");
        await place("right-click");
        await escapeToList(s);
        expect(await s.c.evaluate<string | null>(selectedRow)).toBe(w.c1);
      } finally {
        await end(s);
      }
    },
    caseTimeout(40),
  );

  // ---- FR-044: the Hard dialog ----

  test.skipIf(reason !== null)(
    "FR-044: the Hard dialog gives Cancel the first focus (UIA HasKeyboardFocus), has no default button, states NO_UNDO, and Escape changes nothing",
    async () => {
      const w = build("t017-hard-focus");
      writeFileSync(join(w.repo, "a.txt"), "changed\n");
      const before = state(w.repo);
      const s = await session("hard-focus", w);
      try {
        const dialog = await hardDialog(s, w.c1);
        await until<string | null>(s.c, "the DOM focus on Cancel", `(document.activeElement?.closest('[role=alertdialog]') ? document.activeElement.textContent.trim() : null)`, (v) => v === "Cancel");
        await uiaFocusOnCancel(s.app.pid, "Hard dialog", HARD_CONFIRM);
        // No default button: no submit button and no form, so only the focused button reacts to Enter.
        expect(await s.c.evaluate<{ submit: number; forms: number; noUndo: boolean }>(`(() => { const d = ${dialog}; return { submit: d.querySelectorAll('button[type=submit],input[type=submit]').length, forms: d.querySelectorAll('form').length, noUndo: d.textContent.includes(${js(NO_UNDO)}) }; })()`)).toEqual({ submit: 0, forms: 0, noUndo: true });
        await escapeToList(s);
        expect(state(w.repo)).toEqual(before);
      } finally {
        await end(s);
      }
    },
    caseTimeout(30),
  );

  // ---- FR-020: the Check out confirmation ----

  test.skipIf(reason !== null)(
    "FR-020: the Check out confirmation gives Cancel the first focus (UIA HasKeyboardFocus), and Escape changes nothing",
    async () => {
      const w = build("t017-checkout-focus");
      const before = state(w.repo);
      const s = await session("checkout-focus", w);
      try {
        await toItem(s, w.c2, ITEM_CHECKOUT);
        await until<boolean>(s.c, "the checkout plan", reviewed(CHECKOUT_TITLE(w.c2), CHECKOUT_BUTTON), (v) => v, ACTION_WAIT_MS);
        await until<string | null>(s.c, "the DOM focus on Cancel", `(document.activeElement?.closest('[data-slot=popover-content]') ? document.activeElement.textContent.trim() : null)`, (v) => v === "Cancel");
        await uiaFocusOnCancel(s.app.pid, "Check out confirmation", CHECKOUT_BUTTON);
        await escapeToList(s);
        expect(state(w.repo)).toEqual(before);
      } finally {
        await end(s);
      }
    },
    caseTimeout(30),
  );

  // ---- SC-009: themes and forced colors ----

  test.skipIf(reason !== null)(
    "SC-009: in Dark, Light, and forced colors the commit menu and the Hard dialog keep named controls, visible focus, and texts at 4.5:1; the danger button keeps a border in forced colors",
    async () => {
      const w = build("t017-themes");
      const before = state(w.repo);
      const s = await session("themes", w);
      try {
        await menuByKey(s, w.c2);
        const label = (item: string) => `(${menuItem(item)})?.querySelector('[data-slot=menu-label]')`;
        for (const scheme of ["dark", "light", "forced"] as const) {
          await emulate(s.c, scheme);
          expect({ scheme, unnamed: await unnamed(s.c, MENU) }).toEqual({ scheme, unnamed: [] });
          expect({ scheme, focus: focusVisible(await s.c.poll(FOCUS_STYLE, focusVisible, KEY_WAIT_MS)) }).toEqual({ scheme, focus: true });
          await contrast(s.c, scheme, GROUPS.flat().map((item) => [`menu item ${item}`, label(item)] as [string, string]));
        }
        await emulate(s.c, "dark");
        await escapeToList(s);
        const dialog = await hardDialog(s, w.c1);
        const danger = buttonIn(dialog, HARD_CONFIRM);
        for (const scheme of ["dark", "light", "forced"] as const) {
          await emulate(s.c, scheme);
          expect({ scheme, unnamed: await unnamed(s.c, dialog) }).toEqual({ scheme, unnamed: [] });
          const cancelFocus = await s.c.poll<{ outline: string; width: string; shadow: string }>(FOCUS_STYLE, focusVisible, KEY_WAIT_MS);
          await contrast(s.c, scheme, [
            ["title", `(${dialog}).querySelector('[data-slot=dialog-title]')`],
            ["no-undo", `[...(${dialog}).querySelectorAll('span')].find((e) => e.textContent === ${js(NO_UNDO)})`],
            ["cancel", buttonIn(dialog, "Cancel")],
            ["danger", danger],
          ]);
          if (scheme === "forced") {
            const border = await s.c.evaluate<{ style: string; width: number }>(`(() => { const st = getComputedStyle(${danger}); return { style: st.borderTopStyle, width: Number.parseFloat(st.borderTopWidth) }; })()`);
            expect({ style: border.style !== "none", width: border.width > 0 }).toEqual({ style: true, width: true });
          }
          await focusOn(s.c, danger, "the danger button");
          const dangerFocus = await s.c.poll<{ outline: string; width: string; shadow: string }>(FOCUS_STYLE, focusVisible, KEY_WAIT_MS);
          expect({ scheme, cancel: focusVisible(cancelFocus), danger: focusVisible(dangerFocus) }).toEqual({ scheme, cancel: true, danger: true });
          await focusOn(s.c, buttonIn(dialog, "Cancel"), "Cancel");
        }
        await emulate(s.c, "dark");
        await escapeToList(s);
        expect(state(w.repo)).toEqual(before);
      } finally {
        await end(s);
      }
    },
    caseTimeout(50),
  );

  // Spec SC-009: the text size is a user setting, so the case runs at the current size only.
  const scale = process.platform === "win32" && reason === null ? textScale() : null;
  if (scale !== null) console.log(`OBSERVATION ${TASK}: text scale ${scale}%`);
  for (const size of SCALES) {
    const scaleReason = reason ?? (scale === size ? null : `missing capability text-scale-${size}: the current text size is ${scale}% (set Settings > Accessibility > Text size to ${size}% and run again)`);
    if (scaleReason !== null && reason === null) console.log(`SKIP ${TASK} text scale ${size}%: ${scaleReason} (unverified)`);
    test.skipIf(scaleReason !== null)(
      `SC-009 at text size ${size}%: the commit menu, the Reset popover, and the Hard dialog lie inside the window with no horizontal overflow`,
      async () => {
        const w = build(`t017-scale-${size}`);
        const s = await session(`scale-${size}`, w);
        try {
          const box = async (what: string, expression: string) => {
            await settle(s.c);
            const r = await s.c.evaluate<{ inside: boolean; overflow: boolean }>(`(() => { ${inside} const e = ${expression}; return { inside: inside(e.getBoundingClientRect()), overflow: e.scrollWidth > e.clientWidth }; })()`);
            console.log(`GEOMETRY ${TASK}: ${size}% ${what} ${js(r)}`);
            expect({ what, ...r }).toEqual({ what, inside: true, overflow: false });
          };
          await menuByKey(s, w.c1);
          await box("menu", MENU);
          await escapeToList(s);
          const dialog = await hardDialog(s, w.c1);
          await box("Hard dialog", dialog);
          await escapeToList(s);
          await toItem(s, w.c1, ITEM_RESET);
          await until<boolean>(s.c, "the Mixed plan", reviewed(RESET_TITLE(w.c1), RESET_BUTTON), (v) => v, ACTION_WAIT_MS);
          await box("Reset popover", popover(RESET_TITLE(w.c1)));
          await escapeToList(s);
        } finally {
          await end(s);
        }
      },
      caseTimeout(40),
    );
  }

  // ---- Real Git results, one action of each story (US1 to US4) ----

  test.skipIf(reason !== null)(
    "US1 to US4 by keyboard: the detached checkout, Create tag, Hard reset, and Cherry-pick each give the state of Git's own command on a copy",
    async () => {
      const w = build("t017-git");
      const s = await session("git", w);
      try {
        // US1: Check out c2 (detached HEAD). Oracle: git switch --detach.
        let copy = oracle(w);
        g(copy, ["switch", "-q", "--detach", w.c2]);
        await toItem(s, w.c2, ITEM_CHECKOUT);
        await focusButton(s, popover(CHECKOUT_TITLE(w.c2)), CHECKOUT_BUTTON);
        await press(s.c, "Enter");
        await outcome(s, CHECKOUT_DONE(w.c2));
        expect(state(w.repo)).toEqual(state(copy));
        g(w.repo, ["switch", "-q", "main"]);
        await press(s.c, "F5");
        await until<string | null>(s.c, "the HEAD row c3", headRow, (v) => v === w.c3, ACTION_WAIT_MS);
        // US2: a lightweight tag at c1. Oracle: git tag.
        copy = oracle(w);
        g(copy, ["tag", "t017-tag", w.c1]);
        await toItem(s, w.c1, ITEM_TAG);
        const field = `(${popover(TAG_TITLE(w.c1))})?.querySelector('input')`;
        await until<boolean>(s.c, "the tag name field", `document.activeElement === ${field}`, (v) => v);
        await s.c.send("Input.insertText", { text: "t017-tag" });
        await focusButton(s, popover(TAG_TITLE(w.c1)), TAG_BUTTON);
        await press(s.c, "Enter");
        await outcome(s, TAG_DONE("t017-tag", w.c1));
        expect(state(w.repo)).toEqual(state(copy));
        // US3: Hard reset to c1 with a changed tracked file and an untracked file. Oracle: git reset --hard.
        writeFileSync(join(w.repo, "a.txt"), "changed\n");
        await press(s.c, "F5");
        await until<boolean>(s.c, "the changed working tree", `${headRow} === ${js(w.c3)}`, (v) => v, ACTION_WAIT_MS);
        copy = oracle(w);
        g(copy, ["reset", "-q", "--hard", w.c1]);
        const dialog = await hardDialog(s, w.c1);
        await focusButton(s, dialog, HARD_CONFIRM);
        await press(s.c, "Enter");
        await outcome(s, RESET_DONE(w.c1));
        expect(state(w.repo)).toEqual(state(copy));
        // US4: Cherry-pick t1 onto main. Oracle: git cherry-pick. The new commits differ in their committer dates, so the tree, the parent, and the message count.
        copy = oracle(w);
        g(copy, ["cherry-pick", w.t1]);
        await until<string | null>(s.c, "the HEAD row c1", headRow, (v) => v === w.c1, ACTION_WAIT_MS);
        await toItem(s, w.t1, ITEM_PICK);
        await focusButton(s, popover(PICK_TITLE(w.t1)), PICK_BUTTON);
        await press(s.c, "Enter");
        await outcome(s, PICK_DONE(w.t1));
        const shape = (repo: string) => ({ commit: g(repo, ["log", "-1", "--format=%T %P %an <%ae> %B"]), symbolic: g(repo, ["symbolic-ref", "-q", "HEAD"]).trim(), index: g(repo, ["ls-files", "-s", "-z"]), files: state(repo).files });
        expect(shape(w.repo)).toEqual(shape(copy));
      } finally {
        await end(s);
      }
    },
    caseTimeout(80),
  );
});
