# Implementation Plan: Workbench UX

**Branch**: `f004-spec` (feature `004-workbench-ux`) | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/004-workbench-ux/spec.md`

**Related**: [research.md](research.md) | [data-model.md](data-model.md) | [contracts/operations.md](contracts/operations.md) | [quickstart.md](quickstart.md)

## Summary

Each new action runs Git's own command with literal arguments. A read-only review fixes the facts and issues a one-use token, and one mutation runs the reviewed action. The pattern copies feature 003 `reviewSync` and `sync`. Outcomes come from Git exit codes that Git documents, and from fresh reads. These reads cover HEAD, refs, the index, the worktree list, the stash reflog, and the operation markers. No Git message text decides anything.

Six facts drive the design (research R2 to R15):
- `git branch -D` resolves the branch and then deletes it without an expected old value (builtin/branch.c `delete_branches`). So Delete runs `update-ref -d <ref> <oid>`, which Git refuses when the branch moved. The app then removes the `branch.<name>` section, as `delete_branches` does.
- `git checkout --force` throws away untracked files that are in the way (git-checkout(1) `--force`). So Discard and switch never passes `--force`. It stashes the tracked changes and runs a plain checkout. Git refuses that checkout for untracked files in the way. The app then drops or reapplies the stash.
- `status --porcelain=v2` prints changed entries, then unmerged entries, then untracked entries (wt-status.c `wt_porcelain_v2_print`). So a status read that the 001 bound cuts inside the untracked records still holds every tracked entry. The commit workspace states an honest "at least" untracked count and keeps tracked work available.
- Line staging reuses the 001 hunk pipeline. The service builds a sub-hunk from the retained hunk, applies it with `apply --cached` to the owned candidate, and verifies the exact entry. It needs no `--unidiff-zero`, because the sub-hunk keeps its context lines.
- A merge driver (`merge.<driver>.driver`) is a configured program that merge, rebase, and stash apply run. Feature 001 trust discovery does not list it. The new trust class `workbench` covers it.
- With the trust redesign, an approval binds to folders, the Git selection, and a policy version. Discovery stays, but the per-file program digests go away. So an approval no longer breaks when Git LFS or another tool rewrites a hook.

## Technical Context

**Language/Version**: The 001 to 003 versions stay: TypeScript `7.0.2`, Bun `1.4.3` (exact), Rust/Cargo `1.98.0`.

**Primary Dependencies**: No new runtime dependency for P1 and P2. React `19.3.0`, `@base-ui/react` `^1.8.0`, `@tanstack/react-virtual` `^3.14.13`, `@pierre/diffs` `^1.5.1` (its `enableLineSelection` and `controlledSelection` options), and Tauri `2.12.0` as installed. P3 spell check adds `nspell` and `dictionary-en` after the D17 license and bundle check.

**Storage**: Shell settings gain the preselected switch choice (D3). The trust record changes to version 2 (D12). Repository writes happen only at explicit user actions: Git's own writes during an operation, the Git settings Save (D11), and the ignore line (D9).

**Testing**: Bun tests in real disposable repositories (`tests/git`), compared with Git's own commands on copies. Contract tests and golden vectors (`tests/contracts`, `tests/vectors`). Windows packaged tests (`tests/windows`). WSL tests (`tests/wsl`). Cargo tests for the policies, contexts, the allowlist, the task dialog model, and the file append request.

**Target Platform**: Windows 11 x64 with Git for Windows (2.56.0.windows.2 on the reference PC). WSL2 repositories run the distro's Git. The Git floor stays 2.55.0. It covers `config set` and `config unset` (Git 2.46), `worktree list -z` (Git 2.36), and non-interactive `--autosquash` (Git 2.44).

**Project Type**: Local-first desktop application: Tauri 2 shell, compiled Bun Git service, React renderer.

**Performance Goals**: The 001 SC-005 targets during every operation (spec FR-088): 95% of inputs show a response within 100 ms, and every input within 500 ms. SC-007 measures them with 100,000 untracked files. SC-003: at most three inputs for a switch.

**Constraints**: Hooks always run. No `--no-verify`, no `--force` checkout, no reset, no interactive rebase. Git configuration files stay byte-identical, except Git's own branch-section writes and an explicit Save (O-3). Every Git process has a Job, a deadline, and Cancel. The renderer sends IDs, names that pass the D4 name rule, line ordinals, and validated text only.

**Scale/Scope**: Fixtures with 100,000 untracked files, 1,000 branches, 50 worktrees, and 5 nested submodules. A multi-file action covers at most 10,000 files and 512 MiB of working bytes (D8). The status read keeps the 001 bound of 100,000 records and 32 MiB.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Checked against `.specify/memory/constitution.md` version 3.0.0, before research and again after Phase 1.

| Principle | How the design meets it | Status |
|---|---|---|
| I. Preserve user data | Git stays authoritative, and fresh reads decide every outcome. Discard never passes `--force`, so Git itself refuses untracked files in the way (D3). A stash that holds user changes stays until a reapply without conflicts, and the result names its commit ID. Delete binds to the shown commit (D4). Worktree remove passes `--force` only after the explicit check box (D10). An amend of a commit that the upstream holds asks a destructive confirmation first (D8). Rebase is a history rewrite, and the panel names the moved commits before the Rebase button (D6). The delete confirmation states the reflog limit from a fact (D4). Configuration changes only at Save (D11). No hook bypass. | Pass, note N-1 |
| II. TypeScript/Bun | All Git logic is in TypeScript. Rust adds platform work only: the task dialog fields, the file append, Explorer reveal, contexts, and policy data (D14). | Pass |
| III. Validated boundaries | Typed operations with zod and the strict decoder. Branch names pass Git's own check and the D4 rule. Every name and path passes after `--` or `--end-of-options`. Every output has a bound. Each operation has its own Job. The renderer sends line ordinals, never patch text (contract Δ4). | Pass |
| IV. Real Git verification | Every action is compared with Git's own command on a copy: refs, HEAD, the index, working bytes, the stash reflog, configuration bytes, and operation state. Tests cover failure, Cancel, external changes, stale tokens, and each safeguard. | Pass |
| V. Untrusted repositories | Trust classes `workbench` and `mergetool` cover every hook, filter, merge driver, monitor, signing program, and merge tool that the new commands can run (D12). The prompt stays and asks before any repository program runs. Displayed values stay plain text. | Pass, note N-2 |
| VI. Platform evidence | Packaged Windows evidence for the task dialog, context menus, the merge tool Job, Explorer reveal, and SC-007. WSL stays unverified until the distro runs. | Pass |
| VII. Accessible and measured | The keyboard map is checked against 001 to 003 (D15). Every control has a name, focus, and a stated reason when unavailable. Destructive actions use the danger style and stay apart. SC-007 uses the 001 budgets, fixed before measurement. Qualification records CPU and process-tree memory. | Pass, note N-3 |
| VIII. Locked dependencies | No dependency for P1 and P2. P3 adds two packages with caret ranges and the lockfile (D17). | Pass |
| IX. One planning process | All artifacts stay in `specs/004-workbench-ux`. The contract lists only deltas to 001, 002, and 003. | Pass |

Notes from the second check:
- **N-1 (I, "Destructive actions and history rewrites MUST require explicit confirmation")**: Discard, Choose ours, Choose theirs, branch delete, worktree remove with changes, rebase, and amend each have their own confirmation. The Rebase button counts as the rewrite confirmation (spec FR-026). For a commit that no upstream holds, the checked Amend box with its statement "Commit replaces commit <short ID>." and Commit count as the rewrite confirmation (spec FR-098). Discard drops the stash commit; Git keeps it unreachable until garbage collection. The text "You cannot undo this" stays, because Arbareto offers no recovery for it.
- **N-2 (V, "explicit trust approval before execution")**: An approval now binds to the folders, the Git selection, and the policy version (spec FR-071). After approval, a changed or new hook in the approved folders runs without a new prompt. Example: a tracked `.githooks` folder that a pull changes. The spec Clarifications accept this. Principle V stays met, because the user approves before the first run. One class `workbench` covers all local branch and worktree actions; this is a ponytail ceiling, as 003 N-1. Upgrade path: one class per action, when a user reports extra prompts.
- **N-3 (VII, "cold/warm timings")**: P9 records cold and warm runs for SC-007 by the 001 rules.
- **N-4 (Delivery Gates)**: Safety tests (SC-001, SC-002, SC-004 to SC-006, SC-008, SC-009, SC-015, SC-016), trust boundaries (D12), accessibility checks (SC-014, FR-085), performance budgets (SC-007), and platform qualification (P9) are defined here.

No violation, so Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/004-workbench-ux/
├── spec.md
├── plan.md                 # This file
├── research.md             # Phase 0
├── data-model.md           # Phase 1
├── quickstart.md           # Phase 1
├── contracts/
│   └── operations.md       # Phase 1: deltas to the 001, 002, and 003 contracts
├── checklists/
└── tasks.md                # Phase 2 (/speckit-tasks, not created here)
```

### Source Code (repository root)

```text
src/
├── contracts/              # operations.ts, envelope.ts, errors.ts, limits.ts, channel.ts,
│                           # git-environment.json (+ mergetool), wsl-process.json (+ mergetool), schemas/,
│                           # file-action.ts (+ lines, + files), new: ignore-line.ts, branch-name.ts
├── git-service/            # session.ts, trust.ts (+ workbench, mergetool classes, merge drivers), file-publish.ts,
│                           # hunk-candidate.ts (+ sub-hunk), hunk-publish.ts, status.ts (cut kind), submodule-review.ts,
│                           # submodule-update.ts (scope, hosts), git-runner.ts
│                           # new: workbench-commands.ts, workbench-parsers.ts, line-patch.ts, switch-check.ts,
│                           #      workbench-review.ts, switch.ts, branch-ops.ts, merge-rebase.ts, resolve.ts,
│                           #      multi-publish.ts, ignore.ts, worktrees.ts, git-settings.ts
└── frontend/               # app/Workbench.tsx, app/NoticeBand.tsx, keyboard/shortcuts.ts, refs/ReferencesSidebar.tsx,
                            # changes/*, commit/*, submodules/*, trust/* (TrustDialog.tsx goes)
                            # new: components/{switcher-popover,action-menu,confirm-popover,docked-panel,segmented}.tsx,
                            #      views/{HistoryView,CommitView,SettingsView}.tsx, branches/*, integrate/*,
                            #      worktrees/*, settings/git/*, resolve/*, trust/TrustChip.tsx
src-tauri/
├── build.rs
└── src/                    # ipc.rs, git_env.rs, wsl.rs, process_requests.rs, settings.rs, dialogs.rs, close.rs, file_facts.rs
                            # new: file_append.rs, reveal.rs
tests/
├── git/                    # new: workbench-fixtures.ts, workbench-facts.test.ts, staging-facts.test.ts, switch.test.ts,
│                           #      branch-ops.test.ts, merge-rebase.test.ts, resolve.test.ts, multi-stage.test.ts,
│                           #      line-stage.test.ts, ignore.test.ts, worktrees.test.ts, git-settings.test.ts,
│                           #      trust-v2.test.ts, submodule-scope.test.ts
├── windows/                # new: native-facts.test.ts, workbench-packaged.test.ts, workbench-perf.test.ts
├── wsl/                    # new: workbench-wsl.test.ts
├── contracts/              # new: workbench-*.test.ts(x), shortcuts-004.test.ts
└── vectors/
```

**Structure Decision**: The three-part layout stays: renderer, Bun service, and shared contracts, with a thin Tauri shell. The new service modules sit beside the 003 `sync-integrate.ts` and reuse its policy `integrate`, its conflict actions, and the 001 publication path.

## Design

### Steps (riskiest proof first)

| Step | Files and symbols | Behavior change | Tests that prove it | Main risk |
|---|---|---|---|---|
| P0.1 Fixtures | new `tests/git/workbench-fixtures.ts`. It reuses `fiCommit` and the owned global configuration of `tests/git/fixtures.ts` and the 003 `tests/git/remote-fixtures.ts`. | None (tests only). Branch fixtures: merged, unmerged, current, other-worktree, detached unreachable, names with `/`, a branch section in `.git/config`. Switch fixtures: clean, dirty, conflicting change, untracked and ignored files in the way, a remote branch with one, zero, and two mapping refspecs. Merge and rebase fixtures: fast-forward, diverged, `merge.ff=only`, a merge driver, `rebase.updateRefs`, `fixup!` commits, patch-same commits, empty commits. Conflict kinds UU, AA, AU, UA, DU, UD, DD, a symlink stage. Staging fixtures: 100,000 untracked files, a folder tree, hunks of added, removed, and mixed lines, an incomplete last line. Worktree fixtures: locked, prunable, dirty, main. Config fixtures: each key in each scope, a multi-valued key, an include, an XDG global file. | The builder self-check: refs, counts from `rev-list`, the worktree list, configuration digests. | Build time of 100,000 files. Mitigation: the 001 fixture cache. |
| P0.2 Git facts | new `tests/git/workbench-facts.test.ts` | None. Records the Git behavior that the design depends on (research R21). | F1 to F24 and F29 to F31 of research R21, each against Git's own result on a copy. Windows Git 2.56 and WSL Ubuntu-26.04 Git 2.55. Each fact records the observed version. | A fact fails. Record it in research.md and change the contract before P2. |
| P0.3 Staging facts | new `tests/git/staging-facts.test.ts` | None. | F25 to F28: the sub-hunk apply equals the expected blob for every selection of the line fixtures. F26 records the `cat-file --batch --filters -Z` form. `update-index --add --remove -z --stdin` with 10,000 paths equals `git add` of the same paths. | The `--batch --filters` path split (research R10). |
| P0.4 Native facts | new `tests/windows/native-facts.test.ts` | None. | N1 to N6: the task dialog expanded text by UI Automation, the WebView2 `contextmenu` path, a merge tool window under the operation Job, Cancel of that Job, Explorer reveal, and the foreground of the tool window. | UI Automation of a task dialog. Capability skip, recorded as unverified. |
| P1 Pure logic | new `src/git-service/{workbench-commands,workbench-parsers,line-patch,switch-check}.ts`, new `src/contracts/{ignore-line,branch-name}.ts` | Algorithms only. | Vector tests for each argv builder. Parser tests for the worktree record, the configuration value view, the refspec map, and the URL host. Line patch tests against an independent apply. Ignore line escapes. | Grammar drift. P0.2 pins it. |
| P2 Contracts | `src/contracts/{operations,envelope,errors,limits,channel,file-action}.ts`, `git-environment.json`, `wsl-process.json`, `schemas/`, `tests/vectors/` | Adds `readBranches`, `readWorktrees`, `readGitSettings`, `reviewWorkbench`, `runWorkbench`, `applyFiles`, `openWorktree`, `revealPath`, `setSwitchChoice`, the `lines` field of `applyHunk`, the `scope` field of `reviewSubmodules`, codes, phases, the policy `mergetool`, and the private requests `fileAppend` and `trust confirm` version 2. | Schema tests and golden vectors in Bun and Rust. | typify drops ranges. Keep explicit Rust checks (001 §1). |
| P3 Shell | `src-tauri/src/{ipc,git_env,wsl,process_requests,settings,close,file_facts,dialogs}.rs`, new `src-tauri/src/{file_append,reveal}.rs`, `src-tauri/build.rs`, `src-tauri/capabilities/main.json`, `src/frontend/bridge.ts`, `tests/contracts/bridge.test.ts` | Allowlist, the policy `mergetool` with its limits, the kind fit of `integrate`, the `globalConfig` and `worktreeAdd` contexts, `fileAppend`, `revealPath`, `openWorktree`, close prompt names, marker kinds, the switch choice setting. The task dialog redesign comes in P7. | Cargo tests for each request, each refusal, and the policy limits. | Local only. Rust work stays off cloud sessions. |
| P4 Service P1 | new `switch.ts`, `branch-ops.ts`, `merge-rebase.ts`, `multi-publish.ts`, `ignore.ts`, `workbench-review.ts`; `hunk-candidate.ts` (sub-hunk), `file-publish.ts`, `status.ts` (cut kind), `trust.ts` (class `workbench`, merge drivers), `session.ts` | US1 to US4: switch, branch actions, merge, rebase, multi-file and line staging, ignore lines. | SC-001, SC-002, SC-004, SC-005, SC-006, SC-013. Stale tokens, Cancel at each step, external ref moves, hook rejection, the untracked-in-the-way refusal, the stash reapply conflict. | Stash reflog races (research R3). The runtime checks refuse on a mismatch. |
| P5 Frontend P1 | new `components/*`, `views/*`, `branches/*`, `integrate/*`; `app/Workbench.tsx`, `keyboard/shortcuts.ts`, `refs/ReferencesSidebar.tsx`, `changes/*`, `commit/*`, `index.css` | The view switch, the branch button and list, the switch confirmation, the branch context menu, the merge and rebase panels, the commit workspace. | Component tests: keyboard, focus, unavailable reasons, the virtual tree with 100,000 rows, multi-select, line selection, the 72-column guide. | The commit view replaces the 001 docked commit panel. Every 001 commit panel test moves with it. |
| P6 Service P2 | new `worktrees.ts`, `git-settings.ts`, `resolve.ts`; `submodule-review.ts`, `submodule-update.ts`, `trust.ts` (version 2), `session.ts`, `commit-review.ts` and `commit.ts` (amend) | US5, US6, US7 service part, US8, US9, US11. | SC-008, SC-009, SC-010, SC-011, SC-015, SC-016. | Trust record migration (O-5). |
| P7 Trust shell | `src-tauri/src/{dialogs,settings,service}.rs`, `src/contracts/channel.ts` | The task dialog with main instruction, content, collapsed details, and Not now as default. The record version 2. The run confirmation text. | Cargo tests for the dialog model, the button IDs, the record round trip. N1 packaged check. | Local only. |
| P8 Frontend P2 | new `worktrees/*`, `settings/git/*`, `resolve/*`, `trust/TrustChip.tsx`; `submodules/*`, `commit/*` (amend), `app/Workbench.tsx` (mount points only) | Worktree button and panels, Settings view, trust chip and inline reasons, Submodules group, resolve view, Amend last commit. | Component tests per FR. | The 003 settings dialog moves into the Settings view (O-7). |
| P9 Qualification | `tests/windows/{workbench-packaged,workbench-perf}.test.ts`, `tests/wsl/workbench-wsl.test.ts` | None (tests). | SC-003, SC-007 (cold and warm, CPU, process-tree memory), SC-010 prompt counts, SC-014 keyboard and contrast, N1 to N6 in the package, WSL rows. | The open 001 measurement tools (001 T165, T180, T240, T242, T244). |
| P10 Spell check | new `src/frontend/commit/spelling.ts`, `package.json`, `bun.lock`, notices | US10. | SC-012 with the fixture message; no network request during the session (the 003 no-network harness). | Dictionary bundle size and license (D17). |

Each phase writes its tests first. P0.2 to P0.4 are the riskiest proofs and run first.

### D1 Contracts

[contracts/operations.md](contracts/operations.md) holds the deltas. Summary:
- Reads: `readBranches` (one `for-each-ref` over `refs/heads` and `refs/remotes`, joined with the 003 tracking and the worktree list), `readWorktrees` (`worktree list --porcelain -z`), `readGitSettings` (the 001 configuration listing, by scope).
- `reviewWorkbench {action, …}` is read-only. It returns the plan, a refusal, or a one-use `workbenchToken`. Actions: `switch`, `create-branch`, `rename-branch`, `delete-branch`, `merge`, `rebase`, `choose-side`, `mergetool`, `ignore`, `worktree-add`, `worktree-remove`, `worktree-prune`, `config-save`.
- `runWorkbench {workbenchToken, start: true}` is the one new general mutation. It re-reads every bound value, runs the reviewed steps, and reconciles.
- `applyFiles` stages or unstages a file set in one index publication. `applyHunk` gains the optional `lines` field.
- Native-first: `openWorktree` and the path of `worktree-add`. Shell-only: `revealPath`, `setSwitchChoice`.
- `reviewSubmodules` gains `scope` and the host lines. `updateSubmodules` gains `confirmHosts`.
- New codes: `WORKBENCH_UNAVAILABLE`, `UNTRACKED_IN_WAY`, `STASH_KEPT`. Contract Δ9 lists the reasons.

### D2 Process model, environment, and outcomes

- Policies (contract Δ7):
  - Every 004 Git mutation step runs under the 003 policy `integrate`: `mutation` without `GIT_INDEX_FILE`, plus `GIT_EDITOR=:`. The 003 kind fit (003 Δ6) adds the kinds `workbench` and `applyFiles`.
  - The staging steps of `applyFiles` and line staging keep the 001 `mutation` policy with the owned candidate.
  - New policy `mergetool`: the `integrate` environment, no inactivity limit, the 4-hour ceiling, and empty standard input. Only `runWorkbench` with action `mergetool` uses it.
  - Reads keep the 001 `read` policy. The Git settings view without a repository runs `config list` in the new `globalConfig` context.
- Limits: `integrate` takes the 003 limits: inactivity 300 s, ceiling 4 h, stall notice 15 s. Review reads keep the 30 s deadline (001 §5).
- Every argument array starts with `--no-lazy-fetch`. Reads add `--no-optional-locks` and `--literal-pathspecs` (001 `READ_OPTIONS`). The one exception is `check-ignore --no-index` of D3, which refuses `--literal-pathspecs` (research R21 F1). Checkout steps add `--no-recurse-submodules`, because `git checkout` honors `submodule.recurse` (git-checkout(1)) and the 001 rule keeps Git out of submodules.
- Mutation exclusion: every `runWorkbench` and `applyFiles` enters the 001 exclusion and records a marker of kind `workbench` with its action (spec FR-001). A second mutation gives `BUSY`.
- Outcomes: the 001 data-model §7 states. A result names each effect that the reconciliation observed (spec FR-003). These are HEAD, the changed refs, the stash entry, the index digest, the worktree list, and the operation state.
- Cancel closes the Job of the operation. Reconciliation then re-reads. WSL first waits for the 001 §4 process-end fact.
- Progress phases: contract Δ2. Rebase progress has no percentage, because Git prints none in a machine form.

### D3 Branch switch

- Review reads (contract Δ3 `reviewWorkbench` `switch`): the 001 HEAD capture and markers, `status --porcelain=v2 -z --untracked-files=no --ignore-submodules=dirty` (tracked changes only, so 100,000 untracked files cost nothing here), the worktree list, and the target ref value.
- Clean switch (spec FR-009): a pick in the branch list sends `reviewWorkbench`. When the review reports no tracked change and no unreachable detached commit, `runWorkbench` follows at once. A double-click always shows the confirmation.
- Unreachable detached commit: with a detached HEAD C, `for-each-ref --contains=<C> --count=1 --format=%(refname)` prints nothing when no ref holds C. The confirmation then names C and states that only the reflog keeps it (spec FR-013).
- Local target: `checkout --no-guess --no-recurse-submodules <branch> --`. `--no-guess` stops the remote DWIM when the branch vanished. `--` after the name stops the path reading (git-checkout(1)). This argv has no end-of-options marker, so a short name that starts with `-` refuses with reason `invalid-name` before any Git process. Git's own `check-ref-format --branch` refuses that name, but `update-ref` can create it (FR-004).
- A local target named `@` refuses with reason `reserved-name` before any Git process (D4). Git reads `checkout @ --` as HEAD and keeps the current branch (research R21 F29).
- Remote-tracking target, new local branch: `checkout --no-guess --no-recurse-submodules -b <name> --track=direct <refs/remotes/...> --`. The default name comes from the fetch refspecs (research R2). Zero or several mapping refspecs give an empty field. The name follows the D4 rule, so `@` refuses with reason `reserved-name`. A taken name refuses with reason `name-exists` and offers a switch to that branch.
- Remote-tracking target, commit only: `checkout --no-recurse-submodules --detach <oid> --`. The OID binds the shown commit.
- A branch that another worktree holds gives reason `other-worktree` and the plan names that worktree, so the list offers Open (spec FR-013).
- Local changes choice (spec FR-010, FR-011, FR-012), with tracked changes present:
  - Keep changes: the plain checkout. Git refuses a conflicting change and changes nothing (P0.2 F3).
  - Stash and reapply: the stash protocol below, then the checkout, then `stash apply --index <S>`. A failed checkout does not reapply.
  - Discard changes: the untracked-in-the-way check, the stash protocol, the checkout, then `stash drop` of S. A failed checkout reapplies S at once on the unchanged HEAD, so the user keeps every change. Discard never passes `--force` (research R3).
- Stash protocol (research R3): read `refs/stash` as P. Run `stash push --quiet -m "Arbareto: switch to <branch>"`. Read `refs/stash` as S and the first two entries of its reflog. Accept S only when S differs from P, the entries are S then P, and the first parent of S equals the bound HEAD. Exit 0 with `refs/stash` equal to P means that nothing was stashed; the switch then runs as Keep changes (spec Edge Cases). Any other observation stops before the checkout, and the result names `refs/stash`.
- Reapply result: a fresh index read decides (spec FR-012). Unmerged entries keep S, and the 003 Conflicted list shows them. A non-zero exit without unmerged entries keeps S and gives the remedy `git stash apply <S>`. Exit 0 without unmerged entries drops S.
- Drop: the service reads the `refs/stash` reflog, finds the one entry n whose OID is S, and runs `stash drop --quiet stash@{n}`. No entry or two entries leave S, and the result says so. The window between that read and the drop is a contract gap (contract "Contract gaps").
- Untracked-in-the-way check for Discard (research R4): `diff-tree -r -z --no-renames --name-status <HEAD> <target>` gives the paths that the checkout writes. `fileFacts` reads each path and each leading folder without following links. A file or link counts only when `ls-files -z --stage` has no stage-0 entry at that path. A folder counts where the target writes a file. A `fileFacts` reply of kind `other` counts as a file, because Git's checkout refuses every untracked entry in the way that is no folder (unpack-trees.c `verify_absent`). A reply of kind `error` leaves the check without a verdict, so the switch refuses with reason `unreadable`. Discard stashes the tracked changes first, so a tracked path with changes does not count. This rule matched Git's verdict in all 6 F7 cases (research R21). `check-ignore -z --stdin --no-index` removes the ignored candidates, because Git treats ignored files as replaceable (spec Assumptions). This read has no `--literal-pathspecs`, because Git refuses it there with exit 128 (research R21 F1). Candidates left refuse the switch with `UNTRACKED_IN_WAY` and up to 100 paths. Git's own refusal stays the second guard.
- Preselected choice: the shell setting `switchChoice`, `keep` or `stash`. `discard` is refused as a value (spec FR-010).

### D4 Branch actions

- Name rule (`src/contracts/branch-name.ts`): 1 to 255 UTF-8 bytes, well-formed, no NUL. The service then runs `check-ref-format --branch <name>`. Exit 0 with stdout equal to the name passes. Another stdout refuses, because `--branch` expands `@{-n}` (git-check-ref-format(1)). Non-zero exit refuses with reason `invalid-name`.
- Reserved name: the rule refuses the name `@` with reason `reserved-name`, before `check-ref-format`. Git accepts `@` as a branch name (research R21 F11). In a revision argument, `@` means HEAD (gitrevisions(7)). The switch argv passes the short name, and `checkout @ --` keeps the current branch (F29). The rule applies to create, to the new name of rename, and to the track name of D3.
- An existing branch named `@` from outside Arbareto: switch and worktree add refuse it with reason `reserved-name` before any Git process (D3, D10). Rename from `@` and delete stay available. `branch -m` reads the old name as a branch name (F29), and delete passes `refs/heads/@`.
- Every other revision argument in an argv is a full ref name, such as `refs/heads/<name>`.
- Create branch here: with "Switch to the new branch", `checkout --no-recurse-submodules -b <name> <oid> --`. Without it, `branch --end-of-options <name> <oid>`. The OID binds the selected commit, so Git sets no upstream for it (git-branch(1) `branch.autoSetupMerge`).
- Rename: `branch -m --end-of-options <old> <new>`. Git renames the `branch.<old>` section, moves the reflog, and updates the HEAD of each worktree that holds the branch (builtin/branch.c `copy_or_rename_branch`).
- Delete (spec FR-017 to FR-019, research R5, R6):
  - Unavailable for the current branch and for a branch with a `branch` attribute in the worktree list.
  - Count: `rev-list --count <oid> --not --exclude=<name> --branches --tags --remotes`. `--exclude` takes the name without `refs/heads/` for `--branches` (git-rev-list(1)). Ref names hold no `*`, `?`, `[`, or `\` (git-check-ref-format(1)), so the pattern is literal.
  - Reflog statement: `reflog exists HEAD`, then `log -g -z --no-show-signature --format=%H HEAD --` up to 10,000 entries. `--no-show-signature` keeps `log.showSignature` from running the signing program in a read. The tip in that list gives "Git's HEAD reflog keeps commit <short ID> for a limited time." Otherwise "No reflog keeps commit <short ID> after the delete." (O-4).
  - Run: `update-ref --no-deref -d refs/heads/<name> <oid>`. Git refuses when the ref moved (git-update-ref(1)), so no ref changes.
  - Then, only when the configuration listing holds a local entry of `branch.<name>`: `config --local --remove-section branch.<name>`. Git's own `branch -D` removes that section (`delete_branch_config`). P0.2 F9 compares refs, reflogs, and configuration bytes with Git's own `branch -D`.
- Copy branch name: the renderer writes the short name to the clipboard, with the 002 copy helper.
- Push in the branch menu: the 003 push of the current branch. On another branch, it is unavailable with "Push sends the current branch only." (spec Scope Boundaries).

### D5 Merge

- Review reads: HEAD, markers, `rev-list --left-right --count HEAD...<oid>`, `merge-base --is-ancestor HEAD <oid>` (exit 0 means fast-forward possible, exit 1 means not; git-merge-base(1)), the effective `merge.ff`, and the message preview.
- Message preview: `fmt-merge-msg` with stdin `<oid>\t\tbranch '<name>' of .` and LF, the line that `git merge <name>` builds for a local branch (builtin/merge.c `merge_name`). A remote-tracking source uses `remote-tracking branch '<name>' of .`. `<name>` is the short display name, such as `topic` or `origin/topic`. P0.2 F12 confirmed that the preview equals the message of Git's own `git merge <short name>`, with and without `merge.log`, on `main` and on another branch (research R21, O-6).
- Argv, Merge commit: `merge --no-autostash --no-edit [--no-ff] [--no-commit] --no-log -m <message> --end-of-options <ref>`. `<ref>` is the full ref, such as `refs/heads/<b>`, so a tag of the same name cannot win. `<message>` is the preview, or the edited text. This argv always passes `--no-log -m`, because `merge.log` appends a shortlog to an explicit message (research R7), and the preview already holds that shortlog.
- Merge message bound (`MERGE_MESSAGE_BYTES`, 8 KiB): `git merge -F -` reads a file named `-` (builtin/merge.c `option_read_message`), so the message must fit in the `-m` item. The 001 §6 bound is 32,767 UTF-16 units with the terminating null (`WINDOWS_COMMAND_LINE_UNITS`). A UTF-8 byte gives at most one UTF-16 unit. The CreateProcess quoting of `commandLineUnits` adds at most one unit per byte, only for an ASCII `"` or `\`. So a message of B bytes takes at most 2B + 3 units (the separator and two quotes). With B = 8,192, the item takes at most 16,387 units, and 16,380 units stay for the rest. The `wsl.exe` line with short paths and an empty message, measured with `wslCommandLineUnits`, is 1,143 units; the wrapper text alone is 749. The `git.exe` line is 147 units. A Linux worktree root at `PATH_MAX` (4,095 bytes) takes at most 8,193 more. 12 KiB would leave 8,188 units, which that root does not fit; 16 KiB alone is above the bound. The review still measures the whole line with the bound message and refuses a longer line with `message-size`, as it refuses a longer preview or message. The editor enforces the bound (spec FR-022).
- Argv, Squash: `merge --no-autostash --no-edit --squash --end-of-options <ref>`, without `--no-log -m`. Git accepts `-m` with `--squash` and ignores it: `SQUASH_MSG` holds the same bytes with and without `-m` (research R21 F30). Git commits nothing. The later commit is the 001 commit `commit --quiet --file=-`, and its message is the commit box text (F30).
- Combinations: Squash disables No fast-forward (Git refuses `--squash --no-ff`). Squash hides the message, because Git writes `SQUASH_MSG`, ignores `-m`, and commits nothing (F30). Git fast-forwards also with `--no-commit` (git-merge(1)). So Don't commit with a possible fast-forward selects No fast-forward and locks it. The reason reads "Git fast-forwards without a merge commit, so Don't commit needs No fast-forward." `merge.ff=only` without a possible fast-forward makes Merge commit unavailable with that reason.
- `--no-autostash` follows 003 N-4. A dirty tree that the merge touches makes Git refuse, and nothing changes.
- Outcome: fresh reads of HEAD, `MERGE_HEAD`, and unmerged entries. A stop with conflicts shows the 003 conflict notice (003 FR-030).

### D6 Rebase

- Review reads: `rev-list --count --right-only --cherry-pick --no-merges <oid>...HEAD` for the moved count. That is the walk of sequencer.c `sequencer_make_script`: `right_only`, `cherry_mark`, and `max_parents=1` (research R8). With `rebase.rebaseMerges` true, `--no-merges` goes.
- Rewritten range: `rev-list --count <oid>..HEAD`. Held count: that count minus `rev-list --count <oid>..HEAD --not --remotes`.
- Force note (spec FR-024, O-2): the 003 push destination (003 D4) of the current branch can have a tracking ref T. The note shows when `rev-list --count <oid>..HEAD --not <T>` is below the rewritten count. It reads "The rebase rewrites commits that <T> holds, so the next push needs Force push with lease."
- Moved branches: with `rebase.updateRefs` true, `for-each-ref --merged=HEAD --no-merged=<oid> --format=%(refname) refs/heads` lists the candidate branches. The service removes each branch that the `branch` attribute of another worktree record of `worktree list --porcelain -z` names, because Git does not move a branch that another worktree checks out (research R21 F16). The panel names the branches left.
- Options (spec FR-025): Autostash starts from `rebase.autoStash`, with its scope and file. Autosquash starts unchecked and never takes its default from `rebase.autoSquash`, because that key affects only an interactive rebase (research R21 F15). The argv always passes the explicit form: `--autostash` or `--no-autostash`, and `--autosquash` or `--no-autosquash`. Interactive shows as unavailable: "Not in this version".
- A tracked change without Autostash makes Rebase unavailable: "Commit or stash your changes, or select Autostash." (P0.2 F14).
- Argv: `rebase (--autostash|--no-autostash) (--autosquash|--no-autosquash) --end-of-options <ref>`.
- Outcome: fresh reads of HEAD, the markers, and unmerged entries. An autostash that Git could not reapply moves `refs/stash`; the result names the new stash commit.
- Continue, Skip, and Abort stay the 003 actions (003 D7).

### D7 Conflict resolve

- Kind: the XY code of the porcelain v2 `u` record (spec FR-089). The stages come from `ls-files -z --stage -- <path>`.
- Side names (spec FR-090): this service session can have started the operation. Then the labels are the names it recorded, after a check that `MERGE_HEAD` or `REBASE_HEAD` still equals its start fact. Otherwise the labels are the refs that point at the commit (`for-each-ref --points-at=<oid>`), else the short ID. During a rebase, ours is HEAD and theirs is `REBASE_HEAD`, as git-checkout(1) `--ours` states.
- Choose ours or theirs: `--literal-pathspecs checkout --no-recurse-submodules --ours -- <path>` or `--theirs`. `--literal-pathspecs` keeps a path with `[` from matching other paths (FR-004). The path stays unmerged. Available only with a stage of that side with mode `100644` or `100755`. The token binds the stages and the working file identity and digest, as 003 Mark resolved does (003 data-model §9).
- Open in merge tool: `mergetool --tool=<tool> --no-prompt -- <path>` under the policy `mergetool`. `<tool>` is the effective `merge.tool`. The global `--literal-pathspecs` reaches the script as `GIT_LITERAL_PATHSPECS` (git(1)). Available only with stages 2 and 3 that are regular files.
- Result: a fresh index read decides (spec FR-096). No unmerged stage left: "Git staged <path>." Else the path stays in the list. Backup files show through the next status read.
- Process ownership (D14): the tool runs in the operation Job. Cancel closes the Job, which ends Git, its shell, and the tool process that the Job holds. A tool that hands the file to an earlier instance outside the Job keeps that window (O-8).

### D8 Commit workspace staging

- Multi-file stage (`applyFiles` direction `stage`, spec FR-034 to FR-040): one owned candidate, `update-index --add --remove -z --stdin` with all paths, one verification, one publication. This is the 001 `applyFile` path with a path list (001 §4 "File staging").
- Proof for a file set: each file takes the 001 single-file proof A, then proof B after a failed proof A (001 §4 "Blob proof"). The batch form `cat-file --batch --filters -Z` cannot frame its records, because its header gives the stored blob size, not the filtered length (research R21 F26). A batch replacement is open (O-17).
- Multi-file unstage: one `update-index -z --index-info` with the HEAD entries of every path.
- Binding (spec FR-039): the snapshot ID and the entry IDs that the renderer saw. The service re-reads status for those paths before publication. Another entry set refuses with `STALE_SELECTION`.
- Bound (spec FR-040): at most 10,000 files (`MULTI_FILE_ACTION_FILES`) and 512 MiB of working bytes (`MULTI_FILE_ACTION_BYTES`, the 001 `WHOLE_FILE_STAGE_INPUT_BYTES`). Above the bound, the action is unavailable with the stated limit. P9 measures the time of a 10,000-file action.
- `add -- <pathspec>` was rejected: it stages entries outside the shown read and writes the canonical index without the candidate checks (research R10).
- Stage folder: the entries of that list whose path starts with the folder path and `/`, in the shown read. Stage all changes: every entry of the Changes list, tracked and untracked. Stage all untracked: every Untracked entry. Unstage all: every Staged entry.
- Line staging (spec FR-041 to FR-044, research R11): `applyHunk` with `lines`, the ordinals of the selected `+` and `-` lines of one retained hunk. To stage, an unselected `-` line becomes context and an unselected `+` line goes. To unstage, the reverse applies to the staged hunk. The header counts follow the kept lines. The 001 steps then run unchanged: `apply --cached` on the candidate, the independent `applyToContent`, `hash-object --no-filters --stdin`, the exact entry check, and publication.
- Line refusals: a selection of context lines only (reason `context-only`), a hunk of a deleted file (reason `deleted-file`), and an unstage of lines of a staged new file (reason `new-file`, because the reverse apply deletes the file and Git refuses a partial deletion). Lines of two hunks give `several-hunks` in the renderer (D15). Every 001 FR-011 refusal stays.
- Line refusal texts: `deleted-file` "Git cannot stage or unstage part of a deleted file." and `new-file` "Git cannot unstage part of a new file." The hunk buttons still stage or unstage the whole hunk.
- End-of-file hunk (reason `eof-newline`, O-9): a hunk whose body holds a `\ No newline at end of file` line, on either side, refuses every partial selection before the apply. A selection of every `+` and `-` line of the hunk is the whole hunk and passes. For a partial selection there, `apply --cached` joins two lines with exit 0, and `applyToContent` computes the same blob, so the 001 entry check cannot catch it (research R21 F25).
- Amend last commit (spec FR-098 to FR-100, contract Δ3 "`reviewCommit` and `commit`"): `reviewCommit {amend: true}` adds three reads to the 001 commit review. `cat-file commit <HEAD>` gives the message: the bytes after the first empty line. An `encoding` header that Git does not treat as UTF-8 refuses with the 001 `COMMIT_ENCODING_UNSUPPORTED`. `for-each-ref --format=%(upstream) <HEAD ref>` gives the upstream U. With U, `merge-base --is-ancestor HEAD <U>` decides `rewritesUpstream`: exit 0 true, exit 1 false, another exit `GIT_FAILED` (git-merge-base(1)). The review token binds the HEAD OID and `rewritesUpstream`. An empty staged scope still gets a token, because a message-only amend is valid. `commit {amend: true}` runs `commit --quiet --amend --file=-` through the 001 handoff. A review with `rewritesUpstream` true needs `confirmRewrite: true`, which the renderer sends only after the destructive confirmation. An unborn HEAD gives `WORKBENCH_UNAVAILABLE` reason `unborn`. A merge or a rebase gives `OPERATION_IN_PROGRESS`. The renderer keeps the earlier draft while the box is checked (data-model §14).

### D9 Ignore lines

- The line (`src/contracts/ignore-line.ts`, spec FR-046): `/`, then the path from the worktree root, with `\` before each `*`, `?`, `[`, and `\`, and `\` before each trailing space (gitignore(5)). A folder ends with `/`. The leading `/` keeps `#` and `!` away from the line start, so they need no escape. A path with a control character or invalid UTF-8 refuses with reason `path`.
- Targets: the root `.gitignore`, or the path of `rev-parse --path-format=absolute --git-path info/exclude`.
- Write: the service sends `fileAppend` (contract Δ6) with the target, the expected state (`absent`, or size and SHA-256), and the bytes: LF first when the file does not end with LF, then the line and LF. The shell opens the file without following links, checks a regular file and the expected state, and appends. A link, a folder, invalid UTF-8, a NUL, a file above 1 MiB, or an equal existing line refuses (spec FR-046). The status read follows.
- No Git command writes these files, so the write is the app's own (research R12).

### D10 Worktrees

- List: `worktree list --porcelain -z`. Each record is attribute lines ended by NUL, and an empty line ends the record. Attributes: `worktree`, `HEAD`, `branch`, `detached`, `bare`, `locked` with an optional reason, `prunable` with a reason. With `-z`, reasons are not quoted (builtin/worktree.c `show_worktree_porcelain`, research R13).
- Current worktree: the record whose path identity equals the workspace worktree identity (001 §6 identity request). Main worktree: the first record (git-worktree(1) "The main worktree is listed first").
- Add: `worktree add [-b <new>] -- <path> <oid or branch>`. An existing branch passes its short name, because `worktree add` checks out a branch only when `refs/heads/<name>` exists (P0.2 F17). An existing branch named `@` refuses with reason `reserved-name` before any Git process (D4). A new branch follows the D4 name rule. The path check runs in the shell by OS facts (003 `destinationFacts` with the new `worktreeAdd` context). Git populates with `reset --hard --no-recurse-submodules` (builtin/worktree.c `checkout_worktree`). The app passes no `--relative-paths` and writes no configuration (spec FR-053).
- Remove: `worktree remove [--force] -- <path>`. The review reads the status of that worktree with `-C <path>`. Its trust follows D12 for that worktree. `--force` goes only after the check box, and only once, so a locked worktree stays refused (git-worktree(1)). A status digest that changed before the start refuses.
- Also delete the branch: the D4 delete after a removal that the fresh worktree list confirms.
- Prune: `worktree prune`. Its default expiry is `TIME_MAX`, so it prunes every prunable record, and it skips locked ones (builtin/worktree.c `prune`).
- Open: `openWorktree` is native-first. The shell checks the path text and binds a discovery context. The service accepts it only when the path identity equals a record of a fresh worktree list. The 001 open flow follows (spec FR-051).

### D11 Git settings

- Read: the 001 listing `config list --show-scope --show-origin -z`. Without a repository, it runs in the `globalConfig` context from the application-owned folder, so it lists system, global, and command entries only.
- Effective value: the last entry of the key in listing order (git-config(1)). Several entries in one scope make the key read-only (spec FR-063).
- Booleans read by Git's rule (`parseMaybeBool`, `trust.ts:65`). A value that is not a boolean shows as text with "Git cannot read this value as on or off." and stays read-only.
- Enumerations (spec FR-061): `core.autocrlf` true, false, input; `pull.rebase` true, false, merges, interactive; `pull.ff` true, false, only; `push.default` nothing, current, upstream, simple, matching. `tracking` shows as "tracking (old name of upstream)" and stays selectable.
- Presets (spec FR-062): the merge and diff tool presets are the tool names of Git's `mergetools/` folder (research R14). A preset writes `merge.tool=<name>` or `diff.tool=<name>` only. Editor presets come from the Git for Windows installer list (O-10).
- Write: `config set --local -- <key> <value>` or `--global`, and `config unset --local -- <key>`. One process per changed key, in page order. Git's documented exit codes decide: 1 invalid key, 3 invalid file, 4 cannot write, 5 several lines or no line (git-config(1)). After Save, the listing runs again (spec FR-065). A failure after some writes reports each written key from that read.
- Header file: the local file is `<common dir>/config`. The global file follows git-config(1) `--global`: `$GIT_CONFIG_GLOBAL` when set, else `~/.gitconfig` when it exists, else the XDG file when it exists, else `~/.gitconfig`. The 001 `git var GIT_CONFIG_GLOBAL` result gives the candidates, and `fileFacts` gives their existence.
- Stale check: before each write, the listing runs again. A different entry set for that key refuses with `STALE_REVIEW`.
- Values show as plain text. The view runs no configured program (spec FR-067).

### D12 Trust redesign (option d)

- Classes (contract Δ7):
  - `workbench`: a repository-controlled hook of `post-checkout`, `post-merge`, `pre-merge-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit`, `pre-rebase`, `post-rewrite`, `reference-transaction`, `post-index-change`, or `pre-auto-gc`; a filter `clean`, `smudge`, or `process`; a command `core.fsmonitor`; a signing program; a merge driver `merge.<driver>.driver`; or the 001 conditions `hooksPathControlled`, `folderUnlisted`, and `inputLimited`.
  - `mergetool`: a repository-controlled `merge.tool`, `mergetool.<tool>.cmd`, `mergetool.<tool>.path`, or bare tool program by the 001 §7 PATH rule; plus the filters, the monitor, and `post-index-change`, because the script runs `checkout-index` and `git add` (research R9).
  - Config writes, ignore lines, and the reads of the Git settings view need no class: they run no repository program.
- Discovery stays (spec FR-075): the 001 listing, the hooks folder by phase-1 `fileFacts`, and no program run. Merge drivers join the discovered keys and the value display list.
- Binding (spec FR-071): the record holds the common-directory path and identity, the worktree root and administration-directory paths and identities, the selected Git path, `policyVersion: 2`, and the approval time. No fingerprint and no digest. Phase 2 `fileFacts` digests go, and so do the session-only bounds.
- State: `approved` with a matching record or session approval. `changed` for a record with the same paths and other identities, another Git path, or `policyVersion` 1. `untrusted` without a record. `revoked` after Stop trusting.
- Ask (spec FR-069, FR-070): an action whose class needs approval in an unapproved state sends `approveTrust {trustId, action}`. The shell shows one task dialog (D14). Trust stores the record and the action then continues. Not now ends `canceled`, and no Git process starts.
- Reads: a read that needs approval shows "Arbareto reads no changes until you trust this repository." with Trust… (spec FR-072). It never prompts by itself.
- Chip (spec FR-073): the status bar shows "Trusted" or "Not trusted" only when the listing names a repository-controlled program. Its menu holds "Trust this repository…" and "Stop trusting this repository".
- Stop trusting: the 001 `revokeTrust`. It closes the lingering Jobs and reports the count (spec FR-074). It is unavailable while a mutation runs, because revocation never cancels running work (001 plan).
- Other worktrees: an operation that runs Git in another worktree needs that worktree's approval under the same classes. The dialog names that folder.
- WSL: the same rules through the distro's Git (spec Edge Cases, 001 FR-046).

### D13 Submodule update redesign

- One click (spec FR-076): Update submodules sends `reviewSubmodules` and, when the review has no refusal and no host line, `updateSubmodules` with its token at once. No review dialog opens.
- Refusals (spec FR-078): each review refusal shows as one line in the Submodules group with its 001 §12 text and "Show remedy". No update starts.
- Host lines (spec FR-079, research R16): each row that fetches lists its remote URLs (001 §12 "Plan"). Its host comes from the Git URL grammar of git-fetch(1) "GIT URLS": the authority host of a `scheme://` URL, the part before the first `:` of the scp form without a `/` before it, and "this computer" for a local path or `file://`. Hosts compare without regard to ASCII letter case (RFC 4343). A row whose fetch host differs from the host of its effective `submodule.<name>.url` gives a line. Update anyway sends `updateSubmodules {confirmHosts: true}`.
- Run confirmation (spec FR-080): the 001 `confirmRun` stays, with the new texts (contract Δ12). Cancel is the default.
- Scope (spec FR-081): `reviewSubmodules {scope: {path}}` reviews that row and its nested rows. Refusals, program lists, and host lines of rows outside the scope do not apply. Kept Git directories apply only under `modules/<name>` of a row in the scope.
- Rows (spec FR-077): the renderer maps the 001 progress events (`path`, `rowIndex`, `rowCount`, `percent`, phase) to the rows. A planned row without events is Waiting.
- Result (spec FR-082): the 001 row results show inline. The status bar states the totals. Registration changes show as one line.

### D14 Shell

- Allowlist: the commands of D1.
- Trust task dialog (`dialogs.rs`, research R17): `TaskDialogIndirect` with `pszWindowTitle` "Arbareto", `pszMainInstruction` "Do you trust this repository?", `pszContent` with the action sentence and the advice sentence, `pszExpandedInformation` with the details, `pszCollapsedControlText` "Show details", and `pszExpandedControlText` "Hide details". Buttons: Trust (ID 100) and Not now (`IDCANCEL`). `nDefaultButton` is `IDCANCEL`. `TDF_ALLOW_DIALOG_CANCELLATION` makes Escape, Alt+F4, and the close button return `IDCANCEL`. No `TDF_ENABLE_HYPERLINKS`, because the text holds repository values.
- Detail values: folder paths, hook event names, filter driver names, and scopes. A value with a control character shows as "a name that Arbareto cannot show". At most 20 names per kind, then "and <n> more".
- Run confirmation: main instruction "Run the programs of these submodules?", the content of contract Δ12, Run and Cancel, Cancel as default.
- Merge tool ownership: the `mergetool` policy keeps the 001 Job rules: no breakaway, kill on close. The shell sets no inactivity deadline for it, keeps the 4-hour ceiling, and gives Git an empty standard input. A tool window can open behind Arbareto, because the service starts the process. N6 checks it. If N6 fails, the shell calls `AllowSetForegroundWindow(ASFW_ANY)` right before that run (O-8).
- `fileAppend` (new `file_append.rs`): `CreateFileW` with `FILE_FLAG_OPEN_REPARSE_POINT`, `OPEN_EXISTING` or `CREATE_NEW`, and `FILE_APPEND_DATA`. `GetFileInformationByHandleEx` must show a regular file without a reparse tag. The size and SHA-256 must equal the expected state. Then one `WriteFile` and `FlushFileBuffers`. WSL uses the new `wslFiles` mode `append`.
- `revealPath` (new `reveal.rs`): `SHOpenFolderAndSelectItems` for a path that `fileFacts` places inside the worktree root. A WSL path uses its UNC form.
- `openWorktree`: the 001 `chooseRepository` native step without the picker.
- Contexts: `globalConfig` (fixed `config list` and `config set` and `config unset --global` arrays, application-owned folder) and `worktreeAdd` (the bound path, for `destinationFacts` and the `worktree add` array).
- Close prompt and markers: kind `workbench` with its action name, and kind `applyFiles`.
- Settings: `switchChoice`. The trust record version 2 (P7).

### D15 Frontend architecture

- Views (spec FR-033, design standard D-S2): `Workbench` holds `view: "history" | "commit" | "settings"` per worktree for the window session. Every view keeps the title bar, the top bar, and the status bar. History shows the sidebar, the list, and the dock. Commit is a full view without the sidebar. Settings is a full view with its scope bar and Close.
- Top bar order (design standard): repository button, branch button, worktree button, the 003 Fetch, Pull split button, and Push, the History and Commit segmented control, the menu bar (Repository, View, Help), Refresh, and the Commit icon with its count. View ▸ Settings… opens the Settings view.
- Branch button (spec FR-007): the current branch with the 003 counts, "Detached at <short ID>", or "Merging" or "Rebasing" from the markers. Worktree button (spec FR-049): the current worktree folder name and the worktree count.
- Working directory and Index rows: a selection docks a summary with the counts and "Open Commit view (Enter)". Enter or a double-click on the row switches to the Commit view. Arrow keys never switch the view (reviewer default, O-11).
- Switcher popover (`components/switcher-popover.tsx`): the pattern of the 001 `RepositorySwitcher`: a filter field with first focus, one listbox with `aria-activedescendant`, Enter on the active entry, Escape back to the button. The branch list and the worktree list use it. The list is virtual (spec FR-086). Typing filters by the 001 switcher rule: a literal substring match without regard to letter case. Enter picks the first match. The branch list ends with "New branch… (Ctrl+B)" (spec FR-008).
- Action menu (`components/action-menu.tsx`): Base UI `ContextMenu` for right-click and Shift+F10, Base UI `Menu` for buttons. Items: label, a right-aligned Muted shortcut column, an inline Muted reason for an unavailable item, and the danger text for destructive items (design standard D-S5). An unavailable item stays focusable (spec FR-014). The page calls `preventDefault` on `contextmenu`, so WebView2 raises no `ContextMenuRequested` (Microsoft Learn, research R17). Editable fields keep the built-in text menu.
- Confirm popover (`components/confirm-popover.tsx`): the switch confirmation next to its row, a modal dialog in Base UI, Cancel focused first. Delete and Choose ours or theirs use the modal dialog of 001 "Dialog sizes".
- Docked panel (`components/docked-panel.tsx`): the Merge and Rebase panels and Add worktree take the dock region below the history list, in place of the commit details. Escape or Cancel restores the earlier dock content and focus. Ctrl+Enter runs the panel's primary action.
- Commit view layout (spec FR-029): Changes and Staged lists on the left, the diff on the right, the message editor below the diff. Each region scrolls alone, and splitters follow 001 "Splitter". The status bar states the counts, such as "3 staged files. 1,258 changes, 1,248 of them untracked." (spec FR-048).
- Virtual tree (spec FR-031, FR-086): each list flattens its folders and files into rows, and `@tanstack/react-virtual` renders the visible rows, as 001 ChangesPane does. Folder counts come from one pass over the entries of the snapshot. The Untracked section builds its rows only when it first expands, so a collapsed section of 100,000 files costs no row work (spec FR-030).
- Limited status (research R18): when the 001 bound cuts the read inside the untracked records, the service reports `cut: "untracked"`. The tracked and staged lists are then complete. The Untracked heading states "At least <n> untracked files. Git lists more than Arbareto reads." Multi-file actions over Untracked are unavailable with that reason. Commit stays available, because its review reads the staged scope by itself (001 §4 "Commit validation"). Any other cut keeps the 001 limited rules.
- Multi-select (spec FR-034): click, Ctrl+click, Shift+click, and Shift+Up and Shift+Down. The header then offers "Stage selected (<n>)" or "Unstage selected (<n>)". Space acts on the selection when it holds more than one entry.
- Line selection (spec FR-043): Pierre `enableLineSelection` with `controlledSelection`. Shift+Up and Shift+Down extend the selection while the diff has focus. The hunk mapping of `hunk-mapping.ts` turns the range into line ordinals of one hunk. A range in two hunks gives `several-hunks` and sends no request (contract Δ4). S stages and U unstages only while the diff has focus (spec FR-087).
- Row and hunk buttons (spec FR-032, FR-037): each file row shows its stage or unstage row button on hover and on focus, named "Stage file <name>". Each hunk header shows "Stage hunk" or "Unstage hunk", and the diff heading keeps Previous hunk and Next hunk (001 "Hunk toolbar layout").
- Ignore items (spec FR-045): the menu item opens a confirm popover that shows the exact line and the target file before the write.
- P2 regions: the resolve view replaces the diff for a selected Conflicted entry and shows "Open in <tool>" with Cancel while the tool runs (spec FR-095). The Submodules group and the Worktrees group sit in the sidebar. The Settings view has a page list and the scope bar. The trust chip sits in the status bar (D12).
- Message editor (spec FR-047): a plain textarea with a guide at column 72, drawn from the code font advance width. The counter counts code points of line 1. Line 2 not empty gets a Warning mark with text.
- State: one `state/workbench.ts` store holds the review results, tokens, and outcomes, by the 001 latest-wins and generation rules.
- Keyboard map (spec FR-014, FR-087, research R19):

| Key | Action | Scope | Conflict check |
|---|---|---|---|
| Ctrl+. | Switch | Focused branch row in the sidebar | None in 001 to 003 |
| Ctrl+M | Merge into current branch… | Focused branch row | None |
| Ctrl+Shift+E | Rebase current branch onto… | Focused branch row | None |
| Ctrl+B | Create branch here… | Focused branch row, or the selected history row | None. 002 uses Ctrl+Shift+B. |
| F2 | Rename… | Focused local branch row | None |
| Delete | Delete… | Focused local branch row | 001 switcher uses Delete only inside its popup filter. |
| Ctrl+Shift+Down | Fetch | Window, not in an editable field | 003 D12 key, Git Extensions default |
| Ctrl+Down | Pull (default action) | Window, not in an editable field | 003 D12 key, Git Extensions default (O-1) |
| Ctrl+Up | Push | Window, not in an editable field | 003 D12 key, Git Extensions default (O-1) |
| S, U | Stage or unstage the selected lines | Diff with focus | Single letters stay scoped (spec FR-087). |
| Space | Stage or unstage the entry or the selection | File list | 001 Stage key row |
| Alt+Up, Alt+Down | Previous and next hunk | Diff | 001 |
| Ctrl+Enter | Commit, or the primary action of a docked panel | Message field, or the panel | 001 |

- F6 order per view: History keeps the 001 order. Commit: header, notice band, Changes, Staged, diff, message, status region. Settings: header, scope bar, page list, page content, status region.

### D16 UI standard

Source: the 004 design standard of 2026-10-16 (consistency audit a052af1c, decisions D-S1 to D-S8). These decisions are final.
- Verb (D-S1): the branch action is "Switch". Menu item "Switch (Ctrl+.)", confirmation "Switch to <branch>?", button "Switch". "Check out the commit only" stays for a detached HEAD. This amends the spec FR-014 item "Checkout" (O-12).
- Frame (D-S2): title bar 32 px, top bar 40 px, sidebar 264 px on Surface with "References <n>", status bar 32 px with status text, the trust chip, and the Git version.
- Trust chip (D-S3), history header (D-S4), notes (D-S6), and the sample tag (D-S7) apply to mockups and screenshots.
- Native task dialog (D-S8): Windows chrome colors, the only exception to the tokens.
- Token additions to the 001 compact token system (001 plan.md "Compact token system"). The Light values are open (O-13):

| Role | Dark (Graphite) | Use |
|---|---|---|
| Title bar | `#202227` | Title bar fill |
| Overlay radius | 6 px | Popovers, menus, dialogs |
| Overlay shadow | `0 10px 28px rgba(0,0,0,.5)` | Popovers, menus, dialogs |
| Tooltip shadow | `0 4px 12px rgba(0,0,0,.45)` | Tooltips |
| Danger button | Removed `#F09999` fill, Surface `#26292F` text | Destructive confirm buttons only (D-S5). About 6.7:1 (W3C formula, plan computation; T158 measures it). |

- Danger rules (D-S5): destructive menu items use Removed text. "Abort rebase…" and "Discard changes" are destructive: Removed text on secondary buttons, the filled danger button only inside their confirmation.
- Components: standard button 28 px, row button 24 px, nothing below 24 px. Focus: 2 px Accent outline, offset 2 px on controls and −2 px inside rows and menu items. Selection: the 2×16 px Accent marker. Chips 18 px with radius 4. Count pills radius 9. The selected-lines bar is the 3 px Accent bar on the left.
- Copy: "Label (Key)" on text buttons and tooltips. "…" only when a further step follows. Fixed phrases: "Switch to <branch>?", "Keep changes", "Stash and reapply", "Discard changes", "<n> working changes", "<n> staged", "Not trusted", "Trusted", "Mark resolved", "Selected commit".
- Type and spacing: Segoe UI Variable 12/18, headings 14, Cascadia Code for IDs and keys, spacing 4/8/12/16 only.

### D17 Spell check (P3)

- Library: `nspell` (MIT) with `dictionary-en` (Hunspell en-US from SCOWL). Both run in the renderer without network. The P10 task checks the license text, the bundle size, and the browser load of the `.aff` and `.dic` files before it adds them (O-14).
- Marks: a wavy underline. The wave shape is the non-color cue, and the accessible description of the field states the count of marked words. The chip reads "Spelling: English".
- The context menu of a marked word offers up to 5 suggestions and Ignore. Ignore lasts for the window session.
- Spell check never blocks Commit and never changes text without a selection (spec FR-084).
- Alternative rejected: the WebView2 built-in spell checker. Its words depend on the Windows user dictionary, so SC-012 has no fixed oracle (research R20).

### D18 WSL

- Every operation runs through the distro's Git with wrapper mode `integrate`, and `mergetool` for the merge tool. A merge tool that needs a terminal ends at once, because `setsid --wait` removes the terminal (001 §11).
- `fileAppend` uses `wslFiles` mode `append` inside the distro. Explorer reveal uses the UNC path.
- Worktree paths are Linux paths. `openWorktree` takes them through the 001 §11 route.
- Verify in each distro: F1 to F24, F29 to F31, the stash protocol, the line patch, and the worktree list.

### D19 Tests and fixtures

- Oracles: Git's own command on a copy. Commit OIDs differ by time, so trees, parents, refs, the index, working bytes, and the stash reflog decide.
- Configuration (SC-009): the system, global, and local files before and after, byte for byte. The expected changes are only the saved keys and Git's own branch-section writes of D4.
- Prompts (SC-010): the shell test double counts `confirm` frames. Canary hooks and filters write a marker file. No marker may exist before approval.
- Each new test file adds its line to `tests/groups.json`. Timing tests go into `serial`.
- Mutation tests copy the 001 control rule: one control mutation turns each oracle red.

### Invariants

| Invariant | Evidence |
|---|---|
| `git branch -D` deletes without an expected old value and removes `branch.<name>`. | builtin/branch.c `delete_branches`, `delete_branch_config` (DeepWiki 2026-10-16); P0.2 F9 |
| `update-ref -d <ref> <oldvalue>` deletes only when the ref holds `<oldvalue>`. | git-update-ref(1) |
| `checkout --force` throws away untracked files in the way. | git-checkout(1) `--force` |
| `checkout` honors `submodule.recurse`. | git-checkout(1) `--recurse-submodules` |
| `stash apply` accepts any commit made by `stash push` or `stash create`. `stash drop` needs a reflog entry. | git-stash(1) |
| `stash push` without changes creates no stash and exits 0. | builtin/stash.c `do_push_stash` (DeepWiki 2026-10-16) |
| Porcelain v2 prints changed, unmerged, untracked, then ignored records. | wt-status.c `wt_porcelain_v2_print` (DeepWiki 2026-10-16) |
| The rebase todo walk is `upstream...HEAD` with right-only, cherry mark, and no merges. | sequencer.c `sequencer_make_script` (DeepWiki 2026-10-16); P0.2 F13 |
| `--squash` with `--no-ff` is refused; `--no-commit` still fast-forwards. | git-merge(1); t7600 |
| `worktree list --porcelain -z` ends lines and records with NUL and quotes nothing. | builtin/worktree.c `show_worktree_porcelain`; t2402 |
| `worktree prune` defaults to `TIME_MAX` and skips locked worktrees. | builtin/worktree.c `prune` (DeepWiki 2026-10-16) |
| `config set` and `config unset` exit 5 for several or no matching lines. | git-config(1) exit codes |
| `post-checkout` runs for a file checkout with flag 0. | githooks(5) `post-checkout` |
| `TDF_ALLOW_DIALOG_CANCELLATION` returns `IDCANCEL` for Escape, Alt+F4, and close. | Microsoft Learn TASKDIALOGCONFIG, TaskDialog |
| WebView2 raises `ContextMenuRequested` only when the page did not disable the menu. | Microsoft Learn CoreWebView2.ContextMenuRequested |
| Git Extensions defaults: Pull Ctrl+Down, Fetch Ctrl+Shift+Down, Push Ctrl+Up, Checkout Ctrl+., Create branch Ctrl+B, Merge Ctrl+M, Rebase Ctrl+Shift+E, Delete, F2. | HotkeySettingsManager.cs `CreateDefaultSettings` (DeepWiki 2026-10-16) |

## Open items and reviewer defaults

- **O-1 Keys of Pull and Push.** The first spec FR-014 and its Clarifications named Ctrl+Shift+P and Ctrl+Shift+Up as Git Extensions defaults. The Git Extensions source gives Ctrl+Down and Ctrl+Up (research R19). The plan keeps the 003 D12 keys, which equal the source. Resolved: the spec states these keys (Clarifications, plan-driven corrections).
- **O-2 Force note condition.** FR-024 says "a remote-tracking branch". The plan states the force note only when the push destination's tracking ref holds a rewritten commit. The panel still states the held count over all remote-tracking branches. Resolved: spec FR-024 states it.
- **O-3 SC-009 byte identity.** Git's own branch create with tracking, rename, and delete write `branch.<name>` sections. SC-009 says every configuration file stays byte-identical in other fixtures. The plan accepts Git's own branch-section writes as expected changes. Resolved: spec SC-009 states it.
- **O-4 Reflog statement.** FR-018 says the reflog can restore the tip for a limited time. Git deletes the branch reflog, and only the HEAD reflog can keep the tip. The plan states it from that fact. Resolved: spec FR-018 states it.
- **O-5 Trust record migration.** Version 1 records give `changed`, so each trusted repository asks once after the update (spec FR-071 "trust policy version").
- **O-6 Merge message preview.** It depended on P0.2 F12. Resolved: F12 confirmed the preview, and the merge argv always passes it (D5).
- **O-7 Settings host.** The 003 `settings/SettingsDialog.tsx` content moves into the Settings view as the pages "SSH" and "Clone". 003 WP12 must merge first, or 004 WP22 adds the pages later.
- **O-8 Merge tool window.** Foreground and single-instance tools need N6. A tool window outside the Job stays open after Cancel.
- **O-9 New line refusals.** `deleted-file` and `eof-newline` are plan refusals. Resolved: spec FR-044 lists them.
- **O-10 Editor presets.** The exact `core.editor` values come from the Git for Windows installer. Until a check confirms them, the editor page offers Custom only.
- **O-11 Working directory row.** Selection docks a summary; Enter switches to the Commit view.
- **O-12 Switch verb.** D-S1 amends the FR-014 wording. Resolved: spec FR-014 says Switch.
- **O-13 Light values** of the new tokens wait for the design pass.
- **O-14 Spell check package check** before P10.
- **O-15 FR-016 list.** The spec allows only Abort, Continue, Skip, Mark resolved, Fetch, and Fetch all remotes during a merge or rebase. The resolve actions Choose ours, Choose theirs, and Open in merge tool must also run then. The plan allows them. Resolved: the spec 001 FR-016 change lists them.
- **O-16 FR-033 mode shortcuts.** Feature 001 defines no view or mode shortcut (`src/frontend/keyboard/shortcuts.ts`). The plan adds no key for the view switch. Resolved: spec FR-033 states it.
- **O-17 Batch blob proof.** The batch proof A failed (F26), so each file of a file set takes the single-file proofs (D8). P9 measures that cost for 10,000 files. The candidate `hash-object --stdin-paths` gives the index object IDs after `git add`, also with `eol=crlf` and with a leading space, and a C-quoted line carries any path exactly (research R21 F31). It does not meet 001 §4 "Blob proof": Git reads the working file itself, so the hashed bytes are not the verified bytes. A writer that changes the file during step 5 and keeps the change until that read, then restores it before step 7, passes it. The decision waits for the user.

## Phases

### Batches

| Batch | Steps | Tracks that run in parallel | Content |
|---|---|---|---|
| 0 | P0.1 to P0.4 | A: WP1. B: WP2. C: WP3 (local Windows). | Fixtures and facts, test first. Results go into research.md. |
| 1 | P1, P2, P3 | A: WP4. B: WP5, then WP6 (local). | Pure logic, contracts, and the shell part. |
| 2 | P4 | A: WP7. B: WP8. C: WP9. Then WP10 alone. | P1 service: US1 to US4. |
| 3 | P5 | WP11 alone first. Then A: WP12. B: WP13. C: WP14. | P1 frontend. |
| 4 | P6, P7 | A: WP15. B: WP16. C: WP18. D: WP19. WP17 (local, Rust) beside them. Then WP20 alone. | P2 service and the trust shell. |
| 5 | P8 | A: WP21. B: WP22. C: WP23. D: WP24. E: WP25. F: WP29. | P2 frontend. |
| 6 | P10 | WP26. | P3 spell check. |
| 7 | P9 | WP27 (WSL, alone). WP28 (packaged). | Qualification. |

User stories by priority: P1 is US1 to US4 (batches 2 and 3). P2 is US5 to US9 and US11 (batches 4 and 5). P3 is US10 (batch 6).

### Work packages, in run order

| WP | Agent | Files | Steps |
|---|---|---|---|
| WP0 | implementer | `specs/004-workbench-ux/{plan.md, research.md, data-model.md, contracts/operations.md, quickstart.md}` | This plan. Then `/speckit-tasks` and `/speckit-analyze`. |
| WP1 | implementer-xhigh | `tests/git/workbench-fixtures.ts`, `tests/git/workbench-facts.test.ts`, `tests/groups.json` | P0.1, P0.2 |
| WP2 | implementer-xhigh | `tests/git/staging-facts.test.ts` | P0.3 |
| WP3 | implementer; runs by scout | `tests/windows/native-facts.test.ts` | P0.4. Local Windows. |
| WP4 | implementer | `src/git-service/{workbench-commands,workbench-parsers,line-patch,switch-check}.ts`, `src/contracts/{ignore-line,branch-name}.ts`, their tests | P1 |
| WP5 | implementer | `src/contracts/{operations,envelope,errors,limits,channel,file-action}.ts`, `git-environment.json`, `wsl-process.json`, `schemas/`, `tests/vectors/` | P2 |
| WP6 | implementer-xhigh | `src-tauri/src/{ipc,git_env,wsl,process_requests,settings,close,file_facts,schema,lib}.rs`, new `src-tauri/src/{file_append,reveal}.rs`, `src-tauri/build.rs`, `src-tauri/capabilities/main.json`, `src/frontend/bridge.ts`, `tests/contracts/bridge.test.ts` | P3. Local only. After WP5. |
| WP7 | implementer-xhigh | new `src/git-service/{switch,branch-ops,workbench-review}.ts`, `tests/git/{switch,branch-ops}.test.ts` | P4: US1, US2 |
| WP8 | implementer-xhigh | new `src/git-service/merge-rebase.ts`, `tests/git/merge-rebase.test.ts` | P4: US3 |
| WP9 | implementer-xhigh | `src/git-service/{hunk-candidate,hunk-publish,file-publish,status}.ts`, new `src/git-service/{multi-publish,ignore}.ts`, `tests/git/{multi-stage,line-stage,ignore}.test.ts` | P4: US4 |
| WP10 | implementer | `src/git-service/{session,trust,git-runner}.ts`, `tests/git/trust.test.ts` (class `workbench`) | P4 wiring: handlers, the class `workbench`, merge drivers. After WP7 to WP9. |
| WP11 | frontend-implementer (loads arbareto-ux, vercel-react-best-practices, web-design-guidelines, shadcn) | new `src/frontend/components/{switcher-popover,action-menu,confirm-popover,docked-panel,segmented}.tsx`, new `src/frontend/views/*`, new `src/frontend/state/workbench.ts`, `src/frontend/app/Workbench.tsx`, `src/frontend/keyboard/shortcuts.ts`, `src/frontend/index.css`, `tests/contracts/workbench-views.test.tsx`, `tests/contracts/shortcuts-004.test.ts` | P5 base: views, shared parts, tokens, keys, and the mount points for WP12 to WP14 and WP21 to WP25. |
| WP12 | frontend-implementer | new `src/frontend/branches/*`, `src/frontend/refs/ReferencesSidebar.tsx`, `tests/contracts/workbench-branches.test.tsx` | P5: branch button, list, switch confirmation, branch menu, create, rename, delete. |
| WP13 | frontend-implementer | new `src/frontend/integrate/*`, `tests/contracts/workbench-integrate.test.tsx` | P5: merge and rebase panels. |
| WP14 | frontend-implementer | `src/frontend/changes/*`, `src/frontend/commit/*`, `tests/contracts/workbench-commit.test.tsx` | P5: commit view, virtual tree, multi-select, line selection, ignore items, message guide. |
| WP15 | implementer-xhigh | new `src/git-service/worktrees.ts`, `tests/git/worktrees.test.ts` | P6: US5 |
| WP16 | implementer | new `src/git-service/git-settings.ts`, `tests/git/git-settings.test.ts` | P6: US6 |
| WP17 | implementer-xhigh | `src-tauri/src/{dialogs,settings,service}.rs`, `src/contracts/channel.ts`, `src/git-service/trust.ts` (version 2 binding), `tests/git/trust-v2.test.ts` | P6 and P7: US7. Local only. |
| WP18 | implementer-xhigh | `src/git-service/{submodule-review,submodule-update}.ts`, `tests/git/submodule-scope.test.ts` | P6: US8 |
| WP19 | implementer-xhigh | new `src/git-service/resolve.ts`, `tests/git/resolve.test.ts` | P6: US9 |
| WP20 | implementer | `src/git-service/session.ts`, `src/git-service/trust.ts` (class `mergetool`), `src/git-service/{commit-review,commit}.ts` (amend), `tests/git/commit-amend.test.ts` | P6 wiring and the US11 service part. After WP15 to WP19. |
| WP21 | frontend-implementer | new `src/frontend/worktrees/*`, tests | P8: US5 |
| WP22 | frontend-implementer | new `src/frontend/settings/git/*`, `src/frontend/settings/SettingsView.tsx`, tests | P8: US6 |
| WP23 | frontend-implementer | new `src/frontend/trust/TrustChip.tsx`, remove `src/frontend/trust/TrustDialog.tsx`, `src/frontend/app/RepositoryMenu.tsx`, tests | P8: US7 |
| WP24 | frontend-implementer | `src/frontend/submodules/*`, tests | P8: US8 |
| WP25 | frontend-implementer | new `src/frontend/resolve/*`, tests | P8: US9 |
| WP29 | frontend-implementer | `src/frontend/commit/*` (Amend last commit), `tests/contracts/workbench-amend.test.tsx` | P8: US11. After WP14 and WP20. |
| WP26 | frontend-implementer | new `src/frontend/commit/spelling.ts`, `package.json`, `bun.lock`, the notices inventory, tests | P10: US10 |
| WP27 | implementer; runs by scout, alone | `tests/wsl/workbench-wsl.test.ts` | P9 WSL |
| WP28 | implementer; runs by scout | `tests/windows/{workbench-packaged,workbench-perf}.test.ts` | P9 packaged |

Parallel tracks use disjoint files. These packages are not file-disjoint:
- `src/git-service/session.ts` and `trust.ts`: only WP10 and WP20 edit them in 004 batches 2 and 4. WP17 edits `trust.ts` for the binding before WP20.
- `src/frontend/app/Workbench.tsx`: WP11 owns it. WP12 to WP14 and WP21 to WP25 fill the mount points that WP11 creates.
- `src/frontend/refs/ReferencesSidebar.tsx`: WP12, then WP21 and WP24 add their groups through WP11 mount points.
- `tests/groups.json`: every WP appends its lines. The orchestrator resolves merge conflicts.
- Rust: WP6 and WP17 run one at a time, locally.

Dependencies on feature 003 (branch `f003-spec`, not merged into main):
- 003 Δ3 `reviewSync` and `sync` with actions `abort`, `continue`, and `skip`; 003 Δ4 `applyFile` direction `resolve` (Mark resolved); 003 D7. US3 and US9 need them.
- 003 policy `integrate` and its kind fit (003 Δ6, Δ7). Every 004 mutation needs them.
- 003 trust class `sync` and `SYNC_EVENTS` (003 D11). D12 extends that code.
- 003 `readTracking` (003 Δ3) for the ahead and behind counts in the branch button and list (spec FR-007, FR-008).
- 003 push destination rule (003 D4) for the D6 force note.
- 003 Pull split button and `defaultPullAction` (003 FR-055, FR-056, Δ3 `setDefaultPullAction`) for the Settings page "Pull and push" (spec FR-066).
- 003 `destinationFacts` (003 Δ6) for the worktree add path check.
- 003 conflict notice (003 FR-030) in `app/NoticeBand.tsx`.
- 003 `settings/SettingsDialog.tsx` content for the Settings view (O-7).
- Batch 2 of 004 starts only after 003 batches 2 and 3 (WP6 to WP8 of 003) are merged. Batch 3 of 004 starts only after 003 WP10 and WP11 are merged.

## Agent context

Spec Kit v1.0.12 in this repository has no `update-agent-context` script, so this step changes no file. The plan adds no technology that CLAUDE.md must name. A CLAUDE.md change goes through `claude-md-management:claude-md-improver`.

## Complexity Tracking

No Constitution Check violation. The table stays empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
