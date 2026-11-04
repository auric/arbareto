// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 010 T003: the contract changes of the History commit menu (contract Δ1 to Δ3, Δ5, Δ6, Δ9, Δ10; data-model §3, §4, §6).

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { printOrigin } from "../origin";
import * as channel from "../../src/contracts/channel";
import * as envelope from "../../src/contracts/envelope";
import * as errors from "../../src/contracts/errors";
import * as limits from "../../src/contracts/limits";
import * as operations from "../../src/contracts/operations";

printOrigin("../../src/contracts/channel.ts", import.meta.dir);
printOrigin("../../src/contracts/envelope.ts", import.meta.dir);
printOrigin("../../src/contracts/errors.ts", import.meta.dir);
printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/contracts/operations.ts", import.meta.dir);

const L = limits as unknown as Record<string, number | undefined>;
const OID = "a".repeat(40);
const OID2 = "b".repeat(40);
const OID3 = "c".repeat(40);
const OID256 = "d".repeat(64);
const MAIN = "refs/heads/main";
const HEAD = { state: "branch", target: MAIN, oid: OID };
const id = () => crypto.randomUUID();
const ok = (schema: z.ZodType | undefined, value: unknown) => schema?.safeParse(value).success ?? false;
const request = (operation: string, payload: unknown) => ({ version: 1, sessionId: id(), requestId: id(), operation, repositoryId: id(), repositoryGeneration: 3, payload });
const check = (payload: unknown, side: "renderer" | "service" = "renderer") => {
  const result = envelope.validateRequest(request("reviewWorkbench", payload), side);
  return result.ok ? "ok" : result.code;
};
const ACTIONS = ["reset", "create-tag", "cherry-pick", "revert-commit"];
const PHASES = ["reset", "tag", "cherry-pick", "revert-commit"];
const SYNC_PHASES = ["sync-cherry-pick", "sync-revert"];
const NEW_WORKBENCH_REASONS = ["tag-signing", "already-on-branch", "mainline-needed", "not-merge"];
const NEW_SYNC_REASONS = ["nothing-to-commit", "sequence"];
const parent = (oid: string, subject: string | null = "Fix the parser") => ({ oid, subject });

describe("contract Δ1, Δ2, and Δ6 actions, phases, and trust actions", () => {
  test("no new operation name, and MUTATIONS keeps runWorkbench", () => {
    for (const action of ACTIONS) expect<readonly string[]>(operations.OPERATION_NAMES).not.toContain(action);
    expect(operations.MUTATIONS).toContain("runWorkbench");
  });

  test("WORKBENCH_ACTIONS and WORKBENCH_STARTED_ACTIONS gain the four actions", () => {
    expect<readonly string[]>(channel.WORKBENCH_ACTIONS).toEqual(expect.arrayContaining(ACTIONS));
    expect<readonly string[]>(channel.WORKBENCH_STARTED_ACTIONS).toEqual(expect.arrayContaining(ACTIONS));
  });

  test("a started frame of kind workbench names each action, and a frame of kind sync names none", () => {
    const started = { type: "started", callId: id(), operationId: id(), repositoryId: id(), kind: "workbench", worktreeRoot: "//host/repo", commonDirectory: "//host/repo/.git" };
    for (const action of ACTIONS) {
      expect(ok(channel.MutationRequest, { ...started, action })).toBe(true);
      expect(ok(channel.MutationRequest, { ...started, kind: "sync", action })).toBe(false);
    }
    for (const action of ["tag", "revert", "reset-hard"]) expect(ok(channel.MutationRequest, { ...started, action })).toBe(false);
  });

  // Contract Δ6: the trust dialog names reset, tag, cherry-pick, or revert.
  test("TRUST_ACTIONS gains reset, tag, cherry-pick, and revert, and approveTrust takes each", () => {
    const trust = ["reset", "tag", "cherry-pick", "revert"];
    const approve = (action: string) => envelope.validateRequest({ version: 1, sessionId: id(), requestId: id(), operation: "approveTrust", repositoryId: id(), payload: { action } }, "renderer").ok;
    expect<readonly string[]>(channel.TRUST_ACTIONS).toEqual(expect.arrayContaining(trust));
    for (const action of trust) expect(approve(action)).toBe(true);
    for (const action of ["create-tag", "revert-commit"]) expect(approve(action)).toBe(false);
    expect(approve("commit")).toBe(true);
  });

  const event = (phase: string, counters: Record<string, number> = {}, extra: Record<string, unknown> = {}) => ({ requestId: id(), operationId: id(), state: "running", phase, counters, stalled: false, ...extra });
  test("the four action phases carry no counter and no path", () => {
    expect<readonly string[]>(operations.PHASES).toEqual(expect.arrayContaining(PHASES));
    for (const phase of PHASES) {
      expect(ok(envelope.ProgressEvent, event(phase))).toBe(true);
      expect(ok(envelope.ProgressEvent, event(phase, {}, { stalled: true }))).toBe(true);
      for (const counter of ["percent", "fileIndex", "remoteIndex"]) expect(ok(envelope.ProgressEvent, event(phase, { [counter]: 1 }))).toBe(false);
      expect(ok(envelope.ProgressEvent, event(phase, {}, { path: "a.txt" }))).toBe(false);
    }
    expect(ok(envelope.ProgressEvent, event("revert"))).toBe(false);
  });

  test("the sync phases sync-cherry-pick and sync-revert carry only the sync counters", () => {
    expect<readonly string[]>(operations.PHASES).toEqual(expect.arrayContaining(SYNC_PHASES));
    for (const phase of SYNC_PHASES) {
      expect(ok(envelope.ProgressEvent, event(phase, { percent: 40, remoteIndex: 1, remoteCount: 2 }))).toBe(true);
      expect(ok(envelope.ProgressEvent, event(phase, { fileIndex: 1 }))).toBe(false);
      expect(ok(envelope.ProgressEvent, event(phase, {}, { path: "a.txt" }))).toBe(false);
    }
  });
});

describe("contract Δ3 payloads (data-model §3)", () => {
  test("reset takes the target and one of soft, mixed, or hard", () => {
    for (const mode of ["soft", "mixed", "hard"]) {
      expect(check({ action: "reset", target: OID, mode })).toBe("ok");
      expect(check({ action: "reset", target: OID, mode }, "service")).toBe("ok");
    }
    expect(check({ action: "reset", target: OID256, mode: "hard" })).toBe("ok");
    for (const mode of ["keep", "merge", "HARD", "", null]) expect(check({ action: "reset", target: OID, mode })).toBe("INVALID_REQUEST");
    for (const target of ["HEAD~1", OID.slice(0, 12), OID.toUpperCase(), "main"]) expect(check({ action: "reset", target, mode: "mixed" })).toBe("INVALID_REQUEST");
    expect(check({ action: "reset", target: OID })).toBe("INVALID_REQUEST");
    expect(check({ action: "reset", target: OID, mode: "mixed", branch: MAIN })).toBe("INVALID_REQUEST");
  });

  const tag = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({ action: "create-tag", name: "v1.0", target: OID, message: null, ...fields });
  test("create-tag takes a name or null, the target, and a message or null", () => {
    expect(check(tag())).toBe("ok");
    expect(check(tag(), "service")).toBe("ok");
    // Plan.md D3: the open review of the popover.
    expect(check(tag({ name: null }))).toBe("ok");
    expect(check(tag({ message: "Release 1.0\n\nNotes" }))).toBe("ok");
    expect(check(tag({ target: OID256 }))).toBe("ok");
    for (const missing of ["name", "target", "message"]) {
      const { [missing]: _drop, ...rest } = tag();
      expect(check(rest)).toBe("INVALID_REQUEST");
    }
    expect(check(tag({ target: "v0.9" }))).toBe("INVALID_REQUEST");
    expect(check(tag({ annotated: true }))).toBe("INVALID_REQUEST");
  });

  // Data-model §3 `TagName`: the schema refuses only what `tagNameRefusal` gives as INVALID_REQUEST. The service refuses the rest with a reason.
  test("a tag name has 1 to 255 bytes, no NUL, and no control character", () => {
    for (const name of ["", "v1\u0000x", "a\u0001b", "a\nb", "a\u007f", "a\u0085", "a\ud800", "a".repeat(256), "ä".repeat(128)]) expect(check(tag({ name }))).toBe("INVALID_REQUEST");
    for (const name of ["a".repeat(255), "-x", "HEAD", "@", "a..b", "x.lock", "a b", "werkzeug-ä"]) expect(check(tag({ name }))).toBe("ok");
  });

  test("a tag message is strict UTF-8, not blank, and at most MERGE_MESSAGE_BYTES", () => {
    expect(check(tag({ message: "a".repeat(limits.MERGE_MESSAGE_BYTES) }))).toBe("ok");
    expect(check(tag({ message: "a".repeat(limits.MERGE_MESSAGE_BYTES + 1) }))).toBe("INVALID_REQUEST");
    // `ä` is two UTF-8 bytes.
    expect(check(tag({ message: "ä".repeat(limits.MERGE_MESSAGE_BYTES / 2) + "a" }))).toBe("INVALID_REQUEST");
    for (const message of ["", " ", "\t\r\n", "a\u0000b", "a\udc00"]) expect(check(tag({ message }))).toBe("INVALID_REQUEST");
  });

  test("cherry-pick and revert-commit take the commit and a mainline from 1 to 64, or null", () => {
    for (const action of ["cherry-pick", "revert-commit"]) {
      const pick = (fields: Record<string, unknown> = {}) => ({ action, commit: OID, mainline: null, ...fields });
      expect(check(pick())).toBe("ok");
      expect(check(pick(), "service")).toBe("ok");
      expect(check(pick({ commit: OID256 }))).toBe("ok");
      for (const mainline of [1, 2, limits.HISTORY_PARENTS_PER_COMMIT]) expect(check(pick({ mainline }))).toBe("ok");
      for (const mainline of [0, limits.HISTORY_PARENTS_PER_COMMIT + 1, -1, 1.5, "1", true]) expect(check(pick({ mainline }))).toBe("INVALID_REQUEST");
      const { mainline: _drop, ...withoutMainline } = pick();
      expect(check(withoutMainline)).toBe("INVALID_REQUEST");
      expect(check(pick({ commit: "HEAD" }))).toBe("INVALID_REQUEST");
      expect(check(pick({ target: OID }))).toBe("INVALID_REQUEST");
    }
  });
});

describe("contract Δ3 plans (data-model §3)", () => {
  const R = envelope.ReviewWorkbenchResult;
  // `token: null` sends no token.
  const reviewed = (action: string, plan: unknown, token: string | null = id()) => ok(R, { action, plan, ...(token === null ? {} : { workbenchToken: token }) });

  const reset = (fields: Record<string, unknown> = {}) => ({
    target: OID2,
    mode: "mixed",
    branch: MAIN,
    from: OID,
    leave: 2,
    gain: 0,
    reflogOnly: 1,
    forceNote: null,
    trackedChanges: 3,
    ignoredReplaced: 0,
    ...fields,
  });
  test("a reset plan names the target, mode, branch, counts, force note, tracked changes, and ignored files", () => {
    expect(reviewed("reset", reset())).toBe(true);
    expect(reviewed("reset", reset({ mode: "hard", ignoredReplaced: 4 }))).toBe(true);
    expect(reviewed("reset", reset({ forceNote: { trackingRef: "refs/remotes/origin/main" } }))).toBe(true);
    // A target at the branch tip is valid, and nothing leaves.
    expect(reviewed("reset", reset({ target: OID, leave: 0, gain: 0, reflogOnly: 0 }))).toBe(true);
    expect(reviewed("reset", reset({ leave: 0, gain: 5, reflogOnly: 0 }))).toBe(true);
    expect(reviewed("reset", reset(), null)).toBe(false);
    expect(reviewed("reset", reset({ mode: "keep" }))).toBe(false);
    for (const field of ["leave", "gain", "reflogOnly", "trackedChanges", "ignoredReplaced"]) expect(reviewed("reset", reset({ [field]: -1 }))).toBe(false);
    for (const field of ["target", "from"]) expect(reviewed("reset", reset({ [field]: "HEAD" }))).toBe(false);
    expect(reviewed("reset", reset({ forceNote: { trackingRef: "" } }))).toBe(false);
    expect(reviewed("reset", reset({ forceNote: "refs/remotes/origin/main" }))).toBe(false);
  });

  // Data-model §3: `reflogOnly` counts commits that leave. A force note names a ref that holds a commit that leaves. Only Hard replaces ignored files.
  test("a reset plan keeps the count rules of data-model §3", () => {
    expect(reviewed("reset", reset({ leave: 1, reflogOnly: 2 }))).toBe(false);
    expect(reviewed("reset", reset({ leave: 0, reflogOnly: 0, forceNote: { trackingRef: "refs/remotes/origin/main" } }))).toBe(false);
    for (const mode of ["soft", "mixed"]) expect(reviewed("reset", reset({ mode, ignoredReplaced: 1 }))).toBe(false);
  });

  const tagPlan = (fields: Record<string, unknown> = {}) => ({ name: "v1.0", target: OID, annotated: true, signs: { light: false, annotated: false }, ...fields });
  test("a create-tag plan names the tag, the target, the kind, and both signing facts", () => {
    expect(reviewed("create-tag", tagPlan())).toBe(true);
    expect(reviewed("create-tag", tagPlan({ annotated: false }))).toBe(true);
    expect(reviewed("create-tag", tagPlan({ signs: { light: false, annotated: true } }))).toBe(true);
    expect(reviewed("create-tag", tagPlan({ signs: { light: true, annotated: true } }))).toBe(true);
    // `tag.gpgSign` also signs an annotated tag.
    expect(reviewed("create-tag", tagPlan({ signs: { light: true, annotated: false } }))).toBe(false);
    expect(reviewed("create-tag", tagPlan({ signs: { light: false } }))).toBe(false);
    expect(reviewed("create-tag", tagPlan({ target: "v0.9" }))).toBe(false);
    expect(reviewed("create-tag", tagPlan({ name: "" }))).toBe(false);
  });

  // Plan.md D3: a named lightweight review refuses with `tag-signing` when `signs.light` is true.
  test("a named lightweight plan never signs", () => {
    expect(reviewed("create-tag", tagPlan({ annotated: false, signs: { light: true, annotated: true } }))).toBe(false);
  });

  // Plan.md D3: the open review gives the plan with no token, and it never refuses with `tag-signing`.
  test("a create-tag review with name null gives the plan with no token", () => {
    const open = tagPlan({ name: null, annotated: false, signs: { light: true, annotated: true } });
    expect(reviewed("create-tag", open, null)).toBe(true);
    expect(reviewed("create-tag", tagPlan({ name: null, annotated: false }), null)).toBe(true);
    expect(reviewed("create-tag", open)).toBe(false);
    expect(reviewed("create-tag", tagPlan(), null)).toBe(false);
  });

  for (const action of ["cherry-pick", "revert-commit"]) {
    const pick = (fields: Record<string, unknown> = {}) => ({ commit: OID2, parents: [parent(OID)], mainline: null, branch: MAIN, ...fields });
    test(`a ${action} plan names the commit, its parents, the mainline, and the branch`, () => {
      expect(reviewed(action, pick())).toBe(true);
      // Research.md R2 P5 and P12: a root commit has no parent.
      expect(reviewed(action, pick({ parents: [] }))).toBe(true);
      expect(reviewed(action, pick({ parents: [parent(OID, null)] }))).toBe(true);
      expect(reviewed(action, pick({ parents: [parent(OID), parent(OID3)], mainline: 2 }))).toBe(true);
      const most = Array.from({ length: limits.HISTORY_PARENTS_PER_COMMIT }, () => parent(OID));
      expect(reviewed(action, pick({ parents: most, mainline: limits.HISTORY_PARENTS_PER_COMMIT }))).toBe(true);
      expect(reviewed(action, pick({ parents: [...most, parent(OID)], mainline: 1 }))).toBe(false);
      expect(reviewed(action, pick(), null)).toBe(false);
      expect(reviewed(action, pick({ parents: [{ oid: OID }] }))).toBe(false);
      expect(reviewed(action, pick({ parents: [OID] }))).toBe(false);
      expect(reviewed(action, pick({ commit: "HEAD" }))).toBe(false);
    });

    // Data-model §6: a merge needs a mainline, and a commit with one or no parent takes none. The mainline never exceeds the parent count.
    test(`a ${action} plan keeps the mainline rule`, () => {
      expect(reviewed(action, pick({ mainline: 1 }))).toBe(false);
      expect(reviewed(action, pick({ parents: [], mainline: 1 }))).toBe(false);
      expect(reviewed(action, pick({ parents: [parent(OID), parent(OID3)], mainline: null }))).toBe(false);
      expect(reviewed(action, pick({ parents: [parent(OID), parent(OID3)], mainline: 3 }))).toBe(false);
      expect(reviewed(action, pick({ parents: [parent(OID), parent(OID3)], mainline: 0 }))).toBe(false);
    });
  }
});

describe("contract Δ9 reasons (data-model §6)", () => {
  const R = envelope.ReviewWorkbenchResult;
  test("WORKBENCH_UNAVAILABLE gains tag-signing, already-on-branch, mainline-needed, and not-merge", () => {
    expect<readonly string[]>(errors.WORKBENCH_UNAVAILABLE_REASONS).toEqual(expect.arrayContaining(NEW_WORKBENCH_REASONS));
    expect(new Set(errors.WORKBENCH_UNAVAILABLE_REASONS).size).toBe(errors.WORKBENCH_UNAVAILABLE_REASONS.length);
    for (const reason of NEW_WORKBENCH_REASONS.filter((r) => r !== "mainline-needed")) expect(ok(R, { reason })).toBe(true);
  });

  test("the reused reasons of the four actions stay", () => {
    const reused = ["detached", "unborn", "dirty-tree", "name-exists", "invalid-name", "reserved-name", "message-size", "invalid-config", "limit", "path", "unreadable"];
    expect<readonly string[]>(errors.WORKBENCH_UNAVAILABLE_REASONS).toEqual(expect.arrayContaining(reused));
    for (const reason of reused.filter((r) => r !== "name-exists")) expect(ok(R, { reason })).toBe(true);
  });

  // Plan.md D5 read 5: a merge without a mainline gives `mainline-needed` with its parents, so the popover shows the choice.
  test("mainline-needed carries the parents of the merge, and no other refusal carries them", () => {
    const parents = [parent(OID), parent(OID3, null)];
    expect(ok(R, { reason: "mainline-needed", parents })).toBe(true);
    expect(ok(R, { reason: "mainline-needed", parents: Array.from({ length: limits.HISTORY_PARENTS_PER_COMMIT }, () => parent(OID)) })).toBe(true);
    expect(ok(R, { reason: "mainline-needed" })).toBe(false);
    expect(ok(R, { reason: "mainline-needed", parents: [parent(OID)] })).toBe(false);
    expect(ok(R, { reason: "mainline-needed", parents: Array.from({ length: limits.HISTORY_PARENTS_PER_COMMIT + 1 }, () => parent(OID)) })).toBe(false);
    for (const reason of ["not-merge", "limit", "dirty-tree"]) expect(ok(R, { reason, parents })).toBe(false);
    expect(ok(R, { parents })).toBe(false);
  });

  test("name-exists names the tag ref, and the Hard in-the-way refusal lists 100 paths and the rest as more", () => {
    expect(ok(R, { reason: "name-exists", ref: "refs/tags/v1.0" })).toBe(true);
    const paths = (n: number) => Array.from({ length: n }, (_, i) => `p${i}.txt`);
    expect(ok(R, { reason: "untracked-in-way", paths: paths(100), more: 1 })).toBe(true);
    expect(ok(R, { reason: "untracked-in-way", paths: paths(101), more: 0 })).toBe(false);
    expect(ok(R, { unmerged: 2 })).toBe(true);
  });

  // Contract Δ3: Abort and Continue of a cherry-pick or a revert refuse with these reasons.
  test("SYNC_UNAVAILABLE gains nothing-to-commit and sequence, and not-rebasing stays", () => {
    expect<readonly string[]>(errors.SYNC_UNAVAILABLE_REASONS).toEqual(expect.arrayContaining([...NEW_SYNC_REASONS, "not-rebasing"]));
    expect(new Set(errors.SYNC_UNAVAILABLE_REASONS).size).toBe(errors.SYNC_UNAVAILABLE_REASONS.length);
    for (const reason of NEW_SYNC_REASONS) expect(ok(envelope.ReviewSyncResult, { reason })).toBe(true);
  });

  test("the new reasons are no error codes", () => {
    for (const reason of [...NEW_WORKBENCH_REASONS, ...NEW_SYNC_REASONS]) expect(errors.isErrorCode(reason)).toBe(false);
  });
});

describe("contract Δ3 run results (data-model §4)", () => {
  const R = envelope.RunWorkbenchResult;
  const refs = [{ ref: MAIN }];

  test("a reset run names the mode, HEAD, the changed refs, and the tracked changes", () => {
    const run = (fields: Record<string, unknown> = {}) => ({ action: "reset", mode: "hard", head: { ...HEAD, oid: OID2 }, refs, trackedChanges: 0, ...fields });
    expect(ok(R, run())).toBe(true);
    expect(ok(R, run({ mode: "soft", trackedChanges: 4 }))).toBe(true);
    // Data-model §4: a failed step adds the output tail.
    expect(ok(R, run({ refs: [], outputTail: "error: Entry 'a.txt' not uptodate. Cannot merge.\n" }))).toBe(true);
    expect(ok(R, run({ mode: "keep" }))).toBe(false);
    expect(ok(R, run({ trackedChanges: -1 }))).toBe(false);
    const { mode: _drop, ...withoutMode } = run();
    expect(ok(R, withoutMode)).toBe(false);
    expect(ok(R, run({ operationState: "normal" }))).toBe(false);
  });

  test("a create-tag run names HEAD, the changed refs, and the tag, or null when Git made none", () => {
    const run = (fields: Record<string, unknown> = {}) => ({ action: "create-tag", head: HEAD, refs: [{ ref: "refs/tags/v1.0" }], tag: { name: "v1.0", oid: OID3, annotated: true }, ...fields });
    expect(ok(R, run())).toBe(true);
    expect(ok(R, run({ tag: { name: "v1.0", oid: OID, annotated: false } }))).toBe(true);
    // Research.md R2 P8 and P16: Git made no tag. A hook can still write another ref.
    expect(ok(R, run({ refs: [], tag: null, outputTail: "error: gpg failed to sign the data\n" }))).toBe(true);
    expect(ok(R, run({ refs: [{ ref: "refs/heads/hooked" }], tag: null }))).toBe(true);
    expect(ok(R, run({ tag: { name: "v1.0", oid: OID3 } }))).toBe(false);
    expect(ok(R, run({ tag: { name: "", oid: OID3, annotated: true } }))).toBe(false);
    const { tag: _drop, ...withoutTag } = run();
    expect(ok(R, withoutTag)).toBe(false);
  });

  for (const action of ["cherry-pick", "revert-commit"]) {
    test(`a ${action} run names HEAD, the changed refs, the operation state, the unmerged count, and an optional output tail`, () => {
      const run = (fields: Record<string, unknown> = {}) => ({ action, head: { ...HEAD, oid: OID2 }, refs, operationState: "normal", unmerged: 0, ...fields });
      expect(ok(R, run())).toBe(true);
      expect(ok(R, run({ refs: [], operationState: action === "cherry-pick" ? "cherry-picking" : "reverting", unmerged: 2 }))).toBe(true);
      expect(ok(R, run({ refs: [], operationState: "cherry-picking", unmerged: 0, outputTail: "The previous cherry-pick is now empty\n" }))).toBe(true);
      expect(ok(R, run({ operationState: "picking" }))).toBe(false);
      const { unmerged: _drop, ...withoutUnmerged } = run();
      expect(ok(R, withoutUnmerged)).toBe(false);
      expect(ok(R, run({ stash: null }))).toBe(false);
    });
  }

  // Contract Δ3: RUN_ACTIONS gains the four actions, so an unknown outcome names any of them.
  test("an unknown outcome names each of the four actions", () => {
    for (const action of ACTIONS) expect(ok(R, { action })).toBe(true);
    expect(ok(R, { action: "tag" })).toBe(false);
  });
});

describe("contract Δ3 reviewSync and sync (003 Δ3)", () => {
  test("SyncPlan.operationState widens to cherry-picking and reverting", () => {
    const R = envelope.ReviewSyncResult;
    for (const operationState of ["merging", "rebasing", "cherry-picking", "reverting"]) {
      for (const action of ["abort", "continue"]) expect(ok(R, { action, plan: { remotes: [], operationState }, syncReviewToken: id() })).toBe(true);
    }
    for (const operationState of ["sequencer-active", "normal", "conflicted", "unknown"]) expect(ok(R, { action: "abort", plan: { remotes: [], operationState }, syncReviewToken: id() })).toBe(false);
  });

  // Plan.md D6 `integrationOf`: Abort and Continue can leave a stopped cherry-pick or revert. A pull stops only in a merge or a rebase.
  test("a stopped Abort or Continue names cherry-picking or reverting", () => {
    const R = envelope.SyncResult;
    for (const operation of ["cherry-picking", "reverting"]) {
      for (const action of ["abort", "continue"]) expect(ok(R, { action, integration: { state: "stopped", operation, unmerged: 0 } })).toBe(true);
      for (const action of ["pull", "integrate"]) expect(ok(R, { action, integration: { state: "stopped", operation, unmerged: 1 } })).toBe(false);
    }
    expect(ok(R, { action: "continue", integration: { state: "stopped", operation: "sequencer-active", unmerged: 0 } })).toBe(false);
  });
});

describe("contract Δ5 bounds", () => {
  test("the actions reuse the existing bounds, and no new limit exists", () => {
    expect(L.HISTORY_PARENTS_PER_COMMIT).toBe(64);
    expect(L.MERGE_MESSAGE_BYTES).toBe(8 * 1024);
    expect(L.DISCARD_CHECK_PATHS).toBe(20_000);
    expect(L.WINDOWS_COMMAND_LINE_UNITS).toBe(32_767);
    expect(L.DIAGNOSTIC_RETAINED_BYTES_PER_STREAM).toBe(64 * 1024);
    for (const name of ["TAG_NAME_BYTES", "TAG_MESSAGE_BYTES", "MAINLINE_MAX", "RESET_PATHS"]) expect(L[name]).toBeUndefined();
  });
});

// Contract Δ10: the vectors of each payload, plan, run result, phase, and reason. `src-tauri/src/schema.rs` reads the same files.
describe("contract Δ10 vectors", () => {
  const ROOT = join(import.meta.dir, "..", "vectors");
  const read = (kind: "valid" | "invalid") =>
    readdirSync(join(ROOT, kind))
      .filter((name) => name.startsWith("commit-") && name.endsWith(".json"))
      .map((name) => ({ name, ...(JSON.parse(readFileSync(join(ROOT, kind, name), "utf8")) as { schema: string; text: string; expected: string }) }))
      .map((v) => ({ ...v, value: JSON.parse(v.text) as Record<string, unknown> }));
  const valid = read("valid");
  const invalid = read("invalid");
  const of = (list: typeof valid, schema: string) => list.filter((v) => v.schema === schema).map((v) => v.value);
  const payloads = (list: typeof valid) => of(list, "renderer-envelope").filter((v) => v.operation === "reviewWorkbench").map((v) => v.payload as Record<string, unknown>);

  test("each payload, plan, and run result has a valid vector", () => {
    expect(payloads(valid).map((p) => p.action)).toEqual(expect.arrayContaining(ACTIONS));
    expect(payloads(valid).some((p) => p.action === "create-tag" && p.name === null)).toBe(true);
    expect(payloads(valid).some((p) => p.action === "create-tag" && typeof p.message === "string")).toBe(true);
    expect(of(valid, "review-workbench-result").map((v) => v.action)).toEqual(expect.arrayContaining(ACTIONS));
    expect(of(valid, "review-workbench-result").some((v) => v.action === "create-tag" && v.workbenchToken === undefined)).toBe(true);
    expect(of(valid, "run-workbench-result").map((v) => v.action)).toEqual(expect.arrayContaining(ACTIONS));
  });

  test("each phase and started action has a valid vector, and the sync phases too", () => {
    expect(of(valid, "progress").map((v) => v.phase)).toEqual(expect.arrayContaining([...PHASES, ...SYNC_PHASES]));
    expect(of(invalid, "progress").map((v) => v.phase)).toEqual(expect.arrayContaining(["reset", "sync-revert"]));
    expect(of(valid, "mutation-request").map((v) => v.action)).toEqual(expect.arrayContaining(ACTIONS));
    expect(of(invalid, "mutation-request").map((v) => v.action)).toContain("reset");
  });

  test("each new reason has a valid vector", () => {
    expect(of(valid, "review-workbench-result").map((v) => v.reason)).toEqual(expect.arrayContaining(NEW_WORKBENCH_REASONS));
    expect(of(valid, "review-sync-result").map((v) => v.reason)).toEqual(expect.arrayContaining(NEW_SYNC_REASONS));
    expect(of(valid, "review-sync-result").map((v) => (v.plan as { operationState?: string } | undefined)?.operationState)).toEqual(expect.arrayContaining(["cherry-picking", "reverting"]));
  });

  test("the invalid vectors hold a mode outside the enum, a mainline of 0 and of 65, a tag name with NUL, and a message above 8 KiB", () => {
    const bad = payloads(invalid);
    expect(bad.some((p) => p.action === "reset" && !["soft", "mixed", "hard"].includes(p.mode as string))).toBe(true);
    for (const mainline of [0, 65]) expect(bad.some((p) => (p.action === "cherry-pick" || p.action === "revert-commit") && p.mainline === mainline)).toBe(true);
    expect(bad.some((p) => p.action === "create-tag" && typeof p.name === "string" && p.name.includes("\u0000"))).toBe(true);
    expect(bad.some((p) => p.action === "create-tag" && typeof p.message === "string" && new TextEncoder().encode(p.message).length > limits.MERGE_MESSAGE_BYTES)).toBe(true);
    for (const v of invalid) expect({ name: v.name, expected: v.expected }).toEqual({ name: v.name, expected: "INVALID_REQUEST" });
  });
});
