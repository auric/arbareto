// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T098: `reviewCommit` and `commit` (contract §3, §4 "Commit validation and handoff", §9). `commit-review.ts`, `commit.ts`, and `reconcile.ts` come with T111 to T113.

import { describe, expect } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { COMMIT_MESSAGE_BYTES, COMMIT_OUTPUT_TAIL_BYTES, COMMIT_OUTPUT_TAIL_LINES } from "../../src/contracts/limits";
import { fixtureDir, fixtureEnv, serviceEnv, useFixtureRoot } from "./fixture-root";
import { buildChanged, buildF01, buildF07, buildF11, buildF12, buildF14, buildF17, F11_HOOK_TOKEN, put, run, type Repo } from "./fixtures";
import { rawIndexDigest, refState, workingFileDigests } from "./git-oracle";
import {
  applyHunk,
  approve,
  commit,
  COMMIT_ARGUMENTS,
  commitCalls,
  commitFacts,
  commitPayload,
  git,
  gitPath,
  gitPathOf,
  gitText,
  HOOK_REMEDY_TEXT,
  hookRemedy,
  indexTree,
  isCommitCall,
  LOCKED_REMEDY,
  lingeringSentence,
  mutationFrames,
  one,
  oracleCommit,
  OTHER_LOCKS_TEXT,
  outcome,
  psQuote,
  putHook,
  readOk,
  repoOf,
  repoState,
  REVOKE_SENTENCE,
  review,
  reviewOk,
  selectHunks,
  shQuote,
  subcommand,
  SUCCEEDED,
  treeOf,
  underTest,
  until,
  valuesOf,
  TIMEOUT_MS,
  withService,
} from "./hunk-harness";
import { caseTest, type Capability, type Service, type ServiceResponse } from "./service-harness";

const TASK = "T098";
const COMMIT = "(needs T112/T113/T115)";
const SHELL: Capability[] = ["shell-double"];

useFixtureRoot();

// With local `commit.cleanup=strip`, Git removes the comment line and the trailing white space (git-commit(1) `--cleanup`).
const MESSAGE = "Subject with trailing space   \n\n# a comment line\nBody line\n\n\n";
const FAILED = (code: string) => ({ state: "failed", code });
type Remedy = { text: string; command: string | null };
const remedies = (response: ServiceResponse) => valuesOf(response.result, "remedy").filter((r) => r !== null && r !== undefined) as Remedy[];
const runsSince = (service: Service, from: number) => service.runner.calls.length - from;

// Registers `repo` and reviews its staged scope.
async function reviewed(service: Service, repo: string) {
  const { repositoryId } = await service.register(repo);
  return { repositoryId, r: await reviewOk(service, repositoryId) };
}

// A committed repository in `dir` with one staged change and a rejecting `pre-commit` hook.
function rejectingRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const r: Repo = { git: gitPath(), dir, pre: [] };
  run(r, ["init", "-q", "-b", "main"]);
  for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"], ["core.filemode", "false"]]) run(r, ["config", key!, value!]);
  put(dir, "file.txt", "one\n");
  run(r, ["add", "--", "file.txt"]);
  run(r, ["commit", "-q", "--no-verify", "-m", "base"]);
  put(dir, "file.txt", "two\n");
  run(r, ["add", "--", "file.txt"]);
  putHook(dir, "pre-commit", "echo t098-rejected >&2\nexit 1\n");
}

// Approves trust, reviews, and commits. Decision G2: no exact fact tells a hook failure from a signing failure, so the commit ends GIT_FAILED (contract §9).
async function hookFailure(service: Service, repo: string) {
  const { repositoryId } = await service.register(repo);
  await approve(service, repositoryId);
  const r = await reviewOk(service, repositoryId);
  const response = await commit(service, repositoryId, r, "t098 message\n");
  expect(outcome(response)).toEqual(FAILED("GIT_FAILED"));
  return { response, root: r.read.identity.worktreeRoot };
}

describe("commit creation (contract §4 \"Commit validation and handoff\")", () => {
  caseTest(TASK, `F12: a stable commit creates exactly one commit with the reviewed tree, the reviewed HEAD as parent, the reviewed branch, and the message after the configured cleanup; unrelated unstaged bytes stay, and no approval is needed ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-stable" }, async (service) => {
      const repo = repoOf(buildF12(gitPath(), "t098-stable", "gc-auto"));
      git(repo, ["config", "commit.cleanup", "strip"]);
      const files = workingFileDigests(repo);
      const before = refState(gitPath(), repo);
      const reviewedTree = indexTree(repo);
      const oracle = oracleCommit(repo, "t098-stable-oracle", MESSAGE);
      await underTest("commit");
      const { repositoryId, r } = await reviewed(service, repo);
      expect(r.read.head).toEqual({ state: "branch", target: "refs/heads/main", oid: before.headOid! });
      const response = await commit(service, repositoryId, r, MESSAGE);
      expect(outcome(response)).toEqual(SUCCEEDED);
      const after = refState(gitPath(), repo);
      expect(after.headTarget).toBe("refs/heads/main");
      expect(gitText(repo, ["rev-list", "--count", `${before.headOid}..HEAD`]).trim()).toBe("1");
      const facts = commitFacts(repo);
      expect({ parents: facts.parents, tree: treeOf(repo, "HEAD"), body: facts.body, author: facts.author, committer: facts.committer }).toEqual({
        parents: [before.headOid!],
        tree: reviewedTree,
        body: oracle.body,
        author: oracle.author,
        committer: oracle.committer,
      });
      expect(facts.tree).toBe(oracle.tree);
      expect(one<string>(response.result, "commitOid")).toBe(after.headOid!);
      expect({ ...after.refs, "refs/heads/main": "" }).toEqual({ ...before.refs, "refs/heads/main": "" });
      expect(workingFileDigests(repo)).toEqual(files);
      expect(service.trustStore.records).toEqual([]);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `F07: a commit in one linked worktree moves only its branch; the raw index, the working files, and HEAD of the other worktree stay equal ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-f07" }, async (service) => {
      const built = buildF07(gitPath(), "t098-f07");
      const a = join(built.root, "wt-a");
      const b = join(built.root, "wt-b");
      const other = { rawIndex: rawIndexDigest(gitPath(), b), files: workingFileDigests(b), head: refState(gitPath(), b) };
      const refs = refState(gitPath(), a).refs;
      const reviewedTree = indexTree(a);
      await underTest("commit");
      const { repositoryId, r } = await reviewed(service, a);
      expect(outcome(await commit(service, repositoryId, r, "t098 f07\n"))).toEqual(SUCCEEDED);
      const after = refState(gitPath(), a).refs;
      expect(Object.keys(after).sort()).toEqual(Object.keys(refs).sort());
      expect(Object.keys(after).filter((name) => after[name] !== refs[name])).toEqual(["refs/heads/wt-a"]);
      expect(treeOf(a, "HEAD")).toEqual(reviewedTree);
      const now = refState(gitPath(), b);
      expect({ rawIndex: rawIndexDigest(gitPath(), b), files: workingFileDigests(b), headTarget: now.headTarget, headOid: now.headOid }).toEqual({
        rawIndex: other.rawIndex,
        files: other.files,
        headTarget: other.head.headTarget,
        headOid: other.head.headOid,
      });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `F01: the first commit in an unborn repository succeeds as a root commit of the reviewed index ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-f01" }, async (service) => {
      const repo = repoOf(buildF01(gitPath(), "t098-f01", "unborn-added"));
      const reviewedTree = indexTree(repo);
      await underTest("commit");
      const { repositoryId, r } = await reviewed(service, repo);
      expect(r.read.head).toEqual({ state: "unborn", target: "refs/heads/main" });
      expect(outcome(await commit(service, repositoryId, r, "first\n"))).toEqual(SUCCEEDED);
      expect(refState(gitPath(), repo).headTarget).toBe("refs/heads/main");
      expect(commitFacts(repo).parents).toEqual([]);
      expect(treeOf(repo, "HEAD")).toEqual(reviewedTree);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `the only commit invocation is --no-lazy-fetch commit --quiet --file=- with the message on stdin, and no path, --all, --amend, --no-verify, or signing override ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-argv" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t098-argv", "F09"));
      await underTest("commit");
      const { repositoryId, r } = await reviewed(service, repo);
      const from = service.runner.calls.length;
      expect(outcome(await commit(service, repositoryId, r, MESSAGE))).toEqual(SUCCEEDED);
      const calls = service.runner.calls.slice(from).filter((c) => subcommand(c.arguments) === "commit");
      expect(calls.map((c) => c.arguments)).toEqual([COMMIT_ARGUMENTS]);
      expect(Buffer.from(calls[0]!.input ?? new Uint8Array()).toString("utf8")).toBe(MESSAGE);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `F09: a commit without a background child records lingeringDescendants 0 ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-no-linger" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t098-no-linger", "F09"));
      await underTest("commit");
      const { repositoryId, r } = await reviewed(service, repo);
      const response = await commit(service, repositoryId, r, "t098 no linger\n");
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect(one<number>(response.result, "lingeringDescendants")).toBe(0);
    }),
    TIMEOUT_MS,
  );
});

describe("review (contract §4, research.md R4)", () => {
  caseTest(TASK, `reviewCommit writes no index, runs no write-tree, and makes no trial commit; its first Git read after the trust listing is diff-index --cached -z --name-status with --no-lazy-fetch, --no-optional-locks, and --literal-pathspecs`, SHELL, () =>
    withService({ name: "t098-review" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t098-review", "F09"));
      const before = repoState(repo);
      await underTest("commit-review");
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      const from = service.runner.calls.length;
      await reviewOk(service, repositoryId, read);
      const calls = service.runner.calls.slice(from);
      const writers = ["write-tree", "commit", "commit-tree", "update-index", "read-tree", "apply", "add", "reset", "update-ref", "mktree"];
      expect(calls.filter((c) => writers.includes(subcommand(c.arguments)!)).map((c) => c.arguments)).toEqual([]);
      // Contract §7 "Shared listing": the review runs its own trust listing (`config`, `rev-parse`) before any index read.
      const first = calls.find((c) => !["config", "rev-parse"].includes(subcommand(c.arguments)!))!.arguments;
      expect(subcommand(first)).toBe("diff-index");
      const at = first.indexOf("diff-index");
      expect(["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs"].map((o) => first.indexOf(o) >= 0 && first.indexOf(o) < at)).toEqual([true, true, true]);
      expect(["--cached", "-z", "--name-status"].map((o) => first.indexOf(o) > at)).toEqual([true, true, true]);
      const after = repoState(repo);
      expect({ rawIndex: after.rawIndex, entries: after.entries, lock: existsSync(gitPathOf(repo, "index.lock")) }).toEqual({ rawIndex: before.rawIndex, entries: before.entries, lock: false });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `the review lists an externally staged unsupported file as metadata of the complete staged scope`, SHELL, () =>
    withService({ name: "t098-unsupported" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t098-unsupported", "F09"));
      put(repo, "blob.bin", new Uint8Array([0, 1, 2, 0, 255, 254]));
      git(repo, ["add", "--", "blob.bin"]);
      await underTest("commit-review");
      const { r } = await reviewed(service, repo);
      const paths = valuesOf(r.response.result, "path");
      expect(["blob.bin", "staged.txt"].map((p) => paths.includes(p))).toEqual([true, true]);
    }),
    TIMEOUT_MS,
  );
});

describe("refusals (contract §3, §9)", () => {
  // Data-model §6: "Reject blank messages, NUL characters, unsupported encodings, and messages above the protocol limit."
  const MESSAGES: Record<string, string> = {
    blank: " \t\n\r\n",
    nul: "subject\u0000body\n",
    "above 64 KiB": "x".repeat(COMMIT_MESSAGE_BYTES + 1),
    "above 64 KiB in UTF-8 bytes": "é".repeat(COMMIT_MESSAGE_BYTES / 2 + 1),
  };
  caseTest(TASK, `a blank message, a NUL character, and a message above 64 KiB give INVALID_REQUEST, and no Git process starts ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-messages" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t098-messages", "F09"));
      const head = refState(gitPath(), repo);
      await underTest("commit");
      const { repositoryId, r } = await reviewed(service, repo);
      for (const [name, message] of Object.entries(MESSAGES)) {
        const from = service.runner.calls.length;
        const response = await commit(service, repositoryId, r, message);
        expect({ name, ...outcome(response), runs: runsSince(service, from) }).toEqual({ name, state: "rejected", code: "INVALID_REQUEST", runs: 0 });
      }
      expect(refState(gitPath(), repo)).toEqual(head);
    }),
    TIMEOUT_MS,
  );

  // Contract §3: the review of an empty staged scope succeeds without a token. Without an issued token, a commit names a well-formed ID that the session did not issue (§2).
  caseTest(TASK, `an empty staged scope gives a succeeded review without a reviewToken; a commit without a valid token gives UNKNOWN_TARGET, and no commit process starts ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-empty" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t098-empty", "F09"));
      git(repo, ["reset", "-q"]);
      expect(gitText(repo, ["diff-index", "--cached", "--name-only", "HEAD"])).toBe("");
      const head = refState(gitPath(), repo);
      await underTest("commit");
      const { repositoryId } = await service.register(repo);
      const r = await review(service, repositoryId);
      expect({ ...outcome(r.response), token: r.token, paths: valuesOf(r.response.result, "path") }).toEqual({ ...SUCCEEDED, token: undefined, paths: [] });
      const from = service.runner.calls.length;
      const response = await commit(service, repositoryId, { ...r, token: crypto.randomUUID() }, "empty\n");
      expect({ ...outcome(response), runs: runsSince(service, from) }).toEqual({ state: "rejected", code: "UNKNOWN_TARGET", runs: 0 });
      expect(commitCalls(service)).toEqual([]);
      expect(refState(gitPath(), repo)).toEqual(head);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `missing identity (owned global configuration with user.useConfigOnly=true and no name) gives failed with GIT_FAILED and the Git output tail, and no commit process starts ${COMMIT}`, SHELL, async () => {
    const name = "t098-identity";
    const config = join(fixtureDir(name), "no-identity.gitconfig");
    writeFileSync(config, "[user]\n\tuseConfigOnly = true\n[init]\n\tdefaultBranch = main\n");
    await withService({ name, environment: serviceEnv({ GIT_CONFIG_GLOBAL: config }) }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), name, "F09"));
      const head = refState(gitPath(), repo);
      await underTest("commit");
      const { repositoryId, r } = await reviewed(service, repo);
      const response = await commit(service, repositoryId, r, "identity\n");
      expect(outcome(response)).toEqual(FAILED("GIT_FAILED"));
      expect(typeof one<string>(response.result, "outputTail")).toBe("string");
      expect(commitCalls(service)).toEqual([]);
      expect(refState(gitPath(), repo)).toEqual(head);
    });
  }, TIMEOUT_MS);

  // Decision G2: without trace2, no exact fact tells a signing failure from a hook failure, so the code is GIT_FAILED (contract §9).
  caseTest(TASK, `a failing signing program after trust approval gives GIT_FAILED, and HEAD stays ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-signing" }, async (service) => {
      const built = buildChanged(gitPath(), "t098-signing", "F09");
      const repo = repoOf(built);
      const signer = put(built.root, "programs/t098-signer.sh", "#!/bin/sh\necho t098-signer-failed >&2\nexit 1\n");
      git(repo, ["config", "commit.gpgsign", "true"]);
      git(repo, ["config", "gpg.program", shQuote(signer)]);
      const head = refState(gitPath(), repo);
      await underTest("commit");
      const { repositoryId } = await service.register(repo);
      await approve(service, repositoryId);
      const r = await reviewOk(service, repositoryId);
      expect(outcome(await commit(service, repositoryId, r, "signed\n"))).toEqual(FAILED("GIT_FAILED"));
      expect(refState(gitPath(), repo)).toEqual(head);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `F11: a rejecting pre-commit hook gives GIT_FAILED (decision G2) with the outputTail and the contract §9 hook command; the command names the selected Git and the worktree root and holds no message text ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-hook-failed" }, async (service) => {
      const repo = repoOf(buildF11(gitPath(), "t098-hook-failed", "rejecting"));
      const before = repoState(repo);
      const head = refState(gitPath(), repo);
      await underTest("commit");
      const { repositoryId } = await service.register(repo);
      await approve(service, repositoryId);
      const r = await reviewOk(service, repositoryId);
      const message = "t098-message-marker\n";
      const response = await commit(service, repositoryId, r, message);
      expect(outcome(response)).toEqual(FAILED("GIT_FAILED"));
      expect(typeof one<string>(response.result, "outputTail")).toBe("string");
      expect(remedies(response)).toEqual([{ text: HOOK_REMEDY_TEXT, command: hookRemedy(r.read.identity.worktreeRoot) }]);
      expect(remedies(response)[0]!.command!.includes("t098-message-marker")).toBe(false);
      // Git writes its index with the cache tree before `pre-commit` runs (builtin/commit.c `prepare_index`), so only the logical entries stay.
      expect({ entries: repoState(repo).entries, head: refState(gitPath(), repo) }).toEqual({ entries: before.entries, head });
    }),
    TIMEOUT_MS,
  );

  // Git commits the index lock before it runs `pre-commit` (research.md R4 "index lock release"), so the hook's index write stays.
  // Decision G4: a commit binds no working file, so `workingFiles` is false (contract §8).
  caseTest(TASK, `a pre-commit hook that stages another file and then rejects gives failed-with-effects with index effects only, and the index keeps the hook's entry ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-hook-effects" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t098-hook-effects", "F09"));
      putHook(repo, "pre-commit", "echo hooked >> hooked.txt\ngit add -- hooked.txt\nexit 1\n");
      const head = refState(gitPath(), repo);
      await underTest("commit");
      const { repositoryId } = await service.register(repo);
      await approve(service, repositoryId);
      const r = await reviewOk(service, repositoryId);
      const response = await commit(service, repositoryId, r, "effects\n");
      expect(outcome(response)).toEqual({ state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" });
      expect(one<object>(response.result, "effects")).toEqual({ head: false, index: true, workingFiles: false, operationState: false });
      expect(repoState(repo).entries.some((e) => e.path === "hooked.txt")).toBe(true);
      expect(refState(gitPath(), repo)).toEqual(head);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `i18n.commitEncoding=latin1 gives COMMIT_ENCODING_UNSUPPORTED, and no commit process starts ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-latin1" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t098-latin1", "F09"));
      git(repo, ["config", "i18n.commitEncoding", "latin1"]);
      const head = refState(gitPath(), repo);
      await underTest("commit");
      const { repositoryId, r } = await reviewed(service, repo);
      expect((await commit(service, repositoryId, r, "latin1\n")).code).toBe("COMMIT_ENCODING_UNSUPPORTED");
      expect(commitCalls(service)).toEqual([]);
      expect(refState(gitPath(), repo)).toEqual(head);
    }),
    TIMEOUT_MS,
  );

  for (const value of [null, "utf-8", "UTF8"]) {
    caseTest(TASK, `i18n.commitEncoding ${value ?? "unset"} passes ${COMMIT}`, SHELL, () => {
      const name = `t098-encoding-${(value ?? "unset").toLowerCase()}`;
      return withService({ name }, async (service) => {
        const repo = repoOf(buildChanged(gitPath(), name, "F09"));
        if (value !== null) git(repo, ["config", "i18n.commitEncoding", value]);
        await underTest("commit");
        const { repositoryId, r } = await reviewed(service, repo);
        expect(outcome(await commit(service, repositoryId, r, "encoding\n"))).toEqual(SUCCEEDED);
      });
    }, TIMEOUT_MS);
  }

  caseTest(TASK, `an existing index.lock gives LOCKED with its path and the contract §9 remedy, and the lock stays untouched ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-locked" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t098-locked", "F09"));
      await underTest("commit");
      const { repositoryId, r } = await reviewed(service, repo);
      const lock = gitPathOf(repo, "index.lock");
      writeFileSync(lock, "foreign lock\n");
      const response = (await commit(service, repositoryId, r, "locked\n")) as ServiceResponse<{ path?: string; remedy?: Remedy }>;
      // The service names the lock in the form of Git's absolute `--git-path` output, which uses `/` on Windows. `resolve` gives one form for both.
      const path = response.result?.path === undefined ? undefined : resolve(response.result.path);
      expect({ code: response.code, path, text: response.result?.remedy?.text }).toEqual({ code: "LOCKED", path: lock, text: LOCKED_REMEDY });
      expect(readFileSync(lock, "utf8")).toBe("foreign lock\n");
      expect(commitCalls(service)).toEqual([]);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `a second commit in another linked worktree of the same common directory, while a commit runs, gives BUSY ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-busy" }, async (service) => {
      const built = buildF07(gitPath(), "t098-busy");
      await underTest("commit");
      const a = await reviewed(service, join(built.root, "wt-a"));
      const b = await reviewed(service, join(built.root, "wt-b"));
      const release = service.runner.holdStart(isCommitCall);
      const first = commit(service, a.repositoryId, a.r, "first\n");
      try {
        await until(() => commitCalls(service).length === 1, "first commit process");
        expect((await commit(service, b.repositoryId, b.r, "second\n")).code).toBe("BUSY");
      } finally {
        release();
      }
      expect(outcome(await first)).toEqual(SUCCEEDED);
      expect(commitCalls(service).length).toBe(1);
    }),
    TIMEOUT_MS,
  );
});

describe("trust (contract §7 \"Mutation trust\")", () => {
  caseTest(TASK, `F11: a repository pre-commit hook with denied trust gives TRUST_REQUIRED, and no Git process starts ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-trust-required" }, async (service) => {
      const built = buildF11(gitPath(), "t098-trust-required", "traditional");
      await underTest("commit");
      const { repositoryId, r } = await reviewed(service, repoOf(built));
      const from = service.runner.calls.length;
      expect((await commit(service, repositoryId, r, "trust\n")).code).toBe("TRUST_REQUIRED");
      expect(runsSince(service, from)).toBe(0);
      expect(Object.values(built.facts.canaries).filter((log) => existsSync(join(built.root, log)))).toEqual([]);
    }),
    TIMEOUT_MS,
  );

  // Decision G3: the preflight runs Git reads before the gate decides, so the change ends the commit failed, and no commit process starts.
  caseTest(TASK, `F11: after approval, a one-byte edit of the hook file gives failed with TRUST_CHANGED, and no commit process starts ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-trust-changed" }, async (service) => {
      const repo = repoOf(buildF11(gitPath(), "t098-trust-changed", "traditional"));
      await underTest("commit");
      const { repositoryId } = await service.register(repo);
      await approve(service, repositoryId);
      const r = await reviewOk(service, repositoryId);
      const hook = gitPathOf(repo, "hooks/pre-commit");
      writeFileSync(hook, `${readFileSync(hook, "utf8")}#`);
      expect(outcome(await commit(service, repositoryId, r, "trust\n"))).toEqual(FAILED("TRUST_CHANGED"));
      expect(commitCalls(service)).toEqual([]);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `F12 SSH signing with denied trust gives TRUST_REQUIRED, and its gpg.ssh.defaultKeyCommand canary never runs ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-ssh" }, async (service) => {
      const built = buildF12(gitPath(), "t098-ssh", "ssh-signing");
      await underTest("commit");
      const { repositoryId, r } = await reviewed(service, repoOf(built));
      expect((await commit(service, repositoryId, r, "ssh\n")).code).toBe("TRUST_REQUIRED");
      expect(existsSync(join(built.root, built.facts.canaries["ssh-default-key"]!))).toBe(false);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `F17: the uploadpack canary never runs before or after approval; pre-commit sees GIT_NO_LAZY_FETCH=1; with a HEAD blob missing, --quiet skips the summary, the three hooks run, and the outcome is succeeded with the reviewed tree, parent, and branch ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-f17" }, async (service) => {
      const built = buildF17(gitPath(), "t098-f17", "partial-reset-soft");
      const repo = join(built.root, "clone");
      const log = join(built.root, "t098-hooks.log");
      const env = join(built.root, "t098-env.txt");
      putHook(repo, "pre-commit", `echo "$GIT_NO_LAZY_FETCH" > ${shQuote(env)}\necho pre-commit >> ${shQuote(log)}\n`);
      for (const event of ["commit-msg", "post-commit"]) putHook(repo, event, `echo ${event} >> ${shQuote(log)}\n`);
      const canary = join(built.root, built.facts.canaries.uploadpack!);
      const before = refState(gitPath(), repo);
      const reviewedTree = indexTree(repo);
      await underTest("commit");
      const { repositoryId, r } = await reviewed(service, repo);
      expect((await commit(service, repositoryId, r, "partial\n")).code).toBe("TRUST_REQUIRED");
      expect(existsSync(canary)).toBe(false);
      await approve(service, repositoryId);
      const approved = await reviewOk(service, repositoryId);
      expect(outcome(await commit(service, repositoryId, approved, "partial\n"))).toEqual(SUCCEEDED);
      expect({ canary: existsSync(canary), hooks: readFileSync(log, "utf8"), env: readFileSync(env, "utf8") }).toEqual({ canary: false, hooks: "pre-commit\ncommit-msg\npost-commit\n", env: "1\n" });
      expect({ target: refState(gitPath(), repo).headTarget, parents: commitFacts(repo).parents, tree: treeOf(repo, "HEAD") }).toEqual({ target: "refs/heads/main", parents: [before.headOid!], tree: reviewedTree });
    }),
    TIMEOUT_MS,
  );
});

describe("frames and replay (contract §2, §6 \"Recovery markers\")", () => {
  caseTest(TASK, `the mutation frames arrive as started, ended, then resolved; started precedes the lock creation, and no Git process starts before its reply ${COMMIT}`, SHELL, async () => {
    const name = "t098-frames";
    const repo = repoOf(buildChanged(gitPath(), name, "F09"));
    const lock = gitPathOf(repo, "index.lock");
    const seen: { lock: boolean; runs: number }[] = [];
    let current: Service | null = null;
    const onStarted = (frame: { operationId: string }) => void seen.push({ lock: existsSync(lock), runs: current!.runner.calls.filter((c) => c.operationId === frame.operationId).length });
    await withService({ name, onStarted }, async (service) => {
      current = service;
      await underTest("commit");
      const { repositoryId, r } = await reviewed(service, repo);
      const response = await commit(service, repositoryId, r, "frames\n");
      expect(outcome(response)).toEqual(SUCCEEDED);
      await until(() => mutationFrames(service, response.operationId!).length === 3, "mutation frames");
      expect(mutationFrames(service, response.operationId!)).toEqual(["started", "ended", "resolved"]);
      expect(seen).toEqual([{ lock: false, runs: 0 }]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, `a second commit with the consumed review token gets succeeded with the first operationId and its getOperation result, and starts no Git process ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-replay" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t098-replay", "F09"));
      await underTest("commit");
      const { repositoryId, r } = await reviewed(service, repo);
      const first = await commit(service, repositoryId, r, "replay\n");
      expect(outcome(first)).toEqual(SUCCEEDED);
      const from = service.runner.calls.length;
      const second = await commit(service, repositoryId, r, "replay\n");
      expect({ ...outcome(second), operationId: second.operationId, runs: runsSince(service, from) }).toEqual({ ...SUCCEEDED, operationId: first.operationId, runs: 0 });
      expect(second.result).toEqual((await service.getOperation(first.operationId!)).result);
      expect(commitCalls(service).length).toBe(1);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `a repeated requestId gives INVALID_REQUEST and starts no Git process ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-request-id" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t098-request-id", "F09"));
      await underTest("commit");
      const { repositoryId, r } = await reviewed(service, repo);
      const requestId = crypto.randomUUID();
      const envelope = { repositoryId, repositoryGeneration: r.read.generation, requestId };
      expect(outcome(await service.request("commit", commitPayload(r, "once\n"), envelope))).toEqual(SUCCEEDED);
      const from = service.runner.calls.length;
      service.send("commit", commitPayload(r, "once\n"), envelope);
      await until(() => service.responses.filter((s) => s.requestId === requestId).length === 2, "second response");
      const second = service.responses.filter((s) => s.requestId === requestId)[1]!;
      expect({ ...outcome(second), runs: runsSince(service, from) }).toEqual({ state: "rejected", code: "INVALID_REQUEST", runs: 0 });
    }),
    TIMEOUT_MS,
  );
});

describe("remedy command (contract §4 \"Quoting rule\", §9)", () => {
  // `hook run` runs the configured hooks, then the hook-folder hook (Git `hook.c`). The remedy never commits.
  caseTest(TASK, `F11: the GIT_FAILED hook command runs through PowerShell -NoProfile -Command, exits nonzero, prints both hook outputs, and creates no commit, also after the hook passes ${COMMIT}`, [...SHELL, "powershell"], () =>
    withService({ name: "t098-remedy-run" }, async (service) => {
      const repo = repoOf(buildF11(gitPath(), "t098-remedy-run", "rejecting"));
      git(repo, ["config", "hook.t098.command", "echo t098-configured-output"]);
      git(repo, ["config", "hook.t098.event", "pre-commit"]);
      await underTest("commit");
      const { response } = await hookFailure(service, repo);
      const command = remedies(response)[0]!.command!;
      const state = () => ({ refs: refState(gitPath(), repo), rawIndex: rawIndexDigest(gitPath(), repo) });
      const before = state();
      const shell = Bun.which("pwsh") ?? Bun.which("powershell")!;
      const runIt = () => Bun.spawnSync([shell, "-NoProfile", "-Command", command], { cwd: fixtureDir("t098-remedy-run-cwd"), env: fixtureEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const rejected = runIt();
      const output = `${rejected.stdout.toString()}${rejected.stderr.toString()}`;
      expect({ exit: rejected.exitCode !== 0, configured: output.includes("t098-configured-output"), traditional: output.includes(`rejected https://u:${F11_HOOK_TOKEN}@host.example/`) }).toEqual({ exit: true, configured: true, traditional: true });
      expect(state()).toEqual(before);
      putHook(repo, "pre-commit", "exit 0\n");
      expect(runIt().exitCode).toBe(0);
      expect(state()).toEqual(before);
    }),
    TIMEOUT_MS,
  );

  const QUOTES = ["'", "‘", "’", "‚", "‛"] as const;
  const MARKER = "arbareto-t098-marker";
  const hostile = (i: number) => join(fixtureDir(`t098-quote-${i}`), `w${QUOTES[i]}; ni ${MARKER} #`);

  caseTest(TASK, `each GIT_FAILED hook command doubles all five PowerShell quote characters of the worktree root ${COMMIT}`, SHELL, async () => {
    QUOTES.forEach((_, i) => rejectingRepo(hostile(i)));
    await underTest("commit");
    for (const [i, q] of QUOTES.entries()) {
      await withService({ name: `t098-quote-${i}` }, async (service) => {
        const { response, root } = await hookFailure(service, hostile(i));
        expect({ q, command: remedies(response)[0]!.command }).toEqual({ q, command: hookRemedy(root) });
        expect(hookRemedy(root).includes(psQuote(root))).toBe(true);
      });
    }
  }, TIMEOUT_MS);

  for (const [shell, capability] of [["pwsh", "pwsh"], ["powershell", "windows-powershell"]] as const) {
    caseTest(TASK, `each quoted GIT_FAILED hook command runs in ${shell} without the marker payload ${COMMIT}`, [...SHELL, capability], async () => {
      const dirs = QUOTES.map((q, i) => ({ q, dir: join(fixtureDir(`t098-${shell}-${i}`), basename(hostile(i))) }));
      for (const { dir } of dirs) rejectingRepo(dir);
      await underTest("commit");
      for (const [i, { q, dir }] of dirs.entries()) {
        let command = "";
        await withService({ name: `t098-${shell}-${i}` }, async (service) => {
          command = remedies((await hookFailure(service, dir)).response)[0]!.command!;
        });
        const cwd = fixtureDir(`t098-${shell}-${i}-cwd`);
        Bun.spawnSync([Bun.which(shell)!, "-NoProfile", "-Command", command], { cwd, env: fixtureEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        const markers = [cwd, dir].flatMap((d) => readdirSync(d, { recursive: true }).map(String)).filter((p) => basename(p) === MARKER);
        expect({ shell, q, markers }).toEqual({ shell, q, markers: [] });
        rmSync(cwd, { recursive: true, force: true });
      }
    }, TIMEOUT_MS);
  }

  caseTest(TASK, `a worktree root with U+201C gives no command, and the remedy shows the root as text ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-u201c" }, async (service) => {
      const dir = join(fixtureDir("t098-u201c"), "w“x");
      rejectingRepo(dir);
      await underTest("commit");
      const { response, root } = await hookFailure(service, dir);
      const [remedy] = remedies(response);
      expect({ command: remedy!.command, shown: remedy!.text.includes(root) }).toEqual({ command: null, shown: true });
    }),
    TIMEOUT_MS,
  );
});

describe("output tail (contract §9 \"Commit failure output\")", () => {
  const MARKER = "arbareto-t098-tail-marker";
  // 200 numbered lines: 195 plain lines of 346 bytes give 67,470 bytes, above 64 KiB. Lines 190 to 197 carry the cases of contract §9.
  function hookOutput(): { bytes: Buffer; plain: Set<string> } {
    const special: Record<number, string> = {
      190: "L190 \u001b[31mred\u001b[0m",
      191: "L191 c0\u0001\u0002 del\u007f c1\u0085\u009b",
      192: "L192 crlf\r",
      193: "L193 before\rafter",
      197: `L197 ${MARKER} https://u:TOKEN@host.example/`,
    };
    const plain = new Set<string>();
    const lines = Array.from({ length: 200 }, (_, i) => {
      if (special[i] !== undefined) return `${special[i]}\n`;
      const line = `L${String(i).padStart(3, "0")} ${"x".repeat(340)}`;
      plain.add(line);
      return `${line}\n`;
    });
    return { bytes: Buffer.from(lines.join(""), "utf8"), plain };
  }

  caseTest(TASK, `a rejecting hook with 200 lines and 64 KiB on stdout and stderr gives an outputTail of the last lines within 16 KiB and 100 lines, with the marker and <redacted>, without control sequences, TOKEN, or the first partial line; no log, diagnostic, or progress event holds the marker ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-tail" }, async (service) => {
      const built = buildChanged(gitPath(), "t098-tail", "F09");
      const repo = repoOf(built);
      const { bytes, plain } = hookOutput();
      const out = join(built.root, "t098-hook-output.txt");
      writeFileSync(out, bytes);
      expect(statSync(out).size).toBeGreaterThanOrEqual(64 * 1024);
      putHook(repo, "pre-commit", `cat ${shQuote(out)}\ncat ${shQuote(out)} >&2\nexit 1\n`);
      await underTest("commit");
      const { repositoryId } = await service.register(repo);
      await approve(service, repositoryId);
      const r = await reviewOk(service, repositoryId);
      const response = await commit(service, repositoryId, r, "tail\n");
      expect(outcome(response)).toEqual(FAILED("GIT_FAILED"));
      const tail = one<string>(response.result, "outputTail");
      const lines = tail.split("\n").filter((line) => line !== "");
      expect({
        bytes: Buffer.byteLength(tail) <= COMMIT_OUTPUT_TAIL_BYTES,
        lines: lines.length <= COMMIT_OUTPUT_TAIL_LINES,
        last: lines.at(-1),
        firstComplete: plain.has(lines[0]!),
        marker: tail.includes(MARKER),
        redacted: tail.includes("<redacted>"),
        token: tail.includes("TOKEN"),
        controls: /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(tail),
      }).toEqual({ bytes: true, lines: true, last: `L199 ${"x".repeat(340)}`, firstComplete: true, marker: true, redacted: true, token: false, controls: false });
      const elsewhere = JSON.stringify({ log: service.log(), progress: service.progress, diagnostic: valuesOf(response.result, "diagnostic"), others: service.responses.filter((s) => s !== response) });
      expect(elsewhere.includes(MARKER)).toBe(false);
    }),
    TIMEOUT_MS,
  );
});

describe("lingering jobs (contract §6 \"Lingering Jobs\", \"Completion signal\")", () => {
  caseTest(TASK, `F14 lingering: the post-commit child still runs after the commit, a following readWorkspace succeeds, and the outcome records lingeringDescendants 1 ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-lingering" }, async (service) => {
      const repo = repoOf(buildF14(gitPath(), "t098-lingering", "lingering"));
      await underTest("commit");
      const { repositoryId } = await service.register(repo);
      await approve(service, repositoryId);
      const r = await reviewOk(service, repositoryId);
      const response = await commit(service, repositoryId, r, "lingering\n");
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect(one<number>(response.result, "lingeringDescendants")).toBe(1);
      await readOk(service, repositoryId);
      expect(service.runner.liveRecorded()).toBe(1);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `F14 lingering: a child that writes to the inherited stdout and stderr 3 seconds after Git exits delays no outcome beyond 2 seconds, and no response holds the late text ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-late-output" }, async (service) => {
      const repo = repoOf(buildF14(gitPath(), "t098-late-output", "lingering"));
      const LATE = "arbareto-t098-late-output";
      const hook = gitPathOf(repo, "hooks/post-commit");
      writeFileSync(hook, readFileSync(hook, "utf8").replace("exit 0\n", `(sleep 3; echo ${LATE}; echo ${LATE} >&2) &\nexit 0\n`));
      await underTest("commit");
      const { repositoryId } = await service.register(repo);
      await approve(service, repositoryId);
      const r = await reviewOk(service, repositoryId);
      const response = await commit(service, repositoryId, r, "late\n");
      expect(outcome(response)).toEqual(SUCCEEDED);
      const [call] = commitCalls(service);
      const exitAt = call!.at + call!.durationMs!;
      expect(service.responseAt.get(response.requestId!)! - exitAt).toBeLessThan(2000);
      await Bun.sleep(4000);
      expect(JSON.stringify({ responses: service.responses, progress: service.progress, log: service.log() }).includes(LATE)).toBe(false);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `F14 lock: while the child holds index.lock, the next mutation gives LOCKED with the lock path, the remedy, and the lingering sentence with count 1; the lock bytes stay ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-f14-lock" }, async (service) => {
      const built = buildF14(gitPath(), "t098-f14-lock", "lock");
      const repo = repoOf(built);
      const lock = join(built.root, built.facts.notes.lock as string);
      await underTest("commit");
      const { repositoryId } = await service.register(repo);
      await approve(service, repositoryId);
      const r = await reviewOk(service, repositoryId);
      expect(outcome(await commit(service, repositoryId, r, "lock\n"))).toEqual(SUCCEEDED);
      await until(() => existsSync(lock), "child lock");
      const bytes = readFileSync(lock);
      const c = await selectHunks(service, repositoryId, "multi.txt", "unstaged");
      const response = (await applyHunk(service, repositoryId, c, c.hunkIds[0]!, "stage")) as ServiceResponse<{ path?: string; remedy?: Remedy }>;
      const text = response.result?.remedy?.text ?? "";
      const path = response.result?.path === undefined ? undefined : resolve(response.result.path);
      expect({ code: response.code, path, locked: text.includes(LOCKED_REMEDY), lingering: text.includes(lingeringSentence(1)), revoke: text.includes(REVOKE_SENTENCE) }).toEqual({
        code: "LOCKED",
        path: lock,
        locked: true,
        lingering: true,
        revoke: true,
      });
      expect(readFileSync(lock)).toEqual(bytes);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `F14 ref lock: while the child holds the current branch ref lock, the next commit gives GIT_FAILED, HEAD stays, the outcome names the lock as foreign, and the remedy holds the Other locks text, the lingering count, and the hook command ${COMMIT}`, SHELL, () =>
    withService({ name: "t098-ref-lock" }, async (service) => {
      const built = buildF14(gitPath(), "t098-ref-lock", "lock");
      const repo = repoOf(built);
      const hook = gitPathOf(repo, "hooks/post-commit");
      writeFileSync(hook, readFileSync(hook, "utf8").replace("index.lock", "refs/heads/main.lock"));
      const lock = gitPathOf(repo, "refs/heads/main.lock");
      await underTest("commit");
      const { repositoryId } = await service.register(repo);
      await approve(service, repositoryId);
      expect(outcome(await commit(service, repositoryId, await reviewOk(service, repositoryId), "first\n"))).toEqual(SUCCEEDED);
      await until(() => existsSync(lock), "child ref lock");
      put(repo, "staged.txt", "staged second\n");
      git(repo, ["add", "--", "staged.txt"]);
      const head = refState(gitPath(), repo);
      const r = await reviewOk(service, repositoryId);
      const response = await commit(service, repositoryId, r, "second\n");
      expect(outcome(response)).toEqual(FAILED("GIT_FAILED"));
      expect(refState(gitPath(), repo).headOid).toBe(head.headOid);
      expect(valuesOf(response.result, "foreign").flat().map((p) => resolve(p as string))).toContain(lock);
      const found = remedies(response);
      expect({
        otherLocks: found.some((f) => f.text.includes(OTHER_LOCKS_TEXT) && f.text.includes(lingeringSentence(1))),
        command: found.some((f) => f.command === hookRemedy(r.read.identity.worktreeRoot)),
      }).toEqual({ otherLocks: true, command: true });
      expect(existsSync(lock)).toBe(true);
    }),
    TIMEOUT_MS,
  );
});
