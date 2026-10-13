# Implementation Plan: Full History and Commit Message Filter

**Branch**: `f002-spec` (feature `002-full-history`) | **Date**: 2026-10-11 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-full-history/spec.md`

**Related**: [research.md](research.md) | [data-model.md](data-model.md) | [contracts/operations.md](contracts/operations.md) | [quickstart.md](quickstart.md)

## Summary

The full history reads one `rev-list` order per view in load steps. A step reads to a stop row a fixed read-ahead below the window, and then the service ends Git. A later step runs the same argv again, compares each re-read row with the held row at the same index, and appends the new rows. End and a search load to the end. The service holds the compact topology of the loaded rows and the lane layout. The renderer draws only the visible rows. The message filter is one `rev-list --grep` stream that merges into the view as a subsequence. The service builds the filter-mode reduced graph itself. The design needs no new shell flow-control frame, no Web Worker, and no new dependency.

Three facts drive the choices (research R2, R8):
- The shell has no per-call output flow control, and the service handles each frame before it reads the next. A paused stream would stall the service pipe for every operation. So a load ends Git at its stop row and never pauses it.
- Without a commit-graph, Git sorts the whole graph before its first row (Git revision.c:3195-3196, 4053-4057). An ended Git frees that memory at once. Each later step pays the walk again (D2).
- The installed list virtualizer rebuilds O(n) arrays on every count change and has no fix for the maximum element height. The history list uses fixed-height row arithmetic. ChangesPane and the references sidebar keep `@tanstack/react-virtual`.

Git alone uses more than 128 MiB on 1,000,000 commits (research.md R14). The user decided on 2026-10-12 that SC-002 excludes Git's child processes (O-1, closed).

## Technical Context

**Language/Version**: The 001 versions stay: TypeScript `7.0.2`, Bun `1.4.2` (exact), Rust/Cargo `1.98.0` (001 plan.md "Technical Context").

**Primary Dependencies**: No new dependency. React `19.3.0`, zod `4.6.5`, Tauri `2.12.0` as in 001. ChangesPane and the references sidebar keep `@tanstack/react-virtual`. The history list does not use it (research R8, D6).

**Storage**: None new. All view, search, and cache data lives in the service session or renderer memory. The application writes no repository data (spec FR-044).

**Testing**: Bun tests in real disposable repositories (`tests/git`), contract tests and golden vectors (`tests/contracts`, `tests/vectors`), Windows packaged tests (`tests/windows`), WSL tests (`tests/wsl`), and cargo tests for the shell allowlist, the policy, and the wrapper mode.

**Target Platform**: Windows 11 x64 first, with Git for Windows. WSL2 repositories through the distro Git. The order facts are recorded on Git 2.56.0.windows.1 and WSL Ubuntu-26.04 Git 2.55.

**Project Type**: Local-first desktop application: Tauri 2 shell, compiled Bun Git service, React renderer.

**Performance Goals**: Spec SC-005, SC-006, SC-011, and SC-014. SC-011 uses the 001 statistic: the upper 95% bound of the median ratio (001 plan.md "Matched-condition comparisons").

**Constraints**: SC-002 over the Arbareto processes (shell, service, WebView2), with Git's child processes recorded but not bounded (O-1): 16 MiB after the first load step ends, with no Git process of the view (proposed, O-2), and 128 MiB after End, after a return to the top, and during a search. No renderer work grows with the history size. Every Git process has a deadline and its own Job. Read-only Git with `--no-optional-locks` and `--no-lazy-fetch`.

**Scale/Scope**: Fixtures of 200,000 commits for correctness and timings, and 1,000,000 commits for the memory and responsiveness records. One view per service session. At most 4,000,000 commits per view, 10,000 refs, 64 parents per commit, 24 lanes per row, and 1,024 UTF-8 bytes of filter text. Memory grows with histories above 1,000,000 commits (spec Assumptions).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Checked against `.specify/memory/constitution.md` version 3.0.0, before research and again after Phase 1.

| Principle | How the design meets it | Status |
|---|---|---|
| I. Preserve user data | Read-only Git commands with `--no-optional-locks`. The app writes no commit-graph and only shows the remedy. The probe writes only a temp repository outside every user repository. SC-013 checks byte identity. The selected Git runs everything. | Pass |
| II. TypeScript/Bun | All logic is in TypeScript. The Rust changes are data and enums. | Pass |
| III. Validated boundaries | Five typed operations with zod and the strict decoder. The renderer sends only IDs, numbers, and validated text. Every record is bounded. A view holds at most 4,000,000 commits and each line at most 65 OIDs, so every stream is bounded (note N-1). Each operation has its own Job for cancel. | Pass |
| IV. Real Git verification | Real fixtures. Failure, cancel, and external-change cases: ref moves, shallow, replace, missing objects. | Pass |
| V. Untrusted repositories | No repository program runs. `rev-list` and `cat-file` run without filters. The trust gate runs at open. Text shows as plain text. The search text enters no log. | Pass |
| VI. Platform evidence | Packaged Windows evidence. WSL stays unverified until the distro runs. | Pass |
| VII. Accessible and measured | Keyboard: Ctrl+F, Enter, Escape, F3 and Shift+F3, End, Ctrl+Shift+B. Marks do not depend on color. Budgets are fixed before measurement. See notes N-2, N-3, and N-5. | Pass, with notes N-2, N-3, and N-5 |
| VIII. Locked dependencies | No new dependency. | Pass |
| IX. One planning process | All artifacts stay in `specs/002-full-history`. The 002 contract lists only deltas and cites 001 sections. | Pass |

Notes from the second check:
- **N-1 (III, "Operations MUST bound output")**: Closed. A view holds at most 4,000,000 commits (`HISTORY_VIEW_COMMITS`, contract Δ5). At that bound, the load ends `limited` with `OUTPUT_LIMIT`. The loaded rows stay, and the view states the limit. Each line holds at most 65 OIDs, and the service keeps no raw bytes beyond one partial line. The search stream lists only commits of the view, so the same bound covers it. The bound is a reviewer default (spec Assumptions).
- **N-2 (VII, "complete process-tree memory")**: Closed 2026-10-12. SC-002 adopts the SI-1 text of O-1, so the budget excludes Git's child processes. The measurement still samples the complete process tree and records each Git process apart, so VII holds. The user approved the changed target as an explicit product trade-off (VII), before any budget run.
- **N-3 (VII, "CPU")**: P8 records the CPU time of each process in the tree, from the WPR CPU trace of each workload run, with Git processes apart.
- **N-4 (Delivery Gates)**: The plan defines safety tests (SC-013, SC-010), trust boundaries (Δ7), accessibility checks (FR-031, FR-040, SC-014), performance budgets (SC-002, SC-006, SC-011, SC-014), and the platform qualification (P8, WSL).
- **N-5 (VII, "cold/warm timings")**: P8 records cold and warm runs for SC-005, SC-006, and SC-014, by the 001 rules.

No violation, so Complexity Tracking stays empty. Five items carry ponytail ceilings:
- the compact OID table;
- the fixed-height window;
- the 4,000,000-commit view bound, about 185 to 360 MB (about 46 B per commit when the typed arrays are nearly full, about 90 B just after a doubling) of service memory (unverified; D3). A larger bound needs a measured memory design;
- the topology of every loaded row, which stays for the life of the view (D3);
- End or a search that cancels a running scroll load, which loses at most one Git walk without a commit-graph (D2).

Known limits outside the history view (spec Assumptions): the changes list holds up to 100,000 status entries in memory (`STATUS_LISTING_RECORDS`), and a ref set above 10,000 refs gets the `REF_LISTING_RECORDS` refusal.

## Project Structure

### Documentation (this feature)

```text
specs/002-full-history/
├── spec.md
├── plan.md                 # This file
├── research.md             # Phase 0
├── data-model.md           # Phase 1
├── quickstart.md           # Phase 1
├── contracts/
│   └── operations.md       # Phase 1: deltas to the 001 contract
├── checklists/
│   └── requirements.md
└── tasks.md                # Phase 2 (/speckit-tasks, not created here)
```

### Source Code (repository root)

```text
src/
├── contracts/              # limits.ts, envelope.ts, errors.ts, operations.ts, channel.ts,
│                           # git-environment.json, wsl-process.json, schemas/,
│                           # new: filter-text.ts, matching-probe.ts
├── git-service/            # commands.ts, refs-parser.ts, refs.ts, session.ts, history.ts (P7 retires readHistory)
│                           # new: history-topology.ts, history-layout.ts, history-reduced.ts,
│                           #      history-view.ts, history-search.ts
└── frontend/               # bridge.ts, app/Workbench.tsx, NoticeBand.tsx,
                            # history/HistoryView.tsx, AncestryCell.tsx, CommitDetails.tsx, lanes.ts (P7 retires it),
                            # refs/ReferencesSidebar.tsx
                            # new: state/history-view.ts, history/HistoryFilter.tsx, history/HistoryList.tsx
src-tauri/
├── build.rs
└── src/                    # ipc.rs, git_env.rs, wsl.rs
tests/
├── git/                    # new: history-fixtures.ts, history-order.test.ts, history-layout.test.ts,
│                           #      history-search-facts.test.ts, view and search tests
├── windows/                # new: history-git-memory.test.ts, history-perf.test.ts
├── wsl/                    # new: history-wsl.test.ts
├── contracts/              # new: history-*.test.tsx
└── vectors/
```

**Structure Decision**: The 001 three-part layout stays: renderer, Bun service, and shared contracts, with a thin Tauri shell. The layout moves from `src/frontend/history/lanes.ts:50-120` into `src/git-service/history-layout.ts`.

## Design

### Steps (riskiest proof first)

| Step | Files and symbols | Behavior change | Tests that prove it | Main risk |
|---|---|---|---|---|
| P0.1 Fixture builder | new `tests/git/history-fixtures.ts`. It reuses `fiCommit` (`tests/git/fixtures.ts:1204-1235`) and the cache, lock, seed, and digest of `tests/windows/perf-fixtures.ts` (`PERF_CACHE_ROOT`, `ensurePerfFixture`, `hasCommitGraph`). | None (tests only). Small graph fixtures: equal dates, clock skew, criss-cross, an octopus with 10 parents, a merges-only segment, 50 tips, a shallow clone, tag chains, tags to a tree and a blob, the stash with 2 reflog entries, notes, `refs/pull/1/head`, an unborn branch beside other refs, an empty repository, a detached HEAD. Large fixtures: H200K and H1M, with merges, parallel lines, equal-date runs, skew, Ukrainian/ß/ẞ/SS messages, and windows-1251 messages, each with and without a commit-graph. | The builder self-check: counts, `hasCommitGraph`, semantic digest. | Build time for 1M commits. Mitigation: the existing cache. |
| P0.2 Git order facts | new `tests/git/history-order.test.ts` | None. Records Git behavior that Git does not document. | Two runs of the view argv give the same bytes. `--skip=k` equals the suffix, for k in {1, 255, 256, 257, rows inside merges, last}. The `--skip=k` fact is kept as a record. The load path does not use it (D2). `--date-order` is equal with and without a commit-graph. The stdin order of the start points decides ties between equal dates (experiment, Git 2.56.0.windows.1), so the start points go in ascending lowercase hex. `--grep` equals the full order with the non-matches removed. Windows Git 2.56.0 and WSL Ubuntu-26.04 Git 2.55. | A fact fails. The design still holds, because runtime checks refuse with `HISTORY_CHANGED`. Record the result in research.md. |
| P0.3 Layout equivalence | new `src/git-service/history-layout.ts`: `layoutStep(lanes,row)`, checkpoints, `cellsOf(range)`, moved from `src/frontend/history/lanes.ts:50-120`. New `tests/git/history-layout.test.ts`. | The layout becomes a step function that carries state. | On every graph fixture and H200K: rows fed in random chunk sizes, then cells rebuilt from checkpoints, equal one fold over all rows, cell by cell. Every node-to-bottom segment ends in the lane of the matching Git parent. | The proof from the code is untested. This test is that proof. |
| P0.4 Git memory record | new `tests/windows/history-git-memory.test.ts` (Windows; `GetProcessMemoryInfo` through `bun:ffi` in this file, because 001 T165 has not created `inject.ts` yet) | None. | Peak private bytes of the topology `rev-list` and the search `rev-list --grep`, on H1M with and without a commit-graph. Also the peak up to line S₀ of the first load step of D2, 2,089 for n = 40. T061 also records the re-read cost of a later step at 1,000,000 commits. | It decides O-1 before the budget work starts. |
| P0.5 Matching facts | new `src/contracts/matching-probe.ts` (the fixed fast-import stream and the expected OIDs). Test in `tests/git/history-search-facts.test.ts`. | None. | The FR-023 and FR-024 cases on Windows Git and each WSL distro. Also checks that `init --template=` copies nothing and that an explicit `--git-dir` gets no ownership refusal. | A distro without the C.UTF-8 locale or without PCRE2. |
| P1 Pure algorithms | new `src/git-service/history-topology.ts` (OID table, CSR parents, line parser, order checks), new `src/git-service/history-reduced.ts`, new `src/contracts/filter-text.ts` | Algorithms only. | Topology checks: a duplicate row, a parent that already showed, a non-empty frontier at the end. Reduced graph against a brute-force BFS oracle on the small fixtures and H200K. Filter-text refusals. | Memory per commit. Mitigation: typed arrays, no JS `Map` of OID strings. |
| P2 Contracts | `src/contracts/{limits.ts, envelope.ts, errors.ts, operations.ts, git-environment.json, channel.ts, wsl-process.json}`, `schemas/`, `tests/vectors/` | Adds 5 operations, 3 codes, the `search` policy, the WSL mode `search`, and the `matchingProbe` script. | Schema tests and golden vectors in Bun and Rust. | The shell reads no payload of the five operations (contract Δ1). The service schemas check the ranges. |
| P3 Service view | `src/git-service/commands.ts` (argv builders), `refs-parser.ts` (kinds `stash`, `replace`; `refsDigest`), `refs.ts` (`refs/stash`), new `history-view.ts`, `session.ts` (handlers). Reuses `captureHead`, `sharedListing`, and `checkFailedRead` from `history.ts:255-397`. | `openHistory`, `loadHistory` with the D2 stop rule, `readHistoryRows`, `closeHistory`. | SC-001, SC-003, SC-004, and SC-015 on the small fixtures and H200K. Load cancel and resume. The D2 stop rule: a load ends at its stop row, no process of the load remains, and the next load runs the same argv with no `--skip`. A re-read row that differs from the held row gives `HISTORY_CHANGED` reason `order`. The `HISTORY_VIEW_COMMITS` bound with a lowered test bound. The stale cases. The trust gate. `REPOSITORY_CHANGED`. SC-013 byte identity. | Service CPU during an End load of 1M rows (about 1,350 frames of 64 KiB, unverified). The shell routes `succeeded` after the service closed the load Job (unverified). |
| P4 Shell | `src-tauri/src/ipc.rs` and `src-tauri/build.rs` (5 commands), `git_env.rs` (policy `search`), `wsl.rs` (mode `search`, `matchingProbe`), `src-tauri/src/service.rs` (test only), `src/frontend/bridge.ts` (the five calls), `tests/contracts/bridge.test.ts` | Data and enum changes only. No new frame. | cargo tests for the allowlist, the policy, and the wrapper mode. | Local only. Rust work stays off cloud sessions. |
| P5 Search | new `src/git-service/history-search.ts` (search, probe, merge, reduced settlement). `session.ts` gets the handler and the test option `historyProbeRuns`. `history-view.ts` runs the search on the view. `git-runner.ts` allows the policy `search`. | `searchHistory`. | SC-007 (Windows and each distro), SC-008, SC-009 (no Git process starts), SC-010 search cancel, the order-mismatch refusal. | The subsequence order is only an experiment fact. The runtime check refuses on a mismatch. |
| P6 Frontend | `src/frontend/bridge.ts`, new `state/history-view.ts`, `history/HistoryView.tsx`, new `history/HistoryFilter.tsx`, `history/AncestryCell.tsx`, `history/CommitDetails.tsx`, `app/Workbench.tsx`, `NoticeBand.tsx`, `refs/ReferencesSidebar.tsx` | A virtual list, the D6 load trigger and the more-rows row, the filter, the two modes, the notices, the scope switch, the details pane. The references sidebar becomes a virtual list (D6). | Component tests: keyboard, refusals, notices, stable rows after eviction (FR-011), a fake count of 1M rows with no O(n) structure. The D6 trigger, the more-rows row, End and a search after a running scroll load, and stable rows when the count grows. The sidebar with 10,000 refs (FR-055). | Compressed scrolling at the 1M scale. |
| P7 Retire 001 `readHistory` | `operations.ts`, `envelope.ts` (`ReadHistory`), `history.ts` (`readHistory`, `pageOf`), `session.ts`, `ipc.rs`, `src/frontend/history/lanes.ts`, their tests | One history path only. | The full run stays green. | 001 evidence names `readHistory`. Keep the 001 artifacts as records. |
| P8 Qualification | `tests/windows/history-perf.test.ts`, responsiveness workloads, the Git Extensions harness, `tests/wsl/history-wsl.test.ts` | None. | SC-002, SC-014, and the SC-001 End case on H1M. SC-005, SC-006, and SC-011 on H200K. SC-010 and SC-012 in the packaged build. CPU for each workload (N-3). Cold and warm runs for SC-005, SC-006, and SC-014, by the 001 rules (001 plan.md "Measurements and budgets"). | Git memory is recorded, not bounded (O-1, closed). The filter ratio is close to 1.0. Open 001 tools and the measurement environment (001 T154, T165, T180, T240, T242, T244). |

Each phase writes its tests first. P0.2, P0.3, and P0.4 are the riskiest proofs and run first.

### D1 Contracts

[contracts/operations.md](contracts/operations.md) holds the deltas. They extend 001 §3, §5, and §9, with no fork. Summary:
- `openHistory {scope}` captures HEAD, the FR-047 refs, and the shallow and grafts digests. It returns a `viewId`. One live view per service session.
- `loadHistory {viewId, need}` reads `rev-list --parents --date-order --stdin` to the D2 stop row. `need` is `{row}`, `{oid}`, or `{end: true}`. A later step runs the same argv. It compares the first N streamed rows with the N held rows and appends the rest. At 4,000,000 rows, the load ends `limited` with `OUTPUT_LIMIT` reason `HISTORY_VIEW_COMMITS`, and the rows stay.
- `readHistoryRows` serves scroll pages, navigation, and details. It returns cells, labels, match marks, and optional text.
- `searchHistory {viewId, text}` runs the literal, case-folding search under the `search` policy and merges the matches.
- `closeHistory {viewId}` frees the view.
- `readRefs` adds `refs/stash` and `refsDigest`.
- A ref change gives a notice, never a stale view. Contract Δ8 lists the stale conditions.
- New codes: `HISTORY_CHANGED`, `UNSUPPORTED_FILTER_TEXT`, `SEARCH_UNSUPPORTED`.

### D2 Service process model: load steps, never pause

- A load reads one `rev-list` stream up to its stop row S. The service then ends Git. Git never pauses, because a paused stream would stall the service pipe (research R2). An ended Git frees the memory of its walk at once.
- Stop rule (contract Δ3 `loadHistory`). L₀ is the topology row count at the start. n is the last needed row. M is `HISTORY_LOAD_MARGIN`, 1,024 rows. `{row: n}`: S = max(n + 1 + 2·M, 2·L₀). `{oid}`: S stays open until the commit streams at row r, then S = max(r + 1 + 2·M, 2·L₀). If the commit never streams, the load reads to the end. `{end: true}` and the load of a search have no stop row.
- Re-read rule (contract Δ3 `loadHistory`). Every step runs the same argv, with no `--skip`. N is the topology row count at the start, served or not. The service compares streamed row i with held row i, in OID and parents, for each i below N. The first difference, or a Git exit 0 before row N, makes the view stale with `HISTORY_CHANGED` reason `order`. The rows from N on append. Reason: Git documents no unique order (rev-list-options.adoc:916), so a later run can order the skipped rows another way. A one-row overlap check cannot prove the skipped prefix. The full compare uses only exact parses. N = L₀ and S ≥ 2·L₀, so a step with N ≥ 1 ends its compare before its stop row.
- At S rows, the service waits for the fingerprint check of the load. It then sends the process `cancel` for the call and waits for `exit` (001 §6 "Channel frames"). That closes the Job of the load operation. The check process runs in that Job, so the service must not end Git before the check finishes. The service ignores the exit code of that `cancel`. A Git exit 0 at or after row N and before S makes the view complete.
- Fingerprint check (contract Δ3 `loadHistory`). The service reads the shallow and grafts files before Git starts, so a change there starts no Git process. It reads the replace refs beside the Git start. A text read runs no check, because commit text cannot change with the topology. The view serves only the rows of a load whose check passed. Rows of a load whose check did not finish stay unserved, and the next load re-reads, compares, and serves them.
- The renderer starts a scroll load when fewer than M loaded rows lie below the last needed row (D6). The trigger uses row positions only.
- The factor 2 is exact arithmetic. A scroll to row D needs at most 1 + ⌈log₂(D / S₀)⌉ loads. Each step that ends at its stop row at least doubles the row count. So the re-read rows of all later steps add up to less than twice the final row count, and to less than the final row count when the last step ends at its stop row. Each step that ends by Cancel or `DEADLINE` adds at most its N re-read rows. Until End or a search, the view holds at most 2·n + 2·M + 1 rows. A constant step would cost one walk per step.
- Re-read cost (research R1). Without a commit-graph, Git sorts the whole graph before its first line (Git v2.56.0 revision.c:2485-2487, 3195-3196, 4053-4057). So each later step costs one full walk: about 1 s at 200,000 commits (experiment), about 4.7 s at 1,000,000 (unverified). With a commit-graph, Git walks on demand (revision.c:4058-4059). A later step then streams the N held rows again, and the service parses and compares them. Its cost grows with N (unverified; T061 records it). Each later step also runs the fingerprint check and sends the start points again. In WSL, each Git process adds one `wsl.exe` start.
- Full scroll cost, with S₀ = n + 1 + 2·M; 2,089 for n = 40. End: one load to the end after the first load. Without a commit-graph, open and End cost two walks; the drain design cost one. A scroll to the end without End takes 8 loads at 200,000 commits and 10 loads at 1,000,000. Without a commit-graph, each load is one walk. With a commit-graph, the re-read rows add up to less than two extra passes: 265,303 rows at 200,000 commits and 1,067,479 rows at 1,000,000 commits.
- One load runs per view. A second load gives `BUSY`. End and a search cancel a running scroll load first (D6).
- Each frame is parsed into the topology arrays, then the layout step and the reduced-graph step run. About 1-3 µs per row, so about 2 ms per 64 KiB frame (unverified). Other requests wait at most one frame.
- At most 3 history processes run per view: the load, the search, and the text read. They take no read slot.
- Each operation has its own Job. `cancel` closes that Job.
- After a service restart, no view resumes. The renderer marks the view stale. Refresh opens a new one.
- New: the `search` policy, the WSL wrapper mode `search`, the matching probe, and the process bound outside the read slots. No new channel frame.
- Left out:
  - a per-call output credit frame, because the stop row bounds each load;
  - `--max-count`, because an `{oid}` load learns its stop row only when the commit streams;
  - a raise of the stop row of a running load (add it when a measured End misses a target);
  - `--skip=<N-1>` with a one-row overlap check, because it cannot prove the skipped prefix (re-read rule above).

### D3 Exact page rule

- Rows are addressed by their position in the one stream of a view. A streamed row never changes.
- The cell of row i is `layoutStep(state_i, row_i)`. `state_i` is rebuilt from the checkpoint at ⌊i/256⌋·256. The function is pure, so a rebuilt cell equals the first one.
- The state holds the output lane array and the lane count. It holds no set of sent OIDs, because `--date-order` sends no parent before its children (git-rev-list(1)). The topology table checks duplicate rows and parents that already showed as rows. A parent that repeats inside one line gives one edge (data-model §3, T012).
- A row is limited exactly when it needs more than 24 lanes. A limited row closes the free lane slots and keeps the lane order (O-5, data-model §4).
- Text is read again by OID. Commit objects never change.
- In a complete stream, every parent is a later row. So the 001 "outside page" branch never runs (`lanes.ts:52-55, 84-102`).
- Merges and multiple tips need no special rule. Git's single stream already orders them.
- A load that ends at its stop row keeps the live lane state. The next load continues the fold from it. The cell of row i depends only on rows 0 to i, so load steps change no cell.
- The service stores no cell and no row text.
- The topology table stays for the life of the view. Rebuilding the table would cost one more read from row 0. The lane state of row N depends on every row above it. The hash slots carry the duplicate check, `at: {oid}`, and the search merge. The re-read compare of each later step needs the held rows (D2).
- ponytail: for SHA-1, about 46 bytes per loaded row when the typed arrays are nearly full, and about 80 to 90 bytes just after a doubling (unverified). That is about 185 to 360 MB (about 46 B per commit when the typed arrays are nearly full, about 90 B just after a doubling) at `HISTORY_VIEW_COMMITS`. Upgrade path: drop the rows below the window plus M after a return to the top, and reload them by the D2 re-read rule. Add it when a qualified fixture above 1,000,000 commits must fit SC-002 after End.
- The plan tests what Git does not document (rev-list-options.adoc:916): the P0.2 facts, plus a resume after a cancel at each chunk boundary on H200K, compared with one uninterrupted run.

### D4 Filter-mode reduced graph

Rows are processed in stream order. A row is processed only when its match state is known (D5).
- `P` maps each referenced commit that is not processed yet to a sorted array of match sequence numbers. Arrays are shared and never changed.
- For row x, take `S = P.take(x) ?? ∅`.
- If x is the match with sequence q: for each m in S, add the edge m→q. The edge is direct when x is a parent of m. Otherwise it skips commits. Then T = [q].
- If x does not match: T = S.
- For each parent p of x: `P[p] = P[p] ? union(P[p], T) : T`.
- The settled prefix is the minimum of the next unprocessed match sequence and the smallest first element over the arrays in `P`.

Proof:
- Define D(x) as the matches m ≠ x with a parent path m→…→x and no match strictly between them.
- Every path into x ends with a step from a child c. With `--date-order`, every child streams before its parent. So when x is processed, the union of {c} for matching children and D(c) for the other children equals D(x), by induction over the stream order.
- An edge m→a is emitted exactly when a matches and m is in D(a). That is the FR-033 definition.
- A later edge from m needs m in the array of some unprocessed commit. So m is final when no array in `P` holds it.

Cost: parents times the union size per row, plus a scan over `P` (at most the frontier width). About 2·10⁷ operations at 1M rows, roughly 50-100 ms in total (unverified). Worst case: k branches that join one base give O(k²) union work. This is a ponytail ceiling; a mergeable heap is the upgrade path. Memory: the frontier, plus 8 bytes per reduced edge.

The reduced graph needs the full topology stream beside the search stream, because the paths pass through commits that do not match. Git rewrites parents only under path simplification (revision.c:4077-4096). Filter rows show text before they are settled, with a null cell until then. The reduced layout reuses `layoutStep` with checkpoints. A skip edge draws its node-to-bottom segment with the dashed style, and its accessible text says it skips commits. A match without a matching ancestor shows "No earlier matching commit", unless it is a true root or a shallow boundary. So a search loads to the end (D5).

### D5 Search and highlight mode

- Refusals before any Git process: text that is not well-formed, text above 1,024 UTF-8 bytes, and text with U+000A, U+000D, U+0000, or U+005C followed by U+0045. The reason names the character (SC-009). The renderer runs the same `filter-text.ts` checks first.
- Command and policy: contract Δ3 `searchHistory`. The fingerprint check runs first. `--fixed-strings` overrides `grep.patternType` (unverified). The `-c` value comes after an inherited `GIT_CONFIG_PARAMETERS`, so it wins (unverified).
- Matching probe: contract Δ3 "Matching probe". It runs before the search, not beside it. Hold its output in parallel only if SC-006 misses.
- Merge into the view and the known match state: contract Δ3 and data-model §6.
- Load during a search: a search on an incomplete view loads to the end itself, because filter mode needs the full topology stream (D4). That load belongs to the search operation, so its progress and Cancel go with the search. A `searchHistory` while a load of the view runs gives `BUSY`, so the renderer cancels its scroll load first (D6). A view at the `HISTORY_VIEW_COMMITS` bound gets a `limited` search result, and no Git process starts.
- Filter-mode positions: `at: {row: k}`, the row `index`, and the list length count matches, not view rows. `from` in `at: {match, from}` is an inclusive view row index (contract Δ3 `readHistoryRows`). These are reviewer defaults, not user decisions.
- Next and Previous use `readHistoryRows at:{match}`. The streamed matches have rising row indices, so a binary search finds the target. When the target is not loaded yet, the request waits on the load or search progress, with Cancel. A finished search leaves a complete view. Previous never targets an unloaded row, because loaded rows stay.
- Progress: phase `history-search`, counters `matches` and `settled`. The final count comes in the terminal response (FR-039). A shallow view adds the "searched only the commits that the clone holds" sentence.

### D6 Frontend

- **List**: a fixed-height window. The scroll height is `min(total·rowHeight, MAX_LAYOUT_PX)`. The window reads `maxScrollTop = scrollHeight − clientHeight` from the list element. The virtual offset is `virtualTop = scrollTop · (total·rowHeight − clientHeight) / maxScrollTop`. When `scrollHeight = total·rowHeight`, `virtualTop = scrollTop` exactly. When `maxScrollTop ≤ 0`, `virtualTop = 0`. The first row is `floor(virtualTop / rowHeight)`. Row i is drawn at `scrollTop + i·rowHeight − virtualTop`. So row 0 is at the top at scrollTop 0, and the last row ends at the viewport bottom at `maxScrollTop`. A row that must show (End, keyboard selection) gets a target `virtualTop` by this rule. A row above the viewport aligns to the viewport top. A row below the viewport aligns to the viewport bottom. A visible row does not move. The window then sets `scrollTop = virtualTop · maxScrollTop / (total·rowHeight − clientHeight)`. `MAX_LAYOUT_PX` is Chromium's LayoutUnit maximum, about 33,554,431 px (unverified in WebView2). 1M rows at the comfortable density need about 34M px, which passes it. Research R8 records why `@tanstack/react-virtual` does not fit.
- **Scroll range while the count is unknown**: `total` is the loaded row count plus one more-rows row. That row states that more commits exist (FR-010). No estimate enters `total`. When the view is complete, the more-rows row goes, and the count text shows the final row count. A scrollbar drag reaches only loaded rows and the more-rows row.
- **Load trigger**: The first load after `openHistory` sends n = the last row index of the first window (rows that fit `clientHeight`). Later, n is the last commit row in the window, or the loaded row count when the more-rows row shows. The renderer sends `loadHistory {need: {row: n}}` when the view is not complete, no load or search runs, and fewer than M loaded rows lie below n. After a canceled load or a `DEADLINE`, it waits until the more-rows row shows.
- **Loads to the end or to a commit**: End sends `{end: true}`, then reads `at: {end: true}`. Refresh and a scope switch with a selected commit send `{oid}`. With an active filter, the renderer sends only `searchHistory`. End and a search first cancel a running scroll load and wait for its terminal response.
- **Branch scope** (spec FR-049): no tabs. The default is all branches. A View menu checkbox "Current branch only" switches the scope, with the shortcut Ctrl+Shift+B (a reviewer default, spec Assumptions). The branch context menu shows "Show only this branch's history" only on the current branch. While the scope is the current branch, the history heading shows the removable chip "Current branch only ✕". Removal of the chip selects all branches. Each switch opens a new view (contract Δ3 `openHistory`). UI reference: the approved mockup canvas https://claude.ai/artifact/Ffaf1d13daeFsU3Ski3E54 (user decision 2026-10-12, spec Clarifications).
- **Count growth**: when `total` changes, the window keeps `virtualTop` and sets `scrollTop` by the inverse rule. No visible row moves.
- **References sidebar** (spec FR-055): the flattened tree rows go through `@tanstack/react-virtual`, as in ChangesPane. The R8 rebuild cost does not apply, because the count is at most 10,000 (`REF_LISTING_RECORDS`) and changes only on expand, collapse, or a filter change. Each `treeitem` carries `aria-level`, `aria-posinset`, and `aria-setsize` (WAI-ARIA 1.2 "tree"). Keyboard navigation scrolls the target row into the window before it moves focus.
- **Shortcuts**: Ctrl+F focuses the filter. F3 and Shift+F3 move to the next and the previous match. Ctrl+Shift+B toggles "Current branch only". The 001 map (001 plan.md "Keyboard and focus", `src/frontend/keyboard/shortcuts.ts`) uses none of these keys. The 001 accelerator handler turns off the WebView2 find keys, so Ctrl+F and F3 reach the page. T038 records conflicts with the 001 keyboard map before T040. These keys are reviewer defaults, not user decisions.
- **Listbox**: focus stays on the list element with `aria-activedescendant`. Options carry `aria-posinset`. `aria-setsize` is -1 until the count is known (WAI-ARIA 1.2).
- **Cache**: pages of 128 rows in LRU order up to 8 MiB of `bytes`. The visible pages always stay. Row reads follow the latest-wins rule, one in flight per view.
- **Graph column**: its width is the `lanes` value, at most 24. It never shrinks during a view (FR-016).
- **Labels**: they come from the rows, so the 001 chip-pairing rule goes. The 001 label layout stays (001 plan.md "History graph design"): the labels take at most half of the subject cell, a name ends with an ellipsis beyond 160 DIPs, and labels that do not fit collapse into one "+<n>" chip.
- **Working directory line**: the dotted lead-in shows only when HEAD is row 0.
- **Memory**: the renderer holds O(visible + cache) only. For SHA-1, the service holds about 46 bytes per loaded commit when the typed arrays are nearly full, and about 80 to 90 bytes just after a doubling (unverified, D3). That is about 100 to 200 KB near the top, and about 46 to 90 MB at 1M commits after End or a search.

### D7 Responsiveness

- No renderer work grows with the history size. Layout, parsing, merging, and settlement run in the service, in tasks of one frame each. No Web Worker.
- Measurement reuses the 001 method: WPR Verbose long tasks, DXGI capture, and `inject.ts` probe inputs every 100 ms.
- Additions: a poll of `IsHungAppWindow` every 100 ms. Windows reports a window as not responding after 5 seconds without message processing (Win32 documentation). Whether it covers the Tauri main window is unverified.
- Workloads on H1M without a commit-graph, the slow-Git case: open, End, scrollbar drag, wheel scroll, search, mode switch, scope switch, Cancel, and Refresh after a ref move.
- The 001 History-ready frame drops "Up to 100 commits". The plan redefines it as visible rows with text and cells. The count can still load.

### D8 WSL

- The same operations run through the wrapper. `search` is a new wrapper mode that adds `LC_ALL=C.UTF-8`, because no Windows variable reaches Linux.
- Each text read costs one `wsl.exe` start, about 250 ms (unverified). A long-lived `cat-file` is left out. Add it when WSL misses SC-014.
- A `DEADLINE` of a WSL view returns the remedy text with `command: null`. No WSL form of the commit-graph command exists (contract Δ11).
- Verify in each distro: the matching probe, the P0.2 order facts with that Git version, the `wsl.exe` relay throughput of an End load on H200K, the text latency, and Linux memory through the scope `memory.peak`. Without the last one, SC-002 stays unverified there.

### D9 Tests and fixtures

- Fixtures: P0.1, built at test time and cached.
- Oracles:
  - SC-001: on H200K, the view rows after loads to the end equal one uninterrupted `rev-list --date-order --parents` run. The commit set equals `git log --branches --remotes --tags refs/stash HEAD`. On H1M, the last row after End equals the last line of that run.
  - SC-004: the P0.3 equivalence.
  - SC-008: the BFS oracle and `rev-list --grep`.
  - SC-015: the ref fixture.
- RAM: SC-002 samples private bytes over the complete process tree every 100 ms. The budget sums only the Arbareto processes: the shell, the service, and the WebView2 processes. Git processes are recorded apart and have no bound (O-1). The base is the same worktree with a one-commit history (SC-002). It records the four SC-002 checkpoints and the loaded row count at each.
- Git Extensions (SC-011): matched work on H200K, with the maintained commit-graph variant and the 001 ABBA and run rules. The gate is the upper 95% bound of the median ratio (001 plan.md "Matched-condition comparisons").
  - Full scroll: start at F5 with the list at the top. The harness then sends Ctrl+End every 100 ms in both tools, until the root commit row shows.
  - Message filter: the GE toolbar message filter with Ignore case. It runs `--grep`, `--regexp-ignore-case`, `--all`, and `--parents` (`FilterInfo.GetRevisionFilter`, DeepWiki 2026-10-11). Use an ASCII-letter word, so that the regular-expression and literal matches are the same. Confirm GE's argv from the WPR process trace.

## Open items

- **O-1 SC-002 and Git memory.** Closed 2026-10-12 with choice (b) of T007. The user said: "no, we should not count git own memory, we can do nothing about it". SC-002 now holds the SI-1 candidate text below. The user decided only the process scope: both SC-002 bounds count the Arbareto processes and exclude Git's child processes. The record keeps the Git peaks, without a bound. The base (the same worktree with a one-commit history) is a reviewer default (spec Assumptions), not a user decision.
  - Background: the design recalls that `builtin/rev-list.c` sets `save_commit_buffer` for `--grep` (unverified). Without a commit-graph, the limited walk then keeps every commit buffer.
  - P0.4 result (T006, research.md R14, experiment): on H1M with Git 2.56.0.windows.1, the median peak private bytes of the walking Git process are 166.4 MiB (topology) and 446.5 MiB (search) without a commit-graph, and 145.9 MiB (topology) and 148.2 MiB (search) with one. Five runs vary by at most 0.1 MiB. Each command alone is above 128 MiB.
  - Candidate text (design SI-1, adopted 2026-10-12 into spec.md SC-002): "The view adds at most 128 MiB of private memory to the Arbareto processes: the shell, the service, and the WebView2 processes. The base is the same worktree with a one-commit history. The record states the peak private memory of each Git process next to the peak of the same Git command run alone."
  - Constitution note N-2 applies, and it is closed. Principle VII needs no amendment.
- **O-2 SC-002 first-screen, SC-006, and SC-010 values.** The spec proposes 16 MiB for the SC-002 first screen and 10% or 500 ms for SC-006. The spec proposes 1 s to stop and 5 s to no remaining process for SC-010. The plan confirms them before measurement (spec Assumptions).
- **O-3 Unverified facts.** Research R13 lists them, with the step that checks each one.
- **O-4 Load during a search.** Closed. The service loads to the end itself when a search starts on an incomplete view (D5, contract Δ3 `searchHistory`, data-model §6). The renderer starts nothing extra.
- **O-5 Limited rows after a wide region.** Closed in batch 0. The 001 lane rules never move a lane. So one open lane at index 24 or above kept each later row limited until that lane ended. On H200K, 2,173 rows were limited, but only 93 needed more than 24 lanes; 2,080 had 9 to 24 open lanes. In octopus-65, 67 of 68 rows were limited. Rule now: a limited row draws no edge, so its output lane array drops the free slots and keeps the lane order. A new lane takes the lowest free slot, so a row is limited exactly when it needs more than 24 lanes (data-model.md §4). T005 asserts this both ways. H200K now has 93 limited rows, and octopus-65 has 43 (research.md R16). Each limited row still states the limit, and the lane count never shrinks (FR-016).

## Phases

### Batches (D10)

| Batch | Steps | Content |
|---|---|---|
| 0 | P0.1 to P0.5 | Fixtures and the Git facts. Results go into research.md. |
| 1 | P1, P2, P4, and the `readRefs` part of P3 | Pure algorithms, contracts, the shell, and `readRefs`. |
| 2 | P3 | Service view. |
| 3 | P5 | Search. |
| 4 | P6, P7 | Frontend, and the retirement of 001 `readHistory`. |
| 5 | P8 | Packaged qualification. |

### Work packages, in run order

| WP | Agent | Files | Steps |
|---|---|---|---|
| WP0 | implementer | `specs/002-full-history/{plan.md, research.md, data-model.md, contracts/operations.md, quickstart.md}` | This plan. Run `/speckit-tasks` and `/speckit-analyze` after it. |
| WP1 | implementer-xhigh | `tests/git/history-fixtures.ts`, `tests/git/history-order.test.ts`, `tests/git/history-search-facts.test.ts`, `src/contracts/matching-probe.ts`, `tests/wsl/history-wsl.test.ts` (P0.2 and P0.5 facts) | P0.1, P0.2, P0.5 |
| WP2 | implementer | `tests/windows/history-git-memory.test.ts` | P0.4, and the T061 first-step record. Local Windows run. |
| WP3 | implementer-xhigh | `src/git-service/history-{topology,layout,reduced}.ts`, `src/contracts/filter-text.ts`, their tests | P0.3, P1 |
| WP4 | implementer | `src/contracts/{limits,envelope,errors,operations,channel}.ts`, `git-environment.json`, `wsl-process.json`, `schemas/`, `tests/vectors/`, `src/git-service/{commands,refs-parser,refs}.ts` (`readRefs` only) | P2 |
| WP5 | implementer | `src-tauri/src/{ipc,git_env,wsl,service}.rs`, `src-tauri/build.rs`, `src/frontend/bridge.ts` (the five calls), `tests/contracts/bridge.test.ts` | P4. Local only. |
| WP6 | implementer-xhigh | `src/git-service/{commands,refs-parser,refs,history-view,session}.ts`, view tests | P3 |
| WP7 | implementer-xhigh | `src/git-service/history-search.ts`, `history-view.ts`, `session.ts`, `git-runner.ts`, `tests/git/bun-runner.ts`, `tests/git/service-harness.ts`, search tests | P5 |
| WP8 | frontend-implementer (loads arbareto-ux and vercel-react-best-practices) | `src/frontend/{state/history-view.ts, history/*, app/Workbench.tsx, NoticeBand.tsx, refs/ReferencesSidebar.tsx}`, `tests/contracts/history-*.test.tsx`, `tests/contracts/references-sidebar.test.tsx` | P6 |
| WP9 | implementer | Retire `readHistory` | P7 |
| WP10 | implementer, with the runs done by scout | `tests/windows/history-perf.test.ts`, the Git Extensions harness, the view and search cases of `tests/wsl/history-wsl.test.ts` | P8 |

These packages are not file-disjoint:
- WP4 edits `commands.ts`, `refs-parser.ts`, and `refs.ts` for `readRefs` in batch 1. WP6 edits them later in batch 2.
- WP5 adds the five calls to `bridge.ts`. WP8 uses them and runs later.
- WP4 (T027) adds `refsDigest` to the `readRefs` literals in `tests/contracts/history-view.test.tsx`, `references-sidebar.test.tsx`, and `renderer-freshness.test.ts`. WP8 edits the first two later.
- WP7 changes `session.ts` and `history-view.ts`. It runs strictly after WP6.
- WP9 edits files of WP4, WP5, and WP6. It runs strictly after those three.

## Complexity Tracking

No Constitution Check violation. The table stays empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
