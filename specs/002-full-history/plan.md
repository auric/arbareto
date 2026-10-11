# Implementation Plan: Full History and Commit Message Filter

**Branch**: `f002-spec` (feature `002-full-history`) | **Date**: 2026-10-11 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-full-history/spec.md`

**Related**: [research.md](research.md) | [data-model.md](data-model.md) | [contracts/operations.md](contracts/operations.md) | [quickstart.md](quickstart.md)

## Summary

The full history uses one `rev-list` stream per view, read to the end at full speed. The service holds the compact topology and the lane layout. The renderer draws only the visible rows. The message filter is one `rev-list --grep` stream that merges into the view as a subsequence. The service builds the filter-mode reduced graph itself. The design needs no new shell flow-control frame, no Web Worker, and no new dependency.

Three facts drive the choices (research R2, R8):
- The shell has no per-call output flow control, and the service handles each frame before it reads the next. A paused stream would stall the service pipe for every operation.
- Without a commit-graph, Git walks the whole graph before the first row and holds that memory. A drained stream lets Git exit.
- The installed list virtualizer rebuilds O(n) arrays on every count change and has no fix for the maximum element height. The history list uses fixed-height row arithmetic. ChangesPane keeps `@tanstack/react-virtual`.

One spec target is at risk: SC-002 counts Git's own processes. Git alone can use more than 128 MiB during a search on 1,000,000 commits (unverified estimate). Open item O-1 handles it.

## Technical Context

**Language/Version**: The 001 versions stay: TypeScript `7.0.2`, Bun `1.4.2` (exact), Rust/Cargo `1.98.0` (001 plan.md "Technical Context").

**Primary Dependencies**: No new dependency. React `19.3.0`, zod `4.6.5`, Tauri `2.12.0` as in 001. `@tanstack/react-virtual` stays for ChangesPane only (research R8).

**Storage**: None new. All view, search, and cache data lives in the service session or renderer memory. The application writes no repository data (spec FR-044).

**Testing**: Bun tests in real disposable repositories (`tests/git`), contract tests and golden vectors (`tests/contracts`, `tests/vectors`), Windows packaged tests (`tests/windows`), WSL tests (`tests/wsl`), and cargo tests for the shell allowlist, the policy, and the wrapper mode.

**Target Platform**: Windows 11 x64 first, with Git for Windows. WSL2 repositories through the distro Git. The order facts are recorded on Git 2.56.0.windows.1 and WSL Ubuntu-26.04 Git 2.55.

**Project Type**: Local-first desktop application: Tauri 2 shell, compiled Bun Git service, React renderer.

**Performance Goals**: Spec SC-005, SC-006, SC-011, and SC-014. SC-011 uses the 001 statistic: the upper 95% bound of the median ratio (001 plan.md "Matched-condition comparisons").

**Constraints**: SC-002 128 MiB over the complete process tree (O-1). No renderer work grows with the history size. Every Git process has a deadline and its own Job. Read-only Git with `--no-optional-locks` and `--no-lazy-fetch`.

**Scale/Scope**: Fixtures of 200,000 and 1,000,000 commits. One view per service session. At most 4,000,000 commits per view, 10,000 refs, 64 parents per commit, 24 lanes per row, and 1,024 UTF-8 bytes of filter text. Memory grows with histories above 1,000,000 commits (spec Assumptions).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Checked against `.specify/memory/constitution.md` version 2.0.0, before research and again after Phase 1.

| Principle | How the design meets it | Status |
|---|---|---|
| I. Preserve user data | Read-only Git commands with `--no-optional-locks`. The app writes no commit-graph and only shows the remedy. The probe writes only a temp repository outside every user repository. SC-013 checks byte identity. The selected Git runs everything. | Pass |
| II. TypeScript/Bun | All logic is in TypeScript. The Rust changes are data and enums. | Pass |
| III. Validated boundaries | Five typed operations with zod and the strict decoder. The renderer sends only IDs, numbers, and validated text. Every record is bounded. A view holds at most 4,000,000 commits and each line at most 65 OIDs, so every stream is bounded (note N-1). Each operation has its own Job for cancel. | Pass |
| IV. Real Git verification | Real fixtures. Failure, cancel, and external-change cases: ref moves, shallow, replace, missing objects. | Pass |
| V. Untrusted repositories | No repository program runs. `rev-list` and `cat-file` run without filters. The trust gate runs at open. Text shows as plain text. The search text enters no log. | Pass |
| VI. Platform evidence | Packaged Windows evidence. WSL stays unverified until the distro runs. | Pass |
| VII. Accessible and measured | Keyboard: Ctrl+F, Enter, Escape, F3 and Shift+F3, End. Marks do not depend on color. Budgets are fixed before measurement. See notes N-2, N-3, and N-5. | Pass, with notes N-2, N-3, and N-5 |
| VIII. Locked dependencies | No new dependency. | Pass |
| IX. One planning process | All artifacts stay in `specs/002-full-history`. The 002 contract lists only deltas and cites 001 sections. | Pass |

Notes from the second check:
- **N-1 (III, "Operations MUST bound output")**: Closed. A view holds at most 4,000,000 commits (`HISTORY_VIEW_COMMITS`, contract Δ5). At that bound, the load ends `limited` with `OUTPUT_LIMIT`. The loaded rows stay, and the view states the limit. Each line holds at most 65 OIDs, and the service keeps no raw bytes beyond one partial line. The search stream lists only commits of the view, so the same bound covers it. The bound is a reviewer default (spec Assumptions).
- **N-2 (VII, "complete process-tree memory")**: The SI-1 candidate text in O-1 takes Git out of the budget. The measurement still records each Git process. So the measurement stays complete, but the budget changes. The user decides this in O-1.
- **N-3 (VII, "CPU")**: P8 records the CPU time of each process in the tree, from the WPR CPU trace of each workload run, with Git processes apart.
- **N-4 (Delivery Gates)**: The plan defines safety tests (SC-013, SC-010), trust boundaries (Δ7), accessibility checks (FR-031, FR-040, SC-014), performance budgets (SC-002, SC-006, SC-011, SC-014), and the platform qualification (P8, WSL).
- **N-5 (VII, "cold/warm timings")**: P8 records cold and warm runs for SC-005, SC-006, and SC-014, by the 001 rules.

No violation, so Complexity Tracking stays empty. Three items carry ponytail ceilings:
- the compact OID table;
- the fixed-height window;
- the 4,000,000-commit view bound, about 192 MB of service memory at 48 bytes per commit (unverified). A larger bound needs a measured memory design.

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
                            # history/HistoryView.tsx, AncestryCell.tsx, CommitDetails.tsx, lanes.ts (P7 retires it)
                            # new: state/history-view.ts, history/HistoryFilter.tsx
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
| P0.2 Git order facts | new `tests/git/history-order.test.ts` | None. Records Git behavior that Git does not document. | Two runs of the view argv give the same bytes. `--skip=k` equals the suffix, for k in {1, 255, 256, 257, rows inside merges, last}. `--date-order` is equal with and without a commit-graph. The stdin order of the start points decides ties between equal dates (experiment, Git 2.56.0.windows.1), so the start points go in ascending lowercase hex. `--grep` equals the full order with the non-matches removed. Windows Git 2.56.0 and WSL Ubuntu-26.04 Git 2.55. | A fact fails. The design still holds, because runtime checks refuse with `HISTORY_CHANGED`. Record the result in research.md. |
| P0.3 Layout equivalence | new `src/git-service/history-layout.ts`: `layoutStep(lanes,row)`, checkpoints, `cellsOf(range)`, moved from `src/frontend/history/lanes.ts:50-120`. New `tests/git/history-layout.test.ts`. | The layout becomes a step function that carries state. | On every graph fixture and H200K: rows fed in random chunk sizes, then cells rebuilt from checkpoints, equal one fold over all rows, cell by cell. Every node-to-bottom segment ends in the lane of the matching Git parent. | The proof from the code is untested. This test is that proof. |
| P0.4 Git memory record | new `tests/windows/history-git-memory.test.ts` (Windows; `GetProcessMemoryInfo` through `bun:ffi` in this file, because 001 T165 has not created `inject.ts` yet) | None. | Peak private bytes of the topology `rev-list` and the search `rev-list --grep`, on H1M with and without a commit-graph. | It decides O-1 before the budget work starts. |
| P0.5 Matching facts | new `src/contracts/matching-probe.ts` (the fixed fast-import stream and the expected OIDs). Test in `tests/git/history-search-facts.test.ts`. | None. | The FR-023 and FR-024 cases on Windows Git and each WSL distro. Also checks that `init --template=` copies nothing and that an explicit `--git-dir` gets no ownership refusal. | A distro without the C.UTF-8 locale or without PCRE2. |
| P1 Pure algorithms | new `src/git-service/history-topology.ts` (OID table, CSR parents, line parser, order checks), new `src/git-service/history-reduced.ts`, new `src/contracts/filter-text.ts` | Algorithms only. | Topology checks: a duplicate row, a parent that already showed, a non-empty frontier at the end. Reduced graph against a brute-force BFS oracle on the small fixtures and H200K. Filter-text refusals. | Memory per commit. Mitigation: typed arrays, no JS `Map` of OID strings. |
| P2 Contracts | `src/contracts/{limits.ts, envelope.ts, errors.ts, operations.ts, git-environment.json, channel.ts, wsl-process.json}`, `schemas/`, `tests/vectors/` | Adds 5 operations, 3 codes, the `search` policy, the WSL mode `search`, and the `matchingProbe` script. | Schema tests and golden vectors in Bun and Rust. | Rust typify drops ranges. Keep explicit checks, as 001 §1 requires. |
| P3 Service view | `src/git-service/commands.ts` (argv builders), `refs-parser.ts` (kinds `stash`, `replace`; `refsDigest`), `refs.ts` (`refs/stash`), new `history-view.ts`, `session.ts` (handlers). Reuses `captureHead`, `sharedListing`, and `checkFailedRead` from `history.ts:255-397`. | `openHistory`, `loadHistory`, `readHistoryRows`, `closeHistory`. | SC-001, SC-003, SC-004, and SC-015 on the small fixtures and H200K (H1M in the full run). Load cancel and resume. The `HISTORY_VIEW_COMMITS` bound with a lowered test bound. The stale cases. The trust gate. `REPOSITORY_CHANGED`. SC-013 byte identity. | Service CPU while it drains 1M rows (about 1,350 frames of 64 KiB, unverified). |
| P4 Shell | `src-tauri/src/ipc.rs` and `src-tauri/build.rs` (5 commands), `git_env.rs` (policy `search`), `wsl.rs` (mode `search`, `matchingProbe`) | Data and enum changes only. No new frame. | cargo tests for the allowlist, the policy, and the wrapper mode. | Local only. Rust work stays off cloud sessions. |
| P5 Search | new `src/git-service/history-search.ts` (search, probe, merge, reduced settlement). `session.ts` gets one handler. | `searchHistory`. | SC-007 (Windows and each distro), SC-008, SC-009 (no Git process starts), SC-010 search cancel, the order-mismatch refusal. | The subsequence order is only an experiment fact. The runtime check refuses on a mismatch. |
| P6 Frontend | `src/frontend/bridge.ts`, new `state/history-view.ts`, `history/HistoryView.tsx`, new `history/HistoryFilter.tsx`, `history/AncestryCell.tsx`, `history/CommitDetails.tsx`, `app/Workbench.tsx`, `NoticeBand.tsx` | A virtual list, the filter, the two modes, the notices, the scope switch, the details pane. | Component tests: keyboard, refusals, notices, stable rows after eviction (FR-011), a fake count of 1M rows with no O(n) structure. | Compressed scrolling at the 1M scale. |
| P7 Retire 001 `readHistory` | `operations.ts`, `envelope.ts` (`ReadHistory`), `history.ts` (`readHistory`, `pageOf`), `session.ts`, `ipc.rs`, `src/frontend/history/lanes.ts`, their tests | One history path only. | The full run stays green. | 001 evidence names `readHistory`. Keep the 001 artifacts as records. |
| P8 Qualification | `tests/windows/history-perf.test.ts`, responsiveness workloads, the Git Extensions harness, `tests/wsl/history-wsl.test.ts` | None. | SC-002, SC-005, SC-006, SC-010, SC-011, SC-012, SC-014 in the packaged build. CPU for each workload (N-3). Cold and warm runs for SC-005, SC-006, and SC-014, by the 001 rules (001 plan.md "Measurements and budgets"). | Git memory (O-1). The filter ratio is close to 1.0. Open 001 tools and the measurement environment (001 T154, T165, T180, T240, T242, T244). |

Each phase writes its tests first. P0.2, P0.3, and P0.4 are the riskiest proofs and run first.

### D1 Contracts

[contracts/operations.md](contracts/operations.md) holds the deltas. They extend 001 §3, §5, and §9, with no fork. Summary:
- `openHistory {scope}` captures HEAD, the FR-047 refs, and the shallow and grafts digests. It returns a `viewId`. One live view per service session.
- `loadHistory {viewId}` drains `rev-list --parents --date-order --stdin`. A resume adds `--skip=<N-1>` and checks the overlap row. At 4,000,000 rows, the load ends `limited` with `OUTPUT_LIMIT` reason `HISTORY_VIEW_COMMITS`, and the rows stay.
- `readHistoryRows` serves scroll pages, navigation, and details. It returns cells, labels, match marks, and optional text.
- `searchHistory {viewId, text}` runs the literal, case-folding search under the `search` policy and merges the matches.
- `closeHistory {viewId}` frees the view.
- `readRefs` adds `refs/stash` and `refsDigest`.
- A ref change gives a notice, never a stale view. Contract Δ8 lists the stale conditions.
- New codes: `HISTORY_CHANGED`, `UNSUPPORTED_FILTER_TEXT`, `SEARCH_UNSUPPORTED`.

### D2 Service process model

- The load streams as fast as Git and the service run. Each frame is parsed into the topology arrays, then the layout step and the reduced-graph step run. About 1-3 µs per row, so about 2 ms per 64 KiB frame (unverified). Other requests wait at most one frame.
- At most 3 history processes run per view: the load, the search, and the text read. They take no read slot.
- Each operation has its own Job. `cancel` closes that Job.
- After a service restart, no view resumes. The renderer marks the view stale. Refresh opens a new one.
- New: the `search` policy, the WSL wrapper mode `search`, the matching probe, and the process bound outside the read slots. No new channel frame.
- Left out: a per-call output credit frame. Add it when a qualified fixture beyond about 2M commits must stay within the budget.

### D3 Exact page rule

- Rows are addressed by their position in the one stream of a view. A streamed row never changes.
- The cell of row i is `layoutStep(state_i, row_i)`. `state_i` is rebuilt from the checkpoint at ⌊i/256⌋·256. The function is pure, so a rebuilt cell equals the first one.
- The state holds the output lane array and the lane count. It holds no set of sent OIDs, because `--date-order` sends no parent before its children (git-rev-list(1)). The topology table checks duplicate rows and repeated parents (data-model §3, T012).
- Text is read again by OID. Commit objects never change.
- In a complete stream, every parent is a later row. So the 001 "outside page" branch never runs (`lanes.ts:52-55, 84-102`).
- Merges and multiple tips need no special rule. Git's single stream already orders them.
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

The reduced graph needs the full topology stream beside the search stream, because the paths pass through commits that do not match. Git rewrites parents only under path simplification (revision.c:4077-4096). Filter rows show text before they are settled, with a null cell until then. The reduced layout reuses `layoutStep` with checkpoints. A skip edge draws its node-to-bottom segment with the dashed style, and its accessible text says it skips commits. A match without a matching ancestor shows "No earlier matching commit", unless it is a true root or a shallow boundary.

### D5 Search and highlight mode

- Refusals before any Git process: text that is not well-formed, text above 1,024 UTF-8 bytes, and text with U+000A, U+000D, U+0000, or U+005C followed by U+0045. The reason names the character (SC-009). The renderer runs the same `filter-text.ts` checks first.
- Command and policy: contract Δ3 `searchHistory`. The fingerprint check runs first. `--fixed-strings` overrides `grep.patternType` (unverified). The `-c` value comes after an inherited `GIT_CONFIG_PARAMETERS`, so it wins (unverified).
- Matching probe: contract Δ3 "Matching probe". It runs before the search, not beside it. Hold its output in parallel only if SC-006 misses.
- Merge into the view and the known match state: contract Δ3 and data-model §6.
- Load during a search: when a search starts on an incomplete view, the service resumes the load itself, because filter mode needs the full topology stream (D4). That load belongs to the search operation, so its progress and Cancel go with the search. The renderer starts nothing extra. A view at the `HISTORY_VIEW_COMMITS` bound gets a `limited` search result, and no Git process starts.
- Next and Previous use `readHistoryRows at:{match}`. The streamed matches have rising row indices, so a binary search finds the target. When the target is not loaded yet, the request waits on the load or search progress, with Cancel.
- Progress: phase `history-search`, counters `matches` and `settled`. The final count comes in the terminal response (FR-039). A shallow view adds the "searched only the commits that the clone holds" sentence.

### D6 Frontend

- **List**: a fixed-height window. The scroll height is `min(total·rowHeight, MAX_LAYOUT_PX)`. The window reads `maxScrollTop = scrollHeight − clientHeight` from the list element. The virtual offset is `virtualTop = scrollTop · (total·rowHeight − clientHeight) / maxScrollTop`. When `scrollHeight = total·rowHeight`, `virtualTop = scrollTop` exactly. When `maxScrollTop ≤ 0`, `virtualTop = 0`. The first row is `floor(virtualTop / rowHeight)`. Row i is drawn at `scrollTop + i·rowHeight − virtualTop`. So row 0 is at the top at scrollTop 0, and the last row ends at the viewport bottom at `maxScrollTop`. A row that must show (End, keyboard selection) gets a target `virtualTop` by this rule. A row above the viewport aligns to the viewport top. A row below the viewport aligns to the viewport bottom. A visible row does not move. The window then sets `scrollTop = virtualTop · maxScrollTop / (total·rowHeight − clientHeight)`. `MAX_LAYOUT_PX` is Chromium's LayoutUnit maximum, about 33,554,431 px (unverified in WebView2). 1M rows at the comfortable density need about 34M px, which passes it. Research R8 records why `@tanstack/react-virtual` does not fit.
- **Shortcuts**: Ctrl+F focuses the filter. F3 and Shift+F3 move to the next and the previous match. The 001 map (001 plan.md "Keyboard and focus", `src/frontend/keyboard/shortcuts.ts`) uses none of these keys. The 001 accelerator handler turns off the WebView2 find keys, so Ctrl+F and F3 reach the page. T038 records conflicts with the 001 keyboard map before T040. These keys are reviewer defaults, not user decisions.
- **Listbox**: focus stays on the list element with `aria-activedescendant`. Options carry `aria-posinset`. `aria-setsize` is -1 until the count is known (WAI-ARIA 1.2).
- **Cache**: pages of 128 rows in LRU order up to 8 MiB of `bytes`. The visible pages always stay. Row reads follow the latest-wins rule, one in flight per view.
- **Graph column**: its width is the `lanes` value, at most 24. It never shrinks during a view (FR-016).
- **Labels**: they come from the rows, so the 001 chip-pairing rule goes.
- **Working directory line**: the dotted lead-in shows only when HEAD is row 0.
- **Memory**: the renderer holds O(visible + cache) only. The service holds about 48 bytes per commit for SHA-1, 60 for SHA-256 (unverified). That is about 48 MB at 1M commits.

### D7 Responsiveness

- No renderer work grows with the history size. Layout, parsing, merging, and settlement run in the service, in tasks of one frame each. No Web Worker.
- Measurement reuses the 001 method: WPR Verbose long tasks, DXGI capture, and `inject.ts` probe inputs every 100 ms.
- Additions: a poll of `IsHungAppWindow` every 100 ms. Windows reports a window as not responding after 5 seconds without message processing (Win32 documentation). Whether it covers the Tauri main window is unverified.
- Workloads on H1M without a commit-graph, the slow-Git case: open, End, scrollbar drag, wheel scroll, search, mode switch, scope switch, Cancel, and Refresh after a ref move.
- The 001 History-ready frame drops "Up to 100 commits". The plan redefines it as visible rows with text and cells. The count can still load.

### D8 WSL

- The same operations run through the wrapper. `search` is a new wrapper mode that adds `LC_ALL=C.UTF-8`, because no Windows variable reaches Linux.
- Each text read costs one `wsl.exe` start, about 250 ms (unverified). A long-lived `cat-file` is left out. Add it when WSL misses SC-014.
- Verify in each distro: the matching probe, the P0.2 order facts with that Git version, the `wsl.exe` relay throughput for the 1M drain, the text latency, and Linux memory through the scope `memory.peak`. Without the last one, SC-002 stays unverified there.

### D9 Tests and fixtures

- Fixtures: P0.1, built at test time and cached.
- Oracles:
  - SC-001: the view rows equal one uninterrupted `rev-list --date-order --parents` run. The commit set equals `git log --branches --remotes --tags refs/stash HEAD`.
  - SC-004: the P0.3 equivalence.
  - SC-008: the BFS oracle and `rev-list --grep`.
  - SC-015: the ref fixture.
- RAM: SC-002 sums private bytes over the process tree, sampled every 100 ms, with Git processes recorded apart. The base follows SC-002 until O-1 is decided.
- Git Extensions (SC-011): matched work, with the maintained commit-graph variant and the 001 ABBA and run rules. The gate is the upper 95% bound of the median ratio (001 plan.md "Matched-condition comparisons").
  - Full scroll: start at F5 with the list at the top. The harness then sends Ctrl+End every 100 ms in both tools, until the root commit row shows.
  - Message filter: the GE toolbar message filter with Ignore case. It runs `--grep`, `--regexp-ignore-case`, `--all`, and `--parents` (`FilterInfo.GetRevisionFilter`, DeepWiki 2026-10-11). Use an ASCII-letter word, so that the regular-expression and literal matches are the same. Confirm GE's argv from the WPR process trace.

## Open items

- **O-1 SC-002 and Git memory.** The user confirmed 128 MiB for the complete process tree. SC-002 stays unchanged. The P0.4 measurement of Git's own peak memory comes first. The user then decides whether Git's processes stay inside the budget.
  - Background: the design recalls that `builtin/rev-list.c` sets `save_commit_buffer` for `--grep` (unverified). Without a commit-graph, the limited walk then keeps every commit buffer. The estimate is 100-300 MB for Git alone at 1M commits (unverified).
  - Candidate text (design SI-1, not adopted): "The view adds at most 128 MiB of private memory to the Arbareto processes: the shell, the service, and the WebView2 processes. The base is the same worktree with a one-commit history. The record states the peak private memory of each Git process next to the peak of the same Git command run alone."
  - Constitution note N-2 applies to the candidate.
- **O-2 SC-006 and SC-010 values.** The spec proposes 10% or 500 ms for SC-006. The spec proposes 1 s to stop and 5 s to no remaining process for SC-010. The plan confirms them before measurement (spec Assumptions).
- **O-3 Unverified facts.** Research R13 lists them, with the step that checks each one.
- **O-4 Load during a search.** Closed. The service resumes the load itself when a search starts on an incomplete view (D5, contract Δ3 `searchHistory`, data-model §6). The renderer starts nothing extra.
- **O-5 Limited rows after a wide region.** Open for P6. The 001 lane rules never move a lane. So one open lane beyond lane 24 keeps each row limited until that lane ends. In the octopus-65 fixture, 67 of 68 rows are limited (T005). P6 decides whether the layout compacts lanes or keeps this rule.

## Phases

### Batches (D10)

| Batch | Steps | Content |
|---|---|---|
| 0 | P0.1 to P0.5 | Fixtures and the Git facts. Results go into research.md. |
| 1 | P1, P2 | Pure algorithms and contracts. |
| 2 | P3, P4 | Service view and shell. |
| 3 | P5 | Search. |
| 4 | P6, P7 | Frontend, and the retirement of 001 `readHistory`. |
| 5 | P8 | Packaged qualification. |

### Work packages, in run order

| WP | Agent | Files | Steps |
|---|---|---|---|
| WP0 | implementer | `specs/002-full-history/{plan.md, research.md, data-model.md, contracts/operations.md, quickstart.md}` | This plan. Run `/speckit-tasks` and `/speckit-analyze` after it. |
| WP1 | implementer-xhigh | `tests/git/history-fixtures.ts`, `tests/git/history-order.test.ts`, `tests/git/history-search-facts.test.ts`, `src/contracts/matching-probe.ts`, `tests/wsl/history-wsl.test.ts` (P0.2 and P0.5 facts) | P0.1, P0.2, P0.5 |
| WP2 | implementer | `tests/windows/history-git-memory.test.ts` | P0.4. Local Windows run. |
| WP3 | implementer-xhigh | `src/git-service/history-{topology,layout,reduced}.ts`, `src/contracts/filter-text.ts`, their tests | P0.3, P1 |
| WP4 | implementer | `src/contracts/{limits,envelope,errors,operations,channel}.ts`, `git-environment.json`, `wsl-process.json`, `schemas/`, `tests/vectors/` | P2 |
| WP5 | implementer | `src-tauri/src/{ipc,git_env,wsl}.rs`, `src-tauri/build.rs` | P4. Local only. |
| WP6 | implementer-xhigh | `src/git-service/{commands,refs-parser,refs,history-view,session}.ts`, view tests | P3 |
| WP7 | implementer-xhigh | `src/git-service/history-search.ts`, search tests | P5 |
| WP8 | frontend-implementer (loads arbareto-ux and vercel-react-best-practices) | `src/frontend/{bridge.ts, state/history-view.ts, history/*, app/Workbench.tsx, NoticeBand.tsx}`, `tests/contracts/history-*.test.tsx` | P6 |
| WP9 | implementer | Retire `readHistory` | P7 |
| WP10 | implementer, with the runs done by scout | `tests/windows/history-perf.test.ts`, the Git Extensions harness, the view and search cases of `tests/wsl/history-wsl.test.ts` | P8 |

Two packages are not file-disjoint:
- WP7 adds one `searchHistory` handler line to `session.ts`. It runs strictly after WP6.
- WP9 edits files of WP4, WP5, and WP6. It runs strictly after those three.

## Complexity Tracking

No Constitution Check violation. The table stays empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
