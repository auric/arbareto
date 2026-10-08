// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T106: contract §5 "Mutations", §6 "Recovery markers", "Cross-instance exclusion", and "Mutation frames", and §9.

import { describe, expect, test } from "bun:test";
import { createExclusion } from "../../src/git-service/exclusion";
import { RunnerRefusal, type MutationStarted, type StartedReply, type WalkDeadline } from "../../src/git-service/git-runner";
import { printOrigin } from "../origin";

printOrigin("../../src/git-service/exclusion.ts", import.meta.dir);

const COMMON = { volumeSerial: "0".repeat(15) + "1", fileId: "0".repeat(31) + "1" };
const OTHER = { volumeSerial: "0".repeat(15) + "1", fileId: "0".repeat(31) + "2" };
const BUSY_REMEDY = "Another Arbareto window runs a change in this repository. Wait until it ends, then try again.";
const MARKER_REMEDY = "Arbareto could not save its recovery record. Free disk space or restore write access to this folder, then try again.";

type Reply = StartedReply | WalkDeadline;

// A shell double of the three mutation frames. `reply` answers each `started` frame.
function shell(reply: (frame: MutationStarted) => Promise<Reply> | Reply) {
  const frames: string[] = [];
  return {
    frames,
    runner: {
      async started(frame: MutationStarted) {
        frames.push(`started ${frame.operationId} ${frame.kind} ${frame.worktreeRoot} ${frame.commonDirectory}`);
        return reply(frame);
      },
      ended(operationId: string, endProcesses: boolean) {
        frames.push(`ended ${operationId} ${endProcesses}`);
      },
      closeJob(operationId: string) {
        frames.push(`closeJob ${operationId}`);
      },
    },
  };
}

const workspace = (repositoryId: string, commonIdentity = COMMON) => ({ repositoryId, worktreeRoot: `C:\\r\\${repositoryId}`, commonDirectory: "C:\\r\\common\\.git", commonIdentity });
const entry = (repositoryId = crypto.randomUUID(), commonIdentity = COMMON) => ({ operationId: crypto.randomUUID(), kind: "applyHunk" as const, workspace: workspace(repositoryId, commonIdentity) });

describe("exclusion (T106)", () => {
  test("the started frame carries the Git-resolved paths, and the marker ID enters the mutation", async () => {
    const { runner, frames } = shell(() => ({ markerId: "m".repeat(8) + "-0000-4000-8000-000000000000" }));
    const exclusion = createExclusion(runner);
    const e = entry();
    const entered = await exclusion.enter(e);
    expect(entered).toMatchObject({ ok: true, markerId: "mmmmmmmm-0000-4000-8000-000000000000" });
    expect(frames).toEqual([`started ${e.operationId} applyHunk ${e.workspace.worktreeRoot} ${e.workspace.commonDirectory}`]);
    expect(exclusion.holds(e.workspace.repositoryId)).toBe(true);
    if (!entered.ok) throw new Error("not entered");
    entered.end(false);
    expect(frames.at(-1)).toBe(`ended ${e.operationId} false`);
    expect(exclusion.holds(e.workspace.repositoryId)).toBe(false);
  });

  test("an overlapping mutation on the same commonIdentity gets BUSY, sends no frame, and queues nothing", async () => {
    const { runner, frames } = shell(() => ({ markerId: crypto.randomUUID() }));
    const exclusion = createExclusion(runner);
    const first = await exclusion.enter(entry());
    expect(first.ok).toBe(true);
    // A linked worktree has its own repositoryId and the same common-directory identity.
    const linked = entry(crypto.randomUUID(), { ...COMMON });
    expect(await exclusion.enter(linked)).toEqual({ ok: false, code: "BUSY" });
    expect(frames.filter((f) => f.startsWith("started"))).toHaveLength(1);
    // Another common directory still enters.
    expect((await exclusion.enter(entry(crypto.randomUUID(), OTHER))).ok).toBe(true);
    // The rejected mutation did not wait: the end of the first one starts nothing.
    if (first.ok) first.end(false);
    expect(frames.filter((f) => f.startsWith("started"))).toHaveLength(2);
    expect((await exclusion.enter(linked)).ok).toBe(true);
  });

  test("a mutation that waits for its started reply also excludes an overlapping one", async () => {
    let answer: (reply: Reply) => void = () => {};
    const { runner } = shell(() => new Promise<Reply>((resolve) => (answer = resolve)));
    const exclusion = createExclusion(runner);
    const pending = exclusion.enter(entry());
    expect(await exclusion.enter(entry())).toEqual({ ok: false, code: "BUSY" });
    answer({ markerId: crypto.randomUUID() });
    expect((await pending).ok).toBe(true);
  });

  test.each<[string, Reply, Record<string, unknown>]>([
    ["busy", { busy: true }, { ok: false, code: "BUSY", remedy: { text: BUSY_REMEDY } }],
    ["a marker failure", { failure: "disk-full", folder: "C:\\data\\recovery" }, { ok: false, code: "RECOVERY_MARKER_FAILED", failure: "disk-full", folder: "C:\\data\\recovery", remedy: { text: MARKER_REMEDY } }],
    ["a walk deadline", { stop: "deadline" }, { ok: false, code: "DEADLINE" }],
  ])("a %s reply refuses, sends closeJob and no ended frame, and releases the exclusion", async (_name, reply, expected) => {
    const { runner, frames } = shell(() => reply);
    const exclusion = createExclusion(runner);
    const e = entry();
    expect(await exclusion.enter(e)).toEqual(expected as never);
    expect(frames.slice(1)).toEqual([`closeJob ${e.operationId}`]);
    expect(exclusion.holds(e.workspace.repositoryId)).toBe(false);
    // The released exclusion admits the next mutation.
    expect(await exclusion.enter(entry())).toMatchObject({ ok: false });
    expect(frames.filter((f) => f.startsWith("started"))).toHaveLength(2);
  });

  test("a refused started frame keeps its code and releases the exclusion", async () => {
    const { runner, frames } = shell(() => Promise.reject(new RunnerRefusal("UNKNOWN_TARGET")));
    const exclusion = createExclusion(runner);
    const e = entry();
    expect(await exclusion.enter(e)).toEqual({ ok: false, code: "UNKNOWN_TARGET" });
    expect(frames.slice(1)).toEqual([`closeJob ${e.operationId}`]);
    expect(exclusion.holds(e.workspace.repositoryId)).toBe(false);
  });

  test("end runs once, so a second end sends no second ended frame", async () => {
    const { runner, frames } = shell(() => ({ markerId: crypto.randomUUID() }));
    const exclusion = createExclusion(runner);
    const entered = await exclusion.enter(entry());
    if (!entered.ok) throw new Error("not entered");
    entered.end(true);
    entered.end(true);
    expect(frames.filter((f) => f.startsWith("ended"))).toEqual([expect.stringMatching(/ true$/)]);
  });
});
