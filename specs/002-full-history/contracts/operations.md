# Operation Contract Deltas: Full History and Commit Message Filter

This file lists only the changes to the feature 001 contract, `specs/001-desktop-qualification/contracts/operations.md`. Each delta cites its 001 section. Every 001 rule that no delta replaces stays in force. "001 §n" means that file.

## Δ1 Transport (001 §1)

- Five new renderer operations: `openHistory`, `loadHistory`, `readHistoryRows`, `searchHistory`, `closeHistory`. Each has one Tauri command and one zod schema, as 001 §1 "Renderer request body" and "Schemas" require.
- The five operations are not native-first. The shell reads only `operation` and `requestId`, and it forwards the body unchanged (001 §1 steps 4, 5, and 7). The service zod schemas check every payload range and give `INVALID_REQUEST`. The shell keeps only the 001 §5 request bound of 1 MiB (`FRAME_LIMIT`).
- No new channel frame.

## Δ2 Envelope (001 §2)

- `openHistory` carries `repositoryId` and `repositoryGeneration`. A stale generation gives `REPOSITORY_CHANGED` at acceptance, as for 001 `readHistory`.
- `loadHistory`, `readHistoryRows`, `searchHistory`, and `closeHistory` carry `repositoryId`. Their target is `viewId`, an opaque §2 identifier that the service issues.
- `searchId` is the `operationId` of a `searchHistory` request. The renderer takes it from the accepted event of that request (001 §2). So the renderer can read filter rows from the first match on.
- 001 §2 "Only `cancel` and `getOperation` name an issued one" adds `readHistoryRows` `searchId`.

## Δ3 Public operations (001 §3)

### `openHistory`

- Payload: `{scope: "all" | "current"}`.
- It takes one read slot (001 §5 "Pending reads").
- The capture steps run beside the shared listing as held steps (001 §7 "Shared listing", "Held history steps"). No captured data leaves before `trust.gate(..., "reads")` passes.
- Every command carries `--no-lazy-fetch --no-optional-locks`.
- Capture:
  1. HEAD: the 001 `captureHead` steps. They are `symbolic-ref -q HEAD`, `rev-parse --verify -q HEAD`, and `show-ref --exists` for an unborn branch.
  2. Refs: `for-each-ref --format=<the exact 001 §3 "References result" eight-field format> refs/heads refs/remotes refs/tags refs/stash refs/replace`. The 001 record checks apply, with these additions:
     - A record named exactly `refs/stash` belongs to the set. A record under `refs/stash/` is skipped. Reason: a pattern matches from the beginning up to a slash (git-for-each-ref(1)).
     - A `refs/replace/` record enters only the topology fingerprint. It is no start point and no label.
     - `commitId` follows the 001 rule. `%(*objecttype)` gives the end of the tag chain. A tag that ends at a tree or a blob gives no start point and no label.
     - A symbolic ref gives no label (spec FR-050).
  3. Topology files: `rev-parse --git-path shallow --git-path info/grafts` gives two paths. The service reads both files with `readBounded` and the 4 MiB bound. It takes a SHA-256 of each. An absent file counts as `absent`.
- Start points:
  - `all`: the unique `commitId` values of the FR-047 records, plus the HEAD OID when HEAD is not unborn.
  - `current`: the HEAD OID only. Rows still show the labels of the captured FR-047 refs (spec FR-048).
  - Order: ascending lowercase hex.
  - Git gets the OIDs on stdin, one per line, through the 001 streamed input (001 §6 "Channel frames").
- Result: `{viewId, scope, generation, head, startCount, refsDigest, shallow}`.
  - `refsDigest` is a SHA-256 over `refname NUL objectname LF` of each FR-047 record, in Git's output order.
  - `head` is the 001 `Head` shape, as `readWorkspace.head`.
- One live view per service session. A new `openHistory` releases the old view. Its running operations end `canceled`. Its `viewId` then gives `UNKNOWN_TARGET`.
- An empty repository gives a view with `startCount` 0.

### `loadHistory {viewId, need}`

- Payload `need`: `{row: n}` with n from 0 to 4,000,000, `{oid}` with an object ID of the view's format, or `{end: true}`.
- It takes no read slot. A second load of the view while one runs gives `BUSY`. A load while a search of the view runs gives `BUSY`.
- Command: `--no-lazy-fetch --no-optional-locks rev-list --parents --date-order --stdin`. Every step uses this argv, with no `--skip`. Policy `read`. `deadlineMs` 120,000, the 001 §6 maximum.
- Stop row S. L₀ is the topology row count at the start. It includes the rows that the view does not serve yet. M is `HISTORY_LOAD_MARGIN` (Δ5).
  - `{row: n}`: S = max(n + 1 + 2·M, 2·L₀).
  - `{oid}`: no stop row until that commit streams at row r. Then S = max(r + 1 + 2·M, 2·L₀). If the commit never streams, the load reads to the end.
  - `{end: true}`, and the load inside a search: no stop row.
- At S rows, the service waits for the fingerprint check of this load. It then sends the process `cancel` for the call and waits for `exit` (Δ6). It ignores that exit code. The load ends `succeeded` with `complete: false`.
- A Git exit 0 at or after row N and before S is the end of the history. The end checks run, and the load ends `succeeded` with `complete: true`.
- Before each load step, the service reads the topology fingerprint again. A difference makes the view stale with `HISTORY_CHANGED` reason `topology`.
  - The service reads the shallow file and the grafts file before Git starts. A change there starts no Git process.
  - The service runs `for-each-ref refs/replace` beside the Git start, in the Job of the load.
  - At the stop row, the service waits for this check before it sends the process `cancel`. Reason: the `cancel` closes the load Job, and that Job also holds the check process.
- The view serves only the rows of a load whose fingerprint check passed. When the check does not finish, for example after a quick cancel, the service keeps the streamed rows but does not serve them. The next load re-reads these rows, compares them, and serves them after its check passes.
- Re-read rule. N is the topology row count at the start. It includes the rows that the view does not serve yet (data-model §1 `rowCount`). For each i below N, streamed row i must equal held row i in OID and parents. The first difference makes the view stale with `HISTORY_CHANGED` reason `order`. A Git exit 0 before row N gives the same result. A nonzero exit before row N follows the `checkFailedRead` rule below. A cancel or a `DEADLINE` before row N adds no row, and the view stays `idle`. The rows from N on append to the view. Reason: Git documents no unique order, so a one-row overlap check cannot prove the earlier rows (plan.md D2).
- Each line holds at most 1 + 64 OIDs (`HISTORY_PARENTS_PER_COMMIT`). A longer line ends the load `limited` with `OUTPUT_LIMIT` and that reason.
- A view holds at most 4,000,000 commits (`HISTORY_VIEW_COMMITS`). At that bound, the service ends the load `limited` with `OUTPUT_LIMIT` and that reason. The loaded rows stay. The view states the limit, and a later `loadHistory` gives the same result without a Git process.
- The service keeps no raw bytes beyond one partial line. The line bound and the commit bound together bound the stream. This replaces the 001 §5 "History page" bound for this stream only.
- These cases give `MALFORMED_GIT_OUTPUT` and a stale view: a duplicate row, a parent that already showed, and a parent still pending at exit 0.
- A parent that repeats inside one line is no error. The topology keeps the parent list as Git prints it. The layout and the reduced graph draw one edge for it (data-model §3).
- Pending parents at a stop row, a cancel, or a `DEADLINE` get no check. They stay with the view. The next step re-reads the held rows unchanged, so it continues with the same pending parents. The pending-parent check runs only at a Git exit 0 at or after row N.
- A nonzero exit before S runs the 001 `checkFailedRead` steps (001 §7 "Missing objects"):
  - a missing object in a partial clone gives `OBJECT_MISSING`;
  - a damaged store without a promisor remote gives `REPOSITORY_UNAVAILABLE`;
  - other failures give `GIT_FAILED`.
  - Known limit: the object check covers only the start points, their parents, and the commits that the view already holds or names as parents. A missing commit outside that set, several steps below every start point, gives `GIT_FAILED`, not `OBJECT_MISSING`. This is the feature 001 `checkFailedRead` limit.
- Progress: phase `history-load`, counter `rows`, at most 4 events per second.
- Results:
  - `succeeded` with `rows` and `complete`. `complete: true` gives the final row count (spec FR-010).
  - `canceled`: the rows stay, and the Job is closed.
  - `failed` with `DEADLINE`: the rows stay. The result carries the copyable 001 remedy `& '<selected Git path>' --no-lazy-fetch -C '<worktree root>' commit-graph write --reachable`, quoted by the T262 builder (001 plan.md "Commit-graph variants"). The application never runs it (spec FR-044). A WSL view gets the same remedy text with `command: null`, because no WSL form of the command exists. For 002 views, `DEADLINE` is the trigger. The 001 trigger rule for other reads stays open (001 plan.md "Commit-graph variants" ties it to the contract §6 and §7 changes after 001 T280 to T283).

### `readHistoryRows`

- Payload: `{viewId, mode, searchId?, at, count, text}`.
  - `mode`: `"full"` or `"filter"`. `"filter"` requires `searchId`. Spec highlight mode is `mode: "full"` with `searchId`. Spec filter mode is `mode: "filter"`.
  - `at`: `{row}`, `{oid}`, `{match: "next" | "previous", from}`, or `{end: true}`. `{match}` requires `searchId`. Without it, the request ends `rejected` with `INVALID_REQUEST`, and no Git process starts.
  - In filter mode, `at: {row: k}` names match k, and each row `index` is its match index. Both count matches in full-history order, not view rows. The filter list length is the match count. `rowCount` stays the view row count (data-model §1). This is a reviewer default.
  - `from` in `at: {match, from}` is a view row index, and it is inclusive. `next` gives the first match at row `from` or later. `previous` gives the last match at row `from` or earlier. This is a reviewer default.
  - `count`: 1 to 512.
  - `text`: `"none"`, `"rows"`, or `"details"`. `"details"` requires `count` 1.
- Target resolution:
  - It returns `target: "found"` with the rows. Only `found` carries rows.
  - While the target is unknown and a load or search of the view runs, the request waits.
  - It returns `target: "unknown"` when nothing runs.
  - It returns `target: "none"` when no such row exists. This covers spec FR-038 and the FR-008 case where the new refs do not reach the commit.
- Each row holds:
  - `index`, `oid`, `parents`;
  - `cell {node, color, merge, limited, segments, marks}`;
  - In filter mode, each `line` segment of an edge with `direct` false carries `skip: true`. Other segments omit `skip`.
  - `labels [{kind, name, invalidUtf8}]` and `checkout`;
  - `match` (true, false, or null) when the payload has `searchId`;
  - with `text: "rows"`: `subject`, `author`, `date`, `encoding`, and `invalidUtf8`, or `textLimit` for an object above 256 KiB;
  - with `text: "details"`: also `body`, `bodyCut`, `committer`, `committerDate`, and `children`. `body` and `bodyCut` follow 001 §3 "HistoryPage result" and the 001 §5 "History message body" bound of 16 KiB.
- In filter mode, a row that is not settled yet has `cell: null`.
- In filter mode, `parents` holds the Git parents of the row. The cell draws the reduced parents (data-model §7).
- Text comes from one `cat-file --batch-command -Z` with `contents` lines. Deadline 30 s. `text: "none"` starts no Git process.
- A newer text read cancels an unfinished one of the same view, by the 001 superseded-read rule (001 §5 "Pending reads").
- A text read runs no fingerprint check, because commit text cannot change with the topology.
- A failed text read makes the whole view stale (Δ8): a missing object gives `OBJECT_MISSING`, or `REPOSITORY_UNAVAILABLE` for a damaged store; unreadable commit text gives `MALFORMED_GIT_OUTPUT`, and a nonzero exit gives `GIT_FAILED`. Loads and searches of the view then refuse, and Refresh opens a new view.
- The result stays within `HISTORY_PAGE_BYTES` (8 MiB). It sets `cut` when the bound cuts rows. It also carries `rowCount` (the rows that the view serves, data-model §1), `lanes` (the most lanes so far, at most 24), `complete`, and `bytes` for the renderer cache. `rows` is the row array.

### Refusal result

A view operation that ends without its result value carries `{reason?, remedy?}`. `reason` names the reason of the response code (Δ9). An `OUTPUT_LIMIT` reason is the `limits.ts` export name. `remedy` is `{text, command}`, and `command` is null or a copyable command. `loadHistory` carries `reason` and `remedy` beside `rows` and `complete` in each result.

### `searchHistory {viewId, text}`

- The service refuses before any Git process (spec SC-009):
  - text that is not well-formed UTF-8, or above 1,024 UTF-8 bytes: `UNSUPPORTED_FILTER_TEXT` reason `length` for the bound;
  - U+000A or U+000D: reason `line-break`;
  - U+0000: reason `nul`;
  - U+005C followed by U+0045: reason `quote-end`.
- The first invalid character in text order gives the reason. The byte bound is checked last.
- The service makes these checks. The payload schema bounds no length, and the shell does not read `text` (Δ1).
- Empty text is no search. The renderer sends none (spec FR-027).
- The fingerprint check of `loadHistory` runs first.
- The matching probe runs before the first search of each `gitInstallationId` in a service session ("Matching probe" below).
- Command: `--no-lazy-fetch --no-optional-locks --literal-pathspecs -c i18n.logOutputEncoding=UTF-8 rev-list --date-order --fixed-strings --regexp-ignore-case --grep=<text> --stdin`. Stdin holds the start-point bytes of the view. Policy `search`. Deadline 120,000 ms.
- It takes no read slot. One search runs per view. A new search of the view cancels the old one (spec FR-030).
- The `searchId` stays valid while the search runs and after it ends `succeeded`. A cancel, a failure, a `limited` end, a newer `searchHistory` of the view, `closeHistory`, and a view release end it. A `readHistoryRows` with an ended or unknown `searchId` gives `UNKNOWN_TARGET`.
- Merge into the view:
  - The service interns each match OID in the OID table of the view.
  - When the row of a match is known, its index must be above the index of the previous match. When it is not known yet, the match joins a FIFO queue.
  - A streamed row that is in the queue must be at its head.
  - When the load completes, the queue must be empty.
  - Any break fails the search with `HISTORY_CHANGED` reason `order`, and the view becomes stale (Δ8), as for a re-read difference.
- The reduced graph needs the full topology stream beside the search stream (plan.md D4). When a search starts on an incomplete view, the service loads to the end itself, by the `loadHistory` rules with no stop row. That load belongs to the search operation: its progress and Cancel go with the search. A cancel of the search keeps the loaded rows. The renderer starts nothing extra.
- A `loadHistory` while the search load runs gives `BUSY`. A `searchHistory` while a load of the view runs gives `BUSY`. The renderer cancels its scroll load first (plan.md D6).
- A view that stopped at `HISTORY_VIEW_COMMITS` has no full topology. A search on it ends `limited` with `OUTPUT_LIMIT` reason `HISTORY_VIEW_COMMITS`, and no Git process starts.
- Progress: phase `history-search`, counters `matches` and `settled`.
- The terminal response carries the final match count (spec FR-039). A shallow view adds the statement that the search covered only the commits that the clone holds.
- A canceled search shows no count as final.

### Matching probe

- Windows: a `mkdtemp` folder in `os.tmpdir()`. Then `init --bare --template= --object-format=sha1`, `fast-import` of the fixed stream, two probe `rev-list` runs, and `fs.rm` of the folder.
- WSL: one fixed `matchingProbe` script in a `/tmp/arbareto-probe-<uuid>` folder, through the wrapper in mode `search` (Δ11).
- The fixed stream and the expected OID sets are contract values in `src/contracts/matching-probe.ts`. They cover "Виправлення" in both cases, є/Є, і/І, ї/Ї, ґ/Ґ, ß against ẞ and SS, and a windows-1251 message with an encoding header.
- A mismatch gives `SEARCH_UNSUPPORTED` reason `matching`, with a remedy.
- The probe writes nothing inside a user repository.

### `closeHistory {viewId}`

- It ends the operations of the view and frees its memory. An unknown `viewId` gives `UNKNOWN_TARGET`.

### `readRefs` (001 §3 "References result")

- The patterns add `refs/stash`.
- `RefEntry.kind` adds `stash`. The sidebar does not show it.
- The result adds `refsDigest`, computed as in `openHistory`.

### `readHistory` (001 §3, "HistoryPage result")

- Retired in step P7. The 001 artifacts stay as records. The 001 chip-pairing rule (001 §3 "References result") goes with it, because rows carry their own labels.

## Δ4 Snapshot rules (001 §4)

No change.

## Δ5 Finite bounds (001 §5)

New limits:

| Limit | Value |
|---|---|
| History views | 1 per service session |
| Load and search process deadline | 120,000 ms |
| Text and details read deadline | 30 s |
| Rows per request | 512 |
| Parents per commit (`HISTORY_PARENTS_PER_COMMIT`) | 64 |
| Commits per view (`HISTORY_VIEW_COMMITS`) | 4,000,000. Service memory of about 185 to 360 MB (about 46 B per commit when the typed arrays are nearly full, about 90 B just after a doubling) (unverified). A reviewer default. |
| Load read-ahead (`HISTORY_LOAD_MARGIN`) | 1,024 rows. A scroll load starts when fewer loaded rows lie below the last needed row. A reviewer default and a measurement knob. |
| Filter text | 1,024 UTF-8 bytes |
| Text object above which a row carries `textLimit` | 256 KiB |
| Progress events | 4 per second |
| Lane checkpoint interval (service) | 256 rows |
| Renderer text cache | 8 MiB of `bytes` (a measurement knob) |
| History processes per view | 3: the load, the search, and the text read |

Reused: `GRAPH_LANES` 24 per row, `REF_LISTING_*` for the capture (10,000 records, 4 MiB), `HISTORY_PAGE_BYTES` 8 MiB for each `readHistoryRows` result, the object bounds, and the 16 KiB body bound. A ref set above 10,000 records gives `OUTPUT_LIMIT` with reason `REF_LISTING_RECORDS`.

Retired with `readHistory`: `GRAPH_PATH_SEGMENTS`, and the 001 §5 'History traversal stream' bound (`HISTORY_STREAM_ROWS`, `HISTORY_STREAM_BYTES`). The lanes of a row already bound its segments. The `loadHistory` line bound and `HISTORY_VIEW_COMMITS` bound the new stream.

## Δ6 Private native process requests (001 §6)

- History processes take no read slot. Polls and `readRefs` keep their two slots.
- Each operation has its own Job. `cancel` closes that Job. The Windows Job ends every descendant. The WSL `SIGHUP` trap kills the scope (001 §6 "Process ownership", 001 §11 "Process ownership").
- No new channel frame. No per-call output credit.
- A load ends at its stop row through the process `cancel` of its call. That closes the Job of the load operation (001 §6 "Channel frames"). A `succeeded` result follows.

## Δ7 Startup, trust, and environment (001 §7)

- New environment policy `search` in `src/contracts/git-environment.json`: the `read` policy plus `LC_ALL=C.UTF-8`.
- `openHistory` may reuse the trust listing, as 001 `readHistory` does (001 §7 "Shared listing", "Held history steps").
- No repository program runs. `rev-list` and `cat-file` run without filters.
- The search text enters no log or diagnostic.

## Δ8 Freshness, cancellation, and outcome (001 §8)

- A ref change or a HEAD move never makes a view stale (spec FR-005). The renderer shows the "References changed" notice with Refresh when:
  - the newest `readRefs.refsDigest` differs from the digest of the view; or
  - the newest `readWorkspace.head` differs from the `head` of the view.
- Stale conditions (spec FR-006). A stale view keeps its rows, refuses further loads and searches with its code, and offers Refresh:
  1. A view process fails, and the object check finds a missing commit: `OBJECT_MISSING` (reason `object-missing`). The text read is a view process too, so a failed text read makes the whole view stale.
  2. `HISTORY_CHANGED` reason `topology`: the shallow digest, the grafts digest, or the replace records changed. The service checks this before each load step and before each search (Δ3 `searchHistory`). A text read runs no check, because commit text cannot change with the topology.
  3. `HISTORY_CHANGED` reason `order`: a re-read row differs from the held row, Git exits with code 0 before the held row count, or the search merge breaks (Δ3 `searchHistory`).
  4. `MALFORMED_GIT_OUTPUT`, `GIT_FAILED`, or a diagnostic `OUTPUT_LIMIT`.
  5. The view was released (`UNKNOWN_TARGET`), or the service session ended.
- Cancel and `DEADLINE` do not make the view stale. A later demand resumes the load.
- After a service restart (001 §8 "Service restart"), no view resumes. The renderer marks the view stale, and Refresh opens a new one.
- The 001 §8 "Changing shallow file" watch for `readHistory` is replaced by the topology fingerprint check.

## Δ9 Error codes (001 §9)

- Reused: `INVALID_REQUEST`, `UNKNOWN_TARGET`, `BUSY`, `REPOSITORY_CHANGED`, `TRUST_REQUIRED`, `TRUST_CHANGED`, `MALFORMED_GIT_OUTPUT`, `OUTPUT_LIMIT`, `OBJECT_MISSING`, `REPOSITORY_UNAVAILABLE`, `GIT_FAILED`, `DEADLINE`, `CANCELED`, `PROCESS_OWNERSHIP_FAILED`, `WSL_UNAVAILABLE`.
- New:

| Code | Reasons | Meaning |
|---|---|---|
| `HISTORY_CHANGED` | `order`, `topology` | Git gave another order, or the topology inputs changed. |
| `UNSUPPORTED_FILTER_TEXT` | `line-break`, `nul`, `quote-end`, `length` | The service refuses the text. No Git process starts. |
| `SEARCH_UNSUPPORTED` | `matching` | The matching probe failed. The result carries a remedy. |

- New `OUTPUT_LIMIT` reasons: `HISTORY_PARENTS_PER_COMMIT` and `HISTORY_VIEW_COMMITS`.
- The renderer check (`src/contracts/filter-text.ts`) gives `found`. `found` names the refused characters: the first invalid character, `\E` for `quote-end`, or the lone surrogate. It is null for the byte bound. A lone surrogate is possible only in the renderer check.
- The service `UNSUPPORTED_FILTER_TEXT` refusal carries `reason` only (`HistoryViewRefusal`). The reason names the refused character.

## Δ10 Required contract checks (001 §10)

- Schema tests and golden vectors for the five operations, the three codes, the `search` policy, the WSL mode `search`, and the `matchingProbe` script. They run in Bun and in Rust.
- The shell allowlist holds the five commands.

## Δ11 WSL repositories (001 §11)

- The same operations run through the wrapper (001 §11 "Process launch").
- New wrapper mode `search` in `src/contracts/wsl-process.json`. It adds `LC_ALL=C.UTF-8`, because no Windows variable reaches Linux (001 §11 "Trust and environment").
- New fixed script `matchingProbe`.
- WSL polls do not run `readRefs` (001 §11 "Change polling"). A change of a ref other than HEAD shows the notice at the next focus return, Refresh, or mutation outcome (spec SC-012).
- Each text read costs one `wsl.exe` start (unverified, about 250 ms).
- A `DEADLINE` of a WSL view carries the remedy text with `command: null`. No WSL form of the commit-graph command exists.

## Contract gaps

- Git documents no single order. Runtime checks cover it and refuse with `HISTORY_CHANGED` reason `order`.
- Git gives no PCRE2 signal. The probe covers only the probed cases. FR-023 for the rest of Unicode rests on PCRE2 caseless matching (unverified).
- A set `GIT_REPLACE_REF_BASE` moves replace refs outside the fingerprint.
- The maximum layout height in WebView2 is not verified.
- Linux Git memory is not part of the Windows process tree.
- `core.useReplaceRefs` in the repository config changes parents outside the fingerprint. The re-read compare reports it as reason `order`.
- No Δ5 bound for `children` of a `details` row. The plan gives none, so T028 sets none. Only `HISTORY_VIEW_COMMITS` and the `HISTORY_PAGE_BYTES` result bound limit it. A `details` row above `HISTORY_PAGE_BYTES` gives `cut` and no row.
- A missing commit several steps below every start point gives `GIT_FAILED`, not `OBJECT_MISSING` (Δ3 `loadHistory`, the feature 001 `checkFailedRead` limit).
- A WSL view gets no copyable `DEADLINE` command (Δ11).
- A shallow or grafts file above 4 MiB has no view reason. `openHistory` and `loadHistory` then give `OUTPUT_LIMIT` without `reason`.
- WSL search: Δ3 "Matching probe" runs the fixed `matchingProbe` script through the wrapper in mode `search`. The shell has no route that runs it: `Texts` in `src-tauri/src/wsl.rs` has no `matchingProbe`, and `run` builds only Git argv. Δ1 and Δ6 add no new channel frame. Until a route exists, the service refuses a WSL search with `SEARCH_UNSUPPORTED` reason `matching`. Spec FR-046 is not met for search. A design for the route is in progress.
- Probe step failure: a failed probe step, such as `mkdtemp`, `init`, or `fast-import`, gives `GIT_FAILED`, not `SEARCH_UNSUPPORTED`.
