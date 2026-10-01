# Operation Contract: Windows Desktop Qualification

**Protocol version**: `1` | **Model**: [data-model.md](../data-model.md) | **Plan**: [plan.md](../plan.md)

This contract defines selected behavior, not implemented endpoints. Hunk and file staging use protected candidate publication; commits use the explicitly approved standard Git handoff. Validation checkpoints do not promise repository-wide atomicity. WSL2 repositories use Git inside their distro (§11). Submodule initialization and update follow §12.

## 1. Transport and authority

Use typed Tauri commands/channels between the main local webview and Rust. Register application commands through Tauri's application ACL manifest.

Grant only the operations below to the main local window. Deny remote webviews, shell execution, broad filesystem access, and unregistered application commands.

Rust and the compiled service use private inherited pipes. Frames contain a four-byte unsigned little-endian payload length followed by UTF-8 JSON.

Each pipe frame has a top-level `kind` field with the value `public`, `process`, `mutation`, or `trust`. A `public` frame holds one §2 request, its response, or a progress event. A `process` frame holds one §6 process request, one §6 identity request, one §6 lingering count request, or their output. A `mutation` frame holds one §6 recovery-marker message. A `trust` frame holds one §7 trust-store message. The shell never forwards a `process`, `mutation`, or `trust` frame to the renderer. The renderer envelope in §2 has no `kind` field.

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

Require `repositoryGeneration` for `readHistory`, `readComparison`, `applyHunk`, `applyFile`, `reviewCommit`, `commit`, `reviewSubmodules`, `updateSubmodules`, and `approveTrust`. Match trust approval against its issued fingerprint generation.

`readWorkspace` may include the last observed generation, but a mismatch must not prevent refresh. Other operations omit this field. Cancellation, revocation, and closure must remain available after a repository generation changes.

Responses contain `requestId`, `operationId`, repository generation where applicable, and a typed result. Only one terminal result exists per accepted request.

The service issues `operationId` in the accepted response. No request supplies a new `operationId`. Only `cancel` and `getOperation` name an issued one.

Progress events contain operation identity, phase, and bounded counters. They contain no raw commands, configuration, environment, patch content, or credentials.

The repeat key of a mutation is its one-use approval. For `commit`, the key is the review token. For `applyHunk`, the key is the hunk approval: comparison ID, hunk ID, and direction. For `applyFile`, the key is the file approval: comparison ID and direction. For `updateSubmodules`, the key is the submodule review token (§12). A repeated request with an approval that an accepted operation consumed returns that operation's state and `operationId`. It starts no Git process and no other execution. A new service session invalidates all old identifiers.

The service checks `requestId` before the repeat key. A repeated `requestId` gives `INVALID_REQUEST`, also when its approval was consumed. A retry after a lost response must use a new `requestId`. It then gets the consumed-approval state.

The shell starts the service and completes the startup handshake before it creates the main window. When the native settings hold a Git path, the handshake carries a startup `gitProbe` context for it (§6 "Startup contexts"). The page gets the current `sessionId` from the shell-only operation `currentSession` (§3). It calls `currentSession` at load and after each `service-session` event. `currentSession` is the only request without a `sessionId` field. No public operation carries a handshake, and no initialization script carries a session. Pinned Tauri sets initialization scripts only on builders, so a created window keeps its first script (research R7). When the service start or handshake fails, the shell still creates the window. `currentSession` then returns `SERVICE_UNAVAILABLE`, and the shell shows Git service stopped.

The shell may start the service process before it reads the platform facts, the WebView2 version, and the settings. It sends the handshake frame once those facts exist. The main window still waits for the handshake reply. When WebView2 admission fails, the shell closes the service Job and creates no window. The service answers the handshake before its startup Git probe ends (§6 "Startup contexts"). So window creation and page load overlap that probe.

The shell sends three events to the main window. `service-stopped` reports a service exit and the unresolved recovery markers (§6). The page marks each request without a terminal response as State unknown. `service-session` reports a new service session after Restart service. `text-scale` carries the Windows text scale factor after each `TextScaleFactorChanged` event (plan.md "Windows text size"). The page does not reload for a restart. Drafts are renderer state with a stored copy in webview storage (plan.md "Stored drafts"), so they survive a service restart. After each `service-session` event, the page runs `restoreWorkspace` again, because old identifiers stay invalid (§8 "Service restart"). A reloaded page joins the current service session through `currentSession`. Only Restart service or application start creates a new service session. Identifiers from an old session stay invalid in the new one.

## 3. Public operations

| Operation | Payload | Result and checks |
| --- | --- | --- |
| `getEnvironment` | Empty object. | Build identity, detected and minimum versions, selected Git, prerequisite admission, and separate qualification status. The qualification status is `passed` only when the detected version set is on a build-time list. That list holds the sets with recorded passing evidence. This slice ships that list empty, so the status stays `unverified`. Platform scope `qualification-target` for Windows 11 x64 on a native AMD64 machine with product type `VER_NT_WORKSTATION`, otherwise `other`. The recovery markers that the shell owns at session start (§6, §8). No environment dump. |
| `chooseGit` | Renderer: empty object. Service: only the native-issued `bootstrapId`. | Native executable proposal or selection, explicit approval, version probe, and installation ID. Cancel preserves the current selection. "Git proposal" below defines the native step. |
| `chooseRepository` | Renderer: empty object. Service: only the native-issued `bootstrapId`. | Native folder selection and Git registration. The result holds the `repositoryId`, the current `generation`, and the `worktreeKey` ("Worktree key" below). Cancel preserves the current workspace. A WSL path follows §11, including the distro start and its Cancel. |
| `restoreWorkspace` | Renderer: empty object. Service: only the native-issued `bootstrapId`. | Revalidate the last explicitly chosen repository from application settings. No caller-supplied path. The result holds the `repositoryId`, the current `generation`, and the `worktreeKey`. A WSL path follows §11. |
| `readWorkspace` | `refresh: boolean` and `check: "full"` or `"changes"`. `refresh: true` with `check: "changes"` gives `INVALID_REQUEST`. | Git-derived identity, HEAD, operation state, status completeness, hunk-profile eligibility, snapshot ID, and recovery state. Only a user Refresh action sends `refresh: true`, always with `check: "full"`. Focus return and the first read send `refresh: false` with `check: "full"`. The read after a mutation outcome and the read after a trust approval also send `refresh: false` with `check: "full"`. Polls send `refresh: false` with `check: "changes"` (§8 "Change check"). WSL polls send `check: "full"` instead (§11 "Change polling"). An explicit refresh of a blocked workspace performs recovery reconciliation (§8). |
| `readHistory` | Empty object. The envelope carries `repositoryGeneration`. | Bounded HistoryPage: at most 100 checkout-reachable commits, ordered parents, boundary metadata, captured HEAD, and completeness. No arbitrary ref or pagination argument. The service captures HEAD itself and needs no status snapshot. It can run beside `readWorkspace` within the §5 read caps. Trust gating follows the read rule in §7. |
| `readComparison` | Current snapshot ID and issued entry ID. | One supported canonical comparison with hunk IDs, or an explicit unsupported/limited result. Every result also carries the file-action decision of its entry (§4 "File staging"). |
| `readTrust` | Current repository ID. | Safe execution-policy summary, approval fingerprint, trust `state`, and `persistence` (`stored` or `session`). Show configuration values only for the §7 value display allowlist. Redact URL user information first (§7). |
| `approveTrust` | Issued fingerprint and explicit approval. | The service checks the fingerprint and its generation. The shell then shows a native confirmation (§7 "Trust approval store"). Approve returns the trust ID. It stores the approval, or keeps it for the service session only over a digest bound (§7). Cancel returns `canceled` and stores nothing. A changed policy requires new approval. |
| `revokeTrust` | Current trust ID. | Delete the stored approval, revoke future executable operations, and invalidate dependent approvals. Running work needs explicit cancellation. The shell also closes every lingering Job of that common directory (§6 "Lingering Jobs"). The result states how many processes ended. An unfinished mutation of that common directory ends its processes at `ended` and never lingers (§6). Without a current trust ID, no remedy or outcome text offers Revoke trust (§9 "Lingering count"). |
| `applyHunk` | Comparison ID, hunk ID, snapshot ID, and direction `stage` or `unstage`. | Profile check, fresh validation, exact candidate publication, and reconciled outcome. No renderer patch or whole-file fallback. |
| `applyFile` | Comparison ID, snapshot ID, and direction `stage` or `unstage`. | Whole-file staging of the compared entry (§4 "File staging"). Profile check, fresh validation, verified candidate publication, and reconciled outcome. No renderer path, patch, or content. |
| `reviewCommit` | Current snapshot ID. | Complete staged scope, reviewed index/checkout, execution-policy disclosure, limitations, and one-use review token. Read-only inspection only. |
| `commit` | Review token, message, and explicit full-scope confirmation. | Fresh preflight, one ordinary canonical Git commit invocation, and a reconciled outcome: `succeeded`, `completed-with-effects`, `failed`, `failed-with-effects`, `canceled`, or `unknown`. A repeated `commit` with a consumed review token returns the existing operation state and `operationId`, and starts no Git process. |
| `reviewSubmodules` | Current snapshot ID. | Read-only submodule plan (§12 "Plan"), each refusal, the submodule program list, and a one-use submodule review token. Trust gating follows the read rule in §7. |
| `updateSubmodules` | Submodule review token and explicit start. | Fresh preflight, and a native confirmation when §12 lists submodule programs. One Git update process for each top-level plan row, with progress events. A reconciled outcome with one result per submodule (§12). A repeated request with a consumed token returns the existing operation state and `operationId`, and starts no Git process. |
| `cancel` | Issued operation ID. | Cancellation-requested acknowledgement followed by the actual terminal outcome. |
| `getOperation` | Issued operation ID. | Current or retained terminal state. Never retries an operation. |
| `requestClose` | `stay`, `closeIfIdle`, or `interruptAndClose`. | The shell decides natively and never forwards this operation to the service. A running mutation always shows the native prompt, whose default is Stay open. Only its Interrupt and close button confirms interruption. |
| `currentSession` | Empty object. The envelope has no `sessionId`. | The shell answers natively and never forwards this operation to the service. The result is the current `sessionId`, or `SERVICE_UNAVAILABLE` while no service session runs. Both results carry `textScale`: the current Windows text scale factor, from 1.00 to 2.25 (plan.md "Windows text size"). |
| `dismissRecoveryMarker` | Renderer: one marker ID from `getEnvironment` or `service-stopped`. Service: that marker ID and the native-issued `bootstrapId`. | Explicit removal of a marker whose repository is gone (§6 "Dismissal"). The result states that the operation outcome stays unknown. |

The native dialog and confirmation code must not accept renderer-supplied replacements for selected paths or approval fingerprints. The trust confirmation shows only the fingerprint that the service sends.

The shell runs the native step of `chooseGit`, `chooseRepository`, and `restoreWorkspace` first. A canceled dialog returns a canceled result from the shell, and no frame reaches the service. Otherwise the shell forwards the request with its native-issued `bootstrapId` in the payload. The renderer payload must be empty, and the shell rejects any renderer field.

**Git proposal.** The native step of `chooseGit` first looks for a candidate `git.exe`. With a saved path, the candidate is that path. Without one, the shell searches its own `PATH` for `git.exe`, then tries `%ProgramFiles%\Git\cmd\git.exe`. The shell creates a `gitProbe` context for the candidate, and the service probes it. The native Git selection confirmation then shows the probed path and version. After `GIT_CHANGED` at the saved path, it also shows the stored version (data-model §1). Its buttons are Use this Git, Choose another Git, and Cancel, and Cancel is the default. Choose another Git opens the executable picker. Enter on the default, Escape, Alt+F4, the close button, and a call failure mean Cancel. Without a candidate, the picker opens directly. No candidate is ever selected without Use this Git (FR-003).

**Worktree key.** `worktreeKey` is 64 lowercase hex digits: the SHA-256 of the worktree root identity. For a Windows worktree, that identity is the volume serial number and the 128-bit file ID (§6). For a WSL worktree, it is the distro GUID, the device number, and the inode number (§11). So both WSL prefixes of one folder give one key, and the key stays equal across sessions. The key grants no access; it only names the stored draft of that worktree (plan.md "Stored drafts"). No log or diagnostic receives it.

For `dismissRecoveryMarker`, the renderer payload holds only a marker ID that the shell owns. The shell binds a `repositoryDiscovery` context to the stored worktree path of that marker. It forwards the marker ID with the `bootstrapId`. The native confirmation comes after the service result (§6 "Dismissal").

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
- PowerShell ends a single-quoted string at five characters: U+0027, U+2018, U+2019, U+201A, and U+201B. Each of them inside a value is doubled. This rule applies to every value that any remedy command of this contract holds. Examples are the Git path, the worktree root, and each path. Others are a submodule worktree, a Git directory, a branch name, and a distro name. A research R5 probe showed that doubling keeps each of them literal. The §9 hook remedy uses the same rule. `--literal-pathspecs` keeps path characters literal.
- A path with bytes that are not valid UTF-8 gets no remedy, because PowerShell cannot hold those bytes.
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
| Incoming public request | 1 MiB encoded |
| Private/reply frame | 16 MiB encoded |
| JSON nesting | 16 levels |
| Identifier | 64 ASCII bytes |
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
| Diagnostic bytes retained | 64 KiB per stream, never persisted as raw logs |
| Total unexpected diagnostic output | 4 MiB per operation before cancellation. Each `updateSubmodules` process counts its own 4 MiB, because its stderr carries progress (§12 "Deadlines and Cancel"). |
| Native stdout/stderr chunk | 64 KiB |
| Queued pipe data | 8 chunks per stream; apply backpressure |
| Registered workspaces | 8 at one time per service session. Reuse and release follow §6 "Registration reuse and release". |
| Trust approval records | 4 KiB per record and 256 records. A new record above 256 replaces the oldest record. |
| Retained comparison data | 4 comparisons and 128 MiB total |
| Approval lifetime | 60 seconds; relevant changes invalidate it sooner |
| Concurrent reads | 2 per workspace, 4 globally |
| Pending reads | 8 globally; superseded selection reads are canceled |
| Mutations | 1 per common repository; reject overlap without queueing old approvals |
| Ordinary read deadline | 30 seconds. `reviewSubmodules` and the `updateSubmodules` preflight have no total read deadline. Each of their Git commands has the 30-second deadline below, and the submodule review bound limits the command count. |
| Commit process deadline | 120 seconds, followed by interruption and reconciliation |
| Other Git process deadline | 30 seconds for each bootstrap probe, and for each `applyHunk` or `applyFile` Git step. The same deadline applies to each commit preflight read, `reviewSubmodules` read, `updateSubmodules` preflight read, and mutation reconciliation read. "Deadline outcomes" below states the result. |
| Submodule update process | An inactivity deadline of 300 seconds without an output byte. A ceiling of 4 hours for each process (§12 "Deadlines and Cancel"). |
| Submodule review | 256 submodules at all depths, 8 nesting levels below the superproject, and 1 MiB for each `.gitmodules` source. Each folder of the §12 kept-directory walk counts as one submodule. A larger set gives `UNSUPPORTED_SUBMODULE` with reason `limit` (§12). |
| Submodule progress events | 4 per second for each operation (§12 "Progress"). |
| WSL distro start | 60 seconds for the Git probe of a distro that the running list does not name (§11 "Distro start"). A deadline gives `DEADLINE`. |
| WSL poll gap | 1 second after the previous poll of that workspace ends, only while the main window has focus (§11 "Change polling"). |
| WSL anchor count | One count line for each stdin line, then one line each second after stdin closes (§11 "Process ownership"). |
| Commit failure output tail | Last 16 KiB and at most 100 lines of commit stderr (§9 "Commit failure output") |
| Cancellation/reconciliation target | 5 seconds; report unknown if state cannot be confirmed |
| Recovery markers | 4 KiB per marker and 64 markers per handshake. Above 64, the shell loads the 64 oldest markers. `getEnvironment` reports the limit and the count of files that the shell did not load. Every mutation stays blocked with `STATE_UNKNOWN`. Dismissal (§6) stays available. The block ends at the next handshake that finds at most 64 marker files. |
| Confirmed-close cleanup target | 5 seconds |

**Deadline outcomes.** Every Git process has a deadline. A deadline closes the Job of that process at once, with every descendant.

- A bootstrap probe deadline destroys the context. The registration or dismissal gives `DEADLINE`.
- A deadline of an `applyHunk` or `applyFile` Git step moves the mutation to `reconciling` (data-model §7). So does a commit preflight read deadline. Neither publication nor Git execution has started. Without observed effects, the result is `failed` with `DEADLINE`. The service releases its owned lock only after the Job closes.
- A mutation reconciliation read deadline fails reconciliation. The outcome is `unknown`, and the recovery marker stays (§8).
- The commit process deadline follows §4.
- A `reviewSubmodules` read deadline ends the read `failed` with `DEADLINE`. An `updateSubmodules` preflight read deadline moves the mutation to `reconciling`, and no update process has started.
- An `updateSubmodules` process deadline moves the mutation to `reconciling` with `DEADLINE` and reason `inactivity` or `ceiling` (§12). No later update process starts.

Count canonical patch lines once, including file and hunk headers. Ignore only the empty segment after a final newline. Split view and virtualized rows do not change this count.

Transmit the canonical patch as bounded base64 UTF-8 bytes. This prevents JSON escaping from invalidating raw-byte accounting. Validate decoding before strict patch parsing.

Render limited status/history with a visible explanation. Block mutations that depend on an incomplete status, index, trust, or comparison snapshot.

Use streaming decoders and counters. Do not collect unbounded `text()` or `arrayBuffer()` results. Cache eviction invalidates associated approvals.

Retain an accepted operation's reviewed index snapshot until required reconciliation succeeds, including while unknown state blocks recovery. An accepted `applyHunk` or `applyFile` retains the raw digests of its verified candidate and of the canonical index before publication. An accepted `updateSubmodules` retains its reviewed plan (§12). Approval expiry must not delete required verification data. Use bounded owned files when retaining index bytes would exceed memory budgets.

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
| `gitProbe` | Selected executable with fixed `version --build-options` arguments and no `--no-lazy-fetch` (§7 "Missing objects"), from the application-owned launch directory. | Validate executable identity, version, architecture, and admission policy before issuing `gitInstallationId`. |
| `repositoryDiscovery` | Admitted Git in the selected directory. Only fixed discovery profiles using `rev-parse`, `symbolic-ref`, and `show-ref`. | Resolve and validate repository paths, formats, HEAD state, and physical identities before issuing `repositoryId`. Refuse registration when `--is-bare-repository` or `--is-inside-git-dir` reports true, with `UNSUPPORTED_REPOSITORY`. For a bare repository, the remedy is: open a worktree of it, or clone it. For a Git administration folder, the remedy is: open the working folder that contains it. Classify Git's ownership refusal as `DUBIOUS_OWNERSHIP` by exit status and message prefix. Show the path and Git's suggested command as copyable text, and never run that command. Classify a folder outside every repository as `NOT_A_REPOSITORY`: exit status 128 and a stderr prefix `fatal: not a git repository (or any` (research R2). The remedy is: "Open a folder inside a Git repository." A probe past its §5 deadline gives `DEADLINE`. Other discovery failures use `REPOSITORY_UNAVAILABLE`. |
| `registeredOperation` | Service-constructed Git operation against registered Git and repository IDs. | Normal operation and reconciliation rules apply. |

Discovery profiles use only the documented identity queries in `research.md`. They accept no renderer-provided arguments, refs, paths, or environment overrides.

Discovery probes run under a fixed C locale, so Git messages stay unlocalized. Ownership and bare-repository refusals come before the configuration listing in §7.

A WSL path gets its route, identity, Git, and process rules from §11. Its identity comes from the §11 `stat` probe, never from `FileIdInfo`.

No discovery profile loads the index, because an index load can run a command-valued `core.fsmonitor` before trust approval. So discovery never runs `rev-parse --shared-index-path` (research R2). Split-index state comes from the raw index bytes (§4). A research R2 probe ran every discovery and trust-listing query with repository canaries, and none ran.

The service constructs the fixed probe arrays and parses their results. Native code validates the context and selected target, not Git semantics.

A bootstrap context lasts at most 60 seconds and belongs to one registration or marker dismissal. It can perform that operation's required discovery probes. Cancellation, failure, completion, or service restart destroys it.

Revalidate the selected file/directory identity before execution and registration. A changed target requires a new selection. No bootstrap context permits mutation or general repository reads.

Permanent IDs become valid only after successful registration. Bootstrap probes use the same Job ownership, output bounds, environment controls, and failure cleanup. Each probe process also has the §5 30-second deadline. Each discovery probe passes `--no-lazy-fetch`, and the `gitProbe` version probe runs without it (§7 "Missing objects").

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

**Console and input.** One rule covers every process that the shell starts:

- No console. The shell starts the compiled service and every Git for Windows process with `DETACHED_PROCESS`. It never passes `CREATE_NO_WINDOW` or `CREATE_NEW_CONSOLE` to them. A Git process without a console starts each child with `DETACHED_PROCESS`, hooks and `ssh` included (compat/mingw.c:2247-2263). So no process of an operation can wait for input on a hidden console. With `CREATE_NO_WINDOW`, Git would own a hidden console, and its children would inherit it.
- One exception: `wsl.exe` gets `CREATE_NO_WINDOW`, because a detached `wsl.exe` relayed no output (§11 "Process launch", research R14 probe S10). The §11 wrapper then runs each program that it wraps through `setsid --wait`. So no Git process or hook gets the hidden console as its terminal. The §11 bootstrap probe and the anchor run without the wrapper and without `setsid`. Neither opens a repository or runs a repository program.
- No terminal prompt. Every §7 environment policy sets `GIT_TERMINAL_PROMPT=0`, and the §11 wrapper sets it in every mode. Git then fails instead of asking for a user name or password on a terminal (Git `Documentation/git.adoc`).
- Stdin. Every child gets a stdin pipe. The shell writes the bounded `input`, then closes its end of the pipe. Without `input`, it closes that end at once. So a child that reads stdin gets end-of-file, never a wait.
- Exception: the §11 anchor of a WSL mutation. Its stdin stays open from its start until `ended`. The shell writes one line after each execution process exits, and closes the pipe at `ended`. A closed pipe would end the anchor at count 0 before Git starts. Then no process of the mutation would stay in the Job. Close and Revoke trust could then not end lingering scopes (§11 "Process ownership"). The anchor runs no repository program.
- The rule changes no user configuration. The app never sets `core.sshCommand`, `GIT_SSH_COMMAND`, `core.askPass`, `credential.*`, or a `GCM_*` variable. A credential helper can still show its own window (§12 "Environment and console").
- Evidence: T027 runs a real `pre-commit` hook that waits for terminal input, and T162 repeats it in the installed build. Until they pass, the hook behavior without a console stays unverified.

Enforce Windows' command-line length limit before starting a child. Prefer Git's NUL-delimited stdin facilities for literal path collections.

Use only intended inherited pipe handles. Create the child suspended and assign its Job before resuming it. Assignment failure terminates the owned suspended child; execution must not continue unmanaged.

Each operation has its own Job. The service has a separate Job. Each operation Job and the service Job use kill-on-close and no breakaway. Their handles stay non-inheritable. A shell crash closes these handles and ends every owned descendant. Canceling one operation must not stop unrelated reads.

Drain stdout and stderr independently. Enforce caps before forwarding chunks to Bun. After service failure, close every operation Job outside the lingering set. Lingering Jobs stay (below).

**Completion signal.** A process ends when its process handle signals, never at pipe EOF. A descendant can inherit a pipe and keep it open after the process exits. A research R5 probe saw Git exit after 0.25 seconds while a `post-commit` child held stderr for 8.3 seconds. At the signal, the shell forwards the bytes that each pipe already holds, within the caps. Then it keeps draining each pipe into a discard sink until EOF or Job close. So a writing descendant never blocks or fails on the pipe, and memory does not grow. Discarded bytes count toward no cap. The app never forwards, shows, retains, or logs them. The exit reply follows the forwarded bytes.

These controls manage normal owned process trees. They do not sandbox arbitrary trusted hooks or external service launches.

### Lingering Jobs

Processes that Git or a hook starts during a mutation can outlive the mutation's Git process, as with command-line Git. Examples are detached maintenance, a `post-commit` hook child, and a built-in fsmonitor daemon (§4). The shell keeps them owned and ends them at application close (SC-008).

- The shell associates one completion port with each operation Job before it assigns the first process. Microsoft advises association while the Job is inactive, so no state change goes unreported (research R5).
- When an owned child exits by itself, the shell reads the active process count of its Job through `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION`. The exit reply carries that count as `activeDescendants`. It carries no process name, PID, or argument.
- The service records `lingeringDescendants` in the mutation outcome. The value is the `activeDescendants` count of the last execution process before reconciliation. For `commit`, that process is `commit --quiet --file=-`. For `updateSubmodules`, it is the last update process that ran (§12). When the service sets `endProcesses` (below) before the terminal response, the value is 0. The count alone never changes the outcome classification. A nonzero count adds the plan.md lingering sentence to every mutation outcome text, success included (plan.md "Required visible states").
- At `ended`, the shell reads the active process count again. A zero count closes the Job handle. Otherwise the Job moves to the lingering set, and the shell reads the count once more. A zero count then closes the handle.
- An `ended` frame with `endProcesses: true` closes the Job at once, with every descendant, and it never lingers. The service sets it after a cancellation during `reconciling` (§8). It also sets it when `revokeTrust` for that common directory came after `started`.
- The shell tags each mutation Job with the common-directory identity that it reads for the `started` frame. The tag survives a service restart.
- A `revoke` trust frame (§7) closes every lingering Job whose tag equals the identity of its common-directory path. The reply states how many processes were active in those Jobs before the close.
- A lingering count request is a `process` frame with one common-directory path. The shell reads its identity and returns the total active process count of the lingering Jobs with that tag. It carries no process name, PID, or argument. §9 uses the count in remedies.
- A lingering Job belongs to no running operation. It closes when the port reports `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO` for it, or when the application closes.
- Port message delivery is not guaranteed (research R5). At each `ended` frame, the shell also reads the count of each lingering Job and closes each empty one. A missed message therefore keeps only an empty handle, never a process.
- One shell thread reads the port with `GetQueuedCompletionStatus` and a 1-second timeout. It stops at application close.
- Cancellation, deadline expiry, and Interrupt and close close the operation Job at once, with every descendant. They never create a lingering Job. A cancellation during `reconciling` closes the Job at `ended` instead, so reconciliation reads can finish (§8).
- Read operation Jobs never linger. A read Job closes when the read ends.
- A service exit or Restart service keeps every lingering Job. The shell owns these Jobs, and they belong to no running operation. They close at application close.
- Application close closes every lingering Job, after the operation Jobs and before the service Job. Kill-on-close ends every remaining process. This holds for `closeIfIdle`, Interrupt and close, and Restart Arbareto. A shell crash closes the handles as well.
- Lingering Jobs alone never make a mutation count as running, so `requestClose` shows no prompt for them (research R7).
- A WSL mutation Job also holds its anchor. Its process counts come from the anchor, not from the Job accounting (§11 "Process ownership").
- A lingering process can hold a Git lock file. For `index.lock`, the next mutation gives `LOCKED` with the §9 remedy. Another lock, such as a ref lock or `HEAD.lock`, makes Git fail (§9 "Other locks"). The app never removes a lock. Reconciliation names an observed lock as foreign (§8).

### Recovery markers

The shell stores one marker file for each mutation without a stated outcome. The files live in the `recovery` folder of the application data directory.

A marker holds its ID, the operation kind, and the start time. It also holds the Git-resolved worktree and common-directory paths and the common-directory identity. It holds no message, patch, configuration, environment value, or credential.

The service sends three `mutation` frames:

- `started` with `operationId`, `repositoryId`, `kind`, and the Git-resolved worktree and common-directory paths. The service sends it before it creates the canonical index lock. That lock is the first side effect of every mutation protocol. See research R3 step 4, R4 step 2, and §4 "File staging" step 2. Exception: `updateSubmodules` takes no canonical index lock, and its first side effect is its first update process (§12 "Update protocol"). The shell reads the common-directory identity itself through `FileIdInfo`. Then it takes the named mutex `Local\Arbareto-mutation-<SHA-256 of that identity>` without waiting ("Cross-instance exclusion" below). It writes and flushes the file, then replies with the marker ID. When the write or flush fails, it replies with the failure class: `disk-full`, `access-denied`, or `other`. Without a marker ID, the service creates no lock and starts no Git process. A failure reply refuses the mutation with `RECOVERY_MARKER_FAILED` (§9).
- `ended` with `operationId` and `endProcesses` ("Lingering Jobs"), after the terminal response. From `started` to `ended`, the shell treats the mutation as running for `requestClose`. After a service exit, `ended` never arrives. The shell then closes every operation Job outside the lingering set, and afterwards no mutation counts as running. Lingering Jobs stay until application close ("Lingering Jobs"). The marker file stays.
- `resolved` with the marker ID. The service sends it after a known outcome, or after a recovery refresh states an `unknown` outcome (§8). The shell then deletes the file.

**Cross-instance exclusion.** FR-015 covers every running instance in one Windows logon session, and the §5 mutation bound covers one service. So the shell adds one named mutex per common-directory identity:

- A mutex that another instance holds gives the `started` reply `busy`. The shell then writes no marker. The service refuses the mutation with `BUSY` and the remedy "Another Arbareto window runs a change in this repository. Wait until it ends, then try again." No lock and no Git process starts.
- `WAIT_ABANDONED` counts as taken, because the owning instance stopped. Its marker waits for the next handshake scan, and this mutation still runs every checkpoint.
- The shell releases the mutex at `ended`. After a service exit, it releases the mutex when it closes the operation Jobs. Process exit releases it too. A Windows mutex belongs to its acquiring thread, so one shell thread takes and releases every such mutex.
- Lingering Jobs hold no mutex, as in one instance ("Lingering Jobs").
- Linked worktrees share the common-directory identity, so two instances never mutate two linked worktrees at once.
- Git's own `index.lock` still guards one index against every other writer. A second writer of that index gets `LOCKED` (§9).
- Scope: the mutex name uses the `Local\` prefix, so it exists only in one logon session. FR-015 states this scope. Instances in two logon sessions of one computer do not exclude each other. Between them, Git's `index.lock` still guards each index. Two linked worktrees have separate indexes, so two sessions can mutate them at once. Design decision, 2026-10-01: keep `Local\` (research R11).

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

Every policy also removes each variable whose name starts with `GIT_TEST_`. Git's test suite defines these variables as test knobs (Git `t/README`). `GIT_TEST_SPLIT_INDEX=1` split a private candidate in research R3 probe 9.

These policies build the environment of Git for Windows. A `wsl.exe` process gets an empty `WSLENV`, so no Windows variable reaches Linux Git (§11 "Trust and environment").

Every policy (`probe`, `read`, `mutation`, and `network`) preserves `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, and `GIT_CONFIG_NOSYSTEM` unchanged from the service environment. These variables select which global and system files Git reads (Git `Documentation/git.adoc`). Removing them would change the user's effective configuration (FR-003).

Every policy also preserves `GIT_CONFIG_COUNT`, each `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`, and `GIT_CONFIG_PARAMETERS`. Git reads them as `command` scope, which is protected configuration (Git `Documentation/git-config.adoc`). Every policy also preserves `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_AUTHOR_DATE`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`, `GIT_COMMITTER_DATE`, and `EMAIL`. They override configured identity, so their removal would change identity (FR-003). The `probe` and `read` policies remove `GIT_CONFIG`. It redirects only `git config`, so it would hide local keys from the trust listing (research R7). The `mutation` and `network` policies preserve it for hooks.

Every policy (`probe`, `read`, `mutation`, `mutation-trace2`, and `network`) sets `GIT_TERMINAL_PROMPT=0`. Git then never prompts on a terminal (Git `Documentation/git.adoc` `GIT_TERMINAL_PROMPT`). §6 "Console and input" states the full rule. The `network` policy serves only the `updateSubmodules` update processes (§12). It equals `mutation` without `GIT_INDEX_FILE`. No policy sets or removes `GIT_SSH_COMMAND`, `GIT_ALLOW_PROTOCOL`, or `GIT_PROTOCOL_FROM_USER`.

A trace2 event target comes only from the T091 probe result (research R4). The probe checks whether trace2 events identify hook and signing children. Without that probe result, no policy adds a trace2 variable. With it, `git-environment.json` adds the fixed policy `mutation-trace2`, which is `mutation` plus a trace2 event target. `GIT_TRACE2_EVENT` overrides a user's `trace2.eventTarget` (Git `Documentation/config/trace2.adoc`). So the service selects `mutation-trace2` only in one case. The service environment has no `GIT_TRACE2_EVENT`, and the effective configuration has no `trace2.eventTarget`. Otherwise it selects `mutation`, and hook and signing failures stay `GIT_FAILED` with a recorded reason.

**Missing objects.** A partial clone fetches a missing object on demand. That fetch runs the transport program that repository configuration names, such as `remote.<name>.uploadpack`. A research R5 probe saw `status`, `diff-files -p`, `diff-index --cached -p`, `ls-files --eol`, and `commit` run such a canary without trust approval. So every Git command that the app starts passes the global option `--no-lazy-fetch` first. This covers discovery, the trust listing, reads, reconciliation reads, `applyHunk` and `applyFile` steps, `commit`, and every `reviewSubmodules` and `updateSubmodules` command. Reads also pass `--no-optional-locks`.

- Exception: the two version probes run without `--no-lazy-fetch`. They are the `gitProbe` `version --build-options` (§6) and the WSL `--version` (§11 "Git per distro"). Git added the option in 2.45.0 (Git `Documentation/RelNotes/2.45.0.adoc`). An older Git rejects it with "unknown option" (research R13 P3). With the option, the `GIT_UNSUPPORTED` refusal could not name the found version. A version probe runs outside any repository: from the application-owned launch directory, or from `/` in a distro. It opens no repository and fetches nothing.

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

Status and diff reads pass `--ignore-submodules=dirty`. Superproject reads never start Git inside a submodule. The scoped listing above cannot see a submodule's local configuration, so the gate cannot cover it. The superproject view shows a changed submodule commit, not changes inside the submodule. One exception exists: `reviewSubmodules`, and the preflight and reconciliation of `updateSubmodules`, run fixed commands inside submodules. They cover initialized submodules and kept submodule Git directories (§12 "Review reads"). None of them loads an index or runs a repository program. The §12 submodule program list covers submodule configuration and hooks.

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
- Over a bound, `readTrust` reports the reached bound and `persistence` `session`. `approveTrust` still accepts an explicit approval. Its `confirm` frame carries `persist: false`. The native confirmation names the reached bound and states: "Arbareto cannot check these program files for later edits. This approval lasts until Arbareto closes or its Git service restarts." On Approve, the shell writes no record. The service keeps the approval for the service session. The session ends when Arbareto closes or at Restart service (§2). An edit of an `unchecked` file keeps that session approval, and the confirmation says so. The next session reports `untrusted`, also after Restart service.
- Reading a program file runs nothing. The stored record keeps one fingerprint digest, so the record format stays unchanged.

**Submodule registration keys.** The fingerprint omits `submodule.<name>.url`, `submodule.<name>.active`, and each `submodule.<name>.update` value that does not start with `!`. Git's submodule initialization writes these keys into the parent's local configuration (research R14 probes S1 and S5). None of them names a program. So an `updateSubmodules` run keeps a stored approval valid, and no approval loop starts. A `submodule.<name>.update` value that starts with `!` names a command and stays in the fingerprint. The §12 review shows every URL, redacted, before the start.

**Mutation trust.** A mutation needs approved trust only when it can run a repository-controlled integration (Constitution V, FR-025).

- `commit` needs approval when the fingerprint lists such an integration that `git commit` can run. These are hooks for `pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit`, `post-index-change`, `reference-transaction`, and `pre-auto-gc`. They also include signing programs, clean filters, and command-valued `core.fsmonitor`. The signing programs are `gpg.program`, `gpg.<format>.program`, and `gpg.ssh.defaultKeyCommand`. Git runs `gpg.ssh.defaultKeyCommand` when SSH signing has no `user.signingKey`, and a research R4 probe observed it during `commit`.
- `applyHunk` runs `apply --cached`, `hash-object --no-filters`, `read-tree`, and `ls-files` on a private index, each with `--no-lazy-fetch`. Its supported profile refuses index-change hooks, executable monitors, and custom filters (§4). So `applyHunk` runs no repository-controlled program. It needs approval only when its reads need it.
- `applyFile` runs `update-index`, `read-tree --empty`, `ls-files`, and `cat-file --batch-check` on a private index, each with `--no-lazy-fetch`. The §4 "Blob proof" adds `cat-file --filters --path` and `hash-object --stdin --path` without `-w`. On a private index, `update-index` still ran a command-valued `core.fsmonitor` and a `post-index-change` hook (research R3). The profile refuses both, and `stage` refuses a path with a `filter` attribute (§4 "File staging"). So `applyFile` runs no repository-controlled program. It needs approval only when its reads need it.
- `updateSubmodules` needs the superproject approval only when its reads need it. Its update process loads the superproject index, so a command-valued `core.fsmonitor` runs (research R14 probe S3). The read gate already covers that key. It refuses a `submodule.<name>.update` value that starts with `!` (§12 "Refusals"). Programs inside submodules need the §12 run confirmation instead, which stores nothing.
- A changed fingerprint gives `TRUST_CHANGED` at every checkpoint, also without required approval.
- Without required approval, the next `readWorkspace` observes the new fingerprint. A new selection or review then clears `TRUST_CHANGED`.
- With required approval, trust `state` becomes `changed`. Only an approval of the new fingerprint clears it. A new selection or review follows.
- Without required approval, a stored record with another fingerprint keeps trust `state` `changed` for display only. It blocks no read, hunk or file control, or mutation. The record stays. So renewed approval still applies when an approval becomes required again (FR-025).
- `readTrust` returns `approvalRequired` separately for reads and for `commit`.

Missing approval never disables a hook. A mutation that needs approval refuses with `TRUST_REQUIRED` before any process starts. It refuses with `TRUST_CHANGED` when trust `state` is `changed`.

**Trust approval store.** Approval persists across launches (spec Clarifications, 2026-09-30). The shell stores one record for each worktree in the `trust` folder of the application data directory. The fingerprint is per worktree, because worktree configuration, relative program paths, and a relative `core.hooksPath` resolve per worktree. A record holds the Git-resolved common-directory path and its `FileIdInfo` identity. It also holds the Git-resolved worktree root and administration-directory paths and their `FileIdInfo` identities. These identities form the worktree identity (data-model §2). It also holds the approved fingerprint, the approval time, and the executable identity digest of the selected Git (data-model §1). It holds no configuration value, command text, environment value, or credential. The fingerprint is the digest that `readTrust` returns. Each startup handshake carries every record. The service sends three `trust` frames:

- `confirm` with the worktree path, the worktree administration-directory path, the common-directory path, the Git installation digest, the fingerprint, and `persist`. The service computes the digest from the executable identity (data-model §1). The shell reads the common-directory identity and the worktree identity itself. It shows a native confirmation that names the worktree path and the fingerprint. With `persist: false`, it also shows the reached bound and the session-only text from "Program file digests". Its buttons are Approve and Cancel, and Cancel is the default. Enter on the default, Escape, Alt+F4, the close button, and a call failure mean Cancel. On Approve with `persist: true`, the shell writes and flushes the record. It replaces every record of the same worktree. A record is of the same worktree when both its common-directory identity and its worktree identity match. It is also of the same worktree when both its common-directory path and its worktree root path match. Records of other worktrees of that common directory stay unchanged. With `persist: false`, it writes no record and deletes every record of the same worktree, because none matches the new fingerprint. Then it replies `approved`. Otherwise it replies `declined`, and `approveTrust` ends `canceled`.
- `revoke` with the common-directory path. The shell reads the identity of that path. It deletes every record whose common-directory identity or path matches, for every worktree of that common directory. It also closes every lingering Job with that identity tag (§6 "Lingering Jobs"). Then it replies with the count of processes that the close ended. `revokeTrust` then invalidates the trust ID and returns that count.
- `confirmRun` with the worktree path, the submodule paths, and the count of listed submodule programs (§12 "Trust"). The shell shows a native confirmation with the §12 text. Its buttons are Run and Cancel, and Cancel is the default. Enter on the default, Escape, Alt+F4, the close button, and a call failure mean Cancel. Run replies `approved`, and any other result replies `declined`. The shell writes, replaces, and deletes no record.

The service derives trust `state` from the records and from its session approvals. A record matches when its common-directory identity and its worktree identity equal those of the workspace. `approved` needs a matching record, or a session approval, with the same Git installation digest and fingerprint. A matching record with another digest or fingerprint gives `changed`. So does a record with the same common-directory path and worktree root path but another identity. No record gives `untrusted`. A revoked trust ID gives `revoked`.

Do not disable required hooks to obtain a successful result. Do not add an application-owned hook without approved scope changes.

Logs stay in memory for the session; this slice writes no log files. Logs contain only allowlisted operation kinds, internal IDs, durations, safe codes, counts, and reconciled effect summaries. Do not retain raw stderr, hook output, messages, patches, environment blocks, or configuration dumps. Two response fields carry Git or hook output: the commit failure output (§9) and each submodule output tail (§12). They never enter a log, a `diagnostic`, or a progress event.

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
- For `updateSubmodules`, no attribution step runs. The refresh re-reads every row of the retained plan with the §12 review reads and states each row state. Without a retained request, it reports attribution `unknown` with reason `no-retained-request`, and the next review shows the observed submodule states.

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
- `rejected`: the refusal code.

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
- `WSL_UNAVAILABLE` carries one reason: `wsl-missing`, `distro-missing`, `not-wsl2`, `no-user-manager`, `no-setsid`, or `start-failed` (§11). Its remedy texts are:
  - `wsl-missing`: "WSL is not available on this computer. Install WSL2, then open the folder again."
  - `distro-missing`: "No registered WSL distro has the name <name>. Open the folder through a listed distro."
  - `not-wsl2`: "Distro <name> is not a WSL2 distro. Arbareto opens repositories only in WSL2 distros."
  - `no-user-manager`: the §11 "Process ownership" text.
  - `no-setsid`: "Arbareto needs the setsid program in <distro> to run Git without a terminal. Install the util-linux package in the distro, then open the folder again."
  - `start-failed`: "WSL could not start distro <name>. Start it in a terminal, then open the folder again."
- For a WSL Git, `GIT_UNSUPPORTED` carries reason `version` or reason `windows-git` (§11 "Git per distro"). Reason `version` carries the found and required versions. The `windows-git` text is: "The git command in <distro> is Git for Windows. Install Linux Git 2.55.0 or later in the distro."
- `UNSUPPORTED_REPOSITORY` carries reason `wsl-path` or `mixed-location` for the §11 path rules. The `wsl-path` text is: "This path holds a name that Windows cannot show. Open another folder." The `mixed-location` text is: "The worktree and its Git directories must all lie inside one WSL distro, or all on Windows."
- `UNSUPPORTED_SUBMODULE` carries one reason and the submodule path: `unsaved-commits`, `update-mode`, `clone-interrupted`, `no-url`, `path`, `gitdir-config`, or `limit` (§12 "Refusals"). §12 gives each text and remedy.
- A submodule preflight that detects a changed plan, submodule HEAD, `.git` entry, or program list gives `STALE_REVIEW` (§12 "Update protocol").
- An `updateSubmodules` process deadline gives `DEADLINE` with reason `inactivity` or `ceiling`. Other `DEADLINE` results carry no reason.
- A registration beyond 8 workspaces registered at one time gives `WORKSPACE_LIMIT`. The result names the limit. Only linked worktrees of one common directory can reach it (§6 "Registration reuse and release").
- A registration that would release a workspace with an unfinished mutation gives `BUSY`.
- A mutation whose `started` frame finds the cross-instance mutex held gives `BUSY` with the §6 "Cross-instance exclusion" remedy.
- A failed recovery-marker write gives `RECOVERY_MARKER_FAILED` with the failure class and the `recovery` folder path. Its remedy is: "Arbareto could not save its recovery record. Free disk space or restore write access to this folder, then try again." No lock and no Git process exist yet.
- A hook or signing failure gives `HOOK_FAILED` or `SIGNING_FAILED` only from structured evidence (research R4). Without that evidence, the result is `GIT_FAILED` with a recorded reason.
- `HOOK_FAILED` and a commit `GIT_FAILED` carry a copyable remedy command. It is the PowerShell command `& '<selected Git path>' --no-lazy-fetch -C '<worktree root>' hook run --ignore-missing pre-commit`, quoted by the §4 rule. It runs the traditional and configured `pre-commit` hooks and creates no commit (research R4). The remedy text is: "This command runs the pre-commit hook in a terminal and does not commit. Other hooks show their output only here. Arbareto keeps your message." No single command reproduces `prepare-commit-msg`, `commit-msg`, or signing without the message, so the app offers none for them.

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

**Lingering count.** Before a `LOCKED` result, a commit failure, or a failed `updateSubmodules` outcome, the service sends the §6 lingering count request. The request names the common directory. A nonzero count adds this sentence to the remedy: "Arbareto still runs <count> processes that Git or a hook started in this repository. Closing Arbareto ends them." When the workspace holds a current trust ID, the remedy adds: "Revoke trust also ends them." `revokeTrust` needs that ID (§3), and an untrusted repository has none.

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
- Verify that each remedy command stays literal with each PowerShell single-quote character in each value that it holds. The values include a path, the worktree root, a submodule worktree, and a Git directory.
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
- Verify that no Linux process of an operation remains after cancellation, a deadline, or a service failure. Verify the same after Revoke trust and application close. Check with `pgrep` in the distro. A plain, a `nohup`, and a `setsid` hook child each linger until one of those events. The outcome counts them. A hook that opens `/dev/tty` fails at once. A distro without `setsid` gives `WSL_UNAVAILABLE` with reason `no-setsid`.
- Verify that a `started` frame gives `BUSY` while another instance holds the mutex of that common directory. A linked worktree gives the same result. Verify that `WAIT_ABANDONED` counts as taken.
- Verify that `worktreeKey` stays equal across sessions and for both WSL prefixes, and differs for two linked worktrees.
- Verify that a failed `applyFile` `stage` carries a bounded, sanitized, redacted `outputTail` and the `add` remedy.
- Verify that a WSL poll runs 1 second after the previous poll ends and only while the window has focus. It never runs beside another read of that workspace.
- Verify that `updateSubmodules` gives the submodule HEADs, Git directories, and configuration keys of `git submodule update --init --recursive` in a copy, two levels deep. Verify the `:(literal)` pathspec with a `[1]` path.
- Verify that `reviewSubmodules` runs no submodule canary: `core.fsmonitor`, filters, hooks, `core.sshCommand`, `credential.helper`, and `remote.origin.uploadpack`. Verify that no submodule program runs before an approved `confirmRun`, and that a declined one starts no update process.
- Verify the same for canaries in the kept Git directory of a deinitialized submodule and of its nested submodule. The program list holds each of them.
- Verify that a fetching row lists the remotes of the submodule and marks the default remote. A kept `remote.origin.url` that differs from the parent URL gets the note.
- Verify each §12 refusal, and that a local `submodule.<name>.update=!command` canary never runs.
- Verify that an `ext::` URL runs no program, and that a `file` URL fails without `protocol.file.allow`. The app sets no `protocol.*` key.
- Verify that a stored superproject approval stays `approved` after an update that registers submodules.
- Verify Cancel during a clone, the inactivity deadline, and the ceiling. Reconciliation reports every changed row and each interrupted clone, and removes no file.
- Verify that a submodule blocked by local changes keeps its HEAD and changes. The outcome is `failed-with-effects` when another row changed.
- Verify that each failed row carries a redacted `outputTail` and its remedy command, and that no log holds the output.

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

- When the running list does not name the distro, registration or restore enters phase `wsl-starting`. The renderer shows "Starting WSL distro <name>" with Cancel.
- The first WSL process starts the distro, as `wsl.exe` does for any command. That process is the Git probe ("Git per distro" below). Its deadline is the §5 WSL start deadline.
- The renderer sends Cancel as `cancel` with the `operationId` of the accepted registration request. Cancel closes the probe Job. Registration ends `canceled`, and the current workspace stays unchanged. The distro can keep starting after Cancel, and the app does not stop it.
- A deadline gives `DEADLINE`. A `wsl.exe` failure gives `WSL_UNAVAILABLE` with reason `start-failed`. The result carries the bounded `wsl.exe` error text as plain text, such as `Wsl/Service/WSL_E_DISTRO_NOT_FOUND` (P3).
- After registration, any WSL process can start a stopped distro again. The ordinary §5 deadlines then apply. A read that meets a slow start can end `failed` with `DEADLINE`, and the next poll reads again.

### Git per distro

- One bootstrap probe per distro runs a fixed `/bin/sh -c` script with `LC_ALL=C`. It takes no repository argument. It runs before the helper paths exist, so it runs without the wrapper. It starts only `command -v`, `readlink`, `head`, `stat`, `git --version`, and the empty scope test below. It resolves `git`, `systemd-run`, `systemctl`, and `setsid` with `command -v` and `readlink -f`. It prints each absolute path, the first two bytes of each file, and the `git --version` text. It prints `stat --dereference --format=%d:%i:%s:%Y` of the Git file as its identity. It tests one empty `systemd-run --user --scope` call.
- `--version` runs without `--no-lazy-fetch`. Linux Git 2.43.0 rejected that option with "unknown option" (P3). With it, the floor refusal could not name the found version. `--version` opens no repository and fetches nothing. Every other Git command keeps `--no-lazy-fetch` first (§7 "Missing objects" states this exception once).
- Three cases give `GIT_UNSUPPORTED` with reason `windows-git`. They are a resolved path under `/mnt/` and a file that starts with the bytes `MZ`. The third is a version text with `.windows.`. The `PATH` of an `--exec` process holds Windows directories, and interop runs Windows programs (P2).
- A resolved `systemd-run` or `systemctl` that fails the same rule gives `WSL_UNAVAILABLE` with reason `no-user-manager`. So does a failed scope test ("Process ownership" below).
- A missing `setsid`, or one that fails the same rule, gives `WSL_UNAVAILABLE` with reason `no-setsid`. Every wrapper mode needs it ("Process launch" below). The util-linux package provides it.
- No `git` gives `GIT_UNAVAILABLE` with the remedy "Install Git 2.55.0 or later in <distro>."
- A version below 2.55.0 gives `GIT_UNSUPPORTED` with reason `version`. Compare `major.minor.patch` numerically. An unparseable version gives the same result. The text names both versions: "Git <found> in <distro> is older than 2.55.0. Install Git 2.55.0 or later in the distro."
- The native Git selection confirmation (§3 "Git proposal") then shows the distro, the Git path, and the version. Its buttons are Use this Git and Cancel, and Cancel is the default. Enter on the default, Escape, Alt+F4, the close button, and a call failure mean Cancel. Only Use this Git issues the `gitInstallationId` of that distro.
- Native settings keep the approved path, version text, and identity for each distro GUID. A later probe with another identity gives `GIT_CHANGED` and a new confirmation. The app never selects another Git without that confirmation (FR-003).
- A WSL repository never uses Git for Windows. Windows Git on a `\\wsl.localhost` path failed with "detected dubious ownership" (R13).

### Process launch

Every WSL process is a `wsl.exe` process in an operation Job. The shell creates it suspended and assigns its Job, as §6 states. It supplies `%SystemRoot%\System32\wsl.exe` through `lpApplicationName`. It creates the process with `CREATE_NO_WINDOW`, so `wsl.exe` has a hidden console. With `DETACHED_PROCESS`, a probe command ran, but `wsl.exe` relayed no output (research R14 probe S10). Its environment holds `WSL_UTF8=1` and an empty `WSLENV`. So a `wsl.exe` error message arrives as UTF-8, as Git output does, and the setting never reaches Linux. The argument array is:

`--distribution <distro> --cd / --exec /bin/sh -c <wrapper> sh <unit> <mode> <index file or empty> <systemd-run> <systemctl> <setsid> <program> <program arguments>`

- For Git, `<program>` is the approved Git path, and the program arguments are `--no-lazy-fetch -C <Linux worktree root> <Git arguments>`. `--no-lazy-fetch` stays the first Git argument.
- `--exec` passes each argument to the program without a Linux shell (P3; Git Extensions PR #13271). The wrapper is a constant text and passes its arguments only as `"$@"`. So no argument reaches shell parsing.
- `--cd /` fixes the Linux working directory. `--cd` with a missing directory ran the command in `/` with exit status 0 (P3). So the repository directory reaches Git as `-C`, and Git fails on a missing directory.
- `<unit>` is `arbareto-<operationId>-<n>.scope`. `<n>` counts the processes of the operation.
- `<mode>` is `probe`, `read`, `mutation`, or `network`. In `probe` mode, the wrapper sets `LC_ALL=C` for the program (§6 fixed C locale). A non-empty index file sets `GIT_INDEX_FILE`. Only `mutation` passes one.
- `network` mode serves only the `updateSubmodules` update processes (§12). Inside the distro it behaves as `mutation` mode. Only the service side differs: the process uses the §7 `network` policy and the §12 deadlines.
- Every mode passes the approved `setsid` path (spec Clarifications, 2026-10-01).
- `src/contracts/wsl-process.json` holds the wrapper and anchor texts. The shell embeds that file at build time. The service and the test double read the same file.

The wrapper does four things:

1. It traps `SIGHUP`. The trap ends the scope with `systemctl --user kill --signal=SIGKILL -- <unit>` and exits. The command gets `SIGHUP` when its `wsl.exe` ends (P1).
2. It sets `GIT_TERMINAL_PROMPT=0` in every mode (§6 "Console and input"). It starts `systemd-run --user --scope --quiet --collect --unit=<unit> -- <setsid> --wait <program>` in the background, with the original stdin, and waits for it. A trapped signal interrupts `wait` at once. A foreground child delays the trap until the child ends (P1 S4 and S4b). This holds in every mode.
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
- The anchor traps `SIGHUP`, and the trap ends every `arbareto-<operationId>-*.scope`. For each stdin line, the anchor prints the process count of those scopes, read from their `cgroup.procs` files. After stdin closes, it prints the count once per second and exits at count 0.
- For a WSL mutation, `activeDescendants` is the count that the anchor prints after the last execution process exits. At `ended`, the shell closes the stdin of the anchor. When the anchor exits, the Job empties, and the §6 port rules close it.
- Every Job close ends the scopes of its operation. A Job closes at cancellation, a deadline, Interrupt and close, or `endProcesses`. It also closes at Revoke trust, a service failure, application close, or a shell crash. `wsl.exe` ends, the command gets `SIGHUP`, and the trap ends the scopes. In P1, ten cancellation runs and ten lingering runs left no Linux process 1 second after the Job close.
- The §6 lingering count of a WSL Job is the last anchor count. That count is at most 1 second old. Revoke trust reports it.
- Git runs in its own session without a controlling terminal, in every mode ("Process launch"). So the wrapper exit sends no `SIGHUP` to its children. Every child that keeps running after Git exits lingers in its scope and counts, as on Windows. Before 2026-10-01, a plain child ended at the wrapper exit (P1 S6); that result no longer describes this design.
- Application close needs no WSL call beyond the Job closes. The 5-second close target covers the traps.

### Paths and file access

- The service converts paths only at the Git argument boundary: the `-C` directory and the candidate index file. Entry paths stay Git path bytes, as on Windows.
- Linux Git reports Linux paths. The service converts each Git-resolved directory back to the UNC identity. The worktree root, the Git directory, and the common directory must lie in the Linux file system of one distro. The identity request reports the file system type. Type `v9fs` means a Windows drive (P5: `/mnt/c` reported `v9fs`, and `/` reported `ext2/ext3`). Such a directory gives `UNSUPPORTED_REPOSITORY` with reason `mixed-location`.
- A Windows repository whose Git-resolved directories lie under a WSL prefix also gives reason `mixed-location`.
- The shell answers a WSL identity request with a fixed `/usr/bin/stat --dereference --format=%d:%i:%T` probe in the distro. It runs through the wrapper in `probe` mode. The identity is the distro GUID, the device number, and the inode number. The probe reads no file data. A failed probe refuses registration with `UNSUPPORTED_REPOSITORY`, as a failed `FileIdInfo` call does (§6). Registration reuse, the mutation exclusion, recovery markers, lingering Job tags, and trust records use this identity. This applies where §6 and §7 name `FileIdInfo`.
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
- `wsl.exe` passed each PowerShell argument literally in P3, also with spaces and `$`. The route and path rules above refuse `"` and `\` in WSL names, so no value needs other escaping.

## 12. Submodules

Submodule initialization and update are in this slice (spec FR-047 to FR-054). They form the first network operation of the slice. Research R14 holds the probes S1 to S12 and their sources. Every other rule of this contract applies unless this section states otherwise.

### Scope

- `updateSubmodules` initializes and updates every submodule recursively to the commit that its parent records. Git's own `submodule update --init --recursive` does the work.
- It never selects single submodules, never adds, removes, or syncs one, and never runs a command in each. It passes no `--remote`, `--force`, `--merge`, `--rebase`, or `--checkout`.
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
  - `for-each-ref --contains=HEAD --count=1 --format=%(refname)`.
  - `cat-file --batch-check` with the needed object IDs on stdin.
  - `ls-tree -r -z --full-tree <commit>` and `config --blob <commit>:.gitmodules --null --list`.
- A `reuse` row has no `.git` entry. For it, the same commands run with `--git-dir=<parent Git directory>/modules/<name> --work-tree=<same directory>` in place of `-C` (probes S9 and S11). `--work-tree` replaces a `core.worktree` path that can be missing before the update. None of these commands reads the worktree.
- None of these commands loads an index. Probe S3 ran each one with submodule canaries. The canaries covered `core.fsmonitor`, clean and smudge filters, every traditional hook, `core.sshCommand`, `core.askPass`, and `credential.helper`. No canary ran.
- These commands are the only exception to the §7 rule that superproject reads never start Git inside a submodule. The `updateSubmodules` preflight and reconciliation run the same commands.
- Nested submodules: the review takes the gitlinks of an initialized submodule from the tree of its target commit. This needs a local target commit. Otherwise it takes them from its HEAD tree. It recurses into each nested gitlink with a `.git` entry. Without a local target commit, the plan states that Git finds the nested submodules after its fetch.
- Kept Git directories: a recursive update reuses each kept `modules/<name>` directory of a submodule without a `.git` entry. This holds at every depth, and Git then runs the programs of that directory (probe S11). So the review recursively walks the `modules` folder below the superproject common directory and below each Git directory it reads.
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
  - `clone`: no `.git` entry, and no `<parent Git directory>/modules/<name>`. Git clones the URL and checks out the recorded commit.
  - `reuse`: no `.git` entry, but `<parent Git directory>/modules/<name>` exists. Git connects it and fetches a missing commit (probe S9).
  - `checkout`: the HEAD differs from the recorded commit, and that commit exists locally. No network step runs.
  - `fetch-checkout`: the HEAD differs, and the recorded commit is missing locally. Git fetches, then checks out.
  - `none`: the HEAD equals the recorded commit. Git still visits its nested submodules.
  - `skip`: a submodule with update mode `none`, or a submodule outside the active set. Git leaves it and its nested submodules unchanged. An uninitialized submodule with `update = none` in `.gitmodules` gets registered, but Git skips its clone (builtin/submodule--helper.c:2298, probe S5).
- Notes name each configuration write and each HEAD change:
  - "Git registers the URL in the repository settings." Git writes `submodule.<name>.url` and, when the submodule is not yet active, `submodule.<name>.active` (probe S1). It also copies an update mode from `.gitmodules` (probe S5).
  - "Git marks this submodule active." This note applies to an explicit `submodule.<name>.active=false` when `submodule.active` is unset (probe S5).
  - "Git detaches HEAD from branch <branch>." This note applies when the submodule HEAD is a branch.
  - "Git moves HEAD from <old short ID> to <new short ID>."
- Active set, from Git's `module_init` and `is_submodule_active` (research R14):
  - With `submodule.active` unset, Git initializes every gitlink. An explicit `false` becomes `true` (probe S5).
  - With `submodule.active` set, an explicit `submodule.<name>.active` wins. Otherwise the gitlink must match the `submodule.active` pathspecs. The service asks Git through `ls-files -z --stage -- <pathspecs>`, which uses Git's own matcher. Every other gitlink gets `skip`.
  - Nested levels: the plan lists existing nested submodules and computes no active set for them. Git applies the configuration of each parent.

### Refusals

`reviewSubmodules` returns each refusal, and `updateSubmodules` refuses while one holds. The code is `UNSUPPORTED_SUBMODULE` with one reason:

- `unsaved-commits`: an initialized submodule, or a kept Git directory ("Review reads"), has a HEAD that no ref of it contains. The review also cannot prove that this HEAD equals the target commit. Git detaches HEAD without a warning. Only the submodule reflog then keeps those commits, until reflog expiry (probe S4). Text: "Submodule <path> is at commit <short ID>, which no branch, tag, or other ref holds. Save it with the command, then use Refresh." The remedy is `& '<selected Git path>' -C '<submodule worktree>' branch 'arbareto-saved-<short ID>' <full ID>`. A kept Git directory uses `--git-dir='<Git directory>' --work-tree='<Git directory>'` in place of `-C`. Each value uses the §4 quoting rule. The short ID has 12 hex digits.
- `update-mode`: an existing submodule has update mode `merge`, `rebase`, or `!command`. The mode comes from the effective configuration of the parent, or else from `.gitmodules`. Text: "Submodule <path> uses the update mode <mode>. Arbareto updates only submodules that Git checks out. Use the command in a terminal." The remedy is the update command under "Remedies".
  - A `.gitmodules` value `!command` also refuses. Git itself rejects it with "invalid value" (probe S5).
  - A just-cloned submodule gets a checkout for `merge` and `rebase` (builtin/submodule--helper.c:2143-2147, probe S5). So a `clone` row never refuses for its mode. With `none`, Git skips the clone, so the row is `skip`.
  - Reason: `merge` and `rebase` can stop in an unfinished operation, which this slice blocks. `!command` runs a repository command.
- `clone-interrupted`: a `.git` entry exists, but `rev-parse --verify -q HEAD` fails in it. A killed clone leaves this state, and Git then fails with "Unable to find current revision" (probe S9). Text: "Git stopped while it cloned submodule <path>. Delete the file <path>\.git after all Git tools stop. Then use Update submodules again." The state shows the path with Copy path. Probe S9 recovered after only that file was deleted. The app never deletes it.
- `no-url`: a gitlink has no `.gitmodules` entry. Text: "The .gitmodules file has no entry for submodule <path>. Git cannot update it."
- `path`: a submodule path fails the data-model §5 path rule. Text: "Arbareto cannot pass the path of submodule <path> to Git literally."
- `gitdir-config`: the `config list` output of the superproject, or of a submodule Git directory that the review reads, enables `extensions.submodulePathConfig`. Any `submodule.<name>.gitdir` key in that output also refuses. Git can then place submodule Git directories outside `modules/<name>` (git-config(1)). The kept-directory walk cannot find them, so the program list can miss their programs. The refusal carries the path of the submodule whose configuration holds the setting. A superproject setting carries the worktree root. Text: "This repository sets custom locations for submodule Git folders. Arbareto reads only the default location. Update the submodules in a terminal." The remedy is the update command without a path.
- `limit`: the review passes a §5 submodule bound. Text: "This repository has more than 256 submodules or more than 8 nesting levels. Update them in a terminal." The remedy is the update command without a path.

A WSL distro without `setsid` never reaches the review, because registration refuses it with reason `no-setsid` (§11 "Git per distro").

Git's own refusal to overwrite local changes is no refusal here. It is a failed row ("Reconciliation and outcome").

### Trust

- Superproject: §7 "Mutation trust" applies. The superproject approval is needed only when reads need it.
- Submodule programs: the review lists each program of every submodule Git directory that the update can use. These are each initialized submodule, each `reuse` and `fetch-checkout` row, and each kept Git directory, at every depth ("Review reads"). For each submodule, it applies the §7 repository-controlled resolution rule to the `config list` output. The submodule worktree root and its Git directory act as the repository directories. A submodule Git directory lies inside the Git directory of its parent, so every local and worktree entry is repository-controlled.
- For a submodule without a `.git` entry, Git runs the programs from the worktree that it connects. That worktree is the parent worktree root plus the submodule path. Relative program paths and a relative `core.hooksPath` resolve against that path. A missing file there enters the list as `absent`. A kept Git directory without a plan row has no known path. Its relative program paths and a relative `core.hooksPath` then enter the list as `unchecked`.
- The list holds three kinds of entries:
  - Each repository-controlled integration that §7 names.
  - Each local or worktree entry outside the Git-written keys below.
  - Each file in the effective hooks directory whose name does not end in `.sample`.
- The service digests each listed program file by the §7 "Program file digests" rules and bounds. A file beyond a bound enters the list as `unchecked`.
- Git-written keys: `core.repositoryformatversion`, `core.filemode`, `core.bare`, `core.logallrefupdates`, `core.symlinks`, `core.ignorecase`, `core.precomposeunicode`, and `core.worktree`. Also `extensions.objectformat`, `extensions.refstorage`, `remote.<name>.url`, `remote.<name>.fetch`, `branch.<name>.remote`, and `branch.<name>.merge`. Also `submodule.<name>.url`, `submodule.<name>.active`, and each `submodule.<name>.update` value that does not start with `!`. A clone and a submodule initialization wrote only such keys (probes S2 and S5). None names a program. An `update` value that starts with `!` stays in the list.
- Reason: an update ran the `core.fsmonitor`, smudge filter, `post-checkout`, `post-index-change`, and `reference-transaction` hooks of a submodule (probe S3). A fetch ran its `remote.origin.uploadpack` (probe S6). An update also ran those programs in the kept Git directory of a deinitialized submodule. It ran them in the kept Git directory of its nested submodule too (probe S11).
- When the list is not empty, `updateSubmodules` sends the `trust` frame `confirmRun` after its preflight (§7 "Trust approval store"). The text is: "Update submodules runs <count> programs from submodule settings and hooks in <paths>. They can run any code on this computer." `<paths>` names at most 10 paths and then the count of the others. A kept Git directory without a plan row appears by its Git directory path. A decline ends the operation `canceled`, and no update process starts. The shell stores nothing, so the approval covers this operation only.
- The review token binds the digest of the list. A preflight that finds another list gives `STALE_REVIEW`.
- §7 "Submodule registration keys" keeps a stored superproject approval valid after the update. A submodule Git directory that an update creates enters only the list of a later review, never the stored fingerprint.

### Update protocol

1. Enter the mutation exclusion and wait for the recovery marker ID (§6).
2. Revalidate the review token with the review reads. Check the superproject HEAD, the index gitlinks, the `.gitmodules` digest, and the relevant configuration. Check each submodule HEAD and `.git` entry, each refusal, the program list digest, and trust. A changed value gives `STALE_REVIEW`, and a changed fingerprint gives `TRUST_CHANGED`. Consume the token only after validation.
3. Send `confirmRun` when the program list is not empty.
4. For each top-level plan row except `skip`, in index order, start one Git process: `--no-lazy-fetch -C <worktree root> submodule update --init --recursive --progress -- :(literal)<path>`.
   - Git handles the nested submodules of that row inside that process.
   - `:(literal)` keeps the path literal. A plain `sub[1]` pathspec matched `sub1` (probe S8).
   - `--progress` makes Git report progress on stderr without a terminal.
   - Each process starts after the previous one exits, also after a failure. Git's own update also continued after a submodule failed (probe S7). A failed clone in one process never stops the next process.
5. Honor Cancel at any time. Cancel closes the Job of the running process with every descendant, and no later process starts.
6. Reconcile after the last process, a Cancel, or a deadline.

The update process writes no superproject index. The superproject index digest stayed equal in probe S1. So the protocol takes no canonical index lock. Git takes its own `config.lock` and submodule locks.

### Environment and console

- Update processes use the §7 `network` policy. Git then never prompts on a terminal.
- The app never sets or removes a `protocol.*`, `core.sshCommand`, or `credential.*` key, and never sets `GIT_SSH_COMMAND`. Git's submodule command sets `GIT_PROTOCOL_FROM_USER=0` itself (git-submodule.sh:29-30).
- Like every Git process, each `network` process starts with `DETACHED_PROCESS`, so Git has no console (§6 "Console and input"). Git then starts `ssh` with `DETACHED_PROCESS` "to make ssh recognize that it has no console" (compat/mingw.c:2247-2263). So an SSH passphrase or unknown-host prompt fails, and its message enters the output tail. No SSH server was available for a probe, so this failure stays unverified until T224 or T237 runs one.
- A configured credential helper can show its own window, such as the Git Credential Manager sign-in. `GIT_TERMINAL_PROMPT=0` turns off only its terminal prompts (research R14).
- WSL repositories use wrapper mode `network` (§11 "Process launch"). Like every wrapper mode, it sets `GIT_TERMINAL_PROMPT=0` inside the distro and removes the controlling terminal.

### Network policy

- Git's `protocol.allow` defaults apply unchanged: `ext` is `never`, and `file` is `user` (git-config(1) `protocol.allow`).
- With `GIT_PROTOCOL_FROM_USER=0`, a `file` submodule URL fails unless configuration allows it (probe S6). An `ext::` URL failed and ran no program (probe S6).
- Tests enable local transport only through their owned global configuration: `protocol.file.allow=always`. The app never does.
- `--no-lazy-fetch` stays first. It did not block the explicit clone or fetch of a submodule. Hooks saw `GIT_NO_LAZY_FETCH=1` (probes S1 and S6).

### Progress

- The operation reports "Updating submodule <path> (<i> of <n>)". `<n>` counts the processes of step 4, and `<i>` names the running one.
- The service splits stderr into segments at CR and LF. It takes the last `NN% (a/b)` match of the newest segment as the percentage. Git prints that counter with the untranslated format `"%3u%% (%"PRIuMAX"/%"PRIuMAX")%s"` (progress.c:134). The service parses no other text, because Git translates it.
- A segment without a match keeps the last percentage. A new process starts without a percentage.
- Progress events carry only the index, the count, the row ID, and the percentage. They carry no Git text. At most 4 events per second go out (§5).
- Nested submodules report inside the progress of their top-level row.

### Deadlines and Cancel

- Inactivity deadline: an update process that writes no byte to stdout or stderr for 300 seconds ends. Git prints progress while a transfer advances, so a stalled connection stops the output. The window leaves time for a credential helper sign-in.
- Ceiling: each update process ends after 4 hours, so every Git step has a finite limit.
- A deadline closes the Job at once, with every descendant. The operation moves to `reconciling` with `DEADLINE` and reason `inactivity` or `ceiling`. No later process starts.
- Review, preflight, and reconciliation commands keep the 30-second deadline (§5).
- Cancel, the deadlines, Interrupt and close, and the lingering rules follow §6 and §8. Cancellation never undoes a finished row.
- Each update process counts its own 4 MiB toward the §5 diagnostic cap, because its stderr carries progress.

### Reconciliation and outcome

Reconciliation re-reads every plan row with the review reads, and the superproject configuration. It runs after the last process, a Cancel, a deadline, or a failure. Each row gets one state:

- `cloned`, `moved` with the old and the new commit, `unchanged`, or `failed`.
- `clone-interrupted`, with the path of the `.git` file. A killed clone left `<parent Git directory>/modules/<name>` with no refs, a `tmp_pack_*` file, the `.git` file, and the registered URL (probe S9). The service removes no file.
- `changed-elsewhere`, for a HEAD that equals neither the old nor the target commit.
- `discovered`, for a nested submodule that the review did not list, with its HEAD.

The §8 "Observed locks" set applies, with the submodule locks.

Classification (data-model §7):

- `succeeded`: every process exited 0, and every row reached its planned state.
- `completed-with-effects`: every process exited 0, but a row differs from its plan.
- `failed`: a process failed or a deadline fired, and no row changed.
- `failed-with-effects`: a process failed, or a Cancel or a deadline stopped work, and a row changed.
- `canceled`: a Cancel or a declined `confirmRun` stopped work before any row changed.
- `unknown`: a reconciliation read failed or passed its deadline. The recovery marker stays (§8).

Git refused to overwrite local changes in probe S7. That submodule kept its old HEAD and its changes, and the other rows still updated. Its row states `failed`, and the outcome is `failed-with-effects` when another row changed.

### Output tail

A failed update process carries its own `outputTail` by the §9 "Commit failure output" rules, with one change. A segment that ends with a lone CR replaces the earlier text of its line, as a terminal shows it. So progress lines collapse to their last state. CR LF still becomes LF.

### Remedies

- A failed row gets a copyable PowerShell command by the §4 quoting rule: `& '<selected Git path>' --no-lazy-fetch -C '<worktree root>' submodule update --init --recursive -- ':(literal)<path>'`.
- Its text is: "This command updates this submodule in a terminal, where Git and SSH can ask for input."
- WSL rows use the §11 "Remedy commands" form.
- A path with bytes that are not valid UTF-8 gets no command (§4).

### WSL repositories

- The same protocol runs through §11 with wrapper mode `network`. Clones and fetches run inside the distro with the distro's configuration and credentials.
- `setsid --wait` removes the controlling terminal of the update process, as it does for every WSL process (§11 "Process launch"). So a child that keeps running after Git lingers and counts, as on Windows.
- The reference distro has Git 2.43.0, which the §11 floor refuses. So no WSL update ran with Git 2.55.0, and the WSL rows stay unverified.
