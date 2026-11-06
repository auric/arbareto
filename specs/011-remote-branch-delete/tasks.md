---

description: "Task list for the Remote Branch Delete feature"
---

# Tasks: Remote Branch Delete

**Input**: Design documents from `specs/011-remote-branch-delete/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/operations.md, quickstart.md, and checklists/requirements.md.

**Tests**: The spec (SC-001 to SC-011) and plan.md D16 require tests. A failing-test task comes before each implementation task, and the implementation task depends on it. Each test task names one control mutation that must turn its tests red. No test passes by default.

**Organization**: Phase 1 holds the probe rerun (WP-F). Phase 2 holds the mockup (WP1). Phase 3 holds the contracts and the shell (WP2, WP3). Phases 4 and 5 hold the service and the frontend (WP4, WP5). Phase 6 holds WSL (WP6). Phase 7 holds the packaged qualification (WP7, WP7r). Phase 8 holds the final review. Phase 9 holds the doc pass (WP8). Every task is "Before v0.1.0" (user decision, 2026-11-06).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: The task touches different files from the other `[P]` tasks of its phase. It depends on no incomplete task of that phase. "Depends on" names the exact order.
- **[Story]**: The user story of spec.md (US1 to US4).
- **WP and agent**: Each task names its plan.md work package and its agent.
- **Requirements**: Each task names the spec FR and SC IDs that it proves or builds.
- **Local tags**: `Local: Rust` needs the local Rust toolchain. `Local: package` needs the packaged Windows build on the reference host. `Local: WSL` needs `Ubuntu-26.04` with Git 2.55 and runs alone on the host. Cloud sessions do not run these tasks. A skip never counts as a pass.
- **Earlier specs**: The 001 to 010 texts stay unchanged until T023 (plan.md D14). No other task edits them.
- **Portability**: Shared TypeScript code and the generic test harness hold no Win32 FFI. Windows-only behavior stays in `src-tauri/src/` and `tests/windows/`.
- **Code gate**: Every code task (T003 to T020) waits for two things. The user approves the mockup (T002). Feature 010 merges into `main`, because both features change the same files (plan.md R7). Each code task starts on `main` after that merge.

## Harness and tick rules

- The 001 "Test harness rules" stay in force (`specs/001-desktop-qualification/tasks.md`). They cover `printOrigin`, one control mutation per test task, Git through `tests/git/git-binary.ts`, and capability skips. They also cover `tests/groups.json`, `OBSERVATION` lines, owned fixture roots, and the source headers.
- A green run proves nothing until it prints `ORIGIN` lines that name the checkout under test. The control mutation of the task must turn the same run red.
- Every Git test uses an owned `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM=1`. No test touches a real repository, a real remote, the user's configuration, or a real distro user's files. Every remote is a local bare repository over a file path.
- Oracles (plan.md D16): the same Git commands on a copy of the fixture. Tests compare `for-each-ref` of the local repository and the bare remote, HEAD, and the config bytes by SHA-256.
- A test that asserts a refusal asserts its code and reason, never a message text (spec SC-011).
- Each new test file in `tests/contracts`, `tests/git`, or `tests/wsl` adds its line to `tests/groups.json` in the same task. `tests/windows` files are not in `tests/groups.json`.
- App runs set `ARBARETO_PROFILE_ROOT` to a scratch folder.
- Packaged and perf runs run in the foreground, alone, under the test gate rules of the 001 harness.
- A task is ticked only after a green Windows run that verifies it, with `ORIGIN` lines. A `tests/windows` task needs a green `bun run test:windows` on the reference host.
- Verification steps use only the README "Development" commands.

## Batch-to-work-package mapping

| Batch | Phases | Tasks | Stories | Work packages (agent) |
| --- | --- | --- | --- | --- |
| 0. Spec, facts, mockup | 1, 2 | T001, T002 | Foundational | WP-S (implementer wrote these artifacts), WP-F (scout), then WP1 (frontend-implementer, no code). |
| 1. Contracts, shell, service | 3, 4 | T003 to T014 | US1 to US3 | WP2 (implementer-xhigh), then WP3 (implementer-xhigh, local Rust) and WP4 (implementer-xhigh). Starts after the T002 approval and the 010 merge. |
| 2. Frontend | 5 | T015 to T017 | US1 to US3 | WP5 (frontend-implementer), beside WP4 in its own worktree. |
| 3. WSL and qualification | 6, 7, 8 | T018 to T022 | US4, cross-cutting | WP6 (implementer-xhigh, WSL alone), WP7 (implementer, local package), WP7r (scout), then the review (reviewer). |
| 4. Docs | 9 | T023, T024 | Cross-cutting | WP8 (implementer), after the 010 merge; then the orchestrator. |

---

## Phase 1: Setup — probe rerun (WP-F) — batch 0

**Agent**: scout. The orchestrator runs `/speckit-analyze` on these artifacts before T001 starts.

**Purpose**: Prove the probe facts of research.md R2 on the installed Git before any design depends on them.

- [x] T001 Copy the probe scripts `probe.sh` and `probe2.sh` and their WSL wrappers into a new local scratch folder (research.md R1). Set the scripts' base folder to that new folder first. Run P1 to P20 on Windows and in `Ubuntu-26.04`. Add three probes. U1: a lease delete with `push.useForceIfIncludes=true` in the owned configuration gives the P10 line and exit. U3: a delete of a branch with a non-ASCII UTF-8 name, and a delete in a SHA-256 repository. U8: a stale-lease delete with a pre-push hook that writes one log line. The log line must exist. Copy the git-push(1), git-ls-remote(1), git-symbolic-ref(1), git-update-ref(1), and git-rev-list(1) sections of research.md R3 as text into the folder. Record each result, the Git versions, and the date in research.md R7 "Probe rerun (T001)". A result that differs from research.md R2 is a finding: change research.md, plan.md, and contracts/operations.md first, then run `/speckit-analyze`. Delete the probe repositories after the run. Do not run `wsl --shutdown`, `--terminate`, or `--unregister`. Control: P10 with a wrong expect must print `[rejected] (stale info)`, so the probe can show a difference. No repo code. Requirements: FR-004, FR-007, FR-008, FR-012, FR-015. Agent: scout. Before v0.1.0. Depends on nothing.

---

## Phase 2: Mockup (WP1) — batch 0

**Agent**: frontend-implementer, through the arbareto-ux skill flow. No repo files.

**Purpose**: The user approves the layout before any code exists.

- [x] T002 Approved by the user 2026-11-06 (14 boards, eight decisions). Build the static HTML mockup through the arbareto-ux skill, with sample data marked as sample. Build the 14 boards of plan.md D12. Use the plan.md D13 texts exactly. Pick the icons from the free hugeicons set. The orchestrator shows the mockup to the user. Record the approval, the artifact link, and the board names in the plan.md "Mockup" line. Record the decisions in plan.md "Open items and reviewer defaults". Put every changed text into plan.md D13 first, then run `/speckit-analyze`. No code, so no control mutation; the user's approval is the gate. Requirements: FR-001, FR-006, FR-010, FR-016. Agent: frontend-implementer. Before v0.1.0. Depends on T001.

**Checkpoint**: the code tasks start only after the user approves the mockup and 010 merges into `main`.

---

## Phase 3: Foundational — contracts (WP2) and shell (WP3) — batch 1

**Agent**: WP2 implementer-xhigh; WP3 implementer-xhigh (`Local: Rust`).

**Purpose**: The action, payload, plan, result, and reasons. No story starts before T004 ends.

- [ ] T003 Code gate: start after the T002 approval and the 010 merge into `main`. Write failing contract tests for contract Δ1, Δ3, and Δ9 (data-model §1 to §6). Files: `tests/contracts/remote-delete-contract.test.ts`, `tests/vectors/valid/remote-delete-*.json`, and `tests/vectors/invalid/remote-delete-*.json`. Valid vectors: the remote payload, the combined payload, a plan with `local`, and a result with status `deleted`, `remoteGone`, and `localNotDeleted`. Invalid vectors: `local` with action `push`, `remoteGone` with action `push`, and a plan of this action without `lease`. Cover the four new sync reasons, the four workbench reasons in `SyncRefused`, and `worktree`. Add the file to `tests/groups.json` `parallel`. Control, run after T004: drop `"deleted"` from the `PushResult` status enum; the valid result vector must fail. Requirements: FR-002, FR-003, FR-004, FR-008, FR-011, FR-012, SC-011. Agent: implementer-xhigh. Before v0.1.0. Depends on T001, T002, and the 010 merge.
- [ ] T004 Code gate: start after the T002 approval and the 010 merge into `main`. Implement contract Δ1, Δ3, and Δ9 in `src/contracts/channel.ts`, `envelope.ts`, and `errors.ts`. Add the two type-only entries: `SYNC_TRUST` in `src/frontend/trust/ask.ts` gains `"delete-remote-branch": "push"`, and `SYNC_NAMES` in `src/frontend/status/OperationStatus.tsx` gains X18. Run `bun run export:schemas`. Record the changed schema files in research.md R7 (research.md R5 U7). Verify with `bun run export:schemas --check`, `bun run typecheck`, and `bun run test:contracts`. Requirements: FR-002, FR-003, FR-004, FR-008, FR-011, FR-012, FR-014. Agent: implementer-xhigh. Before v0.1.0. Depends on T003.
- [ ] T005 Code gate: start after the T002 approval and the 010 merge into `main`. Write failing cargo tests first. `close.rs`: the close name X18 for `A::DeleteRemoteBranch` under `StartedKind::Sync`. `schema.rs`: `"delete-remote-branch"` in the started-action test list. Then implement plan.md D9 "Shell" in `src-tauri/src/close.rs` and `schema.rs`. Check the generated identifier after `bun run export:schemas` and record it in research.md R7 (research.md R5 U4). Verify with `cargo test --locked --manifest-path src-tauri/Cargo.toml`. Control: drop the sync mapping arm; the close-name test must fail. `Local: Rust`. Requirements: FR-013, FR-016. Agent: implementer-xhigh. Before v0.1.0. Depends on T004.

---

## Phase 4: Service (WP4) — batch 1

**Agent**: implementer-xhigh.

**Goal**: US1 to US3 in the service.

**Independent Test**: spec.md User Stories 1 to 3 "Independent Test".

- [ ] T006 [P] Code gate: start after the T002 approval and the 010 merge into `main`. Write failing argument tests in `tests/contracts/sync-commands.test.ts` for plan.md D5. Cover the exact delete array with `--force-with-lease=<dst>:<expect>`, and a `pushArgs` call with a null branch and no lease that throws. Cover the `symbolic-ref`, the removed-commit count and list, `remote get-url --all`, and `ls-remote --exit-code` arrays. Cover the count form with and without a local branch (P14). Each array starts with `--no-lazy-fetch`. Control: drop `--force-with-lease` from the delete array; the array case must fail. Requirements: FR-002, FR-004, FR-007, FR-012. Agent: implementer-xhigh. Before v0.1.0. Depends on T004.
- [ ] T007 [P] Code gate: start after the T002 approval and the 010 merge into `main`. Write failing parser tests in `tests/contracts/sync-parsers.test.ts` for plan.md D5. Use the stdout bytes of research.md R2 P1, P3, P7, P8, P9, and P10 verbatim. Cover two matching lines (null) and empty stdout with exit 1 (`none`). Cover a `[deleted]` line for another destination with exit 0 (null). Cover the `:<dst>` form of `[rejected] (remote does not support deleting refs)`. Take it from the research.md R3 source format (research.md R5 U2). Cover `parseSymref` and `parseLsRemote` with the tail-match case of P15. Control: remove the alias match; the P8 case must fail. Requirements: FR-004, FR-008, FR-012, SC-011. Agent: implementer-xhigh. Before v0.1.0. Depends on T004.
- [ ] T008 [P] Code gate: start after the T002 approval and the 010 merge into `main`. Write `tests/contracts/trust-classes.test.ts` for plan.md D9. Assert that every integration kind with `workbench: true` has `sync: true`, and that every workbench event is a sync event. So `approvalRequired.workbench` implies `approvalRequired.sync`. Add the file to `tests/groups.json` `parallel`. Control: set `sync: false` for `core.fsmonitor` in a scratch copy; the test must fail. Requirements: FR-011, FR-014, SC-007. Agent: implementer-xhigh. Before v0.1.0. Depends on T004.
- [ ] T009 [P] [US1] Code gate: start after the T002 approval and the 010 merge into `main`. Write failing real-repository tests in `tests/git/remote-delete.test.ts` on `tests/git/sync-harness.ts`. Use the remote-only fixtures of plan.md D16 against the oracle on a copy (SC-001). Cover success, a name with a slash (P19), and 150 commits that only the branch holds (count 150, list 100). Cover the remote moved after the fetch, where every remote commit stays (SC-002). Cover an absent remote branch with a `pushurl` that differs from the URL. Nothing changes (P9, P16). Cover the remote refusals P3 to P6 and a declined local pre-push hook after approval (P7). Cover the default branch, an absent and a non-symbolic `origin/HEAD`, and `followRemoteHEAD=never`, each with no network process (SC-003). Cover `no-remote-branch` for two remotes, a refspec to `refs/tags/`, and another forward ref. Cover two push URLs, a mirror, an operation in progress, and trust required. Cover the 60 s expiry through the `now` seam and `STALE_REVIEW` after an external fetch. Cover Cancel during a slow pre-receive hook. On Windows, cover the Pageant frame before the push, as `tests/git/sync-fetch.test.ts:394` does for fetch (plan.md R10). Compare the config bytes before and after each run (SC-006). Add the file to `tests/groups.json` `parallel`. Control: drop the lease from the argv; the remote-moved fixture must lose commits and fail. Requirements: FR-002 to FR-005, FR-007 to FR-009, FR-013, SC-001, SC-002, SC-003, SC-006. Agent: implementer-xhigh. Before v0.1.0. Depends on T004.
- [ ] T010 [P] [US2] Code gate: start after the T002 approval and the 010 merge into `main`. Write failing real-repository tests in `tests/git/remote-delete-local.test.ts` for the combined fixtures of plan.md D16 (SC-004). Cover success with the section removed, and a branch without a `branch.<name>` section. Cover `not-upstream` after an external `branch --set-upstream-to`, and `current-branch`, `other-worktree`, and `config-in-include`. Cover `STALE_REVIEW` after an external commit on the local branch. Cover an approved pre-push hook that commits on the local branch during the run: the result has `localNotDeleted`, and the local ref keeps the new commit. Cover Cancel between the steps, a network failure with both branches unchanged, and the combined count of P14. Compare the config bytes; only the `branch.<name>` section may go (SC-006). Add the file to `tests/groups.json` `parallel`. Control: run the local writes before the push; the case "the remote fails, the local branch stays" must fail. Requirements: FR-010, FR-011, FR-013, SC-004, SC-006. Agent: implementer-xhigh. Before v0.1.0. Depends on T004.
- [ ] T011 [P] Code gate: start after the T002 approval and the 010 merge into `main`. Extend `tests/git/pre-push.test.ts` and `tests/git/sync-trust.test.ts`: the pre-push hook gets the `(delete)` stdin line (P7) only after approval, with an empty hook log before it (SC-007). Extend `tests/git/sync-credentials.test.ts`: a push URL with user information shows redacted in the plan, the diagnostics, and the remedy. The remedy is text only (SC-005). Cover the gone-check `ls-remote` step and the event log too. They show no credential. Control: gate the class `workbench` in place of `sync`; the hook case must fail, because `pre-push` is no workbench event. Requirements: FR-008, FR-014, SC-005, SC-007. Agent: implementer-xhigh. Before v0.1.0. Depends on T004.
- [ ] T012 [P] [US3] Code gate: start after the T002 approval and the 010 merge into `main`. Write failing tests in `tests/git/remote-delete-gone.test.ts` for plan.md D8 (user decision Q1 option a). Fixtures: another clone deleted the remote branch (gone, P18). The branch moved (no removal). A `pushurl` differs (no check, P16). The remote holds `refs/heads/x/refs/heads/<name>` but not `refs/heads/<name>` (the exact parse gives gone, P15). An approved pre-push hook runs `update-ref` and moves the tracking ref during the run. The bound `update-ref -d` then refuses, and the stale outcome stays. The hook log proves that the hook ran. If U8 fails, drop this fixture and record the gap in research.md R7. A move before the run refuses earlier with `STALE_REVIEW` (`sync.ts:561`). The combined form (`remoteGone`, then the local delete). Add the file to `tests/groups.json` `parallel`. Control: treat exit 0 as gone; the moved fixture must fail. Requirements: FR-011, FR-012. Agent: implementer-xhigh. Before v0.1.0. Depends on T004.
- [ ] T013 Code gate: start after the T002 approval and the 010 merge into `main`. Implement plan.md D4 to D7, D9 "Trust", and D15 "Side-effect-free fact module", "Review module", and "Run". Files: the new `src/git-service/ref-facts.ts` and `remote-delete.ts`, and `workbench-review.ts`, `branch-ops.ts`, `sync-review.ts`, `sync.ts`, `sync-commands.ts`, and `sync-parsers.ts`. T006 to T011 pass. The 003 and 004 suites stay green, including `tests/git/branch-ops.test.ts` and `tests/git/delete.test.ts`. Verify with `bun run typecheck`, `bun run test:contracts`, and `bun run test:git`. Then the batch 1 review (reviewer, with safety scrutiny of the lease, the order, and the partial outcomes), then `/speckit-converge`. Requirements: FR-002 to FR-011, FR-013, FR-014. Agent: implementer-xhigh. Before v0.1.0. Depends on T006 to T011.
- [ ] T014 Code gate: start after the T002 approval and the 010 merge into `main`. Implement plan.md D8 in `src/git-service/remote-delete.ts`, `sync.ts`, `sync-commands.ts`, and `sync-parsers.ts`. T012 passes, and T009 and T010 stay green. Verify with `bun run typecheck` and `bun run test:git`. Requirements: FR-011, FR-012. Agent: implementer-xhigh. Before v0.1.0. Depends on T012 and T013.

---

## Phase 5: Frontend (WP5) — batch 2

**Agent**: frontend-implementer. It loads `vercel-react-best-practices` and `web-design-guidelines`, and the arbareto-ux skill. WP5 can run beside WP4 in its own worktree.

**Goal**: US1 to US3 in the renderer.

**Independent Test**: the acceptance scenarios of spec.md User Stories 1 to 3.

- [ ] T015 [P] [US1] [US3] Code gate: start after the T002 approval and the 010 merge into `main`. Write failing tests in the new `tests/contracts/remote-delete.test.tsx` for plan.md D1, D2, D6, and D13. Cover the item order, the danger style, and the E1 key text on X1. Cover X1 on a History remote label, and Del on a remote row that starts the review. Cover Cancel as the first focus, Escape, and no default button. Cover each refusal reason of plan.md D4 with its text, and the fallback for other codes. Cover each outcome of plan.md D6 with its text from the `SyncResult` fields, including X23, X26, and the remedy X27. Cover the step texts X19 and X28, the details heading X29, and the list name X30. Cover a cut status-bar line: its full text shows in a tooltip and in its accessible name. Cover the trust ask that names `push`. Use the recorded fakes of `tests/contracts/sync-fake.tsx`. Add the file to `tests/groups.json` `parallel`. Control: move X1 into group 3; the order case must fail. Requirements: FR-001, FR-004, FR-006, FR-008, FR-012, FR-013, FR-016, SC-008, SC-011. Agent: frontend-implementer. Before v0.1.0. Depends on T004.
- [ ] T016 [P] [US2] Code gate: start after the T002 approval and the 010 merge into `main`. Extend `tests/contracts/workbench-branches.test.tsx` for plan.md D3. X9 shows only with a listed remote upstream, and not without a token. It is unchecked by default. Checking sends the payload `{ ref, local }` and shows X12. A refusal shows as an alert and disables Delete. Unchecking restores the 004 plan and the workbench token. Delete with the box checked sends `sync` with the sync token and never sends `runWorkbench`. Cover X10, X11, and the reflog line. While the review runs or refuses, Delete stays visible, disabled, and focusable, with the reason under the check box. Control: make X9 checked by default; the default case must fail. Requirements: FR-010, FR-011, FR-016, SC-008. Agent: frontend-implementer. Before v0.1.0. Depends on T004.
- [ ] T017 Code gate: start after the T002 approval and the 010 merge into `main`. Implement plan.md D1 to D3 and D15 "Frontend". Files: `src/frontend/branches/BranchActions.tsx`, `texts.ts`, and the new `RemoteDeleteConfirm.tsx`. More files: `src/frontend/sync/ForcePushConfirm.tsx` and `useSync.ts`, `src/frontend/app/Workbench.tsx`, `src/frontend/status/OperationStatus.tsx`, and `src/frontend/keyboard/shortcuts.ts`. T015 and T016 pass, and the 003 force-push and 004 branch tests stay green. Compare the result with the T002 boards in `bun run dev` with `ARBARETO_PROFILE_ROOT` in a scratch folder. Verify with `bun run typecheck` and `bun run test:contracts`. Then the batch 2 review (reviewer, with `web-design-guidelines`), then `/speckit-converge`. Requirements: FR-001, FR-006, FR-010, FR-016. Agent: frontend-implementer. Before v0.1.0. Depends on T013, T014, T015, and T016.

---

## Phase 6: User Story 4 — WSL repositories (WP6) — batch 3

**Agent**: implementer-xhigh. `Local: WSL`, alone on the host.

**Goal**: The same results in a WSL repository.

**Independent Test**: spec.md User Story 4 "Independent Test".

- [ ] T018 [US4] Code gate: start after the T002 approval and the 010 merge into `main`. Write `tests/wsl/remote-delete-wsl.test.ts` on `tests/wsl/workbench-wsl-harness.ts` (plan.md D10) in `Ubuntu-26.04`. The bare remote lies inside the distro. Hash and compare inside the distro. Cases: success, stale lease, default branch refusal, combined delete, gone recovery, and Cancel with no process left in the distro (SC-010). Add the file to `tests/groups.json` `serial` with the reason "WSL remote delete in the distro". Verify with `bun run test:all` with `ARBARETO_WSL_DISTRO=Ubuntu-26.04` (the `tests/wsl` serial group, README "Development"). Control: send an expect of another commit; the success case must fail. `Local: WSL`, alone. Requirements: FR-015, SC-010. Agent: implementer-xhigh. Before v0.1.0. Depends on T013 and T014.

---

## Phase 7: Packaged qualification (WP7, WP7r) — batch 3

**Agent**: WP7 implementer writes; WP7r scout runs. `Local: package`.

- [ ] T019 [P] Code gate: start after the T002 approval and the 010 merge into `main`. Write `tests/windows/remote-delete-packaged.test.ts` through UI Automation and CDP. Cover the UIA names of X1 and of the dialog, and Del on a remote row. Cover the Cancel focus of the remote dialog and of the checked local dialog. Use UIA `HasKeyboardFocus` (the 008 T047 method). Cover the focus return to the open Delete dialog after the trust ask (research.md R5 U6). Cover forced colors, both themes, both densities, and 150% and 225% text. Cover one real delete through a local bare remote. Control: let the dialog focus the danger button first; the Cancel focus case must fail. `Local: package`. Requirements: FR-001, FR-006, FR-010, FR-016, SC-008. Agent: implementer. Before v0.1.0. Depends on T005, T013, T014, and T017.
- [ ] T020 [P] Code gate: start after the T002 approval and the 010 merge into `main`. Add the fixture M-D to `tests/windows/perf-fixtures.ts` (plan.md D11). Check that fixture M has the shape of D11 and that M-D adds the remote-tracking refs (research.md R5 U5). Write `tests/windows/remote-delete-perf.test.ts` with the fixed samples of plan.md D11. SC-009a: 40 opens per run (20 right-click, 20 Shift+F10, distinct rows). SC-009b: 10 warm runs and 1 warm-up run per form (remote, combined) on `d01`. SC-009c: 10 + 1 remote-only deletes. SC-009d: 10 + 1 combined deletes. SC-009e: at least 20 history-filter inputs during each SC-009c and SC-009d run. Each timed run deletes its own branch, and the setup recreates the branches outside the timed part. Record CPU seconds and process-tree private bytes per run, with no budget. The warm-up run counts for the every-run bound, never for the median. Measure one cold run per measure SC-009a to SC-009d after a new app start. Each cold run has a budget of 2 times its warm budget. Add WSL record cases for SC-009b to SC-009d on `Ubuntu-26.04` (10 + 1 runs), with no budget. Control: lower the SC-009a every-open bound to 1 ms in a scratch copy of the test; the run must fail. `Local: package`. Requirements: SC-009a, SC-009b, SC-009c, SC-009d, SC-009e. Agent: implementer. Before v0.1.0. Depends on T005, T013, T014, and T017.
- [ ] T021 Run T019 and T020 on the packaged build, in the foreground, alone, under the test gate rules. Run the WSL records of SC-009b to SC-009d. Record the build identity, the OS version, each result, and the records in research.md R7 "Packaged and perf runs (T021)". A failed budget is a finding for `/speckit-converge`. Control: the run prints `ORIGIN` lines of the installed build, and the T019 control turns it red once. `Local: package`. Requirements: SC-008, SC-009a to SC-009e. Agent: scout. Before v0.1.0. Depends on T018, T019, and T020.

---

## Phase 8: Final review — batch 3

**Agent**: reviewer.

- [ ] T022 Final review of the whole feature by the reviewer. Scrutinize the lease, the delete order, the gone recovery, and the partial outcomes. Write the requirement-to-test map into research.md R7 "Requirement-to-test map (T022)". Every FR and SC maps to a test. No outcome comes from message text, timing, retry counts, or a name pattern (SC-011). Then `/speckit-converge`. Control: remove one FR from the draft map; the coverage check must name the missing FR. Requirements: FR-008, SC-011. Agent: reviewer. Before v0.1.0. Depends on T021.

---

## Phase 9: Docs (WP8) — batch 4

**Agent**: implementer, then the orchestrator.

- [ ] T023 Wait until 010 merges into `main`, because 010 also amends these lines. Then apply the amendments of plan.md D14 in the style "Note (2026-11-06, user decision): …". Targets, one each: `specs/001-desktop-qualification/spec.md` FR-027 (`:424`). `specs/003-remote-sync/spec.md` Scope Boundaries (`:226`) and FR-041 (`:261`). `specs/004-workbench-ux/spec.md` Scope Boundaries (`:349`), FR-014 (`:407`), and FR-017 to FR-019 (`:410-412`). `specs/004-workbench-ux/plan.md` D16 "Branch menu groups" (`:570`). `specs/007-first-release/spec.md` `:19` and FR-006 (`:159`). README "Features". The CHANGELOG 0.1.0 section, with the user-visible change only. The 007 files and `CHANGELOG.md` are not on `main` at `65959ceb`; amend them where they live at that time. Check each line number against the base first, because 010 can move it. Leave 003 FR-025 unchanged. No code. Control: none, because the task changes docs only; T024 checks it. Requirements: spec "Changes to earlier requirements". Agent: implementer, with the orchestrator as reviewer. Before v0.1.0. Depends on T022 and the 010 merge.
- [ ] T024 Run `/speckit-analyze` on the final artifacts and fix every CRITICAL and HIGH finding. Then run `/speckit-converge`. Agent: implementer, with the orchestrator as reviewer. Before v0.1.0. Depends on T023.

---

## Dependencies & Execution Order

### Phase dependencies

- Phase 1 (T001) has no dependency. The orchestrator runs `/speckit-analyze` on these artifacts first.
- Phase 2 (T002) waits for T001 and ends with the user's approval.
- Code gate: T003 to T020 wait for the T002 approval and the 010 merge into `main`.
- Phase 3: T003 depends on T001, T002, and the 010 merge. T004 depends on T003. T005 depends on T004.
- Phase 4: T006 to T012 start after T004, in parallel. T013 waits for T006 to T011. T014 waits for T012 and T013.
- Phase 5: T015 and T016 start after T004, in parallel with Phase 4. T017 waits for T013 to T016.
- Phase 6: T018 waits for T013 and T014. It runs alone on the host.
- Phase 7: T019 waits for T005, T013, T014, and T017. T020 waits for T005, T013, T014, and T017. T021 waits for T018 to T020.
- Phase 8: T022 waits for T021.
- Phase 9: T023 waits for T022 and the 010 merge. T024 waits for T023.

### Story dependencies

- US1 needs T009, T013, T015, and T017. US2 needs T010, T013, T016, and T017. US3 needs T012, T014, T015, and T017. US4 needs T018.

### Within each story

- The failing-test task comes first. The service task follows. The frontend task follows the service task.

## Parallel Example

```text
Batch 0:  T001 → T002 (user approval).
Gate:     T002 approved and 010 merged into main.
Batch 1:  T003 → T004 → T005 (local Rust), and T006 to T012 in parallel → T013 → T014.
Batch 2:  T015, T016 in parallel after T004 (own worktree) → T017 after T013 and T014.
Batch 3:  T018 (WSL alone); T019 and T020 in parallel → T021 (alone) → T022.
Batch 4:  T023 → T024.
```

## Implementation Strategy

- MVP: Phases 1 to 5 give US1 to US3 on Windows. The v0.1.0 package needs every phase (user decision, 2026-11-06).
- Deliver in batch order. Each batch ends green, reviewed, and converged before the next batch starts.
- Stop at each checkpoint and run the story's Independent Test.

## Notes

- `[P]` tasks touch different files and have no open dependency in their phase.
- The orchestrator commits after each task or logical group.
- A probe finding changes research.md, plan.md, and contracts/operations.md first, then the dependent task.
- Task IDs follow the design plan section D.7. This spec adds T024, the final analyze and converge step.
