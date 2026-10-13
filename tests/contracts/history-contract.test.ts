// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T015: the feature 002 contract changes (contract Δ1 to Δ3, Δ5, Δ7, Δ9 to Δ11; spec FR-003, FR-026, FR-045, FR-047).

import { describe, expect, test } from "bun:test";
import policyFile from "../../src/contracts/git-environment.json";
import wslProcess from "../../src/contracts/wsl-process.json";
import { printOrigin } from "../origin";
import {
  Completeness,
  LoadHistoryResult,
  OpenHistoryResult,
  ProgressEvent,
  ReadHistoryRowsResult,
  ReadRefsResult,
  SearchHistoryResult,
} from "../../src/contracts/envelope";
import { EnvironmentPolicy, ProcessRequest } from "../../src/contracts/channel";
import * as errors from "../../src/contracts/errors";
import * as limits from "../../src/contracts/limits";
import { OPERATIONS, PHASES, SHELL_ONLY } from "../../src/contracts/operations";

printOrigin("../../src/contracts/channel.ts", import.meta.dir);
printOrigin("../../src/contracts/envelope.ts", import.meta.dir);
printOrigin("../../src/contracts/errors.ts", import.meta.dir);
printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/contracts/operations.ts", import.meta.dir);
printOrigin("../../src/contracts/git-environment.json", import.meta.dir);
printOrigin("../../src/contracts/wsl-process.json", import.meta.dir);

const KIB = 1024;
const MIB = 1024 * KIB;
const OID = "0123456789abcdef0123456789abcdef01234567";
const PARENT = "89abcdef0123456789abcdef0123456789abcdef";
const DIGEST = "a".repeat(64);
const id = () => crypto.randomUUID();

describe("contract Δ5 bounds", () => {
  test("each new bound has its contract value", () => {
    expect(limits.HISTORY_VIEWS_PER_SESSION).toBe(1);
    expect(limits.HISTORY_PROCESS_DEADLINE_MS).toBe(120_000);
    expect(limits.HISTORY_TEXT_DEADLINE_MS).toBe(30_000);
    expect(limits.HISTORY_ROWS_PER_REQUEST).toBe(512);
    expect(limits.HISTORY_PARENTS_PER_COMMIT).toBe(64);
    expect(limits.HISTORY_VIEW_COMMITS).toBe(4_000_000);
    expect(limits.HISTORY_LOAD_MARGIN).toBe(1024);
    expect(limits.FILTER_TEXT_BYTES).toBe(1024);
    expect(limits.HISTORY_COMMIT_OBJECT_BYTES).toBe(256 * KIB);
    expect(limits.HISTORY_PROGRESS_EVENTS_PER_SECOND).toBe(4);
    expect(limits.HISTORY_CHECKPOINT_ROWS).toBe(256);
    expect(limits.HISTORY_RENDERER_CACHE_BYTES).toBe(8 * MIB);
    expect(limits.HISTORY_PROCESSES_PER_VIEW).toBe(3);
  });

  test("the reused bounds keep their 001 values", () => {
    expect(limits.GRAPH_LANES).toBe(24);
    expect(limits.REF_LISTING_RECORDS).toBe(10_000);
    expect(limits.REF_LISTING_BYTES).toBe(4 * MIB);
    expect(limits.HISTORY_PAGE_BYTES).toBe(8 * MIB);
  });

  test("T049 retires GRAPH_PATH_SEGMENTS", () => {
    expect("GRAPH_PATH_SEGMENTS" in limits).toBe(false);
  });
});

describe("contract Δ9 codes", () => {
  test("errors.ts holds the three new codes", () => {
    for (const code of ["HISTORY_CHANGED", "UNSUPPORTED_FILTER_TEXT", "SEARCH_UNSUPPORTED"]) expect(errors.isErrorCode(code)).toBe(true);
  });

  test("each new code has exactly its contract reasons", () => {
    expect([...errors.HISTORY_CHANGED_REASONS]).toEqual(["order", "topology"]);
    expect([...errors.UNSUPPORTED_FILTER_TEXT_REASONS]).toEqual(["line-break", "nul", "quote-end", "length"]);
    expect([...errors.SEARCH_UNSUPPORTED_REASONS]).toEqual(["matching"]);
  });

  test("the new OUTPUT_LIMIT reasons are the export names of their bounds", () => {
    expect([...errors.HISTORY_OUTPUT_LIMIT_REASONS]).toEqual(["HISTORY_PARENTS_PER_COMMIT", "HISTORY_VIEW_COMMITS"]);
    for (const reason of errors.HISTORY_OUTPUT_LIMIT_REASONS) {
      expect(Object.keys(limits)).toContain(reason);
      expect(Completeness.safeParse({ state: "limited", code: "OUTPUT_LIMIT", reason }).success).toBe(true);
    }
  });

  test("a response code of each new code fits the failed state", () => {
    for (const code of ["HISTORY_CHANGED", "UNSUPPORTED_FILTER_TEXT", "SEARCH_UNSUPPORTED"]) expect(errors.codeFitsState("failed", code)).toBe(true);
  });
});

describe("contract Δ1 and Δ3 operations", () => {
  const FIVE = ["openHistory", "loadHistory", "readHistoryRows", "searchHistory", "closeHistory"];

  test("the operation list holds the five operations, and the service gets each one", () => {
    expect(OPERATIONS).toEqual(expect.arrayContaining(FIVE));
    for (const name of FIVE) expect(SHELL_ONLY).not.toContain(name);
  });

  test("the progress phases history-load and history-search exist", () => {
    expect(PHASES).toEqual(expect.arrayContaining(["history-load", "history-search"]));
    const event = { requestId: id(), operationId: id(), state: "running", phase: "history-load", counters: { rows: 2089 } };
    expect(ProgressEvent.safeParse(event).success).toBe(true);
    expect(ProgressEvent.safeParse({ ...event, phase: "history-search", counters: { matches: 3, settled: 2 } }).success).toBe(true);
  });
});

describe("contract Δ3 results", () => {
  const opened = { viewId: id(), scope: "all", generation: 3, head: { state: "branch", target: "refs/heads/main", oid: OID }, startCount: 2, refsDigest: DIGEST, shallow: false };

  test("openHistory gives viewId, scope, generation, head, startCount, refsDigest, and shallow", () => {
    expect(OpenHistoryResult.safeParse(opened).success).toBe(true);
    expect(OpenHistoryResult.safeParse({ ...opened, scope: "current", head: { state: "unborn", target: "refs/heads/main" }, startCount: 0 }).success).toBe(true);
    const { refsDigest: _omit, ...withoutDigest } = opened;
    expect(OpenHistoryResult.safeParse(withoutDigest).success).toBe(false);
    expect(OpenHistoryResult.safeParse({ ...opened, scope: "branch" }).success).toBe(false);
    expect(OpenHistoryResult.safeParse({ ...opened, startCount: limits.REF_LISTING_RECORDS + 2 }).success).toBe(false);
    expect(OpenHistoryResult.safeParse({ reason: "REF_LISTING_RECORDS" }).success).toBe(true);
  });

  test("loadHistory gives rows and complete, and a limited or failed load names its reason", () => {
    expect(LoadHistoryResult.safeParse({ rows: 2089, complete: false }).success).toBe(true);
    expect(LoadHistoryResult.safeParse({ rows: 0, complete: true }).success).toBe(true);
    expect(LoadHistoryResult.safeParse({ rows: limits.HISTORY_VIEW_COMMITS, complete: false, reason: "HISTORY_VIEW_COMMITS" }).success).toBe(true);
    expect(LoadHistoryResult.safeParse({ rows: 10, complete: false, reason: "HISTORY_PARENTS_PER_COMMIT" }).success).toBe(true);
    expect(LoadHistoryResult.safeParse({ rows: 10, complete: false, reason: "order" }).success).toBe(true);
    expect(LoadHistoryResult.safeParse({ rows: 10, complete: false, reason: "topology" }).success).toBe(true);
    const command = "& 'C:\\Git\\cmd\\git.exe' --no-lazy-fetch -C 'C:\\repo' commit-graph write --reachable";
    expect(LoadHistoryResult.safeParse({ rows: 10, complete: false, remedy: { text: "Write a commit-graph.", command } }).success).toBe(true);
    expect(LoadHistoryResult.safeParse({ rows: limits.HISTORY_VIEW_COMMITS + 1, complete: false }).success).toBe(false);
    expect(LoadHistoryResult.safeParse({ rows: 10, complete: true, reason: "order" }).success).toBe(false);
    expect(LoadHistoryResult.safeParse({ rows: 10 }).success).toBe(false);
    expect(LoadHistoryResult.safeParse({ rows: 10, complete: false, reason: "HISTORY_STREAM_ROWS" }).success).toBe(false);
  });

  const cell = { node: 0, color: 1, merge: false, limited: false, segments: [{ shape: "line", from: { lane: 0, at: "node" }, to: { lane: 0, at: "bottom" }, color: 1 }], marks: [] };
  const row = { index: 0, oid: OID, parents: [PARENT], cell, labels: [{ kind: "stash", name: "stash", invalidUtf8: false }], checkout: true };
  const text = { subject: "Fix", author: { name: "A", email: "a@example.invalid" }, date: 1, encoding: null, invalidUtf8: false };
  const details = { body: "", bodyCut: false, committer: { name: "C", email: "c@example.invalid" }, committerDate: 2, children: [] };
  const page = (rows: unknown[], extra: Record<string, unknown> = {}) => ({ target: "found", rows, rowCount: 9, lanes: 1, complete: false, cut: false, bytes: 512, ...extra });
  const noTarget = (target: string, extra: Record<string, unknown> = {}) => ({ target, rowCount: 9, lanes: 1, complete: false, bytes: 64, ...extra });

  test("readHistoryRows rows carry the contract fields for each text value", () => {
    expect(ReadHistoryRowsResult.safeParse(page([row])).success).toBe(true);
    expect(ReadHistoryRowsResult.safeParse(page([{ ...row, ...text }])).success).toBe(true);
    expect(ReadHistoryRowsResult.safeParse(page([{ ...row, ...text, ...details }])).success).toBe(true);
    expect(ReadHistoryRowsResult.safeParse(page([{ ...row, textLimit: true }])).success).toBe(true);
    expect(ReadHistoryRowsResult.safeParse(page([{ ...row, match: null, cell: null }])).success).toBe(true);
    expect(ReadHistoryRowsResult.safeParse(page([{ ...row, cell: { ...cell, segments: [{ ...cell.segments[0], skip: true }] } }])).success).toBe(true);
    expect(ReadHistoryRowsResult.safeParse(page([row, { ...row, index: 1, oid: PARENT, parents: [] }], { cut: true, complete: true })).success).toBe(true);
  });

  test("readHistoryRows refuses a partial text group, a body above 16 KiB, and rows out of order", () => {
    const { date: _omit, ...partial } = text;
    expect(ReadHistoryRowsResult.safeParse(page([{ ...row, ...partial }])).success).toBe(false);
    expect(ReadHistoryRowsResult.safeParse(page([{ ...row, ...details }])).success).toBe(false);
    expect(ReadHistoryRowsResult.safeParse(page([{ ...row, ...text, textLimit: true }])).success).toBe(false);
    expect(ReadHistoryRowsResult.safeParse(page([{ ...row, ...text, ...details, body: "x".repeat(16 * KIB + 1) }])).success).toBe(false);
    expect(ReadHistoryRowsResult.safeParse(page([{ ...row, index: 1 }, row])).success).toBe(false);
    expect(ReadHistoryRowsResult.safeParse(page([{ ...row, parents: Array(65).fill(PARENT) }])).success).toBe(false);
    expect(ReadHistoryRowsResult.safeParse(page([{ ...row, cell: { ...cell, node: 24 } }])).success).toBe(false);
    expect(ReadHistoryRowsResult.safeParse(page([row], { lanes: 25 })).success).toBe(false);
    expect(ReadHistoryRowsResult.safeParse(page([row], { bytes: limits.HISTORY_PAGE_BYTES + 1 })).success).toBe(false);
    expect(ReadHistoryRowsResult.safeParse(page(Array.from({ length: 513 }, (_, i) => ({ ...row, index: i })))).success).toBe(false);
  });

  test("a row holds at most REF_LISTING_RECORDS labels and 2 × GRAPH_LANES segments", () => {
    const labels = (n: number) => page([{ ...row, labels: Array(n).fill(row.labels[0]) }]);
    expect(ReadHistoryRowsResult.safeParse(labels(limits.REF_LISTING_RECORDS)).success).toBe(true);
    expect(ReadHistoryRowsResult.safeParse(labels(limits.REF_LISTING_RECORDS + 1)).success).toBe(false);
    const segments = (n: number) => page([{ ...row, cell: { ...cell, segments: Array(n).fill(cell.segments[0]) } }]);
    expect(ReadHistoryRowsResult.safeParse(segments(2 * limits.GRAPH_LANES)).success).toBe(true);
    expect(ReadHistoryRowsResult.safeParse(segments(2 * limits.GRAPH_LANES + 1)).success).toBe(false);
  });

  test("readHistoryRows carries rowCount, and each row lies below it", () => {
    const { rowCount: _omit, ...withoutCount } = page([row]);
    expect(ReadHistoryRowsResult.safeParse(withoutCount).success).toBe(false);
    expect(ReadHistoryRowsResult.safeParse(page([{ ...row, index: 8 }])).success).toBe(true);
    expect(ReadHistoryRowsResult.safeParse(page([{ ...row, index: 9 }])).success).toBe(false);
    expect(ReadHistoryRowsResult.safeParse(page([], { rowCount: limits.HISTORY_VIEW_COMMITS })).success).toBe(true);
    expect(ReadHistoryRowsResult.safeParse(page([], { rowCount: limits.HISTORY_VIEW_COMMITS + 1 })).success).toBe(false);
  });

  test("readHistoryRows gives target unknown or none without rows, and only found carries rows", () => {
    for (const target of ["unknown", "none"]) {
      expect(ReadHistoryRowsResult.safeParse(noTarget(target)).success).toBe(true);
      expect(ReadHistoryRowsResult.safeParse(noTarget(target, { rows: [] })).success).toBe(false);
      expect(ReadHistoryRowsResult.safeParse(noTarget(target, { rows: [row] })).success).toBe(false);
      const { rowCount: _omit, ...withoutCount } = noTarget(target);
      expect(ReadHistoryRowsResult.safeParse(withoutCount).success).toBe(false);
    }
    const { rows: _omit, ...withoutRows } = page([row]);
    expect(ReadHistoryRowsResult.safeParse(withoutRows).success).toBe(false);
    expect(ReadHistoryRowsResult.safeParse(noTarget("other")).success).toBe(false);
  });

  test("only a line segment may carry skip, and only as true", () => {
    const line = cell.segments[0]!;
    const withSegment = (segment: unknown) => page([{ ...row, cell: { ...cell, segments: [segment] } }]);
    expect(ReadHistoryRowsResult.safeParse(withSegment({ ...line, skip: true })).success).toBe(true);
    expect(ReadHistoryRowsResult.safeParse(withSegment({ ...line, skip: false })).success).toBe(false);
    expect(ReadHistoryRowsResult.safeParse(withSegment({ shape: "stub", lane: 0, color: 1 })).success).toBe(true);
    expect(ReadHistoryRowsResult.safeParse(withSegment({ shape: "stub", lane: 0, color: 1, skip: true })).success).toBe(false);
  });

  test("a view operation without its result value carries reason and a remedy of text and command", () => {
    const command = "& 'C:\\Git\\cmd\\git.exe' --no-lazy-fetch -C 'C:\\repo' commit-graph write --reachable";
    for (const result of [OpenHistoryResult, ReadHistoryRowsResult, SearchHistoryResult]) {
      expect(result.safeParse({}).success).toBe(true);
      expect(result.safeParse({ reason: "topology" }).success).toBe(true);
      expect(result.safeParse({ reason: "object-missing", remedy: { text: "Fetch the missing objects.", command: null } }).success).toBe(true);
      expect(result.safeParse({ remedy: { text: "Write a commit-graph.", command } }).success).toBe(true);
      expect(result.safeParse({ remedy: { text: "Write a commit-graph." } }).success).toBe(false);
      expect(result.safeParse({ remedy: { command: null } }).success).toBe(false);
      expect(result.safeParse({ remedy: { text: "", command: null } }).success).toBe(false);
      expect(result.safeParse({ reason: "order", code: "HISTORY_CHANGED" }).success).toBe(false);
    }
    expect(LoadHistoryResult.safeParse({ rows: 10, complete: false, remedy: { text: "Write a commit-graph." } }).success).toBe(false);
  });

  test("searchHistory gives the final match count, the shallow statement, or a refusal reason", () => {
    expect(SearchHistoryResult.safeParse({ matches: 3, shallow: true }).success).toBe(true);
    for (const reason of [...errors.UNSUPPORTED_FILTER_TEXT_REASONS, "order", "HISTORY_VIEW_COMMITS"]) expect(SearchHistoryResult.safeParse({ reason }).success).toBe(true);
    expect(SearchHistoryResult.safeParse({ reason: "matching", remedy: { text: "Install a Git build with PCRE2.", command: null } }).success).toBe(true);
    expect(SearchHistoryResult.safeParse({ matches: 3 }).success).toBe(false);
    expect(SearchHistoryResult.safeParse({ reason: "pattern" }).success).toBe(false);
  });

  test("readRefs adds refsDigest and the kind stash", () => {
    const stash = {
      kind: "stash",
      name: "stash",
      invalidUtf8: false,
      objectId: OID,
      objectType: "commit",
      peeledId: null,
      peeledType: null,
      symref: null,
      upstream: null,
      upstreamPresent: false,
      commitId: OID,
    };
    const list = { generation: 3, refs: [stash], refsDigest: DIGEST, current: null, completeness: { state: "complete" } };
    expect(ReadRefsResult.safeParse(list).success).toBe(true);
    const { refsDigest: _omit, ...withoutDigest } = list;
    expect(ReadRefsResult.safeParse(withoutDigest).success).toBe(false);
    expect(ReadRefsResult.safeParse({ ...list, refsDigest: "A".repeat(64) }).success).toBe(false);
  });
});

describe("contract Δ7 and Δ11 process texts", () => {
  test("the search policy is the read policy plus LC_ALL=C.UTF-8", () => {
    const { read, search } = policyFile.policies as Record<string, { set: Record<string, string> }>;
    expect(search).toEqual({ ...read, set: { ...read.set, LC_ALL: "C.UTF-8" } });
  });

  test("a run frame takes the environment policy search", () => {
    expect(EnvironmentPolicy.options).toEqual(["probe", "read", "mutation", "network", "search"]);
  });

  test("the WSL wrapper mode search exports LC_ALL=C.UTF-8 and ends its scope like read", () => {
    expect(wslProcess.wrapper).toContain("search) export LC_ALL=C.UTF-8 ;;");
    expect(wslProcess.wrapper).toContain("case $mode in probe | read | search) end ;; esac");
  });

  test("the fixed matchingProbe script imports into an own bare repository and removes it", () => {
    const probe = (wslProcess as Record<string, string[]>).matchingProbe;
    expect(Array.isArray(probe)).toBe(true);
    expect(probe).toContain('mkdir -- "$dir" || exit 1');
    expect(probe).toContain(`trap 'rm -rf -- "$dir"' EXIT`);
  });

  test("the matchingProbe init and fast-import lines pass --no-lazy-fetch first", () => {
    const probe = (wslProcess as Record<string, string[]>).matchingProbe;
    expect(probe).toContain('"$git" --no-lazy-fetch init --bare -q --template= --object-format=sha1 "$dir" || exit 1');
    expect(probe).toContain('"$git" --no-lazy-fetch --git-dir="$dir" fast-import --quiet || exit 1');
    expect(probe.filter((line) => line.startsWith('"$git" ') && !line.startsWith('"$git" --no-lazy-fetch '))).toEqual([]);
  });
});

describe("contract Δ6 run field script", () => {
  const registered = { contextKind: "registeredOperation", gitInstallationId: id(), repositoryId: id() };
  const frame = (context: Record<string, unknown>, extra: Record<string, unknown>) => ({
    type: "run",
    callId: id(),
    operationId: id(),
    arguments: ["/tmp/arbareto-probe-0f0f0f0f-0000-4000-8000-0000000000aa", OID, "1", "--no-lazy-fetch", "--no-lazy-fetch"],
    input: "AA==",
    environmentPolicy: "search",
    limits: { deadlineMs: limits.REGISTERED_DEADLINE_CAP_MS },
    ...context,
    ...extra,
  });

  test("a registeredOperation run takes script matchingProbe", () => {
    expect(ProcessRequest.safeParse(frame(registered, {})).success).toBe(true);
    expect(ProcessRequest.safeParse(frame(registered, { script: "matchingProbe" })).success).toBe(true);
  });

  test("the schema refuses another script value and the field in the other two context kinds", () => {
    for (const script of ["identity", "matchingprobe", "", null, 1]) expect(ProcessRequest.safeParse(frame(registered, { script })).success).toBe(false);
    const probe = { contextKind: "gitProbe", bootstrapId: id() };
    const discovery = { contextKind: "repositoryDiscovery", bootstrapId: id(), gitInstallationId: id() };
    for (const context of [probe, discovery]) {
      expect(ProcessRequest.safeParse(frame(context, { environmentPolicy: "probe" })).success).toBe(true);
      expect(ProcessRequest.safeParse(frame(context, { environmentPolicy: "probe", script: "matchingProbe" })).success).toBe(false);
    }
  });
});
