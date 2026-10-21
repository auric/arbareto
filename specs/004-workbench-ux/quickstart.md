# Quickstart: Validate Workbench UX

**Feature**: `specs/004-workbench-ux` | **Plan**: [plan.md](plan.md) | **Contract**: [contracts/operations.md](contracts/operations.md) | **Data model**: [data-model.md](data-model.md)

This guide lists the validation scenarios. It holds no implementation code. The work packages in plan.md create the named test files.

## Prerequisites

- Windows 11 x64 with the 001 qualification prerequisites.
- Git for Windows 2.56 for the P0 facts. The 001 minimum Git 2.55.0 stays in force.
- Feature 003 merged up to its batch 3 for the P1 service scenarios, and up to its WP11 for the frontend scenarios (plan "Dependencies on feature 003").
- WSL `Ubuntu-26.04` with Git 2.55 for the WSL scenarios. Set `ARBARETO_WSL_DISTRO`.
- A fixture merge tool: a small program that the P0.1 builder writes into the owned global configuration as `mergetool.fixture.cmd`. It writes a fixed result into `$MERGED` and exits 0.
- For app runs: set `ARBARETO_PROFILE_ROOT` to a scratch folder.
- Every test uses an owned `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM=1` where the scenario does not test the system scope. No test touches the user's own configuration.

## Commands

Use only the README "Development" commands:

- `bun install --frozen-lockfile`
- `bun run build`
- `bun run typecheck`
- `bun run export:schemas --check`
- `bun run test:contracts`
- `bun run test:git`
- `bun run test:windows` (after `bun run build:service`)
- `bun run test:all` (alone, never in parallel with another full run)
- `cargo check --locked --manifest-path src-tauri/Cargo.toml`
- `cargo test --locked --manifest-path src-tauri/Cargo.toml`
- `bun run dev`

## Scenarios

| # | Scenario | Test home | Expected outcome | Spec |
|---|---|---|---|---|
| Q1 | Build the 004 fixtures. | `tests/git/workbench-fixtures.ts` | Self-check: refs, counts, the worktree list, configuration digests. | SC-001 to SC-009 |
| Q2 | Record the Git facts F1 to F24 and F29 to F31. | `tests/git/workbench-facts.test.ts` | Each fact passes, or research.md R21 records the failure and the contract changes before P2. | FR-002, FR-004 |
| Q3 | Record the staging facts F25 to F28. | `tests/git/staging-facts.test.ts` | Each sub-hunk equals the expected blob. The batch proof A form is recorded. 10,000 paths equal `git add`. A cut read keeps every tracked record. | SC-006, SC-007 |
| Q4 | Record the native facts N1 to N6 (packaged). | `tests/windows/native-facts.test.ts` | The dialog parts and its default; UIA `ShowContextMenu` opens the app menu (right-click and Shift+F10 wait for T082); the tool inside the Job; Cancel ends it; Explorer selects the path; the tool window foreground. A skip stays unverified. | FR-070, FR-095 |
| Q5 | Switch between local branches, clean and dirty, with each choice. | `tests/git/switch.test.ts` | HEAD, the index, every working byte, and the stash list equal Git's own commands on a copy. | SC-001, SC-002, FR-009 to FR-012 |
| Q6 | Keep changes with a conflicting change; Discard with an untracked file in the way. | `tests/git/switch.test.ts` | Nothing changes. Discard refuses before Git starts and names the file. Untracked files keep their bytes. | SC-002, FR-011, Edge Cases |
| Q7 | Stash and reapply with a reapply conflict, and with a failed checkout. | `tests/git/switch.test.ts` | The stash stays, and the result names its commit ID. The conflicted paths show in the Conflicted list. A failed checkout reapplies nothing. | FR-012, Edge Cases |
| Q8 | Switch to a remote branch with one, zero, and two mapping refspecs; to a branch of another worktree; away from an unreachable detached commit. | `tests/git/switch.test.ts` | The name field, the tracking keys, the Open offer, and the reflog statement match the facts. | FR-013 |
| Q9 | Create, rename, and delete branches: merged, unmerged, current, other worktree, moved after review. | `tests/git/branch-ops.test.ts` | Refs, reflogs, and configuration equal Git's own commands. The warning shows exactly when the count is above zero. A moved branch is never deleted. | SC-004, FR-015 to FR-019 |
| Q10 | Merge with each option and each allowed combination, fast-forward and diverged, a hook that rejects. | `tests/git/merge-rebase.test.ts` | HEAD, refs, the index, working files, and markers equal Git's own merge. The counts equal Git's counts. The preview equals Git's message (F12). | SC-005, FR-021 to FR-023 |
| Q11 | Rebase with Autostash and Autosquash, patch-same commits, `rebase.updateRefs`, and a push tracking ref that holds rewritten commits. | `tests/git/merge-rebase.test.ts` | The result equals Git's own rebase. The moved, held, and branch lists equal Git's facts. The force note shows only for the push tracking ref. | SC-005, FR-024 to FR-027 |
| Q12 | Stop a merge and a rebase with conflicts; finish with the 003 Abort, Continue, Skip, and Mark resolved. | `tests/git/merge-rebase.test.ts` | The 003 notice shows, and each action equals Git's own command. | FR-023, FR-027 |
| Q13 | Choose ours, Choose theirs, and Open in merge tool for UU, AU, UA, DU, UD, DD, and a symlink stage, during a merge and a rebase. | `tests/git/resolve.test.ts` | Working files and the index equal `git checkout --ours`, `--theirs`, and `git mergetool` with the fixture tool on a copy. Unavailable items state their reason. No conflict marker is read. | SC-015, FR-089 to FR-096 |
| Q14 | Open in merge tool with a repository-scope tool in an untrusted repository. | `tests/git/resolve.test.ts` | The trust dialog request comes before any Git process. The canary does not run. | SC-015, FR-097 |
| Q15 | Stage selected files, a folder, all untracked, all changes; unstage all; with one refused file; with an external change before publication. | `tests/git/multi-stage.test.ts` | The index equals the expected index. Every working byte stays. A refused file refuses the whole action and names it. A changed entry set gives `STALE_SELECTION`. | SC-006, FR-034 to FR-040 |
| Q16 | Stage and unstage selected lines of added, removed, and mixed hunks; refused selections. | `tests/git/line-stage.test.ts` | The index entry equals the expected blob. The working file stays. Each refusal gives its reason. | SC-006, FR-041 to FR-044 |
| Q17 | Add to .gitignore and to info/exclude: a file, a folder, a path with glob characters and trailing spaces, an existing line, a link, a file without a final LF. | `tests/git/ignore.test.ts` | The exact line, the LF rule, the refusals, and the status read after it. `git check-ignore` matches the path. | FR-045, FR-046 |
| Q18 | Open the commit view with 100,000 untracked files, scroll, expand Untracked, stage one file. | `tests/windows/workbench-perf.test.ts` | 95% of inputs within 100 ms, every input within 500 ms, cold and warm. CPU and process-tree memory recorded. | SC-007, FR-088 |
| Q19 | Read a status cut inside the untracked records (lowered bound). | `tests/git/multi-stage.test.ts` | `cut: "untracked"`, complete tracked and staged lists, the "At least" text, Commit available. | FR-030, FR-048 |
| Q20 | Add, open, remove, and prune worktrees: new branch, existing branch, dirty, locked, prunable, main. | `tests/git/worktrees.test.ts` | The worktree list and refs equal Git's own commands. No worktree with changes is removed without the check box. | SC-008, FR-049 to FR-057 |
| Q21 | Save each FR-060 key in Local and Global; Cancel; a multi-valued key; an include; an XDG global file. | `tests/git/git-settings.test.ts` | Only the saved keys change, in only that file. Every other byte of every configuration file stays. | SC-009, FR-058 to FR-068 |
| Q22 | A full session in a repository without repository programs; a first commit with a pre-commit hook; Not now; Stop trusting; a hook rewrite after approval; a version 1 record. | `tests/git/trust-v2.test.ts` | Zero prompts, then exactly one. No canary before approval. No new prompt after a hook rewrite. A version 1 record asks once. | SC-010, FR-069 to FR-075 |
| Q23 | Update submodules with one click; a refusal; a host line; programs; one row; Retry; Cancel. | `tests/git/submodule-scope.test.ts` | No dialog without a safety fact. Results equal 001. Each FR-049 refusal still refuses. The host line waits for Update anyway. A scoped run touches only its rows. | SC-011, FR-076 to FR-082 |
| Q24 | Keyboard-only runs of US1 to US4; each key of the plan D15 map; focus after each outcome. | `tests/contracts/shortcuts-004.test.ts`, `tests/windows/workbench-packaged.test.ts` | Each P1 story completes by keyboard. No key acts outside its scope. Contrast at least 4.5:1. | SC-003, SC-014, FR-085, FR-087 |
| Q25 | Moved to a later feature (spec Clarifications, 2026-10-19). Spell check of the fixture message, offline. | `tests/contracts/workbench-spelling.test.tsx`, the 003 no-network harness | Every listed misspelling is marked, no listed correct word is marked, and no network request starts. | SC-012 |
| Q26 | The WSL rows of Q5 to Q23 in Ubuntu-26.04, without Q17 and without the Global saves of Q21. These move to a later feature (spec Clarifications, 2026-10-19). | `tests/wsl/workbench-wsl.test.ts` | Same results through the distro's Git. No remaining process after Cancel or close. | FR-006 |
| Q27 | Review of the requirement-to-test map. | review checklist | No outcome depends on Git message text, timing, or a name pattern. | SC-013 |
| Q28 | Amend with and without staged changes; HEAD on its upstream, not on it, and no upstream; an upstream ref that the repository does not hold; HEAD moved after the review. | `tests/git/commit-amend.test.ts`, `tests/contracts/workbench-amend.test.tsx` | Tree, parents, message, and refs equal `git commit --amend` on a copy. The confirmation shows exactly when `merge-base --is-ancestor` exits 0 or the review gives `rewritesUpstream` `unknown`. A moved HEAD refuses. | SC-016, FR-098 to FR-100 |
| Q29 | Filter files in the Commit view: Ctrl+F, the text "login", then Stage all changes. | `tests/contracts/workbench-commit.test.tsx`, `tests/contracts/shortcuts-004.test.ts` | Ctrl+F focuses Filter files. The lists show only the rows whose path holds "login". Stage all changes stages every change, also the hidden ones. Counts keep the values of the status read. | FR-101 |

## Manual checks in the packaged build

- The trust dialog: "Do you trust this repository?", Not now as default, Show details lists the folder, the hooks, and the filters by name.
- The branch button, the branch list search, and the switch confirmation next to a sidebar row, with Cancel focused first.
- The context menus on branch rows, history labels, Untracked folders, and submodule rows, by right-click and Shift+F10.
- The merge and rebase panels in the dock, Ctrl+Enter, and Escape.
- The commit view: the stage button on hover and focus, the hunk buttons, the line selection bar on the left, the 72-column guide, and the counter.
- The worktree button and the Settings view with its scope bar and Close.
