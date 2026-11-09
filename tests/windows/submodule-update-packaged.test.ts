// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T154, T158, T161 (feature 004 WP39, plan D20): the time from Update submodules to the first update step in the installed package. `Local: package`.
// Spec SC-021. T145 runs this file on a fresh package and records the result in research.md R31.
// The cases drive the page through the WebView2 CDP endpoint and UI Automation patterns. They send no OS input and never move the pointer.
// Page timing uses the page clock: from the `timeStamp` of the click to the first animation frame whose page holds the result.
// T145 records without a budget (`RECORD` lines): the Job CPU and peak committed memory of the app tree, the long tasks of each timed span, and the app cold runs.

import { afterAll, describe, expect, test } from "bun:test";
import { release } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { printOrigin } from "../origin";
import { fixtureDir, FIXTURE_ROOT, ownedGit, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { gitExit } from "../git/history-diff-fixtures";
import { connectPage, freePort, MOD, watchIpc, type Cdp, type IpcLog } from "./cdp";
import type { JobAccounting } from "../git/win32";
import { appEnv, descendants, findInstalledApp, PROBE_TIMEOUT_MS, processRecords, startInstalledApp, WAIT_MS, waitExit, type OwnedProcess } from "./installed-app";
import { markParts, marksShown, movedTwins, otherRepo, replyMarks, sameMarks } from "./submodule-tree-fixture";
import { close, ControlType, find, invoke, MAX_CALL_MS, MAX_WAIT_MS, setValue, type Element } from "./uia";

for (const helper of ["./cdp.ts", "./uia.ts", "./installed-app.ts", "./submodule-tree-fixture.ts"]) printOrigin(helper, import.meta.dir);

const TASK = "T154";
console.log(`OS ${TASK}: os=${release()}`);
const STEP_MS = MAX_WAIT_MS + MAX_CALL_MS;
const caseTimeout = (steps: number, extraMs = 0) => steps * STEP_MS + 2 * PROBE_TIMEOUT_MS + 2 * WAIT_MS + extraMs;
const KEY_WAIT_MS = 10_000;
// Research R31 "List time" and "Update time": the largest budget is 310 s for 1,024 rows.
const LIST_WAIT_MS = 600_000;

// ---- Budgets and sample counts (spec SC-021). Fixed before the first measured run (constitution VII). ----

// Spec SC-021: warm, median of 10 counted runs after one warm-up run.
const RUNS = 10;
// Spec SC-021 and its amendment of 2026-11-04: the median time from the click to "Updating 1 of <n>". The T154, T158, and T161 controls set a value to 1.
const UPDATE_MS: Record<number, number> = { 20: 10_000, 100: 36_000, 256: 85_000, 1_024: 310_000 };
// T145, the feature 010 rule (commit-menu-perf.test.ts): app cold is the first timed run after a new app start. The OS file cache stays warm. A record without a budget.
const COLD_SIZES: readonly number[] = [20, 100];

// ---- App texts (the source of each value is named) ----

// `OPEN_FOLDER` in src/frontend/app/RepositorySwitcher.tsx.
const OPEN_FOLDER = "Open folder… (Ctrl+O)";
// `markParts` of tests/windows/submodule-tree-fixture.ts.
const NO_BRANCH = "no branch";
// Contract Δ12 "Branch marks": the mark of a moved twin row, without `rowId`.
const DETACHED = { state: "detached" };
// The header status of a run in src/frontend/submodules/SubmodulesGroup.tsx.
const updating = (n: number) => `Updating 1 of ${n.toLocaleString("en-US")}`;
// The IPC commands of the list review, the update, and the 005 marks read (src/frontend/bridge.ts `command`).
const SUBMODULE_CALLS = ["review_submodules", "update_submodules", "read_submodule_work"];

// DOM `key` and `code`, and the winuser.h virtual-key code. `cdp.ts` has no O key.
const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", vk: 0x0d, text: "\r" },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 0x28 },
  o: { key: "o", code: "KeyO", vk: 0x4f, text: "o" },
  r: { key: "r", code: "KeyR", vk: 0x52, text: "r" },
};
const CTRL = { key: "Control", code: "ControlLeft", vk: 0x11 };
// A key with text and no modifier goes as `keyDown`, so Chromium also fires the activation of a focused button.
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
const UPDATE = `${GROUP}?.querySelector('[data-submodules-update]')`;
const CANCEL = `[...(${GROUP}?.querySelectorAll('[data-slot=group-header] button') ?? [])].find((e) => e.textContent === 'Cancel')`;
const headerShows = (text: string) => `[...(${GROUP}?.querySelectorAll('[data-slot=group-header] [data-slot=header-status]') ?? [])].some((e) => e.textContent === ${js(text)})`;

describe.skipIf(process.platform !== "win32")("T154 packaged Update submodules start time", () => {
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

  const git = (repo: string, args: string[]) => ownedGit(GIT!, FIXTURE_ROOT, repo, args).toString("utf8");
  const top = (repo: string) => git(repo, ["rev-parse", "--show-toplevel"]).trim();
  // `RepositorySwitcher.tsx`: the trigger label is the folder name and the Git worktree root.
  const switcher = `document.querySelector('button[aria-keyshortcuts="Control+R"]')?.getAttribute('aria-label') ?? null`;
  const switcherLabel = (repo: string) => `${basename(top(repo))}, ${top(repo)}`;
  const at = (repo: string, path: string) => join(repo, ...path.split("/"));

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
  async function openFolder(s: Session, repo: string): Promise<void> {
    await blur(s.c);
    await press(s.c, "o", MOD.Ctrl);
    await pickFolder(s.app.pid, repo);
    await until<string | null>(s.c, `the open ${repo}`, switcher, (v) => v === switcherLabel(repo), LIST_WAIT_MS);
  }
  const RECENT_FILTER = `document.querySelector('[role=combobox][aria-label="Filter recent repositories"]')`;
  const activeOption = `document.getElementById(${RECENT_FILTER}?.getAttribute('aria-activedescendant') ?? '')?.getAttribute('aria-label') ?? null`;
  // Ctrl+R, then the arrow keys to the recent entry of `repo`. Enter opens it.
  async function switchTo(s: Session, repo: string): Promise<void> {
    const label = switcherLabel(repo);
    await blur(s.c);
    await press(s.c, "r", MOD.Ctrl);
    await until<boolean>(s.c, "the recent repositories filter", `document.activeElement === ${RECENT_FILTER}`, (v) => v);
    await until<boolean>(s.c, `the recent entry ${label}`, `[...document.querySelectorAll('[role=listbox][aria-label="Recent repositories"] [role=option]')].some((e) => e.getAttribute('aria-label') === ${js(label)})`, (v) => v);
    for (let i = 0; i < 8 && (await s.c.evaluate<string | null>(activeOption)) !== label; i++) await press(s.c, "ArrowDown");
    expect(await s.c.evaluate<string | null>(activeOption)).toBe(label);
    await press(s.c, "Enter");
    await until<string | null>(s.c, `the open ${repo}`, switcher, (v) => v === label, LIST_WAIT_MS);
  }
  // No submodule IPC call is pending, so a run starts with no read or update in flight.
  async function idle(s: Session): Promise<void> {
    const pending = () => SUBMODULE_CALLS.reduce((sum, command) => sum + s.ipc.pending(command).length, 0);
    for (const stop = performance.now() + LIST_WAIT_MS; pending() > 0; await Bun.sleep(50)) {
      if (performance.now() >= stop) throw new Error(`a submodule call still runs after ${LIST_WAIT_MS} ms`);
    }
  }
  // Each HEAD detached at `head` again. A canceled step can leave changed files, so the switch discards them.
  function detachAll(repo: string, paths: readonly string[], head: string): void {
    for (const p of paths) git(at(repo, p), ["switch", "-q", "--discard-changes", "--detach", head]);
  }
  // Switches away and back, so the next run starts from a new read of `repo`. Every row then shows the mark of a detached HEAD.
  async function reopen(s: Session, repo: string, other: string, paths: readonly string[]): Promise<void> {
    await switchTo(s, other);
    await idle(s);
    await switchTo(s, repo);
    await until<boolean>(s.c, `the marks of ${repo}`, marksShown(paths, NO_BRANCH), (v) => v, LIST_WAIT_MS);
    await idle(s);
    // Above `VIRTUAL_MIN` shown rows, the DOM holds only the mounted marks. The reply holds all of them.
    expect(await replyMarks(s.ipc)).toEqual(sameMarks(paths, DETACHED));
  }
  // Activates Update submodules of the group with Enter. The time runs from the `click` event to the first animation frame with "Updating 1 of <n>".
  // `record` holds the T145 records: the Job CPU from before the Enter key to the result in the test, and the long tasks of the timed span.
  async function timedUpdate(s: Session, n: number): Promise<{ ms: number; record: string }> {
    const check = headerShows(updating(n));
    expect(await s.c.evaluate<boolean>(check)).toBe(false);
    await until<boolean>(s.c, "the enabled Update submodules", `((e) => e !== null && e !== undefined && !e.disabled && e.getAttribute('aria-disabled') !== 'true')(${UPDATE})`, (v) => v);
    await s.c.evaluate(LONG_TASKS);
    await s.c.evaluate(`(() => {
      window.__t154 = null;
      const button = ${UPDATE};
      button.addEventListener('click', (e) => {
        const start = e.timeStamp;
        const step = () => {
          const now = performance.now();
          if (${check}) return void (window.__t154 = { ok: true, ms: now - start, start, end: now });
          if (now - start > ${LIST_WAIT_MS}) return void (window.__t154 = { ok: false, ms: now - start, start, end: now });
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }, { capture: true, once: true });
      button.focus();
      return true;
    })()`);
    await until<boolean>(s.c, "the Update submodules focus", `document.activeElement === (${UPDATE})`, (v) => v);
    const before = s.app.accounting();
    await press(s.c, "Enter");
    const r = (await until<{ ok: boolean; ms: number; start: number; end: number } | null>(s.c, "the timed update", "window.__t154", (v) => v !== null, LIST_WAIT_MS + 10_000))!;
    const after = s.app.accounting();
    if (!r.ok) throw new Error(`"${updating(n)}" did not show within ${LIST_WAIT_MS} ms of the click`);
    const record = `${cpuText(before, after)}; ${stallText(await stalls(s.c, r.start, r.end))}`;
    // The run stops at its first step. The rows stay for the next run.
    await s.c.evaluate(`((e) => (e.click(), true))(${CANCEL})`);
    await idle(s);
    return { ms: r.ms, record };
  }

  // ---- Fixture (no app) ----

  test.skipIf(GIT === null)(
    "T154 fixture: each moved twin row has HEAD detached at main and its gitlink at the release/2.x tip, which the clone holds",
    () => {
      const m = movedTwins(GIT!, fixtureDir("check-moved"), 20);
      const gitlinks = git(m.repo, ["ls-files", "-s", "-z"])
        .split("\0")
        .filter((r) => r.startsWith("160000 "))
        .map((r) => [r.slice(r.indexOf("\t") + 1), r.split(" ")[1]]);
      expect(gitlinks.toSorted()).toEqual(m.paths.map((p) => [p, m.target]).toSorted());
      const rows = m.paths.map((p) => ({
        mark: markParts(GIT!, at(m.repo, p)),
        head: git(at(m.repo, p), ["rev-parse", "HEAD"]).trim(),
        // git-cat-file(1) `-e`: exit 0 when the object exists.
        held: gitExit(GIT!, FIXTURE_ROOT, at(m.repo, p), ["cat-file", "-e", `${m.target}^{commit}`]).exitCode === 0,
      }));
      expect(new Set(rows.map((r) => js(r)))).toEqual(new Set([js({ mark: [NO_BRANCH], head: m.head, held: true })]));
      expect(m.head).not.toBe(m.target);
    },
    5 * 60_000,
  );

  // ---- SC-021: the time to the first update step ----

  for (const n of [20, 100, 256, 1_024]) {
    const budget = UPDATE_MS[n]!;
    test.skipIf(reason !== null)(
      `SC-021: with ${n.toLocaleString("en-US")} moved submodules, "Updating 1 of ${n.toLocaleString("en-US")}" shows within ${budget} ms of the Update submodules click (median of ${RUNS} after one warm-up run)`,
      async () => {
        const m = movedTwins(GIT!, fixtureDir(`sc021-${n}`), n);
        const other = otherRepo(GIT!, fixtureDir(`sc021-${n}-other`));
        let s = await session(`sc021-${n}`, other);
        try {
          // The open registers a recent entry for the switches.
          await openFolder(s, m.repo);
          await until<boolean>(s.c, `the marks of ${m.repo}`, marksShown(m.paths, NO_BRANCH), (v) => v, LIST_WAIT_MS);
          await idle(s);
          expect(await replyMarks(s.ipc)).toEqual(sameMarks(m.paths, DETACHED));
          const times: number[] = [];
          // Run 0 is the warm-up run.
          for (let run = 0; run <= RUNS; run++) {
            const { ms, record } = await timedUpdate(s, n);
            if (run > 0) times.push(ms);
            else console.log(`OBSERVATION ${TASK}: SC-021 ${n} warm-up run ${ms.toFixed(1)} ms`);
            console.log(`RECORD ${TASK}: SC-021 ${n} run ${run}: ${ms.toFixed(1)} ms; ${record}`);
            detachAll(m.repo, m.paths, m.head);
            if (run < RUNS) await reopen(s, m.repo, other, m.paths);
          }
          const mid = median(times);
          console.log(`OBSERVATION ${TASK}: SC-021 ${n} rows: runs ${js(rounded(times))} ms, median ${mid.toFixed(1)} ms, max ${Math.max(...times).toFixed(1)} ms, budget ${budget} ms`);
          // T145 app cold: the first timed run of a new app. The last run leaves `m.repo` open, so the next app restores it. The marks come from the new read.
          if (COLD_SIZES.includes(n)) {
            await end(s);
            s = await restart(`sc021-${n}`, m.repo);
            await until<boolean>(s.c, `the marks of ${m.repo}`, marksShown(m.paths, NO_BRANCH), (v) => v, LIST_WAIT_MS);
            await idle(s);
            const { ms, record } = await timedUpdate(s, n);
            console.log(`RECORD ${TASK}: SC-021 ${n} cold (app cold, OS file cache warm, no budget): ${ms.toFixed(1)} ms; ${record}`);
            detachAll(m.repo, m.paths, m.head);
          }
          expect({ n, runs: times.length, median: mid <= budget }).toEqual({ n, runs: RUNS, median: true });
        } finally {
          await end(s);
        }
      },
      caseTimeout(60 + 20 * (RUNS + 2), (RUNS + 4) * 4 * LIST_WAIT_MS),
    );
  }
});
