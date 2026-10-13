---

description: "Task list for the Full History and Commit Message Filter feature"
---

# Tasks: Full History and Commit Message Filter

**Input**: Design documents from `specs/002-full-history/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/operations.md, quickstart.md, and checklists/requirements.md.

**Tests**: The spec (SC-001 to SC-015) and plan.md "Steps" require tests. Each step writes its tests first (plan.md "Steps (riskiest proof first)"). A failing-test task comes before each implementation task, or the task names its failing case first. No test passes by default.

**Organization**: Phases follow the six batches of plan.md D10: (0) research proofs P0.1 to P0.5, (1) pure algorithms and contracts P1 and P2, (2) service view and shell P3 and P4, (3) search P5, (4) frontend and the retirement of 001 `readHistory` P6 and P7, (5) packaged qualification P8. Story phases carry `[USn]` labels. Batch 0, batch 1, and the cross-cutting qualification tasks carry no label.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: The task touches different files from the other `[P]` tasks in its group and depends on no incomplete task. A `[P]` group starts after all tasks above it finish. A sub-heading starts a new group.
- **Exception (O-1 and O-2)**: T051 waits for a user decision. T007 recorded the O-1 decision on 2026-10-12. No task waits for them, except the tasks that name them in "Depends on".
- **Blocked by 001 (user environment)**: 001 T154, T165, T180, T240, T242, and T244 are open. They wait for the user's measurement environment. T052 follows the T154 procedure. T055 needs T165, T240, and T242. T056 needs T244. T057 needs T180, and T180 needs T165. Batch 5 cannot finish before them.
- **[Story]**: The user story from spec.md (US1 to US3).
- **Local tags**: `Local: Rust` needs the local Rust toolchain. `Local: Windows` needs the Windows reference host. `Local: package` needs the packaged Windows build. `Local: WSL` needs the `Ubuntu-26.04` distro with Git 2.55. `Local: GE` needs the Git Extensions harness. Cloud sessions do not run these tasks (CLAUDE.md "Tool boundaries"). A batch verification that sets `ARBARETO_WSL_DISTRO` or runs `test:windows` carries the matching tag. A skip never counts as a pass.
- Each task names its files, its spec IDs, its plan step (P0.1 to P8), and its dependencies.

## Path Conventions

- Paths follow plan.md "Project Structure": `src/contracts/`, `src/git-service/`, `src/frontend/`, `src-tauri/src/`, `tests/contracts/`, `tests/git/`, `tests/vectors/`, `tests/windows/`, and `tests/wsl/`.
- Feature evidence goes only into `specs/002-full-history/research.md`, as R14 and later (research.md "Results").

## Test harness rules

- The 001 "Test harness rules" stay in force (`specs/001-desktop-qualification/tasks.md`). They cover `printOrigin`, the control mutation, Git discovery through `tests/git/git-binary.ts`, capability skips, `tests/groups.json`, `OBSERVATION` lines, owned fixture roots, and the source headers.
- A file that builds or reads H1M goes into the `serial` group of `tests/groups.json`, with the reason "builds or reads H1M". A file that builds or reads H200K, and no H1M, goes into `serial` with the reason "builds or reads H200K". A file that measures time also goes into `serial`.
- H1M serves only the memory and responsiveness records: T006, T061, T054, and T055 with its SC-001 End case (spec Assumptions). Correctness, timings, and the Git Extensions comparison use H200K. The H1M cases of T001 and T003 stay as opt-in records (research.md R15, R16).
- Every fixture test records the repository bytes before and after the run with the T002 digest helper. They must be equal, and no commit-graph file may appear (SC-013, FR-044).
- A fact test (P0.2, P0.5) has no implementation. A failed fact is a finding, not a red task. The test prints `OBSERVATION <task ID>: <fact>`, and the batch verification copies it into research.md with its mark (documented, experiment, or unverified).
- Tests never start a Git maintenance command and never write a commit-graph into a user repository. Only the fixture builder writes the commit-graph variants, in the owned cache.
- App runs set `ARBARETO_PROFILE_ROOT` to a scratch folder.
- A task is ticked only after a green full run (`bun run test:all`) on Windows that verifies it, with `ORIGIN` lines in the checkout under test. A `tests/windows` task is ticked only after a green `bun run test:windows` on the reference host.
- Batch verification tasks use only the README "Development" commands. A task that needs another command adds it to README "Development" only after it runs green (CLAUDE.md "Tool boundaries").

## Batch-to-story mapping

| Batch | Phase | Plan steps | Tasks | Stories | Scope |
| --- | --- | --- | --- | --- | --- |
| 0. Research proofs | 1 | P0.1 to P0.5 | T001–T011 | Setup | Fixtures, Git order facts, layout equivalence, Git memory record and O-1, matching facts. |
| 1. Pure algorithms and contracts | 2 | P1, P2, P4, and the `readRefs` part of P3 | T012–T020, T025, T027, T029 | Foundational | Topology table, reduced graph, filter-text refusals, five operations, codes, limits, policies, vectors, the five-command shell allowlist and bridge calls, the policy and WSL mode `search`, `readRefs` `refsDigest`. |
| 2. Service view | 3 | P3 | T021–T024, T026, T028, T030, T061 | US1 | `openHistory`, `loadHistory` with load steps, `readHistoryRows`, `closeHistory`, ref capture, stale rules, the Git first-step record. |
| 3. Search | 4 | P5 | T031–T037, T063 | US2, US3 | `searchHistory`, matching probe, merge, reduced settlement, match navigation. |
| 4. Frontend and retirement | 5 | P6, P7 | T038–T050, T062 | US1, US2, US3 | Virtual list with the load trigger, filter, modes, notices, scope switch, details, the virtual references sidebar, retirement of `readHistory`. |
| 5. Packaged qualification | 6 | P8 | T051–T060 | Cross-cutting | SC-002, SC-005, SC-006, SC-010, SC-011, SC-012, SC-014, WSL. Blocked by open 001 T154, T165, T180, T240, T242, T244. |

Work packages (plan.md "Work packages"): WP1 is T001 to T004, T008, and T010. WP2 is T006 and T061. WP3 is T005, T009, T012 to T014, T016, T017, and T019. WP4 is T015, T018, and T027. WP5 is T025 and T029. WP6 is T021 to T024, T026, and T028. WP7 is T031 to T036. WP8 is T038 to T047 and T062. WP9 is T048 and T049. WP10 is T052 to T058. WP11 is T063.

---

## Phase 1: Research proofs (Batch 0, P0.1 to P0.5)

**Purpose**: Build the fixtures and record the Git facts that the design rests on. Results go into research.md.

### Fixture builder (P0.1)

- [ ] T001 Write the failing self-check `tests/git/history-fixtures.test.ts` for `tests/git/history-fixtures.ts` (P0.1). For each small fixture, assert the commit count, the ref list, and the parent count of each commit with `git rev-list --parents` and `git for-each-ref`. For H200K and H1M, assert 200,000 and 1,000,000 commits, the `hasCommitGraph` state of each variant, and the cached `semanticDigest` of each variant. The two variants are two builds of one stream, so compare their refs, index entries, and working files. The `semanticDigest` covers the commit-graph state, so it differs between the variants. A small H3K case makes two builds of one variant and asserts equal digests. Assert that the digest helper gives equal values for an unchanged repository and different values after one `update-ref`. Add the file to `tests/groups.json` `serial` with the reason "builds or reads H1M". Spec: SC-001, SC-003, SC-004, SC-005, SC-013, SC-015. No dependency.
- [ ] T002 Create `tests/git/history-fixtures.ts` (P0.1). Reuse `fiCommit` (`tests/git/fixtures.ts:1222`; plan.md cites 1204-1235, and the function moved). Reuse `acquireLock` (:284), `PERF_CACHE_ROOT` (:15), `hasCommitGraph` (:123), `semanticDigest` (:129), and `builderDigest` (:118) from `tests/windows/perf-fixtures.ts`. Follow the lock and temporary-folder steps of `ensurePerfFixture` (:324). Build these small fixtures through `fast-import`: equal dates, clock skew, criss-cross, an octopus with 10 parents, an octopus with 65 parents (FR-003 exception), a merges-only segment, 50 tips, a shallow clone, tag chains, tags to a tree and a blob, the stash with 2 reflog entries, a notes ref, `refs/pull/1/head`, an unborn branch beside other refs, an empty repository, a detached HEAD, a symbolic remote HEAD ref, a message with a body above 16 KiB and the match word after that bound (FR-019), and a set of 10,001 refs (FR-047 bound). Build H200K and H1M with merges, parallel lines, equal-date runs, skew, Ukrainian, ß, ẞ, and SS messages, and windows-1251 messages with an `encoding` header. Build each large fixture with and without a commit-graph, in the existing cache. Export a digest helper over every file of the repository and its Git folder (SC-013). Make T001 pass. Spec: FR-003, FR-019, FR-047, SC-001, SC-003, SC-004, SC-005, SC-013, SC-015. Depends on T001.

### Fact tests and failing proofs (P0.2 to P0.5)

- [ ] T003 [P] Write the fact test `tests/git/history-order.test.ts` (P0.2). On the small fixtures, H200K, and H1M, with and without a commit-graph, run `rev-list --parents --date-order --stdin` with the start points in ascending lowercase hex. Record these facts: two runs give the same bytes; `--skip=k` equals the suffix for k in {1, 255, 256, 257, a row inside a merge run, the last row}; the output is equal with and without a commit-graph; whether a shuffled or a reversed stdin order gives the same bytes as the ascending order (R15: not on equal-dates, so the start points stay in ascending lowercase hex); `rev-list --grep` with the same start points equals the full order with the non-matches removed; whether `hash-object -t commit -w` accepts a commit object with a repeated `parent` line, and whether `rev-list --parents` then prints that parent twice (data-model §3). Print the Git version. Expect Git 2.56.0.windows.2, and record another version as an observation. Report each fact for research.md. Add the file to `tests/groups.json` `serial`. Spec: FR-004, FR-021, SC-003. Depends on T002.
- [x] T004 [P] Write the failing test `tests/git/history-search-facts.test.ts` for `src/contracts/matching-probe.ts` (P0.5). Import the fixed fast-import stream and the expected OID sets. In a `mkdtemp` folder under the owned fixture root (`tests/git/fixture-root.ts`), run `init --bare --template= --object-format=sha1`, `fast-import`, and the contract Δ3 search argv with `-c i18n.logOutputEncoding=UTF-8` and `LC_ALL=C.UTF-8`. Assert the FR-023 and FR-024 cases: "Виправлення" in lower and upper case, є/Є, і/І, ї/Ї, ґ/Ґ, ß against ẞ (match) and SS (no match), and the windows-1251 message. Also record these R4 and R13 facts: `init --template=` copies nothing into the folder; an explicit `--git-dir` gets no ownership refusal; `--fixed-strings` overrides a `grep.patternType=perl` in the owned global configuration; the `-c` value wins over an inherited `GIT_CONFIG_PARAMETERS`. Assert that `fs.rm` removes the folder. The product probe still uses a `mkdtemp` folder in `os.tmpdir()` (contract Δ3 "Matching probe", plan.md D5). Add the file to `tests/groups.json` `parallel`. Spec: FR-023, FR-024, SC-007. No dependency.
- [x] T005 [P] Write the failing test `tests/git/history-layout.test.ts` for `src/git-service/history-layout.ts` (P0.3). On every graph fixture and on H200K, feed the rows in random chunk sizes with a fixed seed. Rebuild cells from the checkpoints at ⌊i/256⌋·256 with `cellsOf(range)`. Assert that each cell equals one fold of `layoutStep` over all rows, cell by cell. Assert that every node-to-bottom segment ends in the lane of the matching Git parent. Assert that a row is `limited` exactly when it needs more than 24 lanes, and that a limited row keeps its parent identities (FR-016). Assert distinct root and shallow-boundary marks (FR-015). Add the file to `tests/groups.json` `serial`, with the reason "builds or reads H200K". Spec: FR-011, FR-014, FR-015, FR-016, SC-004. Depends on T002.
- [ ] T006 [P] Write `tests/windows/history-git-memory.test.ts` (P0.4). `Local: Windows`. Call `GetProcessMemoryInfo` through `bun:ffi` in this file. `tests/windows/inject.ts` does not exist yet (001 T165 creates it), so import nothing from it. Sample `PeakPagefileUsage` (peak private bytes) of each Git process every 100 ms. Measure the topology `rev-list --parents --date-order --stdin` and the search `rev-list --date-order --fixed-strings --regexp-ignore-case --grep=<word> --stdin` on H1M, with and without a commit-graph. Run each command five times and report each peak and the median for research.md. Do not add the file to `tests/groups.json`. Spec: SC-002, FR-043. Depends on T002.

### Item O-1 (SC-002 and Git memory, closed 2026-10-12)

- [x] T007 Record the T006 numbers in research.md as R14 "Git peak memory", and in plan.md open item O-1. Then ask the user to decide whether Git's own processes stay inside the 128 MiB budget of SC-002. Present two choices. (a) Keep SC-002 unchanged. (b) Adopt the SI-1 candidate text of plan.md O-1, with constitution note N-2. Do not decide for the user. Record the decision in plan.md O-1 and data-model.md §9 "Base". When the decision changes SC-002, change spec.md SC-002 and run `/speckit-analyze`. This task blocks T054 and every SC-002 budget change. Spec: SC-002, FR-043. Plan: O-1, P0.4. Depends on T006. Decision (2026-10-12): choice (b). The user said: "no, we should not count git own memory, we can do nothing about it". SC-002 bounds only the Arbareto processes and records the Git peaks without a bound.

### Proof implementations (P0.3, P0.5)

- [x] T008 [P] Create `src/contracts/matching-probe.ts` (P0.5). It holds the fixed fast-import stream and the expected match and non-match OID sets as contract values (contract Δ3 "Matching probe"). It starts no process. Make T004 pass. Spec: FR-023, FR-024, SC-007. Depends on T004.
- [x] T009 [P] Create `src/git-service/history-layout.ts` (P0.3). Move the lane logic of `layoutHistory` (`src/frontend/history/lanes.ts:50-120`) into a pure `layoutStep(state, row) → {cell, state}`. The state carries the output lane array and the lane count (research.md R3). The topology table checks duplicate rows and parents that already showed as rows. The step uses the distinct parents, in the order of first occurrence, and `merge` is true only for two or more distinct parents (data-model §3, §4). Store a checkpoint every 256 rows, and export `cellsOf(range)`. A row is limited exactly when it needs more than 24 lanes. A limited row draws no edge, and its output lane array drops the free slots and keeps the lane order (plan.md O-5). A new lane takes the lowest free slot. Keep the lane count monotonic. Leave `lanes.ts` unchanged; T049 retires it. Make T005 pass. Spec: FR-011, FR-014, FR-015, FR-016, SC-004. Depends on T005.
- [x] T010 Write `tests/wsl/history-wsl.test.ts` with the P0.2 and P0.5 facts in the distro (P0.2, P0.5). `Local: WSL`. Find the distro through `tests/wsl/wsl-host.ts`. The Windows builder makes each fixture. A `tar` stream on stdin copies it into the owned distro folder, not through `/mnt`. Each H200K variant gets its own sub-folder. Run the T003 order facts with the distro Git, and run the T008 probe stream with `LC_ALL=C.UTF-8`. Report each fact and the distro Git version for research.md. A missing C.UTF-8 locale or a probe mismatch is a finding. Add the file to `tests/groups.json` `serial`. Spec: FR-046, SC-007. Depends on T002 and T008.

### Batch 0 verification

- [ ] T011 Run the batch 0 verification: `bun install --frozen-lockfile`, `bun run typecheck`, `bun run test:all` with `ARBARETO_WSL_DISTRO=Ubuntu-26.04` and `ARBARETO_HISTORY_FIXTURES=H200K`, then `bun run build:service` and `bun run test:windows`. With `ARBARETO_HISTORY_FIXTURES=H200K`, the T001 and T003 H1M cases skip. T001 and T003 also ran once on H1M (research.md R15, R16). T006 and the batch 5 packaged records run H1M. `Local: Windows`. `Local: WSL`. Pass condition: every command exits 0 with `ORIGIN` lines under this checkout. Copy every batch 0 `OBSERVATION` line into research.md R14 and later, each with its mark. A failed order fact keeps the design, because the runtime checks refuse with `HISTORY_CHANGED` (plan.md P0.2). Control mutation: in `cellsOf` of `src/git-service/history-layout.ts`, replace `this.checkpoints[first]!` with `EMPTY_STATE`, and keep the loop start. `tests/git/history-layout.test.ts` must fail. Undo the edit and rerun green. After the run is green, add `ARBARETO_HISTORY_FIXTURES` to README "Development". It names the large fixtures that a run may build, such as `H200K,H1M`. The task passes only after one independent review of batch 0 is recorded in research.md. Spec: all batch 0 IDs of T001 to T010. Depends on T001 to T006 and T008 to T010.

**Checkpoint**: research.md holds the order facts, the layout proof, the Git memory record, and the matching facts. The user decided O-1 on 2026-10-12.

---

## Phase 2: Pure algorithms, contracts, and shell (Batch 1, P1, P2, P4, and the readRefs part of P3)

**Purpose**: Algorithms and contracts that every story uses.

**CRITICAL**: No story work starts before this phase is complete.

### Tests (write first; they must fail)

- [x] T012 [P] Write failing tests in `tests/git/history-topology.test.ts` for `src/git-service/history-topology.ts` (P1). Parse `rev-list --parents` lines for SHA-1 and SHA-256 across random frame splits. The parser keeps at most one partial line. A duplicate row, a parent that already showed as a row, and a parent still pending at exit 0 each give `MALFORMED_GIT_OUTPUT` (data-model §3). A parent that repeats inside one line is accepted: the table keeps the parent list as Git prints it, and the layout gives one edge for it. A row with one parent printed twice has `merge` false. A stream that ends at a simulated stop row with pending parents gives no error, and the next step continues with them. A line with more than 1 + 64 OIDs gives `OUTPUT_LIMIT` reason `HISTORY_PARENTS_PER_COMMIT`. Use the 65-parent fixture. Assert that the table uses typed arrays and no JS `Map` of OID strings. Report the bytes per commit on H200K for research.md (for SHA-1 about 46 when the typed arrays are nearly full, about 80 to 90 just after a doubling, unverified). Add the file to `tests/groups.json` `serial` with the reason "builds or reads H200K". Spec: FR-003, FR-004, FR-045. Depends on T011.
- [x] T013 [P] Write failing tests in `tests/git/history-reduced.test.ts` for `src/git-service/history-reduced.ts` (P1). On the small fixtures and H200K, pick seeded random match sets. Compare each edge set with a brute-force BFS oracle over the FR-033 definition: a nearest matching ancestor has no other match on some parent path between the two. Assert `direct` true only when the matching row is a parent. Assert the settled-prefix rule of plan.md D4. Assert the "No earlier matching commit" state, except for a true root or a shallow boundary. Add the file to `tests/groups.json` `serial` with the reason "builds or reads H200K". Spec: FR-033, FR-034, SC-008. Depends on T011.
- [x] T014 [P] Write failing tests in `tests/contracts/filter-text.test.ts` for `src/contracts/filter-text.ts` (P1). Refusals, each with its reason and the found character: text that is not well-formed (a lone surrogate) and text above 1,024 UTF-8 bytes give `length`; U+000A and U+000D give `line-break`; U+0000 gives `nul`; U+005C followed by U+0045 gives `quote-end`. U+005C followed by U+0065 passes. Text with a leading "-", quotes, and pattern characters passes unchanged. Leading and trailing spaces stay. Exactly 1,024 bytes passes. Empty text means no filter. Text with U+000A before U+0000 gives `line-break`. Text above 1,024 bytes that holds U+0000 gives `nul`. A refusal at the byte bound has `found` null. `quote-end` has `found` `\E`. Each other refusal has the refused character as `found`. Spec: FR-022, FR-026, FR-027, FR-028, SC-009. Depends on T011.
- [x] T015 [P] Write failing contract tests in `tests/contracts/history-contract.test.ts`, `tests/contracts/envelope.test.ts`, and `tests/contracts/vectors.test.ts`, with golden vectors in `tests/vectors/` (P2). Cover the five operations of contract Δ3. `openHistory` takes `{scope: "all" | "current"}` and carries `repositoryGeneration`. `loadHistory` takes `{viewId, need}`, and `need` is `{row}` (0 to 4,000,000), `{oid}`, or `{end: true}`. `searchHistory` takes `{viewId, text}`, and `closeHistory` takes `{viewId}`. The `loadHistory` result carries `rows` and `complete`. `readHistoryRows` takes `{viewId, mode, searchId?, at, count, text}`. `mode: "filter"` requires `searchId`. `count` is 1 to 512. `text: "details"` requires `count` 1. `at` is `{row}`, `{oid}`, `{match: "next" | "previous", from}`, or `{end: true}`. The `readHistoryRows` result carries `rowCount`. The `readHistoryRows` result carries `target`, and only `target: "found"` carries `rows`. A `line` segment may carry `skip: true`. A view operation without its result value carries `{reason?, remedy?}`, and `remedy` is `{text, command}`. The `loadHistory` result carries `reason` and `remedy` beside `rows` and `complete`. Unknown fields give `INVALID_REQUEST`. Cover the result shapes, the codes `HISTORY_CHANGED`, `UNSUPPORTED_FILTER_TEXT`, and `SEARCH_UNSUPPORTED` with their reasons, and the `OUTPUT_LIMIT` reasons `HISTORY_PARENTS_PER_COMMIT` and `HISTORY_VIEW_COMMITS`. Cover each contract Δ5 limit value. The `search` policy in `src/contracts/git-environment.json` equals `read` plus `LC_ALL=C.UTF-8`. `src/contracts/wsl-process.json` holds the mode `search` and the fixed script `matchingProbe`. `readRefs` adds `refsDigest` and `RefEntry.kind` `stash`. Spec: FR-003, FR-026, FR-045, FR-047. Contract: Δ1 to Δ3, Δ5, Δ7, Δ9 to Δ11. Depends on T011.

### Implementation

- [x] T016 [P] Create `src/git-service/history-topology.ts` (P1): the OID table with hash slots, `idToRow` and `rowToId`, CSR parents, the line parser, and the order checks. Make T012 pass. Spec: FR-003, FR-004, FR-045. Depends on T012.
- [x] T017 [P] Create `src/contracts/filter-text.ts` (P1) with the contract Δ3 refusals. The service and the renderer import the same module. Make T014 pass. Spec: FR-022, FR-026, FR-027, FR-028, SC-009. Depends on T014.
- [x] T018 [P] Implement the contract changes (P2) in `src/contracts/limits.ts`, `envelope.ts`, `errors.ts`, `operations.ts`, `channel.ts`, `git-environment.json`, and `wsl-process.json`. Add every contract Δ5 bound as a named constant with its exact value. Keep the names `HISTORY_VIEW_COMMITS` (4,000,000), `HISTORY_PARENTS_PER_COMMIT` (64), and `HISTORY_LOAD_MARGIN` (1,024). Keep `GRAPH_PATH_SEGMENTS` and `readHistory` until T049. Run `bun run export:schemas` to update `src/contracts/schemas/`. Make T015 pass. Spec: FR-003, FR-026, FR-045, FR-047. Depends on T015.
- [x] T019 Create `src/git-service/history-reduced.ts` (P1) by plan.md D4. `P` maps each unprocessed referenced row to a shared, never-changed sorted array of match sequence numbers. Edges take 8 bytes each. Mark the O(k²) union case with a `ponytail:` comment that names the mergeable heap as the upgrade path. Make T013 pass. Spec: FR-033, FR-034, SC-008. Depends on T013 and T016.

### Shell and readRefs (P4, and the readRefs part of P3)

- [x] T025 [P] Write failing cargo unit tests in `src-tauri/src/ipc.rs`, `src-tauri/src/git_env.rs`, and `src-tauri/src/wsl.rs` (P4). `Local: Rust`. The allowlist holds the five commands. The shell reads only `operation` and `requestId` of the five bodies and forwards each body unchanged (001 contract §1 steps 4, 5, and 7). A `readHistoryRows` body with `count` 513 and a `searchHistory` body with 1,025 UTF-8 bytes of text reach the service byte for byte. The policy `search` adds `LC_ALL=C.UTF-8` to `read`. The WSL mode `search` adds `LC_ALL=C.UTF-8`, and the fixed script `matchingProbe` exists. The T018 golden vectors decode in Rust. A cargo guard case in `src-tauri/src/ipc.rs`: a later `succeeded` response of a forwarded `loadHistory` reaches the renderer by its `requestId`. T055 owns the check after a process `cancel` closes the Job. The case guards present behavior (`ipc.rs` `deliver` routes by `requestId` only) and may pass before T029. Record its first result in research.md R13. The failing-first rule does not apply to it. Spec: FR-024, FR-026, FR-046. Contract: Δ1, Δ7, Δ10, Δ11. Depends on T018.
- [x] T027 [P] Extend `refsArgs` in `src/git-service/commands.ts`, `src/git-service/refs-parser.ts`, and `src/git-service/refs.ts` for contract Δ3 `readRefs` (P3). First write the failing cases. In `tests/contracts/git-commands.test.ts`, `refsArgs` ends with `refs/heads`, `refs/remotes`, `refs/tags`, `refs/stash`. In `tests/git/refs.test.ts`, `readRefs` gives `kind: "stash"` for `refs/stash`, skips a record under `refs/stash/`, and returns `refsDigest`: the SHA-256 over `refname NUL objectname LF` of each record, in Git's output order. Then add the kind `stash`, the `refs/stash` pattern, the skip, and `refsDigest`. Add `refsDigest` to the `readRefs` result literals in `tests/contracts/history-view.test.tsx`, `tests/contracts/references-sidebar.test.tsx`, and `tests/contracts/renderer-freshness.test.ts`. `bun run typecheck` exits 0. Spec: FR-047, SC-015. Depends on T018.
- [x] T029 Implement the shell changes (P4) in `src-tauri/src/ipc.rs`, `src-tauri/build.rs`, `src-tauri/src/git_env.rs` (policy `search`), and `src-tauri/src/wsl.rs` (mode `search`, and a cargo case that the `matchingProbe` text exists in `src/contracts/wsl-process.json`). `Local: Rust`. Register the five commands in `AppManifest::commands`, and commit the generated permission files. Grant the five permissions in `src-tauri/capabilities/main.json`. Add no new frame. Add the five calls to `src/frontend/bridge.ts`, and add their entries to `SAMPLE_CALLS` in `tests/contracts/bridge.test.ts`. Make T025 and the three failing `tests/contracts/bridge.test.ts` cases pass. After `cargo test --locked --manifest-path src-tauri/Cargo.toml` runs green, add it to README "Development". Note: T029 delivers no shell route that runs `matchingProbe`. That route moves to a new task (contract "Contract gaps", WSL search). Spec: FR-024, FR-026, FR-046. Depends on T018 and T025.

### Batch 1 verification

- [x] T020 Run the batch 1 verification: `bun run typecheck`, `bun run export:schemas --check`, `cargo check --locked --manifest-path src-tauri/Cargo.toml`, the T029 `cargo test` command, and `bun run test:all`. `Local: Rust`. Pass condition: every command exits 0 with `ORIGIN` lines under this checkout. Copy the T012 bytes-per-commit record into research.md. Control mutation: let `src/contracts/filter-text.ts` accept U+005C followed by U+0045. `tests/contracts/filter-text.test.ts` must fail. Undo the edit and rerun green. The task passes only after one independent review of batch 1 is recorded in research.md. Spec: all batch 1 IDs of T012 to T019, T025, T027, and T029. Depends on T012 to T019, T025, T027, and T029.

**Checkpoint**: The algorithms, the contract, the five-command shell, and the five bridge calls exist. The service answers the five operations with `SERVICE_UNAVAILABLE`. `readRefs` returns `refsDigest` and `kind: "stash"`.

---

## Phase 3: User Story 1 - Scroll to every commit, service part (Batch 2, P3) (Priority: P1)

**Goal**: The service opens a view on a captured ref set, loads one history order in steps, and serves rows, cells, labels, and text.

**Independent Test**: Open views on the small fixtures and H200K. Compare every row and cell with one uninterrupted `rev-list --date-order --parents` run and one full layout.

### Tests for User Story 1, service part (write first; they must fail)

- [x] T021 [P] [US1] Write failing argv tests in `tests/contracts/git-commands.test.ts` (P3). Assert the exact arrays for the capture (`symbolic-ref -q HEAD`, `rev-parse --verify -q HEAD`, `show-ref --exists`, the `for-each-ref` eight-field format over `refs/heads refs/remotes refs/tags refs/stash refs/replace`, and `rev-parse --git-path shallow --git-path info/grafts`). Assert the load argv, which is the same for the first and every later step and carries no `--skip`, and the `cat-file --batch-command -Z` text read. Every argv starts with `--no-lazy-fetch --no-optional-locks`. Spec: FR-045, FR-051. Contract: Δ3. Depends on T020.
- [x] T022 [P] [US1] Write failing tests in `tests/git/history-view.test.ts` for `openHistory`, `loadHistory`, `readHistoryRows`, and `closeHistory` through `openService` of `tests/git/service-harness.ts` (P3). Each test file wraps it in a local `withService`. SC-001 on H200K: loads until `complete` give rows that equal one uninterrupted `rev-list --date-order --parents` run of the same start points, and the commit set equals `git log --branches --remotes --tags refs/stash HEAD`. SC-003: no row changes position across reads. SC-004: each cell equals the T009 fold. FR-010: `complete` and the final count. FR-054 and the plan.md D2 stop rule on H200K: `need: {row: 40}` ends with 2,089 rows and `complete: false`. No process of the load remains after its result; count the runner processes. The next `need: {row: 1065}` ends with 4,178 rows. Its argv equals the first argv with no `--skip`, and its first 2,089 streamed rows equal the held rows. `need: {oid}` of row 50,000 ends with 52,049 rows. `need: {oid}` of a commit that the refs do not reach loads to the end, and `at: {oid}` gives `target: "none"`. `need: {end: true}` loads to the end. FR-011: a reread gives the same commit, text, and cell. FR-017 and FR-018: `text: "rows"` holds no body; `text: "details"` holds the body up to 16 KiB, cut at a character boundary with `bodyCut`. `text: "none"` starts no Git process. A result stays within `HISTORY_PAGE_BYTES` and sets `cut`. Cover `target: "unknown"` and `target: "none"`, one live view, the release of the old view by a new `openHistory` (`UNKNOWN_TARGET`), `closeHistory`, an empty repository with `startCount` 0, an unborn branch beside other refs, and a detached HEAD. The 65-parent fixture ends the load `limited` with `HISTORY_PARENTS_PER_COMMIT`. View bound: add the test-only seam `historyViewCommits` to `ServiceSeams` and to the session options of `openService` in `tests/git/service-harness.ts`, like the existing `readDeadlineMs` seam (`SessionOptions` in `src/git-service/session.ts`, used in `tests/git/read-lifecycle.test.ts`). Set it to 1,000 on H200K. The load ends `limited` with `OUTPUT_LIMIT` reason `HISTORY_VIEW_COMMITS`, the rows stay, and a later `loadHistory` gives the same result without a Git process. Add the file to `tests/groups.json` `serial`. Spec: FR-001, FR-003, FR-004, FR-009, FR-010, FR-011, FR-014, FR-017, FR-018, FR-054, SC-001, SC-003, SC-004, SC-013. Depends on T020.
- [x] T023 [P] [US1] Write failing tests in `tests/git/history-refs.test.ts` for the ref capture and labels (P3). On the ref fixtures, assert SC-015: the all-branches view holds exactly Git's commits for the FR-047 set, each label sits on Git's commit for its ref, a tag chain labels its end commit, and a tag to a tree or a blob adds no row and no label. The notes ref, `refs/pull/1/head`, and the older stash entries add no row. A symbolic remote HEAD ref adds no label. Several refs on one commit give one row with all labels. The checkout row is marked, also for a detached HEAD. The current-branch view holds exactly `git rev-list HEAD` and shows the FR-047 labels. The 10,001-ref fixture gives `OUTPUT_LIMIT` reason `REF_LISTING_RECORDS`. A scope switch opens a new view with a new ref set. Report for research.md whether the pattern `refs/stash` matches `refs/stash/x`, and whether `%(objectname)` of a symbolic ref gives the target OID (R13). Add the file to `tests/groups.json` `parallel`. Spec: FR-001, FR-047, FR-048, FR-049, FR-050, SC-015. Depends on T020.
- [x] T024 [P] [US1] Write failing tests in `tests/git/history-stale.test.ts` for the contract Δ8 rules (P3). Cancel the load at each chunk boundary on H200K and resume. The joined rows equal one uninterrupted run (plan.md D3). A load that ends at its stop row gives `succeeded`, not `GIT_FAILED`. The joined rows of all stop rows equal one uninterrupted run. A re-read row that differs from the held row at the same index, in OID or parents, gives `HISTORY_CHANGED` reason `order`. Cover a difference at row 0, inside the held rows, and at the last held row. Make each difference with real Git. Before open, create a replace ref that changes the parents of the commit at the target row. Load to a stop row. Set `core.useReplaceRefs false` in the repository config, then load again. The topology fingerprint stays equal, and the load gives `HISTORY_CHANGED` reason `order`. Test the Git exit 0 before row N in this task on a synthetic stream fed to the re-read compare, because fixed start points cannot produce it in a real repository. A change of the shallow file, the grafts file, or a replace ref gives `HISTORY_CHANGED` reason `topology` before the next view process. A missing commit in a partial clone gives `OBJECT_MISSING`. A damaged store gives `REPOSITORY_UNAVAILABLE`. A stale view keeps its rows and refuses loads. Cancel and `DEADLINE` leave the view `idle`, not stale. `DEADLINE` carries the 001 remedy `& '<selected Git path>' --no-lazy-fetch -C '<worktree root>' commit-graph write --reachable`, with the selected Git path, from the T262 builder (001 plan.md "Commit-graph variants"). The service never runs it. A ref move or a HEAD move changes no view state. A later generation with the same refs and commits keeps the view (FR-002). A stale generation gives `REPOSITORY_CHANGED`. No captured data leaves before the trust gate passes. A second `loadHistory` while one runs gives `BUSY`. A load cancel stops within 1 s, and no process of it remains after 5 s. Each run leaves the repository bytes unchanged and writes no commit-graph. A configured unreachable remote causes no network process (FR-051). Add the file to `tests/groups.json` `serial`, because it measures the cancel time. Spec: FR-002, FR-005, FR-006, FR-007, FR-044, FR-045, FR-051, FR-054, SC-010, SC-012, SC-013. Depends on T020.
- [ ] T061 [P] [US1] Extend `tests/windows/history-git-memory.test.ts` with the plan.md D2 first-step record (P0.4). `Local: Windows`. Keep the T006 cases unchanged. For the topology `rev-list --parents --date-order --stdin` on H1M, with and without a commit-graph, record the peak private bytes of the walking Git process up to line S₀ of the first load step, 2,089 for n = 40 (plan.md D2). Then end the process as the service does. Record the time from the start to the first output line, and to output line N for N in {2,089, 500,000, 1,000,000}, with no `--skip`, as the re-read cost of a later step at 1,000,000 commits. Run each case five times, and report each value and the median for research.md. This is a record, not a gate. It does not block T030. Tick it after a green `bun run test:windows`. Spec: SC-002, FR-043, FR-054. Depends on T020.

### Implementation for User Story 1, service part

- [x] T026 [US1] Add the argv builders to `src/git-service/commands.ts` (P3). Make T021 pass. Spec: FR-045, FR-051. Depends on T021.
- [x] T028 [US1] Create `src/git-service/history-view.ts` and add the four handlers to `src/git-service/session.ts` (P3). Reuse `captureHead` (`src/git-service/history.ts:255`), `sharedListing` (:283), and `checkFailedRead` (:381). Export `checkFailedRead` from `src/git-service/history.ts`. Add the parser kind `replace` to `src/git-service/refs-parser.ts` for the capture. Add the test-only option `historyViewCommits` to `SessionOptions` (`src/git-service/session.ts:56`), with the default `HISTORY_VIEW_COMMITS`, as `readDeadlineMs` does. Run each view process in its own Job with no read slot, except the one slot of `openHistory`. Apply the plan.md D2 stop rule with `HISTORY_LOAD_MARGIN`. Apply the plan.md D2 re-read rule: on a later step, compare each streamed row below the held row count with the held row at the same index, and append only the rows after them. At the stop row, wait for the fingerprint check of the load. Then send the process `cancel` of the call, wait for its `exit`, and ignore its exit code. A Git exit 0 before the stop row sets `complete`. Send progress phase `history-load` at most 4 times per second. In `src/git-service/history-topology.ts`, add the exact stop row `push(frame, stopRow)`: the parse stops after the row that reaches `stopRow`, applies the stop only after the re-read rows, and keeps the rest of the frame unparsed. Also add the numeric accessors `idOf` and `parentIdsOf` for `ReducedGraph.step`, and a public `intern` for the search merge. An interned OID is no pending parent. `readHistoryRows` with `at: {match}` and no `searchId` ends `rejected` with `INVALID_REQUEST` (contract Δ3). `children` has no Δ5 bound, because the plan gives none (contract "Contract gaps"). Make T022 to T024 pass. Spec: FR-001 to FR-011, FR-014, FR-017, FR-018, FR-044, FR-045, FR-048, FR-051, FR-054, SC-001, SC-003, SC-004, SC-010, SC-013, SC-015. Depends on T009, T016, T018, T022 to T024, T026, and T027.

### Batch 2 verification

- [ ] T030 [US1] Run the batch 2 verification: `bun install --frozen-lockfile`, `bun run build`, `bun run typecheck`, `bun run export:schemas --check`, `cargo check --locked --manifest-path src-tauri/Cargo.toml`, the T029 `cargo test` command, and `bun run test:all` with `ARBARETO_WSL_DISTRO=Ubuntu-26.04`. `Local: Rust`. `Local: WSL`. Pass condition: every command exits 0 with `ORIGIN` lines under this checkout. Copy the batch 2 records into research.md, also the CPU of an End load and the bytes per loaded commit on H200K (R13). Control mutation: in `src/git-service/history-topology.ts`, which holds the re-read compare, compare only the last held row and skip the compare of the earlier re-read rows. `tests/git/history-stale.test.ts` must fail. Undo the edit and rerun green. The task passes only after one independent review of batch 2 is recorded in research.md. Spec: all batch 2 IDs of T021 to T024, T026, and T028. Depends on T021 to T024, T026, and T028.

**Checkpoint**: The service serves full history through the five-command shell. The renderer still uses `readHistory`.

---

## Phase 4: User Stories 2 and 3 - Message search, service part (Batch 3, P5)

**Goal**: The service runs a literal, case-folding search, merges the matches into the view, settles the reduced graph, and resolves match navigation.

**Independent Test**: Search the matching and filter fixtures. Compare the matches, their order, the reduced edges, and the final count with Git and the BFS oracle.

WP7 runs strictly after WP6, because T035 adds the `searchHistory` handler and a test option to `src/git-service/session.ts` and changes `src/git-service/history-view.ts` (plan.md "Work packages").

### Tests for User Stories 2 and 3, service part (write first; they must fail)

- [ ] T031 [P] [US2] Write failing argv tests in `tests/contracts/git-commands.test.ts` for the search (P5). Assert the exact contract Δ3 array: `--no-lazy-fetch --no-optional-locks --literal-pathspecs -c i18n.logOutputEncoding=UTF-8 rev-list --date-order --fixed-strings --regexp-ignore-case --grep=<text> --stdin`. Text with a leading "-" stays inside the one `--grep=` argument. Spec: FR-022, FR-024. Depends on T030.
- [ ] T032 [P] [US2] Write failing tests in `tests/git/history-search.test.ts` for `searchHistory` and `readHistoryRows` mode `filter` (P5). SC-008: the matches equal `rev-list --grep` with the same start points, in full-history order. The reduced edges equal the T013 BFS oracle. In filter mode, each `line` segment of an edge with `direct` false carries `skip: true`, and other segments omit `skip`. A row has `cell: null` until it is settled. A match in the body after 16 KiB shows (FR-019). Each refused text of T014 gives its reason and starts no Git process; count the runner spawns (SC-009). A search on a view that holds only its first load step loads to the end inside the search operation. A `loadHistory` during it gives `BUSY`, and a `searchHistory` while a load runs gives `BUSY`. A search on a `limited` view ends `limited` with `HISTORY_VIEW_COMMITS` and starts no Git process (use `historyViewCommits`). A new search cancels the old one. A cancel stops within 1 s, no process remains after 5 s, and no count is final (SC-010). A broken match order fails the search with `HISTORY_CHANGED` reason `order`, and the view becomes stale. A shallow view states that the search covered only the commits of the clone. Progress uses phase `history-search` with `matches` and `settled`, and only the terminal response carries the final count. A canary search text reaches no log (contract Δ7). A `readHistoryRows` with the `operationId` of the accepted event as `searchId` gives filter rows while the search runs. After a new search, the old `searchId` gives `UNKNOWN_TARGET`. In filter mode, `at: {row: k}` gives match k, each row `index` is its match index, and `rowCount` stays the view row count (contract Δ3 reviewer default). Run the filter case on H200K, and add the file to `tests/groups.json` `serial`. Spec: FR-019, FR-020, FR-021, FR-030, FR-032, FR-033, FR-035, FR-039, FR-045, SC-008, SC-009, SC-010, SC-013. Depends on T030.
- [ ] T033 [P] [US2] Write failing tests in `tests/git/history-matching.test.ts` for the matching probe and the matching rules (P5). The probe runs once per `gitInstallationId` in a session, in a `mkdtemp` folder under `os.tmpdir()`, and removes it. It writes nothing inside the user repository. A probe mismatch gives `SEARCH_UNSUPPORTED` reason `matching` with a remedy, and no search starts. Inject the mismatch through the test-only seam `historyProbeRuns` in `SessionOptions` and `ServiceSeams`, as T022 does for the view bound. The SC-007 cases pass end to end through `searchHistory` on Windows. `Local: Windows` for the Windows end-to-end case. Elsewhere the case skips with an `OBSERVATION` line. The results stay equal under `LC_ALL` and `LANG` set to another locale, and under a user `i18n.logOutputEncoding=ISO-8859-1`, `grep.patternType=perl`, and an inherited `GIT_CONFIG_PARAMETERS`, all in the owned global configuration. Add the file to `tests/groups.json` `parallel`. Spec: FR-022, FR-023, FR-024, FR-025, SC-007. Depends on T030.
- [ ] T034 [P] [US3] Write failing tests in `tests/git/history-highlight.test.ts` for `readHistoryRows` with `at: {match}` in mode `full` (P5). Next and Previous reach every match of the filter fixtures in order. A target that is not loaded yet waits on the running load or search. At the first and the last match, the result is `target: "none"`, and the selection does not wrap. Each row carries `match` true, false, or null. `from` is inclusive: on a match row, `next` and `previous` with `from` equal to that row give that row (contract Δ3 reviewer default). The final count equals Git's count. Add the file to `tests/groups.json` `parallel`. Spec: FR-036, FR-037, FR-038, FR-039, SC-008. Depends on T030.

### Implementation for User Stories 2 and 3, service part

- [ ] T035 [US2] Create `src/git-service/history-search.ts`, add the search argv builder to `src/git-service/commands.ts`, and run the search on the view in `src/git-service/history-view.ts` (P5). In `src/git-service/session.ts`, add the `searchHistory` handler and the test-only option `historyProbeRuns`. Add `historyProbeRuns` to `ServiceSeams` and `openService` in `tests/git/service-harness.ts`. Allow the policy `search` in `EnvironmentPolicy` and `checkCall` of `src/git-service/git-runner.ts`, and the mode `search` in `WslMode` of `tests/git/bun-runner.ts` (contract Δ7). Run the T017 checks before any Git process. Run the fingerprint check, then the probe from `src/contracts/matching-probe.ts`, then the search under policy `search` with deadline 120,000 ms. Merge the matches by contract Δ3 "Merge into the view", with the FIFO of data-model §6. Feed the known match states to `history-reduced.ts`. Make T031 to T033 pass. Spec: FR-019 to FR-025, FR-030, FR-032, FR-033, FR-035, FR-039, SC-007, SC-008, SC-009, SC-010. Depends on T008, T017, T019, T028, and T031 to T033.
- [ ] T036 [US3] Add the `at: {match}` resolution and the `match` row flag to `src/git-service/history-search.ts` and `src/git-service/history-view.ts` (P5). Find the target by binary search over the rising match indices. Make T034 pass. Spec: FR-036, FR-037, FR-038, FR-039. Depends on T034 and T035.
- [ ] T063 [US2] Run the matching probe in WSL through the `run` field `script` (P4, P5). `Local: Rust`. `Local: WSL`. First write the failing cases. In `tests/contracts/history-contract.test.ts`, a `registeredOperation` `run` frame takes `script: "matchingProbe"`, and the schema refuses another value and the field in the other two context kinds. The `matchingProbe` `init` and `fast-import` lines start with `--no-lazy-fetch`. In `tests/contracts/git-commands.test.ts`, `probeScriptArgs` gives the folder, the tip, the run length, and the two exact Δ3 search arrays. It throws for runs of unequal length. In `tests/contracts/native-runner.test.ts`, a `script` call sends a frame that fits `ProcessRequest`. `checkCall` refuses each of these and sends nothing: another policy, a transaction, another context kind, a folder other than `/tmp/arbareto-probe-<uuid>`, a tip that is not 40 lowercase hex digits, a run length `0`, `01`, `+2`, or `a[$(id)]`, a wrong array length, and a run without `--no-lazy-fetch` first. In `tests/git/history-matching.test.ts`, a stub runner with a WSL workspace sees one `run` with `script`, policy `search`, and the fixed stream as input. The contract output gives `pass`, and output without one expected OID gives `mismatch`. An `end 1` line, a malformed line, a third run, and a nonzero exit give `failed`. In `src-tauri/src/wsl.rs`, `matching_probe_command` gives the wrapper array in mode `search` with `/bin/sh -c <matchingProbe text> sh <approved Git>` and the arguments. It refuses each broken argument of the `checkCall` list. In `src-tauri/src/process_requests.rs`, a WSL `script` run reaches the host as that command with its input bytes. Policy `read`, a transaction, a bad run length, and a Windows Git each give `INVALID_REQUEST` and start nothing. In `tests/wsl/history-wsl.test.ts`, use a distro repository with the probe commits. (a) The first search runs one `script` call, then the search. Each T033 SC-007 case matches exactly its probe commits. The probe folder does not exist after the call. The repository files do not change. A second search runs no probe. (b) A probe mismatch through `historyProbeRuns` gives `SEARCH_UNSUPPORTED` reason `matching` with a remedy, `command: null`, and no search process. The next search gives the same result without a probe. (c) Set the double option `wslLocalePath` to an empty owned folder. `LC_ALL=C.UTF-8 locale charmap` there prints `ANSI_X3.4-1968`. A search gives `SEARCH_UNSUPPORTED` reason `matching` with a remedy and no search process. (d) A text with a space, `"`, `\"`, `\`, `$`, `'`, and a backtick matches exactly the fast-import commit that holds it. Then implement: the field in `src/contracts/channel.ts`, and run `bun run export:schemas`. Add `--no-lazy-fetch` to the two lines in `src/contracts/wsl-process.json`. Add `Texts.matching_probe` and `matching_probe_command` to `src-tauri/src/wsl.rs`. Route `script` in `run` and `wsl_run_command` of `src-tauri/src/process_requests.rs`. Add `script` to `GitCall`, `checkCall`, and the `src/git-service/native-runner.ts` frame. Add `probeScriptArgs` to `src/git-service/commands.ts`. Add the WSL branch and the exact output parse to `probeMatching` in `src/git-service/history-search.ts`, and remove `WSL_MATCHING_REMEDY`. Remove the WSL refusal from `matching` in `src/git-service/history-view.ts`. In `tests/git/bun-runner.ts`, run a `script` call through the wrapper as the shell does, refuse it for a Windows Git, record `script`, and add `wslLocalePath`. `isProbe` in `tests/git/history-view-harness.ts` also matches a `script` call. `startSession` in `tests/wsl/fixtures.ts` takes `historyProbeRuns`. Control mutations: remove the run-length digit check from `matching_probe_command`, and the cargo refusal case must fail. Remove the `trap 'rm -rf -- "$dir"' EXIT` line from `matchingProbe`, and case (a) must fail. Undo each edit and rerun green. Spec: FR-023, FR-024, FR-025, FR-046, SC-007. Contract: Δ3 "Matching probe", Δ6, Δ10, Δ11. Depends on T035.

### Batch 3 verification

- [ ] T037 [US2] Run the batch 3 verification: `bun run typecheck` and `bun run test:all` with `ARBARETO_WSL_DISTRO=Ubuntu-26.04`. `Local: WSL`. Pass condition: both commands exit 0 with `ORIGIN` lines under this checkout. Copy the batch 3 records into research.md. Control mutation: remove `--regexp-ignore-case` from the search argv builder in `src/git-service/commands.ts`. `tests/git/history-matching.test.ts` must fail. Undo the edit and rerun green. The task passes only after one independent review of batch 3 is recorded in research.md. Spec: all batch 3 IDs of T031 to T036 and T063. Depends on T031 to T036 and T063.

**Checkpoint**: The service answers every 002 operation. The renderer does not use them yet.

---

## Phase 5: Frontend and retirement of 001 `readHistory` (Batch 4, P6 and P7)

**Goal**: The renderer shows the full history, the filter, both modes, the notices, the scope switch, and the details pane. One history path remains.

**Independent Test**: Drive the components with a fake count of 1,000,000 rows and the sidebar with 10,000 refs. Then run the full suite with `readHistory` removed.

WP8 runs as `frontend-implementer` and loads `arbareto-ux` and `vercel-react-best-practices` (plan.md "Work packages").

### Tests for the frontend (write first; they must fail)

- [x] T038 [P] [US1] Write failing component tests in `tests/contracts/history-list.test.tsx` (P6). Use a fake bridge with 1,000,000 and 4,000,000 rows. The window follows the plan.md D6 `virtualTop` mapping. Run every window case at the compact and the comfortable density (001 plan.md density table: 26 and 34 DIPs), with an 800 px `clientHeight`. For 1,000,000 and 4,000,000 rows at both densities, assert that row 0 is at the top at scrollTop 0, and that the last row's bottom equals the viewport bottom at `maxScrollTop`. For 1,000,000 rows at 26 DIPs, which is uncompressed, assert that row i is at `i·rowHeight` for any scrollTop. Assert that End shows the last row fully visible. The test stubs `clientHeight` and `scrollHeight` on the list element, because happy-dom has no layout. A short list (`maxScrollTop ≤ 0`) gives `virtualTop = 0`. The DOM row count and the held state stay bounded and equal for both counts. Focus stays on the list with `aria-activedescendant`. Options carry `aria-posinset`, and `aria-setsize` is -1 until the count is known. While the count is unknown, the scroll range holds the loaded rows and one more-rows row, and no estimate. The plan.md D6 trigger sends `loadHistory {need: {row: n}}` only when fewer than 1,024 loaded rows lie below n, the view is not complete, and no load or search runs. After a Cancel or a `DEADLINE`, no load starts until the more-rows row shows. A scrollbar drag to the bottom shows the more-rows row and starts a load. End and a search during a scroll load cancel it first and wait for its terminal response. When the count grows, the first visible row keeps its offset, for 1,000,000 and 4,000,000 rows at both densities. Pages of 128 rows stay in an LRU cache up to 8 MiB of `bytes`, the visible pages always stay, and one row read is in flight with the latest request winning. A row that comes back after eviction shows the same commit, text, and cell. The graph column never shrinks. A `limited` row states the limit, and its parents stay readable without color or pointer. Root and shallow marks differ by shape and text. Working directory and Index stay above the commits, and the dotted lead-in shows only when HEAD is row 0. End shows progress with Cancel, and Cancel keeps the rows and the selection. The view states that more rows exist until the count is final. Labels and the checkout mark come from the rows, and a detached HEAD shows as detached. Input stays live during a load. Record the R13 shortcut conflict check of the plan.md D6 keys (Ctrl+F, F3, Shift+F3, Ctrl+Shift+B) against the 001 keyboard map, before T040. Spec: FR-009, FR-010, FR-011, FR-012, FR-013, FR-015, FR-016, FR-050, FR-053, FR-054. Depends on T037.
- [x] T039 [P] [US1] Write failing component tests in `tests/contracts/history-notices.test.tsx` and `tests/contracts/workbench-mount.test.tsx` (P6). A newer `readRefs.refsDigest` or `readWorkspace.head` shows the "References changed" notice with Refresh, and the rows and labels stay. Refresh keeps the selected commit through `at: {oid}` with progress and Cancel. Without the commit, it selects the checkout commit, else the first commit row. Cancel of that load follows the FR-008 selection rule. A stale view keeps its rows and states its typed reason with Refresh. A service restart marks the view stale. The branch scope has no tabs and defaults to all branches (plan.md D6). The View menu checkbox "Current branch only" and Ctrl+Shift+B switch the scope. The branch context menu shows "Show only this branch's history" only on the current branch, and the item selects the current-branch scope. While the scope is the current branch, the history heading shows the removable chip "Current branch only ✕", and its removal selects all branches. Each switch opens a new view, keeps the selection, and runs the active filter again in the same mode. An empty repository shows the empty state. An unborn current branch shows the empty state in the current-branch view. The keyboard opens the branch context menu with Shift+F10 and the Menu key, and the item works from the keyboard. The chip remove control is a button with an accessible name, and Enter and Space remove it. Refresh and a scope switch with a selected commit send `loadHistory` with `need: {oid}`. With an active filter, the scope switch sends only `searchHistory`. Spec: FR-005, FR-006, FR-007, FR-008, FR-049, SC-012. Depends on T037.
- [x] T040 [US2] Write failing component tests in `tests/contracts/history-filter.test.tsx` (P6). Only Enter starts a search, and a pause starts none. The renderer runs `src/contracts/filter-text.ts` first, states the refused character, and sends no request. A changed text, a cleared text, Escape, and a repository close stop the search, and the full history returns with the selection kept. The filter has the accessible name and the plan.md D6 shortcut Ctrl+F, shown by the 001 rules. Filter mode shows only the matches, a skip edge has the dashed style and an accessible text, and no match gives "No commit message contains the text". An empty repository makes the filter unavailable with a reason. A shallow view states the searched scope. `SEARCH_UNSUPPORTED` shows its remedy. Spec: FR-025, FR-027, FR-028, FR-029, FR-030, FR-031, FR-032, FR-034, FR-035, SC-009. Depends on T037 and the T038 conflict record.
- [x] T041 [P] [US3] Write failing component tests in `tests/contracts/history-highlight.test.tsx` (P6). Highlight mode keeps the full graph, and each match row shows a mark that does not depend on color. F3 and Shift+F3 move across all matches, with accessible names. A target that is not loaded shows progress with Cancel. At the ends, the selection stays and the view states that no earlier or later match exists. The count states that more can follow until the search ends, and then states that it is final. A mode switch with unchanged text sends no new search. In filter mode, a non-matching selection moves to the next match, else to the last match. Spec: FR-036, FR-037, FR-038, FR-039, FR-040, FR-041, FR-042. Depends on T037.
- [x] T042 [P] [US1] Write failing tests in `tests/contracts/commit-details.test.tsx` (P6). The details pane reads the body only through `readHistoryRows` with `text: "details"` when it shows the commit, and it states a cut body. Spec: FR-017, FR-018. Depends on T037.

### Implementation for the frontend

- [x] T043 [US1] Create `src/frontend/state/history-view.ts` with the view, the page cache, and the search state (P6). It uses the T029 bridge calls. Spec: FR-012, FR-017, FR-053. Depends on T038 to T042.
- [x] T044 [US1] Create `src/frontend/history/HistoryList.tsx` as the fixed-height window of plan.md D6, with `virtualTopOf` and `scrollTopOf`, and mount it in `src/frontend/app/Workbench.tsx`. Draw service cells in `src/frontend/history/AncestryCell.tsx`. Read the details in `src/frontend/history/CommitDetails.tsx` (P6). Do not use `@tanstack/react-virtual` in the history list. ChangesPane and the references sidebar (T062) keep it. Make T038 and the details cases of T042 pass. Spec: FR-009 to FR-018, FR-050, FR-053. Depends on T043.
- [ ] T045 [US1] Add the branch scope controls of plan.md D6 (P6): the View menu checkbox "Current branch only" with Ctrl+Shift+B in `src/frontend/app/Workbench.tsx`, the item "Show only this branch's history" in the current-branch context menu of `src/frontend/refs/ReferencesSidebar.tsx`, and the chip "Current branch only ✕" in the history heading of `src/frontend/history/HistoryList.tsx`. Add no tabs. Create the branch context menu. The 001 sidebar has none. Match the approved mockup canvas named in plan.md D6. Add the "References changed" notice with Refresh to `src/frontend/app/NoticeBand.tsx`. Make T039 pass. Spec: FR-005, FR-008, FR-049. Depends on T044 and T062.
- [x] T046 [US2] Create `src/frontend/history/HistoryFilter.tsx`, and add filter mode to `src/frontend/history/HistoryList.tsx` and the skip edge style to `src/frontend/history/AncestryCell.tsx` (P6). Make T040 pass. Spec: FR-025, FR-027 to FR-035. Depends on T045.
- [x] T047 [US3] Add highlight mode, match navigation, and the count to `src/frontend/history/HistoryFilter.tsx` and `src/frontend/history/HistoryList.tsx` (P6). Make T041 pass. Spec: FR-036 to FR-042. Depends on T046.

### References sidebar

- [x] T062 [P] [US1] Make the references sidebar a virtual list (P6), test first. First write the failing cases in `tests/contracts/references-sidebar.test.tsx`. With 10,000 refs from a fake bridge, the DOM holds only the rows near the visible area, and the element count is equal for 1,000 and 10,000 refs. Stub `clientHeight` as T038 does, because happy-dom has no layout. Each `treeitem` carries `aria-level`, `aria-posinset`, and `aria-setsize`. ArrowDown, ArrowUp, Home, End, and ArrowLeft to a parent reach rows outside the window, and the focused row then exists as an element and has focus. The sidebar filter and the expanded state cover refs outside the window. The existing sidebar cases stay green. Then change `src/frontend/refs/ReferencesSidebar.tsx`: route the flattened rows through `@tanstack/react-virtual`, as ChangesPane does (plan.md D6). Keep the 10,000-ref bound; a larger set keeps the `REF_LISTING_RECORDS` refusal. Spec: FR-055, FR-047. Depends on T037.

### Retirement of 001 `readHistory` (P7)

WP9 runs strictly after WP4, WP5, and WP6, because it edits their files. It also waits for WP7 (`session.ts`) and WP8 (the renderer stops calling `readHistory`).

- [x] T048 Write the failing retirement checks (P7). In `tests/contracts/operation-registry.test.ts` and `tests/contracts/envelope.test.ts`, `readHistory` gives `UNKNOWN_OPERATION`. In `src-tauri/src/ipc.rs`, a cargo test asserts that the allowlist has no `read_history`. `Local: Rust`. Spec: none new; plan.md P7 and contract Δ3 "readHistory". Depends on T047.
- [x] T049 Retire `readHistory` (P7). Remove it from `src/contracts/operations.ts`, `src/contracts/envelope.ts` (`ReadHistory`), `src/contracts/limits.ts` (`GRAPH_PATH_SEGMENTS`), `src/git-service/history.ts` (`readHistory`, `pageOf`), `src/git-service/session.ts`, `src/frontend/state/requests.ts`, `src-tauri/src/ipc.rs`, `src-tauri/build.rs` and its generated permission file, `src-tauri/capabilities/main.json`, `src/frontend/bridge.ts` (`readHistory`), `src/frontend/app/Workbench.tsx`, and the `readHistory` entry of `SAMPLE_CALLS` in `tests/contracts/bridge.test.ts`. Delete `src/frontend/history/lanes.ts`. Keep `captureHead`, `sharedListing`, and `checkFailedRead`. Delete `tests/git/history-lanes.test.ts`. Move the 001 cases that call `readHistory` to `openHistory` and `readHistoryRows`. They are in `tests/git/history.test.ts`, `read-lifecycle.test.ts`, `trust.test.ts`, `external-changes.test.ts`, `read-inputs.test.ts`, `diagnostics.test.ts`, `status.test.ts`, `poll-cost.test.ts`, and `service-harness.ts`. They are also in `tests/contracts/history-view.test.tsx`, `git-commands.test.ts`, `renderer-freshness.test.ts`, `notice-band.test.tsx`, `workbench-mount.test.tsx`, `wsl-poll.test.ts`, and `tests/wsl/reads.test.ts`. Keep each 001 assertion; change only the operation. Run `bun run export:schemas`. Keep the 001 artifacts as records. Make T048 pass. `Local: Rust`. Spec: none new; plan.md P7 keeps every 001 rule that 002 does not replace (spec "Scope Boundaries"). Depends on T018, T028, T029, T035, T047, and T048.

### Batch 4 verification

- [ ] T050 Run the batch 4 verification: `bun install --frozen-lockfile`, `bun run build`, `bun run typecheck`, `bun run export:schemas --check`, `cargo check --locked --manifest-path src-tauri/Cargo.toml`, the T029 `cargo test` command, and `bun run test:all` with `ARBARETO_WSL_DISTRO=Ubuntu-26.04`. `Local: Rust`. `Local: WSL`. `Local: Windows` for the manual check. Pass condition: every command exits 0 with `ORIGIN` lines under this checkout. `rg -n "readHistory\b|layoutHistory" src` prints nothing. In `src-tauri/src` and `tests`, the same command finds only the T048 retirement assertions: the `#[cfg(test)]` module of `src-tauri/src/ipc.rs`, `tests/contracts/operation-registry.test.ts`, and `tests/contracts/envelope.test.ts`. Then run the quickstart.md "Manual check in the app" with `bun run dev` and a scratch `ARBARETO_PROFILE_ROOT`, and record each step. Control mutation: let `virtualTopOf` in `src/frontend/history/HistoryList.tsx`, which holds the window arithmetic, return `scrollTop`. The 4,000,000-row last-row case of `tests/contracts/history-list.test.tsx` must fail. Undo the edit and rerun green. The task passes only after one independent review of batch 4 is recorded in research.md. Spec: all batch 4 IDs of T038 to T049 and T062. Depends on T038 to T049 and T062.

**Checkpoint**: The app shows the full history with the filter. One history path remains.

---

## Phase 6: Packaged qualification (Batch 5, P8, cross-cutting)

**Purpose**: Record the packaged evidence for the budgets and the Git Extensions comparison.

The responsiveness and capture workloads need the 001 tools `tests/windows/inject.ts` (001 T165), `tests/windows/uia.ts` (001 T240), `tests/windows/capture.ts` (001 T242), and `tests/windows/external-change.ts` (001 T244). `tests/windows/ratio.ts` (001 T243) exists. `tests/windows/uia.ts` exists, but 001 T240 is open, so it is not qualified.

### Open item O-2 (SC-002 first-screen, SC-006, and SC-010 values)

- [ ] T051 Ask the user to confirm the SC-002 first-screen bound (16 MiB), the SC-006 value, and the SC-010 values (1 s, 5 s) before any memory, filter latency, or cancel run. The SC-006 value is 10% or 500 ms, whichever is larger. Record the answer in spec.md SC-002, SC-006, and SC-010 and in plan.md O-2, and run `/speckit-analyze` after a change. Do not decide for the user. This task blocks T053, T054, and T055. Spec: SC-002, SC-006, SC-010. Plan: O-2, P8. Depends on T050.

### Package and measurements

- [ ] T052 Build and install the packaged Windows build by the 001 T154 procedure (P8). `Local: package`. README "Development" lists no package command. After the build runs green, add its command to README "Development". Record the build identity, the Git version, and the WebView2 version in research.md. Spec: SC-014 precondition (packaged build). Depends on T050.
- [ ] T053 Write `tests/windows/history-perf.test.ts` with the SC-005 and SC-006 records (P8). `Local: package`. Write the statistic and the pass rule first, on recorded sample data, and run them red. Then measure the time to the first row and the filter latency (first match, final count) on H200K, with and without a commit-graph. Also record the time to the first new row of a later load step. Record Git's own times under the same conditions next to them, and the time that the application adds. Record cold runs after a reboot and warm runs after one discarded run, by the 001 rules (001 plan.md "Measurements and budgets"). Report each set apart. Spec: SC-005, SC-006. Depends on T051 and T052.
- [ ] T054 Add the SC-002 memory record to `tests/windows/history-perf.test.ts` (P8). `Local: package`. Write the budget check first on recorded samples, and run it red. Sample private bytes over the complete process tree every 100 ms, with each Git process apart and next to the peak of the same Git command run alone. The budget check sums only the Arbareto processes: the shell, the service, and the WebView2 processes. Git's child processes have no bound (T007). The base is the same worktree with a one-commit history (reviewer default, spec Assumptions). Record the four SC-002 checkpoints on H1M: after the first load step ends (its `loadHistory` result arrived), no Git process of the view runs, and the view adds at most 16 MiB (the T051 first-screen bound); after End shows the last commit, after a return to the top, and during a filter search. Record the loaded row count at each checkpoint. Also record the time to the final count of the H1M search next to Git's own search time, without a gate. Spec: SC-002, FR-043, FR-054. Depends on T007, T051, T052, and T053.
- [ ] T055 Add the responsiveness and cancel workloads to `tests/windows/history-perf.test.ts` (P8). `Local: package`. First confirm that `IsHungAppWindow` covers the Tauri main window, and record the result (R9, R13). Poll it every 100 ms. Run these workloads on H1M without a commit-graph, with slow Git activity: open, End, scrollbar drag, wheel scroll, search, mode switch, scope switch, Cancel, and Refresh after a ref move. Use WPR Verbose long tasks, DXGI capture, and `inject.ts` probe inputs every 100 ms (plan.md D7). Assert the 001 SC-005 targets: at least 95% of inputs acknowledged within 100 ms, every input answered within 500 ms, and no interface task above 500 ms. After End, a scrollbar drag to the bottom reaches the last row, which checks the WebView2 layout height (R13). Run End and that drag at the comfortable density, because only that density compresses the scroll range at 1,000,000 rows (plan.md D6). After End, the last row equals the last line of one uninterrupted `rev-list --date-order --parents` run (SC-001 on H1M). A canceled load and a canceled search stop within 1 s, and no process remains after 5 s. Record the CPU time of each process from the WPR CPU trace, with Git apart (note N-3). For open and End, record cold runs after a reboot and warm runs after one discarded run, by the 001 rules. Report each set apart. Spec: FR-012, FR-052, FR-053, FR-054, SC-001, SC-010, SC-014. Depends on T051, T052, T054, and 001 T165, T240, and T242.
- [ ] T056 Add the SC-012 notice timing to `tests/windows/history-perf.test.ts` (P8). `Local: package`. Move HEAD, add a ref, remove a ref, and move a ref during a scroll with the 001 T244 helper. No shown row or label changes. The notice appears within the 001 external-change target. Refresh shows the history of the new ref set. Spec: FR-005, FR-008, SC-012. Depends on T055 and 001 T244.
- [ ] T057 [P] Create the Git Extensions harness `tests/windows/history-ge.ts` and its test `tests/windows/history-ge.test.ts` (P8). `Local: GE`. `Local: package`. Write the test first on recorded samples with `tests/windows/ratio.ts`, and run it red. Full scroll: start at F5 with the list at the top, and send Ctrl+End every 100 ms in both tools until the root commit row shows. Message filter: the Git Extensions toolbar message filter with Ignore case, and an ASCII-letter word. Confirm its argv from the WPR process trace (`--grep`, `--regexp-ignore-case`, `--all`, `--parents`). Use the maintained commit-graph variant and the 001 ABBA and run rules on H200K. Record the work that each tool performs. The gate is the upper 95% bound of the median ratio, at most 1.0 for each workflow. Spec: SC-011. Depends on T052, 001 T180, and 001 T165 (through T180).
- [ ] T058 [P] Extend `tests/wsl/history-wsl.test.ts` with the view and the search through the distro Git (P8). `Local: WSL`. Assert the same order, ref set, and matching rules as on Windows. A ref change other than HEAD shows the notice at the next focus return, Refresh, or mutation outcome. Record the `wsl.exe` relay throughput of an End load on H200K, the text read latency, and the scope `memory.peak` on H200K. Record SC-002 in WSL at 1,000,000 commits as `unverified`. Spec: FR-046, SC-002, SC-007, SC-012. Depends on T050 and T063.

### Records and verification

- [ ] T059 Record every batch 5 result in research.md as R14 and later (P8). Give each SC its own row with `pass`, `fail`, or `unverified`, the build, the OS version, the architecture, the Git version, the fixture, the run count, and the numbers. Record times and ratios as numbers, never as comparative adjectives. Record each failure with its cause. Spec: SC-001 to SC-015. Depends on T053 to T058.
- [ ] T060 Run the batch 5 verification on the reference host with the T052 package installed: `bun run build:service`, `bun run test:windows`, and `bun run test:all` with `ARBARETO_WSL_DISTRO=Ubuntu-26.04`. `Local: package`. `Local: WSL`. Pass condition: every command exits 0 with `ORIGIN` lines under this checkout, and research.md holds a row for each of SC-001 to SC-015. Control mutation: set the SC-002 budget in `tests/windows/history-perf.test.ts` to 1 MiB. The memory check must fail. Undo the edit and rerun green. The task passes only after one independent review of batch 5 is recorded in research.md. Spec: SC-001 to SC-015. Depends on T059.

**Checkpoint**: Batch 5 is complete. research.md holds concrete results, failures, and causes for every SC.

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (batch 0)**: No dependency. T001 and T002 come first. T003 to T006 form one [P] group after T002. T004 uses no fixture, so it may start first. T007 follows T006 and waits for the user. T008 follows T004, and T009 follows T005. T010 follows T002 and T008. T011 closes batch 0 and does not wait for T007.
- **Phase 2 (batch 1)**: Depends on T011. The tests T012 to T015 come first. T016 follows T012, T017 follows T014, T018 follows T015, and T019 follows T013 and T016. T025 and T027 follow T018. T029 follows T018 and T025. T020 closes batch 1.
- **Phase 3 (batch 2)**: Depends on T020. The tests T021 to T024 come first. T026 follows T021. T028 follows T009, T016, T018, T022 to T024, T026, and T027. T030 closes batch 2. T061 runs beside the batch 2 tasks and does not block T030.
- **Phase 4 (batch 3)**: Depends on T030. WP7 runs strictly after WP6: T035 changes `src/git-service/session.ts` and `src/git-service/history-view.ts`, so T035 depends on T028 and has no [P]. T035 also edits `src/git-service/commands.ts` after T026. T036 follows T034 and T035 in the same file. T063 follows T036, because it edits `history-search.ts` and `history-view.ts` too (WP11 runs after WP7). T037 closes batch 3.
- **Phase 5 (batch 4)**: Depends on T037. The tests T038 to T042 come first. T043 to T047 run in order, because T044, T046, and T047 share `HistoryList.tsx`, and T046 and T047 share `HistoryFilter.tsx`. WP9 runs strictly after WP4, WP5, and WP6: T049 edits files of T018, T029, and T028, so T049 depends on T018, T028, T029, T035, T047, and T048, and has no [P]. T062 touches only the sidebar files, so it may run beside T038 to T044. T045 adds the context menu item to `ReferencesSidebar.tsx`, so it follows T062. T050 closes batch 4.
- **Recorded exception (2026-10-13)**: T038 to T044, T046 to T049, and T062 ran before batch 3 on f002-b0, with the fake bridge of `tests/contracts/history-fake.ts`. The R20 run is their evidence. Until T035 merges, the service answers `searchHistory` with `SERVICE_UNAVAILABLE`, so the filter does not work in the app. T050 cannot pass before T037 passes.
- **Phase 6 (batch 5)**: Depends on T050. T051 waits for the user and blocks T053, T054, and T055. T052 comes before every measurement. T053, T054, T055, and T056 share `tests/windows/history-perf.test.ts`, so they run in that order with no [P]. T054 also depends on T007 (O-1). T055 depends on 001 T165, T240, and T242. T056 depends on 001 T244. T057 depends on 001 T180, and T180 depends on 001 T165. T057 and T058 may run beside the T053 to T056 chain. T059 and T060 run last.

### User story dependencies

- **US1**: Depends on batches 0 and 1. Its service part (T021 to T024, T026, T028, and T030) blocks US2 and US3. Its renderer part (T038, T039, T042 to T045) blocks the US2 and US3 renderer parts.
- **US2**: Depends on US1 T028 and on T008, T017, and T019. Its renderer part T046 depends on T045.
- **US3**: Depends on US2 T035. Its renderer part T047 depends on T046.

### Within each batch

- Tests come first and must fail. Fact tests record facts and have no implementation.
- Contracts come before service code. Argv builders in `src/git-service/commands.ts` come before the modules that run Git.
- Service code comes before renderer code.
- The batch verification task comes last. It passes only after one independent review of the batch is recorded in research.md. No automatic review loop runs.

### Parallel opportunities

- Batch 0: T003 to T006 together after T002. T008 and T009 together.
- Batch 1: T012 to T015 together. Then T016 to T018 together. After T018, T025 and T027 together. T029 follows T025.
- Batch 2: T021 to T024 and T061 together.
- Batch 3: T031 to T034 together.
- Batch 4: T038, T039, T041, T042, and T062 together. T040 follows the T038 conflict record.
- Batch 5: T057 and T058 beside the T053 to T056 chain.
- Run one implementer at a time in one checkout. Parallel implementers need disjoint worktrees (user memory "Parallel implementers OK"). Full runs and WSL runs run alone.

## Parallel Example: Batch 3

```bash
# Batch 3 service tests together, before any search code:
Task: "Write failing argv tests in tests/contracts/git-commands.test.ts for the search"
Task: "Write failing tests in tests/git/history-search.test.ts"
Task: "Write failing tests in tests/git/history-matching.test.ts"
Task: "Write failing tests in tests/git/history-highlight.test.ts"
```

---

## Coverage

Each FR and SC maps to at least one task.

| Spec ID | Tasks |
| --- | --- |
| FR-001 | T022, T023 |
| FR-002 | T024 |
| FR-003 | T002, T012, T015, T022 |
| FR-004 | T003, T012, T022 |
| FR-005 | T024, T039, T045, T056 |
| FR-006 | T024, T039 |
| FR-007 | T024, T039 |
| FR-008 | T039, T045, T056 |
| FR-009 | T022, T038 |
| FR-010 | T022, T038 |
| FR-011 | T005, T022, T038 |
| FR-012 | T038, T055 |
| FR-013 | T038 |
| FR-014 | T005, T022 |
| FR-015 | T005, T038 |
| FR-016 | T005, T038 |
| FR-017 | T022, T042 |
| FR-018 | T022, T042 |
| FR-019 | T002, T032 |
| FR-020 | T032 |
| FR-021 | T003, T032 |
| FR-022 | T014, T031, T033 |
| FR-023 | T004, T033, T063 |
| FR-024 | T004, T025, T031, T033, T063 |
| FR-025 | T033, T040, T063 |
| FR-026 | T014, T015, T025 |
| FR-027 | T014, T040 |
| FR-028 | T014, T040 |
| FR-029 | T040 |
| FR-030 | T032, T040 |
| FR-031 | T040 |
| FR-032 | T032, T040 |
| FR-033 | T013, T032 |
| FR-034 | T013, T040 |
| FR-035 | T032, T040 |
| FR-036 | T034, T041 |
| FR-037 | T034, T041 |
| FR-038 | T034, T041 |
| FR-039 | T032, T034, T041 |
| FR-040 | T041 |
| FR-041 | T041 |
| FR-042 | T041 |
| FR-043 | T006, T007, T054, T061 |
| FR-044 | T024 |
| FR-045 | T012, T015, T021, T024, T032 |
| FR-046 | T010, T025, T058, T063 |
| FR-047 | T002, T015, T023, T062 |
| FR-048 | T023 |
| FR-049 | T023, T039 |
| FR-050 | T023, T038 |
| FR-051 | T021, T024 |
| FR-052 | T055 |
| FR-053 | T038, T055 |
| FR-054 | T022, T024, T028, T038, T054, T055, T061 |
| FR-055 | T062 |
| SC-001 | T001, T022, T055 |
| SC-002 | T006, T007, T051, T054, T058, T061 |
| SC-003 | T001, T003, T022 |
| SC-004 | T001, T005, T022 |
| SC-005 | T001, T053 |
| SC-006 | T051, T053 |
| SC-007 | T004, T010, T033, T058, T063 |
| SC-008 | T013, T032, T034 |
| SC-009 | T014, T032, T040 |
| SC-010 | T024, T032, T055 |
| SC-011 | T057 |
| SC-012 | T024, T039, T056, T058 |
| SC-013 | T001, T022, T024, T032 |
| SC-014 | T055 |
| SC-015 | T001, T023 |

---

## Implementation Strategy

### MVP first (User Story 1)

1. Complete batches 0 and 1.
2. Complete batch 2 (US1 service part).
3. Complete T038, T039, T042 to T045 (US1 renderer part).
4. **Stop and validate**: scroll a 200,000-commit fixture to the last commit with stable rows, and press End on it.

### Incremental delivery

1. US1: batches 0 to 2, then the US1 renderer tasks.
2. US2: batch 3 T031 to T035, then T040 and T046.
3. US3: T034 and T036, then T041 and T047.
4. Retirement: T048 and T049.
5. Qualification: batch 5.

The spec requires all three stories for qualification. No partial increment counts as qualified.

---

## Notes

- `[P]` tasks touch different files and depend on no incomplete task.
- `[Story]` labels map each task to a spec.md story for traceability.
- Verify that each test fails before its implementation task starts.
- The orchestrator session commits after each task or logical group. Never commit fixture repositories, performance fixtures, or executables.
- The application never writes a commit-graph, a message index, or other repository data (FR-044).
