# Operation Contract: Windows Desktop Qualification

**Protocol version**: `1` | **Model**: [data-model.md](../data-model.md) | **Plan**: [plan.md](../plan.md)

This contract defines selected behavior, not implemented endpoints. Hunk and file staging use protected candidate publication; commits use the explicitly approved standard Git handoff. Validation checkpoints do not promise repository-wide atomicity. WSL2 repositories use Git inside their distro (§11). Submodule initialization and update follow §12.

## 1. Transport and authority

Use typed Tauri commands/channels between the main local webview and Rust. Register application commands through Tauri's application ACL manifest.

Grant only the operations below to the main local window. Deny remote webviews, shell execution, broad filesystem access, and unregistered application commands.

**Renderer request body.** Each §3 operation has one Tauri command, named as `src-tauri/build.rs` lists it. The bridge sends each envelope as the raw invoke body: `new TextEncoder().encode(JSON.stringify(envelope))`, a `Uint8Array`. Tauri delivers that body unparsed as `InvokeBody::Raw`. Reason: pinned Tauri parses a JSON invoke body into `serde_json::Value` before command code runs (`tauri-2.12.1/src/ipc/protocol.rs:520-530`). That parse has no size bound and keeps only the last of two duplicate keys. The postMessage fallback sends a `Uint8Array` as a JSON number array (`protocol.rs:294`). A refusal below is a `rejected` response with the stated code. The shell checks each renderer request in this order:

1. A call from a window other than `main`, or from an origin other than the local one, fails. The shell forwards nothing.
2. A JSON invoke body gives `INVALID_REQUEST` with `requestId` `null`.
3. A raw body above 1 MiB (§5) gives `FRAME_LIMIT` with `requestId` `null`. No parse runs before this check.
4. A body that is not a UTF-8 JSON object gives `INVALID_REQUEST` with `requestId` `null`. The shell reads only `operation` and `requestId` in this step.
5. An `operation` outside the allowlist gives `UNKNOWN_OPERATION`. An `operation` other than the operation of the command gives `INVALID_REQUEST`. A malformed `requestId` gives `INVALID_REQUEST` with `requestId` `null`.
6. A native-first operation (§3) gets its native step. The shell first decodes its body with the strict decoder below. A failure gives `INVALID_REQUEST`. The shell then checks its renderer envelope with the generated serde type ("Schemas" below).
7. The shell forwards the bytes unchanged in the `public` frame. A native-first operation forwards its envelope with the native payload instead.

The strict decoder refuses duplicate keys, nesting deeper than 16 levels, and unsafe integers. The service runs it on each body. The shell runs it only on a native-first body, because the shell reads that body. The zod schema of the envelope then validates the decoded value.

Rust and the compiled service use private inherited pipes. Frames contain a four-byte unsigned little-endian payload length followed by UTF-8 JSON.

Each pipe frame has a top-level `kind` field with the value `public`, `process`, `mutation`, `trust`, or `handshake`. A `public` frame holds one §2 request, its response, or a progress event. Its body is `{"kind":"public","request":<envelope>}`, `{"kind":"public","response":<response>}`, or `{"kind":"public","progress":<event>}`. A `handshake` frame holds the §6 "Startup handshake" frame or its reply. A `process`, `mutation`, or `trust` frame holds one message from §6 "Channel frames". The shell never forwards a `process`, `mutation`, `trust`, or `handshake` frame to the renderer. The renderer envelope in §2 has no `kind` field.

Reject a length header above the §5 frame bound before reading or allocating the body. The service answers it with a `public` response with `rejected`, `FRAME_LIMIT`, and `requestId` `null`. It then discards that many bytes without storing them. Reject invalid UTF-8, malformed JSON, duplicate object keys, excessive nesting, unknown fields, and unsupported protocol versions. Such a frame gets a `public` response with `rejected` and `INVALID_REQUEST`, or `PROTOCOL_VERSION` for an unsupported version. Its `requestId` is `null`, unless the frame holds a valid `requestId`. When the strict decoder refuses a `public` frame, the service reads `requestId` with a plain JSON parse. The shell forwards only bodies that its own JSON parse accepts. So each forwarded request gets a response with its `requestId`.

Use a strict bounded decoder. Do not rely on `JSON.parse` alone to reject duplicate keys.

**Schemas.** The zod 4 schemas in `src/contracts/` define the envelope, the payloads, the implemented results, and the progress event. They also define the handshake and the channel frames. TypeScript types come from `z.infer`. The service validates each strictly decoded value with these schemas. `bun run export:schemas` writes their JSON Schema files to `src/contracts/schemas/`. The shell build script generates serde types from these files with typify. JSON Schema has no byte bound, and typify drops `const` values and integer ranges. So both sides keep these rules as explicit checks: byte bounds, the UTF-16 path bound, `version` `1`, and integer ranges. serde also reads a struct from a JSON array. So the shell also compares the JSON shape of each typed value with its input. The golden vectors in `tests/vectors/` run in the Bun tests and in the Rust tests. The exported path schema holds only the rules of every platform: at most 32,767 code points and no NUL. Each side checks native absoluteness at runtime (§6 "Channel frames"). A golden vector with a `platform` field runs only on that platform, `windows` or `posix`.

The service owns Git arguments, parsing, snapshots, approvals, and outcomes. The renderer never supplies patches, revspecs, shell commands, executable paths, environments, or process IDs.

Native dialogs return selections to trusted registration code. Only registration can issue repository and Git-installation identifiers.

The public bridge is not a generic message bus. Its operation discriminator is a closed allowlist.

## 2. Envelope

| Field | Request rule |
| --- | --- |
| `version` | Integer `1`. |
| `sessionId` | Opaque service-session identifier. The service issues it in the shell-service startup handshake. The page receives it as the session paragraph below states. |
| `requestId` | Bounded identifier for response correlation. It is unique within the last 65,536 requests of the service session (§5 "Recorded request IDs"). The service records each valid `requestId` of a decoded envelope, also when it rejects the request. A repeated `requestId` gives `INVALID_REQUEST` and starts nothing. |
| `operation` | One exact operation name from the table below. It equals the operation of the invoked command (§1 "Renderer request body"). |
| `repositoryId` | Registered workspace identifier. Required for `readWorkspace`, `readEntries`, `readHistory`, `readComparison`, `readTrust`, `approveTrust`, `revokeTrust`, `applyHunk`, `applyFile`, `reviewCommit`, `commit`, `reviewSubmodules`, and `updateSubmodules`. Other operations omit it. |
| `repositoryGeneration` | Nonnegative safe integer for snapshot-bound operations. It must match the supplied snapshot, review, or trust fingerprint. For `readHistory`, it must equal the current workspace generation. |
| `selectionId` | Renderer selection generation, a top-level envelope field beside `repositoryGeneration`. `readComparison` requires it, and other operations omit it. The renderer issues it, so the service checks only its format. Never a mutation approval. |
| `payload` | Exact operation-specific object. Reject unknown fields. |

The bridge sends each envelope as a raw UTF-8 JSON `Uint8Array` body (§1 "Renderer request body"). The shell forwards these bytes unchanged. The renderer imports only the types of the zod schemas, so zod adds no renderer code.

Identifiers are UUID-shaped ASCII strings issued by the owning boundary. Validate format and session membership. Format alone never grants access. A malformed identifier gives `INVALID_REQUEST`. A well-formed identifier that this session did not issue gives `UNKNOWN_TARGET`. This includes a `sessionId` of another session, a released identifier, and an identifier of another workspace. A `readEntries` `cursor` is such an identifier. Only the snapshot that issued it accepts it (§3). `applyHunk` checks `UNSUPPORTED_COMPARISON` first (§9).

Require `repositoryGeneration` for `readEntries`, `readHistory`, `readComparison`, `applyHunk`, `applyFile`, `reviewCommit`, `commit`, `reviewSubmodules`, `updateSubmodules`, and `approveTrust`. Match trust approval against its issued fingerprint generation.

`readWorkspace` may include the last observed generation, but a mismatch must not prevent refresh. Other operations omit this field. Cancellation, revocation, and closure must remain available after a repository generation changes.

Each request gets exactly one response, and that response is terminal. The shell returns it as the result of the `invoke` call of that request. A response contains `requestId`, `operationId` when the service issued one, and a typed result. When an envelope passes validation and holds `repositoryGeneration` or `selectionId`, its response repeats that value. A `readWorkspace` response with a result carries the generation of that result instead. Responses omit each field that these rules do not set. When the service cannot encode a response within the §5 "Private/reply frame" bound, it sends a terminal `failed` response with `OUTPUT_LIMIT` for that request instead. `getOperation` then reports that replaced state. A request that the service rejects before admission has no `operationId`.

When the service admits a request, it issues an `operationId` and sends the accepted event. The accepted event is a progress event with `requestId`, `operationId`, and `state` `accepted`. It sends this event before any approval check, lock, or Git process. The accepted event does not mean approval, and a `rejected` response can follow. No request supplies a new `operationId`. Only `cancel` and `getOperation` name an issued one.

A progress event has exactly these fields: `requestId`, `operationId`, `state`, `phase` when set, `counters`, and `stalled`. The `state` is `accepted`, `running`, `cancel-requested`, or `reconciling`. The `counters` are bounded nonnegative integers. Only `commit` and `updateSubmodules` events carry `stalled` (§6 "Activity and stall notice"). Every progress event of an operation carries the `requestId` of the request that started it. A progress event contains no raw command, configuration, environment, patch content, Git text, or credential. A progress event is never a response, and the service sends none after the terminal response of its `requestId`.

The repeat key of a mutation is its one-use approval. For `commit`, the key is the review token. For `applyHunk`, the key is the hunk approval: comparison ID, hunk ID, and direction. For `applyFile`, the key is the file approval: comparison ID and direction. For `updateSubmodules`, the key is the submodule review token (§12). A repeated request with an approval that an accepted operation consumed gets a `succeeded` response with that `operationId`. Its result is the `getOperation` result of that operation. The repeated request gets no accepted event. It starts no Git process and no other execution. A new service session invalidates all old identifiers.

The service checks `requestId` before the repeat key. A repeated `requestId` gives `INVALID_REQUEST`, also when its approval was consumed. A retry after a lost response must use a new `requestId`. It then gets the consumed-approval state.

The shell starts the service and completes the startup handshake before it creates the main window. When the native settings hold a Git path, the handshake carries a startup `gitProbe` context for it (§6 "Startup contexts"). The page gets the current `sessionId` from the shell-only operation `currentSession` (§3). It calls `currentSession` at load and after each `service-session` event. `currentSession` is the only request without a `sessionId` field. No public operation carries a handshake, and no initialization script carries a session. Pinned Tauri sets initialization scripts only on builders, so a created window keeps its first script (research R7). When the service start or handshake fails, the shell still creates the window. `currentSession` then returns `SERVICE_UNAVAILABLE`, and the shell shows Git service stopped.

The shell may start the service process before it reads the platform facts, the WebView2 version, and the settings. It sends the handshake frame once those facts exist. The main window still waits for the handshake reply. When WebView2 admission fails, the shell closes the service Job and creates no window. The service answers the handshake before its startup Git probe ends (§6 "Startup contexts"). So window creation and page load overlap that probe.

The shell sends four events to the main window. `operation-progress` carries one §2 progress event without change. The shell checks its fields and drops an event with an unknown field. `service-stopped` reports a service exit and the unresolved recovery markers (§6). The page marks each request without a terminal response as State unknown. `service-session` reports a new service session after Restart service. `text-scale` carries the Windows text scale factor after each `TextScaleFactorChanged` event (plan.md "Windows text size"). The page does not reload for a restart. Drafts are renderer state with a stored copy in webview storage (plan.md "Stored drafts"), so they survive a service restart. After each `service-session` event, the page runs `restoreWorkspace` again, because old identifiers stay invalid (§8 "Service restart"). A reloaded page joins the current service session through `currentSession`. Only Restart service or application start creates a new service session. Identifiers from an old session stay invalid in the new one.

## 3. Public operations

| Operation | Payload | Result and checks |
| --- | --- | --- |
| `getEnvironment` | Empty object. | Build identity, detected and minimum versions, selected Git, prerequisite admission, and separate qualification status. The selected Git is `selectedPath`, the path that the user selected. `executablePath` is the resolved file that runs ("Git proposal" below). `previousVersion` is the saved version when this startup admitted another version (§6 "Startup contexts"). A startup failure can carry `reason` and `path`. `reason` is `selected-missing`, `resolution-failed`, `resolved-missing`, or `outside-installation`. `path` names the missing selected file or the missing resolved file. The qualification status is `passed` only when the detected version set is on a build-time list. That list holds the sets with recorded passing evidence. This slice ships that list empty, so the status stays `unverified`. Platform scope `qualification-target` for Windows 11 x64 on a native AMD64 machine with product type `VER_NT_WORKSTATION`, otherwise `other`. The recovery markers that the shell owns at session start (§6, §8). Each marker holds exactly `markerId`, `kind`, `startedAt`, and `worktreeRoot`. The damaged markers of the handshake, each with exactly `markerId` and `fileName` (§6 "Damaged markers"). No environment dump. |
| `chooseGit` | Renderer: empty object. Service: exactly the native-issued `bootstrapId` and the probed `executablePath`, a native absolute path (§6 "Channel frames"). | Native executable proposal or selection, explicit approval, version probe, and installation ID. A success result holds `gitInstallationId`, `selectedPath`, `executablePath`, `version`, and `digest`. Cancel preserves the current selection. A success that issues a new `gitInstallationId` releases every workspace bound to the previous installation (§6 "Registration reuse and release"). It sends one `release` for each released workspace and one `release` for the previous installation (§6 "Channel frames"). While such a workspace has an unfinished mutation, `chooseGit` gives `BUSY`. A failed or canceled `chooseGit` releases no workspace and keeps the previous installation. It sends one `release` for a new `gitInstallationId` that the shell bound. "Git proposal" below defines the native step. |
| `chooseRepository` | Renderer: empty object. Service: only the native-issued `bootstrapId`. | Native folder selection and Git registration. The result holds the `repositoryId`, the current `generation`, and the `worktreeKey` ("Worktree key" below). Cancel preserves the current workspace. A WSL path follows §11, including the distro start and its Cancel. |
| `restoreWorkspace` | Renderer: empty object. Service: only the native-issued `bootstrapId`. | Revalidate the last explicitly chosen repository from application settings. No caller-supplied path. The result holds the `repositoryId`, the current `generation`, and the `worktreeKey`. A WSL path follows §11. |
| `readWorkspace` | `refresh: boolean` and `check: "full"` or `"changes"`. `refresh: true` with `check: "changes"` gives `INVALID_REQUEST`. | Git-derived identity, HEAD, operation state, status completeness, hunk-profile eligibility, snapshot ID, and recovery state. Only a user Refresh action sends `refresh: true`, always with `check: "full"`. Focus return and the first read send `refresh: false` with `check: "full"`. The read after a mutation outcome and the read after a trust approval also send `refresh: false` with `check: "full"`. Polls send `refresh: false` with `check: "changes"` (§8 "Change check"). WSL polls send `check: "full"` instead (§11 "Change polling"). An explicit refresh of a blocked workspace performs recovery reconciliation (§8). Status paging (T284 implements it): a result holds the summary, `entryCount`, `entries`, and `cursor`. `entryCount` counts the entries of all pages. `entries` holds the first page. `cursor` names the next page, or is `null` after the last page. The `cursor` field is always present. Later pages come from `readEntries`. |
| `readEntries` | `snapshotId` and `cursor`. The envelope carries `repositoryId` and `repositoryGeneration`. T284 implements this operation. | One later page of status entries from the retained snapshot. It starts no Git process. The result holds only `entries` and `cursor`. `entries` holds at least one entry. `cursor` names the next page, or is `null` on the last page. The `cursor` field is always present. The service issues each cursor as an opaque §2 identifier in UUID format. The renderer sends back only a cursor that it received. It never builds or changes a cursor. A malformed cursor gives `INVALID_REQUEST`. The service checks `repositoryGeneration` first, then `snapshotId`, then `cursor`. A stale `repositoryGeneration` gives `REPOSITORY_CHANGED`. A released or replaced snapshot gives `UNKNOWN_TARGET`. A well-formed cursor that this snapshot did not issue gives `UNKNOWN_TARGET`. These refusals end `rejected` (§9). Each page that the service serves ends `succeeded`. The renderer keeps `entryCount` and the snapshot completeness from `readWorkspace`. Each page stays within the §5 "Status page" bound. |
| `readHistory` | Empty object. The envelope carries `repositoryGeneration`. | Bounded HistoryPage: at most 100 checkout-reachable commits, ordered parents, boundary metadata, captured HEAD, and completeness. No arbitrary ref or pagination argument. The service captures HEAD itself and needs no status snapshot. It can run beside `readWorkspace` within the §5 read caps. Trust gating follows the read rule in §7. |
| `readComparison` | Current snapshot ID and issued entry ID. The envelope carries `repositoryId`, `repositoryGeneration`, and `selectionId`. | One supported canonical comparison with hunk IDs, or an explicit unsupported/limited result. Every `succeeded` and `limited` result also carries the file-action decision of its entry (§4 "File staging"). A `failed` or `canceled` result carries none. Exception: an entry without index `flags` gets only `completeness` (§4 "Comparison limits"). |
| `readTrust` | Empty object. The envelope carries `repositoryId`. | Safe execution-policy summary, approval fingerprint, trust `state`, and `persistence` (`stored` or `session`). Show configuration values only for the §7 value display allowlist. Redact URL user information first (§7). A trust listing that cannot complete ends `failed` with `REPOSITORY_UNAVAILABLE`. Its result form is `TrustListingFailed`: only a remedy text that names the path and the error code (§7 "Program file digests"). `approveTrust` gives the same form for that cause. `readWorkspace` ends `failed` with `REPOSITORY_UNAVAILABLE` in its own refusal form. |
| `approveTrust` | `fingerprint`: the issued fingerprint. `approve`: `true`. Any other `approve` value gives `INVALID_REQUEST`. | The service checks the fingerprint and its generation. The shell then shows a native confirmation (§7 "Trust approval store"). Approve returns the trust ID, `persistence` (`stored` or `session`), and `saveFailed` (boolean). `saveFailed` is `true` only when the shell replied `stored: false` after `persist: true`. It stores the approval, or keeps it for the service session only over a digest bound (§7). Cancel returns `canceled` and stores nothing. A changed policy requires new approval. |
| `revokeTrust` | Current trust ID. | Delete the stored approval, revoke future executable operations, and invalidate dependent approvals. Running work needs explicit cancellation. The shell also closes every lingering Job of that common directory (§6 "Lingering Jobs"). The result states how many processes ended. An unfinished mutation of that common directory ends its processes at `ended` and never lingers (§6). Without a current trust ID, no remedy or outcome text offers Revoke trust (§9 "Lingering count"). |
| `applyHunk` | Comparison ID, hunk ID, snapshot ID, and direction `stage` or `unstage`. | Profile check, fresh validation, exact candidate publication, and reconciled outcome. No renderer patch or whole-file fallback. |
| `applyFile` | Comparison ID, snapshot ID, and direction `stage` or `unstage`. | Whole-file staging of the compared entry (§4 "File staging"). Profile check, fresh validation, verified candidate publication, and reconciled outcome. No renderer path, patch, or content. |
| `reviewCommit` | Current snapshot ID. | Complete staged scope, reviewed index/checkout, execution-policy disclosure, limitations, and one-use review token. Read-only inspection only. A `reviewCommit` with an empty staged scope succeeds. Its result shows the empty scope and carries no `reviewToken`. A `commit` with a well-formed review token that this session did not issue gives `UNKNOWN_TARGET` (§2). A malformed or missing token gives `INVALID_REQUEST`. A consumed token follows the §2 repeat rule. |
| `commit` | `reviewToken`, `message`, and `confirmFullScope`: `true`. Any other `confirmFullScope` value gives `INVALID_REQUEST`. | Fresh preflight, one ordinary canonical Git commit invocation, progress events with the §6 stall flag, and a reconciled outcome: `succeeded`, `completed-with-effects`, `failed`, `failed-with-effects`, `canceled`, or `unknown`. A repeated `commit` with a consumed review token returns the existing operation state and `operationId`, and starts no Git process. |
| `reviewSubmodules` | Current snapshot ID. | Read-only submodule plan (§12 "Plan"), each refusal, the submodule program list, and a one-use submodule review token. Trust gating follows the read rule in §7. |
| `updateSubmodules` | `submoduleReviewToken` and `start`: `true`. Any other `start` value gives `INVALID_REQUEST`. | Fresh preflight, and a native confirmation when §12 lists submodule programs. Fetch, check, and checkout steps for each row, level by level, with progress events (§12 "Update protocol"). A reconciled outcome with one result per submodule (§12). A repeated request with a consumed token returns the existing operation state and `operationId`, and starts no Git process. |
| `cancel` | Issued operation ID. | The `cancel` response is the acknowledgement. It holds the current state of the target. The target's terminal outcome comes later in the response of the target's own `requestId`. |
| `getOperation` | Issued operation ID. | Current or retained terminal state. Never retries an operation. A removed record gives `UNKNOWN_TARGET` (§5 "Finished operation records"). |
| `requestClose` | `stay`, `closeIfIdle`, or `interruptAndClose`. | The shell decides natively and never forwards this operation to the service. A running mutation always shows the native prompt, whose default is Stay open. Only its Interrupt and close button confirms interruption. |
| `currentSession` | Empty object. The envelope has no `sessionId`. | The shell answers natively and never forwards this operation to the service. The result is the current `sessionId`, or `SERVICE_UNAVAILABLE` while no service session runs. Both results carry `textScale`: the current Windows text scale factor, from 1.00 to 2.25 (plan.md "Windows text size"). |
| `dismissRecoveryMarker` | Renderer: one marker ID from `getEnvironment` or `service-stopped`. Service: that marker ID and the native-issued `bootstrapId`. When the stored worktree path does not exist, the service payload holds only the marker ID (§6 "Dismissal"). For a damaged marker, the service payload also holds only the marker ID. | Explicit removal of a marker whose repository is gone, or of a damaged marker (§6 "Dismissal"). The result states that the operation outcome stays unknown. |

The native dialog and confirmation code must not accept renderer-supplied replacements for selected paths or approval fingerprints. The trust confirmation shows only the fingerprint that the service sends.

The shell runs the native step of `chooseGit`, `chooseRepository`, and `restoreWorkspace` first. A canceled dialog returns a canceled result from the shell, and no frame reaches the service. Otherwise the shell forwards the request with its native-issued `bootstrapId` in the payload. For `chooseGit`, the payload also holds the candidate `executablePath` of that context. The service reads that file as a stream to compute its SHA-256 digest, within the §5 "Git executable digest input" bound. The renderer payload must be empty, and the shell rejects any renderer field.

**Git proposal.** The native step of `chooseGit` first looks for a candidate `git.exe`. With a saved Git, the candidate is the saved selected path. Without one, the shell searches its own `PATH` for `git.exe`, then tries `%ProgramFiles%\Git\cmd\git.exe`. A saved path that is missing or cannot be read is no candidate, and the shell continues with the `PATH` search. The shell creates a `gitProbe` context for the candidate, and the service probes it. The probe first runs `--exec-path` with the candidate. It selects `git.exe` in the printed folder, the resolved file. Reason: the Git for Windows wrapper `cmd\git.exe` gives Git a hidden console (§6 "Console and input"). Every installer option makes the wrapper the candidate. When the resolved file differs from the candidate, the service sends `resolveGit` (§6 "Channel frames"). The shell then binds a new `gitProbe` context to the resolved file. That context keeps the selected path. The digest, the version probe, the registration, and every later process use the resolved file. The saved settings keep both paths (data-model §1). In `chooseGit`, a missing resolved file, or one that is not a regular file, gives `GIT_UNSUPPORTED`. The service never falls back to the candidate. The native Git selection confirmation then shows the lines `Use this Git?`, `Path: <selected path>`, and `Version: <version>`. When the resolved file differs from the selected path, a `Runs: <resolved path>` line follows the `Path` line. When the probed file is the saved resolved path, it also shows the stored version (data-model §1). Its buttons are Use this Git, Choose another Git, and Cancel, and Cancel is the default. Choose another Git opens the executable picker. The shell creates a `gitProbe` context for the picked file. The `register` reply `another` carries its `bootstrapId` and `executablePath`. The service then probes, digests, admits, and registers that candidate in the same operation. Enter on the default, Escape, Alt+F4, the close button, and a call failure mean Cancel. Without a candidate, the picker opens directly. No candidate is ever selected without Use this Git (FR-003). The startup check keeps the saved selection. It admits a Git upgrade inside the installation root (§6 "Startup contexts").

**Worktree key.** `worktreeKey` is 64 lowercase hex digits: the SHA-256 of the worktree root identity. For a Windows worktree, that identity is the volume serial number and the 128-bit file ID (§6). The hash input is 24 bytes: the 64-bit `VolumeSerialNumber` as 8 big-endian bytes, then the 16 `FILE_ID_128` `Identifier` bytes in array order. These are the bytes of the hex text `volumeSerial` then `fileId` of the identity reply (§6 "Process fields"). For a WSL worktree, the hash input is the UTF-8 identity text `<distroGuid>:<fileSystemId>:<inode>` of the WSL identity reply (§6 "Process fields"). For example, `{c6d24ae9-40f2-40bf-b35d-bf0b6ca4ea00}:fedc9aa3bd65bc57:2` gives `d35b7df970a300771b81b46358abc1283b4307e394398f6097f740d0b6c495f6`. So both WSL prefixes of one folder give one key, and the key stays equal across sessions. The key grants no access; it only names the stored draft of that worktree (plan.md "Stored drafts"). No log or diagnostic receives it.

For `dismissRecoveryMarker`, the renderer payload holds only a marker ID that the shell owns. The shell binds a `repositoryDiscovery` context to the stored worktree path of that marker. It forwards the marker ID with the `bootstrapId`. When that path does not exist, the shell creates no context and forwards only the marker ID. A damaged marker has no stored worktree path, so the shell also forwards only its marker ID. The native confirmation comes after the service result (§6 "Dismissal").

Blank messages, empty staged scope, conflicts, unfinished operations, stale snapshots, and incomplete data refuse mutation. Missing trust refuses a mutation only when it can run a repository-controlled integration (§7 "Mutation trust").

Commit approval covers the full staged scope. It never means “commit the selected file”. Unsupported file diffs can remain in a complete commit review.

Approval authorizes standard Git execution after fresh preflight, not an immutable tree or destination. Preserve approved hooks and report late changes explicitly.

### HistoryPage result

Bind the result to its repository, the request `repositoryGeneration`, the captured HEAD target/OID, the shallow fingerprint, and scope `current-checkout`. The renderer keeps a page while its captured HEAD equals the newest observed HEAD. A generation change alone does not discard it. The renderer accepts a late history response when its captured HEAD equals the newest observed HEAD, whatever its generation. When a read observes another HEAD, the renderer requests `readHistory` once. After `REPOSITORY_CHANGED` for `readHistory`, the renderer resends it once with the current generation. Each row contains a full OID, ordered effective parent OIDs, subject, author, and date. It also carries the commit object's `encoding` header value, or none when the header is absent.

Use Git's child-before-parent date order. OID lengths follow the repository object format. Reject duplicate rows, malformed OIDs, and invalid in-page parent ordering.

Return separate page-boundary and shallow-boundary metadata. An unavailable parent is not a root. Show current HEAD/branch only from the captured identity; do not invent branch ownership for commits.

Resolve shallow metadata through Git and recheck its bounded fingerprint with the captured checkout. In a partial clone, missing objects give `limited` with `OBJECT_MISSING`, without fetching. The page keeps its bounded rows. Without a promisor remote, a missing object gives `failed` with `REPOSITORY_UNAVAILABLE` (§7 "Missing objects"). Graph-only layout limits remain frontend presentation state, not workspace mutation blockers.

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

Any `working-tree-encoding` value other than `unspecified` gives reason `encoding`, also `UTF-8`. No source check confirms that Git skips that conversion.

**Limitation remedies.** `applyFile` refuses some entries ("File staging" below). Such an entry can still need staging or unstaging as a whole file. The service then attaches a copyable remedy command to the change entry. The app never runs it (FR-011).

- An entry that `applyFile` refuses with reason `size`, `rename`, `type`, `symlink`, `LFS`, `filter`, or `blob-proof` gets a remedy. Other reasons get none.
- A native entry gets no remedy when no Git path is selected. A WSL entry gets no remedy when the §11 route of its worktree root fails.
- A `stage` result with `GIT_FAILED` also carries the `add` remedy of its entry and an `outputTail` (§9).
- An Unstaged or Untracked entry gets `& '<selected Git path>' --literal-pathspecs -C '<worktree root>' add -- '<path>'`.
- A Staged entry gets the same form with `restore --staged -- '<path>'`. In an unborn repository, it uses `rm --cached -- '<path>'`, because `restore --staged` needs HEAD.
- A rename record names the source path and the destination path.
- Quoting rule. Every remedy command of this contract puts each interpolated value in single quotes. The values are the selected Git path, each worktree root, and each path. They also include each submodule worktree, Git directory, remote name, branch name, commit ID, and distro name.
- PowerShell ends a single-quoted string at five characters: U+0027, U+2018, U+2019, U+201A, and U+201B. Each of them inside a value is doubled. A research R5 probe showed that doubling keeps each of them literal. `--literal-pathspecs` keeps path characters literal.
- No command is offered when a value holds U+0022, U+201C, U+201D, or U+201E. The same holds for a control character or for bytes that are not valid UTF-8. Control characters are U+0000 to U+001F and U+007F to U+009F. The state then shows the value as plain text without Copy command.
- A refused value gives the remedy `{ text: "PowerShell cannot pass this value safely, so Arbareto offers no command: <value>", command: null }`. `<value>` is the refused value as text, or empty when no single value is identified. A value that is not valid UTF-8 has no text form, so `<value>` is empty.
- Reason: Windows PowerShell 5.1 passed a value with U+0022 to Git without its quotes. A value that starts with U+0022 merged with the next argument into one Git option (research R14 S28). PowerShell 7.6 kept each value literal. U+201C to U+201E and control characters stayed literal in both shells. The rule still refuses them, because PowerShell reads U+201C to U+201E as double quotes outside single quotes. PowerShell cannot hold invalid UTF-8 bytes.
- No command is offered when a value ends in U+005C. The only exception is a drive root: one letter, U+003A, and U+005C, such as `D:\`.
- Reason (research R14 S34): Windows PowerShell 5.1 puts an argument in double quotes when it holds white space. U+0020, U+00A0, U+2002, and U+3000 each caused this. Every interpolated value but one ends its argument, so the closing quote follows its last character. The exception is the System32 path of the §11 form, which `\wsl.exe` follows. One trailing U+005C escaped that quote, and the value merged with the next argument. Two became one, so the value changed. PowerShell 7.6 kept each value literal.
- Without white space, 5.1 adds no quotes, and a trailing U+005C stayed literal. The rule still refuses such a value, because this is the stricter reading. A drive root holds no white space, and both shells passed `D:\` literally.
- Path form. The service removes each trailing U+005C and U+002F from a Windows path that it puts in a command. A drive root keeps its separator, such as `D:\`. So no built Windows path ends in U+005C, except a drive root. The rule changes no other character of the path.
- A UNC share root also loses its trailing separator, such as `\\server\share`. No probe ran Git with such a root, so that form stays unverified (research R14 S34). A WSL command takes Linux paths unchanged (§11).
- The §9 hook remedy and the §11 and §12 commands use this rule. One shared builder applies it.
- The remedy text is: "This command stages or unstages the whole file with your Git settings. Run it in a terminal."

Disable executable external diffs and text conversion for supported inspection. Ordinary Git EOL conversion remains distinct from custom filters.

For tracked entries, generate hunks as `git add -p` does: `diff-files` to stage, `diff-index --cached` to unstage. Git's diff demotes a `core.safecrlf` failure to a warning, so hunks follow `git add -p`, not `git add`. Refuse a hunk request when `ls-files --eol` reports `mixed` for the index or working side. Its reason is `line-endings` (data-model §5), and it applies to hunks only. `ls-files --eol` reports `i/none` for a missing index blob and exits 0 (research R5). So a missing object is detected only by the §7 object check, never from `ls-files --eol`.

For untracked entries, the T092 read is `diff --no-index --no-ext-diff --no-textconv --no-color --src-prefix=a/ --dst-prefix=b/ -- /dev/null <path>` (research R3 "Untracked hunk content"). An untracked entry gets no hunk action and reason `line-endings` when an index entry `.gitattributes` exists in the folder of the path or an ancestor folder, with no regular working file at that path. `core.safecrlf` gives no untracked refusal: untracked hunks follow `git add -p`, as tracked hunks do. The flags `--no-ext-diff` and `--no-textconv` are necessary: without them, `diff --no-index` ran `diff.external` and `textconv` in a research R5 probe. They are not sufficient: the clean filter still ran. So `check-attr` runs first, and a `filter` attribute gives reason `filter` before any untracked diff runs. The §7 read gate still blocks every read while a repository-controlled clean filter lacks approval.

Pierre may parse the canonical service patch for display. If display mapping disagrees with service hunks, disable actions and report `DISPLAY_MAPPING_FAILED`.

### Hunk eligibility and publication

Require an ordinary full index. Refuse unqualified sparse/split indexes, registered `post-index-change` hooks, and executable fsmonitor integrations. A split index is an index with a `link` extension in its raw bytes (Git `Documentation/gitformat-index.adoc`). The service reads that extension itself and never asks Git for the shared index path (§6). Also refuse the built-in fsmonitor daemon (`core.fsmonitor=true`), because this slice has not qualified it. Hook discovery includes disabled registrations; this slice conservatively refuses every index-change registration.

**Split index.** Refuse an effective `core.splitIndex=true` from any scope, also with an unsplit index. The §7 configuration listing supplies the value, so the check starts no process. Research R3 probe 9 shows why:

- With `core.splitIndex=true`, `update-index` and `apply --cached` on a private candidate split the candidate. Each wrote a new `sharedindex.<hash>` file into the Git directory. A global value had the same effect.
- With `splitIndex.sharedIndexExpire=now`, one candidate write deleted the shared index file of the split canonical index. Git then could not read the canonical index. Git deletes shared index files by that setting when it creates a new one (git-config(1) `splitIndex.sharedIndexExpire`).
- `update-index --no-split-index` writes an unsplit candidate, but `apply --cached` has no such option.

The refusal reason is `split-index` for both a `link` extension and `core.splitIndex=true`. Its text is: "Git's split index is on for this repository. Arbareto stages hunks and files only with a full index. Stage this change in a terminal." Step 6 of each protocol also checks the raw candidate. A `link` extension there refuses with the same reason. The §7 environment rule removes `GIT_TEST_SPLIT_INDEX`, which also split a candidate in probe 9.

Return `UNSUPPORTED_HUNK_PROFILE` with a safe explanation. Never bypass those integrations or change user configuration. Index-change registrations block hunk and file publication only; ordinary commits still respect approved hooks.

Hold the exclusively created canonical index lock through candidate preparation, verification, and publication. Revalidate the complete snapshot and profile before preparing the candidate.

Use an owned private index and service-retained Git patch. Apply through `git apply --cached`, reversing the selected staged hunk for unstaging. Create a missing empty candidate through Git, not a malformed zero-byte index.

**Candidate time.** A copied candidate gets a last-write time at or before the canonical index time minus 100 ns. Node.js sets whole milliseconds, so on Windows the service sets the whole millisecond at or before that value. Git for Windows compares whole seconds (built without `USE_NSEC`), so the earlier time only makes more entries racy. The service sets it after the copy and reads it back. A later time refuses the request before any Git step. Git treats an entry as racily clean when its mtime is not older than the index file time (Git `Documentation/technical/racy-git.adoc`). A copy with a new time loses that protection (research R3 probe 8):

- `update-index --add` on such a candidate kept the old blob of a same-size change in 2 of 20 runs.
- A published `apply --cached` candidate hid an unrelated working change from later `status` in 10 of 30 runs.
- With the canonical time kept, both failures stayed at 0 of 20 and 0 of 30.

An earlier time only makes more entries racy, so Git compares their content. A `\\wsl.localhost` view rounds the Linux time to 100 ns and can round it up (research R13 probe P5). The 100 ns step applies only to a time that the service sets through such a 9P view. No WSL step does this.

**Published time.** The service reads the time and the bytes of the verified candidate through one handle, the time first. Publication sets the lock last-write time to that time, at or before it, after the bytes are written and flushed. The service reads it back through the lock handle. A later time refuses publication, and nothing is published. Reason: Git smudges only entries that are racy against the index it read. A later published time hides a same-size change made in the second of the candidate write. The WSL `publish` mode sets the whole seconds of the candidate `st_mtime`, which is at or before that time ("WSL index publication" below).

WSL in-distro form (§6 "WSL file work", mode `candidate`): Perl copies the index into the candidate inside the distro. It sets the candidate access and modification times to the whole seconds of the canonical `st_mtime` with core `utime`, then reads them back with `stat`. Core `utime` sets whole seconds (Perl `doio.c` `apply`, `OP_UTIME`, sets `tv_usec` to 0), and `stat` gives whole seconds. So the candidate time is at or before the canonical time, and the reply holds both values. The service refuses a candidate time above the canonical time before any Git step.

Verify exact candidate bytes, entry existence, mode, stage, and unrelated logical index entries against the independent expected result. Applicability, full-index headers, or a second apply test are insufficient.

Before publication, recheck canonical index bytes, working content, checkout, attributes, configuration, trust, and operation state. Every detected mismatch prevents publication. Honor cancellation before publication begins. Publish only the verified candidate through the owned lock's same-volume replacement.

**Windows lock ownership.** The service creates `index.lock` with `CREATE_NEW` and holds that handle until publication or removal. The lock is owned while `lstat` of the path gives the 64-bit file ID and volume serial of `fstat` on the held handle. That ID is unique on NTFS and ReFS while the file exists; ReFS gives all ones when it cannot be unique (MS-FSCC 2.1.9 and Appendix B note 10). Registration admits only volumes with a 128-bit file ID (§6), so FAT and exFAT never reach this check. A handle ID of 0 or 0xFFFFFFFFFFFFFFFF has no unique value. The service then writes a 64-hex-digit token through the handle and closes it. It removes the lock only when the file at the path holds exactly the token. Then it refuses with `UNSUPPORTED_HUNK_PROFILE` reason `file-id`. The text is: "This volume gives the index lock no unique file ID. Stage this change in a terminal." Like the other §6 compares, it checks that two reads name one file, and it never produces a physical identity. A commit publishes nothing through `index.lock`. A `file-id` lock result removes the lock by its token, and the commit continues. A `file-id` result with `removed: false`, a `create-failed` result, or a release result other than `removed` stops the commit before handoff with `GIT_FAILED`. The result names a remaining lock in `foreign`.

**WSL index publication.** A WSL repository creates the lock, copies the candidate, and publishes inside the distro, through the modes `lock`, `candidate`, and `publish` of §6 "WSL file work". No step writes the index, the lock, or the candidate through a `\\wsl.localhost` path.

- `lock` creates `index.lock` with `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` and mode 0666 before the umask, as Git does (`lockfile.h` default 0666, `tempfile.c` `repo_create_tempfile_mode`). Git then applies the `core.sharedRepository` permissions (`adjust_shared_perm`). A WSL repository whose effective configuration has `core.sharedRepository` at any scope refuses `applyHunk` and `applyFile` with `UNSUPPORTED_HUNK_PROFILE` reason `shared-repository`. The service reads the key from the §7 configuration listing (`config list --show-scope --show-origin -z`), so the check starts no process. The key at any scope in that listing refuses. Its absence allows the mutation. The in-distro `lock` mode does not apply Git's `adjust_shared_perm`. The refusal text is: "This repository sets core.sharedRepository. Arbareto stages hunks and files in a WSL repository only without it. Stage this change in a terminal." `EEXIST` gives `LOCKED`, and the lock stays. The `LOCKED` result path is the UNC form of `index.lock`, as for every other WSL result path (§11 "Paths and file access"). The reply holds the device and inode of the lock from `fstat`.
- Lock token. The service generates 32 random bytes for each `lock` request and sends them as 64 lowercase hex digits in `token`. `lock` writes the token into the new lock right after the `O_EXCL` create. The lock is owned when it has the device and inode of the `lock` reply and its content equals the token exactly. A lock that Git creates is empty or starts with `DIRC` (Git `Documentation/gitformat-index.adoc`), so it never equals the token. Reason: ext4 gives a freed inode to the next new file at once. In R13 a deleted and recreated lock got the same inode in 3 of 3 runs, so device and inode alone cannot show ownership. A copy of the lock at a new inode holds the token, so the token alone cannot show ownership either. `publish` and `remove` both require the device and inode of the `lock` reply and the token content. Recovery identifies an owned stale lock by the same rule. Exception: a stopped `lock` walk and a `lock` result `error` give no `lock` reply. Only on that path, after the process-end fact, does the service send the token-only `remove` form. It checks the size, the token content, and `lstat` against `fstat`. Reason: Git never writes a 64-hex-digit token into `index.lock`, so a lock that holds exactly the token is ours. Accepted limit: the token-only form also removes a copy of the lock that holds the token.
- Process end. A stop of a `wslFiles` walk ends only its `wsl.exe` (§6 "Walks"). The Linux Perl process can outlive that stop for a short time, so a stopped `lock` or `publish` can still change files. The walk runs through the wrapper in the scope `arbareto-<operationId>-<n>.scope` of its operation (§11 "Process launch"). The anchor of the operation counts the processes of every `arbareto-<operationId>-*.scope` from their `cgroup.procs` files (§11 "Process ownership"). That count reaches the service as `activeDescendants` in the `exit` reply of each later process of the operation (§11 "Process ownership"; a mutation `run` starts the anchor when none runs). The anchor selects the scopes by unit name, so the count does not depend on which anchor process prints it. After a stopped `lock` or `publish` walk, the service sends one `run` of `git version` with the `mutation` policy and the approved Git of the workspace. Its arguments are `--no-lazy-fetch` and `version`, and the shell adds `-C` ("Process launch" in §11). The shell starts the anchor before that process when none runs. Its `exit` `activeDescendants` is the count, and 0 is the process-end fact. `version` reads and writes no repository file: it has no setup flag in Git `git.c` `commands[]`. A `run` with another policy starts no anchor, and without an anchor its `exit` carries the Job count of `wsl.exe` processes. After a stopped walk, the service decides nothing until such an `exit` reply carries `activeDescendants` 0. Until then the state stays `reconciling`. A count above 0 can also come from a lingering hook child. A walk `cancel` and a walk deadline end only the walk's `wsl.exe` (§6 "Walks"). They close no Job, and the operation ID stays active, so the anchor can still start. A `closeJob` closes the Job with its anchor and makes the operation ID inactive (§6 "Channel frames"). A later `run` of that operation then gets `UNKNOWN_TARGET`, and no anchor starts. After a `closeJob` or a service failure, no such fact can come, and the state stays unknown. A closed Job is not a process-end fact. Recovery then names the lock and the candidate as foreign and keeps them (§8).
- Stopped or failed `lock`. A stopped `lock` walk (cancel, `closeJob`, or deadline), and a `lock` result `error`, leave lock ownership unknown. A `lock` walk stopped by `cancel` or deadline first waits for the process-end fact above. Then the service sends `remove` with the token. After a `closeJob`, recovery names the lock as foreign and keeps it (§8). `removed` means that the lock was owned and is gone. `notOwned` means that no owned lock exists. `error` leaves ownership unknown, and explicit recovery applies (the "Unknown ownership or publication state" rule below).
- `candidate` is step 4 of each protocol ("Candidate time" above). An absent index gives `absent`, and the service creates the candidate through `read-tree --empty`, as before. An index above `MUTATION_RAW_INDEX_BYTES` gives `bound`, and a non-regular index gives `error`.
- `publish` is the last publication step. It opens `index.lock` with `O_RDWR|O_NOFOLLOW|O_NONBLOCK` and holds that descriptor through the rename. An absent lock gives `notOwned`. The open lock must be a regular file with the device and inode of the `lock` reply, 64 bytes, and the token as content. Otherwise the result is `notOwned`. Then it truncates the lock, copies the candidate into it, and digests the copied bytes. It sets the lock times to the whole seconds of the candidate `st_mtime` with core `utime`. A digest other than the verified candidate digest of step 6 gives `mismatch`. The lock then holds the token again, and no rename follows. Otherwise it calls `fsync` on the lock and checks with `lstat` that the name `index.lock` still has the device and inode of the open descriptor. Another device or inode gives `notOwned`, with the token written back and no rename. Then `rename(2)` replaces `index` with the lock, and `fsync` on the Git directory follows. A rename on one file system is atomic (POSIX.1-2024 `rename`).
- An open inode cannot be reused, so the last `lstat` closes the path swap. A window remains between that `lstat` and the `rename`: a writer that ignores the lock can replace `index.lock` there. Git's own lock commit has the same window (`lockfile.c` `commit_lock_file` renames by path).
- Durability. `publish` always calls `fsync` on the lock before the rename and on the directory after it. This is more durable than Git's default. The shell does not parse `core.fsync`.
- An earlier published time only makes more entries racy ("Candidate time" above). A copy with a new time would lose that protection.
- Every other step stays: the revalidation under the lock, the candidate verification, the recheck before publication, and the stale-selection refusal. The canonical index recheck compares the `indexDigest` reply with the retained digest. It reads no index bytes.
- A stop of a `publish` walk (cancel, `closeJob`, or deadline) leaves the publication state unknown. The mutation then enters `reconciling` (§8). For a `publish` walk stopped by `cancel` or deadline, reconciliation decides nothing until the process-end fact above. Only then does the `indexDigest` result decide: an index digest equal to the verified candidate digest means published, and another index digest means not published. An `index` part `absent`, `bound`, or `error` decides nothing, and the state stays unknown. A not-published state with an owned lock follows the token rule above. After a `closeJob`, recovery names the lock and the candidate as foreign and keeps them (§8).
- A `publish` result `notOwned` ends the mutation `failed` with `STALE_SELECTION`. Nothing is published, and the result path is the UNC form of `index.lock`.
- Outcome after a stopped walk. After a `closeJob` of a `lock` or `publish` walk, the outcome is `unknown`. The lock and the candidate stay as foreign (§8). Interrupt and close sends no terminal response, and the next start shows the workspace `unknown` (§8). A `lock` walk stopped by `cancel` ends the mutation `canceled` after the process-end fact and a `remove` result `removed` or `notOwned`. A `lock` walk stopped by a deadline ends it `failed` with `DEADLINE` after the same steps. A stopped `publish` whose `indexDigest` result has the verified candidate digest is published. Reconciliation then classifies it as a completed publication: `succeeded`, or `completed-with-effects` when the observed state differs (§8). For `applyFile`, the post-publication working-file digest of "File staging" below decides this. A stopped `publish` whose `indexDigest` result has another index digest is not published. The service then sends `remove` for the owned lock. After `removed` or `notOwned`, a `cancel` stop ends the mutation `canceled`, and a deadline stop ends it `failed` with `DEADLINE`. A `remove` result `error` leaves ownership unknown, and explicit recovery applies. An `index` part `absent`, `bound`, or `error` gives `unknown`. A `publish` result `mismatch` ends the mutation `failed` with `STALE_SELECTION`. Nothing is published. The service then sends `remove` with the lock identity and token. A `publish` result `error` counts as a stopped `publish`. After the process-end fact, the index digest decides, as for a stopped `publish`. When that digest shows no publication, the service sends `remove` for the owned lock. After `removed` or `notOwned`, the mutation ends `failed` with `GIT_FAILED` and safe recovery guidance (§9 "When a cause is uncertain" and the failed file step). A `lock` result `error` ends the mutation `failed` with `GIT_FAILED` after the process-end fact and a token-only `remove` result `removed` or `notOwned`. A `candidate` reply with a candidate time above the canonical time ends the mutation `failed` with `GIT_FAILED`.
- The service removes an owned lock or candidate inside the distro with mode `remove` (§6 "WSL file work"): the lock by the device and inode of its `lock` reply and its token, and a candidate by the digest that the service verified last. A candidate has no stable inode, because Git writes it through its own lock file and a rename.

Supported processing does not write working-file content. The lock excludes cooperating index writers, not every independent file/ref/configuration change. Report observed late changes and preserve external bytes without undo or retry.

Unexpected candidate effects prevent publication and require reconciliation. Remove only known owned temporary resources after their processes stop. Unknown ownership or publication state requires explicit recovery, not forced cleanup.

### File staging

`applyFile` stages or unstages one whole change entry (FR-038). It is a separate explicit action. A refused hunk request never falls back to it (FR-011). It uses the hunk profile above, so an ineligible profile gives `UNSUPPORTED_HUNK_PROFILE` for `applyFile` too. It never writes a working file.

`readComparison` returns a file-action decision for each entry: the accepted direction, or a refusal reason from data-model §5. The decision needs no text support. So a binary or oversized comparison can still carry an accepted direction.

| Direction | Accepted entry | Candidate change |
| --- | --- | --- |
| `stage` | An Unstaged entry: modified, deleted, or a mode change that status reports. Binary content, invalid UTF-8, mixed line endings, and encoding conversion are accepted. | Git sets the entry from the working file, as `git add` does. A deleted working file removes the entry. |
| `stage` | An Untracked regular file, text or binary. | Git adds the entry. |
| `unstage` | A Staged entry: modified, added, deleted, or a mode change, with any content. | Each changed path gets its HEAD mode and object ID. A path without a HEAD entry leaves the index. An unborn HEAD has no entries. |
| `unstage` | A Staged rename or copy. | A rename changes both paths. The source gets its HEAD entry, and the destination leaves the index. A copy changes only its destination. |

A refused entry gives `UNSUPPORTED_COMPARISON` with one of these reasons. Operation state keeps its own code, such as `CONFLICTED` or `OPERATION_IN_PROGRESS`.

- `type`: a type change, or a working path that is not a regular file.
- `symlink`: a symbolic link on either side. A type change with a symbolic link on either side gives `type`. `symlink` applies only without a type change.
- `submodule`: a gitlink on either side, or an untracked nested repository.
- `index-flag`: an intent-to-add, assume-unchanged, or skip-worktree entry.
- `path`: the data-model §5 path rule applies. Outside WSL, a tracked entry also gets `path` when another stage-0 index path names the same file identity. The service checks only the other paths whose components have the same count and the same lengths. NTFS `$UpCase` maps each UTF-16 unit to one unit, so every case collision meets this check. Two hard links with such paths both get `path`. So the rule fails closed for them. Hard links with other component lengths stay unchecked.
- `rename`: an Unstaged rename record. Only `stage` meets it.
- `filter` or `LFS`: a `filter` attribute on a `stage` path. `unstage` runs no filter, so it accepts such a path.
- `size`: a `stage` working file above the §5 whole-file bound.
- `blob-proof`: no proof of the staged blob holds at step 6 ("Blob proof" below). Only `stage` meets it, and never in `readComparison`.

The hunk reason `line-endings` never refuses a file action. `stage` accepts mixed line endings (table above).

**Comparison limits.** These `readComparison` results carry `support: null`, or no decision at all:

- Missing object (§7 "Missing objects"): the result is `limited` with `OBJECT_MISSING` and `support: null`. It carries the file-action decision, the file `remedy`, and `objectRemedy: { text }` with the §7 `OBJECT_MISSING` remedy text. It carries no patch and no hunks. It carries no `comparisonId`, and the service keeps no comparison. So no hunk or file action can target it (§7 "Missing objects").
- Line-ending listing: `ls-files --eol` runs without a pathspec, so it lists the whole index once per comparison. When it reaches the §5 "Status or index listing" bound, the result is `limited` with `OUTPUT_LIMIT` and `support: null`. The reason is `STATUS_LISTING_BYTES` or `STATUS_LISTING_RECORDS` (`src/contracts/schemas/read-workspace-result.schema.json`). A limited patch keeps its own reason instead. An entry that this section refuses before the diff keeps that refusal as `support`. The file-action decision and the file `remedy` stay.
- Entry without index `flags`: a cut index listing leaves a non-conflicted entry without `flags`, so no decision is exact. When the snapshot completeness is `limited`, the result is `limited` with that completeness and code. Its value holds only `completeness`. Otherwise the result is `failed` with `MALFORMED_GIT_OUTPUT`.

**Binding.** A file approval binds the comparison values at the start of §4, except the canonical diff and the hunk identity. It binds the index entry and the HEAD entry of each changed path. For `stage`, the working-file values are the existence, type, size, and raw SHA-256 of the whole working file. The service streams the file to compute the digest. A WSL repository takes the digest inside the distro with `wslFiles` mode `digest` (§6 "WSL file work"). `unstage` reads and writes no working file, so it omits the working-file values.

**Protocol.** The steps mirror research R3.

1. Enter the mutation exclusion and wait for the recovery marker ID (§6).
2. Exclusively create the canonical index lock. An existing lock gives `LOCKED`.
3. Revalidate the complete approval and the profile under the lock. For `stage`, digest the working file again.
4. Copy the index into an owned `arbareto-candidate-` file, and set its time by the "Candidate time" rule above. Create an absent candidate through `read-tree --empty`.
5. `stage` runs `update-index --add --remove -z --stdin` with `GIT_INDEX_FILE` set to the candidate. Its stdin holds the literal path bytes. Git reads the working file, applies its built-in conversions, and writes the blob. `unstage` runs `update-index -z --index-info` on the candidate. Its stdin holds the HEAD mode and object ID of each changed path. Mode 0 removes a path.
6. Verify the candidate. Only the changed paths differ, each with stage 0 and the expected existence. For `unstage`, the mode and object ID equal the HEAD entry. For `stage`, a tracked entry keeps the working mode that status reported. An untracked entry gets a regular-file mode. `cat-file --batch-check` confirms the staged object, and the "Blob proof" below proves its content. Every unrelated logical entry keeps its values and flags. The raw candidate holds no `link` extension ("Split index" above).
7. Recheck canonical index bytes, checkout, attributes, configuration, trust, and operation state. For `stage`, digest the working file again. Every detected mismatch refuses publication with the §9 checkpoint code.
8. Honor cancellation before publication begins. Publish only the verified candidate through the owned lock's same-volume replacement.
9. Reconcile (§8), and remove owned files after their processes stop.

**Blob proof.** For `stage`, Git reads the working file in step 5, and its conversion can depend on the index. So the service cannot compute the blob by itself (research R3 "Whole-file staging"). A writer can also change the file and restore identical bytes between steps 3 and 7. Step 6 therefore proves that the staged blob matches the verified bytes. The verified bytes are the bytes whose size and SHA-256 step 3 recorded. Step 6 accepts the blob when one proof holds:

- Proof A: `cat-file --filters --path=<path> <object ID>` writes the staged blob in working-tree form. Its output has the verified size and SHA-256. The service reads at most the verified size plus one byte.
- Proof B: the service streams the working file into `hash-object --stdin --path=<path>` and digests the same stream. The stream has the verified size and SHA-256, and Git prints the staged object ID. Without `-w`, `hash-object` writes no object.
- Proof A runs first. Proof B runs only after proof A fails. Each runs with `--no-lazy-fetch` and the §5 Git step deadline.
- A staged deletion has no blob. Steps 3 and 7 check the absence instead.
- A WSL repository runs proof A as `wslFiles` mode `catFile` and proof B as mode `hashObject` (§6 "WSL file work"). The proof rules stay the same. No working-file or blob byte crosses to Windows.

Each proof accepts cases that the other refuses (research R3 probe 7). Mixed line endings over an LF-only index blob and `ident` fail proof A and pass proof B. A CR in the index blob under `core.autocrlf=true` fails proof B and passes proof A. Two cases equal `git add` and still fail both proofs. They are an attribute file that only the index holds, and a CR index blob with `ident`. A simulated writer failed both proofs. A writer that changed only line endings under `core.autocrlf=true` passed both, because Git stored the same blob.

When both proofs fail, the service digests the working file again. A changed digest gives `STALE_SELECTION`. Otherwise the service cannot tell a writer from an unprovable conversion. The result is then `UNSUPPORTED_COMPARISON` with reason `blob-proof` and the `add` remedy of the entry. The result's `remedy.text` is: "Arbareto cannot prove the staged content of this file. The file can have changed during staging, or Git's conversion can depend on the index. Use the command in a terminal." No publication follows either result.

Neither proof runs a repository-controlled program in an accepted profile. `cat-file --filters` and `hash-object` load no index, so neither ran a command-valued `core.fsmonitor` canary (probe 7). Neither runs `post-index-change`, because neither writes an index. Proof A ran the smudge filter of a path with a `filter` attribute. So the `stage` refusal of such a path (reason `filter`) is what keeps proof A safe.

After publication, reconciliation digests the working file again. A difference gives `completed-with-effects`. Tests compare each result with `git add` in a disposable copy.

`core.safecrlf=true` can make Git refuse a file, as `git add` does. The step then exits nonzero before publication, and the result is `failed` with `GIT_FAILED` (§9). `unstage` writes HEAD object IDs without reading their blobs. So it needs no object that a partial clone lacks (research R3).

### Commit validation and handoff

Review the complete staged scope through read-only inspection and retain a bounded index snapshot. Do not use `write-tree` or trial commits to produce the review. The review token binds current index/checkout/policy observations, not an immutable future commit.

Enter the mutation exclusion and wait for the recovery marker ID (§6), as hunk publication does. Then obtain the canonical index lock for final preflight. Compare the reviewed index, HEAD target/OID, operation state, configuration, and trust. Refuse any detected mismatch; consume the one-use token only after validation.

Preflight reads the effective `i18n.commitEncoding`. A value that Git does not treat as UTF-8 refuses handoff with `COMMIT_ENCODING_UNSUPPORTED`. Git treats an unset value, `utf-8`, and `utf8` in any letter case as UTF-8.

Release that lock before invoking ordinary `git --no-lazy-fetch commit --quiet --file=-` on the canonical index (§7 "Missing objects"). `--quiet` removes only the summary that Git prints after the commit. Hooks and automatic maintenance still run (research R5). Handoff begins at lock release. A new mismatch detected before process start still refuses execution.

Supply only the bounded message on stdin. Do not add paths, `--all`, `--amend`, hook bypasses, signing overrides, injected hooks, or private-index commit semantics.

Git can reread its index after hooks and captures its own HEAD. Changes after handoff may affect the actual tree, parent, or destination. Postchecks report those effects; they do not prevent them retroactively.

After Git updates HEAD, `git commit` runs automatic maintenance and then the `post-commit` hook. Source reasoning says that maintenance runs in the foreground inside the commit process on Git for Windows (research R4). T100 verifies this; until then it is unverified. In that case, the 120-second commit deadline covers maintenance. A deadline interruption at that point leaves a created commit. Reconciliation classifies the outcome from observed state (§8). A lock or temporary file that the interrupted process left is foreign (§8).

If maintenance detaches, its process stays in the operation Job, because the Job forbids breakaway (§6). The same holds for a `post-commit` hook child and for a built-in fsmonitor daemon that the commit starts. These processes can keep running after the commit process exits, as with command-line Git. The commit completes when its Git process exits and reconciliation finishes. The exit is the process handle signal, never pipe EOF (§6 "Completion signal"). A lingering child can keep Git's stderr open after Git exits. Reconciliation classifies the commit from observed state while these processes can still run. It names each maintenance lock or temporary file that it observes as foreign (§8). The outcome records the `lingeringDescendants` count (§6 "Lingering Jobs"). The shell keeps it as a lingering Job until it becomes empty, trust is revoked, or the application closes (§6). An `index.lock` that such a process holds makes the next mutation give `LOCKED` (§9). Another lock that it holds, such as a ref lock or `HEAD.lock`, makes Git fail (§9 "Other locks"). The app never removes a lock.

Compare the resulting tree against the retained reviewed index using bounded read-only Git inspection. A verification copy never becomes the commit index. Check actual parent, destination, index, relevant working bytes, and operation state before classifying the result.

## 5. Finite bounds

The first reached bound wins. A bound cannot turn an incomplete result into a successful complete result.

| Resource | Limit |
| --- | ---: |
| Incoming public request | 1 MiB encoded envelope. The shell checks the raw body bytes before any parse (§1 "Renderer request body"). The shell writes the frame body as `{"kind":"public","request":`, the envelope, and `}`. So a `public` frame body above 1 MiB plus 28 bytes gives `FRAME_LIMIT`. |
| Private/reply frame | 16 MiB encoded. It bounds the length header of every pipe frame (§1). |
| JSON nesting | 16 levels |
| Identifier | 64 ASCII bytes |
| WebView2 version text | 64 ASCII bytes in the startup handshake (§6 "Startup handshake") |
| Commit message | 64 KiB UTF-8; no NUL; nonblank |
| Compared raw version | 1,048,576 bytes per side |
| Compared normalized version | 1,048,576 bytes per side |
| Whole-file stage input | 536,870,912 bytes (512 MiB) per working file (§4 "File staging"). Research R3 states the reason. |
| Canonical diff | 20,000 lines and 4 MiB raw patch bytes |
| Status or index listing | 32 MiB and 100,000 records. When the status parser reaches the byte bound, the service stops the `git status` process. The read ends `limited` with `OUTPUT_LIMIT` and the reason `STATUS_LISTING_BYTES` (§9). Above 100,000 records, the reason is `STATUS_LISTING_RECORDS`. `src/contracts/limits.ts` defines both bounds: `STATUS_LISTING_BYTES` = 32 MiB and `STATUS_LISTING_RECORDS` = 100,000. |
| Status page | 8 MiB encoded result for each `readWorkspace` first page and each `readEntries` page. This stays below the 16 MiB private/reply frame. T284 implements this bound. |
| Raw index eligible for mutation | 64 MiB, including validated dependencies |
| Commit attribution evidence | 4 MiB and 10,000 reference/reflog records, aggregated across all streams and references per reconciliation attempt |
| History traversal stream | 100 commit rows and 128 KiB |
| History parent references | 64 per commit and 1,024 per page |
| Shallow-boundary metadata | 4 MiB |
| History commit object | 256 KiB per object |
| History page | 8 MiB encoded result for each `readHistory` response. This stays below the 16 MiB private/reply frame. The page keeps the rows before the first row that passes the bound. The service always cuts the rows to this bound. This bound sets the completeness only when it is still `complete`, so an earlier bound keeps its reason. |
| Frontend graph layout | 24 simultaneous lanes and 4,096 SVG path segments; explicit row-only fallback |
| Effective configuration/trust input | 4 MiB; overflow blocks execution approval |
| Trust program file digests | 64 files, 1 MiB per file, and 8 MiB total (§7 "Program file digests"). At most 8 link hops for each program or hook path. Overflow permits only a session approval without a stored record |
| File facts | 64 entries per request, 255 UTF-16 units per name component, 1 MiB per file, and 8 MiB per request (§6 "File facts"). The shell applies the byte bounds in request order. |
| Git executable digest input | 256 MiB per file, read as a stream. The read stops above the bound. A larger file gives `GIT_UNSUPPORTED`, and no Git process starts (§3 "Git proposal"). |
| Diagnostic bytes retained | 64 KiB per stream, never persisted as raw logs. The service retains them, and the shell forwards every byte before the completion signal (§6 "Channel frames"). |
| Total unexpected diagnostic output | 4 MiB per operation before cancellation. Each `updateSubmodules` process counts its own 4 MiB, because its stderr carries progress (§12 "Deadlines and Cancel"). The service counts the forwarded bytes and sends `cancel` at the bound. |
| Native stdout/stderr chunk | 64 KiB of decoded bytes in one `output` or `input` frame (§6 "Channel frames") |
| Queued pipe data | 8 chunks per stream in the shell. A full queue stops the reads of that child pipe. A chunk leaves the queue when its frame write to the service returns. Streamed input allows 8 unacknowledged chunks per process (§6 "Channel frames"). |
| Inline process input | 64 KiB of decoded bytes in the `input` field of a `run` request. Larger input uses a stream (§6 "Channel frames"). |
| Streamed process input | 536,870,912 bytes (512 MiB) per process, the whole-file stage input bound |
| Recorded request IDs | 65,536 per service session. A new `requestId` above 65,536 drops the oldest one, so that `requestId` is usable again (§2). |
| Session log entries | 1,000 per service session. A new entry above 1,000 drops the oldest one (§7). |
| Finished operation records | 256 terminal records of reads and rejected requests per service session. A new terminal record above 256 removes the oldest one. A mutation record that consumed an approval stays for the service session (§2). `getOperation` or `cancel` with a removed `operationId` gives `UNKNOWN_TARGET`. |
| Registered workspaces | 8 at one time per service session. Reuse and release follow §6 "Registration reuse and release". |
| Trust approval records | 4 KiB per record and 256 records. A new record above 256 replaces the oldest record. |
| Retained comparison data | 4 comparisons and 128 MiB total |
| Approval lifetime | 60 seconds; relevant changes invalidate it sooner |
| Concurrent reads | 2 per workspace, 4 globally. `readEntries` takes no read slot, because it starts no Git process. |
| Pending reads | 8 globally, in arrival order. When 8 reads wait, a new read gets `rejected` with `BUSY` before admission, and it gets no `operationId`. A canceled read that still waits for a slot leaves the queue at once. It ends `canceled` with no re-read. A new `readComparison` cancels each unfinished `readComparison` of its workspace as superseded. `readEntries` never waits in this queue. |
| Mutations | 1 per common repository; reject overlap without queueing old approvals |
| Ordinary read deadline | 30 seconds. It starts when the read takes its slot, not while it waits. `reviewSubmodules`, the `updateSubmodules` preflight, and its level reads have no total read deadline. Each of their Git commands has the 30-second deadline below, and the submodule review bound limits the command count. |
| Commit process deadline | 120 seconds, followed by interruption and reconciliation |
| Other Git process deadline | 30 seconds for each bootstrap probe, and for each `applyHunk` or `applyFile` Git step. The same deadline applies to each commit preflight read, `reviewSubmodules` read, and mutation reconciliation read. It also applies to each `updateSubmodules` preflight read, level read, and check read (§12). "Deadline outcomes" below states the result. |
| WSL file work | Each `wslFiles` request names one §5 bound in `bound` (§6 "WSL file work"). Mode `digest` takes 1 to 64 entries with `COMPARED_RAW_VERSION_BYTES`, or exactly 1 entry with `WHOLE_FILE_STAGE_INPUT_BYTES`. Modes `hashObject` and `catFile` take 1 entry with `WHOLE_FILE_STAGE_INPUT_BYTES`. Modes `indexDigest`, `lock`, `candidate`, and `publish` take `MUTATION_RAW_INDEX_BYTES`. A link target holds at most 4,095 bytes (Linux `PATH_MAX` 4,096 with its NUL). |
| Walk deadline | 30 seconds for each walk (§6 "Walks"): each `identity`, `fileFacts`, `wslFiles`, `lingeringCount`, `register`, `started`, `revoke`, and `resolveGit` request, and the start of each `run`. It starts when the shell reads the request frame. A `run` `limits` deadline starts when its process starts. It equals the other Git process deadline, because each request is one step of a read, a registration, or a mutation check. |
| Submodule update process | Inactivity deadline: each update process ends after 300 seconds without output or an I/O sum change. Each has a ceiling of 4 hours (§12 "Deadlines and Cancel"). |
| Stall notice | 15 seconds without an output byte and without a change of the I/O sum. It applies to the commit process and to each submodule update process. It shows a notice and ends nothing (§6 "Activity and stall notice"). |
| Submodule review | 256 submodules at all depths, 8 nesting levels below the superproject, and 1 MiB for each `.gitmodules` source. Each folder of the §12 kept-directory walk counts as one submodule. A larger set gives `UNSUPPORTED_SUBMODULE` with reason `limit` (§12). `src/contracts/limits.ts` names the `.gitmodules` bound `SUBMODULE_GITMODULES_BYTES`. In the `readWorkspace` notice, its overflow only skips the name filter. |
| Submodule progress events | 4 per second for each operation (§12 "Progress"). |
| WSL distro start | 60 seconds for the Git probe of a distro that the running list does not name (§11 "Distro start"). A deadline gives `DEADLINE`. |
| WSL poll gap | 1 second after the previous poll of that workspace ends, only while the main window has focus (§11 "Change polling"). |
| WSL anchor count | One line with the count and the I/O sum for each stdin line. After stdin closes, one line each second (§11 "Process ownership"). While a commit or submodule update process runs, the shell writes one stdin line each second (§6). |
| Commit failure output tail | Last 16 KiB and at most 100 lines of commit stderr (§9 "Commit failure output") |
| Cancellation/reconciliation target | 5 seconds; report unknown if state cannot be confirmed. The re-read after a read cancel, failure, or deadline has the same target ("Deadline outcomes"). |
| Recovery markers | 4 KiB per marker and 64 markers per handshake. Above 64, the shell loads the 64 oldest markers. `getEnvironment` reports the limit and the count of files that the shell did not load. Every mutation stays blocked with `STATE_UNKNOWN`. Dismissal (§6) stays available. The block ends at the next handshake that finds at most 64 marker files. Damaged marker files do not count toward this limit (§6 "Damaged markers"). |
| Damaged recovery markers | 64 per handshake, in file-name order. A further damaged file stays unlisted until dismissals free a place. It blocks no mutation. |
| Confirmed-close cleanup target | 5 seconds |

**Deadline outcomes.** Every Git process has a deadline. A deadline closes the Job of that process at once, with every descendant.

- A bootstrap probe deadline destroys the context. The registration or dismissal gives `DEADLINE`.
- A walk deadline (§6 "Walks") has the outcome of a Git process deadline in the same step. A registration or dismissal gives `DEADLINE`. Each read follows its own bullet here. In an ordinary read, the read deadline starts first, so it expires first.
- A `started` deadline ends the mutation `failed` with `DEADLINE` and reason `deadline`, because no Git process ran and no marker exists. A `revoke` deadline ends `revokeTrust` `failed` with `DEADLINE`, and the service revocation stays. A `lingeringCount` deadline adds no lingering sentence (§9 "Lingering count"). A `resolveGit` deadline gives `DEADLINE`.
- An ordinary read deadline closes the operation Job. The service then re-reads the repository state. A canceled or failed read that held a slot gets the same re-read. The re-read is discovery call 1 (§6 "Registration bootstrap"), and it has the 5-second reconciliation target. When the re-read refuses, its refusal replaces the read result. Otherwise the read ends `failed` with `DEADLINE`, `canceled`, or its failure code.
- A deadline of an `applyHunk` or `applyFile` Git step moves the mutation to `reconciling` (data-model §7). So does a commit preflight read deadline. Neither publication nor Git execution has started. Without observed effects, the result is `failed` with `DEADLINE` and reason `deadline` (§9). The service releases its owned lock only after the Job closes.
- A mutation reconciliation read deadline fails reconciliation. The outcome is `unknown`, and the recovery marker stays (§8). After an update or mutation deadline, that `unknown` keeps the recorded deadline reason. A `canceled` outcome after such a deadline also keeps it. An attribution reason (§9) replaces it.
- The commit process deadline follows §4.
- A `reviewSubmodules` read deadline ends the read `failed` with `DEADLINE`. An `updateSubmodules` preflight read deadline moves the mutation to `reconciling`, and no update process has started. A level read or check read deadline also moves it to `reconciling`, and no later process starts.
- An `updateSubmodules` process deadline moves the mutation to `reconciling` with `DEADLINE` and reason `inactivity` or `ceiling` (§12). No later update process starts.

Count canonical patch lines once, including file and hunk headers. Ignore only the empty segment after a final newline. Split view and virtualized rows do not change this count.

Transmit the canonical patch as bounded base64 UTF-8 bytes. This prevents JSON escaping from invalidating raw-byte accounting. Validate decoding before strict patch parsing.

Render limited status/history with a visible explanation. Block mutations that depend on an incomplete status, index, trust, or comparison snapshot.

Use streaming decoders and counters. Do not collect unbounded `text()` or `arrayBuffer()` results. Cache eviction invalidates associated approvals.

Retain an accepted operation's reviewed index snapshot until required reconciliation succeeds, including while unknown state blocks recovery. An accepted `applyHunk` or `applyFile` retains the raw digests of its verified candidate and of the canonical index before publication. An accepted `updateSubmodules` retains its reviewed plan and the rows that its run adds (§12). Approval expiry must not delete required verification data. Use bounded owned files when retaining index bytes would exceed memory budgets.

## 6. Private native process requests

Only the compiled service can use this private channel. No public Tauri command exposes it.

### Startup handshake

The shell sends one `handshake` frame as the first frame of each service session. Its body is `{"kind":"handshake","handshake":{…}}`. Every field below is required, except `savedGit`.

| Field | Value |
| --- | --- |
| `version` | Integer `1`. |
| `restarted` | Boolean. It is `true` only after Restart service (§8 "Service restart"). |
| `platformScope` | `qualification-target` or `other` (§3 `getEnvironment`). |
| `osBuild` | Nonnegative safe integer: the OS build number from `RtlGetVersion`. |
| `webView2Version` | The detected WebView2 runtime version text, at most 64 ASCII bytes. |
| `buildIdentity` | Object with `version`, `commit`, and `signing`. `commit` is the full commit ID, with the suffix `-dirty` when it applies. `signing` is `unsigned` in this slice. |
| `markers` | Array of at most 64 recovery markers (§5). Each holds `markerId`, `kind`, `startedAt`, `worktreeRoot`, `commonDirectory`, and `commonIdentity` ("Recovery markers"). Zero markers give an empty array. |
| `unloadedMarkers` | Nonnegative safe integer: the count of marker files above the 64-marker limit that the shell did not load (§5). Damaged markers do not count. |
| `damagedMarkers` | Array of at most 64 damaged markers (§5, "Damaged markers"). Each holds exactly `markerId` and `fileName`. `fileName` is the file name in the `recovery` folder. It has 1 to 255 UTF-16 units and no path separator. It holds no file content. Zero damaged markers give an empty array. |
| `trustRecords` | Array of at most 256 trust records (§5). Each holds `commonDirectory`, `commonIdentity`, `worktreeRoot`, `gitDirectory`, `worktreeIdentity`, `configurationFingerprint`, `approvedAt`, and `gitSelectedPath` (§7 "Trust approval store"). Zero records give an empty array. |
| `savedGit` | Object with exactly `selectedPath`, `executablePath`, `version`, `digest`, and an optional `bootstrapId` (data-model §1). `bootstrapId` is the startup `gitProbe` context of `selectedPath` ("Startup contexts"). It is absent when the shell cannot read the selected file. `selectedPath` is the saved selected path. `executablePath` is the saved resolved path. `version` is the stored parsed version text. `digest` is the stored SHA-256 of the file at `executablePath`. The object is present only when the settings hold a Git. |

`startedAt` and `approvedAt` are UTC times in RFC 3339 form. `commonIdentity` and each `worktreeIdentity` entry use the Windows or the WSL identity form ("Process fields"). One record or marker holds one form. A WSL record holds one `distroGuid`. `worktreeIdentity` holds the identity replies of `worktreeRoot` and `gitDirectory`, in that order. `configurationFingerprint` and `digest` are 64 lowercase hex digits. `executablePath` and `gitSelectedPath` follow the path rule of "Channel frames".

The service validates the frame with the strict decoder and the zod handshake schema (§1 "Schemas"). It replies `{"kind":"handshake","handshake":{"sessionId":"<ID>"}}`. `getEnvironment` takes its facts and markers only from this frame.

- A missing field, an unknown field, or a wrong type fails the handshake. So do more than 64 markers, more than 64 damaged markers, or more than 256 records.
- A failed handshake gets `{"kind":"handshake","handshake":{"code":"<code>"}}`. The code is `PROTOCOL_VERSION` for another `version`, otherwise `INVALID_REQUEST`. The service then exits, and the shell treats this as a failed handshake (§2).
- A second handshake in a session gets that failure reply with `INVALID_REQUEST`. The session continues unchanged.
- A `public` frame before the handshake gets `rejected` with `SERVICE_UNAVAILABLE`.

### Registration bootstrap

The native shell creates temporary contexts for `chooseGit`, `chooseRepository`, `restoreWorkspace`, and `dismissRecoveryMarker`. It also creates one for the saved selected Git path at each startup handshake ("Startup contexts" below). A context binds the selected path, physical identity, session, permitted probe, and expiry.

Every physical identity is native: the 64-bit volume serial number and the 128-bit file ID from `GetFileInformationByHandleEx` with `FileIdInfo`. On ReFS, the 64-bit file ID is all ones when it cannot be unique (MS-FSCC 2.1.9). It is not stable on FAT or exFAT (research R2). The service never takes a physical identity through Bun `fs.stat`. A Bun `fs.stat` dev and ino compare only checks that two reads name one file: §4 "Windows lock ownership", the swapped-path check of a bounded file read, the on-disk name match of a comparison, the same-file check of two index paths, and the watcher folder check. A 0 or all-ones 64-bit file ID on either side proves no identity. No site treats it as a proven match or a proven difference. The bounded file read (`openRegular`) gives `no-identity` and does not retry. A working-file read with such an ID gives `UNSUPPORTED_HUNK_PROFILE` reason `file-id` in `applyHunk` and `applyFile`, with the §9 working-file text. `readWorkspace` keeps no working version for that file, so every token that binds it becomes invalid. In `readComparison`, a working-file read with such an ID gives `failed` with `UNSUPPORTED_HUNK_PROFILE` and no reason. A `failed` result carries no value (§3). In `readComparison`, that code has only this cause, so the code alone names it. The on-disk name match and the same-file check of two index paths give `unreadable`. The watcher loses the watch, so every poll runs in full. Such a read does not retry, and only a swapped path retries. It sends an identity request (below) for each Git-resolved path. The service never stats, opens, or reads a repository-controlled program or hook path. It sends a file-fact request ("File facts" below). An all-zero or all-ones file ID, or a failed call, refuses registration with `UNSUPPORTED_REPOSITORY`. The remedy is: open the repository from an NTFS or ReFS volume.

The renderer cannot supply or replace those paths. Restoration uses only the application-owned last-selection setting and requires fresh validation.

**Startup contexts.** Two saved selections need contexts without a dialog:

- Saved Git: the shell creates one `gitProbe` context for the saved selected path at each startup handshake. This includes the handshake after Restart service. The handshake carries its `bootstrapId` in `savedGit`, with both saved paths, the version text, and the digest. A settings file without a selected path uses the resolved path as the selected path. When the shell cannot read the selected file, `savedGit` has no `bootstrapId`. The service then gives `GIT_UNAVAILABLE` with reason `selected-missing` and the selected path. The service revalidates the Git before it answers its first public request. The probe runs `--exec-path` with the selected path in the startup context (§3 "Git proposal"). It resolves `git.exe` in the printed folder again, so the stored resolved path and digest do not decide. A Git upgrade can move that file, for example from `mingw64` to `ucrt64`. The installation root is the folder two levels above the selected file. Case rule on Windows: the installation-root check and the §7 `gitSelectedPath` comparison fold only the ASCII letters `A` to `Z` to lowercase. No other character folds, so U+212A KELVIN SIGN stays unequal to `k`. On other platforms, both compare the exact path. For `C:\Git\cmd\git.exe`, the root is `C:\Git`. For `C:\Git\mingw64\bin\git.exe`, it is `C:\Git\mingw64`. The service admits a resolved file inside that root without the confirmation. A different version or digest gives no `GIT_CHANGED`. Output without one folder line gives `GIT_UNAVAILABLE` with reason `resolution-failed`. A missing or non-regular resolved file gives `GIT_UNAVAILABLE` with reason `resolved-missing` and its path. A resolved file outside the root gives `GIT_UNAVAILABLE` with reason `outside-installation`. For a resolved file other than the selected path, the service sends `resolveGit`. The new context stays a startup context. The version probe and the registration then run in that context without the confirmation. The admission rule of `chooseGit` applies, so an old version or another architecture gives `GIT_UNSUPPORTED`. The `register` request carries the version and the digest. After an approved startup `register`, the shell saves the new resolved path, version, and digest. It keeps the selected path. When the admitted version differs from the saved version, `getEnvironment` reports the saved one as `previousVersion`. The boot view then shows the non-blocking line `Git updated: <previousVersion> → <version>`. The next start finds the new version saved, so that line does not show again. The shell refuses a `register` without the confirmation outside a startup context with `INVALID_REQUEST`. Without a saved Git, the handshake carries no `savedGit`, and Git stays unselected.
- Last repository: the shell creates no context at startup. Each `restoreWorkspace` request creates one `repositoryDiscovery` context for the stored last-selection path.

| Context | Permitted execution | Completion |
| --- | --- | --- |
| `gitProbe` | Selected executable with the fixed arguments `--exec-path` or `version --build-options`. No `--no-lazy-fetch` (§7 "Missing objects"). The shell admits the two exact arrays `--no-lazy-fetch var GIT_CONFIG_SYSTEM` and `--no-lazy-fetch var GIT_CONFIG_GLOBAL` in any live `gitProbe` context. The shell holds no admission state. The service calls them only after its admission checks pass (§7 "Configuration file paths"). It runs from the application-owned launch directory. | Validate executable identity, version, architecture, and admission policy before issuing `gitInstallationId`. |
| `repositoryDiscovery` | Admitted Git in the selected directory. Only fixed discovery profiles using `rev-parse`, `symbolic-ref`, and `show-ref`. A `repositoryDiscovery` context permits `symbolic-ref` only with the options `-q`, `--quiet`, and `--short` and exactly one ref name, `HEAD`. The shell refuses every other `symbolic-ref` form, such as `-d`, `--delete`, `-m`, a second name, or no name. It permits `show-ref` as `show-ref --head --verify HEAD`, and also as `show-ref --exists` with exactly one ref name. That name starts with `refs/`, and it is the output of `symbolic-ref -q HEAD` without `--short`. The name must pass the git-check-ref-format(1) rules without options. The shell enforces these rules in `is_ref_name`. The shell refuses every other `show-ref` form. | Resolve and validate repository paths, formats, HEAD state, and physical identities before issuing `repositoryId`. Exit statuses decide the HEAD state (git-symbolic-ref(1), git-show-ref(1)). `symbolic-ref -q HEAD` exit 0 gives the branch ref name. Exit 1 with zero bytes of stderr means a detached HEAD. Any other non-zero result gives `REPOSITORY_UNAVAILABLE`. For a branch ref name, `show-ref --exists <ref>` tells an unborn branch from a failed lookup. Exit 0 means the ref exists. Exit 2 means the ref is missing, so the branch is unborn. Any other exit gives `REPOSITORY_UNAVAILABLE`. For an existing branch or a detached HEAD, `show-ref --head --verify HEAD` gives the object ID. A failure of that read gives `REPOSITORY_UNAVAILABLE`. The service reads no stderr text for these decisions. Refuse registration when `--is-bare-repository` or `--is-inside-git-dir` reports true, with `UNSUPPORTED_REPOSITORY`. For a bare repository, the remedy is: open a worktree of it, or clone it. For a Git administration folder, the remedy is: open the working folder that contains it. The first discovery call is `rev-parse --is-bare-repository --is-inside-git-dir` (research R2 "T283 record"). Every nonzero exit of that call gives `REPOSITORY_UNAVAILABLE` (spec Clarifications, 2026-10-05). The refusal names the selected folder as `path`. Its remedy text is "Run `git status` in this folder", and it offers no command. Its `outputTail` holds Git's stderr by the §9 "Commit failure output" rules. Git exits with 128 for every setup failure, such as a folder outside every repository or dubious ownership. It prints no machine-readable reason, so the service reads no stderr text for this decision. Git's suggested command shows only as plain text in the output tail, never with Copy command, because Git quotes it for a POSIX shell (research R5). A probe past its §5 deadline gives `DEADLINE`. Other Git exit results of a discovery call use `REPOSITORY_UNAVAILABLE`. A runner refusal from the process layer passes through discovery and registration unchanged: `GIT_CHANGED`, `UNKNOWN_TARGET`, `INVALID_REQUEST`, or `PROCESS_OWNERSHIP_FAILED` ("Channel frames"). Only a Git exit result maps to `REPOSITORY_UNAVAILABLE`. |
| `registeredOperation` | Service-constructed Git operation against registered Git and repository IDs. | Normal operation and reconciliation rules apply. |

Discovery profiles use only the documented identity queries in `research.md`. They accept no renderer-provided arguments, refs, paths, or environment overrides.

Discovery probes run under a fixed C locale, so Git messages stay unlocalized. Discovery refusals come before the configuration listing in §7.

A WSL path gets its route, identity, Git, and process rules from §11. A `repositoryDiscovery` context of a WSL path starts no process at creation and reads no identity. `wslProbe` binds its identity once (§11 "Git per distro"). Before `register`, the shell reads that identity again with the §11 identity probe. A changed identity or a failed read destroys the context, and the shell refuses with `UNKNOWN_TARGET`. Discovery `run` requests of a WSL context get no identity read, because each read starts `wsl.exe` (research R13). Limit: no identity protects the selection between the folder dialog and `wslProbe`.

On a Windows service, `chooseRepository` and `restoreWorkspace` are accepted without a selected Windows Git. The service sends `wslDistros` first, because only its reply shows whether the path is a WSL path. A Windows path without a selected Windows Git then ends `failed` with `GIT_UNAVAILABLE`. A WSL path continues with the §11 route. A non-Windows service keeps the `rejected` `GIT_UNAVAILABLE` refusal at acceptance.

No discovery profile loads the index, because an index load can run a command-valued `core.fsmonitor` before trust approval. So discovery never runs `rev-parse --shared-index-path` (research R2). Split-index state comes from the raw index bytes (§4). A research R2 probe ran every discovery and trust-listing query with repository canaries, and none ran.

The service constructs the fixed probe arrays and parses their results. Native code validates the context and selected target, not Git semantics.

A bootstrap context lasts at most 60 seconds and belongs to one registration or marker dismissal. It can perform that operation's required discovery probes. Cancellation, failure, completion, or service restart destroys it.

Revalidate the selected file/directory identity before execution and registration. A changed target requires a new selection. No bootstrap context permits mutation or general repository reads.

Permanent IDs become valid only after successful registration. Bootstrap probes use the same Job ownership, output bounds, environment controls, and failure cleanup. Each probe process also has the §5 30-second deadline. Each discovery probe passes `--no-lazy-fetch`, and the `gitProbe` exec-path and version probes run without it (§7 "Missing objects").

### Registration reuse and release

The scope is one main workspace. A registration matches a registered workspace only when both its worktree identity and its `gitInstallationId` are equal. A match returns that `repositoryId` and registers nothing new. A `chooseGit` that issues a new `gitInstallationId` releases every workspace bound to the previous installation, with every release effect below. It sends one `release` frame for each released workspace and one for the previous installation. While such a workspace has an unfinished mutation, `chooseGit` gives `BUSY`. Like every failed or canceled `chooseGit` (§3 `chooseGit`), it sends one `release` for the new `gitInstallationId` that the shell bound, and nothing else changes. The client then registers again, and that registration creates a new workspace that the new installation binds. A registration of another common-directory identity releases every registered workspace of the previous one. Linked worktrees of one common directory stay registered together.

A release invalidates the released `repositoryId` and its snapshots, comparisons, approvals, and trust ID. It clears the session trust approvals of its worktree (§7 "Trust approval store") and the trust ID that the service issued for that `repositoryId`. It cancels every unfinished read of that workspace, and each one ends `canceled` with no re-read. It does not cancel an unfinished `revokeTrust`, which always completes. An `approveTrust` that completes after the release sets nothing and returns `UNKNOWN_TARGET` (§7 "Trust approval store"). It stops the watcher of that workspace. A registration that would release a workspace with an unfinished mutation gives `BUSY`, and nothing changes. An unfinished mutation is `running`, `cancel-requested`, or `reconciling`. Operation records, retained verification data (§5), and recovery markers survive a release. A later registration that matches an unresolved marker starts in `unknown` (§8).

### Process fields

Every private process frame carries `kind` `process` (§1). "Channel frames" below defines each request and reply body.

| Field | Native validation |
| --- | --- |
| `operationId` | Active service operation with owned lifecycle state. |
| `contextKind` | `gitProbe`, `repositoryDiscovery`, or `registeredOperation`. |
| `bootstrapId` | Native-issued temporary context; required only for probe/discovery. |
| `gitInstallationId` | Required after Git registration. A probe instead uses its native-selected executable context. |
| `repositoryId` | Required for registered operations. Discovery instead uses its native-selected directory context. |
| `arguments` | Structured string array. Constructed by the service. No string holds NUL or a lone surrogate. The quoted command line, with the terminating null, has at most 32,767 UTF-16 units (Microsoft Learn `CreateProcessW`). |
| `input` | At most 64 KiB inline, or a stream of at most 512 MiB (§5, "Channel frames"). |
| `environmentPolicy` | Internal fixed policy identifier, not caller-defined key/value pairs. |
| `transactionId` | Service-owned candidate-index context where an approved design requires it. |
| `limits` | Cannot exceed contract caps. A `network` request carries the §12 inactivity limit and ceiling, and the shell enforces both. A commit request and each `network` request carry the 15-second stall threshold ("Activity and stall notice"). `deadlineMs` is at most 30 seconds for a bootstrap context, 60 seconds for a WSL distro start, else 120 seconds. Only the `network` policy carries the inactivity limit and the ceiling. |

An identity request is a `process` frame with `operationId`, `contextKind`, and the bootstrap or repository ID. It carries at most 8 absolute paths. Each path has at most 32,767 UTF-16 units and no NUL. The shell opens each path with `FILE_READ_ATTRIBUTES`, full sharing, and `FILE_FLAG_BACKUP_SEMANTICS`. It follows junctions and reads no file data. It returns only each identity or the refusal `{"code":"UNSUPPORTED_REPOSITORY"}`. A refusal also carries `"reason":"absent"` only when the open fails with Win32 `ERROR_FILE_NOT_FOUND` (2) or `ERROR_PATH_NOT_FOUND` (3). The Linux double gives it for `ENOENT`. The zod form is `IdentityRefused` in `src/contracts/channel.ts`. Only `reason` `absent` means that a path is missing. Any other refusal refuses the read or registration with its existing refusal form. A Windows identity reply is `{"volumeSerial":"<16 lowercase hex digits>","fileId":"<32 lowercase hex digits>"}` from `FILE_ID_INFO`. `volumeSerial` is the 64-bit `VolumeSerialNumber`, and `fileId` is the 128-bit `FILE_ID_128` `Identifier` bytes in array order. A WSL identity reply is `{"distroGuid":"<GUID>","fileSystemId":"<hex>","inode":"<decimal>"}` (§11). `distroGuid` is the `Lxss` subkey name with `A` to `F` folded to lowercase: `{`, 8-4-4-4-12 hex digits, `}`. Registry key names ignore letter case. `fileSystemId` is the GNU `stat --file-system` `%i` text: 1 to 16 lowercase hex digits without a leading zero. `inode` is the `stat` `%i` text: 1 to 20 decimal digits without a leading zero, at most 2^64−1. Other text is a failed probe. A WSL refusal can carry the `reason` `absent`, `no-fs-uuid`, or `mixed-location`. The identity text of a Windows identity is `volumeSerial` then `fileId`. The identity text of a WSL identity is `distroGuid`, `:`, `fileSystemId`, `:`, `inode`. The mutex name, the trust record file name, and the lingering Job tag use the SHA-256 of the identity text. A path can lie outside the selected directory, because a linked worktree's common directory can live elsewhere. The request is a walk ("Channel frames", "Walks").

Supply the executable through `CreateProcessW.lpApplicationName`. Preserve structured arguments until the tested Windows quoting boundary. Never insert an intermediate command shell.

**Console and input.** One rule covers every process that the shell starts:

- No console. The shell starts the compiled service and every Git for Windows process with `DETACHED_PROCESS`. It never passes `CREATE_NO_WINDOW` or `CREATE_NEW_CONSOLE` to them. A Git process without a console starts each child with `DETACHED_PROCESS`, hooks and `ssh` included (compat/mingw.c:2247-2263). So Git and each program that Git starts directly cannot read a hidden console. A direct native `ssh-keygen -y` with a passphrase key failed at once (research R14 S17). With `CREATE_NO_WINDOW`, Git would own a hidden console, and its children would inherit it. The same `ssh-keygen` call then waited.
- Git for Windows wrapper. Without a console, the wrapper `cmd\git.exe` starts Git with `CREATE_NO_WINDOW` (git-for-windows `mingw-w64-git/git-wrapper.c`). Git, its hooks, and `ssh` then share a hidden console. So the shell runs the wrapper only for the `--exec-path` probe, and every other process runs `<exec-path>\git.exe` (§3 "Git proposal"). Started with `DETACHED_PROCESS`, that file had no console (research R7 "Batch 1 observations"). The `--exec-path` probe through the wrapper still starts one Git with a hidden console. That Git prints one line, reads no input, and starts no child.
- Limit: a hook, and a `core.sshCommand` with arguments, run under the MSYS2 `sh.exe` of Git for Windows. Without a console, that runtime gave each native console program an invisible console (research R14 S17). A program that reads the console directly then waits. `Read-Host -AsSecureString` and a Windows OpenSSH passphrase prompt waited until the probe killed them. A NUL stdin did not end the wait. Plain `Read-Host`, `pause`, and a `/dev/tty` read ended at once.
- So the real bound for such a read is the deadline of the operation. It is 120 seconds for a commit and 300 seconds of inactivity for a submodule update. A read that runs an approved filter has the 30-second read deadline. The deadline closes the Job with every descendant. A native child that a hook starts can keep waiting after the hook exits. If Git then completes, that child lingers until Revoke trust or application close ("Lingering Jobs").
- Before that deadline, the commit and each submodule update process show the stall notice after 15 seconds without activity. "Activity and stall notice" states the rule. The user decided this on 2026-10-01 (spec FR-051).
- One exception: `wsl.exe` gets `CREATE_NO_WINDOW`, because a detached `wsl.exe` relayed no output (§11 "Process launch", research R14 probe S10). The §11 wrapper then runs each program that it wraps through `setsid --wait`. So no Git process or hook gets the hidden console as its terminal. The §11 bootstrap probe and the anchor run without the wrapper and without `setsid`. Neither opens a repository or runs a repository program.
- No terminal prompt. Every §7 environment policy sets `GIT_TERMINAL_PROMPT=0`, and the §11 wrapper sets it in every mode. Git then fails instead of asking for a user name or password on a terminal (Git `Documentation/git.adoc`).
- Stdin. Every child gets a stdin pipe. The shell writes the bounded `input`, then closes its end of the pipe. Without `input`, it closes that end at once. So a child that reads stdin gets end-of-file, never a wait.
- Exception: the §11 anchor of a WSL mutation. Its stdin stays open from its start until `ended`. The shell writes one line after each execution process exits. It also writes one line each second while a tracked process runs ("Activity and stall notice"). It closes the pipe at `ended`. A closed pipe would end the anchor at count 0 before Git starts. Then no process of the mutation would stay in the Job. Close and Revoke trust could then not end lingering scopes (§11 "Process ownership"). The anchor runs no repository program.
- The rule changes no user configuration. The app never sets `core.sshCommand`, `GIT_SSH_COMMAND`, `core.askPass`, `credential.*`, or a `GCM_*` variable. A credential helper can still show its own window (§12 "Environment and console").
- Evidence: T027 runs a real `pre-commit` hook that waits for terminal input, and T162 repeats it in the installed build. Both also run the research R14 S17 console variants, which must end at the deadline. T225 checks their stall events, and T162 checks the stall notice. Until they pass, the hook behavior without a console stays unverified.

Enforce Windows' command-line length limit before starting a child. Prefer Git's NUL-delimited stdin facilities for literal path collections.

Use only intended inherited pipe handles. Create the child suspended and already in its Job. The attribute `PROC_THREAD_ATTRIBUTE_JOB_LIST` names the Job (Microsoft Learn `UpdateProcThreadAttribute`, Windows 10 and later). A shell exit between the creation and the resume then leaves no child outside the Job. A failed creation in the Job starts no process. A failed resume terminates the child. Execution must not continue unmanaged.

Each operation has its own Job. The service has a separate Job. Each operation Job and the service Job use kill-on-close and no breakaway. Their handles stay non-inheritable. A shell crash closes these handles and ends every owned descendant. Canceling one operation must not stop unrelated reads.

Drain stdout and stderr independently. Enforce the chunk size and queue caps before forwarding chunks to Bun. The service enforces the byte caps of §5. After service failure, close every operation Job outside the lingering set. Lingering Jobs stay (below).

**Completion signal.** A process ends when its process handle signals, never at pipe EOF. A descendant can inherit a pipe and keep it open after the process exits. A research R5 probe saw Git exit after 0.25 seconds while a `post-commit` child held stderr for 8.3 seconds. At the signal, the shell forwards the bytes that each pipe already holds, within the chunk size and queue caps. Then it keeps draining each pipe into a discard sink until EOF or Job close. So a writing descendant never blocks or fails on the pipe, and memory does not grow. Discarded bytes count toward no cap. The app never forwards, shows, retains, or logs them. The exit reply follows the forwarded bytes.

**Activity and stall notice.** The shell tracks the activity of two process kinds: the `commit --quiet --file=-` process and each §12 update process.

- Activity is a forwarded output byte or a changed I/O sum. A Windows Job uses its `IO_COUNTERS` sum. A WSL Job uses only the anchor I/O sum.
- Windows I/O sum: the shell calls `QueryInformationJobObject` with `JobObjectBasicAndIoAccountingInformation` (class 8) once per second. The port reader thread ("Lingering Jobs") makes the call. The sum adds the six `IO_COUNTERS` fields. They cover every process that was ever in the Job (Microsoft Learn `IO_COUNTERS`). In probe S16, socket bytes counted in `OtherTransferCount`, and an idle process changed no field.
- WSL I/O sum: the Job holds `wsl.exe`, the anchor, and their console hosts, but no Linux process (§11 "Process ownership"). Windows puts a `conhost.exe` in the Job of each `CREATE_NO_WINDOW` child (T211, 2026-10-04). While a tracked process runs, the shell writes one stdin line to the anchor each second. The anchor answers with its count and the I/O sum of the operation scopes. The sum can drop when a child exits before its parent reaps it. So any change counts as activity.
  - The shell never reads the `IO_COUNTERS` of a WSL Job for activity. The anchor exchange changes them each second. A pipe partner in a probe Job added one read and one write operation per line (research R14 S29). So that sum would never stay unchanged, and no stall or inactivity limit would fire.
  - The anchor runs outside the `arbareto-<operationId>-*.scope` units, because the shell starts it without the wrapper. So its own pipe reads never enter the anchor I/O sum.
- Each tracked request carries the stall threshold of 15 seconds in `limits` ("Process fields"). After that time without activity, the shell sends the activity event `stalled` for that process. At the next activity, it sends `active`. It sends an event only when the state changes. An event carries no output, process name, PID, or argument.
- The service sets the stall flag of the operation from these events (data-model §7). The renderer then shows the stall notice in the status region (plan.md "Required visible states"). The notice text is: "Git may be waiting for a prompt that Arbareto cannot show, or for a sign-in window. To answer a hidden prompt, select Cancel and run this command in a terminal."
- The notice shows one copyable command with Copy command:
  - Commit: the §9 `hook run --ignore-missing pre-commit` command. Its stall text is: "This command runs only the pre-commit hook and does not commit. It cannot repeat a prompt from another hook or from signing." This text applies only to the stall notice. A failed commit carries the §9 remedy text instead. The app offers no command that creates a commit, because its own commit can still run.
  - Submodule update: the §12 "Remedies" command of the running step, with its §12 text.
- Command channel: progress events carry no command (§2). So the operation state holds the field `stallRemedy` (data-model §7) while `stalled` is true. It holds the command and its text. The service builds it by the §4 quoting rule when it sets `stalled`. It clears the field at the next activity. When the §4 rule refuses a value, the field holds the text without a command.
- The renderer calls `getOperation` once after each progress event that sets `stalled`, with the `operationId` of that event. It shows the `stallRemedy` of that result.
- The notice changes no operation state and no deadline. The commit keeps its 120-second deadline. An update process keeps its 300-second inactivity limit and its 4-hour ceiling.
- Reason: a native console read under `sh.exe` waits on an invisible console ("Console and input"). In probe S24, such waits changed no I/O counter for 19 to 29 seconds. So a 15-second threshold detects them.
- Limit: a credential helper window does no I/O while it waits, so the notice appears then too. Its text names a sign-in window for that reason. A wait that keeps doing I/O shows no notice.

These controls manage normal owned process trees. They do not sandbox arbitrary trusted hooks or external service launches.

### Lingering Jobs

Processes that Git or a hook starts during a mutation can outlive the mutation's Git process, as with command-line Git. Examples are detached maintenance, a `post-commit` hook child, and a built-in fsmonitor daemon (§4). The shell keeps them owned and ends them at application close (SC-008).

- The shell associates one completion port with each operation Job before the first process joins it. Microsoft advises association while the Job is inactive, so no state change goes unreported (research R5).
- When an owned child exits by itself, the shell reads the active process count of its Job through `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION`. The exit reply carries that count as `activeDescendants`. It carries no process name, PID, or argument.
- The service records `lingeringDescendants` in the mutation outcome. The value is the `activeDescendants` count of the last execution process before reconciliation. For `commit`, that process is `commit --quiet --file=-`. For `updateSubmodules`, it is the last clone, connect, fetch, checkout, or register process that ran (§12). When the service sets `endProcesses` (below) before the terminal response, the value is 0. The count alone never changes the outcome classification. A nonzero count adds the plan.md lingering sentence to every mutation outcome text, success included (plan.md "Required visible states").
- At `ended`, the shell reads the active process count again. A zero count closes the Job handle. Otherwise the Job moves to the lingering set, and the shell reads the count once more. A zero count then closes the handle.
- An `ended` frame with `endProcesses: true` closes the Job at once, with every descendant, and it never lingers. The service sets it after a cancellation during `reconciling` (§8). It also sets it when `revokeTrust` for that common directory came after `started`.
- The shell tags each mutation Job with the common-directory identity that it reads for the `started` frame. The tag survives a service restart.
- A `revoke` trust frame (§7) closes every lingering Job whose tag equals the identity of its common-directory path. The reply states how many processes were active in those Jobs before the close.
- A lingering count request is a `process` frame with the active `operationId` and one common-directory path. The shell reads its identity and returns the total active process count of the lingering Jobs with that tag. It carries no process name, PID, or argument. §9 uses the count in remedies.
- A lingering Job belongs to no running operation. It closes when the port reports `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO` for it, or when the application closes.
- Port message delivery is not guaranteed (research R5). At each `ended` frame, the shell also reads the count of each lingering Job and closes each empty one. A missed message therefore keeps only an empty handle, never a process.
- One shell thread reads the port with `GetQueuedCompletionStatus` and a 1-second timeout. It stops at application close.
- Cancellation, deadline expiry, and Interrupt and close close the operation Job at once, with every descendant. They never create a lingering Job. A cancellation during `reconciling` closes the Job at `ended` instead, so reconciliation reads can finish (§8).
- Read operation Jobs never linger. A read Job closes when the read ends. The service then sends `closeJob` ("Channel frames").
- A service exit or Restart service keeps every lingering Job. The shell owns these Jobs, and they belong to no running operation. They close at application close.
- Application close closes every lingering Job, after the operation Jobs and before the service Job. Kill-on-close ends every remaining process. This holds for `closeIfIdle`, Interrupt and close, and Restart Arbareto. A shell crash closes the handles as well.
- Lingering Jobs alone never make a mutation count as running, so `requestClose` shows no prompt for them (research R7).
- A WSL mutation Job also holds its anchor. Its process counts come from the anchor, not from the Job accounting (§11 "Process ownership").
- A lingering process can hold a Git lock file. For `index.lock`, the next mutation gives `LOCKED` with the §9 remedy. Another lock, such as a ref lock or `HEAD.lock`, makes Git fail (§9 "Other locks"). The app never removes a lock. Reconciliation names an observed lock as foreign (§8).

### Recovery markers

The shell stores one marker file for each mutation without a stated outcome. The files live in the `recovery` folder of the application data directory.

A marker holds its ID, the operation kind, and the start time. It also holds the Git-resolved worktree and common-directory paths and the common-directory identity. It holds no message, patch, configuration, environment value, or credential.

The service sends three `mutation` frames:

- `started` with `operationId`, `repositoryId`, `kind`, and the Git-resolved worktree and common-directory paths. The service sends it before it creates the canonical index lock. That lock is the first side effect of every mutation protocol. See research R3 step 4, R4 step 2, and §4 "File staging" step 2. Exception: `updateSubmodules` takes no canonical index lock, and its first side effect is its first update process (§12 "Update protocol"). The shell reads the common-directory identity itself through `FileIdInfo`. Then it takes the named mutex `Local\Arbareto-mutation-<SHA-256 of that identity>` without waiting ("Cross-instance exclusion" below). It writes and flushes the file, then replies with the marker ID. When the write or flush fails, it releases the mutex. It then replies with the failure class: `disk-full`, `access-denied`, or `other`. The reply also holds the `recovery` folder path (§9). Without a marker ID, the service creates no lock and starts no Git process. A failure reply refuses the mutation with `RECOVERY_MARKER_FAILED` (§9).
- `ended` with `operationId` and `endProcesses` ("Lingering Jobs"), after the terminal response. From `started` to `ended`, the shell treats the mutation as running for `requestClose`. After a service exit, `ended` never arrives. The shell then closes every operation Job outside the lingering set, and afterwards no mutation counts as running. Lingering Jobs stay until application close ("Lingering Jobs"). The marker file stays.
- `resolved` with the marker ID. The service sends it after a known outcome, or after a recovery refresh states an `unknown` outcome (§8). The shell then deletes the file.

**Cross-instance exclusion.** FR-015 covers every running instance in one Windows logon session, and the §5 mutation bound covers one service. So the shell adds one named mutex per common-directory identity:

- The mutex name ends with the SHA-256 of the identity text, as 64 lowercase hex digits. The identity text is the text of "Process fields".
- A mutex that another instance holds gives the `started` reply `busy`. The shell then writes no marker. The service refuses the mutation with `BUSY` and the remedy "Another Arbareto window runs a change in this repository. Wait until it ends, then try again." No lock and no Git process starts.
- `WAIT_ABANDONED` counts as taken, because the owning instance stopped. Its marker waits for the next handshake scan, and this mutation still runs every checkpoint.
- The shell releases the mutex at `ended`. After a service exit, it releases the mutex when it closes the operation Jobs. Process exit releases it too. A Windows mutex belongs to its acquiring thread, so one shell thread takes and releases every such mutex.
- Lingering Jobs hold no mutex, as in one instance ("Lingering Jobs").
- Linked worktrees share the common-directory identity, so two instances never mutate two linked worktrees at once.
- Git's own `index.lock` still guards one index against every other writer. A second writer of that index gets `LOCKED` (§9).
- Scope: the mutex name uses the `Local\` prefix, so it exists only in one logon session. FR-015 states this scope. Instances in two logon sessions of one computer do not exclude each other. Between them, Git's `index.lock` still guards each index. Two linked worktrees have separate indexes, so two sessions can mutate them at once. Design decision, 2026-10-01: keep `Local\` (research R11).

The owning shell keeps each marker file open without delete sharing. At startup, the shell opens each marker file with no sharing. A sharing violation means that a running instance owns the file, so the shell skips it. Otherwise the owner stopped, and this shell takes ownership. The OS closes the handles of a stopped process. So a crash leaves a file that the next start can open. Each startup handshake, also after Restart service, carries every marker that the shell owns. The shell rescans the `recovery` folder for each handshake.

**Damaged markers.** A damaged marker is a marker file that the shell cannot decode into the handshake form. A file above 4 KiB is damaged. A file whose `markerId` differs from its file name is also damaged. The shell keeps a damaged file open without delete sharing, as an owned marker. It issues one UUID-shaped `markerId` for each damaged file. The ID stays the same in each rescan of that shell process. A damaged marker is not an unloaded file. It does not count toward the 64-marker limit, and it blocks no mutation. The handshake lists it in `damagedMarkers` with its `markerId` and file name only. A file that the shell cannot open or read for another reason is skipped. The next handshake scans it again.

**Dismissal.** A marker for a deleted or moved repository never resolves through a refresh. `dismissRecoveryMarker` removes such a marker explicitly. The shell binds a `repositoryDiscovery` context to the stored worktree path of the marker. The context needs the identity of that path. When the identity open fails with `ERROR_FILE_NOT_FOUND` or `ERROR_PATH_NOT_FOUND`, the path does not exist. The shell then creates no context and forwards only the marker ID. Any other identity failure refuses the request with its code ("Registration bootstrap"). With a context, the service runs the discovery profiles there. The service returns one of two results:

- Dismissal allowed: the payload holds no `bootstrapId`, so the service runs no discovery. Discovery also allows it when it gives `REPOSITORY_UNAVAILABLE`, which includes the merged refusal ("Registration bootstrap"). The native confirmation below still follows. It allows it when the resolved common-directory identity differs from the marker identity.
- Dismissal refused: any other result. The code is `STATE_UNKNOWN` with the remedy "Open this repository and use Refresh."

A damaged marker needs no repository context. The shell creates no context and forwards only its marker ID, so the service allows the dismissal.

For a WSL marker, the shell always creates a context. The service allows the dismissal when the distro of the path is absent from the `wslDistros` `listed` set, or when the §11 probe reports the path `absent`. A listed distro without a registration key is not absent. A WSL marker also gets the two Windows allowances: WSL discovery call 1 exits nonzero (`REPOSITORY_UNAVAILABLE`), or the common-directory WSL identity differs from the marker identity. Any other result gives `STATE_UNKNOWN`.

When dismissal is allowed, the shell shows a native confirmation. It names the worktree path, the operation kind, and the start time. For a damaged marker, it names the file name instead. It states that the operation outcome stays unknown. Its buttons are Dismiss and Cancel, and Cancel is the default. Enter on the default, Escape, Alt+F4, the close button, and a call failure mean Cancel. Only the Dismiss button deletes the file. A dismissed marker never counts as a resolved outcome.

### Channel frames

This subsection defines the bodies of `process`, `mutation`, and `trust` frames. A frame body is `{"kind":"<kind>","<kind>":{…}}` with exactly these two keys. The inner object always has `type`. The strict decoder of §1 applies in both directions. The service validates each frame with its zod schema (§1 "Schemas"). The shell reads `mutation` and `trust` frames into the generated serde types. It still checks each path by the path rule below, because typify counts characters, not UTF-16 units. The shell reads the exact `type` value of a `process` frame, then parses its generated group type through `typed` and `same_shape`. It keeps the checks that typify drops and the rules that depend on context state. Their rules depend on each other and on context state, such as `input` or `inputBytes` and `transactionId` with `indexFile`.

- `callId`: the service issues a new UUID-shaped identifier for each request that expects a reply. Every reply repeats `callId`.
- A reply repeats the request `type`, except the `run` and `input` replies and `refused`.
- `ended`, `resolved`, `release`, and `closeJob` carry no `callId` and get no reply.
- `input` carries the `callId` of its `run` request. `cancel` carries the `callId` of a `run`, `identity`, `fileFacts`, or `wslFiles` request.
- Paths are native absolute paths with 1 to 32,767 UTF-16 units and no NUL or lone surrogate. On Windows, a path starts with a drive letter and a separator, or with two separators and a server name and a share name. It never starts with the device prefix `\\.\` or `\\?\`, with either separator. On other platforms, a path starts with `/`. The service checks this rule through `src/contracts/native-path.ts`. The shell checks it through `Path::is_absolute` and the device-prefix check.
- Bytes travel as standard base64 with padding. A decoded chunk holds 1 to 65,536 bytes.

**Process requests.** The service sends these with `kind` `process`.

| `type` | Fields | Shell behavior |
| --- | --- | --- |
| `run` | `callId`, `operationId`, `contextKind`, the context IDs, `arguments`, `environmentPolicy`, `limits`. Optional: `input` or `inputBytes`, `transactionId` with `indexFile`. | Validates each field by "Process fields" and the rules below. Starts one process, or replies `refused`. |
| `input` | `callId`, `data`. | Writes the chunk to the child stdin, then replies `inputWritten`. |
| `cancel` | `callId`. | For a `run` call, it closes the Job of the operation that owns that call, with every descendant. Each process of that operation then gets `exit`. A `run` whose start did not end gets `exit` too ("Walks"). For an `identity`, `fileFacts`, or `wslFiles` call, it stops that walk, and no reply follows ("Walks"). The shell drops a cancel for an ended call and for any other walk. |
| `identity` | `callId`, `operationId`, `contextKind`, the context IDs, `paths`: 1 to 8 paths. | Replies `identity` with one entry per path, in request order, or with `deadline` ("Walks"). |
| `lingeringCount` | `callId`, `operationId`, `commonDirectory`. | Replies `lingeringCount` with the active process count of the lingering Jobs with that tag, or with `deadline` ("Walks"). An unreadable identity gives 0. |
| `fileFacts` | `callId`, `operationId`, `contextKind` `registeredOperation`, `gitInstallationId`, `repositoryId`, `digest`, `files`. Optional, WSL only: `index` ("WSL file work" below). | Replies `fileFacts` with one fact per entry, in request order ("File facts" below), or with `deadline` ("Walks"). |
| `wslFiles` | `callId`, `operationId`, `contextKind` `registeredOperation`, `gitInstallationId`, `repositoryId`, `mode`, `bound`, and the fields of the mode. WSL only. | Replies `wslFiles` with `results` or with `deadline` ("WSL file work" below, "Walks"). |
| `register` | `callId`, `operationId`, `bootstrapId`, `gitInstallationId`, and either `version`, `digest`, and `confirm`, or `repositoryId`, `worktreeRoot`, `gitDirectory`, and `commonDirectory`. `version` is the parsed version text, such as `2.55.0.windows.3`, not the full output line. `digest` is the SHA-256 of the probed file as 64 lowercase hex digits. | Binds the issued ID to the native context of `bootstrapId`. Before the bind, the shell reads the context identity again, as a walk ("Walks"). A `register` without the confirmation is valid only in a startup context. The shell then saves the Git ("Startup contexts"). |
| `resolveGit` | `callId`, `operationId`, and `bootstrapId` of a live `gitProbe` context. `executablePath`: `git.exe` in the folder that `--exec-path` printed (§3 "Git proposal"). | It refuses another file name and a path that is not a regular file with `INVALID_REQUEST`. This rule also covers a startup context. The service checks the installation root ("Startup contexts"). Otherwise it destroys the context, binds a new `gitProbe` context of that operation to the file, and replies `resolveGit`. The new context keeps the selected path and the startup state. On other platforms, the service expects the file name `git`. |
| `wslDistros` | `callId`, `operationId`, and the `bootstrapId` of a live `repositoryDiscovery` context of that operation. | Replies `wslDistros` with the context path ("WSL frames" below). Only for a path with the §11 WSL prefix, it also runs the §11 list calls and reads the registration keys. A Windows path starts no process. |
| `wslProbe` | `callId`, `operationId`, the `bootstrapId` of a live `repositoryDiscovery` context of that operation, `distro`, and `limits` `{deadlineMs}` with 1 to 60,000. | Runs the §11 bootstrap probe in that distro, without the wrapper. It answers as `run` does, with `output` and `exit`. It binds the parsed facts to the context once (§11 "Git per distro"). A second `wslProbe` on a bound context gets `refused` with `INVALID_REQUEST`. |
| `release` | Exactly one of `repositoryId` or `gitInstallationId`. | Removes the binding. A later request with that ID gets `refused` with `UNKNOWN_TARGET`. |
| `closeJob` | `operationId`. | Closes that operation Job with every descendant. It stops each `identity`, `fileFacts`, and `wslFiles` walk and each `run` start of that operation ("Walks"). The ID is then inactive. |

`run` request fields. Every field is required, except where the row says otherwise.

| Field | Value |
| --- | --- |
| `type` | `run`. |
| `callId` | New identifier for this call. |
| `operationId` | Active operation: from its first request until `ended` or `closeJob` for it. |
| `contextKind` | `gitProbe`, `repositoryDiscovery`, or `registeredOperation`. |
| `bootstrapId` | Only for `gitProbe` and `repositoryDiscovery`. A live context of that kind. |
| `gitInstallationId` | For `repositoryDiscovery` and `registeredOperation`. A bound ID ("`register`"). Absent for `gitProbe`. |
| `repositoryId` | Only for `registeredOperation`. A bound ID that is not released. |
| `arguments` | "Process fields" rules. `gitProbe` permits only `--exec-path`, or `version` and `--build-options`. Every other array starts with `--no-lazy-fetch`. |
| `input` | Optional base64 string with 1 to 65,536 decoded bytes. Not with `inputBytes`. |
| `inputBytes` | Optional integer from 1 to 536,870,912. The service then streams `input` chunks. Not with `input`. |
| `environmentPolicy` | `probe` for a bootstrap context. `read`, `mutation`, or `network` for `registeredOperation`. |
| `transactionId` | Optional. Only with `mutation`. |
| `indexFile` | Required with `transactionId`, absent otherwise. Its name starts with `arbareto-candidate-`, inside the registered Git directory. |
| `limits` | `{deadlineMs, stallMs?}`, or `{inactivityMs, ceilingMs, stallMs}` only with `network`. |
| `limits.deadlineMs` | 1 to 30,000 for a bootstrap context. 1 to 60,000 for a WSL distro start probe (§11). 1 to 120,000 for `registeredOperation`. |
| `limits.inactivityMs` | 1 to 300,000. |
| `limits.ceilingMs` | 1 to 14,400,000. |
| `limits.stallMs` | Exactly 15,000. Only in `registeredOperation`. |

Current directory: `gitProbe` uses the application-owned launch directory, and `repositoryDiscovery` uses the selected directory ("Registration bootstrap"). `registeredOperation` uses the worktree root that `register` bound to `repositoryId`. This last rule is a choice; §12 steps still pass their own `-C`.

Context rules:

- A live `bootstrapId` has the matching kind and is younger than 60 seconds. Its first `operationId` owns it. Another `operationId` gets `UNKNOWN_TARGET`.
- The startup `gitProbe` context has no public operation. The service issues an internal `operationId` for it.
- `register` field `version` is printable ASCII with at most 64 bytes, as `webView2Version`.

Streamed input:

- After `run` with `inputBytes`, the service sends `input` chunks in order.
- At most 8 chunks of one call wait without an `inputWritten` reply.
- The shell closes the child stdin when the written total equals `inputBytes`.
- A chunk past `inputBytes` closes the operation Job. The `exit` then follows.
- After `exit`, the shell drops each `input` of that call.

**Process replies.** The shell sends these with `kind` `process`.

| `type` | Fields | Meaning |
| --- | --- | --- |
| `output` | `callId`, `stream`: `stdout` or `stderr`, `data`. | Bytes that the child wrote before its completion signal. |
| `activity` | `callId`, `state`: `stalled` or `active`. | The stall event of "Activity and stall notice". Only a call with `stallMs` gets it. |
| `inputWritten` | `callId`. | The shell wrote one `input` chunk to the child stdin. |
| `exit` | `callId`, `exitCode`, `activeDescendants`, optional `deadline`. | The last reply of a `run`. It follows every `output` of that call. |
| `refused` | `callId`, `code`. | The request started nothing. Valid for each request with `callId`. |
| `identity` | `callId`, and either `identities` or `deadline`. | Each entry is an identity reply ("Process fields") or `{"code":"UNSUPPORTED_REPOSITORY"}`. A refusal for a not-found path also carries `"reason":"absent"` ("Process fields"). `deadline` is `deadline` when the walk passed its §5 deadline. That reply holds no identity. |
| `lingeringCount` | `callId`, and either `count` or `deadline`. | `count` is a nonnegative safe integer. `deadline` is `deadline` when the walk passed its §5 deadline. |
| `fileFacts` | `callId`, and either `facts` or `deadline`. With a request `index`, also `index`. | One fact per request entry, in request order ("File facts" below). `deadline` is `deadline` when the walk passed its §5 deadline. That reply holds no fact. `index` has the `indexDigest` result form ("WSL file work" below). |
| `wslFiles` | `callId`, and either `results` or `deadline`. | One result per request entry, or one result for a mode without entries ("WSL file work" below). `deadline` is `deadline` when the walk passed its §5 deadline. That reply holds no result. |
| `register` | `callId`, and either `result` or `deadline`. `result`: `approved`, `declined`, or `another`. With `another`, also `bootstrapId` and `executablePath` of the new `gitProbe` context. `executablePath` is a native absolute path by the channel path rule. | Git with `confirm: true`: the Git selection confirmation result. Otherwise `approved`. `deadline` is `deadline` when the identity read passed its §5 deadline. The shell then destroyed the context and bound no ID. |
| `resolveGit` | `callId`, and either `bootstrapId` or `deadline`. | The new `gitProbe` context for the resolved file. The first context ID is no longer valid. `deadline` is `deadline` when the walk passed its §5 deadline. |
| `wslDistros` | `callId`, `path`. With the §11 WSL prefix, also `wslExecutable`, `listed`, `running`, `keys`, and `saved`, or `code` `WSL_UNAVAILABLE` with `reason` `wsl-missing`. | `path` is the context path, always present. `wslExecutable` is the `%SystemRoot%\System32\wsl.exe` path that remedy commands name (§11 "Remedy commands"). `listed` and `running` are the names that the two §11 list calls print. `keys` holds the registration key of each listed name: its `name`, its `guid`, and its `version`. `saved` holds the saved Git of each listed GUID (§11 "Git per distro"). |

- `exitCode` is an integer from 0 to 4,294,967,295. It is `null` when a Job close ended the process, or when no process started ("Walks").
- `deadline` is `deadline`, `inactivity`, or `ceiling`. It names the expired limit. A `run` start past the §5 walk deadline gives `deadline`.
- `activeDescendants` is the active process count of the Job at the exit ("Lingering Jobs"). It is 0 when no process started.
- `refused` codes: `INVALID_REQUEST` for a field that breaks a rule. `UNKNOWN_TARGET` for an inactive or unbound ID or an expired context.
- More `refused` codes: `GIT_CHANGED` for a changed executable identity. `PROCESS_OWNERSHIP_FAILED` for a failed start in the Job or a failed resume.

**Backpressure.** The shell keeps at most 8 chunks per stream. A chunk leaves the queue when its frame write returns. A full queue stops the reads of that child pipe, so Git waits on its write. The service handles each frame before it reads the next frame. It never queues output frames itself. Streamed input uses `inputWritten` instead, so the shell never blocks its service pipe reader.

**Byte caps.** The shell forwards every byte before the completion signal. It enforces only the chunk size and the queue depth. The service retains at most 64 KiB per stream for diagnostics (§5). It counts every forwarded stderr byte of the operation. At 4 MiB it sends `cancel` (§9). An `updateSubmodules` process counts its own 4 MiB. A stream above its §5 result bound also gets `cancel`.

**Walks.** A walk is the part of a request that opens a file or waits on a process before the shell replies. The shell runs each walk on its own thread with a watchdog, so the frame reader never waits on a file open or a process.

| Request | Walk | Deadline reply |
| --- | --- | --- |
| `identity` | Each identity read. | `identity` with `deadline`. It holds no identity. |
| `fileFacts` | Each open, query, and read. | `fileFacts` with `deadline`. It holds no fact. |
| `wslFiles` | The whole `wsl.exe` process of the request. | `wslFiles` with `deadline`. It holds no result. |
| `run` | The start: the identity reads before execution, the Job open, and the process start. The `limits` deadline starts when the process starts. | `exit` with `exitCode` null, `activeDescendants` 0, and `deadline` `deadline`. The shell closes the operation Job. |
| `lingeringCount` | The identity read of `commonDirectory`. | `lingeringCount` with `deadline`. |
| `register` | The identity read of the context path. In a WSL context, this is the §11 identity probe. | `register` with `deadline`. The shell destroys the context and binds no ID. |
| `started` | The identity read of `commonDirectory`. | `started` with `deadline`. The shell takes no mutex, writes no marker, and tags no Job. |
| `revoke` | The identity read of `commonDirectory`. | `revoke` with `deadline`. The shell closes no lingering Job. |
| `resolveGit` | The file check and the identity read of `executablePath`. | `resolveGit` with `deadline`. The shell keeps the first context and binds no new context. |

- A deadline reply is `{"type":"<request type>","callId":"<callId>","deadline":"deadline"}`, except for `run`.
- The §5 walk deadline starts when the shell reads the request. At the deadline, the shell sends the deadline reply and stops the walk.
- Only the watchdog sends the reply and makes the changes of a walk: a bind, a context destroy, a mutex, a marker, a Job tag, a Job close, a record deletion, or a process start. So no change follows a deadline reply or a stop.
- A `cancel` with the `callId` of an `identity`, `fileFacts`, or `wslFiles` walk stops that walk. No reply follows. A `closeJob` stops each `identity`, `fileFacts`, and `wslFiles` walk of its operation.
- A `cancel` or `closeJob` also stops a `run` start. The shell closes the operation Job and replies `exit` with `exitCode` null and `activeDescendants` 0.
- `cancel` and `closeJob` never stop a `lingeringCount`, `register`, `started`, `revoke`, or `resolveGit` walk. The service has no abort for these calls, so each one waits for its reply or its deadline reply.
- A service exit stops every walk. No reply follows.
- To stop a walk, the shell sets a stop flag and calls `CancelSynchronousIo` on the walk thread (Microsoft Learn "Canceling Pending I/O Operations"). The shell repeats the call every 10 milliseconds until the walk thread ends, for at most 5 seconds. A process start makes more than one open, and each open can wait (research R5 U3). The walk checks the flag before each open, query, and read. The shell never sends a fact or an identity from a stopped walk.
- The service does not wait for the shell after it sends `cancel` for an `identity`, `fileFacts`, or `wslFiles` walk. It ends that call as canceled at once. A later reply with that `callId` is dropped ("Errors"). For a `run`, the service waits for `exit`, as for every `run`.
- An `input` chunk that comes before the process starts waits in the queue of its call. The 8-chunk rule applies ("Streamed input"). A start that ends without a process drops the waiting chunks.
- `revoke` deletes each record whose `commonDirectory` equals the request path before its walk starts. That deletion needs no identity.
- Limit: a driver can ignore a cancel, and a cancel can come between the flag check and the next open. The walk thread then waits until its I/O returns. No reply waits for it. The shell does not bound the count of such threads. A `CancelSynchronousIo` call can itself wait while the I/O is not cancelable (research R5 U3). Only the watchdog thread waits then, after its reply.
- A WSL `identity`, `fileFacts`, or `wslFiles` request is a walk too (§11). It follows the same deadline, deadline reply, and stop rules. A stop of a WSL walk ends the walk's own `wsl.exe` process, never the operation Job, because `CancelSynchronousIo` cannot stop a process wait.

**WSL frames.** `wslDistros` and `wslProbe` exist only for WSL routing (§11).

- `wslDistros` accepts any live `repositoryDiscovery` context of the operation. The service holds only the bootstrap ID, so it routes the path that the reply returns (§11 "Route").
- The reply always holds the context path `path`. It holds `wslExecutable`, the list results, the keys, and the saved Gits, or `WSL_UNAVAILABLE` with reason `wsl-missing`, only when the path has the WSL prefix of `src/contracts/wsl-route.ts` (`PREFIX`). For a Windows path, the shell starts no process.
- A service on another platform never sends `wslDistros`, because WSL routing exists only on Windows (§11 "Route").
- The WSL form of `register` holds only `callId`, `operationId`, `bootstrapId`, `gitInstallationId`, and `confirm`. The shell issues the ID only from the facts that `wslProbe` bound. For the repository form in a WSL context, all three paths must lie under `\\wsl.localhost\<bound distro>\`, and `gitInstallationId` must name a WSL installation with the bound GUID. Otherwise the shell refuses with `INVALID_REQUEST`.
- In a WSL context, a changed or failed `register` probe destroys the context and gives `refused` with `UNKNOWN_TARGET`. A probe past the walk deadline gives `register` with `deadline`.

**WSL file work.** `wslFiles` keeps bulk file work of a WSL repository inside the distro. Only facts, sizes, SHA-256 digests, object IDs, exit statuses, and link targets cross to Windows. Reasons: reads through `\\wsl.localhost` (9P) are slow, and no probe verified an atomic replace through 9P. Research R13 "WSL in-distro file work" holds the evidence.

- The repository must be a WSL repository. Another repository, or another `contextKind`, gets `refused` with `INVALID_REQUEST`. An unbound or released `repositoryId` gets `refused` with `UNKNOWN_TARGET`.
- The shell runs the fixed Perl text `wslFiles` of `src/contracts/wsl-process.json` as `/usr/bin/perl -e <text>`. It runs through the wrapper in `probe` mode, in the Job of the request's `operationId`, under the §5 walk deadline. One request starts one `wsl.exe`. The arguments are `mode`, the Linux paths of the three roots, the approved Git path, and the approved `/usr/bin/sha256sum` path (§11 "Git per distro"). Stdin holds the entries and the mode fields as NUL-ended tokens, as for `fileFacts`.
- Each Perl text starts with the shared lines `perlHead` of `src/contracts/wsl-process.json`: the module imports and the helpers that both texts use. The shell and the test double join `perlHead` and the text with one line end.
- Stdin order: the bound as decimal bytes (1,048,576, 536,870,912, or 67,108,864), then the entries, then the mode fields. An entry is its root index (0 worktree root, 1 Git directory, 2 common directory), its component count, and its components. The mode fields follow in this order: `indexDigest` the `sharedIndex` when present; `catFile` the `oid` and the `size`; `lock` the `token`; `candidate` the `candidate`; `publish` the `candidate`, the lock `device` and `inode`, the `token`, and the `expected` digest; `remove` the name (`index.lock` for the lock form, else the `candidate`), then the lock `device`, `inode`, and `token` for the lock form, or the `expected` digest. The token-only lock form sends an empty `device` and `inode`.
- Record grammar. Perl writes NUL-ended tokens of printable ASCII without a space. A link record has a length token and that many raw bytes after it. Numbers are decimal without a leading zero. Each result is one record in request order:
  - `file <size> <changed 0|1> sha256 <hex>` or `file <size> <changed> bound`;
  - `link <component> <length>` and the raw target bytes; `directory`; `absent`; `other`; `error <component> <code>`;
  - `object <size> <hex> <oid|none> <exit> <exit>` and `blob <size> <hex> <over 0|1> <exit> <exit>`, where each exit is `exit <n>` or `signal <n>`;
  - `index <part> [<part>]`, where each part is `digest <size> <hex>`, `absent`, `bound`, or `error <code>`;
  - `lock <device> <inode>`, `locked`, `candidate <size> <hex> <mtime> <size> <hex> <mtime>`, `bound`, `published <size> <hex>`, `mismatch`, `notOwned`, and `removed`.
- The shell keeps at most 64 × (4,095 + 256) bytes of stdout. More output is a broken record form. The test double applies the same cap.
- The walk uses the `fileFacts` open rules (§11 "Trust and environment"): `O_DIRECTORY` and `O_NOFOLLOW` for each middle component, `fchdir` through the handle, and the Perl `$!` `errno` for each failed call. The §6 "File facts" component rule applies to each entry.
- `cancel` and `closeJob` end the process as for `fileFacts`, and no reply follows ("Walks").

Request fields. Every field of the mode is required.

| `mode` | `bound` | Mode fields |
| --- | --- | --- |
| `digest` | `COMPARED_RAW_VERSION_BYTES` with 1 to 64 entries, or `WHOLE_FILE_STAGE_INPUT_BYTES` with 1 entry. | `files`: entries of `root` and `path`, as in "File facts". |
| `indexDigest` | `MUTATION_RAW_INDEX_BYTES`. | Optional `sharedIndex`: the 40 or 64 lowercase hex digits of the `link` extension that the service parsed last. |
| `hashObject` | `WHOLE_FILE_STAGE_INPUT_BYTES`. | `files`: 1 entry with root `worktreeRoot`. |
| `catFile` | `WHOLE_FILE_STAGE_INPUT_BYTES`. | `files`: 1 entry with root `worktreeRoot`. `oid`: the staged object ID. `size`: the verified size, at most the bound. |
| `lock` | `MUTATION_RAW_INDEX_BYTES`. | `token`: 64 lowercase hex digits, 32 random bytes of the service (§4 "WSL index publication"). |
| `candidate` | `MUTATION_RAW_INDEX_BYTES`. | `candidate`: the file name, which starts with `arbareto-candidate-`. |
| `publish` | `MUTATION_RAW_INDEX_BYTES`. | `candidate`, `lock`: the `device` and `inode` of the `lock` reply, `token`: the token of that `lock` request, and `expected`: the verified candidate SHA-256. |
| `remove` | `MUTATION_RAW_INDEX_BYTES`. | Either `lock` and `token`, for the lock, or `candidate` with `expected`: the candidate SHA-256 that the service verified last. `lock` is the `device` and `inode` of the `lock` reply, and `token` is the token of that `lock` request. Without a `lock` reply, `token` alone (§4 "WSL index publication", lock token exception). |

- Another `bound` for the mode gives `refused` with `INVALID_REQUEST`. So does a missing or extra field.
- The index is `index` in the Git directory that `register` bound to `repositoryId`. The lock is `index.lock` beside it, and the candidate lies beside it too. The Git children of `wslFiles` run in `probe` mode, which sets no `GIT_INDEX_FILE` (§11 "Process launch"), so they use this index.

Mode rules:

- Digest. Perl `sysread`s at most the bound plus one byte. It writes them to a pipe-open of the approved `sha256sum` with the single argument `-`, in list form, so no shell parses an argument. The child stdout is a second pipe, which Perl reads after `close`. The output must match `^[0-9a-f]{64} [ *]-\n$` exactly (GNU coreutils `sha256sum --help`: hash, space, mode character, name). R13 verified this line with GNU coreutils 9.4 (Ubuntu-24.04) and with uutils coreutils 0.10.0 (Ubuntu-26.04, `/usr/lib/cargo/bin/coreutils/sha256sum`). `close` must set `$?` to 0. Another line or status gives `error` with code `other-error`. The 68-byte line fits the 65,536-byte Linux pipe capacity (pipe(7)), so the child never waits on its write.
- `digest`: each result is a `fileFacts` kind with `component` where that kind has it. A `file` result also holds `size`, `changed`, and either `sha256` or `bound`. `size` is the count of bytes that Perl wrote to `sha256sum`. A count above the bound gives `bound` with the limit name and no `sha256`. `changed` is `true` when the device or inode of `lstat` on the final name differs from those of `fstat` on the opened file. The service then reads again once, as for an atomic save (`readWorkingVersion`). `changed` does not catch an in-place write during the read, or a new file that reuses the freed inode. The step-7 digest of each protocol (§4 "File staging") covers both. A final `link` result also holds `targetBytes`, in place of the `fileFacts` text `target`: the raw `readlink` bytes as base64, 1 to 4,095 bytes, and `sha256` of those bytes. The shell sends no `executable`, `ownerExecute`, or `lastWrite`.
- `indexDigest`: one result with `index` and, with a request `sharedIndex`, `sharedIndex`. Each holds `size` and `sha256`, `absent`, `bound`, or `error` with `code`. The shared file is `sharedindex.<sharedIndex>` in the Git directory (read-cache.c). The size bound counts both files together, as §5 states. Perl never searches for a shared file. When the index digest differs from the retained digest, the service reads the index bytes through UNC and parses the `link` extension again.
- `hashObject`: Perl reads the file once. It writes each chunk to `sha256sum` and to a pipe-open of `<approved Git> --no-lazy-fetch -C <Linux worktree root> hash-object --stdin --path=<path>`. The result holds `size`, `sha256`, `oid`, `gitExit`, and `hashExit`. `oid` is the Git output when it is exactly one line of 40 or 64 lowercase hex digits, else absent. The shell does not know the object format. The service compares `oid` with the staged object ID. A non-file final component gives its `fileFacts` kind instead. A file above the bound gives `file` with `bound`, and Perl closes both pipes.
- `catFile`: Perl pipe-opens `<approved Git> --no-lazy-fetch -C <Linux worktree root> cat-file --filters --path=<path> <oid>` for reading. It opens no entry: the entry components only give `--path`, joined with `/`. Its `error` results carry component 0. It keeps at most `size` plus one byte and writes them to `sha256sum`. The result holds `size`, `sha256`, `gitExit`, `hashExit`, and `over`. The result `size` is the count of bytes that Perl read. `over` is `true` when Git wrote more than `size` bytes. Perl then stops reading and closes the pipe, so Git can end by `SIGPIPE`. With `over`, the service ignores `gitExit`, and proof A fails.
- `gitExit` and `hashExit` come from `$?` after `close` (perlvar): `{"exitCode":n}` with `$? >> 8` when `$? & 127` is 0, else `{"signal":n}` with `$? & 127`. Git stderr goes to the probe stderr. The shell forwards no probe stderr in a frame, as for `fileFacts` (`collect` in `src-tauri/src/wsl.rs`). So Git stderr reaches no reply, and only the exit statuses decide.
- `lock`: one result. `lock` holds `device` and `inode` as decimal text, or `locked` for `EEXIST`, or `error` with `code`. Perl writes the request `token` into the new lock. A failed or short write gives `error`, and the lock stays with unknown ownership. "WSL index publication" in §4 states the rule.
- `candidate`: one result with `index` (`size`, `sha256`, and `mtime`) and `candidate` (`size`, `sha256`, and `mtime`), or `absent` for an absent index, `bound` for an index above the bound, or `error` with `code`. Both `mtime` values are whole seconds as decimal text. The candidate open uses `O_CREAT|O_EXCL|O_NOFOLLOW`. §4 "Candidate time" states the time rule.
- `publish`: one result: `published` with `size` and `sha256`, `mismatch`, `notOwned`, or `error` with `code`. `notOwned` means an absent lock (`ENOENT`), a regular-file lock with another device or inode, or a lock whose content is not the token. It also means that `lstat` of the name `index.lock` before the rename gives `ENOENT` or another device or inode than the open descriptor. Every other failed `lstat`, and a directory or a symbolic link at `index.lock`, give `error`, not `notOwned`. `mismatch` and `notOwned` rename nothing, and the lock keeps or gets back the token. An `error` before the rename writes the token back when it can. A failed directory `fsync` after the rename gives `error` and writes nothing back, because the lock is then the index.
- `remove`: one result: `removed`, `notOwned`, or `error` with `code`. Perl opens the name with `O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_NOCTTY`. The lock form checks through the descriptor that the file has the device and inode of the request `lock`, is 64 bytes, and holds the token. The token-only form omits the device and inode check. The candidate form digests the file through the descriptor, within the bound, and compares the digest with `expected`. Then `lstat` of the name must give the device and inode of `fstat` on the descriptor, and `unlink` follows. `notOwned` uses the `publish` rules: `ENOENT`, another device or inode, or other content. Every other failure, and a non-regular file, give `error`. `notOwned` and `error` remove nothing. A window remains between the last `lstat` and the `unlink`, as for `publish`. §4 "WSL index publication" states the order, the durability rule, and the window that remains.

Result wire forms. Each result is an object with `kind`:

| `kind` | Fields | Modes |
| --- | --- | --- |
| `file` | `size`, `changed`, and either `sha256` or `bound` (`COMPARED_RAW_VERSION_BYTES` or `WHOLE_FILE_STAGE_INPUT_BYTES`). | `digest`; `hashObject` with `bound` only. |
| `directory`, `absent`, `other` | None. | `digest`, `hashObject`; `absent` also `candidate`. |
| `link` | `component`. A final link also holds `targetBytes` and `sha256`. | `digest`, `hashObject`. |
| `error` | `component` and `code`. | Every mode. Modes without entries use component 0. |
| `object` | `size`, `sha256`, optional `oid`, `gitExit`, `hashExit`. | `hashObject`. |
| `blob` | `size`, `sha256`, `over`, `gitExit`, `hashExit`. | `catFile`. |
| `index` | `index` and optional `sharedIndex`, each an index part. | `indexDigest`, and the `index` of a `fileFacts` reply. |
| `lock` | `device`, `inode`. | `lock`. |
| `locked` | None. | `lock`. |
| `candidate` | `index` and `candidate`, each `{size, sha256, mtime}`. | `candidate`. |
| `bound` | None. | `candidate`. |
| `published` | `size`, `sha256`. | `publish`. |
| `mismatch` | None. | `publish`. |
| `notOwned` | None. | `publish`, `remove`. |
| `removed` | None. | `remove`. |

- An index part is `{kind:"digest", size, sha256}`, `{kind:"absent"}`, `{kind:"bound"}`, or `{kind:"error", code}`.
- An exit is `{"exitCode":n}` with n from 0 to 255, or `{"signal":n}` with n from 1 to 127.
- `device` and `inode` are unsigned 64-bit decimal text without a leading zero. `mtime` is signed 64-bit decimal text.
- The WSL `error` codes are only `access-denied`, `io-error`, and `other-error`. `sharing-violation` never occurs.
- A probe that does not exit 0, or output that breaks the record form, gives each result `error` with component 0 and code `other-error`. For `publish`, the service then treats the publication state as unknown (§4 "WSL index publication").

**Index digest in a read.** A WSL `fileFacts` request can carry `index`: `{}` or `{"sharedIndex":"<hash>"}`. The fact walk then also gives the `indexDigest` result, in the same `wsl.exe` process. Only a WSL repository with `digest: false` accepts the field. Another request with it gets `refused` with `INVALID_REQUEST`. The first phase-1 request of the trust listing of each WSL `readWorkspace` carries it (§7 "Program file digests"). WSL reads never share a listing (§7 "Shared listing"), so the digest adds no `wsl.exe` start. A listing without a phase-1 request carries no `index` result. An example is a hooks path outside every root with no repository-controlled program. That read takes the index bytes through UNC. A limited index listing (`STATUS_LISTING_*`) does not replace the retained raw-index part. Reuse still requires equal digests. Contract §11 "Change polling" states how the read uses it. With `index`, the `fileFacts` arguments are `0`, the three Linux roots, the approved `sha256sum` path, and the `sharedIndex` hash when present. The `index` record follows the fact records. Its bound is `MUTATION_RAW_INDEX_BYTES`. A broken record form gives each fact and the `index` `error` with component 0 and code `other-error`.

**Mutation frames.** "Recovery markers" defines their use.

| `type` | Fields | Reply |
| --- | --- | --- |
| `started` | `callId`, `operationId`, `repositoryId`, `kind`: one mutation name of §3, `worktreeRoot`, `commonDirectory`. | `{type, callId, markerId}`, `{type, callId, busy: true}`, `{type, callId, failure, folder}`, or `{type, callId, deadline: "deadline"}` ("Walks"). |
| `ended` | `operationId`, `endProcesses`: boolean. | None. Only after a `started` reply with `markerId`. |
| `resolved` | `markerId`. | None. |

- `failure` is `disk-full`, `access-denied`, or `other`. `folder` is the `recovery` folder path.
- An unreadable common-directory identity gives `failure` `other`.
- A `busy`, failure, or `deadline` reply holds no mutex and no marker. The service then sends `closeJob`, not `ended`.

**Trust frames.** §7 "Trust approval store" defines their use.

| `type` | Fields | Reply |
| --- | --- | --- |
| `confirm` | `callId`, `worktreeRoot`, `gitDirectory`, `commonDirectory`, `gitSelectedPath`, `fingerprint`, `persist`: boolean. With `persist: false`, also `bound`. | `{type, callId, result}`: `approved` or `declined`. `approved` also carries `stored`. With `stored: true`, the reply also holds `record` in the handshake record form. `stored: false` has no `record`. It follows `persist: false` or a failed record write (§7 "Trust approval store"). |
| `revoke` | `callId`, `commonDirectory`. | `{type, callId, endedProcesses}`: a nonnegative safe integer. Or `{type, callId, deadline: "deadline"}` ("Walks"). |
| `confirmRun` | `callId`, `worktreeRoot`, `submodulePaths`: 1 to 256 paths in display order, `programCount`: at least 1, `uncheckedCount`: 0 to `programCount`. | `{type, callId, result}`: `approved` or `declined`. |

- `fingerprint` is 64 lowercase hex digits. `gitSelectedPath` is a native absolute path by the channel path rule.
- `bound` is `file-count`, `file-bytes`, `total-bytes`, `link`, or `name` (§7 "Program file digests").
- An unreadable common-directory identity gives `revoke` the reply `endedProcesses` 0, as for `lingeringCount`.
- A service exit closes each open trust dialog as Cancel. The shell then writes and deletes no record.

**Errors.**

- The service drops a reply with an unknown `callId`.
- A reply that breaks its shape gets a `public` response with `rejected`, `INVALID_REQUEST`, and `requestId` `null` (§1).
- For a `run` call, that reply also makes the service send `cancel`. It ignores later output and waits for `exit`. The call then fails with `PROCESS_OWNERSHIP_FAILED`.
- A malformed `exit` fails its call at once with `PROCESS_OWNERSHIP_FAILED`. So does a malformed reply to a request other than `run`.
- The shell answers a malformed request that holds a valid `callId` with `refused` and `INVALID_REQUEST`. It drops every other malformed frame.
- A service exit drops every pending call and stops every walk. The shell keeps the lingering set ("Lingering Jobs").

### File facts

The service never stats, opens, or reads a repository-controlled program or hook path (§7). The shell reads such files below the three Git-resolved roots, and it never follows a link below a root (spec Clarifications, 2026-10-05). §7 "Program file digests" states how the service uses the facts.

Request fields. Every field is required, except `index`.

| Field | Value |
| --- | --- |
| `type` | `fileFacts`. |
| `callId` | New identifier for this call. |
| `operationId` | Active operation. |
| `contextKind` | `registeredOperation`. Another context gets `refused` with `INVALID_REQUEST`. |
| `gitInstallationId`, `repositoryId` | Bound IDs. An unbound or released `repositoryId` gets `refused` with `UNKNOWN_TARGET`. |
| `digest` | Boolean. `true` asks for the SHA-256 of each final file. |
| `files` | 1 to 64 entries (§5). Each entry holds exactly `root` and `path`. No entry holds an absolute path. |
| `root` | `worktreeRoot`, `gitDirectory`, or `commonDirectory`: the path that `register` bound to `repositoryId`. |
| `path` | 1 or more name components below the root, in order. |
| `index` | Optional. Only for a WSL repository with `digest: false` ("WSL frames", "Index digest in a read"). The Windows shell refuses it with `INVALID_REQUEST`. |

Component rule. Each component has 1 to 255 UTF-16 units (§5). It holds no NUL and no lone surrogate. It follows the native rule of `isComponent` in `src/contracts/native-path.ts`:

- Windows (Microsoft Learn "Naming Files, Paths, and Namespaces", "Naming Conventions"): no `<`, `>`, `:`, `"`, `/`, `\`, `|`, `?`, or `*`, and no U+0000 to U+001F. No trailing space or period, so `.` and `..` fail too. No reserved device name in any letter case, also with an extension: `CON`, `PRN`, `AUX`, `NUL`, `COM1` to `COM9`, `COM¹` to `COM³`, `LPT1` to `LPT9`, and `LPT¹` to `LPT³`. So `nul` and `COM1.txt` fail.
- POSIX (POSIX.1-2024 XBD 3.146 "Filename"): no `/` and no NUL, and not `.` or `..`.
- So no entry can name a UNC path, a device, an alternate data stream, or a parent folder.
- A broken rule gives `refused` with `INVALID_REQUEST`, and the shell reads nothing.

Shell behavior:

- The shell opens each root as the identity request does ("Process fields"). Git resolved and opened each root during discovery. A root that cannot be opened gives `absent` for a not-found result (Win32 `ERROR_FILE_NOT_FOUND` or `ERROR_PATH_NOT_FOUND`). Any other failure gives `error` with `component` 0.
- It opens each component relative to the handle of its parent. A component that is a link ends the walk of that entry. The shell never follows it.
- On Windows, the shell opens each component with a case-insensitive lookup (`OBJ_CASE_INSENSITIVE`), as Win32 and Git do. A WSL repository follows §11.
- On Windows, a link is a reparse point with a name-surrogate tag (Microsoft Learn "Reparse Point Tags", `IsReparseTagNameSurrogate`). On POSIX, it is a symbolic link.
- On Windows, two open results mark a reparse point: `STATUS_REPARSE_POINT_ENCOUNTERED` and `STATUS_IO_REPARSE_TAG_NOT_HANDLED`. A tag that no file system filter handles gives the second result (T302). The shell then opens the component again with `FILE_OPEN_REPARSE_POINT` and reads its tag.
- A reparse point with another tag is no link. As a middle component, it gives `other`, and the walk of that entry ends. As the final component, it gives the fact of its type. With `digest: true`, a file there gives `error` with code `other-error`, because a read of its logical bytes needs an open that follows the reparse point.
- A file system filter can complete the open of its own reparse point. WOF does this for a compressed file, so the open gives no reparse result. Such a file gives the fact of its type, and the digest covers its logical bytes (T302).
- A component that exists but cannot be opened or read gives `error`. A failed read of a final file gives `error` too.
- The shell opens each final component with attribute access only and reads its type. A directory gives `directory`, also with `digest: true`. Only a regular file is opened again for its data.
- With `digest: true`, the shell reads the size of each final file through its handle. It reads at most the per-file bound plus one byte and hashes the bytes with SHA-256. With `digest: false`, it reads no file data.
- The §5 byte bounds apply in request order. The shell checks the 1 MiB per-file bound first. A file above 1 MiB always gets bound `file-bytes` and no digest. Only files within 1 MiB count toward the 8 MiB request total, with their digested bytes. The first file within 1 MiB that would pass that total gets bound `total-bytes` and no digest, and so does each later file within 1 MiB.
- A WSL repository gets the §11 "Trust and environment" rule.
- Limit: an SMB server can resolve a junction on its own side, where `OBJ_DONT_REPARSE` cannot see it. So a root on an SMB share can give a fact through such a junction. That junction can target only the volumes of that server.
- Git opens the same path through the same server, so the server resolves the same junction for Git. The fact and its digest therefore describe the bytes that Git runs. The junction text names a server path, which the service cannot map to a client path (§7). So a detected junction would give only `unchecked`. Decision D30 (T312): this limit stays.
- The walk has the §5 walk deadline and stops at `cancel` ("Channel frames", "Walks").

Reply facts. Each fact holds `kind` and the fields of its kind.

| `kind` | Fields | Meaning |
| --- | --- | --- |
| `file` | `size`, `lastWrite`. Optional: `digest` or `bound`, never both, `executable`, and `ownerExecute`. | A regular file. `size` is a nonnegative safe integer. `lastWrite` is a signed 64-bit integer as decimal text. On Windows it is `FILE_BASIC_INFO` `LastWriteTime` in 100-ns units since 1601. On POSIX it is the modification time in nanoseconds since 1970. `digest` is the SHA-256 as 64 lowercase hex digits, only with `digest: true` and no bound. `bound` is `file-bytes` or `total-bytes`. |
| `directory` | Optional: `executable`. | A directory. |
| `link` | `component`, `tag`. With tag `symlink` or `junction`, also `target` and `relative`. | `component` is the position of the link in `path`, counted from 1. `tag` is `symlink`, `junction`, or `other` for another name-surrogate tag. `target` is the link text as stored: the `SubstituteName` of the reparse data on Windows, the `readlink` text on POSIX. `relative` is the relative flag of a symbolic link, and `false` for a junction. A target that is no well-formed text, or that holds NUL, gives tag `other`. The shell reads nothing after the link and computes no digest. |
| `absent` | None. | A component does not exist, or a parent component is no directory. Only these open results mean `absent`: `STATUS_OBJECT_NAME_NOT_FOUND` and `STATUS_OBJECT_PATH_NOT_FOUND` on Windows (Win32 `ERROR_FILE_NOT_FOUND` and `ERROR_PATH_NOT_FOUND`), and `ENOENT` and `ENOTDIR` on POSIX. |
| `other` | None. | The object exists but is no regular file, directory, or link, such as a FIFO, a socket, or a device. A middle component with a reparse tag that is not a name surrogate gives `other` too. Such an object cannot run as a hook. |
| `error` | `component`, `code`. | A component exists but cannot be opened or read. `component` is the position of the failed component in `path`, counted from 1. Component 0 is the root. `code` is one entry of the closed list below. |

The `error` codes (`FILE_FACT_ERRORS` in `src/contracts/channel.ts`):

| `code` | Windows status (Win32 error) | POSIX `errno` |
| --- | --- | --- |
| `access-denied` | `STATUS_ACCESS_DENIED` (`ERROR_ACCESS_DENIED`) | `EACCES` |
| `sharing-violation` | `STATUS_SHARING_VIOLATION` (`ERROR_SHARING_VIOLATION`) | None. |
| `io-error` | `STATUS_IO_DEVICE_ERROR` (`ERROR_IO_DEVICE`) | `EIO` |
| `other-error` | Every other failure. | Every other failure. |

- `executable` comes only on POSIX and in a WSL fact (§11). It is the result of an `X_OK` access check on the opened object, as Git `find_hook` uses it for hooks. The Windows shell never sends it.
- `ownerExecute` comes only on POSIX and in a WSL fact (§11), as an optional boolean in a `file` fact. It is the owner execute bit `S_IXUSR` of the opened object, as Git `run-command.c` `is_executable` reads it. Only `ownerExecute` decides a bare-name candidate (§7 "Program file digests"), and `X_OK` decides nothing there. `executable` stays the `access(X_OK)` result for the hook listing.
- The reply holds exactly one fact per entry.

## 7. Startup, trust, and environment

Apply the Git and WebView2 minimum versions in `plan.md`. Admitted versions permit testing but are not automatically qualified. Reject versions below the minimum with the specified component error. Native startup reports WebView2 rejection before creating a webview.

Rust sanitizes the service environment before process creation. Remove Bun CLI-bypass, runtime-argument, inspector, preload, and related runtime-control variables.

Use case-insensitive environment-name matching on Windows. Do not pass arbitrary startup arguments or explicit configuration paths to the compiled service.

Apply all four verified Bun compile-autoload restrictions. Hostile repository configuration files must remain inactive during service startup.

Construct Git child environments separately. Remove the repository-location variables that Git `Documentation/git.adoc` lists, such as `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and `GIT_COMMON_DIR`. Only `mutation` sets `GIT_INDEX_FILE`, from a service-owned `transactionId`. Preserve existing identity, signing, and authentication configuration without persistent changes.

Every policy also removes each variable whose name starts with `GIT_TEST_`. Git's test suite defines these variables as test knobs (Git `t/README`). `GIT_TEST_SPLIT_INDEX=1` split a private candidate in research R3 probe 9.

These policies build the environment of Git for Windows. A `wsl.exe` process gets an empty `WSLENV`, so no Windows variable reaches Linux Git (§11 "Trust and environment").

Every policy (`probe`, `read`, `mutation`, and `network`) preserves `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, and `GIT_CONFIG_NOSYSTEM` unchanged from the service environment. These variables select which global and system files Git reads (Git `Documentation/git.adoc`). Removing them would change the user's effective configuration (FR-003).

Every policy also preserves `GIT_CONFIG_COUNT`, each `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`, and `GIT_CONFIG_PARAMETERS`. Git reads them as `command` scope, which is protected configuration (Git `Documentation/git-config.adoc`). Every policy also preserves `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_AUTHOR_DATE`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`, `GIT_COMMITTER_DATE`, and `EMAIL`. They override configured identity, so their removal would change identity (FR-003). The `probe` and `read` policies remove `GIT_CONFIG`. It redirects only `git config`, so it would hide local keys from the trust listing (research R7). The `mutation` and `network` policies preserve it for hooks.

Every policy (`probe`, `read`, `mutation`, `mutation-trace2`, and `network`) sets `GIT_TERMINAL_PROMPT=0`. Git then never prompts on a terminal (Git `Documentation/git.adoc` `GIT_TERMINAL_PROMPT`). §6 "Console and input" states the full rule. The `network` policy serves only the `updateSubmodules` clone, connect, fetch, checkout, and register processes (§12). It equals `mutation` without `GIT_INDEX_FILE`, plus `GIT_PROTOCOL_FROM_USER=0`. Git's submodule command sets that value for its own children (git-submodule.sh:29-30). The app's own fetch step needs it to keep Git's transport policy (§12 "Environment and console"). No policy sets or removes `GIT_SSH_COMMAND` or `GIT_ALLOW_PROTOCOL`. No other policy sets or removes `GIT_PROTOCOL_FROM_USER`.

A trace2 event target comes only from the T091 probe result (research R4). The probe checks whether trace2 events identify hook and signing children. Without that probe result, no policy adds a trace2 variable. With it, `git-environment.json` adds the fixed policy `mutation-trace2`, which is `mutation` plus a trace2 event target. `GIT_TRACE2_EVENT` overrides a user's `trace2.eventTarget` (Git `Documentation/config/trace2.adoc`). So the service selects `mutation-trace2` only in one case. The service environment has no `GIT_TRACE2_EVENT`, and the effective configuration has no `trace2.eventTarget`. Otherwise it selects `mutation`, and hook and signing failures stay `GIT_FAILED` with a recorded reason.

**Missing objects.** A partial clone fetches a missing object on demand. That fetch runs the transport program that repository configuration names, such as `remote.<name>.uploadpack`. A research R5 probe saw `status`, `diff-files -p`, `diff-index --cached -p`, `ls-files --eol`, and `commit` run such a canary without trust approval. So every Git command that the app starts passes the global option `--no-lazy-fetch` first. This covers discovery, the trust listing, reads, reconciliation reads, `applyHunk` and `applyFile` steps, `commit`, and every `reviewSubmodules` and `updateSubmodules` command. Reads also pass `--no-optional-locks`.

- Exception: three probes run without `--no-lazy-fetch`. They are the `gitProbe` `--exec-path` and `version --build-options` (§6), and the WSL `--version` (§11 "Git per distro"). Git added the option in 2.45.0 (Git `Documentation/RelNotes/2.45.0.adoc`). An older Git rejects it with "unknown option" (research R13 P3). With the option, the `GIT_UNSUPPORTED` refusal could not name the found version. These probes run outside any repository: from the application-owned launch directory, or from `/` in a distro. They open no repository and fetch nothing.

- `--no-lazy-fetch` sets `GIT_NO_LAZY_FETCH=1` for every Git child, hooks included (research R5). An approved hook cannot fetch objects during an app operation. This differs from command-line Git. A hook that fails for this reason shows its message in the commit failure output (§9).
- Object check: the service decides that a promisor remote exists exactly by Git's rule in `promisor-remote.c` `promisor_remote_config`. It splits each key as Git's `parse_config_key` does:
  - `remote.<name>.promisor=true` names the promisor `<name>`. The two-part key `remote.promisor=true` names the promisor `""`.
  - `remote.<name>.partialclonefilter` also names the promisor `<name>`.
  - `extensions.partialclone` counts only from `<commondir>/config`, and only when `core.repositoryformatversion` is set. The service decides that origin by comparing file identities from the §6 identity request, never by path text. An unknown identity makes the promisor answer unknown, and the read ends `GIT_FAILED`.
  - A name that starts with `/` names no promisor. In such a repository, a failed read or mutation step starts an object check. The service runs `cat-file --batch-check` with `--no-lazy-fetch`. Its input holds the object IDs that the step read or named: HEAD tree and index entries within the §5 listing caps, or history commit IDs. For history, the input also holds the raw parents of each commit that the shallow file does not list. The raw parents of a commit in the shallow file stay out. When the shallow file read reached its §5 bound, all raw parents stay out. Raw parents are check input only and never display data. A `missing` answer gives `OBJECT_MISSING` (§9). Otherwise the failure stays `GIT_FAILED`. The service never parses the Git message.
- A read that needs a missing object ends `limited` with `OBJECT_MISSING` and blocks dependent mutations. A status read gives a refusal without entries. A history read keeps its bounded rows, also in a partial clone. The status result form and the history result form do not change.
- A mutation step before publication or handoff fails with `OBJECT_MISSING`, and no data changes. After handoff, reconciliation classifies the result from observed state, and the exit status alone decides nothing. The commit passes `--quiet`, so Git prints no summary after the commit. Without it, a research R5 probe saw a commit move HEAD, run `post-commit`, and then exit 128 in its summary. With `--quiet`, the same case exited 0 and ran every hook.
- The `OBJECT_MISSING` remedy text is: "This partial clone lacks objects that Git needs here. Arbareto never downloads objects. Download them in a terminal, for example with git backfill, then use Refresh."
- Damaged object store: a failed history read without a promisor remote also runs the object check. A `missing` answer in a repository without a promisor remote means a damaged object store. The read ends `failed` with `REPOSITORY_UNAVAILABLE`, and its text suggests `git fsck`. `recoveryState` becomes `unavailable` (data-model §2), and the incomplete read keeps dependent mutations blocked.

Trust discovery includes traditional hooks, configured hook commands/events, conditional includes, worktree configuration, filters, monitors, diff tools, and signing programs.

**Value display allowlist.** `readTrust` shows a configuration value only for a key on this closed list. The list holds `filter.<driver>.clean`, `filter.<driver>.process`, and `filter.<driver>.smudge`. It holds `core.fsmonitor`, `core.hooksPath`, and `hook.<name>.command`. It holds `diff.<driver>.textconv`, `diff.<driver>.command`, and `diff.external`. It holds the signing keys `gpg.program`, `gpg.<format>.program`, and `gpg.ssh.defaultKeyCommand` (Git `Documentation/config/gpg.adoc`). Every other entry is opaque, and `readTrust` shows only its key, scope, and origin. Examples are `http.extraheader`, `user.signingkey`, and a remote URL with user information. The `include.path` and `includeIf.<condition>.path` values stay hidden on purpose, and their origins stay visible. Trust resolution uses origins, not include values.

**URL user information.** A key subsection can hold a URL with credentials. Examples are `url.<base>.insteadOf`, `http.<url>.extraheader`, `credential.<url>.helper`, and `includeIf.hasconfig:remote.*.url:<pattern>.path`. Git prints these subsections unchanged (research R5 probe). So the service redacts every key subsection, origin, and allowlisted value before display or logging. For each `://` in the text, the authority runs to the next `/`, `?`, `#`, or the end. When that authority holds `@`, all text before its last `@` becomes `<redacted>`. Git's `transport_anonymize_url` also removes the user information of a URL for display (research R5). The trust fingerprint covers the unredacted bytes, and no response carries them.

Do not execute a custom filter merely to determine whether the repository is trusted. Before the first status read, list effective configuration with scopes. The listing includes `command` scope entries from the preserved environment. The trust fingerprint covers them. This listing runs no filter and loads no index. A repository-controlled key (resolution rule below) can define a command that a read runs. Such a key blocks status, diff, and history reads until trust approval. History reads cannot run these keys (list below). Their results still wait for the same approval, so one read gate covers the workspace. The trust gate runs before any comparison limit check (§4 "Comparison limits"). `readHistory` takes the listing of its request generation when the service holds one ("Shared listing" below). Otherwise it runs the listing itself. It waits for no status step, only for a running listing of its generation. System, global, and command entries are protected configuration (Git `Documentation/git-config.adoc`). They run without approval, unless the resolution rule makes them repository-controlled.

The blocking class is any repository-controlled key that names a command a read can run. This slice reads through `status --porcelain=v2`, `diff-files`, `diff-index --cached`, `ls-files --eol`, `rev-list`, `cat-file --batch-command`, and `cat-file --batch-check`. The untracked read is the T092 form `diff --no-index --no-ext-diff --no-textconv --no-color --src-prefix=a/ --dst-prefix=b/ -- /dev/null <path>` (§4). The patch reads `diff-files -p` and `diff-index --cached -p` carry `--no-relative --src-prefix=a/ --dst-prefix=b/ --ignore-submodules=dirty` (research R3 "Untracked hunk content"). The binary reads are `diff-index --cached --numstat -z --no-textconv --no-ext-diff --no-relative --ignore-submodules=dirty <tree> -- <path>`, `diff-files --numstat -z --no-textconv --no-ext-diff --no-relative --ignore-submodules=dirty -- <path>`, and `diff --no-index --numstat -z --no-ext-diff --no-textconv --no-color -- /dev/null <path>`. A record with two `-` fields gives reason `binary` (git-diff(1) `--numstat`). `config --blob <object ID>` and `config --blob <commit>:.gitmodules` load no index. `config --blob :.gitmodules` loads the index. In a probe of 2026-10-08 it ran a command-valued `core.fsmonitor` canary, and with `true` it started `git fsmonitor--daemon`. So no read uses the `:<path>` form. Reads also run `check-attr -z --stdin`, `hash-object -t tree --stdin` without `-w`, and `config --file .gitmodules --null --list`. For those commands, the listed keys behave as follows:

- `filter.<driver>.clean` and `filter.<driver>.process` can fire. `status` and `diff-files` run the clean conversion on stat-dirty working files. `diff --no-index` ran the clean filter in a research R5 probe, also with both flags.
- Command-valued `core.fsmonitor` can fire. Every command that loads the index can run it, including `status`, `diff-files`, `diff-index`, and `ls-files`. `rev-parse --shared-index-path` also loads the index. It ran the monitor in a research R2 probe, so no read or discovery step uses it.
- `core.fsmonitor=true` names Git's built-in daemon, not a repository-defined command. It does not block reads from any scope. When no daemon runs, a command that loads the index can start `git fsmonitor--daemon` (research R3). That daemon is an owned descendant of the read's operation Job, and Job close ends it (unverified). A daemon that a `commit` starts stays in a lingering Job until application close (§6 "Lingering Jobs"). A daemon that runs outside the app is unrelated and keeps running. Hunk actions still refuse this profile (§4).
- `filter.<driver>.smudge` cannot fire. Git runs it only when it writes working files.
- `filter.<driver>.required` names no command. It makes a clean failure fatal.
- `diff.<driver>.textconv`, `diff.<driver>.command`, and `diff.external` cannot fire. Plumbing diffs run them only with explicit `--textconv` or `--ext-diff`. Porcelain `diff` and `log -p` can run them, and supported inspection disables them. `diff --no-index` ran `diff.external` without `--no-ext-diff` and `textconv` without `--no-textconv` (research R5). So any `diff` form carries both flags.
- `rev-list`, `cat-file --batch-command`, and `cat-file --batch-check` without `--filters` or `--textconv` run none of these keys.
- `diff --no-index` loaded no index and ran no `core.fsmonitor` canary in that probe.
- `check-attr` loads the index, so a command-valued `core.fsmonitor` can fire. It ran the monitor canary in a research R5 probe of 2026-10-01. It runs no filter and no diff driver.
- `hash-object -t tree --stdin` and `config --file .gitmodules --null --list` load no index and run no filter. Neither ran a canary in that probe.
- `hash-object --stdin --path=<path>` is no read. Only the `stage` blob proof runs it (§4 "Blob proof"). It ran the clean filter of its path in that probe. So `stage` refuses a path with a `filter` attribute before any proof runs.

Status and diff reads pass `--ignore-submodules=dirty`. Superproject reads never start Git inside a submodule. The scoped listing above cannot see a submodule's local configuration, so the gate cannot cover it. The superproject view shows a changed submodule commit, not changes inside the submodule. One exception exists: `reviewSubmodules`, and the preflight, level reads, checks, and reconciliation of `updateSubmodules`, run fixed commands inside submodules. They cover initialized submodules and kept submodule Git directories (§12 "Review reads"). None of them loads an index or runs a repository program, with one exception. The nested active-set read of §12 "Plan" loads the index of a parent submodule. It runs only after the §12 step 3 decision. The program list of that run covers the `core.fsmonitor` that it can start. The §12 submodule program list covers submodule configuration and hooks. It also covers relative values from every scope that resolve inside a submodule worktree.

Keys that cannot fire for these reads do not block reads. Ordinary trust discovery still covers them before any operation that can run them.

**Protected programs that change trust.** A protected program can write local configuration and hooks during a read. Example: the Git for Windows system configuration names `git-lfs filter-process`, a system-scope filter. During the first status read, it writes `lfs.repositoryformatversion` into the local configuration and installs four hooks. The fingerprint then changes, so the next read ends `TRUST_CHANGED`. This result is correct. The user approves the new fingerprint, and the next read passes (fixture F05).

**Shared listing.** Only `readHistory` may reuse a trust listing (research R5 "T281 record"). It reuses the listing that a `readWorkspace` of the same generation runs or ran, after the tuple recheck below.

- `readWorkspace` always runs its own listing. It can start gated programs, such as filters and `core.fsmonitor`, so its trust decision never relies on stat data.
- A listing belongs to the generation of the read that started it. For a `readWorkspace` without a request generation, that is the generation of its result.
- The service never reuses a listing for another generation.
- Before `readHistory` reuses a listing, the service reads the §8 change tuple again. It compares it with the tuple from the time of that listing. This compare starts no Git process.
- The service reads the tuple of a listing before that listing starts. So an edit during the listing changes the compare result.
- Any tuple difference needs a new listing. The tuple holds each configuration origin file and each absent candidate file (§8 "Change check"). So a configuration edit or a new configuration file forces a new listing.
- A `readHistory` that finds that listing still running waits for it.
- The first read after registration shares no listing with `readHistory`, because no tuple exists before its listing. The first `readHistory` runs its own listing.
- A WSL repository never shares a trust listing, and each WSL read runs its own listing. The service has no tested stat tuple for distro configuration files (§11 "Trust and environment").
- In the T281 probe, a history read with a stale listing passed its gate after a local `core.fsmonitor` edit. A fresh listing gave `TRUST_CHANGED`. So the tuple compare is required.
- The shared listing removes 2 Git processes from a `readHistory` that reuses a listing.

**Held history steps.** `readHistory` can start its history steps beside the trust listing (research R5 "T281 record"). They start before the gate decides.

- The held steps are `rev-list` and `cat-file --batch-command`. They also include the HEAD capture (`symbolic-ref`, `rev-parse --verify`) and the `rev-parse --git-path shallow` read. A failed `rev-parse --verify` decides nothing. It only leads to `show-ref --exists`, whose exit status alone decides unborn (2) or present (0) (§6 "Registration bootstrap").
- They pass `--no-lazy-fetch` ("Missing objects"). `rev-list` and `cat-file` without `--filters` or `--textconv` run no blocking key (list above).
- The service holds their output and releases it only after the gate passes.
- A refused gate (`TRUST_REQUIRED` or `TRUST_CHANGED`) ends every held step that still runs. The service discards all held output and starts no object check.
- The refused response comes from the gate code only. No held row reaches any response.
- In the T281 probe, no canary ran before the gate, and no held row reached a refused response.

**Repository-controlled resolution.** An executable integration is repository-controlled when any of these holds:

- Its entry has scope `local` or `worktree`.
- Its origin file from `--show-origin` lies inside the worktree root, the Git directory, or the common directory. This covers includes of repository files.
- It is a configured hook, and its `hook.<name>.command` entry meets one of the two rules above ("Hook registrations"). A configured hook whose `hook.<name>.command` entry the listing cannot classify counts as repository-controlled.
- It is a hooks-folder hook ("Hook registrations"), and the hooks directory lies inside one of those directories. `rev-parse --git-path hooks` prints the effective directory, including `core.hooksPath`, relative to the Git working directory. Resolve it against the directory where Git ran. A relative `core.hooksPath` from any scope resolves inside the worktree.
- Its program lies inside one of those directories. Git runs hook, filter, and monitor commands from the worktree root. A program path with `/` or `\` that is not absolute resolves against that root.
- Its program is a bare name, and the child `PATH` holds a relative entry. Then every bare-name program needs trust, Git LFS included. On POSIX, an empty entry is the current folder, so it counts as a relative entry. On Windows, Git for Windows skips an empty entry, so it is no relative entry. An explicit relative entry, such as `.`, counts on both platforms. A Windows probe with Git 2.56.0.windows.1 confirmed both Windows facts, for the shell form `foo %f` and for the plain form.

**Inside and outside.** The roots are the worktree root, the Git directory, and the common directory. These rules decide whether a path lies inside them:

- A path from repository-controlled scope is repository-controlled. The service inspects it only through `fileFacts` below a root (§6 "File facts"). It never reads such a path outside the roots. The only exception is the identity request below.
- A path from protected scope that lies under a root by text is walked with `fileFacts`.
- A protected path outside every root by text gets an identity request (§6 "Process fields"). The request covers the path and its existing ancestors. UNC and device paths are refused by text first. Such a path gets no identity request, and it stays in the fingerprint as a location only.
- Alias detection needs identities. So the placement rule may send an identity request for any local or mapped-drive path outside every root, whatever its scope. The identity request reads only attributes (§6 "Process fields"). A UNC or device path never gets one.
- An identity equal to a root identity means inside. The service maps the path to that root plus the remaining components and walks it with `fileFacts`.
- Otherwise the path is outside: protected, location only.
- So a junction alias of the worktree never makes tracked hook files run without approval.
- By text, a path lies under a root when its components start with the components of the root. On Windows, the comparison folds only the ASCII letters `A` to `Z` (§6 "Startup contexts" case rule). The longest matching root wins.
- One identity request carries at most 8 paths, so a long ancestor chain needs more than one request. In a WSL repository, the §11 identity probes give the identities. The UNC refusal does not apply there (§11 "Paths and file access").

The rule classifies the program that Git starts. A protected command can still read repository files through its arguments. That behavior stays the user's configured choice (research R5).

No unknown gets the protected default. A lookup miss that the rules make impossible is a service fault. The listing then fails. A configuration key from Git output is data. The service never uses it as a property name of a plain object.

**Hook registrations.** The trust listing runs no `git hook list`. It starts 2 Git processes, not 30 (research R5 "T280 record"). These are `config list --show-scope --show-origin -z` and `rev-parse --git-path hooks`. The service derives the hook registrations in TypeScript from their output by the T280 rules. These rules cover the repeated-registration order, empty `event` values, `enabled` values, and event switches. In the T280 probe, the derivation matched `git hook list -z --show-scope` in all 12 cases.

- Classify each configured hook by the scope and origin of its `hook.<name>.command` entry, never by its `hook.<name>.event` entry. A repository-controlled command entry needs approval for every operation that can run its event, whatever scope the event entry has. `git hook list --show-scope` reports the scope of the last `event` entry. Git runs the last `command` value from any scope.
- A hooks-folder hook is the entry `<event>` in the hooks directory, for each of the 28 known events. Git for Windows also tries `<event>.exe` when `<event>` is absent. On Windows, Git lists an entry that exists, a folder included. On POSIX, Git lists the entry only when it has the execute bit.
- A non-boolean `hook.<name>.enabled` value follows the result of Git 2.56 for Windows. When Git exits nonzero for it, the derivation records `fatal`, as for the other fatal cases of research R5 "T280 record". `fatal` means that every `git hook` call and hook run fails, so no configured hook runs.
- The service reads the hooks directory and its entries only through phase-1 `fileFacts` ("Program file digests"). The fact table there decides whether an entry counts as a listed hook.
- A hooks directory that lies outside every root lists no entries. So does one whose link resolves outside the roots or cannot be resolved. `readTrust` then shows no hook from that directory, whether its `core.hooksPath` entry is repository-controlled or protected. The service never opens such a directory. It sends the listing request only for a directory inside a root. The location of such a directory and each hop's target text stay in the fingerprint. The fingerprint fields are `hooksDirectory`, then one `hooksFolderHop` field with the target text of each hop. A link that resolves outside the roots adds `hooksFolderResolved` with its resolved location. A link that cannot be resolved adds `hooksFolder: "unchecked"` and sets bound `link`, so the approval is session-only. When its `core.hooksPath` entry is repository-controlled, or the directory lies inside a root, `approvalRequired.commit` is `true`. A repository-controlled `core.hooksPath` sets this flag whether or not the listing finds a hook. Unknown never becomes "no hooks".

**Configuration file paths.** Two commands give the system and global candidate files of §8 "Change check". They are `git var GIT_CONFIG_SYSTEM` and `git var GIT_CONFIG_GLOBAL` (git-var(1)). The service runs them once per admitted Git installation, in that order, and keeps the result with that installation. They run in the `gitProbe` context after the admission checks pass (§6 "Registration bootstrap"). The trust listing itself still starts 2 Git processes ("Hook registrations").

- Exit 0 prints one path per line. Git prints a path also when the file does not exist (git-var(1)). Each line is a candidate, kept as printed.
- `GIT_CONFIG_GLOBAL` can print two lines: the XDG file and the user file.
- Exit 1 with empty stdout and empty stderr means that Git reads no file of that kind (Git `builtin/var.c` `cmd_var`). It is no failure. `GIT_CONFIG_NOSYSTEM` gives this result.
- The probe stops at the first other result: another nonzero exit, exit 1 with any stdout or stderr byte, or output that the parse rejects. That result refuses the Git installation with `GIT_UNSUPPORTED`, the existing admission refusal (§3 "Git proposal", §6 "Startup contexts"). It never gives an empty candidate set.
- A WSL installation runs no `git var`, because WSL polls use no stat tuple (§11 "Trust and environment").

**Program file digests.** The trust fingerprint also covers the bytes of repository-controlled program files. So an edit of an approved hook or program file gives `TRUST_CHANGED`.

- The service covers each file that a repository-controlled integration names by path. These are the hooks-folder entries from "Hook registrations". They are also program paths that are absolute or hold `/` or `\`. It resolves each path by "Repository-controlled resolution" and "Inside and outside".
- The service never stats, opens, or reads such a path itself. It sends `fileFacts` requests (§6 "File facts") only for paths inside the roots. A path outside the roots stays in the fingerprint as a location only.
- Phase 1 sends `digest: false`. It reads the hooks directory, each `<event>` with its `<event>.exe` on Windows, each bare-name candidate, and each program path. A list above 64 entries takes more than one request.
- Link resolution runs in TypeScript, one hop at a time, at most 8 hops (§5), and only inside the roots. A relative target resolves by text against the folder of the link. It may start with a run of `..` components, and no `..` may follow a normal component. An absolute target `\??\X:\…` maps to `X:\…`. The components of the entry after the link follow the target. The result is a new phase-1 entry.
- A link whose resolved target is exactly a root gives a `directory` fact.
- A program or hook path inside a root can break the §6 component rule (`isComponent`), for example with more than 255 UTF-16 units or a trailing period on Windows. The service sends no `fileFacts` entry for it. It enters the fingerprint as `unchecked` with bound `name`, so the approval is session-only. It never fails the listing.
- A link cannot be resolved when its target holds `..` after a normal component, or when it is root-relative or drive-relative. The same holds for a `\??\UNC\` target or another NT path, a component that breaks the §6 rule, tag `other`, and a chain above 8 hops.
- Phase 2 sends `digest: true` for the resolved files inside the roots, in fingerprint order, in one request.
- The fact after resolution decides the fingerprint value and the hook listing:

| Fact after resolution | Fingerprint value | Listed as a hook |
| --- | --- | --- |
| `file` with `digest` | The digest. | Yes. On POSIX, only with `executable`. |
| `file` with `bound` | `unchecked` with that bound. | Yes. On POSIX, only with `executable`. |
| `directory` or `other` | `absent`. | On Windows, yes. On POSIX, only a `directory` with `executable`. |
| `absent` | `absent`. | No. |
| A link that resolves outside the roots | The location and each hop's target text. | Yes. |
| A link that cannot be resolved | `unchecked` with bound `link`, and each hop's target text. | Yes. |
| `error` | None. The listing ends `failed` with `REPOSITORY_UNAVAILABLE`. | None. |

- Only an `absent` fact means absent. An `error` fact ends the listing `failed` with `REPOSITORY_UNAVAILABLE`. The text names the path and the `code`, never an OS message text.
- Unknown never becomes "no hooks". An entry without a link keeps byte-identical fingerprint fields, so old approvals stay valid.
- A bare-name program has no path. Its name and the child `PATH` entries stay in the fingerprint. Git for Windows skips empty `PATH` entries. On POSIX, an empty entry is the current folder, so it is a relative entry ("Repository-controlled resolution"). For each other entry in order, it tries `<entry>\<name>.exe`, then `<entry>\<name>` when that is not a directory (research R5). When the child `PATH` holds relative entries, the service repeats that lookup in each of them. Each relative entry resolves against the worktree root. Git starts hooks, filters, and monitors from that root. The service reads each candidate inside the roots with phase-1 `fileFacts`. A candidate outside the roots stays a location only. On POSIX, a candidate counts only when its `file` fact has `ownerExecute: true`, the owner execute bit `S_IXUSR` (Git `run-command.c` `is_executable`, §6 "File facts"). A Windows rule for this check is not decided here. The first counted `file` fact gets a digest in phase 2. Without one, each relative entry enters the fingerprint as `absent`, so creating such a file gives `TRUST_CHANGED`. The lookup uses the same rule: only an `absent` fact means absent, and an `error` fact ends the listing `failed`. An earlier absolute entry can hold the same name, and Git then starts that file. The digest still covers the repository candidate, so this case errs toward `TRUST_CHANGED`.
- Bounds: the shell applies 1 MiB per file and 8 MiB per request (§6 "File facts"). Phase 2 carries at most 64 files. Only `file` facts count toward this 64-file bound. A file with bound `file-bytes` or `total-bytes` enters the fingerprint as `unchecked` with its path. So does every file after the 64-file bound. T192 and T169 measure the poll cost with these digests.
- The `bound` names map to the §5 "Trust program file digests" row: `file-count` is 64 files, `file-bytes` is 1 MiB per file, and `total-bytes` is 8 MiB total. `link` is a link that cannot be resolved, including a chain above 8 hops. Its confirmation text is "a link that Arbareto cannot follow". `name` is a path inside a root that breaks the §6 component rule (bullets above). Its confirmation text is "a file name that Arbareto cannot check" (`src-tauri/src/dialogs.rs` `bound_text`).
- Over a bound, `readTrust` reports the reached bound and `persistence` `session`. `approveTrust` still accepts an explicit approval. Its `confirm` frame carries `persist: false`. The native confirmation names the reached bound and states: "Arbareto cannot check these program files for later edits. This approval lasts until Arbareto closes or its Git service restarts." On Approve, the shell writes no record. The service keeps the approval for the service session. The session ends when Arbareto closes or at Restart service (§2). An edit of an `unchecked` file keeps that session approval, and the confirmation says so. The next session reports `untrusted`, also after Restart service.
- Reading a program file runs nothing. The stored record keeps one fingerprint digest, so the record format stays unchanged.

**Submodule registration keys.** The fingerprint omits `submodule.<name>.url`, `submodule.<name>.active`, and each `submodule.<name>.update` value that does not start with `!`. Git's submodule initialization writes these keys into the parent's local configuration (research R14 probes S1 and S5). None of them names a program. So an `updateSubmodules` run keeps a stored approval valid, and no approval loop starts. A `submodule.<name>.update` value that starts with `!` names a command and stays in the fingerprint. The §12 review shows every URL, redacted, before the start.

**Mutation trust.** A mutation needs approved trust only when it can run a repository-controlled integration (Constitution V, FR-025).

- `commit` needs approval when the fingerprint lists such an integration that `git commit` can run. These are hooks for `pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit`, `post-index-change`, `reference-transaction`, and `pre-auto-gc`. They also include signing programs, clean filters, and command-valued `core.fsmonitor`. The signing programs are `gpg.program`, `gpg.<format>.program`, and `gpg.ssh.defaultKeyCommand`. Git runs `gpg.ssh.defaultKeyCommand` when SSH signing has no `user.signingKey`, and a research R4 probe observed it during `commit`.
- `applyHunk` runs `apply --cached`, `hash-object --no-filters`, `read-tree`, and `ls-files` on a private index, each with `--no-lazy-fetch`. Its supported profile refuses index-change hooks, executable monitors, and custom filters (§4). So `applyHunk` runs no repository-controlled program. It needs approval only when its reads need it.
- `applyFile` runs `update-index`, `read-tree --empty`, `ls-files`, and `cat-file --batch-check` on a private index, each with `--no-lazy-fetch`. The §4 "Blob proof" adds `cat-file --filters --path` and `hash-object --stdin --path` without `-w`. On a private index, `update-index` still ran a command-valued `core.fsmonitor` and a `post-index-change` hook (research R3). The profile refuses both, and `stage` refuses a path with a `filter` attribute (§4 "File staging"). So `applyFile` runs no repository-controlled program. It needs approval only when its reads need it.
- `updateSubmodules` needs the superproject approval only when its reads need it. Its clone, connect, checkout, and register processes load the superproject index, so a command-valued `core.fsmonitor` runs (research R14 probe S3). The read gate already covers that key. It refuses a `submodule.<name>.update` value that starts with `!` (§12 "Refusals"). Programs inside submodules need the §12 run confirmation instead, which stores nothing.
- A changed fingerprint gives `TRUST_CHANGED` at every checkpoint, also without required approval.
- Without required approval, the next `readWorkspace` observes the new fingerprint. A new selection or review then clears `TRUST_CHANGED`.
- With required approval, trust `state` becomes `changed`. Only an approval of the new fingerprint clears it. A new selection or review follows.
- Without required approval, a stored record with another fingerprint keeps trust `state` `changed` for display only. It blocks no read, hunk or file control, or mutation. The record stays. So renewed approval still applies when an approval becomes required again (FR-025).
- `readTrust` returns `approvalRequired` separately for reads and for `commit`.

Missing approval never disables a hook. A mutation that needs approval refuses with `TRUST_REQUIRED` before any process starts. It refuses with `TRUST_CHANGED` when trust `state` is `changed`.

**Trust approval store.** Approval persists across launches (spec Clarifications, 2026-09-30). The shell stores one record for each worktree in the `trust` folder of the application data directory. The fingerprint is per worktree, because worktree configuration, relative program paths, and a relative `core.hooksPath` resolve per worktree. A record holds the Git-resolved common-directory path and its `FileIdInfo` identity. It also holds the Git-resolved worktree root and administration-directory paths and their `FileIdInfo` identities. These identities form the worktree identity (data-model §2). It also holds the approved fingerprint, the approval time, and `gitSelectedPath`, the selected Git path (`selectedPath`, data-model §1). The record does not bind the Git executable digest. A Git upgrade behind the same selected path keeps each stored approval valid (§6 "Startup contexts"). A different selected path gives `changed`, and the user must approve again. It holds no configuration value, command text, environment value, or credential. The fingerprint is the digest that `readTrust` returns. Each startup handshake carries every record. The service sends three `trust` frames:

- `confirm` with the worktree path, the worktree administration-directory path, the common-directory path, the selected Git path, the fingerprint, and `persist`. The service sends the `selectedPath` of the current Git selection (data-model §1). For a WSL repository, the frame and the stored record carry the UNC form of the approved Git path instead (§11 "Trust and environment"). The shell reads the common-directory identity and the worktree identity itself. It shows a native confirmation that names the worktree path and the fingerprint. With `persist: false`, the frame also carries `bound`. The dialog then shows that bound and the session-only text from "Program file digests". Its buttons are Approve and Cancel, and Cancel is the default. Enter on the default, Escape, Alt+F4, the close button, and a call failure mean Cancel. On Approve with `persist: true`, the shell writes and flushes the record. It replaces every record of the same worktree. A record is of the same worktree when both its common-directory identity and its worktree identity match. It is also of the same worktree when both its common-directory path and its worktree root path match. Records of other worktrees of that common directory stay unchanged. When that write or flush fails, the approval still holds for this service session only. The shell then replies `approved` with `stored: false` and without `record`. The service keeps a session approval, and `readTrust` reports `persistence` `session`. A failed write leaves the stored records unchanged. A record above 4 KiB (§5) gets the reply of a failed write, and the shell writes nothing. For this service session, the session approval takes precedence over a stored record of the same worktree. The UI shows the next notice only when the `approveTrust` result has `saveFailed: true`. With `persist: false`, the UI shows the session-only text from "Program file digests". The UI states that the approval holds only for this session: "Arbareto could not save this approval. This approval lasts until Arbareto closes or its Git service restarts." The second sentence is the session-only text from "Program file digests". With `persist: false`, it writes no record and deletes every record of the same worktree, because none matches the new fingerprint. Then it replies `approved`. Otherwise it replies `declined`, and `approveTrust` ends `canceled`. An `approveTrust` that completes after a release of its workspace sets no approval and returns `UNKNOWN_TARGET` (§6 "Registration reuse and release"). Accepted gap: with `persist: true`, the shell has already written the confirmed record. A later session uses that record only when the stored fingerprint matches, because the user confirmed that state.
- `revoke` with the common-directory path. The shell reads the identity of that path. It deletes every record whose common-directory identity or path matches, for every worktree of that common directory. It also closes every lingering Job with that identity tag (§6 "Lingering Jobs"). Then it replies with the count of processes that the close ended. `revokeTrust` then invalidates the trust ID and returns that count.
- `confirmRun` with the worktree path, the submodule paths, and the count of listed submodule programs. It also carries the count of `unchecked` entries (§12 "Trust"). The shell shows a native confirmation with the §12 text. Its buttons are Run and Cancel, and Cancel is the default. Enter on the default, Escape, Alt+F4, the close button, and a call failure mean Cancel. Run replies `approved`, and any other result replies `declined`. The shell writes, replaces, and deletes no record.

The service derives trust `state` from the records and from its session approvals. A record matches when its common-directory identity and its worktree identity equal those of the workspace. `approved` needs a matching record, or a session approval, with the same selected Git path and fingerprint. The service compares `gitSelectedPath` with the current `selectedPath` as native paths. The comparison follows the case rule of §6 "Startup contexts". A matching record with another selected Git path or fingerprint gives `changed`. So does a record with the same common-directory path and worktree root path but another identity. A different resolved path, version, or digest behind the same selected path does not give `changed`. No record gives `untrusted`. A revoked trust ID gives `revoked`.

Do not disable required hooks to obtain a successful result. Do not add an application-owned hook without approved scope changes.

Logs stay in memory for the session, with at most 1,000 entries (§5 "Session log entries"). This slice writes no log files. Logs contain only allowlisted operation kinds, internal IDs, durations, safe codes, diagnostic causes, counts, and reconciled effect summaries (data-model §7 `effects`). The optional `cause` field carries the diagnostic cause of an operation. Its value is a §9 step cause (`lock-create`, `candidate-copy`, `candidate-time`, `publish-time`, `verification`, `write`, or `replace`) or an `ErrorCode` (§9), such as the code of a failed reconciliation observation (§8). When reconciliation fails, the observation's code is the `cause`. Otherwise the §9 step cause is the `cause`, then the recorded `DEADLINE` or `OUTPUT_LIMIT` cause. It never holds a path, text, or repository content. Do not retain raw stderr, hook output, messages, patches, environment blocks, or configuration dumps. Only `outputTail` fields carry Git or hook output: the commit failure output, the `stage` output, and the discovery refusal (§9), and each submodule output tail (§12). An `outputTail` never enters a log, a `diagnostic`, or a progress event.

Provide actionable safe explanations. Full repository-specific diagnostics remain available through the user's selected Git tools, not unrestricted automatic log export.

## 8. Freshness, cancellation, and outcome semantics

Snapshot-bound requests carry `repositoryGeneration`. Selection-dependent reads also carry `selectionId`. Discard obsolete display results without hiding operation completion notifications.

Changes invalidate approvals before replacement views arrive. A pending read cannot preserve an old mutation capability.

**Token invalidation.** The observation fingerprint is HEAD, `indexFingerprint`, `policyFingerprint`, and `operationState` (data-model §4). It also holds the `workingVersions` that a token binds. These rules define "refresh" and "relevant state change" in data-model §6:

- A `readWorkspace` call with `refresh: true` invalidates every dependent token.
- A `refresh: false` read whose fingerprint differs from the issued one invalidates every token that depends on it.
- A `refresh: false` read with an unchanged fingerprint keeps issued tokens.
- A watcher hint marks the workspace dirty, so the next read re-reads Git state. The hint alone invalidates no token.
- A complete read that records an observation different from the retained one advances `generation`. This holds also for a change of working files alone. An equal observation keeps the generation.
- A token that these rules keep still needs the current generation at acceptance (§9).
- Service restart and successful consumption invalidate tokens as data-model §6 states.
- After a hunk approval expires or becomes invalid, the renderer issues `readComparison` again for the same entry. It keeps the diff scroll while the canonical comparison stays unchanged. It keeps the hunk selection only when the new comparison has a hunk with the same canonical hunk digest. Otherwise the selection clears with a notice. The §4 publication rechecks stay unchanged.
- After a file approval expires or becomes invalid, the renderer issues `readComparison` again for the same entry. It keeps the file selection while the entry keeps its category. The §4 "File staging" rechecks stay unchanged.

**Change check.** A `readWorkspace` with `check: "changes"` first compares a stat tuple with the one from the last complete read. WSL polls never use it (§11 "Change polling"). The tuple holds size, last-write time, and presence for a fixed file set:

- The index, in every ref format.
- The worktree `HEAD`, the ref file of the current branch, and `packed-refs`, for the `files` ref format. A full read resolves the path of the ref file with `git rev-parse --git-path <target>`, once per new HEAD target. The service keeps no list of ref prefixes.
- Discovery reports the ref format through `--show-ref-format`. For the `reftable` format, two files replace the `HEAD`, branch ref, and `packed-refs` entries. They are `reftable/tables.list` in the worktree administration directory and in the common directory. For the main worktree, both paths name one file. Git rewrites this stack ordering file by rename on every ref update (gitformat-reftable(5)). `HEAD` is then a fixed stub, and no branch ref file or `packed-refs` exists. A ref update can keep the file size, so the tuple also holds the file content. A `tables.list` above 64 KiB counts as changed, so the read runs in full.
- Every configuration origin file from the last trust listing.
- The program-file entries: each phase-1 `fileFacts` entry of the last trust listing (§7 "Program file digests"). Each entry holds its root, its components, and its fact: the kind, `size` and `lastWrite` of a file, and the target text of each link hop. The check reads them again with phase-1 `fileFacts` requests (T088). Any difference in a fact changes the tuple.
- Each candidate configuration file that does not exist yet, with presence `absent`. Creating, removing, or changing any candidate changes the tuple.
- The candidates are the files Git reads. They are the system and global files (§7 "Configuration file paths") and the local `config`. The worktree `config.worktree` is a candidate when `extensions.worktreeConfig` is set.
- The candidates also include each `include.path` and `includeIf.<condition>.path` target that the listing names.
- The system and global candidates are the kept `git var` lines. Git applies `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_GLOBAL`, and `GIT_CONFIG_NOSYSTEM` to that output, so the service applies no override itself. The service resolves the other candidates as Git does (Git `config.c` `do_git_config_sequence` and `handle_path_include`). The local `config` lies in the common directory. `config.worktree` lies in the worktree administration directory. A relative include target resolves against the folder of the file that names it. A leading `~/` resolves against the home folder.
- The working file of the selected entry, from its `workingVersions` binding.
- New candidates: a listing can name a candidate that the tuple taken before that listing did not hold. The read then keeps no tuple. The next poll runs in full and takes its facts before its listing.

The check also compares the hint counter and the trust policy fingerprint with those of the last complete read. Any difference in the hint counter, the tuple, or the trust policy fingerprint runs a full read through the read gate (§7). The check starts no Git process. Without a watcher hint and with an equal tuple, the read returns the last snapshot. Its `snapshotId` and `generation` stay unchanged. Otherwise it runs a full read. A change check is a hint, not validation. Every mutation checkpoint still reads Git state (§4). This stat compares change hints only. Physical identity still comes from the §6 identity request.

**Watcher hints.** The service watches the worktree, the worktree administration directory, and the common directory. The debounce is trailing 100 ms, with a maximum wait of 1000 ms from the first event not yet delivered as a hint. A watch is lost when it fails to start, emits `error`, or its directory changes identity (`dev` and `ino`), or when a re-arm fails. The service checks that identity at most once per debounce interval. An event that arrives while an identity check runs schedules one more check after that check ends, still at most once per debounce interval. A `change` event with a null file name re-arms the watch of that directory: the service closes the watch, then watches the same path again. Otherwise that event counts as a hint. A failed re-arm is a lost watch, and no change hint follows it. Reason: on Linux, Bun 1.4.2 reports a removed or replaced watched root as one null-name event and then stays silent (C6 T297 probe). A buffer overflow also gives a null file name (research R5 "Watcher event source"). After a lost watch, every poll of that workspace runs in full until the workspace is registered again.

**Changing working file.** An atomic save can replace a working file while `readWorkspace` reads it. When a working-file read reports a change during the read, the service discards the partial result. It then runs the full read once more, and that result gets a new generation. Both attempts share one §5 "Ordinary read deadline". A change during the second read ends the read `limited` with `WORKTREE_CHANGING`. That result keeps the entries and working files that did read. A `limited` read is not a complete read, so the next `check: "changes"` poll runs in full. A token that binds the changed working file becomes invalid ("Token invalidation" above). `readWorkspace` never fails with `REPOSITORY_CHANGED` for this cause.

**Changing shallow file.** `readHistory` watches `.git/shallow` from its first shallow file read to the end of its object read (§3 "HistoryPage result"). One change in that window restarts the read once. The restart keeps the request generation, because a history page binds it. A second change ends the read `limited` with `WORKTREE_CHANGING`. `REPOSITORY_CHANGED` stays reserved for a generation mismatch at acceptance (§9).

**Late read.** A `readWorkspace` can find that a newer read already recorded an equal observation. It then records nothing. It returns the first page of the retained snapshot, with its `snapshotId`, `cursor`, and `generation` (data-model §4 "Status snapshot retention").

Cancellation means stopping further owned work, not undoing completed work. The terminal result can still be successful if the intended operation completed first.

After any mutation outcome, inspect actual HEAD target/OID, index, relevant working bytes, and operation markers. Unknown state blocks further mutations in the affected workspace.

**Observed locks.** After every reconciled outcome other than `succeeded`, reconciliation also checks a fixed set of lock files. For `commit`, this check follows handoff. They are the Git-resolved `index.lock` and `HEAD.lock` in the worktree administration directory. For the `files` ref format, they include the current branch ref lock and `packed-refs.lock` in the common directory. For `reftable`, they include `reftable/tables.list.lock` in both administration directories. The outcome names each existing one as foreign, with its path (§9 "Other locks"). A file check is an observation, not a cause. After `updateSubmodules`, the set also holds the superproject `config.lock`. It also holds the `index.lock` and `HEAD.lock` of each submodule Git directory in the plan (§12). The terminal result names foreign files in `foreign`, an optional array of Git-resolved paths. It is present only when not empty, on any terminal mutation state. The §8 set of the operation bounds its size. `applyHunk` and `applyFile` name at most 6 files: the 4 locks, the candidate, and the candidate `.lock`. `commit` names at most 4. `updateSubmodules` names at most 5 + 2 × 256 (§5 "Submodule review").

Distinguish `succeeded`, `completed-with-effects`, `failed-with-effects`, `canceled`, and `unknown`. A known checkpoint mismatch after acceptance ends `failed` with its checkpoint code, not `completed-with-effects`, because `rejected` applies only to a refusal at or before acceptance with no Git process (§9).

A published hunk or file, or a created commit, with differing observed state is completed-with-effects when execution completed. An execution failure with observed changes is failed-with-effects. Neither is `succeeded`; preserve the draft and show grounded commit identities. After a cancel, an index that matches neither retained digest still gives `canceled`. The service did not publish.

Late cancellation can still produce `succeeded` or `completed-with-effects`. Reconcile before classification; cancellation is never an undo command.

**Cancellation during reconciliation.** Git has exited, but its descendants can still run in the operation Job.

- A cancellation during `reconciling` stops no reconciliation read. Those reads keep their §5 deadline. The service acknowledges the request and sets `endProcesses` on `ended` (§6 "Lingering Jobs"). So every process that Git or a hook started ends after the terminal response. That outcome records `lingeringDescendants` 0.
- A cancellation after `ended` has no target, because the operation is terminal. `cancel` returns the terminal state and ends no lingering Job.
- Interrupt and close during `reconciling` closes the operation Job at once and then follows application close (§6). No terminal response or `resolved` frame follows, so the recovery marker stays. The next start shows that workspace `unknown`.

Use bounded reference/reflog evidence for uncertain commit attribution. Apply the aggregate byte and record caps across all streams and references per reconciliation attempt. Do not assume current HEAD belongs to this request or invent a causal explanation. Evidence overflow or ambiguous attribution gives the terminal outcome `unknown`. Mutations stay blocked until an explicit recovery refresh reports that outcome.

**Commit attribution read.** The service reads the HEAD reflog with this argv: `--no-lazy-fetch --no-optional-locks --literal-pathspecs log -g -z --date=raw --no-show-signature --no-decorate --no-color --format=%H%x00%gd%x00%gn%x00%ge%x00%gs HEAD --`. The preflight tip read adds `-n 1` after `log`. Each record has five fields: commit OID, selector, committer name, committer email, and message. Each field ends with NUL. Records come newest first. With `--date=raw`, the selector is `HEAD@{<epoch> <zone>}`. The message never holds LF and can be empty. A linked worktree reads its own HEAD log. The read is a commit walk. Git skips a record whose new OID names no commit object, and the caps count only printed records (research R4 "T113 probes").

**Attribution window.** The tip is the newest record that the preflight read. The window holds the records that the reconciliation read prints before the first record equal to the tip in all five fields. The preflight can read no tip, or no printed record can equal the tip. Then the window holds every printed record when the read ended inside the caps. Automatic maintenance after the commit can expire the tip (research R4). The tip record counts toward the 10,000 records. A read above 4 MiB or 10,000 records gives `unknown` with reason `evidence-limit`. Only one window identifies a commit: exactly one record, whose commit is the observed HEAD and whose parents equal the reviewed HEAD. Two or more records give `unknown` with reason `ambiguous`. So does one record that fails this check. So do 0 records while the observed HEAD OID differs from the reviewed HEAD OID. The message, the identity, and the Git exit status never decide attribution. Git exits 128 for this read of an unborn HEAD, also when a HEAD log exists. So the service reads no tip for an unborn reviewed HEAD. While the observed HEAD is unborn, it reads no window, and the window holds 0 records. Commit reconciliation binds no working file. So a commit outcome reports `effects.workingFiles` false.

From `unknown`, only `readWorkspace` with `refresh: true` performs recovery reconciliation. It succeeds when all of these hold:

- No process that the service requested for the prior operation runs. Its operation Job is closed or lingering (§6 "Lingering Jobs"). A lingering descendant does not block recovery.
- A complete snapshot exists: HEAD target and OID, complete index, operation markers, and relevant working bytes.
- Owned lock and candidate files are released, or the terminal result names their paths in its `foreign` list. The list is optional and present only when not empty, on any terminal mutation state. The §8 set of the operation bounds that list ("Observed locks").
- For `commit`, one attribution attempt ran within the §5 caps. Its result is an identified commit, no commit, or `unknown`. An `unknown` result names its reason: `ambiguous`, `evidence-limit`, or `no-retained-request`.
- For `applyHunk` and `applyFile`, no attribution step runs. The observed canonical index is compared with two retained digests: the verified candidate and the index before publication. The result names the match: `published`, `not-published`, or `neither`. Without a retained request, the result is `unknown` with reason `no-retained-request`.
- For `updateSubmodules`, no attribution step runs. The refresh re-reads every row of the retained plan with the §12 review reads and states each row state. The retained plan holds the rows that the run added. Without a retained request, it reports attribution `unknown` with reason `no-retained-request`, and the next review shows the observed submodule states.

An attribution result of `unknown` does not fail reconciliation. It stays the prior operation's terminal outcome (FR-020). A failed, limited, or unavailable observation fails reconciliation, and the workspace stays `unknown`. The observation's code goes to the diagnostic, as the `cause` of the operation's session log entry (§7). The outcome keeps any recorded deadline reason (§5 "Deadline outcomes"). A status-only read performs no reconciliation, so it cannot release the gate. The refresh result states the prior outcome and the attribution result. It never replaces the prior terminal response. After success, the service sends `resolved` for the marker, and the workspace becomes `ready`.

Do not remove locks after interruption unless ownership and lifetime are certain. Do not delete unknown recovery files or discard a hook-modified private index silently.

For a WSL repository, a closed Job is not a process-end fact. Without a process-end fact, recovery names a lock or candidate with unknown ownership as foreign and keeps it. Recovery sends `remove` with the retained token, or with the retained candidate digest, only after a process-end fact (§4 "WSL index publication", "Process end").

After a restart, the app has no ownership record. Treat every leftover lock and candidate file as foreign. The recovery result bounds this list; T114 defines the bound. Name candidate files with the fixed prefix `arbareto-candidate-` so users can identify them.

On restart, obtain a fresh snapshot and review. Do not replay requests or claim that a previous interrupted operation rolled back.

A recovery marker survives a service restart, application close, and crash (§6). `getEnvironment` lists the markers from earlier sessions. A workspace whose common-directory identity matches an unresolved marker starts in `unknown`. The marker can come from this session or an earlier one. A new session has no retained request. So its recovery refresh reports attribution `unknown` with reason `no-retained-request`.

**Service restart.** The startup handshake after Restart service carries `restarted: true`. In that session, every registered workspace starts in `unknown`, also without a marker (FR-023). Only a `readWorkspace` with `refresh: true` in that session releases it. A `refresh: false` read keeps the block. With a matching marker, the refresh follows the rules above. Without one, recovery needs only a complete snapshot, and the refresh states that no operation outcome is pending. After each `service-session` event, the renderer runs `restoreWorkspace` again (§2). It shows State unknown and blocks every mutation until that refresh succeeds.

## 9. Error codes

| Category | Codes |
| --- | --- |
| Request boundary | `INVALID_REQUEST`, `PROTOCOL_VERSION`, `UNKNOWN_OPERATION`, `UNKNOWN_TARGET`, `FRAME_LIMIT`, `BUSY`, `WORKSPACE_LIMIT` |
| Prerequisites | `GIT_UNAVAILABLE`, `GIT_CHANGED`, `GIT_UNSUPPORTED`, `WEBVIEW_UNAVAILABLE`, `WEBVIEW_UNSUPPORTED`, `WSL_UNAVAILABLE` |
| Repository state | `REPOSITORY_UNAVAILABLE`, `REPOSITORY_CHANGED`, `UNSUPPORTED_REPOSITORY`, `OPERATION_IN_PROGRESS`, `CONFLICTED`, `LOCKED`, `UNSUPPORTED_SUBMODULE` |
| Trust and approval | `TRUST_REQUIRED`, `TRUST_CHANGED`, `STALE_SELECTION`, `STALE_REVIEW`, `APPROVAL_EXPIRED`, `UNSUPPORTED_HUNK_PROFILE` |
| Data and display | `MALFORMED_GIT_OUTPUT`, `OUTPUT_LIMIT`, `OBJECT_MISSING`, `UNSUPPORTED_COMPARISON`, `DISPLAY_MAPPING_FAILED`, `GRAPH_LAYOUT_LIMITED`, `WORKTREE_CHANGING` |
| Execution | `IDENTITY_REQUIRED` (no current rule gives it), `HOOK_FAILED`, `SIGNING_FAILED`, `GIT_FAILED`, `PROCESS_OWNERSHIP_FAILED`, `DEADLINE`, `CANCELED`, `COMMIT_ENCODING_UNSUPPORTED` |
| Recovery | `COMPLETED_WITH_EFFECTS`, `FAILED_WITH_EFFECTS`, `STATE_UNKNOWN`, `SERVICE_UNAVAILABLE`, `RECOVERY_MARKER_FAILED` |

Each terminal state (data-model §7) carries one result code:

- `succeeded`: no error code.
- `limited`: `OUTPUT_LIMIT`, with the reached §5 bound as its reason, `OBJECT_MISSING` (§7 "Missing objects"), or `WORKTREE_CHANGING` (§8 "Changing working file"). The response keeps its bounded data and completeness `limited`. Exception: a status `OBJECT_MISSING` result is a refusal that keeps no entries (§7 "Missing objects").
- `failed`: the specific failure code, such as `DEADLINE`, `GIT_FAILED`, or a mutation `OBJECT_MISSING`. A mutation `OUTPUT_LIMIT` also carries its §5 bound as `reason`.
- `canceled`: `CANCELED`.
- `completed-with-effects`: `COMPLETED_WITH_EFFECTS`.
- `failed-with-effects`: `FAILED_WITH_EFFECTS`. After an update or mutation deadline, it also carries the deadline `reason` (below).
- `unknown`: `STATE_UNKNOWN`, with its attribution reason. An `unknown` from a reconciliation read deadline after an update or mutation deadline carries the recorded deadline reason instead (§5 "Deadline outcomes"). An `unknown` from a failed, limited, or unavailable reconciliation observation (§8) also keeps any recorded deadline reason. The observation's code goes to the diagnostic, not to the outcome.
- `rejected`: the refusal code. `SERVICE_UNAVAILABLE` is always a `rejected` result.

A mutation request in a workspace whose recovery state is `unknown` is rejected with `STATE_UNKNOWN`. Above the recovery-marker limit (§5), every mutation is rejected with `STATE_UNKNOWN`. Unexpected diagnostic output above 4 MiB cancels the operation. A read then ends `failed` with `OUTPUT_LIMIT`. A mutation enters `reconciling`, and its diagnostic names `OUTPUT_LIMIT` as the cause.

Map these cases to codes:

- At acceptance of a snapshot-bound request other than `approveTrust`, a stale `repositoryGeneration` gives `REPOSITORY_CHANGED`. No Git process starts. `readWorkspace` never fails on a generation mismatch (§2). It also never fails for a working file that changes during the read (§8 "Changing working file"). An `approveTrust` fingerprint-generation mismatch gives `TRUST_CHANGED`.
- At acceptance, `readEntries` gives `REPOSITORY_CHANGED` for a stale `repositoryGeneration`. It gives `UNKNOWN_TARGET` for a released or replaced snapshot, or for a cursor that the snapshot did not issue. Each of these responses is `rejected`, and no Git process starts.
- A hunk or file checkpoint that detects a changed file, index, HEAD, or attribute, or a `publish` that finds the index lock no longer owned (`notOwned`) or the candidate changed (`mismatch`), gives `STALE_SELECTION`. At a hunk or file checkpoint, a stop decides first, and a deadline wins over a cancel. Then come a failed policy read, the trust gate and `TRUST_CHANGED`, and a failed index read. Then an index format error gives `MALFORMED_GIT_OUTPUT`. Then comes the §4 profile refusal. Then a failed operation-state read decides, and then the operation state. An observed `conflicted` gives `CONFLICTED`. An observed `merging`, `rebasing`, `cherry-picking`, `reverting`, or `sequencer-active` gives `OPERATION_IN_PROGRESS`. An observed `unknown` or a changed operation state gives `STALE_SELECTION`. Then come a failed HEAD read, a changed HEAD, a changed index, a failed attribute read, and changed attributes. Last, the bound working file decides: a changed read gives `STALE_SELECTION`, then a failed read gives its code, then another version gives `STALE_SELECTION`. A commit preflight that detects a changed index, checkout, or operation state gives `STALE_REVIEW`. An unfinished operation blocks a commit as it blocks a hunk or file (FR-016). At `commit` acceptance, the bound operation state decides before the trust gate. A review that bound `conflicted` gives `CONFLICTED`. A review that bound `merging`, `rebasing`, `cherry-picking`, `reverting`, or `sequencer-active` gives `OPERATION_IN_PROGRESS`. Each of these responses is `rejected`, and no Git process starts. A review that bound `unknown` passes acceptance. At the commit preflight, an observed `unknown` operation state gives `STALE_REVIEW`, also for a review that bound `unknown`. At the commit preflight, a stop decides first. Then come a failed policy read, the trust gate and `TRUST_CHANGED`, and a failed index read. Then an index format error gives `MALFORMED_GIT_OUTPUT`. Then a failed operation-state read and a failed HEAD read decide. Then a changed index, HEAD, or operation state gives `STALE_REVIEW`. This compare does not need the tip. Then a failed or malformed attribution tip read gives `GIT_FAILED`. Two bounds keep `OUTPUT_LIMIT`: a tip record above 4 MiB gives reason `ATTRIBUTION_EVIDENCE_BYTES`, and the §5 "Total unexpected diagnostic output" bound keeps its own reason. An unborn reviewed HEAD has no tip read (§8 "Attribution window"). Then an unsupported `i18n.commitEncoding` gives `COMMIT_ENCODING_UNSUPPORTED`. Last, `git var` checks identity.
- A failed file step of a hunk or file mutation gives `failed` with `GIT_FAILED`. The service keeps the cause in its diagnostic: `lock-create`, `candidate-copy`, `candidate-time`, `publish-time`, `verification`, `write`, or `replace`. A candidate copy or read error gives the cause `candidate-copy`. A `utimes` or read-back failure gives the cause `publish-time`. An index above `MUTATION_RAW_INDEX_BYTES` at candidate time gives `failed` with `OUTPUT_LIMIT` and reason `MUTATION_RAW_INDEX_BYTES`. Nothing is published. The WSL `candidate` `bound` reply gives the same outcome. Reconciliation decides publication by the canonical index digest. Nothing is published unless that digest equals the verified candidate digest. A `publish` that ends without a typed result, while the canonical digest is neither the `before` digest nor the verified candidate digest, gives `unknown` with `STATE_UNKNOWN`. The diagnostic `cause` is `GIT_FAILED`. The marker and both digests stay (§8). The remedy text is: "Arbareto could not finish this staging step. Nothing was staged. Use Refresh, then try again or stage in a terminal." A `publish` that returned success, while the later canonical digest is not the verified candidate digest, gives `completed-with-effects` with `effects.index` true. §4 "WSL index publication" gives the WSL counterparts.
- The commit preflight runs after acceptance and can run Git reads. So a preflight `STALE_REVIEW` ends the commit `failed`, not `rejected`. `rejected` applies only to a refusal at or before acceptance, when no Git process has started.
- A nonzero `git var GIT_AUTHOR_IDENT` or `GIT_COMMITTER_IDENT` exit gives `failed` with `GIT_FAILED`. Its `outputTail` holds the end of that `git var` process stderr, built by the "Commit failure output" rules. It carries no remedy command. Git documents no exit status for a missing identity, so no rule gives `IDENTITY_REQUIRED`. No commit process starts.
- The choice between `REPOSITORY_CHANGED` and these checkpoint codes depends on the request sequence. A `readWorkspace` that observes the change increases the generation, so a later request gives `REPOSITORY_CHANGED` at acceptance. Without such a read, the generation still matches, and the checkpoint code applies.
- A checkpoint that detects a changed trust fingerprint gives `TRUST_CHANGED`. This includes a configuration change during a hunk or file request.
- An entry that `applyFile` refuses gives `UNSUPPORTED_COMPARISON` with its file-action reason (§4 "File staging"). A direction that does not match the comparison scope gives `INVALID_REQUEST`.
- At acceptance, `applyHunk` gives `UNSUPPORTED_COMPARISON` with the support reason for an unsupported comparison. Otherwise it gives `UNKNOWN_TARGET` for a hunk ID that the named comparison did not issue, and `INVALID_REQUEST` for a direction that does not match the comparison scope. Each response is `rejected`, and no Git process starts.
- A `commit` with a review token from an earlier service session gives `UNKNOWN_TARGET`. The response is `rejected`, and no Git process starts.
- A `commit` with a review token that is no longer valid gets one code. At acceptance, a token past the §5 approval lifetime gives `APPROVAL_EXPIRED`. At acceptance, a token that a `readWorkspace` with `refresh: true` invalidated without a detected change gives `UNKNOWN_TARGET`. That token counts as a released identifier (§2). Each of these acceptance responses is `rejected`, and no Git process starts. A relevant state change gives `STALE_REVIEW` at the commit preflight, as above, and no commit process starts. A hunk or file approval past the §5 approval lifetime gives `APPROVAL_EXPIRED` at acceptance. The response is `rejected`, and no Git process starts. A hunk approval, a file approval, or a submodule review token that a `readWorkspace` with `refresh: true` invalidated without a detected change gives `UNKNOWN_TARGET` at acceptance. The response is `rejected`, and no Git process starts. A submodule review token past the §5 approval lifetime gives `APPROVAL_EXPIRED` at acceptance, in the same way.
- A failed `stage` Git step without a missing object gives `GIT_FAILED`. The result carries the `outputTail` of that step ("Commit failure output" below) and the `add` remedy of the entry (§4). A terminal run of the remedy repeats Git's message. `core.safecrlf=true` can cause this failure, as it does for `git add`.
- A `stage` whose staged blob has no proof gives `UNSUPPORTED_COMPARISON` with reason `blob-proof` and the `add` remedy. After a changed digest, it gives `STALE_SELECTION` (§4 "Blob proof").
- A split index or `core.splitIndex=true` gives `UNSUPPORTED_HUNK_PROFILE` with reason `split-index` for `applyHunk` and `applyFile` (§4 "Split index").
- A WSL repository with `core.sharedRepository` at any scope gives `UNSUPPORTED_HUNK_PROFILE` with reason `shared-repository` for `applyHunk` and `applyFile`. §4 "WSL index publication" gives the text.
- A Windows index lock whose handle has file ID 0 or all ones gives `UNSUPPORTED_HUNK_PROFILE` with reason `file-id` for `applyHunk` and `applyFile`. §4 "Windows lock ownership" gives the text.
- A working-file read whose file ID is 0 or all ones gives `UNSUPPORTED_HUNK_PROFILE` with reason `file-id` for `applyHunk` and `applyFile` (§6 "Registration bootstrap"). The text is: "This volume gives this file no unique file ID. Stage this change in a terminal." The index lock keeps its §4 text.
- The other §4 "Hunk eligibility and publication" refusals give `UNSUPPORTED_HUNK_PROFILE` for `applyHunk` and `applyFile` with these reasons and remedy texts:
  - `sparse-index`: "This repository uses a sparse index. Arbareto stages hunks and files only with a full index. Stage this change in a terminal."
  - `index-change-hook`: "This repository registers a post-index-change hook. Arbareto does not stage hunks and files while such a registration exists, also a disabled one. Stage this change in a terminal."
  - `executable-monitor`: "The core.fsmonitor setting starts a program for this repository. Arbareto does not stage hunks and files while that setting starts a program. Stage this change in a terminal."
  - `unqualified-monitor`: "This repository uses the built-in fsmonitor daemon of Git. Arbareto has not qualified that daemon for staging hunks and files. Stage this change in a terminal."
- `WSL_UNAVAILABLE` carries one reason: `wsl-missing`, `distro-missing`, `not-wsl2`, `no-user-manager`, `no-setsid`, `no-coreutils`, `no-perl`, or `start-failed` (§11). Its remedy texts are:
  - `wsl-missing`: "WSL is not available on this computer. Install WSL2, then open the folder again."
  - `distro-missing`: "No registered WSL distro has the name <name>. Open the folder through a listed distro."
  - `not-wsl2`: "Distro <name> is not a WSL2 distro. Arbareto opens repositories only in WSL2 distros."
  - `no-user-manager`: the §11 "Process ownership" text.
  - `no-setsid`: "Arbareto needs the setsid program in <distro>. Install the util-linux package in the distro, then open the folder again."
  - `no-coreutils`: "Arbareto needs the stat, env, and sha256sum programs in /usr/bin of <distro>. Install the coreutils package in the distro, then open the folder again."
  - `no-perl`: "Arbareto needs Perl in <distro> to check hook and program files. Install the distro's perl package, then open the repository again."
  - `start-failed`: "WSL could not start distro <name>. Start it in a terminal, then open the folder again."
- For a WSL Git, `GIT_UNSUPPORTED` carries reason `version`, `windows-git`, or `no-fs-uuid` (§11 "Git per distro"). Reason `version` carries the found and required versions. On an Ubuntu distro, it also carries the §11 Git PPA remedy command. The `windows-git` text is: "The git command in <distro> is Git for Windows. Install Linux Git 2.55.0 or later in the distro."
- `UNSUPPORTED_REPOSITORY` carries reason `wsl-path`, `mixed-location`, or `no-fs-uuid` for the §11 path rules. The `wsl-path` text is: "This path holds a name that Windows cannot show. Open another folder." The `mixed-location` text is: "The worktree and its Git directories must all lie inside one WSL distro, or all on Windows." The `no-fs-uuid` text is: "Arbareto cannot read a file-system UUID for this folder. Open a folder on the distro's own disk."
- `UNSUPPORTED_SUBMODULE` reasons: `unsaved-commits`, `update-mode`, `clone-interrupted`, `folder-not-empty`, `no-url`, `path`, `active-value`, `remote-name`, `gitdir-config`, or `limit`. The code carries the submodule path and one reason. §12 "Refusals" gives each text and remedy. A refusal during the run gives no code. Its row ends `refused` with its reason, which can also be `programs` or `changed-after-review` (§12 "Refusals during the run").
- A submodule preflight gives `STALE_REVIEW` when it detects a change (§12 "Update protocol"). The change can be in the plan, a submodule HEAD, a `.git` entry, a folder state, or the program list. So does the re-check after an approved `confirmRun`. That re-check consumed the token, so the operation ends `failed` with the code (§12 "Update protocol" step 3).
- An update or mutation deadline carries a `reason` that names the expired limit. The values are those of the §6 "Process fields" `deadline` field: `deadline`, `inactivity`, or `ceiling`. An `updateSubmodules` process deadline gives `inactivity` or `ceiling` (§5 "Submodule update process" and "Deadline outcomes"). Every other update or mutation deadline gives `deadline`.
- A deadline with no observed effect ends `failed` with `DEADLINE` and that reason. A deadline after a row or a file already changed ends `failed-with-effects` with `FAILED_WITH_EFFECTS` and that reason (§12 "Reconciliation and outcome"). A mutation reconciliation read deadline still gives `unknown` (§5 "Deadline outcomes").
- A `DEADLINE` of a read, a bootstrap probe, a registration, a dismissal, or `revokeTrust` carries no reason. A walk deadline in a mutation step follows the mutation rule above (§5 "Deadline outcomes").
- Every nonzero exit of the first discovery call gives `REPOSITORY_UNAVAILABLE` (§6 "Registration bootstrap"). The result names the selected folder as `path` and carries the remedy text "Run `git status` in this folder" without a command. It also carries `outputTail` ("Commit failure output" below). Git's ownership refusal and a folder outside every repository give this code too.
- A registration beyond 8 workspaces registered at one time gives `WORKSPACE_LIMIT`. The result names the limit. Only linked worktrees of one common directory can reach it (§6 "Registration reuse and release").
- A registration that would release a workspace with an unfinished mutation gives `BUSY`. So does a `chooseGit` while a workspace of the previous installation has an unfinished mutation (§6 "Registration reuse and release").
- A read that arrives while 8 reads wait gives `BUSY` before admission (§5 "Pending reads"). The response holds no `operationId`, and no Git process starts.
- A mutation whose `started` frame finds the cross-instance mutex held gives `BUSY` with the §6 "Cross-instance exclusion" remedy.
- A failed recovery-marker write gives `RECOVERY_MARKER_FAILED` with the failure class and the `recovery` folder path. Its remedy is: "Arbareto could not save its recovery record. Free disk space or restore write access to this folder, then try again." No lock and no Git process exist yet.
- A hook or signing failure gives `HOOK_FAILED` or `SIGNING_FAILED` only from structured evidence (research R4). Without that evidence, the result is `GIT_FAILED` with a recorded reason.
- `HOOK_FAILED` and a `GIT_FAILED` after the commit process starts carry a copyable remedy command. It is the PowerShell command `& '<selected Git path>' --no-lazy-fetch -C '<worktree root>' hook run --ignore-missing pre-commit`, quoted by the §4 rule. It runs the traditional and configured `pre-commit` hooks and creates no commit (research R4). The remedy text is: "This command runs the pre-commit hook in a terminal and does not commit. Other hooks show their output only here. Arbareto keeps your message." This text applies only to the failure remedy, and the §6 stall notice has its own text. No single command reproduces `prepare-commit-msg`, `commit-msg`, or signing without the message, so the app offers none for them. A `GIT_FAILED` before handoff carries no remedy command.

**Commit failure output.** A commit that ends `failed`, `failed-with-effects`, or `unknown` carries `outputTail`. It holds the end of the commit process stderr, or of the failed `git var` process before handoff. Git sends hook stdout to that stderr, so it holds hook output too (research R4).

- The service keeps a 16 KiB ring buffer of raw stderr bytes read before the completion signal (§6). Later bytes never enter it.
- When bytes were dropped before the buffer, the service drops the first partial line. So a URL is never cut at its start.
- It decodes UTF-8 with U+FFFD replacement. It removes ECMA-48 escape sequences, C0 controls except TAB and LF, DEL, and C1 controls. CR LF and a lone CR become LF.
- It then applies the §7 URL user-information redaction and keeps the last 100 lines.
- The renderer shows `outputTail` as plain text only, never as markup. No log, `diagnostic`, progress event, or other response carries it (§7).
- Only Git and the hooks that the user configured or approved write this output, as in a terminal run. Redaction removes URL user information but cannot detect every secret form (research R5).
- A failed `updateSubmodules` process carries its own `outputTail` by these rules, with one change for progress (§12 "Output tail").
- A failed `applyFile` `stage` Git step carries an `outputTail` from the stderr of its `update-index` process, by these rules.
- The discovery `REPOSITORY_UNAVAILABLE` of the first discovery call carries an `outputTail` from the stderr of that call. It follows these rules with the §12 "Output tail" change.

**Other locks.** Return `LOCKED` only when the app's own exclusive `index.lock` creation fails. A lingering process can hold another lock, such as a ref lock or `HEAD.lock`. Git then fails after handoff, and the commit ends `GIT_FAILED`, or `failed-with-effects` when reconciliation observes hook effects. The outcome names each observed lock (§8 "Observed locks") with its path. The terminal result lists these paths in `foreign`. The list is optional and present only when not empty, on any terminal mutation state. The §8 set of the operation bounds its size. Its remedy text is: "Git could not take a lock. Another Git process, or a process that Git or a hook started, can hold it. Use Refresh after that process ends."

**Lingering count.** Before a `LOCKED` result, a commit failure, or a failed `updateSubmodules` outcome, the service sends the §6 lingering count request. The request names the common directory. A nonzero count adds this sentence to the remedy: "Arbareto still runs <count> processes that Git or a hook started in this repository. Closing Arbareto ends them." A count of 1 uses "1 process" in place of "<count> processes" (plan.md "Long text"). When the workspace holds a current trust ID, the remedy adds: "Revoke trust also ends them." `revokeTrust` needs that ID (§3), and an untrusted repository has none.

A `LOCKED` result carries the Git-resolved lock path and this remedy: "Another Git process or a crash left this lock. Remove it only after all Git tools stop, including other Arbareto windows." The app never removes a lock. Git-reported lock failures stay `GIT_FAILED` with the "Other locks" guidance. A remaining `index.lock` gives `LOCKED` with its path on the next mutation attempt. Another remaining lock makes Git fail again with `GIT_FAILED`.

Do not classify repository state by parsing localized human status output. Use bounded structured observations and known execution phases. When a cause is uncertain, return `GIT_FAILED` with safe recovery guidance.

## 10. Required contract checks

- Reject unknown operations, duplicate keys, unknown fields, oversized frames, malformed UTF-8, invalid IDs, and hostile environment requests.
- Reject caller-supplied executable paths, patches, ref expressions, and traversal attempts.
- Reject another workspace's entry, hunk, review, or cancellation target.
- Verify staged/unstaged identity for the same path and category-specific comparison scope.
- Verify service restarts invalidate approvals and cannot replay a commit.
- Verify that the page gets its `sessionId` only through `currentSession`: at load, after a reload, and after `service-session`. Every draft survives a restart without a page reload. Verify that `currentSession` and each `text-scale` event carry the current Windows text scale factor.
- Verify that after Restart service the renderer runs `restoreWorkspace` again. Mutations stay blocked until a `refresh: true` read in the new session (FR-023).
- Verify 20 alternating opens of two repositories with different common directories. Each open releases the other, and no open gives `WORKSPACE_LIMIT`. A released `repositoryId` gives `UNKNOWN_TARGET`. Reopening the current worktree returns its `repositoryId`.
- Verify that no discovery or trust-listing command runs a repository-defined program before trust approval.
- Verify that no command runs a `remote.<name>.uploadpack` canary in a partial clone, also after trust approval. A read that needs a missing object gives `OBJECT_MISSING`, and a hook sees `GIT_NO_LAZY_FETCH=1`.
- Verify that each remedy command stays literal with each PowerShell single-quote character in each §4 value kind. The kinds are the Git path, each root and path, a submodule worktree, and a Git directory. They also include a remote name, a branch name, and a commit ID. A value with U+0022, U+201C, U+201D, U+201E, a control character, or invalid UTF-8 gives no command. Run each command in PowerShell 7 and in Windows PowerShell 5.1.
- Verify that URL user information in key subsections and origins never reaches `readTrust`, a diagnostic, or the log.
- Verify that trust approval persists across service sessions. A changed common-directory identity, Git installation, or fingerprint gives `TRUST_CHANGED`. An edit of an approved repository-controlled hook or program file also gives `TRUST_CHANGED`.
- Verify that marker dismissal needs an unavailable or changed repository and an explicit native confirmation.
- Verify a repeated `commit` with a consumed review token returns the first operation, and a repeated `requestId` gives `INVALID_REQUEST`.
- Verify the §9 token codes at acceptance: an expired token gives `APPROVAL_EXPIRED`, a refresh-invalidated token gives `UNKNOWN_TARGET`, and a preflight change gives `failed` `STALE_REVIEW`.
- Verify stale/out-of-order reads cannot replace the active view or authorize mutation.
- Verify that a `check: "changes"` read without a hint or a tuple change starts no Git process. Verify that `readHistory` runs beside `readWorkspace` without a status snapshot, and waits for read trust like other reads.
- Verify the §7 "Shared listing" and "Held history steps" rules. `readHistory` reuses the listing of a `readWorkspace` of its generation. `readWorkspace` always runs its own listing. A configuration edit or a new candidate file between the two reads forces a new listing. A refused gate returns no held history row, and no canary runs.
- Verify that a trust approval over a digest bound stores no record, and that the next session reports `untrusted`. This holds also after Restart service.
- Verify all limits report incomplete state explicitly and release owned process resources.
- Verify cancellation near completion reports actual effects and preserves unrelated processes.
- Verify configured hooks, hostile startup variables, and diagnostic credential canaries.
- Verify exact candidate publication and refusal for unsupported index-change hook/monitor profiles, including disabled registrations. This holds for hunks and files.
- Verify Stage file and Unstage file against `git add`, `git restore --staged`, and `git rm --cached` in disposable copies. Include a binary file, a staged rename, and each F04 line-ending case. A changed working file refuses `stage`, and a changed index entry refuses `unstage`.
- Verify checkpoint refusals separately from controlled changes after publication or commit handoff.
- Verify ordinary commit hooks retain their canonical index effects and `completed-with-effects` and `failed-with-effects` outcomes preserve drafts.
- Verify ambiguous or over-limit attribution remains unknown without retry, undo, or invented identities. Test aggregate byte and record limits independently.
- Verify status-only refresh cannot unblock unknown attribution. Required recovery reconciliation must succeed first.
- Verify that recovery reconciliation enables mutations when attribution stays `unknown`, and that its result states that outcome.
- Verify that a recovery marker survives a service restart, application close, and shell crash, and blocks the matching workspace.
- Verify that a `post-commit` hook child outlives its commit, and that the outcome records one lingering descendant. The child inherits stdout and stderr and writes after Git exits, and the commit still completes at Git's exit. A later read succeeds. An `index.lock` that the child holds gives `LOCKED` and stays. A held ref lock makes the next commit give `GIT_FAILED` with the observed lock path and the lingering count. Revoke trust ends the child and reports the count. Application close ends the child within 5 seconds. Cancellation still ends the whole tree, also during `reconciling`.
- Verify each §5 deadline outcome, including an `applyHunk` step, an `applyFile` step, and a reconciliation read.
- Verify that the pre-commit remedy command creates no commit. Verify that `outputTail` stays within 16 KiB and 100 lines, holds no control sequence, and redacts URL user information.
- Verify real parent DAGs, shallow/page boundaries, data limits, controlled graph selection, and row alignment.
- Verify that `core.splitIndex=true` from local and global scope refuses `applyHunk` and `applyFile` with reason `split-index`. Verify that no `sharedindex.*` file appears. Verify the same for a `link` extension. With `GIT_TEST_SPLIT_INDEX=1` in the service environment, verify that the Git environment lacks the variable (§4 "Split index", §7), that staging succeeds, and that no `sharedindex.*` file appears.
- Verify that `core.sharedRepository` from local and global scope refuses `applyHunk` and `applyFile` in a WSL repository with reason `shared-repository`. The index keeps its bytes, and no owned lock or candidate remains. The check takes the key from the §7 configuration listing and starts no extra Git process.
- Verify each §4 "Blob proof" branch for `stage`: proof A and proof B. Also verify both failing with `blob-proof`, and a changed digest with `STALE_SELECTION`. Verify that a writer that changes and restores the working file during step 5 never publishes.
- Verify that a candidate copy keeps a time at most the canonical index time. A same-size change in the second of the last index write must stage its new bytes. A later `status` must still show an unrelated such change.
- Verify the §11 route rule, distro checks, Git floor, and start step with Cancel. Verify that no Windows variable reaches Linux Git.
- Verify that no Linux process of an operation remains after cancellation, a deadline, or a service failure. Verify the same after Revoke trust and application close. Check with `pgrep` in the distro. A plain, a `nohup`, and a `setsid` hook child each linger until one of those events. The outcome counts them. A hook that opens `/dev/tty` fails at once. A distro without `setsid` gives `WSL_UNAVAILABLE` with reason `no-setsid`. A distro without `/usr/bin/stat`, `/usr/bin/env`, or `/usr/bin/sha256sum` gives reason `no-coreutils`.
- Verify each `wslFiles` mode against distro `sha256sum` and Git. Verify the bound and field refusals, the refusal outside WSL, `LOCKED` with the lock kept, and `publish` `mismatch` and `notOwned` with no rename. `notOwned` covers a replaced lock, and a deleted lock that another writer creates again with the same inode. The lock content after `lock` and after `mismatch` is the token. `remove` deletes an owned lock or candidate. A recreated lock, and a copy of the lock with the token at a new inode, give `notOwned` and stay. The token-only form removes an owned lock and such a copy. A failed `lstat` other than `ENOENT` gives `error`. Verify that `cancel`, `closeJob`, and the deadline give no result. Inject the deadline after Perl has created and written the lock. Verify that no `remove` and no `indexDigest` decision comes before an `exit` with `activeDescendants` 0. After the process-end fact, `remove` with the token gives `removed`, and a stopped `publish` is decided from `indexDigest`. A deadline before the create gives `notOwned`. Verify that the index-hash gate reads the index bytes only after a digest change.
- Verify the §4 "Outcome after a stopped walk" for each `lock` and `publish` stop, and `publish` `notOwned` with `failed` `STALE_SELECTION` and the UNC `index.lock` path.
- Verify that a `started` frame gives `BUSY` while another instance holds the mutex of that common directory. A linked worktree gives the same result. Verify that `WAIT_ABANDONED` counts as taken.
- Verify that `worktreeKey` stays equal across sessions and for both WSL prefixes, and differs for two linked worktrees.
- Verify that a failed `applyFile` `stage` carries a bounded, sanitized, redacted `outputTail` and the `add` remedy.
- Verify that a WSL poll runs 1 second after the previous poll ends and only while the window has focus. It never runs beside another read of that workspace.
- Verify that `updateSubmodules` gives the submodule HEADs, Git directories, and configuration keys of `git submodule update --init --recursive` in a copy, two levels deep. Verify the `:(literal)` pathspec with a `[1]` path.
- Verify the §12 steps for each row kind. A fetching row runs `fetch --progress --no-recurse-submodules`, the fallback fetch only when the target stays unreachable, the check, and then `submodule update --init --no-fetch`. No step passes `--recursive`. Each fetch carries `GIT_PROTOCOL_FROM_USER=0` and `--no-recurse-submodules`.
- Verify that a target present without a ref makes the row fetch, as Git's own update does. A `reuse` row that fetches runs the connect step first.
- Verify that `reviewSubmodules` runs no submodule canary: `core.fsmonitor`, filters, hooks, `core.sshCommand`, `credential.helper`, and `remote.origin.uploadpack`. Verify that no submodule program runs before an approved `confirmRun`, and that a declined one starts no update process.
- Verify the same for canaries in the kept Git directory of a deinitialized submodule and of its nested submodule. The program list holds each of them.
- Verify that a fetching row lists the remotes of the submodule and marks the default remote. A kept `remote.origin.url` that differs from the parent URL gets the note.
- Verify each §12 refusal, and that a local `submodule.<name>.update=!command` canary never runs.
- Verify that an `ext::` URL runs no program, and that a `file` URL fails without `protocol.file.allow`. The app sets no `protocol.*` key.
- Verify that a stored superproject approval stays `approved` after an update that registers submodules.
- Verify Cancel during a clone, the inactivity deadline, and the ceiling. Reconciliation reports every changed row and each interrupted clone, and removes no file.
- Verify that a submodule blocked by local changes keeps its HEAD and changes. The outcome is `failed-with-effects` when another row changed.
- Verify that each failed row carries a redacted `outputTail` and its remedy command, and that no log holds the output.
- Verify that a `reuse` row whose folder holds a modified tracked file refuses with `folder-not-empty`. The file keeps its bytes. Verify that the moved-folder remedy of `clone-interrupted` lets the next update succeed.
- Verify that a relative global `core.hooksPath` lists an `unchecked` entry for each `clone`, `reuse`, `checkout`, and `fetch-checkout` row. No such hook runs before an approved `confirmRun`.
- Verify that a row whose HEAD only a remote-tracking ref holds passes the review. With `fetch.prune` set and the remote branch deleted, the fetch removes that ref. The row then ends `refused` with `unsaved-commits`, HEAD unchanged, and no checkout process. The other rows still update.
- Verify that the review reads run again after an approved `confirmRun`. A change gives `STALE_REVIEW` before any update process starts. The operation ends `failed`, and its recovery marker resolves.
- Verify the folder check before the first step of each `reuse` row. A file added after the preflight gives `folder-not-empty`, and the file keeps its bytes. The check reads of a `reuse` row use `--git-dir` and `--work-tree`.
- Verify that Cancel after a connect step gives `failed-with-effects` with the `connected` flag. Verify that a failed first fetch whose row reaches its target gives `succeeded`.
- Verify that a silent update process with a changing I/O sum passes the inactivity limit. An idle one reaches it.
- Verify that a plain folder, a dubious-ownership folder with `$(…)` or a quote character in its name, and a broken gitfile each give `REPOSITORY_UNAVAILABLE`. Each refusal names the selected folder, carries Git's message in `outputTail`, and offers no command. Other stderr bytes keep the same code.
- Verify that a WSL identity holds the UUID-derived file-system ID and the inode, not the device number. Verify that a type other than `ef53` gives `no-fs-uuid`.
- Verify that a hook whose native child reads an invisible console ends at the deadline (§6 "Console and input"). Every descendant ends too.
- Verify the stall notice for a commit hook and for a submodule step that block without I/O. The notice appears 15 to 17 seconds after the last activity, with Cancel and the §6 command. Cancel ends the Job, and no log holds output. Activity hides the notice.
- Verify that a nested level whose configuration gained a program after the confirmation refuses with `programs`. Its program never runs, and the other rows continue.
- Verify that a row whose program file an earlier row changed refuses with `programs` before its first step. Its program never runs.
- Verify the program re-check before each later process. A program file that changes during the fetch of a row refuses that row with `programs` before its checkout step. The changed program never runs. A changed parent `core.fsmonitor` program refuses its nested level before the active-set read.
- Verify the §12 clone check. Another Git process initializes a `clone` row path after the preflight and commits on its HEAD. The row ends `refused` with `unsaved-commits` and no command. No hook of that Git directory runs, and HEAD keeps its commit. Without such a commit, the reason is `changed-after-review`.
- Verify that a submodule remote whose name starts with `-` refuses with `remote-name`. Every fetch and `remote get-url` passes `--` before a remote name. A marker program named in a remote name never runs.
- Verify each §12 read failure. A failed check, `remote get-url`, or folder read ends its row `failed` without a later process. A failed level read ends the nested rows of that level `failed`.
- Verify that an uninitialized `update = none` submodule gets the `submodule.*` keys of Git's own update and no clone.
- Verify that a row whose registration Git wrote before a failed checkout carries `registered`. The outcome is then `failed-with-effects`. Verify the same for a nested row against its level-read baseline.
- Verify that each built remedy command gives Git the intended arguments in PowerShell 7 and Windows PowerShell 5.1. A value that ends in `\`, other than a drive root, gives no command (§4).
- Verify that the clone step of a `reuse` row without a kept HEAD runs no nested kept program. The result equals Git's own update.
- Verify that the fetch remedy refuses a `file` remote without `protocol.file.allow` in PowerShell 7 and 5.1. The session keeps its `GIT_PROTOCOL_FROM_USER` value.
- Verify that `getOperation` carries `stallRemedy` while `stalled` is true and clears it at the next activity. No progress event carries a command.
- Verify that each admitted request gets one accepted event before its response, with the same `requestId`. Verify that a request rejected before admission gets no accepted event. Verify that no progress event follows the response of its `requestId`.
- Verify that an idle WSL Git with an active anchor reaches `stalled` and `inactivity`. Job `IO_COUNTERS` that change each second never count.
- Verify that shared TypeScript takes native path rules only from `src/contracts/native-path.ts`. A scan of the transpiled `src/` files checks this (`tests/git/portable-imports.test.ts`).

## 11. WSL repositories

WSL2 repositories are in this slice (spec FR-039 to FR-046). Git inside the distro runs them. Every other rule of this contract applies unless this section states otherwise. Research R13 holds the probes P1 to P5 and their sources.

### Route

- WSL routing exists only on Windows. On other platforms, every path takes the native route.
- A selected or restored path is a WSL path when it starts with `\\wsl$\` or `\\wsl.localhost\`. Each of the three separators in that prefix can be `\` or `/`, as Win32 accepts both. The prefix comparison ignores letter case, as WSL does (P3).
- The next segment names the distro. It must equal a name that `wsl.exe --list --quiet` prints. Without an exact match, one match that ignores ASCII letter case (`A` to `Z` only, as in §6 "Startup contexts") counts, because `wsl.exe --distribution` accepted another letter case (P3). Any other result gives `WSL_UNAVAILABLE` with reason `distro-missing`.
- The identity is one normalized UNC path: the `\\wsl.localhost\` prefix, the listed distro spelling, and the remaining segments. So both prefixes of one folder give one `repositoryId`.
- The Linux path is `/` followed by the remaining segments, joined with `/`. `wslpath -u` gave the same result in P3.
- Windows names cannot hold some Linux names. WSL shows such a name with characters in U+F000 to U+F0FF (P5 showed `\` as U+F05C). A repository path segment with such a character gives `UNSUPPORTED_REPOSITORY` with reason `wsl-path`.
- Every other path stays a Windows path. A drive letter mapped to a WSL share is a Windows path, and the §6 identity rule refuses it.
- The service decides the route before any §6 identity request. `FileIdInfo` failed with error 50 on `\\wsl.localhost` paths (P5), so a WSL path never uses it.

### Distro checks

- The shell lists distros with `wsl.exe --list --quiet` and running distros with `wsl.exe --list --running --quiet`. Both calls use fixed arguments and the §5 probe deadline. The shell decodes their output as strict UTF-8, because every `wsl.exe` process gets `WSL_UTF8=1` ("Process launch" below). Without it, WSL printed UTF-16LE (P3). The shell never parses the localized State column of `--list --verbose`.
- The shell reads the registration key `HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss\{GUID}` whose `DistributionName` equals the listed name. `Version` 2 means WSL2 (P3). Another value gives `WSL_UNAVAILABLE` with reason `not-wsl2`. A missing key gives reason `distro-missing`. The GUID enters the repository identity, so a registered-again distro gives a new identity.
- A missing `%SystemRoot%\System32\wsl.exe`, or a failed list call, gives `WSL_UNAVAILABLE` with reason `wsl-missing`.
- The app never installs, configures, stops, or unregisters WSL or a distro. It runs no `--install`, `--update`, `--shutdown`, `--terminate`, `--unregister`, `--set-version`, or `--manage`.

### Distro start

- When the running list does not name the distro, registration or restore enters phase `wsl-starting`. The renderer shows "Starting WSL distro <name>…" with Cancel.
- The first WSL process starts the distro, as `wsl.exe` does for any command. That process is the Git probe ("Git per distro" below). Its deadline is the §5 WSL start deadline.
- The renderer sends Cancel as `cancel` with the `operationId` from the accepted event of the registration request (§2). Cancel closes the probe Job. Registration ends `canceled`, and the current workspace stays unchanged. The distro can keep starting after Cancel, and the app does not stop it.
- A deadline gives `DEADLINE`. A `wsl.exe` failure gives `WSL_UNAVAILABLE` with reason `start-failed`. The result carries the bounded `wsl.exe` error text as plain text, such as `Wsl/Service/WSL_E_DISTRO_NOT_FOUND` (P3).
- After registration, any WSL process can start a stopped distro again. The ordinary §5 deadlines then apply. A read that meets a slow start can end `failed` with `DEADLINE`, and the next poll reads again.
- The identity probes of `lingeringCount`, `started`, and `revoke` follow the same rule, with the §5 walk deadline. `lingeringCount` and `revoke` skip the probe when its result cannot change the reply. That is the case when no lingering Job tag holds the distro GUID of the repository. For `revoke`, no trust record outside the path match may hold that GUID either. The reply is then `count` 0 or `endedProcesses` 0, and no `wsl.exe` starts.

### Git per distro

- One bootstrap probe per distro runs a fixed `/bin/sh -c` script with `LC_ALL=C`. It takes one argument: the Linux path of its context, which the shell computes by the "Route" rule. For that path, it prints `selfs` with `stat --dereference --file-system --format=%t:%i`, `selino` with `stat --dereference --format=%i`, and `selstat`. `selstat` is `ok`, `absent` when Perl `stat` sets `ENOENT` or `ENOTDIR`, or `error`. The shell binds the context identity from these lines together with the Git facts, or binds nothing. A context binds once. It runs before the helper paths exist, so it runs without the wrapper. It starts only `command -v`, `readlink`, `head`, `stat`, `perl`, `git --version`, and the empty scope test below. It reads `/etc/os-release` with the shell builtin `read` (the Ubuntu rule below). It resolves `git`, `systemd-run`, `systemctl`, and `setsid` with `command -v` and `readlink -f`. It also resolves the fixed paths `/usr/bin/stat`, `/usr/bin/env`, `/usr/bin/sha256sum`, and `/usr/bin/perl` with `readlink -f`. For `sha256sum`, the probe line is `found sha256sum "$(readlink -f -- /usr/bin/sha256sum)"`, so the output holds `path sha256sum` and `magic sha256sum` lines. It prints each absolute path, the first two bytes of each file, and the `git --version` text. As the identity of the Git file, it prints `stat --dereference --file-system --format=%t:%i <Git file>` and `stat --dereference --format=%i:%s:%Y <Git file>`. It tests one empty `systemd-run --user --scope` call.
- `--version` runs without `--no-lazy-fetch`. Linux Git 2.43.0 rejected that option with "unknown option" (P3). With it, the floor refusal could not name the found version. `--version` opens no repository and fetches nothing. Every other Git command keeps `--no-lazy-fetch` first (§7 "Missing objects" states this exception once).
- Three cases give `GIT_UNSUPPORTED` with reason `windows-git`. They are a resolved path under `/mnt/` and a file that starts with the bytes `MZ`. The third is a version text with `.windows.`. The `PATH` of an `--exec` process holds Windows directories, and interop runs Windows programs (P2).
- A resolved `systemd-run` or `systemctl` that fails the same rule gives `WSL_UNAVAILABLE` with reason `no-user-manager`. So does a failed scope test ("Process ownership" below).
- A missing `setsid`, or one that fails the same rule, gives `WSL_UNAVAILABLE` with reason `no-setsid`. Every wrapper mode needs it ("Process launch" below). The util-linux package provides it. The identity rule uses `stat` from coreutils, not `findmnt` (research R13 P7).
- A missing `/usr/bin/stat`, `/usr/bin/env`, or `/usr/bin/sha256sum`, or one that fails the same rule, gives `WSL_UNAVAILABLE` with reason `no-coreutils`. The identity probes need `stat` ("Paths and file access" below), and the §12 fetch remedy needs `env` ("Remedy commands" below). The §6 "WSL file work" digests need `sha256sum`. The coreutils package provides all three. FR-043 requires this refusal for the program that identifies folders.
- A missing `/usr/bin/perl`, or one that fails the same rule, gives `WSL_UNAVAILABLE` with reason `no-perl` (§9 remedy text). The identity and `fileFacts` probes need it ("Paths and file access", "Trust and environment"). Debian, Ubuntu, and Kali always hold it, because `perl-base` is Essential. The program checks come before the path checks, because the path lines need both `stat` and `perl`.
- The service checks the context path lines after the program checks and before the other Git rules. `selstat absent` gives `UNSUPPORTED_REPOSITORY` with the WSL remedy, and it allows a dismissal (§6 "Dismissal"). `selstat error`, or a missing or malformed `selfs` or `selino` line, gives `UNSUPPORTED_REPOSITORY` with the WSL remedy. Type `1021997` gives reason `mixed-location`. Any other type except `ef53`, or ID 0, gives reason `no-fs-uuid`. The WSL remedy is: "Arbareto cannot read the identity of this folder in <distro>. Check that the folder exists on the distro's own disk."
- A Git file without a stable file-system ID ("Paths and file access" below) gives `GIT_UNSUPPORTED` with reason `no-fs-uuid`. The text is: "Arbareto cannot read a file-system UUID for Git in <distro>. Install Git on the distro's own disk."
- No `git` gives `GIT_UNAVAILABLE` with the remedy "Install Git 2.55.0 or later in <distro>."
- A version below 2.55.0 gives `GIT_UNSUPPORTED` with reason `version`. Compare `major.minor.patch` numerically. An unparseable version gives the same result. The text names both versions: "Git <found> in <distro> is older than 2.55.0. Install Git 2.55.0 or later in the distro."
- On an Ubuntu distro, reason `version` also carries a copyable remedy command. The app never runs it. Ubuntu means `ID=ubuntu` in the distro's `/etc/os-release`. The value can also stand in double or single quotes (os-release(5)).
  - Detection: the bootstrap probe reads `/etc/os-release` with the shell builtin `read`, so it starts no process for it. It prints the value of the first `ID=` line as one `osid` line. The probe output bounds apply (§6 "Registration bootstrap").
  - A missing or unreadable file, another value, or another distro gives no command. The refusal then keeps the text above.
  - The command runs the distro as root, so no `sudo` password prompt shows. Its form is: `& '<System32 path>\wsl.exe' --distribution '<distro>' --user root --cd / --exec /bin/sh -c 'add-apt-repository -y ppa:git-core/ppa && apt-get update && apt-get install -y git'`.
  - The script argument is a fixed literal. The §4 quoting rule and the U+005C rule of "Remedy commands" below apply to every value. One shared builder applies them.
  - The text keeps both sentences above. It adds this sentence: "This command adds the official git-core PPA and installs its Git." Research R13 records the PPA version.
- The native Git selection confirmation (§3 "Git proposal") then shows the distro, the Git path, and the version. Its buttons are Use this Git and Cancel, and Cancel is the default. Enter on the default, Escape, Alt+F4, the close button, and a call failure mean Cancel. Only Use this Git issues the `gitInstallationId` of that distro.
- Native settings keep the approved path, version text, and identity for each distro GUID. A later probe with another identity gives `GIT_CHANGED` and a new confirmation. The app never selects another Git without that confirmation (FR-003).
- A WSL repository never uses Git for Windows. Windows Git on a `\\wsl.localhost` path failed with "detected dubious ownership" (R13).

### Process launch

Every WSL process is a `wsl.exe` process in an operation Job. The shell creates it suspended and already in its Job, as §6 states. It supplies `%SystemRoot%\System32\wsl.exe` through `lpApplicationName`. It creates the process with `CREATE_NO_WINDOW`, so `wsl.exe` has a hidden console. With `DETACHED_PROCESS`, a probe command ran, but `wsl.exe` relayed no output (research R14 probe S10). Its environment holds `WSL_UTF8=1` and an empty `WSLENV`. So a `wsl.exe` error message arrives as UTF-8, as Git output does, and the setting never reaches Linux. The argument array is:

`--distribution <distro> --cd / --exec /bin/sh -c <wrapper> sh <unit> <mode> <index file or empty> <systemd-run> <systemctl> <setsid> <program> <program arguments>`

- For Git, `<program>` is the approved Git path, and the program arguments are `--no-lazy-fetch -C <Linux directory> <Git arguments>`. The directory is the worktree root, or for a §12 step the parent or submodule worktree. `--no-lazy-fetch` stays the first Git argument. The `-c fetch.recurseSubmodules=no` of a §12 clone step follows it and precedes `-C`.
- `--exec` passes each argument to the program without a Linux shell (P3; Git Extensions PR #13271). The wrapper is a constant text and passes its arguments only as `"$@"`. So no argument reaches shell parsing.
- `--cd /` fixes the Linux working directory. `--cd` with a missing directory ran the command in `/` with exit status 0 (P3). So the repository directory reaches Git as `-C`, and Git fails on a missing directory.
- `<unit>` is `arbareto-<operationId>-<n>.scope`. `<n>` counts the processes of the operation.
- `<mode>` is `probe`, `read`, `mutation`, or `network`. In `probe` mode, the wrapper sets `LC_ALL=C` for the program (§6 fixed C locale). A non-empty index file sets `GIT_INDEX_FILE`. Only `mutation` passes one.
- `network` mode serves only the `updateSubmodules` clone, connect, fetch, checkout, and register processes (§12). Inside the distro it behaves as `mutation` mode, and it also sets `GIT_PROTOCOL_FROM_USER=0`. The §7 policies cannot set it there, because no Windows variable reaches Linux Git. The service side uses the §12 deadlines.
- Every mode passes the approved `setsid` path (spec Clarifications, 2026-10-01).
- `src/contracts/wsl-process.json` holds the wrapper and anchor texts. The shell embeds that file at build time. The service and the test double read the same file.

The wrapper does four things:

1. It traps `SIGHUP`. The trap ends the scope with `systemctl --user kill --signal=SIGKILL -- <unit>` and exits. The command gets `SIGHUP` when its `wsl.exe` ends (P1).
2. It sets `GIT_TERMINAL_PROMPT=0` in every mode (§6 "Console and input"), and `GIT_PROTOCOL_FROM_USER=0` in `network` mode. It starts `systemd-run --user --scope --quiet --collect --unit=<unit> -- <setsid> --wait <program>` in the background, with the original stdin, and waits for it. A trapped signal interrupts `wait` at once. A foreground child delays the trap until the child ends (P1 S4 and S4b). This holds in every mode.
3. In `probe` and `read` mode, it ends the scope after the program exits. So read processes never linger (§6).
4. It exits with the exit status of the program.

`setsid` reason: with the hidden console, a Linux command could open `/dev/tty`. So a hook or an SSH prompt could wait for input that nobody can see, until its deadline. `setsid --wait` removed the controlling terminal and passed the exit status (research R14 probe S10). A `/dev/tty` open, an SSH passphrase prompt, and an unknown-host prompt then fail at once. The user chose this for every mode on 2026-10-01 (spec Clarifications). Consequence: the children of Git get no `SIGHUP` at the wrapper exit. A child that keeps running stays in the scope, and the anchor counts it, as on Windows ("Process ownership" below). Research R13 records this as a design change that needs a re-probe.

The wrapper itself stays in the session of `wsl.exe`. So it still gets `SIGHUP` when its `wsl.exe` ends, and its trap still ends the scope. The anchor runs without `setsid` for the same reason.

The `wsl.exe` exit is the completion signal of the Git process (§6). Its exit status is Git's status (P1 S3 and S5b). Stdin, stdout, and stderr pass through unchanged.

### Process ownership

A Windows Job holds `wsl.exe`, not the Linux processes. A Linux process that detaches or ignores `SIGHUP` survived the `wsl.exe` exit and a later Job close (P1). Git's detached maintenance detaches too (Git `daemonize()` calls `setsid()`; git-config(1) `maintenance.autoDetach`). So the app owns Linux processes through systemd user scopes:

- Every WSL process runs in its own scope. A process cannot leave the control group of its scope. A child that starts its own unit through `systemd-run` or `systemctl` leaves app ownership. An external service launch on Windows does the same (§6).
- The distro must run a systemd user manager. Without it, the Git probe gives `WSL_UNAVAILABLE` with reason `no-user-manager`. The remedy text is: "Arbareto needs the systemd user manager in this distro to end the processes that Git starts. Set systemd=true under [boot] in /etc/wsl.conf, then restart the distro." The user decided this refusal on 2026-09-30 (spec Clarifications). The app changes no distro configuration and offers no mode with a process ownership limit.
- A mutation starts an anchor in its operation Job before its first Git process: `wsl.exe --distribution <distro> --cd / --exec /bin/sh -c <anchor> sh <systemctl> <operationId>`.
- The anchor traps `SIGHUP`, and the trap ends every `arbareto-<operationId>-*.scope`. For each stdin line, the anchor prints one line with two numbers. The first is the process count of those scopes, read from their `cgroup.procs` files. The second is the I/O sum: the `rchar` and `wchar` values of `/proc/<pid>/io` for each of those processes. After stdin closes, it prints the line once per second and exits at count 0.
- I/O sum reasons (research R13 P6): the user scope has no `io` controller, so no `io.stat` file exists. `/proc/<pid>/io` of a same-user process was readable. After a child exited and its parent reaped it, the parent's `rchar` included the child's reads. A process that leaves between the two reads adds nothing. The §12 inactivity deadline and the §6 stall notice use the sum (§6 "Activity and stall notice").
- For a WSL mutation, `activeDescendants` is the count that the anchor prints after the last execution process exits. The lines that the shell requests each second for activity do not replace that count. At `ended`, the shell closes the stdin of the anchor. When the anchor exits, the Job empties, and the §6 port rules close it.
- Every Job close ends the scopes of its operation. A Job closes at the `cancel` of a `run` call, a `closeJob`, the deadline of a `run` or a read, Interrupt and close, or `endProcesses`. A walk `cancel` and a walk deadline end only the walk's `wsl.exe` and close no Job (§6 "Walks"). It also closes at Revoke trust, a service failure, application close, or a shell crash. `wsl.exe` ends, the command gets `SIGHUP`, and the trap ends the scopes. In P1, ten cancellation runs and ten lingering runs left no Linux process 1 second after the Job close.
- The §6 lingering count of a WSL Job is the last anchor count. That count is at most 1 second old. Revoke trust reports it.
- Git runs in its own session without a controlling terminal, in every mode ("Process launch"). So the wrapper exit sends no `SIGHUP` to its children. Every child that keeps running after Git exits lingers in its scope and counts, as on Windows. Before 2026-10-01, a plain child ended at the wrapper exit (P1 S6); that result no longer describes this design.
- Application close needs no WSL call beyond the Job closes. The 5-second close target covers the traps.

### Paths and file access

- The service converts paths only at the Git argument boundary: the `-C` directory and the candidate index file. Entry paths stay Git path bytes, as on Windows.
- Linux Git reports Linux paths. The service converts each Git-resolved directory back to the UNC identity. The worktree root, the Git directory, and the common directory must lie in the Linux file system of one distro. The identity probe reads the file system type magic. Type `v9fs`, magic `1021997`, means a Windows drive (P5: `/mnt/c` reported `v9fs`, and `/` reported `ext2/ext3`). Such a directory gives `UNSUPPORTED_REPOSITORY` with reason `mixed-location`.
- A Windows repository whose Git-resolved directories lie under a WSL prefix also gives reason `mixed-location`.
- A WSL identity request, a WSL `fileFacts` request, and a `wslFiles` request are walks (§6 "Walks"). Each runs its `wsl.exe` process on its walk thread, under the §5 walk deadline. A stop ends that `wsl.exe` process, never the operation Job.
- The shell answers a WSL identity request with one fixed `identity` probe of `src/contracts/wsl-process.json` per request. `/bin/sh` runs it through the wrapper in `probe` mode, with `/usr/bin/perl` and the Linux paths as arguments. For each path, it prints `id <inode> <type>:<fsid>` from `/usr/bin/stat --dereference --format=%i` and `/usr/bin/stat --dereference --file-system --format=%t:%i`. `%t:%i` gives the file system type magic and the file-system ID (`statfs` `f_fsid`). When a `stat` fails, the probe prints the Perl `stat` result instead: `absent` when `$!` is `ENOENT` or `ENOTDIR`, else `fail`. `absent` gives the refusal with `reason` `absent` (§6 "Process fields"), and `fail` gives the refusal without a reason. So one request of up to 8 paths starts one `wsl.exe`. The identity is the distro GUID, the file-system ID, and the inode number, in the §6 WSL identity form. The probe reads no file data. A failed probe refuses registration with `UNSUPPORTED_REPOSITORY`, as a failed `FileIdInfo` call does (§6).
- Only type `ef53` (ext2, ext3, and ext4) gives a stable file-system ID. Every other type except `v9fs` gives reason `no-fs-uuid`, as an all-zero `FileIdInfo` does. So does an ID of 0.
- Reason: the device number can change. WSL2 attaches each distro disk as a SCSI disk, and `lsblk` listed `sda` to `sde`. The attach order probably selects the device; T252 checks this. The reference distro's root reported `stat %d` 2096, which is device 8:48 (`/dev/sdd`). A UUID stays with the file system. Registration reuse, the mutation exclusion, recovery markers, lingering Job tags, and trust records use this identity. This applies where §6 and §7 name `FileIdInfo`.
- ID source (research R13 P7): ext4 derives `f_fsid` from its superblock UUID (Linux `fs/ext4/super.c`, `uuid_to_fsid`). The reference root reported ID `fedc9aa3bd65bc57`, which equals that value for its `findmnt` UUID. `statfs` reads the mounted superblock and needs no udev data. `findmnt` took the UUID from udev data, because the user cannot read the disk device. The udev trigger finished 0.7 seconds after user space started, so an earlier UUID read could be empty. XFS derives its ID from the device number (Linux `fs/xfs/xfs_super.c`). Two tmpfs mounts gave different IDs. So only type `ef53` counts.
- An entry path with a character that Windows names cannot hold gets reason `path` (data-model §5). §6 "WSL file work" takes path components by the §6 "File facts" component rule, so it cannot take such a name.
- In a WSL repository, the on-disk name (`diskPath`) of a comparison equals the index path bytes. Linux name lookup is exact, so a found file has the index name. Limit: a folder with the ext4 `casefold` attribute looks up names without letter case. The service does not detect such a folder, so a letter-case difference there gets no `path` refusal (research R13 "WSL in-distro file work").
- Bulk file work stays inside the distro (§6 "WSL file work"). Only facts, sizes, SHA-256 digests, object IDs, exit statuses, and link targets cross to Windows. Working-file digests, the staging digests of §4 "Binding", both blob proofs, the canonical index digest, the index lock, the candidate copy, publication, and the removal of an owned lock or candidate use `wslFiles`. No working-file content crosses. Reasons: reads through `\\wsl.localhost` (9P) and Linux reads of `/mnt` (drvfs) are slow. No probe verified an atomic replace through 9P. A Linux `rename(2)` on one file system is atomic (POSIX.1-2024 `rename`).
- The `readWorkspace` submodule notice checks `.git` entries and `.gitmodules` with WSL `fileFacts` requests with `digest: false` (§12 "Discovery notice"). No such check reads through `\\wsl.localhost`.
- New in-distro work joins a process that already runs, or runs once per comparison or per staging step. It never starts one `wsl.exe` per file. Each `wsl.exe` start costs about 200 to 250 ms, and each systemd scope about 52 ms (research R13 P10).
- These crossings stay:
  - Git output through the pipe, within its §5 bounds.
  - The raw index bytes after a changed index digest ("Change polling" below), and the raw candidate bytes for the §4 `link` check.
  - The seven operation-marker `stat` calls, and `.git/shallow` within its 4 MiB bound.
  - Metadata-only `/mnt` access from inside the distro: the bootstrap `PATH` search and the identity probes of outside paths.
- In P5, a second exclusive create of `index.lock` through UNC failed with error 80. A replace over `index` succeeded, and Linux Git read the result. These results no longer decide a product step.
- The candidate lies in the Linux Git directory beside the index. Git gets it as a Linux path through the index file argument of the wrapper.
- Ownership gap. Linux Git refuses a repository that another user owns. It compares `st_uid` with the effective user ID, and for root with `SUDO_UID` (Git `git-compat-util.h` `is_path_owned_by_current_uid`). Its refusal holds no machine-readable reason. So a WSL repository gets the §6 merged refusal: `REPOSITORY_UNAVAILABLE` with the output tail. The app runs no ownership probe in the distro.

### Change polling

- WSL repositories get no watcher. `fs.watch` threw `EISDIR` on `\\wsl.localhost` paths in Node and Bun (R13).
- While the main window has focus, the renderer sends `readWorkspace` with `refresh: false` and `check: "full"` as a poll. It sends the next poll 1 second after the previous poll ends. Without focus, it sends no poll. Focus return and each mutation outcome send the §3 full read as for Windows repositories.
- A poll never starts while another read of that workspace runs. A poll that falls due during such a read starts when that read ends. A user read that finds both workspace read slots busy cancels a running poll. It cancels a superseded selection read the same way (§5).
- WSL polls never use `check: "changes"`. Without a watcher, the stat tuple cannot see unselected working files.
- Index-hash gate. A WSL `readWorkspace` takes the index digest inside the distro, in the first phase-1 `fileFacts` request of its trust listing (§6 "Index digest in a read"). A listing without a phase-1 request gives no digest, and the read reads through UNC. That request carries the `sharedIndex` hash of the last parsed index. When the index `sha256` equals the `rawIndexDigest` of the last parsed index, and any shared digest equals the retained one, the read reads no index bytes. It reuses the retained raw-index part of the index fingerprint: `rawIndexDigest`, the `link` hash, and the shared-index digest. SHA-256 equality is the byte identity that both values bind. The read computes the hunk eligibility from the retained `link` hash and the listing of this read. The listing gives `index.sparse`, `core.splitIndex`, the `post-index-change` hook, and `core.fsmonitor`. The entry part of the fingerprint comes from the listing of this read, as before. A digest change reads the index bytes through UNC and parses them, as before. Only a read with a complete index listing replaces the retained raw-index part. A limited index listing does not replace it, and reuse still requires equal digests. An `absent`, `bound`, or `error` result also reads through UNC, and the UNC read decides.
- Order: the digest comes before the Git reads of the read, and the UNC read comes after them. In both orders, a change between the two shows in the next poll. A mutation compares the index digest under its lock again (§4).
- plan.md §Measurements holds the WSL budgets.

### Trust and environment

- Repository-controlled programs run as the Linux user of the distro. Through interop, they can start Windows programs as the Windows user. The §7 trust rules apply unchanged.
- The trust listing uses the distro Git. The service reads no program file through its UNC path (§6 "File facts").
- The shell answers a `fileFacts` request of a WSL repository with the fixed Perl probe `fileFacts` of `src/contracts/wsl-process.json`. It runs `/usr/bin/perl` through the wrapper in `probe` mode, in the Job of the request's `operationId`, under the §5 walk deadline. The arguments are `digest` as `0` or `1`, then the Linux paths of the three roots. A request with `index` also passes the approved `sha256sum` path and the `sharedIndex` hash (§6 "Index digest in a read"). Stdin holds each entry as its root index, its component count, and its components, each ended by NUL. The probe opens a root with `O_DIRECTORY` and follows a link there, as the identity probe does. It opens each middle component with `O_DIRECTORY` and `O_NOFOLLOW`, then changes to it through the handle. It never follows a link below a root. Perl `$!` gives the `errno` of each failed call. `ENOENT` and `ENOTDIR` give `absent`. `EACCES` and `EIO` give their §6 codes, and every other value gives `other-error`. The probe reads at most 1 MiB plus one byte of each final file and applies the §5 byte bounds in request order. It sends the bytes, and the shell computes each SHA-256. `lastWrite` holds whole seconds times 10^9, because Perl `lstat` gives `st_mtime` in seconds only. WSL listings never share (§7), so no change check reads it. A probe that does not exit 0, or output that breaks the record form, gives each entry `error` with component 0 and code `other-error`. `cancel` and `closeJob` end the probe process, and no reply follows (§6 "Walks").
- The probe reports `executable` (`access(X_OK)`) and `ownerExecute` (`S_IXUSR`). A hooks-folder entry counts only with `executable`. A bare-name program uses the `PATH` that the Git probe printed, and a candidate counts only with `ownerExecute`. The lookup tries only `<entry>/<name>`, and the hook lookup tries only `<event>`, because Linux Git adds no `.exe`. The Windows directories in that `PATH` lie outside the repository, so they enter the fingerprint as locations only. The probe reads no `HOME`.
- A WSL listing applies the POSIX rules of §7 to the Linux forms of the three roots, with no letter-case fold and `/` as the separator. An absolute link target is a Linux path. Request components still pass the §6 component rule, so a Linux name that Windows names cannot hold gets `unchecked` with bound `name`.
- A protected path outside the roots gets an identity request in its `wslIdentityPath` form (`src/contracts/wsl-route.ts`). A path without that form fails the listing with `REPOSITORY_UNAVAILABLE`.
- A protected path outside the roots whose WSL identity reply is `mixed-location` or `no-fs-uuid` counts as outside every root, as a location only. Examples are `/mnt/c` on drvfs and a tmpfs mount. It never gives `REPOSITORY_UNAVAILABLE`. Reason: the WSL roots lie on ext4 ("Paths and file access"), so a file on another file system cannot alias a root.
- Known limits of WSL trust listings:
  - A Linux name without a Windows form fails the listing.
  - The probe reads no `HOME`, so a `~/` value counts as repository-controlled. This only adds approval prompts.
  - Letter-case folding of record paths on WSL UNC paths changes only the label.
- A WSL `confirm` frame and its `TrustRecord` carry `gitSelectedPath` as the UNC form of the approved Git path, `\\wsl.localhost\<distro>\…`. The service maps the Linux path by the "Route" rule (`wslIdentityPath` in `src/contracts/wsl-route.ts`). `gitSelectedPath` stays required. A distro rename changes this path, so the next read needs approval again (§7 "Trust approval store"). A Linux Git path that the rule cannot map refuses `approveTrust` before any dialog, with `UNSUPPORTED_REPOSITORY` and the remedy "The Git path <path> in <distro> holds a name that Windows cannot show. Install Git in another folder of the distro, then approve again." No session approval follows.
- A WSL repository never shares a trust listing (§7 "Shared listing"). WSL polls use no stat tuple ("Change polling"), and no probe tested the tuple for distro configuration files.
- Every `wsl.exe` process gets an empty `WSLENV` ("Process launch" above). WSL forwards only the variables that `WSLENV` names (P4 forwarded `GIT_TRACE` through it). So no Windows variable reaches Linux Git, and that includes the `GIT_*` variables that §7 preserves for Git for Windows. The distro's own configuration and environment apply.
- The `--exec` environment in P4 held `HOME`, `PATH`, `LANG`, `USER`, `SHELL`, `TERM`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, `WSL_DISTRO_NAME`, and `WSL_INTEROP`. It held no `GIT_*` variable. The `mutation-trace2` policy does not apply to WSL, so hook and signing failures stay `GIT_FAILED`.
- Credentials come from the distro's Git configuration. The app sets up no credential helper. An SSH agent that `.bashrc` starts does not load under `--exec` (Git Extensions #11839). Hooks and the §12 update fetches can meet this limit.

### Remedy commands

A WSL remedy is a PowerShell command that calls `wsl.exe`. Each value uses the §4 quoting rule. The `add` form is:

`& '<System32 path>\wsl.exe' --distribution '<distro>' --cd / --exec '<Git path>' --literal-pathspecs -C '<Linux worktree root>' add -- '<path>'`

- The `restore --staged` and `rm --cached` forms follow the same pattern. So does the §9 hook remedy, which keeps `--no-lazy-fetch` as its first Git argument. So do the §12 submodule remedies. In a terminal, `wsl.exe` has a visible console, so Git and SSH can ask for input there.
- `wsl.exe` passed each PowerShell argument literally in P3, also with spaces and `$`. The §4 rule applies to every value of a WSL command, the trailing U+005C rule included.
- The route and path rules above refuse `"` and `\` in distro names and paths. A remote name from the distro's Git configuration can still hold them. No probe passed U+005C through `wsl.exe`. So a WSL command is offered only when no value after `--distribution` holds U+005C. The distro name counts as such a value. The `wsl.exe` path before `--distribution` keeps its Windows form, so this rule does not apply to it.
- The §12 fetch remedy puts `/usr/bin/env GIT_PROTOCOL_FROM_USER=0` between `--exec` and `'<Git path>'`. The variable then applies only to that one Git command. With it, distro Git refused a `file` remote, and without it, the fetch passed (research R14 S30).
- `env` reads each leading argument with U+003D as a `NAME=value` assignment. It takes the first argument without U+003D as the program (GNU coreutils manual, "env invocation"). So an approved Git path with U+003D gives no fetch remedy. The row still shows its text.

## 12. Submodules

Submodule initialization and update are in this slice (spec FR-047 to FR-054). They form the first network operation of the slice. Research R14 holds the probes S1 to S35 and their sources. Every other rule of this contract applies unless this section states otherwise.

### Scope

- `updateSubmodules` initializes and updates every submodule recursively to the commit that its parent records. Submodule HEADs, folders, and settings equal those of Git's own `submodule update --init --recursive` (probe S20). The recorded differences touch only remote-tracking refs, one skipped fetch, and the environment of hooks ("Update protocol" step 5).
- The app runs that work in phases for each submodule ("Update protocol"). It fetches first and checks the refs of the submodule again. Then Git checks out without a fetch. The user decided this order on 2026-10-01 (spec Clarifications).
- It never selects single submodules, never adds, removes, or syncs one, and never runs a command in each. It passes no `--remote`, `--force`, `--merge`, `--rebase`, `--checkout`, or `--recursive`.
- Other operations keep their submodule rules. Reads pass `--ignore-submodules=dirty` and start no Git process inside a submodule. Hunk and file staging refuse submodules with reason `submodule`.

### Discovery notice

`readWorkspace` returns `submoduleNotice` from superproject data only. It starts no Git process inside a submodule.

- A stage-0 gitlink counts when its worktree path holds no `.git` entry. A `submodule.<name>.active` value `false` excludes it from the notice. The review can still show its activation ("Plan"). A gitlink also counts when porcelain v2 reports it deleted in the worktree (`Y` is `D`). Git then sees no worktree entry, also behind a linked folder. Such a gitlink and a gitlink whose path fails the data-model §5 path rule get no file check. The file check never follows a link. Only a value that Git's boolean rule reads as false excludes the gitlink. A value that is no boolean excludes nothing.
- A gitlink also counts when porcelain v2 status reports a changed commit in its submodule state (`SC..`). Status passes `--ignore-submodules=dirty`, so Git reads the submodule HEAD in its own process (research R5).
- The service maps paths to names from the first `.gitmodules` source of "Review reads": `config --file .gitmodules`, `config --blob <stage-0 object ID>`, or `config --blob HEAD:.gitmodules`, each with `--null --list`. None loads the index (§7). The service runs this read only when a gitlink counts and an effective `submodule.<name>.active` value is false. A worktree `.gitmodules` that is a link or a folder counts as present, so `config --file` decides. Its nonzero exit gives `skipped`.
- `count` is the number of gitlinks that count, without a bound. `paths` holds the first 256 of them in index order (§5 "Submodule review"). Above 256, the review refuses with reason `limit`. The notice can name a submodule that `submodule.active` excludes. The review then shows that submodule as `skip`.
- The name filter needs a complete `.gitmodules` listing. When the listing passes the §5 1 MiB bound, or Git exits nonzero, no gitlink is excluded and `filter` is `skipped`. Git documents no exit status that identifies an invalid file for `--list`. The read completeness does not change. Otherwise `filter` is `applied`, also when the filter is not needed or no source exists.
- The HEAD source is used only when `cat-file --batch-check` resolves `HEAD:.gitmodules` to an object. Its `<object> missing` reply means that no HEAD source exists (git-cat-file(1)). A nonzero `cat-file --batch-check` exit gives `skipped`.
- When the status or index listing ends `limited`, the notice uses only the listed records. The read completeness already states the limit.

### Review reads

`reviewSubmodules` builds the plan from the superproject and from each initialized submodule. An initialized submodule has a `.git` entry in its worktree path. The review also reads each kept Git directory (below).

- Superproject reads: the index gitlinks, the §7 configuration listing, and `.gitmodules`. Git reads the worktree `.gitmodules` first, then the index blob, then the HEAD blob. The review reads the same source through `config --file` or `config --blob`. The index source is the stage-0 `.gitmodules` object ID from the index listing, read with `config --blob <object ID>`.
- Top-level checked-out commits come from `diff-files -p --ignore-submodules=dirty --no-relative --src-prefix=a/ --dst-prefix=b/ -- <gitlink paths>`. The service takes the path from the `+++ b/<path>` line, with C-quote unquoting. A path that matches no requested gitlink gives `MALFORMED_GIT_OUTPUT`. The service splits long path lists into several calls under the §6 command-line limit. The `Subproject commit` lines name each submodule HEAD. It started no Git process inside a submodule (probe S3).
- Inside each initialized submodule, the review runs only these fixed commands. Each starts with `--no-lazy-fetch --no-optional-locks -C <submodule worktree>`.
  - `rev-parse --verify -q HEAD`, `rev-parse --absolute-git-dir`, `rev-parse --git-path hooks`, and `symbolic-ref -q HEAD`. `show-ref --exists <HEAD ref>` runs only when `rev-parse --verify -q HEAD` fails. Exit 2 then means no commit, and another result is a read failure.
  - `config list --show-scope --show-origin -z`.
  - `for-each-ref --contains=HEAD --count=1 --format=%(refname)`. Every ref counts ("Refusals").
  - `cat-file --batch-check` with the needed object IDs on stdin.
  - `rev-list -n 1 <target> --not --all`. Git's own update runs this read before each fetch decision (`is_tip_reachable`, builtin/submodule--helper.c:2493-2514). Exit status 0 with no output means that a ref or HEAD reaches the target. Output or a failure means that none reaches it (probe S23).
  - `ls-tree -r -z --full-tree <commit>` and `config --blob <commit>:.gitmodules --null --list`.
- A `reuse` row has no `.git` entry. For it, the same commands run with `--git-dir=<parent Git directory>/modules/<name> --work-tree=<same directory>` in place of `-C` (probes S9 and S11). `--work-tree` replaces a `core.worktree` path that can be missing before the update. None of these commands reads the worktree.
- Folder check: for each `reuse` row, the service reads the type of its worktree path and lists its entries. It reads no file data and starts no process. The `folder-not-empty` refusal uses the result ("Refusals").
- None of these commands loads an index. Probe S3 ran each one with submodule canaries. The canaries covered `core.fsmonitor`, clean and smudge filters, every traditional hook, `core.sshCommand`, `core.askPass`, and `credential.helper`. No canary ran. Probe S23 ran the `rev-list` read with the same canaries, and none ran.
- These commands are the only exception to the §7 rule that superproject reads never start Git inside a submodule. The `updateSubmodules` preflight, its level reads, and its reconciliation run the same commands.
- The update adds two commands that run only after the step 3 decision ("Update protocol"). `remote get-url --all -- <name>` serves the fallback fetch, and it ran no canary (probe S23). The nested active-set read ("Plan") loads an index and can run the `core.fsmonitor` of that submodule.
- Nested submodules: the review takes the gitlinks of an initialized submodule from the tree of its target commit. This needs a local target commit. Otherwise it takes them from its HEAD tree. It recurses into each nested gitlink with a `.git` entry. Without a local target commit, the plan states that the update finds the nested submodules after its fetch. Then the nested rows come from the HEAD-tree commit, and each carries `target: null`. The update reads each nested level again after its parent checkout ("Update protocol").
- Kept Git directories: the update reuses each kept `modules/<name>` directory of a submodule without a `.git` entry. This holds at every depth, and Git then runs the programs of that directory (probe S11). So the review recursively walks the superproject `modules` folder and the `modules` folder below each Git directory it reads. Git names the superproject folder: `rev-parse --path-format=absolute --git-path modules`. A linked worktree has its own `modules` folder, not the one in the common directory (probe of 2026-10-09).
- A submodule name can hold `/`, so the walk enters every subfolder. For each folder, it runs `rev-parse --absolute-git-dir` with `--git-dir=<folder> --work-tree=<folder>`. A folder that Git accepts is a kept Git directory. In it, the walk continues only in its own `modules` folder. Git refuses a submodule Git directory inside another one (Git v2.55.0 submodule.c:2402-2442).
- In each kept Git directory, the review runs the commands above with `--git-dir=<directory> --work-tree=<directory>`. Each directory then enters the program list ("Trust") and the `unsaved-commits` check ("Refusals") once.
- Each folder that the walk visits counts as one submodule toward the §5 submodule review bound. A larger walk gives reason `limit`. After the bound, the review still reviews the top-level rows. Nesting and the walk stop.
- The walk assumes Git's default layout under `modules`. Git 2.55 also offers `extensions.submodulePathConfig`, which places Git directories by `submodule.<name>.gitdir` (git-config(1)). The review refuses that layout with reason `gitdir-config` ("Refusals", research R14).

### Plan

Each plan row holds an opaque row ID, the path, the name, and the depth. It also holds the URL, the action, the notes, and any refusal reason.

- URL: the effective `submodule.<name>.url` of the parent, or else the `.gitmodules` value. A relative `.gitmodules` URL appears as written. Its note reads: "Git resolves this URL against the remote of the parent repository." The service redacts URL user information by the §7 rule.
- Fetch URLs: a `reuse` or `fetch-checkout` row fetches inside the submodule, from the remotes of the submodule. The first fetch ignores the parent URL (probe S12). So the row also lists each `remote.<name>.url` from the submodule `config list`, redacted, and marks the default remote.
  - The default remote is the remote of the checked-out branch, else the only remote, else `origin` (Git v2.55.0 remote.c:666-680). When Git would die on the remote configuration (T254 `SubmoduleUrlError`), the row marks no remote as default.
  - Git can contact other remotes too. With `fetch.all` true, the fetch covers every remote. A fetch by commit ID uses the remote whose URL equals the `.gitmodules` URL (builtin/fetch.c:2700-2720, builtin/submodule--helper.c:77-115). So the row lists every remote.
  - A note applies when no remote URL equals the parent URL. It reads: "Git fetches from the submodule remotes, not from this URL."
  - A submodule without a remote gets the note: "This submodule has no remote. Git cannot fetch a missing commit."
- Actions:
  - `clone`: no `.git` entry, and no `<parent Git directory>/modules/<name>`. Git clones the URL and checks out the recorded commit. Git can fetch that commit inside the same process (probe S19). A new clone has no earlier HEAD to lose.
  - `reuse`: no `.git` entry, but `<parent Git directory>/modules/<name>` exists. Git connects it and fetches a missing commit (probe S9). Then it runs `checkout -q -f`, which overwrites tracked files in the folder (probe S13). So the folder must be absent or empty (`folder-not-empty` under "Refusals").
    - A kept Git directory whose HEAD is no commit, as after an interrupted clone, has no earlier HEAD to lose. The update runs the clone step for that row. The `folder-not-empty` rule and the step 5 folder check still apply to it ("Update protocol").
    - For every other `reuse` row, the `rev-list` read in the kept Git directory decides whether the row fetches, as for the two actions below.
  - `checkout`: the HEAD differs from the recorded commit, and a ref or HEAD of the submodule reaches that commit. No fetch runs.
  - `fetch-checkout`: the HEAD differs, and no ref reaches the recorded commit. The commit is missing or present without a ref. Git's own update fetches in both cases (probe S19). The update fetches first ("Update protocol").
  - `none`: the HEAD equals the recorded commit. The update still visits its nested submodules.
  - `skip`: a submodule with update mode `none`, or a submodule outside the active set. Git leaves it and its nested submodules unchanged. An uninitialized submodule with `update = none` in `.gitmodules` gets registered, but Git skips its clone (builtin/submodule--helper.c:2298, probe S5).
    - Such a row in the active set gets the registration note and the register step ("Update protocol" step 5). So the settings equal those of Git's own update (probe S33).
    - A `skip` row outside the active set starts no process ("Active set" below).
- Notes name each configuration write and each HEAD change:
  - "Git registers the URL in the repository settings." Git writes `submodule.<name>.url` and, when the submodule is not yet active, `submodule.<name>.active` (probe S1). It also copies an update mode from `.gitmodules` (probe S5).
  - "Git marks this submodule active." This note applies to an explicit `submodule.<name>.active=false` when `submodule.active` is unset (probe S5).
  - "Git detaches HEAD from branch <branch>." This note applies when the submodule HEAD is a branch.
  - "Git moves HEAD from <old short ID> to <new short ID>."
  - "Git fetches in this submodule before the checkout." This note applies to each row that fetches.
- Active set, from Git's `module_init` and `is_submodule_active` (research R14):
  - With `submodule.active` unset, Git initializes every gitlink. An explicit `false` becomes `true` (probe S5).
  - With `submodule.active` set, an explicit `submodule.<name>.active` wins. Otherwise the gitlink must match the `submodule.active` pathspecs. The service asks Git through `ls-files -z --stage -- <pathspecs>`, which uses Git's own matcher. Every other gitlink gets `skip`.
  - Nested levels: the review lists existing nested submodules and computes no active set for them. After each parent checkout, the update computes the active set of the nested level. It uses the same rules and the configuration of the parent submodule.
  - When that parent sets `submodule.active`, the update runs `ls-files -z --stage -- <pathspecs>` inside it. That read loads the index of the parent submodule, so its `core.fsmonitor` can run. The run confirmation covers that program. Git's own recursive update loads the same index (builtin/submodule--helper.c `module_list_compute`).
  - A nested row below such a parent gets the note: "Git applies the active submodules of <parent path>." A pathspec would activate an inactive submodule (builtin/submodule--helper.c:596-597). So the update starts no process for a nested row outside the active set.

### Refusals

`reviewSubmodules` returns each refusal, and `updateSubmodules` refuses while one holds. The code is `UNSUPPORTED_SUBMODULE` with one reason. A kept Git directory without a plan row uses its Git directory path as the refusal `path`. The reasons are:

- `unsaved-commits`: an initialized submodule, or a kept Git directory ("Review reads"), has a HEAD that no ref of it contains. The review also cannot prove that this HEAD equals the target commit. Git detaches HEAD without a warning. Only the submodule reflog then keeps those commits, until reflog expiry (probe S4).
  - Every ref counts, `refs/remotes` included. A fetch can still remove or move the ref that holds HEAD. With `fetch.prune`, a fetch deleted the only remote-tracking ref that held HEAD (probe S15).
  - So the update checks HEAD and its refs again after each fetch and before each checkout ("Update protocol"). A row that fails this check gets no checkout. It ends `refused` with this reason, its text, and its remedy (probe S20).
  - Text: "Submodule <path> is at commit <short ID>, which the update can leave without a branch, tag, or other ref. Save it with the command, then use Refresh." The remedy is `& '<selected Git path>' --no-lazy-fetch -C '<submodule worktree>' branch 'arbareto-saved-<short ID>' '<full ID>'`. `--no-lazy-fetch` stays the first Git argument, as in every app command (§7 "Missing objects"). A kept Git directory uses `--git-dir='<Git directory>' --work-tree='<Git directory>'` in place of `-C`. Each value uses the §4 quoting rule. The short ID has 12 hex digits.
- `update-mode`: a row has an update mode that this slice refuses. The rules below name each case. The mode comes from the effective configuration of the parent, or else from `.gitmodules`. Text: "Submodule <path> uses the update mode <mode>. Arbareto updates only submodules that Git checks out. Use the command in a terminal." `<mode>` is the value that refuses: the `.gitmodules` value when that value refuses, else the effective value. The remedy is the update command under "Remedies".
  - A `.gitmodules` value that is a `!command` or no Git update mode refuses its row. This holds for every effective value, `none` included, for every row kind, and outside the active set. Git dies when it reads that `.gitmodules` value and exits 128 for the whole update (probe S5, probe of 2026-10-09). The other rows are reviewed as usual.
  - A `.gitmodules` `update` value that is a `!command` or no Git update mode, in an entry that matches no gitlink, has no row. So the review lists no refusal for it. Git exits 128 for the whole update, so the update ends `GIT_FAILED` ("Reconciliation and outcome").
  - An effective `merge` or `rebase` refuses an existing submodule or a `reuse` row.
  - A just-cloned submodule gets a checkout for `merge` and `rebase` (builtin/submodule--helper.c:2143-2147, probe S5). So a `merge` or `rebase` mode never refuses a `clone` row. An effective `!command` refuses its row, whatever the row kind, a `clone` row included. With `none`, Git skips the clone, so the row is `skip`.
  - An effective value that is not `checkout`, `rebase`, `merge`, `none`, or a `!command`, for example `foo`, refuses every row kind, a `clone` row included. Git exits 128 for it from either source (Git `parse_submodule_update_type`, probe of 2026-10-09).
  - Reason: `merge` and `rebase` can stop in an unfinished operation, which this slice blocks. `!command` runs a repository command.
- `clone-interrupted`: a `.git` entry exists, but `rev-parse --verify -q HEAD` finds no commit in it ("Update protocol", read failures). Another result is a read failure ("Update protocol" step 5). A killed clone leaves this state, and Git then fails with "Unable to find current revision" (probe S9). Text: "Git stopped while it cloned submodule <path>. Move the folder <path> out of the repository after all Git tools stop. Then use Update submodules again." The state shows the path with Copy path. The app never moves or deletes it.
  - Reason: Git then sees a `reuse` row with an absent folder. It recreates the folder, fetches into the kept Git directory, and checks out the recorded commit. The moved folder keeps every byte (probe S13).
  - The earlier remedy deleted only `<path>\.git`. A folder with other files then became a `reuse` row, and `checkout -q -f` overwrote them (probe S13). The `folder-not-empty` refusal now blocks that state.
- `folder-not-empty`: a `reuse` row has a worktree path that is not an empty folder. The path holds a file, a link, a junction, or a folder with any entry, hidden entries included. Git's update would run `checkout -q -f` there and overwrite tracked files without a warning (probe S13). An absent path and an empty folder pass. Text: "Submodule <path> has no Git link, but its folder is not empty. Git would overwrite those files. Move the folder out of the repository, then use Refresh." The state shows the path with Copy path. The app never moves or deletes it.
  - A `clone` row needs no empty-folder rule for files without a Git link. Git refused to clone into a folder that was not empty, and the file kept its bytes (probe S13). The row then fails ("Reconciliation and outcome").
  - A `.git` entry or a `modules/<name>` directory that appears after the review is a different case. The clone check ("Update protocol" step 5) refuses it before Git starts.
- `no-url`: a gitlink has no `.gitmodules` entry. A mapped name with no URL in any source also refuses with `no-url`. Text: "The .gitmodules file has no entry for submodule <path>. Git cannot update it."
- `path`: a submodule path fails the data-model §5 path rule. Text: "Arbareto cannot pass the path of submodule <path> to Git literally."
- `active-value`: the effective `submodule.<name>.active` of a gitlink is not a Git boolean. Git 2.56 `submodule update` exits 128 for it (research R14, probe of 2026-10-08). Text: "Submodule <path> has a submodule.<name>.active value that is not true or false. Fix it in a terminal, then use Refresh." It has no command.
- `remote-name`: a row that fetches lists a remote whose name starts with `-`. Git can read such a name as an option. A fetch by commit ID without `--` ran the program that the remote name `--upload-pack=<program>` named (probe S31). Text: "Submodule <path> has a remote named <name>, which Git can read as an option. Rename that remote in a terminal, then use Refresh." It has no command.
  - Every app command also passes `--` before a remote name ("Update protocol" step 5). The refusal is a second guard.
  - `remote.<name>.url` is a Git-written key ("Trust"), so the program list never shows such a name. The refusal does.
- `gitdir-config`: the `config list` output of the superproject, or of a submodule Git directory that the review reads, enables `extensions.submodulePathConfig`. Any `submodule.<name>.gitdir` key in that output also refuses. Git can then place submodule Git directories outside `modules/<name>` (git-config(1)). The kept-directory walk cannot find them, so the program list can miss their programs. The refusal carries the path of the submodule whose configuration holds the setting. A superproject setting carries the worktree root. A kept Git directory without a plan row carries its Git directory path. Text: "This repository sets custom locations for submodule Git folders. Arbareto reads only the default location. Update the submodules in a terminal." The remedy is the update command for that submodule path. A superproject setting and a kept Git directory without a plan row get the update command without a path ("Remedies").
- `limit`: the review passes a §5 submodule bound. Text: "This repository has more than 256 submodules or more than 8 nesting levels. Update them in a terminal." The remedy is the update command without a path.
- Order: the review lists the `update-mode`, `gitdir-config`, and `limit` refusals after every other refusal. Their remedy runs Git's own update without these checks ("Remedies"). So the review shows the other remedies first.

A WSL distro without `setsid` never reaches the review, because registration refuses it with reason `no-setsid` (§11 "Git per distro").

Git's own refusal to overwrite local changes is no refusal here. It is a failed row ("Reconciliation and outcome").

**Refusals during the run.** The update reads each nested level, and it checks each row again before its steps ("Update protocol"). A refusal found then stops only that row and its nested rows. The row ends `refused` with its reason, text, and remedy or none, and the other rows continue. The step 5 checks can give `unsaved-commits` and `folder-not-empty` then. A level read can give every review reason. Two reasons exist only during the run:

- `programs`: a row or a nested level needs a program that the run confirmation did not cover ("Trust"). Text: "Submodule <path> needs programs that the run confirmation did not cover. Use Update submodules again to review them." It has no command.
- `changed-after-review`: the clone check found a changed `.git` entry or `modules/<name>` state ("Update protocol" step 5). A ref holds the HEAD of the found Git directory, or it has no HEAD commit. Text: "Another program changed submodule <path> after the review. Use Update submodules again to review it." It has no command.
- Reason for a stop instead of a new confirmation: FR-048 requires that the review lists every program before the start. A new dialog during the run would show programs that no review listed.

### Trust

- Superproject: §7 "Mutation trust" applies. The superproject approval is needed only when reads need it.
- Submodule programs: the review lists each program of every submodule Git directory that the update can use. These are each initialized submodule, each `reuse` and `fetch-checkout` row, and each kept Git directory, at every depth ("Review reads"). For each submodule, it applies the §7 repository-controlled resolution rule to the `config list` output. A submodule listing uses the superproject roots as the repository directories. A submodule path outside them is a location only, with digest `unchecked` (§6 "File facts"). Every local and worktree entry of a submodule is repository-controlled.
  - Reason: a global `core.sshCommand` can name a file in the superproject worktree. Each submodule fetch runs it, so each row that fetches lists it with its digest.
  - A submodule Git directory outside the superproject roots counts as repository-controlled by the path that Git prints. A program path in it enters the list as `unchecked`. Its hooks folder enters the list once, as `core.hooksPath` with digest `unchecked`. So does a hooks folder outside the roots that a repository-controlled `core.hooksPath` names. The service reads nothing there.
  - A `clone` row has no submodule Git directory before the update, so it lists the programs of the system, global, and command entries by these rules.
- For a submodule without a `.git` entry, Git runs the programs from the worktree that it connects. That worktree is the parent worktree root plus the submodule path. Relative program paths and a relative `core.hooksPath` resolve against that path. A kept Git directory without a plan row has no known path. Its relative program paths and a relative `core.hooksPath` then enter the list as `unchecked`. Its other program paths follow the superproject roots, as above.
- Relative values from every scope: §7 classes a relative `core.hooksPath` and a relative program path from any scope as repository-controlled. So is a bare-name program when the child `PATH` holds a relative entry. In a submodule, each such value resolves inside the submodule worktree. Git applies the system, global, and command entries in every submodule. So the review applies this rule to those entries of the superproject listing too.
- An update writes the worktree files of each `clone`, `reuse`, `checkout`, and `fetch-checkout` row. Git then runs the hook and program files of the target tree, which the review cannot digest first (probe S14). So each relative value enters the list once for each of these rows, as `unchecked`, at every depth. A relative `core.hooksPath` enters as its hooks directory. A `none` or `skip` row keeps its digested entries.
- Some rows have nested submodules that stay unknown until the update fetches ("Review reads"). Such a row lists each relative value once more for them, as `unchecked`.
- Reason for the two rules above: with a global `core.hooksPath=.githooks`, a `clone` row ran the cloned `post-checkout` and `reference-transaction` hooks. No confirmation went out, because the list was empty. A `checkout` row and a `fetch-checkout` row ran the target-tree versions of those hooks (probe S14).
- The list holds three kinds of entries:
  - Each repository-controlled integration that §7 names.
  - Each local or worktree entry outside the Git-written keys below.
  - Each file in the effective hooks directory whose name does not end in `.sample`.
- The service digests each listed program file by the §7 "Program file digests" rules and bounds. A file beyond a bound enters the list as `unchecked`.
- Git-written keys: `core.repositoryformatversion`, `core.filemode`, `core.bare`, `core.logallrefupdates`, `core.symlinks`, `core.ignorecase`, `core.precomposeunicode`, and `core.worktree`. Also `extensions.objectformat`, `extensions.refstorage`, `remote.<name>.url`, `remote.<name>.fetch`, `branch.<name>.remote`, and `branch.<name>.merge`. Also `submodule.<name>.url`, `submodule.<name>.active`, and each `submodule.<name>.update` value that does not start with `!`. A clone and a submodule initialization wrote only such keys (probes S2 and S5). None names a program. An `update` value that starts with `!` stays in the list.
- Reason: an update ran the `core.fsmonitor`, smudge filter, `post-checkout`, `post-index-change`, and `reference-transaction` hooks of a submodule (probe S3). A fetch ran its `remote.origin.uploadpack` (probe S6). An update also ran those programs in the kept Git directory of a deinitialized submodule. It ran them in the kept Git directory of its nested submodule too (probe S11).
- The fetch step of a row runs the same transport programs and hooks as the fetch inside Git's own update. Each fetch also starts `git maintenance run --auto --detach` (probe S19). So the list needs no extra entry for the fetch step.
- Nested levels: before each nested level, the service builds the program list of that level by these rules. Each entry must match a confirmed entry: the same row or Git directory, key or hook file, origin, and digest.
  - A confirmed `unchecked` entry covers the same relative value for the same row.
  - A row with unknown nested submodules has extra `unchecked` entries. They cover the same values for each nested row below that row.
  - Any other entry refuses the rows of that level with reason `programs` ("Refusals during the run"). No process starts for them.
  - In the normal case, a level adds no entry. The kept-directory walk found every kept Git directory. A new clone writes only Git-written keys (probe S2). An approved hook or an outside change can add one.
- Program re-check: right before each process that can start a program, the service builds the program entries again. This holds at every depth. These processes are each clone, connect, fetch, checkout, and register step, and each nested active-set read ("Plan"). The entries are those of each submodule Git directory that the process can use. For a step, that is the Git directory of its row. A nested row adds the Git directory of its parent submodule. For a nested active-set read, it is the Git directory of the parent submodule. The service digests each listed program file again. Each entry must match a confirmed entry by the rules above.
  - Before a step, any other entry ends the row `refused` with reason `programs`. No later process starts for the row.
  - Before a nested active-set read, any other entry refuses every row of that nested level with reason `programs`. The read does not start. The parent row keeps its state.
  - Reason: after the confirmation, a hook of an earlier row or an outside writer can change later programs. A fetch can run up to 4 hours, and a hook of an earlier step can write a program file. The nested-level rule covered only the rows that a level read adds.
- When the list is not empty, `updateSubmodules` sends the `trust` frame `confirmRun` after its preflight (§7 "Trust approval store"). The text is: "Update submodules runs <count> programs from submodule settings and hooks in <paths>. They can run any code on this computer." `<paths>` names at most 10 paths and then the count of the others. A kept Git directory without a plan row appears by its Git directory path. When the list holds `unchecked` entries, the text adds: "Arbareto cannot check <n> of them before the run." `<count>` counts each `unchecked` hooks directory as one program. A count of 1 reads "1 program". A decline ends the operation `canceled`, and no update process starts. The shell stores nothing, so the approval covers this operation only.
- The review token binds the digest of the list. A preflight that finds another list gives `STALE_REVIEW`.
- §7 "Submodule registration keys" keeps a stored superproject approval valid after the update. A submodule Git directory that an update creates enters only the list of a later review, never the stored fingerprint.

### Update protocol

1. Enter the mutation exclusion and wait for the recovery marker ID (§6).
2. Revalidate the review token with the review reads. Check the superproject HEAD, the index gitlinks, the `.gitmodules` digest, and the relevant configuration. Check each submodule HEAD and `.git` entry, the reachability of each target, each refusal, the program list digest, and trust. A changed value gives `STALE_REVIEW`, and a changed fingerprint gives `TRUST_CHANGED`. Consume the token only after validation.
3. Send `confirmRun` when the program list is not empty. The dialog has no time limit, and repository state can change while it is open.
   - After an `approved` reply, run the step 2 review reads again before step 4. Compare the same values with the consumed review. A changed value gives `STALE_REVIEW`, and a changed fingerprint gives `TRUST_CHANGED`.
   - The operation then ends `failed` with that code. No update process starts, and no reconciliation runs, because nothing changed. The recovery marker is resolved, so later mutations are not blocked.
   - The token stays consumed. A repeated request with it returns this operation (§2). A new review is needed.
   - Without `confirmRun`, step 4 follows step 2 at once, so no re-check runs.
4. Visit the rows. Top-level rows go in index order, except `skip` rows without the register step. After the last step of a row, the update visits the nested level of that row (step 6). Then the next row follows. This depth-first order follows Git's own recursion (probe S19).
5. Each row runs the steps of its kind. `<parent worktree>` is the superproject worktree root for a top-level row. For a nested row, it is the worktree of its parent submodule.
   - Clone step, for a `clone` row and a `reuse` row without a kept HEAD commit: `--no-lazy-fetch -c fetch.recurseSubmodules=no -C <parent worktree> submodule update --init --progress -- :(literal)<path>`. Git clones or connects, fetches when it needs to, and checks out. The row has no earlier HEAD to lose. The clone check below runs first. A `reuse` row also runs the folder check below first.
     - `-c fetch.recurseSubmodules=no` stops the on-demand recursion of the fetch inside this step. Without it, that fetch entered a nested kept Git directory of a `reuse` row and ran its hook (probe S27). Git then skips every submodule fetch (builtin/fetch.c:2819), also over a `submodule.<name>.fetchRecurseSubmodules` value. With the option, no nested program ran, and HEADs, settings, and nested refs equaled Git's own update (probe S27).
     - A connect step cannot replace this step for a `reuse` row without a kept HEAD. After the connect step, the `--no-fetch` checkout failed with "Unable to find current revision" (probe S27).
     - Difference: Git passes the option to its children through `GIT_CONFIG_PARAMETERS`, so a hook sees it (probe S27). A `git fetch` in such a hook then does not recurse. This is a deliberate difference, like `--no-lazy-fetch`.
   - Clone check, before each clone step. The folder part reads file types only and starts no process.
     - The worktree path must still hold no `.git` entry.
     - For a `clone` row, `<parent Git directory>/modules/<name>` must still be absent. For a `reuse` row without a kept HEAD, it must still exist, and `rev-parse --verify -q HEAD` in it must still find no commit.
     - Otherwise no clone step starts, and the row ends `refused`. The service runs the check reads below in the Git directory that it found. That is the worktree `.git` entry, or else `modules/<name>` with `--git-dir` and `--work-tree`.
     - When no ref holds the HEAD commit there, the reason is `unsaved-commits` with the found-folder text below and no command. Otherwise the reason is `changed-after-review` ("Refusals during the run").
     - Found-folder text: "Submodule <path> is at commit <short ID>, which no branch, tag, or other ref holds. Another program set up this submodule after the review. Save that commit in a terminal, then use Update submodules again."
     - Reason for no command: no review read that Git directory, so its programs are unlisted. The save-branch command runs its `reference-transaction` hook in the user's terminal (probe S11).
     - Reason: another tool can initialize the path after the review. The clone step then checked out in that unlisted Git directory and ran its hook. Its local commit lost its last ref (probe S26).
   - Register step, for a `skip` row with update mode `none` in the active set whose parent has no `submodule.<name>.url`: `--no-lazy-fetch -C <parent worktree> submodule init -- :(literal)<path>`. Git writes the keys that its own update writes and clones nothing (probe S33). The row has no other step.
     - It loads the parent index, as the active-set read does ("Plan"). A `skip` row outside the active set starts no process, because a pathspec would activate it (builtin/submodule--helper.c:596-597).
   - A `checkout` row runs the check and the checkout step below. So does a `reuse` row whose kept Git directory reaches the target.
   - A `fetch-checkout` row runs the steps below in order. So does a `reuse` row whose kept Git directory does not reach the target.
     1. Connect step, `reuse` only, after the folder check and the check below: `--no-lazy-fetch -C <parent worktree> submodule update --init --no-fetch --progress -- :(literal)<path>`. Git registers the row, creates and connects the folder, and removes the kept index. Its `checkout -q -f` then fails, because the target is missing (probe S22). Git's own update also connects before its fetch (probe S19).
        - The service checks that result with structured reads. A `.git` entry must exist, HEAD must equal the kept HEAD, and the target must stay unreachable. The row then continues with the first fetch.
        - Exit status 0 means that Git checked out a present target, and the row is done. A target that is present without a ref takes this path. Such a row skips the fetch of Git's own update, and a skipped fetch cannot remove a ref.
        - Any other result ends the row `failed`.
     2. First fetch: `--no-lazy-fetch -C <submodule worktree> fetch --progress --no-recurse-submodules`. Git's own update runs `fetch` with no remote and no refspec (builtin/submodule--helper.c:2516-2546, probe S19). `--progress` adds only progress output. A failed first fetch does not end the row, as in Git's own update. It counts as exit 0 when its row then reaches its target commit ("Reconciliation and outcome").
        - `--no-recurse-submodules` stops the fetch in nested submodules. Without it, the fetch recursed into a populated nested submodule whose new commit was missing (probe S25). With `fetch.recurseSubmodules=true`, it recursed into every populated nested submodule. That recursion runs nested programs and changes nested refs before the nested level read and check.
        - The update visits each nested level itself (step 6), and a nested row that needs a fetch runs its own first fetch there. So with the default `fetch.recurseSubmodules`, the nested commits and refs equal those of Git's own update.
        - Difference: with `fetch.recurseSubmodules=true`, Git's own update also fetches nested submodules that need no fetch. The app does not, so their remote-tracking refs can stay older. HEADs, the folder layout, and settings stay equal. This is a deliberate difference, like `--no-lazy-fetch`.
     3. Fallback fetch: the service runs the `rev-list` read again. When the target stays unreachable, it runs `--no-lazy-fetch -C <submodule worktree> fetch --progress --no-recurse-submodules -- <remote> <target>`. A fetch by commit ID also recursed without that option (probe S25). Git's own update runs the same fetch by commit ID (builtin/submodule--helper.c:2640-2668). A failed fallback fetch ends the row `failed` without a checkout, as in Git's own update (probe S21).
        - `--` keeps the remote name literal. Without it, a remote named `--upload-pack=<program>` ran that program, and with it, Git fetched from that remote (probe S31). The `remote-name` refusal blocks such a name too ("Refusals").
        - `<remote>` follows Git's `get_default_remote_submodule` (builtin/submodule--helper.c:77-115). It is the first remote whose URL equals the resolved `.gitmodules` URL. Otherwise it is the default remote ("Plan").
        - A relative `.gitmodules` URL resolves against the raw `remote.<default remote>.url` of the parent repository. Git's `resolve_relative_url` reads that key without a `url.<base>.insteadOf` rewrite (builtin/submodule--helper.c:53-75, probe S32). `relative_url` then joins the two (remote.c:2933-3003). The service takes the raw value from the parent `config list` output.
        - Without that key, Git resolves the URL against its current folder, the parent worktree root (probe S32). An absolute `.gitmodules` URL stays as written.
        - The submodule remote URLs come from `remote get-url --all -- <name>`. It applies `url.<base>.insteadOf`, as Git's `add_url_alias` does for each remote (remote.c:100-107, probe S23).
        - The match compares the resolved `.gitmodules` URL with these rewritten remote URLs, as `repo_remote_from_url` does (remote.c:1822-1835). In probe S32, the resolved URL differed from the rewritten remote URL, so no remote matched. The default remote then applies.
        - The rule depends on the Git version. The probed Git version of the registration selects the rule, and the service never infers it.
          - Below 2.56.0, the match uses the resolved `.gitmodules` URL as it is. Source: Git v2.55.0 (tag object `5ce91c059e41090e7d2cffad39c04af8acf98dc1`, commit `e9019fcafe0040228b8631c30f97ae1adb61bcdc`), `repo_remote_from_url` (remote.c:1812-1835) and `get_default_remote_submodule` (builtin/submodule--helper.c:77-115).
          - From 2.56.0, the match first rewrites the resolved `.gitmodules` URL with the `url.<base>.insteadOf` rules of the submodule, as `alias_url` does: the longest prefix wins, and the first base wins a tie. Source: Git v2.56.0 (tag object `2478544319491bbd2a42cc57a83e3d2f4730a280`, commit `a018953688f1b10bddf91bff8747068f5f4746a4`), `alias_url` (remote.c:49-73), `repo_remote_from_url` (remote.c:1840-1861), and `get_default_remote_submodule` (builtin/submodule--helper.c:77-119).
          - `relative_url` is equal in both versions (v2.55.0 remote.c:2933-3003, v2.56.0 remote.c:3026-3096).
          - Evidence, 2026-10-08: the submodule `insteadOf` rule `fake:` and the `.gitmodules` URL `fake:sub.git`, with remotes `a` and `b`. `get-default-remote` printed `origin` with Git 2.55.0 and `b` with Git 2.56.0.windows.1.
     4. The check and the checkout step below.
   - Folder check, for every `reuse` row, with or without a kept HEAD. The "Review reads" folder check runs again right before the first step of the row. That step is its clone, connect, or checkout step. The check starts no process.
     - A path that is neither absent nor an empty folder ends the row `refused` with reason `folder-not-empty`. No process starts for the row, and the files keep their bytes.
     - Before the checkout step that follows a connect step, the folder must hold only its `.git` entry. Otherwise the row also ends `refused` with that reason.
     - Reason: a writer can add files after the review or after the step 3 re-check. Git's `checkout -q -f` would overwrite them (probe S13).
   - Check, before each connect step and each checkout step: `rev-parse --verify -q HEAD` and `for-each-ref --contains=HEAD --count=1 --format=%(refname)`. A `reuse` row runs them in its kept Git directory before its connect step. Without a connect step, it runs them there before its checkout step.
     - In the kept Git directory, they use `--git-dir=<kept Git directory> --work-tree=<kept Git directory>`, as "Review reads" states. So an absent or empty folder never resolves to the superproject.
     - HEAD must equal its value at the review or at the level read (step 6). A ref must contain it, and every ref counts.
     - A missing ref ends the row `refused` with reason `unsaved-commits`, and no checkout runs (probe S20).
     - A changed HEAD ends the row without a checkout. Reconciliation states the row.
   - Checkout step: `--no-lazy-fetch -C <parent worktree> submodule update --init --no-fetch --progress -- :(literal)<path>`. `--no-fetch` stops the fetch of Git's own update. Without `--recursive`, Git visits no nested submodule (probe S20). With a missing target, Git fails with "Unable to checkout" and keeps HEAD (probe S20).
   - `:(literal)` keeps the path literal. A plain `sub[1]` pathspec matched `sub1` (probe S8). `--progress` makes Git report progress on stderr without a terminal.
   - Each process starts after the previous one exits, also after a failure (probe S7). A failed or refused row never stops the next row. The update visits no nested level of a failed or refused row, as Git's own update does (builtin/submodule--helper.c:2879-2885).
   - Read failures. Exit statuses decide each read result, because Git translates its messages. A read error never counts as an absent state.
     - `rev-parse --verify -q HEAD`: exit 0 with an object ID gives the commit. Output that is no object ID is a failure. A non-zero exit decides nothing. It only leads to `symbolic-ref -q HEAD` and then `show-ref --exists <ref>`, as in discovery (§6 "Registration bootstrap"). Only the `show-ref --exists` exit status decides: 2 means no commit (unborn), and 0 means that the ref is present, so the failed read is a failure. Any other result is a failure.
     - `for-each-ref --contains=HEAD`: exit 0 without output means no ref. A non-zero exit is a failure.
     - `rev-list -n 1 <target> --not --all`: a non-zero exit counts as unreachable, as Git's `is_tip_reachable` treats it (builtin/submodule--helper.c:2493-2514). The row then fetches, as in Git's own update.
     - `remote get-url --all -- <name>`: a non-zero exit is a failure. The row then runs no fallback fetch.
     - A `.gitmodules` URL that `relative_url` cannot resolve (an empty remote URL, no component left to strip, or a key without a value) ends its row `failed`. A `branch.` key with an empty subsection ("bad config key") ends the row `failed` the same way. No fallback fetch runs. The row result names the URL resolution and carries no command.
     - Folder and clone checks: a read error other than "not found" is a failure. It never counts as an absent path or an empty folder.
     - A failed check, `remote get-url`, or folder read ends its row `failed`. No later process starts for the row, and the update visits no level below it. The row result names the failed read and carries no command.
     - A failed level read (step 6) ends each listed nested row of that level `failed`, and no process starts below them. The parent row keeps its state, and its result names the failed read.
     - A read past its 30-second deadline follows the §5 deadline rule instead. The Job closes, and the operation reconciles with `DEADLINE`.
     - At the review, a failed folder read gives `REPOSITORY_UNAVAILABLE` with the path. Another failed review read ends the review `failed` with `GIT_FAILED`, and no token goes out.
6. Nested level: after the last step of a row, the service reads the nested level of that row. A `none` row gets the same read.
   - It runs the review reads inside the worktree of that submodule. The gitlinks come from its HEAD tree. It also reads its `.gitmodules`, its active set ("Plan"), each nested submodule, and each kept Git directory below it.
   - Each read keeps the 30-second deadline (§5). The §5 submodule review bound covers every row that the update visits. A row above that bound ends `refused` with reason `limit`.
   - It applies the refusals and the nested-level program rule ("Trust"). A row with a refusal ends `refused`, and the update visits no level below it. Every other row of the level runs step 5. Its uninitialized `update = none` rows in the active set run the register step, as Git's own recursive update registers them.
7. Honor Cancel at any time. Cancel closes the Job of the running process with every descendant. No later process or level starts.
8. Reconcile after the last row, a Cancel, a deadline, or a failure.

The update processes write no superproject index. The superproject index digest stayed equal in probe S1. So the protocol takes no canonical index lock. Git takes its own `config.lock` and submodule locks.

### Environment and console

- Update processes use the §7 `network` policy. Git then never prompts on a terminal.
- The `network` policy sets `GIT_PROTOCOL_FROM_USER=0`. Git's submodule command sets the same value for its children (git-submodule.sh:29-30). Without it, the fetch step allowed a `file` remote that Git's own update refused (probe S21). The value restricts transports and enables none.
- The app never sets or removes a `protocol.*`, `core.sshCommand`, or `credential.*` key, and never sets `GIT_SSH_COMMAND`.
- Like every Git process, each `network` process starts with `DETACHED_PROCESS`, so Git has no console (§6 "Console and input"). Git then starts `ssh` with `DETACHED_PROCESS` "to make ssh recognize that it has no console" (compat/mingw.c:2247-2263). So an SSH passphrase or unknown-host prompt fails, and its message enters the output tail. A direct native `ssh-keygen -y` with a passphrase key failed at once under `DETACHED_PROCESS` (research R14 S17). No SSH server was available for a probe, so the SSH failure stays unverified until T224 or T237 runs one.
- Limit: a `core.sshCommand` or `GIT_SSH_COMMAND` with arguments runs through `sh`. A native Windows OpenSSH program started that way gets an invisible console (§6 "Console and input"). Its passphrase prompt then waits, as `ssh-keygen -y` did under a hook (research R14 S17).
- Such a wait changed no I/O counter (probe S24). So after 15 seconds, the status shows the §6 stall notice. It offers Cancel and the remedy command of the running step. The 300-second inactivity deadline still ends the process. The user decided this on 2026-10-01 (spec Clarifications, FR-051).
- A configured credential helper can show its own window, such as the Git Credential Manager sign-in. `GIT_TERMINAL_PROMPT=0` turns off only its terminal prompts (research R14). Such a window does no I/O either, so the stall notice can appear while it waits. The notice text names that case.
- WSL repositories use wrapper mode `network` (§11 "Process launch"). Like every wrapper mode, it sets `GIT_TERMINAL_PROMPT=0` inside the distro and removes the controlling terminal.

### Network policy

- Git's `protocol.allow` defaults apply unchanged: `ext` is `never`, and `file` is `user` (git-config(1) `protocol.allow`).
- With `GIT_PROTOCOL_FROM_USER=0`, a `file` submodule URL fails unless configuration allows it (probes S6 and S21). An `ext::` URL failed and ran no program (probe S6).
- Tests enable local transport only through their owned global configuration: `protocol.file.allow=always`. The app never does.
- `--no-lazy-fetch` stays first, also in the fetch steps. It did not block the explicit clone or fetch of a submodule. Hooks saw `GIT_NO_LAZY_FETCH=1` (probes S1, S6, and S20).

### Progress

- The operation reports "Fetching submodule <path> (<i> of <n>)…" during a fetch step. It reports "Updating submodule <path> (<i> of <n>)…" during a clone, connect, checkout, or register step.
- `<n>` counts the rows that the update plans to visit, except `skip` rows without the register step. A nested level adds its new rows to `<n>` when the update reads it. The nested rows of a failed or refused row leave `<n>`. `<i>` names the row in progress.
- The service splits stderr into segments at CR and LF. It takes the last `NN% (a/b)` match of the newest segment as the percentage. Git prints that counter with the untranslated format `"%3u%% (%"PRIuMAX"/%"PRIuMAX")%s"` (progress.c:134). The service parses no other text, because Git translates it. A fetch with `--progress` printed such segments (probe S20).
- A segment without a match keeps the last percentage. A new process starts without a percentage.
- Besides the §2 identity fields, progress events carry only the phase, the stall flag, and `counters`. `counters` holds `rowIndex`, `rowCount`, and `percent` when a percentage exists. `rowIndex` is `<i>`, and `rowCount` is `<n>`. No row ID goes out. The phase is `fetch` or `update`, and §6 "Activity and stall notice" defines the flag. They carry no Git text. At most 4 events per second go out (§5).

### Deadlines and Cancel

- Inactivity deadline: each update process ends after 300 seconds without activity (§6 "Activity and stall notice"). This covers each clone, connect, fetch, checkout, and register step. The window leaves time for a credential helper sign-in.
- Reason: output alone is no activity signal. Git's own fetch runs without a progress option, and the checkout runs `checkout -q` (probe S16 trace). A silent local fetch read 120 MB and wrote 160 MB without an output byte (probe S16).
- Stall notice: after 15 seconds without activity, the status shows the §6 stall notice. It offers Cancel and the "Remedies" command of the running step. The notice ends no process.
- The shell enforces both limits from the request `limits` (§6 "Process fields"). At expiry it closes the Job, and the exit reply names `inactivity` or `ceiling`.
- Limits of the signal: a process that waits for console input or for a credential helper window does no I/O. It shows the stall notice and ends after 300 seconds. A helper that keeps doing I/O while it waits keeps the process alive until the ceiling. A lingering child of an earlier step stays in the same Job, so its I/O also counts.
- Ceiling: each update process ends after 4 hours, so every Git step has a finite limit.
- A deadline closes the Job at once, with every descendant. The operation moves to `reconciling` with `DEADLINE` and reason `inactivity` or `ceiling`. No later process or level starts. A 30-second read deadline in the update gives reason `deadline` (§9).
- Reconciliation keeps the reason. With no row effect, the update ends `failed` with `DEADLINE` and that reason. After a row changed or got a flag, it ends `failed-with-effects` with `FAILED_WITH_EFFECTS` and that reason (§9, "Reconciliation and outcome").
- Review, preflight, level, check, and reconciliation commands keep the 30-second deadline (§5).
- Cancel, the deadlines, Interrupt and close, and the lingering rules follow §6 and §8. Cancellation never undoes a finished row.
- Each update process counts its own 4 MiB toward the §5 diagnostic cap, because its stderr carries progress.

### Reconciliation and outcome

Reconciliation re-reads every plan row and every row that the run visited, with the review reads, and the superproject configuration. It runs after the last row, a Cancel, a deadline, or a failure. Each row gets one state:

- `cloned`, `moved` with the old and the new commit, `unchanged`, or `failed`.
- `clone-interrupted`, with the submodule folder path and the `clone-interrupted` remedy ("Refusals"). A killed clone left `<parent Git directory>/modules/<name>` with no refs, a `tmp_pack_*` file, the `.git` file, and the registered URL (probe S9). The service moves and removes no file.
- `changed-elsewhere`, for a HEAD that equals neither the old nor the target commit.
- `refused`, for a refusal during the run, with its reason, text, and remedy or none ("Refusals during the run"). HEAD keeps its commit.

Each row result also carries four flags. Three come from the phase record of the service. `fetched` is true when a fetch step of the row started. `connected` is true when a step started that can create the `.git` entry of the row. These steps are the clone step, the connect step, and the checkout step of a `reuse` row. `found` is true when the review did not list the row. Reconciliation reads HEAD, so it cannot see a fetch or a connection.

The fourth flag comes from reconciliation. `registered` is true when a `submodule.<name>.*` key of the parent configuration differs from its baseline. Reconciliation compares those keys for every row. So it sees a registration that `--init` wrote before Git refused the checkout of that row.

- Baseline: the preflight value, when the preflight read the configuration of the parent. A top-level row always has it. For any other nested row, the baseline is the value from the step 6 read of its level.
- A key that is absent at the baseline and present at reconciliation is a difference. A key that is present at the baseline and absent at reconciliation is a difference too.

The §8 "Observed locks" set applies, with the submodule locks.

Classification (data-model §7):

- `succeeded`: every process exited 0, and every row reached its planned state. A connect step that ends as "Update protocol" step 5 expects counts as exit 0. A failed first fetch counts as exit 0 when its row then reaches its target commit. A failed first fetch of a row that ends `refused` or `failed` counts as a failed process. A row that the review did not list reaches its planned state as `cloned`, `moved`, or `unchanged`. A registration that the plan notes is part of the planned state.
- `completed-with-effects`: every process exited 0, and no run read failed, but a row differs from its plan. A `refused` row is such a row, also when no row changed and no row has a flag.
- `failed`: a process or a run read failed, or a deadline fired. A deadline gives `DEADLINE` with its reason (§9). No row changed, and no row has the `fetched`, `connected`, or `registered` flag. A failed step 3 re-check also ends `failed`, with `STALE_REVIEW` or `TRUST_CHANGED` and no process.
- `failed-with-effects`: a process or a run read failed, or a Cancel or a deadline stopped work. A row changed, or a row has the `fetched`, `connected`, or `registered` flag. After a deadline, the code is `FAILED_WITH_EFFECTS` with the deadline reason (§9).
- `canceled`: a Cancel or a declined `confirmRun` stopped work before any row changed. No row has the `fetched`, `connected`, or `registered` flag.
- `unknown`: a reconciliation read failed or passed its deadline. The recovery marker stays (§8).

A fetch step counts as an effect, because it can write refs and objects, prune refs, and run hooks. A step that sets `connected` counts as an effect too. It writes the registration, the `.git` file, and `core.worktree`, and a connect step removes the kept index (probe S22). The `registered` flag counts as an effect, because Git wrote repository settings (FR-052).

Git refused to overwrite local changes in probe S7. That submodule kept its old HEAD and its changes, and the other rows still updated. Its row states `failed`, and the outcome is `failed-with-effects` when another row changed.

### Output tail

A failed update process carries its own `outputTail` by the §9 "Commit failure output" rules, with one change. A segment that ends with a lone CR replaces the earlier text of its line, as a terminal shows it. So progress lines collapse to their last state. CR LF still becomes LF.

### Remedies

A failed row, and a row whose step shows the stall notice, get a copyable PowerShell command for that step. Each value uses the §4 quoting rule.

- Fetch step: `& { $p = $env:GIT_PROTOCOL_FROM_USER; $env:GIT_PROTOCOL_FROM_USER = '0'; try { & '<selected Git path>' --no-lazy-fetch -C '<submodule worktree>' fetch --no-recurse-submodules } finally { $env:GIT_PROTOCOL_FROM_USER = $p } }`. After a fallback fetch, the Git part ends with `fetch --no-recurse-submodules -- '<remote>' '<full target ID>'`. The text is: "This command fetches this submodule in a terminal, where Git and SSH can ask for input. Then use Update submodules again."
  - The script block sets `GIT_PROTOCOL_FROM_USER=0` for that one Git command, as the `network` policy does. Without it, a pasted fetch allowed the `file` transport that the app's fetch blocks (probe S21).
  - `finally` restores the earlier value, also after Ctrl+C (Microsoft Learn `about_Try_Catch_Finally`). `$p` stays local to the script block. In PowerShell 7.6 and Windows PowerShell 5.1, it refused a `file` remote and kept the session value (probe S30).
- Connect or checkout step: `& '<selected Git path>' --no-lazy-fetch -C '<parent worktree>' submodule update --init --no-fetch -- ':(literal)<path>'`. The text is: "This command checks out this submodule in a terminal, where Git can ask for input. Then use Update submodules again."
- Clone step: `& '<selected Git path>' --no-lazy-fetch -C '<parent worktree>' submodule update --init -- ':(literal)<path>'`. The text is: "This command clones this submodule in a terminal, where Git and SSH can ask for input. Then use Update submodules again."
- Register step: `& '<selected Git path>' --no-lazy-fetch -C '<parent worktree>' submodule init -- ':(literal)<path>'`. The text is: "This command registers this submodule in a terminal. Then use Update submodules again."
- None of these commands passes `--recursive` or `-c fetch.recurseSubmodules=no`. The next Update submodules run reviews the nested submodules first. Git's submodule command sets `GIT_PROTOCOL_FROM_USER=0` itself (git-submodule.sh:29-30), so only the fetch command sets it.
- The update command of the `update-mode`, `gitdir-config`, and `limit` refusals runs Git's own update in a terminal: `& '<selected Git path>' --no-lazy-fetch -C '<parent worktree>' submodule update --init --recursive -- ':(literal)<path>'`.
  - The `update-mode` command names its refused row. So does a `gitdir-config` command for a submodule configuration. A superproject `gitdir-config` command and the `limit` command use `-C '<worktree root>'` and end before `--`.
  - Its text is: "This command runs Git's own recursive update without Arbareto's checks. Git can leave submodule commits without a ref. It can overwrite files in reused submodule folders and run a configured update command. Resolve every other refusal first."
  - Reason: Git's own update skips the `unsaved-commits` and `folder-not-empty` checks. It runs `checkout -q -f` in reused folders (probe S13) and can run a `!command` update mode (probe S5).
- WSL rows use the §11 "Remedy commands" form. A WSL fetch command needs an approved Git path without U+003D (§11).
- A value that the §4 quoting rule refuses gives no command. The row still shows its text.

### WSL repositories

- The same protocol runs through §11 with wrapper mode `network`. Clones and fetches run inside the distro with the distro's configuration and credentials.
- `setsid --wait` removes the controlling terminal of the update process, as it does for every WSL process (§11 "Process launch"). So a child that keeps running after Git lingers and counts, as on Windows. An SSH prompt in the distro fails at once, because it has no terminal.
- The inactivity deadline and the stall notice use the anchor I/O sum, never the Job `IO_COUNTERS` (§6). No WSL update ran with Git 2.55.0, so this signal is unverified for a real fetch (T232).
- The reference distro has Git 2.43.0, which the §11 floor refuses. So no WSL update ran with Git 2.55.0, and the WSL rows stay unverified.
