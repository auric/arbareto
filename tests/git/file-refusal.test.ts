// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T197: `applyFile` refusals, races, and outcomes (contract §4 "File staging", "Blob proof", §5, §8, §9). `src/git-service/file-publish.ts` comes with T200.
// The checkpoint observer is the T110 seam `hunkCheckpoint`: 5 after the Git step, 11 after the final recheck, 13 after publication.

import { describe, expect, spyOn } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { APPROVAL_LIFETIME_MS } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import { fixtureEnv, serviceEnv, useFixtureRoot } from "./fixture-root";
import { buildChanged, buildF02, buildF04, buildF04Stage, buildF05, buildF07, buildF10, buildF16StageInput, buildFileAccepted, put, type Built, type F04StageVariant, type F10Variant } from "./fixtures";
import { indexEntries } from "./git-oracle";
import {
  approve,
  candidateFiles,
  compare,
  copyRepo,
  git,
  gitDirOf,
  gitPath,
  gitPathOf,
  gitText,
  LOCKED_REMEDY,
  mutationFrames,
  one,
  outcome,
  psQuote,
  readOk,
  repoOf,
  repoState,
  shortDeadline,
  subcommand,
  SUCCEEDED,
  TIMEOUT_MS,
  todoCase,
  until,
  valuesOf,
  withService,
  type Comparison,
  type Direction,
} from "./hunk-harness";
import { caseTest, openService, type Capability, type ChangeEntry, type Envelope, type HunkCheckpoint, type OpenOptions, type Refusal, type Service, type ServiceResponse } from "./service-harness";

const TASK = "T197";
const RECOVERY = "(needs T200/T114/T115)";
const SHELL: Capability[] = ["shell-double"];

useFixtureRoot();

// Prints the ORIGIN line of the module under test and loads it. Before T200, the module is missing, and this throws.
async function underTest(): Promise<unknown> {
  const module = "file-publish";
  printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
  return import(`../../src/git-service/${module}.ts`);
}

// Contract §3 `applyFile`: comparison ID, snapshot ID, and direction.
function applyFile(service: Service, repositoryId: string, c: Comparison, direction: Direction, envelope: Envelope = {}): Promise<ServiceResponse> {
  return service.request("applyFile", { comparisonId: c.comparisonId, snapshotId: c.read.snapshotId, direction }, { repositoryId, repositoryGeneration: c.read.generation, ...envelope });
}

// Contract §4 "Limitation remedies".
const REMEDY_TEXT = "This command stages or unstages the whole file with your Git settings. Run it in a terminal.";
// Contract §4 "Blob proof".
const BLOB_PROOF_TEXT = "Arbareto cannot prove the staged content of this file. The file can have changed during staging, or Git's conversion can depend on the index. Use the command in a terminal.";
const addRemedy = (root: string, path: string) => `& ${psQuote(gitPath())} --literal-pathspecs -C ${psQuote(root)} add -- ${psQuote(path)}`;
// Contract §9 "Commit failure output".
const TAIL_BYTES = 16 * 1024;
const TAIL_LINES = 100;
// C0 controls except TAB and LF, DEL, and C1 controls.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

type Result = Refusal & { reason?: string; outputTail?: string };
type Recovery = { outcome: string; attribution?: { result: string; reason?: string }; indexMatch?: string };

const code = (response: ServiceResponse) => response.code;
const sharedIndexFiles = (repo: string) => readdirSync(gitDirOf(repo)).filter((name) => name.startsWith("sharedindex.")).sort();
const refresh = (service: Service, repositoryId: string) => service.readWorkspace(repositoryId, { refresh: true, check: "full" });
const callsOf = (service: Service, operationId: string) => service.runner.calls.filter((c) => c.operationId === operationId);

// Runs `request` and checks the T197 invariants: unchanged canonical index bytes, unchanged working bytes, and no remaining owned candidate file.
// `baseline` holds the state that the case expects to stay. A writer during the request resets it.
async function refused(service: Service, repo: string, request: () => Promise<ServiceResponse>, baseline = { state: repoState(repo) }): Promise<ServiceResponse<Result>> {
  const response = await request();
  const after = repoState(repo);
  expect({ rawIndex: after.rawIndex, files: after.files, candidates: candidateFiles(repo) }).toEqual({ rawIndex: baseline.state.rawIndex, files: baseline.state.files, candidates: [] });
  return response as ServiceResponse<Result>;
}

// One open service with a checkpoint hook per step. Each hook runs once.
type Hooks = Partial<Record<HunkCheckpoint["step"], (checkpoint: HunkCheckpoint) => Promise<void> | void>>;
async function withObserver(name: string, body: (service: Service, hooks: Hooks) => Promise<void>, options: Omit<OpenOptions, "git" | "name"> = {}): Promise<void> {
  const hooks: Hooks = {};
  const hunkCheckpoint = async (checkpoint: HunkCheckpoint) => {
    const hook = hooks[checkpoint.step];
    if (hook === undefined) return;
    delete hooks[checkpoint.step];
    await hook(checkpoint);
  };
  await withService({ name, hunkCheckpoint, ...options }, (service) => body(service, hooks));
}

// Runs `onStart` at the start barrier of each Git process whose subcommand is `name`, before the process starts.
function atStart(service: Service, name: string, onStart: () => void): void {
  service.runner.holdStart((call) => {
    if (subcommand(call.arguments) === name) onStart();
    return false;
  });
}

// Gives every Git process that starts while `on` holds a 1 ms deadline. Clearing `on` also clears the walk deadline.
function deadlines(service: Service): { on: boolean; off(): void } {
  const state = {
    on: false,
    off() {
      state.on = false;
      service.runner.inject.deadlineMs = null;
    },
  };
  service.runner.holdStart(() => {
    service.runner.inject.deadlineMs = state.on ? 1 : null;
    return false;
  });
  return state;
}

// The changed base: `staged.txt` staged, two unstaged hunks in `multi.txt`.
const changed = (name: string) => repoOf(buildChanged(gitPath(), name, "F09"));
const appendLine = (repo: string, path: string) => put(repo, path, `${readFileSync(join(repo, path), "utf8")}external line\n`);

// Index bytes of a copy with `staged.txt` unstaged. The fixture stays unchanged.
function otherIndex(repo: string, name: string): Uint8Array {
  const copy = copyRepo(repo, `${name}-other-index`);
  git(copy, ["reset", "-q", "--", "staged.txt"]);
  return readFileSync(gitPathOf(copy, "index"));
}

describe("checkpoints (contract §4 \"File staging\" steps 3 and 7, §9)", () => {
  for (const checkpoint of ["first", "second"] as const) {
    caseTest(TASK, `a working-file change before the ${checkpoint} checkpoint refuses stage with STALE_SELECTION, with no read between the change and applyFile`, SHELL, () => {
      const name = `t197-stage-${checkpoint}`;
      return withObserver(name, async (service, hooks) => {
        const repo = changed(name);
        await underTest();
        const { repositoryId } = await service.register(repo);
        const c = await compare(service, repositoryId, "multi.txt", "unstaged");
        const baseline = { state: repoState(repo) };
        let observed = false;
        const change = () => {
          appendLine(repo, "multi.txt");
          baseline.state = repoState(repo);
          observed = true;
        };
        if (checkpoint === "first") change();
        else hooks[5] = change;
        const response = await refused(service, repo, () => applyFile(service, repositoryId, c, "stage"), baseline);
        // Contract §4 step 3: the first checkpoint refuses before any Git step writes the candidate.
        const updates = callsOf(service, response.operationId!).filter((call) => subcommand(call.arguments) === "update-index").length;
        expect({ checkpoint, code: code(response), observed, updates }).toEqual({ checkpoint, code: "STALE_SELECTION", observed: true, updates: checkpoint === "first" ? 0 : 1 });
      });
    }, TIMEOUT_MS);

    caseTest(TASK, `an index-entry change before the ${checkpoint} checkpoint refuses unstage with STALE_SELECTION, with no read between the change and applyFile`, SHELL, () => {
      const name = `t197-unstage-${checkpoint}`;
      return withObserver(name, async (service, hooks) => {
        const repo = changed(name);
        const index = otherIndex(repo, name);
        await underTest();
        const { repositoryId } = await service.register(repo);
        const c = await compare(service, repositoryId, "staged.txt", "staged");
        const baseline = { state: repoState(repo) };
        let observed = false;
        // An independent writer that ignores the canonical index lock.
        const change = () => {
          writeFileSync(gitPathOf(repo, "index"), index);
          baseline.state = repoState(repo);
          observed = true;
        };
        if (checkpoint === "first") change();
        else hooks[5] = change;
        const response = await refused(service, repo, () => applyFile(service, repositoryId, c, "unstage"), baseline);
        expect({ checkpoint, code: code(response), observed }).toEqual({ checkpoint, code: "STALE_SELECTION", observed: true });
      });
    }, TIMEOUT_MS);
  }

  // Contract §4: every detected mismatch prevents publication. An external index equal to the verified candidate before `publish()` is no publication.
  caseTest(TASK, `an index change to the candidate bytes before the second checkpoint gives failed STALE_SELECTION, not succeeded`, SHELL, () => {
    const name = "t197-second-candidate-bytes";
    return withObserver(name, async (service, hooks) => {
      const repo = changed(name);
      await underTest();
      const { repositoryId } = await service.register(repo);
      const c = await compare(service, repositoryId, "multi.txt", "unstaged");
      const baseline = { state: repoState(repo) };
      let armed = false;
      let wrote = false;
      hooks[5] = () => void (armed = true);
      // The first `check-attr` after step 5 belongs to the step 7 checkpoint. The candidate is complete then.
      // An independent writer copies the owned candidate over the canonical index and ignores the lock.
      atStart(service, "check-attr", () => {
        if (!armed) return;
        armed = false;
        const owned = candidateFiles(repo).filter((f) => !f.endsWith(".lock"));
        expect(owned.length).toBe(1);
        writeFileSync(gitPathOf(repo, "index"), readFileSync(join(gitDirOf(repo), owned[0]!)));
        baseline.state = repoState(repo);
        wrote = true;
      });
      const response = await refused(service, repo, () => applyFile(service, repositoryId, c, "stage"), baseline);
      expect({ ...outcome(response), wrote }).toEqual({ state: "failed", code: "STALE_SELECTION", wrote: true });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, `a working-file change alone does not refuse unstage, and the index equals git restore --staged`, SHELL, () =>
    withService({ name: "t197-unstage-working" }, async (service) => {
      const repo = changed("t197-unstage-working");
      const oracle = copyRepo(repo, "t197-unstage-working-oracle");
      git(oracle, ["--literal-pathspecs", "restore", "--staged", "--", "staged.txt"]);
      await underTest();
      const { repositoryId } = await service.register(repo);
      const c = await compare(service, repositoryId, "staged.txt", "staged");
      appendLine(repo, "staged.txt");
      const files = repoState(repo).files;
      expect(outcome(await applyFile(service, repositoryId, c, "unstage"))).toEqual(SUCCEEDED);
      expect({ entries: indexEntries(gitPath(), repo), files: repoState(repo).files, candidates: candidateFiles(repo) }).toEqual({ entries: indexEntries(gitPath(), oracle), files, candidates: [] });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `a readWorkspace between the change and applyFile gives REPOSITORY_CHANGED at acceptance, and no Git process starts`, SHELL, () =>
    withService({ name: "t197-generation" }, async (service) => {
      const repo = changed("t197-generation");
      await underTest();
      const { repositoryId } = await service.register(repo);
      const c = await compare(service, repositoryId, "multi.txt", "unstaged");
      appendLine(repo, "multi.txt");
      expect((await readOk(service, repositoryId)).generation).toBeGreaterThan(c.read.generation);
      const calls = service.runner.calls.length;
      const response = await refused(service, repo, () => applyFile(service, repositoryId, c, "stage"));
      expect({ ...outcome(response), runs: service.runner.calls.length - calls }).toEqual({ state: "rejected", code: "REPOSITORY_CHANGED", runs: 0 });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `a configuration change of the trust fingerprint gives TRUST_CHANGED`, SHELL, () =>
    withService({ name: "t197-trust" }, async (service) => {
      const built = buildChanged(gitPath(), "t197-trust", "F09");
      const repo = repoOf(built);
      const program = (n: string) => `'${put(built.root, `programs/${n}.sh`, "#!/bin/sh\nexit 0\n").replaceAll("\\", "/")}'`;
      git(repo, ["config", "diff.external", program("diff-a")]);
      await underTest();
      const { repositoryId } = await service.register(repo);
      const c = await compare(service, repositoryId, "multi.txt", "unstaged");
      git(repo, ["config", "diff.external", program("diff-b")]);
      expect(code(await refused(service, repo, () => applyFile(service, repositoryId, c, "stage")))).toBe("TRUST_CHANGED");
    }),
    TIMEOUT_MS,
  );
});

describe("refused entries (contract §4 \"File staging\", §9)", () => {
  // Each refused T194 entry with the direction of its comparison scope and its file-action reason.
  type Refused = { label: string; repo: () => { built: Built; repo: string }; path: (built: Built) => string; category: ChangeEntry["category"]; reason: string; trust?: boolean };
  const f05 = (label: string) => () => {
    const built = buildF05(gitPath(), `t197-f05-${label}`, "file-refusals");
    return { built, repo: repoOf(built, "super") };
  };
  const REFUSED: Refused[] = [
    { label: "type", repo: f05("type"), path: () => "type-change.txt", category: "staged", reason: "type", trust: true },
    { label: "staged-symlink", repo: f05("staged-symlink"), path: () => "new-link", category: "staged", reason: "symlink", trust: true },
    { label: "gitlink", repo: f05("gitlink"), path: () => "sub-moved", category: "unstaged", reason: "submodule", trust: true },
    // `ls-files -o` and status list a nested repository as its folder name with a final `/` (fixture facts).
    { label: "nested", repo: f05("nested"), path: (b) => b.facts.repos.super!.untracked[0]!, category: "untracked", reason: "submodule", trust: true },
    { label: "lfs", repo: f05("lfs"), path: () => "asset.psd", category: "unstaged", reason: "LFS", trust: true },
    { label: "filter", repo: f05("filter"), path: () => "custom.cf", category: "unstaged", reason: "filter", trust: true },
    {
      label: "rename-record",
      repo: () => {
        const built = buildFileAccepted(gitPath(), "t197-rename-record");
        return { built, repo: repoOf(built) };
      },
      path: () => "ita-dst.txt",
      category: "unstaged",
      reason: "rename",
    },
    {
      label: "size",
      repo: () => {
        const built = buildF16StageInput(gitPath(), "t197-size");
        return { built, repo: repoOf(built) };
      },
      path: () => "over-limit.bin",
      category: "untracked",
      reason: "size",
    },
    {
      label: "index-flag",
      repo: () => {
        const built = buildF10(gitPath(), "t197-index-flag", "flags");
        return { built, repo: repoOf(built) };
      },
      path: () => "ita.txt",
      category: "unstaged",
      reason: "index-flag",
    },
  ];

  for (const entry of REFUSED) {
    caseTest(TASK, `T194 ${entry.label}: applyFile gives UNSUPPORTED_COMPARISON with reason ${entry.reason}, and the clean-filter canary never runs`, SHELL, () =>
      withService({ name: `t197-refused-${entry.label}` }, async (service) => {
        const { built, repo } = entry.repo();
        const path = entry.path(built);
        const canaries = Object.values(built.facts.canaries).map((log) => join(built.root, log));
        const logs = () => canaries.map((log) => (existsSync(log) ? readFileSync(log, "utf8") : null));
        await underTest();
        const { repositoryId } = await service.register(repo);
        // As `approvedRead` in `comparison.test.ts`: the first approved read lists more policy, so the comparison needs a second approval.
        if (entry.trust) {
          await approve(service, repositoryId);
          await service.readWorkspace(repositoryId);
          await approve(service, repositoryId);
        }
        const c = await compare(service, repositoryId, path, entry.category);
        const before = logs();
        const response = await refused(service, repo, () => applyFile(service, repositoryId, c, entry.category === "staged" ? "unstage" : "stage"));
        expect({ label: entry.label, code: code(response), reason: response.result?.reason, canaries: logs() }).toEqual({ label: entry.label, code: "UNSUPPORTED_COMPARISON", reason: entry.reason, canaries: before });
      }),
      TIMEOUT_MS,
    );
  }

  // `merge --quit` keeps the conflicted index and removes MERGE_HEAD (git-merge(1)), so only the conflict remains.
  caseTest(TASK, `conflicts give CONFLICTED`, SHELL, () =>
    withService({ name: "t197-conflicted" }, async (service) => {
      const repo = repoOf(buildF10(gitPath(), "t197-conflicted", "merge"));
      git(repo, ["merge", "--quit"]);
      put(repo, "keep.txt", "keep changed\n");
      await underTest();
      const { repositoryId } = await service.register(repo);
      expect(repoState(repo).markers).toEqual([]);
      const c = await compare(service, repositoryId, "keep.txt", "unstaged");
      expect(code(await refused(service, repo, () => applyFile(service, repositoryId, c, "stage")))).toBe("CONFLICTED");
    }),
    TIMEOUT_MS,
  );

  // `git add` resolves the conflict and keeps the operation marker, so only the operation state remains.
  caseTest(TASK, `merge, rebase, cherry-pick, and revert states give OPERATION_IN_PROGRESS`, SHELL, async () => {
    const cases = (["merge", "rebase", "cherry-pick", "revert"] satisfies F10Variant[]).map((variant) => {
      const repo = repoOf(buildF10(gitPath(), `t197-${variant}`, variant));
      put(repo, "conflict.txt", "resolved\n");
      git(repo, ["add", "--", "conflict.txt"]);
      put(repo, "keep.txt", "keep changed\n");
      expect({ variant, unmerged: gitText(repo, ["ls-files", "-u"]), marked: repoState(repo).markers.length > 0 }).toEqual({ variant, unmerged: "", marked: true });
      return { variant, repo };
    });
    await underTest();
    for (const { variant, repo } of cases) {
      await withService({ name: `t197-${variant}` }, async (service) => {
        const { repositoryId } = await service.register(repo);
        const c = await compare(service, repositoryId, "keep.txt", "unstaged");
        expect({ variant, code: code(await refused(service, repo, () => applyFile(service, repositoryId, c, "stage"))) }).toEqual({ variant, code: "OPERATION_IN_PROGRESS" });
      });
    }
  }, TIMEOUT_MS);
});

describe("hunk profiles (contract §4 \"Hunk eligibility and publication\", \"Split index\")", () => {
  type Profile = { name: string; reason: string; build: (built: Built, repo: string) => void; env?: (built: Built) => Record<string, string>; canary?: "hook" | "monitor"; variant?: F10Variant; trust?: boolean };
  const canaryLog = (built: Built, name: string) => join(built.root, "canaries", `t197-${name}.log`);
  const canaryCommand = (built: Built, name: string, tail: string) => {
    const log = canaryLog(built, name).replaceAll("\\", "/");
    return `'${put(built.root, `canaries/t197-${name}.sh`, `#!/bin/sh\necho "${name} $*" >> '${log}'\n${tail}`).replaceAll("\\", "/")}'`;
  };
  // The T190 profiles on F02 and the F10 split-index cases (contract §10).
  const PROFILES: Profile[] = [
    { name: "sparse", reason: "sparse-index", build: (_b, repo) => void git(repo, ["config", "--local", "index.sparse", "true"]) },
    { name: "split", reason: "split-index", build: (_b, repo) => void git(repo, ["update-index", "--split-index"]) },
    { name: "f10-split-index", reason: "split-index", variant: "split-index", build: () => {} },
    { name: "f10-split-config", reason: "split-index", variant: "split-config", build: () => {} },
    { name: "f10-split-global", reason: "split-index", variant: "split-global", build: () => {}, env: (b) => serviceEnv({ GIT_CONFIG_GLOBAL: join(b.root, b.facts.notes.globalConfig as string) }) },
    { name: "hook", reason: "index-change-hook", canary: "hook", build: (b, repo) => void put(gitDirOf(repo), "hooks/post-index-change", `#!/bin/sh\nexec ${canaryCommand(b, "hook", "")} "$@"\n`) },
    {
      name: "disabled-hook",
      reason: "index-change-hook",
      canary: "hook",
      build: (b, repo) => {
        // git-config(1) `hook.<friendly-name>.enabled`.
        git(repo, ["config", "--local", "hook.t197.command", canaryCommand(b, "hook", "")]);
        git(repo, ["config", "--local", "hook.t197.event", "post-index-change"]);
        git(repo, ["config", "--local", "hook.t197.enabled", "false"]);
      },
    },
    { name: "monitor-command", reason: "executable-monitor", canary: "monitor", trust: true, build: (b, repo) => void git(repo, ["config", "--local", "core.fsmonitor", canaryCommand(b, "monitor", "exit 1\n")]) },
    { name: "monitor-builtin", reason: "unqualified-monitor", build: (_b, repo) => void git(repo, ["config", "--local", "core.fsmonitor", "true"]) },
  ];

  for (const profile of PROFILES) {
    const tail = `${profile.canary === undefined ? "" : `, and the ${profile.canary} canary never runs during applyFile`}${profile.reason === "split-index" ? ", and no sharedindex file appears" : ""}`;
    caseTest(TASK, `profile ${profile.name} gives UNSUPPORTED_HUNK_PROFILE with reason ${profile.reason} for stage and unstage${tail}`, SHELL, async () => {
      const name = `t197-profile-${profile.name}`;
      const built = profile.variant === undefined ? buildF02(gitPath(), name) : buildF10(gitPath(), name, profile.variant);
      const repo = repoOf(built);
      const [unstaged, staged] = profile.variant === undefined ? ["multi.txt", "other-a.txt"] : ["keep.txt", null];
      if (profile.variant !== undefined) put(repo, "keep.txt", "keep changed\n");
      profile.build(built, repo);
      const shared = sharedIndexFiles(repo);
      const log = profile.canary === undefined ? null : canaryLog(built, profile.canary);
      const logText = () => (log !== null && existsSync(log) ? readFileSync(log, "utf8") : null);
      try {
        await withService({ name, ...(profile.env === undefined ? {} : { environment: profile.env(built) }) }, async (service) => {
          await underTest();
          const { repositoryId } = await service.register(repo);
          if (profile.trust) await approve(service, repositoryId);
          for (const [path, category, direction] of [[unstaged, "unstaged", "stage"], [staged, "staged", "unstage"]] as const) {
            if (path === null) continue;
            const c = await compare(service, repositoryId, path, category);
            // The reads and the `repoState` oracle can run the monitor. Only a run during applyFile counts (as in `hunk-refusal.test.ts`).
            const baseline = { state: repoState(repo) };
            const before = logText();
            let during = before;
            const request = async () => {
              const r = await applyFile(service, repositoryId, c, direction);
              during = logText();
              return r;
            };
            const response = await refused(service, repo, request, baseline);
            expect({ profile: profile.name, direction, code: code(response), reason: response.result?.reason, canary: during }).toEqual({ profile: profile.name, direction, code: "UNSUPPORTED_HUNK_PROFILE", reason: profile.reason, canary: before });
          }
        });
        expect(sharedIndexFiles(repo)).toEqual(shared);
      } finally {
        // research.md R3: a read can start the built-in daemon. It must not outlive the case.
        if (profile.name === "monitor-builtin") git(repo, ["fsmonitor--daemon", "stop"], { allowExit: [0, 1, 128] });
      }
    }, TIMEOUT_MS);
  }

  // Contract §4 "Split index", §7, and §10: the environment policy removes `GIT_TEST_SPLIT_INDEX` before Git, so nothing splits (T110 decision G1).
  caseTest(TASK, `with GIT_TEST_SPLIT_INDEX=1 in the service environment, no spawned Git gets the variable, stage and unstage succeed, and no sharedindex file appears`, SHELL, async () => {
    const name = "t197-test-split";
    const repo = repoOf(buildF02(gitPath(), name));
    const environment = serviceEnv({ GIT_TEST_SPLIT_INDEX: "1" });
    expect(environment.GIT_TEST_SPLIT_INDEX).toBe("1");
    const shared = sharedIndexFiles(repo);
    // The environment of each process that the runner spawns.
    const spawned: { argv: string[]; env: Record<string, string> }[] = [];
    const spawn = Bun.spawn;
    const spy = spyOn(Bun, "spawn").mockImplementation(((argv: string[], options: { env?: Record<string, string> }) => {
      spawned.push({ argv, env: options?.env ?? {} });
      return spawn(argv, options as never);
    }) as never);
    try {
      await withService({ name, environment }, async (service) => {
        await underTest();
        const { repositoryId } = await service.register(repo);
        for (const [path, category, direction] of [["multi.txt", "unstaged", "stage"], ["other-a.txt", "staged", "unstage"]] as const) {
          const c = await compare(service, repositoryId, path, category);
          expect({ direction, ...outcome(await applyFile(service, repositoryId, c, direction)) }).toEqual({ direction, ...SUCCEEDED });
        }
      });
    } finally {
      spy.mockRestore();
    }
    expect(spawned.filter((s) => s.argv.includes("update-index")).length).toBe(2);
    expect(spawned.filter((s) => Object.keys(s.env).some((k) => k.toUpperCase() === "GIT_TEST_SPLIT_INDEX")).map((s) => s.argv)).toEqual([]);
    expect(sharedIndexFiles(repo)).toEqual(shared);
  }, TIMEOUT_MS);
});

describe("blob proof and Git failures (contract §4 \"Blob proof\", §9)", () => {
  const isProof = (args: readonly string[]) => (subcommand(args) === "cat-file" && args.includes("--filters")) || (subcommand(args) === "hash-object" && args.includes("--stdin") && args.some((a) => a.startsWith("--path=")));

  for (const variant of ["index-attribute", "ident-crlf"] satisfies F04StageVariant[]) {
    caseTest(TASK, `F04 ${variant}: both proofs fail, and stage gives UNSUPPORTED_COMPARISON with reason blob-proof, the blob-proof text, and the add command`, SHELL, () =>
      withService({ name: `t197-blob-proof-${variant}` }, async (service) => {
        const repo = repoOf(buildF04Stage(gitPath(), `t197-blob-proof-${variant}`, variant));
        await underTest();
        const { repositoryId } = await service.register(repo);
        const c = await compare(service, repositoryId, "f.txt", "unstaged");
        const response = await refused(service, repo, () => applyFile(service, repositoryId, c, "stage"));
        const root = c.read.identity.worktreeRoot;
        expect({ code: code(response), reason: response.result?.reason, remedy: response.result?.remedy }).toEqual({ code: "UNSUPPORTED_COMPARISON", reason: "blob-proof", remedy: { text: BLOB_PROOF_TEXT, command: addRemedy(root, "f.txt") } });
        expect(callsOf(service, response.operationId!).filter((call) => isProof(call.arguments)).map((call) => subcommand(call.arguments))).toEqual(["cat-file", "hash-object"]);
      }),
      TIMEOUT_MS,
    );
  }

  // Contract §4 "Blob proof": the writer must change the bytes that `update-index` reads. A change after step 5 leaves the staged blob equal to the verified bytes.
  for (const restore of [true, false]) {
    const result = restore ? "UNSUPPORTED_COMPARISON with reason blob-proof" : "STALE_SELECTION";
    caseTest(TASK, `a writer that changes the working file before the update-index step ${restore ? "and restores its bytes at the observer point after step 5" : "and leaves it changed"} gives ${result}, and nothing publishes`, SHELL, () => {
      const name = `t197-writer-${restore ? "restored" : "changed"}`;
      return withObserver(name, async (service, hooks) => {
        const repo = changed(name);
        const original = readFileSync(join(repo, "multi.txt"));
        await underTest();
        const { repositoryId } = await service.register(repo);
        const c = await compare(service, repositoryId, "multi.txt", "unstaged");
        const baseline = { state: repoState(repo) };
        let wrote = false;
        atStart(service, "update-index", () => {
          if (wrote) return;
          wrote = true;
          appendLine(repo, "multi.txt");
          if (!restore) baseline.state = repoState(repo);
        });
        if (restore) hooks[5] = () => void writeFileSync(join(repo, "multi.txt"), original);
        const response = await refused(service, repo, () => applyFile(service, repositoryId, c, "stage"), baseline);
        expect({ wrote, code: code(response), reason: response.result?.reason }).toEqual({ wrote: true, code: restore ? "UNSUPPORTED_COMPARISON" : "STALE_SELECTION", reason: restore ? "blob-proof" : undefined });
      });
    }, TIMEOUT_MS);
  }

  caseTest(TASK, `core.safecrlf=true with a mixed file gives GIT_FAILED with the add remedy and an outputTail that holds Git's refusal line within 16 KiB and 100 lines and no control sequence`, SHELL, () =>
    withService({ name: "t197-safecrlf" }, async (service) => {
      const repo = repoOf(buildF04(gitPath(), "t197-safecrlf", "safecrlf"));
      // Git's own `git add` in a copy gives the refusal line. Its exit status is the oracle, never its text.
      const oracle = copyRepo(repo, "t197-safecrlf-oracle");
      const add = Bun.spawnSync([gitPath(), "--literal-pathspecs", "add", "--", "mixed.txt"], { cwd: oracle, env: fixtureEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const stderr = add.stderr.toString("utf8").replaceAll("\r\n", "\n").split("\n").filter((line) => line !== "");
      expect({ exit: add.exitCode === 0, lines: stderr.length > 0 }).toEqual({ exit: false, lines: true });
      await underTest();
      const { repositoryId } = await service.register(repo);
      const c = await compare(service, repositoryId, "mixed.txt", "unstaged");
      const response = await refused(service, repo, () => applyFile(service, repositoryId, c, "stage"));
      const tail = one<string>(response.result, "outputTail");
      expect({ code: code(response), remedy: response.result?.remedy }).toEqual({ code: "GIT_FAILED", remedy: { text: REMEDY_TEXT, command: addRemedy(c.read.identity.worktreeRoot, "mixed.txt") } });
      expect({ refusal: tail.split("\n").includes(stderr.at(-1)!), bytes: Buffer.byteLength(tail) <= TAIL_BYTES, lines: tail.split("\n").length <= TAIL_LINES, control: CONTROL.test(tail) }).toEqual({ refusal: true, bytes: true, lines: true, control: false });
    }),
    TIMEOUT_MS,
  );
});

describe("request checks (contract §4, §9)", () => {
  caseTest(TASK, `a direction that does not match the comparison scope gives INVALID_REQUEST, and no Git process starts`, SHELL, () =>
    withService({ name: "t197-direction" }, async (service) => {
      const repo = changed("t197-direction");
      await underTest();
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      const staged = await compare(service, repositoryId, "staged.txt", "staged", read);
      const unstaged = await compare(service, repositoryId, "multi.txt", "unstaged", read);
      const calls = service.runner.calls.length;
      const results = [await refused(service, repo, () => applyFile(service, repositoryId, staged, "stage")), await refused(service, repo, () => applyFile(service, repositoryId, unstaged, "unstage"))];
      expect({ results: results.map(outcome), runs: service.runner.calls.length - calls }).toEqual({ results: [{ state: "rejected", code: "INVALID_REQUEST" }, { state: "rejected", code: "INVALID_REQUEST" }], runs: 0 });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `an entry from another workspace gives UNKNOWN_TARGET`, SHELL, () =>
    withService({ name: "t197-other-workspace" }, async (service) => {
      const built = buildF07(gitPath(), "t197-other-workspace");
      const a = join(built.root, "wt-a");
      const b = join(built.root, "wt-b");
      put(a, "shared.txt", "shared changed in a\n");
      put(b, "shared.txt", "shared changed in b\n");
      await underTest();
      const wa = await service.register(a);
      const wb = await service.register(b);
      const ca = await compare(service, wa.repositoryId, "shared.txt", "unstaged");
      const rb = await readOk(service, wb.repositoryId);
      const response = await refused(service, b, () => service.request("applyFile", { comparisonId: ca.comparisonId, snapshotId: rb.snapshotId, direction: "stage" }, { repositoryId: wb.repositoryId, repositoryGeneration: rb.generation }));
      expect(code(response)).toBe("UNKNOWN_TARGET");
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `a second mutation in another linked worktree of the same common directory gives BUSY`, SHELL, () =>
    withObserver("t197-busy", async (service, hooks) => {
      let reached = () => {};
      const atStep5 = new Promise<void>((resolve) => (reached = resolve));
      let release = () => {};
      const released = new Promise<void>((resolve) => (release = resolve));
      hooks[5] = async () => {
        reached();
        await released;
      };
      const built = buildF07(gitPath(), "t197-busy");
      const a = join(built.root, "wt-a");
      const b = join(built.root, "wt-b");
      put(a, "shared.txt", "shared changed in a\n");
      put(b, "shared.txt", "shared changed in b\n");
      await underTest();
      const wa = await service.register(a);
      const wb = await service.register(b);
      const ca = await compare(service, wa.repositoryId, "shared.txt", "unstaged");
      const cb = await compare(service, wb.repositoryId, "shared.txt", "unstaged");
      const first = applyFile(service, wa.repositoryId, ca, "stage");
      await atStep5;
      try {
        expect(code(await refused(service, b, () => applyFile(service, wb.repositoryId, cb, "stage")))).toBe("BUSY");
      } finally {
        release();
      }
      expect(outcome(await first)).toEqual(SUCCEEDED);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `an approval older than 60 seconds on an injected clock gives APPROVAL_EXPIRED, and no Git process starts`, SHELL, () => {
    // T110 decision G5: the approval lifetime runs on the monotonic service clock (`approvalClock`). The case moves that clock.
    let elapsed = 0;
    const approvalClock = () => performance.now() + elapsed;
    return withService({ name: "t197-expired", approvalClock }, async (service) => {
      const repo = changed("t197-expired");
      await underTest();
      const { repositoryId } = await service.register(repo);
      const c = await compare(service, repositoryId, "multi.txt", "unstaged");
      elapsed = APPROVAL_LIFETIME_MS + 1;
      const calls = service.runner.calls.length;
      const response = await refused(service, repo, () => applyFile(service, repositoryId, c, "stage"));
      expect({ ...outcome(response), runs: service.runner.calls.length - calls }).toEqual({ state: "rejected", code: "APPROVAL_EXPIRED", runs: 0 });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, `a repeated applyFile with the consumed approval gets succeeded with the first operationId and its getOperation result, and starts no Git process`, SHELL, () =>
    withService({ name: "t197-repeat" }, async (service) => {
      const repo = changed("t197-repeat");
      await underTest();
      const { repositoryId } = await service.register(repo);
      const c = await compare(service, repositoryId, "multi.txt", "unstaged");
      const first = await applyFile(service, repositoryId, c, "stage");
      expect(outcome(first)).toEqual(SUCCEEDED);
      const calls = service.runner.calls.length;
      const second = await applyFile(service, repositoryId, c, "stage");
      expect({ ...outcome(second), operationId: second.operationId, runs: service.runner.calls.length - calls }).toEqual({ ...SUCCEEDED, operationId: first.operationId, runs: 0 });
      expect(second.result).toEqual((await service.getOperation(first.operationId!)).result);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `a repeated requestId gives INVALID_REQUEST and starts no Git process`, SHELL, () =>
    withService({ name: "t197-request-id" }, async (service) => {
      const repo = changed("t197-request-id");
      await underTest();
      const { repositoryId } = await service.register(repo);
      const c = await compare(service, repositoryId, "multi.txt", "unstaged");
      const requestId = crypto.randomUUID();
      expect(outcome(await applyFile(service, repositoryId, c, "stage", { requestId }))).toEqual(SUCCEEDED);
      const calls = service.runner.calls.length;
      service.send("applyFile", { comparisonId: c.comparisonId, snapshotId: c.read.snapshotId, direction: "stage" }, { repositoryId, repositoryGeneration: c.read.generation, requestId });
      await until(() => service.responses.filter((s) => s.requestId === requestId).length === 2, "second response");
      const second = service.responses.filter((s) => s.requestId === requestId)[1]!;
      expect({ ...outcome(second), runs: service.runner.calls.length - calls }).toEqual({ state: "rejected", code: "INVALID_REQUEST", runs: 0 });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `an existing index.lock gives LOCKED with its Git-resolved path and the contract §9 remedy, and the lock stays untouched`, SHELL, () =>
    withService({ name: "t197-locked" }, async (service) => {
      const repo = changed("t197-locked");
      await underTest();
      const { repositoryId } = await service.register(repo);
      const c = await compare(service, repositoryId, "multi.txt", "unstaged");
      const lock = gitPathOf(repo, "index.lock");
      writeFileSync(lock, "foreign lock\n");
      const response = await refused(service, repo, () => applyFile(service, repositoryId, c, "stage"));
      // The service names the lock in the form of Git's absolute `--git-path` output, which uses `/` on Windows. `resolve` gives one form for both (as in `hunk-refusal.test.ts`).
      const path = response.result?.path === undefined ? undefined : resolve(response.result.path);
      expect({ code: code(response), path, text: response.result?.remedy?.text, lock: readFileSync(lock, "utf8") }).toEqual({ code: "LOCKED", path: lock, text: LOCKED_REMEDY, lock: "foreign lock\n" });
    }),
    TIMEOUT_MS,
  );
});

describe("races and outcomes (contract §5, §8)", () => {
  caseTest(TASK, `a working-file change after the final recheck lets publication finish, and the outcome is completed-with-effects with the external bytes intact`, SHELL, () =>
    withObserver("t197-late-writer", async (service, hooks) => {
      const repo = changed("t197-late-writer");
      const oracle = copyRepo(repo, "t197-late-writer-oracle");
      git(oracle, ["--literal-pathspecs", "add", "--", "multi.txt"]);
      await underTest();
      const { repositoryId } = await service.register(repo);
      const c = await compare(service, repositoryId, "multi.txt", "unstaged");
      let external = "";
      hooks[11] = () => {
        appendLine(repo, "multi.txt");
        external = readFileSync(join(repo, "multi.txt"), "utf8");
      };
      const response = await applyFile(service, repositoryId, c, "stage");
      expect({ ...outcome(response), external: external !== "" }).toEqual({ state: "completed-with-effects", code: "COMPLETED_WITH_EFFECTS", external: true });
      expect({ entries: indexEntries(gitPath(), repo), bytes: readFileSync(join(repo, "multi.txt"), "utf8"), candidates: candidateFiles(repo) }).toEqual({ entries: indexEntries(gitPath(), oracle), bytes: external, candidates: [] });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `cancellation before publication gives canceled, and nothing publishes`, SHELL, () =>
    withObserver("t197-cancel", async (service, hooks) => {
      const repo = changed("t197-cancel");
      await underTest();
      const { repositoryId } = await service.register(repo);
      const c = await compare(service, repositoryId, "multi.txt", "unstaged");
      hooks[5] = async ({ operationId }) => {
        expect((await service.cancel(operationId)).state).not.toBe("rejected");
      };
      const response = await refused(service, repo, () => applyFile(service, repositoryId, c, "stage"));
      expect(outcome(response)).toEqual({ state: "canceled", code: "CANCELED" });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `a Git step past a test-injected deadline gives failed with DEADLINE, and the owned lock is gone`, SHELL, () =>
    withService({ name: "t197-deadline" }, async (service) => {
      const repo = changed("t197-deadline");
      await underTest();
      const { repositoryId } = await service.register(repo);
      const c = await compare(service, repositoryId, "multi.txt", "unstaged");
      shortDeadline(service, (call) => subcommand(call.arguments) === "update-index").arm();
      const response = await refused(service, repo, () => applyFile(service, repositoryId, c, "stage"));
      expect({ ...outcome(response), lock: existsSync(gitPathOf(repo, "index.lock")) }).toEqual({ state: "failed", code: "DEADLINE", lock: false });
    }),
    TIMEOUT_MS,
  );

  // Contract §8: an `applyFile` left `unknown` runs no attribution step. The refresh compares the canonical index with the retained candidate and pre-publication digests.
  type Match = "published" | "not-published" | "neither";
  for (const match of ["published", "not-published", "neither"] satisfies Match[]) {
    todoCase(TASK, `an applyFile left unknown recovers from its retained digests, and its refresh reports ${match} with no attribution step ${RECOVERY}`, SHELL, () => {
      const name = `t197-unknown-${match}`;
      return withObserver(name, async (service, hooks) => {
        const repo = changed(name);
        const oracle = copyRepo(repo, `${name}-oracle`);
        git(oracle, ["--literal-pathspecs", "add", "--", "multi.txt"]);
        const before = repoState(repo);
        const index = otherIndex(repo, name);
        await underTest();
        const { repositoryId } = await service.register(repo);
        const c = await compare(service, repositoryId, "multi.txt", "unstaged");
        const stop = deadlines(service);
        // Published: every Git process after publication passes its deadline. Not published: every process after the Git step does.
        hooks[match === "not-published" ? 5 : 13] = () => void (stop.on = true);
        expect(outcome(await applyFile(service, repositoryId, c, "stage"))).toEqual({ state: "unknown", code: "STATE_UNKNOWN" });
        stop.off();
        if (match === "neither") writeFileSync(gitPathOf(repo, "index"), index);
        const expected = match === "published" ? indexEntries(gitPath(), oracle) : match === "not-published" ? before.entries : indexEntries(gitPath(), repo);
        const refreshed = await refresh(service, repositoryId);
        expect(outcome(refreshed)).toEqual(SUCCEEDED);
        expect({ indexMatch: one<Recovery>(refreshed.result, "recovery").indexMatch, attribution: valuesOf(refreshed.result, "attribution"), entries: indexEntries(gitPath(), repo) }).toEqual({ indexMatch: match, attribution: [], entries: expected });
      });
    });
  }

  todoCase(TASK, `after a handshake with restarted true, applyFile gives STATE_UNKNOWN, also after a refresh false read, until a refresh true read ${RECOVERY}`, SHELL, async () => {
    const repo = changed("t197-restart");
    await underTest();
    const service = await openService({ git: gitPath(), name: "t197-restart" });
    await service.register(repo);
    const next = await service.restart();
    try {
      const restored = await next.restoreWorkspace(repo);
      expect(restored.state).toBe("succeeded");
      const id = (restored.result as { repositoryId: string }).repositoryId;
      const stage = async () => applyFile(next, id, await compare(next, id, "multi.txt", "unstaged"), "stage");
      expect(outcome(await refused(next, repo, stage))).toEqual({ state: "rejected", code: "STATE_UNKNOWN" });
      expect(outcome(await next.readWorkspace(id, { refresh: false, check: "full" }))).toEqual(SUCCEEDED);
      expect(outcome(await refused(next, repo, stage))).toEqual({ state: "rejected", code: "STATE_UNKNOWN" });
      expect(outcome(await refresh(next, id))).toEqual(SUCCEEDED);
      expect(outcome(await stage())).toEqual(SUCCEEDED);
    } finally {
      await next.dispose();
    }
  });

  todoCase(TASK, `the applyFile mutation frames arrive as started, ended, then resolved ${RECOVERY}`, SHELL, () =>
    withService({ name: "t197-frames" }, async (service) => {
      const repo = changed("t197-frames");
      await underTest();
      const { repositoryId } = await service.register(repo);
      const response = await applyFile(service, repositoryId, await compare(service, repositoryId, "multi.txt", "unstaged"), "stage");
      expect(outcome(response)).toEqual(SUCCEEDED);
      await until(() => mutationFrames(service, response.operationId!).length === 3, "mutation frames");
      expect(mutationFrames(service, response.operationId!)).toEqual(["started", "ended", "resolved"]);
    }),
  );
});
