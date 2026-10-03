// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { INLINE_PROCESS_INPUT_BYTES, NATIVE_CHUNK_BYTES, PROCESS_EXIT_CODE_MAX, UNACKNOWLEDGED_INPUT_CHUNKS } from "../contracts/limits";
import { isIdentifier } from "../contracts/operations";
import {
  checkCall,
  checkContext,
  checkIdentityPaths,
  checkRegister,
  checkRelease,
  checkStarted,
  checkTrust,
  createDiagnosticCounter,
  exact,
  isChannelPath,
  isCount,
  isObject,
  oneOf,
  REFUSED_CODES,
  RunnerRefusal,
  type GitExit,
  type GitRunner,
  type IdentityReply,
  type RefusedCode,
  type RegisterReply,
  type StartedReply,
  type TrustRecord,
  type TrustReply,
} from "./git-runner";
import { isTrustRecord } from "./session";
import type { Frame, FrameKind, FrameWriter } from "./transport";

// Contract §6 "Channel frames": the service side of the `process`, `mutation`, and `trust` frames.

type Body = Record<string, unknown>;

const isHex = (digits: number) => (v: unknown) => typeof v === "string" && v.length === digits && /^[0-9a-f]+$/.test(v);
const head = { type: (v: unknown) => typeof v === "string", callId: isIdentifier };
const refusedFields = { ...head, code: oneOf(...REFUSED_CODES) };
const isIdentity = (v: unknown) => exact(v, { volumeSerial: isHex(16), fileId: isHex(32) }) || exact(v, { code: oneOf("UNSUPPORTED_REPOSITORY") });
const exitFields = {
  ...head,
  exitCode: (v: unknown) => v === null || (isCount(v) && (v as number) <= PROCESS_EXIT_CODE_MAX),
  activeDescendants: isCount,
  deadline: oneOf("deadline", "inactivity", "ceiling"),
};
const outputFields = { ...head, stream: oneOf("stdout", "stderr"), data: (v: unknown) => typeof v === "string" };

const ownershipFailed = () => new RunnerRefusal("PROCESS_OWNERSHIP_FAILED", "shell reply refused");
const invalid = (detail: string): never => {
  throw new RunnerRefusal("INVALID_REQUEST", detail);
};

// Standard base64 with padding, 1 to 65,536 decoded bytes. `fromBase64` accepts missing padding and white space.
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
function decodeChunk(data: unknown): Uint8Array | undefined {
  if (typeof data !== "string" || !BASE64.test(data)) return undefined;
  try {
    const bytes = Uint8Array.fromBase64(data);
    return bytes.length > 0 && bytes.length <= NATIVE_CHUNK_BYTES ? bytes : undefined;
  } catch {
    return undefined;
  }
}

interface Pending {
  // Returns false for a reply that breaks its shape. The session then sends a `public` rejection (contract §6 "Errors").
  handle(kind: FrameKind, reply: Body): boolean;
}

export function createNativeRunner(writer: FrameWriter): GitRunner & { receive(frame: Frame): boolean } {
  const pending = new Map<string, Pending>();
  const diagnostics = createDiagnosticCounter();

  const send = (kind: FrameKind, body: Body) => writer.write({ kind, [kind]: body });

  // A request other than `run`. A malformed reply fails the call at once.
  function ask<T>(kind: FrameKind, body: Body, parse: (reply: Body) => T | undefined): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const callId = crypto.randomUUID();
      pending.set(callId, {
        handle(replyKind, reply) {
          pending.delete(callId);
          if (replyKind === kind && reply.type === "refused" && exact(reply, refusedFields)) {
            reject(new RunnerRefusal(reply.code as RefusedCode));
            return true;
          }
          const value = replyKind === kind && reply.type === body.type ? parse(reply) : undefined;
          if (value === undefined) {
            reject(ownershipFailed());
            return false;
          }
          resolve(value);
          return true;
        },
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
      const input = call.input?.length ? call.input : undefined;
      const streamed = input && input.length > INLINE_PROCESS_INPUT_BYTES ? input : undefined;
      let sentBytes = 0;
      let unacknowledged = 0;
      let canceled = false;
      let broken = false;
      const cancel = () => {
        if (canceled) return;
        canceled = true;
        send("process", { type: "cancel", callId });
      };
      // Contract §6 "Streamed input": at most 8 chunks of one call wait for `inputWritten`.
      const pump = () => {
        while (streamed && !canceled && unacknowledged < UNACKNOWLEDGED_INPUT_CHUNKS && sentBytes < streamed.length) {
          const chunk = streamed.subarray(sentBytes, sentBytes + NATIVE_CHUNK_BYTES);
          send("process", { type: "input", callId, data: chunk.toBase64() });
          sentBytes += chunk.length;
          unacknowledged++;
        }
      };

      return new Promise<GitExit>((resolve, reject) => {
        const finish = (outcome: GitExit | Error) => {
          pending.delete(callId);
          call.signal.removeEventListener("abort", cancel);
          if (outcome instanceof Error) reject(outcome);
          else resolve(outcome);
        };
        // Contract §6 "Errors": the service sends `cancel`, ignores later output, and fails the call at the `exit`.
        const malformed = () => {
          broken = true;
          cancel();
          return false;
        };
        pending.set(callId, {
          handle(kind, reply) {
            if (kind !== "process") return malformed();
            if (reply.type === "exit") {
              if (!exact(reply, exitFields, ["deadline"])) {
                finish(ownershipFailed());
                return false;
              }
              if (broken) {
                finish(ownershipFailed());
                return true;
              }
              const { exitCode, activeDescendants, deadline } = reply as unknown as GitExit;
              finish({ exitCode, activeDescendants, ...(deadline ? { deadline } : {}), ...(diagnostics.reached(call) ? { diagnosticLimit: true } : {}) });
              return true;
            }
            if (reply.type === "refused" && exact(reply, refusedFields)) {
              finish(broken ? ownershipFailed() : new RunnerRefusal(reply.code as RefusedCode));
              return true;
            }
            if (broken) return true;
            if (reply.type === "output" && exact(reply, outputFields)) {
              const bytes = decodeChunk(reply.data);
              if (!bytes) return malformed();
              if (reply.stream === "stdout") {
                call.stdout.push(bytes);
                // Contract §6 "Byte caps": a stream above its result bound gets `cancel`.
                if (call.stdout.limited) cancel();
              } else {
                call.stderr.push(bytes);
                if (diagnostics.add(call, bytes.length)) cancel();
              }
              return true;
            }
            // Only a call with `stallMs` gets `activity`.
            if (reply.type === "activity" && call.limits.stallMs !== undefined && exact(reply, { ...head, state: oneOf("stalled", "active") })) {
              call.onActivity?.(reply.state as "stalled" | "active");
              return true;
            }
            if (reply.type === "inputWritten" && unacknowledged > 0 && exact(reply, head)) {
              unacknowledged--;
              pump();
              return true;
            }
            return malformed();
          },
        });
        call.signal.addEventListener("abort", cancel, { once: true });
        const { context, operationId, environmentPolicy, transaction, limits } = call;
        try {
          send("process", {
            type: "run",
            callId,
            operationId,
            ...context,
            arguments: [...call.arguments],
            ...(streamed ? { inputBytes: streamed.length } : input ? { input: input.toBase64() } : {}),
            environmentPolicy,
            ...(transaction ? { transactionId: transaction.transactionId, indexFile: transaction.indexFile } : {}),
            limits: { ...limits },
          });
          pump();
        } catch (error) {
          finish(error as Error);
        }
      });
    },

    async identities(operationId, context, paths) {
      if (!isIdentifier(operationId) || !checkContext(context)) invalid("identity context");
      checkIdentityPaths(paths);
      return ask<IdentityReply[]>("process", { type: "identity", operationId, ...context, paths: [...paths] }, (r) =>
        exact(r, { ...head, identities: (v) => Array.isArray(v) && v.length === paths.length && v.every(isIdentity) })
          ? (r.identities as IdentityReply[])
          : undefined,
      );
    },

    async lingeringCount(operationId, commonDirectory) {
      if (!isIdentifier(operationId) || !isChannelPath(commonDirectory)) invalid("lingering count");
      return ask<number>("process", { type: "lingeringCount", operationId, commonDirectory }, (r) =>
        exact(r, { ...head, count: isCount }) ? (r.count as number) : undefined,
      );
    },

    async register(request) {
      const confirm = checkRegister(request);
      return ask<RegisterReply>("process", { type: "register", ...request }, (r) => {
        if (exact(r, { ...head, result: oneOf("approved") })) return { result: "approved" };
        // Contract §6 "Process replies": only a Git registration with `confirm: true` gets another result.
        if (!confirm) return undefined;
        if (exact(r, { ...head, result: oneOf("declined") })) return { result: "declined" };
        if (exact(r, { ...head, result: oneOf("another"), bootstrapId: isIdentifier, executablePath: isChannelPath })) {
          return { result: "another", bootstrapId: r.bootstrapId as string, executablePath: r.executablePath as string };
        }
        return undefined;
      });
    },

    release(target) {
      checkRelease(target);
      send("process", { type: "release", ...target });
    },

    closeJob(operationId) {
      if (!isIdentifier(operationId)) invalid("closeJob");
      send("process", { type: "closeJob", operationId });
      diagnostics.clear(operationId);
    },

    async started(frame) {
      checkStarted(frame);
      return ask<StartedReply>("mutation", { type: "started", ...frame }, (r) => {
        if (exact(r, { ...head, markerId: isIdentifier })) return { markerId: r.markerId as string };
        if (exact(r, { ...head, busy: oneOf(true) })) return { busy: true };
        if (exact(r, { ...head, failure: oneOf("disk-full", "access-denied", "other"), folder: isChannelPath })) {
          return { failure: r.failure, folder: r.folder } as StartedReply;
        }
        return undefined;
      });
    },

    ended(operationId, endProcesses) {
      if (!isIdentifier(operationId) || typeof endProcesses !== "boolean") invalid("ended");
      send("mutation", { type: "ended", operationId, endProcesses });
      diagnostics.clear(operationId);
    },

    resolved(markerId) {
      if (!isIdentifier(markerId)) invalid("resolved");
      send("mutation", { type: "resolved", markerId });
    },

    async trust(request) {
      checkTrust(request);
      return ask<TrustReply>("trust", { ...request }, (r) => {
        if (request.type === "revoke") return exact(r, { ...head, endedProcesses: isCount }) ? { endedProcesses: r.endedProcesses as number } : undefined;
        if (exact(r, { ...head, result: oneOf("declined") })) return { result: "declined" };
        if (request.type === "confirmRun") return exact(r, { ...head, result: oneOf("approved") }) ? { result: "approved" } : undefined;
        if (exact(r, { ...head, result: oneOf("approved"), stored: oneOf(false) })) return { result: "approved", stored: false };
        // Contract §7 "Trust approval store": with `persist: false`, the shell writes no record.
        if (request.persist && exact(r, { ...head, result: oneOf("approved"), stored: oneOf(true), record: isTrustRecord })) {
          return { result: "approved", stored: true, record: r.record as TrustRecord };
        }
        return undefined;
      });
    },

    // Returns false for a frame that breaks the reply shape. A reply without a pending call is dropped.
    receive(frame) {
      const body = frame[frame.kind];
      if (Object.keys(frame).length !== 2 || !isObject(body) || !isIdentifier(body.callId)) return false;
      const call = pending.get(body.callId);
      return call ? call.handle(frame.kind, body) : true;
    },
  };
}
