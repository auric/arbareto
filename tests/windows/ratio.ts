// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// SC-015 ratio and percentile bootstrap interval (T243, plan.md §Matched-condition comparisons). Usage:
//   bun tests/windows/ratio.ts <runs.json>
// Input: {"target": <ratio>, "arbareto": [Run], "gitExtensions": [Run], "ended"?: [{"app": "arbareto"|"gitExtensions", "cause": Cause}]}.
// Run: {"ms": <counted run time in ms>, "uMs": <run uncertainty u in ms>}. Warm-up runs never go into this file.
// Exit 0: label `met`. Exit 1: any other label. Exit 2: bad input.

import { readFileSync } from "node:fs";

export type App = "arbareto" | "gitExtensions";
// plan.md "Invalid capture": the block end causes.
const CAUSES = ["no-region-change", "other-settled-hash", "fourth-invalid-run"] as const;
export type Cause = (typeof CAUSES)[number];
export interface Run {
  ms: number;
  uMs: number;
}
export interface Runs {
  target: number;
  arbareto: Run[];
  gitExtensions: Run[];
  ended: { app: App; cause: Cause }[];
}
export type Result =
  | { kind: "interval"; arbaretoMedianMs: number; gitExtensionsMedianMs: number; ratio: number; lower: number; upper: number; label: "met" | "missed" | "inconclusive" }
  | { kind: "ended"; label: "missed" | "unverified"; ended: Runs["ended"] };

const RESAMPLES = 10_000;
const SEED = 42;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function keys(v: unknown, where: string, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!isObject(v)) throw new Error(`${where}: expected an object`);
  for (const k of Object.keys(v)) if (!required.includes(k) && !optional.includes(k)) throw new Error(`${where}: unknown key ${k}`);
  for (const k of required) if (!(k in v)) throw new Error(`${where}: missing key ${k}`);
  return v;
}
function number(v: unknown, where: string, positive: boolean): number {
  if (typeof v !== "number" || !Number.isFinite(v) || (positive ? v <= 0 : v < 0)) throw new Error(`${where}: expected a finite number ${positive ? "above 0" : "at or above 0"}`);
  return v;
}

export function parseRuns(value: unknown): Runs {
  const o = keys(value, "runs file", ["target", "arbareto", "gitExtensions"], ["ended"]);
  const target = number(o.target, "target", true);
  const endedRaw = o.ended ?? [];
  if (!Array.isArray(endedRaw)) throw new Error("ended: expected an array");
  const ended = endedRaw.map((e, i) => {
    const m = keys(e, `ended[${i}]`, ["app", "cause"]);
    if (m.app !== "arbareto" && m.app !== "gitExtensions") throw new Error(`ended[${i}].app: expected arbareto or gitExtensions`);
    if (!CAUSES.includes(m.cause as Cause)) throw new Error(`ended[${i}].cause: expected one of ${CAUSES.join(", ")}`);
    return { app: m.app as App, cause: m.cause as Cause };
  });
  const list = (app: App): Run[] => {
    const raw = o[app];
    if (!Array.isArray(raw)) throw new Error(`${app}: expected an array`);
    // A median needs one run. An ended block gives no interval, so its runs can be absent.
    if (raw.length === 0 && ended.length === 0) throw new Error(`${app}: expected at least one counted run`);
    return raw.map((r, i) => {
      const m = keys(r, `${app}[${i}]`, ["ms", "uMs"]);
      const run = { ms: number(m.ms, `${app}[${i}].ms`, false), uMs: number(m.uMs, `${app}[${i}].uMs`, false) };
      // The ratio divides by Git Extensions times minus u.
      if (app === "gitExtensions" && run.ms - run.uMs <= 0) throw new Error(`${app}[${i}]: ms minus uMs must be above 0`);
      return run;
    });
  };
  return { target, arbareto: list("arbareto"), gitExtensions: list("gitExtensions"), ended };
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

// Marsaglia 2003, "Xorshift RNGs", J. Stat. Softw. 8(14): the 32-bit generator with shifts 13, 17, 5.
export function xorshift32(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

// An unbiased index in [0, n): reject the top values that 2^32 mod n leaves over.
function index(next: () => number, n: number): number {
  const limit = 2 ** 32 - (2 ** 32 % n);
  for (;;) {
    const x = next();
    if (x < limit) return x % n;
  }
}

export function evaluate(runs: Runs): Result {
  if (runs.ended.length > 0) {
    const missed = runs.ended.some((e) => e.app === "arbareto" && e.cause === "no-region-change");
    return { kind: "ended", label: missed ? "missed" : "unverified", ended: runs.ended };
  }
  const a = runs.arbareto.map((r) => r.ms + r.uMs);
  const g = runs.gitExtensions.map((r) => r.ms - r.uMs);
  const arbaretoMedianMs = median(a);
  const gitExtensionsMedianMs = median(g);
  const next = xorshift32(SEED);
  const ratios = new Float64Array(RESAMPLES);
  for (let i = 0; i < RESAMPLES; i++) {
    const ra = a.map(() => a[index(next, a.length)]!);
    const rg = g.map(() => g[index(next, g.length)]!);
    ratios[i] = median(ra) / median(rg);
  }
  ratios.sort();
  // Nearest rank: the value at rank ceil(p * N).
  const lower = ratios[Math.ceil(0.025 * RESAMPLES) - 1]!;
  const upper = ratios[Math.ceil(0.975 * RESAMPLES) - 1]!;
  const label = upper <= runs.target ? "met" : lower > runs.target ? "missed" : "inconclusive";
  return { kind: "interval", arbaretoMedianMs, gitExtensionsMedianMs, ratio: arbaretoMedianMs / gitExtensionsMedianMs, lower, upper, label };
}

if (import.meta.main) {
  let result: Result;
  try {
    if (process.argv.length !== 3) throw new Error("usage: bun tests/windows/ratio.ts <runs.json>");
    result = evaluate(parseRuns(JSON.parse(readFileSync(process.argv[2]!, "utf8"))));
  } catch (e) {
    console.error(`ratio: ${(e as Error).message}`);
    process.exit(2);
  }
  if (result.kind === "ended") {
    for (const e of result.ended) console.log(`ended ${e.app} ${e.cause}`);
  } else {
    console.log(`arbareto-median-ms ${result.arbaretoMedianMs}`);
    console.log(`git-extensions-median-ms ${result.gitExtensionsMedianMs}`);
    console.log(`ratio ${result.ratio}`);
    console.log(`interval ${result.lower} ${result.upper}`);
  }
  console.log(`label ${result.label}`);
  process.exit(result.label === "met" ? 0 : 1);
}
