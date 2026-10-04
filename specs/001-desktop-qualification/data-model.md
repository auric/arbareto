# Data Model: Windows Desktop Qualification

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Protocol**: [contracts/operations.md](contracts/operations.md)

This document defines planned state, not implemented types. Git remains authoritative. Runtime objects stay in memory unless persistence is explicitly listed.

## 1. Git installation

| Field | Meaning and validation |
| --- | --- |
| `gitInstallationId` | Opaque, session-scoped identifier for the explicitly selected executable. |
| `selectedPath` | Absolute path that the user selected, such as the Git for Windows wrapper `cmd\git.exe`. Only the `--exec-path` probe runs it (contract §3 "Git proposal"). |
| `executablePath` | Absolute, resolved executable path: `git.exe` in the folder that `--exec-path` prints. Never a renderer-supplied command string. |
| `executableIdentity` | Resolved file identity, version output, and executable digest. Replacement invalidates approval. |
| `version` | Parsed Git for Windows version, plus bounded original version output. |
| `admission` | `admitted` or `unsupported`, according to the local qualification package's minimum version: `2.55.0.windows.3` or later. |
| `qualification` | `unverified`, `passed`, or `failed`. A pass requires recorded qualification evidence, not admission or installation presence. The source is a build-time list of version sets with recorded passing evidence. A version set is the Git version, the WebView2 version, and the OS build of one recorded passing packaged run. `passed` requires an exact match. This slice ships the list empty, so the value stays `unverified`. |

Persist `selectedPath`, `executablePath`, the approved version text, and the SHA-256 digest of `executablePath` in application-owned settings. A settings entry without `selectedPath` uses `executablePath` as the selected path. The digest is 64 lowercase hex digits. A file rewritten in place keeps its file ID, so the digest identifies its bytes. Revalidate after restart: resolve `selectedPath` through `--exec-path` again (contract §6 "Startup contexts"). A resolved file inside the installation root of `selectedPath` is admitted without a new confirmation. A different version or digest then replaces the saved values, and `selectedPath` stays. `getEnvironment` reports the saved version as `previousVersion` for that start only. A resolved file outside that root gives `GIT_UNAVAILABLE`. Never select another installation without Use this Git. When `chooseGit` probes the saved resolved path, the confirmation also shows the stored version (contract §3 "Git proposal").

A WSL Git installation is one Linux Git per distro (contract §11 "Git per distro"). It adds these fields:

| Field | Meaning and validation |
| --- | --- |
| `location` | `windows` or `wsl`. |
| `distro` | Listed distro name and registration GUID. A new GUID is a new installation. |
| `executablePath` | Absolute Linux path from `command -v git` and `readlink -f`. Never under `/mnt/`. |
| `executableIdentity` | UUID-derived file-system ID from `stat --file-system`, and inode, size, and modification time from `stat`, plus the version text. A change gives `GIT_CHANGED`. A file system without a stable ID gives `GIT_UNSUPPORTED` with reason `no-fs-uuid` (contract §11). |
| `version` | Linux Git version. `admission` is `admitted` from `2.55.0`. A lower, unparseable, or `.windows.` version is `unsupported`. |
| `helpers` | Absolute Linux paths of `systemd-run` and `systemctl`, and a passed scope test. Without them, the distro gives `WSL_UNAVAILABLE`. The absolute path of `setsid`. Without it, the distro gives `WSL_UNAVAILABLE` with reason `no-setsid`, because every wrapper mode needs it (contract §11 "Git per distro"). The resolved `/usr/bin/stat` and `/usr/bin/env`. Without either, the distro gives `WSL_UNAVAILABLE` with reason `no-coreutils`. |

Native settings keep one approved WSL Git for each distro GUID, beside the Windows Git selection.

Native settings retain the last explicitly opened repository and window bounds. Native storage also holds recovery markers (contract §6) and trust approval records (contract §7 "Trust approval store"). A marker holds no message, patch, configuration, environment value, or credential. A trust record holds no configuration value, command text, or credential. Revalidate that repository before restoring its workspace. Unknown or invalid native settings use documented defaults. This slice has no settings migration.

Application-owned webview storage retains theme, density, and pane proportions as bounded scalar preferences. Invalid values use documented defaults. No mode preference exists, because a repository always opens in History (spec FR-034). The same storage keeps one stored draft per worktree (§2 "Stored draft"). Keep drafts and per-mode selection/scroll hints in renderer memory. They survive a service restart, because the page does not reload (contract §2). Hunk approvals, file approvals, and commit review tokens belong to the service session, and a service restart invalidates them. Trust approvals persist in native storage (§3). UI preferences never grant Git permissions.

Native-owned bootstrap contexts permit bounded probing before permanent IDs exist. Git registration follows a successful executable probe. Repository registration follows successful Git discovery. See the protocol's registration bootstrap.

## 2. Repository workspace

| Field | Meaning and validation |
| --- | --- |
| `repositoryId` | Random session identifier issued after registration. Not a path or Git revision expression. A registration of the same worktree identity returns the existing identifier. A registration of another common directory releases the previous one (contract §6 "Registration reuse and release"). |
| `gitInstallationId` | Selected Git installation. |
| `worktreeRoot` | Absolute working-tree path returned through Git discovery. |
| `gitDirectory` | Git-resolved worktree administration directory. |
| `commonDirectory` | Git-resolved shared administration directory. |
| `indexPath` | Git-resolved index path for this worktree. |
| `worktreeIdentity` | Resolved directory identity for this checkout and its administration directory. |
| `worktreeKey` | SHA-256 of the worktree root identity, as 64 lowercase hex digits (contract §3 "Worktree key"). It stays equal across sessions and for both WSL prefixes. It names the stored draft and grants no access. |
| `commonIdentity` | Resolved common-directory identity. This identifies the application mutation exclusion group, in one instance and across instances (contract §6 "Cross-instance exclusion"). |
| `head` | Symbolic target plus object ID, detached object ID, or a validated unborn branch. |
| `objectFormat` | Git-reported object format. Validate object IDs against that format. |
| `refFormat` | Git-reported ref format from `--show-ref-format`: `files` or `reftable`. It selects the change-check files (contract §8 "Change check"). |
| `operationState` | Normal, conflicted, merging, rebasing, cherry-picking, reverting, sequencer-active, or unknown. |
| `generation` | Monotonic service counter for accepted state changes. Not proof that external state stayed unchanged. |
| `recoveryState` | `ready`, `refreshing`, `reconciling`, `unknown`, or `unavailable`. `unknown` takes precedence over every other value. `reconciling`: a mutation of this workspace is in operation state `reconciling`. `unavailable`: the last read got `REPOSITORY_UNAVAILABLE` for this registered workspace. `refreshing`: a `readWorkspace` with `refresh: true` runs for this workspace. `ready`: none of these holds after a complete read. |
| `hunkEligibility` | Eligible or a bounded reason for unsupported index, registered index-change hook, executable monitor, or repository state. The built-in monitor (`core.fsmonitor=true`) is an unqualified monitor profile. A `link` extension or an effective `core.splitIndex=true` gives reason `split-index` (contract §4 "Split index"). It gates file staging too (contract §4 "File staging"). |
| `location` | `windows`, or `wsl` with the distro name and GUID (contract §11). The header and the repository menu show "WSL: <distro>" for `wsl`. |
| `linuxPaths` | For `wsl` only: the Linux worktree root, Git directory, and common directory that Linux Git reported. The UNC forms above stay the identity paths. |
| `distroState` | For `wsl` only: `running` or `starting`, from the running list at registration (transitions below). |
| `pollState` | For `wsl` only: `waiting`, `polling`, or `paused` (transitions below). |
| `submoduleNotice` | Count and paths of gitlinks that are not initialized or not at their recorded commit (contract §12 "Discovery notice"). Superproject data only. Empty without gitlinks. |

Different linked worktrees have different worktree identities and indexes. They can share one common identity.

Resolve paths through Git before filesystem canonicalization. Never derive paths by appending `.git`. Never lowercase paths as an identity algorithm.

On Windows, the shell supplies every volume and file identity (contract §6). An identity is the 64-bit volume serial number plus the 128-bit file ID. Keep this platform behavior outside shared Git semantics.

A WSL identity is the distro GUID, the UUID-derived file-system ID, and the inode number (contract §11). Both come from `stat`. The Linux device number is not part of it, because it can change between distro starts. A file system without a stable ID gives `UNSUPPORTED_REPOSITORY` with reason `no-fs-uuid`. Only ext2, ext3, and ext4 derive the ID from their UUID. `FileIdInfo` fails on WSL paths. Both prefixes of one folder give one normalized UNC identity, so they give one `repositoryId`. A worktree, Git directory, or common directory on the other side gives `UNSUPPORTED_REPOSITORY` with reason `mixed-location`.

WSL start and poll transitions:

| Current state | Event | Next state and required behavior |
| --- | --- | --- |
| none | Registration or restore of a WSL path; the running list names the distro | `running`. The Git probe runs with the §5 probe deadline. |
| none | Registration or restore; the running list does not name the distro | `starting`. The renderer shows "Starting WSL distro <name>…" with Cancel. The Git probe runs with the 60-second start deadline. |
| `starting` | Git probe succeeds | `running`. Registration continues. |
| `starting` | Cancel through `cancel` with the registration `operationId` | Registration ends `canceled`. The current workspace stays unchanged. The app never stops the distro. |
| `starting` | Deadline or `wsl.exe` failure | Registration ends `failed` with `DEADLINE` or `WSL_UNAVAILABLE` reason `start-failed`. |
| `waiting` | 1 second after the previous poll ends, window focused, and no other read of the workspace runs | `polling`. One `readWorkspace` with `check: "full"`. A poll that falls due during another read starts when that read ends. |
| `polling` | The poll ends | `waiting`. |
| `polling` | A user read needs its read slot | The poll ends `canceled`, then `waiting`. |
| `waiting` or `polling` | Window loses focus | `paused`. A running poll finishes. |
| `paused` | Window gains focus | The focus-return full read runs, then `waiting`. |

Refuse bare repositories and Git administration folders with `UNSUPPORTED_REPOSITORY`. For a bare repository, the remedy is "Open a worktree of it, or clone it". For a Git administration folder, the remedy is "Open the working folder that contains it". Refuse a repository that Git reports with dubious ownership with `DUBIOUS_OWNERSHIP`. Refuse a folder outside every repository with `NOT_A_REPOSITORY` and the remedy "Open a folder inside a Git repository." A discovery probe past its deadline gives `DEADLINE` (contract §5). Other discovery failures use `REPOSITORY_UNAVAILABLE` with the remedy "Run `git status` in this folder". These failures include inaccessible targets and a missing `.git` file target. Opening a repository never creates a worktree or changes Git configuration.

### Stored draft

The renderer owns this record in application-owned webview storage (plan.md "Stored drafts", spec FR-034).

| Field | Meaning and validation |
| --- | --- |
| `worktreeKey` | Record key (above). One record per worktree. |
| `message` | Draft text: at most 64 KiB of UTF-8, no NUL (contract §5 commit message bound). Blank text deletes the record. |
| `draftRevision` | Renderer draft revision of the stored text. A reconciled `succeeded` commit deletes the record only when this revision equals the submitted one. |
| `writtenAt` | Local write time. It selects the record to delete when a new key passes 256 records. |

Each write is one atomic `readwrite` transaction with the durability hint `strict`, so a record is whole or absent. No log, diagnostic, trace, or telemetry holds a message. Clear message deletes the record. The record never grants a Git permission, and a service restart leaves it unchanged.

## 3. Trust approval

| Field | Meaning and validation |
| --- | --- |
| `trustId` | Identifier of the approval in this service session. The stored record persists across launches. |
| `repositoryId` | Approved workspace. |
| `commonIdentity` | Common-directory identity and Git-resolved path that the stored record binds. |
| `worktreeIdentity` | Worktree identity (§2) and Git-resolved worktree root and administration-directory paths that the stored record binds. The store keeps one record per worktree. Approving one linked worktree never changes the record of another. |
| `gitSelectedPath` | Selected Git path (`selectedPath`, §1) that the stored record binds. It is a fully qualified Windows path. The record does not bind the Git executable digest. |
| `configurationFingerprint` | Digest of relevant effective configuration, include origins, attribute policy, and executable integration locations. It also covers the SHA-256 digest of each program or hook file that a repository-controlled integration names. Only files inside the worktree root, the Git directory, or the common directory count. A bare-name program that relative `PATH` entries resolve to a repository file counts too. The bounds are 64 files, 1 MiB per file, and 8 MiB in total (contract §7 "Program file digests"). A file beyond a bound enters as `unchecked`. It is a SHA-256 digest as 64 lowercase hex digits. `readTrust` returns the fingerprint, and a stored record binds it. |
| `persistence` | `stored` or `session`. It is `session` when a digest bound is reached. A session approval lasts until the service session ends: Arbareto closes, or Restart service starts a new session. It writes no record. |
| `approvedExecution` | Explicit approval for repository-controlled hooks, filters, and configured tools. |
| `approvalRequired` | Two flags from contract §7 "Mutation trust": one for reads and one for `commit`. |
| `approvedAt` | Approval time for display and qualification records. The stored record and the handshake keep it as UTC in RFC 3339 form. The UI shows it in local time. |
| `state` | `untrusted`, `approved`, `changed`, or `revoked`. Contract §7 "Trust approval store" derives it from the stored records. |

Approval permits code execution; it does not make repository code harmless. Explain that consequence before approval.

Approval persists across launches in native storage. A native confirmation precedes each approval (contract §7). Over a digest bound, the approval stays in the service session only, and the confirmation states why. The confirmation names both ends: Arbareto closes, or its Git service restarts. The next session then reports `untrusted`. A change of the common or worktree identity, the selected Git path, or the fingerprint gives state `changed` and `TRUST_CHANGED`. A Git upgrade behind the same selected path keeps the approval valid. An edit of a repository-controlled hook or program file changes the fingerprint. Only a renewed explicit approval clears it. Without required approval, `changed` is informational and blocks nothing (contract §7 "Mutation trust"). Revoke trust deletes the stored records of every worktree of that common directory. It also closes the lingering Jobs of that common directory and states how many processes ended (contract §6 "Lingering Jobs").

Configuration changes invalidate approval and dependent selections. Missing approval blocks each operation that can run a repository-controlled integration (contract §7). It never authorizes bypassing required hooks.

The fingerprint omits the submodule registration keys that Git's submodule initialization writes (contract §7 "Submodule registration keys"). So Update submodules keeps a stored approval valid. Programs inside submodules get no stored approval. Each Update submodules run lists them and needs its own native confirmation (contract §12 "Trust").

Custom filters remain outside hunk support and file staging even after trust approval. File unstaging runs no filter, so it stays available for such a path. Do not persist configuration values, hook output, or credentials in logs.

## 4. Change snapshot

| Field | Meaning and validation |
| --- | --- |
| `snapshotId` | Opaque identifier for one validated observation. |
| `repositoryId`, `generation` | Workspace and service generation that produced the observation. |
| `head` | Symbolic target and resolved object ID, including the unborn distinction. |
| `indexFingerprint` | Full-index content digest and Git-derived entries. Include referenced split-index state when applicable. Split-index state comes from the raw index `link` extension, which names the shared index file (contract §4). |
| `indexEntries` | Literal path identity, stage, mode, object ID, and the intent-to-add, assume-unchanged, and skip-worktree flags. |
| `workingVersions` | Selected-path existence, type, mode, raw-byte digest, and normalized content identity. For a file approval in direction `stage`, the digest covers the whole working file within the contract §5 whole-file bound. |
| `policyFingerprint` | Relevant attributes, trust approval, configuration, and Git installation identity. |
| `operationState` | Freshly observed mutation blockers. |
| `completeness` | `complete`, `limited`, or `failed`, with a specific reason. A missing object in a partial clone gives `limited` with `OBJECT_MISSING`; the app never fetches it (contract §7 "Missing objects"). |
| `observedAt` | Observation time. It is not a transaction timestamp. |

Git reads can span external changes. Admit a mutation token only after consistency checks complete.

File timestamps and watcher events are hints. They cannot replace content checks. A raw-byte change invalidates a selection despite identical normalized content.

Index validation covers the whole index, not only the displayed path. Incomplete status or index data cannot authorize a mutation.

### History page

| Field | Meaning and validation |
| --- | --- |
| Repository/generation | Registered workspace and the request `repositoryGeneration`; never an arbitrary renderer revision. The page does not wait for a status snapshot (contract §3 `readHistory`). |
| Captured checkout | Full HEAD OID and symbolic target, including detached or unborn state. |
| Scope | `current-checkout`; at most 100 reachable commit rows. |
| Commit row | Full OID, ordered effective parent OIDs, subject, author, date, and the commit's `encoding` header value or none. |
| Row order | Git child-before-parent date order; no renderer sorting by author timestamps. |
| Boundaries | Explicit outside-page and shallow/unavailable ancestry, with parent IDs where known. |
| Completeness | Complete, limited, or failed data with a specific cause; unknown parents never become roots. |

Resolve shallow metadata through Git and include its bounded fingerprint in read validation. Ordinary parent edges come from Git traversal, not inferred branch membership.

Renderer state owns `selectedOid`, scroll anchor, and derived lane geometry. At most 24 lanes and 4,096 segments can render. Layout overflow retains rows and parent text; it does not change Git eligibility or data completeness.

Graph positions are not Git identities or mutation approvals. Current HEAD/branch labels reflect the captured checkout only. They sit at the start of the subject cell, not in the graph cell. No graph action changes a reference or fetches missing history.

## 5. Change entry and file comparison

| Entity | Fields and rules |
| --- | --- |
| Change entry | `entryId`, literal path bytes, display path, category, source path, modes, object IDs, conflict stages, limitation, and limitation remedy. The remedy is a copyable whole-file command or none (contract §4 "Limitation remedies"). |
| Comparison | `comparisonId`, snapshot, entry, scope, canonical service diff, hunk identifiers, completeness, support decision, and file-action decision. |
| Hunk | `hunkId`, ordinal, old/new ranges, exact canonical hunk digest, and service-owned application data. |
| Support decision | `supported` or an explicit reason: binary, encoding, size, rename, mode, type, symlink, submodule, LFS, filter, state, `line-endings`, `index-flag`, or `path`. |
| File-action decision | `stage`, `unstage`, or a refusal reason from the support-decision list. Contract §4 "File staging" defines the accepted entries and each reason. It is independent of the support decision, so a binary entry can carry `stage`. An `applyFile` result can also carry reason `blob-proof`, which only step 6 gives (contract §4 "Blob proof"). |

An entry identifier distinguishes staged and unstaged entries for the same path. A staged deletion and untracked replacement remain separate entries.

Store Git paths as bytes internally. Display valid Unicode without changing identity. Reject unsupported filesystem encodings without guessing another path. Show invalid UTF-8 path bytes as `\xNN` escapes. Keep the raw bytes as the identity. Such entries get no hunk or file action, with reason `path`.

Compare the working file's on-disk name with the index path bytes. Any difference, such as letter case, refuses hunk and file actions with reason `path`. An entry that the service cannot read, such as a path beyond the Windows limit, also gets reason `path`. In a WSL repository, so does a path with a character that Windows names cannot hold (contract §11). Run this comparison only for changed entries or at request time, never for every tracked entry on each refresh.

Reason `line-endings` applies when `ls-files --eol` reports `mixed` for the index or working side. Reason `index-flag` applies to intent-to-add, assume-unchanged, and skip-worktree entries.

Comparison scopes are `head-to-index`, `index-to-worktree`, and `empty-to-untracked`. An unborn HEAD supplies an empty committed baseline.

Service-generated canonical hunks define selectable boundaries. Renderer row numbers, visual wrapping, highlighting, and virtualization never define mutation boundaries.

The service retains the authoritative hunk data. The renderer receives display data and opaque identifiers, never an executable patch capability.

## 6. Mutation approvals

| Entity | Fields and rules |
| --- | --- |
| Hunk approval | Repository, snapshot, comparison, hunk, direction, exact content bindings, and one-use token. |
| File approval | Repository, snapshot, comparison, entry, direction, and one-use token. It binds the index entry and the HEAD entry of each changed path. For `stage`, it also binds the existence, type, size, and raw SHA-256 of the whole working file. `unstage` binds no working bytes (contract §4 "File staging"). |
| Commit review | Repository, snapshot, complete staged scope, retained reviewed index, HEAD target/OID, execution-policy disclosure, trust, and review token. |
| Commit request | Review token, message, and explicit confirmation of the complete staged scope. The service issues the operation identifier in its accepted response. |
| Submodule review | Repository, snapshot, superproject HEAD, index gitlinks, `.gitmodules` digest, and relevant configuration. The plan rows (§9), each submodule HEAD and `.git` entry, each `modules/<name>` state, and the reachability of each target. It also binds the folder state of each `reuse` row and the refusals. The submodule program list digest, trust, and one-use token. The update checks these values again after an approved run confirmation (contract §12 "Update protocol"). |

Tokens expire on refresh, relevant state change, service restart, or successful consumption. Contract §8 "Token invalidation" defines refresh and relevant state change. After a hunk or file approval expires, the renderer requests the comparison again. It keeps a hunk whose canonical digest stays unchanged, and a file whose entry keeps its category (contract §8). After a submodule review token expires, the renderer requests the review again and keeps the review dialog open. A changed plan shows a notice. A consumed token stays bound to its operation for the rest of the service session. A repeated request with that token returns the operation's state and `operationId` (contract §2). Other expired tokens require a new review or selection.

Reject duplicate submissions while an operation is active. Never retry a mutation automatically after a lost response or service restart.

Commit messages remain in renderer memory after failed, changed, or uncertain outcomes. Track the submitted worktree, draft revision, and message beside the request/operation IDs in renderer memory. These fields do not extend the public commit payload.

Reconciled intended success clears only the matching, unchanged submitted draft. Preserve all later edits, including completion while History is visible. Never clear another worktree's draft. Explicit user clearing remains available.

Reject blank messages, NUL characters, unsupported encodings, and messages above the protocol limit. IME composition blocks submission.

Unsupported diff content can remain in a commit review. Its path, type, and staged identity must remain visible and complete.

A hunk or file approval requires initial and pre-publication validation. The canonical lock protects cooperating index writers, not independent working-file or reference changes.

A file approval stages Git's conversion of the working file, not retained bytes. The service cannot recompute that blob, because Git's conversion can depend on the index. Working-file digests before and after the Git step bind the bytes. Step 6 proves that the staged blob matches those bytes, or the request refuses (contract §4 "Blob proof").

Commit approval authorizes ordinary Git execution after preflight. It is not an immutable future tree, parent, or destination. Retain reviewed index data until reconciliation, even after token consumption or expiry.

Compare actual commit scope through read-only Git inspection against that retained snapshot. The verification copy is never used as the commit index. The selected protocols and remaining qualification are documented in [research.md](research.md).

## 7. Operation and outcome

| Field | Meaning and validation |
| --- | --- |
| `operationId` | Session-unique identifier that the service issues in the accepted event (contract §2). No request creates one; `cancel` and `getOperation` name an issued one. A repeated request with a consumed approval returns the existing state, not another execution. |
| `requestId` | Correlates a request with exactly one terminal response. Every progress event of the operation also carries it (contract §2). A `requestId` repeated within the last 65,536 requests of one service session gives `INVALID_REQUEST` and starts nothing (contract §5). |
| `repositoryId`, `commonIdentity` | Registered target and mutation exclusion group, when applicable. Pre-registration operations use a native bootstrap context. |
| `kind` | One operation from the protocol allowlist. |
| `state` | State from the transition table below. |
| `phase` | Bounded operation phase, including preflight, candidate verification, publication, commit handoff, submodule confirmation, and reconciliation where applicable. Registration and restore of a WSL path add `wsl-starting` (contract §11). Update submodules progress names its phase `fetch` or `update` (§9). |
| `stalled` | `commit` and Update submodules only. True while the running Git process has shown no output byte and no I/O change for 15 seconds. The next activity sets it false. Progress events carry it. The renderer then shows the stall notice with Cancel and one command (contract §6 "Activity and stall notice"). It changes no state and no deadline. |
| `stallRemedy` | Set only while `stalled` is true. The command of the running step and its text, built by the contract §4 quoting rule. A refused value leaves the text without a command. `getOperation` returns it, and no progress event carries it (contract §2, §6). The next activity clears it. |
| `ownedProcesses` | Native process handles and operation Job identity. Never process-name matching. After a mutation ends, a Job with remaining processes becomes a lingering Job (contract §6 "Lingering Jobs"). It closes when it is empty or the application closes. A WSL operation also owns its systemd user scopes `arbareto-<operationId>-<n>.scope`, which every Job close ends (contract §11). |
| `lingeringDescendants` | Mutation outcomes only. The count of owned processes that still ran when the last execution process exited. It comes from the shell's `activeDescendants` exit reply. For a WSL mutation, the anchor count supplies it (contract §11). It is 0 when a cancellation during `reconciling` or a revoke ends them (contract §6). No process name, PID, or argument. |
| `limits` | Output, duration, concurrency, and framing limits from the protocol. |
| `result` | Typed success, refusal, failure, limit, interruption, or unknown-state result. An `unknown` result names its attribution reason: `ambiguous`, `evidence-limit`, or `no-retained-request`. A hunk or file recovery names its index match: `published`, `not-published`, or `neither` (contract §8). Contract §9 maps each terminal state to its result code. |
| `effects` | Reconciled HEAD, index, working-file, and operation-state differences. It is an object with exactly four boolean fields: `head`, `index`, `workingFiles`, and `operationState`. `true` means that category changed. |
| `diagnostic` | Bounded error code and safe explanation. No raw environment, repository content, or credentials. |
| `outputTail` | Three carriers only. A commit that ends `failed`, `failed-with-effects`, or `unknown` carries it (contract §9). So does a failed `applyFile` `stage` step, and each row of a failed Update submodules process. The sanitized, redacted end of the commit process stderr, with hook output. It holds at most 16 KiB and 100 lines (contract §9 "Commit failure output"). A failed `stage` step takes it from the stderr of its `update-index` process. Plain text for display. Never logged or persisted. A failed Update submodules process gives its row its own tail by the same rules (contract §12 "Output tail"). |
| `submoduleResults` | Update submodules only. One result per plan row and per row that the run added. Each holds the row ID, path, state, old and new commit, and the flags `fetched`, `connected`, `found`, and `registered`. A failed process adds its `outputTail` and remedy. A failed read adds the name of that read. A refused row adds its reason, text, and remedy or none (§9). |

### State transitions

| Current state | Event | Next state and required behavior |
| --- | --- | --- |
| `accepted` | Valid read | `running`. |
| `accepted` | Mutation exclusion unavailable | `rejected`; do not queue an old approval. |
| `accepted` | Invalid approval, trust, or state | `rejected`; no process starts. |
| `accepted` (mutation) | The shell replies to `started` with the marker ID | `running`. The approval, trust, and state checks passed, and the mutation exclusion is held. The shell flushed the marker file before its reply. No lock and no Git process exist before this step. The rechecks under the canonical index lock run in `running` (contract §4, §6 "Recovery markers"). |
| `accepted` (mutation) | The shell replies to `started` with `busy` or a failure class | `rejected` with `BUSY` or `RECOVERY_MARKER_FAILED`. Release the mutation exclusion. No lock and no Git process start (contract §6, §9). |
| `running` | Cancellation request | `cancel-requested`; signal only owned processes. |
| `running` | Read completes | `succeeded`, `limited`, or `failed`; check generation before display. |
| `running` | Mutation finishes or fails | `reconciling`; keep further mutations blocked. |
| `running` (read) | Read deadline expires | Close the operation Job, refresh relevant state, then `failed` with `DEADLINE`. |
| `running` (Update submodules) | The submodule program confirmation is declined | `canceled`. No update process starts, and the recovery marker is resolved. |
| `running` (Update submodules) | The re-check after an approved program confirmation finds a change | `failed` with `STALE_REVIEW` or `TRUST_CHANGED`. The review token stays consumed. No update process starts, no reconciliation runs, and the recovery marker is resolved (contract §12 "Update protocol" step 3). |
| `running` (`commit` or Update submodules) | The running Git process shows no activity for 15 seconds | Stay `running`. Set `stalled`, and show the stall notice. The next activity clears it. No deadline changes (contract §6 "Activity and stall notice"). |
| `running` (Update submodules) | A check, the clone check, a program re-check, or a level read finds a refusal | Stay `running`. That row ends `refused`, and no later process starts for it or its nested rows. A program re-check before a nested active-set read refuses the rows of that level instead. The other rows continue (contract §12 "Refusals during the run" and "Trust"). |
| `running` (Update submodules) | A check, `remote get-url`, or folder read fails | Stay `running`. That row ends `failed`, and no process starts for it or its nested rows. The other rows continue. The outcome counts the failure like a failed process (contract §12 "Update protocol", read failures). |
| `running` (Update submodules) | A level read fails | Stay `running`. Each listed nested row of that level ends `failed`, and no process starts below them. The parent row keeps its state (contract §12 "Update protocol", read failures). |
| `running` (Update submodules) | An update process passes its inactivity deadline or ceiling | Close the operation Job at once, with every descendant. Start no later update process. Then `reconciling`, with `DEADLINE` and reason `inactivity` or `ceiling` (contract §12). |
| `running` (mutation) | A Git step, preflight read, or commit process deadline expires | Close the operation Job at once, with every descendant. Then `reconciling`, with `DEADLINE` as the recorded cause. Reconciliation classifies the outcome from observed state (contract §4, §5 "Deadline outcomes"). |
| `cancel-requested` (mutation) | Processes stop or deadline expires | `reconciling`. |
| `cancel-requested` (read) | Owned processes stop | Refresh relevant state, then `canceled`. |
| `cancel-requested` (read) | The read deadline expires first | Close the operation Job, refresh relevant state, then `failed` with `DEADLINE`. |
| `reconciling` | Intended effects confirmed | `succeeded`, including completion after a late cancellation request. |
| `reconciling` | No effects confirmed | `canceled` or `failed`, according to the observed outcome. |
| `reconciling` | Execution completed with differing observed effects | `completed-with-effects`; identify grounded results, preserve the draft, and require fresh review. For Update submodules, a `refused` row is such a difference, also when no row changed (contract §12 "Reconciliation and outcome"). |
| `reconciling` | Failed/interrupted execution left effects | `failed-with-effects`; report actual state without rollback or retry. |
| `reconciling` | State or commit attribution cannot be determined | `unknown`; keep mutations blocked and keep the recovery marker. |
| `reconciling` | Cancellation request | Stay `reconciling`. Reconciliation reads continue under their own deadline. `ended` carries `endProcesses`, so every process that Git or a hook started ends, and `lingeringDescendants` is 0 (contract §8). |
| `reconciling` | A reconciliation read deadline expires | Close the operation Job with every descendant. `unknown`; keep mutations blocked and keep the recovery marker. |
| `reconciling` | Interrupt and close | Close the operation Job at once, then follow application close (contract §6). No terminal response follows, and the recovery marker stays. The next start shows the workspace `unknown`. |
| Terminal mutation state, Job lingering | `revokeTrust` for its common directory | The shell closes that lingering Job. The `revokeTrust` result states how many processes ended. |
| `running`, `cancel-requested`, or `reconciling` (mutation) | `revokeTrust` for its common directory | The operation continues; revocation cancels nothing. `ended` carries `endProcesses`, so its Job never lingers. |
| `unknown` | Explicit recovery refresh completes recovery reconciliation (contract §8) | Workspace becomes `ready`. The refresh result states the prior outcome, also an `unknown` attribution. The recovery marker is resolved. Prior tokens remain invalid. |
| `unknown` | A status-only read succeeds, or recovery reconciliation fails (contract §8) | Remain blocked. A status-only read cannot release this gate. |
| none | Registration or restore matches an unresolved recovery marker | Workspace starts `unknown`. Without a retained request, its recovery refresh reports reason `no-retained-request`. |
| none | Registration or restore in a session after Restart service | Workspace starts `unknown` (FR-023). Only a `refresh: true` read in that session releases it (contract §8 "Service restart"). |

Keep required verification data while recovery remains blocked. Apply the contract's aggregate reference/reflog byte and record limits to each reconciliation attempt.

A process exit code does not determine mutation success. Inspect Git state and working-file bytes before reporting the result.

On closure during mutation, offer staying open or interrupting and closing. Lingering Jobs alone cause no prompt, and closure ends their processes. After restart, obtain fresh Git state before accepting mutations. A recovery marker keeps an unresolved outcome across restart (contract §6). After Restart service, every workspace stays `unknown` until an explicit refresh in the new session (FR-023). The renderer runs `restoreWorkspace` again, because old identifiers stay invalid.

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

A scenario record result is only `pass`, `fail`, or `unverified`. A record whose only evidence is source inspection stays `unverified`, and its evidence column names `source-inspected`. The research.md R10 evidence-group table may use that label as a status. Source inspection never passes a packaged Windows scenario.

## 9. Submodule plan and outcome

Update submodules binds a reviewed plan (contract §12). The plan lives in the service session. A service restart invalidates its token, as §6 states.

| Entity | Fields and rules |
| --- | --- |
| Plan row | Opaque row ID, literal path bytes, display path, name, depth, and parent row. Redacted URL, current HEAD or none, and target commit or unknown. A `reuse` or `fetch-checkout` row adds each redacted remote URL of the submodule. It marks the default remote (contract §12 "Plan"). Action, notes, and refusal reason or none. |
| Action | `clone`, `reuse`, `checkout`, `fetch-checkout`, `none`, or `skip` (contract §12 "Plan"). A row fetches when no ref or HEAD of the submodule reaches its target, as in Git's own update. An unregistered `skip` row with update mode `none` in the active set gets only the register step. Nested rows of a parent whose target commit is missing locally carry target unknown. |
| Refusal reason | `unsaved-commits`, `update-mode`, `clone-interrupted`, `folder-not-empty`, `no-url`, `path`, `remote-name`, `gitdir-config`, or `limit`, with the code `UNSUPPORTED_SUBMODULE` (contract §12 "Refusals"). One refusal at the review blocks the whole update. Every ref counts. The review lists `update-mode`, `gitdir-config`, and `limit` after the others. During the run, a refusal stops only its row and that row's nested rows. The reasons `programs` and `changed-after-review` exist only then (contract §12 "Refusals during the run"). |
| Submodule program | Row ID or kept Git directory, key, scope, origin, and program path or hook file. Each has its digest, `absent`, or `unchecked`. Kept Git directories count (contract §12 "Review reads"). A relative value from any scope can name a file that the update writes. It then gives one `unchecked` entry per such row (contract §12 "Trust"). Values show only for the contract §7 value display allowlist. URL user information is redacted. |
| Row result | Row ID, state, old and new commit, and for a failed process its `outputTail` and remedy. The states are `cloned`, `moved`, `unchanged`, `failed`, `clone-interrupted`, `changed-elsewhere`, and `refused` (contract §12 "Reconciliation and outcome"). A `clone-interrupted` row carries the folder path and the move-out remedy. A `refused` row carries its reason, text, and remedy or none. An `unsaved-commits` refusal from the clone check carries no command (contract §12 "Update protocol" step 5). The flag `fetched` is true when a fetch step of the row started. The flag `connected` is true when a clone step, a connect step, or a `reuse` checkout step started. The flag `found` is true when the review did not list the row. The flag `registered` is true when reconciliation finds a `submodule.<name>.*` key of the row changed since its baseline. The baseline is the preflight value, or for a nested row without one, the value from its level read. A key that the baseline lacks counts as a change (contract §12 "Reconciliation and outcome"). `fetched`, `connected`, and `registered` count as effects (contract §12 "Reconciliation and outcome"). A failed read gives state `failed` with the name of that read and no remedy. |
| Progress | The contract §2 identity fields, row index, row count, row ID, phase `fetch` or `update`, percentage or none, and the `stalled` flag (§7). No Git text (contract §12 "Progress"). |

The plan never authorizes a change that Git would not make. It names what Git does for the reviewed state. Git remains authoritative, and reconciliation reports the observed result of each row.

The service keeps the retained plan, with the rows that the run adds, until reconciliation succeeds (contract §5). A refresh during recovery compares each row with it (contract §8).
