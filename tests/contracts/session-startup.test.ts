// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { PENDING_READS_GLOBAL, PUBLIC_FRAME_BODY_BYTES } from "../../src/contracts/limits";
import type { GitCall, GitExit, GitRunner } from "../../src/git-service/git-runner";
import { createSession, type SessionOptions } from "../../src/git-service/session";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/git-service/git-runner.ts", import.meta.dir);
printOrigin("../../src/git-service/session.ts", import.meta.dir);

const DEADLINE_MS = 100;
const WAIT_MS = 5_000;
const TEST_TIMEOUT_MS = 10_000;

// The saved Git is a small `git.exe` in an owned folder. The probe resolves `<exec-path>\git.exe`, so the name matters.
const SAVED_FOLDER = mkdtempSync(join(tmpdir(), "arbareto-session-startup-"));
afterAll(() => rmSync(SAVED_FOLDER, { recursive: true, force: true }));
const SAVED_PATH = join(SAVED_FOLDER, "git.exe");
writeFileSync(SAVED_PATH, "saved Git stub");
// A wrapper in a subfolder. The exec-path probe of `probeRun` names the saved folder, so the wrapper resolves to `SAVED_PATH`.
const WRAPPER_PATH = join(SAVED_FOLDER, "cmd", "git.exe");
mkdirSync(join(SAVED_FOLDER, "cmd"));
writeFileSync(WRAPPER_PATH, "wrapper Git stub");
const SAVED_GIT = {
  bootstrapId: "00000000-0000-4000-8000-0000000000aa",
  selectedPath: SAVED_PATH,
  executablePath: SAVED_PATH,
  version: "2.55.0.windows.3",
  digest: new Bun.CryptoHasher("sha256").update(readFileSync(SAVED_PATH)).digest("hex"),
};

// The shell answers the exec-path probe with the saved folder and the version probe with an admitted version.
async function probeRun(call: GitCall): Promise<GitExit> {
  const output = call.arguments[0] === "--exec-path" ? `${SAVED_FOLDER}\n` : "git version 2.55.0.windows.3\ncpu: x86_64\n";
  call.stdout.push(new TextEncoder().encode(output));
  return { exitCode: 0, activeDescendants: 0 };
}
const HANDSHAKE = {
  version: 1,
  restarted: false,
  platformScope: "other",
  osBuild: 26200,
  webView2Version: "140.0.0.0",
  buildIdentity: { version: "0.1.0", commit: "0".repeat(40), signing: "unsigned" },
  markers: [],
  unloadedMarkers: 0,
  damagedMarkers: [],
  trustRecords: [],
  savedGit: SAVED_GIT,
};
const IDENTITY = { volumeSerial: "0123456789abcdef", fileId: "0123456789abcdef0123456789abcdef" };

type Response = { requestId: string | null; state: string; code?: string; result?: { gitCode?: string } };
type Progress = { requestId: string; operationId: string };

function startSession(runner: Partial<GitRunner>, handshake: object = HANDSHAKE) {
  const responses: Response[] = [];
  const progress: Progress[] = [];
  const calls = { closeJob: [] as string[], release: [] as unknown[] };
  const session = createSession({
    writer: {
      write: (frame) => {
        if ("response" in frame) responses.push(frame.response as Response);
        if ("progress" in frame) progress.push(frame.progress as Progress);
      },
      flush: async () => {},
    },
    runner: {
      closeJob: (id: string) => void calls.closeJob.push(id),
      release: (target: unknown) => void calls.release.push(target),
      receive: () => false,
      ...runner,
    } as unknown as SessionOptions["runner"],
    fail: () => {},
    startupDeadlineMs: DEADLINE_MS,
  });
  const send = (frame: object) => session.receive({ type: "frame", body: new TextEncoder().encode(JSON.stringify(frame)) });
  send({ kind: "handshake", handshake });
  const sessionId = session.sessionId as string;
  const getEnvironment = (requestId: string = crypto.randomUUID()) => {
    send({ kind: "public", request: { version: 1, sessionId, requestId, operation: "getEnvironment", payload: {} } });
    return requestId;
  };
  const responseFor = async (requestId: string) => {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const found = responses.filter((r) => r.requestId === requestId);
      if (found.length > 0) return found;
      if (Date.now() > deadline) throw new Error(`no response for ${requestId}`);
      await Bun.sleep(10);
    }
  };
  return { responses, progress, calls, send, sessionId, getEnvironment, responseFor };
}

const never = () => new Promise<never>(() => {});

test(
  "a startup revalidation that never settles ends at the deadline with DEADLINE",
  async () => {
    const { calls, getEnvironment, responseFor } = startSession({ identities: never });
    const id = getEnvironment();
    const [response] = await responseFor(id);
    expect(response).toMatchObject({ state: "succeeded", result: { gitCode: "DEADLINE" } });
    // The startup Job closes first. The `getEnvironment` operation then closes its own Job.
    expect(calls.closeJob).toHaveLength(2);
    const operationId = (response as { operationId?: string }).operationId as string;
    expect(calls.closeJob[0]).not.toBe(operationId);
    expect(calls.closeJob[1]).toBe(operationId);
  },
  TEST_TIMEOUT_MS,
);

test(
  `the startup gate holds ${PENDING_READS_GLOBAL} public frames and rejects the rest with SERVICE_UNAVAILABLE after the requestId claim`,
  async () => {
    const { responses, getEnvironment, responseFor } = startSession({ identities: never });
    const held = Array.from({ length: PENDING_READS_GLOBAL }, () => getEnvironment());
    expect(responses).toEqual([]);
    const extra = getEnvironment();
    expect(responses).toEqual([{ requestId: extra, state: "rejected", code: "SERVICE_UNAVAILABLE" }]);
    getEnvironment(extra);
    expect(responses[1]).toEqual({ requestId: extra, state: "rejected", code: "INVALID_REQUEST" });
    for (const id of held) {
      const terminal = (await responseFor(id)).filter((r) => r.state !== "accepted");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({ state: "succeeded", result: { gitCode: "DEADLINE" } });
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "a held oversize frame counts toward the cap and gets FRAME_LIMIT when the gate opens",
  async () => {
    const { responses, send, sessionId, getEnvironment, responseFor } = startSession({ identities: never });
    const held = Array.from({ length: PENDING_READS_GLOBAL - 1 }, () => getEnvironment());
    const pad = "a".repeat(PUBLIC_FRAME_BODY_BYTES);
    send({ kind: "public", request: { version: 1, sessionId, requestId: crypto.randomUUID(), operation: "getEnvironment", payload: {}, pad } });
    expect(responses).toEqual([]);
    const extra = getEnvironment();
    expect(responses).toEqual([{ requestId: extra, state: "rejected", code: "SERVICE_UNAVAILABLE" }]);
    for (const id of held) expect(await responseFor(id)).toHaveLength(1);
    expect(responses.filter((r) => r.requestId === null)).toEqual([{ requestId: null, state: "rejected", code: "FRAME_LIMIT" }]);
  },
  TEST_TIMEOUT_MS,
);

test(
  "a startup revalidation that throws reports GIT_FAILED, not GIT_UNAVAILABLE",
  async () => {
    const { getEnvironment, responseFor } = startSession({
      identities: async () => {
        throw new Error("identity reply lost");
      },
    });
    const [response] = await responseFor(getEnvironment());
    expect(response).toMatchObject({ state: "succeeded", result: { gitCode: "GIT_FAILED" } });
  },
  TEST_TIMEOUT_MS,
);

test(
  "a startup registration that approves after the deadline releases its gitInstallationId",
  async () => {
    let approve!: () => void;
    const registered: string[] = [];
    const { calls, getEnvironment, responseFor } = startSession({
      identities: async () => [IDENTITY],
      run: probeRun,
      register: (request) => {
        registered.push(request.gitInstallationId);
        return new Promise((resolve) => (approve = () => resolve({ result: "approved" })));
      },
    });
    const [response] = await responseFor(getEnvironment());
    expect(response).toMatchObject({ state: "succeeded", result: { gitCode: "DEADLINE" } });
    expect(registered).toHaveLength(1);
    approve();
    await Bun.sleep(20);
    expect(calls.release).toEqual([{ gitInstallationId: registered[0] }]);
    const [later] = await responseFor(getEnvironment());
    expect(later).toMatchObject({ state: "succeeded", result: { gitCode: "DEADLINE" } });
  },
  TEST_TIMEOUT_MS,
);

test(
  "a chooseGit probe that registers after a cancel releases its gitInstallationId and ends canceled",
  async () => {
    let approve!: () => void;
    const registered: string[] = [];
    const { savedGit: _, ...withoutSavedGit } = HANDSHAKE;
    const { calls, progress, send, sessionId, responseFor } = startSession(
      {
        identities: async () => [IDENTITY],
        run: probeRun,
        register: (request) => {
          registered.push(request.gitInstallationId);
          return new Promise((resolve) => (approve = () => resolve({ result: "approved" })));
        },
      },
      withoutSavedGit,
    );
    const request = (operation: string, payload: object) => {
      const requestId = crypto.randomUUID();
      send({ kind: "public", request: { version: 1, sessionId, requestId, operation, payload } });
      return requestId;
    };
    const choose = request("chooseGit", { bootstrapId: SAVED_GIT.bootstrapId, executablePath: SAVED_GIT.executablePath });
    const deadline = Date.now() + WAIT_MS;
    while (registered.length === 0) {
      if (Date.now() > deadline) throw new Error("no register request");
      await Bun.sleep(10);
    }
    const operationId = progress.find((p) => p.requestId === choose)?.operationId as string;
    const [canceled] = await responseFor(request("cancel", { operationId }));
    expect(canceled).toMatchObject({ state: "succeeded", result: { state: "cancel-requested" } });
    approve();
    const [terminal] = await responseFor(choose);
    expect(terminal).toMatchObject({ state: "canceled" });
    expect(calls.release).toEqual([{ gitInstallationId: registered[0] }]);
  },
  TEST_TIMEOUT_MS,
);

// Contract §6 "Startup contexts": the startup probe resolves `selectedPath` and compares the result with the stored `executablePath`.
const wrapperRunner = (resolved: unknown[]): Partial<GitRunner> => ({
  identities: async () => [IDENTITY],
  run: probeRun,
  resolveGit: async (request) => (resolved.push(request), { bootstrapId: crypto.randomUUID() }),
  register: async () => ({ result: "approved" }),
});

test(
  "a startup wrapper selectedPath that resolves to the stored executablePath gives getEnvironment both paths and no gitCode",
  async () => {
    const resolved: unknown[] = [];
    const { getEnvironment, responseFor } = startSession(wrapperRunner(resolved), { ...HANDSHAKE, savedGit: { ...SAVED_GIT, selectedPath: WRAPPER_PATH } });
    const [response] = await responseFor(getEnvironment());
    expect(response).toMatchObject({ state: "succeeded", result: { selectedPath: WRAPPER_PATH, executablePath: SAVED_PATH, admission: "admitted" } });
    expect(response.result?.gitCode).toBeUndefined();
    expect(resolved).toEqual([{ operationId: expect.any(String), bootstrapId: SAVED_GIT.bootstrapId, executablePath: SAVED_PATH }]);
  },
  TEST_TIMEOUT_MS,
);

test(
  "a chooseGit success through a wrapper returns selectedPath and executablePath",
  async () => {
    const { savedGit: _, ...withoutSavedGit } = HANDSHAKE;
    const { send, sessionId, responseFor } = startSession(wrapperRunner([]), withoutSavedGit);
    const requestId = crypto.randomUUID();
    const payload = { bootstrapId: crypto.randomUUID(), executablePath: WRAPPER_PATH };
    send({ kind: "public", request: { version: 1, sessionId, requestId, operation: "chooseGit", payload } });
    const [terminal] = await responseFor(requestId);
    expect(terminal).toMatchObject({
      state: "succeeded",
      result: { selectedPath: WRAPPER_PATH, executablePath: SAVED_PATH, version: SAVED_GIT.version, digest: SAVED_GIT.digest },
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "a startup selectedPath that resolves to itself, not to the stored executablePath, gives GIT_CHANGED and registers nothing",
  async () => {
    const otherPath = join(SAVED_FOLDER, "other", "git.exe");
    mkdirSync(join(SAVED_FOLDER, "other"));
    writeFileSync(otherPath, readFileSync(SAVED_PATH));
    const registers: unknown[] = [];
    const runner = { ...wrapperRunner([]), register: async (request: unknown) => (registers.push(request), { result: "approved" as const }) };
    const { getEnvironment, responseFor } = startSession(runner, { ...HANDSHAKE, savedGit: { ...SAVED_GIT, executablePath: otherPath } });
    const [response] = await responseFor(getEnvironment());
    expect(response).toMatchObject({ state: "succeeded", result: { gitCode: "GIT_CHANGED" } });
    expect(registers).toEqual([]);
  },
  TEST_TIMEOUT_MS,
);
