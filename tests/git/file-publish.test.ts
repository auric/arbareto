// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T200: the pure decisions of `applyFile` (contract §4 "File staging" steps 5 and 6, "Blob proof"). No Git process runs.

import { describe, expect, test } from "bun:test";
import { decideFileAction, type FileActionCategory } from "../../src/contracts/file-action";
import type { RawIndexEntry } from "../../src/git-service/eligibility";
import { changedEntries, digestSink, fileApproval, indexInfoInput, type ExpectedChange, type FileAction } from "../../src/git-service/file-publish";
import type { RetainedComparison } from "../../src/git-service/comparison";
import type { ChangeSnapshot } from "../../src/git-service/snapshot";
import type { Workspace } from "../../src/git-service/registration";
import { printOrigin } from "../origin";

printOrigin("../../src/git-service/file-publish.ts", import.meta.dir);

const HEAD = "1".repeat(40);
const INDEX = "2".repeat(40);
const STAGED = "3".repeat(40);
const ZERO = "0".repeat(40);
const bytes = (text: string) => new Uint8Array(Buffer.from(text, "latin1"));
const text = (value: Uint8Array) => Buffer.from(value).toString("latin1");

// One `status --porcelain=v2 -z` record without its final NUL, and its decided file action.
function actionOf(category: FileActionCategory, record: string, headUnborn = false): FileAction {
  const decision = decideFileAction({ category, record: bytes(record), headUnborn, indexFlags: { intentToAdd: false, assumeUnchanged: false, skipWorktree: false }, attributes: {}, working: { type: "absent" } });
  if (decision.direction === null) throw new Error(`refused: ${JSON.stringify(decision)}`);
  return decision;
}
const unstageRows = (action: FileAction) => (action.direction === "unstage" ? action.changedPaths : []);

describe("indexInfoInput (contract §4 step 5, git-update-index(1) `--index-info`)", () => {
  test.each([
    ["modified", actionOf("staged", `1 M. N... 100644 100644 100644 ${HEAD} ${INDEX} a.txt`), `100644 ${HEAD}\ta.txt\0`],
    ["executable", actionOf("staged", `1 M. N... 100755 100644 100644 ${HEAD} ${INDEX} a.sh`), `100755 ${HEAD}\ta.sh\0`],
    ["added, mode 0", actionOf("staged", `1 A. N... 000000 100644 100644 ${ZERO} ${INDEX} new.txt`), `0 ${ZERO}\tnew.txt\0`],
    ["rename, 2 rows", actionOf("staged", `2 R. N... 100644 100644 100644 ${HEAD} ${INDEX} R100 dst.txt\0src.txt`), `100644 ${HEAD}\tsrc.txt\0` + `0 ${ZERO}\tdst.txt\0`],
    ["copy, destination only", actionOf("staged", `2 C. N... 100644 100644 100644 ${HEAD} ${INDEX} C100 dst.txt\0src.txt`), `0 ${ZERO}\tdst.txt\0`],
    ["unborn", actionOf("staged", `1 A. N... 000000 100644 100644 ${ZERO} ${INDEX} first.txt`, true), `0 ${ZERO}\tfirst.txt\0`],
    ["path with space and tab", actionOf("staged", `1 M. N... 100644 100644 100644 ${HEAD} ${INDEX} a b\tc.txt`), `100644 ${HEAD}\ta b\tc.txt\0`],
  ])("%s", (_name, action, expected) => {
    expect(text(indexInfoInput(unstageRows(action)))).toBe(expected);
  });
});

describe("changedEntries (contract §4 step 6)", () => {
  const CLEAN = { stage: 0, assumeUnchanged: false, skipWorktree: false, intentToAdd: false };
  const entry = (path: string, oid: string, mode = "100644", extra: Partial<RawIndexEntry> = {}): RawIndexEntry => ({ path: bytes(path), mode, oid, ...CLEAN, ...extra });
  const canonical = [entry("a.txt", INDEX), entry("b.txt", INDEX)];
  const stage = (path: string): FileAction => ({ direction: "stage", changedPaths: [{ path: bytes(path) }] });
  const target = (action: FileAction, mode: string | null = "100644", deletion = false): ExpectedChange => ({ action, mode, deletion, objectFormat: "sha1" });
  const unstage = actionOf("staged", `1 M. N... 100644 100644 100644 ${HEAD} ${INDEX} a.txt`);
  const added = actionOf("staged", `1 A. N... 000000 100644 100644 ${ZERO} ${INDEX} a.txt`);
  const rename = actionOf("staged", `2 R. N... 100644 100644 100644 ${HEAD} ${INDEX} R100 a.txt\0src.txt`);

  test.each([
    ["stage: the working mode and a new blob", target(stage("a.txt")), [entry("a.txt", STAGED), entry("b.txt", INDEX)], { staged: STAGED }],
    ["stage: another mode than status reported", target(stage("a.txt")), [entry("a.txt", STAGED, "100755"), entry("b.txt", INDEX)], { detail: "selected-entry" }],
    ["stage: a set assume-unchanged flag", target(stage("a.txt")), [entry("a.txt", STAGED, "100644", { assumeUnchanged: true }), entry("b.txt", INDEX)], { detail: "selected-entry" }],
    ["stage: a set skip-worktree flag", target(stage("a.txt")), [entry("a.txt", STAGED, "100644", { skipWorktree: true }), entry("b.txt", INDEX)], { detail: "selected-entry" }],
    ["stage: a higher stage", target(stage("a.txt")), [entry("a.txt", STAGED, "100644", { stage: 2 }), entry("b.txt", INDEX)], { detail: "selected-entry" }],
    ["stage: a malformed object ID", target(stage("a.txt")), [entry("a.txt", "xyz"), entry("b.txt", INDEX)], { detail: "selected-entry" }],
    ["stage: a changed unrelated entry", target(stage("a.txt")), [entry("a.txt", STAGED), entry("b.txt", STAGED)], { detail: "unrelated-entries" }],
    ["stage: a removed unrelated entry", target(stage("a.txt")), [entry("a.txt", STAGED)], { detail: "unrelated-entries" }],
    ["stage untracked: mode 100644", target(stage("c.txt"), null), [entry("a.txt", INDEX), entry("b.txt", INDEX), entry("c.txt", STAGED)], { staged: STAGED }],
    ["stage untracked: mode 100755", target(stage("c.txt"), null), [entry("a.txt", INDEX), entry("b.txt", INDEX), entry("c.txt", STAGED, "100755")], { staged: STAGED }],
    ["stage untracked: mode 120000", target(stage("c.txt"), null), [entry("a.txt", INDEX), entry("b.txt", INDEX), entry("c.txt", STAGED, "120000")], { detail: "selected-entry" }],
    ["stage untracked: no entry", target(stage("c.txt"), null), canonical, { detail: "selected-entry" }],
    ["stage deletion: the entry is gone", target(stage("a.txt"), "000000", true), [entry("b.txt", INDEX)], { staged: null }],
    ["stage deletion: the entry stays", target(stage("a.txt"), "000000", true), canonical, { detail: "selected-entry" }],
    ["unstage: the HEAD entry", target(unstage, null), [entry("a.txt", HEAD), entry("b.txt", INDEX)], { staged: null }],
    // `--index-info` skips a path that `verify_path` refuses and exits 0 (research R3).
    ["unstage: the canonical entry stays", target(unstage, null), canonical, { detail: "selected-entry" }],
    ["unstage: mode 0 removes the path", target(added, null), [entry("b.txt", INDEX)], { staged: null }],
    ["unstage: mode 0 and the canonical entry stays", target(added, null), canonical, { detail: "selected-entry" }],
    ["unstage rename: the source HEAD entry and no destination", target(rename, null), [entry("b.txt", INDEX), entry("src.txt", HEAD)], { staged: null }],
    ["unstage rename: the destination stays", target(rename, null), [entry("a.txt", INDEX), entry("b.txt", INDEX), entry("src.txt", HEAD)], { detail: "selected-entry" }],
  ] as const)("%s", (_name, t, candidate, expected) => {
    expect(changedEntries(t, candidate, canonical)).toEqual(expected);
  });
});

describe("digestSink (contract §4 \"Blob proof\" proof A)", () => {
  const sha = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

  test("the verified size stays within the bound, and the digest covers the pushed bytes", () => {
    const sink = digestSink(3);
    sink.push(bytes("ab"));
    sink.push(bytes("c"));
    expect({ bytes: sink.bytes, limited: sink.limited, digest: sink.digest() }).toEqual({ bytes: 3, limited: false, digest: sha("abc") });
  });

  test.each([
    ["one chunk", ["abcd"]],
    ["a later chunk", ["abc", "d"]],
  ])("the sink goes limited at the verified size plus one byte: %s", (_name, chunks) => {
    const sink = digestSink(3);
    for (const chunk of chunks) sink.push(bytes(chunk));
    expect({ bytes: sink.bytes, limited: sink.limited, digest: sink.digest() }).toEqual({ bytes: 4, limited: true, digest: sha("abc") });
  });

  test("an empty blob of size 0", () => {
    const sink = digestSink(0);
    expect({ limited: sink.limited, digest: sink.digest() }).toEqual({ limited: false, digest: sha("") });
  });
});

describe("fileApproval (data-model §6, contract §4 \"Binding\")", () => {
  const w = { gitInstallationId: "g", worktreeIdentity: [{}, {}], commonIdentity: {} } as unknown as Workspace;
  const s = { head: { state: "unborn", target: "refs/heads/main" }, indexFingerprint: { rawIndexDigest: null }, indexEntries: [], policyFingerprint: "p", operationState: "normal" } as unknown as ChangeSnapshot;
  const comparison = (fileAction: RetainedComparison["fileAction"]) =>
    ({
      comparisonId: "c",
      repositoryId: "r",
      snapshotId: "s",
      generation: 1,
      entry: { entryId: "e", pathBytes: Buffer.from("a.txt").toString("base64"), category: "unstaged" },
      fileAction,
      working: { size: 3, sha256: "d".repeat(64) },
      attributes: {},
      workingVersion: null,
    }) as unknown as RetainedComparison;

  test("stage binds the whole working file, unstage binds no working values, and a refused entry gets none", () => {
    const staged = fileApproval(comparison({ direction: "stage", changedPaths: [{ path: bytes("a.txt") }] }), s, w);
    const unstaged = fileApproval(comparison({ direction: "unstage", changedPaths: [] }), s, w);
    expect({ kind: staged?.kind, entryId: staged?.entryId, direction: staged?.direction, working: staged?.binding.working }).toEqual({ kind: "file", entryId: "e", direction: "stage", working: { size: 3, sha256: "d".repeat(64) } });
    expect({ direction: unstaged?.direction, working: unstaged?.binding.working }).toEqual({ direction: "unstage", working: null });
    expect(fileApproval(comparison({ direction: null, code: "UNSUPPORTED_COMPARISON", reason: "size" }), s, w)).toBeNull();
    expect(fileApproval(comparison({ direction: "stage", changedPaths: [] }), { ...s, policyFingerprint: null }, w)).toBeNull();
  });
});
