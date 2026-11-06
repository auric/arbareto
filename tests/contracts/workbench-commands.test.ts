// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import * as commands from "../../src/git-service/commands";
import * as sc from "../../src/git-service/sync-commands";
import * as wb from "../../src/git-service/workbench-commands";

printOrigin("../../src/git-service/workbench-commands.ts", import.meta.dir);
printOrigin("../../src/git-service/sync-commands.ts", import.meta.dir);

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
  ["rebase walk of the moved branches", wb.rebaseWalkArgs(A, false, "sha1"), [...R, "rev-list", "--right-only", "--cherry-mark", "--no-merges", "--parents", `${A}...HEAD`]],
  ["rebase walk with rebase.rebaseMerges", wb.rebaseWalkArgs(S, true, "sha256"), [...R, "rev-list", "--right-only", "--cherry-mark", "--parents", `${S}...HEAD`]],
  ["delete local configuration keys", wb.localConfigArgs(), [...R, "config", "list", "--local", "--no-includes", "--show-scope", "--show-origin", "-z"]],
  ["readGitSettings global file entries", wb.configFileArgs("global"), [...R, "config", "list", "--global", "--no-includes", "--show-scope", "--show-origin", "-z"]],
  ["choose-side and mergetool stages", wb.stagesArgs(["uu.txt"]), [...R, "ls-files", "-z", "--stage", "--", "uu.txt"]],
  ["ignore exclude path", wb.excludePathArgs(), [...R, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]],
  ["worktree-remove status", wb.worktreeStatusArgs("D:\\src\\wt"), [...R, "-C", "D:\\src\\wt", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=dirty"]],
  ["worktree-remove trust listing of that worktree (plan.md O-20)", wb.worktreeConfigListArgs("D:\\src\\wt"), [...R, "-C", "D:\\src\\wt", "config", "list", "--show-scope", "--show-origin", "-z"]],
  ["worktree-remove hooks folder of that worktree", wb.worktreeHooksPathArgs("D:\\src\\wt"), [...R, "-C", "D:\\src\\wt", "rev-parse", "--git-path", "hooks"]],
  ["worktree-remove index of that worktree", wb.worktreeIndexArgs("D:\\src\\wt"), [...R, "-C", "D:\\src\\wt", "ls-files", "-z", "--stage"]],
  ["worktree-remove folders of that worktree", wb.worktreeLayoutArgs("D:\\src\\wt"), [...R, "-C", "D:\\src\\wt", "rev-parse", "--show-toplevel", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir"]],
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
  ["worktree add a tracking branch", wb.worktreeAddTrackArgs("team/x", "D:\\src\\wt", "refs/remotes/team/a/team/x"), [L, "worktree", "add", "--track", "-b", "team/x", "--", "D:\\src\\wt", "refs/remotes/team/a/team/x"]],
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
    expect(wb.worktreeAddTrackArgs("topic", "-p", "refs/remotes/origin/topic").slice(-3)).toEqual(["--", "-p", "refs/remotes/origin/topic"]);
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
    throws(() => wb.worktreeAddTrackArgs("topic", "D:\\wt", "refs/heads/topic"));
    throws(() => wb.worktreeAddTrackArgs("@", "D:\\wt", "refs/remotes/origin/x"));
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
    throws(() => wb.rebaseWalkArgs(A, false, "sha256"));
  });

  test("an empty or NUL item", () => {
    throws(() => wb.stagesArgs([]));
    throws(() => wb.stagesArgs([""]));
    throws(() => wb.chooseSideArgs("ours", "a\0b"));
    throws(() => wb.mergetoolArgs("", "uu.txt"));
    throws(() => wb.worktreeRemoveArgs("", false));
    throws(() => wb.worktreeStatusArgs(""));
    for (const args of [wb.worktreeConfigListArgs, wb.worktreeHooksPathArgs, wb.worktreeLayoutArgs, wb.worktreeIndexArgs]) for (const path of ["", "a\0b"]) throws(() => args(path));
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

// Feature 010 contract Δ3 and plan.md D3 to D6 (T006). Control: drop `--no-recurse-submodules` from the reset arguments; the reset case must fail.
describe("commit menu argv (feature 010 plan.md D3 to D6)", () => {
  const throws = (f: () => unknown) => expect(f).toThrow(TypeError);
  const COMMIT_READS: [string, string[], string[]][] = [
    ["reset Hard in-the-way candidates (P15, P17)", wb.resetCandidatesArgs(A, "sha1"), [...R, "diff-index", "-R", "-z", "--no-renames", "--name-status", A, "--"]],
    ["reset commits that leave", wb.rewrittenCountArgs(A, "sha1"), [...R, "rev-list", "--count", `${A}..HEAD`]],
    ["reset commits that arrive", wb.gainCountArgs(A, "sha1"), [...R, "rev-list", "--count", `HEAD..${A}`]],
    ["reset reflog-only count", wb.reflogOnlyCountArgs(A, "main", "sha1"), [...R, "rev-list", "--count", "HEAD", "--not", A, "--exclude=main", "--branches", "--tags", "--remotes"]],
    ["reset reflog-only count of a slash branch", wb.reflogOnlyCountArgs(S, "team/x", "sha256"), [...R, "rev-list", "--count", "HEAD", "--not", S, "--exclude=team/x", "--branches", "--tags", "--remotes"]],
    ["reset Mixed and Hard index match", wb.indexMatchArgs(A, "sha1"), [...R, "diff-index", "--cached", "--quiet", A, "--"]],
    ["Continue nothing-to-commit index match", wb.indexMatchArgs("HEAD", "sha1"), [...R, "diff-index", "--cached", "--quiet", "HEAD", "--"]],
    ["tag name check", wb.tagNameCheckArgs("v1.0"), [...R, "check-ref-format", "refs/tags/v1.0"]],
    ["tag name check of a slash name", wb.tagNameCheckArgs("a/b"), [...R, "check-ref-format", "refs/tags/a/b"]],
    ["tag exists", commands.headRefExistsArgs("refs/tags/v1.0"), [...R, "show-ref", "--exists", "refs/tags/v1.0"]],
    ["cherry-pick already on the branch", wb.commitIsAncestorArgs(A, "sha1"), [...R, "merge-base", "--is-ancestor", A, "HEAD"]],
    ["cherry-pick and revert parents", wb.parentsArgs(A, "sha1"), [...R, "rev-list", "--parents", "-n", "1", A, "--"]],
  ];
  const COMMIT_STEPS: [string, string[], string[]][] = [
    ["reset soft", wb.resetArgs(A, "soft", "sha1"), [L, "reset", "--quiet", "--no-recurse-submodules", "--soft", A, "--"]],
    ["reset mixed", wb.resetArgs(A, "mixed", "sha1"), [L, "reset", "--quiet", "--no-recurse-submodules", "--mixed", A, "--"]],
    ["reset hard", wb.resetArgs(S, "hard", "sha256"), [L, "reset", "--quiet", "--no-recurse-submodules", "--hard", S, "--"]],
    ["lightweight tag", wb.tagArgs("v1.0", A, null, "sha1"), [L, "tag", "--end-of-options", "v1.0", A]],
    ["annotated tag", wb.tagArgs("v1.0", A, "Release 1.0\n\nNotes", "sha1"), [L, "tag", "-m", "Release 1.0\n\nNotes", "--end-of-options", "v1.0", A]],
    ["cherry-pick", wb.cherryPickArgs(A, null, "sha1"), [L, "cherry-pick", A]],
    ["cherry-pick a merge with -m 2", wb.cherryPickArgs(A, 2, "sha1"), [L, "cherry-pick", "-m", "2", A]],
    ["revert", wb.revertCommitArgs(A, null, "sha1"), [L, "revert", "--no-edit", A]],
    ["revert a merge with -m 1", wb.revertCommitArgs(S, 1, "sha256"), [L, "revert", "--no-edit", "-m", "1", S]],
    ["abort a cherry-pick", sc.abortArgs("cherry-picking"), [L, "cherry-pick", "--abort"]],
    ["abort a revert", sc.abortArgs("reverting"), [L, "revert", "--abort"]],
    ["continue a cherry-pick", sc.continueArgs("cherry-picking"), [L, "cherry-pick", "--continue"]],
    ["continue a revert", sc.continueArgs("reverting"), [L, "revert", "--continue"]],
    ["abort a merge stays", sc.abortArgs("merging"), [L, "merge", "--abort"]],
    ["continue a rebase stays", sc.continueArgs("rebasing"), [L, "rebase", "--continue"]],
    ["continue a merge stays", sc.continueArgs("merging"), [L, "commit", "--quiet"]],
  ];

  for (const [name, actual, expected] of [...COMMIT_READS, ...COMMIT_STEPS]) test(name, () => expect(actual).toEqual(expected));

  test("every array starts with --no-lazy-fetch, and every read has --no-optional-locks and --literal-pathspecs", () => {
    for (const [, args] of [...COMMIT_READS, ...COMMIT_STEPS]) expect(args[0]).toBe(L);
    for (const [, args] of COMMIT_READS) expect(args.slice(0, 3)).toEqual(R);
  });

  // Research.md R4: cherry-pick and revert pass no `--`, and no option changes Git's own message, signing, or empty-commit rule.
  test("cherry-pick and revert pass no --, no hook bypass, and no signing or empty-commit option", () => {
    for (const [, args] of COMMIT_STEPS.filter(([, a]) => a[1] === "cherry-pick" || a[1] === "revert").filter(([, a]) => !a.includes("--abort") && !a.includes("--continue"))) {
      for (const item of ["--", "-x", "-s", "-n", "--no-gpg-sign", "--allow-empty", "--empty", "--no-verify", "--edit"]) expect(args).not.toContain(item);
    }
  });

  // Research.md R2 P8 and R4: the annotated tag passes `-m` without `-a`, so `tag.forceSignAnnotated` applies. No step replaces a tag or skips signing.
  test("a tag step passes no -a, no -f, and no --no-sign; a name that starts with '-' stays after --end-of-options", () => {
    for (const args of [wb.tagArgs("v1", A, null, "sha1"), wb.tagArgs("v1", A, "m", "sha1")]) for (const item of ["-a", "-f", "--force", "--no-sign", "-s"]) expect(args).not.toContain(item);
    expect(wb.tagArgs("-x", A, "-m", "sha1").slice(-5)).toEqual(["-m", "-m", "--end-of-options", "-x", A]);
  });

  test("refused inputs", () => {
    throws(() => wb.resetArgs("HEAD~1", "soft", "sha1"));
    throws(() => wb.resetArgs(A, "keep" as "soft", "sha1"));
    throws(() => wb.resetArgs(A, "merge" as "soft", "sha1"));
    throws(() => wb.resetCandidatesArgs(S, "sha1"));
    throws(() => wb.reflogOnlyCountArgs(A, "a..b", "sha1"));
    throws(() => wb.indexMatchArgs("HEAD~1", "sha1"));
    throws(() => wb.tagArgs("a..b", A, null, "sha1"));
    throws(() => wb.tagArgs("v1", A, "a\0b", "sha1"));
    throws(() => wb.tagArgs("v1", A, "", "sha1"));
    throws(() => wb.tagArgs("v1", "HEAD", null, "sha1"));
    throws(() => wb.tagNameCheckArgs(""));
    throws(() => wb.tagNameCheckArgs("a\0b"));
    for (const mainline of [0, 65, 1.5, -1]) {
      throws(() => wb.cherryPickArgs(A, mainline, "sha1"));
      throws(() => wb.revertCommitArgs(A, mainline, "sha1"));
    }
    throws(() => wb.cherryPickArgs("HEAD", null, "sha1"));
    throws(() => wb.parentsArgs("-x", "sha1"));
    throws(() => wb.commitIsAncestorArgs("main", "sha1"));
    throws(() => sc.abortArgs("sequencer-active" as "merging"));
    throws(() => sc.continueArgs("conflicted" as "merging"));
  });
});
