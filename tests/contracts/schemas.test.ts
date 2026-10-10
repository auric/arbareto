// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import {
  ChooseGitResult,
  Comparison,
  decodeRequest,
  EnvironmentResult,
  NativeFirstEnvelope,
  OperationResult,
  ProgressEvent,
  RendererEnvelope,
  Response,
  ServiceEnvelope,
  SessionResult,
  validateRequest,
} from "../../src/contracts/envelope";
import { Handshake, MutationRequest, ProcessReply, ProcessRequest, TrustRecord, TrustReply, TrustRequest } from "../../src/contracts/channel";
import { EXPORTED, renderSchemas, staleSchemaFiles } from "../../src/contracts/export-schemas";
import { COMMIT_MESSAGE_BYTES } from "../../src/contracts/limits";
import { isWindows } from "../../src/contracts/native-path";
import { OPERATIONS, SHELL_ONLY } from "../../src/contracts/operations";
import { getEnvironment } from "../../src/git-service/environment";
import { createSessionLog } from "../../src/git-service/log";
import { createOperationRegistry } from "../../src/git-service/operations";
import { SUPPORT_REASONS } from "../../src/git-service/support";

printOrigin("../../src/contracts/envelope.ts", import.meta.dir);
printOrigin("../../src/contracts/channel.ts", import.meta.dir);
printOrigin("../../src/contracts/export-schemas.ts", import.meta.dir);
printOrigin("../../src/contracts/native-path.ts", import.meta.dir);
printOrigin("../../src/git-service/environment.ts", import.meta.dir);

const id = () => crypto.randomUUID();
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const IDENTITY = { volumeSerial: "0123456789abcdef", fileId: "0123456789abcdef0123456789abcdef" };
const REPO = isWindows ? "C:\\repo" : "/repo";
const GIT_DIR = isWindows ? "C:\\repo\\.git" : "/repo/.git";
const GIT_PATH = isWindows ? "C:\\Program Files\\Git\\cmd\\git.exe" : "/usr/bin/git";
const RECORD = {
  commonDirectory: GIT_DIR,
  commonIdentity: IDENTITY,
  worktreeRoot: REPO,
  gitDirectory: GIT_DIR,
  worktreeIdentity: [IDENTITY, IDENTITY],
  configurationFingerprint: "a".repeat(64),
  approvedAt: "2026-10-04T08:00:00Z",
  gitSelectedPath: GIT_PATH,
};
const HANDSHAKE = {
  version: 1,
  restarted: false,
  platformScope: "other",
  osBuild: 26200,
  webView2Version: "154.0.4258.53",
  buildIdentity: { version: "0.1.0", commit: "0".repeat(40), signing: "unsigned" },
  markers: [],
  unloadedMarkers: 0,
  damagedMarkers: [],
  trustRecords: [RECORD],
};
const commit = (message: string) => ({
  version: 1,
  sessionId: id(),
  requestId: id(),
  operation: "commit",
  repositoryId: id(),
  repositoryGeneration: 0,
  payload: { reviewToken: id(), message, confirmFullScope: true },
});

describe("envelope schemas", () => {
  test("the renderer envelope is a union of the 22 operations, and the service envelope of 20", () => {
    const names = (schema: { options: readonly { shape: { operation: { value: string } } }[] }) => schema.options.map((o) => o.shape.operation.value);
    expect(names(RendererEnvelope)).toEqual([...OPERATIONS]);
    expect(names(ServiceEnvelope)).toEqual(OPERATIONS.filter((name) => !(SHELL_ONLY as readonly string[]).includes(name)));
    expect(names(NativeFirstEnvelope).toSorted()).toEqual(["chooseGit", "chooseRepository", "dismissRecoveryMarker", "restoreWorkspace"]);
  });

  test("validateRequest gives PROTOCOL_VERSION, then UNKNOWN_OPERATION, then INVALID_REQUEST", () => {
    const base = { version: 1, sessionId: id(), requestId: id(), operation: "getEnvironment", payload: {} };
    expect(validateRequest({ ...base, version: 2, operation: "runShell", extra: 1 }, "renderer")).toEqual({ ok: false, code: "PROTOCOL_VERSION" });
    expect(validateRequest({ ...base, operation: "runShell", extra: 1 }, "renderer")).toEqual({ ok: false, code: "UNKNOWN_OPERATION" });
    expect(validateRequest({ ...base, extra: 1 }, "renderer")).toEqual({ ok: false, code: "INVALID_REQUEST" });
    expect(validateRequest(base, "service")).toMatchObject({ ok: true, request: base });
  });

  test("a version of 1.0 from the strict decoder gives PROTOCOL_VERSION", () => {
    const text = `{"version":1.0,"sessionId":"${id()}","requestId":"${id()}","operation":"getEnvironment","payload":{}}`;
    expect(decodeRequest(new TextEncoder().encode(text), "renderer")).toEqual({ ok: false, code: "PROTOCOL_VERSION" });
  });

  test("a commit message counts UTF-8 bytes: a 4-byte character may end exactly at 64 KiB", () => {
    const atLimit = "a".repeat(COMMIT_MESSAGE_BYTES - 4) + "\u{1F600}";
    expect(new TextEncoder().encode(atLimit).length).toBe(COMMIT_MESSAGE_BYTES);
    expect(validateRequest(commit(atLimit), "service")).toMatchObject({ ok: true });
    expect(validateRequest(commit("a" + atLimit), "service")).toEqual({ ok: false, code: "INVALID_REQUEST" });
    expect(decodeRequest(encode(commit("a" + atLimit)), "renderer")).toEqual({ ok: false, code: "INVALID_REQUEST" });
  });
});

describe("result, progress, and response schemas", () => {
  test("getEnvironment, chooseGit, getOperation, and currentSession results fit their schemas", () => {
    const handshake = Handshake.parse(HANDSHAKE);
    expect(EnvironmentResult.safeParse(getEnvironment(handshake, null)).success).toBe(true);
    const git = { gitInstallationId: id(), selectedPath: GIT_PATH, executablePath: GIT_PATH, version: "2.55.0.windows.3", digest: "c".repeat(64) };
    expect(ChooseGitResult.safeParse(git).success).toBe(true);
    expect(ChooseGitResult.safeParse({ minimumVersion: "2.55.0.windows.3", detectedVersion: "2.54.0.windows.1" }).success).toBe(true);
    expect(ChooseGitResult.safeParse({ ...git, extra: 1 }).success).toBe(false);
    const runner = { closeJob() {}, ended() {} };
    const registry = createOperationRegistry(() => {}, () => {}, createSessionLog(), runner);
    const { operationId } = registry.start("getOperation", id());
    expect(OperationResult.safeParse(registry.get(operationId)).success).toBe(true);
    for (const textScale of [1, 1.5, 2.25]) expect(SessionResult.safeParse({ sessionId: id(), textScale }).success).toBe(true);
    for (const bad of [{ sessionId: id() }, { sessionId: id(), textScale: 0.99 }, { sessionId: id(), textScale: 2.2501 }, { sessionId: id(), textScale: "1.5" }, { sessionId: id(), textScale: 1, extra: 1 }]) {
      expect(SessionResult.safeParse(bad).success).toBe(false);
    }
  });

  test("a progress event holds exactly the contract §2 fields", () => {
    const event = { requestId: id(), operationId: id(), state: "running", phase: "fetch", counters: { index: 1 }, stalled: false };
    expect(ProgressEvent.safeParse(event).success).toBe(true);
    for (const bad of [{ ...event, command: "git fetch" }, { ...event, state: "succeeded" }, { ...event, counters: { index: -1 } }, { ...event, counters: { index: 1.5 } }]) {
      expect(ProgressEvent.safeParse(bad).success).toBe(false);
    }
  });

  // T339 (b): contract §2 and §11 "Distro start".
  test("only phase wsl-starting carries distro, a listed distro name", () => {
    const event = { requestId: id(), operationId: id(), state: "running", phase: "wsl-starting", counters: {}, distro: "Ubuntu-26.04" };
    expect(ProgressEvent.safeParse(event).success).toBe(true);
    const { distro: _distro, ...without } = event;
    for (const bad of [without, { ...event, phase: "fetch" }, { ...without, phase: undefined, distro: "Ubuntu" }, { ...event, distro: "" }, { ...event, distro: "Ubuntu\n" }]) {
      expect(ProgressEvent.safeParse(bad).success).toBe(false);
    }
  });

  test("the readComparison support values are supported and the T103 support reasons", () => {
    expect(Comparison.shape.support.unwrap().options).toEqual(["supported", ...SUPPORT_REASONS]);
  });

  test("a response is terminal and carries a contract §9 code", () => {
    expect(Response.safeParse({ requestId: null, state: "rejected", code: "FRAME_LIMIT" }).success).toBe(true);
    expect(Response.safeParse({ requestId: id(), state: "running" }).success).toBe(false);
    expect(Response.safeParse({ requestId: id(), state: "rejected", code: "NO_SUCH_CODE" }).success).toBe(false);
  });
});

describe("channel schemas", () => {
  test("the handshake and the trust record bind gitSelectedPath, a channel path, and no digest", () => {
    expect(Handshake.safeParse(HANDSHAKE).success).toBe(true);
    expect(TrustRecord.safeParse(RECORD).success).toBe(true);
    const { gitSelectedPath: _path, ...withoutPath } = RECORD;
    expect(TrustRecord.safeParse({ ...withoutPath, gitInstallationDigest: "b".repeat(64) }).success).toBe(false);
    expect(TrustRecord.safeParse({ ...RECORD, gitSelectedPath: "b".repeat(64) }).success).toBe(false);
    expect(TrustRecord.safeParse({ ...RECORD, gitSelectedPath: "\\\\?\\C:\\Git\\cmd\\git.exe" }).success).toBe(false);
  });

  test("a confirm frame carries gitSelectedPath, and bound only with persist false", () => {
    const confirm = {
      type: "confirm",
      callId: id(),
      worktreeRoot: REPO,
      gitDirectory: GIT_DIR,
      commonDirectory: GIT_DIR,
      gitSelectedPath: GIT_PATH,
      fingerprint: "a".repeat(64),
      persist: true,
    };
    expect(TrustRequest.safeParse(confirm).success).toBe(true);
    expect(TrustRequest.safeParse({ ...confirm, persist: false, bound: "file-bytes" }).success).toBe(true);
    expect(TrustRequest.safeParse({ ...confirm, persist: false }).success).toBe(false);
    expect(TrustRequest.safeParse({ ...confirm, bound: "file-bytes" }).success).toBe(false);
    const { gitSelectedPath: _path, ...withoutPath } = confirm;
    expect(TrustRequest.safeParse({ ...withoutPath, gitInstallationDigest: "b".repeat(64) }).success).toBe(false);
    expect(TrustReply.safeParse({ type: "confirm", callId: id(), result: "approved", stored: true, record: RECORD }).success).toBe(true);
  });

  test("process and mutation frames follow contract §6", () => {
    const run = {
      type: "run",
      callId: id(),
      operationId: id(),
      contextKind: "registeredOperation",
      gitInstallationId: id(),
      repositoryId: id(),
      arguments: ["--no-lazy-fetch", "status"],
      environmentPolicy: "read",
      limits: { deadlineMs: 30_000 },
    };
    expect(ProcessRequest.safeParse(run).success).toBe(true);
    expect(ProcessRequest.safeParse({ ...run, bootstrapId: id() }).success).toBe(false);
    expect(ProcessRequest.safeParse({ ...run, arguments: ["a\u0000b"] }).success).toBe(false);
    expect(ProcessReply.safeParse({ type: "exit", callId: id(), exitCode: 4_294_967_295, activeDescendants: 0 }).success).toBe(true);
    expect(ProcessReply.safeParse({ type: "exit", callId: id(), exitCode: 4_294_967_296, activeDescendants: 0 }).success).toBe(false);
    const started = { type: "started", callId: id(), operationId: id(), repositoryId: id(), kind: "commit", worktreeRoot: REPO, commonDirectory: GIT_DIR };
    expect(MutationRequest.safeParse(started).success).toBe(true);
    expect(MutationRequest.safeParse({ ...started, kind: "readWorkspace" }).success).toBe(false);
    expect(MutationRequest.safeParse({ type: "ended", operationId: id(), endProcesses: false }).success).toBe(true);
  });

  // T339 (d): contract §6 "Mutation frames".
  test("a started frame of a hunk or file action carries its direction, and no other kind carries one", () => {
    const started = { type: "started", callId: id(), operationId: id(), repositoryId: id(), worktreeRoot: REPO, commonDirectory: GIT_DIR };
    for (const kind of ["applyHunk", "applyFile"]) {
      for (const direction of ["stage", "unstage"]) expect(MutationRequest.safeParse({ ...started, kind, direction }).success).toBe(true);
      expect(MutationRequest.safeParse({ ...started, kind }).success).toBe(false);
      expect(MutationRequest.safeParse({ ...started, kind, direction: "both" }).success).toBe(false);
    }
    for (const kind of ["commit", "updateSubmodules"]) {
      expect(MutationRequest.safeParse({ ...started, kind }).success).toBe(true);
      expect(MutationRequest.safeParse({ ...started, kind, direction: "stage" }).success).toBe(false);
    }
  });
});

describe("exported JSON Schema files", () => {
  test("every object branch of a union carries a title, as typify needs", () => {
    const untitled: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) return node.forEach((item, i) => walk(item, `${path}/${i}`));
      if (typeof node !== "object" || node === null) return;
      const record = node as Record<string, unknown>;
      for (const key of ["anyOf", "oneOf"]) {
        const branches = record[key];
        if (!Array.isArray(branches)) continue;
        branches.forEach((branch, i) => {
          if (branch?.type === "object" && typeof branch.title !== "string") untitled.push(`${path}/${key}/${i}`);
        });
      }
      for (const [key, value] of Object.entries(record)) walk(value, `${path}/${key}`);
    };
    for (const [name, text] of Object.entries(renderSchemas())) walk(JSON.parse(text), name);
    expect(untitled).toEqual([]);
  });

  test("the committed schema files equal a fresh export", () => {
    expect(Object.keys(renderSchemas()).toSorted()).toEqual(Object.keys(EXPORTED).map((name) => `${name}.schema.json`).toSorted());
    expect(staleSchemaFiles()).toEqual([]);
  });
});
