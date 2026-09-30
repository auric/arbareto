# Operation Contract: Windows Desktop Qualification

**Protocol version**: `1` | **Model**: [data-model.md](../data-model.md) | **Plan**: [plan.md](../plan.md)

This contract defines selected behavior, not implemented endpoints. Hunks use protected candidate publication; commits use the explicitly approved standard Git handoff. Validation checkpoints do not promise repository-wide atomicity.

## 1. Transport and authority

Use typed Tauri commands/channels between the main local webview and Rust. Register application commands through Tauri's application ACL manifest.

Grant only the operations below to the main local window. Deny remote webviews, shell execution, broad filesystem access, and unregistered application commands.

Rust and the compiled service use private inherited pipes. Frames contain a four-byte unsigned little-endian payload length followed by UTF-8 JSON.

Each pipe frame has a top-level `kind` field with the value `public`, `process`, `mutation`, or `trust`. A `public` frame holds one §2 request, its response, or a progress event. A `process` frame holds one §6 process request, one §6 identity request, or their output. A `mutation` frame holds one §6 recovery-marker message. A `trust` frame holds one §7 trust-store message. The shell never forwards a `process`, `mutation`, or `trust` frame to the renderer. The renderer envelope in §2 has no `kind` field.

Reject oversized lengths before allocation. Reject invalid UTF-8, malformed JSON, duplicate object keys, excessive nesting, unknown fields, and unsupported protocol versions.

Use a strict bounded decoder. Do not rely on `JSON.parse` alone to reject duplicate keys.

The service owns Git arguments, parsing, snapshots, approvals, and outcomes. The renderer never supplies patches, revspecs, shell commands, executable paths, environments, or process IDs.

Native dialogs return selections to trusted registration code. Only registration can issue repository and Git-installation identifiers.

The public bridge is not a generic message bus. Its operation discriminator is a closed allowlist.

## 2. Envelope

| Field | Request rule |
| --- | --- |
| `version` | Integer `1`. |
| `sessionId` | Opaque service-session identifier. The service issues it in the shell-service startup handshake. The page receives it as the session paragraph below states. |
| `requestId` | Bounded identifier for response correlation. It is unique in the service session. A repeated `requestId` gives `INVALID_REQUEST` and starts nothing. |
| `operation` | One exact operation name from the table below. |
| `repositoryId` | Registered workspace identifier when required. |
| `repositoryGeneration` | Nonnegative safe integer for snapshot-bound operations. It must match the supplied snapshot, review, or trust fingerprint. For `readHistory`, it must equal the current workspace generation. |
| `selectionId` | Renderer selection generation for selection-dependent reads. Never a mutation approval. |
| `payload` | Exact operation-specific object. Reject unknown fields. |

Identifiers are UUID-shaped ASCII strings issued by the owning boundary. Validate format and session membership. Format alone never grants access.

Require `repositoryGeneration` for `readHistory`, `readComparison`, `applyHunk`, `reviewCommit`, `commit`, and `approveTrust`. Match trust approval against its issued fingerprint generation.

`readWorkspace` may include the last observed generation, but a mismatch must not prevent refresh. Other operations omit this field. Cancellation, revocation, and closure must remain available after a repository generation changes.

Responses contain `requestId`, `operationId`, repository generation where applicable, and a typed result. Only one terminal result exists per accepted request.

The service issues `operationId` in the accepted response. No request supplies a new `operationId`. Only `cancel` and `getOperation` name an issued one.

Progress events contain operation identity, phase, and bounded counters. They contain no raw commands, configuration, environment, patch content, or credentials.

The repeat key of a mutation is its one-use approval. For `commit`, the key is the review token. For `applyHunk`, the key is the hunk approval: comparison ID, hunk ID, and direction. A repeated request with an approval that an accepted operation consumed returns that operation's state and `operationId`. It starts no Git process and no other execution. A new service session invalidates all old identifiers.

The service checks `requestId` before the repeat key. A repeated `requestId` gives `INVALID_REQUEST`, also when its approval was consumed. A retry after a lost response must use a new `requestId`. It then gets the consumed-approval state.

The shell starts the service and completes the startup handshake before it creates the main window. When the native settings hold a Git path, the handshake carries a startup `gitProbe` context for it (§6 "Startup contexts"). The page gets the current `sessionId` from the shell-only operation `currentSession` (§3). It calls `currentSession` at load and after each `service-session` event. `currentSession` is the only request without a `sessionId` field. No public operation carries a handshake, and no initialization script carries a session. Pinned Tauri sets initialization scripts only on builders, so a created window keeps its first script (research R7). When the service start or handshake fails, the shell still creates the window. `currentSession` then returns `SERVICE_UNAVAILABLE`, and the shell shows Git service stopped.

The shell may start the service process before it reads the platform facts, the WebView2 version, and the settings. It sends the handshake frame once those facts exist. The main window still waits for the handshake reply. When WebView2 admission fails, the shell closes the service Job and creates no window. The service answers the handshake before its startup Git probe ends (§6 "Startup contexts"). So window creation and page load overlap that probe.

The shell sends two events to the main window. `service-stopped` reports a service exit and the unresolved recovery markers (§6). The page marks each request without a terminal response as State unknown. `service-session` reports a new service session after Restart service. The page does not reload for a restart. Drafts are renderer state, so they survive a service restart. After each `service-session` event, the page runs `restoreWorkspace` again, because old identifiers stay invalid (§8 "Service restart"). A reloaded page joins the current service session through `currentSession`. Only Restart service or application start creates a new service session. Identifiers from an old session stay invalid in the new one.

## 3. Public operations

| Operation | Payload | Result and checks |
| --- | --- | --- |
| `getEnvironment` | Empty object. | Build identity, detected and minimum versions, selected Git, prerequisite admission, and separate qualification status. The qualification status is `passed` only when the detected version set is on a build-time list. That list holds the sets with recorded passing evidence. This slice ships that list empty, so the status stays `unverified`. Platform scope `qualification-target` for Windows 11 x64 on a native AMD64 machine with product type `VER_NT_WORKSTATION`, otherwise `other`. The recovery markers that the shell owns at session start (§6, §8). No environment dump. |
| `chooseGit` | Renderer: empty object. Service: only the native-issued `bootstrapId`. | Native executable proposal or selection, explicit approval, version probe, and installation ID. Cancel preserves the current selection. "Git proposal" below defines the native step. |
| `chooseRepository` | Renderer: empty object. Service: only the native-issued `bootstrapId`. | Native folder selection and Git registration. The result holds the `repositoryId` and the current `generation`. Cancel preserves the current workspace. |
| `restoreWorkspace` | Renderer: empty object. Service: only the native-issued `bootstrapId`. | Revalidate the last explicitly chosen repository from application settings. No caller-supplied path. The result holds the `repositoryId` and the current `generation`. |
| `readWorkspace` | `refresh: boolean` and `check: "full"` or `"changes"`. `refresh: true` with `check: "changes"` gives `INVALID_REQUEST`. | Git-derived identity, HEAD, operation state, status completeness, hunk-profile eligibility, snapshot ID, and recovery state. Only a user Refresh action sends `refresh: true`, always with `check: "full"`. Focus return and the first read send `refresh: false` with `check: "full"`. The read after a mutation outcome and the read after a trust approval also send `refresh: false` with `check: "full"`. Polls send `refresh: false` with `check: "changes"` (§8 "Change check"). An explicit refresh of a blocked workspace performs recovery reconciliation (§8). |
| `readHistory` | Empty object. The envelope carries `repositoryGeneration`. | Bounded HistoryPage: at most 100 checkout-reachable commits, ordered parents, boundary metadata, captured HEAD, and completeness. No arbitrary ref or pagination argument. The service captures HEAD itself and needs no status snapshot. It can run beside `readWorkspace` within the §5 read caps. Trust gating follows the read rule in §7. |
| `readComparison` | Current snapshot ID and issued entry ID. | One supported canonical comparison with hunk IDs, or an explicit unsupported/limited result. |
| `readTrust` | Current repository ID. | Safe execution-policy summary, approval fingerprint, trust `state`, and `persistence` (`stored` or `session`). Show configuration values only for the §7 value display allowlist. Redact URL user information first (§7). |
| `approveTrust` | Issued fingerprint and explicit approval. | The service checks the fingerprint and its generation. The shell then shows a native confirmation (§7 "Trust approval store"). Approve returns the trust ID. It stores the approval, or keeps it for this session only over a digest bound (§7). Cancel returns `canceled` and stores nothing. A changed policy requires new approval. |
| `revokeTrust` | Current trust ID. | Delete the stored approval, revoke future executable operations, and invalidate dependent approvals. Running work needs explicit cancellation. |
| `applyHunk` | Comparison ID, hunk ID, snapshot ID, and direction `stage` or `unstage`. | Profile check, fresh validation, exact candidate publication, and reconciled outcome. No renderer patch or whole-file fallback. |
| `reviewCommit` | Current snapshot ID. | Complete staged scope, reviewed index/checkout, execution-policy disclosure, limitations, and one-use review token. Read-only inspection only. |
| `commit` | Review token, message, and explicit full-scope confirmation. | Fresh preflight, one ordinary canonical Git commit invocation, and a reconciled outcome: `succeeded`, `completed-with-effects`, `failed`, `failed-with-effects`, `canceled`, or `unknown`. A repeated `commit` with a consumed review token returns the existing operation state and `operationId`, and starts no Git process. |
| `cancel` | Issued operation ID. | Cancellation-requested acknowledgement followed by the actual terminal outcome. |
| `getOperation` | Issued operation ID. | Current or retained terminal state. Never retries an operation. |
| `requestClose` | `stay`, `closeIfIdle`, or `interruptAndClose`. | The shell decides natively and never forwards this operation to the service. A running mutation always shows the native prompt, whose default is Stay open. Only its Interrupt and close button confirms interruption. |
| `currentSession` | Empty object. The envelope has no `sessionId`. | The shell answers natively and never forwards this operation to the service. The result is the current `sessionId`, or `SERVICE_UNAVAILABLE` while no service session runs. |
| `dismissRecoveryMarker` | Renderer: one marker ID from `getEnvironment` or `service-stopped`. Service: that marker ID and the native-issued `bootstrapId`. | Explicit removal of a marker whose repository is gone (§6 "Dismissal"). The result states that the operation outcome stays unknown. |

The native dialog and confirmation code must not accept renderer-supplied replacements for selected paths or approval fingerprints. The trust confirmation shows only the fingerprint that the service sends.

The shell runs the native step of `chooseGit`, `chooseRepository`, and `restoreWorkspace` first. A canceled dialog returns a canceled result from the shell, and no frame reaches the service. Otherwise the shell forwards the request with its native-issued `bootstrapId` in the payload. The renderer payload must be empty, and the shell rejects any renderer field.

**Git proposal.** The native step of `chooseGit` first looks for a candidate `git.exe`. With a saved path, the candidate is that path. Without one, the shell searches its own `PATH` for `git.exe`, then tries `%ProgramFiles%\Git\cmd\git.exe`. The shell creates a `gitProbe` context for the candidate, and the service probes it. The native Git selection confirmation then shows the probed path and version. After `GIT_CHANGED` at the saved path, it also shows the stored version (data-model §1). Its buttons are Use this Git, Choose another Git, and Cancel, and Cancel is the default. Choose another Git opens the executable picker. Enter on the default, Escape, Alt+F4, the close button, and a call failure mean Cancel. Without a candidate, the picker opens directly. No candidate is ever selected without Use this Git (FR-003).

For `dismissRecoveryMarker`, the renderer payload holds only a marker ID that the shell owns. The shell binds a `repositoryDiscovery` context to the stored worktree path of that marker. It forwards the marker ID with the `bootstrapId`. The native confirmation comes after the service result (§6 "Dismissal").

Blank messages, empty staged scope, conflicts, unfinished operations, stale snapshots, and incomplete data refuse mutation. Missing trust refuses a mutation only when it can run a repository-controlled integration (§7 "Mutation trust").

Commit approval covers the full staged scope. It never means “commit the selected file”. Unsupported file diffs can remain in a complete commit review.

Approval authorizes standard Git execution after fresh preflight, not an immutable tree or destination. Preserve approved hooks and report late changes explicitly.

### HistoryPage result

Bind the result to its repository, the request `repositoryGeneration`, the captured HEAD target/OID, the shallow fingerprint, and scope `current-checkout`. The renderer keeps a page while its captured HEAD equals the newest observed HEAD. A generation change alone does not discard it. The renderer accepts a late history response when its captured HEAD equals the newest observed HEAD, whatever its generation. When a read observes another HEAD, the renderer requests `readHistory` once. After `REPOSITORY_CHANGED` for `readHistory`, the renderer resends it once with the current generation. Each row contains a full OID, ordered effective parent OIDs, subject, author, and date. It also carries the commit object's `encoding` header value, or none when the header is absent.

Use Git's child-before-parent date order. OID lengths follow the repository object format. Reject duplicate rows, malformed OIDs, and invalid in-page parent ordering.

Return separate page-boundary and shallow-boundary metadata. An unavailable parent is not a root. Show current HEAD/branch only from the captured identity; do not invent branch ownership for commits.

Resolve shallow metadata through Git and recheck its bounded fingerprint with the captured checkout. Missing objects produce limited/error state without fetching. Graph-only layout limits remain frontend presentation state, not workspace mutation blockers.

## 4. Snapshot and hunk rules

A comparison binds these values:

- Git installation and physical repository/worktree/common-directory identities.
- HEAD symbolic target and object ID, including the unborn distinction.
- Complete index state and any shared-index dependency.
- Selected entry identity, category, mode, stage, and blob identity.
- Raw working bytes, existence, type, and applicable normalized content.
- Relevant attributes, effective configuration, trust approval, and repository operation state.
- Canonical service diff and selected hunk identity.

Mismatches reject the selection and require refresh plus reselection. Do not relocate or reinterpret it silently.

Do not accept raw patch text or line ranges from the renderer. Validate that the hunk belongs to the requested comparison and direction.

Preserve additions, deletions, empty blobs, and absent entries distinctly. A metadata-only empty-file change has no selectable text hunk.

Support valid UTF-8 LF/CRLF content within the specified limits. Reject binary, invalid encoding, rename, mode/type, symlink, submodule, LFS, custom-filter, and encoding-conversion hunk requests. Also reject hunk requests for intent-to-add, assume-unchanged, and skip-worktree entries.

**Limitation remedies.** An unsupported entry can still need staging or unstaging as a whole file. The service then attaches a copyable remedy command to the change entry. The app never runs it and offers no stage action for it (FR-011).

- Reasons `binary`, `encoding`, `size`, `rename`, `mode`, `type`, `symlink`, `LFS`, `filter`, and `line-endings` get a remedy. Other reasons get none.
- An Unstaged or Untracked entry gets `& '<selected Git path>' --literal-pathspecs -C '<worktree root>' add -- '<path>'`.
- A Staged entry gets the same form with `restore --staged -- '<path>'`. In an unborn repository, it uses `rm --cached -- '<path>'`, because `restore --staged` needs HEAD.
- A staged rename names the source path and the destination path.
- Each `'` inside a value is doubled, as in the §9 hook remedy. `--literal-pathspecs` keeps path characters literal.
- A path with bytes that are not valid UTF-8 gets no remedy, because PowerShell cannot hold those bytes.
- The remedy text is: "This command stages or unstages the whole file with your Git settings. Run it in a terminal."

Disable executable external diffs and text conversion for supported inspection. Ordinary Git EOL conversion remains distinct from custom filters.

For tracked entries, generate hunks as `git add -p` does: `diff-files` to stage, `diff-index --cached` to unstage. Git's diff demotes a `core.safecrlf` failure to a warning, so hunks follow `git add -p`, not `git add`. Refuse a hunk request when `ls-files --eol` reports `mixed` for the index or working side.

Pierre may parse the canonical service patch for display. If display mapping disagrees with service hunks, disable actions and report `DISPLAY_MAPPING_FAILED`.

### Hunk eligibility and publication

Require an ordinary full index. Refuse unqualified sparse/split indexes, registered `post-index-change` hooks, and executable fsmonitor integrations. A split index is an index with a `link` extension in its raw bytes (Git `Documentation/gitformat-index.adoc`). The service reads that extension itself and never asks Git for the shared index path (§6). Also refuse the built-in fsmonitor daemon (`core.fsmonitor=true`), because this slice has not qualified it. Hook discovery includes disabled registrations; this slice conservatively refuses every index-change registration.

Return `UNSUPPORTED_HUNK_PROFILE` with a safe explanation. Never bypass those integrations or change user configuration. Index-change registrations block hunk publication only; ordinary commits still respect approved hooks.

Hold the exclusively created canonical index lock through candidate preparation, verification, and publication. Revalidate the complete snapshot and profile before preparing the candidate.

Use an owned private index and service-retained Git patch. Apply through `git apply --cached`, reversing the selected staged hunk for unstaging. Create a missing empty candidate through Git, not a malformed zero-byte index.

Verify exact candidate bytes, entry existence, mode, stage, and unrelated logical index entries against the independent expected result. Applicability, full-index headers, or a second apply test are insufficient.

Before publication, recheck canonical index bytes, working content, checkout, attributes, configuration, trust, and operation state. Every detected mismatch prevents publication. Honor cancellation before publication begins. Publish only the verified candidate through the owned lock's same-volume replacement.

Supported processing does not write working-file content. The lock excludes cooperating index writers, not every independent file/ref/configuration change. Report observed late changes and preserve external bytes without undo or retry.

Unexpected candidate effects prevent publication and require reconciliation. Remove only known owned temporary resources after their processes stop. Unknown ownership or publication state requires explicit recovery, not forced cleanup.

### Commit validation and handoff

Review the complete staged scope through read-only inspection and retain a bounded index snapshot. Do not use `write-tree` or trial commits to produce the review. The review token binds current index/checkout/policy observations, not an immutable future commit.

Enter the mutation exclusion and wait for the recovery marker ID (§6), as hunk publication does. Then obtain the canonical index lock for final preflight. Compare the reviewed index, HEAD target/OID, operation state, configuration, and trust. Refuse any detected mismatch; consume the one-use token only after validation.

Preflight reads the effective `i18n.commitEncoding`. A value that Git does not treat as UTF-8 refuses handoff with `COMMIT_ENCODING_UNSUPPORTED`. Git treats an unset value, `utf-8`, and `utf8` in any letter case as UTF-8.

Release that lock before invoking ordinary `git commit --file=-` on the canonical index. Handoff begins at lock release. A new mismatch detected before process start still refuses execution.

Supply only the bounded message on stdin. Do not add paths, `--all`, `--amend`, hook bypasses, signing overrides, injected hooks, or private-index commit semantics.

Git can reread its index after hooks and captures its own HEAD. Changes after handoff may affect the actual tree, parent, or destination. Postchecks report those effects; they do not prevent them retroactively.

After Git updates HEAD, `git commit` runs automatic maintenance and then the `post-commit` hook. Source reasoning says that maintenance runs in the foreground inside the commit process on Git for Windows (research R4). T100 verifies this; until then it is unverified. In that case, the 120-second commit deadline covers maintenance. A deadline interruption at that point leaves a created commit. Reconciliation classifies the outcome from observed state (§8). A lock or temporary file that the interrupted process left is foreign (§8).

If maintenance detaches, its process stays in the operation Job, because the Job forbids breakaway (§6). Reconciliation classifies the commit from observed state while that process can still run. It names each maintenance lock or temporary file that it observes as foreign (§8). The operation Job closes when the operation ends, after reconciliation. That close ends the detached maintenance and every other remaining descendant, such as a `post-commit` hook child.

Compare the resulting tree against the retained reviewed index using bounded read-only Git inspection. A verification copy never becomes the commit index. Check actual parent, destination, index, relevant working bytes, and operation state before classifying the result.

## 5. Finite bounds

The first reached bound wins. A bound cannot turn an incomplete result into a successful complete result.

| Resource | Limit |
| --- | ---: |
| Incoming public request | 1 MiB encoded |
| Private/reply frame | 16 MiB encoded |
| JSON nesting | 16 levels |
| Identifier | 64 ASCII bytes |
| Commit message | 64 KiB UTF-8; no NUL; nonblank |
| Compared raw version | 1,048,576 bytes per side |
| Compared normalized version | 1,048,576 bytes per side |
| Canonical diff | 20,000 lines and 4 MiB raw patch bytes |
| Status or index listing | 32 MiB and 100,000 records |
| Raw index eligible for mutation | 64 MiB, including validated dependencies |
| Commit attribution evidence | 4 MiB and 10,000 reference/reflog records, aggregated across all streams and references per reconciliation attempt |
| History traversal stream | 100 commit rows and 128 KiB |
| History parent references | 64 per commit and 1,024 per page |
| Shallow-boundary metadata | 4 MiB |
| History commit object | 256 KiB per object |
| History object payload total | 32 MiB |
| Frontend graph layout | 24 simultaneous lanes and 4,096 SVG path segments; explicit row-only fallback |
| Effective configuration/trust input | 4 MiB; overflow blocks execution approval |
| Trust program file digests | 64 files, 1 MiB per file, and 8 MiB total (§7 "Program file digests"). Overflow permits only a session approval without a stored record |
| Diagnostic bytes retained | 64 KiB per stream, never persisted as raw logs |
| Total unexpected diagnostic output | 4 MiB per operation before cancellation |
| Native stdout/stderr chunk | 64 KiB |
| Queued pipe data | 8 chunks per stream; apply backpressure |
| Registered workspaces | 8 at one time per service session. Reuse and release follow §6 "Registration reuse and release". |
| Trust approval records | 4 KiB per record and 256 records. A new record above 256 replaces the oldest record. |
| Retained comparison data | 4 comparisons and 128 MiB total |
| Approval lifetime | 60 seconds; relevant changes invalidate it sooner |
| Concurrent reads | 2 per workspace, 4 globally |
| Pending reads | 8 globally; superseded selection reads are canceled |
| Mutations | 1 per common repository; reject overlap without queueing old approvals |
| Ordinary read deadline | 30 seconds |
| Commit process deadline | 120 seconds, followed by interruption and reconciliation |
| Cancellation/reconciliation target | 5 seconds; report unknown if state cannot be confirmed |
| Recovery markers | 4 KiB per marker and 64 markers per handshake. Above 64, the shell loads the 64 oldest markers. `getEnvironment` reports the limit and the count of files that the shell did not load. Every mutation stays blocked with `STATE_UNKNOWN`. Dismissal (§6) stays available. The block ends at the next handshake that finds at most 64 marker files. |
| Confirmed-close cleanup target | 5 seconds |

Count canonical patch lines once, including file and hunk headers. Ignore only the empty segment after a final newline. Split view and virtualized rows do not change this count.

Transmit the canonical patch as bounded base64 UTF-8 bytes. This prevents JSON escaping from invalidating raw-byte accounting. Validate decoding before strict patch parsing.

Render limited status/history with a visible explanation. Block mutations that depend on an incomplete status, index, trust, or comparison snapshot.

Use streaming decoders and counters. Do not collect unbounded `text()` or `arrayBuffer()` results. Cache eviction invalidates associated approvals.

Retain an accepted operation's reviewed index snapshot until required reconciliation succeeds, including while unknown state blocks recovery. An accepted `applyHunk` retains the raw digests of its verified candidate and of the canonical index before publication. Approval expiry must not delete required verification data. Use bounded owned files when retaining index bytes would exceed memory budgets.

## 6. Private native process requests

Only the compiled service can use this private channel. No public Tauri command exposes it.

### Registration bootstrap

The native shell creates temporary contexts for `chooseGit`, `chooseRepository`, `restoreWorkspace`, and `dismissRecoveryMarker`. It also creates one for the saved Git path at each startup handshake ("Startup contexts" below). A context binds the selected path, physical identity, session, permitted probe, and expiry.

Every physical identity is native: the 64-bit volume serial number and the 128-bit file ID from `GetFileInformationByHandleEx` with `FileIdInfo`. The 64-bit file ID is not unique on ReFS, FAT, or exFAT (research R2). The service never reads an identity through Bun `fs.stat`. It sends an identity request (below) for each Git-resolved path. An all-zero or all-ones file ID, or a failed call, refuses registration with `UNSUPPORTED_REPOSITORY`. The remedy is: open the repository from an NTFS or ReFS volume.

The renderer cannot supply or replace those paths. Restoration uses only the application-owned last-selection setting and requires fresh validation.

**Startup contexts.** Two saved selections need contexts without a dialog:

- Saved Git path: the shell creates one `gitProbe` context for the saved path at each startup handshake. This includes the handshake after Restart service. The handshake carries its `bootstrapId`. The service revalidates the executable in that context before it answers its first public request. A changed identity gives `GIT_CHANGED`, and the service selects no other executable. Without a saved path, the handshake carries no context, and Git stays unselected.
- Last repository: the shell creates no context at startup. Each `restoreWorkspace` request creates one `repositoryDiscovery` context for the stored last-selection path.

| Context | Permitted execution | Completion |
| --- | --- | --- |
| `gitProbe` | Selected executable with fixed `version --build-options` arguments, from the application-owned launch directory. | Validate executable identity, version, architecture, and admission policy before issuing `gitInstallationId`. |
| `repositoryDiscovery` | Admitted Git in the selected directory. Only fixed discovery profiles using `rev-parse`, `symbolic-ref`, and `show-ref`. | Resolve and validate repository paths, formats, HEAD state, and physical identities before issuing `repositoryId`. Refuse registration when `--is-bare-repository` or `--is-inside-git-dir` reports true, with `UNSUPPORTED_REPOSITORY`. For a bare repository, the remedy is: open a worktree of it, or clone it. For a Git administration folder, the remedy is: open the working folder that contains it. Classify Git's ownership refusal as `DUBIOUS_OWNERSHIP` by exit status and message prefix. Show the path and Git's suggested command as copyable text, and never run that command. Classify a folder outside every repository as `NOT_A_REPOSITORY`: exit status 128 and a stderr prefix `fatal: not a git repository (or any` (research R2). The remedy is: "Open a folder inside a Git repository." Other discovery failures use `REPOSITORY_UNAVAILABLE`. |
| `registeredOperation` | Service-constructed Git operation against registered Git and repository IDs. | Normal operation and reconciliation rules apply. |

Discovery profiles use only the documented identity queries in `research.md`. They accept no renderer-provided arguments, refs, paths, or environment overrides.

Discovery probes run under a fixed C locale, so Git messages stay unlocalized. Ownership and bare-repository refusals come before the configuration listing in §7.

No discovery profile loads the index, because an index load can run a command-valued `core.fsmonitor` before trust approval. So discovery never runs `rev-parse --shared-index-path` (research R2). Split-index state comes from the raw index bytes (§4). A research R2 probe ran every discovery and trust-listing query with repository canaries, and none ran.

The service constructs the fixed probe arrays and parses their results. Native code validates the context and selected target, not Git semantics.

A bootstrap context lasts at most 60 seconds and belongs to one registration or marker dismissal. It can perform that operation's required discovery probes. Cancellation, failure, completion, or service restart destroys it.

Revalidate the selected file/directory identity before execution and registration. A changed target requires a new selection. No bootstrap context permits mutation or general repository reads.

Permanent IDs become valid only after successful registration. Bootstrap probes use the same Job ownership, output bounds, environment controls, and failure cleanup.

### Registration reuse and release

The scope is one main workspace. A registration whose worktree identity equals a registered workspace returns that `repositoryId`. It registers nothing new. A registration of another common-directory identity releases every registered workspace of the previous one. Linked worktrees of one common directory stay registered together.

A release invalidates the released `repositoryId` and its snapshots, comparisons, approvals, and trust ID. It cancels the reads of that workspace and stops its watcher. A registration that would release a workspace with an unfinished mutation gives `BUSY`, and nothing changes. An unfinished mutation is `running`, `cancel-requested`, or `reconciling`. Operation records, retained verification data (§5), and recovery markers survive a release. A later registration that matches an unresolved marker starts in `unknown` (§8).

### Process fields

Every private process frame carries `kind` `process` (§1).

| Field | Native validation |
| --- | --- |
| `operationId` | Active service operation with owned lifecycle state. |
| `contextKind` | `gitProbe`, `repositoryDiscovery`, or `registeredOperation`. |
| `bootstrapId` | Native-issued temporary context; required only for probe/discovery. |
| `gitInstallationId` | Required after Git registration. A probe instead uses its native-selected executable context. |
| `repositoryId` | Required for registered operations. Discovery instead uses its native-selected directory context. |
| `arguments` | Structured string array; bounded count/size; no NUL. Constructed by the service. |
| `input` | Bounded input bytes or bounded streaming input. |
| `environmentPolicy` | Internal fixed policy identifier, not caller-defined key/value pairs. |
| `transactionId` | Service-owned candidate-index context where an approved design requires it. |
| `limits` | Cannot exceed contract caps. |

An identity request is a `process` frame with `operationId`, `contextKind`, and the bootstrap or repository ID. It carries at most 8 absolute paths. Each path has at most 32,767 UTF-16 units and no NUL. The shell opens each path with `FILE_READ_ATTRIBUTES`, full sharing, and `FILE_FLAG_BACKUP_SEMANTICS`. It follows junctions and reads no file data. It returns only each identity or an error code. A path can lie outside the selected directory, because a linked worktree's common directory can live elsewhere.

Supply the executable through `CreateProcessW.lpApplicationName`. Preserve structured arguments until the tested Windows quoting boundary. Never insert an intermediate command shell.

Enforce Windows' command-line length limit before starting a child. Prefer Git's NUL-delimited stdin facilities for literal path collections.

Use only intended inherited pipe handles. Create the child suspended and assign its Job before resuming it. Assignment failure terminates the owned suspended child; execution must not continue unmanaged.

Each operation has its own Job. The service has a separate Job. Each operation Job and the service Job use kill-on-close and no breakaway. Their handles stay non-inheritable. A shell crash closes these handles and ends every owned descendant. Canceling one operation must not stop unrelated reads.

Drain stdout and stderr independently. Enforce caps before forwarding chunks to Bun. Close all outstanding operation Jobs after service failure.

These controls manage normal owned process trees. They do not sandbox arbitrary trusted hooks or external service launches.

### Recovery markers

The shell stores one marker file for each mutation without a stated outcome. The files live in the `recovery` folder of the application data directory.

A marker holds its ID, the operation kind, and the start time. It also holds the Git-resolved worktree and common-directory paths and the common-directory identity. It holds no message, patch, configuration, environment value, or credential.

The service sends three `mutation` frames:

- `started` with `operationId`, `repositoryId`, `kind`, and the Git-resolved worktree and common-directory paths. The service sends it before it creates the canonical index lock. That lock is the first side effect of both protocols (research R3 step 4, R4 step 2). The shell reads the common-directory identity itself through `FileIdInfo`. It writes and flushes the file, then replies with the marker ID. When the write or flush fails, it replies with the failure class: `disk-full`, `access-denied`, or `other`. Without a marker ID, the service creates no lock and starts no Git process. A failure reply refuses the mutation with `RECOVERY_MARKER_FAILED` (§9).
- `ended` with `operationId`, after the terminal response. From `started` to `ended`, the shell treats the mutation as running for `requestClose`. After a service exit, `ended` never arrives. The shell then closes every operation Job, and afterwards no mutation counts as running. The marker file stays.
- `resolved` with the marker ID. The service sends it after a known outcome, or after a recovery refresh states an `unknown` outcome (§8). The shell then deletes the file.

The owning shell keeps each marker file open without delete sharing. At startup, the shell opens each marker file with no sharing. A sharing violation means that a running instance owns the file, so the shell skips it. Otherwise the owner stopped, and this shell takes ownership. The OS closes the handles of a stopped process. So a crash leaves a file that the next start can open. Each startup handshake, also after Restart service, carries every marker that the shell owns. The shell rescans the `recovery` folder for each handshake.

**Dismissal.** A marker for a deleted or moved repository never resolves through a refresh. `dismissRecoveryMarker` removes such a marker explicitly. The shell binds a `repositoryDiscovery` context to the stored worktree path of the marker. The service runs the discovery profiles there and returns one of two results:

- Dismissal allowed: Git reports `REPOSITORY_UNAVAILABLE` or `NOT_A_REPOSITORY`, or the resolved common-directory identity differs from the marker identity.
- Dismissal refused: any other result. The code is `STATE_UNKNOWN` with the remedy "Open this repository and use Refresh."

When dismissal is allowed, the shell shows a native confirmation. It names the worktree path, the operation kind, and the start time. It states that the operation outcome stays unknown. Its buttons are Dismiss and Cancel, and Cancel is the default. Enter on the default, Escape, Alt+F4, the close button, and a call failure mean Cancel. Only the Dismiss button deletes the file. A dismissed marker never counts as a resolved outcome.

## 7. Startup, trust, and environment

Apply the Git and WebView2 minimum versions in `plan.md`. Admitted versions permit testing but are not automatically qualified. Reject versions below the minimum with the specified component error. Native startup reports WebView2 rejection before creating a webview.

Rust sanitizes the service environment before process creation. Remove Bun CLI-bypass, runtime-argument, inspector, preload, and related runtime-control variables.

Use case-insensitive environment-name matching on Windows. Do not pass arbitrary startup arguments or explicit configuration paths to the compiled service.

Apply all four verified Bun compile-autoload restrictions. Hostile repository configuration files must remain inactive during service startup.

Construct Git child environments separately. Remove the repository-location variables that Git `Documentation/git.adoc` lists, such as `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and `GIT_COMMON_DIR`. Only `mutation` sets `GIT_INDEX_FILE`, from a service-owned `transactionId`. Preserve existing identity, signing, and authentication configuration without persistent changes.

Every policy (`probe`, `read`, and `mutation`) preserves `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, and `GIT_CONFIG_NOSYSTEM` unchanged from the service environment. These variables select which global and system files Git reads (Git `Documentation/git.adoc`). Removing them would change the user's effective configuration (FR-003).

Every policy also preserves `GIT_CONFIG_COUNT`, each `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`, and `GIT_CONFIG_PARAMETERS`. Git reads them as `command` scope, which is protected configuration (Git `Documentation/git-config.adoc`). Every policy also preserves `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_AUTHOR_DATE`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`, `GIT_COMMITTER_DATE`, and `EMAIL`. They override configured identity, so their removal would change identity (FR-003). The `probe` and `read` policies remove `GIT_CONFIG`. It redirects only `git config`, so it would hide local keys from the trust listing (research R7). The `mutation` policy preserves it for hooks.

A trace2 event target comes only from the T091 probe result (research R4). The probe checks whether trace2 events identify hook and signing children. Without that probe result, no policy adds a trace2 variable. With it, `git-environment.json` adds the fixed policy `mutation-trace2`, which is `mutation` plus a trace2 event target. `GIT_TRACE2_EVENT` overrides a user's `trace2.eventTarget` (Git `Documentation/config/trace2.adoc`). So the service selects `mutation-trace2` only in one case. The service environment has no `GIT_TRACE2_EVENT`, and the effective configuration has no `trace2.eventTarget`. Otherwise it selects `mutation`, and hook and signing failures stay `GIT_FAILED` with a recorded reason.

History and object inspection use `--no-lazy-fetch` and `--no-optional-locks`. Missing objects require explicit limited/error outcomes, not an implicit network fetch.

Trust discovery includes traditional hooks, configured hook commands/events, conditional includes, worktree configuration, filters, monitors, diff tools, and signing programs.

**Value display allowlist.** `readTrust` shows a configuration value only for a key on this closed list. The list holds `filter.<driver>.clean`, `filter.<driver>.process`, and `filter.<driver>.smudge`. It holds `core.fsmonitor`, `core.hooksPath`, and `hook.<name>.command`. It holds `diff.<driver>.textconv`, `diff.<driver>.command`, and `diff.external`. It holds the signing keys `gpg.program`, `gpg.<format>.program`, and `gpg.ssh.defaultKeyCommand` (Git `Documentation/config/gpg.adoc`). Every other entry is opaque, and `readTrust` shows only its key, scope, and origin. Examples are `http.extraheader`, `user.signingkey`, and a remote URL with user information. The `include.path` and `includeIf.<condition>.path` values stay hidden on purpose, and their origins stay visible. Trust resolution uses origins, not include values.

**URL user information.** A key subsection can hold a URL with credentials. Examples are `url.<base>.insteadOf`, `http.<url>.extraheader`, `credential.<url>.helper`, and `includeIf.hasconfig:remote.*.url:<pattern>.path`. Git prints these subsections unchanged (research R5 probe). So the service redacts every key subsection, origin, and allowlisted value before display or logging. For each `://` in the text, the authority runs to the next `/`, `?`, `#`, or the end. When that authority holds `@`, all text before its last `@` becomes `<redacted>`. Git's `transport_anonymize_url` also removes the user information of a URL for display (research R5). The trust fingerprint covers the unredacted bytes, and no response carries them.

Do not execute a custom filter merely to determine whether the repository is trusted. Before the first status read, list effective configuration with scopes. The listing includes `command` scope entries from the preserved environment. The trust fingerprint covers them. This listing runs no filter and loads no index. A repository-controlled key (resolution rule below) can define a command that a read runs. Such a key blocks status, diff, and history reads until trust approval. History reads cannot run these keys (table below). They still wait for the same approval, so one read gate covers the workspace. `readHistory` runs this listing itself and never waits for a status read. System, global, and command entries are protected configuration (Git `Documentation/git-config.adoc`). They run without approval, unless the resolution rule makes them repository-controlled.

The blocking class is any repository-controlled key that names a command a read can run. This slice reads through `status --porcelain=v2`, `diff-files`, `diff-index --cached`, `ls-files --eol`, `rev-list`, and `cat-file --batch-command`. For those commands, the listed keys behave as follows:

- `filter.<driver>.clean` and `filter.<driver>.process` can fire. `status` and `diff-files` run the clean conversion on stat-dirty working files.
- Command-valued `core.fsmonitor` can fire. Every command that loads the index can run it, including `status`, `diff-files`, `diff-index`, and `ls-files`. `rev-parse --shared-index-path` also loads the index. It ran the monitor in a research R2 probe, so no read or discovery step uses it.
- `core.fsmonitor=true` names Git's built-in daemon, not a repository-defined command. It does not block reads from any scope. When no daemon runs, a command that loads the index can start `git fsmonitor--daemon` (research R3). That daemon is an owned descendant of the read's operation Job, and Job close ends it (unverified). A daemon that runs outside the app is unrelated and keeps running. Hunk actions still refuse this profile (§4).
- `filter.<driver>.smudge` cannot fire. Git runs it only when it writes working files.
- `filter.<driver>.required` names no command. It makes a clean failure fatal.
- `diff.<driver>.textconv`, `diff.<driver>.command`, and `diff.external` cannot fire. Plumbing diffs run them only with explicit `--textconv` or `--ext-diff`. Porcelain `diff` and `log -p` can run them, and supported inspection disables them.
- `rev-list` and `cat-file --batch-command` without `--filters` or `--textconv` run none of these keys.

Status and diff reads pass `--ignore-submodules=dirty`. Superproject reads never start Git inside a submodule. The scoped listing above cannot see a submodule's local configuration, so the gate cannot cover it. The superproject view shows a changed submodule commit, not changes inside the submodule.

Keys that cannot fire for these reads do not block reads. Ordinary trust discovery still covers them before any operation that can run them.

**Repository-controlled resolution.** An executable integration is repository-controlled when any of these holds:

- Its entry has scope `local` or `worktree`.
- Its origin file from `--show-origin` lies inside the worktree root, the Git directory, or the common directory. This covers includes of repository files.
- It is a hook that `git hook list <event>` reports from the hooks directory, and that directory lies inside one of those directories. `rev-parse --git-path hooks` prints the effective directory, including `core.hooksPath`, relative to the Git working directory. Resolve it against the directory where Git ran. A relative `core.hooksPath` from any scope resolves inside the worktree.
- Its program lies inside one of those directories. Git runs hook, filter, and monitor commands from the worktree root. A program path with `/` or `\` that is not absolute resolves against that root.
- Its program is a bare name, and the child `PATH` holds an empty, `.`, or other relative entry. Then every bare-name program needs trust, Git LFS included.

The rule classifies the program that Git starts. A protected command can still read repository files through its arguments. That behavior stays the user's configured choice (research R5).

**Program file digests.** The trust fingerprint also covers the bytes of repository-controlled program files. So an edit of an approved hook or program file gives `TRUST_CHANGED`.

- The service computes the SHA-256 digest of each file that a repository-controlled integration names by path. These are hook files from `git hook list` and the hooks directory. They are also program paths that are absolute or hold `/` or `\`. It resolves each path by the rule above.
- Only a resolved path inside the worktree root, the Git directory, or the common directory gets a digest. The service never opens a program path outside them, such as a UNC or device path. Such a path stays in the fingerprint as a location only.
- A listed path inside those directories can be absent or not a regular file. It then enters the fingerprint as the fixed value `absent`.
- A bare-name program has no path. Its name and the child `PATH` entries stay in the fingerprint. Git for Windows skips empty `PATH` entries. For each other entry in order, it tries `<entry>\<name>.exe`, then `<entry>\<name>` when that is not a directory (research R5). When the child `PATH` holds relative entries, the service repeats that lookup in each of them. Each relative entry resolves against the worktree root. Git starts hooks, filters, and monitors from that root. The first regular file found gets a digest. Without one, each relative entry enters the fingerprint as `absent`, so creating such a file gives `TRUST_CHANGED`. An earlier absolute entry can hold the same name, and Git then starts that file. The digest still covers the repository candidate, so this case errs toward `TRUST_CHANGED`.
- Bounds: at most 64 files, 1 MiB per file, and 8 MiB in total (§5). The service checks the size through the open handle before it reads. It reads at most the bound plus one byte. It digests files in fingerprint order. A file above 1 MiB enters the fingerprint as `unchecked` with its path. So does every file after the 64-file or 8 MiB bound. T192 and T169 measure the poll cost with these digests.
- Over a bound, `readTrust` reports the reached bound and `persistence` `session`. `approveTrust` still accepts an explicit approval. Its `confirm` frame carries `persist: false`. The native confirmation names the reached bound and states: "Arbareto cannot check these program files for later edits. This approval lasts until Arbareto closes." On Approve, the shell writes no record. The service keeps the approval for the service session. An edit of an `unchecked` file keeps that session approval, and the confirmation says so. The next session reports `untrusted`.
- Reading a program file runs nothing. The stored record keeps one fingerprint digest, so the record format stays unchanged.

**Mutation trust.** A mutation needs approved trust only when it can run a repository-controlled integration (Constitution V, FR-025).

- `commit` needs approval when the fingerprint lists such an integration that `git commit` can run. These are hooks for `pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit`, `post-index-change`, `reference-transaction`, and `pre-auto-gc`. They also include signing programs, clean filters, and command-valued `core.fsmonitor`. The signing programs are `gpg.program`, `gpg.<format>.program`, and `gpg.ssh.defaultKeyCommand`. Git runs `gpg.ssh.defaultKeyCommand` when SSH signing has no `user.signingKey`, and a research R4 probe observed it during `commit`.
- `applyHunk` runs `apply --cached`, `hash-object --no-filters`, `read-tree`, and `ls-files` on a private index. Its supported profile refuses index-change hooks, executable monitors, and custom filters (§4). So `applyHunk` runs no repository-controlled program. It needs approval only when its reads need it.
- A changed fingerprint gives `TRUST_CHANGED` at every checkpoint, also without required approval.
- Without required approval, the next `readWorkspace` observes the new fingerprint. A new selection or review then clears `TRUST_CHANGED`.
- With required approval, trust `state` becomes `changed`. Only an approval of the new fingerprint clears it. A new selection or review follows.
- Without required approval, a stored record with another fingerprint keeps trust `state` `changed` for display only. It blocks no read, hunk control, or mutation. The record stays. So renewed approval still applies when an approval becomes required again (FR-025).
- `readTrust` returns `approvalRequired` separately for reads and for `commit`.

Missing approval never disables a hook. A mutation that needs approval refuses with `TRUST_REQUIRED` before any process starts. It refuses with `TRUST_CHANGED` when trust `state` is `changed`.

**Trust approval store.** Approval persists across launches (spec Clarifications, 2026-09-30). The shell stores one record for each worktree in the `trust` folder of the application data directory. The fingerprint is per worktree, because worktree configuration, relative program paths, and a relative `core.hooksPath` resolve per worktree. A record holds the Git-resolved common-directory path and its `FileIdInfo` identity. It also holds the Git-resolved worktree root and administration-directory paths and their `FileIdInfo` identities, which form the worktree identity (data-model §2). It also holds the approved fingerprint, the approval time, and the executable identity digest of the selected Git (data-model §1). It holds no configuration value, command text, environment value, or credential. The fingerprint is the digest that `readTrust` returns. Each startup handshake carries every record. The service sends two `trust` frames:

- `confirm` with the worktree path, the worktree administration-directory path, the common-directory path, the Git installation digest, the fingerprint, and `persist`. The service computes the digest from the executable identity (data-model §1). The shell reads the common-directory identity and the worktree identity itself. It shows a native confirmation that names the worktree path and the fingerprint. With `persist: false`, it also shows the reached bound and the session-only text from "Program file digests". Its buttons are Approve and Cancel, and Cancel is the default. Enter on the default, Escape, Alt+F4, the close button, and a call failure mean Cancel. On Approve with `persist: true`, the shell writes and flushes the record. It replaces every record of the same worktree. A record is of the same worktree when both its common-directory identity and its worktree identity match. It is also of the same worktree when both its common-directory path and its worktree root path match. Records of other worktrees of that common directory stay unchanged. With `persist: false`, it writes no record and deletes every record of the same worktree, because none matches the new fingerprint. Then it replies `approved`. Otherwise it replies `declined`, and `approveTrust` ends `canceled`.
- `revoke` with the common-directory path. The shell reads the identity of that path. It deletes every record whose common-directory identity or path matches, for every worktree of that common directory. Then it replies. `revokeTrust` then invalidates the trust ID.

The service derives trust `state` from the records and from its session approvals. A record matches when its common-directory identity and its worktree identity equal those of the workspace. `approved` needs a matching record, or a session approval, with the same Git installation digest and fingerprint. A matching record with another digest or fingerprint gives `changed`. So does a record with the same common-directory path and worktree root path but another identity. No record gives `untrusted`. A revoked trust ID gives `revoked`.

Do not disable required hooks to obtain a successful result. Do not add an application-owned hook without approved scope changes.

Logs stay in memory for the session; this slice writes no log files. Logs contain only allowlisted operation kinds, internal IDs, durations, safe codes, counts, and reconciled effect summaries. Do not retain raw stderr, hook output, messages, patches, environment blocks, or configuration dumps.

Provide actionable safe explanations. Full repository-specific diagnostics remain available through the user's selected Git tools, not unrestricted automatic log export.

## 8. Freshness, cancellation, and outcome semantics

Snapshot-bound requests carry `repositoryGeneration`. Selection-dependent reads also carry `selectionId`. Discard obsolete display results without hiding operation completion notifications.

Changes invalidate approvals before replacement views arrive. A pending read cannot preserve an old mutation capability.

**Token invalidation.** The observation fingerprint is HEAD, `indexFingerprint`, `policyFingerprint`, and `operationState` (data-model §4). It also holds the `workingVersions` that a token binds. These rules define "refresh" and "relevant state change" in data-model §6:

- A `readWorkspace` call with `refresh: true` invalidates every dependent token.
- A `refresh: false` read whose fingerprint differs from the issued one invalidates every token that depends on it.
- A `refresh: false` read with an unchanged fingerprint keeps issued tokens.
- A watcher hint marks the workspace dirty, so the next read re-reads Git state. The hint alone invalidates no token.
- Service restart and successful consumption invalidate tokens as data-model §6 states.
- After a hunk approval expires or becomes invalid, the renderer issues `readComparison` again for the same entry. It keeps the diff scroll while the canonical comparison stays unchanged. It keeps the hunk selection only when the new comparison has a hunk with the same canonical hunk digest. Otherwise the selection clears with a notice. The §4 publication rechecks stay unchanged.

**Change check.** A `readWorkspace` with `check: "changes"` first compares a stat tuple with the one from the last complete read. The tuple holds size, last-write time, and presence for a fixed file set:

- The index, in every ref format.
- The worktree `HEAD`, the ref file of the current branch, and `packed-refs`, for the `files` ref format.
- Discovery reports the ref format through `--show-ref-format`. For the `reftable` format, two files replace the `HEAD`, branch ref, and `packed-refs` entries. They are `reftable/tables.list` in the worktree administration directory and in the common directory. For the main worktree, both paths name one file. Git rewrites this stack ordering file by rename on every ref update (gitformat-reftable(5)). `HEAD` is then a fixed stub, and no branch ref file or `packed-refs` exists. A ref update can keep the file size, so the tuple also holds the file content. A `tables.list` above 64 KiB counts as changed, so the read runs in full.
- Every configuration origin file from the last trust listing, and every file that the trust fingerprint digests.
- The working file of the selected entry, from its `workingVersions` binding.

The check starts no Git process. Without a watcher hint and with an equal tuple, the read returns the last snapshot. Its `snapshotId` and `generation` stay unchanged. Otherwise it runs a full read. A change check is a hint, not validation. Every mutation checkpoint still reads Git state (§4). This stat compares change hints only. Physical identity still comes from the §6 identity request.

Cancellation means stopping further owned work, not undoing completed work. The terminal result can still be successful if the intended operation completed first.

After any mutation outcome, inspect actual HEAD target/OID, index, relevant working bytes, and operation markers. Unknown state blocks further mutations in the affected workspace.

Distinguish `succeeded`, `completed-with-effects`, `failed-with-effects`, `canceled`, and `unknown`. A known checkpoint mismatch remains a refusal, not completed-with-effects.

A published hunk or created commit with differing observed state is completed-with-effects when execution completed. An execution failure with observed changes is failed-with-effects. Neither is `succeeded`; preserve the draft and show grounded commit identities.

Late cancellation can still produce `succeeded` or `completed-with-effects`. Reconcile before classification; cancellation is never an undo command.

Use bounded reference/reflog evidence for uncertain commit attribution. Apply the aggregate byte and record caps across all streams and references per reconciliation attempt. Do not assume current HEAD belongs to this request or invent a causal explanation. Evidence overflow or ambiguous attribution gives the terminal outcome `unknown`. Mutations stay blocked until an explicit recovery refresh reports that outcome.

From `unknown`, only `readWorkspace` with `refresh: true` performs recovery reconciliation. It succeeds when all of these hold:

- No process of the prior operation runs, and its operation Job is closed.
- A complete snapshot exists: HEAD target and OID, complete index, operation markers, and relevant working bytes.
- Owned lock and candidate files are released, or the result names them as foreign.
- For `commit`, one attribution attempt ran within the §5 caps. Its result is an identified commit, no commit, or `unknown`. An `unknown` result names its reason: `ambiguous`, `evidence-limit`, or `no-retained-request`.
- For `applyHunk`, no attribution step runs. The observed canonical index is compared with two retained digests: the verified candidate and the index before publication. The result names the match: `published`, `not-published`, or `neither`. Without a retained request, the result is `unknown` with reason `no-retained-request`.

An attribution result of `unknown` does not fail reconciliation. It stays the prior operation's terminal outcome (FR-020). A failed, limited, or unavailable observation fails reconciliation, and the workspace stays `unknown`. A status-only read performs no reconciliation, so it cannot release the gate. The refresh result states the prior outcome and the attribution result. It never replaces the prior terminal response. After success, the service sends `resolved` for the marker, and the workspace becomes `ready`.

Do not remove locks after interruption unless ownership and lifetime are certain. Do not delete unknown recovery files or discard a hook-modified private index silently.

After a restart, the app has no ownership record. Treat every leftover lock and candidate file as foreign. Name candidate files with the fixed prefix `arbareto-candidate-` so users can identify them.

On restart, obtain a fresh snapshot and review. Do not replay requests or claim that a previous interrupted operation rolled back.

A recovery marker survives a service restart, application close, and crash (§6). `getEnvironment` lists the markers from earlier sessions. A workspace whose common-directory identity matches an unresolved marker starts in `unknown`. The marker can come from this session or an earlier one. A new session has no retained request. So its recovery refresh reports attribution `unknown` with reason `no-retained-request`.

**Service restart.** The startup handshake after Restart service carries `restarted: true`. In that session, every registered workspace starts in `unknown`, also without a marker (FR-023). Only a `readWorkspace` with `refresh: true` in that session releases it. A `refresh: false` read keeps the block. With a matching marker, the refresh follows the rules above. Without one, recovery needs only a complete snapshot, and the refresh states that no operation outcome is pending. After each `service-session` event, the renderer runs `restoreWorkspace` again (§2). It shows State unknown and blocks every mutation until that refresh succeeds.

## 9. Error codes

| Category | Codes |
| --- | --- |
| Request boundary | `INVALID_REQUEST`, `PROTOCOL_VERSION`, `UNKNOWN_OPERATION`, `UNKNOWN_TARGET`, `FRAME_LIMIT`, `BUSY`, `WORKSPACE_LIMIT` |
| Prerequisites | `GIT_UNAVAILABLE`, `GIT_CHANGED`, `GIT_UNSUPPORTED`, `WEBVIEW_UNAVAILABLE`, `WEBVIEW_UNSUPPORTED` |
| Repository state | `REPOSITORY_UNAVAILABLE`, `REPOSITORY_CHANGED`, `UNSUPPORTED_REPOSITORY`, `DUBIOUS_OWNERSHIP`, `NOT_A_REPOSITORY`, `OPERATION_IN_PROGRESS`, `CONFLICTED`, `LOCKED` |
| Trust and approval | `TRUST_REQUIRED`, `TRUST_CHANGED`, `STALE_SELECTION`, `STALE_REVIEW`, `APPROVAL_EXPIRED`, `UNSUPPORTED_HUNK_PROFILE` |
| Data and display | `MALFORMED_GIT_OUTPUT`, `OUTPUT_LIMIT`, `UNSUPPORTED_COMPARISON`, `DISPLAY_MAPPING_FAILED`, `GRAPH_LAYOUT_LIMITED` |
| Execution | `IDENTITY_REQUIRED`, `HOOK_FAILED`, `SIGNING_FAILED`, `GIT_FAILED`, `PROCESS_OWNERSHIP_FAILED`, `DEADLINE`, `CANCELED`, `COMMIT_ENCODING_UNSUPPORTED` |
| Recovery | `COMPLETED_WITH_EFFECTS`, `FAILED_WITH_EFFECTS`, `STATE_UNKNOWN`, `SERVICE_UNAVAILABLE`, `RECOVERY_MARKER_FAILED` |

Each terminal state (data-model §7) carries one result code:

- `succeeded`: no error code.
- `limited`: `OUTPUT_LIMIT`, with the reached §5 bound as its reason. The response keeps its bounded data and completeness `limited`.
- `failed`: the specific failure code, such as `DEADLINE` or `GIT_FAILED`.
- `canceled`: `CANCELED`.
- `completed-with-effects`: `COMPLETED_WITH_EFFECTS`.
- `failed-with-effects`: `FAILED_WITH_EFFECTS`.
- `unknown`: `STATE_UNKNOWN`, with its attribution reason.
- `rejected`: the refusal code.

A mutation request in a workspace whose recovery state is `unknown` is rejected with `STATE_UNKNOWN`. Above the recovery-marker limit (§5), every mutation is rejected with `STATE_UNKNOWN`. Unexpected diagnostic output above 4 MiB cancels the operation. A read then ends `failed` with `OUTPUT_LIMIT`. A mutation enters `reconciling`, and its diagnostic names `OUTPUT_LIMIT` as the cause.

Map these cases to codes:

- At acceptance of a snapshot-bound request other than `approveTrust`, a stale `repositoryGeneration` gives `REPOSITORY_CHANGED`. No Git process starts. `readWorkspace` never fails on a generation mismatch (§2). An `approveTrust` fingerprint-generation mismatch gives `TRUST_CHANGED`.
- A hunk checkpoint that detects a changed file, index, HEAD, or attribute gives `STALE_SELECTION`. A commit preflight that detects a changed index, checkout, or operation state gives `STALE_REVIEW`.
- The choice between `REPOSITORY_CHANGED` and these checkpoint codes depends on the request sequence. A `readWorkspace` that observes the change increases the generation, so a later request gives `REPOSITORY_CHANGED` at acceptance. Without such a read, the generation still matches, and the checkpoint code applies.
- A checkpoint that detects a changed trust fingerprint gives `TRUST_CHANGED`. This includes a configuration change during a hunk request.
- A registration beyond 8 workspaces registered at one time gives `WORKSPACE_LIMIT`. The result names the limit. Only linked worktrees of one common directory can reach it (§6 "Registration reuse and release").
- A registration that would release a workspace with an unfinished mutation gives `BUSY`.
- A failed recovery-marker write gives `RECOVERY_MARKER_FAILED` with the failure class and the `recovery` folder path. Its remedy is: "Arbareto could not save its recovery record. Free disk space or restore write access to this folder, then try again." No lock and no Git process exist yet.
- A hook or signing failure gives `HOOK_FAILED` or `SIGNING_FAILED` only from structured evidence (research R4). Without that evidence, the result is `GIT_FAILED` with a recorded reason.
- `HOOK_FAILED` and a commit `GIT_FAILED` carry a copyable remedy command. It is the PowerShell command `& '<selected Git path>' -C '<worktree root>' commit`, with each `'` inside a path doubled. The remedy text is: "Run this command in a terminal to see the hook output. Arbareto keeps your message." Hook output itself never enters a response (§7).

Return `LOCKED` only when the app's own exclusive lock creation fails. A `LOCKED` result carries the Git-resolved lock path and this remedy: "Another Git process or a crash left this lock. Remove it only after all Git tools stop, including other Arbareto windows." The app never removes the lock. Git-reported lock failures stay `GIT_FAILED` with safe guidance. The guidance tells the user to refresh; a remaining lock gives `LOCKED` with its path on the next mutation attempt.

Do not classify repository state by parsing localized human status output. Use bounded structured observations and known execution phases. When a cause is uncertain, return `GIT_FAILED` with safe recovery guidance.

## 10. Required contract checks

- Reject unknown operations, duplicate keys, unknown fields, oversized frames, malformed UTF-8, invalid IDs, and hostile environment requests.
- Reject caller-supplied executable paths, patches, ref expressions, and traversal attempts.
- Reject another workspace's entry, hunk, review, or cancellation target.
- Verify staged/unstaged identity for the same path and category-specific comparison scope.
- Verify service restarts invalidate approvals and cannot replay a commit.
- Verify that the page gets its `sessionId` only through `currentSession`: at load, after a reload, and after `service-session`. Every draft survives a restart without a page reload.
- Verify that after Restart service the renderer runs `restoreWorkspace` again. Mutations stay blocked until a `refresh: true` read in the new session (FR-023).
- Verify 20 alternating opens of two repositories with different common directories. Each open releases the other, and no open gives `WORKSPACE_LIMIT`. A released `repositoryId` gives `UNKNOWN_TARGET`. Reopening the current worktree returns its `repositoryId`.
- Verify that no discovery or trust-listing command runs a repository-defined program before trust approval.
- Verify that URL user information in key subsections and origins never reaches `readTrust`, a diagnostic, or the log.
- Verify that trust approval persists across service sessions. A changed common-directory identity, Git installation, or fingerprint gives `TRUST_CHANGED`. An edit of an approved repository-controlled hook or program file also gives `TRUST_CHANGED`.
- Verify that marker dismissal needs an unavailable or changed repository and an explicit native confirmation.
- Verify a repeated `commit` with a consumed review token returns the first operation, and a repeated `requestId` gives `INVALID_REQUEST`.
- Verify stale/out-of-order reads cannot replace the active view or authorize mutation.
- Verify that a `check: "changes"` read without a hint or a tuple change starts no Git process. Verify that `readHistory` runs beside `readWorkspace` without a status snapshot, and waits for read trust like other reads.
- Verify that a trust approval over a digest bound stores no record, and that the next session reports `untrusted`.
- Verify all limits report incomplete state explicitly and release owned process resources.
- Verify cancellation near completion reports actual effects and preserves unrelated processes.
- Verify configured hooks, hostile startup variables, and diagnostic credential canaries.
- Verify exact candidate publication and refusal for unsupported index-change hook/monitor profiles, including disabled registrations.
- Verify checkpoint refusals separately from controlled changes after publication or commit handoff.
- Verify ordinary commit hooks retain their canonical index effects and `completed-with-effects` and `failed-with-effects` outcomes preserve drafts.
- Verify ambiguous or over-limit attribution remains unknown without retry, undo, or invented identities. Test aggregate byte and record limits independently.
- Verify status-only refresh cannot unblock unknown attribution. Required recovery reconciliation must succeed first.
- Verify that recovery reconciliation enables mutations when attribution stays `unknown`, and that its result states that outcome.
- Verify that a recovery marker survives a service restart, application close, and shell crash, and blocks the matching workspace.
- Verify real parent DAGs, shallow/page boundaries, data limits, controlled graph selection, and row alignment.
