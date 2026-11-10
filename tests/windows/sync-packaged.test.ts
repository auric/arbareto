// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 003 T078: the SC-008 workloads in the installed package (plan.md P12). `Local: package`.
// During each remote operation against the T004 remote, `SendInput` types one probe character into the message field every 100 ms.
// The visible response of a probe is the first captured frame after its QPC value whose masked hash differs from the frame before it (001 plan.md "Responsiveness metrics", "Capture source").
// The region is the message-field rectangle, and its mask comes from 5 seconds of the settled field (001 T242 live case).
// CPU and memory come from the owned Job of the app tree, so exited children count (001 plan.md "Measurements and budgets").
// plan.md "Performance Goals" holds no CPU or memory budget for these workloads yet (T076), so those values print as OBSERVATION lines and decide nothing.
// The cases send OS input and take the foreground, so they run only with `ARBARETO_LIVE_INPUT=1` in the 001 T165 measurement account.
// Control mutation: set INPUT.p95Ms to 1; each workload case must fail.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { TERMINAL_STATES } from "../../src/contracts/errors";
import { FIXED_IDENTITY, fixtureDir, FIXTURE_ROOT, useFixtureRoot } from "../git/fixture-root";
import { fixtureGitPath, GIT } from "../git/git-binary";
import { buildCredentialRemote, credentialHelper, gitOut, gitRun, HTTP_PASSWORD, HTTP_USER, nativeEnv, nativeHost, revParse, type GitHost } from "../git/remote-fixtures";
import { printOrigin } from "../origin";
import { startHttpRemote, type HttpRemote } from "../support/http-remote";
import { buildMask, CaptureError, deltaSeconds, DISPLAY_OFF, displayState, hashImage, keepDisplayOn, openDuplication, releaseDisplay, type Duplication } from "./capture";
import { connectPage, freePort, watchIpc, type Cdp, type IpcCall } from "./cdp";
import { encodeInputs, INPUT_BYTES, keystroke, qpc, qpcFrequency } from "./inject";
import { appEnv, COMMIT_VIEW, findInstalledApp, PROBE_TIMEOUT_MS, processRecords, startInstalledApp, WAIT_MS, waitExit, type AppEnv, type OwnedProcess } from "./installed-app";
import { median } from "./ratio";
import { boundingRect, close, ControlType, find, focus, foregroundPid, foregroundSkip, inputDesktopSkip, invoke, isEnabled, MAX_CALL_MS, MAX_WAIT_MS, readValue, setValue, UiaError, waitFocus, type Element } from "./uia";

for (const helper of ["./capture.ts", "./inject.ts", "./cdp.ts", "./uia.ts", "./installed-app.ts", "./ratio.ts", "../support/http-remote.ts", "../git/remote-fixtures.ts"]) printOrigin(helper, import.meta.dir);
for (const source of ["../../src/contracts/errors.ts", "../../src/frontend/sync/SyncToolbar.tsx", "../../src/frontend/sync/PullSplitButton.tsx", "../../src/frontend/commit/CommitTray.tsx"]) printOrigin(source, import.meta.dir);

const TASK = "T078";
const LIVE = process.env.ARBARETO_LIVE_INPUT === "1";

// ---- Targets and run parameters (the source of each value is named) ----

// Spec SC-008 and 001 SC-005: 95% of inputs within 100 ms, every input within 500 ms.
const INPUT = { p95Ms: 100, maxMs: 500 } as const;
// 001 plan.md "Responsiveness metrics": one probe input every 100 ms.
const PROBE_MS = 100;
// 001 plan.md "Measurements and budgets", Input acknowledgement row: 100 counted actions per class.
const MIN_PROBES = 100;
// 001 plan.md "Capture source", Mask: 5 seconds of the settled end state.
const CALIBRATE_MS = 5_000;
// The capture runs on after the reply, so the last probes can show their response. It is above the 500 ms target.
const TAIL_MS = 1_000;
// One frame wait. It keeps the T004 server on this event loop answering.
const ACQUIRE_MS = 10;
// An incompressible blob of 8 MiB, sent in chunks of 64 KiB every 100 ms: about 13 seconds of transfer, above MIN_PROBES × PROBE_MS.
const BLOB_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const CHUNK_MS = 100;
// The push sends its pack in the request, which the throttle does not slow. The pause switch holds its first response this long instead.
const PUSH_HOLD_MS = 12_000;
const RUN_MAX_MS = 120_000;

// ---- App texts (the source of each value is named) ----

// `OPEN_FOLDER` in src/frontend/app/RepositorySwitcher.tsx.
const OPEN_FOLDER = "Open folder… (Ctrl+O)";
// src/frontend/commit/CommitTray.tsx.
const MESSAGE = "Commit message";
// The probe character. Its count in the message field proves that every probe reached the field.
const PROBE_CHAR = "x";

type Op = "fetch" | "pull" | "push";
// SyncToolbar.tsx and PullSplitButton.tsx Names; `Cancel <SYNC_NAMES[action]>` shows while the operation runs.
const OPS: Record<Op, { button: string; running: string }> = {
  fetch: { button: "Fetch", running: "Cancel Fetch" },
  pull: { button: "Pull", running: "Cancel Pull" },
  push: { button: "Push", running: "Cancel Push" },
};

const STEP_MS = MAX_WAIT_MS + MAX_CALL_MS;
const SETUP_MS = 5 * 60_000;
const STOP_MS = 10_000;
// UIA_E_ELEMENTNOTAVAILABLE: a render replaced the element.
const UIA_E_ELEMENTNOTAVAILABLE = 0x8004_0201;
const CASE_MS = SETUP_MS + 20 * STEP_MS + CALIBRATE_MS + RUN_MAX_MS + TAIL_MS + 2 * STOP_MS + 2 * PROBE_TIMEOUT_MS + 2 * WAIT_MS;

const js = (value: unknown) => JSON.stringify(value);

// ---- Win32 calls that tests/windows/inject.ts does not export (it calls SendInput only from its command line) ----

const { ptr: P, i32, u32, i64 } = FFIType;
const open = () =>
  dlopen("user32.dll", {
    SendInput: { args: [u32, P, i32], returns: u32 },
    SetProcessDpiAwarenessContext: { args: [i64], returns: i32 },
  }).symbols;
let user32: ReturnType<typeof open> | undefined;
// The DLLs exist only on Windows, so the import of this file must not open them.
const win = () => (user32 ??= open());
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4n;

// ---- Statistic ----

type Summary = { n: number; median: number; p95: number; max: number };
// 001 plan.md "Responsiveness metrics": every run, median, nearest-rank p95, and maximum.
function summarize(values: readonly number[]): Summary {
  if (values.length === 0) return { n: 0, median: Number.NaN, p95: Number.NaN, max: Number.NaN };
  const sorted = values.toSorted((a, b) => a - b);
  return { n: values.length, median: median(sorted), p95: sorted[Math.ceil(0.95 * sorted.length) - 1]!, max: sorted.at(-1)! };
}

type CapturedFrame = { t: bigint; hash: string };

// The first frame after the input whose hash differs from the frame before it. Null: no such frame was captured.
function responseMs(frames: readonly CapturedFrame[], input: bigint, frequency: bigint): number | null {
  for (let i = 1; i < frames.length; i++) {
    if (frames[i]!.t > input && frames[i]!.hash !== frames[i - 1]!.hash) return (Number(frames[i]!.t - input) * 1000) / Number(frequency);
  }
  return null;
}

describe("T078 response rule on sample frames", () => {
  test("the response is the first changed frame after the input; an earlier change or an equal frame does not count", () => {
    const f = (t: number, hash: string): CapturedFrame => ({ t: BigInt(t), hash });
    const frames = [f(0, "a"), f(50, "b"), f(150, "b"), f(180, "c"), f(300, "d")];
    expect(responseMs(frames, 100n, 1000n)).toBe(80);
    expect(responseMs(frames, 300n, 1000n)).toBeNull();
    expect(responseMs([f(0, "a")], 0n, 1000n)).toBeNull();
  });
});

describe.skipIf(process.platform !== "win32")("T078 packaged SC-008 workloads", () => {
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
            ? "live input needs the measurement account: set ARBARETO_LIVE_INPUT=1 (001 T165); the cases send OS input and take the foreground"
            : inputDesktopSkip();
  if (reason !== null) console.log(`SKIP ${TASK}: ${reason}`);
  // UIA rectangles and desktop duplication then share physical pixels.
  if (reason === null) win().SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

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

  async function invokeWhenEnabled(pid: number, name: string, type: number): Promise<void> {
    for (const end = performance.now() + MAX_WAIT_MS; ; await Bun.sleep(10)) {
      const element = await find(pid, name, Math.max(0, Math.ceil(end - performance.now())), type);
      try {
        if (isEnabled(element)) return invoke(element);
      } catch (error) {
        if (!(error instanceof UiaError && error.hresult === UIA_E_ELEMENTNOTAVAILABLE)) throw error;
      } finally {
        element.release();
      }
      if (performance.now() >= end) throw new Error(`${js(name)} was not enabled within ${MAX_WAIT_MS} ms`);
    }
  }

  // Moves the UIA focus to the message field. A lost foreground cannot be verified, so it ends the case as SKIP, never as a pass.
  async function focusMessage(pid: number): Promise<void> {
    await uia(pid, MESSAGE, ControlType.Edit, focus);
    try {
      await waitFocus(pid, MESSAGE, MAX_WAIT_MS);
    } catch (error) {
      const skip = error instanceof UiaError && error.code === "TIMEOUT" ? foregroundSkip(pid) : null;
      if (skip === null) throw error;
      throw new Error(`SKIP ${TASK} message focus: ${skip}`);
    }
  }

  function sendProbe(pid: number): bigint {
    const owner = foregroundPid();
    if (owner !== pid) throw new Error(`SKIP ${TASK}: the app (PID ${pid}) lost the foreground window to PID ${owner}, so the case sends no input`);
    const events = keystroke(`text:${PROBE_CHAR}`);
    const bytes = encodeInputs(events);
    const at = qpc();
    // SendInput returns the number of events that it inserted. UIPI blocks give a lower count (Microsoft Learn "SendInput").
    const inserted = win().SendInput(events.length, ptr(bytes), INPUT_BYTES);
    if (inserted !== events.length) throw new Error(`SendInput inserted ${inserted} of ${events.length} events`);
    return at;
  }

  // ---- Fixture and session ----

  type Reply = IpcCall & { at: bigint };
  type Session = { app: OwnedProcess; c: Cdp; env: AppEnv; replies: Reply[]; body<T>(call: IpcCall): Promise<T> };

  // The empty value clears the system helpers, so Git Credential Manager never stores the fixture credential or opens a prompt.
  function credentialConfig(h: GitHost, env: AppEnv): void {
    const file = env.set.GIT_CONFIG_GLOBAL;
    const helper = credentialHelper(HTTP_USER, HTTP_PASSWORD);
    gitRun(h, h.root, ["config", "--file", file, "--add", "credential.helper", ""]);
    gitRun(h, h.root, ["config", "--file", file, "--add", "credential.helper", helper]);
    const proc = Bun.spawnSync([fixtureGitPath(GIT!), "config", "--get-all", "--show-scope", "credential.helper"], { cwd: h.root, env: env.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: PROBE_TIMEOUT_MS });
    const lines = proc.stdout.toString().split("\n").filter((l) => l !== "");
    expect({ exit: proc.exitCode, last: lines.slice(-2) }).toEqual({ exit: 0, last: ["global\t", `global\t${helper}`] });
  }

  const identity = ["-c", `user.name=${FIXED_IDENTITY.name}`, "-c", `user.email=${FIXED_IDENTITY.email}`];

  // Commits one incompressible blob in `repo` with plain Git.
  function commitBlob(h: GitHost, repo: string, name: string): void {
    writeFileSync(`${repo}/${name}`, randomBytes(BLOB_BYTES));
    gitRun(h, repo, ["add", "--", name]);
    gitRun(h, repo, [...identity, "commit", "-q", "-m", name]);
  }

  async function session(h: GitHost, label: string, repo: string): Promise<Session> {
    const env = appEnv(fixtureDir(`${TASK}-${label}-app`), false);
    credentialConfig(h, env);
    const port = freePort();
    env.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port}`;
    const app = startInstalledApp(installed!, env);
    owned.add(app);
    console.log(`STARTED ${TASK} ${label}: ${app.pid} port=${port} profile=${env.set.ARBARETO_PROFILE_ROOT}`);
    // A new profile holds no Git selection, so the boot view offers Select Git (uia.test.ts T241).
    await uia(app.pid, "Select Git", ControlType.Button, invoke);
    const c = await connectPage(port, MAX_WAIT_MS);
    sockets.add(c);
    const replies: Reply[] = [];
    const ipc = await watchIpc(c, (call) => replies.push({ ...call, at: qpc() }));
    await uia(app.pid, "Use this Git", undefined, invoke);
    await uia(app.pid, OPEN_FOLDER, undefined, invoke);
    const path = resolve(repo);
    if (!isAbsolute(path) || relative(FIXTURE_ROOT, path).startsWith("..")) throw new Error(`the repository is outside the fixture root: ${js(path)}`);
    // The Windows folder picker: the Edit has the Name of its label, and its dialog window has the Name of the OK button.
    await uia(app.pid, "Folder:", ControlType.Edit, (field) => setValue(field, path));
    await uia(app.pid, "Select Folder", ControlType.Button, invoke);
    const top = gitOut(h, repo, ["rev-parse", "--show-toplevel"]).trim();
    await uia(app.pid, `${basename(top)}, ${top}`, ControlType.Button, () => {});
    return { app, c, env, replies, body: (call) => ipc.body(call) };
  }

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

  // ---- Capture ----

  function duplicate(pid: number, rect: { x: number; y: number; width: number; height: number }): Duplication {
    let opened: ReturnType<typeof openDuplication>;
    try {
      opened = openDuplication(rect);
    } catch (error) {
      if (!(error instanceof CaptureError)) throw error;
      opened = { skip: error.message, hresult: error.hresult ?? null };
    }
    if ("skip" in opened) throw new Error(`SKIP ${TASK}: missing capability ${opened.skip} (HRESULT ${opened.hresult ?? "none"}; PID ${pid})`);
    return opened.dup;
  }

  // `acquire` skips a pointer-only frame. 20 waits of 100 ms bound the first frame.
  function firstImage(dup: Duplication): { t: bigint; image: Uint8Array } {
    for (let i = 0; i < 20; i++) {
      const frame = dup.acquire(100);
      if (frame !== null) return { t: frame.lastPresentTime, image: frame.image };
    }
    throw new Error("no desktop frame of the message field within 2 s");
  }

  // 001 plan.md "Capture source", Mask: the pixels that change during 5 seconds of the settled field.
  async function calibrate(dup: Duplication): Promise<{ mask: Uint8Array; first: CapturedFrame }> {
    const base = firstImage(dup);
    const images = [base.image];
    let last = base.t;
    for (const end = performance.now() + CALIBRATE_MS; performance.now() < end; await Bun.sleep(0)) {
      const frame = dup.acquire(ACQUIRE_MS);
      if (frame === null) continue;
      images.push(frame.image);
      last = frame.lastPresentTime;
    }
    const mask = buildMask(images, dup.region.width, dup.region.height);
    console.log(`MASK ${TASK}: ${images.length} frames, ${mask.reduce((n, m) => n + m, 0)} masked pixels of ${mask.length}`);
    return { mask, first: { t: last, hash: hashImage(images.at(-1)!, mask) } };
  }

  // ---- Workloads ----

  async function workload(op: Op): Promise<void> {
    const h = nativeHost(GIT!, `t078-${op}`);
    const served = `${h.root}/served`;
    mkdirSync(served, { recursive: true });
    const bare = buildCredentialRemote(h, served);
    const http = startHttpRemote({ git: fixtureGitPath(GIT!), projectRoot: served, user: HTTP_USER, password: HTTP_PASSWORD, env: nativeEnv() });
    console.log(`SERVERS ${TASK} ${op}: http port=${http.port}`);
    let dup: Duplication | null = null;
    await guarded(
      async () => {
        const repo = `${h.root}/repo`;
        gitRun(h, h.root, ["clone", "-q", "--", bare, repo]);
        for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"]] as const) gitRun(h, repo, ["config", key, value]);
        gitRun(h, repo, ["remote", "set-url", "origin", `${http.url}/cred.git`]);
        // Fetch and pull download one blob commit that the remote holds. Push uploads one blob commit of the clone.
        if (op === "push") commitBlob(h, repo, "push.bin");
        else {
          const helper = `${h.root}/helper`;
          gitRun(h, h.root, ["clone", "-q", "--", bare, helper]);
          commitBlob(h, helper, `${op}.bin`);
          gitRun(h, helper, ["push", "-q", "origin", "main"]);
        }
        const target = op === "push" ? revParse(h, repo, "HEAD") : revParse(h, bare, "refs/heads/main");

        const s = await session(h, op, repo);
        const pid = s.app.pid;
        await uia(pid, COMMIT_VIEW, ControlType.Button, invoke);
        await uia(pid, MESSAGE, ControlType.Edit, (field) => setValue(field, ""));
        await focusMessage(pid);
        keepDisplayOn();
        if ((await displayState()) === DISPLAY_OFF) throw new Error(`SKIP ${TASK}: missing capability display-off`);
        const rect = await uia(pid, MESSAGE, ControlType.Edit, boundingRect);
        dup = duplicate(pid, rect);
        const delta = deltaSeconds(dup.mode.numerator, dup.mode.denominator);
        console.log(`REGION ${TASK} ${op}: ${js(rect)} mode ${dup.mode.width}x${dup.mode.height} Δ=${(delta * 1000).toFixed(2)} ms adapter=${js(dup.adapter)}`);
        const { mask, first } = await calibrate(dup);

        if (op === "push") http.pause();
        else http.throttle(CHUNK_BYTES, CHUNK_MS);
        const since = s.replies.length;
        await invokeWhenEnabled(pid, OPS[op].button, ControlType.Button);
        await uia(pid, OPS[op].running, ControlType.Button, () => {});
        // The Invoke can move focus to the toolbar, so the field takes focus again before the first probe (001 plan.md "Responsiveness metrics").
        await focusMessage(pid);

        const frequency = qpcFrequency();
        const frames: CapturedFrame[] = [first];
        const probes: bigint[] = [];
        const cpu: { at: number; ms: number }[] = [];
        const before = s.app.accounting();
        const startedAt = performance.now();
        let next = startedAt;
        let replyAt: bigint | null = null;
        let tailEnd = Number.POSITIVE_INFINITY;
        let held = op === "push";
        for (;;) {
          const now = performance.now();
          if (replyAt === null) {
            const r = s.replies.slice(since).find((call) => call.command === "sync");
            if (r !== undefined) {
              replyAt = r.at;
              tailEnd = now + TAIL_MS;
            }
          }
          if (now >= tailEnd) break;
          if (now - startedAt >= RUN_MAX_MS) throw new Error(`the ${op} did not end within ${RUN_MAX_MS} ms`);
          if (held && now - startedAt >= PUSH_HOLD_MS) {
            http.resume();
            held = false;
          }
          if (replyAt === null && now >= next) {
            probes.push(sendProbe(pid));
            const a = s.app.accounting();
            cpu.push({ at: now, ms: a.userMs + a.kernelMs });
            next = now + PROBE_MS;
          }
          const frame = dup.acquire(replyAt === null ? Math.max(0, Math.min(ACQUIRE_MS, Math.floor(next - performance.now()))) : ACQUIRE_MS);
          if (frame !== null) frames.push({ t: frame.lastPresentTime, hash: hashImage(frame.image, mask) });
          await Bun.sleep(0);
        }
        const after = s.app.accounting();
        http.throttle(null);

        // Every probe reached the field, or the run cannot be verified.
        const value = await uia(pid, MESSAGE, ControlType.Edit, readValue);
        if (value !== PROBE_CHAR.repeat(probes.length)) throw new Error(`SKIP ${TASK} ${op}: the message field holds ${js(value.length)} characters after ${probes.length} probes, so some probes went elsewhere`);

        const reply = await s.body<{ state?: string; code?: string }>(s.replies.slice(since).find((call) => call.command === "sync")!);
        console.log(`REPLY ${TASK} ${op}: state=${reply.state} code=${reply.code ?? "none"}`);
        expect(TERMINAL_STATES as readonly string[]).toContain(reply.state);
        // The workload moved data: the remote-tracking ref, HEAD, or the remote branch holds the blob commit.
        const moved = op === "fetch" ? revParse(h, repo, "refs/remotes/origin/main") : op === "pull" ? revParse(h, repo, "HEAD") : revParse(h, bare, "refs/heads/main");
        expect({ state: reply.state, moved }).toEqual({ state: "succeeded", moved: target });

        const times = probes.map((q) => responseMs(frames, q, frequency));
        const missing = times.filter((t) => t === null).length;
        const ms = times.map((t) => t ?? Number.POSITIVE_INFINITY);
        const sum = summarize(ms);
        console.log(`PROBES ${TASK} ${op}: ${js(ms.map((t) => (Number.isFinite(t) ? Math.round(t * 10) / 10 : "none")))}`);
        console.log(`SUMMARY ${TASK} SC-008 ${op}: n=${sum.n} median=${sum.median.toFixed(1)} ms p95=${sum.p95.toFixed(1)} ms max=${sum.max.toFixed(1)} ms without response ${missing}; u=Δ=${(delta * 1000).toFixed(2)} ms; frames ${frames.length}`);

        // 001 plan.md "Measurements and budgets": CPU-seconds, peak CPU over the probe interval, and the peak committed bytes of the Job (all processes, exited ones included).
        const cpus = availableParallelism();
        let peak = 0;
        for (let i = 1; i < cpu.length; i++) peak = Math.max(peak, (cpu[i]!.ms - cpu[i - 1]!.ms) / (cpu[i]!.at - cpu[i - 1]!.at) / cpus);
        const cpuSeconds = (after.userMs + after.kernelMs - before.userMs - before.kernelMs) / 1000;
        console.log(
          `OBSERVATION ${TASK} ${op}: CPU-seconds ${cpuSeconds.toFixed(3)}, peak CPU ${(peak * 100).toFixed(1)}% of ${cpus} logical processors, processes ${after.processes - before.processes} started, peak Job committed bytes ${after.peakJobBytes} (session), peak process committed bytes ${after.peakProcessBytes}; no budget: plan.md "Performance Goals" holds no T078 rows (T076 open)`,
        );
        console.log(`OBSERVATION ${TASK} ${op}: renderer long tasks unverified (the WPR Verbose trace of 001 T165 is not part of this case)`);

        if (probes.length < MIN_PROBES) throw new Error(`only ${probes.length} probes ran during the ${op}; the workload needs at least ${MIN_PROBES}`);
        expect({ p95Within: sum.p95 <= INPUT.p95Ms, maxWithin: sum.max <= INPUT.maxMs }).toEqual({ p95Within: true, maxWithin: true });
      },
      async () => {
        const errors: unknown[] = [];
        for (const step of [() => (dup as Duplication | null)?.close(), releaseDisplay]) {
          try {
            step();
          } catch (error) {
            errors.push(error);
          }
        }
        await http.stop().catch((error) => void errors.push(error));
        if (!http.ended()) errors.push(new Error("a CGI process of the HTTP remote has no exit record"));
        return errors;
      },
    );
  }

  for (const op of ["fetch", "pull", "push"] as const) {
    test.skipIf(reason !== null)(`SC-008 ${op}: probe inputs every 100 ms during the ${op} keep 95% of responses within 100 ms and every response within 500 ms`, () => workload(op), CASE_MS);
  }

  // 001 plan.md "Responsiveness metrics" defines two probe targets: the History list and the message field. The clone panel hides both (src/frontend/app/Workbench.tsx `mainPanel`).
  console.log(`SKIP ${TASK} SC-008 clone: missing decision: no 001 probe target shows while the clone panel is open (unverified)`);
  test.skip("SC-008 clone (SKIP: no 001 probe target shows while the clone panel is open)", () => {});
});
