// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { printOrigin } from "../origin";
import * as bridgeModule from "../../src/frontend/bridge";
import { validateRequest } from "../../src/contracts/envelope";
import { OPERATIONS } from "../../src/contracts/operations";

printOrigin("../../src/frontend/bridge.ts", import.meta.dir);
printOrigin("../../src/contracts/envelope.ts", import.meta.dir);
printOrigin("../../src/contracts/operations.ts", import.meta.dir);

const { createBridge } = bridgeModule;
type Bridge = ReturnType<typeof createBridge>;
type Envelope = Record<string, unknown>;
type Handler = (event: { payload: unknown }) => void;

const id = () => crypto.randomUUID();

// `src-tauri/build.rs` is the source of the command names.
const COMMANDS = [...readFileSync(new URL("../../src-tauri/build.rs", import.meta.url), "utf8").matchAll(/^\s+"([a-z_]+)",$/gm)].map((m) => m[1]);
const commandOf = (operation: string) => operation.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const repo = () => ({ repositoryId: id() });
const gen = () => ({ repositoryId: id(), repositoryGeneration: 0 });
const SAMPLE_CALLS: Record<string, (b: Bridge) => Promise<unknown>> = {
  getEnvironment: (b) => b.getEnvironment(),
  chooseGit: (b) => b.chooseGit(),
  chooseRepository: (b) => b.chooseRepository(),
  restoreWorkspace: (b) => b.restoreWorkspace(),
  readWorkspace: (b) => b.readWorkspace(repo(), { refresh: false, check: "full" }),
  readHistory: (b) => b.readHistory(gen()),
  readComparison: (b) => b.readComparison({ ...gen(), selectionId: id() }, { snapshotId: id(), entryId: id() }),
  readTrust: (b) => b.readTrust(repo()),
  approveTrust: (b) => b.approveTrust(gen(), { fingerprint: "a".repeat(64), approve: true }),
  revokeTrust: (b) => b.revokeTrust(repo(), { trustId: id() }),
  applyHunk: (b) => b.applyHunk(gen(), { comparisonId: id(), hunkId: id(), snapshotId: id(), direction: "stage" }),
  applyFile: (b) => b.applyFile(gen(), { comparisonId: id(), snapshotId: id(), direction: "unstage" }),
  reviewCommit: (b) => b.reviewCommit(gen(), { snapshotId: id() }),
  commit: (b) => b.commit(gen(), { reviewToken: id(), message: "m", confirmFullScope: true }),
  reviewSubmodules: (b) => b.reviewSubmodules(gen(), { snapshotId: id() }),
  updateSubmodules: (b) => b.updateSubmodules(gen(), { submoduleReviewToken: id(), start: true }),
  cancel: (b) => b.cancel({ operationId: id() }),
  getOperation: (b) => b.getOperation({ operationId: id() }),
  requestClose: (b) => b.requestClose({ choice: "stay" }),
  currentSession: (b) => b.currentSession(),
  dismissRecoveryMarker: (b) => b.dismissRecoveryMarker({ markerId: id() }),
};

interface Options {
  // Return undefined to keep the request without a response.
  answer?: (command: string, request: Envelope) => unknown;
  reject?: (command: string) => boolean;
}

function harness(options: Options = {}) {
  let sessionId = id();
  const calls: { command: string; request: Envelope }[] = [];
  const listens: string[] = [];
  const handlers = new Map<string, Handler>();
  let unlistens = 0;

  const invoke = (command: string, args?: unknown): Promise<unknown> => {
    const request = (args as { request: Envelope }).request;
    calls.push({ command, request });
    if (options.reject?.(command)) return Promise.reject(new Error(`command ${command} not found`));
    if (command === "current_session") return Promise.resolve({ requestId: request.requestId, state: "succeeded", result: { sessionId } });
    const answer = options.answer ? options.answer(command, request) : defaultAnswer(request);
    return answer === undefined ? new Promise(() => {}) : Promise.resolve(answer);
  };
  const defaultAnswer = (request: Envelope) =>
    request.sessionId === sessionId
      ? { requestId: request.requestId, operationId: id(), state: "succeeded", result: {} }
      : { requestId: request.requestId, state: "rejected", code: "UNKNOWN_TARGET" };
  const listen = (event: string, handler: Handler) => {
    listens.push(event);
    handlers.set(event, handler);
    return Promise.resolve(() => {
      unlistens++;
    });
  };

  const bridge = createBridge(invoke, listen);
  return {
    bridge,
    calls,
    listens,
    unlistens: () => unlistens,
    emit: (event: string, payload: unknown = {}) => handlers.get(event)?.({ payload }),
    newSession: () => (sessionId = id()),
    session: () => sessionId,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("frontend bridge", () => {
  test("the command list in build.rs covers each operation", () => {
    expect(COMMANDS.toSorted()).toEqual(OPERATIONS.map(commandOf).toSorted());
  });

  test("at load, the bridge calls currentSession without a sessionId", async () => {
    const h = harness();
    await settle();
    expect(h.calls.map((c) => c.command)).toEqual(["current_session"]);
    const request = h.calls[0].request;
    expect(Object.hasOwn(request, "sessionId")).toBe(false);
    expect(validateRequest(request, "renderer").ok).toBe(true);
  });

  test("each operation function sends a valid envelope to its snake_case command", async () => {
    const h = harness();
    for (const operation of OPERATIONS) {
      const before = h.calls.length;
      const response = (await SAMPLE_CALLS[operation](h.bridge)) as { state: string };
      expect(response.state).toBe("succeeded");
      const call = h.calls.at(-1)!;
      expect(h.calls.length).toBe(before + 1);
      expect(call.command).toBe(commandOf(operation));
      expect(COMMANDS).toContain(call.command);
      expect(call.request.operation).toBe(operation);
      const checked = validateRequest(call.request, "renderer");
      expect(checked.ok ? "ok" : checked.code).toBe("ok");
      if (operation === "currentSession") expect(Object.hasOwn(call.request, "sessionId")).toBe(false);
      else expect(call.request.sessionId).toBe(h.session());
    }
    const requestIds = h.calls.map((c) => c.request.requestId);
    expect(new Set(requestIds).size).toBe(requestIds.length);
  });

  test("a service-session event refreshes the session without a reload", async () => {
    const h = harness();
    await settle();
    const first = h.session();
    expect(((await h.bridge.getEnvironment()) as { state: string }).state).toBe("succeeded");
    expect(h.calls.at(-1)!.request.sessionId).toBe(first);

    const second = h.newSession();
    h.emit("service-session");
    const response = (await h.bridge.getEnvironment()) as { state: string };
    const commands = h.calls.map((c) => c.command);
    expect(commands.filter((c) => c === "current_session").length).toBe(2);
    expect(h.calls.at(-1)!.request.sessionId).toBe(second);
    expect(response.state).toBe("succeeded");
  });

  test("a service-stopped event gives State unknown to each request without a terminal response", async () => {
    const h = harness({
      answer: (command, request) => (command === "get_operation" ? { requestId: request.requestId, state: "succeeded", result: {} } : undefined),
    });
    const pendingCommit = h.bridge.commit(gen(), { reviewToken: id(), message: "m", confirmFullScope: true });
    const pendingRead = h.bridge.readHistory(gen());
    const done = await h.bridge.getOperation({ operationId: id() });
    expect((done as { state: string }).state).toBe("succeeded");
    await settle();

    h.emit("service-stopped", { markers: [] });
    const [commit, read] = (await Promise.all([pendingCommit, pendingRead])) as { requestId: string; state: string; code?: string; operationId?: string }[];
    for (const response of [commit, read]) {
      expect(response.state).toBe("unknown");
      expect(response.code).toBe("STATE_UNKNOWN");
    }
    const sent = h.calls.filter((c) => c.command === "commit" || c.command === "read_history").map((c) => c.request.requestId as string);
    expect([commit.requestId, read.requestId]).toEqual(sent);
  });

  test("a rejected invoke gives a rejected SERVICE_UNAVAILABLE result without operationId", async () => {
    const noSession = harness({ reject: () => true });
    const first = (await noSession.bridge.getEnvironment()) as Record<string, unknown>;
    expect(first.state).toBe("rejected");
    expect(first.code).toBe("SERVICE_UNAVAILABLE");
    expect(Object.hasOwn(first, "operationId")).toBe(false);
    const session = (await noSession.bridge.currentSession()) as Record<string, unknown>;
    expect(session.state).toBe("rejected");
    expect(session.code).toBe("SERVICE_UNAVAILABLE");

    const denied = harness({ reject: (command) => command === "commit" });
    const commit = (await denied.bridge.commit(gen(), { reviewToken: id(), message: "m", confirmFullScope: true })) as Record<string, unknown>;
    expect(commit.state).toBe("rejected");
    expect(commit.code).toBe("SERVICE_UNAVAILABLE");
    expect(Object.hasOwn(commit, "operationId")).toBe(false);
    expect(denied.calls.at(-1)!.command).toBe("commit");
  });

  test("the bridge subscribes to each shell event once and never unlistens", async () => {
    const h = harness();
    await h.bridge.getEnvironment();
    h.emit("service-session");
    await h.bridge.getEnvironment();
    expect(h.listens.toSorted()).toEqual(["service-session", "service-stopped"]);
    expect(h.unlistens()).toBe(0);
  });

  test("the bridge exports no generic invoke function", () => {
    expect(Object.keys(bridgeModule)).toEqual(["createBridge"]);
    const h = harness();
    expect(Object.keys(h.bridge).toSorted()).toEqual([...OPERATIONS].toSorted());
  });
});
