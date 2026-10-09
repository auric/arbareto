// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, jest, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { refPathArgs } from "../../src/git-service/commands";
import { probeGit } from "../../src/git-service/git-installation";
import type { GitRunner } from "../../src/git-service/git-runner";
import { createHistoryReader } from "../../src/git-service/history";
import { createRegistrations } from "../../src/git-service/registration";
import { createWorkspaceReader } from "../../src/git-service/status";
import { createTrust } from "../../src/git-service/trust";
import { watchWorkspace } from "../../src/git-service/watch";
import { printOrigin } from "../origin";
import type { CallMatch, RecordedCall } from "./bun-runner";
import { FIXTURE_ROOT, ownedGit, serviceEnv, useFixtureRoot, type OwnedGitOptions } from "./fixture-root";
import { buildF02, buildF18, put, type Built } from "./fixtures";
import { GIT } from "./git-binary";
import { caseTest, once, openService, withFsCalls, type OpenOptions, type Service, type ServiceResponse, type WorkspaceResult } from "./service-harness";

printOrigin("../../src/git-service/watch.ts", import.meta.dir);

const TASK = "T075";
const TIMEOUT_MS = 120_000;
const WAIT_MS = 30_000;
const W = ["shell-double"] as const;
// Task T075 and spec SC-007: a hint within 2 seconds. Plan.md "Freshness and reconciliation": a 100 ms debounce.
const HINT_BUDGET_MS = 2_000;
const DEBOUNCE_MS = 100;
// The quiet time before a change, so the events of earlier steps have given their hint.
const SETTLE_MS = 3 * DEBOUNCE_MS;
// Timers fire on whole milliseconds, so a debounce timer can end up to 1 ms before its nominal time.
const TIMER_SLACK_MS = 1;
// T088 decision E5: the longest wait from the first event that no hint delivered yet.
const MAX_WAIT_MS = 1000;

const FULL = { refresh: false, check: "full" } as const;
const CHANGES = { refresh: false, check: "changes" } as const;
const SUCCEEDED = { state: "succeeded", code: undefined };
// A fixed whole-millisecond time, so a restored time equals the one that the last complete read saw.
const FIXED_TIME = new Date(Date.UTC(2026, 0, 1));

useFixtureRoot();

const gitPath = (): string => {
  if (GIT === null) throw new Error("Git executable absent");
  return GIT;
};
const repoOf = (built: Built, name = "repo") => join(built.root, name);
const git = (cwd: string, args: string[], options: OwnedGitOptions = {}) => ownedGit(gitPath(), FIXTURE_ROOT, cwd, args, options).toString("utf8");
const outcome = (response: ServiceResponse) => ({ state: response.state, code: response.code });

const isStatus: CallMatch = (call) => call.arguments.includes("status");
// A full read lists status. Contract §8: a change check without a change starts no Git process.
const ranFullRead = (calls: RecordedCall[]) => calls.some(isStatus);
// The trust listing of contract §7: `config list --show-scope --show-origin -z`.
const listedTrust = (calls: RecordedCall[]) => calls.some((c) => c.arguments.includes("config") && c.arguments.includes("list"));

// Oracle: the worktree, the worktree administration directory, and the common directory, as Git resolves them.
function watchedDirectories(worktree: string): string[] {
  const [top, gitDir, common] = git(worktree, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]).trimEnd().split("\n");
  return [...new Set([top!, gitDir!, common!])];
}

// A new commit object on top of HEAD. It moves no ref. The fixture Git uses fixed times, so only another message gives another object ID.
const newCommit = (repo: string, message = "t075") => git(repo, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", message]).trim();

async function waitFor(what: string, found: () => boolean): Promise<void> {
  const until = performance.now() + WAIT_MS;
  while (!found()) {
    if (performance.now() > until) throw new Error(`${what}: not seen within ${WAIT_MS} ms`);
    await Bun.sleep(10);
  }
}

// Runs `body` with a watcher that records the time of each hint.
async function watching(directories: string[], body: (hints: number[]) => Promise<void>): Promise<void> {
  const hints: number[] = [];
  const stop = watchWorkspace(directories, () => hints.push(performance.now()));
  try {
    await body(hints);
  } finally {
    stop();
  }
}

// The seam: each `fs.watch` call gives a watcher that only the test drives, in call order.
async function withFakeWatch(body: (fakes: (EventEmitter & { close: () => void })[], spy: ReturnType<typeof spyOn<typeof fs, "watch">>) => Promise<void>): Promise<void> {
  const fakes: (EventEmitter & { close: () => void })[] = [];
  const spy = spyOn(fs, "watch").mockImplementation((() => {
    const fake = Object.assign(new EventEmitter(), { close: () => {} });
    fakes.push(fake);
    return fake;
  }) as never);
  try {
    await body(fakes, spy);
  } finally {
    spy.mockRestore();
  }
}

// Real watches. `events` holds each change event that the watches of `watch.ts` receive.
async function withWatchEvents(body: (events: string[]) => Promise<void>): Promise<void> {
  const events: string[] = [];
  const real = fs.watch;
  const spy = spyOn(fs, "watch").mockImplementation(((...args: Parameters<typeof fs.watch>) => {
    const watcher = real(...args);
    watcher.on("change", (event, name) => events.push(`${args[0]} ${event} ${name}`));
    return watcher;
  }) as never);
  try {
    await body(events);
  } finally {
    spy.mockRestore();
  }
}

// A real directory for a fake watch. `watch.ts` reads its identity at the start.
const fakeWatchDirectory = (name: string) => {
  const directory = join(FIXTURE_ROOT, name);
  mkdirSync(directory);
  return directory;
};

// Makes one change after a quiet time and returns the time from the change to the next hint.
async function hintAfter(hints: number[], what: string, change: () => void): Promise<number> {
  await Bun.sleep(SETTLE_MS);
  const count = hints.length;
  change();
  const changedAt = performance.now();
  while (hints.length <= count) {
    if (performance.now() - changedAt > HINT_BUDGET_MS) throw new Error(`${what}: no watcher hint within ${HINT_BUDGET_MS} ms`);
    await Bun.sleep(5);
  }
  return hints[count]! - changedAt;
}

describe("watcher hints (L, real files)", () => {
  // F18 files: `main` and `packed` live in `packed-refs`, and `loose` has its own ref file.
  const CHANGES_OF_F18: [string, (repo: string) => void][] = [
    ["a working-file change", (repo) => writeFileSync(join(repo, "watched.txt"), "watched t075\n")],
    ["an index change", (repo) => git(repo, ["update-index", "--chmod=+x", "--", "other.txt"])],
    ["a loose ref change", (repo) => git(repo, ["update-ref", "refs/heads/loose", newCommit(repo)])],
    ["a packed-refs change", (repo) => git(repo, ["update-ref", "-d", "refs/heads/packed"])],
    ["a HEAD change", (repo) => git(repo, ["symbolic-ref", "HEAD", "refs/heads/loose"])],
  ];

  for (const [label, change] of CHANGES_OF_F18) {
    caseTest(
      TASK,
      `F18 files: ${label} gives a watcher hint within ${HINT_BUDGET_MS} ms`,
      [],
      async () => {
        const repo = repoOf(buildF18(gitPath(), `t075-watch-${label.replaceAll(" ", "-")}`, "files"));
        await watching(watchedDirectories(repo), async (hints) => {
          expect(await hintAfter(hints, label, () => change(repo))).toBeLessThanOrEqual(HINT_BUDGET_MS);
        });
      },
      TIMEOUT_MS,
    );
  }

  caseTest(
    TASK,
    `F18 reftable: a commit in the main worktree and a branch switch in the linked worktree each give the linked worktree watcher a hint within ${HINT_BUDGET_MS} ms`,
    [],
    async () => {
      const built = buildF18(gitPath(), "t075-watch-reftable", "reftable");
      const main = repoOf(built);
      const wt = join(built.root, "wt");
      await watching(watchedDirectories(wt), async (hints) => {
        expect(await hintAfter(hints, "commit in the main worktree", () => git(main, ["commit", "-q", "--allow-empty", "--no-verify", "-m", "t075"]))).toBeLessThanOrEqual(HINT_BUDGET_MS);
        expect(await hintAfter(hints, "branch switch in the linked worktree", () => git(wt, ["symbolic-ref", "HEAD", "refs/heads/loose"]))).toBeLessThanOrEqual(HINT_BUDGET_MS);
      });
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    `watcher hints debounce for ${DEBOUNCE_MS} ms: changes with gaps below ${DEBOUNCE_MS} ms give one hint, at least ${DEBOUNCE_MS} ms after the last change`,
    [],
    async () => {
      const repo = repoOf(buildF18(gitPath(), "t075-debounce-burst", "files"));
      // 15 writes 20 ms apart take 300 ms, three debounce times. A watcher without a trailing debounce gives more than one hint.
      const writes = 15;
      const gapMs = DEBOUNCE_MS / 5;
      await watching(watchedDirectories(repo), async (hints) => {
        await Bun.sleep(SETTLE_MS);
        const count = hints.length;
        let last = 0;
        for (let i = 0; i < writes; i++) {
          writeFileSync(join(repo, "watched.txt"), `burst ${i}\n`);
          last = performance.now();
          await Bun.sleep(gapMs);
        }
        await Bun.sleep(HINT_BUDGET_MS);
        expect(hints.length - count).toBe(1);
        expect(hints[count]! - last).toBeGreaterThanOrEqual(DEBOUNCE_MS - TIMER_SLACK_MS);
        expect(hints[count]! - last).toBeLessThanOrEqual(HINT_BUDGET_MS);
      });
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    `watcher hints debounce for ${DEBOUNCE_MS} ms: two changes ${6 * DEBOUNCE_MS} ms apart give one hint each`,
    [],
    async () => {
      const repo = repoOf(buildF18(gitPath(), "t075-debounce-apart", "files"));
      await watching(watchedDirectories(repo), async (hints) => {
        await Bun.sleep(SETTLE_MS);
        const count = hints.length;
        writeFileSync(join(repo, "watched.txt"), "first\n");
        await Bun.sleep(6 * DEBOUNCE_MS);
        writeFileSync(join(repo, "watched.txt"), "second\n");
        await Bun.sleep(HINT_BUDGET_MS);
        expect(hints.length - count).toBe(2);
      });
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a watcher gives no hint without a change, and close() stops its hints (contract §6: a release stops the watcher)",
    [],
    async () => {
      const repo = repoOf(buildF18(gitPath(), "t075-close", "files"));
      const hints: number[] = [];
      const stop = watchWorkspace(watchedDirectories(repo), () => hints.push(performance.now()));
      try {
        await Bun.sleep(HINT_BUDGET_MS);
        expect(hints).toEqual([]);
      } finally {
        stop();
      }
      writeFileSync(join(repo, "watched.txt"), "after close\n");
      await Bun.sleep(HINT_BUDGET_MS);
      expect(hints).toEqual([]);
    },
    TIMEOUT_MS,
  );

  caseTest(
    "T088",
    "a change event without a file name gives a hint and re-arms the watch (T088 decision E8)",
    [],
    () =>
      withFakeWatch(async (fakes, spy) => {
        const directory = fakeWatchDirectory("t088-overflow");
        const hints: boolean[] = [];
        const stop = watchWorkspace([directory], (lost) => hints.push(lost));
        try {
          expect(fakes.length).toBe(1);
          const closed = spyOn(fakes[0]!, "close");
          fakes[0]!.emit("change", "rename", null);
          expect({ closes: closed.mock.calls.length, watched: spy.mock.calls.map((call) => call[0]) }).toEqual({ closes: 1, watched: [directory, directory] });
          await Bun.sleep(HINT_BUDGET_MS);
          expect(hints).toEqual([false]);
          fakes[1]!.emit("change", "change", "watched.txt");
          await Bun.sleep(HINT_BUDGET_MS);
          expect(hints).toEqual([false, false]);
        } finally {
          stop();
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    "T088",
    "a re-arm that fails after a change event without a file name gives a lost hint (T088 decision E8)",
    [],
    () =>
      withFakeWatch(async (fakes, spy) => {
        const hints: boolean[] = [];
        const stop = watchWorkspace([fakeWatchDirectory("t088-rearm-failed")], (lost) => hints.push(lost));
        try {
          spy.mockImplementationOnce(() => {
            throw new Error("t088 re-arm failed");
          });
          fakes[0]!.emit("change", "rename", null);
          await Bun.sleep(HINT_BUDGET_MS);
          expect({ watches: spy.mock.calls.length, hints }).toEqual({ watches: 2, hints: [true] });
        } finally {
          stop();
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    "T088",
    "an event during a pending identity check schedules one more check, so a later loss gives a lost hint (T088 decision E9)",
    [],
    () =>
      withFakeWatch(async (fakes) => {
        const directory = fakeWatchDirectory("t088-recheck");
        const pending: ((error: NodeJS.ErrnoException | null, stats?: fs.BigIntStats) => void)[] = [];
        const stat = spyOn(fs, "stat").mockImplementation(((_path: string, _options: unknown, done: (typeof pending)[number]) => {
          pending.push(done);
        }) as never);
        const hints: boolean[] = [];
        const stop = watchWorkspace([directory], (lost) => hints.push(lost));
        try {
          fakes[0]!.emit("change", "change", "watched.txt");
          await waitFor("the first identity check", () => pending.length === 1);
          fakes[0]!.emit("change", "change", "watched.txt");
          pending[0]!(null, statSync(directory, { bigint: true }));
          await waitFor("the second identity check", () => pending.length === 2);
          pending[1]!(Object.assign(new Error("t088 removed"), { code: "ENOENT" }));
          expect(hints).toContain(true);
        } finally {
          stop();
          stat.mockRestore();
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    "T088",
    `events every 50 ms for 3 s give hints at most ${MAX_WAIT_MS} ms apart (T088 decision E5: a maximum wait from the first undelivered event)`,
    [],
    () =>
      withFakeWatch(async (fakes) => {
        const directory = fakeWatchDirectory("t088-max-wait");
        jest.useFakeTimers();
        try {
          // The test clock: whole milliseconds since the first event. Each step advances the fake timers by 1 ms.
          let now = 0;
          const hints: number[] = [];
          const stop = watchWorkspace([directory], () => hints.push(now));
          try {
            while (now < 3000) {
              if (now % 50 === 0) fakes[0]!.emit("change", "change", "watched.txt");
              now += 1;
              jest.advanceTimersByTime(1);
            }
            for (let i = 0; i < 2 * DEBOUNCE_MS; i++) {
              now += 1;
              jest.advanceTimersByTime(1);
            }
            expect(hints).toEqual([MAX_WAIT_MS, 2 * MAX_WAIT_MS, 3 * MAX_WAIT_MS]);
          } finally {
            stop();
          }
        } finally {
          jest.useRealTimers();
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    "T088",
    "a watch that is lost or closed gives no hint for a later event",
    [],
    () =>
      withFakeWatch(async (fakes) => {
        const directory = fakeWatchDirectory("t088-stopped");
        const hints: boolean[] = [];
        const stop = watchWorkspace([directory], (lost) => hints.push(lost));
        try {
          fakes[0]!.emit("error", new Error("t088 lost"));
          fakes[0]!.emit("change", "change", "watched.txt");
          await Bun.sleep(HINT_BUDGET_MS);
          expect(hints).toEqual([true]);
        } finally {
          stop();
        }
        watchWorkspace([directory], (lost) => hints.push(lost))();
        fakes[1]!.emit("change", "change", "watched.txt");
        await Bun.sleep(HINT_BUDGET_MS);
        expect(hints).toEqual([true]);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    "T088",
    `a change keeps the watch, and removing the watched directories gives a lost hint within ${HINT_BUDGET_MS} ms`,
    [],
    async () => {
      const repo = repoOf(buildF18(gitPath(), "t088-removed", "files"));
      const hints: boolean[] = [];
      const stop = watchWorkspace(watchedDirectories(repo), (lost) => hints.push(lost));
      try {
        await Bun.sleep(SETTLE_MS);
        // The identity check runs one debounce time after the first event of the change.
        const from = hints.length;
        writeFileSync(join(repo, "watched.txt"), "watched t088\n");
        await Bun.sleep(HINT_BUDGET_MS);
        // NTFS last-access events on `.git` directories can add change hints (contract §8: a hint is only a hint).
        expect({ changeHints: hints.length > from, lost: hints.includes(true) }).toEqual({ changeHints: true, lost: false });
        rmSync(repo, { recursive: true, force: true });
        const removedAt = performance.now();
        while (!hints.includes(true)) {
          if (performance.now() - removedAt > HINT_BUDGET_MS) throw new Error(`no lost hint within ${HINT_BUDGET_MS} ms`);
          await Bun.sleep(5);
        }
      } finally {
        stop();
      }
    },
    TIMEOUT_MS,
  );
});

async function withService(options: Omit<OpenOptions, "git">, body: (service: Service) => Promise<void>): Promise<void> {
  const service = await openService({ git: gitPath(), ...options });
  try {
    await body(service);
  } finally {
    await service.dispose();
  }
}

// One read with the Git calls that it started.
async function read(service: Service, repositoryId: string, payload: typeof FULL | typeof CHANGES | { refresh: true; check: "full" }): Promise<{ response: ServiceResponse<WorkspaceResult>; calls: RecordedCall[]; result: WorkspaceResult }> {
  const before = service.runner.calls.length;
  const response = await service.readWorkspace(repositoryId, payload);
  expect(outcome(response)).toEqual(SUCCEEDED);
  return { response, calls: service.runner.calls.slice(before), result: response.result! };
}

// T088 decision E3: the first read after registration keeps no stat tuple, so the first check "changes" poll runs in full.
// The first trust listing reads the hooks folder. NTFS last-access updates on `.git` directories can give change events.
// So the helper polls until a poll starts no Git process, and returns that poll.
async function settled(service: Service, repositoryId: string): Promise<{ calls: RecordedCall[]; result: WorkspaceResult }> {
  await read(service, repositoryId, FULL);
  const until = performance.now() + WAIT_MS;
  for (;;) {
    const poll = await read(service, repositoryId, CHANGES);
    if (poll.calls.length === 0) return poll;
    if (performance.now() > until) throw new Error(`no check "changes" poll without a Git process within ${WAIT_MS} ms`);
    await Bun.sleep(DEBOUNCE_MS);
  }
}

const changedEntry = (result: WorkspaceResult, path: string) => result.entries.some((e) => e.path === path && e.category === "unstaged");

describe("hints in the service (contract §8)", () => {
  caseTest(
    TASK,
    `F18: an external working-file change gives a hint within ${HINT_BUDGET_MS} ms that marks the workspace dirty, and the next readWorkspace increases generation`,
    W,
    () =>
      withService({ name: "t075-hint-dirty" }, async (service) => {
        const repo = repoOf(buildF18(gitPath(), "t075-hint-dirty", "files"));
        const { repositoryId } = await service.register(repo);
        const first = await settled(service, repositoryId);
        const idle = await read(service, repositoryId, CHANGES);
        expect({ runs: idle.calls.length, snapshotId: idle.result.snapshotId }).toEqual({ runs: 0, snapshotId: first.result.snapshotId });
        // The stat tuple holds no unselected working file, so only the hint can start the full read.
        writeFileSync(join(repo, "watched.txt"), "watched t075\n");
        await Bun.sleep(HINT_BUDGET_MS);
        const next = await read(service, repositoryId, CHANGES);
        expect(ranFullRead(next.calls)).toBe(true);
        expect(next.result.generation).toBeGreaterThan(first.result.generation);
        expect(changedEntry(next.result, "watched.txt")).toBe(true);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a watcher event alone never marks state fresh: it starts no Git process and sends no response",
    W,
    () =>
      withService({ name: "t075-hint-alone" }, async (service) => {
        const repo = repoOf(buildF18(gitPath(), "t075-hint-alone", "files"));
        const { repositoryId } = await service.register(repo);
        const first = await settled(service, repositoryId);
        const counts = () => ({ calls: service.runner.calls.length, responses: service.responses.length, progress: service.progress.length });
        const before = counts();
        writeFileSync(join(repo, "watched.txt"), "watched t075\n");
        await Bun.sleep(HINT_BUDGET_MS);
        expect(counts()).toEqual(before);
        const next = await read(service, repositoryId, CHANGES);
        expect({ full: ranFullRead(next.calls), changed: changedEntry(next.result, "watched.txt"), newer: next.result.generation > first.result.generation }).toEqual({ full: true, changed: true, newer: true });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a watcher event during a running read does not let that read mark state fresh: the next check changes read runs a full read",
    W,
    () =>
      withService({ name: "t075-hint-during-read" }, async (service) => {
        const repo = repoOf(buildF18(gitPath(), "t075-hint-during-read", "files"));
        const { repositoryId } = await service.register(repo);
        await read(service, repositoryId, FULL);
        const release = service.runner.pauseStdout(once(isStatus));
        try {
          const running = service.send("readWorkspace", FULL, { repositoryId });
          const operationId = await service.operationId(running);
          await waitFor("held status call", () => service.runner.calls.some((c) => c.operationId === operationId && isStatus(c)));
          // The small F18 status ends at once. Only its output waits at the barrier.
          await Bun.sleep(SETTLE_MS);
          writeFileSync(join(repo, "watched.txt"), "watched t075\n");
          await Bun.sleep(HINT_BUDGET_MS);
          release();
          expect(outcome(await service.response(running))).toEqual(SUCCEEDED);
        } finally {
          release();
        }
        const next = await read(service, repositoryId, CHANGES);
        expect({ full: ranFullRead(next.calls), changed: changedEntry(next.result, "watched.txt") }).toEqual({ full: true, changed: true });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    "T088",
    `after the first reads, a full read gives its own watcher no hint: ${HINT_BUDGET_MS} ms later, a check "changes" read starts no Git process`,
    W,
    () =>
      withWatchEvents((events) =>
        withService({ name: "t088-own-read" }, async (service) => {
          const repo = repoOf(buildF18(gitPath(), "t088-own-read", "files"));
          const { repositoryId } = await service.register(repo);
          await settled(service, repositoryId);
          const from = events.length;
          const full = await read(service, repositoryId, FULL);
          await Bun.sleep(HINT_BUDGET_MS);
          const poll = await read(service, repositoryId, CHANGES);
          // NTFS last-access events on `.git` directories can add change hints (contract §8: a hint is only a hint).
          if (events.length > from) {
            console.log(`T088 own read: watcher events after the full read start\n  ${events.slice(from).join("\n  ")}`);
            expect(poll.calls.length === 0 ? poll.result.snapshotId === full.result.snapshotId : ranFullRead(poll.calls)).toBe(true);
          } else {
            expect({ runs: poll.calls.length, snapshotId: poll.result.snapshotId }).toEqual({ runs: 0, snapshotId: full.result.snapshotId });
          }
        }),
      ),
    TIMEOUT_MS,
  );

  caseTest(
    "T088",
    'a lost watcher makes every later check "changes" poll run a full read (T088 decision E4)',
    W,
    () =>
      withFakeWatch((fakes) =>
        withService({ name: "t088-lost" }, async (service) => {
          const repo = repoOf(buildF18(gitPath(), "t088-lost", "files"));
          const { repositoryId } = await service.register(repo);
          expect(fakes.length).toBeGreaterThan(0);
          await settled(service, repositoryId);
          expect((await read(service, repositoryId, CHANGES)).calls.length).toBe(0);
          fakes[0]!.emit("error", new Error("t088 lost"));
          for (let poll = 0; poll < 2; poll++) expect({ poll, full: ranFullRead((await read(service, repositoryId, CHANGES)).calls) }).toEqual({ poll, full: true });
        }),
      ),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    'the next readWorkspace call with check "full" recovers a suppressed watcher notification',
    W,
    () =>
      withService({ name: "t075-suppressed-full", watchHints: false }, async (service) => {
        const repo = repoOf(buildF18(gitPath(), "t075-suppressed-full", "files"));
        const { repositoryId } = await service.register(repo);
        const first = await read(service, repositoryId, FULL);
        writeFileSync(join(repo, "watched.txt"), "watched t075\n");
        const next = await read(service, repositoryId, FULL);
        expect({ full: ranFullRead(next.calls), changed: changedEntry(next.result, "watched.txt"), newer: next.result.generation > first.result.generation }).toEqual({ full: true, changed: true, newer: true });
      }),
    TIMEOUT_MS,
  );
});

describe("change check with suppressed hints (contract §8 \"Change check\")", () => {
  // Each F18 files change of the stat tuple, and whether it changes HEAD or the index, so that the generation increases.
  const TUPLE_CHANGES: [string, (repo: string) => void, boolean][] = [
    ["an index change", (repo) => git(repo, ["update-index", "--chmod=+x", "--", "other.txt"]), true],
    ["a HEAD change", (repo) => git(repo, ["symbolic-ref", "HEAD", "refs/heads/loose"]), true],
    ["a current-branch ref change", (repo) => git(repo, ["update-ref", "refs/heads/main", newCommit(repo)]), true],
    [
      "a packed-refs change",
      (repo) => {
        // `packed` lives only in `packed-refs`, so its deletion rewrites that file and no ref file.
        expect(existsSync(join(repo, ".git", "refs", "heads", "packed"))).toBe(false);
        const packedRefs = join(repo, ".git", "packed-refs");
        const before = readFileSync(packedRefs, "utf8");
        expect(before).toContain(" refs/heads/packed\n");
        git(repo, ["update-ref", "-d", "refs/heads/packed"]);
        expect(readFileSync(packedRefs, "utf8")).not.toBe(before);
      },
      false,
    ],
  ];

  for (const [label, change, moves] of TUPLE_CHANGES) {
    caseTest(
      TASK,
      `with a suppressed hint, a check "changes" read detects ${label} and then runs a full read`,
      W,
      () =>
        withService({ name: `t075-tuple-${label.replaceAll(" ", "-")}`, watchHints: false }, async (service) => {
          const repo = repoOf(buildF18(gitPath(), `t075-tuple-${label.replaceAll(" ", "-")}`, "files"));
          const { repositoryId } = await service.register(repo);
          const first = await settled(service, repositoryId);
          change(repo);
          const next = await read(service, repositoryId, CHANGES);
          expect(ranFullRead(next.calls)).toBe(true);
          if (moves) expect(next.result.generation).toBeGreaterThan(first.result.generation);
        }),
      TIMEOUT_MS,
    );
  }

  caseTest(
    "T088",
    'the first check "changes" poll after registration runs a full read, and a listing that names a new candidate file makes the next poll run in full too (T088 decision E3)',
    W,
    () =>
      withService({ name: "t088-new-candidate", watchHints: false }, async (service) => {
        const built = buildF18(gitPath(), "t088-new-candidate", "files");
        const repo = repoOf(built);
        const { repositoryId } = await service.register(repo);
        await read(service, repositoryId, FULL);
        // The first listing names every candidate file first.
        expect(ranFullRead((await read(service, repositoryId, CHANGES)).calls)).toBe(true);
        expect((await read(service, repositoryId, CHANGES)).calls.length).toBe(0);
        // A missing include target is a new candidate (contract §8 "Change check").
        git(repo, ["config", "include.path", join(built.root, "t088-include.gitconfig").replaceAll("\\", "/")]);
        const polls: boolean[] = [];
        for (let poll = 0; poll < 3; poll++) polls.push(ranFullRead((await read(service, repositoryId, CHANGES)).calls));
        expect(polls).toEqual([true, true, false]);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    "T088",
    'in a linked worktree, a change of its branch ref from the main worktree makes a check "changes" read run a full read, and Git resolves the ref file once (T088 decision E7)',
    W,
    () =>
      withService({ name: "t088-linked-ref", watchHints: false }, async (service) => {
        const built = buildF18(gitPath(), "t088-linked-ref", "files");
        const repo = repoOf(built);
        const wt = join(built.root, "t088-wt");
        git(repo, ["worktree", "add", "-q", "-b", "t088", wt]);
        const { repositoryId } = await service.register(wt);
        const resolves = () => service.runner.calls.filter((c) => c.arguments.join(" ") === refPathArgs("refs/heads/t088").join(" ")).length;
        const first = await settled(service, repositoryId);
        expect((await read(service, repositoryId, CHANGES)).calls.length).toBe(0);
        // The branch ref file lies in the common directory, not in the worktree administration directory.
        git(repo, ["update-ref", "refs/heads/t088", newCommit(repo)]);
        const next = await read(service, repositoryId, CHANGES);
        expect({ full: ranFullRead(next.calls), newer: next.result.generation > first.result.generation, resolves: resolves() }).toEqual({ full: true, newer: true, resolves: 1 });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    "T088",
    'a read that ends REPOSITORY_UNAVAILABLE during the stat compare of a check "changes" read makes that read run in full',
    W,
    () =>
      withService({ name: "t088-unavailable-race", watchHints: false }, async (service) => {
        const git = gitPath();
        const repo = repoOf(buildF18(git, "t088-unavailable-race", "files"));
        const probed = await probeGit(service.runner, { bootstrapId: service.runner.addContext("gitProbe", git), executablePath: git });
        if (!("installation" in probed)) throw new Error(`probe failed: ${JSON.stringify(probed)}`);
        const { installation } = probed;
        const registrations = createRegistrations({ runner: service.runner, unfinishedMutation: () => false });
        const registered = await registrations.register({ operationId: crypto.randomUUID(), bootstrapId: service.runner.addContext("repositoryDiscovery", repo), installation, signal: new AbortController().signal });
        if (!registered.ok || !("repositoryId" in registered.result)) throw new Error(`registration failed: ${JSON.stringify(registered)}`);
        const workspace = registrations.get(registered.result.repositoryId)!;
        // The session reads the configuration file paths from the installation (`session.ts`).
        const reader = createWorkspaceReader({ runner: service.runner, trust: createTrust({ runner: service.runner, environment: serviceEnv(), configFiles: () => installation.configFiles }) });
        const poll = async (check: "full" | "changes") => {
          const before = service.runner.calls.length;
          const outcome = await reader.readWorkspace({ operationId: crypto.randomUUID(), signal: new AbortController().signal, installation, workspace, refresh: false, check });
          return { result: outcome.result, runs: service.runner.calls.length - before };
        };
        await poll("full");
        await poll("changes");
        expect(await poll("changes")).toEqual({ result: "succeeded", runs: 0 });
        // The seam: `markUnavailable` runs before the first stat call of the compare, so after the check that the compare starts with.
        let marked = false;
        const { value } = await withFsCalls(
          () => poll("changes"),
          (call) => {
            if (marked || call.name !== "stat") return;
            marked = true;
            reader.markUnavailable(workspace.repositoryId);
          },
        );
        expect({ marked, result: value.result, full: value.runs > 0 }).toEqual({ marked: true, result: "succeeded", full: true });
      }),
    TIMEOUT_MS,
  );

  // Contract §5 "Deadline outcomes": a walk deadline in the change check ends the read as a Git step deadline does. It never becomes a full read.
  caseTest(
    "T312",
    'a walk deadline in the change check of a check "changes" read ends the read with deadline and starts no Git process',
    W,
    () =>
      withService({ name: "t312-change-check-deadline", watchHints: false }, async (service) => {
        const git = gitPath();
        const repo = repoOf(buildF18(git, "t312-change-check-deadline", "files"));
        const probed = await probeGit(service.runner, { bootstrapId: service.runner.addContext("gitProbe", git), executablePath: git });
        if (!("installation" in probed)) throw new Error(`probe failed: ${JSON.stringify(probed)}`);
        const { installation } = probed;
        const registrations = createRegistrations({ runner: service.runner, unfinishedMutation: () => false });
        const registered = await registrations.register({ operationId: crypto.randomUUID(), bootstrapId: service.runner.addContext("repositoryDiscovery", repo), installation, signal: new AbortController().signal });
        if (!registered.ok || !("repositoryId" in registered.result)) throw new Error(`registration failed: ${JSON.stringify(registered)}`);
        const workspace = registrations.get(registered.result.repositoryId)!;
        let stopped = 0;
        let deadline = false;
        const runner: GitRunner = {
          ...service.runner,
          fileFacts: (request, signal) => (deadline ? Promise.resolve((stopped++, { stop: "deadline" as const })) : service.runner.fileFacts(request, signal)),
        };
        const reader = createWorkspaceReader({ runner, trust: createTrust({ runner, environment: serviceEnv(), configFiles: () => installation.configFiles }) });
        const poll = async (check: "full" | "changes") => {
          const before = service.runner.calls.length;
          const outcome = await reader.readWorkspace({ operationId: crypto.randomUUID(), signal: new AbortController().signal, installation, workspace, refresh: false, check });
          return { result: outcome.result, runs: service.runner.calls.length - before };
        };
        await poll("full");
        await poll("changes");
        expect(await poll("changes")).toEqual({ result: "succeeded", runs: 0 });
        deadline = true;
        expect(await poll("changes")).toEqual({ result: "deadline", runs: 0 });
        expect(stopped).toBeGreaterThan(0);
      }),
    TIMEOUT_MS,
  );

  // Contract §6 "File facts": an `error` fact names no file state. So a tuple with it proves nothing, and the reads keep and share no tuple.
  caseTest(
    "T309",
    'an error fact for a program-file entry outside the trust listing keeps no tuple: a check "changes" read runs in full, and readHistory runs its own listing',
    W,
    () =>
      withService({ name: "t309-tuple-error", watchHints: false }, async (service) => {
        const git = gitPath();
        const repo = repoOf(buildF18(git, "t309-tuple-error", "files"));
        const probed = await probeGit(service.runner, { bootstrapId: service.runner.addContext("gitProbe", git), executablePath: git });
        if (!("installation" in probed)) throw new Error(`probe failed: ${JSON.stringify(probed)}`);
        const { installation } = probed;
        const registrations = createRegistrations({ runner: service.runner, unfinishedMutation: () => false });
        const registered = await registrations.register({ operationId: crypto.randomUUID(), bootstrapId: service.runner.addContext("repositoryDiscovery", repo), installation, signal: new AbortController().signal });
        if (!registered.ok || !("repositoryId" in registered.result)) throw new Error(`registration failed: ${JSON.stringify(registered)}`);
        const workspace = registrations.get(registered.result.repositoryId)!;
        // The stub gives the first entry of each phase-1 request outside a trust listing an `error` fact. The listings get the real facts.
        let listing = 0;
        let stubbed = 0;
        const runner: GitRunner = {
          ...service.runner,
          async fileFacts(request, signal) {
            const facts = await service.runner.fileFacts(request, signal);
            if (listing > 0 || request.digest || !Array.isArray(facts)) return facts;
            stubbed++;
            return facts.map((fact, i) => (i === 0 ? { kind: "error", component: request.files[0]!.path.length, code: "sharing-violation" } : fact));
          },
        };
        const trust = createTrust({ runner, environment: serviceEnv(), configFiles: () => installation.configFiles });
        const listTrust = trust.listTrust;
        trust.listTrust = async (target) => {
          listing++;
          try {
            return await listTrust(target);
          } finally {
            listing--;
          }
        };
        const reader = createWorkspaceReader({ runner, trust });
        const history = createHistoryReader({ runner, trust, listingTuple: reader.listingTuple, markUnavailable: reader.markUnavailable });
        const target = () => ({ operationId: crypto.randomUUID(), signal: new AbortController().signal, installation, workspace });
        const poll = async (check: "full" | "changes") => {
          const before = service.runner.calls.length;
          const outcome = await reader.readWorkspace({ ...target(), refresh: false, check });
          if (outcome.result !== "succeeded") throw new Error(`read ended ${outcome.result}`);
          return { generation: outcome.value.generation, full: ranFullRead(service.runner.calls.slice(before)) };
        };
        await poll("full");
        // Its tuple before the listing holds the stubbed fact. The first read had no program-file entry to ask.
        const second = await poll("full");
        expect(stubbed).toBe(1);
        expect((await poll("changes")).full).toBe(true);
        expect(stubbed).toBeGreaterThanOrEqual(2);
        const before = service.runner.calls.length;
        const read = await history.readHistory({ ...target(), generation: second.generation });
        expect({ result: read.result, listed: listedTrust(service.runner.calls.slice(before)) }).toEqual({ result: "succeeded", listed: true });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    "T088",
    "the first full read after registration shares no trust listing with readHistory, and a later full read does (T088 decision E6)",
    W,
    () =>
      withService({ name: "t088-first-share", watchHints: false }, async (service) => {
        const repo = repoOf(buildF18(gitPath(), "t088-first-share", "files"));
        const { repositoryId } = await service.register(repo);
        const listings = async (generation: number) => {
          const before = service.runner.calls.length;
          expect(outcome(await service.readHistory(repositoryId, generation))).toEqual(SUCCEEDED);
          return service.runner.calls.slice(before).filter((c) => listedTrust([c])).length;
        };
        expect(await listings((await read(service, repositoryId, FULL)).result.generation)).toBe(1);
        expect(await listings((await read(service, repositoryId, FULL)).result.generation)).toBe(0);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    'with a suppressed hint for an unselected working file, a check "changes" read returns the last snapshot, and the next check "full" read shows the change',
    W,
    () =>
      withService({ name: "t075-unselected", watchHints: false }, async (service) => {
        const repo = repoOf(buildF18(gitPath(), "t075-unselected", "files"));
        const { repositoryId } = await service.register(repo);
        const first = await settled(service, repositoryId);
        writeFileSync(join(repo, "watched.txt"), "watched t075\n");
        const poll = await read(service, repositoryId, CHANGES);
        expect({ runs: poll.calls.length, snapshotId: poll.result.snapshotId, generation: poll.result.generation, changed: changedEntry(poll.result, "watched.txt") }).toEqual({
          runs: 0,
          snapshotId: first.result.snapshotId,
          generation: first.result.generation,
          changed: false,
        });
        const full = await read(service, repositoryId, FULL);
        expect(changedEntry(full.result, "watched.txt")).toBe(true);
      }),
    TIMEOUT_MS,
  );

  // An F18 copy whose local clean filter names a program inside the worktree, so the trust fingerprint digests that file.
  const EDITS: [string, (repo: string) => void][] = [
    ["a configuration origin file", (repo) => git(repo, ["config", "t075.note", "edited"])],
    [
      "a digested program file",
      (repo) => {
        const path = join(repo, "tools", "clean.sh");
        const bytes = readFileSync(path);
        bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 0x01;
        writeFileSync(path, bytes);
      },
    ],
  ];

  for (const [label, edit] of EDITS) {
    caseTest(
      TASK,
      `an edit of ${label} makes a check "changes" read list trust again`,
      W,
      () =>
        withService({ name: `t075-trust-${label.replaceAll(" ", "-")}`, watchHints: false }, async (service) => {
          const repo = repoOf(buildF18(gitPath(), `t075-trust-${label.replaceAll(" ", "-")}`, "files"));
          put(repo, "tools/clean.sh", "#!/bin/sh\nexec cat\n# t075\n");
          git(repo, ["config", "filter.t075.clean", "./tools/clean.sh"]);
          const { repositoryId } = await service.register(repo);
          const trust = await service.readTrust(repositoryId);
          expect((await service.approveTrust(repositoryId, trust.result!.fingerprint, trust.result!.generation)).state).toBe("succeeded");
          await settled(service, repositoryId);
          const idle = await read(service, repositoryId, CHANGES);
          expect(idle.calls.length).toBe(0);
          edit(repo);
          const before = service.runner.calls.length;
          await service.readWorkspace(repositoryId, CHANGES);
          expect(listedTrust(service.runner.calls.slice(before))).toBe(true);
        }),
      TIMEOUT_MS,
    );
  }

  caseTest(
    "T088",
    'a trust revocation after a complete read makes the next check "changes" read apply the read gate again',
    W,
    () =>
      withService({ name: "t088-revoke", watchHints: false }, async (service) => {
        const repo = repoOf(buildF18(gitPath(), "t088-revoke", "files"));
        put(repo, "tools/clean.sh", "#!/bin/sh\nexec cat\n# t088\n");
        git(repo, ["config", "filter.t088.clean", "./tools/clean.sh"]);
        const { repositoryId } = await service.register(repo);
        const trust = await service.readTrust(repositoryId);
        const approved = await service.approveTrust(repositoryId, trust.result!.fingerprint, trust.result!.generation);
        expect(approved.state).toBe("succeeded");
        await settled(service, repositoryId);
        expect((await read(service, repositoryId, CHANGES)).calls.length).toBe(0);
        expect((await service.revokeTrust(repositoryId, approved.result!.trustId)).state).toBe("succeeded");
        const next = await service.readWorkspace(repositoryId, CHANGES);
        expect({ succeeded: next.state === "succeeded", code: next.code }).toEqual({ succeeded: false, code: "TRUST_REQUIRED" });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    "T320",
    'with a suppressed hint, a check "changes" read detects a change of the selected working file and then runs a full read',
    W,
    () =>
      withService({ name: "t075-selected", watchHints: false }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t075-selected"));
        const { repositoryId } = await service.register(repo);
        const first = (await settled(service, repositoryId)).result;
        const entry = first.entries.find((e) => e.path === "multi.txt" && e.category === "unstaged")!;
        // The comparison binds the working file of the selected entry (`workingVersions`).
        const compared = await service.request("readComparison", { snapshotId: first.snapshotId, entryId: entry.entryId }, { repositoryId, repositoryGeneration: first.generation, selectionId: crypto.randomUUID() });
        expect(outcome(compared)).toEqual(SUCCEEDED);
        expect((await read(service, repositoryId, CHANGES)).calls.length).toBe(0);
        writeFileSync(join(repo, "multi.txt"), "selected file changed\n");
        const next = await read(service, repositoryId, CHANGES);
        expect(ranFullRead(next.calls)).toBe(true);
      }),
    TIMEOUT_MS,
  );
});

describe("reftable change check with suppressed hints (contract §8 \"Change check\")", () => {
  // F18 reftable: the main worktree `repo` and the linked worktree `wt`.
  caseTest(
    TASK,
    'a commit in the main worktree makes a check "changes" read of each worktree run a full read',
    W,
    () =>
      withService({ name: "t075-reftable-commit", watchHints: false }, async (service) => {
        const built = buildF18(gitPath(), "t075-reftable-commit", "reftable");
        const [main, wt] = [repoOf(built), join(built.root, "wt")];
        const ids = [(await service.register(main)).repositoryId, (await service.register(wt)).repositoryId];
        const firsts = [await settled(service, ids[0]!), await settled(service, ids[1]!)];
        git(main, ["commit", "-q", "--allow-empty", "--no-verify", "-m", "t075"]);
        const mainNext = await read(service, ids[0]!, CHANGES);
        const wtNext = await read(service, ids[1]!, CHANGES);
        expect({ main: ranFullRead(mainNext.calls), wt: ranFullRead(wtNext.calls) }).toEqual({ main: true, wt: true });
        expect(mainNext.result.generation).toBeGreaterThan(firsts[0]!.result.generation);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    'a branch switch in the linked worktree makes its check "changes" read run a full read',
    W,
    () =>
      withService({ name: "t075-reftable-switch", watchHints: false }, async (service) => {
        const built = buildF18(gitPath(), "t075-reftable-switch", "reftable");
        const wt = join(built.root, "wt");
        const { repositoryId } = await service.register(wt);
        const first = await settled(service, repositoryId);
        expect(first.result.identity.refFormat).toBe("reftable");
        git(wt, ["symbolic-ref", "HEAD", "refs/heads/loose"]);
        const next = await read(service, repositoryId, CHANGES);
        expect(ranFullRead(next.calls)).toBe(true);
        expect({ head: next.result.head, newer: next.result.generation > first.result.generation }).toEqual({ head: { state: "branch", target: "refs/heads/loose", oid: built.facts.repos.wt!.refs["refs/heads/loose"]! }, newer: true });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    'a ref update that keeps the size and time of tables.list makes a check "changes" read run a full read',
    W,
    () =>
      withService({ name: "t075-reftable-same-size", watchHints: false }, async (service) => {
        const built = buildF18(gitPath(), "t075-reftable-same-size", "reftable");
        const repo = repoOf(built);
        const tables = resolve(repo, git(repo, ["rev-parse", "--git-common-dir"]).trim(), "reftable", "tables.list");
        // A large first table. Git's auto-compaction then keeps two tables after each small update, so tables.list keeps its size.
        const head = git(repo, ["rev-parse", "HEAD"]).trim();
        git(repo, ["update-ref", "--stdin"], { input: Buffer.from(Array.from({ length: 200 }, (_, i) => `create refs/tags/t075-${i} ${head}\n`).join("")) });
        git(repo, ["pack-refs"]);
        git(repo, ["update-ref", "refs/heads/loose", newCommit(repo, "t075 first")]);
        utimesSync(tables, FIXED_TIME, FIXED_TIME);
        const { repositoryId } = await service.register(repo);
        await settled(service, repositoryId);
        const before = readFileSync(tables);
        git(repo, ["update-ref", "refs/heads/loose", newCommit(repo, "t075 second")]);
        const after = readFileSync(tables);
        expect({ size: after.length, same: after.equals(before) }).toEqual({ size: before.length, same: false });
        utimesSync(tables, FIXED_TIME, FIXED_TIME);
        expect(statSync(tables).mtimeMs).toBe(FIXED_TIME.getTime());
        const next = await read(service, repositoryId, CHANGES);
        expect(ranFullRead(next.calls)).toBe(true);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    'an index change makes a check "changes" read run a full read',
    W,
    () =>
      withService({ name: "t075-reftable-index", watchHints: false }, async (service) => {
        const built = buildF18(gitPath(), "t075-reftable-index", "reftable");
        const wt = join(built.root, "wt");
        const { repositoryId } = await service.register(wt);
        const first = await settled(service, repositoryId);
        git(wt, ["update-index", "--chmod=+x", "--", "other.txt"]);
        const next = await read(service, repositoryId, CHANGES);
        expect({ full: ranFullRead(next.calls), newer: next.result.generation > first.result.generation }).toEqual({ full: true, newer: true });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    'without a ref or index change, a check "changes" read starts no Git process',
    W,
    () =>
      withService({ name: "t075-reftable-idle", watchHints: false }, async (service) => {
        const built = buildF18(gitPath(), "t075-reftable-idle", "reftable");
        for (const worktree of [repoOf(built), join(built.root, "wt")]) {
          const { repositoryId } = await service.register(worktree);
          const first = await settled(service, repositoryId);
          const poll = await read(service, repositoryId, CHANGES);
          expect({ worktree, runs: poll.calls.length, snapshotId: poll.result.snapshotId, generation: poll.result.generation }).toEqual({
            worktree,
            runs: 0,
            snapshotId: first.result.snapshotId,
            generation: first.result.generation,
          });
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    "T088",
    'a tables.list above 64 KiB gives an unknown fact, so every check "changes" poll runs a full read',
    W,
    () =>
      withService({ name: "t088-tables-over", watchHints: false }, async (service) => {
        const repo = repoOf(buildF18(gitPath(), "t088-tables-over", "reftable"));
        const tables = resolve(repo, git(repo, ["rev-parse", "--git-common-dir"]).trim(), "reftable", "tables.list");
        const head = git(repo, ["rev-parse", "HEAD"]).trim();
        // Git's test switch keeps one table for each transaction. A table line has 43 bytes, so 1600 tables pass 64 KiB.
        const transactions = Array.from({ length: 1600 }, (_, i) => `start\ncreate refs/tags/t088-${i} ${head}\ncommit\n`).join("");
        git(repo, ["update-ref", "--stdin"], { input: Buffer.from(transactions), env: { GIT_TEST_REFTABLE_AUTOCOMPACTION: "false" } });
        expect(statSync(tables).size).toBeGreaterThan(64 * 1024);
        const { repositoryId } = await service.register(repo);
        await read(service, repositoryId, FULL);
        for (let poll = 0; poll < 3; poll++) expect({ poll, full: ranFullRead((await read(service, repositoryId, CHANGES)).calls) }).toEqual({ poll, full: true });
      }),
    TIMEOUT_MS,
  );
});

describe("token invalidation (contract §8 \"Token invalidation\")", () => {
  // Every value of the fields named `key` in `value`, at any depth. Data-model §5 names `comparisonId` and `hunkId`.
  function valuesOf(value: unknown, key: string): unknown[] {
    if (Array.isArray(value)) return value.flatMap((item) => valuesOf(item, key));
    if (typeof value !== "object" || value === null) return [];
    return Object.entries(value).flatMap(([k, item]) => (k === key ? [item, ...valuesOf(item, key)] : valuesOf(item, key)));
  }

  // Issues a hunk token for the unstaged multi.txt entry of F02. `apply` sends the hunk approval with a given generation.
  async function hunkToken(service: Service, repositoryId: string): Promise<{ generation: number; apply: (generation: number) => Promise<ServiceResponse> }> {
    const snapshot = (await service.readWorkspace(repositoryId)).result!;
    const entry = snapshot.entries.find((e) => e.path === "multi.txt" && e.category === "unstaged")!;
    const comparison = await service.request("readComparison", { snapshotId: snapshot.snapshotId, entryId: entry.entryId }, { repositoryId, repositoryGeneration: snapshot.generation, selectionId: crypto.randomUUID() });
    const [comparisonId] = valuesOf(comparison.result, "comparisonId");
    const [hunkId] = valuesOf(comparison.result, "hunkId");
    return {
      generation: snapshot.generation,
      apply: (generation) => service.request("applyHunk", { comparisonId, hunkId, snapshotId: snapshot.snapshotId, direction: "stage" }, { repositoryId, repositoryGeneration: generation }),
    };
  }

  async function withToken(name: string, options: Partial<OpenOptions>, body: (service: Service, repo: string, repositoryId: string) => Promise<void>): Promise<void> {
    const repo = repoOf(buildF02(gitPath(), name));
    const service = await openService({ git: gitPath(), name, ...options });
    try {
      await body(service, repo, (await service.register(repo)).repositoryId);
    } finally {
      await service.dispose();
    }
  }

  caseTest("T075", "a hint and the next readWorkspace invalidate each token whose fingerprint part changed: a ref change that moves HEAD invalidates every token that binds HEAD", W, () =>
    withToken("t075-token-head", {}, async (service, repo, repositoryId) => {
      const token = await hunkToken(service, repositoryId);
      git(repo, ["update-ref", "refs/heads/main", newCommit(repo)]);
      await Bun.sleep(HINT_BUDGET_MS);
      const next = (await service.readWorkspace(repositoryId)).result!;
      expect(next.generation).toBeGreaterThan(token.generation);
      expect((await token.apply(next.generation)).state).not.toBe("succeeded");
    }),
    TIMEOUT_MS,
  );

  caseTest("T075", "a refresh: false read with an unchanged fingerprint keeps an issued hunk token", W, () =>
    withToken("t075-token-kept", { watchHints: false }, async (service, _repo, repositoryId) => {
      const token = await hunkToken(service, repositoryId);
      const next = (await service.readWorkspace(repositoryId, FULL)).result!;
      expect(next.generation).toBe(token.generation);
      expect(outcome(await token.apply(next.generation))).toEqual(SUCCEEDED);
    }),
    TIMEOUT_MS,
  );

  caseTest("T075", "a refresh: false read after an index change invalidates an issued hunk token", W, () =>
    withToken("t075-token-index", { watchHints: false }, async (service, repo, repositoryId) => {
      const token = await hunkToken(service, repositoryId);
      put(repo, "keep.txt", "keep t075\n");
      git(repo, ["add", "--", "keep.txt"]);
      const next = (await service.readWorkspace(repositoryId, FULL)).result!;
      expect(next.generation).toBeGreaterThan(token.generation);
      expect((await token.apply(next.generation)).state).not.toBe("succeeded");
    }),
    TIMEOUT_MS,
  );

  caseTest("T075", "a refresh: true read invalidates an issued hunk token without any change", W, () =>
    withToken("t075-token-refresh", { watchHints: false }, async (service, _repo, repositoryId) => {
      const token = await hunkToken(service, repositoryId);
      const next = (await service.readWorkspace(repositoryId, { refresh: true, check: "full" })).result!;
      expect((await token.apply(next.generation)).state).not.toBe("succeeded");
    }),
    TIMEOUT_MS,
  );
});
