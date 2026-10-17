# Operation Contract Deltas: Workbench UX

This file lists only the changes to the feature 001 contract (`specs/001-desktop-qualification/contracts/operations.md`), the feature 002 deltas (`specs/002-full-history/contracts/operations.md`), and the feature 003 deltas (`specs/003-remote-sync/contracts/operations.md` on branch `f003-spec`). "001 §n", "002 Δn", and "003 Δn" name those sections. Every rule that no delta replaces stays in force.

## Δ1 Transport (001 §1)

- New renderer operations: `readBranches`, `readWorktrees`, `readGitSettings`, `reviewWorkbench`, `runWorkbench`, `applyFiles`, `openWorktree`, `revealPath`. Each has one Tauri command and one zod schema.
- New shell-only operation: `setSwitchChoice`. The shell answers it natively and never forwards it.
- `openWorktree` is native-first, as `chooseRepository` is (001 §3). `reviewWorkbench` with action `worktree-add` is native-first for its path.
- `readGitSettings` without `repositoryId` runs in the `globalConfig` context (Δ6).
- Keep explicit range checks in Rust (001 §1).

## Δ2 Envelope (001 §2)

- `readBranches`, `readWorktrees`, `reviewWorkbench`, `runWorkbench`, and `applyFiles` carry `repositoryId`. The reads and the review carry `repositoryGeneration`.
- `MUTATIONS` gains `runWorkbench` and `applyFiles`. The repeat key of `runWorkbench` is its `workbenchToken`. The repeat key of `applyFiles` is its approval key (Δ4).
- `applyFiles` carries no `repositoryGeneration`. Its `snapshotId` binds the shown read.
- Phases: `switch-stash`, `switch-checkout`, `switch-reapply`, `switch-drop`, `branch`, `merge`, `rebase`, `resolve`, `mergetool`, `worktree`, `config`, `ignore`, `stage-files`. Counters: `fileIndex` and `fileCount` for `stage-files`, `keyIndex` and `keyCount` for `config`. Events carry no ref name, path, or Git text.
- `runWorkbench` progress carries no stall flag (001 §6 "Activity and stall notice"), so its steps show no stall notice.

## Δ3 Public operations (001 §3)

Every argument array below starts with `--no-lazy-fetch`. Reads add `--no-optional-locks` and `--literal-pathspecs`, except `check-ignore --no-index` (plan D3). Policies are in brackets. `<name>`, `<old>`, and `<new>` passed the branch name rule (plan D4). `<ref>` is a full ref name from the review. `<oid>` matches the object format. `<path>` is the literal path bytes.

A payload `ref` lies under `refs/heads/` for a local branch, under `refs/remotes/` for a `track` target, and under either for `merge` and `rebase`. Another ref gives `INVALID_REQUEST`.

### `readBranches`

- Payload: `{}`. One read slot. Held step and read gate, as `readRefs` (001 §7 "Held history steps").
- Reads: `for-each-ref --format=%(refname)%00%(objectname)%00%(upstream)%00%(HEAD)%00%(symref) refs/heads refs/remotes`, the `readWorktrees` command, and the remote fetch refspecs from the trust listing entries `remote.<name>.fetch`.
- Record checks: five fields with four NUL bytes and LF; the refname under `refs/heads/` or `refs/remotes/`; the OID of the object format; `upstream` empty or under `refs/`; `HEAD` `*` or a space, with at most one `*` under `refs/heads/`; `symref` empty or under `refs/`. A record with a non-empty `symref`, such as `refs/remotes/origin/HEAD`, is no branch entry and is skipped.
- Bounds: `REF_LISTING_RECORDS` and 4 MiB. The 30 s deadline.
- Result: data-model §1.

### `readWorktrees`

- Payload: `{}`. One read slot.
- Command: `worktree list --porcelain -z` [`read`].
- Parse: data-model §8 record checks. Bounds: `WORKTREE_RECORDS` and `WORKTREE_LISTING_BYTES` (4 MiB).
- The service sends one identity request per record path (001 §6), at most 8 paths per request, to mark the current record.

### `readGitSettings`

- Payload: `{}`. With `repositoryId`, the read runs the 001 configuration listing of that workspace. The 001 §7 read gate does not apply, because the listing runs no program. Without `repositoryId`, the shell runs the same command in the `globalConfig` context.
- Command: `config list --show-scope --show-origin -z` [`read`].
- Result: data-model §9 for the keys of spec FR-060, plus `difftool.<t>.path`, `difftool.<t>.cmd`, `mergetool.<t>.path`, and `mergetool.<t>.cmd` for the effective `diff.tool` and `merge.tool` values `<t>`.
- Values pass the 001 §7 URL redaction before display.

### `reviewWorkbench`

- Payload, one of:
  - `{action: "switch", target: {ref} | {track: {ref, name}} | {detach: oid}, choice: "keep" | "stash" | "discard"}`;
  - `{action: "create-branch", name, start: oid, switchTo: boolean}`;
  - `{action: "rename-branch", ref, name}`;
  - `{action: "delete-branch", ref}`;
  - `{action: "merge", ref, result: "merge" | "squash", noFastForward, noCommit, message: string | null}`;
  - `{action: "rebase", ref, autostash: boolean, autosquash: boolean}`;
  - `{action: "choose-side", entryId, side: "ours" | "theirs"}` with the shown `snapshotId`;
  - `{action: "mergetool", entryId}` with the shown `snapshotId`;
  - `{action: "ignore", entryId, target: "gitignore" | "exclude"}` with the shown `snapshotId`;
  - `{action: "worktree-add", branch: {new: name, start: oid} | {existing: ref}, bootstrapId}`; the shell bound the path (Δ6 `worktreeAdd`);
  - `{action: "worktree-remove", worktree: path, force: boolean, deleteBranch: boolean}`;
  - `{action: "worktree-prune"}`;
  - `{action: "config-save", scope: "local" | "global", changes: [{key, value: string | null}]}`, 1 to 32 changes, each key from the FR-060 list or a tool key of `readGitSettings`, and each key at most once.
- One read slot. Every review reads the 001 HEAD capture, the operation markers, and the trust listing (own or shared, 001 §7), with the 30 s deadline.
- Common refusals before any token: `OPERATION_IN_PROGRESS` (except `choose-side`, `mergetool`, `ignore`, `config-save`, `worktree-prune`, and `worktree-remove` of another worktree), `CONFLICTED` with the count (for `switch`, `merge`, `rebase`), `TRUST_REQUIRED` or `TRUST_CHANGED` for an action whose class needs approval (Δ7), `INVALID_REQUEST` for a name that fails the rule, `WORKBENCH_UNAVAILABLE` with a Δ9 reason.
- Reads per action:
  - `switch`: `status --porcelain=v2 -z --untracked-files=no --ignore-submodules=dirty`; `readWorktrees`; `rev-parse --verify -q <ref>^{commit}` for a ref target; for a detached HEAD C, `for-each-ref --contains=<C> --count=1 --format=%(refname)`; `show-ref --exists refs/stash`, then `rev-parse --verify -q refs/stash`; for Discard, the plan D3 in-the-way check: `diff-tree -r -z --no-renames --name-status <HEAD> <target oid>`, `fileFacts` (001 §6), `ls-files -z --stage` for the candidates (a file or link counts only without a stage-0 entry at its path), and `--no-lazy-fetch --no-optional-locks check-ignore -z --stdin --no-index` with the candidates on stdin, without `--literal-pathspecs` (Git exits 128 with it). A candidate that starts with `:` gives reason `path` before that read, because Git can read a leading `:` as pathspec magic without the flag (plan D3). For `track`, the plan D3 Track rule reads the trust listing entries `remote.<name>.fetch` first. No mapping remote, or a fetch refspec that Git refuses, gives reason `no-tracking-refspec`. Two or more mapping remotes give reason `several-tracking-remotes` with `remotes`. Then `show-ref --exists refs/heads/<name>` exit 2 must hold; exit 0 gives reason `name-exists` with `ref`. A `ref` target equal to the HEAD branch gives reason `same-branch`. An unborn HEAD with choice `stash` or `discard` gives reason `unborn`. A nonzero `rev-parse --verify -q` exit for the target gives `GIT_FAILED`, because git-rev-parse(1) names no exit code for a missing ref. A `ref` target `refs/heads/@` and a `track` name `@` give reason `reserved-name` before any Git process (plan D4, research R21 F29). A `ref` target whose short name starts with `-` gives reason `invalid-name` before any Git process, because the switch argv has no end-of-options marker and Git's `check-ref-format --branch` refuses that name (FR-004). In the in-the-way check, a `fileFacts` reply of kind `other` counts as in the way, because Git's checkout refuses every untracked entry in the way that is no folder (unpack-trees.c `verify_absent`). A reply of kind `error` gives reason `unreadable`.
  - `create-branch`: the name `@` gives reason `reserved-name` before any Git process (plan D4); `check-ref-format --branch <name>`; `show-ref --exists refs/heads/<name>`.
  - `rename-branch`: the same for `<new>`. An old name `@` passes (F29).
  - `delete-branch`: `readWorktrees`; `rev-list --count <oid> --not --exclude=<name> --branches --tags --remotes`; `reflog exists HEAD`, then `log -g -z --no-show-signature --format=%H -n 10000 HEAD --`. `--no-show-signature` stops `log.showSignature` from running the signing program in a read (git-config(1)), as in the 001 §8 "Commit attribution read".
  - `merge`: `rev-list --left-right --count HEAD...<oid>`; `merge-base --is-ancestor HEAD <oid>` (exit 0 or 1; another exit gives `GIT_FAILED`); the effective `merge.ff`; the message preview `fmt-merge-msg` with one stdin line that holds the short display name (plan D5). A non-zero `fmt-merge-msg` exit gives `GIT_FAILED`. For `result: "merge"`, a preview or a `message` above `MERGE_MESSAGE_BYTES` gives reason `message-size`. So does a merge command line above the 001 §6 bound, measured with the bound message by the 001 §6 measure (`git.exe` or `wsl.exe` line).
  - `rebase`: the plan D6 counts; the 003 D4 destination for the force note; when `rebase.updateRefs` is true, `for-each-ref --merged=HEAD --no-merged=<oid> --format=%(refname) refs/heads` and `readWorktrees`, then the moved list without each ref that the `branch` attribute of another worktree record names; the effective `rebase.autoStash` and `rebase.rebaseMerges`. `rebase.autoSquash` is not read, because Autosquash starts unchecked (plan D6).
  - `choose-side`, `mergetool`: `ls-files -z --stage -- <path>`; the working file facts and SHA-256 (001 §4 "Binding"); for `mergetool`, the effective `merge.tool` and its tool keys.
  - `ignore`: `rev-parse --path-format=absolute --git-path info/exclude` for `exclude`; `fileFacts` with `digest: true` of the target (1 MiB bound). The line of `src/contracts/ignore-line.ts` gives reason `path` for a control character or invalid UTF-8, and reason `limit` above 4,096 UTF-8 bytes.
  - `worktree-add`: `{existing: "refs/heads/@"}` gives reason `reserved-name` before any Git process (plan D4); `readWorktrees`; `destinationFacts` (003 Δ6) of the bound path: `absent` or `empty` passes, other replies give `DESTINATION_NOT_EMPTY`; for `new`, the `create-branch` checks.
  - `worktree-remove`: `readWorktrees`; in that worktree, `-C <path> status --porcelain=v2 -z --untracked-files=all --ignore-submodules=dirty` under the trust state of that worktree; for `deleteBranch`, the `delete-branch` reads.
  - `worktree-prune`: `readWorktrees`. No prunable record gives reason `nothing-to-prune`.
  - `config-save`: the configuration listing. A key with several entries in the scope gives reason `multi-value`.
- Result: `{action, plan, workbenchToken}`. `plan` holds the data-model §3 to §11 fields for display.

### `runWorkbench`

- Payload: `{workbenchToken, start: true}`. For a review with host lines (Δ12) it is `updateSubmodules`, not this operation.
- Protocol:
  1. Enter the mutation exclusion and wait for the recovery marker ID, kind `workbench` (001 §6).
  2. Re-read every bound value (data-model §2). A difference gives `STALE_REVIEW`, and no process starts. Consume the token only after validation.
  3. Run the steps of the action. Honor Cancel at any time; Cancel closes the Job, and no later step starts.
  4. Reconcile: HEAD, the refs listing, the index, the markers, the unmerged count, `refs/stash` and its reflog, the worktree list, and for `config-save` the listing. WSL first waits for the 001 §4 process-end fact.
- Steps [policy `integrate` unless stated]:
  - `switch` keep: `checkout --no-guess --no-recurse-submodules <branch> --`; track: `checkout --no-guess --no-recurse-submodules -b <name> --track=direct <ref> --`; detach: `checkout --no-recurse-submodules --detach <oid> --`.
  - `switch` stash: `stash push --quiet -m "Arbareto: switch to <branch>"`; the S checks (plan D3); the checkout; then `stash apply --index <S>`; then the drop step.
  - `switch` discard: the stash steps without the apply. A succeeded checkout runs the drop step. A refused checkout runs `stash apply --index <S>` on the unchanged HEAD. The drop step then runs only after exit 0 with no unmerged entry.
  - Drop step: `log -g -z --no-show-signature --format=%H refs/stash --` (bound 10,000 entries; `--no-show-signature` as in the `delete-branch` read); with exactly one entry n equal to S, `stash drop --quiet stash@{n}`. A reflog above the bound proves no single entry, so S stays with state `kept-not-found`.
  - `create-branch`: `checkout --no-recurse-submodules -b <name> <oid> --`, or `branch --end-of-options <name> <oid>`.
  - `rename-branch`: `branch -m --end-of-options <old> <new>`.
  - `delete-branch`: `update-ref --no-deref -d refs/heads/<name> <oid>`; then, when the listing held a local `branch.<name>` entry, `config --local --remove-section branch.<name>`. A non-zero `update-ref` exit runs no second step. A branch that moves after the re-read makes `update-ref` exit non-zero, and the branch stays. The fresh reads see the move, so the outcome is `failed-with-effects`.
  - `merge` with `result: "merge"`: `merge --no-autostash --no-edit [--no-ff] [--no-commit] --no-log -m <message> --end-of-options <ref>`. `<ref>` is the full ref. `<message>` is the bound preview or the edited text.
  - `merge` with `result: "squash"`: `merge --no-autostash --no-edit --squash --end-of-options <ref>`, without `--no-log -m`. Git ignores `-m` with `--squash` and writes its own `SQUASH_MSG` (research R21 F30). The later 001 `commit` takes the commit box text.
  - `rebase`: `rebase (--autostash|--no-autostash) (--autosquash|--no-autosquash) --end-of-options <ref>`.
  - `choose-side`: `--literal-pathspecs checkout --no-recurse-submodules --ours -- <path>` or `--theirs`. `--literal-pathspecs` keeps the path literal (FR-004). Without it, a path with `[` (valid on NTFS) is a glob, and the checkout overwrites the working files of other matching paths.
  - `mergetool` [`mergetool`]: `--literal-pathspecs mergetool --tool=<tool> --no-prompt -- <path>`, with empty stdin (plan D7).
  - `ignore`: the `fileAppend` request (Δ6). No Git process.
  - `worktree-add`: `worktree add -b <new> -- <path> <oid>` or `worktree add -- <path> <branch short name>`. `<path>` is the `path` of the `destinationFacts` reply (Δ6).
  - `worktree-remove`: `worktree remove [--force] -- <path>`; then, after a fresh list without that path, the `delete-branch` steps.
  - `worktree-prune`: `worktree prune`.
  - `config-save`: per change, the listing again, then `config set --<scope> -- <key> <value>` or `config unset --<scope> -- <key>`.
- Results: data-model §3 for `switch`. Other actions return the 001 outcome state with the observed effects. These are the refs before and after, HEAD, the stash entry, the worktree list, and the written keys. A failed step adds its `outputTail` (001 §9 rules).
- Git exit codes that decide: `merge-base --is-ancestor` (0, 1), `show-ref --exists` (0, 2), `config set` and `unset` (1 to 6, git-config(1)), `check-ref-format` (0 or non-zero). Every other exit only marks a step as failed; fresh reads decide the outcome.

### `reviewCommit` and `commit` (001 §3, §4 "Commit validation and handoff")

- `reviewCommit` payload adds `amend?: true`. The review then adds these reads: `cat-file commit <HEAD oid>` for the message, the bytes after the first empty line; `for-each-ref --format=%(upstream) <HEAD ref>`; with an upstream U, `merge-base --is-ancestor HEAD <U>` (exit 0 or 1; another exit gives `GIT_FAILED`).
- The result adds `amend: {headOid, message, upstream, rewritesUpstream}`. An empty staged scope still carries a `reviewToken` for an amend. The token binds `headOid` and `rewritesUpstream`.
- Refusals: an unborn HEAD gives `WORKBENCH_UNAVAILABLE` reason `unborn`. A merge or a rebase gives `OPERATION_IN_PROGRESS`. An `encoding` header that Git does not treat as UTF-8 gives `COMMIT_ENCODING_UNSUPPORTED`.
- `commit` payload adds `amend?: true` and `confirmRewrite?: true`. A token with `rewritesUpstream` true and no `confirmRewrite: true` gives `INVALID_REQUEST`. `amend` must equal the review.
- `confirmRewrite` comes only with `amend: true`, because only an amend review can rewrite the upstream. Another form gives `INVALID_REQUEST`.
- Step: `commit --quiet --amend --file=-`. This changes the 001 §4 rule that forbids `--amend`, for this payload only. Every other 001 handoff rule stays.

### `applyFiles`

- Payload: `{snapshotId, entryIds, direction, kind, folder?}` (data-model §6). Approval key: `{kind: "files", snapshotId, entryIds digest, direction}`.
- The kind fixes the direction: `all-untracked` and `all-changes` stage, and `all-staged` unstages. `folder` comes only with kind `folder`. Another form gives `INVALID_REQUEST`.
- Steps: Δ4. Policy: 001 `mutation` with the owned candidate.

### `applyHunk` (001 §3, §4)

- Payload adds `lines?: number[]` (data-model §6). Δ4 has the steps.
- The schema caps `lines` at `CANONICAL_DIFF_LINES` ordinals, and each ordinal at that value, because the 001 §5 canonical diff bound caps a hunk body.

### `openWorktree`

- Renderer payload: `{repositoryId, path}`.
- Native step: the shell checks the path text (001 Windows rules or the §11 WSL route) and binds a `repositoryDiscovery` context. It forwards `{repositoryId, bootstrapId}`.
- Service: `readWorktrees` of `repositoryId`. The bound path identity must equal one record identity. Otherwise `UNKNOWN_TARGET`. Then the 001 `chooseRepository` registration flow with the same `bootstrapId`.

### `revealPath`

- Payload: `{repositoryId, entryId}`. The shell forwards it to the service. `repositoryId` sits in the payload, as for `openWorktree`.
- The service maps `entryId` of its current read to the worktree root and the path. It sends the private `reveal` request (Δ6). The shell checks by `fileFacts` that the path lies inside the root. Then it calls `SHOpenFolderAndSelectItems`. A WSL path uses its UNC form. Errors give `UNKNOWN_TARGET`.
- Shell rules: the path lies below the worktree root by text (001 §7 "Inside and outside"), and ASCII letters fold only for a Windows root. The `fileFacts` walk of its components meets no reparse point on the way. The entry is a file, a folder, or a link as the last component. The root itself, an absent entry, a failed show, and the walk deadline give `UNKNOWN_TARGET`. A path that breaks the channel path rule gives `INVALID_REQUEST`. Only the walk finish calls `SHOpenFolderAndSelectItems`.

### Shell-only operations

- `setSwitchChoice {choice: "keep" | "stash"}`: stores data-model §13 `switchChoice`. It answers the 003 `readSyncSettings` result, which carries `switchChoice` (Δ14).

## Δ4 File staging (001 §4)

- Line selection: 001 §4 "Do not accept raw patch text or line ranges from the renderer" changes. The renderer may send line ordinals of one retained hunk (data-model §6). The service builds the sub-hunk (plan D8). It never takes patch text from the renderer.
- Sub-hunk rules: stage keeps each selected line, turns each unselected `-` line into a context line, and drops each unselected `+` line. Unstage keeps each selected line, turns each unselected `+` line into a context line, and drops each unselected `-` line. The old count is the context and `-` lines; the new count is the context and `+` lines. Each start names the first line of its side, and a side with count 0 names the line before, as xdiff `xdl_emit_hunk_hdr` prints it.
- Line refusals (`UNSUPPORTED_COMPARISON`): `context-only`, `deleted-file`, `new-file`, `eof-newline`, and every 001 FR-011 reason. `new-file`: unstage applies a staged addition in reverse as a deletion, and Git refuses a partial deletion (apply.c `parse_single_patch`). So every line selection of an unstage with a `new file mode` header refuses.
- `several-hunks` comes only from the renderer. Its hunk mapping refuses a selection in two hunks and sends no request (plan D15). At the service, an ordinal outside the retained hunk gives `INVALID_REQUEST` (data-model §6).
- `eof-newline`: a hunk whose body holds a `\ No newline at end of file` line, on either side, refuses every partial selection before the apply. A selection of every `+` and `-` line of the hunk passes as the whole hunk (plan D8, research R21 F25).
- Steps 4 to 9 of 001 §4 "Hunk eligibility and publication" stay. `applyToContent` takes the sub-hunk.
- `applyFiles` stage: steps 1 to 9 of 001 §4 "File staging", with these changes. Step 3 digests every working file. Step 5 sends every path on one stdin to `update-index --add --remove -z --stdin`. Step 6 verifies every entry with the 001 single-file proof A, and proof B runs per failed file. No batch proof exists yet (plan O-17, research R21 F26). Step 7 re-reads `status --porcelain=v2 -z` for exactly those paths and digests every file again. One refused file refuses the whole action, names the file, and gives its reason (spec FR-038).
- `applyFiles` unstage: one `update-index -z --index-info` with the HEAD mode and OID of every path, mode 0 for a path without a HEAD entry.
- The 001 file-action decision of each entry must accept the direction. A refused entry refuses the action before step 1.
- Status cut: `readWorkspace` gains `cut: "untracked" | "other" | null` in a `limited` result. `untracked` holds when the read reached its bound and the last parsed record is a `?` record. Then the tracked, unmerged, and staged entries are complete, and Commit is not blocked by the limit. `other` keeps the 001 rules.

## Δ5 Finite bounds (001 §5)

| Limit | Value |
|---|---|
| Multi-file action files (`MULTI_FILE_ACTION_FILES`) | 10,000 |
| Multi-file action working bytes (`MULTI_FILE_ACTION_BYTES`) | 512 MiB (`STREAMED_PROCESS_INPUT_BYTES`) |
| Discard check candidates (`DISCARD_CHECK_PATHS`) | 20,000 |
| In-the-way paths in a result | 100, plus a count |
| Worktree records (`WORKTREE_RECORDS`) and listing bytes (`WORKTREE_LISTING_BYTES`) | 1,000 and 4 MiB |
| Stash and HEAD reflog reads (`REFLOG_SCAN_ENTRIES`) | 10,000 entries |
| Moved branches listed in the rebase panel | 100, plus a count |
| Config changes per Save | 32 |
| Ignore target file | 1 MiB |
| Ignore line | 4,096 UTF-8 bytes |
| Merge message (`MERGE_MESSAGE_BYTES`) | 8 KiB (8,192 UTF-8 bytes), so the `-m` item takes at most 16,387 of the 32,767 command-line units (plan D5) |
| Branch name | 255 UTF-8 bytes |
| Trust dialog names per kind | 20, plus a count |
| Workbench review token lifetime | 60 s |
| `integrate` and `mergetool` process limits | inactivity 300 s and none; ceiling 4 h for both |
| Review reads | 30 s |

## Δ6 Private native process requests (001 §6)

- Policy fit: `integrate` runs need an operation that started as kind `sync` (003 Δ6), `workbench`, or `applyFiles`. `mergetool` runs need kind `workbench` with action `mergetool`.
- Policy `mergetool` takes no inactivity limit and the 4-hour ceiling. Its stdin is empty: the shell gives the child a closed pipe.
- A `mergetool` run carries the limits `{ceilingMs}` only (`CeilingLimits`), so it gets no stall notice.
- New context `globalConfig`: cwd is the application-owned launch folder. Accepted arrays: `--no-lazy-fetch --no-optional-locks --literal-pathspecs config list --show-scope --show-origin -z`, and `--no-lazy-fetch config set --global -- <key> <value>` and `--no-lazy-fetch config unset --global -- <key>`. Any other array gives `INVALID_REQUEST`.
- `globalConfig` policies: the listing runs only under `read`, and `config set` and `config unset` only under `integrate`. A write takes the `integrate` kind fit, so it needs a `started` marker of kind `sync`, `workbench`, or `applyFiles`. Without an open repository, no marker exists, so no write runs. A WSL Git gets `INVALID_REQUEST` (contract gap).
- New context `worktreeAdd`: bound by the native step of `reviewWorkbench` `worktree-add`. It serves `destinationFacts` (003 Δ6) and the `worktree add` array, whose path item must equal the bound path in Git's form.
- The `worktreeAdd` context IDs are `gitInstallationId`, `repositoryId`, and `bootstrapId`. Its `destinationFacts` request names the binding by `bootstrapId` in place of `cloneId`.
- The `destinationFacts` reply to the `worktreeAdd` form adds `path`: the bound path in Git's form for the route. That is the Windows path for a Windows Git and the Linux path for a WSL Git. The path item of the `worktree add` run must equal it byte for byte. The reply to the clone form carries no `path`.
- A `registeredOperation` run never runs `worktree add` or `clone`. Only their bound contexts name the folder that they write.
- The shell finds the Git command after the global options by the Git 2.55 `git.c` `handle_options` grammar. `--git-dir`, `--namespace`, `--work-tree`, `-c`, `--config-env`, `--shallow-file`, `-C`, and `--attr-source` take the next item as their value. The first other item that does not start with `-` is the command. A command `clone`, or `worktree` followed by `add`, gives `INVALID_REQUEST`.
- `worktreeAdd` lifetime: until its review result, the context lives at most the 001 60-second context lifetime. A result with a `workbenchToken` binds it to that token, for the token lifetime of 60 seconds from the result (Δ5, data-model §2). It ends earlier when the shell admits its `worktree add` run, when a new `worktree-add` review of the same repository replaces it, or when the service releases the repository. A result without a token ends it. No operation owns it, because the review and the run are two operations. This changes the 001 §6 "Context rules" owner rule for this kind only.
- New request `fileAppend {repositoryId, target: "gitignore" | "exclude", path, expected, bytes}`. The shell resolves `path` against the worktree root or checks that it lies inside the Git common directory, by identity (001 §7 "Inside and outside"). Windows: `NtCreateFile` opens each component relative to its parent handle with `OBJ_DONT_REPARSE`. The target open takes `FILE_OPEN_REPARSE_POINT`, `FILE_NON_DIRECTORY_FILE`, `FILE_OPEN` (or `FILE_CREATE` for `absent`), and `FILE_READ_DATA` with `FILE_APPEND_DATA` access, and it shares only reads. A reparse point on the way, a reparse tag, a folder, or a target with a `FILE_STANDARD_INFORMATION.NumberOfLinks` other than 1 gives `refused` reason `not-regular`; a size or SHA-256 other than `expected` gives `stale`; then one `WriteFile` at the end of the file and `FlushFileBuffers`. WSL: `wslFiles` mode `append` (Δ11). Reply: `appended`, `stale`, `refused {reason}`, or `error {code}`.
- Why `NtCreateFile`: `CreateFileW` takes a full path and follows a reparse point on the way, and `FILE_FLAG_OPEN_REPARSE_POINT` covers only the last component. The relative opens keep the target below the root by identity. `FILE_READ_DATA` serves the SHA-256 compare. Read sharing keeps other writers out from the check to the append.
- `fileAppend` rules: the operation holds a `started` marker of kind `workbench` with action `ignore-gitignore` or `ignore-exclude` that matches `target`. Another operation gets `INVALID_REQUEST`. `expected.size` is at most 1 MiB (Δ5 "Ignore target file"), and `bytes` holds 1 to 64 KiB. A missing folder on the way gives `error` `other-error`. The reply has no deadline form, so a check past its walk deadline gives `error` `other-error`. Only the walk finish writes, so a deadline leaves the target unchanged.
- The `fileAppend` `path` is an absolute path for both targets. For `gitignore`, the shell requires `<worktree root>/.gitignore`. For `exclude`, it requires a path inside the common directory by identity, with the components `info` and `exclude` exactly below it.
- New request `reveal {repositoryId, path}`: Δ3 `revealPath`.
- `trust` frame `confirm` version 2: `{worktreeRoot, adminDirectory, commonDirectory, gitSelectedPath, policyVersion: 2, action, details}`. `action` is one of `commit`, `read`, `fetch`, `pull`, `push`, `switch`, `branch`, `merge`, `rebase`, `resolve`, `mergetool`, `worktree`, `submodules`. `details` holds `hooks` (event and folder), `filters` (driver and scope), `monitors` (scope), `mergeDrivers` (driver and scope), `mergeTools` (tool and scope), and `signing` (key and scope), at most 20 names per kind with a `more` count. `fingerprint`, `persist`, and `bound` go.
- Until T057, `src/contracts/channel.ts` `TrustConfirmV2` holds this frame beside the version 1 `TrustRequest`, and the shell reads version 1. T057 puts it and the version 2 record in `TrustRequest`.
- The shell builds the dialog text from fixed strings and these values (plan D14). The `confirm` reply keeps `declined`, `approved` with `stored: false`, and `approved` with `stored: true` and the version 2 record.
- `confirmRun` keeps its fields. Its text changes (Δ12).
- Marker kinds add `workbench` and `applyFiles`. The `started` frame of kind `workbench` carries `action`. The close prompt names the action: "Switch", "Create branch", "Rename branch", "Delete branch", "Merge", "Rebase", "Choose ours", "Choose theirs", "Merge tool", "Add to .gitignore", "Add to info/exclude", "Add worktree", "Remove worktree", "Prune worktrees", "Save Git settings"; kind `applyFiles` is "Stage files" or "Unstage files".
- The `workbench` `action` has one value for each close prompt name: `switch`, `create-branch`, `rename-branch`, `delete-branch`, `merge`, `rebase`, `choose-ours`, `choose-theirs`, `mergetool`, `ignore-gitignore`, `ignore-exclude`, `worktree-add`, `worktree-remove`, `worktree-prune`, `config-save`. Kind `applyFiles` carries `direction` `stage` or `unstage`.
- The marker kinds are no longer the `MUTATIONS` names: a `runWorkbench` run records kind `workbench`.

## Δ7 Startup, trust, and environment (001 §7)

- Policies: 004 mutation steps use the 003 policy `integrate`. New policy `mergetool`: the `integrate` remove list, prefixes, and preserve list, `set {GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: ":"}`, no index variable.
- Trust discovery adds `merge.<driver>.driver` and `merge.<driver>.recursive`, and the merge tool keys `merge.tool`, `mergetool.<tool>.cmd`, and `mergetool.<tool>.path`. The value display list adds them.
- `approvalRequired` adds `workbench` and `mergetool` (plan D12). Each is true when any listed integration is repository-controlled by the 001 "Repository-controlled resolution" rule.
- The `readTrust` result schema changes with the trust tasks: T033 adds the `workbench` and `mergetool` flags, and T057 adds `programs`, the version 2 record, and `approveTrust {trustId, action}`.
- "Program file digests" goes. Phase 1 `fileFacts` stays for the hook listing. No phase 2 runs. The bounds `file-count`, `file-bytes`, and `total-bytes` and the session-only approval of a bound go. The 001 §5 row "Trust program file digests" goes.
- Until T057 removes trust phase 2, `src/contracts/limits.ts` keeps `TRUST_DIGEST_FILES`, `TRUST_DIGEST_FILE_BYTES`, and `TRUST_DIGEST_TOTAL_BYTES`. `trust.ts` and the fileFacts test doubles read them.
- "Protected programs that change trust" changes: a program that installs hooks during a read changes `approvalRequired`, not an approval. The next action that needs approval asks once.
- "Trust approval store": a record is data-model §10. Matching uses the identities and the selected Git path; the fingerprint compare goes. A version 1 record gives `changed`. `revoke` stays.
- Mutation trust: `runWorkbench` checks the class of its action before any process. `mergetool` uses class `mergetool`. `ignore` and `config-save` use no class, because they run no repository program. Every other action uses class `workbench`. A class flag that is true without approval gives `TRUST_REQUIRED`. State `changed` gives `TRUST_CHANGED`. `applyFiles` and line staging keep the 001 `applyHunk` and `applyFile` rule: approval only when their reads need it.
- An action that runs Git in another worktree (`worktree-remove`) checks the trust state of that worktree.
- Logs: kinds, IDs, codes, reasons, and counts only. No ref name, path, or message.

## Δ8 Freshness, cancellation, and outcome (001 §8)

- After each `runWorkbench` and `applyFiles` outcome, the renderer runs `readWorkspace`, `readRefs`, `readBranches`, and, after a 003 merge, `readTracking`. It refreshes the 002 view with `{oid}` of the selected commit and shows no refs-changed notice (002 FR-005 change, spec "Changes to earlier requirements").
- Cancel is never rollback. A canceled switch states the observed HEAD and the stash state. A canceled rebase or merge states the operation state from the markers.
- A stopped merge or rebase shows the 003 conflict notice (003 Δ8).

## Δ9 Error codes (001 §9)

| Code | Reasons | Meaning |
|---|---|---|
| `WORKBENCH_UNAVAILABLE` | `detached`, `unborn`, `current-branch`, `other-worktree`, `name-exists`, `invalid-name`, `reserved-name`, `same-branch`, `ff-only`, `dirty-tree`, `interactive`, `no-merge-tool`, `side-missing`, `side-not-regular`, `stages-missing`, `main-worktree`, `current-worktree`, `locked`, `nothing-to-prune`, `multi-value`, `limit`, `push-current-only`, `ignore-exists`, `ignore-not-text`, `ignore-not-regular`, `ignore-size`, `path`, `message-size`, `unreadable`, `no-tracking-refspec`, `several-tracking-remotes` | The action cannot run. No process starts. |
| `UNTRACKED_IN_WAY` | `untracked-in-way` | Discard would overwrite these untracked files. The result lists up to 100 paths. |
| `STASH_KEPT` | `conflicts`, `failed-apply`, `failed-checkout`, `not-found`, `stash-changed` | The switch kept the stash. The result names its commit ID and the remedy. |

- `STASH_KEPT` never ends a response. A kept stash is an observed effect, and 001 §9 gives `failed-with-effects` only `FAILED_WITH_EFFECTS`. The result carries data-model §3 `stash.state` `kept-<reason>`.
- `same-branch` (switch): the target is the current branch. `unborn` (switch): Stash and reapply or Discard changes on an unborn HEAD. `no-tracking-refspec` and `several-tracking-remotes` (switch `track`): plan D3 Track rule.

Reused: `OPERATION_IN_PROGRESS`, `CONFLICTED`, `APPROVAL_EXPIRED`, `STALE_REVIEW`, `STALE_SELECTION`, `TRUST_REQUIRED`, `TRUST_CHANGED`, `MALFORMED_GIT_OUTPUT`, `OUTPUT_LIMIT`, `GIT_FAILED`, `DEADLINE`, `CANCELED`, `COMPLETED_WITH_EFFECTS`, `FAILED_WITH_EFFECTS`, `STATE_UNKNOWN`, `UNKNOWN_TARGET`, `BUSY`, `DESTINATION_NOT_EMPTY`, `UNSUPPORTED_COMPARISON`. File action reasons add `context-only`, `several-hunks` (renderer only, Δ4), `deleted-file`, `new-file`, `eof-newline`.

No file decision gives a line refusal, so the `readComparison` `fileAction` never holds one.

## Δ10 Required contract checks (001 §10)

- Schema tests and golden vectors for every new operation, code, phase, policy, context, and private request, in Bun and Rust.
- T016 covers the request schemas. The task that implements an operation adds its result schema and the result vectors.
- Vector tests for each argv builder of `workbench-commands.ts`, each parser of `workbench-parsers.ts`, `line-patch.ts`, and `ignore-line.ts`.
- The shell allowlist holds the new commands.
- The Rust check of `src-tauri/src/schema.rs` reads each new vector of `native-first-envelope`, `mutation-request`, `progress`, and `process-request`.

## Δ11 WSL repositories (001 §11)

- New wrapper mode `mergetool` in `wsl-process.json`: `export GIT_EDITOR=:`. The 003 mode `integrate` serves the other 004 steps.
- New `wslFiles` mode `append`: `lstat` of each folder on the way, an open of the target with `O_RDONLY|O_NOFOLLOW`, a regular-file check by `fstat`, the size and SHA-256 compare, then an append with `O_WRONLY|O_APPEND|O_NOFOLLOW` and `fsync`. `absent` uses `O_CREAT|O_EXCL`.
- A link on the way or at the target gives `refused` reason `not-regular`. So does a target with an `st_nlink` other than 1. Before the write, the text checks that the write handle has the device, the inode, and the size of the compared file. POSIX has no share mode that keeps other writers out, so a writer between that check and the append can still change the file (contract gap).
- Worktree paths in `readWorktrees` are Linux paths. `openWorktree` maps them by the §11 route.
- `revealPath` takes the UNC form of the path (§11 "Paths and file access").

## Δ12 Submodules (001 §12)

- "Scope" changes: an update may cover one row and its nested rows. `reviewSubmodules` payload adds `scope?: {path}`. Without `scope`, the review covers every row, as before.
- A scoped review applies refusals, program lists, and host lines only to rows in the scope. The kept-directory walk covers only `modules/<name>` folders of rows in the scope and their nested `modules` folders. A nested row in the scope needs an initialized parent; otherwise reason `parent-not-initialized`.
- Host lines: the review result adds `hosts: [{path, fetch, settings}]` for each row whose fetch host differs from the host of its effective `submodule.<name>.url` (plan D13). The review token binds them.
- `updateSubmodules` payload adds `confirmHosts?: true`. A review with host lines needs it. Without it, the update refuses with `STALE_REVIEW` reason `hosts`, and no process starts.
- FR-048 change: the review result no longer opens a dialog. The renderer starts the update with the token right after a review without refusal and without host lines. That click counts as the explicit start.
- `confirmRun` text: main instruction "Run the programs of these submodules?". Content: "Update submodules runs <count> programs from <paths>. Run them only if you trust these submodules." With unchecked entries: "Arbareto cannot check <n> of them first." Buttons: Run and Cancel, Cancel as the default.
- The `unchecked` entries of §12 "Trust" stay. They no longer come from digest bounds. They come only from the cases that §12 names: relative values in rows that the update writes, unknown nested submodules, and kept directories without a row.
- Every other §12 rule stays: the refusals, the update protocol, the progress, the deadlines, the reconciliation, and the remedies.

## Δ13 Changes to 002 deltas

- 002 Δ8: after a 004 outcome that the user started, the view refreshes with `{oid}` and shows no refs-changed notice (Δ8).
- 002 FR-049 context menu: the branch context menu holds the plan D4 items. "Show only this branch's history" stays on the current branch.

## Δ14 Changes to 003 deltas

- 003 Δ6 policy fit: `integrate` also serves kinds `workbench` and `applyFiles` (Δ6).
- 003 D11 trust: `SYNC_EVENTS` stays for `sync`. The version 2 binding of Δ7 applies to every class, `sync` included.
- 003 D12 keys stay: Fetch Ctrl+Shift+Down, Pull Ctrl+Down, Push Ctrl+Up. They act in the window but not in an editable field.
- 003 `settings/SettingsDialog.tsx`: its pages move into the Settings view (plan O-7). The shell-only operations of 003 Δ3 stay.
- 003 Δ3 `readSyncSettings`: the result gains data-model §13 `switchChoice`, so the renderer reads it as it reads `defaultPullAction`. `setSwitchChoice` answers the same result.

## Contract gaps

- Git gives no machine-readable reason for a refused checkout, merge, rebase, stash apply, or worktree command. The outcome comes from fresh reads, and the tail shows Git's text.
- Git has no command that drops a stash by commit ID. The drop step reads the reflog position first, so a stash that another process pushes between that read and the drop can shift the position. `stash drop` then removes another entry. Git's own `stash pop` reads the position the same way.
- `update-ref -d` does not check worktrees. A worktree that checks out the branch between the review and the delete keeps a HEAD that names a deleted branch. Git's own `branch -D` has the same window between its check and its delete.
- A `[branch "<name>"]` section without keys gives no listing entry. So the delete keeps it, but Git's own `branch -D` removes it. That is a known SC-009 byte difference. `config --remove-section` exits 128 both for "no such section" and for other fatal errors, so no exit code tells them apart.
- The untracked-in-the-way check can name a path that Git allows on case-insensitive volumes (research R4).
- `check-ignore --no-index` runs without `--literal-pathspecs`. A stdin path that starts with `:` can then be read as pathspec magic. So the in-the-way check refuses such a candidate with reason `path` (plan D3). NTFS cannot hold `:`, so only the WSL test T081 checks whether Git reads it literally (research R21 F1).
- The documentation of `git mergetool` defines no exit status (spec FR-096).
- `git stash push` names no created stash in machine form. The service reads `refs/stash` and its reflog instead.
- `git merge -F -` reads a file named `-`, not standard input (builtin/merge.c `option_read_message`). Git 2.56.0.windows.2 exits 129 with "could not read file '-'" when no such file exists. So the merge message goes in the `-m` item, and `MERGE_MESSAGE_BYTES` keeps that item inside the 001 §6 command-line bound.
- A merge tool that hands the file to an earlier instance outside the operation Job keeps its window after Cancel.
- A configuration write races with another writer between the listing and `config set`. Git takes `config.lock` only for the write itself.
- The `globalConfig` context has no WSL form. A WSL Git gets `INVALID_REQUEST`.
- POSIX has no share mode that keeps other writers out. A writer between the check and the append of the `wslFiles` mode `append` can change the file.
- The shell cannot see a review token that the service invalidates before its lifetime ends (001 §5 "Approval lifetime"). The `worktreeAdd` context of that token stays until the token lifetime ends, and no run of that token starts.
- `revealPath` checks the path with its `fileFacts` walk, and `SHParseDisplayName` then reads the path again by text. A folder that changes into a link between the two can make Explorer show an entry outside the root.
- `fileAppend` for `absent` creates the file and then writes. A failed write leaves an empty file. A later check of that file gives `stale`, so no write follows without a new review.
