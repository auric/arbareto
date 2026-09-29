# Operation Contract: Windows Desktop Qualification

**Protocol version**: `1` | **Model**: [data-model.md](../data-model.md) | **Plan**: [plan.md](../plan.md)

This contract defines selected behavior, not implemented endpoints. Hunks use protected candidate publication; commits use the explicitly approved standard Git handoff. Validation checkpoints do not promise repository-wide atomicity.

## 1. Transport and authority

Use typed Tauri commands/channels between the main local webview and Rust. Register application commands through Tauri's application ACL manifest.

Grant only the operations below to the main local window. Deny remote webviews, shell execution, broad filesystem access, and unregistered application commands.

Rust and the compiled service use private inherited pipes. Frames contain a four-byte unsigned little-endian payload length followed by UTF-8 JSON.

Each pipe frame has a top-level `kind` field with the value `public`, `process`, or `mutation`. A `public` frame holds one §2 request, its response, or a progress event. A `process` frame holds one §6 process request, one §6 identity request, or their output. A `mutation` frame holds one §6 recovery-marker message. The shell never forwards a `process` or `mutation` frame to the renderer. The renderer envelope in §2 has no `kind` field.

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
| `repositoryGeneration` | Nonnegative safe integer for snapshot-bound operations. It must match the supplied snapshot, review, or trust fingerprint. |
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

The shell gives the page its first `sessionId` through a page initialization script. No public operation carries a handshake. The shell sends two events to the main window. `service-stopped` reports a service exit and the unresolved recovery markers (§6). The page marks each request without a terminal response as "outcome unknown". `service-session` delivers the new `sessionId` after Restart service. The page does not reload for a restart. Drafts are renderer state, so they survive a service restart. A reloaded page gets the current `sessionId` from the initialization script and joins the current service session. Only Restart service or application start creates a new service session. Identifiers from an old session stay invalid in the new one.

## 3. Public operations

| Operation | Payload | Result and checks |
| --- | --- | --- |
| `getEnvironment` | Empty object. | Build identity, detected and minimum versions, selected Git, prerequisite admission, and separate qualification status. The qualification status is `passed` only when the detected version set is on a build-time list. That list holds the sets with recorded passing evidence. This slice ships that list empty, so the status stays `unverified`. Platform scope `qualification-target` for Windows 11 x64 on a native AMD64 machine with product type `VER_NT_WORKSTATION`, otherwise `other`. The recovery markers that the shell owns at session start (§6, §8). No environment dump. |
| `chooseGit` | Renderer: empty object. Service: only the native-issued `bootstrapId`. | Native executable selection, explicit approval, version probe, and installation ID. Cancel preserves the current selection. |
| `chooseRepository` | Renderer: empty object. Service: only the native-issued `bootstrapId`. | Native folder selection and Git registration. Cancel preserves the current workspace. |
| `restoreWorkspace` | Renderer: empty object. Service: only the native-issued `bootstrapId`. | Revalidate the last explicitly chosen repository from application settings. No caller-supplied path. |
| `readWorkspace` | `refresh: boolean`. | Git-derived identity, HEAD, operation state, status completeness, hunk-profile eligibility, snapshot ID, and recovery state. Only a user Refresh action sends `refresh: true`. Polls and focus return send `refresh: false`. An explicit refresh of a blocked workspace performs recovery reconciliation (§8). |
| `readHistory` | Current snapshot ID. | Bounded HistoryPage: at most 100 checkout-reachable commits, ordered parents, boundary metadata, captured HEAD, and completeness. No arbitrary ref or pagination argument. |
| `readComparison` | Current snapshot ID and issued entry ID. | One supported canonical comparison with hunk IDs, or an explicit unsupported/limited result. |
| `readTrust` | Current repository ID. | Safe execution-policy summary and approval fingerprint. Show configuration values only for the §7 value display allowlist. |
| `approveTrust` | Issued fingerprint and explicit approval. | Session trust token. A changed policy requires new approval. |
| `revokeTrust` | Current trust ID. | Revoke future executable operations and invalidate dependent approvals. Running work needs explicit cancellation. |
| `applyHunk` | Comparison ID, hunk ID, snapshot ID, and direction `stage` or `unstage`. | Profile check, fresh validation, exact candidate publication, and reconciled outcome. No renderer patch or whole-file fallback. |
| `reviewCommit` | Current snapshot ID. | Complete staged scope, reviewed index/checkout, execution-policy disclosure, limitations, and one-use review token. Read-only inspection only. |
| `commit` | Review token, message, and explicit full-scope confirmation. | Fresh preflight, one ordinary canonical Git commit invocation, and a reconciled outcome: `succeeded`, `completed-with-effects`, `failed`, `failed-with-effects`, `canceled`, or `unknown`. A repeated `commit` with a consumed review token returns the existing operation state and `operationId`, and starts no Git process. |
| `cancel` | Issued operation ID. | Cancellation-requested acknowledgement followed by the actual terminal outcome. |
| `getOperation` | Issued operation ID. | Current or retained terminal state. Never retries an operation. |
| `requestClose` | `stay`, `closeIfIdle`, or `interruptAndClose`. | The shell decides natively and never forwards this operation to the service. A running mutation always shows the native prompt, whose default is Stay open. Only its Interrupt and close button confirms interruption. |

The native dialog and confirmation code must not accept renderer-supplied replacements for selected paths or approval fingerprints.

The shell runs the native step of `chooseGit`, `chooseRepository`, and `restoreWorkspace` first. A canceled dialog returns a canceled result from the shell, and no frame reaches the service. Otherwise the shell forwards the request with its native-issued `bootstrapId` in the payload. The renderer payload must be empty, and the shell rejects any renderer field.

Blank messages, empty staged scope, conflicts, unfinished operations, stale snapshots, and incomplete data refuse mutation. Missing trust refuses a mutation only when it can run a repository-controlled integration (§7 "Mutation trust").

Commit approval covers the full staged scope. It never means “commit the selected file”. Unsupported file diffs can remain in a complete commit review.

Approval authorizes standard Git execution after fresh preflight, not an immutable tree or destination. Preserve approved hooks and report late changes explicitly.

### HistoryPage result

Bind the result to its repository, snapshot, captured HEAD target/OID, and scope `current-checkout`. Each row contains a full OID, ordered effective parent OIDs, subject, author, and date. It also carries the commit object's `encoding` header value, or none when the header is absent.

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

Disable executable external diffs and text conversion for supported inspection. Ordinary Git EOL conversion remains distinct from custom filters.

For tracked entries, generate hunks as `git add -p` does: `diff-files` to stage, `diff-index --cached` to unstage. Git's diff demotes a `core.safecrlf` failure to a warning, so hunks follow `git add -p`, not `git add`. Refuse a hunk request when `ls-files --eol` reports `mixed` for the index or working side.

Pierre may parse the canonical service patch for display. If display mapping disagrees with service hunks, disable actions and report `DISPLAY_MAPPING_FAILED`.

### Hunk eligibility and publication

Require an ordinary full index. Refuse unqualified sparse/split indexes, registered `post-index-change` hooks, and executable fsmonitor integrations. Also refuse the built-in fsmonitor daemon (`core.fsmonitor=true`), because this slice has not qualified it. Hook discovery includes disabled registrations; this slice conservatively refuses every index-change registration.

Return `UNSUPPORTED_HUNK_PROFILE` with a safe explanation. Never bypass those integrations or change user configuration. Index-change registrations block hunk publication only; ordinary commits still respect approved hooks.

Hold the exclusively created canonical index lock through candidate preparation, verification, and publication. Revalidate the complete snapshot and profile before preparing the candidate.

Use an owned private index and service-retained Git patch. Apply through `git apply --cached`, reversing the selected staged hunk for unstaging. Create a missing empty candidate through Git, not a malformed zero-byte index.

Verify exact candidate bytes, entry existence, mode, stage, and unrelated logical index entries against the independent expected result. Applicability, full-index headers, or a second apply test are insufficient.

Before publication, recheck canonical index bytes, working content, checkout, attributes, configuration, trust, and operation state. Every detected mismatch prevents publication. Honor cancellation before publication begins. Publish only the verified candidate through the owned lock's same-volume replacement.

Supported processing does not write working-file content. The lock excludes cooperating index writers, not every independent file/ref/configuration change. Report observed late changes and preserve external bytes without undo or retry.

Unexpected candidate effects prevent publication and require reconciliation. Remove only known owned temporary resources after their processes stop. Unknown ownership or publication state requires explicit recovery, not forced cleanup.

### Commit validation and handoff

Review the complete staged scope through read-only inspection and retain a bounded index snapshot. Do not use `write-tree` or trial commits to produce the review. The review token binds current index/checkout/policy observations, not an immutable future commit.

Obtain the canonical index lock for final preflight. Compare the reviewed index, HEAD target/OID, operation state, configuration, and trust. Refuse any detected mismatch; consume the one-use token only after validation.

Preflight reads the effective `i18n.commitEncoding`. A value that Git does not treat as UTF-8 refuses handoff with `COMMIT_ENCODING_UNSUPPORTED`. Git treats an unset value, `utf-8`, and `utf8` in any letter case as UTF-8.

Release that lock before invoking ordinary `git commit --file=-` on the canonical index. Handoff begins at lock release. A new mismatch detected before process start still refuses execution.

Supply only the bounded message on stdin. Do not add paths, `--all`, `--amend`, hook bypasses, signing overrides, injected hooks, or private-index commit semantics.

Git can reread its index after hooks and captures its own HEAD. Changes after handoff may affect the actual tree, parent, or destination. Postchecks report those effects; they do not prevent them retroactively.

After Git updates HEAD, `git commit` runs automatic maintenance and then the `post-commit` hook. On Git for Windows, maintenance runs in the foreground inside the commit process (research R4). The 120-second commit deadline therefore covers it. A deadline interruption at that point leaves a created commit. Reconciliation classifies the outcome from observed state (§8). A lock or temporary file that the interrupted process left is foreign (§8).

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
| Diagnostic bytes retained | 64 KiB per stream, never persisted as raw logs |
| Total unexpected diagnostic output | 4 MiB per operation before cancellation |
| Native stdout/stderr chunk | 64 KiB |
| Queued pipe data | 8 chunks per stream; apply backpressure |
| Registered workspaces | 8 per service session |
| Retained comparison data | 4 comparisons and 128 MiB total |
| Approval lifetime | 60 seconds; relevant changes invalidate it sooner |
| Concurrent reads | 2 per workspace, 4 globally |
| Pending reads | 8 globally; superseded selection reads are canceled |
| Mutations | 1 per common repository; reject overlap without queueing old approvals |
| Ordinary read deadline | 30 seconds |
| Commit process deadline | 120 seconds, followed by interruption and reconciliation |
| Cancellation/reconciliation target | 5 seconds; report unknown if state cannot be confirmed |
| Recovery markers | 4 KiB per marker and 64 markers per start. Above 64, `getEnvironment` reports the limit, and every mutation stays blocked with `STATE_UNKNOWN`. |
| Confirmed-close cleanup target | 5 seconds |

Count canonical patch lines once, including file and hunk headers. Ignore only the empty segment after a final newline. Split view and virtualized rows do not change this count.

Transmit the canonical patch as bounded base64 UTF-8 bytes. This prevents JSON escaping from invalidating raw-byte accounting. Validate decoding before strict patch parsing.

Render limited status/history with a visible explanation. Block mutations that depend on an incomplete status, index, trust, or comparison snapshot.

Use streaming decoders and counters. Do not collect unbounded `text()` or `arrayBuffer()` results. Cache eviction invalidates associated approvals.

Retain an accepted operation's reviewed index snapshot until required reconciliation succeeds, including while unknown state blocks recovery. Approval expiry must not delete required verification data. Use bounded owned files when retaining index bytes would exceed memory budgets.

## 6. Private native process requests

Only the compiled service can use this private channel. No public Tauri command exposes it.

### Registration bootstrap

The native shell creates temporary contexts for `chooseGit`, `chooseRepository`, and `restoreWorkspace`. A context binds the selected path, physical identity, session, permitted probe, and expiry.

Every physical identity is native: the 64-bit volume serial number and the 128-bit file ID from `GetFileInformationByHandleEx` with `FileIdInfo`. The 64-bit file ID is not unique on ReFS, FAT, or exFAT (research R2). The service never reads an identity through Bun `fs.stat`. It sends an identity request (below) for each Git-resolved path. An all-zero or all-ones file ID, or a failed call, refuses registration with `UNSUPPORTED_REPOSITORY`. The remedy is: open the repository from an NTFS or ReFS volume.

The renderer cannot supply or replace those paths. Restoration uses only the application-owned last-selection setting and requires fresh validation.

| Context | Permitted execution | Completion |
| --- | --- | --- |
| `gitProbe` | Selected executable with fixed `version --build-options` arguments, from the application-owned launch directory. | Validate executable identity, version, architecture, and admission policy before issuing `gitInstallationId`. |
| `repositoryDiscovery` | Admitted Git in the selected directory. Only fixed discovery profiles using `rev-parse`, `symbolic-ref`, and `show-ref`. | Resolve and validate repository paths, formats, HEAD state, and physical identities before issuing `repositoryId`. Refuse registration when `--is-bare-repository` or `--is-inside-git-dir` reports true, with `UNSUPPORTED_REPOSITORY`. For a bare repository, the remedy is: open a worktree of it, or clone it. For a Git administration folder, the remedy is: open the working folder that contains it. Classify Git's ownership refusal as `DUBIOUS_OWNERSHIP` by exit status and message prefix. Show the path and Git's suggested command as copyable text, and never run that command. Other discovery failures use `REPOSITORY_UNAVAILABLE`. |
| `registeredOperation` | Service-constructed Git operation against registered Git and repository IDs. | Normal operation and reconciliation rules apply. |

Discovery profiles use only the documented identity queries in `research.md`. They accept no renderer-provided arguments, refs, paths, or environment overrides.

Discovery probes run under a fixed C locale, so Git messages stay unlocalized. Ownership and bare-repository refusals come before the configuration listing in §7.

The service constructs the fixed probe arrays and parses their results. Native code validates the context and selected target, not Git semantics.

A bootstrap context lasts at most 60 seconds and belongs to one registration operation. It can perform that operation's required discovery probes. Cancellation, failure, completion, or service restart destroys it.

Revalidate the selected file/directory identity before execution and registration. A changed target requires a new selection. No bootstrap context permits mutation or general repository reads.

Permanent IDs become valid only after successful registration. Bootstrap probes use the same Job ownership, output bounds, environment controls, and failure cleanup.

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

- `started` with `operationId`, `repositoryId`, `kind`, and the Git-resolved worktree and common-directory paths. The service sends it before it creates the canonical index lock. That lock is the first side effect of both protocols (research R3 step 4, R4 step 2). The shell reads the common-directory identity itself through `FileIdInfo`. It writes and flushes the file, then replies with the marker ID. Without that reply, the service creates no lock and starts no Git process. It refuses the mutation with `SERVICE_UNAVAILABLE`.
- `ended` with `operationId`, after the terminal response. From `started` to `ended`, the shell treats the mutation as running for `requestClose`.
- `resolved` with the marker ID. The service sends it after a known outcome, or after a recovery refresh states an `unknown` outcome (§8). The shell then deletes the file.

The owning shell keeps each marker file open without delete sharing. At startup, the shell opens each marker file with no sharing. A sharing violation means that a running instance owns the file, so the shell skips it. Otherwise the owner stopped, and this shell takes ownership. The OS closes the handles of a stopped process. So a crash leaves a file that the next start can open. Each startup handshake, also after Restart service, carries every marker that the shell owns.

## 7. Startup, trust, and environment

Apply the Git and WebView2 minimum versions in `plan.md`. Admitted versions permit testing but are not automatically qualified. Reject versions below the minimum with the specified component error. Native startup reports WebView2 rejection before creating a webview.

Rust sanitizes the service environment before process creation. Remove Bun CLI-bypass, runtime-argument, inspector, preload, and related runtime-control variables.

Use case-insensitive environment-name matching on Windows. Do not pass arbitrary startup arguments or explicit configuration paths to the compiled service.

Apply all four verified Bun compile-autoload restrictions. Hostile repository configuration files must remain inactive during service startup.

Construct Git child environments separately. Remove the repository-location variables that Git `Documentation/git.adoc` lists, such as `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and `GIT_COMMON_DIR`. Only `mutation` sets `GIT_INDEX_FILE`, from a service-owned `transactionId`. Preserve existing identity, signing, and authentication configuration without persistent changes.

Every policy (`probe`, `read`, and `mutation`) preserves `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, and `GIT_CONFIG_NOSYSTEM` unchanged from the service environment. These variables select which global and system files Git reads (Git `Documentation/git.adoc`). Removing them would change the user's effective configuration (FR-003).

Every policy also preserves `GIT_CONFIG_COUNT`, each `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`, and `GIT_CONFIG_PARAMETERS`. Git reads them as `command` scope, which is protected configuration (Git `Documentation/git-config.adoc`). Every policy also preserves `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_AUTHOR_DATE`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`, `GIT_COMMITTER_DATE`, and `EMAIL`. They override configured identity, so their removal would change identity (FR-003). The `probe` and `read` policies remove `GIT_CONFIG`. It redirects only `git config`, so it would hide local keys from the trust listing (research R7). The `mutation` policy preserves it for hooks.

The `mutation` policy adds a trace2 event target only if the T091 probe supports it (research R4). The probe checks whether trace2 events identify hook and signing children. Without that probe result, the policy adds no trace2 variable.

History and object inspection use `--no-lazy-fetch` and `--no-optional-locks`. Missing objects require explicit limited/error outcomes, not an implicit network fetch.

Trust discovery includes traditional hooks, configured hook commands/events, conditional includes, worktree configuration, filters, monitors, diff tools, and signing programs.

**Value display allowlist.** `readTrust` shows a configuration value only for a key on this closed list. The list holds `filter.<driver>.clean`, `filter.<driver>.process`, and `filter.<driver>.smudge`. It holds `core.fsmonitor`, `core.hooksPath`, and `hook.<name>.command`. It holds `diff.<driver>.textconv`, `diff.<driver>.command`, and `diff.external`. It holds the signing keys `gpg.program` and `gpg.<format>.program` (Git `Documentation/config/gpg.adoc`). Every other entry is opaque, and `readTrust` shows only its key, scope, and origin. Examples are `http.extraheader`, `user.signingkey`, and a remote URL with user information. The `include.path` and `includeIf.<condition>.path` values stay hidden on purpose, and their origins stay visible. Trust resolution uses origins, not include values.

Do not execute a custom filter merely to determine whether the repository is trusted. Before the first status read, list effective configuration with scopes. The listing includes `command` scope entries from the preserved environment. The trust fingerprint covers them. This listing runs no filter and loads no index. A repository-controlled key (resolution rule below) can define a command that a read runs. Such a key blocks status, diff, and history reads until trust approval. System, global, and command entries are protected configuration (Git `Documentation/git-config.adoc`). They run without approval, unless the resolution rule makes them repository-controlled.

The blocking class is any repository-controlled key that names a command a read can run. This slice reads through `status --porcelain=v2`, `diff-files`, `diff-index --cached`, `ls-files --eol`, `rev-list`, and `cat-file --batch-command`. For those commands, the listed keys behave as follows:

- `filter.<driver>.clean` and `filter.<driver>.process` can fire. `status` and `diff-files` run the clean conversion on stat-dirty working files.
- Command-valued `core.fsmonitor` can fire. Every command that loads the index can run it, including `status`, `diff-files`, `diff-index`, and `ls-files`.
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

**Mutation trust.** A mutation needs approved trust only when it can run a repository-controlled integration (Constitution V, FR-025).

- `commit` needs approval when the fingerprint lists such an integration that `git commit` can run. These are hooks for `pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit`, `post-index-change`, `reference-transaction`, and `pre-auto-gc`. They also include signing programs, clean filters, and command-valued `core.fsmonitor`.
- `applyHunk` runs `apply --cached`, `hash-object --no-filters`, `read-tree`, and `ls-files` on a private index. Its supported profile refuses index-change hooks, executable monitors, and custom filters (§4). So `applyHunk` runs no repository-controlled program. It needs approval only when its reads need it.
- A changed fingerprint gives `TRUST_CHANGED` at every checkpoint, also without required approval.
- `readTrust` returns `approvalRequired` separately for reads and for `commit`.

Missing approval never disables a hook. A mutation that needs approval refuses with `TRUST_REQUIRED` before any process starts.

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
- One attribution attempt ran within the §5 caps. Its result is an identified commit, no commit, or `unknown`. An `unknown` result names its reason: `ambiguous`, `evidence-limit`, or `no-retained-request`.

An attribution result of `unknown` does not fail reconciliation. It stays the prior operation's terminal outcome (FR-020). A failed, limited, or unavailable observation fails reconciliation, and the workspace stays `unknown`. A status-only read performs no reconciliation, so it cannot release the gate. The refresh result states the prior outcome and the attribution result. It never replaces the prior terminal response. After success, the service sends `resolved` for the marker, and the workspace becomes `ready`.

Do not remove locks after interruption unless ownership and lifetime are certain. Do not delete unknown recovery files or discard a hook-modified private index silently.

After a restart, the app has no ownership record. Treat every leftover lock and candidate file as foreign. Name candidate files with the fixed prefix `arbareto-candidate-` so users can identify them.

On restart, obtain a fresh snapshot and review. Do not replay requests or claim that a previous interrupted operation rolled back.

A recovery marker survives a service restart, application close, and crash (§6). `getEnvironment` lists the markers from earlier sessions. A workspace whose common-directory identity matches a marker starts in `unknown`. The new session has no retained request. So its recovery refresh reports attribution `unknown` with reason `no-retained-request`.

## 9. Error codes

| Category | Codes |
| --- | --- |
| Request boundary | `INVALID_REQUEST`, `PROTOCOL_VERSION`, `UNKNOWN_OPERATION`, `UNKNOWN_TARGET`, `FRAME_LIMIT`, `BUSY`, `WORKSPACE_LIMIT` |
| Prerequisites | `GIT_UNAVAILABLE`, `GIT_CHANGED`, `GIT_UNSUPPORTED`, `WEBVIEW_UNAVAILABLE`, `WEBVIEW_UNSUPPORTED` |
| Repository state | `REPOSITORY_UNAVAILABLE`, `REPOSITORY_CHANGED`, `UNSUPPORTED_REPOSITORY`, `DUBIOUS_OWNERSHIP`, `OPERATION_IN_PROGRESS`, `CONFLICTED`, `LOCKED` |
| Trust and approval | `TRUST_REQUIRED`, `TRUST_CHANGED`, `STALE_SELECTION`, `STALE_REVIEW`, `APPROVAL_EXPIRED`, `UNSUPPORTED_HUNK_PROFILE` |
| Data and display | `MALFORMED_GIT_OUTPUT`, `OUTPUT_LIMIT`, `UNSUPPORTED_COMPARISON`, `DISPLAY_MAPPING_FAILED`, `GRAPH_LAYOUT_LIMITED` |
| Execution | `IDENTITY_REQUIRED`, `HOOK_FAILED`, `SIGNING_FAILED`, `GIT_FAILED`, `PROCESS_OWNERSHIP_FAILED`, `DEADLINE`, `CANCELED`, `COMMIT_ENCODING_UNSUPPORTED` |
| Recovery | `COMPLETED_WITH_EFFECTS`, `FAILED_WITH_EFFECTS`, `STATE_UNKNOWN`, `SERVICE_UNAVAILABLE` |

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
- A checkpoint that detects a changed trust fingerprint gives `TRUST_CHANGED`. This includes a configuration change during a hunk request.
- A registration beyond the 8 registered workspaces of a service session gives `WORKSPACE_LIMIT`. The result names the limit.
- A hook or signing failure gives `HOOK_FAILED` or `SIGNING_FAILED` only from structured evidence (research R4). Without that evidence, the result is `GIT_FAILED` with a recorded reason.

Return `LOCKED` only when the app's own exclusive lock creation fails. A `LOCKED` result carries the Git-resolved lock path and this remedy: "Another Git process or a crash left this lock. Remove it only after all Git tools stop, including other Arbareto windows." The app never removes the lock. Git-reported lock failures stay `GIT_FAILED` with safe guidance. The guidance tells the user to refresh; a remaining lock gives `LOCKED` with its path on the next mutation attempt.

Do not classify repository state by parsing localized human status output. Use bounded structured observations and known execution phases. When a cause is uncertain, return `GIT_FAILED` with safe recovery guidance.

## 10. Required contract checks

- Reject unknown operations, duplicate keys, unknown fields, oversized frames, malformed UTF-8, invalid IDs, and hostile environment requests.
- Reject caller-supplied executable paths, patches, ref expressions, and traversal attempts.
- Reject another workspace's entry, hunk, review, or cancellation target.
- Verify staged/unstaged identity for the same path and category-specific comparison scope.
- Verify service restarts invalidate approvals and cannot replay a commit.
- Verify a service restart delivers the new `sessionId` through `service-session` without a page reload, and every draft survives.
- Verify a repeated `commit` with a consumed review token returns the first operation, and a repeated `requestId` gives `INVALID_REQUEST`.
- Verify stale/out-of-order reads cannot replace the active view or authorize mutation.
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
