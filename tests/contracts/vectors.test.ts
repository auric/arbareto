// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { NativeFirstEnvelope, validateRequest } from "../../src/contracts/envelope";
import { DICTIONARY_UNAVAILABLE_REASONS } from "../../src/contracts/errors";
import { EXPORTED } from "../../src/contracts/export-schemas";
import { decodeStrictJson } from "../../src/contracts/strict-json";

printOrigin("../../src/contracts/envelope.ts", import.meta.dir);
printOrigin("../../src/contracts/export-schemas.ts", import.meta.dir);
printOrigin("../../src/contracts/strict-json.ts", import.meta.dir);

// The same files run in `src-tauri/src/schema.rs`. Each holds `schema` (a file stem of `src/contracts/schemas/`), `text`, and `expected`.
// An optional `platform` (`windows` or `posix`) limits a vector to the hosts of that platform.
interface Vector {
  schema: string;
  text: string;
  expected: string;
  platform?: string;
  // Dot paths to values that fix only the named fault. `null` deletes the key or the array item.
  repair?: Record<string, unknown>;
}

const PLATFORMS = ["windows", "posix"];
const HOST_PLATFORM = process.platform === "win32" ? "windows" : "posix";

// Every invalid vector of these schemas carries `repair`. The repaired text must pass, so a second fault cannot mask the named one.
// Feature 004 T034 adds the workbench result schemas, and T060 the worktree and Git settings result schemas. Contract Δ3 adds the `reviewCommit` result schema.
const FAULT_SCHEMAS = ["registration-result", "open-recent-repository-result", "recent-repositories-result", "review-workbench-result", "run-workbench-result", "read-branches-result", "read-worktrees-result", "read-git-settings-result", "review-commit-result"];

function repaired(value: unknown, repair: Record<string, unknown>): unknown {
  const copy = structuredClone(value) as Record<string, unknown>;
  for (const [path, replacement] of Object.entries(repair)) {
    const keys = path.split(".");
    const last = keys.pop()!;
    const parent = keys.reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, copy);
    if (replacement !== null) parent[last] = replacement;
    else if (Array.isArray(parent)) parent.splice(Number(last), 1);
    else delete parent[last];
  }
  return copy;
}

const ROOT = join(import.meta.dir, "..", "vectors");
const vectors = (["valid", "invalid"] as const).flatMap((kind) =>
  readdirSync(join(ROOT, kind))
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ kind, name, vector: JSON.parse(readFileSync(join(ROOT, kind, name), "utf8")) as Vector })),
);

// The strict decoder runs first, as in the service. Envelopes then take the contract §1 code order.
function check({ schema, text }: Vector): string {
  const decoded = decodeStrictJson(new TextEncoder().encode(text));
  if (!decoded.ok) return decoded.code;
  if (schema === "renderer-envelope" || schema === "service-envelope") {
    const result = validateRequest(decoded.value, schema === "renderer-envelope" ? "renderer" : "service");
    return result.ok ? "valid" : result.code;
  }
  if (schema === "native-first-envelope") {
    const result = validateRequest(decoded.value, "renderer");
    if (!result.ok) return result.code;
    return NativeFirstEnvelope.safeParse(decoded.value).success ? "valid" : "INVALID_REQUEST";
  }
  const exported = EXPORTED[schema as keyof typeof EXPORTED];
  if (!exported) throw new Error(`no exported schema ${schema}`);
  return exported.safeParse(decoded.value).success ? "valid" : "INVALID_REQUEST";
}

describe("golden vectors", () => {
  test("both folders hold vectors, and each file states a valid expectation", () => {
    expect(vectors.filter((v) => v.kind === "valid").length).toBeGreaterThan(0);
    expect(vectors.filter((v) => v.kind === "invalid").length).toBeGreaterThan(0);
    for (const { kind, vector } of vectors) expect(vector.expected === "valid").toBe(kind === "valid");
  });

  test("each platform field names windows or posix", () => {
    const wrong = vectors.filter(({ vector }) => vector.platform !== undefined && !PLATFORMS.includes(vector.platform));
    expect(wrong.map(({ kind, name }) => `${kind}/${name}`)).toEqual([]);
  });

  const runs = (vector: Vector) => vector.platform === undefined || vector.platform === HOST_PLATFORM;
  const rows = (on: boolean) => vectors.filter((v) => runs(v.vector) === on).map((v) => [`${v.kind}/${v.name}`, v.vector] as const);
  test.each(rows(true))("%s", (_name, vector) => {
    expect(check(vector)).toBe(vector.expected);
  });
  test.skip.each(rows(false))("%s (other platform)", () => {});

  // Feature 002 contract Δ10: vectors for the five operations and their results.
  test("each feature 002 operation has a valid request vector, and each of its result schemas has valid and invalid vectors", () => {
    const operations = vectors.filter(({ kind, vector }) => kind === "valid" && vector.schema === "renderer-envelope").map(({ vector }) => JSON.parse(vector.text).operation);
    expect(operations).toEqual(expect.arrayContaining(["openHistory", "loadHistory", "readHistoryRows", "searchHistory", "closeHistory"]));
    for (const schema of ["open-history-result", "load-history-result", "read-history-rows-result", "search-history-result"]) {
      for (const kind of ["valid", "invalid"]) expect(vectors.some((v) => v.kind === kind && v.vector.schema === schema)).toBe(true);
    }
  });

  // Feature 003 contract Δ10: vectors for the new operations, codes, policies, and private requests.
  test("each feature 003 operation, code, policy, and private request has a valid vector", () => {
    const texts = (schema: string) => vectors.filter(({ kind, vector }) => kind === "valid" && vector.schema === schema).map(({ vector }) => JSON.parse(vector.text) as Record<string, unknown>);
    const operations = [...texts("renderer-envelope"), ...texts("service-envelope")].map((t) => t.operation);
    const added = ["readTracking", "reviewSync", "sync", "clone", "connectInTerminal", "readSyncSettings", "setSshClient", "setDefaultPullAction", "chooseSyncPath", "clearSyncPath", "launchPuttygen"];
    expect(operations).toEqual(expect.arrayContaining(added));
    expect(texts("response").map((t) => t.code)).toEqual(expect.arrayContaining(["SYNC_UNAVAILABLE", "PUSH_REJECTED", "PUTTY_UNAVAILABLE", "DESTINATION_NOT_EMPTY"]));
    expect(texts("process-request").map((t) => t.environmentPolicy)).toEqual(expect.arrayContaining(["remote", "integrate"]));
    expect(texts("process-request").map((t) => t.contextKind)).toContain("clone");
    for (const schema of ["process-request", "process-reply"]) expect(texts(schema).map((t) => t.type)).toEqual(expect.arrayContaining(["destinationFacts", "pageant", "terminal"]));
  });

  // Feature 003 contract Δ10: the shell reads these vectors in `src-tauri/src/schema.rs`.
  test("each feature 003 shell-read schema has its valid and invalid vectors", () => {
    const texts = (kind: string, schema: string) => vectors.filter((v) => v.kind === kind && v.vector.schema === schema).map(({ vector }) => JSON.parse(vector.text) as Record<string, unknown>);
    const operations = texts("valid", "native-first-envelope").map((t) => t.operation);
    expect(operations).toEqual(expect.arrayContaining(["clone", "readSyncSettings", "setSshClient", "setDefaultPullAction", "chooseSyncPath", "clearSyncPath", "launchPuttygen"]));
    expect(texts("invalid", "native-first-envelope").map((t) => t.operation)).toEqual(expect.arrayContaining(["clone", "chooseSyncPath"]));
    const started = (kind: string) => texts(kind, "mutation-request").map((t) => `${String(t.kind)}:${String(t.action ?? t.direction ?? "")}`);
    expect(started("valid")).toEqual(expect.arrayContaining(["sync:pull", "applyFile:resolve"]));
    expect(started("invalid")).toEqual(expect.arrayContaining(["sync:", "applyHunk:resolve"]));
    for (const kind of ["valid", "invalid"]) expect(texts(kind, "progress").map((t) => t.phase)).toContain("sync-fetch");
    const markers = texts("valid", "handshake").flatMap((t) => t.markers as { kind: string }[]);
    expect(markers.map((m) => m.kind)).toContain("sync");
    expect(texts("valid", "process-reply").filter((t) => t.type === "pageant").map((t) => t.result)).toContain("git");
  });

  // Feature 004 contract Δ10: vectors for the new operations, codes, phases, policy, contexts, private requests, and marker kinds.
  test("each feature 004 operation, code, phase, policy, context, private request, and marker kind has its vectors", () => {
    const texts = (kind: string, schema: string) => vectors.filter((v) => v.kind === kind && v.vector.schema === schema).map(({ vector }) => JSON.parse(vector.text) as Record<string, unknown>);
    const envelopes = ["renderer-envelope", "service-envelope", "native-first-envelope"].flatMap((schema) => texts("valid", schema));
    expect(envelopes.map((t) => t.operation)).toEqual(
      expect.arrayContaining(["readBranches", "readWorktrees", "readGitSettings", "reviewWorkbench", "runWorkbench", "applyFiles", "openWorktree", "revealPath", "setSwitchChoice", "chooseWorktreeFolder"]),
    );
    expect(texts("valid", "native-first-envelope").map((t) => t.operation)).toEqual(expect.arrayContaining(["openWorktree", "reviewWorkbench", "setSwitchChoice", "chooseWorktreeFolder"]));
    expect(texts("invalid", "native-first-envelope").map((t) => t.operation)).toEqual(expect.arrayContaining(["openWorktree", "reviewWorkbench", "setSwitchChoice", "revealPath", "chooseWorktreeFolder"]));
    for (const kind of ["valid", "invalid"]) expect(texts(kind, "choose-worktree-folder-result")).not.toHaveLength(0);
    expect(texts("valid", "service-envelope").map((t) => t.operation)).toContain("revealPath");
    expect(texts("valid", "response").map((t) => t.code)).toEqual(expect.arrayContaining(["WORKBENCH_UNAVAILABLE", "UNTRACKED_IN_WAY", "STASH_KEPT"]));
    expect(texts("valid", "progress").map((t) => t.phase)).toEqual(expect.arrayContaining(["stage-files", "config"]));
    expect(texts("invalid", "progress").map((t) => t.phase)).toEqual(expect.arrayContaining(["stage-files", "merge"]));
    const requests = texts("valid", "process-request");
    expect(requests.map((t) => t.environmentPolicy)).toContain("mergetool");
    expect(requests.map((t) => t.contextKind)).toEqual(expect.arrayContaining(["globalConfig", "worktreeAdd"]));
    expect(requests.some((t) => t.type === "destinationFacts" && "bootstrapId" in t)).toBe(true);
    for (const schema of ["process-request", "process-reply"]) expect(texts("valid", schema).map((t) => t.type)).toEqual(expect.arrayContaining(["fileAppend", "reveal"]));
    const started = (kind: string) => texts(kind, "mutation-request").map((t) => `${String(t.kind)}:${String(t.action ?? t.direction ?? "")}`);
    expect(started("valid")).toEqual(expect.arrayContaining(["workbench:choose-ours", "applyFiles:unstage"]));
    expect(started("invalid")).toEqual(expect.arrayContaining(["workbench:", "applyFiles:resolve"]));
    const markers = texts("valid", "handshake").flatMap((t) => t.markers as { kind: string }[]);
    expect(markers.map((m) => m.kind)).toEqual(expect.arrayContaining(["workbench", "applyFiles"]));
    // T034: the result schemas of the batch 2 actions.
    const actions = (schema: string) => texts("valid", schema).map((t) => t.action ?? t.reason);
    expect(actions("review-workbench-result")).toEqual(expect.arrayContaining(["switch", "delete-branch", "merge", "rebase", "ignore", "config-save", "untracked-in-way"]));
    expect(actions("run-workbench-result")).toEqual(expect.arrayContaining(["switch", "delete-branch", "merge", "ignore", "rebase", "config-save"]));
    for (const schema of ["review-workbench-result", "run-workbench-result", "read-branches-result", "read-worktrees-result", "read-git-settings-result", "review-commit-result"]) for (const kind of ["valid", "invalid"]) expect({ schema, kind, count: texts(kind, schema).length > 0 }).toEqual({ schema, kind, count: true });
  });

  // Feature 006 contract Δ10: vectors for each new operation, the code, every reason, the phase, `spelling` in `readSyncSettings`, and the shell setting.
  test("each feature 006 operation, reason, phase, result, and the spelling setting has its vectors", () => {
    const texts = (kind: string, schema: string) => vectors.filter((v) => v.kind === kind && v.vector.schema === schema).map(({ vector }) => JSON.parse(vector.text) as Record<string, unknown>);
    const operations = (kind: string, schema: string) => texts(kind, schema).map((t) => t.operation);
    const service = ["listDictionaries", "readDictionary", "downloadDictionary", "importDictionary", "removeDictionary"];
    expect(operations("valid", "renderer-envelope")).toEqual(expect.arrayContaining([...service, "setSpelling", "openLicenceLink"]));
    expect(operations("valid", "service-envelope")).toEqual(expect.arrayContaining(service));
    expect(operations("invalid", "service-envelope")).toEqual(expect.arrayContaining(["readDictionary", "importDictionary", "setSpelling", "openLicenceLink"]));
    for (const kind of ["valid", "invalid"]) expect(operations(kind, "native-first-envelope")).toEqual(expect.arrayContaining(["importDictionary", "setSpelling", "openLicenceLink"]));
    expect(texts("valid", "response").map((t) => t.code)).toContain("DICTIONARY_UNAVAILABLE");
    const results = ["list-dictionaries-result", "read-dictionary-result", "dictionary-run-result", "remove-dictionary-result", "open-licence-link-result"];
    const reasons = new Set(results.flatMap((schema) => texts("valid", schema).map((t) => t.reason)));
    for (const reason of DICTIONARY_UNAVAILABLE_REASONS) expect({ reason, vector: reasons.has(reason) }).toEqual({ reason, vector: true });
    for (const kind of ["valid", "invalid"]) expect(texts(kind, "progress").map((t) => t.phase)).toContain("dictionary");
    for (const schema of results) for (const kind of ["valid", "invalid"]) expect({ schema, kind, count: texts(kind, schema).length > 0 }).toEqual({ schema, kind, count: true });
    for (const kind of ["valid", "invalid"]) expect(texts(kind, "sync-settings-result").some((t) => "spelling" in t)).toBe(true);
  });

  const faulted = vectors.filter(({ kind, vector }) => kind === "invalid" && FAULT_SCHEMAS.includes(vector.schema));
  test("each invalid vector of a fault schema carries its repair", () => {
    expect(faulted.filter(({ vector }) => vector.repair === undefined).map(({ name }) => name)).toEqual([]);
  });
  const faultRows = (on: boolean) => faulted.filter((v) => runs(v.vector) === on).map((v) => [`invalid/${v.name}`, v.vector] as const);
  test.each(faultRows(true))("%s passes after the repair of its named fault", (_name, vector) => {
    const exported = EXPORTED[vector.schema as keyof typeof EXPORTED];
    expect(exported.safeParse(repaired(JSON.parse(vector.text), vector.repair ?? {})).success).toBe(true);
  });
});
