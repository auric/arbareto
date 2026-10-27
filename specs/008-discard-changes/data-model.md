# Data Model: Discard (Revert) Changes

Every record below lives in memory for one review or one run. Nothing is stored. Paths cross the contracts as base64 bytes, as in 001 to 005.

## 1. Review payloads (renderer to service)

| Action | Fields | Rules |
| --- | --- | --- |
| `revert-lines` | `snapshotId`, `comparisonId`, `hunkId`, `lines?` | `lines`: the 004 line selection (1-based ordinals of `+` and `-` lines of one hunk, ascending). Without `lines`, the whole hunk. The comparison scope is `index-to-worktree` (unstaged) or `head-to-index` (staged). |
| `revert-files` | `snapshotId`, `entryIds` | 1 to 10,000 unique entry IDs of the Changes list or the Staged list of one snapshot. |
| `revert-unstaged` | `snapshotId` | The service takes the entries from the snapshot. |

The renderer sends no path, no byte, and no count. The service derives everything from the retained snapshot and comparison.

## 2. Revert bound (service, per review)

- `action`, `repositoryId`, `generation`, `head`, `operationState`, `indexFingerprint` (001 data-model), `policyFingerprint`.
- `index`: for an action with an index part, the bound raw index digest and the planned entries (§3 `newIndex`).
- `indexLock`: `absent`. A present `index.lock` refuses the review with `LOCKED` (plan D2).
- `files`: one file plan per path, in tree order (005 FR-015).
- `attributes`: per path, the six conversion values from the working files and from the index (research R7).
- The frame compares the whole bound with `Bun.deepEquals` at the run (plan D2). Any difference is `STALE_REVIEW` with reason `revert-changed`.

## 3. File plan

| Field | Meaning |
| --- | --- |
| `entryId`, `pathBytes` | The snapshot entry and its literal path. |
| `category` | `unstaged` or `staged` (the list of the row). |
| `headEntry` | `{mode, oid}` or `absent` (status `mH`, `hH`; absent for an unborn HEAD). |
| `indexEntry` | `{mode, oid}` or `absent` (status `mI`, `hI`). |
| `newIndex` | `{mode, oid}`, `remove`, or `keep` (no index change for this path). |
| `working` | The bound working-file facts: `absent`, or `{size, sha256, attributes, links, owner, dacl, creationTime}` on Windows, or `{size, sha256, mode, uid, gid, links, xattr: false}` on WSL. |
| `folders` | For an absent target: the missing folder names below the deepest existing folder. |
| `source` | Revert file and Revert all unstaged changes: `{oid, path}` of the blob whose working-tree form the run writes. Lines: `bytes`. |
| `newSize`, `newSha256` | The size and the SHA-256 of the bytes that the run writes, or `keep` (a staged new file keeps its working file). |

Rules:
- Revert file: `newIndex` = `headEntry` when it differs from `indexEntry`, `remove` when `headEntry` is `absent`, else `keep`. `source` = `headEntry.oid`, or none for a staged new file (spec FR-021).
- Revert all unstaged changes: `newIndex` = `keep`. `source` = `indexEntry.oid`.
- An unstaged deletion and a staged deletion bind `working: absent`.

## 4. Line plan

- `comparisonId`, `hunkId`, `scope` (`unstaged` or `staged`), `selected` (ordinals or all).
- `subHunk`: the partial patch from `subHunk` with the `unstage` rule (plan D3): an unselected `+` line becomes context, and an unselected `-` line drops.
- `workingBytes`: the bound working bytes (at most 1 MiB), with their size and SHA-256.
- `eol`: the `ls-files --eol` `w/` value of the path.
- `newBytes`: `reverseLines(workingBytes, subHunk, eol)` (§6).
- `expectedBlobId`: the blob ID of the expected check-in content: the working side of the comparison with `subHunk` reversed (unstaged), or the new index content (staged).
- `proof`: the `hash-object --path=<path> --stdin` output for `newBytes`. It must equal `expectedBlobId`.
- Staged only: `newIndexEntry` from the Unstage lines candidate.

## 5. Plan for the confirmation (service to renderer)

| Kind | Fields |
| --- | --- |
| `lines` | `scope`, `fileBytes` (the path), `lines` (the count of selected `+` and `-` lines) or null for a whole hunk. |
| `files` | `count`, `paths` (first 20 in tree order), `newFiles` (staged new files that keep their working file), `staged` (files with a staged change), `unstaged`. |
| `unstaged` | `count`, `paths` (first 20), `submodules` (entries left unchanged). |

- The renderer computes `hidden` for `unstaged`: the covered entries that Filter files hides in the shown snapshot. The service never sees the filter text (004 FR-101).
- The renderer builds every text from these fields and `revert-text.ts`. It shows each path as plain text with the 001 path display rules.

## 6. Line-ending rule (`revert-bytes.ts`)

`reverseLines(working, subHunk, eol)`:
1. Split `working` into lines, each with its own ending (LF, CRLF, or none for the last line).
2. Walk the reversed partial patch against the working lines: a context line must equal the working line after the removal of its CR before LF; a `+` line goes; a `-` line comes back at its place.
3. A restored line ends with CRLF for `eol = crlf`, and with LF for `eol = lf`. For any other value, and for a line without an ending in the comparison, it keeps its comparison bytes.
4. Every other line keeps its raw bytes.
5. A context mismatch in step 2 gives `stale`, because the working bytes no longer match the comparison.

Cases for the G5 probe and the unit vectors of `tests/git/revert-bytes.test.ts`:

| Working form | Git conversion | Restored line | Proof |
| --- | --- | --- | --- |
| LF | none | comparison bytes (LF) | passes |
| CRLF | none, index CRLF | comparison bytes (CRLF) | passes |
| CRLF | `core.autocrlf=true`, index LF | LF line + CR before LF | passes |
| CRLF | `text eol=crlf` | as above | passes |
| LF | `core.autocrlf=true`, index LF | LF | passes |
| CRLF | none, index LF (every line differs) | CRLF | fails: `line-endings` |
| mixed | any | the 001 support refuses first (`line-endings`) | — |
| any | `ident` set | the review refuses first (`ident`) | — |

## 7. Refusal reasons

| Reason | Applies to | Source fact |
| --- | --- | --- |
| 001 support reasons (`rename`, `mode`, `type`, `symlink`, `submodule`, `LFS`, `filter`, `state`, `index-flag`, `path`) | all | `decideSupport` and the status record |
| `binary`, `encoding`, `size`, `line-endings` | lines | `decideSupport`, `revert-bytes.ts` proof |
| `ident` | lines | `check-attr` `ident` = `set` |
| `context-only`, `several-hunks`, `deleted-file`, `new-file`, `eof-newline` | lines | `subHunk`, the renderer mapping |
| `unstaged-changes` | staged lines | the status worktree letter |
| `untracked` | files, lines | the status record `?` |
| `in-the-way` | files | an untracked record at a bound-absent path |
| `attributes` | all | `check-attr` against `check-attr --cached` |
| `not-regular`, `hard-link`, `read-only`, `encrypted`, `owner`, `security`, `file-attributes`, `xattr` | all | `fileFacts` with `detail` (plan D8, D9) |
| `too-large` | files, unstaged | `REVERT_FILE_BYTES`, `REVERT_TOTAL_BYTES` |
| `limit` | files, unstaged | `MULTI_FILE_ACTION_FILES` |
| `nothing-to-revert` | unstaged | no covered entry |
| `LOCKED` (001 code, with the lock path and remedy) | all | the `index.lock` fact at the review and at the run start |
| eligibility (`sparse-index`, `split-index`, `executable-monitor`, `unqualified-monitor`; staged part also `index-change-hook`, WSL `shared-repository`) | all | `hunkEligibility` |

## 8. Run phases and per-file outcome

Phases: `revert-index` (no counters), then `revert-files` (`fileIndex`, `fileCount`), then `reconciling`.

Per-file outcome from the fresh read (plan D10):

| Fresh index entry | Fresh working digest | Outcome |
| --- | --- | --- |
| planned (or `keep`) | `newSha256` (or `keep`) | `reverted` |
| planned, index changed | old digest | `unstaged-only` |
| old | old | `not-changed` (with the reply code: `stale`, `refused`, `error`, or none) |
| any | neither old nor new | `changed-outside` |
| — | — | `not-started` (no request reached the path) |

A fresh read that fails gives the unknown outcome of the whole run (001 FR-023).

## 9. Result (service to renderer)

`{action, files: [{entryId, outcome, code?, reason?}], foldersCreated: [pathBytes], index: "published" | "none" | "refused"}`. The response state follows plan D10.

## 10. View state (renderer, not stored)

- `revert`: `null`, or `{kind, origin, review: "checking" | {plan, token} | {refused: reason}, running: boolean}`. `origin` names the control that gets the focus back.
- A new snapshot or a new comparison patch clears an open review that names the old one (001 FR-022).
