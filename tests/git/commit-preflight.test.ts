// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T112: the pure decisions of `commit` (contract §2, §4, §7, §9). No Git process runs.

import { describe, expect, test } from "bun:test";
import type { Acceptance, Approval, CommitBinding, CommitReview } from "../../src/git-service/approvals";
import { admitCommit, commitRemedy, HOOK_REMEDY_TEXT, preflightRefusal, utf8Commits } from "../../src/git-service/commit";
import type { RetainedReview } from "../../src/git-service/commit-review";
import { lingeringSentence, REVOKE_TEXT, type PolicyObservation, type StateObservation } from "../../src/git-service/hunk-publish";
import type { OperationState } from "../../src/git-service/snapshot";
import type { ConfigEntry } from "../../src/git-service/trust";
import { printOrigin } from "../origin";

printOrigin("../../src/git-service/commit.ts", import.meta.dir);

const HEX = (c: string) => c.repeat(64);
const REPO = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";
const head = { state: "branch" as const, target: "refs/heads/main", oid: "a".repeat(40) };
const BINDING: CommitBinding = {
  stagedScope: HEX("1"),
  reviewedIndex: { digest: HEX("2"), rawIndexDigest: HEX("3"), sharedIndex: null },
  head,
  disclosure: HEX("4"),
  trust: { state: "untrusted", trustId: null },
  operationState: "normal",
  approvalRequired: false,
};

describe("admitCommit (contract §2, §7 \"Mutation trust\", §9)", () => {
  const review = (binding: Partial<CommitBinding> = {}, fields: Partial<CommitReview> = {}): CommitReview => ({
    kind: "commit",
    reviewToken: TOKEN,
    repositoryId: REPO,
    snapshotId: "33333333-3333-4333-8333-333333333333",
    generation: 3,
    binding: { ...BINDING, ...binding },
    ...fields,
  });
  const kept: RetainedReview = { repositoryId: REPO, issuedAt: 0, rawIndex: null, wslIndex: null, entries: [] };
  const admit = (accepted: Acceptance, o: { generation?: number; retained?: RetainedReview; gate?: "TRUST_REQUIRED" | "TRUST_CHANGED" } = {}) =>
    admitCommit({ repositoryId: REPO, repositoryGeneration: 3 }, { generation: o.generation ?? 3 }, accepted, () => ("retained" in o ? o.retained : kept), () => o.gate ?? null);
  const ok = (a: Approval): Acceptance => ({ ok: true, approval: a });

  test("a current review passes and keeps its retained data", () => {
    expect(admit(ok(review()))).toEqual({ approval: review(), review: kept });
    expect(admit(ok(review({ operationState: "unknown" })))).toEqual({ approval: review({ operationState: "unknown" }), review: kept });
  });

  test.each([
    ["a stale generation comes before every other check", { ok: false, code: "APPROVAL_EXPIRED" } as Acceptance, { generation: 4 }, "REPOSITORY_CHANGED"],
    ["an expired token", { ok: false, code: "APPROVAL_EXPIRED" } as Acceptance, {}, "APPROVAL_EXPIRED"],
    ["an invalidated or unknown token", { ok: false, code: "UNKNOWN_TARGET" } as Acceptance, {}, "UNKNOWN_TARGET"],
    ["a token of another workspace's operation", { ok: false, consumed: "op" } as Acceptance, {}, "UNKNOWN_TARGET"],
    ["a hunk approval", ok({ ...review(), kind: "hunk" } as unknown as Approval), {}, "UNKNOWN_TARGET"],
    ["a review of another workspace", ok(review({}, { repositoryId: "44444444-4444-4444-8444-444444444444" })), {}, "UNKNOWN_TARGET"],
    ["a review of another generation", ok(review({}, { generation: 2 })), {}, "UNKNOWN_TARGET"],
    ["no retained review data", ok(review()), { retained: undefined }, "UNKNOWN_TARGET"],
    ["retained data of another workspace", ok(review()), { retained: { ...kept, repositoryId: "44444444-4444-4444-8444-444444444444" } }, "UNKNOWN_TARGET"],
    ["a conflicted review before the trust gate", ok(review({ operationState: "conflicted" })), { gate: "TRUST_REQUIRED" }, "CONFLICTED"],
    ["required trust without approval", ok(review()), { gate: "TRUST_REQUIRED" }, "TRUST_REQUIRED"],
    ["a changed trust state", ok(review()), { gate: "TRUST_CHANGED" }, "TRUST_CHANGED"],
  ] as const)("%s", (_name, accepted, o, code) => {
    expect(admit(accepted, o)).toEqual({ code });
  });

  test.each(["merging", "rebasing", "cherry-picking", "reverting", "sequencer-active"] as const)("an unfinished %s operation gives OPERATION_IN_PROGRESS", (state) => {
    expect(admit(ok(review({ operationState: state })))).toEqual({ code: "OPERATION_IN_PROGRESS" });
  });

  test("the trust gate gets the reviewed binding", () => {
    const seen: CommitBinding[] = [];
    admitCommit({ repositoryId: REPO, repositoryGeneration: 3 }, { generation: 3 }, ok(review({ approvalRequired: true })), () => kept, (b) => (seen.push(b), null));
    expect(seen).toEqual([{ ...BINDING, approvalRequired: true }]);
  });
});

const entry = (key: string, value: string | null, exact = true): ConfigEntry => ({ key, value, scope: "local", origin: "file:.git/config", exact, originBytes: new Uint8Array(), keyValueBytes: new Uint8Array() }) as ConfigEntry;
const listing = (entries: ConfigEntry[] = []) => ({ entries, hooks: { configured: [], folder: [], fatal: false } });

describe("utf8Commits (contract §4, Git is_encoding_utf8)", () => {
  test.each([
    ["unset", [], true],
    ["utf-8", [entry("i18n.commitencoding", "utf-8")], true],
    ["UTF8", [entry("i18n.commitencoding", "UTF8")], true],
    ["Utf-8", [entry("i18n.commitencoding", "Utf-8")], true],
    ["latin1", [entry("i18n.commitencoding", "latin1")], false],
    ["two dashes", [entry("i18n.commitencoding", "utf--8")], false],
    ["a quoted trailing space", [entry("i18n.commitencoding", "utf-8 ")], false],
    ["an empty value", [entry("i18n.commitencoding", "")], false],
    ["a key without a value", [entry("i18n.commitencoding", null)], false],
    ["a value whose bytes are not UTF-8", [entry("i18n.commitencoding", "utf-8", false)], false],
    ["the last entry wins over latin1", [entry("i18n.commitencoding", "latin1"), entry("i18n.commitencoding", "utf8")], true],
    ["the last entry wins over utf-8", [entry("i18n.commitencoding", "utf-8"), entry("i18n.commitencoding", "latin1")], false],
    ["only the exact key counts", [entry("i18n.logoutputencoding", "latin1"), entry("i18n.x.commitencoding", "latin1")], true],
  ] as const)("%s", (_name, entries, utf8) => {
    expect(utf8Commits([...entries])).toBe(utf8);
  });
});

describe("preflightRefusal (contract §9 commit preflight order)", () => {
  const POLICY = HEX("5");
  const policy = (fields: Partial<Extract<PolicyObservation, { listing: unknown }>> = {}): PolicyObservation => ({ listing: listing(), gate: null, policyFingerprint: POLICY, attributes: null, ...fields });
  const state = (fields: Partial<StateObservation> = {}): StateObservation => ({
    head: { value: head },
    index: { value: { raw: new Uint8Array(), digest: HEX("3"), unmerged: false } },
    operationState: { value: "normal" },
    working: null,
    ...fields,
  });
  const decide = (p: PolicyObservation, s: StateObservation, b: CommitBinding = BINDING) => preflightRefusal(b, POLICY, p, s);
  const STALE = { code: "STALE_REVIEW" as const };
  const otherIndex = { index: { value: { raw: new Uint8Array(), digest: HEX("9"), unmerged: false } } };
  const latin1 = { listing: listing([entry("i18n.commitencoding", "latin1")]) };

  test("an unchanged observation passes", () => {
    expect(decide(policy(), state())).toBeNull();
  });

  test.each([
    ["a deadline wins over a cancel and every refusal", policy({ gate: "TRUST_REQUIRED" }), state({ head: { stop: "canceled" }, operationState: { stop: "deadline" } }), { stop: "deadline" }],
    ["a cancel wins over every refusal", { code: "GIT_FAILED" } as PolicyObservation, state({ index: { stop: "canceled" } }), { stop: "canceled" }],
    ["a failed policy read comes next, without a remedy", { code: "GIT_FAILED" } as PolicyObservation, state(otherIndex), { code: "GIT_FAILED" }],
    ["a listing OUTPUT_LIMIT is the diagnostic bound", { code: "OUTPUT_LIMIT", reason: "UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION" } as PolicyObservation, state(), { code: "OUTPUT_LIMIT", reason: "UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION", cause: "OUTPUT_LIMIT" }],
    ["the commit gate comes before the policy fingerprint", policy({ gate: "TRUST_REQUIRED", policyFingerprint: HEX("6") }), state(otherIndex), { code: "TRUST_REQUIRED" }],
    ["a configuration or trust change gives TRUST_CHANGED before a failed index read", policy({ policyFingerprint: HEX("6") }), state({ index: { code: "GIT_FAILED" } }), { code: "TRUST_CHANGED" }],
    ["a failed index read comes before a changed HEAD", policy(), state({ index: { code: "GIT_FAILED" }, head: { value: { ...head, oid: "b".repeat(40) } } }), { code: "GIT_FAILED" }],
    ["a raw index above the bound", policy(), state({ index: { code: "OUTPUT_LIMIT", reason: "MUTATION_RAW_INDEX_BYTES" } }), { code: "OUTPUT_LIMIT", reason: "MUTATION_RAW_INDEX_BYTES" }],
    ["an index format error", policy(), state({ index: { code: "MALFORMED_GIT_OUTPUT" } }), { code: "MALFORMED_GIT_OUTPUT" }],
    ["a failed operation-state read comes before a failed HEAD read", policy(), state({ operationState: { code: "GIT_FAILED" }, head: { code: "MALFORMED_GIT_OUTPUT" } }), { code: "GIT_FAILED" }],
    ["a failed HEAD read comes before a changed index", policy(), state({ ...otherIndex, head: { code: "MALFORMED_GIT_OUTPUT" } }), { code: "MALFORMED_GIT_OUTPUT" }],
    ["a changed index", policy(), state(otherIndex), STALE],
    ["a changed HEAD OID", policy(), state({ head: { value: { ...head, oid: "b".repeat(40) } } }), STALE],
    ["a changed HEAD target with the same OID", policy(), state({ head: { value: { ...head, target: "refs/heads/twin" } } }), STALE],
    ["a detached HEAD at the same OID", policy(), state({ head: { value: { state: "detached", oid: head.oid } } }), STALE],
    ["an observed unknown operation state", policy(), state({ operationState: { value: "unknown" } }), STALE],
    ["a changed operation state", policy(), state({ operationState: { value: "merging" } }), STALE],
    ["a changed index comes before an unsupported encoding", policy(latin1), state(otherIndex), STALE],
    ["an unsupported i18n.commitEncoding", policy(latin1), state(), { code: "COMMIT_ENCODING_UNSUPPORTED" }],
  ] as const)("%s", (_name, p, s, expected) => {
    expect(decide(p as PolicyObservation, s as StateObservation) as unknown).toEqual(expected);
  });

  test("a reviewed unknown state never passes", () => {
    const unknown = { ...BINDING, operationState: "unknown" as OperationState };
    expect([decide(policy(), state({ operationState: { value: "unknown" } }), unknown), decide(policy(), state(), unknown)]).toEqual([STALE, STALE]);
  });
});

describe("commitRemedy (contract §4 \"Quoting rule\", §9)", () => {
  const GIT = "C:\\Program Files\\Git\\cmd\\git.exe";
  const command = (root: string) => `& 'C:\\Program Files\\Git\\cmd\\git.exe' --no-lazy-fetch -C '${root}' hook run --ignore-missing pre-commit`;

  test("the command names the selected Git and the worktree root and holds no message", () => {
    expect(commitRemedy(GIT, "D:\\work\\repo\\", null, false)).toEqual({ text: HOOK_REMEDY_TEXT, command: command("D:\\work\\repo") });
  });

  test.each(["'", "\u2018", "\u2019", "\u201A", "\u201B"])("the root quote %p is doubled", (q) => {
    expect(commitRemedy(GIT, `D:\\w${q}x`, null, false).command).toBe(command(`D:\\w${q}${q}x`));
  });

  test("a root with U+201C gives no command and shows the root as text", () => {
    expect(commitRemedy(GIT, "D:\\w\u201Cx", null, false)).toEqual({ text: "PowerShell cannot pass this value safely, so Arbareto offers no command: D:\\w\u201Cx", command: null });
  });

  test("a Git path with U+0022 shows that path as text", () => {
    expect(commitRemedy('C:\\G"it\\git.exe', "D:\\w\u201Cx", null, false).text).toBe('PowerShell cannot pass this value safely, so Arbareto offers no command: C:\\G"it\\git.exe');
  });

  test.each([
    [null, true, HOOK_REMEDY_TEXT],
    [0, true, HOOK_REMEDY_TEXT],
    [1, false, `${HOOK_REMEDY_TEXT} ${lingeringSentence(1)}`],
    [1, true, `${HOOK_REMEDY_TEXT} ${lingeringSentence(1)} ${REVOKE_TEXT}`],
    [2, false, `${HOOK_REMEDY_TEXT} ${lingeringSentence(2)}`],
    [2, true, `${HOOK_REMEDY_TEXT} ${lingeringSentence(2)} ${REVOKE_TEXT}`],
  ] as const)("lingering count %p with trust ID %p", (count, trustId, text) => {
    expect(commitRemedy(GIT, "D:\\repo", count, trustId).text).toBe(text);
  });

  test("a refused value keeps the lingering sentence", () => {
    expect(commitRemedy(GIT, "D:\\w\u201Cx", 2, true).text).toBe(`PowerShell cannot pass this value safely, so Arbareto offers no command: D:\\w\u201Cx ${lingeringSentence(2)} ${REVOKE_TEXT}`);
  });
});
