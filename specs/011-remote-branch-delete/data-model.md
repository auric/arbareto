# Data Model: Remote Branch Delete

Every record below lives in memory for one review, one dialog, or one run. Nothing is stored. Object IDs match the object format of the repository and pass `isObjectId`. Ref names pass `isRefName`.

## 1. Review payload

| Field | Rule |
| --- | --- |
| `action` | `"delete-remote-branch"`, a new `SYNC_ACTIONS` value. |
| `ref` | `FullRef`. It starts with `refs/remotes/` and passes `isRefName`. |
| `local` | `FullRef`, optional. It starts with `refs/heads/` and passes `isRefName`. It is present only for the combined delete. |

- A payload that breaks a rule gives `INVALID_REQUEST` before any Git process (plan D4 read 0).
- `local` with another action is invalid (contract Δ10 vectors).

## 2. Bound facts (service, per review)

The review binds the facts in `SyncBinding`. The run observes all of them again, and `staleOf` compares them in full (`sync.ts:561-571`). A difference gives `STALE_REVIEW`.

| Fact | Content |
| --- | --- |
| `payload`, `head`, `operationState`, `trust` | As for every 003 sync action. |
| `remotes` | `[R]`, the one remote that maps `ref`. |
| `destination` | `{ remote: R, ref: dst, trackingRef: ref, url, setUpstream: false, upstreamRebase: false, source: "tracking-ref" }`. `url` is the unredacted push URL and never leaves the service. |
| `lease` | `{ trackingRef: ref, expect, count, commits }`. `expect` is the object ID of `ref`. `count` and `commits` come from plan D4 read 10. |
| `local` | Combined only: `{ ref, oid, onlyHere, reflogKeeps, section, worktrees }`. `worktrees` is the listing digest, as `DeleteBound` holds it (`branch-ops.ts:188`). |
| `sameUrl` | True when `remote get-url --all` equals `remote get-url --push --all` byte for byte (plan D4 read 9). |

## 3. Plan

`SyncPlan` for this action:

| Field | Content |
| --- | --- |
| `remotes` | `[R]` |
| `destination` | As bound, with the redacted URL. `source` is `"tracking-ref"`. |
| `lease` | `{ trackingRef, expect, count, commits }`. `commits` holds at most `SYNC_LEASE_COMMITS` (100) entries of short ID and subject. |
| `local` | Combined only: `{ ref: FullRef, oid: ObjectId, reflogKeeps: boolean }`. |

- A plan of this action without `lease` or `destination` is invalid. `local` is valid only for this action.
- The token lives 60 s (`APPROVAL_LIFETIME_MS`) and is single use.

## 4. Run result and outcome mapping

`SyncResult` for this action:

| Field | Content |
| --- | --- |
| `push` | `PushResult` with `status` `deleted`, `rejected`, `remote-rejected`, `remote-failure`, or `none`. `oldObjectId` and `newObjectId` are the tracking ref before and after. `lease` is true. `upstreamWritten` and `upstreamNotSet` are false. |
| `reason`, `reasonText` | As in 003. `reasonText` is display text only. A stale lease gives `reason: stale-lease`. |
| `remoteGone` | `true` only when the gone recovery removed the stale ref (plan D8). Only this action carries it. |
| `localNotDeleted` | `true` only when the remote delete succeeded and a local write failed or Cancel stopped it. Only this action carries it. |
| `remedy` | The terminal command and its text, as for a push. A URL with user information gives text only. |

- The outcome events and their texts are in plan D6. The combined rows are in plan D7.
- `expected` is the listing before, without `ref` after `deleted` or `remoteGone`. After local writes that all exited 0, it is also without the local ref.
- Cancel never rolls back. The run reconciles from fresh reads.

## 5. Combined partial outcomes

| Remote part | Local part | Event | Result fields |
| --- | --- | --- | --- |
| deleted | deleted | `intended-effects-confirmed` | `push.status` `deleted` |
| deleted | failed, or not run after Cancel | `failed-with-effects` | `localNotDeleted: true` |
| failed, rejected, stale, or canceled | not run | `no-effects` | the failure fields |
| gone, stale ref removed | deleted | `intended-effects-confirmed` | `remoteGone: true` |
| gone, stale ref removed | failed, or not run after Cancel | failed-with-effects | remoteGone: true, localNotDeleted: true |

## 6. Refusal reasons

| Code | Reason | Source |
| --- | --- | --- |
| `SYNC_UNAVAILABLE` | `default-branch` (new) | `symbolic-ref -q` names `ref` (plan D4 read 6). |
| `SYNC_UNAVAILABLE` | `default-unknown` (new) | `symbolic-ref -q` exits 1. |
| `SYNC_UNAVAILABLE` | `no-remote-branch` (new) | The refspec mapping fails (plan D4 read 3). |
| `SYNC_UNAVAILABLE` | `not-upstream` (new) | `%(upstream)` of `local` differs from `ref` (plan D4 read 7). |
| `SYNC_UNAVAILABLE` | `push-urls`, `mirror`, `invalid-config`, `remote-missing`, `unknown-operation` (existing) | As in 003. |
| `WORKBENCH_UNAVAILABLE` | `current-branch`, `other-worktree`, `head-unresolved`, `config-in-include` (existing) | The local facts of plan D4 read 7. `SyncRefused` carries them, with `worktree` for `other-worktree`. |
| `UNKNOWN_TARGET` | none | `ref` is absent here (plan D4 read 5). |
| `OPERATION_IN_PROGRESS`, `TRUST_REQUIRED`, `TRUST_CHANGED`, `STALE_REVIEW`, `APPROVAL_EXPIRED`, `GIT_FAILED`, `MALFORMED_GIT_OUTPUT`, `INVALID_REQUEST` | none | As in 003. |

- The texts of each reason are in plan D4 "Refusals" and D13.

## 7. Renderer state (not stored)

| State | Content |
| --- | --- |
| Remote overlay | `{ kind: "remote-delete", entry, plan, token }`. It opens from X1 or Del on a remote-tracking entry. |
| Delete overlay field | `remote: { checked, plan, token, error } \| null`. It is null when X9 does not show (plan D1). `checked` starts false. |

- While `checked` is true, Delete sends `sync` with the sync token. It never sends `runWorkbench`.
- While `checked` is false, Delete sends `runWorkbench` with the workbench token, as in 004.

## 8. Texts

Plan D13 holds every visible text of this feature once. This file names texts by their D13 IDs only.
