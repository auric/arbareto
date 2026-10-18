// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T016: the feature 004 contract changes (contract Δ1 to Δ7, Δ9 to Δ12; spec FR-001, FR-004, FR-040, FR-071).

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

// The module namespaces give `undefined` for a missing export, so each case fails on its own before T017.
const L = limits as unknown as Record<string, number>;
const E = errors as unknown as Record<string, readonly string[]> & typeof errors;
const P = channel as unknown as Record<string, z.ZodType> & Record<string, readonly string[]> & typeof channel;

const KIB = 1024;
const MIB = 1024 * KIB;
const OID = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = "a".repeat(64);
const SEP = isWindows ? "\\" : "/";
const REPO = isWindows ? "C:\\repo" : "/repo";
const GIT_DIR = `${REPO}${SEP}.git`;
const WORKTREE = isWindows ? "C:\\repo-wt" : "/repo-wt";
const GIT_PATH = isWindows ? "C:\\Program Files\\Git\\cmd\\git.exe" : "/usr/bin/git";
const IDENTITY = { volumeSerial: "0123456789abcdef", fileId: "0123456789abcdef0123456789abcdef" };
const id = () => crypto.randomUUID();
const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;
const b64 = (text: string) => Buffer.from(text).toString("base64");

const NEW_RENDERER = ["readBranches", "readWorktrees", "readGitSettings", "reviewWorkbench", "runWorkbench", "applyFiles", "openWorktree", "revealPath"];
const NEW_SHELL = ["setSwitchChoice"];
const WORKBENCH_ACTIONS = ["switch", "create-branch", "rename-branch", "delete-branch", "merge", "rebase", "choose-side", "mergetool", "ignore", "worktree-add", "worktree-remove", "worktree-prune", "config-save"];
// Contract Δ6: the close prompt names each of these.
const STARTED_ACTIONS = [
  "switch",
  "create-branch",
  "rename-branch",
  "delete-branch",
  "merge",
  "rebase",
  "choose-ours",
  "choose-theirs",
  "mergetool",
  "ignore-gitignore",
  "ignore-exclude",
  "worktree-add",
  "worktree-remove",
  "worktree-prune",
  "config-save",
];
const WORKBENCH_PHASES = ["switch-stash", "switch-checkout", "switch-reapply", "switch-drop", "branch", "merge", "rebase", "resolve", "mergetool", "worktree", "config", "ignore", "stage-files"];

const request = (operation: string, payload: unknown, target: Record<string, unknown> = {}) => ({ version: 1, sessionId: id(), requestId: id(), operation, ...target, payload });
const check = (value: unknown, side: "renderer" | "service" = "renderer") => {
  const result = envelope.validateRequest(value, side);
  return result.ok ? "ok" : result.code;
};
const repo = () => ({ repositoryId: id() });
const gen = () => ({ repositoryId: id(), repositoryGeneration: 3 });
const shown = () => ({ snapshotId: id(), entryId: id() });

describe("contract Δ5 bounds", () => {
  test("each named bound has its contract value", () => {
    expect(L.MULTI_FILE_ACTION_FILES).toBe(10_000);
    expect(L.MULTI_FILE_ACTION_BYTES).toBe(512 * MIB);
    expect(L.MULTI_FILE_ACTION_BYTES).toBe(limits.STREAMED_PROCESS_INPUT_BYTES);
    expect(L.DISCARD_CHECK_PATHS).toBe(20_000);
    expect(L.WORKTREE_RECORDS).toBe(1000);
    expect(L.WORKTREE_LISTING_BYTES).toBe(4 * MIB);
    expect(L.REFLOG_SCAN_ENTRIES).toBe(10_000);
    expect(L.MERGE_MESSAGE_BYTES).toBe(8 * KIB);
  });

  test("the reused bounds keep their values", () => {
    expect(limits.APPROVAL_LIFETIME_MS).toBe(60_000);
    expect(limits.READ_DEADLINE_MS).toBe(30_000);
    expect(limits.COMMIT_MESSAGE_BYTES).toBe(64 * KIB);
    expect(limits.SUBMODULE_UPDATE_INACTIVITY_MS).toBe(300_000);
    expect(limits.SUBMODULE_UPDATE_CEILING_MS).toBe(4 * 60 * 60 * 1000);
    expect(limits.REF_LISTING_RECORDS).toBe(10_000);
    expect(limits.REF_LISTING_BYTES).toBe(4 * MIB);
  });

  test("a bound name is an OUTPUT_LIMIT reason", () => {
    for (const reason of ["MULTI_FILE_ACTION_FILES", "DISCARD_CHECK_PATHS", "WORKTREE_RECORDS", "WORKTREE_LISTING_BYTES", "REFLOG_SCAN_ENTRIES"]) {
      expect(ok(envelope.Completeness, { state: "limited", code: "OUTPUT_LIMIT", reason })).toBe(true);
    }
  });
});

describe("contract Δ9 codes", () => {
  const CODES = ["WORKBENCH_UNAVAILABLE", "UNTRACKED_IN_WAY", "STASH_KEPT"];

  test("errors.ts holds the three new codes, and each fits a failed or rejected response", () => {
    for (const code of CODES) {
      expect(errors.isErrorCode(code)).toBe(true);
      expect(errors.codeFitsState("failed", code)).toBe(true);
      expect(errors.codeFitsState("rejected", code)).toBe(true);
    }
  });

  test("each new code has exactly its contract reasons", () => {
    expect([...(E.WORKBENCH_UNAVAILABLE_REASONS ?? [])]).toEqual([
      "detached",
      "unborn",
      "current-branch",
      "other-worktree",
      "name-exists",
      "invalid-name",
      "reserved-name",
      "same-branch",
      "ff-only",
      "dirty-tree",
      "interactive",
      "no-merge-tool",
      "merge-tool-name",
      "side-missing",
      "side-not-regular",
      "stages-missing",
      "main-worktree",
      "current-worktree",
      "locked",
      "prunable",
      "nothing-to-prune",
      "multi-value",
      "limit",
      "push-current-only",
      "ignore-exists",
      "ignore-not-text",
      "ignore-not-regular",
      "ignore-size",
      "path",
      "message-size",
      "unreadable",
      "no-tracking-refspec",
      "several-tracking-remotes",
      "squash-no-ff",
      "merge-options",
      "invalid-config",
      "unknown-operation",
      "apply-backend",
      "config-in-include",
      "included",
      "unreadable-value",
    ]);
    expect([...(E.UNTRACKED_IN_WAY_REASONS ?? [])]).toEqual(["untracked-in-way"]);
    expect([...(E.STASH_KEPT_REASONS ?? [])]).toEqual(["conflicts", "failed-apply", "failed-checkout", "not-found", "stash-changed"]);
  });

  test("the file action reasons add the five line refusals, which no readComparison decision gives", () => {
    for (const reason of ["context-only", "several-hunks", "deleted-file", "new-file", "eof-newline"]) {
      expect(FILE_ACTION_REASONS).toContain(reason as never);
      const comparison = { completeness: { state: "limited", code: "OBJECT_MISSING" }, scope: "index-to-worktree", support: null, remedy: null, objectRemedy: { text: "Fetch." } };
      expect(ok(envelope.ReadComparisonResult, { ...comparison, fileAction: reason })).toBe(false);
    }
  });
});

describe("contract Δ1 operations", () => {
  test("the operation list holds the eight forwarded operations and the shell-only operation", () => {
    expect(operations.OPERATIONS).toEqual(expect.arrayContaining([...NEW_RENDERER, ...NEW_SHELL]));
  });

  test("the shell answers setSwitchChoice and never forwards it, and revealPath reaches the service", () => {
    expect(operations.SHELL_ONLY).toEqual(expect.arrayContaining(NEW_SHELL));
    for (const name of NEW_RENDERER) expect(operations.SHELL_ONLY).not.toContain(name);
    expect(check(request("setSwitchChoice", { choice: "keep" }), "service")).toBe("UNKNOWN_OPERATION");
    expect(check(request("revealPath", { repositoryId: id(), entryId: id() }), "service")).toBe("ok");
  });

  test("openWorktree, reviewWorkbench, and setSwitchChoice are native-first", () => {
    const names = (envelope.NativeFirstEnvelope.options as readonly { shape: { operation: { value: string } } }[]).map((o) => o.shape.operation.value);
    expect(names).toEqual(expect.arrayContaining(["openWorktree", "reviewWorkbench", ...NEW_SHELL]));
    for (const name of ["readBranches", "readWorktrees", "readGitSettings", "runWorkbench", "applyFiles", "revealPath"]) expect(names).not.toContain(name);
  });

  test("only the worktree-add review is native-first", () => {
    const native = (payload: unknown) => ok(envelope.NativeFirstEnvelope, request("reviewWorkbench", payload, gen()));
    expect(native({ action: "worktree-add", branch: { new: "wt", start: OID }, path: WORKTREE })).toBe(true);
    expect(native({ action: "worktree-add", branch: { existing: "refs/heads/topic" }, path: WORKTREE })).toBe(true);
    expect(native({ action: "worktree-add", branch: { new: "wt", start: OID }, bootstrapId: id() })).toBe(false);
    expect(native({ action: "switch", target: { ref: "refs/heads/main" }, choice: "keep" })).toBe(false);
  });
});

describe("contract Δ2 envelope", () => {
  test("MUTATIONS holds runWorkbench and applyFiles, and a recovery marker has kind workbench or applyFiles", () => {
    expect(operations.MUTATIONS).toEqual(expect.arrayContaining(["runWorkbench", "applyFiles"] as never[]));
    for (const name of ["reviewWorkbench", "openWorktree", "readGitSettings"]) expect(operations.MUTATIONS).not.toContain(name as never);
    for (const kind of ["workbench", "applyFiles", "sync", "commit"]) expect(ok(operations.MutationKind, kind)).toBe(true);
    expect(ok(operations.MutationKind, "runWorkbench")).toBe(false);
  });

  test("readBranches, readWorktrees, and reviewWorkbench carry repositoryId and repositoryGeneration", () => {
    for (const [name, payload] of [
      ["readBranches", {}],
      ["readWorktrees", {}],
      ["reviewWorkbench", { action: "worktree-prune" }],
    ] as const) {
      expect(check(request(name, payload, gen()))).toBe("ok");
      expect(check(request(name, payload, gen()), "service")).toBe("ok");
      expect(check(request(name, payload, repo()))).toBe("INVALID_REQUEST");
      expect(check(request(name, payload, { repositoryGeneration: 3 }))).toBe("INVALID_REQUEST");
    }
  });

  test("runWorkbench and applyFiles carry repositoryId and no repositoryGeneration", () => {
    const files = { snapshotId: id(), entryIds: [id()], direction: "stage", kind: "selected" };
    for (const [name, payload] of [
      ["runWorkbench", { workbenchToken: id(), start: true }],
      ["applyFiles", files],
    ] as const) {
      expect(check(request(name, payload, repo()))).toBe("ok");
      expect(check(request(name, payload, repo()), "service")).toBe("ok");
      expect(check(request(name, payload, gen()))).toBe("INVALID_REQUEST");
      expect(check(request(name, payload))).toBe("INVALID_REQUEST");
    }
  });

  test("readGitSettings runs with or without repositoryId, and without repositoryGeneration", () => {
    for (const side of ["renderer", "service"] as const) {
      expect(check(request("readGitSettings", {}, repo()), side)).toBe("ok");
      expect(check(request("readGitSettings", {}), side)).toBe("ok");
      expect(check(request("readGitSettings", {}, gen()), side)).toBe("INVALID_REQUEST");
    }
    expect(check(request("readGitSettings", { scope: "global" }))).toBe("INVALID_REQUEST");
  });

  test("openWorktree, revealPath, and setSwitchChoice carry no envelope repositoryId", () => {
    expect(check(request("openWorktree", { repositoryId: id(), path: WORKTREE }, repo()))).toBe("INVALID_REQUEST");
    expect(check(request("revealPath", { repositoryId: id(), entryId: id() }, repo()))).toBe("INVALID_REQUEST");
    expect(check(request("setSwitchChoice", { choice: "stash" }, repo()))).toBe("INVALID_REQUEST");
  });
});

describe("contract Δ2 progress", () => {
  const event = (phase: string, counters: Record<string, number> = {}, extra: Record<string, unknown> = {}) => ({ requestId: id(), operationId: id(), state: "running", phase, counters, stalled: false, ...extra });

  test("the thirteen phases exist", () => {
    expect(operations.PHASES).toEqual(expect.arrayContaining(WORKBENCH_PHASES));
    for (const phase of WORKBENCH_PHASES) {
      expect(ok(envelope.ProgressEvent, event(phase))).toBe(true);
      expect(ok(envelope.ProgressEvent, event(phase, {}, { stalled: true }))).toBe(true);
    }
  });

  test("stage-files counts files, config counts keys, and the other phases carry no counter", () => {
    expect(ok(envelope.ProgressEvent, event("stage-files", { fileIndex: 3, fileCount: 10 }))).toBe(true);
    expect(ok(envelope.ProgressEvent, event("config", { keyIndex: 1, keyCount: 2 }))).toBe(true);
    expect(ok(envelope.ProgressEvent, event("stage-files", { keyIndex: 1 }))).toBe(false);
    expect(ok(envelope.ProgressEvent, event("config", { fileIndex: 1 }))).toBe(false);
    for (const phase of WORKBENCH_PHASES.filter((p) => p !== "stage-files" && p !== "config")) {
      for (const counter of ["percent", "fileIndex", "keyIndex", "rowIndex"]) expect(ok(envelope.ProgressEvent, event(phase, { [counter]: 1 }))).toBe(false);
    }
  });

  test("a workbench event carries no ref name, path, or Git text", () => {
    for (const phase of WORKBENCH_PHASES) {
      expect(ok(envelope.ProgressEvent, event(phase, {}, { path: "src/a.ts" }))).toBe(false);
      for (const field of ["ref", "branch", "text", "message"]) expect(ok(envelope.ProgressEvent, event(phase, {}, { [field]: "main" }))).toBe(false);
    }
  });
});

describe("contract Δ3 payloads", () => {
  const review = (payload: unknown, side: "renderer" | "service" = "renderer") => check(request("reviewWorkbench", payload, gen()), side);

  const FORMS = [
    { action: "switch", target: { ref: "refs/heads/feature/x" }, choice: "keep" },
    { action: "switch", target: { ref: "refs/heads/main" }, choice: "stash" },
    { action: "switch", target: { track: { ref: "refs/remotes/origin/topic", name: "topic" } }, choice: "discard" },
    { action: "switch", target: { detach: OID }, choice: "keep" },
    // Plan D4: the service refuses `@` with WORKBENCH_UNAVAILABLE reason reserved-name.
    { action: "switch", target: { ref: "refs/heads/@" }, choice: "keep" },
    { action: "create-branch", name: "feature/y", start: OID, switchTo: true },
    { action: "create-branch", name: "@", start: OID, switchTo: false },
    { action: "rename-branch", ref: "refs/heads/old", name: "new" },
    { action: "delete-branch", ref: "refs/heads/old" },
    { action: "merge", ref: "refs/heads/topic", result: "merge", noFastForward: true, noCommit: true, message: null },
    { action: "merge", ref: "refs/remotes/origin/topic", result: "merge", noFastForward: false, noCommit: false, message: "Merge topic\n\nBody" },
    { action: "merge", ref: "refs/heads/topic", result: "squash", noFastForward: false, noCommit: false, message: null },
    { action: "rebase", ref: "refs/remotes/origin/main", autostash: true, autosquash: false },
    { action: "choose-side", ...shown(), side: "ours" },
    { action: "choose-side", ...shown(), side: "theirs" },
    { action: "mergetool", ...shown() },
    { action: "ignore", ...shown(), target: "gitignore" },
    { action: "ignore", ...shown(), target: "exclude" },
    { action: "worktree-remove", worktree: WORKTREE, force: false, deleteBranch: true },
    // Contract Δ11: the worktree paths of a WSL repository are Linux paths.
    { action: "worktree-remove", worktree: "/home/u/repo-wt", force: true, deleteBranch: false },
    { action: "worktree-prune" },
    { action: "config-save", scope: "local", changes: [{ key: "pull.rebase", value: "true" }] },
    { action: "config-save", scope: "global", changes: [{ key: "core.autocrlf", value: null }, { key: "mergetool.fixture.cmd", value: 'fixture "$MERGED"' }] },
  ];

  test("each reviewWorkbench action decodes on both sides", () => {
    const actions = new Set<string>();
    for (const payload of FORMS) {
      expect(review(payload)).toBe("ok");
      expect(review(payload, "service")).toBe("ok");
      actions.add(payload.action);
    }
    expect([...actions, "worktree-add"].toSorted()).toEqual(WORKBENCH_ACTIONS.toSorted());
    expect<string[]>([...(P.WORKBENCH_ACTIONS ?? [])]).toEqual(WORKBENCH_ACTIONS);
  });

  test("worktree-add takes the path from the renderer and the bound bootstrapId on the service side", () => {
    for (const branch of [{ new: "wt", start: OID }, { existing: "refs/heads/topic" }]) {
      expect(review({ action: "worktree-add", branch, path: WORKTREE })).toBe("ok");
      expect(review({ action: "worktree-add", branch, bootstrapId: id() }, "service")).toBe("ok");
      expect(review({ action: "worktree-add", branch, bootstrapId: id() })).toBe("INVALID_REQUEST");
      expect(review({ action: "worktree-add", branch, path: WORKTREE }, "service")).toBe("INVALID_REQUEST");
      expect(review({ action: "worktree-add", branch, path: WORKTREE, bootstrapId: id() }, "service")).toBe("INVALID_REQUEST");
    }
    expect(review({ action: "worktree-add", branch: { new: "wt", start: OID }, path: "wt" })).toBe("INVALID_REQUEST");
    expect(review({ action: "worktree-add", branch: { existing: "topic" }, path: WORKTREE })).toBe("INVALID_REQUEST");
    expect(review({ action: "worktree-add", branch: { new: "wt", start: OID, existing: "refs/heads/a" }, path: WORKTREE })).toBe("INVALID_REQUEST");
    expect(review({ action: "worktree-add", branch: { new: "wt" }, path: WORKTREE })).toBe("INVALID_REQUEST");
  });

  test("a reviewWorkbench form outside the contract gives INVALID_REQUEST", () => {
    const bad = [
      {},
      { action: "checkout", target: { ref: "refs/heads/main" }, choice: "keep" },
      { action: "switch", target: { ref: "refs/heads/main" }, choice: "force" },
      { action: "switch", target: { ref: "refs/heads/main" } },
      { action: "switch", target: { ref: "main" }, choice: "keep" },
      { action: "switch", target: { ref: "refs/heads/" }, choice: "keep" },
      { action: "switch", target: { ref: "refs/remotes/origin/main" }, choice: "keep" },
      { action: "switch", target: { track: { ref: "refs/heads/main", name: "main" } }, choice: "keep" },
      { action: "switch", target: { track: { ref: "refs/remotes/origin/x", name: "" } }, choice: "keep" },
      { action: "switch", target: { track: { ref: "refs/remotes/origin/x" } }, choice: "keep" },
      { action: "switch", target: { detach: "HEAD" }, choice: "keep" },
      { action: "switch", target: { ref: "refs/heads/a", detach: OID }, choice: "keep" },
      { action: "create-branch", name: "a\u0000b", start: OID, switchTo: true },
      { action: "create-branch", name: "a\ud800", start: OID, switchTo: true },
      { action: "create-branch", name: "", start: OID, switchTo: true },
      { action: "create-branch", name: "a", start: "main", switchTo: true },
      { action: "create-branch", name: "a", start: OID },
      { action: "rename-branch", ref: "refs/remotes/origin/a", name: "b" },
      { action: "rename-branch", ref: "refs/heads/a" },
      { action: "delete-branch", ref: "refs/tags/v1" },
      { action: "delete-branch", ref: "refs/heads/a", force: true },
      { action: "merge", ref: "refs/tags/v1", result: "merge", noFastForward: false, noCommit: false, message: null },
      { action: "merge", ref: "refs/heads/t", result: "octopus", noFastForward: false, noCommit: false, message: null },
      { action: "merge", ref: "refs/heads/t", result: "merge", noFastForward: false, noCommit: false, message: " \n\t" },
      { action: "merge", ref: "refs/heads/t", result: "merge", noFastForward: false, noCommit: false },
      { action: "rebase", ref: "refs/heads/t", autostash: true },
      { action: "rebase", ref: "refs/heads/t", autostash: true, autosquash: false, interactive: true },
      { action: "choose-side", entryId: id(), side: "ours" },
      { action: "choose-side", ...shown(), side: "both" },
      { action: "mergetool", ...shown(), tool: "vimdiff" },
      { action: "ignore", ...shown(), target: "global" },
      { action: "ignore", ...shown(), target: "gitignore", line: "/build/" },
      { action: "worktree-remove", worktree: "", force: false, deleteBranch: false },
      { action: "worktree-remove", worktree: WORKTREE, force: "yes", deleteBranch: false },
      { action: "worktree-prune", expire: "now" },
      { action: "config-save", scope: "system", changes: [{ key: "pull.rebase", value: "true" }] },
      { action: "config-save", scope: "local", changes: [] },
      { action: "config-save", scope: "local", changes: [{ key: "", value: "x" }] },
      { action: "config-save", scope: "local", changes: [{ key: "pull.rebase" }] },
      { action: "config-save", scope: "local", changes: [{ key: "pull.rebase", value: "a\u0000b" }] },
      { action: "config-save", scope: "local", changes: [{ key: "pull.rebase", value: "true" }, { key: "pull.rebase", value: "false" }] },
    ];
    for (const payload of bad) {
      expect(review(payload)).toBe("INVALID_REQUEST");
      expect(review(payload, "service")).toBe("INVALID_REQUEST");
    }
  });

  // Plan D5 and the 2026-10-17 decision: Squash disables No fast-forward and Don't commit, and hides the message.
  test("a squash merge takes no No fast-forward, no Don't commit, and no message", () => {
    const squash = { action: "merge", ref: "refs/heads/t", result: "squash", noFastForward: false, noCommit: false, message: null };
    expect(review(squash)).toBe("ok");
    expect(review({ ...squash, noFastForward: true })).toBe("INVALID_REQUEST");
    expect(review({ ...squash, noCommit: true })).toBe("INVALID_REQUEST");
    expect(review({ ...squash, message: "Squash topic" })).toBe("INVALID_REQUEST");
  });

  test("a branch name holds 1 to 255 UTF-8 bytes (contract Δ5)", () => {
    const create = (name: string) => review({ action: "create-branch", name, start: OID, switchTo: false });
    expect(create("x".repeat(255))).toBe("ok");
    expect(create("x".repeat(256))).toBe("INVALID_REQUEST");
    expect(create("\u20ac".repeat(85))).toBe("ok");
    expect(create("\u20ac".repeat(86))).toBe("INVALID_REQUEST");
    expect(review({ action: "rename-branch", ref: "refs/heads/a", name: "x".repeat(256) })).toBe("INVALID_REQUEST");
    expect(review({ action: "switch", target: { track: { ref: "refs/remotes/origin/x", name: "x".repeat(256) } }, choice: "keep" })).toBe("INVALID_REQUEST");
  });

  test("a merge message follows the 001 commit message rule within MERGE_MESSAGE_BYTES (contract Δ5)", () => {
    const merge = (message: string) => review({ action: "merge", ref: "refs/heads/t", result: "merge", noFastForward: false, noCommit: false, message });
    expect(merge("a".repeat(limits.MERGE_MESSAGE_BYTES))).toBe("ok");
    expect(merge("a".repeat(limits.MERGE_MESSAGE_BYTES + 1))).toBe("INVALID_REQUEST");
    // U+20AC is three UTF-8 bytes: 2,730 of them give 8,190 bytes, and 2,731 give 8,193.
    expect(merge("€".repeat(2730))).toBe("ok");
    expect(merge("€".repeat(2731))).toBe("INVALID_REQUEST");
    expect(merge("")).toBe("INVALID_REQUEST");
  });

  test("config-save takes 1 to 32 changes", () => {
    const changes = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `mergetool.t${i}.cmd`, value: "x" }));
    expect(review({ action: "config-save", scope: "local", changes: changes(32) })).toBe("ok");
    expect(review({ action: "config-save", scope: "local", changes: changes(33) })).toBe("INVALID_REQUEST");
  });

  test("runWorkbench takes the token and start true only", () => {
    expect(check(request("runWorkbench", { workbenchToken: id(), start: true }, repo()))).toBe("ok");
    for (const start of [false, "true", 1, null]) expect(check(request("runWorkbench", { workbenchToken: id(), start }, repo()))).toBe("INVALID_REQUEST");
    expect(check(request("runWorkbench", { workbenchToken: id() }, repo()))).toBe("INVALID_REQUEST");
    expect(check(request("runWorkbench", { workbenchToken: "x", start: true }, repo()))).toBe("INVALID_REQUEST");
    expect(check(request("runWorkbench", { workbenchToken: id(), start: true, action: "switch" }, repo()))).toBe("INVALID_REQUEST");
  });

  describe("applyFiles", () => {
    const files = (fields: Record<string, unknown> = {}, side: "renderer" | "service" = "renderer") =>
      check(request("applyFiles", { snapshotId: id(), entryIds: [id(), id()], direction: "stage", kind: "selected", ...fields }, repo()), side);
    const folder = b64("src/lib");

    test("each data-model §6 kind decodes with its direction", () => {
      const forms = [
        {},
        { direction: "unstage" },
        { kind: "folder", folder },
        { kind: "folder", direction: "unstage", folder },
        { kind: "all-untracked" },
        { kind: "all-changes" },
        { kind: "all-staged", direction: "unstage" },
      ];
      for (const fields of forms) {
        expect(files(fields)).toBe("ok");
        expect(files(fields, "service")).toBe("ok");
      }
    });

    test("entryIds holds 1 to 10,000 unique IDs", () => {
      const ids = (n: number) => Array.from({ length: n }, () => id());
      expect(files({ entryIds: ids(10_000) })).toBe("ok");
      expect(files({ entryIds: ids(10_001) })).toBe("INVALID_REQUEST");
      expect(files({ entryIds: [] })).toBe("INVALID_REQUEST");
      const same = id();
      expect(files({ entryIds: [same, same] })).toBe("INVALID_REQUEST");
      expect(files({ entryIds: ["x"] })).toBe("INVALID_REQUEST");
    });

    test("a form outside data-model §6 gives INVALID_REQUEST", () => {
      const bad = [
        { kind: "folder" },
        { kind: "selected", folder },
        { kind: "folder", folder: "" },
        { kind: "folder", folder: "src/lib" },
        { kind: "all-staged" },
        { kind: "all-untracked", direction: "unstage" },
        { kind: "all-changes", direction: "unstage" },
        { direction: "resolve" },
        { kind: "all" },
        { paths: ["src/a.ts"] },
      ];
      for (const fields of bad) expect(files(fields)).toBe("INVALID_REQUEST");
      expect(check(request("applyFiles", { entryIds: [id()], direction: "stage", kind: "selected" }, repo()))).toBe("INVALID_REQUEST");
    });
  });

  test("applyHunk takes ascending unique line ordinals from 1", () => {
    const hunk = (lines?: unknown, side: "renderer" | "service" = "renderer") =>
      check(request("applyHunk", { comparisonId: id(), hunkId: id(), snapshotId: id(), direction: "stage", ...(lines === undefined ? {} : { lines }) }, gen()), side);
    for (const lines of [undefined, [1], [2, 5, 9], [limits.CANONICAL_DIFF_LINES]]) {
      expect(hunk(lines)).toBe("ok");
      expect(hunk(lines, "service")).toBe("ok");
    }
    for (const lines of [[], [0], [-1], [3, 2], [2, 2], [1.5], ["1"], [limits.CANONICAL_DIFF_LINES + 1], null]) expect(hunk(lines)).toBe("INVALID_REQUEST");
    expect(check(request("applyFile", { comparisonId: id(), snapshotId: id(), direction: "stage", lines: [1] }, gen()))).toBe("INVALID_REQUEST");
  });

  test("reviewCommit takes amend true", () => {
    expect(check(request("reviewCommit", { snapshotId: id(), amend: true }, gen()))).toBe("ok");
    expect(check(request("reviewCommit", { snapshotId: id(), amend: true }, gen()), "service")).toBe("ok");
    for (const amend of [false, "true", null]) expect(check(request("reviewCommit", { snapshotId: id(), amend }, gen()))).toBe("INVALID_REQUEST");
  });

  test("commit takes amend true and confirmRewrite true, and confirmRewrite only with amend", () => {
    const commit = (fields: Record<string, unknown>) => check(request("commit", { reviewToken: id(), message: "Fix parser", confirmFullScope: true, ...fields }, gen()));
    expect(commit({ amend: true })).toBe("ok");
    expect(commit({ amend: true, confirmRewrite: true })).toBe("ok");
    expect(commit({ confirmRewrite: true })).toBe("INVALID_REQUEST");
    for (const value of [false, "true", null]) {
      expect(commit({ amend: value })).toBe("INVALID_REQUEST");
      expect(commit({ amend: true, confirmRewrite: value })).toBe("INVALID_REQUEST");
    }
    expect(commit({ amend: true, message: " \n" })).toBe("INVALID_REQUEST");
  });

  test("reviewSubmodules takes an optional scope path, and updateSubmodules takes confirmHosts true", () => {
    const scoped = (scope?: unknown) => check(request("reviewSubmodules", { snapshotId: id(), ...(scope === undefined ? {} : { scope }) }, gen()));
    expect(scoped()).toBe("ok");
    expect(scoped({ path: "libs/a" })).toBe("ok");
    for (const scope of [{}, { path: "" }, "libs/a", { path: "libs/a", nested: false }, null]) expect(scoped(scope)).toBe("INVALID_REQUEST");
    const update = (fields: Record<string, unknown>) => check(request("updateSubmodules", { submoduleReviewToken: id(), start: true, ...fields }, gen()));
    expect(update({ confirmHosts: true })).toBe("ok");
    for (const confirmHosts of [false, "true", null]) expect(update({ confirmHosts })).toBe("INVALID_REQUEST");
  });

  test("openWorktree takes the record path from the renderer and the bound bootstrapId on the service side", () => {
    expect(check(request("openWorktree", { repositoryId: id(), path: WORKTREE }))).toBe("ok");
    expect(check(request("openWorktree", { repositoryId: id(), path: "/home/u/repo-wt" }))).toBe("ok");
    expect(check(request("openWorktree", { repositoryId: id(), bootstrapId: id() }), "service")).toBe("ok");
    expect(check(request("openWorktree", { repositoryId: id(), bootstrapId: id() }))).toBe("INVALID_REQUEST");
    expect(check(request("openWorktree", { repositoryId: id(), path: WORKTREE }), "service")).toBe("INVALID_REQUEST");
    for (const payload of [{ repositoryId: id(), path: "" }, { path: WORKTREE }, { repositoryId: "x", path: WORKTREE }]) expect(check(request("openWorktree", payload))).toBe("INVALID_REQUEST");
  });

  test("revealPath names an entry, and setSwitchChoice takes keep or stash (data-model §13)", () => {
    for (const side of ["renderer", "service"] as const) expect(check(request("revealPath", { repositoryId: id(), entryId: id() }), side)).toBe("ok");
    expect(check(request("revealPath", { repositoryId: id() }))).toBe("INVALID_REQUEST");
    expect(check(request("revealPath", { repositoryId: id(), entryId: id(), path: WORKTREE }))).toBe("INVALID_REQUEST");
    for (const choice of ["keep", "stash"]) expect(check(request("setSwitchChoice", { choice }))).toBe("ok");
    for (const choice of ["discard", "Keep", "", null]) expect(check(request("setSwitchChoice", { choice }))).toBe("INVALID_REQUEST");
  });

  test("readBranches and readWorktrees take an empty payload", () => {
    for (const name of ["readBranches", "readWorktrees"]) expect(check(request(name, { pattern: "refs/heads" }, gen()))).toBe("INVALID_REQUEST");
  });
});

describe("contract Δ7 and Δ11 process texts", () => {
  const policies = policyFile.policies as Record<string, unknown>;

  test("policy mergetool is integrate: the remove list, prefixes, preserve list, GIT_EDITOR=:, and no index variable", () => {
    expect(policies.mergetool).toEqual(policies.integrate);
    expect(policies.mergetool).toMatchObject({ set: { GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: ":" }, indexFileVariable: null });
  });

  test("a run frame takes the policy mergetool", () => {
    expect(channel.EnvironmentPolicy.options).toContain("mergetool" as never);
  });

  test("the WSL wrapper mode mergetool exports GIT_EDITOR=: and keeps its scope after Git exits", () => {
    expect(wslProcess.wrapper).toContain("mergetool) export GIT_EDITOR=: ;;");
    expect(wslProcess.wrapper).toContain("integrate) export GIT_EDITOR=: ;;");
    expect(wslProcess.wrapper).toContain("case $mode in probe | read | search) end ;; esac");
  });
});

describe("contract Δ6 private requests", () => {
  const call = { callId: id(), operationId: id() };
  const network = { inactivityMs: limits.SUBMODULE_UPDATE_INACTIVITY_MS, ceilingMs: limits.SUBMODULE_UPDATE_CEILING_MS, stallMs: limits.STALL_NOTICE_MS };
  const run = (context: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: "run", ...call, arguments: ["--no-lazy-fetch", "worktree", "prune"], environmentPolicy: "integrate", limits: network, ...context, ...extra });
  const registered = { contextKind: "registeredOperation", gitInstallationId: id(), repositoryId: id() };
  const globalConfig = { contextKind: "globalConfig", gitInstallationId: id() };
  const worktreeAdd = { contextKind: "worktreeAdd", gitInstallationId: id(), repositoryId: id(), bootstrapId: id() };
  const frame = (value: unknown) => ok(channel.ProcessRequest, value);
  const reply = (value: unknown) => ok(channel.ProcessReply, value);

  test("a mergetool run takes the 4-hour ceiling and no inactivity limit", () => {
    const tool = { environmentPolicy: "mergetool", arguments: ["--no-lazy-fetch", "--literal-pathspecs", "mergetool", "--tool=fixture", "--no-prompt", "--", "a.txt"] };
    expect(frame(run(registered, { ...tool, limits: { ceilingMs: limits.SUBMODULE_UPDATE_CEILING_MS } }))).toBe(true);
    expect(frame(run(registered, { ...tool, limits: { ceilingMs: limits.SUBMODULE_UPDATE_CEILING_MS + 1 } }))).toBe(false);
    expect(frame(run(registered, { ...tool, limits: { ceilingMs: limits.SUBMODULE_UPDATE_CEILING_MS, inactivityMs: limits.SUBMODULE_UPDATE_INACTIVITY_MS } }))).toBe(false);
  });

  test("the globalConfig context names only the Git", () => {
    const list = ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs", "config", "list", "--show-scope", "--show-origin", "-z"];
    expect(frame(run(globalConfig, { arguments: list, environmentPolicy: "read", limits: { deadlineMs: limits.READ_DEADLINE_MS } }))).toBe(true);
    expect(ok(channel.ProcessContext, globalConfig)).toBe(true);
    expect(frame(run({ ...globalConfig, repositoryId: id() }))).toBe(false);
    expect(frame(run({ contextKind: "globalConfig" }))).toBe(false);
  });

  test("the worktreeAdd context names the Git, the repository, and the bound path", () => {
    expect(frame(run(worktreeAdd, { arguments: ["--no-lazy-fetch", "worktree", "add", "--", WORKTREE, OID] }))).toBe(true);
    expect(ok(channel.ProcessContext, worktreeAdd)).toBe(true);
    const { bootstrapId: _b, ...withoutBinding } = worktreeAdd;
    const { repositoryId: _r, ...withoutRepository } = worktreeAdd;
    expect(frame(run(withoutBinding))).toBe(false);
    expect(frame(run(withoutRepository))).toBe(false);
    expect(frame(run({ ...worktreeAdd, cloneId: id() }))).toBe(false);
  });

  test("destinationFacts names a clone or a worktreeAdd binding", () => {
    expect(frame({ type: "destinationFacts", ...call, bootstrapId: id() })).toBe(true);
    expect(frame({ type: "destinationFacts", ...call, cloneId: id() })).toBe(true);
    expect(frame({ type: "destinationFacts", ...call, cloneId: id(), bootstrapId: id() })).toBe(false);
    expect(frame({ type: "destinationFacts", ...call, bootstrapId: id(), path: WORKTREE })).toBe(false);
  });

  const append = { type: "fileAppend", ...call, repositoryId: id(), target: "gitignore", path: `${REPO}${SEP}.gitignore`, expected: "absent", bytes: b64("/build/\n") };

  test("fileAppend names the target, the path, the expected state, and the bytes", () => {
    expect(frame(append)).toBe(true);
    expect(frame({ ...append, target: "exclude", path: `${GIT_DIR}${SEP}info${SEP}exclude`, expected: { size: 12, sha256: DIGEST }, bytes: b64("\n/build/\n") })).toBe(true);
    const bad = [
      { ...append, target: "global" },
      { ...append, path: ".gitignore" },
      { ...append, expected: { size: 12 } },
      { ...append, expected: { size: -1, sha256: DIGEST } },
      { ...append, expected: "present" },
      { ...append, bytes: "" },
      { ...append, bytes: Buffer.alloc(limits.INLINE_PROCESS_INPUT_BYTES + 1).toString("base64") },
      { ...append, line: "/build/" },
    ];
    for (const value of bad) expect(frame(value)).toBe(false);
    const { repositoryId: _r, ...withoutRepository } = append;
    expect(frame(withoutRepository)).toBe(false);
  });

  test("fileAppend replies appended, stale, stopped, interrupted, refused not-regular, or error with a file fact code", () => {
    const callId = call.callId;
    for (const result of ["appended", "stale", "stopped", "interrupted"]) expect(reply({ type: "fileAppend", callId, result })).toBe(true);
    expect(reply({ type: "fileAppend", callId, result: "refused", reason: "not-regular" })).toBe(true);
    for (const code of channel.FILE_FACT_ERRORS) expect(reply({ type: "fileAppend", callId, result: "error", code })).toBe(true);
    expect(reply({ type: "fileAppend", callId, result: "refused" })).toBe(false);
    expect(reply({ type: "fileAppend", callId, result: "refused", reason: "link" })).toBe(false);
    expect(reply({ type: "fileAppend", callId, result: "error" })).toBe(false);
    expect(reply({ type: "fileAppend", callId, result: "appended", code: "io-error" })).toBe(false);
  });

  test("reveal names the repository and the path, and its reply carries only the call", () => {
    const reveal = { type: "reveal", ...call, repositoryId: id(), path: `${REPO}${SEP}src${SEP}a.ts` };
    expect(frame(reveal)).toBe(true);
    expect(frame({ ...reveal, path: "src/a.ts" })).toBe(false);
    const { repositoryId: _r, ...withoutRepository } = reveal;
    expect(frame(withoutRepository)).toBe(false);
    expect(reply({ type: "reveal", callId: call.callId })).toBe(true);
    expect(reply({ type: "reveal", callId: call.callId, result: "shown" })).toBe(false);
  });

  describe("trust frame confirm version 2", () => {
    const names = (item: Record<string, string>, n: number, more = 0) => ({ names: Array.from({ length: n }, () => item), more });
    const details = {
      hooks: names({ event: "pre-commit", folder: `${GIT_DIR}${SEP}hooks` }, 1),
      filters: names({ driver: "lfs", scope: "local" }, 1),
      monitors: names({ scope: "local" }, 0),
      mergeDrivers: names({ driver: "union", scope: "local" }, 1),
      mergeTools: names({ tool: "fixture", scope: "global" }, 0),
      signing: names({ key: "gpg.program", scope: "local" }, 0),
      other: names({ key: "core.sshcommand", scope: "local" }, 1),
    };
    const v2 = { type: "confirm", callId: id(), worktreeRoot: REPO, adminDirectory: GIT_DIR, commonDirectory: GIT_DIR, gitSelectedPath: GIT_PATH, policyVersion: 2, action: "commit", details };
    // T057 puts the version 2 frame in `TrustRequest` (contract Δ6).
    const confirm = (value: unknown) => ok(channel.TrustRequest, value);

    test("the frame names the folders, the Git, the action, and the details", () => {
      expect(confirm(v2)).toBe(true);
      const actions = ["commit", "read", "fetch", "pull", "push", "switch", "branch", "merge", "rebase", "resolve", "mergetool", "worktree", "submodules"];
      expect<string[]>([...(P.TRUST_ACTIONS ?? [])]).toEqual(actions);
      for (const action of actions) expect(confirm({ ...v2, action })).toBe(true);
      expect(confirm({ ...v2, action: "clone" })).toBe(false);
    });

    test("the frame carries no fingerprint, persist, or bound", () => {
      expect(confirm({ ...v2, fingerprint: DIGEST })).toBe(false);
      expect(confirm({ ...v2, persist: true })).toBe(false);
      expect(confirm({ ...v2, bound: "file-bytes" })).toBe(false);
      expect(confirm({ ...v2, policyVersion: 1 })).toBe(false);
      const { adminDirectory: _a, ...withoutAdmin } = v2;
      expect(confirm({ ...withoutAdmin, gitDirectory: GIT_DIR })).toBe(false);
    });

    test("each kind lists at most 20 names with a more count (contract Δ5)", () => {
      expect(confirm({ ...v2, details: { ...details, hooks: names({ event: "pre-commit", folder: GIT_DIR }, 20, 3) } })).toBe(true);
      expect(confirm({ ...v2, details: { ...details, hooks: names({ event: "pre-commit", folder: GIT_DIR }, 21) } })).toBe(false);
      expect(confirm({ ...v2, details: { ...details, filters: { names: [], more: -1 } } })).toBe(false);
      const { signing: _s, ...withoutSigning } = details;
      expect(confirm({ ...v2, details: withoutSigning })).toBe(false);
      // Plan D14: the shell shows an empty value or a value with a control character as a fixed text, so the frame carries it.
      expect(confirm({ ...v2, details: { ...details, hooks: names({ event: "pre\u0001commit", folder: GIT_DIR }, 1) } })).toBe(true);
      expect(confirm({ ...v2, details: { ...details, filters: names({ driver: "", scope: "local" }, 1) } })).toBe(true);
      // A `hook.<name>.event` hook names the scope of its command in place of a folder.
      expect(confirm({ ...v2, details: { ...details, hooks: names({ event: "pre-push", scope: "global" }, 1) } })).toBe(true);
      expect(confirm({ ...v2, details: { ...details, hooks: names({ event: "pre-push", scope: "global", folder: GIT_DIR }, 1) } })).toBe(false);
    });
  });

  describe("mutation frames", () => {
    const started = { type: "started", callId: id(), operationId: id(), repositoryId: id(), worktreeRoot: REPO, commonDirectory: GIT_DIR };
    const mutation = (value: unknown) => ok(channel.MutationRequest, value);

    test("a started frame of kind workbench carries the action that the close prompt names", () => {
      expect<string[]>([...(P.WORKBENCH_STARTED_ACTIONS ?? [])]).toEqual(STARTED_ACTIONS);
      for (const action of STARTED_ACTIONS) expect(mutation({ ...started, kind: "workbench", action })).toBe(true);
      expect(mutation({ ...started, kind: "workbench" })).toBe(false);
      expect(mutation({ ...started, kind: "workbench", action: "choose-side" })).toBe(false);
      expect(mutation({ ...started, kind: "workbench", action: "fetch" })).toBe(false);
      expect(mutation({ ...started, kind: "sync", action: "switch" })).toBe(false);
      expect(mutation({ ...started, kind: "workbench", action: "switch", direction: "stage" })).toBe(false);
    });

    test("a started frame of kind applyFiles carries stage or unstage", () => {
      for (const direction of ["stage", "unstage"]) expect(mutation({ ...started, kind: "applyFiles", direction })).toBe(true);
      expect(mutation({ ...started, kind: "applyFiles" })).toBe(false);
      expect(mutation({ ...started, kind: "applyFiles", direction: "resolve" })).toBe(false);
      expect(mutation({ ...started, kind: "applyFiles", direction: "stage", action: "switch" })).toBe(false);
      expect(mutation({ ...started, kind: "runWorkbench" })).toBe(false);
    });

    test("a recovery marker takes the kinds workbench and applyFiles", () => {
      const marker = { markerId: id(), kind: "workbench", startedAt: "2026-10-17T08:00:00Z", worktreeRoot: REPO, commonDirectory: GIT_DIR, commonIdentity: IDENTITY };
      expect(ok(channel.Marker, marker)).toBe(true);
      expect(ok(channel.Marker, { ...marker, kind: "applyFiles" })).toBe(true);
      expect(ok(channel.Marker, { ...marker, kind: "runWorkbench" })).toBe(false);
    });
  });
});
