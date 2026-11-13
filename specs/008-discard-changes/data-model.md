# Data Model: Discard (Revert) Changes

Every record below lives in memory for one review or one run. Nothing is stored. Paths cross the contracts as base64 bytes, as in 001 to 005.

## 1. Review payloads (renderer to service)

| Action | Fields | Rules |
| --- | --- | --- |
| `revert-lines` | `snapshotId`, `comparisonId`, `hunkId`, `lines?` | `lines`: the 004 line selection (1-based ordinals of `+` and `-` lines of one hunk, ascending). Without `lines`, the whole hunk. The comparison scope is `index-to-worktree` (unstaged) or `head-to-index` (staged). |
| `revert-files` | `snapshotId`, `entryIds` | 1 to 10,000 unique entry IDs of the Changes list or the Staged list of one snapshot. A partly staged file has a Changes row and a Staged row. Two picked rows of one file merge into one file plan, and the first picked row's `entryId` gets the outcome. |
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
| `working` | The bound working-file facts: `absent`, or `{size, sha256, attributes, links, owner, group, dacl, creationTime}` on Windows, or `{size, sha256, mode, uid, gid, links, xattr: false}` on WSL. The WSL `mode` is the whole `st_mode`. |
| `folders` | For an absent target: the missing folder names below the deepest existing folder. |
| `gitMode` | For an absent target: the Git mode of `source` (`100644` or `100755`). The `fileReplace` frame carries it (contract Δ6 `gitMode`). |
| `source` | Revert file and Revert all unstaged changes: the index entry (`{mode, oid}`) that `checkout-index --temp` writes after the index part, and its blob size from `cat-file --batch-check` (for the batches and the deadlines). Lines: `bytes`. |
| `newSize`, `newSha256` | Lines: the size and the SHA-256 that the review computes. Whole files: none at the review; the run takes them from Git's temporary file (§8a). `keep`: a staged new file keeps its working file. |

Rules:
- Revert file: `newIndex` = `headEntry` when it differs from `indexEntry`, `remove` when `headEntry` is `absent`, else `keep`. `source` = `headEntry`, or none for a staged new file (spec FR-021).
- Revert all unstaged changes: `newIndex` = `keep`. `source` = `indexEntry`.
- An unstaged deletion and a staged deletion bind `working: absent`.
- WSL: the `detail` read also gives `own` (`st_uid == $>`), the owner rule of the WSL `replace` write (`wsl-process.json`). The review refuses with `owner` when `own` is false, before the `xattr` check. `own` is no bound fact: the bound `uid` holds the owner.

## 4. Line plan

- `comparisonId`, `hunkId`, `scope` (`unstaged` or `staged`), `selected` (ordinals or all).
- `subHunk`: the partial patch from `subHunk` with the `unstage` rule (plan D3): an unselected `+` line becomes context, and an unselected `-` line drops.
- `workingBytes`: the bound working bytes (at most 1 MiB), with their size and SHA-256.
- `eol`: the `restoreEol` value of the path (§6): the `ls-files --eol` `w/` value, or empty when Git converts no line ending for the path.
- `newBytes`: `reverseLines(workingBytes, subHunk, eol)` (§6).
- `expectedBlobId`: the blob ID of the expected check-in content: the working side of the comparison with `subHunk` reversed (unstaged), or the new index content (staged).
- `proof`: the `hash-object --path=<path> --stdin` output for `newBytes`. It must equal `expectedBlobId`.
- Staged only: `newIndexEntry` from the Unstage lines candidate.

## 5. Plan for the confirmation (service to renderer)

| Review `action` | Plan fields |
| --- | --- |
| `revert-lines` | `scope`, `fileBytes` (the path), `lines` (the count of selected `+` and `-` lines) or null for a whole hunk. |
| `revert-files` | `count`, `paths` (first 20 in tree order), `newFiles` (staged new files that keep their working file), `staged` (files with a staged change), `unstaged`. |
| `revert-unstaged` | `count`, `paths` (first 20), `submodules` (entries left unchanged). |

- No plan has a `kind` field. The renderer keys on the `action` of the review result (contract Δ3).
- The renderer computes `hidden` for `revert-unstaged`: the covered entries that Filter files hides in the shown snapshot. The service never sees the filter text (004 FR-101).
- The renderer builds every text from these fields and `revert-text.ts`. It shows each path as plain text with the 001 path display rules.

## 6. Line-ending rule (`revert-bytes.ts`)

`restoreEol(eol, autocrlf)` picks the `eol` value from the `ls-files --eol` record and `core.autocrlf` (Git `convert.c` `convert_attrs` and `output_eol`, v2.55.0 and v2.56.0):
- The `attr/` value `-text` is CRLF_BINARY. The empty `attr/` value is CRLF_UNDEFINED, and `core.autocrlf=false` makes it CRLF_BINARY.
- For CRLF_BINARY, `output_eol` gives EOL_UNSET. Git's checkout writes the blob bytes, and check-in keeps the working bytes. So `eol` is empty, and a restored line keeps its comparison bytes.
- Every other action can map CRLF to LF at check-in. So `eol` is the `w/` value, and the working form picks the ending (spec FR-015).
- `core.autocrlf` comes from the trust listing: the last entry wins, and `false` is the default (Git `environment.c` `git_default_core_config`). A cut listing or a value that Git cannot read refuses with `line-endings`.
- `core.eol` never makes CRLF_BINARY, so the rule does not read it.

`reverseLines(working, subHunk, eol)`:
1. Split `working` into lines, each with its own ending (LF, CRLF, or none for the last line).
2. Walk the reversed partial patch against the working lines: a context line must equal the working line after the removal of its CR before LF; a `+` line goes; a `-` line comes back at its place.
3. A restored line ends with CRLF for `eol = crlf`, and with LF for `eol = lf`. For any other value (also empty), and for a line without an ending in the comparison, it keeps its comparison bytes.
4. Every other line keeps its raw bytes.
5. A context mismatch in step 2 gives `stale`, because the working bytes no longer match the comparison.

Cases for the G5 probe and the unit vectors of `tests/git/revert-bytes.test.ts`:

| Working form | Git conversion | Restored line | Proof |
| --- | --- | --- | --- |
| LF | none | comparison bytes (LF) | passes |
| CRLF | none, index CRLF | comparison bytes (CRLF) | passes |
| CRLF | `core.autocrlf=true`, index LF | LF line + CR before LF | passes |
| CRLF | `text eol=crlf` | as above | passes |
| LF | `core.autocrlf=true`, index LF | LF; Git's `apply -R` gives CRLF for every line, so the plan D13 line oracle applies | passes |
| CRLF | none, index LF (every line differs) | comparison bytes (LF): Git's checkout writes the LF blob bytes | passes |
| CRLF | `-text`, index LF | comparison bytes (LF), also with `core.autocrlf=true` | passes |
| mixed | any | the 001 support refuses first (`line-endings`) | — |
| any | `ident` set | the review refuses first (`ident`) | — |

## 7. Refusal reasons

| Reason | Applies to | Source fact |
| --- | --- | --- |
| 001 support reasons (`rename`, `mode`, `type`, `symlink`, `submodule`, `LFS`, `filter`, `state`, `index-flag`, `path`) | all | `decideSupport` and the status record; also `type` for a `directory` fact of the target (spec Edge Cases "The working file is a folder now"), and `path` for a Windows `file` fact with `exactName: false` (plan D8) |
| `binary`, `encoding`, `size`, `line-endings` | lines | `decideSupport`, `revert-bytes.ts` proof |
| `ident` | lines | `check-attr` `ident` = `set` |
| `context-only`, `several-hunks`, `deleted-file`, `new-file`, `eof-newline` | lines | `subHunk`, the renderer mapping; in the renderer, `deleted-file` and `new-file` come from the comparison field `fileChange` (contract Δ3 `readComparison`); a type change `T` gives `null`, and the renderer refuses |
| `unstaged-changes` | staged lines | the status worktree letter |
| `untracked` | files, lines | the status record `?` |
| `in-the-way` | files | the file fact: no index entry in the shown read and a present working file (any fact but `absent` or `error`), also for an ignored file; or a file that is not a folder at a folder name of that path. A file that appears between the review and the run ends `STALE_REVIEW` `revert-changed`. |
| `unreadable` (005) | all | a `fileFacts` `error` fact of a target or of a folder on its path; on WSL also a `detail` read without `syscall.ph` (research R15 "Probe L8 (T057)") |
| `attributes` | all | `check-attr` against `check-attr --cached` |
| `not-regular`, `hard-link`, `read-only`, `encrypted`, `owner`, `security`, `file-attributes`, `xattr` | all | `fileFacts` with `detail` (plan D8, D9). `not-regular`: a `link` fact at any component, or an `other` fact. |
| `limit` | files, unstaged | `MULTI_FILE_ACTION_FILES` |
| `nothing-to-revert` | unstaged | no covered entry |
| `LOCKED` (001 code, with the lock path and remedy) | all | the `index.lock` fact at the review and at the run start |
| eligibility (`sparse-index`, `split-index`, `executable-monitor`, `unqualified-monitor`; staged part also `index-change-hook`, WSL `shared-repository`) | all | `hunkEligibility` |

The refusal value (contract Δ3): `{reason}` for a repository-level reason, with `remedy` for an eligibility reason, or `{path, remedy}` for `LOCKED`. A file reason gives `{reason, files: [{path, reason}], more}`: the first 20 refused files in tree order, each with its reason, and the count of the other refused files. The top-level `reason` is the reason of the first file, and the response code is its code (`WORKBENCH_UNAVAILABLE` or `UNSUPPORTED_COMPARISON`).

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

A `not-changed` file with a reply code is the "failed with its code" outcome of spec FR-039: `refused` carries the reply reason, and `error` the reply code, as `reason`. A `not-changed` file without a code got `stopped` or `interrupted`. An `unstaged-only` file carries `code` and `reason` under the same rules (spec FR-017). Plan D10 gives the response state.

A fresh read that fails gives the unknown outcome of the whole run (001 FR-023).

- `newSha256` of a whole file is the SHA-256 of Git's temporary file that the request sent. A fresh digest equal to it gives `reverted`, also after an `interrupted` reply.
- Only the shell reply `stopped` means that a write did not start. A `fileReplace` without a shell reply within the service wait after a Cancel gives the unknown outcome of the whole run, and the recovery marker stays.
- No file changed and the first file got `stopped` without a Cancel: the shell deadline stopped it, so the response code is `DEADLINE`.

## 8a. Git temporary file (whole files, plan D5a)

- Per batch path: `{name, path, size, sha256}`. `name` comes from the exact parse of `<temp> TAB <path> NUL` and is one path component in the worktree root. `size` and `sha256` come from a streamed `fileFacts` digest.
- A record whose `path` is not a batch path, or a name with a separator, gives `MALFORMED_GIT_OUTPUT`.
- After a failed parse, only a complete record `<name> TAB <batch path> NUL` names a file that `tempRemove` may remove. Every other name stays, and the run ends with `MALFORMED_GIT_OUTPUT` or `GIT_FAILED` (known limit, spec FR-036).
- The record ends in one of two ways: a `fileReplace` with `source` consumes it, or `tempRemove` removes it by `name` with `size` and `sha256`. A stop between the two leaves it (spec FR-036 known limit).

## 9. Result (service to renderer)

`{action, files: [{entryId, outcome, code?, reason?}], foldersCreated: [pathBytes], index: "published" | "none" | "refused", reason?, remedy?}`. `foldersCreated` also holds the folders that a failed write created (contract Δ6 `folders` of a failure reply). The response state follows plan D10.

- `reason` `revert-changed`: a `STALE_REVIEW` result in which no file changed. `index` is `none` or `refused`, never `published`. The renderer shows the plan D11 multi-file stale text.
- `reason` with an eligibility value (`sparse-index`, `split-index`, `index-change-hook`, `executable-monitor`, `unqualified-monitor`, `shared-repository`): the index part refused with `UNSUPPORTED_HUNK_PROFILE`. `index` is `refused`, and `remedy: {text}` carries the text of the review refusal (`PROFILE_TEXTS`). Only these reasons carry `remedy`.
- A stale index part keeps the 005 shape `{action, reason: "revert-changed"}`, and a lock refusal keeps `{path, remedy}` (contract Δ3).
- The lock-time `file-id` refusal sends no `reason`. It is no eligibility reason, and `PROFILE_TEXTS` has no entry for it.

## 10. View state (renderer, not stored)

- `revert`: `null`, or `{kind, origin, review: "checking" | {plan, token} | {refused: reason}, running: boolean}`. `origin` names the control that gets the focus back.
- A new snapshot or a new comparison patch clears an open review that names the old one (001 FR-022).
