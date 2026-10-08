// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T229: the `submoduleNotice` of `readWorkspace` (contract §12 "Discovery notice", "Review reads", §11 "Paths and file access").

import { describe, expect } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FileFact } from "../../src/contracts/channel";
import { gitmodulesHeadArgs, gitmodulesIndexArgs } from "../../src/git-service/commands";
import { probeGit } from "../../src/git-service/git-installation";
import type { FileFactsRequest, GitRunner } from "../../src/git-service/git-runner";
import { createRegistrations } from "../../src/git-service/registration";
import { createWorkspaceReader } from "../../src/git-service/status";
import { createTrust } from "../../src/git-service/trust";
import { printOrigin } from "../origin";
import { serviceEnv, useFixtureRoot } from "./fixture-root";
import { buildF27, buildF28, type Built } from "./fixtures";
import { gitPath, readOk, TIMEOUT_MS, valuesOf } from "./hunk-harness";
import { caseTest, withFsCalls, type Capability, type Service } from "./service-harness";
import { fixtureGit, globalEnv, superOf, withFixture } from "./submodule-harness";

printOrigin("../../src/git-service/status.ts", import.meta.dir);
printOrigin("../../src/git-service/submodule-review.ts", import.meta.dir);

const TASK = "T229";
const SHELL: Capability[] = ["shell-double"];

useFixtureRoot();

type Notice = { count: number; paths: string[]; filter: "applied" | "skipped" };
const noticeOf = (value: unknown) => valuesOf(value, "submoduleNotice")[0] as Notice | undefined;
const gitArgs = (service: Service) => service.runner.calls.map((c) => c.arguments);
// The fs calls of the service that name a `.git` or `.gitmodules` entry.
const entryCalls = (calls: { name: string; path: string }[]) => calls.filter((c) => /[\\/]\.git(?:modules)?$/.test(c.path));

// A read through `createWorkspaceReader` with the runner of the service, and with `fileFacts` replaced by `facts`.
async function directRead(service: Service, b: Built, facts: GitRunner["fileFacts"]) {
  const git = gitPath();
  const probed = await probeGit(service.runner, { bootstrapId: service.runner.addContext("gitProbe", git), executablePath: git });
  if (!("installation" in probed)) throw new Error(`probe failed: ${JSON.stringify(probed)}`);
  const { installation } = probed;
  const signal = new AbortController().signal;
  const runner: GitRunner = { ...service.runner, fileFacts: facts };
  const registrations = createRegistrations({ runner, unfinishedMutation: () => false });
  const registered = await registrations.register({ operationId: crypto.randomUUID(), bootstrapId: service.runner.addContext("repositoryDiscovery", superOf(b)), installation, signal });
  if (!registered.ok || !("repositoryId" in registered.result)) throw new Error(`registration failed: ${JSON.stringify(registered)}`);
  const workspace = registrations.get(registered.result.repositoryId)!;
  const reader = createWorkspaceReader({ runner, trust: createTrust({ runner, environment: serviceEnv(globalEnv(b)) }) });
  return withFsCalls(() => reader.readWorkspace({ operationId: crypto.randomUUID(), signal, installation, workspace, refresh: false }));
}

describe("notice file checks (contract §12 \"Discovery notice\")", () => {
  caseTest(TASK, "the .git checks go through one fileFacts request with digest false, and the service stats no .git entry", SHELL, () => {
    const b = buildF27(gitPath(), "t229-notice-facts", "base");
    fixtureGit(b, superOf(b), ["submodule", "update", "--init", "--", "solo"]);
    return withFixture(b, "t229-notice-facts", async (service) => {
      const { repositoryId } = await service.register(superOf(b));
      const { value: read, calls } = await withFsCalls(() => readOk(service, repositoryId));
      expect(noticeOf(read)).toEqual({ count: 1, paths: ["mid"], filter: "applied" });
      const notice = service.runner.fileFactCalls.filter((c) => c.files.some((f) => f.path.at(-1) === ".git"));
      expect(notice.map((c) => ({ digest: c.digest, files: c.files }))).toEqual([
        { digest: false, files: [{ root: "worktreeRoot", path: ["mid", ".git"] }, { root: "worktreeRoot", path: ["solo", ".git"] }] },
      ]);
      expect(entryCalls(calls)).toEqual([]);
    });
  }, TIMEOUT_MS);

  // §11: in WSL, `a/sub` with `a` a symbolic link gives porcelain `1 AD`. The walk never follows the link, so the gitlink counts.
  caseTest(TASK, "a link before the last component means no .git entry, so the gitlink counts", SHELL, () => {
    const b = buildF27(gitPath(), "t229-notice-link", "base");
    fixtureGit(b, superOf(b), ["submodule", "update", "--init", "--", "solo"]);
    return withFixture(b, "t229-notice-link", async (service) => {
      const requests: FileFactsRequest[] = [];
      const facts = async (request: FileFactsRequest, signal: AbortSignal) => {
        requests.push(request);
        const reply = await service.runner.fileFacts(request, signal);
        if (!Array.isArray(reply)) return reply;
        return reply.map((fact, i): FileFact => (request.files[i]!.path.join("/") === "solo/.git" ? { kind: "link", component: 1, tag: "symlink", target: "elsewhere", relative: true } : fact));
      };
      const { value, calls } = await directRead(service, b, facts);
      expect(value.result).toBe("succeeded");
      expect(noticeOf(value)).toEqual({ count: 2, paths: ["mid", "solo"], filter: "applied" });
      expect(requests.filter((r) => r.files.some((f) => f.path.at(-1) === ".git")).map((r) => r.digest)).toEqual([false]);
      expect(entryCalls(calls)).toEqual([]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "a final link at the .git entry counts as an entry, so the gitlink does not count", SHELL, () => {
    const b = buildF27(gitPath(), "t229-notice-final-link", "base");
    return withFixture(b, "t229-notice-final-link", async (service) => {
      const facts = async (request: FileFactsRequest, signal: AbortSignal) => {
        const reply = await service.runner.fileFacts(request, signal);
        if (!Array.isArray(reply)) return reply;
        return reply.map((fact, i): FileFact => (request.files[i]!.path.join("/") === "solo/.git" ? { kind: "link", component: 2, tag: "symlink", target: "elsewhere", relative: true } : fact));
      };
      const { value } = await directRead(service, b, facts);
      expect(noticeOf(value)).toEqual({ count: 1, paths: ["mid"], filter: "applied" });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "an error fact gives REPOSITORY_UNAVAILABLE", SHELL, () => {
    const b = buildF27(gitPath(), "t229-notice-error", "base");
    return withFixture(b, "t229-notice-error", async (service) => {
      const facts = async (request: FileFactsRequest, signal: AbortSignal) => {
        const reply = await service.runner.fileFacts(request, signal);
        if (!Array.isArray(reply)) return reply;
        return reply.map((fact, i): FileFact => (request.files[i]!.path.join("/") === "solo/.git" ? { kind: "error", component: 1, code: "access-denied" } : fact));
      };
      const { value } = await directRead(service, b, facts);
      expect(value).toMatchObject({ result: "failed", code: "REPOSITORY_UNAVAILABLE" });
    });
  }, TIMEOUT_MS);
});

describe("notice name filter (contract §12 \"Discovery notice\", \"Review reads\")", () => {
  caseTest(TASK, "a broken worktree .gitmodules skips the name filter and leaves the read complete", SHELL, () => {
    const b = buildF28(gitPath(), "t229-notice-broken", "inactive");
    writeFileSync(join(superOf(b), ".gitmodules"), "[submodule \"mid\"]\n\tpath = mid\n[submodule\n");
    return withFixture(b, "t229-notice-broken", async (service) => {
      const { repositoryId } = await service.register(superOf(b));
      const read = await readOk(service, repositoryId);
      expect(read.completeness).toEqual({ state: "complete" });
      expect(noticeOf(read)).toEqual({ count: 2, paths: ["mid", "solo"], filter: "skipped" });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "without a worktree .gitmodules, the filter reads the index blob by its object ID", SHELL, () => {
    const b = buildF28(gitPath(), "t229-notice-index", "inactive");
    const oid = fixtureGit(b, superOf(b), ["rev-parse", ":.gitmodules"]).trim();
    rmSync(join(superOf(b), ".gitmodules"));
    return withFixture(b, "t229-notice-index", async (service) => {
      const { repositoryId } = await service.register(superOf(b));
      const read = await readOk(service, repositoryId);
      expect(noticeOf(read)).toEqual({ count: 1, paths: ["mid"], filter: "applied" });
      const args = gitArgs(service);
      expect(args.filter((a) => a.includes("--blob"))).toEqual([gitmodulesIndexArgs(oid, "sha1")]);
      expect(args.flat().filter((a) => a.startsWith(":"))).toEqual([]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "without a worktree or index .gitmodules, the filter reads the HEAD blob", SHELL, () => {
    const b = buildF28(gitPath(), "t229-notice-head", "inactive");
    fixtureGit(b, superOf(b), ["rm", "-q", "--cached", "--", ".gitmodules"]);
    rmSync(join(superOf(b), ".gitmodules"));
    return withFixture(b, "t229-notice-head", async (service) => {
      const { repositoryId } = await service.register(superOf(b));
      const read = await readOk(service, repositoryId);
      expect(noticeOf(read)).toEqual({ count: 1, paths: ["mid"], filter: "applied" });
      const args = gitArgs(service);
      expect(args.filter((a) => a.includes("--blob"))).toEqual([gitmodulesHeadArgs()]);
      expect(args.flat().filter((a) => a.startsWith(":"))).toEqual([]);
    });
  }, TIMEOUT_MS);
});
