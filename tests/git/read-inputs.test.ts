// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REGISTERED_WORKSPACES } from "../../src/contracts/limits";
import { probeGit } from "../../src/git-service/git-installation";
import * as registrationModule from "../../src/git-service/registration";
import { createWorkspaceReader } from "../../src/git-service/status";
import { createTrust } from "../../src/git-service/trust";
import * as watchModule from "../../src/git-service/watch";
import { printOrigin } from "../origin";
import { FIXTURE_ROOT, fixtureGit, ownedGit, serviceEnv, useFixtureRoot } from "./fixture-root";
import { buildF02, buildF06, buildF07, put } from "./fixtures";
import { GIT } from "./git-binary";
import { caseTest, openService, type Refusal, type Service } from "./service-harness";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/git-service/registration.ts", import.meta.dir);
printOrigin("../../src/git-service/read-scheduler.ts", import.meta.dir);
printOrigin("../../src/git-service/session.ts", import.meta.dir);
printOrigin("../../src/git-service/status.ts", import.meta.dir);
printOrigin("../../src/git-service/watch.ts", import.meta.dir);

const TASK = "T072";
const RELEASE_TASK = "T321";
const RECENT_TASK = "T343";
const TIMEOUT_MS = 120_000;
const ALTERNATING_TIMEOUT_MS = 600_000;
// Task T075 and spec SC-007: a hint within 2 seconds.
const HINT_BUDGET_MS = 2_000;
const WAIT_MS = 30_000;

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
  caseTest(TASK, "a snapshot ID or entry ID from another workspace gives UNKNOWN_TARGET and starts no Git process", ["shell-double"], async () => {
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
  }, TIMEOUT_MS);

  caseTest(TASK, "a snapshot ID or entry ID from another session gives UNKNOWN_TARGET and starts no Git process", ["shell-double"], async () => {
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
  }, TIMEOUT_MS);
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

  caseTest(TASK, "readComparison without repositoryGeneration gives INVALID_REQUEST and starts no Git process", ["shell-double"], async () => {
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
  }, TIMEOUT_MS);

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

  caseTest(
    "T322",
    "a readWorkspace with an old last-observed generation returns a fresh result of a newer generation, never REPOSITORY_CHANGED",
    ["shell-double"],
    () =>
      withService("t322-workspace-old", async (service) => {
        const repo = join(buildF02(gitPath(), "t322-workspace-old").root, "repo");
        const { repositoryId, generation } = await service.register(repo);
        const current = await advance(service, repo, repositoryId, generation);
        // A new staged change after `current`, so only a fresh read can show it.
        put(repo, "keep.txt", "keep fresh\n");
        fixtureGit(gitPath(), repo, ["add", "--", "keep.txt"]);
        const response = await service.readWorkspace(repositoryId, { refresh: false, check: "full" }, generation);
        expect({ state: response.state, code: response.code }).toEqual({ state: "succeeded", code: undefined });
        expect(response.result!.generation).toBeGreaterThan(current);
      }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a readComparison with an old repositoryGeneration gives REPOSITORY_CHANGED and starts no Git process", ["shell-double"], async () => {
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
  }, TIMEOUT_MS);

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

// The seam: the registrations of the service report each ID in `busy` as a workspace with an unfinished mutation, and record their `release` frames.
async function withBusySeam(name: string, body: (service: Service, seam: { busy: Set<string>; releases: unknown[] }) => Promise<void>): Promise<void> {
  const seam = { busy: new Set<string>(), releases: [] as unknown[] };
  const real = registrationModule.createRegistrations;
  const spy = spyOn(registrationModule, "createRegistrations").mockImplementation((options) =>
    real({
      ...options,
      unfinishedMutation: (repositoryId) => seam.busy.has(repositoryId),
      runner: {
        ...options.runner,
        release: (target) => {
          seam.releases.push(target);
          options.runner.release(target);
        },
      },
    }),
  );
  try {
    await withService(name, (service) => body(service, seam));
  } finally {
    spy.mockRestore();
  }
}

// Real Git headers of the repository, so only the injected records differ from a real listing.
const statusHeaders = (git: string, repo: string): Buffer => {
  const out = ownedGit(git, FIXTURE_ROOT, repo, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=no"]);
  return Buffer.concat(out.toString("latin1").split("\0").filter((r) => r.startsWith("# ")).map((r) => Buffer.from(`${r}\0`, "latin1")));
};
const isStatus = (args: readonly string[]) => args.includes("status") && args.includes("--porcelain=v2");

describe("unfinished mutations and release effects (contract §6 \"Registration reuse and release\")", () => {
  caseTest(
    RELEASE_TASK,
    "with an unfinished mutation in a registered workspace, chooseRepository of another common directory gives BUSY, sends no release, and both registered workspaces stay",
    ["shell-double"],
    () =>
      withBusySeam("t321-busy-repository", async (service, seam) => {
        const git = gitPath();
        const built = buildF07(git, "t321-busy-repository");
        const a = await service.register(join(built.root, "wt-a"));
        const b = await service.register(join(built.root, "wt-b"));
        const other = join(buildF02(git, "t321-busy-repository-other").root, "repo");
        seam.busy.add(a.repositoryId);
        const response = await service.chooseRepository(other);
        expect({ state: response.state, code: response.code, releases: seam.releases }).toEqual({ state: "failed", code: "BUSY", releases: [] });
        for (const { repositoryId } of [a, b]) {
          const read = await codeAndSpawns(service, () => service.readWorkspace(repositoryId));
          expect({ repositoryId, state: read.state, ran: read.runs > 0 }).toEqual({ repositoryId, state: "succeeded", ran: true });
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    RELEASE_TASK,
    "with an unfinished mutation in a workspace of the current Git, a chooseGit that issues a new gitInstallationId gives BUSY, sends no release of that workspace or of the current Git, and sends one release of the new ID",
    ["shell-double"],
    () =>
      withBusySeam("t321-busy-git", async (service, seam) => {
        const git = gitPath();
        const repo = join(buildF02(git, "t321-busy-git").root, "repo");
        const { repositoryId } = await service.register(repo);
        const chooseGit = () => service.request("chooseGit", { bootstrapId: service.runner.addContext("gitProbe", git), executablePath: git });
        // The startup `chooseGit` of the harness is the only earlier response with a `gitInstallationId`.
        const current = (service.responses.find((r) => typeof (r.result as { gitInstallationId?: unknown } | undefined)?.gitInstallationId === "string")!.result as { gitInstallationId: string }).gitInstallationId;
        seam.busy.add(repositoryId);
        const framesBefore = service.runner.frames.length;
        const busy = await chooseGit();
        expect({ state: busy.state, code: busy.code, releases: seam.releases }).toEqual({ state: "failed", code: "BUSY", releases: [] });
        // The shell bound the new ID before the BUSY reply, so the service sends exactly one `release` for it.
        const shellReleases = service.runner.frames.slice(framesBefore).filter((f) => f.type === "release");
        expect(shellReleases).toEqual([{ type: "release", gitInstallationId: expect.any(String) }]);
        expect(shellReleases[0]!.gitInstallationId).not.toBe(current);
        const read = await codeAndSpawns(service, () => service.readWorkspace(repositoryId));
        expect({ state: read.state, ran: read.runs > 0 }).toEqual({ state: "succeeded", ran: true });
        // Without the unfinished mutation, the same chooseGit issues a new gitInstallationId and releases the workspace and the current Git.
        seam.busy.clear();
        const chosen = await chooseGit();
        expect({ state: chosen.state, releases: seam.releases }).toEqual({ state: "succeeded", releases: [{ repositoryId }, { gitInstallationId: current }] });
      }),
    TIMEOUT_MS,
  );

  // Contract §3 `openRecentRepository`: the shell forwards an open as `restoreWorkspace`, so every check of `restoreWorkspace` applies.
  caseTest(
    RECENT_TASK,
    "with an unfinished mutation in a registered workspace, an open of another common directory gives BUSY, sends no release, and the workspace stays",
    ["shell-double"],
    () =>
      withBusySeam("t343-busy-open", async (service, seam) => {
        const git = gitPath();
        const { repositoryId } = await service.register(join(buildF02(git, "t343-busy-open").root, "repo"));
        const other = join(buildF06(git, "t343-busy-open-other").root, "repo");
        seam.busy.add(repositoryId);
        const response = await service.restoreWorkspace(other);
        expect({ state: response.state, code: response.code, releases: seam.releases }).toEqual({ state: "failed", code: "BUSY", releases: [] });
        const read = await codeAndSpawns(service, () => service.readWorkspace(repositoryId));
        expect({ state: read.state, ran: read.runs > 0 }).toEqual({ state: "succeeded", ran: true });
      }),
    TIMEOUT_MS,
  );

  // Contract §3: the shell stores the recent entry from `worktreeRoot` and `worktreeKey` of the result.
  caseTest(
    RECENT_TASK,
    "chooseRepository and restoreWorkspace results carry the Git-resolved worktreeRoot beside the worktreeKey",
    ["shell-double"],
    () =>
      withService("t343-worktree-root", async (service) => {
        const repo = join(buildF02(gitPath(), "t343-worktree-root").root, "repo");
        mkdirSync(join(repo, "sub"));
        const chosen = await service.chooseRepository(join(repo, "sub"));
        const restored = await service.restoreWorkspace(repo);
        const { repositoryId } = chosen.result as { repositoryId: string };
        const read = await service.readWorkspace(repositoryId);
        // The root that Git resolved, in the form of the workspace identity.
        const root = (read.result as { identity: { worktreeRoot: string } }).identity.worktreeRoot;
        expect(realpathSync.native(root)).toBe(realpathSync.native(repo));
        for (const response of [chosen, restored]) {
          expect(response.state).toBe("succeeded");
          expect(Object.keys(response.result as object).toSorted()).toEqual(["generation", "repositoryId", "worktreeKey", "worktreeRoot"]);
          expect((response.result as { worktreeRoot: string }).worktreeRoot).toBe(root);
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    RELEASE_TASK,
    "a release stops the watchers of the released workspace: an external change there gives no hint",
    ["shell-double"],
    async () => {
      const real = watchModule.watchWorkspace;
      const watched: { hints: number }[] = [];
      const spy = spyOn(watchModule, "watchWorkspace").mockImplementation((directories, onHint) => {
        const record = { hints: 0 };
        watched.push(record);
        return real(directories, (lost) => {
          record.hints++;
          onHint(lost);
        });
      });
      try {
        await withService("t321-release-watch", async (service) => {
          const git = gitPath();
          const repo = join(buildF02(git, "t321-release-watch").root, "repo");
          const other = join(buildF06(git, "t321-release-watch-other").root, "repo");
          await service.register(repo);
          expect(watched.length).toBe(1);
          const own = watched[0]!;
          // The watcher is live before the release.
          const before = own.hints;
          writeFileSync(join(repo, "t321-before.txt"), "before\n");
          const until = performance.now() + WAIT_MS;
          while (own.hints === before) {
            if (performance.now() > until) throw new Error(`no watcher hint within ${WAIT_MS} ms`);
            await Bun.sleep(10);
          }
          expect((await service.chooseRepository(other)).state).toBe("succeeded");
          expect(watched.length).toBe(2);
          const released = own.hints;
          writeFileSync(join(repo, "t321-after.txt"), "after\n");
          await Bun.sleep(HINT_BUDGET_MS);
          expect(own.hints).toBe(released);
        });
      } finally {
        spy.mockRestore();
      }
    },
    TIMEOUT_MS,
  );

  // The session also refuses a released `repositoryId` before `readEntries` runs (the request check in `session.ts`). This case checks the reader alone.
  caseTest(
    RELEASE_TASK,
    "after a release, readEntries with a cursor of the released snapshot gives UNKNOWN_TARGET and starts no Git process",
    ["shell-double"],
    () =>
      withService("t321-release-entries", async (service) => {
        const git = gitPath();
        const repo = join(buildF02(git, "t321-release-entries").root, "repo");
        const other = join(buildF06(git, "t321-release-entries-other").root, "repo");
        // Untracked records with 4,000-byte names fill more than one Status page.
        const listing = Buffer.concat([statusHeaders(git, repo), ...Array.from({ length: 1200 }, (_, i) => Buffer.from(`? u/${String(i).padStart(4, "0")}${"n".repeat(4000)}\0`))]);
        service.runner.inject.stdout = (call) => (isStatus(call.arguments) ? listing : undefined);
        const probed = await probeGit(service.runner, { bootstrapId: service.runner.addContext("gitProbe", git), executablePath: git });
        if (!("installation" in probed)) throw new Error(`probe failed: ${JSON.stringify(probed)}`);
        const { installation } = probed;
        const reader = createWorkspaceReader({ runner: service.runner, trust: createTrust({ runner: service.runner, environment: serviceEnv(), configFiles: () => installation.configFiles }) });
        // `session.ts` wires `onRelease` to the reader release in the same way.
        const registrations = registrationModule.createRegistrations({ runner: service.runner, unfinishedMutation: () => false, onRelease: (w) => reader.release(w.repositoryId) });
        const register = async (path: string) => {
          const outcome = await registrations.register({ operationId: crypto.randomUUID(), bootstrapId: service.runner.addContext("repositoryDiscovery", path), installation, signal: new AbortController().signal });
          if (!outcome.ok || !("repositoryId" in outcome.result)) throw new Error(`registration failed: ${JSON.stringify(outcome)}`);
          return outcome.result.repositoryId;
        };
        const repositoryId = await register(repo);
        const read = await reader.readWorkspace({ operationId: crypto.randomUUID(), signal: new AbortController().signal, installation, workspace: registrations.get(repositoryId)!, refresh: false, check: "full" });
        if (read.result !== "succeeded") throw new Error(`read ended ${read.result}`);
        const { generation, snapshotId, cursor } = read.value;
        if (cursor === null) throw new Error("the snapshot has one page");
        expect(reader.readEntries(repositoryId, generation, snapshotId, cursor).ok).toBe(true);
        await register(other);
        expect(registrations.has(repositoryId)).toBe(false);
        const before = service.runner.calls.length;
        const page = reader.readEntries(repositoryId, generation, snapshotId, cursor);
        expect({ page, runs: service.runner.calls.length - before }).toEqual({ page: { ok: false, code: "UNKNOWN_TARGET" }, runs: 0 });
      }),
    TIMEOUT_MS,
  );
});

describe("readKind (contract §3 `readWorkspace`, §8 \"Change check\")", () => {
  caseTest(
    "T356",
    'a check "changes" read without a hint gives readKind retained and starts no Git process, and a full read gives readKind full',
    ["shell-double"],
    async () => {
      const service = await openService({ git: gitPath(), name: "t356-read-kind", watchHints: false });
      try {
        const repo = join(buildF02(gitPath(), "t356-read-kind").root, "repo");
        const { repositoryId } = await service.register(repo);
        const kind = async (check: "full" | "changes") => {
          const before = service.runner.calls.length;
          const response = await service.readWorkspace(repositoryId, { refresh: false, check });
          expect(response.state).toBe("succeeded");
          return { readKind: (response.result as { readKind?: unknown }).readKind, runs: service.runner.calls.length - before };
        };
        // Contract §8 "New candidates": the first listing can name candidates that its earlier tuple did not hold. So the second full read makes the compared tuple.
        expect((await kind("full")).readKind).toBe("full");
        expect((await kind("full")).readKind).toBe("full");
        expect(await kind("changes")).toEqual({ readKind: "retained", runs: 0 });
        expect((await kind("full")).readKind).toBe("full");
      } finally {
        await service.dispose();
      }
    },
    TIMEOUT_MS,
  );
});
