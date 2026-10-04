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
6. A native-first operation (§3) gets its native step. The shell first checks its renderer envelope with the generated serde type ("Schemas" below).
7. The shell forwards the bytes unchanged in the `public` frame. A native-first operation forwards its envelope with the native payload instead.

Only the service strict decoder refuses duplicate keys, nesting deeper than 16 levels, and unsafe integers. The zod schema of the envelope then validates the decoded value.

Rust and the compiled service use private inherited pipes. Frames contain a four-byte unsigned little-endian payload length followed by UTF-8 JSON.

Each pipe frame has a top-level `kind` field with the value `public`, `process`, `mutation`, `trust`, or `handshake`. A `public` frame holds one §2 request, its response, or a progress event. Its body is `{"kind":"public","request":<envelope>}`, `{"kind":"public","response":<response>}`, or `{"kind":"public","progress":<event>}`. A `handshake` frame holds the §6 "Startup handshake" frame or its reply. A `process`, `mutation`, or `trust` frame holds one message from §6 "Channel frames". The shell never forwards a `process`, `mutation`, `trust`, or `handshake` frame to the renderer. The renderer envelope in §2 has no `kind` field.

Reject a length header above the §5 frame bound before reading or allocating the body. The service answers it with a `public` response with `rejected`, `FRAME_LIMIT`, and `requestId` `null`. It then discards that many bytes without storing them. Reject invalid UTF-8, malformed JSON, duplicate object keys, excessive nesting, unknown fields, and unsupported protocol versions. Such a frame gets a `public` response with `rejected` and `INVALID_REQUEST`, or `PROTOCOL_VERSION` for an unsupported version. Its `requestId` is `null`, unless the frame holds a valid `requestId`. When the strict decoder refuses a `public` frame, the service reads `requestId` with a plain JSON parse. The shell forwards only bodies that its own JSON parse accepts. So each forwarded request gets a response with its `requestId`.

Use a strict bounded decoder. Do not rely on `JSON.parse` alone to reject duplicate keys.

**Schemas.** The zod 4 schemas in `src/contracts/` define the envelope, the payloads, the implemented results, and the progress event. They also define the handshake and the channel frames. TypeScript types come from `z.infer`. The service validates each strictly decoded value with these schemas. `bun run export:schemas` writes their JSON Schema files to `src/contracts/schemas/`. The shell build script generates serde types from these files with typify. JSON Schema has no byte bound, and typify drops `const` values and integer ranges. So both sides keep these rules as explicit checks: byte bounds, the UTF-16 path bound, `version` `1`, and integer ranges. serde also reads a struct from a JSON array. So the shell also compares the JSON shape of each typed value with its input. The golden vectors in `tests/vectors/` run in the Bun tests and in the Rust tests.

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
| `repositoryId` | Registered workspace identifier. Required for `readWorkspace`, `readHistory`, `readComparison`, `readTrust`, `approveTrust`, `revokeTrust`, `applyHunk`, `applyFile`, `reviewCommit`, `commit`, `reviewSubmodules`, and `updateSubmodules`. Other operations omit it. |
| `repositoryGeneration` | Nonnegative safe integer for snapshot-bound operations. It must match the supplied snapshot, review, or trust fingerprint. For `readHistory`, it must equal the current workspace generation. |
| `selectionId` | Renderer selection generation. `readComparison` requires it, and other operations omit it. The renderer issues it, so the service checks only its format. Never a mutation approval. |
| `payload` | Exact operation-specific object. Reject unknown fields. |

The bridge sends each envelope as a raw UTF-8 JSON `Uint8Array` body (§1 "Renderer request body"). The shell forwards these bytes unchanged. The renderer imports only the types of the zod schemas, so zod adds no renderer code.

Identifiers are UUID-shaped ASCII strings issued by the owning boundary. Validate format and session membership. Format alone never grants access. A malformed identifier gives `INVALID_REQUEST`. A well-formed identifier that this session did not issue gives `UNKNOWN_TARGET`. This includes a `sessionId` of another session, a released identifier, and an identifier of another workspace.

Require `repositoryGeneration` for `readHistory`, `readComparison`, `applyHunk`, `applyFile`, `reviewCommit`, `commit`, `reviewSubmodules`, `updateSubmodules`, and `approveTrust`. Match trust approval against its issued fingerprint generation.

`readWorkspace` may include the last observed generation, but a mismatch must not prevent refresh. Other operations omit this field. Cancellation, revocation, and closure must remain available after a repository generation changes.

Each request gets exactly one response, and that response is terminal. The shell returns it as the result of the `invoke` call of that request. A response contains `requestId`, `operationId` when the service issued one, repository generation where applicable, and a typed result. A request that the service rejects before admission has no `operationId`.

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
| `chooseGit` | Renderer: empty object. Service: exactly the native-issued `bootstrapId` and the probed `executablePath`, a fully qualified Windows path (§6 "Channel frames"). | Native executable proposal or selection, explicit approval, version probe, and installation ID. A success result holds `gitInstallationId`, `selectedPath`, `executablePath`, `version`, and `digest`. Cancel preserves the current selection. A success that issues a new `gitInstallationId` sends one `release` for the previous one (§6 "Channel frames"). A failed or canceled `chooseGit` releases nothing. "Git proposal" below defines the native step. |
| `chooseRepository` | Renderer: empty object. Service: only the native-issued `bootstrapId`. | Native folder selection and Git registration. The result holds the `repositoryId`, the current `generation`, and the `worktreeKey` ("Worktree key" below). Cancel preserves the current workspace. A WSL path follows §11, including the distro start and its Cancel. |
| `restoreWorkspace` | Renderer: empty object. Service: only the native-issued `bootstrapId`. | Revalidate the last explicitly chosen repository from application settings. No caller-supplied path. The result holds the `repositoryId`, the current `generation`, and the `worktreeKey`. A WSL path follows §11. |
| `readWorkspace` | `refresh: boolean` and `check: "full"` or `"changes"`. `refresh: true` with `check: "changes"` gives `INVALID_REQUEST`. | Git-derived identity, HEAD, operation state, status completeness, hunk-profile eligibility, snapshot ID, and recovery state. Only a user Refresh action sends `refresh: true`, always with `check: "full"`. Focus return and the first read send `refresh: false` with `check: "full"`. The read after a mutation outcome and the read after a trust approval also send `refresh: false` with `check: "full"`. Polls send `refresh: false` with `check: "changes"` (§8 "Change check"). WSL polls send `check: "full"` instead (§11 "Change polling"). An explicit refresh of a blocked workspace performs recovery reconciliation (§8). |
| `readHistory` | Empty object. The envelope carries `repositoryGeneration`. | Bounded HistoryPage: at most 100 checkout-reachable commits, ordered parents, boundary metadata, captured HEAD, and completeness. No arbitrary ref or pagination argument. The service captures HEAD itself and needs no status snapshot. It can run beside `readWorkspace` within the §5 read caps. Trust gating follows the read rule in §7. |
| `readComparison` | Current snapshot ID and issued entry ID. | One supported canonical comparison with hunk IDs, or an explicit unsupported/limited result. Every result also carries the file-action decision of its entry (§4 "File staging"). |
| `readTrust` | Empty object. The envelope carries `repositoryId`. | Safe execution-policy summary, approval fingerprint, trust `state`, and `persistence` (`stored` or `session`). Show configuration values only for the §7 value display allowlist. Redact URL user information first (§7). |
| `approveTrust` | `fingerprint`: the issued fingerprint. `approve`: `true`. Any other `approve` value gives `INVALID_REQUEST`. | The service checks the fingerprint and its generation. The shell then shows a native confirmation (§7 "Trust approval store"). Approve returns the trust ID, `persistence` (`stored` or `session`), and `saveFailed` (boolean). `saveFailed` is `true` only when the shell replied `stored: false` after `persist: true`. It stores the approval, or keeps it for the service session only over a digest bound (§7). Cancel returns `canceled` and stores nothing. A changed policy requires new approval. |
| `revokeTrust` | Current trust ID. | Delete the stored approval, revoke future executable operations, and invalidate dependent approvals. Running work needs explicit cancellation. The shell also closes every lingering Job of that common directory (§6 "Lingering Jobs"). The result states how many processes ended. An unfinished mutation of that common directory ends its processes at `ended` and never lingers (§6). Without a current trust ID, no remedy or outcome text offers Revoke trust (§9 "Lingering count"). |
| `applyHunk` | Comparison ID, hunk ID, snapshot ID, and direction `stage` or `unstage`. | Profile check, fresh validation, exact candidate publication, and reconciled outcome. No renderer patch or whole-file fallback. |
| `applyFile` | Comparison ID, snapshot ID, and direction `stage` or `unstage`. | Whole-file staging of the compared entry (§4 "File staging"). Profile check, fresh validation, verified candidate publication, and reconciled outcome. No renderer path, patch, or content. |
| `reviewCommit` | Current snapshot ID. | Complete staged scope, reviewed index/checkout, execution-policy disclosure, limitations, and one-use review token. Read-only inspection only. |
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

**Worktree key.** `worktreeKey` is 64 lowercase hex digits: the SHA-256 of the worktree root identity. For a Windows worktree, that identity is the volume serial number and the 128-bit file ID (§6). For a WSL worktree, it is the distro GUID, the UUID-derived file-system ID, and the inode number (§11). So both WSL prefixes of one folder give one key, and the key stays equal across sessions. The key grants no access; it only names the stored draft of that worktree (plan.md "Stored drafts"). No log or diagnostic receives it.

For `dismissRecoveryMarker`, the renderer payload holds only a marker ID that the shell owns. The shell binds a `repositoryDiscovery` context to the stored worktree path of that marker. It forwards the marker ID with the `bootstrapId`. When that path does not exist, the shell creates no context and forwards only the marker ID. A damaged marker has no stored worktree path, so the shell also forwards only its marker ID. The native confirmation comes after the service result (§6 "Dismissal").

Blank messages, empty staged scope, conflicts, unfinished operations, stale snapshots, and incomplete data refuse mutation. Missing trust refuses a mutation only when it can run a repository-controlled integration (§7 "Mutation trust").

Commit approval covers the full staged scope. It never means “commit the selected file”. Unsupported file diffs can remain in a complete commit review.

Approval authorizes standard Git execution after fresh preflight, not an immutable tree or destination. Preserve approved hooks and report late changes explicitly.

### HistoryPage result

Bind the result to its repository, the request `repositoryGeneration`, the captured HEAD target/OID, the shallow fingerprint, and scope `current-checkout`. The renderer keeps a page while its captured HEAD equals the newest observed HEAD. A generation change alone does not discard it. The renderer accepts a late history response when its captured HEAD equals the newest observed HEAD, whatever its generation. When a read observes another HEAD, the renderer requests `readHistory` once. After `REPOSITORY_CHANGED` for `readHistory`, the renderer resends it once with the current generation. Each row contains a full OID, ordered effective parent OIDs, subject, author, and date. It also carries the commit object's `encoding` header value, or none when the header is absent.

Use Git's child-before-parent date order. OID lengths follow the repository object format. Reject duplicate rows, malformed OIDs, and invalid in-page parent ordering.

Return separate page-boundary and shallow-boundary metadata. An unavailable parent is not a root. Show current HEAD/branch only from the captured identity; do not invent branch ownership for commits.

Resolve shallow metadata through Git and recheck its bounded fingerprint with the captured checkout. Missing objects give `limited` with `OBJECT_MISSING`, without fetching (§7 "Missing objects"). Graph-only layout limits remain frontend presentation state, not workspace mutation blockers.

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

**Limitation remedies.** `applyFile` refuses some entries ("File staging" below). Such an entry can still need staging or unstaging as a whole file. The service then attaches a copyable remedy command to the change entry. The app never runs it (FR-011).

- An entry that `applyFile` refuses with reason `size`, `rename`, `type`, `symlink`, `LFS`, `filter`, or `blob-proof` gets a remedy. Other reasons get none.
- A `stage` result with `GIT_FAILED` also carries the `add` remedy of its entry and an `outputTail` (§9).
- An Unstaged or Untracked entry gets `& '<selected Git path>' --literal-pathspecs -C '<worktree root>' add -- '<path>'`.
- A Staged entry gets the same form with `restore --staged -- '<path>'`. In an unborn repository, it uses `rm --cached -- '<path>'`, because `restore --staged` needs HEAD.
- A rename record names the source path and the destination path.
- Quoting rule. Every remedy command of this contract puts each interpolated value in single quotes. The values are the selected Git path, each worktree root, and each path. They also include each submodule worktree, Git directory, remote name, branch name, commit ID, and distro name.
- PowerShell ends a single-quoted string at five characters: U+0027, U+2018, U+2019, U+201A, and U+201B. Each of them inside a value is doubled. A research R5 probe showed that doubling keeps each of them literal. `--literal-pathspecs` keeps path characters literal.
- No command is offered when a value holds U+0022, U+201C, U+201D, or U+201E. The same holds for a control character or for bytes that are not valid UTF-8. Control characters are U+0000 to U+001F and U+007F to U+009F. The state then shows the value as plain text without Copy command.
- Reason: Windows PowerShell 5.1 passed a value with U+0022 to Git without its quotes. A value that starts with U+0022 merged with the next argument into one Git option (research R14 S28). PowerShell 7.6 kept each value literal. U+201C to U+201E and control characters stayed literal in both shells. The rule still refuses them, because PowerShell reads U+201C to U+201E as double quotes outside single quotes. PowerShell cannot hold invalid UTF-8 bytes.
- No command is offered when a value ends in U+005C. The only exception is a drive root: one letter, U+003A, and U+005C, such as `D:\`.
- Reason (research R14 S34): Windows PowerShell 5.1 puts an argument in double quotes when it holds white space. U+0020, U+00A0, U+2002, and U+3000 each caused this. Every interpolated value but one ends its argument, so the closing quote follows its last character. The exception is the System32 path of the §11 form, which `\wsl.exe` follows. One trailing U+005C escaped that quote, and the value merged with the next argument. Two became one, so the value changed. PowerShell 7.6 kept each value literal.
- Without white space, 5.1 adds no quotes, and a trailing U+005C stayed literal. The rule still refuses such a value, because this is the stricter reading. A drive root holds no white space, and both shells passed `D:\` literally.
- Path form. The service removes each trailing U+005C and U+002F from a Windows path that it puts in a command. A drive root keeps its separator, such as `D:\`. So no built Windows path ends in U+005C, except a drive root. The rule changes no other character of the path.
- Exception: the §6 `safe.directory` path stays as Git reported it, because Git compares that text. The U+005C refusal above still applies to it.
- A UNC share root also loses its trailing separator, such as `\\server\share`. No probe ran Git with such a root, so that form stays unverified (research R14 S34). A WSL command takes Linux paths unchanged (§11).
- The §6 dubious-ownership command, the §9 hook remedy, and the §11 and §12 commands use this rule. One shared builder applies it.
- The remedy text is: "This command stages or unstages the whole file with your Git settings. Run it in a terminal."

Disable executable external diffs and text conversion for supported inspection. Ordinary Git EOL conversion remains distinct from custom filters.

For tracked entries, generate hunks as `git add -p` does: `diff-files` to stage, `diff-index --cached` to unstage. Git's diff demotes a `core.safecrlf` failure to a warning, so hunks follow `git add -p`, not `git add`. Refuse a hunk request when `ls-files --eol` reports `mixed` for the index or working side. Its reason is `line-endings` (data-model §5), and it applies to hunks only. `ls-files --eol` reports `i/none` for a missing index blob and exits 0 (research R5). So a missing object is detected only by the §7 object check, never from `ls-files --eol`.

For untracked entries, T092 selects the method. A `diff` form carries `--no-ext-diff --no-textconv`, such as `diff --no-index --no-ext-diff --no-textconv -- /dev/null <path>`. Both flags are necessary: without them, `diff --no-index` ran `diff.external` and `textconv` in a research R5 probe. They are not sufficient: the clean filter still ran. So `check-attr` runs first, and a `filter` attribute gives reason `filter` before any untracked diff runs. The §7 read gate still blocks every read while a repository-controlled clean filter lacks approval.

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

**Candidate time.** A copied candidate gets a last-write time 100 ns before the canonical index time. The service sets it after the copy and reads it back. A later time refuses the request before any Git step. Git treats an entry as racily clean when its mtime is not older than the index file time (Git `Documentation/technical/racy-git.adoc`). A copy with a new time loses that protection (research R3 probe 8):

- `update-index --add` on such a candidate kept the old blob of a same-size change in 2 of 20 runs.
- A published `apply --cached` candidate hid an unrelated working change from later `status` in 10 of 30 runs.
- With the canonical time kept, both failures stayed at 0 of 20 and 0 of 30.

An earlier time only makes more entries racy, so Git compares their content. A `\\wsl.localhost` view rounds the Linux time to 100 ns and can round it up (research R13 probe P5). The 100 ns step keeps the candidate time at or before the canonical time there too.

Verify exact candidate bytes, entry existence, mode, stage, and unrelated logical index entries against the independent expected result. Applicability, full-index headers, or a second apply test are insufficient.

Before publication, recheck canonical index bytes, working content, checkout, attributes, configuration, trust, and operation state. Every detected mismatch prevents publication. Honor cancellation before publication begins. Publish only the verified candidate through the owned lock's same-volume replacement.

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
- `symlink`: a symbolic link on either side.
- `submodule`: a gitlink on either side, or an untracked nested repository.
- `index-flag`: an intent-to-add, assume-unchanged, or skip-worktree entry.
- `path`: the data-model §5 path rule applies.
- `rename`: an Unstaged rename record. Only `stage` meets it.
- `filter` or `LFS`: a `filter` attribute on a `stage` path. `unstage` runs no filter, so it accepts such a path.
- `size`: a `stage` working file above the §5 whole-file bound.
- `blob-proof`: no proof of the staged blob holds at step 6 ("Blob proof" below). Only `stage` meets it, and never in `readComparison`.

The hunk reason `line-endings` never refuses a file action. `stage` accepts mixed line endings (table above).

**Binding.** A file approval binds the comparison values at the start of §4, except the canonical diff and the hunk identity. It binds the index entry and the HEAD entry of each changed path. For `stage`, the working-file values are the existence, type, size, and raw SHA-256 of the whole working file. The service streams the file to compute the digest. `unstage` reads and writes no working file, so it omits the working-file values.

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

Each proof accepts cases that the other refuses (research R3 probe 7). Mixed line endings over an LF-only index blob and `ident` fail proof A and pass proof B. A CR in the index blob under `core.autocrlf=true` fails proof B and passes proof A. Two cases equal `git add` and still fail both proofs. They are an attribute file that only the index holds, and a CR index blob with `ident`. A simulated writer failed both proofs. A writer that changed only line endings under `core.autocrlf=true` passed both, because Git stored the same blob.

When both proofs fail, the service digests the working file again. A changed digest gives `STALE_SELECTION`. Otherwise the service cannot tell a writer from an unprovable conversion. The result is then `UNSUPPORTED_COMPARISON` with reason `blob-proof` and the `add` remedy of the entry. Its text is: "Arbareto cannot prove the staged content of this file. The file can have changed during staging, or Git's conversion can depend on the index. Use the command in a terminal." No publication follows either result.

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
| Concurrent reads | 2 per workspace, 4 globally |
| Pending reads | 8 globally; superseded selection reads are canceled |
| Mutations | 1 per common repository; reject overlap without queueing old approvals |
| Ordinary read deadline | 30 seconds. `reviewSubmodules`, the `updateSubmodules` preflight, and its level reads have no total read deadline. Each of their Git commands has the 30-second deadline below, and the submodule review bound limits the command count. |
| Commit process deadline | 120 seconds, followed by interruption and reconciliation |
| Other Git process deadline | 30 seconds for each bootstrap probe, and for each `applyHunk` or `applyFile` Git step. The same deadline applies to each commit preflight read, `reviewSubmodules` read, and mutation reconciliation read. It also applies to each `updateSubmodules` preflight read, level read, and check read (§12). "Deadline outcomes" below states the result. |
| Submodule update process | Inactivity deadline: each update process ends after 300 seconds without output or an I/O sum change. Each has a ceiling of 4 hours (§12 "Deadlines and Cancel"). |
| Stall notice | 15 seconds without an output byte and without a change of the I/O sum. It applies to the commit process and to each submodule update process. It shows a notice and ends nothing (§6 "Activity and stall notice"). |
| Submodule review | 256 submodules at all depths, 8 nesting levels below the superproject, and 1 MiB for each `.gitmodules` source. Each folder of the §12 kept-directory walk counts as one submodule. A larger set gives `UNSUPPORTED_SUBMODULE` with reason `limit` (§12). |
| Submodule progress events | 4 per second for each operation (§12 "Progress"). |
| WSL distro start | 60 seconds for the Git probe of a distro that the running list does not name (§11 "Distro start"). A deadline gives `DEADLINE`. |
| WSL poll gap | 1 second after the previous poll of that workspace ends, only while the main window has focus (§11 "Change polling"). |
| WSL anchor count | One line with the count and the I/O sum for each stdin line. After stdin closes, one line each second (§11 "Process ownership"). While a commit or submodule update process runs, the shell writes one stdin line each second (§6). |
| Commit failure output tail | Last 16 KiB and at most 100 lines of commit stderr (§9 "Commit failure output") |
| Cancellation/reconciliation target | 5 seconds; report unknown if state cannot be confirmed |
| Recovery markers | 4 KiB per marker and 64 markers per handshake. Above 64, the shell loads the 64 oldest markers. `getEnvironment` reports the limit and the count of files that the shell did not load. Every mutation stays blocked with `STATE_UNKNOWN`. Dismissal (§6) stays available. The block ends at the next handshake that finds at most 64 marker files. Damaged marker files do not count toward this limit (§6 "Damaged markers"). |
| Damaged recovery markers | 64 per handshake, in file-name order. A further damaged file stays unlisted until dismissals free a place. It blocks no mutation. |
| Confirmed-close cleanup target | 5 seconds |

**Deadline outcomes.** Every Git process has a deadline. A deadline closes the Job of that process at once, with every descendant.

- A bootstrap probe deadline destroys the context. The registration or dismissal gives `DEADLINE`.
- A deadline of an `applyHunk` or `applyFile` Git step moves the mutation to `reconciling` (data-model §7). So does a commit preflight read deadline. Neither publication nor Git execution has started. Without observed effects, the result is `failed` with `DEADLINE`. The service releases its owned lock only after the Job closes.
- A mutation reconciliation read deadline fails reconciliation. The outcome is `unknown`, and the recovery marker stays (§8).
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

`startedAt` and `approvedAt` are UTC times in RFC 3339 form. `commonIdentity` uses the form of an identity reply ("Process fields"). `worktreeIdentity` holds the identity replies of `worktreeRoot` and `gitDirectory`, in that order. `configurationFingerprint` and `digest` are 64 lowercase hex digits. `executablePath` and `gitSelectedPath` follow the path rule of "Channel frames".

The service validates the frame with the strict decoder and the zod handshake schema (§1 "Schemas"). It replies `{"kind":"handshake","handshake":{"sessionId":"<ID>"}}`. `getEnvironment` takes its facts and markers only from this frame.

- A missing field, an unknown field, or a wrong type fails the handshake. So do more than 64 markers, more than 64 damaged markers, or more than 256 records.
- A failed handshake gets `{"kind":"handshake","handshake":{"code":"<code>"}}`. The code is `PROTOCOL_VERSION` for another `version`, otherwise `INVALID_REQUEST`. The service then exits, and the shell treats this as a failed handshake (§2).
- A second handshake in a session gets that failure reply with `INVALID_REQUEST`. The session continues unchanged.
- A `public` frame before the handshake gets `rejected` with `SERVICE_UNAVAILABLE`.

### Registration bootstrap

The native shell creates temporary contexts for `chooseGit`, `chooseRepository`, `restoreWorkspace`, and `dismissRecoveryMarker`. It also creates one for the saved selected Git path at each startup handshake ("Startup contexts" below). A context binds the selected path, physical identity, session, permitted probe, and expiry.

Every physical identity is native: the 64-bit volume serial number and the 128-bit file ID from `GetFileInformationByHandleEx` with `FileIdInfo`. The 64-bit file ID is not unique on ReFS, FAT, or exFAT (research R2). The service never reads an identity through Bun `fs.stat`. It sends an identity request (below) for each Git-resolved path. An all-zero or all-ones file ID, or a failed call, refuses registration with `UNSUPPORTED_REPOSITORY`. The remedy is: open the repository from an NTFS or ReFS volume.

The renderer cannot supply or replace those paths. Restoration uses only the application-owned last-selection setting and requires fresh validation.

**Startup contexts.** Two saved selections need contexts without a dialog:

- Saved Git: the shell creates one `gitProbe` context for the saved selected path at each startup handshake. This includes the handshake after Restart service. The handshake carries its `bootstrapId` in `savedGit`, with both saved paths, the version text, and the digest. A settings file without a selected path uses the resolved path as the selected path. When the shell cannot read the selected file, `savedGit` has no `bootstrapId`. The service then gives `GIT_UNAVAILABLE` with reason `selected-missing` and the selected path. The service revalidates the Git before it answers its first public request. The probe runs `--exec-path` with the selected path in the startup context (§3 "Git proposal"). It resolves `git.exe` in the printed folder again, so the stored resolved path and digest do not decide. A Git upgrade can move that file, for example from `mingw64` to `ucrt64`. The installation root is the folder two levels above the selected file. For `C:\Git\cmd\git.exe`, the root is `C:\Git`. For `C:\Git\mingw64\bin\git.exe`, it is `C:\Git\mingw64`. The service admits a resolved file inside that root without the confirmation. A different version or digest gives no `GIT_CHANGED`. Output without one folder line gives `GIT_UNAVAILABLE` with reason `resolution-failed`. A missing or non-regular resolved file gives `GIT_UNAVAILABLE` with reason `resolved-missing` and its path. A resolved file outside the root gives `GIT_UNAVAILABLE` with reason `outside-installation`. For a resolved file other than the selected path, the service sends `resolveGit`. The new context stays a startup context. The version probe and the registration then run in that context without the confirmation. The admission rule of `chooseGit` applies, so an old version or another architecture gives `GIT_UNSUPPORTED`. The `register` request carries the version and the digest. After an approved startup `register`, the shell saves the new resolved path, version, and digest. It keeps the selected path. When the admitted version differs from the saved version, `getEnvironment` reports the saved one as `previousVersion`. The boot view then shows the non-blocking line `Git updated: <previousVersion> → <version>`. The next start finds the new version saved, so that line does not show again. The shell refuses a `register` without the confirmation outside a startup context with `INVALID_REQUEST`. Without a saved Git, the handshake carries no `savedGit`, and Git stays unselected.
- Last repository: the shell creates no context at startup. Each `restoreWorkspace` request creates one `repositoryDiscovery` context for the stored last-selection path.

| Context | Permitted execution | Completion |
| --- | --- | --- |
| `gitProbe` | Selected executable with the fixed arguments `--exec-path` or `version --build-options`. No `--no-lazy-fetch` (§7 "Missing objects"). It runs from the application-owned launch directory. | Validate executable identity, version, architecture, and admission policy before issuing `gitInstallationId`. |
| `repositoryDiscovery` | Admitted Git in the selected directory. Only fixed discovery profiles using `rev-parse`, `symbolic-ref`, and `show-ref`. A `repositoryDiscovery` context permits `symbolic-ref` only with the options `-q`, `--quiet`, and `--short` and exactly one ref name, `HEAD`. The shell refuses every other `symbolic-ref` form, such as `-d`, `--delete`, `-m`, a second name, or no name. | Resolve and validate repository paths, formats, HEAD state, and physical identities before issuing `repositoryId`. Refuse registration when `--is-bare-repository` or `--is-inside-git-dir` reports true, with `UNSUPPORTED_REPOSITORY`. For a bare repository, the remedy is: open a worktree of it, or clone it. For a Git administration folder, the remedy is: open the working folder that contains it. Classify Git's ownership refusal as `DUBIOUS_OWNERSHIP` by exit status and message prefix. Show the path and a remedy command that the service builds, and never run that command. Never offer Git's suggested command, because Git quotes it for a POSIX shell. PowerShell parsed `$(calc)` in that text as a subexpression (research R5). Under the fixed C locale, one stderr line starts with `fatal: detected dubious ownership in repository at '`. The path runs from that prefix to the last `'` of that line. The command is `& '<selected Git path>' config --global --add safe.directory '<path>'` with the §4 quoting rule. A WSL repository gets the §11 "Remedy commands" form. A message without that prefix gets no command. So does a path that the §4 quoting rule refuses, but the path still shows. Classify a folder outside every repository as `NOT_A_REPOSITORY`: exit status 128 and a stderr prefix `fatal: not a git repository (or any` (research R2). The remedy is: "Open a folder inside a Git repository." A probe past its §5 deadline gives `DEADLINE`. Other discovery failures use `REPOSITORY_UNAVAILABLE`. |
| `registeredOperation` | Service-constructed Git operation against registered Git and repository IDs. | Normal operation and reconciliation rules apply. |

Discovery profiles use only the documented identity queries in `research.md`. They accept no renderer-provided arguments, refs, paths, or environment overrides.

Discovery probes run under a fixed C locale, so Git messages stay unlocalized. Ownership and bare-repository refusals come before the configuration listing in §7.

A WSL path gets its route, identity, Git, and process rules from §11. Its identity comes from the §11 `stat` probe, never from `FileIdInfo`.

No discovery profile loads the index, because an index load can run a command-valued `core.fsmonitor` before trust approval. So discovery never runs `rev-parse --shared-index-path` (research R2). Split-index state comes from the raw index bytes (§4). A research R2 probe ran every discovery and trust-listing query with repository canaries, and none ran.

The service constructs the fixed probe arrays and parses their results. Native code validates the context and selected target, not Git semantics.

A bootstrap context lasts at most 60 seconds and belongs to one registration or marker dismissal. It can perform that operation's required discovery probes. Cancellation, failure, completion, or service restart destroys it.

Revalidate the selected file/directory identity before execution and registration. A changed target requires a new selection. No bootstrap context permits mutation or general repository reads.

Permanent IDs become valid only after successful registration. Bootstrap probes use the same Job ownership, output bounds, environment controls, and failure cleanup. Each probe process also has the §5 30-second deadline. Each discovery probe passes `--no-lazy-fetch`, and the `gitProbe` exec-path and version probes run without it (§7 "Missing objects").

### Registration reuse and release

The scope is one main workspace. A registration whose worktree identity equals a registered workspace returns that `repositoryId`. It registers nothing new. A registration of another common-directory identity releases every registered workspace of the previous one. Linked worktrees of one common directory stay registered together.

A release invalidates the released `repositoryId` and its snapshots, comparisons, approvals, and trust ID. It cancels the reads of that workspace and stops its watcher. A registration that would release a workspace with an unfinished mutation gives `BUSY`, and nothing changes. An unfinished mutation is `running`, `cancel-requested`, or `reconciling`. Operation records, retained verification data (§5), and recovery markers survive a release. A later registration that matches an unresolved marker starts in `unknown` (§8).

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

An identity request is a `process` frame with `operationId`, `contextKind`, and the bootstrap or repository ID. It carries at most 8 absolute paths. Each path has at most 32,767 UTF-16 units and no NUL. The shell opens each path with `FILE_READ_ATTRIBUTES`, full sharing, and `FILE_FLAG_BACKUP_SEMANTICS`. It follows junctions and reads no file data. It returns only each identity or the code `UNSUPPORTED_REPOSITORY`. A Windows identity reply is `{"volumeSerial":"<16 lowercase hex digits>","fileId":"<32 lowercase hex digits>"}` from `FILE_ID_INFO`. `volumeSerial` is the 64-bit `VolumeSerialNumber`, and `fileId` is the 128-bit `FILE_ID_128` `Identifier` bytes in array order. A path can lie outside the selected directory, because a linked worktree's common directory can live elsewhere.

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
- WSL I/O sum: the Job holds only `wsl.exe` and the anchor (§11 "Process ownership"). While a tracked process runs, the shell writes one stdin line to the anchor each second. The anchor answers with its count and the I/O sum of the operation scopes. The sum can drop when a child exits before its parent reaps it. So any change counts as activity.
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

- The mutex name ends with the SHA-256 of the identity text, as 64 lowercase hex digits. The identity text is `volumeSerial` (16 lowercase hex digits) then `fileId` (32 lowercase hex digits) in UTF-8, without a separator.
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

- Dismissal allowed: the payload holds no `bootstrapId`, so the service runs no discovery. Discovery also allows it when Git reports `REPOSITORY_UNAVAILABLE` or `NOT_A_REPOSITORY`. It allows it when the resolved common-directory identity differs from the marker identity.
- Dismissal refused: any other result. The code is `STATE_UNKNOWN` with the remedy "Open this repository and use Refresh."

A damaged marker needs no repository context. The shell creates no context and forwards only its marker ID, so the service allows the dismissal.

When dismissal is allowed, the shell shows a native confirmation. It names the worktree path, the operation kind, and the start time. For a damaged marker, it names the file name instead. It states that the operation outcome stays unknown. Its buttons are Dismiss and Cancel, and Cancel is the default. Enter on the default, Escape, Alt+F4, the close button, and a call failure mean Cancel. Only the Dismiss button deletes the file. A dismissed marker never counts as a resolved outcome.

### Channel frames

This subsection defines the bodies of `process`, `mutation`, and `trust` frames. A frame body is `{"kind":"<kind>","<kind>":{…}}` with exactly these two keys. The inner object always has `type`. The strict decoder of §1 applies in both directions. The service validates each frame with its zod schema (§1 "Schemas"). The shell reads `mutation` and `trust` frames into the generated serde types. It still checks each path by the path rule below, because typify counts characters, not UTF-16 units. `process` frames keep hand-written field checks in the shell. Their rules depend on each other and on context state, such as `input` or `inputBytes` and `transactionId` with `indexFile`.

- `callId`: the service issues a new UUID-shaped identifier for each request that expects a reply. Every reply repeats `callId`.
- A reply repeats the request `type`, except the `run` and `input` replies and `refused`.
- `ended`, `resolved`, `release`, and `closeJob` carry no `callId` and get no reply.
- `cancel` and `input` carry the `callId` of their `run` request.
- Paths are absolute, have 1 to 32,767 UTF-16 units, and hold no NUL or lone surrogate. A path never starts with the device prefix `\\.\` or `\\?\`, with either separator.
- Bytes travel as standard base64 with padding. A decoded chunk holds 1 to 65,536 bytes.

**Process requests.** The service sends these with `kind` `process`.

| `type` | Fields | Shell behavior |
| --- | --- | --- |
| `run` | `callId`, `operationId`, `contextKind`, the context IDs, `arguments`, `environmentPolicy`, `limits`. Optional: `input` or `inputBytes`, `transactionId` with `indexFile`. | Validates each field by "Process fields" and the rules below. Starts one process, or replies `refused`. |
| `input` | `callId`, `data`. | Writes the chunk to the child stdin, then replies `inputWritten`. |
| `cancel` | `callId`. | Closes the Job of the operation that owns that call, with every descendant. Each process of that operation then gets `exit`. A cancel for an ended call is dropped. |
| `identity` | `callId`, `operationId`, `contextKind`, the context IDs, `paths`: 1 to 8 paths. | Replies `identity` with one entry per path, in request order. |
| `lingeringCount` | `callId`, `operationId`, `commonDirectory`. | Replies `lingeringCount` with the active process count of the lingering Jobs with that tag. An unreadable identity gives 0. |
| `register` | `callId`, `operationId`, `bootstrapId`, `gitInstallationId`, and either `version`, `digest`, and `confirm`, or `repositoryId`, `worktreeRoot`, `gitDirectory`, and `commonDirectory`. `version` is the parsed version text, such as `2.55.0.windows.3`, not the full output line. `digest` is the SHA-256 of the probed file as 64 lowercase hex digits. | Binds the issued ID to the native context of `bootstrapId`. A `register` without the confirmation is valid only in a startup context. The shell then saves the Git ("Startup contexts"). |
| `resolveGit` | `callId`, `operationId`, and `bootstrapId` of a live `gitProbe` context. `executablePath`: `git.exe` in the folder that `--exec-path` printed (§3 "Git proposal"). | It refuses another file name and a path that is not a regular file with `INVALID_REQUEST`. This rule also covers a startup context. The service checks the installation root ("Startup contexts"). Otherwise it destroys the context, binds a new `gitProbe` context of that operation to the file, and replies `resolveGit`. The new context keeps the selected path and the startup state. |
| `release` | Exactly one of `repositoryId` or `gitInstallationId`. | Removes the binding. A later request with that ID gets `refused` with `UNKNOWN_TARGET`. |
| `closeJob` | `operationId`. | Closes that operation Job with every descendant. The ID is then inactive. |

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
| `identity` | `callId`, `identities`. | Each entry is an identity reply ("Process fields") or `{"code":"UNSUPPORTED_REPOSITORY"}`. |
| `lingeringCount` | `callId`, `count`. | Nonnegative safe integer. |
| `register` | `callId`, `result`: `approved`, `declined`, or `another`. With `another`, also `bootstrapId` and `executablePath` of the new `gitProbe` context. `executablePath` is a fully qualified Windows path by the channel path rule. | Git with `confirm: true`: the Git selection confirmation result. Otherwise `approved`. |
| `resolveGit` | `callId`, `bootstrapId`. | The new `gitProbe` context for the resolved file. The first context ID is no longer valid. |

- `exitCode` is an integer from 0 to 4,294,967,295. It is `null` when a Job close ended the process.
- `deadline` is `deadline`, `inactivity`, or `ceiling`. It names the expired limit.
- `activeDescendants` is the active process count of the Job at the exit ("Lingering Jobs").
- `refused` codes: `INVALID_REQUEST` for a field that breaks a rule. `UNKNOWN_TARGET` for an inactive or unbound ID or an expired context.
- More `refused` codes: `GIT_CHANGED` for a changed executable identity. `PROCESS_OWNERSHIP_FAILED` for a failed start in the Job or a failed resume.

**Backpressure.** The shell keeps at most 8 chunks per stream. A chunk leaves the queue when its frame write returns. A full queue stops the reads of that child pipe, so Git waits on its write. The service handles each frame before it reads the next frame. It never queues output frames itself. Streamed input uses `inputWritten` instead, so the shell never blocks its service pipe reader.

**Byte caps.** The shell forwards every byte before the completion signal. It enforces only the chunk size and the queue depth. The service retains at most 64 KiB per stream for diagnostics (§5). It counts every forwarded stderr byte of the operation. At 4 MiB it sends `cancel` (§9). An `updateSubmodules` process counts its own 4 MiB. A stream above its §5 result bound also gets `cancel`.

**Mutation frames.** "Recovery markers" defines their use.

| `type` | Fields | Reply |
| --- | --- | --- |
| `started` | `callId`, `operationId`, `repositoryId`, `kind`: one mutation name of §3, `worktreeRoot`, `commonDirectory`. | `{type, callId, markerId}`, `{type, callId, busy: true}`, or `{type, callId, failure, folder}`. |
| `ended` | `operationId`, `endProcesses`: boolean. | None. Only after a `started` reply with `markerId`. |
| `resolved` | `markerId`. | None. |

- `failure` is `disk-full`, `access-denied`, or `other`. `folder` is the `recovery` folder path.
- An unreadable common-directory identity gives `failure` `other`.
- A `busy` or failure reply holds no mutex and no marker. The service then sends `closeJob`, not `ended`.

**Trust frames.** §7 "Trust approval store" defines their use.

| `type` | Fields | Reply |
| --- | --- | --- |
| `confirm` | `callId`, `worktreeRoot`, `gitDirectory`, `commonDirectory`, `gitSelectedPath`, `fingerprint`, `persist`: boolean. With `persist: false`, also `bound`. | `{type, callId, result}`: `approved` or `declined`. `approved` also carries `stored`. With `stored: true`, the reply also holds `record` in the handshake record form. `stored: false` has no `record`. It follows `persist: false` or a failed record write (§7 "Trust approval store"). |
| `revoke` | `callId`, `commonDirectory`. | `{type, callId, endedProcesses}`: a nonnegative safe integer. |
| `confirmRun` | `callId`, `worktreeRoot`, `submodulePaths`: 1 to 256 paths in display order, `programCount`: at least 1, `uncheckedCount`: 0 to `programCount`. | `{type, callId, result}`: `approved` or `declined`. |

- `fingerprint` is 64 lowercase hex digits. `gitSelectedPath` is a fully qualified Windows path by the channel path rule.
- `bound` is `file-count`, `file-bytes`, or `total-bytes` (§7 "Program file digests").
- An unreadable common-directory identity gives `revoke` the reply `endedProcesses` 0, as for `lingeringCount`.
- A service exit closes each open trust dialog as Cancel. The shell then writes and deletes no record.

**Errors.**

- The service drops a reply with an unknown `callId`.
- A reply that breaks its shape gets a `public` response with `rejected`, `INVALID_REQUEST`, and `requestId` `null` (§1).
- For a `run` call, that reply also makes the service send `cancel`. It ignores later output and waits for `exit`. The call then fails with `PROCESS_OWNERSHIP_FAILED`.
- A malformed `exit` fails its call at once with `PROCESS_OWNERSHIP_FAILED`. So does a malformed reply to a request other than `run`.
- The shell answers a malformed request that holds a valid `callId` with `refused` and `INVALID_REQUEST`. It drops every other malformed frame.
- A service exit drops every pending call. The shell keeps the lingering set ("Lingering Jobs").

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
- Object check: the configuration listing shows a promisor remote as `remote.<name>.promisor` or `extensions.partialClone`. In such a repository, a failed read or mutation step starts an object check. The service runs `cat-file --batch-check` with `--no-lazy-fetch`. Its input holds the object IDs that the step needed: HEAD tree and index entries within the §5 listing caps, or history commit IDs. A `missing` answer gives `OBJECT_MISSING` (§9). Otherwise the failure stays `GIT_FAILED`. The service never parses the Git message.
- A read that needs a missing object ends `limited` with `OBJECT_MISSING`. It keeps any bounded data and blocks dependent mutations. History follows the same rule.
- A mutation step before publication or handoff fails with `OBJECT_MISSING`, and no data changes. After handoff, reconciliation classifies the result from observed state, and the exit status alone decides nothing. The commit passes `--quiet`, so Git prints no summary after the commit. Without it, a research R5 probe saw a commit move HEAD, run `post-commit`, and then exit 128 in its summary. With `--quiet`, the same case exited 0 and ran every hook.
- The `OBJECT_MISSING` remedy text is: "This partial clone lacks objects that Git needs here. Arbareto never downloads objects. Download them in a terminal, for example with git backfill, then use Refresh."

Trust discovery includes traditional hooks, configured hook commands/events, conditional includes, worktree configuration, filters, monitors, diff tools, and signing programs.

**Value display allowlist.** `readTrust` shows a configuration value only for a key on this closed list. The list holds `filter.<driver>.clean`, `filter.<driver>.process`, and `filter.<driver>.smudge`. It holds `core.fsmonitor`, `core.hooksPath`, and `hook.<name>.command`. It holds `diff.<driver>.textconv`, `diff.<driver>.command`, and `diff.external`. It holds the signing keys `gpg.program`, `gpg.<format>.program`, and `gpg.ssh.defaultKeyCommand` (Git `Documentation/config/gpg.adoc`). Every other entry is opaque, and `readTrust` shows only its key, scope, and origin. Examples are `http.extraheader`, `user.signingkey`, and a remote URL with user information. The `include.path` and `includeIf.<condition>.path` values stay hidden on purpose, and their origins stay visible. Trust resolution uses origins, not include values.

**URL user information.** A key subsection can hold a URL with credentials. Examples are `url.<base>.insteadOf`, `http.<url>.extraheader`, `credential.<url>.helper`, and `includeIf.hasconfig:remote.*.url:<pattern>.path`. Git prints these subsections unchanged (research R5 probe). So the service redacts every key subsection, origin, and allowlisted value before display or logging. For each `://` in the text, the authority runs to the next `/`, `?`, `#`, or the end. When that authority holds `@`, all text before its last `@` becomes `<redacted>`. Git's `transport_anonymize_url` also removes the user information of a URL for display (research R5). The trust fingerprint covers the unredacted bytes, and no response carries them.

Do not execute a custom filter merely to determine whether the repository is trusted. Before the first status read, list effective configuration with scopes. The listing includes `command` scope entries from the preserved environment. The trust fingerprint covers them. This listing runs no filter and loads no index. A repository-controlled key (resolution rule below) can define a command that a read runs. Such a key blocks status, diff, and history reads until trust approval. History reads cannot run these keys (table below). They still wait for the same approval, so one read gate covers the workspace. `readHistory` runs this listing itself and never waits for a status read. System, global, and command entries are protected configuration (Git `Documentation/git-config.adoc`). They run without approval, unless the resolution rule makes them repository-controlled.

The blocking class is any repository-controlled key that names a command a read can run. This slice reads through `status --porcelain=v2`, `diff-files`, `diff-index --cached`, `ls-files --eol`, `rev-list`, `cat-file --batch-command`, and `cat-file --batch-check`. The untracked read is the T092 method, such as `diff --no-index --no-ext-diff --no-textconv` (§4). T092 adds its selected form to this list. Reads also run `check-attr -z --stdin`, `hash-object -t tree --stdin` without `-w`, and `config --file .gitmodules --null --list`. For those commands, the listed keys behave as follows:

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
- The `bound` names map to the §5 "Trust program file digests" row: `file-count` is 64 files, `file-bytes` is 1 MiB per file, and `total-bytes` is 8 MiB total.
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

- `confirm` with the worktree path, the worktree administration-directory path, the common-directory path, the selected Git path, the fingerprint, and `persist`. The service sends the `selectedPath` of the current Git selection (data-model §1). The shell reads the common-directory identity and the worktree identity itself. It shows a native confirmation that names the worktree path and the fingerprint. With `persist: false`, the frame also carries `bound`. The dialog then shows that bound and the session-only text from "Program file digests". Its buttons are Approve and Cancel, and Cancel is the default. Enter on the default, Escape, Alt+F4, the close button, and a call failure mean Cancel. On Approve with `persist: true`, the shell writes and flushes the record. It replaces every record of the same worktree. A record is of the same worktree when both its common-directory identity and its worktree identity match. It is also of the same worktree when both its common-directory path and its worktree root path match. Records of other worktrees of that common directory stay unchanged. When that write or flush fails, the approval still holds for this service session only. The shell then replies `approved` with `stored: false` and without `record`. The service keeps a session approval, and `readTrust` reports `persistence` `session`. A failed write leaves the stored records unchanged. A record above 4 KiB (§5) gets the reply of a failed write, and the shell writes nothing. For this service session, the session approval takes precedence over a stored record of the same worktree. The UI shows the next notice only when the `approveTrust` result has `saveFailed: true`. With `persist: false`, the UI shows the session-only text from "Program file digests". The UI states that the approval holds only for this session: "Arbareto could not save this approval. This approval lasts until Arbareto closes or its Git service restarts." The second sentence is the session-only text from "Program file digests". With `persist: false`, it writes no record and deletes every record of the same worktree, because none matches the new fingerprint. Then it replies `approved`. Otherwise it replies `declined`, and `approveTrust` ends `canceled`.
- `revoke` with the common-directory path. The shell reads the identity of that path. It deletes every record whose common-directory identity or path matches, for every worktree of that common directory. It also closes every lingering Job with that identity tag (§6 "Lingering Jobs"). Then it replies with the count of processes that the close ended. `revokeTrust` then invalidates the trust ID and returns that count.
- `confirmRun` with the worktree path, the submodule paths, and the count of listed submodule programs. It also carries the count of `unchecked` entries (§12 "Trust"). The shell shows a native confirmation with the §12 text. Its buttons are Run and Cancel, and Cancel is the default. Enter on the default, Escape, Alt+F4, the close button, and a call failure mean Cancel. Run replies `approved`, and any other result replies `declined`. The shell writes, replaces, and deletes no record.

The service derives trust `state` from the records and from its session approvals. A record matches when its common-directory identity and its worktree identity equal those of the workspace. `approved` needs a matching record, or a session approval, with the same selected Git path and fingerprint. The service compares `gitSelectedPath` with the current `selectedPath` as Windows paths. The comparison ignores ASCII letter case, as the installation-root check of §6 "Startup contexts" does. A matching record with another selected Git path or fingerprint gives `changed`. So does a record with the same common-directory path and worktree root path but another identity. A different resolved path, version, or digest behind the same selected path does not give `changed`. No record gives `untrusted`. A revoked trust ID gives `revoked`.

Do not disable required hooks to obtain a successful result. Do not add an application-owned hook without approved scope changes.

Logs stay in memory for the session, with at most 1,000 entries (§5 "Session log entries"). This slice writes no log files. Logs contain only allowlisted operation kinds, internal IDs, durations, safe codes, counts, and reconciled effect summaries (data-model §7 `effects`). Do not retain raw stderr, hook output, messages, patches, environment blocks, or configuration dumps. Two response fields carry Git or hook output: the commit failure output (§9) and each submodule output tail (§12). They never enter a log, a `diagnostic`, or a progress event.

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
- After a file approval expires or becomes invalid, the renderer issues `readComparison` again for the same entry. It keeps the file selection while the entry keeps its category. The §4 "File staging" rechecks stay unchanged.

**Change check.** A `readWorkspace` with `check: "changes"` first compares a stat tuple with the one from the last complete read. WSL polls never use it (§11 "Change polling"). The tuple holds size, last-write time, and presence for a fixed file set:

- The index, in every ref format.
- The worktree `HEAD`, the ref file of the current branch, and `packed-refs`, for the `files` ref format.
- Discovery reports the ref format through `--show-ref-format`. For the `reftable` format, two files replace the `HEAD`, branch ref, and `packed-refs` entries. They are `reftable/tables.list` in the worktree administration directory and in the common directory. For the main worktree, both paths name one file. Git rewrites this stack ordering file by rename on every ref update (gitformat-reftable(5)). `HEAD` is then a fixed stub, and no branch ref file or `packed-refs` exists. A ref update can keep the file size, so the tuple also holds the file content. A `tables.list` above 64 KiB counts as changed, so the read runs in full.
- Every configuration origin file from the last trust listing, and every file that the trust fingerprint digests.
- The working file of the selected entry, from its `workingVersions` binding.

The check starts no Git process. Without a watcher hint and with an equal tuple, the read returns the last snapshot. Its `snapshotId` and `generation` stay unchanged. Otherwise it runs a full read. A change check is a hint, not validation. Every mutation checkpoint still reads Git state (§4). This stat compares change hints only. Physical identity still comes from the §6 identity request.

Cancellation means stopping further owned work, not undoing completed work. The terminal result can still be successful if the intended operation completed first.

After any mutation outcome, inspect actual HEAD target/OID, index, relevant working bytes, and operation markers. Unknown state blocks further mutations in the affected workspace.

**Observed locks.** After a failed mutation, reconciliation also checks a fixed set of lock files. They are the Git-resolved `index.lock` and `HEAD.lock` in the worktree administration directory. For the `files` ref format, they include the current branch ref lock and `packed-refs.lock` in the common directory. For `reftable`, they include `reftable/tables.list.lock` in both administration directories. The outcome names each existing one as foreign, with its path (§9 "Other locks"). A file check is an observation, not a cause. After `updateSubmodules`, the set also holds the superproject `config.lock`. It also holds the `index.lock` and `HEAD.lock` of each submodule Git directory in the plan (§12).

Distinguish `succeeded`, `completed-with-effects`, `failed-with-effects`, `canceled`, and `unknown`. A known checkpoint mismatch remains a refusal, not completed-with-effects.

A published hunk or file, or a created commit, with differing observed state is completed-with-effects when execution completed. An execution failure with observed changes is failed-with-effects. Neither is `succeeded`; preserve the draft and show grounded commit identities.

Late cancellation can still produce `succeeded` or `completed-with-effects`. Reconcile before classification; cancellation is never an undo command.

**Cancellation during reconciliation.** Git has exited, but its descendants can still run in the operation Job.

- A cancellation during `reconciling` stops no reconciliation read. Those reads keep their §5 deadline. The service acknowledges the request and sets `endProcesses` on `ended` (§6 "Lingering Jobs"). So every process that Git or a hook started ends after the terminal response. That outcome records `lingeringDescendants` 0.
- A cancellation after `ended` has no target, because the operation is terminal. `cancel` returns the terminal state and ends no lingering Job.
- Interrupt and close during `reconciling` closes the operation Job at once and then follows application close (§6). No terminal response or `resolved` frame follows, so the recovery marker stays. The next start shows that workspace `unknown`.

Use bounded reference/reflog evidence for uncertain commit attribution. Apply the aggregate byte and record caps across all streams and references per reconciliation attempt. Do not assume current HEAD belongs to this request or invent a causal explanation. Evidence overflow or ambiguous attribution gives the terminal outcome `unknown`. Mutations stay blocked until an explicit recovery refresh reports that outcome.

From `unknown`, only `readWorkspace` with `refresh: true` performs recovery reconciliation. It succeeds when all of these hold:

- No process that the service requested for the prior operation runs. Its operation Job is closed or lingering (§6 "Lingering Jobs"). A lingering descendant does not block recovery.
- A complete snapshot exists: HEAD target and OID, complete index, operation markers, and relevant working bytes.
- Owned lock and candidate files are released, or the result names them as foreign.
- For `commit`, one attribution attempt ran within the §5 caps. Its result is an identified commit, no commit, or `unknown`. An `unknown` result names its reason: `ambiguous`, `evidence-limit`, or `no-retained-request`.
- For `applyHunk` and `applyFile`, no attribution step runs. The observed canonical index is compared with two retained digests: the verified candidate and the index before publication. The result names the match: `published`, `not-published`, or `neither`. Without a retained request, the result is `unknown` with reason `no-retained-request`.
- For `updateSubmodules`, no attribution step runs. The refresh re-reads every row of the retained plan with the §12 review reads and states each row state. The retained plan holds the rows that the run added. Without a retained request, it reports attribution `unknown` with reason `no-retained-request`, and the next review shows the observed submodule states.

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
| Prerequisites | `GIT_UNAVAILABLE`, `GIT_CHANGED`, `GIT_UNSUPPORTED`, `WEBVIEW_UNAVAILABLE`, `WEBVIEW_UNSUPPORTED`, `WSL_UNAVAILABLE` |
| Repository state | `REPOSITORY_UNAVAILABLE`, `REPOSITORY_CHANGED`, `UNSUPPORTED_REPOSITORY`, `DUBIOUS_OWNERSHIP`, `NOT_A_REPOSITORY`, `OPERATION_IN_PROGRESS`, `CONFLICTED`, `LOCKED`, `UNSUPPORTED_SUBMODULE` |
| Trust and approval | `TRUST_REQUIRED`, `TRUST_CHANGED`, `STALE_SELECTION`, `STALE_REVIEW`, `APPROVAL_EXPIRED`, `UNSUPPORTED_HUNK_PROFILE` |
| Data and display | `MALFORMED_GIT_OUTPUT`, `OUTPUT_LIMIT`, `OBJECT_MISSING`, `UNSUPPORTED_COMPARISON`, `DISPLAY_MAPPING_FAILED`, `GRAPH_LAYOUT_LIMITED` |
| Execution | `IDENTITY_REQUIRED`, `HOOK_FAILED`, `SIGNING_FAILED`, `GIT_FAILED`, `PROCESS_OWNERSHIP_FAILED`, `DEADLINE`, `CANCELED`, `COMMIT_ENCODING_UNSUPPORTED` |
| Recovery | `COMPLETED_WITH_EFFECTS`, `FAILED_WITH_EFFECTS`, `STATE_UNKNOWN`, `SERVICE_UNAVAILABLE`, `RECOVERY_MARKER_FAILED` |

Each terminal state (data-model §7) carries one result code:

- `succeeded`: no error code.
- `limited`: `OUTPUT_LIMIT`, with the reached §5 bound as its reason, or `OBJECT_MISSING` (§7 "Missing objects"). The response keeps its bounded data and completeness `limited`.
- `failed`: the specific failure code, such as `DEADLINE`, `GIT_FAILED`, or a mutation `OBJECT_MISSING`.
- `canceled`: `CANCELED`.
- `completed-with-effects`: `COMPLETED_WITH_EFFECTS`.
- `failed-with-effects`: `FAILED_WITH_EFFECTS`.
- `unknown`: `STATE_UNKNOWN`, with its attribution reason.
- `rejected`: the refusal code. `SERVICE_UNAVAILABLE` is always a `rejected` result.

A mutation request in a workspace whose recovery state is `unknown` is rejected with `STATE_UNKNOWN`. Above the recovery-marker limit (§5), every mutation is rejected with `STATE_UNKNOWN`. Unexpected diagnostic output above 4 MiB cancels the operation. A read then ends `failed` with `OUTPUT_LIMIT`. A mutation enters `reconciling`, and its diagnostic names `OUTPUT_LIMIT` as the cause.

Map these cases to codes:

- At acceptance of a snapshot-bound request other than `approveTrust`, a stale `repositoryGeneration` gives `REPOSITORY_CHANGED`. No Git process starts. `readWorkspace` never fails on a generation mismatch (§2). An `approveTrust` fingerprint-generation mismatch gives `TRUST_CHANGED`.
- A hunk or file checkpoint that detects a changed file, index, HEAD, or attribute gives `STALE_SELECTION`. A commit preflight that detects a changed index, checkout, or operation state gives `STALE_REVIEW`.
- The choice between `REPOSITORY_CHANGED` and these checkpoint codes depends on the request sequence. A `readWorkspace` that observes the change increases the generation, so a later request gives `REPOSITORY_CHANGED` at acceptance. Without such a read, the generation still matches, and the checkpoint code applies.
- A checkpoint that detects a changed trust fingerprint gives `TRUST_CHANGED`. This includes a configuration change during a hunk or file request.
- An entry that `applyFile` refuses gives `UNSUPPORTED_COMPARISON` with its file-action reason (§4 "File staging"). A direction that does not match the comparison scope gives `INVALID_REQUEST`.
- A failed `stage` Git step without a missing object gives `GIT_FAILED`. The result carries the `outputTail` of that step ("Commit failure output" below) and the `add` remedy of the entry (§4). A terminal run of the remedy repeats Git's message. `core.safecrlf=true` can cause this failure, as it does for `git add`.
- A `stage` whose staged blob has no proof gives `UNSUPPORTED_COMPARISON` with reason `blob-proof` and the `add` remedy. After a changed digest, it gives `STALE_SELECTION` (§4 "Blob proof").
- A split index or `core.splitIndex=true` gives `UNSUPPORTED_HUNK_PROFILE` with reason `split-index` for `applyHunk` and `applyFile` (§4 "Split index").
- `WSL_UNAVAILABLE` carries one reason: `wsl-missing`, `distro-missing`, `not-wsl2`, `no-user-manager`, `no-setsid`, `no-coreutils`, or `start-failed` (§11). Its remedy texts are:
  - `wsl-missing`: "WSL is not available on this computer. Install WSL2, then open the folder again."
  - `distro-missing`: "No registered WSL distro has the name <name>. Open the folder through a listed distro."
  - `not-wsl2`: "Distro <name> is not a WSL2 distro. Arbareto opens repositories only in WSL2 distros."
  - `no-user-manager`: the §11 "Process ownership" text.
  - `no-setsid`: "Arbareto needs the setsid program in <distro>. Install the util-linux package in the distro, then open the folder again."
  - `no-coreutils`: "Arbareto needs the stat and env programs in /usr/bin of <distro>. Install the coreutils package in the distro, then open the folder again."
  - `start-failed`: "WSL could not start distro <name>. Start it in a terminal, then open the folder again."
- For a WSL Git, `GIT_UNSUPPORTED` carries reason `version`, `windows-git`, or `no-fs-uuid` (§11 "Git per distro"). Reason `version` carries the found and required versions. The `windows-git` text is: "The git command in <distro> is Git for Windows. Install Linux Git 2.55.0 or later in the distro."
- `UNSUPPORTED_REPOSITORY` carries reason `wsl-path`, `mixed-location`, or `no-fs-uuid` for the §11 path rules. The `wsl-path` text is: "This path holds a name that Windows cannot show. Open another folder." The `mixed-location` text is: "The worktree and its Git directories must all lie inside one WSL distro, or all on Windows." The `no-fs-uuid` text is: "Arbareto cannot read a file-system UUID for this folder. Open a folder on the distro's own disk."
- `UNSUPPORTED_SUBMODULE` reasons: `unsaved-commits`, `update-mode`, `clone-interrupted`, `folder-not-empty`, `no-url`, `path`, `remote-name`, `gitdir-config`, or `limit`. The code carries the submodule path and one reason. §12 "Refusals" gives each text and remedy. A refusal during the run gives no code. Its row ends `refused` with its reason, which can also be `programs` or `changed-after-review` (§12 "Refusals during the run").
- A submodule preflight gives `STALE_REVIEW` when it detects a change (§12 "Update protocol"). The change can be in the plan, a submodule HEAD, a `.git` entry, a folder state, or the program list. So does the re-check after an approved `confirmRun`. That re-check consumed the token, so the operation ends `failed` with the code (§12 "Update protocol" step 3).
- An `updateSubmodules` process deadline gives `DEADLINE` with reason `inactivity` or `ceiling`. Other `DEADLINE` results carry no reason.
- A registration beyond 8 workspaces registered at one time gives `WORKSPACE_LIMIT`. The result names the limit. Only linked worktrees of one common directory can reach it (§6 "Registration reuse and release").
- A registration that would release a workspace with an unfinished mutation gives `BUSY`.
- A mutation whose `started` frame finds the cross-instance mutex held gives `BUSY` with the §6 "Cross-instance exclusion" remedy.
- A failed recovery-marker write gives `RECOVERY_MARKER_FAILED` with the failure class and the `recovery` folder path. Its remedy is: "Arbareto could not save its recovery record. Free disk space or restore write access to this folder, then try again." No lock and no Git process exist yet.
- A hook or signing failure gives `HOOK_FAILED` or `SIGNING_FAILED` only from structured evidence (research R4). Without that evidence, the result is `GIT_FAILED` with a recorded reason.
- `HOOK_FAILED` and a commit `GIT_FAILED` carry a copyable remedy command. It is the PowerShell command `& '<selected Git path>' --no-lazy-fetch -C '<worktree root>' hook run --ignore-missing pre-commit`, quoted by the §4 rule. It runs the traditional and configured `pre-commit` hooks and creates no commit (research R4). The remedy text is: "This command runs the pre-commit hook in a terminal and does not commit. Other hooks show their output only here. Arbareto keeps your message." This text applies only to the failure remedy, and the §6 stall notice has its own text. No single command reproduces `prepare-commit-msg`, `commit-msg`, or signing without the message, so the app offers none for them.

**Commit failure output.** A commit that ends `failed`, `failed-with-effects`, or `unknown` carries `outputTail`. It holds the end of the commit process stderr. Git sends hook stdout to that stderr, so it holds hook output too (research R4).

- The service keeps a 16 KiB ring buffer of raw stderr bytes read before the completion signal (§6). Later bytes never enter it.
- When bytes were dropped before the buffer, the service drops the first partial line. So a URL is never cut at its start.
- It decodes UTF-8 with U+FFFD replacement. It removes ECMA-48 escape sequences, C0 controls except TAB and LF, DEL, and C1 controls. CR LF and a lone CR become LF.
- It then applies the §7 URL user-information redaction and keeps the last 100 lines.
- The renderer shows `outputTail` as plain text only, never as markup. No log, `diagnostic`, progress event, or other response carries it (§7).
- Only Git and the hooks that the user configured or approved write this output, as in a terminal run. Redaction removes URL user information but cannot detect every secret form (research R5).
- A failed `updateSubmodules` process carries its own `outputTail` by these rules, with one change for progress (§12 "Output tail").
- A failed `applyFile` `stage` Git step carries an `outputTail` from the stderr of its `update-index` process, by these rules.

**Other locks.** Return `LOCKED` only when the app's own exclusive `index.lock` creation fails. A lingering process can hold another lock, such as a ref lock or `HEAD.lock`. Git then fails after handoff, and the commit ends `GIT_FAILED`, or `failed-with-effects` when reconciliation observes hook effects. The outcome names each observed lock (§8 "Observed locks") with its path. Its remedy text is: "Git could not take a lock. Another Git process, or a process that Git or a hook started, can hold it. Use Refresh after that process ends."

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
- Verify stale/out-of-order reads cannot replace the active view or authorize mutation.
- Verify that a `check: "changes"` read without a hint or a tuple change starts no Git process. Verify that `readHistory` runs beside `readWorkspace` without a status snapshot, and waits for read trust like other reads.
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
- Verify that `core.splitIndex=true` from local and global scope refuses `applyHunk` and `applyFile` with reason `split-index`. Verify that no `sharedindex.*` file appears. Verify the same for a `link` extension and for `GIT_TEST_SPLIT_INDEX=1` in the service environment.
- Verify each §4 "Blob proof" branch for `stage`: proof A and proof B. Also verify both failing with `blob-proof`, and a changed digest with `STALE_SELECTION`. Verify that a writer that changes and restores the working file during step 5 never publishes.
- Verify that a candidate copy keeps a time at most the canonical index time. A same-size change in the second of the last index write must stage its new bytes. A later `status` must still show an unrelated such change.
- Verify the §11 route rule, distro checks, Git floor, and start step with Cancel. Verify that no Windows variable reaches Linux Git.
- Verify that no Linux process of an operation remains after cancellation, a deadline, or a service failure. Verify the same after Revoke trust and application close. Check with `pgrep` in the distro. A plain, a `nohup`, and a `setsid` hook child each linger until one of those events. The outcome counts them. A hook that opens `/dev/tty` fails at once. A distro without `setsid` gives `WSL_UNAVAILABLE` with reason `no-setsid`. A distro without `/usr/bin/stat` or `/usr/bin/env` gives reason `no-coreutils`.
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
- Verify that the `DUBIOUS_OWNERSHIP` remedy stays literal in PowerShell for a folder with `$(…)` and for each quote character.
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

## 11. WSL repositories

WSL2 repositories are in this slice (spec FR-039 to FR-046). Git inside the distro runs them. Every other rule of this contract applies unless this section states otherwise. Research R13 holds the probes P1 to P5 and their sources.

### Route

- A selected or restored path is a WSL path when it starts with `\\wsl$\` or `\\wsl.localhost\`. The prefix comparison ignores letter case, as WSL does (P3).
- The next segment names the distro. It must equal a name that `wsl.exe --list --quiet` prints. Without an exact match, one match that ignores letter case counts, because `wsl.exe --distribution` accepted another letter case (P3). Any other result gives `WSL_UNAVAILABLE` with reason `distro-missing`.
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

### Git per distro

- One bootstrap probe per distro runs a fixed `/bin/sh -c` script with `LC_ALL=C`. It takes no repository argument. It runs before the helper paths exist, so it runs without the wrapper. It starts only `command -v`, `readlink`, `head`, `stat`, `git --version`, and the empty scope test below. It resolves `git`, `systemd-run`, `systemctl`, and `setsid` with `command -v` and `readlink -f`. It also resolves the fixed paths `/usr/bin/stat` and `/usr/bin/env` with `readlink -f`. It prints each absolute path, the first two bytes of each file, and the `git --version` text. As the identity of the Git file, it prints `stat --dereference --file-system --format=%t:%i <Git file>` and `stat --dereference --format=%i:%s:%Y <Git file>`. It tests one empty `systemd-run --user --scope` call.
- `--version` runs without `--no-lazy-fetch`. Linux Git 2.43.0 rejected that option with "unknown option" (P3). With it, the floor refusal could not name the found version. `--version` opens no repository and fetches nothing. Every other Git command keeps `--no-lazy-fetch` first (§7 "Missing objects" states this exception once).
- Three cases give `GIT_UNSUPPORTED` with reason `windows-git`. They are a resolved path under `/mnt/` and a file that starts with the bytes `MZ`. The third is a version text with `.windows.`. The `PATH` of an `--exec` process holds Windows directories, and interop runs Windows programs (P2).
- A resolved `systemd-run` or `systemctl` that fails the same rule gives `WSL_UNAVAILABLE` with reason `no-user-manager`. So does a failed scope test ("Process ownership" below).
- A missing `setsid`, or one that fails the same rule, gives `WSL_UNAVAILABLE` with reason `no-setsid`. Every wrapper mode needs it ("Process launch" below). The util-linux package provides it. The identity rule uses `stat` from coreutils, not `findmnt` (research R13 P7).
- A missing `/usr/bin/stat` or `/usr/bin/env`, or one that fails the same rule, gives `WSL_UNAVAILABLE` with reason `no-coreutils`. The identity probes need `stat` ("Paths and file access" below), and the §12 fetch remedy needs `env` ("Remedy commands" below). The coreutils package provides both. FR-043 requires this refusal for the program that identifies folders.
- A Git file without a stable file-system ID ("Paths and file access" below) gives `GIT_UNSUPPORTED` with reason `no-fs-uuid`. The text is: "Arbareto cannot read a file-system UUID for Git in <distro>. Install Git on the distro's own disk."
- No `git` gives `GIT_UNAVAILABLE` with the remedy "Install Git 2.55.0 or later in <distro>."
- A version below 2.55.0 gives `GIT_UNSUPPORTED` with reason `version`. Compare `major.minor.patch` numerically. An unparseable version gives the same result. The text names both versions: "Git <found> in <distro> is older than 2.55.0. Install Git 2.55.0 or later in the distro."
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
- Every Job close ends the scopes of its operation. A Job closes at cancellation, a deadline, Interrupt and close, or `endProcesses`. It also closes at Revoke trust, a service failure, application close, or a shell crash. `wsl.exe` ends, the command gets `SIGHUP`, and the trap ends the scopes. In P1, ten cancellation runs and ten lingering runs left no Linux process 1 second after the Job close.
- The §6 lingering count of a WSL Job is the last anchor count. That count is at most 1 second old. Revoke trust reports it.
- Git runs in its own session without a controlling terminal, in every mode ("Process launch"). So the wrapper exit sends no `SIGHUP` to its children. Every child that keeps running after Git exits lingers in its scope and counts, as on Windows. Before 2026-10-01, a plain child ended at the wrapper exit (P1 S6); that result no longer describes this design.
- Application close needs no WSL call beyond the Job closes. The 5-second close target covers the traps.

### Paths and file access

- The service converts paths only at the Git argument boundary: the `-C` directory and the candidate index file. Entry paths stay Git path bytes, as on Windows.
- Linux Git reports Linux paths. The service converts each Git-resolved directory back to the UNC identity. The worktree root, the Git directory, and the common directory must lie in the Linux file system of one distro. The identity request reports the file system type. Type `v9fs`, magic `1021997`, means a Windows drive (P5: `/mnt/c` reported `v9fs`, and `/` reported `ext2/ext3`). Such a directory gives `UNSUPPORTED_REPOSITORY` with reason `mixed-location`.
- A Windows repository whose Git-resolved directories lie under a WSL prefix also gives reason `mixed-location`.
- The shell answers a WSL identity request with two fixed probes in the distro. They are `/usr/bin/stat --dereference --format=%i <path>` and `/usr/bin/stat --dereference --file-system --format=%t:%i <path>`. Each runs through the wrapper in `probe` mode. The first gives the inode number. The second gives the file system type magic and the file-system ID (`statfs` `f_fsid`). The identity is the distro GUID, the file-system ID, and the inode number. The probes read no file data. A failed probe refuses registration with `UNSUPPORTED_REPOSITORY`, as a failed `FileIdInfo` call does (§6).
- Only type `ef53` (ext2, ext3, and ext4) gives a stable file-system ID. Every other type except `v9fs` gives reason `no-fs-uuid`, as an all-zero `FileIdInfo` does. So does an ID of 0.
- Reason: the device number can change. WSL2 attaches each distro disk as a SCSI disk, and `lsblk` listed `sda` to `sde`. The attach order probably selects the device; T252 checks this. The reference distro's root reported `stat %d` 2096, which is device 8:48 (`/dev/sdd`). A UUID stays with the file system. Registration reuse, the mutation exclusion, recovery markers, lingering Job tags, and trust records use this identity. This applies where §6 and §7 name `FileIdInfo`.
- ID source (research R13 P7): ext4 derives `f_fsid` from its superblock UUID (Linux `fs/ext4/super.c`, `uuid_to_fsid`). The reference root reported ID `fedc9aa3bd65bc57`, which equals that value for its `findmnt` UUID. `statfs` reads the mounted superblock and needs no udev data. `findmnt` took the UUID from udev data, because the user cannot read the disk device. The udev trigger finished 0.7 seconds after user space started, so an earlier UUID read could be empty. XFS derives its ID from the device number (Linux `fs/xfs/xfs_super.c`). Two tmpfs mounts gave different IDs. So only type `ef53` counts.
- An entry path with a character that Windows names cannot hold gets reason `path` (data-model §5). The service reads each working file through its UNC path and cannot map such a name.
- The service reads and writes repository files through the UNC path. These are raw index bytes, working-file and program-file digests, the stat tuple, the index lock, the candidate copy, and publication. In P5, a second exclusive create of `index.lock` failed with error 80. A replace over `index` succeeded, and Linux Git read the result. Bun `fs.stat` returned the size and the time. The atomicity of the replace over the WSL file share is unverified (T213).
- The candidate lies in the Linux Git directory beside the index. Git gets it as a Linux path through the index file argument of the wrapper.

### Change polling

- WSL repositories get no watcher. `fs.watch` threw `EISDIR` on `\\wsl.localhost` paths in Node and Bun (R13).
- While the main window has focus, the renderer sends `readWorkspace` with `refresh: false` and `check: "full"` as a poll. It sends the next poll 1 second after the previous poll ends. Without focus, it sends no poll. Focus return and each mutation outcome send the §3 full read as for Windows repositories.
- A poll never starts while another read of that workspace runs. A poll that falls due during such a read starts when that read ends. A user read that finds both workspace read slots busy cancels a running poll. It cancels a superseded selection read the same way (§5).
- WSL polls never use `check: "changes"`. Without a watcher, the stat tuple cannot see unselected working files.
- plan.md §Measurements holds the WSL budgets.

### Trust and environment

- Repository-controlled programs run as the Linux user of the distro. Through interop, they can start Windows programs as the Windows user. The §7 trust rules apply unchanged.
- The trust listing uses the distro Git. Program-file digests read each file through its UNC path. A bare-name program uses the Linux `PATH` of the Git probe. The lookup tries only `<entry>/<name>`, because Linux Git adds no `.exe`. The Windows directories in that `PATH` lie outside the repository, so they enter the fingerprint as locations only.
- Every `wsl.exe` process gets an empty `WSLENV` ("Process launch" above). WSL forwards only the variables that `WSLENV` names (P4 forwarded `GIT_TRACE` through it). So no Windows variable reaches Linux Git, and that includes the `GIT_*` variables that §7 preserves for Git for Windows. The distro's own configuration and environment apply.
- The `--exec` environment in P4 held `HOME`, `PATH`, `LANG`, `USER`, `SHELL`, `TERM`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, `WSL_DISTRO_NAME`, and `WSL_INTEROP`. It held no `GIT_*` variable. The `mutation-trace2` policy does not apply to WSL, so hook and signing failures stay `GIT_FAILED`.
- Credentials come from the distro's Git configuration. The app sets up no credential helper. An SSH agent that `.bashrc` starts does not load under `--exec` (Git Extensions #11839). Hooks and the §12 update fetches can meet this limit.

### Remedy commands

A WSL remedy is a PowerShell command that calls `wsl.exe`. Each value uses the §4 quoting rule. The `add` form is:

`& '<System32 path>\wsl.exe' --distribution '<distro>' --cd / --exec '<Git path>' --literal-pathspecs -C '<Linux worktree root>' add -- '<path>'`

- The `restore --staged` and `rm --cached` forms follow the same pattern. So does the §9 hook remedy, which keeps `--no-lazy-fetch` as its first Git argument. So do the §12 submodule remedies. In a terminal, `wsl.exe` has a visible console, so Git and SSH can ask for input there.
- `wsl.exe` passed each PowerShell argument literally in P3, also with spaces and `$`. The §4 rule applies to every value of a WSL command, the trailing U+005C rule included.
- The route and path rules above refuse `"` and `\` in distro names and paths. A remote name from the distro's Git configuration can still hold them. No probe passed U+005C through `wsl.exe`. So a WSL command is offered only when no value after `--distribution` holds U+005C.
- The §12 fetch remedy puts `/usr/bin/env GIT_PROTOCOL_FROM_USER=0` between `--exec` and `'<Git path>'`. The variable then applies only to that one Git command. With it, distro Git refused a `file` remote, and without it, the fetch passed (research R14 S30).
- `env` reads each leading argument with U+003D as a `NAME=value` assignment. It takes the first argument without U+003D as the program (GNU coreutils manual, "env invocation"). So an approved Git path with U+003D gives no fetch remedy. The row still shows its text.

## 12. Submodules

Submodule initialization and update are in this slice (spec FR-047 to FR-054). They form the first network operation of the slice. Research R14 holds the probes S1 to S34 and their sources. Every other rule of this contract applies unless this section states otherwise.

### Scope

- `updateSubmodules` initializes and updates every submodule recursively to the commit that its parent records. Submodule HEADs, folders, and settings equal those of Git's own `submodule update --init --recursive` (probe S20). The recorded differences touch only remote-tracking refs, one skipped fetch, and the environment of hooks ("Update protocol" step 5).
- The app runs that work in phases for each submodule ("Update protocol"). It fetches first and checks the refs of the submodule again. Then Git checks out without a fetch. The user decided this order on 2026-10-01 (spec Clarifications).
- It never selects single submodules, never adds, removes, or syncs one, and never runs a command in each. It passes no `--remote`, `--force`, `--merge`, `--rebase`, `--checkout`, or `--recursive`.
- Other operations keep their submodule rules. Reads pass `--ignore-submodules=dirty` and start no Git process inside a submodule. Hunk and file staging refuse submodules with reason `submodule`.

### Discovery notice

`readWorkspace` returns `submoduleNotice` from superproject data only. It starts no Git process inside a submodule.

- A stage-0 gitlink counts when its worktree path holds no `.git` entry. A `submodule.<name>.active` value `false` excludes it from the notice. The review can still show its activation ("Plan").
- A gitlink also counts when porcelain v2 status reports a changed commit in its submodule state (`SC..`). Status passes `--ignore-submodules=dirty`, so Git reads the submodule HEAD in its own process (research R5).
- The service maps paths to names from the worktree `.gitmodules` through `config --file .gitmodules --null --list`. That command loads no index. The service runs it only when the index holds a gitlink.
- The notice holds the count and the paths, within the §5 review bound. It can name a submodule that `submodule.active` excludes. The review then shows that submodule as `skip`.

### Review reads

`reviewSubmodules` builds the plan from the superproject and from each initialized submodule. An initialized submodule has a `.git` entry in its worktree path. The review also reads each kept Git directory (below).

- Superproject reads: the index gitlinks, the §7 configuration listing, and `.gitmodules`. Git reads the worktree `.gitmodules` first, then the index blob, then the HEAD blob. The review reads the same source through `config --file` or `config --blob`.
- Top-level checked-out commits come from `diff-files -p --ignore-submodules=dirty -- <gitlink paths>`. The service splits long path lists into several calls under the §6 command-line limit. The `Subproject commit` lines name each submodule HEAD. It started no Git process inside a submodule (probe S3).
- Inside each initialized submodule, the review runs only these fixed commands. Each starts with `--no-lazy-fetch --no-optional-locks -C <submodule worktree>`.
  - `rev-parse --verify -q HEAD`, `rev-parse --absolute-git-dir`, `rev-parse --git-path hooks`, and `symbolic-ref -q HEAD`.
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
- Nested submodules: the review takes the gitlinks of an initialized submodule from the tree of its target commit. This needs a local target commit. Otherwise it takes them from its HEAD tree. It recurses into each nested gitlink with a `.git` entry. Without a local target commit, the plan states that the update finds the nested submodules after its fetch. The update reads each nested level again after its parent checkout ("Update protocol").
- Kept Git directories: the update reuses each kept `modules/<name>` directory of a submodule without a `.git` entry. This holds at every depth, and Git then runs the programs of that directory (probe S11). So the review recursively walks the `modules` folder below the superproject common directory and below each Git directory it reads.
- A submodule name can hold `/`, so the walk enters every subfolder. For each folder, it runs `rev-parse --absolute-git-dir` with `--git-dir=<folder> --work-tree=<folder>`. A folder that Git accepts is a kept Git directory. In it, the walk continues only in its own `modules` folder. Git refuses a submodule Git directory inside another one (Git v2.55.0 submodule.c:2402-2442).
- In each kept Git directory, the review runs the commands above with `--git-dir=<directory> --work-tree=<directory>`. Each directory then enters the program list ("Trust") and the `unsaved-commits` check ("Refusals") once.
- Each folder that the walk visits counts as one submodule toward the §5 submodule review bound. A larger walk gives reason `limit`.
- The walk assumes Git's default layout under `modules`. Git 2.55 also offers `extensions.submodulePathConfig`, which places Git directories by `submodule.<name>.gitdir` (git-config(1)). The review refuses that layout with reason `gitdir-config` ("Refusals", research R14).

### Plan

Each plan row holds an opaque row ID, the path, the name, and the depth. It also holds the URL, the action, the notes, and any refusal reason.

- URL: the effective `submodule.<name>.url` of the parent, or else the `.gitmodules` value. A relative `.gitmodules` URL appears as written. Its note reads: "Git resolves this URL against the remote of the parent repository." The service redacts URL user information by the §7 rule.
- Fetch URLs: a `reuse` or `fetch-checkout` row fetches inside the submodule, from the remotes of the submodule. The first fetch ignores the parent URL (probe S12). So the row also lists each `remote.<name>.url` from the submodule `config list`, redacted, and marks the default remote.
  - The default remote is the remote of the checked-out branch, else the only remote, else `origin` (Git v2.55.0 remote.c:666-680).
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

`reviewSubmodules` returns each refusal, and `updateSubmodules` refuses while one holds. The code is `UNSUPPORTED_SUBMODULE` with one reason:

- `unsaved-commits`: an initialized submodule, or a kept Git directory ("Review reads"), has a HEAD that no ref of it contains. The review also cannot prove that this HEAD equals the target commit. Git detaches HEAD without a warning. Only the submodule reflog then keeps those commits, until reflog expiry (probe S4).
  - Every ref counts, `refs/remotes` included. A fetch can still remove or move the ref that holds HEAD. With `fetch.prune`, a fetch deleted the only remote-tracking ref that held HEAD (probe S15).
  - So the update checks HEAD and its refs again after each fetch and before each checkout ("Update protocol"). A row that fails this check gets no checkout. It ends `refused` with this reason, its text, and its remedy (probe S20).
  - Text: "Submodule <path> is at commit <short ID>, which the update can leave without a branch, tag, or other ref. Save it with the command, then use Refresh." The remedy is `& '<selected Git path>' --no-lazy-fetch -C '<submodule worktree>' branch 'arbareto-saved-<short ID>' '<full ID>'`. `--no-lazy-fetch` stays the first Git argument, as in every app command (§7 "Missing objects"). A kept Git directory uses `--git-dir='<Git directory>' --work-tree='<Git directory>'` in place of `-C`. Each value uses the §4 quoting rule. The short ID has 12 hex digits.
- `update-mode`: an existing submodule has update mode `merge`, `rebase`, or `!command`. The mode comes from the effective configuration of the parent, or else from `.gitmodules`. Text: "Submodule <path> uses the update mode <mode>. Arbareto updates only submodules that Git checks out. Use the command in a terminal." The remedy is the update command under "Remedies".
  - A `.gitmodules` value `!command` also refuses. Git itself rejects it with "invalid value" (probe S5).
  - A just-cloned submodule gets a checkout for `merge` and `rebase` (builtin/submodule--helper.c:2143-2147, probe S5). So a `clone` row never refuses for its mode. With `none`, Git skips the clone, so the row is `skip`.
  - Reason: `merge` and `rebase` can stop in an unfinished operation, which this slice blocks. `!command` runs a repository command.
- `clone-interrupted`: a `.git` entry exists, but `rev-parse --verify -q HEAD` exits 1 without output in it. Another exit status is a read failure ("Update protocol" step 5). A killed clone leaves this state, and Git then fails with "Unable to find current revision" (probe S9). Text: "Git stopped while it cloned submodule <path>. Move the folder <path> out of the repository after all Git tools stop. Then use Update submodules again." The state shows the path with Copy path. The app never moves or deletes it.
  - Reason: Git then sees a `reuse` row with an absent folder. It recreates the folder, fetches into the kept Git directory, and checks out the recorded commit. The moved folder keeps every byte (probe S13).
  - The earlier remedy deleted only `<path>\.git`. A folder with other files then became a `reuse` row, and `checkout -q -f` overwrote them (probe S13). The `folder-not-empty` refusal now blocks that state.
- `folder-not-empty`: a `reuse` row has a worktree path that is not an empty folder. The path holds a file, a link, a junction, or a folder with any entry, hidden entries included. Git's update would run `checkout -q -f` there and overwrite tracked files without a warning (probe S13). An absent path and an empty folder pass. Text: "Submodule <path> has no Git link, but its folder is not empty. Git would overwrite those files. Move the folder out of the repository, then use Refresh." The state shows the path with Copy path. The app never moves or deletes it.
  - A `clone` row needs no empty-folder rule for files without a Git link. Git refused to clone into a folder that was not empty, and the file kept its bytes (probe S13). The row then fails ("Reconciliation and outcome").
  - A `.git` entry or a `modules/<name>` directory that appears after the review is a different case. The clone check ("Update protocol" step 5) refuses it before Git starts.
- `no-url`: a gitlink has no `.gitmodules` entry. Text: "The .gitmodules file has no entry for submodule <path>. Git cannot update it."
- `path`: a submodule path fails the data-model §5 path rule. Text: "Arbareto cannot pass the path of submodule <path> to Git literally."
- `remote-name`: a `reuse` or `fetch-checkout` row lists a remote whose name starts with `-`. Git can read such a name as an option. A fetch by commit ID without `--` ran the program that the remote name `--upload-pack=<program>` named (probe S31). Text: "Submodule <path> has a remote named <name>, which Git can read as an option. Rename that remote in a terminal, then use Refresh." It has no command.
  - Every app command also passes `--` before a remote name ("Update protocol" step 5). The refusal is a second guard.
  - `remote.<name>.url` is a Git-written key ("Trust"), so the program list never shows such a name. The refusal does.
- `gitdir-config`: the `config list` output of the superproject, or of a submodule Git directory that the review reads, enables `extensions.submodulePathConfig`. Any `submodule.<name>.gitdir` key in that output also refuses. Git can then place submodule Git directories outside `modules/<name>` (git-config(1)). The kept-directory walk cannot find them, so the program list can miss their programs. The refusal carries the path of the submodule whose configuration holds the setting. A superproject setting carries the worktree root. Text: "This repository sets custom locations for submodule Git folders. Arbareto reads only the default location. Update the submodules in a terminal." The remedy is the update command for that submodule path, or without a path for a superproject setting ("Remedies").
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
- Submodule programs: the review lists each program of every submodule Git directory that the update can use. These are each initialized submodule, each `reuse` and `fetch-checkout` row, and each kept Git directory, at every depth ("Review reads"). For each submodule, it applies the §7 repository-controlled resolution rule to the `config list` output. The submodule worktree root and its Git directory act as the repository directories. A submodule Git directory lies inside the Git directory of its parent, so every local and worktree entry is repository-controlled.
- For a submodule without a `.git` entry, Git runs the programs from the worktree that it connects. That worktree is the parent worktree root plus the submodule path. Relative program paths and a relative `core.hooksPath` resolve against that path. A kept Git directory without a plan row has no known path. Its relative program paths and a relative `core.hooksPath` then enter the list as `unchecked`.
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
     - `rev-parse --verify -q HEAD`: exit 1 without output means no commit. Any other non-zero exit, or output that is no object ID, is a failure.
     - `for-each-ref --contains=HEAD`: exit 0 without output means no ref. A non-zero exit is a failure.
     - `rev-list -n 1 <target> --not --all`: a non-zero exit counts as unreachable, as Git's `is_tip_reachable` treats it (builtin/submodule--helper.c:2493-2514). The row then fetches, as in Git's own update.
     - `remote get-url --all -- <name>`: a non-zero exit is a failure. The row then runs no fallback fetch.
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
- Besides the §2 identity fields, progress events carry only the index, the count, the row ID, the phase, the percentage, and the stall flag. The phase is `fetch` or `update`, and §6 "Activity and stall notice" defines the flag. They carry no Git text. At most 4 events per second go out (§5).

### Deadlines and Cancel

- Inactivity deadline: each update process ends after 300 seconds without activity (§6 "Activity and stall notice"). This covers each clone, connect, fetch, checkout, and register step. The window leaves time for a credential helper sign-in.
- Reason: output alone is no activity signal. Git's own fetch runs without a progress option, and the checkout runs `checkout -q` (probe S16 trace). A silent local fetch read 120 MB and wrote 160 MB without an output byte (probe S16).
- Stall notice: after 15 seconds without activity, the status shows the §6 stall notice. It offers Cancel and the "Remedies" command of the running step. The notice ends no process.
- The shell enforces both limits from the request `limits` (§6 "Process fields"). At expiry it closes the Job, and the exit reply names `inactivity` or `ceiling`.
- Limits of the signal: a process that waits for console input or for a credential helper window does no I/O. It shows the stall notice and ends after 300 seconds. A helper that keeps doing I/O while it waits keeps the process alive until the ceiling. A lingering child of an earlier step stays in the same Job, so its I/O also counts.
- Ceiling: each update process ends after 4 hours, so every Git step has a finite limit.
- A deadline closes the Job at once, with every descendant. The operation moves to `reconciling` with `DEADLINE` and reason `inactivity` or `ceiling`. No later process or level starts.
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
- `failed`: a process or a run read failed, or a deadline fired. No row changed, and no row has the `fetched`, `connected`, or `registered` flag. A failed step 3 re-check also ends `failed`, with `STALE_REVIEW` or `TRUST_CHANGED` and no process.
- `failed-with-effects`: a process or a run read failed, or a Cancel or a deadline stopped work. A row changed, or a row has the `fetched`, `connected`, or `registered` flag.
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
