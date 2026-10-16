# Data Model: Workbench UX

Each section names its source. Field names are contract names. "001 data-model §n" and "003 data-model §n" name the earlier models.

## 1. Branch entry (`readBranches` result)

- `ref`: the full reference name, `refs/heads/<name>` or `refs/remotes/<remote>/<name>`.
- `kind`: `local` or `remote`.
- `name`: the short name. Display text only; actions send `ref`.
- `oid`: the commit of the ref.
- `upstream`: the full upstream ref, or null. From `%(upstream)`.
- `tracking`: the 003 data-model §1 entry when its `oid` and upstream OID equal this read, else null (003 FR-021 pairing rule).
- `heldBy`: the worktree path whose record has `branch <ref>`, or null.
- `current`: true for the `*` record of `%(HEAD)`.
- `localName`: for a remote ref, the D3 refspec mapping result, or null when zero or several refspecs map it.
- `hasLocal`: for a remote ref, true when `localName` names an existing local branch.
- Validation: the 003 `readTracking` record checks, plus the worktree record checks of §8.
- Order: local entries first, then remote entries, each by `ref` bytes (spec FR-008).

## 2. Workbench review (retained, one use)

- `workbenchToken`: a contract §2 identifier. Lifetime 60 s (001 `APPROVAL_LIFETIME_MS`).
- `action`: one of the contract Δ3 actions.
- `bound`: the values that `runWorkbench` re-reads. A difference gives `STALE_REVIEW`.
  - always: the HEAD target and OID, the operation markers, the trust state and class flag, the repository generation;
  - `switch`: the target ref and OID, the tracked status digest, `refs/stash`, the choice, and for Discard the in-the-way result;
  - `create-branch`, `rename-branch`: the name, the start OID, the absent target ref;
  - `delete-branch`: the ref and OID, the unmerged count, the worktree list digest;
  - `merge`, `rebase`: the source ref and OID, the counts, the options, the message digest;
  - `choose-side`, `mergetool`: the path, its index stages with modes and OIDs, the working file identity and SHA-256, the operation state;
  - `ignore`: the target file state (`absent`, or size and SHA-256), the line;
  - `worktree-add`: the path facts, the branch or OID;
  - `worktree-remove`: the worktree record, its status digest, the force flag, the branch delete facts;
  - `worktree-prune`: the prunable records;
  - `config-save`: each changed key with its scope, earlier entries, and new value or unset.
- Consumption: only after validation, as 003 data-model §2.

## 3. Switch plan and result

- Plan: `target` (`{local: ref}`, `{track: {ref, name}}`, or `{detach: oid}`), `trackedChanges` (count), `unreachable` (the detached commit OID or null), `heldBy`, `choice`, `inTheWay` (up to 100 paths, with `more` count).
- Result: the 001 outcome state plus:
  - `head`: the observed HEAD target and OID;
  - `stash`: `null`, or `{oid, state}` with `state` one of `dropped`, `kept-conflicts`, `kept-failed-apply`, `kept-failed-checkout`, `kept-not-found`;
  - `conflicted`: the unmerged count from the fresh index read;
  - `remedy`: for a kept stash, `& '<git>' --no-lazy-fetch -C '<worktree>' stash apply '<oid>'`, by the 001 §4 quoting rule.
- State transitions: `reviewed` → `stashing` → `checking-out` → `reapplying` → `dropping` → `reconciling` → terminal. Discard: `stashing` → `checking-out` → (`dropping` on success | `restoring` on refusal) → `reconciling`.

## 4. Branch delete check

- `ref`, `oid`, `onlyHere` (the unmerged count), `reflogKeeps` (true, false), `heldBy` (null, else the action is refused), `current` (false, else refused).
- Text rules: `onlyHere > 0` gives "<branch> has <n> commits that no other branch has. Deleting the branch loses them." `onlyHere = 0` gives "Deleting <branch> loses no commit." `reflogKeeps` gives the D4 reflog sentence.

## 5. Merge and rebase requests

- Merge: `source` (ref and OID), `result` (`merge` or `squash`), `noFastForward`, `noCommit`, `message` (null for Git's default, else the edited text, 1 to 64 KiB, the 001 commit message rule), `facts` (`ahead`, `behind`, `fastForward`, `mergeFf` with source).
- Rebase: `onto` (ref and OID), `moved`, `rewritten`, `held`, `forceNote` (`{trackingRef}` or null), `movedBranches` (refs, when `rebase.updateRefs` is true), `autostash` and `autosquash` (value plus `{scope, origin}` or `default`).
- Validation: `merge` refuses a detached HEAD, an unborn branch, the current branch as source, and an operation in progress (spec FR-028).

## 6. File selection and line selection

- File selection: `snapshotId`, `entryIds` (1 to 10,000, unique, all from one list of that snapshot), `direction` (`stage` or `unstage`), `kind` (`selected`, `folder`, `all-untracked`, `all-changes`, `all-staged`), and for `folder` the folder path bytes.
- Line selection: the 001 hunk approval key (`comparisonId`, `hunkId`, `direction`) plus `lines`: ascending unique ordinals of `+` or `-` lines in the body of that retained hunk, 1 to the hunk line count.
- Validation: an ordinal that names a context line, an incomplete-line marker, or a line outside the hunk gives `INVALID_REQUEST`. The refusals of plan D8 give `UNSUPPORTED_COMPARISON` with their reason.

## 7. Ignore line

- `target`: `gitignore` or `exclude`.
- `path`: the worktree-relative path bytes of the entry, and `folder` (true for an Untracked folder row).
- `line`: the escaped, anchored text without its LF.
- `prefixNewline`: true when the target does not end with LF.
- `expected`: `absent`, or `{size, sha256}`.

## 8. Worktree entry (`readWorktrees` result)

- `path`: the bytes of the `worktree` attribute.
- `head`: the OID, or null for `bare`.
- `branch`: the full ref, or null with `detached` true.
- `bare`, `detached`: booleans.
- `locked`: null, or `{reason}` where `reason` is null or the untrusted text.
- `prunable`: null, or `{reason}` with untrusted text.
- `main`: true for the first record. `current`: true when the path identity equals the workspace worktree identity.
- Record checks: the first line starts with `worktree `; each other line is one of the attribute forms; `HEAD` holds an OID of the object format; at most one of `branch` and `detached`; the record ends with an empty line. A failed check gives `MALFORMED_GIT_OUTPUT`.
- Bound: 1,000 records (`WORKTREE_RECORDS`) and 4 MiB.

## 9. Configuration value (`readGitSettings` result)

- `key`: the canonical key as Git prints it.
- `entries`: each `{scope, origin, value}` in listing order. `value` is null for a key without `=`.
- `scopes`: per scope (`system`, `global`, `local`, `worktree`, `command`) the entries of that scope.
- `effective`: the last entry, or null.
- `type`: `bool`, `enum` with the values of plan D11, or `text`.
- `readOnly`: true for several entries in the selected scope, or a bool value that Git cannot read.
- `files`: `local` (the common-directory `config` path), `global` (the plan D11 file), `system` (the `git var GIT_CONFIG_SYSTEM` result or null).
- `appSettings`: the 003 `defaultPullAction` and the `switchChoice`, marked "Arbareto setting, not in Git configuration" (spec FR-066, FR-068).

## 10. Trust approval record, version 2

- `policyVersion`: 2.
- `commonDirectory` with its `FileIdInfo` identity, `worktreeRoot` and `adminDirectory` with their identities (001 contract §7 "Trust approval store").
- `gitSelectedPath`.
- `approvedAt`.
- No fingerprint and no program digest.
- State rules: plan D12. A version 1 record gives `changed`.
- `readTrust` result: `state`, `approvalRequired` with the 001 `read` and `commit`, the 003 `sync`, and the new `workbench` and `mergetool` flags, and `programs` (hook events with folders, filter drivers with scopes, monitors, merge drivers, merge tools, signing programs, by name only).

## 11. Resolve request

- `path` bytes, `kind` (the porcelain v2 XY code and its text), `stages` (1 to 3, each with mode and OID), `side` (`ours` or `theirs`) or `tool` (the effective `merge.tool` with its scope and origin), `names` (`ours` and `theirs` labels by plan D7), `working` (existence, identity, SHA-256), `operation` (`merging` or `rebasing`).
- Kind texts: UU "Both modified", AA "Both added", AU "Added by us", UA "Added by them", DU "Deleted by us", UD "Deleted by them", DD "Both deleted".

## 12. Submodule row state (renderer)

- `path`, `depth`, `state` (`waiting`, `fetching`, `updating`, `done`, `failed`, `refused`, `skipped`), `percent` (from the 001 progress counter, or null), `observed` (the 001 row result), `exitCode` and `outputTail` for a failure.
- Host line: `{rows: [path], hosts: [{fetch, settings}]}` from the review, with Update anyway.

## 13. Shell settings additions

- `switchChoice`: `keep` (default) or `stash`. Any other value reads as `keep`.
- The 003 `defaultPullAction` stays.
- Trust records: version 2 (§10). The 256-record bound and 4 KiB per record stay (001 §5).

## 14. View state (renderer, not stored)

- Per worktree for the window session: `view` (`history`, `commit`, `settings`), `settingsScope`, `settingsPage`, `commitLayout` (`tree` or `flat` per list), `untrackedExpanded` (false at open), the multi-selection per list, the line selection of the shown diff, and `amend` (false at open) with the draft that the HEAD message replaced (spec FR-098).
- A new snapshot keeps the selection of entries whose IDs still exist, and drops the others.
