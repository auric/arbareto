// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Runs the test groups of `tests/groups.json` (T324). Usage: `bun tests/run.ts full|fast`.
// Step 1 runs the parallel group with `bun test --parallel`. Step 2 runs the serial group in one `bun test` process.
// A serial file measures wall or CPU time or asserts a wall-clock budget, so no other test file runs beside it.

import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkGroups, inFast, REPO, slash } from "./groups";

const mode = process.argv[2];
if (mode !== "full" && mode !== "fast") throw new Error("usage: bun tests/run.ts full|fast");

const { groups, discovered, serial, problems } = checkGroups();
if (problems.length > 0) {
  for (const p of problems) console.error(`GROUPS ${p}`);
  process.exit(1);
}

const selected = mode === "full" ? discovered : discovered.filter((f) => inFast(groups, f));
// Each worker runs Git children, and one child keeps one physical core busy. The T324 host has 8 physical cores (`Win32_Processor.NumberOfCores`).
// With 16 workers, WSL reads passed the 30 s Git process deadline (research.md "Test run time"). `ARBARETO_TEST_WORKERS` sets another count.
const workers = Number(process.env.ARBARETO_TEST_WORKERS ?? "8");
if (!Number.isInteger(workers) || workers < 1) throw new Error(`ARBARETO_TEST_WORKERS must be a positive integer: ${process.env.ARBARETO_TEST_WORKERS}`);
const steps = [
  { name: "parallel", files: selected.filter((f) => groups.parallel.includes(f)), flags: [`--parallel=${workers}`] },
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
  // A leading `./` makes Bun read each argument as a path, not as a name filter (Bun 1.4.3 docs/test/discovery.mdx).
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
