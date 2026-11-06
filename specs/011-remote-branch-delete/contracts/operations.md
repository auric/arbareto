# Operation Contract Deltas: Remote Branch Delete

This file lists only the changes to the feature 001 contract (`specs/001-desktop-qualification/contracts/operations.md`) and to the 002 to 010 deltas. "001 §n" and "00n Δn" name those sections. Every rule that no delta replaces stays in force.

## Δ1 Transport (001 §1)

- `SYNC_ACTIONS` gains `delete-remote-branch` (`channel.ts:878`). The `started` frame action enum follows (`channel.ts` `startedFields`).
- No new operation name. `reviewSync` reviews the action, and `sync` runs it.
- No new `TRUST_ACTIONS` value.

## Δ2 Envelope (001 §2)

- `MUTATIONS` keeps `sync`. No new mutation operation. The push step and the gone check report the existing phase `sync-push`. The local writes of the combined delete report the new phase `sync-delete-local` before the first write.
- Events carry no path, no URL, and no Git text.

## Δ3 Public operations (001 §3)

`L` stands for `--no-lazy-fetch`. Reads add `--no-optional-locks`.

### `reviewSync` (003 Δ3)

- New payload `ReviewDeleteRemoteBranch { action: "delete-remote-branch", ref: FullRef, local: FullRef.optional() }` in `ReviewSyncPayload` (`envelope.ts:224`). Data-model §1 gives the rules.
- `PushDestination.source` gains `"tracking-ref"` (`envelope.ts:1273`).
- `SyncPlan` gains `local: { ref: FullRef, oid: ObjectId, reflogKeeps: boolean }`, optional (`envelope.ts:1307`).
- `ReviewSyncResult` (`envelope.ts:1322`): the reviewed refine adds two rules. `delete-remote-branch` needs `destination`, `lease`, and a token. `local` needs that action.
- `SyncRefused.reason` gains the new sync reasons of Δ9 and the workbench reasons `current-branch`, `other-worktree`, `head-unresolved`, and `config-in-include`. `SyncRefused` gains `worktree: ChannelPath.optional()`.
- Reads, in order (plan D4):
  0. The payload rule, with no Git process.
  1. The 003 common reads (`sync-review.ts:400-420`).
  2. The operation state rule (`OPERATION_IN_PROGRESS`, `unknown-operation`).
  3. The refspec mapping and the forward check (`no-remote-branch`).
  4. The remote list (`remote-missing`) and the mirror rule (`mirror`).
  5. `listRefs` of `ref` (`UNKNOWN_TARGET`).
  6. `[L, "symbolic-ref", "-q", "refs/remotes/<R>/HEAD"]`. Exit 0 with one `refs/` line and a target equal to `ref` gives `default-branch`. Exit 1 gives `default-unknown`. Another exit gives `GIT_FAILED`. A broken line gives `MALFORMED_GIT_OUTPUT`.
  7. With `local`: the current branch, the worktrees, `%(upstream)`, and `deleteFacts` (`current-branch`, `other-worktree`, `head-unresolved`, `not-upstream`, `config-in-include`).
  8. `remote get-url --push --all -- R` (`push-urls`).
  9. `remote get-url --all -- R` (`sameUrl`).
  10. `rev-list --count` and `rev-list --max-count=100` over the tips with the exclusions of plan D4 read 10.
- No read contacts a remote (003 FR-041).

### `sync` (003 Δ3)

- Steps (plan D6): the 003 frame, `listRefs` before, `pageant(R)` on Windows, then the push.
- Push: `[L, "push", "--porcelain", "--progress", "--no-recurse-submodules", "--no-follow-tags", "--force-with-lease=<dst>:<expect>", "--", R, ":<dst>"]`. A delete without the lease item is a contract violation.
- Parse: one porcelain line whose second field equals `:<dst>` or `(delete):<dst>`. The flag and summary map through `PUSHED`, which gains `["-", "deleted"]`. Two matching lines, or exit 0 with no matching line, give `MALFORMED_GIT_OUTPUT`. Empty stdout with a nonzero exit gives `none`.
- Gone recovery (plan D8): when the status is `rejected`, the reason is `stale-lease`, and `sameUrl` holds, run `[L, "ls-remote", "--exit-code", "--", R, dst]` through the network step. Exit 2, or exit 0 with no exact `<dst>` line, means gone. Then run `[L, "update-ref", "--no-deref", "-d", ref, expect]`. Exit 0 sets `remoteGone`. Any other result keeps the stale outcome.
- Local writes (combined, after `deleted` or `remoteGone`): `deleteRefArgs(branch, oid)`, then `removeBranchSectionArgs(branch)` when `section` holds. They stop at the first nonzero exit and at Cancel.
- Results: `PushResult.status` gains `"deleted"` (`envelope.ts:1359`). `SyncResult` (`envelope.ts:1389`): `PUSHING` (`:1384`) gains the action. New fields `remoteGone: z.literal(true).optional()` and `localNotDeleted: z.literal(true).optional()`, only for this action.
- The push `SUCCESS` set (`sync.ts:42`) stays unchanged.

## Δ5 Finite bounds (001 §5)

- `SYNC_LEASE_COMMITS` (100) for the commit list.
- `DIAGNOSTIC_RETAINED_BYTES_PER_STREAM` (64 KiB) for the push stdout, the symref line, the URL lines, and the `ls-remote` lines.
- `SYNC_REFS_BYTES` and `SYNC_REFS_RECORDS` for the listings.
- No new limit constant.

## Δ6 Shell (001 §6)

- `close.rs` `Mutation` gains `DeleteRemoteBranch` under `StartedKind::Sync`, with the close name X18 (plan D13).
- `schema.rs` started-action test list gains `"delete-remote-branch"`.
- The phase `sync-delete-local` carries no counter (Δ2). `schema.rs` `progress` refuses a counter on it. The no-counter phase test gains `"sync-delete-local"`.
- `dialogs.rs` stays unchanged, because the trust ask names `push`.

## Δ7 Startup, trust, and environment (001 §7)

- The action uses the trust class `sync`. It covers `pre-push`, `reference-transaction`, and the transport programs (`trust.ts:673-675`, `:374-392`).
- `approvalRequired.workbench` implies `approvalRequired.sync` (`trust.ts:1475-1476`). So the `sync` gate covers the local writes of the combined delete.
- The trust ask names the action `push` (`SYNC_TRUST`, `ask.ts:23`).
- The push and the gone check run under policy `remote` with `GIT_TERMINAL_PROMPT=0` and the stall notice.
- The remote-only delete writes no configuration. The combined delete removes only the `branch.<name>` section.

## Δ8 Freshness, cancellation, and outcome (001 §8)

- A review lives 60 s and is single use.
- Cancel stops the step. Fresh reads report the result. Cancel is never a rollback.
- The outcome mapping is plan D6 and D7. Data-model §4 and §5 give the fields.

## Δ9 Error codes (001 §9)

- New `SYNC_UNAVAILABLE_REASONS` (`errors.ts:71`): `default-branch`, `default-unknown`, `no-remote-branch`, and `not-upstream`.
- `SyncRefused` carries the four workbench reasons and `worktree` for the combined review.
- Reused codes: `UNKNOWN_TARGET`, `OPERATION_IN_PROGRESS`, `STALE_REVIEW`, `APPROVAL_EXPIRED`, `PUSH_REJECTED`, `GIT_FAILED`, `MALFORMED_GIT_OUTPUT`, and `INVALID_REQUEST`.

## Δ10 Required contract checks (001 §10)

- `bun run export:schemas` regenerates `src/contracts/schemas/*.json`. `bun run export:schemas --check` decides the changed set (research R5 U7).
- Valid vectors in `tests/vectors/valid/remote-delete-*.json`: the remote payload, the combined payload, a plan with `local`, and a result with status `deleted`, `remoteGone`, and `localNotDeleted`. Also a result with `remoteGone` and `localNotDeleted` together.
- Invalid vectors in `tests/vectors/invalid/remote-delete-*.json`: `local` with action `push`, `remoteGone` with action `push`, and a plan of this action without `lease`.

## Δ11 WSL repositories (001 §11)

- The same argument arrays run through the 006 route. No new wrapper mode.
- The run waits for the process-end fact before any read.

## Contract gaps

- None known. The gone fact needs a network read, so it stays in the run (plan D8). A probe finding of T001 changes this file first.
