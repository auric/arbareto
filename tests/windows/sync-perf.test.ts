// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 003 T077: the SC-003 and SC-004 records in the installed package (plan.md P12, N-2). `Local: package`.
// The statistic and the pass rule run first on sample data. Those cases need no app and always run.
// SC-003 reads the names of the References tree through UI Automation. SC-004 takes the end of an operation from its IPC reply (contract Δ3 `sync`, `clone`).
// Each timed span is an upper bound: it starts at the last sample before the start event and ends after the sample that saw the end.
// The app cases take the foreground and run for many minutes, so they run only with `ARBARETO_LIVE_INPUT=1` in the 001 T165 measurement account.
// Cold runs need a reboot that the user starts: `ARBARETO_SYNC_COLD=prepare`, then one `ARBARETO_SYNC_COLD=run` after each reboot.
// Control mutation: set BUDGET.counts to 1; the sample pass case and every SC-003 app case must fail.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { TERMINAL_STATES } from "../../src/contracts/errors";
import { SUBMODULE_UPDATE_INACTIVITY_MS } from "../../src/contracts/limits";
import { fixtureDir, FIXTURE_ROOT, ownedPath, removeTree, useFixtureRoot } from "../git/fixture-root";
import { fixtureGitPath, GIT } from "../git/git-binary";
import { buildCredentialRemote, buildMany, credentialHelper, gitOut, gitRun, HTTP_PASSWORD, HTTP_USER, MANY_BRANCHES, manyCounts, manyName, nativeEnv, nativeHost, type GitHost } from "../git/remote-fixtures";
import { printOrigin } from "../origin";
import { startHttpRemote, type HttpRemote } from "../support/http-remote";
import { connectPage, freePort, keyEvents, MOD, watchIpc, type Cdp, type IpcCall } from "./cdp";
import { appEnv, findInstalledApp, PROBE_TIMEOUT_MS, powershellJson, processRecords, startInstalledApp, WAIT_MS, waitExit, type AppEnv, type OwnedProcess } from "./installed-app";
import { PERF_CACHE_ROOT } from "./perf-fixtures";
import { median } from "./ratio";
import { close, ControlType, expand, find, inputDesktopSkip, invoke, isEnabled, MAX_CALL_MS, MAX_WAIT_MS, readText, readValue, setValue, UiaError, type Element } from "./uia";

for (const helper of ["./cdp.ts", "./uia.ts", "./installed-app.ts", "./ratio.ts", "./perf-fixtures.ts", "../support/http-remote.ts", "../git/remote-fixtures.ts"]) printOrigin(helper, import.meta.dir);
for (const source of ["../../src/contracts/errors.ts", "../../src/contracts/limits.ts", "../../src/frontend/refs/ReferencesSidebar.tsx", "../../src/frontend/state/tracking.ts", "../../src/frontend/status/OperationStatus.tsx", "../../src/frontend/sync/SyncToolbar.tsx", "../../src/frontend/clone/CloneDialog.tsx"]) printOrigin(source, import.meta.dir);

const TASK = "T077";
const LIVE = process.env.ARBARETO_LIVE_INPUT === "1";
const COLD = process.env.ARBARETO_SYNC_COLD;

// ---- Budgets and series (the source of each value is named) ----

// Spec SC-003: 1 s. Spec SC-004: 5 s to a reconciled or unknown state, 20 s to the stall notice.
const BUDGET = { counts: 1_000, end: 5_000, stall: 20_000 } as const;
// 001 plan.md "Measurements and budgets": 20 counted warm runs (Warm reopen row) and 10 cold runs after a reboot on M (Cold usable workspace row).
const WARM_RUNS = 20;
const COLD_RUNS = 10;
// 001 plan.md "Measurements and budgets", Cancellation row: twenty controlled slow-operation runs.
const CANCEL_RUNS = 20;
// shortcut: one limit run per operation, because each run waits 5 minutes. Raise it when plan.md fixes a run count for the SC-004 limit.
const LIMIT_RUNS = 1;

// ---- Statistic and pass rule (001 plan.md "Responsiveness metrics": every run, median, nearest-rank p95, maximum) ----

type Summary = { n: number; median: number; p95: number; max: number };
type Verdict = "pass" | "fail" | "unverified";

function summarize(values: readonly number[]): Summary {
  if (values.length === 0) return { n: 0, median: Number.NaN, p95: Number.NaN, max: Number.NaN };
  const sorted = values.toSorted((a, b) => a - b);
  return { n: values.length, median: median(sorted), p95: sorted[Math.ceil(0.95 * sorted.length) - 1]!, max: sorted.at(-1)! };
}

// SC-003 and SC-004 bound each run, so one run above the budget fails the series. A series with fewer runs than it needs is unverified, never a pass.
function verdict(values: readonly number[], budgetMs: number, required: number): Verdict {
  const bad = values.filter((v) => !Number.isFinite(v) || v < 0);
  if (bad.length > 0) throw new Error(`a run time is not a finite nonnegative number: ${JSON.stringify(bad)}`);
  if (values.some((v) => v > budgetMs)) return "fail";
  return values.length < required ? "unverified" : "pass";
}

function report(series: string, values: readonly number[], budgetMs: number, required: number): Verdict {
  const s = summarize(values);
  const v = verdict(values, budgetMs, required);
  console.log(`SERIES ${TASK} ${series}: runs ${JSON.stringify(values.map((x) => Math.round(x * 10) / 10))}`);
  console.log(`SUMMARY ${TASK} ${series}: n=${s.n} of ${required} median=${s.median.toFixed(1)} ms p95=${s.p95.toFixed(1)} ms max=${s.max.toFixed(1)} ms budget=${budgetMs} ms verdict=${v}`);
  return v;
}

describe("T077 statistic and pass rule on sample data", () => {
  // Sample data in ms: 20 runs, the slowest one exactly at the budget.
  const SAMPLE = [412, 388, 455, 402, 397, 1000, 420, 431, 399, 405, 418, 392, 440, 409, 401, 395, 427, 411, 403, 398];

  test("the summary gives the median, the nearest-rank p95, and the maximum", () => {
    expect(summarize(SAMPLE)).toEqual({ n: 20, median: 407, p95: 455, max: 1000 });
    expect(summarize([7])).toEqual({ n: 1, median: 7, p95: 7, max: 7 });
  });

  test("every run at or below the budget with the full run count passes", () => {
    expect(verdict(SAMPLE, BUDGET.counts, WARM_RUNS)).toBe("pass");
  });

  test("one run above the budget fails, also in an incomplete series", () => {
    expect(verdict([...SAMPLE.slice(0, 5), 1000.1, ...SAMPLE.slice(6)], BUDGET.counts, WARM_RUNS)).toBe("fail");
    expect(verdict([1000.1], BUDGET.counts, WARM_RUNS)).toBe("fail");
    expect(verdict([5000.1], BUDGET.end, CANCEL_RUNS)).toBe("fail");
    expect(verdict([20_000.1], BUDGET.stall, LIMIT_RUNS)).toBe("fail");
  });

  test("a series with fewer runs than it needs is unverified, also an empty one", () => {
    expect(verdict(SAMPLE.slice(1), BUDGET.counts, WARM_RUNS)).toBe("unverified");
    expect(verdict([], BUDGET.counts, COLD_RUNS)).toBe("unverified");
  });

  test("a missing or negative run time refuses the series", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) expect(() => verdict([400, bad], BUDGET.counts, 2)).toThrow("finite nonnegative");
  });
});

// ---- App texts (the source of each value is named) ----

// `OPEN_FOLDER` in src/frontend/app/RepositorySwitcher.tsx.
const OPEN_FOLDER = "Open folder… (Ctrl+O)";
// The heading of src/frontend/refs/ReferencesSidebar.tsx names the tree.
const REFERENCES = "References";
// src/frontend/status/OperationStatus.tsx `STALL_NOTICE` (contract §6 "Activity and stall notice").
const STALL_NOTICE = "Git may be waiting for a prompt that Arbareto cannot show, or for a sign-in window. To answer a hidden prompt, select Cancel and run this command in a terminal.";
// src/frontend/app/RepositoryMenu.tsx and src/frontend/clone/CloneDialog.tsx.
const REPOSITORY = "Repository";
const CLONE_ITEM = "Clone…";
const CLONE_URL = "Remote URL";
const CLONE_DESTINATION = "Destination folder";
const CLONE_BUTTON = "Clone";

// ReferencesSidebar.tsx row name: `<name>, local branch, → <upstream>, <a> ahead, <b> behind` (tracking.ts `countLabel`).
const MANY = Array.from({ length: MANY_BRANCHES }, (_, i) => {
  const name = manyName(i);
  const [ahead, behind] = manyCounts(i);
  const base = `${name}, local branch, → origin/${name}`;
  return { name, ahead, behind, base, full: `${base}, ${ahead} ahead, ${behind} behind` };
});

// The operations of SC-004. `button` is the UIA Name of the start control (SyncToolbar.tsx, PullSplitButton.tsx). `cancel` is `Cancel <SYNC_NAMES[action]>`.
type Op = "fetch" | "pull" | "push" | "clone";
const OPS: Record<Op, { button: string; cancel: string; command: string }> = {
  fetch: { button: "Fetch", cancel: "Cancel Fetch", command: "sync" },
  pull: { button: "Pull", cancel: "Cancel Pull", command: "sync" },
  push: { button: "Push", cancel: "Cancel Push", command: "sync" },
  clone: { button: CLONE_BUTTON, cancel: "Cancel", command: "clone" },
};

// ---- Bounds ----

const STEP_MS = MAX_WAIT_MS + MAX_CALL_MS;
// An open of the 200-branch fixture and its count read.
const OPEN_WAIT_MS = 30_000;
// The end of an operation after a Cancel. It is far above the 5-second budget, so a slow end gives a number, not a time-out.
const END_WAIT_MS = 60_000;
const POLL_MS = 50;
const STOP_MS = 10_000;
const SETUP_MS = 5 * 60_000;
const INACTIVITY_MS = SUBMODULE_UPDATE_INACTIVITY_MS;
// UIA_E_ELEMENTNOTAVAILABLE: a render replaced the element.
const UIA_E_ELEMENTNOTAVAILABLE = 0x8004_0201;

const js = (value: unknown) => JSON.stringify(value);

// Microsoft Learn `Win32_OperatingSystem.LastBootUpTime`. The FILETIME text keeps all digits.
function bootTime(): string {
  return powershellJson("ConvertTo-Json ([string](Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToFileTimeUtc())") as string;
}

const COLD_DIR = ownedPath(PERF_CACHE_ROOT, "t077-sc003-cold");
const COLD_STATE = join(COLD_DIR, "state.json");
type ColdState = { boot: string; runs: { boot: string; ms: number }[] };
const readCold = (): ColdState | null => (existsSync(COLD_STATE) ? (JSON.parse(readFileSync(COLD_STATE, "utf8")) as ColdState) : null);

describe.skipIf(process.platform !== "win32")("T077 packaged SC-003 and SC-004 records", () => {
  // Bun 1.4.4 runs `afterAll` hooks in declaration order. This hook must come before the fixture root removal.
  const owned = new Set<OwnedProcess>();
  const sockets = new Set<Cdp>();
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
    installed === null
      ? (discovery as { skip: string }).skip
      : GIT === null
        ? "Git executable absent"
        : others.length > 0
          ? `another-instance: ${installed.mainBinaryName} runs as PID ${others.map((r) => r.pid).join(", ")}`
          : !LIVE
            ? "live input needs the measurement account: set ARBARETO_LIVE_INPUT=1 (001 T165); the cases take the foreground and run for many minutes"
            : inputDesktopSkip();
  if (reason !== null) console.log(`SKIP ${TASK}: ${reason}`);
  // A cold step runs alone, so no other case warms the caches first.
  const warmReason = reason ?? (COLD !== undefined ? `ARBARETO_SYNC_COLD=${COLD} runs only the cold step` : null);
  const coldState = reason === null && COLD === "run" ? readCold() : null;
  const coldReason =
    reason ??
    (COLD === "prepare"
      ? null
      : COLD !== "run"
        ? "cold runs need a reboot that the user starts: set ARBARETO_SYNC_COLD=prepare, reboot, then set ARBARETO_SYNC_COLD=run after each reboot"
        : coldState === null
          ? "no prepared cold fixture: run ARBARETO_SYNC_COLD=prepare first"
          : coldState.boot === bootTime()
            ? "no reboot since the last cold step: the user must reboot before each cold run"
            : null);
  if (coldReason !== null) console.log(`SKIP ${TASK} cold: ${coldReason}`);

  // ---- UIA helpers ----

  async function use<T>(element: Promise<Element>, body: (element: Element) => T): Promise<T> {
    const found = await element;
    try {
      return body(found);
    } finally {
      found.release();
    }
  }
  const uia = <T>(pid: number, name: string, type: number | undefined, body: (element: Element) => T) => use(find(pid, name, MAX_WAIT_MS, type), body);

  // A render can replace the element, so each poll finds it again. Returns `performance.now()` just before the Invoke call.
  async function invokeWhenEnabled(pid: number, name: string, type: number, ms = MAX_WAIT_MS): Promise<number> {
    for (const end = performance.now() + ms; ; await Bun.sleep(10)) {
      const element = await find(pid, name, Math.max(0, Math.ceil(end - performance.now())), type);
      try {
        if (isEnabled(element)) {
          const at = performance.now();
          invoke(element);
          return at;
        }
      } catch (error) {
        if (!(error instanceof UiaError && error.hresult === UIA_E_ELEMENTNOTAVAILABLE)) throw error;
      } finally {
        element.release();
      }
      if (performance.now() >= end) throw new Error(`${js(name)} was not enabled within ${ms} ms`);
    }
  }

  async function setField(pid: number, name: string, text: string): Promise<void> {
    for (const end = performance.now() + MAX_WAIT_MS; ; await Bun.sleep(10)) {
      const field = await find(pid, name, Math.max(0, Math.ceil(end - performance.now())), ControlType.Edit);
      try {
        if (isEnabled(field) && readValue(field) !== text) setValue(field, text);
        if (readValue(field) === text) return;
      } catch (error) {
        if (!(error instanceof UiaError && error.hresult === UIA_E_ELEMENTNOTAVAILABLE)) throw error;
      } finally {
        field.release();
      }
      if (performance.now() >= end) throw new Error(`${js(name)} did not take ${js(text)} within ${MAX_WAIT_MS} ms`);
    }
  }

  // A search with a zero bound reads the tree once.
  async function present(pid: number, name: string, type?: number): Promise<boolean> {
    try {
      (await find(pid, name, 0, type)).release();
      return true;
    } catch (error) {
      if (error instanceof UiaError && error.code === "TIMEOUT") return false;
      throw error;
    }
  }

  // The joined row names of the References tree, or null without the tree (uia.ts `readText`).
  async function treeNames(pid: number): Promise<string | null> {
    let tree: Element;
    try {
      tree = await find(pid, REFERENCES, 0, ControlType.Tree);
    } catch (error) {
      if (error instanceof UiaError && error.code === "TIMEOUT") return null;
      throw error;
    }
    try {
      return readText(tree);
    } catch (error) {
      if (error instanceof UiaError && error.hresult === UIA_E_ELEMENTNOTAVAILABLE) return null;
      throw error;
    } finally {
      tree.release();
    }
  }

  type CountRun = { ms: number; shownAfterMs: number; mounted: number; polls: number; longestPollMs: number };

  // From the last read without a fixture branch row to the first read in which every mounted fixture row has its count label.
  // The tree is virtual above 200 rows (ReferencesSidebar.tsx `VIRTUAL_MIN`), so only the mounted rows can show a count.
  async function timeCounts(pid: number, absentSince: number): Promise<CountRun> {
    let absentAt = absentSince;
    let shownAt: number | null = null;
    let polls = 0;
    let longest = 0;
    for (const end = absentSince + OPEN_WAIT_MS; ; await Bun.sleep(1)) {
      const s = performance.now();
      const names = await treeNames(pid);
      const e = performance.now();
      polls++;
      longest = Math.max(longest, e - s);
      const mounted = names === null ? [] : MANY.filter((row) => names.includes(row.base));
      if (mounted.length === 0) {
        if (shownAt !== null) throw new Error("the fixture branch rows left the References tree");
        absentAt = s;
      } else {
        shownAt ??= e;
        if (mounted.every((row) => names!.includes(row.full))) return { ms: e - absentAt, shownAfterMs: shownAt - absentAt, mounted: mounted.length, polls, longestPollMs: longest };
      }
      if (e >= end) {
        const missing = mounted.filter((row) => !names!.includes(row.full)).map((row) => row.name);
        throw new Error(`the counts did not show within ${OPEN_WAIT_MS} ms: tree ${names === null ? "absent" : `with ${mounted.length} fixture rows`}, rows without their count label ${js(missing.slice(0, 10))}`);
      }
    }
  }

  // ---- Sessions ----

  type Reply = IpcCall & { at: number };
  type Session = { app: OwnedProcess; c: Cdp; env: AppEnv; replies: Reply[]; body<T>(call: IpcCall): Promise<T> };

  // Each Git call of the app uses this owned global file. The empty value clears the system helpers, so Git Credential Manager never stores the fixture credential.
  function credentialConfig(h: GitHost, env: AppEnv): void {
    const file = env.set.GIT_CONFIG_GLOBAL;
    const helper = credentialHelper(HTTP_USER, HTTP_PASSWORD);
    gitRun(h, h.root, ["config", "--file", file, "--add", "credential.helper", ""]);
    gitRun(h, h.root, ["config", "--file", file, "--add", "credential.helper", helper]);
    const proc = Bun.spawnSync([fixtureGitPath(GIT!), "config", "--get-all", "--show-scope", "credential.helper"], { cwd: h.root, env: env.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: PROBE_TIMEOUT_MS });
    const lines = proc.stdout.toString().split("\n").filter((l) => l !== "");
    expect({ exit: proc.exitCode, last: lines.slice(-2) }).toEqual({ exit: 0, last: ["global\t", `global\t${helper}`] });
  }

  function inside(root: string, path: string): string {
    const full = resolve(path);
    if (!isAbsolute(full) || relative(root, full).startsWith("..")) throw new Error(`the folder is outside ${js(root)}: ${js(full)}`);
    return full;
  }
  const switcherName = (repo: string) => {
    const top = Bun.spawnSync([fixtureGitPath(GIT!), "rev-parse", "--show-toplevel"], { cwd: repo, env: nativeEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
    if (top === "") throw new Error(`git rev-parse --show-toplevel gave nothing in ${js(repo)}`);
    return `${basename(top)}, ${top}`;
  };

  // The Windows folder picker: the Edit has the Name of its label, and its dialog window has the Name of the OK button. Returns the time before the confirm.
  async function pickFolder(pid: number, root: string, repo: string): Promise<number> {
    await uia(pid, "Folder:", ControlType.Edit, (field) => setValue(field, inside(root, repo)));
    return uia(pid, "Select Folder", ControlType.Button, (button) => {
      const at = performance.now();
      invoke(button);
      return at;
    });
  }

  async function start(root: string, label: string, configure?: (env: AppEnv) => void): Promise<Session> {
    const env = appEnv(root, false);
    configure?.(env);
    const port = freePort();
    env.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port}`;
    const app = startInstalledApp(installed!, env);
    owned.add(app);
    console.log(`STARTED ${TASK} ${label}: ${app.pid} port=${port} profile=${env.set.ARBARETO_PROFILE_ROOT}`);
    const c = await connectPage(port, MAX_WAIT_MS);
    sockets.add(c);
    const replies: Reply[] = [];
    const ipc = await watchIpc(c, (call) => replies.push({ ...call, at: performance.now() }));
    return { app, c, env, replies, body: (call) => ipc.body(call) };
  }

  // A new profile holds no Git selection, so the boot view offers Select Git (uia.test.ts T241).
  async function session(root: string, label: string, repoRoot: string, repo: string, configure?: (env: AppEnv) => void): Promise<Session> {
    const s = await start(root, label, configure);
    await uia(s.app.pid, "Select Git", ControlType.Button, invoke);
    await uia(s.app.pid, "Use this Git", undefined, invoke);
    await uia(s.app.pid, OPEN_FOLDER, undefined, invoke);
    await pickFolder(s.app.pid, repoRoot, repo);
    await uia(s.app.pid, switcherName(repo), ControlType.Button, () => {});
    return s;
  }

  // The keyboard handler takes Ctrl+O only outside an editable element (src/frontend/keyboard/shortcuts.ts). Returns the time before the confirm.
  async function openFolder(s: Session, repo: string): Promise<number> {
    await s.c.evaluate(`(document.activeElement?.blur?.(), true)`);
    for (const params of keyEvents("o", MOD.Ctrl, { typed: true })) await s.c.send("Input.dispatchKeyEvent", params);
    return pickFolder(s.app.pid, FIXTURE_ROOT, repo);
  }

  async function stopApp(app: OwnedProcess): Promise<void> {
    owned.delete(app);
    app.stop();
    if ((await waitExit(app)) === null) throw new Error(`the app PID ${app.pid} did not exit within ${WAIT_MS} ms`);
  }

  // The read_tracking reply of the open: every fixture branch has its fixture counts (contract Δ3 `readTracking`).
  async function expectTracking(s: Session, since: number): Promise<void> {
    let call: Reply | undefined;
    for (const end = performance.now() + MAX_WAIT_MS; (call = s.replies.slice(since).findLast((r) => r.command === "read_tracking")) === undefined; await Bun.sleep(POLL_MS)) {
      if (performance.now() >= end) throw new Error(`no read_tracking reply within ${MAX_WAIT_MS} ms of the open`);
    }
    const reply = await s.body<{ state: string; result?: { entries: { name: string; track: unknown }[] } }>(call);
    const byName = new Map((reply.result?.entries ?? []).map((e) => [e.name, e.track]));
    expect({ state: reply.state, tracks: MANY.map((row) => byName.get(row.name)) }).toEqual({ state: "succeeded", tracks: MANY.map((row) => ({ state: "counts", ahead: row.ahead, behind: row.behind })) });
  }

  const runLine = (series: string, k: number, r: CountRun) =>
    console.log(`RUN ${TASK} ${series} ${k}: ${r.ms.toFixed(1)} ms (sidebar after ${r.shownAfterMs.toFixed(1)} ms; ${r.mounted} mounted rows; ${r.polls} reads, longest ${r.longestPollMs.toFixed(1)} ms)`);

  // ---- SC-003 warm ----

  test.skipIf(warmReason !== null)(
    "SC-003 warm: on the 200-branch fixture, every mounted branch row shows its count label within 1 s after the sidebar shows, in 20 counted reopens after one discarded run",
    async () => {
      const h = nativeHost(GIT!, "t077-warm");
      const { clone } = buildMany(h);
      const small = `${h.root}/small`;
      gitRun(h, h.root, ["init", "-q", "-b", "main", "--", small]);
      gitRun(h, small, ["commit", "-q", "--allow-empty", "-m", "small"]);
      const s = await session(fixtureDir(`${TASK}-warm-app`), "warm", FIXTURE_ROOT, small);
      const runs: number[] = [];
      for (let k = 0; k <= WARM_RUNS; k++) {
        const since = s.replies.length;
        const absent = await openFolder(s, clone);
        const r = await timeCounts(s.app.pid, absent);
        runLine("warm", k, r);
        if (k === 0) console.log(`DISCARDED ${TASK} warm: run 0 (001 warm-up rule)`);
        else runs.push(r.ms);
        await expectTracking(s, since);
        await openFolder(s, small);
        await uia(s.app.pid, switcherName(small), ControlType.Button, () => {});
      }
      expect(report("SC-003 warm", runs, BUDGET.counts, WARM_RUNS)).toBe("pass");
    },
    SETUP_MS + (WARM_RUNS + 1) * (2 * OPEN_WAIT_MS + 4 * STEP_MS) + 8 * STEP_MS + 2 * PROBE_TIMEOUT_MS,
  );

  // ---- SC-003 cold ----

  test.skipIf(coldReason !== null)(
    "SC-003 cold: the first app start after a reboot reopens the retained 200-branch fixture, and every mounted branch row shows its count label within 1 s after the sidebar shows",
    async () => {
      const cold = coldState;
      if (COLD === "prepare") {
        if (existsSync(COLD_DIR)) removeTree(COLD_DIR);
        mkdirSync(join(COLD_DIR, "app"), { recursive: true });
        const h = nativeHost(GIT!, "t077-cold");
        const { clone } = buildMany(h);
        const repo = join(COLD_DIR, "many");
        cpSync(clone, repo, { recursive: true, verbatimSymlinks: true });
        // The retained repository and Git selection live in the profile (001 plan.md "Measurements and budgets", cold timing).
        const s = await session(join(COLD_DIR, "app"), "cold-prepare", COLD_DIR, repo);
        await timeCounts(s.app.pid, performance.now());
        await stopApp(s.app);
        writeFileSync(COLD_STATE, js({ boot: bootTime(), runs: [] } satisfies ColdState));
        console.log(`PREPARED ${TASK} cold: reboot, then run with ARBARETO_SYNC_COLD=run and ARBARETO_LIVE_INPUT=1; repeat ${COLD_RUNS} times`);
        return;
      }
      const boot = bootTime();
      const before = performance.now();
      const s = await start(join(COLD_DIR, "app"), "cold");
      const r = await timeCounts(s.app.pid, before);
      const runs = [...cold!.runs, { boot, ms: r.ms }];
      runLine("cold", runs.length, r);
      await stopApp(s.app);
      writeFileSync(COLD_STATE, js({ boot, runs } satisfies ColdState));
      const v = report("SC-003 cold", runs.map((x) => x.ms), BUDGET.counts, COLD_RUNS);
      if (v === "unverified") console.log(`OBSERVATION ${TASK}: SC-003 cold has ${runs.length} of ${COLD_RUNS} runs; it stays unverified until the series is complete`);
      expect(r.ms).toBeLessThanOrEqual(BUDGET.counts);
    },
    SETUP_MS + 2 * OPEN_WAIT_MS + 8 * STEP_MS + 2 * PROBE_TIMEOUT_MS + 2 * WAIT_MS,
  );

  // ---- SC-004 ----

  type Sync = { h: GitHost; http: HttpRemote; repo: string; url: string; s: Session };

  // A failure of the body stays the reported failure. A cleanup failure is reported only when the body passed.
  async function guarded(body: () => Promise<void>, cleanup: () => Promise<unknown[]>): Promise<void> {
    let failed = false;
    try {
      await body();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const errors = await cleanup();
      if (errors.length > 0) {
        if (failed) console.log(`CLEANUP ${TASK}: ${errors.map(String).join("; ")}`);
        else throw new AggregateError(errors, "the cleanup failed");
      }
    }
  }

  // A clone whose `origin` is the T004 HTTP remote. `main` tracks `origin/main` and has one local commit, so a push has work.
  async function withSync(label: string, body: (x: Sync) => Promise<void>): Promise<void> {
    const h = nativeHost(GIT!, `t077-${label}`);
    const served = `${h.root}/served`;
    mkdirSync(served, { recursive: true });
    const bare = buildCredentialRemote(h, served);
    const http = startHttpRemote({ git: fixtureGitPath(GIT!), projectRoot: served, user: HTTP_USER, password: HTTP_PASSWORD, env: nativeEnv() });
    console.log(`SERVERS ${TASK} ${label}: http port=${http.port}`);
    await guarded(
      async () => {
        const url = `${http.url}/cred.git`;
        const repo = `${h.root}/repo`;
        gitRun(h, h.root, ["clone", "-q", "--", bare, repo]);
        for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"]] as const) gitRun(h, repo, ["config", key, value]);
        gitRun(h, repo, ["remote", "set-url", "origin", url]);
        gitRun(h, repo, ["commit", "-q", "--allow-empty", "-m", "local"]);
        expect(gitOut(h, repo, ["for-each-ref", "--format=%(upstream)", "refs/heads/main"]).trim()).toBe("refs/remotes/origin/main");
        const s = await session(fixtureDir(`${TASK}-${label}-app`), label, FIXTURE_ROOT, repo, (env) => credentialConfig(h, env));
        await body({ h, http, repo, url, s });
      },
      async () => {
        const errors: unknown[] = [];
        await http.stop().catch((error) => void errors.push(error));
        if (!http.ended()) errors.push(new Error("a CGI process of the HTTP remote has no exit record"));
        return errors;
      },
    );
  }

  const refsOf = (x: Sync) => gitOut(x.h, x.repo, ["for-each-ref", "--format=%(refname) %(objectname)"]) + gitOut(x.h, x.repo, ["rev-parse", "HEAD"]);

  // Opens the clone panel through the Repository menu (UIA ExpandCollapse and Invoke).
  async function openClone(pid: number): Promise<void> {
    await uia(pid, REPOSITORY, ControlType.MenuItem, expand);
    await uia(pid, CLONE_ITEM, ControlType.MenuItem, invoke);
  }

  // Starts `op`. A clone gets a new missing destination under the fixture root. Returns the time before the Invoke call.
  async function startOp(x: Sync, op: Op, k: number): Promise<number> {
    const pid = x.s.app.pid;
    if (op === "clone") {
      await setField(pid, CLONE_URL, x.url);
      await setField(pid, CLONE_DESTINATION, inside(FIXTURE_ROOT, `${x.h.root}/clone-${k}`).replaceAll("/", "\\"));
    }
    return invokeWhenEnabled(pid, OPS[op].button, ControlType.Button, END_WAIT_MS);
  }

  async function reply(x: Sync, op: Op, since: number, ms: number): Promise<Reply> {
    for (const end = performance.now() + ms; ; await Bun.sleep(POLL_MS)) {
      const r = x.s.replies.slice(since).find((call) => call.command === OPS[op].command);
      if (r !== undefined) return r;
      if (performance.now() >= end) throw new Error(`no ${OPS[op].command} reply within ${ms} ms`);
    }
  }

  async function stateOf(x: Sync, r: Reply): Promise<string> {
    const body = await x.s.body<{ state?: string; code?: string }>(r);
    console.log(`REPLY ${TASK}: ${r.command} state=${body.state} code=${body.code ?? "none"}`);
    expect(TERMINAL_STATES as readonly string[]).toContain(body.state);
    return body.state!;
  }

  const OP_LIST: Op[] = ["fetch", "pull", "push", "clone"];

  for (const op of OP_LIST) {
    test.skipIf(reason !== null)(
      `SC-004 Cancel, ${op}: with the T004 pause switch on, ${CANCEL_RUNS} runs each reach a reconciled or unknown state within 5 s of the Cancel invoke`,
      async () => {
        await withSync(`cancel-${op}`, async (x) => {
          if (op === "clone") await openClone(x.s.app.pid);
          const times: number[] = [];
          for (let k = 0; k < CANCEL_RUNS; k++) {
            const before = op === "clone" ? null : refsOf(x);
            const since = x.s.replies.length;
            const requests = x.http.requests();
            x.http.pause();
            try {
              await startOp(x, op, k);
              // The operation runs: the remote got a request and the Cancel control is enabled.
              for (const end = performance.now() + MAX_WAIT_MS; x.http.requests() === requests; await Bun.sleep(POLL_MS)) {
                if (performance.now() >= end) throw new Error(`the ${op} sent no request within ${MAX_WAIT_MS} ms`);
              }
              const t0 = await invokeWhenEnabled(x.s.app.pid, OPS[op].cancel, ControlType.Button);
              const r = await reply(x, op, since, END_WAIT_MS);
              times.push(r.at - t0);
              console.log(`RUN ${TASK} cancel ${op} ${k}: ${(r.at - t0).toFixed(1)} ms`);
              await stateOf(x, r);
            } finally {
              x.http.resume();
            }
            if (before !== null) expect(refsOf(x)).toBe(before);
          }
          expect(report(`SC-004 cancel ${op}`, times, BUDGET.end, CANCEL_RUNS)).toBe("pass");
        });
      },
      SETUP_MS + CANCEL_RUNS * (END_WAIT_MS + 6 * STEP_MS) + 10 * STEP_MS + 2 * STOP_MS + 2 * PROBE_TIMEOUT_MS,
    );
  }

  for (const op of OP_LIST) {
    test.skipIf(reason !== null)(
      `SC-004 limit and stall, ${op}: with the T004 pause switch on, the stall notice shows within 20 s of the last request, and the inactivity end reaches a reconciled or unknown state within 5 s of the limit`,
      async () => {
        await withSync(`limit-${op}`, async (x) => {
          if (op === "clone") await openClone(x.s.app.pid);
          const stalls: number[] = [];
          const ends: number[] = [];
          for (let k = 0; k < LIMIT_RUNS; k++) {
            const since = x.s.replies.length;
            const started = x.http.responsesStarted();
            x.http.pause();
            try {
              // `prevAt` is the sample before the last request count rise. The last transfer of Git comes at or after it.
              let count = x.http.requests();
              let sampleAt = performance.now();
              let prevAt = sampleAt;
              const t0 = await startOp(x, op, k);
              let noticeAt: number | null = null;
              let r: Reply | undefined;
              for (const end = t0 + INACTIVITY_MS + END_WAIT_MS; r === undefined; await Bun.sleep(POLL_MS)) {
                const at = performance.now();
                const now = x.http.requests();
                if (now !== count) {
                  count = now;
                  prevAt = sampleAt;
                }
                sampleAt = at;
                if (noticeAt === null && (await present(x.s.app.pid, STALL_NOTICE))) {
                  noticeAt = performance.now();
                  console.log(`STALL ${TASK} ${op} ${k}: notice ${(noticeAt - prevAt).toFixed(1)} ms after the last request`);
                }
                r = x.s.replies.slice(since).find((call) => call.command === OPS[op].command);
                if (r === undefined && at >= end) throw new Error(`no ${OPS[op].command} reply within ${INACTIVITY_MS + END_WAIT_MS} ms`);
              }
              const done = r!;
              // The paused remote passed no response, so the last transfer is the last request.
              expect(x.http.responsesStarted()).toBe(started);
              // The inactivity limit cannot end the operation before 5 minutes after the start invoke.
              expect(done.at - t0).toBeGreaterThanOrEqual(INACTIVITY_MS);
              ends.push(done.at - (t0 + INACTIVITY_MS));
              console.log(`RUN ${TASK} limit ${op} ${k}: ${(done.at - t0 - INACTIVITY_MS).toFixed(1)} ms after the limit`);
              await stateOf(x, done);
              if (noticeAt === null) throw new Error(`the stall notice did not show during the ${op} (${OPS[op].command} ran ${((done.at - t0) / 1000).toFixed(1)} s)`);
              stalls.push(noticeAt - prevAt);
            } finally {
              x.http.resume();
            }
          }
          const stall = report(`SC-004 stall ${op}`, stalls, BUDGET.stall, LIMIT_RUNS);
          const end = report(`SC-004 limit ${op}`, ends, BUDGET.end, LIMIT_RUNS);
          expect({ stall, end }).toEqual({ stall: "pass", end: "pass" });
        });
      },
      SETUP_MS + LIMIT_RUNS * (INACTIVITY_MS + END_WAIT_MS + 6 * STEP_MS) + 10 * STEP_MS + 2 * STOP_MS + 2 * PROBE_TIMEOUT_MS,
    );
  }
});
