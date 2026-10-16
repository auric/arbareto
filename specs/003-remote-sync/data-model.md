# Data Model: Remote Sync

**Feature**: `specs/003-remote-sync` | **Date**: 2026-10-12 | **Plan**: [plan.md](plan.md) | **Contract**: [contracts/operations.md](contracts/operations.md)

The service holds §1 to §9 and §11 in memory for one service session. The shell holds §10 in its native settings. Feature 001 and 002 data-model rules stay in force.

## 1. Tracking entry (`readTracking` result)

| Field | Type | Rule |
|---|---|---|
| `name` | string | Local branch name without `refs/heads/`. UTF-8 with replacement, and `invalidUtf8` marks other bytes. |
| `objectId` | OID | `%(objectname)`. |
| `upstream` | full ref name or null | `%(upstream)`. Null: no upstream. |
| `upstreamObjectId` | OID or null | The OID of the `upstream` record in the same output. Null when the record is absent. |
| `track` | `{state: "none"}`, `{state: "gone"}`, or `{state: "counts", ahead, behind}` | From `%(upstream:track,nobracket)`. Empty with an upstream gives counts 0 and 0. |
| `current` | boolean | `%(HEAD)` is `*`. At most one entry. |

Label rule (renderer):
- Counts: `↑ahead ↓behind`, and the text "A ahead, B behind". 0 and 0 shows the equal mark.
- A value above 10,000 shows "10000+".
- `none` shows "No upstream". `gone` shows "Upstream gone".
- A count shows only when `objectId` and `upstreamObjectId` equal the newest `readRefs` values. Otherwise it shows no number.

## 2. Sync review (retained, one use)

| Field | Rule |
|---|---|
| `syncReviewToken` | Opaque §2 identifier. Lifetime: the 001 approval lifetime of 60 s. |
| `action` | `fetch`, `fetch-all`, `pull`, `integrate`, `push`, `force-push`, `abort`, `continue`, or `skip`. |
| `binding.head` | The 001 `Head` at review. |
| `binding.operationState` | The 001 `operationState` at review. |
| `binding.trust` | Fingerprint and `approvalRequired.sync`. A changed fingerprint is a trust difference only when `approvalRequired.sync` is true in the review or in the re-read. |
| `binding.remotes` | Ordered names from `git remote`, or the one remote of the action. |
| `binding.upstream` | `{ref, objectId}` for `pull` and `integrate`. |
| `binding.destination` | §3 result for `push` and `force-push`. |
| `binding.lease` | `{trackingRef, expect, count, commits[≤100]}` for `force-push`. Each commit is `{objectId, subject}`. A commit object above `HISTORY_COMMIT_OBJECT_BYTES` gives `subject` null. |
| `binding.index` | Index fingerprint and unmerged count for `continue`. |
| `binding.mode` | For `pull` and `integrate`: the payload mode or null. |
| `binding.skippedCommit` | For `skip`: the `REBASE_HEAD` object ID. |

`sync` re-reads each bound value. A difference gives `STALE_REVIEW`. A trust difference gives `TRUST_CHANGED` or `TRUST_REQUIRED`.

## 3. Push destination

| Field | Rule |
|---|---|
| `remote` | `%(push:remotename)`, else `origin` (plan.md D4 step 1), or the panel choice. Must be in `git remote`. |
| `ref` | Full remote ref name (plan.md D4), or `refs/heads/<panel name>`. |
| `trackingRef` | `%(push)`, or null for a panel destination and a `push-default-triangular` destination. Null gives `no-lease` for Force push with lease. |
| `url` | The one push URL, redacted for display. |
| `setUpstream` | Panel choice. Default true only for a branch without an upstream, else false (FR-016). Only the panel sets it. |
| `upstreamRebase` | True when a selected Set upstream also writes `branch.<branch>.rebase`, because `branch.autoSetupRebase` is `remote` or `always`. False without `setUpstream`. |
| `source` | `remote-push-refspec` (`remote.<R>.push`), `push-default-upstream` (`upstream`, `tracking`), `push-default-branch` (`current`, and `simple` or unset with the fetch remote), `push-default-triangular` (`simple` or unset with another push remote), or `panel`. `matching` always gives `panel` (plan.md D4 step 4). |

## 4. Fetch result

| Field | Rule |
|---|---|
| `remotes[]` | One per remote: `name`, `state` (`succeeded`, `failed`, `canceled`, `deadline`, `not-started`), `updates`, `counts`, `outputTail`. |
| `remotes[].updates[]` | The porcelain lines of that remote, at most 1,000: `flag`, `oldObjectId`, `newObjectId`, `ref`. |
| `remotes[].counts` | Lines per flag, for all lines of that remote. |
| `observed` | Ref changes from the before and after listings that the lines do not cover. |

## 5. Push result

| Field | Rule |
|---|---|
| `status` | `pushed`, `forced`, `created`, `up-to-date`, `rejected`, `remote-rejected`, `remote-failure`, or `none` (no line). |
| `oldObjectId`, `newObjectId` | From the observed tracking ref, before and after. |
| `reasonText` | The parenthesized reason as plain text. Display only. |
| `lease` | True when the push sent a lease. A `rejected` status with a lease means the remote changed. |
| `upstreamWritten` | True when `branch.<name>.remote`, `.merge`, or `.rebase` changed. |
| `upstreamNotSet` | True when a selected Set upstream ran after a successful push and a write did not exit 0, or a Cancel came first (contract Δ3). The push outcome stays. The result holds the Set upstream remedy. |
| `outputTail` | Bounded, redacted stderr of the push, also on success. |

## 6. Pull decision

Inputs: counts after the fetch, `pull.ff`, `branch.<name>.rebase`, `pull.rebase`, and the payload mode. The rebase column takes the payload mode first, then `branch.<name>.rebase`, then `pull.rebase`. The rows apply in order, and the first match decides.

| Counts | `pull.ff` | Rebase value or payload mode | Result |
|---|---|---|---|
| behind 0 | any | any | `up-to-date`, no integration |
| ahead 0, behind > 0 | any | `true`, `merges`, `interactive`, or payload `rebase` | `fast-forward` (Git's pull fast-forwards a rebase pull that can fast-forward) |
| ahead 0, behind > 0 | `false` | unset or `false`, or payload `merge` | `merge --no-ff` (FR-027, reviewer default O-2) |
| ahead 0, behind > 0 | `true` or `only` | any | `fast-forward` |
| ahead 0, behind > 0 | unset | unset or `false`, or payload `merge` | `merge` with no ff option, so `merge.ff` applies as in Git's pull (reviewer default O-2, research R16 e) |
| both > 0 | `only` | no payload, any configured rebase value | refusal `ff-only` (t7601 "pull.ff=only overrides pull.rebase=true") |
| both > 0 | `only` | payload `rebase` or `merge` | that mode; Git's pull turns `--ff-only` into `--ff` |
| both > 0 | unset | unset and no payload | `mode-required` |
| both > 0 | any | `true`, `merges`, payload `rebase` | `rebase` (`--rebase-merges` for `merges`) |
| both > 0 | any | `interactive` | refusal `interactive-rebase` |
| both > 0 | `true` or `false` | unset and no payload | `merge` with `--ff` or `--no-ff` |
| both > 0 | `true`, `false`, or unset | `false` or payload `merge` | `merge` with `--ff`, `--no-ff`, or nothing |

An invalid value gives refusal `invalid-config`. The `sync` result names the source of the mode as `modeSource`: `payload`, `branch`, `pull`, `pull-ff`, or null when no payload and no configuration value decided.

## 7. Integration state

| Value | Meaning |
|---|---|
| `none` | No integration started. |
| `up-to-date` | Behind was 0. |
| `mode-required` | The renderer must ask. |
| `done` | Git exited 0, and the §8 checks hold. |
| `stopped` | A merge or rebase is in progress. `operation` and `unmerged` count follow. |
| `refused` | Git exited non-zero, and the state is normal. `outputTail` follows. |

## 8. Outcome per action

| Action | `succeeded` | `completed-with-effects` | `failed` | `failed-with-effects` | `canceled` |
|---|---|---|---|---|---|
| fetch, fetch-all | Every process exit 0, and the listing diff equals the lines. | Exit 0, and the diff has more changes. | A process failed, and no ref changed. | A process failed or a limit fired, and a ref changed. | Cancel, and no ref changed. |
| push | Status `pushed`, `forced`, `created`, or `up-to-date`, also with `upstreamNotSet`. | Success, and another local change is observed. | `PUSH_REJECTED` with its reason, or no line and no change. | A limit or Cancel, and a local ref or config changed. | Cancel, and no local change. The remote can hold the push. |
| pull, integrate | Integration `up-to-date` or `done`, or `mode-required`. | `done`, and an observed value differs from the expected one. | No effect. | The fetch changed refs, and the integration is `stopped`, `refused`, or not started. | Cancel, and no change. |
| abort, continue, skip | State `normal` after abort; Git exit 0 and state `normal` after continue or skip. | Another observed change. | Git refused, and nothing changed. | `stopped` again, or a partial change. | Cancel, and no change. |
| clone | Exit 0 and registration. | Not used. | A refusal before the start, or a failure with the destination absent or empty. | The destination exists and is not empty after a failure, a limit, or Cancel. | Cancel, and the destination is absent or empty. |

A failed reconciliation read gives `unknown`, and the recovery marker stays (001 §8). Clone has no marker.

## 9. Mark resolved (`applyFile` direction `resolve`)

| Field | Rule |
|---|---|
| Entry | A `u` status record with stages present. |
| Accepted | XY in `UU`, `AA`, `AU`, `UA`, `DU`, `UD`, a regular working file, no `120000` or `160000` in any mode, no `filter` attribute, size within 512 MiB, and the 001 path rule. |
| Refused | `missing` (no working file, includes `DD`), `type`, `symlink`, `submodule`, `path`, `filter`, `LFS`, `size`, `blob-proof`. |
| Binding | The 001 `FileBinding`, with `entry.stage` null, the three stage modes and OIDs, the working mode `mW` of the `u` record, plus `operationState`. |
| Staging | `hash-object -w -- <path>` on the working file, then `update-index -z --index-info` with `<mW> SP <oid> TAB <path>` (plan.md D7). `mW` equals the `git add` mode, also on Windows with `core.symlinks=false` and `core.filemode=false` (research R16 i). `update-index --add` is not used: it writes `100644` there. |
| Verification | One stage-0 entry with mode `mW`, no stages 1 to 3 for the path, and every other entry unchanged. P0.2 (i2) verifies the equality with `git add`. |

## 10. Shell settings

| Field | Rule |
|---|---|
| `sshClient` | `git` (default) or `plink`. |
| `defaultPullAction` | `pull` (default, Pull with Git's configuration), `pull-merge`, `pull-rebase`, `fetch`, or `fetch-all`. The main part of the Pull split button runs it (FR-055, FR-056). Never written into Git configuration. |
| `plinkPath` | A picked file. Pageant and PuTTYgen sit in its folder (O-7). |
| `remoteKeyFiles[]` | Up to 256 entries of `{worktreeKey, remote, path}`. The path is a picked file. |
| `defaultCloneFolder` | A picked folder or null. |
| `lastCloneParent` | Stored after each successful clone. |

`readSyncSettings` also returns `programs`. For a set `plinkPath`, it holds one entry each for `plink`, `pageant`, and `puttygen`, with the path in the plink folder (O-7) and `present` from an OS fact. For a null `plinkPath`, it is empty.

No passphrase, no credential, and no key content.

## 11. Connect target (retained)

`{operationId, kind: "remote" | "url", repositoryId | null, gitInstallationId, target}` for the last failed `sync` or `clone` of each workspace. The service keeps one only when the `pageant` reply of that operation was not `git`. A clone without a workspace keeps one target for the session. The target URL never leaves the service, except in the `terminal` request to the shell.
