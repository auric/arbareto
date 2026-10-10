// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { evaluate, median, parseRuns, xorshift32 } from "./ratio";

const SCRIPT = printOrigin("./ratio.ts", import.meta.dir);
const dir = mkdtempSync(join(tmpdir(), "arbareto-ratio-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const runs = (ms: number[], uMs = 0) => ms.map((m) => ({ ms: m, uMs }));
const input = (a: number[], g: number[], uMs = 0, target = 0.5) => ({ target, arbareto: runs(a, uMs), gitExtensions: runs(g, uMs) });

function cli(json: string) {
  const file = join(dir, `${crypto.randomUUID()}.json`);
  writeFileSync(file, json);
  const r = Bun.spawnSync([process.execPath, SCRIPT, file], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("median", () => {
  test("odd count gives the middle value", () => expect(median([9, 1, 5])).toBe(5));
  test("five runs give the third value", () => expect(median([50, 10, 40, 20, 30])).toBe(30));
  test("even count gives the mean of the two middle values", () => expect(median([4, 1, 3, 2])).toBe(2.5));
  test("ties", () => {
    expect(median([5, 7, 5, 7])).toBe(6);
    expect(median([3, 9, 3, 3])).toBe(3);
  });
});

describe("xorshift32", () => {
  // Marsaglia 2003, shifts 13, 17, 5. Hand-computed: seed 1 gives 270369; seed 42 gives 11355432.
  test("first outputs", () => {
    expect(xorshift32(1)()).toBe(270369);
    expect(xorshift32(42)()).toBe(11355432);
  });
});

describe("evaluate", () => {
  test("hand-computed case with three runs per application", () => {
    const r = evaluate(
      parseRuns({
        target: 0.5,
        arbareto: [{ ms: 100, uMs: 4 }, { ms: 120, uMs: 6 }, { ms: 110, uMs: 5 }],
        gitExtensions: [{ ms: 300, uMs: 5 }, { ms: 260, uMs: 5 }, { ms: 280, uMs: 10 }],
      }),
    );
    // Arbareto 104, 126, 115 -> 115. Git Extensions 295, 255, 270 -> 270.
    if (r.kind !== "interval") throw new Error("expected an interval");
    expect(r.arbaretoMedianMs).toBe(115);
    expect(r.gitExtensionsMedianMs).toBe(270);
    expect(r.ratio).toBe(115 / 270);
    // Every resample ratio lies between 104/295 and 126/255.
    expect(r.lower).toBeGreaterThanOrEqual(104 / 295);
    expect(r.upper).toBeLessThanOrEqual(126 / 255);
    expect(r.label).toBe("met");
  });

  test("equal samples give the ratio 1 and the interval [1, 1]", () => {
    const r = evaluate(parseRuns(input([50, 50, 50, 50, 50], [50, 50, 50, 50, 50], 0, 1)));
    expect(r).toMatchObject({ kind: "interval", ratio: 1, lower: 1, upper: 1, label: "met" });
  });

  test("the same input gives the same interval", () => {
    const i = input([100, 130, 90, 160, 110, 95, 140, 120, 105, 150], [250, 300, 220, 280, 310, 240, 260, 290, 230, 270]);
    const a = evaluate(parseRuns(i));
    const b = evaluate(parseRuns(structuredClone(i)));
    expect(a).toEqual(b);
    if (a.kind !== "interval") throw new Error("expected an interval");
    expect(a.lower).toBeLessThan(a.upper);
  });

  test("a positive u raises the ratio", () => {
    const a = evaluate(parseRuns(input([100, 110, 120], [200, 210, 220], 0)));
    const b = evaluate(parseRuns(input([100, 110, 120], [200, 210, 220], 6.06)));
    if (a.kind !== "interval" || b.kind !== "interval") throw new Error("expected intervals");
    expect(b.ratio).toBeGreaterThan(a.ratio);
  });

  test("labels follow the interval and the target", () => {
    expect(evaluate(parseRuns(input([60, 60, 60], [100, 100, 100], 0, 0.5)))).toMatchObject({ label: "missed" });
    expect(evaluate(parseRuns(input([40, 60, 50], [100, 100, 100], 0, 0.5)))).toMatchObject({ label: "inconclusive" });
  });

  test("an Arbareto block ended by no region change gives missed", () => {
    const r = evaluate(parseRuns({ ...input([], []), ended: [{ app: "arbareto", cause: "no-region-change" }] }));
    expect(r).toEqual({ kind: "ended", label: "missed", ended: [{ app: "arbareto", cause: "no-region-change" }] });
  });

  test("a Git Extensions block ended by no region change gives unverified", () => {
    const r = evaluate(parseRuns({ ...input([], []), ended: [{ app: "gitExtensions", cause: "no-region-change" }] }));
    expect(r).toMatchObject({ kind: "ended", label: "unverified" });
  });

  test("other ended causes give unverified", () => {
    for (const cause of ["other-settled-hash", "fourth-invalid-run"]) {
      expect(evaluate(parseRuns({ ...input([], []), ended: [{ app: "arbareto", cause }] }))).toMatchObject({ label: "unverified" });
    }
  });
});

describe("parseRuns refuses bad input", () => {
  const good = input([1, 2, 3], [4, 5, 6]);
  const cases: [string, unknown][] = [
    ["not an object", [1]],
    ["no target", { arbareto: good.arbareto, gitExtensions: good.gitExtensions }],
    ["zero target", { ...good, target: 0 }],
    ["unknown key", { ...good, extra: 1 }],
    ["too few runs", { ...good, arbareto: [] }],
    ["string time", { ...good, arbareto: [{ ms: "1", uMs: 0 }] }],
    ["non-finite time", { ...good, arbareto: [{ ms: Infinity, uMs: 0 }] }],
    ["negative u", { ...good, arbareto: [{ ms: 1, uMs: -1 }] }],
    ["unknown run key", { ...good, arbareto: [{ ms: 1, uMs: 0, s: 1 }] }],
    ["Git Extensions time not above u", { ...good, gitExtensions: [{ ms: 5, uMs: 5 }] }],
    ["unknown cause", { ...good, ended: [{ app: "arbareto", cause: "slow" }] }],
    ["unknown app", { ...good, ended: [{ app: "other", cause: "no-region-change" }] }],
  ];
  for (const [name, value] of cases) test(name, () => expect(() => parseRuns(value)).toThrow());
});

describe("CLI", () => {
  test("met exits 0 and prints the medians, the ratio, and the interval", () => {
    const r = cli(JSON.stringify(input([50, 50, 50], [100, 100, 100])));
    expect(r.code).toBe(0);
    expect(r.out).toBe("arbareto-median-ms 50\ngit-extensions-median-ms 100\nratio 0.5\ninterval 0.5 0.5\nlabel met\n");
  });

  test("an upper bound above the target exits 1", () => {
    expect(cli(JSON.stringify(input([40, 60, 50], [100, 100, 100]))).code).toBe(1);
  });

  test("an ended block prints its label and no interval, and exits 1", () => {
    const r = cli(JSON.stringify({ ...input([], []), ended: [{ app: "arbareto", cause: "no-region-change" }] }));
    expect(r.code).toBe(1);
    expect(r.out).toBe("ended arbareto no-region-change\nlabel missed\n");
  });

  test("bad input exits 2", () => {
    // JSON.parse turns 1e999 into Infinity.
    const r = cli('{"target":0.5,"arbareto":[{"ms":1e999,"uMs":0}],"gitExtensions":[{"ms":5,"uMs":0}]}');
    expect(r.code).toBe(2);
    expect(r.err).toContain("ms");
    expect(cli("{").code).toBe(2);
  });
});
