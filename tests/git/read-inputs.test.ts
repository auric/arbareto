// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { REGISTERED_WORKSPACES } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import { fixtureGit, useFixtureRoot } from "./fixture-root";
import { buildF02, buildF06, buildF07, put } from "./fixtures";
import { GIT } from "./git-binary";
import { caseTest, openService, type Refusal, type Service } from "./service-harness";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/git-service/registration.ts", import.meta.dir);
printOrigin("../../src/git-service/read-scheduler.ts", import.meta.dir);

const TASK = "T072";
const TIMEOUT_MS = 120_000;
const ALTERNATING_TIMEOUT_MS = 600_000;

useFixtureRoot();

const gitPath = (): string => {
  if (GIT === null) throw new Error("Git executable absent");
  return GIT;
};

async function withService(name: string, body: (service: Service) => Promise<void>): Promise<void> {
  const service = await openService({ git: gitPath(), name });
  try {
    await body(service);
  } finally {
    await service.dispose();
  }
}

// Runs `request` and returns its code with the count of `run` requests that it caused.
async function codeAndSpawns(service: Service, request: () => Promise<{ code?: string; state: string }>): Promise<{ state: string; code?: string; runs: number }> {
  const before = service.runner.calls.length;
  const response = await request();
  return { state: response.state, code: response.code, runs: service.runner.calls.length - before };
}

// Approves trust for one workspace and returns its trust ID.
async function approve(service: Service, repositoryId: string): Promise<string> {
  const trust = await service.readTrust(repositoryId);
  expect(trust.state).toBe("succeeded");
  const approved = await service.approveTrust(repositoryId, trust.result!.fingerprint, trust.result!.generation);
  expect(approved.state).toBe("succeeded");
  return approved.result!.trustId;
}

describe("foreign identifiers (contract §2)", () => {
  caseTest(
    TASK,
    "a trust ID from another workspace gives UNKNOWN_TARGET and starts no Git process",
    ["shell-double"],
    () =>
      withService("t072-trust-workspace", async (service) => {
        const built = buildF07(gitPath(), "t072-trust-workspace");
        const a = await service.register(join(built.root, "wt-a"));
        const b = await service.register(join(built.root, "wt-b"));
        const trustA = await approve(service, a.repositoryId);
        expect(await codeAndSpawns(service, () => service.revokeTrust(b.repositoryId, trustA))).toEqual({ state: "rejected", code: "UNKNOWN_TARGET", runs: 0 });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a trust ID from another session gives UNKNOWN_TARGET and starts no Git process",
    ["shell-double"],
    async () => {
      const git = gitPath();
      const repo = join(buildF02(git, "t072-trust-session").root, "repo");
      let service = await openService({ git, name: "t072-trust-session" });
      try {
        const old = await approve(service, (await service.register(repo)).repositoryId);
        service = await service.restart();
        const { repositoryId } = await service.register(repo);
        expect(await codeAndSpawns(service, () => service.revokeTrust(repositoryId, old))).toEqual({ state: "rejected", code: "UNKNOWN_TARGET", runs: 0 });
      } finally {
        await service.dispose();
      }
    },
    TIMEOUT_MS,
  );

  // Contract §3 `readComparison`: "Current snapshot ID and issued entry ID". Data-model §4 and §5 name the fields `snapshotId` and `entryId`.
  test.todo("a snapshot ID or entry ID from another workspace gives UNKNOWN_TARGET and starts no Git process (needs T105/T115)", async () => {
    const git = gitPath();
    const service = await openService({ git, name: "t072-snapshot-workspace" });
    try {
      const built = buildF07(git, "t072-snapshot-workspace");
      put(join(built.root, "wt-b"), "b-change.txt", "b\n");
      const a = await service.register(join(built.root, "wt-a"));
      const b = await service.register(join(built.root, "wt-b"));
      const readA = (await service.readWorkspace(a.repositoryId)).result!;
      const readB = (await service.readWorkspace(b.repositoryId)).result!;
      const send = (snapshotId: string, entryId: string, generation: number) =>
        codeAndSpawns(service, () => service.request("readComparison", { snapshotId, entryId }, { repositoryId: b.repositoryId, repositoryGeneration: generation, selectionId: crypto.randomUUID() }));
      expect(await send(readA.snapshotId, readB.entries[0]!.entryId, readB.generation)).toEqual({ state: "rejected", code: "UNKNOWN_TARGET", runs: 0 });
      expect(await send(readB.snapshotId, readA.entries[0]!.entryId, readB.generation)).toEqual({ state: "rejected", code: "UNKNOWN_TARGET", runs: 0 });
    } finally {
      await service.dispose();
    }
  });

  test.todo("a snapshot ID or entry ID from another session gives UNKNOWN_TARGET and starts no Git process (needs T105/T115)", async () => {
    const git = gitPath();
    const repo = join(buildF02(git, "t072-snapshot-session").root, "repo");
    let service = await openService({ git, name: "t072-snapshot-session" });
    try {
      const old = (await service.readWorkspace((await service.register(repo)).repositoryId)).result!;
      service = await service.restart();
      const { repositoryId } = await service.register(repo);
      const current = (await service.readWorkspace(repositoryId)).result!;
      const send = (snapshotId: string, entryId: string) =>
        codeAndSpawns(service, () => service.request("readComparison", { snapshotId, entryId }, { repositoryId, repositoryGeneration: current.generation, selectionId: crypto.randomUUID() }));
      expect(await send(old.snapshotId, current.entries[0]!.entryId)).toEqual({ state: "rejected", code: "UNKNOWN_TARGET", runs: 0 });
      expect(await send(current.snapshotId, old.entries[0]!.entryId)).toEqual({ state: "rejected", code: "UNKNOWN_TARGET", runs: 0 });
    } finally {
      await service.dispose();
    }
  });
});

describe("generations (contract §2, §9)", () => {
  // Reads once, then stages a change and reads again, so the workspace generation increases.
  // Data-model §2: only an accepted state change advances the generation. The first observation after registration does not.
  async function advance(service: Service, repo: string, repositoryId: string, generation: number): Promise<number> {
    expect((await service.readWorkspace(repositoryId)).result!.generation).toBe(generation);
    put(repo, "keep.txt", `keep ${generation}\n`);
    fixtureGit(gitPath(), repo, ["add", "--", "keep.txt"]);
    const read = await service.readWorkspace(repositoryId);
    expect(read.result!.generation).toBeGreaterThan(generation);
    return read.result!.generation;
  }

  caseTest(
    TASK,
    "readHistory without repositoryGeneration gives INVALID_REQUEST and starts no Git process",
    ["shell-double"],
    () =>
      withService("t072-history-missing", async (service) => {
        const repo = join(buildF02(gitPath(), "t072-history-missing").root, "repo");
        const { repositoryId } = await service.register(repo);
        expect(await codeAndSpawns(service, () => service.request("readHistory", {}, { repositoryId }))).toEqual({ state: "rejected", code: "INVALID_REQUEST", runs: 0 });
      }),
    TIMEOUT_MS,
  );

  test.todo("readComparison without repositoryGeneration gives INVALID_REQUEST and starts no Git process (needs T105/T115)", async () => {
    const git = gitPath();
    const service = await openService({ git, name: "t072-comparison-missing" });
    try {
      const repo = join(buildF02(git, "t072-comparison-missing").root, "repo");
      const { repositoryId } = await service.register(repo);
      const read = (await service.readWorkspace(repositoryId)).result!;
      const response = await codeAndSpawns(service, () =>
        service.request("readComparison", { snapshotId: read.snapshotId, entryId: read.entries[0]!.entryId }, { repositoryId, selectionId: crypto.randomUUID() }),
      );
      expect(response).toEqual({ state: "rejected", code: "INVALID_REQUEST", runs: 0 });
    } finally {
      await service.dispose();
    }
  });

  caseTest(
    TASK,
    "a readHistory whose generation differs from the current workspace generation gives REPOSITORY_CHANGED and starts no Git process",
    ["shell-double"],
    () =>
      withService("t072-history-stale", async (service) => {
        const repo = join(buildF02(gitPath(), "t072-history-stale").root, "repo");
        const { repositoryId, generation } = await service.register(repo);
        const current = await advance(service, repo, repositoryId, generation);
        for (const stale of [generation, current + 1]) {
          expect({ stale, ...(await codeAndSpawns(service, () => service.readHistory(repositoryId, stale))) }).toEqual({ stale, state: "rejected", code: "REPOSITORY_CHANGED", runs: 0 });
        }
        expect((await service.readHistory(repositoryId, current)).state).toBe("succeeded");
      }),
    TIMEOUT_MS,
  );

  test.todo("a readComparison with an old repositoryGeneration gives REPOSITORY_CHANGED and starts no Git process (needs T105/T115)", async () => {
    const git = gitPath();
    const service = await openService({ git, name: "t072-comparison-stale" });
    try {
      const repo = join(buildF02(git, "t072-comparison-stale").root, "repo");
      const { repositoryId } = await service.register(repo);
      const old = (await service.readWorkspace(repositoryId)).result!;
      put(repo, "keep.txt", "keep changed\n");
      fixtureGit(git, repo, ["add", "--", "keep.txt"]);
      expect((await service.readWorkspace(repositoryId)).result!.generation).toBeGreaterThan(old.generation);
      const response = await codeAndSpawns(service, () =>
        service.request("readComparison", { snapshotId: old.snapshotId, entryId: old.entries[0]!.entryId }, { repositoryId, repositoryGeneration: old.generation, selectionId: crypto.randomUUID() }),
      );
      expect(response).toEqual({ state: "rejected", code: "REPOSITORY_CHANGED", runs: 0 });
    } finally {
      await service.dispose();
    }
  });

  caseTest(
    TASK,
    "a readWorkspace payload without check, or with a check other than full or changes, gives INVALID_REQUEST",
    ["shell-double"],
    () =>
      withService("t072-check", async (service) => {
        const repo = join(buildF02(gitPath(), "t072-check").root, "repo");
        const { repositoryId } = await service.register(repo);
        const payloads: object[] = [{ refresh: false }, { refresh: true }, ...["partial", "FULL", "", "Changes"].map((check) => ({ refresh: false, check })), { refresh: false, check: null }, { refresh: false, check: 1 }];
        for (const payload of payloads) {
          expect({ payload, ...(await codeAndSpawns(service, () => service.request("readWorkspace", payload, { repositoryId }))) }).toEqual({ payload, state: "rejected", code: "INVALID_REQUEST", runs: 0 });
        }
      }),
    TIMEOUT_MS,
  );
});

describe("registration reuse and release (contract §6)", () => {
  caseTest(
    TASK,
    "20 alternating opens of two common directories never give WORKSPACE_LIMIT, and each open releases the other repositoryId to UNKNOWN_TARGET",
    ["shell-double"],
    () =>
      withService("t072-alternating", async (service) => {
        const git = gitPath();
        const repos = [join(buildF02(git, "t072-alternating-a").root, "repo"), join(buildF06(git, "t072-alternating-b").root, "repo")];
        let previous: string | null = null;
        for (let i = 0; i < 20; i++) {
          const response = await service.chooseRepository(repos[i % 2]!);
          expect({ open: i, state: response.state, code: response.code }).toEqual({ open: i, state: "succeeded", code: undefined });
          const { repositoryId } = response.result as { repositoryId: string };
          if (previous !== null) {
            expect({ open: i, ...(await codeAndSpawns(service, () => service.readWorkspace(previous as string))) }).toEqual({ open: i, state: "rejected", code: "UNKNOWN_TARGET", runs: 0 });
          }
          expect((await service.readWorkspace(repositoryId)).state).toBe("succeeded");
          previous = repositoryId;
        }
      }),
    ALTERNATING_TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "reopening the current worktree returns its repositoryId",
    ["shell-double"],
    () =>
      withService("t072-reopen", async (service) => {
        const repo = join(buildF02(gitPath(), "t072-reopen").root, "repo");
        const first = await service.register(repo);
        const second = await service.register(repo);
        expect(second.repositoryId).toBe(first.repositoryId);
        expect(second.worktreeKey).toBe(first.worktreeKey);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "two linked worktrees of one common directory stay registered together",
    ["shell-double"],
    () =>
      withService("t072-linked", async (service) => {
        const built = buildF07(gitPath(), "t072-linked");
        const a = await service.register(join(built.root, "wt-a"));
        const b = await service.register(join(built.root, "wt-b"));
        expect(a.repositoryId).not.toBe(b.repositoryId);
        for (const id of [a.repositoryId, b.repositoryId]) expect((await service.readWorkspace(id)).state).toBe("succeeded");
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    `a ninth registration of distinct linked worktrees of one common directory gives WORKSPACE_LIMIT naming the ${REGISTERED_WORKSPACES}-workspace limit`,
    ["shell-double"],
    () =>
      withService("t072-limit", async (service) => {
        const git = gitPath();
        const built = buildF07(git, "t072-limit");
        const main = join(built.root, "main");
        const names = ["main", "wt-a", "wt-b"];
        // F07 holds three worktrees. The limit needs one more than REGISTERED_WORKSPACES.
        for (let n = names.length; n <= REGISTERED_WORKSPACES; n++) {
          fixtureGit(git, main, ["worktree", "add", "-q", "-b", `wt-${n}`, `../wt-${n}`]);
          names.push(`wt-${n}`);
        }
        expect(names.length).toBe(REGISTERED_WORKSPACES + 1);
        const ids: string[] = [];
        for (const name of names.slice(0, REGISTERED_WORKSPACES)) ids.push((await service.register(join(built.root, name))).repositoryId);
        expect(new Set(ids).size).toBe(REGISTERED_WORKSPACES);
        const ninth = await service.chooseRepository(join(built.root, names[REGISTERED_WORKSPACES]!));
        expect({ refused: ninth.state !== "succeeded", code: ninth.code, limit: (ninth.result as Refusal | undefined)?.limit }).toEqual({ refused: true, code: "WORKSPACE_LIMIT", limit: REGISTERED_WORKSPACES });
      }),
    TIMEOUT_MS,
  );
});
