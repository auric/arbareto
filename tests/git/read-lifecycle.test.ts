// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { CONCURRENT_READS_GLOBAL, CONCURRENT_READS_PER_WORKSPACE, NATIVE_CHUNK_BYTES, PENDING_READS_GLOBAL, RECONCILIATION_TARGET_MS } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import type { CallMatch, RecordedCall } from "./bun-runner";
import { fixtureGit, useFixtureRoot } from "./fixture-root";
import { buildF02, buildF07, put, type Built } from "./fixtures";
import { GIT } from "./git-binary";
import { caseTest, once, openService, type HistoryResult, type OpenOptions, type Service, type ServiceResponse, type WorkspaceResult } from "./service-harness";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/git-service/read-scheduler.ts", import.meta.dir);

const TASK = "T074";
const TIMEOUT_MS = 120_000;
const WAIT_MS = 30_000;
const W = ["windows-shell-double"] as const;
// The test-injected read deadline (`readDeadlineMs` seam).
const DEADLINE_MS = 3_000;
// A negative check has no event to wait for. A read that the scheduler admits starts its first process at once, so this wait is far above that time.
const SETTLE_MS = 500;

const FULL = { refresh: false, check: "full" } as const;
const SUCCEEDED = { state: "succeeded", code: undefined };

useFixtureRoot();

const gitPath = (): string => {
  if (GIT === null) throw new Error("Git executable absent");
  return GIT;
};
const repoOf = (built: Built, name = "repo") => join(built.root, name);
const outcome = (response: ServiceResponse) => ({ state: response.state, code: response.code });

const isStatus: CallMatch = (call) => call.arguments.includes("status");
const isRevList: CallMatch = (call) => call.arguments.includes("rev-list");
// Every registered call. `gitProbe` calls are the only ones without `--no-lazy-fetch` (contract §7 "Missing objects").
const isRegistered: CallMatch = (call) => call.arguments[0] === "--no-lazy-fetch";

// Untracked records far above the 64 KiB pipe buffer of the shell double. A held status process then waits on its write, so only a stop ends it.
function fillStatus(repo: string): void {
  const name = "u".repeat(100);
  for (let i = 0; i < Math.ceil((4 * NATIVE_CHUNK_BYTES) / name.length); i++) put(repo, `untracked/${name}-${i}.txt`, "");
}

function stageChange(repo: string, text: string): void {
  put(repo, "keep.txt", `${text}\n`);
  fixtureGit(gitPath(), repo, ["add", "--", "keep.txt"]);
}

async function withService(options: Omit<OpenOptions, "git">, body: (service: Service) => Promise<void>): Promise<void> {
  const service = await openService({ git: gitPath(), ...options });
  try {
    await body(service);
  } finally {
    await service.dispose();
  }
}

async function waitFor(what: string, found: () => boolean): Promise<void> {
  const until = performance.now() + WAIT_MS;
  while (!found()) {
    if (performance.now() > until) throw new Error(`${what}: not seen within ${WAIT_MS} ms`);
    await Bun.sleep(10);
  }
}

// The first call of `operationId` that `match` accepts, once the double recorded it.
async function heldCall(service: Service, operationId: string, match: CallMatch): Promise<RecordedCall> {
  const find = () => service.runner.calls.find((c) => c.operationId === operationId && match(c));
  await waitFor(`call of ${operationId}`, () => find() !== undefined);
  return find()!;
}

// The accepted calls of a workspace that started inside a time window.
const callsBetween = (service: Service, repositoryId: string, from: number, to: number) => service.runner.calls.filter((c) => c.repositoryId === repositoryId && c.at > from && c.at < to && c.refused === undefined);

// The operations with a recorded call since `from`. A waiting read records no call.
const runningOperations = (service: Service, from: number) => new Set(service.runner.calls.slice(from).map((c) => c.operationId));

describe("cancellation (data-model §7)", () => {
  caseTest(
    TASK,
    "cancel of a held read gives cancel-requested; after the owned process stops and the relevant state is re-read, the read ends canceled; a second read in the same workspace completes",
    W,
    () =>
      withService({ name: "t074-cancel" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t074-cancel"));
        fillStatus(repo);
        const { repositoryId } = await service.register(repo);
        const release = service.runner.pauseStdout(once(isStatus));
        try {
          const read = service.send("readWorkspace", FULL, { repositoryId });
          const operationId = await service.operationId(read);
          const held = await heldCall(service, operationId, isStatus);
          const cancel = service.send("cancel", { operationId });
          const ack = await service.response<{ state: string }>(cancel);
          expect({ state: ack.state, target: ack.result?.state }).toEqual({ state: "succeeded", target: "cancel-requested" });
          const done = await service.response(read);
          expect(outcome(done)).toEqual({ state: "canceled", code: "CANCELED" });
          expect(held.exit?.exitCode).toBeNull();
          expect(callsBetween(service, repositoryId, service.responseAt.get(cancel)!, service.responseAt.get(read)!).length).toBeGreaterThan(0);
          expect(outcome(await service.readWorkspace(repositoryId))).toEqual(SUCCEEDED);
        } finally {
          release();
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "cancellation stops only processes that the operation owns",
    W,
    () =>
      withService({ name: "t074-owned" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t074-owned"));
        fillStatus(repo);
        const { repositoryId } = await service.register(repo);
        // The first barrier takes the first status call, so the second takes the next one. Later status calls pass.
        const releaseA = service.runner.pauseStdout(once(isStatus));
        const releaseB = service.runner.pauseStdout(once(isStatus));
        try {
          const a = service.send("readWorkspace", FULL, { repositoryId });
          const operationA = await service.operationId(a);
          const heldA = await heldCall(service, operationA, isStatus);
          const b = service.send("readWorkspace", FULL, { repositoryId });
          const operationB = await service.operationId(b);
          const heldB = await heldCall(service, operationB, isStatus);
          expect((await service.cancel(operationA)).state).toBe("succeeded");
          expect(outcome(await service.response(a))).toEqual({ state: "canceled", code: "CANCELED" });
          expect(heldA.exit?.exitCode).toBeNull();
          expect({ exit: heldB.exit, answered: service.responseAt.has(b) }).toEqual({ exit: undefined, answered: false });
          releaseB();
          expect(outcome(await service.response(b))).toEqual(SUCCEEDED);
          expect(heldB.exit?.exitCode).toBe(0);
        } finally {
          releaseA();
          releaseB();
        }
      }),
    TIMEOUT_MS,
  );

  test.todo("a superseded selection read is canceled (needs T105/T115)", async () => {
    const repo = repoOf(buildF02(gitPath(), "t074-superseded"));
    const service = await openService({ git: gitPath(), name: "t074-superseded" });
    const release = service.runner.pauseStdout(once((c) => c.arguments.includes("diff-files")));
    try {
      const { repositoryId } = await service.register(repo);
      const read = (await service.readWorkspace(repositoryId)).result!;
      const [first, second] = ["multi.txt", "other-a.txt"].map((path) => read.entries.find((e) => e.path === path)!);
      const older = service.send("readComparison", { snapshotId: read.snapshotId, entryId: first!.entryId }, { repositoryId, repositoryGeneration: read.generation, selectionId: crypto.randomUUID() });
      await heldCall(service, await service.operationId(older), (c) => c.arguments.includes("diff-files"));
      const newer = await service.request("readComparison", { snapshotId: read.snapshotId, entryId: second!.entryId }, { repositoryId, repositoryGeneration: read.generation, selectionId: crypto.randomUUID() });
      expect(outcome(newer)).toEqual(SUCCEEDED);
      expect(outcome(await service.response(older))).toEqual({ state: "canceled", code: "CANCELED" });
    } finally {
      release();
      await service.dispose();
    }
  });
});

describe("re-read after a failed read and the read deadline (data-model §7)", () => {
  caseTest(
    TASK,
    `a read past a test-injected ${DEADLINE_MS} ms deadline ends failed with DEADLINE: its process stops, and the service re-reads the relevant state before the terminal result`,
    W,
    () =>
      withService({ name: "t074-deadline", readDeadlineMs: DEADLINE_MS }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t074-deadline"));
        fillStatus(repo);
        const { repositoryId } = await service.register(repo);
        const release = service.runner.pauseStdout(once(isStatus));
        try {
          const sentAt = performance.now();
          const read = service.send("readWorkspace", FULL, { repositoryId });
          const held = await heldCall(service, await service.operationId(read), isStatus);
          const done = await service.response(read);
          const doneAt = service.responseAt.get(read)!;
          expect(outcome(done)).toEqual({ state: "failed", code: "DEADLINE" });
          expect(doneAt - sentAt).toBeGreaterThanOrEqual(DEADLINE_MS);
          expect(doneAt - sentAt).toBeLessThan(DEADLINE_MS + RECONCILIATION_TARGET_MS);
          expect(held.exit?.exitCode).toBeNull();
          // The held status call blocks every later step of the read. So a call after half the deadline belongs to the re-read.
          expect(callsBetween(service, repositoryId, sentAt + DEADLINE_MS / 2, doneAt).length).toBeGreaterThan(0);
        } finally {
          release();
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a read past the test-injected deadline ends failed with DEADLINE also while it is cancel-requested",
    W,
    () =>
      withService({ name: "t074-deadline-cancel", readDeadlineMs: DEADLINE_MS }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t074-deadline-cancel"));
        fillStatus(repo);
        const { repositoryId } = await service.register(repo);
        // A start barrier that holds nothing records each call that starts after the cancel. The second stdout barrier then holds the first of them.
        let armed = false;
        const afterCancel = new WeakSet<object>();
        const spy = service.runner.holdStart((call) => {
          if (armed) afterCancel.add(call);
          return false;
        });
        const releaseFirst = service.runner.pauseStdout(once(isStatus));
        const releaseLater = service.runner.pauseStdout(once((call) => afterCancel.has(call)));
        try {
          const sentAt = performance.now();
          const read = service.send("readWorkspace", FULL, { repositoryId });
          const operationId = await service.operationId(read);
          await heldCall(service, operationId, isStatus);
          armed = true;
          const cancel = service.send("cancel", { operationId });
          expect((await service.response<{ state: string }>(cancel)).result?.state).toBe("cancel-requested");
          const ackAt = service.responseAt.get(cancel)!;
          await waitFor("a call after the cancel", () => callsBetween(service, repositoryId, ackAt, Number.POSITIVE_INFINITY).length > 0);
          expect(((await service.getOperation(operationId)).result as { state: string }).state).toBe("cancel-requested");
          const done = await service.response(read);
          const doneAt = service.responseAt.get(read)!;
          expect(outcome(done)).toEqual({ state: "failed", code: "DEADLINE" });
          expect(doneAt - sentAt).toBeGreaterThanOrEqual(DEADLINE_MS);
          expect(doneAt - sentAt).toBeLessThan(DEADLINE_MS + RECONCILIATION_TARGET_MS);
        } finally {
          spy();
          releaseFirst();
          releaseLater();
        }
      }),
    TIMEOUT_MS,
  );
});

describe("read limits (contract §5 \"Concurrent reads\" and \"Pending reads\")", () => {
  caseTest(
    TASK,
    `${CONCURRENT_READS_PER_WORKSPACE} reads run at once in one workspace, and one more waits without a process until a slot frees`,
    W,
    () =>
      withService({ name: "t074-workspace-cap" }, async (service) => {
        const { repositoryId } = await service.register(repoOf(buildF02(gitPath(), "t074-workspace-cap")));
        const from = service.runner.calls.length;
        const release = service.runner.holdStart(isRegistered);
        try {
          const reads = Array.from({ length: CONCURRENT_READS_PER_WORKSPACE + 1 }, () => service.send("readWorkspace", FULL, { repositoryId }));
          await waitFor(`${CONCURRENT_READS_PER_WORKSPACE} running reads`, () => runningOperations(service, from).size >= CONCURRENT_READS_PER_WORKSPACE);
          await Bun.sleep(SETTLE_MS);
          expect(runningOperations(service, from).size).toBe(CONCURRENT_READS_PER_WORKSPACE);
          release();
          for (const read of reads) expect(outcome(await service.response(read))).toEqual(SUCCEEDED);
        } finally {
          release();
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    `${CONCURRENT_READS_GLOBAL} reads run at once across workspaces, ${PENDING_READS_GLOBAL} more wait, and one more read is rejected without a process`,
    W,
    () =>
      withService({ name: "t074-global-cap" }, async (service) => {
        const built = buildF07(gitPath(), "t074-global-cap");
        // Three linked worktrees of one common directory stay registered together. Three workspaces can hold more than 4 reads at the per-workspace cap.
        const ids: string[] = [];
        for (const name of ["main", "wt-a", "wt-b"]) ids.push((await service.register(join(built.root, name))).repositoryId);
        const from = service.runner.calls.length;
        const release = service.runner.holdStart(isRegistered);
        try {
          const reads = Array.from({ length: CONCURRENT_READS_GLOBAL + PENDING_READS_GLOBAL }, (_, i) => service.send("readWorkspace", FULL, { repositoryId: ids[i % ids.length] }));
          await waitFor(`${CONCURRENT_READS_GLOBAL} running reads`, () => runningOperations(service, from).size >= CONCURRENT_READS_GLOBAL);
          await Bun.sleep(SETTLE_MS);
          const calls = service.runner.calls.slice(from);
          expect(runningOperations(service, from).size).toBe(CONCURRENT_READS_GLOBAL);
          for (const id of ids) expect(new Set(calls.filter((c) => c.repositoryId === id).map((c) => c.operationId)).size).toBeLessThanOrEqual(CONCURRENT_READS_PER_WORKSPACE);
          const before = service.runner.calls.length;
          const extra = await service.response(service.send("readWorkspace", FULL, { repositoryId: ids[0] }), RECONCILIATION_TARGET_MS);
          // Contract §5 fixes the pending bound. It fixes no code for the read above it.
          expect({ state: extra.state, runs: service.runner.calls.length - before }).toEqual({ state: "rejected", runs: 0 });
          release();
          for (const read of reads) expect(outcome(await service.response(read))).toEqual(SUCCEEDED);
        } finally {
          release();
        }
      }),
    TIMEOUT_MS,
  );
});

describe("late responses (contract §8)", () => {
  caseTest(
    TASK,
    "a readWorkspace that finishes after a newer read keeps its old repositoryGeneration, so the caller can discard it",
    W,
    () =>
      withService({ name: "t074-late-workspace" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t074-late-workspace"));
        const { repositoryId } = await service.register(repo);
        const old = (await service.readWorkspace(repositoryId)).result!.generation;
        const release = service.runner.pauseStdout(once(isStatus));
        try {
          const late = service.send("readWorkspace", FULL, { repositoryId });
          await heldCall(service, await service.operationId(late), isStatus);
          // The small F02 status ends at once. Only its output waits at the barrier, so it shows the state before the change.
          await Bun.sleep(SETTLE_MS);
          stageChange(repo, "keep t074 late");
          const newer = service.send("readWorkspace", FULL, { repositoryId });
          const newerResponse = await service.response<WorkspaceResult>(newer);
          expect(outcome(newerResponse)).toEqual(SUCCEEDED);
          expect(newerResponse.repositoryGeneration).toBeGreaterThan(old);
          release();
          const lateResponse = await service.response<WorkspaceResult>(late);
          expect(service.responseAt.get(late)!).toBeGreaterThan(service.responseAt.get(newer)!);
          expect({ repositoryGeneration: lateResponse.repositoryGeneration, generation: lateResponse.result?.generation }).toEqual({ repositoryGeneration: old, generation: old });
        } finally {
          release();
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a readHistory that finishes after a newer read keeps its request repositoryGeneration",
    W,
    () =>
      withService({ name: "t074-late-history" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t074-late-history"));
        const { repositoryId } = await service.register(repo);
        const old = (await service.readWorkspace(repositoryId)).result!.generation;
        const release = service.runner.pauseStdout(once(isRevList));
        try {
          const late = service.send("readHistory", {}, { repositoryId, repositoryGeneration: old });
          await heldCall(service, await service.operationId(late), isRevList);
          stageChange(repo, "keep t074 history");
          const newer = service.send("readWorkspace", FULL, { repositoryId });
          const newerResponse = await service.response<WorkspaceResult>(newer);
          expect(newerResponse.repositoryGeneration).toBeGreaterThan(old);
          release();
          const lateResponse = await service.response<HistoryResult>(late);
          expect(service.responseAt.get(late)!).toBeGreaterThan(service.responseAt.get(newer)!);
          expect({ ...outcome(lateResponse), repositoryGeneration: lateResponse.repositoryGeneration, generation: lateResponse.result?.generation }).toEqual({ ...SUCCEEDED, repositoryGeneration: old, generation: old });
        } finally {
          release();
        }
      }),
    TIMEOUT_MS,
  );

  test.todo("a readComparison that finishes after a newer request keeps its old repositoryGeneration and selectionId (needs T105/T115)", async () => {
    const repo = repoOf(buildF02(gitPath(), "t074-late-comparison"));
    const service = await openService({ git: gitPath(), name: "t074-late-comparison" });
    const release = service.runner.pauseStdout(once((c) => c.arguments.includes("diff-files")));
    try {
      const { repositoryId } = await service.register(repo);
      const read = (await service.readWorkspace(repositoryId)).result!;
      const entry = read.entries.find((e) => e.path === "multi.txt" && e.category === "unstaged")!;
      const selectionId = crypto.randomUUID();
      const late = service.send("readComparison", { snapshotId: read.snapshotId, entryId: entry.entryId }, { repositoryId, repositoryGeneration: read.generation, selectionId });
      await heldCall(service, await service.operationId(late), (c) => c.arguments.includes("diff-files"));
      stageChange(repo, "keep t074 comparison");
      expect((await service.readWorkspace(repositoryId)).result!.generation).toBeGreaterThan(read.generation);
      release();
      const response = await service.response(late);
      // Task T087: every response carries `repositoryGeneration` and `selectionId`.
      expect({ repositoryGeneration: response.repositoryGeneration, selectionId: Object.fromEntries(Object.entries(response)).selectionId }).toEqual({ repositoryGeneration: read.generation, selectionId });
    } finally {
      release();
      await service.dispose();
    }
  });
});

describe("recoveryState entry rules (data-model §2)", () => {
  caseTest(
    TASK,
    "while a refresh: true read is held, a refresh: false read that completes reports refreshing; after the release, the next read reports ready",
    W,
    () =>
      withService({ name: "t074-refreshing" }, async (service) => {
        const { repositoryId } = await service.register(repoOf(buildF02(gitPath(), "t074-refreshing")));
        expect((await service.readWorkspace(repositoryId)).result?.recoveryState).toBe("ready");
        const release = service.runner.pauseStdout(once(isStatus));
        try {
          const refresh = service.send("readWorkspace", { refresh: true, check: "full" }, { repositoryId });
          await heldCall(service, await service.operationId(refresh), isStatus);
          const during = await service.readWorkspace(repositoryId);
          expect({ ...outcome(during), recoveryState: during.result?.recoveryState }).toEqual({ ...SUCCEEDED, recoveryState: "refreshing" });
          release();
          expect(outcome(await service.response(refresh))).toEqual(SUCCEEDED);
          const after = await service.readWorkspace(repositoryId);
          expect({ ...outcome(after), recoveryState: after.result?.recoveryState }).toEqual({ ...SUCCEEDED, recoveryState: "ready" });
        } finally {
          release();
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a .git file moved out of a registered F07 linked worktree gives REPOSITORY_UNAVAILABLE with recoveryState unavailable, and after the restore the next complete read reports ready",
    W,
    () =>
      withService({ name: "t074-unavailable" }, async (service) => {
        const built = buildF07(gitPath(), "t074-unavailable");
        const worktree = join(built.root, "wt-a");
        const dotGit = join(worktree, ".git");
        // The file moves out of the worktree. Every watched directory stays.
        const moved = join(built.root, "wt-a.git-file");
        const { repositoryId } = await service.register(worktree);
        expect((await service.readWorkspace(repositoryId)).result?.recoveryState).toBe("ready");
        renameSync(dotGit, moved);
        try {
          const gone = await service.readWorkspace(repositoryId);
          expect({ code: gone.code, recoveryState: gone.result?.recoveryState }).toEqual({ code: "REPOSITORY_UNAVAILABLE", recoveryState: "unavailable" });
        } finally {
          renameSync(moved, dotGit);
        }
        const back = await service.readWorkspace(repositoryId);
        expect({ ...outcome(back), recoveryState: back.result?.recoveryState }).toEqual({ ...SUCCEEDED, recoveryState: "ready" });
      }),
    TIMEOUT_MS,
  );
});
