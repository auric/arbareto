// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T002: the feature 005 contract changes (contract Δ1 to Δ3, Δ5, Δ6, Δ9, Δ10; data-model §1, §2, §6, §7, §10; spec FR-001, FR-004).

import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { printOrigin } from "../origin";
import * as channel from "../../src/contracts/channel";
import * as envelope from "../../src/contracts/envelope";
import * as errors from "../../src/contracts/errors";
import * as limits from "../../src/contracts/limits";
import { isWindows } from "../../src/contracts/native-path";
import * as operations from "../../src/contracts/operations";

printOrigin("../../src/contracts/channel.ts", import.meta.dir);
printOrigin("../../src/contracts/envelope.ts", import.meta.dir);
printOrigin("../../src/contracts/errors.ts", import.meta.dir);
printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/contracts/operations.ts", import.meta.dir);

// The module namespaces give `undefined` for a missing export, so each case fails on its own before T004.
const L = limits as unknown as Record<string, number>;
const E = errors as unknown as Record<string, readonly string[] | undefined>;
const P = channel as unknown as Record<string, z.ZodType | readonly string[] | undefined>;
const V = envelope as unknown as Record<string, z.ZodType | undefined>;

const KIB = 1024;
const MIB = 1024 * KIB;
const OID = "0123456789abcdef0123456789abcdef01234567";
const OID2 = "89abcdef0123456789abcdef0123456789abcdef";
const DIGEST = "a".repeat(64);
const REPO = isWindows ? "C:\\repo" : "/repo";
const SEP = isWindows ? "\\" : "/";
const id = () => crypto.randomUUID();
const b64 = (text: string | Uint8Array) => Buffer.from(text).toString("base64");
// A missing schema refuses every value, so the case fails instead of throwing.
const ok = (schema: z.ZodType | readonly string[] | undefined, value: unknown) => (schema as z.ZodType | undefined)?.safeParse(value).success ?? false;

const request = (operation: string, payload: unknown, target: Record<string, unknown> = {}) => ({ version: 1, sessionId: id(), requestId: id(), operation, ...target, payload });
const check = (value: unknown, side: "renderer" | "service" = "renderer") => {
  const result = envelope.validateRequest(value, side);
  return result.ok ? "ok" : result.code;
};
const gen = () => ({ repositoryId: id(), repositoryGeneration: 3 });
const repo = () => ({ repositoryId: id() });
const OPTIONS = { ignoreWhitespace: false, detectMoves: true, detectCopies: false, ignoreList: true };

const NEW_OPERATIONS = ["readCommitChanges", "readCommitFile", "readBlame", "readIgnoreFile", "previewIgnore", "openSubmodule"];
const NEW_READS = NEW_OPERATIONS.filter((name) => name !== "openSubmodule");
const SAMPLE: Record<string, () => unknown> = {
  readCommitChanges: () => ({ viewId: id(), oid: OID, parent: 0 }),
  readCommitFile: () => ({ changesId: id(), fileId: 0 }),
  readBlame: () => ({ source: { changesId: id(), fileId: 3 }, options: OPTIONS }),
  readIgnoreFile: () => ({ target: "gitignore" }),
  previewIgnore: () => ({ target: "exclude", text: b64("/build/\n"), snapshotId: id() }),
};

describe("contract Δ5 bounds", () => {
  test("each named bound has its contract value", () => {
    expect(L.PUBLIC_REQUEST_BYTES).toBe(2_097_152);
    expect(L.PUBLIC_FRAME_BODY_BYTES).toBe(2_097_152 + 28);
    expect(L.COMMIT_CHANGES_RESULT_BYTES).toBe(8 * MIB);
    expect(L.COMMIT_CHANGES_RESULT_BYTES).toBe(limits.HISTORY_PAGE_BYTES);
    expect(L.BLAME_FILE_BYTES).toBe(4 * MIB);
    expect(L.BLAME_FILE_BYTES).toBe(limits.CANONICAL_DIFF_BYTES);
    expect(L.BLAME_FILE_LINES).toBe(100_000);
    expect(L.BLAME_OUTPUT_BYTES).toBe(32 * MIB);
    expect(L.BLAME_OUTPUT_BYTES).toBe(limits.STATUS_LISTING_BYTES);
    expect(L.BLAME_RESULT_BYTES).toBe(12 * MIB);
    expect(L.BLAME_RESULT_BYTES).toBeLessThan(limits.PIPE_FRAME_BYTES);
    expect(L.BLAME_PROGRESS_EVENTS_PER_SECOND).toBe(4);
    expect(L.IGNORE_TARGET_BYTES).toBe(1 * MIB);
    expect(L.PREVIEW_PATHS).toBe(100_000);
    expect(L.PREVIEW_IGNORE_FILES).toBe(10_000);
    expect(L.PREVIEW_GROUP_PATHS).toBe(1000);
  });

  test("the reused bounds keep their values", () => {
    expect(limits.STATUS_LISTING_RECORDS).toBe(100_000);
    expect(limits.CANONICAL_DIFF_LINES).toBe(20_000);
    expect(limits.HISTORY_PARENTS_PER_COMMIT).toBe(64);
    expect(limits.HISTORY_PROCESS_DEADLINE_MS).toBe(120_000);
    expect(limits.MULTI_FILE_ACTION_FILES).toBe(10_000);
    expect(limits.FILE_FACT_ENTRIES).toBe(64);
    expect(limits.SUBMODULE_REVIEW_NESTING_LEVELS).toBe(8);
  });

  // Plan.md O-6: base64 needs no JSON escape, so a 1 MiB text takes 4 × ⌈1,048,576 / 3⌉ = 1,398,104 bytes.
  test("a previewIgnore request with 1 MiB of text as base64 fits one public request", () => {
    const text = b64(new Uint8Array(MIB).fill(0x61));
    expect(text.length).toBe(1_398_104);
    const bytes = new TextEncoder().encode(JSON.stringify(request("previewIgnore", { target: "gitignore", text, snapshotId: id() }, gen())));
    expect(bytes.length).toBeLessThanOrEqual(2_097_152);
    expect(envelope.decodeRequest(bytes, "renderer")).toMatchObject({ ok: true });
    const save = new TextEncoder().encode(JSON.stringify(request("reviewWorkbench", { action: "ignore-save", target: "gitignore", text, expected: { size: MIB, sha256: DIGEST } }, gen())));
    expect(envelope.decodeRequest(save, "renderer")).toMatchObject({ ok: true });
  });

  test("a bound name is an OUTPUT_LIMIT reason", () => {
    for (const reason of ["COMMIT_CHANGES_RESULT_BYTES", "BLAME_FILE_BYTES", "BLAME_FILE_LINES", "BLAME_OUTPUT_BYTES", "BLAME_RESULT_BYTES", "PREVIEW_PATHS", "PREVIEW_IGNORE_FILES", "IGNORE_TARGET_BYTES"]) {
      expect(ok(envelope.Completeness, { state: "limited", code: "OUTPUT_LIMIT", reason })).toBe(true);
    }
  });
});

describe("contract Δ9 codes", () => {
  test("errors.ts holds BLAME_UNAVAILABLE and SUBMODULE_UNAVAILABLE, and each fits a failed or rejected response", () => {
    for (const code of ["BLAME_UNAVAILABLE", "SUBMODULE_UNAVAILABLE"]) {
      expect(errors.isErrorCode(code)).toBe(true);
      expect(errors.codeFitsState("failed", code)).toBe(true);
      expect(errors.codeFitsState("rejected", code)).toBe(true);
    }
  });

  test("each new code has exactly its contract reasons", () => {
    expect([...(E.BLAME_UNAVAILABLE_REASONS ?? [])]).toEqual(["no-history", "binary", "submodule", "size", "lines", "ignore-revs-file-missing", "no-previous", "path"]);
    expect([...(E.SUBMODULE_UNAVAILABLE_REASONS ?? [])]).toEqual(["not-submodule", "submodule-not-initialized", "path"]);
    // Feature 008 contract Δ9 adds `revert-changed`.
    expect([...(E.STALE_REVIEW_REASONS ?? [])]).toEqual(["files-changed", "ignore-changed", "revert-changed"]);
    expect([...(E.UNKNOWN_TARGET_REASONS ?? [])]).toEqual(["absent"]);
  });

  test("WORKBENCH_UNAVAILABLE adds the feature 005 reasons, keeps the other 004 ignore reasons, and removes ignore-exists and ignore-not-text (T057)", () => {
    const added = ["conflicted", "submodule", "nested-repository", "no-recycle-bin", "long-path", "nothing-to-delete", "ignore-link", "ignore-folder", "ignore-not-utf8", "ignore-nul", "ignore-lone-cr"];
    const kept = ["ignore-not-regular", "ignore-size", "limit", "path", "unreadable"];
    expect(errors.WORKBENCH_UNAVAILABLE_REASONS).toEqual(expect.arrayContaining([...added, ...kept] as never[]));
    expect(new Set(errors.WORKBENCH_UNAVAILABLE_REASONS).size).toBe(errors.WORKBENCH_UNAVAILABLE_REASONS.length);
    for (const reason of ["ignore-exists", "ignore-not-text"]) {
      expect(errors.WORKBENCH_UNAVAILABLE_REASONS).not.toContain(reason as never);
      expect(ok(envelope.ReviewWorkbenchResult, { reason })).toBe(false);
    }
  });

  test("a response carries each new code", () => {
    for (const code of ["BLAME_UNAVAILABLE", "SUBMODULE_UNAVAILABLE"]) {
      expect(ok(envelope.Response, { requestId: id(), operationId: id(), state: "failed", code, result: { reason: "path" } })).toBe(true);
    }
  });
});

describe("contract Δ1 operations", () => {
  test("the operation list holds the six new operations, and the shell forwards each one", () => {
    expect(operations.OPERATIONS).toEqual(expect.arrayContaining(NEW_OPERATIONS));
    for (const name of NEW_OPERATIONS) expect(operations.SHELL_ONLY).not.toContain(name as never);
    for (const name of NEW_OPERATIONS) expect(operations.MUTATIONS).not.toContain(name as never);
  });

  test("only openSubmodule is native-first", () => {
    const names = (envelope.NativeFirstEnvelope.options as readonly { shape: { operation: { value: string } } }[]).map((o) => o.shape.operation.value);
    expect(names).toContain("openSubmodule");
    for (const name of NEW_READS) expect(names).not.toContain(name);
  });
});

describe("contract Δ2 envelope", () => {
  test("the five new reads carry repositoryId and repositoryGeneration on both sides", () => {
    for (const name of NEW_READS) {
      for (const side of ["renderer", "service"] as const) {
        expect({ name, side, code: check(request(name, SAMPLE[name]!(), gen()), side) }).toEqual({ name, side, code: "ok" });
        expect(check(request(name, SAMPLE[name]!(), repo()), side)).toBe("INVALID_REQUEST");
        expect(check(request(name, SAMPLE[name]!()), side)).toBe("INVALID_REQUEST");
      }
    }
  });

  test("an unknown payload field gives INVALID_REQUEST", () => {
    for (const name of NEW_READS) expect(check(request(name, { ...(SAMPLE[name]!() as object), extra: 1 }, gen()))).toBe("INVALID_REQUEST");
    expect(check(request("openSubmodule", { repositoryId: id(), path: "lib/core", extra: 1 }))).toBe("INVALID_REQUEST");
  });

  test("openSubmodule carries the parent repositoryId in the payload, and the shell forwards its bootstrapId", () => {
    expect(check(request("openSubmodule", { repositoryId: id(), path: "lib/core" }))).toBe("ok");
    expect(ok(envelope.NativeFirstEnvelope, request("openSubmodule", { repositoryId: id(), path: "lib/core" }))).toBe(true);
    expect(check(request("openSubmodule", { repositoryId: id(), path: "lib/core" }, repo()))).toBe("INVALID_REQUEST");
    expect(check(request("openSubmodule", { repositoryId: id(), bootstrapId: id(), path: "lib/core" }), "service")).toBe("ok");
    expect(check(request("openSubmodule", { repositoryId: id(), path: "lib/core" }), "service")).toBe("INVALID_REQUEST");
    expect(check(request("openSubmodule", { repositoryId: id(), bootstrapId: id(), path: "lib" }))).toBe("INVALID_REQUEST");
  });

  test("an openSubmodule path with an empty, `.`, or `..` component gives INVALID_REQUEST", () => {
    for (const path of ["", "lib//core", "/lib", "lib/", ".", "lib/./core", "..", "lib/../x"]) expect({ path, code: check(request("openSubmodule", { repositoryId: id(), path })) }).toEqual({ path, code: "INVALID_REQUEST" });
    for (const path of ["lib", "a/b/c", ".hidden", "x..y"]) expect(check(request("openSubmodule", { repositoryId: id(), path }))).toBe("ok");
  });

  test("MUTATIONS gains no operation", () => {
    expect([...operations.MUTATIONS].toSorted()).toEqual(["applyFile", "applyFiles", "applyHunk", "commit", "runWorkbench", "sync", "updateSubmodules"]);
  });
});

describe("contract Δ2 progress", () => {
  const event = (phase: string, counters: Record<string, number> = {}, extra: Record<string, unknown> = {}) => ({ requestId: id(), operationId: id(), state: "running", phase, counters, stalled: false, ...extra });

  test("the 004 phase ignore goes with its producer (review fix 11)", () => {
    expect<readonly string[]>(operations.PHASES).not.toContain("ignore");
    expect(ok(envelope.ProgressEvent, event("ignore"))).toBe(false);
  });

  test("the four new phases exist", () => {
    expect(operations.PHASES).toEqual(expect.arrayContaining(["blame", "delete-files", "ignore-save", "preview"]));
    for (const phase of ["blame", "delete-files", "ignore-save", "preview"]) expect(ok(envelope.ProgressEvent, event(phase))).toBe(true);
  });

  test("blame counts blamed and total lines, delete-files counts files, and ignore-save and preview carry no counter", () => {
    expect(ok(envelope.ProgressEvent, event("blame", { blamed: 120, total: 4000 }))).toBe(true);
    expect(ok(envelope.ProgressEvent, event("delete-files", { fileIndex: 3, fileCount: 10 }))).toBe(true);
    expect(ok(envelope.ProgressEvent, event("blame", { fileIndex: 1 }))).toBe(false);
    expect(ok(envelope.ProgressEvent, event("delete-files", { blamed: 1 }))).toBe(false);
    for (const phase of ["ignore-save", "preview"]) for (const counter of ["blamed", "fileIndex", "percent"]) expect(ok(envelope.ProgressEvent, event(phase, { [counter]: 1 }))).toBe(false);
  });

  test("an event carries no path, ref name, or Git text", () => {
    for (const phase of ["blame", "delete-files", "ignore-save", "preview"]) {
      expect(ok(envelope.ProgressEvent, event(phase, {}, { path: "src/a.ts" }))).toBe(false);
      for (const field of ["ref", "text", "line"]) expect(ok(envelope.ProgressEvent, event(phase, {}, { [field]: "x" }))).toBe(false);
    }
  });
});

describe("contract Δ3 payloads", () => {
  const read = (name: string, payload: unknown) => check(request(name, payload, gen()));

  test("readCommitChanges takes viewId, oid, and a parent index from 0 to 63", () => {
    for (const parent of [0, 1, 63]) expect(read("readCommitChanges", { viewId: id(), oid: OID, parent })).toBe("ok");
    expect(read("readCommitChanges", { viewId: id(), oid: "b".repeat(64), parent: 0 })).toBe("ok");
    for (const parent of [-1, 64, 1.5, "0", null]) expect(read("readCommitChanges", { viewId: id(), oid: OID, parent })).toBe("INVALID_REQUEST");
    for (const oid of ["HEAD", OID.toUpperCase(), OID.slice(1)]) expect(read("readCommitChanges", { viewId: id(), oid, parent: 0 })).toBe("INVALID_REQUEST");
    expect(read("readCommitChanges", { viewId: id(), oid: OID })).toBe("INVALID_REQUEST");
  });

  test("readCommitFile takes changesId and a record ordinal", () => {
    expect(read("readCommitFile", { changesId: id(), fileId: 0 })).toBe("ok");
    expect(read("readCommitFile", { changesId: id(), fileId: limits.STATUS_LISTING_RECORDS - 1 })).toBe("ok");
    for (const fileId of [-1, limits.STATUS_LISTING_RECORDS, 0.5, id()]) expect(read("readCommitFile", { changesId: id(), fileId })).toBe("INVALID_REQUEST");
    expect(read("readCommitFile", { changesId: "c", fileId: 0 })).toBe("INVALID_REQUEST");
  });

  test("readBlame takes one of the four source forms and the four booleans", () => {
    for (const source of [{ changesId: id(), fileId: 2 }, { snapshotId: id(), entryId: id() }, { blameId: id(), line: 1 }, { blameId: id(), line: 100_000 }, { blameId: id() }]) {
      expect(read("readBlame", { source, options: OPTIONS })).toBe("ok");
    }
    for (const source of [{ blameId: id(), line: 0 }, { blameId: id(), line: 100_001 }, { changesId: id(), entryId: id() }, { changesId: id(), fileId: 1, line: 2 }, { blameId: id(), focusLine: 2 }, {}]) {
      expect(read("readBlame", { source, options: OPTIONS })).toBe("INVALID_REQUEST");
    }
    const { ignoreList: _omit, ...three } = OPTIONS;
    for (const options of [three, { ...OPTIONS, ignoreWhitespace: "true" }, { ...OPTIONS, revs: "x" }]) {
      expect(read("readBlame", { source: { changesId: id(), fileId: 0 }, options })).toBe("INVALID_REQUEST");
    }
  });

  test("readIgnoreFile names the gitignore or the exclude target", () => {
    for (const target of ["gitignore", "exclude"]) expect(read("readIgnoreFile", { target })).toBe("ok");
    for (const target of ["info/exclude", ".gitignore", ""]) expect(read("readIgnoreFile", { target })).toBe("INVALID_REQUEST");
  });

  test("previewIgnore text is base64 of at most 1 MiB of strict UTF-8 without NUL", () => {
    const preview = (text: unknown) => read("previewIgnore", { target: "gitignore", text, snapshotId: id() });
    expect(preview("")).toBe("ok");
    expect(preview(b64("*.log\n!keep.log\n# é\n"))).toBe("ok");
    expect(preview(b64(new Uint8Array(MIB).fill(0x61)))).toBe("ok");
    expect(preview(b64(new Uint8Array(MIB + 1).fill(0x61)))).toBe("INVALID_REQUEST");
    expect(preview(b64(Uint8Array.of(0x61, 0x00, 0x62)))).toBe("INVALID_REQUEST");
    expect(preview(b64(Uint8Array.of(0xff, 0x0a)))).toBe("INVALID_REQUEST");
    expect(preview(b64(Uint8Array.of(0xed, 0xa0, 0x80)))).toBe("INVALID_REQUEST");
    expect(preview("*.log")).toBe("INVALID_REQUEST");
    expect(read("previewIgnore", { target: "gitignore", text: "" })).toBe("INVALID_REQUEST");
  });

  test("previewIgnore takes an optional lineEnding lf or crlf (plan.md D9)", () => {
    const preview = (fields: Record<string, unknown>) => read("previewIgnore", { target: "gitignore", text: b64("a\n"), snapshotId: id(), ...fields });
    for (const lineEnding of ["lf", "crlf"]) expect(preview({ lineEnding })).toBe("ok");
    for (const lineEnding of ["none", "mixed", "cr", null]) expect(preview({ lineEnding })).toBe("INVALID_REQUEST");
  });

  describe("reviewWorkbench", () => {
    const review = (payload: unknown, side: "renderer" | "service" = "renderer") => check(request("reviewWorkbench", payload, gen()), side);
    const del = (fields: Record<string, unknown> = {}) => ({ action: "delete", snapshotId: id(), entryIds: [id()], mode: "recycle", ...fields });

    test("delete takes 1 to 10,000 unique entry IDs, an optional folder, and the mode", () => {
      for (const side of ["renderer", "service"] as const) {
        expect(review(del(), side)).toBe("ok");
        expect(review(del({ mode: "permanent", folder: b64("logs") }), side)).toBe("ok");
      }
      expect(review(del({ entryIds: Array.from({ length: limits.MULTI_FILE_ACTION_FILES }, id) }))).toBe("ok");
      expect(review(del({ entryIds: Array.from({ length: limits.MULTI_FILE_ACTION_FILES + 1 }, id) }))).toBe("INVALID_REQUEST");
      const same = id();
      for (const fields of [{ entryIds: [] }, { entryIds: [same, same] }, { mode: "trash" }, { mode: undefined }, { folder: "" }, { folder: "logs/" }]) expect(review(del(fields))).toBe("INVALID_REQUEST");
    });

    test("ignore-save takes the target, the base64 text, and the expected state", () => {
      const save = (fields: Record<string, unknown> = {}) => ({ action: "ignore-save", target: "exclude", text: b64("/out/\n"), expected: "absent", ...fields });
      for (const side of ["renderer", "service"] as const) {
        expect(review(save(), side)).toBe("ok");
        expect(review(save({ expected: { size: 12, sha256: DIGEST } }), side)).toBe("ok");
      }
      expect(review(save({ text: "" }))).toBe("ok");
      for (const lineEnding of ["lf", "crlf"]) expect(review(save({ lineEnding }))).toBe("ok");
      for (const lineEnding of ["none", "mixed", "cr", null]) expect(review(save({ lineEnding }))).toBe("INVALID_REQUEST");
      // Contract Δ3: a NUL in the text gives the review refusal `ignore-nul`, so the schema passes it.
      expect(review(save({ text: b64("a\u0000b") }))).toBe("ok");
      for (const fields of [{ expected: "present" }, { expected: { size: 1 } }, { expected: { size: MIB + 1, sha256: DIGEST } }, { target: "both" }, { text: "/out/" }, { text: b64(new Uint8Array(MIB + 1).fill(0x61)) }, { text: b64(Uint8Array.of(0xc3)) }]) {
        expect(review(save(fields))).toBe("INVALID_REQUEST");
      }
    });

    test("the 004 ignore action gives INVALID_REQUEST, and its plan and run results go (T057)", () => {
      for (const side of ["renderer", "service"] as const) {
        expect(review({ action: "ignore", snapshotId: id(), entryId: id(), target: "gitignore" }, side)).toBe("INVALID_REQUEST");
        expect(review({ action: "ignore", snapshotId: id(), entryId: id(), target: "exclude", folder: b64("logs") }, side)).toBe("INVALID_REQUEST");
      }
      expect(channel.WORKBENCH_ACTIONS).toEqual(expect.arrayContaining(["delete", "ignore-save"]));
      expect(channel.WORKBENCH_ACTIONS).not.toContain("ignore" as never);
      const plan = { target: "gitignore", path: b64("top-new.txt"), folder: false, line: "/top-new.txt", prefixNewline: false, expected: "absent" };
      expect(ok(envelope.ReviewWorkbenchResult, { action: "ignore", plan, workbenchToken: id() })).toBe(false);
      for (const result of [{ action: "ignore" }, { action: "ignore", reason: "ignore-not-regular" }]) expect(ok(envelope.RunWorkbenchResult, result)).toBe(false);
    });
  });

  test("revealPath takes an optional base64 folder", () => {
    for (const side of ["renderer", "service"] as const) {
      expect(check(request("revealPath", { repositoryId: id(), entryId: id(), folder: b64("src/gen") }), side)).toBe("ok");
      expect(check(request("revealPath", { repositoryId: id(), entryId: id() }), side)).toBe("ok");
    }
    for (const folder of ["", "src/gen", 1]) expect(check(request("revealPath", { repositoryId: id(), entryId: id(), folder }))).toBe("INVALID_REQUEST");
  });
});

describe("contract Δ3 readRefs nameBytes (001 §3)", () => {
  const ref = { kind: "branch", name: "b�", invalidUtf8: true, objectId: OID, objectType: "commit", peeledId: null, peeledType: null, symref: null, upstream: null, upstreamPresent: false, commitId: OID };
  const list = (r: object) => ({ generation: 1, refs: [r], current: null, refsDigest: "0".repeat(64), completeness: { state: "complete" } });
  test("an invalid UTF-8 name carries its raw bytes in base64, and a valid name carries none", () => {
    expect(ok(envelope.ReadRefsResult, list({ ...ref, nameBytes: btoa("b\xff") }))).toBe(true);
    expect(ok(envelope.ReadRefsResult, list(ref))).toBe(false);
    expect(ok(envelope.ReadRefsResult, list({ ...ref, name: "b", invalidUtf8: false, nameBytes: btoa("b") }))).toBe(false);
    expect(ok(envelope.ReadRefsResult, list({ ...ref, name: "b", invalidUtf8: false }))).toBe(true);
  });
});

describe("contract Δ3 readBranches", () => {
  const entry = { ref: "refs/heads/topic", kind: "local", name: "topic", invalidUtf8: false, oid: OID, upstream: "refs/remotes/origin/topic", tracking: null, heldBy: null, current: false, localName: null };
  test("an entry carries upstreamPresent, and true needs an upstream", () => {
    expect(ok(envelope.ReadBranchesResult, { entries: [{ ...entry, upstreamPresent: true }] })).toBe(true);
    expect(ok(envelope.ReadBranchesResult, { entries: [{ ...entry, upstreamPresent: false }] })).toBe(true);
    // WP2 review: null is an unpaired tracking entry, an unknown state. The field is required.
    expect(ok(envelope.ReadBranchesResult, { entries: [{ ...entry, upstreamPresent: null }] })).toBe(true);
    expect(ok(envelope.ReadBranchesResult, { entries: [entry] })).toBe(false);
    expect(ok(envelope.ReadBranchesResult, { entries: [{ ...entry, upstream: null, upstreamPresent: false }] })).toBe(true);
    expect(ok(envelope.ReadBranchesResult, { entries: [{ ...entry, upstream: null, upstreamPresent: true }] })).toBe(false);
    expect(ok(envelope.ReadBranchesResult, { entries: [{ ...entry, upstreamPresent: "yes" }] })).toBe(false);
  });
});

describe("data-model §1 commit changes", () => {
  const file = (fileId: number, fields: Record<string, unknown> = {}) => ({ fileId, status: "modified", pathBytes: b64(`f${fileId}`), kind: "file", ...fields });
  const changes = (fields: Record<string, unknown> = {}) => ({
    changesId: id(),
    viewId: id(),
    oid: OID,
    parents: [OID2],
    base: { kind: "parent", index: 0, oid: OID2 },
    files: [file(0), file(1, { status: "renamed", score: 92, oldPathBytes: b64("old"), pathBytes: b64("new") }), file(2, { status: "added", kind: "submodule" })],
    completeness: { state: "complete" },
    ...fields,
  });
  const R = () => V.ReadCommitChangesResult;

  test("a listing with each status and kind fits", () => {
    expect(ok(R(), changes())).toBe(true);
    const all = ["added", "deleted", "modified", "type-changed"].map((status, i) => file(i, { status, kind: ["file", "link", "submodule", "file"][i] }));
    expect(ok(R(), changes({ files: all }))).toBe(true);
  });

  test("the base is a parent of the row, the empty tree of a root, or shallow with no files", () => {
    expect(ok(R(), changes({ parents: [], base: { kind: "empty-tree", oid: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" } }))).toBe(true);
    expect(ok(R(), changes({ parents: [], base: { kind: "shallow" }, files: [] }))).toBe(true);
    expect(ok(R(), changes({ parents: [], base: { kind: "shallow" } }))).toBe(false);
    expect(ok(R(), changes({ base: { kind: "parent", index: 1, oid: OID2 } }))).toBe(false);
    expect(ok(R(), changes({ base: { kind: "parent", index: 0, oid: OID } }))).toBe(false);
    expect(ok(R(), changes({ base: { kind: "empty-tree", oid: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" } }))).toBe(false);
    expect(ok(R(), changes({ parents: Array.from({ length: 65 }, () => OID2) }))).toBe(false);
  });

  test("a renamed entry carries its score and old path, and no other entry does", () => {
    expect(ok(R(), changes({ files: [file(0, { status: "renamed", oldPathBytes: b64("a") })] }))).toBe(false);
    expect(ok(R(), changes({ files: [file(0, { status: "renamed", score: 101, oldPathBytes: b64("a") })] }))).toBe(false);
    expect(ok(R(), changes({ files: [file(0, { score: 50 })] }))).toBe(false);
    expect(ok(R(), changes({ files: [file(0, { oldPathBytes: b64("a") })] }))).toBe(false);
    for (const status of ["copied", "unmerged", "C", "M"]) expect(ok(R(), changes({ files: [file(0, { status })] }))).toBe(false);
  });

  test("fileId is the record ordinal", () => {
    expect(ok(R(), changes({ files: [file(1)] }))).toBe(false);
    expect(ok(R(), changes({ files: [file(0), file(0)] }))).toBe(false);
  });

  test("a limited listing names its bound and the shown count", () => {
    for (const reason of ["STATUS_LISTING_RECORDS", "STATUS_LISTING_BYTES", "COMMIT_CHANGES_RESULT_BYTES"]) {
      expect(ok(R(), changes({ completeness: { state: "limited", code: "OUTPUT_LIMIT", reason, shown: 3 } }))).toBe(true);
    }
    expect(ok(R(), changes({ completeness: { state: "limited", code: "OUTPUT_LIMIT", reason: "STATUS_LISTING_RECORDS", shown: 2 } }))).toBe(false);
    expect(ok(R(), changes({ completeness: { state: "limited", code: "OUTPUT_LIMIT", reason: "BLAME_FILE_LINES", shown: 3 } }))).toBe(false);
    expect(ok(R(), changes({ completeness: { state: "limited", code: "OBJECT_MISSING", shown: 3 } }))).toBe(false);
  });

  test("a missing object carries the 001 remedy and no listing", () => {
    expect(ok(R(), { remedy: { text: "Fetch the missing objects." } })).toBe(true);
    expect(ok(R(), { remedy: { text: "" } })).toBe(false);
    expect(ok(R(), { ...changes(), extra: 1 })).toBe(false);
  });
});

describe("data-model §2 commit file", () => {
  const commitFile = (fields: Record<string, unknown> = {}) => ({ changesId: id(), fileId: 1, facts: {}, binary: false, patch: b64("diff --git a/x b/x\n"), completeness: { state: "complete" }, ...fields });
  const R = () => V.ReadCommitFileResult;

  test("a patch, a rename, a mode change, a submodule, and a type change fit", () => {
    expect(ok(R(), commitFile())).toBe(true);
    expect(ok(R(), commitFile({ facts: { rename: { oldPath: b64("old"), score: 100 } }, patch: null }))).toBe(true);
    expect(ok(R(), commitFile({ facts: { mode: { old: "100644", new: "100755" } } }))).toBe(true);
    expect(ok(R(), commitFile({ facts: { submodule: { old: OID, new: null } }, patch: null }))).toBe(true);
    expect(ok(R(), commitFile({ facts: { typeChange: { old: "file", new: "link" } }, patch: null }))).toBe(true);
  });

  test("a binary file, a submodule, and a type change carry no patch", () => {
    expect(ok(R(), commitFile({ binary: true, patch: null }))).toBe(true);
    expect(ok(R(), commitFile({ binary: true }))).toBe(false);
    expect(ok(R(), commitFile({ facts: { submodule: { old: OID, new: OID2 } } }))).toBe(false);
    expect(ok(R(), commitFile({ facts: { typeChange: { old: "file", new: "submodule" } } }))).toBe(false);
  });

  test("the facts take only their contract forms", () => {
    expect(ok(R(), commitFile({ facts: { mode: { old: "644", new: "100755" } } }))).toBe(false);
    expect(ok(R(), commitFile({ facts: { typeChange: { old: "file", new: "folder" } } }))).toBe(false);
    expect(ok(R(), commitFile({ facts: { rename: { oldPath: "", score: 50 } } }))).toBe(false);
    expect(ok(R(), commitFile({ facts: { copy: {} } }))).toBe(false);
  });

  test("a limited patch names a canonical diff bound, and a missing object carries the remedy", () => {
    for (const reason of ["CANONICAL_DIFF_BYTES", "CANONICAL_DIFF_LINES"]) expect(ok(R(), commitFile({ completeness: { state: "limited", code: "OUTPUT_LIMIT", reason } }))).toBe(true);
    expect(ok(R(), commitFile({ completeness: { state: "limited", code: "OUTPUT_LIMIT", reason: "BLAME_FILE_BYTES" } }))).toBe(false);
    expect(ok(R(), commitFile({ patch: null, completeness: { state: "limited", code: "OBJECT_MISSING" }, remedy: { text: "Fetch." } }))).toBe(true);
    expect(ok(R(), commitFile({ patch: null, completeness: { state: "limited", code: "OBJECT_MISSING" } }))).toBe(false);
    expect(ok(R(), commitFile({ remedy: { text: "Fetch." } }))).toBe(false);
  });

  test("an UNSUPPORTED_COMPARISON refusal names reason path, the 001 reason of a path that is no valid UTF-8", () => {
    expect(ok(R(), { reason: "path" })).toBe(true);
    expect(ok(R(), { reason: "binary" })).toBe(false);
    expect(ok(R(), { ...commitFile(), reason: "path" })).toBe(false);
  });
});

describe("data-model §6 ignore file", () => {
  const file = (fields: Record<string, unknown> = {}) => ({ target: "gitignore", file: `${REPO}${SEP}.gitignore`, state: "file", text: "*.log\n", lineEnding: "crlf", bom: true, expected: { size: 10, sha256: DIGEST }, ...fields });
  const R = () => V.ReadIgnoreFileResult;

  test("a file and an absent file fit", () => {
    expect(ok(R(), file())).toBe(true);
    expect(ok(R(), file({ target: "exclude", file: "/home/u/repo/.git/info/exclude", lineEnding: "lf", bom: false }))).toBe(true);
    expect(ok(R(), file({ state: "absent", text: "", lineEnding: "none", bom: false, expected: "absent" }))).toBe(true);
  });

  test("a mixed file carries lineCounts with at least 1 of each form; no other result carries them", () => {
    expect(ok(R(), file({ lineEnding: "mixed", lineCounts: { lf: 1, crlf: 2 } }))).toBe(true);
    expect(ok(R(), file({ lineEnding: "mixed" }))).toBe(false);
    for (const lineCounts of [{ lf: 0, crlf: 1 }, { lf: 1, crlf: 0 }, { lf: 1 }, { lf: 1, crlf: 1, cr: 1 }, { lf: -1, crlf: 1 }]) expect(ok(R(), file({ lineEnding: "mixed", lineCounts }))).toBe(false);
    for (const lineEnding of ["lf", "crlf", "none"]) expect(ok(R(), file({ lineEnding, lineCounts: { lf: 1, crlf: 1 } }))).toBe(false);
  });

  test("an absent file has no text, no BOM, no line ending, and expected absent", () => {
    expect(ok(R(), file({ state: "absent", text: "x", lineEnding: "none", bom: false, expected: "absent" }))).toBe(false);
    expect(ok(R(), file({ state: "absent", text: "", lineEnding: "none", bom: false }))).toBe(false);
    expect(ok(R(), file({ expected: "absent" }))).toBe(false);
    expect(ok(R(), file({ state: "absent", text: "", lineEnding: "lf", bom: false, expected: "absent" }))).toBe(false);
  });

  test("the text holds no NUL and at most 1 MiB, and the fact holds at most 1 MiB", () => {
    expect(ok(R(), file({ text: "a\u0000" }))).toBe(false);
    expect(ok(R(), file({ text: "a".repeat(MIB + 1) }))).toBe(false);
    expect(ok(R(), file({ expected: { size: MIB + 1, sha256: DIGEST } }))).toBe(false);
    expect(ok(R(), file({ lineEnding: "cr" }))).toBe(false);
  });

  test("a refusal names one readIgnoreFile reason", () => {
    for (const reason of ["ignore-link", "ignore-folder", "ignore-not-regular", "ignore-size", "ignore-not-utf8", "ignore-nul", "ignore-lone-cr", "unreadable", "path"]) expect(ok(R(), { reason })).toBe(true);
    for (const reason of ["ignore-exists", "conflicted", "absent"]) expect(ok(R(), { reason })).toBe(false);
  });
});

describe("data-model §7 ignore preview", () => {
  const group = (count: number) => ({ count, paths: Array.from({ length: Math.min(count, 1000) }, (_, i) => b64(`p${i}`)) });
  const preview = (fields: Record<string, unknown> = {}) => ({ preview: { newlyIgnored: group(2), noLongerIgnored: group(0), trackedMatched: 1, notices: { entries: [{ kind: "link", pathBytes: b64("ln") }, { kind: "inside-ignored", pathBytes: b64("out/.gitignore") }], more: 0 }, ...fields } });
  const R = () => V.PreviewIgnoreResult;

  test("a preview fits, with at most 1,000 paths per group and 100 notices", () => {
    expect(ok(R(), preview())).toBe(true);
    expect(ok(R(), preview({ newlyIgnored: group(5000) }))).toBe(true);
    expect(ok(R(), preview({ newlyIgnored: { count: 5000, paths: group(1001).paths.concat(b64("x")) } }))).toBe(false);
    expect(ok(R(), preview({ newlyIgnored: { count: 3, paths: group(2).paths } }))).toBe(false);
    const notices = Array.from({ length: 100 }, (_, i) => ({ kind: "link", pathBytes: b64(`l${i}`) }));
    expect(ok(R(), preview({ notices: { entries: notices, more: 7 } }))).toBe(true);
    expect(ok(R(), preview({ notices: { entries: [...notices, notices[0]], more: 7 } }))).toBe(false);
    expect(ok(R(), preview({ notices: { entries: [{ kind: "folder", pathBytes: b64("x") }], more: 0 } }))).toBe(false);
  });

  test("unavailable names its reason and an optional bound", () => {
    for (const reason of ["paths", "listing", "name-case", "shadow-copy", "self-check", "unreadable", "deadline"]) expect(ok(R(), { unavailable: { reason } })).toBe(true);
    expect(ok(R(), { unavailable: { reason: "paths", bound: "PREVIEW_PATHS" } })).toBe(true);
    expect(ok(R(), { unavailable: { reason: "listing", bound: "STATUS_LISTING_RECORDS" } })).toBe(true);
    expect(ok(R(), { unavailable: { reason: "partial" } })).toBe(false);
    expect(ok(R(), { unavailable: { reason: "paths", bound: "NOT_A_BOUND" } })).toBe(false);
    expect(ok(R(), { ...preview(), unavailable: { reason: "paths" } })).toBe(false);
  });
});

describe("data-model §10 blame", () => {
  const commit = (fields: Record<string, unknown> = {}) => ({
    oid: OID,
    author: b64("A U Thor"),
    authorMail: b64("<a@example.test>"),
    authorTime: 1_700_000_000,
    authorTz: "+0200",
    summary: b64("Add parser"),
    previous: { oid: OID2, pathBytes: b64("src/old.ts") },
    filenameBytes: b64("src/a.ts"),
    shallow: false,
    ...fields,
  });
  const group = (finalStart: number, count: number, fields: Record<string, unknown> = {}) => ({ commit: 0, origStart: finalStart, finalStart, count, ignored: false, unblamable: false, ...fields });
  const blame = (fields: Record<string, unknown> = {}) => ({ blameId: id(), commit: OID, pathBytes: b64("src/a.ts"), content: b64("a\nb\nc\n"), lines: 3, ignoreList: "none", groups: [group(1, 2), group(3, 1, { commit: 1, ignored: true })], commits: [commit(), commit({ oid: OID2, previous: null, shallow: true })], ...fields });
  const R = () => V.ReadBlameResult;

  test("a result whose groups cover 1 to N fits", () => {
    expect(ok(R(), blame())).toBe(true);
    for (const ignoreList of ["on", "off"]) expect(ok(R(), blame({ ignoreList }))).toBe(true);
    expect(ok(R(), blame({ content: "", lines: 0, groups: [], commits: [] }))).toBe(true);
  });

  test("focusLine is an integer from 1 to lines, and absent when lines is 0", () => {
    for (const focusLine of [1, 3]) expect(ok(R(), blame({ focusLine }))).toBe(true);
    for (const focusLine of [0, 4, 1.5, "2"]) expect(ok(R(), blame({ focusLine }))).toBe(false);
    expect(ok(R(), blame({ content: "", lines: 0, groups: [], commits: [], focusLine: 1 }))).toBe(false);
  });

  test("a gap, an overlap, a group past N, or an unknown commit index refuses the result", () => {
    expect(ok(R(), blame({ groups: [group(1, 1), group(3, 1)] }))).toBe(false);
    expect(ok(R(), blame({ groups: [group(1, 2), group(2, 2)] }))).toBe(false);
    expect(ok(R(), blame({ groups: [group(1, 4)] }))).toBe(false);
    expect(ok(R(), blame({ groups: [group(1, 2)] }))).toBe(false);
    expect(ok(R(), blame({ groups: [group(1, 3, { commit: 2 })] }))).toBe(false);
    expect(ok(R(), blame({ groups: [group(1, 3, { count: 0 })] }))).toBe(false);
  });

  test("the commit facts take their contract forms", () => {
    expect(ok(R(), blame({ commits: [commit({ authorTz: "0200" }), commit()] }))).toBe(false);
    expect(ok(R(), blame({ commits: [commit({ authorTime: 1.5 }), commit()] }))).toBe(false);
    expect(ok(R(), blame({ commits: [commit({ previous: { oid: "HEAD", pathBytes: b64("x") } }), commit()] }))).toBe(false);
    expect(ok(R(), blame({ commits: [commit({ author: "A U Thor" }), commit()] }))).toBe(false);
    expect(ok(R(), blame({ ignoreList: "true" }))).toBe(false);
  });

  test("the content holds at most 4 MiB and the result at most 100,000 lines", () => {
    expect(ok(R(), blame({ lines: limits.BLAME_FILE_LINES + 1 }))).toBe(false);
    expect(ok(R(), blame({ content: b64(new Uint8Array(4 * MIB + 1)) }))).toBe(false);
  });

  test("a BLAME_UNAVAILABLE refusal names its reason, and only ignore-revs-file-missing carries the configured path", () => {
    for (const reason of E.BLAME_UNAVAILABLE_REASONS ?? []) {
      const value = reason === "ignore-revs-file-missing" ? { reason, path: ".git-blame-ignore-revs" } : { reason };
      expect(ok(R(), value)).toBe(true);
    }
    expect(ok(R(), { reason: "ignore-revs-file-missing" })).toBe(false);
    expect(ok(R(), { reason: "binary", path: "x" })).toBe(false);
    expect(ok(R(), { reason: "tracked" })).toBe(false);
    expect(ok(R(), { remedy: { text: "Fetch." } })).toBe(true);
    expect(ok(R(), { outputTail: "fatal: could not open object name list\n" })).toBe(true);
  });
});

describe("contract Δ3 other results", () => {
  test("openSubmodule gives the chooseRepository result or a SUBMODULE_UNAVAILABLE reason", () => {
    const R = V.OpenSubmoduleResult;
    expect(ok(R, { repositoryId: id(), generation: 0, worktreeKey: DIGEST, worktreeRoot: `${REPO}${SEP}lib` })).toBe(true);
    for (const reason of ["not-submodule", "submodule-not-initialized", "path"]) expect(ok(R, { reason })).toBe(true);
    expect(ok(R, { reason: "nested" })).toBe(false);
  });

  test("revealPath refuses an absent target with UNKNOWN_TARGET reason absent", () => {
    expect(ok(V.RevealPathResult, { reason: "absent" })).toBe(true);
    expect(ok(V.RevealPathResult, { reason: "missing" })).toBe(false);
  });

  test("a delete and an ignore-save review give their plans", () => {
    const R = envelope.ReviewWorkbenchResult;
    const entryIds = [id(), id(), id()];
    const plan = (fields: Record<string, unknown> = {}) => ({ mode: "recycle", entryIds, files: { count: 3, paths: [b64("a"), b64("b"), b64("c")] }, tracked: 1, folder: null, wsl: false, ...fields });
    expect(ok(R, { action: "delete", plan: plan(), workbenchToken: id() })).toBe(true);
    expect(ok(R, { action: "delete", plan: plan({ mode: "permanent", wsl: true, folder: b64("logs") }), workbenchToken: id() })).toBe(true);
    const many = Array.from({ length: 25 }, id);
    expect(ok(R, { action: "delete", plan: plan({ entryIds: many, files: { count: 25, paths: Array.from({ length: 20 }, (_, i) => b64(`p${i}`)) } }), workbenchToken: id() })).toBe(true);
    expect(ok(R, { action: "delete", plan: plan({ entryIds: many, files: { count: 25, paths: Array.from({ length: 21 }, (_, i) => b64(`p${i}`)) } }), workbenchToken: id() })).toBe(false);
    expect(ok(R, { action: "delete", plan: plan({ files: { count: 2, paths: [b64("a"), b64("b")] } }), workbenchToken: id() })).toBe(false);
    expect(ok(R, { action: "delete", plan: plan({ tracked: 4 }), workbenchToken: id() })).toBe(false);
    expect(ok(R, { action: "delete", plan: plan({ wsl: true }), workbenchToken: id() })).toBe(false);
    expect(ok(R, { action: "ignore-save", plan: { target: "gitignore", file: `${REPO}${SEP}.gitignore`, size: 6, sha256: DIGEST }, workbenchToken: id() })).toBe(true);
    expect(ok(R, { action: "ignore-save", plan: { target: "gitignore", file: `${REPO}${SEP}.gitignore`, size: MIB + 1, sha256: DIGEST }, workbenchToken: id() })).toBe(false);
  });

  test("a review refusal names each new reason, and ignore-changed is a STALE_REVIEW reason of the review", () => {
    const R = envelope.ReviewWorkbenchResult;
    for (const reason of ["conflicted", "submodule", "nested-repository", "no-recycle-bin", "long-path", "nothing-to-delete", "ignore-link", "ignore-folder", "ignore-not-utf8", "ignore-nul", "ignore-lone-cr", "ignore-changed"]) {
      expect({ reason, ok: ok(R, { reason }) }).toEqual({ reason, ok: true });
    }
  });

  test("a delete run states each file and folder outcome", () => {
    const R = envelope.RunWorkbenchResult;
    const entries = [
      { entryId: id(), outcome: "recycled", recycledPath: isWindows ? "C:\\$Recycle.Bin\\S-1\\$RA1.txt" : "/trash/a.txt" },
      { entryId: id(), outcome: "error", code: "sharing-violation" },
      ...["deleted", "kept", "changed", "absent", "not-regular", "stopped"].map((outcome) => ({ entryId: id(), outcome })),
    ];
    const folders = [{ pathBytes: b64("a/b"), outcome: "removed" }, { pathBytes: b64("a"), outcome: "kept" }, { pathBytes: b64("c"), outcome: "error", code: "access-denied" }];
    expect(ok(R, { action: "delete", entries, folders })).toBe(true);
    expect(ok(R, { action: "delete", entries: [{ entryId: id(), outcome: "recycled" }], folders: [] })).toBe(false);
    expect(ok(R, { action: "delete", entries: [{ entryId: id(), outcome: "error" }], folders: [] })).toBe(false);
    expect(ok(R, { action: "delete", entries: [{ entryId: id(), outcome: "deleted", code: "io-error" }], folders: [] })).toBe(false);
    expect(ok(R, { action: "delete", entries: [{ entryId: id(), outcome: "moved" }], folders: [] })).toBe(false);
    expect(ok(R, { action: "delete", entries: [], folders: [{ pathBytes: b64("a"), outcome: "deleted" }] })).toBe(false);
  });

  test("an ignore-save run states its outcome, and a stale run names its STALE_REVIEW reason", () => {
    const R = envelope.RunWorkbenchResult;
    for (const outcome of ["replaced", "stale", "not-regular", "stopped", "interrupted"]) expect(ok(R, { action: "ignore-save", outcome })).toBe(true);
    expect(ok(R, { action: "ignore-save", outcome: "error", code: "access-denied" })).toBe(true);
    expect(ok(R, { action: "ignore-save", outcome: "error" })).toBe(false);
    expect(ok(R, { action: "ignore-save", outcome: "appended" })).toBe(false);
    expect(ok(R, { action: "delete", reason: "files-changed" })).toBe(true);
    expect(ok(R, { action: "ignore-save", reason: "ignore-changed" })).toBe(true);
    expect(ok(R, { action: "delete", reason: "ignore-changed" })).toBe(false);
    for (const action of ["delete", "ignore-save"]) expect(ok(R, { action })).toBe(true);
  });
});

describe("contract Δ6 private requests", () => {
  const call = { callId: id(), operationId: id(), repositoryId: id() };
  const abs = (name: string) => `${REPO}${SEP}${name}`;
  const fileExpected = { kind: "file", size: 12, lastWrite: "133000000000000000", digest: DIGEST };

  test("fileDelete takes 0 to 64 entries and 0 to 64 folders, one of them not empty", () => {
    const req = (fields: Record<string, unknown>) => ({ type: "fileDelete", ...call, mode: "recycle", entries: [], folders: [], ...fields });
    expect(ok(channel.ProcessRequest, req({ entries: [{ path: abs("a.txt"), expected: fileExpected }] }))).toBe(true);
    expect(ok(channel.ProcessRequest, req({ mode: "permanent", entries: [{ path: abs("ln"), expected: { kind: "link", tag: "symlink", target: "../x" } }] }))).toBe(true);
    expect(ok(channel.ProcessRequest, req({ entries: [{ path: abs("big.bin"), expected: { kind: "file", size: 2 * MIB, lastWrite: "-5" } }] }))).toBe(true);
    // Contract Δ5: a digest binds a file of at most 1 MiB.
    expect(ok(channel.ProcessRequest, req({ entries: [{ path: abs("a.bin"), expected: { ...fileExpected, size: MIB } }] }))).toBe(true);
    expect(ok(channel.ProcessRequest, req({ entries: [{ path: abs("a.bin"), expected: { ...fileExpected, size: MIB + 1 } }] }))).toBe(false);
    expect(ok(channel.ProcessRequest, req({ folders: [abs(`a${SEP}b`), abs("a")] }))).toBe(true);
    expect(ok(channel.ProcessRequest, req({}))).toBe(false);
    const many = Array.from({ length: 65 }, (_, i) => ({ path: abs(`f${i}`), expected: fileExpected }));
    expect(ok(channel.ProcessRequest, req({ entries: many }))).toBe(false);
    expect(ok(channel.ProcessRequest, req({ entries: many.slice(0, 64) }))).toBe(true);
    expect(ok(channel.ProcessRequest, req({ folders: Array.from({ length: 65 }, (_, i) => abs(`d${i}`)) }))).toBe(false);
    expect(ok(channel.ProcessRequest, req({ entries: [{ path: "a.txt", expected: fileExpected }] }))).toBe(false);
    expect(ok(channel.ProcessRequest, req({ mode: "move", entries: [{ path: abs("a"), expected: fileExpected }] }))).toBe(false);
    expect(ok(channel.ProcessRequest, req({ entries: [{ path: abs("a"), expected: { kind: "directory" } }] }))).toBe(false);
    expect(ok(channel.ProcessRequest, req({ entries: [{ path: abs("a"), expected: { kind: "link", tag: "symlink" } }] }))).toBe(false);
    // A link fact with the file fields is no file fact.
    expect(ok(channel.ProcessRequest, req({ entries: [{ path: abs("a"), expected: { ...fileExpected, kind: "link" } }] }))).toBe(false);
  });

  test("fileReplace takes the target, the path, the expected state, and 0 to 1 MiB of bytes", () => {
    const req = (fields: Record<string, unknown> = {}) => ({ type: "fileReplace", ...call, target: "gitignore", path: abs(".gitignore"), expected: "absent", bytes: b64("/out/\n"), ...fields });
    expect(ok(channel.ProcessRequest, req())).toBe(true);
    expect(ok(channel.ProcessRequest, req({ bytes: "" }))).toBe(true);
    expect(ok(channel.ProcessRequest, req({ target: "exclude", expected: { size: MIB, sha256: DIGEST }, bytes: b64(new Uint8Array(MIB)) }))).toBe(true);
    expect(ok(channel.ProcessRequest, req({ bytes: b64(new Uint8Array(MIB + 1)) }))).toBe(false);
    expect(ok(channel.ProcessRequest, req({ expected: { size: MIB + 1, sha256: DIGEST } }))).toBe(false);
    expect(ok(channel.ProcessRequest, req({ path: ".gitignore" }))).toBe(false);
    expect(ok(channel.ProcessRequest, req({ target: "attributes" }))).toBe(false);
  });

  test("shadow takes op create, and fileAppend goes (T057)", () => {
    expect(ok(channel.ProcessRequest, { type: "shadow", ...call, op: "create" })).toBe(true);
    expect(ok(channel.ProcessRequest, { type: "shadow", ...call, op: "remove" })).toBe(false);
    expect(ok(channel.ProcessRequest, { type: "fileAppend", ...call, target: "gitignore", path: abs(".gitignore"), expected: "absent", bytes: b64("/x\n") })).toBe(false);
    expect(P.FileAppendReply).toBeUndefined();
  });

  test("the ignorePreview run context names the Git, the shadow, the repository s or c, and the index", () => {
    const context = { contextKind: "ignorePreview", gitInstallationId: id(), shadowId: id(), shadowRepository: "s", shadowIndex: "index" };
    const run = { type: "run", callId: id(), operationId: id(), arguments: ["--no-lazy-fetch", "init", "-q", "--template="], environmentPolicy: "read", limits: { deadlineMs: 30_000 }, ...context };
    expect(ok(channel.ProcessContext, context)).toBe(true);
    expect(ok(channel.ProcessRequest, run)).toBe(true);
    expect(ok(channel.ProcessRequest, { ...run, shadowRepository: "c", shadowIndex: "exclude" })).toBe(true);
    for (const wrong of [{ shadowRepository: "x" }, { shadowIndex: "other" }, { shadowId: "s1" }, { repositoryId: id() }]) expect(ok(channel.ProcessRequest, { ...run, ...wrong })).toBe(false);
    const { shadowIndex: _index, ...withoutIndex } = run;
    const { gitInstallationId: _git, ...withoutGit } = run;
    expect(ok(channel.ProcessRequest, withoutIndex)).toBe(false);
    expect(ok(channel.ProcessRequest, withoutGit)).toBe(false);
  });

  test("fileFacts content needs digest true, exactly one entry, and no index", () => {
    const facts = (fields: Record<string, unknown>) => ({ type: "fileFacts", callId: id(), operationId: id(), contextKind: "registeredOperation", gitInstallationId: id(), repositoryId: id(), digest: true, files: [{ root: "worktreeRoot", path: [".gitignore"] }], ...fields });
    expect(ok(channel.ProcessRequest, facts({ content: true }))).toBe(true);
    expect(ok(channel.ProcessRequest, facts({ content: false }))).toBe(true);
    expect(ok(channel.ProcessRequest, facts({ content: true, digest: false }))).toBe(false);
    expect(ok(channel.ProcessRequest, facts({ content: true, files: [{ root: "worktreeRoot", path: ["a"] }, { root: "worktreeRoot", path: ["b"] }] }))).toBe(false);
    expect(ok(channel.ProcessRequest, facts({ content: true, digest: false, index: {} }))).toBe(false);
  });

  test("a file fact with content adds the base64 bytes of at most 1 MiB", () => {
    const fact = { kind: "file", size: 6, lastWrite: "1", digest: DIGEST, bytes: b64("/out/\n") };
    expect(ok(channel.FileFact, fact)).toBe(true);
    expect(ok(channel.FileFact, { ...fact, bytes: b64(new Uint8Array(MIB + 1)) })).toBe(false);
    expect(ok(channel.FileFact, { ...fact, digest: undefined })).toBe(false);
    expect(ok(channel.FileFactsReply, { type: "fileFacts", callId: id(), facts: [fact] })).toBe(true);
  });

  test("the fileDelete, fileReplace, shadow, and reveal replies", () => {
    const callId = id();
    const reply = (value: Record<string, unknown>) => ok(channel.ProcessReply, { callId, ...value });
    const entries = [
      { result: "recycled", recycledPath: abs("x") },
      { result: "kept", hresult: 0x80270000 },
      { result: "error", code: "access-denied" },
      ...["deleted", "stale", "absent", "not-regular", "stopped"].map((result) => ({ result })),
    ];
    const folders = [{ result: "removed" }, { result: "kept" }, { result: "absent" }, { result: "not-regular" }, { result: "error", code: "io-error" }];
    expect(reply({ type: "fileDelete", entries, folders })).toBe(true);
    expect(reply({ type: "fileDelete", entries: [{ result: "recycled" }], folders: [] })).toBe(false);
    expect(reply({ type: "fileDelete", entries: [{ result: "kept" }], folders: [] })).toBe(false);
    expect(reply({ type: "fileDelete", entries: [], folders: [{ result: "deleted" }] })).toBe(false);
    // A stop before the delete phase gives `stopped`. A WSL stop or deadline gives `interrupted`.
    for (const result of ["stopped", "interrupted"]) expect(reply({ type: "fileDelete", result })).toBe(true);
    expect(reply({ type: "fileDelete", result: "deleted" })).toBe(false);
    expect(reply({ type: "fileDelete", result: "stopped", entries: [], folders: [] })).toBe(false);
    expect(reply({ type: "fileDelete", entries: [{ result: "interrupted" }], folders: [] })).toBe(false);
    for (const result of ["replaced", "stale", "stopped", "interrupted"]) expect(reply({ type: "fileReplace", result })).toBe(true);
    expect(reply({ type: "fileReplace", result: "refused", reason: "not-regular" })).toBe(true);
    expect(reply({ type: "fileReplace", result: "error", code: "access-denied" })).toBe(true);
    expect(reply({ type: "fileReplace", result: "appended" })).toBe(false);
    // T057: the 004 `fileAppend` replies go.
    for (const value of [{ result: "appended" }, { result: "stopped" }, { result: "refused", reason: "not-regular" }, { result: "error", code: "io-error" }]) expect(reply({ type: "fileAppend", ...value })).toBe(false);
    expect(reply({ type: "shadow", shadowId: id() })).toBe(true);
    expect(reply({ type: "shadow", result: "error", code: "other-error" })).toBe(true);
    expect(reply({ type: "shadow", shadowId: "s1" })).toBe(false);
    expect(reply({ type: "reveal" })).toBe(true);
    expect(reply({ type: "reveal", result: "absent" })).toBe(true);
    expect(reply({ type: "reveal", result: "missing" })).toBe(false);
  });

  test("a workbench marker names delete-files, ignore-save-gitignore, or ignore-save-exclude, and the 004 ignore actions go (T057)", () => {
    const started = { type: "started", callId: id(), operationId: id(), repositoryId: id(), kind: "workbench", worktreeRoot: REPO, commonDirectory: `${REPO}${SEP}.git` };
    for (const action of ["delete-files", "ignore-save-gitignore", "ignore-save-exclude"]) expect(ok(channel.MutationRequest, { ...started, action })).toBe(true);
    for (const action of ["delete", "ignore-gitignore", "ignore-exclude"]) expect(ok(channel.MutationRequest, { ...started, action })).toBe(false);
    expect(P.WORKBENCH_STARTED_ACTIONS).toEqual(expect.arrayContaining(["delete-files", "ignore-save-gitignore", "ignore-save-exclude"]));
    for (const action of ["ignore-gitignore", "ignore-exclude"]) expect(P.WORKBENCH_STARTED_ACTIONS).not.toContain(action);
  });
});
