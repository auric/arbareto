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
  - The state needs no set of sent OIDs. With `--date-order`, no parent comes before its children (git-rev-list(1)), so such a set changes no cell. The topology table checks duplicate rows and parents that already showed as rows. A parent that repeats inside one line gives one edge (data-model §3, T012). **documented**
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
  - The design counts the parts per commit for SHA-1: OID 20, hash slots about 12, idToRow and rowToId 8, CSR about 8.4. SHA-256 adds 12 bytes. The typed arrays grow by doubling. So a loaded commit takes about 46 bytes when the arrays are nearly full, and about 80 to 90 bytes just after a doubling. That is about 46 to 90 MB at 1M commits, and about 185 to 360 MB (about 46 B per commit when the typed arrays are nearly full, about 90 B just after a doubling) at 4,000,000. **unverified**
  - Git alone uses 446.5 MiB during a search on 1M commits without a commit-graph, and 145.9 to 166.4 MiB otherwise (R14). **experiment** The design recalls that `builtin/rev-list.c` sets `save_commit_buffer` for `--grep`, so the limited walk keeps every commit buffer. **unverified** (plan.md O-1, background)
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
  - The pattern `refs/stash` also matches `refs/stash/x`. The service skips such records. **experiment** (T023, R19)
  - `%(objectname)` of a symbolic ref gives the target OID. **experiment** (T023, R19)
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
  - The planned shortcuts (Ctrl+F, F3, Shift+F3, Ctrl+Shift+B; plan.md D6) do not conflict with the 001 keyboard map (T038 record, R13). **documented** for WebView2 and the code. The packaged-app key check stays **unverified**.

## R10 WSL

- **Decision**: The same operations run through the 001 wrapper. A new wrapper mode `search` adds `LC_ALL=C.UTF-8`.
- **Rationale**:
  - WSL gets an empty `WSLENV` (001 §11), so no Windows variable reaches Linux. **documented**
  - WSL polls do not run `readRefs` (001 §11). So a ref change shows at the next focus return, Refresh, or mutation outcome (spec SC-012). **documented**
  - Each text read costs one `wsl.exe` start, about 250 ms. **unverified**
  - Ubuntu-26.04 (Git 2.55.0) has the C.UTF-8 locale, gives the probe matches, and gives the R15 order facts. Its view bytes equal the Windows Git bytes. **experiment** (T010)
  - WSL search runs the matching probe through the `run` field `script` (T063, R22). On Ubuntu-26.04 (glibc 2.43), an empty `LOCPATH` folder does not hide C.UTF-8: `LC_ALL=C.UTF-8 locale charmap` still gives `UTF-8`. So no test can remove the locale this way, and T063 case (c) skips. **experiment** (finding, T063)
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
- The bytes per commit in the service (about 46 to 90, R6), and the service CPU during an End load: P3 and P8. T012 measured the topology table alone at 59.0 bytes per commit on H200K (R18). Closed for H200K: T030 recorded the End load CPU and 59.0 bytes per loaded commit (R19, R21). The memory record at 1,000,000 commits stays with T054.
- Whether Git prints a repeated parent in one `rev-list --parents` line for a commit object that it accepts: closed. `hash-object -t commit -w` accepts it, and `rev-list --parents` prints the parent twice (T003, R15, **experiment**).
- The `save_commit_buffer` recollection: open. P0.4 measured the extra search memory (R14), but no plan step reads the Git source yet (plan.md O-1).
- `init --template=` copies nothing; an explicit `--git-dir` skips the ownership check: P0.5 showed both on Git 2.56.0.windows.1 (R4, **experiment**).
- `refs/stash` as a pattern matches `refs/stash/x`; `%(objectname)` of a symbolic ref gives the target OID: closed. R19 records both (T023, **experiment**).
- The maximum layout height in WebView2: P6.
- `IsHungAppWindow` covers the Tauri main window: P8.
- Shortcut conflicts, T038 record, 2026-10-13. The app key map (`src/frontend/keyboard/shortcuts.ts`) gives each key one action: F10, F5, F6, Shift+F6, Ctrl+Enter, F3, Shift+F3, Ctrl+F, Ctrl+Shift+B, Ctrl+O, Ctrl+R, and Alt+Up/Down. No other handler of the page uses these keys with these modifiers. `tests/contracts/history-list.test.tsx` checks the four new keys and the 001 keys. The shell sets `AreBrowserAcceleratorKeysEnabled` to false and `IsBrowserAcceleratorKeyEnabled` to false for every key (`src-tauri/src/webview.rs`). Microsoft Learn lists Ctrl+F, F3, and Shift+F3 as keys that this setting turns off. It lists Ctrl+Shift+B ("Show Favorites Bar") as a key whose feature does not apply to WebView2. Result: no conflict. **documented** The check of the four keys in the packaged app, and with a non-Latin keyboard layout, stays **unverified** until a live key check.
- The re-read cost of a later step at 1,000,000 commits: closed. T061 recorded the Git time to output lines 1, 2,089, 500,000, and 1,000,000 on H1M (R14, **experiment**).
- The memory after the first load step, with no Git process: P8.
- The Rust shell routes `succeeded` after the service closed the load Job: T055. T025 first result, 2026-10-12: the cargo case `a_succeeded_response_after_a_cancel_closed_the_operation_job_reaches_the_renderer` (dcd9d5d, `src-tauri/src/process_requests.rs`) passed on its first run after T029. Before T029, the shell allowlist has no `loadHistory`, so the case cannot run. Commit 17a8340 replaced it with `a_succeeded_response_of_an_operation_reaches_the_renderer_by_its_request_id` in `src-tauri/src/ipc.rs`. A Job close changes no routing state: only `submit`, `deliver`, and `set_session(None)` change the pending requests. The case passed in the 96c486e run (R20, cargo test). It covers only the routing by `requestId`. **experiment** T055 owns the end-to-end check in the packaged app.

## Results

P0 to P8 record their results here as R14 and later. Tasks with no P step, such as T067 and T068 (R23), also record their results here. Record times and ratios as numbers, never as comparative adjectives.

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
- T006, 2026-10-13, Git 2.56.0.windows.2, the 64fee42 run (R21), five runs per row. The medians are 166.3 MiB (topology) and 446.4 MiB (search) without a commit-graph, and 145.8 MiB (topology) and 148.2 MiB (search) with one. The peaks are 166.3 (5 runs); 446.6, 446.4, 446.4, 446.4, 446.4; 145.8 (5 runs); and 148.1, 148.2, 148.2, 148.2, 148.1 MiB. **experiment**

T061, 2026-10-13, Git 2.56.0.windows.2, H1M, `tests/windows/history-git-memory.test.ts`, the 64fee42 run (R21). The command is the topology `rev-list --parents --date-order --stdin` with no `--skip`. Five runs per row. A record, not a gate. **experiment**

| H1M variant | Peak of the walking Git process up to line 2,089, then ended (MiB) | Median (MiB) |
|---|---|---|
| no commit-graph | 166.3, 166.3, 166.3, 166.3, 166.3 | 166.3 |
| commit-graph | 145.8, 145.7, 145.7, 145.8, 145.8 | 145.8 |

| H1M variant | Output line | Times from the start (ms) | Median (ms) |
|---|---|---|---|
| no commit-graph | 1 | 4,032, 4,049, 4,041, 4,053, 4,053 | 4,049 |
| no commit-graph | 2,089 | 4,040, 4,052, 4,053, 4,056, 4,057 | 4,053 |
| no commit-graph | 500,000 | 4,939, 5,141, 5,117, 4,915, 5,162 | 5,117 |
| no commit-graph | 1,000,000 | 5,807, 6,227, 6,206, 5,788, 6,269 | 6,206 |
| commit-graph | 1 | 645, 649, 650, 652, 647 | 649 |
| commit-graph | 2,089 | 649, 653, 653, 658, 650 | 653 |
| commit-graph | 500,000 | 1,482, 1,713, 1,491, 1,702, 1,485 | 1,491 |
| commit-graph | 1,000,000 | 2,337, 2,802, 2,358, 2,768, 2,361 | 2,361 |

- The first-step peak equals the T006 topology peak of the whole walk on both variants. Without a commit-graph, Git walks the whole graph before the first line (R1).
- A later step that re-reads to line N pays the time to line N. At 1,000,000 commits, the median re-read to the last line is 6,206 ms without a commit-graph and 2,361 ms with one.

## R15 Order facts (P0.2)

T003 (Windows Git 2.56.0.windows.2) and T010 (Ubuntu-26.04 Git 2.55.0), verification run of f002-b0 96c486e, 2026-10-13 (R20). Fixtures: the 19 small fixtures and H200K, each with and without a commit-graph. Start points go to stdin in ascending lowercase hex. **experiment**

| Fact | Windows (T003) | Ubuntu-26.04 (T010) |
|---|---|---|
| Two runs give the same bytes. | 40 of 40 | 40 of 40 |
| `--skip=k` equals the suffix. | 40 of 40 | 40 of 40 |
| The output is equal with and without a commit-graph. | 20 of 20 | 20 of 20 |
| A shuffled stdin gives the same bytes. | 38 of 40; fails on equal-dates (both variants) | 38 of 40; fails on equal-dates (both variants) |
| A reversed stdin gives the same bytes. | 38 of 40; fails on equal-dates (both variants) | 38 of 40; fails on equal-dates (both variants) |
| `--grep` equals the full order without the non-matches. | 40 of 40 | 40 of 40 |
| The distro view bytes equal the Windows Git bytes of the same repository. | not applicable | 40 of 40 |

- The Windows facts above hold for Git 2.56.0.windows.2, the version that T003 expects. **experiment**
- The H1M case of T003 skipped in this run (`ARBARETO_HISTORY_FIXTURES=H200K`). It ran once on 2026-10-12 with Git 2.56.0.windows.1. All facts held on both H1M variants. So the Windows counts of that run were 42 of 42, 21 of 21, and 40 of 42 for the shuffled and the reversed stdin. **experiment**
- The 64fee42 run (R21, `ARBARETO_HISTORY_FIXTURES=H200K,H1M`) ran T003 on H1M with Git 2.56.0.windows.2. The Windows counts were 42 of 42 (two runs, `--skip`, `--grep`), 21 of 21 (commit-graph), and 40 of 42 (shuffled and reversed stdin, both equal-dates variants fail). T010 gave the Ubuntu-26.04 counts of the table again. **experiment**
- Repeated parent (data-model §3), T003, Git 2.56.0.windows.2, the 64fee42 run: `hash-object -t commit -w` exits 0 for a commit object with the same `parent` line twice. `rev-list --parents` then prints that parent twice in the commit's line. **experiment**
- The `--skip` values on H200K were k = 1, 255, 256, 257, 19,393 (a merge run), and 199,999. On equal-dates and merges-only, the merge run is at k = 2. On H1M (2026-10-12 and the 64fee42 run) they were k = 1, 255, 256, 257, 101,159 (a merge run), and 999,999, on both variants.
- On equal-dates, another stdin order gives the same row set in another order. The first difference is at row 0 or 1. So the ascending start-point order of R1 stays a requirement.
- `rev-list --stdin` with no start point exits 0 and prints nothing (empty fixture, both Gits).
- T010 copies each Windows-built repository into the owned distro folder through a `tar` stream. So both Gits read byte-equal repositories.

## R16 Fixtures and layout (P0.1, P0.3)

- T001, 2026-10-12: H200K and H1M have 200,000 and 1,000,000 commits. Each variant has the expected commit-graph state. The two variants are two builds of one stream. Their refs, index entries, and working files are equal. **experiment**
- T001, 2026-10-13 (R20): the small fixture and H200K cases pass. The H1M case did not run, because it runs only on request (`ARBARETO_HISTORY_FIXTURES=H1M`).
- T001, the 64fee42 run (R21, `ARBARETO_HISTORY_FIXTURES=H200K,H1M`): the small fixture, H200K, and H1M cases pass. That run built H1M. T005 gave the table below again. **experiment**
- Measurement note: a work-session sampler measured the next three items. No repository test reproduces them. **experiment**
  - Build time per variant, from the folder creation to the manifest write: H200K 9.8 s and 10.3 s; H1M 55.1 s and 59.3 s (without and with a commit-graph). Disk size: H200K 35.2 MiB and 46.7 MiB; H1M 176.3 MiB and 233.5 MiB.
  - During the H1M build, the largest Git process peaked at 205 MiB of private bytes (2-second samples).
  - T003 on H1M holds about 2 GiB of private bytes in the Bun test process. The host then had 4,790 MB available.
- T005 on H200K, before the O-5 fix: 2,173 rows were limited. Only 93 of them need more than 24 lanes. The other 2,080 had 9 to 24 open lanes, but a lane at index 24 or above stayed open. **experiment**
- T005 now asserts that a row is limited exactly when it needs more than 24 lanes. A row needs the larger of two counts: its open lanes above plus one lane for a new node, and its open lanes below. On the old layout, this check fails on 2,080 H200K rows and on 24 octopus-65 rows. **experiment**
- After the O-5 fix, a limited row closes the free lane slots and keeps the lane order (plan.md O-5). T005, 2026-10-13 (R20): on every fixture, each cell rebuilt from a checkpoint equals the fold. "Traced lanes" end at their parent nodes through the cells. The edges of the limited rows start and end through the lane state. **experiment**

| Fixture | Rows | Traced lanes | Limited rows | Edges started by limited rows | Lanes ended by limited rows | Roots | Shallow boundaries | Lane count |
|---|---|---|---|---|---|---|---|---|
| equal-dates | 601 | 598 | 0 | 0 | 0 | 1 | 0 | 5 |
| clock-skew | 81 | 79 | 0 | 0 | 0 | 1 | 0 | 3 |
| criss-cross | 10 | 8 | 0 | 0 | 0 | 1 | 0 | 3 |
| octopus-10 | 23 | 22 | 0 | 0 | 0 | 1 | 0 | 10 |
| octopus-65 | 68 | 24 | 43 | 107 | 43 | 1 | 0 | 24 |
| merges-only | 302 | 300 | 0 | 0 | 0 | 2 | 0 | 3 |
| tips-50 | 151 | 24 | 103 | 103 | 77 | 1 | 0 | 24 |
| shallow | 3 | 2 | 0 | 0 | 0 | 0 | 1 | 1 |
| tag-chains | 4 | 3 | 0 | 0 | 0 | 1 | 0 | 1 |
| tag-tree-blob | 2 | 1 | 0 | 0 | 0 | 1 | 0 | 1 |
| stash | 5 | 4 | 0 | 0 | 0 | 1 | 0 | 2 |
| notes | 3 | 2 | 0 | 0 | 0 | 1 | 0 | 1 |
| pull-ref | 3 | 2 | 0 | 0 | 0 | 1 | 0 | 1 |
| unborn-beside | 4 | 2 | 0 | 0 | 0 | 1 | 0 | 2 |
| empty | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| detached | 3 | 2 | 0 | 0 | 0 | 1 | 0 | 1 |
| remote-head | 4 | 3 | 0 | 0 | 0 | 1 | 0 | 1 |
| long-body | 3 | 2 | 0 | 0 | 0 | 1 | 0 | 1 |
| refs-10001 | 2 | 1 | 0 | 0 | 0 | 1 | 0 | 1 |
| H200K | 200,000 | 199,899 | 93 | 96 | 93 | 1 | 0 | 24 |

- T010, 2026-10-13 (R20): Ubuntu-26.04 has Git 2.55.0 and the C.UTF-8 locale (`LC_ALL=C.UTF-8 locale charmap` gives `UTF-8` with exit 0). Both probe runs give the contract matches with the distro Git and `LC_ALL=C.UTF-8` (2 of 2, R17). **experiment**

## R17 Matching facts (P0.5)

T004 (Windows Git 2.56.0.windows.2) and T010 (Ubuntu-26.04 Git 2.55.0), 2026-10-13 (R20). The R4 facts marked T004 came from Git 2.56.0.windows.1 on 2026-10-12. This run shows them again on 2.56.0.windows.2. **experiment**

- Probe run 1 (виправлення є і ї ґ ß) and probe run 2 (ВИПРАВЛЕННЯ Є І Ї Ґ ẞ) both match: windows-1251 Виправлення, ẞ, ß, Ґ, ґ, Ї, ї, І, і, Є, є, ВИПРАВЛЕННЯ, виправлення. Neither matches SS or ascii. The Windows Git and the Ubuntu-26.04 Git give the same sets.
- `init --bare --template=` writes only `HEAD` and `config`. The default template adds `description`, 14 `hooks/*.sample` files, and `info/exclude`. `init --template=` adds none of them.
- With another owner, discovery exits 128, and an explicit `--git-dir` exits 0. The probe runs then give the contract matches.
- With `grep.patternType=perl`, `--grep=probe.` matches 15 of 15 probe commits without `--fixed-strings` and 0 with it.
- With an inherited `GIT_CONFIG_PARAMETERS`, `config --get` gives `ISO-8859-1` alone and `UTF-8` with `-c`. The probe runs give the contract matches.
- With `LC_ALL=C`, the Windows probe runs give the contract matches.

## R18 Topology table and reduced graph (P1)

T012 and T013, 2026-10-13 (R20), Windows Git 2.56.0.windows.2. **experiment**

- T012 on H200K: 200,000 rows. The topology table holds 11,801,562 bytes of typed arrays, 59.0 bytes per commit (SHA-1, allocated capacity). The batch 1 run of 2026-10-12 gave 11,539,418 bytes, 57.7 bytes per commit.
- T013 runs 7 match sets on each fixture: none, all, one, p0.5, p0.1, p0.01, and p0.3 with the parentless rows. The table gives the sums over the 7 sets. On every fixture, the reduced edges equal the BFS oracle.

| Fixture | Rows | Matches | Reduced edges | Skip commits | "No earlier matching commit" | Matching roots | Matching shallow boundaries | Step time (ms) | With oracle checks (ms) |
|---|---|---|---|---|---|---|---|---|---|
| equal-dates | 601 | 1,144 | 1,454 | 558 | 6 | 3 | 0 | 3 | 8 |
| clock-skew | 81 | 161 | 172 | 60 | 3 | 3 | 0 | 0 | 1 |
| criss-cross | 10 | 26 | 34 | 9 | 1 | 4 | 0 | 0 | 0 |
| octopus-10 | 23 | 48 | 59 | 13 | 8 | 2 | 0 | 0 | 0 |
| octopus-65 | 68 | 119 | 177 | 7 | 35 | 2 | 0 | 0 | 0 |
| merges-only | 302 | 579 | 2,053 | 1,233 | 4 | 4 | 0 | 1 | 3 |
| tips-50 | 151 | 295 | 232 | 30 | 61 | 2 | 0 | 0 | 1 |
| shallow | 3 | 6 | 2 | 0 | 2 | 0 | 2 | 0 | 0 |
| tag-chains | 4 | 8 | 4 | 0 | 1 | 3 | 0 | 0 | 0 |
| tag-tree-blob | 2 | 6 | 2 | 0 | 0 | 4 | 0 | 0 | 0 |
| stash | 5 | 13 | 10 | 1 | 1 | 3 | 0 | 0 | 0 |
| notes | 3 | 6 | 2 | 0 | 2 | 2 | 0 | 0 | 0 |
| pull-ref | 3 | 6 | 2 | 0 | 2 | 2 | 0 | 0 | 0 |
| unborn-beside | 4 | 8 | 4 | 0 | 1 | 3 | 0 | 0 | 0 |
| empty | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| detached | 3 | 6 | 2 | 0 | 2 | 2 | 0 | 0 | 0 |
| remote-head | 4 | 8 | 4 | 0 | 1 | 3 | 0 | 0 | 0 |
| long-body | 3 | 6 | 2 | 0 | 2 | 2 | 0 | 0 | 0 |
| refs-10001 | 2 | 6 | 2 | 0 | 0 | 4 | 0 | 0 | 0 |
| H200K | 200,000 | 382,109 | 879,711 | 599,876 | 13 | 3 | 0 | 204 | 10,418 |

- The times come from one run on a test worker. They are records, not gates.
- The 64fee42 run (R21) gave the same counts on every fixture. H200K took 192 ms in the step and 10,335 ms with the oracle checks. T012 gave 11,801,562 bytes again, 59.0 bytes per commit.

## R19 Ref capture and view (P3)

T023 and T024, 2026-10-13 (R20), Windows Git 2.56.0.windows.2. **experiment**

- `%(objectname)` of the symbolic ref `refs/remotes/origin/HEAD` gives the target OID (R7).
- The `for-each-ref` pattern `refs/stash` matches `refs/stash/x` (R7). The service skips such records.
- A load cancel on H200K without a commit-graph ends in 12 ms. T024 asserts at most 1,000 ms. The 64fee42 run (R21) gave 14 ms.
- T023, the 64fee42 run: both ref facts above held again.

T030 records, 2026-10-13, the 64fee42 run (R21), Windows Git 2.56.0.windows.2, H200K without a commit-graph. **experiment**
- An End load of 200,000 rows took 2,097.3 ms wall time. CPU time: 2,125.0 ms in the service process and 1,312.5 ms in 2 Git processes. The service runs inside the test process, so the service CPU includes the test harness.
- After the End load, the view topology holds 11,801,562 bytes of typed arrays for 200,000 rows: 59.0 bytes per loaded commit (SHA-1, allocated capacity). The lane checkpoints are JS objects, and the count leaves them out.
- The End load sent 5 `history-load` progress events in 2,097.3 ms. The contract allows at most 4 per second (Δ3 `loadHistory`).
- An earlier run of the same test on 62c027f gave 2,194.7 ms wall time, 2,109.0 ms service CPU, and 1,375.0 ms Git CPU in 2 processes.

## R20 Verification run of f002-b0 96c486e

Run of 2026-10-12 and 2026-10-13 for T011, T020, T030, and T050. Host: Windows 11 Pro 10.0.26300 x64, Bun 1.4.3, Git 2.56.0.windows.2 (`C:\Program Files\Git\ucrt64\bin\git.exe`). WSL: Ubuntu-26.04 with Git 2.55.0. T020 meets its pass condition, and the batch 1 review is recorded. T011 waits for a green `test:windows`, the H1M cases, and the batch 0 review. T030 waits for the batch 2 review fixes and the End load records. T050 waits for the batch 4 review fixes, the manual check, and batch 3.

| Step | Exit | Counts |
|---|---|---|
| `bun install --frozen-lockfile` | 0 | no changes |
| `bun run typecheck` | 0 | |
| `bun run export:schemas --check` | 0 | schema files current |
| `bun run build` and `bun run build:service` | 0 | |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml` | 0 | |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | 0 | 441 passed, 0 failed, 4 ignored |
| cargo clippy with `-D warnings` | 0 | |
| cargo fmt check | 0 | |
| `bun run test:all`, `ARBARETO_WSL_DISTRO=Ubuntu-26.04`, `ARBARETO_HISTORY_FIXTURES=H200K`, `ARBARETO_TEST_WORKERS=6` | 0 | 151 files, 4,928 tests, 0 fail. Parallel step: 130 files, 4,573 pass, 36 skip, 2,027.4 s. Serial step: 21 files, 311 pass, 8 skip, 2,382.2 s. |
| `tests/wsl/registration.test.ts` on Ubuntu-24.04 | not in the log | 42 tests: 38 pass, 4 skip, 0 fail |
| `bun run test:windows` | 1 | 10 files, 112 tests: 107 pass, 4 skip, 1 fail |

- `ORIGIN`: `test:all` prints 1,256 lines, all under `C:\Projects\arbareto-l1`. Each control mutation run also prints its lines under this checkout.
- `test:all` skips (44): golden vectors of another platform 29; POSIX-only cases 2; Linux `F_SETPIPE_SZ` 1; `ssh-server` 3; `history-fixture-h1m` 2 (T001, T003); `distro-git-below-2.55` 2; `two-test-distros` 1; `other-account-owner` 1; `disposable-volume` 1; `fifo` 1; `restart-keeps-lingering` 1.
- Ubuntu-24.04 skips (4): `distro-git-2.55` 4.
- `test:windows` skips (4): `display-off` 1; live input needs the measurement account 2; `history-fixture-h1m` 1 (T006).
- `rg -n "readHistory\b|layoutHistory" src` prints nothing. In `src-tauri/src` and `tests`, it finds only the T048 assertions: the test module of `src-tauri/src/ipc.rs`, `tests/contracts/operation-registry.test.ts`, and `tests/contracts/envelope.test.ts`.
- `test:all` prints 209 `OBSERVATION` lines. 96 lines belong to 002 tasks (T001, T003, T004, T005, T010, T012, T013, T023, T024), and R15 to R19 hold them. The other 113 lines belong to 001 tasks.
- The T286 observation retired with `HISTORY_STREAM_BYTES`. Commit 517aa41 removed its line, and b8cabe9 removed the constant. `tests/git/history-parser.test.ts` keeps `TASK = "T286"` for its `SKIP` lines.

Control mutations. Each run went red with the edit, and green after the undo.

| Task | Edit | Red | Green |
|---|---|---|---|
| T011 | `cellsOf` in `src/git-service/history-layout.ts` starts from `EMPTY_STATE`. | `tests/git/history-layout.test.ts`: 2 of 3 fail (every small fixture, H200K). | 3 pass |
| T020 | `src/contracts/filter-text.ts:23` accepts U+005C followed by U+0045. | `tests/contracts/filter-text.test.ts`: 2 of 5 fail. | 5 pass |
| T030 | `src/git-service/history-topology.ts:213` compares only the last held row. | `tests/git/history-stale.test.ts`: 2 of 16 fail (a difference at row 0, and inside the held rows). | 16 pass |
| T050 | `virtualTopOf` in `src/frontend/history/HistoryList.tsx` returns `scrollTop`. | `tests/contracts/history-list.test.tsx`: 3 of 29 fail (the last-row case at 1,000,000 rows and 34 DIPs, and at 4,000,000 rows and 26 and 34 DIPs). | 29 pass |

Open items:
- `test:windows` fails T240 "installed app selects Git, opens and cancels the folder picker, and reads the status regions": `TIMEOUT: no focus on "Open folder… (Ctrl+O)"` after 10,000 ms. The test drives the installed app `%LOCALAPPDATA%\Arbareto\arbareto.exe` (SHA-256 `d21b7a5f…`). That build comes from main, not from this checkout. The cause is under investigation.
- The independent reviews of batches 0 and 4 are not recorded.
- T030 waits for the batch 2 review fixes and the End load records.
- T030: the CPU of an End load and the bytes per loaded commit on H200K are not recorded.
- T045: no comparison with the approved mockup canvas is recorded. The user compares the app with the canvas.
- T050: the quickstart.md "Manual check in the app" did not run.

## R21 Verification run of f002-b3 64fee42

Run of 2026-10-13, 06:21 to 07:40 local, in `C:\Projects\arbareto-l4` at 64fee42, for T001 to T003, T006, T011, T030 to T037, T050, T061, and T063. Host: Windows 11 Pro 10.0.26300 x64, Bun 1.4.3, Git 2.56.0.windows.2 (`C:\Program Files\Git\ucrt64\bin\git.exe`). WSL: Ubuntu-26.04 with Git 2.55.0, and Ubuntu-24.04 with Git 2.43.0 for the registration file. The run built H1M. Each batch review of 002 is recorded ("Batch reviews").

| Step | Exit | Counts |
|---|---|---|
| `bun install --frozen-lockfile` | 0 | no changes |
| `bun run typecheck` | 0 | |
| `bun run export:schemas --check` | 0 | schema files current |
| `bun run build` and `bun run build:service` | 0 | |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml` | 0 | |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | 0 | 444 passed, 0 failed, 4 ignored |
| cargo clippy with `-D warnings` | 0 | |
| cargo fmt check | 0 | |
| `bun run test:all`, `ARBARETO_WSL_DISTRO=Ubuntu-26.04`, `ARBARETO_HISTORY_FIXTURES=H200K,H1M`, `ARBARETO_TEST_WORKERS=6` | 1 | 154 files, 5,014 tests. Parallel step: 132 files, 4,634 pass, 36 skip, 2 fail, 2,028.2 s. Serial step: 22 files, 335 pass, 7 skip, 0 fail, 2,682.2 s. |
| `test:all` rerun on 270a0a8 | 1 | 154 files, 5,015 tests. Parallel step: 132 files, 4,636 pass, 36 skip, 1 fail. Serial step: 22 files, 334 pass, 7 skip, 1 fail. Both failures are intermittent 001 tests. |
| Rerun on 2173c40: `bun install --frozen-lockfile`, `bun run typecheck`, `bun run export:schemas --check`, `bun run build` and `bun run build:service`, and `bun run test:all` with `ARBARETO_WSL_DISTRO=Ubuntu-26.04` | 0 | 154 files, 5,015 tests, 0 fail. Parallel step: 132 files, 4,637 pass, 36 skip, 0 fail, 2,258.5 s. Serial step: 22 files, 335 pass, 7 skip, 0 fail, 2,776.6 s. |
| `tests/wsl/registration.test.ts` on Ubuntu-24.04 | 0 | 42 tests: 38 pass, 4 skip, 0 fail |
| `bun run test:windows`, `ARBARETO_HISTORY_FIXTURES=H200K,H1M` | 0 | 10 files, 113 tests: 110 pass, 3 skip, 0 fail |

- The two `test:all` failures are outside 002. (1) The portability ban test "shared source outside the platform files holds no native path rule" found a `process.platform` check in `notices.ts`; 14675a1 on main fixed it. (2) The held-arrow case of `tests/contracts/commit-details.test.tsx` hit the 5 s test timeout under six workers; 8908d08 fixed it. 270a0a8 holds both fixes.
- The 270a0a8 rerun failed on two intermittent 001 tests. (1) `tests/contracts/workbench-mount.test.tsx` B4-1 counted 3 reads, not 2. The real 1 s poll fired in the settle window. This was a test defect, and 688a49e fixes it. (2) The WSL F31 silent-fetch case (T232) failed with `REPOSITORY_UNAVAILABLE`. The cause was environmental (next item).
- Environmental cause of F31: at about 06:28 UTC, an unattended upgrade in Ubuntu-26.04 installed libc6. The package then re-executed systemd (`daemon-reexec`). During that step, `systemd-run` could not start the scope of the call. The wrapper exited nonzero, and the service reported `REPOSITORY_UNAVAILABLE`. Timer facts: `apt-daily.timer` and `apt-daily-upgrade.timer` start these upgrades in the test distro, and the 2173c40 run saw neither timer fire. **experiment**
- Product gap from F31: the WSL wrapper reports a scope start failure as a Git exit. `systemd-run` exits 1 for every start failure, from systemd 258 on. Feature 001 fixes this later in a new task. The design of a scope start byte exists.
- The 2173c40 rerun is green. `ORIGIN`: 1,290 lines, all under `C:\Projects\arbareto-l4`. The T001 and T003 H1M cases ran. Skips (43): golden vectors of another platform 29; `ssh-server` 3; `distro-git-below-2.55` 2; `disposable-volume` 1; `fifo` 1; `restart-keeps-lingering` 1; `empty-locpath-hides-c-utf8` 1 (T063 case (c)); `two-test-distros` 1; skips by test name 4.
- From 64fee42 to 2173c40, no file changed in `src-tauri`, `tests/windows`, `tests/wsl`, or the 002 service and test code. The changes are `Workbench.tsx`, `notices.ts`, three contract tests, and spec files. So the 64fee42 results of cargo, `test:windows`, Ubuntu-24.04, and the control mutations stand.

Ticks after the 2173c40 rerun. Each task cites its proof.

| Task | Proof |
|---|---|
| T001 | The small fixture, H200K, and H1M cases pass in the 2173c40 `test:all` (R16). |
| T002 | The 19 small fixtures, H200K, and H1M build, and T001 passes (R16). |
| T003 | The order facts and the repeated-parent fact hold on Git 2.56.0.windows.2, H200K, and H1M (R15). |
| T006 | `test:windows` on 64fee42 is green, and R14 holds the five H1M peaks and medians per row. |
| T011 | The batch 0 commands exit 0 with `ORIGIN` lines under this checkout (64fee42, 2173c40). The `cellsOf` mutation went red, then green. README "Development" names `ARBARETO_HISTORY_FIXTURES`. "Batch reviews" holds the batch 0 review. |
| T030 | The batch 2 commands exit 0 (64fee42 cargo, 2173c40 build and `test:all`). R19 holds the End load CPU and 59.0 bytes per loaded commit. The re-read mutation went red, then green. "Batch reviews" holds the batch 2 review. |
| T061 | `test:windows` on 64fee42 is green, and R14 holds the first-step peaks and the times to lines 1, 2,089, 500,000, and 1,000,000. |
| T031 | `tests/contracts/git-commands.test.ts` asserts the exact Δ3 search array and a leading "-" inside `--grep=`. Green in 2173c40. |
| T032 | `tests/git/history-search.test.ts` is green in 2173c40 (R22). |
| T033 | `tests/git/history-matching.test.ts` is green in 2173c40, with the Windows end-to-end case on the reference host. |
| T034 | `tests/git/history-highlight.test.ts` is green in 2173c40. |
| T035 | T031 to T033 pass in 2173c40 (R22). |
| T036 | T034 passes in 2173c40. |
| T037 | `typecheck` and `test:all` exit 0 in 2173c40. The `--regexp-ignore-case` mutation went red, then green. R22 holds the records. "Batch reviews" holds the batch 3 review. |
| T063 | The cargo cases pass on 64fee42, and `tests/wsl/history-wsl.test.ts` passes in 2173c40 with case (c) skipped as a finding (R10, R22). Both control mutations went red, then green. |
- `ORIGIN`: `test:all` prints 1,290 lines, all under `C:\Projects\arbareto-l4`. Each control mutation run also prints its lines under this checkout.
- `test:all` skips (43). Parallel step (36): golden vectors of another platform 29; `distro-git-below-2.55` 2; POSIX-only cases 2; `other-account-owner` 1; `disposable-volume` 1; `two-test-distros` 1. Serial step (7): `ssh-server` 3; Linux `F_SETPIPE_SZ` 1; `fifo` 1; `restart-keeps-lingering` 1; `empty-locpath-hides-c-utf8` 1 (T063 case (c)).
- The T063 case (c) skip is a finding. On Ubuntu-26.04 (glibc 2.43), `LC_ALL=C.UTF-8 locale charmap` with an empty `LOCPATH` folder gives `UTF-8` with exit 0, not `ANSI_X3.4-1968`. So an empty `LOCPATH` does not hide C.UTF-8, and the case cannot make the locale missing (R10, R22).
- No `history-fixture-h1m` skip remains: the T001, T003, T006, and T061 H1M cases ran.
- Ubuntu-24.04 skips (4): `distro-git-2.55` 4.
- `test:windows` skips (3): `display-off` 1; live input needs the measurement account 2.
- `rg -n "readHistory\b|layoutHistory" src` prints nothing. In `src-tauri/src` and `tests`, it finds only the T048 assertions: the test module of `src-tauri/src/ipc.rs`, `tests/contracts/operation-registry.test.ts`, and `tests/contracts/envelope.test.ts`.
- `test:all` prints 215 `OBSERVATION` lines. 102 lines belong to 002 tasks (T003, T004, T005, T010, T012, T013, T023, T024, T030, T032, T063). The other 113 lines belong to 001 tasks. `test:windows` prints 48 lines, all of 002 (T006, T061). R10 and R14 to R19 and R22 hold the 002 lines.

Control mutations. Each run went red with the edit, and green after the undo.

| Task | Edit | Red | Green |
|---|---|---|---|
| T011 | `cellsOf` in `src/git-service/history-layout.ts` starts from `EMPTY_STATE`. | `tests/git/history-layout.test.ts`: 2 of 3 fail (every small fixture, H200K). | 3 pass |
| T020 | `src/contracts/filter-text.ts` accepts U+005C followed by U+0045. | `tests/contracts/filter-text.test.ts`: 2 of 5 fail. | 5 pass |
| T030 | `src/git-service/history-topology.ts` compares only the last held row. | `tests/git/history-stale.test.ts`: 3 of 19 fail (a difference at row 0, inside the held rows, and inside the rows that the view does not serve yet). | 19 pass |
| T037 | The search argv builder in `src/git-service/commands.ts` drops `--regexp-ignore-case`. | `tests/git/history-matching.test.ts`: 5 of 22 fail. | 22 pass |
| T050 | `virtualTopOf` in `src/frontend/history/HistoryList.tsx` returns `scrollTop`. | `tests/contracts/history-list.test.tsx`: 4 of 35 fail (the last-row case at 1,000,000 rows and 34 DIPs, and at 4,000,000 rows and 26 and 34 DIPs; the short list). | 35 pass |
| T063 | `matching_probe_command` in `src-tauri/src/wsl.rs` drops the run-length digit check. | cargo test: 2 fail (`wsl::tests::the_matching_probe_refuses_each_broken_argument`, `process_requests::tests::a_wsl_script_run_reaches_the_host_as_the_matching_probe_and_a_broken_one_starts_nothing`). | 444 pass |
| T063 | `matchingProbe` drops the `trap 'rm -rf -- "$dir"' EXIT` line. | `tests/wsl/history-wsl.test.ts`: case (a) fails at line 253. | 8 pass, 1 skip (case (c)) |

Open items:
- The WSL scope start gap (F31): feature 001 gets a new task.
- T045: no comparison with the approved mockup canvas is recorded. The user compares the app with the canvas.
- T050: the quickstart.md "Manual check in the app" did not run.

## R22 Search (P5)

T032 and T063, the 64fee42 run (R21), Windows Git 2.56.0.windows.2 and Ubuntu-26.04 Git 2.55.0. **experiment**

- T032, H200K, text "marker": 4,000 matches. 1,351 filter rows draw an edge that skips commits.
- T032, H200K with a commit-graph, text "commit" on a new view: 198,400 matches. The search queue (data-model §6) held at most 98,650 matches.
- T032: a search cancel on H200K without a commit-graph ends in 11 ms. The test asserts at most 1,000 ms.
- T063: WSL search on Ubuntu-26.04 runs one `script` call with `matchingProbe`, then the search. Cases (a), (b), and (d) pass. Case (c) skips: an empty `LOCPATH` does not hide C.UTF-8 on glibc 2.43 (finding, R10).

## R23 Ticks of T067 and T068, 2026-10-22

001 full run 7 at 27ddd40 is green (001 research.md R10 "Full runs 6 and 7"): parallel 6,611 pass, serial 588 pass, 0 fail. All `ORIGIN` lines name `C:\Projects\arbareto-l5`. Commit 32c40ec holds both tasks. From 27ddd40 to d4fc41a, no file of either task changed. The control mutations ran at d4fc41a in `C:\Projects\arbareto-l8`, and each `ORIGIN` line names that checkout. Each source file was restored byte for byte (sha256 check).

| Task | Proof | Edit | Red | Green |
|---|---|---|---|---|
| T067 | `tests/contracts/references-sidebar.test.tsx` is green in run 7. | `ReferencesSidebar.tsx:379` drops `font-semibold` on the current row. | 33 pass, 1 fail ("the current branch name is bold with aria-current and no Current text", line 164). | 34 pass |
| T068 | `tests/contracts/commit-details.test.tsx` is green in run 7. | `CommitDetails.tsx:141` makes the parent button copy the selected commit ID. | 14 pass, 1 fail ("each parent has its own Copy parent ID button, and it copies that parent", line 109). | 15 pass |

## Batch reviews

Each batch verification task passes only after one independent review of its batch is recorded here.

**Batch 1, 2026-10-12.** Independent batch 1 review, reviewer agent (Opus), 2026-10-12. Scope: commits adccfa0 (T015, T018) and dcd9d5d (T014, T025, T027, T029, review fixes) on f002-b0, for src, src-tauri, tests, and README.md, without the merges of main. Verdict: pass. Open items: the cancel guard case proves only routing by requestId (R13 stays unverified until T055); the search policy gate gets its cargo case in this fix; labels and segments are bounded in this fix; children is a contract gap; at: {match} without searchId is a contract gap for T028.

**Batch 0, 2026-10-13.** Independent batch 0 review, reviewer agent (Opus), 2026-10-13. Scope: commits 864d8df and d3d1818 (T001 to T006, T008 to T010) on f002-b0 at 96c486e, for the fixture builder, the fact tests, `history-layout.ts`, and `matching-probe.ts`, without the merges of main. Verdict: pass for the code; T011 stays open. Items and state: the repeated-parent fact for `hash-object` and `rev-list --parents` is closed (62c027f adds the T003 case, R15 holds the fact); the `test:windows` T240 failure outside batch 0 is closed (main T376; R21 `test:windows` 110 pass, 0 fail); the T006 H1M evidence is closed (R14, the 64fee42 run); the Git version of R15 is closed (R15 names 2.56.0.windows.2, and 280d6c8 sets it in `history-order.test.ts`); the T011 mutation line is closed (T011 names `cellsOf`, not a line). Open: T011 waits for the `test:all` rerun on 270a0a8 (R21), closed by the green 2173c40 rerun.

**Batch 2, 2026-10-13.** Independent batch 2 review, reviewer agent (Opus), 2026-10-13. Scope: commit 2908430 (T021 to T024, T026, T028) with the decisions of a154a6a and fe788e5 on f002-b0 at 96c486e, for `history-view.ts`, `history-topology.ts`, `refs-parser.ts`, `commands.ts`, the `session.ts` handlers, and their tests. No earlier batch 2 review exists. Verdict: fix first. Items and state, all fixed in 62c027f: the view served held rows from an unchecked load before the re-read compared them (contract Δ3 `loadHistory`), and now serves only the compared rows, with a test of rows that the view does not serve yet; T030 has the End load CPU and the bytes per loaded commit on H200K (R19); a stop row equal to `HISTORY_VIEW_COMMITS` ends `complete`, not `limited`; a test covers the `history-load` progress rate (R19); the trust revoke gates an open view with `TRUST_REQUIRED` (contract Δ7); `step` and `small` come from `history.ts`. Not verified, no fix: `checkFailedRead` builds a set of up to 4,000,000 OIDs after a nonzero exit (memory and deadline); the lane checkpoints with hundreds of open lanes (memory). The replace check beside the Git start can miss a change in the step that completes; contract Δ3 `loadHistory` allows it. Open: T030 waits for the `test:all` rerun on 270a0a8 (R21), closed by the green 2173c40 rerun.

**Batch 3, 2026-10-13.** Independent batch 3 review, reviewer agent (Opus), 2026-10-13. Scope: commit 17f2ae8 (T031 to T036) on f002-b3, diff 96c486e..17f2ae8, for src and tests. Verdict: fail until four items close. Blocking items and state: `SearchMerge.advance` skipped the first unserved row after the queue emptied, fixed in 62c027f with a unit test; a failed probe step gave `SEARCH_UNSUPPORTED` reason `matching`, and now gives `GIT_FAILED` or `MALFORMED_GIT_OUTPUT` and makes the view stale (62c027f, 280d6c8; contract Δ8 condition 4); WSL search refused, and T063 adds the route through the `run` field `script` (3b2f88a, a203b1d; contract Δ3 "Matching probe", Δ6, Δ11); T031 to T036 are not ticked yet, and they wait for the `test:all` rerun on 270a0a8 (R21), closed by the green 2173c40 rerun. Other items, all fixed: a search merge break makes the view stale (decision 2026-10-13, spec Assumptions; 62c027f); the frontend no longer labels `settled` as commits searched (ee815a4); the filter test fake answers a refused text `rejected` (ee815a4); data-model §7 states that reduced parents are in rising match order (5a3cb8d); an unexpected runner exception aborts the inner load, and the search waits for it (62c027f, 280d6c8); `tests/git/history-matching.test.ts` covers the probe folder removal after a failed step, after a cancel, and a failed removal with the log cause `probe-folder-remove`. Verified: the search argv equals contract Δ3; the `search` policy equals Δ7 in Bun and Rust; the H200K search cancel ends within 1,000 ms with no process left; the probe writes nothing in the user repository. Open contract gaps (contract "Contract gaps"): the 001 §7 cause list does not name `probe-folder-remove`; a canceled WSL probe leaves its `/tmp/arbareto-probe-<uuid>` folder.

**Batch 4, 2026-10-13.** Independent batch 4 review, reviewer agent (Opus), 2026-10-13. Scope: commits 418fa43, de03011, ace1c19, 517aa41, and b8cabe9 on f002-b0 at 96c486e, for the history frontend, the references sidebar, the notice band, the Workbench wiring, the bridge, and the retirement of `readHistory`. Verdict: fail. Blocking items, all fixed in ee815a4: a stopped or failed search ends its `searchId`, and the list returns to the full view (contract Δ3, data-model §6); a load failure with an unhandled code halts the load and shows its code, so no load loop starts; the details pane says that the commit is not in the list only for `target: "none"`; "No earlier matching commit" never shows on a limited row; F3 maps a selection from the other list mode by its OID first. Other items and state: the progress `rows` counter no longer sets the served row count (ee815a4), and its served row count only raises the list height (6cea578); the history-painted and details-ready marks follow plan D7 (ee815a4), and details-ready fires only for a found details read (6cea578); the sidebar takes the density row height (ee815a4); a ref click selects through `selectOid` (ee815a4); filter-mode F3 shows its wait and end states (ee815a4); focus moves to the list when the chip, Cancel, or Refresh unmounts (ee815a4); T044, T046, T047, and T050 name `HistoryList.tsx` (cf5682d); `history-parser.test.ts` keeps `TASK = "T286"`, because its `SKIP` lines use it (R20). The four UI search assumptions agree with the contract text. No live code needs the retired 001 traversal. Not verified: a References notice flash after Refresh (6cea578 orders the reads by a request sequence counter); Ctrl+F and Ctrl+Shift+B on a Cyrillic layout (R13, live key check); "No commits yet" twice in an empty repository. Open: T045 (mockup canvas comparison) and the T050 manual check.

**Re-review, 2026-10-13.** Independent re-review of the batch 2, 3, and 4 fixes, reviewer agent (Opus), 2026-10-13. Scope: commits 62c027f, ee815a4, 3b2f88a, a203b1d, and 00d55ec on f002-b3 at bba6409. Verdict: fix three items first; every earlier blocking item of batches 2, 3, and 4 is closed. Items and state, all fixed: F1, the References notice ordered its reads by `performance.now()`, so equal stamps hid a newer read; a request sequence counter orders them now (6cea578). F2, contract Δ3 named no output code for the WSL probe; Δ3 "Matching probe" now gives `MALFORMED_GIT_OUTPUT` for output in another form and `GIT_FAILED` for a nonzero exit (280d6c8). F3, a failed probe step did not make the view stale in the service; it does now (280d6c8, contract Δ8 condition 4). F5, T061 now imports `HISTORY_LOAD_MARGIN` from `limits.ts` (280d6c8). S1, the search awaits its aborted inner load after a runner exception (280d6c8). S2 and S4, `history-load` progress sends the served row count, and the list grows from it (280d6c8, 6cea578). S3, details-ready fires only for a found details read (6cea578). The Δ7 trust gate of an open view is contract text (280d6c8). The repeated-parent fact is in R15. Verified: the T063 shell checks each script input; the search text reaches no shell parser. Open: T031 to T036 wait for the `test:all` rerun on 270a0a8 (R21), closed by the green 2173c40 rerun; the `probe-folder-remove` cause stays a contract gap (contract "Contract gaps"); `TASK = "T286"` stays.
