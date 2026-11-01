// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 008 T047: the revert actions in the installed package. Spec SC-006, SC-008, SC-009, FR-041; plan.md D8, D9, D11, D12, D13. `Local: package`; the WSL case is also `Local: WSL`, alone.
// The cases drive the page through the WebView2 CDP endpoint and UI Automation patterns. They send no OS input and never move the pointer.
// CDP keys go through `Input.dispatchKeyEvent`, as tests/windows/inspection-packaged.test.ts does. They do not replace one live-input check of the native key path.
// Dark and Light are the System theme under the CDP `prefers-color-scheme` emulation. Forced colors is the CDP `forced-colors` emulation, not a Windows contrast theme.
// Each expected text is a plan.md D11 text. Each expected byte, mode, and index entry comes from Git's own command on a copy (plan.md D13).
// The app ends through the owned Job of `installed-app.ts` `spawnOwned`, as every packaged test does. The harness has no WM_CLOSE route.

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { printOrigin } from "../origin";
import { faGit } from "../git/file-actions-fixtures";
import { fixtureDir, FIXTURE_ROOT, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { sha256 } from "../git/git-oracle";
import type { GitHost } from "../git/remote-fixtures";
import { distroGitHost, sh } from "../wsl/fixtures";
import { missingCapability, uncPath, useWslFolder, wslHost, type WslCapability, type WslHost } from "../wsl/wsl-host";
import { connectPage, freePort, keyEvents, MOD, watchIpc, type Cdp, type IpcLog } from "./cdp";
import { decodePng, formatMeasurement, measure, THRESHOLD } from "./contrast";
import { appEnv, COMMIT_VIEW, findInstalledApp, powershellJson, PROBE_TIMEOUT_MS, processRecords, startInstalledApp, WAIT_MS, waitExit, type OwnedProcess } from "./installed-app";
import { close, ControlType, find, findLiveRegions, foregroundSkip, invoke, MAX_CALL_MS, MAX_WAIT_MS, readText, setValue, waitFocus, type Element } from "./uia";

for (const helper of ["./cdp.ts", "./uia.ts", "./installed-app.ts", "./contrast.ts", "../wsl/wsl-host.ts", "../wsl/fixtures.ts"]) printOrigin(helper, import.meta.dir);
// The package under test holds these sources. The `APP` line names the installed binary and its SHA-256.
for (const source of ["../../src/frontend/changes/RevertConfirm.tsx", "../../src/frontend/changes/revert-text.ts", "../../src/frontend/changes/ComparisonView.tsx", "../../src/frontend/changes/ChangesPane.tsx"]) printOrigin(source, import.meta.dir);

const TASK = "T047";
// One wait of a UIA step can pass its bound by one call.
const STEP_MS = MAX_WAIT_MS + MAX_CALL_MS;
const caseTimeout = (steps: number) => steps * STEP_MS + 2 * PROBE_TIMEOUT_MS + 2 * WAIT_MS;
// A view change, a status read, and a service round trip after a key stay far below it.
const KEY_WAIT_MS = 10_000;
// A review, a run, and its reconcile reads.
const ACTION_WAIT_MS = 30_000;
// A WSL step runs several `wsl.exe` processes, and the first open can start the distro.
const WSL_WAIT_MS = 300_000;
const WSL_CASE_MS = 900_000;
// The holder process prints its line after one PowerShell start.
const HOLD_MS = 30_000;
// One pass over 40 presses bounds each keyboard walk.
const WALK = 40;
// Research.md R12 N4 and spec SC-009: the Windows text sizes of the check.
const SCALES = [150, 225] as const;
// Spec SC-008 names this distro.
const DISTRO = "Ubuntu-26.04";
const WSL_NEEDS: WslCapability[] = ["wsl-fixture-fs-id", "distro-git-2.55", "perl", "ubuntu-distro"];

// ---- App texts (the source of each value is named) ----

// `OPEN_FOLDER` in src/frontend/app/RepositorySwitcher.tsx.
const OPEN_FOLDER = "Open folder… (Ctrl+O)";
// Plan.md D11 `NO_UNDO`.
const NO_UNDO = "You cannot undo this.";
// Plan.md D11 "Lines title, unstaged", "Lines body, unstaged", "Lines buttons", `REVERT_DONE` lines.
const linesTitle = (n: number, file: string) => `Revert ${n} lines in ${file}?`;
const LINES_BODY = "Arbareto removes the selected changes from the working file. The index does not change.";
const LINES_BUTTON = "Revert lines";
const linesDone = (n: number, file: string) => `Arbareto reverted ${n} lines in ${file}.`;
// Plan.md D11 "Files title" (`<n>` is "1 file" for a count of 1), "Files body, one file", "Files buttons", `REVERT_DONE` files.
const FILE_TITLE = "Revert 1 file?";
const FILE_BODY = "Arbareto sets the file to its version in the last commit, in the index and in the working file. Its staged and unstaged changes are lost.";
const FILE_BUTTON = "Revert file";
const FILE_DONE = "Arbareto reverted 1 file.";
// Plan.md D11 `REVERT_FAILURE` (spec FR-041): the `sharing-violation` text, and the 005 Delete form for every other code.
const sharingText = (file: string) => `Another program has ${file} open. Arbareto did not change it. Close the file, then try again.`;
const notChanged = (file: string, code: string) => `${file}: Not changed: ${code}`;
// Plan.md D11 item labels and D12 "Changes list row menu"; the 005 group "Delete from disk" (src/frontend/changes/ChangesPane.tsx `menuGroups`).
const REVERT_FILE_ITEM = "Revert file…";
const DELETE_ITEMS = ["Delete…", "Delete permanently…"];
// Plan.md D12 "Keys": `KEYS.revertFiles.aria`.
const REVERT_KEY = "R";

// ---- The fixture file (plan.md D13 line oracle) ----

// 20 lines with a change at line 2 and at line 15. With three context lines, `git diff` gives two hunks.
const PATH = "login.txt";
const BASE = Array.from({ length: 20 }, (_, i) => `l${i + 1}\n`).join("");
const CHANGED = BASE.replace("l2\n", "L2\n").replace("l15\n", "L15\n");
// Shift+Down from no selection selects the first change row of the first hunk (`hunk-mapping.ts` `stepRange`). The next Shift+Down adds the `+L2` row.
const SELECTED = 2;

// The header and the first hunk of a one-file patch (git-diff(1) "Generating patch text with -p": each hunk starts with "@@ ").
function firstHunk(diff: string): string {
  const lines = diff.split("\n");
  const starts = lines.flatMap((l, i) => (l.startsWith("@@ ") ? [i] : []));
  if (starts.length !== 2) throw new Error(`the fixture diff has ${starts.length} hunks, not 2`);
  return `${lines.slice(0, starts[1]).join("\n")}\n`;
}
const DIFF_ARGS = ["diff", "--no-ext-diff", "--no-color", "--no-textconv", "-U3", "--", PATH];

// ---- CDP keys ----

// `cdp.ts` `keyEvents` with `typed`: Enter goes as `keyDown` with its text, so Chromium also fires the activation of a focused button.
async function press(c: Cdp, name: string, modifiers = 0): Promise<void> {
  for (const params of keyEvents(name, modifiers, { typed: true })) await c.send("Input.dispatchKeyEvent", params);
  console.log(`KEY ${TASK}: ${name} mods=${modifiers}`);
}
// A held R: one key down, then auto-repeat key downs (CDP `Input.dispatchKeyEvent` `autoRepeat`, DOM `KeyboardEvent.repeat`), then one key up.
async function holdR(c: Cdp, repeats: number): Promise<void> {
  const [down, up] = keyEvents("r");
  await c.send("Input.dispatchKeyEvent", down!);
  for (let i = 0; i < repeats; i++) await c.send("Input.dispatchKeyEvent", { ...down!, autoRepeat: true });
  await c.send("Input.dispatchKeyEvent", up!);
  console.log(`KEY ${TASK}: held r repeats=${repeats}`);
}

const js = (value: unknown) => JSON.stringify(value);
async function until<T>(c: Cdp, what: string, expression: string, done: (value: T) => boolean, ms = KEY_WAIT_MS): Promise<T> {
  const value = await c.poll<T>(expression, done, ms);
  if (!done(value)) throw new Error(`${what} did not happen within ${ms} ms: ${js(value)}`);
  return value;
}
// The page waits for the end of every running animation, then for one frame. A closed Base UI popup stays in the DOM until its exit animation ends.
const settle = (c: Cdp) => c.evaluate(`Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))).then(() => new Promise((done) => requestAnimationFrame(() => done(true))))`);

const ACTIVE = `(() => { const a = document.activeElement; return { label: a?.getAttribute('aria-label') ?? null, text: a?.textContent?.trim().slice(0, 80) ?? null, slot: a?.dataset?.slot ?? null, section: a?.closest('[data-section]')?.dataset.section ?? null, tree: a?.closest('[data-file-tree]')?.dataset.fileTree ?? null, dialog: a?.closest('[role=alertdialog]') !== null }; })()`;
type Active = { label: string | null; text: string | null; slot: string | null; section: string | null; tree: string | null; dialog: boolean };
const active = (c: Cdp) => c.evaluate<Active>(ACTIVE);
// Presses `key` until `done` holds for the focused element.
async function keyTo(c: Cdp, key: string, what: string, done: (a: Active) => boolean, modifiers = 0): Promise<void> {
  for (let i = 0; i < WALK; i++) {
    if (done(await active(c))) return;
    await press(c, key, modifiers);
  }
  if (done(await active(c))) return;
  throw new Error(`${what}: ${WALK} presses of ${key} did not reach it, the focus is on ${js(await active(c))}`);
}

const DIALOGS = `[...document.querySelectorAll('[role=alertdialog]')].filter((d) => !d.hasAttribute('data-closed') && !d.hasAttribute('data-ending-style'))`;
const DIALOG = `${DIALOGS}[0]`;
const dialogTitle = `(${DIALOG})?.querySelector('[data-slot=dialog-title]')?.textContent ?? null`;
const openDialogs = (c: Cdp) => c.evaluate<number>(`${DIALOGS}.length`);
const MENU = `[...document.querySelectorAll('[role=menu]')].find((m) => !m.hasAttribute('data-closed') && !m.hasAttribute('data-ending-style'))`;
// The status bar lines of src/frontend/status/OperationStatus.tsx: each `role=status` element of the footer.
const STATUS_LINES = `[...document.querySelectorAll('footer [role=status]')].map((e) => e.textContent)`;

// ---- Accessibility, focus, and contrast through CDP (SC-009) ----

const NAMED_ROLES = ["button", "menuitem", "treeitem"];
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

// ---- UI Automation status region ----

// Polls the polite live regions until one reads `text`, and returns the texts that the polls read (tests/windows/uia.test.ts `waitStatus`).
async function waitStatus(processId: number, text: string, ms = ACTION_WAIT_MS): Promise<string[]> {
  const seen = new Set<string>();
  for (const end = performance.now() + ms; performance.now() < end; await Bun.sleep(50)) {
    for (const region of await findLiveRegions(processId, Math.max(0, Math.ceil(end - performance.now())))) {
      try {
        seen.add(readText(region));
      } finally {
        region.release();
      }
    }
    if (seen.has(text)) return [...seen];
  }
  throw new Error(`no status region reads ${js(text)} after ${ms} ms: ${js([...seen])}`);
}

// ---- The run reply ----

type FileOutcome = { entryId: string; outcome: string; code?: string; reason?: string };
type RunReply = { state: string; code?: string; result?: { action: string; files: FileOutcome[]; index: string } };
const outcomes = (reply: RunReply) => (reply.result?.files ?? []).map((f) => ({ outcome: f.outcome, code: f.code, reason: f.reason }));
async function runReply(ipc: IpcLog, n: number, ms: number): Promise<RunReply> {
  const calls = await ipc.wait("run_workbench", n, ms);
  const reply = await ipc.body<RunReply>(calls[n - 1]!);
  console.log(`RUN_REPLY ${TASK}: state=${reply.state} code=${reply.code ?? "-"} files=${js(outcomes(reply))}`);
  return reply;
}
// Research.md R15 probe W9: with Windows Defender on, a rename can fail with STATUS_ACCESS_DENIED, and the file keeps its old bytes. Spec FR-037: no retry.
const W9 = { state: "failed", files: [{ outcome: "not-changed", code: "error", reason: "access-denied" }] };
const isW9 = (reply: RunReply) => js({ state: reply.state, files: outcomes(reply) }) === js(W9);

// ---- A holder process (research.md R15 probe W8 (b)) ----

// A holder with read access and read and write sharing, but no delete sharing: the check open succeeds, and the rename fails with STATUS_SHARING_VIOLATION.
async function holdOpen(path: string): Promise<{ pid: number; release(): Promise<void> }> {
  const script = "$f = [System.IO.File]::Open($env:T047_HOLD, 'Open', 'Read', 'ReadWrite'); [Console]::Out.WriteLine('HELD'); [Console]::Out.Flush(); [void][Console]::In.ReadLine(); $f.Close()";
  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, T047_HOLD: path }, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const release = async () => {
    proc.stdin.end();
    if ((await Promise.race([proc.exited, Bun.sleep(HOLD_MS).then(() => null)])) === null) {
      proc.kill();
      await proc.exited;
    }
    console.log(`HOLD_END ${TASK}: pid=${proc.pid} exit=${proc.exitCode}`);
  };
  const reader = proc.stdout.getReader();
  let text = "";
  for (const end = performance.now() + HOLD_MS; !text.includes("HELD\r\n") && !text.includes("HELD\n"); ) {
    const chunk = await Promise.race([reader.read(), Bun.sleep(Math.max(0, end - performance.now())).then(() => null)]);
    if (chunk === null || chunk.done) {
      proc.kill();
      await proc.exited;
      throw new Error(`the holder of ${path} did not start within ${HOLD_MS} ms: ${js(text)}`);
    }
    text += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  console.log(`HOLD ${TASK}: pid=${proc.pid}`);
  return { pid: proc.pid, release };
}

// ---- icacls(1) deny entries for the access-denied case ----

// whoami(1) `/user /fo csv /nh` prints one CSV record: the account name and its SID.
function currentSid(): string {
  const r = Bun.spawnSync(["whoami", "/user", "/fo", "csv", "/nh"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const m = /^"[^"]*","(S-1-[0-9-]+)"\r?\n?$/.exec(r.stdout.toString());
  if (r.exitCode !== 0 || m === null) throw new Error(`whoami /user exited ${r.exitCode}: ${js(r.stdout.toString())}`);
  return m[1]!;
}
function icacls(path: string, args: string[]): void {
  const r = Bun.spawnSync(["icacls", path, ...args], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`icacls ${args.join(" ")} exited ${r.exitCode}: ${r.stderr.toString()}`);
}

describe.skipIf(process.platform !== "win32")("T047 packaged revert", () => {
  // Bun 1.4.4 runs `afterAll` hooks in declaration order. This hook must come before the fixture root and the WSL folder removal.
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

  // The WSL case runs only in the distro of spec SC-008, so the owned folder is created only there.
  const host = reason === null ? wslHost() : null;
  const wslMissing = reason === null ? missingCapability(WSL_NEEDS) : null;
  const wslReason = reason ?? (wslMissing !== null ? `missing capability ${wslMissing}` : host?.distro !== DISTRO ? `missing capability wsl-distro-${DISTRO}: the WSL harness selects ${js(host?.distro ?? null)}` : null);
  if (wslReason === null) useWslFolder();
  else console.log(`SKIP ${TASK} WSL case: ${wslReason}`);

  const g = (repo: string, args: string[], input?: string) => faGit(GIT!, repo, args, input === undefined ? {} : { input });
  const indexOf = (repo: string) => g(repo, ["ls-files", "--stage", "-z"]).toString("latin1");
  const fileDigest = (repo: string, path: string) => sha256(readFileSync(join(repo, path)));
  // `RepositorySwitcher.tsx`: the trigger label is the folder name and the Git worktree root.
  const switcher = `document.querySelector('button[aria-keyshortcuts="Control+R"]')?.getAttribute('aria-label') ?? null`;

  let builds = 0;
  // One repository with `login.txt` changed at lines 2 and 15, unstaged.
  function build(name: string): string {
    const repo = join(fixtureDir(`${name}-${++builds}`), "repo");
    mkdirSync(repo, { recursive: true });
    g(repo, ["init", "-q", "-b", "main"]);
    for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"]] as const) g(repo, ["config", key, value]);
    writeFileSync(join(repo, PATH), BASE);
    g(repo, ["add", "--", PATH]);
    g(repo, ["commit", "-q", "--no-verify", "-m", "base"]);
    writeFileSync(join(repo, PATH), CHANGED);
    return repo;
  }
  // Plan.md D13 line oracle: `git apply -R` of the selected hunk on a copy. The fixture has no conversion, so the bytes must be equal.
  function linesOracle(repo: string): { digest: string; index: string } {
    const copy = join(fixtureDir(`oracle-${++builds}`), "repo");
    cpSync(repo, copy, { recursive: true });
    g(copy, ["update-index", "-q", "--refresh"]);
    g(copy, ["apply", "-R", "-"], firstHunk(g(copy, DIFF_ARGS).toString("latin1")));
    return { digest: fileDigest(copy, PATH), index: indexOf(copy) };
  }

  async function use<T>(element: Promise<Element>, body: (element: Element) => T): Promise<T> {
    const found = await element;
    try {
      return body(found);
    } finally {
      found.release();
    }
  }
  const uia = <T>(pid: number, name: string, type: number | undefined, body: (element: Element) => T, ms = MAX_WAIT_MS) => use(find(pid, name, ms, type), body);

  type Session = { app: OwnedProcess; c: Cdp; ipc: IpcLog };
  let starts = 0;
  // One app session on `folder`, with a fresh profile root: Select Git, then the folder picker. `top` is the expected switcher root, or null for a WSL folder.
  async function session(label: string, folder: string, top: string | null, ms = ACTION_WAIT_MS): Promise<Session> {
    const env = appEnv(fixtureDir(`${label}-${++starts}-app`), false);
    const port = freePort();
    env.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port}`;
    const app = startInstalledApp(installed!, env);
    owned.add(app);
    console.log(`STARTED ${TASK}: ${app.pid} ${label} port=${port} profile=${env.set.ARBARETO_PROFILE_ROOT}`);
    // A new profile holds no Git selection, so the boot view offers Select Git (uia.test.ts T241).
    await uia(app.pid, "Select Git", ControlType.Button, invoke);
    await uia(app.pid, "Use this Git", undefined, invoke);
    await uia(app.pid, OPEN_FOLDER, undefined, invoke);
    await uia(app.pid, "Folder:", ControlType.Edit, (field) => setValue(field, folder));
    await uia(app.pid, "Select Folder", ControlType.Button, invoke);
    await uia(app.pid, "References", ControlType.Tree, () => {}, ms);
    const c = await connectPage(port, MAX_WAIT_MS);
    sockets.add(c);
    if (top !== null) await until<string | null>(c, "the open repository", switcher, (v) => v === `${basename(top)}, ${top}`, ms);
    // `window.__TAURI_INTERNALS__.invoke` is read-only, so each reply comes from the CDP `Network` record of the call.
    const ipc = await watchIpc(c);
    return { app, c, ipc };
  }
  async function windowsSession(label: string, repo: string): Promise<Session> {
    if (!isAbsolute(repo) || relative(FIXTURE_ROOT, repo).startsWith("..")) throw new Error(`the repository is outside the fixture root: ${js(repo)}`);
    return session(label, repo, g(repo, ["rev-parse", "--show-toplevel"]).toString().trim());
  }
  async function end(s: Session): Promise<void> {
    s.c.close();
    sockets.delete(s.c);
    s.app.stop();
    owned.delete(s.app);
    expect(await waitExit(s.app)).not.toBeNull();
  }

  // The Commit view button, then the Changes row `path` by keyboard. The view switch focuses the Changes Tab-stop row (Workbench.tsx `focusCommitEntry`).
  async function rowByKeyboard(s: Session, path: string, ms = ACTION_WAIT_MS): Promise<void> {
    await uia(s.app.pid, COMMIT_VIEW, ControlType.Button, invoke);
    await until<boolean>(s.c, `the Changes row ${path}`, `[...document.querySelectorAll('[data-file-tree=changes] [role=treeitem]')].some((e) => e.getAttribute('aria-label') === ${js(path)})`, (v) => v, ms);
    await until<Active>(s.c, "the focus in the Changes list", ACTIVE, (a) => a.tree === "changes");
    await press(s.c, "Home");
    await keyTo(s.c, "ArrowDown", `the row ${path}`, (a) => a.tree === "changes" && a.label === path);
    // Enter on a file row selects it (ChangesPane.tsx row keys).
    await press(s.c, "Enter");
  }

  // R on the focused Changes row opens the review; the confirmation then opens with Cancel focused (plan.md D12 "Modal").
  async function fileConfirm(s: Session, ms = ACTION_WAIT_MS): Promise<void> {
    await press(s.c, "r");
    await until<string | null>(s.c, "the Revert file confirmation", dialogTitle, (v) => v === FILE_TITLE, ms);
    await until<Active>(s.c, "the first focus on Cancel", ACTIVE, (a) => a.dialog && a.text === "Cancel");
  }

  // From the selected Changes row to the diff by keyboard: F6 to the comparison section, Tab to the diff body, then two Shift+Down rows.
  async function linesSelection(s: Session, ms = ACTION_WAIT_MS): Promise<void> {
    await until<boolean>(s.c, "the diff of the selected file", `!!document.querySelector('[data-section=comparison] [data-slot=diff-body]')`, (v) => v, ms);
    await keyTo(s.c, "F6", "the comparison section", (a) => a.section === "comparison");
    await keyTo(s.c, "Tab", "the diff body", (a) => a.slot === "diff-body");
    for (let i = 0; i < SELECTED; i++) await press(s.c, "ArrowDown", MOD.Shift);
  }
  async function linesConfirm(s: Session, ms = ACTION_WAIT_MS): Promise<void> {
    await press(s.c, "r");
    await until<string | null>(s.c, "the Revert lines confirmation", dialogTitle, (v) => v === linesTitle(SELECTED, PATH), ms);
    await until<Active>(s.c, "the first focus on Cancel", ACTIVE, (a) => a.dialog && a.text === "Cancel");
  }
  // Spec SC-006: the dialog closes, no run starts, and the file and the index keep their state.
  async function closedWithoutRun(s: Session, what: string, state: () => unknown, before: unknown): Promise<void> {
    await until<number>(s.c, `the closed dialog after ${what}`, `${DIALOGS}.length`, (n) => n === 0);
    await settle(s.c);
    expect({ what, runs: s.ipc.finished("run_workbench").length + s.ipc.pending("run_workbench").length, state: state() }).toEqual({ what, runs: 0, state: before });
  }

  // ---- SC-006 and US1 by keyboard ----

  test.skipIf(reason !== null)(
    "SC-006, US1 by keyboard: R opens the modal with Cancel focused for CDP and UI Automation; Enter right after the open, Escape, and a held R change nothing; Tab to Revert lines and Enter reverts; the status region announces the result",
    async () => {
      const repo = build("t047-keys");
      const before = { digest: fileDigest(repo, PATH), index: indexOf(repo) };
      const state = () => ({ digest: fileDigest(repo, PATH), index: indexOf(repo) });
      const oracle = linesOracle(repo);
      const s = await windowsSession("keys", repo);
      try {
        await rowByKeyboard(s, PATH);
        await linesSelection(s);
        await linesConfirm(s);
        const texts = await s.c.evaluate<{ body: string | null; buttons: string[]; notice: boolean }>(
          `(() => { const d = ${DIALOG}; return { body: d.querySelector('[data-slot=dialog-description]')?.textContent ?? null, buttons: [...d.querySelectorAll('button')].map((b) => b.textContent.trim()), notice: [...d.querySelectorAll('span')].some((e) => e.textContent === ${js(NO_UNDO)}) }; })()`,
        );
        expect(texts).toEqual({ body: LINES_BODY, buttons: ["Cancel", LINES_BUTTON], notice: true });
        expect(await unnamed(s.c, DIALOG)).toEqual([]);
        expect(focusVisible(await s.c.evaluate(FOCUS_STYLE))).toBe(true);
        // UI Automation reports the focus of the foreground window only.
        const foreground = foregroundSkip(s.app.pid);
        if (foreground === null) await waitFocus(s.app.pid, "Cancel", MAX_WAIT_MS);
        else console.log(`SKIP ${TASK} UIA focus on Cancel: ${foreground} (unverified; the CDP focus is on Cancel)`);

        // Enter right after the open activates Cancel.
        await press(s.c, "Enter");
        await closedWithoutRun(s, "Enter", state, before);
        // Plan.md D12 "Modal": `finalFocus` returns the focus to the opener, and the line selection stays.
        await until<Active>(s.c, "the focus back on the diff body", ACTIVE, (a) => a.slot === "diff-body");
        await linesConfirm(s);
        await press(s.c, "Escape");
        await closedWithoutRun(s, "Escape", state, before);
        await until<Active>(s.c, "the focus back on the diff body", ACTIVE, (a) => a.slot === "diff-body");

        // R in the modal does not confirm, and a held R opens no second modal (spec FR-046).
        await linesConfirm(s);
        await holdR(s.c, 5);
        await settle(s.c);
        expect({ dialogs: await openDialogs(s.c), title: await s.c.evaluate<string | null>(dialogTitle), runs: s.ipc.finished("run_workbench").length + s.ipc.pending("run_workbench").length, state: state() }).toEqual({
          dialogs: 1,
          title: linesTitle(SELECTED, PATH),
          runs: 0,
          state: before,
        });
        console.log(`OBSERVATION ${TASK}: review_workbench replies after the held R: ${s.ipc.finished("review_workbench").length}`);

        await keyTo(s.c, "Tab", "the Revert lines button", (a) => a.dialog && a.text === LINES_BUTTON);
        expect(focusVisible(await s.c.evaluate(FOCUS_STYLE))).toBe(true);
        await press(s.c, "Enter");
        const reply = await runReply(s.ipc, 1, ACTION_WAIT_MS);
        if (isW9(reply)) {
          expect(state()).toEqual(before);
          console.log(`OBSERVATION ${TASK}: W9 the rename gave access-denied, and ${PATH} kept its old bytes (typed outcome, research.md R15)`);
          return;
        }
        expect({ state: reply.state, files: outcomes(reply) }).toEqual({ state: "succeeded", files: [{ outcome: "reverted", code: undefined, reason: undefined }] });
        expect(state()).toEqual(oracle);
        const statusTexts = await waitStatus(s.app.pid, linesDone(SELECTED, PATH));
        console.log(`STATUS ${TASK}: ${js(statusTexts)}`);
        expect((await s.c.evaluate<(string | null)[]>(STATUS_LINES)).includes(linesDone(SELECTED, PATH))).toBe(true);
      } finally {
        await end(s);
      }
    },
    caseTimeout(60),
  );

  // ---- SC-009: the row menu, the themes, forced colors, and the text sizes ----

  type Group = { label: string; danger: string | null; keys: string | null }[];
  const GROUPS = `[...(${MENU}).querySelectorAll('[data-slot=dropdown-menu-group]')].map((g) => [...g.querySelectorAll('[role=menuitem]')].map((i) => ({ label: i.querySelector('[data-slot=menu-label]')?.textContent ?? null, danger: i.getAttribute('data-danger'), keys: i.getAttribute('aria-keyshortcuts') })))`;

  test.skipIf(reason !== null)(
    "SC-009, plan.md D12: Shift+F10 on a Changes row opens the row menu with Revert file… (danger, R) in its own group directly above the Delete from disk group; every item has a name",
    async () => {
      const repo = build("t047-menu");
      const s = await windowsSession("menu", repo);
      try {
        await rowByKeyboard(s, PATH);
        await press(s.c, "F10", MOD.Shift);
        const groups = await until<Group[]>(s.c, "the row menu", `(${MENU}) ? ${GROUPS} : []`, (v) => v.length > 0);
        console.log(`MENU ${TASK}: ${js(groups)}`);
        const at = groups.findIndex((group) => group.some((i) => i.label === REVERT_FILE_ITEM));
        expect({ revert: groups[at], next: groups[at + 1]?.map((i) => i.label) }).toEqual({ revert: [{ label: REVERT_FILE_ITEM, danger: "true", keys: REVERT_KEY }], next: DELETE_ITEMS });
        expect(await unnamed(s.c, MENU)).toEqual([]);
        await press(s.c, "Escape");
        await until<Active>(s.c, "the focus back on the row", ACTIVE, (a) => a.tree === "changes" && a.label === PATH);
      } finally {
        await end(s);
      }
    },
    caseTimeout(30),
  );

  test.skipIf(reason !== null)(
    "SC-009, plan.md D12 Forced-colors and Light-theme: in Dark, Light, and forced colors the Revert file modal keeps its texts at 4.5:1, visible focus, named controls, and a danger button with a border; Escape changes nothing",
    async () => {
      const repo = build("t047-themes");
      const before = { digest: fileDigest(repo, PATH), index: indexOf(repo) };
      const s = await windowsSession("themes", repo);
      try {
        await rowByKeyboard(s, PATH);
        await fileConfirm(s);
        const body = await s.c.evaluate<string | null>(`(${DIALOG}).querySelector('[data-slot=dialog-description]')?.textContent ?? null`);
        expect(body).toBe(FILE_BODY);
        const danger = `(${DIALOG}).querySelector('button[data-danger=true]')`;
        expect(await s.c.evaluate<string | null>(`(${danger})?.textContent.trim() ?? null`)).toBe(FILE_BUTTON);
        for (const scheme of ["dark", "light", "forced"] as const) {
          await emulate(s.c, scheme);
          expect({ scheme, unnamed: await unnamed(s.c, DIALOG) }).toEqual({ scheme, unnamed: [] });
          expect({ scheme, cancel: focusVisible(await s.c.evaluate(FOCUS_STYLE)) }).toEqual({ scheme, cancel: true });
          await contrast(s.c, scheme, [
            ["title", `(${DIALOG}).querySelector('[data-slot=dialog-title]')`],
            ["body", `(${DIALOG}).querySelector('[data-slot=dialog-description]')`],
            ["no-undo", `[...(${DIALOG}).querySelectorAll('span')].find((e) => e.textContent === ${js(NO_UNDO)})`],
            ["cancel", `[...(${DIALOG}).querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel')`],
            ["danger", danger],
          ]);
          // Plan.md D12 "Modal": in forced colors, the danger button keeps its text and border.
          if (scheme === "forced") {
            const border = await s.c.evaluate<{ style: string; width: number; text: string }>(`(() => { const b = ${danger}; const st = getComputedStyle(b); return { style: st.borderTopStyle, width: Number.parseFloat(st.borderTopWidth), text: b.textContent.trim() }; })()`);
            expect({ style: border.style !== "none", width: border.width > 0, text: border.text }).toEqual({ style: true, width: true, text: FILE_BUTTON });
          }
          await keyTo(s.c, "Tab", "the danger button", (a) => a.dialog && a.text === FILE_BUTTON);
          expect({ scheme, danger: focusVisible(await s.c.evaluate(FOCUS_STYLE)) }).toEqual({ scheme, danger: true });
          await keyTo(s.c, "Tab", "Cancel", (a) => a.dialog && a.text === "Cancel");
        }
        await emulate(s.c, "dark");
        await press(s.c, "Escape");
        await closedWithoutRun(s, "Escape", () => ({ digest: fileDigest(repo, PATH), index: indexOf(repo) }), before);
      } finally {
        await end(s);
      }
    },
    caseTimeout(40),
  );

  // Spec SC-009: the text size is a user setting, so the case runs at the current size only.
  const scale = process.platform === "win32" && reason === null ? textScale() : null;
  if (scale !== null) console.log(`OBSERVATION ${TASK}: text scale ${scale}%`);
  for (const size of SCALES) {
    const scaleReason = reason ?? (scale === size ? null : `missing capability text-scale-${size}: the current text size is ${scale}% (set Settings > Accessibility > Text size to ${size}% and run again)`);
    if (scaleReason !== null && reason === null) console.log(`SKIP ${TASK} text scale ${size}%: ${scaleReason} (unverified)`);
    test.skipIf(scaleReason !== null)(
      `SC-009 at text size ${size}%: the Revert file modal and the row menu lie inside the window, the modal has no horizontal overflow, and Tab reaches the revert button`,
      async () => {
        const repo = build(`t047-scale-${size}`);
        const s = await windowsSession(`scale-${size}`, repo);
        try {
          await rowByKeyboard(s, PATH);
          await fileConfirm(s);
          const inside = `const inside = (b) => b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight;`;
          const modal = await s.c.evaluate<{ dialog: boolean; overflow: boolean; buttons: { text: string; inside: boolean }[] }>(
            `(() => { ${inside} const d = ${DIALOG}; return { dialog: inside(d.getBoundingClientRect()), overflow: d.scrollWidth > d.clientWidth, buttons: [...d.querySelectorAll('button')].map((b) => ({ text: b.textContent.trim(), inside: inside(b.getBoundingClientRect()) })) }; })()`,
          );
          console.log(`GEOMETRY ${TASK}: ${size}% modal ${js(modal)}`);
          expect(modal).toEqual({ dialog: true, overflow: false, buttons: [{ text: "Cancel", inside: true }, { text: FILE_BUTTON, inside: true }] });
          await keyTo(s.c, "Tab", "the danger button", (a) => a.dialog && a.text === FILE_BUTTON);
          await press(s.c, "Escape");
          await until<number>(s.c, "the closed dialog", `${DIALOGS}.length`, (n) => n === 0);
          await until<Active>(s.c, "the focus back on the row", ACTIVE, (a) => a.tree === "changes" && a.label === PATH);
          await press(s.c, "F10", MOD.Shift);
          await until<boolean>(s.c, "the row menu", `!!(${MENU})`, (v) => v);
          await settle(s.c);
          const menu = await s.c.evaluate<{ menu: boolean; items: { label: string | null; inside: boolean }[] }>(
            `(() => { ${inside} const m = ${MENU}; return { menu: inside(m.getBoundingClientRect()), items: [...m.querySelectorAll('[role=menuitem]')].map((i) => ({ label: i.querySelector('[data-slot=menu-label]')?.textContent ?? null, inside: inside(i.getBoundingClientRect()) })) }; })()`,
          );
          console.log(`GEOMETRY ${TASK}: ${size}% menu ${js(menu)}`);
          expect({ menu: menu.menu, outside: menu.items.filter((i) => !i.inside).map((i) => i.label), revert: menu.items.some((i) => i.label === REVERT_FILE_ITEM) }).toEqual({ menu: true, outside: [], revert: true });
          await press(s.c, "Escape");
        } finally {
          await end(s);
        }
      },
      caseTimeout(30),
    );
  }

  // ---- FR-041: a held file and a file without delete access ----

  test.skipIf(reason !== null)(
    "FR-041, probe W8: a file that another process holds without delete sharing gives the sharing-violation text, and the file and the index keep their state",
    async () => {
      const repo = build("t047-held");
      const before = { digest: fileDigest(repo, PATH), index: indexOf(repo) };
      const s = await windowsSession("held", repo);
      let hold: Awaited<ReturnType<typeof holdOpen>> | null = null;
      try {
        await rowByKeyboard(s, PATH);
        await linesSelection(s);
        await linesConfirm(s);
        hold = await holdOpen(join(repo, PATH));
        await keyTo(s.c, "Tab", "the Revert lines button", (a) => a.dialog && a.text === LINES_BUTTON);
        await press(s.c, "Enter");
        const reply = await runReply(s.ipc, 1, ACTION_WAIT_MS);
        expect({ state: reply.state, files: outcomes(reply) }).toEqual({ state: "failed", files: [{ outcome: "not-changed", code: "error", reason: "sharing-violation" }] });
        await until<(string | null)[]>(s.c, "the sharing-violation text", STATUS_LINES, (v) => v.includes(sharingText(PATH)), ACTION_WAIT_MS);
        await waitStatus(s.app.pid, sharingText(PATH));
        expect({ digest: fileDigest(repo, PATH), index: indexOf(repo) }).toEqual(before);
      } finally {
        await hold?.release();
        await end(s);
      }
    },
    caseTimeout(40),
  );

  test.skipIf(reason !== null)(
    "FR-041: a file without delete access in a folder without delete-child access gives the 005 form with access-denied, and the file and the index keep their state",
    async () => {
      const repo = build("t047-denied");
      const before = { digest: fileDigest(repo, PATH), index: indexOf(repo) };
      const sid = currentSid();
      const target = join(repo, PATH);
      // Microsoft Learn "File Security and Access Rights": a delete needs DELETE on the file or FILE_DELETE_CHILD on its folder. The rename over the target is such a delete.
      icacls(target, ["/deny", `*${sid}:(D)`]);
      icacls(repo, ["/deny", `*${sid}:(DC)`]);
      const s = await windowsSession("denied", repo).catch((error) => {
        icacls(target, ["/remove:d", `*${sid}`]);
        icacls(repo, ["/remove:d", `*${sid}`]);
        throw error;
      });
      try {
        await rowByKeyboard(s, PATH);
        await linesSelection(s);
        await linesConfirm(s);
        await keyTo(s.c, "Tab", "the Revert lines button", (a) => a.dialog && a.text === LINES_BUTTON);
        await press(s.c, "Enter");
        const reply = await runReply(s.ipc, 1, ACTION_WAIT_MS);
        expect({ state: reply.state, files: outcomes(reply) }).toEqual({ state: "failed", files: [{ outcome: "not-changed", code: "error", reason: "access-denied" }] });
        await until<(string | null)[]>(s.c, "the access-denied text", STATUS_LINES, (v) => v.includes(notChanged(PATH, "access-denied")), ACTION_WAIT_MS);
        await waitStatus(s.app.pid, notChanged(PATH, "access-denied"));
        expect({ digest: fileDigest(repo, PATH), index: indexOf(repo) }).toEqual(before);
      } finally {
        await end(s);
        icacls(target, ["/remove:d", `*${sid}`]);
        icacls(repo, ["/remove:d", `*${sid}`]);
      }
    },
    caseTimeout(40),
  );

  // Spec FR-041: the reference host cannot make a full or a read-only volume without these capabilities. The double replies of T029 cover both texts.
  for (const capability of ["full-volume", "read-only-volume"]) {
    console.log(`SKIP ${TASK} FR-041 ${capability}: missing capability ${capability} (tests/git/revert-files.test.ts T029 covers the text through the double reply)`);
    test.skip(`FR-041: the ${capability} text in the package (SKIP: ${capability})`, () => {});
  }

  // ---- SC-008: the Rust shell `wslFiles` route in the owned folder of Ubuntu-26.04 ----

  test.skipIf(wslReason !== null)(
    "SC-008, plan.md D9: in a repository of Ubuntu-26.04, the package reverts two selected lines and one whole file through the shell wslFiles route; the bytes and the index equal Git's own commands on a copy, and mode, owner, group, and link count stay",
    async () => {
      const w = host as WslHost;
      const GLOBAL = "[user]\n\tname = Arbareto Fixture\n\temail = fixture@arbareto.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n";
      const h: GitHost = distroGitHost(w, "t047", GLOBAL);
      const dir = `${h.root}/repo`;
      if (!dir.startsWith(`${w.folder}/`)) throw new Error(`outside the owned folder: ${dir}`);
      const git = (cwd: string, args: string[], input?: string) => {
        const r = h.run(cwd, args, input === undefined ? {} : { input: Buffer.from(input) });
        if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${r.exitCode}: ${r.stderr.toString()}`);
        return r.stdout;
      };
      const TOOL = "tool.sh";
      sh(w, 'mkdir -p -- "$1"', [dir]);
      git(dir, ["init", "-q", "-b", "main"]);
      for (const [key, value] of [["core.eol", "lf"], ["core.safecrlf", "false"]] as const) git(dir, ["config", key, value]);
      // `GitHost.write` gives a file that starts with `#!` the mode 755.
      h.write(`${dir}/${PATH}`, BASE);
      h.write(`${dir}/${TOOL}`, "#!/bin/sh\necho base\n");
      git(dir, ["add", "--", PATH, TOOL]);
      git(dir, ["commit", "-q", "--no-verify", "-m", "base"]);
      h.write(`${dir}/${PATH}`, CHANGED);
      h.write(`${dir}/${TOOL}`, "#!/bin/sh\necho changed\n");
      // GNU stat `%a %u %g %h`: the mode bits, the owner, the group, and the link count.
      const stats = (cwd: string) => sh(w, 'cd -- "$1" && shift && stat -c "%a %u %g %h" -- "$@"', [cwd, PATH, TOOL]).stdout.trim().split("\n");
      const state = (cwd: string) => ({ index: git(cwd, ["ls-files", "--stage", "-z"]).toString("latin1"), files: h.digests(cwd) });
      const statsBefore = stats(dir);
      // Plan.md D13 oracles on a `cp -a` copy in the distro: `apply -R` of the selected hunk, and `restore --staged --worktree --source=HEAD` for Revert file.
      const copy = `${dir}-oracle`;
      h.copy(dir, copy);
      git(copy, ["update-index", "-q", "--refresh"]);
      git(copy, ["apply", "-R", "-"], firstHunk(git(copy, DIFF_ARGS).toString("latin1")));
      const afterLines = state(copy);
      git(copy, ["restore", "--staged", "--worktree", "--source=HEAD", "--", TOOL]);
      const afterFile = state(copy);
      console.log(`WSL ${TASK}: distro=${w.distro} folder=${uncPath(w, dir)} stats=${js(statsBefore)}`);

      const s = await session("wsl", uncPath(w, dir), null, WSL_WAIT_MS);
      try {
        await rowByKeyboard(s, PATH, WSL_WAIT_MS);
        await linesSelection(s, WSL_WAIT_MS);
        await linesConfirm(s, WSL_WAIT_MS);
        await keyTo(s.c, "Tab", "the Revert lines button", (a) => a.dialog && a.text === LINES_BUTTON);
        await press(s.c, "Enter");
        const lines = await runReply(s.ipc, 1, WSL_WAIT_MS);
        expect({ state: lines.state, files: outcomes(lines) }).toEqual({ state: "succeeded", files: [{ outcome: "reverted", code: undefined, reason: undefined }] });
        await waitStatus(s.app.pid, linesDone(SELECTED, PATH), WSL_WAIT_MS);
        expect(state(dir)).toEqual(afterLines);

        // Revert file of `tool.sh` from its Changes row: Git's temporary file stays in the distro (plan.md D9 "A whole file").
        await keyTo(s.c, "F6", "the Changes list", (a) => a.tree === "changes");
        await press(s.c, "Home");
        await keyTo(s.c, "ArrowDown", `the row ${TOOL}`, (a) => a.tree === "changes" && a.label === TOOL);
        await fileConfirm(s, WSL_WAIT_MS);
        await keyTo(s.c, "Tab", "the Revert file button", (a) => a.dialog && a.text === FILE_BUTTON);
        await press(s.c, "Enter");
        const file = await runReply(s.ipc, 2, WSL_WAIT_MS);
        expect({ state: file.state, files: outcomes(file) }).toEqual({ state: "succeeded", files: [{ outcome: "reverted", code: undefined, reason: undefined }] });
        await waitStatus(s.app.pid, FILE_DONE, WSL_WAIT_MS);
        expect(state(dir)).toEqual(afterFile);
        expect(stats(dir)).toEqual(statsBefore);
      } finally {
        await end(s);
      }
    },
    WSL_CASE_MS,
  );
});
