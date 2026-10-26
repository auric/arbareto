// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T042: the feature 006 timing and memory budgets in the installed package (plan.md P8, WP8, D3). Quickstart.md Q12, Q25, and Q27. `Local: package`.
// Spec FR-017, FR-028, SC-004. A timing case counts N runs after one warm-up run. Each counted run must meet the budget, and the OBSERVATION line also gives the median.
// The cases drive the page through the WebView2 CDP endpoint and UI Automation patterns. They send no OS input and never move the pointer.
// Page timing: the time from the `timeStamp` of the input event to the start of the first animation frame whose page holds the result (as T061).
// It leaves out the OS input path and the compositor, so it is not the 001 visible response of the capture source (001 plan.md "Capture source").
// Each case runs only against a 006 build (spelling-app.ts `buildHolds`).

import { afterAll, describe, expect, test } from "bun:test";
import { cpus } from "node:os";
import { join } from "node:path";
import { fixtureDir, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { printOrigin } from "../origin";
import { languageFixture } from "../support/language-fixture";
import { MOD, type Cdp } from "./cdp";
import { appEnv, COMMIT_VIEW } from "./installed-app";
import {
  ACTION_WAIT_MS,
  browserVersion,
  cachedEntry,
  cacheSkip,
  cachedText,
  caret,
  caseTimeout,
  catalog,
  CHIP,
  copyProfile,
  DESCRIPTIONS,
  end,
  FIELD,
  installDictionary,
  js,
  MARKS,
  MENU_LABELS,
  openRepository,
  packaged,
  press,
  SETTINGS_ITEM,
  setSpelling,
  smallRepo,
  SPELL_SWITCH,
  spellMenu,
  SPELLING_TAB,
  startWith,
  T,
  uia,
  until,
  VIEW_MENU,
  waitFor,
  writeMessage,
  type Session,
} from "./spelling-app";
import { close, ControlType, expand, invoke, toggle } from "./uia";
import type { CatalogEntry } from "../../src/contracts/dictionaries";

const SAMPLER = printOrigin("../../scripts/windows/measure-ram.ps1", import.meta.dir);
for (const helper of ["./spelling-app.ts", "../support/language-fixture.ts"]) printOrigin(helper, import.meta.dir);

const TASK = "T042";

// ---- Budgets (spec SC-004, FR-017, FR-028; plan.md D3) ----

const FIRST_MARKS_MS = 1_000;
const MARK_UPDATE_MS = 100;
const STALL_MS = 50;
const LOAD_MS = 10_000;
const GATE_BYTES = 256 * 1024 * 1024;
const INPUT_P95_MS = 100;
const INPUT_MAX_MS = 500;
// The counted runs after one warm-up run. Each first-open run is a new app process.
const RUNS = 10;
const OPEN_RUNS = 5;
const GATE_RUNS = 3;
// Plan.md D3 "Packaged gate method".
const BASELINE_DELAY_MS = 10_000;
const BASELINE_SAMPLES = 3;
const BASELINE_GAP_MS = 1_000;
const SAMPLE_MS = 250;
const LOAD_POLL_MS = 50;
const AFTER_MS = 5_000;
// The page waits for each timed step at most this long. A step past it fails the case.
const STEP_LIMIT_MS = 60_000;
// The Event Timing API reports no entry below its 16 ms minimum `durationThreshold`, so such an input counts as 16 ms.
const EVENT_THRESHOLD_MS = 16;
// The 001 probe interval during a workload (001 plan.md "Responsiveness metrics").
const PROBE_INTERVAL_MS = 100;
// Spec SC-004 and src/contracts/limits.ts `COMMIT_MESSAGE_BYTES`: the spell check covers at most 64 KiB of UTF-8.
const MESSAGE_BYTES = 64 * 1024;

// Data-model §11, the first vector. "recieve" is its only English misspelling (research.md R13 T028 N1).
const FIXTURE = "Fix the sync job so it does not recieve stale data";
const WRONG = "recieve";
// tests/support/language-fixture.ts `LATIN_NEGATIVES`[0]. One typed `x` keeps it one marked word.
const NEGATIVE = "qzxqzx";

// A message of `MESSAGE_BYTES - 1` ASCII bytes where every word is a negative word, 10 words per line. One typed character reaches the limit.
function fullMessage(): { text: string; words: number; last: string } {
  const lines: string[] = [];
  let line: string[] = [];
  let bytes = 0;
  let words = 0;
  for (;;) {
    const sep = line.length === 0 ? (lines.length === 0 ? 0 : 1) : 1;
    if (bytes + sep + NEGATIVE.length > MESSAGE_BYTES - 1) break;
    if (line.length === 10) {
      lines.push(line.join(" "));
      line = [];
      continue;
    }
    line.push(NEGATIVE);
    bytes += sep + NEGATIVE.length;
    words++;
  }
  // The last word takes the rest, so the text has exactly `MESSAGE_BYTES - 1` bytes.
  const pad = MESSAGE_BYTES - 1 - bytes;
  line[line.length - 1] = `${NEGATIVE}${"z".repeat(pad)}`;
  lines.push(line.join(" "));
  const text = lines.join("\n");
  if (Buffer.byteLength(text) !== MESSAGE_BYTES - 1) throw new Error(`the full message has ${Buffer.byteLength(text)} bytes`);
  return { text, words, last: line[line.length - 1]! };
}

// ---- Page timing (as tests/windows/inspection-perf.test.ts T061) ----

// `arm` records the `timeStamp` of the next input event and resolves with the frame time at which the check first holds.
// The frame loop runs only while the page is visible (HTML "update the rendering"). The Long Tasks API reports each main thread task above 50 ms.
const PAGE = `(() => {
  if (window.__t042 !== undefined) return true;
  window.__t042Keys = [];
  window.__t042Events = [];
  window.__t042Long = [];
  addEventListener('keydown', (e) => window.__t042Keys.push(e.timeStamp), { capture: true });
  new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.name === 'keydown') window.__t042Events.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'event', durationThreshold: ${EVENT_THRESHOLD_MS} });
  new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__t042Long.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'longtask' });
  window.__t042 = {
    arm(check, limit) {
      let start = null;
      let done = null;
      const onInput = (e) => { if (start === null) start = e.timeStamp; };
      for (const type of ['keydown', 'beforeinput']) addEventListener(type, onInput, { capture: true });
      this.value = null;
      const end = (ok) => {
        for (const type of ['keydown', 'beforeinput']) removeEventListener(type, onInput, { capture: true });
        this.value = { ok, start, end: done, time: done === null || start === null ? null : done - start };
      };
      const step = (now) => {
        if (start !== null && done === null && check()) done = now;
        if (done !== null) return end(true);
        if (start !== null && now - start > limit) return end(false);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      return true;
    },
  };
  return true;
})()`;

type Timed = { ok: boolean; start: number | null; end: number | null; time: number | null };
// Arms the page, runs `act` (which sends the input), and returns the time of the check after the input, in ms, with the long tasks of that span.
async function timed(c: Cdp, check: string, act: () => Promise<void>): Promise<{ ms: number; long: number[] }> {
  await c.evaluate(PAGE);
  await c.evaluate(`(window.__t042Long = [], window.__t042.arm(() => (${check}), ${STEP_LIMIT_MS}))`);
  await act();
  // `cdp.ts` ends one call after 10 s, so the page sets `value` and the test polls it up to the step limit.
  const r = (await until<Timed | null>(c, "the timed step", "window.__t042.value", (v) => v !== null, STEP_LIMIT_MS + 5_000))!;
  if (!r.ok || r.time === null) throw new Error(`a step did not show within ${STEP_LIMIT_MS} ms: ${js(r)}`);
  const long = await c.evaluate<{ start: number; duration: number }[]>("window.__t042Long");
  return { ms: r.time, long: long.filter((l) => l.start + l.duration >= r.start! && l.start <= r.end!).map((l) => l.duration) };
}

const median = (xs: number[]) => {
  const s = xs.toSorted((a, b) => a - b);
  return s.length % 2 === 1 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
// 001 plan.md "Responsiveness metrics": the nearest-rank p95.
const p95 = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.max(0, Math.ceil(0.95 * xs.length) - 1)]!;
const rounded = (xs: number[]) => xs.map((x) => Math.round(x * 10) / 10);
// Returns the maximum: spec SC-004 and quickstart.md Q12 bound each run.
function record(what: string, runs: number[], budget?: number): number {
  const max = Math.max(...runs);
  console.log(`OBSERVATION ${TASK}: ${what}: runs ${js(rounded(runs))} ms, median ${median(runs).toFixed(1)} ms, max ${max.toFixed(1)} ms${budget === undefined ? "" : `, budget ${budget} ms`}`);
  return max;
}

// ---- FR-028 inputs (W3C Event Timing, as T061 SC-009) ----

const openWindow = (c: Cdp) => c.evaluate(`(${PAGE}, window.__t042Keys = [], window.__t042Events = [], true)`);
async function closeWindow(c: Cdp, label: string): Promise<void> {
  await c.evaluate("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 50))))");
  const { keys, events } = await c.evaluate<{ keys: number[]; events: { start: number; duration: number }[] }>("({ keys: window.__t042Keys, events: window.__t042Events })");
  const durations = keys.map((k) => events.find((e) => e.start === k)?.duration ?? EVENT_THRESHOLD_MS);
  console.log(`OBSERVATION ${TASK}: FR-028 ${label}: ${durations.length} inputs, p95 ${durations.length === 0 ? "-" : p95(durations)} ms, max ${durations.length === 0 ? "-" : Math.max(...durations)} ms, durations ${js(durations)}`);
  expect(durations.length).toBeGreaterThan(0);
  expect({ label, p95: p95(durations) <= INPUT_P95_MS, max: Math.max(...durations) <= INPUT_MAX_MS }).toEqual({ label, p95: true, max: true });
}

// `trigger` starts the workload. Then a probe input goes to the page every 100 ms until `finish` resolves.
async function probing<V>(c: Cdp, label: string, probe: () => Promise<void>, trigger: () => Promise<void>, finish: () => Promise<V>): Promise<V> {
  await openWindow(c);
  await trigger();
  let finished = false;
  // A rejection must stay handled until `await running`: Bun 1.4.4 fails the case at an unhandled rejection and starts the next case first.
  const running = finish();
  running.then(
    () => void (finished = true),
    () => void (finished = true),
  );
  while (!finished) {
    await probe();
    await Bun.sleep(PROBE_INTERVAL_MS);
  }
  const value = await running;
  await closeWindow(c, label);
  return value;
}

// ---- The T040 sampler ----

type Sample = { timeMs: number; rootPid: number; processes: number; webView2PrivateBytes: number; totalPrivateBytes: number };
interface Sampler {
  samples: Sample[];
  at(timeMs: number, ms: number): Promise<Sample>;
  stop(): Promise<void>;
}

// One JSON line per sample on stdout (T040). The sampler is a child of this process, so `kill` ends it by its own handle.
function startSampler(rootPid: number): Sampler {
  const ps = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const proc = Bun.spawn([ps, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SAMPLER, "-RootPid", String(rootPid), "-Json", "-IntervalMs", String(SAMPLE_MS)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const samples: Sample[] = [];
  const reading = (async () => {
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of proc.stdout) {
      rest += decoder.decode(chunk, { stream: true });
      for (let i = rest.indexOf("\n"); i >= 0; i = rest.indexOf("\n")) {
        const line = rest.slice(0, i).trim();
        rest = rest.slice(i + 1);
        if (line !== "") samples.push(JSON.parse(line) as Sample);
      }
    }
  })();
  return {
    samples,
    // The first sample at or after `timeMs` (Unix ms, the clock of `Date.now`).
    at: (timeMs, ms) => waitFor(`a sample at ${timeMs}`, ms, () => samples.find((s) => s.timeMs >= timeMs)),
    async stop() {
      proc.kill();
      await proc.exited;
      await reading;
      const err = await new Response(proc.stderr).text();
      if (err.trim() !== "") console.log(`SAMPLER_STDERR ${TASK}: ${err.trim()}`);
    },
  };
}

const p = await packaged();
const installed = p.installed;
const reason = p.reason;

describe.skipIf(process.platform !== "win32")("T042 packaged spell check budgets", () => {
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

  // Plan.md D3 "Setup per run": a scratch profile with the Git selection and the fixture repository as the last repository.
  let template: string | null = null;
  async function profileTemplate(): Promise<string> {
    if (template !== null) return template;
    const repo = smallRepo(GIT!, "t042-repo");
    const env = appEnv(fixtureDir("template-app"), false);
    const s = await startWith(installed!, env, "template", TASK);
    sessions.add(s);
    try {
      await openRepository(s, repo);
    } finally {
      sessions.delete(s);
      await end(s);
    }
    return (template = env.set.ARBARETO_PROFILE_ROOT);
  }
  // A new app process on a fresh copy of the template profile. It opens the last repository by itself.
  async function fresh(label: string, prepare?: (profile: string) => void): Promise<Session> {
    const tpl = await profileTemplate();
    const env = appEnv(fixtureDir(`${label}-app`), false);
    copyProfile(tpl, env.set.ARBARETO_PROFILE_ROOT);
    prepare?.(env.set.ARBARETO_PROFILE_ROOT);
    const s = await startWith(installed!, env, label, TASK);
    sessions.add(s);
    await uia(s.app.pid, "References", ControlType.Tree, () => {});
    return s;
  }
  async function stop(s: Session): Promise<void> {
    sessions.delete(s);
    await end(s);
  }
  const toCommitView = (s: Session) => uia(s.app.pid, COMMIT_VIEW, ControlType.Button, invoke);
  async function openSpelling(s: Session): Promise<void> {
    await uia(s.app.pid, VIEW_MENU, ControlType.MenuItem, expand);
    await uia(s.app.pid, SETTINGS_ITEM, ControlType.MenuItem, invoke);
    const tab = `[...document.querySelectorAll('[role=tab]')].find((t) => t.textContent.trim() === ${js(SPELLING_TAB)})`;
    await until<boolean>(s.c, "the Spelling tab", `!!(${tab})`, (v) => v);
    await s.c.evaluate(`(${tab}).click(); true`);
    await until<boolean>(s.c, "the Spelling page", `!!document.querySelector('[data-slot=spelling-page]')`, (v) => v);
  }

  test.skipIf(reason !== null)(
    `Q12, SC-004: English marks show within ${FIRST_MARKS_MS} ms after the first open of the commit editor (each of ${OPEN_RUNS} app starts)`,
    async () => {
      const runs: number[] = [];
      for (let i = 0; i <= OPEN_RUNS; i++) {
        const s = await fresh(`open-${i}`);
        try {
          const start = performance.now();
          await toCommitView(s);
          await writeMessage(s.app.pid, s.c, FIXTURE);
          await until<string[]>(s.c, "the English marks", MARKS, (v) => js(v) === js([WRONG]), STEP_LIMIT_MS);
          // The first start warms the package files and the WebView2 runtime.
          if (i > 0) runs.push(performance.now() - start);
        } finally {
          await stop(s);
        }
      }
      expect(record("SC-004 first open to English marks (host clock, from the Commit view invoke, with the UIA SetValue)", runs, FIRST_MARKS_MS)).toBeLessThanOrEqual(FIRST_MARKS_MS);
    },
    caseTimeout(10 * (OPEN_RUNS + 1)),
  );

  test.skipIf(reason !== null)(
    `Q12, SC-004: in a 64 KiB message with every word marked, each typed character updates the marks within ${MARK_UPDATE_MS} ms with no main thread task above ${STALL_MS} ms; a whole-text paste is the recorded limit case`,
    async () => {
      const full = fullMessage();
      const s = await fresh("full");
      try {
        await toCommitView(s);
        await writeMessage(s.app.pid, s.c, full.text);
        await until<number>(s.c, "every word marked", `document.querySelectorAll('[data-slot="spell-mark"]').length`, (v) => v === full.words, STEP_LIMIT_MS);
        const lastMark = `[...document.querySelectorAll('[data-slot="spell-mark"]')].at(-1)?.textContent ?? null`;
        const runs: number[] = [];
        const stalls: number[] = [];
        for (let i = 0; i <= RUNS; i++) {
          await caret(s.c, full.text.length);
          const typed = await timed(s.c, `${lastMark} === ${js(`${full.last}x`)}`, () => press(s.c, "x"));
          await press(s.c, "Backspace", 0, ["deleteBackward"]);
          await until<string | null>(s.c, "the mark after Backspace", lastMark, (v) => v === full.last, STEP_LIMIT_MS);
          if (i === 0) continue;
          runs.push(typed.ms);
          stalls.push(...typed.long);
        }
        console.log(`OBSERVATION ${TASK}: SC-004 long tasks during the typed runs: ${js(rounded(stalls))} ms`);
        expect(record(`SC-004 typed character to the mark update in ${MESSAGE_BYTES - 1} bytes with ${full.words} marks`, runs, MARK_UPDATE_MS)).toBeLessThanOrEqual(MARK_UPDATE_MS);
        expect(stalls.filter((d) => d > STALL_MS)).toEqual([]);
        // The limit case: a paste of the whole text over a selection of the whole text. CDP `Input.insertText` fires `beforeinput` as a paste would.
        const pastes: number[] = [];
        for (let i = 0; i <= 3; i++) {
          await s.c.evaluate(`(${FIELD}.focus(), ${FIELD}.select(), true)`);
          const pasted = await timed(s.c, `document.querySelectorAll('[data-slot="spell-mark"]').length === ${full.words} && ${FIELD}.value.length === ${full.text.length}`, () => s.c.send("Input.insertText", { text: full.text }).then(() => {}));
          if (i > 0) pastes.push(pasted.ms);
        }
        record(`SC-004 limit case: whole-text paste of ${MESSAGE_BYTES - 1} bytes to all ${full.words} marks (recorded, no budget)`, pastes);
      } finally {
        await stop(s);
      }
    },
    caseTimeout(30, 2 * (RUNS + 5) * STEP_LIMIT_MS),
  );

  // FR-028: the probes move the caret in the message field, so they change no text and start no round.
  let side = false;
  const caretProbe = (c: Cdp) => () => press(c, (side = !side) ? "ArrowLeft" : "ArrowRight");

  test.skipIf(reason !== null)(
    `Q27, FR-028: 95% of inputs within ${INPUT_P95_MS} ms and every input within ${INPUT_MAX_MS} ms during a 64 KiB round and during a suggestion list`,
    async () => {
      const full = fullMessage();
      const s = await fresh("inputs");
      try {
        await toCommitView(s);
        await writeMessage(s.app.pid, s.c, FIXTURE);
        await until<string[]>(s.c, "the English marks", MARKS, (v) => js(v) === js([WRONG]));
        await s.c.evaluate(`(${FIELD}.focus(), ${FIELD}.select(), true)`);
        await probing(
          s.c,
          "a 64 KiB round",
          caretProbe(s.c),
          () => s.c.send("Input.insertText", { text: full.text }).then(() => {}),
          () => until<number>(s.c, "the 64 KiB round", `document.querySelectorAll('[data-slot="spell-mark"]').length`, (v) => v === full.words, STEP_LIMIT_MS),
        );
        await s.c.evaluate(`(${FIELD}.focus(), ${FIELD}.select(), true)`);
        await s.c.send("Input.insertText", { text: FIXTURE });
        await until<string[]>(s.c, "the English marks", MARKS, (v) => js(v) === js([WRONG]));
        const menu = spellMenu(WRONG);
        await caret(s.c, FIXTURE.indexOf(WRONG) + 2);
        await probing(
          s.c,
          "a suggestion list",
          () => press(s.c, (side = !side) ? "ArrowDown" : "ArrowUp"),
          () => press(s.c, "F10", MOD.Shift),
          () => until<string[]>(s.c, "the suggestions", MENU_LABELS(menu), (v) => v.includes(T.ignore) && !v.includes(T.finding)),
        );
        await press(s.c, "Escape");
      } finally {
        await stop(s);
      }
    },
    caseTimeout(30, 4 * STEP_LIMIT_MS),
  );

  const { entry: uk, skip: ukCache } = cachedEntry("uk");
  const ukSkip = reason ?? ukCache;
  if (ukSkip !== null) console.log(`SKIP ${TASK} FR-028 Ukrainian load: ${ukSkip} (unverified)`);
  test.skipIf(ukSkip !== null)(
    `Q27, FR-028: 95% of inputs within ${INPUT_P95_MS} ms and every input within ${INPUT_MAX_MS} ms during a Ukrainian load`,
    async () => {
      const s = await fresh("uk-load", (profile) => {
        installDictionary(profile, uk!);
        setSpelling(profile, { enabled: true, languages: ["en", "uk"] });
      });
      try {
        await probing(
          s.c,
          "a Ukrainian load",
          caretProbe(s.c),
          async () => {
            await toCommitView(s);
            await until<boolean>(s.c, "the message field", `!!${FIELD}`, (v) => v);
            await caret(s.c, 0);
          },
          () => until<string | null>(s.c, "the Ukrainian load", CHIP, (v) => v === T.chip(["English", uk!.name]), STEP_LIMIT_MS),
        );
      } finally {
        await stop(s);
      }
    },
    caseTimeout(30, STEP_LIMIT_MS),
  );

  // Tasks.md "Harness and tick rules": no test uses the network. A real download in the package reads raw.githubusercontent.com.
  console.log(`SKIP ${TASK} FR-028 during a download: missing capability network-download (unverified; no test uses the network)`);
  test.skip("Q27, FR-028 during a download (SKIP: network-download)", () => {});

  // ---- The packaged gate of plan.md D3 (FR-017, Q25) ----

  type GateRun = {
    run: number;
    webview2: string;
    baselineBytes: number;
    peakBytes: number;
    increaseBytes: number;
    maxGapMs: number;
    loadMs: number | null;
    descriptions: (string | null)[];
    expected: string;
  };
  async function gateRun(entry: CatalogEntry, text: string, negatives: string[], firstNegative: number, run: number): Promise<GateRun> {
    const s = await fresh(`gate-${entry.id}-${run}`, (profile) => {
      installDictionary(profile, entry);
      setSpelling(profile, { enabled: false, languages: [entry.id] });
    });
    const sampler = startSampler(s.app.pid);
    try {
      const webview2 = await browserVersion(s.port);
      await toCommitView(s);
      await writeMessage(s.app.pid, s.c, text);
      const shown = Date.now();
      const base: number[] = [];
      for (let i = 0; i < BASELINE_SAMPLES; i++) base.push((await sampler.at(shown + BASELINE_DELAY_MS + i * BASELINE_GAP_MS, BASELINE_DELAY_MS + BASELINE_SAMPLES * BASELINE_GAP_MS + ACTION_WAIT_MS)).webView2PrivateBytes);
      const from = shown + BASELINE_DELAY_MS;
      const baselineBytes = median(base);
      await openSpelling(s);
      await uia(s.app.pid, SPELL_SWITCH, ControlType.Button, toggle);
      const start = performance.now();
      await toCommitView(s);
      let loadMs: number | null = null;
      for (const stopAt = start + 6 * LOAD_MS; loadMs === null && performance.now() < stopAt; await Bun.sleep(LOAD_POLL_MS)) {
        if ((await s.c.evaluate<string | null>(CHIP)) === T.chip([entry.name])) loadMs = performance.now() - start;
      }
      await Bun.sleep(AFTER_MS);
      const descriptions = await s.c.evaluate<(string | null)[]>(DESCRIPTIONS);
      // Without a load the language gives no suggestions. The run returns, so the gate records its values.
      if (loadMs !== null) {
        await caret(s.c, firstNegative + 1);
        await press(s.c, "F10", MOD.Shift);
        const menu = spellMenu(negatives[0]!);
        await until<string[]>(s.c, "the suggestions of the first negative word", MENU_LABELS(menu), (v) => v.includes(T.ignore) && !v.includes(T.finding), STEP_LIMIT_MS);
        const listed = Date.now();
        await sampler.at(listed + AFTER_MS, AFTER_MS + ACTION_WAIT_MS);
        await press(s.c, "Escape");
      }
      const window = sampler.samples.filter((x) => x.timeMs >= from);
      // A tree without a WebView2 process gives 0 bytes, and the bound would pass.
      expect(window.filter((x) => x.rootPid !== s.app.pid || x.webView2PrivateBytes <= 0)).toEqual([]);
      const peakBytes = Math.max(...window.map((x) => x.webView2PrivateBytes));
      const maxGapMs = Math.max(0, ...window.slice(1).map((x, i) => x.timeMs - window[i]!.timeMs));
      return { run, webview2, baselineBytes, peakBytes, increaseBytes: peakBytes - baselineBytes, maxGapMs, loadMs, descriptions, expected: T.count(negatives.length) };
    } finally {
      await sampler.stop();
      await stop(s);
    }
  }

  for (const entry of reason === null ? catalog.entries : []) {
    const skip = cacheSkip(entry);
    if (skip !== null) {
      console.log(`SKIP ${TASK} packaged gate ${entry.id}: ${skip} (unverified)`);
      test.skip(`Q25, FR-017 packaged gate ${entry.id} (SKIP: ${skip})`, () => {});
      continue;
    }
    test(
      `Q25, FR-017 packaged gate ${entry.id}: ${GATE_RUNS} runs load within ${LOAD_MS} ms, add at most 256 MiB of WebView2 private bytes, and give the exact fixture count`,
      async () => {
        const fixture = languageFixture(cachedText(entry, "index.aff"), cachedText(entry, "index.dic"));
        if (fixture.problem !== null) {
          console.log(`GATE_FAILURE ${TASK}: ${js({ id: entry.id, step: 2, reason: fixture.problem })}`);
          throw new Error(`the ${entry.id} fixture refuses: ${fixture.problem}`);
        }
        const before = fixture.positives.join(" ");
        const text = `${before} ${fixture.negatives.join(" ")}`;
        const runs: GateRun[] = [];
        for (let run = 1; run <= GATE_RUNS; run++) {
          const r = await gateRun(entry, text, fixture.negatives, before.length, run);
          runs.push(r);
          console.log(
            `OBSERVATION ${TASK}: gate ${js({ id: entry.id, date: new Date().toISOString(), build: p.build, cpu: cpus()[0]?.model ?? null, logical: cpus().length, ...r })}`,
          );
        }
        const failed = runs.filter((r) => r.loadMs === null || r.loadMs > LOAD_MS || r.increaseBytes > GATE_BYTES || !r.descriptions.includes(r.expected));
        if (failed.length > 0) {
          // A run without a load measured no fixture count, so it fails step 3.
          const step = failed.some((r) => r.loadMs === null) ? 3 : failed.some((r) => !r.descriptions.includes(r.expected)) ? 2 : failed.some((r) => r.loadMs! > LOAD_MS) ? 3 : 4;
          console.log(`GATE_FAILURE ${TASK}: ${js({ id: entry.id, step, runs })}`);
        }
        expect(failed).toEqual([]);
      },
      caseTimeout(10 * (GATE_RUNS + 1), GATE_RUNS * (BASELINE_DELAY_MS + 6 * LOAD_MS + 2 * AFTER_MS + 3 * STEP_LIMIT_MS)),
    );
  }
});
