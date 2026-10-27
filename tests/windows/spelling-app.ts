// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T041, T042: the shared steps of the feature 006 packaged tests (plan.md P8, WP8). They send no OS input and never move the pointer.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import catalogFile from "../../src/contracts/dictionaries.json";
import { Catalog, type CatalogEntry } from "../../src/contracts/dictionaries";
import { SPELLING_TEXTS } from "../../src/frontend/spelling/texts";
import { fixtureDir, fixtureEnv, FIXTURE_ROOT } from "../git/fixture-root";
import { faGit, write } from "../git/file-actions-fixtures";
import { GIT } from "../git/git-binary";
import { printOrigin } from "../origin";
import { connectPage, freePort, MOD, type Cdp, type KeyEvent } from "./cdp";
import { appEnv, findInstalledApp, PROBE_TIMEOUT_MS, processRecords, startInstalledApp, WAIT_MS, waitExit, type AppEnv, type InstalledApp, type OwnedProcess } from "./installed-app";
import { ControlType, find, invoke, MAX_CALL_MS, MAX_WAIT_MS, setValue, type Element } from "./uia";

for (const helper of ["../../src/contracts/dictionaries.json", "../../src/frontend/spelling/texts.ts", "./cdp.ts", "./uia.ts", "./installed-app.ts"]) printOrigin(helper, import.meta.dir);

export const T = SPELLING_TEXTS;
export const catalog = Catalog.parse(catalogFile);
// One wait of a UIA step can pass its bound by one call.
export const STEP_MS = MAX_WAIT_MS + MAX_CALL_MS;
export const caseTimeout = (steps: number, extraMs = 0) => steps * STEP_MS + 4 * PROBE_TIMEOUT_MS + 2 * WAIT_MS + extraMs;
// A Git read, a worker load, or a service round trip after a step stays far below it.
export const ACTION_WAIT_MS = 30_000;

// ---- App texts and page expressions (the source of each value is named) ----

// src/frontend/app/RepositorySwitcher.tsx `OPEN_FOLDER`.
export const OPEN_FOLDER = "Open folder… (Ctrl+O)";
// src/frontend/commit/CommitTray.tsx: the textarea name.
export const MESSAGE = "Commit message";
// src/frontend/app/Workbench.tsx: the View menu and its Settings item.
export const VIEW_MENU = "View";
export const SETTINGS_ITEM = "Settings…";
// src/frontend/settings/SettingsView.tsx `APP_PAGES` and src/frontend/settings/SpellingPage.tsx `SPELLING_PAGE.spellCheck`.
export const SPELLING_TAB = "Spelling";
export const SPELL_SWITCH = "Spell check";
// src/frontend/settings/SpellingPage.tsx `SPELLING_PAGE.name.download` and `SPELLING_PAGE.transport`.
export const downloadName = (language: string) => `Download ${language}`;
export const transportText = (language: string) => `Arbareto could not download the ${language} dictionary. Check the connection, then select Retry, or use Import.`;

export const js = (value: unknown) => JSON.stringify(value);
export const FIELD = `document.querySelector('textarea[aria-label=${js(MESSAGE)}]')`;
// src/frontend/spelling/SpellMirror.tsx `MARK` spans and src/frontend/spelling/SpellChip.tsx.
export const MARKS = `[...document.querySelectorAll('[data-slot="spell-mark"]')].map((e) => e.textContent)`;
export const CHIP = `document.querySelector('[data-slot="spell-chip"]')?.textContent ?? null`;
// CommitTray.tsx: the textarea names the sr-only count element and its other descriptions in `aria-describedby`.
export const DESCRIPTIONS = `(${FIELD}?.getAttribute('aria-describedby') ?? '').split(' ').filter((id) => id !== '').map((id) => document.getElementById(id)?.textContent ?? null)`;
// src/frontend/components/action-menu.tsx: the menu has the `aria-label` of SpellMenu.tsx, and each item label sits in `data-slot=menu-label`.
export const spellMenu = (raw: string) => `[...document.querySelectorAll('[role=menu]')].find((m) => m.getAttribute('aria-label') === ${js(T.menu(raw))})`;
export const MENU_LABELS = (menu: string) => `[...((${menu})?.querySelectorAll('[role=menuitem] [data-slot=menu-label]') ?? [])].map((e) => e.textContent)`;
export const menuItem = (menu: string, label: string) => `[...((${menu})?.querySelectorAll('[role=menuitem]') ?? [])].find((e) => e.querySelector('[data-slot=menu-label]')?.textContent === ${js(label)})`;

// ---- The installed 006 build ----

// Contract `buildIdentity`: `commit` is a full SHA-1 or SHA-256 commit ID, with the suffix `-dirty` for a dirty tree.
const BUILD = /^(\S+) ([0-9a-f]{40}|[0-9a-f]{64})(-dirty)?$/;
// src/frontend/boot/BootView.tsx: the boot view shows `<dt>Build</dt><dd>{version} {commit}</dd>` before a Git selection.
const BUILD_TEXT = `[...document.querySelectorAll('dt')].find((d) => d.textContent === 'Build')?.nextElementSibling?.textContent ?? null`;
// The batch 3 files come after every 006 work package (tasks.md "Phase dependencies"). A build tree with this file holds all code that the tests check.
export const BUILD_MARKER = "tests/windows/spelling-packaged.test.ts";
const CHECKOUT = join(import.meta.dir, "..", "..");

// Git decides from the commit object of the build: `rev-parse --verify --quiet` exits 0 only for a valid object, and `ls-tree -z --name-only` prints each match with a NUL.
export function buildHolds(git: string, commit: string): string | null {
  const run = (args: string[]) => Bun.spawnSync([git, "-C", CHECKOUT, ...args], { env: fixtureEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: PROBE_TIMEOUT_MS });
  const known = run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${commit}^{commit}`]);
  if (known.exitCode !== 0 || known.stdout.toString() !== `${commit}\n`) return `not-006-build: the build commit ${commit} is not in this checkout`;
  const tree = run(["ls-tree", "-z", "--name-only", commit, "--", BUILD_MARKER]);
  if (tree.exitCode !== 0) throw new Error(`git ls-tree ${commit} exited ${tree.exitCode}: ${tree.stderr.toString()}`);
  return tree.stdout.toString() === `${BUILD_MARKER}\0` ? null : `not-006-build: the build commit ${commit} has no ${BUILD_MARKER}`;
}

// Starts the package once with an own profile and reads the build identity of the boot view.
async function readBuild(installed: InstalledApp): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "arbareto-spelling-build-"));
  let app: OwnedProcess | null = null;
  try {
    const env = appEnv(root, false);
    const port = freePort();
    env.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port}`;
    app = startInstalledApp(installed, env);
    const c = await connectPage(port, ACTION_WAIT_MS);
    try {
      const text = await c.poll<string | null>(BUILD_TEXT, (v) => v !== null, MAX_WAIT_MS);
      if (text === null) throw new Error(`the boot view showed no build identity within ${MAX_WAIT_MS} ms`);
      return text;
    } finally {
      c.close();
    }
  } finally {
    app?.stop();
    if (app !== null && (await waitExit(app)) === null) throw new Error("the build probe app did not exit");
    rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  }
}

export interface Packaged {
  installed: InstalledApp | null;
  build: string | null;
  reason: string | null;
}

// The skip reason of a packaged 006 case, or null. Another instance runs as the user's app, so no probe starts then.
export async function packaged(): Promise<Packaged> {
  if (process.platform !== "win32") return { installed: null, build: null, reason: "the installed package exists only on Windows" };
  const discovery = findInstalledApp();
  if ("skip" in discovery) return { installed: null, build: null, reason: discovery.skip };
  const installed = discovery.app;
  if (GIT === null) return { installed, build: null, reason: "Git executable absent" };
  const others = processRecords().filter((r) => r.name.toLowerCase() === installed.mainBinaryName.toLowerCase());
  if (others.length > 0) return { installed, build: null, reason: `another-instance: ${installed.mainBinaryName} runs as PID ${others.map((r) => r.pid).join(", ")}` };
  const text = await readBuild(installed);
  console.log(`BUILD ${text}`);
  const match = BUILD.exec(text);
  if (match === null) throw new Error(`the build identity is not "<version> <commit>[-dirty]": ${js(text)}`);
  return { installed, build: text, reason: buildHolds(GIT, match[2]!) };
}

// ---- CDP keys ----

// DOM `key` and `code`, the winuser.h virtual-key code, and the text of a key that types one.
const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", vk: 0x0d, text: "\r" },
  Escape: { key: "Escape", code: "Escape", vk: 0x1b },
  Tab: { key: "Tab", code: "Tab", vk: 0x09 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 0x08 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 0x25 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 0x26 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 0x27 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 0x28 },
  F10: { key: "F10", code: "F10", vk: 0x79 },
  ContextMenu: { key: "ContextMenu", code: "ContextMenu", vk: 0x5d },
  x: { key: "x", code: "KeyX", vk: 0x58, text: "x" },
  z: { key: "z", code: "KeyZ", vk: 0x5a },
};
const MODIFIER_KEYS = [
  { bit: MOD.Alt, key: "Alt", code: "AltLeft", vk: 0x12 },
  { bit: MOD.Ctrl, key: "Control", code: "ControlLeft", vk: 0x11 },
  { bit: MOD.Shift, key: "Shift", code: "ShiftLeft", vk: 0x10 },
];

// As cdp.ts `keyEvents` with `typed`. CDP runs an editing command only when `commands` names it (CDP `Input.dispatchKeyEvent`).
export async function press(c: Cdp, name: string, modifiers = 0, commands?: string[]): Promise<void> {
  const k = KEYS[name];
  if (k === undefined) throw new Error(`no CDP key ${js(name)}`);
  const held = MODIFIER_KEYS.filter((m) => modifiers & m.bit);
  const typed = k.text !== undefined && modifiers === 0;
  const event = (type: KeyEvent["type"], m: { key: string; code: string; vk: number }, bits: number): KeyEvent => ({ type, key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, modifiers: bits });
  for (const m of held) await c.send("Input.dispatchKeyEvent", event("rawKeyDown", m, modifiers));
  await c.send("Input.dispatchKeyEvent", { ...event(typed ? "keyDown" : "rawKeyDown", k, modifiers), ...(commands ? { commands } : {}), ...(typed ? { text: k.text, unmodifiedText: k.text } : {}) });
  await c.send("Input.dispatchKeyEvent", event("keyUp", k, modifiers));
  for (const m of held.toReversed()) await c.send("Input.dispatchKeyEvent", event("keyUp", m, 0));
}

// ---- Page waits ----

// Polls a page expression until `done` holds, or fails at the bound with the last value.
export async function until<V>(c: Cdp, what: string, expression: string, done: (value: V) => boolean, ms = ACTION_WAIT_MS): Promise<V> {
  const value = await c.poll<V>(expression, done, ms);
  if (!done(value)) throw new Error(`${what} did not happen within ${ms} ms: ${js(value)}`);
  return value;
}

// The end of every running animation, then one frame. A closed Base UI popup stays in the DOM until its exit animation ends.
export const settle = (c: Cdp) => c.evaluate(`Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))).then(() => new Promise((done) => requestAnimationFrame(() => done(true))))`);

// Puts the caret at `offset` of the message field and gives the field the focus.
export const caret = (c: Cdp, offset: number) => c.evaluate(`(() => { const f = ${FIELD}; f.focus(); f.setSelectionRange(${offset}, ${offset}); return document.activeElement === f; })()`);

export const fieldValue = (c: Cdp) => c.evaluate<string>(`${FIELD}.value`);

// Polls a test-side probe every 50 ms until it returns a value, or fails at the bound.
export async function waitFor<V>(what: string, ms: number, probe: () => V | null | undefined | false): Promise<V> {
  for (const end = performance.now() + ms; ; await Bun.sleep(50)) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (performance.now() >= end) throw new Error(`${what} did not happen within ${ms} ms`);
  }
}

// ---- UIA steps ----

export async function uia<V>(pid: number, name: string, type: number | undefined, body: (element: Element) => V, ms = MAX_WAIT_MS): Promise<V> {
  const found = await find(pid, name, ms, type);
  try {
    return body(found);
  } finally {
    found.release();
  }
}

// ValuePattern SetValue can land before React mounts its handler, so the step repeats until the page holds the text.
export async function writeMessage(pid: number, c: Cdp, text: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await uia(pid, MESSAGE, ControlType.Edit, (field) => setValue(field, text));
    if ((await c.poll<boolean>(`${FIELD}?.value === ${js(text)}`, (v) => v, MAX_WAIT_MS)) === true) return;
  }
  throw new Error("the message field does not hold the written text");
}

// ---- App sessions ----

export interface Session {
  app: OwnedProcess;
  c: Cdp;
  env: AppEnv;
  port: number;
}

// Starts the package on an own profile below the fixture root, with the CDP endpoint on a free port.
export async function start(installed: InstalledApp, root: string, label: string, task: string): Promise<Session> {
  const env = appEnv(root, false);
  return startWith(installed, env, label, task);
}

export async function startWith(installed: InstalledApp, env: AppEnv, label: string, task: string): Promise<Session> {
  const port = freePort();
  env.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port}`;
  const app = startInstalledApp(installed, env);
  console.log(`STARTED ${task}: ${app.pid} ${label} port=${port} profile=${env.set.ARBARETO_PROFILE_ROOT}`);
  try {
    return { app, c: await connectPage(port, ACTION_WAIT_MS), env, port };
  } catch (error) {
    app.stop();
    throw error;
  }
}

// A new profile holds no Git selection, so the boot view offers Select Git (uia.test.ts T241). Then the Windows folder picker opens `repo`.
export async function openRepository(s: Session, repo: string): Promise<void> {
  if (repo === "" || !isAbsolute(repo) || relative(FIXTURE_ROOT, repo).startsWith("..")) throw new Error(`the repository is outside the fixture root: ${js(repo)}`);
  await uia(s.app.pid, "Select Git", ControlType.Button, invoke);
  await uia(s.app.pid, "Use this Git", undefined, invoke);
  await uia(s.app.pid, OPEN_FOLDER, undefined, invoke);
  await uia(s.app.pid, "Folder:", ControlType.Edit, (field) => setValue(field, repo));
  await uia(s.app.pid, "Select Folder", ControlType.Button, invoke);
  await uia(s.app.pid, "References", ControlType.Tree, () => {});
}

export async function end(s: Session): Promise<void> {
  s.c.close();
  s.app.stop();
  if ((await waitExit(s.app)) === null) throw new Error(`the app ${s.app.pid} did not exit`);
}

// ---- Workers (N1, F14) ----

export interface WorkerLog {
  sessions: { sessionId: string; type: string; url: string }[];
  // Each response with the media type that WebAssembly streaming compiles (WebAssembly Web API "compileStreaming": `application/wasm`).
  wasm: { url: string; status: number }[];
  cspIssues: string[];
  errors: string[];
}

// CDP `Target.setAutoAttach` with `flatten` attaches each worker as a session of this socket. Each worker waits until its `Network` domain runs.
export async function watchWorkers(c: Cdp): Promise<WorkerLog> {
  const log: WorkerLog = { sessions: [], wasm: [], cspIssues: [], errors: [] };
  c.on("Target.attachedToTarget", (p) => {
    const sessionId = p.sessionId as string;
    const info = p.targetInfo as { type: string; url: string };
    log.sessions.push({ sessionId, type: info.type, url: info.url });
    void (async () => {
      try {
        await c.send("Network.enable", {}, sessionId);
        await c.send("Audits.enable", {}, sessionId);
      } catch (error) {
        log.errors.push(`${info.url}: ${String(error)}`);
      } finally {
        await c.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch((error) => log.errors.push(`${info.url}: ${String(error)}`));
      }
    })();
  });
  c.on("Network.responseReceived", (p) => {
    const r = p.response as { url: string; status: number; mimeType: string };
    if (r.mimeType === "application/wasm") log.wasm.push({ url: r.url, status: r.status });
  });
  c.on("Audits.issueAdded", (p) => {
    const issue = p.issue as { code: string };
    if (issue.code === "ContentSecurityPolicyIssue") log.cspIssues.push(js(issue).slice(0, 400));
  });
  await c.send("Network.enable");
  await c.send("Audits.enable");
  await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  return log;
}

// The bytes of a page-origin URL, read by the page itself under its CSP (`connect-src 'self'`).
export async function pageBytes(c: Cdp, url: string): Promise<Buffer> {
  const base64 = await c.evaluate<string>(`fetch(${js(url)}).then((r) => r.ok ? r.arrayBuffer() : Promise.reject(new Error('HTTP ' + r.status))).then((b) => { let s = ''; const u = new Uint8Array(b); for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768)); return btoa(s); })`);
  return Buffer.from(base64, "base64");
}

export const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

// The WebView2 runtime of the page: CDP `/json/version` `Browser`.
export async function browserVersion(port: number): Promise<string> {
  const r = (await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(MAX_WAIT_MS) })).json()) as { Browser: string };
  return r.Browser;
}

// ---- Fixtures ----

// A repository with one commit and one changed file, so the Commit view opens with a message editor.
export function smallRepo(git: string, name: string): string {
  const repo = join(fixtureDir(name), "repo");
  mkdirSync(repo, { recursive: true });
  faGit(git, repo, ["init", "-q", "-b", "main"]);
  for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"]]) faGit(git, repo, ["config", key!, value!]);
  write(repo, "a.txt", "one\n");
  faGit(git, repo, ["add", "--", "a.txt"]);
  faGit(git, repo, ["commit", "-q", "--no-verify", "-m", "base"]);
  write(repo, "a.txt", "two\n");
  return repo;
}

// ---- Dictionary cache (plan.md D3 "Local test cache") ----

const CACHE = process.env.ARBARETO_DICTIONARY_CACHE;
export const CACHE_SKIP = "dictionary cache absent: set ARBARETO_DICTIONARY_CACHE";
export const cacheFolder = CACHE === undefined || CACHE === "" ? null : join(CACHE, catalog.source.commit);
// The skip reason of a catalog entry, or null when the cache holds every file of it.
export function cacheSkip(entry: CatalogEntry): string | null {
  if (cacheFolder === null) return CACHE_SKIP;
  const missing = entry.files.find((f) => !existsSync(join(cacheFolder, entry.id, f.name)));
  return missing === undefined ? null : `not-cached ${entry.id}/${missing.name}`;
}
export function cachedEntry(id: string): { entry: CatalogEntry; skip: null } | { entry: null; skip: string } {
  const entry = catalog.entries.find((e) => e.id === id);
  if (entry === undefined) return { entry: null, skip: `not-in-catalog ${id}` };
  const skip = cacheSkip(entry);
  return skip === null ? { entry, skip } : { entry: null, skip };
}

// Data-model §3: the files of the entry with the catalog size and SHA-256, and `entry.json` as `{version: 1, entry}`.
export function installDictionary(profileRoot: string, entry: CatalogEntry): void {
  if (cacheFolder === null) throw new Error(CACHE_SKIP);
  const dir = join(profileRoot, "data", "dictionaries", entry.id);
  mkdirSync(dir, { recursive: true });
  for (const file of entry.files) {
    const bytes = readFileSync(join(cacheFolder, entry.id, file.name));
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new Error(`the cached ${entry.id}/${file.name} does not match the catalog`);
    writeFileSync(join(dir, file.name), bytes);
  }
  writeFileSync(join(dir, "entry.json"), JSON.stringify({ version: 1, entry }));
}

export const cachedText = (entry: CatalogEntry, name: string) => new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(join(cacheFolder!, entry.id, name)));

// src-tauri/src/settings.rs: `<root>/config/settings.json`, key `spelling` (data-model §8).
export function setSpelling(profileRoot: string, spelling: { enabled: boolean; languages: string[] }): void {
  const file = join(profileRoot, "config", "settings.json");
  const settings = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  mkdirSync(join(profileRoot, "config"), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...settings, spelling }));
}

// A fresh profile copy: the `config` and `data` folders of `template`, without its WebView2 folder.
export function copyProfile(template: string, target: string): void {
  for (const name of ["config", "data"]) if (existsSync(join(template, name))) cpSync(join(template, name), join(target, name), { recursive: true });
}
