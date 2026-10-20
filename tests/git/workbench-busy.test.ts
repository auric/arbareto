// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T097: a second mutation of the same repository while a feature 004 mutation runs gives BUSY (spec FR-001, contract §5).
// The runner double holds the first mutation at its Git step, so the order of the requests is exact.

import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { useFixtureRoot } from "./fixture-root";
import { workingFileDigests } from "./git-oracle";
import { commitPayload, entryOf, readOk, reviewOk, subcommand } from "./hunk-harness";
import { caseTest, keepConfigs, type RegistrationResult, type Service, type ServiceResponse } from "./service-harness";
import { gitExe, native, TIMEOUT_MS, until, withSync } from "./sync-harness";
import { buildWorkbench, repoOf, wb, type WbFixture } from "./workbench-fixtures";

for (const module of ["exclusion", "workbench-review", "session"]) {
  printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
}
useFixtureRoot();

const TASK = "T097";
const SHELL = ["shell-double"] as const;
const SUCCEEDED = { state: "succeeded", code: undefined };
const BUSY = { state: "rejected", code: "BUSY" };
const outcome = (r: { state: string; code?: string }) => ({ state: r.state, code: r.code });

let builds = 0;
const git = (f: WbFixture, args: string[], allowExit: number[] = [0]) => wb(repoOf(f), args, { allowExit }).stdout.toString("utf8");

// `merge-diverged` with a staged file for `reviewCommit` and an untracked file for `applyFiles`.
function build(): WbFixture {
  const f = buildWorkbench(gitExe(), "merge-diverged", `t097-${++builds}`);
  writeFileSync(join(f.repo, "staged.txt"), "staged\n");
  git(f, ["add", "--", "staged.txt"]);
  writeFileSync(join(f.repo, "new.txt"), "new\n");
  return f;
}

// HEAD, every ref, the index, and every working byte.
function stateOf(f: WbFixture) {
  return {
    head: git(f, ["symbolic-ref", "-q", "HEAD"], [0, 1]).trim(),
    refs: git(f, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    index: git(f, ["ls-files", "-s", "-z"]),
    files: workingFileDigests(f.repo),
  };
}

// The fixture runs no repository program, so approval is needed only if the trust listing says so.
async function open(service: Service, f: WbFixture): Promise<RegistrationResult> {
  const r = await service.register(native(f.repo));
  const trust = await service.readTrust(r.repositoryId);
  if (trust.result!.approvalRequired.workbench) expect((await service.approveTrust(r.repositoryId)).state).toBe("succeeded");
  return r;
}

async function tokenOf(service: Service, r: RegistrationResult, payload: object): Promise<string> {
  const response = await service.request<{ workbenchToken: string }>("reviewWorkbench", payload, { repositoryId: r.repositoryId, repositoryGeneration: r.generation });
  expect(outcome(response)).toEqual(SUCCEEDED);
  return response.result!.workbenchToken;
}

const sendRun = (service: Service, r: RegistrationResult, token: string) => service.send("runWorkbench", { workbenchToken: token, start: true }, { repositoryId: r.repositoryId });
const MERGE = { action: "merge", ref: "refs/heads/topic", result: "merge", noFastForward: false, noCommit: false, message: null };
const SWITCH = { action: "switch", target: { ref: "refs/heads/other" }, choice: "keep" };
const isMerge = (call: { arguments: readonly string[] }) => subcommand(call.arguments) === "merge";
const isUpdateIndex = (call: { arguments: readonly string[] }) => subcommand(call.arguments) === "update-index";

// The second request gives BUSY and changes nothing. `reads`: the Git subcommands that it starts before the exclusion refuses it.
async function refused(service: Service, f: WbFixture, send: () => Promise<ServiceResponse<unknown>>, label: string, reads: string[] = []): Promise<void> {
  const before = stateOf(f);
  const from = service.runner.calls.length;
  const response = await send();
  expect({ label, ...outcome(response) }).toEqual({ label, ...BUSY });
  const started = service.runner.calls.slice(from);
  expect({ label, subcommands: started.map((c) => subcommand(c.arguments)), own: started.every((c) => c.operationId === response.operationId) }).toEqual({ label, subcommands: reads, own: true });
  expect({ label, state: stateOf(f) }).toEqual({ label, state: before });
}

caseTest(TASK, "FR-001: while a runWorkbench merge runs, a second runWorkbench, an applyFiles, and a commit of the same repository give BUSY, start no mutating Git process, and change nothing", SHELL, async () => {
  const f = build();
  await withSync("t097-merge-first", (s) =>
    keepConfigs(s, async (service) => {
      const r = await open(service, f);
      const read = await readOk(service, r.repositoryId);
      const commit = await reviewOk(service, r.repositoryId, read);
      const second = await tokenOf(service, r, SWITCH);
      const first = await tokenOf(service, r, MERGE);
      const release = service.runner.holdStart(isMerge);
      const requestId = sendRun(service, r, first);
      try {
        await until(() => service.runner.calls.some(isMerge), "held merge");
        await refused(service, f, () => service.response(sendRun(service, r, second)), "runWorkbench");
        const entry = entryOf(read, "new.txt", "untracked");
        // `multi-publish.ts` `decide` reads the trust listing and the attributes before `publish` enters the exclusion. These reads write nothing.
        await refused(service, f, () => service.request("applyFiles", { snapshotId: read.snapshotId, entryIds: [entry.entryId], direction: "stage", kind: "selected" }, { repositoryId: r.repositoryId }), "applyFiles", ["config", "rev-parse", "check-attr"]);
        await refused(service, f, () => service.request("commit", commitPayload(commit, "second\n"), { repositoryId: r.repositoryId, repositoryGeneration: read.generation }), "commit");
        // A Cancel before the held process starts leaves the repository as it was.
        await service.cancel(await service.operationId(requestId));
      } finally {
        release();
      }
      expect(outcome(await service.response(requestId))).toEqual({ state: "canceled", code: "CANCELED" });
    }),
  );
}, TIMEOUT_MS);

caseTest(TASK, "FR-001: while an applyFiles runs, a runWorkbench of the same repository gives BUSY and starts no Git process", SHELL, async () => {
  const f = build();
  await withSync("t097-apply-first", (s) =>
    keepConfigs(s, async (service) => {
      const r = await open(service, f);
      const read = await readOk(service, r.repositoryId);
      const token = await tokenOf(service, r, SWITCH);
      const release = service.runner.holdStart(isUpdateIndex);
      const entry = entryOf(read, "new.txt", "untracked");
      const requestId = service.send("applyFiles", { snapshotId: read.snapshotId, entryIds: [entry.entryId], direction: "stage", kind: "selected" }, { repositoryId: r.repositoryId });
      try {
        await until(() => service.runner.calls.some(isUpdateIndex), "held update-index");
        await refused(service, f, () => service.response(sendRun(service, r, token)), "runWorkbench");
      } finally {
        release();
      }
      expect(outcome(await service.response(requestId))).toEqual(SUCCEEDED);
      expect(git(f, ["ls-files", "--", "new.txt"])).toBe("new.txt\n");
    }),
  );
}, TIMEOUT_MS);
