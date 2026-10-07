// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Runs the test groups of `tests/groups.json` (T324). Usage: `bun tests/run.ts full|fast`.
// Step 1 runs the parallel group with `bun test --parallel`. Step 2 runs the serial group in one `bun test` process.
// A serial file measures wall or CPU time or asserts a wall-clock budget, so no other test file runs beside it.

import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Groups {
  roots: string[];
  // File to the reason that it measures time.
  serial: Record<string, string>;
  parallel: string[];
  // Files, or folders that end with "/".
  fast: string[];
}

const REPO = join(import.meta.dir, "..");
const groups = JSON.parse(readFileSync(join(import.meta.dir, "groups.json"), "utf8")) as Groups;
const mode = process.argv[2];
if (mode !== "full" && mode !== "fast") throw new Error("usage: bun tests/run.ts full|fast");

const slash = (p: string) => p.replaceAll("\\", "/");
// Bun 1.4.2 docs/test/discovery.mdx: the default test file name patterns.
const TEST_FILE = new Bun.Glob("**/*{.test,_test,.spec,_spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}");
const discovered = groups.roots.flatMap((root) => [...TEST_FILE.scanSync({ cwd: join(REPO, root) })].map((f) => `${root}/${slash(f)}`)).sort();
const serial = Object.keys(groups.serial);

// The group check: each discovered file is in exactly one group, and each listed entry exists.
const problems: string[] = [];
const listed = [...serial, ...groups.parallel];
for (const f of discovered) {
  const n = listed.filter((l) => l === f).length;
  if (n !== 1) problems.push(`${f} is in ${n} groups`);
}
for (const f of listed) if (!discovered.includes(f)) problems.push(`${f} is listed but is not a discovered test file`);
const inFast = (f: string) => groups.fast.some((e) => (e.endsWith("/") ? f.startsWith(e) : f === e));
for (const e of groups.fast) if (!discovered.some((f) => (e.endsWith("/") ? f.startsWith(e) : f === e))) problems.push(`fast entry ${e} selects no discovered test file`);
if (problems.length > 0) {
  for (const p of problems) console.error(`GROUPS ${p}`);
  process.exit(1);
}

const selected = mode === "full" ? discovered : discovered.filter(inFast);
const steps = [
  { name: "parallel", files: selected.filter((f) => groups.parallel.includes(f)), flags: ["--parallel"] },
  { name: "serial", files: selected.filter((f) => serial.includes(f)), flags: [] },
];
console.log(`RUN ${mode}: ${selected.length} of ${discovered.length} discovered files`);

const out = join(tmpdir(), `arbareto-test-run-${crypto.randomUUID()}`);
mkdirSync(out);
let failed = false;
const ran = new Map<string, number>();
for (const step of steps) {
  if (step.files.length === 0) continue;
  const report = join(out, `${step.name}.xml`);
  // A leading `./` makes Bun read each argument as a path, not as a name filter (Bun 1.4.2 docs/test/discovery.mdx).
  const args = ["test", ...step.flags, "--reporter=junit", `--reporter-outfile=${report}`, ...step.files.map((f) => `./${f}`)];
  console.log(`STEP ${step.name}: ${step.files.length} files, start ${new Date().toISOString()}`);
  const started = performance.now();
  const proc = Bun.spawnSync([process.execPath, ...args], { cwd: REPO, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  if (proc.exitCode !== 0) failed = true;
  let tests = 0;
  // Each file is one top-level `testsuite` with a `file` attribute. Nested suites repeat the file.
  for (const m of readFileSync(report, "utf8").matchAll(/<testsuite\b[^>]*\bfile="([^"]*)"[^>]*>/g)) {
    const file = slash(m[1]!);
    if (ran.has(file)) continue;
    const count = Number(m[0].match(/\btests="(\d+)"/)?.[1]);
    ran.set(file, count);
    tests += count;
  }
  console.log(`STEP ${step.name}: exit ${proc.exitCode}, ${step.files.length} files, ${tests} tests, ${seconds} s, end ${new Date().toISOString()}, report ${report}`);
}

// The count check: the reports name every selected file and no other file.
const missing = selected.filter((f) => !ran.has(f));
const extra = [...ran.keys()].filter((f) => !selected.includes(f));
for (const f of missing) console.error(`COUNT ${f} has no report`);
for (const f of extra) console.error(`COUNT ${f} is not selected`);
console.log(`RUN ${mode}: ${ran.size} of ${selected.length} files reported, ${[...ran.values()].reduce((a, b) => a + b, 0)} tests`);
process.exit(failed || missing.length > 0 || extra.length > 0 ? 1 : 0);
