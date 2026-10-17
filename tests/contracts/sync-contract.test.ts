// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T019: the feature 003 contract changes (contract Δ1 to Δ11; spec FR-001, FR-002, FR-003, FR-008).

import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import policyFile from "../../src/contracts/git-environment.json";
import wslProcess from "../../src/contracts/wsl-process.json";
import { printOrigin } from "../origin";
import * as channel from "../../src/contracts/channel";
import * as envelope from "../../src/contracts/envelope";
import * as errors from "../../src/contracts/errors";
import { FILE_ACTION_REASONS } from "../../src/contracts/file-action";
import * as limits from "../../src/contracts/limits";
import { isWindows } from "../../src/contracts/native-path";
import * as operations from "../../src/contracts/operations";

printOrigin("../../src/contracts/channel.ts", import.meta.dir);
printOrigin("../../src/contracts/envelope.ts", import.meta.dir);
printOrigin("../../src/contracts/errors.ts", import.meta.dir);
printOrigin("../../src/contracts/file-action.ts", import.meta.dir);
printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/contracts/operations.ts", import.meta.dir);
printOrigin("../../src/contracts/git-environment.json", import.meta.dir);
printOrigin("../../src/contracts/wsl-process.json", import.meta.dir);

// The module namespaces give `undefined` for a missing export, so each case fails on its own before T024.
const L = limits as unknown as Record<string, number>;
const E = errors as unknown as Record<string, readonly string[]> & typeof errors;
const C = envelope as unknown as Record<string, z.ZodType> & typeof envelope;
const P = channel as unknown as Record<string, z.ZodType> & typeof channel;
const O = operations as unknown as Record<string, readonly string[]> & typeof operations;

const KIB = 1024;
const MIB = 1024 * KIB;
const OID = "0123456789abcdef0123456789abcdef01234567";
const OID2 = "89abcdef0123456789abcdef0123456789abcdef";
const DIGEST = "a".repeat(64);
const REPO = isWindows ? "C:\\repo" : "/repo";
const DEST = isWindows ? "D:\\src\\tool" : "/src/tool";
const PLINK = isWindows ? "C:\\Program Files\\PuTTY\\plink.exe" : "/opt/putty/plink";
const CLONE_URL = "https://example.test/team/tool.git";
// git-fetch(1) OUTPUT: the flags of a `--porcelain` line.
const FLAGS = [" ", "+", "-", "t", "*", "!", "="];
const id = () => crypto.randomUUID();
const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;

const NEW_RENDERER = ["readTracking", "reviewSync", "sync", "clone", "connectInTerminal"];
const NEW_SHELL = ["readSyncSettings", "setSshClient", "setDefaultPullAction", "chooseSyncPath", "clearSyncPath", "launchPuttygen"];
const SYNC_PHASES = ["sync-fetch", "sync-merge", "sync-rebase", "sync-push", "sync-continue", "clone", "pageant"];

const request = (operation: string, payload: unknown, target: Record<string, unknown> = {}) => ({ version: 1, sessionId: id(), requestId: id(), operation, ...target, payload });
const check = (value: unknown, side: "renderer" | "service" = "renderer") => {
  const result = envelope.validateRequest(value, side);
  return result.ok ? "ok" : result.code;
};
const repo = () => ({ repositoryId: id() });
const gen = () => ({ repositoryId: id(), repositoryGeneration: 3 });

describe("contract Δ5 bounds", () => {
  test("each new bound has its contract value", () => {
    expect(L.SYNC_FETCH_LISTED_REFS).toBe(1000);
    expect(L.SYNC_REMOTES).toBe(256);
    expect(L.SYNC_LEASE_COMMITS).toBe(100);
    expect(L.TRACKING_COUNT_DISPLAY).toBe(10_000);
    expect(L.SYNC_REFS_RECORDS).toBe(100_000);
    expect(L.SYNC_REFS_BYTES).toBe(32 * MIB);
    expect(L.PAGEANT_READY_MS).toBe(30_000);
    expect(L.CLONE_URL_BYTES).toBe(4096);
    expect(L.KEY_FILE_ENTRIES).toBe(256);
  });

  test("the reused 001 bounds keep their values", () => {
    expect(limits.SUBMODULE_UPDATE_INACTIVITY_MS).toBe(300_000);
    expect(limits.SUBMODULE_UPDATE_CEILING_MS).toBe(4 * 60 * 60 * 1000);
    expect(limits.STALL_NOTICE_MS).toBe(15_000);
    expect(limits.READ_DEADLINE_MS).toBe(30_000);
    expect(limits.APPROVAL_LIFETIME_MS).toBe(60_000);
    expect(limits.UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION).toBe(4 * MIB);
    expect(limits.COMMIT_OUTPUT_TAIL_BYTES).toBe(16 * KIB);
    expect(limits.COMMIT_OUTPUT_TAIL_LINES).toBe(100);
    expect(limits.REF_LISTING_RECORDS).toBe(10_000);
    expect(limits.REF_LISTING_BYTES).toBe(4 * MIB);
  });
});

describe("contract Δ9 codes", () => {
  const CODES = ["SYNC_UNAVAILABLE", "PUSH_REJECTED", "PUTTY_UNAVAILABLE", "DESTINATION_NOT_EMPTY"];

  test("errors.ts holds the four new codes, and each fits a failed or rejected response", () => {
    for (const code of CODES) {
      expect(errors.isErrorCode(code)).toBe(true);
      expect(errors.codeFitsState("failed", code)).toBe(true);
      expect(errors.codeFitsState("rejected", code)).toBe(true);
    }
  });

  test("each new code has exactly its contract reasons", () => {
    expect([...E.SYNC_UNAVAILABLE_REASONS]).toEqual([
      "detached",
      "unborn",
      "no-upstream",
      "remote-missing",
      "no-remotes",
      "local-upstream",
      "several-merge-refs",
      "push-urls",
      "mirror",
      "push-remote-differs",
      "invalid-config",
      "no-lease",
      "ff-only",
      "interactive-rebase",
      "upstream-gone",
      "no-operation",
      "not-rebasing",
      "no-skip-commit",
    ]);
    expect([...E.PUSH_REJECTED_REASONS]).toEqual(["rejected", "stale-lease", "remote-rejected", "remote-failure"]);
    expect([...E.PUTTY_UNAVAILABLE_REASONS]).toEqual(["missing", "unreadable", "version", "exit", "not-ready"]);
    expect([...E.DESTINATION_NOT_EMPTY_REASONS]).toEqual(["not-empty", "file", "other"]);
    expect([...E.PUTTY_PROGRAMS]).toEqual(["plink", "pageant", "puttygen"]);
  });

  test("OUTPUT_LIMIT reason SYNC_REMOTES is the export name of its bound", () => {
    expect([...E.SYNC_OUTPUT_LIMIT_REASONS]).toEqual(["SYNC_REMOTES"]);
    expect(Object.keys(limits)).toContain("SYNC_REMOTES");
    expect(ok(envelope.Completeness, { state: "limited", code: "OUTPUT_LIMIT", reason: "SYNC_REMOTES" })).toBe(true);
  });

  test("the file action reason missing, and readComparison gives the decision resolve", () => {
    expect(FILE_ACTION_REASONS).toContain("missing" as never);
    const comparison = { completeness: { state: "limited", code: "OBJECT_MISSING" }, scope: "index-to-worktree", support: null, remedy: null, objectRemedy: { text: "Fetch." } };
    for (const fileAction of ["resolve", "missing"]) expect(ok(envelope.ReadComparisonResult, { ...comparison, fileAction })).toBe(true);
    expect(ok(envelope.ReadComparisonResult, { ...comparison, fileAction: "blob-proof" })).toBe(false);
  });
});

describe("contract Δ1 operations", () => {
  test("the operation list holds the five renderer operations and the six shell-only settings operations", () => {
    expect(operations.OPERATIONS).toEqual(expect.arrayContaining([...NEW_RENDERER, ...NEW_SHELL]));
  });

  test("the shell answers the six settings operations and never forwards them", () => {
    expect(operations.SHELL_ONLY).toEqual(expect.arrayContaining(NEW_SHELL));
    for (const name of NEW_RENDERER) expect(operations.SHELL_ONLY).not.toContain(name);
    for (const name of NEW_SHELL) expect(check(request(name, {}), "service")).toBe("UNKNOWN_OPERATION");
  });

  test("clone and the settings operations are native-first", () => {
    const names = (envelope.NativeFirstEnvelope.options as readonly { shape: { operation: { value: string } } }[]).map((o) => o.shape.operation.value);
    expect(names).toEqual(expect.arrayContaining(["clone", ...NEW_SHELL]));
    for (const name of ["readTracking", "reviewSync", "sync", "connectInTerminal"]) expect(names).not.toContain(name);
  });
});

describe("contract Δ2 envelope", () => {
  test("MUTATIONS holds sync, and a recovery marker can have kind sync", () => {
    expect(operations.MUTATIONS).toContain("sync" as never);
    expect(operations.MUTATIONS).not.toContain("clone" as never);
    expect(ok(operations.MutationKind, "sync")).toBe(true);
  });

  test("readTracking and reviewSync carry repositoryId and repositoryGeneration", () => {
    for (const [name, payload] of [
      ["readTracking", {}],
      ["reviewSync", { action: "fetch-all" }],
    ] as const) {
      expect(check(request(name, payload, gen()))).toBe("ok");
      expect(check(request(name, payload, gen()), "service")).toBe("ok");
      expect(check(request(name, payload, repo()))).toBe("INVALID_REQUEST");
      expect(check(request(name, payload, { repositoryGeneration: 3 }))).toBe("INVALID_REQUEST");
    }
  });

  test("sync carries repositoryId and no repositoryGeneration", () => {
    const payload = { syncReviewToken: id(), start: true };
    expect(check(request("sync", payload, repo()))).toBe("ok");
    expect(check(request("sync", payload, repo()), "service")).toBe("ok");
    expect(check(request("sync", payload, gen()))).toBe("INVALID_REQUEST");
    expect(check(request("sync", payload))).toBe("INVALID_REQUEST");
  });

  test("connectInTerminal names a sync target with repositoryId and a clone target without one (data-model §11)", () => {
    const payload = { operationId: id() };
    expect(check(request("connectInTerminal", payload, repo()))).toBe("ok");
    expect(check(request("connectInTerminal", payload))).toBe("ok");
    expect(check(request("connectInTerminal", payload, gen()))).toBe("INVALID_REQUEST");
    expect(check(request("connectInTerminal", { operationId: "x" }, repo()))).toBe("INVALID_REQUEST");
  });

  test("clone and the settings operations carry no repositoryId", () => {
    const clone = { url: CLONE_URL, destination: DEST, keyFile: "none" };
    expect(check(request("clone", clone))).toBe("ok");
    expect(check(request("clone", clone, repo()))).toBe("INVALID_REQUEST");
    expect(check(request("readSyncSettings", {}, repo()))).toBe("INVALID_REQUEST");
  });
});

describe("contract Δ3 payloads", () => {
  const review = (payload: unknown) => check(request("reviewSync", payload, gen()));

  test("each reviewSync action form decodes", () => {
    const forms = [
      { action: "fetch" },
      { action: "fetch", remote: "origin" },
      { action: "fetch", remote: "-x" },
      { action: "fetch-all" },
      { action: "pull" },
      { action: "pull", mode: "rebase" },
      { action: "pull", mode: "merge" },
      { action: "integrate", mode: "rebase" },
      { action: "integrate", mode: "merge" },
      { action: "push" },
      { action: "push", destination: { remote: "origin", branch: "feature/x", setUpstream: true } },
      { action: "force-push" },
      { action: "abort" },
      { action: "continue" },
      { action: "skip" },
    ];
    for (const payload of forms) expect(review(payload)).toBe("ok");
  });

  test("a reviewSync form outside the contract gives INVALID_REQUEST", () => {
    const bad = [
      {},
      { action: "prune" },
      { action: "Fetch" },
      { action: "fetch", remote: "" },
      { action: "fetch", remote: "a\u0000b" },
      { action: "fetch", remote: 1 },
      { action: "fetch-all", remote: "origin" },
      { action: "pull", mode: "squash" },
      { action: "pull", mode: null },
      { action: "integrate" },
      { action: "push", destination: { remote: "origin", branch: "main" } },
      { action: "push", destination: { remote: "origin", branch: "", setUpstream: false } },
      { action: "push", destination: { remote: "origin", branch: "main", setUpstream: false, force: true } },
      { action: "force-push", lease: OID },
      { action: "abort", operation: "merging" },
      { action: "skip", mode: "rebase" },
    ];
    for (const payload of bad) expect(review(payload)).toBe("INVALID_REQUEST");
  });

  test("sync takes the token and start true only", () => {
    expect(check(request("sync", { syncReviewToken: id(), start: true }, repo()))).toBe("ok");
    for (const start of [false, "true", 1, null]) expect(check(request("sync", { syncReviewToken: id(), start }, repo()))).toBe("INVALID_REQUEST");
    expect(check(request("sync", { syncReviewToken: id() }, repo()))).toBe("INVALID_REQUEST");
    expect(check(request("sync", { syncReviewToken: "x", start: true }, repo()))).toBe("INVALID_REQUEST");
    expect(check(request("sync", { syncReviewToken: id(), start: true, action: "push" }, repo()))).toBe("INVALID_REQUEST");
  });

  test("applyFile takes the direction resolve, and applyHunk does not", () => {
    expect(check(request("applyFile", { comparisonId: id(), snapshotId: id(), direction: "resolve" }, gen()))).toBe("ok");
    expect(check(request("applyFile", { comparisonId: id(), snapshotId: id(), direction: "resolve" }, gen()), "service")).toBe("ok");
    expect(check(request("applyHunk", { comparisonId: id(), hunkId: id(), snapshotId: id(), direction: "resolve" }, gen()))).toBe("INVALID_REQUEST");
  });

  describe("clone", () => {
    const clone = (fields: Record<string, unknown>) => check(request("clone", { url: CLONE_URL, destination: DEST, keyFile: "none", ...fields }));

    test("the renderer form takes url, destination, and keyFile none or picked", () => {
      expect(clone({})).toBe("ok");
      expect(clone({ keyFile: "picked" })).toBe("ok");
      for (const keyFile of ["auto", "", null]) expect(clone({ keyFile })).toBe("INVALID_REQUEST");
      expect(check(request("clone", { url: CLONE_URL, destination: DEST }))).toBe("INVALID_REQUEST");
      expect(clone({ path: DEST })).toBe("INVALID_REQUEST");
    });

    test("the URL holds 1 to 4,096 UTF-8 bytes", () => {
      expect(clone({ url: "u".repeat(4096) })).toBe("ok");
      expect(clone({ url: "u".repeat(4097) })).toBe("INVALID_REQUEST");
      expect(clone({ url: "\u20ac".repeat(1365) })).toBe("ok");
      expect(clone({ url: "\u20ac".repeat(1366) })).toBe("INVALID_REQUEST");
      expect(clone({ url: "" })).toBe("INVALID_REQUEST");
    });

    test("a URL with a control character or a lone surrogate gives INVALID_REQUEST", () => {
      for (const c of ["\u0000", "\t", "\n", "\r", "\u001b", "\u007f", "\u0085", "\u009f", "\ud800"]) expect(clone({ url: `https://example.test/a${c}b` })).toBe("INVALID_REQUEST");
      expect(clone({ url: "-u https://example.test/a b" })).toBe("ok");
    });

    test("the destination is a channel path", () => {
      for (const destination of ["tool", "", 1]) expect(clone({ destination })).toBe("INVALID_REQUEST");
    });

    test("the service form takes url, bootstrapId, and cloneId", () => {
      const service = { url: CLONE_URL, bootstrapId: id(), cloneId: id() };
      expect(check(request("clone", service), "service")).toBe("ok");
      expect(check(request("clone", service))).toBe("INVALID_REQUEST");
      expect(check(request("clone", { url: CLONE_URL, destination: DEST, keyFile: "none" }), "service")).toBe("INVALID_REQUEST");
      expect(check(request("clone", { ...service, destination: DEST }), "service")).toBe("INVALID_REQUEST");
      expect(check(request("clone", { ...service, url: "a\nb" }), "service")).toBe("INVALID_REQUEST");
    });
  });

  test("connectInTerminal takes only an operationId", () => {
    expect(check(request("connectInTerminal", { operationId: id(), target: "origin" }, repo()))).toBe("INVALID_REQUEST");
    expect(check(request("connectInTerminal", {}, repo()))).toBe("INVALID_REQUEST");
  });

  describe("shell-only settings operations", () => {
    test("readSyncSettings and launchPuttygen take an empty payload", () => {
      for (const name of ["readSyncSettings", "launchPuttygen"]) {
        expect(check(request(name, {}))).toBe("ok");
        expect(check(request(name, { path: PLINK }))).toBe("INVALID_REQUEST");
      }
    });

    test("setSshClient takes git or plink", () => {
      for (const kind of ["git", "plink"]) expect(check(request("setSshClient", { kind }))).toBe("ok");
      for (const kind of ["putty", "openssh", "", null]) expect(check(request("setSshClient", { kind }))).toBe("INVALID_REQUEST");
      expect(check(request("setSshClient", { kind: "plink", path: PLINK }))).toBe("INVALID_REQUEST");
    });

    test("setDefaultPullAction takes the five data-model §10 values", () => {
      for (const action of ["pull", "pull-merge", "pull-rebase", "fetch", "fetch-all"]) expect(check(request("setDefaultPullAction", { action }))).toBe("ok");
      for (const action of ["pull-squash", "push", "Pull", "", null]) expect(check(request("setDefaultPullAction", { action }))).toBe("INVALID_REQUEST");
      expect([...(C.DEFAULT_PULL_ACTIONS as unknown as string[])]).toEqual(["pull", "pull-merge", "pull-rebase", "fetch", "fetch-all"]);
    });

    test("chooseSyncPath and clearSyncPath name a key file by worktreeKey and remote, and the other targets by neither", () => {
      for (const name of ["chooseSyncPath", "clearSyncPath"]) {
        for (const target of ["plink", "cloneFolder"]) expect(check(request(name, { target }))).toBe("ok");
        expect(check(request(name, { target: "remoteKey", worktreeKey: DIGEST, remote: "origin" }))).toBe("ok");
        expect(check(request(name, { target: "remoteKey", worktreeKey: DIGEST }))).toBe("INVALID_REQUEST");
        expect(check(request(name, { target: "remoteKey", remote: "origin" }))).toBe("INVALID_REQUEST");
        expect(check(request(name, { target: "plink", remote: "origin" }))).toBe("INVALID_REQUEST");
        expect(check(request(name, { target: "cloneFolder", worktreeKey: DIGEST }))).toBe("INVALID_REQUEST");
        expect(check(request(name, { target: "remoteKey", worktreeKey: "A".repeat(64), remote: "origin" }))).toBe("INVALID_REQUEST");
        expect(check(request(name, { target: "pageant" }))).toBe("INVALID_REQUEST");
        expect(check(request(name, { target: "plink", path: PLINK }))).toBe("INVALID_REQUEST");
      }
    });
  });
});

describe("contract Δ2 progress", () => {
  const event = (phase: string, extra: Record<string, unknown> = {}) => ({ requestId: id(), operationId: id(), state: "running", phase, counters: { percent: 40, remoteIndex: 1, remoteCount: 2 }, stalled: false, ...extra });

  test("the seven phases exist and take percent, remoteIndex, remoteCount, and stalled", () => {
    expect(operations.PHASES).toEqual(expect.arrayContaining(SYNC_PHASES));
    for (const phase of SYNC_PHASES) {
      expect(ok(envelope.ProgressEvent, event(phase))).toBe(true);
      expect(ok(envelope.ProgressEvent, event(phase, { stalled: true, counters: {} }))).toBe(true);
    }
  });

  test("a sync or clone event carries no other counter, no path, and no remote name, URL, or Git text", () => {
    for (const phase of SYNC_PHASES) {
      expect(ok(envelope.ProgressEvent, event(phase, { counters: { objects: 3 } }))).toBe(false);
      expect(ok(envelope.ProgressEvent, event(phase, { path: "origin" }))).toBe(false);
      for (const field of ["remote", "url", "text", "ref"]) expect(ok(envelope.ProgressEvent, event(phase, { [field]: "origin" }))).toBe(false);
    }
  });
});

describe("contract Δ3 results", () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    name: "main",
    invalidUtf8: false,
    objectId: OID,
    upstream: "refs/remotes/origin/main",
    upstreamObjectId: OID2,
    track: { state: "counts", ahead: 2, behind: 3 },
    current: true,
    ...over,
  });

  test("readTracking gives the data-model §1 entries", () => {
    const R = C.ReadTrackingResult;
    expect(ok(R, { entries: [] })).toBe(true);
    expect(ok(R, { entries: [entry(), entry({ name: "gone", track: { state: "gone" }, upstreamObjectId: null, current: false }), entry({ name: "local", upstream: null, upstreamObjectId: null, track: { state: "none" }, current: false })] })).toBe(true);
    expect(ok(R, { entries: [entry(), entry({ name: "b" })] })).toBe(false);
    expect(ok(R, { entries: [entry({ track: { state: "counts", ahead: -1, behind: 0 } })] })).toBe(false);
    expect(ok(R, { entries: [entry({ track: { state: "counts", ahead: 1 } })] })).toBe(false);
    expect(ok(R, { entries: [entry({ upstream: null, upstreamObjectId: null })] })).toBe(false);
    expect(ok(R, { entries: [entry({ track: { state: "none" } })] })).toBe(false);
    expect(ok(R, { entries: [entry({ objectId: "x" })] })).toBe(false);
    expect(ok(R, { entries: [entry({ label: "2 ahead" })] })).toBe(false);
    expect(ok(R, { entries: Array.from({ length: limits.REF_LISTING_RECORDS + 1 }, () => entry({ current: false })) })).toBe(false);
  });

  test("a refused readTracking names its bound or its failure", () => {
    const R = C.ReadTrackingResult;
    for (const reason of ["REF_LISTING_RECORDS", "REF_LISTING_BYTES"]) expect(ok(R, { completeness: { state: "limited", code: "OUTPUT_LIMIT", reason } })).toBe(true);
    expect(ok(R, { completeness: { state: "failed", code: "MALFORMED_GIT_OUTPUT" } })).toBe(true);
  });

  const destination = { remote: "origin", ref: "refs/heads/main", trackingRef: "refs/remotes/origin/main", url: "https://example.test/r.git", setUpstream: false, source: "push-default-branch" };
  const plan = (over: Record<string, unknown> = {}) => ({ remotes: ["origin"], ...over });

  test("reviewSync gives action, plan, and syncReviewToken", () => {
    const R = C.ReviewSyncResult;
    expect(ok(R, { action: "fetch", plan: plan(), syncReviewToken: id() })).toBe(true);
    expect(ok(R, { action: "pull", plan: plan({ upstream: { ref: "refs/remotes/origin/main", objectId: OID }, mode: null }), syncReviewToken: id() })).toBe(true);
    expect(ok(R, { action: "integrate", plan: plan({ upstream: { ref: "refs/remotes/origin/main", objectId: OID }, mode: "rebase" }), syncReviewToken: id() })).toBe(true);
    expect(ok(R, { action: "push", plan: plan({ destination }), syncReviewToken: id() })).toBe(true);
    for (const source of ["remote-push-refspec", "push-default-upstream", "push-default-triangular", "panel"]) {
      expect(ok(R, { action: "push", plan: plan({ destination: { ...destination, source, trackingRef: null } }), syncReviewToken: id() })).toBe(true);
    }
    expect(ok(R, { action: "push", plan: plan({ destination: { ...destination, source: "matching" } }), syncReviewToken: id() })).toBe(false);
    expect(ok(R, { action: "abort", plan: plan({ remotes: [], operationState: "merging" }), syncReviewToken: id() })).toBe(true);
    expect(ok(R, { action: "prune", plan: plan(), syncReviewToken: id() })).toBe(false);
    expect(ok(R, { action: "fetch", plan: plan() })).toBe(false);
  });

  // Data-model §2 names the field `operationState`. Data-model §6: the `sync` result names the mode source, not the plan.
  test("the plan names operationState and holds no modeSource", () => {
    const R = C.ReviewSyncResult;
    expect(ok(R, { action: "continue", plan: plan({ remotes: [], operationState: "rebasing" }), syncReviewToken: id() })).toBe(true);
    expect(ok(R, { action: "abort", plan: plan({ remotes: [], operation: "merging" }), syncReviewToken: id() })).toBe(false);
    expect(ok(R, { action: "abort", plan: plan({ remotes: [], operationState: "cherry-picking" }), syncReviewToken: id() })).toBe(false);
    expect(ok(R, { action: "integrate", plan: plan({ mode: "rebase", modeSource: "payload" }), syncReviewToken: id() })).toBe(false);
  });

  // Contract Δ3 read 8: the skip review names the REBASE_HEAD commit. A commit object above the bound gives a null subject.
  test("a skip review names skippedCommit, and no other action does", () => {
    const R = C.ReviewSyncResult;
    const skip = (skippedCommit: unknown, action = "skip") => ok(R, { action, plan: plan({ remotes: [], operationState: "rebasing", skippedCommit }), syncReviewToken: id() });
    expect(skip({ objectId: OID, subject: "Fix the parser" })).toBe(true);
    expect(skip({ objectId: OID, subject: null })).toBe(true);
    expect(skip({ objectId: OID, subject: "" })).toBe(true);
    expect(skip({ objectId: OID })).toBe(false);
    expect(skip({ objectId: "REBASE_HEAD", subject: null })).toBe(false);
    expect(skip({ objectId: OID, subject: null, shortId: "0123456" })).toBe(false);
    expect(skip(undefined)).toBe(false);
    expect(skip({ objectId: OID, subject: null }, "continue")).toBe(false);
  });

  test("force-push names its lease commits, at most 100, with the exact count", () => {
    const R = C.ReviewSyncResult;
    const commits = (n: number) => Array.from({ length: n }, () => ({ objectId: OID2, subject: "Fix" }));
    const lease = (count: number, n: number) => ({ action: "force-push", plan: plan({ destination, lease: { trackingRef: "refs/remotes/origin/main", expect: OID, count, commits: commits(n) } }), syncReviewToken: id() });
    expect(ok(R, lease(2, 2))).toBe(true);
    expect(ok(R, lease(0, 0))).toBe(true);
    expect(ok(R, lease(20_000, 100))).toBe(true);
    expect(ok(R, lease(101, 101))).toBe(false);
    expect(ok(R, lease(3, 2))).toBe(false);
    expect(ok(R, lease(2, 3))).toBe(false);
  });

  test("push without a destination lists the remotes and gives no token", () => {
    const R = C.ReviewSyncResult;
    const panel = { remotes: ["origin", "fork"], prefill: { remote: "origin", ref: "refs/heads/main" }, setUpstream: true };
    expect(ok(R, { action: "push", plan: plan({ needsDestination: panel }) })).toBe(true);
    expect(ok(R, { action: "push", plan: plan({ needsDestination: { ...panel, prefill: null } }) })).toBe(true);
    expect(ok(R, { action: "push", plan: plan({ needsDestination: panel }), syncReviewToken: id() })).toBe(false);
    expect(ok(R, { action: "fetch", plan: plan({ needsDestination: panel }) })).toBe(false);
    expect(ok(R, { action: "push", plan: plan({ needsDestination: { ...panel, remotes: [] } }) })).toBe(false);
  });

  test("a refused reviewSync names its Δ9 reason or the unmerged count", () => {
    const R = C.ReviewSyncResult;
    for (const reason of [...(E.SYNC_UNAVAILABLE_REASONS ?? []), "SYNC_REMOTES"]) expect(ok(R, { reason })).toBe(true);
    expect(ok(R, { unmerged: 3 })).toBe(true);
    expect(ok(R, { reason: "detached-head" })).toBe(false);
    expect(ok(R, { reason: "stale-lease" })).toBe(false);
  });

  const zero = Object.fromEntries(FLAGS.map((flag) => [flag, 0]));
  const remote = (over: Record<string, unknown> = {}) => ({ name: "origin", state: "succeeded", updates: [{ flag: "+", oldObjectId: OID, newObjectId: OID2, ref: "refs/remotes/origin/main" }], counts: { ...zero, "+": 1 }, outputTail: "", ...over });
  const pushed = { status: "pushed", oldObjectId: OID, newObjectId: OID2, reasonText: null, lease: false, upstreamWritten: false, upstreamNotSet: false, outputTail: "" };

  test("the fetch result of data-model §4", () => {
    const R = C.SyncResult;
    expect([...(C.FETCH_FLAGS as unknown as string[])]).toEqual(FLAGS);
    expect(ok(R, { action: "fetch", fetch: { remotes: [remote()], observed: [] } })).toBe(true);
    expect(ok(R, { action: "fetch-all", fetch: { remotes: [remote(), remote({ name: "fork", state: "not-started", updates: [], counts: zero })], observed: [{ ref: "refs/remotes/origin/x", oldObjectId: null, newObjectId: OID }] } })).toBe(true);
    for (const state of ["failed", "canceled", "deadline"]) expect(ok(R, { action: "fetch", fetch: { remotes: [remote({ state })], observed: [] } })).toBe(true);
    const many = Array.from({ length: limits.SYNC_FETCH_LISTED_REFS }, () => remote().updates[0]);
    expect(ok(R, { action: "fetch", fetch: { remotes: [remote({ updates: many, counts: { ...zero, "+": 4000 } })], observed: [] } })).toBe(true);
    expect(ok(R, { action: "fetch", fetch: { remotes: [remote({ updates: [...many, many[0]] })], observed: [] } })).toBe(false);
    expect(ok(R, { action: "fetch", fetch: { remotes: [remote({ state: "skipped" })], observed: [] } })).toBe(false);
    expect(ok(R, { action: "fetch", fetch: { remotes: [remote({ counts: { "+": 1 } })], observed: [] } })).toBe(false);
    expect(ok(R, { action: "fetch", fetch: { remotes: [remote({ url: "https://example.test" })], observed: [] } })).toBe(false);
  });

  test("the push result of data-model §5", () => {
    const R = C.SyncResult;
    for (const status of ["pushed", "forced", "created", "up-to-date", "rejected", "remote-rejected", "remote-failure", "none"]) {
      expect(ok(R, { action: "push", push: { ...pushed, status } })).toBe(true);
    }
    expect(ok(R, { action: "force-push", push: { ...pushed, status: "rejected", reasonText: "stale info", lease: true, newObjectId: null } })).toBe(true);
    expect(ok(R, { action: "push", push: { ...pushed, status: "accepted" } })).toBe(false);
    expect(ok(R, { action: "fetch", push: pushed })).toBe(false);
    // Contract Δ3 Set upstream: a failed write after a successful push.
    expect(ok(R, { action: "push", push: { ...pushed, status: "created", upstreamNotSet: true }, remedy: { text: "t", command: "& 'git' config" } })).toBe(true);
    const { upstreamNotSet: _omitted, ...withoutFact } = pushed;
    expect(ok(R, { action: "push", push: withoutFact })).toBe(false);
  });

  test("the integration states of data-model §7", () => {
    const R = C.SyncResult;
    const integrations = [
      { state: "none" },
      { state: "up-to-date" },
      { state: "mode-required" },
      { state: "done" },
      { state: "stopped", operation: "rebasing", unmerged: 2 },
      { state: "refused", outputTail: "error: Your local changes would be overwritten\n" },
    ];
    for (const integration of integrations) expect(ok(R, { action: "pull", fetch: { remotes: [remote()], observed: [] }, counts: { ahead: 1, behind: 1 }, integration })).toBe(true);
    for (const action of ["integrate", "abort", "continue", "skip"]) expect(ok(R, { action, integration: { state: "done" } })).toBe(true);
    expect(ok(R, { action: "pull", integration: { state: "stopped", operation: "rebasing" } })).toBe(false);
    expect(ok(R, { action: "pull", integration: { state: "stopped", operation: "cherry-picking", unmerged: 1 } })).toBe(false);
    expect(ok(R, { action: "pull", integration: { state: "conflicted" } })).toBe(false);
    expect(ok(R, { action: "push", integration: { state: "done" } })).toBe(false);
  });

  // Contract Δ3 `sync` "Results and states" and data-model §6.
  test("only a pull or integrate result names the mode source", () => {
    const R = C.SyncResult;
    for (const action of ["pull", "integrate"]) {
      for (const modeSource of ["payload", "branch", "pull", "pull-ff", null]) expect(ok(R, { action, integration: { state: "done" }, modeSource })).toBe(true);
      expect(ok(R, { action, integration: { state: "done" }, modeSource: "default" })).toBe(false);
    }
    for (const action of ["fetch", "fetch-all", "push", "force-push", "abort", "continue", "skip"]) expect(ok(R, { action, modeSource: "payload" })).toBe(false);
  });

  test("a sync result can carry the copyable remedy of its step", () => {
    const R = C.SyncResult;
    const command = "& 'C:\\Git\\cmd\\git.exe' --no-lazy-fetch -C 'C:\\repo' fetch -- 'origin'";
    expect(ok(R, { action: "fetch", fetch: { remotes: [remote({ state: "failed" })], observed: [] }, remedy: { text: "This command runs the step in a terminal.", command } })).toBe(true);
    expect(ok(R, { action: "fetch", remedy: { text: "Run it by hand.", command: null } })).toBe(true);
    expect(ok(R, { action: "fetch", remedy: { text: "", command: null } })).toBe(false);
  });

  test("clone gives the registration result, the destination state, or a refusal", () => {
    const R = C.CloneResult;
    const workspace = { repositoryId: id(), generation: 0, worktreeKey: DIGEST, worktreeRoot: DEST };
    expect(ok(R, workspace)).toBe(true);
    expect(ok(R, { exists: true, empty: false, outputTail: "fatal: ...\n", remedy: { text: "Clone it in a terminal.", command: `& 'git' clone -- '${CLONE_URL}' '${DEST}'` } })).toBe(true);
    expect(ok(R, { exists: false, empty: false, outputTail: "", remedy: { text: "The URL holds user information.", command: null } })).toBe(true);
    for (const reason of ["not-empty", "file", "other"]) expect(ok(R, { reason, path: DEST })).toBe(true);
    expect(ok(R, { reason: "missing", program: "pageant", path: PLINK })).toBe(true);
    expect(ok(R, { reason: "absent", path: DEST })).toBe(false);
    expect(ok(R, { exists: true, outputTail: "" })).toBe(false);
  });

  const settings = {
    sshClient: "plink",
    defaultPullAction: "pull",
    // Feature 004 contract Δ14: the result also carries data-model §13 `switchChoice`.
    switchChoice: "keep",
    plinkPath: PLINK,
    programs: [
      { program: "plink", path: PLINK, present: true },
      { program: "pageant", path: PLINK, present: false },
      { program: "puttygen", path: PLINK, present: true },
    ],
    remoteKeyFiles: [{ worktreeKey: DIGEST, remote: "origin", path: PLINK }],
    defaultCloneFolder: null,
    lastCloneParent: DEST,
  };

  test("the settings operations give the data-model §10 settings or a PuTTY refusal", () => {
    const R = C.SyncSettingsResult;
    expect(ok(R, settings)).toBe(true);
    expect(ok(R, { ...settings, sshClient: "git", plinkPath: null, programs: [], remoteKeyFiles: [], lastCloneParent: null })).toBe(true);
    // Contract Δ3 `readSyncSettings`: the result holds no repository value.
    expect(ok(R, { ...settings, keyProposals: [{ worktreeKey: DIGEST, remote: "origin", value: "C:\\keys\\a.ppk" }] })).toBe(false);
    expect(ok(R, { ...settings, remoteKeyFiles: Array(limits.KEY_FILE_ENTRIES).fill(settings.remoteKeyFiles[0]) })).toBe(true);
    expect(ok(R, { ...settings, remoteKeyFiles: Array(limits.KEY_FILE_ENTRIES + 1).fill(settings.remoteKeyFiles[0]) })).toBe(false);
    expect(ok(R, { ...settings, defaultPullAction: "pull-squash" })).toBe(false);
    expect(ok(R, { ...settings, passphrase: "secret" })).toBe(false);
    for (const reason of E.PUTTY_UNAVAILABLE_REASONS ?? []) expect(ok(R, { reason, program: "plink", path: PLINK })).toBe(true);
    expect(ok(R, { reason: "version", program: "ssh", path: PLINK })).toBe(false);
    expect(ok(R, { reason: "version", program: "plink" })).toBe(false);
  });

  // Data-model §10: one entry each for plink, pageant, and puttygen with a set plinkPath, else none.
  test("programs holds the three PuTTY programs for a set plinkPath, else none", () => {
    const R = C.SyncSettingsResult;
    const [plink, pageant, puttygen] = settings.programs;
    expect(ok(R, { ...settings, programs: [puttygen, plink, pageant] })).toBe(true);
    expect(ok(R, { ...settings, programs: [] })).toBe(false);
    expect(ok(R, { ...settings, programs: [plink, pageant] })).toBe(false);
    expect(ok(R, { ...settings, programs: [plink, pageant, pageant] })).toBe(false);
    expect(ok(R, { ...settings, plinkPath: null })).toBe(false);
    expect(ok(R, { ...settings, plinkPath: null, programs: [] })).toBe(true);
  });
});

describe("contract Δ7 and Δ11 process texts", () => {
  const policies = policyFile.policies as Record<string, { remove: string[]; removePrefixes: string[]; set: Record<string, string>; indexFileVariable: string | null; preserve: string[] }>;

  test("policy remote is network without GIT_PROTOCOL_FROM_USER", () => {
    const { network, remote } = policies;
    expect(remote).toEqual({ ...network!, set: { GIT_TERMINAL_PROMPT: "0" } });
    expect(network!.set.GIT_PROTOCOL_FROM_USER).toBe("0");
  });

  test("policy integrate is remote plus GIT_EDITOR=:", () => {
    const { remote, integrate } = policies;
    expect(integrate).toEqual({ ...remote!, set: { GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: ":" } });
  });

  test("a run frame takes the policies remote and integrate", () => {
    expect(channel.EnvironmentPolicy.options).toEqual(expect.arrayContaining(["remote", "integrate"]));
  });

  test("the WSL wrapper modes remote and integrate", () => {
    expect(wslProcess.wrapper).toContain("read | mutation | remote) ;;");
    expect(wslProcess.wrapper).toContain("integrate) export GIT_EDITOR=: ;;");
    // Both keep the scope after Git exits, as `mutation` does.
    expect(wslProcess.wrapper).toContain("case $mode in probe | read | search) end ;; esac");
  });

  test("the wslFiles mode destination reads lstat, then one directory entry", () => {
    const text = wslProcess.wslFiles.join("\n");
    expect(text).toContain("  destination => sub {");
    expect(text).toContain("lstat($path)");
    expect(text).toContain("readdir");
    for (const result of ["absent", "empty", "not-empty", "file", "other", "error"]) expect(text).toContain(`put('${result}'`);
  });
});

describe("contract Δ6 private requests", () => {
  const call = { callId: id(), operationId: id() };
  const network = { inactivityMs: limits.SUBMODULE_UPDATE_INACTIVITY_MS, ceilingMs: limits.SUBMODULE_UPDATE_CEILING_MS, stallMs: limits.STALL_NOTICE_MS };
  const run = (context: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: "run", ...call, arguments: ["--no-lazy-fetch", "fetch"], environmentPolicy: "remote", limits: network, ...context, ...extra });
  const registered = { contextKind: "registeredOperation", gitInstallationId: id(), repositoryId: id() };
  const clone = { contextKind: "clone", cloneId: id(), gitInstallationId: id() };
  const frame = (value: unknown) => ok(channel.ProcessRequest, value);
  const reply = (value: unknown) => ok(channel.ProcessReply, value);

  test("a registered run takes the policies remote and integrate with the network limits", () => {
    expect(frame(run(registered))).toBe(true);
    expect(frame(run(registered, { environmentPolicy: "integrate" }))).toBe(true);
    expect(frame(run(registered, { environmentPolicy: "upload" }))).toBe(false);
  });

  test("the clone context runs the clone array and takes no repository", () => {
    expect(frame(run(clone, { arguments: ["--no-lazy-fetch", "clone", "--progress", "--no-recurse-submodules", "--", CLONE_URL, DEST] }))).toBe(true);
    expect(ok(channel.ProcessContext, clone)).toBe(true);
    expect(frame(run({ ...clone, repositoryId: id() }))).toBe(false);
    expect(frame(run({ contextKind: "clone", gitInstallationId: id() }))).toBe(false);
  });

  test("destinationFacts names the clone and replies with one destination state", () => {
    expect(frame({ type: "destinationFacts", ...call, cloneId: id() })).toBe(true);
    expect(frame({ type: "destinationFacts", ...call, cloneId: id(), path: DEST })).toBe(false);
    expect(frame({ type: "destinationFacts", ...call })).toBe(false);
    for (const result of ["absent", "empty", "not-empty", "file", "other"]) expect(reply({ type: "destinationFacts", callId: call.callId, result })).toBe(true);
    for (const code of channel.FILE_FACT_ERRORS) expect(reply({ type: "destinationFacts", callId: call.callId, result: "error", code })).toBe(true);
    expect(reply({ type: "destinationFacts", callId: call.callId, result: "error" })).toBe(false);
    expect(reply({ type: "destinationFacts", callId: call.callId, result: "empty", code: "io-error" })).toBe(false);
    expect(reply({ type: "destinationFacts", callId: call.callId, result: "link" })).toBe(false);
  });

  test("pageant names a repository and remote, or a clone, and replies none, ready, or failed with the program and path", () => {
    expect(frame({ type: "pageant", ...call, repositoryId: id(), remote: "origin" })).toBe(true);
    expect(frame({ type: "pageant", ...call, cloneId: id() })).toBe(true);
    expect(frame({ type: "pageant", ...call, repositoryId: id(), remote: "origin", cloneId: id() })).toBe(false);
    expect(frame({ type: "pageant", ...call, repositoryId: id() })).toBe(false);
    expect(frame({ type: "pageant", ...call, cloneId: id(), path: PLINK })).toBe(false);
    for (const result of ["git", "none", "ready"]) expect(reply({ type: "pageant", callId: call.callId, result })).toBe(true);
    expect(reply({ type: "pageant", callId: call.callId, result: "plink" })).toBe(false);
    for (const reason of E.PUTTY_UNAVAILABLE_REASONS ?? []) expect(reply({ type: "pageant", callId: call.callId, result: "failed", reason, program: "pageant", path: PLINK })).toBe(true);
    expect(reply({ type: "pageant", callId: call.callId, result: "failed", reason: "exit" })).toBe(false);
    expect(reply({ type: "pageant", callId: call.callId, result: "ready", program: "pageant", path: PLINK })).toBe(false);
  });

  test("terminal names the Git, the repository of a sync target, and the target, and replies started or failed", () => {
    const terminal = { type: "terminal", ...call, gitInstallationId: id(), target: "origin" };
    expect(frame({ ...terminal, repositoryId: id() })).toBe(true);
    expect(frame({ ...terminal, target: CLONE_URL })).toBe(true);
    expect(frame({ ...terminal, target: "" })).toBe(false);
    expect(frame({ ...terminal, script: "ls-remote" })).toBe(false);
    expect(frame({ ...terminal, worktreeRoot: REPO })).toBe(false);
    expect(reply({ type: "terminal", callId: call.callId, result: "started" })).toBe(true);
    expect(reply({ type: "terminal", callId: call.callId, result: "failed", reason: "missing", program: "plink", path: PLINK })).toBe(true);
    expect(reply({ type: "terminal", callId: call.callId, result: "failed" })).toBe(false);
  });

  test("a started frame of kind sync carries its action and no direction, and only applyFile carries resolve", () => {
    const started = { type: "started", callId: id(), operationId: id(), repositoryId: id(), worktreeRoot: REPO, commonDirectory: `${REPO}${isWindows ? "\\" : "/"}.git` };
    for (const action of C.SYNC_ACTIONS ?? []) expect(ok(channel.MutationRequest, { ...started, kind: "sync", action })).toBe(true);
    expect([...(C.SYNC_ACTIONS ?? [])]).toEqual(["fetch", "fetch-all", "pull", "integrate", "push", "force-push", "abort", "continue", "skip"]);
    expect(ok(channel.MutationRequest, { ...started, kind: "sync" })).toBe(false);
    expect(ok(channel.MutationRequest, { ...started, kind: "sync", action: "prune" })).toBe(false);
    expect(ok(channel.MutationRequest, { ...started, kind: "sync", action: "push", direction: "stage" })).toBe(false);
    for (const kind of ["commit", "updateSubmodules"]) expect(ok(channel.MutationRequest, { ...started, kind, action: "fetch" })).toBe(false);
    expect(ok(channel.MutationRequest, { ...started, kind: "applyFile", direction: "resolve", action: "continue" })).toBe(false);
    expect(ok(channel.MutationRequest, { ...started, kind: "applyFile", direction: "resolve" })).toBe(true);
    expect(ok(channel.MutationRequest, { ...started, kind: "applyHunk", direction: "resolve" })).toBe(false);
    expect(ok(channel.MutationRequest, { ...started, kind: "clone" })).toBe(false);
  });
});
