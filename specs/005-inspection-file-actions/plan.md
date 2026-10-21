# Implementation Plan: History Inspection and Commit View File Actions

**Branch**: `005-inspection-file-actions` | **Date**: 2026-10-21 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/005-inspection-file-actions/spec.md`

**Related**: [research.md](research.md) | [data-model.md](data-model.md) | [contracts/operations.md](contracts/operations.md) | [quickstart.md](quickstart.md)

## Summary

History shows the changed files and the diff of the selected commit. The Commit view gets folders-first trees, Show in Explorer for a folder, Delete and Delete permanently, a docked ignore editor with an exact preview, Open submodule, and Blame. The sidebar gets a full-name card and an upstream-gone mark. Each read runs Git's own machine-readable command with literal arguments. Each file action follows the 004 pattern: a read-only review binds the facts and issues a one-use token, and one `runWorkbench` runs the reviewed action. Fresh reads decide every outcome. No Git message text decides anything.

Seven facts drive the design (research R2 to R14):
- `git diff-tree <merge>` prints nothing, so every History read uses the two-tree form `diff-tree <parent> <commit>`, and a root commit compares with the empty tree (design R1, probed).
- `diff-tree` and `ls-files` load the index (Git 2.56 builtin/diff-tree.c:132, builtin/ls-files.c:681), and an index load can run a command-valued `core.fsmonitor` (read-cache.c `tweak_fsmonitor`). So the History diff, the ignore preview, and the Open submodule checks wait behind the 001 read gate. Blame of a commit, `git diff` of two blobs, `ls-tree`, `cat-file`, and `check-ignore --no-index` load no index (R13).
- `git blame` turns textconv on by default (builtin/blame.c:1026), so every blame passes `--no-textconv`. A missing `blame.ignoreRevsFile` makes blame exit 128, and no command-line form avoids it, so the service checks each relative file first (R11).
- `--incremental` blame output prints no ignore markers, and `--porcelain` prints `ignored` and `unblamable` per line only with `blame.markIgnoredLines` and `blame.markUnblamableLines` (builtin/blame.c `emit_porcelain_per_line_details`). So a blame with an ignore list runs `--porcelain` without progress counts (R11).
- An exact ignore preview needs Git's own matcher on the candidate text. A throwaway shadow repository that holds only the ignore files, plus `check-ignore --no-index -z --stdin -v -n`, matched a real save in all 11 report cases (ignore-preview report). `--exclude-from` substitution is wrong for a `.gitignore` edit (R8).
- `SHFileOperationW` gives no per-item result. `IFileOperation` with a progress sink gives `PostDeleteItem` per item, and a null `psiNewlyCreated` means a full delete (Microsoft Learn). So Delete uses `IFileOperation` for the Recycle Bin and `FileDispositionInfoEx` on the checked handle for a permanent delete (R5).
- Git names no upstream for a branch whose remote is gone (remote.c `branch_get_upstream`), so the gone mark needs only `%(upstream)` and the presence of that ref in the same `for-each-ref` read (R14).

## Technical Context

**Language/Version**: The 001 to 004 versions stay: TypeScript `7.0.2`, Bun `1.4.3` (exact), Rust/Cargo `1.98.0`.

**Primary Dependencies**: No new runtime package. React `19.3.0`, `@base-ui/react` `^1.8.0` (PreviewCard for the branch card), `@tanstack/react-virtual` `^3.14.13`, `@pierre/diffs` `^1.5.1`, `@hugeicons/core-free-icons` as installed, Tauri `2.12.0`. The shadcn generator adds `hover-card` with `shadcn@4.21.0` only (D13). The Rust shell uses the installed `windows` crate features plus the Shell COM interfaces `IFileOperation`, `IFileOperationProgressSink`, and `IShellItem` (D7). WP3 checks the crate feature list and records each added feature in research.md.

**Storage**: Repository writes happen only at explicit user actions: Delete and Delete permanently of reviewed working files (D6), and Save of `.gitignore` or `info/exclude` (D10). The ignore preview writes only a shadow folder below the application-owned data folder, or below `/tmp` in a WSL distro (D9). The renderer keeps the submodule parent chain for the window session (D11). No new shell setting.

**Testing**: Bun tests in real disposable repositories (`tests/git`), compared with Git's own commands on copies. Contract tests and golden vectors (`tests/contracts`, `tests/vectors`). Windows packaged tests (`tests/windows`). WSL tests (`tests/wsl`, Ubuntu-26.04 with Git 2.55). Cargo tests for `file_delete.rs`, `file_replace.rs`, the shadow context, and the WSL Perl modes.

**Target Platform**: Windows 11 x64 with Git for Windows (2.56.0.windows.2 on the reference PC). WSL2 repositories run the distro's Git. The Git floor stays 2.55.0. It covers `cat-file --batch-command -Z` (Git 2.43) and `blame.markIgnoredLines` (Git 2.23).

**Project Type**: Local-first desktop application: Tauri 2 shell, compiled Bun Git service, React renderer.

**Performance Goals**: SC-001: the changed-file list within 300 ms after the selection, the first diff within 150 ms more, a move to the next file within 150 ms (1,000-file fixture, warm package, median of 10). SC-005: an ignore preview of 100,000 paths within 5 s on Windows (D9 states which runs count). SC-006: the first blame progress within 500 ms on the 10,000-line, 5,000-commit fixture, and Cancel ends Git within 1 s. The 001 SC-005 input targets hold during every read and action (SC-009).

**Constraints**: Hooks, filters, textconv, and external diff programs never run in a read of this feature. Every Git process has a Job, a deadline, and Cancel. The renderer sends IDs, booleans, line numbers, path bytes of shown rows, and the editor text only. Delete never follows a link or a junction. Save replaces the file in one atomic step. No Git configuration file changes. Each `-c` item of this plan sets a value for one process only (D2).

**Scale/Scope**: Commits with up to 100,000 changed files and 32 MiB of raw listing. Delete of up to 10,000 files (004 `MULTI_FILE_ACTION_FILES`). Ignore files up to 1 MiB. Previews of up to 100,000 checked paths. Blame of files up to 4 MiB and 100,000 lines. Submodule chains of up to 8 levels.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Checked against `.specify/memory/constitution.md` version 3.0.0, before research and again after Phase 1.

| Principle | How the design meets it | Status |
|---|---|---|
| I. Preserve user data | Git and fresh reads decide every outcome. Delete binds to the file facts at review and checks them again before any delete and again under the open handle (D6, D7). Only listed Changes entries go; ignored and unlisted files stay. A tracked file loses only its working file; the index never changes. The modal confirmation names the count, the paths, the Recycle Bin or permanent mode, and "You cannot undo this." Save compares the disk bytes with the loaded bytes and replaces the file atomically (D10). Cancel never reports an undo. | Pass, note N-1 |
| II. TypeScript/Bun | All Git logic, the preview method, the tree order, and the blame parse are TypeScript. Rust adds only platform work: the no-follow delete walk and the Recycle Bin call, the atomic replace, the shadow folder lifetime, and three WSL Perl modes (D14). | Pass |
| III. Validated boundaries | Typed operations with zod and the strict decoder. Every path passes after `--` with `--literal-pathspecs`, except `check-ignore` stdin paths (D9). Every listing, patch, blame, and result has a bound (contract Δ5). Each read has Cancel and a deadline. The renderer never sends a revision expression: History reads send a view ID, a row OID that the service finds in its view, and a parent index. | Pass |
| IV. Real Git verification | Each read is compared with Git's own command on a copy: `diff-tree`, `git blame --porcelain`, and the ignored set after a real save. Delete tests check the index digest, every other working byte, the Recycle Bin item, and the stale and link-swap cases. | Pass |
| V. Untrusted repositories | No read runs a hook, a filter, textconv, or an external diff. Index-loading reads wait behind the 001 read gate (D2). The submodule gets its own trust state. The parent's programs never run for the open (D11). The editor text, the blame lines, and the diff are plain text. | Pass, note N-2 |
| VI. Platform evidence | Packaged Windows evidence for the Recycle Bin result, the permanent-delete warning, the folder reveal, and the SC timings (P9). WSL evidence on Ubuntu-26.04. The `FOF_WANTNUKEWARNING` behavior stays unverified until N2 runs (research R16). | Pass, note N-3 |
| VII. Accessible and measured | Every new control has a label or icon, a tooltip, an accessible name, visible focus, and a stated reason when unavailable (D15). Delete items sit in their own labelled menu group with the danger style. Budgets are fixed before measurement (SC-001, SC-005, SC-006). | Pass |
| VIII. Locked dependencies | No new package. The shadcn generator runs only as `shadcn@4.21.0`. New `windows` crate features go into `Cargo.lock` with the change (D14). | Pass |
| IX. One planning process | All artifacts stay in `specs/005-inspection-file-actions`. The contract lists only deltas to 001 to 004. | Pass |

Notes from the second check:
- **N-1 (I, "Destructive actions … MUST require explicit confirmation of their scope and effects")**: Delete and Delete permanently are new destructive actions. The amended 001 FR-027 exception list (004 spec.md:317) names them. The modal states the scope (count, first 20 paths, the folder rule, the tracked count) and the effect (Recycle Bin, permanent, WSL). "Recovery claims MUST state their limits": Delete states the Recycle Bin only for items that Windows reports as recycled (D7). A plain Delete that Windows cannot recycle asks with the Windows warning first (spec FR-028).
- **N-2 (V, "explicit trust approval before execution")**: The preview, the History diff, and the Open submodule checks load the index, so they wait behind the read gate. The preview also runs Git in a shadow repository that the application owns. That repository holds no repository-controlled configuration. User-level configuration (global and system) applies there as it applies to every Git run, and the plan does not override it except for the `-c` items of D9.
- **N-3 (VI, "Untested behavior MUST remain explicitly unverified")**: Research R16 lists every unverified point: the `FOF_WANTNUKEWARNING` dialog with `FOF_NOCONFIRMATION`, the `ls-files --directory` collapse, long shadow paths with `core.longpaths` false, `FileDispositionInfoEx` on a volume without POSIX delete, and the `./` stdin prefix on Windows.
- **N-4 (Delivery Gates)**: Safety tests (SC-003, SC-005, SC-011), trust boundaries (D2, D11), accessibility checks (SC-010), performance budgets (SC-001, SC-002, SC-005, SC-006, SC-009), and platform qualification (P9) are defined here.

No violation, so Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/005-inspection-file-actions/
├── spec.md
├── plan.md                 # This file
├── research.md             # Phase 0
├── data-model.md           # Phase 1
├── quickstart.md           # Phase 1
├── contracts/
│   └── operations.md       # Phase 1: deltas to the 001 to 004 contracts
├── checklists/
└── tasks.md                # Phase 2 (/speckit-tasks, not created here)
```

### Source Code (repository root)

```text
src/
├── contracts/              # envelope.ts, errors.ts, limits.ts, channel.ts, operations.ts, wsl-process.json (+ delete, replace, scratch), schemas/
│                           # new: tree-order.ts; ignore-line.ts stays
├── git-service/            # session.ts, history-view.ts, diff-parser.ts (+ rename headers), commands.ts, ignore.ts, workbench-review.ts,
│                           # branches.ts (upstreamPresent), native-runner.ts, git-runner.ts
│                           # new: commit-changes.ts, blame.ts, blame-parser.ts, line-map.ts, file-delete.ts, ignore-text.ts,
│                           #      ignore-preview.ts, submodule-open.ts
└── frontend/               # history/CommitDetails.tsx, changes/{ChangesPane,file-tree,file-actions}.tsx, refs/ReferencesSidebar.tsx,
                            # branches/BranchButton.tsx, submodules/SubmodulesGroup.tsx, app/{Workbench,RepositoryMenu}.tsx, bridge.ts,
                            # state/history-view.ts, keyboard/shortcuts.ts
                            # new: history/CommitChanges.tsx, blame/{BlameView,blame-time}.tsx, ignore/IgnoreEditor.tsx,
                            #      changes/DeleteConfirm.tsx, branches/BranchCard.tsx, app/ParentButton.tsx, components/ui/hover-card.tsx
src-tauri/
└── src/                    # process_requests.rs, schema.rs, wsl.rs, reveal.rs, service.rs, bootstrap.rs, lib.rs
                            # new: file_delete.rs, file_replace.rs, shadow.rs
tests/
├── git/                    # new: history-diff-fixtures.ts, history-diff-facts.test.ts, commit-changes.test.ts, blame.test.ts,
│                           #      file-actions-fixtures.ts, file-actions-facts.test.ts, delete.test.ts, ignore-editor.test.ts,
│                           #      ignore-preview.test.ts, submodule-open.test.ts, branch-gone.test.ts
├── windows/                # new: delete-facts.test.ts, inspection-packaged.test.ts, inspection-perf.test.ts
├── wsl/                    # new: inspection-wsl.test.ts
├── contracts/              # new: inspection-*.test.ts(x), tree-order.test.ts, shortcuts-005.test.ts
└── vectors/
```

**Structure Decision**: The three-part layout stays: renderer, Bun service, and shared contracts, with a thin Tauri shell. The tree comparator lives in `src/contracts/tree-order.ts`, because the service sorts the preview lists and the renderer sorts the trees with the same rule. It has no runtime import, as `ignore-line.ts`.

## Design

### Steps (riskiest proof first)

| Step | Files and symbols | Behavior change | Tests that prove it | Main risk |
|---|---|---|---|---|
| P0.1 Fixtures | new `tests/git/history-diff-fixtures.ts` (WP4), new `tests/git/file-actions-fixtures.ts` (WP5). Both reuse `tests/git/fixtures.ts` and the 004 `tests/git/workbench-fixtures.ts`. | None (tests only). History: normal, merge with 2 and 3 parents, root, shallow, rename at 92%, mode change, binary, submodule, type change, 1,000-file and 100,001-file commits, a partial clone with a missing blob. Blame: renames, moved lines, whitespace, an ignore list (relative, absolute, missing, reset by an empty value), a shallow clone, binary, submodule, a 10,000-line file with 5,000 commits. Files: untracked, changed tracked, folders with ignored files, a link to a folder outside, a junction, read-only, a nested repository, a submodule, a conflict. Ignore: the report cases C0 to C8 and W1, CRLF, BOM, empty, absent, a linked `.gitignore`, a `.gitignore` in an ignored folder, a case-variant name, a skip-worktree `.gitignore`, gitlinks. Branches: pruned upstream, removed remote, no upstream, `feature/b` and `Feature/a` as packed refs. | The builder self-check: commit trees, counts, the ignored set, the index digest. | Build time of the 100,001-file commit. Mitigation: the 001 fixture cache. |
| P0.2 Git facts | new `tests/git/history-diff-facts.test.ts` (WP4: F1 to F9, F17), new `tests/git/file-actions-facts.test.ts` (WP5: F10 to F16, F18) | None. Records the Git behavior that the design depends on (research R16). | Each fact against Git's own result on a copy, on Windows Git 2.56 and WSL Git 2.55. Each fact records the observed version. | A fact fails. Record it in research.md and change the contract before P4 or P5. |
| P0.3 Native facts | new `tests/windows/delete-facts.test.ts` (WP3, packaged), cargo tests in `file_delete.rs` and `file_replace.rs` | None. | N1 to N8 of research R16: the per-item recycle result, the warning on a volume without a Recycle Bin, links and junctions, the cancel of the rest, the POSIX disposition, the held folder handle, the atomic replace, the folder reveal. Each Recycle Bin test purges its own items through the reply `recycledPath`. | N2 needs a volume without a Recycle Bin. Capability skip, recorded as unverified. |
| P1 Pure logic | new `src/contracts/tree-order.ts` (WP1), new `src/git-service/{blame-parser,line-map,ignore-text}.ts`, the raw record parser of `commit-changes.ts`, the rename header extension of `diff-parser.ts` (WP4, WP5) | Algorithms only. | Unit tests: the comparator against a reference sort with invalid UTF-8; both blame grammars; the hunk-header line map; the line-ending and BOM codec; the raw record grammar. | Grammar drift. P0.2 pins it. |
| P2 Contracts | `src/contracts/{operations,envelope,errors,limits,channel}.ts`, `wsl-process.json` (schemas only), `schemas/`, `tests/vectors/` | Adds the operations, codes, reasons, phases, bounds, and private requests of contract Δ1 to Δ15. | Schema tests and golden vectors in Bun and Rust. | typify drops ranges. Keep explicit Rust checks (001 §1). |
| P3 Shell | `src-tauri/src/{file_delete,file_replace,shadow}.rs` (new), `process_requests.rs`, `schema.rs`, `wsl.rs`, `reveal.rs`, `service.rs`, `bootstrap.rs`, `lib.rs`, `src/contracts/wsl-process.json` (Perl modes `delete`, `replace`, `scratch`) | `fileDelete`, `fileReplace`, the `ignorePreview` context with the shadow folder, the `absent` reveal reply, the `openSubmodule` native step, the recent entry of `openSubmodule`, the new close prompt names. `fileAppend` goes. | Cargo tests for each request, refusal, and walk case. N1 to N8. | Local only. COM STA thread and owner window. |
| P4 Service History | new `commit-changes.ts`, `blame.ts`, `blame-parser.ts`, `line-map.ts`; `commands.ts`, `diff-parser.ts`, `history-view.ts`, `session.ts` | US1 and US7 service part. | SC-001, SC-002, SC-006, FR-058 attribution, the read gate, Cancel, missing objects. | Blame time on large files. The deadline and Cancel bound it. |
| P5 Service files | new `file-delete.ts`, `ignore-text.ts`, `ignore-preview.ts`, `submodule-open.ts`; `ignore.ts`, `workbench-review.ts`, `native-runner.ts`, `git-runner.ts`, `tests/git/bun-runner.ts`, `session.ts` | US2, US4, US5, US6 service part. | SC-003, SC-005, SC-007, stale reviews, Cancel, WSL rows. | Preview time at 100,000 paths. D9 bounds it. |
| P6 Frontend base | `src/frontend/changes/file-tree.ts`, `refs/ReferencesSidebar.tsx`, `branches/BranchButton.tsx`, new `branches/BranchCard.tsx`, `components/ui/hover-card.tsx`, `src/git-service/branches.ts` | US3, US8, US9. | SC-004, SC-008, the card keyboard rules. | Sort cost at 100,000 rows. One key per row, built once per read. |
| P7 Frontend History | `history/CommitDetails.tsx`, new `history/CommitChanges.tsx`, new `blame/*`, `state/history-view.ts`, `views/HistoryView.tsx`, `bridge.ts`, `app/Workbench.tsx` | US1 and US7 UI. | Component tests per FR, SC-001 timing in the package. | The dock swap of the blame view. |
| P8 Frontend Commit view | `changes/ChangesPane.tsx`, `changes/file-actions.ts`, new `changes/DeleteConfirm.tsx`, new `ignore/IgnoreEditor.tsx`, `submodules/SubmodulesGroup.tsx`, new `app/ParentButton.tsx`, `app/RepositoryMenu.tsx`, `app/Workbench.tsx`, `bridge.ts`, `keyboard/shortcuts.ts` | US2, US4, US5, US6 UI, and the Blame entry of US7. | Component tests per FR. | The discard rule across the views (FR-044). |
| P9 Qualification | `tests/windows/{inspection-packaged,inspection-perf}.test.ts`, `tests/wsl/inspection-wsl.test.ts` | None (tests). | SC-001 to SC-010 in the package and in Ubuntu-26.04. | The open 001 measurement tools. |

Each step writes its tests first. P0.2 and P0.3 are the riskiest proofs and run first inside WP3, WP4, and WP5.

### D1 Contracts

[contracts/operations.md](contracts/operations.md) holds the deltas. Summary:
- New reads: `readCommitChanges` and `readCommitFile` (D3), `readBlame` (D12), `readIgnoreFile` and `previewIgnore` (D8, D9).
- New native-first operation: `openSubmodule` (D11).
- `reviewWorkbench` gains the actions `delete` (D6) and `ignore-save` (D10). The action `ignore` goes, with its one-line dialog.
- `revealPath` gains `folder` (D5). `readBranches` entries gain `upstreamPresent` (D13).
- New private requests: `fileDelete` (D7), `fileReplace` (D10), and `shadow` with the context `ignorePreview` (D9). `fileAppend` goes. The `reveal` reply gains `absent`. WSL `fileFacts` gains `content` for one ignore file (D8).
- New codes `BLAME_UNAVAILABLE` and `SUBMODULE_UNAVAILABLE`. New reasons of `WORKBENCH_UNAVAILABLE`, `STALE_REVIEW`, and `UNKNOWN_TARGET` (contract Δ9).
- The public request bound rises from 1 MiB to 2 MiB, so a 1 MiB editor text fits a `previewIgnore` or `ignore-save` request (contract Δ5).

### D2 Process model, environment, and outcomes

- Every argument array starts with `--no-lazy-fetch`. Reads add `--no-optional-locks` and `--literal-pathspecs` (001 `READ_OPTIONS`). The exceptions are `check-ignore` (Git exits 128 with `--literal-pathspecs`, 004 R21 F1) and the commands of the shadow context, which name no pathspec (D9).
- Read policies: every read of this feature runs under the 001 `read` policy. Delete and Save run their file steps through the shell and their reconcile reads under `read`. No 005 step runs a Git mutation.
- Read gate (spec FR-003, research R13). The gate is the 001 `trust.gate(w, listing, installation, "reads")` call before the first Git process, as `comparison.ts:346-351`:

| Read | Git commands | Loads the index | Gate |
|---|---|---|---|
| `readCommitChanges`, `readCommitFile` | `diff-tree` | Yes (builtin/diff-tree.c:132) | Yes |
| `readBlame` | `ls-tree`, `diff --numstat` of two trees, `cat-file`, `blame <commit>` | No | No |
| `readBlame` before (`source.blameId`) | `ls-tree`, `diff -U0` of two blobs, then the blame above | No (builtin/diff.c `builtin_diff_blobs`) | No |
| `readIgnoreFile` | `rev-parse --git-path info/exclude`, `fileFacts` | No | No |
| `previewIgnore` | `ls-files` in the repository, `check-ignore --no-index` in the repository, shadow commands | Yes (`ls-files`) | Yes |
| `openSubmodule` | `ls-files --stage` in the parent, then the 001 discovery | Yes (parent index) | Yes, the parent gate |
| `revealPath` with `folder` | none | No | No |
| `reviewWorkbench` `delete`, `ignore-save` | `fileFacts`, `rev-parse --git-path` | No | No |
| The reconcile `readWorkspace` after Delete and Save | the 001 status read | Yes | The 001 gate |
| The branch card | none (it reads held results) | No | No |

- Mutation exclusion: every `runWorkbench` of `delete` and `ignore-save` enters the 001 exclusion and records a marker of kind `workbench` with its action. Delete and Save count as mutations for 001 FR-015 and FR-016 (spec FR-033, FR-046). A second mutation gives `BUSY`.
- `-c` items: `-c blame.markIgnoredLines=true -c blame.markUnblamableLines=true` (D12) and the D9 shadow items `core.autocrlf`, `core.eol`, `core.ignorecase`, `core.excludesFile`. Each applies to one process (git(1) `-c`). No configuration file changes.
- Outcomes: the 001 data-model §7 states. A result names each effect that the reconciliation observed (D6, D10).
- Cancel ends the Job of the read or the operation (001 FR-045). Reconciliation then re-reads. WSL first waits for the 001 §4 process-end fact.
- Progress phases (contract Δ2): `blame` with `blamed` and `total` without an ignore list and no counters with one; `delete-files` with `fileIndex` and `fileCount`; `ignore-save`; `preview`.

### D3 History diff of the selected commit

- Layout (spec FR-005, Main board). The "Selected commit" dock region holds three regions with splitters: Commit details, "Changed files (<n>)", and the diff. The constrained profile shows two tabs, "Commit" and "Changes" (HistoryStates board, cell 8). The Changes tab holds the file list above the diff.
- Selection: a commit row selection sends `readCommitChanges {viewId, oid, parent: 0}`. The first file in tree order (D4) then sends `readCommitFile`. A move in the list sends `readCommitFile` for that file. Each read is latest-wins by the 001 pending-read rule, so a fast move cancels the earlier read.
- `readCommitChanges` service steps:
  1. `find(repositoryId, viewId)` (`history-view.ts:282`) gives the view, else `UNKNOWN_TARGET`. `topology.rowOf(oid)` (`history-topology.ts:190`) gives the row, else `UNKNOWN_TARGET`. The parents are `topology.parents(row)` in Git order (`history-topology.ts:143`). The renderer never sends a parent OID.
  2. Parents present: `parent` must be below the parent count, else `INVALID_REQUEST`. The base is that parent.
  3. No parents: the view shallow set holds the OID gives base `shallow`, and the result holds no file. Otherwise the base is the empty tree of `emptyTreeArgs()` (`commands.ts:296`, SHA-1 and SHA-256). This is the `history-layout.ts:83` rule.
  4. The read gate (D2).
  5. `--no-lazy-fetch --no-optional-locks --literal-pathspecs diff-tree -r -z --raw -M -l1000 <base> <oid>`. Git prints full object IDs, because diff-tree sets `abbrev = 0` (builtin/diff-tree.c:134).
  6. Parse (diff-format(5) "Raw output format" with `-z`): `:<old mode> SP <new mode> SP <old oid> SP <new oid> SP <status><score> NUL <path> NUL`, and a second `<path> NUL` for status R. Modes are six octal digits. OIDs match the object format, and the absent side holds the zero OID. Status A, D, M, R (with a three-digit score), and T are accepted. C, U, X, B, and any other byte refuse the whole list with `MALFORMED_GIT_OUTPUT` (spec FR-006).
  7. Kind per entry: mode 160000 on either side is `submodule`, 120000 is `link`, else `file`.
  8. Bounds: `STATUS_LISTING_RECORDS` (100,000) and `STATUS_LISTING_BYTES` (32 MiB) of raw output, then `HISTORY_PAGE_BYTES` (8 MiB) of encoded result. The service keeps whole records only, in Git's output order, and marks the result `limited` with the shown count. The renderer then sorts the shown entries in tree order.
  9. A non-zero exit runs the 001 §7 `hasPromisor` path, as `comparison.ts:474-483`. A promisor repository gives `OBJECT_MISSING` with the 001 remedy. The read never fetches.
  10. The service retains the listing of the latest call per view as `changesId` (raw bytes and record offsets). A new `readCommitChanges` or a released view drops it. An older `changesId` gives `UNKNOWN_TARGET`.
- `readCommitFile {changesId, fileId}` service steps:
  1. The read gate again, because the trust state can change between reads.
  2. Kind `submodule`: no Git read. The result holds the two commit IDs from the listing.
  3. Otherwise two reads with the same pathspec: `diff-tree` with the 001 `PATCH_OPTIONS`, `-M -l1000`, `<base> <oid> -- <path>` (and `<old path>` for R), and `diff-tree` with the 001 `NUMSTAT_OPTIONS` and the same arguments. The rename pairs inside that pathspec (design R1, probed; F3).
  4. Parse with `parsePatch` and `parseNumstat` (`diff-parser.ts:114`, `:220`). `parsePatch` gains the header lines `similarity index <n>%`, `rename from <path>`, and `rename to <path>` (diff.c `fill_metainfo`), with a pure rename that has no hunk. A type change gives two patch sections (F3). The service then sends no patch and the fact line only.
  5. Binary: `parseNumstat` gives `binary` from `-` and `-` (git-diff(1) `--numstat`).
  6. Bounds: `CANONICAL_DIFF_BYTES` (4 MiB) and `CANONICAL_DIFF_LINES` (20,000), with the 001 limit texts.
- Parent picker (spec FR-008): a commit with two or more parents shows the radio group "Compare with". Each option reads "Parent <i> <short ID>", with `<i>` from 1 in Git order. Parent 1 starts selected. A change sends a new `readCommitChanges` with that index. The 002 bound of 64 parents per commit limits the options.
- Texts (Main and HistoryStates boards):
  - Heading: "Changed files (<n>)", with the en-US thousands separator. A limited list shows the shown count.
  - Root: "Compared with an empty tree. This is a root commit." (note row with the info icon).
  - Shallow: "Arbareto cannot show the changes. The parent of this commit is not in this shallow clone." (Warning fill). The heading reads "Changed files" without a count.
  - Limit: "This commit changes more files than Arbareto shows. Arbareto shows the first <n>." (Warning fill).
  - Empty list: "This commit changes no file." for a root, and "This commit changes no file compared with parent <i>." otherwise.
  - Loading: "Arbareto reads the changed files." Failure: "Arbareto cannot read the changed files: <code>." Trust: the 004 D12 text "Arbareto reads no changes until you trust this repository." with "Trust…".
  - Diff facts, each as a fact row with the info icon above the diff: "Renamed from <old path> (<score>% similar)."; "Mode <old> → <new>." with both modes in the code font; "Submodule commit <old short ID> → <new short ID>."; "Binary file. Arbareto does not show its changes."; "Type changed from <old kind> to <new kind>." with the kinds "file", "symbolic link", and "submodule". An added or deleted submodule shows "Submodule commit added: <short ID>." or "Submodule commit removed: <short ID>.".
  - Diff states: "Arbareto reads the diff." and "Arbareto cannot read the diff: <code>.". Missing objects: the 001 `OBJECT_MISSING` remedy. The diff bounds: the 001 limit texts.
  - File row name: "<name>, <status>", such as "login.ts, modified". A rename adds ", renamed from <old path>". A submodule row reads "<name>, submodule, <status>". The status words are "added", "deleted", "modified", "renamed", and "type changed". The status letters are A, D, M, R, and T, with the 004 D16 colors (M Warning, A Added, D Removed, R and T Text).
  - The 001 line "Changed files are not shown in this version." (`CommitDetails.tsx:14`) goes.
- The diff header (32 px): the path in the code font at weight 600, "<n> hunks" in Muted text, then Copy path, Previous hunk (Alt+Up), Next hunk (Alt+Down), and the 24 px button "Blame". The diff body is `PatchView` (`PatchView.tsx:37`) without `hunkAction` and without line selection, so it holds no stage action (spec FR-014).

### D4 Tree order: folders first

- Rule (spec FR-015, FR-016): `src/contracts/tree-order.ts` exports `compareNames(a, b)` and `comparePaths(a, b)` over path component bytes. `compareNames` maps each byte 0x41 to 0x5A to that byte plus 0x20, then compares the mapped bytes as unsigned values. Equal mapped bytes then compare the raw bytes. So the order is total and needs no locale, `localeCompare`, `Intl.Collator`, or `toLowerCase`.
- Siblings: a folder, a submodule row, and a nested-repository row sort as folders, before the files. Each group sorts by `compareNames`.
- Flat layout: `comparePaths` walks the components. At the first component that differs, or where one path ends, the folder side comes first, then `compareNames`. So the flat order equals the order of the tree leaves.
- Lists: the Changes and Staged trees and their flat layouts (`file-tree.ts:33` keeps service order today), the History changed-file list, the References tree (`ReferencesSidebar.tsx:104` keeps the first-entry order today), the preview lists (sorted in the service), and the Delete confirmation list. The group order of the References tree (Branches, Remotes, Worktrees, Tags, Submodules, Stashes) stays.
- Cost: each row builds its mapped key once per read. A 100,000-row sort runs once per snapshot, not per render. P6 measures it inside the 004 SC-007 budget.

### D5 Show in Explorer for a folder

- Payload: `revealPath {repositoryId, entryId, folder?}`. `folder` holds the base64 path bytes of the folder row. It must be a proper prefix of the entry path, followed by `/`, which is the `reviewIgnore` check (`ignore.ts:129-133`). Another value gives `INVALID_REQUEST`.
- `revealTarget` (`session.ts:99`) joins the folder bytes in place of the entry path. The shell walk already accepts a directory (`process_requests.rs:1267`), and `SHOpenFolderAndSelectItems` on a folder opens its parent with the folder selected (N8).
- Absent: the shell walk that finds no entry replies `absent`. The service gives `UNKNOWN_TARGET` with reason `absent`, and no Explorer window opens. The renderer shows "<path> does not exist. Select Refresh (F5)." for a folder and for a file.
- `SHOW_FOLDER_REASON` (`ChangesPane.tsx:32`) goes.

### D6 Delete: review and run

- Scope (spec FR-020 to FR-022): rows of the Changes list only. Entry categories `unstaged` and `untracked`. A `staged` entry gives `INVALID_REQUEST`.
- Refusals before any token, each as `WORKBENCH_UNAVAILABLE`: `conflicted` (a `conflicted` entry); `submodule` (a porcelain v2 record whose `<sub>` field starts with `S`); `nested-repository` (an untracked record that ends with `/`, which git-status(1) prints only for a nested repository with `--untracked-files=all`); `limit` (more than `MULTI_FILE_ACTION_FILES` entries); `no-recycle-bin` (mode `recycle` in a WSL workspace); `nothing-to-delete` (every entry has an unstaged deletion, Y = `D`, so no working file exists); `unreadable` (a `fileFacts` reply of kind `error`).
- Delete counts as a mutation for 001 FR-015 and FR-016 (spec FR-033). So the 004 common refusals apply before any token: `OPERATION_IN_PROGRESS` (and `unknown-operation`) during an unfinished operation, and `CONFLICTED` with the count while the index holds unmerged entries.
- Folder: `folder` holds the folder row bytes. The entries must equal every Changes entry of the snapshot below the folder, the rows that Filter files hides included (004 FR-101). Another set gives `STALE_SELECTION`. Entries with an unstaged deletion leave the plan, because they have no working file. A folder with a conflicted, submodule, or nested-repository entry refuses with that reason. No part runs.
- Review reads: `fileFacts` with `digest: true` for each path, 64 entries per frame (`FILE_FACT_ENTRIES`). A `file` fact binds `size`, `lastWrite`, and the SHA-256 of a file up to 1 MiB. A larger file has `bound` and binds `size` and `lastWrite` only (spec FR-030 known limit). A `link` fact binds the tag and the target. A `directory` or `other` fact at an entry path gives `STALE_SELECTION`, because the status read no longer holds.
- Plan: `{mode, entryIds, files, tracked, folder, wsl}`. `files` counts the paths, and `tracked` counts the `unstaged` entries. The token lives 60 s (`APPROVAL_LIFETIME_MS`).
- Run (`runWorkbench`):
  1. The marker of kind `workbench` with action `delete-files`.
  2. Check phase: `fileFacts` with `digest: true` for every path again. Any fact that differs from the review gives `STALE_REVIEW` reason `files-changed`, and nothing is deleted (US2 scenario 5).
  3. Delete phase: `fileDelete` requests of at most 64 entries each, in tree order (D7). The shell checks each entry again under its handle. A difference there gives `stale` for that file only (spec FR-030).
  4. Folder phase, folder Delete only: one more `fileDelete` with the candidate folders, deepest first. The candidates are the selected folder and every folder between it and a deleted file. No folder above the selected folder is a candidate.
  5. Reconcile: fresh `fileFacts` (`digest: false`) of every path and folder, then `readWorkspace`.
- Deadline per `fileDelete`: `GIT_PROCESS_DEADLINE_MS` plus `MULTI_FILE_STEP_MS_PER_FILE` per entry, capped at `REGISTERED_DEADLINE_CAP_MS` (120 s). A Windows warning dialog that waits for the user can hold the reply past it (contract gap).
- Outcome per file (spec FR-033), from the reply and the fresh fact:

| Reply | Fresh fact absent | Fresh fact present |
|---|---|---|
| `recycled` | moved to the Recycle Bin | changed |
| `deleted` | deleted | changed |
| `kept` | absent | kept |
| `stale` | absent | changed |
| `not-regular` | absent | not a regular file |
| `error {code}` | absent | error with its code |
| `stopped`, `interrupted`, no reply | absent | stopped |

- Response state: every file `recycled` or `deleted` gives `succeeded`. No file removed gives `failed` with the first reason code (`STALE_REVIEW`, `GIT_FAILED`, or the error code). Otherwise `failed-with-effects`. Cancel gives `canceled` with the per-file outcomes, never an undo.
- Tracked files lose only the working file. No step touches the index (spec FR-032). The test compares the `.git/index` SHA-256 before and after.

### D7 Delete: shell steps

- Windows (`file_delete.rs`):
  - Request rules: each path lies below the worktree root by `file_facts::below`, as `fileAppend` (`process_requests.rs:1147`). The operation holds a `started` marker of kind `workbench` with action `delete-files`. Another operation gets `INVALID_REQUEST`.
  - Walk: `NtCreateFile` opens each folder relative to its parent handle with `OBJ_DONT_REPARSE`, as `file_append.rs:168`. Each folder handle stays open with share READ|WRITE and without `FILE_SHARE_DELETE` until the request ends. So no other process can rename a folder on the way (N6).
  - Target open: relative, access `DELETE|FILE_READ_DATA|FILE_READ_ATTRIBUTES|SYNCHRONIZE`, share READ|WRITE|DELETE, options `FILE_OPEN_REPARSE_POINT|FILE_SYNCHRONOUS_IO_NONALERT`. The open has no `FILE_NON_DIRECTORY_FILE`, because a link to a folder is a directory reparse point (clarify contradiction 7). A directory without a reparse tag gives `not-regular`.
  - Compare: `FILE_STANDARD_INFORMATION.EndOfFile`, `FILE_BASIC_INFORMATION.LastWriteTime`, the SHA-256 for a bound file, and the reparse tag and target for a link (`file_facts.rs` `reparse_point`). A difference gives `stale`.
  - Permanent: `SetFileInformationByHandle(FileDispositionInfoEx)` with `FILE_DISPOSITION_FLAG_DELETE|FILE_DISPOSITION_FLAG_POSIX_SEMANTICS` on the checked handle. No `FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE`, so a read-only file gives `error access-denied` (spec FR-025). A link handle deletes the link itself.
  - Recycle: one `IFileOperation` per request on a COM STA thread with `SetOwnerWindow(main window)`. Flags `FOF_NOCONFIRMATION|FOF_SILENT|FOF_NOERRORUI|FOF_WANTNUKEWARNING|FOF_ALLOWUNDO|FOFX_RECYCLEONDELETE`. No `FOFX_EARLYFAILURE`, so one failed item does not cancel the others. Each checked entry goes in through `SHCreateItemFromParsingName` and `DeleteItem`. Unchecked entries are not added.
  - `PreDeleteItem` reopens the path by the held relative walk and compares `FILE_ID_INFORMATION` with the checked handle. A mismatch returns `HRESULT_FROM_WIN32(ERROR_CANCELLED)`, which cancels this and every later item (Microsoft Learn `IFileOperationProgressSink::PreDeleteItem`). Those entries reply `stopped`.
  - `PostDeleteItem` decides: `hrDelete` S_OK with a non-null `psiNewlyCreated` gives `recycled` with `recycledPath` (its parsing name). S_OK with null gives `deleted` (Microsoft Learn: "If the item was fully deleted, this value is NULL"). Another `hrDelete` gives `kept` with the HRESULT. The fresh read then decides kept or absent (D6).
  - Folders: open relative with `DELETE`, `FILE_DIRECTORY_FILE`, and `FILE_OPEN_REPARSE_POINT`. A reparse tag gives `not-regular`. Then the POSIX disposition delete. `STATUS_DIRECTORY_NOT_EMPTY` gives `kept`.
  - Exactly one reply per request, also after `cancel`, `closeJob`, or a service exit. A stop before an entry gives `stopped` for it and every later entry.
- WSL: the new `wslFiles` mode `delete` (the name `remove` is taken by the owned lock and candidate removal). For each entry: `lstat` of each folder on the way must give a directory, `lstat` of the target must give the bound type, then the size, `st_mtime` in the `lastWrite` form, and the SHA-256 for a bound file must match. Then `unlink`. Folders: `rmdir`, and `ENOTEMPTY` or `EEXIST` gives `kept`. A stop gives `interrupted`, and the fresh read decides. The steps act by path after the `lstat` check (spec FR-031 known limit).

### D8 Ignore editor: read and text rules

- Entry points (spec FR-034, FR-035): the row menu items "Add to .gitignore…" and "Add to info/exclude…" of an Untracked row, and the Repository menu items "Edit .gitignore" and "Edit info/exclude". The editor docks in the Commit view diff region. A Repository menu open from History switches the view to Commit first.
- `readIgnoreFile {target}`: `targetOf` and `factOf` (`ignore.ts:93-120`). Windows reads the bytes with the no-follow fact digest check of `ignore.ts:152-155`. WSL sends `fileFacts` with `digest: true` and `content: true` for the one entry, and the bytes cross the `wsl.exe` pipe (recommendation Q1, at most 1 MiB).
- Refusals (`WORKBENCH_UNAVAILABLE`): `ignore-link` (fact `link`), `ignore-folder` (`directory`), `ignore-not-regular` (`other`), `ignore-size` (`bound`, above 1 MiB), `ignore-not-utf8`, `ignore-nul`, `mixed-line-endings`, `unreadable` (`error`), and `path` (Git names an `info/exclude` outside the common directory, `ignore.ts:107`).
- Codec (`ignore-text.ts`, spec FR-036, FR-037): a leading EF BB BF sets `bom` and leaves the text. Git skips that BOM too (dir.c `skip_utf8_bom`). The bytes must be strict UTF-8 without NUL. Line endings: no CR gives `lf`; every LF after a CR and no other CR gives `crlf`; no line break gives `none`; anything else gives `mixed-line-endings`. The text is the bytes with each CRLF replaced by LF.
- Result: `{file, state: "absent" | "file", text, lineEnding, bom, expected}`. `file` is the path in Git's form. `expected` is `absent` or `{size, sha256}`.
- The added line (spec FR-034): the 004 D9 line from `ignoreLine` (`ignore-line.ts`). The renderer appends `"\n"` first when the text is not empty and does not end with `"\n"`, then the line and `"\n"`. It then selects the line text. A line of the text that equals the line exactly adds nothing, and the editor selects that line.
- Unsaved state: the text differs from the loaded text. Close, a row action for the other file, Open submodule, Open parent repository, and Open repository open the modal "Discard changes to <file>?" first (spec FR-044). A row action for the same file adds its line to the current text.
- The text is plain text in a `textarea`. It is never markup (spec FR-045).

### D9 Ignore preview

- Trigger (spec FR-041): the renderer sends `previewIgnore {target, text, snapshotId}` 400 ms after the last edit. A new edit cancels the running preview (001 §5 "Pending reads"). "Updating preview…" shows while a preview runs. Save stays available.
- Base (in memory, no file): the service keeps one preview base per workspace and target, keyed by `snapshotId`. Another `snapshotId` builds a new base. The base holds the listings, the S verdicts, the expansion cache, and the self-check result.
- Real repository reads (the read gate first):
  - T: `ls-files -z --stage -v` (`indexEntryArgs`). The first record per path counts, so unmerged stages count once. Mode 160000 marks a gitlink. Tag `S` marks a skip-worktree entry.
  - U: `ls-files -o -z --directory --no-empty-directory`. A record that ends with `/` is a folder that holds no tracked entry, or a nested repository (git-ls-files(1) `--directory`; F10).
  - Expansion of a folder record d: `ls-files -o -z -- <d>/`, in batches that fit the 001 §6 command line. It lists every untracked file below d. Zero records mark a nested repository, which stays one path (F10).
  - Each listing: at most `STATUS_LISTING_RECORDS` records and `STATUS_LISTING_BYTES` bytes. Above either, the preview gives reason `listing`.
- Shadow (report Q2, F11, F14), built by the shell context `ignorePreview` for one preview operation (D14):
  1. `init -q --template=` in the shadow folder. The empty template creates no `info/exclude`.
  2. `hash-object -w --no-filters --stdin-paths` with the C-quoted absolute paths of each regular `.gitignore` that the listings name and `fileFacts` shows as a `file` (004 F31 quoting). A link `.gitignore` stays out, because Git opens in-tree ignore files with `PATTERN_NOFOLLOW` (dir.c:1779). The candidate text goes through `hash-object -w --no-filters --stdin`, with the BOM and line endings of the loaded file. A skip-worktree `.gitignore` that is absent on disk goes in as its index blob (`cat-file --batch` in the repository, then `hash-object -w --stdin`), because Git reads that blob (dir.c `read_skip_worktree_file_from_index`).
  3. `update-index -z --index-info` with each ignore file, a 160000 entry for each tracked gitlink, each nested repository, and each folder input, so the shadow holds an empty folder there (report E1).
  4. `-c core.autocrlf=false -c core.eol=lf checkout-index -a -f`. `info/exclude` goes through a second index (`GIT_INDEX_FILE`) with one entry `exclude` and `checkout-index -a -f --prefix=.git/info/`. The saved copy is the real file through `hash-object --stdin-paths`, because Git follows a link at `info/exclude`.
  5. `hash-object --no-filters --stdin-paths` of each written file must equal its OID. Another value gives reason `shadow-copy`.
  6. `-c core.ignorecase=<value> [-c core.excludesFile=<absolute path>] check-ignore --no-index -z --stdin -v -n`. `<value>` is the effective `core.ignorecase` of the repository listing, or `false` when the listing has none (git-config(1) default). A relative `core.excludesFile` joins the worktree root (report "Relative core.excludesFile"). Without an effective value, the default XDG file applies in both repositories.
- Classification (exact by dir.c `prep_exclude`, lines 1731-1745: an excluded folder ends the walk, and every path below it matches that folder pattern):
  - Inputs: every T path, every U file record, and every U folder record as a folder input. A stdin path that starts with `:` gets a `./` prefix (report Q2; F13). The output gives one record per input in input order. A record whose pattern field is not empty and does not start with `!` is ignored.
  - S verdicts come from the base. Base build: the shadow first holds the saved text (S). The S check and the real repository `check-ignore --no-index -z --stdin -v -n` run on the same inputs at the same time. Any input with another verdict gives reason `self-check`. Then the shadow takes the candidate text in the one edited file (C) for the C check. The real command reads the real ignore files without the index (check-ignore.c:187).
  - A U folder record that S does not ignore expands in the base. Its files join the inputs, and its `.gitignore` files join both shadows. Its subfolders join as folder inputs.
  - A U folder record that S ignores stays one input while C also ignores it. When C does not ignore it, it expands for this preview (from the expansion cache). Its files take the S verdict ignored without a check, by the excluded-folder rule. Its `.gitignore` files join only the C shadow.
  - Below a folder input that both texts ignore, no path is checked. That folder counts as one path (spec FR-039).
- Results (spec FR-038): "Newly ignored" are untracked paths that C ignores and S does not. "No longer ignored" are untracked paths that S ignores and C does not. Each group holds the full count and the first 1,000 paths by `comparePaths` (D4). "Tracked files stay tracked." shows with the count of T paths that C matches and S does not, only when that count is not zero.
- Notices (spec FR-040), at most 100 plus a count: a `.gitignore` that `fileFacts` shows as a link, "<path> is a symbolic link. Git does not read it."; a `.gitignore` below a folder that C ignores, "<path> is inside an ignored folder. Git does not read it.".
- Bounds and typed limits (spec FR-039), each as "Preview not available: <reason>.":
  - `paths`: more than 100,000 inputs in one C check (`PREVIEW_PATHS`).
  - `listing`: a listing above its bound, or more than 10,000 ignore files, or an ignore file above 1 MiB.
  - `name-case`: a listed path whose last component equals `.gitignore` under the D4 ASCII fold, but not exactly. The rule holds on every route, so it covers every case-insensitive volume.
  - `long-path`: on Windows, a shadow path of 260 or more UTF-16 units while the effective `core.longpaths` is not true (report: unverified Git behavior).
  - `shadow-copy`, `self-check`, `unreadable` (a `fileFacts` error for an ignore file), `deadline` (a step reached the 30 s read deadline), and `failed` with the code.
- Time (SC-005): the report measured 4.1 to 5.0 s for one `check-ignore` of 100,000 paths on Windows, and 0.28 to 0.34 s in WSL. A preview with a built base runs one C check. The base build first runs the S and real checks at the same time, then the C check, so the first preview takes about two check times. P9 measures both, and SC-005 counts previews with a built base (O-3).
- Temporary files: the shell removes the shadow folder when the preview operation ends, also after Cancel. Each new shadow first removes leftover shadow folders whose owner process record no longer exists (D14).

### D10 Ignore save

- Review `reviewWorkbench {action: "ignore-save", target, text, expected}`: `targetOf` and `factOf` read the file again. A state other than `expected` gives `STALE_REVIEW` reason `ignore-changed`. The codec of D8 applies to the current bytes, so `bom` and `lineEnding` come from the file, not from the renderer. The bytes are the BOM when `bom`, then the text with each LF replaced by CRLF for `crlf`. `lf` and `none` keep LF (spec FR-042). A NUL in the text gives `ignore-nul`. Bytes above 1 MiB give `ignore-size`. The plan holds `{target, file, size, sha256}` of the new bytes. No trust class applies, because no repository program runs. Save counts as a mutation for 001 FR-015 and FR-016 (spec FR-046), so `OPERATION_IN_PROGRESS`, `unknown-operation`, and `CONFLICTED` refuse it before any token. This replaces the 004 exception of the action `ignore`.
- Run: the marker of kind `workbench` with action `ignore-save-gitignore` or `ignore-save-exclude`. Then one `fileReplace {repositoryId, target, path, expected, bytes}`. Then a fresh `fileFacts` digest of the target and `readWorkspace`. A digest equal to the plan gives `succeeded`.
- Windows `fileReplace` (`file_replace.rs`):
  - The `fileAppend` walk with `OBJ_DONT_REPARSE` to the parent folder, and the `fileAppend` path rules (004 Δ6).
  - An existing target opens with `FILE_READ_DATA|SYNCHRONIZE`, share READ|DELETE, `FILE_OPEN_REPARSE_POINT|FILE_NON_DIRECTORY_FILE`. So no other writer can open it for writing. A reparse tag, a folder, or `NumberOfLinks` other than 1 gives `refused not-regular`. A size or SHA-256 other than `expected` gives `stale`.
  - A temporary file `.arbareto-<32 hex>.tmp` opens relative to the parent with `FILE_CREATE`, `DELETE|FILE_WRITE_DATA`. One `WriteFile` and `FlushFileBuffers` follow.
  - `SetFileInformationByHandle(FileRenameInfoEx)` on the temporary handle with `RootDirectory` set to the parent handle. An existing target takes `FILE_RENAME_FLAG_REPLACE_IF_EXISTS|FILE_RENAME_FLAG_POSIX_SEMANTICS`. An absent target takes `FILE_RENAME_FLAG_POSIX_SEMANTICS` only, so a file that appeared since the check gives `stale` (N7).
  - A failure after the create deletes the temporary file by disposition on its handle. A crash between the create and the rename leaves the temporary file (contract gap).
- WSL: the new `wslFiles` mode `replace`. `lstat` on the way, an open of the target with `O_RDONLY|O_NOFOLLOW`, `fstat` must show a regular file with `st_nlink` 1, the size and SHA-256 compare. A temporary file in the same folder with `O_CREAT|O_EXCL|O_NOFOLLOW|O_WRONLY`, `fchmod` to the target mode bits, the write, `fsync`, then `rename(2)` over the target, and `fsync` of the folder. An absent target uses `link(2)` and `unlink(2)` in place of `rename(2)`, so an existing name gives `EEXIST` and `stale`.
- `fileAppend` and the 004 `ignore` review go (spec FR-034). The 004 D9 line rules stay in `ignore-line.ts`.

### D11 Open submodule and the parent chain

- Entry points (spec FR-047): in the Submodules group, Enter and a double-click on a row, and the row menu item "Open submodule". In the Commit view, the row menu of a submodule row of the Changes list.
- Availability, the same in both places (spec FR-048):
  - A Submodules group row with action `clone` or `reuse` has no `.git` entry (001 contract §12 "Actions"). It gives "Initialize this submodule first. Select Update submodules.".
  - A row with depth above 0 gives "Open <parent path> first.".
  - A chain of 8 levels (`SUBMODULE_REVIEW_NESTING_LEVELS`) gives "Arbareto opens at most 8 nested submodules in a row. Open this submodule with Open repository.".
  - Path bytes that are not valid UTF-8 give "The submodule path is not valid UTF-8, so Arbareto cannot open it.".
  - A Commit view row takes the facts of the Submodules group row with the same path bytes. Without a loaded group row, the item stays available, and the service checks decide.
- `openSubmodule {repositoryId, path}` is native-first, as `openWorktree` (`service.rs:865`). `path` is the worktree-relative path text with `/` separators. The shell checks each component by the channel path rule and refuses `.`, `..`, and empty components with `INVALID_REQUEST`. It joins the path to the worktree root (the §11 UNC form for WSL) and binds a `repositoryDiscovery` context. It forwards `{repositoryId, bootstrapId, path}`.
- Service checks (spec FR-049), in this order:
  1. An unfinished mutation in the parent gives `BUSY` before any process (`registration.ts:180`).
  2. The parent read gate.
  3. `ls-files -z --stage -- <path>` in the parent: exactly one record, stage 0, mode 160000, at exactly `<path>`. Otherwise `SUBMODULE_UNAVAILABLE` reason `not-submodule`.
  4. `fileFacts` (`digest: false`) of `<path>` and `<path>/.git`: a directory and an existing `.git` entry (file or directory). An absent `.git` gives reason `submodule-not-initialized`. A link gives reason `path`.
  5. The 001 discovery with the `bootstrapId`. Its worktree root identity must equal the identity of the folder from step 4. Otherwise reason `submodule-not-initialized`, which also covers a `.git` file whose Git directory Git cannot find (F16).
  6. The 001 registration flow with the same `bootstrapId`. Registration releases the parent, because the common identity differs (`registration.ts:179`).
- Trust (spec FR-050): the submodule gets its own trust state through the 004 D12 flow. No approval comes from the parent. Steps 3 and 5 run behind the parent gate, and the discovery profiles load no index (`commands.ts:33`).
- Recent entry: `registered_root` (`service.rs:760-768`) adds `openSubmodule`, so each open stores a recent entry, as `openWorktree` does today (`remember`, `service.rs:1050-1068`).
- Parent chain (spec FR-051), renderer state for the window session: a stack of `{entryId, name, path}`, at most 8. Before it sends `openSubmodule`, the renderer reads `listRecentRepositories` and takes the entry with `current: true`. That entry is the parent. Without one, the stack entry holds `entryId: null`.
- "Open parent repository": an icon button before the repository button, with the folder-up icon and the parent folder name. The tooltip is "Open parent repository" and, on a second line, the full path. The accessible name is "Open parent repository <name>, <path>". One click sends `openRecentRepository {entryId}`. Success pops the stack. `entryId: null`, `UNKNOWN_TARGET`, or `REPOSITORY_UNAVAILABLE` show "Open the parent repository with Open repository." and clear the stack.
- Every other open (Open repository, a recent entry, clone, `openWorktree`) clears the stack.
- WSL (spec FR-052): the same steps through the §11 route.

### D12 Blame

- Sources (spec FR-053): a file of the History diff (`{changesId, fileId}`), a tracked row of the Commit view (`{snapshotId, entryId}`), and "Blame before this commit" (`{blameId, line}`). A History row with status D blames the old path at the chosen parent. Every other History row blames the path at the commit. A Commit view row blames the path at the snapshot HEAD.
- Unavailable in the renderer, with "Git has no history for this file.": an untracked row, a staged addition, and an unborn HEAD. The service gives `BLAME_UNAVAILABLE` reason `no-history` for a path that `ls-tree` does not find.
- Options `{ignoreWhitespace, detectMoves, detectCopies, ignoreList}` map to `-w`, `-M`, `-C`, and the ignore-list toggle (spec FR-057, FR-059).
- Steps (no read gate, D2):
  1. `ls-tree -z -l --full-tree <oid> -- <path>`: exactly one record `<mode> SP <type> SP <oid> SP <size> TAB <path> NUL` at exactly `<path>`. `<size>` is right-aligned in at least 7 characters, and `-` for a gitlink (builtin/ls-tree.c:233 `%7s`). Type `commit` (mode 160000) gives reason `submodule`. A size above 4 MiB (`BLAME_FILE_BYTES`) gives reason `size`. No record gives reason `no-history`. A non-zero exit takes the `hasPromisor` path.
  2. `diff --numstat -z --no-textconv --no-ext-diff --no-relative --no-renames <empty tree> <oid> -- <path>`: `-` and `-` give reason `binary` (spec FR-061). This `git diff` of two trees loads no index (builtin/diff.c `builtin_diff_tree`).
  3. `cat-file blob <blob oid>` gives the content, at most 4 MiB. More than 100,000 lines (`BLAME_FILE_LINES`) gives reason `lines`. A last line without LF counts as a line (blame.c `find_line_starts`).
  4. Ignore list (spec FR-059, FR-060): the `blame.ignoreRevsFile` entries of the shared configuration listing, in listing order. The effective list is the values after the last empty value (config/blame.adoc:24-28). A value counts as relative when it starts with none of `/`, `\`, `~`, `%(prefix)/`, and a drive letter with `:` (Git `is_absolute_path` and `git_config_pathname`), and holds no `..` component. Each relative value gets `fileFacts` below the worktree root. `absent` gives reason `ignore-revs-file-missing`. Other values pass to Git unchanged. Git reads the configured files in both toggle states (builtin/blame.c `build_ignorelist`), so the check applies in both.
  5. Without an effective list, or with the toggle off: `blame --incremental --no-textconv --encoding=none [-w] [-M] [-C] [--ignore-revs-file=] <oid> -- <path>`. The empty `--ignore-revs-file=` comes only with the toggle off, and it clears the list after Git read the files (git-blame(1) `--ignore-revs-file`).
  6. With the toggle on and an effective list: `-c blame.markIgnoredLines=true -c blame.markUnblamableLines=true blame --porcelain --no-textconv --encoding=none [-w] [-M] [-C] <oid> -- <path>`.
- Parse (`blame-parser.ts`, git-blame(1) "THE PORCELAIN FORMAT" and "INCREMENTAL OUTPUT"): a group header `<oid> SP <orig line> SP <final line> SP <count> LF`. Commit headers on the first appearance: `author`, `author-mail`, `author-time`, `author-tz`, `committer`, `committer-mail`, `committer-time`, `committer-tz`, `summary`, optional `boundary`, optional `previous <oid> SP <path>`, and `filename <path>`. Incremental ends each group with `filename`. Porcelain repeats a header per line without the count, prints `ignored` and `unblamable` per line, and prints a TAB content line, which the parser skips after the count check. Paths in `previous` and `filename` are C-quoted when Git quotes them. An unknown header line refuses with `MALFORMED_GIT_OUTPUT`.
- Checks (spec FR-058): the groups cover lines 1 to N exactly once, where N is the step 3 line count. Otherwise `MALFORMED_GIT_OUTPUT`.
- Shallow (spec FR-062): a commit that the view shallow set or the `shallow` file (`topologyPathArgs`, `commands.ts:191`) lists is `shallow`. The `boundary` header does not decide it, because `blame.showRoot` changes it (builtin/blame.c:742).
- Progress (spec FR-063): incremental mode sends `blame` events with `blamed` (the sum of parsed group counts) and `total` (N), at most 4 per second. Porcelain mode sends events without counters.
- Bounds: Git output 32 MiB (`BLAME_OUTPUT_BYTES`), encoded result 12 MiB (`BLAME_RESULT_BYTES`), deadline `HISTORY_PROCESS_DEADLINE_MS` (120 s), Cancel by the Job (SC-006). Above a bound: `OUTPUT_LIMIT`.
- Result: data-model §10. The service retains the latest result per workspace as `blameId`.
- "Blame before this commit" (spec FR-056): the line's group gives commit X with `previous {oid P, path Q}` and the original line o = `origStart + (line - finalStart)`. No `previous` gives reason `no-previous`. `ls-tree` gives the blob of `Q` at P and of `filename` at X. `diff -U0 --no-textconv --no-ext-diff --no-color <blob of Q> <blob of X>` gives the hunk headers `@@ -a[,b] +c[,d] @@` (a count is 1 when Git omits it). `line-map.ts` maps o: inside a hunk with d > 0 and c ≤ o < c + d, the line maps to a, or to a + 1 when b = 0. Otherwise o moves by the sum of (b − d) of the hunks with c + d − 1 < o. The result clamps to 1 and the line count of Q. The new blame runs for `(P, Q)` with the same options and focuses the mapped line.
- Age steps (spec FR-055), in the renderer: c is the count of distinct `author-time` values of the result's commits, r the 0-based rank of a commit's time, oldest first, and the step floor(7 × r / c) + 1. The current time never enters the step.
- Relative date text (renderer, `blame-time.ts`), with d the time from the author time to now: under 1 minute "Less than a minute ago"; under 60 minutes "<n> minutes ago"; under 24 hours "<n> hours ago"; under 14 days "<n> days ago"; under 60 days "<n> weeks ago"; under 365 days "<n> months ago" with n = floor(days / 30); else "<n> years ago" with n = floor(days / 365). A count of 1 uses the singular. A time after now shows the full date. The tooltip shows the 001 commit details date form.

### D13 Branch card and the gone mark

- `BranchEntry.upstreamPresent` (`readBranches`): `upstream !== null` and the same `for-each-ref` read holds that ref, as `refs-parser.ts:94` does for `RefEntry`. No new read.
- Gone rule (spec FR-064): `upstream !== null && !upstreamPresent`. A removed remote gives an empty `%(upstream)` (remote.c `branch_get_upstream`), so no mark. It agrees with the 003 track state `gone` of the same read (spec Assumptions).
- Mark: the `Unlink01Icon` Hugeicons icon, 16 px, `currentColor`, after the name in the sidebar row, the branch list row, and the card. Its tooltip is "The upstream <name> no longer exists.". The accessible name of the row gains ", upstream gone" in place of the visible ", not present" (`ReferencesSidebar.tsx:51`). The visible "→ <upstream>" text stays.
- Card: shadcn `hover-card` (Base UI PreviewCard), added with `bunx --bun shadcn@4.21.0 add hover-card`. When the `base-mira` registry has no `hover-card`, WP2 uses `@base-ui/react` PreviewCard directly, as the generated components do.
- "Cut" (spec FR-065): `scrollWidth > clientWidth` of the name element, read at pointer enter and at focus. Rows: sidebar branch rows, sidebar remote rows, branch list rows, and the branch button.
- Content (spec FR-066): the full name; "Upstream: <name>" or "No upstream"; with a present upstream "<a> ahead, <b> behind" or "Up to date" from the 003 tracking state; with the gone rule "Upstream gone: <name> no longer exists"; "Checked out in <worktree path>" from the latest `readBranches` `heldBy`. A remote row card shows only the full name. Without a loaded `readBranches` result, the card leaves out the worktree line.
- Keys: the card opens at once on keyboard focus and after the PreviewCard default delay on hover. Escape closes it, and the focus stays on the row. The row keeps its accessible name, and the card text is its accessible description while it shows.

### D14 Shell

- Allowlist: the commands of D1.
- `fileDelete` (`file_delete.rs`) and `fileReplace` (`file_replace.rs`): D7 and D10. Both reuse the `file_append.rs` walk (`open_root`, `open_relative` with `OBJ_DONT_REPARSE`). `file_append.rs` goes with `fileAppend` after WP3 moves the shared walk into `file_delete.rs`.
- COM: the Recycle Bin request runs on its own STA thread (`CoInitializeEx(COINIT_APARTMENTTHREADED)`) with a message loop while `PerformOperations` runs, and `SetOwnerWindow` with the main window. WP3 records the `windows` crate features that it adds.
- Shadow context (`shadow.rs`), kind `IgnorePreview` in `bootstrap.rs` `ContextKind`:
  - The private request `shadow {op: "create"}` creates `<launch directory>/preview/<shell PID>-<shell creation time>-<16 hex>/` (Windows) or, for a WSL workspace, `/tmp/arbareto-preview-<shell PID>-<shell creation time>-<16 hex>/` through the new `wslFiles` mode `scratch`. It replies `{shadowId}`.
  - The context belongs to the requesting operation. The shell removes the folder when that operation ends, after Cancel, `closeJob`, or a service exit. Windows uses the no-follow walk and disposition deletes. WSL uses `scratch` with `remove`, which deletes only below the `arbareto-preview-` prefix with `lstat` and no link following.
  - Before each create, the shell removes every shadow folder whose owner PID and creation time match no live process record (OS process facts), and every own folder that no live context holds.
  - Accepted arrays in the context, cwd the shadow folder, each with `--no-lazy-fetch`: `init -q --template=`; `hash-object -w --no-filters --stdin-paths`; `hash-object -w --no-filters --stdin`; `hash-object --no-filters --stdin-paths`; `update-index -z --index-info`; `-c core.autocrlf=false -c core.eol=lf checkout-index -a -f`, also with `--prefix=.git/info/`; `-c core.ignorecase=<true|false> [-c core.excludesFile=<path>] check-ignore --no-index -z --stdin -v -n`. The shell sets `GIT_INDEX_FILE` only to `<shadow>/.git/index` or `<shadow>/.git/exclude.index`. Any other array gives `INVALID_REQUEST`.
- `reveal` reply `absent` (D5): the walk finds no entry.
- `openSubmodule` native step (D11) and `registered_root` (`service.rs:764`).
- Close prompt names and marker actions: "Delete files" (`delete-files`), "Save .gitignore" (`ignore-save-gitignore`), and "Save info/exclude" (`ignore-save-exclude`). "Add to .gitignore" and "Add to info/exclude" go.
- WSL `fileFacts` `content`: the shell forwards the bytes of the one entry in the `file` fact as base64, only with `digest: true` and one entry. A Windows request with `content` gives `INVALID_REQUEST` (recommendation Q1).

### D15 Frontend architecture and texts

- History view (Main board). The dock region "Selected commit" with the 32 px heading. Regions: Commit details 268 px wide (12 px padding), Changed files 288 px wide, and the diff with the rest of the width. The splitters follow the 001 "Splitter" rule (8 DIP hit area, thin rule). The Changed files region stacks the 32 px heading with the Tree layout and Flat layout icon buttons, the "Compare with" row (padding 6 px 8 px, 24 px radios) for a merge commit, the Filter files field row (8 px padding, 28 px field with the search icon), and the virtual tree (26 px rows, 8 px plus 16 px per level, the 16 px status letter column). Each region scrolls by itself.
- Changed files keys (spec FR-007, FR-013): one Tab stop with roving focus. Up and Down move the selection and show its diff at once, without motion. Left and Right collapse and expand a folder. Home and End go to the first and last row. Ctrl+F focuses Filter files while the focus is in Changed files or in the diff. Elsewhere in History, Ctrl+F keeps the 002 history filter. F6 reaches Changed files and then the diff after the commit details.
- Blame view (Blame board). It replaces the History list in place through the 004 dock swap. The 32 px heading holds Back (Esc), "Blame: <path> at <short ID>" with the path and the ID in the 12 px code font, and the 24 px button "Blame before this commit (Alt+Left)". The 32 px toolbar "Blame options" holds three 24 px toggle buttons with `aria-pressed`, a divider, "Skip commits in the ignore list" with its icon (only with an effective list), and "<n> lines" at the end. The line list uses 20 px rows and the columns 4 px age bar, 236 px gutter (short ID in the code font, the author, the relative date in Muted text), 16 px marker, 40 px line number, then the content in the code font. The first line of each run has a 1 px top divider, and only that line shows the gutter text. The selected line shows the selection marker and the Text line number. A 28 px legend row ends the region. The commit details of the selected line show below in the dock.
- Blame keys (spec FR-056): one Tab stop with roving focus. Up and Down select a line and show its commit details at once. Enter or a click selects the line's commit in History. Alt+Left runs "Blame before this commit". The handler calls `preventDefault`, because WebView2 maps Alt+Left to back navigation. Escape and Back return to the History list, or to the Commit view row for a Commit view source (spec FR-054).
- Blame texts:
  - Heading "Blame: <path> at <short ID>". Back "Back (Esc)". Toolbar name "Blame options". Toggles "Ignore whitespace", "Detect moved lines", "Detect lines from other files", "Skip commits in the ignore list". Count "<n> lines" ("1 line").
  - Progress: "Blaming… <blamed> of <total> lines" with Cancel. With an ignore list: "Blaming…" with Cancel.
  - Stopped: "Blame stopped before Git finished."
  - Marks: "?" with the tooltip "Ignored. Git skipped the commit of this line." and "*" with the tooltip "Unblamable. Git found no commit for this line after the skip.". The line name adds ", ignored" or ", unblamable".
  - Shallow: "Earlier history is not in this clone." on the second line of the run, or in the tooltip of a run of one line.
  - Tooltip of the gutter: the 001 date form, then "Path in this commit: <name>" when `filename` differs from the blamed path.
  - Line name: "Line <n>, <short ID>, <author>, <relative date>", plus the marks. The line text is its accessible description.
  - Legend: "Older" and "Newer" around the seven shades. Tooltip "The shade ranks the commits of this file by author date. Today's date has no effect.". The legend group name is "Commit age, older to newer".
  - Refusals: `no-history` "Git has no history for this file."; `binary` "Arbareto does not blame a binary file."; `submodule` "This path is a submodule. Open the submodule to blame its files."; `size` "Arbareto does not blame a file larger than 4 MiB."; `lines` "Arbareto does not blame a file with more than 100,000 lines."; `ignore-revs-file-missing` "Git cannot run blame. The file <path> that blame.ignoreRevsFile names does not exist."; `no-previous` "Git names no earlier version of this line.". A failure: "Blame did not complete: <code>." with "Show output" for `GIT_FAILED`.
- Commit view row menu (CommitActions board), 300 px wide, 28 px rows, groups with separators:
  1. Stage file, Unstage file, Stage folder, Unstage folder, or Mark resolved (the 004 items), "Open submodule" (submodule rows), "Blame" (tracked file rows), "Copy path", "Show in Explorer".
  2. "Add to .gitignore…" and "Add to info/exclude…" (Untracked rows only; the ellipsis marks the editor step).
  3. The labelled group "Delete from disk" (24 px group label, weight 600, Muted): "Delete…" (Del) and "Delete permanently…" (Shift+Del), with the trash icon and Removed text (004 D-S5). Changes list rows only.
- Delete unavailable reasons (Muted, on the item line or wrapped below it): `conflicted` "Arbareto does not delete a file with a conflict."; `submodule` "Arbareto does not delete a submodule."; `nested-repository` "This folder holds another Git repository."; `limit` "Delete covers at most 10,000 files."; `nothing-to-delete` and a single unstaged deletion "This file is already deleted from the working tree."; `OPERATION_IN_PROGRESS` "A Git operation is in progress. Finish it first." and `CONFLICTED` "Resolve the <n> conflicted files first." (the 004 D15 texts); a running mutation: the 003 running reason in the tooltip only (004 D15).
- Delete keys (spec FR-023): Del and Shift+Del act only while the Changes list has focus. They act on the selection, or on the focused row without a selection.
- Delete confirmation (DeleteConfirm board): the 001 modal dialog with the alert icon and the 14/20 px title. The body lists the first 20 paths in tree order in the code font, inside a Canvas box with a 1 px divider edge, radius 4, padding 6 px 8 px, 18 px lines. Then "and <m> more files." ("and 1 more file."). Notices: the tracked line and the WSL line on Warning fill, "You cannot undo this." on Removed fill, each with its icon. The folder line sits above the list. The footer: a top divider, padding 8 px 12 px, Cancel with the first focus, then the danger button. Titles and buttons: spec FR-026 to FR-029.
- Delete run texts: status bar names "Delete files", "Deleting files", "Delete files details". Progress "Deleting files (<i> of <n>)…". Outcomes: "Moved <n> files to the Recycle Bin." ("1 file"), "Deleted <n> files permanently.", else "Delete finished: <parts>." with the non-zero parts "<n> moved to the Recycle Bin", "<n> deleted", "<n> kept", "<n> changed", "<n> not on disk", "<n> not regular", "<n> failed", "<n> stopped". `STALE_REVIEW` `files-changed`: "The files changed after the review. Arbareto deleted nothing. Select Refresh (F5), then delete again." `APPROVAL_EXPIRED`: "The review expired. Select Delete again.". Cancel: "Delete stopped: <parts>.". The details list each path with its outcome: "Moved to the Recycle Bin", "Deleted", "Kept", "Changed, not deleted", "Not on disk", "Not a regular file, not deleted", "Not deleted: <code>", "Stopped, not deleted".
- Folder reveal text (D5): "<path> does not exist. Select Refresh (F5).".
- Ignore editor (IgnoreEditor board): docked in the Commit view diff region, non-modal. The 32 px heading holds the file-edit icon, "Edit .gitignore" or "Edit info/exclude" (14/600), and the path in Muted code font, cut with an ellipsis and a tooltip with the full path. The body holds the editor and a 340 px preview with the splitter "Resize editor and preview". The editor has a 44 px line-number gutter (Muted code font, right-aligned, 1 px right divider, only the visible numbers render) and the `textarea` (code font, 18 px lines, padding 8 px, no wrap, `spellcheck="false"`). The selected line has the Selected fill. The footer holds Close and Save (Accent fill), right-aligned.
- Ignore editor keys: Ctrl+S saves while the focus is in the editor panel. Escape runs Close while the focus is in the editor panel and no IME composition runs. The textarea keeps Tab as focus movement.
- Ignore editor texts:
  - Preview: "Updating preview…" (status role); "Newly ignored (<n>)" and "No longer ignored (<n>)" group headings (28 px, with icons); 22 px path rows in the code font; "and <n> more paths" after 1,000 rows; "Tracked files stay tracked." with the count at the end of the note row; the notices of D9; "Preview not available: <reason>." on Warning fill.
  - Preview reasons: `paths` "the preview checks more than 100,000 paths"; `listing` "Git lists more paths or ignore files than the preview reads"; `name-case` "a file name differs from .gitignore only in letter case"; `long-path` "a path is too long for the preview copy, and core.longpaths is off"; `shadow-copy` "Arbareto cannot copy the ignore files for the preview"; `self-check` "the preview does not match Git for the saved text"; `unreadable` "Arbareto cannot read an ignore file of this repository"; `deadline` "the preview took longer than 30 seconds"; `failed` "Git failed with <code>"; the read gate gives the 004 D12 trust text and "Trust…" in place of the preview.
  - Discard modal: title "Discard changes to <file>?", buttons "Keep editing" (first focus) and "Discard" (danger).
  - Stale save: a Warning notice "<file> changed on disk after Arbareto loaded it. Arbareto did not save your text." with the button "Reload". With unsaved text, Reload opens the discard modal first.
  - Open refusals, shown in the editor region in place of the text: `ignore-link` "<file> is a symbolic link. Arbareto edits only a regular file."; `ignore-folder` "<file> is a folder. Arbareto edits only a regular file."; `ignore-not-regular` "<file> is a special file. Arbareto edits only a regular file."; `ignore-size` "<file> is larger than 1 MiB. Arbareto does not edit it."; `ignore-not-utf8` "<file> is not valid UTF-8 text. Arbareto does not edit it."; `ignore-nul` "<file> holds a NUL character. Arbareto does not edit it."; `mixed-line-endings` "<file> has mixed line endings, or a CR without an LF. Arbareto does not edit it."; `unreadable` "Arbareto cannot read <file>: <code>."; `path` "Git names an info/exclude path outside the Git folder. Arbareto does not edit it.". `<file>` is ".gitignore" or "info/exclude".
  - Save texts: status bar names "Save .gitignore", "Saving .gitignore", "Save .gitignore details" (and info/exclude). Outcome "Saved .gitignore." or "Saved info/exclude.". `ignore-size` at save: "The text is larger than 1 MiB. Arbareto did not save it."; `ignore-nul`: "The text holds a NUL character. Arbareto did not save it.". `OPERATION_IN_PROGRESS` and `CONFLICTED` take the 004 D15 texts, and the text stays in the editor. Another failure: "Save did not complete: <code>.".
- Submodules (SubmoduleOpen board): the row menu adds "Open submodule" first, before "Update" and "Copy path". An unavailable item shows its reason on a second line, indented 24 px. BUSY: "A Git operation is running in this repository. Wait for its result, then open the submodule." Other refusals: `submodule-not-initialized` takes the FR-048 text; `not-submodule` "Git lists no submodule at <path>."; `path` "The submodule path holds a link, so Arbareto cannot open it."; another code "Open submodule did not complete: <code>.".
- Parent button (SubmoduleOpen board): a 28 px button with the folder-up icon and the parent folder name, before the repository button, with the 004 tooltip shadow.
- Branch card (BranchCard board): 360 px wide, padding 12 px, gap 6 px, radius 6, the overlay shadow, opened beside the row at its end edge. The name line has weight 600 and wraps at any character. Each fact line has a 16 px icon. The worktree path uses the code font.
- F6 order: History keeps the 001 order, with Changed files and the diff after the commit details. The blame view takes the place of the History list in that order. The Commit view keeps the 004 order. The ignore editor takes the diff place, with the editor and then the preview.
- State: `state/history-view.ts` gains the commit changes, the selected file, the parent index, and the blame state. `state/workbench.ts` gains the delete review, the ignore editor state (target, loaded text, current text, preview), and the parent chain. All follow the 001 latest-wins and generation rules.
- Keyboard map additions (spec FR-067, conflict check against 001 to 004):

| Key | Action | Scope | Conflict check |
|---|---|---|---|
| Delete | Delete… | Changes list with focus | 004 Delete acts on a focused branch row and in the worktree list. Different regions. |
| Shift+Delete | Delete permanently… | Changes list with focus | None |
| Enter | Open submodule | Submodules group row | 004 Enter on that row had no action. |
| Enter | Select the line's commit in History | Blame list | None |
| Alt+Left | Blame before this commit | Blame list | WebView2 back navigation, prevented. |
| Escape | Back | Blame view | 004 Escape closes popovers first. |
| Ctrl+S | Save | Ignore editor panel | 004 Ctrl+S saves Settings, only in the Settings view. |
| Escape | Close | Ignore editor panel, no IME composition | None |
| Ctrl+F | Filter files | Changed files or the History diff | 002 Ctrl+F stays elsewhere in History. |
| Escape | Close the card | Branch card open | None |

### D16 UI standard additions

- Tokens: the 001 and 004 tokens. New: seven age shades, Dark from the Blame board: `#323B4B`, `#3E4D66`, `#4A5F82`, `#56719D`, `#6283B9`, `#6E95D4`, `#7AA7F0` (step 1 to 7). Light shades are open (O-2). The proposed Light ramp is `#DCE8FA`, `#BDD1EF`, `#9FB9E3`, `#80A2D8`, `#618BCC`, `#4373C1`, `#245CB5`, the sRGB steps from the Light Selected fill to the Light Accent.
- The age bar is decoration. The relative date stays the cue.
- Forced colors (ForcedColors board): menus, the card, dialogs, and tooltips keep a 1 px CanvasText edge. The selected row uses Highlight with HighlightText. The focus outline is 2 px Highlight. Delete items keep CanvasText, and the group label and its separator stay the cue, because forced colors remove the Removed color. Unavailable items use GrayText. The age bar takes `forced-color-adjust: auto`, so it disappears, and the relative date stays. The gone icon uses `currentColor` and stays visible. Status letters stay text. Notice fills disappear, and their icons stay.
- Light (Light board): the 001 Light tokens. The Light title bar value stays open (004 O-13).
- Motion: none on selection, arrow keys, the diff, the blame lines, and the preview update. The card and menus open with the 004 popover motion, and nothing moves under `prefers-reduced-motion: reduce`.
- Copy: "Label (Key)" on buttons and tooltips. "…" only when a further step follows: "Delete…", "Delete permanently…", "Add to .gitignore…", "Add to info/exclude…".

### D17 WSL

- History reads and blame run through the distro's Git with the 001 `read` wrapper mode. Only Git output crosses, which §11 allows.
- Delete: `wslFiles` mode `delete`; plain Delete opens the permanent confirmation with "Files in a WSL distro have no Recycle Bin." (spec FR-029).
- Ignore editor: the read crosses one file of at most 1 MiB out of the distro (`fileFacts` `content`). The preview text and path lists cross into the distro on stdin. The shadow lives under `/tmp` (`wslFiles` mode `scratch`). Save uses `wslFiles` mode `replace` (spec FR-043).
- Open submodule: the 001 §11 route for the joined path.
- Verify in Ubuntu-26.04: F1 to F18, the `./` stdin prefix (F13), the shadow cleanup, and the three Perl modes.

### D18 Tests and fixtures

- Oracles: Git's own command on a copy. History: `diff-tree` sets and patches. Blame: `git blame --porcelain` with the same options, line by line. Preview: the change of `ls-files -o -i --exclude-standard -z` and `ls-files -c -i --exclude-standard -z` after a real save on a copy. Delete: absent paths, unchanged other bytes, the `.git/index` SHA-256, and the Recycle Bin item.
- Recycle Bin tests purge each item that they moved through the reply `recycledPath`, and they change no other Recycle Bin item (SC-003).
- Canaries: a command-valued `core.fsmonitor` writes a marker file. It must stay absent for blame, the folder reveal, and the branch card in an untrusted repository, and absent for the gated reads before approval.
- Each new test file adds its line to `tests/groups.json`. Timing tests go into `serial`.
- Mutation tests copy the 001 control rule: one control mutation turns each oracle red.
- A green run from a worktree prints where it imported the code under test (global rule).

### Invariants

| Invariant | Evidence |
|---|---|
| `diff-tree <merge>` prints nothing; the two-tree form works for every parent and for a root against the empty tree. | design R1 (probed on Git 2.56.0.windows.2) |
| `diff-tree` loads the index; `ls-files` loads the index. | Git 2.56 builtin/diff-tree.c:132, builtin/ls-files.c:681 |
| `git diff` of two blobs or two trees loads no index. | Git 2.56 builtin/diff.c: only `builtin_diff_index` (:163-167), `builtin_diff_files` (:285), and `refresh_index_quietly` (:246, only with `skip_stat_unmatch` above 1) read it |
| `check-ignore --no-index` loads no index. | Git 2.56 builtin/check-ignore.c:187 |
| Blame of a commit loads the index only for the working tree. | Git 2.56 blame.c:205, :290 (`fake_working_tree_commit`) |
| Blame turns textconv on by default. | Git 2.56 builtin/blame.c:1026 |
| Porcelain prints `ignored` and `unblamable` per line only with the mark keys. | Git 2.56 builtin/blame.c `emit_porcelain_per_line_details` |
| `blame.ignoreRevsFile` repeats; an empty value resets. | config/blame.adoc:24-28; builtin/blame.c:764-772 |
| An excluded folder ends the ignore walk. | Git 2.56 dir.c `prep_exclude` (:1731-1745) |
| In-tree `.gitignore` files open without following a link. | Git 2.56 dir.c:1779 `PATTERN_NOFOLLOW` |
| Git skips a UTF-8 BOM in an ignore file. | Git 2.56 dir.c:1242 `skip_utf8_bom` |
| `ls-files -o --directory` prints a wholly untracked folder as one record. | git-ls-files(1) `--directory` |
| `PostDeleteItem` `psiNewlyCreated` is null for a full delete. | Microsoft Learn `IFileOperationProgressSink::PostDeleteItem` |
| A `PreDeleteItem` failure cancels this and every later item. | Microsoft Learn `IFileOperationProgressSink::PreDeleteItem` |
| `FOF_WANTNUKEWARNING` partially overrides `FOF_NOCONFIRMATION`. | Microsoft Learn `IFileOperation::SetOperationFlags` (behavior unverified, N2) |
| Each `openWorktree` registration stores a recent entry. | `service.rs:760-768`, `:1050-1068` |
| Git names no upstream for a branch whose remote is gone. | remote.c:1796-1801, :1908 (clarify F2) |

## Open items and reviewer defaults

- **O-1 Visible upstream text.** The approved boards show no "→ <upstream>" text in the sidebar rows. The spec changes only ", not present". The plan keeps the 001 visible upstream text. A board-driven removal needs a spec change.
- **O-2 Light age shades.** The boards define only the Dark shades. D16 proposes a Light ramp. The design pass confirms it, as 004 O-13.
- **O-3 SC-005 runs.** The first preview of an editor session builds the base: the S and real checks run at the same time, then the C check. SC-005 counts the previews with a built base. P9 records the first preview time too.
- **O-4 Delete permanently on volumes without POSIX delete.** `FileDispositionInfoEx` with POSIX semantics can fail on such a volume (unverified, N5). The file then stays, and the result names the error. No fallback runs.
- **O-5 WSL `remove` name.** Design R4 named the WSL mode `remove`. That name is the existing owned-lock removal. The plan names the new mode `delete`.
- **O-6 Public request bound.** The 001 bound of 1 MiB rises to 2 MiB, so a 1 MiB editor text fits a request. Another option was a lower editor bound, which spec FR-036 does not allow.
- **O-7 `FOFX_EARLYFAILURE`.** Design R4 listed it. The plan drops it, so one failed recycle does not cancel the other items. Identity mismatches still cancel the rest through `PreDeleteItem`.
- **O-8 Tree order module path.** Design R2 proposed `src/frontend/tree-order.ts`. The service sorts the preview lists too, so the module sits in `src/contracts/`.

## Phases

### Batches

| Batch | Steps | Tracks that run in parallel | Content |
|---|---|---|---|
| 0 | WP0, P2 | WP1 alone after WP0. | This plan, then the contracts. |
| 1 | P0.1 to P0.3, P1, P3, P4, P6 | A: WP2. B: WP3 (local Windows). C: WP4. | Facts first inside each package, then the shell, the History service, and the frontend base. |
| 2 | P5, P7 | A: WP5 (after WP4). B: WP6 (after WP2 and WP4). | The file action service and the History UI. |
| 3 | P8 | WP7 alone (after WP5 and WP6). | The Commit view UI. |
| 4 | P9 | WP8 (WSL alone, then packaged). | Qualification. |

User stories by priority: P1 is US1 and US2 (WP4, WP5, WP6, WP7). P2 is US3 to US7 (WP2, WP5 to WP7). P3 is US8 and US9 (WP2).

### Work packages, in run order

| WP | Agent | Files | Steps |
|---|---|---|---|
| WP0 | orchestrator | `specs/005-inspection-file-actions/{plan.md, research.md, data-model.md, contracts/operations.md, quickstart.md}`, the cross-feature text changes | This plan. Then `/speckit-tasks` and `/speckit-analyze`. |
| WP1 | implementer | `src/contracts/{operations,envelope,errors,limits,channel}.ts`, new `src/contracts/tree-order.ts`, `src/contracts/schemas/`, `tests/vectors/`, `tests/contracts/{inspection-contract,tree-order}.test.ts` | P2 and the comparator of P1. |
| WP2 | frontend-implementer (loads arbareto-ux, vercel-react-best-practices, web-design-guidelines, shadcn) | `src/frontend/changes/file-tree.ts`, `src/frontend/refs/ReferencesSidebar.tsx`, `src/frontend/branches/BranchButton.tsx`, new `src/frontend/branches/BranchCard.tsx`, new `src/frontend/components/ui/hover-card.tsx`, `src/git-service/branches.ts` (`upstreamPresent`), `tests/contracts/inspection-tree.test.tsx`, `tests/contracts/inspection-card.test.tsx`, `tests/git/branch-gone.test.ts` | P6: US3, US8, US9. After WP1. |
| WP3 | implementer-xhigh | new `src-tauri/src/{file_delete,file_replace,shadow}.rs`, remove `src-tauri/src/file_append.rs`, `src-tauri/src/{process_requests,schema,wsl,reveal,service,bootstrap,lib}.rs`, `src-tauri/Cargo.toml` and `Cargo.lock` (features), `src/contracts/wsl-process.json` (modes `delete`, `replace`, `scratch`), `tests/windows/delete-facts.test.ts` | P0.3 and P3. Local only. After WP1. |
| WP4 | implementer | new `src/git-service/{commit-changes,blame,blame-parser,line-map}.ts`, `src/git-service/{commands,diff-parser,history-view,session}.ts`, new `tests/git/{history-diff-fixtures.ts,history-diff-facts.test.ts,commit-changes.test.ts,blame.test.ts}`, `tests/contracts/{blame-parser,line-map}.test.ts` | P0.1 and P0.2 (History part), P1 (History part), P4: US1, US7 service. After WP1. |
| WP5 | implementer-xhigh | new `src/git-service/{file-delete,ignore-text,ignore-preview,submodule-open}.ts`, `src/git-service/{ignore,workbench-review,native-runner,git-runner,session}.ts`, `tests/git/bun-runner.ts`, new `tests/git/{file-actions-fixtures.ts,file-actions-facts.test.ts,delete.test.ts,ignore-editor.test.ts,ignore-preview.test.ts,submodule-open.test.ts}` | P0.1 and P0.2 (file part), P1 (codec), P5: US2, US4, US5, US6 service. After WP4, because both edit `session.ts`. |
| WP6 | frontend-implementer | `src/frontend/history/CommitDetails.tsx`, new `src/frontend/history/CommitChanges.tsx`, new `src/frontend/blame/{BlameView.tsx,blame-time.ts}`, `src/frontend/state/history-view.ts`, `src/frontend/views/HistoryView.tsx`, `src/frontend/bridge.ts`, `src/frontend/app/Workbench.tsx`, `tests/contracts/{inspection-history,inspection-blame}.test.tsx` | P7: US1, US7 UI. After WP2 and WP4. Parallel with WP5. |
| WP7 | frontend-implementer | `src/frontend/changes/{ChangesPane.tsx,file-actions.ts}`, new `src/frontend/changes/DeleteConfirm.tsx`, new `src/frontend/ignore/IgnoreEditor.tsx`, `src/frontend/submodules/SubmodulesGroup.tsx`, new `src/frontend/app/ParentButton.tsx`, `src/frontend/app/{Workbench,RepositoryMenu}.tsx`, `src/frontend/state/workbench.ts`, `src/frontend/bridge.ts`, `src/frontend/keyboard/shortcuts.ts`, `tests/contracts/{inspection-delete,inspection-ignore,inspection-submodule,shortcuts-005}.test.tsx` | P8: US2, US4, US5, US6 UI, and the Commit view Blame entry. After WP5 and WP6. |
| WP8 | implementer writes, scout runs (WSL alone) | `tests/wsl/inspection-wsl.test.ts`, `tests/windows/{inspection-packaged,inspection-perf}.test.ts` | P9. Last. |

Parallel tracks use disjoint files in separate worktrees. These files are not disjoint:
- `src/git-service/session.ts`: WP4, then WP5.
- `src/frontend/app/Workbench.tsx` and `src/frontend/bridge.ts`: WP6, then WP7.
- `src/frontend/changes/file-tree.ts`: WP2 changes the order. WP7 uses it unchanged.
- `src/contracts/envelope.ts`, `errors.ts`, `limits.ts`, `channel.ts`, and `schemas/`: WP1 owns them. A later package that needs a schema change reports it, and the orchestrator merges it.
- `tests/groups.json`: every WP appends its lines. The orchestrator resolves merge conflicts.
- Rust: only WP3 edits `src-tauri/`.

Dependencies: main at 3575a15 holds features 001 to 004. No 005 package waits for another feature.

## Agent context

Spec Kit v1.0.12 in this repository has no `update-agent-context` script, and `setup-plan.ps1` changes no agent file. So this step changes no `CLAUDE.md`. The plan adds no technology that CLAUDE.md must name. A CLAUDE.md change goes through `claude-md-management:claude-md-improver`.

## Complexity Tracking

No Constitution Check violation. The table stays empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
