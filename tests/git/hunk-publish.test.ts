// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T110: the pure decisions of `applyHunk` (contract §4, §8, §9). No Git process runs.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvironmentPolicy, GitRunner } from "../../src/git-service/git-runner";
import type { CandidateFailure } from "../../src/git-service/hunk-candidate";
import {
  candidateRefusal,
  checkpointRefusal,
  diagnosticCause,
  FILE_ID_TEXT,
  lingeringSentence,
  lockRefusal,
  publishRefusal,
  recording,
  removeOwned,
  SPLIT_INDEX_TEXT,
  STEP_FAILED_TEXT,
  type CheckpointBinding,
  type PolicyObservation,
  type StateObservation,
} from "../../src/git-service/hunk-publish";
import { LOCKED_REMEDY } from "../../src/git-service/index-lock";
import type { WorkingVersion } from "../../src/git-service/snapshot";
import type { ConfigEntry } from "../../src/git-service/trust";
import { printOrigin } from "../origin";

printOrigin("../../src/git-service/hunk-publish.ts", import.meta.dir);

const HEX = (c: string) => c.repeat(64);
const LOCK = "C:/repo/.git/index.lock";
const REVOKE = "Revoke trust also ends them.";

describe("lockRefusal (contract §4 \"Windows lock ownership\", §9 \"Lingering count\")", () => {
  const locked = { ok: false as const, code: "LOCKED" as const, path: LOCK, remedy: { text: LOCKED_REMEDY } };
  test.each([
    [0, false, LOCKED_REMEDY],
    [0, true, LOCKED_REMEDY],
    [null, true, LOCKED_REMEDY],
    [1, false, `${LOCKED_REMEDY} Arbareto still runs 1 process that Git or a hook started in this repository. Closing Arbareto ends them.`],
    [1, true, `${LOCKED_REMEDY} Arbareto still runs 1 process that Git or a hook started in this repository. Closing Arbareto ends them. ${REVOKE}`],
    [2, false, `${LOCKED_REMEDY} Arbareto still runs 2 processes that Git or a hook started in this repository. Closing Arbareto ends them.`],
    [2, true, `${LOCKED_REMEDY} Arbareto still runs 2 processes that Git or a hook started in this repository. Closing Arbareto ends them. ${REVOKE}`],
  ])("LOCKED with lingering count %p and trust ID %p", (count, trustId, text) => {
    expect(lockRefusal(locked, count, trustId)).toEqual({ code: "LOCKED", path: LOCK, remedy: { text } });
  });

  test("lingeringSentence uses the singular for 1", () => {
    expect([lingeringSentence(1), lingeringSentence(3)].map((s) => s.split(" that ")[0])).toEqual(["Arbareto still runs 1 process", "Arbareto still runs 3 processes"]);
  });

  test("file-id refuses with its text, and a lock that can remain is foreign", () => {
    expect(lockRefusal({ ok: false, reason: "file-id", path: LOCK, removed: true }, null, false)).toEqual({ code: "UNSUPPORTED_HUNK_PROFILE", reason: "file-id", remedy: { text: FILE_ID_TEXT } });
    expect(lockRefusal({ ok: false, reason: "file-id", path: LOCK, removed: false }, null, false)).toEqual({ code: "UNSUPPORTED_HUNK_PROFILE", reason: "file-id", remedy: { text: FILE_ID_TEXT }, foreign: [LOCK] });
  });

  test("another create failure is a failed file step with the cause lock-create", () => {
    expect(lockRefusal({ ok: false, reason: "create-failed", errno: "EACCES", path: LOCK }, null, false)).toEqual({ code: "GIT_FAILED", cause: "lock-create", remedy: { text: STEP_FAILED_TEXT } });
  });
});

describe("candidateRefusal (research R3 steps 6 to 10, contract §9)", () => {
  const step = { code: "GIT_FAILED", remedy: { text: STEP_FAILED_TEXT } };
  const cases: [CandidateFailure, unknown][] = [
    [{ reason: "canceled" }, { stop: "canceled" }],
    [{ reason: "deadline", step: "apply" }, { stop: "deadline" }],
    [{ reason: "refused", code: "PROCESS_OWNERSHIP_FAILED" }, { code: "PROCESS_OWNERSHIP_FAILED" }],
    [{ reason: "split-index" }, { code: "UNSUPPORTED_HUNK_PROFILE", reason: "split-index", remedy: { text: SPLIT_INDEX_TEXT } }],
    [{ reason: "index-changed" }, { code: "STALE_SELECTION" }],
    [{ reason: "bound" }, { code: "OUTPUT_LIMIT", reason: "MUTATION_RAW_INDEX_BYTES" }],
    [{ reason: "object-missing" }, { check: "object-missing" }],
    [{ reason: "git-failed", step: "apply", exitCode: 1 }, { check: "git-failed" }],
    [{ reason: "unavailable", errno: "EBUSY" }, { ...step, cause: "candidate-copy" }],
    [{ reason: "candidate-time", canonicalNs: 1n, candidateNs: 2n }, { ...step, cause: "candidate-time" }],
    [{ reason: "verification", detail: "content" }, { ...step, cause: "verification" }],
    [{ reason: "malformed", step: "patch" }, { code: "MALFORMED_GIT_OUTPUT" }],
    [{ reason: "output-limit", step: "apply" }, { code: "OUTPUT_LIMIT", reason: "UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION", cause: "OUTPUT_LIMIT" }],
  ];
  test.each(cases)("%p", (failure, expected) => {
    expect(candidateRefusal(failure)).toEqual(expected as never);
  });
});

describe("publishRefusal (research R3 step 13, contract §9)", () => {
  const step = { code: "GIT_FAILED", remedy: { text: STEP_FAILED_TEXT } };
  test.each([
    [{ published: false, reason: "notOwned" }, { code: "STALE_SELECTION", path: LOCK }],
    [{ published: false, reason: "time" }, { ...step, cause: "publish-time" }],
    [{ published: false, reason: "publish-time", errno: "EPERM" }, { ...step, cause: "publish-time" }],
    [{ published: false, reason: "write-failed", errno: null }, { ...step, cause: "write" }],
    [{ published: false, reason: "replace-failed", errno: "EACCES" }, { ...step, cause: "replace" }],
  ] as const)("%p", (result, expected) => {
    expect(publishRefusal(result, LOCK)).toEqual(expected as never);
  });
});

describe("diagnosticCause (contract §8, §9)", () => {
  test("a failed reconciliation observation names its code, also after a failed write step", () => {
    expect(diagnosticCause("MALFORMED_GIT_OUTPUT", { cause: "write" }, "DEADLINE")).toBe("MALFORMED_GIT_OUTPUT");
  });
  test("otherwise the failed-step cause, then the recorded DEADLINE or OUTPUT_LIMIT cause", () => {
    expect([diagnosticCause(null, { cause: "write" }, "DEADLINE"), diagnosticCause(null, {}, "DEADLINE"), diagnosticCause(null, null, "OUTPUT_LIMIT"), diagnosticCause(null, null, undefined)]).toEqual(["write", "DEADLINE", "OUTPUT_LIMIT", undefined]);
  });
});

describe("checkpointRefusal (contract §4, §9)", () => {
  const working: WorkingVersion = { path: new TextEncoder().encode("a.txt"), exists: true, type: "file", mode: 0o100644, size: 4, rawDigest: HEX("3"), normalized: null };
  const head = { state: "branch" as const, target: "refs/heads/main", oid: "a".repeat(40) };
  const binding: CheckpointBinding = {
    head,
    index: { digest: HEX("1"), rawIndexDigest: null, sharedIndex: null },
    working,
    attributes: { text: "auto" },
    policyFingerprint: HEX("4"),
    operationState: "normal",
  };
  const entry = (key: string, value: string) => ({ key, value, scope: "local", origin: "file:.git/config", exact: true, originBytes: new Uint8Array(), keyValueBytes: new Uint8Array() }) as ConfigEntry;
  const listing = (entries: ConfigEntry[] = []) => ({ entries, hooks: { configured: [], folder: [], fatal: false } });
  const policy = (fields: Partial<Extract<PolicyObservation, { listing: unknown }>> = {}): PolicyObservation => ({ listing: listing(), gate: null, policyFingerprint: HEX("4"), attributes: { value: { text: "auto" } }, ...fields });
  const state = (fields: Partial<StateObservation> = {}): StateObservation => ({
    head: { value: head },
    index: { value: { raw: null, digest: null, unmerged: false } },
    operationState: { value: "normal" },
    working: { value: { ...working, path: new Uint8Array(Buffer.from("a.txt")) } },
    ...fields,
  });
  const STALE = { code: "STALE_SELECTION" as const };

  test("an unchanged observation passes", () => {
    expect(checkpointRefusal(binding, policy(), state(), "sha1")).toBeNull();
  });

  test.each([
    ["a deadline wins over a cancel and every refusal", policy({ gate: "TRUST_REQUIRED" }), state({ head: { stop: "canceled" }, operationState: { stop: "deadline" } }), { stop: "deadline" }],
    ["a cancel wins over every refusal", { code: "GIT_FAILED" } as PolicyObservation, state({ working: { stop: "canceled" } }), { stop: "canceled" }],
    ["a listing failure comes first", { code: "MALFORMED_GIT_OUTPUT" } as PolicyObservation, state({ operationState: { value: "conflicted" } }), { code: "MALFORMED_GIT_OUTPUT" }],
    ["a listing OUTPUT_LIMIT is the diagnostic bound", { code: "OUTPUT_LIMIT", reason: "UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION" } as PolicyObservation, state(), { code: "OUTPUT_LIMIT", reason: "UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION", cause: "OUTPUT_LIMIT" }],
    ["the gate comes before the policy fingerprint", policy({ gate: "TRUST_CHANGED", policyFingerprint: HEX("5"), attributes: null }), state(), { code: "TRUST_CHANGED" }],
    ["a changed policy fingerprint gives TRUST_CHANGED before the index", policy({ policyFingerprint: HEX("5") }), state({ index: { code: "OUTPUT_LIMIT", reason: "MUTATION_RAW_INDEX_BYTES" } }), { code: "TRUST_CHANGED" }],
    ["a raw index above the bound", policy(), state({ index: { code: "OUTPUT_LIMIT", reason: "MUTATION_RAW_INDEX_BYTES" } }), { code: "OUTPUT_LIMIT", reason: "MUTATION_RAW_INDEX_BYTES" }],
    ["a raw index that is no Git index", policy(), state({ index: { value: { raw: new Uint8Array([1, 2, 3]), digest: HEX("9"), unmerged: false } } }), { code: "MALFORMED_GIT_OUTPUT" }],
    ["core.splitIndex comes before the operation state", policy({ listing: listing([entry("core.splitindex", "true")]) }), state({ operationState: { value: "conflicted" } }), { code: "UNSUPPORTED_HUNK_PROFILE", reason: "split-index", remedy: { text: SPLIT_INDEX_TEXT } }],
    [
      "another profile reason has its contract §9 text",
      policy({ listing: listing([entry("index.sparse", "true")]) }),
      state(),
      { code: "UNSUPPORTED_HUNK_PROFILE", reason: "sparse-index", remedy: { text: "This repository uses a sparse index. Arbareto stages hunks and files only with a full index. Stage this change in a terminal." } },
    ],
    ["conflicted with a changed index gives CONFLICTED", policy(), state({ operationState: { value: "conflicted" }, index: { value: { raw: null, digest: HEX("8"), unmerged: true } } }), { code: "CONFLICTED" }],
    ["rebasing with a changed HEAD gives OPERATION_IN_PROGRESS", policy(), state({ operationState: { value: "rebasing" }, head: { value: { state: "detached", oid: "b".repeat(40) } } }), { code: "OPERATION_IN_PROGRESS" }],
    ["sequencer-active gives OPERATION_IN_PROGRESS", policy(), state({ operationState: { value: "sequencer-active" } }), { code: "OPERATION_IN_PROGRESS" }],
    ["an observed unknown gives STALE_SELECTION", policy(), state({ operationState: { value: "unknown" } }), STALE],
    ["a failed operation-state read keeps its code and gets the step remedy", policy(), state({ operationState: { code: "GIT_FAILED" } }), { code: "GIT_FAILED", remedy: { text: STEP_FAILED_TEXT } }],
    ["a changed HEAD", policy(), state({ head: { value: { ...head, oid: "b".repeat(40) } } }), STALE],
    ["a failed HEAD capture keeps its code", policy(), state({ head: { code: "MALFORMED_GIT_OUTPUT" } }), { code: "MALFORMED_GIT_OUTPUT" }],
    ["a changed raw index digest", policy(), state({ index: { value: { raw: null, digest: HEX("8"), unmerged: false } } }), STALE],
    ["a changed attribute", policy({ attributes: { value: { text: "unset" } } }), state(), STALE],
    ["a failed attribute read keeps its code and gets the step remedy", policy({ attributes: { code: "GIT_FAILED" } }), state(), { code: "GIT_FAILED", remedy: { text: STEP_FAILED_TEXT } }],
    ["a changed working file", policy(), state({ working: { value: { ...working, rawDigest: HEX("7") } } }), STALE],
    ["a working file above the bound or replaced twice", policy(), state({ working: { changed: true } }), STALE],
    ["a failed working-file read keeps its code", policy(), state({ working: { code: "REPOSITORY_UNAVAILABLE" } }), { code: "REPOSITORY_UNAVAILABLE" }],
  ] as [string, PolicyObservation, StateObservation, unknown][])("%s", (_name, p, s, expected) => {
    expect(checkpointRefusal(binding, p, s, "sha1")).toEqual(expected as never);
  });

  test("a bound unknown state still gives STALE_SELECTION for an observed unknown", () => {
    expect(checkpointRefusal({ ...binding, operationState: "unknown" }, policy(), state({ operationState: { value: "unknown" } }), "sha1")).toEqual(STALE);
  });

  test("a binding without a working version ignores the working file", () => {
    expect(checkpointRefusal({ ...binding, working: null }, policy(), state({ working: null }), "sha1")).toBeNull();
  });
});

describe("recording (contract §6 \"Lingering Jobs\", T371)", () => {
  // A runner double: each run exits 0 with the next count.
  const replay = async (runs: [EnvironmentPolicy, number | null][]) => {
    const counts = runs.map(([, count]) => count);
    const rec = recording({ run: async () => ({ exitCode: 0, activeDescendants: counts.shift()! }) } as unknown as GitRunner);
    for (const [environmentPolicy] of runs) await rec.run({ environmentPolicy } as never);
    return { last: rec.last, execution: rec.execution };
  };

  test("a checkpoint read with a count of 1 before the first mutation step gives no execution count", async () => {
    expect(await replay([["read", 1]])).toEqual({ last: 1, execution: null });
  });

  test("a mutation step that exits with 1 keeps 1 after a later read with 0", async () => {
    expect(await replay([["read", 1], ["mutation", 1], ["read", 0]])).toEqual({ last: 0, execution: 1 });
  });
});

describe("removeOwned (contract §8 \"Observed locks\", T110 decision G18)", () => {
  test("removes owned files after every process ended, and names them foreign otherwise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbareto-t110-owned-"));
    try {
      const candidate = join(dir, "arbareto-candidate-x");
      writeFileSync(candidate, "x");
      expect(await removeOwned([candidate, `${candidate}.lock`], false)).toEqual([candidate, `${candidate}.lock`]);
      expect(existsSync(candidate)).toBe(true);
      expect(await removeOwned([candidate, `${candidate}.lock`], true)).toEqual([]);
      expect(existsSync(candidate)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
