# Feature Specification: Windows Desktop Qualification

**Feature Branch**: `001-desktop-qualification`

**Feature Directory**: `specs/001-desktop-qualification`

**Created**: 2026-09-28

**Status**: Draft

**Input**: User description: "Build the first installable Windows qualification slice of Arbareto, a local-first Git client."

## Clarifications

### Session 2026-09-28

The user supplied the initial decisions directly. The follow-up answer below selects standard Git commit behavior.

- Q: Which Windows target requires initial qualification? → A: Windows 11 x64 only, not an assertion about the user's current computer. Windows 10 and ARM remain unqualified.
- Q: Which Git installation, worktree operations, and configuration changes are allowed? → A: Use installed Git for Windows. Open existing linked worktrees; do not create or manage them. Do not alter global Git configuration, identity, signing, hooks, credential helpers, PATH, or agent configuration.
- Q: What must hunk staging preserve and handle? → A: Preserve working-file bytes and unrelated index contents. Handle simultaneous staged and unstaged changes, empty or unborn repositories, and binary or unsupported diffs explicitly. Never approximate unsupported staging or unstaging.
- Q: What do local-first operation and performance figures mean? → A: No cloud account is required. Performance figures in the brief are proposed targets, not measured results.
- Q: What separates local test packages from public release? → A: Label unsigned local test packages honestly. Block public release until required signing and update checks have verified passing evidence.
- Q: Should Arbareto use standard Git commit behavior instead of promising an atomic commit of the reviewed snapshot? → A: Standard Git. Use fresh checks and unchanged approved hooks. Report late changes and any created commit accurately. Preserve the draft after an unexpected result; never retry or undo that result automatically.

### Session 2026-09-29

- Q: Which product is the primary UX reference? → A: Git Extensions. Borrow its workflow and graph behavior, not its GPL-3.0 code. T3 Code remains a visual-style reference.
- Q: Which license applies, and what must the app show? → A: AGPL-3.0-or-later with the section 7 terms in NOTICE.md. The app shows the legal notices in an About window.
- Q: How does the local test package behave on Windows 10 or ARM64? → A: It runs and shows the label "Unqualified platform" in the repository menu and the About window. Qualification covers Windows 11 x64 only.
- Q: Which configured commands need trust approval before status reads? → A: Filter and monitor commands from repository-controlled keys (FR-025) need approval. Local and worktree keys are always repository-controlled. System and global commands, such as Git LFS, run without approval. This holds when the program lies outside the repository (FR-025).
- Q: What role do Git Extensions results have, and when is another shell considered? → A: A missed SC-015 comparison target is a qualification failure, like other missed budgets. Other baseline observations stay informational. A failure counts against the desktop shell only under the plan's attribution rule.
- Q: Is Narrator a qualification gate? → A: No. Screen-reader (Narrator) support and its tests move to a later feature.
- Q: How are the other decision items in checklists/qualification.md resolved? → A: They use reviewer defaults. The defaults follow Git's own behavior, add no repair or configuration action, and give each refusal a reason and a copyable remedy. Superproject reads never start Git inside a submodule.
- Q: How fast must Arbareto be, and what is the baseline? → A: Speed is a primary product goal. Git Extensions 7.2.1 under matched conditions is the baseline. SC-015 states the target: Cold launch, warm reopen, and history refresh have a median time ratio of at most 0.5. Every other compared workflow has a ratio of at most 1.0. The absolute budgets in SC-005 and SC-006 stay.
- Q: When must a commit or hunk action wait for trust approval? → A: Only when it can run repository-controlled code, such as hooks, signing programs, filters, or monitors. A changed trust fingerprint still refuses the action.
- Q: When does the source code become public? → A: At version 1, the first working release that implements most Git Extensions features except plugins. Until then the repository stays private, and packages stay local test packages. Public release stays blocked until then.

### Session 2026-09-30

- Q: Does trust approval last longer than one application session? → A: Yes. Approval persists across launches. It binds the shared repository identity, the working copy, the selected Git installation, and the trust policy. A change to any of them requires renewed approval. Exception: when the application cannot check every repository-controlled program file for later edits, approval lasts only until the application closes. The confirmation states this. Revoke trust stays in the repository menu and removes the stored approval. Approval stays explicit, and missing approval never disables hooks. The stored approval holds no configuration values or credentials.
- Q: What does Changes show when a repository opens? → A: No file is selected. Changes shows the status lists with their counts, HEAD, and the hint "Select a file to view its changes".
- Q: Does this slice offer right-click menus? → A: No. Application context menus move to a later feature. The built-in page menu loses its page actions, such as Reload, Back, Save as, Print, and Inspect. Cut, Copy, Paste, and Select all stay for editable text and selected text. Every action stays reachable by a visible control and by keyboard.
- Q: Can a process that Git or a hook starts during a mutation keep running after the mutation? → A: Yes, as with command-line Git. The mutation completes when its Git process exits and its outcome is reconciled. The outcome states how many such processes still run. They block no later read. A lock file that one holds makes the next mutation refuse with the existing lock guidance. Closing the application ends every such process, so no application-owned process remains after closure (SC-008). Closing with only such processes and no running mutation shows no prompt. Cancellation, interruption, and a deadline still end every process of that operation. A service failure still ends the processes of each running operation. Processes from completed mutations keep running until the application closes.

### Interface requirements supplied on 2026-09-28

The user requested a compact Windows Git workbench with resizable panes, two densities, and dark/light themes. Mode changes must preserve context. This request excludes UI implementation and a separate design hierarchy.

The user subsequently requested a read-only history graph, suitable component reuse, and resolution of the staging/commit design blockers.

On 2026-09-29 the user asked to re-evaluate graph components, including mermaid.js gitGraph.

## User Scenarios & Testing *(mandatory)*

All five journeys are required for qualification. Their order follows installation, inspection, preparation, commitment, and recovery.

### User Story 1 - Install and use a Windows workspace (Priority: P1)

A developer installs Arbareto and uses familiar Windows controls without installing development runtimes or creating a cloud account.

**Why this priority**: An installed application must work outside the development environment before its desktop behavior can be qualified.

**Independent Test**: Install the packaged build as a standard Windows user. Exercise its window, folder dialog, clipboard, keyboard, and text input.

**Acceptance Scenarios**:

1. **Given** a clean qualification machine with documented prerequisites. **When** I install and start Arbareto. **Then** it runs without global Node or Bun installations.
2. **Given** a missing or unsupported Git installation or WebView2 runtime. **When** installation or startup checks run. **Then** I receive accurate prerequisites and recovery instructions, not a blank or falsely usable workspace.
3. **Given** an open workspace. **When** I accept or cancel the folder dialog. **Then** focus returns predictably, and cancellation leaves the current repository unchanged.
4. **Given** the packaged application. **When** I resize, snap, or move it between supported display scales. **Then** essential controls remain reachable and readable.
5. **Given** a commit message field. **When** I paste Unicode text or use an IME. **Then** the application preserves the text and does not commit while composition remains active.
6. **Given** keyboard-only use. **When** I navigate the primary workflow and change display density. **Then** focus remains visible, controls remain reachable, and status never depends on color alone.
7. **Given** a supported window. **When** I change themes or resize panes with a pointer or keyboard. **Then** controls remain readable, reachable, and visibly focused.

---

### User Story 2 - Inspect a repository before changing it (Priority: P1)

A developer opens an existing repository or linked worktree, reviews its changes, and reads recent history before preparing a commit.

**Why this priority**: Correct repository identity and accurate changes are prerequisites for safe decisions.

**Independent Test**: Open disposable fixtures with known commits and file states. Compare the displayed status, history, and selected diff with Git.

**Acceptance Scenarios**:

1. **Given** an ordinary repository with staged, unstaged, and untracked changes. **When** I open it. **Then** I see each category, including a file with both staged and unstaged changes.
2. **Given** linked worktrees with different staged contents. **When** I open either worktree. **Then** its path, branch, and staged changes identify that worktree correctly.
3. **Given** a supported text file. **When** I select its staged or unstaged entry. **Then** the diff shows the corresponding comparison and identifies its scope.
4. **Given** more than 100 reachable commits. **When** I open history. **Then** I see only the first 100 entries and a clear first-page limit.
5. **Given** a repository without commits. **When** I inspect it. **Then** history shows an empty state, while status and supported text diffs remain usable.
6. **Given** an unsupported or oversized comparison. **When** I select it. **Then** I see its status and limitation, not a misleading empty diff or enabled hunk action.
7. **Given** an invalid, inaccessible, or removed repository path. **When** I open or refresh it. **Then** I receive an actionable failure without changes to repository data.
8. **Given** a selected comparison, draft message, and scrolled workspace. **When** I switch to History and return to Changes. **Then** valid selection, comparison scope, draft, scroll, and usable focus return.
9. **Given** repository state changes while I inspect History. **When** I return to Changes. **Then** my draft remains, but obsolete hunk selections and mutation approvals do not return.
10. **Given** linear history, merges, and commits with misleading dates. **When** I open History. **Then** graph edges match Git parents, and children appear before parents.
11. **Given** parents outside the first page or unavailable in shallow history. **When** I inspect their children. **Then** the graph identifies those boundaries rather than inventing roots or connections.
12. **Given** a selected graph row. **When** I use keyboard navigation, resize, or change density and theme. **Then** rows and graph nodes stay aligned, and equivalent parent information remains accessible without color.

---

### User Story 3 - Prepare exactly one selected hunk (Priority: P1)

A developer stages or unstages one displayed text hunk without changing working-file bytes or unrelated staged changes.

**Why this priority**: Incorrect partial staging can commit unintended content and destroy confidence in the application.

**Independent Test**: Use real disposable repositories with multiple hunks and existing staged content. Assert exact index contents and unchanged working-file bytes.

**Acceptance Scenarios**:

1. **Given** two unstaged hunks and existing staged changes in the same file, plus unrelated staged content. **When** I stage one hunk. **Then** only that hunk enters the index, and working-file bytes remain unchanged.
2. **Given** two staged hunks and additional unstaged edits in the same file. **When** I unstage one hunk. **Then** only that hunk leaves the index, and working-file bytes remain unchanged.
3. **Given** a displayed hunk whose file, index, or base revision changes externally. **When** I request staging or unstaging. **Then** the application refuses the stale selection and requires a new selection after refresh.
4. **Given** supported added, deleted, or untracked text, including an unborn repository. **When** I stage or unstage a hunk. **Then** the resulting index matches the selected change, including entry creation or removal where required.
5. **Given** Unicode paths, spaces, or CRLF text. **When** I stage or unstage a supported hunk. **Then** the intended path changes in the index, and working-file bytes remain unchanged.
6. **Given** a lock, conflict, binary or unsupported comparison, or overlapping application mutation. **When** I request a hunk action. **Then** the application refuses it without changing index contents or working-file bytes and explains the restriction. It never substitutes whole-file staging or an approximate hunk.
7. **Given** an empty repository with no file changes. **When** I open its change views. **Then** they show empty states, hunk actions remain unavailable, and repository data stays unchanged.
8. **Given** an index-change hook or unsupported index/monitor profile. **When** I request a hunk action. **Then** the app refuses it without bypassing integrations or publishing an index change.
9. **Given** a controlled independent write after final validation. **When** hunk publication and reconciliation finish. **Then** the external bytes remain intact, and observed late changes appear explicitly. The app does not undo publication automatically.

---

### User Story 4 - Commit the prepared content (Priority: P1)

A developer reviews the complete staged scope, writes a message, and creates one local commit using existing Git settings.

**Why this priority**: The qualification slice must complete a useful local workflow without bypassing repository safeguards.

**Independent Test**: Prepare disposable repositories with known index contents. Verify the resulting commit, branch, index, working files, and message after each outcome.

**Acceptance Scenarios**:

1. **Given** staged content, a valid message, and no concurrent or hook changes. **When** I commit once. **Then** one commit contains the approved staged content, and unrelated unstaged changes remain untouched.
2. **Given** staged content in an unborn repository. **When** I commit. **Then** the first commit succeeds and the workspace refreshes its branch, status, and history.
3. **Given** no staged changes or a blank message. **When** I attempt to commit. **Then** the application explains the missing requirement and creates no commit.
4. **Given** a staged snapshot or current branch that changed after review. **When** I request a commit. **Then** the application refuses the stale request and shows the refreshed scope.
5. **Given** missing identity, denied trust, a rejected hook, or a signing failure. **When** I commit. **Then** I see the failure and retain my message without silent configuration changes or safeguard bypasses.
6. **Given** a commit interrupted after Git might have changed state. **When** reconciliation completes. **Then** I see the actual result, including any identified commit, before another mutation becomes available.
7. **Given** an approved hook stages another file after review. **When** Git creates a commit. **Then** I see its actual identity and a changed-result warning. My draft remains; the app neither retries nor rewrites the commit.
8. **Given** a controlled index or checkout change after handoff. **When** Git finishes. **Then** I see the observed result or explicit uncertainty, not a claim that preflight prevented the change.

---

### User Story 5 - Stay in control while Git is busy (Priority: P1)

A developer continues using the interface, sees external changes, cancels work, and closes the application without hidden activity.

**Why this priority**: Slow operations and external tools must not cause stale writes, frozen controls, or unintended background processes.

**Independent Test**: Use deliberately slow operations and concurrent external edits in disposable fixtures. Observe input response, state recovery, cancellation, and process cleanup.

**Acceptance Scenarios**:

1. **Given** a slow history or diff read. **When** I type, navigate, resize, or request cancellation. **Then** the interface acknowledges input promptly and identifies the active operation.
2. **Given** an externally changed file, index, or branch reference. **When** the application detects the change or regains focus. **Then** it refreshes affected views and invalidates obsolete hunk selections.
3. **Given** older and newer requests for different selections. **When** the older request finishes last. **Then** its result cannot replace the current selection or repository state.
4. **Given** a running operation. **When** I cancel it or it fails. **Then** I see its outcome and refreshed Git state, without a false rollback claim or automatic retry.
5. **Given** an active mutation. **When** I request application closure. **Then** I can stay or explicitly interrupt and close, with a warning that interruption cannot guarantee rollback.
6. **Given** closure during idle, read, or mutation activity. **When** the application exits. **Then** no unintended application-owned processes remain, and unrelated Git processes remain untouched.
7. **Given** an unavailable repository during recovery. **When** the application cannot determine the result. **Then** it marks state unknown. A status-only refresh keeps mutations blocked until required recovery reconciliation succeeds.

### Edge Cases

- A selected worktree uses a `.git` file or shares history with another worktree. Its index and working files remain distinct.
- Empty repositories, detached checkouts, and filenames containing Unicode, spaces, or option-like characters retain their correct identities.
- A file can have staged changes, further unstaged changes, or a staged deletion followed by an untracked replacement.
- External writers can change files, references, or the index without a notification. Every mutation still requires a fresh validity check.
- Locks, permission failures, full disks, removed repositories, and malformed results produce failures, not optimistic success or forced lock removal.
- Merge conflicts and unfinished merge, rebase, cherry-pick, or revert operations remain inspection-only in this slice.
- Binary content, invalid text encodings, renames, type changes, and oversized diffs never receive guessed or truncated hunk mutations.
- Repository text can resemble markup, commands, or credentials. Display it as untrusted text and keep credentials out of diagnostics.
- Trusted hooks can alter repository state before failing or completing. Reconciliation reports those changes rather than asserting unchanged data.
- Repeated commit activation, cancellation near completion, and shutdown during recovery must not create duplicate commits or conceal completed work.
- Git can normalize line endings when it reads a working file. Hunks use Git's normalized content, and raw working bytes stay unchanged. With `core.safecrlf=true`, `git add` can refuse a file that hunk staging accepts, as `git add -p` does.
- Entries marked intent-to-add, assume-unchanged, or skip-worktree show their Git status but offer no hunk actions. Git hides working changes behind the last two flags, and the app shows only what Git reports.
- A `.git` file can point to a missing directory. Git then refuses the folder, and the app shows that refusal with a remedy.
- Git can refuse a repository that another user owns. The app shows Git's suggested command and never changes Git configuration.
- Windows paths can exceed 260 characters or differ only by letter case. An entry that the app cannot read, or whose file name differs in case, gets no hunk action.
- A path can contain bytes that are not valid UTF-8. Show escaped bytes, keep byte identity, and offer no hunk action.
- The superproject view shows a changed submodule commit, but not changes inside the submodule. To inspect those changes, open the submodule as its own repository.

## Requirements *(mandatory)*

### Scope Boundaries

This feature defines qualification for one installable Windows 11 x64 slice, not production readiness or complete product coverage. This target does not describe the user's current computer. Windows 10, ARM, macOS, and Linux remain unqualified.

Include existing repositories and linked worktrees, status, supported file diffs, single-hunk staging, and local commits. Include one read-only history page with an ancestry graph. Include an About window with the legal notices.

Exclude repository creation and cloning, remote authentication and operations, branch management, history rewriting, advanced rebase, and conflict resolution. Exclude an integrated terminal, provider integrations, plugin systems, AI features, and full feature parity. Also exclude history search, pagination, line-level staging, worktree creation or management, and automatic updates.

Unsupported hunk operations do not prevent inspection of available metadata. A commit can include externally staged unsupported files when their paths, types, and staged scope remain visible and valid.

Safety uses explicit validation checkpoints, not a repository-wide transaction. Refuse mismatches detected before execution or hunk publication. These checks do not freeze independent writers or approved hooks. Reconcile observed relevant state afterward without automatic undo or retry.

Index-change hooks and unqualified index or monitor profiles exclude hunk mutation in this slice. Refuse those operations rather than bypass integrations. Ordinary commit hooks remain supported through the approved standard Git behavior.

Screen-reader (Narrator) support and its tests move to a later feature. This slice keeps native semantics and visible text labels.

### Functional Requirements

#### Installation and Windows use

- **FR-001**: The package MUST install and start for a standard Windows user without globally installed Node or Bun. Ordinary local Git work MUST require no account, AI, or network connection after prerequisites are available.
- **FR-002**: Qualification MUST report actual Git and WebView2 prerequisites, supported versions, and tested versions. It MUST distinguish bundled components, preinstalled requirements, downloads, network needs, and any elevation requirement. Missing prerequisites MUST produce installation guidance or a clear blocked state.
- **FR-003**: The application MUST use an installed Git for Windows executable and expose its selected path and version. It MUST NOT bundle Git, silently substitute another executable, or alter user Git configuration, including global settings. It MUST NOT alter identity, signing, hooks, credential helpers, PATH, or agent configuration.
- **FR-004**: The application MUST support folder selection, dialog cancellation, focus restoration, clipboard use, keyboard shortcuts, resizing, snapping, and DPI transitions. Text entry MUST preserve Unicode and IME composition without accidental action activation. For editable or selected text, the built-in page menu MUST offer only Cut, Copy, Paste, and Select all. Other targets MUST show no menu.
- **FR-005**: Primary actions MUST support keyboard access, visible focus, accessible contrast, and non-color status cues. The interface MUST offer compact and comfortable density with reachable controls at documented supported window sizes. Dark and light themes MUST preserve semantic change/status roles and readable text. The interface MUST remain usable in Windows contrast themes. Theme changes MUST NOT remove focus or rely on color alone. State changes MUST NOT remove focus from a control that becomes unavailable.

#### Repository inspection

- **FR-006**: The application MUST open an existing ordinary repository or linked worktree and display its resolved path and checkout state. Shared history MUST NOT cause confusion between separate worktree indexes or working files. The application MUST open any layout for which Git reports a working tree, including submodule checkouts and separate Git directories. It MUST refuse bare repositories and Git administration folders with a reason and a remedy.
- **FR-007**: Status MUST distinguish staged, unstaged, untracked, and conflicted entries. One path MUST appear in each applicable category. Refresh MUST use actual Git state rather than assume earlier displayed data remains valid. Changes inside a submodule MUST stay outside these categories. A submodule gitlink MUST appear only when its checked-out or staged commit differs from the recorded commit.
- **FR-008**: History MUST show at most 100 commits reachable from the current checkout. Children MUST precede parents; prefer newer commits where ancestry permits. Each entry MUST identify the commit, subject, author, date, and parent relationships. The view MUST identify its checkout scope and first-page limit, and handle repositories without commits. History MUST show subjects and authors that are not valid UTF-8 with replacement characters and a visible encoding label.
- **FR-009**: File review MUST distinguish staged comparisons against the current commit from unstaged comparisons against the index. Untracked text MUST compare against an empty version. Unborn repositories MUST use an empty committed baseline.
- **FR-010**: Supported hunk review MUST cover UTF-8 text with LF or CRLF endings, including additions, modifications, deletions, and untracked files. Each compared version MUST contain at most 1 MiB, and the displayed diff MUST contain at most 20,000 lines. Line-ending policies are Git's built-in conversions from `core.autocrlf`, `core.eol`, `core.safecrlf`, and the `text`, `eol`, and `crlf` attributes. A file that Git reports with mixed line endings MUST have no hunk actions. A difference that Git normalizes away MUST have no selectable hunk.
- **FR-011**: Unsupported comparisons MUST show available path, status, type, and a specific limitation. Their hunk actions MUST remain disabled, and unsupported requests MUST be rejected without index or working-file changes. The application MUST NOT approximate unsupported hunk actions or silently substitute whole-file staging or unstaging. Unsupported cases include binary files, invalid UTF-8, oversized content, renames, type or mode changes, symlinks, submodules, and LFS-managed files. Files requiring custom content filters or encoding conversion MUST also remain outside hunk support.
- **FR-012**: Reads MUST have finite output limits documented before implementation. Incomplete or truncated results MUST be identified. Mutations MUST NOT rely on incomplete data, and limits MUST NOT appear as empty or successful complete results.

#### Selected-hunk safety

- **FR-013**: A hunk action MUST publish exactly one verified, selected, currently displayed supported hunk. It MUST preserve unrelated staged entries and MUST NOT write working-file content. Without independent writers, every working-file byte, including line endings, MUST remain unchanged. Concurrent-write fixtures MUST preserve the independent writer's resulting bytes.
- **FR-014**: Before preparation, hunk actions MUST validate repository identity, base revision, complete index, working content, attributes, configuration, and operation state. Repeat relevant checks immediately before publication. Every detected mismatch MUST refuse publication and require refresh plus reselection. Never silently relocate or reinterpret a selected hunk. These checkpoints do not freeze independent writers afterward.
- **FR-015**: The application MUST prevent overlapping mutations that affect the same shared repository. It MUST refuse detected stale state or lock conflicts without overwriting independent changes. Late changes MUST produce an explicit reconciled outcome, not an atomicity or rollback claim.
- **FR-016**: Conflicts and unfinished repository operations MUST block mutations in this slice. The application MUST explain the blocking state and allow refresh after external resolution. It MUST NOT remove another process's lock or attempt an automatic repair. For an existing index lock, the application MUST show its path and explain that another Git process or a crash left it. It MUST tell the user to remove the lock only after all Git tools stop.

#### Commit behavior

- **FR-017**: Commit approval MUST cover the complete staged scope, not merely the selected file or hunk. Require staged changes and a nonblank message. Each accepted request MUST start at most one ordinary Git commit invocation.
- **FR-018**: Immediately before handing execution to Git, revalidate the reviewed index, checkout identity, operation state, configuration, and trust. Refuse detected mismatches and require renewed review. After handoff, Git executes its normal commit behavior. Preflight does not atomically bind the eventual tree, parent, or destination against late changes. Reconciled intended success clears only the unchanged submitted draft; preserve later edits.
- **FR-019**: Commit MUST respect configured identity, hooks, and signing requirements. Missing identity, denied trust, hook rejection, and signing failure MUST produce actionable failures without bypasses or configuration changes. When the effective `i18n.commitEncoding` is not UTF-8, the application MUST refuse the commit and explain the setting. Git records that encoding and does not re-code the UTF-8 message.
- **FR-020**: After every commit outcome, inspect relevant Git state and identify created commits where evidence permits. A differing result MUST appear as completed-with-effects or failed-with-effects, not ordinary intended success. Preserve the draft after failed, changed, or uncertain results. Report uncertainty rather than inventing commit attribution. Never automatically retry, reset, amend, undo, or promise rollback.

#### Responsiveness, recovery, and trust

- **FR-021**: The interface MUST remain interactive during Git activity and show pending, completed, failed, cancellation-requested, and canceled outcomes accurately. Operations MUST offer cancellation, bound diagnostic output, and distinguish incomplete work from confirmed success.
- **FR-022**: The application MUST detect external working-file, index, and reference changes and refresh affected views. It MUST invalidate stale selections, refresh on regained focus, and provide manual refresh. Obsolete results MUST NOT overwrite a newer selection or state.
- **FR-023**: After interruption or failure, the application MUST re-read relevant Git state before enabling another mutation. It MUST report completed effects, partial effects, or unknown state without assuming cancellation reversed changes. Failed reconciliation MUST block further mutations until successful recovery reconciliation. A status-only refresh MUST NOT remove that block. After a failure of the application's background process or its window, the application MUST NOT restart either automatically. It MUST say which part stopped and offer an explicit restart action. After the background process restarts, mutations MUST stay blocked until an explicit refresh. When an operation was running at the failure, that refresh MUST state that its outcome is unknown.
- **FR-024**: Closing during a mutation MUST offer staying open or explicitly interrupting and closing. The warning MUST explain rollback limits. Shutdown MUST stop application-owned activity without terminating unrelated processes or leaving unintended descendants.
- **FR-025**: Repository content and configuration MUST remain untrusted. Displayed content MUST NOT execute commands or active markup. Repository-controlled hooks, filters, previews, and tools MUST require explicit trust approval before execution. Missing trust MUST block unsafe operations rather than bypass required hooks. Status reads MUST wait for trust approval when repository configuration defines a filter or monitor command that a status read can run. A command from any configuration scope is repository-controlled when its program or hook file lies inside the repository. Trust approval MUST persist across launches until the user revokes it. Exception: the application can be unable to check every repository-controlled program file for later edits. Approval then MUST last only until the application closes, and the confirmation MUST state this. A change of repository identity, working copy, selected Git installation, or trust policy MUST require renewed approval.
- **FR-026**: The application MUST reject requests outside the supported operation set, invalid targets, and malformed inputs before changing repository data. Paths MUST retain their literal meaning, including Unicode, spaces, and option-like names. Credentials MUST NOT appear in logs or diagnostics.
- **FR-027**: This slice MUST NOT offer discard, reset, force operations, history rewrites, or automatic conflict repair. Failures and retries MUST preserve user changes and avoid unrequested repository mutations.

#### Qualification evidence

- **FR-028**: Every mutation test MUST use real disposable repositories and disposable linked worktrees. Tests MUST NOT mutate the developer's real work repositories or global Git configuration. They MUST NOT alter the user's identity, signing, hooks, credential helpers, PATH, or agent configuration. Safety assertions MUST inspect exact index contents, working-file bytes, references, and operation state where applicable.
- **FR-029**: Initial qualification MUST use the installed package on Windows 11 x64, not browser-only or development-server results. Evidence MUST identify the build, OS, architecture, hardware, prerequisites, fixture, scenario, result, and reproduction steps. The target MUST NOT serve as evidence about the user's current computer or an untested environment. Windows 10 and ARM MUST remain unqualified. Untested cases MUST remain explicitly unverified. On Windows 10 or ARM64, the application MUST run and label the session "Unqualified platform". The label MUST appear in the repository menu beside the selected Git version and in the About window. Results from these sessions MUST NOT count as qualification evidence.
- **FR-030**: Qualification MUST measure input response, interface stalls, cold and warm timings, CPU, and complete application process-tree memory. Hardware, fixture sizes, measurement methods, and budgets MUST be fixed in the plan before testing. Runs MUST include enabled Windows Defender, a moderate development fixture, and a large-history fixture.
- **FR-031**: Shell qualification evidence MUST support retaining the selected shell or recording a blocking requirement. Failures MUST identify causes and attempted remedies. Technical comparisons and matched-condition baseline procedures MUST remain in the plan and research, not user stories.
- **FR-032**: Qualification evidence MUST remain in this feature's upstream plan and research artifacts. A shell change MUST require a blocking requirement that the selected architecture cannot reasonably satisfy. Missed budgets MUST remain failures unless an explicit product trade-off approves revised targets. Git Extensions results MUST affect qualification only through the SC-015 comparison targets. A shell change MUST also require a failure that the plan's attribution rule assigns to the desktop shell.
- **FR-033**: Unsigned local test packages MUST carry the label "Unsigned local test package" in package identification and qualification records. Local test evidence MUST NOT imply signed-package verification or public release readiness. The plan MUST identify required package-signing checks and verification of update authenticity and tampered-update rejection. Public release MUST remain blocked until all required signing and update checks have verified passing evidence.

#### Workbench context and layout

- **FR-034**: Switching between Changes and History MUST preserve valid per-mode selection, scroll context, draft text, and usable focus. Selection MUST retain its staged or unstaged scope. Mode changes MUST NOT restore stale mutation approvals. When a repository opens, no file MUST be selected. Changes MUST then show the status lists with counts, HEAD, and a hint to select a file.
- **FR-035**: Workspace panes MUST support pointer and keyboard resizing. Density, window-size, and DPI changes MUST keep essential actions reachable. These changes MUST preserve draft text and valid selection within supported window sizes.
- **FR-036**: History MUST align a read-only ancestry graph with its commit rows. Edges MUST follow Git parent identities, not inferred timestamps or branch names. Distinguish roots from parents outside the page or unavailable in shallow history. Expose equivalent parent information without requiring color or pointer use. Graph selection MUST NOT check out, move, or modify any revision or reference.

#### Legal notices

- **FR-037**: The application MUST provide an About Arbareto window that keyboard and pointer can open. It MUST show the product name, version, build identity, copyright notice, and the attribution "Arbareto by Ihor Lifanov". It MUST state that the software has no warranty and is licensed under AGPL-3.0-or-later with additional terms. It MUST state that licensees may convey the software under that license. It MUST display the full license text, the additional terms, and every bundled third-party license notice without network access. It MUST identify where to obtain the Corresponding Source for the running build. It MUST show the label "Unsigned local test package" when SC-011 applies. It MUST show the label "Unqualified platform" when FR-029 applies. Opening the window MUST NOT start a network request or a Git operation.

### Key Entities *(include if feature involves data)*

- **Repository workspace**: The selected repository, working directory, shared repository identity, checkout state, and selected Git executable.
- **Change snapshot**: The observed committed baseline, index contents, working-file contents, and freshness information for a repository view.
- **History page**: A captured checkout, bounded commit rows, actual parent identities, and explicit page or shallow-history boundaries.
- **File comparison**: A path, change category, comparison sides, supported hunks, or an explicit unsupported or incomplete result.
- **Hunk selection**: One displayed change tied to its repository and source snapshot, invalid after relevant state changes.
- **Commit request**: The message and reviewed staged snapshot whose complete contents the developer intends to commit.
- **Operation outcome**: The requested action, progress, cancellation state, diagnostic result, and reconciled effects on repository data.
- **Qualification record**: A reproducible packaged scenario, environment, measurements, result, failure cause, attempted remedy, and decision impact.

## Success Criteria *(mandatory)*

### Measurable Outcomes

These outcomes define proposed qualification targets, not measured results. Only recorded packaged tests can establish whether they pass.

- **SC-001**: On Windows 11 x64, a standard user installs and launches the package using installed Git for Windows. No global development runtime is required. Inspection, staging, unstaging, and commits work offline without a cloud account. Both ordinary-repository and linked-worktree scenarios pass. Missing-prerequisite scenarios show accurate recovery instructions.
- **SC-002**: Status, comparison scope, first-page history, and parent relationships match Git in every specified inspection fixture. History never exceeds 100 entries. Unsupported or incomplete comparisons expose no enabled hunk mutation.
- **SC-003**: Ordinary partial-staging fixtures produce the exact expected index and preserve every working-file byte. Detected stale checkpoints prevent canonical index publication. Concurrent-write fixtures preserve external bytes and report observed late changes without automatic undo. Cases cover additions, deletions, untracked text, CRLF, Unicode paths, linked worktrees, empty/unborn repositories, and simultaneous staged/unstaged changes. Unsupported requests cause no canonical index or working-file changes.
- **SC-004**: Ordinary stable commit fixtures create exactly one intended commit and preserve unrelated unstaged changes. Each accepted request starts at most one Git commit invocation. Preflight mismatches refuse handoff. Late external or hook changes produce verified changed-result or unknown outcomes, never ordinary intended success. Reconciliation precedes another mutation, and changed results preserve the draft.
- **SC-005**: During slow Git activity, at least 95% of tested interactions receive visible acknowledgement within 100 ms. No measured interval makes the interface unresponsive for more than 500 ms. Test interactions include typing, navigation, resizing, and cancellation.
- **SC-006**: On the agreed moderate fixture, the workspace becomes usable within 1.5 seconds after a cold launch. Reopening that repository in a warm application takes at most 500 ms. The plan fixes timing boundaries and run counts before measurement.
- **SC-007**: An idle, foreground workspace reflects completed external file, index, and reference changes within two seconds. Focus return or manual refresh also recovers missed notifications. Detected stale checkpoints refuse execution or hunk publication, including while a read remains pending. Later changes remain visible through reconciled outcomes.
- **SC-008**: In controlled slow-operation fixtures, cancellation reaches a reconciled or explicitly unknown state within five seconds. No unintended application-owned process remains five seconds after confirmed closure. Unrelated processes remain running in all lifecycle tests.
- **SC-009**: Every specified native interaction passes in the installed Windows build at 100%, 150%, and 200% display scaling. Tests include mixed-scale focus transitions, resizing, snapping, keyboard access, clipboard, and IME composition. They cover both densities, both themes, and one Windows contrast theme. Keyboard pane resizing retains visible focus. No essential action becomes unreachable or activates accidentally at the plan's supported window sizes.
- **SC-010**: Every required qualification scenario has a recorded pass, failure, or explicit unverified result. Evidence includes cold and warm performance, CPU, complete process-tree memory, and matched-condition baseline observations. The shell decision cites concrete results and unresolved blockers, without unsupported superiority claims.
- **SC-011**: Every unsigned local test package and its qualification record carry the label "Unsigned local test package". Public release remains blocked without verified passing evidence for required package-signing, update-authenticity, and tampered-update rejection checks.
- **SC-012**: Every mode-switch fixture restores the valid selected entry, comparison scope, draft text, scroll anchor, and usable focus. Returning after an external change never re-enables an obsolete hunk selection or mutation approval.
- **SC-013**: Every graph fixture matches Git parent relationships and distinguishes loaded nodes, page boundaries, and shallow boundaries. Keyboard selection, row alignment, and text alternatives pass in both densities and themes. Unsupported or limited graph layouts never invent ancestry or hide their limitation.
- **SC-014**: In the installed package, keyboard-only use opens About Arbareto offline. It reaches the copyright, no-warranty statement, conveyance permission, license, additional terms, source location, and every bundled third-party notice. The notice inventory matches the licenses of every dependency the package ships. Text stays readable and reachable in both themes, both densities, one Windows contrast theme, and at 200% scaling.
- **SC-015**: On the agreed moderate fixture and its large-diff copy, Arbareto meets the target below against Git Extensions 7.2.1. Cold launch, warm reopen, and history refresh have a median time ratio of at most 0.5. Every other compared workflow has a ratio of at most 1.0. The ratio is the Arbareto median time divided by the Git Extensions median time. Compared workflows are cold launch, warm reopen, history refresh, external-change display, large-diff display, single-hunk staging, and local commit. Both applications use the same computer, Git executable, repository copies, and cache state. These figures are targets to measure, not claims. Only recorded packaged runs of both applications establish a result. A workflow that Git Extensions cannot run stays unverified. A missed target stays a recorded failure unless an explicit product trade-off approves a revised target.

## Assumptions

- Initial qualification targets Windows 11 x64 under a standard user account with Windows Defender enabled. Windows 10, ARM, macOS, and Linux require separate scope and qualification before support claims.
- The architecture selected in the constitution remains the candidate. This specification does not request another shell implementation or comparative prototype.
- Users supply an existing repository and installed Git for Windows. The application opens existing linked worktrees but does not create or manage them. The plan defines supported Git and WebView2 versions and installation behavior before packaged testing.
- The first history page graphs commits reachable from the captured current checkout, not every branch in the repository. Historical file inspection, branch filtering, search, and additional pages remain deferred.
- Hunk support uses the explicit text limits in FR-010. Ordinary Git line-ending normalization remains valid, but working-file bytes must never change through staging or unstaging.
- Unsupported entries can remain visible and already staged content can still be committed. Conflicts and unfinished operations remain mutation blockers regardless of file type.
- The plan selects disposable moderate and large-history fixtures, exact hardware, minimum window sizes, and repeatable timing conditions before implementation. Performance comparisons use Git Extensions under matching conditions.
- Performance figures in the brief and numerical success criteria are proposed qualification targets, not measured results. Qualification records misses instead of silently relaxing targets.
- Automatic updates remain outside this feature. Unsigned packages are for local testing only and require explicit labeling. Required signing, update-authenticity, and tampered-update rejection checks remain public release gates.
- This specification step creates planning artifacts only. It does not scaffold the application, execute mutation tests, or claim any Windows behavior has passed.
