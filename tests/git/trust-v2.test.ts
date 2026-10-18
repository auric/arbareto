// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T051: feature 004 US7 trust option (d), quickstart Q22. Spec FR-069 to FR-075 and SC-010; plan.md D12, D14, and O-5; contract Δ6 and Δ7; data-model §10.
// The shell double records each `trust` `confirm` frame in `runner.frames` with `callsBefore`, the count of Git calls before the frame.

import { describe, expect } from "bun:test";
import { appendFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { useFixtureRoot } from "./fixture-root";
import { buildF02, buildF14, put, type Built } from "./fixtures";
import { applyHunk, barrier, commit, commitCalls, commitPayload, gitPathOf, gitText, outcome, putHook, readOk, repoOf, reviewOk, selectHunks, shQuote, SUCCEEDED, TIMEOUT_MS, until, withService, gitPath } from "./hunk-harness";
import { caseTest, openService, type OpenOptions, type Service, type ServiceResponse } from "./service-harness";
import { UNSHOWN_NAME } from "../../src/git-service/trust";

printOrigin("../../src/git-service/trust.ts", import.meta.dir);
printOrigin("../../src/git-service/session.ts", import.meta.dir);
printOrigin("../../src/contracts/channel.ts", import.meta.dir);
printOrigin("../../src/contracts/envelope.ts", import.meta.dir);

const TASK = "T051";
const W = ["shell-double"] as const;
const CANCELED = { state: "canceled", code: "CANCELED" };

// Data-model §10: the version 2 record holds no fingerprint and no program digest.
const V2_FIELDS = ["adminDirectory", "approvedAt", "commonDirectory", "commonIdentity", "gitSelectedPath", "policyVersion", "worktreeIdentity", "worktreeRoot"];
// Contract Δ6: the version 2 `confirm` frame. `callsBefore` is the double's record field.
const FRAME_FIELDS = ["action", "adminDirectory", "callsBefore", "commonDirectory", "details", "gitSelectedPath", "policyVersion", "type", "worktreeRoot"];
const NONE = { names: [], more: 0 };
const NO_PROGRAMS = { hooks: NONE, filters: NONE, monitors: NONE, mergeDrivers: NONE, mergeTools: NONE, signing: NONE, other: NONE };

type Frame = Record<string, unknown> & { callsBefore: number; details: Record<string, { names: Record<string, unknown>[]; more: number }> };
type Programs = Record<string, { names: Record<string, unknown>[]; more: number }>;
interface Trust {
  state: string;
  trustId?: string;
  approvalRequired: Record<string, boolean>;
  programs: Programs;
}

const confirms = (service: Service) => service.runner.frames.filter((f) => f.type === "confirm") as Frame[];
const records = (service: Service) => service.trustStore.records as unknown as Record<string, unknown>[];
const slash = (path: string) => path.replaceAll("\\", "/");
const samePath = (path: unknown) => (typeof path !== "string" ? path : process.platform === "win32" ? slash(path).replace(/\/$/, "").toLowerCase() : slash(path).replace(/\/$/, ""));
const keysOf = (value: unknown) => Object.keys(value as object).sort();
// Hook names with their folder in the samePath form.
const hookFolders = (names: Record<string, unknown>[]) => names.map((n) => ({ event: n.event, folder: samePath(n.folder) }));

useFixtureRoot();

async function trustOf(service: Service, repositoryId: string): Promise<Trust> {
  const response = await service.readTrust(repositoryId);
  expect(outcome(response)).toEqual(SUCCEEDED);
  return response.result as unknown as Trust;
}

// Contract Δ7 `approveTrust {action}`: the envelope carries only `repositoryId`.
const approveTrust = (service: Service, repositoryId: string, action: string) => service.request<{ trustId: string; persistence: string; saveFailed: boolean }>("approveTrust", { action }, { repositoryId });

// A pre-commit hook that writes `name` into the canary folder.
function canaryHook(built: Built, repo: string, event: string, name: string): string {
  const log = join(built.root, "canaries", `${name}.log`);
  put(built.root, "canaries/.keep", "");
  putHook(repo, event, `: > ${shQuote(log)}\nexit 0\n`);
  return log;
}

function gitPaths(repo: string): { worktreeRoot: string; gitDirectory: string; commonDirectory: string } {
  const [worktreeRoot, gitDirectory, commonDirectory] = gitText(repo, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]).trimEnd().split("\n");
  return { worktreeRoot: worktreeRoot!, gitDirectory: gitDirectory!, commonDirectory: commonDirectory! };
}

// A new service session at application start with the same record store.
async function nextSession(service: Service, name: string, overrides: Partial<OpenOptions> = {}): Promise<Service> {
  await service.dispose();
  return openService({ git: gitPath(), name, trustStore: service.trustStore, ...overrides });
}

async function withSessions(name: string, body: (first: Service, set: (next: Service) => Service) => Promise<void>): Promise<void> {
  let current = await openService({ git: gitPath(), name });
  try {
    await body(current, (next) => (current = next));
  } finally {
    await current.dispose();
  }
}

// Stages the unstaged `multi.txt` hunks of F02, so a second commit has a staged change.
async function stageMulti(service: Service, repositoryId: string): Promise<void> {
  const c = await selectHunks(service, repositoryId, "multi.txt", "unstaged");
  expect(outcome(await applyHunk(service, repositoryId, c, c.hunkIds[0]!, "stage"))).toEqual(SUCCEEDED);
}

// The 001 history read on the feature 002 operations: open, load to the end, and one row read.
async function historyRead(service: Service, repositoryId: string): Promise<ServiceResponse> {
  const read = await readOk(service, repositoryId);
  const opened = await service.openHistory(repositoryId, read.generation);
  if (opened.state !== "succeeded") return opened;
  const viewId = opened.result!.viewId;
  const loaded = await service.request("loadHistory", { viewId, need: { end: true } }, { repositoryId });
  if (loaded.state !== "succeeded") return loaded;
  return service.request("readHistoryRows", { viewId, mode: "full", at: { row: 0 }, count: 100, text: "rows" }, { repositoryId });
}

// Contract Δ7: no trust listing runs phase 2, so no `fileFacts` request of a trust operation asks for a digest.
const trustDigests = (service: Service, operationIds: (string | undefined)[]) => service.runner.fileFactCalls.filter((c) => operationIds.includes(c.operationId) && c.digest).length;

describe("trust option (d) (spec FR-069 to FR-075, plan.md D12)", () => {
  caseTest(
    TASK,
    "SC-010: a full session without repository programs sends no confirm frame, and readTrust names no program",
    W,
    () =>
      withService({ name: "t051-no-programs" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t051-no-programs"));
        const { repositoryId } = await service.register(repo);
        expect(outcome(await historyRead(service, repositoryId))).toEqual(SUCCEEDED);
        expect(outcome(await service.request("readRefs", {}, { repositoryId, repositoryGeneration: (await readOk(service, repositoryId)).generation }))).toEqual(SUCCEEDED);
        const read = await service.readTrust(repositoryId);
        const trust = read.result as unknown as Trust;
        expect({ state: trust.state, approvalRequired: trust.approvalRequired, programs: trust.programs }).toEqual({
          state: "untrusted",
          approvalRequired: { reads: false, commit: false, sync: false, workbench: false },
          programs: NO_PROGRAMS,
        });
        // Contract Δ7: the readTrust result holds no fingerprint and no digest bound.
        expect({ fingerprint: "fingerprint" in trust, bound: "bound" in trust }).toEqual({ fingerprint: false, bound: false });
        await stageMulti(service, repositoryId);
        expect(outcome(await commit(service, repositoryId, await reviewOk(service, repositoryId), "no programs\n"))).toEqual(SUCCEEDED);
        expect(confirms(service)).toEqual([]);
        expect(trustDigests(service, [read.operationId])).toBe(0);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "US7 scenario 2: reads and the review of a repository with a pre-commit hook ask nothing, the commit refuses with TRUST_REQUIRED before any process, and Not now ends canceled with no Git process and no canary",
    W,
    () =>
      withService({ name: "t051-not-now" }, async (service) => {
        const built = buildF02(gitPath(), "t051-not-now");
        const repo = repoOf(built);
        const log = canaryHook(built, repo, "pre-commit", "t051-not-now");
        const hooks = gitPathOf(repo, "hooks");
        const { repositoryId } = await service.register(repo);
        await readOk(service, repositoryId);
        const read = await service.readTrust(repositoryId);
        const trust = read.result as unknown as Trust;
        expect({ state: trust.state, approvalRequired: trust.approvalRequired }).toEqual({ state: "untrusted", approvalRequired: { reads: false, commit: true, sync: true, workbench: false } });
        expect(hookFolders(trust.programs.hooks!.names)).toEqual([{ event: "pre-commit", folder: samePath(hooks) }]);
        const r = await reviewOk(service, repositoryId);
        const from = service.runner.calls.length;
        expect((await commit(service, repositoryId, r, "needs trust\n")).code).toBe("TRUST_REQUIRED");
        expect(commitCalls(service, from)).toEqual([]);
        expect(confirms(service)).toEqual([]);

        service.runner.inject.confirmResult = "declined";
        const declined = await approveTrust(service, repositoryId, "commit");
        expect(outcome(declined)).toEqual(CANCELED);
        const frames = confirms(service);
        expect(frames.length).toBe(1);
        const frame = frames[0]!;
        expect(keysOf(frame)).toEqual(FRAME_FIELDS);
        const paths = gitPaths(repo);
        expect({
          policyVersion: frame.policyVersion,
          action: frame.action,
          worktreeRoot: samePath(frame.worktreeRoot),
          adminDirectory: samePath(frame.adminDirectory),
          commonDirectory: samePath(frame.commonDirectory),
          gitSelectedPath: frame.gitSelectedPath,
          hooks: hookFolders(frame.details.hooks!.names),
        }).toEqual({
          policyVersion: 2,
          action: "commit",
          worktreeRoot: samePath(paths.worktreeRoot),
          adminDirectory: samePath(paths.gitDirectory),
          commonDirectory: samePath(paths.commonDirectory),
          gitSelectedPath: gitPath(),
          hooks: [{ event: "pre-commit", folder: samePath(hooks) }],
        });
        // Spec FR-072: after Not now, no Git process starts.
        expect(service.runner.calls.length).toBe(frame.callsBefore);
        expect({ canary: existsSync(log), records: records(service) }).toEqual({ canary: false, records: [] });
        expect((await trustOf(service, repositoryId)).state).toBe("untrusted");
        expect(trustDigests(service, [read.operationId, declined.operationId])).toBe(0);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "Trust stores one version 2 record without a fingerprint, the hook runs only after it, and the next session asks nothing",
    W,
    () =>
      withSessions("t051-trust", async (first, set) => {
        const built = buildF02(gitPath(), "t051-trust");
        const repo = repoOf(built);
        const log = canaryHook(built, repo, "pre-commit", "t051-trust");
        const { repositoryId } = await first.register(repo);
        const r = await reviewOk(first, repositoryId);
        expect((await commit(first, repositoryId, r, "first\n")).code).toBe("TRUST_REQUIRED");
        const approved = await approveTrust(first, repositoryId, "commit");
        expect({ ...outcome(approved), persistence: approved.result?.persistence, saveFailed: approved.result?.saveFailed }).toEqual({ ...SUCCEEDED, persistence: "stored", saveFailed: false });
        expect(confirms(first).length).toBe(1);
        expect(records(first).length).toBe(1);
        const record = records(first)[0]!;
        const paths = gitPaths(repo);
        expect(keysOf(record)).toEqual(V2_FIELDS);
        expect({
          policyVersion: record.policyVersion,
          worktreeRoot: samePath(record.worktreeRoot),
          adminDirectory: samePath(record.adminDirectory),
          commonDirectory: samePath(record.commonDirectory),
          git: record.gitSelectedPath,
        }).toEqual({ policyVersion: 2, worktreeRoot: samePath(paths.worktreeRoot), adminDirectory: samePath(paths.gitDirectory), commonDirectory: samePath(paths.commonDirectory), git: gitPath() });
        expect(existsSync(log)).toBe(false);
        expect(outcome(await commit(first, repositoryId, await reviewOk(first, repositoryId), "first\n"))).toEqual(SUCCEEDED);
        expect(existsSync(log)).toBe(true);
        expect(trustDigests(first, [approved.operationId])).toBe(0);

        const second = set(await nextSession(first, "t051-trust-next"));
        const next = await second.register(repo);
        expect((await trustOf(second, next.repositoryId)).state).toBe("approved");
        await stageMulti(second, next.repositoryId);
        expect(outcome(await commit(second, next.repositoryId, await reviewOk(second, next.repositoryId), "second\n"))).toEqual(SUCCEEDED);
        expect(confirms(second)).toEqual([]);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "FR-071: a rewritten hook and a new hook after approval ask nothing, and both run",
    W,
    () =>
      withService({ name: "t051-rewrite" }, async (service) => {
        const built = buildF02(gitPath(), "t051-rewrite");
        const repo = repoOf(built);
        canaryHook(built, repo, "pre-commit", "t051-rewrite-a");
        const { repositoryId } = await service.register(repo);
        expect(outcome(await approveTrust(service, repositoryId, "commit"))).toEqual(SUCCEEDED);
        expect(outcome(await commit(service, repositoryId, await reviewOk(service, repositoryId), "before rewrite\n"))).toEqual(SUCCEEDED);
        // As `git lfs install` or husky does: other bytes in an approved hook, and one more hook in the same folder.
        const rewritten = canaryHook(built, repo, "pre-commit", "t051-rewrite-b");
        const added = canaryHook(built, repo, "post-commit", "t051-rewrite-c");
        expect((await trustOf(service, repositoryId)).state).toBe("approved");
        await stageMulti(service, repositoryId);
        expect(outcome(await commit(service, repositoryId, await reviewOk(service, repositoryId), "after rewrite\n"))).toEqual(SUCCEEDED);
        expect({ rewritten: existsSync(rewritten), added: existsSync(added), confirms: confirms(service).length }).toEqual({ rewritten: true, added: true, confirms: 1 });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "FR-071: a moved worktree folder gives changed and TRUST_CHANGED before any process, and Trust asks once",
    W,
    () =>
      withSessions("t051-moved", async (first, set) => {
        const built = buildF02(gitPath(), "t051-moved");
        const repo = repoOf(built);
        const log = canaryHook(built, repo, "pre-commit", "t051-moved");
        expect(outcome(await approveTrust(first, (await first.register(repo)).repositoryId, "commit"))).toEqual(SUCCEEDED);
        await first.dispose();
        // A rename on one volume keeps the file IDs, so only the folder paths change.
        const moved = join(built.root, "repo-moved");
        renameSync(repo, moved);
        const second = set(await openService({ git: gitPath(), name: "t051-moved-next", trustStore: first.trustStore }));
        const { repositoryId } = await second.register(moved);
        expect((await trustOf(second, repositoryId)).state).toBe("changed");
        const from = second.runner.calls.length;
        expect((await commit(second, repositoryId, await reviewOk(second, repositoryId), "moved\n")).code).toBe("TRUST_CHANGED");
        expect({ commits: commitCalls(second, from), canary: existsSync(log) }).toEqual({ commits: [], canary: false });
        expect(outcome(await approveTrust(second, repositoryId, "commit"))).toEqual(SUCCEEDED);
        expect({ state: (await trustOf(second, repositoryId)).state, confirms: confirms(second).length, records: records(second).length }).toEqual({ state: "approved", confirms: 1, records: 1 });
        expect(samePath(records(second)[0]!.worktreeRoot)).toBe(samePath(moved));
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "FR-071: another selected Git path gives changed and TRUST_CHANGED before any process",
    W,
    () =>
      withSessions("t051-git-path", async (first, set) => {
        const built = buildF02(gitPath(), "t051-git-path");
        const repo = repoOf(built);
        canaryHook(built, repo, "pre-commit", "t051-git-path");
        expect(outcome(await approveTrust(first, (await first.register(repo)).repositoryId, "commit"))).toEqual(SUCCEEDED);
        // The file that `--exec-path` names is the same Git under another path.
        const other = join(gitText(built.root, ["--exec-path"]).trim(), process.platform === "win32" ? "git.exe" : "git");
        expect({ exists: existsSync(other), same: samePath(other) === samePath(gitPath()) }).toEqual({ exists: true, same: false });
        const second = set(await nextSession(first, "t051-git-path-next", { gitSelectedPath: other }));
        const { repositoryId } = await second.register(repo);
        expect((await trustOf(second, repositoryId)).state).toBe("changed");
        const from = second.runner.calls.length;
        expect((await commit(second, repositoryId, await reviewOk(second, repositoryId), "other git\n")).code).toBe("TRUST_CHANGED");
        expect(commitCalls(second, from)).toEqual([]);
        expect(confirms(second)).toEqual([]);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "plan.md O-5: a version 1 record gives changed and asks once, and its version 2 record replaces it",
    W,
    () =>
      withSessions("t051-v1", async (first, set) => {
        const built = buildF02(gitPath(), "t051-v1");
        const repo = repoOf(built);
        canaryHook(built, repo, "pre-commit", "t051-v1");
        expect(outcome(await approveTrust(first, (await first.register(repo)).repositoryId, "commit"))).toEqual(SUCCEEDED);
        // The 001 record form of the same worktree. Its fingerprint is the approved one when the store wrote a version 1 record.
        const stored = records(first)[0]!;
        const v1 = {
          commonDirectory: stored.commonDirectory,
          commonIdentity: stored.commonIdentity,
          worktreeRoot: stored.worktreeRoot,
          gitDirectory: stored.adminDirectory ?? stored.gitDirectory,
          worktreeIdentity: stored.worktreeIdentity,
          configurationFingerprint: stored.configurationFingerprint ?? "f".repeat(64),
          approvedAt: stored.approvedAt,
          gitSelectedPath: stored.gitSelectedPath,
        };
        first.trustStore.records = [v1 as never];
        const second = set(await nextSession(first, "t051-v1-second"));
        const { repositoryId } = await second.register(repo);
        expect((await trustOf(second, repositoryId)).state).toBe("changed");
        expect((await commit(second, repositoryId, await reviewOk(second, repositoryId), "v1\n")).code).toBe("TRUST_CHANGED");
        expect(outcome(await approveTrust(second, repositoryId, "commit"))).toEqual(SUCCEEDED);
        expect(confirms(second).length).toBe(1);
        expect(records(second).map((r) => ({ policyVersion: r.policyVersion, fingerprint: "configurationFingerprint" in r }))).toEqual([{ policyVersion: 2, fingerprint: false }]);

        const third = set(await nextSession(second, "t051-v1-third"));
        const next = await third.register(repo);
        expect((await trustOf(third, next.repositoryId)).state).toBe("approved");
        expect(outcome(await commit(third, next.repositoryId, await reviewOk(third, next.repositoryId), "v2\n"))).toEqual(SUCCEEDED);
        expect(confirms(third)).toEqual([]);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "FR-074: Stop trusting ends the lingering hook child and returns the count 1, and the next commit needs trust again",
    W,
    () =>
      withService({ name: "t051-stop" }, async (service) => {
        const repo = repoOf(buildF14(gitPath(), "t051-stop", "lingering"));
        const { repositoryId } = await service.register(repo);
        expect(outcome(await approveTrust(service, repositoryId, "commit"))).toEqual(SUCCEEDED);
        expect(outcome(await commit(service, repositoryId, await reviewOk(service, repositoryId), "lingering\n"))).toEqual(SUCCEEDED);
        expect(service.runner.liveRecorded()).toBe(1);
        const trust = await trustOf(service, repositoryId);
        const revoked = await service.revokeTrust(repositoryId, trust.trustId!);
        expect({ ...outcome(revoked), ended: revoked.result?.endedProcesses }).toEqual({ ...SUCCEEDED, ended: 1 });
        await until(() => service.runner.liveRecorded() === 0, "lingering child end", 5_000);
        expect({ state: (await trustOf(service, repositoryId)).state, records: records(service) }).toEqual({ state: "revoked", records: [] });
        put(repo, "after-revoke.txt", "x\n");
        gitText(repo, ["add", "--", "after-revoke.txt"]);
        expect((await commit(service, repositoryId, await reviewOk(service, repositoryId), "after revoke\n")).code).toBe("TRUST_REQUIRED");
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "plan.md D12: Stop trusting is unavailable while a mutation runs: it gives BUSY, changes nothing, and the commit completes",
    W,
    () =>
      withService({ name: "t051-stop-busy" }, async (service) => {
        const built = buildF02(gitPath(), "t051-stop-busy");
        const repo = repoOf(built);
        const gate = barrier(built.root, "pre-commit");
        putHook(repo, "pre-commit", gate.body);
        const { repositoryId } = await service.register(repo);
        expect(outcome(await approveTrust(service, repositoryId, "commit"))).toEqual(SUCCEEDED);
        const trustId = (await trustOf(service, repositoryId)).trustId!;
        const r = await reviewOk(service, repositoryId);
        const requestId = service.send("commit", commitPayload(r, "busy\n"), { repositoryId, repositoryGeneration: r.read.generation });
        try {
          await gate.reached();
          expect(outcome(await service.revokeTrust(repositoryId, trustId))).toEqual({ state: "rejected", code: "BUSY" });
          expect(records(service).length).toBe(1);
        } finally {
          gate.release();
        }
        expect(outcome(await service.response(requestId))).toEqual(SUCCEEDED);
        expect((await trustOf(service, repositoryId)).state).toBe("approved");
        expect(outcome(await service.revokeTrust(repositoryId, trustId))).toEqual(SUCCEEDED);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "FR-070 and plan.md D14: the details name programs by name and scope only, at most 20 names per kind, with no value and no credential",
    W,
    () =>
      withService({ name: "t051-details" }, async (service) => {
        const built = buildF02(gitPath(), "t051-details");
        const repo = repoOf(built);
        const config = (key: string, value: string) => gitText(repo, ["config", key, value]);
        for (let i = 0; i < 25; i++) config(`filter.f${String(i).padStart(2, "0")}.clean`, "secret-tool --token=ARBARETO-T051-VALUE");
        config("core.fsmonitor", "./t051-monitor.sh --token=ARBARETO-T051-VALUE");
        config("core.sshCommand", "ssh -i ARBARETO-T051-KEY");
        config("credential.https://user:ARBARETO-T051-PASSWORD@host.example.helper", "store");
        const { repositoryId } = await service.register(repo);
        const trust = await trustOf(service, repositoryId);
        expect({ names: trust.programs.filters!.names.length, more: trust.programs.filters!.more, first: trust.programs.filters!.names[0] }).toEqual({ names: 20, more: 5, first: { driver: "f00", scope: "local" } });
        expect(trust.programs.monitors).toEqual({ names: [{ scope: "local" }], more: 0 });
        expect(trust.programs.other!.names).toEqual([
          { key: "core.sshcommand", scope: "local" },
          { key: "credential.https://<redacted>@host.example.helper", scope: "local" },
        ]);
        service.runner.inject.confirmResult = "declined";
        expect(outcome(await approveTrust(service, repositoryId, "fetch"))).toEqual(CANCELED);
        const [frame] = confirms(service);
        expect({ action: frame!.action, details: frame!.details }).toEqual({ action: "fetch", details: trust.programs });
        // The 001 `entries` keep their value display allowlist (contract §7). The dialog details, `programs`, and the log carry no value.
        const text = JSON.stringify([frame, trust.programs, service.log()]);
        expect(["ARBARETO-T051-VALUE", "ARBARETO-T051-KEY", "ARBARETO-T051-PASSWORD", "secret-tool"].filter((secret) => text.includes(secret))).toEqual([]);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "plan.md D14: a name with a character of the Unicode general category Cc, Cf, Zl, or Zp, or with invalid UTF-8, shows as a fixed text in programs and in the dialog details",
    W,
    () =>
      withService({ name: "t051-hidden-names" }, async (service) => {
        const built = buildF02(gitPath(), "t051-hidden-names");
        const repo = repoOf(built);
        const config = (key: string, value: string) => gitText(repo, ["config", key, value]);
        // U+202E RIGHT-TO-LEFT OVERRIDE makes the rest of a name read from right to left.
        config("filter.lfs\u202eexe.clean", "cat");
        config("filter.\u2066x\u2069.clean", "cat");
        config("filter.plain.clean", "cat");
        config("hook.t051.command", "./t051-hook.sh");
        config("hook.t051.event", "pre-commit\u2066");
        // The bytes 0xff are no UTF-8, so the service decodes them with a replacement character.
        appendFileSync(gitPathOf(repo, "config"), Buffer.concat([Buffer.from('[filter "bad'), Buffer.from([0xff]), Buffer.from('"]\n\tclean = cat\n')]));
        const { repositoryId } = await service.register(repo);
        const trust = await trustOf(service, repositoryId);
        expect({ filters: trust.programs.filters, hooks: trust.programs.hooks }).toEqual({
          filters: {
            names: [
              { driver: UNSHOWN_NAME, scope: "local" },
              { driver: UNSHOWN_NAME, scope: "local" },
              { driver: "plain", scope: "local" },
              { driver: UNSHOWN_NAME, scope: "local" },
            ],
            more: 0,
          },
          hooks: { names: [{ event: UNSHOWN_NAME, scope: "local" }], more: 0 },
        });
        service.runner.inject.confirmResult = "declined";
        expect(outcome(await approveTrust(service, repositoryId, "commit"))).toEqual(CANCELED);
        const [frame] = confirms(service);
        expect(frame!.details).toEqual(trust.programs);
        const text = JSON.stringify([frame!.details, trust.programs]);
        expect([..."\u202e\u2066\u2069\ufffd"].filter((c) => text.includes(c)).map((c) => c.codePointAt(0)!.toString(16))).toEqual([]);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "FR-072: a read that needs trust never asks by itself, and Trust for the action read lets the read run",
    W,
    () =>
      withService({ name: "t051-read" }, async (service) => {
        const built = buildF02(gitPath(), "t051-read");
        const repo = repoOf(built);
        put(repo, ".gitattributes", "*.txt filter=t051\n");
        gitText(repo, ["config", "filter.t051.clean", "cat"]);
        const { repositoryId } = await service.register(repo);
        expect((await service.readWorkspace(repositoryId)).code).toBe("TRUST_REQUIRED");
        expect(confirms(service)).toEqual([]);
        const trust = await trustOf(service, repositoryId);
        expect({ reads: trust.approvalRequired.reads, filters: trust.programs.filters }).toEqual({ reads: true, filters: { names: [{ driver: "t051", scope: "local" }], more: 0 } });
        expect(outcome(await approveTrust(service, repositoryId, "read"))).toEqual(SUCCEEDED);
        expect(confirms(service).map((f) => f.action)).toEqual(["read"]);
        expect(outcome(await service.readWorkspace(repositoryId))).toEqual(SUCCEEDED);
      }),
    TIMEOUT_MS,
  );
});
