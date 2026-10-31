// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 008 T017: `publishIndex`, the `steps()` part of `publish()` (plan.md D7, research.md R3).
// It takes the owned lock, runs `prepare`, publishes the checked candidate, and returns the `Ending` with the owned files. It sends no registry event.
// The split must not change staging. These suites cover the staging paths and stay green: tests/git/hunk-stage.test.ts, hunk-unstage.test.ts,
// hunk-refusal.test.ts, hunk-races.test.ts, line-stage.test.ts, file-publish.test.ts, file-stage.test.ts, file-refusal.test.ts, multi-stage.test.ts, and mark-resolved.test.ts.

import { describe, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import type { ChangeEntry } from "../../src/contracts/envelope";
import type { GitInstallation } from "../../src/git-service/git-installation";
import { parsePatch } from "../../src/git-service/diff-parser";
import { prepareCandidate } from "../../src/git-service/hunk-candidate";
import { besideIndex, indexSession, publishIndex, type HunkCheckpoint, type PublicationClaim, type PublicationSession, type PublishContext, type RetainedPublication } from "../../src/git-service/hunk-publish";
import { LOCKED_REMEDY } from "../../src/git-service/index-lock";
import { createRegistrations, type Workspace } from "../../src/git-service/registration";
import type { Trust } from "../../src/git-service/trust";
import { printOrigin } from "../origin";
import { createBunRunner } from "./bun-runner";
import { fixtureDir, serviceEnv, useFixtureRoot } from "./fixture-root";
import { buildF02 } from "./fixtures";
import { sha256 } from "./git-oracle";
import { candidateFiles, gitPath, gitPathOf, gitText, oraclePatch, repoOf, repoState, TIMEOUT_MS } from "./hunk-harness";
import { caseTest } from "./service-harness";

printOrigin("../../src/git-service/hunk-publish.ts", import.meta.dir);
useFixtureRoot();

const TASK = "T017";
const PATH = "multi.txt";

// A workspace that the shell double registers, as tests/git/hunk-candidate.test.ts does.
async function registered(name: string, repo: string) {
  const g = gitPath();
  const runner = createBunRunner({ git: g, directory: fixtureDir(`${name}-runner`), environment: serviceEnv() });
  const gitInstallationId = crypto.randomUUID();
  await runner.register({ operationId: crypto.randomUUID(), bootstrapId: runner.addContext("gitProbe", g), gitInstallationId, version: "2.55.0", digest: "c".repeat(64), confirm: false });
  const installation: GitInstallation = {
    gitInstallationId,
    selectedPath: g,
    executablePath: g,
    version: "2.55.0",
    admission: "admitted",
    executableIdentity: { file: { volumeSerial: "0".repeat(16), fileId: "0".repeat(31) + "1" }, versionOutput: "2.55.0", digest: "c".repeat(64) },
  };
  const registrations = createRegistrations({ runner, unfinishedMutation: () => false });
  const done = await registrations.register({ operationId: crypto.randomUUID(), bootstrapId: runner.addContext("repositoryDiscovery", repo), installation, signal: new AbortController().signal });
  if (!done.ok || !("repositoryId" in done.result)) throw new Error(`registration failed: ${JSON.stringify(done)}`);
  return { runner, installation, workspace: registrations.get(done.result.repositoryId)! as Workspace };
}

// One publication session of an unstaged hunk of `multi.txt`. `consume` decides the claim.
async function sessionOf(name: string, consume = true, signal = new AbortController().signal) {
  const repo = repoOf(buildF02(gitPath(), name));
  const { runner, installation, workspace } = await registered(name, repo);
  const operationId = crypto.randomUUID();
  // `publishIndex` reads only `currentTrustId` of the trust, and only for a lock refusal.
  const trust = { currentTrustId: () => undefined } as unknown as Trust;
  const ctx: PublishContext = { runner, trust, reader: { operationState: async () => "normal" }, operationId, signal, workspace, installation: { ...installation, selectedPath: installation.selectedPath } as PublishContext["installation"] };
  const claims: string[] = [];
  const claim: PublicationClaim = { consume: (id) => (claims.push(id), consume), refusal: () => "UNKNOWN_TARGET" };
  const before = repoState(repo);
  const kept: RetainedPublication = { repositoryId: workspace.repositoryId, before: before.rawIndex, candidate: null };
  const session = indexSession(ctx, new TextEncoder().encode(PATH), claim, kept);
  return { repo, runner, workspace, operationId, session, claims, kept, before };
}

// A `prepare` that builds the candidate of the second unstaged hunk, as `prepareHunk` does between the lock and `publish()`.
function hunkPrepare(repo: string, w: Workspace, rawIndexDigest: string | null, seen: { lockHeld?: boolean; calls: number }) {
  return async ({ ctx, rec, run }: PublicationSession) => {
    seen.calls++;
    seen.lockHeld = existsSync(`${w.indexPath}.lock`);
    const patch = new Uint8Array(oraclePatch(repo, PATH, "index-to-worktree"));
    const parsed = parsePatch(patch, new TextEncoder().encode(PATH));
    if (!parsed.ok) throw new Error("patch");
    // The HEAD and index sides of the status record, as tests/git/hunk-candidate.test.ts `sides` reads them.
    const head = /^(\d{6}) blob ([0-9a-f]+)\t/.exec(gitText(repo, ["ls-tree", "HEAD", "--", PATH]))!;
    const index = /^(\d{6}) ([0-9a-f]+) 0\t/.exec(gitText(repo, ["ls-files", "-s", "--", PATH]))!;
    const entry = { entryId: crypto.randomUUID(), category: "unstaged", path: PATH, pathBytes: Buffer.from(PATH).toString("base64"), modes: [head[1], index[1], "100644"], oids: [head[2], index[2]] } as ChangeEntry;
    const prepared = await prepareCandidate({ runner: rec, operationId: ctx.operationId, signal: ctx.signal, workspace: w, rawIndexDigest, comparison: { entry, scope: "index-to-worktree", patch }, hunk: parsed.patch.hunks[1]! });
    if (!prepared.ok) throw new Error(`candidate: ${prepared.failure.reason}`);
    run.candidate = prepared.candidate;
    run.candidatePath = besideIndex(w, prepared.candidate.path);
    return null;
  };
}

const indexBytes = (repo: string) => new Uint8Array(readFileSync(gitPathOf(repo, "index")));
// A shell frame of the recovery marker. `publishIndex` holds no marker, so it sends none.
const markerFrames = (frames: readonly Record<string, unknown>[]) => frames.filter((f) => f.type === "started" || f.type === "resolved");

describe("publishIndex (T017, plan.md D7)", () => {
  caseTest(
    TASK,
    "takes the owned lock, runs prepare under it, publishes the checked candidate, and returns the ending and the owned files",
    [],
    async () => {
      const s = await sessionOf("t017-publish");
      try {
        const seen = { calls: 0 } as { lockHeld?: boolean; calls: number };
        const checkpoints: HunkCheckpoint[] = [];
        const ending = await publishIndex({ runner: s.runner, hunkCheckpoint: (c) => void checkpoints.push(c) }, s.session, { prepare: hunkPrepare(s.repo, s.workspace, s.before.rawIndex, seen) });
        expect(ending).toEqual({ published: true });
        expect({ calls: seen.calls, lockHeld: seen.lockHeld, claims: s.claims }).toEqual({ calls: 1, lockHeld: true, claims: [s.operationId] });
        const candidate = s.session.run.candidate!;
        // The canonical index now holds the checked candidate bytes, and the owned lock went with the rename.
        expect(sha256(indexBytes(s.repo))).toBe(candidate.digest);
        expect(existsSync(`${s.workspace.indexPath}.lock`)).toBe(false);
        expect({ published: s.session.run.published, publishStarted: s.session.run.publishStarted, publishing: s.session.run.publishing, lock: s.session.run.lock, kept: s.kept.candidate }).toEqual({
          published: true,
          publishStarted: true,
          publishing: false,
          lock: null,
          kept: candidate.digest,
        });
        expect(checkpoints).toEqual([{ step: 13, operationId: s.operationId }]);
        // The owned candidate file stays until the caller releases it after its process-end fact.
        expect(s.session.run.candidatePath).toBe(besideIndex(s.workspace, candidate.path));
        expect(candidateFiles(s.repo)).toEqual([basename(candidate.path)]);
        expect(await s.session.releaseOwned(true)).toBe(false);
        expect({ candidates: candidateFiles(s.repo), foreign: s.session.foreign }).toEqual({ candidates: [], foreign: [] });
        expect(markerFrames(s.runner.frames)).toEqual([]);
      } finally {
        // A failed case still closes the owned lock handle.
        await s.session.releaseOwned(true);
        await s.runner.dispose();
      }
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a claim that does not consume gives its code before the lock, and prepare does not run",
    [],
    async () => {
      const s = await sessionOf("t017-claim", false);
      try {
        const seen = { calls: 0 };
        const ending = await publishIndex({ runner: s.runner }, s.session, { prepare: hunkPrepare(s.repo, s.workspace, s.before.rawIndex, seen) });
        expect(ending).toEqual({ code: "UNKNOWN_TARGET" });
        expect({ calls: seen.calls, lock: s.session.run.lock, lockFile: existsSync(`${s.workspace.indexPath}.lock`) }).toEqual({ calls: 0, lock: null, lockFile: false });
        expect(repoState(s.repo)).toEqual(s.before);
      } finally {
        await s.runner.dispose();
      }
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "an existing index lock gives LOCKED with the lock path and the 001 remedy; prepare does not run and the foreign lock stays",
    [],
    async () => {
      const s = await sessionOf("t017-locked");
      try {
        const lock = `${s.workspace.indexPath}.lock`;
        writeFileSync(lock, "foreign");
        const seen = { calls: 0 };
        const ending = await publishIndex({ runner: s.runner }, s.session, { prepare: hunkPrepare(s.repo, s.workspace, s.before.rawIndex, seen) });
        expect(ending).toEqual({ code: "LOCKED", path: lock, remedy: { text: LOCKED_REMEDY } });
        expect({ calls: seen.calls, lock: s.session.run.lock, foreign: readFileSync(lock, "utf8") }).toEqual({ calls: 0, lock: null, foreign: "foreign" });
        expect(await s.session.releaseOwned(true)).toBe(false);
        expect(existsSync(lock)).toBe(true);
      } finally {
        await s.runner.dispose();
      }
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a prepare refusal ends the publication with that refusal; the owned lock stays held until releaseOwned, and the index stays",
    [],
    async () => {
      const s = await sessionOf("t017-refused");
      try {
        let held = false;
        const ending = await publishIndex({ runner: s.runner }, s.session, {
          prepare: async () => {
            held = existsSync(`${s.workspace.indexPath}.lock`);
            return { code: "STALE_SELECTION" };
          },
        });
        expect(ending).toEqual({ code: "STALE_SELECTION" });
        expect({ held, owned: s.session.run.lock?.path, publishStarted: s.session.run.publishStarted }).toEqual({ held: true, owned: `${s.workspace.indexPath}.lock`, publishStarted: false });
        expect(await s.session.releaseOwned(true)).toBe(false);
        expect(existsSync(`${s.workspace.indexPath}.lock`)).toBe(false);
        expect(repoState(s.repo)).toEqual(s.before);
      } finally {
        await s.runner.dispose();
      }
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a Cancel before the lock consumes the claim and ends canceled without a lock",
    [],
    async () => {
      const abort = new AbortController();
      abort.abort();
      const s = await sessionOf("t017-cancel", true, abort.signal);
      try {
        const seen = { calls: 0 };
        const ending = await publishIndex({ runner: s.runner }, s.session, { prepare: hunkPrepare(s.repo, s.workspace, s.before.rawIndex, seen) });
        expect(ending).toEqual({ stop: "canceled" });
        expect({ calls: seen.calls, claims: s.claims, lockFile: existsSync(`${s.workspace.indexPath}.lock`) }).toEqual({ calls: 0, claims: [s.operationId], lockFile: false });
        expect(repoState(s.repo)).toEqual(s.before);
      } finally {
        await s.runner.dispose();
      }
    },
    TIMEOUT_MS,
  );
});
