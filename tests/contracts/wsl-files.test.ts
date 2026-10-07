// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T325: the `wslFiles` request and the `fileFacts` field `index` (contract §6 "WSL file work", "Index digest in a read").
// The shell reads the same frames through the generated types (`src-tauri/src/schema.rs`), and the golden vectors run in both.

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { ProcessReply, ProcessRequest, type WslFileResult, type WslIndexResult } from "../../src/contracts/channel";
import { createNativeRunner } from "../../src/git-service/native-runner";

printOrigin("../../src/contracts/channel.ts", import.meta.dir);
printOrigin("../../src/git-service/native-runner.ts", import.meta.dir);

type Body = Record<string, unknown>;
type Sent = Record<string, unknown> & { kind: string };

const id = () => crypto.randomUUID();
const SIGNAL = new AbortController().signal;
const HEX = "a".repeat(64);
const OID = "b".repeat(40);
const context = () => ({ operationId: id(), contextKind: "registeredOperation", gitInstallationId: id(), repositoryId: id() });
const frame = (fields: Body) => ({ type: "wslFiles", callId: id(), ...context(), ...fields });
const entry = (name = "a.txt") => ({ root: "worktreeRoot", path: ["src", name] });
const entries = (n: number) => Array.from({ length: n }, (_, i) => entry(`f${i}`));

// One valid frame of each mode with its allowed bound.
const MODES: [string, Body][] = [
  ["digest", { mode: "digest", bound: "COMPARED_RAW_VERSION_BYTES", files: entries(64) }],
  ["digest of one whole file", { mode: "digest", bound: "WHOLE_FILE_STAGE_INPUT_BYTES", files: [entry()] }],
  ["indexDigest", { mode: "indexDigest", bound: "MUTATION_RAW_INDEX_BYTES" }],
  ["indexDigest with a shared index", { mode: "indexDigest", bound: "MUTATION_RAW_INDEX_BYTES", sharedIndex: OID }],
  ["hashObject", { mode: "hashObject", bound: "WHOLE_FILE_STAGE_INPUT_BYTES", files: [entry()] }],
  ["catFile", { mode: "catFile", bound: "WHOLE_FILE_STAGE_INPUT_BYTES", files: [entry()], oid: OID, size: 536_870_912 }],
  ["lock", { mode: "lock", bound: "MUTATION_RAW_INDEX_BYTES" }],
  ["candidate", { mode: "candidate", bound: "MUTATION_RAW_INDEX_BYTES", candidate: "arbareto-candidate-1" }],
  ["publish", { mode: "publish", bound: "MUTATION_RAW_INDEX_BYTES", candidate: "arbareto-candidate-1", lock: { device: "2112", inode: "57001" }, expected: HEX }],
];

const valid = (value: unknown) => ProcessRequest.safeParse(value).success;
const validReply = (value: unknown) => ProcessReply.safeParse(value).success;

describe("the wslFiles request (contract §6 WSL file work)", () => {
  test.each(MODES)("%s with its allowed bound is valid", (_name, fields) => {
    expect(valid(frame(fields))).toBe(true);
  });

  const BOUNDS = ["COMPARED_RAW_VERSION_BYTES", "WHOLE_FILE_STAGE_INPUT_BYTES", "MUTATION_RAW_INDEX_BYTES", "FILE_FACT_BYTES"];
  test.each(MODES)("%s with any other bound is refused", (_name, fields) => {
    const allowed = fields.mode === "digest" ? ["COMPARED_RAW_VERSION_BYTES", "WHOLE_FILE_STAGE_INPUT_BYTES"] : [fields.bound];
    for (const bound of BOUNDS.filter((b) => !allowed.includes(b))) expect(valid(frame({ ...fields, bound }))).toBe(false);
  });

  test.each(MODES)("%s without a field or with an extra field is refused", (_name, fields) => {
    for (const key of Object.keys(fields).filter((k) => k !== "sharedIndex")) {
      const { [key]: _gone, ...rest } = fields;
      expect(valid(frame(rest))).toBe(false);
    }
    const { operationId: _o, ...withoutOperation } = frame(fields);
    expect(valid(withoutOperation)).toBe(false);
    expect(valid(frame({ ...fields, extra: 1 }))).toBe(false);
    expect(valid(frame({ ...fields, digest: false }))).toBe(false);
  });

  test("digest takes at most 64 entries, and exactly 1 entry with WHOLE_FILE_STAGE_INPUT_BYTES", () => {
    expect(valid(frame({ mode: "digest", bound: "COMPARED_RAW_VERSION_BYTES", files: entries(65) }))).toBe(false);
    expect(valid(frame({ mode: "digest", bound: "COMPARED_RAW_VERSION_BYTES", files: [] }))).toBe(false);
    expect(valid(frame({ mode: "digest", bound: "WHOLE_FILE_STAGE_INPUT_BYTES", files: entries(2) }))).toBe(false);
  });

  test("hashObject and catFile take one worktreeRoot entry, and an entry keeps the component rule", () => {
    expect(valid(frame({ mode: "hashObject", bound: "WHOLE_FILE_STAGE_INPUT_BYTES", files: entries(2) }))).toBe(false);
    expect(valid(frame({ mode: "hashObject", bound: "WHOLE_FILE_STAGE_INPUT_BYTES", files: [{ root: "gitDirectory", path: ["index"] }] }))).toBe(false);
    expect(valid(frame({ mode: "catFile", bound: "WHOLE_FILE_STAGE_INPUT_BYTES", files: [entry()], oid: OID, size: 536_870_913 }))).toBe(false);
    expect(valid(frame({ mode: "digest", bound: "COMPARED_RAW_VERSION_BYTES", files: [{ root: "worktreeRoot", path: [".."] }] }))).toBe(false);
  });

  test("a candidate name starts with arbareto-candidate- and is one component", () => {
    for (const candidate of ["index.lock", "candidate-1", "arbareto-candidate-1/x", ""]) {
      expect(valid(frame({ mode: "candidate", bound: "MUTATION_RAW_INDEX_BYTES", candidate }))).toBe(false);
      expect(valid(frame({ mode: "publish", bound: "MUTATION_RAW_INDEX_BYTES", candidate, lock: { device: "1", inode: "2" }, expected: HEX }))).toBe(false);
    }
  });

  test("the publish lock holds decimal device and inode texts, and the shared index hash is 40 or 64 hex digits", () => {
    const publish = (lock: Body) => frame({ mode: "publish", bound: "MUTATION_RAW_INDEX_BYTES", candidate: "arbareto-candidate-1", lock, expected: HEX });
    expect(valid(publish({ device: "0", inode: "18446744073709551615" }))).toBe(true);
    for (const lock of [{ device: "01", inode: "2" }, { device: "1", inode: "18446744073709551616" }, { device: "1" }, { device: "1", inode: "2", size: "0" }]) expect(valid(publish(lock))).toBe(false);
    for (const sharedIndex of ["c".repeat(64), "c".repeat(40)]) expect(valid(frame({ mode: "indexDigest", bound: "MUTATION_RAW_INDEX_BYTES", sharedIndex }))).toBe(true);
    for (const sharedIndex of ["C".repeat(40), "c".repeat(41), ""]) expect(valid(frame({ mode: "indexDigest", bound: "MUTATION_RAW_INDEX_BYTES", sharedIndex }))).toBe(false);
  });
});

describe("the fileFacts field index (contract §6 Index digest in a read)", () => {
  const facts = (fields: Body) => ({ type: "fileFacts", callId: id(), ...context(), digest: false, files: [{ root: "gitDirectory", path: ["hooks"] }], ...fields });

  test("index is {} or {sharedIndex}, only with digest: false", () => {
    expect(valid(facts({ index: {} }))).toBe(true);
    expect(valid(facts({ index: { sharedIndex: OID } }))).toBe(true);
    expect(valid(facts({ index: {}, digest: true }))).toBe(false);
    expect(valid(facts({ index: { other: 1 } }))).toBe(false);
  });

  test("the reply holds the indexDigest result form", () => {
    const reply = (index: unknown) => ({ type: "fileFacts", callId: id(), facts: [{ kind: "absent" }], index });
    expect(validReply(reply({ kind: "index", index: { kind: "digest", size: 104, sha256: HEX }, sharedIndex: { kind: "absent" } }))).toBe(true);
    expect(validReply(reply({ kind: "index", index: { kind: "bound" } }))).toBe(true);
    expect(validReply(reply({ kind: "error", component: 0, code: "other-error" }))).toBe(true);
    expect(validReply(reply({ kind: "index", index: { kind: "digest", size: 104 } }))).toBe(false);
  });
});

describe("the wslFiles reply", () => {
  const reply = (results: unknown[]) => ({ type: "wslFiles", callId: id(), results });
  const exit = { exitCode: 0 };

  test.each([
    ["a digest file", { kind: "file", size: 0, changed: false, sha256: HEX }],
    ["a digest file above the bound", { kind: "file", size: 1_048_577, changed: true, bound: "COMPARED_RAW_VERSION_BYTES" }],
    ["a final link", { kind: "link", component: 1, targetBytes: "/w==", sha256: HEX }],
    ["a middle link", { kind: "link", component: 1 }],
    ["an object", { kind: "object", size: 12, sha256: HEX, oid: OID, gitExit: exit, hashExit: exit }],
    ["an object without an oid", { kind: "object", size: 12, sha256: HEX, gitExit: { exitCode: 128 }, hashExit: exit }],
    ["a blob over its size with a signal exit", { kind: "blob", size: 1, sha256: HEX, over: true, gitExit: { signal: 13 }, hashExit: exit }],
    ["a lock", { kind: "lock", device: "2112", inode: "57001" }],
    ["locked", { kind: "locked" }],
    ["a candidate", { kind: "candidate", index: { size: 104, sha256: HEX, mtime: "1791410531" }, candidate: { size: 104, sha256: HEX, mtime: "1791410531" } }],
    ["published", { kind: "published", size: 104, sha256: HEX }],
    ["mismatch", { kind: "mismatch" }],
    ["notOwned", { kind: "notOwned" }],
    ["an error", { kind: "error", component: 0, code: "other-error" }],
  ])("%s is a valid result", (_name, result) => {
    expect(validReply(reply([result]))).toBe(true);
  });

  test.each([
    ["sha256 and bound together", { kind: "file", size: 0, changed: false, sha256: HEX, bound: "COMPARED_RAW_VERSION_BYTES" }],
    ["neither sha256 nor bound", { kind: "file", size: 0, changed: false }],
    ["targetBytes without sha256", { kind: "link", component: 1, targetBytes: "/w==" }],
    ["targetBytes above 4,095 bytes", { kind: "link", component: 1, targetBytes: new Uint8Array(4096).toBase64(), sha256: HEX }],
    ["an exit with both forms", { kind: "blob", size: 1, sha256: HEX, over: false, gitExit: { exitCode: 0, signal: 9 }, hashExit: exit }],
    ["signal 0", { kind: "blob", size: 1, sha256: HEX, over: false, gitExit: { signal: 0 }, hashExit: exit }],
    ["the sharing-violation code", { kind: "error", component: 0, code: "sharing-violation" }],
  ])("a result with %s is invalid", (_name, result) => {
    expect(validReply(reply([result]))).toBe(false);
  });

  test("a deadline reply holds no result", () => {
    expect(validReply({ type: "wslFiles", callId: id(), deadline: "deadline" })).toBe(true);
    expect(validReply({ type: "wslFiles", callId: id(), deadline: "deadline", results: [{ kind: "locked" }] })).toBe(false);
    expect(validReply(reply([]))).toBe(false);
  });
});

// The service side: the frame, the reply checks, the deadline, and the abort (contract §6 "Walks").
describe("native runner wslFiles", () => {
  function channel() {
    const sent: Sent[] = [];
    const runner = createNativeRunner({ write: (f) => void sent.push(structuredClone(f) as Sent), flush: async () => {} });
    const last = (type: string) => sent.map((f) => f[f.kind] as Body).filter((b) => b.type === type).at(-1) as Body;
    return { runner, sent, last, reply: (body: Body) => runner.receive({ kind: "process", process: body }) };
  }
  const call = (fields: Body) => ({ ...context(), ...fields }) as Parameters<ReturnType<typeof createNativeRunner>["wslFiles"]>[0];

  test("wslFiles sends the frame and returns the results of its mode", async () => {
    const c = channel();
    const sent = call({ mode: "digest", bound: "COMPARED_RAW_VERSION_BYTES", files: [entry(), entry("b")] });
    const result = c.runner.wslFiles(sent, SIGNAL);
    const body = c.last("wslFiles");
    expect(body).toEqual({ type: "wslFiles", callId: body.callId, ...sent });
    const results: WslFileResult[] = [{ kind: "file", size: 3, changed: false, sha256: HEX }, { kind: "absent" }];
    expect(c.reply({ type: "wslFiles", callId: body.callId, results })).toBe(true);
    expect(await result).toEqual(results);
  });

  test.each([
    ["a count that differs from the entry count", { mode: "digest", bound: "COMPARED_RAW_VERSION_BYTES", files: [entry()] }, [{ kind: "absent" }, { kind: "absent" }]],
    ["a kind of another mode", { mode: "lock", bound: "MUTATION_RAW_INDEX_BYTES" }, [{ kind: "published", size: 1, sha256: HEX }]],
    ["a component past the entry path", { mode: "digest", bound: "COMPARED_RAW_VERSION_BYTES", files: [entry()] }, [{ kind: "error", component: 3, code: "io-error" }]],
    ["targetBytes on a middle link", { mode: "digest", bound: "COMPARED_RAW_VERSION_BYTES", files: [entry()] }, [{ kind: "link", component: 1, targetBytes: "/w==", sha256: HEX }]],
    ["another bound name", { mode: "digest", bound: "COMPARED_RAW_VERSION_BYTES", files: [entry()] }, [{ kind: "file", size: 1, changed: false, bound: "WHOLE_FILE_STAGE_INPUT_BYTES" }]],
    ["a shared part without a request hash", { mode: "indexDigest", bound: "MUTATION_RAW_INDEX_BYTES" }, [{ kind: "index", index: { kind: "absent" }, sharedIndex: { kind: "absent" } }]],
  ] as const)("a reply with %s fails the call with PROCESS_OWNERSHIP_FAILED", async (_name, fields, results) => {
    const c = channel();
    const result = c.runner.wslFiles(call(fields), SIGNAL);
    expect(c.reply({ type: "wslFiles", callId: c.last("wslFiles").callId, results })).toBe(false);
    await expect(result).rejects.toMatchObject({ code: "PROCESS_OWNERSHIP_FAILED" });
  });

  test("a deadline reply gives the deadline stop, and an abort sends cancel and ends the call", async () => {
    const c = channel();
    const lock = call({ mode: "lock", bound: "MUTATION_RAW_INDEX_BYTES" });
    const timed = c.runner.wslFiles(lock, SIGNAL);
    expect(c.reply({ type: "wslFiles", callId: c.last("wslFiles").callId, deadline: "deadline" })).toBe(true);
    expect(await timed).toEqual({ stop: "deadline" });
    const controller = new AbortController();
    const canceled = c.runner.wslFiles(lock, controller.signal);
    const callId = c.last("wslFiles").callId;
    controller.abort();
    expect(await canceled).toEqual({ stop: "canceled" });
    expect(c.last("cancel")).toEqual({ type: "cancel", callId });
  });

  test("an invalid request sends nothing", async () => {
    const c = channel();
    await expect(c.runner.wslFiles(call({ mode: "lock", bound: "COMPARED_RAW_VERSION_BYTES" }), SIGNAL)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(c.sent).toEqual([]);
  });

  test("indexedFileFacts sends index and returns the facts and the index result", async () => {
    const c = channel();
    const request = { ...context(), contextKind: "registeredOperation" as const, digest: false, files: [{ root: "gitDirectory" as const, path: ["hooks"] }], index: { sharedIndex: OID } };
    const result = c.runner.indexedFileFacts(request, SIGNAL);
    const body = c.last("fileFacts");
    expect(body).toEqual({ type: "fileFacts", callId: body.callId, ...request });
    const index: WslIndexResult = { kind: "index", index: { kind: "digest", size: 104, sha256: HEX }, sharedIndex: { kind: "absent" } };
    expect(c.reply({ type: "fileFacts", callId: body.callId, facts: [{ kind: "absent" }], index })).toBe(true);
    expect(await result).toEqual({ facts: [{ kind: "absent" }], index });
    // A reply without index, and the plain fileFacts call with index, both fail.
    const missing = c.runner.indexedFileFacts(request, SIGNAL);
    expect(c.reply({ type: "fileFacts", callId: c.last("fileFacts").callId, facts: [{ kind: "absent" }] })).toBe(false);
    await expect(missing).rejects.toMatchObject({ code: "PROCESS_OWNERSHIP_FAILED" });
    await expect(c.runner.fileFacts(request as never, SIGNAL)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
