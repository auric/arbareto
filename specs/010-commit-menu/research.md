# Research: History Commit Menu

## R1 Sources and fact marks

- Arbareto code: the design plan read the branch `007-first-release` at `ba095f87`. This spec checked a sample of its line references on `main` at `f0d79499`. The sample is `NoticeBand.tsx:24-25`, `workbench-review.ts:117`, `HistoryList.tsx:414-418`, `shortcuts.ts:180`, `integrate/texts.ts:64-65`, `HunkControls.tsx:34-46`, and `running-tooltip.tsx:10`. Each matched. Every implementer checks the other references on the base of the task.
- Git: Git for Windows 2.56.0.windows.2 on the reference PC. The probes ran in scratch repositories with `GIT_EDITOR=:`, `GIT_TERMINAL_PROMPT=0`, and an empty owned `GIT_CONFIG_GLOBAL`. Stdin was not a TTY. Each probe repository installs a logging hook for 12 events. Six events are pre-commit, prepare-commit-msg, commit-msg, post-commit, post-checkout, and post-rewrite. The other six are reference-transaction, post-index-change, pre-auto-gc, post-merge, pre-merge-commit, and pre-rebase.
- Probe scripts: `probe.sh` (P1 to P3c), `probe2.sh` (P4 to P7), and `probe3.sh` (P8 to P14). They are in local scratch, with the design plan of 2026-11-04. T001 ran them again on 2026-11-04 in a new local scratch folder. It added `probe4.sh` for P15 and P16, and set `GIT_CONFIG_NOSYSTEM=1`. On 2026-11-06, `probe-high1.sh` and `probe-s1s2.sh` added P17 to P20 in a new local scratch folder, with the same settings. `probe-p19.sh` added the Switch and skip-worktree rows of P19.
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
| P17 | `reset --hard <target>` where the index equals the target at `p` and at `d/f`. The user replaced `p` by an untracked folder `p/keep.txt`, `d/` by an untracked file `d`, or `p` by a nested repository. | Exit 0. Git deletes `p/keep.txt`, replaces the file `d` by the folder `d/`, and deletes the nested `.git` folder. `diff-index --cached -R <target>` lists none of these paths. `diff-index -R <target>` lists `A p`, `A d/f`, and `T p`. A staged change at `p` gives `M p` with `--cached` and `A p` without it. The P4b path gives `A p` in both forms. A file with new stat data and the same bytes gives `M` without `--cached`. | `probe-high1.sh` | plan D4 read 7, SC-002 |
| P18 | An ignored folder `x/` where the target writes a file `x`. It holds a nested repository: a `.git` folder at `x/` or at `x/sub/`, or a `.git` file (gitdir link) at `x/`. | `reset --hard` deletes the nested repository. The 004 Discard (`stash push`, then `checkout`) deletes it too. `ls-files -z --others --ignored --exclude-standard -- x` prints the record `x/`, or `x/plain.txt` and `x/sub/`. A plain ignored folder gives one record for each file. | `probe-s1s2.sh` | plan D4 read 7, 004 plan D3 |
| P19 | An assume-unchanged `p` (`update-index --assume-unchanged`), replaced by an untracked folder `p/keep.txt`. The same for `d/f`, with `d/` replaced by a file `d`. | `reset --hard` deletes `p/keep.txt` and replaces the file `d`. Neither `diff-index` form lists `p` or `d/f`. `ls-files -z -v` prints `h p`. A skip-worktree `p` in the same shape: Git keeps `p/keep.txt`. The 004 Discard and Stash (`stash push`, then `checkout`) lose the same bytes when another tracked change exists. A skip-worktree `p` or `d/f` keeps them in both, and in `reset --hard`. `ls-files -z -v` prints `S` for skip-worktree and `s` for skip-worktree with the assume-unchanged bit. | `probe-high1.sh`, `probe-p19.sh` | plan D4 read 7, 004 plan D3 |
| P20 | A gitlink `s` that is equal in the index and the target. The user replaced the submodule folder by an untracked file `s`. | `diff-index -R <target>` lists `T s`. `status --porcelain=v2` gives `1 .T` for `s`, so Git counts a tracked change. `reset --hard --no-recurse-submodules` replaces the file `s` by an empty folder. | `probe-s1s2.sh` | plan D4 effects |

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
- git-diff-index(1) "Raw output format": `git-diff-index <tree-ish>` "compares the <tree-ish> and the files on the filesystem". `git-diff-index --cached <tree-ish>` "compares the <tree-ish> and the index". Section "NON-CACHED MODE": "show me the differences between HEAD and the currently checked out tree - index contents _and_ files that aren't up to date".
- git-stash(1) `push`: "Save your local modifications to a new stash entry and roll them back to HEAD (in the working tree and in the index)."
- git-update-index(1) `--assume-unchanged`: "the user promises not to change the file". "To see which files have the "assume unchanged" bit set, use git ls-files -v". git-ls-files(1) `-v`: "use lowercase letters for files that are marked as assume unchanged". git-ls-files(1) `-t`: each name has "a status tag (which is followed by a space and then the filename)". The tags of index entries are `H` ("tracked file that is not either unmerged or skip-worktree"), `S` ("tracked file that is skip-worktree"), and `M` ("tracked file that is unmerged").
- git-rev-list(1) `--exclude=<glob>`: patterns for `--branches` do not start with `refs/heads`.
- git-commit(1) `--allow-empty`: Git refuses a commit with the same tree as its sole parent.
- Minimum Git: Windows 2.55.0.windows.3 (`admission.ts:9`), WSL 2.55.0 (`wsl-route.ts:12`).

## R4 Decisions

- Decision: the Hard check lists its candidates through `diff-index --cached -R` (P4b, P15). `diff-tree HEAD <target>` misses an index-removed path. Note (2026-11-06): the check reads `diff-index -R <target>` without `--cached`. The `--cached` form misses a working-tree change at a path where the index equals the target, and Git then deletes untracked bytes (P17). The non-cached form compares the target with the files on the filesystem (R3).
- Decision (2026-11-06): a nested repository in an ignored folder in the way is not replaceable. An `ls-files --others --ignored` record that ends with `/` names it, when `fileFacts` gives a file or a folder at `<record>.git` (P18). The check refuses it with `UNTRACKED_IN_WAY` and its folder path. A record that ends with `/` and has no `.git` gives `MALFORMED_GIT_OUTPUT`.
- Gap (2026-11-06): the check misses an assume-unchanged path (P19). Diff-index does not look at the working file of such an entry, but `reset --hard` does. git-update-index(1) states that the user promises not to change such a file. `ls-files -z -v` names these entries (R3). The check does not read it yet. Note (2026-11-06): data safety comes first, so the check now reads `ls-files -z -v` (plan D4 read 7). Each `h` entry is a candidate path, as an `M` record of the diff listing.
- Known limit (2026-11-06): Git's nested-repository rule covers only a `.git` file or folder. A bare repository in an ignored folder in the way gives plain ignored files.
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

Run 2026-11-05, packaged NSIS build, warm, in the foreground, alone, under the test gate and the full-run lock. No Kernel-Power 42 event occurred in any step.

- Build: commit `bba51aca`. Installed `arbareto.exe` SHA-256 `44f1270664da40ec005d5104832085f61d5194199fbde4415f18858823e0b73b`. It equals the built exe after the NSIS marker patch (`__TAURI_BUNDLE_TYPE_VAR_UNK` to `__TAURI_BUNDLE_TYPE_VAR_NSS`, 1 hit). The T017 and T018 `ORIGIN` lines name this hash.
- OS: Windows 11 Pro 10.0.26300 (build 26300). Git: 2.56.0.windows.2.
- T017 (SC-009): 5 pass, 2 skip, 0 fail. The 150% and 225% text-scale cases skip, because the OS text size is 100%. These two cases stay unverified.
- T018: 4 pass, 1 fail. All time budgets pass. SC-011 fails (see below). Superseded by the 2026-11-06 runs.

| Measure | Median (budget) | Every-run max (budget) | Cold (budget) |
|---|---|---|---|
| SC-010a menu paint, 40 opens | every open 9.5 to 23.7 ms (p95 100 ms) | 23.7 ms (500 ms) | 30.5 ms (200 ms) |
| SC-010b Reset | 254.6 ms (300 ms) | 397.4 ms (500 ms) | 274.5 ms (600 ms) |
| SC-010b Check out | 226.6 ms (300 ms) | 237.6 ms (500 ms) | - |
| SC-010b Create tag | 20 ms (300 ms) | 24.2 ms (500 ms) | - |
| SC-010b Cherry-pick | 243.3 ms (300 ms) | 381.8 ms (500 ms) | - |
| SC-010b Revert | 234.8 ms (300 ms) | 385.9 ms (500 ms) | - |
| SC-010c Hard review (M-R) | 701.5 ms (1 s) | 823.7 ms (2 s) | 775.8 ms (2 s) |
| SC-010d Soft | 632.1 ms (1 s) | 789.8 ms (2 s) | 748 ms (2 s) |
| SC-010d Mixed | 784.2 ms (2 s) | 807.5 ms (4 s) | - |
| SC-010d Create tag | 684.6 ms (1 s) | 908.3 ms (2 s) | - |
| SC-010d Hard (M-R) | 3,259.2 ms (4 s) | 3,700.1 ms (8 s) | 3,395.8 ms (8 s) |
| SC-010d Cherry-pick | 714.1 ms (2 s) | 1,108.1 ms (4 s) | - |
| SC-010d Revert | 771.5 ms (2 s) | 842.9 ms (4 s) | - |
| SC-010d Abort | 450 ms (2 s) | 660.5 ms (4 s) | - |
| SC-010d Continue | 828.5 ms (2 s) | 992.7 ms (4 s) | - |
| SC-010d Detached checkout (M-R) | 2,463 ms (4 s) | 2,893.1 ms (8 s) | - |

- Cold runs: the test measures one cold run per SC-010 measure (SC-010a, SC-010b Reset, SC-010c, SC-010d Soft and Hard). All are within 2 times the warm budget.
- Records, no budget: CPU 0.078 s to 10.2 s per run (165 runs). Process-tree private bytes 669 MB to 1,254 MB. The bytes increase across the series.
- SC-011 counts (inputs per run, 11 runs per action): Abort 15 to 31, Revert 31 to 45, Continue 34 to 55, Cherry-pick 37 to 67, Soft 38 to 54, Mixed 44 to 64, Create tag 48 to 69, Detached checkout 166 to 229, Hard 229 to 289. Input p95 is at most 40 ms and max is at most 48 ms.
- Finding for `/speckit-converge`: SC-011 fails. Superseded by the 2026-11-06 runs. Abort runs 1 to 6 got 18, 15, 19, 18, 18, and 18 inputs, below the minimum of 20. The response times pass. The Abort runs are short (median 450 ms), so the probe does not reach 20 inputs.
- Control: a scratch build let `AlertConfirm` focus the danger button first (installed SHA-256 `add5319c...1030964`, `ORIGIN` line matches). The FR-044 Cancel focus case failed (0 pass, 1 fail). `RevertConfirm.tsx` was restored byte-equal (SHA-256 `688895e6...24f33d8`). A clean rebuild and reinstall matched its own built exe after the marker patch. The worktree status was clean.
- WSL record: `tests/windows/commit-menu-perf.test.ts` has three WSL record cases on `Ubuntu-26.04`, with no budget. They are SC-010b on M, SC-010d and SC-011 on M, and SC-010d and SC-011 on M-R. They print `RECORD` lines.

- SC-011 probe (decision 2026-11-05): the probe waits 2 ms between inputs. Thus a run of about 400 ms still gets the minimum of 20 inputs. The 001 SC-005 targets do not change. The decision of 2026-11-10 replaces this decision.
- SC-011 probe (decision 2026-11-10): the probe sends one input every 10 ms on a fixed timer. It does not wait for the CDP replies of an input before the next input. The test awaits all replies after the window ends. Only keydowns on the history filter count, as before. The spec targets do not change: p95 at most 100 ms, max at most 500 ms, at least 20 inputs per run.
- Reason: the 2 ms wait did not set the rate. Each input waited for its keyDown and keyUp replies, about 14 to 16 ms per input on the M-R actions. The pre-tag `test:windows` of 2026-11-10 failed: two Abort runs had 19 and 18 inputs. Their p95 was 32 to 40 ms.
- Risk: a queued input also measures the main-thread queue time. On 2026-11-10 the input p95 rose on Cherry-pick (64 ms, max 88 ms), Revert, Abort, and Continue. It stays under the 100 ms and 500 ms limits.
- Run 2026-11-10 (packaged, alone, under the test gate): installed SHA-256 `90c2d140...20aa4d`. The test sources came from the change branch (`ORIGIN` lines). Quiet check before the run: CPU 8.3%, MsMpEng 1.5%, free memory 9.5 GB.
- T018 on M and M-R: 2 pass, 0 fail, 695 s. Abort got 36 to 56 inputs per run. The probe spacing was 10.7 to 11.2 ms for each action.
- Input p95 and max per action (ms): Soft 32 and 32, Mixed 32 and 32, Create tag 24 and 32, Hard 24 and 40, Cherry-pick 64 and 88, Revert 48 and 64, Abort 56 and 64, Continue 48 and 64, Detached checkout 24 and 48.
- Control: a 25 ms period in a local scratch copy gave 1 fail on M-R. Abort got 14 to 20 inputs per run. Only the SC-011 Abort `inputs` value was false. The test file in the change branch kept its hash.
- The WSL record cases did not run.

#### Run 2026-11-06 (final run)

Packaged NSIS build, warm, alone, under the test gate and the full-run lock. No Kernel-Power 42 event occurred in any step. Free memory before the first packaged case: 12,258 MB.

- Build: commit `22cdcac9`. Built `arbareto.exe` SHA-256 `50913356...1ff0a3`. Installed SHA-256 `e8418226...269a9e23`. The installed exe equals the built exe after the NSIS marker patch (1 hit). The T017, T018, and Top bar `ORIGIN` lines name this hash.
- OS: Windows 11 Pro 10.0.26300. Git: 2.56.0.windows.2. WSL distro: Ubuntu-26.04.
- Post-merge check: `bun install --frozen-lockfile`, typecheck, `export:schemas --check`, contracts with portable imports (614 s), and the six Git suites (876 s) all exit 0.
- T017 (SC-009): 5 pass, 2 skip, 0 fail.
- T018 Windows: 3 pass, 2 fail, 3 skip (the WSL cases). SC-010b and SC-010d on M fail on a median.
- Top bar row case (004 plan): it fails on the clean build. The header height is 44.8 px, the `--h-header` row is 44 px. Count and reason are correct.

| Measure | Median (budget) | Every-run max (budget) | Cold (budget) |
|---|---|---|---|
| SC-010a menu paint, 40 opens | p95 25.4 ms (100 ms) | 27.6 ms (500 ms) | 35.4 ms (200 ms) |
| SC-010b Reset | **388.9 ms (300 ms), missed** | 404.3 ms (500 ms) | 406 ms (600 ms) |
| SC-010b Check out | 230.2 ms (300 ms) | 368.7 ms (500 ms) | - |
| SC-010b Create tag | 20.4 ms (300 ms) | 24.8 ms (500 ms) | - |
| SC-010b Cherry-pick | 244.4 ms (300 ms) | 391.5 ms (500 ms) | - |
| SC-010b Revert | 298 ms (300 ms) | 409.1 ms (500 ms) | - |
| SC-010c Hard review (M-R) | 857.1 ms (1 s) | 1,076.1 ms (2 s) | 975.5 ms (2 s) |
| SC-010d Soft | 893.6 ms (1 s) | 1,256.1 ms (2 s) | 1,025.4 ms (2 s) |
| SC-010d Mixed | 971.7 ms (2 s) | 1,079.5 ms (4 s) | - |
| SC-010d Create tag | **1,052.6 ms (1 s), missed** | 1,245.8 ms (2 s) | - |
| SC-010d Hard (M-R) | 3,655.5 ms (4 s) | 5,722.9 ms (8 s) | 4,780.9 ms (8 s) |
| SC-010d Cherry-pick | 839 ms (2 s) | 940.8 ms (4 s) | - |
| SC-010d Revert | 738.3 ms (2 s) | 883.9 ms (4 s) | - |
| SC-010d Abort | 492.6 ms (2 s) | 661 ms (4 s) | - |
| SC-010d Continue | 904.8 ms (2 s) | 1,223 ms (4 s) | - |
| SC-010d Detached checkout (M-R) | 2,368.2 ms (4 s) | 2,877.6 ms (8 s) | - |

- Missed budgets (finding for `/speckit-converge`): SC-010b Reset median 388.9 ms against 300 ms. Its runs are bimodal: 3 runs near 255 ms, 7 runs near 390 ms. SC-010d Create tag median 1,052.6 ms against 1 s. The previous run had 254.6 ms and 684.6 ms.
- SC-011 (inputs per run, 11 runs per action, 12 with the cold run): Abort 20 to 39, Revert 35 to 51, Cherry-pick 39 to 60, Continue 49 to 82, Soft 63 to 125, Mixed 73 to 100, Create tag 81 to 114, Detached checkout 199 to 289, Hard 324 to 633. No run is below 20. Input p95 is at most 40 ms, max is at most 88 ms (Cherry-pick). SC-011 passes.
- SC-011 first-input offsets: Continue 8 to 30.3 ms, Create tag 9.1 to 25.6 ms, Mixed 19.1 to 25 ms, Soft 17.5 to 27.6 ms, Detached checkout 20 to 27.1 ms, Hard 26 to 31.9 ms, Cherry-pick 45.9 to 54.7 ms, Revert 50.6 to 58.4 ms, Abort 58.9 to 64.4 ms.
- Process-tree private bytes, start to end per series: SC-010b 668 to 697 MB. SC-010c 770 to 763 MB. SC-010d M 805 to 1,009 MB. SC-010d M-R 930 to 1,201 MB (max 1,274 MB, Detached checkout). The bytes increase across the session, and each series starts a new app.
- JS heap used, run 0 to the last run per action: SC-010b Reset 26.6 to 19 MB, Revert 19.7 to 19.8 MB, Cherry-pick 14.3 to 29.9 MB (SC-010b max 31.3 MB). SC-010c 29 to 29.6 MB (max 38.4 MB). SC-010d Soft 18.4 to 22.3 MB, Hard 19.9 to 25.8 MB, Continue 49.6 to 51.1 MB, Detached checkout 25.5 to 34.2 MB (SC-010d max 66.3 MB). No action grows without bound.

WSL record (Ubuntu-26.04, no budget, 10 + 1 runs per action). All three `RECORD` lines are complete.

| Measure | Median | Every-run max | Cold |
|---|---|---|---|
| SC-010b WSL Reset | 1,789.5 ms | 1,856.3 ms | 2,352 ms |
| SC-010b WSL Check out | 1,586 ms | 1,717.9 ms | - |
| SC-010b WSL Create tag | 30.8 ms | 36.7 ms | - |
| SC-010b WSL Cherry-pick | 1,707.2 ms | 1,917.5 ms | - |
| SC-010b WSL Revert | 1,755 ms | 1,986.4 ms | - |
| SC-010d WSL Soft | 4,254.2 ms | 6,948.8 ms | 3,702.6 ms |
| SC-010d WSL Mixed | 4,116.5 ms | 4,393.5 ms | - |
| SC-010d WSL Create tag | 5,528.2 ms | 7,227.9 ms | - |
| SC-010d WSL Hard (M-R) | 10,634.8 ms | 20,270.9 ms | 13,485.9 ms |
| SC-010d WSL Cherry-pick | 3,895.3 ms | 4,925.6 ms | - |
| SC-010d WSL Revert | 3,871 ms | 4,259.5 ms | - |
| SC-010d WSL Abort | 2,835.7 ms | 3,100.3 ms | - |
| SC-010d WSL Continue | 5,404.1 ms | 5,643.5 ms | - |
| SC-010d WSL Detached checkout | 4,873.4 ms | 7,100.7 ms | - |

- WSL SC-011: 113 to 1,378 inputs per run, p95 at most 40 ms, max at most 72 ms. WSL private bytes 675 to 1,080 MB. WSL heap at most 48.3 MB.

Controls:

- Control a (one scratch build): `AlertConfirm` focused the danger button first, and the header showed the detached count span. Installed SHA-256 `90f8ac95...68b94c63e`. The FR-044 Cancel focus case failed (the focus stayed on "Reset hard"). The Top bar row case failed with `count: true`. Both source files were restored byte-equal (`RevertConfirm.tsx` `688895e6...24f33d8`, `Workbench.tsx` `bb505608...bd306d0`). A clean rebuild and reinstall matched its built exe after the marker patch. The FR-044 rerun passed with `ORIGIN` SHA-256 `85f7036c...8c8161b1`. This hash differs from the first clean build, so two builds of one commit do not give equal bytes.
- Control a limit: the Top bar row case also fails on the clean build (height only), so its control shows only the extra `count` difference.
- Control b (WSL identity, test edit, no rebuild): without the local `user.email` write and its check, the WSL M-R record case did not stop. Cherry-pick run 0 completed, and the case passed. The control did not turn red. The identity source of the app's distro Git in this case is unverified. `commit-menu-perf.test.ts` was restored byte-equal (`6cc9dab9...f5f92ab`).

#### Targeted rerun (2026-11-06)

Packaged build of `5d27b52f` plus one test commit with four test fixes: the Top bar line count, the SC-011 probe without polling, per-run IPC timing, and the WSL identity check in the distro environment. The app code equals `22cdcac9`. Installed SHA-256 prefix `0A677CAE`. The targeted run passed.

- Top bar row case: the header has one line (client height 44 px, row height 44 px). Control: at a window width of 900 px, the header has 2 lines.
- SC-010b medians on M (budget 300 ms median, 500 ms every run): Reset 256 ms (max 397 ms, cold 411 ms), Check out 230 ms, Create tag 21 ms, Cherry-pick 240 ms, Revert 245 ms.
- SC-010d on M: Soft 705 ms (max 775 ms, cold 923 ms), Mixed 813 ms (max 877 ms), Create tag 747 ms (max 891 ms).
- SC-011: 48 to 83 inputs per run. Input p95 is at most 32 ms.
- IPC split: each slow run is about 130 to 150 ms slower than the fast group. The extra time is inside one `review_workbench` or `run_workbench` call. Thus the variance is in Git process time, not in the page.
- WSL record medians: Soft 3,617 ms, Mixed 4,009 ms, Create tag 5,148 ms.
- WSL identity control: without the local `user.name`, the new check fails with exit 128 before the series. With it, the series passes.
- Result: every budget passes. SC-010a, SC-010c, and SC-010d on M-R passed on `22cdcac9`. SC-010b and SC-010d on M pass on this rerun with the same app code.
- Text size (user decision 2026-11-06): the skip of the SC-009 150% and 225% cases is accepted for v0.1.0. The cases run after v0.1.0 (tasks.md T024).

### Requirement-to-test map (T022)

Review 2026-11-06 by the reviewer on `9c8dfe0e`. The map below adds the later fixes and tests up to `22cdcac9`. Test files are in `tests/git/`, `tests/contracts/`, `tests/wsl/`, and `tests/windows/`.

| ID | Test file and case | Coverage |
|---|---|---|
| FR-001 | All refusal cases assert code and reason (`tests/git/*`); the T022 SC-012 review | yes |
| FR-002 | `commit-actions-contract.test.ts` "WORKBENCH_ACTIONS and WORKBENCH_STARTED_ACTIONS gain the four actions", "no new operation name, and MUTATIONS keeps runWorkbench"; `commit-menu.test.tsx` "a running mutation blocks all but Copy…"; `src-tauri/src/schema.rs` and `close.rs` cargo tests | yes |
| FR-003 | `reset.test.ts` "FR-003: a new untracked file in the way after the Hard review gives STALE_REVIEW…"; `create-tag.test.ts` "FR-003 and FR-007: an external tag write…"; `cherry-pick-revert.test.ts` "FR-003 and FR-007: an external commit…"; `sync-conflicts.test.ts` "010 FR-003 and FR-007…"; `commit-actions.test.tsx` "an expired ${action} review states that nothing changed" | yes |
| FR-004 | `reset.test.ts`, `create-tag.test.ts`, `cherry-pick-revert.test.ts` "SC-007 and FR-004…"; `sync-conflicts.test.ts` "010 SC-007 and FR-004…"; `sync-conflicts.test.tsx` "${k.state}: Abort and Continue ask trust with the ${k.trust} action"; `dialogs.rs` cargo tests | yes |
| FR-005 | `keepConfigs` in every `withSync` of `reset.test.ts`, `create-tag.test.ts`, `cherry-pick-revert.test.ts`; `workbench-commands.test.ts` "cherry-pick and revert pass no --, no hook bypass…", "a tag step passes no -a, no -f, and no --no-sign…"; `create-tag.test.ts` "FR-032 and P8…" (2 cases); `cherry-pick-revert.test.ts` "SC-003 and FR-053: an empty pick (P6) and a signing failure (P11)…" | yes |
| FR-006 | `cherry-pick-revert.test.ts` "SC-003 and FR-053: an empty pick (P6) and a signing failure (P11)… with the output tail…"; `commit-actions.test.tsx` "a stop without conflicts states it and shows the output tail as plain text" | yes |
| FR-007 | `reset.test.ts` "FR-007: Cancel before the step…; a step killed while index.lock exists…"; `create-tag.test.ts` and `cherry-pick-revert.test.ts` "FR-003 and FR-007…"; `sync-conflicts.test.ts` "010 FR-003 and FR-007…" | yes |
| FR-008 | `workbench-commands.test.ts` "every array starts with --no-lazy-fetch…"; UNKNOWN_TARGET: `reset.test.ts` "FR-041 and data-model §6…", `create-tag.test.ts` "plan.md D3: the open review…", `cherry-pick-revert.test.ts` "FR-051…" | yes |
| FR-010 | `commit-menu.test.tsx` "a right-click on a commit row selects the row, docks its details…", "a right-click on a branch chip keeps the 004 branch menu", "${name} with no active label opens the commit menu…", "Right makes the first label active…"; `commit-actions.test.tsx` Escape and Hard dialog focus cases; `commit-menu-packaged.test.ts` "FR-010, FR-014, U2: Shift+F10 and a right-click…" | yes |
| FR-011 | `commit-menu.test.tsx` "a right-click on a commit row selects the row…", "a detached HEAD blocks Cherry-pick, Revert, and Reset, and the Reset label drops the branch name" | yes |
| FR-012 | `commit-menu.test.tsx` availability cases (clean branch, running mutation, operation states, detached, unborn, HEAD at this commit); service rechecks `reset.test.ts` "FR-041…", `cherry-pick-revert.test.ts` "FR-051…" | yes |
| FR-013 | `commit-menu.test.tsx` "the Working directory and Index rows open no menu", "the More commits row and a Loading row open no menu (plan D1)" | yes |
| FR-014 | `commit-menu.test.tsx` "every item has an icon and an accessible name", "an unavailable item stays focusable and runs nothing"; `commit-actions.test.tsx` preselection and first-focus cases; `commit-menu-packaged.test.ts` "FR-010, FR-014, U2…", "SC-009: in Dark, Light, and forced colors…", "SC-009 at text size ${size}%…" (the 150% and 225% cases skip, because the OS text size is 100%) | partial |
| FR-015 | `commit-menu.test.tsx` "Right makes the first label active and Shift+F10 then opens its branch menu; Left on the first label goes back…"; `workbench-branches.test.tsx` "Right and Left move the active label…", "a new selected row starts with no active label" | yes |
| FR-020 | `switch.test.ts` "010 FR-020 and SC-005…", "010 FR-020: from a detached commit that no ref holds…"; `commit-actions.test.tsx` checkout confirmation cases; `commit-menu-packaged.test.ts` "FR-020: the Check out confirmation gives Cancel the first focus…"; `commit-actions-wsl.test.ts` "T016 FR-020…" | yes |
| FR-021 | `commit-menu.test.tsx` "Create branch here shows Ctrl+B, and it opens the 004 Create branch popover at the commit"; `commit-actions.test.tsx` "Escape on the Create branch popover of the commit menu returns the focus to the list" | yes |
| FR-022 | `commit-menu.test.tsx` "Copy commit ID copies the full object ID and is always available" | yes |
| FR-030 | `commit-actions.test.tsx` tag kind cases; `create-tag.test.ts` "plan.md D3: the open review with name null…" | yes |
| FR-031 | `create-tag.test.ts` "FR-031 and P9…", "FR-031 and FR-032: an existing name gives name-exists…", "contract §5: a check-ref-format exit code null gives GIT_FAILED…"; `tag-name.test.ts` (8 cases); `commit-actions.test.tsx` "the refusal ${reason} shows in the popover after Create tag" | yes |
| FR-032 | `create-tag.test.ts` "FR-032 and P8" (2 cases), "FR-031 and FR-032… invalid-config…"; `commit-actions.test.tsx` signing line cases | yes |
| FR-033 | `commit-actions-contract.test.ts` tag message rules and invalid vectors; `create-tag.test.ts` "FR-031 and FR-032: … a message …" | yes |
| FR-034 | `commit-actions.test.tsx` "Create tag reviews again… and states the outcome"; `workbench-commands.test.ts` tag argv (no tag push) | yes |
| FR-040 | `commit-actions.test.tsx` "Mixed is preselected and focused…", "a mode change reviews again…"; `commit-actions-contract.test.ts` "reset takes the target and one of soft, mixed, or hard" | yes |
| FR-041 | `reset.test.ts` "FR-041 and data-model §6…"; `commit-menu.test.tsx` detached and unborn cases | yes |
| FR-042 | `reset.test.ts` "SC-001: each mode two commits back…", "SC-001 and FR-042…"; `commit-actions.test.tsx` "the counts and notes of the plan, in plural and singular forms" | yes |
| FR-043 | `reset.test.ts` "FR-043 and SC-002: Hard with an untracked file at a target path…", "FR-043: 101 untracked files…", "FR-043 and P4c…"; P17: `reset.test.ts` "FR-043 and SC-002: where the index equals the target, Hard with an untracked folder in place of a file…", "FR-043: Hard at the tip with more than DISCARD_CHECK_PATHS changed tracked files refuses with limit…", `switch.test.ts` "FR-011 and SC-002: Stash and Discard with an untracked folder in place of a tracked file…"; P18: `reset.test.ts` "FR-043 and FR-044: an ignored folder in the way that holds a nested repository refuses Hard…", `switch.test.ts` "FR-011 and 010 research.md R2 P18: Discard and Stash with an ignored folder in the way that holds a nested repository…"; P19: `reset.test.ts` "FR-043 and SC-002: an assume-unchanged entry with an untracked folder in place of its file…", `switch.test.ts` "FR-011 and SC-002: Stash and Discard with an assume-unchanged entry…"; `commit-actions.test.tsx` in-the-way list; `commit-actions-wsl.test.ts` "T016 FR-043…" | yes |
| FR-044 | `commit-actions.test.tsx` Hard dialog cases; `reset.test.ts` "FR-044 and P4c: an ignored folder…"; `commit-menu-packaged.test.ts` "FR-044: the Hard dialog gives Cancel the first focus (UIA HasKeyboardFocus)…" | yes |
| FR-045 | `workbench-commands.test.ts` "commit menu argv" rows reset soft, mixed, hard | yes |
| FR-046 | `reset.test.ts` SC-001 cases and "FR-007: … index.lock … failed-with-effects" | yes |
| FR-050 | `cherry-pick-revert.test.ts` "SC-003 and FR-050: a merge commit with -m 1 and -m 2…"; `commit-actions.test.tsx` parent choice cases | yes |
| FR-051 | `cherry-pick-revert.test.ts` "FR-051: …", "SC-010b: with parallel reads, CONFLICTED comes before…"; `commit-actions.test.tsx` "${action}: the refusal ${reason} shows its text" | yes |
| FR-052 | `workbench-commands.test.ts` pick argv; `commit-actions.test.tsx` "a plain commit: the popover names the branch, Git's message and author, and Amend last commit…" | yes |
| FR-053 | `cherry-pick-revert.test.ts` "SC-003 and FR-053…" (3 cases), "SC-007 and FR-004: … post-commit hook…"; `commit-actions.test.tsx` stop cases | yes |
| FR-060 | `sync-conflicts.test.tsx` conflict row cases in the pick states | yes |
| FR-061 | `sync-conflicts.test.ts` "010 SC-006 and FR-061: Abort…", "010 SC-006, FR-062, and FR-063: … Continue…"; `sync-conflicts.test.tsx` Abort confirmation cases | yes |
| FR-062 | `sync-conflicts.test.ts` Continue refusals, nothing-to-commit, sequence; `sync-conflicts.test.tsx` refusal text cases; `commit-actions-wsl.test.ts` "T016 plan.md D6: with a .git/sequencer folder…" | yes |
| FR-063 | `sync-conflicts.test.ts` "010 SC-006, FR-062, and FR-063…", "010 FR-063: Choose ours and Choose theirs of a stopped cherry-pick and revert run checkout --<side>…"; `sync-conflicts.test.tsx` "${k.state}: Mark resolved stays available…", "the resolve tools of a conflicted file (FR-063)" (a merge case and one case per pick state) | yes |
| FR-070 | `commit-actions-wsl.test.ts` (all 7 T016 cases) | yes |
| FR-080 | `commit-menu-perf.test.ts` "SC-010d, SC-011 on M…", "SC-010d, SC-011 on M-R…"; SC-011 passes on build `22cdcac9` (R7 "Run 2026-11-06") | yes |
| SC-001 | `reset.test.ts` SC-001 cases | yes |
| SC-002 | `reset.test.ts` "FR-043 and SC-002…" (3 cases), "FR-043: 101 untracked files…"; `switch.test.ts` "FR-011 and SC-002…" P17 and P19 cases; `commit-actions-wsl.test.ts` "T016 FR-043…" | yes |
| SC-003 | `cherry-pick-revert.test.ts` SC-003 cases; `commit-actions-wsl.test.ts` "T016 SC-003…" | yes |
| SC-004 | `create-tag.test.ts` SC-004 and FR-031/032 cases; `commit-actions-wsl.test.ts` "T016 SC-004…" | yes |
| SC-005 | `switch.test.ts` "010 FR-020 and SC-005…" | yes |
| SC-006 | `sync-conflicts.test.ts` SC-006 cases; `commit-actions-wsl.test.ts` "T016 SC-006…" | yes |
| SC-007 | "SC-007 and FR-004…" cases in reset, create-tag, cherry-pick-revert, switch, sync-conflicts | yes |
| SC-008 | `commit-actions-wsl.test.ts` "T016 SC-008…" and the mode, owner and link-count checks | yes |
| SC-009 | `commit-menu-packaged.test.ts` cases (the 150% and 225% cases skip) | partial |
| SC-010a | `commit-menu-perf.test.ts` "SC-010a, U3: on L…" | yes |
| SC-010b | `commit-menu-perf.test.ts` "SC-010b, U3: on M…" | yes |
| SC-010c | `commit-menu-perf.test.ts` "SC-010c: on M-R the Hard review…" | yes |
| SC-010d | `commit-menu-perf.test.ts` SC-010d cases on M and M-R | yes |
| SC-011 | `commit-menu-perf.test.ts` SC-010d cases; passes on build `22cdcac9` (R7 "Run 2026-11-06") | yes |
| SC-012 | The T022 review (manual). Its findings below name no outcome that message text, timing, a retry count, or a name pattern decides. | yes |

- Coverage marks: the map gives test coverage. The pass or fail result of a budget is in R7 "Packaged and perf runs (T019)". SC-010b Reset and SC-010d Create tag missed a median on `22cdcac9` and pass on the targeted rerun.
- Control: the reviewer removed FR-022 from the draft map. The coverage pass then reported "missing in draft: FR-022".

Review findings and outcomes:

- HIGH-1: Hard reset lost untracked data where the index equals the target (P17). Fixed by `c732eb32`.
- S1: Switch with Stash or Discard lost untracked data in the way (P17). Fixed by `c732eb32`.
- S2: a nested repository in the way was lost (P17, P18). Fixed by `c732eb32`.
- P19: Hard reset, Stash, and Discard lost untracked data at an assume-unchanged entry. Fixed by `be61a01d`.
- LOW-1, LOW-2, and LOW-3: handled.

Known items for after v0.1.0:

- Check out with the default switch choice Stash takes about 340 to 380 ms, because the review reads once more. Fix: run the Switch observe reads in parallel.
- The resolve view shows no "theirs" name during a cherry-pick or a revert.
- A bare repository in an ignored folder counts as ignored files.
- With `core.ignoreStat=true`, the Hard review can refuse with `limit`.
