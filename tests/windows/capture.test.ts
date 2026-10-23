// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Only the live app case injects input, and it runs only with ARBARETO_LIVE_INPUT=1 in the measurement account.

import { afterAll, describe, expect, test } from "bun:test";
import { inflateSync, crc32 } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { FIXTURE_ROOT, fixtureDir, fixtureGit, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { appEnv, findInstalledApp, startInstalledApp, waitExit, type OwnedProcess } from "./installed-app";
import { boundingRect, find, inputDesktopSkip, invoke, MAX_WAIT_MS, waitFocus, type Element } from "./uia";
import { qpc, qpcFrequency } from "./inject";
import {
  analyzeRun,
  applyMask,
  blockStatus,
  buildMask,
  CaptureError,
  deltaSeconds,
  DISPLAY_OFF,
  displayState,
  encodePng,
  hashImage,
  keepDisplayOn,
  openDuplication,
  parseArgs,
  releaseDisplay,
  stopReason,
  type BlockRun,
  type Duplication,
  type Frame,
  type Opened,
  type Region,
  type RunResult,
} from "./capture";
import { srcImportHits } from "./src-imports";
import { withProbe } from "./probe-window";

const CAPTURE = printOrigin("./capture.ts", import.meta.dir);
const INJECT = printOrigin("./inject.ts", import.meta.dir);

const code = (body: () => unknown) => {
  try {
    body();
  } catch (error) {
    if (error instanceof CaptureError) return error.code;
    throw error;
  }
  return null;
};

// One QPC tick is 1 µs here, so 1 second is 1,000,000 ticks.
const F = 1_000_000n;
const DELTA = 1 / 165;
const timing = { frequency: F, delta: DELTA };
const frame = (t: number, hash: string, accumulated = 1): Frame => ({ lastPresentTime: BigInt(t), accumulatedFrames: accumulated, hash });
const valid = (result: RunResult) => {
  if (!result.valid) throw new Error(`invalid run: ${result.cause}`);
  return result;
};

describe("T242 capture.ts without input", () => {
  test("no file under src/ imports bun:ffi or capture.ts", () => {
    expect(srcImportHits([CAPTURE])).toEqual([]);
  });

  test("arguments: region, run limits, modes", () => {
    expect(parseArgs(["--region", "10,20,300,200", "--out", "o"])).toEqual({ mode: "run", region: { x: 10, y: 20, width: 300, height: 200 }, limit: 30, out: "o", mask: null, launch: null });
    expect(parseArgs(["--region", "0,0,8,8", "--out", "o", "--limit", "90", "--mask", "m", "--launch", "app.exe", "--flag"])).toMatchObject({ limit: 90, mask: "m", launch: ["app.exe", "--flag"] });
    expect(parseArgs(["--calibrate", "--region", "0,0,8,8", "--out", "o"])).toMatchObject({ mode: "calibrate" });
    expect(parseArgs(["--analyze", "o", "--start", "123", "--settled", "ab"])).toEqual({ mode: "analyze", out: "o", start: 123n, settled: "ab" });
    for (const bad of [[], ["--region", "0,0,0,8", "--out", "o"], ["--region", "0,0,8", "--out", "o"], ["--region", "0,0,8,8"], ["--region", "0,0,8,8", "--out", "o", "--limit", "45"], ["--analyze", "o"], ["--bogus"]]) {
      expect(code(() => parseArgs(bad))).toBe("BAD_ARGUMENT");
    }
  });

  test("Δ is one refresh interval of the current mode", () => {
    expect(deltaSeconds(165, 1)).toBeCloseTo(1 / 165, 12);
    expect(deltaSeconds(60000, 1001)).toBeCloseTo(1001 / 60000, 12);
    expect(code(() => deltaSeconds(0, 1))).toBe("NO_REFRESH_RATE");
    expect(code(() => deltaSeconds(60, 0))).toBe("NO_REFRESH_RATE");
  });

  test("settled frame, end frame, and the run time", () => {
    const run = valid(analyzeRun([frame(100, "A"), frame(200_000, "B"), frame(300_000, "C"), frame(400_000, "C")], 150_000n, timing));
    expect(run.settled.hash).toBe("C");
    expect(run.end.lastPresentTime).toBe(300_000n);
    expect(run.seconds).toBeCloseTo(0.15, 9);
    expect(run.u).toBe(DELTA);
  });

  test("a region that changes and returns ends at the return", () => {
    const run = valid(analyzeRun([frame(100, "A"), frame(200_000, "B"), frame(250_000, "A")], 150_000n, timing));
    expect(run.end.lastPresentTime).toBe(250_000n);
  });

  test("u is the gap to the previous frame when the end frame accumulates frames and the gap exceeds Δ", () => {
    expect(valid(analyzeRun([frame(100_000, "A"), frame(150_000, "B", 2)], 120_000n, timing)).u).toBeCloseTo(0.05, 9);
    expect(valid(analyzeRun([frame(147_000, "A"), frame(150_000, "B", 2)], 120_000n, timing)).u).toBe(DELTA);
    expect(valid(analyzeRun([frame(100_000, "A"), frame(150_000, "B", 1)], 120_000n, timing)).u).toBe(DELTA);
  });

  test("invalid runs carry their cause and kind", () => {
    const none = analyzeRun([frame(100, "A"), frame(200_000, "A")], 150_000n, timing);
    expect(none).toEqual({ valid: false, cause: "no-region-change", kind: "repeatable" });
    // The last change came before the start event.
    expect(analyzeRun([frame(100, "A"), frame(120_000, "B"), frame(200_000, "B")], 150_000n, timing)).toEqual({ valid: false, cause: "no-region-change", kind: "repeatable" });
    expect(analyzeRun([frame(100, "A"), frame(200_000, "B")], 150_000n, timing, "C")).toEqual({ valid: false, cause: "settled-hash", kind: "repeatable" });
    expect(analyzeRun([frame(100, "A"), frame(200_000, "B")], 150_000n, timing, undefined, "access-lost")).toEqual({ valid: false, cause: "access-lost", kind: "one-off" });
    expect(analyzeRun([], 150_000n, timing, undefined, "secure-desktop")).toEqual({ valid: false, cause: "secure-desktop", kind: "one-off" });
  });

  test("the loop stops 3 seconds after the last change, or at the run limit", () => {
    const frames = [frame(0, "A"), frame(1_000_000, "B"), frame(2_000_000, "B")];
    expect(stopReason([frame(0, "A")], 29_000_000n, 0n, F, 30)).toBeNull();
    expect(stopReason(frames, 3_999_999n, 0n, F, 30)).toBeNull();
    expect(stopReason(frames, 4_000_000n, 0n, F, 30)).toBe("settled");
    expect(stopReason([frame(0, "A")], 30_000_000n, 0n, F, 30)).toBe("limit");
  });

  test("the mask holds pixels that change during calibration, and the hash ignores them", () => {
    const image = (caret: number, other = 0) => Uint8Array.from([1, 2, 3, 255, caret, caret, caret, 255, other, 0, 0, 255, 9, 9, 9, 255]);
    const mask = buildMask([image(0), image(200), image(0)], 2, 2);
    expect([...mask]).toEqual([0, 1, 0, 0]);
    expect([...applyMask(image(77), mask)]).toEqual([1, 2, 3, 255, 0, 0, 0, 0, 0, 0, 0, 255, 9, 9, 9, 255]);
    expect(hashImage(image(10), mask)).toBe(hashImage(image(99), mask));
    expect(hashImage(image(10, 1), mask)).not.toBe(hashImage(image(10, 0), mask));
    expect(code(() => buildMask([image(0), Uint8Array.of(0)], 2, 2))).toBe("BAD_ARGUMENT");
  });

  test("the settled region saves as a lossless PNG", () => {
    const bgra = Uint8Array.from([10, 20, 30, 255, 40, 50, 60, 128]);
    const png = encodePng(bgra, 2, 1);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const chunks: Record<string, Buffer> = {};
    for (let at = 8; at < png.length; ) {
      const length = png.readUInt32BE(at);
      const type = png.subarray(at + 4, at + 8).toString("latin1");
      const data = png.subarray(at + 8, at + 8 + length);
      expect(png.readUInt32BE(at + 8 + length)).toBe(crc32(png.subarray(at + 4, at + 8 + length)));
      chunks[type] = data;
      at += 12 + length;
    }
    expect(Object.keys(chunks)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect([...chunks.IHDR!]).toEqual([0, 0, 0, 2, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
    // Filter byte 0, then RGBA pixels.
    expect([...inflateSync(chunks.IDAT!)]).toEqual([0, 30, 20, 10, 255, 60, 50, 40, 128]);
  });

  describe("block rules (plan.md \"Invalid capture\")", () => {
    const ok: BlockRun = { warmup: false, result: valid(analyzeRun([frame(0, "A"), frame(2, "B")], 1n, timing)) };
    const bad = (cause: "no-region-change" | "settled-hash" | "access-lost" | "secure-desktop", warmup = false): BlockRun => ({
      warmup,
      result: { valid: false, cause, kind: cause === "access-lost" || cause === "secure-desktop" ? "one-off" : "repeatable" },
    });
    const warm: BlockRun = { ...ok, warmup: true };

    test("a block completes after its counted runs; the warm-up run is not counted", () => {
      expect(blockStatus("arbareto", 2, [warm, ok])).toEqual({ state: "open", remaining: 1, added: 0 });
      expect(blockStatus("arbareto", 2, [warm, ok, ok])).toEqual({ state: "complete", added: 0 });
    });

    test("each invalid counted run adds one run, and an invalid warm-up run adds none", () => {
      expect(blockStatus("arbareto", 2, [warm, bad("access-lost"), ok])).toEqual({ state: "open", remaining: 1, added: 1 });
      expect(blockStatus("arbareto", 2, [bad("access-lost", true), ok])).toEqual({ state: "open", remaining: 1, added: 0 });
    });

    test("one-off failures with one cause never end a block before the fourth invalid run", () => {
      const three = [warm, bad("access-lost"), bad("access-lost"), bad("secure-desktop")];
      expect(blockStatus("arbareto", 2, three)).toEqual({ state: "open", remaining: 2, added: 3 });
      expect(blockStatus("arbareto", 2, [...three, bad("access-lost")])).toEqual({ state: "ended", label: "unverified", cause: "access-lost", causes: ["access-lost", "access-lost", "secure-desktop", "access-lost"] });
    });

    test("a second repeatable failure with one cause ends the block", () => {
      const nrc = "no-region-change";
      expect(blockStatus("arbareto", 5, [warm, bad(nrc), ok, bad(nrc)])).toEqual({ state: "ended", label: "missed", cause: nrc, causes: [nrc, nrc] });
      expect(blockStatus("git-extensions", 5, [warm, bad(nrc), bad(nrc)])).toEqual({ state: "ended", label: "unverified", cause: nrc, causes: [nrc, nrc] });
      expect(blockStatus("arbareto", 5, [warm, bad("settled-hash"), bad("settled-hash")])).toEqual({ state: "ended", label: "unverified", cause: "settled-hash", causes: ["settled-hash", "settled-hash"] });
      expect(blockStatus("arbareto", 5, [warm, bad("settled-hash"), bad("no-region-change")])).toEqual({ state: "open", remaining: 5, added: 2 });
    });

    test("an invalid warm-up run counts toward both end rules", () => {
      expect(blockStatus("arbareto", 5, [bad("no-region-change", true), bad("no-region-change")])).toEqual({ state: "ended", label: "missed", cause: "no-region-change", causes: ["no-region-change", "no-region-change"] });
      const four = [bad("access-lost", true), bad("access-lost"), bad("secure-desktop"), bad("access-lost")];
      expect(blockStatus("arbareto", 5, four)).toMatchObject({ state: "ended", label: "unverified" });
    });

    test("a fourth invalid run ends the block as unverified, even when it is the first no-region-change", () => {
      const runs = [warm, bad("access-lost"), bad("access-lost"), bad("settled-hash"), bad("no-region-change")];
      expect(blockStatus("arbareto", 5, runs)).toEqual({ state: "ended", label: "unverified", cause: "no-region-change", causes: ["access-lost", "access-lost", "settled-hash", "no-region-change"] });
    });

    test("a run after the end of a block refuses", () => {
      expect(code(() => blockStatus("arbareto", 1, [warm, ok, ok]))).toBe("BAD_ARGUMENT");
    });
  });
});

// A top-most WPF window over the region. `ShowActivated="False"` keeps the desktop focus with the user. It prints "rendered" after its first render.
const PROBE = `
Add-Type -AssemblyName PresentationFramework
$w = [Windows.Markup.XamlReader]::Parse(@'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Title="Capture probe" ShowActivated="False" ShowInTaskbar="False" Topmost="True" WindowStyle="None" ResizeMode="NoResize" WindowStartupLocation="Manual" Left="0" Top="0" Width="64" Height="64"><Grid Background="#102030"/></Window>
'@)
$w.Add_ContentRendered({ [Console]::WriteLine("rendered") })
$w.Show()
[Windows.Threading.Dispatcher]::Run()
`;
// #102030 in the BGRA order of the duplicated desktop image.
const PROBE_BGRA = [0x30, 0x20, 0x10, 0xff];

// A CaptureError, such as DPI_SCALED or ROTATED, also names a missing capability.
function tryOpen(region: Region): Opened {
  try {
    return openDuplication(region);
  } catch (error) {
    if (error instanceof CaptureError) return { skip: error.message, hresult: error.hresult ?? null };
    throw error;
  }
}

// Desktop duplication gives no frames while the display is off. The request keeps an on display on during the live cases.
if (process.platform === "win32") keepDisplayOn();
const displayOff = process.platform === "win32" && (await displayState()) === DISPLAY_OFF;

describe.skipIf(process.platform !== "win32")("T242 capture.ts live", () => {
  afterAll(releaseDisplay);
  // This first open also makes the test process per-monitor DPI aware, so the UIA rectangles below are physical pixels.
  const opened: Opened = displayOff ? { skip: "display-off", hresult: null } : tryOpen({ x: 0, y: 0, width: 16, height: 16 });
  if ("skip" in opened) console.log(`SKIP desktop duplication: missing capability ${opened.skip}`);

  test.skipIf("skip" in opened)(
    "duplicates the reference output and reads the probe colour in one region frame",
    () =>
      withProbe(PROBE, async (probe) => {
        const dup = "skip" in opened ? null! : opened.dup;
        try {
          console.log(`ADAPTER ${dup.adapter}`);
          console.log(`OUTPUT ${dup.output.name} ${JSON.stringify(dup.output.rect)} mode=${dup.mode.width}x${dup.mode.height} refresh=${dup.mode.numerator}/${dup.mode.denominator}`);
          console.log(`DELTA_MS ${deltaSeconds(dup.mode.numerator, dup.mode.denominator) * 1000}`);
          const reader = probe.stdout.getReader();
          const timer = setTimeout(() => probe.kill(), MAX_WAIT_MS);
          const chunk = await reader.read().finally(() => clearTimeout(timer));
          expect(new TextDecoder().decode(chunk.value)).toContain("rendered");
          const expected = Array.from({ length: 16 * 16 }, () => PROBE_BGRA).flat();
          let got = null;
          // `acquire` skips the pointer-only first frame. The next frame can still predate the probe composition. 20 waits of 100 ms bound the case.
          for (let i = 0; i < 20 && (got === null || !Bun.deepEquals([...got.image], expected)); i++) got = dup.acquire(100) ?? got;
          expect(got).not.toBeNull();
          expect(got!.lastPresentTime).toBeGreaterThan(0n);
          console.log(`REGION_BGRA ${[...got!.image.subarray(0, 4)]}`);
          expect([...got!.image]).toEqual(expected);
        } finally {
          dup.close();
        }
      }),
    MAX_WAIT_MS + 10_000,
  );

  describe("installed app", () => {
    // Bun 1.4.4 runs `afterAll` hooks in declaration order, also when a test timeout leaves its body running. This hook must come before the fixture root removal.
    let owned: OwnedProcess | undefined;
    afterAll(() => owned?.stop());
    useFixtureRoot();
    const found = findInstalledApp();
    const app = "app" in found ? found.app : null;
    const reason = app === null ? (found as { skip: string }).skip : GIT === null ? "Git executable absent" : process.env.ARBARETO_LIVE_INPUT !== "1" ? "live input needs the measurement account: set ARBARETO_LIVE_INPUT=1" : "skip" in opened ? `missing capability ${opened.skip}` : inputDesktopSkip();
    if (reason !== null) console.log(`SKIP installed app: ${reason}`);

    test.skipIf(reason !== null)(
      "a typed character changes the message field within 1 second of its injection",
      async () => {
        const repo = fixtureDir("repo");
        writeFileSync(join(repo, "untracked.txt"), "untracked\n");
        fixtureGit(GIT!, repo, ["init", "-q"]);
        const inject = (...keys: string[]) => {
          const proc = Bun.spawnSync([process.execPath, INJECT, ...keys], { stdout: "pipe", stderr: "inherit" });
          expect(proc.exitCode).toBe(0);
          return [...proc.stdout.toString().matchAll(/qpc=(\d+)/g)].map((m) => BigInt(m[1]!));
        };
        const using = async <T,>(element: Promise<Element>, body: (e: Element) => T): Promise<T> => {
          const e = await element;
          try {
            return await body(e);
          } finally {
            e.release();
          }
        };
        const launched = (owned = startInstalledApp(app!, appEnv(fixtureDir("app"), false)));
        let dup: Duplication | null = null;
        try {
          await using(find(launched.pid, "Select Git", MAX_WAIT_MS), invoke);
          await using(find(launched.pid, "Use this Git", MAX_WAIT_MS), invoke);
          await using(find(launched.pid, "Open folder… (Ctrl+O)", MAX_WAIT_MS), invoke);
          // The Folder box name of the Windows folder picker. T180 confirms it.
          await waitFocus(launched.pid, "Folder:", MAX_WAIT_MS);
          inject(`text:${repo}`, "Enter");
          await using(find(launched.pid, "Working directory, 1 working change", MAX_WAIT_MS), () => {});
          // T241 fallback: the T240 driver has no focus method. Four F6 presses move from the history list to the composer (plan.md "Keyboard and focus").
          inject("Home", "F6", "F6", "F6", "F6");
          await waitFocus(launched.pid, "Commit message", MAX_WAIT_MS);
          const region = await using(find(launched.pid, "Commit message", MAX_WAIT_MS), boundingRect);
          console.log(`REGION ${JSON.stringify(region)}`);
          const reopened = tryOpen(region);
          if ("skip" in reopened) throw new Error(`desktop duplication: ${reopened.skip}`);
          dup = reopened.dup;
          const frequency = qpcFrequency();
          // A 5-second calibration of the settled field gives the mask (plan.md "Mask"). 20 waits bound the first frame.
          let before = null;
          for (let i = 0; i < 20 && before === null; i++) before = dup.acquire(100);
          if (before === null) throw new Error("no first frame of the message field");
          const images = [before.image];
          const first = qpc();
          while (qpc() - first < 5n * frequency) {
            const got = dup.acquire(100);
            if (got !== null) images.push(got.image);
          }
          const mask = buildMask(images, region.width, region.height);
          const base = hashImage(before.image, mask);
          const frames: Frame[] = [{ lastPresentTime: before.lastPresentTime, accumulatedFrames: before.accumulatedFrames, hash: base }];
          let last = before.image;
          const [at] = inject("text:x");
          const started = qpc();
          while (stopReason(frames, qpc(), started, frequency, 30) === null) {
            const got = dup.acquire(100);
            if (got === null) continue;
            frames.push({ lastPresentTime: got.lastPresentTime, accumulatedFrames: got.accumulatedFrames, hash: hashImage(got.image, mask) });
            last = got.image;
          }
          const changed = frames.find((f) => f.lastPresentTime > at! && f.hash !== base);
          const png = `${FIXTURE_ROOT}-settled.png`;
          writeFileSync(png, encodePng(last, region.width, region.height));
          console.log(`SETTLED_PNG ${png}: the tester confirms the typed character; otherwise record unverified`);
          expect(changed).toBeDefined();
          const seconds = Number(changed!.lastPresentTime - at!) / Number(frequency);
          console.log(`INPUT_RESPONSE_S ${seconds}`);
          expect(seconds).toBeLessThanOrEqual(1);
        } finally {
          dup?.close();
          launched.stop();
          expect(await waitExit(launched)).not.toBeNull();
        }
      },
      120_000,
    );
  });
});
