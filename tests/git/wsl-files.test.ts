// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T214 WP2: the WSL file steps against a fake runner (contract §4 "WSL index publication" and "Process end", §6 "WSL file work").
// The fake runner checks each request with the service request checks, so every body here is a valid frame.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { GIT_PROCESS_DEADLINE_MS } from "../../src/contracts/limits";
import { checkCall, checkWslFiles, RunnerRefusal, type GitCall, type GitExit, type WalkStop, type WslFileResult, type WslFilesCall } from "../../src/git-service/git-runner";
import { LOCKED_REMEDY } from "../../src/git-service/index-lock";
import type { Workspace } from "../../src/git-service/registration";
import { processEnd, removeCandidate, wslCopy, wslIndexOf, wslLock, wslProofA, wslProofB, wslWhole, type Clock, type WslContext } from "../../src/git-service/wsl-files";

printOrigin("../../src/git-service/wsl-files.ts", import.meta.dir);

type Reply = WslFileResult[] | WalkStop | RunnerRefusal;
type RunReply = GitExit | RunnerRefusal;

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const OID = "c".repeat(40);
const LINK = "d".repeat(40);
const DIR = mkdtempSync(join(tmpdir(), "arbareto-wsl-files-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

function fake(replies: Reply[], exits: RunReply[] = [], indexPath = join(DIR, "missing", "index")) {
  const requests: WslFilesCall[] = [];
  const signals: AbortSignal[] = [];
  const runs: GitCall[] = [];
  const controller = new AbortController();
  const workspace = { repositoryId: crypto.randomUUID(), gitInstallationId: crypto.randomUUID(), indexPath, objectFormat: "sha1" } as unknown as Workspace;
  const ctx: WslContext = {
    operationId: crypto.randomUUID(),
    signal: controller.signal,
    workspace,
    runner: {
      async wslFiles(request, signal) {
        checkWslFiles(request);
        requests.push(request);
        signals.push(signal);
        const reply = replies.shift();
        if (reply === undefined) throw new Error("no queued wslFiles reply");
        if (reply instanceof RunnerRefusal) throw reply;
        return reply;
      },
      async run(call) {
        checkCall(call);
        runs.push(call);
        const reply = exits.shift();
        if (reply === undefined) throw new Error("no queued run reply");
        if (reply instanceof RunnerRefusal) throw reply;
        return reply;
      },
    },
  };
  // The request without the context fields.
  const body = (i: number) => {
    const { operationId: _o, contextKind: _k, gitInstallationId: _g, repositoryId: _r, ...rest } = requests[i]!;
    return rest;
  };
  return { ctx, requests, signals, runs, body, cancel: () => controller.abort() };
}

const UNFIT = { code: "PROCESS_OWNERSHIP_FAILED" } as const;
const REFUSAL = () => new RunnerRefusal("UNKNOWN_TARGET");
const CANCELED: WalkStop = { stop: "canceled" };
const DEADLINE: WalkStop = { stop: "deadline" };
const ZERO = { exitCode: 0 };

// A version 2 index with one entry `a` at `stage` and the SHA-1 trailer (Git `Documentation/gitformat-index.adoc`).
function indexBytes(stage: number): Uint8Array {
  const header = Buffer.alloc(12);
  header.write("DIRC", 0, "latin1");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(1, 8);
  const entry = Buffer.alloc(64);
  entry.writeUInt32BE(0o100644, 24);
  entry.writeUInt16BE((stage << 12) | 1, 60);
  entry.write("a", 62, "latin1");
  const body = Buffer.concat([header, entry]);
  return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}

describe("wslIndexOf (contract §4 index recheck, §6 indexDigest)", () => {
  const bound = { rawIndexDigest: HEX_A, sharedIndex: null };
  const index = (index: unknown, sharedIndex?: unknown): Reply => [{ kind: "index", index, ...(sharedIndex === undefined ? {} : { sharedIndex }) } as WslFileResult];

  test("an equal digest reuses the bound link and reads no index bytes", async () => {
    const f = fake([index({ kind: "digest", size: 10, sha256: HEX_A }, { kind: "digest", size: 5, sha256: HEX_B })]);
    const r = await wslIndexOf(f.ctx, { rawIndexDigest: HEX_A, sharedIndex: { hash: LINK, digest: HEX_B } });
    expect(f.body(0)).toEqual({ mode: "indexDigest", bound: "MUTATION_RAW_INDEX_BYTES", sharedIndex: LINK });
    expect(r).toMatchObject({ value: { raw: { link: LINK }, digest: HEX_A, unmerged: false } });
  });

  // Feature 003 contract Δ4: a Mark resolved binding holds stages above 0, also without a merge marker (a stash-apply conflict).
  test("an equal digest takes the stage fact of the bound index and reads no index bytes", async () => {
    const f = fake([index({ kind: "digest", size: 10, sha256: HEX_A })]);
    expect(await wslIndexOf(f.ctx, bound, true)).toMatchObject({ value: { digest: HEX_A, unmerged: true } });
    const g = fake([index({ kind: "digest", size: 10, sha256: HEX_A })]);
    expect(await wslIndexOf(g.ctx, bound)).toMatchObject({ value: { digest: HEX_A, unmerged: false } });
    // A changed digest reads its own stages, whatever the bound fact is.
    const path = join(DIR, "changed-resolved-index");
    writeFileSync(path, indexBytes(0));
    const h = fake([index({ kind: "digest", size: 104, sha256: HEX_B })], [], path);
    expect(await wslIndexOf(h.ctx, bound, true)).toMatchObject({ value: { digest: HEX_B, unmerged: false } });
  });

  test("a link without a shared file sends no sharedIndex", async () => {
    const f = fake([index({ kind: "digest", size: 10, sha256: HEX_A })]);
    expect(await wslIndexOf(f.ctx, { rawIndexDigest: HEX_A, sharedIndex: { hash: "0".repeat(40), digest: null } })).toMatchObject({ value: { raw: { link: "0".repeat(40) } } });
    expect(f.body(0)).toEqual({ mode: "indexDigest", bound: "MUTATION_RAW_INDEX_BYTES" });
  });

  test("an absent index part gives a null digest without a read", async () => {
    const f = fake([index({ kind: "absent" })]);
    expect(await wslIndexOf(f.ctx, bound)).toMatchObject({ value: { raw: { link: null }, digest: null, unmerged: false } });
  });

  test("a changed digest reads the raw index once through the index path for the link and the stages", async () => {
    const path = join(DIR, "changed-index");
    writeFileSync(path, indexBytes(2));
    const f = fake([index({ kind: "digest", size: 104, sha256: HEX_B })], [], path);
    expect(await wslIndexOf(f.ctx, bound)).toMatchObject({ value: { raw: { link: null }, digest: HEX_B, unmerged: true } });
    writeFileSync(path, indexBytes(0));
    const g = fake([index({ kind: "digest", size: 104, sha256: HEX_B })], [], path);
    expect(await wslIndexOf(g.ctx, bound)).toMatchObject({ value: { digest: HEX_B, unmerged: false } });
  });

  test("changed index bytes that are no Git index give MALFORMED_GIT_OUTPUT", async () => {
    const path = join(DIR, "malformed-index");
    writeFileSync(path, "not an index");
    const f = fake([index({ kind: "digest", size: 12, sha256: HEX_B })], [], path);
    expect(await wslIndexOf(f.ctx, bound)).toEqual({ code: "MALFORMED_GIT_OUTPUT" });
  });

  test("a changed index that is no regular file gives GIT_FAILED", async () => {
    const path = join(DIR, "directory-index");
    mkdirSync(path);
    const f = fake([index({ kind: "digest", size: 12, sha256: HEX_B })], [], path);
    expect(await wslIndexOf(f.ctx, bound)).toEqual({ code: "GIT_FAILED" });
  });

  test("an error part gives GIT_FAILED, and a bound part gives OUTPUT_LIMIT", async () => {
    expect(await wslIndexOf(fake([index({ kind: "error", code: "io-error" })]).ctx, bound)).toEqual({ code: "GIT_FAILED" });
    const shared = { rawIndexDigest: HEX_A, sharedIndex: { hash: LINK, digest: HEX_B } };
    expect(await wslIndexOf(fake([index({ kind: "digest", size: 1, sha256: HEX_A }, { kind: "bound" })]).ctx, shared)).toEqual({ code: "OUTPUT_LIMIT", reason: "MUTATION_RAW_INDEX_BYTES" });
    expect(await wslIndexOf(fake([[{ kind: "error", component: 0, code: "other-error" }]]).ctx, bound)).toEqual({ code: "GIT_FAILED" });
  });

  test("a stop, a refusal, and a result of another mode", async () => {
    expect(await wslIndexOf(fake([DEADLINE]).ctx, bound)).toEqual(DEADLINE);
    expect(await wslIndexOf(fake([REFUSAL()]).ctx, bound)).toEqual({ code: "UNKNOWN_TARGET" });
    expect(await wslIndexOf(fake([[{ kind: "locked" }]]).ctx, bound)).toEqual(UNFIT);
  });
});

describe("wslWhole (contract §6 digest with the whole-file bound)", () => {
  const parts = ["src", "a.txt"];
  const file = (changed: boolean, sha256 = HEX_A): WslFileResult => ({ kind: "file", size: 3, changed, sha256 });

  test("a file gives its size and digest", async () => {
    const f = fake([[file(false)]]);
    expect(await wslWhole(f.ctx, parts)).toEqual({ value: { size: 3, sha256: HEX_A } });
    expect(f.body(0)).toEqual({ mode: "digest", bound: "WHOLE_FILE_STAGE_INPUT_BYTES", files: [{ root: "worktreeRoot", path: parts }] });
  });

  test("changed reads once more, and a second changed gives changed", async () => {
    const f = fake([[file(true)], [file(false, HEX_B)]]);
    expect(await wslWhole(f.ctx, parts)).toEqual({ value: { size: 3, sha256: HEX_B } });
    expect(f.requests).toHaveLength(2);
    const g = fake([[file(true)], [file(true)]]);
    expect(await wslWhole(g.ctx, parts)).toEqual({ changed: true });
    expect(g.requests).toHaveLength(2);
  });

  test.each([
    ["a file above the bound", { kind: "file", size: 9, changed: false, bound: "WHOLE_FILE_STAGE_INPUT_BYTES" }, { changed: true }],
    ["a directory", { kind: "directory" }, { value: "other" }],
    ["another type", { kind: "other" }, { value: "other" }],
    ["a final link", { kind: "link", component: 2, targetBytes: "YQ==", sha256: HEX_A }, { value: "other" }],
    ["a link before the last component", { kind: "link", component: 1 }, { value: "absent" }],
    ["an absent file", { kind: "absent" }, { value: "absent" }],
    ["an error", { kind: "error", component: 2, code: "access-denied" }, { code: "REPOSITORY_UNAVAILABLE" }],
    ["a result of another mode", { kind: "removed" }, UNFIT],
  ] as const)("%s", async (_name, result, expected) => {
    expect<unknown>(await wslWhole(fake([[result as WslFileResult]]).ctx, parts)).toEqual(expected);
  });

  test("a stop and a refusal", async () => {
    expect(await wslWhole(fake([CANCELED]).ctx, parts)).toEqual(CANCELED);
    expect(await wslWhole(fake([REFUSAL()]).ctx, parts)).toEqual({ code: "UNKNOWN_TARGET" });
  });
});

describe("blob proofs (contract §4 \"Blob proof\", §6 catFile and hashObject)", () => {
  const parts = ["a.txt"];
  const bound = { size: 3, sha256: HEX_A };
  const blob = (fields: Record<string, unknown> = {}): WslFileResult => ({ kind: "blob", size: 3, sha256: HEX_A, over: false, gitExit: ZERO, hashExit: ZERO, ...fields }) as WslFileResult;
  const object = (fields: Record<string, unknown> = {}): WslFileResult => ({ kind: "object", size: 3, sha256: HEX_A, oid: OID, gitExit: ZERO, hashExit: ZERO, ...fields }) as WslFileResult;

  test("proof A sends the staged object ID and the verified size", async () => {
    const f = fake([[blob()]]);
    expect(await wslProofA(f.ctx, parts, OID, bound)).toEqual({ value: true });
    expect(f.body(0)).toEqual({ mode: "catFile", bound: "WHOLE_FILE_STAGE_INPUT_BYTES", files: [{ root: "worktreeRoot", path: parts }], oid: OID, size: 3 });
  });

  test.each([
    ["over", { over: true }],
    ["a Git signal exit", { gitExit: { signal: 13 } }],
    ["a nonzero hash exit", { hashExit: { exitCode: 1 } }],
    ["another size", { size: 4 }],
    ["another digest", { sha256: HEX_B }],
  ])("proof A fails with %s", async (_name, fields) => {
    expect(await wslProofA(fake([[blob(fields)]]).ctx, parts, OID, bound)).toEqual({ value: false });
  });

  test("proof A: an error, a stop, a refusal, and a result of another mode", async () => {
    expect(await wslProofA(fake([[{ kind: "error", component: 0, code: "other-error" }]]).ctx, parts, OID, bound)).toEqual({ code: "GIT_FAILED" });
    expect(await wslProofA(fake([DEADLINE]).ctx, parts, OID, bound)).toEqual(DEADLINE);
    expect(await wslProofA(fake([REFUSAL()]).ctx, parts, OID, bound)).toEqual({ code: "UNKNOWN_TARGET" });
    expect(await wslProofA(fake([[object()]]).ctx, parts, OID, bound)).toEqual(UNFIT);
  });

  test("proof B holds only for the staged object ID", async () => {
    const f = fake([[object()]]);
    expect(await wslProofB(f.ctx, parts, OID, bound)).toEqual({ value: true });
    expect(f.body(0)).toEqual({ mode: "hashObject", bound: "WHOLE_FILE_STAGE_INPUT_BYTES", files: [{ root: "worktreeRoot", path: parts }] });
    const { oid: _oid, ...noOid } = object() as Record<string, unknown>;
    expect(await wslProofB(fake([[noOid as WslFileResult]]).ctx, parts, OID, bound)).toEqual({ value: false });
    expect(await wslProofB(fake([[object({ oid: "e".repeat(40) })]]).ctx, parts, OID, bound)).toEqual({ value: false });
    expect(await wslProofB(fake([[object({ gitExit: { exitCode: 128 } })]]).ctx, parts, OID, bound)).toEqual({ value: false });
  });

  test.each([
    ["a file above the bound", { kind: "file", size: 9, changed: false, bound: "WHOLE_FILE_STAGE_INPUT_BYTES" }, { value: false }],
    ["an absent file", { kind: "absent" }, { value: false }],
    ["a directory", { kind: "directory" }, { value: false }],
    ["an error", { kind: "error", component: 1, code: "io-error" }, { code: "GIT_FAILED" }],
    ["a result of another mode", { kind: "blob", size: 3, sha256: HEX_A, over: false, gitExit: ZERO, hashExit: ZERO }, UNFIT],
  ] as const)("proof B with %s", async (_name, result, expected) => {
    expect<unknown>(await wslProofB(fake([[result as WslFileResult]]).ctx, parts, OID, bound)).toEqual(expected);
  });
});

describe("wslLock (contract §4 \"Lock token\")", () => {
  const LOCK: WslFileResult = { kind: "lock", device: "2112", inode: "57001" };

  test("each lock request sends a new 32-byte token as 64 lowercase hex digits", async () => {
    const f = fake([[LOCK], [LOCK]]);
    await wslLock(f.ctx);
    await wslLock(f.ctx);
    const [a, b] = [f.body(0), f.body(1)] as { token: string }[];
    expect(f.body(0)).toEqual({ mode: "lock", bound: "MUTATION_RAW_INDEX_BYTES", token: a!.token });
    expect(a!.token).toMatch(/^[0-9a-f]{64}$/);
    expect(b!.token).toMatch(/^[0-9a-f]{64}$/);
    expect(a!.token).not.toBe(b!.token);
  });

  test("a lock reply gives the lock form: publish and release name the device, the inode, and the token", async () => {
    const f = fake([[LOCK], [{ kind: "published", size: 10, sha256: HEX_A }], [{ kind: "removed" }]]);
    const r = await wslLock(f.ctx);
    if (!("ok" in r) || !r.ok) throw new Error("no lock");
    const { token } = r.lock;
    expect(r.lock).toMatchObject({ path: `${f.ctx.workspace.indexPath}.lock`, identity: { device: "2112", inode: "57001" } });
    expect("unknown" in r).toBe(false);
    const signal = new AbortController().signal;
    expect(await r.lock.publish("arbareto-candidate-1", HEX_A, signal)).toEqual({ published: true, size: 10, sha256: HEX_A });
    expect(f.body(1)).toEqual({ mode: "publish", bound: "MUTATION_RAW_INDEX_BYTES", candidate: "arbareto-candidate-1", lock: { device: "2112", inode: "57001" }, token, expected: HEX_A });
    expect(f.signals[1]).toBe(signal);
    expect(await r.lock.release()).toBe("removed");
    expect(f.body(2)).toEqual({ mode: "remove", bound: "MUTATION_RAW_INDEX_BYTES", lock: { device: "2112", inode: "57001" }, token });
  });

  test("a lock error gives create-failed and only the token-only form", async () => {
    const f = fake([[{ kind: "error", component: 0, code: "io-error" }], [{ kind: "notOwned" }]]);
    const r = await wslLock(f.ctx);
    expect(r).toMatchObject({ ok: false, reason: "create-failed", errno: "io-error", path: `${f.ctx.workspace.indexPath}.lock` });
    if (!("unknown" in r)) throw new Error("no unknown lock");
    expect(await r.unknown.removeByToken()).toBe("notOwned");
    expect(f.body(1)).toEqual({ mode: "remove", bound: "MUTATION_RAW_INDEX_BYTES", token: (f.body(0) as { token: string }).token });
  });

  test("a stopped lock walk gives the stop and only the token-only form, and the removal runs after a cancel", async () => {
    const f = fake([CANCELED, [{ kind: "removed" }]]);
    f.cancel();
    const r = await wslLock(f.ctx);
    expect(r).toMatchObject({ stop: "canceled" });
    if (!("unknown" in r)) throw new Error("no unknown lock");
    expect(await r.unknown.removeByToken()).toBe("removed");
    expect(f.body(1)).toEqual({ mode: "remove", bound: "MUTATION_RAW_INDEX_BYTES", token: (f.body(0) as { token: string }).token });
    expect(f.signals[1]!.aborted).toBe(false);
  });

  test("locked gives LOCKED with the lock path and no unknown lock", async () => {
    const f = fake([[{ kind: "locked" }]]);
    expect(await wslLock(f.ctx)).toEqual({ ok: false, code: "LOCKED", path: `${f.ctx.workspace.indexPath}.lock`, remedy: { text: LOCKED_REMEDY } });
  });

  // T116 B3-5: the service cannot tell whether such a walk ran, so the lock ownership stays unknown (contract §4 "Stopped or failed `lock`").
  test.each([
    ["a refusal", REFUSAL(), { code: "UNKNOWN_TARGET" }],
    ["a result of another mode", [{ kind: "removed" }] as WslFileResult[], UNFIT],
    ["a malformed reply", new RunnerRefusal("PROCESS_OWNERSHIP_FAILED"), UNFIT],
  ] as const)("%s gives its failure and only the token-only form", async (_name, reply, expected) => {
    const f = fake([reply as Reply, [{ kind: "notOwned" }]]);
    const r = await wslLock(f.ctx);
    expect(r).toMatchObject(expected);
    if (!("unknown" in r)) throw new Error("no unknown lock");
    expect(r.unknown.path).toBe(`${f.ctx.workspace.indexPath}.lock`);
    expect(await r.unknown.removeByToken()).toBe("notOwned");
    expect(f.body(1)).toEqual({ mode: "remove", bound: "MUTATION_RAW_INDEX_BYTES", token: (f.body(0) as { token: string }).token });
  });

  const locked = async (replies: Reply[]) => {
    const f = fake([[LOCK], ...replies]);
    const r = await wslLock(f.ctx);
    if (!("ok" in r) || !r.ok) throw new Error("no lock");
    return { f, lock: r.lock };
  };

  test.each([
    ["mismatch", [{ kind: "mismatch" }], { published: false, reason: "mismatch" }],
    ["notOwned", [{ kind: "notOwned" }], { published: false, reason: "notOwned" }],
    ["error as a typed replace failure", [{ kind: "error", component: 0, code: "io-error" }], { published: false, reason: "replace-failed", errno: "io-error" }],
    ["published with another digest", [{ kind: "published", size: 10, sha256: HEX_B }], UNFIT],
    ["a result of another mode", [{ kind: "removed" }], UNFIT],
  ] as const)("publish: %s", async (_name, results, expected) => {
    const { lock } = await locked([results as unknown as WslFileResult[]]);
    expect<unknown>(await lock.publish("arbareto-candidate-1", HEX_A, new AbortController().signal)).toEqual(expected);
  });

  test("publish: a stop and a refusal", async () => {
    expect(await (await locked([DEADLINE])).lock.publish("arbareto-candidate-1", HEX_A, new AbortController().signal)).toEqual(DEADLINE);
    expect(await (await locked([REFUSAL()])).lock.publish("arbareto-candidate-1", HEX_A, new AbortController().signal)).toEqual({ code: "UNKNOWN_TARGET" });
  });

  test.each([
    ["removed", { kind: "removed" }, "removed"],
    ["notOwned", { kind: "notOwned" }, "notOwned"],
    ["error", { kind: "error", component: 0, code: "access-denied" }, "remove-failed"],
    ["a result of another mode", { kind: "published", size: 1, sha256: HEX_A }, UNFIT],
  ] as const)("release: %s", async (_name, result, expected) => {
    const { f, lock } = await locked([[result as WslFileResult]]);
    f.cancel();
    expect<unknown>(await lock.release()).toEqual(expected);
    expect(f.signals[1]!.aborted).toBe(false);
  });

  test("release: a deadline stop", async () => {
    expect(await (await locked([DEADLINE])).lock.release()).toEqual(DEADLINE);
  });
});

describe("wslCopy (contract §4 \"Candidate time\", §6 candidate)", () => {
  const copy = (index: Record<string, unknown> = {}, candidate: Record<string, unknown> = {}): WslFileResult[] => [
    { kind: "candidate", index: { size: 10, sha256: HEX_A, mtime: "100", ...index }, candidate: { size: 10, sha256: HEX_A, mtime: "100", ...candidate } } as WslFileResult,
  ];

  test("a verified copy at the canonical time gives both facts", async () => {
    const f = fake([copy({}, { mtime: "99" })]);
    expect(await wslCopy(f.ctx, "arbareto-candidate-1", HEX_A)).toEqual({ value: { index: { size: 10, sha256: HEX_A, mtime: "100" }, candidate: { size: 10, sha256: HEX_A, mtime: "99" } } });
    expect(f.body(0)).toEqual({ mode: "candidate", bound: "MUTATION_RAW_INDEX_BYTES", candidate: "arbareto-candidate-1" });
    expect(await wslCopy(fake([copy()]).ctx, "arbareto-candidate-1", HEX_A)).toMatchObject({ value: {} });
  });

  test.each([
    ["an index digest other than the binding", copy({ sha256: HEX_B }, { sha256: HEX_B }), HEX_A, { failure: { reason: "index-changed" } }],
    ["a copy without a bound digest", copy(), null, { failure: { reason: "index-changed" } }],
    ["a copy of other bytes", copy({}, { sha256: HEX_B }), HEX_A, { failure: { reason: "verification", detail: "content" } }],
    ["a copy of another size", copy({}, { size: 11 }), HEX_A, { failure: { reason: "verification", detail: "content" } }],
    ["a candidate time above the canonical time", copy({}, { mtime: "101" }), HEX_A, { failure: { reason: "candidate-time", canonicalNs: 100_000_000_000n, candidateNs: 101_000_000_000n } }],
    ["an absent index without a bound digest", [{ kind: "absent" }], null, { value: null }],
    ["an absent index with a bound digest", [{ kind: "absent" }], HEX_A, { failure: { reason: "index-changed" } }],
    ["an index above the bound", [{ kind: "bound" }], HEX_A, { failure: { reason: "bound" } }],
    ["an error", [{ kind: "error", component: 0, code: "io-error" }], HEX_A, { failure: { reason: "unavailable", errno: "io-error" } }],
    ["a result of another mode", [{ kind: "locked" }], HEX_A, UNFIT],
  ] as const)("%s", async (_name, results, boundDigest, expected) => {
    const reply = (results as unknown as WslFileResult[])[0]!;
    // The walk created the candidate before a `candidate` reply, so its failure carries the read-back facts.
    const copied = reply.kind === "candidate" && "failure" in expected ? { copied: { index: reply.index, candidate: reply.candidate } } : {};
    expect<unknown>(await wslCopy(fake([[reply]]).ctx, "arbareto-candidate-1", boundDigest)).toEqual({ ...expected, ...copied });
  });

  test("a stop and a refusal", async () => {
    expect(await wslCopy(fake([CANCELED]).ctx, "arbareto-candidate-1", HEX_A)).toEqual(CANCELED);
    expect(await wslCopy(fake([REFUSAL()]).ctx, "arbareto-candidate-1", HEX_A)).toEqual({ code: "UNKNOWN_TARGET" });
  });
});

describe("removeCandidate (contract §4, the candidate form of remove)", () => {
  test("sends the name and the last verified digest, also after a cancel", async () => {
    const f = fake([[{ kind: "removed" }]]);
    f.cancel();
    expect(await removeCandidate(f.ctx, "arbareto-candidate-1", HEX_A)).toBe("removed");
    expect(f.body(0)).toEqual({ mode: "remove", bound: "MUTATION_RAW_INDEX_BYTES", candidate: "arbareto-candidate-1", expected: HEX_A });
    expect(f.signals[0]!.aborted).toBe(false);
  });

  test.each([
    ["notOwned", { kind: "notOwned" }, "notOwned"],
    ["error", { kind: "error", component: 0, code: "other-error" }, "remove-failed"],
  ] as const)("%s", async (_name, result, expected) => {
    expect(await removeCandidate(fake([[result as WslFileResult]]).ctx, "arbareto-candidate-1", HEX_A)).toBe(expected);
  });
});

describe("processEnd (contract §4 \"Process end\", decision G2)", () => {
  const exit = (activeDescendants: number | null, extra: Partial<GitExit> = {}): GitExit => ({ exitCode: 0, activeDescendants, ...extra });
  // A clock that moves only when the loop sleeps.
  function clock(): Clock & { slept: number[] } {
    let t = 0;
    const slept: number[] = [];
    return {
      slept,
      now: () => t,
      sleep: async (ms) => {
        slept.push(ms);
        t += ms;
      },
    };
  }

  test("count 0 is the fact: one mutation run of git version on a live signal", async () => {
    const f = fake([], [exit(0)]);
    f.cancel();
    expect(await processEnd(f.ctx, clock())).toBe("fact");
    expect(f.runs).toHaveLength(1);
    const run = f.runs[0]!;
    expect(run.arguments).toEqual(["--no-lazy-fetch", "version"]);
    expect(run).toMatchObject({ environmentPolicy: "mutation", limits: { deadlineMs: GIT_PROCESS_DEADLINE_MS } });
    expect(run.transaction).toBeUndefined();
    expect(run.signal.aborted).toBe(false);
  });

  test("a count above 0 repeats the run once per second until the count is 0", async () => {
    const f = fake([], [exit(2), exit(1), exit(0)]);
    const c = clock();
    expect(await processEnd(f.ctx, c)).toBe("fact");
    expect(f.runs).toHaveLength(3);
    expect(c.slept).toEqual([1000, 1000]);
    expect(f.runs.map((r) => r.limits)).toEqual([{ deadlineMs: 30_000 }, { deadlineMs: 29_000 }, { deadlineMs: 28_000 }]);
  });

  test("without count 0 within the 30-second Git process deadline, the result is no fact", async () => {
    const f = fake([], Array.from({ length: 40 }, () => exit(1)));
    expect(await processEnd(f.ctx, clock())).toBe("noFact");
    expect(f.runs).toHaveLength(GIT_PROCESS_DEADLINE_MS / 1000);
    expect(f.runs.at(-1)!.limits).toEqual({ deadlineMs: 1000 });
  });

  test.each([
    ["a run deadline", exit(0, { exitCode: null, deadline: "deadline" })],
    ["the diagnostic limit", exit(0, { diagnosticLimit: true })],
    ["a refusal after closeJob", new RunnerRefusal("UNKNOWN_TARGET")],
  ])("%s gives no fact", async (_name, reply) => {
    const f = fake([], [reply]);
    expect(await processEnd(f.ctx, clock())).toBe("noFact");
    expect(f.runs).toHaveLength(1);
  });

  test("a nonzero exit code with count 0 is the fact, because the contract keys the fact on the count alone", async () => {
    expect(await processEnd(fake([], [exit(0, { exitCode: 1 })]).ctx, clock())).toBe("fact");
  });

  // T116 B3-1: contract §6 `activeDescendants` null and `exitCode` null are no fact, and the run repeats.
  test.each([
    ["an exit without a count", exit(null)],
    ["an exit with exitCode null and count 0, because a Job close ended the run or none started", exit(0, { exitCode: null })],
  ])("%s is no fact, and the next run decides", async (_name, first) => {
    const f = fake([], [first, exit(0)]);
    const c = clock();
    expect(await processEnd(f.ctx, c)).toBe("fact");
    expect({ runs: f.runs.length, slept: c.slept }).toEqual({ runs: 2, slept: [1000] });
  });

  test("exits without a count until the 30-second Git process deadline give no fact", async () => {
    const f = fake([], Array.from({ length: 40 }, () => exit(null)));
    expect(await processEnd(f.ctx, clock())).toBe("noFact");
    expect(f.runs).toHaveLength(GIT_PROCESS_DEADLINE_MS / 1000);
  });
});
