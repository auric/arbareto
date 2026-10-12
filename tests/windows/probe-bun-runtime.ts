// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T366 probe, not a test. Run after `bun run build:service`: `bun tests/windows/probe-bun-runtime.ts [service.exe]`. It runs T366 checks 1, 4, 5, and 6 on Windows.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processRecords } from "./installed-app";

const REPO = join(import.meta.dir, "..", "..");
const SERVICE = process.argv[2] ?? join(REPO, "src-tauri", "binaries", "arbareto-git-x86_64-pc-windows-msvc.exe");
const WAIT_MS = 30_000;
const POLL_MS = 500;

console.log(`BUN ${Bun.version} ${Bun.revision} ${process.execPath}`);
const root = mkdtempSync(join(tmpdir(), "arbareto-probe-bun-"));
console.log(`ROOT ${root}`);

let failed = false;
const verdict = (check: string, ok: boolean, detail: string) => {
  if (!ok) failed = true;
  console.log(`VERDICT ${check} ${ok ? "PASS" : "FAIL"}: ${detail}`);
};
const bounded = <T>(p: Promise<T>) => Promise.race([p, Bun.sleep(WAIT_MS).then(() => null)]);

// Check 1: both variables make the compiled service write a file.
{
  const exists = existsSync(SERVICE);
  console.log(`SERVICE ${SERVICE}${exists ? ` ${statSync(SERVICE).mtime.toISOString()}` : " absent"}`);
  const order = join(root, "order.out");
  const digest = join(root, "digest.out");
  const proc = Bun.spawn([SERVICE], { cwd: root, env: { ...process.env, BUN_BYTECODE_ORDER_OUT: order, BUN_BYTECODE_DIGEST_OUT: digest }, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  proc.stdin.end();
  const code = await bounded(proc.exited);
  if (code === null) proc.kill();
  const sizes = [order, digest].map((f) => (existsSync(f) ? `${statSync(f).size} bytes` : "absent"));
  verdict("T366-1", code !== null && existsSync(order) && existsSync(digest), `exit ${code}; BUN_BYTECODE_ORDER_OUT file ${sizes[0]}, BUN_BYTECODE_DIGEST_OUT file ${sizes[1]}`);
}

// Check 4.
{
  const proc = Bun.spawn([process.execPath, "-e", ""], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  const type = typeof proc.resourceUsage()?.cpuTime.total;
  verdict("T366-4", type === "bigint", `typeof resourceUsage().cpuTime.total is ${type}`);
}

// Check 5: `a.test.ts` as a name filter also selects `xa.test.ts`. The junit report lists each file once as a top-level `testsuite`.
{
  const dir = join(root, "discovery");
  mkdirSync(dir);
  for (const f of ["a.test.ts", "xa.test.ts"]) writeFileSync(join(dir, f), `import { test } from "bun:test";\ntest("${f}", () => {});\n`);
  const files = (arg: string) => {
    const report = join(root, `${arg.startsWith("./") ? "path" : "filter"}.xml`);
    const run = Bun.spawnSync([process.execPath, "test", "--reporter=junit", `--reporter-outfile=${report}`, arg], { cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: WAIT_MS });
    const found = [...readFileSync(report, "utf8").matchAll(/<testsuite\b[^>]*\bfile="([^"]*)"[^>]*>/g)].map((m) => m[1]!).sort();
    console.log(`  bun test ${arg}: exit ${run.exitCode}, files ${found.join(", ")}`);
    return found;
  };
  const path = files("./a.test.ts");
  const filter = files("a.test.ts");
  verdict("T366-5", path.length === 1 && path[0]!.endsWith("a.test.ts") && !path[0]!.endsWith("xa.test.ts") && filter.length === 2, "`./a.test.ts` runs one file; the control `a.test.ts` runs both");
}

// Check 6: a killed Bun parent ends its child. Process records give identity as PID plus creation time.
{
  const pidFile = join(root, "child.pid");
  const script = `const c = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`;
  const parent = Bun.spawn([process.execPath, "-e", script], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const until = performance.now() + WAIT_MS;
  while (!existsSync(pidFile) && performance.now() < until) await Bun.sleep(POLL_MS);
  const childPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null;
  const child = childPid === null ? undefined : processRecords().find((r) => r.pid === childPid && r.parent === parent.pid);
  if (child === undefined) {
    verdict("T366-6", false, `no child record of parent ${parent.pid}`);
    parent.kill();
  } else {
    parent.kill();
    const parentExit = await bounded(parent.exited);
    let alive = true;
    const end = performance.now() + WAIT_MS;
    while (alive && performance.now() < end) {
      alive = processRecords().some((r) => r.pid === child.pid && r.created === child.created);
      if (alive) await Bun.sleep(POLL_MS);
    }
    if (alive) process.kill(child.pid);
    verdict("T366-6", parentExit !== null && !alive, `parent ${parent.pid} killed (exit ${parentExit}); child ${child.pid} ${alive ? "still ran" : "ended"}`);
  }
}

rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
