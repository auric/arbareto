# Data Model: History Commit Menu

Every record below lives in memory for one menu, one review, or one run. Nothing is stored. Object IDs match the object format of the repository and pass `isObjectId`.

## 1. Commit menu state (renderer, not stored)

| Field | Rule |
| --- | --- |
| `oid` | The object ID of the commit row. Only commit rows open the menu (plan D1). |
| `anchor` | The row option element. The menu anchors to it. |
| `byKey` | True for Shift+F10 or the Menu key. Then the first item gets the focus. |

- Groups and order: plan D11 "Menu". Availability and reasons: plan D1 "Availability".
- The renderer reads the latest `readWorkspace` head and operation state and `mutationReason`. The service review checks every rule again.
- History label state: `activeLabel` is a label index or `null`. Left on the first label sets `null`. Right from `null` sets 0. Shift+F10 with `null` opens the commit menu.

## 2. Bound facts (service, per review)

The dispatcher binds HEAD, the operation state, and the trust listing (`workbench-review.ts:231-244`). Each action adds these facts. The run observes all of them again. A difference gives `STALE_REVIEW`.

| Action | Bound facts |
| --- | --- |
| `reset` | `target`, `mode`, the tracked digest, `leave`, `gain`, `reflogOnly`, `forceNote`, `ignoredReplaced` |
| `create-tag` | `absent: true` (no `refs/tags/<name>`), the `signs` value of the selected kind |
| `cherry-pick` | `parents`, `mainline`, `clean: true` |
| `revert-commit` | `parents`, `mainline`, `clean: true` |

## 3. Review payloads and plans

| Action | Payload | Plan |
| --- | --- | --- |
| `reset` | `{ action, target: ObjectId, mode: "soft" \| "mixed" \| "hard" }` | `ResetPlan { target, mode, branch, from, leave, gain, reflogOnly, forceNote, trackedChanges, ignoredReplaced }` |
| `create-tag` | `{ action, name: TagName \| null, target: ObjectId, message: TagMessage \| null }` | `CreateTagPlan { name, target, annotated, signs: { light, annotated } }` |
| `cherry-pick` | `{ action, commit: ObjectId, mainline: 1..64 \| null }` | `CherryPickPlan { commit, parents, mainline, branch }` |
| `revert-commit` | `{ action, commit: ObjectId, mainline: 1..64 \| null }` | `RevertCommitPlan { commit, parents, mainline, branch }` |

- `TagName`: 1 to 255 bytes (`BRANCH_NAME_BYTES`), no NUL, no control character. An empty name gives `INVALID_REQUEST`. `tagNameRefusal` gives `invalid-name` for a leading `-`, and `reserved-name` for `HEAD` and `@`.
- `name: null` is the open review of the popover (plan D3). It gives the plan with `name: null` and no token. A run needs a review with a name.
- `signs`: `light` is the effective `tag.gpgSign`. `annotated` is true when `tag.gpgSign` or `tag.forceSignAnnotated` is true. The open review returns both facts. It never refuses with `tag-signing`.
- `TagMessage`: strict UTF-8, not blank, at most `MERGE_MESSAGE_BYTES` (8 KiB). `null` gives a lightweight tag.
- `mainline`: an integer from 1 to 64 (`HISTORY_PARENTS_PER_COMMIT`). It must not exceed the parent count.
- `leave`, `gain`, `reflogOnly`: the counts of `rev-list --count` (plan D4 read 4).
- `forceNote`: `null`, or the tracking ref that holds a commit that leaves.
- `trackedChanges`: the count of `trackedStatus`.
- `ignoredReplaced`: the count of ignored files that Hard reset replaces. An ignored folder counts its files. It is 0 for Soft and Mixed.
- `parents`: the parents of `rev-list --parents -n 1`, each with its short ID and subject for the popover.

## 4. Run results and the outcome mapping

| Action | Run result |
| --- | --- |
| `reset` | `ResetRun { action, mode, head, refs, trackedChanges }` |
| `create-tag` | `CreateTagRun { action, head, refs, tag: { name, oid, annotated } }` |
| `cherry-pick` | `CherryPickRun { action, head, refs, operationState, unmerged, outputTail? }` |
| `revert-commit` | `RevertCommitRun { action, head, refs, operationState, unmerged, outputTail? }` |

Outcome mapping. Each row uses a fresh `observe`. The first row that matches decides.

| Action | Facts | Outcome |
| --- | --- | --- |
| `reset` | Exit 0. HEAD is on the same branch at `target`. No ref other than `refs/heads/<branch>` changed, and that ref equals `target`. The state is normal, and no lock exists. Soft: the index fingerprint is unchanged. Mixed: `diff-index --cached --quiet <target> --` gives exit 0. Hard: the same, and `trackedChanges()` is false. | `intended-effects-confirmed` |
| `reset` | Any other fact set with a change of refs, HEAD, index fingerprint, tracked digest, state, or lock | `failed-with-effects` with the changed facts |
| `reset` | The intended facts fail, and nothing changed | `no-effects`, `failed`, `GIT_FAILED` with the output tail |
| `create-tag` | Exit 0. Only `refs/tags/<name>` is new. Lightweight: its value equals the target. Annotated: its value differs, and `info <value>^{commit}` gives the target. HEAD and the state are unchanged. | `intended-effects-confirmed` |
| `create-tag` | No new ref, and nothing changed | `no-effects`, `failed`, `GIT_FAILED` with the output tail |
| `create-tag` | Any other fact set with a change | `failed-with-effects` with the changed facts |
| `cherry-pick`, `revert-commit` | Exit 0. The state is normal, and HEAD is on the same branch. One new commit has the parents `[old HEAD]`. Only the branch ref moved, and no tracked changes exist. | `intended-effects-confirmed` |
| `cherry-pick`, `revert-commit` | State `cherry-picking` or `reverting`, unmerged > 0 | `failed-with-effects` with `{ operationState, unmerged }` |
| `cherry-pick`, `revert-commit` | State `cherry-picking` or `reverting`, unmerged 0 | `failed-with-effects` with the output tail |
| `cherry-pick`, `revert-commit` | Any other fact set with a change of refs, HEAD, index fingerprint, tracked digest, state, or lock | `failed-with-effects` with the changed facts |
| `cherry-pick`, `revert-commit` | No marker, and nothing changed | `no-effects`, `failed`, `GIT_FAILED` with the output tail |

The exit code alone never decides `intended-effects-confirmed`. Git documents no exit status for these commands (research R3).

## 5. Stop-finishing states and refusals

| State | Band row | Abort | Continue | Skip |
| --- | --- | --- | --- | --- |
| `cherry-picking` | Conflict row, kind `cherry-pick` | `cherry-pick --abort`, phase `sync-cherry-pick` | `cherry-pick --continue`, phase `sync-continue` | hidden; `not-rebasing` |
| `reverting` | Conflict row, kind `revert` | `revert --abort`, phase `sync-revert` | `revert --continue`, phase `sync-continue` | hidden; `not-rebasing` |
| `sequencer-active` | outside-only (001) | none | none | none |

Outcome of Abort and Continue: the 003 rule of `runConflictAction` (`sync-integrate.ts:347-351`) applies unchanged.
- Git ended the operation and the state is normal: `intended-effects-confirmed` when only the branch of the final HEAD moved. Another ref change gives `differing-effects`.
- Otherwise, any change of refs, HEAD, state, index fingerprint, or lock gives `failed-with-effects`.
- No change after Cancel gives `no-effects` with `canceled`. Another case gives `no-effects` with the step code.

Refusals of Abort and Continue (class `sync`):

| Reason | Fact | Applies to |
| --- | --- | --- |
| `sequence` | The status reader marker facts show `.git/sequencer` | Abort, Continue |
| `CONFLICTED` | Unmerged > 0 | Continue |
| `nothing-to-commit` | `diff-index --cached --quiet HEAD --` exit 0 | Continue |
| `not-rebasing` | Skip outside a rebase | Skip |

Frontend states during `cherry-picking` and `reverting`:
- `operationBlock` gives `operation`, and Mark resolved stays.
- Amend is blocked.
- The trust ask uses `cherry-pick` or `revert`.

## 6. Refusal reasons of the four actions

| Reason | Actions | Source fact |
| --- | --- | --- |
| `detached` | reset, cherry-pick, revert-commit | HEAD has no branch |
| `unborn` | reset, cherry-pick, revert-commit | The current branch has no commit |
| `CONFLICTED` | reset, cherry-pick, revert-commit | `indexState` unmerged > 0 |
| `UNKNOWN_TARGET` | all four | `info <oid>^{commit}` gives missing |
| `UNTRACKED_IN_WAY` (`untracked-in-way`) | reset Hard | the in-the-way verdict of plan D4 read 7 |
| `limit` | reset Hard | more than `DISCARD_CHECK_PATHS` candidates |
| `invalid-name` | create-tag | `check-ref-format` exit not 0, or `tagNameRefusal` for a leading `-` |
| `reserved-name` | create-tag | `tagNameRefusal` for `HEAD` or `@` |
| `name-exists` | create-tag | `show-ref --exists` exit 0 |
| `tag-signing` | create-tag | lightweight and effective `tag.gpgSign` true |
| `invalid-config` | create-tag | `tag.gpgSign` or `tag.forceSignAnnotated` is no boolean |
| `message-size` | create-tag | the message exceeds 8 KiB or the command-line bound |
| `limit` (parents) | cherry-pick, revert-commit | more than 64 parents |
| `mainline-needed` | cherry-pick, revert-commit | 2 or more parents and `mainline: null` |
| `not-merge` | cherry-pick, revert-commit | 1 or no parent and a mainline |
| `already-on-branch` | cherry-pick | `merge-base --is-ancestor` exit 0 |
| `dirty-tree` | cherry-pick, revert-commit | `trackedChanges()` true |
| `GIT_FAILED` | all four | a read exit that the documentation does not define as pass or refusal |

## 7. Texts

Plan D11 holds every visible text. This file holds none.
