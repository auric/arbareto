// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 011 T019: the remote branch delete in the installed package. Spec FR-001, FR-006, FR-010, FR-016, SC-008; research.md R5 U6. `Local: package`.
// The cases drive the page through the WebView2 CDP endpoint and UI Automation patterns. They send no OS input and never move the pointer.
// A right-click is the UIA ShowContextMenu call, which Chromium sends to the page as a `contextmenu` event (uia.ts `showContextMenu`).
// A check-box click is the UIA Toggle call, which Chromium maps to the default action (a `click` event).
// Dark and Light are the System theme under the CDP `prefers-color-scheme` emulation. Forced colors is the CDP `forced-colors` emulation, not a Windows contrast theme.
// Each expected text is a plan.md D13 text. Each expected Git result comes from Git's own listing of the repository and its bare remote.
// Control: let `AlertConfirm` focus the danger button first; the remote Cancel focus case must fail.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { fixtureDir, FIXTURE_ROOT, ownedGit, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { printOrigin } from "../origin";
import { connectPage, freePort, keyEvents, MOD, watchIpc, type Cdp, type IpcLog } from "./cdp";
import { decodePng, formatMeasurement, measure, THRESHOLD } from "./contrast";
import { appEnv, descendants, findInstalledApp, HISTORY_VIEW, powershellJson, PROBE_TIMEOUT_MS, processRecords, startInstalledApp, WAIT_MS, waitExit, type OwnedProcess } from "./installed-app";
import { acceleratorKey, close, ControlType, expand, find, findAll, foregroundSkip, hasKeyboardFocus, invoke, MAX_CALL_MS, MAX_WAIT_MS, setValue, showContextMenu, toggle, waitFocus, type Element } from "./uia";

for (const helper of ["./cdp.ts", "./uia.ts", "./installed-app.ts", "./contrast.ts"]) printOrigin(helper, import.meta.dir);
// The package under test holds these sources. The `ORIGIN` line of `findInstalledApp` names the installed binary and its SHA-256.
for (const source of ["../../src/frontend/branches/BranchActions.tsx", "../../src/frontend/branches/RemoteDeleteConfirm.tsx", "../../src/frontend/branches/texts.ts", "../../src/frontend/changes/RevertConfirm.tsx", "../../src/frontend/refs/ReferencesSidebar.tsx", "../../src/frontend/status/OperationStatus.tsx"]) printOrigin(source, import.meta.dir);

const TASK = "T019";
const STEP_MS = MAX_WAIT_MS + MAX_CALL_MS;
const caseTimeout = (steps: number) => steps * STEP_MS + 2 * PROBE_TIMEOUT_MS + 2 * WAIT_MS;
const KEY_WAIT_MS = 10_000;
// A review, a run, and its reconcile reads.
const ACTION_WAIT_MS = 30_000;
// One menu walk ends after this many presses.
const WALK = 12;
// Spec FR-016 and SC-008: the Windows text sizes of the check.
const SCALES = [150, 225] as const;

// ---- App texts (plan.md D13, src/frontend/branches/texts.ts) ----

const OPEN_FOLDER = "Open folder… (Ctrl+O)";
const REMOTE = "origin";
// src/frontend/refs/ReferencesSidebar.tsx `GROUPS` nouns and the row name.
const remoteRowName = (tracking: string) => `${tracking}, remote-tracking branch`;
const LOCAL_NOUN = "local branch";
const MENU_NAME = (branch: string) => `Actions for ${branch}`;
const CREATE_HERE = "Create branch here…";
const ADD_WORKTREE = "Add worktree for this branch…";
const RD = {
  item: "Delete remote branch…",
  title: (tracking: string) => `Delete the remote branch ${tracking}?`,
  deletesLead: "Git deletes ",
  deletesTail: (remote: string, tracking: string) => ` on ${remote}, and the remote-tracking branch ${tracking} here.`,
  lost: (n: number) => (n === 1 ? "1 commit is on no other branch, tag, or remote-tracking branch here:" : `${n} commits are on no other branch, tag, or remote-tracking branch here:`),
  warning: (tracking: string) => `Other people can lose work. The delete stops if ${tracking} changed since the last fetch.`,
  button: "Delete remote branch",
  alsoDelete: (tracking: string) => `Also delete the remote branch ${tracking}`,
  bothLost: (branch: string, tracking: string, n: number) => `${branch} and ${tracking} have ${n} ${n === 1 ? "commit" : "commits"} that no other branch, tag, or remote-tracking branch has. The delete loses them.`,
  list: (tracking: string) => `Commits only on ${tracking}`,
} as const;
// src/frontend/keyboard/shortcuts.ts `KEYS.delete`.
const DEL = { aria: "Delete", text: "Del" };
const DELETE_TITLE = (branch: string) => `Delete ${branch}?`;
const DELETE_BUTTON = "Delete";
// src/frontend/status/OperationStatus.tsx `deleteOutcome`.
const REMOTE_DONE = (tracking: string) => `Deleted the remote branch ${tracking}.`;
const BOTH_DONE = (branch: string, tracking: string) => `Deleted ${branch} and the remote branch ${tracking}.`;
// src-tauri/src/dialogs.rs `trust_confirmation` (004 plan.md D14).
const TRUST_MAIN = "Do you trust this repository?";
const TRUST = "Trust";

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
const dialogWith = (title: string) => `${open("[role=alertdialog],[role=dialog]")}.find((d) => d.querySelector('[data-slot=dialog-title]')?.textContent.trim() === ${js(title)})`;
const nothingOpen = `${open("[role=menu]")}.length === 0 && ${open("[role=alertdialog],[role=dialog]")}.length === 0`;
const buttonIn = (scope: string, text: string) => `[...((${scope})?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === ${js(text)})`;
const enabled = (button: string) => `(!!(${button}) && !(${button}).disabled && (${button}).getAttribute('aria-disabled') !== 'true')`;
const checkboxIn = (scope: string) => `(${scope})?.querySelector('input[type=checkbox]')`;
const menuItem = (label: string) => `[...((${MENU})?.querySelectorAll('[role=menuitem]') ?? [])].find((i) => i.querySelector('[data-slot=menu-label]')?.textContent === ${js(label)})`;
const GROUP_LABELS = `[...((${MENU})?.querySelectorAll('[data-slot=dropdown-menu-group]') ?? [])].map((g) => [...g.querySelectorAll('[role=menuitem]')].map((i) => i.querySelector('[data-slot=menu-label]')?.textContent ?? null))`;
const statusTexts = `[...(document.querySelector('[data-slot=status-region] footer')?.querySelectorAll('[role=status]') ?? [])].map((e) => e.textContent.trim())`;
const list = `document.querySelector('[data-history-list]')`;
const headRow = `(document.querySelector('[data-history-list] [role=option] .badge')?.closest('[role=option]')?.dataset.rowId ?? null)`;
// The References tree: its `aria-labelledby` heading reads "References" (ReferencesSidebar.tsx).
const REFS = `[...document.querySelectorAll('[role=tree]')].find((t) => document.getElementById(t.getAttribute('aria-labelledby') ?? '')?.textContent.trim() === 'References')`;
const treeRow = (test: string) => `[...((${REFS})?.querySelectorAll('[role=treeitem]') ?? [])].find((e) => { const n = e.getAttribute('aria-label') ?? ''; return ${test}; })`;
const remoteRow = (tracking: string) => treeRow(`n === ${js(remoteRowName(tracking))}`);
// A local row name continues with the upstream and the track label (ReferencesSidebar.tsx `name`).
const localRowEl = (branch: string) => treeRow(`n === ${js(`${branch}, ${LOCAL_NOUN}`)} || n.startsWith(${js(`${branch}, ${LOCAL_NOUN}, `)})`);
const groupRow = (prefix: string) => treeRow(`n.startsWith(${js(prefix)})`);
const inside = `const inside = (b) => b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight;`;

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

async function focusOn(c: Cdp, expression: string, what: string): Promise<void> {
  await until<boolean>(c, `${what} shows`, `!!(${expression})`, (v) => v);
  await c.evaluate(`(${expression}).scrollIntoView({ block: 'nearest' }); (${expression}).focus(); true`);
  await until<boolean>(c, `${what} has focus`, `document.activeElement === (${expression})`, (v) => v);
}

// ---- Accessibility, focus, and contrast through CDP (SC-008) ----

const NAMED_ROLES = ["button", "checkbox", "list", "menuitem"];
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

// ---- UI Automation keyboard focus (the 008 T047 method) ----

// GetFocusedElement gives the system focus, which exists only in the foreground window. An agent session never owns the foreground.
// Chromium `AXPlatformNodeWin` sets HasKeyboardFocus on the element with the DOM focus, with no window focus check.
// `focused` must be the one named element with HasKeyboardFocus, and each name of `others` must name one element without it.
async function uiaFocus(processId: number, what: string, focused: string, others: string[]): Promise<void> {
  const foreground = foregroundSkip(processId);
  if (foreground === null) {
    await waitFocus(processId, focused, MAX_WAIT_MS);
    return;
  }
  const left = (end: number) => Math.max(0, Math.min(MAX_WAIT_MS, Math.ceil(end - performance.now())));
  const want = js([{ name: focused, hasKeyboardFocus: true }, ...others.map((name) => ({ name, hasKeyboardFocus: false }))]);
  let seen: unknown = null;
  for (const end = performance.now() + MAX_WAIT_MS; ; await Bun.sleep(50)) {
    const elements: Element[] = [];
    try {
      for (const name of [focused, ...others]) {
        const found = await findAll(processId, name, left(end));
        elements.push(...found);
        if (found.length !== 1) throw new Error(`${what}: process ${processId} has ${found.length} elements named ${js(name)}`);
      }
      seen = elements.map((e) => ({ name: e.name, hasKeyboardFocus: hasKeyboardFocus(e) }));
      if (js(seen) === want) break;
    } finally {
      for (const e of elements) e.release();
    }
    if (performance.now() >= end) throw new Error(`${what}: no UIA HasKeyboardFocus on ${js(focused)} alone after ${MAX_WAIT_MS} ms: ${js(seen)}`);
  }
  console.log(`OBSERVATION ${TASK}: ${what}: UIA HasKeyboardFocus on ${js(focused)} (provider focus, the DOM focus source); system focus unverified: ${foreground}`);
}

describe.skipIf(process.platform !== "win32")("T019 packaged remote branch delete", () => {
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

  const g = (cwd: string, args: string[], allowExit = [0], env: Record<string, string> = {}) => ownedGit(GIT!, FIXTURE_ROOT, cwd, args, { allowExit, env }).toString("utf8");
  const rev = (repo: string, name: string) => g(repo, ["rev-parse", "--verify", "--end-of-options", `${name}^{commit}`]).trim();
  const REF_LIST = ["for-each-ref", "--format=%(objectname) %(refname) %(upstream)"];
  type World = { repo: string; remote: string };
  // The Git facts that a delete changes: the refs and upstreams of the repository and the refs of its bare remote.
  const state = (w: World) => ({ refs: g(w.repo, REF_LIST), remote: g(w.remote, REF_LIST), head: g(w.repo, ["symbolic-ref", "-q", "HEAD"]).trim() });
  const without = (lines: string, refs: string[]) => lines.split("\n").filter((l) => !refs.some((r) => l.split(" ")[1] === r)).join("\n");

  let builds = 0;
  // main: c1 → c2. topic: t1 → t2 → t3 on c2, on the remote only. feature: f1 on c2, local with upstream origin/feature. origin/HEAD names origin/main.
  function build(name: string): World {
    const root = fixtureDir(`${name}-${++builds}`);
    const repo = join(root, "repo");
    const remote = join(root, "remote.git");
    mkdirSync(repo, { recursive: true });
    g(root, ["init", "-q", "--bare", "-b", "main", remote]);
    g(repo, ["init", "-q", "-b", "main"]);
    for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"]] as const) g(repo, ["config", key, value]);
    let day = 0;
    const commit = (path: string, text: string, message: string) => {
      writeFileSync(join(repo, path), text);
      g(repo, ["add", "--", path]);
      const date = `2026-01-${String(++day).padStart(2, "0")}T00:00:00+0000`;
      g(repo, ["commit", "-q", "--no-verify", "-m", message], [0], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
      return rev(repo, "HEAD");
    };
    commit("a.txt", "a1\n", "c1");
    const c2 = commit("a.txt", "a2\n", "c2");
    g(repo, ["switch", "-q", "-c", "topic"]);
    for (const t of ["t1", "t2", "t3"]) commit("t.txt", `${t}\n`, t);
    g(repo, ["switch", "-q", "-c", "feature", c2]);
    commit("f.txt", "f1\n", "f1");
    g(repo, ["switch", "-q", "main"]);
    g(repo, ["remote", "add", REMOTE, remote]);
    g(repo, ["push", "-q", REMOTE, "refs/heads/main:refs/heads/main", "refs/heads/topic:refs/heads/topic", "refs/heads/feature:refs/heads/feature"]);
    g(repo, ["fetch", "-q", REMOTE]);
    // Plan.md D4 step 6: the review needs `refs/remotes/origin/HEAD`.
    g(repo, ["remote", "set-head", REMOTE, "main"]);
    g(repo, ["branch", "-q", "-D", "topic"]);
    g(repo, ["branch", "-q", "--set-upstream-to=refs/remotes/origin/feature", "feature"]);
    return { repo, remote };
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
    const s = { app, c, ipc, w };
    await showRemotes(s);
    return s;
  }
  async function end(s: Session): Promise<void> {
    s.c.close();
    sockets.delete(s.c);
    s.app.stop();
    owned.delete(s.app);
    expect(await waitExit(s.app)).not.toBeNull();
  }

  // ReferencesSidebar.tsx `defaultExpansion`: Remotes and its folders start closed. A narrow window hides the sidebar behind "Show references".
  async function showRemotes(s: Session): Promise<void> {
    const show = `[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Show references' && b.getAttribute('aria-expanded') === 'false')`;
    if (await s.c.evaluate<boolean>(`!!(${show})`)) {
      await focusOn(s.c, show, "Show references");
      await press(s.c, "Enter");
    }
    for (const prefix of ["Remotes, ", `${REMOTE}, folder, `]) {
      const row = groupRow(prefix);
      if ((await s.c.evaluate<string | null>(`(${row})?.getAttribute('aria-expanded') ?? null`)) !== "true") {
        await focusOn(s.c, row, `the ${prefix} row`);
        await press(s.c, "ArrowRight");
      }
      await until<string | null>(s.c, `the open ${prefix} row`, `(${row})?.getAttribute('aria-expanded') ?? null`, (v) => v === "true");
    }
  }
  // Shift+F10 opens the row menu with the focus on its first item. Down moves to `label`.
  async function toItem(s: Session, row: string, branch: string, label: string): Promise<void> {
    await focusOn(s.c, row, `the ${branch} row`);
    await press(s.c, "F10", MOD.Shift);
    await until<string | null>(s.c, "the branch menu", `(${MENU})?.getAttribute('aria-label') ?? null`, (v) => v === MENU_NAME(branch));
    for (let i = 0; i < WALK && !(await s.c.evaluate<boolean>(`document.activeElement === (${menuItem(label)})`)); i++) await press(s.c, "ArrowDown");
    await until<boolean>(s.c, `the focus on ${label}`, `document.activeElement === (${menuItem(label)})`, (v) => v);
  }
  // Del on the remote-tracking row starts the review. The alert dialog then shows its plan.
  async function remoteDialog(s: Session, tracking: string): Promise<string> {
    await focusOn(s.c, remoteRow(tracking), `the ${tracking} row`);
    await press(s.c, "Delete");
    const dialog = dialogWith(RD.title(tracking));
    await until<boolean>(s.c, "the remote dialog with its plan", enabled(buttonIn(dialog, RD.button)), (v) => v, ACTION_WAIT_MS);
    return dialog;
  }
  // Del on the local row opens the 004 dialog with X9. The UIA Toggle checks X9; the dialog then shows the combined plan.
  async function checkedLocalDialog(s: Session, branch: string, tracking: string, lost: number): Promise<string> {
    await focusOn(s.c, localRowEl(branch), `the ${branch} row`);
    await press(s.c, "Delete");
    const dialog = dialogWith(DELETE_TITLE(branch));
    await until<boolean>(s.c, "the local dialog with X9", `${enabled(buttonIn(dialog, DELETE_BUTTON))} && (${checkboxIn(dialog)})?.checked === false`, (v) => v, ACTION_WAIT_MS);
    await uia(s.app.pid, RD.alsoDelete(tracking), undefined, toggle);
    await combinedPlan(s, dialog, branch, tracking, lost);
    return dialog;
  }
  const combinedPlan = (s: Session, dialog: string, branch: string, tracking: string, lost: number) =>
    until<boolean>(s.c, "the combined plan", `(${checkboxIn(dialog)})?.checked === true && ${enabled(buttonIn(dialog, DELETE_BUTTON))} && (${dialog}).textContent.includes(${js(RD.bothLost(branch, tracking, lost))})`, (v) => v, ACTION_WAIT_MS);
  // Escape closes the open layer. The focus then returns to `row` (spec FR-016).
  async function escapeTo(s: Session, row: string): Promise<void> {
    await press(s.c, "Escape");
    await until<boolean>(s.c, "the closed layer and the focus on the row", `${nothingOpen} && document.activeElement === (${row})`, (v) => v);
  }
  async function outcome(s: Session, text: string): Promise<void> {
    await until<string[]>(s.c, `the outcome ${text}`, statusTexts, (v) => v.includes(text), ACTION_WAIT_MS);
  }

  // ---- FR-001, FR-006: X1, its key, the dialog names, and Del ----

  test.skipIf(reason !== null)(
    "FR-001, FR-006: X1 ends group 2 of the remote-tracking row menu in the danger style with the key text Del and AcceleratorKey Delete; X1 and Del open the alert dialog named X2 with X3, X4, the list X30, and X7; Escape changes nothing",
    async () => {
      const w = build("t019-names");
      const before = state(w);
      const tracking = `${REMOTE}/topic`;
      const s = await session("names", w);
      try {
        // A right-click opens the menu at the row.
        await uia(s.app.pid, remoteRowName(tracking), ControlType.TreeItem, (row) => expect(showContextMenu(row)).toBe(0));
        await until<string | null>(s.c, "the right-click menu", `(${MENU})?.getAttribute('aria-label') ?? null`, (v) => v === MENU_NAME(tracking));
        const groups = await s.c.evaluate<string[][]>(GROUP_LABELS);
        const x1 = await s.c.evaluate<{ danger: string | null; keys: string | null; aria: string | null; icon: boolean }>(`(() => { const i = ${menuItem(RD.item)}; return { danger: i.getAttribute('data-danger'), keys: i.querySelector('[data-slot=dropdown-menu-shortcut]')?.textContent ?? null, aria: i.getAttribute('aria-keyshortcuts'), icon: !!i.querySelector('[data-slot=menu-icon] svg') }; })()`);
        expect({ group2: groups[1], x1 }).toEqual({ group2: [CREATE_HERE, ADD_WORKTREE, RD.item], x1: { danger: "true", keys: DEL.text, aria: DEL.aria, icon: true } });
        expect(await uia(s.app.pid, RD.item, ControlType.MenuItem, acceleratorKey)).toBe(DEL.aria);
        await uia(s.app.pid, MENU_NAME(tracking), undefined, () => {});
        await press(s.c, "Escape");
        await until<boolean>(s.c, "the closed menu", nothingOpen, (v) => v);
        // X1 by keyboard.
        await toItem(s, remoteRow(tracking), tracking, RD.item);
        await press(s.c, "Enter");
        const dialog = dialogWith(RD.title(tracking));
        await until<boolean>(s.c, "the remote dialog with its plan", enabled(buttonIn(dialog, RD.button)), (v) => v, ACTION_WAIT_MS);
        const texts = await s.c.evaluate<{ text: string; dst: string | null; list: string | null; items: number; role: string | null }>(
          `(() => { const d = ${dialog}; return { text: d.textContent, dst: d.querySelector('code')?.textContent ?? null, list: d.querySelector('ul')?.getAttribute('aria-label') ?? null, items: d.querySelectorAll('ul li').length, role: d.getAttribute('role') }; })()`,
        );
        const subjects = ["t1", "t2", "t3"].filter((t) => texts.text.includes(t));
        expect({ ...texts, text: [RD.deletesLead, RD.deletesTail(REMOTE, tracking), RD.lost(3), RD.warning(tracking)].map((t) => texts.text.includes(t)), subjects }).toEqual({
          text: [true, true, true, true],
          dst: "refs/heads/topic",
          list: RD.list(tracking),
          items: 3,
          role: "alertdialog",
          subjects: ["t1", "t2", "t3"],
        });
        for (const [name, type] of [[RD.title(tracking), undefined], [RD.list(tracking), undefined], [RD.button, ControlType.Button], ["Cancel", ControlType.Button]] as const) await uia(s.app.pid, name, type, () => {});
        expect(await unnamed(s.c, dialog)).toEqual([]);
        await escapeTo(s, remoteRow(tracking));
        // Del on the focused row opens the same dialog.
        await remoteDialog(s, tracking);
        await escapeTo(s, remoteRow(tracking));
        expect(state(w)).toEqual(before);
      } finally {
        await end(s);
      }
    },
    caseTimeout(40),
  );

  // ---- FR-006: Cancel focus of the remote dialog (control target) ----

  test.skipIf(reason !== null)(
    "FR-006: the remote dialog gives Cancel the first focus (UIA HasKeyboardFocus), has no default button, and Escape changes nothing",
    async () => {
      const w = build("t019-remote-focus");
      const before = state(w);
      const tracking = `${REMOTE}/topic`;
      const s = await session("remote-focus", w);
      try {
        const dialog = await remoteDialog(s, tracking);
        await until<string | null>(s.c, "the DOM focus on Cancel", `(document.activeElement?.closest('[role=alertdialog]') ? document.activeElement.textContent.trim() : null)`, (v) => v === "Cancel");
        await uiaFocus(s.app.pid, "remote dialog", "Cancel", [RD.button]);
        // No default button: no submit button and no form, so only the focused button reacts to Enter.
        expect(await s.c.evaluate<{ submit: number; forms: number }>(`(() => { const d = ${dialog}; return { submit: d.querySelectorAll('button[type=submit],input[type=submit]').length, forms: d.querySelectorAll('form').length }; })()`)).toEqual({ submit: 0, forms: 0 });
        await escapeTo(s, remoteRow(tracking));
        expect(state(w)).toEqual(before);
      } finally {
        await end(s);
      }
    },
    caseTimeout(30),
  );

  // ---- FR-010: the local dialog with X9 ----

  test.skipIf(reason !== null)(
    "FR-010: the local Delete dialog opens with X9 unchecked and Cancel focused (UIA HasKeyboardFocus); the checked plan states the commits of both deletes and never moves the focus to Delete; Escape changes nothing",
    async () => {
      const w = build("t019-local-focus");
      const before = state(w);
      const tracking = `${REMOTE}/feature`;
      const s = await session("local-focus", w);
      try {
        await focusOn(s.c, localRowEl("feature"), "the feature row");
        await press(s.c, "Delete");
        const dialog = dialogWith(DELETE_TITLE("feature"));
        await until<boolean>(s.c, "the local dialog with X9", `${enabled(buttonIn(dialog, DELETE_BUTTON))} && (${checkboxIn(dialog)})?.checked === false`, (v) => v, ACTION_WAIT_MS);
        await until<string | null>(s.c, "the DOM focus on Cancel", `(document.activeElement?.closest('[role=dialog]') ? document.activeElement.textContent.trim() : null)`, (v) => v === "Cancel");
        await uiaFocus(s.app.pid, "local dialog", "Cancel", [DELETE_BUTTON]);
        await uia(s.app.pid, RD.alsoDelete(tracking), undefined, toggle);
        await combinedPlan(s, dialog, "feature", tracking, 1);
        expect(await s.c.evaluate<string | null>(`(${dialog}).querySelector('ul')?.getAttribute('aria-label') ?? null`)).toBe(RD.list(tracking));
        expect(await s.c.evaluate<boolean>(`document.activeElement === (${buttonIn(dialog, DELETE_BUTTON)})`)).toBe(false);
        expect(await uia(s.app.pid, DELETE_BUTTON, ControlType.Button, hasKeyboardFocus)).toBe(false);
        expect(await unnamed(s.c, dialog)).toEqual([]);
        await escapeTo(s, localRowEl("feature"));
        expect(state(w)).toEqual(before);
      } finally {
        await end(s);
      }
    },
    caseTimeout(30),
  );

  // ---- U6: the trust ask from inside the open dialog ----

  test.skipIf(reason !== null)(
    "U6: with a pre-push hook, checking X9 asks for trust; after Trust the combined plan shows and the focus is back on X9 inside the open Delete dialog (UIA HasKeyboardFocus); the hook does not run",
    async () => {
      const w = build("t019-trust");
      // Feature 003 plan.md D11: `pre-push` is a sync event only, so the 004 delete review asks nothing and the sync review asks once.
      const marker = join(w.repo, "..", "pre-push.marker");
      writeFileSync(join(w.repo, ".git", "hooks", "pre-push"), `#!/bin/sh\necho pre-push >> '${marker.replaceAll("\\", "/")}'\n`);
      const before = state(w);
      const tracking = `${REMOTE}/feature`;
      const s = await session("trust", w);
      try {
        await focusOn(s.c, localRowEl("feature"), "the feature row");
        await press(s.c, "Delete");
        const dialog = dialogWith(DELETE_TITLE("feature"));
        const box = checkboxIn(dialog);
        await until<boolean>(s.c, "the local dialog with X9", `${enabled(buttonIn(dialog, DELETE_BUTTON))} && (${box})?.checked === false`, (v) => v, ACTION_WAIT_MS);
        await focusOn(s.c, box, "X9");
        await uia(s.app.pid, RD.alsoDelete(tracking), undefined, toggle);
        await use(find(s.app.pid, TRUST_MAIN, MAX_WAIT_MS), () => {});
        await uia(s.app.pid, TRUST, ControlType.Button, invoke);
        await combinedPlan(s, dialog, "feature", tracking, 1);
        await until<boolean>(s.c, "the DOM focus on X9 inside the open dialog", `!!(${dialog}) && document.activeElement === (${box})`, (v) => v);
        await uiaFocus(s.app.pid, "Delete dialog after the trust ask", RD.alsoDelete(tracking), ["Cancel", DELETE_BUTTON]);
        expect(existsSync(marker)).toBe(false);
        await escapeTo(s, localRowEl("feature"));
        expect(state(w)).toEqual(before);
      } finally {
        await end(s);
      }
    },
    caseTimeout(40),
  );

  // ---- SC-008, FR-016: themes and forced colors ----

  test.skipIf(reason !== null)(
    "SC-008, FR-016: in Dark, Light, and forced colors X1, the remote dialog, and the checked local dialog keep named controls, visible focus, and texts at 4.5:1; each danger button keeps a border in forced colors",
    async () => {
      const w = build("t019-themes");
      const before = state(w);
      const remote = `${REMOTE}/topic`;
      const tracking = `${REMOTE}/feature`;
      const s = await session("themes", w);
      try {
        await toItem(s, remoteRow(remote), remote, RD.item);
        for (const scheme of ["dark", "light", "forced"] as const) {
          await emulate(s.c, scheme);
          expect({ scheme, unnamed: await unnamed(s.c, MENU) }).toEqual({ scheme, unnamed: [] });
          expect({ scheme, focus: focusVisible(await s.c.poll(FOCUS_STYLE, focusVisible, KEY_WAIT_MS)) }).toEqual({ scheme, focus: true });
          await contrast(s.c, scheme, [["X1", `(${menuItem(RD.item)})?.querySelector('[data-slot=menu-label]')`]]);
        }
        await emulate(s.c, "dark");
        await escapeTo(s, remoteRow(remote));
        const dialogs: { name: string; open: () => Promise<string>; danger: string; texts: (d: string) => [string, string][]; row: string }[] = [
          {
            name: "remote dialog",
            open: () => remoteDialog(s, remote),
            danger: RD.button,
            texts: (d) => [
              ["title", `(${d}).querySelector('[data-slot=dialog-title]')`],
              ["warning", `[...(${d}).querySelectorAll('span')].find((e) => e.textContent === ${js(RD.warning(remote))})`],
            ],
            row: remoteRow(remote),
          },
          {
            name: "checked local dialog",
            open: () => checkedLocalDialog(s, "feature", tracking, 1),
            danger: DELETE_BUTTON,
            texts: (d) => [
              ["title", `(${d}).querySelector('[data-slot=dialog-title]')`],
              ["X9", `(${checkboxIn(d)}).closest('label')`],
              ["warning", `[...(${d}).querySelectorAll('span')].find((e) => e.textContent === ${js(RD.warning(tracking))})`],
            ],
            row: localRowEl("feature"),
          },
        ];
        for (const d of dialogs) {
          const dialog = await d.open();
          const danger = buttonIn(dialog, d.danger);
          for (const scheme of ["dark", "light", "forced"] as const) {
            await emulate(s.c, scheme);
            expect({ dialog: d.name, scheme, unnamed: await unnamed(s.c, dialog) }).toEqual({ dialog: d.name, scheme, unnamed: [] });
            await focusOn(s.c, buttonIn(dialog, "Cancel"), "Cancel");
            const cancelFocus = await s.c.poll<{ outline: string; width: string; shadow: string }>(FOCUS_STYLE, focusVisible, KEY_WAIT_MS);
            await contrast(s.c, scheme, [...d.texts(dialog), ["cancel", buttonIn(dialog, "Cancel")], ["danger", danger]]);
            if (scheme === "forced") {
              const border = await s.c.evaluate<{ style: string; width: number }>(`(() => { const st = getComputedStyle(${danger}); return { style: st.borderTopStyle, width: Number.parseFloat(st.borderTopWidth) }; })()`);
              expect({ dialog: d.name, style: border.style !== "none", width: border.width > 0 }).toEqual({ dialog: d.name, style: true, width: true });
            }
            await focusOn(s.c, danger, "the danger button");
            const dangerFocus = await s.c.poll<{ outline: string; width: string; shadow: string }>(FOCUS_STYLE, focusVisible, KEY_WAIT_MS);
            expect({ dialog: d.name, scheme, cancel: focusVisible(cancelFocus), danger: focusVisible(dangerFocus) }).toEqual({ dialog: d.name, scheme, cancel: true, danger: true });
          }
          await emulate(s.c, "dark");
          await focusOn(s.c, buttonIn(dialog, "Cancel"), "Cancel");
          await escapeTo(s, d.row);
        }
        expect(state(w)).toEqual(before);
      } finally {
        await end(s);
      }
    },
    caseTimeout(80),
  );

  // ---- FR-016: densities and text sizes ----

  // The menu, the remote dialog, and the checked local dialog lie inside the window with no horizontal overflow.
  async function geometry(s: Session, label: string): Promise<void> {
    const remote = `${REMOTE}/topic`;
    const box = async (what: string, expression: string) => {
      await settle(s.c);
      const r = await s.c.evaluate<{ inside: boolean; overflow: boolean }>(`(() => { ${inside} const e = ${expression}; return { inside: inside(e.getBoundingClientRect()), overflow: e.scrollWidth > e.clientWidth }; })()`);
      console.log(`GEOMETRY ${TASK}: ${label} ${what} ${js(r)}`);
      expect({ label, what, ...r }).toEqual({ label, what, inside: true, overflow: false });
    };
    await toItem(s, remoteRow(remote), remote, RD.item);
    await box("menu", MENU);
    await escapeTo(s, remoteRow(remote));
    await box("remote dialog", await remoteDialog(s, remote));
    await escapeTo(s, remoteRow(remote));
    await box("checked local dialog", await checkedLocalDialog(s, "feature", `${REMOTE}/feature`, 1));
    await escapeTo(s, localRowEl("feature"));
  }

  test.skipIf(reason !== null)(
    "FR-016: in Compact and Comfortable the menu, the remote dialog, and the checked local dialog lie inside the window with no horizontal overflow",
    async () => {
      const w = build("t019-density");
      const before = state(w);
      const s = await session("density", w);
      try {
        for (const density of ["Compact", "Comfortable"] as const) {
          // The View menu radio items of src/frontend/app/Workbench.tsx (as workbench-packaged.test.ts).
          await uia(s.app.pid, "View", ControlType.MenuItem, expand);
          const item = `[...document.querySelectorAll('[role="menuitemradio"]')].find((e) => e.textContent.trim() === ${js(density)})`;
          await focusOn(s.c, item, `the ${density} item`);
          await press(s.c, "Enter");
          await until<string | null>(s.c, `the ${density} density`, "document.documentElement.getAttribute('data-density')", (v) => v === density.toLowerCase());
          await until<boolean>(s.c, "the closed View menu", nothingOpen, (v) => v);
          await showRemotes(s);
          await geometry(s, density);
        }
        expect(state(w)).toEqual(before);
      } finally {
        await end(s);
      }
    },
    caseTimeout(60),
  );

  // Spec SC-008: the text size is a user setting, so the case runs at the current size only.
  const scale = process.platform === "win32" && reason === null ? textScale() : null;
  if (scale !== null) console.log(`OBSERVATION ${TASK}: text scale ${scale}%`);
  for (const size of SCALES) {
    const scaleReason = reason ?? (scale === size ? null : `missing capability text-scale-${size}: the current text size is ${scale}% (set Settings > Accessibility > Text size to ${size}% and run again)`);
    if (scaleReason !== null && reason === null) console.log(`SKIP ${TASK} text scale ${size}%: ${scaleReason} (unverified)`);
    test.skipIf(scaleReason !== null)(
      `SC-008 at text size ${size}%: the menu, the remote dialog, and the checked local dialog lie inside the window with no horizontal overflow`,
      async () => {
        const w = build(`t019-scale-${size}`);
        const s = await session(`scale-${size}`, w);
        try {
          await geometry(s, `${size}%`);
        } finally {
          await end(s);
        }
      },
      caseTimeout(40),
    );
  }

  // ---- Real deletes through the local bare remote ----

  test.skipIf(reason !== null)(
    "US1, US2 by keyboard: X1 deletes origin/topic, and the checked local dialog deletes feature and origin/feature; Git's listings of the repository and the bare remote lose exactly those refs",
    async () => {
      const w = build("t019-git");
      const s = await session("git", w);
      try {
        // US1: remote only.
        let before = state(w);
        const topic = `${REMOTE}/topic`;
        await toItem(s, remoteRow(topic), topic, RD.item);
        await press(s.c, "Enter");
        const dialog = dialogWith(RD.title(topic));
        await until<boolean>(s.c, "the remote dialog with its plan", enabled(buttonIn(dialog, RD.button)), (v) => v, ACTION_WAIT_MS);
        await focusOn(s.c, buttonIn(dialog, RD.button), "the danger button");
        await press(s.c, "Enter");
        await outcome(s, REMOTE_DONE(topic));
        expect(state(w)).toEqual({ refs: without(before.refs, ["refs/remotes/origin/topic"]), remote: without(before.remote, ["refs/heads/topic"]), head: before.head });
        expect(g(w.repo, ["ls-remote", REMOTE, "refs/heads/topic"])).toBe("");
        // US2: combined.
        before = state(w);
        const feature = `${REMOTE}/feature`;
        const local = await checkedLocalDialog(s, "feature", feature, 1);
        await focusOn(s.c, buttonIn(local, DELETE_BUTTON), "Delete");
        await press(s.c, "Enter");
        await outcome(s, BOTH_DONE("feature", feature));
        expect(state(w)).toEqual({ refs: without(before.refs, ["refs/heads/feature", "refs/remotes/origin/feature"]), remote: without(before.remote, ["refs/heads/feature"]), head: before.head });
        expect(g(w.repo, ["ls-remote", REMOTE, "refs/heads/feature"])).toBe("");
      } finally {
        await end(s);
      }
    },
    caseTimeout(50),
  );
});
