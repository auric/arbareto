// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T041: the feature 006 spell check in the installed package (plan.md P8, WP8). Quickstart.md Q8, Q13, Q24, Q26, and "Manual checks in the packaged build".
// Spec FR-005, FR-007, FR-008, FR-026, SC-001, SC-007, SC-009. Research.md R12 F14 (again), N1 to N6, and N8. `Local: package`.
// The cases drive the page through the WebView2 CDP endpoint and UI Automation patterns. Only the live cases send OS input, and only with ARBARETO_LIVE_INPUT=1.
// Each case runs only against a 006 build: the boot view build identity must name a commit of this checkout whose tree holds this file (spelling-app.ts `buildHolds`).
// Dark and Light are the System theme under the CDP `prefers-color-scheme` emulation. Forced colors is the CDP `forced-colors` emulation, not a Windows contrast theme.

import { afterAll, describe, expect, test } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HUNSPELL_WASM_SHA256 } from "../../src/frontend/highlight/guard";
import { fixtureDir, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { printOrigin } from "../origin";
import { languageFixture } from "../support/language-fixture";
import { MOD, type Cdp } from "./cdp";
import { decodePng, formatMeasurement, measure, THRESHOLD } from "./contrast";
import { encodeInputs, INPUT_BYTES, keystroke, type KeyEvent as InputEvent } from "./inject";
import { appEnv, COMMIT_VIEW, powershellJson } from "./installed-app";
import {
  ACTION_WAIT_MS,
  browserVersion,
  CACHE_SKIP,
  cachedEntry,
  cachedText,
  caret,
  caseTimeout,
  catalog,
  CHIP,
  downloadName,
  end,
  FIELD,
  fieldValue,
  installDictionary,
  js,
  MARKS,
  MENU_LABELS,
  menuItem,
  MESSAGE,
  openRepository,
  packaged,
  pageBytes,
  press,
  settle,
  setSpelling,
  sha256,
  smallRepo,
  SETTINGS_ITEM,
  spellMenu,
  SPELLING_TAB,
  startWith,
  T,
  transportText,
  uia,
  until,
  VIEW_MENU,
  waitFor,
  watchWorkers,
  writeMessage,
  type Session,
  type WorkerLog,
} from "./spelling-app";
import { boundingRect, close, ControlType, expand, find, foregroundPid, foregroundSkip, inputDesktopSkip, invoke, MAX_WAIT_MS, textRects, type Rect } from "./uia";

for (const helper of ["./spelling-app.ts", "./contrast.ts", "./inject.ts", "../support/language-fixture.ts", "../../src/frontend/highlight/guard.ts"]) printOrigin(helper, import.meta.dir);

const TASK = "T041";
const LIVE = process.env.ARBARETO_LIVE_INPUT === "1";
// Data-model §11, the first vector. "recieve" is its only English misspelling (research.md R13 T028 N1).
const FIXTURE = "Fix the sync job so it does not recieve stale data";
const WRONG = "recieve";
const RIGHT = "receive";
// tests/support/language-fixture.ts `LATIN_NEGATIVES`: each fails Hunspell for every Latin catalog language (data-model §16).
const N4_TEXT = "Fix the sync job so it does not recieve qzxqzxqzx data\nxkcdqwvjz end";
const N4_MARKS = ["recieve", "qzxqzxqzx", "xkcdqwvjz"];
// Research.md R12 N4: the text scales of the check.
const SCALES = [100, 150, 225];
// The data-model §11 vector texts (tests/contracts/spell-words.test.ts holds the expected words).
const VECTORS = [
  "Fix the sync job so it does not recieve stale data",
  "Rename `fixtureName` in src/app.ts for v1.2.3.",
  "Ask user@host about snake_case and https://example.com/a.",
  "don't follow-up",
  "e.g. U.S. end.",
  "a `b` c `d",
  "x1 ٣abc word",
  "привіт recieve",
  "תיקון סדר התויות",
];

// quickstart.md "Manual checks in the packaged build". The tester confirms each line in the package.
const MANUAL = [
  "the marks, the chip, and the spelling menu against the Main and SpellingEdges boards",
  "the Spelling page, the failure texts, and the licence view against the SpellingPage, DictionaryFailures, and LicenceView boards",
  "the licence link opens the catalog URL in the default browser",
  "the About licence list shows the hunspell-wasm note with its two source links",
  "the WSL Global header and Save against the WslGlobal board, with the owned distro global file of a test double run only",
  "forced colors (Aquatic) and Light for the menu and the Spelling page against the ForcedColors and Light boards",
];

// ---- Accessibility, focus, and contrast through CDP (spec SC-007, FR-026) ----

// The Chromium accessibility tree gives each computed name. A control of these roles without a name breaks SC-007.
const NAMED_ROLES = ["button", "menuitem", "textbox", "checkbox", "switch", "tab", "link", "listitem"];
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

// Visible focus: the focused control draws an outline or a box shadow, or the D8 box draws its ring around the focused textarea.
const FOCUS_STYLE = `(() => { const a = document.activeElement; const s = getComputedStyle(a); const box = a.closest('[data-slot=spell-box]'); return { outline: s.outlineStyle, width: s.outlineWidth, shadow: s.boxShadow, ring: box === null ? 'none' : getComputedStyle(box).boxShadow }; })()`;
const focusVisible = (s: { outline: string; width: string; shadow: string; ring: string }) => (s.outline !== "none" && Number.parseFloat(s.width) > 0) || s.shadow !== "none" || s.ring !== "none";

type Scheme = "dark" | "light" | "forced";
async function emulate(c: Cdp, scheme: Scheme): Promise<void> {
  const features = scheme === "forced" ? [{ name: "forced-colors", value: "active" }] : [{ name: "prefers-color-scheme", value: scheme }, { name: "forced-colors", value: "none" }];
  await c.send("Emulation.setEmulatedMedia", { features });
  await settle(c);
}

// The text contrast in each element, measured in a CDP screenshot at device pixels (T179 `measure`).
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

// ---- Win32 calls that tests/windows/uia.ts and inject.ts do not export ----

const { ptr: P, i32, u32, i64 } = FFIType;
const openUser32 = () =>
  dlopen("user32.dll", {
    SendInput: { args: [u32, P, i32], returns: u32 },
    SetCursorPos: { args: [i32, i32], returns: i32 },
    WindowFromPoint: { args: [i64], returns: P },
    GetAncestor: { args: [P, u32], returns: P },
    GetWindowThreadProcessId: { args: [P, P], returns: u32 },
    SetThreadDpiAwarenessContext: { args: [i64], returns: i64 },
  }).symbols;
let user32: ReturnType<typeof openUser32> | undefined;
// The DLL exists only on Windows, so the import of this file must not open it.
const win = () => (user32 ??= openUser32());
// Microsoft Learn "DPI_AWARENESS_CONTEXT handle": a per-monitor-aware v2 thread gets physical pixels from UI Automation and SetCursorPos.
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4n;
async function physical<V>(body: () => Promise<V>): Promise<V> {
  const before = win().SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  if (BigInt(before) === 0n) throw new Error("SetThreadDpiAwarenessContext failed");
  try {
    return await body();
  } finally {
    win().SetThreadDpiAwarenessContext(BigInt(before));
  }
}
// Microsoft Learn `GetAncestor`: GA_ROOT. `WindowFromPoint` takes a POINT by value, which x64 passes as one 64-bit register.
const GA_ROOT = 2;
function ownsPixel(pid: number, x: number, y: number): boolean {
  const owner = new Uint32Array(1);
  const hwnd = win().WindowFromPoint((BigInt(y) << 32n) | (BigInt(x) & 0xffff_ffffn));
  if (hwnd === null) return false;
  const root = win().GetAncestor(hwnd, GA_ROOT);
  if (root === null) return false;
  win().GetWindowThreadProcessId(root, ptr(owner));
  return owner[0] === pid;
}
function insert(events: InputEvent[] | Buffer, count: number, what: string, pid: number): void {
  if (foregroundPid() !== pid) throw new Error(`the app (PID ${pid}) does not own the foreground window, so the case sends no input`);
  // SendInput returns the number of events that it inserted. UIPI blocks give a lower count (Microsoft Learn "SendInput").
  const bytes = Buffer.isBuffer(events) ? events : encodeInputs(events);
  const inserted = win().SendInput(count, ptr(bytes), INPUT_BYTES);
  if (inserted !== count) throw new Error(`SendInput inserted ${inserted} of ${count} events for ${what}`);
  console.log(`INPUT ${TASK}: ${what}`);
}
const liveKeys = (pid: number, stroke: string) => {
  const events = keystroke(stroke);
  insert(events, events.length, stroke, pid);
};
// winuser.h VK_APPS (the Menu key) and VK_CONTROL, VK_Z. Microsoft Learn "Keyboard Input Overview": VK_APPS is an extended key.
const KEYEVENTF_EXTENDEDKEY = 0x1;
const KEYEVENTF_KEYUP = 0x2;
const liveMenuKey = (pid: number) => insert([{ vk: 0x5d, scan: 0, flags: KEYEVENTF_EXTENDEDKEY }, { vk: 0x5d, scan: 0, flags: KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP }], 2, "Menu key", pid);
const liveUndo = (pid: number) =>
  insert(
    [
      { vk: 0x11, scan: 0, flags: 0 },
      { vk: 0x5a, scan: 0, flags: 0 },
      { vk: 0x5a, scan: 0, flags: KEYEVENTF_KEYUP },
      { vk: 0x11, scan: 0, flags: KEYEVENTF_KEYUP },
    ],
    4,
    "Ctrl+Z",
    pid,
  );
// winuser.h, x64: INPUT has `type` at 0 and MOUSEINPUT at 8, with `dwFlags` at 12 in MOUSEINPUT.
const INPUT_MOUSE = 0;
const MOUSEEVENTF_RIGHTDOWN = 0x8;
const MOUSEEVENTF_RIGHTUP = 0x10;
function rightClick(pid: number, x: number, y: number): void {
  if (!ownsPixel(pid, x, y)) throw new Error(`the app (PID ${pid}) does not own the pixel ${x},${y}, so the case sends no input`);
  if (!win().SetCursorPos(x, y)) throw new Error(`SetCursorPos(${x}, ${y}) failed`);
  const bytes = Buffer.alloc(2 * INPUT_BYTES);
  for (const [i, flags] of [MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP].entries()) {
    bytes.writeUInt32LE(INPUT_MOUSE, i * INPUT_BYTES);
    bytes.writeUInt32LE(flags, i * INPUT_BYTES + 8 + 12);
  }
  insert(bytes, 2, `right-click at ${x},${y}`, pid);
}

// ---- Mark geometry (N4) ----

// The screen rect of each mark span: the UIA rect of the textarea plus the span offset in the page, in device pixels.
async function markRects(pid: number, c: Cdp): Promise<{ word: string; rect: Rect }[]> {
  const page = await c.evaluate<{ field: { x: number; y: number }; dpr: number; spans: { word: string; x: number; y: number; width: number; height: number; rects: number }[] }>(
    `(() => { const f = ${FIELD}.getBoundingClientRect(); return { field: { x: f.x, y: f.y }, dpr: devicePixelRatio, spans: [...document.querySelectorAll('[data-slot="spell-mark"]')].map((s) => { const b = s.getBoundingClientRect(); return { word: s.textContent, x: b.x, y: b.y, width: b.width, height: b.height, rects: s.getClientRects().length }; }) }; })()`,
  );
  const edit = await uia(pid, MESSAGE, ControlType.Edit, boundingRect);
  return page.spans.map((s) => {
    if (s.rects !== 1) throw new Error(`the mark ${s.word} has ${s.rects} line boxes`);
    return { word: s.word, rect: { x: edit.x + (s.x - page.field.x) * page.dpr, y: edit.y + (s.y - page.field.y) * page.dpr, width: s.width * page.dpr, height: s.height * page.dpr } };
  });
}
const within1 = (a: Rect, b: Rect) => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1;

// Microsoft Learn "Make text bigger": HKCU\Software\Microsoft\Accessibility `TextScaleFactor` (DWORD, 100 to 225). An absent value is 100.
const textScale = () => (powershellJson(`$v = (Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Accessibility' -Name TextScaleFactor -ErrorAction SilentlyContinue).TextScaleFactor
ConvertTo-Json -Compress -InputObject $(if ($null -eq $v) { 100 } else { [int]$v })`) as number);

// Get-WinUserLanguageList: an `InputMethodTips` entry with LANGID 0411 is a Japanese input method.
const japaneseIme = () => (powershellJson(`ConvertTo-Json -Compress -InputObject @(Get-WinUserLanguageList | ForEach-Object { $_.InputMethodTips } | Where-Object { $_ -like '0411:*' }).Count`) as number) > 0;

const p = await packaged();
const installed = p.installed;
const reason = p.reason;

describe.skipIf(process.platform !== "win32")("T041 packaged spell check", () => {
  // Bun 1.4.4 runs `afterAll` hooks in declaration order. This hook must come before the fixture root removal.
  const sessions = new Set<Session>();
  afterAll(() => {
    for (const s of sessions) {
      s.c.close();
      s.app.stop();
    }
    close();
  });
  useFixtureRoot();

  if (reason !== null) console.log(`SKIP installed app: ${reason}`);
  for (const line of MANUAL) console.log(`MANUAL ${TASK}: ${line}`);
  const liveReason = reason ?? (LIVE ? inputDesktopSkip() : "live-input: set ARBARETO_LIVE_INPUT=1 in the measurement account");
  if (liveReason !== null) console.log(`SKIP ${TASK} live-input cases: ${liveReason}`);

  async function session(label: string, prepare?: (profile: string) => void): Promise<{ s: Session; repo: string; workers: WorkerLog }> {
    const repo = smallRepo(GIT!, `t041-${label}`);
    const env = appEnv(fixtureDir(`${label}-app`), false);
    prepare?.(env.set.ARBARETO_PROFILE_ROOT);
    const s = await startWith(installed!, env, label, TASK);
    sessions.add(s);
    // The workers start at the first editor show (plan.md D9), so the attach comes first.
    const workers = await watchWorkers(s.c);
    await openRepository(s, repo);
    return { s, repo, workers };
  }
  async function stop(s: Session): Promise<void> {
    sessions.delete(s);
    await end(s);
  }
  const toCommitView = (s: Session) => uia(s.app.pid, COMMIT_VIEW, ControlType.Button, invoke);
  async function marked(s: Session, text: string, expected: string[]): Promise<void> {
    await writeMessage(s.app.pid, s.c, text);
    await until<string[]>(s.c, `the marks ${js(expected)}`, MARKS, (v) => js(v) === js(expected));
  }
  async function openSpelling(s: Session): Promise<void> {
    await uia(s.app.pid, VIEW_MENU, ControlType.MenuItem, expand);
    await uia(s.app.pid, SETTINGS_ITEM, ControlType.MenuItem, invoke);
    const tab = `[...document.querySelectorAll('[role=tab]')].find((t) => t.textContent.trim() === ${js(SPELLING_TAB)})`;
    await until<boolean>(s.c, "the Spelling tab", `!!(${tab})`, (v) => v);
    await s.c.evaluate(`(${tab}).click(); true`);
    await until<boolean>(s.c, "the Spelling page", `!!document.querySelector('[data-slot=spelling-page]')`, (v) => v);
  }

  test.skipIf(reason !== null)(
    "F14, N1, Q24: the workers start under the CSP, fetch hunspell.wasm from the app origin with its pinned SHA-256, and mark English",
    async () => {
      const { s, workers } = await session("n1");
      try {
        await toCommitView(s);
        await marked(s, FIXTURE, [WRONG]);
        expect(await s.c.evaluate<string | null>(CHIP)).toBe(T.chip(["English"]));
        const wasm = await waitFor("the wasm response", ACTION_WAIT_MS, () => workers.wasm.length > 0 && workers.wasm);
        const origin = new URL(s.c.url).origin;
        const urls = [...new Set(wasm.map((w) => w.url))];
        const bytes = await pageBytes(s.c, urls[0]!);
        console.log(
          `OBSERVATION ${TASK}: N1 F14 build=${p.build} workers=${js(workers.sessions.map((w) => `${w.type} ${w.url}`))} wasm=${js(wasm)} sha256=${sha256(bytes)} bytes=${bytes.length} cspIssues=${workers.cspIssues.length} webview2=${await browserVersion(s.port)}`,
        );
        expect({ errors: workers.errors, csp: workers.cspIssues }).toEqual({ errors: [], csp: [] });
        expect({ urls: urls.length, origin: urls.every((u) => new URL(u).origin === origin), status: wasm.every((w) => w.status === 200) }).toEqual({ urls: 1, origin: true, status: true });
        expect(sha256(bytes)).toBe(HUNSPELL_WASM_SHA256);
      } finally {
        await stop(s);
      }
    },
    caseTimeout(20),
  );

  test.skipIf(reason !== null)(
    "N2, N3, Q8, FR-005 by keyboard: Shift+F10 and the Menu key on a mark open the spelling menu; Enter on a suggestion replaces the word; one Ctrl+Z restores it",
    async () => {
      const { s } = await session("menu");
      try {
        await toCommitView(s);
        await marked(s, FIXTURE, [WRONG]);
        const menu = spellMenu(WRONG);
        const inWord = FIXTURE.indexOf(WRONG) + 2;
        expect(await caret(s.c, inWord)).toBe(true);
        await press(s.c, "F10", MOD.Shift);
        await until<boolean>(s.c, "the spelling menu", `!!(${menu})`, (v) => v);
        // Plan.md D15 "Menu opening": a key opens the menu with the focus on its first item.
        expect(await s.c.evaluate<boolean>(`document.activeElement === (${menu}).querySelector('[role=menuitem]')`)).toBe(true);
        const labels = await until<string[]>(s.c, "the suggestions", MENU_LABELS(menu), (v) => !v.includes(T.finding) && v.includes(T.ignore));
        console.log(`OBSERVATION ${TASK}: FR-005 menu of ${WRONG}: ${js(labels)}`);
        const tail = [T.ignore, T.add, T.cut, T.copy, T.selectAll];
        const suggestions = labels.slice(0, labels.length - tail.length);
        expect({ tail: labels.slice(-tail.length), atMost5: suggestions.length <= 5, right: suggestions.includes(RIGHT) }).toEqual({ tail, atMost5: true, right: true });
        expect(await unnamed(s.c, menu)).toEqual([]);
        expect(focusVisible(await s.c.evaluate(FOCUS_STYLE))).toBe(true);
        for (let i = 0; i < 8 && !(await s.c.evaluate<boolean>(`document.activeElement === (${menuItem(menu, RIGHT)})`)); i++) await press(s.c, "ArrowDown");
        await press(s.c, "Enter");
        const replaced = FIXTURE.replace(WRONG, RIGHT);
        await until<string>(s.c, "the replaced word", `${FIELD}.value`, (v) => v === replaced);
        await until<string[]>(s.c, "no mark", MARKS, (v) => v.length === 0);
        // N2: one undo step. CDP runs the `undo` editing command of the native Ctrl+Z binding.
        await caret(s.c, replaced.length);
        await press(s.c, "z", MOD.Ctrl, ["undo"]);
        await until<string>(s.c, "the restored word", `${FIELD}.value`, (v) => v === FIXTURE);
        await until<string[]>(s.c, "the mark again", MARKS, (v) => js(v) === js([WRONG]));
        // N3: the Menu key with the caret in the mark.
        await caret(s.c, inWord);
        await press(s.c, "ContextMenu");
        await until<boolean>(s.c, "the spelling menu by the Menu key", `!!(${menu}) && !(${menu}).hasAttribute('data-ending-style')`, (v) => v);
        await press(s.c, "Escape");
        await settle(s.c);
        await until<boolean>(s.c, "the closed menu and the focus on the field", `!(${menu}) && document.activeElement === ${FIELD}`, (v) => v);
        expect(await fieldValue(s.c)).toBe(FIXTURE);
      } finally {
        await stop(s);
      }
    },
    caseTimeout(30),
  );

  test.skipIf(liveReason !== null)(
    "N2, N3 live: a right-click, Shift+F10, and the Menu key on a mark open the spelling menu; Shift+F10 elsewhere keeps the built-in menu; one live Ctrl+Z restores a replaced word",
    async () => {
      const { s } = await session("live");
      try {
        await toCommitView(s);
        await marked(s, FIXTURE, [WRONG]);
        const skip = foregroundSkip(s.app.pid);
        if (skip !== null) throw new Error(skip);
        const menu = spellMenu(WRONG);
        const closed = async () => {
          liveKeys(s.app.pid, "Escape");
          await settle(s.c);
          await until<boolean>(s.c, "the closed menu", `!(${menu})`, (v) => v);
        };
        await physical(async () => {
          const [mark] = await markRects(s.app.pid, s.c);
          rightClick(s.app.pid, Math.round(mark!.rect.x + mark!.rect.width / 2), Math.round(mark!.rect.y + mark!.rect.height / 2));
        });
        await until<boolean>(s.c, "the spelling menu by right-click", `!!(${menu})`, (v) => v);
        await closed();
        await caret(s.c, FIXTURE.indexOf(WRONG) + 2);
        liveKeys(s.app.pid, "Shift+F10");
        await until<boolean>(s.c, "the spelling menu by Shift+F10", `!!(${menu})`, (v) => v);
        await closed();
        await caret(s.c, FIXTURE.indexOf(WRONG) + 2);
        liveMenuKey(s.app.pid);
        await until<boolean>(s.c, "the spelling menu by the Menu key", `!!(${menu})`, (v) => v);
        await closed();
        // Elsewhere: the page `contextmenu` event keeps its default, so WebView2 shows its built-in menu (plan.md D15 "Menu opening").
        await s.c.evaluate(`(window.__t041Menu = [], addEventListener('contextmenu', (e) => window.__t041Menu.push(e.defaultPrevented)), true)`);
        await caret(s.c, FIXTURE.indexOf("sync") + 1);
        liveKeys(s.app.pid, "Shift+F10");
        expect(await until<boolean[]>(s.c, "the contextmenu event", "window.__t041Menu", (v) => v.length > 0)).toEqual([false]);
        expect(await s.c.evaluate<boolean>(`!!document.querySelector('[role=menu]')`)).toBe(false);
        liveKeys(s.app.pid, "Escape");
        // N2 on the native key path.
        await caret(s.c, FIXTURE.indexOf(WRONG) + 2);
        liveKeys(s.app.pid, "Shift+F10");
        await until<boolean>(s.c, "the spelling menu", `!!(${menu})`, (v) => v);
        await until<string[]>(s.c, "the suggestions", MENU_LABELS(menu), (v) => v.includes(RIGHT));
        for (let i = 0; i < 8 && !(await s.c.evaluate<boolean>(`document.activeElement === (${menuItem(menu, RIGHT)})`)); i++) liveKeys(s.app.pid, "Down");
        liveKeys(s.app.pid, "Enter");
        await until<string>(s.c, "the replaced word", `${FIELD}.value`, (v) => v === FIXTURE.replace(WRONG, RIGHT));
        liveUndo(s.app.pid);
        await until<string>(s.c, "the restored word", `${FIELD}.value`, (v) => v === FIXTURE);
      } finally {
        await stop(s);
      }
    },
    caseTimeout(40),
  );

  test.skipIf(reason !== null)(
    "N4, Q13: at the current text scale, the UIA TextPattern rect of each marked word equals its mirror span rect within 1 device pixel, also for a Hebrew line",
    async () => {
      const scale = textScale();
      console.log(`OBSERVATION ${TASK}: N4 text scale ${scale}%`);
      for (const other of SCALES.filter((v) => v !== scale)) console.log(`SKIP ${TASK} N4 at ${other}%: missing capability text-scale-${other} (unverified; set Settings > Accessibility > Text size to ${other}% and run again)`);
      const he = cachedEntry("he");
      if (he === null) console.log(`SKIP ${TASK} N4 Hebrew line: ${CACHE_SKIP} (unverified)`);
      const hebrew = he === null ? null : languageFixture(cachedText(he, "index.aff"), cachedText(he, "index.dic"));
      const hebrewLine = hebrew === null ? null : `${hebrew.positives[0]} ${hebrew.negatives[0]} ${hebrew.positives[1]}`;
      const { s } = await session("n4", (profile) => {
        if (he === null) return;
        installDictionary(profile, he);
        setSpelling(profile, { enabled: true, languages: ["en", "he"] });
      });
      try {
        await toCommitView(s);
        const text = hebrewLine === null ? N4_TEXT : `${N4_TEXT}\n${hebrewLine}`;
        await marked(s, text, hebrewLine === null ? N4_MARKS : [...N4_MARKS, hebrew!.negatives[0]!]);
        await physical(async () => {
          const spans = await markRects(s.app.pid, s.c);
          const field = await find(s.app.pid, MESSAGE, MAX_WAIT_MS, ControlType.Edit);
          try {
            for (const { word, rect } of spans) {
              const ranges = textRects(field, word);
              console.log(`OBSERVATION ${TASK}: N4 scale=${scale} word=${word} uia=${js(ranges)} mirror=${js(rect)}`);
              expect({ word, one: ranges?.length === 1, within: ranges?.length === 1 && within1(ranges[0]!, rect) }).toEqual({ word, one: true, within: true });
            }
          } finally {
            field.release();
          }
        });
      } finally {
        await stop(s);
      }
    },
    caseTimeout(30),
  );

  // Research.md R12 N5: the composition must come from the Japanese IME. No harness of tests/windows switches the input method of the app window.
  const imeSkip = reason ?? (japaneseIme() ? "ime-driver: no test harness drives a Japanese IME composition" : "japanese-ime: no Japanese input method in Get-WinUserLanguageList");
  console.log(`SKIP ${TASK} N5: missing capability ${imeSkip} (unverified)`);
  test.skip(`N5, Q13: a Japanese IME composition shows no mark, and afterwards the marks equal the typed text (SKIP: ${imeSkip})`, () => {});

  // Research.md R12 N6: the case runs inside Windows Sandbox (scripts/windows/clean-install.wsb, `<Networking>Disable</Networking>`), where the tester sets ARBARETO_TEST_SANDBOX=1.
  const sandboxSkip = reason ?? (process.env.ARBARETO_TEST_SANDBOX === "1" ? null : "windows-sandbox: run inside scripts/windows/clean-install.wsb with ARBARETO_TEST_SANDBOX=1");
  if (sandboxSkip !== null) console.log(`SKIP ${TASK} N6: missing capability ${sandboxSkip} (unverified)`);
  test.skipIf(sandboxSkip !== null)(
    "N6, Q24, SC-001, FR-007, FR-010: without networking, US1 passes, and Download shows the transport text and keeps no file",
    async () => {
      // .NET `NetworkInterface.GetIsNetworkAvailable`: false when no interface other than loopback and tunnel is up.
      expect(powershellJson("ConvertTo-Json -Compress -InputObject ([System.Net.NetworkInformation.NetworkInterface]::GetIsNetworkAvailable())")).toBe(false);
      const { s } = await session("n6");
      try {
        await toCommitView(s);
        await marked(s, FIXTURE, [WRONG]);
        expect(await s.c.evaluate<string | null>(CHIP)).toBe(T.chip(["English"]));
        const entry = catalog.entries[0]!;
        await openSpelling(s);
        await uia(s.app.pid, downloadName(entry.name), ControlType.Button, invoke);
        await until<boolean>(s.c, "the transport text", `document.body.innerText.includes(${js(transportText(entry.name))})`, (v) => v, 130_000);
        const folder = join(s.env.set.ARBARETO_PROFILE_ROOT, "data", "dictionaries");
        const left = existsSync(folder) ? readdirSync(folder) : [];
        // Data-model §3: the staging name is `.staging-<id>-<32 hex>`.
        expect(left.filter((name) => name === entry.id || new RegExp(`^\\.staging-${entry.id.replaceAll("-", "\\-")}-[0-9a-f]{32}$`).test(name))).toEqual([]);
      } finally {
        await stop(s);
      }
    },
    caseTimeout(30, 130_000),
  );

  test.skipIf(reason !== null)(
    "N8: the data-model §11 vector texts give the same Intl.Segmenter word segments in each WebView2 worker as in Bun",
    async () => {
      const { s, workers } = await session("n8");
      try {
        await toCommitView(s);
        await marked(s, FIXTURE, [WRONG]);
        const sessions = workers.sessions.filter((w) => w.type === "worker");
        expect(sessions.length).toBeGreaterThan(0);
        const segments = `(${js(VECTORS)}).map((text) => text.split('\\n').map((line) => [...new Intl.Segmenter('und', { granularity: 'word' }).segment(line)].filter((x) => x.isWordLike).map((x) => [x.segment, x.index])))`;
        const bun = (0, eval)(segments) as unknown;
        for (const w of sessions) {
          const r = (await s.c.send("Runtime.evaluate", { expression: segments, returnByValue: true }, w.sessionId)) as { result: { value?: unknown }; exceptionDetails?: unknown };
          expect(r.exceptionDetails).toBeUndefined();
          console.log(`OBSERVATION ${TASK}: N8 worker=${w.url} same=${js(r.result.value) === js(bun)}`);
          expect(r.result.value).toEqual(bun);
        }
      } finally {
        await stop(s);
      }
    },
    caseTimeout(20),
  );

  test.skipIf(reason !== null)(
    "Q26, SC-007, FR-026: by keyboard the Spelling page switch and licence view work; the editor, the menu, and the page have names, visible focus, and a text contrast of at least 4.5:1 in Dark, Light, and forced colors; the wave stays in forced colors",
    async () => {
      const { s } = await session("a11y");
      try {
        await toCommitView(s);
        await marked(s, FIXTURE, [WRONG]);
        await caret(s.c, FIXTURE.indexOf(WRONG) + 2);
        expect(focusVisible(await s.c.evaluate(FOCUS_STYLE))).toBe(true);
        const menu = spellMenu(WRONG);
        await press(s.c, "F10", MOD.Shift);
        await until<string[]>(s.c, "the suggestions", MENU_LABELS(menu), (v) => !v.includes(T.finding) && v.includes(T.ignore));
        const label = (text: string) => `(${menuItem(menu, text)})?.querySelector('[data-slot=menu-label]')`;
        for (const scheme of ["dark", "light", "forced"] as const) {
          await emulate(s.c, scheme);
          await contrast(s.c, scheme, [
            ["chip", `document.querySelector('[data-slot="spell-chip"]')`],
            ["menu item Ignore", label(T.ignore)],
            ["menu item Add to dictionary", label(T.add)],
          ]);
          // Plan.md D16: in forced colors the wave keeps its shape and takes CanvasText.
          const wave = await s.c.evaluate<{ line: string; style: string }>(`(() => { const st = getComputedStyle(document.querySelector('[data-slot="spell-mark"]')); return { line: st.textDecorationLine, style: st.textDecorationStyle }; })()`);
          expect({ scheme, wave }).toEqual({ scheme, wave: { line: "underline", style: "wavy" } });
        }
        await emulate(s.c, "dark");
        await press(s.c, "Escape");
        await settle(s.c);
        await openSpelling(s);
        const page = `document.querySelector('[data-slot=spelling-page]')`;
        expect(await unnamed(s.c, page)).toEqual([]);
        // The switch by keyboard: Enter on a focused button runs its activation behavior (HTML "button" element).
        const sw = `document.querySelector('[data-slot=spelling-page] [role=switch]')`;
        await s.c.evaluate(`(${sw}).focus(); true`);
        expect(focusVisible(await s.c.evaluate(FOCUS_STYLE))).toBe(true);
        const before = await s.c.evaluate<string | null>(`(${sw}).getAttribute('aria-checked')`);
        await press(s.c, "Enter");
        await until<string | null>(s.c, "the switch change", `(${sw}).getAttribute('aria-checked')`, (v) => v !== before);
        await press(s.c, "Enter");
        await until<string | null>(s.c, "the switch back", `(${sw}).getAttribute('aria-checked')`, (v) => v === before);
        // src/frontend/settings/SpellingPage.tsx `SPELLING_PAGE.name.showLicence`: the English row is the bundled row.
        const show = `document.querySelector('[data-slot=spelling-page] button[aria-label="Show licence of English"]')`;
        await s.c.evaluate(`(${show}).focus(); true`);
        await press(s.c, "Enter");
        const licence = `document.querySelector('[data-slot=licence-panel] [role=document]')`;
        await until<boolean>(s.c, "the licence view", `(${licence})?.textContent.trim().length > 0`, (v) => v);
        for (const scheme of ["dark", "light", "forced"] as const) {
          await emulate(s.c, scheme);
          await contrast(s.c, scheme, [
            ["page heading", `document.querySelector('[data-slot=spelling-page] h3')`],
            ["switch label", `(${sw}).nextElementSibling`],
          ]);
        }
        await s.c.send("Emulation.setEmulatedMedia", { features: [] });
        await press(s.c, "Escape");
        await until<boolean>(s.c, "the closed licence view", `!(${licence})`, (v) => v);
      } finally {
        await stop(s);
      }
    },
    caseTimeout(40),
  );

  // Spec FR-025: the package writes the real global file of the distro user, and no test touches that file. The manual check covers US2 with a test double.
  console.log(`SKIP ${TASK} US2 keyboard run in the package: missing capability owned-distro-global (unverified; quickstart.md manual check "WSL Global header and Save")`);
  test.skip("Q26 US2 keyboard run in the package (SKIP: owned-distro-global)", () => {});
});
