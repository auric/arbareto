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

## R1 Page rule: one stream per view

- **Decision**: Each view reads one `rev-list --parents --date-order --stdin` stream. The service reads it to the end at full speed. A resume after Cancel or a deadline uses the same arguments with `--skip=<N-1>`. The first resumed line must equal row N-1.
- **Rationale**:
  - One stream gives one exact order by construction. **experiment**
  - `--date-order` shows no parent before all its children (git-rev-list(1)). **documented**
  - `--skip` applies after the ordering (rev-list-options). **documented**
  - Joined `--skip` pages give the same order. Each deep page walks the history again: 942 ms at 200,000 commits without a commit-graph, 180 ms with one. **experiment**
  - Git documents no unique order (rev-list-options.adoc:916). Repeatability across two processes is an experiment fact only. **documented** (the gap) and **experiment** (the repeatability)
  - Without a commit-graph, the first row waits for a walk of the whole graph: about 1 s at 200,000 commits, 48 ms with a commit-graph. **experiment**
  - rev-list reads revisions from stdin with `--stdin` (git-rev-list(1)). **documented**
- **Alternatives considered**:
  - A cursor that restarts from the parents not yet sent. It gives another valid order, so the order changes inside a view. Rejected. **experiment**
  - `--skip` pages for every scroll. Each page walks again. Rejected for scrolling; kept only for a resume.
  - A paused stream with backpressure. The memory note of the investigation proposed it ("read with backpressure"). The design rejects it (R2).

## R2 Process model: drain, do not pause

- **Decision**: The load streams as fast as Git and the service run. The service parses each frame into compact arrays. No new shell flow-control frame. No Web Worker.
- **Rationale**:
  - The shell keeps at most 8 chunks per stream, and the service handles each frame before it reads the next (001 contract §6 "Backpressure"; `process_requests.rs:2394`). A paused stream would stall the service pipe for every operation. **documented**
  - Without a commit-graph, Git walks the whole graph before the first row and holds that memory. A paused stream keeps the memory for the life of the view. A drained stream lets Git exit after a few seconds. **experiment** (the walk) and **unverified** (the hold time)
  - The cost is about 1-3 µs per row, so about 2 ms per 64 KiB frame. Other requests wait at most one frame. **unverified**
  - A 1M-commit drain is about 1,350 frames of 64 KiB, about 115 MB. The cost of the strict JSON decoder over that volume is unknown. **unverified**
- **Alternatives considered**: A per-call output credit frame. Left out. Add it when a qualified fixture beyond about 2M commits must stay within the budget.

## R3 Graph layout: one step function with checkpoints

- **Decision**: The service runs the lane layout as a pure step `layoutStep(lanes, row)`. It stores a checkpoint every 256 rows. The cell of row i comes from the checkpoint at ⌊i/256⌋·256.
- **Rationale**:
  - The 001 layout (`lanes.ts`) can run page by page with equal results, when it carries the output lane array and the set of sent OIDs. This is a proof from the code. No test has shown it. **unverified** (P0.3 tests it)
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
  - `-F -i` folds Cyrillic, Ukrainian є ї ґ і, and ß against ẞ, never against "SS", under those settings. **experiment**
  - `--fixed-strings` overrides `grep.patternType`. **unverified**
  - The `-c` value comes after an inherited `GIT_CONFIG_PARAMETERS`, so it wins. **unverified**
  - FR-023 for the rest of Unicode rests on PCRE2 caseless matching. **unverified**
  - `git version --build-options` does not report PCRE2. No Git signal tells whether Git uses PCRE2. This is a contract gap. The probe covers only the probed cases. **experiment**
  - The Windows command line caps a pattern near 32,767 characters. The plan sets 1,024 UTF-8 bytes. **documented** (Win32 command line limit)
  - `init --template=` copies nothing, and an explicit `--git-dir` gets no ownership refusal. **unverified** (P0.5 tests both)
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
  - Git alone can use 100-300 MB during a search on 1M commits without a commit-graph. The design recalls that `builtin/rev-list.c` sets `save_commit_buffer` for `--grep`, so the limited walk keeps every commit buffer. **unverified** (P0.4 measures it; plan.md open item O-1)
  - Linux Git memory is not part of the Windows process tree. The WSL scope `memory.peak` can record it. **unverified**
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
- **Alternatives considered**: The Git Extensions exclusion list. Rejected for explicit namespaces (spec Assumptions).

## R8 History list: why the installed virtualizer does not fit

- **Decision**: The history list uses its own fixed-height row arithmetic. ChangesPane keeps `@tanstack/react-virtual`. This follows the project rule "prefer libraries": the plan checked the installed library first.
- **Rationale**:
  - `@tanstack/virtual-core` 3.17.11 builds a `Float64Array(count*2)` and an items array of `count`. It rebuilds them from index 0 whenever `count` changes (`node_modules/@tanstack/virtual-core/dist/esm/index.js:673-705`). A load that grows `count` to 1M rows repeats O(n) work in the renderer. **documented** (code)
  - The library has no fix for the maximum element height of the browser. **documented** (code)
  - Chromium's LayoutUnit maximum is about 33,554,431 px. 1M rows at the comfortable density need about 34M px. **unverified** in WebView2
  - The fixed-height window computes the first row as `round(scrollTop / maxScrollTop · (total − visibleRows))`, with `maxScrollTop = min(total·rowHeight, MAX_LAYOUT_PX) − viewportHeight` (plan.md D6). Its work does not grow with the history.
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
  - PCRE2 and the C.UTF-8 locale in each distro, the order facts with the distro Git, and the relay throughput for a 1M drain. **unverified** until the distro runs
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

## R13 Open facts

These stay **unverified** until the named step runs:
- Git peak memory during load and search: P0.4.
- About 48 bytes per commit in the service, and the service CPU during the drain: P3 and P8.
- The `save_commit_buffer` recollection: P0.4.
- `init --template=` copies nothing; an explicit `--git-dir` skips the ownership check: P0.5.
- `refs/stash` as a pattern matches `refs/stash/x`; `%(objectname)` of a symbolic ref gives the target OID: P3.
- The maximum layout height in WebView2: P6.
- `IsHungAppWindow` covers the Tauri main window: P8.
- The shortcut conflicts with the 001 keyboard map: P6.

## Results

P0 to P8 record their results here as R14 and later. Record times and ratios as numbers, never as comparative adjectives.
