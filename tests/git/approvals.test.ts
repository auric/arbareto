// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T108: data-model §6 "Mutation approvals", contract §2 repeat rule, §4 binding list, §5 "Approval lifetime", §8 "Token invalidation", and §9.

import { describe, expect, test } from "bun:test";
import { APPROVAL_LIFETIME_MS } from "../../src/contracts/limits";
import { createApprovals } from "../../src/git-service/approvals";
import { printOrigin } from "../origin";

printOrigin("../../src/git-service/approvals.ts", import.meta.dir);
type Store = ReturnType<typeof createApprovals>;
type Approval = Parameters<Store["issue"]>[0];

const id = () => crypto.randomUUID();
const ident = (n: number) => ({ volumeSerial: "0".repeat(15) + "1", fileId: n.toString(16).padStart(32, "0") });
const HEX = (c: string) => c.repeat(64);

// Every value of the contract §4 list, plus the canonical diff and the selected hunk.
const comparisonBinding = () => ({
  gitInstallationId: id(),
  worktreeIdentity: [ident(1), ident(2)] as [ReturnType<typeof ident>, ReturnType<typeof ident>],
  commonIdentity: ident(3),
  head: { state: "branch" as const, target: "refs/heads/main", oid: "a".repeat(40) },
  index: { digest: HEX("1"), rawIndexDigest: HEX("2"), sharedIndex: null },
  entry: { pathBytes: Buffer.from("a.txt").toString("base64"), category: "unstaged" as const, modes: ["100644", "100644", "100644"], oids: ["b".repeat(40), "c".repeat(40)], stage: 0 as const },
  working: { path: new TextEncoder().encode("a.txt"), exists: true as const, type: "file" as const, mode: 0o100644, size: 4, rawDigest: HEX("3"), normalized: "d".repeat(40) },
  attributes: { text: "auto" },
  policyFingerprint: HEX("4"),
  operationState: "normal" as const,
});

function hunk(at = { comparisonId: id(), hunkId: id(), direction: "stage" as const }): Extract<Approval, { kind: "hunk" }> {
  return { kind: "hunk", repositoryId: id(), snapshotId: id(), generation: 1, ...at, binding: { ...comparisonBinding(), patchDigest: HEX("5"), hunkDigest: HEX("6") } };
}

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

describe("approvals (T108)", () => {
  test("a hunk approval lasts at most 60 seconds: valid at 60,000 ms, expired after it", () => {
    const c = clock();
    const store = createApprovals(c.now);
    const a = hunk();
    store.issue(a);
    c.advance(APPROVAL_LIFETIME_MS);
    expect(store.accept(a)).toEqual({ ok: true, approval: a });
    c.advance(1);
    expect(store.accept(a)).toEqual({ ok: false, code: "APPROVAL_EXPIRED" });
    expect(store.consume(a, id())).toBe(false);
  });

  test("a consumed approval is one-use: a repeat gets its operation, also after the lifetime", () => {
    const c = clock();
    const store = createApprovals(c.now);
    const a = hunk();
    store.issue(a);
    const operationId = id();
    expect(store.consume(a, operationId)).toBe(true);
    expect(store.consume(a, id())).toBe(false);
    expect(store.accept(a)).toEqual({ ok: false, consumed: operationId });
    c.advance(APPROVAL_LIFETIME_MS + 1);
    expect(store.accept(a)).toEqual({ ok: false, consumed: operationId });
    // Invalidation, eviction, and a new issue never release a consumed approval (contract §2).
    store.invalidate(() => true);
    store.forget(a.comparisonId);
    expect(store.issue(a)).toEqual({ ok: false, consumed: operationId });
    expect(store.accept(a)).toEqual({ ok: false, consumed: operationId });
  });

  test("comparison eviction forgets its approvals; an expired one answers APPROVAL_EXPIRED until then", () => {
    const c = clock();
    const store = createApprovals(c.now);
    const comparisonId = id();
    const [stage, unstage, other] = [hunk({ comparisonId, hunkId: id(), direction: "stage" }), hunk({ comparisonId, hunkId: id(), direction: "stage" }), hunk()];
    for (const a of [stage, unstage, other]) expect(store.issue(a)).toEqual({ ok: true });
    c.advance(APPROVAL_LIFETIME_MS + 1);
    expect(store.accept(stage)).toEqual({ ok: false, code: "APPROVAL_EXPIRED" });
    store.forget(comparisonId);
    expect(store.accept(stage)).toEqual({ ok: false, code: "UNKNOWN_TARGET" });
    expect(store.accept(unstage)).toEqual({ ok: false, code: "UNKNOWN_TARGET" });
    expect(store.accept(other)).toEqual({ ok: false, code: "APPROVAL_EXPIRED" });
  });

  test("the key is comparison, hunk, and direction; another value names no approval", () => {
    const store = createApprovals(clock().now);
    const a = hunk();
    store.issue(a);
    expect(store.accept({ ...a, direction: "unstage" })).toEqual({ ok: false, code: "UNKNOWN_TARGET" });
    expect(store.accept({ ...a, hunkId: id() })).toEqual({ ok: false, code: "UNKNOWN_TARGET" });
    // A new service session holds no approval.
    expect(createApprovals(clock().now).accept(a)).toEqual({ ok: false, code: "UNKNOWN_TARGET" });
  });

  test("an invalidated approval or review gives UNKNOWN_TARGET; another repository keeps its approval", () => {
    const store = createApprovals(clock().now);
    const [invalidated, other] = [hunk(), hunk()];
    const commit: Approval = { kind: "commit", repositoryId: invalidated.repositoryId, snapshotId: id(), generation: 1, reviewToken: id(), binding: { stagedScope: HEX("7"), reviewedIndex: comparisonBinding().index, head: comparisonBinding().head, disclosure: HEX("8"), trust: { state: "approved", trustId: id() }, operationState: "normal", approvalRequired: true } };
    for (const a of [invalidated, other, commit]) store.issue(a);
    store.invalidate((a) => a.repositoryId === invalidated.repositoryId);
    expect(store.accept(invalidated)).toEqual({ ok: false, code: "UNKNOWN_TARGET" });
    expect(store.accept(commit)).toEqual({ ok: false, code: "UNKNOWN_TARGET" });
    expect(store.accept(other)).toMatchObject({ ok: true });
  });

  // T386: contract §6 "Registration reuse and release". A released `repositoryId` is never issued again, so no request reaches its consumed approval.
  test("T386: a release frees every approval of its repository, also a consumed one; another repository keeps its consumed approval", async () => {
    const store = createApprovals(clock().now);
    const operationId = id();
    const [released, other] = [hunk(), hunk()];
    const ref = new WeakRef(released.binding);
    for (const a of [released, other]) {
      store.issue(a);
      expect(store.consume(a, operationId)).toBe(true);
    }
    const unused = { ...hunk(), repositoryId: released.repositoryId };
    store.issue(unused);
    store.release(released.repositoryId);
    expect(store.accept(released)).toEqual({ ok: false, code: "UNKNOWN_TARGET" });
    expect(store.accept(unused)).toEqual({ ok: false, code: "UNKNOWN_TARGET" });
    expect(store.accept(other)).toEqual({ ok: false, consumed: operationId });
    // Only the store and `released` hold the binding.
    (released as { binding: unknown }).binding = null;
    // A WeakRef keeps its target until the current job ends (ECMA-262 ClearKeptObjects).
    await Bun.sleep(0);
    Bun.gc(true);
    expect(ref.deref()).toBeUndefined();
  });

  test("a hunk approval binds every value of the contract §4 list, and each change is reported", () => {
    const store = createApprovals(clock().now);
    const a = hunk();
    expect(store.staleFields(a.binding, structuredClone(a.binding))).toEqual([]);
    const changes: Record<string, unknown> = {
      gitInstallationId: id(),
      worktreeIdentity: [ident(1), ident(9)],
      commonIdentity: ident(9),
      head: { state: "unborn", target: "refs/heads/main" },
      index: { ...a.binding.index, sharedIndex: { hash: HEX("9"), digest: null } },
      entry: { ...a.binding.entry, stage: 2 },
      working: { ...a.binding.working, rawDigest: HEX("9") },
      attributes: { text: "auto", eol: "crlf" },
      policyFingerprint: HEX("9"),
      operationState: "merging",
      patchDigest: HEX("9"),
      hunkDigest: HEX("9"),
    };
    for (const [key, value] of Object.entries(changes)) expect(store.staleFields(a.binding, { ...a.binding, [key]: value })).toEqual([key]);
    // Raw bytes compare byte by byte.
    const path = new TextEncoder().encode("A.txt");
    expect(store.staleFields(a.binding, { ...a.binding, working: { ...a.binding.working, path } as typeof a.binding.working })).toEqual(["working"]);
  });

  test("a stage file approval binds the working-file size and digest; an unstage one binds none", () => {
    const store = createApprovals(clock().now);
    const { working: _working, ...rest } = comparisonBinding();
    const stage: Approval = { kind: "file", repositoryId: id(), snapshotId: id(), generation: 1, comparisonId: id(), entryId: id(), direction: "stage", binding: { ...rest, working: { size: 4, sha256: HEX("3") } } };
    const unstage: Approval = { ...stage, comparisonId: id(), direction: "unstage", binding: { ...rest, working: null } };
    store.issue(stage);
    store.issue(unstage);
    expect(store.accept(stage)).toMatchObject({ ok: true });
    expect(store.accept(unstage)).toMatchObject({ ok: true });
    expect(store.staleFields(stage.binding, { ...stage.binding, working: { size: 4, sha256: HEX("9") } })).toEqual(["working"]);
  });
});
