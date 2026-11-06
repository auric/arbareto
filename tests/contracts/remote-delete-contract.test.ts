// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 011 T003: the contract changes of the remote branch delete (contract Δ1 to Δ3, Δ9, Δ10; data-model §1 to §6).

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

const ACTION = "delete-remote-branch";
const OID = "a".repeat(40);
const OID2 = "b".repeat(40);
const OID256 = "d".repeat(64);
const TRACKING = "refs/remotes/origin/feature";
const LOCAL = "refs/heads/feature";
const WORKTREE = "//host/repo-feature";
const NEW_SYNC_REASONS = ["default-branch", "default-unknown", "no-remote-branch", "not-upstream"];
const WORKBENCH_REASONS = ["current-branch", "other-worktree", "head-unresolved", "config-in-include"];
const id = () => crypto.randomUUID();
const ok = (schema: z.ZodType | undefined, value: unknown) => schema?.safeParse(value).success ?? false;
const check = (payload: unknown, side: "renderer" | "service" = "renderer") => {
  const result = envelope.validateRequest({ version: 1, sessionId: id(), requestId: id(), operation: "reviewSync", repositoryId: id(), repositoryGeneration: 3, payload }, side);
  return result.ok ? "ok" : result.code;
};
const field = (value: unknown, ...keys: string[]) => keys.reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], value);

describe("contract Δ1 and Δ2: the action and the phase", () => {
  test("SYNC_ACTIONS gains delete-remote-branch, with no new operation, mutation, or trust action", () => {
    expect<readonly string[]>(channel.SYNC_ACTIONS).toContain(ACTION);
    expect<readonly string[]>(operations.OPERATION_NAMES).not.toContain(ACTION);
    expect(operations.MUTATIONS).toContain("sync");
    expect<readonly string[]>(channel.TRUST_ACTIONS).not.toContain(ACTION);
    expect<readonly string[]>(channel.WORKBENCH_STARTED_ACTIONS).not.toContain(ACTION);
  });

  test("a started frame of kind sync names the action, and a frame of another kind does not", () => {
    const fields = { operationId: id(), repositoryId: id(), kind: "sync", action: ACTION, worktreeRoot: "//host/repo", commonDirectory: "//host/repo/.git" };
    expect(ok(channel.StartedCall, fields)).toBe(true);
    expect(ok(channel.MutationRequest, { type: "started", callId: id(), ...fields })).toBe(true);
    for (const kind of ["workbench", "commit"]) expect(ok(channel.MutationRequest, { type: "started", callId: id(), ...fields, kind })).toBe(false);
    expect(ok(channel.MutationRequest, { type: "started", callId: id(), ...fields, action: "delete-remote" })).toBe(false);
  });

  const event = (phase: string, counters: Record<string, number> = {}, extra: Record<string, unknown> = {}) => ({ requestId: id(), operationId: id(), state: "running", phase, counters, stalled: false, ...extra });
  // Contract Δ2: the local writes report sync-delete-local. update-ref and config print no progress, so the phase carries no counter.
  test("the phase sync-delete-local carries no counter and no path", () => {
    expect<readonly string[]>(operations.PHASES).toContain("sync-delete-local");
    expect(ok(envelope.ProgressEvent, event("sync-delete-local"))).toBe(true);
    expect(ok(envelope.ProgressEvent, event("sync-delete-local", {}, { state: "cancel-requested", stalled: true }))).toBe(true);
    for (const counter of ["percent", "remoteIndex", "remoteCount", "fileIndex"]) expect(ok(envelope.ProgressEvent, event("sync-delete-local", { [counter]: 1 }))).toBe(false);
    expect(ok(envelope.ProgressEvent, event("sync-delete-local", {}, { path: "a.txt" }))).toBe(false);
    // Contract Δ2: the push step and the gone check report the existing phase sync-push.
    expect(ok(envelope.ProgressEvent, event("sync-push", { percent: 40 }))).toBe(true);
    expect(ok(envelope.ProgressEvent, event("sync-delete"))).toBe(false);
  });
});

describe("contract Δ3 reviewSync payload (data-model §1)", () => {
  test("the remote payload names the remote-tracking ref", () => {
    expect(check({ action: ACTION, ref: TRACKING })).toBe("ok");
    expect(check({ action: ACTION, ref: TRACKING }, "service")).toBe("ok");
    // Research.md R2 P19: a branch name with a slash.
    expect(check({ action: ACTION, ref: "refs/remotes/origin/team/feature" })).toBe("ok");
  });

  test("the combined payload adds the local branch", () => {
    expect(check({ action: ACTION, ref: TRACKING, local: LOCAL })).toBe("ok");
    expect(check({ action: ACTION, ref: TRACKING, local: LOCAL }, "service")).toBe("ok");
  });

  test("ref is under refs/remotes/, and local is under refs/heads/", () => {
    for (const ref of ["refs/heads/feature", "refs/remotes/", "origin/feature", "refs/tags/v1", "", 7, null]) expect(check({ action: ACTION, ref })).toBe("INVALID_REQUEST");
    for (const local of ["refs/remotes/origin/feature", "refs/heads/", "feature", "", null]) expect(check({ action: ACTION, ref: TRACKING, local })).toBe("INVALID_REQUEST");
    expect(check({ action: ACTION })).toBe("INVALID_REQUEST");
    expect(check({ action: ACTION, local: LOCAL })).toBe("INVALID_REQUEST");
    for (const extra of [{ remote: "origin" }, { destination: { remote: "origin", branch: "feature", setUpstream: false } }, { lease: true }]) {
      expect(check({ action: ACTION, ref: TRACKING, ...extra })).toBe("INVALID_REQUEST");
    }
  });

  // Data-model §1: `local` with another action is invalid.
  test("ref and local come only with the delete action", () => {
    expect(check({ action: "push" })).toBe("ok");
    for (const action of ["push", "force-push", "fetch"]) {
      expect(check({ action, local: LOCAL })).toBe("INVALID_REQUEST");
      expect(check({ action, ref: TRACKING })).toBe("INVALID_REQUEST");
    }
  });
});

const destination = { remote: "origin", ref: "refs/heads/feature", trackingRef: TRACKING, url: "https://example.test/r.git", setUpstream: false, upstreamRebase: false, source: "tracking-ref" };
const lease = { trackingRef: TRACKING, expect: OID, count: 2, commits: [{ objectId: OID2, subject: "Fix the parser" }, { objectId: OID, subject: null }] };
const planLocal = { ref: LOCAL, oid: OID2, reflogKeeps: true };
const plan = (over: Record<string, unknown> = {}) => ({ remotes: ["origin"], destination, lease, ...over });
// `token: null` sends no token.
const reviewed = (action: string, value: unknown, token: string | null = id()) => ok(envelope.ReviewSyncResult, { action, plan: value, ...(token === null ? {} : { syncReviewToken: token }) });

describe("contract Δ3 plan (data-model §3)", () => {
  test("the plan names the destination with source tracking-ref and the lease", () => {
    expect(reviewed(ACTION, plan())).toBe(true);
    expect(reviewed(ACTION, plan({ lease: { ...lease, count: 0, commits: [] } }))).toBe(true);
    expect(reviewed(ACTION, plan({ lease: { ...lease, expect: OID256 } }))).toBe(true);
    // Plan.md D16: 150 commits that only the branch holds give count 150 and a list of SYNC_LEASE_COMMITS.
    const commits = Array.from({ length: limits.SYNC_LEASE_COMMITS }, () => ({ objectId: OID2, subject: "Fix" }));
    expect(reviewed(ACTION, plan({ lease: { ...lease, count: 150, commits } }))).toBe(true);
    expect(reviewed(ACTION, plan({ lease: { ...lease, count: 150, commits: [...commits, commits[0]] } }))).toBe(false);
    expect(reviewed(ACTION, plan({ destination: { ...destination, source: "remote-tracking" } }))).toBe(false);
  });

  test("a delete plan needs the destination, the lease, and a token", () => {
    const { lease: _lease, ...withoutLease } = plan();
    const { destination: _destination, ...withoutDestination } = plan();
    expect(reviewed(ACTION, withoutLease)).toBe(false);
    expect(reviewed(ACTION, withoutDestination)).toBe(false);
    expect(reviewed(ACTION, plan(), null)).toBe(false);
    const panel = { remotes: ["origin"], prefill: null, setUpstream: false, upstreamRebase: false };
    expect(reviewed(ACTION, plan({ needsDestination: panel }), null)).toBe(false);
  });

  test("the combined plan adds the local ref, its tip, and the reflog fact", () => {
    expect(reviewed(ACTION, plan({ local: planLocal }))).toBe(true);
    expect(reviewed(ACTION, plan({ local: { ...planLocal, reflogKeeps: false } }))).toBe(true);
    expect(reviewed(ACTION, plan({ local: { ...planLocal, oid: OID256 } }))).toBe(true);
    const { reflogKeeps: _reflogKeeps, ...withoutReflog } = planLocal;
    expect(reviewed(ACTION, plan({ local: withoutReflog }))).toBe(false);
    expect(reviewed(ACTION, plan({ local: { ...planLocal, onlyHere: 2 } }))).toBe(false);
    expect(reviewed(ACTION, plan({ local: { ...planLocal, oid: "HEAD" } }))).toBe(false);
    expect(reviewed(ACTION, plan({ local: { ...planLocal, ref: "" } }))).toBe(false);
    expect(reviewed(ACTION, plan({ local: LOCAL }))).toBe(false);
  });

  test("local comes only with the delete action", () => {
    const forced = plan({ destination: { ...destination, source: "push-default-branch" } });
    expect(reviewed("force-push", forced)).toBe(true);
    expect(reviewed("force-push", { ...forced, local: planLocal })).toBe(false);
    expect(reviewed("push", { remotes: ["origin"], destination: forced.destination, local: planLocal })).toBe(false);
    expect(reviewed("fetch", { remotes: ["origin"], local: planLocal })).toBe(false);
  });
});

describe("contract Δ9 reasons (data-model §6)", () => {
  const R = envelope.ReviewSyncResult;
  test("SYNC_UNAVAILABLE gains default-branch, default-unknown, no-remote-branch, and not-upstream", () => {
    expect<readonly string[]>(errors.SYNC_UNAVAILABLE_REASONS).toEqual(expect.arrayContaining(NEW_SYNC_REASONS));
    expect(new Set(errors.SYNC_UNAVAILABLE_REASONS).size).toBe(errors.SYNC_UNAVAILABLE_REASONS.length);
    // Contract Δ3 `SyncRefused`: `remote` comes exactly with `default-branch` and `default-unknown`.
    const named = ["default-branch", "default-unknown"];
    for (const reason of NEW_SYNC_REASONS) expect({ reason, ok: ok(R, named.includes(reason) ? { reason, remote: "origin" } : { reason }) }).toEqual({ reason, ok: true });
    for (const reason of NEW_SYNC_REASONS) expect({ reason, ok: ok(R, named.includes(reason) ? { reason } : { reason, remote: "origin" }) }).toEqual({ reason, ok: false });
  });

  test("the reused sync reasons of the delete review stay", () => {
    for (const reason of ["push-urls", "mirror", "invalid-config", "remote-missing", "unknown-operation"]) expect(ok(R, { reason })).toBe(true);
  });

  test("SyncRefused carries the four workbench reasons of the combined review, and no other workbench reason", () => {
    expect<readonly string[]>(errors.WORKBENCH_UNAVAILABLE_REASONS).toEqual(expect.arrayContaining(WORKBENCH_REASONS));
    for (const reason of WORKBENCH_REASONS) expect(ok(R, { reason })).toBe(true);
    for (const reason of ["dirty-tree", "name-exists", "locked", "main-worktree"]) expect(ok(R, { reason })).toBe(false);
  });

  // `heldElsewhere` and `unresolvedRefusal` (`workbench-review.ts`) name the worktree for these two reasons.
  test("worktree names a channel path, and only with other-worktree or head-unresolved", () => {
    for (const reason of ["other-worktree", "head-unresolved"]) expect(ok(R, { reason, worktree: WORKTREE })).toBe(true);
    for (const reason of ["current-branch", "config-in-include", "mirror", "default-branch"]) expect(ok(R, { reason, worktree: WORKTREE })).toBe(false);
    expect(ok(R, { worktree: WORKTREE })).toBe(false);
    for (const worktree of ["", "repo-feature", "//host/a\u0000b", 7]) expect(ok(R, { reason: "other-worktree", worktree })).toBe(false);
  });

  test("the new reasons are no error codes, and the reused codes exist", () => {
    for (const reason of NEW_SYNC_REASONS) expect(errors.isErrorCode(reason)).toBe(false);
    const reused = ["SYNC_UNAVAILABLE", "WORKBENCH_UNAVAILABLE", "UNKNOWN_TARGET", "OPERATION_IN_PROGRESS", "STALE_REVIEW", "APPROVAL_EXPIRED", "PUSH_REJECTED", "GIT_FAILED", "MALFORMED_GIT_OUTPUT", "INVALID_REQUEST"];
    for (const code of reused) expect(errors.isErrorCode(code)).toBe(true);
  });
});

describe("contract Δ3 sync result (data-model §4 and §5)", () => {
  const R = envelope.SyncResult;
  const push = (over: Record<string, unknown> = {}) => ({ status: "deleted", oldObjectId: OID, newObjectId: null, reasonText: null, lease: true, upstreamWritten: false, upstreamNotSet: false, outputTail: "", ...over });
  const stale = push({ status: "rejected", newObjectId: OID, reasonText: "stale info" });
  const gone = push({ status: "rejected", reasonText: "stale info" });
  const result = (over: Record<string, unknown> = {}) => ({ action: ACTION, push: push(), ...over });

  test("PushResult.status gains deleted, and the delete result carries the push", () => {
    expect(ok(R, result())).toBe(true);
    for (const status of ["rejected", "remote-rejected", "remote-failure", "none"]) expect(ok(R, result({ push: push({ status }) }))).toBe(true);
    expect(ok(R, result({ push: push({ status: "removed" }) }))).toBe(false);
    expect(ok(R, result({ fetch: { remotes: [], observed: [] } }))).toBe(false);
    // An unknown outcome names the action alone.
    expect(ok(R, { action: ACTION })).toBe(true);
  });

  test("each row of data-model §5 has its result form", () => {
    expect(ok(R, result())).toBe(true);
    expect(ok(R, result({ localNotDeleted: true }))).toBe(true);
    const remedy = { text: "This command fetches origin and removes the remote-tracking branches whose remote branch is gone.", command: "& 'git' --no-lazy-fetch -C 'repo' fetch --prune -- 'origin'" };
    expect(ok(R, result({ push: stale, reason: "stale-lease", remedy }))).toBe(true);
    expect(ok(R, result({ push: gone, remoteGone: true }))).toBe(true);
    expect(ok(R, result({ push: gone, remoteGone: true, localNotDeleted: true }))).toBe(true);
    for (const reason of errors.PUSH_REJECTED_REASONS) expect(ok(R, result({ push: stale, reason }))).toBe(true);
  });

  test("remoteGone and localNotDeleted are true or absent", () => {
    for (const value of [false, "true", 1, null]) {
      expect(ok(R, result({ push: gone, remoteGone: value }))).toBe(false);
      expect(ok(R, result({ localNotDeleted: value }))).toBe(false);
    }
  });

  test("remoteGone and localNotDeleted come only with the delete action", () => {
    const pushed = push({ status: "pushed", newObjectId: OID2, lease: false });
    expect(ok(R, { action: "push", push: pushed })).toBe(true);
    for (const action of ["push", "force-push"]) {
      expect(ok(R, { action, push: pushed, remoteGone: true })).toBe(false);
      expect(ok(R, { action, push: pushed, localNotDeleted: true })).toBe(false);
    }
    for (const action of ["fetch", "pull", "abort"]) {
      expect(ok(R, { action, remoteGone: true })).toBe(false);
      expect(ok(R, { action, localNotDeleted: true })).toBe(false);
    }
  });
});

// Contract Δ10. `tests/contracts/vectors.test.ts` checks each file against its schema.
describe("contract Δ10 vectors", () => {
  const ROOT = join(import.meta.dir, "..", "vectors");
  const read = (kind: "valid" | "invalid") =>
    readdirSync(join(ROOT, kind))
      .filter((name) => name.startsWith("remote-delete-") && name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(ROOT, kind, name), "utf8")) as { schema: string; text: string; expected: string })
      .map((v) => ({ ...v, value: JSON.parse(v.text) as Record<string, unknown> }));
  const valid = read("valid");
  const invalid = read("invalid");
  const of = (list: typeof valid, schema: string) => list.filter((v) => v.schema === schema).map((v) => v.value);
  const payloads = (list: typeof valid) => of(list, "renderer-envelope").filter((v) => v.operation === "reviewSync").map((v) => v.payload as Record<string, unknown>);

  test("the remote payload, the combined payload, and a plan with local have valid vectors", () => {
    expect(payloads(valid).some((p) => p.action === ACTION && p.local === undefined)).toBe(true);
    expect(payloads(valid).some((p) => p.action === ACTION && typeof p.local === "string")).toBe(true);
    expect(of(valid, "review-sync-result").some((v) => v.action === ACTION && field(v, "plan", "local") !== undefined && field(v, "plan", "destination", "source") === "tracking-ref")).toBe(true);
  });

  test("results with deleted, remoteGone, localNotDeleted, and both flags have valid vectors", () => {
    const results = of(valid, "sync-result").filter((v) => v.action === ACTION);
    expect(results.some((v) => field(v, "push", "status") === "deleted" && v.localNotDeleted === undefined)).toBe(true);
    expect(results.some((v) => v.remoteGone === true && v.localNotDeleted === undefined)).toBe(true);
    expect(results.some((v) => v.localNotDeleted === true && v.remoteGone === undefined)).toBe(true);
    expect(results.some((v) => v.remoteGone === true && v.localNotDeleted === true)).toBe(true);
  });

  test("the invalid vectors hold local with push, remoteGone with push, and a delete plan without lease, each as the only fault", () => {
    for (const v of invalid) expect(v.expected).toBe("INVALID_REQUEST");
    const local = payloads(invalid).find((p) => p.action === "push" && "local" in p);
    const { local: _local, ...pushPayload } = local ?? {};
    expect(local === undefined ? "absent" : check(pushPayload)).toBe("ok");
    const gone = of(invalid, "sync-result").find((v) => v.action === "push" && v.remoteGone === true);
    const { remoteGone: _gone, ...pushResult } = gone ?? {};
    expect(gone !== undefined && ok(envelope.SyncResult, pushResult)).toBe(true);
    const bare = of(invalid, "review-sync-result").find((v) => v.action === ACTION && field(v, "plan", "lease") === undefined);
    expect(bare !== undefined && ok(envelope.ReviewSyncResult, { ...bare, plan: { ...(bare.plan as object), lease } })).toBe(true);
  });
});
