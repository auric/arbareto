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

**Storage**: Repository writes happen only at explicit user actions: Delete and Delete permanently of reviewed working files (D6), and Save of `.gitignore` or `info/exclude` (D10). The ignore preview writes only a shadow folder below `<launch directory>/preview`, or below `/tmp` in a WSL distro (D9, D14). The launch directory is the per-user app local data folder (`service.rs:108-113`), never the install folder. The renderer keeps the submodule parent chain for the window session (D11). No new shell setting.

**Testing**: Bun tests in real disposable repositories (`tests/git`), compared with Git's own commands on copies. Contract tests and golden vectors (`tests/contracts`, `tests/vectors`). Windows packaged tests (`tests/windows`). WSL tests (`tests/wsl`, Ubuntu-26.04 with Git 2.55). Cargo tests for `file_delete.rs`, `file_replace.rs`, the shadow context, and the WSL Perl modes.

**Target Platform**: Windows 11 x64 with Git for Windows (2.56.0.windows.2 on the reference PC). WSL2 repositories run the distro's Git. The Git floor stays 2.55.0. It covers `cat-file --batch-command -Z` (Git 2.43) and `blame.markIgnoredLines` (Git 2.23).

**Project Type**: Local-first desktop application: Tauri 2 shell, compiled Bun Git service, React renderer.

**Performance Goals**: SC-001: the changed-file list within 300 ms after the selection, the first diff within 150 ms more, a move to the next file within 150 ms (1,000-file fixture, warm package, median of 10). SC-005: every ignore preview of 100,000 paths within 5 s on Windows, the first one too (D9, O-3). SC-006: the first blame progress within 500 ms on the 10,000-line, 5,000-commit fixture, and Cancel ends Git within 1 s. The 001 SC-005 input targets hold during every read and action (SC-009).

**Constraints**: Hooks, filters, textconv, and external diff programs never run in a read of this feature. Every Git process has a Job, a deadline, and Cancel. The renderer sends IDs, booleans, line numbers, path bytes of shown rows, and the editor text as base64 UTF-8 bytes only. Delete never follows a link or a junction. Save replaces the file in one atomic step. No Git configuration file changes. Each `-c` item of this plan sets a value for one process only (D2).

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
- **N-3 (VI, "Untested behavior MUST remain explicitly unverified")**: Research R16 lists every unverified point: the `FOF_WANTNUKEWARNING` dialog with `FOF_NOCONFIRMATION`, the Recycle Bin call for long paths and for names that end in a dot or a space, the Shell move beside the held target handle, the `ls-files --directory` collapse, the `core.longpaths` option for long shadow paths, and `FileDispositionInfoEx` on a volume without POSIX delete. The probes of 2026-10-21 settled the `./` stdin prefix on Windows (F13) and the `blame.ignoreRevsFile` reset (F7, O-9).
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
| P0.1 Fixtures | new `tests/git/history-diff-fixtures.ts` (WP4), new `tests/git/file-actions-fixtures.ts` (WP5). Both reuse `tests/git/fixtures.ts` and the 004 `tests/git/workbench-fixtures.ts`. | None (tests only). History: normal, merge with 2 and 3 parents, root, shallow, rename at 92%, mode change, binary, submodule, type change, a file `a` replaced by a folder `a/`, 1,000-file and 100,001-file commits, a partial clone with a missing blob. Blame: renames, moved lines, whitespace, an ignore list (relative, absolute, `~/`, `:(optional)`, missing, an empty value), a shallow clone, binary, submodule, a 10,000-line file with 5,000 commits, a `diff.interHunkContext` value. Files: untracked, changed tracked, folders with ignored files, nested empty folders `a/b/c`, a link to a folder outside, a junction, read-only, a name that ends in a dot or a space beside a tracked name, a nested repository, a submodule, a conflict. Ignore: the report cases C0 to C8 and W1, CRLF, BOM, empty, absent, a linked `.gitignore`, a `.gitignore` in an ignored folder, case-variant names `.GITIGNORE` and `.gıtignore`, a skip-worktree `.gitignore` absent on disk, an empty ignored folder, gitlinks. Branches: pruned upstream, removed remote, no upstream, `feature/b` and `Feature/a` as packed refs. | The builder self-check: commit trees, counts, the ignored set, the index digest. | Build time of the 100,001-file commit. Mitigation: the 001 fixture cache. |
| P0.2 Git facts | new `tests/git/history-diff-facts.test.ts` (WP4: F1 to F9, F17), new `tests/git/file-actions-facts.test.ts` (WP5: F10 to F16, F18, F19) | None. Records the Git behavior that the design depends on (research R16). | Each fact against Git's own result on a copy, on Windows Git 2.56 and WSL Git 2.55. Each fact records the observed version. | A fact fails. Record it in research.md and change the contract before P4 or P5. |
| P0.3 Native facts | new `tests/windows/delete-facts.test.ts` (WP3, packaged), cargo tests in `file_delete.rs` and `file_replace.rs` | None. | N1 to N11 and N3b of research R16: the per-item recycle result, the warning on a volume without a Recycle Bin, links and junctions in both modes, the cancel of the rest, the POSIX disposition, the held folder handle, the atomic replace, the folder reveal, names that end in a dot or a space, long paths, the Shell move beside the held handle. The cargo test of the folder removal of `a/b/c`. Each Recycle Bin test purges its own items through the reply `recycledPath`. | N2 and N3b need a volume without a Recycle Bin. Capability skip, recorded as unverified. |
| P1 Pure logic | new `src/contracts/tree-order.ts` (WP1), new `src/git-service/{blame-parser,line-map,ignore-text}.ts`, the raw record parser of `commit-changes.ts`, the rename header extension of `diff-parser.ts` (WP4, WP5) | Algorithms only. | Unit tests: the comparator against a reference sort with invalid UTF-8; both blame grammars; the hunk-header line map; the line-ending and BOM codec; the raw record grammar. | Grammar drift. P0.2 pins it. |
| P2 Contracts | `src/contracts/{operations,envelope,errors,limits,channel}.ts`, `wsl-process.json` (schemas only), `schemas/`, `tests/vectors/` | Adds the operations, codes, reasons, phases, bounds, and private requests of contract Δ1 to Δ15. | Schema tests and golden vectors in Bun and Rust. | typify drops ranges. Keep explicit Rust checks (001 §1). |
| P3 Shell | `src-tauri/src/{file_delete,file_replace,shadow}.rs` (new), `process_requests.rs`, `schema.rs`, `wsl.rs`, `reveal.rs`, `service.rs`, `bootstrap.rs`, `ipc.rs`, `close.rs`, `lib.rs`, `src-tauri/build.rs`, `src-tauri/capabilities/main.json`, `src/contracts/wsl-process.json` (Perl modes `delete`, `replace`, `scratch`) | `fileDelete`, `fileReplace`, the `ignorePreview` context with the shadow folder, the `absent` reveal reply, the `openSubmodule` native step, the recent entry of `openSubmodule`, the new close prompt names. `fileAppend` goes in the removal step T057, after WP7. | Cargo tests for each request, refusal, and walk case. N1 to N11 and N3b. | Local only. COM STA thread and owner window. |
| P4 Service History | new `commit-changes.ts`, `blame.ts`, `blame-parser.ts`, `line-map.ts`; `commands.ts`, `diff-parser.ts`, `history-view.ts`, `session.ts` | US1 and US7 service part. | SC-001, SC-002, SC-006, FR-058 attribution, the read gate, Cancel, missing objects. | Blame time on large files. The deadline and Cancel bound it. |
| P5 Service files | new `file-delete.ts`, `ignore-text.ts`, `ignore-preview.ts`, `submodule-open.ts`; `ignore.ts`, `workbench-review.ts`, `native-runner.ts`, `git-runner.ts`, `tests/git/bun-runner.ts`, `session.ts` | US2, US4, US5, US6 service part. | SC-003, SC-005, SC-007, stale reviews, Cancel, WSL rows. | Preview time at 100,000 paths. One Windows check alone takes 4.1 to 5.0 s, so SC-005 is at risk (D9). |
| P6 Frontend base | `src/frontend/changes/file-tree.ts`, `refs/ReferencesSidebar.tsx`, `index.css`, `branches/BranchButton.tsx`, new `branches/BranchCard.tsx`, `components/ui/hover-card.tsx`, `src/git-service/branches.ts` | US3, US8, US9. | SC-004, SC-008, the card keyboard rules. | Sort cost at 100,000 rows. One key per row, built once per read. |
| P7 Frontend History | `history/CommitDetails.tsx`, new `history/CommitChanges.tsx`, new `blame/*`, `state/history-view.ts`, `views/HistoryView.tsx` (the History view frame, not the row helpers in `history/HistoryView.tsx`), `app/Workbench.tsx`, `index.css` | US1 and US7 UI. | Component tests per FR, SC-001 timing in the package. | The dock swap of the blame view. |
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
- The editor text crosses as base64 of its UTF-8 bytes. A 1 MiB text then takes 1,398,104 bytes, and base64 needs no JSON escape. So the public request bound rises from 1 MiB to 2 MiB (contract Δ5).

### D2 Process model, environment, and outcomes

- Every argument array starts with `--no-lazy-fetch`. Reads add `--no-optional-locks` and `--literal-pathspecs` (001 `READ_OPTIONS`). The exceptions are `check-ignore` (Git exits 128 with `--literal-pathspecs`, 004 R21 F1) and the commands of the shadow context, which name no pathspec (D9).
- Read policies: every read of this feature runs under the 001 `read` policy. Delete and Save run their file steps through the shell and their reconcile reads under `read`. No 005 step runs a Git mutation.
- Read gate (spec FR-003, research R13). The gate is the 001 `trust.gate(w, listing, installation, "reads")` call before the first Git process, as `comparison.ts:346-351`:

| Read | Git commands | Loads the index | Gate |
|---|---|---|---|
| `readCommitChanges`, `readCommitFile` | `diff-tree` | Yes (builtin/diff-tree.c:132) | Yes |
| `readBlame` | `ls-tree`, `diff --numstat` of two trees, `cat-file`, `config get --all --type=path`, `blame <commit>` | No | No |
| `readBlame` before (`source.blameId`) | `ls-tree`, `diff -U0` of two blobs, then the blame above | No (builtin/diff.c `builtin_diff_blobs`) | No |
| `readIgnoreFile` | `rev-parse --git-path info/exclude`, `fileFacts` | No | No |
| `previewIgnore` | `ls-files` listings and `cat-file` in the repository, `fileFacts`, shadow commands | Yes (`ls-files`) | Yes |
| `openSubmodule` | `ls-files --stage` in the parent, then the 001 discovery | Yes (parent index) | Yes, the parent gate |
| `revealPath` with `folder` | none | No | No |
| `reviewWorkbench` `delete`, `ignore-save` | `fileFacts`, `rev-parse --git-path` | No | No |
| The reconcile `readWorkspace` after Delete and Save | the 001 status read | Yes | The 001 gate |
| The branch card | none (it reads held results) | No | No |

- Mutation exclusion: every `runWorkbench` of `delete` and `ignore-save` enters the 001 exclusion and records a marker of kind `workbench` with its action. A second mutation gives `BUSY`. Delete counts as a mutation for 001 FR-015 and FR-016 (spec FR-033). Save counts for 001 FR-015 only, so it also runs during an unfinished operation and with conflicts (spec FR-046, D10).
- `-c` items: `-c blame.markIgnoredLines=true -c blame.markUnblamableLines=true` (D12) and the D9 shadow items `core.autocrlf`, `core.eol`, `core.ignorecase`, `core.excludesFile`, and on Windows `core.longpaths`. Each applies to one process (git(1) `-c`). No configuration file changes.
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
  6. Parse (diff-format(5) "Raw output format" with `-z`): `:<old mode> SP <new mode> SP <old oid> SP <new oid> SP <status><score> NUL <path> NUL`, and a second `<path> NUL` for status R. For R, the first path is the old (source) path and the second is the new (destination) path (diff-format.adoc:50-52). Modes are six octal digits. OIDs match the object format, and the absent side holds the zero OID. Status A, D, M, R (with a three-digit score), and T are accepted. C, U, X, B, and any other byte refuse the whole list with `MALFORMED_GIT_OUTPUT` (spec FR-006).
  7. Kind per entry: mode 160000 on either side is `submodule`, 120000 is `link`, else `file`.
  8. Bounds: `STATUS_LISTING_RECORDS` (100,000) and `STATUS_LISTING_BYTES` (32 MiB) of raw output, then `COMMIT_CHANGES_RESULT_BYTES` (8 MiB, equal to `HISTORY_PAGE_BYTES`) of encoded result. The service keeps whole records only, in Git's output order, and marks the result `limited` with the shown count. The renderer then sorts the shown entries in tree order.
  9. A non-zero exit runs the 001 §7 `hasPromisor` path, as `comparison.ts:474-483`. A promisor repository gives `OBJECT_MISSING` with the 001 remedy. The read never fetches.
  10. The service retains the listing of the latest call per view as `changesId` (raw bytes and record offsets). A new `readCommitChanges` or a released view drops it. An older `changesId` gives `UNKNOWN_TARGET`.
- `readCommitFile {changesId, fileId}` service steps:
  1. The read gate again, because the trust state can change between reads.
  2. Kind `submodule`: no Git read. The result holds the two commit IDs from the listing.
  3. Otherwise two reads with the same pathspec: `diff-tree` with the 001 `PATCH_OPTIONS`, `-M -l1000`, `<base> <oid> -- <path>` (and `<old path>` for R), and `diff-tree` with the 001 `NUMSTAT_OPTIONS` and the same arguments. The rename pairs inside that pathspec (design R1, probed; F3).
  4. Parse with `parsePatch` and `parseNumstat` (`diff-parser.ts:114`, `:220`). `parsePatch` gains the header lines `similarity index <n>%`, `rename from <path>`, and `rename to <path>` (diff.c `fill_metainfo`), with a pure rename that has no hunk. A type change gives two patch sections (F3). The service then sends no patch and the fact line only.
  5. Section filter: a pathspec also matches every path below `<path>/` (gitglossary(7) "pathspec"). So a commit that replaces the file `a` with the folder `a/` gives sections for `a` and `a/x`. The service drops each patch and numstat section whose paths lie below `<path>/` or `<old path>/`. The kept sections must equal the listing entry exactly: its status and its paths, and two sections of one path for a type change. A section with another path, a missing section, or an extra section gives `MALFORMED_GIT_OUTPUT`. The P0.1 fixture holds this case (Q4).
  6. Binary: `parseNumstat` gives `binary` from `-` and `-` (git-diff(1) `--numstat`).
  7. Bounds: `CANONICAL_DIFF_BYTES` (4 MiB) and `CANONICAL_DIFF_LINES` (20,000), with the 001 limit texts.
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
- Refusals before any token, each as `WORKBENCH_UNAVAILABLE`: `conflicted` (a `conflicted` entry); `submodule` (a porcelain v2 record whose `<sub>` field starts with `S`); `nested-repository` (an untracked record that ends with `/`, which git-status(1) prints only for a nested repository with `--untracked-files=all`); `limit` (more than `MULTI_FILE_ACTION_FILES` entries); `no-recycle-bin` (mode `recycle` in a WSL workspace); `long-path` (mode `recycle`, and the full Windows path of an entry holds 260 or more UTF-16 units, which is `MAX_PATH`; N10 records the Shell result for such a path, and Delete permanently stays available); `nothing-to-delete` (every entry has an unstaged deletion, Y = `D`, so no working file exists); `path` (an entry path with a name that `isComponent` of `src/contracts/native-path.ts` refuses, such as a name that ends in a period or a space; the shell path rule refuses such a path, D7 N9); `unreadable` (a `fileFacts` reply of kind `error`).
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
| `error {code}`, such as `access-denied` (read-only, FR-025) or `sharing-violation` (another program holds the file without delete sharing) | absent | error with its code |
| `stopped` (the entry or the whole request), `interrupted` (the whole WSL request), no reply | absent | stopped |

- Response state: every file `recycled` or `deleted` gives `succeeded`. No file removed gives `failed` with the first reason code (`STALE_REVIEW`, `GIT_FAILED`, or the error code). Otherwise `failed-with-effects`. Cancel gives `canceled` with the per-file outcomes, never an undo.
- Tracked files lose only the working file. No step touches the index (spec FR-032). The test compares the `.git/index` SHA-256 before and after.

### D7 Delete: shell steps

- Windows (`file_delete.rs`):
  - Request rules: each path lies below the worktree root by `file_facts::below`, as `fileAppend` (`process_requests.rs:1147`). The operation holds a `started` marker of kind `workbench` with action `delete-files`. Another operation gets `INVALID_REQUEST`. A `digest` binds a file of at most 1 MiB (Δ5), so a larger `size` with a `digest` gets `INVALID_REQUEST`. Each folder is the shallowest folder of the request or lies below it. Another folder set gets `INVALID_REQUEST`.
  - Walk: `NtCreateFile` opens each folder relative to its parent handle with `OBJ_DONT_REPARSE`, as `file_append.rs:168`. Each folder handle stays open with share READ|WRITE and without `FILE_SHARE_DELETE` until the request ends. So no other process can rename a folder on the way (N6). The held handle takes `FILE_LIST_DIRECTORY|FILE_READ_ATTRIBUTES|SYNCHRONIZE`. NT records the share mode only for an open with read, write, or delete access (`IoSetShareAccess`). A handle with attribute access only blocks no rename (N6, 2026-10-22).
  - Target open: relative, access `DELETE|FILE_READ_DATA|FILE_READ_ATTRIBUTES|SYNCHRONIZE`, share READ|WRITE|DELETE, options `FILE_OPEN_REPARSE_POINT|FILE_SYNCHRONOUS_IO_NONALERT`. The open has no `FILE_NON_DIRECTORY_FILE`, because a link to a folder is a directory reparse point (clarify contradiction 7). A directory without a reparse tag gives `not-regular`. Another program that holds the file without `FILE_SHARE_DELETE` makes the open fail with `STATUS_SHARING_VIOLATION`, which gives `error sharing-violation` (the `file_facts.rs:581` code name).
  - Compare: `FILE_STANDARD_INFORMATION.EndOfFile`, `FILE_BASIC_INFORMATION.LastWriteTime`, the SHA-256 for a bound file, and the reparse tag and target for a link (`file_facts.rs` `reparse_point`). A difference gives `stale`.
  - Permanent: `SetFileInformationByHandle(FileDispositionInfoEx)` with `FILE_DISPOSITION_FLAG_DELETE|FILE_DISPOSITION_FLAG_POSIX_SEMANTICS` on the checked handle. No `FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE`, so a read-only file gives `error access-denied` (spec FR-025). A link handle deletes the link itself.
  - Recycle: mode `recycle` never gets a path of 260 or more UTF-16 units, because the review refuses it with `long-path` (D6, N10). One `IFileOperation` per request on a COM STA thread with `SetOwnerWindow(main window)`. Flags `FOF_NOCONFIRMATION|FOF_SILENT|FOF_NOERRORUI|FOF_WANTNUKEWARNING|FOF_ALLOWUNDO|FOFX_RECYCLEONDELETE`. No `FOFX_EARLYFAILURE`, so one failed item does not cancel the others. Each checked entry goes in through `SHCreateItemFromParsingName` and `DeleteItem`. Unchecked entries are not added. A failed step before `PerformOperations` moves nothing, so each item gives `kept` with that HRESULT. The HRESULT of `PerformOperations` decides nothing: a cancel or a failed item can make it fail after other items moved. The shell calls `Unadvise` and takes the sink results. A failure of the COM thread gives `error other-error` for each item, and the fresh read decides (D6).
  - `PreDeleteItem` checks the item that the Shell is about to delete. It reads `psiItem` with `IShellItem::GetDisplayName(SIGDN_FILESYSPATH)`. It opens that path as the Shell does: a Win32 path without the `\\?\` prefix, so Win32 path normalization applies, with access `FILE_READ_ATTRIBUTES`, `FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS`, and share READ|WRITE|DELETE. It compares the `FILE_ID_INFORMATION` of that handle with the checked handle. A failed `GetDisplayName`, a failed open, or another file ID returns `HRESULT_FROM_WIN32(ERROR_CANCELLED)`. That cancels this and every later item (Microsoft Learn `IFileOperationProgressSink::PreDeleteItem`). The Shell reports the cancelled item to `PostDeleteItem` with `HRESULT_FROM_WIN32(ERROR_CANCELLED)`, so it replies `kept` with that HRESULT. Each later item replies `stopped` (N4, 2026-10-22).
  - Reason: the Shell parse uses Win32 path rules, and the Shell does not support names that end in a space or a period (Microsoft Learn "Naming Files, Paths, and Namespaces"). Win32 normalization removes such an end (Microsoft Learn ".NET file path formats", "Skip normalization"). So an untracked `a.` can resolve to a tracked `a`, and the compare cancels it (N9). A folder name that ends in `.{CLSID}` can move the parse into a Shell namespace folder. Then `SIGDN_FILESYSPATH` fails or names another file, and the compare cancels too. Gap: the request path rule `file_facts::below` (`is_component`) refuses a name that ends in a period or a space, so such a name gets `INVALID_REQUEST` in both modes and cannot be deleted. The review refuses it first with `path` (D6, spec FR-021).
  - `PostDeleteItem` decides: `hrDelete` S_OK with a non-null `psiNewlyCreated` gives `recycled` with `recycledPath` (its parsing name). A failed parsing name gives `error other-error`. S_OK with null gives `deleted` (Microsoft Learn: "If the item was fully deleted, this value is NULL"). Another `hrDelete` gives `kept` with the HRESULT. The fresh read then decides kept or absent (D6).
  - Shell move beside the held handle: the checked target handle stays open during the move with share READ|WRITE|DELETE. N11 records whether the Shell move opens the source with a share mode that conflicts with it. A conflict gives `kept` with the HRESULT, and the fact changes this step before P5.
  - Folders: the walk holds each folder above a deeper candidate without `FILE_SHARE_DELETE`, so a second `DELETE` open of that folder fails with a sharing violation. So the check holds only the folders above the shallowest candidate. The folder phase opens each candidate once with `DELETE` added to its access, still without `FILE_SHARE_DELETE`, parents before children, and deletes through that handle. A folder between two candidates, such as a folder that keeps a file, opens without `DELETE`. Deepest first, the shell sets `FileDispositionInfoEx` with `FILE_DISPOSITION_FLAG_DELETE|FILE_DISPOSITION_FLAG_POSIX_SEMANTICS` on the held handle and then closes it. POSIX semantics remove the name when that handle closes (Microsoft Learn `FILE_DISPOSITION_INFORMATION_EX`), so the parent is empty for its own step. `ERROR_DIR_NOT_EMPTY` gives `kept`. A reparse point at a candidate fails the `OBJ_DONT_REPARSE` open, which gives `not-regular`. The cargo test deletes `a` with only the empty folders `a/b/c` below it, and all three reply `removed`. A second cargo test removes `a/b/c` below a folder `a/b` that keeps a file.
  - Exactly one reply per request, also after `cancel`, `closeJob`, or a service exit. The checks run in the walk, and the delete phase runs in the walk finish. A stop or a deadline before the delete phase replies `{result: "stopped"}`, and nothing changes. The delete phase does not stop. After a `PreDeleteItem` cancel, each item that the Shell did not reach replies `stopped`.
- WSL: the new `wslFiles` mode `delete` (the name `remove` is taken by the owned lock and candidate removal). Per entry, the Perl text holds each folder on the way as its working folder. It runs `chdir` to the worktree root. Then, for each folder name: `lstat` of the name must give a directory, `chdir` into it, and `stat(".")` must give the device and inode of that `lstat`. So no link on the way can move the working folder. At the target, `lstat` of the last name must give the bound type. A bound file opens with `O_RDONLY|O_NOFOLLOW`, and `fstat` must give the `lstat` device and inode. The size, `st_mtime` in the `lastWrite` form, and the SHA-256 must match. Then `unlink` of the last name, relative to the working folder. Folders: the same walk to the parent, then `rmdir` of the last name. `ENOTEMPTY` or `EEXIST` gives `kept`. The process changes files inside the walk. So a stop, a deadline, an output that ends early, or an exit status other than 0 replies `{result: "interrupted"}`, and the fresh read decides. Perl core has `lstat`, `chdir`, `stat`, `sysopen` with `Fcntl` `O_NOFOLLOW`, `unlink`, and `rmdir`. Only a swap of the last name between its check and the act stays open (spec FR-031 known limit).

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

- Trigger (spec FR-041): the renderer sends `previewIgnore {target, text, snapshotId}` 400 ms after the last edit. `text` is the base64 of the UTF-8 bytes (D1). A new edit cancels the running preview (001 §5 "Pending reads"). "Updating preview…" shows while a preview runs. Save stays available.
- Text check: `TextEncoder` replaces a lone surrogate with U+FFFD, so the renderer first checks `String.prototype.isWellFormed()`. A text that fails gets no preview and no Save (D15). The service decodes the bytes and refuses invalid UTF-8, a NUL, or more than 1 MiB with `INVALID_REQUEST`.
- Base (in memory, no file): the service keeps one preview base per workspace and target, keyed by `snapshotId`. Another `snapshotId` builds a new base. The base holds the listings, the self-check listings, the S verdicts, the expansion cache, and the self-check result.
- Real repository reads (the read gate first):
  - T: `ls-files -z --stage -v` (`indexEntryArgs`). The first record per path counts, so unmerged stages count once. Mode 160000 marks a gitlink. Tag `S` marks a skip-worktree entry.
  - U: `ls-files -o -z --directory --no-empty-directory`. A record that ends with `/` is a folder that holds no tracked entry, or a nested repository (git-ls-files(1) `--directory`; F10).
  - Expansion of a folder record d: `ls-files -o -z -- <d>/`, in batches that fit the 001 §6 command line. It lists every untracked file below d. For a nested repository it lists the one record `<d>/` itself, which marks that repository, and it stays one path (dir.c:2045; probed on Git 2.56.0.windows.2, 2026-10-21; F10).
  - Self-check listings, index-aware: RI = `ls-files -o -i --exclude-standard --directory -z` and RT = `ls-files -c -i --exclude-standard -z`. Both read the index, so Git reads a skip-worktree `.gitignore` that is absent on disk from its index blob (dir.c:1174-1178). `-i` turns the untracked cache off (dir.c:3011-3014). RI stops at an excluded folder and lists it as one record `<d>/` (dir.c:2094-2096). A folder that is not excluded but holds only ignored paths gives `<d>/` beside its own records (dir.c:2163-2188, :2661-2663). An empty excluded folder gives `<d>/` too. An ignored nested repository gives `<x>/` only when the repository itself is excluded and its parent is not (dir.c:2041-2046). Inside an excluded folder, the folder record covers the repository (dir.c:2088-2096; F10). F19 records these forms. The probes of 2026-10-21 showed each of them on Git 2.56.0.windows.2 and WSL Git 2.55.0. RI never takes a pathspec, because a pathspec below an excluded folder can exit 128 (builtin/ls-files.c:154-155; F10).
  - Each listing: at most `STATUS_LISTING_RECORDS` records and `STATUS_LISTING_BYTES` bytes. Above either, the preview gives reason `listing`.
- Shadow (report Q2, F11, F14), built by the shell context `ignorePreview` for one preview operation (D14). The shadow folder holds two repositories: `s` with the saved text (S) and `c` with the candidate text (C). Both take the steps below and differ only in the one edited file, so the S and C checks can run at the same time. On Windows, each array that reads or writes a file in the working tree carries `-c core.longpaths=true` (steps 2, 4, 5, and 6). It applies to one process only (D2), and the shadow path is longer than the real path.
  1. `init -q --template=` in each shadow repository. The empty template creates no `info/exclude`.
  2. `hash-object -w --no-filters --stdin-paths` with the C-quoted absolute paths of each regular `.gitignore` that the listings name and `fileFacts` shows as a `file` (004 F31 quoting). A link `.gitignore` stays out, because Git opens in-tree ignore files with `PATTERN_NOFOLLOW` (dir.c:1779). The candidate text goes through `hash-object -w --no-filters --stdin`, with the BOM and line endings of the loaded file. A skip-worktree `.gitignore` that is absent on disk goes in as its index blob (`cat-file --batch` in the repository, then `hash-object -w --stdin`), because Git reads that blob (dir.c `read_skip_worktree_file_from_index`).
  3. `update-index -z --index-info` with each ignore file, a 160000 entry for each tracked gitlink, each nested repository, and each folder input, so the shadow holds an empty folder there (report E1).
  4. `-c core.autocrlf=false -c core.eol=lf checkout-index -a -f`. `info/exclude` goes through a second index (`GIT_INDEX_FILE`) with one entry `exclude` and `checkout-index -a -f --prefix=.git/info/`. The saved copy is the real file through `hash-object --stdin-paths`, because Git follows a link at `info/exclude`.
  5. `hash-object --no-filters --stdin-paths` of each written file must equal its OID. Another value gives reason `shadow-copy`.
  6. `-c core.ignorecase=<value> [-c core.excludesFile=<absolute path>] check-ignore --no-index -z --stdin -v -n`, in `s` for S and in `c` for C. `<value>` is the effective `core.ignorecase` of the repository listing, or `false` when the listing has none (git-config(1) default). A relative `core.excludesFile` joins the worktree root (report "Relative core.excludesFile"). Without an effective value, the default XDG file applies in the real and the shadow repositories.
- Classification (exact by dir.c `prep_exclude`, lines 1731-1745: an excluded folder ends the walk, and every path below it matches that folder pattern):
  - Inputs: every T path, every U file record, and every U folder record as a folder input. A stdin path that starts with `:` gets a `./` prefix (report Q2; F13). Git reads a `./` path literally on Windows and in WSL (F13). The service sends only `/` separators, because Git for Windows also reads `\` as a separator (compat/win32/path-utils.h:9; F13). The output gives one record per input in input order. A record whose pattern field is not empty and does not start with `!` is ignored.
  - S verdicts come from the base. Base build: each check round runs the S check in `s` and the C check in `c` at the same time. The self-check listings RI and RT run at the same time as the first round. The result shows only after the self-check passes (O-3).
  - Self-check (spec FR-039), exact by the RI and RT record forms above. Git's verdict for each input is:
    - a T path p: matched when RT holds p;
    - a folder input d: ignored when RI holds `<d>/` and no record below `<d>/`;
    - a nested repository x: ignored when RI holds `<x>/`, or holds a folder record above x with no record below that folder;
    - a file input f: ignored when RI holds f, or holds a folder record above f with no record below that folder.
  - Any input whose S verdict differs from Git's verdict gives reason `self-check`. A record of RI that is no input must end with `/` and hold no U record and no expansion record at or below it. That is an empty folder, which U leaves out (`--no-empty-directory`), and it changes no verdict. Any other extra record of RI or RT gives reason `self-check`.
  - A U folder record that S does not ignore expands in the base. Its files join the inputs, and its `.gitignore` files join both shadows. Its subfolders join as folder inputs.
  - A U folder record that S ignores stays one input while C also ignores it. When C does not ignore it, it expands for this preview (from the expansion cache). Its files take the S verdict ignored without a check, by the excluded-folder rule. Its `.gitignore` files join only the C shadow.
  - Below a folder input that both texts ignore, no path is checked. That folder counts as one path (spec FR-039).
- Results (spec FR-038): "Newly ignored" are untracked paths that C ignores and S does not. "No longer ignored" are untracked paths that S ignores and C does not. Each group holds the full count and the first 1,000 paths by `comparePaths` (D4). "Tracked files stay tracked." shows with the count of T paths that C matches and S does not, only when that count is not zero.
- Notices (spec FR-040), at most 100 plus a count: a `.gitignore` that `fileFacts` shows as a link, "<path> is a symbolic link. Git does not read it."; a `.gitignore` below a folder that C ignores, "<path> is inside an ignored folder. Git does not read it.".
- Bounds and typed limits (spec FR-039), each as "Preview not available: <reason>.":
  - `paths`: more than 100,000 inputs in one C check (`PREVIEW_PATHS`).
  - `listing`: a listing above its bound, or more than 10,000 ignore files, or an ignore file above 1 MiB.
  - `name-case`: Git opens `<folder>/.gitignore` by that exact name in each folder that its walk reads, without following a link (dir.c `prep_exclude`, wrapper.c:828 `open_nofollow`). A case-insensitive folder can resolve that name to another listed name, such as `.GITIGNORE`. On Windows NTFS, Git then reads `.GITIGNORE` and reports its rules as `.gitignore` (F19 probe of 2026-10-21). NTFS does not map `ı` (U+0131) to `i`, so `.gıtignore` gives no rules. The shadow copies only the exact name. So for each folder of an input path that lists no exact `.gitignore`, the service sends one `fileFacts` entry (`digest: false`) for `<folder>/.gitignore`. The root is left out for the target `gitignore`, because the editor loads what that open finds. The Windows `fileFacts` walk opens names with `OBJ_CASE_INSENSITIVE` (`file_facts.rs:502`), as the Win32 open of Git does, and the WSL route opens the exact name in the distro. A `file` fact gives `name-case`. An `error` fact gives `unreadable`. The volume case rule decides, not a name compare, so the rule is exact on every route. P9 measures its cost, one entry per such folder in frames of 64.
  - `shadow-copy`, `self-check`, `unreadable` (a `fileFacts` error for an ignore file), `deadline` (a step reached the 30 s read deadline), and `failed` with the code.
- Time (SC-005): the report measured 4.1 to 5.0 s for one `check-ignore` of 100,000 paths on Windows, and 0.28 to 0.34 s in WSL, and 0.68 to 0.73 s for `ls-files -o -z` at 100,000 files on Windows. The base build runs the S check, the C check, and the self-check listings at the same time. A preview with a built base runs one C check. SC-005 counts every preview, the first one too, as the spec states (O-3). Risk: one Windows check alone already takes 4.1 to 5.0 s, so SC-005 is at risk. P9 measures the first and the later previews.
- Temporary files: the shell removes the shadow folder when the preview operation ends, also after Cancel. Each new shadow first removes leftover shadow folders whose owner process record no longer exists (D14).

### D10 Ignore save

- Review `reviewWorkbench {action: "ignore-save", target, text, expected}`, with `text` as base64 UTF-8 bytes (D9 "Text check"): `targetOf` and `factOf` read the file again. A state other than `expected` gives `STALE_REVIEW` reason `ignore-changed`. The codec of D8 applies to the current bytes, so `bom` and `lineEnding` come from the file, not from the renderer. The bytes are the BOM when `bom`, then the text with each LF replaced by CRLF for `crlf`. `lf` and `none` keep LF (spec FR-042). A NUL in the text gives `ignore-nul`. Bytes above 1 MiB give `ignore-size`. The plan holds `{target, file, size, sha256}` of the new bytes. No trust class applies, because no repository program runs. Save counts as a mutation for 001 FR-015 only (spec FR-046, user decision 2026-10-21). It keeps the 004 exception of the action `ignore` (004 contract Δ3): `OPERATION_IN_PROGRESS`, `unknown-operation`, and `CONFLICTED` do not refuse it, because Save changes no Git state. A running mutation still gives `BUSY`. The stale check above stays.
- Run: the marker of kind `workbench` with action `ignore-save-gitignore` or `ignore-save-exclude`. Then one `fileReplace {repositoryId, target, path, expected, bytes}`. Then a fresh `fileFacts` digest of the target and `readWorkspace`. A digest equal to the plan gives `succeeded`.
- Windows `fileReplace` (`file_replace.rs`):
  - The `fileAppend` walk with `OBJ_DONT_REPARSE` to the parent folder, and the `fileAppend` path rules (004 Δ6).
  - An existing target opens with `FILE_READ_DATA|FILE_READ_ATTRIBUTES|SYNCHRONIZE`, share READ|DELETE, `FILE_OPEN_REPARSE_POINT|FILE_NON_DIRECTORY_FILE`. `FILE_READ_ATTRIBUTES` serves the reparse tag and link count queries. So no other writer can open it for writing. A reparse tag, a folder, or `NumberOfLinks` other than 1 gives `refused not-regular`. A size or SHA-256 other than `expected` gives `stale`.
  - The walk and the target check run in the walk, and the target handle stays open. The temporary file, the write, and the rename run in the walk finish. So a stop or a deadline before the finish replies `stopped`, and nothing is written.
  - A temporary file `.arbareto-<32 hex>.tmp` opens relative to the parent with `FILE_CREATE`, `DELETE|FILE_WRITE_DATA`. One `WriteFile` and `FlushFileBuffers` follow.
  - `NtSetInformationFile(FileRenameInformationEx)` on the temporary handle with `RootDirectory` set to the parent handle. The Win32 `SetFileInformationByHandle(FileRenameInfoEx)` refuses a relative name with a `RootDirectory` with `ERROR_INVALID_PARAMETER` (N7, 2026-10-22). An existing target takes `FILE_RENAME_REPLACE_IF_EXISTS|FILE_RENAME_POSIX_SEMANTICS`. An absent target takes `FILE_RENAME_POSIX_SEMANTICS` only, so a file that appeared since the check gives `STATUS_OBJECT_NAME_COLLISION` and `stale` (N7).
  - A failure after the create deletes the temporary file by disposition on its handle. A crash between the create and the rename leaves the temporary file (contract gap).
- WSL: the new `wslFiles` mode `replace`. The walk of the WSL mode `delete` (D7) holds the parent folder as the working folder: `lstat`, `chdir`, and the `stat(".")` device and inode compare for each folder. Every later step names only the last name, relative to that folder. An open of the target with `O_RDONLY|O_NOFOLLOW`, `fstat` must show a regular file with `st_nlink` 1, the size and SHA-256 compare. A temporary file in the same folder with `O_CREAT|O_EXCL|O_NOFOLLOW|O_WRONLY`, `fchmod` to the target mode bits, the write, `fsync`, then `rename(2)` over the target, and `fsync` of the folder (an open of `.`). An absent target uses `link(2)` and `unlink(2)` in place of `rename(2)`, so an existing name gives `EEXIST` and `stale`. A new file gets mode 0666 less the umask. A stop, a deadline, or a broken output replies `interrupted`.
- `fileAppend` and the 004 `ignore` review go (spec FR-034) in the WP3 removal step T057, after the editor replaces them (T040, T054). The 004 D9 line rules stay in `ignore-line.ts`.

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
  4. Ignore list (spec FR-059, FR-060): `config get --all --type=path -z blame.ignoreRevsFile`, with the worktree root as cwd, where blame runs too. Exit 1 means no value (git-config(1) `get`). `--type=path` and blame both call `git_config_pathname` (builtin/config.c:350, builtin/blame.c:768), so Git itself expands `~/` and `%(prefix)/` and drops a missing `:(optional)` value (config.c:1320-1336, builtin/config.c:527-533). The service classifies no prefix. The parser accepts empty `-z` records. The effective list is all non-empty values from all scopes, as Git uses them (builtin/blame.c:771 `string_list_insert`, :941-947; F7; O-9). An empty configuration value resets nothing, although config/blame.adoc:24-28 says otherwise. Only the command-line value `--ignore-revs-file=` clears the list. A relative value joins the worktree root. Each non-empty value whose path the shell `below` rule accepts gets `fileFacts`, because `build_ignorelist` reads every non-empty value (builtin/blame.c:941-947). `absent` gives reason `ignore-revs-file-missing`. Git gets every other value unchanged. Git reads the configured files in both toggle states, so the check applies in both.
  5. Without an effective list, or with the toggle off: `blame --incremental --no-textconv --encoding=none [-w] [-M] [-C] [--ignore-revs-file=] <oid> -- <path>`. The empty `--ignore-revs-file=` comes only with the toggle off, and it clears the list after Git read the files (git-blame(1) `--ignore-revs-file`).
  6. With the toggle on and an effective list: `-c blame.markIgnoredLines=true -c blame.markUnblamableLines=true blame --porcelain --no-textconv --encoding=none [-w] [-M] [-C] <oid> -- <path>`.
- Parse (`blame-parser.ts`, git-blame(1) "THE PORCELAIN FORMAT" and "INCREMENTAL OUTPUT"): a group header `<oid> SP <orig line> SP <final line> SP <count> LF`. Commit headers on the first appearance: `author`, `author-mail`, `author-time`, `author-tz`, `committer`, `committer-mail`, `committer-time`, `committer-tz`, `summary`, optional `boundary`, optional `previous <oid> SP <path>`, and `filename <path>`. Incremental ends each group with `filename`. Porcelain repeats a header per line without the count, prints `ignored` and `unblamable` per line, and prints a TAB content line, which the parser skips after the count check. Paths in `previous` and `filename` are C-quoted when Git quotes them. An unknown header line refuses with `MALFORMED_GIT_OUTPUT`.
- Checks (spec FR-058): the groups cover lines 1 to N exactly once, where N is the step 3 line count. Otherwise `MALFORMED_GIT_OUTPUT`.
- Shallow (spec FR-062): a commit that the view shallow set or the `shallow` file (`topologyPathArgs`, `commands.ts:191`) lists is `shallow`. The `boundary` header does not decide it, because `blame.showRoot` changes it (builtin/blame.c:742).
- Progress (spec FR-063): incremental mode sends `blame` events with `blamed` (the sum of parsed group counts) and `total` (N), at most 4 per second. Porcelain mode sends events without counters.
- Bounds: Git output 32 MiB (`BLAME_OUTPUT_BYTES`), encoded result 12 MiB (`BLAME_RESULT_BYTES`), deadline `HISTORY_PROCESS_DEADLINE_MS` (120 s), Cancel by the Job (SC-006). Above a bound: `OUTPUT_LIMIT`.
- Result: data-model §10. The service retains the latest result per workspace as `blameId`.
- "Blame before this commit" (spec FR-056): the line's group gives commit X with `previous {oid P, path Q}` and the original line o = `origStart + (line - finalStart)`. No `previous` gives reason `no-previous`. `ls-tree` gives the blob of `Q` at P and of `filename` at X. `diff -U0 --inter-hunk-context=0 --no-textconv --no-ext-diff --no-color <blob of Q> <blob of X>` gives the hunk headers. `--inter-hunk-context=0` keeps a user `diff.interHunkContext` from merging hunks (git-diff(1) `--inter-hunk-context`). The headers are `@@ -a[,b] +c[,d] @@` (a count is 1 when Git omits it). `line-map.ts` maps o: inside a hunk with d > 0 and c ≤ o < c + d, the line maps to a, or to a + 1 when b = 0. Otherwise o moves by the sum of (b − d) of the hunks with c + d − 1 < o. The result clamps to 1 and the line count of Q. The new blame runs for `(P, Q)` with the same options and focuses the mapped line.
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

- Commands: the service builds the arrays of D1, with `config get --all --type=path -z blame.ignoreRevsFile` (D12) and the self-check listings of D9 (001 §6). The shell keeps no per-command list for registered runs. Only the `ignorePreview` context admits a fixed array set (below).
- `fileDelete` (`file_delete.rs`) and `fileReplace` (`file_replace.rs`): D7 and D10. Both reuse the `file_append.rs` walk (`open_root`, `open_relative` with `OBJ_DONT_REPARSE`). WP3 moves the shared walk into `file_delete.rs`. `file_append.rs` goes with `fileAppend` in the removal step T057, after WP7.
- COM: the Recycle Bin request runs on its own STA thread (`CoInitializeEx(COINIT_APARTMENTTHREADED)`) with a message loop while `PerformOperations` runs, and `SetOwnerWindow` with the main window. WP3 records the `windows` crate features that it adds.
- Shadow context (`shadow.rs`), kind `IgnorePreview` in `bootstrap.rs` `ContextKind`:
  - The private request `shadow {op: "create"}` creates `<launch directory>/preview/<shell PID>-<shell creation time>-<16 hex>/` (Windows) or, for a WSL workspace, `/tmp/arbareto-preview-<shell PID>-<shell creation time>-<16 hex>/` through the new `wslFiles` mode `scratch`. The launch directory is the one exact folder of `service.rs:108-113`: the Tauri app local data folder, or the launch folder below `ARBARETO_PROFILE_ROOT`. It is per-user and writable, never the install folder. The shadow folder holds the two shadow repositories `s` and `c` (D9). It replies `{shadowId}`.
  - The context belongs to the requesting operation. The shell removes the folder when that operation ends, after Cancel, `closeJob`, or a service exit. The removal runs on its own thread after the state lock is released. Windows uses `std::fs::remove_dir_all`, which opens each entry relative to its folder and never follows a link (Rust 1.58.1, CVE-2022-21658). WSL uses `scratch` with `remove`: it opens `/tmp` and the shadow folder with `O_DIRECTORY|O_NOFOLLOW`, enters each folder with `chdir` and the `stat(".")` device and inode compare, and removes only relative names. It acts only on a name that starts with `arbareto-preview-`.
  - At each create, the shell removes every shadow folder whose owner PID and creation time match no live process record (OS process facts), and every own folder that no live context holds. It lists them under the state lock and removes them on its own thread after the reply. The create does not wait: a leftover is never the new folder or a live one. Only `ERROR_INVALID_PARAMETER` from `OpenProcess` means that no process has the PID. Another failure of `OpenProcess` or `GetProcessTimes` keeps the folder. A process with the PID and another creation time is another process, so the folder goes. The WSL `sweep` lists only the `arbareto-preview-*` entries whose `lstat` owner is the distro user (`$<`).
  - Accepted arrays in the context, cwd `<shadow>/s` or `<shadow>/c`, each with `--no-lazy-fetch`: `init -q --template=`; `hash-object -w --no-filters --stdin-paths`; `hash-object -w --no-filters --stdin`; `hash-object --no-filters --stdin-paths`; `update-index -z --index-info`; `-c core.autocrlf=false -c core.eol=lf checkout-index -a -f`, also with `--prefix=.git/info/`; `-c core.ignorecase=<true|false> [-c core.excludesFile=<path>] check-ignore --no-index -z --stdin -v -n`. On Windows, the `hash-object --stdin-paths`, `checkout-index`, and `check-ignore` arrays also start with `-c core.longpaths=true` after `--no-lazy-fetch`. The shell sets `GIT_INDEX_FILE` only to `<cwd>/.git/index` or `<cwd>/.git/exclude.index`. It sets `GIT_DIR` to `<cwd>/.git`, so Git never finds a repository above the shadow folder, such as a `.git` folder in `%USERPROFILE%`. Any other array gives `INVALID_REQUEST`. The `run` fields `shadowId`, `shadowRepository`, and `shadowIndex` name the folder, the cwd, and the index (contract Δ6).
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
- Delete unavailable reasons (Muted, on the item line or wrapped below it): `conflicted` "Arbareto does not delete a file with a conflict."; `submodule` "Arbareto does not delete a submodule."; `nested-repository` "This folder holds another Git repository."; `limit` "Delete covers at most 10,000 files."; `long-path` (from the review, so it shows in place of the confirmation) "Arbareto does not move a path of 260 or more characters to the Recycle Bin. Use Delete permanently…"; `nothing-to-delete` and a single unstaged deletion "This file is already deleted from the working tree."; `path` "Windows does not allow this file name."; `OPERATION_IN_PROGRESS` "A Git operation is in progress. Finish it first." and `CONFLICTED` "Resolve the <n> conflicted files first." (the 004 D15 texts); a running mutation: the 003 running reason in the tooltip only (004 D15).
- Delete keys (spec FR-023): Del and Shift+Del act only while the Changes list has focus. They act on the selection, or on the focused row without a selection.
- Delete confirmation (DeleteConfirm board): the 001 modal dialog with the alert icon and the 14/20 px title. The body lists the first 20 paths in tree order in the code font, inside a Canvas box with a 1 px divider edge, radius 4, padding 6 px 8 px, 18 px lines. Then "and <m> more files." ("and 1 more file."). Notices: the tracked line and the WSL line on Warning fill, "You cannot undo this." on Removed fill, each with its icon. The folder line sits above the list. The footer: a top divider, padding 8 px 12 px, Cancel with the first focus, then the danger button. Titles and buttons: spec FR-026 to FR-029.
- Delete run texts: status bar names "Delete files", "Deleting files", "Delete files details". Progress "Deleting files (<i> of <n>)…". Outcomes: "Moved <n> files to the Recycle Bin." ("1 file"), "Deleted <n> files permanently.", else "Delete finished: <parts>." with the non-zero parts "<n> moved to the Recycle Bin", "<n> deleted", "<n> kept", "<n> changed", "<n> not on disk", "<n> not regular", "<n> failed", "<n> stopped". `STALE_REVIEW` `files-changed`: "The files changed after the review. Arbareto deleted nothing. Select Refresh (F5), then delete again." `APPROVAL_EXPIRED`: "The review expired. Select Delete again.". Cancel: "Delete stopped: <parts>.". The details list each path with its outcome: "Moved to the Recycle Bin", "Deleted", "Kept", "Changed, not deleted", "Not on disk", "Not a regular file, not deleted", "Not deleted: <code>", "Stopped, not deleted".
- Folder reveal text (D5): "<path> does not exist. Select Refresh (F5).".
- Ignore editor (IgnoreEditor board): docked in the Commit view diff region, non-modal. The 32 px heading holds the file-edit icon, "Edit .gitignore" or "Edit info/exclude" (14/600), and the path in Muted code font, cut with an ellipsis and a tooltip with the full path. The body holds the editor and a 340 px preview with the splitter "Resize editor and preview". The editor has a 44 px line-number gutter (Muted code font, right-aligned, 1 px right divider, only the visible numbers render) and the `textarea` (code font, 18 px lines, padding 8 px, no wrap, `spellcheck="false"`). The selected line has the Selected fill. The footer holds Close and Save (Accent fill), right-aligned.
- Ignore editor keys: Ctrl+S saves while the focus is in the editor panel. Escape runs Close while the focus is in the editor panel and no IME composition runs. The textarea keeps Tab as focus movement.
- Ignore editor texts:
  - Preview: "Updating preview…" (status role); "Newly ignored (<n>)" and "No longer ignored (<n>)" group headings (28 px, with icons); 22 px path rows in the code font; "and <n> more paths" after 1,000 rows; "Tracked files stay tracked." with the count at the end of the note row; the notices of D9; "Preview not available: <reason>." on Warning fill.
  - Preview reasons: `paths` "the preview checks more than 100,000 paths"; `listing` "Git lists more paths or ignore files than the preview reads"; `name-case` "a file name differs from .gitignore only in letter case"; `shadow-copy` "Arbareto cannot copy the ignore files for the preview"; `self-check` "the preview does not match Git for the saved text"; `unreadable` "Arbareto cannot read an ignore file of this repository"; `deadline` "the preview took longer than 30 seconds"; `failed` "Git failed with <code>"; the read gate gives the 004 D12 trust text and "Trust…" in place of the preview.
  - Discard modal: title "Discard changes to <file>?", buttons "Keep editing" (first focus) and "Discard" (danger).
  - Stale save: a Warning notice "<file> changed on disk after Arbareto loaded it. Arbareto did not save your text." with the button "Reload". With unsaved text, Reload opens the discard modal first.
  - Open refusals, shown in the editor region in place of the text: `ignore-link` "<file> is a symbolic link. Arbareto edits only a regular file."; `ignore-folder` "<file> is a folder. Arbareto edits only a regular file."; `ignore-not-regular` "<file> is a special file. Arbareto edits only a regular file."; `ignore-size` "<file> is larger than 1 MiB. Arbareto does not edit it."; `ignore-not-utf8` "<file> is not valid UTF-8 text. Arbareto does not edit it."; `ignore-nul` "<file> holds a NUL character. Arbareto does not edit it."; `mixed-line-endings` "<file> has mixed line endings, or a CR without an LF. Arbareto does not edit it."; `unreadable` "Arbareto cannot read <file>: <code>."; `path` "Git names an info/exclude path outside the Git folder. Arbareto does not edit it.". `<file>` is ".gitignore" or "info/exclude".
  - Save texts: status bar names "Save .gitignore", "Saving .gitignore", "Save .gitignore details" (and info/exclude). Outcome "Saved .gitignore." or "Saved info/exclude.". `ignore-size` at save: "The text is larger than 1 MiB. Arbareto did not save it."; `ignore-nul`: "The text holds a NUL character. Arbareto did not save it."; a text that fails `isWellFormed()` (D9): "The text holds an invalid character. Arbareto cannot save it or show a preview.", shown in place of the preview, with Save unavailable. `BUSY` takes the 003 running reason, and the text stays in the editor. Save runs during an unfinished operation and with conflicts (D10). Another failure: "Save did not complete: <code>.".
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

- Tokens: the 001 and 004 tokens. New: seven age shades, Dark from the Blame board: `#323B4B`, `#3E4D66`, `#4A5F82`, `#56719D`, `#6283B9`, `#6E95D4`, `#7AA7F0` (step 1 to 7). Light (O-2, decided 2026-10-21): `#C2D4F0`, `#A7C0E6`, `#8DACDC`, `#7398D3`, `#5984C9`, `#3E70BF`, `#245CB5` (step 1 to 7). These are seven equal sRGB steps from the Light Selected fill `#DCE8FA` to the Light Accent `#245CB5`, without the fill itself. So step 1 is one step darker than the Selected fill, and the age bar stays visible on the selected line.
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
- Verify in Ubuntu-26.04: F1 to F19, the `./` stdin prefix (F13), the shadow cleanup, and the three Perl modes, with a folder swapped for a link during the `delete` and `replace` walks.

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
| `blame.ignoreRevsFile` repeats. Blame uses every non-empty configuration value from every scope. An empty configuration value resets nothing, although the doc says it does. `--ignore-revs-file=` clears the list. A missing file exits 128 (O-9). | config/blame.adoc:24-28; Git 2.56 builtin/blame.c:764-772 (`string_list_insert`), :941-947, :997; oidset.c:81-83; F7 probed on Git 2.56.0.windows.2 and WSL Git 2.55.0, 2026-10-21 |
| `config --type=path` expands a value as blame does. | Git 2.56 builtin/config.c:350, builtin/blame.c:768, config.c:1320 |
| An excluded folder ends the ignore walk. | Git 2.56 dir.c `prep_exclude` (:1731-1745) |
| `ls-files -o -i --exclude-standard --directory` stops at an excluded folder, and lists a folder of only ignored paths as `<d>/` beside its records. `-i` uses no untracked cache. | Git 2.56 dir.c:2094-2096, :2163-2188, :2661-2663, :3011-3014; probed 2026-10-21 |
| The expansion `ls-files -o -- <d>/` of a nested repository prints `<d>/`. | Git 2.56 dir.c:2045; probed 2026-10-21 |
| RI gives `<x>/` for a nested repository only when x is excluded and its parent is not. A pathspec below an excluded folder can exit 128. | Git 2.56 dir.c:2041-2046, :2088-2096, builtin/ls-files.c:154-155; F10 probed 2026-10-21 |
| In-tree `.gitignore` files open without following a link. | Git 2.56 dir.c:1779 `PATTERN_NOFOLLOW` |
| Git skips a UTF-8 BOM in an ignore file. | Git 2.56 dir.c:1242 `skip_utf8_bom` |
| `ls-files -o --directory` prints a wholly untracked folder as one record. | git-ls-files(1) `--directory` |
| `PostDeleteItem` `psiNewlyCreated` is null for a full delete. | Microsoft Learn `IFileOperationProgressSink::PostDeleteItem` |
| A `PreDeleteItem` failure cancels this and every later item. | Microsoft Learn `IFileOperationProgressSink::PreDeleteItem` |
| `SIGDN_FILESYSPATH` fails for an item without a file system path. | Microsoft Learn `SIGDN` |
| The Shell does not support names that end in a space or a period. | Microsoft Learn "Naming Files, Paths, and Namespaces" |
| A POSIX disposition removes the name when that handle closes. | Microsoft Learn `FILE_DISPOSITION_INFORMATION_EX` |
| A reparse point can be set on an empty folder through `FILE_WRITE_ATTRIBUTES` alone. | MS-FSA 2.1.5.10.37 `FSCTL_SET_REPARSE_POINT` |
| `FOF_WANTNUKEWARNING` partially overrides `FOF_NOCONFIRMATION`. | Microsoft Learn `IFileOperation::SetOperationFlags` (behavior unverified, N2) |
| Each `openWorktree` registration stores a recent entry. | `service.rs:760-768`, `:1050-1068` |
| Git names no upstream for a branch whose remote is gone. | remote.c:1796-1801, :1908 (clarify F2) |

## Open items and reviewer defaults

- **O-1 Visible upstream text.** Decided (user, 2026-10-21): the visible "→ <upstream>" text stays. Only ", not present" goes (spec FR-064).
- **O-2 Light age shades.** Decided (2026-10-21): the D16 Light ramp starts one step darker than the Light Selected fill, so step 1 stays visible on the selected line.
- **O-3 SC-005 runs.** Decided (2026-10-21): the S check, the C check, and the self-check listings run at the same time. The result shows only after the self-check passes. SC-005 counts every preview, the first one too. Risk: one Windows check alone takes 4.1 to 5.0 s, so SC-005 is at risk (D9).
- **O-4 Delete permanently on volumes without POSIX delete.** Accepted (2026-10-21). `FileDispositionInfoEx` with POSIX semantics can fail on such a volume (unverified, N5). The file then stays, and the result names the error. No fallback runs.
- **O-5 WSL `remove` name.** Accepted (2026-10-21). Design R4 named the WSL mode `remove`. That name is the existing owned-lock removal. The plan names the new mode `delete`.
- **O-6 Public request bound.** Decided (2026-10-21): 2 MiB, with the editor text as base64 UTF-8 bytes. A 1 MiB text then takes 1,398,104 bytes, and base64 needs no JSON escape, so 699,048 bytes of the 2,097,152 stay for the rest of the request. Without base64, JSON escapes a LF as 2 bytes and a control character as 6 bytes, so 2 MiB did not hold every 1 MiB text.
- **O-7 `FOFX_EARLYFAILURE`.** Accepted (2026-10-21). Design R4 listed it. The plan drops it, so one failed recycle does not cancel the other items. Identity mismatches still cancel the rest through `PreDeleteItem`.
- **O-8 Tree order module path.** Accepted (2026-10-21). Design R2 proposed `src/frontend/tree-order.ts`. The service sorts the preview lists too, so the module sits in `src/contracts/`.
- **O-9 Empty `blame.ignoreRevsFile` value.** Decided (user, 2026-10-21): blame follows Git exactly. F7 ran on Windows Git 2.56.0.windows.2 and WSL Git 2.55.0. Git uses every non-empty value from every configuration scope. An empty configuration value resets nothing, because `string_list_insert` keeps the values sorted (builtin/blame.c:771) and `build_ignorelist` reads every file (:941-947). The doc says otherwise (config/blame.adoc:24-28). `--ignore-revs-file=` on the command line clears the list (:997). A missing file exits 128 (oidset.c:81-83). Spec FR-059 and D12 step 4 follow Git. The toggle off still passes `--ignore-revs-file=`, so it turns all lists off for one blame.

## Phases

### Batches

| Batch | Steps | Tracks that run in parallel | Content |
|---|---|---|---|
| 0 | P1 (comparator), P2 | WP1 alone after WP0. | This plan, then the contracts and the tree comparator. |
| 1 | P0.1 to P0.3, P1, P3, P4, P6 | A: WP2. B: WP3 (local Windows). C: WP4. | Facts first inside each package, then the shell, the History service, and the frontend base. |
| 2 | P0.1, P0.2, P1, P5, P7 | A: WP5 (after WP4). B: WP6 (after WP2 and WP4). | The file action service and the History UI. |
| 3 | P8 | WP7 alone (after WP5 and WP6). Then the WP3 removal step T057. | The Commit view UI, then the removal of the 004 one-line ignore path. |
| 4 | P9 | WP8 (WSL alone, then packaged). | Qualification. |

User stories by priority: P1 is US1 and US2 (WP4, WP5, WP6, WP7). P2 is US3 to US7 (WP2, WP5 to WP7). P3 is US8 and US9 (WP2).

### Work packages, in run order

| WP | Agent | Files | Steps |
|---|---|---|---|
| WP0 | orchestrator | `specs/005-inspection-file-actions/{plan.md, research.md, data-model.md, contracts/operations.md, quickstart.md}`, the cross-feature text changes | This plan. Then `/speckit-tasks` and `/speckit-analyze`. |
| WP1 | implementer | `src/contracts/{operations,envelope,errors,limits,channel}.ts`, new `src/contracts/tree-order.ts`, `src/contracts/schemas/`, `tests/vectors/`, `tests/contracts/{inspection-contract,tree-order}.test.ts`; the T004 ripple in `src-tauri/`, `src/frontend/bridge.ts`, and the existing contract tests | P2 and the comparator of P1. |
| WP2 | frontend-implementer (loads arbareto-ux, vercel-react-best-practices, web-design-guidelines, shadcn) | `src/frontend/changes/file-tree.ts`, `src/frontend/refs/ReferencesSidebar.tsx`, `src/frontend/branches/BranchButton.tsx`, new `src/frontend/branches/BranchCard.tsx`, new `src/frontend/components/ui/hover-card.tsx`, `src/frontend/index.css`, `src/git-service/branches.ts` (`upstreamPresent`), `tests/contracts/inspection-tree.test.tsx`, `tests/contracts/inspection-card.test.tsx`, `tests/git/branch-gone.test.ts` | P6: US3, US8, US9. After WP1. |
| WP3 | implementer-xhigh | new `src-tauri/src/{file_delete,file_replace,shadow}.rs`, `src-tauri/src/{process_requests,schema,wsl,reveal,service,bootstrap,ipc,close,lib}.rs`, `src-tauri/build.rs`, `src-tauri/capabilities/main.json`, `src-tauri/Cargo.toml` and `Cargo.lock` (features), `src/contracts/wsl-process.json` (modes `delete`, `replace`, `scratch`), `tests/windows/delete-facts.test.ts`. Removal step T057: `src/contracts/{operations,envelope,errors}.ts`, `src/contracts/schemas/`, `src/git-service/{ignore,workbench-review}.ts`, `tests/git/bun-runner.ts`, `src-tauri/src/{process_requests,close,schema,lib}.rs`, `tests/contracts/{inspection-contract,envelope,vectors}.test.ts`, `tests/vectors/`, `tests/git/ignore-editor.test.ts`, `tests/groups.json`; delete `src-tauri/src/file_append.rs` and `tests/git/ignore.test.ts` | P0.3 and P3. Local only. After WP1. `fileAppend` and the 004 `ignore` action stay until the removal step T057, after WP7. |
| WP4 | implementer | new `src/git-service/{commit-changes,blame,blame-parser,line-map}.ts`, `src/git-service/{commands,diff-parser,history-view,session}.ts`, new `tests/git/{history-diff-fixtures.ts,history-diff-facts.test.ts,commit-changes.test.ts,blame.test.ts}`, `tests/contracts/{blame-parser,line-map,diff-parser}.test.ts` | P0.1 and P0.2 (History part), P1 (History part), P4: US1, US7 service. After WP1. |
| WP5 | implementer-xhigh | new `src/git-service/{file-delete,ignore-text,ignore-preview,submodule-open}.ts`, `src/git-service/{ignore,workbench-review,native-runner,git-runner,session}.ts`, `tests/git/bun-runner.ts`, new `tests/git/{file-actions-fixtures.ts,file-actions-facts.test.ts,delete.test.ts,ignore-editor.test.ts,ignore-preview.test.ts,submodule-open.test.ts}`, `tests/git/reveal-path.test.ts`, `tests/contracts/ignore-text.test.ts` | P0.1 and P0.2 (file part), P1 (codec), P5: US2, US4, US5, US6 service. After WP4, because both edit `session.ts`. |
| WP6 | frontend-implementer | `src/frontend/history/CommitDetails.tsx`, new `src/frontend/history/CommitChanges.tsx`, new `src/frontend/blame/{BlameView.tsx,blame-time.ts}`, `src/frontend/state/history-view.ts`, `src/frontend/views/HistoryView.tsx` (the History view frame, not `src/frontend/history/HistoryView.tsx`), `src/frontend/app/Workbench.tsx`, `src/frontend/index.css`, `tests/contracts/{inspection-history,inspection-blame}.test.tsx` | P7: US1, US7 UI. After WP2 and WP4. Parallel with WP5. |
| WP7 | frontend-implementer | `src/frontend/changes/{ChangesPane.tsx,file-actions.ts}`, new `src/frontend/changes/DeleteConfirm.tsx`, new `src/frontend/ignore/IgnoreEditor.tsx`, `src/frontend/submodules/SubmodulesGroup.tsx`, new `src/frontend/app/ParentButton.tsx`, `src/frontend/app/{Workbench,RepositoryMenu}.tsx`, `src/frontend/state/workbench.ts`, `src/frontend/bridge.ts`, `src/frontend/keyboard/shortcuts.ts`, `tests/contracts/{inspection-delete,inspection-ignore,inspection-submodule}.test.tsx`, `tests/contracts/shortcuts-005.test.ts` | P8: US2, US4, US5, US6 UI, and the Commit view Blame entry. After WP5 and WP6. |
| WP8 | implementer writes, scout runs (WSL alone) | `tests/wsl/inspection-wsl.test.ts`, `tests/windows/{inspection-packaged,inspection-perf}.test.ts` | P9. Last. |

Parallel tracks use disjoint files in separate worktrees. These files are not disjoint:
- `src/git-service/session.ts`: WP4, then WP5.
- `src/frontend/app/Workbench.tsx`: WP6, then WP7. `src/frontend/bridge.ts`: WP1 (T004), then WP7.
- `src/frontend/changes/file-tree.ts`: WP2 changes the order. WP7 uses it unchanged.
- `src/contracts/envelope.ts`, `errors.ts`, `limits.ts`, `channel.ts`, and `schemas/`: WP1 owns them. The removal step T057 edits them alone, after WP7. A later package that needs a schema change reports it, and the orchestrator merges it.
- `tests/groups.json`: every WP appends its lines. The orchestrator resolves merge conflicts.
- Rust: only WP3 edits `src-tauri/`, with its removal step T057.
- `src/frontend/index.css`: WP2, then WP6.
- `tests/contracts/bridge.test.ts`: WP6, then WP7.

Dependencies: main at 3575a15 holds features 001 to 004. No 005 package waits for another feature.

## Agent context

Spec Kit v1.0.12 in this repository has no `update-agent-context` script, and `setup-plan.ps1` changes no agent file. So this step changes no `CLAUDE.md`. The plan adds no technology that CLAUDE.md must name. A CLAUDE.md change goes through `claude-md-management:claude-md-improver`.

## Complexity Tracking

No Constitution Check violation. The table stays empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
