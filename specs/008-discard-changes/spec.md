# Feature Specification: Discard (Revert) Changes

**Feature Branch**: `008-discard-changes`

**Feature Directory**: `specs/008-discard-changes`

**Created**: 2026-10-27

**Status**: Draft

**Input**: User description (2026-10-27): "Discard (revert) changes" as feature 008. Revert selected lines or a hunk (key R in the diff), Revert file (key R in the file list, also for several selected files), and Revert all unstaged changes. Cover unstaged and staged changes, as Git Extensions does. Untracked files go only through the 005 Delete flow. Always ask, with Cancel as the first focus. Ship before the first public package, v0.1.0. Inputs: the user decisions of 2026-10-27 and the investigator facts report of 2026-10-27 (local scratch).

## Clarifications

### Session 2026-10-27

The user gave these decisions on 2026-10-27.

- Q: Which changes can the user revert? → A: Unstaged and staged changes, as in Git Extensions. Revert file also unstages the file. Staged lines revert in the index and in the working file together (FR-016, FR-019).
- Q: Does Arbareto keep a backup of the reverted content? → A: No. The confirmation is the only safeguard, and it states "You cannot undo this." (FR-008).
- Q: When does Arbareto ask? → A: Always. Cancel has the first focus. Enter alone never reverts (FR-008).
- Q: Which actions ship? → A: Revert selected lines or the selected hunk (R in the diff), Revert file (R in the file lists, also for several selected files), and Revert all unstaged changes. Untracked files go only through the 005 Delete flow (FR-012, FR-018, FR-026).
- Q: When does the feature ship? → A: Before the first public package, v0.1.0. This feature takes the number 008. The Linux feature moves to 009.

The clarify pass of 2026-10-27 resolved these points. The sources are the facts report, Git's source and documentation, the constitution, and the earlier specs.

- Q: Does Arbareto let Git write the working file? → A: No. Git's apply and checkout remove the file and then create it. A failure between the two steps leaves no file. Hard links and the read-only attribute are lost (facts report). Arbareto replaces the file itself in one atomic step (FR-031 to FR-036). The design change below lets Git write only its own temporary file.
- Q: Which version does Revert file restore? → A: The HEAD version, in the index and in the working file. Revert all unstaged changes restores the index version and keeps the index (FR-019, FR-028).
- Q: On which comparison does R in the diff act? → A: On the shown comparison. In the unstaged diff, it changes only the working file. In the staged diff, it changes the index and the working file (FR-014, FR-016).
- Q: Does a revert run during a merge, a rebase, or with conflicts? → A: No. Feature 001 FR-016 blocks mutations then, as it blocks Delete (FR-002).
- Q: Does a revert need trust approval? → A: No. It runs no repository program. A file with a filter driver or Git LFS refuses, because Git's working-tree conversion would run that driver. Git LFS can also download objects, which 001 FR-025 forbids (FR-004, FR-038).
- Q: Does a binary file revert? → A: Revert file, yes. Git's own working-tree conversion gives the exact bytes. Lines and hunks of a binary file, no (FR-024, FR-038).
- Q: Where do the actions show? → A: Only in the Commit view: the Changes list, the Staged list, and the diff. History offers no revert. Git's commit revert is a later feature (FR-006).
- Q: Which dialog asks? → A: The in-app modal of the 005 Delete confirmation, with no default button (FR-008).
- Q: What does Revert all unstaged changes do with a submodule entry? → A: It leaves the entry unchanged, as Git's own `git restore .` does without `--recurse-submodules`. The confirmation counts these entries (FR-027).
- Q: What happens when the index part succeeds and the working-file part stops? → A: The index part stays. The result names the exact state. Arbareto does not undo the index part (FR-017, FR-039).
- Q: What does the review hold for a file revert? → A: The source index entry and the facts of the current target, not the bytes. A long review shows "Checking <n> files…" with Cancel (FR-007, SC-007). The design change below defines the bytes.
- Q: What does R do on a folder row? → A: Nothing. It shows "Arbareto does not revert a folder. Select its files." Revert folder is out of scope (FR-023).
- Q: Do logs hold reverted content? → A: No. Logs and diagnostics hold no file content and no diff text (constitution V, FR-049).
- Q: How do paths show in the modal? → A: As untrusted plain text, under the 001 path display rules (FR-010).

The user answered four more questions on 2026-10-27. Each answer is the recommended option.

- Q: What does Revert file do with a staged new file that HEAD does not have? → A: It removes the index entry and keeps the working file, which then shows as untracked. It loses no content. It matches the Git Extensions default, where the box "Also delete new files" starts clear. Untracked files go only through Delete (FR-021). The rejected options were a delete through the Recycle Bin and a refusal.
- Q: What does Revert all unstaged changes do when a listed entry has a refusal, such as a symbolic link? → A: The whole action is unavailable. Its reason names the blocking files and their reasons. This matches the all-or-nothing rule of 004 FR-038 for multi-file actions (FR-029). The rejected option reverted the other files and listed the skipped files.
- Q: Can the user revert staged lines when the same file also has unstaged changes? → A: No. The action is unavailable with "This file also has unstaged changes. Revert or stage them first." Git's `apply --index`, which Git Extensions uses, refuses the same case (FR-016). The rejected option located the lines through an exact line map of the hunk headers.
- Q: Does a revert run the `post-checkout` hook? → A: No, as in Git Extensions (FR-004). A revert runs no Git command that runs a hook, so no hook is skipped. It writes the working file itself and changes the index through `update-index`, which runs only `post-index-change`, and that hook refuses the staged part (FR-038). Git's own `git restore <path>` and `git checkout -- <path>` do run `post-checkout` with the flag 0 (Git `builtin/checkout.c` `checkout_paths`). Arbareto runs neither command. Constitution I forbids a bypass of the hooks of an operation that Git runs. A revert is not such an operation, so it does not break the principle. The rejected options ran `post-checkout` behind trust approval, or refused when a `post-checkout` hook exists.

The user answered the plan on 2026-10-27 and asked for one design change.

- Q: Where does the hook reading go? → A: Only into this spec (the hook answer above) and the plan's constitution check. The constitution gets no patch.
- Q: What happens to the DACL of a file? → A: When the batch 0 probe shows that the swap loses the file's own DACL, the write copies it to the new file (FR-035). A missing `windows` crate feature goes through the dependency review first.
- Q: Does Revert file keep the 8 MiB limit? → A: No. Git Extensions has no size limit, because Git writes the file. Git's `checkout-index --temp` writes the working-tree form of the index entry to its own temporary file in the worktree root. The shell checks that file, copies it beside the target, and swaps it over the target with the same atomic rename and expected checks (FR-019, FR-025, FR-028, FR-031). The batch 0 probe G9 shows Git's own restore bytes in every fixture on Windows and in WSL (plan research R15). Lines and hunks keep the in-memory path. Their bytes cross in one frame. The 001 comparison bounds of 1 MiB per version keep that frame at 2,117,152 bytes or less (plan research R11, review of 2026-10-30).

## User Scenarios & Testing *(mandatory)*

Feature 001 stages and unstages files and hunks. Feature 004 adds line staging, multi-select, and the Commit view. Feature 005 adds Delete for untracked and changed files. No feature can discard a change today: 001 FR-027 and the 004 Scope Boundaries exclude it. The user must leave Arbareto, or edit the file by hand. Git Extensions is the reference: it offers Reset selected lines, Reset file (key R), and Reset unstaged changes.

### User Story 1 - Revert lines or a hunk in the working file (Priority: P1)

A developer selects changed lines in the unstaged diff, or selects a hunk, and presses R. A confirmation states what goes. After Revert, the working file loses exactly those changes. The index does not change.

**Why this priority**: The removal of a debug line or an experiment is a daily task. Git Extensions offers Reset selected lines. Today the user must edit the file by hand.

**Independent Test**: Revert lines and hunks in disposable fixtures. The fixtures have added, removed, and mixed hunks, LF and CRLF files, a CRLF file that Git stores with LF, and Unicode paths. Compare the working-file bytes with Git's own reverse apply of the same partial patch on a copy. Check that the index and every other working-file byte stay unchanged. Change the file between the review and the run, and check that nothing changes.

**Acceptance Scenarios**:

1. **Given** the unstaged diff of login.ts with 3 selected changed lines, and the diff has focus. **When** I press R. **Then** the modal "Revert 3 lines in login.ts?" opens, and Cancel has the focus. The modal states "Arbareto removes the selected changes from the working file. The index does not change. You cannot undo this."
2. **Given** that modal. **When** I press Enter or Escape. **Then** the modal closes, and nothing changes.
3. **Given** that modal. **When** I select "Revert lines". **Then** the working file loses exactly the 3 changes, and the diff refreshes. The status bar states "Arbareto reverted 3 lines in login.ts."
4. **Given** a selected hunk and no line selection. **When** I press R. **Then** the modal "Revert this hunk in login.ts?" opens with the button "Revert hunk".
5. **Given** an open modal. **When** another program changes login.ts before I confirm. **Then** the run changes nothing. It states "login.ts changed after the review. Arbareto changed nothing. Check the changes, then select the lines again."
6. **Given** a selection with only context lines, or with lines of two hunks. **When** I press R. **Then** no modal opens, and the reason shows.
7. **Given** a CRLF working file that Git stores with LF. **When** I revert a removed line. **Then** the restored line ends with CRLF, and every other byte stays.
8. **Given** the diff of a binary, renamed, or untracked file. **When** I press R. **Then** no modal opens, and the reason shows, such as "Arbareto does not revert an untracked file. Use Delete."
9. **Given** a hunk. **When** I open its "More actions" menu. **Then** a separate group holds "Revert hunk…" with the key R.

---

### User Story 2 - Revert files (Priority: P1)

A developer selects one or more files in the Changes list or the Staged list and presses R. A confirmation lists the files. After Revert, each file equals its HEAD version, in the index and in the working file.

**Why this priority**: The revert of a whole file is the most frequent discard. Git Extensions offers Reset file with the key R.

**Independent Test**: In fixtures with modified, deleted, staged, partly staged, binary, CRLF, and working-tree-encoding files, revert one file and several files. Compare the index and the working files with Git's own `git restore --staged --worktree --source=HEAD` on a copy. Check that no other file and no other index entry changes.

**Acceptance Scenarios**:

1. **Given** 2 marked files with unstaged changes, and the Changes list has focus. **When** I press R. **Then** the modal "Revert 2 files?" lists both files, Cancel has the focus, and "Revert files" reverts them.
2. **Given** a file with staged and unstaged changes. **When** I revert it. **Then** its index entry and its working file equal HEAD, and the file leaves both lists.
3. **Given** a file in the Staged list, and the Staged list has focus. **When** I press R. **Then** the same modal opens, and Revert returns the file to its HEAD version.
4. **Given** a file with an unstaged deletion. **When** I revert it. **Then** the file exists again with the bytes of Git's own restore.
5. **Given** a binary file or a file with a `working-tree-encoding` attribute. **When** I revert it. **Then** its bytes equal the bytes of Git's own restore on a copy.
6. **Given** a selection that holds an untracked file. **When** I press R. **Then** no modal opens, and the reason states "Arbareto does not revert an untracked file. Use Delete."
7. **Given** a staged new file that HEAD does not have. **When** the modal opens. **Then** it states "The last commit does not have 1 of these files. Arbareto unstages it and keeps the file. Git then shows it as untracked." (Clarifications, 2026-10-27).
8. **Given** a file that another program holds open without write sharing. **When** the run reaches it. **Then** the file stays unchanged. The result states "Another program has login.ts open. Arbareto did not change it. Close the file, then try again."
9. **Given** a row with a refusal, such as a submodule. **When** I open its row menu. **Then** "Revert file…" is unavailable with the reason, such as the 001 text "This entry is a submodule or a nested repository." (FR-038).

---

### User Story 3 - Revert all unstaged changes (Priority: P2)

A developer selects "Revert all unstaged changes…" in the menu of the Changes header. A confirmation counts the files. After Revert, every listed tracked file equals its index version. Staged changes and untracked files stay.

**Why this priority**: After an experiment, a developer wants a clean working tree and keeps the staged work. Git Extensions offers Reset unstaged changes. It touches many files, so it comes after the per-file actions.

**Independent Test**: In fixtures with modified, deleted, partly staged, submodule, and untracked entries, run the action. Compare every working file with Git's own `git restore .` on a copy. Check that the index, the untracked files, and the submodule working trees stay unchanged.

**Acceptance Scenarios**:

1. **Given** 5 files with unstaged changes and 3 untracked files. **When** I select "Revert all unstaged changes…". **Then** the modal "Revert all unstaged changes?" lists the 5 files. It states "Arbareto sets 5 files to their version in the index. Staged changes stay. Untracked files stay. You cannot undo this."
2. **Given** that modal. **When** I select "Revert unstaged changes". **Then** the 5 files equal their index versions, the 3 untracked files stay, and the index does not change.
3. **Given** a partly staged file. **When** the action runs. **Then** its staged changes stay, and its working file equals its index version.
4. **Given** a submodule with a changed commit. **When** the modal opens. **Then** it states "Submodule changes stay. Arbareto does not change 1 submodule."
5. **Given** a Filter files text that hides 2 of the 5 files. **When** the modal opens. **Then** it counts all 5 files and states "This covers 2 files that Filter files hides."
6. **Given** a listed entry with a refusal, such as a symbolic link. **When** I open the Changes header menu. **Then** the item is unavailable. Its reason names the file and the reason (Clarifications, 2026-10-27).
7. **Given** a running action. **When** I select Cancel. **Then** the action stops before the next file. The result names the outcome of each file.

---

### User Story 4 - Revert staged lines (Priority: P2)

A developer selects lines in the staged diff, or selects a staged hunk, and presses R. After Revert, the changes are gone from the index and from the working file.

**Why this priority**: The user decided that staged lines revert directly. It needs the line rules of User Story 1 and the index rules of line unstaging. So it comes after User Story 1.

**Independent Test**: In fixtures with staged added, removed, and mixed hunks, revert staged lines and hunks. Compare the index with Git's own `apply --cached --reverse` of the same partial patch on a copy. Compare the working file with the expected bytes. Check that the other index entries and the other working files stay unchanged.

**Acceptance Scenarios**:

1. **Given** the staged diff of login.ts with 2 selected lines, and login.ts has no unstaged change. **When** I press R. **Then** the modal "Revert 2 staged lines in login.ts?" states "Arbareto removes the selected changes from the index and from the working file. You cannot undo this."
2. **Given** that modal. **When** I select "Revert lines". **Then** the index entry and the working file both lose exactly the 2 changes.
3. **Given** login.ts also has unstaged changes. **When** I press R in its staged diff. **Then** no modal opens. The reason states "This file also has unstaged changes. Revert or stage them first." (Clarifications, 2026-10-27).
4. **Given** the index part succeeds, and another program then changes login.ts. **When** the run ends. **Then** the working file keeps the other program's bytes. The result states "Arbareto removed the changes from the index. It did not change login.ts, because the file changed after the review."

---

### User Story 5 - Revert in a WSL repository (Priority: P2)

A developer uses the same actions in a WSL repository. The write runs inside the distro. Each file keeps its mode bits.

**Why this priority**: Feature 001 FR-039 to FR-046 promise WSL parity. A WSL file has POSIX mode bits and an owner, which a new file does not keep by itself.

**Independent Test**: On Ubuntu-26.04, run the fixtures of User Stories 1 to 4 in an owned distro folder. Compare each result with Git's own commands on a copy in the same distro. Check the mode bits, the owner, and the link count of each written file.

**Acceptance Scenarios**:

1. **Given** a WSL file with the mode 0755 and unstaged changes. **When** I revert it. **Then** its bytes equal Git's own restore on a copy, and its mode stays 0755.
2. **Given** a WSL file that another distro user owns. **When** I open its row menu. **Then** "Revert file…" is unavailable with "Another user owns login.ts. Arbareto does not change it."
3. **Given** a WSL repository with `core.sharedRepository` set. **When** I select staged lines. **Then** Revert is unavailable with the 001 shared-repository reason. The revert of unstaged lines stays available.

---

### Edge Cases

- The user presses R and holds it. The key repeat opens at most one modal, and no repeat confirms it.
- The user presses R during an IME composition. Nothing happens.
- The confirmation stays open for more than 60 seconds. The review expires, and the run changes nothing (FR-011).
- The user presses R in the History commit diff. Nothing happens, because History offers no revert (FR-006).
- The selected lines include the Git marker "No newline at end of file" on either side. Only the whole hunk can revert, as for line staging (004 FR-044).
- The selected hunk belongs to an unstaged deletion or a staged deletion. Lines and hunks are unavailable with "Arbareto does not revert lines or hunks of a deleted file. Use Revert file."
- The selected lines belong to a staged new file. Lines and hunks are unavailable with "Arbareto does not revert lines or hunks of a staged new file. Use Revert file."
- The diff is limited by the 001 bounds, such as a version or the working file above 1 MiB, or 20,000 lines. Lines and hunks are unavailable with the size reason. Revert file stays available up to its own bound (FR-025).
- A restored line would need a line ending that Git's check-in conversion does not give back exactly. The action refuses with `line-endings` (FR-015).
- The file has the `ident` attribute. Lines and hunks are unavailable. Revert file works, because Git's own conversion gives the bytes.
- A `.gitattributes` file has a change that gives the path other attribute values in the working files than in the index. Every revert of that path refuses with `attributes`, because Git's own checkout and Git's working-tree conversion can then read different values. A change that gives equal values does not refuse. This also covers the `.gitattributes` file itself.
- A staged deletion meets an untracked file at the same path. Revert file refuses with "A file that Git does not track exists at <path>. Delete it first, or keep the deletion."
- The branch is unborn. HEAD has no file, so Revert file follows the new-file rule for every file (Clarifications, 2026-10-27). Revert all unstaged changes and the unstaged line revert work as usual.
- The working file is read-only, has more than one hard link, or is a link or a junction. The review refuses with its reason (FR-034).
- A folder on the path becomes a link or a junction after the review. The write changes nothing outside the reviewed path and reports the file as changed.
- Windows Defender or another program holds the file during the rename. The write fails with the OS status, and the file keeps its old bytes. Arbareto does not retry by itself. The batch 0 probe W9 saw 0 to 2 access-denied renames in 1,000 with Windows Defender on. Such a file gets the outcome failed with `access-denied`, nothing changed, and the FR-041 access-denied text. This outcome is valid, not a defect.
- The disk is full during the write of the temporary file. The target keeps its old bytes, and no temporary file stays.
- Revert file of a very large file needs free space for three copies for a short time: the target, Git's temporary file, and the copy beside the target. A full disk fails with its FR-041 text, and the target keeps its bytes.
- The application ends during a write. The target holds its old bytes or its new bytes, never a part, and never no file.
- The index lock exists at the review or at the start of the run. Every revert refuses with the 001 FR-016 lock guidance, also one without an index part, because another Git process can then write working files. A lock that appears later stops the index part, and no working file changes. During the working part, the exact expected check of each write protects the files.
- Another Git process changes the index after the review. The staged part refuses as stale. The unstaged revert also refuses, because the index entry binds the shown comparison.
- A multi-file revert holds more files than the 004 multi-file limit (10,000). The action is unavailable with the limit, and no file changes.
- Cancel arrives during a multi-file run. The current file ends its atomic write or does not start it. The fresh read decides each outcome. Cancel is not reported as an undo.
- A deleted file that Revert file restores lies in a folder that no longer exists. The run creates the missing folders, as Git's own restore does. A folder that the run created stays after a later stop, and the result names it.
- The working file is a folder now. The review refuses with the `type` reason.
- The path differs from the file name on disk only in letter case. The review refuses with the `path` reason.
- WSL: another program writes the file inside the distro between the check and the rename. The rename replaces that write. This is a known limit, because Linux offers no mandatory lock (FR-043).

## Requirements *(mandatory)*

### Scope Boundaries

Include Revert selected lines and Revert hunk in the unstaged diff and in the staged diff. Include Revert file for one or several rows of the Changes list and of the Staged list. Include Revert all unstaged changes. Include their reviews, confirmations, refusals, results, keys, menus, and WSL parity.

Exclude the revert of untracked files: the 005 Delete flow covers them. Exclude a backup, an undo, and a Recycle Bin copy of reverted content. Exclude Revert folder and Revert all changes, which would be Git's `reset --hard`. Exclude a revert to another revision (005 excludes "Reset file to a revision"). Exclude Git's commit revert, branch reset, and stash. Exclude the revert of submodules, symbolic links, renames, mode changes, type changes, and conflicted files. Exclude files with a filter driver or Git LFS. Exclude any revert action in History. Exclude Bitbucket and Jira integration and the Linux qualification (feature 009).

The no-heuristics rule applies to every requirement. Every decision comes from exact parses of machine-readable Git output, from Git exit codes that the Git documentation defines for that command, from OS facts, or from contract-defined values. Git message text, timing, retry counts, and name patterns never decide an outcome.

### Dependencies

- Feature 001 provides the comparisons and their support rules (FR-009 to FR-014), and the staging checkpoints. It also provides the read gate, the operation registry with Cancel, the outcome reconciliation (FR-023), and the WSL rules (FR-039 to FR-046).
- Feature 004 provides the Commit view, the Changes and Staged lists, multi-select, Filter files, and the line selection. It also provides the house action menu and the review and run steps of workbench actions.
- Feature 005 provides the row menu with its "Delete from disk" group (FR-023) and the Delete flow for untracked files. It also provides the tree order of confirmation lists (FR-015) and the atomic file replace of the ignore editor (FR-042).
- The first public package, v0.1.0, waits for this feature (user decision, 2026-10-27).

### Changes to earlier requirements

This feature changes these requirements for builds that include it. The earlier texts stay unchanged in their own files until the plan updates them.

- **001 FR-027** (`specs/001-desktop-qualification/spec.md:424`): "This slice MUST NOT offer discard, reset, force operations, history rewrites, or automatic conflict repair." Revert lines, Revert hunk, Revert file, and Revert all unstaged changes are allowed behind their confirmations (FR-007 to FR-011). Reset, force operations other than 003, and history rewrites stay excluded.
- **001 FR-013** (`specs/001-desktop-qualification/spec.md:404`), **001 FR-038** (`:447`), and **004 FR-042** (`specs/004-workbench-ux/spec.md:403`): "MUST NOT write working-file content." The rule stays for Stage and Unstage. The revert actions of this feature write working files under FR-031 to FR-037. The text needs no change.
- **001 contract §11** (`specs/001-desktop-qualification/contracts/operations.md:1608`): "No working-file content crosses, except for the ignore editor." The bytes of one reverted file also cross out of and into the distro, within the plan bound (FR-043).
- **004 Scope Boundaries** (`specs/004-workbench-ux/spec.md:303`): "Exclude … discard of single files, hunks, or lines". The exclusion goes. Reset stays excluded.
- **004 Changes to earlier requirements, 001 FR-027** (`specs/004-workbench-ux/spec.md:322`): "Reset, force push other than 003, and other history rewrites stay excluded. Amended by feature 005 …". The list of allowed actions also holds the revert actions of this feature.
- **004 Assumptions** (`specs/004-workbench-ux/spec.md:526`): "Discard of single files, hunks, or lines stays out of scope, although Git Extensions offers Reset selected lines. This is a reviewer default." The assumption goes.
- **004 Research inputs** (`specs/004-workbench-ux/spec.md:548`): "Reset selected lines asks for an explicit Yes." The Git Extensions fact stays. Arbareto differs on purpose: Cancel has the first focus, and no button is the default (FR-008).
- **005 FR-023** (`specs/005-inspection-file-actions/spec.md:330`): "The row menu MUST show a separate labelled group with "Delete…" (Del) and "Delete permanently…" (Shift+Del)." A separate group directly above it holds "Revert file…" (R) (FR-018).
- **005 FR-020** (`specs/005-inspection-file-actions/spec.md:327`): "Staged-list rows MUST NOT offer Delete." The rule stays. Staged-list rows get their own destructive group with "Revert file…" (FR-018).
- These texts stay unchanged: 003 `spec.md:226` (reset and revert of branches stay excluded), 005 `spec.md:266` ("Reset file to a revision" stays excluded), and the project brief `docs/project-brief.md:49` (reset variants stay in the power-user release).
- The project brief `docs/project-brief.md:101` names the label "Discard changes". The user named the actions "Revert" on 2026-10-27. The plan decides whether the brief changes.

### Functional Requirements

#### Common rules

- **FR-001**: Every outcome MUST come from a documented Git exit code, Git's machine-readable output, an OS fact, or a fresh read. The Git documentation MUST define that exit code for that command. The application MUST NOT classify any result by Git's message text.
- **FR-002**: Each revert action MUST count as a mutation for 001 FR-015, FR-016, FR-023, and FR-024. While one runs, another mutation of the same repository MUST be refused as busy. During a merge, a rebase, another unfinished operation, or with conflicts, every revert action MUST be unavailable with the 001 FR-016 reason.
- **FR-003**: Every path MUST pass to Git as a literal value after an end-of-options marker where Git supports one.
- **FR-004**: A revert MUST run no repository program: no hook, no filter driver, no textconv driver, no external diff, and no `core.fsmonitor` command. It MUST NOT need trust approval. Reads that load the index MUST wait behind the 001 read gate. The `post-checkout` hook does not run (Clarifications, 2026-10-27).
- **FR-005**: A revert MUST NOT download objects (001 FR-025). A missing object MUST refuse the action before any change, with the 001 missing-object remedy.
- **FR-006**: Only the Commit view MUST offer revert actions: the Changes list, the Staged list, and the diff. History, the History commit diff, and the commit details MUST NOT offer one.

#### Review and confirmation

- **FR-007**: Each action MUST have a review step and a run step. The review MUST bind every fact that the action uses. These facts are HEAD, the index entry of each path with its mode and object ID, and the shown comparison. They also cover the working file (type, size, SHA-256, identity, and link count), the attributes and configuration of 001 FR-014, and the operation state. The review MUST fix the exact result of each write and each index entry that it publishes. For lines and hunks, it MUST compute the new bytes. For a file, it MUST fix the source index entry (mode and object ID) and the facts of the current target. The run MUST write only the bytes that Git's `checkout-index --temp` wrote for that entry, checked by their size and SHA-256. The review MUST end before the confirmation opens. While it runs, the status bar MUST show "Checking <n> files…" with Cancel. A refused review MUST show its reason, and no confirmation opens.
- **FR-008**: Each action MUST ask in an in-app modal confirmation, every time. Cancel MUST have the first focus. The modal MUST have no default button and no access key for its revert button. Enter with Cancel focused, Escape, and a close MUST cancel. Only an activation of the revert button MUST revert: a click, or Enter or Space while it has focus. The R key and its repeat MUST NOT confirm. Every modal MUST state "You cannot undo this."
- **FR-009**: The modal texts MUST be:
  - Unstaged lines: title "Revert <n> lines in <file>?", text "Arbareto removes the selected changes from the working file. The index does not change.", button "Revert lines".
  - Unstaged hunk: title "Revert this hunk in <file>?", the same text, button "Revert hunk".
  - Staged lines: title "Revert <n> staged lines in <file>?", text "Arbareto removes the selected changes from the index and from the working file.", button "Revert lines".
  - Staged hunk: title "Revert this staged hunk in <file>?", the staged text, button "Revert hunk".
  - Files: title "Revert <n> files?", text "Arbareto sets each file to its version in the last commit, in the index and in the working file. Their staged and unstaged changes are lost.", button "Revert files".
  - Files with staged new files: the added line "The last commit does not have <k> of these files. Arbareto unstages them and keeps the files. Git then shows them as untracked." (Clarifications, 2026-10-27).
  - All unstaged: title "Revert all unstaged changes?", text "Arbareto sets <n> files to their version in the index. Staged changes stay. Untracked files stay.", button "Revert unstaged changes".
  - All unstaged with submodule entries: the added line "Submodule changes stay. Arbareto does not change <k> submodules."
  - All unstaged with hidden rows: the added line "This covers <h> files that Filter files hides."
  - With <n>, <k>, or <h> equal to 1, the texts MUST use the singular: "1 line", "1 file", "1 submodule", "the file", "it", and the buttons "Revert line" and "Revert file".
- **FR-010**: A file confirmation and the confirmation of Revert all unstaged changes MUST list the first 20 paths in the 005 tree order (005 FR-015). It MUST state "and <m> more files." for the rest, and "and 1 more file." for one. Each path MUST show as untrusted plain text, under the 001 path display rules.
- **FR-011**: The run MUST use its review once. It MUST check the bound facts again immediately before the index publication and immediately before each working-file write. A difference MUST stop that part before it starts. The result MUST name the changed fact. A review MUST expire after the workbench review lifetime of the contract (60 s). An expired review MUST change nothing and state "The review expired. Arbareto changed nothing. Select Revert again."

#### Revert lines and hunk

- **FR-012**: With the diff focused, R MUST open the review of the selected lines. Without a line selection, R MUST open the review of the selected hunk. Without either, R MUST change nothing and show "No hunk is selected." Each hunk MUST offer a "More actions" menu beside its Stage hunk or Unstage hunk button. That menu MUST hold a separate destructive group with "Revert hunk…" (R). With a line selection in that hunk, the group MUST also hold "Revert <n> lines…" (R).
- **FR-013**: The line selection MUST follow 004 FR-043 and FR-044. Lines MUST be unavailable for a selection with only context lines and for lines of two hunks. Lines and hunks MUST be unavailable for every comparison that 001 FR-011 marks as unsupported. Lines and hunks MUST be unavailable for a deleted file, a staged new file, and an untracked file. A part of a hunk with Git's "No newline at end of file" marker MUST be unavailable, and the whole hunk stays available.
- **FR-014**: An unstaged revert MUST change only the working file. The new bytes MUST equal the working bytes with exactly the selected changes reversed. A selected added line MUST go. A selected removed line MUST come back at its place. Every unselected line MUST stay. The index MUST NOT change.
- **FR-015**: Before the write, the review MUST prove two facts. First, every byte outside the reverted lines keeps its exact value. Second, Git's check-in conversion of the new bytes for that path gives exactly the expected content. The expected content is the working side of the shown comparison with the selected changes reversed. A restored line MUST end with the line ending that Git reports for the working file (`lf` or `crlf` in `ls-files --eol`). For every other report, and for a line without a line ending, it MUST keep its comparison bytes. The second proof then decides whether these bytes are right. Without both proofs, the review MUST refuse with `line-endings`.
- **FR-016**: A staged revert MUST change the index entry and the working file. The new index entry MUST equal the index content with exactly the selected changes reversed, as Unstage lines computes it (004 FR-041). It MUST pass the 001 FR-013 and FR-014 checks before publication. The working file MUST lose the same changes under the FR-015 proof. A staged revert MUST be unavailable when the file also has unstaged changes, with "This file also has unstaged changes. Revert or stage them first." (Clarifications, 2026-10-27).
- **FR-017**: A staged revert MUST publish the index first and write the working file second. When the working-file part stops, the index part MUST stay. The result MUST state "Arbareto removed the changes from the index. It did not change <file>, because <reason>."

#### Revert file

- **FR-018**: With the Changes list or the Staged list focused, R MUST open the review of the marked rows of that list, or else of the focused row. Marks never span both lists (004 FR-034). The Changes-list row menu MUST hold a separate destructive group with "Revert file…" or "Revert <n> files…" (R), directly above the 005 "Delete from disk" group (005 FR-023). A revert deletes no file, so the item MUST NOT join that group (mockup approval, 2026-10-31). The Staged-list row menu MUST hold a separate destructive group with the same item.
- **FR-019**: Revert file MUST set each file to HEAD. The index entry MUST get the HEAD mode and object ID. The working file MUST get the bytes that Git's own restore from HEAD writes for that path. Git's `checkout-index --temp` of the published index entry writes these bytes to its temporary file. A file whose index entry already equals HEAD MUST change only its working file.
- **FR-020**: A deleted file MUST come back, after a staged deletion and after an unstaged deletion. The review MUST bind the path as absent. An untracked file at that path MUST refuse with "A file that Git does not track exists at <path>. Delete it first, or keep the deletion." The run MUST create each missing folder on the path, as Git's own restore does. It MUST create each folder below its held parent, without following a link. A folder that the run created MUST stay after a later stop, and the result MUST name it.
- **FR-021**: A staged new file that HEAD does not have MUST lose its index entry. Its working file MUST stay, and Git then shows it as untracked (Clarifications, 2026-10-27). On an unborn branch, every file follows this rule.
- **FR-022**: A multi-file revert MUST update the index in one step for all its files, or change nothing (004 FR-038). Then it MUST write each working file in its own atomic step. One refused file at review MUST refuse the whole action, and the reason MUST name the file. One action MUST cover at most the 004 multi-file limit (004 FR-040). Above it, the action MUST be unavailable with the limit stated.
- **FR-023**: Revert file MUST be unavailable when the selection holds an untracked row, with "Arbareto does not revert an untracked file. Use Delete." It MUST also be unavailable for a row with a refusal of FR-038, with that reason. With several marked rows, the reason MUST name the first blocking file in tree order (mockup approval, 2026-10-31). On a folder row, R MUST change nothing and show "Arbareto does not revert a folder. Select its files."
- **FR-024**: Revert file MUST support binary files, files with a `working-tree-encoding` attribute, and files with the `ident` attribute. Git's own working-tree conversion gives their exact bytes.
- **FR-025**: Revert file and Revert all unstaged changes MUST have no size limit per file and no size limit per action. A full disk MUST fail with its FR-041 text. Lines and hunks MUST stay within the 001 comparison bounds: 1 MiB per compared version, 1 MiB for the working file, and 20,000 diff lines. These bounds keep the new bytes within one frame of 2,117,152 bytes (plan research R11).

#### Revert all unstaged changes

- **FR-026**: The menu of the Changes header MUST hold a separate destructive group with "Revert all unstaged changes…". The action has no key. Without unstaged changes, the item MUST be unavailable with "No unstaged changes."
- **FR-027**: The action MUST cover exactly the tracked entries of the shown status read whose working side differs from the index. It MUST include the rows that Filter files hides, as Stage all changes does (004 FR-101). It MUST NOT cover untracked, ignored, or staged-only entries. A submodule entry MUST stay unchanged, and the confirmation MUST count it.
- **FR-028**: Each covered file MUST get the bytes that Git's own `git restore` from the index writes for that path. Git's `checkout-index --temp` of the index entry writes these bytes to its temporary file. The index MUST NOT change.
- **FR-029**: When a covered entry has a refusal of FR-038, the action MUST be unavailable (Clarifications, 2026-10-27). Its reason MUST name the first 20 such files with their reasons. The action MUST cover at most the 004 multi-file limit.
- **FR-030**: While the action runs, the status bar MUST show "Reverting <i> of <n>…" and Cancel. Cancel MUST stop the action before the next file.

#### Write safety

- **FR-031**: Arbareto MUST replace each working file itself. Git MAY write only its own temporary file, through `checkout-index --temp`. A Git command MUST NOT write the target. So Arbareto MUST NOT run `git apply` without `--cached`, `checkout`, `restore`, `checkout-index` without `--temp`, `reset`, or `stash` for these actions.
- **FR-032**: Each write MUST be one atomic replace. Arbareto MUST write a new file in the same folder, flush it, and rename it over the target in one step. At every moment, the target MUST hold its old bytes or its new bytes. It MUST never hold a part, and it MUST never be missing. For a path bound as absent, the rename MUST succeed only while the name is still absent.
- **FR-033**: Immediately before the rename, the write MUST compare the target with the review: size and SHA-256, or absent. On Windows, the write MUST hold the target without write sharing from this check until the rename.
- **FR-034**: The write MUST NOT follow a link or a junction, on the path or at the target. The review MUST refuse a link or a junction with `not-regular`. It MUST refuse a file with more than one hard link with `hard-link`. It MUST refuse a file with the read-only attribute with `read-only`. It MUST NOT clear the attribute.
- **FR-035**: The new file MUST keep the hidden and system attributes and the security descriptor of the old file. When the write cannot keep one of them, the review MUST refuse with a typed reason. The plan MUST list each file fact that the write keeps. It MUST record each fact that the write drops, such as an alternate data stream, as a known limit.
- **FR-036**: A failed write MUST leave no temporary file. The plan MUST show how a crash leaves no temporary file, or record the case as a known limit. Arbareto MUST remove Git's temporary file only by the name that Git printed, and only after a check of its size and SHA-256. Arbareto MUST NOT delete a file because its name matches a pattern. Known limit: a crash after `checkout-index --temp` leaves Git's temporary file `.merge_file_<random>` in the worktree root, and the status shows it as untracked.
- **FR-037**: Arbareto MUST NOT retry a failed write or a refused step by itself.

#### Refusals

- **FR-038**: Each refusal MUST name its reason. The comparison limitations MUST show the existing 001 limitation text. These reasons apply to every revert action:
  - The 001 support reasons: `rename`, `mode`, `type`, `symlink`, `submodule`, `LFS`, `filter`, `state`, `index-flag`, and `path`.
  - `untracked`: "Arbareto does not revert an untracked file. Use Delete."
  - `attributes`: "Git reads other attributes for <path> from the working files than from the index. Commit or revert the .gitattributes change first." The review MUST compare Git's attribute values of the path from the working files and from the index, for `text`, `eol`, `crlf`, `ident`, `filter`, and `working-tree-encoding`. A difference MUST refuse.
  - `not-regular`: "<file> or a folder on its path is a link or a junction. Arbareto does not follow it."
  - `hard-link`: "<file> has more than one hard link. Arbareto does not change it."
  - `read-only`: "<file> is read-only. Arbareto does not change it."
  - `owner` (WSL): "Another user owns <file>. Arbareto does not change it."
  - `in-the-way`: the FR-020 text. It also applies when a file that is not a folder stands at a folder name on the path of a deleted file.
  - `unreadable`: "Arbareto cannot read one of these files, so Revert is unavailable." The review cannot read the facts of a target or of a folder on its path.
  - The 001 index lock refusal with its lock guidance (001 FR-016), when the index lock exists at the review or at the start of the run.
  - `encrypted`: "<file> is encrypted. Arbareto does not change it."
  - `file-attributes`: "Arbareto cannot keep the file attributes of <file>. It did not change the file."
  - `security`: "Arbareto cannot keep the permissions of <file>. It did not change the file."
  - `xattr` (WSL): "<file> has extended attributes. Arbareto does not change it."
  - The plan research R8 and R9 decide `file-attributes`, `security`, and `xattr` after the batch 0 probes.
  - `stale`: "<file> changed after the review. Arbareto changed nothing. Check the changes, then try again." For lines, the text ends with "then select the lines again".
  - The index eligibility reasons of an action with a staged part: `sparse-index`, `split-index`, `index-change-hook`, `executable-monitor`, `unqualified-monitor`, and on WSL `shared-repository`.
  - The index read reasons of every action: `sparse-index`, `split-index`, `executable-monitor`, and `unqualified-monitor`, because the review binds the index entry.
  These reasons apply only to lines and hunks:
  - The 001 support reasons `binary`, `encoding`, `size`, and `line-endings`.
  - `ident`: "Arbareto does not revert part of a file with the ident attribute. Use Revert file."
  - The line reasons with revert texts: "The selection holds only context lines. Select added or removed lines.", "The selection covers two hunks. Select lines of one hunk.", "Arbareto does not revert lines or hunks of a deleted file. Use Revert file.", "Arbareto does not revert lines or hunks of a staged new file. Use Revert file.", and 'This hunk holds the Git marker "No newline at end of file". Revert the whole hunk.'
  - `unstaged-changes` for staged lines: the FR-016 text (Clarifications, 2026-10-27).

#### Outcomes

- **FR-039**: After every run, a fresh read MUST decide the result. This applies after success, failure, and Cancel. The fresh read covers the SHA-256 of each written file, the index entry of each path, and a status read. Each file MUST get one outcome: reverted, unstaged only, not changed, changed outside Arbareto, failed with its code, or not started. Cancel MUST NOT be reported as an undo.
- **FR-040**: The success texts MUST be "Arbareto reverted <n> lines in <file>.", "Arbareto reverted a hunk in <file>.", "Arbareto reverted <n> files.", and "Arbareto reverted the unstaged changes of <n> files." A multi-file result with another outcome MUST state the count of each outcome. It MUST list the first 20 files that did not revert, in tree order, each with its outcome, and state "and <m> more files." for the rest.
- **FR-041**: A failed write MUST name the file and the OS status. A sharing violation MUST show "Another program has <file> open. Arbareto did not change it. Close the file, then try again." Access denied, a full disk, a read-only volume, and every other status MUST show the file with its code, in the 005 Delete result form (mockup approval, 2026-10-31).
- **FR-042**: After success, the diff MUST refresh, and the selection MUST move as after Stage file (001 FR-038). A file that leaves its list MUST pass the focus to the next entry, then to the previous entry, then to the list heading. After Cancel of the modal, the focus MUST return to the control that opened it.

#### WSL repositories

- **FR-043**: Every revert action MUST work for WSL repositories under the 001 WSL rules. The write MUST run inside the distro, never through a `\\wsl.localhost` path. For lines and hunks, the bytes of one file MUST cross out of and into the distro only within the plan bound. For Revert file and Revert all unstaged changes, file content MUST NOT cross: Git writes its temporary file inside the distro, and the distro copies it beside the target. The new file MUST keep the mode bits of the old file exactly. A file whose owner differs from the distro user MUST refuse with `owner`. A file whose group the write cannot keep MUST also refuse with `owner`. A file with more than one hard link MUST refuse with `hard-link`. The write MUST NOT follow a link at any path component. A staged part MUST refuse with `shared-repository` when any scope sets `core.sharedRepository`. Known limit: the rename inside the distro acts by path after its check. A write by another program in that window gets replaced.
- **FR-044**: WSL tests MUST run in an owned distro folder of Ubuntu-26.04. Each test MUST compare with Git's own commands on a copy in the same distro. A case that the harness cannot run MUST stay recorded as unverified with its cause.

#### Visible controls and keyboard

- **FR-045**: Every new control and menu item MUST follow 004 FR-085 and FR-087. It MUST have a label, a tooltip with its key, an accessible name, and visible focus. A menu item MUST give "R" in `aria-keyshortcuts`. An unavailable item MUST state its reason. The revert items MUST stay in their separate destructive groups, apart from routine actions.
- **FR-046**: R MUST act only while the diff, the Changes list, or the Staged list has focus. It MUST NOT act during an IME composition or in an editable field. On a refused row or selection, R MUST change nothing and MUST show the reason, as Space does (001 FR-038). A held R MUST open at most one modal.
- **FR-047**: The modal MUST be an alert dialog. Its accessible name MUST be its title, and its description MUST be its text. Focus MUST stay inside the modal until it closes. The result MUST show in the status region, which assistive technology announces.
- **FR-048**: The window MUST keep the 001 SC-005 response targets during every review and run of this feature.
- **FR-049**: Logs and diagnostics MUST NOT hold file content or diff text of a revert. They MAY hold the action, the paths, the outcomes, and the codes.

### Key Entities *(include if feature involves data)*

- **Revert review**: The action kind, the repository, HEAD, the shown comparison where it applies, and the operation state. It holds one file plan per path. It is single-use.
- **File plan**: One path with its bound index entry and its bound working-file facts. The facts are absent, or type, size, SHA-256, identity, link count, attributes, and on WSL mode and owner. It also holds the new index entry if any, and the new working bytes or the source blob, with the SHA-256 of the bytes.
- **Line selection**: The selected added and removed lines of one hunk of the shown comparison, as in feature 004.
- **Revert result**: The outcome of each path from the fresh read, the index part state, and the failure code where one applies.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In every line and hunk fixture, the working-file bytes equal Git's own reverse apply of the same partial patch on a copy. The fixtures with a line-ending conversion use their stated expected bytes: the check-in form of the new bytes equals Git's own `apply --cached --reverse` on a staged copy, and every unselected line keeps its raw bytes (plan D13). In every unstaged fixture, the index digest stays unchanged. In every staged fixture, the index equals Git's own `apply --cached --reverse` on a copy. Every other working-file byte stays unchanged.
- **SC-002**: In every Revert file fixture, the index and the working files equal Git's own `git restore --staged --worktree --source=HEAD` on a copy. One difference is intended: a staged new file keeps its working file, which Git's restore deletes (Clarifications, 2026-10-27). In every Revert all unstaged changes fixture, the working files equal Git's own `git restore .` on a copy, and the index stays unchanged. Untracked files and submodule working trees stay byte-identical.
- **SC-003**: In every stale fixture, nothing changes, and the result names the changed fact. The fixtures change the file, the index entry, HEAD, the attributes, or the configuration between the review and the run.
- **SC-004**: In every refusal fixture of FR-038, the action refuses before any change. The index digest and every working-file byte stay unchanged.
- **SC-005**: In the interruption fixtures, the run stops at each write step through a fault seam, or the process ends there. Each target then holds exactly its old bytes or its new bytes, and no file is missing. No temporary file stays, except for a crash case that the plan records as a known limit.
- **SC-006**: In every confirmation test, Enter right after the open, Escape, Cancel, and a held R change nothing. Only an activation of the revert button reverts.
- **SC-007**: On the packaged build, with budgets fixed before the measurement, warm, median of 10 runs on the agreed hardware: R shows a busy state within 100 ms. The confirmation or the refusal shows within 500 ms for a file of up to 1 MiB. For Revert all unstaged changes of 1,000 files, it shows within 3 s. A line, hunk, or single-file revert shows the refreshed diff within 500 ms after the confirmation. Revert file of 100 files ends within 3 s. Revert all unstaged changes of 1,000 files ends within 10 s on Windows and within 30 s on WSL. Revert file of one 1 GiB binary file ends within 30 s on Windows, and the service memory rises by at most 64 MiB. Cancel stops a multi-file run within 1 s. The process-tree memory rises by at most 64 MiB during a run at the 004 multi-file limit.
- **SC-008**: In every WSL fixture on Ubuntu-26.04, the results equal Git's own commands on a copy in the distro. The mode bits, the owner, and the link count of each written file stay unchanged.
- **SC-009**: Keyboard-only users complete User Stories 1 to 4. Each new control has an accessible name, visible focus, and a contrast of at least 4.5:1. The modal and the menus stay usable in a Windows contrast theme and at the Windows text sizes 150% and 225% (001 SC-009).
- **SC-010**: A review of the requirement-to-test map finds no outcome that Git message text, timing, retry counts, or a name pattern decides.
- **SC-011**: During every review and run, the window keeps the 001 SC-005 targets: 95% of inputs show a response within 100 ms, and every input within 500 ms.

## Assumptions

- The actions use the word "Revert", as the user named them. Git's later commit revert gets the label "Revert commit…", so the two stay distinct. This is a reviewer default.
- R in the Staged list opens Revert file, as R in the Changes list does. Git Extensions offers Reset file in both lists. This is a reviewer default.
- The diff offers the revert items in a "More actions" menu of each hunk, not as visible buttons beside Stage hunk. Constitution VII keeps destructive actions apart from routine actions. The mockup through the arbareto-ux skill confirms the placement. This is a reviewer default.
- Revert all unstaged changes sits in a menu of the Changes header, and it has no key. Git Extensions offers it in the commit dialog without a default key. This is a reviewer default.
- The confirmation shows counts and paths, not the reverted lines. The selection stays visible in the diff behind the modal. This is a reviewer default.
- The modal and result texts are proposals. The plan records them, as every visible text comes from plan.md.
- The fileReplace step of feature 005 grows to working files. Today it covers only `.gitignore` and `info/exclude` up to 1 MiB. For a whole file, it copies from Git's temporary file instead of a frame.

## Design notes for planning

These notes come from the facts report of 2026-10-27 (local scratch) and the Git source. The plan decides the final form.

- Reuse for staged parts: `applyHunk` (`src/git-service/hunk-publish.ts:1022`) runs `apply --cached [--reverse]` on a private index copy. It recomputes the expected blob in memory (`hunk-candidate.ts:104`, `:349`) and compares the entries (`:365-366`). It publishes through the owned index lock (`hunk-publish.ts:865-869`). `admit` (`:945-975`) refuses stale selections. Checkpoints 5 and 11 (`:978-1011`) check the working file by size and SHA-256 (`snapshot.ts:262`).
- Reuse for line selection: `subHunk` (`line-patch.ts:38`) and the frontend `pickLines` (`hunk-mapping.ts:101`). The unstage rule builds the partial patch against the working side: an unselected `+` line becomes context, and an unselected `-` line drops. The review applies that patch reversed, in memory, to the working bytes.
- Reuse for refusals: `decideSupport` (`support.ts:130`) and `hunkEligibility` (`eligibility.ts:206`). `SUPPORT_ATTRIBUTES` (`support.ts:18`) does not read `ident` today. The line revert must read it, because a restored line would keep the collapsed `$Id$` form.
- Reuse for file unstage: `applyFile` (`file-publish.ts:226`, `:349`) and `applyFiles` (`multi-publish.ts:494`). Unstage writes the HEAD entries through `update-index -z --index-info` (`commands.ts:411`, `:415`). 001 research rejected `git restore --staged` and `reset -- <path>`: they give no checked candidate, and `reset` ran the clean filter on another file (001 `research.md:306-313`).
- Reuse for the write: `fileReplace` (`process_requests.rs:1456`, `file_replace.rs`). It binds "absent" or size and SHA-256. It refuses a link, a folder, and a file with more than one link. It writes a temporary file beside the target, flushes it, and renames it with POSIX semantics. WSL uses the `wslFiles` mode `replace`. Today the request limits the target to the ignore files and 1 MiB (`process_requests.rs:1481-1488`). The WSL mode must also set the old mode bits on the new file before the rename, and check the owner.
- Reuse for review and run: `registerWorkbenchAction` (`workbench-review.ts:103`). `observe` binds the facts and the plan, and the run takes a single-use token.
- Reuse for Delete of untracked files: `file-delete.ts:117`, shell `file_delete.rs`, keys Del and Shift+Del (`shortcuts.ts:186-187`). The key R is free in the `diff`, `fileList`, and `changesList` scopes (`shortcuts.ts:172-190`).
- Whole-file bytes: `git checkout-index --temp --stdin -z` writes the working-tree form of each index entry to `.merge_file_<random>` through `mkstemp` in its current folder (`entry.c` `open_output_fd`, Git v2.56.0). `--prefix` does not apply to a temporary file (`entry.c` `checkout_entry_ca`). `checkout-index` runs with `NEED_WORK_TREE` (`git.c`), so its current folder is the worktree root. It prints `<temp> TAB <path>`, and with `-z` it ends each record with NUL. With `--temp`, it takes no index lock and writes no index (`builtin/checkout-index.c`). It reads attributes in the check-in direction: the working `.gitattributes` first (`attr.c:856`). Branch checkout reads the index first (`attr.c:852`, `unpack-trees.c`). The `attributes` refusal removes the case where the two differ: the review compares `git check-attr -z` with `git check-attr --cached -z` for the six conversion attributes of the path.
- Line-ending proof: `git hash-object --path=<path> --stdin` without `-w` gives the blob ID of the check-in form and writes nothing. The review compares it with the blob ID of the expected content, which it computes in memory.
- Why not Git on the working tree: `git apply` runs the clean filter on read and the smudge filter on write (`apply.c:2401-2422`, `:4524`). It rewrites the whole file and removes the old file before it writes the new one (`apply.c:4706`). Checkout also unlinks the file and then creates it with `O_EXCL` (`entry.c:577`, `:89`). A failure between the steps leaves no file. Hard links and the read-only attribute are lost. The conversion applies to the whole file (facts report, Git v2.55.0).
- Hooks (Clarifications, 2026-10-27): `checkout_paths` runs `post-checkout` with the flag 0 (`builtin/checkout.c:717`, Git v2.56.0). `cmd_restore` reaches it through `checkout_main` (`:2234`, `:2099`). githooks(5) names only checkout and switch. `checkout-index` runs no hook.
- `apply --index` expects the index and the working copy to be identical. This is why Git Extensions refuses Reset selected lines on a staged file with other unstaged changes (Clarifications, 2026-10-27).
- Switch "Discard" in feature 004 is stash push, checkout, and stash drop (`switch.ts:256`, `workbench-commands.ts:234-257`). This feature does not reuse it.
- Limits: `MULTI_FILE_ACTION_FILES` is 10,000 (`src/contracts/limits.ts:144`). The comparison bounds are 1 MiB per version and 20,000 diff lines (`limits.ts:19-22`). `WHOLE_FILE_STAGE_INPUT_BYTES` is 512 MiB (`limits.ts:21`), and `PIPE_FRAME_BYTES` is 16 MiB (`limits.ts:14`). The FR-025 bound must fit the frame or stream the bytes.
- Temporary file after a crash: a Windows handle with a delete disposition until the rename leaves no file. On WSL, the plan checks `O_TMPFILE` and `linkat` against the atomic rename (unverified).
- The mockup comes first, through the arbareto-ux skill: the hunk "More actions" menu, the row menu groups, the Changes header menu, the modal, and the result lines.

## Research inputs

These facts come from the Git Extensions source at commit a816fb0c, read on 2026-10-27. They describe Git Extensions, not Arbareto. Git Extensions is GPL-3.0, so Arbareto takes ideas only.

- Reset selected lines (`FileViewer.cs:1682`, `:1761`, dialog `:193-205`) asks "Are you sure you want to reset the changes to the selected lines?" with Yes and No. Yes is the default, and Escape means No. The key is R. Unstaged lines go through `git apply --whitespace=nowarn` of a reversed patch on the working tree. Staged lines go through `--reverse --index`.
- Reset selected files (`FileStatusList.ContextMenu.cs:987`) has the key R. The dialog "Reset changes" asks "Are you sure you want to reset all selected files to {0}?" and states "This will delete any uncommitted work.", with Reset and Cancel. A check box "Also delete new files and/or directories" starts clear.
- `GitModule.ResetChanges` (`:1388`) unstages first, deletes new files with `File.Delete`, and then runs `checkout-index --index --force`.
- The commit dialog offers Reset all changes (`reset --hard`, with an optional `clean`) and Reset unstaged changes (`checkout -- .`).
- The Arbareto UX skill (`.claude/skills/arbareto-ux/SKILL.md:24`) lists "Reset changes" among the commit workflow buttons of Git Extensions.
