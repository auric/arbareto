// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T044: `reviewSync` and `sync` with `pull` and `integrate` (contract Δ3, data-model §6 to §8, plan.md D6, O-2, O-3, FR-004, FR-007, FR-027 to FR-031, SC-001, SC-004, SC-006, SC-010).
// The oracle is Git's own `pull` on a copy. Trees and parents decide for new commits. Exit codes, porcelain fields, and repository reads decide, never message text.

import { expect } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { RECONCILIATION_TARGET_MS } from "../../src/contracts/limits";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import {
  buildMergeConflict,
  buildPartialClone,
  buildPull,
  buildRebaseConflict,
  buildSubmodule,
  configDigests,
  fc,
  gitOut,
  gitPaths,
  gitRun,
  importStream,
  leftRight,
  pullRowCopy,
  PULL_ROWS,
  refMap,
  revParse,
  type GitHost,
  type PullFixture,
  type PullRow,
} from "./remote-fixtures";
import { caseTest, type Service } from "./service-harness";
import {
  ANY_EXIT,
  callsOf,
  copyWithRemotes,
  hostFor,
  INTEGRATE_ENV,
  native,
  parentCount,
  pullFlags,
  refreshIndex,
  refusalOf,
  register,
  remoteCalls,
  repoShape,
  reviewed,
  reviewSync,
  run,
  sendSync,
  subcommandOf,
  sync,
  TIMEOUT_MS,
  unmergedPaths,
  until,
  withSync,
  type SyncResult,
} from "./sync-harness";

useFixtureRoot();

const TASK = "T044";
const SHELL = ["shell-double"] as const;
const outcome = (r: { state: string; code?: string }) => ({ state: r.state, code: r.code });
const SUCCEEDED = { state: "succeeded", code: undefined };
const WITH_EFFECTS = { state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" };
const isFetch = (c: { arguments: readonly string[] }) => subcommandOf(c.arguments) === "fetch";
const progressOf = (service: Service, requestId: string) => (service.progress as { requestId?: string; phase?: string }[]).filter((p) => p.requestId === requestId);
// The Git processes that can change HEAD, the index, or the working files.
const integrateCalls = (service: Service, from = 0) => service.runner.calls.slice(from).filter((c) => c.environmentPolicy === "integrate");

// Data-model §6 `modeSource`: the payload, then `branch.<name>.rebase`, then `pull.rebase`, then `pull.ff`.
function modeSourceOf(row: PullRow): string | null {
  if (row.payload !== undefined) return "payload";
  const keys = row.config.map(([k]) => k);
  if (keys.includes(`branch.${row.branch}.rebase`)) return "branch";
  if (keys.includes("pull.rebase")) return "pull";
  return keys.includes("pull.ff") ? "pull-ff" : null;
}

const integrationOf = (row: PullRow): string => (row.expect === "up-to-date" ? "up-to-date" : row.expect === "refuse:mode-required" ? "mode-required" : row.expect.startsWith("refuse:") ? "none" : "done");

describeGit("sync pull and integrate (T044)", () => {
  let fixture: { h: GitHost; f: PullFixture } | null = null;
  let copies = 0;
  const pullFixture = () => {
    if (fixture === null) {
      const h = hostFor("t044-pull");
      fixture = { h, f: buildPull(h) };
    }
    return fixture;
  };
  const rowCopy = (row: Pick<PullRow, "branch" | "config">): string => {
    const { h, f } = pullFixture();
    return refreshIndex(h, pullRowCopy(h, f, { name: "copy", expect: "merge", ...row }, `${h.root}/copy-${++copies}`));
  };
  const copyOf = (repo: string): string => {
    const { h } = pullFixture();
    const to = `${h.root}/copy-${++copies}`;
    h.copy(repo, to);
    return refreshIndex(h, to);
  };
  // Git's own pull on a copy: a plain fetch first gives the counts that the pull decides from.
  const oraclePull = (repo: string, mode?: "merge" | "rebase", extra: string[] = []) => {
    const { h } = pullFixture();
    gitRun(h, repo, ["fetch", "-q", "origin"]);
    const branch = gitOut(h, repo, ["symbolic-ref", "--short", "HEAD"]).trim();
    const counts = leftRight(h, repo, "HEAD", revParse(h, repo, `refs/remotes/origin/${branch}`));
    const pull = gitRun(h, repo, ["pull", ...pullFlags(mode), ...extra], { allowExit: ANY_EXIT, env: INTEGRATE_ENV });
    return { counts: { ahead: counts[0], behind: counts[1] }, exitCode: pull.exitCode };
  };

  caseTest(TASK, "SC-001 and data-model §6: each row gives Git's own pull on a copy, names its mode source, keeps the configuration bytes (SC-006), and refuses with no change of HEAD, the index, or the working files", SHELL, async () => {
    const { h } = pullFixture();
    for (const row of PULL_ROWS) {
      const app = rowCopy(row);
      const oracle = rowCopy(row);
      const before = repoShape(h, app);
      const config = configDigests(h, app);
      await withSync(`t044-row-${copies}`, async (service) => {
        const r = await register(service, app);
        const from = service.runner.calls.length;
        const response = await run(service, r, { action: "pull", ...(row.payload === undefined ? {} : { mode: row.payload }) });
        const expected = row.expect;
        // Every row fetches the forced update of `origin/rewrite`, so a refusal after the fetch has effects.
        const refusedAfterFetch = expected === "refuse:ff-only" || expected === "refuse:interactive-rebase";
        expect({ row: row.name, ...outcome(response) }).toEqual({ row: row.name, ...(refusedAfterFetch ? WITH_EFFECTS : SUCCEEDED) });
        const result = response.result!;
        expect({ row: row.name, integration: result.integration?.state }).toEqual({ row: row.name, integration: integrationOf(row) });
        if (refusedAfterFetch) expect({ row: row.name, reason: (result as { reason?: string }).reason }).toEqual({ row: row.name, reason: expected.slice("refuse:".length) });
        if (!expected.startsWith("refuse:")) expect({ row: row.name, modeSource: result.modeSource }).toEqual({ row: row.name, modeSource: expected === "up-to-date" ? null : modeSourceOf(row) });
        expect(remoteCalls(service, from).filter(isFetch).length).toBe(1);

        const after = repoShape(h, app);
        if (expected.startsWith("refuse:")) {
          expect({ row: row.name, head: after.head, shape: after.shape, index: after.index, files: after.files, markers: after.markers }).toEqual({ row: row.name, head: before.head, shape: before.shape, index: before.index, files: before.files, markers: before.markers });
        }
        if (expected === "refuse:mode-required") {
          // Plan.md D6: the renderer asks, then `integrate` runs with no second fetch.
          const integrated = await run(service, r, { action: "integrate", mode: "merge" });
          expect(outcome(integrated)).toEqual(SUCCEEDED);
          expect({ integration: integrated.result!.integration, modeSource: integrated.result!.modeSource }).toEqual({ integration: { state: "done" }, modeSource: "payload" });
          expect(remoteCalls(service, from).filter(isFetch).length).toBe(1);
        }
        const git = oraclePull(oracle, expected === "refuse:mode-required" ? "merge" : row.payload);
        expect({ row: row.name, counts: result.counts }).toEqual({ row: row.name, counts: git.counts });
        // Git's pull starts an interactive rebase that `GIT_EDITOR=:` accepts. The app refuses it on purpose.
        if (expected !== "refuse:interactive-rebase") expect({ row: row.name, shape: repoShape(h, app) }).toEqual({ row: row.name, shape: repoShape(h, oracle) });
        if (expected === "refuse:ff-only") expect({ row: row.name, gitExit: git.exitCode === 0 }).toEqual({ row: row.name, gitExit: false });
        expect({ row: row.name, config: Object.values(configDigests(h, app)).map((c) => c.sha256) }).toEqual({ row: row.name, config: Object.values(config).map((c) => c.sha256) });
      });
    }
  }, 900_000);

  caseTest(TASK, "O-2: only behind with pull.ff=false, or with merge.ff=false and no pull.ff, makes a merge commit; only behind otherwise fast-forwards; progress names sync-fetch, then sync-merge or sync-rebase", SHELL, async () => {
    const { h } = pullFixture();
    const cases: [PullRow["config"], number, string][] = [
      [[["pull.ff", "false"]], 2, "sync-merge"],
      [[["merge.ff", "false"]], 2, "sync-merge"],
      [[], 1, "sync-merge"],
      [[["pull.rebase", "true"]], 1, "sync-merge"],
    ];
    for (const [config, parents, phase] of cases) {
      const app = rowCopy({ branch: "p-behind", config });
      const upstream = revParse(h, app, "refs/remotes/origin/p-behind");
      await withSync(`t044-o2-${copies}`, async (service) => {
        const r = await register(service, app);
        const requestId = sendSync(service, r, (await reviewed(service, r, { action: "pull" })).syncReviewToken);
        expect(outcome(await service.response<SyncResult>(requestId))).toEqual(SUCCEEDED);
        expect({ config, parents: parentCount(h, app), ff: revParse(h, app, "HEAD") === upstream }).toEqual({ config, parents, ff: parents === 1 });
        const phases = progressOf(service, requestId).map((p) => p.phase).filter((p) => p?.startsWith("sync-"));
        expect({ config, phases: [...new Set(phases)] }).toEqual({ config, phases: ["sync-fetch", phase] });
      });
    }
    const rebased = rowCopy({ branch: "p-diverged", config: [["pull.rebase", "true"]] });
    await withSync("t044-o2-rebase", async (service) => {
      const r = await register(service, rebased);
      const requestId = sendSync(service, r, (await reviewed(service, r, { action: "pull" })).syncReviewToken);
      expect(outcome(await service.response<SyncResult>(requestId))).toEqual(SUCCEEDED);
      expect([...new Set(progressOf(service, requestId).map((p) => p.phase).filter((p) => p?.startsWith("sync-")))]).toEqual(["sync-fetch", "sync-rebase"]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-027: the decision uses the counts after the fetch; a branch equal before the fetch fast-forwards to the fetched commit, as Git's own pull does", SHELL, async () => {
    const { h, f } = pullFixture();
    const a = copyWithRemotes(h, f.clone, { origin: f.origin }, `late-${++copies}`);
    gitRun(h, refreshIndex(h, a.repo), ["checkout", "-q", "p-equal"]);
    const base = revParse(h, a.remotes.origin!, "refs/heads/p-equal");
    importStream(h, a.remotes.origin!, [Buffer.from(`reset refs/heads/p-equal\nfrom ${base}\n\n`), fc({ mark: 1, ref: "refs/heads/p-equal", message: "late\n", files: { "late.txt": "late\n" } })]);
    const oracle = copyOf(a.repo);
    expect(leftRight(h, a.repo, "HEAD", "refs/remotes/origin/p-equal")).toEqual([0, 0]);
    await withSync("t044-after-fetch", async (service) => {
      const r = await register(service, a.repo);
      const response = await run(service, r, { action: "pull" });
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect({ counts: response.result!.counts, integration: response.result!.integration }).toEqual({ counts: { ahead: 0, behind: 1 }, integration: { state: "done" } });
    });
    oraclePull(oracle);
    expect(repoShape(h, a.repo)).toEqual(repoShape(h, oracle));
    expect(revParse(h, a.repo, "HEAD")).toBe(revParse(h, a.remotes.origin!, "refs/heads/p-equal"));
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-028: each review refusal starts no remote and no integrate process", SHELL, async () => {
    const { h } = pullFixture();
    const variants: { name: string; reason: string; code?: string; prepare: (repo: string) => void; actions?: object[] }[] = [
      { name: "detached", reason: "detached", prepare: (repo) => gitRun(h, repo, ["checkout", "-q", "--detach"]) },
      { name: "unborn", reason: "unborn", prepare: (repo) => gitRun(h, repo, ["checkout", "-q", "--orphan", "fresh"]) },
      { name: "no-upstream", reason: "no-upstream", prepare: (repo) => gitRun(h, repo, ["checkout", "-q", "-b", "lonely"]) },
      { name: "remote-missing", reason: "remote-missing", prepare: (repo) => gitRun(h, repo, ["config", "branch.p-behind.remote", "nowhere"]) },
      { name: "local-upstream", reason: "local-upstream", prepare: (repo) => gitRun(h, repo, ["config", "branch.p-behind.remote", "."]) },
      { name: "several-merge-refs", reason: "several-merge-refs", prepare: (repo) => gitRun(h, repo, ["config", "--add", "branch.p-behind.merge", "refs/heads/p-equal"]) },
      { name: "pull.ff invalid", reason: "invalid-config", prepare: (repo) => gitRun(h, repo, ["config", "pull.ff", "bogus"]) },
      { name: "pull.rebase invalid", reason: "invalid-config", prepare: (repo) => gitRun(h, repo, ["config", "pull.rebase", "bogus"]), actions: [{ action: "pull" }] },
      { name: "integrate without a tracking ref", reason: "upstream-gone", prepare: (repo) => gitRun(h, repo, ["update-ref", "-d", "refs/remotes/origin/p-behind"]), actions: [{ action: "integrate", mode: "merge" }] },
    ];
    for (const v of variants) {
      const repo = rowCopy({ branch: "p-behind", config: [] });
      v.prepare(repo);
      await withSync(`t044-refuse-${copies}`, async (service) => {
        const r = await register(service, repo);
        const from = service.runner.calls.length;
        for (const payload of v.actions ?? [{ action: "pull" }, { action: "pull", mode: "rebase" }, { action: "integrate", mode: "merge" }]) {
          expect({ variant: v.name, payload, ...refusalOf(await reviewSync(service, r, payload)) }).toEqual({ variant: v.name, payload, state: "failed", code: "SYNC_UNAVAILABLE", result: { reason: v.reason } });
        }
        expect({ variant: v.name, remote: remoteCalls(service, from), integrate: integrateCalls(service, from) }).toEqual({ variant: v.name, remote: [], integrate: [] });
      });
    }
    // 001 FR-016 delta: a merge or a rebase in progress refuses pull and integrate.
    for (const build of [buildMergeConflict, buildRebaseConflict]) {
      const built = build(h, `t044-in-progress-${++copies}`);
      await withSync(`t044-in-progress-${copies}`, async (service) => {
        const r = await register(service, built.repo);
        // The fixture filter driver is repository-controlled, so the trust gate decides first.
        const trust = await service.readTrust(r.repositoryId);
        expect((await service.approveTrust(r.repositoryId)).state).toBe("succeeded");
        for (const payload of [{ action: "pull" }, { action: "integrate", mode: "rebase" }]) {
          expect(outcome(await reviewSync(service, r, payload))).toEqual({ state: "failed", code: "OPERATION_IN_PROGRESS" });
        }
        expect(remoteCalls(service)).toEqual([]);
      });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-028: an upstream that the fetch does not give refuses with upstream-gone after the fetch effects, and HEAD, the index, and the working files stay", SHELL, async () => {
    const { h } = pullFixture();
    const repo = rowCopy({ branch: "p-behind", config: [] });
    gitRun(h, repo, ["config", "branch.p-behind.merge", "refs/heads/absent"]);
    const before = repoShape(h, repo);
    await withSync("t044-gone", async (service) => {
      const r = await register(service, repo);
      const response = await run(service, r, { action: "pull" });
      expect(outcome(response)).toEqual(WITH_EFFECTS);
      expect({ reason: (response.result as { reason?: string }).reason, integration: response.result!.integration, fetched: response.result!.fetch!.remotes.map((x) => x.state) }).toEqual({ reason: "upstream-gone", integration: { state: "none" }, fetched: ["succeeded"] });
      expect(integrateCalls(service)).toEqual([]);
    });
    const after = repoShape(h, repo);
    expect({ head: after.head, shape: after.shape, index: after.index, files: after.files }).toEqual({ head: before.head, shape: before.shape, index: before.index, files: before.files });
  }, TIMEOUT_MS);

  caseTest(TASK, "data-model §2 modeConfig: a merge.ff, branch.<name>.rebase, pull.rebase, or pull.ff value that changes after the review gives STALE_REVIEW; no remote or integrate process starts", SHELL, async () => {
    const { h } = pullFixture();
    const repo = rowCopy({ branch: "p-diverged", config: [] });
    const before = repoShape(h, repo);
    await withSync("t044-mode-stale", async (service) => {
      const r = await register(service, repo);
      for (const [key, value] of [["merge.ff", "false"], ["branch.p-diverged.rebase", "true"], ["pull.rebase", "true"], ["pull.ff", "only"]]) {
        for (const payload of [{ action: "pull" }, { action: "integrate", mode: "rebase" }]) {
          const review = await reviewed(service, r, payload);
          gitRun(h, repo, ["config", key!, value!]);
          expect({ key, ...payload, ...outcome(await sync(service, r, review.syncReviewToken)) }).toEqual({ key, ...payload, state: "failed", code: "STALE_REVIEW" });
          gitRun(h, repo, ["config", "--unset", key!]);
        }
      }
      expect(remoteCalls(service)).toEqual([]);
      expect(integrateCalls(service)).toEqual([]);
    });
    expect(repoShape(h, repo)).toEqual(before);
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-029: changes that Git refuses to overwrite give integration refused, no stash entry, and the index and files of Git's own pull with --no-autostash, also with rebase.autoStash and merge.autoStash", SHELL, async () => {
    const { h, f } = pullFixture();
    for (const mode of ["merge", "rebase"] as const) {
      const a = copyWithRemotes(h, f.clone, { origin: f.origin }, `stash-${mode}-${++copies}`);
      gitRun(h, refreshIndex(h, a.repo), ["checkout", "-q", "p-diverged"]);
      const tip = revParse(h, a.remotes.origin!, "refs/heads/p-diverged");
      // The fetched commit changes `base.txt`, which holds an uncommitted change.
      importStream(h, a.remotes.origin!, [Buffer.from(`reset refs/heads/p-diverged\nfrom ${tip}\n\n`), fc({ mark: 1, ref: "refs/heads/p-diverged", message: "remote base\n", files: { "base.txt": "remote base\n" } })]);
      h.write(`${a.repo}/base.txt`, "dirty\n");
      gitRun(h, a.repo, ["config", "rebase.autoStash", "true"]);
      gitRun(h, a.repo, ["config", "merge.autoStash", "true"]);
      const oracle = copyOf(a.repo);
      const before = repoShape(h, a.repo);
      await withSync(`t044-stash-${mode}`, async (service) => {
        const r = await register(service, a.repo);
        const response = await run(service, r, { action: "pull", mode });
        expect({ mode, ...outcome(response) }).toEqual({ mode, ...WITH_EFFECTS });
        expect({ mode, integration: response.result!.integration?.state }).toEqual({ mode, integration: "refused" });
        expect(typeof response.result!.integration!.outputTail).toBe("string");
      });
      gitRun(h, oracle, ["pull", ...pullFlags(mode), "--no-autostash"], { allowExit: ANY_EXIT, env: INTEGRATE_ENV });
      const [app, git] = [repoShape(h, a.repo), repoShape(h, oracle)];
      expect({ mode, index: app.index, files: app.files, head: app.head, shape: app.shape }).toEqual({ mode, index: git.index, files: git.files, head: git.head, shape: git.shape });
      expect({ mode, index: app.index, files: app.files }).toEqual({ mode, index: before.index, files: before.files });
      expect({ mode, stash: refMap(h, a.repo, ["refs/stash"]) }).toEqual({ mode, stash: {} });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-030: a conflicting pull gives failed-with-effects, integration stopped with the kind from the markers and the unmerged count, and Git's own pull state on a copy", SHELL, async () => {
    const { h } = pullFixture();
    for (const mode of ["merge", "rebase"] as const) {
      const repo = rowCopy({ branch: "p-diverged", config: [] });
      // Both sides add `remote.txt` with other content.
      h.write(`${repo}/remote.txt`, "local\n");
      gitRun(h, repo, ["add", "--", "remote.txt"]);
      gitRun(h, repo, ["commit", "-q", "-m", "local remote.txt"]);
      const oracle = copyOf(repo);
      const mergeOracle = copyOf(repo);
      await withSync(`t044-conflict-${mode}`, async (service) => {
        const r = await register(service, repo);
        const response = await run(service, r, { action: "pull", mode });
        expect({ mode, ...outcome(response) }).toEqual({ mode, ...WITH_EFFECTS });
        expect({ mode, integration: response.result!.integration }).toEqual({ mode, integration: { state: "stopped", operation: mode === "merge" ? "merging" : "rebasing", unmerged: 1 } });
      });
      gitRun(h, oracle, ["pull", ...pullFlags(mode)], { allowExit: ANY_EXIT, env: INTEGRATE_ENV });
      if (mode === "merge") {
        // O-3: the message is Git's own `git merge origin/<branch>` message, so MERGE_MSG equals that merge byte for byte, with its conflict lines.
        gitRun(h, mergeOracle, ["fetch", "-q", "origin"]);
        gitRun(h, mergeOracle, ["merge", "--no-edit", "origin/p-diverged"], { allowExit: [1], env: INTEGRATE_ENV });
        const msg = (at: string) => h.read(gitPaths(h, at, ["MERGE_MSG"])[0]!)?.toString("utf8") ?? null;
        expect(msg(repo)).toBe(msg(mergeOracle));
      }
      expect({ mode, unmerged: unmergedPaths(h, repo) }).toEqual({ mode, unmerged: ["remote.txt"] });
      const [app, git] = [repoShape(h, repo), repoShape(h, oracle)];
      // O-3: a merge conflict marker names the merged ref, which is the remote-tracking ref here and FETCH_HEAD in Git's own pull. Every other byte is equal.
      const markerFile = (files: Record<string, string>) => (mode === "merge" ? { ...files, "remote.txt": "label" } : files);
      expect({ mode, head: app.head, index: app.index, files: markerFile(app.files), markers: app.markers, remotes: app.remotes }).toEqual({ mode, head: git.head, index: git.index, files: markerFile(git.files), markers: git.markers, remotes: git.remotes });
      expect(revParse(h, repo, "HEAD")).toBe(revParse(h, oracle, "HEAD"));
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-031 and US5 scenario 6: the trust rules apply before any process; after approval the merge hooks and signing run, and the merge message equals Git's own git merge origin/<branch> (O-3, feature 004 plan.md D5)", SHELL, async () => {
    const { h } = pullFixture();
    const repo = rowCopy({ branch: "p-diverged", config: [["merge.log", "true"]] });
    // O-3: Git's own message for the short remote-tracking name, here with the merge.log shortlog. The copy has no hook and no signer.
    const oracle = copyOf(repo);
    gitRun(h, oracle, ["fetch", "-q", "origin"]);
    gitRun(h, oracle, ["merge", "--no-edit", "origin/p-diverged"], { env: INTEGRATE_ENV });
    const marks = { pre: `${h.root}/pre-merge-commit-${copies}.ran`, post: `${h.root}/post-merge-${copies}.ran`, sign: `${h.root}/signer-${copies}.ran` };
    h.write(`${repo}/.git/hooks/pre-merge-commit`, `#!/bin/sh\n: > '${marks.pre}'\n`);
    h.write(`${repo}/.git/hooks/post-merge`, `#!/bin/sh\n: > '${marks.post}'\n`);
    // gpg-interface.c `sign_buffer_gpg` needs a `[GNUPG:] SIG_CREATED` status line on the status descriptor 2.
    const signer = `${h.root}/signer-${copies}.sh`;
    h.write(signer, `#!/bin/sh\ncat > /dev/null\n: > '${marks.sign}'\nprintf '\\n[GNUPG:] SIG_CREATED D 1 8 00 0 0\\n' >&2\nprintf -- '-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZQ==\\n-----END PGP SIGNATURE-----\\n'\n`);
    gitRun(h, repo, ["config", "commit.gpgSign", "true"]);
    gitRun(h, repo, ["config", "gpg.program", signer]);
    const message = (at: string) => {
      const raw = gitOut(h, at, ["cat-file", "commit", "HEAD"]);
      return raw.slice(raw.indexOf("\n\n") + 2);
    };
    await withSync("t044-hooks", async (service) => {
      const r = await register(service, repo);
      expect(outcome(await reviewSync(service, r, { action: "pull", mode: "merge" }))).toEqual({ state: "failed", code: "TRUST_REQUIRED" });
      expect(service.runner.calls.filter((c) => c.environmentPolicy === "remote" || c.environmentPolicy === "integrate")).toEqual([]);
      const trust = await service.readTrust(r.repositoryId);
      expect((await service.approveTrust(r.repositoryId)).state).toBe("succeeded");
      const from = service.runner.calls.length;
      const response = await run(service, r, { action: "pull", mode: "merge" });
      expect(outcome(response)).toEqual(SUCCEEDED);
      // Feature 004 plan.md D5: `--no-log -m <preview>` with the full ref, so a tag of the same name cannot win. The item holds no final LF.
      const merge = service.runner.calls.slice(from).find((c) => subcommandOf(c.arguments) === "merge")!;
      expect(merge.arguments.slice(-4)).toEqual(["--no-log", "-m", message(oracle).replace(/\n$/, ""), "refs/remotes/origin/p-diverged"]);
    });
    expect({ pre: existsSync(native(marks.pre)), post: existsSync(native(marks.post)), sign: existsSync(native(marks.sign)) }).toEqual({ pre: true, post: true, sign: true });
    const commit = gitOut(h, repo, ["cat-file", "commit", "HEAD"]);
    expect({ signed: commit.includes("\ngpgsig "), parents: parentCount(h, repo), message: message(repo) }).toEqual({ signed: true, parents: 2, message: message(oracle) });
    expect(message(repo).startsWith("Merge remote-tracking branch 'origin/p-diverged' into p-diverged\n")).toBe(true);
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-007: a pull that moves a gitlink starts no Git inside the submodule, and readWorkspace shows the 001 submodule notice", SHELL, async () => {
    const h = hostFor("t044-submodule");
    const s = buildSubmodule(h);
    await withSync("t044-submodule", async (service) => {
      const r = await register(service, s.clone);
      const response = await run(service, r, { action: "pull" });
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect(service.runner.calls.every((c) => c.repositoryId === undefined || c.repositoryId === r.repositoryId)).toBe(true);
      const read = await service.readWorkspace(r.repositoryId);
      expect((read.result as unknown as { submoduleNotice: { count: number; paths: string[] } }).submoduleNotice).toMatchObject({ count: 1, paths: ["sub"] });
    });
    expect({ head: revParse(h, s.clone, "HEAD"), sub: revParse(h, `${s.clone}/sub`, "HEAD") }).toEqual({ head: s.c2, sub: s.s1 });
  }, TIMEOUT_MS);

  caseTest(TASK, "contract §7: a partial clone that lacks an object of the pull starts no lazy fetch; every process starts with --no-lazy-fetch, and the blob stays missing", SHELL, async () => {
    const h = hostFor("t044-partial");
    const p = buildPartialClone(h);
    const tip = revParse(h, p.origin, "refs/heads/main");
    importStream(h, p.origin, [Buffer.from(`reset refs/heads/main\nfrom ${tip}\n\n`), fc({ mark: 1, ref: "refs/heads/main", message: "change a\n", files: { "a.txt": "changed\n" } })]);
    const blob = gitOut(h, p.origin, ["rev-parse", "refs/heads/main:a.txt"]).trim();
    await withSync("t044-partial", async (service) => {
      const r = await register(service, p.clone);
      const requestId = sendSync(service, r, (await reviewed(service, r, { action: "pull" })).syncReviewToken);
      expect((await service.response<SyncResult>(requestId)).state).not.toBe("succeeded");
      expect(callsOf(service, await service.operationId(requestId)).filter((c) => c.arguments[0] !== "--no-lazy-fetch").map((c) => c.arguments)).toEqual([]);
    });
    expect(gitRun(h, p.clone, ["--no-lazy-fetch", "cat-file", "-e", blob], { allowExit: ANY_EXIT }).exitCode).not.toBe(0);
  }, TIMEOUT_MS);

  caseTest(TASK, "SC-004: Cancel during the rebase and during the merge re-reads HEAD, the index, and the markers within 5 seconds and claims no rollback", SHELL, async () => {
    const { h } = pullFixture();
    for (const [mode, event] of [["rebase", "pre-rebase"], ["merge", "pre-merge-commit"]] as const) {
      const repo = rowCopy({ branch: "p-diverged", config: [] });
      const started = `${h.root}/${event}-${copies}.started`;
      const release = `${h.root}/${event}-${copies}.release`;
      // The hook waits at most 30 seconds for the release file.
      h.write(`${repo}/.git/hooks/${event}`, `#!/bin/sh\n: > '${started}'\ni=0\nwhile [ ! -f '${release}' ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done\nexit 0\n`);
      const before = repoShape(h, repo);
      try {
        await withSync(`t044-cancel-${mode}`, async (service) => {
          const r = await register(service, repo);
          const trust = await service.readTrust(r.repositoryId);
          expect((await service.approveTrust(r.repositoryId)).state).toBe("succeeded");
          const requestId = sendSync(service, r, (await reviewed(service, r, { action: "integrate", mode })).syncReviewToken);
          await until(() => existsSync(native(started)), `${event} hook start`, 30_000);
          const canceledAt = performance.now();
          await service.cancel(await service.operationId(requestId));
          const response = await service.response<SyncResult>(requestId);
          expect(service.responseAt.get(requestId)! - canceledAt).toBeLessThanOrEqual(RECONCILIATION_TARGET_MS);
          const after = repoShape(h, repo);
          const operationId = await service.operationId(requestId);
          expect(callsOf(service, operationId).filter((c) => c.environmentPolicy === "integrate").map((c) => c.exit?.exitCode)).toEqual([null]);
          if (mode === "rebase") {
            // pre-rebase runs before the rebase changes anything.
            expect(outcome(response)).toEqual({ state: "canceled", code: "CANCELED" });
            expect(after).toEqual(before);
          } else {
            // builtin/merge.c writes the merged index and files before the pre-merge-commit hook, and MERGE_HEAD after it.
            expect(outcome(response)).toEqual(WITH_EFFECTS);
            expect({ shape: after.shape, markers: after.markers, indexChanged: !Bun.deepEquals(after.index, before.index) }).toEqual({ shape: before.shape, markers: [], indexChanged: true });
          }
        });
      } finally {
        h.write(release, "");
      }
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "contract §8: a step killed while index.lock exists gives failed-with-effects, also with HEAD and the index unchanged", SHELL, async () => {
    const { h } = pullFixture();
    const repo = rowCopy({ branch: "p-diverged", config: [] });
    const lock = native(gitPaths(h, repo, ["index.lock"])[0]!);
    const started = `${h.root}/lock-${copies}.started`;
    const release = `${h.root}/lock-${copies}.release`;
    // The hook runs in the process tree of `git rebase`, so the kill ends it with the lock in place. It waits at most 30 seconds.
    h.write(`${repo}/.git/hooks/pre-rebase`, `#!/bin/sh\n: > '${lock}'\n: > '${started}'\ni=0\nwhile [ ! -f '${release}' ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done\nexit 0\n`);
    const before = repoShape(h, repo);
    try {
      await withSync("t044-cancel-lock", async (service) => {
        const r = await register(service, repo);
        const trust = await service.readTrust(r.repositoryId);
        expect((await service.approveTrust(r.repositoryId)).state).toBe("succeeded");
        const requestId = sendSync(service, r, (await reviewed(service, r, { action: "integrate", mode: "rebase" })).syncReviewToken);
        await until(() => existsSync(native(started)), "pre-rebase hook start", 30_000);
        await service.cancel(await service.operationId(requestId));
        const response = await service.response<SyncResult>(requestId);
        const operationId = await service.operationId(requestId);
        expect(callsOf(service, operationId).filter((c) => c.environmentPolicy === "integrate").map((c) => c.exit?.exitCode)).toEqual([null]);
        expect({ ...outcome(response), integration: response.result!.integration }).toEqual({ ...WITH_EFFECTS, integration: undefined });
        expect(repoShape(h, repo)).toEqual({ ...before, markers: ["index.lock"] });
      });
    } finally {
      h.write(release, "");
      rmSync(lock, { force: true });
    }
  }, TIMEOUT_MS);
});
