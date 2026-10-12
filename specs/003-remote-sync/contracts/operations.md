# Operation Contract Deltas: Remote Sync

This file lists only the changes to the feature 001 contract (`specs/001-desktop-qualification/contracts/operations.md`) and the feature 002 deltas (`specs/002-full-history/contracts/operations.md`). "001 §n" and "002 Δn" name those sections. Every rule that no delta replaces stays in force.

## Δ1 Transport (001 §1)

- New renderer operations: `readTracking`, `reviewSync`, `sync`, `clone`, `connectInTerminal`. Each has one Tauri command and one zod schema.
- New shell-only operations: `readSyncSettings`, `setSshClient`, `chooseSyncPath`, `clearSyncPath`, `launchPuttygen`. The shell answers natively and never forwards them.
- `clone` is native-first, as `chooseRepository` is (001 §3).
- Keep explicit range checks in Rust (001 §1).

## Δ2 Envelope (001 §2)

- `readTracking`, `reviewSync`, `sync`, and `connectInTerminal` carry `repositoryId`. `readTracking` and `reviewSync` carry `repositoryGeneration`.
- The repeat key of `sync` is its `syncReviewToken`, by the 001 §2 repeat rule. `MUTATIONS` gains `sync`.
- `sync` and `clone` events carry `stalled`. Their phases: `sync-fetch`, `sync-merge`, `sync-rebase`, `sync-push`, `sync-continue`, `clone`, `pageant`. Counters: `percent`, `remoteIndex`, `remoteCount`. They carry no remote name, URL, path, or Git text.

## Δ3 Public operations (001 §3)

### `readTracking`

- Payload: `{}`. One read slot. Held step and read gate, as `readRefs` (001 §7 "Held history steps").
- Command: `--no-lazy-fetch --no-optional-locks for-each-ref --format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(HEAD) refs/heads refs/remotes`.
- Record checks. One failed check gives `failed` with `MALFORMED_GIT_OUTPUT`:
  - five fields with four NUL bytes, ending with LF;
  - the refname starts with `refs/heads/` or `refs/remotes/`;
  - the OID matches the object format;
  - `upstream` is empty or starts with `refs/`;
  - the track matches `^(?:|gone|ahead [1-9][0-9]*|behind [1-9][0-9]*|ahead [1-9][0-9]*, behind [1-9][0-9]*)$`;
  - the track is not empty only for a `refs/heads/` record with an upstream;
  - `HEAD` is `*` or a space, and at most one `*`, only under `refs/heads/`.
- Bounds: `REF_LISTING_RECORDS` and 4 MiB (001 §5). The 30 s read deadline.
- Result: data-model §1.

### `reviewSync`

- Payload, one of:
  - `{action: "fetch", remote?}`, where `remote` must be in `git remote`;
  - `{action: "fetch-all"}`;
  - `{action: "pull", mode?: "rebase" | "merge"}`;
  - `{action: "integrate", mode: "rebase" | "merge"}`;
  - `{action: "push", destination?: {remote, branch, setUpstream}}`, where `branch` gives `refs/heads/<branch>` that passes `isRefName`;
  - `{action: "force-push"}`, `{action: "abort"}`, `{action: "continue"}`, `{action: "skip"}`.
- One read slot. Reads, each with `--no-lazy-fetch`, the read ones also with `--no-optional-locks`, and the 30 s deadline:
  1. the trust listing, shared or own (001 §7);
  2. the 001 HEAD capture and operation state;
  3. `remote`;
  4. for branch actions, the plan.md D4 `for-each-ref` record of `refs/heads/<branch>`;
  5. for push, `remote get-url --push --all -- <remote>`;
  6. for force-push, `rev-list --count <T> ^<HEAD>`, `rev-list --max-count=100 <T> ^<HEAD>`, and `cat-file --batch-command` subjects;
  7. for continue, the index unmerged count.
- Configuration values come from the trust listing entries by Git's last-value rule. `parseMaybeBool` (`trust.ts:65`) reads booleans.
- Refusals, before any token: `SYNC_UNAVAILABLE` with a Δ9 reason, `OPERATION_IN_PROGRESS`, `CONFLICTED` with the count, `TRUST_REQUIRED`, `TRUST_CHANGED`, or `INVALID_REQUEST` for a renderer name that fails its check.
- Result: `{action, plan, syncReviewToken}`. `plan` holds the data-model §2 fields for display: names, redacted URL, destination, mode source, lease commits.
- For `push` without a destination, `plan.needsDestination` lists the remotes, and no token goes out.

### `sync`

- Payload: `{syncReviewToken, start: true}`. Any other `start` value gives `INVALID_REQUEST`.
- Protocol:
  1. Enter the mutation exclusion and wait for the recovery marker ID, kind `sync` (001 §6).
  2. Re-read every bound value (data-model §2). A difference gives `STALE_REVIEW`, and no process starts. Consume the token only after validation.
  3. For a remote with a key file under `plink`, send `pageant` (Δ6) and wait for its reply. Phase `pageant`.
  4. For fetch, pull, and fetch-all, list all refs: `for-each-ref --format=%(refname)%00%(objectname)`. Bound: 100,000 records and 32 MiB. Above the bound, the effect state is unknown.
  5. Run the steps of the action (below).
  6. Honor Cancel at any time. Cancel closes the Job. No later step starts.
  7. Reconcile: the refs listing again, HEAD, the index, markers, the unmerged count, and for push the upstream values. WSL waits for the 001 §12 process-end fact first.
- Steps. Every argument array starts with `--no-lazy-fetch`. Network limits from 001 §12. Policy in brackets.
  - fetch: `fetch --porcelain --progress --no-recurse-submodules -- <remote>` [`remote`].
  - fetch-all: the same, once per remote, in `git remote` order, without `skipFetchAll` remotes (O-4). A failed remote does not stop the next.
  - push and force-push: `push --porcelain --progress --no-recurse-submodules --no-follow-tags [--set-upstream] [--force-with-lease=<dst>:<expect>] -- <remote> refs/heads/<branch>:<dst>` [`remote`].
  - pull: the fetch step, the upstream OID from the step 4 listing, then `--no-optional-locks rev-list --left-right --count <HEAD>...<U>` with the 30 s deadline, the data-model §6 decision, then integrate.
  - integrate: the count and the decision without a fetch.
    - fast-forward: `merge --ff-only --no-autostash <upstream ref>` [`integrate`];
    - merge: `merge --no-edit --no-autostash [--ff | --no-ff] <upstream ref>` [`integrate`];
    - rebase: `rebase --no-autostash --fork-point [--rebase-merges] <upstream ref>` [`integrate`].
  - abort: `merge --abort` or `rebase --abort` [`integrate`].
  - continue: `commit --quiet` (merging) or `rebase --continue` (rebasing) [`integrate`].
  - skip: `rebase --skip` [`integrate`].
- Fetch line grammar: `^([ +\-t*!=]) ([0-9a-f]+) ([0-9a-f]+) (\S+)$`, with OIDs of the object format. A line that breaks it makes the fetch list `MALFORMED_GIT_OUTPUT`. The observed listing still decides the effects.
- Push lines: `To <text>`, `<flag>\t<from>:<to>\t<summary>[ (<reason>)]`, and `Done`.
  - Exactly one status line must have `from:to` equal to the refspec. Its flag and summary give data-model §5 `status`. `[rejected]`, `[remote rejected]`, and `[remote failure]` are the only `!` summaries that decide.
  - Another or a missing line, with a non-zero exit, gives status `none`.
- Results and states: data-model §4 to §8. `PUSH_REJECTED` reasons: `rejected`, `stale-lease` (a lease was sent), `remote-rejected`, `remote-failure`.
- Remedies (001 §4 quoting):
  - fetch: `& '<git>' --no-lazy-fetch -C '<worktree>' fetch -- '<remote>'`;
  - push: `& '<git>' --no-lazy-fetch -C '<worktree>' push -- '<remote>' 'refs/heads/<branch>:<dst>'`, with `--force-with-lease='<dst>:<expect>'` for force-push.
  - Text: "This command runs the step in a terminal, where Git and SSH can ask for input. Then use the action again."
- A failed `sync` under `plink` keeps a connect target (data-model §11).

### `applyFile` (001 §3, §4)

- `direction` adds `resolve`. Only a `readComparison` decision `resolve` accepts it. Δ4 has the steps.

### `clone`

- Renderer payload: `{url, destination, keyFile: "none" | "picked"}`. `url`: 1 to 4,096 UTF-8 bytes, no control character. `destination`: a `ChannelPath`.
- Native step:
  - The shell checks the path text by the 001 Windows rules or the §11 WSL route. It binds a `clone` context and a `repositoryDiscovery` context for the path.
  - With `keyFile: "picked"`, the shell shows the `.ppk` picker. A canceled picker ends `canceled`.
  - The shell forwards `{url, bootstrapId, cloneId}`.
- Service:
  1. `destinationFacts` (Δ6). Not `absent` and not `empty` gives `DESTINATION_NOT_EMPTY` with the path, and no Git process starts.
  2. Under `plink`, `pageant` with the picked key.
  3. `--no-lazy-fetch clone --progress --no-recurse-submodules -- <url> <destination>` [`remote`], network limits, phase `clone`.
  4. Exit 0: 001 discovery and registration through the bound context. The top level must equal the destination. The result is the `chooseRepository` result.
  5. Otherwise: `destinationFacts` again. The result holds `{exists, empty}`, the redacted `outputTail`, and the remedy `& '<git>' clone -- '<url>' '<destination>'`, or text only when the URL holds user information.
- Shell finish: store the recent entry and `lastCloneParent`.

### `connectInTerminal`

- Payload: `{operationId}` of a failed `sync` or `clone` with a retained connect target. Otherwise `UNKNOWN_TARGET`.
- The service sends `terminal` (Δ6). Result: `succeeded` when the console starts. Otherwise `failed` with `PUTTY_UNAVAILABLE`.

### Shell-only settings operations

- `readSyncSettings {}`: data-model §10 with the resolved program paths and the presence of each program. Also the GE initial key value for a remote when the service reported it (O-8).
- `setSshClient {kind: "git" | "plink"}`.
- `chooseSyncPath {target: "plink" | "remoteKey" | "cloneFolder", worktreeKey?, remote?}`: native picker. For `plink`, the shell reads the Pageant file version. Below 0.75, it gives `PUTTY_UNAVAILABLE` reason `version`.
- `clearSyncPath {target, worktreeKey?, remote?}`.
- `launchPuttygen {}`: starts `puttygen.exe` from the plink folder outside every Job. Missing gives `PUTTY_UNAVAILABLE`.

## Δ4 File staging (001 §4)

- New table row: `resolve` accepts a Conflicted entry by data-model §9. Git sets one stage-0 entry from the working file, as `git add` does, and stages 1 to 3 of the path leave.
- New refusal reason `missing`: a conflicted path without a working file.
- Acceptance: the bound `operationState` must equal the observed one. The 001 `CONFLICTED` and `OPERATION_IN_PROGRESS` acceptance refusals do not apply to `resolve`.
- Step 5: `update-index --add --remove -z --stdin` on the candidate, with the path bytes.
- Step 6: the path has exactly one stage-0 entry with the P0.2 mode and no stage 1 to 3. The blob proof runs. Every other entry keeps its values, also other unmerged stages.
- Step 7: the index fingerprint, the stage set of the path, and the working digest must equal the binding. Otherwise `STALE_SELECTION`.
- No step reads conflict markers or any file text for a decision.

## Δ5 Finite bounds (001 §5)

| Limit | Value |
|---|---|
| Listed fetch updates (`SYNC_FETCH_LISTED_REFS`) | 1,000 per remote. Counts by flag cover all lines. |
| Remotes (`SYNC_REMOTES`) | 256 lines of `git remote`. Above gives `OUTPUT_LIMIT` reason `SYNC_REMOTES`. |
| Push URLs per remote | 1 (O-11). |
| Lease subjects (`SYNC_LEASE_COMMITS`) | 100. The count is exact. |
| Count display (`TRACKING_COUNT_DISPLAY`) | 10,000. Above shows "10000+". |
| Sync refs listing | 100,000 records and 32 MiB. |
| Sync and clone process limits | 001 §12: inactivity 300 s, ceiling 4 h, stall 15 s. |
| Review reads, count, refs listings | 30 s. |
| Pageant readiness | 30 s. |
| Clone URL | 4,096 UTF-8 bytes. |
| Key file entries | 256 in shell settings. |
| Diagnostic output | 4 MiB per process, as 001 §12. |
| Output tail | 16 KiB and 100 lines, as 001 §9, with the §12 CR rule. |
| Sync review token lifetime | 60 s (001 approval lifetime). |

## Δ6 Private native process requests (001 §6)

- Policies `remote` and `integrate` take `NetworkLimits` (inactivity and ceiling). The `run_limits` rule extends from `network` to these two. The `registeredOperation` policy fit adds them.
- `remote` runs on Windows contexts get `GIT_SSH_COMMAND` and `GIT_SSH_VARIANT=plink` from the shell settings when `sshClient` is `plink`. The command is the plink path in POSIX single quotes, U+0027 written as `'\''`, then ` -batch`. No other policy and no WSL run gets them.
- New context `clone`: cwd is the application-owned launch folder, or `/` in WSL. The argument array must be the fixed clone array, with the bound destination as the last item.
- New request `destinationFacts {cloneId}`. Reply: `absent`, `empty`, `not-empty`, `file`, `other`, or `error {code}`. A link or a junction gives `other`. WSL uses `wslFiles` mode `destination` (Δ11).
- New request `pageant {repositoryId, remote}` or `{cloneId}`. Reply: `none` (no key), `ready`, or `failed {reason, program, path}`. The shell starts `pageant.exe --encrypted <key>` outside every Job. It waits until the process exits or `WaitForInputIdle` returns 0, up to 30 s.
- New request `terminal {target}`.
  - The shell starts Windows PowerShell 5.1 from the system folder with `CREATE_NEW_CONSOLE`, `-NoProfile -NoExit`, and a constant script.
  - Values pass in `ARBARETO_GIT`, `ARBARETO_DIR`, and `ARBARETO_TARGET`, plus `GIT_SSH_COMMAND='<plink>'` without `-batch` and `GIT_SSH_VARIANT=plink`.
  - Script: `if ($env:ARBARETO_DIR) { & $env:ARBARETO_GIT --no-lazy-fetch -C $env:ARBARETO_DIR ls-remote --heads -- $env:ARBARETO_TARGET } else { & $env:ARBARETO_GIT --no-lazy-fetch ls-remote --heads -- $env:ARBARETO_TARGET }`.
- Marker kinds add `sync` (`settings.rs:759`). The close prompt covers running `sync` and `clone` (`close.rs`).

## Δ7 Startup, trust, and environment (001 §7)

- New policy `remote`: the `network` remove list and prefixes, `set {GIT_TERMINAL_PROMPT: "0"}`, no index variable, the same preserve list. `GIT_PROTOCOL_FROM_USER` stays as the service environment holds it.
- New policy `integrate`: the same, with `set {GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: ":"}`.
- The rule "No policy sets or removes `GIT_SSH_COMMAND`" gets one exception: the shell adds the PuTTY pair to `remote` runs under `plink` (Δ6).
- Mutation trust adds `approvalRequired.sync` (plan.md D11). `sync` refuses with `TRUST_REQUIRED` or `TRUST_CHANGED` before any process.
- The value display allowlist adds `core.sshCommand`, `core.gitProxy`, `core.askPass`, `credential.helper`, `credential.<url>.helper`, `remote.<name>.uploadpack`, and `remote.<name>.receivepack`, redacted.
- Logs: no URL, remote name, ref name, or output tail. Only kinds, IDs, codes, reasons, and counts.

## Δ8 Freshness, cancellation, and outcome (001 §8)

- `sync` outcomes follow data-model §8. Cancel is never rollback. A canceled push says: "The remote can hold this push. Fetch to see the remote state."
- After each `sync` outcome, the renderer runs `readWorkspace`, `readRefs`, and `readTracking`. After a fetch outcome, it refreshes the 002 view with `{oid}` and shows no refs-changed notice (FR-013).
- A `sync` outcome that moved a gitlink shows the 001 submodule notice through `readWorkspace`.
- Recovery after a crash re-reads HEAD, the index, and the markers. The outcome stays unknown, with no attribution.

## Δ9 Error codes (001 §9)

| Code | Reasons | Meaning |
|---|---|---|
| `SYNC_UNAVAILABLE` | `detached`, `unborn`, `no-upstream`, `remote-missing`, `no-remotes`, `local-upstream`, `several-merge-refs`, `push-urls`, `mirror`, `push-remote-differs`, `invalid-config`, `no-lease`, `ff-only`, `interactive-rebase`, `upstream-gone`, `no-operation`, `not-rebasing` | The action cannot run. No process starts, or none after the fetch. |
| `PUSH_REJECTED` | `rejected`, `stale-lease`, `remote-rejected`, `remote-failure` | The porcelain status of the pushed ref. |
| `PUTTY_UNAVAILABLE` | `missing`, `unreadable`, `version`, `not-ready` | With `program` and `path`. |
| `DESTINATION_NOT_EMPTY` | `not-empty`, `file`, `other` | With the destination path. No Git process starts. |

Reused: `OPERATION_IN_PROGRESS`, `CONFLICTED`, `STALE_REVIEW`, `STALE_SELECTION`, `TRUST_REQUIRED`, `TRUST_CHANGED`, `MALFORMED_GIT_OUTPUT`, `OUTPUT_LIMIT`, `GIT_FAILED`, `DEADLINE`, `CANCELED`, `COMPLETED_WITH_EFFECTS`, `FAILED_WITH_EFFECTS`, `STATE_UNKNOWN`, `UNKNOWN_TARGET`, `BUSY`. File action reason adds `missing`.

## Δ10 Required contract checks (001 §10)

- Schema tests and golden vectors for every new operation, code, phase, policy, wrapper mode, and private request, in Bun and Rust.
- The shell allowlist holds the new commands.
- Vector tests for each argv builder of `sync-commands.ts`.

## Δ11 WSL repositories (001 §11)

- New wrapper modes in `wsl-process.json`: `remote` (no export) and `integrate` (`export GIT_EDITOR=:`).
- New `wslFiles` mode `destination`: `lstat`, then one `readdir` entry check.
- PuTTY never applies. The settings say that the distro's SSH setup applies.
- Clone into a WSL path uses the §11 route, distro start, and Git-per-distro approval first.

## Δ12 Submodules (001 §12)

- No `sync` or `clone` step starts Git inside a submodule. Fetch and push pass `--no-recurse-submodules`. Clone passes `--no-recurse-submodules`. `merge` and `rebase` do not honor `submodule.recurse` (P0.2 h).
- Update submodules stays the only submodule network action.

## Contract gaps

- Git gives no machine-readable reason for an SSH failure, a credential failure, or a host-key failure. The outcome says the cause is unknown and shows the tail.
- Git gives no machine-readable "mode required" for pull. The app decides from the counts and the configuration itself.
- Git gives no signal that a process used SSH. So Connect in a terminal shows for every failed network operation under `plink` (O-10).
- Under `simple`, `%(push)` and Git's own push differ for a triangular workflow. The app shows the FR-016 panel there.
- A push URL from `remote get-url --push` already has `pushInsteadOf` applied. `ls-remote` in the terminal applies `insteadOf` to it again.
- A remote result after a canceled push is not observable without a fetch.
- A local-path remote runs the remote repository's own receive hooks on this machine, as Git does by hand.
