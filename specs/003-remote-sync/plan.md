# Implementation Plan: Remote Sync

**Branch**: `f003-spec` (feature `003-remote-sync`) | **Date**: 2026-10-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-remote-sync/spec.md`

**Related**: [research.md](research.md) | [data-model.md](data-model.md) | [contracts/operations.md](contracts/operations.md) | [quickstart.md](quickstart.md)

## Summary

Each remote operation runs Git's own command with machine-readable output. Fetch uses `fetch --porcelain`. Push uses `push --porcelain`. Counts use `for-each-ref` with `%(upstream:track,nobracket)` and `rev-list --left-right --count`. Outcomes come from these parses, from Git exit codes that Git documents, and from fresh reads of refs, HEAD, the index, and the 001 operation markers. Pull is the app's own fetch, then a count, then a local `merge` or `rebase` against the exact remote-tracking ref. So the "only behind" and "diverged" decision comes from the counts after the fetch (FR-027). The mode rule copies builtin/pull.c. Mark resolved is a new `resolve` direction of the 001 `applyFile`. Clone is a native-first operation that ends in the 001 open flow.

Five facts drive the design (research R1, R2, R5, R8, R10):
- The 001 `network` policy sets `GIT_PROTOCOL_FROM_USER=0`. Git's default `protocol.file.allow` is `user`, so that policy blocks local-path and `file://` remotes. A new policy `remote` keeps Git's own transport policy (FR-008).
- Plain `for-each-ref` prints untranslated tracking text. Only `git branch` and `git tag` call `setup_ref_filter_porcelain_msg()`. One process counts all local branches, which SC-003 needs.
- `%(push:remoteref)` is filled only when the push remote has `remote.<name>.push` refspecs (remote.c `remote_ref_for_branch`). The destination rule therefore also reads `push.default` (D4).
- Git adds plink's `-batch` only for the TortoisePlink variant (connect.c `push_ssh_options`). The app sets `GIT_SSH_COMMAND='<plink>' -batch` and `GIT_SSH_VARIANT=plink` in the child environment only, as the PuTTY manual §7.4 shows.
- On Windows, `git update-index --add` on an unmerged path loses the link and exec modes that `git add` keeps (R16 i). The porcelain v2 `mW` field equals the `git add` mode. So Mark resolved hashes the working file and writes stage 0 with mode `mW` through `update-index --index-info`. It reuses the 001 candidate, blob proof, and publication steps.

## Technical Context

**Language/Version**: The 001 and 002 versions stay: TypeScript `7.0.2`, Bun `1.4.3` (exact, T366), Rust/Cargo `1.98.0`.

**Primary Dependencies**: No new runtime dependency. The test-only devDependency `ssh2` 1.17.0 follows the O-5 record (T007, T008). User-installed optional programs: PuTTY 0.75 or later (plink, Pageant, PuTTYgen; O-6). The Git floor stays 2.55.0 (001). It covers `fetch --porcelain` (Git 2.41) and `%(push:remoteref)` (Git 2.22).

**Storage**: The shell settings gain the SSH client choice, the plink path, one key file per worktree and remote, the default pull action, the default clone folder, and the parent of the last clone. Repositories get no app write. Two exceptions exist: the Set upstream values, and Git's own writes during an operation.

**Testing**: Bun contract tests and golden vectors (`tests/contracts`, `tests/vectors`). Real Git tests with local bare remotes, a local `git http-backend` remote with Basic sign-in, and a local `git daemon` (`tests/git`). Windows packaged and native tests (`tests/windows`). Every case that starts plink, Pageant, or PuTTYgen runs in Windows Sandbox. WSL tests (`tests/wsl`). Cargo tests for policies, wrapper modes, the allowlist, settings, Pageant start, and destination facts. No test contacts a public host.

**Target Platform**: Windows 11 x64 with Git for Windows. WSL2 repositories run through the distro Git. PuTTY applies only to Windows repositories.

**Project Type**: Local-first desktop application: Tauri 2 shell, compiled Bun Git service, React renderer.

**Performance Goals**: SC-003: all counts of 200 branches show within 1 s after the sidebar shows. SC-004: 5 s to a reconciled or unknown state, and the stall notice within 20 s. SC-008: the 001 SC-005 input targets during every remote operation.

**Constraints**: Network use only on a user action (FR-041). The 001 network limits: stall notice at 15 s, inactivity end at 300 s, ceiling at 4 h. The configuration files stay byte-identical, except a selected Set upstream. No credential in a display, log, diagnostic, or command. No submodule recursion. No stash, no discard, and no force without a lease.

**Scale/Scope**: 10,000 refs (`REF_LISTING_RECORDS`), 1,000 listed fetch updates per remote, 100 lease subjects, a count display bound of 10,000, and 256 remotes. Fixtures: a moderate repository with 200 branches, and a branch with an unrelated history of 20,000 commits.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Checked against `.specify/memory/constitution.md` version 3.0.0, before research and again after Phase 1.

| Principle | How the design meets it | Status |
|---|---|---|
| I. Preserve user data | Git stays authoritative. Every outcome is reconciled from fresh reads. No stash, discard, or reset (FR-029). Force push needs a lease and a modal confirmation that names the commits. Set upstream is the only configuration write, and the user selects it. Abort states its limits. Skip opens a confirmation that names the commit that leaves the rebased branch and states that Git discards the index and working-file changes of that step; Cancel has the initial focus. A rebase pull is a history rewrite. Constitution I (version 3.0.0) counts a non-interactive rebase pull as confirmed when the user explicitly selects a rebase action, or when the user's own Git configuration selects a rebase for a pull that the user starts. These choices count: the Pull with rebase menu item or notice choice, the Rebase choice of the FR-027 mode question, a default action that the user set to Pull with rebase, or Pull (use Git's configuration) when `pull.rebase` or `branch.<name>.rebase` selects a rebase (FR-057). Continue at a stop of the user's own `-i` rebase runs its remaining `pick`, `reword` (message kept, because of `GIT_EDITOR=:`), `drop`, `fixup`, and `squash` lines without a new confirmation: the user wrote that todo, and Abort and the reflog can undo it. Continue and Skip refuse while the todo holds an `exec` line (D7). The app never deletes a clone folder. The selected Git runs every command. | Pass |
| II. TypeScript/Bun | All Git logic is in TypeScript. Rust adds only platform work: Pageant start outside the Job with `WaitForInputIdle`, the terminal launch with `CREATE_NEW_CONSOLE`, the file version resource, destination facts, pickers, and settings. | Pass |
| III. Validated boundaries | Typed operations with zod and the strict decoder. Remote names must be in the `git remote` list. A branch name must pass the `check-ref-format` rules. URLs, remotes, and refspecs pass after `--`. Every output has a bound. Each operation has its own Job for Cancel. | Pass |
| IV. Real Git verification | Local bare remotes, compared with Git's own commands on copies. The tests check refs, the index, working bytes, and operation state. They cover failure, cancel, external changes, the lease safeguard, and stale Mark resolved. | Pass |
| V. Untrusted repositories | The trust class `sync` covers the hook events, transport programs, filters, and protocol switches that these commands can run (D11). Remote messages show as plain text. URLs are redacted. PuTTY variables are set only in the child environment. A repository-controlled `remote.<name>.puttykeyfile` is never used without the user's save (O-8). | Pass, note N-1 |
| VI. Platform evidence | Packaged Windows evidence for PuTTY, Pageant, the terminal, the stall notice, cancel timing, and counts timing. Every case that starts plink, Pageant, or PuTTYgen runs in Windows Sandbox. WSL stays unverified until the distro runs. | Pass |
| VII. Accessible and measured | Counts have text alternatives and an equal mark, and status never depends on color alone. Force push shows an icon and text, and Cancel has focus. Toolbar icons have tooltips with keys. SC-003, SC-004, and SC-008 budgets are fixed before measurement. Fetch, pull, push, and clone workloads use the 001 CPU and process-tree memory rows. Their budgets are fixed before T078 runs. | Pass, note N-2 |
| VIII. Locked dependencies | No runtime dependency. One optional test devDependency goes into the lockfile after O-5. | Pass |
| IX. One planning process | All artifacts stay in `specs/003-remote-sync`. The contract lists only deltas to 001 and 002. | Pass |

Notes from the second check:
- **N-1 (V)**: One trust class `sync` covers all sync actions, so a fetch in a repository with a repository-controlled `pre-commit` hook needs approval. This is a ponytail ceiling. Upgrade path: one class per action. Add it when a user reports extra trust prompts.
- **N-2 (VII, "cold/warm timings")**: P12 records cold and warm runs for SC-003 by the 001 rules.
- **N-3 (Delivery Gates)**: The plan defines safety tests (SC-002, SC-005, SC-006, SC-012, SC-014), trust boundaries (D11), accessibility checks (FR-020, FR-024, FR-039), budgets (SC-003, SC-004, SC-008), and platform qualification (P11, P12).
- **N-4**: The app adds a lease, no tag push, no autostash, and no submodule recursion. Each is a deliberate difference from a bare `git push` or `git pull`, and the spec requires each one.

No violation, so Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/003-remote-sync/
├── spec.md
├── plan.md                 # This file
├── research.md             # Phase 0
├── data-model.md           # Phase 1
├── quickstart.md           # Phase 1
├── contracts/
│   └── operations.md       # Phase 1: deltas to the 001 and 002 contracts
├── checklists/
│   └── requirements.md
└── tasks.md                # Phase 2 (/speckit-tasks, not created here)
```

### Source Code (repository root)

```text
src/
├── contracts/              # operations.ts, envelope.ts, errors.ts, limits.ts, channel.ts,
│                           # git-environment.json (+ remote, integrate), wsl-process.json (+ modes),
│                           # file-action.ts (+ resolve), schemas/,
│                           # new: clone-name.ts
├── git-service/            # session.ts, trust.ts (+ sync class), file-publish.ts, hunk-publish.ts,
│                           # comparison.ts, git-runner.ts (+ policies)
│                           # new: sync-commands.ts, sync-parsers.ts, tracking.ts,
│                           #      sync-review.ts, sync.ts, sync-integrate.ts, clone.ts
└── frontend/               # bridge.ts, app/Workbench.tsx, app/NoticeBand.tsx, app/RepositoryMenu.tsx,
                            # app/RepositoryStates.tsx, refs/ReferencesSidebar.tsx,
                            # history/HistoryView.tsx (002), changes/ChangesPane.tsx, commit/CommitTray.tsx
                            # new: state/tracking.ts, sync/* (SyncToolbar.tsx, PullSplitButton.tsx, PushPanel.tsx,
                            #      ForcePushConfirm.tsx, PullModeChoice.tsx, ConflictActions.tsx),
                            #      clone/CloneDialog.tsx, settings/SettingsDialog.tsx
src-tauri/
├── build.rs
└── src/                    # ipc.rs, git_env.rs, wsl.rs, process_requests.rs, settings.rs, dialogs.rs, close.rs
                            # new: putty.rs
tests/
├── support/                # new: http-remote.ts, git-daemon.ts, ssh-server.ts
├── git/                    # new: remote-fixtures.ts, remote-facts.test.ts, remote-servers.test.ts,
│                           #      ssh-server.test.ts, connect-terminal.test.ts, sync-*.test.ts,
│                           #      clone.test.ts, mark-resolved.test.ts, tracking.test.ts
├── windows/                # new: putty-facts.test.ts, sync-packaged.test.ts, sync-perf.test.ts, no-network.test.ts
├── wsl/                    # new: sync-wsl.test.ts
├── contracts/              # new: sync-contract.test.ts, sync-rules.test.ts, sync-*.test.ts(x), clone-name.test.ts
└── vectors/
scripts/windows/            # new: putty-tests.wsb, its prepare script, and its README
```

**Structure Decision**: The 001 three-part layout stays: renderer, Bun service, and shared contracts, with a thin Tauri shell. The new service files sit beside `submodule-update.ts`, whose network step pattern they reuse (`submodule-update.ts:470-512`).

## Design

### Steps (riskiest proof first)

| Step | Files and symbols | Behavior change | Tests that prove it | Main risk |
|---|---|---|---|---|
| P0.1 Remote fixtures | new `tests/git/remote-fixtures.ts`. It reuses the owned global configuration and `fiCommit` of `tests/git/fixtures.ts`. New `tests/support/http-remote.ts`: `Bun.serve` with `git http-backend` and Basic sign-in on 127.0.0.1. A `git daemon` helper for SC-013. | None (tests only). Bare remotes with clones: ahead, behind, diverged, equal, no upstream, upstream gone, remote and branch names with slashes, 200 branches, a 20,000-commit unrelated branch. Merge and rebase conflicts: UU, AA, AU, UA, DU, UD, DD, a symlink stage, stages with different exec bits, a `filter` path, conflict-marker text in a resolved file. A remote `pre-receive` that refuses. The `push.default` matrix, `remote.<name>.push`, `pushRemote`, `pushDefault`, two push URLs, a mirror remote. A partial clone, a moved gitlink, a URL with a credential, a credential helper. | The builder self-check: ref values, counts from `rev-list`, operation markers. | Build time of the unrelated branch. Mitigation: the 001 fixture cache. |
| P0.2 Git facts | new `tests/git/remote-facts.test.ts` | None. Records the Git behavior that the design depends on (research R16). | (a) `fetch --porcelain` line grammar; with `--progress`, whether stderr still carries the counter. (b) `push --porcelain` full ref names, the `To` and `Done` lines, `[rejected]`, `[remote rejected]`, and a lease refusal as `[rejected]`. (c) `%(upstream:track,nobracket)` grammar under `LANG=de_DE.UTF-8` and `LC_ALL=de_DE.UTF-8`, equal to `rev-list --left-right --count` on each branch. (d) The D4 destination equals the `to` field of Git's own `push --dry-run --porcelain` for every config fixture. (e) The D6 pull equals Git's own `pull` on copies (tree, parents, index, files) for each mode matrix row. (f) `GIT_EDITOR=:` with `commit` keeps `MERGE_MSG` without comment lines. (g) `GIT_PROTOCOL_FROM_USER=0` blocks a local-path remote. (h) `merge` and `rebase` ignore `submodule.recurse=true`. (i) `update-index --add` on each unmerged kind gives the same `ls-files --stage` as `git add`, with the stage-0 mode. (i2) `update-index --index-info` with mode `mW` equals `git add` for each unmerged kind on Windows and WSL. (j) `%(upstream)` is empty when `branch.<name>.remote` names an unconfigured remote. (k) The `git fetch --all` remote set with `skipFetchAll` and `skipDefaultUpdate`. (l) `rebase --skip` leaves the index and working files equal to HEAD of the next step. (m) `git fetch --all` and `git push` with a non-boolean `skipFetchAll`, `skipDefaultUpdate`, or `mirror` value. Windows Git 2.56 (2.56.0.windows.2 on the reference PC) and WSL Ubuntu-26.04 Git 2.55. Each fact records the observed version. | A fact fails. Record it in research.md, then change the contract before P4. |
| P0.3 SSH and PuTTY facts | new `tests/support/ssh-server.ts` (O-5), new `tests/windows/putty-facts.test.ts`, inert fixtures `tests/fixtures/ssh/` (test key pair, `.ppk` without passphrase) | None. | A plink `-batch` fetch with an unknown host key fails within 5 s. `GIT_SSH_COMMAND` with a plink path that holds a space and U+0027 works. `pageant --encrypted <key>` adds to a running Pageant and exits, and starts a new agent that `WaitForInputIdle` reports idle. A key that Pageant holds lets a fetch pass. Pageant `--encrypted` with an unreadable key file exits non-zero. Every case that starts plink, Pageant, or PuTTYgen runs only in Windows Sandbox. The host keeps only the file version read of `pageant.exe`. | No SSH server is available (O-5). Capability skip, recorded as unverified. |
| P1 Pure logic | new `src/git-service/sync-commands.ts` (every argv), new `src/git-service/sync-parsers.ts` (fetch and push porcelain, tracking records, counts, the D4 destination rule, the D6 mode rule), new `src/contracts/clone-name.ts`, `src/contracts/file-action.ts` (`resolve` decision, reason `missing`) | Algorithms only. | Unit and vector tests for each grammar, each refusal, and each matrix row of D4 and D6. Clone name cases. Resolve decision cases. | Grammar drift between Git versions. P0.2 pins it. |
| P2 Contracts | `src/contracts/{operations,envelope,errors,limits,channel}.ts`, `git-environment.json`, `wsl-process.json`, `schemas/`, `tests/vectors/` | Adds `readTracking`, `reviewSync`, `sync`, `clone`, `connectInTerminal`, six shell-only settings operations, the `resolve` direction, four codes, phases, the policies `remote` and `integrate`, two WSL modes, and the private requests `pageant`, `terminal`, and `destinationFacts`. | Schema tests and golden vectors in Bun and Rust. | typify drops ranges. Keep explicit checks, as 001 §1 requires. |
| P3 Shell | `src-tauri/src/{git_env,wsl,process_requests,ipc,settings,dialogs,close}.rs`, `src-tauri/build.rs`, new `src-tauri/src/putty.rs`, `src/frontend/bridge.ts` and `tests/contracts/bridge.test.ts` (the new calls). | Policies `remote` and `integrate` take the inactivity limits (`process_requests.rs:2655`). Policy fit (`process_requests.rs:738-745`). The PuTTY pair is added to `remote` runs. The `clone` context. Destination facts. Pageant start and wait. Terminal launch. Settings and pickers. Marker kind `sync`. Close prompt for `sync` and `clone`. | Cargo tests: policy build, mode list, allowlist, limit checks, settings round trip, destination facts on a fixture folder, Pageant wait with a capability skip. | Local only. Rust work stays off cloud sessions. |
| P4 Service core | new `tracking.ts`, `sync-review.ts`, `sync.ts`; `trust.ts` (class `sync`); `session.ts` (handlers); `git-runner.ts` (`EnvironmentPolicy`) | `readTracking`. `reviewSync` and `sync` for fetch, fetch-all, push, and force-push. Reconciliation. Retained connect targets. | SC-001 (fetch, push), SC-002, SC-003 values, SC-005, SC-006, SC-010 mapping. Cancel and deadline at each step. External ref moves. TRUST_REQUIRED before a pre-push hook. Remote rejection by `pre-receive`. A lease that loses no remote commit. | Parse of porcelain under rare configs. Mitigation: strict grammar, then the observed state decides. |
| P5 Pull and conflict actions | new `sync-integrate.ts`; `session.ts` (one line) | Pull (fetch, count, decide, integrate), `integrate`, abort, continue, skip. | SC-001 (pull), SC-012, and FR-029 refusal. The mode matrix against Git's own pull. A rebase that stops again. Continue blocked while unmerged entries exist, also with marker-like text. | A Git behavior difference between `pull` and the split steps. P0.2 (e) records it. |
| P6 Mark resolved | `file-action.ts` (P1), `comparison.ts`, `file-publish.ts`, `hunk-publish.ts`, `wsl-files.ts` | `applyFile` direction `resolve` for an unmerged path: `hash-object -w` of the working file, then `update-index --index-info` with mode `mW` (D7). | SC-014: index equal to `git add`, also for exec bits on Windows; working bytes unchanged, stale refusals, marker-like text stages. | `hunk-publish.ts:628-635` assumes no stage above 0. Known-hard. |
| P7 Clone and terminal | new `clone.ts`; `session.ts` (two lines) | `clone` with destination facts, the PuTTY key, and registration. `connectInTerminal`. | SC-011, FR-047 refusals that start no Git, FR-050 folder states after cancel, submodules not cloned, empty remote opens unborn. | Discovery after clone in WSL. |
| P8 Frontend A | new `state/tracking.ts`, new `sync/*`, `app/Workbench.tsx`, `app/NoticeBand.tsx`, `refs/ReferencesSidebar.tsx`, `commit/CommitTray.tsx`, `history/HistoryView.tsx` (after 002 P6) | Toolbar Fetch, the Pull split button with its default action, Push, and the Fetch all menu. Counts in the toolbar, the sidebar, and history labels. Push panel, push-rejected notice, force confirmation, Commit and push. | Component tests: keyboard, focus, unavailable reasons, text alternatives, notice lifetime, Cancel focus. | The 002 history view must be merged first for the history labels. |
| P9 Frontend B | `sync/PullModeChoice.tsx`, `sync/ConflictActions.tsx`, `app/NoticeBand.tsx`, `changes/ChangesPane.tsx` | The pull mode choice, conflict actions with the Abort confirmation, and Mark resolved. | Component tests. | None new. |
| P10 Frontend C | new `clone/CloneDialog.tsx`, `settings/SettingsDialog.tsx`, `app/RepositoryMenu.tsx`, `app/RepositoryStates.tsx`, `app/NoticeBand.tsx` (Connect in a terminal) | Clone panel with the suggestion, SSH and clone settings, and PuTTYgen. | Component tests: the suggestion follows URL edits until a destination edit. | None new. |
| P11 WSL | `tests/wsl/sync-wsl.test.ts` | None (tests). | SC-009 in each distro: results, no remaining process after Cancel or close, the anchor activity signal on a real fetch. | WSL fetch activity is unverified (001 §12). |
| P12 Packaged qualification | `tests/windows/sync-packaged.test.ts`, `sync-perf.test.ts`, `no-network.test.ts` | None (tests). | SC-003 timing, SC-004, SC-007 (Sandbox), SC-008, and SC-013 (30 minutes; the `git daemon` access hook, the HTTP server, and the SSH server count requests; no log text decides). | The open 001 tools (T165, T180, T240, T242, T244). |

Each phase writes its tests first. P0.2 and P0.3 are the riskiest proofs and run first.

### D1 Contracts

[contracts/operations.md](contracts/operations.md) holds the deltas. Summary:
- `readTracking` is one read. It runs one `for-each-ref` over `refs/heads` and `refs/remotes` with `%(upstream:track,nobracket)`.
- `reviewSync {action, …}` is read-only. It returns the plan, a refusal, or a one-use `syncReviewToken`. Actions: `fetch`, `fetch-all`, `pull`, `integrate`, `push`, `force-push`, `abort`, `continue`, `skip`.
- `sync {syncReviewToken, start: true}` is the one new mutation. It runs the reviewed action and reconciles.
- `applyFile` gets the direction `resolve` (Mark resolved).
- `clone {url, destination}` is native-first. It ends with the 001 registration result.
- `connectInTerminal {operationId}` opens the PuTTY connect terminal for a failed operation.
- Shell-only: `readSyncSettings`, `setSshClient`, `setDefaultPullAction`, `chooseSyncPath`, `clearSyncPath`, `launchPuttygen`.
- New codes: `SYNC_UNAVAILABLE`, `PUSH_REJECTED`, `PUTTY_UNAVAILABLE`, `DESTINATION_NOT_EMPTY`.

### D2 Process model, environment, progress, and cancel

- Policies (contract Δ7):
  - `remote` serves fetch, push, and clone. It equals `network` without `GIT_PROTOCOL_FROM_USER`. The service environment value of that variable stays unchanged.
  - `integrate` serves merge, rebase, commit for Continue, abort, and skip. It equals `mutation` without `GIT_INDEX_FILE`, plus `GIT_EDITOR=:`.
  - The 001 `network` policy stays for `updateSubmodules` only.
- Limits: every `sync` and `clone` Git process uses the 001 network limits (`git-runner.ts:72`): inactivity 300 s, ceiling 4 h, stall notice 15 s. Review reads, the count, and the refs listings keep the 30 s deadline (001 §5).
- Activity: the 001 Job I/O sum, which includes network I/O (Win32 `IO_COUNTERS`). WSL uses the anchor CPU-time sum (001 §12).
- Progress: phases `sync-fetch`, `sync-merge`, `sync-rebase`, `sync-push`, `sync-continue`, `clone`, and `pageant`. The percentage comes from `parseSubmoduleProgress` (`src/contracts/submodules.ts:133`), which reads Git's untranslated counter format (progress.c). No estimate. The renderer composes "Fetching from <remote>…" from the review result. Progress events carry no remote name.
- Cancel closes the Job of the operation. Reconciliation then re-reads the refs, HEAD, the index, and the markers (FR-004). WSL first waits for the 001 §12 process-end fact.
- Stall remedy: the copyable PowerShell command of the running step, built with `buildRemedyCommand` (`src/contracts/remedy-command.ts:55`). A URL that holds user information gives no command, only text.
- Output: the `outputTail` of the failed or finished process, built with `buildSubmoduleOutputTail` (`submodules.ts:192`) and redacted with `redactUrlUserInfo` (`submodules.ts:146`). Remote messages stay inside the tail. No line is selected by its text.

### D3 Fetch

- The remote of Fetch is the default remote of remote.c `remotes_remote_for_branch`: `branch.<branch>.remote`, else the only remote of `git remote` when exactly one exists, else `origin` (research R16 d). builtin/fetch.c takes it through `remote_get(NULL)`. Without a branch (detached HEAD), it is the only remote, else `origin`.
- A remote that `git remote` does not list gives `SYNC_UNAVAILABLE` reason `remote-missing`, and no Git process starts.
- The value `.` gives reason `local-upstream`.
- A merge or a rebase in progress does not refuse Fetch or Fetch all remotes (spec "Changes to feature 001 requirements", 001 FR-016).
- From the push-rejected notice, the payload names the push remote (contract Δ3).
- Argv: `--no-lazy-fetch fetch --porcelain --progress --no-recurse-submodules -- <remote>`. The app adds no prune or tag option (FR-011).
- Fetch all: every remote of `git remote`, in its order, without the skipped remotes (O-4). A remote is skipped when the last value of `remote.<name>.skipFetchAll` and `remote.<name>.skipDefaultUpdate`, taken over both names, is true by `parseMaybeBool` (research R16 k). One process per remote, so each remote has its own outcome. An invalid remote value or a string key without a value refuses every action before any process (contract Δ3 `reviewSync`, research R16 m).
- Result: the porcelain lines up to `SYNC_FETCH_LISTED_REFS` (1,000), with counts by flag for every line.
- Reconciliation compares a full `for-each-ref` listing from before and after the fetch. A change that the porcelain lines do not list gives `completed-with-effects`, with the observed list.

### D4 Push and the push destination

- Review read: `for-each-ref --format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(push)%00%(push:remotename)%00%(push:remoteref) refs/heads/<branch>`. The pattern matches by prefix, so the service keeps only the record whose refname equals `refs/heads/<branch>`.
- Destination rule (builtin/push.c `setup_default_push_refspecs`, remote.c `branch_get_push_1`; research R2, R16 d). The rule follows Git's own push of the current branch (FR-014). "Panel" means no destination, so the FR-016 panel shows. When `%(upstream)` is not empty, the panel shows the current upstream and shows Set upstream not selected.
  0. `%(upstream)` empty: the panel shows. It is pre-filled with the steps 1 to 5 destination when one exists.
  1. R = `%(push:remotename)`. Empty: no remote is explicit, so R is the only remote when exactly one exists, else `origin` (remote.c `remotes_remote_for_branch`, research R16 d). R not in `git remote`: panel.
  2. R is `.`: reason `local-push-remote`. Git pushes into the repository itself; the app refuses on purpose (R16 d). R not in `git remote`: reason `remote-missing`. `remote.<R>.mirror` true: reason `mirror`. Git pushes to a mirror remote; the app refuses on purpose (R16 d). An invalid remote value or a string key without a value refuses every action before any process (contract Δ3 `reviewSync`, research R16 m).
  3. dst = `%(push:remoteref)` when it is filled, which is the `remote.<R>.push` case. Source `remote-push-refspec`.
  4. Else, by the last `push.default` value. Git checks every entry, so one invalid entry stops each Git read before this rule (contract "Contract gaps"). F is the fetch remote: the default remote of remote.c `remotes_remote_for_branch`: `branch.<branch>.remote`, else the only remote of `git remote` when exactly one exists, else `origin` (research R16 d).
     - A is the auto upstream: some `push.autoSetupRemote` entry is true, and the branch has no `branch.<branch>.merge` entry or no `branch.<branch>.remote` entry (builtin/push.c `git_push_config` and `get_upstream_ref`, remote.c `set_merge`; R16 d). A false entry does not clear a true entry. An invalid entry gives reason `invalid-config` for every push, because `git push` exits 128 on it.
     - `current`: dst = `refs/heads/<branch>`.
     - `simple` or unset, R differs from F (triangular): dst = `refs/heads/<branch>`, because Git's push treats it like `current`. Source `push-default-triangular`.
     - `simple` or unset, R equals F, and A: dst = `refs/heads/<branch>`. Git's push also sets the upstream, so the panel pre-fills this destination with Set upstream selected (FR-014, FR-016).
     - `simple` or unset, R equals F: `%(push)` empty means that Git cannot resolve one destination, so panel. Else dst = `refs/heads/<branch>`.
     - `upstream` or `tracking` with A: needs F = R, else reason `push-remote-differs`. dst = `refs/heads/<branch>`, source `push-default-upstream`, pre-filled as for `simple`.
     - `upstream` or `tracking`: needs `%(upstream:remotename)` = R, else reason `push-remote-differs`. `%(upstream)` empty: panel. Else dst = `%(upstream:remoteref)`.
     - More than one `branch.<branch>.merge` entry gives reason `several-merge-refs` for `simple` or unset with R equal to F, and for `upstream` or `tracking` after the R check. Git's push stops there with exit 128 (builtin/push.c `get_upstream_ref`).
     - `matching`: panel. Git pushes the branch only when the remote advertises a branch of the same name at push time. The review contacts no remote (R2).
     - `nothing`: reason `invalid-config`. Another value, or a key without a value, fails the trust listing first.
  5. The tracking ref of dst is `%(push)` when it is filled. A triangular destination has an empty `%(push)`, so it has no tracking ref. Force push with lease then gives reason `no-lease` (D5).
- `remote get-url --push --all -- <R>` must print exactly one URL. Otherwise the reason is `push-urls` (O-11). Git pushes to every push URL; the app refuses on purpose (R16 d).
- Argv: `--no-lazy-fetch push --porcelain --progress --no-recurse-submodules --no-follow-tags [--force-with-lease=<dst>:<expect>] -- <R> refs/heads/<branch>:<dst>`.
- Result: the one porcelain line whose `from:to` equals the refspec.
  - Flags ` `, `+`, `*`, and `=` mean success.
  - `!` with `[rejected]` starts the FR-023 notice.
  - `[remote rejected]` shows "Rejected by the remote".
  - `[remote failure]` means an unknown remote result.
  - The reason text in parentheses shows as plain text and decides nothing (FR-015).
- Set upstream: the panel lists the remotes and the branch name. Set upstream is selected by default only for a branch without an upstream (FR-016). The service checks the name with the `check-ref-format` rules (`isRefName`, `commands.ts`).
- After a push with a success status, a selected Set upstream writes `branch.<branch>.remote` and `branch.<branch>.merge` with two `config --local` processes (contract Δ3 "Set upstream"). With `branch.autoSetupRebase` `remote` or `always`, a third process writes `branch.<branch>.rebase true`, as Git's `push --set-upstream` does. The review binds that fact in `destination.upstreamRebase`. Exit codes alone decide. A failed write gives `upstreamNotSet` and a remedy, and the push stays succeeded.

### D5 Push rejected and force push with lease

- The renderer keeps the notice until a later push succeeds, the user dismisses it, or the HEAD target changes (FR-023).
- The four choices, in order: Pull with rebase (`reviewSync {action: "pull", mode: "rebase"}`), Pull with merge, Fetch (`{action: "fetch", remote: <push remote>}`), and Force push with lease.
- The force-push review reads the tracking OID T. Without T, the reason is `no-lease`. A D4 destination without a tracking ref, such as a triangular one, also gives `no-lease`.
- It counts `rev-list --count T ^HEAD` and reads up to 100 subjects with `rev-list --max-count=100 T ^HEAD` and the 001 `cat-file --batch-command` reader.
- The modal names the destination, the count, and the subjects, and says that other people can lose work. Cancel has the initial focus.
- `sync` re-reads T. A changed T gives `STALE_REVIEW`, and the modal must show again.
- The lease is `--force-with-lease=<dst>:<T>`. A `[rejected]` status of this push means that the remote branch changed (spec Assumptions). The notice then offers Fetch.

### D6 Pull: fetch, count, decide, integrate

1. Fetch R = `branch.<branch>.remote` by D3. The upstream must exist in the configuration. Otherwise the reason is `no-upstream`. Several `branch.<branch>.merge` values give reason `several-merge-refs`.
2. Read the upstream OID U from the post-fetch listing. A missing U ends with reason `upstream-gone` after the fetch effects.
3. Count with `rev-list --left-right --count <HEAD oid>...<U>`. The output is "ahead TAB behind".
4. Decide, as builtin/pull.c `cmd_pull` decides (research R3):
   - behind 0: up to date.
   - `pull.ff=only` and diverged: with no payload mode, reason `ff-only`, whatever the configured rebase value (t7601 "pull.ff=only overrides pull.rebase=true"). With a payload mode, that mode runs, because Git's pull turns `--ff-only` into `--ff` for an explicit `--rebase` or `--no-rebase`. Only behind: fast-forward.
   - The payload mode, then `branch.<branch>.rebase`, then `pull.rebase`: `true` or `merges` rebases when diverged and fast-forwards when only behind, also with `pull.ff=false`. `interactive` gives reason `interactive-rebase` when a rebase is needed.
   - Diverged, with no rebase value and no `pull.ff`: the result is `integration: mode-required`. The renderer asks, then sends `reviewSync {action: "integrate", mode}`. No configuration changes.
   - Only behind: with `pull.ff=true` or `only`, fast-forward. With `pull.ff=false`, Git's pull makes a merge commit (O-2). Without `pull.ff`, merge with no ff option, so `merge.ff` applies as in Git's pull (O-2, research R16 e).
   - Otherwise: merge, with the `pull.ff` option that Git's pull passes.
5. Integrate (policy `integrate`):
   - fast-forward: `merge --ff-only --no-autostash <upstream ref>`;
   - merge: `merge --no-edit --no-autostash [--ff | --no-ff] [--no-log -m <message>] <upstream ref>`. For a `refs/remotes/` upstream, `<message>` is the feature 004 D5 preview: `fmt-merge-msg` with stdin `<U>\t\tremote-tracking branch '<short name>' of .` and LF, where `<short name>` is the upstream without `refs/remotes/`. That is the line of builtin/merge.c `merge_name`, so the message equals Git's own `git merge <short name>`, also with `merge.log` (004 research F12). `--no-log` stops a second shortlog. Another upstream form gets no `-m`, so Git writes its own default message;
   - rebase: `rebase --no-autostash --fork-point [--rebase-merges] <upstream ref>`.
6. Reconcile. A fast-forward HEAD must equal U. A merge commit must hold U as a parent. After a merge without an ff option, HEAD equals U, or a merge commit holds U as a parent. A rebase result must contain U. Any other observation gives `completed-with-effects`, with the observed values.
- A merge or rebase in progress after step 5 gives `failed-with-effects` with `integration: stopped`, its kind, and the unmerged count. The notice band then shows the actions.
- The merge message equals Git's own `git merge <remote>/<branch>` (O-3, step 5).
- Pull and integrate check `OPERATION_IN_PROGRESS` before `detached`, because a rebase in progress detaches HEAD.
- The count uses the bound HEAD. A HEAD that another process moved during the fetch gives `STALE_REVIEW` after the fetch effects, and no integrate step starts.

### D7 Conflict actions and Mark resolved

- The kind comes from the 001 markers (`commands.ts:117`, `status.ts:260` `stateOf`). Only `merging` and `rebasing` get actions. `unknown` gives reason `unknown-operation`: `rebase-apply/applying` (git am), or a marker without a file fact. `normal` and `conflicted` give `no-operation`.
- Abort: `merge --abort` or `rebase --abort`.
- Continue:
  - merging: `commit --quiet`. With `GIT_EDITOR=:`, Git takes `MERGE_MSG` and strips the comment lines (research R4).
  - rebasing: `rebase --continue`.
  - The review and `sync` require a fresh index with no unmerged entry. Otherwise the code is `CONFLICTED` with the count.
- Editor: Continue never opens an editor. The `integrate` policy sets `GIT_EDITOR=:` in the process environment (contract Δ7, `git-environment.json`; the WSL wrapper exports it, Δ11). git-var(1) documents the order `GIT_EDITOR`, then `core.editor`, then `VISUAL`, then `EDITOR`, so the user's `core.editor` does not apply. editor.c `launch_specified_editor` starts no program for the editor `:` and keeps the prepared message file. So `commit` and `rebase --continue` take the message that Git prepared, with Git's own cleanup (research R4, R16 f, R18). No configuration changes.
- Skip: `rebase --skip`, only while rebasing. Skip opens a confirmation before the start. The confirmation names the commit of `REBASE_HEAD`, which gitrevisions(7) defines as the commit at which the rebase stopped. It states that Git discards the index and working-file changes of that step. Cancel has the initial focus. Without `REBASE_HEAD`, Skip gives reason `no-skip-commit`.
- Every rebase stop offers Abort, Continue, and Skip, for the merge and the apply backend, as Git and Git Extensions do. builtin/rebase.c `init_basic_state` writes `rebase-merge/interactive` for every merge-backend rebase, also a non-interactive one, so that file is no fact about an interactive rebase and decides nothing (research R18). This also covers the 004 autosquash rebases.
- Exec lines: repository content is untrusted, and a folder from an archive can hold a todo with `exec` lines, which Git runs with the shell. So the Continue and Skip reviews of a rebase read `rebase-merge/git-rebase-todo` (path from `rev-parse --git-path`, bound `SYNC_REBASE_TODO_BYTES`). A line is an `exec` line when, after its leading spaces and tabs, its first word up to a space, a tab, CR, or the end is `exec` or `x`:
  - sequencer.c `todo_list_parse_insn_buffer` ends a line at LF and drops a final CR. `parse_insn_line` drops the leading spaces and tabs (`strspn(bol, " \t")`). `is_command` takes the name or its one-letter abbreviation from `todo_command_info` (`[TODO_EXEC] = { 'x', "exec" }`) before a space, a tab, CR, LF, or the end.
  - `sequencer_parse_todo_command` matches the commands before `comment_line_str`, so a line that starts with `exec` or `x` is an exec line whatever `core.commentChar` holds, and a comment line never is one (research R18).
  - An exec line, an unreadable file, or a file above the bound gives reason `rebase-exec`. The refusal carries a terminal remedy with `git rebase --continue` or `--skip`. The remedy text of an exec line is "This rebase holds exec lines, and Git runs them as shell commands. Arbareto does not run them. Read the todo list, then continue in a terminal." The remedy text of an unreadable file, a file that is no regular file, or a file above the bound is "Arbareto cannot read the rebase todo list. Continue in a terminal." Abort stays available, because it runs no todo line. A missing file, as for the apply backend, holds no line.
  - The review binds the SHA-256 of the file. `sync` reads it again, and a change gives `STALE_REVIEW`.
- Continue at a stop of the user's own `-i` rebase runs the remaining `pick`, `reword`, `drop`, `fixup`, and `squash` lines without a new confirmation. `reword` keeps its message, because `GIT_EDITOR=:` applies. The user wrote that todo, and Abort and the reflog can undo the result.
- Conflict-action results carry no remedy. The stall notice keeps the step command.
- Mark resolved: `readComparison` of a conflicted entry gives the decision `{direction: "resolve"}`. `applyFile` then runs the 001 §4 steps:
  - Step 5 runs `hash-object -w -- <path>` on the working file. Git applies the conversion of the path attributes, as `git add` does. A `filter` path is refused (data-model §9), so no filter driver runs.
  - Step 5 then runs `update-index -z --index-info` on the candidate with `<mW> SP <oid> TAB <path>` and NUL. `mW` is the working mode of the bound status `u` record (research R16 i). The stage-0 entry replaces stages 1 to 3 of the path (P0.2 i2).
  - `update-index --add` is not used for `resolve`. On Windows it writes `100644` for a link or an exec file (R16 i).
  - Step 6 accepts exactly one stage-0 entry with mode `mW` and no stage 1 to 3 for the path. The blob proof follows.
  - Symbolic links and gitlinks stay refused (data-model §9).
  - A missing working file gives reason `missing`, and so does DD.
  - Acceptance checks the bound operation state for equality, instead of the 001 `CONFLICTED` and `OPERATION_IN_PROGRESS` refusals (`file-publish.ts:219-220`).
  - The WSL path cannot assume an index without stages above 0 (`hunk-publish.ts:628-635`, `wsl-files.ts` `wslIndexOf`). An equal index digest takes the stage fact of the bound index. A stash-apply conflict has stages above 0 and no merge marker.
  - Hunk staging and Stage file stay refused while a merge or a rebase is in progress (001 FR-016 delta).

### D8 Ahead and behind counts

- `readTracking` runs `--no-lazy-fetch --no-optional-locks for-each-ref --format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(HEAD) refs/heads refs/remotes`. This is one process for all branches.
- The track grammar is: empty, `gone`, `ahead N`, `behind N`, or `ahead N, behind M`. The text is untranslated in `for-each-ref` (ref-filter.c `msgs`). P0.2 (c) proves it under a German locale and against `rev-list`.
- Labels:
  - `↑N ↓M`, with the text "N ahead, M behind".
  - An equal mark for an empty track with an upstream.
  - "No upstream" for an empty upstream.
  - "Upstream gone" for `gone`.
  - A configured `branch.<name>.remote` that `git remote` does not list shows "Remote missing".
  - Above 10,000, the label shows "10000+".
- Pairing: the renderer shows a count only when the branch OID and the upstream OID of the tracking result equal the newest `readRefs` values. Otherwise it shows no number (FR-021).
- Triggers: each new `readRefs.refsDigest` (002 Δ8), each outcome, and each focus return.
- The tooltip says that the counts compare with the last fetch (FR-022).
- The toolbar uses the `*` entry. A detached HEAD shows "No branch checked out".
- The history labels join by branch name with the 002 row labels.

### D9 PuTTY

- Setting "PuTTY (plink)", Windows repositories only.
  - The shell adds `GIT_SSH_COMMAND='<plink path, sh-quoted>' -batch` and `GIT_SSH_VARIANT=plink` to `remote` runs.
  - `GIT_SSH_COMMAND` overrides `GIT_SSH` and `core.sshCommand` (connect.c `get_ssh_command`; git-config(1)).
  - Nothing is written into the configuration, the Windows environment, or the registry.
- The setting "Git's own configuration" adds nothing.
- Pageant: the service sends `pageant` before the first `remote` run of each remote and before a clone, on a Windows Git. The reply `git` tells the service that `sshClient` is `git` (contract Δ6). A key file set for the worktree and remote, or picked in the clone panel, goes to Pageant then.
  - The shell starts `pageant.exe --encrypted <key>` outside every Job. PuTTY 0.75 or later is needed (O-6).
  - The reply is `ready` only when the process exits with status 0 (client mode, an agent already ran), or `WaitForInputIdle` returns 0 while the process still runs (new agent). Any other exit status gives `failed` reason `exit`. 30 s without either gives `failed` reason `not-ready`.
  - The PuTTY manual §9.3.1 states that this command loads into a running Pageant. So the app reads no window title and no process list.
  - Pageant asks for the passphrase in its own window at first use. Plink then waits on the agent, and the stall notice names a sign-in window.
- Pageant and PuTTYgen are `pageant.exe` and `puttygen.exe` in the plink folder (O-7). A missing program gives `PUTTY_UNAVAILABLE` with the program and the path (FR-037).
- Connect in a terminal: a failed `sync` or `clone` whose result holds `connectTarget: true` offers it (O-10, data-model §11). The service sets the field from the kept target, so a refusal before the start offers no action.
  - `connectInTerminal` sends the shell a `terminal` request. The shell opens a new console with a constant PowerShell script and the values in environment variables, so no value lands on a command line.
  - The script runs `git ls-remote --heads -- <target>` with `GIT_SSH_COMMAND='<plink>'` without `-batch`. Git parses the URL, host, port, and user, so plink can show the host-key prompt (O-9).
  - The target is the remote name for fetch and pull, the push URL for push, and the URL for clone.
  - The app accepts, stores, and compares no host key.
- Generate or convert a key: the shell starts `puttygen.exe` with no argument.

### D10 Clone

- The panel takes a URL and a destination path. The pure function `suggestCloneName` (`src/contracts/clone-name.ts`) builds the suggestion:
  - The parent is the last clone parent, else the default clone folder, else empty.
  - The name is the last segment after `/`, `\`, or `:`, without trailing separators and one `.git`.
  - The suggestion follows URL edits until the first destination edit.
- `clone` is native-first. The shell checks the path text (absolute, `ChannelPath`, Windows or §11 WSL route). It binds a `clone` context and a `repositoryDiscovery` context for that path and forwards a `bootstrapId`. The service reads the path with `wslDistros`, as `chooseRepository` does (contract Δ3).
- Right before the run, the service sends `destinationFacts`. Absent or an empty folder passes. A file, a non-empty folder, or another type gives `DESTINATION_NOT_EMPTY`, and no Git process starts.
- Argv: `--no-lazy-fetch clone --progress --no-recurse-submodules -- <url> <destination>`. The cwd is the application-owned launch folder, or `/` in WSL.
- Exit 0, then the 001 `chooseRepository` registration flow with the same `bootstrapId`. It must give the destination as the top level. Then the 001 registration result follows, and the trust gate comes before the first read (FR-051). The shell stores the recent entry and the last clone parent.
- Other ends: `destinationFacts` again, and the result states `exists` and `empty` (FR-050). No file is deleted or moved.
- Without a destination fact or a process-end fact, the result holds the code only, and the renderer shows the folder state as unknown ("Open items").

### D11 Trust

- `trust.ts` gains `approvalRequired.sync`. It is true when any of these is repository-controlled:
  - a hook of `SYNC_EVENTS`: the 001 `COMMIT_EVENTS` (`trust.ts:576`) plus `pre-push`, `pre-merge-commit`, `post-merge`, `post-checkout`, `pre-rebase`, and `post-rewrite`;
  - a filter `clean`, `process`, or `smudge`;
  - a command-valued `core.fsmonitor`;
  - a signing program;
  - a transport program: `core.sshCommand`, `core.gitProxy`, `core.askPass`, `credential.helper`, `credential.<url>.helper`, `remote.<name>.uploadpack`, or `remote.<name>.receivepack`;
  - a merge driver: `merge.<driver>.driver`. A pull merge runs it with the shell (ll-merge.c `ll_ext_merge`);
  - `core.alternateRefsCommand`. A fetch in a repository with an alternate runs it with the shell (fetch-pack.c `for_each_alternate_ref`). A probe saw no 001 read or commit run it;
  - a remote helper `git remote-<name>`: a `remote.<name>.vcs` value, a `remote.<name>.url` or `pushurl` value of the form `<name>::<address>` or `<scheme>://` with a scheme that Git does not transport itself, and every `url.<base>.insteadOf` or `pushInsteadOf` entry with any base and value. The service does not copy the rewrite of remote.c, because a copy can drift from Git and miss a helper. The cost is one approval more for such a repository. transport.c `transport_get` (Git 2.56) transports `!is_url(url)`, `file://`, `git://`, `ssh://`, `git+ssh://`, and `ssh+git://` itself and gives `rsync:` no helper. Makefile `REMOTE_CURL_NAMES` installs Git's own helpers for `http`, `https`, `ftp`, and `ftps`, so they do not count. `ext::` stays blocked by the `protocol.ext.allow` default `never` (git-config(1)). Accepted over-reports, each entry on its own: a one-letter scheme such as `C://x`, which Git takes as a DOS drive path that can name a bundle file; an uppercase scheme such as `HTTPS://x`, which `starts_with` does not match, while Windows then finds Git's own helper; a `<scheme>://` URL of a remote whose `remote.<name>.vcs` decides the helper; and a remote name that starts with "/", which remote.c `handle_config` skips;
  - a `protocol.allow` or `protocol.<name>.allow` entry;
  - the 001 `hooksPathControlled`, `folderUnlisted`, or `inputLimited` condition.
- The transport programs already exist in `programKey` for submodules (`trust.ts:311-317`). The main listing now uses them too, so their program files enter the fingerprint. The merge driver enters `programKey` with the shell form. Only repositories with such a repository-controlled program see a new fingerprint once.
- `readTrust` shows the program of each transport value and `remote.<name>.puttykeyfile`, redacted (contract Δ7 "Transport value redaction"). It also reports `approvalRequired.sync`.
- `sync` refuses with `TRUST_REQUIRED` or `TRUST_CHANGED` before any process. Clone needs no trust. The new repository gets the 001 decision.

### D12 Frontend

- Toolbar (FR-039):
  - Fetch, Pull, and Push icon buttons with Hugeicons, tooltips, and keys. Reviewer default: Ctrl+Shift+Down, Ctrl+Down, Ctrl+Up. T-task checks them against the 001 and 002 maps.
  - A menu beside Fetch holds Fetch all remotes.
  - Pull is a split button (FR-055, FR-056). The main part runs the default action. The menu lists Pull (use Git's configuration), Pull with merge, Pull with rebase, Fetch, Fetch all remotes, and Set default action. Set default action is a submenu with radio items for the five actions. The shell stores the choice as `defaultPullAction` (data-model §10, contract Δ3 `setDefaultPullAction`), never in Git configuration. The icon and tooltip of the main part name the current default. Ctrl+Down runs the main part.
  - The pull actions map to `reviewSync {action: "pull"}`, `{action: "pull", mode: "merge"}`, and `{action: "pull", mode: "rebase"}`. A rebase action needs no further confirmation (FR-057).
  - Unavailable reasons come from `readWorkspace` (head, operation state) and `readTracking` (upstream). The review gives exact refusals, such as `remote-missing`.
  - Unavailable because an operation runs: the reason goes into the tooltip and the accessible description; the status bar shows the progress and Cancel. This rule and the reconcile read reason below are the only exceptions to the 001 rule "Every disabled mutation control keeps its visible reason text".
    - The rule applies while `operation !== null && response === null`, for a sync and for every other mutation, such as a commit, a stage, or a submodule update.
    - The reason text is "A Git operation is running. Its progress and Cancel are in the status bar." A visually hidden element holds it for `aria-describedby`. The toolbar shows no inline reason line for it.
    - Fetch, Pull, and Push stay disabled and focusable. Every other unavailable reason keeps its visible inline line.
    - The same rule applies to the actions of the push-rejected row, the Pull mode row, and the conflict row. The Skip tooltip shows the Skip text, then the reason.
    - While an operation runs, a Space refusal does not hide the status bar progress text.
  - Running sync action: the control of the running action shows its progress text, and a Cancel icon button follows it.
    - Fetch and Fetch all remotes show "Fetching…" at Fetch. Pull in every mode, and `integrate`, show "Pulling…" at Pull. Push and Force push with lease show "Pushing…" at Push.
    - After Cancel, the text is "Cancel requested" until the response comes.
    - The accessible name and the tooltip of Cancel are "Cancel <action name>", with the mutation names below. It sends the status bar Cancel request for the same operation ID.
    - Escape does not cancel. When the response removes Cancel while it has focus, focus moves to the action control.
    - Abort, Continue, and Skip show no progress in the toolbar. The status bar shows it.
  - While the reconcile read after a mutation outcome runs, Fetch, Pull, Push, and the actions of the push-rejected, Pull mode, and conflict rows are unavailable with the reason "The status read after the last operation is still running." (001 FR-023). Commit and push stays available, because it waits for the read before its push review. The read gives the generation that the next review names. The reason follows the running reason rule: it shows only in the tooltip and the accessible description, and the toolbar and the band rows show no visible line for it.
  - While `readSyncSettings` runs, the Pull main part shows the reason "The default pull action is still loading…".
  - A failed `readSyncSettings` shows the Pull main part reason "The default pull action did not load: <code>." `<code>` is the response code, or the response state without a code.
  - A review result without a `syncReviewToken` starts nothing. A `force-push` plan without `destination` or `lease` also starts nothing and opens no confirmation (FR-024). The status bar then shows "<action name> did not start: the review is incomplete."
- Counts: `state/tracking.ts`, the sidebar entry, and the 002 history label (after 002 P6).
  - A failed `readTracking` shows "Counts did not load: <code>." in place of the toolbar counts. `<code>` is the response code, or the response state without a code.
- Notices: the push-rejected row and the conflict row. Destructive actions show an icon and text and never fold into More.
- Push panel (FR-016): the note under the Set upstream checkbox names the keys. With `needsDestination.upstreamRebase` false: "Writes branch.<branch>.remote and .merge for <remote>/<remote branch>." With it true: "Writes branch.<branch>.remote, .merge, and .rebase for <remote>/<remote branch>." Without a chosen remote, the text ends after the keys.
- Modals only for Force push with lease, Abort, and Skip (UX direction 2026-10-10; constitution I).
- The 001 "finish it outside Arbareto" text goes for merging and rebasing.
- FR-013: after a fetch outcome, the renderer refreshes the 002 view with `{oid}` of the selected commit, without the refs-changed notice.
- Commit and push: the 001 commit, then a push review only after `succeeded`. The push review waits for the reconcile read of the commit, so it carries the new generation. An unborn branch does not disable Commit and push (FR-038). The push review after the commit decides.
- Mutation names (001 plan.md "Status and fallback texts"): Mark resolved is "Mark resolved". A `sync` takes the name of its action: "Fetch", "Fetch all remotes", "Pull" (also for `integrate`), "Push", "Force push with lease", "Abort", "Continue", or "Skip". A clone is "Clone". The shell close prompt reads the action from the `started` frame (contract Δ6).
- A failed or canceled clone names the folder state from `exists` and `empty` (FR-050, data-model §8):
  - `exists` false: "The folder does not exist."
  - `exists` true and `empty` true: "The folder is empty."
  - `exists` true and `empty` false: "The folder is not empty. Arbareto deleted and moved no file." A canceled clone that left files shows this text.
  - A result without `exists` and `empty`: "The folder state is unknown."
- Mark resolved shows "Marking resolved" while it runs and "File marked resolved" after `succeeded`. A running `sync` shows the FR-002 step text.
- The stage bar button of a Conflicted entry with the decision `resolve` reads "Mark resolved (Space)", and Space runs it.
  - The status area heading is "Mark resolved details". The refusal sentence is "Mark resolved is unavailable: <reason text>". The `missing` reason text is "The working file of this conflicted path is missing."
- Pull mode row (FR-027, FR-057): a notice row after `integration: mode-required`.
  - Text: "The branch and its upstream have diverged. Choose Rebase or Merge for this pull. Arbareto does not change the Git configuration."
  - Buttons "Rebase", "Merge", and "Cancel". Rebase gets focus only when the focused element is no input, textarea, or contenteditable element. Escape and Cancel remove the row and send nothing. A choice sends `reviewSync {action: "integrate", mode}`, and no confirmation follows.
  - The status bar shows "Pull fetched. Choose Rebase or Merge for this pull."
  - A succeeded pull or integrate with `modeSource` shows "Pull completed. <source> selected the mode." The sources are `payload` "The choice for this pull", `branch` "branch.<branch>.rebase", `pull` "pull.rebase", and `pull-ff` "pull.ff". A null `modeSource` shows "Pull completed".
- Conflict row (FR-030, FR-042 to FR-045): the row replaces the blocking row for `merging` and `rebasing`. It sits after the Connect in a terminal row (tasks.md exception 2026-10-17).
  - It shows the 001 first sentence without "finish it outside Arbareto".
  - While `merging` or `rebasing`, the toolbar and the hunk and file controls give the reason "A merge or a rebase is in progress. Finish it with Mark resolved and the actions in the Notices band." Every other state that is not `normal` keeps the 001 reason "Arbareto blocks changes until the Git operation ends outside Arbareto. Then select Refresh (F5)."
  - Buttons "Abort…", "Continue", and "Skip…" for `rebasing` only. The Skip tooltip reads "Skip leaves the current commit out of the rebased branch."
  - With unmerged entries, the Continue reason is "Continue is unavailable while 1 file is unmerged. Mark it resolved first." or "Continue is unavailable while <n> files are unmerged. Mark them resolved first."
  - A refused review hides the refused action until the operation state or HEAD changes.
  - `rebase-exec` hides Continue and Skip. The row shows the remedy text and the command with Copy command. Without a remedy, the row shows "Continue and Skip are unavailable: rebase-exec".
  - `no-skip-commit` shows "Skip is unavailable: Git names no commit at this rebase stop."
  - `unknown-operation` shows the 001 `unknown` row text and no action.
  - Another reason shows "<action name> is unavailable: <reason>".
  - Abort confirmation: the title "Abort the merge?" or "Abort the rebase?". The text "Git returns the branch, the index, and the working files to their state before the merge." or "… before the rebase." A merge adds "Git can fail to restore uncommitted changes from before the merge." Buttons "Abort merge" or "Abort rebase", and "Cancel".
  - Skip confirmation: the title "Skip this commit?". The text "Skip leaves commit <short ID> out of the rebased branch." Then the short ID and the subject, or the ID only for a null subject. Then "Git discards the index and working-file changes of this step." Buttons "Skip commit" and "Cancel".
  - An abort review without `plan.operationState`, or a skip review without `plan.skippedCommit`, starts nothing. The status bar shows "<action name> did not start: the review is incomplete."
- The 001 repository menu (001 plan.md "Compact token system") gains "Clone…" after "Recent repositories" and "Settings…" after "Select Git".
- Clone panel (FR-046 to FR-050, FR-054): a non-modal panel in the main area. "Clone…" in the start view and in the repository menu opens it. Escape and "Close clone panel" close it.
  - Heading "Clone repository". Fields "Remote URL" and "Destination folder". Button "Clone".
  - Only under plink: the checkbox "Pick a PuTTY key file at the start" with the note "Arbareto does not save this key file."
  - Unavailable reasons: "Enter the remote URL.", "Enter the destination folder.", and "The clone settings are still loading…".
  - The separator of `suggestCloneName` is `\`, because the Windows shell checks a destination by the 001 Windows rules or the §11 WSL route (contract Δ3 `clone`). A macOS or Linux shell must state its own separator.
  - A failed `readSyncSettings` shows "The clone settings did not load: <code>." The suggestion then has no parent, and the panel offers no key file. Connect in a terminal follows only the `connectTarget` field of the clone result (data-model §11).
  - A running clone shows "Cloning into <folder>…" with Cancel and the percentage. `<folder>` is the destination of the start. After Cancel, "Cancel requested" shows.
  - Until the first progress event gives the operation ID, Cancel is unavailable with the reason "Cancel is available after the clone starts."
  - While a clone runs, Escape and "Close clone panel" do not close the panel. The line "The clone is running. Select Cancel to stop it, then close the panel." shows.
  - The end line is "Clone canceled", "Clone did not complete: <code>", "Clone did not start: <code>", or "State unknown", as the 001 status texts.
  - `DESTINATION_NOT_EMPTY` by reason: `not-empty` "The destination folder is not empty: <path>", `file` "The destination is a file: <path>", `other` "The destination is not a folder: <path>".
  - `PUTTY_UNAVAILABLE`: "<program> is not available: <path> (<reason>)". The program names are "plink", "Pageant", and "PuTTYgen".
  - The folder state text follows, except after `DESTINATION_NOT_EMPTY`. Then the output tail and the remedy with Copy command follow.
  - The URL shows in its field. User information of the URL never shows. The remedy and the output tail can name the URL without its user information (contract Δ3 "Remedies").
- Settings panel (FR-032 to FR-037): a non-modal panel in the main area. "Settings…" in the repository menu opens it. Escape and "Close settings" close it. Heading "Settings". Feature 004 moves its content into the Settings view (004 O-7).
  - While `readSyncSettings` runs: "The settings are still loading…". A failed read: "The settings did not load: <code>." A failed change: "The setting did not change: <code>.", or the `PUTTY_UNAVAILABLE` text.
  - Group "SSH client" with "Git's own configuration" and "PuTTY (plink)". The note reads "PuTTY applies only to Windows repositories. A WSL repository uses the SSH setup of its distro."
  - "PuTTY (plink)" without a plink program opens the plink picker first. A canceled picker keeps the setting.
  - "Plink program": the path or "Not set", with "Choose plink…" and "Clear plink". While the client is "PuTTY (plink)", "Clear plink" is unavailable with the reason "Select Git's own configuration before you clear the plink program." (FR-033).
  - An arrow key in the SSH client group never opens the plink picker. Only a click or Space on "PuTTY (plink)", or "Choose plink…", opens it.
  - Each `programs` entry shows "<program>: <path>", plus "Not available" when `present` is false.
  - "Generate or convert a key". Without a plink program, its reason is "Choose the plink program first." After success, "PuTTYgen started." shows.
  - "Key files for this repository": one row for each remote with a saved key file or a proposal. A row shows the remote, the path or "No key file", "Choose key file for <remote>…", and "Clear key file for <remote>".
  - A proposal shows "Git Extensions setting: <path>". It comes from the last `readTrust` entry `remote.<name>.puttykeyfile` with a value, because the last value of a single-valued key wins (git-config(1)).
  - "Add a key file for another remote": the field "Remote" and the button "Choose key file…". An empty field gives the reason "Enter the remote name." The shell checks the remote name.
  - Without a repository: "Open a repository to set its key files."
  - "Default clone folder": the path or "Not set", with "Choose default clone folder…" and "Clear default clone folder".
- Connect in a terminal (FR-034, O-10):
  - A `sync` whose result holds `connectTarget: true` shows a notice row. It reads "<action name> did not complete with PuTTY (plink)." with "Connect in a terminal" and "Dismiss notice". The row names no cause.
  - A failed clone whose result holds `connectTarget: true` shows "Connect in a terminal" in the clone panel.
  - Results: "The terminal opened.", the `PUTTY_UNAVAILABLE` text, or "Connect in a terminal did not complete: <code>".
- Skills for the implementer: `arbareto-ux`, `vercel-react-best-practices`, `web-design-guidelines`, and `shadcn` with the version that tasks.md pins.

### D13 WSL

- New wrapper modes: `remote` (no extra export) and `integrate` (`GIT_EDITOR=:`) in `wsl-process.json`. WSLENV stays empty, so no PuTTY variable reaches Linux. The settings say so (FR-032).
- `setsid --wait` removes the terminal, so SSH and credential prompts fail at once inside the distro.
- The anchor CPU-time sum is the activity signal. The 001 §12 process-end rule runs before reconciliation.
- Clone into a WSL path: the §11 route, the distro start, and the Git-per-distro approval of `chooseRepository`. Then `wslFiles` mode `destination` for FR-047 and FR-050.
- `readTracking` costs one `wsl.exe` start.

### D14 Tests and fixtures

- No network: local bare remotes as paths, a local `git http-backend` with Basic sign-in on 127.0.0.1, a local `git daemon` on 127.0.0.1, and a local SSH server (O-5). An access hook counts `git daemon` service requests; no log text decides. Each test uses an owned `GIT_CONFIG_GLOBAL`. The tests never set `protocol.file.allow`, because the `remote` policy keeps Git's default.
- Oracles: Git's own command on a copy. SC-001 and SC-002 compare refs, the index, working bytes, and operation state. Commit OIDs differ by time, so trees and parents decide.
- Credentials (SC-005): a URL with a password and a test credential helper. The test scans every result, progress event, log entry, remedy, and output tail for the secret bytes.
- Configuration (SC-006): the system, global, and local files before and after, byte for byte. In Sandbox runs, the PuTTY registry key too.
- Mutation tests copy the 001 control rule: one control mutation must turn each oracle red.
- Each new test file adds its line to `tests/groups.json`. Timing tests go into `serial`.

### Invariants

| Invariant | Evidence |
|---|---|
| `protocol.file.allow` defaults to `user`, so `GIT_PROTOCOL_FROM_USER=0` blocks local remotes. | git-config(1) `protocol.allow`; transport.c `get_protocol_config`; 001 §12 "Network policy" probes S6, S21 |
| `fetch --porcelain` prints `<flag> <old> <new> <local-ref>` on stdout. | git-fetch(1) OUTPUT; builtin/fetch.c |
| `push --porcelain` prints `<flag>\t<from>:<to>\t<summary> (<reason>)` with full ref names, a `To` line with an anonymized URL, and `Done`, also after a rejected push. The summaries are untranslated. | git-push(1) OUTPUT; transport.c `print_ref_status`, `transport_anonymize_url`; research R16 b |
| A lease refusal is `[rejected]` with "stale info". | transport.c `REF_STATUS_REJECT_STALE`; t5533 |
| `for-each-ref` track text is untranslated. | ref-filter.c `msgs` "Untranslated plumbing messages"; only builtin/branch.c and builtin/tag.c call `setup_ref_filter_porcelain_msg` |
| `%(push:remoteref)` is filled only with `remote.<name>.push` refspecs. | remote.c `remote_ref_for_branch` |
| `rev-list --left-right --count` prints left TAB right. | git-rev-list(1) `--count` |
| Pull runs `merge FETCH_HEAD`, rebases from the fork point, fast-forwards when it can, and stops on divergence without a configured mode. | builtin/pull.c `run_merge`, `run_rebase`, `get_rebase_fork_point`, `cmd_pull` |
| `merge --continue` runs `git commit` after a `MERGE_HEAD` check. Merge opens no editor without a terminal. | builtin/merge.c; `default_edit_option` |
| `GIT_SSH_COMMAND` runs through the shell and overrides `GIT_SSH` and `core.sshCommand`. `-batch` is automatic only for TortoisePlink. | connect.c `get_ssh_command`, `push_ssh_options`; PuTTY manual §7.4 |
| `pageant <key>` loads into a running Pageant. `--encrypted` defers the passphrase to Pageant. | PuTTY manual §9.3.1, §9.5 |
| Operation markers and their order. | `commands.ts:117`; `status.ts:260` (wt-status.c `wt_status_get_state`) |
| Network limits, stall notice, and Job I/O activity. | `git-runner.ts:69-73`; 001 §12 "Deadlines and Cancel"; Win32 `IO_COUNTERS` |
| Policies are data. Only `network` takes inactivity limits today. | `src/contracts/git-environment.json`; `process_requests.rs:2655` |
| File staging steps and blob proof. | 001 §4 "File staging"; `file-publish.ts:199-313` |
| Remedy quoting and URL redaction. | `remedy-command.ts:55`; `submodules.ts:146` |

## Reviewer defaults (O-1 to O-11)

- **O-1 Count source (FR-019 wording).** Reviewer default: `for-each-ref %(upstream:track,nobracket)`, the untranslated plumbing form, in one process. Alternative: one `rev-list` per branch, about 400 processes for SC-003, about 100 s in WSL. FR-019 and the spec Assumptions record it.
- **O-2 Only behind with `pull.ff=false`.** Git's pull makes a merge commit, although the branch can fast-forward. Reviewer default: follow Git. FR-027 and the spec Assumptions record it. The same default covers `merge.ff=false` without `pull.ff`: Git's pull runs `merge` with no ff option, and the merge makes a merge commit (research R16 e).
- **O-3 Merge message.** The app merges the counted remote-tracking ref. The message follows the feature 004 D5 rule: the `fmt-merge-msg` preview for the short remote-tracking name, passed as `--no-log -m`. It equals Git's own `git merge origin/main`, such as "Merge remote-tracking branch 'origin/main'", with the " into <branch>" suffix and the `merge.log` shortlog as Git writes them. The merge argument stays the full ref, so a tag of the same name cannot win. Git's pull writes "Merge branch 'main' of <url>". Reviewer default: accept, because it binds the merge to the counted commit. A conflict marker names the merge argument, so it differs from the label of Git's own pull. Accepted.
- **O-4 Fetch all and `skipFetchAll`.** Reviewer default: skip the remotes that `git fetch --all` skips. Git skips a remote when the last value of `remote.<name>.skipFetchAll` and `remote.<name>.skipDefaultUpdate`, taken over both names, is true (research R16 k).
- **O-5 SSH test server.** Reviewer default: test devDependency `ssh2`, if P0.3 shows that it runs under Bun. Else a WSL `sshd` when `openssh-server` is already installed in the distro. Else the SSH cases stay unverified. The project installs nothing; installing `openssh-server` with sudo is the user's step. Result (T007, research R21): `ssh2` 1.17.0 passed under Bun 1.4.3. T011 adds the test devDependency `ssh2` 1.17.0. User decision (2026-10-19): `bun install` must not build the optional `cpu-features` native addon, because the build needs a C++ toolchain. `ssh2` uses its JavaScript crypto without it. T011 adds `"trustedDependencies": []` to `package.json` in the same change. A defined list replaces the Bun default list, and an empty list allows no lifecycle scripts (Bun docs, "Lifecycle scripts"). After `bun install`, `node_modules/cpu-features/build` must not exist.
- **O-6 PuTTY 0.75 minimum** for `pageant --encrypted`. Reviewer default: yes. The shell reads the file version resource and refuses an older Pageant.
- **O-7 Pageant and PuTTYgen paths.** Reviewer default: the plink folder, with no extra picker.
- **O-8 `remote.<name>.puttykeyfile`.** It is repository-controlled. Reviewer default: the settings show it as a proposal only, and the app uses a key file only after the user saves it in the application settings.
- **O-9 and O-10 Connect in a terminal.** Reviewer default: `git ls-remote` through plink without `-batch`, because Git parses the URL. It is offered for every operation under plink whose network step failed and whose result carries `connectTarget`, because no signal says that Git used SSH. FR-034 and the spec Assumptions record it.
- **O-11 Several push URLs.** Reviewer default: refuse with reason `push-urls`.

Further reviewer defaults:
- Pull on an unborn branch refuses with reason `unborn`.
- A missing remote shows at the review, not in the toolbar state.
- Key files are keyed by `worktreeKey` and the remote name.
- The clone suggestion splits at `/`, `\`, and `:`.
- Lease subjects stop at 100.
- The count display bound is 10,000.

## Open items

- **Redacted key proposal.** Accepted display limit. `readTrust` redacts each entry key (contract §7 "URL user information"). A remote name that holds `://` and then `@` reaches the settings changed. The proposal then names another remote. The app uses no proposal before the user chooses a key file (O-8), so no key file reaches Pageant from it.
- **WSL clone process end.** Contract gap. The 001 §12 process-end fact runs in the context of a registered workspace, and a clone has none. So a WSL clone process without an exit status, after Cancel or a limit, gives the code only, without `{exists, empty}` (contract Δ3 `clone` step 6). A fix needs a process-end fact in the `clone` context. T075 records the result.
- Run the `exec` lines of a rebase todo after a trust question. This feature refuses Continue and Skip with `rebase-exec` and offers the terminal command instead (D7). Later work.

## Phases

### Batches

| Batch | Steps | Content |
|---|---|---|
| 0 | P0.1, P0.2, P0.3 | Fixtures and Git and PuTTY facts. Results go into research.md. |
| 1 | P1, P2, P3 part | Pure logic and contracts. The P3 policies, WSL modes, allowlist, Rust checks, marker kind, close prompt names, and the bridge calls. |
| 2 | P3 rest, P4 | PuTTY, clone context, and service core. |
| 3 | P5, P6 | Pull, conflict actions, Mark resolved. |
| 4 | P7, P8 | Clone and terminal; frontend A. |
| 5 | P9, P10 | Frontend B and C. |
| 6 | P11, P12 | WSL and packaged qualification. |

### Work packages, in run order

| WP | Agent | Files | Steps |
|---|---|---|---|
| WP0 | implementer | `specs/003-remote-sync/{plan.md, research.md, data-model.md, contracts/operations.md, quickstart.md}` | This plan. Then `/speckit-tasks` and `/speckit-analyze`. |
| WP1 | implementer-xhigh | `tests/git/remote-fixtures.ts`, `tests/git/remote-facts.test.ts`, `tests/support/http-remote.ts`, `tests/groups.json` | P0.1, P0.2 |
| WP2 | implementer-xhigh | `tests/support/ssh-server.ts`, `tests/windows/putty-facts.test.ts`, `tests/fixtures/ssh/*`, `scripts/windows/putty-tests.wsb` with its prepare script and README, `package.json` and `bun.lock` (only after O-5) | P0.3. Local Windows; Sandbox for registry cases. |
| WP3 | implementer | `src/git-service/{sync-commands,sync-parsers}.ts`, `src/contracts/{clone-name,file-action}.ts`, their tests | P1 |
| WP4 | implementer | `src/contracts/{operations,envelope,errors,limits,channel}.ts`, `git-environment.json`, `wsl-process.json`, `schemas/`, `tests/vectors/` | P2 |
| WP5 | implementer-xhigh | `src-tauri/src/{git_env,wsl,process_requests,ipc,settings,dialogs,close}.rs`, `src-tauri/src/{schema,lib}.rs`, new `src-tauri/src/putty.rs`, `src-tauri/build.rs`, `src-tauri/capabilities/main.json`, `src/frontend/bridge.ts`, `tests/contracts/bridge.test.ts` | P3. Local only. T026 and T029 run in batch 1. T027, T028, T030, and T031 run in batch 2. |
| WP6 | implementer-xhigh | `src/git-service/{tracking,sync-review,sync,trust,git-runner,session}.ts`, sync tests | P4 |
| WP7 | implementer-xhigh | `src/git-service/sync-integrate.ts`, one handler line in `session.ts`, tests | P5 |
| WP8 | implementer-xhigh | `src/git-service/{comparison,file-publish,hunk-publish,wsl-files}.ts`, `tests/git/mark-resolved.test.ts`, `tests/git/wsl-files.test.ts` | P6 |
| WP9 | implementer | `src/git-service/clone.ts`, two handler lines in `session.ts`, `tests/git/clone.test.ts` | P7 |
| WP10 | frontend-implementer (loads arbareto-ux, vercel-react-best-practices, web-design-guidelines, shadcn) | `src/frontend/{state/tracking.ts, sync/* (with PullSplitButton.tsx), app/Workbench.tsx, app/NoticeBand.tsx, refs/ReferencesSidebar.tsx, commit/CommitTray.tsx, history/HistoryView.tsx}`, `tests/contracts/sync-*.test.tsx` | P8 |
| WP11 | frontend-implementer | `src/frontend/{sync/PullModeChoice.tsx, sync/ConflictActions.tsx, app/NoticeBand.tsx, changes/ChangesPane.tsx}`, tests | P9 |
| WP12 | frontend-implementer | `src/frontend/{clone/CloneDialog.tsx, settings/SettingsDialog.tsx, app/RepositoryMenu.tsx, app/RepositoryStates.tsx, app/NoticeBand.tsx}`, tests | P10 |
| WP13 | implementer; the runs by scout, alone | `tests/wsl/sync-wsl.test.ts` | P11 |
| WP14 | implementer; the runs by scout | `tests/windows/{sync-packaged,sync-perf,no-network}.test.ts` | P12 |

Parallel pairs with disjoint files: WP1 and WP2, WP3 and WP4, WP5 and WP6, WP7 and WP8. These packages are not file-disjoint:
- `session.ts`: WP6, then WP7, then WP9.
- `app/NoticeBand.tsx`: WP10, then WP11, then WP12.
- `tests/groups.json`: every WP appends its lines. The orchestrator resolves merge conflicts.
- WP10 needs the 002 frontend (002 P6) merged before it touches `history/HistoryView.tsx`. Without it, WP10 leaves out the history labels, and a follow-up task adds them.

## Agent context

Spec Kit v1.0.12 in this repository has no `update-agent-context` script, so this step changes no file. The plan adds no technology that CLAUDE.md must name. A new README "Development" command comes only after it runs green. A CLAUDE.md change goes through `claude-md-management:claude-md-improver`.

## Complexity Tracking

No Constitution Check violation. The table stays empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
