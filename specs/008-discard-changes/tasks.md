---

description: "Task list for the Discard (Revert) Changes feature"
---

# Tasks: Discard (Revert) Changes

**Input**: Design documents from `specs/008-discard-changes/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/operations.md, quickstart.md, and checklists/requirements.md.

**Tests**: The spec (SC-001 to SC-011) and plan.md "Steps" require tests. A failing-test task comes before each implementation task, and the implementation task depends on it. The probes of research.md R14 come first (batch 0). No test passes by default.

**Organization**: Phases 1 and 2 hold the probes and the foundation (batches 0 and 1). Phases 3 to 7 hold one user story each (batches 2 and 3). Phase 8 holds the cross-cutting safety suites (batch 3). Phase 9 holds the qualification and the doc pass (batch 4). Story phases carry `[USn]` labels.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: The task touches different files from the other `[P]` tasks of its group and depends on no incomplete task of that group. A sub-heading starts a new group. "Depends on" names the exact order.
- **[Story]**: The user story of spec.md (US1 to US5).
- **WP and agent**: Each task names its plan.md work package. The phase heading names the agent.
- **Local tags**: `Local: Rust` needs the local Rust toolchain. `Local: Windows` needs the Windows reference host. `Local: package` needs the packaged Windows build. `Local: WSL` needs `Ubuntu-26.04` with Git 2.55 and runs alone on the host. Cloud sessions do not run these tasks. A skip never counts as a pass.
- **Earlier specs**: The 001 to 006 texts stay unchanged until T051 (plan.md D14). No other task edits `specs/001-desktop-qualification/` to `specs/006-wsl-parity-spellcheck/`.
- **Portability**: Shared TypeScript code and the generic test harness hold no Win32 FFI. Windows-only behavior stays in `src-tauri/src/` and `tests/windows/`.

## Harness and tick rules

- The 001 "Test harness rules" stay in force (`specs/001-desktop-qualification/tasks.md`): `printOrigin`, one control mutation per batch verification, Git through `tests/git/git-binary.ts`, capability skips, `tests/groups.json`, `OBSERVATION` lines, owned fixture roots, and the source headers.
- Every Git test uses an owned `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM=1`. No test touches a real repository, the user's configuration, or a real distro user's files.
- Oracles (plan.md D13): Git's own `apply -R` (fixtures without a line-ending conversion), the plan.md D13 line oracle (`apply --cached -R` after `add` on a copy, and the raw bytes of every unselected line), `restore --staged --worktree --source=HEAD`, and `restore .` on a copy of the fixture. Tests compare index bytes through `ls-files --stage -z` and working bytes by SHA-256.
- A test that asserts a refusal asserts its code and reason, never a message text (spec SC-010).
- Each new test file in `tests/contracts`, `tests/git`, or `tests/wsl` adds its line to `tests/groups.json` in the same task: `parallel`, or `serial` with its reason. `tests/windows` files are not in `tests/groups.json`.
- A probe task has no implementation. It prints `OBSERVATION <task ID>: <probe> <result>` with the Git, Windows, Bun, or distro version. A failed probe is a finding, not a red task.
- App runs set `ARBARETO_PROFILE_ROOT` to a scratch folder.
- A task is ticked only after a green Windows run that verifies it, with `ORIGIN` lines in the checkout under test. A `tests/windows` task needs a green `bun run test:windows` on the reference host.
- Batch verification tasks use only the README "Development" commands.

## Batch-to-story mapping

| Batch | Phases | Tasks | Stories | Work packages (agent) |
| --- | --- | --- | --- | --- |
| 0. Probes and contracts | 1, 2 (first part) | T001–T011 | Foundational | WP1 (implementer; T004 alone on WSL), then WP2 (implementer). |
| 1. Shell, foundation, mockup | 2 (second part) | T012–T024 | Foundational | A: WP3 (implementer-xhigh, local Rust and WSL). B: WP4 foundation (implementer-xhigh). C: WP5 mockup (frontend-implementer, no code). |
| 2. P1 stories | 3, 4 | T025–T033 | US1, US2 | WP4 (implementer-xhigh), then WP5 (frontend-implementer). |
| 3. P2 stories, WSL, safety | 5, 6, 7, 8 | T034–T046 | US3, US4, US5, cross-cutting | WP4, then WP5, then WP6 (implementer, WSL alone), then WP4 safety suites. |
| 4. Qualification and docs | 9 | T047–T053 | Cross-cutting | WP7 (implementer writes, scout runs; local package), then WP8 (implementer). |

---

## Phase 1: Setup — batch 0 probes (WP1)

**Agent**: implementer. T004 runs alone on WSL.

**Purpose**: Prove the facts of research.md R14 before any design depends on them.

- [x] T001 [P] Write the Git probes G3 to G10 in `tests/git/revert-facts.test.ts` (research.md R14; G1 and G2 are withdrawn). Use real disposable repositories. G9 compares the bytes of `git --no-lazy-fetch checkout-index --temp --stdin -z` for one path with the bytes of `git restore --worktree` and, after a HEAD entry in the index, of `git restore --source=HEAD --staged --worktree` on a copy, for these fixtures: no conversion, `core.autocrlf=true`, `core.autocrlf=input`, `text eol=crlf`, `text=auto` with an LF blob and a CRLF blob, `ident`, `working-tree-encoding=UTF-16LE-BOM`, a clean and smudge filter of a test program in the fixture, a Git LFS-tracked file through a test `filter.lfs` program without network (capability skip `git-lfs`), a binary file, an empty file, and a file with mode 100755. G10 checks that the temporary file lands in the worktree root also with `-C <subfolder>` and `--prefix=<folder>/`, that its name is one component, that stdout holds exactly `<temp> TAB <path> NUL` per path, that `checkout.workers=4` gives the same files, that no other file below the worktree root changes (a digest of every file before and after), that the index bytes and their time stay, that no `index.lock` appears, and that `post-checkout` and `post-index-change` hooks leave no marker file. G3 checks that `hash-object --path=<p> --stdin` writes no object and runs no `core.fsmonitor` command. G4 compares `check-attr -z --stdin` with `check-attr --cached -z --stdin` before and after a `.gitattributes` change. G5 records the `ls-files --eol -z` `w/` values and runs the data-model §6 cases through `hash-object`. G6 is a source fact, so T005 records it. G7 checks that `git restore --source=HEAD --staged --worktree` removes a staged new file. G8 checks that `--no-optional-locks status --porcelain=v2 -z` shows the entry unchanged after a G9 write, and that the index bytes stay. Add the file to `tests/groups.json` `parallel`.
- [ ] T002 [P] Write the Windows probes W1 to W11 in `tests/windows/revert-facts.test.ts` through `bun:ffi` on NTFS files below the owned fixture root (research.md R14, as `tests/windows/delete-facts.test.ts` does). W2 records the owner of a file that an elevated helper created, or skips with the capability `elevated-helper`. W11 skips with the capability `efs` without EFS. W9 runs 1,000 replaces with Windows Defender real-time protection on and retries nothing. `Local: Windows`.
- [x] T003 [P] Write the replace-sequence probes as `#[ignore]` cargo tests in the test module of `src-tauri/src/file_replace.rs`: W1 the attribute copy through `FileBasicInformation`, W2 the DACL copy methods on a handle and the descriptor compare, W3 the creation-time copy and the tunneling case, W5 the NT status of a rename over a read-only target, W6 the delete disposition on close, its clear with `FileDispositionInformationEx`, and a child process that holds the handle and ends by `TerminateProcess` before and after the clear, W10 the folder create below a held parent and a reparse point at a folder name. Each probe prints `OBSERVATION T003`. `Local: Rust`. If a `windows` crate feature is missing, record it as a finding for WP3 (plan.md Technical Context), and add no feature in this task.
- [x] T004 Write the WSL probes L1 to L7 in `tests/wsl/revert-facts.test.ts`, with Perl snippets through the existing WSL test harness in the owned distro folder of `Ubuntu-26.04` (research.md R14). L6 sets `user.test` and skips the ACL case with the capability `acl-tools` when `setfacl` is absent. The file also runs the G9 and G10 case list inside the distro. Add the file to `tests/groups.json` `serial` with the reason "runs Perl probes in the distro". `Local: WSL`, alone. Depends on nothing.
- [x] T005 Run the fact gate: run T001 to T004, copy every `OBSERVATION` line into research.md R15 with the date, the host build, and the versions. Record G6 from the Git source at the tag of the selected Git version: the hooks that `builtin/update-index.c` runs. Record the W2 result for T013, and the G9 cases that differ. For each finding, change the research.md R8 or R9 table, plan.md D3 to D9, and contracts/operations.md, then run `/speckit-analyze`. Depends on T001 to T004. Agent: scout runs, implementer edits.

---

## Phase 2: Foundational — batch 0 contracts (WP2) and batch 1 foundation (WP3, WP4, WP5)

**Agent**: WP2 implementer; WP3 implementer-xhigh; WP4 implementer-xhigh; WP5 frontend-implementer.

**Purpose**: The contracts, the shell write, the index split, the test double, the revert frame, and the approved mockup. No user story starts before this phase ends.

### Contracts (batch 0, WP2; write the tests first)

- [x] T006 Write failing contract tests in `tests/contracts/revert-contract.test.ts` and the vectors `tests/vectors/valid/revert-*.json` and `tests/vectors/invalid/revert-*.json`. Cover the three payloads of data-model §1: `entryIds` "1 to 10,000 unique entry IDs", `lines` "1-based ordinals of `+` and `-` lines of one hunk, ascending". Cover the plans of data-model §5, the result of data-model §9, the phases `revert-index` (no counters) and `revert-files` (`fileIndex`, `fileCount`), the marker actions `revert-lines`, `revert-files`, `revert-unstaged`, the contract Δ9 reasons, `STALE_REVIEW` reason `revert-changed`, and `REVERT_FILE_BYTES` = 2,117,152 for the frame of a line revert (research.md R11, review of 2026-10-30), with no byte bound for whole files. Cover the review refusal value of contract Δ3 with `files` and `remedy`. Cover the contract Δ6 frames: `fileReplace` `working` with exactly one of `bytes` (0 to `REVERT_FILE_BYTES`) and `source` (`{name, size, sha256}`, `name` one path component), and `folders` 0 to 64 only with `expected: absent`; `tempRemove`; `fileFacts` `detail` and `stream`. Add the file to `tests/groups.json` `parallel`. Depends on T005.
- [x] T007 Implement the contracts in `src/contracts/operations.ts`, `src/contracts/envelope.ts`, `src/contracts/errors.ts`, `src/contracts/limits.ts`, and the exported schemas in `src/contracts/schemas/`. Add the typify types and the explicit range checks in `src-tauri/src/schema.rs`. Run `bun run export:schemas`. Depends on T006.
- [x] T008 [P] Write failing tests in `tests/contracts/shortcuts-008.test.ts`: `scopedAction` gives `revertLines` for R in scope `diff`, and `revertFiles` for R in `changesList` and in the new scope `stagedList`. A composing event gives null. Each `KEYS` entry has `aria` "R" and `text` "R". Add the file to `tests/groups.json` `parallel`. Depends on T005.
- [x] T009 Implement `revertLines` and `revertFiles` and the scope `stagedList` in `src/frontend/keyboard/shortcuts.ts` (plan.md D12). Depends on T008.
- [x] T010 [P] Write failing vectors in `tests/contracts/support.test.ts` for `parseAttributes` with seven attributes, `ident` last (research.md R6). Then add `ident` to `SUPPORT_ATTRIBUTES` in `src/git-service/support.ts`, and check that `attributeArgs` in `src/git-service/commands.ts` and its callers in `comparison.ts`, `hunk-publish.ts`, and `multi-publish.ts` still pass. Hunk staging keeps its results; a change of only the `ident` value between the review and the publication now gives `STALE_SELECTION`, as research.md R6 records. Depends on T005.
- [x] T011 Batch 0 verification: `bun run typecheck`, `bun run export:schemas --check`, `bun run test:contracts`, `bun run test:fast`, and `cargo test --locked --manifest-path src-tauri/Cargo.toml`. Control mutation: remove the `revert-files` phase from `operations.ts`; `test:contracts` must turn red. Then the batch 0 review (reviewer), then `/speckit-converge`. Depends on T007, T009, T010. Evidence: research.md R15 "Batch 0 verification (T011)". The batch 0 review ran first, and `4d729e84` holds its fixes.

### Shell write (batch 1, WP3; write the tests first)

- [ ] T012 [P] Write failing cargo tests in `src-tauri/src/file_replace.rs` and `src-tauri/src/process_requests.rs` for `fileReplace` `working` (contract Δ6, plan.md D8). Cover: a path outside the worktree root, a first component `.git` in any ASCII case, and a path inside the Git directory give `INVALID_REQUEST`; a missing or other marker action gives `INVALID_REQUEST`; bytes above `REVERT_FILE_BYTES` give `INVALID_REQUEST`; `expected` and `facts` mismatches give `stale`; the refusals `not-regular`, `hard-link`, `read-only`, `encrypted`, `owner`, `security`, and `file-attributes`; the kept facts of the research.md R8 table as T005 decided them; no temporary file after a failed write; `folders` creation and a reparse point at a folder name; the reply codes `sharing-violation` and `access-denied`; `stopped` before the write; a failed rename is not tried again (spec FR-037); the `source` copy (a digest that differs gives `stale`, a link or a second hard link at the source refuses, the source goes after success and after failure, and a 40 MiB source copies with a streamed digest); `tempRemove` (`removed`, `stale`, `absent`); `fileFacts` `stream` of a 40 MiB file; the size rule of the deadline (contract Δ3). Add `fileFacts` `detail` tests in `src-tauri/src/file_facts.rs`. `Local: Rust`. Depends on T011.
- [ ] T013 Write failing cargo tests in `src-tauri/src/file_replace.rs` for the DACL copy that probe W2 decided (research.md R15, user decision, 2026-10-27): `GetKernelObjectSecurity` of the old file, `SE_DACL_AUTO_INHERIT_REQ` set on that descriptor through `SetSecurityDescriptorControl`, then `SetKernelObjectSecurity` with `DACL_SECURITY_INFORMATION` on the temporary file handle. All three calls are in the enabled `windows` feature `Win32_Security`, so `src-tauri/Cargo.toml` gets no new feature. Cover the ten W2 cases (a plain and an auto-inherited folder; inherited ACEs only, an explicit ACE, a protected DACL, a file renamed in from a folder with another inheritable ACE, and a folder ACE added after the file exists), with the copy before the write as plan.md D8 orders it: each result has the owner, group, and DACL bytes and the SDDL of the old file. A difference after the copy refuses with `security`. `Local: Rust`. Depends on T005, T012.
- [ ] T014 Implement the Windows `working` target with `bytes` and `source`, and `tempRemove`, in `src-tauri/src/file_replace.rs`, `fileFacts` `detail` and `stream` in `src-tauri/src/file_facts.rs`, the DACL copy that T013 tests, the size-rule deadline of contract Δ3 for `checkout-index --temp` runs, `fileReplace` `source`, and `fileFacts` `stream` in place of `REGISTERED_DEADLINE_CAP_MS`, the routing and the marker actions in `src-tauri/src/process_requests.rs`, and the frame types in `src-tauri/src/schema.rs` (plan.md D8). `Local: Rust`. Depends on T012, T013.
- [ ] T015 [P] Write failing WSL tests in `tests/wsl/revert-wsl-files.test.ts` for the `wslFiles` `replace` `working` route through the shell (contract Δ11, plan.md D9): the mode bits 0644, 0755, and 0600 stay; another `st_uid` refuses with `owner`; the gid copy before the write, and `EPERM` refuses with `owner`; 02755 and 04755 keep their bits after the gid copy (probe L4); an extended attribute refuses with `xattr`; a link count of 2 refuses with `hard-link`; no name stays after a `kill -9` before `linkat` (as T005 decided); `mkdir` of `folders`; a stop gives `interrupted`; the `source` copy from Git's temporary file with the `fstat` identity check, and the source unlink after it; an absent target gets `0777 & ~umask` for mode 100755 and `0666 & ~umask` for 100644; `tempRemove`. A setgid 02755 file keeps 02755 after a `working` replace and after a 005 `ignore` replace (probe L4, research.md R15). Add the file to `tests/groups.json` `serial` with the reason "WSL replace in the distro". `Local: WSL`, alone. Depends on T011.
- [ ] T016 Implement the WSL `working` route with `bytes` and `source`, and the mode `tempRemove`: `replace_one` in `src/contracts/wsl-process.json` and `replace_command` and `replace_reply` in `src-tauri/src/wsl.rs` (plan.md D9). Move the mode copy of `replace_one` from a `chmod` before the write to an `fchmod` on the temporary file after the gid copy, the write, and the fsync, with an `fstat` compare of the mode bits before `linkat` (probe L4, plan.md D9). This change also fixes the 005 ignore-file save in WSL, which loses the setgid bit today. `Local: WSL`, `Local: Rust`. Depends on T015.

### Index split, test double, and frame (batch 1, WP4; write the tests first)

- [ ] T017 [P] Write failing tests in `tests/git/publish-index.test.ts`: `publishIndex` takes the owned lock, runs `prepare`, publishes the checked candidate, and returns the `Ending` and the owned files without a registry event (plan.md D7). Name the existing staging suites that must stay green: `tests/git/hunk-stage.test.ts`, `hunk-refusal.test.ts`, `hunk-races.test.ts`, `file-publish.test.ts`, and the multi-file staging tests. Add the file to `tests/groups.json` `parallel`. Depends on T011.
- [ ] T018 Split `publish()` in `src/git-service/hunk-publish.ts` at its `steps()` closure into the export `publishIndex` (plan.md D7). Export the Unstage lines `prepare` from `hunk-publish.ts` and the Unstage files `prepare` from `src/git-service/multi-publish.ts`. Depends on T017.
- [ ] T019 [P] Write failing tests in `tests/git/bun-runner.test.ts` for the test double: `fileReplace` `working` with `bytes` and `source`, and `tempRemove`, give the contract Δ6 replies with the same expected and facts checks on the host file system, records each request, and can stop at each write step through a seam; `fileFacts` `detail` and `stream` give the data-model §3 fields. Then implement them in `tests/git/bun-runner.ts`. Depends on T011.
- [ ] T020 Write failing tests in `tests/git/revert-frame.test.ts` (plan.md D2, D10): the three actions register and take no trust class; `OPERATION_IN_PROGRESS`, `unknown-operation`, `CONFLICTED`, and `BUSY` refuse them; an `index.lock` at the review or at the run start gives `LOCKED` with the lock path and changes nothing; the refusal order of plan.md D2; a changed bound gives `STALE_REVIEW` with `revert-changed`; a run after 60 s gives `APPROVAL_EXPIRED` (the `now` seam); the per-file outcomes of data-model §8 and the response states of plan.md D10 with synthetic double replies; a crash seam leaves the recovery marker. Spec FR-031: across every revert run of this file, the runner records no argument array with `apply` without `--cached`, `checkout`, `restore`, `checkout-index` without `--temp`, `reset`, or `stash`. Spec FR-003: every recorded array starts with `--no-lazy-fetch`, and each path passes after `--` or on stdin, also for the option-like path `-x` and the path `:(glob)*`. Spec FR-049: no service log entry of a revert holds file bytes, patch text, or a path. Add the file to `tests/groups.json` `parallel`. Depends on T018, T019.
- [ ] T021 Implement the frame in the new `src/git-service/revert.ts`: the registrations, the common reads, the refusal order, the reconcile reads (`ls-files --stage -z`, `fileFacts` digests, `readWorkspace`), and the outcome rules. Add the three actions to `CLASSLESS`, `STALE_REASONS`, and `FACT_REFUSALS` in `src/git-service/workbench-review.ts`. Add the plan.md D5a batch steps with the exact parse of `<temp> TAB <path> NUL`, and the argument builders for `checkout-index --temp --stdin -z`, `cat-file --batch-check`, `hash-object --path --stdin`, `check-attr --cached -z --stdin`, and the path-scoped `ls-files --stage -z` and `ls-files --eol -z` in `src/git-service/commands.ts`. Add the request types in `src/git-service/git-runner.ts`, and import `revert.ts` in `src/git-service/session.ts`. Depends on T020.

### Mockup (batch 1, WP5; no code)

- [x] T022 [P] Build the static HTML mockup through the arbareto-ux skill, with sample data marked as sample: the hunk "More actions" menu, the Changes and Staged row menus, the Changes header menu, the modal for each kind (lines, hunk, staged lines, files with new files, all unstaged with submodules and hidden rows), a refusal, the progress line, the result lines, forced colors, and the light theme (plan.md D12). The orchestrator shows it to the user. Record the approval and the board names in plan.md "Related". Depends on T011.
- [x] T023 Update plan.md D11 and D12 with the approved layout and the final texts, then run `/speckit-analyze`. Depends on T022.
- [ ] T024 Batch 1 verification: `bun run typecheck`, `bun run test:contracts`, `bun run test:git`, `cargo test --locked --manifest-path src-tauri/Cargo.toml`, and the WSL files alone with `ARBARETO_WSL_DISTRO=Ubuntu-26.04`. Control mutation: drop the expected SHA-256 compare in `file_replace.rs` `check`; the T012 stale test must turn red. Then the batch 1 review (reviewer, with safety scrutiny of `file_replace.rs`, the WSL `replace_one`, and `publishIndex`), then `/speckit-converge`. Depends on T014, T016, T018, T021, T023.

**Checkpoint**: the foundation is ready. User stories can start.

---

## Phase 3: User Story 1 — Revert lines or a hunk in the working file (Priority: P1) — batch 2 (MVP)

**Goal**: R in the unstaged diff reverts the selected lines or the selected hunk in the working file, after the confirmation.

**Independent Test**: spec.md User Story 1 "Independent Test".

**Agent**: WP4 implementer-xhigh, then WP5 frontend-implementer.

- [ ] T025 [US1] Write failing tests in `tests/git/revert-bytes.test.ts` for the pure functions of `src/git-service/revert-bytes.ts`: `reverseLines` with every case of data-model §6, a line without an ending, a context mismatch that gives `stale`, and `blobId` for `sha1` and `sha256`. Write failing tests in `tests/git/revert-lines.test.ts` (plan.md D3): unstaged lines and whole hunks pass the plan.md D13 line oracle, and equal Git's `apply -R` of the same partial patch on a copy in the fixtures without a line-ending conversion; the index digest stays; the CRLF cases; the `line-endings` refusal of the proof; the refusals `ident`, `attributes`, `untracked`, `deleted-file`, `new-file`, `eof-newline`, `context-only`, `binary`, `rename`, `mode`, `symlink`, `submodule`, `filter`, and `LFS`; a change between the review and the run gives `STALE_REVIEW` `revert-changed` (the `revertCheckpoint` seam); an expired token. Add both files to `tests/groups.json` `parallel`. Depends on T024.
- [ ] T026 [US1] Implement `src/git-service/revert-bytes.ts` and the unstaged `revert-lines` review and run in `src/git-service/revert.ts` (plan.md D3), with the `revertCheckpoint` seam. Depends on T025.
- [ ] T027 [P] [US1] Write failing tests in `tests/contracts/revert-confirm.test.tsx` (the modal is an alert dialog; Cancel has the first focus; Enter on Cancel, Escape, and a held R change nothing; no default button; the lines and hunk texts with their singular forms and "You cannot undo this."; the focus returns to the opener), `tests/contracts/revert-keys.test.tsx` (R in the diff with a line selection opens the lines review; with only a selected hunk the hunk review; without either "No hunk is selected."; nothing during an IME composition or in an editable field; R in the History commit diff does nothing), and `tests/contracts/revert-menus.test.tsx` (the hunk "More actions" menu with its destructive group "Revert hunk…" and "Revert <n> lines…", `aria-keyshortcuts` "R", and the unavailable reasons). Add the files to `tests/groups.json` `parallel`. Depends on T024.
- [ ] T028 [US1] Implement the frontend part: `src/frontend/changes/revert-text.ts`, the new `src/frontend/changes/RevertConfirm.tsx`, the "More actions" menu in `src/frontend/changes/HunkControls.tsx`, R in `src/frontend/changes/ComparisonView.tsx`, the ignore of `revertLines` in `src/frontend/history/CommitChanges.tsx`, and the review and run wiring with the busy, progress, and result lines in `src/frontend/app/Workbench.tsx` and `src/frontend/bridge.ts` (plan.md D11, D12). Depends on T026, T027.

**Checkpoint**: US1 works end to end in `bun run dev`.

---

## Phase 4: User Story 2 — Revert files (Priority: P1) — batch 2

**Goal**: R in the Changes list or the Staged list reverts the marked files to HEAD, in the index and in the working file.

**Independent Test**: spec.md User Story 2 "Independent Test".

**Agent**: WP4 implementer-xhigh, then WP5 frontend-implementer.

- [ ] T029 [US2] Write failing tests in `tests/git/revert-files.test.ts` (plan.md D5): modified, staged, partly staged, staged deletion, unstaged deletion with missing folders, binary, CRLF, `working-tree-encoding`, and `ident` files equal Git's `restore --staged --worktree --source=HEAD` on a copy; a staged new file keeps its working file (G7); the unborn branch rule; `in-the-way`; `untracked`; a 40 MiB binary file reverts, which is above the 16 MiB frame, and no request carries its bytes (no size limit, spec FR-025); an index change between D5a steps 1 and 3 gives `STALE_REVIEW` `revert-changed` and removes the temporary files (the `revertCheckpoint` seam); a malformed `checkout-index` record gives `MALFORMED_GIT_OUTPUT` and removes the named temporary files; a stop after `checkout-index` removes every unused temporary file through `tempRemove`; `limit` above 10,000 files; the index update for all files or none; `unstaged-only` when a file changes between the index part and its write (the `revertCheckpoint` seam); the double replies `sharing-violation`, `access-denied`, `disk-full`, and `read-only-volume` each give `failed` with that code, the old bytes, and the result field that selects its spec FR-041 text. Add the file to `tests/groups.json` `parallel`. Depends on T028.
- [ ] T030 [US2] Implement the `revert-files` review and run in `src/git-service/revert.ts` (plan.md D5), with `publishIndex` and the Unstage files `prepare`. Depends on T029.
- [ ] T031 [P] [US2] Extend the failing tests: `tests/contracts/revert-menus.test.tsx` (the Changes row menu group with "Revert file…" or "Revert <n> files…" directly above the "Delete from disk" group, the first blocking file named with several marked rows, the Staged row menu destructive group, the folder row reason, the untracked reason); `tests/contracts/revert-confirm.test.tsx` (the files texts, the first 20 paths in tree order, "and <m> more files." and "and 1 more file.", the new-files line, plain-text paths); `tests/contracts/revert-keys.test.tsx` (R in the Changes and Staged lists on marked rows and on the focused row; a key repeat opens nothing; after a success, the focus goes to the next entry, then to the previous entry, then to the list heading, as spec FR-042 states). Depends on T028.
- [ ] T032 [US2] Implement the menus and R in `src/frontend/changes/ChangesPane.tsx`, the files texts in `revert-text.ts`, and the wiring in `src/frontend/app/Workbench.tsx`. Depends on T030, T031.
- [ ] T033 Batch 2 verification: `bun run typecheck`, `bun run test:contracts`, `bun run test:git`, and `bun run build`. Control mutation: keep the comparison bytes for every restored line in `revert-bytes.ts`; a T025 CRLF case must turn red. Then the batch 2 review (reviewer, with safety scrutiny of `revert.ts` and `revert-bytes.ts`, plus web-design-guidelines for the UI diff), then `/speckit-converge`. Depends on T032.

**Checkpoint**: the P1 stories work. This is the minimum for v0.1.0 only together with Phases 5 to 9.

---

## Phase 5: User Story 3 — Revert all unstaged changes (Priority: P2) — batch 3

**Goal**: one action sets every listed tracked file to its index version and keeps the index.

**Independent Test**: spec.md User Story 3 "Independent Test".

**Agent**: WP4 implementer-xhigh, then WP5 frontend-implementer.

- [ ] T034 [US3] Write failing tests in `tests/git/revert-unstaged.test.ts` (plan.md D6): the working files equal Git's `restore .` on a copy; the index stays; untracked files and submodule working trees stay byte-identical, and the plan counts the submodules; the entries that a renderer filter would hide are covered; one refused entry makes the action unavailable, and the reason names the first 20 files with their reasons; `nothing-to-revert`; `limit`; the `revert-files` counters; the writes go through plan.md D5a from the index entries; Cancel stops before the next file within 1 s, and no unused temporary file stays; the per-file outcomes. Add the file to `tests/groups.json` `parallel`. Depends on T033.
- [ ] T035 [US3] Implement the `revert-unstaged` review and run in `src/git-service/revert.ts` (plan.md D6). Depends on T034.
- [ ] T036 [P] [US3] Extend the failing tests: `tests/contracts/revert-menus.test.tsx` (the Changes header "More actions" menu with "Revert all unstaged changes…", unavailable with "No unstaged changes."); `tests/contracts/revert-confirm.test.tsx` (the submodules line, the hidden line from the Filter files state, the singular forms); a progress and result test for "Checking <n> files…" during the review, "Reverting <i> of <n>…" with Cancel, and the result with the count of each outcome, the first 20 files that did not revert, and "and <m> more files." (spec FR-007, FR-030, FR-040). Depends on T033.
- [ ] T037 [US3] Implement the Changes header menu in `src/frontend/changes/ChangesPane.tsx`, the hidden count, and the progress and result lines in `src/frontend/app/Workbench.tsx` and `revert-text.ts`. Depends on T035, T036.

---

## Phase 6: User Story 4 — Revert staged lines (Priority: P2) — batch 3

**Goal**: R in the staged diff removes the selected changes from the index and from the working file.

**Independent Test**: spec.md User Story 4 "Independent Test".

**Agent**: WP4 implementer-xhigh, then WP5 frontend-implementer.

- [ ] T038 [US4] Write failing tests in `tests/git/revert-staged.test.ts` (plan.md D4): the index equals Git's `apply --cached -R` of the same partial patch on a copy; the working file loses the same changes; a file with unstaged changes refuses with `unstaged-changes`; `index-change-hook` refuses; the WSL `shared-repository` refusal through the double; an index part followed by a changed file gives `unstaged-only` and the FR-017 result; an index lock refuses with the 001 lock guidance and changes nothing. Add the file to `tests/groups.json` `parallel`. Depends on T037.
- [ ] T039 [US4] Implement the staged `revert-lines` review and run in `src/git-service/revert.ts` (plan.md D4), with `publishIndex` and the Unstage lines `prepare`. Depends on T038.
- [ ] T040 [P] [US4] Extend the failing tests: R in the staged diff opens the staged review; the staged lines and staged hunk texts; the partial result line of FR-017. Depends on T037.
- [ ] T041 [US4] Implement the staged texts and the partial result in `revert-text.ts`, `src/frontend/changes/ComparisonView.tsx`, and `src/frontend/app/Workbench.tsx`. Depends on T039, T040.

---

## Phase 7: User Story 5 — Revert in a WSL repository (Priority: P2) — batch 3

**Goal**: the same actions in a WSL repository, with the write inside the distro.

**Independent Test**: spec.md User Story 5 "Independent Test".

**Agent**: WP6 implementer. `Local: WSL`, alone.

- [ ] T042 [US5] Write the WSL tests in `tests/wsl/revert-wsl.test.ts`: the US1 to US4 fixtures in the owned folder of `Ubuntu-26.04` equal Git's own commands on a copy in the distro; the mode 0755 stays; a file of another distro user refuses with `owner` (a capability skip `second-distro-user` when the harness cannot create one without `sudo`); the gid copy; `xattr`; `shared-repository` refuses a staged part and keeps the unstaged revert available; a 40 MiB whole file reverts with no file content across the boundary, and a line revert crosses at most 1 MiB; an `interrupted` reply waits for the process-end fact. Add the file to `tests/groups.json` `serial` with the reason "WSL revert in the distro". Depends on T041. A failure is a finding for `/speckit-converge`.

---

## Phase 8: Cross-cutting safety — batch 3

**Agent**: WP4 implementer-xhigh.

- [ ] T043 [P] Write the refusal matrix in `tests/git/revert-refusal.test.ts`: every reason of data-model §7 for every action where it applies refuses before any change; the index digest and every working-file byte stay (SC-004). Spec FR-005: in a partial-clone fixture whose HEAD blob is missing, Revert file refuses before any change with the 001 missing-object remedy, and the runner records no fetch and no process without `--no-lazy-fetch`. Add the file to `tests/groups.json` `parallel`. Depends on T041.
- [ ] T044 [P] Write the race and interruption suite in `tests/git/revert-races.test.ts`: changes of the file, the index entry, HEAD, the attributes, and the configuration between the review and the run change nothing and name the fact (SC-003); an external writer during the run gives `changed-outside`; the double stops at each write step, and each target holds its old or its new bytes, never a part, never missing (SC-005). Add the file to `tests/groups.json` `serial` with the reason "checkpoint seams and timing". Depends on T041.
- [ ] T045 Fix every finding of T042 to T044 in the file that owns it (`src/git-service/revert.ts`, `revert-bytes.ts`, `src-tauri/src/file_replace.rs`, or `src/contracts/wsl-process.json`), test first. Depends on T042, T043, T044.
- [ ] T046 Batch 3 verification: `bun run typecheck`, `bun run test:contracts`, `bun run test:git`, `cargo test --locked --manifest-path src-tauri/Cargo.toml`, and the WSL files alone. Control mutation: skip the run-time SHA-256 compare of the source bytes in `revert.ts`; a T044 case must turn red. Then the batch 3 review (reviewer, with safety scrutiny), then `/speckit-converge`. Depends on T045.

---

## Phase 9: Qualification and docs — batch 4

**Agent**: WP7 implementer writes, scout runs (`Local: package`); WP8 implementer.

- [ ] T047 [P] Write the packaged tests in `tests/windows/revert-packaged.test.ts` through UI Automation and CDP: R opens the modal and Cancel has the UI Automation focus; Enter right after the open changes nothing; Tab to "Revert lines" and Enter reverts; the status region announces the result; Shift+F10 opens the row menu with the destructive group; forced colors and both themes; 150% and 225% text scale; a file that another process holds open gives the sharing-violation text and keeps its bytes; a file without write access gives the access-denied text (SC-006, SC-009, spec FR-041). A revert that expects success and gets `failed` with `access-denied` on the rename, with the old bytes (probe W9, Windows Defender), is a typed outcome and not a test failure: the test asserts the code and the old bytes and prints an `OBSERVATION` line. The full-disk and read-only-volume texts come from the double replies of T029, because the reference host cannot make a full or read-only volume without a capability (`full-volume`, `read-only-volume` skips). `Local: package`. Depends on T046.
- [ ] T048 [P] Add the revert fixture of research.md R12 to `tests/windows/perf-fixtures.ts`, and write `tests/windows/revert-perf.test.ts` for the SC-007 budgets, with the 1 GiB binary file of SC-007 and the measured disk throughput for the research.md R11 deadline rule: warm, median of 10 runs, Windows Defender on, memory through `scripts/windows/measure-ram.ps1 -Json`, and the WSL copy from the Windows package. A missed budget stays a failure (constitution VII). A run that gives `failed` with `access-denied` on the rename and keeps the old bytes (probe W9) is a typed outcome and not a test failure: the test asserts the code and the old bytes, prints an `OBSERVATION` line, and leaves that run out of the median. The application does not retry it (spec FR-037). `Local: package`. Depends on T046.
- [ ] T049 Full-run verification: `bun run test:all` with `ARBARETO_WSL_DISTRO=Ubuntu-26.04` on Windows, with `ORIGIN` lines in the checkout under test; `cargo test --locked --manifest-path src-tauri/Cargo.toml`; `bun run build:service` and `bun run test:windows`. Control mutation: let `RevertConfirm.tsx` focus the revert button first; T027 and T047 must turn red. Record the results in research.md R15. Depends on T047, T048.
- [ ] T050 Package task: `bun run package`, install the current-user NSIS package, and run T047 and T048 against the installed app. Record the build identity, the OS version, the architecture, the prerequisites, and each result in research.md R15 (constitution VI). `Local: package`. Depends on T049.
- [ ] T051 Doc pass (plan.md D14): append "Amended by feature 008 (2026-10-27): …" to `specs/001-desktop-qualification/spec.md:424`, `specs/001-desktop-qualification/contracts/operations.md:1608`, `specs/004-workbench-ux/spec.md:303`, `:322`, and `:526`, and `specs/005-inspection-file-actions/spec.md:330`. Change the label in `docs/project-brief.md:101` to "Revert file". Add one line to the README "Features": "Revert selected lines, hunks, files, or all unstaged changes, after a confirmation." Add the requirement-to-test map to research.md R15: each FR and SC with its test files and its oracle, and a statement per row that no outcome depends on Git message text, timing, a retry count, or a name pattern (spec SC-010). Use ASD-STE100, no hard wraps, and no local absolute paths. Depends on T050.
- [ ] T052 Final review (reviewer, with safety scrutiny of every destructive path and the constitution Delivery Gates), then `/speckit-converge`. Record the findings and the unverified points in research.md R15. Depends on T051.
- [ ] T053 Run `/speckit-analyze` on the final artifacts and fix every CRITICAL and HIGH finding. Depends on T052.

---

## Dependencies & Execution Order

### Phase dependencies

- Phase 1 (probes) has no dependency. T005 gates everything after it.
- Phase 2 depends on T005. T011 ends batch 0. T024 ends batch 1 and gates every story.
- Phases 3 and 4 (P1) run in batch 2: Phase 4 starts after T028, because both phases change `Workbench.tsx` and `revert.ts`.
- Phases 5 and 6 (P2) run in batch 3 after T033, in that order, for the same files.
- Phase 7 runs after T041, alone on the host.
- Phase 8 runs after T041. T045 waits for T042 to T044.
- Phase 9 runs after T046.

### Story dependencies

- US1 needs only the foundation. US2 reuses the modal and the wiring of US1. US3 reuses the files modal of US2. US4 reuses the lines path of US1 and the index split. US5 tests US1 to US4 on WSL.

### Within each story

- The failing-test task comes first. The service task follows. The frontend tests and the frontend task follow the service task.

## Parallel Example

```text
Batch 0:  T001, T002, T003 in parallel (T004 alone on WSL), then T005.
          After T005: T006 with T008 and T010 in parallel; T007 after T006; T009 after T008.
Batch 1:  Track A: T012 → T013 → T014, and T015 → T016 (WSL alone).
          Track B: T017 → T018, T019, then T020 → T021.
          Track C: T022 → T023.
Batch 2:  T025 → T026 with T027 in parallel, then T028; then T029 → T030 with T031, then T032.
```

## Implementation Strategy

- MVP: Phases 1 to 3 give US1 end to end. The v0.1.0 package needs every phase, because the user named all three actions for it (spec Clarifications).
- Deliver in batch order. Each batch ends green, reviewed, and converged before the next batch starts.
- Stop at each checkpoint and run the story's Independent Test.

## Notes

- `[P]` tasks touch different files and have no open dependency in their group.
- Commit after each task or logical group. The orchestrator commits.
- A probe finding changes research.md, plan.md, and contracts/operations.md first, then the dependent task.
