# Implementation Plan: Discard (Revert) Changes

**Branch**: `008-discard-changes` | **Date**: 2026-10-27 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/008-discard-changes/spec.md`

**Related**: [research.md](research.md) | [data-model.md](data-model.md) | [contracts/operations.md](contracts/operations.md) | [quickstart.md](quickstart.md)

## Summary

The Commit view gets three destructive actions: Revert lines or a hunk (R in the diff), Revert file (R in the Changes and Staged lists), and Revert all unstaged changes (a menu of the Changes header). Each action is a workbench action with a review and a single-use run (004 contract Δ3). The review binds every fact and fixes the exact result. A modal asks every time, with Cancel as the first focus and no default button. The run checks the facts again and publishes the index part through the existing candidate and lock path. Then it writes each working file through a widened atomic replace with an exact expected check. A fresh read decides every outcome.

Six facts drive the design (research R2 to R10):
- Git's apply and checkout remove a working file before they write the new one, so a failure leaves no file, and hard links and the read-only attribute are lost (R2). So Arbareto writes the working file itself.
- The publication path of `applyHunk` and `applyFiles` already builds and checks a private index candidate and publishes it under the owned lock (R3). The revert reuses it through one split of `publish()`.
- `git checkout-index --temp` writes Git's working-tree form of an index entry to Git's own temporary file. So Revert file needs no copy of Git's conversion logic and no size limit (R4, probes G9 and G10).
- Git's check-in conversion maps working lines to index lines one to one. `git hash-object --path --stdin` without `-w` proves the result of a line revert without a write (R5, probe G3).
- The 005 replace keeps no attribute, no creation time, and no DACL, and it can leave `.arbareto-<hex>.tmp` after a crash (R8, R9). Batch 0 probes decide each fact before the shell work starts. The shell copies Git's temporary file beside the target, so the final rename stays inside the target folder.
- `git restore <path>` runs `post-checkout`, and Arbareto runs no such command, so a revert skips no hook (R10, user decision of 2026-10-27).

## Technical Context

**Language/Version**: The 001 to 006 versions stay: TypeScript `7.0.2`, Bun `1.4.4` (exact), Rust/Cargo `1.99.0`. Main and this branch have no `rust-toolchain.toml`, so the host toolchain (Cargo 1.99.0) applies. The 007 branch pins 1.99.0 in `rust-toolchain.toml`.

**Primary Dependencies**: No new package and no new Rust crate. The shell uses the installed `windows` crate features of `file_replace.rs` and `file_facts.rs`. Probe W2 showed that the swap loses the file's own DACL (research R15). The DACL copy uses `GetKernelObjectSecurity`, `SetSecurityDescriptorControl` with `SE_DACL_AUTO_INHERIT_REQ`, and `SetKernelObjectSecurity` on a handle, all in the enabled feature `Win32_Security` (T013). No new `windows` feature is needed.

**Storage**: None. The feature changes repository data only: the index through the owned lock, and working files through the atomic replace.

**Testing**: Bun tests in real disposable repositories with Git oracles on a copy (`tests/git`). Contract tests and golden vectors (`tests/contracts`, `tests/vectors`). Cargo tests for the shell. Windows fact and packaged tests (`tests/windows`). WSL tests in `Ubuntu-26.04` with Git 2.55 (`tests/wsl`).

**Target Platform**: Windows 11 x64 with WebView2 and Git for Windows (2.56.0.windows.2 on the reference PC). WSL2 repositories run the distro's Git. The Git floor stays 2.55.0.

**Project Type**: Local-first desktop application: Tauri 2 shell, compiled Bun Git service, React renderer.

**Performance Goals**: Spec SC-007, fixed before the measurement: busy state within 100 ms after R; the confirmation or the refusal within 500 ms for a file up to 1 MiB, and within 3 s for 1,000 files; the refreshed diff within 500 ms after the confirmation for a line, hunk, or single file; 100 files within 3 s; 1,000 files within 10 s on Windows and 30 s on WSL; Cancel within 1 s; at most 64 MiB process-tree memory increase at 10,000 files; one 1 GiB file within 30 s with at most 64 MiB service memory increase. The 001 SC-005 input targets hold throughout (spec FR-048). Method: research R12.

**Constraints**: No Git command writes a target file. Git writes only its own temporary file through `checkout-index --temp` (spec FR-031). No repository program runs (spec FR-004). The renderer sends IDs, line numbers, and the action only, never a path or bytes. The service log keeps its allowlist fields (`log.ts`), so no file content enters a log (spec FR-049). Every outcome comes from a fresh read.

**Scale/Scope**: At most 10,000 files per action (`MULTI_FILE_ACTION_FILES`). Revert file and Revert all unstaged changes have no size limit. Line revert stays within the 001 comparison bounds (1 MiB per version and 20,000 diff lines) and reads at most 1 MiB of working bytes. These bounds keep its frame within `REVERT_FILE_BYTES` (2,117,152 bytes, research R11).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Checked against principles I to IX of `.specify/memory/constitution.md` version 4.0.0 on `main` `80f32119`, footer "**Version**: 4.0.0 | **Ratified**: 2026-09-28 | **Last Amended**: 2026-10-22", before research and again after Phase 1. Version 4.0.1 on the branch `007-first-release` changes only the Delivery Gates definition of "production release" (research R1), so the result is the same for both.

| Principle | How the design meets it | Status |
|---|---|---|
| I. Preserve user data | Every action asks in a modal that states its scope, its effects, and "You cannot undo this." Cancel has the first focus, and no button is the default (D11, D12). The review binds every fact, and the run checks them again and before each write (D2). The index part publishes only a checked candidate under the owned lock (D7). Each working file is replaced in one atomic step with an exact expected check, so it never goes missing (D8, D9). A fresh read decides the outcome, and Cancel never reports an undo (D10). Principle I of version 4.0.0 states "Operations MUST NOT bypass Git hooks". A revert runs no Git command that runs a hook, so it skips none (note N-1). | Pass, note N-1 |
| II. TypeScript/Bun | The review, the line logic, the proof, the plan, and the outcome rules are TypeScript (D3 to D6, D10). Rust changes only the atomic replace and the file facts, which need Windows handle-relative NT calls (`NtSetInformationFile`, `FileBasicInformation`, and the security calls of research R8) that shared code cannot reach (D8). | Pass |
| III. Validated boundaries | Three typed workbench actions with zod schemas and explicit Rust checks (contract Δ1 to Δ3). The renderer names a snapshot, entry IDs, a comparison, a hunk, and line numbers. The shell checks every path below the worktree root by identity and refuses the Git directory (contract Δ6). Every read and write has a bound and Cancel (contract Δ5). | Pass |
| IV. Real Git verification | Every story test runs in a real disposable repository and compares the index and the working bytes with Git's own command on a copy (D13). Stale, race, interruption, and refusal fixtures assert that nothing changes (SC-003 to SC-005). | Pass |
| V. Untrusted repositories | No repository program runs. Filter drivers and Git LFS refuse (D2). Paths show as plain text (spec FR-010). No file content or diff text enters a log (spec FR-049). | Pass |
| VI. Platform evidence | Packaged Windows tests for the keys, the modal focus, the menus, the budgets, a file in use, and Windows Defender (WP7). WSL tests on Ubuntu-26.04 (WP6). Each probe that needs a missing capability records it as unverified (note N-2). | Pass, note N-2 |
| VII. Accessible and measured | Every new control has a label, a tooltip with its key, an accessible name, visible focus, and a stated reason when unavailable. The revert items stay in separate destructive groups (D12). The budgets are fixed above and in research R12, before measurement. | Pass |
| VIII. Locked dependencies | No new package, no new crate, and no new `windows` feature. The DACL copy uses the enabled feature `Win32_Security` (research R15, Technical Context). | Pass |
| IX. One planning process | All artifacts stay in `specs/008-discard-changes`. The contract lists only deltas to 001 to 006. The earlier specs change only in the doc pass (D14). | Pass |

Notes from the second check:
- **N-1 (constitution 4.0.0, principle I, "Operations MUST NOT bypass Git hooks")**: Git's own `git restore <path>` runs `post-checkout` with the flag 0 (research R10). A revert runs no checkout, restore, or switch. It changes the index through `update-index`, whose only hook is `post-index-change`, and that hook refuses the staged part. Git writes only its own temporary file through `checkout-index --temp`, which runs no hook and writes no index (research R10, probe G10). So a revert runs no Git command with a hook, and no hook is skipped. The user confirmed this reading on 2026-10-27. The reading lives in the spec Clarifications and in this note. The constitution gets no patch.
- **N-2 (VI, "Untested behavior MUST remain explicitly unverified")**: research R14 lists the probes with capability skips: the owner of a file that an elevated process created (W2), EFS (W11), POSIX ACLs in the distro (L6). The SACL and the mandatory label stay a known limit (R8).
- **N-3 (Delivery Gates)**: safety tests (SC-001 to SC-006), trust boundaries (spec FR-004), accessibility checks (SC-009), performance budgets (SC-007), and platform qualification (WP6, WP7) are defined here. Each batch ends with one independent review with explicit safety scrutiny of the destructive paths.

No violation, so Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/008-discard-changes/
├── spec.md
├── plan.md                 # This file
├── research.md             # Phase 0
├── data-model.md           # Phase 1
├── quickstart.md           # Phase 1
├── contracts/
│   └── operations.md       # Phase 1: deltas to the 001 to 006 contracts
├── checklists/
└── tasks.md                # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── contracts/              # operations.ts (phases, marker actions), envelope.ts (payloads, plans, results), errors.ts (reasons),
│                           # limits.ts (REVERT_FILE_BYTES), wsl-process.json (wslFiles replace), schemas/
├── git-service/            # hunk-publish.ts (publishIndex split), multi-publish.ts (unstage prepare export), support.ts (ident),
│                           # commands.ts (checkout-index --temp, hash-object --path, check-attr --cached), git-runner.ts (fileReplace working, fileFacts detail),
│                           # workbench-review.ts (classless, stale reason), session.ts
│                           # new: revert.ts (the three handlers), revert-bytes.ts (line logic, ending rule, blob ID; no I/O)
└── frontend/               # changes/{HunkControls,ChangesPane,ComparisonView}.tsx, keyboard/shortcuts.ts, app/Workbench.tsx, history/CommitChanges.tsx, bridge.ts
                            # new: changes/{RevertConfirm.tsx, revert-text.ts}
src-tauri/src/              # file_replace.rs (working target, file facts, delete-on-close temp, folders), file_facts.rs (detail), process_requests.rs, schema.rs, wsl.rs
tests/
├── contracts/              # new: revert-contract.test.ts, shortcuts-008.test.ts, revert-confirm.test.tsx, revert-menus.test.tsx, revert-keys.test.tsx
├── git/                    # new: revert-facts.test.ts, publish-index.test.ts, revert-frame.test.ts, revert-bytes.test.ts, revert-lines.test.ts,
│                           #      revert-staged.test.ts, revert-files.test.ts, revert-unstaged.test.ts, revert-refusal.test.ts, revert-races.test.ts;
│                           #      changed: bun-runner.ts and bun-runner.test.ts (double); tests/contracts/support.test.ts (ident)
├── vectors/                # new: valid/revert-*.json and invalid/revert-*.json
├── wsl/                    # new: revert-facts.test.ts, revert-wsl-files.test.ts, revert-wsl.test.ts
└── windows/                # new: revert-facts.test.ts, revert-packaged.test.ts, revert-perf.test.ts; changed: perf-fixtures.ts
```

**Structure Decision**: The three-part layout stays: renderer, Bun service, and shared contracts, with a thin Tauri shell. `revert-bytes.ts` holds only pure functions on bytes, so its unit tests need no repository, and it holds no Win32 or WSL code (portability rule).

## Design

### Steps (riskiest proof first)

| Step | Files and symbols | Behavior change | Tests that prove it | Main risk |
|---|---|---|---|---|
| P0.1 Git facts | new `tests/git/revert-facts.test.ts` (WP1) | None. | G3 to G10 of research R14. | `checkout-index --temp` differs from Git's restore for a conversion (G9). R15: no fixture differs, so no refusal covers it. |
| P0.2 Windows facts | new `tests/windows/revert-facts.test.ts`, probe cargo tests in `file_replace.rs` (WP1) | None. | W1 to W11. | Clearing the delete disposition fails on the host (W6). Then the 005 temporary name stays with a recorded window. |
| P0.3 WSL facts | new `tests/wsl/revert-facts.test.ts` (WP1) | None. | L1 to L7. | `linkat` through `/proc/self/fd` fails from Perl (L2). Then the 005 temporary name stays. |
| P1 Contracts | `src/contracts/*`, `tests/vectors/` (WP2) | Adds the actions, phases, reasons, bounds, keys, and the `ident` attribute read. | Schema tests, vectors, the shortcut map test. | typify drops ranges. Keep explicit Rust checks. |
| P2 Shell replace | `file_replace.rs`, `file_facts.rs`, `process_requests.rs`, `wsl.rs`, `wsl-process.json` (WP3) | `fileReplace` gains the `working` target with the R8 and R9 facts. `fileFacts` gains `detail`. | Cargo tests per fact and refusal. WSL replace tests. | The DACL copy needs a `windows` feature (W2, Technical Context). |
| P3 Index split | `hunk-publish.ts`, `multi-publish.ts` (WP4) | None for staging. `publishIndex` becomes callable from a workbench run. | The whole existing staging suite stays green, plus `publish-index.test.ts`. | A changed order of lock and claim events. The suite catches it. |
| P4 Service actions | new `revert.ts`, `revert-bytes.ts`, `support.ts`, `commands.ts`, `workbench-review.ts` (WP4) | US1 to US4 in the service. | SC-001 to SC-005 in `tests/git`. | The partial outcome after a published index (D10). |
| P5 Frontend | `changes/*`, `keyboard/shortcuts.ts`, `app/Workbench.tsx` (WP5) | The menus, the keys, the modal, progress, and results. | Component tests per FR. | The modal focus in WebView2 (WP7 checks it in the package). |
| P6 WSL | `tests/wsl/revert-wsl.test.ts` (WP6) | None (tests). | US5, SC-008. | The hex input of a line revert (up to 4,234,304 bytes of hex) through `wsl.exe` stdin. |
| P7 Qualification | `tests/windows/revert-packaged.test.ts`, `revert-perf.test.ts` (WP7) | None (tests). | SC-006, SC-007, SC-009, SC-011. | Windows Defender holds a file during the rename (W9). |

Each step writes its tests first.

### D1 Contracts

[contracts/operations.md](contracts/operations.md) holds the deltas. Summary:
- `reviewWorkbench` gains the actions `revert-lines`, `revert-files`, and `revert-unstaged`. `runWorkbench` runs them. No new operation name.
- Phases `revert-index` (no counters) and `revert-files` (`fileIndex`, `fileCount`). Marker actions `revert-lines`, `revert-files`, and `revert-unstaged`.
- `fileReplace` gains the target `working`, with `bytes` (lines) or `source` (Git's temporary file, whole files). `fileFacts` gains `detail` and a streamed digest without the 1 MiB bound. The new private request `tempRemove` removes an unused Git temporary file.
- New `WORKBENCH_UNAVAILABLE` reasons and the `STALE_REVIEW` reason `revert-changed`.
- `REVERT_FILE_BYTES` (2,117,152 bytes): the frame bound of a line revert, which the 001 comparison bounds always keep (research R11). Whole files have no size bound.
- A review refusal names the first 20 refused files in tree order with their reasons, and the count of the rest (contract Δ3, spec FR-022, FR-029).

### D2 Review and run frame

- The three actions register through `registerWorkbenchAction` (`workbench-review.ts:103`) in the new `revert.ts`. They join `CLASSLESS` (`:114`), because no step runs a repository program. They do not join `IN_PROGRESS_ALLOWED` (`:109`), so `OPERATION_IN_PROGRESS`, `unknown-operation`, and `CONFLICTED` refuse them (spec FR-002). `STALE_REASONS` and `FACT_REFUSALS` (`:119`, `:121`) gain the three actions with `revert-changed`.
- Review (`observe`): the common reads of the frame (HEAD, operation state, trust listing), then the action reads of D3 to D6. The bound holds the facts of data-model §2. The plan holds the confirmation fields of data-model §5. The 60 s token lifetime (`APPROVAL_LIFETIME_MS`) applies, so a late run gets `APPROVAL_EXPIRED` (spec FR-011).
- Run: the frame observes everything again and compares the bound with `Bun.deepEquals` (`staleOf`, `:287`). A difference gives `STALE_REVIEW` with `revert-changed`, and nothing runs. Then the run executes the parts of D7 to D9 in order and reconciles (D10). `observeBefore` is false, because the run reads the index itself in its reconcile.
- Reads that load the index (`ls-files`, `check-attr --cached`, `diff`) wait behind the 001 read gate. A `core.fsmonitor` command refuses through the hunk eligibility (`executable-monitor`, `unqualified-monitor`) before any of them.
- Index lock: the review reads the fact of `index.lock` in the Git directory (`fileFacts`, as the 001 lock guidance names the path). A present lock refuses every revert with `LOCKED` and the 001 remedy (`lockRefusal`, `hunk-publish.ts:118`). The bound holds `indexLock: absent`, so the run's full observation checks it again. A lock that appears during the working part does not stop it: each write keeps its exact expected check (spec Edge Cases).
- Common refusal order per path, before any action-specific step: the repository-level refusals (operation, conflicts, busy, index lock), the hunk eligibility of D7 (`sparse-index`, `split-index`, and for a staged part `index-change-hook` and WSL `shared-repository`), the 001 support reasons of the comparison, then the file facts of D8 or D9, then `attributes` (research R7), then the size bounds.

### D3 Revert lines, unstaged

- Payload: `{action: "revert-lines", snapshotId, comparisonId, hunkId, lines?}`. The comparison is a retained `index-to-worktree` comparison (`o.comparisons`, as `admit` in `hunk-publish.ts:945`). `lines` uses the 004 line selection form.
- Review: the sub-hunk through `subHunk` with the `unstage` rule: an unselected `+` line becomes context, and an unselected `-` line drops. So the partial patch stands against the working side, the new side of the comparison, and the review applies it reversed (data-model §4). The comparison scope stays `index-to-worktree`. The revert calls `subHunk` directly, not through the `admit` direction check of `hunk-publish.ts:954`. Then the working bytes, at most 1 MiB (research R4, R11): the Windows service reads them through `workingOf` with the bound `COMPARED_RAW_VERSION_BYTES` (`hunk-publish.ts`), not through `wholeWorking`, whose bound is `WHOLE_FILE_STAGE_INPUT_BYTES`; WSL reads them through `fileFacts` with `content: true`. A larger working file refuses with `size`. Their size and SHA-256 must equal the comparison binding. Then `ls-files --eol -z` for the path, `check-attr` and `check-attr --cached` (research R7), and `ident` (research R6).
- Bytes: `revert-bytes.ts` `reverseLines(working, hunk, ending)` removes the selected `+` lines, inserts the selected `-` lines with the R5 ending rule, and keeps every other raw line (data-model §6).
- Proof: `hash-object --path=<path> --stdin` of the new bytes must print `blobId(expected)`, where `expected` is the check-in form of the working side with the hunk reversed. `revert-bytes.ts` computes both in memory. A difference refuses with `line-endings`.
- Bound: the new SHA-256 and size. Plan: `{kind: "lines", scope: "unstaged", file, lines: n | null}`.
- Run: D8 or D9 write with `expected` = the bound working size and SHA-256. No index part.

### D4 Revert lines, staged

- The comparison is a retained `head-to-index` comparison. The review refuses with `unstaged-changes` when the status record of the path has a worktree letter other than `.` (Clarifications, 2026-10-27).
- Index part: the existing Unstage lines candidate (`applyToContent` in `hunk-candidate.ts:104` through the `prepare` of `hunk-publish.ts:978`), bound to the same comparison and line selection.
- Working part: because the file has no unstaged change, its check-in form equals the index blob. The review reads the raw working bytes with the D3 read and its 1 MiB bound, so a larger working file refuses with `size`. It applies the same reversed sub-hunk to them with the R5 rule. The proof compares `hash-object --path` of the new bytes with the blob ID of the new index content.
- Run order: the index part first, then the working write (spec FR-017, D10).

### D5 Revert file

- Payload: `{action: "revert-files", snapshotId, entryIds}` with 1 to 10,000 IDs of the Changes or Staged list of one snapshot. A folder row sends no request: the renderer shows the folder reason (spec FR-023).
- Review per entry: the status record gives the HEAD, index, and worktree modes and object IDs. The index part is the 004 Unstage files candidate (`update-index -z --index-info` with the HEAD entries, `commands.ts:411`) for every entry whose index entry differs from HEAD. A staged new file loses its entry, and its working file stays (spec FR-021). The working part writes each entry that HEAD holds through D5a, after the index part. The review binds the HEAD entry and the current target facts (size and a streamed SHA-256), not the new bytes.
- A deletion binds `absent` and the list of missing folders. An untracked status record at the same path refuses with `in-the-way`.
- Plan: `{kind: "files", count, paths (first 20 in tree order), newFiles, staged, unstaged}`.

### D5a Whole-file write through `checkout-index --temp`

Revert file and Revert all unstaged changes write each file in batches of at most 64 paths, in tree order (research R4):
1. Read `ls-files --stage -z` for the batch paths and the raw index digest. Each entry must equal the plan (for Revert file, the published HEAD entry).
2. Run `git --no-lazy-fetch checkout-index --temp --stdin -z` in the worktree root, with the batch paths on stdin, NUL-ended. Git writes each entry to `.merge_file_<random>` in the worktree root and prints `<temp> TAB <path> NUL` (source facts, probe G10). The service parses each record exactly: the temporary name must be one path component, and the path must be one of the batch paths. Any other output gives `MALFORMED_GIT_OUTPUT`, and the run removes every named temporary file (step 6).
3. Read the entries and the raw index digest again. A difference from step 1 gives `STALE_REVIEW` `revert-changed` for the batch, and step 6 removes the temporary files.
4. Read `fileFacts` with a streamed digest of each temporary file. This gives the size and the SHA-256 of the new bytes.
5. Per file, send `fileReplace` `working` with `source: {name, size, sha256}` (D8, D9). The shell copies the temporary file beside the target with a streamed SHA-256, checks the size and the digest, swaps the copy over the target with the expected check, and removes the source through its held handle.
6. Each temporary file that no `fileReplace` consumed goes through `tempRemove` with its size and SHA-256. A stop between step 2 and step 6 leaves it (spec FR-036 known limit).

Rules:
- `checkout-index --temp` takes no index lock and writes no index (`builtin/checkout-index.c`, `--temp` branch). It runs no hook (research R10). It loads the index, so the eligibility refusals and the read gate apply (D2). The review refuses `filter` and `LFS` before step 2, so Git runs no filter program (spec FR-004).
- Probe G9 gave the bytes of Git's restore for each fixture on Windows and in the distro (research R15). So the review has no refusal for the output of `checkout-index --temp` (user decision, 2026-10-27).
- The final rename stays inside the target folder, so the volume rule holds for it. The Git temporary file lies in the worktree root, on the same volume as every target that the walk reaches, because the walk refuses every reparse point on the path. A WSL `st_dev` that differs between the root and the target folder refuses with `not-regular`.
- A target bound as absent gets the folder ACL on Windows, because the copy is created in the target folder. On WSL it gets `0777 & ~umask` for an entry with mode 100755 and `0666 & ~umask` for 100644, as Git's checkout creates a file (`entry.c` `create_file`).

### D6 Revert all unstaged changes

- Payload: `{action: "revert-unstaged", snapshotId}`. The service takes every entry of the snapshot with a worktree letter other than `.` and a tracked status record, including the rows that Filter files hides. Submodule entries (`S…` or mode 160000) are counted and left out.
- Review per entry: the source is the index entry. The run writes it through D5a. No index part.
- A refusal of any entry makes the whole action unavailable, and the reason names the first 20 files in tree order with their reasons (Clarifications, 2026-10-27).
- Plan: `{kind: "unstaged", count, paths, submodules}`. The renderer adds the hidden count from its filter (data-model §5).

### D7 Index part

- `publishIndex(session, steps)` is the `steps()` closure of `publish()` (`hunk-publish.ts:841-894`) as an export. It takes the owned lock (Windows `createIndexLock`, WSL `wslLock` after its process-end anchor), runs `steps.prepare`, publishes the checked candidate, and returns `Ending` and the owned files. `publish()` calls it, so the staging paths keep one code path and their tests.
- The revert run calls `publishIndex` inside its workbench run with the progress phase `revert-index`. Its `releaseOwned` and the foreign-file list feed the revert reconcile (D10). A lock refusal gives the 001 lock guidance (`lockRefusal`, `:118`), and no working file changes.
- `prepare` for staged lines: the Unstage lines `prepare` with the bound sub-hunk. For Revert file: the `multi-publish.ts` `prepare` with the direction `unstage` and the bound items. Both export their `prepare` for this call.
- The claim: the workbench token is the single-use claim, so the publication claim always consumes.

### D8 Working-file write on Windows

- `fileReplace {repositoryId, target: "working", path, expected, facts, bytes | source, folders}` (contract Δ6). `bytes` carries a line revert. `source` names Git's temporary file in the worktree root with its size and SHA-256. The shell checks the path below the worktree root with `file_facts::below`, refuses a first component that names the Git directory or `.git`, and requires the started marker action of the run.
- `check` (`file_replace.rs:118`) keeps its walk, its held parent, its held target, and its size and SHA-256 compare. It adds the R8 facts under the held target handle: the attributes, the link count (`hard-link`), the read-only and encrypted attributes, the owner, group, and DACL. Any difference from `facts` gives `stale`. The target digest streams through the held handle, so `check` has no 1 MiB read bound for this target.
- `write` (`:180`) creates the temporary file with the delete disposition on close (W6). It sets the attribute set and the creation time through `FileBasicInformation` (W1, W3). The rename sets the archive attribute, so the archive attribute is no compared fact (research R15). W2 showed that the swap loses the file's own DACL (research R15), so it copies the old descriptor with `SE_DACL_AUTO_INHERIT_REQ` set through `SetKernelObjectSecurity` (T013). It compares the resulting owner, group, and DACL with the old file, and a difference refuses with `security`. The copy before the write keeps the same facts as the copy after it (W1, W2, W3 `copy-first`, research R15). Then it writes `bytes`, or copies `source` with a streamed SHA-256 that must equal the request, flushes, clears the delete disposition, and renames with `FILE_RENAME_POSIX_SEMANTICS | FILE_RENAME_REPLACE_IF_EXISTS`. A target bound as absent renames without `REPLACE_IF_EXISTS`, so an existing name gives `stale` (as 005 N7).
- `security` after an index part (review of 2026-10-30). The DACL copy keeps the descriptor in all 10 W2 cases, also when the old file has other inherited ACEs than its folder gives a new file (`renamed-in`, `folder-ace-after`, research R15). So no probed file reaches the `security` refusal, and the review needs no trial file. The write keeps its compare as the guard. If a file still gives `security` after a published index part, the D10 row "published, some files not reverted" applies: `failed-with-effects`, and the file gets `not-changed` with the code `refused` and the reason `security` (data-model §8).
- `source`: the shell opens the named file relative to the held worktree root without following a link, and requires a regular file with one link and the requested size. After the rename, and after every failure that comes after the source open, it deletes the source through that handle. A failure before the open leaves the source to `tempRemove` (D5a step 6).
- `tempRemove {repositoryId, name, expected: {size, sha256}}`: one file in the worktree root, deleted through its handle only when its facts equal `expected`. Reply `removed`, `stale`, `absent`, or `error {code}`.
- `folders` lists the missing folder names below the deepest existing folder. The shell creates each with `FILE_CREATE` and `FILE_DIRECTORY_FILE` relative to the held parent and `OBJ_DONT_REPARSE` (W10).
- Reply: `replaced`, `stale`, `refused {reason}` (`not-regular`, `hard-link`, `read-only`, `encrypted`, `owner`, `security`, `file-attributes`), `error {code}` (`sharing-violation`, `access-denied`, `disk-full`, `read-only-volume`, or another code), `stopped`, plus `folders` created.
- The R8 table decides each fact. A probe that differs changes this section before WP3 (research R8 rule).

### D9 Working-file write on WSL

- The same request reaches `wslFiles` mode `replace` with the root `worktree` and any path below it. The Perl `replace_one` (`wsl-process.json`) keeps its walk and its checks, and adds: the `st_uid` compare (`owner`), the `llistxattr` check (`xattr`), the `O_TMPFILE` create and the `linkat` name just before the rename (L1, L2), and `mkdir` of the missing folders (L7). The temporary file steps run in this order: the gid copy `fchown(-1, old gid)` (`EPERM` refuses with `owner`), the write, `fsync`, `fchmod` of the old `st_mode & 07777`, an `fstat` compare of those mode bits, then `linkat`. A write and an unprivileged `chown` each clear the set-user-ID and set-group-ID bits (chown(2), probe L4, research R15), so the mode copy comes after both. `fchmod` can drop the set-group-ID bit without an error (chmod(2)), so the `fstat` compare proves the bits, and a difference refuses with `owner` (spec FR-043).
- A line revert: the bytes cross in hex on stdin, at most `REVERT_FILE_BYTES` (contract Δ11). The WSL read of the working bytes uses `fileFacts` with `content: true` (at most 1 MiB).
- A whole file: no content crosses. Git writes its temporary file inside the distro. The Perl `replace_one` opens it relative to the root with `O_NOFOLLOW`, checks its `fstat` against `lstat`, copies it into the `O_TMPFILE` file beside the target with a streamed SHA-256, and unlinks the source after the identity check. `tempRemove` runs the same identity check.
- A staged part refuses with `shared-repository` (`eligibility.ts:225`) when any scope sets `core.sharedRepository`. An unstaged revert writes no repository file, so that reason does not apply to it.
- A stop, a deadline, or a broken output of `replace` gives `interrupted`. The reconcile waits for the process-end fact before the fresh read (`workbench-review.ts:360`).

### D10 Outcome and failure handling

- Reconcile reads after every run, also after Cancel and failure: the index entries of every path (`ls-files --stage -z` with the bound object format), `fileFacts` with `digest: true` for every path, and `readWorkspace`.
- Per-file outcome (data-model §8): `reverted` (the index entry and the digest equal the plan), `unstaged-only` (the index entry equals the plan, the digest equals the old file), `not-changed` (both equal the old state), `changed-outside` (the digest equals neither), `not-started` (no request reached the file). A `not-changed` file carries the reply code `stale`, `refused` with its reason, or `error` with its code. This is the "failed with its code" outcome of spec FR-039. A `not-changed` file without a code got `stopped` or `interrupted`.
- Response state. Each row needs the fresh read. A Cancel never turns an effect into `canceled`, and it never reports an undo (spec FR-039, constitution I). The Cancel rows follow 005 plan D6 "Response state".

| Index part | Working writes | Response | Code |
| --- | --- | --- | --- |
| none, or published | every file `reverted` | `succeeded` (intended effects confirmed), also after a late Cancel | none |
| refused before publication | none started | `failed` (no effects) | the refusal code, such as `STALE_REVIEW` or the lock code |
| published | some files not reverted | `failed-with-effects` | the first file in tree order names its code |
| published | Cancel before the last file | `failed-with-effects` | none; the result names each file outcome |
| none | some files `reverted` or `changed-outside`, then a failure | `failed-with-effects` | the first file in tree order that did not revert names its code |
| none | some files `reverted` or `changed-outside`, then Cancel | `failed-with-effects` | none; the result names each file outcome |
| none | no file changed, Cancel | `canceled` | none |
| none | no file changed | `failed` | the code of the first file in tree order |
| unknown (WSL without a process-end fact, or a failed reconcile read) | — | outcome unknown; the recovery marker stays (001 FR-023) | `GIT_FAILED` or `DEADLINE` |

- Cancel: before the lock, nothing runs. After the publication starts, the index part ends, because the publication is one rename. Between files, the run stops before the next request. A started `fileReplace` ends without a stop, as in 005.
- Git temporary files: D5a step 6 removes every unused one before the reconcile reads.
- The index part never rolls back. When the working part stops after a published index, the result states the FR-017 text, and the file shows its working changes as unstaged.
- A crash during a run leaves the 001 recovery marker of kind `workbench`. The next start reconciles and reports the outcome as unknown until a refresh (001 FR-023).

### D11 Texts

`src/frontend/changes/revert-text.ts` holds every visible text of the spec, with these constants:
- `REVERT_TITLE`, `REVERT_BODY`, `REVERT_BUTTON` per kind (lines, hunk, staged lines, staged hunk, files, unstaged), with the singular forms of spec FR-009. `NO_UNDO` = "You cannot undo this."
- `NEW_FILES_LINE`, `SUBMODULES_LINE`, `HIDDEN_LINE`, `MORE_FILES` (005 FR-026 form).
- `REVERT_REASON` per reason of spec FR-038, and `LINE_REVERT_TEXT` for the five line reasons. The comparison limitations keep `LIMITATION_TEXT` (`limitation-text.ts`), and the eligibility reasons keep `PROFILE_TEXTS`.
- `REVERT_DONE` (spec FR-040), `REVERT_PARTIAL` (FR-017), `REVERT_EXPIRED` (FR-011), `REVERT_FAILURE` (FR-041), `REVERT_PROGRESS` ("Reverting <i> of <n>"), `REVERT_CHECKING` ("Checking <n> files…"), `NO_HUNK` (existing "No hunk is selected.").
- Item labels: "Revert hunk…", "Revert <n> lines…", "Revert file…", "Revert <n> files…", "Revert all unstaged changes…", and the tooltip "More actions".

### D12 UI, keys, and menus

- Keys (`keyboard/shortcuts.ts` `KEYS`): `revertLines` = `R` in scope `diff`; `revertFiles` = `R` in the new scope `stagedList` and in `changesList`. `scopedAction` matches letters by `keyCode`, ignores a composing event, and an editable target never reaches it (`isEditable`). A repeat key event opens nothing (`event.repeat`, as Delete in `ChangesPane.tsx:791`). `CommitChanges.tsx:552` ignores `revertLines`, so R in the History diff does nothing.
- Diff: each hunk gets a "More actions" icon button beside Stage hunk or Unstage hunk (`HunkControls.tsx`). It opens the house action menu (`components/action-menu.tsx`) with a destructive group: "Revert hunk…" (R), and with a line selection in that hunk "Revert <n> lines…" (R). An unavailable item states its reason.
- Changes list row menu: the 005 destructive group gets "Revert file…" or "Revert <n> files…" (R) beside "Delete…" and "Delete permanently…". Staged list row menu: a new destructive group with the same item. Changes header: a "More actions" button with a destructive group "Revert all unstaged changes…".
- Modal: `RevertConfirm.tsx` follows `DeleteConfirm.tsx` (`initialFocus` on Cancel, `finalFocus` to the opener) as an alert dialog. Its revert button has the destructive style, no default role, and no access key. Enter on Cancel cancels. The renderer shows the plan of the review only.
- Busy and progress: the status bar shows `REVERT_CHECKING` during the review and `REVERT_PROGRESS` during `revert-files`, with Cancel. The result goes to the status region, which assistive technology announces.
- The mockup through the arbareto-ux skill comes first (WP5 first task). Its boards decide the button sizes and the menu order within these rules.

### D13 Tests and fixtures

- Oracles: Git's own commands on a copy of the fixture: for lines, see the line oracle below; `git restore --staged --worktree --source=HEAD` for Revert file (minus the staged-new-file difference of G7); `git restore .` for Revert all unstaged changes. The tests compare index bytes through `ls-files --stage -z` and working bytes by SHA-256.
- Line oracle. Git's `apply -R` converts the whole working file again, so it gives CRLF for every line of an LF file under `core.autocrlf=true`. The R5 rule keeps such a file LF (probe G5 `apply-reverse` record, research R15). So a line revert passes when both checks hold. First, `hash-object --path` of the new bytes equals the blob of `git apply --cached -R` of the same partial patch on a copy after `git add` of the path. Second, every unselected line keeps its raw working bytes. For a staged revert, the index also equals `git apply --cached -R` of the patch on a copy. A fixture without a conversion also equals `git apply -R` byte for byte.
- The test double (`tests/git/bun-runner.ts`) implements `fileReplace` `working` with `bytes` and `source`, and `tempRemove`, with the same expected checks on the host file system, and records each request. The shell behavior has its own cargo tests and the packaged tests.
- Seams: `revertCheckpoint({step: "before-index" | "after-index" | "before-write", path})` in the service run for the race fixtures, as `hunkCheckpoint` (`hunk-publish.ts:74`). Production passes none.
- Fault fixtures: the double stops at each write step; the cargo tests kill a child that holds the temporary handle (W6); the WSL test kills the distro process (L3).
- Each new `tests/git`, `tests/contracts`, and `tests/wsl` file gets its line in `tests/groups.json` in its task.

### D14 Earlier spec lines and docs

The doc pass (WP8, after the full run of WP7) appends one sentence "Amended by feature 008 (2026-10-27): …" to each line below, as feature 005 amended 004 FR-045:
- `specs/001-desktop-qualification/spec.md:424` (FR-027): the revert actions are allowed behind their confirmations.
- `specs/001-desktop-qualification/contracts/operations.md:1608` (§11): the bytes of one file of a line revert, at most 1 MiB out and at most `REVERT_FILE_BYTES` (2,117,152 bytes) in, cross the distro boundary. A whole-file revert crosses no content.
- `specs/004-workbench-ux/spec.md:303` (Scope Boundaries): the discard exclusion goes.
- `specs/004-workbench-ux/spec.md:322` (the 001 FR-027 change): the revert actions join the allowed list.
- `specs/004-workbench-ux/spec.md:526` (Assumptions): the discard assumption goes.
- `specs/005-inspection-file-actions/spec.md:330` (FR-023): the destructive group also holds "Revert file…".
- `docs/project-brief.md:101`: the label "Discard changes" becomes "Revert file".
- `README.md` "Features": one line for Revert lines, hunks, files, and all unstaged changes, after a confirmation.
These lines stay unchanged: 001 FR-013 (`:404`), 001 FR-038 (`:447`), 004 FR-042 (`:403`), 004 `:548`, 003 `:226`, 005 `:266`, and the brief `:49`.

### Invariants

- No Git command writes a target file. Git writes only its own temporary file, through `checkout-index --temp`.
- No working file is ever missing or partly written: the old bytes or the new bytes, at every moment.
- No write happens without an exact expected check of the target under the held handle.
- The index changes only through a checked candidate under the owned lock.
- No outcome comes from Git message text, timing, a retry count, or a name pattern.
- No modal reverts on Enter alone.

## Open items and reviewer defaults

- The R8 and R9 tables are decisions with probes. A probe result that differs changes them before WP3 (research R14 rule).
- Revert file has no size bound (Clarifications, 2026-10-27). A line revert keeps the 001 comparison bounds, which keep its frame within `REVERT_FILE_BYTES` (research R11).
- The DACL copy method is decided (research R15, user decision of 2026-10-27). T013 tests it, and T014 builds it.
- The placement of "More actions" and the menu order follow the mockup (WP5).
- `docs/project-brief.md:101` changes its label example (D14). The brief is not a spec.

## Phases

### Batches

| Batch | Work packages | Content |
| --- | --- | --- |
| 0 | WP1, then WP2 | The probes G, W, and L, the fact gate, then the contracts, the keys, and the `ident` read. |
| 1 | WP3, WP4 (foundation), and WP5 (mockup only) in parallel | The shell replace and facts (local Rust and WSL); the index split, the test double, and the revert frame; the mockup for user approval. |
| 2 | WP4 (US1, US2), then WP5 (US1, US2) | The two P1 stories end to end: unstaged lines and hunks, and Revert file. |
| 3 | WP4 (US3, US4), then WP5 (US3, US4), then WP6 alone, then the safety suites | Revert all unstaged changes, staged lines, the WSL stories, and the refusal, race, and interruption suites. |
| 4 | WP7, then WP8 | The packaged tests, the budgets, the full run, the package, then the doc pass. |

Each batch ends with its verification task, one independent review (`reviewer`, with safety scrutiny of every destructive path), and `/speckit-converge`. A WSL run runs alone on the host, so the other tracks pause their test runs during it.

### Work packages, in run order

- **WP1 Facts** (implementer; W probes `Local: Windows` and `Local: Rust`; L probes `Local: WSL`, alone): research R14 G3 to G10, W1 to W11, L1 to L7, and the fact gate into R15.
- **WP2 Contracts** (implementer): contract Δ1 to Δ10, the schemas, the vectors, `KEYS`, and `SUPPORT_ATTRIBUTES` with `ident`.
- **WP3 Shell** (implementer-xhigh, `Local: Rust`, `Local: WSL`): D8 and D9.
- **WP4 Service** (implementer-xhigh): D2 to D7 and D10, with the test double. Batch 1 holds its foundation; batches 2 and 3 hold one story per task pair.
- **WP5 Frontend** (frontend-implementer; the mockup first, through the arbareto-ux skill, for user approval in batch 1): D11 and D12, one story per task pair in batches 2 and 3.
- **WP6 WSL** (implementer, `Local: WSL`, alone): US5 and SC-008.
- **WP7 Qualification** (implementer writes, scout runs; `Local: package`): SC-006, SC-007, SC-009, SC-011, the full run, and the package.
- **WP8 Docs** (implementer): D14 and the research R15 evidence map.

## Agent context

No agent context file changes. The `CLAUDE.md` files stay as they are.

## Complexity Tracking

No violation.
