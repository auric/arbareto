# Operation Contract Deltas: History Inspection and Commit View File Actions

This file lists only the changes to the feature 001 contract (`specs/001-desktop-qualification/contracts/operations.md`) and to the 002, 003, and 004 deltas (`specs/00n-*/contracts/operations.md`). "001 §n", "002 Δn", "003 Δn", and "004 Δn" name those sections. Every rule that no delta replaces stays in force.

## Δ1 Transport (001 §1)

- New renderer operations: `readCommitChanges`, `readCommitFile`, `readBlame`, `readIgnoreFile`, `previewIgnore`, `openSubmodule`. Each has one Tauri command and one zod schema.
- `openSubmodule` is native-first, as `openWorktree` (004 Δ1).
- `reviewWorkbench` gains the actions `delete` and `ignore-save`. The 004 action `ignore` goes.
- `revealPath` gains `folder`. `readBranches` entries gain `upstreamPresent`. `readRefs` entries gain `nameBytes` for a name that is not valid UTF-8.
- New private requests: `fileDelete`, `fileReplace`, and `shadow`. `fileAppend` goes.
- Keep explicit range checks in Rust (001 §1).

## Δ2 Envelope (001 §2)

- `readCommitChanges`, `readCommitFile`, `readBlame`, `readIgnoreFile`, and `previewIgnore` carry `repositoryId` and `repositoryGeneration`. `openSubmodule` carries `repositoryId` of the parent.
- Generation rule: `readCommitChanges` gives `REPOSITORY_CHANGED` at acceptance when `repositoryGeneration` is not the workspace generation, as `openHistory` does. `readCommitFile` and `readBlame` with `{changesId, fileId}`, `{blameId, line}`, or `{blameId}` do not check it, because their retained listing or result names commit IDs, and these survive a generation change as 001 History pages do. `readBlame` with `{snapshotId, entryId}` checks it through the snapshot (001 §9).
- `MUTATIONS` keeps `runWorkbench`. No new mutation operation.
- Phases: `blame` (counters `blamed` and `total`, or none), `delete-files` (counters `fileIndex` and `fileCount`), `ignore-save`, `preview`. Events carry no path, ref name, or Git text. The 004 phase `ignore` goes with the `ignore` action, because no operation sends it.
- Marker actions of kind `workbench` add `delete-files`, `ignore-save-gitignore`, and `ignore-save-exclude`. The actions `ignore-gitignore` and `ignore-exclude` go.

## Δ3 Public operations (001 §3)

Every argument array starts with `--no-lazy-fetch`. Reads add `--no-optional-locks` and `--literal-pathspecs`, except `check-ignore` (004 plan D3) and the shadow arrays (Δ6). `<oid>` matches the object format. `<path>` is the literal path bytes. Policies are the 001 `read` policy unless stated.

### `readCommitChanges`

- Payload: `{viewId, oid, parent}`. `parent` is an integer from 0 to 63. One read slot.
- Target: the 002 view of `viewId` (`history-view.ts:282`) and its row of `oid` (`history-topology.ts:190`). Another view, a released view, or no row gives `UNKNOWN_TARGET`. A `parent` at or above the row parent count gives `INVALID_REQUEST`, except for a row without parents, where only 0 passes.
- Base: the parent at index `parent` in Git order. A row without parents gives the base `shallow` when the view shallow set holds it, and the empty tree of `hash-object -t tree --stdin` otherwise.
- Read gate: 001 §7 `reads`, before the first Git process, because `diff-tree` loads the index.
- Command: `--no-lazy-fetch --no-optional-locks --literal-pathspecs diff-tree -r -z --raw -M -l1000 <base> <oid>`. The base `shallow` runs no command.
- Parse (diff-format(5) raw with `-z`): `:` six octal digits SP six octal digits SP OID SP OID SP status, then NUL, the path, NUL, and for R a second path and NUL. Accepted status: `A`, `D`, `M`, `T` (no score), `R` with exactly three score digits from 000 to 100. Any other status or form gives `MALFORMED_GIT_OUTPUT` for the whole listing.
- Bounds: 100,000 records (`STATUS_LISTING_RECORDS`) and 32 MiB (`STATUS_LISTING_BYTES`) of output, then 8 MiB of encoded result (`COMMIT_CHANGES_RESULT_BYTES`, equal to `HISTORY_PAGE_BYTES`). Reason: the listing has the status record form, and the result has the history page frame budget. The result keeps whole records in Git order and is `limited` with the reached bound and `shown`.
- Deadline: `READ_DEADLINE_MS` (30 s). Cancel ends the Job.
- Errors: a non-zero exit takes the 001 §7 `hasPromisor` path: `OBJECT_MISSING` with the 001 remedy in a promisor repository, else `GIT_FAILED`. `TRUST_REQUIRED`, `TRUST_CHANGED` from the gate.
- Result: data-model §1. A new call replaces the retained listing of the view.

### `readCommitFile`

- Payload: `{changesId, fileId}`. One read slot.
- Target: the retained listing of `changesId`, else `UNKNOWN_TARGET`. `fileId` outside the listing gives `INVALID_REQUEST`.
- Read gate: as `readCommitChanges`.
- Kind `submodule`: no command. The facts come from the listing.
- Commands, with `<paths>` the path, or for R the new path and the old path:
  - `--no-lazy-fetch --no-optional-locks --literal-pathspecs diff-tree -p --no-textconv --no-ext-diff --no-relative --src-prefix=a/ --dst-prefix=b/ --ignore-submodules=dirty -M -l1000 <base> <oid> -- <paths>`.
  - `--no-lazy-fetch --no-optional-locks --literal-pathspecs diff-tree --numstat -z --no-textconv --no-ext-diff --no-relative --ignore-submodules=dirty -M -l1000 <base> <oid> -- <paths>`.
- Parse: `parsePatch` (001 §4) with the added header lines `similarity index <n>%`, `rename from <path>`, and `rename to <path>`, in the diff.c `fill_metainfo` order. A pure rename has no hunk. `parseNumstat` with the old path for R. `-` and `-` give `binary: true`. A type change gives its fact and no patch.
- Section filter (plan D3): a pathspec also matches the paths below `<path>/`. The service drops each patch and numstat section whose paths lie below `<path>/` or `<old path>/`. The kept sections must equal the listing entry: its status and its paths, and two sections of one path for a type change. A section with another path, a missing section, or an extra section gives `MALFORMED_GIT_OUTPUT`.
- Bounds: `CANONICAL_DIFF_BYTES` (4 MiB) and `CANONICAL_DIFF_LINES` (20,000) per patch, with the 001 limited result. Reason: the 001 canonical diff bounds of every shown diff. Known limit: the byte bound counts the whole `diff-tree -p` output, also the sections below `<path>/` that the filter drops.
- Deadline 30 s. Errors as `readCommitChanges`. A path that is no valid UTF-8 gives `UNSUPPORTED_COMPARISON` with the 001 reason `path`, because no argv item can carry it.
- Result: data-model §2.

### `readBlame`

- Payload: `{source, options}`. `source` is `{changesId, fileId}`, `{snapshotId, entryId}`, `{blameId, line}`, or `{blameId}`. `options` is `{ignoreWhitespace, detectMoves, detectCopies, ignoreList}`, all booleans. One read slot.
- Target: `{changesId, fileId}` gives the commit and path of plan D12 (status D: the chosen parent and the old path). `{snapshotId, entryId}` gives the snapshot HEAD and the entry path. An unborn HEAD gives `BLAME_UNAVAILABLE` `no-history`. `{blameId, line}` gives the `previous` commit and path of the line's group, and `no-previous` without one. `{blameId}` gives the commit and path of the retained result (data-model §10 `commit`, `pathBytes`). Steps 1 to 6 run with the new options. `focusLine` is absent. The generation is not checked, as for `{blameId, line}`. An unknown ID gives `UNKNOWN_TARGET`.
- No read gate: no command loads the index (plan D2).
- Commands, in this order:
  1. `--no-lazy-fetch --no-optional-locks --literal-pathspecs ls-tree -z -l --full-tree <oid> -- <path>`. Exactly one record `<mode> SP <type> SP <oid> SP <size> TAB <path> NUL` with the exact path. After `<oid>` and one SP, the size is right-aligned with spaces to a width of at least 7 (`%7s`, builtin/ls-tree.c:233). The size is `-` for a tree or a gitlink. Type `commit` gives `submodule`. No record gives `no-history`. A size above `BLAME_FILE_BYTES` gives `size`.
  2. `--no-lazy-fetch --no-optional-locks --literal-pathspecs diff --numstat -z --no-textconv --no-ext-diff --no-relative --no-renames <empty tree> <oid> -- <path>`. `-` and `-` give `binary`.
  3. `--no-lazy-fetch --no-optional-locks cat-file blob <blob oid>`. More than `BLAME_FILE_LINES` lines gives `lines`.
  4. `--no-lazy-fetch --no-optional-locks config get --all --type=path -z blame.ignoreRevsFile`, cwd the worktree root. Exit 1 gives an empty list (git-config(1) `get`). Any other non-zero exit gives `GIT_FAILED`. An empty value gives an empty `-z` record. The effective list is every non-empty value from every scope, as in Git, and an empty value resets nothing (plan D12 step 4, O-9). Then the file check of plan D12 step 4. A missing file gives `ignore-revs-file-missing` with `path`.
  5. Without an effective list or with `ignoreList: false`: `--no-lazy-fetch --no-optional-locks --literal-pathspecs blame --incremental --no-textconv --encoding=none [-w] [-M] [-C] [--ignore-revs-file=] <oid> -- <path>`. `--ignore-revs-file=` comes only with an effective list and `ignoreList: false`. It clears every list for this one blame.
  6. With an effective list and `ignoreList: true`: `--no-lazy-fetch --no-optional-locks --literal-pathspecs -c blame.markIgnoredLines=true -c blame.markUnblamableLines=true blame --porcelain --no-textconv --encoding=none [-w] [-M] [-C] <oid> -- <path>`.
- For `{blameId, line}`: steps 1 to 6 for (P, Q) first, so a binary or oversize previous version gives its `BLAME_UNAVAILABLE` reason. Then `ls-tree` of the previous path at the previous commit and of `filename` at the line's commit, then `--no-lazy-fetch --no-optional-locks diff -U0 --inter-hunk-context=0 --no-textconv --no-ext-diff --no-color <old blob> <new blob>`. The hunk headers give the mapped line `focusLine` (data-model §10 and §11). Without `--exit-code`, `git diff` exits 0 with and without a difference (git-diff(1) `--exit-code`), so any other exit gives `GIT_FAILED`.
- Parse: data-model §10 and plan D12 "Parse". An unknown header line, a group outside 1 to N, or a gap gives `MALFORMED_GIT_OUTPUT`.
- Bounds: file 4 MiB (`BLAME_FILE_BYTES`, the canonical diff byte bound, so one file never exceeds what a diff shows), 100,000 lines (`BLAME_FILE_LINES`, the line bound of the virtual list budget), Git output 32 MiB (`BLAME_OUTPUT_BYTES`, the status listing byte bound), encoded result 12 MiB (`BLAME_RESULT_BYTES`, so the result fits the 16 MiB pipe frame with its JSON framing), progress 4 events per second (`BLAME_PROGRESS_EVENTS_PER_SECOND`, as the history progress). Above a bound: `OUTPUT_LIMIT`.
- Deadline: `HISTORY_PROCESS_DEADLINE_MS` (120 s) for the blame step, 30 s for the others. Cancel ends the Job (001 FR-045).
- Errors: `BLAME_UNAVAILABLE` with its reason, and reason `path` for a path that is no valid UTF-8; `GIT_FAILED` with the output tail (an exit 128 of a non-relative ignore file); `OBJECT_MISSING` by the `hasPromisor` path; `OUTPUT_LIMIT`; `DEADLINE`; `CANCELED`.
- Result: data-model §10. One retained result per workspace.

### `readIgnoreFile`

- Payload: `{target}`, `gitignore` or `exclude`. One read slot.
- Commands: for `exclude`, `--no-lazy-fetch --no-optional-locks --literal-pathspecs rev-parse --path-format=absolute --git-path info/exclude` (004 Δ3). Then `fileFacts` with `digest: true` for the target (001 §6). Windows reads the bytes and compares size and SHA-256 with the fact (`ignore.ts:152-155`). WSL sends `fileFacts` with `content: true` (Δ6).
- No read gate: no command loads the index.
- Errors: `WORKBENCH_UNAVAILABLE` with `ignore-link`, `ignore-folder`, `ignore-not-regular`, `ignore-size`, `ignore-not-utf8`, `ignore-nul`, `ignore-lone-cr` (a CR that no LF follows, also as the last byte), `unreadable`, or `path`. `REPOSITORY_CHANGED` when the bytes differ from the fact.
- Result: data-model §6. A file with LF lines and CRLF lines gives `lineEnding: "mixed"` and `lineCounts: {lf, crlf}`, both at least 1. Every other result has no `lineCounts`.

### `previewIgnore`

- Payload: `{target, text, snapshotId, lineEnding?}`. `lineEnding` is `lf` or `crlf`, the selected form of plan D8. The renderer sends it always when a form is selected, also a preselected form. The candidate bytes take it for all lines. Without it, a file of one form keeps its form, and a `mixed` file takes LF. Git drops one CR before each LF (dir.c v2.56.0), so both forms give the same preview. `text` is the base64 of the UTF-8 bytes of the editor text. The decoded bytes are at most 1 MiB, strict UTF-8, and hold no NUL, else `INVALID_REQUEST`. A CR byte in `text` gives `INVALID_REQUEST` for `previewIgnore` and `ignore-save`, because the editor text holds LF line ends only (plan D8). The renderer checks `isWellFormed()` before it encodes, because `TextEncoder` replaces a lone surrogate (plan D9). One read slot. The renderer sends it 400 ms after the last edit and cancels the running one (001 §5 "Pending reads").
- Read gate: 001 §7 `reads`, because `ls-files` loads the index.
- Repository commands:
  - `--no-lazy-fetch --no-optional-locks --literal-pathspecs ls-files -z --stage -v`.
  - `--no-lazy-fetch --no-optional-locks --literal-pathspecs ls-files -o -z --directory --no-empty-directory`.
  - `--no-lazy-fetch --no-optional-locks --literal-pathspecs ls-files -o -z -- <folder>/ …` in batches that fit the 001 §6 command line. The one record `<folder>/` marks a nested repository (plan D9).
  - `--no-lazy-fetch --no-optional-locks cat-file --batch` with the OIDs of skip-worktree `.gitignore` entries that are absent on disk.
  - The self-check listings, which read the index: `--no-lazy-fetch --no-optional-locks --literal-pathspecs ls-files -o -i --exclude-standard --directory -z` (RI) and `--no-lazy-fetch --no-optional-locks --literal-pathspecs ls-files -c -i --exclude-standard -z` (RT). RI takes no pathspec, because a pathspec below an excluded folder can exit 128 (plan D9). The repository uses its own configuration here. Plan D9 "Self-check" defines the verdict of each input.
  - `fileFacts` (`digest: false`) for every `.gitignore` path of the listings, and for `<folder>/.gitignore` of each folder of an input path that lists no exact `.gitignore` (plan D9 `name-case`).
- Shadow commands: Δ6 `shadow`.
- Parse: `ls-files -z --stage -v` gives `<tag> SP <mode> SP <oid> SP <stage> TAB <path> NUL` (git-ls-files(1) `--stage`, `-v`). `ls-files -o -z`, `ls-files -o -i -z`, and `ls-files -c -i -z` give `<path> NUL`, and a folder record ends with `/`. `check-ignore -z -v -n` gives `<source> NUL <line> NUL <pattern> NUL <path> NUL`, one record per input in input order (git-check-ignore(1) OUTPUT). A record count other than the input count gives `MALFORMED_GIT_OUTPUT`.
- Bounds: 100,000 inputs per preview (`PREVIEW_PATHS`, the SC-005 size, about 5 s on Windows; plan D9 `paths` names what counts); 100,000 records and 32 MiB per listing (the status listing bounds); 10,000 ignore files (`PREVIEW_IGNORE_FILES`) of at most 1 MiB each; 1,000 paths per result group (`PREVIEW_GROUP_PATHS`, spec FR-038); 100 notices plus a count. Above a bound: the result `unavailable` with its reason (data-model §7), never a partial preview.
- Deadline: 30 s per process. The whole preview has no other deadline. Cancel ends every Job and the shadow context.
- Errors: `TRUST_REQUIRED`, `TRUST_CHANGED`; `GIT_FAILED`, `OUTPUT_LIMIT`, `DEADLINE`, `CANCELED` of a step. The result `unavailable` is a `succeeded` response.
- Result: data-model §7.

### `openSubmodule`

- Renderer payload: `{repositoryId, path}`. `path` is worktree-relative text with `/` separators. Each component follows the 001 §6 channel component rule. An empty component, `.`, or `..` gives `INVALID_REQUEST` in the shell.
- Native step: the shell joins `path` to the worktree root of `repositoryId` (the §11 UNC form for WSL) and binds a `repositoryDiscovery` context. It forwards `{repositoryId, bootstrapId, path}`. An unregistered `repositoryId` gives `UNKNOWN_TARGET` before any context.
- Service steps: plan D11 steps 1 to 6.
  - `--no-lazy-fetch --no-optional-locks --literal-pathspecs ls-files -z --stage -- <path>` in the parent, behind the parent read gate. Exactly one record with stage 0, mode 160000, and the exact path.
  - `fileFacts` (`digest: false`) of `<path>` and `<path>/.git`.
  - The 001 discovery profiles with the `bootstrapId`, then the 001 registration flow.
- Errors: `BUSY` (a parent mutation runs); `TRUST_REQUIRED`, `TRUST_CHANGED` (the parent gate); `SUBMODULE_UNAVAILABLE` with `not-submodule`, `submodule-not-initialized`, or `path`; the 001 registration codes.
- Result: the 001 `chooseRepository` result. The shell stores the recent entry of the submodule (Δ6).

### `reviewWorkbench` (004 Δ3)

- New payload forms:
  - `{action: "delete", snapshotId, entryIds, folder?, mode: "recycle" | "permanent"}`. `entryIds` holds 1 to 10,000 unique IDs. `folder` holds the base64 folder bytes of a folder row.
  - `{action: "ignore-save", target, text, expected, lineEnding?}`. `text` as `previewIgnore` (base64 UTF-8 bytes). A CR byte in `text` gives `INVALID_REQUEST` before any Git process. `expected` is `"absent"` or `{size, sha256}`. `lineEnding` is `lf` or `crlf`. The renderer sends the selected form always when one is selected (plan D8).
- The form `{action: "ignore", …}` goes.
- Common refusals (004 Δ3) now apply to `delete` too: `OPERATION_IN_PROGRESS`, `unknown-operation`, and `CONFLICTED` with the count, because Delete counts as a mutation for 001 FR-015 and FR-016 (spec FR-033).
- `ignore-save` keeps the 004 exception of the action `ignore`: `OPERATION_IN_PROGRESS`, `unknown-operation`, and `CONFLICTED` do not refuse it, because Save changes no Git state (spec FR-046). A running mutation gives `BUSY` (001 FR-015). The stale check stays.
- `delete` reads: the snapshot entries (no Git process), then `fileFacts` with `digest: true`, 64 entries per frame. Refusals before a token: `WORKBENCH_UNAVAILABLE` with `conflicted`, `submodule`, `nested-repository`, `limit`, `no-recycle-bin`, `long-path` (mode `recycle` and a full Windows path of 260 or more UTF-16 units, plan D6), `nothing-to-delete`, `path` (a name that `isComponent` refuses, such as a name that ends in a period or a space, plan D7 N9), or `unreadable`; `STALE_SELECTION` for a folder set that differs from the snapshot or a fact of kind `directory` or `other`; `INVALID_REQUEST` for a `staged` entry or an entry of another snapshot.
- `delete` plan: data-model §4 plan fields. No trust class: before the reconcile read, the run starts only the common reads `config`, `rev-parse`, and `symbolic-ref` of the stale check. None of them loads the index or runs a repository program.
- `ignore-save` reads: `rev-parse --git-path info/exclude` for `exclude`, then `fileFacts` with `digest: true`, and the bytes as `readIgnoreFile`. A state other than `expected` gives `STALE_REVIEW` with reason `ignore-changed`. Then the line-ending check of the current bytes: a `mixed` file without `lineEnding` gives `INVALID_REQUEST`. The new bytes take `lineEnding` for all lines when present, and the file form otherwise. Refusals: the `readIgnoreFile` reasons, plus `ignore-size` for new bytes above 1 MiB and `ignore-nul` for a NUL in the text.
- `ignore-save` plan: `{target, file, size, sha256}` of the new bytes. No trust class.

### `runWorkbench` (004 Δ3)

- `delete`: the marker of action `delete-files`; the check phase (`fileFacts` again, any difference gives `STALE_REVIEW` `files-changed` and no request); then `fileDelete` requests of at most 64 entries, in tree order; then, for a folder Delete, one `fileDelete` with the candidate folders; then fresh `fileFacts` (`digest: false`) of every path and folder, and `readWorkspace`. The phase `delete-files` counts the replied entries.
  - A folder Delete with more than 64 candidates sends one `fileDelete` per candidate subtree of at most 64 folders. A larger subtree first sends its child subtrees, then its top folder alone. A folder goes after every folder below it.
  - Response state: every file `recycled` or `deleted` gives `succeeded`, also after Cancel, because the delete phase does not stop. A removed file, or a file that is absent after a request without an entry reply, with `stopped`, or with `interrupted`, gives `failed-with-effects`, also after Cancel. Otherwise Cancel gives `canceled`. Otherwise no file was removed, and the response is `failed` with the code of the first file in tree order: `changed` gives `STALE_REVIEW` with reason `files-changed`; `stopped` after the service deadline of its request gives `DEADLINE`; a refused request gives its code; anything else gives `GIT_FAILED`. Each file keeps its own outcome. A shell reply `absent` or `stale` is never an effect of the request.
- `ignore-save`: the marker of action `ignore-save-gitignore` or `ignore-save-exclude`; one `fileReplace`; then a fresh `fileFacts` digest of the target and `readWorkspace`. A `stopped` or `interrupted` reply with the expected state gives `canceled` after Cancel, and otherwise `failed` with `GIT_FAILED`, because the reply names no cause.
- Outcome: plan D6 table and D10. The response states follow 001 data-model §7.
- Deadline per `fileDelete`: `GIT_PROCESS_DEADLINE_MS` plus `MULTI_FILE_STEP_MS_PER_FILE` for each entry, at most `REGISTERED_DEADLINE_CAP_MS`. `fileReplace`: the 001 walk deadline.

### `revealPath` (004 Δ3)

- Payload: `{repositoryId, entryId, folder?}`. `folder` is the base64 bytes of a proper prefix of the entry path that a `/` follows. Another value gives `INVALID_REQUEST`.
- The service joins the folder bytes in place of the entry path. The `reveal` reply `absent` gives `UNKNOWN_TARGET` with reason `absent`.

### `readBranches` (004 Δ3)

- Each entry gains the required field `upstreamPresent` (boolean or null). It is false when `upstream` is null. Otherwise it comes from the 003 tracking entry that pairs with the entry in the same read: false for the track state `gone`, and true for another state. Without a paired tracking entry it is null, an unknown state, and no mark shows. No new command.
- Rationale: the branch listing holds only `refs/heads` and `refs/remotes`, but an upstream can be another ref, such as `refs/tags/v1` with remote `.`. `%(upstream:track,nobracket)` prints `gone` exactly when the upstream does not resolve (ref-filter.c).

### `readRefs` (001 §3)

- Each `RefEntry` whose name is not valid UTF-8 gains `nameBytes`: the raw name bytes in base64. A valid UTF-8 name has no `nameBytes`. The References tree sorts on these bytes (plan D4).

## Δ4 File staging (001 §4)

- No change. Delete and Save never touch the index.

## Δ5 Finite bounds (001 §5)

| Limit | Value |
|---|---|
| Public request (`PUBLIC_REQUEST_BYTES`) | 2 MiB (2,097,152 bytes), up from 1 MiB. The editor text crosses as base64, so a 1 MiB text takes 1,398,104 bytes with no JSON escape, and 699,048 bytes stay for the other fields (plan O-6). `PUBLIC_FRAME_BODY_BYTES` follows. |
| Commit changes listing | 100,000 records and 32 MiB (`STATUS_LISTING_RECORDS`, `STATUS_LISTING_BYTES`) |
| Commit changes result (`COMMIT_CHANGES_RESULT_BYTES`) | 8 MiB (`HISTORY_PAGE_BYTES`) |
| Parent index | 0 to 63 (`HISTORY_PARENTS_PER_COMMIT` − 1) |
| Retained commit listings | 1 per view |
| Commit file patch | 4 MiB and 20,000 lines (`CANONICAL_DIFF_BYTES`, `CANONICAL_DIFF_LINES`) |
| Blame file (`BLAME_FILE_BYTES`, `BLAME_FILE_LINES`) | 4 MiB and 100,000 lines |
| Blame Git output (`BLAME_OUTPUT_BYTES`) | 32 MiB |
| Blame result (`BLAME_RESULT_BYTES`) | 12 MiB |
| Blame progress (`BLAME_PROGRESS_EVENTS_PER_SECOND`) | 4 events per second |
| Blame process deadline | 120 s (`HISTORY_PROCESS_DEADLINE_MS`) |
| Retained blame results | 1 per workspace |
| Delete entries | 10,000 (`MULTI_FILE_ACTION_FILES`) |
| `fileDelete` entries and folders per request | 64 each (`FILE_FACT_ENTRIES`) |
| Delete digest | files up to 1 MiB (the 001 §6 `fileFacts` digest bound); above it, size and `lastWrite` only |
| Delete confirmation paths | 20, plus a count |
| Ignore file, editor text, saved bytes | 1 MiB (`IGNORE_TARGET_BYTES`) |
| Preview inputs per preview (`PREVIEW_PATHS`) | 100,000 |
| Preview listings | 100,000 records and 32 MiB each |
| Preview ignore files (`PREVIEW_IGNORE_FILES`) | 10,000, each at most 1 MiB |
| Preview group paths (`PREVIEW_GROUP_PATHS`) | 1,000, plus the count |
| Preview notices | 100, plus a count |
| Preview pause (renderer) | 400 ms after the last edit |
| Shadow folders | 1 per preview operation |
| Submodule chain | 8 levels (`SUBMODULE_REVIEW_NESTING_LEVELS`) |
| Workbench review token lifetime | 60 s (004) |

## Δ6 Private native process requests (001 §6)

- New request `fileDelete {repositoryId, mode: "recycle" | "permanent", entries, folders}`.
  - `entries`: 0 to 64 of `{path, expected}`. `path` is an absolute path below the worktree root by `file_facts::below`. `expected` is the review fact: `{kind: "file", size, lastWrite, digest?}` or `{kind: "link", tag, target}`. A `digest` needs a `size` of at most 1 MiB (Δ5).
  - `folders`: 0 to 64 absolute folder paths below the worktree root, deepest first. Each folder is the shallowest folder of the request or lies below it. One of `entries` and `folders` is not empty. A folder Delete with more candidates sends them in subtrees (Δ3 `runWorkbench`).
  - Rules: the operation holds a `started` marker of kind `workbench` with action `delete-files`. Another operation gets `INVALID_REQUEST`. `recycle` in a WSL workspace gets `INVALID_REQUEST`. A `recycle` entry whose path holds 260 or more UTF-16 units gets `INVALID_REQUEST`, because the review refuses it first (Δ3).
  - Windows: plan D7. `PreDeleteItem` compares the `FILE_ID_INFORMATION` of the `SIGDN_FILESYSPATH` path of `psiItem`, opened as a Win32 path without following a link, with the checked handle. A failure or another ID cancels this and every later item. The folder step deletes each candidate through its held walk handle with `DELETE`, deepest first. WSL: `wslFiles` mode `delete` (Δ11).
  - Reply: per entry `recycled {recycledPath}`, `deleted`, `kept {hresult}`, `stale`, `absent`, `not-regular`, `error {code}` (such as `access-denied` or `sharing-violation`), or `stopped` (the Recycle Bin operation ended before the item); per folder `removed`, `kept`, `absent`, `not-regular`, or `error {code}`. Exactly one reply per request, also after `cancel`, `closeJob`, or a service exit.
  - A Windows stop or deadline before the delete phase replies `{type: "fileDelete", result: "stopped"}`: nothing changed. A WSL stop, deadline, or broken `delete` output replies `{type: "fileDelete", result: "interrupted"}`: the outcome is unknown, and the service runs the fresh read and `readWorkspace`.
- New request `fileReplace {repositoryId, target: "gitignore" | "exclude", path, expected, bytes}`.
  - `path` rules: the 004 `fileAppend` path rules (`<worktree root>/.gitignore`, or `info/exclude` inside the common directory by identity).
  - `expected`: `absent` or `{size, sha256}`, with `size` at most 1 MiB. `bytes`: 0 to 1 MiB.
  - Rules: the operation holds a `started` marker of kind `workbench` with action `ignore-save-gitignore` or `ignore-save-exclude` that matches `target`.
  - Windows: plan D10. WSL: `wslFiles` mode `replace` (Δ11).
  - Reply: `replaced`, `stale`, `stopped` (a Windows stop or deadline before the write), `interrupted` (a WSL stop, deadline, or broken `replace` output), `refused {reason: "not-regular"}`, or `error {code}`.
- New request `shadow {operationId, repositoryId, op: "create"}`.
  - The shell creates the shadow folder (data-model §13) below `<launch directory>/preview`, the per-user app local data folder of `service.rs:108-113`, and binds the context `ignorePreview` to the operation. The folder holds the shadow repositories `s` and `c`. Reply `{shadowId}` or `error {code}`.
  - At each create, the shell removes leftover shadow folders whose owner PID and creation time match no live process record, and own folders that no live context holds. The removal runs after the reply, outside the state lock. Only `ERROR_INVALID_PARAMETER` from `OpenProcess` means that no process has the PID. Another failure keeps the folder.
  - The shell removes the folder when the operation ends, after Cancel, `closeJob`, or a service exit.
  - Accepted arrays in an `ignorePreview` context, cwd `<shadow>/s` or `<shadow>/c`: `--no-lazy-fetch init -q --template=`; `--no-lazy-fetch hash-object -w --no-filters --stdin-paths`; `--no-lazy-fetch hash-object -w --no-filters --stdin`; `--no-lazy-fetch hash-object --no-filters --stdin-paths`; `--no-lazy-fetch update-index -z --index-info`; `--no-lazy-fetch -c core.autocrlf=false -c core.eol=lf checkout-index -a -f`, also with `--prefix=.git/info/`; `--no-lazy-fetch -c core.ignorecase=<true|false> [-c core.excludesFile=<path>] check-ignore --no-index -z --stdin -v -n`. On Windows, the `hash-object --stdin-paths`, `checkout-index`, and `check-ignore` arrays carry `-c core.longpaths=true` right after `--no-lazy-fetch`. The request names the repository (`s` or `c`) and the index: `index` or `exclude` sets `GIT_INDEX_FILE` to `<cwd>/.git/index` or `<cwd>/.git/exclude.index`. The shell sets `GIT_DIR` to `.git`, which names `<cwd>/.git`; a WSL run takes `--git-dir=.git` after `-C <cwd>`. So Git never finds a repository above the shadow folder, and `git init` makes a repository with a work tree: with `GIT_DIR` set, `git init` guesses a bare repository unless `GIT_DIR` is `.git` or ends in `/.git` (Git `builtin/init-db.c` `guess_repository_type`). For the `ignorePreview` context on Windows the shell sets `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` to an empty file in the shadow folder; the service passes every setting the preview needs as `-c` items. Any other array, cwd, or index gives `INVALID_REQUEST`.
  - `run` fields of the context (001 §6 "Channel frames"): `contextKind: "ignorePreview"`, `gitInstallationId` (the Git of the repository, as every non-bootstrap context names it), `shadowId` (the `shadow` reply), `shadowRepository` (`s` or `c`, the cwd), and `shadowIndex` (`index` or `exclude`). The `run` field `indexFile` stays absent, because `shadowIndex` names the index. A `shadowId` that no live context of the operation holds gives `UNKNOWN_TARGET` (001 §6 `refused` codes: an unbound ID).
  - Policy: the 001 `read` policy with the shadow cwd. The shell never runs a repository context command in an `ignorePreview` context.
- `reveal` reply adds `absent` for a walk that finds no entry. The service maps it to `UNKNOWN_TARGET` with reason `absent`.
- `fileFacts` gains `content: boolean`, WSL only, with `digest: true`, exactly one entry, and no `index`. The `file` fact then adds `bytes` (base64) for a file up to 1 MiB. A Windows request with `content` gives `INVALID_REQUEST`.
- `openSubmodule` native step: as `openWorktree` (004 Δ6), with the joined path. `registered_root` (`service.rs:760-768`) adds `openSubmodule`, so a `succeeded` result stores a recent entry, and the settings keep it as the last repository (`service.rs:1007`).
- The request `fileAppend` goes (004 Δ6).
- Close prompt names: "Delete files", "Save .gitignore", "Save info/exclude". "Add to .gitignore" and "Add to info/exclude" go.

## Δ7 Startup, trust, and environment (001 §7)

- Read gate per read: plan D2 table. `readCommitChanges`, `readCommitFile`, `previewIgnore`, and the `openSubmodule` parent read wait behind the 001 `reads` gate. `readBlame`, `readIgnoreFile`, `revealPath`, and the `delete` and `ignore-save` reviews need no gate.
- Trust classes: `delete` and `ignore-save` use no class, because they run no repository program. Their reconcile `readWorkspace` keeps the 001 gate.
- The submodule of `openSubmodule` gets its own trust state through the 004 D12 flow. No approval comes from the parent.
- `-c` items: `blame.markIgnoredLines`, `blame.markUnblamableLines` (`readBlame`), and `core.autocrlf`, `core.eol`, `core.ignorecase`, `core.excludesFile`, and on Windows `core.longpaths` (shadow context only). Each applies to one process. No configuration file changes.
- Logs: kinds, IDs, codes, reasons, and counts only. No path, editor text, blame line, or `recycledPath`.

## Δ8 Freshness, cancellation, and outcome (001 §8)

- After a `delete` or `ignore-save` outcome, the renderer runs `readWorkspace`. A Delete with tracked files also refreshes the History Working directory row.
- Cancel is never rollback. A canceled Delete states each file outcome from the fresh read. A canceled Save states the fresh target state.
- A History view refresh drops the retained listing and the selected file when the commit row leaves the view.

## Δ9 Error codes (001 §9)

| Code | Reasons | Meaning |
|---|---|---|
| `BLAME_UNAVAILABLE` | `no-history`, `binary`, `submodule`, `size`, `lines`, `ignore-revs-file-missing`, `no-previous`, `path` | Blame cannot run for this file. No blame process starts. |
| `UNSUPPORTED_COMPARISON` (001) | `readCommitFile` uses the 001 reason `path` | The path is no valid UTF-8, so no argv item can carry it. |
| `SUBMODULE_UNAVAILABLE` | `not-submodule`, `submodule-not-initialized`, `path` | The open cannot start. The parent stays open. |
| `WORKBENCH_UNAVAILABLE` (004) | adds `conflicted`, `submodule`, `nested-repository`, `no-recycle-bin`, `long-path`, `nothing-to-delete`, `ignore-link`, `ignore-folder`, `ignore-not-utf8`, `ignore-nul`, `ignore-lone-cr`; keeps the 004 reasons `ignore-not-regular`, `ignore-size`, `limit`, `path`, and `unreadable`; removes `ignore-exists`, `ignore-not-text` | The action cannot run. No file changes. |
| `STALE_REVIEW` (001) | adds `files-changed`, `ignore-changed` | A bound fact changed after the review. Nothing changes. |
| `UNKNOWN_TARGET` (001) | adds `absent` | The reveal target does not exist on disk. |

- `ignore-revs-file-missing` carries `path`, the value as configured.
- `not-regular` is a per-file outcome of `fileDelete` and `fileReplace` (Δ6), not a `WORKBENCH_UNAVAILABLE` reason.
- `path` of `BLAME_UNAVAILABLE` is the 001 reason of a path that is no valid UTF-8. It carries no `path` field.
- Reused: `BUSY`, `CONFLICTED`, `OPERATION_IN_PROGRESS`, `APPROVAL_EXPIRED`, `STALE_SELECTION`, `TRUST_REQUIRED`, `TRUST_CHANGED`, `MALFORMED_GIT_OUTPUT`, `OUTPUT_LIMIT`, `OBJECT_MISSING`, `GIT_FAILED`, `DEADLINE`, `CANCELED`, `FAILED_WITH_EFFECTS`, `REPOSITORY_CHANGED`, `INVALID_REQUEST`.

## Δ10 Required contract checks (001 §10)

- Schema tests and golden vectors for every new operation, code, reason, phase, private request, and context, in Bun and Rust.
- Vector tests for the raw record parser, both blame grammars, the line map, the ignore codec, and `tree-order.ts`.
- The service builds the new command arrays (001 §6). The shell keeps no per-command list for registered runs. A Rust test admits the new registered arrays. The `ignorePreview` context admits only the Δ6 shadow arrays.
- The Rust check of `src-tauri/src/schema.rs` reads each new vector of `native-first-envelope`, `mutation-request`, `progress`, and `process-request`.

## Δ11 WSL repositories (001 §11)

- §11 "No working-file content crosses" changes for the ignore editor (spec FR-043). These crossings are allowed:
  - Out of the distro: the bytes of one ignore file, at most 1 MiB, through `fileFacts` `content`.
  - Into the distro: the editor text on the stdin of `hash-object --stdin` (preview) and in the `wslFiles` `replace` input (save); the preview path lists on the stdin of `check-ignore`.
- New `wslFiles` mode `delete`: per entry, `chdir` to the worktree root, then for each folder on the way `lstat` (a directory, no link), `chdir` into it, and `stat(".")` with the device and inode of that `lstat`. Another result gives `stale`. At the target, `lstat` of the last name with the bound type, then the size, `st_mtime` in the `lastWrite` form, and the SHA-256 of a bound file through an `O_RDONLY|O_NOFOLLOW` open whose `fstat` device and inode equal the `lstat`. Then `unlink` of the last name in the working folder. Per folder: the same walk to its parent, then `rmdir` of the last name; `ENOTEMPTY` or `EEXIST` gives `kept`. A stop, a deadline, an output that ends early, or an exit status other than 0 gives the request reply `interrupted` (Δ6).
- New `wslFiles` mode `replace`: plan D10 WSL steps, with the walk of mode `delete` to the parent folder. Each later step names the last name only. A link on the way or at the target, or `st_nlink` other than 1, gives `refused not-regular`.
- New `wslFiles` mode `scratch`: `create` makes the shadow folder and its `s` and `c` folders with `mkdir` mode 0700 under `/tmp` with the data-model §13 name. `remove` deletes one shadow folder depth-first, only below a name that starts with `arbareto-preview-`, and never through a link: it opens `/tmp` and each folder with `O_RDONLY|O_DIRECTORY|O_NOFOLLOW`, enters it with `chdir`, compares the `stat(".")` device and inode with the `lstat` of the name, and then uses only relative names with `lstat`, `unlink`, and `rmdir`. `sweep` lists the `arbareto-preview-*` entries whose `lstat` owner is the distro user (`$<`) for the leftover rule.
- The shadow Git commands run inside the distro through the wrapper in mode `read`: `git --no-lazy-fetch -C /tmp/<shadow>/<s|c> --git-dir=.git <array without --no-lazy-fetch>`, with `GIT_INDEX_FILE` `<cwd>/.git/index` or `<cwd>/.git/exclude.index`. The arrays are the Δ6 arrays without `-c core.longpaths=true`. The run takes the WSL Git of the shadow's distro; another Git gives `INVALID_REQUEST`.
- `revealPath` with `folder` takes the UNC form of the folder.

## Δ12 Submodules (001 §12)

- The Submodules group row menu adds "Open submodule". Enter and a double-click open the row.
- A row with action `clone` or `reuse` has no `.git` entry (001 §12 "Actions"), so Open submodule is unavailable for it in the renderer. The service checks of `openSubmodule` decide every other case.
- Every other §12 rule stays.

## Δ13 Changes to 002 deltas

- 002 spec Scope Boundaries: historical diffs and blame are in feature 005. The Files tab and branch filtering stay out.
- 002 Δ3 views: `readCommitChanges` and `readBlame` take the view topology and shallow set. A view release drops their retained results.
- The 001 commit details line "Changed files are not shown in this version." goes.

## Δ14 Changes to 003 deltas

- 003 FR-020 sidebar state: the gone state shows as the icon mark of plan D13 with its tooltip, not as the visible text ", not present". The text "Upstream gone" stays in the branch list and the card.

## Δ15 Changes to 004 deltas

- 004 Δ3 `reviewWorkbench` `ignore`, its plan, and its run steps go. `ignore-save` replaces them.
- 004 Δ6 `fileAppend` goes. `fileReplace` replaces it.
- 004 Δ9 reasons `ignore-exists` and `ignore-not-text` go.
- 004 Δ3 `revealPath`: the folder form and the `absent` reason above.
- 004 contract gap "A WSL `ignore` review refuses with `WORKBENCH_UNAVAILABLE` reason `unreadable`" closes (Δ11).
- 004 contract gap "`fileAppend` for `absent` creates the file and then writes" closes, because `fileReplace` renames a complete temporary file.

## Contract gaps

- The Recycle Bin call takes a path (`SHCreateItemFromParsingName`), and the Shell resolves it again for the move. Between `PreDeleteItem` and the move, two changes reach another item (spec FR-031). First, a swap of the last path component. Second, another program empties a folder on the path and makes it a junction. The held folder handle does not block that, because `FSCTL_SET_REPARSE_POINT` needs only `FILE_WRITE_DATA` or `FILE_WRITE_ATTRIBUTES` and an empty folder (MS-FSA 2.1.5.10.37), and share modes do not control attribute access. The `PreDeleteItem` identity compare catches both changes when they happen before it.
- The WSL `delete` and `replace` modes hold each folder on the path as the working folder after a device and inode check, and act on the last name only. A swap of the last name between its check and the act reaches the swapped item.
- The `fileReplace` target handle shares `DELETE`, so the rename can replace the target. Another program can rename a file over the target name between the stale check and the rename. Save then replaces that file, and the fresh digest names the outcome.
- `name-case` needs one `fileFacts` entry per folder of an input path without an exact `.gitignore`. In WSL, each frame of 64 entries is one `wsl.exe` run, so the base build of a repository with many folders can take long. P9 measures it.
- Files above 1 MiB bind only size and `lastWrite`. An edit that keeps both goes unnoticed (spec FR-030).
- A Windows warning dialog of `FOF_WANTNUKEWARNING` waits for the user. It can hold the `fileDelete` reply past its deadline, because `PerformOperations` returns only after the dialog.
- A crash between the temporary-file create and the rename of `fileReplace` leaves `.arbareto-<hex>.tmp` next to the target. The next status read shows it as an untracked file.
- The ignore preview is exact for one snapshot. An external change during a preview can make that preview differ from the next state. The next snapshot builds a new base.
- `hash-object --stdin-paths` in the shadow reads each real `.gitignore` by path after its `fileFacts` check. A swap to a link in that window gives the shadow other bytes. The self-check catches it only for S inputs.
- A preview folder below an expanded folder counts by its files, unless the base already holds it as a folder input. So "Preview not available: paths" can show earlier than the exact collapse would allow.
- The renderer finds the parent recent entry by `current: true`. A recent entry that other opens push out of the 20 entries gives "Open the parent repository with Open repository.".
- The `diff -U0` options of "Blame before this commit" follow the user's diff configuration, such as `diff.algorithm`. The mapped line is the line of Git's own zero-context diff under that configuration. `--inter-hunk-context=0` keeps `diff.interHunkContext` out.
- `blame.ignoreRevsFile` values that the shell `below` rule refuses, such as a value outside the worktree or with a `..` component, pass to Git unchecked. A missing file there gives `GIT_FAILED` with the output tail. `config --type=path` removes the prefix rules but not this gap, because `fileFacts` checks only paths below the worktree root.
- `FileDispositionInfoEx` and `FileRenameInfoEx` need a file system with POSIX delete and rename support. Another file system gives `error`, and the file stays (plan O-4).
