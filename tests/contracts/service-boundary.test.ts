// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { printOrigin } from "../origin";
import { createSession, type SessionOptions } from "../../src/git-service/session";

const SERVICE_PATH = printOrigin("../../src/git-service/main.ts", import.meta.dir);
printOrigin("../../src/git-service/session.ts", import.meta.dir);

const READ_TIMEOUT_MS = 5_000;
const QUIET_MS = 500;
const TEST_TIMEOUT_MS = 30_000;
const MIB = 1024 * 1024;
const FRAME_KINDS = ["public", "process", "mutation", "trust", "handshake"];
const TERMINAL = ["succeeded", "limited", "failed", "canceled", "completed-with-effects", "failed-with-effects", "unknown", "rejected"];
// Contract §9 codes.
const ERROR_CODES = new Set(
  (
    "INVALID_REQUEST PROTOCOL_VERSION UNKNOWN_OPERATION UNKNOWN_TARGET FRAME_LIMIT BUSY WORKSPACE_LIMIT " +
    "GIT_UNAVAILABLE GIT_CHANGED GIT_UNSUPPORTED WEBVIEW_UNAVAILABLE WEBVIEW_UNSUPPORTED WSL_UNAVAILABLE " +
    "REPOSITORY_UNAVAILABLE REPOSITORY_CHANGED UNSUPPORTED_REPOSITORY DUBIOUS_OWNERSHIP NOT_A_REPOSITORY " +
    "OPERATION_IN_PROGRESS CONFLICTED LOCKED UNSUPPORTED_SUBMODULE TRUST_REQUIRED TRUST_CHANGED STALE_SELECTION " +
    "STALE_REVIEW APPROVAL_EXPIRED UNSUPPORTED_HUNK_PROFILE MALFORMED_GIT_OUTPUT OUTPUT_LIMIT OBJECT_MISSING " +
    "UNSUPPORTED_COMPARISON DISPLAY_MAPPING_FAILED GRAPH_LAYOUT_LIMITED IDENTITY_REQUIRED HOOK_FAILED " +
    "SIGNING_FAILED GIT_FAILED PROCESS_OWNERSHIP_FAILED DEADLINE CANCELED COMMIT_ENCODING_UNSUPPORTED " +
    "COMPLETED_WITH_EFFECTS FAILED_WITH_EFFECTS STATE_UNKNOWN SERVICE_UNAVAILABLE RECOVERY_MARKER_FAILED"
  ).split(" "),
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Contract §6 "Startup handshake". The frame omits the optional `savedGit`.
const HANDSHAKE_FIELDS = {
  version: 1,
  restarted: false,
  platformScope: "other",
  osBuild: 26200,
  webView2Version: "140.0.0.0",
  buildIdentity: { version: "0.1.0", commit: "0".repeat(40), signing: "unsigned" },
  markers: [] as unknown[],
  unloadedMarkers: 0,
  damagedMarkers: [] as unknown[],
  trustRecords: [] as unknown[],
};
const HANDSHAKE = { kind: "handshake", handshake: HANDSHAKE_FIELDS };
const SAVED_GIT = {
  bootstrapId: "00000000-0000-4000-8000-0000000000aa",
  selectedPath: "C:\\Program Files\\Git\\cmd\\git.exe",
  executablePath: "C:\\Program Files\\Git\\mingw64\\libexec\\git-core\\git.exe",
  version: "2.55.0.windows.3",
  digest: "c".repeat(64),
};

// Contract §6 "Process fields": a Windows identity reply.
const IDENTITY = { volumeSerial: "0123456789abcdef", fileId: "0123456789abcdef0123456789abcdef" };
const MARKER = {
  markerId: "00000000-0000-4000-8000-000000000000",
  kind: "commit",
  startedAt: "2026-10-02T08:00:00Z",
  worktreeRoot: "C:\\repo",
  commonDirectory: "C:\\repo\\.git",
  commonIdentity: IDENTITY,
};
const TRUST_RECORD = {
  commonDirectory: "C:\\repo\\.git",
  commonIdentity: IDENTITY,
  worktreeRoot: "C:\\repo",
  gitDirectory: "C:\\repo\\.git",
  worktreeIdentity: [IDENTITY, IDENTITY],
  configurationFingerprint: "a".repeat(64),
  approvedAt: "2026-10-02T08:00:00Z",
  gitInstallationDigest: "b".repeat(64),
};

type Frame = {
  kind?: unknown;
  handshake?: { sessionId?: unknown; code?: unknown };
  response?: { requestId?: unknown; operationId?: unknown; state?: unknown; code?: unknown };
  progress?: { requestId?: unknown; operationId?: unknown; state?: unknown; counters?: unknown };
};

const encoder = new TextEncoder();

function frameBytes(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, true);
  out.set(body, 4);
  return out;
}
const jsonFrame = (value: unknown) => frameBytes(encoder.encode(JSON.stringify(value)));

class Service {
  readonly proc: Subprocess<"pipe", "pipe", "pipe">;
  readonly frames: Frame[] = [];
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private pending: ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> | null = null;
  private buffer = new Uint8Array(0);
  private eof = false;
  private readonly cwd: string;

  constructor() {
    this.cwd = mkdtempSync(join(tmpdir(), "arbareto-service-cwd-"));
    this.proc = Bun.spawn([process.execPath, SERVICE_PATH], {
      cwd: this.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.reader = this.proc.stdout.getReader();
  }

  get running() {
    return this.proc.exitCode === null && this.proc.signalCode === null;
  }

  send(bytes: Uint8Array) {
    try {
      this.proc.stdin.write(bytes);
      // A flush or end to an exited service can reject later with EPIPE.
      void Promise.resolve(this.proc.stdin.flush()).catch(() => {});
    } catch {
      // A closed pipe shows up as end of stream in the next read.
    }
  }

  sendJson(value: unknown) {
    this.send(jsonFrame(value));
  }

  private take(): Frame | null {
    if (this.buffer.length < 4) return null;
    const length = new DataView(this.buffer.buffer, this.buffer.byteOffset).getUint32(0, true);
    if (length > 16 * MIB) throw new Error(`service sent a frame length above 16 MiB: ${length}`);
    if (this.buffer.length < 4 + length) return null;
    const body = this.buffer.slice(4, 4 + length);
    this.buffer = this.buffer.slice(4 + length);
    const frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as Frame;
    this.frames.push(frame);
    return frame;
  }

  async next(timeoutMs = READ_TIMEOUT_MS): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = this.take();
      if (frame) return frame;
      if (this.eof) throw new Error(`service closed stdout (exit ${this.proc.exitCode ?? "pending"})`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no frame within ${timeoutMs} ms`);
      const read = (this.pending ??= this.reader.read());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), left);
      });
      const result = await Promise.race([read, timeout]);
      clearTimeout(timer);
      if (result === "timeout") throw new Error(`no frame within ${timeoutMs} ms`);
      this.pending = null;
      if (result.done || !result.value) {
        this.eof = true;
        continue;
      }
      const merged = new Uint8Array(this.buffer.length + result.value.length);
      merged.set(this.buffer);
      merged.set(result.value, this.buffer.length);
      this.buffer = merged;
    }
  }

  async responseFor(requestIds: string | null | Array<string | null>, timeoutMs = READ_TIMEOUT_MS) {
    const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = await this.next(Math.max(1, deadline - Date.now()));
      const id = frame.response?.requestId ?? null;
      if (frame.response && ids.includes(id as string | null) && TERMINAL.includes(frame.response.state as string)) {
        return frame.response;
      }
    }
  }

  async quietFrames(ms = QUIET_MS): Promise<Frame[]> {
    const seen: Frame[] = [];
    const deadline = Date.now() + ms;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return seen;
      try {
        seen.push(await this.next(left));
      } catch (error) {
        if (String(error).includes("no frame within")) return seen;
        throw error;
      }
    }
  }

  async handshake(): Promise<string> {
    this.sendJson(HANDSHAKE);
    const reply = await this.next();
    expect(reply.kind).toBe("handshake");
    expect(reply).toEqual({ kind: "handshake", handshake: { sessionId: expect.stringMatching(UUID) } });
    return reply.handshake?.sessionId as string;
  }

  async exited(timeoutMs = READ_TIMEOUT_MS): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.proc.exited, new Promise((r) => (timer = setTimeout(r, timeoutMs)))]);
    clearTimeout(timer);
    return !this.running;
  }

  async stop() {
    try {
      void Promise.resolve(this.proc.stdin.end()).catch(() => {});
    } catch {
      // The pipe can already be closed.
    }
    this.proc.kill();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.proc.exited, new Promise((r) => (timer = setTimeout(r, 5_000)))]);
    clearTimeout(timer);
    if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill("SIGKILL");
    rmSync(this.cwd, { recursive: true, force: true });
  }
}

const services: Service[] = [];
const start = () => {
  const service = new Service();
  services.push(service);
  return service;
};
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.stop()));
});

const request = (
  sessionId: string | undefined,
  operation: string,
  payload: Record<string, unknown> = {},
  requestId = crypto.randomUUID(),
  repositoryId?: string,
) => {
  const envelope: Record<string, unknown> = { version: 1, requestId, operation, payload };
  if (sessionId !== undefined) envelope.sessionId = sessionId;
  if (repositoryId !== undefined) envelope.repositoryId = repositoryId;
  return { kind: "public", request: envelope };
};

async function expectTypedError(service: Service, requestId: string | null | Array<string | null>, code?: string) {
  const response = await service.responseFor(requestId);
  expect(response.state).toBe("rejected");
  expect(ERROR_CODES.has(response.code as string)).toBe(true);
  if (code) expect(response.code).toBe(code);
  return response;
}

async function expectHandshakeFailure(service: Service, handshake: unknown, code: string) {
  service.sendJson({ kind: "handshake", handshake });
  const reply = await service.next();
  expect(reply).toEqual({ kind: "handshake", handshake: { code } });
  expect(await service.exited()).toBe(true);
}

const withoutField = (field: string) => {
  const fields: Record<string, unknown> = { ...HANDSHAKE_FIELDS };
  delete fields[field];
  return fields;
};

async function expectStillServing(service: Service, sessionId: string) {
  expect(service.running).toBe(true);
  const probe = request(sessionId, "getEnvironment");
  service.sendJson(probe);
  const response = await service.responseFor(probe.request.requestId as string);
  expect(TERMINAL).toContain(response.state as string);
}

describe("service boundary", () => {
  test(
    "the startup handshake returns a sessionId",
    async () => {
      const service = start();
      await service.handshake();
      expect(service.running).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "malformed frames get typed errors and the service keeps running",
    async () => {
      const service = start();
      const sessionId = await service.handshake();
      const noKind = request(sessionId, "getEnvironment");
      const badKind = request(sessionId, "getEnvironment");
      // Contract §1: an undecodable frame gets requestId null. A frame with a valid requestId gets that ID.
      const cases: Array<[string, Uint8Array, string | null]> = [
        ["invalid JSON", frameBytes(encoder.encode('{"kind":"public",')), null],
        ["invalid UTF-8", frameBytes(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])), null],
        ["empty body", frameBytes(new Uint8Array(0)), null],
        ["missing kind", jsonFrame({ request: noKind.request }), noKind.request.requestId as string],
        ["unknown kind", jsonFrame({ ...badKind, kind: "shell" }), badKind.request.requestId as string],
      ];
      for (const [, bytes, requestId] of cases) {
        service.send(bytes);
        const response = await expectTypedError(service, requestId, "INVALID_REQUEST");
        expect(response.requestId).toBe(requestId);
      }
      await expectStillServing(service, sessionId);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "duplicate keys give INVALID_REQUEST",
    async () => {
      const service = start();
      const sessionId = await service.handshake();
      const requestId = crypto.randomUUID();
      const text =
        `{"kind":"public","request":{"version":1,"sessionId":"${sessionId}","requestId":"${requestId}",` +
        `"operation":"getEnvironment","operation":"getEnvironment","payload":{}}}`;
      service.send(frameBytes(encoder.encode(text)));
      const response = await service.responseFor([null, requestId]);
      expect(response.state).toBe("rejected");
      expect(response.code).toBe("INVALID_REQUEST");
      await expectStillServing(service, sessionId);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "unknown operations give UNKNOWN_OPERATION",
    async () => {
      const service = start();
      const sessionId = await service.handshake();
      for (const operation of ["deleteBranch", "read_workspace", "__proto__"]) {
        const frame = request(sessionId, operation);
        service.sendJson(frame);
        await expectTypedError(service, frame.request.requestId as string, "UNKNOWN_OPERATION");
      }
      await expectStillServing(service, sessionId);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "requestClose and currentSession sent to the service give UNKNOWN_OPERATION",
    async () => {
      const service = start();
      const sessionId = await service.handshake();
      const close = request(sessionId, "requestClose", { choice: "stay" });
      service.sendJson(close);
      await expectTypedError(service, close.request.requestId as string, "UNKNOWN_OPERATION");
      const current = request(undefined, "currentSession");
      service.sendJson(current);
      await expectTypedError(service, current.request.requestId as string, "UNKNOWN_OPERATION");
      await expectStillServing(service, sessionId);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "forged identifiers get typed errors",
    async () => {
      const service = start();
      const sessionId = await service.handshake();
      const forgedSession = request(crypto.randomUUID(), "getEnvironment");
      service.sendJson(forgedSession);
      await expectTypedError(service, forgedSession.request.requestId as string, "UNKNOWN_TARGET");
      const forgedOperation = request(sessionId, "getOperation", { operationId: crypto.randomUUID() });
      service.sendJson(forgedOperation);
      await expectTypedError(service, forgedOperation.request.requestId as string, "UNKNOWN_TARGET");
      // A forged trustId needs a registered workspace, which T015 cannot create. So this case forges repositoryId.
      const forgedRepository = request(sessionId, "revokeTrust", { trustId: crypto.randomUUID() }, crypto.randomUUID(), crypto.randomUUID());
      service.sendJson(forgedRepository);
      await expectTypedError(service, forgedRepository.request.requestId as string, "UNKNOWN_TARGET");
      await expectStillServing(service, sessionId);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "identifiers from another session get typed errors",
    async () => {
      const first = start();
      const second = start();
      const firstSession = await first.handshake();
      const secondSession = await second.handshake();
      expect(secondSession).not.toBe(firstSession);
      const foreign = request(secondSession, "getEnvironment");
      first.sendJson(foreign);
      await expectTypedError(first, foreign.request.requestId as string, "UNKNOWN_TARGET");
      await expectStillServing(first, firstSession);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a public frame body above 1 MiB plus 28 bytes gives FRAME_LIMIT",
    async () => {
      const service = start();
      const sessionId = await service.handshake();
      // Contract §5: the body is this 27-byte prefix, the envelope, and "}". Spaces pad the request value.
      const body = (frame: ReturnType<typeof request>, size: number) => {
        const envelope = JSON.stringify(frame.request);
        const bytes = encoder.encode('{"kind":"public","request":' + " ".repeat(size - 28 - envelope.length) + envelope + "}");
        expect(bytes.length).toBe(size);
        return bytes;
      };
      const atLimit = request(sessionId, "getEnvironment");
      service.send(frameBytes(body(atLimit, MIB + 28)));
      const accepted = await service.responseFor(atLimit.request.requestId as string);
      expect(accepted.code).not.toBe("FRAME_LIMIT");
      const overLimit = request(sessionId, "getEnvironment");
      service.send(frameBytes(body(overLimit, MIB + 29)));
      const response = await service.responseFor([null, overLimit.request.requestId as string]);
      expect(response.state).toBe("rejected");
      expect(response.code).toBe("FRAME_LIMIT");
      await expectStillServing(service, sessionId);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a length header above 16 MiB gives FRAME_LIMIT before any body byte",
    async () => {
      const service = start();
      const sessionId = await service.handshake();
      const length = 16 * MIB + 1;
      const header = new Uint8Array(4);
      new DataView(header.buffer).setUint32(0, length, true);
      service.send(header);
      const response = await expectTypedError(service, null, "FRAME_LIMIT");
      expect(response.requestId).toBeNull();
      const chunk = new Uint8Array(MIB);
      for (let sent = 0; sent < length; sent += chunk.length) {
        service.send(chunk.subarray(0, Math.min(chunk.length, length - sent)));
      }
      await expectStillServing(service, sessionId);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "each accepted request gets exactly one terminal response",
    async () => {
      const service = start();
      const sessionId = await service.handshake();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const frame = request(sessionId, "getEnvironment");
        ids.push(frame.request.requestId as string);
        service.sendJson(frame);
      }
      for (const id of ids) await service.responseFor(id);
      await service.quietFrames();
      for (const id of ids) {
        const terminal = service.frames.filter(
          (f) => f.response?.requestId === id && TERMINAL.includes(f.response.state as string),
        );
        expect(terminal.length).toBe(1);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an admitted request gets one accepted event before its terminal response, and a forged request gets none",
    async () => {
      // This half drives the session registry in process, so the event order does not depend on a Git process.
      const frames: Frame[] = [];
      const session = createSession({
        writer: { write: (frame) => void frames.push(frame as Frame), flush: async () => {} },
        runner: { receive: () => false, closeJob: () => {} } as unknown as SessionOptions["runner"],
        fail: () => {},
      });
      session.receive({ type: "frame", body: encoder.encode(JSON.stringify(HANDSHAKE)) });
      const requestId = crypto.randomUUID();
      const { operationId } = session.registry.start("getEnvironment", requestId);
      session.registry.apply(operationId, { type: "valid-read" });
      session.registry.apply(operationId, { type: "read-complete", result: "succeeded" });
      const own = frames.filter((f) => f.progress?.requestId === requestId || f.response?.requestId === requestId);
      expect(own.map((f) => (f.progress ? "progress" : "response"))).toEqual(["progress", "response"]);
      expect(own[0]).toEqual({ kind: "public", progress: { requestId, operationId, state: "accepted", counters: {} } });
      expect(own[1].response).toMatchObject({ requestId, operationId, state: "succeeded" });

      const service = start();
      const sessionId = await service.handshake();
      const forged = [request(sessionId, "getOperation", { operationId: crypto.randomUUID() }), request(crypto.randomUUID(), "getEnvironment")];
      for (const frame of forged) {
        service.sendJson(frame);
        await expectTypedError(service, frame.request.requestId as string, "UNKNOWN_TARGET");
      }
      await service.quietFrames();
      expect(service.frames.filter((f) => f.progress !== undefined)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a repeated requestId gives INVALID_REQUEST and starts nothing",
    async () => {
      const service = start();
      const sessionId = await service.handshake();
      const first = request(sessionId, "getEnvironment");
      service.sendJson(first);
      const firstResponse = await service.responseFor(first.request.requestId as string);
      expect(firstResponse.code).not.toBe("INVALID_REQUEST");
      const before = service.frames.length;
      service.sendJson(first);
      await expectTypedError(service, first.request.requestId as string, "INVALID_REQUEST");
      await service.quietFrames();
      const later = service.frames.slice(before).filter((f) => f.response?.requestId === first.request.requestId);
      expect(later.length).toBe(1);
      expect(later[0].response?.operationId ?? null).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test("the session keeps the last 65,536 requestId values and drops the oldest first", () => {
    // In process and without Git, so the 65,537 requests stay fast.
    const responses = new Map<unknown, Frame["response"]>();
    const session = createSession({
      writer: { write: (frame) => void responses.set((frame as Frame).response?.requestId, (frame as Frame).response), flush: async () => {} },
      runner: { receive: () => false, closeJob: () => {} } as unknown as SessionOptions["runner"],
      fail: () => {},
    });
    session.receive({ type: "frame", body: encoder.encode(JSON.stringify(HANDSHAKE)) });
    const sessionId = session.sessionId as string;
    const id = (i: number) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}` as ReturnType<typeof crypto.randomUUID>;
    // A request without its other envelope fields still records its requestId (contract §2).
    for (let i = 1; i <= 65_537; i++) session.receive({ type: "frame", body: encoder.encode(`{"kind":"public","request":{"requestId":"${id(i)}"}}`) });
    expect(responses.get(id(65_537))?.code).toBe("INVALID_REQUEST");
    const send = (requestId: ReturnType<typeof crypto.randomUUID>) => {
      session.receive({ type: "frame", body: encoder.encode(JSON.stringify(request(sessionId, "getEnvironment", {}, requestId))) });
      return responses.get(requestId);
    };
    expect(send(id(2))?.code).toBe("INVALID_REQUEST");
    expect(send(id(1))?.state).toBe("succeeded");
    // Recording the first requestId again dropped the second, so the set holds 65,536.
    expect(send(id(2))?.state).toBe("succeeded");
  });

  test(
    "every pipe frame carries a known top-level kind",
    async () => {
      const service = start();
      const sessionId = await service.handshake();
      const frame = request(sessionId, "getEnvironment");
      service.sendJson(frame);
      await service.responseFor(frame.request.requestId as string);
      service.send(frameBytes(encoder.encode("{")));
      await service.responseFor(null);
      await service.quietFrames();
      expect(service.frames.length).toBeGreaterThan(0);
      for (const received of service.frames) expect(FRAME_KINDS).toContain(received.kind as string);
    },
    TEST_TIMEOUT_MS,
  );
});

const DAMAGED = { markerId: "00000000-0000-4000-8000-0000000000d0", fileName: "broken.json" };
const damagedAt = (i: number) => ({ markerId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, fileName: `damaged-${i}.json` });
const damaged = (count: number) => Array.from({ length: count }, (_, i) => damagedAt(i));
const markerAt = (i: number) => ({ ...MARKER, markerId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` });
const markers = (count: number) => Array.from({ length: count }, (_, i) => markerAt(i));
const trustRecords = (count: number) => Array.from({ length: count }, () => ({ ...TRUST_RECORD }));
// Contract §5: 4 KiB per trust record and per recovery marker. The path field pads the JSON encoding to `bytes`.
const sized = <T extends { worktreeRoot: string }>(item: T, bytes: number): T => {
  const base = encoder.encode(JSON.stringify({ ...item, worktreeRoot: "C:\\" })).length;
  return { ...item, worktreeRoot: "C:\\" + "a".repeat(bytes - base) };
};
const RECORD_BYTES = 4096;

describe("startup handshake bounds", () => {
  // Positive controls for the "65 markers" and "257 trust records" failures.
  const atBound: Array<[string, Record<string, unknown>]> = [
    ["64 markers", { markers: markers(64) }],
    ["64 damaged markers", { damagedMarkers: damaged(64) }],
    // Contract §6: a file name has at most 255 UTF-16 units.
    ["a 255-unit damaged file name", { damagedMarkers: [{ ...DAMAGED, fileName: `${"é".repeat(250)}.json` }] }],
    ["256 trust records", { trustRecords: trustRecords(256) }],
    // Positive control for the `savedGit` failures.
    ["a savedGit", { savedGit: SAVED_GIT }],
    // Contract §6 `savedGit`: without a readable selected file, the shell sends no `bootstrapId`.
    ["a savedGit without bootstrapId", { savedGit: Object.fromEntries(Object.entries(SAVED_GIT).filter(([k]) => k !== "bootstrapId")) }],
    // Positive controls for the version text and record size failures.
    ["64-byte printable versions", { buildIdentity: { ...HANDSHAKE_FIELDS.buildIdentity, version: "~".repeat(64) }, savedGit: { ...SAVED_GIT, version: " ".repeat(64) } }],
    ["a 4096-byte trust record and marker", { trustRecords: [sized(TRUST_RECORD, RECORD_BYTES)], markers: [sized(MARKER, RECORD_BYTES)] }],
  ];
  for (const [name, fields] of atBound) {
    test(
      `${name} give a sessionId`,
      async () => {
        const service = start();
        service.sendJson({ kind: "handshake", handshake: { ...HANDSHAKE_FIELDS, ...fields } });
        expect(await service.next()).toEqual({ kind: "handshake", handshake: { sessionId: expect.stringMatching(UUID) } });
        expect(service.running).toBe(true);
      },
      TEST_TIMEOUT_MS,
    );
  }
});

describe("startup handshake failures", () => {
  // A failed handshake ends the service, so each case starts its own service.
  const failures: Array<[string, unknown, string]> = [
    ...Object.keys(HANDSHAKE_FIELDS).map((field): [string, unknown, string] => [`missing ${field}`, withoutField(field), "INVALID_REQUEST"]),
    ["an unknown field", { ...HANDSHAKE_FIELDS, extra: 1 }, "INVALID_REQUEST"],
    ["a wrong type", { ...HANDSHAKE_FIELDS, restarted: "false" }, "INVALID_REQUEST"],
    ["65 markers", { ...HANDSHAKE_FIELDS, markers: markers(65) }, "INVALID_REQUEST"],
    ["65 damaged markers", { ...HANDSHAKE_FIELDS, damagedMarkers: damaged(65) }, "INVALID_REQUEST"],
    ["a damaged marker without fileName", { ...HANDSHAKE_FIELDS, damagedMarkers: [{ markerId: DAMAGED.markerId }] }, "INVALID_REQUEST"],
    ["a damaged marker with file content", { ...HANDSHAKE_FIELDS, damagedMarkers: [{ ...DAMAGED, content: "{" }] }, "INVALID_REQUEST"],
    ["a damaged marker with a malformed markerId", { ...HANDSHAKE_FIELDS, damagedMarkers: [{ ...DAMAGED, markerId: "broken" }] }, "INVALID_REQUEST"],
    ["a damaged marker with an empty file name", { ...HANDSHAKE_FIELDS, damagedMarkers: [{ ...DAMAGED, fileName: "" }] }, "INVALID_REQUEST"],
    ["a 256-unit damaged file name", { ...HANDSHAKE_FIELDS, damagedMarkers: [{ ...DAMAGED, fileName: `${"a".repeat(251)}.json` }] }, "INVALID_REQUEST"],
    ["a damaged file name with a backslash", { ...HANDSHAKE_FIELDS, damagedMarkers: [{ ...DAMAGED, fileName: "..\\settings.json" }] }, "INVALID_REQUEST"],
    ["a damaged file name with a slash", { ...HANDSHAKE_FIELDS, damagedMarkers: [{ ...DAMAGED, fileName: "../settings.json" }] }, "INVALID_REQUEST"],
    ["257 trust records", { ...HANDSHAKE_FIELDS, trustRecords: trustRecords(257) }, "INVALID_REQUEST"],
    ["a top-level bootstrapId", { ...HANDSHAKE_FIELDS, bootstrapId: crypto.randomUUID() }, "INVALID_REQUEST"],
    ...Object.keys(SAVED_GIT).filter((field) => field !== "bootstrapId").map((field): [string, unknown, string] => [
      `a savedGit without ${field}`,
      { ...HANDSHAKE_FIELDS, savedGit: Object.fromEntries(Object.entries(SAVED_GIT).filter(([k]) => k !== field)) },
      "INVALID_REQUEST",
    ]),
    ["a savedGit with an unknown field", { ...HANDSHAKE_FIELDS, savedGit: { ...SAVED_GIT, extra: 1 } }, "INVALID_REQUEST"],
    ["a savedGit with a malformed bootstrapId", { ...HANDSHAKE_FIELDS, savedGit: { ...SAVED_GIT, bootstrapId: "not-a-uuid" } }, "INVALID_REQUEST"],
    ["a savedGit with a non-hex digest", { ...HANDSHAKE_FIELDS, savedGit: { ...SAVED_GIT, digest: "g".repeat(64) } }, "INVALID_REQUEST"],
    ["a savedGit with an uppercase digest", { ...HANDSHAKE_FIELDS, savedGit: { ...SAVED_GIT, digest: "C".repeat(64) } }, "INVALID_REQUEST"],
    ["a savedGit with a short digest", { ...HANDSHAKE_FIELDS, savedGit: { ...SAVED_GIT, digest: "c".repeat(63) } }, "INVALID_REQUEST"],
    ["a savedGit with a relative executablePath", { ...HANDSHAKE_FIELDS, savedGit: { ...SAVED_GIT, executablePath: "git.exe" } }, "INVALID_REQUEST"],
    ["a savedGit with a relative selectedPath", { ...HANDSHAKE_FIELDS, savedGit: { ...SAVED_GIT, selectedPath: "cmd\\git.exe" } }, "INVALID_REQUEST"],
    ["a savedGit with a device selectedPath", { ...HANDSHAKE_FIELDS, savedGit: { ...SAVED_GIT, selectedPath: "\\\\.\\pipe\\git.exe" } }, "INVALID_REQUEST"],
    ["a savedGit with a number selectedPath", { ...HANDSHAKE_FIELDS, savedGit: { ...SAVED_GIT, selectedPath: 7 } }, "INVALID_REQUEST"],
    ["a savedGit that is not an object", { ...HANDSHAKE_FIELDS, savedGit: null }, "INVALID_REQUEST"],
    ["a 65-byte buildIdentity version", { ...HANDSHAKE_FIELDS, buildIdentity: { ...HANDSHAKE_FIELDS.buildIdentity, version: "1".repeat(65) } }, "INVALID_REQUEST"],
    ["a buildIdentity version with a control character", { ...HANDSHAKE_FIELDS, buildIdentity: { ...HANDSHAKE_FIELDS.buildIdentity, version: "0.1.0\u0000" } }, "INVALID_REQUEST"],
    ["a 65-byte savedGit version", { ...HANDSHAKE_FIELDS, savedGit: { ...SAVED_GIT, version: "2".repeat(65) } }, "INVALID_REQUEST"],
    ["a savedGit version with a non-ASCII character", { ...HANDSHAKE_FIELDS, savedGit: { ...SAVED_GIT, version: `2.55.0${String.fromCharCode(0xe9)}` } }, "INVALID_REQUEST"],
    ["a trust record above 4 KiB", { ...HANDSHAKE_FIELDS, trustRecords: [sized(TRUST_RECORD, RECORD_BYTES + 1)] }, "INVALID_REQUEST"],
    ["a marker above 4 KiB", { ...HANDSHAKE_FIELDS, markers: [sized(MARKER, RECORD_BYTES + 1)] }, "INVALID_REQUEST"],
    ["version 2", { ...HANDSHAKE_FIELDS, version: 2 }, "PROTOCOL_VERSION"],
  ];
  for (const [name, handshake, code] of failures) {
    test(
      `${name} gives ${code}, and the service exits`,
      async () => {
        const service = start();
        await expectHandshakeFailure(service, handshake, code);
      },
      TEST_TIMEOUT_MS,
    );
  }

  // Contract §6 "Startup handshake": `version` is the integer `1`, so its literal has no fraction and no exponent.
  for (const literal of ["1.0", "1e0"]) {
    test(
      `version ${literal} gives PROTOCOL_VERSION, and the service exits`,
      async () => {
        const service = start();
        const text = JSON.stringify(HANDSHAKE).replace('"version":1,', `"version":${literal},`);
        expect(text).toContain(`"version":${literal},`);
        service.send(frameBytes(encoder.encode(text)));
        expect(await service.next()).toEqual({ kind: "handshake", handshake: { code: "PROTOCOL_VERSION" } });
        expect(await service.exited()).toBe(true);
      },
      TEST_TIMEOUT_MS,
    );
  }

  test(
    "version 1 in the handshake text gives a sessionId",
    async () => {
      const service = start();
      const text = JSON.stringify(HANDSHAKE);
      expect(text).toContain('"version":1,');
      service.send(frameBytes(encoder.encode(text)));
      const reply = await service.next();
      expect(reply.kind).toBe("handshake");
      expect(typeof reply.handshake?.sessionId).toBe("string");
      expect(service.running).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a second handshake gives INVALID_REQUEST, and the session continues",
    async () => {
      const service = start();
      const sessionId = await service.handshake();
      service.sendJson(HANDSHAKE);
      expect(await service.next()).toEqual({ kind: "handshake", handshake: { code: "INVALID_REQUEST" } });
      await expectStillServing(service, sessionId);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a public request before the handshake gives SERVICE_UNAVAILABLE",
    async () => {
      const service = start();
      const early = request(crypto.randomUUID(), "getEnvironment");
      service.sendJson(early);
      await expectTypedError(service, early.request.requestId as string, "SERVICE_UNAVAILABLE");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("getEnvironment through the service", () => {
  test(
    "after a handshake without savedGit, getEnvironment succeeds with GIT_UNAVAILABLE and the handshake facts",
    async () => {
      const service = start();
      const sessionId = await service.handshake();
      const frame = request(sessionId, "getEnvironment");
      service.sendJson(frame);
      const response = (await service.responseFor(frame.request.requestId as string)) as Frame["response"] & { result?: Record<string, unknown> };
      expect(response.state).toBe("succeeded");
      expect(response.result).toMatchObject({
        gitCode: "GIT_UNAVAILABLE",
        buildIdentity: HANDSHAKE_FIELDS.buildIdentity,
        platformScope: HANDSHAKE_FIELDS.platformScope,
        markers: [],
        damagedMarkers: [],
      });
      expect(response.result?.selectedPath).toBeUndefined();
      expect(response.result?.executablePath).toBeUndefined();
      const accepted = service.frames.filter((f) => f.progress?.requestId === frame.request.requestId);
      expect(accepted.map((f) => f.progress?.state)).toEqual(["accepted"]);
    },
    TEST_TIMEOUT_MS,
  );
});
