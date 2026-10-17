# Operation Contract Deltas: Remote Sync

This file lists only the changes to the feature 001 contract (`specs/001-desktop-qualification/contracts/operations.md`) and the feature 002 deltas (`specs/002-full-history/contracts/operations.md`). "001 §n" and "002 Δn" name those sections. Every rule that no delta replaces stays in force.

## Δ1 Transport (001 §1)

- New renderer operations: `readTracking`, `reviewSync`, `sync`, `clone`, `connectInTerminal`. Each has one Tauri command and one zod schema.
- New shell-only operations: `readSyncSettings`, `setSshClient`, `setDefaultPullAction`, `chooseSyncPath`, `clearSyncPath`, `launchPuttygen`. The shell answers natively and never forwards them.
- `clone` is native-first, as `chooseRepository` is (001 §3).
- Keep explicit range checks in Rust (001 §1).

## Δ2 Envelope (001 §2)

- `readTracking`, `reviewSync`, and `sync` carry `repositoryId`. `readTracking` and `reviewSync` carry `repositoryGeneration`.
- `connectInTerminal` carries `repositoryId` for the target of a failed `sync`, and no `repositoryId` for the target of a failed `clone` (data-model §11).
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
  6. for force-push, `rev-list --count <T> ^<HEAD>`, `rev-list --max-count=100 <T> ^<HEAD>`, and `cat-file --batch-command` subjects. A commit object above `HISTORY_COMMIT_OBJECT_BYTES` gives `subject` null;
  7. for continue, the index unmerged count;
  8. for skip, `show-ref --exists REBASE_HEAD`, then `show-ref --verify REBASE_HEAD`, then the subject of that commit with the read 6 `cat-file --batch-command -Z` reader. Status 2 of the first read gives reason `no-skip-commit`. The second read must print one line: an object ID of the object format, a space, `REBASE_HEAD`, and LF. Other output gives `MALFORMED_GIT_OUTPUT`. A commit object above `HISTORY_COMMIT_OBJECT_BYTES` gives `subject` null.
- Configuration values come from the trust listing entries by Git's last-value rule. `parseMaybeBool` (`trust.ts:65`) reads booleans.
- Every action refuses with `SYNC_UNAVAILABLE` reason `invalid-config` when any `remote.<name>.mirror`, `remote.<name>.skipFetchAll`, `remote.<name>.skipDefaultUpdate`, `remote.<name>.prune`, or `remote.<name>.pruneTags` entry holds a value that `parseMaybeBool` rejects. It also refuses when the listing gives no value for an entry of these keys: `branch.<name>.remote`, `branch.<name>.pushRemote`, `branch.<name>.merge`, `url.<base>.insteadOf`, `url.<base>.pushInsteadOf`, `remote.pushDefault`, and `remote.<name>.url`, `pushurl`, `push`, `fetch`, `receivepack`, `uploadpack`, `tagOpt`, `proxy`, `proxyAuthMethod`, `vcs`, `serverOption`, `negotiationRestrict`, `negotiationInclude`, or `followRemoteHEAD`. A remote name that starts with `/` is skipped, as Git skips it. The check uses read 1 and runs before read 3. Git reads these keys in remote.c `handle_config` for every entry, so `git remote`, `fetch`, `push`, and every `%(upstream)` or `%(push)` read stop on such a value (research R16 m).
- For push, more than one `branch.<branch>.merge` entry gives reason `several-merge-refs` under `simple` or unset when the push remote equals the fetch remote, and under `upstream` or `tracking` (plan.md D4 step 4). Git's push stops there with exit 128.
- Refusals, before any token: `SYNC_UNAVAILABLE` with a Δ9 reason, `OPERATION_IN_PROGRESS` (never for `fetch` and `fetch-all`, which stay allowed during a merge or a rebase in progress; `pull`, `integrate`, `push`, and `force-push` refuse with it), `CONFLICTED` with the count, `TRUST_REQUIRED`, `TRUST_CHANGED`, or `INVALID_REQUEST` for a renderer name that fails its check.
- Result: `{action, plan, syncReviewToken}`. `plan` holds the data-model §2 fields for display: `remotes`, `upstream`, `destination` with the redacted URL, `lease` with its `commits`, the payload `mode`, `operationState` (`merging` or `rebasing`), and `skippedCommit`.
- For `push` without a destination, `plan.needsDestination` lists the remotes, and no token goes out.

### `sync`

- Payload: `{syncReviewToken, start: true}`. Any other `start` value gives `INVALID_REQUEST`.
- Protocol:
  1. Enter the mutation exclusion and wait for the recovery marker ID, kind `sync` (001 §6).
  2. Re-read every bound value (data-model §2). A difference gives `STALE_REVIEW`, and no process starts. Consume the token only after validation.
  3. On a Windows Git, send `pageant` (Δ6) before the first `remote` run of each remote, and wait for its reply. Phase `pageant`. Fetch-all sends it before each remote. `failed` ends the action with `PUTTY_UNAVAILABLE`, and no later Git process starts. A WSL Git sends no `pageant`.
  4. For fetch, pull, and fetch-all, list all refs: `for-each-ref --format=%(refname)%00%(objectname)`. Bound: 100,000 records and 32 MiB. Above the bound, the effect state is unknown.
  5. Run the steps of the action (below).
  6. Honor Cancel at any time. Cancel closes the Job. No later step starts.
  7. Reconcile: the refs listing again, HEAD, the index, markers, the unmerged count, and for push the upstream values. WSL waits for the 001 §12 process-end fact first.
- Steps. Every argument array starts with `--no-lazy-fetch`. Network limits from 001 §12. Policy in brackets.
  - fetch: `fetch --porcelain --progress --no-recurse-submodules -- <remote>` [`remote`].
  - fetch-all: the same, once per remote, in `git remote` order, without the skipped remotes (O-4). A remote is skipped when the last value of `remote.<name>.skipFetchAll` and `remote.<name>.skipDefaultUpdate`, taken over both names, is true. A failed remote does not stop the next.
  - push and force-push: `push --porcelain --progress --no-recurse-submodules --no-follow-tags [--force-with-lease=<dst>:<expect>] -- <remote> refs/heads/<branch>:<dst>` [`remote`]. `<remote>` and `<dst>` come from the plan.md D4 rule or the panel. A triangular destination is `refs/heads/<branch>` on the push remote, as Git's own push selects it. `matching` always needs the panel. A mirror remote and a remote with several push URLs are refused on purpose, although Git pushes to them (research R16 d).
  - Set upstream: the push argv never has `--set-upstream`. Git then prints a localized line between the status lines and `Done` (branch.c `install_branch_config_multiple_remotes`).
    - After a push with a success status, a selected Set upstream runs `config --local -- branch.<branch>.remote <remote>`, then `config --local -- branch.<branch>.merge <dst>` [`remote`]. These are the values that transport.c `set_upstreams` writes for `push --set-upstream`.
    - `branch --set-upstream-to` is not used. It needs the remote-tracking ref, and a push updates that ref only when a fetch refspec maps `<dst>`.
    - Only exit 0 of each write means set (git-config(1)). Another exit, a runner refusal, or a Cancel before a write gives `upstreamNotSet` true and starts no later write.
    - `upstreamNotSet` does not change the push outcome. A succeeded push stays `succeeded`, and the result holds the Set upstream remedy.
  - pull: the fetch step, then a `for-each-ref --format=%(refname)%00%(objectname)` listing after the fetch process ends; U is the upstream OID from that listing. Then `--no-optional-locks rev-list --left-right --count <HEAD>...<U>` with the 30 s deadline, the data-model §6 decision, then integrate.
  - integrate: the count and the decision without a fetch.
    - fast-forward: `merge --ff-only --no-autostash <upstream ref>` [`integrate`];
    - merge: `merge --no-edit --no-autostash [--ff | --no-ff] <upstream ref>` [`integrate`];
    - rebase: `rebase --no-autostash --fork-point [--rebase-merges] <upstream ref>` [`integrate`].
  - abort: `merge --abort` or `rebase --abort` [`integrate`].
  - continue: `commit --quiet` (merging) or `rebase --continue` (rebasing) [`integrate`].
  - skip: `rebase --skip` [`integrate`].
- Fetch line grammar: `^([ +\-t*!=]) ([0-9a-f]+) ([0-9a-f]+) (\S+)$`, with OIDs of the object format. A line that breaks it makes the fetch list `MALFORMED_GIT_OUTPUT`. The observed listing still decides the effects.
- Push lines: `To <text>`, `<flag>\t<from>:<to>\t<summary>[ (<reason>)]`, and `Done`. `from` and `to` are full ref names. Git prints `Done` also after a rejected push, so `Done` decides nothing (research R16 b).
  - Exactly one status line must have `from:to` equal to the refspec. Its flag and summary give data-model §5 `status`. `[rejected]`, `[remote rejected]`, and `[remote failure]` are the only `!` summaries that decide.
  - Another or a missing line, with a non-zero exit, gives status `none`.
- Results and states: data-model §4 to §8. `PUSH_REJECTED` reasons: `rejected`, `stale-lease` (a lease was sent), `remote-rejected`, `remote-failure`. A `pull` or `integrate` result that reached a decision holds `modeSource` (data-model §6).
- Remedies (001 §4 quoting):
  - fetch: `& '<git>' --no-lazy-fetch -C '<worktree>' fetch -- '<remote>'`;
  - push: `& '<git>' --no-lazy-fetch -C '<worktree>' push -- '<remote>' 'refs/heads/<branch>:<dst>'`, with `--force-with-lease='<dst>:<expect>'` for force-push.
  - Set upstream: `& '<git>' --no-lazy-fetch -C '<worktree>' config --local -- 'branch.<branch>.remote' '<remote>'; & '<git>' --no-lazy-fetch -C '<worktree>' config --local -- 'branch.<branch>.merge' '<dst>'`. Text: "The push succeeded, but Arbareto could not set the upstream. This command sets it."
  - pull: the fetch remedy for the fetch step, and the integrate argv for the integrate step.
  - Text: "This command runs the step in a terminal, where Git and SSH can ask for input. Then use the action again."
- An expired `syncReviewToken` gives `APPROVAL_EXPIRED` (001).
- A failed `sync` keeps a connect target only when its `pageant` reply was not `git` (data-model §11).

### `applyFile` (001 §3, §4)

- `direction` adds `resolve`. Only a `readComparison` decision `resolve` accepts it. Δ4 has the steps.

### `clone`

- Renderer payload: `{url, destination, keyFile: "none" | "picked"}`. `url`: 1 to 4,096 UTF-8 bytes, no control character. `destination`: a `ChannelPath`.
- Native step:
  - The shell checks the path text by the 001 Windows rules or the §11 WSL route.
  - With `keyFile: "picked"`, the shell shows the `.ppk` picker. A canceled picker ends `canceled`.
  - The shell binds one `clone` context and one `repositoryDiscovery` context for the path (Δ6).
  - The shell forwards `{url, bootstrapId, cloneId}`. The service payload holds no path, as for `chooseRepository` (001 §3).
- Service:
  1. `wslDistros {bootstrapId}` (001 §6). The reply `path` is the destination. A WSL path then takes the §11 distro start and the Git-per-distro approval, as `chooseRepository` does. The Git argument is the reply path, or for a WSL path its §11 Linux path.
  2. `destinationFacts {cloneId}` (Δ6). `not-empty`, `file`, or `other` gives `DESTINATION_NOT_EMPTY` with the reply path, and no Git process starts.
     - An `error` reply gives `REPOSITORY_UNAVAILABLE` with the reply path and a text that names the error code, as the 001 §12 folder read does. No Git process starts.
  3. `pageant {cloneId}` on a Windows Git (Δ6).
  4. `--no-lazy-fetch clone --progress --no-recurse-submodules -- <url> <Git argument>` [`remote`], network limits, phase `clone`.
  5. Exit 0: the 001 `chooseRepository` registration flow with the same `bootstrapId`, from `wslDistros` on. The top level must equal the destination. The result is the `chooseRepository` result.
     - The identity request of the registration also names the destination, for a WSL path in its 001 §11 identity form. A top level with another identity gives `REPOSITORY_UNAVAILABLE`, and nothing registers.
     - A refused registration after exit 0 gives its own code with the step 6 result, not the `chooseRepository` refusal result (FR-051).
  6. Otherwise: `destinationFacts` again. The result holds `{exists, empty}`, the redacted `outputTail`, and the remedy `& '<git>' clone -- '<url>' '<destination>'`, or text only when the URL holds user information or the Git is a WSL Git.
     - A second reply `error`, or a failed request, gives the code of the step without `{exists, empty}`.
     - A WSL clone process without an exit status gives the code only, because no process-end fact exists without a registered workspace (plan.md "Open items").
- Shell finish: store the recent entry and `lastCloneParent`.

### `connectInTerminal`

- Payload: `{operationId}` of a failed `sync` or `clone` with a retained connect target. A `sync` target needs the `repositoryId` of its workspace. A `clone` target needs no `repositoryId`. Any other combination gives `UNKNOWN_TARGET`.
- Before `terminal`, the service checks `approvalRequired.sync` and the trust fingerprint. A difference gives `TRUST_REQUIRED` or `TRUST_CHANGED`, and no console starts. A clone target has no repository and needs no trust check.
- The service sends `terminal` (Δ6). Result: `succeeded` when the console starts. A `failed` reply gives `failed` with `PUTTY_UNAVAILABLE` and the program and the path.
- The trust check reads a fresh trust listing, so a trust refusal ends `failed`. A `refused` reply ends `failed` with its own code.

### Shell-only settings operations

- `readSyncSettings {}`: data-model §10 with `programs`. The result holds no repository value. `readTrust` shows a repository `remote.<name>.puttykeyfile` value, and the settings show it only as a proposal (Δ7). The app uses no key file before the user saves it (O-8).
- `setSshClient {kind: "git" | "plink"}`.
- `setDefaultPullAction {action: "pull" | "pull-merge" | "pull-rebase" | "fetch" | "fetch-all"}`: stores data-model §10 `defaultPullAction` in the shell settings. It writes no Git configuration (FR-056).
- `chooseSyncPath {target: "plink" | "remoteKey" | "cloneFolder", worktreeKey?, remote?}`: native picker. For `plink`, the shell reads the Pageant file version. Below 0.75, it gives `PUTTY_UNAVAILABLE` reason `version`.
- `clearSyncPath {target, worktreeKey?, remote?}`.
- `launchPuttygen {}`: starts `puttygen.exe` from the plink folder outside every Job. Missing gives `PUTTY_UNAVAILABLE`.

## Δ4 File staging (001 §4)

- New table row: `resolve` accepts a Conflicted entry by data-model §9. The app writes one stage-0 entry from the working file with the `git add` mode, and stages 1 to 3 of the path leave.
- New refusal reason `missing`: a conflicted path without a working file.
- Acceptance: the bound `operationState` must equal the observed one. The 001 `CONFLICTED` and `OPERATION_IN_PROGRESS` acceptance refusals do not apply to `resolve`.
- Step 5:
  - `--no-lazy-fetch hash-object -w -- <path>` on the working file. Git applies the conversion of the path attributes. A `filter` path is refused before this step, so no filter driver runs.
  - `--no-lazy-fetch update-index -z --index-info` on the candidate, with `<mW> SP <oid> TAB <path>` and NUL. `mW` is the bound working mode of the status `u` record. The stage-0 entry replaces stages 1 to 3 of the path.
  - `update-index --add` is not used for `resolve`. On Windows with `core.symlinks=false` and `core.filemode=false`, it writes `100644` where `git add` keeps `120000` or `100755` (research R16 i).
- Step 6: the path has exactly one stage-0 entry with mode `mW` and no stage 1 to 3. The blob proof runs. Every other entry keeps its values, also other unmerged stages. P0.2 (i2) verifies the equality with `git add`.
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
- The shell records the `started` kind of each operation. A `remote` or `integrate` run needs an operation that started as kind `sync`. Any other operation gives `INVALID_REQUEST`.
- `remote` runs on Windows contexts get `GIT_SSH_COMMAND` and `GIT_SSH_VARIANT=plink` from the shell settings when `sshClient` is `plink`. The command is the plink path in POSIX single quotes, U+0027 written as `'\''`, then ` -batch`. No other policy and no WSL run gets them.
- New context `clone`: cwd is the application-owned launch folder, or `/` in WSL. The argument array must be the fixed clone array. Its last item must equal the bound destination in Git's form: the checked Windows path, or the §11 Linux path of a WSL path.
- The clone operation owns its `clone` and `repositoryDiscovery` contexts from its first request. An owned context of a clone stays valid until the operation ends. The 001 context lifetime of 60 s applies only before the first request.
- The `repositoryDiscovery` context of a clone binds the destination identity only after the clone process exits with status 0. Before that, a `wslProbe` of that context binds no identity, and an `identity` request or a discovery `run` gives `UNKNOWN_TARGET`. The destination can be absent at the native step.
- New request `destinationFacts {cloneId}`. It carries no path. The shell reads the bound destination: OS facts on Windows, and the `wslFiles` script mode `destination` with the §11 Linux path in WSL. No `wslFiles` frame of the service takes mode `destination`. Reply: `absent`, `empty`, `not-empty`, `file`, `other`, or `error {code}`. A link or a junction gives `other`.
- New request `pageant {repositoryId, remote}` or `{cloneId}`, for a Windows Git only. A WSL target gives `refused` with `INVALID_REQUEST`. Reply: `git` (`sshClient` is `git`), `none` (`plink` and no key file), `ready`, or `failed {reason, program, path}`. Under `plink`, a missing `plink.exe` gives `failed {reason: "missing", program: "plink", path}`. The shell starts `pageant.exe --encrypted <key>` outside every Job. Reply `ready` only when the process exits with status 0, or `WaitForInputIdle` returns 0 while the process still runs. Any other exit status gives `failed {reason: "exit", program, path}`. 30 s without either gives `failed {reason: "not-ready"}`. If P0.3 shows no defined exit status, record the contract gap and refuse.
- New request `terminal {gitInstallationId, repositoryId?, target}`. `repositoryId` is present for a `sync` target and absent for a `clone` target. The shell takes the Git path from `gitInstallationId` and the worktree root from `repositoryId`, from its own registrations. The service sends no path. An unregistered pair or a WSL Git gives `refused` with `UNKNOWN_TARGET`. `target` is the remote name, the push URL, or the clone URL (plan.md D9).
  - The shell starts Windows PowerShell 5.1 from the system folder with `CREATE_NEW_CONSOLE`, `-NoProfile -NoExit`, and a constant script.
  - Values pass in `ARBARETO_GIT`, `ARBARETO_DIR`, and `ARBARETO_TARGET`, plus `GIT_SSH_COMMAND='<plink>'` without `-batch` and `GIT_SSH_VARIANT=plink`. Without `repositoryId`, `ARBARETO_DIR` is empty.
  - Script: `if ($env:ARBARETO_DIR) { & $env:ARBARETO_GIT --no-lazy-fetch -C $env:ARBARETO_DIR ls-remote --heads -- $env:ARBARETO_TARGET } else { & $env:ARBARETO_GIT --no-lazy-fetch ls-remote --heads -- $env:ARBARETO_TARGET }`.
- Marker kinds add `sync` (`settings.rs:759`). The close prompt covers running `sync` and `clone` (`close.rs`).
- The `started` frame of kind `sync` carries `action`, one of the nine `reviewSync` actions. No other kind carries `action`. Direction `resolve` goes only with kind `applyFile`.

## Δ7 Startup, trust, and environment (001 §7)

- New policy `remote`: the `network` remove list and prefixes, `set {GIT_TERMINAL_PROMPT: "0"}`, no index variable, the same preserve list. `GIT_PROTOCOL_FROM_USER` stays as the service environment holds it.
- New policy `integrate`: the same, with `set {GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: ":"}`.
- 001 §6 "Process fields" (L581) and §12 "Environment and console" (L1880) get one exception: the shell adds the PuTTY pair to `remote` runs under `plink` (Δ6).
- Mutation trust adds `approvalRequired.sync` (plan.md D11). The class also counts a repository-controlled `merge.<driver>.driver`, because a pull merge runs it. The `readTrust` result carries `approvalRequired.sync` next to `reads` and `commit`. `sync` refuses with `TRUST_REQUIRED` or `TRUST_CHANGED` before any process.
- The value display allowlist adds `core.sshCommand`, `core.gitProxy`, `core.askPass`, `credential.helper`, `credential.<url>.helper`, `remote.<name>.uploadpack`, `remote.<name>.receivepack`, and `remote.<name>.puttykeyfile`, redacted.
- Transport value redaction. Arguments and snippets can hold a secret, so `readTrust` shows only the program. The trust decision does not change.
  - `core.sshCommand`, `credential.helper`, `credential.<url>.helper`, `remote.<name>.uploadpack`, and `remote.<name>.receivepack` show the first shell word after quote removal (`shellProgram`, `trust.ts`). Git runs these values with the shell.
  - A `credential` value that starts with `!` shows `<shell command>`. A value whose first word the service cannot name also shows `<shell command>`. An empty value shows empty.
  - `core.gitProxy` shows the command before ` for ` (connect.c `git_proxy_command_options`). Git runs that command without the shell and without configured arguments.
  - `core.askPass` and `remote.<name>.puttykeyfile` show the whole value. Git runs `core.askPass` without the shell (prompt.c `do_askpass`).
  - Then the 001 §7 URL user information rule applies to the shown text.
- Logs: no URL, remote name, ref name, or output tail. Only kinds, IDs, codes, reasons, and counts.

## Δ8 Freshness, cancellation, and outcome (001 §8)

- `sync` outcomes follow data-model §8. Cancel is never rollback. A canceled push says: "The remote can hold this push. Fetch to see the remote state."
- After each `sync` outcome, the renderer runs `readWorkspace`, `readRefs`, and `readTracking`. After a fetch outcome, it refreshes the 002 view with `{oid}` and shows no refs-changed notice (FR-013).
- A `sync` outcome that moved a gitlink shows the 001 submodule notice through `readWorkspace`.
- Recovery after a crash re-reads HEAD, the index, and the markers. The outcome stays unknown, with no attribution.

## Δ9 Error codes (001 §9)

| Code | Reasons | Meaning |
|---|---|---|
| `SYNC_UNAVAILABLE` | `detached`, `unborn`, `no-upstream`, `remote-missing`, `no-remotes`, `local-upstream`, `several-merge-refs`, `push-urls`, `mirror`, `push-remote-differs`, `invalid-config`, `no-lease`, `ff-only`, `interactive-rebase`, `upstream-gone`, `no-operation`, `not-rebasing`, `no-skip-commit` | The action cannot run. No process starts, or none after the fetch. |
| `PUSH_REJECTED` | `rejected`, `stale-lease`, `remote-rejected`, `remote-failure` | The porcelain status of the pushed ref. |
| `PUTTY_UNAVAILABLE` | `missing`, `unreadable`, `version`, `exit`, `not-ready` | With `program` and `path`. |
| `DESTINATION_NOT_EMPTY` | `not-empty`, `file`, `other` | With the destination path. No Git process starts. |

Reused: `REPOSITORY_UNAVAILABLE` (`clone` steps 2 and 5), `OPERATION_IN_PROGRESS`, `CONFLICTED`, `APPROVAL_EXPIRED`, `STALE_REVIEW`, `STALE_SELECTION`, `TRUST_REQUIRED`, `TRUST_CHANGED`, `MALFORMED_GIT_OUTPUT`, `OUTPUT_LIMIT`, `GIT_FAILED`, `DEADLINE`, `CANCELED`, `COMPLETED_WITH_EFFECTS`, `FAILED_WITH_EFFECTS`, `STATE_UNKNOWN`, `UNKNOWN_TARGET`, `BUSY`. File action reason adds `missing`.

## Δ10 Required contract checks (001 §10)

- Schema tests and golden vectors for every new operation, code, phase, policy, wrapper mode, and private request, in Bun and Rust.
- The shell allowlist holds the new commands.
- Vector tests for each argv builder of `sync-commands.ts`.
- The Rust check of `src-tauri/src/schema.rs` reads each new vector of `native-first-envelope`, `mutation-request`, `progress`, `handshake`, and `process-request`.

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
- Under `simple`, `%(push)` is empty for a triangular workflow, while Git's own push selects `refs/heads/<branch>` on the push remote. The app follows Git's push, so that destination has no tracking ref and no lease.
- Under `matching`, Git selects the branch from the refs that the remote advertises at push time. The review contacts no remote, so the FR-016 panel shows.
- A push URL from `remote get-url --push` already has `pushInsteadOf` applied. `ls-remote` in the terminal applies `insteadOf` to it again.
- A remote result after a canceled push is not observable without a fetch.
- A local-path remote runs the remote repository's own receive hooks on this machine, as Git does by hand.
- 001 `network` runs need only a `started` reply. The shell does not check that the operation started as kind `updateSubmodules`.
- Git checks every `push.default` entry, not only the last one (config.c `git_default_push_config`). An invalid entry makes each Git read exit 128, also the trust listing. So a review ends with the code of that failed read, not `invalid-config`.
- `push --set-upstream` also writes `branch.<branch>.rebase` when `branch.autoSetupRebase` asks for it (branch.c `should_setup_rebase`). Set upstream writes only `remote` and `merge`.
