---

description: "Task list for the History Commit Menu feature"
---

# Tasks: History Commit Menu

**Input**: Design documents from `specs/010-commit-menu/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/operations.md, quickstart.md, and checklists/requirements.md.

**Tests**: The spec (SC-001 to SC-012) and plan.md D14 require tests. A failing-test task comes before each implementation task, and the implementation task depends on it. Each test task names one control mutation that must turn its tests red. No test passes by default.

**Organization**: Phase 1 holds the spec artifacts and the probe rerun (WP-S). Phase 2 holds the mockup (WP1). Phase 3 holds the contracts and the shell (WP2, WP3). Phases 4 and 5 hold the service and the frontend (WP4, WP5). Phase 6 holds WSL (WP6). Phase 7 holds the packaged qualification (WP7, WP7r). Phase 8 holds the final review. Phase 9 holds the doc pass (WP8). Every task is "Before v0.1.0" (user decision, 2026-11-04).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: The task touches different files from the other `[P]` tasks of its phase. It depends on no incomplete task of that phase. "Depends on" names the exact order.
- **[Story]**: The user story of spec.md (US1 to US5).
- **WP and agent**: Each task names its plan.md work package and its agent.
- **Requirements**: Each task names the spec FR and SC IDs that it proves or builds.
- **Local tags**: `Local: Rust` needs the local Rust toolchain. `Local: package` needs the packaged Windows build on the reference host. `Local: WSL` needs `Ubuntu-26.04` with Git 2.55 and runs alone on the host. Cloud sessions do not run these tasks. A skip never counts as a pass.
- **Earlier specs**: The 001 to 008 texts stay unchanged until T020 (plan.md D12). No other task edits them.
- **Portability**: Shared TypeScript code and the generic test harness hold no Win32 FFI. Windows-only behavior stays in `src-tauri/src/` and `tests/windows/`.
- **Probe and mockup gate**: Every code task (T003 to T019, T023) depends on T001 and T002. T001 proves the probe facts. T002 ends with the user's approval of the mockup.

## Harness and tick rules

- The 001 "Test harness rules" stay in force (`specs/001-desktop-qualification/tasks.md`). They cover `printOrigin`, one control mutation per test task, Git through `tests/git/git-binary.ts`, and capability skips. They also cover `tests/groups.json`, `OBSERVATION` lines, owned fixture roots, and the source headers.
- A green run proves nothing until it prints `ORIGIN` lines that name the checkout under test. The control mutation of the task must turn the same run red.
- Every Git test uses an owned `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM=1`. No test touches a real repository, the user's configuration, or a real distro user's files.
- Oracles (plan.md D14): Git's own command on a copy of the fixture. Tests compare HEAD, `for-each-ref`, `ls-files --stage -z`, and working bytes by SHA-256.
- A test that asserts a refusal asserts its code and reason, never a message text (spec SC-012).
- Each new test file in `tests/contracts`, `tests/git`, or `tests/wsl` adds its line to `tests/groups.json` in the same task. `tests/windows` files are not in `tests/groups.json`.
- App runs set `ARBARETO_PROFILE_ROOT` to a scratch folder.
- Packaged and perf runs run in the foreground, alone, under the test gate rules of the 001 harness.
- A task is ticked only after a green Windows run that verifies it, with `ORIGIN` lines. A `tests/windows` task needs a green `bun run test:windows` on the reference host.
- Verification steps use only the README "Development" commands.

## Batch-to-work-package mapping

| Batch | Phases | Tasks | Stories | Work packages (agent) |
| --- | --- | --- | --- | --- |
| 0. Spec, facts, mockup | 1, 2 | T001, T002 | Foundational | WP-S (implementer writes the artifacts; scout runs T001), then WP1 (frontend-implementer, no code). |
| 1. Contracts, shell, service | 3, 4 | T003 to T011, T023 | US1 to US4 | WP2 (implementer-xhigh), then WP3 (implementer-xhigh, local Rust) and WP4 (implementer-xhigh). |
| 2. Frontend | 5 | T012 to T015 | US1 to US4 | WP5 (frontend-implementer), beside WP4 in its own worktree. |
| 3. WSL and qualification | 6, 7, 8 | T016 to T019, T022 | US5, cross-cutting | WP6 (implementer-xhigh, WSL alone), WP7 (implementer, local package), WP7r (scout), then the review (reviewer). |
| 4. Docs | 9 | T020, T021 | Cross-cutting | WP8 (implementer), after the merges of `main-tree-marks-perf` and `main-tree-render-perf`; then the orchestrator. |

---

## Phase 1: Setup — spec artifacts and facts (WP-S) — batch 0

**Agent**: implementer writes the artifacts of `specs/010-commit-menu/`. scout runs T001. The orchestrator runs `/speckit-analyze` on the artifacts before T002 starts.

**Purpose**: Prove the probe facts of research.md R2 on the installed Git before any design depends on them.

- [x] T001 Run the probe scripts `probe.sh`, `probe2.sh`, and `probe3.sh` again in a new local scratch folder (research.md R1). Set the scripts' base folder to that new folder first. Add one script line for P15 (`diff-index --cached -R -z --no-renames --name-status <target> --` on the P4b repository). Record every probe P1 to P15, with P6b and P14, in research.md R7 "Probe rerun (T001)". Add the Git version and the date. A result that differs from research.md R2 is a finding: change research.md, plan.md, and contracts/operations.md first, then run `/speckit-analyze`. Control: P8 with `tag.gpgSign=false` must create the lightweight ref, so the probe can show a difference. No repo code. Requirements: FR-001, FR-031, FR-032, FR-043, FR-062. Agent: scout. Before v0.1.0. Depends on nothing. Done on 2026-11-04 with Git 2.56.0.windows.2. `probe4.sh` added P15 and P16. No fact differs from research.md R2 (research.md R7 "Probe rerun (T001)").

---

## Phase 2: Mockup (WP1) — batch 0

**Agent**: frontend-implementer, through the arbareto-ux skill flow. No repo files.

**Purpose**: The user approves the layout before any code exists.

- [x] T002 Build the static HTML mockup through the arbareto-ux skill, with sample data marked as sample. Build the boards of plan.md D10. Use the plan.md D11 texts exactly. The user approved the mockup on 2026-11-04 with the orchestrator defaults: [canvas](https://claude.ai/artifact/7s2QiFoeBkVbwsnNHqfTLQ). Plan.md "Mockup" and "Open items" record the decisions. Pick the icons from the free hugeicons set. The orchestrator shows the mockup to the user. Record the approval, the artifact link, and the board names in the plan.md "Mockup" line. Put every changed text into plan.md D11 first, then run `/speckit-analyze`. No code, so no control mutation; the user's approval is the gate. Requirements: FR-010 to FR-015, FR-030, FR-040, FR-042, FR-044, FR-050, FR-060. Agent: frontend-implementer. Before v0.1.0. Depends on T001.

**Checkpoint**: the user approved the mockup on 2026-11-04. The code tasks start after T001 ends.

---

## Phase 3: Foundational — contracts (WP2) and shell (WP3) — batch 1

**Agent**: WP2 implementer-xhigh; WP3 implementer-xhigh (`Local: Rust`).

**Purpose**: The four actions, phases, payloads, plans, run results, reasons, and the tag-name rule. No story starts before T004 ends.

- [x] T003 Write failing contract tests for contract Δ1 to Δ10 (data-model §3, §4, §6). Files: `tests/contracts/commit-actions-contract.test.ts`, `tests/vectors/valid/commit-*.json`, and `tests/vectors/invalid/commit-*.json`. Cover the four payloads, plans, run results, and phases. Cover the widened `SyncPlan.operationState`, the new workbench reasons, and the new sync reasons. The invalid vectors hold a mode outside the enum and a mainline of 0 and of 65. They also hold a tag name with NUL and a message above 8 KiB. Write failing tests in `tests/contracts/tag-name.test.ts` for `tagNameRefusal`. Cover empty, a leading `-`, `HEAD`, `@`, and a control character. Cover the valid names of research.md R2 P9. Add both files to `tests/groups.json` `parallel`. Cover the sync phases `sync-cherry-pick` and `sync-revert`, and a `create-tag` review with `name: null`. Control, run after T004: remove `"hard"` from the reset mode enum; a valid vector must fail. Requirements: FR-002, FR-003, FR-031, FR-033, FR-040, FR-050, SC-012. Agent: implementer-xhigh. Before v0.1.0. Depends on T001 and T002.
- [x] T004 Implement contract Δ1 to Δ10 in `src/contracts/channel.ts`, `envelope.ts`, `errors.ts`, `operations.ts`, and the new `tag-name.ts`. Run `bun run export:schemas`. Verify with `bun run export:schemas --check`, `bun run typecheck`, and `bun run test:contracts`. Requirements: FR-002, FR-003, FR-031, FR-033. Agent: implementer-xhigh. Before v0.1.0. Depends on T003.
- [x] T005 Write failing cargo tests first. `schema.rs`: the four started actions, the four phases, and the two sync phases. `close.rs`: the four `CLOSE_*` names of plan.md D11. `dialogs.rs`: the four `TRUST_*` sentences. Then implement plan.md D7 in `src-tauri/src/close.rs`, `dialogs.rs`, and `schema.rs`. Verify with `cargo test --locked --manifest-path src-tauri/Cargo.toml`. Control: drop the "Revert commit" close name; its test must fail. `Local: Rust`. Requirements: FR-002, FR-004. Agent: implementer-xhigh. Before v0.1.0. Depends on T004.

---

## Phase 4: Service actions (WP4) — batch 1

**Agent**: implementer-xhigh.

**Goal**: US2 to US4 and the detached checkout in the service.

**Independent Test**: spec.md User Stories 2 to 4 "Independent Test".

- [x] T006 [P] Write failing argument tests in `tests/contracts/workbench-commands.test.ts` for the new builders (plan.md D3 to D6). Cover reset per mode, the lightweight and the annotated tag, and cherry-pick and revert with and without `-m`. Cover `diff-index --cached -R`, the reflog-only count, `merge-base --is-ancestor`, and `rev-list --parents -n 1`. Cover the index match `diff-index --cached --quiet` and the abort and continue arguments of both kinds. Each array starts with `--no-lazy-fetch`. Control: drop `--no-recurse-submodules` from the reset arguments; the reset case must fail. Requirements: FR-008, FR-045, FR-052, FR-061. Agent: implementer-xhigh. Before v0.1.0. Depends on T004.
- [x] T007 [P] [US3] Write failing real-repository tests in `tests/git/reset.test.ts`. Cover the plan.md D4 effects per mode against `git reset --<mode>` on a copy (SC-001). Fixtures: 2 commits back, a target outside the branch history, a staged new file (P4d, P4e), and unstaged edits. Each count equals `rev-list --count`. Cover the force note, and these refusals: detached, unborn, `CONFLICTED`, an operation in progress, and `UNKNOWN_TARGET`. Cover `UNTRACKED_IN_WAY` with research.md R2 P4, P4b, and a folder case, where every byte stays (SC-002). Cover the ignored count (P4c) and `STALE_REVIEW` after a new untracked file in the way. Cover the 60 s expiry through the `now` seam, Cancel, and a killed process with `index.lock`. Cover hooks only after approval, with the event set of research.md R2 P3 (SC-007). Add the file to `tests/groups.json` `parallel`. Cover each mode with the target at the branch tip, on a clean and a dirty tree. Cover 101 paths in the way. The refusal lists 100 paths, and `more` is 1. Cover more than `DISCARD_CHECK_PATHS` candidates. Hard refuses with `limit`, and every byte stays. Compare the owned configuration bytes before and after each run (FR-005). Control: build the Hard candidates from `diff-tree HEAD <target>`; the P4b case must fail. Requirements: FR-002, FR-003, FR-004, FR-005, FR-007, FR-008, FR-040 to FR-046, SC-001, SC-002, SC-007. Agent: implementer-xhigh. Before v0.1.0. Depends on T004.
- [x] T008 [P] [US2] Write failing tests in `tests/git/create-tag.test.ts` against `git tag` on a copy (SC-004). Fixtures: lightweight, annotated, and `tag.gpgSign=true` for both kinds with a failing `gpg.program`. More fixtures: `tag.forceSignAnnotated=true`, an existing name, a value that is no boolean, and a message above 8 KiB. The invalid names come from research.md R2 P9 (`a..b`, `x.lock`, `a b`, empty, `-x`, `HEAD`, `@`). Each refusal changes no ref. The hook event set of research.md R2 P3c runs only after approval (SC-007). Add the file to `tests/groups.json` `parallel`. Cover the open review with `name: null`: the plan comes back with no token, and no ref changes. Cover `UNKNOWN_TARGET` for a missing target. Cover `STALE_REVIEW` after an external tag write, the 60 s expiry, and Cancel. Compare the owned configuration bytes before and after each run (FR-005). Cover the open review with `tag.gpgSign=true` and with `tag.forceSignAnnotated=true`. The plan holds both facts, and no refusal comes back. Cover a `reference-transaction` hook that writes another ref and exits 1 in the `prepared` state (research.md R2 P16). Git creates no tag, and the outcome is `failed-with-effects`. Control: return a token for `name: null`; the open-review case must fail. Requirements: FR-005, FR-031 to FR-034, SC-004, SC-007. Agent: implementer-xhigh. Before v0.1.0. Depends on T004.
- [x] T009 [P] [US4] Write failing tests in `tests/git/cherry-pick-revert.test.ts` against Git's own command on a copy (SC-003). Fixtures: a clean pick and revert, a conflict, and a merge with `-m 1` and `-m 2`. Also a merge without a mainline (`mainline-needed`). More fixtures: `not-merge`, a root commit (research.md R2 P5, P12), an empty stop (P6), and a signing failure (P11). The last fixtures are `already-on-branch` and `dirty-tree` for each P10 case. Cover the outcome mapping of data-model §4 and the output tail as plain text. The hook event set of research.md R2 P2 runs only after approval (SC-007). Add the file to `tests/groups.json` `parallel`. Cover the FR-051 refusals `detached`, `unborn`, and `CONFLICTED`, and `limit` for more than 64 parents. Cover `UNKNOWN_TARGET` for a missing commit. Cover `STALE_REVIEW` after an external commit, Cancel, and a killed process with `index.lock`. Cover a post-commit hook that edits a tracked file. The outcome is `failed-with-effects`. Compare the owned configuration bytes before and after each run (FR-005). Control: drop the `-m` item; the merge case must fail. Requirements: FR-001, FR-005, FR-006, FR-050 to FR-053, SC-003, SC-007. Agent: implementer-xhigh. Before v0.1.0. Depends on T004.
- [x] T010 [P] [US4] Extend `tests/git/sync-conflicts.test.ts` with the plan.md D6 service cases (SC-006). The oracle is `git cherry-pick --abort` and `--continue`, and the revert forms, on a copy. Cover Abort and Continue for both kinds, the Skip refusal `not-rebasing`, and `nothing-to-commit` (research.md R2 P6, P13). Cover `sequence` with a `.git/sequencer` folder, `CONFLICTED` on Continue, and Mark resolved in both states. Cover the pre-commit hook of Continue under the `sync` approval (research.md R2 P1, P2c). Cover `STALE_REVIEW` after an external `git add`, and a killed Continue with `index.lock`. Cover the phases `sync-cherry-pick` and `sync-revert` of Abort. Control: map `cherry-picking` to `merge`; the Abort case must fail. Requirements: FR-004, FR-060 to FR-063, SC-006, SC-007. Agent: implementer-xhigh. Before v0.1.0. Depends on T004.
- [x] T023 [P] [US1] Write the detached checkout tests in `tests/git/switch.test.ts` for the commit-menu payload `{ detach: <oid> }` (plan.md D2). Fixtures: a clean tree, Keep, Stash, Discard, an unreachable-commit note, and an untracked file in the way. Each result equals the 004 SC-001 oracle on a copy (SC-005). The hook event set of research.md R2 P3b runs only after approval. Control: send a branch target in place of `detach`; the detached-HEAD assertion must fail. Requirements: FR-020, SC-005, SC-007. Agent: implementer-xhigh. Before v0.1.0. Depends on T004.
- [x] T011 Implement plan.md D3 to D5, D13 "Service module", and the service part of D6. Files: `src/git-service/commit-actions.ts`, `workbench-commands.ts`, `switch.ts`, `merge-rebase.ts`, and `sync-commands.ts`. More files: `sync-review.ts`, `sync-integrate.ts`, `status.ts`, and `session.ts`. T006 to T010 and T023 pass. `tests/git/switch.test.ts` and `tests/git/merge-rebase.test.ts` stay green. Verify with `bun run typecheck`, `bun run test:contracts`, and `bun run test:git`. Then the batch 1 review (reviewer, with safety scrutiny of the Hard path), then `/speckit-converge`. Requirements: FR-001 to FR-008, FR-031 to FR-034, FR-040 to FR-046, FR-050 to FR-053, FR-061, FR-062. Agent: implementer-xhigh. Before v0.1.0. Depends on T006 to T010, T023.

---

## Phase 5: Frontend (WP5) — batch 2

**Agent**: frontend-implementer. It loads `vercel-react-best-practices` and `web-design-guidelines`, and the arbareto-ux skill. WP5 can run beside WP4 in its own worktree.

**Goal**: US1 to US4 in the renderer.

**Independent Test**: spec.md User Story 1 "Independent Test" and the acceptance scenarios of User Stories 2 to 4.

- [x] T012 [P] [US1] Write failing tests in `tests/contracts/commit-menu.test.tsx` for plan.md D1. Cover the right-click selection and dock, the chip branch menu, and Shift+F10 and the Menu key with no active label. Cover Left and Right on labels with the `COMMIT_ANNOUNCE` live text, and no menu on the four non-commit rows. Cover the groups and order, Ctrl+B for Create branch here, and Copy commit ID with the full object ID. Cover every availability row with its reason, and the focus return to the list. Update `tests/contracts/workbench-branches.test.tsx:461-558` to the amended label rule (plan.md R3). Add the new file to `tests/groups.json` `parallel`. Control: let Shift+F10 open label 0 again; the new cases must fail. Requirements: FR-010 to FR-015, FR-021, FR-022, SC-009. Agent: frontend-implementer. Before v0.1.0. Depends on T001, T002, and T004.
- [x] T013 [P] [US2] [US3] [US4] Write failing tests in `tests/contracts/commit-actions.test.tsx`. Cover the Check out confirmation with the detach note, Cancel as the first focus, and `CHECKOUT_DISCARD_BUTTON` for Discard. Cover the Tag popover with Lightweight tag preselected and the `TAG_KIND` legend. Cover the review on open and again on Create tag. From the open-review plan, cover `TAG_SIGNS` after a switch to Annotated tag, and `tag-signing` on Lightweight tag. A switch back to Lightweight tag clears the message. An empty name keeps Create tag unavailable. A typed message selects Annotated tag. A blank annotated message blocks the button. The signing line and each tag refusal show. Cover the Reset popover with Mixed preselected and a new review on a mode change. Cover the counts, the notes, and the in-the-way refusal in both tail forms. Cover the Hard dialog with Cancel focused first and no default button. Enter on Cancel and Escape change nothing. Cover the ignored count and the no-undo line. Cover the Cherry-pick and Revert popovers with parent 1 preselected on a merge, and the Amend last commit note. Cover the outcome texts, the expiry text, the output tail as plain text, and Cancel. Add the file to `tests/groups.json` `parallel`. Control: preselect Soft; the Mixed case must fail. Requirements: FR-003, FR-006, FR-007, FR-014, FR-020, FR-030, FR-032, FR-034, FR-040, FR-042 to FR-044, FR-050, FR-052, FR-053, SC-009. Agent: frontend-implementer. Before v0.1.0. Depends on T001, T002, and T004.
- [x] T014 [P] [US4] Extend `tests/contracts/sync-conflicts.test.tsx` for the plan.md D6 frontend. Cover the band row in `cherry-picking` and `reverting`, and the abort labels and confirmations with `ABORT_PICK_BUTTON` and `ABORT_REVERT_BUTTON`. Continue shows after the last Mark resolved. Cover Resolve conflicts in place of Continue while files are unmerged, and no Skip. Cover the `nothing-to-commit` and `sequence` texts, Mark resolved staying available, Amend blocked, and the trust ask kind. Control: remove `cherry-picking` from `ACTIONS_IN_APP`; the band case must fail. Requirements: FR-060 to FR-063. Agent: frontend-implementer. Before v0.1.0. Depends on T001, T002, and T004.
- [ ] T015 Implement plan.md D1, D2, D13 "Menu", "Actions hook", and "Hard dialog", and the frontend part of D6. Files: `src/frontend/history/HistoryList.tsx`, the new `CommitActions.tsx` and `commit-texts.ts`, and `src/frontend/branches/BranchActions.tsx` and `texts.ts`. More files: `src/frontend/changes/RevertConfirm.tsx` and `HunkControls.tsx`, and `src/frontend/sync/ConflictActions.tsx` and `useSync.ts`. The last files: `src/frontend/app/NoticeBand.tsx` and `Workbench.tsx`, `src/frontend/commit/CommitTray.tsx`, `src/frontend/trust/ask.ts`, and `src/frontend/status/OperationStatus.tsx`. T012 to T014 pass, and the 008 `RevertConfirm` tests stay green. Compare the result with the T002 boards in `bun run dev` with `ARBARETO_PROFILE_ROOT` in a scratch folder. Verify with `bun run typecheck` and `bun run test:contracts`. Then the batch 2 review (reviewer, with `web-design-guidelines`), then `/speckit-converge`. Requirements: FR-010 to FR-015, FR-020 to FR-022, FR-030, FR-040, FR-044, FR-050, FR-060, FR-063. Agent: frontend-implementer. Before v0.1.0. Depends on T011, T012 to T014.

---

## Phase 6: User Story 5 — WSL repositories (WP6) — batch 3

**Agent**: implementer-xhigh. `Local: WSL`, alone on the host.

**Goal**: The same actions in a WSL repository.

**Independent Test**: spec.md User Story 5 "Independent Test".

- [x] T016 [US5] Write `tests/wsl/commit-actions-wsl.test.ts` on `tests/wsl/workbench-wsl-harness.ts` (plan.md D8) in `Ubuntu-26.04`. Fixtures: each reset mode on a copy in the distro, and Hard with a Linux untracked file in the way. More fixtures: a lightweight and an annotated tag, a clean cherry-pick, and a conflict with Mark resolved and Continue. The last fixtures: an Abort, a clean revert, a merge revert with `-m 1`, and a detached checkout. The mode bits, the owner, and the link count of each written file stay (SC-008). The sequencer marker read uses the WSL-aware marker facts (research.md R5 U1). Add the file to `tests/groups.json` `serial` with the reason "WSL commit actions in the distro". Add a `.git/sequencer` fixture in the distro. Abort and Continue refuse with `sequence`. Control: send `mixed` for the Hard case; the byte comparison must fail. `Local: WSL`, alone. Requirements: FR-070, SC-008. Agent: implementer-xhigh. Before v0.1.0. Depends on T011. Done on 2026-11-05 in `Ubuntu-26.04` with Git 2.55.0: 7 cases pass. The control turns the Hard byte comparison red. Abort and Continue refuse with `SYNC_UNAVAILABLE` reason `sequence`.

---

## Phase 7: Packaged qualification (WP7, WP7r) — batch 3

**Agent**: WP7 implementer writes; WP7r scout runs. `Local: package`.

- [x] T017 [P] Write `tests/windows/commit-menu-packaged.test.ts` through UI Automation and CDP. Cover the UIA names of the menu and its items, and the right-click and Shift+F10 paths. Cover a menu inside the window beside a full-width row (research.md R5 U2). Cover the Hard dialog Cancel focus through UIA `HasKeyboardFocus` (the 008 T047 method). Cover forced colors, both themes, 150% and 225% text, and real Git results for one action of each story. Cover the Check out confirmation Cancel focus through UIA `HasKeyboardFocus`. Control: let `AlertConfirm` focus the danger button first; the Cancel focus case must fail. `Local: package`. Requirements: FR-010, FR-014, FR-044, SC-009. Agent: implementer. Before v0.1.0. Depends on T005, T015.
- [ ] T018 [P] Add the fixture M-R to `tests/windows/perf-fixtures.ts` (plan.md D9). Check that fixtures L and M have the shape of D9 (research.md R5 U3). Write `tests/windows/commit-menu-perf.test.ts` with the fixed samples of plan.md D9. SC-010a: 40 opens per run on L (20 right-click, 20 Shift+F10, distinct rows). SC-010b: 10 warm runs and 1 warm-up run per action on M. SC-010c: 10 + 1 Hard reviews on M-R. SC-010d: 10 + 1 runs per action on M and M-R. SC-011: at least 20 history-filter inputs during each SC-010d run. Record CPU seconds and process-tree private bytes per run, with no budget. The warm-up run counts for the every-run bound, never for the median. Measure one cold run per SC-010 measure after a new app start. Each cold run has a budget of 2 times its warm budget. Control: lower the SC-010a every-open bound to 1 ms in a scratch copy of the test; the run must fail. `Local: package`. Requirements: FR-080, SC-010a, SC-010b, SC-010c, SC-010d, SC-011. Agent: implementer. Before v0.1.0. Depends on T005, T015.
- [ ] T019 Run T017 and T018 on the packaged build, in the foreground, alone, under the test gate rules. Run the WSL times of SC-010b and SC-010d (10 + 1 runs on `Ubuntu-26.04`) as a record. Record the build identity, the OS version, each result, and the records in research.md R7 "Packaged and perf runs (T019)". A failed budget is a finding for `/speckit-converge`. Control: the run prints `ORIGIN` lines of the installed build, and the T017 control turns it red once. `Local: package`. Requirements: SC-009, SC-010a to SC-010d, SC-011. Agent: scout. Before v0.1.0. Depends on T016, T017, T018.

---

## Phase 8: Final review — batch 3

**Agent**: reviewer.

- [ ] T022 Final review of the whole feature by the reviewer. Scrutinize the safety of Reset Hard, the in-the-way check, and the stop finishing. Write the requirement-to-test map into research.md R7 "Requirement-to-test map (T022)". Every FR and SC maps to a test. No outcome comes from message text, timing, retry counts, or a name pattern (SC-012). Then `/speckit-converge`. Control: remove one FR from the draft map; the coverage check must name the missing FR. Requirements: FR-001, SC-012. Agent: reviewer. Before v0.1.0. Depends on T019.

---

## Phase 9: Docs (WP8) — batch 4

**Agent**: implementer, then the orchestrator.

- [ ] T020 Wait until the branches `main-tree-marks-perf` and `main-tree-render-perf` merge into `main`. Both change `specs/004-workbench-ux/plan.md` and `tasks.md`. Then apply the amendments of plan.md D12 in the style "Note (2026-11-04, user decision): …". Files: `specs/001-desktop-qualification/spec.md`, `specs/003-remote-sync/spec.md`, and `specs/004-workbench-ux/spec.md` and `plan.md`. More files: `specs/007-first-release/spec.md` and `plan.md`, and `specs/008-discard-changes/spec.md`. The 007 files are not on `main` at `f0d79499`; amend them where 007 lives at that time. Add the user-visible changes to README "Features" and to the CHANGELOG 0.1.0 section. No code. Control: none, because the task changes docs only; T021 checks it. Requirements: spec "Changes to earlier requirements". Agent: implementer, with the orchestrator as reviewer. Before v0.1.0. Depends on T022 and the merges of `main-tree-marks-perf` and `main-tree-render-perf`.
- [ ] T021 Run `/speckit-analyze` on the final artifacts and fix every CRITICAL and HIGH finding. Then run `/speckit-converge`. Agent: implementer, with the orchestrator as reviewer. Before v0.1.0. Depends on T020.

---

## Dependencies & Execution Order

### Phase dependencies

- Phase 1 (T001) has no dependency. The orchestrator runs `/speckit-analyze` on these artifacts first.
- Phase 2 (T002) ended before T001, with the user's approval. T001 and T002 gate every code task.
- Phase 3: T003 depends on T001 and T002. T004 depends on T003. T005 depends on T004 (plan.md R6).
- Phase 4: T006 to T010 and T023 start after T004, in parallel. T011 waits for all six.
- Phase 5: T012 to T014 start after T001, T002, and T004, in parallel with Phase 4. T015 waits for T011 and T012 to T014.
- Phase 6: T016 waits for T011. It runs alone on the host.
- Phase 7: T017 and T018 wait for T005 and T015. T019 waits for T016 to T018.
- Phase 8: T022 waits for T019.
- Phase 9: T020 waits for T022 and the two merges. T021 waits for T020.

### Story dependencies

- US1 needs T012, T015, and T023. US2 needs T008, T011, T013, and T015. US3 needs T007, T011, T013, and T015. US4 needs T009, T010, T011, T013 to T015. US5 needs T016.

### Within each story

- The failing-test task comes first. The service task follows. The frontend task follows the service task.

## Parallel Example

```text
Batch 0:  T001 → T002 (user approval).
Batch 1:  T003 → T004 → T005 (local Rust), and T006, T007, T008, T009, T010, T023 in parallel → T011.
Batch 2:  T012, T013, T014 in parallel after T004 (own worktree) → T015 after T011.
Batch 3:  T016 (WSL alone); T017 and T018 in parallel → T019 (alone) → T022.
Batch 4:  after the two merges: T020 → T021.
```

## Implementation Strategy

- MVP: Phases 1 to 5 give US1 to US4 on Windows. The v0.1.0 package needs every phase, because the user named all items for it (spec Clarifications).
- Deliver in batch order. Each batch ends green, reviewed, and converged before the next batch starts.
- Stop at each checkpoint and run the story's Independent Test.

## Notes

- `[P]` tasks touch different files and have no open dependency in their phase.
- The orchestrator commits after each task or logical group.
- A probe finding changes research.md, plan.md, and contracts/operations.md first, then the dependent task.
- Task IDs follow the design plan. This spec adds T022 and T023. T022 is the final review with the SC-012 map. T023 holds the SC-005 detached checkout tests.
