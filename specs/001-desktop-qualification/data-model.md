# Data Model: Windows Desktop Qualification

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Protocol**: [contracts/operations.md](contracts/operations.md)

This document defines planned state, not implemented types. Git remains authoritative. Runtime objects stay in memory unless persistence is explicitly listed.

## 1. Git installation

| Field | Meaning and validation |
| --- | --- |
| `gitInstallationId` | Opaque, session-scoped identifier for the explicitly selected executable. |
| `executablePath` | Absolute, resolved executable path. Never a renderer-supplied command string. |
| `executableIdentity` | Resolved file identity, version output, and executable digest. Replacement invalidates approval. |
| `version` | Parsed Git for Windows version, plus bounded original version output. |
| `admission` | `admitted` or `unsupported`, according to the local qualification package's minimum version: `2.55.0.windows.3` or later. |
| `qualification` | `unverified`, `passed`, or `failed`. A pass requires recorded qualification evidence, not admission or installation presence. The source is a build-time list of version sets with recorded passing evidence. A version set is the Git version, the WebView2 version, and the OS build of one recorded passing packaged run. `passed` requires an exact match. This slice ships the list empty, so the value stays `unverified`. |

Persist the selected Git path in application-owned settings. Revalidate it after restart. Never silently select another executable.

Native settings retain the last explicitly opened repository and window bounds. Native storage also holds recovery markers (contract §6). A marker holds no message, patch, configuration, environment value, or credential. Revalidate that repository before restoring its workspace. Unknown or invalid native settings use documented defaults. This slice has no settings migration.

Application-owned webview storage retains theme, density, and pane proportions as bounded scalar preferences. Invalid values use documented defaults. Keep drafts and per-mode selection/scroll hints in renderer memory. They survive a service restart, because the page does not reload (contract §2). Operation approvals belong to the service session, and a service restart invalidates them. UI preferences never grant Git permissions.

Native-owned bootstrap contexts permit bounded probing before permanent IDs exist. Git registration follows a successful executable probe. Repository registration follows successful Git discovery. See the protocol's registration bootstrap.

## 2. Repository workspace

| Field | Meaning and validation |
| --- | --- |
| `repositoryId` | Random session identifier issued after registration. Not a path or Git revision expression. |
| `gitInstallationId` | Selected Git installation. |
| `worktreeRoot` | Absolute working-tree path returned through Git discovery. |
| `gitDirectory` | Git-resolved worktree administration directory. |
| `commonDirectory` | Git-resolved shared administration directory. |
| `indexPath` | Git-resolved index path for this worktree. |
| `worktreeIdentity` | Resolved directory identity for this checkout and its administration directory. |
| `commonIdentity` | Resolved common-directory identity. This identifies the application mutation exclusion group. |
| `head` | Symbolic target plus object ID, detached object ID, or a validated unborn branch. |
| `objectFormat` | Git-reported object format. Validate object IDs against that format. |
| `operationState` | Normal, conflicted, merging, rebasing, cherry-picking, reverting, sequencer-active, or unknown. |
| `generation` | Monotonic service counter for accepted state changes. Not proof that external state stayed unchanged. |
| `recoveryState` | `ready`, `refreshing`, `reconciling`, `unknown`, or `unavailable`. |
| `hunkEligibility` | Eligible or a bounded reason for unsupported index, registered index-change hook, executable monitor, or repository state. The built-in monitor (`core.fsmonitor=true`) is an unqualified monitor profile. |

Different linked worktrees have different worktree identities and indexes. They can share one common identity.

Resolve paths through Git before filesystem canonicalization. Never derive paths by appending `.git`. Never lowercase paths as an identity algorithm.

On Windows, the shell supplies every volume and file identity (contract §6). An identity is the 64-bit volume serial number plus the 128-bit file ID. Keep this platform behavior outside shared Git semantics.

Refuse bare repositories and Git administration folders with `UNSUPPORTED_REPOSITORY`. For a bare repository, the remedy is "Open a worktree of it, or clone it". For a Git administration folder, the remedy is "Open the working folder that contains it". Refuse a repository that Git reports with dubious ownership with `DUBIOUS_OWNERSHIP`. Other discovery failures use `REPOSITORY_UNAVAILABLE` with the remedy "Run `git status` in this folder". These failures include inaccessible targets and a missing `.git` file target. Opening a repository never creates a worktree or changes Git configuration.

## 3. Trust approval

| Field | Meaning and validation |
| --- | --- |
| `trustId` | Session-scoped approval identifier. |
| `repositoryId` | Approved workspace. |
| `configurationFingerprint` | Relevant effective configuration, include origins, attribute policy, and executable integration locations. |
| `approvedExecution` | Explicit approval for repository-controlled hooks, filters, and configured tools. |
| `approvalRequired` | Two flags from contract §7 "Mutation trust": one for reads and one for `commit`. |
| `approvedAt` | Local timestamp for display and qualification records. |
| `state` | `untrusted`, `approved`, `changed`, or `revoked`. |

Approval permits code execution; it does not make repository code harmless. Explain that consequence before approval.

Configuration changes invalidate approval and dependent selections. Missing approval blocks each operation that can run a repository-controlled integration (contract §7). It never authorizes bypassing required hooks.

Custom filters remain outside hunk support even after trust approval. Do not persist configuration values, hook output, or credentials in logs.

## 4. Change snapshot

| Field | Meaning and validation |
| --- | --- |
| `snapshotId` | Opaque identifier for one validated observation. |
| `repositoryId`, `generation` | Workspace and service generation that produced the observation. |
| `head` | Symbolic target and resolved object ID, including the unborn distinction. |
| `indexFingerprint` | Full-index content digest and Git-derived entries. Include referenced split-index state when applicable. |
| `indexEntries` | Literal path identity, stage, mode, object ID, and the intent-to-add, assume-unchanged, and skip-worktree flags. |
| `workingVersions` | Selected-path existence, type, mode, raw-byte digest, and normalized content identity. |
| `policyFingerprint` | Relevant attributes, trust approval, configuration, and Git installation identity. |
| `operationState` | Freshly observed mutation blockers. |
| `completeness` | `complete`, `limited`, or `failed`, with a specific reason. |
| `observedAt` | Observation time. It is not a transaction timestamp. |

Git reads can span external changes. Admit a mutation token only after consistency checks complete.

File timestamps and watcher events are hints. They cannot replace content checks. A raw-byte change invalidates a selection despite identical normalized content.

Index validation covers the whole index, not only the displayed path. Incomplete status or index data cannot authorize a mutation.

### History page

| Field | Meaning and validation |
| --- | --- |
| Repository/snapshot | Registered workspace and captured snapshot; never an arbitrary renderer revision. |
| Captured checkout | Full HEAD OID and symbolic target, including detached or unborn state. |
| Scope | `current-checkout`; at most 100 reachable commit rows. |
| Commit row | Full OID, ordered effective parent OIDs, subject, author, date, and the commit's `encoding` header value or none. |
| Row order | Git child-before-parent date order; no renderer sorting by author timestamps. |
| Boundaries | Explicit outside-page and shallow/unavailable ancestry, with parent IDs where known. |
| Completeness | Complete, limited, or failed data with a specific cause; unknown parents never become roots. |

Resolve shallow metadata through Git and include its bounded fingerprint in read validation. Ordinary parent edges come from Git traversal, not inferred branch membership.

Renderer state owns `selectedOid`, scroll anchor, and derived lane geometry. At most 24 lanes and 4,096 segments can render. Layout overflow retains rows and parent text; it does not change Git eligibility or data completeness.

Graph positions are not Git identities or mutation approvals. Current HEAD/branch badges reflect the captured checkout only. No graph action changes a reference or fetches missing history.

## 5. Change entry and file comparison

| Entity | Fields and rules |
| --- | --- |
| Change entry | `entryId`, literal path bytes, display path, category, source path, modes, object IDs, conflict stages, and limitation. |
| Comparison | `comparisonId`, snapshot, entry, scope, canonical service diff, hunk identifiers, completeness, and support decision. |
| Hunk | `hunkId`, ordinal, old/new ranges, exact canonical hunk digest, and service-owned application data. |
| Support decision | `supported` or an explicit reason: binary, encoding, size, rename, mode, type, symlink, submodule, LFS, filter, state, `line-endings`, `index-flag`, or `path`. |

An entry identifier distinguishes staged and unstaged entries for the same path. A staged deletion and untracked replacement remain separate entries.

Store Git paths as bytes internally. Display valid Unicode without changing identity. Reject unsupported filesystem encodings without guessing another path. Show invalid UTF-8 path bytes as `\xNN` escapes. Keep the raw bytes as the identity. Such entries get no hunk action, with reason `path`.

Compare the working file's on-disk name with the index path bytes. Any difference, such as letter case, refuses hunk actions with reason `path`. An entry that the service cannot read, such as a path beyond the Windows limit, also gets reason `path`. Run this comparison only for changed entries or at hunk-request time, never for every tracked entry on each refresh.

Reason `line-endings` applies when `ls-files --eol` reports `mixed` for the index or working side. Reason `index-flag` applies to intent-to-add, assume-unchanged, and skip-worktree entries.

Comparison scopes are `head-to-index`, `index-to-worktree`, and `empty-to-untracked`. An unborn HEAD supplies an empty committed baseline.

Service-generated canonical hunks define selectable boundaries. Renderer row numbers, visual wrapping, highlighting, and virtualization never define mutation boundaries.

The service retains the authoritative hunk data. The renderer receives display data and opaque identifiers, never an executable patch capability.

## 6. Mutation approvals

| Entity | Fields and rules |
| --- | --- |
| Hunk approval | Repository, snapshot, comparison, hunk, direction, exact content bindings, and one-use token. |
| Commit review | Repository, snapshot, complete staged scope, retained reviewed index, HEAD target/OID, execution-policy disclosure, trust, and review token. |
| Commit request | Review token, message, and explicit confirmation of the complete staged scope. The service issues the operation identifier in its accepted response. |

Tokens expire on refresh, relevant state change, service restart, or successful consumption. Contract §8 "Token invalidation" defines refresh and relevant state change. A consumed token stays bound to its operation for the rest of the service session. A repeated request with that token returns the operation's state and `operationId` (contract §2). Other expired tokens require a new review or selection.

Reject duplicate submissions while an operation is active. Never retry a mutation automatically after a lost response or service restart.

Commit messages remain in renderer memory after failed, changed, or uncertain outcomes. Track the submitted worktree, draft revision, and message beside the request/operation IDs in renderer memory. These fields do not extend the public commit payload.

Reconciled intended success clears only the matching, unchanged submitted draft. Preserve all later edits, including completion while History is visible. Never clear another worktree's draft. Explicit user clearing remains available.

Reject blank messages, NUL characters, unsupported encodings, and messages above the protocol limit. IME composition blocks submission.

Unsupported diff content can remain in a commit review. Its path, type, and staged identity must remain visible and complete.

A hunk approval requires initial and pre-publication validation. The canonical lock protects cooperating index writers, not independent working-file or reference changes.

Commit approval authorizes ordinary Git execution after preflight. It is not an immutable future tree, parent, or destination. Retain reviewed index data until reconciliation, even after token consumption or expiry.

Compare actual commit scope through read-only Git inspection against that retained snapshot. The verification copy is never used as the commit index. The selected protocols and remaining qualification are documented in [research.md](research.md).

## 7. Operation and outcome

| Field | Meaning and validation |
| --- | --- |
| `operationId` | Session-unique identifier that the service issues in the accepted response. No request creates one; `cancel` and `getOperation` name an issued one. A repeated request with a consumed approval returns the existing state, not another execution. |
| `requestId` | Correlates a request with exactly one terminal response. A repeated `requestId` in one service session gives `INVALID_REQUEST` and starts nothing. |
| `repositoryId`, `commonIdentity` | Registered target and mutation exclusion group, when applicable. Pre-registration operations use a native bootstrap context. |
| `kind` | One operation from the protocol allowlist. |
| `state` | State from the transition table below. |
| `phase` | Bounded operation phase, including preflight, candidate verification, publication, commit handoff, and reconciliation where applicable. |
| `ownedProcesses` | Native process handles and operation Job identity. Never process-name matching. |
| `limits` | Output, duration, concurrency, and framing limits from the protocol. |
| `result` | Typed success, refusal, failure, limit, interruption, or unknown-state result. An `unknown` result names its attribution reason: `ambiguous`, `evidence-limit`, or `no-retained-request`. Contract §9 maps each terminal state to its result code. |
| `effects` | Reconciled HEAD, index, working-file, and operation-state differences. |
| `diagnostic` | Bounded error code and safe explanation. No raw environment, repository content, or credentials. |

### State transitions

| Current state | Event | Next state and required behavior |
| --- | --- | --- |
| `accepted` | Valid read | `running`. |
| `accepted` | Mutation exclusion unavailable | `rejected`; do not queue an old approval. |
| `accepted` | Invalid approval, trust, or state | `rejected`; no process starts. |
| `running` | Cancellation request | `cancel-requested`; signal only owned processes. |
| `running` | Read completes | `succeeded`, `limited`, or `failed`; check generation before display. |
| `running` | Mutation finishes or fails | `reconciling`; keep further mutations blocked. |
| `running` (read) | Read deadline expires | Close the operation Job, refresh relevant state, then `failed` with `DEADLINE`. |
| `cancel-requested` (mutation) | Processes stop or deadline expires | `reconciling`. |
| `cancel-requested` (read) | Owned processes stop | Refresh relevant state, then `canceled`. |
| `cancel-requested` (read) | The read deadline expires first | Close the operation Job, refresh relevant state, then `failed` with `DEADLINE`. |
| `reconciling` | Intended effects confirmed | `succeeded`, including completion after a late cancellation request. |
| `reconciling` | No effects confirmed | `canceled` or `failed`, according to the observed outcome. |
| `reconciling` | Execution completed with differing observed effects | `completed-with-effects`; identify grounded results, preserve the draft, and require fresh review. |
| `reconciling` | Failed/interrupted execution left effects | `failed-with-effects`; report actual state without rollback or retry. |
| `reconciling` | State or commit attribution cannot be determined | `unknown`; keep mutations blocked and keep the recovery marker. |
| `unknown` | Explicit recovery refresh completes recovery reconciliation (contract §8) | Workspace becomes `ready`. The refresh result states the prior outcome, also an `unknown` attribution. The recovery marker is resolved. Prior tokens remain invalid. |
| `unknown` | A status-only read succeeds, or recovery reconciliation fails (contract §8) | Remain blocked. A status-only read cannot release this gate. |
| none | Registration or restore matches a recovery marker from an earlier session | Workspace starts `unknown`. Its recovery refresh reports attribution reason `no-retained-request`. |

Keep required verification data while recovery remains blocked. Apply the contract's aggregate reference/reflog byte and record limits to each reconciliation attempt.

A process exit code does not determine mutation success. Inspect Git state and working-file bytes before reporting the result.

On closure during mutation, offer staying open or interrupting and closing. After restart, obtain fresh Git state before accepting mutations. A recovery marker keeps an unresolved outcome across restart (contract §6).

## 8. Qualification record

Record qualification evidence in [research.md](research.md). Keep procedures and fixed budgets in [plan.md](plan.md) and [quickstart.md](quickstart.md).

Each record contains:

- Scenario identifier, application revision, release profile, package digest, and unsigned or signed package status.
- Exact dependency versions, Git path/version, WebView2 version, OS revision, architecture, and installer prerequisites.
- Hardware, display scales, Defender status, power mode, fixture seed/digest, and measurement method.
- Reproduction steps, run counts, individual observations, and `pass`, `fail`, or `unverified` results.
- Exact index, working-file, reference, and operation-state assertions for mutation scenarios.
- Failure cause, attempted remedy, retest result, remaining blocker, and decision impact.
- Raw evidence location and digest where applicable. Redact secrets before retaining evidence.

Source inspection records use a separate `source-inspected` label. They cannot pass packaged Windows scenarios.
