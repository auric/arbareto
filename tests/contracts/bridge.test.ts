// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { printOrigin } from "../origin";
import * as bridgeModule from "../../src/frontend/bridge";
import { validateRequest } from "../../src/contracts/envelope";
import { OPERATIONS } from "../../src/contracts/operations";

// `@tauri-apps/api` reads `window` only when a function runs, so this assignment comes in time.
(globalThis as { window?: unknown }).window ??= globalThis;

printOrigin("../../src/frontend/bridge.ts", import.meta.dir);
printOrigin("../../src/contracts/envelope.ts", import.meta.dir);
printOrigin("../../src/contracts/operations.ts", import.meta.dir);

const { createBridge } = bridgeModule;
type Bridge = ReturnType<typeof createBridge>;
type Envelope = Record<string, unknown>;
type Invoke = (command: string, args: unknown, options?: unknown) => Promise<unknown>;

const id = () => crypto.randomUUID();
const utf8 = new TextDecoder("utf-8", { fatal: true });

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
  listRecentRepositories: (b) => b.listRecentRepositories(),
  openRecentRepository: (b) => b.openRecentRepository({ entryId: id() }),
  removeRecentRepository: (b) => b.removeRecentRepository({ entryId: id() }),
  readWorkspace: (b) => b.readWorkspace(repo(), { refresh: false, check: "full" }),
  readEntries: (b) => b.readEntries(gen(), { snapshotId: id(), cursor: id() }),
  openHistory: (b) => b.openHistory(gen(), { scope: "all" }),
  loadHistory: (b) => b.loadHistory(repo(), { viewId: id(), need: { row: 0 } }),
  readHistoryRows: (b) => b.readHistoryRows(repo(), { viewId: id(), mode: "full", at: { row: 0 }, count: 1, text: "none" }),
  searchHistory: (b) => b.searchHistory(repo(), { viewId: id(), text: "fix" }),
  closeHistory: (b) => b.closeHistory(repo(), { viewId: id() }),
  readRefs: (b) => b.readRefs(gen()),
  readComparison: (b) => b.readComparison({ ...gen(), selectionId: id() }, { snapshotId: id(), entryId: id() }),
  readTrust: (b) => b.readTrust(repo()),
  approveTrust: (b) => b.approveTrust(repo(), { action: "commit" }),
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
  readTracking: (b) => b.readTracking(gen()),
  reviewSync: (b) => b.reviewSync(gen(), { action: "push", destination: { remote: "origin", branch: "main", setUpstream: true } }),
  sync: (b) => b.sync(repo(), { syncReviewToken: id(), start: true }),
  clone: (b) => b.clone({ url: "https://example.test/team/tool.git", destination: "//host/src/tool", keyFile: "none" }),
  connectInTerminal: (b) => b.connectInTerminal(repo(), { operationId: id() }),
  readSyncSettings: (b) => b.readSyncSettings(),
  setSshClient: (b) => b.setSshClient({ kind: "plink" }),
  setDefaultPullAction: (b) => b.setDefaultPullAction({ action: "pull-rebase" }),
  chooseSyncPath: (b) => b.chooseSyncPath({ target: "remoteKey", worktreeKey: "a".repeat(64), remote: "origin" }),
  clearSyncPath: (b) => b.clearSyncPath({ target: "plink" }),
  launchPuttygen: (b) => b.launchPuttygen(),
  // Feature 004 contract Δ1.
  readBranches: (b) => b.readBranches(gen()),
  readWorktrees: (b) => b.readWorktrees(gen()),
  readGitSettings: (b) => b.readGitSettings(repo()),
  reviewWorkbench: (b) => b.reviewWorkbench(gen(), { action: "worktree-prune" }),
  runWorkbench: (b) => b.runWorkbench(repo(), { workbenchToken: id(), start: true }),
  applyFiles: (b) => b.applyFiles(repo(), { snapshotId: id(), entryIds: [id()], direction: "stage", kind: "selected" }),
  openWorktree: (b) => b.openWorktree({ repositoryId: id(), path: "/home/u/repo-wt" }),
  revealPath: (b) => b.revealPath({ repositoryId: id(), entryId: id() }),
  setSwitchChoice: (b) => b.setSwitchChoice({ choice: "stash" }),
  chooseWorktreeFolder: (b) => b.chooseWorktreeFolder({ repositoryId: id() }),
  // Feature 006 contract Δ1.
  listDictionaries: (b) => b.listDictionaries(),
  readDictionary: (b) => b.readDictionary({ language: "uk", file: "index.dic", offset: 1_048_576 }),
  downloadDictionary: (b) => b.downloadDictionary({ language: "uk" }),
  importDictionary: (b) => b.importDictionary({ language: "uk" }),
  removeDictionary: (b) => b.removeDictionary({ language: "uk" }),
  setSpelling: (b) => b.setSpelling({ enabled: false, languages: ["en", "uk"] }),
  openLicenceLink: (b) => b.openLicenceLink({ language: "en" }),
};

// tasks.md T389. `tsc` checks this function. It never runs. A target variable with a key outside the contract must not compile.
function extraTargetKeys(b: Bridge) {
  const withGeneration = { ...gen(), extra: 1 };
  const withRepository = { ...repo(), extra: 1 };
  // @ts-expect-error The `extra` key is outside the `readBranches` target.
  void b.readBranches(withGeneration);
  // @ts-expect-error The `extra` key is outside the `readWorktrees` target.
  void b.readWorktrees(withGeneration);
  // @ts-expect-error The `extra` key is outside the `readGitSettings` target.
  void b.readGitSettings(withRepository);
  // @ts-expect-error The `extra` key is outside the `reviewWorkbench` target.
  void b.reviewWorkbench(withGeneration, { action: "worktree-prune" });
  // @ts-expect-error The `extra` key is outside the `runWorkbench` target.
  void b.runWorkbench(withRepository, { workbenchToken: id(), start: true });
  // @ts-expect-error The `extra` key is outside the `applyFiles` target.
  void b.applyFiles(withRepository, { snapshotId: id(), entryIds: [id()], direction: "stage", kind: "selected" });
}

interface Options {
  // Return undefined to keep the request without a response.
  answer?: (command: string, request: Envelope) => unknown;
  reject?: (command: string) => boolean;
  // Replaces the result of an event subscription.
  listen?: (event: string) => Promise<unknown>;
  onSessionChange?: () => void;
  onTextScale?: (value: unknown) => void;
}

// `mockIPC` answers each command. A spy on the mocked internals records the event subscriptions of the bridge.
function harness(options: Options = {}) {
  let sessionId = id();
  const calls: { command: string; request: Envelope; body: Uint8Array }[] = [];
  const listens: string[] = [];
  const timeline: string[] = [];
  let unlistens = 0;

  const defaultAnswer = (request: Envelope) =>
    request.sessionId === sessionId
      ? { requestId: request.requestId, operationId: id(), state: "succeeded", result: {} }
      : { requestId: request.requestId, state: "rejected", code: "UNKNOWN_TARGET" };
  mockIPC(
    (command, args) => {
      // Contract §1 "Renderer request body": one raw UTF-8 JSON body for each invoke.
      if (!(args instanceof Uint8Array)) throw new TypeError(`invoke ${command} without a Uint8Array body`);
      const request = JSON.parse(utf8.decode(args)) as Envelope;
      calls.push({ command, request, body: args });
      timeline.push(`invoke ${command}`);
      if (options.reject?.(command)) return Promise.reject(new Error(`command ${command} not found`));
      if (command === "current_session") return { requestId: request.requestId, state: "succeeded", result: { sessionId } };
      const answer = options.answer ? options.answer(command, request) : defaultAnswer(request);
      return answer === undefined ? new Promise(() => {}) : answer;
    },
    { shouldMockEvents: true },
  );
  const internals = (globalThis as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
  const mocked = internals.invoke;
  internals.invoke = (command, args, invokeOptions) => {
    if (command === "plugin:event|listen") {
      const event = (args as { event: string }).event;
      listens.push(event);
      timeline.push(`listen ${event}`);
      if (options.listen) return options.listen(event);
    }
    if (command === "plugin:event|unlisten") unlistens++;
    return mocked(command, args, invokeOptions);
  };

  const bridge = createBridge(options.onSessionChange, options.onTextScale);
  return {
    bridge,
    calls,
    listens,
    timeline,
    unlistens: () => unlistens,
    emit: (event: string, payload: unknown = {}) => void emit(event, payload),
    newSession: () => (sessionId = id()),
    session: () => sessionId,
  };
}

afterEach(() => clearMocks());

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
      expect(call.body).toBeInstanceOf(Uint8Array);
      expect(utf8.decode(call.body)).toBe(JSON.stringify(call.request));
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

  test("readEntries sends the repository target, the snapshot ID, and the cursor to read_entries, and returns the page", async () => {
    const page = { entries: [], cursor: null };
    const h = harness({ answer: (_command, request) => ({ requestId: request.requestId, operationId: id(), state: "succeeded", result: page }) });
    const target = { repositoryId: id(), repositoryGeneration: 4 };
    const payload = { snapshotId: id(), cursor: id() };
    const response = (await h.bridge.readEntries(target, payload)) as Record<string, unknown>;
    const call = h.calls.at(-1)!;
    expect(call.command).toBe("read_entries");
    // Contract §2: `readEntries` carries `repositoryId` and `repositoryGeneration`, and no `selectionId`.
    expect(call.request).toEqual({ version: 1, sessionId: h.session(), requestId: call.request.requestId, operation: "readEntries", ...target, payload });
    expect(validateRequest(call.request, "renderer").ok).toBe(true);
    expect(response).toMatchObject({ requestId: call.request.requestId, state: "succeeded", result: page });
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
    const pendingRead = h.bridge.openHistory(gen(), { scope: "all" });
    const done = await h.bridge.getOperation({ operationId: id() });
    expect((done as { state: string }).state).toBe("succeeded");
    await settle();

    h.emit("service-stopped", { markers: [] });
    const [commit, read] = (await Promise.all([pendingCommit, pendingRead])) as { requestId: string; state: string; code?: string; operationId?: string }[];
    for (const response of [commit, read]) {
      expect(response.state).toBe("unknown");
      expect(response.code).toBe("STATE_UNKNOWN");
    }
    const sent = h.calls.filter((c) => c.command === "commit" || c.command === "open_history").map((c) => c.request.requestId as string);
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

  test("an operation-progress event reaches the pending request with its requestId", async () => {
    const h = harness({ answer: (command, request) => (command === "commit" ? undefined : { requestId: request.requestId, state: "succeeded", result: {} }) });
    const events: unknown[] = [];
    const pendingCommit = h.bridge.commit(gen(), { reviewToken: id(), message: "m", confirmFullScope: true }, (event) => events.push(event));
    await settle();
    const requestId = h.calls.at(-1)!.request.requestId as string;
    const operationId = id();
    const accepted = { requestId, operationId, state: "accepted", counters: {} };
    h.emit("operation-progress", accepted);
    expect(events).toEqual([accepted]);

    await h.bridge.cancel({ operationId: (events[0] as { operationId: string }).operationId });
    const cancel = h.calls.at(-1)!;
    expect(cancel.command).toBe("cancel");
    expect(cancel.request.payload).toEqual({ operationId });
    expect(validateRequest(cancel.request, "renderer").ok).toBe(true);

    // The bridge keeps the recorded operationId for a request that ends without a terminal response.
    h.emit("service-stopped", { markers: [] });
    expect(await pendingCommit).toEqual({ requestId, operationId, state: "unknown", code: "STATE_UNKNOWN" });
  });

  test("an operation-progress event for a settled or unknown requestId calls no handler", async () => {
    const h = harness();
    const events: unknown[] = [];
    const response = (await h.bridge.openHistory(gen(), { scope: "all" }, (event) => events.push(event))) as { state: string };
    expect(response.state).toBe("succeeded");
    const requestId = h.calls.at(-1)!.request.requestId as string;
    h.emit("operation-progress", { requestId, operationId: id(), state: "running", counters: {} });
    h.emit("operation-progress", { requestId: id(), operationId: id(), state: "accepted", counters: {} });
    h.emit("operation-progress", null);
    await settle();
    expect(events).toEqual([]);
  });

  test("a request rejected before admission resolves with no operationId", async () => {
    const h = harness({ answer: (_command, request) => ({ requestId: request.requestId, state: "rejected", code: "INVALID_REQUEST" }) });
    const events: unknown[] = [];
    const response = (await h.bridge.applyFile(gen(), { comparisonId: id(), snapshotId: id(), direction: "stage" }, (event) => events.push(event))) as Record<string, unknown>;
    expect(response.state).toBe("rejected");
    expect(Object.hasOwn(response, "operationId")).toBe(false);
    expect(events).toEqual([]);
  });

  test("the bridge subscribes to each shell event once and never unlistens", async () => {
    const h = harness();
    await h.bridge.getEnvironment();
    h.emit("service-session");
    await h.bridge.getEnvironment();
    expect(h.listens.toSorted()).toEqual(["operation-progress", "service-session", "service-stopped", "text-scale"]);
    expect(h.unlistens()).toBe(0);
  });

  test("each text-scale event reaches the onTextScale handler with its payload", async () => {
    const values: unknown[] = [];
    const h = harness({ onTextScale: (value) => values.push(value) });
    await h.bridge.getEnvironment();
    h.emit("text-scale", 1.5);
    h.emit("text-scale", 2.25);
    expect(values).toEqual([1.5, 2.25]);
  });

  test("the bridge subscribes to each shell event before the first currentSession call", async () => {
    const h = harness({ listen: () => new Promise(() => {}) });
    expect(h.timeline.slice(0, 4).toSorted()).toEqual(["listen operation-progress", "listen service-session", "listen service-stopped", "listen text-scale"]);
    expect(h.timeline.slice(4)).toEqual(["invoke current_session"]);
    expect(((await h.bridge.getEnvironment()) as { state: string }).state).toBe("succeeded");
  });

  test("a rejected listen leaves no unhandled rejection, and the bridge still reads the session", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      const h = harness({ listen: () => Promise.reject(new Error("listen denied")) });
      await settle();
      await settle();
      expect(h.listens.toSorted()).toEqual(["operation-progress", "service-session", "service-stopped", "text-scale"]);
      expect(h.calls.map((c) => c.command)).toEqual(["current_session"]);
      expect(((await h.bridge.getEnvironment()) as { state: string }).state).toBe("succeeded");
      await settle();
      expect(unhandled).toEqual([]);
      expect(h.unlistens()).toBe(0);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  test("onSessionChange runs after a service-session event reads the new session, and not at load", async () => {
    let changes = 0;
    const h = harness({ onSessionChange: () => void changes++ });
    await settle();
    expect(changes).toBe(0);
    h.newSession();
    h.emit("service-session");
    await settle();
    expect(changes).toBe(1);
    expect(h.calls.map((c) => c.command)).toEqual(["current_session", "current_session"]);
  });

  test("the bridge exports no generic invoke function", () => {
    expect(Object.keys(bridgeModule)).toEqual(["createBridge"]);
    const h = harness();
    expect(Object.keys(h.bridge).toSorted()).toEqual([...OPERATIONS].toSorted());
  });
});
