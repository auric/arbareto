// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T329: contract §6. A 0 or all-ones `ino` on either side of a Bun `fs.stat` compare proves no identity.
// `fileIdSeam` marks the `ino` of chosen files as a sentinel. The compares themselves still read the real IDs.

import { describe, expect, test } from "bun:test";
import { lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createComparisonReader, diskName } from "../../src/git-service/comparison";
import { probeGit } from "../../src/git-service/git-installation";
import { refusalOf, workingOf, type Failure } from "../../src/git-service/hunk-publish";
import { fileIdSeam, NO_FILE_ID } from "../../src/git-service/index-lock";
import { createRegistrations, type Workspace } from "../../src/git-service/registration";
import { readWorkingVersion } from "../../src/git-service/snapshot";
import { createWorkspaceReader } from "../../src/git-service/status";
import { createTrust } from "../../src/git-service/trust";
import { watchWorkspace } from "../../src/git-service/watch";
import { printOrigin } from "../origin";
import { fixtureDir, serviceEnv, useFixtureRoot } from "./fixture-root";
import { buildF02, put } from "./fixtures";
import { git, gitPath, repoOf, TIMEOUT_MS, withService } from "./hunk-harness";
import { caseTest } from "./service-harness";

for (const module of ["snapshot", "comparison", "hunk-publish", "file-publish", "index-lock", "status", "watch"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);

useFixtureRoot();

// Contract §9: the working-file `file-id` text.
const WORKING_FILE_ID_TEXT = "This volume gives this file no unique file ID. Stage this change in a terminal.";
const enc = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));
const inoOf = (path: string) => lstatSync(path, { bigint: true }).ino;

// Marks the file IDs of `paths` as `sentinel` until the result runs.
function markSentinel(paths: readonly string[], sentinel: bigint = -1n): () => void {
  const inos = new Set(paths.map(inoOf));
  fileIdSeam.ino = (ino) => (inos.has(ino) ? sentinel : ino);
  return () => void delete fileIdSeam.ino;
}

async function withSentinel<T>(paths: readonly string[], body: () => Promise<T>, sentinel: bigint = -1n): Promise<T> {
  const unmark = markSentinel(paths, sentinel);
  try {
    return await body();
  } finally {
    unmark();
  }
}

test("NO_FILE_ID holds 0 and all ones, also as the signed -1 of Bun", () => {
  expect(NO_FILE_ID).toEqual([0n, -1n, 0xffff_ffff_ffff_ffffn]);
});

describe("snapshot openRegular (T329)", () => {
  for (const [i, sentinel] of NO_FILE_ID.entries()) {
    test(`file ID ${sentinel} gives UNSUPPORTED_HUNK_PROFILE and no retry`, async () => {
      const dir = fixtureDir(`t329-open-${i}`);
      writeFileSync(join(dir, "a.txt"), "a\n");
      let lstats = 0;
      const read = await withSentinel([join(dir, "a.txt")], () => readWorkingVersion(dir, enc("a.txt"), "COMPARED_RAW_VERSION_BYTES", null, { afterLstat: async () => void lstats++ }), sentinel);
      expect(read).toEqual({ ok: false, completeness: { state: "failed", code: "UNSUPPORTED_HUNK_PROFILE" } });
      expect(lstats).toBe(1);
    });
  }

  test("a real file ID still reads the file", async () => {
    const dir = fixtureDir("t329-open-real");
    writeFileSync(join(dir, "a.txt"), "a\n");
    const read = await readWorkingVersion(dir, enc("a.txt"), "COMPARED_RAW_VERSION_BYTES", null);
    expect(read.ok).toBe(true);
  });
});

describe("hunk and file publication working read (T329)", () => {
  for (const bound of ["COMPARED_RAW_VERSION_BYTES", "WHOLE_FILE_STAGE_INPUT_BYTES"] as const) {
    test(`workingOf with ${bound} gives reason file-id, and refusalOf gives the §9 working-file text`, async () => {
      const dir = fixtureDir(`t329-working-${bound}`);
      writeFileSync(join(dir, "a.txt"), "a\n");
      const read = await withSentinel([join(dir, "a.txt")], () => workingOf({ worktreeRoot: dir } as Workspace, enc("a.txt"), bound));
      expect(read).toEqual({ code: "UNSUPPORTED_HUNK_PROFILE", reason: "file-id" });
      expect(refusalOf(read as Failure)).toEqual({ code: "UNSUPPORTED_HUNK_PROFILE", reason: "file-id", remedy: { text: WORKING_FILE_ID_TEXT } });
    });
  }

  test("the code alone gets no file-id reason", () => {
    expect(refusalOf({ code: "UNSUPPORTED_HUNK_PROFILE" })).toEqual({ code: "UNSUPPORTED_HUNK_PROFILE" });
  });
});

describe("comparison diskName (T329)", () => {
  test("a candidate compare with a sentinel ID gives null", async () => {
    const dir = fixtureDir("t329-disk-name");
    writeFileSync(join(dir, "A.txt"), "a\n");
    const target = lstatSync(join(dir, "A.txt"), { bigint: true });
    expect(await diskName(dir, "a.txt", target)).toBe("A.txt");
    expect(await withSentinel([join(dir, "A.txt")], () => diskName(dir, "a.txt", target))).toBeNull();
  });
});

describe("readComparison and readWorkspace (T329)", () => {
  caseTest("T329", "a sentinel working-file ID: the index-path check gives path, readComparison fails with UNSUPPORTED_HUNK_PROFILE, and readWorkspace drops the bound version", ["shell-double"], () =>
    withService({ name: "t329-reads" }, async (service) => {
      const repo = repoOf(buildF02(gitPath(), "t329-reads"));
      // `extra.txt` has the component lengths of `multi.txt`, so the index-path check compares the two.
      put(repo, "extra.txt", "extra\n");
      git(repo, ["add", "--", "extra.txt"]);
      const probed = await probeGit(service.runner, { bootstrapId: service.runner.addContext("gitProbe", gitPath()), executablePath: gitPath() });
      if (!("installation" in probed)) throw new Error(`probe failed: ${JSON.stringify(probed)}`);
      const { installation } = probed;
      const registrations = createRegistrations({ runner: service.runner, unfinishedMutation: () => false });
      const registered = await registrations.register({ operationId: crypto.randomUUID(), bootstrapId: service.runner.addContext("repositoryDiscovery", repo), installation, signal: new AbortController().signal });
      if (!registered.ok || !("repositoryId" in registered.result)) throw new Error(`registration failed: ${JSON.stringify(registered)}`);
      const workspace = registrations.get(registered.result.repositoryId)!;
      const trust = createTrust({ runner: service.runner, environment: serviceEnv() });
      const reader = createWorkspaceReader({ runner: service.runner, trust });
      const comparisons = createComparisonReader({ runner: service.runner, trust, onDrop: () => {} });
      const signal = new AbortController().signal;
      const readWorkspace = () => reader.readWorkspace({ operationId: crypto.randomUUID(), signal, installation, workspace, refresh: true });
      const read = await readWorkspace();
      if (read.result !== "succeeded") throw new Error(`read failed: ${JSON.stringify(read)}`);
      const target = (category: string) => {
        const entry = read.value.entries.find((e) => e.path === "multi.txt" && e.category === category)!;
        const found = reader.entry(workspace.repositoryId, read.value.generation, read.value.snapshotId, entry.entryId);
        if (!found.ok) throw new Error(found.code);
        return { operationId: crypto.randomUUID(), signal, installation, workspace, snapshot: found.snapshot, entry: found.entry };
      };
      const supportOf = (o: Awaited<ReturnType<typeof comparisons.readComparison>>) => (o as { value: { support: unknown } }).value.support;

      expect(supportOf(await comparisons.readComparison(target("staged")))).toBe("supported");
      const unstaged = await comparisons.readComparison(target("unstaged"));
      expect(unstaged.result).toBe("succeeded");
      const version = comparisons.get((unstaged as { value: { comparisonId: string } }).value.comparisonId)!.workingVersion!;
      expect(reader.bind(workspace.repositoryId, read.value.generation, version)).toBe(true);

      const multi = join(repo, "multi.txt");
      // `head-to-index` reads no working version, so only the index-path check sees the sentinel.
      expect(supportOf(await withSentinel([multi], () => comparisons.readComparison(target("staged"))))).toBe("path");
      expect(await withSentinel([multi], () => comparisons.readComparison(target("unstaged")))).toEqual({ result: "failed", code: "UNSUPPORTED_HUNK_PROFILE" });

      // The ID becomes a sentinel while `diff-files` starts, so only the whole-file read of the `stage` binding sees it.
      const marked: { unmark: (() => void) | null } = { unmark: null };
      const release = service.runner.holdStart((call) => {
        if (marked.unmark === null && call.arguments.includes("diff-files")) marked.unmark = markSentinel([multi]);
        return false;
      });
      try {
        expect(await comparisons.readComparison(target("unstaged"))).toEqual({ result: "failed", code: "UNSUPPORTED_HUNK_PROFILE" });
      } finally {
        release();
        marked.unmark?.();
      }
      expect(marked.unmark).not.toBeNull();

      const again = await withSentinel([multi], readWorkspace);
      if (again.result !== "succeeded") throw new Error(`read failed: ${JSON.stringify(again)}`);
      expect(again.value.generation).toBe(read.value.generation + 1);
      const kept = reader.snapshot(workspace.repositoryId, again.value.generation, again.value.snapshotId);
      if (!kept.ok) throw new Error(kept.code);
      expect(kept.snapshot.workingVersions).toEqual([]);
    }), TIMEOUT_MS);
});

describe("watch directory identity (T329)", () => {
  // A bounded wait for the first lost-watch hint.
  const lostWithin = (hints: boolean[], ms: number) =>
    new Promise<boolean>((resolve) => {
      const end = Date.now() + ms;
      const poll = () => (hints.includes(true) ? resolve(true) : Date.now() > end ? resolve(false) : setTimeout(poll, 20));
      poll();
    });

  test("a sentinel ID at start loses the watch", () => {
    const dir = fixtureDir("t329-watch-start");
    const hints: boolean[] = [];
    const unmark = markSentinel([dir]);
    let stop = () => {};
    try {
      stop = watchWorkspace([dir], (lost) => hints.push(lost));
    } finally {
      unmark();
      stop();
    }
    expect(hints).toEqual([true]);
  });

  test("a sentinel ID at the identity check loses the watch", async () => {
    const dir = fixtureDir("t329-watch-check");
    const hints: boolean[] = [];
    const stop = watchWorkspace([dir], (lost) => hints.push(lost));
    const unmark = markSentinel([dir]);
    try {
      writeFileSync(join(dir, "a.txt"), "a\n");
      expect(await lostWithin(hints, 5_000)).toBe(true);
    } finally {
      unmark();
      stop();
    }
  });
});
