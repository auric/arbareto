// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T196: `applyFile` stage and unstage (contract §4 "File staging", "Blob proof"). `src/git-service/file-publish.ts` comes with T200.

import { describe, expect } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { printOrigin } from "../origin";
import { useFixtureRoot } from "./fixture-root";
import { buildF01, buildF02, buildF04, buildF04Stage, buildF06, buildF07, buildF16StageInput, buildF17, buildFileAccepted, F04_BLOB_PROOFS, put, type Built, type F04StageVariant, type F04Variant } from "./fixtures";
import { indexEntries, rawIndexDigest } from "./git-oracle";
import { approve, candidateFiles, compare, copyRepo, git, gitDirOf, gitPath, gitText, outcome, repoOf, repoState, subcommand, SUCCEEDED, TIMEOUT_MS, valuesOf, withService, type Comparison, type Direction } from "./hunk-harness";
import { caseTest, type Capability, type ChangeEntry, type Envelope, type Service, type ServiceResponse } from "./service-harness";

const TASK = "T196";
const SHELL: Capability[] = ["shell-double"];
const RACY_RUNS = 20;
// The F04 policy, racy, and F16 cases build many fixtures or hash 512 MiB files.
const LONG_TIMEOUT_MS = 600_000;

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

// One process start as the double sees it. `RecordedCall` has no transaction, so this reads `transaction.indexFile` of the `GitCall` at its start barrier.
interface Start {
  operationId: string;
  arguments: readonly string[];
  indexFile?: string;
}

function watchStarts(service: Service, onStart: (start: Start) => void = () => {}): Start[] {
  const starts: Start[] = [];
  service.runner.holdStart((call) => {
    const { transaction } = call as typeof call & { transaction?: { indexFile: string } };
    const start: Start = { operationId: call.operationId, arguments: [...call.arguments], ...(transaction === undefined ? {} : { indexFile: transaction.indexFile }) };
    starts.push(start);
    onStart(start);
    return false;
  });
  return starts;
}

// Contract §4 "File staging" step 5, with the T199 builders.
const STAGE_ARGUMENTS = ["--no-lazy-fetch", "update-index", "--add", "--remove", "-z", "--stdin"];
const UNSTAGE_ARGUMENTS = ["--no-lazy-fetch", "update-index", "-z", "--index-info"];
const FORBIDDEN = ["add", "reset", "restore", "rm"];

const callsOf = (service: Service, operationId: string) => service.runner.calls.filter((c) => c.operationId === operationId);
const isProofA = (args: readonly string[], path: string) => subcommand(args) === "cat-file" && args.includes("--filters") && args.includes(`--path=${path}`);
const isProofB = (args: readonly string[], path: string) => subcommand(args) === "hash-object" && args.includes("--stdin") && args.includes(`--path=${path}`);

// Contract §4 "Blob proof": proof B runs only after proof A fails. The proof that held is the last one that ran.
function proofOf(service: Service, operationId: string, path: string): "A" | "B" | "none" {
  const calls = callsOf(service, operationId);
  const a = calls.filter((c) => isProofA(c.arguments, path)).length;
  const b = calls.filter((c) => isProofB(c.arguments, path)).length;
  expect({ path, a, b: b <= a }).toEqual({ path, a: a === 0 ? 0 : 1, b: true });
  return b === 1 ? "B" : a === 1 ? "A" : "none";
}

// Checks the Git steps of one accepted `applyFile` (contract §4 steps 5 and 6, §7 "Missing objects").
function checkSteps(service: Service, starts: Start[], repo: string, operationId: string, direction: Direction, path: string, deletion: boolean): void {
  const calls = callsOf(service, operationId);
  for (const call of calls) {
    expect({ path, args: call.arguments.slice(0, 1) }).toEqual({ path, args: ["--no-lazy-fetch"] });
    expect({ path, forbidden: FORBIDDEN.includes(subcommand(call.arguments) ?? "") }).toEqual({ path, forbidden: false });
    if (subcommand(call.arguments) === "hash-object") expect({ path, write: call.arguments.includes("-w") }).toEqual({ path, write: false });
  }
  const updates = calls.filter((c) => subcommand(c.arguments) === "update-index");
  expect({ path, updates: updates.map((c) => ({ args: c.arguments, policy: c.environmentPolicy })) }).toEqual({ path, updates: [{ args: direction === "stage" ? STAGE_ARGUMENTS : UNSTAGE_ARGUMENTS, policy: "mutation" }] });
  // Contract §4 step 5: `stage` stdin holds the literal path bytes.
  if (direction === "stage") expect({ path, input: Buffer.from(updates[0]!.input ?? new Uint8Array()).toString("utf8") }).toEqual({ path, input: `${path}\0` });
  const update = starts.find((s) => s.operationId === operationId && subcommand(s.arguments) === "update-index");
  const indexFile = update?.indexFile ?? "";
  expect({ path, folder: resolve(dirname(indexFile)), owned: basename(indexFile).startsWith("arbareto-candidate-") }).toEqual({ path, folder: resolve(gitDirOf(repo)), owned: true });
  const proofs = calls.filter((c) => isProofA(c.arguments, path) || isProofB(c.arguments, path));
  if (direction === "unstage" || deletion) {
    expect({ path, proofs: proofs.length }).toEqual({ path, proofs: 0 });
    return;
  }
  // Proof A names the staged object ID as its last argument.
  const staged = indexEntries(gitPath(), repo).find((e) => e.path === path && e.stage === 0)!;
  const a = proofs.find((c) => isProofA(c.arguments, path))!;
  expect({ path, oid: a.arguments.at(-1) }).toEqual({ path, oid: staged.oid });
}

interface Step {
  path: string;
  category: ChangeEntry["category"];
  direction: Direction;
  // Git's own command in a disposable copy (contract §4: "Tests compare each result with `git add` in a disposable copy").
  oracle: string[];
  deletion?: boolean;
}

const addStep = (path: string, category: ChangeEntry["category"] = "unstaged", deletion = false): Step => ({ path, category, direction: "stage", oracle: ["--literal-pathspecs", "add", "--", path], deletion });
const restoreStep = (path: string, ...paths: string[]): Step => ({ path, category: "staged", direction: "unstage", oracle: ["--literal-pathspecs", "restore", "--staged", "--", path, ...paths] });

// Runs each step in order in one repository. Each step compares the full logical index with its oracle copy, and every working file stays.
async function acceptedSteps(service: Service, name: string, repo: string, steps: Step[], approveTrust = false): Promise<{ step: Step; operationId: string }[]> {
  const starts = watchStarts(service);
  const { repositoryId } = await service.register(repo);
  if (approveTrust) await approve(service, repositoryId);
  const done: { step: Step; operationId: string }[] = [];
  for (const [i, step] of steps.entries()) {
    const before = repoState(repo);
    const oracle = copyRepo(repo, `${name}-oracle-${i}`);
    git(oracle, step.oracle);
    const c = await compare(service, repositoryId, step.path, step.category);
    const response = await applyFile(service, repositoryId, c, step.direction);
    expect({ step: step.path, ...outcome(response) }).toEqual({ step: step.path, ...SUCCEEDED });
    const after = repoState(repo);
    expect({ step: step.path, entries: after.entries }).toEqual({ step: step.path, entries: indexEntries(gitPath(), oracle) });
    expect({ step: step.path, files: after.files }).toEqual({ step: step.path, files: before.files });
    expect(candidateFiles(repo)).toEqual([]);
    checkSteps(service, starts, repo, response.operationId!, step.direction, step.path, step.deletion ?? false);
    done.push({ step, operationId: response.operationId! });
  }
  return done;
}

describe("accepted entries (contract §4 \"File staging\")", () => {
  caseTest(TASK, `T194 accepted entries: a modified and an untracked binary file, a deleted file, and a mode change stage as git add; a staged rename, a staged copy, and a staged modification unstage as git restore --staged; the runner sees only update-index on an owned candidate and the proofs without -w`, SHELL, () =>
    withService({ name: "t196-accepted" }, async (service) => {
      const built = buildFileAccepted(gitPath(), "t196-accepted");
      const repo = repoOf(built);
      await underTest();
      await acceptedSteps(service, "t196-accepted", repo, [
        addStep("binary.dat"),
        addStep("untracked.dat", "untracked"),
        addStep("deleted.txt", "unstaged", true),
        addStep("mode.txt"),
        restoreStep("rename-dst.txt", "rename-src.txt"),
        restoreStep("copy-dst.txt"),
        restoreStep("copy-src.txt"),
      ]);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `the staged rename restores the source HEAD entry and removes the destination`, SHELL, () =>
    withService({ name: "t196-rename" }, async (service) => {
      const repo = repoOf(buildFileAccepted(gitPath(), "t196-rename"));
      const head = (path: string) => gitText(repo, ["ls-tree", "HEAD", "--", path]).trim();
      await underTest();
      await acceptedSteps(service, "t196-rename", repo, [restoreStep("rename-dst.txt", "rename-src.txt")]);
      const entry = (path: string) => indexEntries(gitPath(), repo).filter((e) => e.path === path).map((e) => `${e.mode} blob ${e.oid}\t${e.path}`);
      expect({ source: entry("rename-src.txt"), destination: entry("rename-dst.txt") }).toEqual({ source: [head("rename-src.txt")], destination: [] });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `F06: an untracked replacement stages; a staged addition and a staged deletion unstage, and a deleted file stages as git add`, SHELL, async () => {
    const first = repoOf(buildF06(gitPath(), "t196-f06-untracked"));
    const second = repoOf(buildF06(gitPath(), "t196-f06"));
    await underTest();
    await withService({ name: "t196-f06-untracked" }, (service) => acceptedSteps(service, "t196-f06-untracked", first, [addStep("replaced.txt", "untracked")]).then(() => {}));
    await withService({ name: "t196-f06" }, (service) =>
      acceptedSteps(service, "t196-f06", second, [addStep("untracked.txt", "untracked"), restoreStep("added.txt"), addStep("deleted.txt", "unstaged", true), restoreStep("replaced.txt")]).then(() => {}),
    );
  }, TIMEOUT_MS);

  caseTest(TASK, `F02: whole-file steps of a path with staged and unstaged hunks equal git add and git restore --staged, and they need no trust approval because F02 lists no repository-controlled integration`, SHELL, () =>
    withService({ name: "t196-f02" }, async (service) => {
      const repo = repoOf(buildF02(gitPath(), "t196-f02"));
      await underTest();
      await acceptedSteps(service, "t196-f02", repo, [restoreStep("other-a.txt"), restoreStep("other-b.txt"), addStep("multi.txt"), restoreStep("multi.txt")]);
      const { repositoryId } = await service.register(repo);
      expect((await service.readTrust(repositoryId)).result?.approvalRequired).toEqual({ reads: false, commit: false, sync: false, workbench: false, mergetool: false });
      expect(service.trustStore.records).toEqual([]);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `F01 unborn: Unstage file equals git rm --cached, and an untracked empty file stages`, SHELL, () =>
    withService({ name: "t196-f01" }, async (service) => {
      const repo = repoOf(buildF01(gitPath(), "t196-f01", "unborn-added"));
      const rmCached = (path: string): Step => ({ path, category: "staged", direction: "unstage", oracle: ["--literal-pathspecs", "rm", "--cached", "-q", "--", path] });
      await underTest();
      await acceptedSteps(service, "t196-f01", repo, [rmCached("first.txt"), rmCached("empty.txt"), addStep("untracked-empty.txt", "untracked")]);
    }),
    TIMEOUT_MS,
  );
});

describe("line endings and blob proofs (contract §4 \"Blob proof\", research.md R3 probe 7)", () => {
  // `safecrlf` refuses an LF file under `core.autocrlf=true`, as `git add` does. T197 covers that variant.
  const POLICIES: F04Variant[] = ["autocrlf-false", "autocrlf-true", "autocrlf-input", "eol-crlf", "attributes"];
  caseTest(TASK, `F04: each line-ending policy stages each LF, CRLF, and mixed file as git add does; report the proof that held for research.md R3`, SHELL, async () => {
    await underTest();
    const repos = POLICIES.map((variant) => ({ variant, built: buildF04(gitPath(), `t196-f04-${variant}`, variant) }));
    for (const { variant, built } of repos) {
      const repo = repoOf(built);
      const paths = built.facts.repos.repo!.unstaged;
      await withService({ name: `t196-f04-${variant}` }, async (service) => {
        const done = await acceptedSteps(service, `t196-f04-${variant}`, repo, paths.map((p) => addStep(p)));
        for (const { step, operationId } of done) console.log(`OBSERVATION ${TASK}: F04 ${variant} ${step.path} eol ${JSON.stringify((built.facts.notes.eol as Record<string, unknown>)[step.path])} proof ${proofOf(service, operationId, step.path)}`);
      });
    }
  }, LONG_TIMEOUT_MS);

  const ACCEPTED: F04StageVariant[] = ["index-crlf", "mixed-over-lf", "ident"];
  for (const variant of ACCEPTED) {
    const expected = F04_BLOB_PROOFS[variant].a ? "A" : "B";
    caseTest(TASK, `F04 ${variant}: f.txt stages as git add does through proof ${expected}; report the pair for research.md R3`, SHELL, () =>
      withService({ name: `t196-proof-${variant}` }, async (service) => {
        const repo = repoOf(buildF04Stage(gitPath(), `t196-proof-${variant}`, variant));
        await underTest();
        const [done] = await acceptedSteps(service, `t196-proof-${variant}`, repo, [addStep("f.txt")]);
        const proof = proofOf(service, done!.operationId, "f.txt");
        console.log(`OBSERVATION ${TASK}: F04 stage-${variant} f.txt proof ${proof} (research R3 probe 7 expects ${expected})`);
        expect({ variant, proof }).toEqual({ variant, proof: expected });
      }),
      TIMEOUT_MS,
    );
  }
});

describe("candidate time and isolation (contract §4 \"Candidate time\")", () => {
  caseTest(TASK, `F02 racy: in ${RACY_RUNS} runs Stage file stages the new same-size bytes, and the candidate time never exceeds the canonical index time`, SHELL, async () => {
    await underTest();
    const runs = Array.from({ length: RACY_RUNS }, (_, run) => {
      const name = `t196-racy-${run}`;
      const built = buildF02(gitPath(), name, "racy");
      return { run, name, repo: repoOf(built), racy: (built.facts.notes.racy as { path: string }).path };
    });
    for (const { run, name, repo, racy } of runs) {
      // `hash-object` without `-w` gives the blob that `git add` stores. F02 has no attributes.
      const expected = gitText(repo, ["hash-object", "--", racy]).trim();
      const index = join(gitDirOf(repo), "index");
      const times: { candidate: bigint; index: bigint }[] = [];
      await withService({ name }, async (service) => {
        watchStarts(service, (start) => {
          if (subcommand(start.arguments) === "update-index" && start.indexFile !== undefined) times.push({ candidate: statSync(start.indexFile, { bigint: true }).mtimeNs, index: statSync(index, { bigint: true }).mtimeNs });
        });
        const { repositoryId } = await service.register(repo);
        const c = await compare(service, repositoryId, racy, "unstaged");
        expect({ run, ...outcome(await applyFile(service, repositoryId, c, "stage")) }).toEqual({ run, ...SUCCEEDED });
      });
      expect({ run, count: times.length, earlierOrEqual: times[0]!.candidate <= times[0]!.index }).toEqual({ run, count: 1, earlierOrEqual: true });
      expect({ run, oid: indexEntries(gitPath(), repo).find((e) => e.path === racy)?.oid }).toEqual({ run, oid: expected });
      expect(candidateFiles(repo)).toEqual([]);
    }
  }, LONG_TIMEOUT_MS);

  caseTest(TASK, `F07: Stage file in one linked worktree leaves the raw index bytes of the other worktree unchanged`, SHELL, () =>
    withService({ name: "t196-f07" }, async (service) => {
      const built = buildF07(gitPath(), "t196-f07");
      const a = join(built.root, "wt-a");
      const b = join(built.root, "wt-b");
      put(a, "shared.txt", "shared changed in a\n");
      const other = { index: rawIndexDigest(gitPath(), b), entries: indexEntries(gitPath(), b) };
      const expected = gitText(a, ["hash-object", "--", "shared.txt"]).trim();
      await underTest();
      const { repositoryId } = await service.register(a);
      const c = await compare(service, repositoryId, "shared.txt", "unstaged");
      expect(outcome(await applyFile(service, repositoryId, c, "stage"))).toEqual(SUCCEEDED);
      expect(indexEntries(gitPath(), a).find((e) => e.path === "shared.txt")?.oid).toBe(expected);
      expect({ index: rawIndexDigest(gitPath(), b), entries: indexEntries(gitPath(), b) }).toEqual(other);
    }),
    TIMEOUT_MS,
  );

  // Contract §4 "Comparison limits": an OBJECT_MISSING comparison carries no `comparisonId`, and the service keeps no comparison.
  caseTest(TASK, `F17: the unstage comparison is limited with OBJECT_MISSING, carries the file-action decision unstage and no comparisonId, so no applyFile targets it, and the uploadpack canary never runs`, SHELL, () =>
    withService({ name: "t196-f17" }, async (service) => {
      const built = buildF17(gitPath(), "t196-f17", "partial-reset-soft");
      const clone = repoOf(built, "clone");
      const canary = join(built.root, built.facts.canaries.uploadpack!);
      // `ls-tree` reads trees only. The blob:none clone holds every tree.
      const [meta] = gitText(clone, ["--no-lazy-fetch", "ls-tree", "-z", "HEAD", "--", "data.txt"]).split("\t");
      const [, , oid] = meta!.split(" ");
      expect((built.facts.notes.missingBlobs as string[]).includes(oid!)).toBe(true);
      const before = repoState(clone);
      await underTest();
      const { repositoryId } = await service.register(clone);
      await approve(service, repositoryId);
      const c = await compare(service, repositoryId, "data.txt", "staged");
      expect({ ...outcome(c.response), comparisonId: valuesOf(c.response.result, "comparisonId"), fileAction: valuesOf(c.response.result, "fileAction") }).toEqual({ state: "limited", code: "OBJECT_MISSING", comparisonId: [], fileAction: ["unstage"] });
      expect({ rawIndex: repoState(clone).rawIndex, files: repoState(clone).files, canary: existsSync(canary) }).toEqual({ rawIndex: before.rawIndex, files: before.files, canary: false });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `F16: the 536,870,912-byte untracked file stages as git add does; report its Git step time for research.md R3`, SHELL, () =>
    withService({ name: "t196-f16" }, async (service) => {
      await underTest();
      const built: Built = buildF16StageInput(gitPath(), "t196-f16");
      const repo = repoOf(built);
      const expected = gitText(repo, ["hash-object", "--", "at-limit.bin"]).trim();
      const before = repoState(repo);
      const { repositoryId } = await service.register(repo);
      const c = await compare(service, repositoryId, "at-limit.bin", "untracked");
      const response = await applyFile(service, repositoryId, c, "stage");
      expect(outcome(response)).toEqual(SUCCEEDED);
      const after = repoState(repo);
      expect({ oid: after.entries.find((e) => e.path === "at-limit.bin")?.oid, files: after.files }).toEqual({ oid: expected, files: before.files });
      const update = callsOf(service, response.operationId!).find((call) => subcommand(call.arguments) === "update-index");
      console.log(`OBSERVATION ${TASK}: F16 update-index of 536,870,912 bytes took ${update?.durationMs} ms; ${gitText(repo, ["version"]).trim()}`);
    }),
    LONG_TIMEOUT_MS,
  );
});
