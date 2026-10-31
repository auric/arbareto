// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T006: the feature 008 contract changes (contract Δ1 to Δ3, Δ5, Δ6, Δ9, Δ10; data-model §1, §5, §8, §9).

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

// The module namespaces give `undefined` for a missing export, so each case fails on its own before T007.
const L = limits as unknown as Record<string, number | undefined>;
const E = errors as unknown as Record<string, readonly string[] | undefined>;

const MIB = 1024 * 1024;
const DIGEST = "a".repeat(64);
const DIGEST2 = "b".repeat(64);
const REPO = isWindows ? "C:\\repo" : "/repo";
const SEP = isWindows ? "\\" : "/";
const abs = (name: string) => `${REPO}${SEP}${name}`;
const id = () => crypto.randomUUID();
const b64 = (text: string | Uint8Array) => Buffer.from(text).toString("base64");
const ok = (schema: z.ZodType | undefined, value: unknown) => schema?.safeParse(value).success ?? false;
const request = (operation: string, payload: unknown) => ({ version: 1, sessionId: id(), requestId: id(), operation, repositoryId: id(), repositoryGeneration: 3, payload });
const check = (payload: unknown) => {
  const result = envelope.validateRequest(request("reviewWorkbench", payload), "renderer");
  return result.ok ? "ok" : result.code;
};
const ACTIONS = ["revert-lines", "revert-files", "revert-unstaged"];

describe("contract Δ5 bounds", () => {
  // Research.md R11: the working bytes, the restored lines of the other side, and one CR per restored diff line.
  test("REVERT_FILE_BYTES is the reachable line-revert size, and the whole-file actions keep MULTI_FILE_ACTION_FILES", () => {
    expect(L.REVERT_FILE_BYTES).toBe(2_117_152);
    expect(L.REVERT_FILE_BYTES).toBe(2 * limits.COMPARED_RAW_VERSION_BYTES + limits.CANONICAL_DIFF_LINES);
    expect(limits.MULTI_FILE_ACTION_FILES).toBe(10_000);
    expect(limits.FILE_FACT_ENTRIES).toBe(64);
  });
});

describe("contract Δ1 and Δ2 operations, phases, and markers", () => {
  test("no new operation name, and MUTATIONS keeps runWorkbench", () => {
    for (const action of ACTIONS) expect<readonly string[]>(operations.OPERATION_NAMES).not.toContain(action);
    expect(operations.MUTATIONS).toContain("runWorkbench");
  });

  test("reviewWorkbench gains the three actions", () => {
    expect(channel.WORKBENCH_ACTIONS).toEqual(expect.arrayContaining(ACTIONS));
  });

  const event = (phase: string, counters: Record<string, number> = {}, extra: Record<string, unknown> = {}) => ({ requestId: id(), operationId: id(), state: "running", phase, counters, stalled: false, ...extra });
  test("revert-index carries no counter, and revert-files carries fileIndex and fileCount", () => {
    expect(operations.PHASES).toEqual(expect.arrayContaining(["revert-index", "revert-files"]));
    expect(ok(envelope.ProgressEvent, event("revert-index"))).toBe(true);
    expect(ok(envelope.ProgressEvent, event("revert-files", { fileIndex: 64, fileCount: 200 }))).toBe(true);
    for (const counter of ["fileIndex", "fileCount", "percent"]) expect(ok(envelope.ProgressEvent, event("revert-index", { [counter]: 1 }))).toBe(false);
    for (const counter of ["keyIndex", "percent", "blamed"]) expect(ok(envelope.ProgressEvent, event("revert-files", { [counter]: 1 }))).toBe(false);
    for (const phase of ["revert-index", "revert-files"]) expect(ok(envelope.ProgressEvent, event(phase, {}, { path: "a.txt" }))).toBe(false);
  });

  test("a workbench marker names revert-lines, revert-files, or revert-unstaged", () => {
    const started = { type: "started", callId: id(), operationId: id(), repositoryId: id(), kind: "workbench", worktreeRoot: REPO, commonDirectory: abs(".git") };
    expect(channel.WORKBENCH_STARTED_ACTIONS).toEqual(expect.arrayContaining(ACTIONS));
    for (const action of ACTIONS) expect(ok(channel.MutationRequest, { ...started, action })).toBe(true);
    for (const action of ACTIONS) expect(ok(channel.MutationRequest, { ...started, kind: "sync", action })).toBe(false);
    expect(ok(channel.MutationRequest, { ...started, action: "revert" })).toBe(false);
  });
});

describe("contract Δ3 payloads (data-model §1)", () => {
  const snapshotId = id();

  test("revert-lines takes the snapshot, the comparison, the hunk, and optional ascending line ordinals", () => {
    const lines = (fields: Record<string, unknown> = {}) => ({ action: "revert-lines", snapshotId, comparisonId: id(), hunkId: id(), ...fields });
    expect(check(lines())).toBe("ok");
    expect(check(lines({ lines: [1, 3, 4] }))).toBe("ok");
    for (const wrong of [[], [3, 1], [2, 2], [0], [1.5], [limits.CANONICAL_DIFF_LINES + 1]]) expect(check(lines({ lines: wrong }))).toBe("INVALID_REQUEST");
    for (const field of ["snapshotId", "comparisonId", "hunkId"]) expect(check(lines({ [field]: "x" }))).toBe("INVALID_REQUEST");
    expect(check(lines({ path: b64("a.txt") }))).toBe("INVALID_REQUEST");
  });

  test("revert-files takes 1 to 10,000 unique entry IDs", () => {
    const files = (entryIds: unknown) => ({ action: "revert-files", snapshotId, entryIds });
    expect(check(files([id()]))).toBe("ok");
    expect(check(files(Array.from({ length: limits.MULTI_FILE_ACTION_FILES }, id)))).toBe("ok");
    expect(check(files([]))).toBe("INVALID_REQUEST");
    expect(check(files(Array.from({ length: limits.MULTI_FILE_ACTION_FILES + 1 }, id)))).toBe("INVALID_REQUEST");
    const one = id();
    expect(check(files([one, one]))).toBe("INVALID_REQUEST");
    expect(check({ action: "revert-files", snapshotId, entryIds: [id()], paths: [b64("a")] })).toBe("INVALID_REQUEST");
  });

  test("revert-unstaged takes only the snapshot", () => {
    expect(check({ action: "revert-unstaged", snapshotId })).toBe("ok");
    expect(check({ action: "revert-unstaged" })).toBe("INVALID_REQUEST");
    expect(check({ action: "revert-unstaged", snapshotId, entryIds: [id()] })).toBe("INVALID_REQUEST");
  });
});

describe("contract Δ3 plans (data-model §5) and Δ9 reasons", () => {
  const R = envelope.ReviewWorkbenchResult;
  const reviewed = (action: string, plan: unknown) => ok(R, { action, plan, workbenchToken: id() });
  const paths = (n: number) => Array.from({ length: n }, (_, i) => b64(`p${i}`));

  test("a lines plan names the scope, the path, and the line count or null for a whole hunk", () => {
    expect(reviewed("revert-lines", { scope: "unstaged", fileBytes: b64("a.txt"), lines: 3 })).toBe(true);
    expect(reviewed("revert-lines", { scope: "staged", fileBytes: b64("a.txt"), lines: null })).toBe(true);
    expect(reviewed("revert-lines", { scope: "both", fileBytes: b64("a.txt"), lines: null })).toBe(false);
    expect(reviewed("revert-lines", { scope: "staged", fileBytes: "", lines: null })).toBe(false);
    expect(reviewed("revert-lines", { scope: "staged", fileBytes: b64("a.txt"), lines: 0 })).toBe(false);
  });

  test("a files plan gives the count, the first 20 paths, and the new, staged, and unstaged counts", () => {
    const plan = (fields: Record<string, unknown> = {}) => ({ count: 3, paths: paths(3), newFiles: 1, staged: 2, unstaged: 1, ...fields });
    expect(reviewed("revert-files", plan())).toBe(true);
    expect(reviewed("revert-files", plan({ count: 25, paths: paths(20) }))).toBe(true);
    expect(reviewed("revert-files", plan({ count: 25, paths: paths(21) }))).toBe(false);
    expect(reviewed("revert-files", plan({ paths: paths(2) }))).toBe(false);
    expect(reviewed("revert-files", plan({ count: 0, paths: [], newFiles: 0, staged: 0, unstaged: 0 }))).toBe(false);
    expect(reviewed("revert-files", plan({ staged: 4 }))).toBe(false);
    expect(reviewed("revert-files", plan({ unstaged: 4 }))).toBe(false);
    // A staged new file has a staged change.
    expect(reviewed("revert-files", plan({ newFiles: 3 }))).toBe(false);
  });

  test("an unstaged plan gives the count, the first 20 paths, and the submodules left unchanged", () => {
    expect(reviewed("revert-unstaged", { count: 2, paths: paths(2), submodules: 1 })).toBe(true);
    expect(reviewed("revert-unstaged", { count: 30, paths: paths(20), submodules: 0 })).toBe(true);
    expect(reviewed("revert-unstaged", { count: 30, paths: paths(19), submodules: 0 })).toBe(false);
    expect(reviewed("revert-unstaged", { count: 0, paths: [], submodules: 0 })).toBe(false);
    expect(reviewed("revert-unstaged", { count: 2, paths: paths(2), submodules: 1, hidden: 1 })).toBe(false);
  });

  test("each plan belongs to its own action", () => {
    expect(reviewed("revert-unstaged", { scope: "unstaged", fileBytes: b64("a.txt"), lines: 3 })).toBe(false);
    expect(reviewed("revert-lines", { count: 2, paths: paths(2), submodules: 1 })).toBe(false);
  });

  const REASONS = ["untracked", "in-the-way", "attributes", "ident", "unstaged-changes", "not-regular", "hard-link", "read-only", "encrypted", "owner", "security", "file-attributes", "xattr", "nothing-to-revert", "limit"];
  test("WORKBENCH_UNAVAILABLE gains the Δ9 reasons, and a review refusal names each", () => {
    expect(E.WORKBENCH_UNAVAILABLE_REASONS).toEqual(expect.arrayContaining(REASONS));
    for (const reason of REASONS) expect({ reason, ok: ok(R, { reason }) }).toEqual({ reason, ok: true });
  });

  // Spec FR-022, FR-029, and plan.md D6: the first 20 refused files in tree order with their reasons, and the count of the rest.
  test("a review refusal names the first refused files with their reasons and the count of the rest", () => {
    const file = (reason: string, name = "a.txt") => ({ path: b64(name), reason });
    const twenty = Array.from({ length: 20 }, (_, i) => file(i === 0 ? "symlink" : "hard-link", `f${i}`));
    expect(ok(R, { reason: "symlink", files: twenty, more: 5 })).toBe(true);
    expect(ok(R, { reason: "hard-link", files: [file("hard-link")], more: 0 })).toBe(true);
    for (const reason of ["untracked", "attributes", "owner", "xattr", "rename", "submodule", "path", "filter", "LFS", "mode", "ident", "binary", "line-endings", "eof-newline"]) {
      expect({ reason, ok: ok(R, { reason, files: [file(reason)], more: 0 }) }).toEqual({ reason, ok: true });
    }
    expect(ok(R, { reason: "symlink", files: [...twenty, file("hard-link", "f20")], more: 4 })).toBe(false);
    expect(ok(R, { reason: "symlink", files: twenty })).toBe(false);
    expect(ok(R, { reason: "owner", files: [file("hard-link")], more: 0 })).toBe(false);
    expect(ok(R, { reason: "hard-link", files: [], more: 0 })).toBe(false);
    expect(ok(R, { reason: "hard-link", files: [{ path: "", reason: "hard-link" }], more: 0 })).toBe(false);
    for (const reason of ["nothing-to-revert", "limit", "several-hunks", "sparse-index"]) expect({ reason, ok: ok(R, { reason, files: [file(reason)], more: 0 }) }).toEqual({ reason, ok: false });
    expect(ok(R, { reason: "untracked-in-way", paths: ["a.txt"], files: [file("untracked")], more: 0 })).toBe(false);
  });

  // Data-model §7: the support and line reasons of UNSUPPORTED_COMPARISON, and the eligibility reasons of UNSUPPORTED_HUNK_PROFILE with their remedy.
  test("a review refusal carries the support, line, and eligibility reasons, and the remedy of an eligibility or LOCKED refusal", () => {
    for (const reason of ["binary", "encoding", "size", "rename", "mode", "type", "symlink", "LFS", "filter", "state", "line-endings", "index-flag", "context-only", "deleted-file", "new-file", "eof-newline"]) {
      expect({ reason, ok: ok(R, { reason }) }).toEqual({ reason, ok: true });
    }
    expect(ok(R, { reason: "several-hunks" })).toBe(false);
    expect(ok(R, { reason: "supported" })).toBe(false);
    const remedy = { text: "Stage this change in a terminal." };
    for (const reason of ["sparse-index", "split-index", "index-change-hook", "executable-monitor", "unqualified-monitor", "shared-repository"]) {
      expect({ reason, ok: ok(R, { reason, remedy }) }).toEqual({ reason, ok: true });
    }
    expect(ok(R, { path: `${abs(".git")}${SEP}index.lock`, remedy })).toBe(true);
    expect(ok(R, { reason: "binary", remedy })).toBe(false);
    expect(ok(R, { remedy })).toBe(false);
    expect(ok(R, { reason: "sparse-index", remedy: { text: "" } })).toBe(false);
  });

  test("STALE_REVIEW gains revert-changed", () => {
    expect(E.STALE_REVIEW_REASONS).toEqual(expect.arrayContaining(["revert-changed"]));
    expect(ok(R, { reason: "revert-changed" })).toBe(true);
  });
});

describe("contract Δ3 run result (data-model §8, §9)", () => {
  const R = envelope.RunWorkbenchResult;
  const run = (fields: Record<string, unknown> = {}) => ({ action: "revert-files", files: [{ entryId: id(), outcome: "reverted" }], foldersCreated: [], index: "published", ...fields });

  test("each file states its outcome, and only not-changed carries a reply code", () => {
    const files = [
      ...["reverted", "unstaged-only", "changed-outside", "not-started", "not-changed"].map((outcome) => ({ entryId: id(), outcome })),
      { entryId: id(), outcome: "not-changed", code: "stale" },
      { entryId: id(), outcome: "not-changed", code: "refused", reason: "hard-link" },
      { entryId: id(), outcome: "not-changed", code: "error", reason: "sharing-violation" },
    ];
    expect(ok(R, run({ files, foldersCreated: [b64("new"), b64("new/deep")] }))).toBe(true);
    for (const index of ["published", "none", "refused"]) expect(ok(R, run({ index }))).toBe(true);
    for (const action of ["revert-unstaged", "revert-lines"]) expect(ok(R, run({ action, index: "none" }))).toBe(true);
    expect(ok(R, run({ index: "written" }))).toBe(false);
    expect(ok(R, run({ files: [{ entryId: id(), outcome: "kept" }] }))).toBe(false);
    expect(ok(R, run({ files: [{ entryId: id(), outcome: "reverted", code: "stale" }] }))).toBe(false);
    expect(ok(R, run({ files: [{ entryId: id(), outcome: "not-changed", code: "refused" }] }))).toBe(false);
    expect(ok(R, run({ files: [{ entryId: id(), outcome: "not-changed", code: "stale", reason: "hard-link" }] }))).toBe(false);
    expect(ok(R, run({ files: [{ entryId: id(), outcome: "not-changed", code: "refused", reason: "sharing-violation" }] }))).toBe(false);
    expect(ok(R, run({ files: [{ entryId: id(), outcome: "not-changed", code: "error", reason: "hard-link" }] }))).toBe(false);
    expect(ok(R, run({ foldersCreated: [""] }))).toBe(false);
  });

  test("a line revert names exactly one file", () => {
    expect(ok(R, run({ action: "revert-lines", files: [] }))).toBe(false);
    expect(ok(R, run({ action: "revert-lines", files: [{ entryId: id(), outcome: "reverted" }, { entryId: id(), outcome: "reverted" }] }))).toBe(false);
  });

  test("a stale run names revert-changed, and an unread run names the action only", () => {
    for (const action of ACTIONS) {
      expect(ok(R, { action, reason: "revert-changed" })).toBe(true);
      expect(ok(R, { action, reason: "files-changed" })).toBe(false);
      expect(ok(R, { action })).toBe(true);
    }
    expect(ok(R, { action: "delete", reason: "revert-changed" })).toBe(false);
  });
});

describe("contract Δ6 private requests", () => {
  const call = { callId: id(), operationId: id(), repositoryId: id() };
  const windowsFacts = { size: 12, sha256: DIGEST, attributes: 0x20, links: 1, owner: "S-1-5-21-1-2-3-1001", group: "S-1-5-21-1-2-3-513", dacl: "D:(A;;FA;;;SY)", creationTime: "133000000000000000" };
  const wslFacts = { size: 12, sha256: DIGEST, mode: 0o100644, uid: 1000, gid: 1000, links: 1, xattr: false };
  const working = (fields: Record<string, unknown> = {}) => ({ type: "fileReplace", ...call, target: "working", path: abs("a.txt"), expected: { size: 12, sha256: DIGEST }, facts: windowsFacts, bytes: b64("new\n"), ...fields });
  const source = { name: ".merge_file_a1B2c3", size: 40, sha256: DIGEST2 };
  const R = channel.ProcessRequest;

  test("fileReplace working takes bytes up to REVERT_FILE_BYTES", () => {
    expect(ok(R, working())).toBe(true);
    expect(ok(R, working({ bytes: "" }))).toBe(true);
    expect(ok(R, working({ facts: wslFacts }))).toBe(true);
    const bound = L.REVERT_FILE_BYTES ?? 0;
    expect(ok(R, working({ bytes: b64(new Uint8Array(bound)) }))).toBe(true);
    expect(ok(R, working({ bytes: b64(new Uint8Array(bound + 1)) }))).toBe(false);
    for (const bytes of ["eAo", "eA=o", "e===", "eAo*"]) expect({ bytes, ok: ok(R, working({ bytes })) }).toEqual({ bytes, ok: false });
    // A whole file has no size bound, so the expected size has none.
    expect(ok(R, working({ expected: { size: 4 * 1024 * MIB, sha256: DIGEST }, facts: { ...windowsFacts, size: 4 * 1024 * MIB }, bytes: undefined, source }))).toBe(true);
  });

  test("fileReplace working takes exactly one of bytes and source", () => {
    expect(ok(R, working({ bytes: undefined, source }))).toBe(true);
    expect(ok(R, working({ source }))).toBe(false);
    expect(ok(R, working({ bytes: undefined }))).toBe(false);
  });

  test("a source name is one path component", () => {
    for (const name of ["a/b", "a\\b", "..", ".", "", "a\0b"]) expect({ name, ok: ok(R, working({ bytes: undefined, source: { ...source, name } })) }).toEqual({ name, ok: false });
    expect(ok(R, working({ bytes: undefined, source: { ...source, size: -1 } }))).toBe(false);
    expect(ok(R, working({ bytes: undefined, source: { ...source, sha256: "A".repeat(64) } }))).toBe(false);
  });

  test("folders holds 1 to 64 folder names, only with expected absent", () => {
    const absent = (folders: unknown) => working({ expected: "absent", facts: "absent", folders });
    expect(ok(R, working({ expected: "absent", facts: "absent" }))).toBe(true);
    expect(ok(R, absent(["new", "deep"]))).toBe(true);
    expect(ok(R, absent(Array.from({ length: 64 }, (_, i) => `d${i}`)))).toBe(true);
    expect(ok(R, absent(Array.from({ length: 65 }, (_, i) => `d${i}`)))).toBe(false);
    expect(ok(R, absent([]))).toBe(false);
    expect(ok(R, absent(["a/b"]))).toBe(false);
    expect(ok(R, working({ folders: ["new"] }))).toBe(false);
  });

  test("facts are the bound working facts: absent with expected absent, else the size and digest of expected", () => {
    expect(ok(R, working({ facts: "absent" }))).toBe(false);
    expect(ok(R, working({ expected: "absent" }))).toBe(false);
    expect(ok(R, working({ facts: undefined }))).toBe(false);
    expect(ok(R, working({ facts: { ...windowsFacts, size: 13 } }))).toBe(false);
    expect(ok(R, working({ facts: { ...wslFacts, sha256: DIGEST2 } }))).toBe(false);
    expect(ok(R, working({ facts: { ...windowsFacts, mode: 0o100644 } }))).toBe(false);
    expect(ok(R, working({ facts: { ...wslFacts, xattr: true } }))).toBe(false);
    const { owner: _owner, ...noOwner } = windowsFacts;
    expect(ok(R, working({ facts: noOwner }))).toBe(false);
    const { group: _group, ...noGroup } = windowsFacts;
    expect(ok(R, working({ facts: noGroup }))).toBe(false);
    expect(ok(R, working({ facts: { ...windowsFacts, creationTime: "1.5" } }))).toBe(false);
  });

  test("the targets gitignore and exclude keep their 1 MiB rules and take no working field", () => {
    const ignore = (fields: Record<string, unknown> = {}) => ({ type: "fileReplace", ...call, target: "gitignore", path: abs(".gitignore"), expected: "absent", bytes: b64("/out/\n"), ...fields });
    expect(ok(R, ignore())).toBe(true);
    expect(ok(R, ignore({ bytes: b64(new Uint8Array(MIB + 1)) }))).toBe(false);
    expect(ok(R, ignore({ expected: { size: MIB + 1, sha256: DIGEST } }))).toBe(false);
    expect(ok(R, ignore({ bytes: undefined }))).toBe(false);
    expect(ok(R, ignore({ bytes: undefined, source }))).toBe(false);
    expect(ok(R, ignore({ facts: "absent" }))).toBe(false);
    expect(ok(R, ignore({ folders: ["info"] }))).toBe(false);
  });

  test("tempRemove takes one name in the worktree root and its expected size and digest", () => {
    const remove = (fields: Record<string, unknown> = {}) => ({ type: "tempRemove", ...call, name: ".merge_file_a1B2c3", expected: { size: 40, sha256: DIGEST }, ...fields });
    expect(ok(R, remove())).toBe(true);
    for (const name of ["a/b", "..", ""]) expect(ok(R, remove({ name }))).toBe(false);
    expect(ok(R, remove({ expected: "absent" }))).toBe(false);
    expect(ok(R, remove({ path: abs("x") }))).toBe(false);
  });

  const facts = (fields: Record<string, unknown> = {}) => ({ type: "fileFacts", callId: id(), operationId: id(), contextKind: "registeredOperation", gitInstallationId: id(), repositoryId: id(), digest: true, files: [{ root: "worktreeRoot", path: ["a.txt"] }], ...fields });
  test("fileFacts takes detail, and stream only with digest", () => {
    expect(ok(R, facts({ detail: true }))).toBe(true);
    expect(ok(R, facts({ detail: true, stream: true }))).toBe(true);
    expect(ok(R, facts({ detail: false, stream: false, digest: false }))).toBe(true);
    expect(ok(R, facts({ stream: true, digest: false }))).toBe(false);
    expect(ok(R, facts({ stream: true, content: true }))).toBe(false);
    expect(ok(R, facts({ detail: "yes" }))).toBe(false);
  });
});

describe("contract Δ6 replies", () => {
  const callId = id();
  const reply = (value: Record<string, unknown>) => ok(channel.ProcessReply, { callId, ...value });

  test("fileReplace gives replaced with the created folders, and the new refusal reasons and error codes", () => {
    expect(reply({ type: "fileReplace", result: "replaced" })).toBe(true);
    expect(reply({ type: "fileReplace", result: "replaced", folders: ["new", "deep"] })).toBe(true);
    expect(reply({ type: "fileReplace", result: "replaced", folders: [] })).toBe(false);
    expect(reply({ type: "fileReplace", result: "stale", folders: ["new"] })).toBe(false);
    for (const reason of ["not-regular", "hard-link", "read-only", "encrypted", "owner", "security", "file-attributes", "xattr"]) {
      expect({ reason, ok: reply({ type: "fileReplace", result: "refused", reason }) }).toEqual({ reason, ok: true });
    }
    expect(reply({ type: "fileReplace", result: "refused", reason: "stale" })).toBe(false);
    for (const code of ["sharing-violation", "access-denied", "disk-full", "read-only-volume", "io-error", "other-error"]) {
      expect({ code, ok: reply({ type: "fileReplace", result: "error", code }) }).toEqual({ code, ok: true });
    }
    expect(reply({ type: "fileReplace", result: "error", code: "hard-link" })).toBe(false);
  });

  test("tempRemove gives removed, stale, absent, or error with a code", () => {
    for (const result of ["removed", "stale", "absent"]) expect(reply({ type: "tempRemove", result })).toBe(true);
    expect(reply({ type: "tempRemove", result: "error", code: "access-denied" })).toBe(true);
    expect(reply({ type: "tempRemove", result: "error" })).toBe(false);
    expect(reply({ type: "tempRemove", result: "replaced" })).toBe(false);
  });

  test("a detail file fact adds links and the Windows or the WSL facts, never a part of them", () => {
    const file = { kind: "file", size: 12, lastWrite: "1", digest: DIGEST };
    const windows = { links: 1, attributes: 0x20, owner: "S-1-5-32-544", group: "S-1-5-32-545", dacl: "D:(A;;FA;;;SY)", creationTime: "-5" };
    const wsl = { links: 2, mode: 0o100755, uid: 0, gid: 0, xattr: true };
    expect(ok(channel.FileFact, { ...file, ...windows })).toBe(true);
    expect(ok(channel.FileFact, { ...file, ...wsl })).toBe(true);
    expect(ok(channel.FileFact, file)).toBe(true);
    expect(ok(channel.FileFact, { ...file, ...windows, ...wsl })).toBe(false);
    expect(ok(channel.FileFact, { ...file, links: 1 })).toBe(false);
    const { links: _links, ...windowsOnly } = windows;
    expect(ok(channel.FileFact, { ...file, ...windowsOnly })).toBe(false);
    const { dacl: _dacl, ...noDacl } = windows;
    expect(ok(channel.FileFact, { ...file, ...noDacl })).toBe(false);
    const { group: _group, ...noGroup } = windows;
    expect(ok(channel.FileFact, { ...file, ...noGroup })).toBe(false);
    const { xattr: _xattr, ...noXattr } = wsl;
    expect(ok(channel.FileFact, { ...file, ...noXattr })).toBe(false);
    expect(ok(channel.FileFact, { ...file, ...windows, attributes: 2 ** 32 })).toBe(false);
    expect(ok(channel.FileFact, { ...file, ...windows, links: 0 })).toBe(false);
  });
});

// Contract Δ10: the golden vectors of `tests/vectors/*/revert-*.json` for Bun and Rust.
describe("contract Δ10 vectors", () => {
  const ROOT = join(import.meta.dir, "..", "vectors");
  const texts = (kind: string, schema: string) =>
    readdirSync(join(ROOT, kind))
      .filter((name) => name.startsWith("revert-") && name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(ROOT, kind, name), "utf8")) as { schema: string; text: string })
      .filter((v) => v.schema === schema)
      .map((v) => JSON.parse(v.text) as Record<string, unknown>);

  test("each payload, plan, result, phase, marker action, request, and reply has its valid and invalid vectors", () => {
    for (const kind of ["valid", "invalid"]) {
      expect(texts(kind, "renderer-envelope").map((t) => (t.payload as { action: string }).action)).toEqual(expect.arrayContaining(kind === "valid" ? ACTIONS : ["revert-lines", "revert-files"]));
      expect(texts(kind, "review-workbench-result").length).toBeGreaterThan(0);
      expect(texts(kind, "run-workbench-result").length).toBeGreaterThan(0);
      expect(texts(kind, "progress").map((t) => t.phase)).toEqual(expect.arrayContaining(["revert-index", "revert-files"]));
      expect(texts(kind, "mutation-request").length).toBeGreaterThan(0);
      expect(texts(kind, "process-request").map((t) => t.type)).toEqual(expect.arrayContaining(["fileReplace", "tempRemove", "fileFacts"]));
      expect(texts(kind, "process-reply").map((t) => t.type)).toEqual(expect.arrayContaining(["fileReplace", "fileFacts"]));
    }
    const plans = texts("valid", "review-workbench-result").map((t) => t.action ?? t.reason);
    expect(plans).toEqual(expect.arrayContaining([...ACTIONS, "ident", "context-only"]));
    expect(texts("valid", "review-workbench-result").some((t) => Array.isArray(t.files))).toBe(true);
    expect(texts("invalid", "review-workbench-result").some((t) => Array.isArray(t.files))).toBe(true);
    const runs = texts("valid", "run-workbench-result").map((t) => t.reason ?? t.action);
    expect(runs).toEqual(expect.arrayContaining(["revert-files", "revert-changed"]));
    expect(texts("valid", "mutation-request").map((t) => t.action)).toEqual(expect.arrayContaining(ACTIONS));
    const replaces = texts("valid", "process-request").filter((t) => t.type === "fileReplace");
    expect(replaces.some((t) => "bytes" in t)).toBe(true);
    expect(replaces.some((t) => "source" in t && "folders" in t)).toBe(true);
    expect(texts("valid", "process-reply").map((t) => t.type)).toContain("tempRemove");
  });
});
