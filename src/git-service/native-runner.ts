// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import {
  ActivityReply,
  Base64,
  ConfirmReply,
  ConfirmRunReply,
  ExitReply,
  FileFactsReply,
  IdentityListReply,
  InputWrittenReply,
  LingeringCountReply,
  OutputReply,
  Refused,
  RegisterReply as RegisterReplySchema,
  ResolveGitReply,
  RevokeReply,
  StartedReply as StartedReplySchema,
} from "../contracts/channel";
import { INLINE_PROCESS_INPUT_BYTES, NATIVE_CHUNK_BYTES, UNACKNOWLEDGED_INPUT_CHUNKS } from "../contracts/limits";
import { isChannelPath, isIdentifier } from "../contracts/operations";
import {
  checkCall,
  checkContext,
  checkFileFacts,
  checkIdentityPaths,
  checkRegister,
  checkRelease,
  checkResolveGit,
  checkStarted,
  checkTrust,
  createDiagnosticCounter,
  RunnerRefusal,
  type FileFact,
  type FileFactsRequest,
  type GitExit,
  type GitRunner,
  type IdentityReply,
  type RegisterReply,
  type StartedReply,
  type TrustReply,
  type WalkStop,
} from "./git-runner";
import type { Frame, FrameKind, FrameWriter } from "./transport";

// Contract §6 "Channel frames": the service side of the `process`, `mutation`, and `trust` frames.

type Body = Record<string, unknown>;

const DEADLINE: WalkStop = { stop: "deadline" };
const CANCELED: WalkStop = { stop: "canceled" };

const isObject = (v: unknown): v is Body => typeof v === "object" && v !== null && !Array.isArray(v);
const ownershipFailed = () => new RunnerRefusal("PROCESS_OWNERSHIP_FAILED", "shell reply refused");
const invalid = (detail: string): never => {
  throw new RunnerRefusal("INVALID_REQUEST", detail);
};

// A decoded chunk holds 1 to 65,536 bytes. `fromBase64` accepts missing padding and white space, so the schema pattern checks first.
function decodeChunk(data: string): Uint8Array | undefined {
  if (!Base64.safeParse(data).success) return undefined;
  try {
    const bytes = Uint8Array.fromBase64(data);
    return bytes.length > 0 && bytes.length <= NATIVE_CHUNK_BYTES ? bytes : undefined;
  } catch {
    return undefined;
  }
}

// Contract §6 "File facts": `component` counts from 1 for a link and from 0, the root, for an error.
// Only `digest: true` gives `digest` or `bound`, and then each file has one of them.
function factFits(request: FileFactsRequest, fact: FileFact, components: number): boolean {
  if (fact.kind === "link") return fact.component >= 1 && fact.component <= components;
  if (fact.kind === "error") return fact.component <= components;
  if (fact.kind !== "file") return true;
  return request.digest ? fact.digest !== undefined || fact.bound !== undefined : fact.digest === undefined && fact.bound === undefined;
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
  // Contract §6 "Walks": an abort of `canceled.signal` sends `cancel` and resolves `canceled.value` at once. An aborted signal sends nothing.
  function ask<T>(kind: FrameKind, body: Body, parse: (reply: Body) => T | undefined, canceled?: { signal: AbortSignal; value: T }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (canceled?.signal.aborted) return resolve(canceled.value);
      const callId = crypto.randomUUID();
      const abort = () => {
        pending.delete(callId);
        resolve(canceled!.value);
        send(kind, { type: "cancel", callId });
      };
      pending.set(callId, {
        handle(replyKind, reply) {
          pending.delete(callId);
          canceled?.signal.removeEventListener("abort", abort);
          const refused = replyKind === kind ? Refused.safeParse(reply) : undefined;
          if (refused?.success) {
            reject(new RunnerRefusal(refused.data.code));
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
        return;
      }
      canceled?.signal.addEventListener("abort", abort, { once: true });
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
              const exit = ExitReply.safeParse(reply);
              if (!exit.success) {
                finish(ownershipFailed());
                return false;
              }
              if (broken) {
                finish(ownershipFailed());
                return true;
              }
              const { exitCode, activeDescendants, deadline } = exit.data;
              finish({ exitCode, activeDescendants, ...(deadline ? { deadline } : {}), ...(diagnostics.reached(call) ? { diagnosticLimit: true } : {}) });
              return true;
            }
            const refused = Refused.safeParse(reply);
            if (refused.success) {
              finish(broken ? ownershipFailed() : new RunnerRefusal(refused.data.code));
              return true;
            }
            if (broken) return true;
            const output = OutputReply.safeParse(reply);
            if (output.success) {
              const bytes = decodeChunk(output.data.data);
              if (!bytes) return malformed();
              if (output.data.stream === "stdout") {
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
            const activity = ActivityReply.safeParse(reply);
            if (activity.success && call.limits.stallMs !== undefined) {
              call.onActivity?.(activity.data.state);
              return true;
            }
            if (unacknowledged > 0 && InputWrittenReply.safeParse(reply).success) {
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

    async identities(operationId, context, paths, signal) {
      if (!isIdentifier(operationId) || !checkContext(context)) invalid("identity context");
      checkIdentityPaths(paths);
      const body = { type: "identity", operationId, ...context, paths: [...paths] };
      const parse = (r: Body): IdentityReply[] | WalkStop | undefined => {
        const reply = IdentityListReply.safeParse(r);
        if (!reply.success) return undefined;
        if ("deadline" in reply.data) return DEADLINE;
        return reply.data.identities.length === paths.length ? reply.data.identities : undefined;
      };
      return ask("process", body, parse, { signal, value: CANCELED });
    },

    async fileFacts(request, signal) {
      checkFileFacts(request);
      const { operationId, contextKind, gitInstallationId, repositoryId, digest, files } = request;
      const body = { type: "fileFacts", operationId, contextKind, gitInstallationId, repositoryId, digest, files: files.map(({ root, path }) => ({ root, path: [...path] })) };
      const parse = (r: Body): FileFact[] | WalkStop | undefined => {
        const reply = FileFactsReply.safeParse(r);
        if (!reply.success) return undefined;
        if ("deadline" in reply.data) return DEADLINE;
        return reply.data.facts.length === files.length && reply.data.facts.every((fact, i) => factFits(request, fact, files[i]!.path.length)) ? reply.data.facts : undefined;
      };
      return ask("process", body, parse, { signal, value: CANCELED });
    },

    async lingeringCount(operationId, commonDirectory) {
      if (!isIdentifier(operationId) || !isChannelPath(commonDirectory)) invalid("lingering count");
      return ask<number>("process", { type: "lingeringCount", operationId, commonDirectory }, (r) => LingeringCountReply.safeParse(r).data?.count);
    },

    async register(request) {
      const confirm = checkRegister(request);
      return ask<RegisterReply>("process", { type: "register", ...request }, (r) => {
        const reply = RegisterReplySchema.safeParse(r);
        if (!reply.success) return undefined;
        // Contract §6 "Process replies": only a Git registration with `confirm: true` gets another result.
        const data = reply.data;
        if (data.result === "approved") return { result: "approved" };
        if (!confirm) return undefined;
        return "bootstrapId" in data ? { result: "another", bootstrapId: data.bootstrapId, executablePath: data.executablePath } : { result: "declined" };
      });
    },

    async resolveGit(request) {
      checkResolveGit(request);
      return ask<{ bootstrapId: string }>("process", { type: "resolveGit", ...request }, (r) => {
        const reply = ResolveGitReply.safeParse(r);
        return reply.success ? { bootstrapId: reply.data.bootstrapId } : undefined;
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
        const reply = StartedReplySchema.safeParse(r);
        if (!reply.success) return undefined;
        const { type: _type, callId: _callId, ...parsed } = reply.data;
        return parsed;
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
      return ask<TrustReply>("trust", { ...request }, (r): TrustReply | undefined => {
        if (request.type === "revoke") {
          const reply = RevokeReply.safeParse(r);
          return reply.success ? { endedProcesses: reply.data.endedProcesses } : undefined;
        }
        if (request.type === "confirmRun") {
          const reply = ConfirmRunReply.safeParse(r);
          if (!reply.success) return undefined;
          return reply.data.result === "approved" ? { result: "approved" } : { result: "declined" };
        }
        const reply = ConfirmReply.safeParse(r);
        if (!reply.success) return undefined;
        if (reply.data.result === "declined") return { result: "declined" };
        if (!reply.data.stored) return { result: "approved", stored: false };
        // Contract §7 "Trust approval store": with `persist: false`, the shell writes no record.
        return request.persist ? { result: "approved", stored: true, record: reply.data.record } : undefined;
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
