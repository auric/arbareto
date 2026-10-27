# Implementation Plan: Discard (Revert) Changes

**Branch**: `008-discard-changes` | **Date**: 2026-10-27 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/008-discard-changes/spec.md`

**Related**: [research.md](research.md) | [data-model.md](data-model.md) | [contracts/operations.md](contracts/operations.md) | [quickstart.md](quickstart.md)

## Summary

The Commit view gets three destructive actions: Revert lines or a hunk (R in the diff), Revert file (R in the Changes and Staged lists), and Revert all unstaged changes (a menu of the Changes header). Each action is a workbench action with a review and a single-use run (004 contract Δ3). The review binds every fact and fixes the exact result. A modal asks every time, with Cancel as the first focus and no default button. The run checks the facts again and publishes the index part through the existing candidate and lock path. Then it writes each working file through a widened atomic replace with an exact expected check. A fresh read decides every outcome.

Six facts drive the design (research R2 to R10):
- Git's apply and checkout remove a working file before they write the new one, so a failure leaves no file, and hard links and the read-only attribute are lost (R2). So Arbareto writes the working file itself.
- The publication path of `applyHunk` and `applyFiles` already builds and checks a private index candidate and publishes it under the owned lock (R3). The revert reuses it through one split of `publish()`.
- `git cat-file --filters --path` gives Git's working-tree form of a blob, so Revert file needs no copy of Git's conversion logic (R4, probe G1).
- Git's check-in conversion maps working lines to index lines one to one. `git hash-object --path --stdin` without `-w` proves the result of a line revert without a write (R5, probe G3).
- The 005 replace keeps no attribute, no creation time, and no DACL, and it can leave `.arbareto-<hex>.tmp` after a crash (R8, R9). Batch 0 probes decide each fact before the shell work starts.
- `git restore <path>` runs `post-checkout`, and Arbareto runs no such command, so a revert skips no hook (R10, user decision of 2026-10-27).

## Technical Context

**Language/Version**: The 001 to 006 versions stay: TypeScript `7.0.2`, Bun `1.4.4` (exact), Rust/Cargo `1.98.0`.

**Primary Dependencies**: No new package and no new Rust crate. The shell uses the installed `windows` crate features of `file_replace.rs` and `file_facts.rs`. The DACL copy needs `Win32_Security_Authorization` (`GetSecurityInfo`, `SetSecurityInfo`). WP3 checks whether `Cargo.toml` already enables it. A missing feature is a dependency change with its own review (constitution VIII).

**Storage**: None. The feature changes repository data only: the index through the owned lock, and working files through the atomic replace.

**Testing**: Bun tests in real disposable repositories with Git oracles on a copy (`tests/git`). Contract tests and golden vectors (`tests/contracts`, `tests/vectors`). Cargo tests for the shell. Windows fact and packaged tests (`tests/windows`). WSL tests in `Ubuntu-26.04` with Git 2.55 (`tests/wsl`).

**Target Platform**: Windows 11 x64 with WebView2 and Git for Windows (2.56.0.windows.2 on the reference PC). WSL2 repositories run the distro's Git. The Git floor stays 2.55.0.

**Project Type**: Local-first desktop application: Tauri 2 shell, compiled Bun Git service, React renderer.

**Performance Goals**: Spec SC-007, fixed before the measurement: busy state within 100 ms after R; the confirmation or the refusal within 500 ms for a file up to 1 MiB, and within 3 s for 1,000 files; the refreshed diff within 500 ms after the confirmation for a line, hunk, or single file; 100 files within 3 s; 1,000 files within 10 s on Windows and 30 s on WSL; Cancel within 1 s; at most 64 MiB process-tree memory increase at 10,000 files. The 001 SC-005 input targets hold throughout (spec FR-048). Method: research R12.

**Constraints**: No Git command writes a working file for a revert (spec FR-031). No repository program runs (spec FR-004). The renderer sends IDs, line numbers, and the action only, never a path or bytes. The service log keeps its allowlist fields (`log.ts`), so no file content enters a log (spec FR-049). Every outcome comes from a fresh read.

**Scale/Scope**: At most 10,000 files per action (`MULTI_FILE_ACTION_FILES`). At most 8 MiB per file and 1 GiB per action (research R11). Line revert within the 001 comparison bounds: 1 MiB per version and 20,000 diff lines.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Checked against `.specify/memory/constitution.md` on `main` `80f32119`, footer "**Version**: 4.0.0 | **Ratified**: 2026-09-28 | **Last Amended**: 2026-10-22", before research and again after Phase 1. Version 4.0.1 on the branch `007-first-release` changes only the Delivery Gates definition of "production release" (research R1), so the result is the same for both.

| Principle | How the design meets it | Status |
|---|---|---|
| I. Preserve user data | Every action asks in a modal that states its scope, its effects, and "You cannot undo this." Cancel has the first focus, and no button is the default (D11, D12). The review binds every fact, and the run checks them again and before each write (D2). The index part publishes only a checked candidate under the owned lock (D7). Each working file is replaced in one atomic step with an exact expected check, so it never goes missing (D8, D9). A fresh read decides the outcome, and Cancel never reports an undo (D10). A revert runs no hook and so bypasses none (note N-1). | Pass, note N-1 |
| II. TypeScript/Bun | The review, the line logic, the proof, the plan, and the outcome rules are TypeScript (D3 to D6, D10). Rust changes only the atomic replace and the file facts, which need Windows handle-relative NT calls (`NtSetInformationFile`, `FileBasicInformation`, `SetSecurityInfo`) that shared code cannot reach (D8). | Pass |
| III. Validated boundaries | Three typed workbench actions with zod schemas and explicit Rust checks (contract Δ1 to Δ3). The renderer names a snapshot, entry IDs, a comparison, a hunk, and line numbers. The shell checks every path below the worktree root by identity and refuses the Git directory (contract Δ6). Every read and write has a bound and Cancel (contract Δ5). | Pass |
| IV. Real Git verification | Every story test runs in a real disposable repository and compares the index and the working bytes with Git's own command on a copy (D13). Stale, race, interruption, and refusal fixtures assert that nothing changes (SC-003 to SC-005). | Pass |
| V. Untrusted repositories | No repository program runs. Filter drivers and Git LFS refuse (D2). Paths show as plain text (spec FR-010). No file content or diff text enters a log (spec FR-049). | Pass |
| VI. Platform evidence | Packaged Windows tests for the keys, the modal focus, the menus, the budgets, a file in use, and Windows Defender (WP7). WSL tests on Ubuntu-26.04 (WP6). Each probe that needs a missing capability records it as unverified (note N-2). | Pass, note N-2 |
| VII. Accessible and measured | Every new control has a label, a tooltip with its key, an accessible name, visible focus, and a stated reason when unavailable. The revert items stay in separate destructive groups (D12). The budgets are fixed above and in research R12, before measurement. | Pass |
| VIII. Locked dependencies | No new package and no new crate. A missing `windows` feature for the DACL copy goes through its own review in WP3 (Technical Context). | Pass |
| IX. One planning process | All artifacts stay in `specs/008-discard-changes`. The contract lists only deltas to 001 to 006. The earlier specs change only in the doc pass (D14). | Pass |

Notes from the second check:
- **N-1 (I, "Operations MUST NOT bypass Git hooks")**: Git's own `git restore <path>` runs `post-checkout` with the flag 0 (research R10). A revert runs no checkout or restore. It writes the working file itself and changes the index through `update-index`, whose only hook is `post-index-change`, and that hook refuses the staged part. So a revert runs no Git command with a hook, and no hook is skipped. The user confirmed this reading on 2026-10-27.
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
│                           # limits.ts (REVERT_FILE_BYTES, REVERT_TOTAL_BYTES), wsl-process.json (wslFiles replace), schemas/
├── git-service/            # hunk-publish.ts (publishIndex split), multi-publish.ts (unstage prepare export), support.ts (ident),
│                           # commands.ts (cat-file --filters, hash-object --path, check-attr --cached), git-runner.ts (fileReplace working, fileFacts detail),
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
| P0.1 Git facts | new `tests/git/revert-facts.test.ts` (WP1) | None. | G1 to G8 of research R14. | `cat-file --filters` differs from Git's restore for a conversion (G1). Then D5 changes before WP4. |
| P0.2 Windows facts | new `tests/windows/revert-facts.test.ts`, probe cargo tests in `file_replace.rs` (WP1) | None. | W1 to W11. | Clearing the delete disposition fails on the host (W6). Then the 005 temporary name stays with a recorded window. |
| P0.3 WSL facts | new `tests/wsl/revert-facts.test.ts` (WP1) | None. | L1 to L7. | `linkat` through `/proc/self/fd` fails from Perl (L2). Then the 005 temporary name stays. |
| P1 Contracts | `src/contracts/*`, `tests/vectors/` (WP2) | Adds the actions, phases, reasons, bounds, keys, and the `ident` attribute read. | Schema tests, vectors, the shortcut map test. | typify drops ranges. Keep explicit Rust checks. |
| P2 Shell replace | `file_replace.rs`, `file_facts.rs`, `process_requests.rs`, `wsl.rs`, `wsl-process.json` (WP3) | `fileReplace` gains the `working` target with the R8 and R9 facts. `fileFacts` gains `detail`. | Cargo tests per fact and refusal. WSL replace tests. | The DACL copy needs a `windows` feature (Technical Context). |
| P3 Index split | `hunk-publish.ts`, `multi-publish.ts` (WP4) | None for staging. `publishIndex` becomes callable from a workbench run. | The whole existing staging suite stays green, plus `publish-index.test.ts`. | A changed order of lock and claim events. The suite catches it. |
| P4 Service actions | new `revert.ts`, `revert-bytes.ts`, `support.ts`, `commands.ts`, `workbench-review.ts` (WP4) | US1 to US4 in the service. | SC-001 to SC-005 in `tests/git`. | The partial outcome after a published index (D10). |
| P5 Frontend | `changes/*`, `keyboard/shortcuts.ts`, `app/Workbench.tsx` (WP5) | The menus, the keys, the modal, progress, and results. | Component tests per FR. | The modal focus in WebView2 (WP7 checks it in the package). |
| P6 WSL | `tests/wsl/revert-wsl.test.ts` (WP6) | None (tests). | US5, SC-008. | The hex input of 16 MiB through `wsl.exe` stdin. |
| P7 Qualification | `tests/windows/revert-packaged.test.ts`, `revert-perf.test.ts` (WP7) | None (tests). | SC-006, SC-007, SC-009, SC-011. | Windows Defender holds a file during the rename (W9). |

Each step writes its tests first.

### D1 Contracts

[contracts/operations.md](contracts/operations.md) holds the deltas. Summary:
- `reviewWorkbench` gains the actions `revert-lines`, `revert-files`, and `revert-unstaged`. `runWorkbench` runs them. No new operation name.
- Phases `revert-index` (no counters) and `revert-files` (`fileIndex`, `fileCount`). Marker actions `revert-lines`, `revert-files`, and `revert-unstaged`.
- `fileReplace` gains the target `working`. `fileFacts` gains `detail`.
- New `WORKBENCH_UNAVAILABLE` reasons and the `STALE_REVIEW` reason `revert-changed`.
- `REVERT_FILE_BYTES` (8 MiB) and `REVERT_TOTAL_BYTES` (1 GiB).

### D2 Review and run frame

- The three actions register through `registerWorkbenchAction` (`workbench-review.ts:103`) in the new `revert.ts`. They join `CLASSLESS` (`:114`), because no step runs a repository program. They do not join `IN_PROGRESS_ALLOWED` (`:109`), so `OPERATION_IN_PROGRESS`, `unknown-operation`, and `CONFLICTED` refuse them (spec FR-002). `STALE_REASONS` and `FACT_REFUSALS` (`:119`, `:121`) gain the three actions with `revert-changed`.
- Review (`observe`): the common reads of the frame (HEAD, operation state, trust listing), then the action reads of D3 to D6. The bound holds the facts of data-model §2. The plan holds the confirmation fields of data-model §5. The 60 s token lifetime (`APPROVAL_LIFETIME_MS`) applies, so a late run gets `APPROVAL_EXPIRED` (spec FR-011).
- Run: the frame observes everything again and compares the bound with `Bun.deepEquals` (`staleOf`, `:287`). A difference gives `STALE_REVIEW` with `revert-changed`, and nothing runs. Then the run executes the parts of D7 to D9 in order and reconciles (D10). `observeBefore` is false, because the run reads the index itself in its reconcile.
- Reads that load the index (`ls-files`, `check-attr --cached`, `diff`) wait behind the 001 read gate. A `core.fsmonitor` command refuses through the hunk eligibility (`executable-monitor`, `unqualified-monitor`) before any of them.
- Index lock: the review reads the fact of `index.lock` in the Git directory (`fileFacts`, as the 001 lock guidance names the path). A present lock refuses every revert with `LOCKED` and the 001 remedy (`lockRefusal`, `hunk-publish.ts:118`). The bound holds `indexLock: absent`, so the run's full observation checks it again. A lock that appears during the working part does not stop it: each write keeps its exact expected check (spec Edge Cases).
- Common refusal order per path, before any action-specific step: the repository-level refusals (operation, conflicts, busy, index lock), the hunk eligibility of D7 (`sparse-index`, `split-index`, and for a staged part `index-change-hook` and WSL `shared-repository`), the 001 support reasons of the comparison, then the file facts of D8 or D9, then `attributes` (research R7), then the size bounds.

### D3 Revert lines, unstaged

- Payload: `{action: "revert-lines", snapshotId, comparisonId, hunkId, lines?}`. The comparison is a retained `index-to-worktree` comparison (`o.comparisons`, as `admit` in `hunk-publish.ts:945`). `lines` uses the 004 line selection form.
- Review: the sub-hunk through `subHunk` with the `unstage` rule: an unselected `+` line becomes context, and an unselected `-` line drops. So the partial patch stands against the working side, the new side of the comparison, and the review applies it reversed (data-model §4). The comparison scope stays `index-to-worktree`. The revert calls `subHunk` directly, not through the `admit` direction check of `hunk-publish.ts:954`. Then the working bytes: the Windows service reads them through its own bounded read (the `wholeWorking` read of `multi-publish.ts`); WSL reads them through `fileFacts` with `content: true`. Their size and SHA-256 must equal the comparison binding. Then `ls-files --eol -z` for the path, `check-attr` and `check-attr --cached` (research R7), and `ident` (research R6).
- Bytes: `revert-bytes.ts` `reverseLines(working, hunk, ending)` removes the selected `+` lines, inserts the selected `-` lines with the R5 ending rule, and keeps every other raw line (data-model §6).
- Proof: `hash-object --path=<path> --stdin` of the new bytes must print `blobId(expected)`, where `expected` is the check-in form of the working side with the hunk reversed. `revert-bytes.ts` computes both in memory. A difference refuses with `line-endings`.
- Bound: the new SHA-256 and size. Plan: `{kind: "lines", scope: "unstaged", file, lines: n | null}`.
- Run: D8 or D9 write with `expected` = the bound working size and SHA-256. No index part.

### D4 Revert lines, staged

- The comparison is a retained `head-to-index` comparison. The review refuses with `unstaged-changes` when the status record of the path has a worktree letter other than `.` (Clarifications, 2026-10-27).
- Index part: the existing Unstage lines candidate (`applyToContent` in `hunk-candidate.ts:104` through the `prepare` of `hunk-publish.ts:978`), bound to the same comparison and line selection.
- Working part: because the file has no unstaged change, its check-in form equals the index blob. The review applies the same reversed sub-hunk to the raw working bytes with the R5 rule. The proof compares `hash-object --path` of the new bytes with the blob ID of the new index content.
- Run order: the index part first, then the working write (spec FR-017, D10).

### D5 Revert file

- Payload: `{action: "revert-files", snapshotId, entryIds}` with 1 to 10,000 IDs of the Changes or Staged list of one snapshot. A folder row sends no request: the renderer shows the folder reason (spec FR-023).
- Review per entry: the status record gives the HEAD, index, and worktree modes and object IDs. The index part is the 004 Unstage files candidate (`update-index -z --index-info` with the HEAD entries, `commands.ts:411`) for every entry whose index entry differs from HEAD. A staged new file loses its entry, and its working file stays (spec FR-021). The working part writes `cat-file --filters --path=<path> <HEAD oid>` for each entry that HEAD holds. The review reads those bytes once, checks the size bound, and binds the SHA-256 and the size.
- A deletion binds `absent` and the list of missing folders. An untracked status record at the same path refuses with `in-the-way`.
- Plan: `{kind: "files", count, paths (first 20 in tree order), newFiles, staged, unstaged}`.

### D6 Revert all unstaged changes

- Payload: `{action: "revert-unstaged", snapshotId}`. The service takes every entry of the snapshot with a worktree letter other than `.` and a tracked status record, including the rows that Filter files hides. Submodule entries (`S…` or mode 160000) are counted and left out.
- Review per entry: the source blob is the index object ID. The bytes are `cat-file --filters --path=<path> <index oid>`. No index part.
- A refusal of any entry makes the whole action unavailable, and the reason names the first 20 files in tree order with their reasons (Clarifications, 2026-10-27).
- Plan: `{kind: "unstaged", count, paths, submodules}`. The renderer adds the hidden count from its filter (data-model §5).

### D7 Index part

- `publishIndex(session, steps)` is the `steps()` closure of `publish()` (`hunk-publish.ts:841-894`) as an export. It takes the owned lock (Windows `createIndexLock`, WSL `wslLock` after its process-end anchor), runs `steps.prepare`, publishes the checked candidate, and returns `Ending` and the owned files. `publish()` calls it, so the staging paths keep one code path and their tests.
- The revert run calls `publishIndex` inside its workbench run with the progress phase `revert-index`. Its `releaseOwned` and the foreign-file list feed the revert reconcile (D10). A lock refusal gives the 001 lock guidance (`lockRefusal`, `:118`), and no working file changes.
- `prepare` for staged lines: the Unstage lines `prepare` with the bound sub-hunk. For Revert file: the `multi-publish.ts` `prepare` with the direction `unstage` and the bound items. Both export their `prepare` for this call.
- The claim: the workbench token is the single-use claim, so the publication claim always consumes.

### D8 Working-file write on Windows

- `fileReplace {repositoryId, target: "working", path, expected, facts, bytes, folders}` (contract Δ6). The shell checks the path below the worktree root with `file_facts::below`, refuses a first component that names the Git directory or `.git`, and requires the started marker action of the run.
- `check` (`file_replace.rs:118`) keeps its walk, its held parent, its held target, and its size and SHA-256 compare. It adds the R8 facts under the held target handle: the attributes, the link count (`hard-link`), the read-only and encrypted attributes, the owner and DACL. Any difference from `facts` gives `stale`.
- `write` (`:180`) creates the temporary file with the delete disposition on close (W6). It sets the attribute set and the creation time through `FileBasicInformation` (W1, W3), copies the DACL (W2), and compares the resulting owner and DACL with the old file. Then it writes, flushes, clears the delete disposition, and renames with `FILE_RENAME_POSIX_SEMANTICS | FILE_RENAME_REPLACE_IF_EXISTS`. A target bound as absent renames without `REPLACE_IF_EXISTS`, so an existing name gives `stale` (as 005 N7).
- `folders` lists the missing folder names below the deepest existing folder. The shell creates each with `FILE_CREATE` and `FILE_DIRECTORY_FILE` relative to the held parent and `OBJ_DONT_REPARSE` (W10).
- Reply: `replaced`, `stale`, `refused {reason}` (`not-regular`, `hard-link`, `read-only`, `encrypted`, `owner`, `security`, `file-attributes`), `error {code}` (`sharing-violation`, `access-denied`, `disk-full`, `read-only-volume`, or another code), `stopped`, plus `folders` created.
- The R8 table decides each fact. A probe that differs changes this section before WP3 (research R8 rule).

### D9 Working-file write on WSL

- The same request reaches `wslFiles` mode `replace` with the root `worktree` and any path below it. The Perl `replace_one` (`wsl-process.json`) keeps its walk and its checks, and adds: the `st_uid` compare and the gid copy through `chown(-1, gid)` (`owner`), the `llistxattr` check (`xattr`), the `O_TMPFILE` create and the `linkat` name just before the rename (L1, L2), and `mkdir` of the missing folders (L7).
- The bytes cross in hex on stdin, at most `REVERT_FILE_BYTES` (contract Δ11). The WSL read of the working bytes for a line revert uses `fileFacts` with `content: true` (at most 1 MiB).
- A staged part refuses with `shared-repository` (`eligibility.ts:225`) when any scope sets `core.sharedRepository`. An unstaged revert writes no repository file, so that reason does not apply to it.
- A stop, a deadline, or a broken output of `replace` gives `interrupted`. The reconcile waits for the process-end fact before the fresh read (`workbench-review.ts:360`).

### D10 Outcome and failure handling

- Reconcile reads after every run, also after Cancel and failure: the index entries of every path (`ls-files --stage -z` with the bound object format), `fileFacts` with `digest: true` for every path, and `readWorkspace`.
- Per-file outcome (data-model §8): `reverted` (the index entry and the digest equal the plan), `unstaged-only` (the index entry equals the plan, the digest equals the old file), `not-changed` (both equal the old state), `changed-outside` (the digest equals neither), `failed {code}` (a reply error with the old state), `not-started` (no request reached the file).
- Response state:

| Index part | Working writes | Response | Code |
| --- | --- | --- | --- |
| none, or published | every file `reverted` | `succeeded` (intended effects confirmed) | none |
| refused before publication | none started | `failed` (no effects) | the refusal code, such as `STALE_REVIEW` or the lock code |
| published | some files not reverted | `failed-with-effects` | the first file in tree order names its code |
| none | no file changed, Cancel | `canceled` | none |
| none | no file changed | `failed` | the code of the first file in tree order |
| unknown (WSL without a process-end fact, or a failed reconcile read) | — | outcome unknown; the recovery marker stays (001 FR-023) | `GIT_FAILED` or `DEADLINE` |

- Cancel: before the lock, nothing runs. After the publication starts, the index part ends, because the publication is one rename. Between files, the run stops before the next request. A started `fileReplace` ends without a stop, as in 005.
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

- Oracles: Git's own commands on a copy of the fixture: `git apply -R` and `git apply --cached -R` of the same partial patch for lines; `git restore --staged --worktree --source=HEAD` for Revert file (minus the staged-new-file difference of G7); `git restore .` for Revert all unstaged changes. The tests compare index bytes through `ls-files --stage -z` and working bytes by SHA-256.
- The test double (`tests/git/bun-runner.ts`) implements `fileReplace` `working` with the same expected checks on the host file system, and records each request. The shell behavior has its own cargo tests and the packaged tests.
- Seams: `revertCheckpoint({step: "before-index" | "after-index" | "before-write", path})` in the service run for the race fixtures, as `hunkCheckpoint` (`hunk-publish.ts:74`). Production passes none.
- Fault fixtures: the double stops at each write step; the cargo tests kill a child that holds the temporary handle (W6); the WSL test kills the distro process (L3).
- Each new `tests/git`, `tests/contracts`, and `tests/wsl` file gets its line in `tests/groups.json` in its task.

### D14 Earlier spec lines and docs

The doc pass (WP8, after the full run of WP7) appends one sentence "Amended by feature 008 (2026-10-27): …" to each line below, as feature 005 amended 004 FR-045:
- `specs/001-desktop-qualification/spec.md:424` (FR-027): the revert actions are allowed behind their confirmations.
- `specs/001-desktop-qualification/contracts/operations.md:1608` (§11): the bytes of one reverted file, at most 8 MiB, cross out of and into the distro.
- `specs/004-workbench-ux/spec.md:303` (Scope Boundaries): the discard exclusion goes.
- `specs/004-workbench-ux/spec.md:322` (the 001 FR-027 change): the revert actions join the allowed list.
- `specs/004-workbench-ux/spec.md:526` (Assumptions): the discard assumption goes.
- `specs/005-inspection-file-actions/spec.md:330` (FR-023): the destructive group also holds "Revert file…".
- `docs/project-brief.md:101`: the label "Discard changes" becomes "Revert file".
- `README.md` "Features": one line for Revert lines, hunks, files, and all unstaged changes, after a confirmation.
These lines stay unchanged: 001 FR-013 (`:404`), 001 FR-038 (`:447`), 004 FR-042 (`:403`), 004 `:548`, 003 `:226`, 005 `:266`, and the brief `:49`.

### Invariants

- No Git command writes a working file for a revert.
- No working file is ever missing or partly written: the old bytes or the new bytes, at every moment.
- No write happens without an exact expected check of the target under the held handle.
- The index changes only through a checked candidate under the owned lock.
- No outcome comes from Git message text, timing, a retry count, or a name pattern.
- No modal reverts on Enter alone.

## Open items and reviewer defaults

- The R8 and R9 tables are decisions with probes. A probe result that differs changes them before WP3 (research R14 rule).
- The 8 MiB file bound is a reviewer default (research R11). A streamed write could lift it later.
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

- **WP1 Facts** (implementer; W probes `Local: Windows` and `Local: Rust`; L probes `Local: WSL`, alone): research R14 G1 to G8, W1 to W11, L1 to L7, and the fact gate into R15.
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
