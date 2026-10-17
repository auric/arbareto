// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T052: `clone` (contract Δ3 and Δ6, data-model §11, plan.md D10, FR-046 to FR-051, SC-004, SC-006, SC-011).
// The oracle is Git's own clone of the same URL into another folder. OS facts decide the destination state, never message text.
// Limits of the shell double:
// - It starts no Pageant. A picked key file gives the reply `ready`.
// - `plink.exe` is an empty file that the test makes. The double checks only that it exists.
// - FR-049 "saves no key file" is checked as: no result, event, log entry, or frame holds the key path.
// - FR-050 "opens no file" is checked as: the result equals the OS facts of the destination.
// - It maps the `errno` name to the `destinationFacts` error code. The shell maps the Win32 error.
// - It has no WSL clone route. T075 runs the WSL clone in the distro.

import { expect } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { RECONCILIATION_TARGET_MS, STALL_NOTICE_MS, SUBMODULE_UPDATE_CEILING_MS, SUBMODULE_UPDATE_INACTIVITY_MS } from "../../src/contracts/limits";
import { CloneResult } from "../../src/contracts/envelope";
import { printOrigin } from "../origin";
import { startHttpRemote, type HttpRemote } from "../support/http-remote";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { refState, workingFileDigests } from "./git-oracle";
import { buildCredentialRemote, buildEmptyRemote, buildFetchFlags, buildSubmodule, gitRun, HTTP_PASSWORD, HTTP_USER, nativeEnv, stageEntries, urlWithCredential, type GitHost } from "./remote-fixtures";
import { caseTest, type Service, type ServiceResponse } from "./service-harness";
import { callsOf, gitExe, helperGlobal, hostFor, localConfig, native, strings, TIMEOUT_MS, withSync } from "./sync-harness";

useFixtureRoot();
printOrigin("../../src/git-service/clone.ts", import.meta.dir);

const TASK = "T052";
const SHELL = ["shell-double"] as const;
const WINDOWS = ["shell-double", "git-for-windows"] as const;
const JUNCTION = ["shell-double", "ntfs-junction"] as const;
const UNREADABLE = ["shell-double", "read-denial"] as const;
const CLONE = (url: string, destination: string) => ["--no-lazy-fetch", "clone", "--progress", "--no-recurse-submodules", "--", url, destination];
const NETWORK_LIMITS = { inactivityMs: SUBMODULE_UPDATE_INACTIVITY_MS, ceilingMs: SUBMODULE_UPDATE_CEILING_MS, stallMs: STALL_NOTICE_MS };
const REMEDY_TEXT = "This command runs the step in a terminal, where Git and SSH can ask for input. Then use the action again.";
const outcome = (r: { state: string; code?: string }) => ({ state: r.state, code: r.code });

interface Cloned {
  repositoryId?: string;
  generation?: number;
  worktreeRoot?: string;
  exists?: boolean;
  empty?: boolean;
  outputTail?: string;
  remedy?: { text: string; command?: string | null };
  reason?: string;
  path?: string;
  program?: string;
}

// The native step of the shell: it binds the contexts of `destination` and forwards their IDs (contract Δ3).
function sendClone(service: Service, destination: string, url: string, key?: string): { requestId: string; cloneId: string; bootstrapId: string } {
  const ids = service.runner.addClone(destination, url, key);
  return { requestId: service.send("clone", { url, ...ids }), ...ids };
}

async function clone(service: Service, destination: string, url: string): Promise<ServiceResponse<Cloned> & { operationId: string }> {
  const { requestId } = sendClone(service, destination, url);
  const operationId = await service.operationId(requestId);
  const response = await service.response<Cloned>(requestId, 120_000);
  expect(CloneResult.safeParse(response.result).success || response.result === undefined).toBe(true);
  return { ...response, operationId };
}

// OS facts of the destination, as FR-050 states them.
function onDisk(path: string): { exists: boolean; empty: boolean } {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return { exists: stat !== undefined, empty: stat?.isDirectory() === true && readdirSync(path).length === 0 };
}

// Refs, HEAD, the configuration values, the index entries, and the working files (SC-011).
function repoState(h: GitHost, repo: string) {
  return { ...refState(gitExe(), native(repo)), config: localConfig(h, repo), index: stageEntries(h, repo), files: workingFileDigests(native(repo)) };
}

function oracleClone(h: GitHost, url: string, tag: string): string {
  const to = `${h.root}/${tag}-oracle`;
  gitRun(h, h.root, ["clone", "-q", "--no-recurse-submodules", "--", url, to]);
  return to;
}

const progressOf = (service: Service, requestId: string) => (service.progress as { requestId?: string; phase?: string; counters?: Record<string, number>; stalled?: boolean }[]).filter((p) => p.requestId === requestId);

// The same OS identity: the volume and the file index.
const sameFile = (a: string, b: string) => {
  const [x, y] = [statSync(a, { bigint: true }), statSync(b, { bigint: true })];
  return x.dev === y.dev && x.ino === y.ino;
};

async function until(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const end = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > end) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await Bun.sleep(20);
  }
}

// An HTTP remote with Basic sign-in. An owned global file names the test credential helper, so the URL holds no user information.
async function withHttp(h: GitHost, body: (server: HttpRemote, url: string, environment: Record<string, string>) => Promise<void>): Promise<void> {
  const project = `${h.root}/http`;
  mkdirSync(project, { recursive: true });
  buildCredentialRemote(h, project);
  const environment = nativeEnv({ GIT_CONFIG_GLOBAL: helperGlobal(h, HTTP_USER, HTTP_PASSWORD) });
  const server = startHttpRemote({ git: gitExe(), projectRoot: project, user: HTTP_USER, password: HTTP_PASSWORD, env: nativeEnv() });
  try {
    await body(server, `${server.url}/cred.git`, environment);
  } finally {
    server.resume();
    await server.stop();
  }
}

describeGit("clone (T052)", () => {
  caseTest(TASK, "SC-011, SC-006, FR-046, FR-051: a clone into a missing folder and into an empty folder equals Git's own clone, writes only Git's configuration, and registers the destination as the top level", SHELL, async () => {
    const h = hostFor("t052-equal");
    const { origin } = buildFetchFlags(h);
    const url = native(origin);
    const oracle = repoState(h, oracleClone(h, url, "equal"));
    await withSync("t052-equal", async (service) => {
      for (const kind of ["missing", "empty"] as const) {
        const destination = native(`${h.root}/${kind}`);
        if (kind === "empty") mkdirSync(destination);
        const before = [h.read(h.systemConfig), h.read(h.globalConfig)];
        const { requestId } = sendClone(service, destination, url);
        const operationId = await service.operationId(requestId);
        const response = await service.response<Cloned>(requestId, 120_000);
        expect({ kind, ...outcome(response) }).toEqual({ kind, state: "succeeded", code: undefined });
        expect(Object.keys(response.result!).sort()).toEqual(["generation", "repositoryId", "worktreeKey", "worktreeRoot"]);
        expect(sameFile(response.result!.worktreeRoot!, destination)).toBe(true);
        expect(repoState(h, destination)).toEqual(oracle);
        // SC-006: the system and global files stay unchanged.
        expect([h.read(h.systemConfig), h.read(h.globalConfig)]).toEqual(before);
        const calls = callsOf(service, operationId);
        const step = calls.filter((c) => c.contextKind === "clone");
        expect(step.map((c) => ({ args: c.arguments, policy: c.environmentPolicy, limits: c.limits }))).toEqual([{ args: CLONE(url, destination), policy: "remote", limits: NETWORK_LIMITS }]);
        // FR-051: the clone runs discovery only. The 001 trust decision comes before the first read.
        expect([...new Set(calls.map((c) => c.environmentPolicy))].sort()).toEqual(["probe", "remote"]);
        const events = progressOf(service, requestId).filter((p) => p.phase !== undefined);
        expect(events.length).toBeGreaterThan(0);
        for (const event of events) {
          expect(["clone", "pageant"]).toContain(event.phase!);
          expect(Object.keys(event.counters ?? {}).every((k) => k === "percent")).toBe(true);
          expect(event.stalled).toBe(false);
        }
      }
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-047: a non-empty folder and a file give DESTINATION_NOT_EMPTY before any Git process, and every destination byte stays equal", SHELL, async () => {
    const h = hostFor("t052-not-empty");
    const { origin } = buildFetchFlags(h);
    const folder = native(`${h.root}/full`);
    mkdirSync(folder);
    writeFileSync(join(folder, "keep.txt"), "keep\n");
    const file = native(`${h.root}/file.txt`);
    writeFileSync(file, "file\n");
    await withSync("t052-not-empty", async (service) => {
      for (const [destination, reason] of [[folder, "not-empty"], [file, "file"]] as const) {
        const before = reason === "file" ? readFileSync(file) : workingFileDigests(folder);
        const response = await clone(service, destination, native(origin));
        expect({ ...outcome(response), result: response.result }).toEqual({ state: "failed", code: "DESTINATION_NOT_EMPTY", result: { reason, path: destination } });
        expect(callsOf(service, response.operationId)).toEqual([]);
        expect(reason === "file" ? readFileSync(file) : workingFileDigests(folder)).toEqual(before);
      }
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-047: a junction gives DESTINATION_NOT_EMPTY with other, starts no Git process, and leaves its target unchanged", JUNCTION, async () => {
    const h = hostFor("t052-junction");
    const { origin } = buildFetchFlags(h);
    const target = native(`${h.root}/target`);
    mkdirSync(target);
    const junction = native(`${h.root}/junction`);
    symlinkSync(target, junction, "junction");
    await withSync("t052-junction", async (service) => {
      const response = await clone(service, junction, native(origin));
      expect({ ...outcome(response), result: response.result }).toEqual({ state: "failed", code: "DESTINATION_NOT_EMPTY", result: { reason: "other", path: junction } });
      expect(callsOf(service, response.operationId)).toEqual([]);
      expect(readdirSync(target)).toEqual([]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "a destination that the shell cannot read gives REPOSITORY_UNAVAILABLE with the path and the error code before any Git process (001 §12 folder check)", UNREADABLE, async () => {
    const h = hostFor("t052-unreadable");
    const { origin } = buildFetchFlags(h);
    const folder = native(`${h.root}/denied`);
    mkdirSync(folder);
    denyList(folder);
    try {
      await withSync("t052-unreadable", async (service) => {
        const response = await clone(service, folder, native(origin));
        expect({ ...outcome(response), result: response.result }).toEqual({ state: "failed", code: "REPOSITORY_UNAVAILABLE", result: { path: folder, remedy: { text: `Arbareto cannot read ${folder}: access-denied.` } } });
        expect(callsOf(service, response.operationId)).toEqual([]);
      });
    } finally {
      allowList(folder);
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "a URL that starts with - stays literal after --, so Git takes it as a repository and no option runs", SHELL, async () => {
    const h = hostFor("t052-dash");
    const destination = native(`${h.root}/dash`);
    await withSync("t052-dash", async (service) => {
      const response = await clone(service, destination, "--bare");
      expect(outcome(response)).toEqual({ state: "failed", code: "GIT_FAILED" });
      expect(callsOf(service, response.operationId).filter((c) => c.contextKind === "clone").map((c) => c.arguments)).toEqual([CLONE("--bare", destination)]);
      expect(existsSync(join(destination, "HEAD"))).toBe(false);
      const { outputTail, ...state } = response.result!;
      expect(state).toEqual({ ...onDisk(destination), remedy: { text: REMEDY_TEXT, command: `& ${psQuote(gitExe())} clone -- '--bare' ${psQuote(destination)}` } });
      expect(typeof outputTail).toBe("string");
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-051: a top level whose identity differs from the destination ends with the FR-050 result and registers nothing", SHELL, async () => {
    const h = hostFor("t052-top-level");
    const { origin } = buildFetchFlags(h);
    const destination = native(`${h.root}/top`);
    await withSync("t052-top-level", async (service) => {
      service.runner.inject.identities.set(destination, { volumeSerial: "00000000000000ff", fileId: "000000000000000000000000000000ff" });
      const response = await clone(service, destination, native(origin));
      expect(outcome(response)).toEqual({ state: "failed", code: "REPOSITORY_UNAVAILABLE" });
      expect({ exists: response.result!.exists, empty: response.result!.empty }).toEqual(onDisk(destination));
      expect(onDisk(destination)).toEqual({ exists: true, empty: false });
      expect(response.result!.repositoryId).toBeUndefined();
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "001 §3 \"Cancel preserves the current workspace\": Cancel while step 5 registers releases the new workspace before the canceled response", SHELL, async () => {
    const h = hostFor("t052-cancel-register");
    const { origin } = buildFetchFlags(h);
    const destination = native(`${h.root}/registering`);
    await withSync("t052-cancel-register", async (service) => {
      let held: string | null = null;
      let open = () => {};
      const gate = new Promise<void>((resolve) => (open = resolve));
      service.runner.inject.holdRegister = (request) => {
        held = request.repositoryId;
        return gate;
      };
      const { requestId } = sendClone(service, destination, native(origin));
      const operationId = await service.operationId(requestId);
      await until(() => held !== null, "held register");
      await service.cancel(operationId);
      open();
      const response = await service.response<Cloned>(requestId);
      expect(outcome(response)).toEqual({ state: "canceled", code: "CANCELED" });
      expect(service.runner.frames).toContainEqual({ type: "release", repositoryId: held });
      expect({ exists: response.result!.exists, empty: response.result!.empty }).toEqual(onDisk(destination));
      service.runner.inject.holdRegister = null;
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "a broken second destinationFacts read keeps the code of the step and gives the code-only result", SHELL, async () => {
    const h = hostFor("t052-broken-facts");
    const { origin } = buildFetchFlags(h);
    const destination = native(`${h.root}/broken`);
    await withSync("t052-broken-facts", async (service) => {
      let reads = 0;
      service.runner.inject.destinationFacts = () => {
        if (++reads === 2) throw new TypeError("broken channel");
      };
      // The ceiling ends the clone process, so the step code is DEADLINE.
      service.runner.inject.limits = { ceilingMs: 1 };
      const response = await clone(service, destination, native(origin));
      expect({ ...outcome(response), result: response.result, reads }).toEqual({ state: "failed", code: "DEADLINE", result: undefined, reads: 2 });
      service.runner.inject.limits = {};
      service.runner.inject.destinationFacts = null;
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "an empty remote opens with an unborn branch, as Git's own clone has it", SHELL, async () => {
    const h = hostFor("t052-empty-remote");
    const url = native(buildEmptyRemote(h));
    const oracle = refState(gitExe(), native(oracleClone(h, url, "empty")));
    const destination = native(`${h.root}/unborn`);
    await withSync("t052-empty-remote", async (service) => {
      const response = await clone(service, destination, url);
      expect(outcome(response)).toEqual({ state: "succeeded", code: undefined });
      expect(refState(gitExe(), destination)).toEqual(oracle);
      const read = await service.readWorkspace(response.result!.repositoryId!);
      expect(read.state).toBe("succeeded");
      expect(read.result!.head).toEqual({ state: "unborn", target: oracle.headTarget! });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-048: a remote with a submodule commit clones no submodule, and the repository offers Update submodules", SHELL, async () => {
    const h = hostFor("t052-submodule");
    const f = buildSubmodule(h);
    const destination = native(`${h.root}/super-clone`);
    await withSync("t052-submodule", async (service) => {
      const response = await clone(service, destination, native(f.superRemote));
      expect(outcome(response)).toEqual({ state: "succeeded", code: undefined });
      expect(existsSync(join(destination, ".git", "modules"))).toBe(false);
      expect(readdirSync(join(destination, "sub"))).toEqual([]);
      const read = await service.readWorkspace(response.result!.repositoryId!);
      expect((read.result as unknown as { submoduleNotice: { count: number; paths: string[] } }).submoduleNotice).toMatchObject({ count: 1, paths: ["sub"] });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-050, SC-004: Cancel during a paused HTTP clone ends canceled within 5 seconds with the destination state from OS facts", SHELL, async () => {
    const h = hostFor("t052-cancel");
    const destination = native(`${h.root}/canceled`);
    await withHttp(h, async (server, url, environment) => {
      await withSync("t052-cancel", async (service) => {
        server.pause();
        const served = server.requests();
        const { requestId } = sendClone(service, destination, url);
        const operationId = await service.operationId(requestId);
        await until(() => server.requests() > served, "a paused request");
        const canceledAt = performance.now();
        await service.cancel(operationId);
        const response = await service.response<Cloned>(requestId);
        expect(outcome(response)).toEqual({ state: "canceled", code: "CANCELED" });
        expect(service.responseAt.get(requestId)! - canceledAt).toBeLessThanOrEqual(RECONCILIATION_TARGET_MS);
        const { outputTail: _tail, ...state } = response.result!;
        expect(state).toEqual({ ...onDisk(destination), remedy: { text: REMEDY_TEXT, command: `& ${psQuote(gitExe())} clone -- ${psQuote(url)} ${psQuote(destination)}` } });
        const step = callsOf(service, operationId).find((c) => c.contextKind === "clone")!;
        await until(() => step.exit !== undefined, "process end", RECONCILIATION_TARGET_MS);
        expect(step.exit!.exitCode).toBeNull();
      }, { environment });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-050, SC-004: the inactivity end of a paused HTTP clone gives DEADLINE within 5 seconds, after a stall event with the clone remedy", SHELL, async () => {
    const h = hostFor("t052-inactivity");
    const destination = native(`${h.root}/stalled`);
    await withHttp(h, async (server, url, environment) => {
      await withSync("t052-inactivity", async (service) => {
        service.runner.inject.limits = { stallMs: 300, inactivityMs: 3_000 };
        server.pause();
        const { requestId } = sendClone(service, destination, url);
        const operationId = await service.operationId(requestId);
        const command = `& ${psQuote(gitExe())} clone -- ${psQuote(url)} ${psQuote(destination)}`;
        await until(() => progressOf(service, requestId).some((p) => p.stalled === true), "stalled event");
        expect(((await service.getOperation(operationId)).result as { stallRemedy?: unknown }).stallRemedy).toEqual({ command, text: REMEDY_TEXT });
        const response = await service.response<Cloned>(requestId, 60_000);
        const step = callsOf(service, operationId).find((c) => c.contextKind === "clone")!;
        expect(outcome(response)).toEqual({ state: "failed", code: "DEADLINE" });
        expect(step.exit?.deadline).toBe("inactivity");
        expect(service.responseAt.get(requestId)! - (step.at + step.durationMs!)).toBeLessThanOrEqual(RECONCILIATION_TARGET_MS);
        const { outputTail: _tail, ...state } = response.result!;
        expect(state).toEqual({ ...onDisk(destination), remedy: { text: REMEDY_TEXT, command } });
        service.runner.inject.limits = {};
      }, { environment });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "a failed HTTP clone shows the redacted output tail and the remedy, or text only for a URL with user information; no output holds a credential or the URL", SHELL, async () => {
    const h = hostFor("t052-http-failure");
    await withHttp(h, async (_server, url, environment) => {
      await withSync("t052-http-failure", async (service) => {
        const signed = urlWithCredential(url, HTTP_USER, "wrong-password");
        const withUser = await clone(service, native(`${h.root}/with-user`), signed);
        expect(outcome(withUser)).toEqual({ state: "failed", code: "GIT_FAILED" });
        expect(withUser.result!.outputTail).not.toBe("");
        expect(withUser.result!.remedy).toEqual({ text: REMEDY_TEXT, command: null });
        expect({ exists: withUser.result!.exists, empty: withUser.result!.empty }).toEqual(onDisk(native(`${h.root}/with-user`)));

        // The served project holds no `missing.git`.
        const plain = native(`${h.root}/plain`);
        const missing = url.replace("/cred.git", "/missing.git");
        const failed = await clone(service, plain, missing);
        expect(outcome(failed)).toEqual({ state: "failed", code: "GIT_FAILED" });
        expect(failed.result!.remedy).toEqual({ text: REMEDY_TEXT, command: `& ${psQuote(gitExe())} clone -- ${psQuote(missing)} ${psQuote(plain)}` });

        const texts = strings([service.responses, service.progress, service.log(), service.runner.frames]);
        for (const secret of ["wrong-password", HTTP_USER]) expect({ secret, found: texts.filter((t) => t.includes(secret)) }).toEqual({ secret, found: [] });
        const logTexts = strings(service.log());
        for (const name of ["http", "127.0.0.1", "cred.git", "missing.git"]) expect({ name, found: logTexts.filter((t) => t.includes(name)) }).toEqual({ name, found: [] });
      }, { environment });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-049: with keyFile picked under plink, the shell gets pageant {cloneId} before the clone, and no output holds the key path", WINDOWS, async () => {
    const h = hostFor("t052-picked");
    const { origin } = buildFetchFlags(h);
    // An empty stand-in. The double checks that the file exists and never starts it.
    const plink = native(`${h.root}/putty/plink.exe`);
    mkdirSync(native(`${h.root}/putty`));
    writeFileSync(plink, "");
    const key = native(`${h.root}/keys/id.ppk`);
    mkdirSync(native(`${h.root}/keys`));
    writeFileSync(key, "PuTTY-User-Key-File-3: ssh-ed25519\n");
    const destination = native(`${h.root}/picked`);
    await withSync("t052-picked", async (service) => {
      service.runner.inject.sshClient = { plink };
      const { requestId, cloneId } = sendClone(service, destination, native(origin), key);
      const response = await service.response<Cloned>(requestId, 120_000);
      expect(outcome(response)).toEqual({ state: "succeeded", code: undefined });
      const operationId = response.operationId!;
      expect(service.runner.frames.filter((f) => f.type === "pageant")).toEqual([{ type: "pageant", operationId, cloneId }]);
      const phases = progressOf(service, requestId).flatMap((p) => (p.phase === undefined ? [] : [p.phase]));
      expect(phases.indexOf("pageant")).toBeGreaterThanOrEqual(0);
      expect(phases.indexOf("pageant")).toBeLessThan(phases.indexOf("clone"));
      expect(readFileSync(key, "utf8")).toBe("PuTTY-User-Key-File-3: ssh-ed25519\n");
      const texts = strings([service.responses, service.progress, service.log(), service.runner.frames]);
      expect(texts.filter((t) => t.includes("id.ppk"))).toEqual([]);
      service.runner.inject.sshClient = "git";
    });
  }, TIMEOUT_MS);
});

const psQuote = (value: string) => `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`;

// The folder keeps its attributes readable, so `lstat` works and the listing fails. On Windows, `RD` denies the folder listing.
function denyList(path: string): void {
  if (process.platform === "win32") icacls([path, "/deny", `${userInfo().username}:(RD)`]);
  else chmodSync(path, 0o100);
}

function allowList(path: string): void {
  if (process.platform === "win32") icacls([path, "/remove:d", userInfo().username]);
  else chmodSync(path, 0o755);
}

function icacls(args: string[]): void {
  const proc = Bun.spawnSync(["icacls", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`icacls ${args.join(" ")} exited ${proc.exitCode}`);
}
