// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { splitIndexLink } from "../../src/git-service/eligibility";
import { printOrigin } from "../origin";
import { FIXTURE_GLOBAL_CONFIG, FIXTURE_ROOT, fixtureDir, ownedGit, serviceEnv, useFixtureRoot } from "./fixture-root";
import { buildF02, buildF10, put, type Built } from "./fixtures";
import { GIT } from "./git-binary";
import { caseTest, openService, type OpenOptions, type Service, type WorkspaceResult } from "./service-harness";

printOrigin("../../src/git-service/eligibility.ts", import.meta.dir);

const TASK = "T190";
const TIMEOUT_MS = 120_000;

useFixtureRoot();

const gitPath = (): string => {
  if (GIT === null) throw new Error("Git executable absent");
  return GIT;
};
const slash = (path: string) => path.replaceAll("\\", "/");
const repoOf = (built: Built) => join(built.root, "repo");
const git = (repo: string, args: string[], allowExit?: number[]) => ownedGit(gitPath(), FIXTURE_ROOT, repo, args, allowExit === undefined ? {} : { allowExit }).toString("utf8");
const gitPathOf = (repo: string, name: string) => resolve(repo, git(repo, ["rev-parse", "--git-path", name]).trim());
const rawIndex = (repo: string) => new Uint8Array(readFileSync(gitPathOf(repo, "index")));

// Git `Documentation/gitformat-index.adoc`: a split index names `sharedindex.<hash>` in its Git directory.
const sharedIndexFiles = (repo: string) => readdirSync(git(repo, ["rev-parse", "--absolute-git-dir"]).trim()).filter((name) => name.startsWith("sharedindex."));

describe("splitIndexLink (contract §4 \"Split index\")", () => {
  caseTest(
    TASK,
    "F10 split-index: the raw link extension gives the hash of the shared index file",
    [],
    () => {
      const repo = repoOf(buildF10(gitPath(), "t190-link", "split-index"));
      // Oracle only. The service never asks Git for this path (contract §6).
      const shared = basename(git(repo, ["rev-parse", "--shared-index-path"]).trim());
      expect(shared).toMatch(/^sharedindex\.[0-9a-f]{40}$/);
      expect(sharedIndexFiles(repo)).toEqual([shared]);
      expect(splitIndexLink(rawIndex(repo))).toBe(shared.slice("sharedindex.".length));
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "F02: a full index without a link extension gives null",
    [],
    () => {
      const repo = repoOf(buildF02(gitPath(), "t190-no-link"));
      expect(sharedIndexFiles(repo)).toEqual([]);
      expect(splitIndexLink(rawIndex(repo))).toBeNull();
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "F10 split-config: core.splitIndex=true with an unsplit index gives null, because the state comes from the raw bytes",
    [],
    () => {
      const repo = repoOf(buildF10(gitPath(), "t190-split-config", "split-config"));
      expect(git(repo, ["config", "--local", "core.splitIndex"]).trim()).toBe("true");
      expect(splitIndexLink(rawIndex(repo))).toBeNull();
    },
    TIMEOUT_MS,
  );
});

// A logging canary outside the worktree. It exits 1, so Git treats a monitor answer as a failure.
function canary(built: Built, name: string): { command: string; log: string } {
  const log = join(built.root, "canaries", `t190-${name}.log`);
  const script = put(built.root, `canaries/t190-${name}.sh`, `#!/bin/sh\necho "${name} $*" >> '${slash(log)}'\nexit 1\n`);
  chmodSync(script, 0o755);
  return { command: `'${slash(script)}'`, log };
}

async function withService(options: Omit<OpenOptions, "git">, body: (service: Service) => Promise<void>): Promise<void> {
  const service = await openService({ git: gitPath(), ...options });
  try {
    await body(service);
  } finally {
    await service.dispose();
  }
}

async function approve(service: Service, repositoryId: string): Promise<void> {
  const trust = await service.readTrust(repositoryId);
  expect(trust.state).toBe("succeeded");
  expect((await service.approveTrust(repositoryId, trust.result!.fingerprint, trust.result!.generation)).state).toBe("succeeded");
}

// One full read. Returns the result and the argument arrays of the Git calls that the read started.
async function readOnce(service: Service, repositoryId: string): Promise<{ result: WorkspaceResult; calls: string[] }> {
  const before = service.runner.calls.length;
  const response = await service.readWorkspace(repositoryId);
  expect({ state: response.state, code: response.code }).toEqual({ state: "succeeded", code: undefined });
  return { result: response.result!, calls: service.runner.calls.slice(before).map((c) => c.arguments.join(" ")).sort() };
}

const UNSUPPORTED = (reason: Extract<WorkspaceResult["hunkEligibility"], { eligible: false }>["reason"]) => ({ eligible: false, reason });

describe("hunk eligibility profiles (contract §4, data-model §2)", () => {
  caseTest(
    TASK,
    "an ordinary F02 copy is eligible",
    ["windows-shell-double"],
    () =>
      withService({ name: "t190-plain" }, async (service) => {
        const { repositoryId } = await service.register(repoOf(buildF02(gitPath(), "t190-plain")));
        expect((await readOnce(service, repositoryId)).result.hunkEligibility).toEqual({ eligible: true });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "index.sparse=true at local scope gives reason sparse-index",
    ["windows-shell-double"],
    () =>
      withService({ name: "t190-sparse" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t190-sparse"));
        git(repo, ["config", "--local", "index.sparse", "true"]);
        const { repositoryId } = await service.register(repo);
        expect((await readOnce(service, repositoryId)).result.hunkEligibility).toEqual(UNSUPPORTED("sparse-index"));
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a split index gives reason split-index from the raw link extension, and no call asks Git for the shared index path",
    ["windows-shell-double"],
    () =>
      withService({ name: "t190-split" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t190-split"));
        git(repo, ["update-index", "--split-index"]);
        expect(sharedIndexFiles(repo).length).toBe(1);
        const { repositoryId } = await service.register(repo);
        expect((await readOnce(service, repositoryId)).result.hunkEligibility).toEqual(UNSUPPORTED("split-index"));
        expect(service.runner.calls.filter((c) => c.arguments.includes("--shared-index-path"))).toEqual([]);
      }),
    TIMEOUT_MS,
  );

  // The plain F02 read gives the reference call set. The split check reads the configuration listing, so it adds no call.
  async function plainCalls(): Promise<string[]> {
    let calls: string[] = [];
    await withService({ name: "t190-reference" }, async (service) => {
      const { repositoryId } = await service.register(repoOf(buildF02(gitPath(), "t190-reference")));
      calls = (await readOnce(service, repositoryId)).calls;
    });
    return calls;
  }

  caseTest(
    TASK,
    "core.splitIndex=true at local scope with an unsplit index gives reason split-index, and the check starts no process",
    ["windows-shell-double"],
    async () => {
      const reference = await plainCalls();
      await withService({ name: "t190-split-local" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t190-split-local"));
        git(repo, ["config", "--local", "core.splitIndex", "true"]);
        const { repositoryId } = await service.register(repo);
        const { result, calls } = await readOnce(service, repositoryId);
        expect(result.hunkEligibility).toEqual(UNSUPPORTED("split-index"));
        expect(calls).toEqual(reference);
        expect(sharedIndexFiles(repo)).toEqual([]);
      });
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "core.splitIndex=true at global scope with an unsplit index gives reason split-index, and the check starts no process",
    ["windows-shell-double"],
    async () => {
      const reference = await plainCalls();
      // The owned global file serves every fixture of this run, so this case uses its own global file (fixtures.ts `buildF10` notes).
      const global = join(fixtureDir("t190-split-global-home"), ".gitconfig");
      writeFileSync(global, `${readFileSync(FIXTURE_GLOBAL_CONFIG, "utf8")}[core]\n\tsplitIndex = true\n`);
      await withService({ name: "t190-split-global", environment: serviceEnv({ GIT_CONFIG_GLOBAL: global }) }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t190-split-global"));
        const { repositoryId } = await service.register(repo);
        const { result, calls } = await readOnce(service, repositoryId);
        expect(result.hunkEligibility).toEqual(UNSUPPORTED("split-index"));
        expect(calls).toEqual(reference);
        expect(sharedIndexFiles(repo)).toEqual([]);
      });
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a post-index-change hook gives reason index-change-hook, and its canary never runs",
    ["windows-shell-double"],
    () =>
      withService({ name: "t190-hook" }, async (service) => {
        const built = buildF02(gitPath(), "t190-hook");
        const repo = repoOf(built);
        const { command, log } = canary(built, "post-index-change");
        const hook = join(gitPathOf(repo, "hooks"), "post-index-change");
        writeFileSync(hook, `#!/bin/sh\nexec ${command} "$@"\n`);
        chmodSync(hook, 0o755);
        const { repositoryId } = await service.register(repo);
        expect((await readOnce(service, repositoryId)).result.hunkEligibility).toEqual(UNSUPPORTED("index-change-hook"));
        expect(existsSync(log)).toBe(false);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a disabled post-index-change registration gives reason index-change-hook, and its canary never runs",
    ["windows-shell-double"],
    () =>
      withService({ name: "t190-hook-disabled" }, async (service) => {
        const built = buildF02(gitPath(), "t190-hook-disabled");
        const repo = repoOf(built);
        const { command, log } = canary(built, "registration");
        // git-config(1) `hook.<friendly-name>.enabled`.
        git(repo, ["config", "--local", "hook.t190.command", command]);
        git(repo, ["config", "--local", "hook.t190.event", "post-index-change"]);
        git(repo, ["config", "--local", "hook.t190.enabled", "false"]);
        const { repositoryId } = await service.register(repo);
        expect((await readOnce(service, repositoryId)).result.hunkEligibility).toEqual(UNSUPPORTED("index-change-hook"));
        expect(existsSync(log)).toBe(false);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a command-valued core.fsmonitor after trust approval gives reason executable-monitor, and its canary never runs before approval",
    ["windows-shell-double"],
    () =>
      withService({ name: "t190-monitor" }, async (service) => {
        const built = buildF02(gitPath(), "t190-monitor");
        const repo = repoOf(built);
        const { command, log } = canary(built, "fsmonitor");
        git(repo, ["config", "--local", "core.fsmonitor", command]);
        const { repositoryId } = await service.register(repo);
        await approve(service, repositoryId);
        expect(existsSync(log)).toBe(false);
        expect((await readOnce(service, repositoryId)).result.hunkEligibility).toEqual(UNSUPPORTED("executable-monitor"));
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "the built-in core.fsmonitor=true gives the unqualified-monitor reason, needs no approval, and reads still run",
    ["windows-shell-double"],
    () =>
      withService({ name: "t190-builtin-monitor" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t190-builtin-monitor"));
        git(repo, ["config", "--local", "core.fsmonitor", "true"]);
        try {
          const { repositoryId } = await service.register(repo);
          const trust = await service.readTrust(repositoryId);
          expect(trust.result?.approvalRequired.reads).toBe(false);
          const { result } = await readOnce(service, repositoryId);
          expect({ eligibility: result.hunkEligibility, completeness: result.completeness.state }).toEqual({ eligibility: UNSUPPORTED("unqualified-monitor"), completeness: "complete" });
        } finally {
          // A read can start Git's daemon (contract §7). The shell double has no Job, so the test stops it.
          git(repo, ["fsmonitor--daemon", "stop"], [0, 1, 128]);
        }
      }),
    TIMEOUT_MS,
  );
});
