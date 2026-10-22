# Data Model: History Inspection and Commit View File Actions

Each section names its source. Field names are contract names. "001 data-model §n", "002 data-model §n", and "004 data-model §n" name the earlier models.

## 1. Commit changes (`readCommitChanges` result)

- `changesId`: a contract §2 identifier. The service keeps one listing per history view (plan D3).
- `viewId`, `oid`: the request values. `oid` is a row of the view.
- `parents`: the row parents in Git order, from the view topology. 0 to 64 OIDs (002 `HISTORY_PARENTS_PER_COMMIT`).
- `base`: `{kind: "parent", index, oid}`, `{kind: "empty-tree", oid}`, or `{kind: "shallow"}`.
- `files`: one entry per raw record, in Git's output order. Empty for `shallow`.
  - `fileId`: the 0-based record ordinal of this listing.
  - `status`: `added`, `deleted`, `modified`, `renamed`, or `type-changed` (raw A, D, M, R, T).
  - `score`: 0 to 100 for `renamed`, else absent.
  - `pathBytes`: the base64 path bytes. For `renamed`, the new path.
  - `oldPathBytes`: the base64 old path for `renamed`, else absent.
  - `kind`: `submodule` when either mode is 160000, `link` when either mode is 120000, else `file`.
- `completeness`: `complete`, or `limited` with `code` (`STATUS_LISTING_RECORDS`, `STATUS_LISTING_BYTES`, or `COMMIT_CHANGES_RESULT_BYTES`) and `shown`.
- Retained only in the service: the raw record bytes and offsets, the modes, and the object IDs of each entry.
- Validation: the raw grammar of plan D3 step 6. Status C, U, X, B, or another byte refuses the listing with `MALFORMED_GIT_OUTPUT`. Modes are six octal digits. OIDs match the object format. An added entry has the old mode 000000 and the zero OID; a deleted entry has the new mode 000000 and the zero OID.
- Lifetime: until the next `readCommitChanges` of the view, a view release, or a registration release. Then `UNKNOWN_TARGET`.

## 2. Commit file (`readCommitFile` result)

- `changesId`, `fileId`: the request values.
- `facts`: `{rename?: {oldPath, score}, mode?: {old, new}, submodule?: {old: oid | null, new: oid | null}, typeChange?: {old, new}}`. The kinds of `typeChange` are `file`, `link`, and `submodule`.
- `binary`: true when the numstat record holds `-` and `-` (git-diff(1) `--numstat`).
- `patch`: the base64 canonical patch, or null for a binary file, a submodule, a type change, and a pure rename or mode change without a hunk.
- `completeness`: `complete`, `limited` with `CANONICAL_DIFF_BYTES` or `CANONICAL_DIFF_LINES`, or `limited` with `OBJECT_MISSING` and the 001 remedy.
- Validation: `parsePatch` with the rename header rules, and `parseNumstat` with the old path for `renamed`.

## 3. Tree order key

- Source: plan D4. `src/contracts/tree-order.ts`.
- `components`: the path split at `/`, as bytes.
- `folded`: each component with the bytes 0x41 to 0x5A raised by 0x20.
- `folder`: true for a folder row, a submodule row (porcelain v2 `<sub>` starting with `S`, or a History entry of kind `submodule`), and a nested-repository row (an untracked record ending with `/`).
- Order: compare at the first differing component. A folder comes before a file. Then `folded` by unsigned bytes. Then raw bytes. A path that ends first, where the other path continues, is the file side.
- Built once per read for each row. Never from `localeCompare`, `Intl.Collator`, or `toLowerCase`.

## 4. Delete review (retained, one use)

- Source: plan D6, contract Δ3 `reviewWorkbench` `delete`.
- `workbenchToken`: a contract §2 identifier. Lifetime 60 s (`APPROVAL_LIFETIME_MS`).
- `mode`: `recycle` or `permanent`.
- `entries`: per path `{entryId, pathBytes, category, expected}`.
  - `expected`: the `fileFacts` fact at review. `file`: `size`, `lastWrite`, and `digest` (SHA-256) up to 1 MiB, or `bound`. `link`: `tag` and `target`.
- `folder`: the folder bytes of a folder Delete, or null.
- `folders`: the candidate folders of a folder Delete, deepest first (plan D6 step 4).
- `bound` (checked by `runWorkbench`): the snapshot ID, the repository generation, the operation markers, the conflicted count, and every `expected` fact.
- Plan fields (to the renderer): `mode`, `entryIds`, `files`, `tracked`, `folder`, `wsl`.
- Validation: 1 to 10,000 entries (`MULTI_FILE_ACTION_FILES`), all of the Changes list of that snapshot, categories `unstaged` or `untracked`. A folder Delete holds exactly the Changes entries below the folder. Refusals: contract Δ9.
- State transitions: `reviewed` → `checking` → `deleting` → `removing-folders` → `reconciling` → terminal. A stale check ends at `checking` with nothing deleted.

## 5. Delete result

- Per path: `outcome` one of `recycled`, `deleted`, `kept`, `changed`, `absent`, `not-regular`, `error`, `stopped`, with `code` for `error`, and `recycledPath` for `recycled` (the parsing name of `psiNewlyCreated`, Windows only).
- Per candidate folder: `removed`, `kept` (not empty), `absent`, `not-regular`, or `error` with `code`.
- The outcome table of plan D6 maps the shell reply and the fresh fact to the outcome.
- `state`: the 001 data-model §7 outcome: `succeeded`, `failed`, `failed-with-effects`, or `canceled`.
- `recycledPath` never enters a log line. Tests use it to purge their own items.

## 6. Ignore file (`readIgnoreFile` result)

- Source: plan D8.
- `target`: `gitignore` or `exclude`.
- `file`: the path in Git's form: `<worktree root>/.gitignore`, or the `rev-parse --path-format=absolute --git-path info/exclude` result.
- `state`: `absent` or `file`.
- `text`: the decoded text, with each CRLF replaced by LF and without the BOM. Empty for `absent`.
- `lineEnding`: `lf`, `crlf`, or `none` (no line break; Save uses LF).
- `bom`: true when the bytes start with EF BB BF.
- `expected`: `absent`, or `{size, sha256}` of the bytes on disk.
- Validation: at most 1 MiB, strict UTF-8, no NUL, one line-ending form. Refusals: `ignore-link`, `ignore-folder`, `ignore-not-regular`, `ignore-size`, `ignore-not-utf8`, `ignore-nul`, `mixed-line-endings`, `unreadable`, `path`.
- The text is untrusted. The renderer shows it as plain text only.

## 7. Ignore preview

- Source: plan D9.
- Request: `target`, `text` (base64 of the UTF-8 bytes of the editor text, LF form, at most 1 MiB decoded), `snapshotId` (the shown `readWorkspace` snapshot).
- Base (service memory only, one per workspace and target):
  - `snapshotId`, `target`, the S text bytes (the file on disk at base build).
  - `tracked`: the T paths with mode, stage, and the skip-worktree tag.
  - `untracked`: the U records, each `file`, `folder`, or `nested-repository` (an expansion that prints only `<d>/`).
  - `expansions`: per folder record, the cached expansion records.
  - `realIgnored` and `realTracked`: the RI and RT self-check listings (plan D9).
  - `sVerdicts`: per input, ignored or not under S, with the pattern source.
  - `selfCheck`: `passed`, or the failure reason.
- Result, one of:
  - `{preview: {newlyIgnored, noLongerIgnored, trackedMatched, notices}}`. Each group is `{count, paths}` with at most 1,000 base64 paths by `comparePaths`. `trackedMatched` is a count. `notices` holds at most 100 entries `{kind: "link" | "inside-ignored", pathBytes}` and a `more` count.
  - `{unavailable: {reason, bound?}}` with `reason` one of `paths`, `listing`, `name-case`, `shadow-copy`, `self-check`, `unreadable`, `deadline`.
- A failed Git step ends the response `failed` with its code. The renderer shows it as "Preview not available: Git failed with <code>.".
- Verdict rule: a `check-ignore -v -n` record whose pattern field is not empty and does not start with `!` is ignored.
- Lifetime of the base: until another `snapshotId` or target, a registration release, or a service exit.

## 8. Ignore save review (retained, one use)

- Source: plan D10.
- `workbenchToken`, lifetime 60 s.
- `target`, `file`, `expected` (the loaded state).
- `bytes`: the BOM when the file has one, then the text in the file's line-ending form.
- `after`: `{size, sha256}` of `bytes`.
- `bound`: `expected`, the repository generation, and the Arbareto mutation markers (001 FR-015). The Git operation state and the conflicted count are not bound, because Save runs during an unfinished operation and with conflicts (spec FR-046).
- Validation: the request text decodes from base64 to strict UTF-8 of at most 1 MiB. A NUL passes the schema, and the review refuses it with `ignore-nul` (contract Δ3). `bytes` at most 1 MiB, else `ignore-size`.
- Result: `replaced`, or the 001 outcome with `STALE_REVIEW` `ignore-changed`, `stale`, `not-regular`, `stopped`, `interrupted`, or `error {code}`, cross-checked by the fresh target digest.

## 9. Submodule open and the parent chain

- Request: `repositoryId` (the parent), `path` (worktree-relative text, `/` separators).
- Checks: plan D11 steps 1 to 6.
- Result: the 001 `chooseRepository` registration result of the submodule.
- Parent chain (renderer, window session): a stack of at most 8 entries `{entryId, name, path}`. `entryId` is the recent entry that `listRecentRepositories` marked `current` before the open, or null. `name` is the last path component of `path`.
- Transitions: Open submodule pushes. Open parent repository pops on success and clears the stack on failure. Every other open clears the stack.

## 10. Blame request and result

- Source: plan D12.
- Request `source`: `{changesId, fileId}`, `{snapshotId, entryId}`, `{blameId, line}`, or `{blameId}`. `{blameId}` gives the commit and path of the retained result (its `commit` and `pathBytes`). Steps 1 to 6 run with the new options. `focusLine` is absent. An unknown ID gives `UNKNOWN_TARGET`. The generation is not checked, as for `{blameId, line}`. `options`: `ignoreWhitespace`, `detectMoves`, `detectCopies`, `ignoreList` (booleans).
- Result:
  - `blameId`: a contract §2 identifier. One retained result per workspace.
  - `commit`: the blamed commit OID. `pathBytes`: the blamed path.
  - `content`: the base64 file bytes, at most 4 MiB. `lines`: the line count N, at most 100,000.
  - `ignoreList`: `none`, `on`, or `off` (the toggle state of this run).
  - `groups`: in final line order, each `{commit, origStart, finalStart, count, ignored, unblamable}`. `commit` is an index into `commits`. `ignored` and `unblamable` are true only from the porcelain markers.
  - `commits`: one entry per distinct (oid, previous, filename) origin (blame.h `blame_origin`). An `oid` can repeat. Each `{oid, author, authorMail, authorTime, authorTz, summary, previous: {oid, pathBytes} | null, filenameBytes, shallow}`. Text fields are the raw bytes as base64, because `--encoding=none` gives Git's stored bytes. `authorMail` holds Git's bytes, with the angle brackets.
  - `focusLine`: for a `{blameId, line}` source, the data-model §11 mapped line, an integer from 1 to `lines`. Absent for the other sources, and absent when `lines` is 0.
- Validation: the groups cover 1 to N exactly once; `previous` OIDs match the object format; `authorTime` is an integer; `authorTz` matches `[+-][0-9]{4}`.
- Progress event `blame`: `{blamed, total}` in incremental mode, at most 4 per second; no counters in porcelain mode.

## 11. Blame before mapping

- Input: the retained result, a line L. The group g with `finalStart ≤ L < finalStart + count`. The commit X of g with `previous {P, Q}`.
- `o = origStart + (L - finalStart)`, the line in X's version of `filename`.
- Hunks of `diff -U0 <blob Q at P> <blob filename at X>`: `(a, b, c, d)` from `@@ -a[,b] +c[,d] @@`, with an omitted count of 1.
- Map: a hunk with d > 0 and c ≤ o < c + d gives a, or a + 1 when b = 0. Otherwise o + Σ(b − d) over the hunks that end before o. A hunk with d > 0 ends at c + d − 1. A hunk with d = 0 ends at c, because Git prints the new line before an empty range as c (xdiff `xdl_format_hunk_hdr`, F9). The result clamps to 1 and the line count of Q. A Q without lines gives no mapped line.
- Output: the new blame request `{source: {blameId, line: L}}` runs for `(P, Q)`, and its result carries the mapped line as `focusLine` (§10).
- No `previous`: reason `no-previous`.

## 12. Branch tracking facts

- `BranchEntry` (004 data-model §1) gains the required `upstreamPresent` (boolean or null): false when `upstream` is null; else false for the 003 track state `gone` of the paired tracking entry and true for another state; null without a paired entry (unknown, no mark).
- Gone: `upstream !== null && upstreamPresent === false`. The sidebar takes `gone` from the 003 track state of its tracking label.
- `RefEntry` (001 data-model §4) gains `nameBytes` (base64 raw name bytes) exactly when `invalidUtf8` is true. The References tree keys on these bytes (§3).
- Card facts (renderer, no new read): `name` (the full ref name without its namespace), `upstream` (short name or null), `gone`, `tracking` (the 003 `ahead` and `behind`, or null), `heldBy` (from the latest `readBranches`, or unknown when none is loaded). A remote row holds only `name`.

## 13. Shadow folder (shell)

- Source: plan D14, contract Δ6 `shadow`.
- `shadowId`: a contract §2 identifier, bound to one operation.
- Path: `<launch directory>/preview/<pid>-<creation time>-<16 hex>` on Windows, or `/tmp/arbareto-preview-<pid>-<creation time>-<16 hex>` in a WSL distro. `<pid>` and `<creation time>` name the shell process. The launch directory is the per-user app local data folder, or the launch folder below `ARBARETO_PROFILE_ROOT` (`service.rs:108-113`). It is never the install folder.
- Lifetime: until its operation ends, also after Cancel, `closeJob`, or a service exit. Leftovers whose owner process record does not exist go at the next create.
- Files: two shadow repositories, `s` (saved text) and `c` (candidate text). Each holds its `.git`, `.git/index`, `.git/exclude.index`, the ignore files, and the empty folders of the folder inputs.

## 14. View state (renderer, not stored)

- History, per view: `changes` (§1), `parent` (index), `selectedFile` (`fileId`), `fileFilter`, `layout` (`tree` or `flat`), `blame` (§10 with the selected line and the source to return to), `tab` (`commit` or `changes` in the constrained profile).
- Commit view: the delete review (§4) while its confirmation shows; `ignoreEditor`: `{target, loaded (§6), text, selection, preview (§7) or null, previewState: "idle" | "updating" | "unavailable", stale: boolean}`.
- Window: the parent chain (§9).
- A new snapshot keeps the selected file when its path still exists, and drops it otherwise. A new snapshot rebuilds the ignore preview base at the next preview.
