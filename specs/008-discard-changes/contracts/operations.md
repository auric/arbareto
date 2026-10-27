# Operation Contract Deltas: Discard (Revert) Changes

This file lists only the changes to the feature 001 contract (`specs/001-desktop-qualification/contracts/operations.md`) and to the 002 to 006 deltas. "001 §n" and "00n Δn" name those sections. Every rule that no delta replaces stays in force.

## Δ1 Transport (001 §1)

- `reviewWorkbench` gains the actions `revert-lines`, `revert-files`, and `revert-unstaged`. `runWorkbench` runs them. No new operation name.
- The private request `fileReplace` gains the target `working`. The private request `fileFacts` gains `detail`.
- Keep explicit range checks in Rust (001 §1).

## Δ2 Envelope (001 §2)

- `MUTATIONS` keeps `runWorkbench`. No new mutation operation.
- New phases: `revert-index` (no counters) and `revert-files` (counters `fileIndex` and `fileCount`). Events carry no path and no Git text.
- New marker actions of kind `workbench`: `revert-lines`, `revert-files`, and `revert-unstaged`.

## Δ3 Public operations (001 §3)

Every argument array starts with `--no-lazy-fetch`. Reads add `--no-optional-locks` and `--literal-pathspecs`. `<oid>` matches the object format. `<path>` is the literal path bytes.

### `reviewWorkbench` (004 Δ3)

- New payload forms (data-model §1):
  - `{action: "revert-lines", snapshotId, comparisonId, hunkId, lines?}`.
  - `{action: "revert-files", snapshotId, entryIds}` with 1 to 10,000 unique IDs.
  - `{action: "revert-unstaged", snapshotId}`.
- Common refusals (004 Δ3) apply: `OPERATION_IN_PROGRESS`, `unknown-operation`, and `CONFLICTED`. A running mutation gives `BUSY`. No trust class (Δ7).
- Reads of every action: the snapshot entries (no Git process); `ls-files --stage -z` and `ls-files --eol -z` for the paths, as literal pathspecs after `--`; `check-attr -z --stdin` and `check-attr --cached -z --stdin` for `text`, `eol`, `crlf`, `ident`, `filter`, `working-tree-encoding`, and `diff`; `fileFacts` with `digest: true` and `detail: true`, 64 entries per frame.
- `revert-lines` reads: the retained comparison; the working bytes (Windows: the service read of at most 1 MiB; WSL: `fileFacts` with `content: true`); then `hash-object --path=<path> --stdin` with the new bytes on stdin. `hash-object` runs without `-w` and writes no object.
- `revert-files` and `revert-unstaged` reads: per path `cat-file --filters --path=<path> <oid>` with stdout bounded by `REVERT_FILE_BYTES` + 1. Probe G2 decides whether a batch form replaces the per-path run.
- Refusals before a token: `LOCKED` with the path and the 001 remedy when `index.lock` exists (plan D2); `WORKBENCH_UNAVAILABLE` with a reason of data-model §7; `UNSUPPORTED_COMPARISON` with the 001 support reason; `UNSUPPORTED_HUNK_PROFILE` with the eligibility reason; `INVALID_REQUEST` for an entry of another snapshot, a duplicate ID, or a comparison of another snapshot; `UNKNOWN_TARGET` for an unknown comparison or hunk.
- Plans: data-model §5.

### `runWorkbench` (004 Δ3)

- Every revert action: the marker of its action; the frame's full observation again (a difference gives `STALE_REVIEW` with reason `revert-changed`); then the parts below; then the reconcile reads (`ls-files --stage -z` of the paths, `fileFacts` with `digest: true`, `readWorkspace`).
- Index part (`revert-lines` staged, `revert-files` with an index change): phase `revert-index`; the owned lock and the checked candidate of 001 §4 through `publishIndex` (plan D7). A lock or candidate refusal ends the run before any working write.
- Working part: phase `revert-files`; one `fileReplace` `working` per path in tree order. A file without a working change (`keep`) sends none. Before each request, the service reads the source bytes again (`cat-file --filters`) and sends them only when their SHA-256 equals the bound value. Another value ends the run with `STALE_REVIEW` `revert-changed` for that file.
- Cancel stops the run before the next request. A started `fileReplace` runs to its end.
- Response state and per-file outcomes: plan D10 and data-model §8.
- Deadline per `fileReplace`: the 001 walk deadline (30 s).

## Δ5 Finite bounds (001 §5)

- `REVERT_FILE_BYTES` = 8,388,608 (8 MiB): the working-tree form of one file of `revert-files` or `revert-unstaged`.
- `REVERT_TOTAL_BYTES` = 1,073,741,824 (1 GiB): the sum of the working-tree forms of one action.
- `revert-lines` keeps `COMPARED_RAW_VERSION_BYTES`, `COMPARED_NORMALIZED_VERSION_BYTES`, and `CANONICAL_DIFF_LINES`.
- `revert-files` and `revert-unstaged` keep `MULTI_FILE_ACTION_FILES` (10,000).
- The token lifetime stays `APPROVAL_LIFETIME_MS` (60 s).

## Δ6 Private native process requests (001 §6)

- `fileReplace {repositoryId, target: "working", path, expected, facts, bytes, folders}`.
  - `path`: an absolute path below the worktree root by `file_facts::below`. A first component equal to `.git` (ASCII case folded) or a path inside the Git directory or the common directory by identity gives `INVALID_REQUEST`.
  - `expected`: `absent` or `{size, sha256}`. `facts`: the bound facts of data-model §3 `working`. `bytes`: 0 to `REVERT_FILE_BYTES`. `folders`: 0 to 64 folder names below the deepest existing folder, only with `expected: absent`.
  - Rules: the operation holds a `started` marker of kind `workbench` with action `revert-lines`, `revert-files`, or `revert-unstaged`. Another operation gets `INVALID_REQUEST`.
  - Windows: plan D8. WSL: `wslFiles` mode `replace` with root `worktree` (Δ11).
  - Reply: `replaced {folders}`, `stale`, `stopped` (a Windows stop or deadline before the write), `interrupted` (a WSL stop, deadline, or broken output), `refused {reason}` with `not-regular`, `hard-link`, `read-only`, `encrypted`, `owner`, `security`, `file-attributes`, or `xattr`, or `error {code}` with `sharing-violation`, `access-denied`, `disk-full`, `read-only-volume`, or another code.
- `fileFacts` gains `detail: boolean`. With `detail`, a `file` fact adds `links`, and on Windows `attributes` (the `FileBasicInformation` attribute bits), `owner` and `dacl` (SDDL), and `creationTime`; on WSL `mode`, `uid`, `gid`, and `xattr` (a boolean).
- Close prompt names: "Revert lines", "Revert files", "Revert unstaged changes".

## Δ7 Startup, trust, and environment (001 §7)

- The three revert actions have no trust class. No step runs a repository program: `cat-file --filters` and `hash-object --path` run only the built-in conversions, because the review refuses `filter` and `LFS` first.
- The reads that load the index wait behind the 001 read gate. A `core.fsmonitor` command refuses through the eligibility first.

## Δ8 Freshness, cancellation, and outcome (001 §8)

- A refresh read and a workspace release end every unused revert token (004 Δ3 "Token invalidation").
- The reconcile reads of Δ3 decide every outcome. A failed reconcile read leaves the outcome unknown, and the marker stays (001 FR-023).

## Δ9 Error codes (001 §9)

- New `WORKBENCH_UNAVAILABLE` reasons: `untracked`, `in-the-way`, `attributes`, `ident`, `unstaged-changes`, `not-regular`, `hard-link`, `read-only`, `encrypted`, `owner`, `security`, `file-attributes`, `xattr`, `too-large`, `nothing-to-revert`. `limit` exists (004).
- New `STALE_REVIEW` reason: `revert-changed`.
- The per-file outcomes of data-model §8 are result fields, not codes.

## Δ10 Required contract checks (001 §10)

- Schema tests and golden vectors for the three payloads, the three plans, the result, the two phases, the new reasons, and the widened `fileReplace` and `fileFacts` frames, in Bun and Rust.
- The Rust side checks the path rules, the byte bound, the `folders` count, and the marker action explicitly.

## Δ11 WSL repositories (001 §11)

- §11 "No working-file content crosses" changes for the revert. These crossings are allowed:
  - Out of the distro: the working bytes of one file of `revert-lines`, at most 1 MiB, through `fileFacts` `content`; the `cat-file --filters` stdout of one file, at most `REVERT_FILE_BYTES`.
  - Into the distro: the new bytes of one file on the stdin of `hash-object --stdin` and in the `wslFiles` `replace` input, at most `REVERT_FILE_BYTES`.
- `wslFiles` mode `replace` gains the root `worktree` with any path below it, and plan D9 steps: the owner check, the gid copy, the `xattr` check, the `O_TMPFILE` create with a `linkat` name before the rename (probes L1 and L2), and `mkdir` of `folders`.
- A staged part refuses with `shared-repository` when any scope sets `core.sharedRepository` (001 §4 "WSL index publication").

## Δ15 Changes to 004 deltas

- 004 Δ3 `reviewWorkbench` gains the revert actions. Its common refusals apply to them.
- 004 Δ9 `WORKBENCH_UNAVAILABLE` gains the Δ9 reasons above.

## Δ16 Changes to 005 deltas

- 005 Δ6 `fileReplace` gains the target `working`. The targets `gitignore` and `exclude` keep their rules and their 1 MiB bound.
- 005 Δ11 `wslFiles` `replace` keeps its ignore-file rules for the roots of `gitignore` and `exclude`.

## Contract gaps

- The `fileReplace` target handle shares `DELETE`, so the rename can replace the target. Another program can rename a file over the target name between the check and the rename (005 gap). The fresh digest then names the outcome `changed-outside`.
- WSL: the `replace` mode acts on the last name after its check. A write by another program inside that window gets replaced, because Linux offers no mandatory lock (spec FR-043).
- A crash in the window between the clear of the delete disposition (Windows) or the `linkat` name (WSL) and the rename leaves `.arbareto-<hex>.tmp` beside the target (probes W6, L3). The next status read shows it as an untracked file. Arbareto never deletes it by its name.
- The SACL and the mandatory label of a Windows file are not checked (research R8). Alternate data streams are dropped (probe W7).
