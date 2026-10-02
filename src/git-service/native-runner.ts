// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { NATIVE_CHUNK_BYTES } from "../contracts/limits";
import { isIdentifier } from "../contracts/operations";
import {
  checkCall,
  checkIdentityPaths,
  RunnerRefusal,
  type GitExit,
  type GitRunner,
  type IdentityReply,
  type StartedReply,
  type TrustReply,
} from "./git-runner";
import type { Frame, FrameKind, FrameWriter } from "./transport";

// Contract §6 and §7 give the request fields but no frame body shape. Each request body holds `type` and a service-issued `callId`. Each shell reply repeats both.

type Reply = Record<string, unknown>;
type Check = (value: unknown) => boolean;

const isCount: Check = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isHex = (digits: number): Check => (v) => typeof v === "string" && v.length === digits && /^[0-9a-f]+$/.test(v);
const oneOf =
  (...allowed: unknown[]): Check =>
  (v) =>
    allowed.includes(v);
const isObject = (v: unknown): v is Reply => typeof v === "object" && v !== null && !Array.isArray(v);

// `optional` names the fields that a reply can omit.
function exact(reply: Reply, fields: Record<string, Check>, optional: string[] = []): boolean {
  const keys = Object.keys(reply);
  if (keys.some((k) => !Object.hasOwn(fields, k))) return false;
  return Object.entries(fields).every(([k, check]) => (Object.hasOwn(reply, k) ? check(reply[k]) : optional.includes(k)));
}

const head = { type: (v: unknown) => typeof v === "string", callId: isIdentifier };
const isIdentity: Check = (v) =>
  isObject(v) && (exact(v, { volumeSerial: isHex(16), fileId: isHex(32) }) || exact(v, { code: (c) => typeof c === "string" }));

function decodeChunk(data: unknown): Uint8Array | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const bytes = Uint8Array.fromBase64(data);
    return bytes.length > 0 && bytes.length <= NATIVE_CHUNK_BYTES ? bytes : undefined;
  } catch {
    return undefined;
  }
}

interface Pending {
  kind: FrameKind;
  // Returns false for a reply that breaks its shape.
  handle(reply: Reply): boolean;
  fail(error: Error): void;
}

export function createNativeRunner(writer: FrameWriter): GitRunner & { receive(frame: Frame): boolean } {
  const pending = new Map<string, Pending>();

  const send = (kind: FrameKind, body: Reply) => writer.write({ kind, [kind]: body });

  function ask<T>(kind: FrameKind, body: Reply, parse: (reply: Reply) => T | undefined): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const callId = crypto.randomUUID();
      pending.set(callId, {
        kind,
        handle(reply) {
          const value = reply.type === body.type ? parse(reply) : undefined;
          if (value === undefined) return false;
          pending.delete(callId);
          resolve(value);
          return true;
        },
        fail: reject,
      });
      try {
        send(kind, { ...body, callId });
      } catch (error) {
        pending.delete(callId);
        reject(error);
      }
    });
  }

  return {
    async run(call) {
      checkCall(call);
      call.signal.throwIfAborted();
      const callId = crypto.randomUUID();
      const onAbort = () => send("process", { type: "cancel", callId });
      const exit = new Promise<GitExit>((resolve, reject) => {
        const done = () => {
          pending.delete(callId);
          call.signal.removeEventListener("abort", onAbort);
        };
        pending.set(callId, {
          kind: "process",
          handle(reply) {
            if (reply.type === "output" && exact(reply, { ...head, stream: oneOf("stdout", "stderr"), data: (v) => typeof v === "string" })) {
              const bytes = decodeChunk(reply.data);
              if (!bytes) return false;
              (reply.stream === "stdout" ? call.stdout : call.stderr).push(bytes);
              return true;
            }
            if (reply.type === "activity" && exact(reply, { ...head, state: oneOf("stalled", "active") })) {
              call.onActivity?.(reply.state as "stalled" | "active");
              return true;
            }
            const exitFields = {
              ...head,
              exitCode: (v: unknown) => v === null || (typeof v === "number" && Number.isSafeInteger(v)),
              activeDescendants: isCount,
              deadline: oneOf("deadline", "inactivity", "ceiling"),
            };
            if (reply.type === "exit" && exact(reply, exitFields, ["deadline"])) {
              done();
              const { exitCode, activeDescendants, deadline } = reply as unknown as GitExit;
              resolve({ exitCode, activeDescendants, ...(deadline ? { deadline } : {}) });
              return true;
            }
            return false;
          },
          fail(error) {
            done();
            reject(error);
          },
        });
      });
      call.signal.addEventListener("abort", onAbort, { once: true });
      const { context, operationId, environmentPolicy, transactionId, limits } = call;
      try {
        send("process", {
          type: "run",
          callId,
          operationId,
          ...context,
          arguments: [...call.arguments],
          ...(call.input ? { input: call.input.toBase64() } : {}),
          environmentPolicy,
          ...(transactionId ? { transactionId } : {}),
          limits,
        });
      } catch (error) {
        pending.get(callId)?.fail(error as Error);
      }
      return exit;
    },

    async identities(operationId, context, paths) {
      checkIdentityPaths(paths);
      return ask<IdentityReply[]>("process", { type: "identity", operationId, ...context, paths: [...paths] }, (r) =>
        exact(r, { ...head, identities: (v) => Array.isArray(v) && v.length === paths.length && v.every(isIdentity) })
          ? (r.identities as IdentityReply[])
          : undefined,
      );
    },

    lingeringCount(operationId, commonDirectory) {
      return ask<number>("process", { type: "lingeringCount", operationId, commonDirectory }, (r) =>
        exact(r, { ...head, count: isCount }) ? (r.count as number) : undefined,
      );
    },

    started(frame) {
      return ask<StartedReply>("mutation", { type: "started", ...frame }, (r) => {
        if (exact(r, { ...head, markerId: isIdentifier })) return { markerId: r.markerId as string };
        if (exact(r, { ...head, busy: oneOf(true) })) return { busy: true };
        if (exact(r, { ...head, failure: oneOf("disk-full", "access-denied", "other") })) return { failure: r.failure as "disk-full" | "access-denied" | "other" };
        return undefined;
      });
    },

    ended(operationId, endProcesses) {
      send("mutation", { type: "ended", operationId, endProcesses });
    },

    resolved(markerId) {
      send("mutation", { type: "resolved", markerId });
    },

    trust(request) {
      return ask<TrustReply>("trust", { ...request }, (r) => {
        if (request.type === "revoke") return exact(r, { ...head, endedProcesses: isCount }) ? { endedProcesses: r.endedProcesses as number } : undefined;
        return exact(r, { ...head, result: oneOf("approved", "declined") }) ? { result: r.result as "approved" | "declined" } : undefined;
      });
    },

    // Returns false for a frame that breaks the reply shape. A reply without a pending call is dropped.
    receive(frame) {
      const body = frame[frame.kind];
      if (Object.keys(frame).length !== 2 || !isObject(body) || !isIdentifier(body.callId)) return false;
      const call = pending.get(body.callId);
      if (!call) return true;
      if (call.kind !== frame.kind || !call.handle(body)) {
        call.fail(new RunnerRefusal("shell reply refused"));
        pending.delete(body.callId);
        return false;
      }
      return true;
    },
  };
}
