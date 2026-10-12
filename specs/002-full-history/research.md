# Research: Full History and Commit Message Filter

**Feature**: `specs/002-full-history` | **Date**: 2026-10-11 | **Plan**: [plan.md](plan.md)

## Sources and fact marks

The facts come from three sources:
- the investigation of 2026-10-11 with Git 2.56.0.windows.1 on synthetic repositories (spec "Research inputs");
- the plan design of 2026-10-11, which read the 001 code, the 001 contract, and the Git source;
- DeepWiki on gitextensions/gitextensions, 2026-10-11.

Each fact has one mark:
- **documented**: Git documentation, Win32 documentation, WAI-ARIA, or the 001 contract states it. Source code with a file and line counts here too.
- **experiment**: a run on Git 2.56.0.windows.1 showed it. Git does not promise it. Runtime checks must guard it.
- **unverified**: an estimate or a recollection. No test has shown it yet. The plan names the step that checks it.

The investigation scripts were in a session scratchpad. They may be gone. Step P0.2 records the experiment facts again as tests.

## R1 Page rule: one order per view, read in load steps

- **Decision**: Each view reads one `rev-list --parents --date-order --stdin` order in load steps. A step reads to a stop row, and then the service ends Git (plan.md D2). A later step runs the same arguments with no `--skip`. The service compares each of the first N streamed rows with the held row at the same index, in OID and parents. The first difference makes the view stale with `HISTORY_CHANGED` reason `order`. The rows after the held rows append (reviewer default, spec Assumptions).
- **Rationale**:
  - One stream gives one exact order by construction. **experiment**
  - `--date-order` shows no parent before all its children (git-rev-list(1)). **documented**
  - `--skip` applies after the ordering (rev-list-options). **documented**
  - Joined `--skip` pages give the same order. Each deep page walks the history again: 942 ms at 200,000 commits without a commit-graph, 180 ms with one. **experiment**
  - Git documents no unique order (rev-list-options.adoc:916). Repeatability across two processes is an experiment fact only. **documented** (the gap) and **experiment** (the repeatability)
  - Without a commit-graph, the first row waits for a walk of the whole graph: about 1 s at 200,000 commits, 48 ms with a commit-graph. **experiment**
  - Because Git documents no unique order, a later run can order the skipped rows another way. A one-row overlap check after `--skip` cannot prove the skipped prefix. The full compare of the re-read rows uses only exact parses. **documented** (the gap)
  - The step size rule keeps S ≥ 2·L₀. So the re-read rows of all later steps add up to less than twice the final row count for steps that end at their stop row or at the end; each canceled step adds at most N (plan.md D2) (plan.md D2). **documented** (arithmetic)
  - rev-list reads revisions from stdin with `--stdin` (git-rev-list(1)). **documented**
  - With equal commit dates, the stdin order of the start points decides the order of the tied rows. A shuffled or a reversed stdin gave the same rows in another order. So the start points must go to Git in ascending lowercase hex. **experiment** (Git 2.56.0.windows.1, T003 equal-dates fixture)
  - Without generation numbers, `--date-order` sets `limited`, and `limit_list` walks the whole graph before the first line (Git v2.56.0 revision.c:2485-2487, 3195-3196, 4053-4057). With them, `init_topo_walk` walks on demand (revision.c:4058-4059). `--skip` takes one walk step for each skipped commit (revision.c:4598-4607). **documented** (code)
- **Alternatives considered**:
  - A cursor that restarts from the parents not yet sent. It gives another valid order, so the order changes inside a view. Rejected. **experiment**
  - Fixed-size `--skip` pages. A deep scroll costs one walk per page. Rejected; load steps double instead (plan.md D2).
  - Load steps with `--skip=<N-1>` and a one-row overlap check. The check cannot prove the skipped prefix. Replaced by the full compare on 2026-10-12 (reviewer default, spec Assumptions).
  - One stream per view, drained at full speed. It holds the topology of every commit from the open. Replaced by load steps on 2026-10-12 (user decision, spec Clarifications).
  - A paused stream with backpressure. The memory note of the investigation proposed it ("read with backpressure"). The design rejects it (R2).

## R2 Process model: load to a stop row, then end Git

- **Decision**: A load reads to its stop row. The service then ends Git with the process `cancel` of the call. Git never pauses. The service parses each frame into compact arrays. No new shell flow-control frame. No Web Worker.
- **Rationale**:
  - The shell keeps at most 8 chunks per stream, and the service handles each frame before it reads the next (001 contract §6 "Backpressure"; `process_requests.rs:2394`). A paused stream would stall the service pipe for every operation. **documented**
  - A paused Git keeps the memory of its walk. An ended Git frees it at once. Without a commit-graph, the next step walks again (R1). **experiment** (the walk) and **documented** (code, R1)
  - A process `cancel` for a run call closes the Job of the operation that owns the call, and each process of it gets `exit` (001 §6 "Channel frames"; `process_requests.rs:1148-1158`). **documented**
  - The cost is about 1-3 µs per row, so about 2 ms per 64 KiB frame. Other requests wait at most one frame. **unverified**
  - An End load of 1M commits is about 1,350 frames of 64 KiB, about 115 MB. The cost of the strict JSON decoder over that volume is unknown. **unverified**
- **Alternatives considered**:
  - A per-call output credit frame. Left out: the stop row bounds each load.
  - A paused stream. Rejected: Git keeps its memory, and the pipe stalls.
  - `--max-count` per step. Rejected: an `{oid}` load learns its stop row only when the commit streams.

## R3 Graph layout: one step function with checkpoints

- **Decision**: The service runs the lane layout as a pure step `layoutStep(lanes, row)`. It stores a checkpoint every 256 rows. The cell of row i comes from the checkpoint at ⌊i/256⌋·256.
- **Rationale**:
  - The 001 layout (`lanes.ts`) can run row by row with equal results, when the state carries the output lane array and the lane count. One rule changes: a limited row closes the free lane slots (plan.md O-5). T005 shows equal cells from checkpoints on every graph fixture and on H200K (R16). **experiment**
  - The state needs no set of sent OIDs. With `--date-order`, no parent comes before its children (git-rev-list(1)), so such a set changes no cell. The topology table checks duplicate rows and repeated parents (data-model §3, T012). **documented**
  - A complete walk lists every effective parent later. So the 001 "outside page" branch never runs (`lanes.ts:50-110`, `lanes.ts:52-55, 84-102`). **documented** (code)
  - The page-wide width limit of 001 must become a rule for each row. **documented** (code)
- **Alternatives considered**: Layout in the renderer. Rejected, because renderer work then grows with the history (R8).

## R4 Message search and matching

- **Decision**: One `rev-list --date-order --fixed-strings --regexp-ignore-case --grep=<text> --stdin` stream per search, with `-c i18n.logOutputEncoding=UTF-8` and `LC_ALL=C.UTF-8`. A fixed matching probe runs once per Git installation per service session before the first search.
- **Rationale**:
  - The matches come in exactly the full-history order, with the non-matches removed. So they merge into the full stream as a subsequence. **experiment** (the runtime check refuses on a mismatch)
  - `--grep` keeps real parents. Git rewrites parents only under path simplification (revision.c:4077-4096). **documented** (code)
  - `--graph --grep` breaks lines at parents that do not match. The application must build the reduced graph itself. **experiment**
  - `-F` on a PCRE2 build wraps the text in `\Q…\E` (grep.c:527-546). A backslash followed by `E` breaks literal matching, with or without `-i`. **documented** (code) and **experiment**
  - Case folding of non-ASCII text needs a UTF-8 locale and UTF-8 log output (grep.c:325-326, revision.c:3214). **documented** (code)
  - On Git 2.56.0.windows.1, the probe also folded case with `LC_ALL=C`. **experiment** (T004)
  - This Git install (`C:\Git`) has no `share/locale` folder and no `git.mo` file. `git version --build-options` reports `gettext: enabled`. **experiment**
  - The link between the missing locale files and the folding under `LC_ALL=C` is not shown. **unverified**
  - The search keeps `LC_ALL=C.UTF-8` for Git builds that have locale files.
  - `-F -i` folds Cyrillic, Ukrainian є ї ґ і, and ß against ẞ, never against "SS", under those settings. **experiment**
  - `--fixed-strings` overrides `grep.patternType=perl` in the global configuration. With that setting, `--grep=probe.` matched 15 of 15 probe commits without `--fixed-strings` and 0 with it. **experiment** (Git 2.56.0.windows.1, T004)
  - The `-c` value comes after an inherited `GIT_CONFIG_PARAMETERS`, so it wins. With an inherited `i18n.logOutputEncoding=ISO-8859-1`, `config --get` gave `ISO-8859-1` alone and `UTF-8` with `-c`. The probe runs gave the contract matches. **experiment** (Git 2.56.0.windows.1, T004)
  - FR-023 for the rest of Unicode rests on PCRE2 caseless matching. **unverified**
  - `git version --build-options` does not report PCRE2. No Git signal tells whether Git uses PCRE2. This is a contract gap. The probe covers only the probed cases. **experiment**
  - The Windows command line caps a pattern near 32,767 characters. The plan sets 1,024 UTF-8 bytes. **documented** (Win32 command line limit)
  - `init --bare --template=` copies nothing. It writes only `HEAD` and `config`. A marker file in `GIT_TEMPLATE_DIR` and the default template files do not appear. **experiment** (Git 2.56.0.windows.1, T004)
  - An explicit `--git-dir` gets no ownership refusal. With `GIT_TEST_ASSUME_DIFFERENT_OWNER=1`, discovery exits 128, and `--git-dir` exits 0. The probe runs then give the contract matches. **experiment** (Git 2.56.0.windows.1, T004)
  - `fs.rm` with `recursive` and `force` removes the probe folder after the probe runs. **experiment** (Bun 1.4.2, T004)
- **Alternatives considered**:
  - A filter over loaded rows. Wrong answers in a long history (spec US2). Rejected.
  - A message index. FR-044 forbids it.

## R5 Filter-mode reduced graph

- **Decision**: The service builds the reduced graph from the full topology stream and the match states, in stream order (plan.md D4).
- **Rationale**:
  - Define D(x) as the matches m ≠ x with a parent path m→…→x and no match strictly between them. With `--date-order`, every child streams before its parent. So the union over the children of x gives D(x), by induction over the stream order. An edge m→a is emitted exactly when a matches and m is in D(a). That is the FR-033 definition. **documented** (proof from the `--date-order` rule; P1 tests it against a BFS oracle)
  - The reduced graph needs the full stream, because the paths pass through commits that do not match. **documented** (follows from R4)
  - Typical cost: about 2·10⁷ operations at 1M rows, about 50-100 ms in total. **unverified**
  - Worst case: k branches that join one base give O(k²) union work. **documented** (from the algorithm)
- **Alternatives considered**: A mergeable heap for the sets. Left out as the upgrade path for the O(k²) case.

## R6 Memory

- **Decision**: The service holds the topology in typed arrays: an OID table, CSR parents, and lane checkpoints. The renderer holds only the visible pages and an LRU cache of row text up to 8 MiB.
- **Rationale**:
  - A 001 HistoryRow takes about 600-790 bytes in Bun/JSC. **experiment**
  - A compact topology row takes about 40 bytes (investigation estimate). **unverified**
  - The design counts about 48 bytes per commit for SHA-1 (60 for SHA-256): OID 20, hash slots about 12, idToRow and rowToId 8, CSR about 8.4. That is about 48 MB at 1M commits. **unverified**
  - Git alone uses 446.5 MiB during a search on 1M commits without a commit-graph, and 145.9 to 166.4 MiB otherwise (R14). **experiment** The design recalls that `builtin/rev-list.c` sets `save_commit_buffer` for `--grep`, so the limited walk keeps every commit buffer. **unverified** (plan.md open item O-1)
  - Linux Git memory is not part of the Windows process tree. The WSL scope `memory.peak` can record it. **unverified**
  - With load steps, the view holds at most 2·n + 2·M + 1 rows until End or a search (plan.md D2). Near the top, that is about 2,089 rows. **documented** (arithmetic)
  - The topology table never shrinks during a view (plan.md D3).
- **Alternatives considered**: A JS `Map` of OID strings. Rejected for its memory per commit. The investigation proposed a 32 MiB text cache. The design uses 8 MiB of `bytes` as a measurement knob.

## R7 Ref set capture

- **Decision**: One `for-each-ref` with the exact 001 §3 format over `refs/heads refs/remotes refs/tags refs/stash refs/replace`. Start points are the unique commit IDs plus the HEAD OID, in ascending lowercase hex, on stdin.
- **Rationale**:
  - for-each-ref uses refname order, `%00`, and `*` peeling (001 §3; T356). **documented** and **experiment** (T356)
  - `%(*objecttype)` gives the end of the tag chain (T356 probe on 2.56.0). **experiment**
  - Patterns match from the beginning up to a slash (git-for-each-ref(1)). **documented**
  - The pattern `refs/stash` can also match `refs/stash/x`. The service skips such records. **unverified**
  - `%(objectname)` of a symbolic ref gives the target OID. **unverified**
  - 10,000 SHA-256 lines need about 650 KB, so a large set uses the 001 streamed input. **documented** (arithmetic)
  - A set `GIT_REPLACE_REF_BASE` moves replace refs outside the fingerprint. **documented** (Git environment); a contract gap
  - `core.useReplaceRefs` in the repository config changes parents outside the fingerprint. The re-read compare reports it as reason `order`. A load after `core.useReplaceRefs false` keeps the topology fingerprint equal and gives `HISTORY_CHANGED` reason `order` (T024). **unverified**; a contract gap
- **Alternatives considered**: The Git Extensions exclusion list. Rejected for explicit namespaces (spec Assumptions).

## R8 History list: why the installed virtualizer does not fit

- **Decision**: The history list uses its own fixed-height row arithmetic. ChangesPane keeps `@tanstack/react-virtual`, and the references sidebar uses it too (plan.md D6), because its count is at most 10,000 refs. This follows the project rule "prefer libraries": the plan checked the installed library first.
- **Rationale**:
  - `@tanstack/virtual-core` 3.17.11 builds a `Float64Array(count*2)` and an items array of `count`. It rebuilds them from index 0 whenever `count` changes (`node_modules/@tanstack/virtual-core/dist/esm/index.js:673-705`). A load that grows `count` to 1M rows repeats O(n) work in the renderer. **documented** (code)
  - The library has no fix for the maximum element height of the browser. **documented** (code)
  - Chromium's LayoutUnit maximum is about 33,554,431 px. 1M rows at the comfortable density need about 34M px. **unverified** in WebView2
  - The fixed-height window maps the scroll range to a virtual offset: `virtualTop = scrollTop · (total·rowHeight − clientHeight) / (scrollHeight − clientHeight)`, and the first row is `floor(virtualTop / rowHeight)` (plan.md D6). Its work does not grow with the history.
- **Alternatives considered**:
  - `@tanstack/react-virtual` for history. Rejected for the two facts above.
  - A new virtualizer package. Rejected: no new dependency (Constitution VIII), and a few lines of arithmetic cover the need.

## R9 Responsiveness

- **Decision**: No renderer work grows with the history size. Measurement reuses the 001 method and adds an `IsHungAppWindow` poll every 100 ms.
- **Rationale**:
  - Windows reports a window as not responding after 5 seconds without message processing (Win32 documentation). **documented**
  - `IsHungAppWindow` covers the Tauri main window. **unverified**
  - The planned shortcuts (Ctrl+F for the filter, F3, Shift+F3; plan.md D6) do not conflict with the 001 keyboard map. **unverified**

## R10 WSL

- **Decision**: The same operations run through the 001 wrapper. A new wrapper mode `search` adds `LC_ALL=C.UTF-8`.
- **Rationale**:
  - WSL gets an empty `WSLENV` (001 §11), so no Windows variable reaches Linux. **documented**
  - WSL polls do not run `readRefs` (001 §11). So a ref change shows at the next focus return, Refresh, or mutation outcome (spec SC-012). **documented**
  - Each text read costs one `wsl.exe` start, about 250 ms. **unverified**
  - Ubuntu-26.04 (Git 2.55.0) has the C.UTF-8 locale, gives the probe matches, and gives the R15 order facts. Its view bytes equal the Windows Git bytes. **experiment** (T010)
  - PCRE2 and the C.UTF-8 locale in other distros, and the relay throughput of an End load on H200K. **unverified** until the distro runs
- **Alternatives considered**: A long-lived `cat-file` in the distro. Left out. Add it when WSL misses SC-014.

## R11 Git Extensions comparison

- **Decision**: SC-011 uses matched work with the maintained commit-graph variant and the 001 ABBA and run rules. The gate value is the upper bound of the 95% interval of the median ratio (001 plan.md "Matched-condition comparisons").
- **Rationale**:
  - Git Extensions streams `git log -z` with no order flag and reorders rows by score. **documented** (DeepWiki)
  - Its quick search covers only loaded rows, so it is not matched work. Its filter mode reads real parents again. **documented** (DeepWiki)
  - The toolbar message filter with Ignore case runs `--grep`, `--regexp-ignore-case`, `--all`, and `--parents` (`FilterInfo.GetRevisionFilter`). **documented** (DeepWiki); the WPR process trace confirms the argv
  - The default view "Show all branches" reads HEAD and every ref. It excludes `refs/notes/commits`, `refs/sessions/`, and `refs/copilot/checkpoints/`. It includes the stash ref and adds older stash entries. **documented** (DeepWiki)
  - The filter ratio is close to 1.0, because both tools spend most time in the same Git walk. **unverified**

## R12 Invariants and their sources

| Invariant | Source | Mark |
|---|---|---|
| `--date-order` shows no parent before all its children. | git-rev-list(1) | documented |
| A complete walk lists every effective parent later, so lanes need no "outside page" mark. | `lanes.ts:50-110` | documented (code) |
| `--skip` applies after the ordering. | rev-list-options | documented |
| The order repeats across processes. | rev-list-options.adoc:916 states no unique order | experiment |
| `-F` on PCRE2 wraps the text in `\Q…\E`. | grep.c:527-546 | documented (code) |
| Case folding needs a UTF-8 locale and UTF-8 log output. | grep.c:325-326, revision.c:3214 | documented (code) |
| for-each-ref uses refname order, `%00`, and `*` peeling. | 001 §3; T356 | documented, experiment |
| for-each-ref patterns match by prefix up to a slash. | git-for-each-ref(1) | documented |
| rev-list reads revisions from stdin with `--stdin`. | git-rev-list(1) | documented |
| The shell holds at most 8 chunks per stream, and the service handles frames in order. | 001 §6 "Backpressure"; `process_requests.rs:2394` | documented |
| Registered processes have `deadlineMs` ≤ 120,000. | 001 §6 "Channel frames" | documented |
| Policies are data in `src/contracts/git-environment.json`. WSL gets an empty `WSLENV`. | 001 §7, §11 | documented |
| virtual-core rebuilds from index 0 on every count change. | `dist/esm/index.js:673-705` | documented (code) |
| `captureHead`, `sharedListing`, and `checkFailedRead` can be reused. | `src/git-service/history.ts:255-397` | documented (code) |
| Without generation numbers, `--date-order` walks the whole graph before the first line. | Git v2.56.0 revision.c:2485-2487, 3195-3196, 4053-4057 | documented (code) |
| With generation numbers, the walk runs on demand, and `--skip` takes one walk step per skipped commit. | Git v2.56.0 revision.c:4058-4059, 4598-4607 | documented (code) |
| A service `cancel` of a run call closes the Job of its operation. | `native-runner.ts:155-159, 212-213`, `process_requests.rs:1148-1158`, 001 contract §6 | documented (code) |

## R13 Open facts

These stay **unverified** until the named step runs:
- Git peak memory during load and search: P0.4 measured it on Windows (R14, **experiment**). Linux Git memory stays open: P8.
- About 48 bytes per commit in the service, and the service CPU during an End load: P3 and P8.
- The `save_commit_buffer` recollection: open. P0.4 measured the extra search memory (R14), but no plan step reads the Git source yet (plan.md O-1).
- `init --template=` copies nothing; an explicit `--git-dir` skips the ownership check: P0.5 showed both on Git 2.56.0.windows.1 (R4, **experiment**).
- `refs/stash` as a pattern matches `refs/stash/x`; `%(objectname)` of a symbolic ref gives the target OID: P3.
- The maximum layout height in WebView2: P6.
- `IsHungAppWindow` covers the Tauri main window: P8.
- The shortcut conflicts with the 001 keyboard map: P6.
- The re-read cost of a later step at 1,000,000 commits: T061.
- The memory after the first load step, with no Git process: P8.
- The Rust shell routes `succeeded` after the service closed the load Job: T025 and T055.

## Results

P0 to P8 record their results here as R14 and later. Record times and ratios as numbers, never as comparative adjectives.

## R14 Git peak memory

T006, 2026-10-12, Git 2.56.0.windows.1, H1M (1,000,000 commits), `tests/windows/history-git-memory.test.ts`. The value is `PeakPagefileUsage` (peak private bytes) through `GetProcessMemoryInfo`. The test samples every 100 ms and reads each open handle again after the process exits. Five runs per row. **experiment**

| H1M variant | Command | Peaks of the largest Git process (MiB) | Median (MiB) |
|---|---|---|---|
| no commit-graph | topology `rev-list --parents --date-order --stdin` | 166.3, 166.4, 166.3, 166.4, 166.4 | 166.4 |
| no commit-graph | search `rev-list --date-order --fixed-strings --regexp-ignore-case --grep=marker --stdin` | 446.5, 446.5, 446.5, 446.5, 446.6 | 446.5 |
| commit-graph | topology | 145.9, 145.9, 145.9, 145.9, 145.9 | 145.9 |
| commit-graph | search | 148.2, 148.2, 148.1, 148.2, 148.2 | 148.2 |

- A second set of five runs gave the medians 166.4, 446.6, 145.9, and 148.1 MiB, in the table order.
- Each run has two Git processes. `C:\Git\cmd\git.exe` is a launcher with a peak of 1.4 MiB. Its child `git.exe` does the walk and holds the peak above.
- The walking Git process of every row is above the 128 MiB of SC-002. The search without a commit-graph is 3.5 times the budget. **experiment** On 2026-10-12, the user decided that SC-002 excludes Git's child processes (plan.md O-1). These peaks stay recorded, without a bound.
- The search without a commit-graph uses 280 MiB more than the topology. This agrees with the `save_commit_buffer` recollection of R6. The Git source is not read yet, so the cause stays **unverified**.
- The search argv is the contract Δ3 argv with `LC_ALL=C.UTF-8`. The search on H1M matches 20,000 rows.

## R15 Order facts (P0.2)

T003 (Windows Git 2.56.0.windows.1) and T010 (Ubuntu-26.04 Git 2.55.0), 2026-10-12. Fixtures: the 19 small fixtures, H200K, and H1M (H1M on Windows only), each with and without a commit-graph. Start points go to stdin in ascending lowercase hex. **experiment**

| Fact | Windows (T003) | Ubuntu-26.04 (T010) |
|---|---|---|
| Two runs give the same bytes. | 42 of 42 | 40 of 40 |
| `--skip=k` equals the suffix. | 42 of 42 | 40 of 40 |
| The output is equal with and without a commit-graph. | 21 of 21 | 20 of 20 |
| A shuffled stdin gives the same bytes. | 40 of 42; fails on equal-dates (both variants) | 38 of 40; fails on equal-dates (both variants) |
| A reversed stdin gives the same bytes. | 40 of 42; fails on equal-dates (both variants) | 38 of 40; fails on equal-dates (both variants) |
| `--grep` equals the full order without the non-matches. | 42 of 42 | 40 of 40 |
| The distro view bytes equal the Windows Git bytes of the same repository. | not applicable | 40 of 40 |

- The `--skip` values on H200K were k = 1, 255, 256, 257, 19,393 (a merge run), and 199,999. On H1M they were k = 1, 255, 256, 257, 101,159 (a merge run), and 999,999.
- On equal-dates, another stdin order gives the same row set in another order. The first difference is at row 0 or 1. So the ascending start-point order of R1 stays a requirement.
- `rev-list --stdin` with no start point exits 0 and prints nothing (empty fixture, both Gits).
- T010 copies each Windows-built repository into the owned distro folder through a `tar` stream. So both Gits read byte-equal repositories.

## R16 Fixtures and layout (P0.1, P0.3)

- T001, 2026-10-12: H200K and H1M have 200,000 and 1,000,000 commits. Each variant has the expected commit-graph state. The two variants are two builds of one stream. Their refs, index entries, and working files are equal. **experiment**
- Measurement note: a sampler in the work session measured the next three items. It is not in the repository, and no repository test prints these numbers. These items are **experiment** results of a work-session sampler. No repository test reproduces them.
  - Build time per variant, from the folder creation to the manifest write: H200K 9.8 s and 10.3 s; H1M 55.1 s and 59.3 s (without and with a commit-graph). Disk size: H200K 35.2 MiB and 46.7 MiB; H1M 176.3 MiB and 233.5 MiB.
  - During the H1M build, the largest Git process peaked at 205 MiB of private bytes (2-second samples).
  - T003 on H1M holds about 2 GiB of private bytes in the Bun test process. The host then had 4,790 MB available.
- T005 on H200K, before the O-5 fix: 2,173 rows were limited. Only 93 of them need more than 24 lanes. The other 2,080 had 9 to 24 open lanes, but a lane at index 24 or above stayed open. **experiment**
- T005 now asserts that a row is limited exactly when it needs more than 24 lanes. A row needs the larger of two counts: its open lanes above plus one lane for a new node, and its open lanes below. On the old layout, this check fails on 2,080 H200K rows and on 24 octopus-65 rows. **experiment**
- After the O-5 fix, a limited row closes the free lane slots and keeps the lane order (plan.md O-5). T005 on H200K: 200,000 rows; each cell rebuilt from a checkpoint equals the fold. 199,899 lanes end at their parent nodes through the cells. 93 rows are limited. octopus-65 has 43 limited rows of 68, and tips-50 has 103 of 151. **experiment**
- T010: Ubuntu-26.04 has the C.UTF-8 locale (`locale charmap` gives `UTF-8`). Both probe runs give the contract matches with the distro Git and `LC_ALL=C.UTF-8`. **experiment**
