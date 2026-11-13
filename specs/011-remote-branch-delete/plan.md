# Implementation Plan: Remote Branch Delete

**Branch**: `011-remote-branch-delete` | **Date**: 2026-11-06 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/011-remote-branch-delete/spec.md`, and the design plan of 2026-11-06 with its Git probes (local scratch).

**Related**: [research.md](research.md) | [data-model.md](data-model.md) | [contracts/operations.md](contracts/operations.md) | [quickstart.md](quickstart.md)

**Code base**: origin/main `65959ceb`. Line references cite `65959ceb` unless they name the branch `010-commit-menu` (`22cdcac9`).

**Mockup** (T002): approved by the user on 2026-11-06 (14 boards, eight decisions). Boards: the D12 list. Review page: https://claude.ai/artifact/MC4tBgvkN2fAnAuoLYAPFF (screenshots of the 14 boards; the board sources are in local scratch). Decisions: research R7 "Mockup review (T002)".

## Summary

A remote-tracking branch gets the menu item X1 (D13). The item deletes the branch on its remote with a Git lease. The local Delete dialog gets the check box X9 for the upstream remote branch. The delete is a new 003 sync action, `delete-remote-branch`. It reuses the push step, the `sync` trust class, Pageant, the stall notice, the remedies, and the connect target. One combined operation deletes the remote branch first, then the local branch.

Four facts drive the design (research R2 and R3):
- A stale lease prints the source field `(delete):<dst>`, not `:<dst>` (P8, P9). The current push parser matches only the argv refspec. So the parse also accepts the alias (D5).
- Without a lease, Git deletes a remote branch that moved after the last fetch (P11). Git also reports `[deleted]` for a branch that does not exist (P2). So every delete carries `--force-with-lease=<dst>:<expect>` (D5).
- A successful delete removes the remote-tracking ref and keeps the upstream config of local branches, which then show `gone` (P12).
- `symbolic-ref -q refs/remotes/<remote>/HEAD` names the default branch with no network read. It exits 1 with no output when the ref is absent or not symbolic (P13). So reviews stay offline (003 FR-041).

## Technical Context

**Language/Version**: The 001 to 010 versions stay: TypeScript `7.0.2`, Bun `1.4.4` (exact), Rust/Cargo `1.99.0`.

**Primary Dependencies**: No new package and no new Rust crate. The icons come from the installed free hugeicons set.

**Storage**: None. The feature changes repository data only through Git commands.

**Testing**: Bun tests in real disposable repositories with a local bare remote and Git oracles on a copy (`tests/git`). Contract tests and golden vectors (`tests/contracts`, `tests/vectors`). Cargo tests for the shell. Packaged tests through UI Automation and CDP (`tests/windows`). WSL tests on `Ubuntu-26.04` with Git 2.55 (`tests/wsl`).

**Target Platform**: Windows 11 x64 with WebView2 and Git for Windows (2.56.0.windows.2 on the reference PC). WSL2 repositories run the distro's Git. The Git floor stays 2.55.0.windows.3 on Windows (`admission.ts:9`) and 2.55.0 in WSL (`src/contracts/wsl-route.ts:12`).

**Project Type**: Local-first desktop application: Tauri 2 shell, compiled Bun Git service, React renderer.

**Performance Goals**: Spec SC-009a to SC-009e (D11). The user accepted the budgets on 2026-11-06, before any measured run.

**Constraints**: Every argument array starts with `--no-lazy-fetch` (001 contract §7). The push step runs under policy `remote` with `PROCESS_LIMITS.network`, `GIT_TERMINAL_PROMPT=0`, and the 15 s stall notice. The local writes run through `writeUpstream` (`sync.ts:307`). Every outcome comes from a porcelain field, a documented exit code, or a fresh read (spec SC-011).

**Scale/Scope**: One new sync action, one menu item, one dialog, one check box, and four new sync refusal reasons. The bounds stay: `SYNC_LEASE_COMMITS` 100, `DIAGNOSTIC_RETAINED_BYTES_PER_STREAM` 64 KiB, `SYNC_REFS_BYTES`, `SYNC_REFS_RECORDS`, and `APPROVAL_LIFETIME_MS` 60 s. No new limit constant.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Checked against principles I to IX of `.specify/memory/constitution.md` version 4.0.0 on `main` `65959ceb`, footer "**Version**: 4.0.0 | **Ratified**: 2026-09-28 | **Last Amended**: 2026-10-22".

| Principle | How the design meets it | Status |
|---|---|---|
| I. Preserve user data | The confirmation lists every commit that the delete removes here (D2, D3). The Git lease refuses a moved remote branch, so no unseen remote commit goes (D5, P8). Del opens the confirmation with Cancel first. The combined delete runs the remote part first, so a network failure changes nothing (D7). | Pass |
| II. TypeScript/Bun | The review, the run, and the outcome rules are TypeScript (D15). Rust changes only the close name and the started action (D9). | Pass |
| III. Validated boundaries | One typed payload with a zod schema and the `isRefName` rule before any Git process (D4 read 0). Every list has a bound (contract Δ5). | Pass |
| IV. Real Git verification | Every story test runs against a local bare remote and compares with Git's own commands on a copy (D16). | Pass |
| V. Untrusted repositories | No repository program runs before trust approval of the `sync` class (D9). URLs show redacted. The remote reason text shows as plain display text and never decides. | Pass |
| VI. Platform evidence | Packaged Windows tests for the item, the dialog focus, forced colors, text scale, and the budgets (WP7). WSL tests on `Ubuntu-26.04` (WP6). | Pass |
| VII. Accessible and measured | The item has a label, an icon, an accessible name, the key text, and a stated reason when unavailable (D1). The budgets were set before measurement (D11). | Pass |
| VIII. Locked dependencies | No new package and no new crate. | Pass |
| IX. One planning process | All artifacts stay in `specs/011-remote-branch-delete`. The contract lists only deltas. The earlier specs change only in WP8 (D14). | Pass |

No violation, so Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/011-remote-branch-delete/
├── spec.md
├── plan.md                 # This file
├── research.md             # Phase 0
├── data-model.md           # Phase 1
├── quickstart.md           # Phase 1
├── contracts/
│   └── operations.md       # Phase 1: deltas to the 001 to 010 contracts
├── checklists/
│   └── requirements.md
└── tasks.md                # Phase 2
```

### Source Code (repository root)

```text
src/
├── contracts/              # channel.ts (SYNC_ACTIONS, started action), envelope.ts (payload, plan, result), errors.ts (reasons), schemas/
├── git-service/            # sync.ts (runDelete), sync-review.ts (observeSync), sync-commands.ts, sync-parsers.ts,
│                           # workbench-review.ts and branch-ops.ts (re-exports only)
│                           # new: ref-facts.ts (side-effect-free facts), remote-delete.ts (observeRemoteDelete)
└── frontend/               # branches/{BranchActions.tsx,texts.ts}, sync/{ForcePushConfirm.tsx,useSync.ts}, app/Workbench.tsx,
                            # status/OperationStatus.tsx, keyboard/shortcuts.ts, trust/ask.ts
                            # new: branches/RemoteDeleteConfirm.tsx
src-tauri/src/              # close.rs (Mutation name), schema.rs (started-action test list)
tests/
├── contracts/              # new: remote-delete-contract.test.ts, remote-delete.test.tsx, trust-classes.test.ts
│                           # changed: sync-commands.test.ts, sync-parsers.test.ts, workbench-branches.test.tsx
├── git/                    # new: remote-delete.test.ts, remote-delete-local.test.ts, remote-delete-gone.test.ts
│                           # changed: pre-push.test.ts, sync-trust.test.ts, sync-credentials.test.ts
├── vectors/                # new: valid/remote-delete-*.json and invalid/remote-delete-*.json
├── wsl/                    # new: remote-delete-wsl.test.ts
└── windows/                # new: remote-delete-packaged.test.ts, remote-delete-perf.test.ts; changed: perf-fixtures.ts (fixture M-D)
```

**Structure Decision**: The three-part layout stays: renderer, Bun service, and shared contracts, with a thin Tauri shell. Shared code holds no Win32 FFI. Windows-only behavior stays in `src-tauri/src/` and `tests/windows/`.

## Design

This plan numbers its design sections by topic. The design plan of 2026-11-06 (local scratch) holds the same content in sections 0, 1, and A to I.

### Steps (riskiest proof first)

| Step | Files and symbols | Behavior change | Tests that prove it | Main risk |
|---|---|---|---|---|
| P0 Git facts | local scratch only (T001) | None. | P1 to P20 of research R2, plus U1 and U3, on the installed Git and in `Ubuntu-26.04`. | A newer Git changes a porcelain line. Then research, this plan, and the contract change first. |
| P1 Mockup | local scratch only (T002) | None. | User approval of the D12 boards. | The layout changes texts. D13 changes first. |
| P2 Contracts | `src/contracts/*`, `tests/vectors/` (WP2) | The channel admits the payload, plan, and result. | Schema tests and vectors (T003). | `Record<SyncAction, ...>` tables in the frontend break typecheck. WP2 adds the two one-line entries. |
| P3 Shell | `close.rs`, `schema.rs` (WP3) | The close prompt names a running remote delete. | Cargo tests (T005). | The generated Rust identifier (research R5 U4). Resolved by T005, see research R5 and R7 "Shell (T005)". |
| P4 Service | `ref-facts.ts`, `remote-delete.ts`, sync files (WP4) | US1 to US3 in the service. | SC-001 to SC-007 in `tests/git` (T006 to T012). | The parse misses the `(delete):<dst>` alias (P8). |
| P5 Frontend | `branches/*`, `sync/*`, `status/*`, `keyboard/shortcuts.ts` (WP5) | The item, Del, the dialog, the check box, and the outcomes. | Component tests per FR (T015, T016). | The 010 changes to `BranchActions.tsx` and `useSync.ts` (R7). |
| P6 WSL | `tests/wsl/remote-delete-wsl.test.ts` (WP6) | None (tests). | US4, SC-010. | A process stays in the distro after Cancel. |
| P7 Qualification | `tests/windows/remote-delete-*.test.ts` (WP7) | None (tests). | SC-008, SC-009a to SC-009e. | The focus return after the trust ask (research R5 U6). |

Each step writes its tests first.

### D1 Scope and entry points

- Remote-tracking row menu (`BranchActions.tsx:336-362`). Today the remote groups are `[integrate, create, [copy]]` (`:357`). New group 2: the existing 004 items Create branch here and Add worktree for this branch, then X1 (danger, trash icon `Delete02Icon`). Group 3 stays the existing Copy branch name item.
- History remote labels: `Workbench.tsx:784` `onLabelMenu` calls `branches.onRef("remote", ..., "menu")`. That call opens the same menu. 010 keeps this path. Its commit menu opens only when no label is active (010 FR-010, FR-015). So the label menu gets X1 with no extra code.
- Keyboard: `KEYS.delete` (`shortcuts.ts:182`) widens its scope from `["localBranchRow"]` to `BRANCH_ROWS` (`:174`). `act` (`BranchActions.tsx:320-334`) routes `delete` on a remote entry to the remote flow. The menu shows the existing key text of `KEYS.delete` for X1 (user decision Q2).
- Availability: `reasons(entry).delete` (`:301`) for a remote entry gives the existing `blockedReason`. That covers an operation in progress, a running mutation, and an unknown state. Every other refusal comes from the review.
- Local Delete dialog (`DeleteConfirm`, `:571-598`): X9 shows only when `entry.upstream` starts with `refs/remotes/` and `entryOf(entry.upstream)` is not null. It is unchecked by default. It does not show when the dialog has no token (`config-in-include`).
- The branch list skips symbolic refs, so no `origin/HEAD` row exists (`workbench-parsers.ts:58`).

### D2 Remote confirmation

- An alert dialog (Base UI `AlertDialog`, the 008 `RevertConfirm` pattern). Cancel has the first focus. No button is the default, so Enter alone never deletes.
- Content: X2, X3, then X4 with the commit list and X5, or X6. Then X7 with the warning icon. Buttons: X8 (danger) and Cancel.
- The commit list shows up to `SYNC_LEASE_COMMITS` (100) commits, then X5. Its accessible name is X30.
- The remote confirmation keeps this stronger look: the alert dialog, the warning icon, and X7. The local 004 dialog keeps its look (D3).
- In forced colors, the danger red goes. X2 and X8 state the danger in text.
- The list reuses the force-push list (`ForcePushConfirm.tsx:45-53`), exported as `LeaseCommits`: short ID and subject, `max-h-60` with its own scrollbar.
- A name that does not fit keeps its full text in the tooltip and the accessible name (arbareto-ux rule).

### D3 Local dialog with the check box

- The dialog stays the 004 `Dialog` with Cancel first (004 FR-018).
- Unchecked: the dialog shows the 004 plan (`T.onlyHere` or `T.noneLost`, and the reflog line). Delete runs the workbench token, as today.
- Checking starts a sync review `{ action: "delete-remote-branch", ref: entry.upstream, local: entry.ref }`. While it runs, the dialog shows X12 under the check box, and Delete is unavailable.
- Checked and reviewed: X10 or X11 shows. The list and X5 show when the count is above 0. The reflog line for the local tip follows (`T.reflogKeeps` or `T.noReflog` from `plan.local.reflogKeeps`). Then X7 shows. Delete runs the sync token.
- Checked and refused: the refusal text shows under the check box with `role="alert"`. Delete is unavailable while the box is checked.
- Unavailable Delete: the button stays visible. It is disabled and stays focusable. The reason shows under the check box. The dialog never hides the button.
- The commit list of the checked plan has the accessible name X30.
- Unchecking shows the 004 plan again and uses the workbench token.
- A trust ask for `push` can open from inside the dialog. The packaged test checks the focus return (R8, research R5 U6).

### D4 Review reads and bound facts (`reviewSync` `delete-remote-branch`)

Each read is local. No read contacts a remote. Order:

0. Payload rule before any Git process: `ref` starts with `refs/remotes/` and passes `isRefName`. `local`, when present, starts with `refs/heads/` and passes `isRefName`. Otherwise `INVALID_REQUEST`.
1. The 003 common reads (`sync-review.ts:400-420`): the trust listing and the `sync` gate, `invalidRemoteValue`, HEAD, the operation state, and `git remote`.
2. A state other than `normal` gives `OPERATION_IN_PROGRESS`, and `unknown` gives `unknown-operation` (the push rule of `sync-review.ts:446`). A detached or unborn HEAD does not refuse.
3. Mapping from the listing entries. `localNameOf(ref)` (`workbench-parsers.ts:419`) must give a name. `trackingRemotes(ref)` (`:428`) must give exactly one remote R. Then `dst = refs/heads/<name>`. The forward check `trackingOf(entries, R, dst) === ref` (`sync.ts:150`) must hold, because the Git push removes the ref of that forward mapping (transport.c `update_one_tracking_ref`). Otherwise `no-remote-branch`.
4. R must be in the `git remote` list (`remote-missing`). A mirror remote gives `mirror` (`sync-review.ts:114-117`).
5. `listRefs(ctx, ref)` gives the expect object ID. An absent ref gives `UNKNOWN_TARGET`.
6. `symbolic-ref -q refs/remotes/<R>/HEAD`. Exit 0 with one `refs/` line: a target equal to `ref` gives `default-branch`. Exit 1 gives `default-unknown`. Another exit gives `GIT_FAILED`. A broken line gives `MALFORMED_GIT_OUTPUT`.
7. With `local`: the current branch gives `current-branch`. `readWorktrees` and `heldElsewhere` give `other-worktree` or `head-unresolved`. `pushRecordArgs(branch)` (`sync-commands.ts:45`) gives `%(upstream)`. A value other than `ref` gives `not-upstream`. `deleteFacts` gives the local tip, `reflogKeeps`, `section`, and `config-in-include`.
8. `remote get-url --push --all -- R` must give exactly one URL (`push-urls`, O-11, `sync-parsers.ts:130`).
9. `remote get-url --all -- R`. `sameUrl` is true when that output equals the push URL output byte for byte (D8).
10. The commits that the delete removes from every ref here. Tips: `expect`, and with `local` also the local tip. Exclusions: `--exclude=<branch> --branches` with `local` (else `--branches`), `--tags`, and `--exclude=<trackingShort> --remotes`. `trackingShort` is the tracking ref without `refs/remotes/` (P14). Count with `rev-list --count`. List the first `SYNC_LEASE_COMMITS` (100) with subjects. Reuse the body of `leaseOf` (`sync-review.ts:186-210`) as a shared `commitsOf(ctx, countArgs, listArgs)`.

Refusals (texts in D13):

| Case | Code and reason | Where | Text |
|---|---|---|---|
| Operation in progress or a running mutation (renderer) | `blockedReason` | status bar, item reason | existing texts |
| Operation in progress (service) | `OPERATION_IN_PROGRESS`, or `SYNC_UNAVAILABLE` `unknown-operation` | status bar or check box | existing fallback of `refusalText` |
| Trust not approved | `TRUST_REQUIRED`, `TRUST_CHANGED` | ask once for `push`, then the refusal | existing trust flow |
| Default branch | `SYNC_UNAVAILABLE` `default-branch` | status bar or check box | X13 |
| Default branch unknown | `SYNC_UNAVAILABLE` `default-unknown` | status bar or check box | X14 |
| No exact remote branch mapping | `SYNC_UNAVAILABLE` `no-remote-branch` | status bar or check box | X15 |
| No remote-tracking ref backs the branch | `UNKNOWN_TARGET` | status bar or check box | X17 |
| Upstream changed (combined) | `SYNC_UNAVAILABLE` `not-upstream` | check box | X16 |
| Local facts changed (combined) | `WORKBENCH_UNAVAILABLE` `current-branch`, `other-worktree`, `head-unresolved`, `config-in-include` | check box | existing `REASONS` texts (`texts.ts:91-106`) |
| Several push URLs, mirror, invalid config, missing remote | `SYNC_UNAVAILABLE` `push-urls`, `mirror`, `invalid-config`, `remote-missing` | status bar or check box | existing fallback |

`refusalText` (`texts.ts:109`) maps the `SYNC_UNAVAILABLE` reasons of this table as it maps `WORKBENCH_UNAVAILABLE` reasons today.

Binding (`SyncBinding`, compared in full at `sync` by `staleOf`, `sync.ts:561-571`):

- `payload`, `head`, `operationState`, `trust`, `remotes: [R]`.
- `destination`: `{ remote: R, ref: dst, trackingRef: ref, url, setUpstream: false, upstreamRebase: false, source: "tracking-ref" }`. `url` is the unredacted push URL and never leaves the service (`sync-review.ts:30`).
- `lease`: `{ trackingRef: ref, expect, count, commits }`.
- `local` (combined): `{ ref, oid, onlyHere, reflogKeeps, section, worktrees }`. `worktrees` is the listing digest, as `DeleteBound` holds it (`branch-ops.ts:188`).
- `sameUrl`.

Plan (`planOf`): `remotes`, `destination` with the redacted URL, `lease`, and `local: { ref, oid, reflogKeeps }`. The token lives 60 s (`APPROVAL_LIFETIME_MS`).

### D5 Argument arrays and parsers

`L` stands for `--no-lazy-fetch`.

- `sync-commands.ts` `pushArgs` (`:86-90`) takes `branch: string | null`. Null builds the delete refspec `:<dst>` and requires a lease, else it throws. The other options stay: `--porcelain --progress --no-recurse-submodules --no-follow-tags`. The delete array is `[L, "push", "--porcelain", "--progress", "--no-recurse-submodules", "--no-follow-tags", "--force-with-lease=<dst>:<expect>", "--", R, ":<dst>"]`.
- New `remoteHeadArgs(remote)`: `read("symbolic-ref", "-q", "refs/remotes/<remote>/HEAD")`, with `isRefName` on the built name.
- New `onlyTipsCountArgs(tips, branch | null, trackingShort, of)` and `onlyTipsListArgs(...)`: `rev-list [--count | --max-count=SYNC_LEASE_COMMITS] <tips> --not [--exclude=<branch>] --branches --tags --exclude=<trackingShort> --remotes`.
- New `fetchUrlArgs(remote)`: `read("remote", "get-url", "--all", "--", remote)`.
- New `lsRemoteArgs(remote, dst)`: `[L, "ls-remote", "--exit-code", "--", remote, dst]`.
- `sync-parsers.ts` `PUSHED` (`:83-88`) gains `["-", "deleted"]`. `PushStatus` (`:76`) gains `"deleted"`. The push `SUCCESS` set (`sync.ts:42`) stays unchanged, so a push never succeeds on a `-` line.
- `parsePushPorcelain` (`:108`) takes an optional `alias`. A line matches when its source:destination field equals `refspec` or `alias`. The delete passes `:<dst>` and `(delete):<dst>` (transport.c `print_ref_status`, remote.c `alloc_delete_ref`). Two matching lines give null.
- New `parseSymref(stdout)`: exactly one line that starts with `refs/` and ends with LF, else null.
- New `parseLsRemote(stdout, of)`: lines `<oid>\t<ref>\n`, exact parse, else null. A pattern matches a ref tail, so the gone fact needs an exact `<dst>` line (P15).

### D6 Run steps and outcome mapping (`sync`)

Steps:

1. The 003 steps: the own trust listing, the full new observation, `staleOf`, then token consumption (`sync.ts:510-518`).
2. `listRefs` before.
3. `pageant(R)` on a Windows repository (`sync.ts:249-255`).
4. The push: `pushArgs(R, null, dst, expect, of)` through `networkStep(..., "sync-push", ...)`. Policy `remote`, `PROCESS_LIMITS.network`, and the stall notice. Remedy: `& {git} --no-lazy-fetch -C {root} push --force-with-lease={lease} -- {remote} {refspec}`. A URL with user information gets the remedy as text only (`sync.ts:173-174`).
5. Parse: `parsePushPorcelain(stdout, ":<dst>", exit, "(delete):<dst>")`.
6. Lease re-read and gone recovery (D8), only when the push status is `rejected`, the review bound `sameUrl: true`, and no Cancel came.
7. With `local`, after `deleted` or `remoteGone`: the local writes `deleteRefArgs(branch, oid)` and, when `section`, `removeBranchSectionArgs(branch)` (`workbench-commands.ts:275-282`), through `writeUpstream`. It stops at the first nonzero exit and at Cancel (`sync.ts:310`). Before the first local write, the service reports the phase `sync-delete-local`. The status bar shows X28 for that phase.
8. Enter reconciling. Wait for the WSL process-end fact (`processEnded`). Read refs, HEAD, the operation state, and the trust listing.
9. Outcome (table below).

`expected` is the listing before, without `ref` after `deleted` or `remoteGone`. After local writes that all exited 0, it is also without the local ref.

`localNotDeleted` comes only from the fresh ref listing after the run. Exit codes do not set it (data-model §4).

| Push line and steps | Event | Result fields | Text |
|---|---|---|---|
| `deleted`; local writes done, or none | `intended-effects-confirmed`, or `differing-effects` when other refs or HEAD changed | `push.status` `deleted` | X20, or X21 when combined |
| `deleted`; the fresh listing still holds the local ref after a failed local write or Cancel | `failed-with-effects` | `localNotDeleted: true` | X24 |
| `deleted`; the local ref is gone, but the section removal failed, or Cancel stopped it | `failed-with-effects` | `push.status` `deleted`, no `localNotDeleted` | the 003 line "{name} did not complete and left effects: {code}" |
| `rejected`; the D8 re-read shows a remote value other than `<expect>`, or a gone fact without `remoteGone` | `no-effects`, failed, `PUSH_REJECTED` | `reason: stale-lease`; `remedy` X27 | X22, plus X25 when combined |
| `rejected`; the D8 re-read equals `<expect>`, fails, or does not run (user decision 2026-11-11) | `no-effects`, failed, `PUSH_REJECTED` | `reason: rejected`, `reasonText` (display only), no `remedy` | E5, plus X25 when combined |
| `rejected` and `remoteGone`; local writes done, or none | `intended-effects-confirmed` | `remoteGone: true` | X23, then X26 when combined |
| `rejected` and `remoteGone`; the fresh listing still holds the local ref after a failed local write or Cancel | `failed-with-effects` | `remoteGone: true`, `localNotDeleted: true` | X23, then X25 |
| `rejected` and `remoteGone`; the local ref is gone, but the section removal failed, or Cancel stopped it | `failed-with-effects` | `remoteGone: true`, no `localNotDeleted` | the 003 line "{name} did not complete and left effects: {code}" |
| `remote-rejected` or `remote-failure` | `no-effects`, failed, `PUSH_REJECTED` | `reason`, `reasonText` (display only) | E2, plus X25 when combined |
| `none` with a nonzero exit, or a refused start | `no-effects`, failed, `GIT_FAILED` (or the runner code) | `remedy` with the command; the connect target | E3 with the remedy, plus X25 when combined |
| Canceled, no ref changed | `no-effects`, canceled | `remedy` `CANCELED_PUSH_TEXT` (`sync.ts:36`) | E4, plus X25 when combined |
| Any failure with a changed ref | `failed-with-effects` | as above | as above |
| A process at its deadline | `no-effects`, failed, with the DEADLINE cause | none | E3 |
| Exit 0 with no matching line | `no-effects`, failed, `MALFORMED_GIT_OUTPUT` | none | E3 |
| An after-run read failed | `reconciliation-read-failed`, unknown | the marker stays (`sync.ts:245-246`) | existing unknown-outcome text |

- `PushResult` for this action: `oldObjectId` and `newObjectId` are the tracking ref before and after. `lease` is true. `upstreamWritten` and `upstreamNotSet` are false.
- The network failure, the missing credential prompt, and a declined pre-push hook share one outcome. Git reports the three only through message text, and message text never decides (CLAUDE.md "No heuristics"). The stall notice of 001 FR-051 covers a hidden prompt.

### D7 Combined order and partial failure

Order: remote first, then local.

- A network or credential failure is the most likely failure. With remote first, both branches stay unchanged after it, so the same dialog can try again.
- A local failure after a remote success loses no commit. The local branch keeps its tip and its reflog. `update-ref` with the bound tip refuses a moved branch (004 FR-019).
- Local first would leave the remote branch after a network failure. The user would then need the remote row to finish.
- Combined count: one `rev-list` over both tips with both exclusions (D4 read 10). Two separate counts miss the commits that only the two refs hold together. The P14 combined form gives 2 where the local-only count gives 0.

| Remote | Local | Event | Text |
|---|---|---|---|
| deleted | deleted | intended | X21 |
| deleted | failed, or not run after Cancel | failed-with-effects | X24 |
| failed, rejected, stale, or canceled | not run | no-effects | the failure text plus X25 |
| gone, stale ref removed | deleted | intended | X23 then X26 |
| gone, stale ref removed | failed, or not run after Cancel | failed-with-effects | X23, then X25 |

### D8 Lease re-read and gone recovery (user decisions 2026-11-06, design option Q1 a, and 2026-11-11)

- Trigger: the push status is `rejected`, and the review bound `sameUrl: true`. The `(delete):<dst>` alias does not decide (user decision 2026-11-11).
- Stale fact: the re-read shows a remote value other than `<expect>`, or no remote ref. A re-read that equals `<expect>`, fails, or does not run gives reason `rejected` (003 Δ9, T092).
- Step: `ls-remote --exit-code -- R <dst>` through `networkStep`, with the same policy, Pageant, and remedies as the push.
- Gone fact: exit 2, or exit 0 with no exact `<dst>` line (`parseLsRemote`). An exact `<dst>` line with a value other than `<expect>` means the branch moved, so the stale outcome stays. An exact line equal to `<expect>`, another exit, a parse failure, or Cancel gives reason `rejected`.
- Cancel: the re-read does not start after Cancel, as in the push (`sync.ts` `!signal.aborted`).
- Removal: `update-ref --no-deref -d <ref> <expect>` as one more write through `writeUpstream`. Exit 0 marks `remoteGone`. A nonzero exit keeps the stale outcome. The expect value makes Git refuse a ref that changed after the review.
- A different `pushurl` skips the check, because the fetch URL could name another repository than the push URL. The reason is then `rejected`, with E5 and no remedy.

### D9 Sync action, trust, and shell

- The push needs Pageant (`sync.ts:249`), the push remedies, the connect target (`sync.ts:256-258`), the `remote` policy, and the network stall handling. Only the syncer has them. Workbench steps run under policy `integrate` (`workbench-review.ts:369`) with no Pageant step. So the delete is a sync action.
- Trust: the `sync` class covers `pre-push`, `reference-transaction`, and the transport programs (`trust.ts:673-675`, `:374-392`, 003 FR-009). The local writes can run `reference-transaction` only. Every workbench event is a sync event (`trust.ts:673-689`). Every integration kind with `workbench: true` has `sync: true` (`trust.ts:394-409`). So `approvalRequired.workbench` implies `approvalRequired.sync` (`trust.ts:1475-1476`), and the one `sync` gate covers the combined operation. T008 asserts this implication.
- The trust ask names `push`: `SYNC_TRUST` (`ask.ts:23`) gains `"delete-remote-branch": "push"`. No new `TRUST_ACTIONS` value, so `dialogs.rs` stays unchanged.
- Shell: `src-tauri/src/close.rs` `Mutation` (`:83-100`) gains `DeleteRemoteBranch`. The sync mapping (`:149-159`) gains `A::DeleteRemoteBranch`. The kind list (`:194-202`) gains it under `StartedKind::Sync`. The name table (`:230-245`) gains X18. `src-tauri/src/schema.rs:2084-2094` started-action test list gains `"delete-remote-branch"`. The phase `sync-delete-local` carries no counter, so `progress` in `schema.rs` (`:382`) refuses a counter on it. The no-counter phase test in `schema.rs` gains `"sync-delete-local"`.
- Network policy: 003 FR-041 gains this action (D14). The review stays offline, so `ls-remote --symref` is not used. A network read in a review would break 003 FR-041 and SC-013.

### D10 WSL parity (feature 006)

- The same argument arrays run through the 006 route. No new wrapper mode.
- The run waits for the process-end fact before any read (`processEnded`, 001 contract §11).
- New test file `tests/wsl/remote-delete-wsl.test.ts` on `tests/wsl/workbench-wsl-harness.ts`. Distro `Ubuntu-26.04` (Git 2.55, the WSL minimum). The bare remote lies inside the distro. Hash and compare inside the distro. The file runs alone. Cases: success, stale lease, default branch refusal, combined delete, gone recovery, and Cancel with no process left in the distro.

### D11 Budgets (constitution VII)

The user accepted these budgets on 2026-11-06, before any measured run. The runs use the packaged build, warm, on the agreed hardware. The warm-up run counts for the every-run bound, never for the median (001 spec.md:95, 010 plan D9).

| SC | Measure | Fixture | Samples | Budget |
|---|---|---|---|---|
| SC-009a | Input to menu paint on a remote-tracking row (right-click and Shift+F10) | M-D | 40 per run (20 + 20, distinct rows) | p95 at most 100 ms; every open at most 500 ms (001 SC-005) |
| SC-009b | Item activation, or check-box click, to the confirmation with its plan or refusal | M-D, target `d01` with 150 commits that only it holds | 10 warm + 1 warm-up per form (remote, combined) | median at most 500 ms; every run at most 1 s |
| SC-009c | Delete button to outcome text, remote only, local bare remote over a file path | M-D | 10 + 1 | median at most 1.5 s; every run at most 3 s |
| SC-009d | Delete button to outcome text, combined | M-D | 10 + 1 | median at most 2 s; every run at most 4 s |
| SC-009e | Input response during each SC-009c and SC-009d run (typing in the history filter) | M-D | at least 20 inputs per run | 001 SC-005 targets |
| record | CPU seconds and process-tree private bytes per run | M-D | the same runs | recorded, no budget |
| record | WSL times of SC-009b to SC-009d | `Ubuntu-26.04`, bare remote in the distro | 10 + 1 | recorded, no budget |
| cold | The first run after a new app start, per measure SC-009a to SC-009d | M-D | 1 per measure | 2 times the warm budget: the median budget, and the p95 budget for SC-009a |

- Fixture M-D: fixture M (`tests/windows/perf-fixtures.ts:31`: 5,000 commits, 10,000 files, 32 refs) plus a local bare remote over a file path. It holds 64 branches `d01` to `d64`, fetched, and 11 run branches per run measure. `d01` holds 150 commits that no other ref holds. Each timed run deletes its own branch, so the setup creates the branches again outside the timed part.
- Probe basis on the reference host, through Git Bash: a push delete took 259 to 441 ms (10 runs). Three review reads took 276 to 430 ms (10 runs). In WSL `Ubuntu-26.04`: 16 to 18 ms and 11 to 15 ms.
- Git Bash adds MSYS process cost. The service starts Git directly. The review starts about 12 Git processes. The run starts about 8, plus the reconcile reads.
- Keep the perf fixture cache safe from `%TEMP%` clean-up.

### D12 Mockup first (arbareto-ux skill §4)

- The mockup is static HTML in local scratch, with sample data marked as sample. It picks the icons from the free hugeicons set.
- Boards:
  1. Remote-menu: the sidebar remote-tracking row menu with X1 and the key text in group 2.
  2. Label-menu: a History remote label with the same menu.
  3. Remote-confirm-lost: 3 listed commits and X5 for 147 more commits.
  4. Remote-confirm-none: count 0 with X6.
  5. Remote-confirm-long: a long remote and branch name, with the tooltip.
  6. Local-unchecked: the 004 dialog with the unchecked X9.
  7. Local-loading: checked, X12.
  8. Local-checked: the combined plan.
  9. Local-refused: checked, X13 under the box, Delete unavailable.
  10. Status-running: X19 with Cancel.
  11. Status-outcomes: X20 to X24, X26, and E3 with a remedy command.
  12. Forced colors: boards 3 and 8.
  13. Dark theme, compact density: boards 3 and 8.
  14. Comfortable density: boards 1 and 6.
- The user approves the boards before any code task (T003 onward) starts. A changed text goes into D13 first.

### D13 Texts

`src/frontend/branches/texts.ts` holds the new renderer texts. `OperationStatus.tsx` holds the status texts. Rust `close.rs` holds X18. Every visible text of this feature is in this section once. The mockup confirms the layout.

- `{tracking}` is the short remote-tracking name (`shortRef`, such as `origin/feature`). `{dst}` is the full remote ref, such as `refs/heads/feature`. `{name}` is `{dst}` without `refs/heads/`. `{branch}` is the local branch name. `{remote}` is the remote name. `{n}` is a count.
- With the default refspec, `{tracking}` equals the `<remote>/<name>` of the user decision.

New texts:

| ID | Where | Text |
|---|---|---|
| X1 | menu item | Delete remote branch… |
| X2 | dialog title | Delete the remote branch {tracking}? |
| X3 | dialog | Git deletes `{dst}` on {remote}, and the remote-tracking branch {tracking} here. |
| X4 | dialog, count above 0 | {n} commits are on no other branch, tag, or remote-tracking branch here: (n = 1: "1 commit is on no other branch, tag, or remote-tracking branch here:") |
| X6 | dialog, count 0 | Another branch, tag, or remote-tracking branch here holds every commit of {tracking}. |
| X7 | dialog warning | Other people can lose work. The delete stops if {tracking} changed since the last fetch. |
| X8 | danger button | Delete remote branch |
| X9 | check box | Also delete the remote branch {tracking} |
| X10 | local dialog, checked, count above 0 | {branch} and {tracking} have {n} commits that no other branch, tag, or remote-tracking branch has. The delete loses them. (n = 1: "commit") |
| X11 | local dialog, checked, count 0 | Deleting {branch} and {tracking} loses no commit. |
| X13 | refusal | {tracking} is the default branch of {remote}. Arbareto does not delete the default branch of a remote. |
| X14 | refusal | Arbareto cannot tell the default branch of {remote}. Fetch {remote}, or run git remote set-head {remote} --auto, then try again. |
| X15 | refusal | No fetch refspec of exactly one remote maps {tracking} to a remote branch, so Arbareto cannot name it. |
| X16 | refusal | {tracking} is no longer the upstream of {branch}. Close this dialog, then try again. |
| X17 | refusal | {tracking} no longer exists here. |
| X18 | status bar name, close prompt | the text of X8 |
| X19 | status bar step | Deleting the remote branch on {remote}… |
| X20 | outcome | Deleted the remote branch {tracking}. |
| X21 | outcome | Deleted {branch} and the remote branch {tracking}. |
| X22 | outcome | {tracking} changed on {remote} since the last fetch, so Git deleted nothing. Fetch {remote}, then try again. |
| X23 | outcome | {remote} lists no branch {name}. Arbareto deleted the remote-tracking branch {tracking}. |
| X24 | outcome | Deleted the remote branch {tracking}. {branch} stays. |
| X25 | outcome suffix | {branch} stays. |
| X26 | outcome, combined after X23 | Deleted the local branch {branch}. |
| X27 | details area remedy of X22 | Text: "This command fetches {remote} and removes the remote-tracking branches whose remote branch is gone." Command: `& {git} --no-lazy-fetch -C {root} fetch --prune -- {remote}` |
| X28 | status bar step, local delete | Deleting {branch}… |
| X29 | details heading | Delete remote branch details |
| X30 | accessible name of the commit list | Commits only on {tracking} |

- X24 equals X20 followed by X25.
- A status-bar line that does not fit keeps its full text in a tooltip and in its accessible name (arbareto-ux rule).

Existing texts that this feature reuses unchanged:

| ID | Where | Source | Text |
|---|---|---|---|
| X5 | dialog, list end | force-push list (`ForcePushConfirm.tsx:45-53`) | and 1 more commit / and {n} more commits |
| X12 | local dialog, review runs | existing loading text | Loading… |
| E1 | key text of X1 | `KEYS.delete` (`shortcuts.ts:182`) | Del |
| E2 | outcome, `remote-rejected` or `remote-failure` | `OperationStatus.tsx` `REMOTE_REJECTED` | Rejected by the remote, then `: <reasonText>` |
| E3 | outcome, failure | `OperationStatus.tsx`, `STEP_REMEDY_TEXT` and the command (`sync.ts:34`) | {name} did not complete: {code}. |
| E4 | outcome, canceled | `OperationStatus.tsx:397` | {name} canceled. The remote can hold this push. Fetch to see the remote state. |
| E5 | outcome, `rejected` without a stale fact (user decision 2026-11-11) | 003 plan D5 (T092), `OperationStatus.tsx` `pushRejected` | {name} did not complete: PUSH_REJECTED rejected: {reasonText} |

The refusals `blockedReason`, `REASONS` (`texts.ts:91-106`), the trust flow, and the unknown-outcome text keep their existing texts. This feature adds no copy of them.

### D14 Earlier spec lines and docs

WP8 (T023) amends the earlier specs in the style "Note (2026-11-06, user decision): …". T023 starts only after 010 merges into `main`. 010 also amends 001 FR-027, 003 `:226`, 004 `:349`, and 004 FR-014.

- 001 FR-027 (`specs/001-desktop-qualification/spec.md:424`): after the 008 and 010 amendments, add "Amended by feature 011 (2026-11-06, user decision): the delete of a remote branch with a lease is allowed behind its confirmation." Cite 011 FR-006 and FR-007.
- 003 Scope Boundaries (`specs/003-remote-sync/spec.md:226`): "deletion of remote branches" goes. The delete of one remote branch comes with 011. Push of several branches and of tags stays excluded.
- 003 FR-041 (`specs/003-remote-sync/spec.md:261`): add the action X18 of feature 011 to the network actions.
- 003 FR-025 (`specs/003-remote-sync/spec.md:283`): no change. 011 FR-007 applies the same lease rule to a delete.
- 004 Scope Boundaries (`specs/004-workbench-ux/spec.md:349`): "Exclude remote branch delete" goes. Remote management stays excluded.
- 004 FR-014 (`specs/004-workbench-ux/spec.md:407`): a remote-tracking branch also offers X1 with Del.
- 004 FR-017 to FR-019 (`specs/004-workbench-ux/spec.md:410-412`): with the 011 check box, the FR-018 count covers both refs. FR-019 binds the local part.
- 004 plan D16 "Branch menu groups" (`specs/004-workbench-ux/plan.md:570`): group 2 of a remote-tracking branch gains X1.
- 007 spec `:19` and FR-006 (`:159`): feature 011 is a v0.1.0 blocker. The 007 files are not on `main` at `65959ceb`. They exist on the branch `007-first-release`. T023 amends them where 007 lives at that time.
- README "Features" (`README.md:27`): one line for the user-visible change.
- CHANGELOG 0.1.0 section: one line for the user-visible change. `CHANGELOG.md` is not on `main` at `65959ceb`. It exists on the branch `007-first-release`. T023 amends it where it lives at that time.

### D15 Service and frontend modules

- Side-effect-free fact module: `observeSync` (`sync-review.ts:400`) must call `deleteFacts` (`branch-ops.ts:163`) and the worktree reads (`workbench-review.ts:146-184`). `branch-ops.ts` calls `registerWorkbenchAction` at load time. An import chain workbench-review, sync-review, branch-ops, workbench-review would run that call while `handlers` (`workbench-review.ts:114`) is still uninitialized. That gives a temporal-dead-zone ReferenceError.
- So move `refTarget`, `revCount`, `readWorktrees`, `unresolvedRefusal`, `heldElsewhere`, `unavailable`, and type `Refused` from `workbench-review.ts:65-184` into a new `src/git-service/ref-facts.ts`. Move `DeleteFacts`, `deleteFacts`, `headReflogKeeps`, and `localSectionKeys` from `branch-ops.ts:57-78` and `:154-178` there too. The new module has no load-time side effects. `workbench-review.ts` and `branch-ops.ts` re-export the moved names, so no other importer changes.
- Review module: new `src/git-service/remote-delete.ts` (no load-time side effects) with `observeRemoteDelete`. `sync-review.ts` `observeSync` calls it for the new action, after the remote list (`:419`) and before the push reads (`:444`). `sync-review.ts:537-544` passes `worktree` into the refusal value. `planOf` (`:499`) adds `local`. `leaseOf` (`:180-211`) splits into the tracking read and a shared `commitsOf`.
- Run: `src/git-service/sync.ts` gets `runDelete(entries)` inside `createSyncer`, next to `runPush` (`:417`). It reuses `pageant` (`:249`), `networkStep` (`:278`), `remedyOf` (`:259`), `writeUpstream` (`:307`), `processEnded` (`:327`), and `keepTarget` (`:256`). The shared after-run reads of `runPush` (`:461-476`) move into one helper that both use. The dispatch at `:519-524` gains the action. The forward check `trackingOf` (`sync.ts:150`) must give back the reviewed ref.
- Frontend: `src/frontend/branches/BranchActions.tsx`, `texts.ts`, and the new `RemoteDeleteConfirm.tsx`. `src/frontend/sync/ForcePushConfirm.tsx` exports the commit list of `:45-53` as `LeaseCommits`. `src/frontend/sync/useSync.ts` exports `review` and `startReviewed` (the current `start`, `:88-115`). `src/frontend/app/Workbench.tsx` passes them to `useBranchActions` (`:1776`). `src/frontend/status/OperationStatus.tsx` changes `syncStepText` (`:367`) and `syncOutcome` (`:392`), and `SYNC_NAMES` (`:135`) gains X18. `src/frontend/keyboard/shortcuts.ts:182` widens the scope. `syncStepText` maps the phase `sync-delete-local` to X28.
- Renderer state: the remote overlay `{ kind: "remote-delete", entry, plan, token }`, and the delete overlay field `remote: { checked, plan, token, error } | null` (data-model §7).

### D16 Tests and fixtures

- Oracle: the same Git commands on a copy (`git push --porcelain --force-with-lease=<dst>:<expect> -- <remote> :<dst>`, then `update-ref` and `config --remove-section`). Compare `for-each-ref` of the local repository and the bare remote, HEAD, and the config bytes by SHA-256.
- T009 (remote only). Each fixture compares with the oracle or asserts its code and reason:
  - Success. A name with a slash (P19). A branch with 150 commits that only it holds (count 150, list 100).
  - The remote moved after the fetch (stale; every remote commit stays). The remote branch is absent, and the `pushurl` differs (reason `rejected`, no re-read, P9, P16).
  - `receive.denyDeletes` (P3). The HEAD branch of a bare remote behind a stale local `origin/HEAD` (P4, remote rejected).
  - A non-bare remote with the branch checked out (P5). A remote pre-receive hook (P6). A local pre-push hook that declines (P7, after approval).
  - The default branch (refused, no network process). `origin/HEAD` absent, and non-symbolic (`default-unknown`). `followRemoteHEAD=never`.
  - `no-remote-branch`: two remotes that map the ref, a refspec to `refs/tags/`, and a forward mapping that names another ref.
  - Two push URLs. A mirror remote. An operation in progress. Trust required.
  - The 60 s expiry through the `now` seam. `STALE_REVIEW` after an external fetch. Cancel during a slow pre-receive hook.
  - On Windows: the run sends the Pageant frame before the push, as `tests/git/sync-fetch.test.ts:394` checks for fetch (R10).
  - The config files stay byte-identical.
- T010 (combined):
  - Success with the section removed. A branch without a `branch.<name>` section.
  - `not-upstream` after an external `branch --set-upstream-to`. `current-branch`, `other-worktree`, and `config-in-include`.
  - `STALE_REVIEW` after an external commit on the local branch.
  - An approved pre-push hook commits on the local branch during the run. The result has `localNotDeleted`, and the local ref keeps the new commit.
  - Cancel between the steps. The combined count of P14.
- T012 (gone recovery): another clone deleted the remote branch (gone). The branch moved (no removal). A `pushurl` differs (no check). The remote holds `refs/heads/x/refs/heads/<name>` but not `refs/heads/<name>` (the exact parse gives gone). The combined form (X23 then X26).
- A test that asserts a refusal asserts its code and reason, never a message text (spec SC-011).
- Every Git test uses an owned `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM=1`. Hook fixtures write one log line per event. A test asserts the event set after approval and an empty log before it.
- Each new file in `tests/contracts`, `tests/git`, or `tests/wsl` adds its line to `tests/groups.json` in the same task.

### Invariants

1. Porcelain format: `transport.c:620-640`, `:664-690`, `:743`, `:773`, `:788-796`; `remote.c:1105-1110`; probes P1, P3, P8, P9, P10.
2. The lease protects a delete: P8, P9, P10. Without it, Git deletes moved and absent branches: P2, P11.
3. A successful delete removes the tracking ref and keeps the local config: `transport.c:574-616`; P12.
4. `symbolic-ref -q` gives exit 1 with no output for absent and non-symbolic refs: P13.
5. Fetch creates an absent `refs/remotes/<remote>/HEAD` by default on the admitted Git versions: P13; `admission.ts:9`; 001 `spec.md:521` (WSL Git 2.55).
6. `--exclude` before `--remotes` takes the name without `refs/remotes/`: P14 with its control. Ref names hold no glob character (`workbench-commands.ts:150`).
7. `ls-remote --exit-code` exits 2 when no ref matches (git-ls-remote(1)); P15.
8. The `sync` class covers the combined operation: `trust.ts:673-689`, `:374-409`, `:1475-1476`.
9. Refspec mapping in both directions exists: `workbench-parsers.ts:392-432` and `sync.ts:148-170`.
10. Network steps, writes, and Cancel: `sync.ts:277-324`.
11. Token binding and stale checks: `sync.ts:510-518` and `:561-571`; `sync-review.ts:546-548`.
12. Reviews never contact a remote: `sync-review.ts:5`; 003 FR-041 (`spec.md:261`).
13. The branch list skips symbolic refs, so no `origin/HEAD` row exists: `workbench-parsers.ts:58`.
14. The local delete steps: `branch-ops.ts:162-186`; `workbench-commands.ts:274-282`.
15. WSL parity: P20.

## Risks

- R1 The `(delete):<dst>` source field of a stale lease (P8, P9). Mitigation: the alias match and T007.
- R2 A delete without a lease removes moved commits (P11). Mitigation: `pushArgs` throws without a lease for a delete, and T006 asserts the argv.
- R3 The import-order hazard of D15. Mitigation: `ref-facts.ts` with no load-time side effects.
- R4 A stale local `origin/HEAD`. The new default of the remote stays deletable here. Git servers refuse their HEAD branch by default (P4). Per the user decision, Arbareto reads only the local symref.
- R5 Hidden prompts. `GIT_TERMINAL_PROMPT=0` (`git-environment.json`, policy `remote`) fails fast. SSH prompts get the 001 FR-051 stall notice. No message text decides.
- R6 Partial combined results. X24 and X25 state the exact state. No commit is lost.
- R7 File overlap with 010: `channel.ts`, `envelope.ts`, `errors.ts`, `sync.ts`, `sync-review.ts`, `sync-commands.ts`, `useSync.ts`, `ask.ts`, `BranchActions.tsx`, and `texts.ts`. Mitigation: 011 code starts on `main` after 010 merges.
- R8 The trust ask from inside the open Delete dialog. Mitigation: the packaged test checks the focus after the shell dialog closes (T019).
- R9 The 60 s token lifetime while the dialog stays open. The run then refuses with `APPROVAL_EXPIRED`, as the 003 and 004 flows do today.
- R10 PuTTY remotes. The delete reuses the push Pageant step. T009 checks the Pageant frame on Windows (D16).
- R11 A remote that hides refs (`uploadpack.hideRefs`). The gone check then removes the stale ref, but the remote keeps its branch. The confirmation listed the commits of that ref, so no unconfirmed data goes.
- R12 Cancel after a remote success and before the local delete. `writeUpstream` checks the signal before each write (`sync.ts:310`). The result is `failed-with-effects`. It states `localNotDeleted` only when the fresh ref listing still holds the local ref. A Cancel between the ref delete and the section removal gives no `localNotDeleted`.
- R13 Known limit: with a differing `pushurl`, no re-read runs, so each `[rejected]` delete gives E5 with no remedy (user decision 2026-11-11). A gone remote branch then keeps its stale ref on every retry. X27 does not apply: `fetch --prune` prunes from the fetch URL, not from the push URL of the delete. Mitigation: none in the application. After a check of the push URL, the user can run `git branch -d -r <remote>/<branch>` in a terminal.

## Open items and reviewer defaults

- The user answered Q1 to Q6 of the design plan on 2026-11-06 (spec Clarifications). Q1: option (a), the gone recovery of D8. Q2: Del opens the confirmation. Q3: text only. Q4: X1. Q5: the refusal X14. Q6: the D11 budgets.
- Reviewer default: X9 uses `{tracking}`. With the default refspec, it equals the `<remote>/<name>` of the user decision (spec Assumptions).
- Reviewer default: E4 keeps the existing word "push" for a delete. The mockup review can change it in D13.
- Reviewer default: the cold measures cover SC-009a to SC-009d. SC-009e is an input-response measure during the runs and has no cold run.
- Mockup decisions: the user approved the boards and eight decisions on 2026-11-06 (research R7 "Mockup review (T002)"). D2, D3, D6, and D13 hold them.

## Phases

### Batches

| Batch | Work packages | Content |
| --- | --- | --- |
| 0 | WP-S, WP-F, then WP1 | These artifacts, the probe rerun (T001), then the mockup for user approval (T002). |
| 1 | WP2, then WP3 and WP4 | The contracts, then the Rust shell (local) and the service. Starts after the T002 approval and after 010 merges into `main`. |
| 2 | WP5 (beside WP4 in its own worktree) | The item, Del, the dialog, the check box, and the outcomes. |
| 3 | WP6 alone, WP7, then WP7r, then the review | The WSL tests, the packaged and perf tests, the packaged runs, and the final review. |
| 4 | WP8 | The amendments, README, and CHANGELOG. |

Each batch ends with its verification, one independent review (`reviewer`), and `/speckit-converge`. A WSL run runs alone on the host.

### Work packages, in run order

| Order | WP | Agent | Scope (files) | Tasks | Depends on |
|---|---|---|---|---|---|
| 1 | WP-S | implementer | `specs/011-remote-branch-delete/**`; then `/speckit-analyze` | none | none |
| 2 | WP-F | scout | research.md R7 only | T001 | WP-S |
| 3 | WP1 | frontend-implementer | no repository files (local scratch mockup) | T002 | WP-F; the user's approval ends it |
| 4 | WP2 | implementer-xhigh | `src/contracts/channel.ts`, `envelope.ts`, `errors.ts`, `operations.ts`, `src/contracts/schemas/*`; one line each in `src/frontend/trust/ask.ts` and `src/frontend/status/OperationStatus.tsx`; `tests/contracts/remote-delete-contract.test.ts`; `tests/vectors/**/remote-delete-*.json`; `tests/groups.json` | T003, T004 | WP1 approval; 010 merged |
| 5a | WP3 | implementer-xhigh (`Local: Rust`) | `src-tauri/src/close.rs`, `src-tauri/src/schema.rs` | T005 | WP2 |
| 5b | WP4 | implementer-xhigh | `src/git-service/ref-facts.ts` (new), `remote-delete.ts` (new), `workbench-review.ts`, `branch-ops.ts`, `sync-review.ts`, `sync.ts`, `sync-commands.ts`, `sync-parsers.ts`; `tests/contracts/sync-commands.test.ts`, `sync-parsers.test.ts`, `trust-classes.test.ts` (new); `tests/git/remote-delete*.test.ts` (new), `pre-push.test.ts`, `sync-trust.test.ts`, `sync-credentials.test.ts`; `tests/groups.json` | T006 to T014 | WP2 |
| 5c | WP5 | frontend-implementer | `src/frontend/branches/BranchActions.tsx`, `texts.ts`, `RemoteDeleteConfirm.tsx` (new); `src/frontend/sync/ForcePushConfirm.tsx`, `useSync.ts`; `src/frontend/app/Workbench.tsx`; `src/frontend/status/OperationStatus.tsx`; `src/frontend/keyboard/shortcuts.ts`; `tests/contracts/remote-delete.test.tsx` (new), `workbench-branches.test.tsx`; `tests/groups.json` | T015 to T017 | WP1, WP2; T017 also WP4 (T013, T014) |
| 6 | WP6 | implementer-xhigh (`Local: WSL`, alone) | `tests/wsl/remote-delete-wsl.test.ts` (new), `tests/groups.json` | T018 | WP4 |
| 7 | WP7 | implementer (`Local: package`) | `tests/windows/remote-delete-packaged.test.ts` and `remote-delete-perf.test.ts` (new), `tests/windows/perf-fixtures.ts` | T019, T020 | WP3, WP4, WP5 |
| 8 | WP7r | scout (`Local: package`) | research.md R7 | T021 | WP6, WP7 |
| 9 | review | reviewer | read only; research.md R7 map | T022 | WP7r |
| 10 | WP8 | implementer | the 001, 003, 004, and 007 spec lines of D14; README; CHANGELOG | T023, T024 | review; 010 merged |

- WP3, WP4, and WP5 are file-disjoint after WP2. They can run in separate worktrees. Run one implementer at a time unless the orchestrator allows parallel runs.
- `tests/groups.json` is shared. Each WP adds only its own lines, and the orchestrator merges them.
- WP5 needs the WP4 service only for the `bun run dev` check. Its contract tests use the recorded fakes (`tests/contracts/sync-fake.tsx`).

## Agent context

No agent context file changes. The `CLAUDE.md` files stay as they are. `.specify/feature.json` stays unchanged in WP-S. The orchestrator selects feature 011 when it starts batch 1.

## Complexity Tracking

No violation.
