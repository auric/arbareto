// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import * as commands from "../../src/git-service/commands";
import * as wb from "../../src/git-service/workbench-commands";

printOrigin("../../src/git-service/workbench-commands.ts", import.meta.dir);

// Contract Δ3, Δ10, and plan.md D2 to D11: the argv vectors of `workbench-commands.ts` (T007).

const L = "--no-lazy-fetch";
const R = [L, "--no-optional-locks", "--literal-pathspecs"];
const A = "a".repeat(40);
const B = "b".repeat(40);
const S = "c".repeat(64);
const MESSAGE = "Merge branch 'topic'\n\n* topic:\n  Topic work\n";

const READS: [string, string[], string[]][] = [
  ["readBranches for-each-ref", wb.branchListArgs(), [...R, "for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)%00%(HEAD)%00%(symref)%00%(objecttype)%00%(*objectname)%00%(*objecttype)", "refs/heads", "refs/remotes"]],
  ["readWorktrees", wb.worktreeListArgs(), [...R, "worktree", "list", "--porcelain", "-z"]],
  ["readGitSettings", commands.configListArgs(), [...R, "config", "list", "--show-scope", "--show-origin", "-z"]],
  ["switch tracked status", wb.trackedStatusArgs(), [...R, "status", "--porcelain=v2", "-z", "--untracked-files=no", "--ignore-submodules=dirty"]],
  ["rebase tracked status", wb.rebaseStatusArgs(), [...R, "status", "--porcelain=v2", "-z", "--untracked-files=no", "--ignore-submodules=all"]],
  ["switch target commit", wb.refPeelArgs("refs/remotes/one/topic"), [...R, "for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)", "refs/remotes/one/topic"]],
  ["switch unreachable detached commit", wb.containsArgs(A, "sha1"), [...R, "for-each-ref", `--contains=${A}`, "--count=1", "--format=%(refname)"]],
  ["stash exists", commands.headRefExistsArgs("refs/stash"), [...R, "show-ref", "--exists", "refs/stash"]],
  ["stash value", wb.stashValueArgs(), [...R, "rev-parse", "--verify", "-q", "refs/stash"]],
  ["stash reflog of the S checks and the drop step", wb.stashReflogArgs(), [...R, "log", "-g", "-z", "--no-show-signature", "--format=%H", "refs/stash", "--"]],
  ["discard changed paths", wb.changedPathsArgs(A, B, "sha1"), [...R, "diff-tree", "-r", "-z", "--no-renames", "--name-status", A, B]],
  ["discard index stages", wb.stagesArgs(["a.txt", "dir/new.txt"]), [...R, "ls-files", "-z", "--stage", "--", "a.txt", "dir/new.txt"]],
  ["track name exists", commands.headRefExistsArgs("refs/heads/topic"), [...R, "show-ref", "--exists", "refs/heads/topic"]],
  ["branch name check", wb.branchNameCheckArgs("topic"), [...R, "check-ref-format", "--branch", "topic"]],
  ["delete unmerged count", wb.unmergedCountArgs(A, "topic", "sha1"), [...R, "rev-list", "--count", A, "--not", "--exclude=topic", "--branches", "--tags", "--remotes"]],
  ["delete reflog exists", wb.headReflogExistsArgs(), [...R, "reflog", "exists", "HEAD"]],
  ["delete HEAD reflog", wb.headReflogArgs(), [...R, "log", "-g", "-z", "--no-show-signature", "--format=%H", "-n", "10000", "HEAD", "--"]],
  ["merge counts", wb.mergeCountsArgs(A, "sha1"), [...R, "rev-list", "--left-right", "--count", `HEAD...${A}`]],
  ["merge fast-forward check", wb.headIsAncestorArgs(A, "sha1"), [...R, "merge-base", "--is-ancestor", "HEAD", A]],
  ["merge message preview", wb.mergeMessageArgs(), [...R, "fmt-merge-msg"]],
  ["rebase moved count", wb.movedCountArgs(A, false, "sha1"), [...R, "rev-list", "--count", "--right-only", "--cherry-pick", "--no-merges", `${A}...HEAD`]],
  ["rebase moved count with rebase.rebaseMerges", wb.movedCountArgs(A, true, "sha1"), [...R, "rev-list", "--count", "--right-only", "--cherry-pick", `${A}...HEAD`]],
  ["rebase rewritten count", wb.rewrittenCountArgs(A, "sha1"), [...R, "rev-list", "--count", `${A}..HEAD`]],
  ["rebase held count", wb.heldCountArgs(A, "sha1"), [...R, "rev-list", "--count", `${A}..HEAD`, "--not", "--remotes"]],
  ["rebase force note count", wb.forceNoteCountArgs(A, "refs/remotes/origin/topic", "sha1"), [...R, "rev-list", "--count", `${A}..HEAD`, "--not", "refs/remotes/origin/topic"]],
  ["rebase moved branches", wb.updateRefsArgs(A, "sha1"), [...R, "for-each-ref", "--merged=HEAD", `--no-merged=${A}`, "--format=%(refname)", "refs/heads"]],
  ["choose-side and mergetool stages", wb.stagesArgs(["uu.txt"]), [...R, "ls-files", "-z", "--stage", "--", "uu.txt"]],
  ["ignore exclude path", wb.excludePathArgs(), [...R, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]],
  ["worktree-remove status", wb.worktreeStatusArgs("D:\\src\\wt"), [...R, "-C", "D:\\src\\wt", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=dirty"]],
  ["amend message", wb.commitObjectArgs(A, "sha1"), [...R, "cat-file", "commit", A]],
  ["amend upstream", wb.upstreamOfArgs("refs/heads/main"), [...R, "for-each-ref", "--format=%(upstream)", "refs/heads/main"]],
  ["amend rewrites upstream", wb.headIsAncestorArgs("refs/remotes/origin/main", "sha1"), [...R, "merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main"]],
];

// research.md R21 F1: Git exits 128 for `check-ignore --no-index` with `--literal-pathspecs`.
const CHECK_IGNORE = [L, "--no-optional-locks", "check-ignore", "-z", "--stdin", "--no-index"];

const merge = (flags: string[]) => [L, "merge", "--no-autostash", "--no-edit", ...flags, "--no-log", "-m", MESSAGE, "--end-of-options", "refs/heads/topic"];

const STEPS: [string, string[], string[]][] = [
  ["switch keep", wb.switchArgs("topic"), [L, "checkout", "--no-guess", "--no-recurse-submodules", "topic", "--"]],
  ["switch track", wb.trackArgs("topic", "refs/remotes/origin/topic"), [L, "checkout", "--no-guess", "--no-recurse-submodules", "-b", "topic", "--track=direct", "refs/remotes/origin/topic", "--"]],
  ["switch detach", wb.detachArgs(A, "sha1"), [L, "checkout", "--no-recurse-submodules", "--detach", A, "--"]],
  ["stash push", wb.stashPushArgs("topic"), [L, "stash", "push", "--quiet", "-m", "Arbareto: switch to topic"]],
  ["stash apply", wb.stashApplyArgs(S, "sha256"), [L, "stash", "apply", "--index", S]],
  ["stash drop", wb.stashDropArgs(2), [L, "stash", "drop", "--quiet", "stash@{2}"]],
  ["create and switch", wb.createSwitchArgs("fresh", A, "sha1"), [L, "checkout", "--no-recurse-submodules", "-b", "fresh", A, "--"]],
  ["create", wb.createArgs("fresh", A, "sha1"), [L, "branch", "--end-of-options", "fresh", A]],
  ["rename", wb.renameArgs("old/name", "new/name"), [L, "branch", "-m", "--end-of-options", "old/name", "new/name"]],
  ["rename from @ (F29)", wb.renameArgs("@", "from-at"), [L, "branch", "-m", "--end-of-options", "@", "from-at"]],
  ["delete ref", wb.deleteRefArgs("topic", A, "sha1"), [L, "update-ref", "--no-deref", "-d", "refs/heads/topic", A]],
  ["delete ref @", wb.deleteRefArgs("@", A, "sha1"), [L, "update-ref", "--no-deref", "-d", "refs/heads/@", A]],
  ["delete branch section", wb.removeBranchSectionArgs("topic"), [L, "config", "--local", "--remove-section", "branch.topic"]],
  ["merge commit", wb.mergeArgs("refs/heads/topic", { result: "merge", noFastForward: false, noCommit: false, message: MESSAGE }), merge([])],
  ["merge commit --no-ff", wb.mergeArgs("refs/heads/topic", { result: "merge", noFastForward: true, noCommit: false, message: MESSAGE }), merge(["--no-ff"])],
  ["merge commit --no-commit", wb.mergeArgs("refs/heads/topic", { result: "merge", noFastForward: true, noCommit: true, message: MESSAGE }), merge(["--no-ff", "--no-commit"])],
  ["merge squash", wb.mergeArgs("refs/heads/topic", { result: "squash" }), [L, "merge", "--no-autostash", "--no-edit", "--squash", "--end-of-options", "refs/heads/topic"]],
  ["merge a remote-tracking branch", wb.mergeArgs("refs/remotes/origin/topic", { result: "squash" }), [L, "merge", "--no-autostash", "--no-edit", "--squash", "--end-of-options", "refs/remotes/origin/topic"]],
  ["rebase", wb.rebaseOntoArgs("refs/heads/up", false, false), [L, "rebase", "--no-autostash", "--no-autosquash", "--end-of-options", "refs/heads/up"]],
  ["rebase autostash", wb.rebaseOntoArgs("refs/heads/up", true, false), [L, "rebase", "--autostash", "--no-autosquash", "--end-of-options", "refs/heads/up"]],
  ["rebase autosquash", wb.rebaseOntoArgs("refs/heads/up", false, true), [L, "rebase", "--no-autostash", "--autosquash", "--end-of-options", "refs/heads/up"]],
  ["rebase both", wb.rebaseOntoArgs("refs/remotes/origin/up", true, true), [L, "rebase", "--autostash", "--autosquash", "--end-of-options", "refs/remotes/origin/up"]],
  ["choose ours", wb.chooseSideArgs("ours", "uu.txt"), [L, "--literal-pathspecs", "checkout", "--no-recurse-submodules", "--ours", "--", "uu.txt"]],
  ["choose theirs", wb.chooseSideArgs("theirs", "a[b].txt"), [L, "--literal-pathspecs", "checkout", "--no-recurse-submodules", "--theirs", "--", "a[b].txt"]],
  ["mergetool", wb.mergetoolArgs("fixture", "uu.txt"), [L, "--literal-pathspecs", "mergetool", "--tool=fixture", "--no-prompt", "--", "uu.txt"]],
  ["worktree add a new branch", wb.worktreeAddNewArgs("wt-new", "D:\\src\\wt new", A, "sha1"), [L, "worktree", "add", "-b", "wt-new", "--", "D:\\src\\wt new", A]],
  ["worktree add an existing branch", wb.worktreeAddExistingArgs("D:\\src\\wt", "merged"), [L, "worktree", "add", "--", "D:\\src\\wt", "merged"]],
  ["worktree remove", wb.worktreeRemoveArgs("D:\\src\\wt", false), [L, "worktree", "remove", "--", "D:\\src\\wt"]],
  ["worktree remove --force", wb.worktreeRemoveArgs("D:\\src\\wt", true), [L, "worktree", "remove", "--force", "--", "D:\\src\\wt"]],
  ["worktree prune", wb.worktreePruneArgs(), [L, "worktree", "prune"]],
  ["config set local", wb.configSetArgs("local", "user.name", "Fixture Name"), [L, "config", "set", "--local", "--", "user.name", "Fixture Name"]],
  ["config set global", wb.configSetArgs("global", "core.autocrlf", "input"), [L, "config", "set", "--global", "--", "core.autocrlf", "input"]],
  ["config set an empty value", wb.configSetArgs("local", "core.editor", ""), [L, "config", "set", "--local", "--", "core.editor", ""]],
  ["config unset", wb.configUnsetArgs("global", "user.name"), [L, "config", "unset", "--global", "--", "user.name"]],
  ["amend", wb.amendArgs(), [L, "commit", "--quiet", "--amend", "--file=-"]],
];

describe("workbench argv vectors", () => {
  for (const [name, actual, expected] of [...READS, ["check-ignore", wb.checkIgnoreArgs(), CHECK_IGNORE] as [string, string[], string[]], ...STEPS]) {
    test(name, () => expect(actual).toEqual(expected));
  }

  test("every array starts with --no-lazy-fetch", () => {
    for (const [, args] of [...READS, ...STEPS]) expect(args[0]).toBe(L);
    expect(wb.checkIgnoreArgs()[0]).toBe(L);
  });

  test("every read has --no-optional-locks and --literal-pathspecs before the command", () => {
    for (const [, args] of READS) expect(args.slice(0, 3)).toEqual(R);
  });

  test("check-ignore --no-index has no --literal-pathspecs (research.md R21 F1)", () => {
    expect(wb.checkIgnoreArgs()).not.toContain("--literal-pathspecs");
    expect(wb.checkIgnoreArgs().slice(0, 2)).toEqual([L, "--no-optional-locks"]);
  });

  test("every checkout step has --no-recurse-submodules", () => {
    const checkouts = STEPS.filter(([, args]) => args.includes("checkout"));
    expect(checkouts.length).toBe(6);
    for (const [, args] of checkouts) expect(args).toContain("--no-recurse-submodules");
  });

  test("a reflog read never runs a signature program", () => {
    for (const [, args] of READS) if (args.includes("-g")) expect(args).toContain("--no-show-signature");
  });
});

describe("merge and rebase argv (plan.md D5, D6, research.md R21 F12, F15, F30)", () => {
  const commit = (noFastForward: boolean, noCommit: boolean, message = MESSAGE) => wb.mergeArgs("refs/heads/topic", { result: "merge", noFastForward, noCommit, message });

  test("Merge commit always passes --no-log -m <message> with the preview or the edited text", () => {
    for (const [ff, nc] of [[false, false], [true, false], [true, true], [false, true]] as const) {
      const args = commit(ff, nc);
      expect(args.slice(-5)).toEqual(["--no-log", "-m", MESSAGE, "--end-of-options", "refs/heads/topic"]);
      expect(args.filter((a) => a === "-m").length).toBe(1);
    }
    expect(commit(false, false, "Edited text").slice(-4, -2)).toEqual(["-m", "Edited text"]);
  });

  test("Squash passes no --no-log and no -m", () => {
    const args = wb.mergeArgs("refs/heads/topic", { result: "squash" });
    expect(args).not.toContain("-m");
    expect(args).not.toContain("--no-log");
    expect(args).not.toContain("--no-ff");
    expect(args).not.toContain("--no-commit");
  });

  test("both results pass --end-of-options with the full ref", () => {
    for (const args of [commit(false, false), wb.mergeArgs("refs/heads/topic", { result: "squash" })]) expect(args.slice(-2)).toEqual(["--end-of-options", "refs/heads/topic"]);
  });

  test("a message that starts with '-' stays the -m value", () => {
    expect(commit(false, false, "-x").slice(-4)).toEqual(["-m", "-x", "--end-of-options", "refs/heads/topic"]);
  });

  test("rebase always passes the explicit Autostash and Autosquash forms", () => {
    for (const autostash of [false, true]) {
      for (const autosquash of [false, true]) {
        const args = wb.rebaseOntoArgs("refs/heads/up", autostash, autosquash);
        expect(args.filter((a) => a === "--autostash" || a === "--no-autostash")).toEqual([autostash ? "--autostash" : "--no-autostash"]);
        expect(args.filter((a) => a === "--autosquash" || a === "--no-autosquash")).toEqual([autosquash ? "--autosquash" : "--no-autosquash"]);
        expect(args.slice(-2)).toEqual(["--end-of-options", "refs/heads/up"]);
      }
    }
  });

  // builtin/merge.c `merge_name`: the line that `git merge <name>` builds for a local or a remote-tracking branch.
  test("the fmt-merge-msg input line holds the short display name", () => {
    expect(wb.mergeMessageInput("refs/heads/feature/x", A, "sha1")).toBe(`${A}\t\tbranch 'feature/x' of .\n`);
    expect(wb.mergeMessageInput("refs/remotes/origin/topic", A, "sha1")).toBe(`${A}\t\tremote-tracking branch 'origin/topic' of .\n`);
  });
});

describe("names stay after --end-of-options or --", () => {
  test("branch names that start with '-'", () => {
    expect(wb.createArgs("-x", A, "sha1").slice(-3)).toEqual(["--end-of-options", "-x", A]);
    expect(wb.renameArgs("-x", "-y").slice(-3)).toEqual(["--end-of-options", "-x", "-y"]);
    expect(wb.trackArgs("-x", "refs/remotes/origin/-x").slice(4, 6)).toEqual(["-b", "-x"]);
  });

  test("paths, keys, and values that start with '-'", () => {
    expect(wb.chooseSideArgs("ours", "-n.txt").slice(-2)).toEqual(["--", "-n.txt"]);
    expect(wb.mergetoolArgs("fixture", "--x").slice(-2)).toEqual(["--", "--x"]);
    expect(wb.stagesArgs(["-n.txt"]).slice(-2)).toEqual(["--", "-n.txt"]);
    expect(wb.worktreeAddExistingArgs("-p", "merged").slice(-3)).toEqual(["--", "-p", "merged"]);
    expect(wb.worktreeRemoveArgs("-p", false).slice(-2)).toEqual(["--", "-p"]);
    expect(wb.configSetArgs("local", "user.name", "-value").slice(-3)).toEqual(["--", "user.name", "-value"]);
  });
});

describe("refused inputs", () => {
  const throws = (f: () => unknown) => expect(f).toThrow(TypeError);

  // plan.md D3, D4, D10, and research.md R21 F29: Git reads `@` as HEAD in a revision argument.
  test("the name @ in a revision or a new-name position", () => {
    throws(() => wb.switchArgs("@"));
    throws(() => wb.worktreeAddExistingArgs("D:\\wt", "@"));
    throws(() => wb.trackArgs("@", "refs/remotes/origin/x"));
    throws(() => wb.createArgs("@", A, "sha1"));
    throws(() => wb.createSwitchArgs("@", A, "sha1"));
    throws(() => wb.renameArgs("old", "@"));
    throws(() => wb.worktreeAddNewArgs("@", "D:\\wt", A, "sha1"));
  });

  // contract §3: the switch argv has no end-of-options marker, so Git would read such a name as an option.
  test("a switch name that starts with '-'", () => {
    throws(() => wb.switchArgs("-f"));
    throws(() => wb.switchArgs("--force"));
  });

  test("a name or a ref that fails the ref rules", () => {
    throws(() => wb.switchArgs("bad..name"));
    throws(() => wb.createArgs("a b", A, "sha1"));
    throws(() => wb.renameArgs("x*", "y"));
    throws(() => wb.deleteRefArgs("", A, "sha1"));
    throws(() => wb.refPeelArgs("topic"));
    throws(() => wb.refPeelArgs("refs/tags/v1"));
    throws(() => wb.mergeArgs("topic", { result: "squash" }));
    throws(() => wb.mergeArgs("refs/tags/v1", { result: "squash" }));
    throws(() => wb.mergeArgs("refs/heads/a..b", { result: "squash" }));
    throws(() => wb.rebaseOntoArgs("refs/heads/a b", false, false));
    throws(() => wb.mergeMessageInput("refs/heads/a~1", A, "sha1"));
    throws(() => wb.rebaseOntoArgs("-x", false, false));
    throws(() => wb.trackArgs("topic", "refs/heads/topic"));
    throws(() => wb.forceNoteCountArgs(A, "origin/topic", "sha1"));
    throws(() => wb.upstreamOfArgs("main"));
    throws(() => wb.mergeMessageInput("refs/tags/v1", A, "sha1"));
    throws(() => wb.headIsAncestorArgs("HEAD~1", "sha1"));
  });

  test("an object ID of another format", () => {
    throws(() => wb.detachArgs(S, "sha1"));
    throws(() => wb.containsArgs("HEAD", "sha1"));
    throws(() => wb.changedPathsArgs(A, S, "sha1"));
    throws(() => wb.stashApplyArgs(A, "sha256"));
    throws(() => wb.createArgs("x", A.toUpperCase(), "sha1"));
    throws(() => wb.movedCountArgs("a".repeat(39), false, "sha1"));
  });

  test("an empty or NUL item", () => {
    throws(() => wb.stagesArgs([]));
    throws(() => wb.stagesArgs([""]));
    throws(() => wb.chooseSideArgs("ours", "a\0b"));
    throws(() => wb.mergetoolArgs("", "uu.txt"));
    throws(() => wb.worktreeRemoveArgs("", false));
    throws(() => wb.worktreeStatusArgs(""));
    throws(() => wb.configSetArgs("local", "", "x"));
    throws(() => wb.configSetArgs("local", "user.name", "a\0b"));
    throws(() => wb.stashPushArgs(""));
    throws(() => wb.mergeArgs("refs/heads/topic", { result: "merge", noFastForward: false, noCommit: false, message: "" }));
    throws(() => wb.mergeArgs("refs/heads/topic", { result: "merge", noFastForward: false, noCommit: false, message: "a\0b" }));
    throws(() => wb.branchNameCheckArgs("a\0b"));
  });

  test("an unknown scope, side, result, or stash position", () => {
    throws(() => wb.configSetArgs("system" as "local", "user.name", "x"));
    throws(() => wb.configUnsetArgs("worktree" as "local", "user.name"));
    throws(() => wb.chooseSideArgs("base" as "ours", "uu.txt"));
    throws(() => wb.mergeArgs("refs/heads/topic", { result: "octopus" } as unknown as { result: "squash" }));
    throws(() => wb.stashDropArgs(-1));
    throws(() => wb.stashDropArgs(1.5));
  });
});
