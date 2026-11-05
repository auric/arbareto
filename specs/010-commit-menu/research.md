# Research: History Commit Menu

## R1 Sources and fact marks

- Arbareto code: the design plan read the branch `007-first-release` at `ba095f87`. This spec checked a sample of its line references on `main` at `f0d79499`. The sample is `NoticeBand.tsx:24-25`, `workbench-review.ts:117`, `HistoryList.tsx:414-418`, `shortcuts.ts:180`, `integrate/texts.ts:64-65`, `HunkControls.tsx:34-46`, and `running-tooltip.tsx:10`. Each matched. Every implementer checks the other references on the base of the task.
- Git: Git for Windows 2.56.0.windows.2 on the reference PC. The probes ran in scratch repositories with `GIT_EDITOR=:`, `GIT_TERMINAL_PROMPT=0`, and an empty owned `GIT_CONFIG_GLOBAL`. Stdin was not a TTY. Each probe repository installs a logging hook for 12 events. Six events are pre-commit, prepare-commit-msg, commit-msg, post-commit, post-checkout, and post-rewrite. The other six are reference-transaction, post-index-change, pre-auto-gc, post-merge, pre-merge-commit, and pre-rebase.
- Probe scripts: `probe.sh` (P1 to P3c), `probe2.sh` (P4 to P7), and `probe3.sh` (P8 to P14). They are in local scratch, with the design plan of 2026-11-04. T001 ran them again on 2026-11-04 in a new local scratch folder. It added `probe4.sh` for P15 and P16, and set `GIT_CONFIG_NOSYSTEM=1`.
- Git documentation: the Git 2.56 HTML pages that Git for Windows installs. Local scratch holds text copies of git-reset(1), git-cherry-pick(1), git-revert(1), and git-tag(1).
- Constitution: `.specify/memory/constitution.md` on `main` `f0d79499`, footer "**Version**: 4.0.0 | **Ratified**: 2026-09-28 | **Last Amended**: 2026-10-22".
- Marks: "Probe" is a fact that a probe run showed. "Doc" is a fact of the Git documentation. "Code" is a fact of the Arbareto source. "Decision" is a plan choice.

## R2 Probe facts (Git 2.56.0.windows.2)

| ID | Case | Observed fact | Source | Used by |
|---|---|---|---|---|
| P1 | `cherry-pick <oid>` with a conflict | Exit 1. `CHERRY_PICK_HEAD` is present. No `.git/sequencer`. Hooks: post-index-change, reference-transaction. The status reader gives `cherry-picking` (`status.ts:278`). | `probe.sh` | plan D5, D6 |
| P1 | `cherry-pick --continue` after `git add` | Exit 0. Hooks: pre-commit, prepare-commit-msg, commit-msg, post-commit, post-index-change, reference-transaction. The message and author of the picked commit stay. | `probe.sh` | plan D6, spec FR-004 |
| P1b | `cherry-pick --abort` and `--skip` of a single pick | Exit 0. The marker goes. HEAD is unchanged. Hooks: post-index-change, reference-transaction. | `probe.sh` | spec Assumptions (no Skip) |
| P2 | clean `cherry-pick <oid>` | Exit 0. Hooks: prepare-commit-msg, post-commit, post-index-change, reference-transaction. No pre-commit and no commit-msg. | `probe.sh` | plan D5, SC-007 |
| P2b | clean `revert --no-edit <oid>` | The same hooks. Message `Revert "<subject>"` with the line `This reverts commit <oid>.` | `probe.sh` | plan D5 |
| P2c | revert conflict, then `revert --continue` | Exit 1 with `REVERT_HEAD`. Then exit 0 with the pre-commit and commit-msg hooks. | `probe.sh` | plan D6 |
| P3 | `reset --quiet --no-recurse-submodules --<mode> <oid> --` | Exit 0 for soft, mixed, and hard. Hooks: soft reference-transaction; mixed and hard post-index-change and reference-transaction. No post-checkout. | `probe.sh` | plan D4, SC-007 |
| P3b | `checkout --no-recurse-submodules --detach <oid> --` | Hooks: post-checkout, post-index-change, reference-transaction. | `probe.sh` | plan D2, SC-007 |
| P3c | `tag <n> <oid>` and `tag -a -m m <n> <oid>` | Hook: reference-transaction only. | `probe.sh` | plan D3, SC-007 |
| P4 | `reset --hard` with an untracked `new.txt` at a target path, and an untracked file `d` where the target has `d/f.txt` | Exit 0. Git overwrites `new.txt`. Git replaces the file `d` by the folder `d/`. Git loses the user bytes. | `probe2.sh` | plan D4 read 7, SC-002 |
| P4b | `git rm --cached p.txt`, an edit of it, then `reset --hard <target that tracks p.txt>` | Git loses the edit. `diff-tree HEAD <target>` lists nothing. `diff-index --cached <target>` lists `D p.txt`. | `probe2.sh` | plan D4 read 7, SC-002 |
| P4c | ignored file at a target path | `reset --hard` overwrites it. | `probe2.sh` | spec FR-043, FR-044 |
| P4d | staged new file and an unstaged edit, then `reset --hard HEAD~1` | Git deletes the staged new file. The edit goes. An unrelated untracked file stays. | `probe2.sh` | plan D4 effects |
| P4e | staged new file, then `reset --mixed HEAD~1` | The file becomes untracked. The working file stays. | `probe2.sh` | plan D4 effects |
| P5 | `revert --no-edit <root commit>` | Exit 0. Git reverts a root commit. | `probe2.sh` | plan D1 (no root reason) |
| P6 | cherry-pick of a change that HEAD already has, from a commit that is no ancestor of HEAD | Exit 1. `CHERRY_PICK_HEAD` stays, with 0 unmerged entries. `diff-index --cached --quiet HEAD --` gives exit 0. Continue gives exit 1. `--skip` clears the state. | `probe2.sh` | plan D6 `nothing-to-commit` |
| P6b | cherry-pick of an initially empty commit | Exit 1. `CHERRY_PICK_HEAD` stays, with 0 unmerged entries. This is the same stop as P6. | `probe2.sh` (T001) | plan D6 `nothing-to-commit` |
| P7 | cherry-pick or revert of a merge without `-m` | Exit 128. No marker. No change. With `-m 1`, exit 0. The revert message adds "reversing changes made to <parent 1>." | `probe2.sh` | plan D5 mainline |
| P8 | lightweight `tag` with `tag.gpgSign=true` | Exit 128 "no tag message?". No ref. | `probe3.sh` | plan D3 `tag-signing` |
| P8 | `tag -a -m` with `tag.gpgSign=true` and a failing `gpg.program` | Exit 128. No ref. Git leaves the message in `.git/TAG_EDITMSG`. | `probe3.sh` | plan D3 outcome |
| P8 | `tag -a -m` with `tag.forceSignAnnotated=true` | Not signed: an explicit `-a` wins (git-tag(1)). | `probe3.sh` | plan D3 step |
| P8 | `tag -m m` without `-a`, with `tag.forceSignAnnotated=true` | Git signs. With a failing gpg: exit 128 and no ref. So `-m` without `-a` respects the signing configuration. | `probe3.sh` | plan D3 step |
| P8 | existing tag name | Exit 128. No change. | `probe3.sh` | plan D3 read 2 |
| P9 | `check-ref-format refs/tags/<n>` | 0 for `v1.0`, `-x`, `@`, `HEAD`, and `a/b`. 1 for `a..b`, `x.lock`, `a b`, and empty. `git tag -x` and `git tag HEAD` refuse ("not a valid tag name"). | `probe3.sh` | plan D3 precheck |
| P10 | cherry-pick with an unrelated unstaged change; a staged unrelated change; an unstaged overlap | Exit 0 for the first. Exit 128 and no change for the second and the third. | `probe3.sh` | plan D5 read 7 |
| P11 | cherry-pick with `commit.gpgSign=true` and a failing gpg | Exit 1. `CHERRY_PICK_HEAD` stays, with 0 unmerged entries. The index differs from HEAD. | `probe3.sh` | plan D5 outcome |
| P12 | `cherry-pick <root commit>` onto another history | Exit 0. The parent is the old HEAD. | `probe3.sh` | plan D1 (no root reason) |
| P13 | Continue on an empty pick | Exit 1. The marker stays. | `probe3.sh` | plan D6 `nothing-to-commit` |
| P14 | `reset --soft HEAD` during a cherry-pick stop | `CHERRY_PICK_HEAD` goes. HEAD is unchanged. No design depends on it, because a workbench action refuses every non-normal state (plan Invariant 1). | `probe3.sh` (T001) | none |
| P15 | `diff-index --cached -R -z --no-renames --name-status <target> --` | In the HEAD-to-target direction, `A` means that the target has the path and the index lacks it. `D` means that only the index has it. T001: `A p.txt`, `D r.txt`, `D s.txt`. Without `-R`, the letters swap. | `probe4.sh` (T001) | plan D4 read 7 |
| P16 | A `reference-transaction` hook that writes another ref and exits 1 in the `prepared` state, for `git tag` and `git tag -m` | Git calls the hook with `preparing`, `prepared`, and `aborted` for the tag ref. `git tag` exits 128, and no tag ref exists. The ref that the hook wrote stays. | `probe4.sh` (T001) | plan D3 outcome, T008 |

## R3 Git documentation facts

- git-reset(1): `--soft` "Leave your working tree files and the index unchanged." `--mixed` "Leave your working directory unchanged. Update the index to match the new HEAD". `--hard` "Overwrite all files and directories with the version from <commit>, and may overwrite untracked files. Tracked files not in <commit> are removed". "Before the operation, ORIG_HEAD is set to the tip of the current branch." It documents `--[no-]recurse-submodules`. It has no EXIT STATUS section.
- git-cherry-pick(1) and git-revert(1): "This requires your working tree to be clean (no modifications from the HEAD commit)." Both document `-m <parent-number>`. Revert documents `--no-edit`, and `--edit` "is the default if you run the command from a terminal". Both document the sequencer `--continue`, `--skip`, and `--abort`. Neither has an EXIT STATUS section.
- git-tag(1) states: "Unless -f is given, the named tag must not yet exist."
- git-tag(1) states: "If -m <msg> ... is given and -a, -s, and -u <key-id> are absent, -a is implied."
- git-tag(1) `tag.forceSignAnnotated`: "If --annotate is specified on the command line, it takes precedence". The `--cleanup` default is `strip`.
- git-check-ref-format(1): the command "exits with a non-zero status if it is not" acceptable.
- git-show-ref(1) `--exists`: 0 when the ref exists, 2 when it is missing, 1 on an error.
- git-merge-base(1) `--is-ancestor`: 0 for true, 1 for false, and another non-zero status for an error.
- git-diff-index(1): `--quiet` implies `--exit-code`. 1 means differences, and 0 means none.
- git-rev-list(1) `--exclude=<glob>`: patterns for `--branches` do not start with `refs/heads`.
- git-commit(1) `--allow-empty`: Git refuses a commit with the same tree as its sole parent.
- Minimum Git: Windows 2.55.0.windows.3 (`admission.ts:9`), WSL 2.55.0 (`wsl-route.ts:12`).

## R4 Decisions

- Decision: the Hard check lists its candidates through `diff-index --cached -R` (P4b, P15). `diff-tree HEAD <target>` misses an index-removed path.
- Decision: the annotated tag step passes `-m` without `-a` (P8). The signing configuration then applies as Git defines it.
- Decision: Cherry-pick and Revert pass no `--`. A full object ID is unambiguous, and Git would read later items as paths.
- Decision: the clean-tree rule follows the documentation, not the P10 behavior. The documentation is the contract.
- Decision: the sequencer marker comes from the status reader marker facts, not from `gitPathExists` (R5 U1).
- Decision: Skip stays hidden for a single pick. Abort gives the same result (P1b).

## R5 Unverified assumptions

- U1 (corrected): `gitPathExists` (`sync-review.ts:265-274`) maps WSL paths. It reads the path through `gitPathOf` (`:247-263`), and a WSL path takes its UNC form (contract §11). The sequencer marker still comes from the status reader marker facts. Those facts are the chosen source.
- U2 Base UI places a row-anchored menu inside the window for a full-width history row. The 005 Changes rows show this behavior. 004 `research.md:673` records "Not checked: a row menu beside a full-width row". T017 checks it in the package.
- U3 Fixtures L and M of 001 `plan.md:1134-1135` exist in the perf fixture cache in the shape that SC-010 needs. M-R is new. T018 checks both.
- U4 The history row `parents` field can differ from Git's view under grafts or replace refs. The review reads the parents again, so the popover shows the review result.
- U5 No probe covered the pinentry behavior of a user's gpg setup under the service process.

## R6 Budgets and the measurement method

- The budgets of spec SC-010a to SC-011 come from the design plan section D. The user approved them on 2026-11-04, before any measured run.
- The method follows 001: the packaged build, warm, on the agreed hardware. The warm-up run counts for the every-run bound, never for the median (001 spec.md:95).
- The records (CPU seconds, process-tree private bytes, WSL times) have no budget.

## R7 Results

### Probe rerun (T001)

Done on 2026-11-04 with Git 2.56.0.windows.2. Scripts `probe.sh`, `probe2.sh`, `probe3.sh`, and `probe4.sh` ran in a new local scratch folder. Each repository was local, with an empty owned `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM=1`, and a `-c` identity.

- P1 to P13: each result equals the R2 table. No fact differs from the design.
- P3c: `git tag` and `git tag -a -m` ran only the `reference-transaction` hook.
- P6b, P14, P15, and P16: new results in the R2 table.
- P7 also showed that `cherry-pick -m 1` on a commit with one parent runs, and here it stopped as an empty pick. Arbareto refuses this case with `not-merge` before Git runs, so the design stays.

### Packaged and perf runs (T019)

Pending. T019 records the build identity, the OS version, each SC-009 to SC-011 result, and the records.

- SC-011 probe (decision 2026-11-05): the probe waits 2 ms between inputs. Thus a run of about 400 ms still gets the minimum of 20 inputs. The 001 SC-005 targets do not change.

### Requirement-to-test map (T022)

Pending. T022 maps every FR and SC to its tests (spec SC-012).
