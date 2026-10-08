// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T096: `applyHunk` refusals (contract §4, §9). `src/git-service/hunk-publish.ts` comes with T110.

import { describe, expect, setSystemTime } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVAL_LIFETIME_MS } from "../../src/contracts/limits";
import { serviceEnv, useFixtureRoot } from "./fixture-root";
import { buildChanged, buildF02, buildF04, buildF07, buildF10, put, type Built, type F10Variant } from "./fixtures";
import {
  applyHunk,
  approve,
  compare,
  copyRepo,
  git,
  gitDirOf,
  gitPath,
  gitPathOf,
  gitText,
  outcome,
  readOk,
  repoOf,
  repoState,
  selectHunks,
  SUCCEEDED,
  todoCase,
  underTest,
  withService,
  type Comparison,
} from "./hunk-harness";
import type { Capability, HunkCheckpoint, OpenOptions, Refusal, Service, ServiceResponse } from "./service-harness";

const TASK = "T096";
const NEEDS = "(needs T110/T115)";
const SHELL: Capability[] = ["shell-double"];

useFixtureRoot();

// Contract §9 "A `LOCKED` result carries the Git-resolved lock path and this remedy".
const LOCKED_REMEDY = "Another Git process or a crash left this lock. Remove it only after all Git tools stop, including other Arbareto windows.";

type Result = Refusal & { reason?: string };

// Runs `request` and checks the T096 invariants: unchanged canonical index bytes, unchanged working bytes, and no whole-file fallback.
// `baseline` returns the state that the case expects to stay. A change during the request resets it.
async function refused(service: Service, repo: string, request: () => Promise<ServiceResponse>, baseline = { state: repoState(repo) }): Promise<ServiceResponse<Result>> {
  const calls = service.runner.calls.length;
  const response = await request();
  const after = repoState(repo);
  expect({ rawIndex: after.rawIndex, files: after.files }).toEqual({ rawIndex: baseline.state.rawIndex, files: baseline.state.files });
  // Contract §4 "File staging" step 5: `applyFile` stages through `update-index`. A hunk refusal never reaches it.
  expect(service.runner.calls.slice(calls).filter((c) => c.arguments.includes("update-index"))).toEqual([]);
  return response as ServiceResponse<Result>;
}

const code = (response: ServiceResponse) => response.code;
const sharedIndexFiles = (repo: string) => readdirSync(gitDirOf(repo)).filter((name) => name.startsWith("sharedindex.")).sort();

// One open service with a step 5 hook that the case sets.
async function withObserver(name: string, body: (service: Service, at5: { run: (() => void) | null }) => Promise<void>, options: Omit<OpenOptions, "git" | "name"> = {}): Promise<void> {
  const at5: { run: (() => void) | null } = { run: null };
  const hunkCheckpoint = ({ step }: HunkCheckpoint) => {
    if (step !== 5 || at5.run === null) return;
    const run = at5.run;
    at5.run = null;
    run();
  };
  await withService({ name, hunkCheckpoint, ...options }, (service) => body(service, at5));
}

describe("checkpoints (contract §4, §9)", () => {
  // F09 changes. Each one ignores the canonical index lock, as an independent writer can.
  type Prepared = { index: Uint8Array; commit: string };
  const CHANGES: Record<"file" | "index" | "HEAD" | "attribute", (repo: string, p: Prepared) => void> = {
    file: (repo) => put(repo, "multi.txt", `${readFileSync(join(repo, "multi.txt"), "utf8")}external line\n`),
    index: (repo, p) => writeFileSync(gitPathOf(repo, "index"), p.index),
    HEAD: (repo, p) => void git(repo, ["update-ref", "refs/heads/main", p.commit]),
    attribute: (repo) => put(repo, ".gitattributes", "*.txt -diff\n"),
  };
  // The index of a copy with `staged.txt` unstaged, and a new commit on the HEAD tree. Neither touches the fixture.
  function prepare(repo: string, name: string): Prepared {
    const copy = copyRepo(repo, `${name}-prepared`);
    git(copy, ["reset", "-q", "--", "staged.txt"]);
    const commit = gitText(repo, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "external"]).trim();
    return { index: readFileSync(gitPathOf(copy, "index")), commit };
  }

  for (const checkpoint of ["first", "second"] as const) {
    for (const change of Object.keys(CHANGES) as (keyof typeof CHANGES)[]) {
      todoCase(TASK, `F09: a ${change} change before the ${checkpoint} checkpoint gives STALE_SELECTION, with no read between the change and applyHunk ${NEEDS}`, SHELL, () => {
        const name = `t096-${checkpoint}-${change.toLowerCase()}`;
        return withObserver(name, async (service, at5) => {
          const repo = repoOf(buildChanged(gitPath(), name, "F09"));
          const prepared = prepare(repo, name);
          await underTest("hunk-publish");
          const { repositoryId } = await service.register(repo);
          const c = await selectHunks(service, repositoryId, "multi.txt", "unstaged");
          const baseline = { state: repoState(repo) };
          const doChange = () => {
            CHANGES[change](repo, prepared);
            baseline.state = repoState(repo);
          };
          if (checkpoint === "first") doChange();
          else at5.run = doChange;
          const response = await refused(service, repo, () => applyHunk(service, repositoryId, c, c.hunkIds[0]!, "stage"), baseline);
          expect({ change, checkpoint, code: code(response), observed: at5.run === null }).toEqual({ change, checkpoint, code: "STALE_SELECTION", observed: true });
        });
      });
    }
  }

  todoCase(TASK, `F09: a readWorkspace between the change and applyHunk gives REPOSITORY_CHANGED at acceptance, and no Git process starts ${NEEDS}`, SHELL, () =>
    withService({ name: "t096-generation" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t096-generation", "F09"));
      await underTest("hunk-publish");
      const { repositoryId } = await service.register(repo);
      const c = await selectHunks(service, repositoryId, "multi.txt", "unstaged");
      put(repo, "multi.txt", `${readFileSync(join(repo, "multi.txt"), "utf8")}external line\n`);
      expect((await readOk(service, repositoryId)).generation).toBeGreaterThan(c.read.generation);
      const calls = service.runner.calls.length;
      const response = await refused(service, repo, () => applyHunk(service, repositoryId, c, c.hunkIds[0]!, "stage"));
      expect({ ...outcome(response), runs: service.runner.calls.length - calls }).toEqual({ state: "rejected", code: "REPOSITORY_CHANGED", runs: 0 });
    }),
  );

  todoCase(TASK, `F09: a configuration change of the trust fingerprint gives TRUST_CHANGED; without required approval, the next readWorkspace and a new selection stage the hunk without an approval ${NEEDS}`, SHELL, () =>
    withService({ name: "t096-trust" }, async (service) => {
      const built = buildChanged(gitPath(), "t096-trust", "F09");
      const repo = repoOf(built);
      const program = (n: string) => `'${put(built.root, `programs/${n}.sh`, "#!/bin/sh\nexit 0\n").replaceAll("\\", "/")}'`;
      git(repo, ["config", "diff.external", program("diff-a")]);
      await underTest("hunk-publish");
      const { repositoryId } = await service.register(repo);
      const trust = await service.readTrust(repositoryId);
      expect(trust.result!.approvalRequired).toEqual({ reads: false, commit: false });
      const old = await selectHunks(service, repositoryId, "multi.txt", "unstaged");
      git(repo, ["config", "diff.external", program("diff-b")]);
      expect(code(await refused(service, repo, () => applyHunk(service, repositoryId, old, old.hunkIds[0]!, "stage")))).toBe("TRUST_CHANGED");
      const fresh = await selectHunks(service, repositoryId, "multi.txt", "unstaged");
      expect(outcome(await applyHunk(service, repositoryId, fresh, fresh.hunkIds[0]!, "stage"))).toEqual(SUCCEEDED);
      expect(service.trustStore.records).toEqual([]);
    }),
  );
});

describe("repository state (contract §9)", () => {
  todoCase(TASK, `an existing index.lock gives LOCKED with its Git-resolved path and the contract §9 remedy, and the lock stays untouched ${NEEDS}`, SHELL, () =>
    withService({ name: "t096-locked" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t096-locked", "F09"));
      await underTest("hunk-publish");
      const { repositoryId } = await service.register(repo);
      const c = await selectHunks(service, repositoryId, "multi.txt", "unstaged");
      const lock = gitPathOf(repo, "index.lock");
      writeFileSync(lock, "foreign lock\n");
      const response = await refused(service, repo, () => applyHunk(service, repositoryId, c, c.hunkIds[0]!, "stage"));
      expect({ code: code(response), path: response.result?.path, text: response.result?.remedy?.text }).toEqual({ code: "LOCKED", path: lock, text: LOCKED_REMEDY });
      expect(readFileSync(lock, "utf8")).toBe("foreign lock\n");
    }),
  );

  // `merge --quit` keeps the conflicted index and removes MERGE_HEAD (git-merge(1)), so only the conflict remains.
  todoCase(TASK, `conflicts give CONFLICTED ${NEEDS}`, SHELL, () =>
    withService({ name: "t096-conflicted" }, async (service) => {
      const repo = repoOf(buildF10(gitPath(), "t096-conflicted", "merge"));
      git(repo, ["merge", "--quit"]);
      put(repo, "keep.txt", "keep changed\n");
      await underTest("hunk-publish");
      const { repositoryId } = await service.register(repo);
      expect(repoState(repo).markers).toEqual([]);
      const read = await readOk(service, repositoryId);
      const c = await selectHunks(service, repositoryId, "keep.txt", "unstaged", read);
      expect(code(await refused(service, repo, () => applyHunk(service, repositoryId, c, c.hunkIds[0]!, "stage")))).toBe("CONFLICTED");
    }),
  );

  // `git add` resolves the conflict and keeps the operation marker, so only the operation state remains.
  todoCase(TASK, `merge, rebase, cherry-pick, and revert states give OPERATION_IN_PROGRESS ${NEEDS}`, SHELL, async () => {
    const cases = (["merge", "rebase", "cherry-pick", "revert"] satisfies F10Variant[]).map((variant) => {
      const repo = repoOf(buildF10(gitPath(), `t096-${variant}`, variant));
      put(repo, "conflict.txt", "resolved\n");
      git(repo, ["add", "--", "conflict.txt"]);
      put(repo, "keep.txt", "keep changed\n");
      expect({ variant, unmerged: gitText(repo, ["ls-files", "-u"]), marked: repoState(repo).markers.length > 0 }).toEqual({ variant, unmerged: "", marked: true });
      return { variant, repo };
    });
    await underTest("hunk-publish");
    for (const { variant, repo } of cases) {
      await withService({ name: `t096-${variant}` }, async (service) => {
        const { repositoryId } = await service.register(repo);
        const c = await selectHunks(service, repositoryId, "keep.txt", "unstaged");
        expect({ variant, code: code(await refused(service, repo, () => applyHunk(service, repositoryId, c, c.hunkIds[0]!, "stage"))) }).toEqual({ variant, code: "OPERATION_IN_PROGRESS" });
      });
    }
  });
});

describe("hunk profiles (contract §4 \"Hunk eligibility and publication\")", () => {
  type Profile = { name: string; reason: string; build: (built: Built, repo: string) => void; env?: (built: Built) => Record<string, string>; hookLog?: boolean; variant?: F10Variant };
  const hookCanary = (built: Built) => {
    const log = join(built.root, "canaries", "t096-post-index-change.log");
    const script = put(built.root, "canaries/t096-post-index-change.sh", `#!/bin/sh\necho "post-index-change $*" >> '${log.replaceAll("\\", "/")}'\n`);
    return { command: `'${script.replaceAll("\\", "/")}'`, log };
  };
  const PROFILES: Profile[] = [
    { name: "sparse", reason: "sparse-index", build: (_b, repo) => void git(repo, ["config", "--local", "index.sparse", "true"]) },
    { name: "split", reason: "split-index", build: (_b, repo) => void git(repo, ["update-index", "--split-index"]) },
    { name: "f10-split-index", reason: "split-index", variant: "split-index", build: () => {} },
    { name: "f10-split-config", reason: "split-index", variant: "split-config", build: () => {} },
    { name: "f10-split-global", reason: "split-index", variant: "split-global", build: () => {}, env: (b) => serviceEnv({ GIT_CONFIG_GLOBAL: join(b.root, b.facts.notes.globalConfig as string) }) },
    { name: "test-split", reason: "split-index", build: () => {}, env: () => serviceEnv({ GIT_TEST_SPLIT_INDEX: "1" }) },
    { name: "hook", reason: "index-change-hook", hookLog: true, build: (b, repo) => void put(gitDirOf(repo), "hooks/post-index-change", `#!/bin/sh\nexec ${hookCanary(b).command} "$@"\n`) },
    {
      name: "disabled-hook",
      reason: "index-change-hook",
      hookLog: true,
      build: (b, repo) => {
        // git-config(1) `hook.<friendly-name>.enabled`.
        git(repo, ["config", "--local", "hook.t096.command", hookCanary(b).command]);
        git(repo, ["config", "--local", "hook.t096.event", "post-index-change"]);
        git(repo, ["config", "--local", "hook.t096.enabled", "false"]);
      },
    },
    { name: "monitor-command", reason: "executable-monitor", build: (b, repo) => void git(repo, ["config", "--local", "core.fsmonitor", `'${put(b.root, "canaries/t096-fsmonitor.sh", "#!/bin/sh\nexit 1\n").replaceAll("\\", "/")}'`]) },
    { name: "monitor-builtin", reason: "unqualified-monitor", build: (_b, repo) => void git(repo, ["config", "--local", "core.fsmonitor", "true"]) },
  ];

  for (const profile of PROFILES) {
    todoCase(TASK, `profile ${profile.name} gives UNSUPPORTED_HUNK_PROFILE with reason ${profile.reason}${profile.hookLog ? ", and the hook canary never runs" : ""}${profile.reason === "split-index" ? ", and no sharedindex file appears" : ""} ${NEEDS}`, SHELL, async () => {
      const name = `t096-profile-${profile.name}`;
      const built = profile.variant === undefined ? buildF02(gitPath(), name) : buildF10(gitPath(), name, profile.variant);
      const repo = repoOf(built);
      const path = profile.variant === undefined ? "multi.txt" : "keep.txt";
      if (profile.variant !== undefined) put(repo, "keep.txt", "keep changed\n");
      profile.build(built, repo);
      const shared = sharedIndexFiles(repo);
      try {
        await withService({ name, ...(profile.env === undefined ? {} : { environment: profile.env(built) }) }, async (service) => {
          await underTest("hunk-publish");
          const { repositoryId } = await service.register(repo);
          await approve(service, repositoryId);
          const c = await selectHunks(service, repositoryId, path, "unstaged");
          const response = await refused(service, repo, () => applyHunk(service, repositoryId, c, c.hunkIds[0]!, "stage"));
          expect({ profile: profile.name, code: code(response), reason: response.result?.reason }).toEqual({ profile: profile.name, code: "UNSUPPORTED_HUNK_PROFILE", reason: profile.reason });
        });
        expect(sharedIndexFiles(repo)).toEqual(shared);
        if (profile.hookLog) expect(existsSync(join(built.root, "canaries", "t096-post-index-change.log"))).toBe(false);
      } finally {
        // research.md R3: a read can start the built-in daemon. It must not outlive the case.
        if (profile.name === "monitor-builtin") git(repo, ["fsmonitor--daemon", "stop"], { allowExit: [0, 1, 128] });
      }
    });
  }
});

describe("request checks (contract §4, §9)", () => {
  todoCase(TASK, `flagged entries, binary files, and other unsupported comparisons give UNSUPPORTED_COMPARISON ${NEEDS}`, SHELL, async () => {
    const cases: [string, () => string, string, "unstaged" | "untracked"][] = [
      ["flags", () => repoOf(buildF10(gitPath(), "t096-unsupported-flags", "flags")), "ita.txt", "unstaged"],
      [
        "binary",
        () => {
          const repo = repoOf(buildF02(gitPath(), "t096-unsupported-binary"));
          put(repo, "bin.dat", Uint8Array.from({ length: 256 }, (_, i) => i));
          return repo;
        },
        "bin.dat",
        "untracked",
      ],
      ["mixed", () => repoOf(buildF04(gitPath(), "t096-unsupported-mixed", "autocrlf-false")), "mixed.txt", "unstaged"],
    ];
    const repos = cases.map(([, build]) => build());
    await underTest("hunk-publish");
    for (const [i, [label, , path, category]] of cases.entries()) {
      const repo = repos[i]!;
      await withService({ name: `t096-unsupported-${label}` }, async (service) => {
        const { repositoryId } = await service.register(repo);
        const c = await compare(service, repositoryId, path, category);
        expect({ label, ...outcome(c.response), hunks: c.hunkIds }).toEqual({ label, ...SUCCEEDED, hunks: [] });
        // Contract §9: an unsupported comparison gives UNSUPPORTED_COMPARISON before the hunk ID check. It issues no hunk ID, so the case names one that no comparison issued.
        const calls = service.runner.calls.length;
        const response = await refused(service, repo, () => applyHunk(service, repositoryId, c, crypto.randomUUID(), "stage"));
        expect({ label, ...outcome(response), runs: service.runner.calls.length - calls }).toEqual({ label, state: "rejected", code: "UNSUPPORTED_COMPARISON", runs: 0 });
      });
    }
  });

  todoCase(TASK, `a renderer-supplied patch or line range gives INVALID_REQUEST, and no Git process starts ${NEEDS}`, SHELL, () =>
    withService({ name: "t096-renderer-patch" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t096-renderer-patch", "F09"));
      await underTest("hunk-publish");
      const { repositoryId } = await service.register(repo);
      const c = await selectHunks(service, repositoryId, "multi.txt", "unstaged");
      for (const extra of [{ patch: "@@ -20 +20 @@\n-line 20\n+line 20 changed\n" }, { lines: { start: 20, end: 20 } }]) {
        const calls = service.runner.calls.length;
        const response = await refused(service, repo, () => applyHunk(service, repositoryId, c, c.hunkIds[0]!, "stage", extra));
        expect({ ...outcome(response), runs: service.runner.calls.length - calls }).toEqual({ state: "rejected", code: "INVALID_REQUEST", runs: 0 });
      }
    }),
  );

  todoCase(TASK, `a hunk ID from another workspace gives UNKNOWN_TARGET ${NEEDS}`, SHELL, () =>
    withService({ name: "t096-other-workspace" }, async (service) => {
      const built = buildF07(gitPath(), "t096-other-workspace");
      const a = join(built.root, "wt-a");
      const b = join(built.root, "wt-b");
      put(a, "shared.txt", "shared changed in a\n");
      put(b, "shared.txt", "shared changed in b\n");
      await underTest("hunk-publish");
      const wa = await service.register(a);
      const wb = await service.register(b);
      const ca = await selectHunks(service, wa.repositoryId, "shared.txt", "unstaged");
      const rb = await readOk(service, wb.repositoryId);
      const response = await refused(service, b, () =>
        service.request("applyHunk", { comparisonId: ca.comparisonId, hunkId: ca.hunkIds[0], snapshotId: rb.snapshotId, direction: "stage" }, { repositoryId: wb.repositoryId, repositoryGeneration: rb.generation }),
      );
      expect(code(response)).toBe("UNKNOWN_TARGET");
    }),
  );

  todoCase(TASK, `a second mutation in another linked worktree of the same common directory gives BUSY ${NEEDS}`, SHELL, async () => {
    let reached = () => {};
    const atStep5 = new Promise<void>((resolve) => (reached = resolve));
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const hunkCheckpoint = async ({ step }: HunkCheckpoint) => {
      if (step !== 5) return;
      reached();
      await released;
    };
    await withService({ name: "t096-busy", hunkCheckpoint }, async (service) => {
      const built = buildF07(gitPath(), "t096-busy");
      const a = join(built.root, "wt-a");
      const b = join(built.root, "wt-b");
      put(a, "shared.txt", "shared changed in a\n");
      put(b, "shared.txt", "shared changed in b\n");
      await underTest("hunk-publish");
      const wa = await service.register(a);
      const wb = await service.register(b);
      const ca = await selectHunks(service, wa.repositoryId, "shared.txt", "unstaged");
      const cb = await selectHunks(service, wb.repositoryId, "shared.txt", "unstaged");
      const first = applyHunk(service, wa.repositoryId, ca, ca.hunkIds[0]!, "stage");
      await atStep5;
      try {
        expect(code(await refused(service, b, () => applyHunk(service, wb.repositoryId, cb, cb.hunkIds[0]!, "stage")))).toBe("BUSY");
      } finally {
        release();
      }
      expect(outcome(await first)).toEqual(SUCCEEDED);
    });
  });

  todoCase(TASK, `an approval older than 60 seconds on an injected clock gives APPROVAL_EXPIRED ${NEEDS}`, SHELL, () =>
    withService({ name: "t096-expired" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t096-expired", "F09"));
      await underTest("hunk-publish");
      const { repositoryId } = await service.register(repo);
      const c = await selectHunks(service, repositoryId, "multi.txt", "unstaged");
      // Bun `setSystemTime` moves `Date.now()` only. Timers and `performance.now()` keep running.
      setSystemTime(new Date(Date.now() + APPROVAL_LIFETIME_MS + 1));
      try {
        expect(code(await refused(service, repo, () => applyHunk(service, repositoryId, c, c.hunkIds[0]!, "stage")))).toBe("APPROVAL_EXPIRED");
      } finally {
        setSystemTime();
      }
    }),
  );

  todoCase(TASK, `a hunk ID from another comparison and a never-issued hunk ID give UNKNOWN_TARGET, and a direction that does not match the comparison gives INVALID_REQUEST; each is rejected, and no Git process starts ${NEEDS}`, SHELL, () =>
    withService({ name: "t096-other-comparison" }, async (service) => {
      const repo = repoOf(buildF02(gitPath(), "t096-other-comparison"));
      await underTest("hunk-publish");
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      const staged = await selectHunks(service, repositoryId, "multi.txt", "staged", read);
      const unstaged: Comparison = await selectHunks(service, repositoryId, "multi.txt", "unstaged", read);
      // Contract §9: the hunk ID must come from the named comparison.
      const calls = service.runner.calls.length;
      const results = [
        await refused(service, repo, () => applyHunk(service, repositoryId, unstaged, staged.hunkIds[0]!, "stage")),
        await refused(service, repo, () => applyHunk(service, repositoryId, unstaged, crypto.randomUUID(), "stage")),
        await refused(service, repo, () => applyHunk(service, repositoryId, unstaged, unstaged.hunkIds[0]!, "unstage")),
      ];
      expect({ results: results.map(outcome), runs: service.runner.calls.length - calls }).toEqual({
        results: [
          { state: "rejected", code: "UNKNOWN_TARGET" },
          { state: "rejected", code: "UNKNOWN_TARGET" },
          { state: "rejected", code: "INVALID_REQUEST" },
        ],
        runs: 0,
      });
    }),
  );

  // F15 full volume. No builder creates and mounts an owned VHD without elevation, so `disposable-volume` stays absent.
  todoCase(TASK, `F15 full volume: staging a hunk gives GIT_FAILED with safe guidance and never succeeds; no owned candidate file remains ${NEEDS}`, [...SHELL, "disposable-volume"], async () => {
    throw new Error("fixture gap: no disposable-volume builder exists");
  });
});
