// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T001: the Git facts G3 to G10 of research.md R14 with the Git under test, in real disposable repositories. G6 is a source fact, so T005 records it.
// Each fact prints `OBSERVATION T001` lines. A `match=false` line is a finding for research.md R15, not a failure (tasks.md "Harness and tick rules").

import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { observationLine } from "./fact-runner";
import { FIXTURE_ROOT, fixtureEnv, ownedPath, useFixtureRoot } from "./fixture-root";
import { describeGit, fixtureGitPath } from "./git-binary";
import { fileSha256 } from "./git-oracle";
import { nativeHost } from "./remote-fixtures";
import { factLines, REVERT_FACTS, revertGitVersion, type FileState, type RevertHost } from "./revert-facts";

useFixtureRoot();

const TASK = "T001";
// plan.md Technical Context names Git for Windows 2.56.0.windows.2 on the reference PC. Other hosts record the version only.
const EXPECTED_VERSION = process.platform === "win32" ? "2.56.0.windows.2" : "record";
const FACT_MS = 300_000;

const owned = (path: string) => ownedPath(FIXTURE_ROOT, path);

function tree(dir: string): Record<string, string> {
  const digests: Record<string, string> = {};
  const walk = (at: string, prefix: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path, `${prefix}${name}/`);
      else if (stat.isFile()) digests[`${prefix}${name}`] = fileSha256(path);
    }
  };
  walk(owned(dir), "");
  return digests;
}

function stat(path: string): FileState | null {
  const p = owned(path);
  if (!existsSync(p)) return null;
  const s = statSync(p, { bigint: true });
  return { size: Number(s.size), sha256: fileSha256(p), mtime: s.mtimeNs.toString(), mode: (Number(s.mode) & 0o7777).toString(8) };
}

function remove(path: string): void {
  const p = owned(path);
  if (!existsSync(p)) return;
  chmodSync(p, 0o666);
  rmSync(p, { force: true });
}

function swap(target: string, bytes: Uint8Array): void {
  const p = owned(target);
  const temp = join(dirname(p), ".arbareto-probe.tmp");
  writeFileSync(temp, bytes);
  renameSync(temp, p);
}

describeGit("Git facts G3 to G10 for revert (T001, research.md R14)", (git) => {
  let host: RevertHost | undefined;
  const x = (): RevertHost => {
    if (host !== undefined) return host;
    const h = nativeHost(git, "revert-facts");
    return (host = { git: h, tree, stat, remove, names: (dir) => readdirSync(owned(dir)), swap });
  };

  test("Git version", () => {
    const v = revertGitVersion(x());
    console.log(observationLine(TASK, { fact: "version", expected: EXPECTED_VERSION, observed: v, match: EXPECTED_VERSION === "record" || v === EXPECTED_VERSION }, `git=${v}`));
  });

  // `git lfs version` in the temporary folder. It reads no repository.
  const lfs = Bun.spawnSync([fixtureGitPath(git), "lfs", "version"], { cwd: tmpdir(), env: fixtureEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  for (const fact of REVERT_FACTS) {
    const name = `${fact.id}: ${fact.title}`;
    if (fact.needs === "git-lfs" && !lfs) {
      console.log(`SKIP ${TASK} ${fact.id}: missing capability git-lfs (unverified)`);
      test.skip(`${name} (SKIP: git-lfs)`, () => {});
      continue;
    }
    test(name, () => {
      const h = x();
      const v = revertGitVersion(h);
      const observations = fact.run(h);
      expect(observations.length).toBeGreaterThan(0);
      for (const line of factLines(TASK, fact, observations, `git=${v}`)) console.log(line);
    }, FACT_MS);
  }
});
