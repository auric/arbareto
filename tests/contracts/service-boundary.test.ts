// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { printOrigin } from "../origin";

const SERVICE_PATH = printOrigin("../../src/git-service/main.ts", import.meta.dir);

const READ_TIMEOUT_MS = 5_000;
const QUIET_MS = 500;
const TEST_TIMEOUT_MS = 30_000;
const MIB = 1024 * 1024;
const FRAME_KINDS = ["public", "process", "mutation", "trust"];
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

// The contract names the startup handshake but not its frame. These shapes are test choices.
const HANDSHAKE = { kind: "public", handshake: { version: 1, restarted: false } };
type Frame = {
  kind?: unknown;
  handshake?: { sessionId?: unknown };
  response?: { requestId?: unknown; operationId?: unknown; state?: unknown; code?: unknown };
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
      this.proc.stdin.flush();
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
    const sessionId = reply.handshake?.sessionId;
    expect(typeof sessionId).toBe("string");
    expect(sessionId as string).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    return sessionId as string;
  }

  async stop() {
    try {
      this.proc.stdin.end();
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

const request = (sessionId: string | undefined, operation: string, payload: Record<string, unknown> = {}, requestId = crypto.randomUUID()) => {
  const envelope: Record<string, unknown> = { version: 1, requestId, operation, payload };
  if (sessionId !== undefined) envelope.sessionId = sessionId;
  return { kind: "public", request: envelope };
};

async function expectTypedError(service: Service, requestId: string | null | Array<string | null>, code?: string) {
  const response = await service.responseFor(requestId);
  expect(response.state).toBe("rejected");
  expect(ERROR_CODES.has(response.code as string)).toBe(true);
  if (code) expect(response.code).toBe(code);
}

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
      const cases: Array<[string, Uint8Array, Array<string | null>, string | undefined]> = [
        ["invalid JSON", frameBytes(encoder.encode('{"kind":"public",')), [null], "INVALID_REQUEST"],
        ["invalid UTF-8", frameBytes(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])), [null], "INVALID_REQUEST"],
        ["empty body", frameBytes(new Uint8Array(0)), [null], "INVALID_REQUEST"],
        ["missing kind", jsonFrame({ request: noKind.request }), [null, noKind.request.requestId as string], undefined],
        ["unknown kind", jsonFrame({ ...badKind, kind: "shell" }), [null, badKind.request.requestId as string], undefined],
      ];
      for (const [, bytes, ids, code] of cases) {
        service.send(bytes);
        await expectTypedError(service, ids, code);
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
      await expectTypedError(service, forgedSession.request.requestId as string);
      const forgedOperation = request(sessionId, "getOperation", { operationId: crypto.randomUUID() });
      service.sendJson(forgedOperation);
      await expectTypedError(service, forgedOperation.request.requestId as string);
      const forgedTrust = request(sessionId, "revokeTrust", { trustId: crypto.randomUUID() });
      service.sendJson(forgedTrust);
      await expectTypedError(service, forgedTrust.request.requestId as string);
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
      await expectTypedError(first, foreign.request.requestId as string);
      await expectStillServing(first, firstSession);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an oversized public request gives FRAME_LIMIT",
    async () => {
      const service = start();
      const sessionId = await service.handshake();
      const frame = request(sessionId, "getEnvironment");
      const body = JSON.stringify(frame);
      service.send(frameBytes(encoder.encode(" ".repeat(MIB + 1 - body.length) + body)));
      const response = await service.responseFor([null, frame.request.requestId as string]);
      expect(response.state).toBe("rejected");
      expect(response.code).toBe("FRAME_LIMIT");
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
    "a repeated requestId gives INVALID_REQUEST and starts nothing",
    async () => {
      const service = start();
      const sessionId = await service.handshake();
      const first = request(sessionId, "getEnvironment");
      service.sendJson(first);
      const firstResponse = await service.responseFor(first.request.requestId as string);
      expect(firstResponse.state).not.toBe("rejected");
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
