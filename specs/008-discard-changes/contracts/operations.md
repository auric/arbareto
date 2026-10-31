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
- Reads of every action: the snapshot entries (no Git process); `ls-files --stage -z` and `ls-files --eol -z` for the paths, as literal pathspecs after `--`; `check-attr -z --stdin` and `check-attr --cached -z --stdin` for `text`, `eol`, `crlf`, `ident`, `filter`, `working-tree-encoding`, and `diff`; `fileFacts` with `digest: true` and `detail: true`, 64 entries per frame, with `stream: true` for the targets of `revert-files` and `revert-unstaged`.
- `revert-lines` reads: the retained comparison; the working bytes (Windows: the service read of at most 1 MiB; WSL: `fileFacts` with `content: true`); then `hash-object --path=<path> --stdin` with the new bytes on stdin. `hash-object` runs without `-w` and writes no object.
- `revert-files` and `revert-unstaged` reads: no content read. `cat-file --batch-check` gives the blob size of each source entry (for the batches and the deadlines of plan D5a).
- Refusals before a token: `LOCKED` with the path and the 001 remedy when `index.lock` exists (plan D2); `WORKBENCH_UNAVAILABLE` with a reason of data-model §7; `UNSUPPORTED_COMPARISON` with the 001 support reason; `UNSUPPORTED_HUNK_PROFILE` with the eligibility reason; `INVALID_REQUEST` for an entry of another snapshot, a duplicate ID, or a comparison of another snapshot; `UNKNOWN_TARGET` for an unknown comparison or hunk.
- Refusal value (data-model §7): `{reason}`; `{reason, remedy: {text}}` for an eligibility reason; `{path, remedy: {text}}` for `LOCKED`; `{reason, files: [{path, reason}], more}` for file reasons. `files` holds 1 to 20 refused files in tree order with base64 path bytes. `reason` equals the reason of the first file, and the response code is the code of that file. `more` counts the other refused files. The service gives no `several-hunks`, because only the renderer finds it.
- Plans: data-model §5.

### `runWorkbench` (004 Δ3)

- Every revert action: the marker of its action; the frame's full observation again (a difference gives `STALE_REVIEW` with reason `revert-changed`); then the parts below; then the reconcile reads (`ls-files --stage -z` of the paths, `fileFacts` with `digest: true`, `readWorkspace`).
- Index part (`revert-lines` staged, `revert-files` with an index change): phase `revert-index`; the owned lock and the checked candidate of 001 §4 through `publishIndex` (plan D7). A lock or candidate refusal ends the run before any working write.
- Working part: phase `revert-files`, in tree order. A file without a working change (`keep`) sends none. A line revert sends one `fileReplace` `working` with `bytes`. Whole files follow plan D5a in batches of at most 64 paths: `ls-files --stage -z` and the raw index digest; `git --no-lazy-fetch checkout-index --temp --stdin -z` with the batch paths on stdin, in the worktree root; the entries and the digest again (a difference gives `STALE_REVIEW` `revert-changed`); `fileFacts` with `stream: true` for each temporary file; one `fileReplace` `working` with `source` per path; `tempRemove` for each unused temporary file.
- `checkout-index` deadline: `GIT_PROCESS_DEADLINE_MS` plus 1 s for each started 64 MiB of the batch blob sizes (research R11). This size rule replaces `REGISTERED_DEADLINE_CAP_MS` for `checkout-index --temp`, for `fileReplace` with `source`, and for `fileFacts` with `stream`, so a large file gets a finite deadline and no size limit. Cancel stops each of them.
- Cancel stops the run before the next request. A started `fileReplace` runs to its end.
- Response state and per-file outcomes: plan D10 and data-model §8.
- Deadline per `fileReplace`: the 001 walk deadline (30 s).

## Δ5 Finite bounds (001 §5)

- `REVERT_FILE_BYTES` = 2,117,152 = 2 × `COMPARED_RAW_VERSION_BYTES` + `CANONICAL_DIFF_LINES`: the bytes of one `fileReplace` `working` frame of a line revert. The new bytes are at most the working bytes (1 MiB), plus the restored lines of the other side (1 MiB), plus one CR for each restored diff line (research R11). So the 001 comparison bounds are the visible limit, and this bound is never the reason of a refusal. The `bytes` field uses the shared `Base64` pattern, and the shell computes the byte count from the base64 text length.
- `revert-files` and `revert-unstaged` have no byte bound per file or per action (spec FR-025).
- `revert-lines` keeps `COMPARED_RAW_VERSION_BYTES`, `COMPARED_NORMALIZED_VERSION_BYTES`, and `CANONICAL_DIFF_LINES`.
- `revert-files` and `revert-unstaged` keep `MULTI_FILE_ACTION_FILES` (10,000).
- The token lifetime stays `APPROVAL_LIFETIME_MS` (60 s).

## Δ6 Private native process requests (001 §6)

- `fileReplace {repositoryId, target: "working", path, expected, facts, bytes | source, folders}`.
  - `path`: an absolute path below the worktree root by `file_facts::below`. A first component equal to `.git` (ASCII case folded) or a path inside the Git directory or the common directory by identity gives `INVALID_REQUEST`.
  - `expected`: `absent` or `{size, sha256}`. `facts`: the bound facts of data-model §3 `working`. `bytes`: 0 to `REVERT_FILE_BYTES`. `source`: `{name, size, sha256}` of Git's temporary file; `name` is one path component in the worktree root. Exactly one of `bytes` and `source`. `folders`: 0 to 64 folder names below the deepest existing folder, only with `expected: absent`.
  - Rules: the operation holds a `started` marker of kind `workbench` with action `revert-lines`, `revert-files`, or `revert-unstaged`. Another operation gets `INVALID_REQUEST`.
  - Windows: plan D8. WSL: `wslFiles` mode `replace` with root `worktree` (Δ11).
  - `source`: the shell opens the file relative to the held worktree root without following a link. It needs a regular file with one link and the requested size. It copies it beside the target with a streamed SHA-256, which must equal `sha256`, else `stale`. It deletes the source through its handle after the rename and after every failure that comes after the source open. A failure before the open leaves the source to `tempRemove` (plan D5a step 6).
  - Deadline: the 001 walk deadline plus 1 s for each started 64 MiB of the target and the source sizes (the size rule of Δ3).
  - Reply: `replaced {folders}`, `stale`, `stopped` (a Windows stop or deadline before the write), `interrupted` (a WSL stop, deadline, or broken output), `refused {reason}` with `not-regular`, `hard-link`, `read-only`, `encrypted`, `owner`, `security`, `file-attributes`, or `xattr`, or `error {code}` with `sharing-violation`, `access-denied`, `disk-full`, `read-only-volume`, or another code.
- New request `tempRemove {repositoryId, name, expected: {size, sha256}}` under a revert marker: one file in the worktree root, deleted through its handle only when its facts equal `expected`. Reply `removed`, `stale`, `absent`, or `error {code}`. WSL: `wslFiles` mode `tempRemove` (Δ11).
- `fileFacts` gains `stream: boolean`: a digest without the 1 MiB bound, read in chunks, with the deadline rule of `fileReplace`. Only a revert marker may ask for it.
- `fileFacts` gains `detail: boolean`. With `detail`, a `file` fact adds `links`, and on Windows `attributes` (the `FileBasicInformation` attribute bits), `owner`, `group`, and `dacl` (SDDL), and `creationTime`; on WSL `mode`, `uid`, `gid`, and `xattr` (a boolean).
- Close prompt names: "Revert lines", "Revert files", "Revert unstaged changes".

## Δ7 Startup, trust, and environment (001 §7)

- The three revert actions have no trust class. No step runs a repository program: `checkout-index --temp` and `hash-object --path` run only the built-in conversions, because the review refuses `filter` and `LFS` first. `checkout-index` runs no hook and, with `--temp`, writes no index (research R10).
- The reads that load the index wait behind the 001 read gate. A `core.fsmonitor` command refuses through the eligibility first.

## Δ8 Freshness, cancellation, and outcome (001 §8)

- A refresh read and a workspace release end every unused revert token (004 Δ3 "Token invalidation").
- The reconcile reads of Δ3 decide every outcome. A failed reconcile read leaves the outcome unknown, and the marker stays (001 FR-023).

## Δ9 Error codes (001 §9)

- New `WORKBENCH_UNAVAILABLE` reasons: `untracked`, `in-the-way`, `attributes`, `ident`, `unstaged-changes`, `not-regular`, `hard-link`, `read-only`, `encrypted`, `owner`, `security`, `file-attributes`, `xattr`, `nothing-to-revert`. `limit` exists (004). Probe G9 gave Git's restore bytes in every fixture (research R15), so no reason covers `checkout-index --temp` output.
- New `STALE_REVIEW` reason: `revert-changed`.
- The per-file outcomes of data-model §8 are result fields, not codes.

## Δ10 Required contract checks (001 §10)

- Schema tests and golden vectors for the three payloads, the three plans, the result, the two phases, the new reasons, and the widened `fileReplace` and `fileFacts` frames, in Bun and Rust.
- The Rust side checks the path rules, the byte bound, the `folders` count, and the marker action explicitly.

## Δ11 WSL repositories (001 §11)

- §11 "No working-file content crosses" changes for the revert. These crossings are allowed:
  - Out of the distro: the working bytes of one file of `revert-lines`, at most 1 MiB, through `fileFacts` `content`.
  - Into the distro: the new bytes of one file of `revert-lines` on the stdin of `hash-object --stdin` and in the `wslFiles` `replace` input, at most `REVERT_FILE_BYTES` (2,117,152 bytes, 4,234,304 bytes of hex).
  - `revert-files` and `revert-unstaged` cross no file content: `checkout-index --temp` writes inside the distro, and the `replace` mode copies inside the distro.
- `wslFiles` mode `replace` gains the root `worktree` with any path below it, and plan D9 steps: the owner check, the gid copy, the `xattr` check, the `O_TMPFILE` create with a `linkat` name before the rename (probes L1 and L2), the order gid copy, write, fsync, mode copy, `fstat` compare of the mode bits, then `linkat` (probe L4, plan D9), `mkdir` of `folders`, and the `source` copy from Git's temporary file with an `fstat` identity check. A target bound as absent gets `0777 & ~umask` for mode 100755 and `0666 & ~umask` for 100644. New `wslFiles` mode `tempRemove` with the same identity check.
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
- No review fact predicts a Windows `security` difference or a WSL `EPERM` of the gid copy. The write refuses them with `refused {security}` or `refused {owner}`. After a published index part, the run then ends `failed-with-effects` (plan D8, D10). No W2 fixture gives `security` (research R15).
- A crash or a stop between `checkout-index --temp` and the `fileReplace` or `tempRemove` of a file leaves Git's temporary file `.merge_file_<random>` in the worktree root. The next status read shows it as untracked. Arbareto never deletes it by its name pattern.
