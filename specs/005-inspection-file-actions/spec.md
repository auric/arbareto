# Feature Specification: History Inspection and Commit View File Actions

**Feature Branch**: `005-inspection-file-actions`

**Feature Directory**: `specs/005-inspection-file-actions`

**Created**: 2026-10-21

**Status**: Draft

**Input**: User description (2026-10-21, own words in quotes): (1) History: "when clicking on the commit, it should show the diff with changes happened in the commit". (2) "sort the files and folders view in the commit view, so the folders comes first and only then files, just like in Git Extensions, this is about untracked files and folders, but the same maybe applied to other views". (3) Show in Explorer for a folder too, not only a file, from the Commit view. (4) Delete a file or a folder right from the Commit view. (5) "when adding something to git exclude or gitignore, we should show the dialog like in the Git Extensions, maybe not that kind of the dialog, something else, but the idea is to allow user to edit whole file, and show ignored files, which would be ignored in case of adding some line or editing some line." (6) Open a submodule inside the app by click or through the row menu. (7) "blame like in Git Extensions but better, we need some blame view also". (8) "we should show full branch entry name and its origin details when the branch name is too long and cannot be displayed fully in the view". (9) "maybe we should have some icon to display branches that already have no origin".

## Clarifications

### Session 2026-10-21

The user gave these decisions, and accepted every recommended default of the feature design.

- Q: Where does Delete put the files? → A: Delete moves them to the Recycle Bin. Shift+Delete deletes them permanently, "just like in Windows" (FR-024, FR-025).
- Q: Does Open submodule open a new window? → A: No. It opens the submodule in the same window. A separate header button "Open parent repository" then names the parent. One click on it goes back (FR-047, FR-051).
- Q: Which feature comes first? → A: This feature. WSL parity and the commit message spell check (nspell with English and downloadable dictionaries) move to feature 006.
- Q: What does a folder Delete remove? → A: Only the files that the Changes list shows under that folder, then the folders that become empty. Ignored files and files that the list does not show stay (FR-022).
- Q: Does the ignore editor keep the one-line "Add to .gitignore?" dialog? → A: No. The ignore editor replaces it (FR-034).
- Q: In which order do file trees show their entries? → A: Folders first, then files. Names sort A to Z with ASCII letter case ignored, and equal names then sort by their raw bytes. The References tree uses the same order (FR-015 to FR-017).
- Q: Which diff does a merge commit show? → A: The diff against parent 1, with a "Compare with" parent picker (FR-008).
- Q: What does Delete do in a WSL repository? → A: A WSL distro has no Recycle Bin. Plain Delete opens the permanent confirmation with the line "Files in a WSL distro have no Recycle Bin." (FR-029).
- Q: Does blame skip the commits of an ignore list? → A: Only when Git configuration sets `blame.ignoreRevsFile`. A toggle "Skip commits in the ignore list" turns it off for one blame. A `.git-blame-ignore-revs` file without that setting has no effect (FR-059).
- Q: Does the ignore editor work in a WSL repository? → A: Yes. The feature design (R5) and the recommendation Q1 of 2026-10-21 allow it. The bytes of one ignore file, at most 1 MiB, cross out of the distro. The unsaved text and the preview path lists cross into the distro. The preview runs inside the distro (FR-043).
- Q: Which method gives the exact ignore preview? → A: The investigator report of 2026-10-21 found an exact method. It covers the root `.gitignore` and `info/exclude`, on Windows and in WSL. It writes nothing into the repository. The cases without an exact preview show a typed limit (FR-038, FR-039).
- Q: When Windows cannot move a file to the Recycle Bin, what does plain Delete do? → A: Windows shows its own permanent-delete warning, as Explorer does. No keeps the file. The result names the outcome of each file (FR-028).
- Q: How long may one ignore preview take on Windows, and at which path bound? → A: About 5 seconds at 100,000 paths. A folder that both texts ignore counts as one path. Above the bound, the preview shows "Preview not available" (FR-039, SC-005).
- Q: What progress does Blame show when an ignore list applies? → A: A busy state with Cancel and no counts. The line counts show only without an ignore list (FR-063, SC-006).
- Q: Where does Blame open from a Commit view row? → A: In History, in place of the History list. Escape or Back returns to the Commit view row (FR-054).
- Q: What happens to unsaved ignore editor text at another ignore action or another open? → A: A row action for the same file adds its line to the current text and selects it. A row action for the other file first asks "Discard changes to <file>?". Open submodule, Open parent repository, and Open repository also ask first (FR-044).
- Q: Does a branch whose remote was removed show the gone mark? → A: No. Git reports such a branch as a branch without an upstream. The card states "No upstream", and no new Git read runs (FR-064, FR-066).
- Q: Where is Open submodule offered? → A: In the sidebar Submodules group, by click, Enter, or the row menu. The row menu of a submodule row in the Commit view Changes list also offers it. Both places use the same checks and the same unavailable reasons (FR-047, FR-048).
- Q: Does Save of the ignore editor run during a merge or a rebase with conflicts? → A: Yes. Save changes no Git state, and the 004 ignore action ran then too. Delete stays blocked then (FR-033, FR-046).
- Q: Which `blame.ignoreRevsFile` values count when one value is empty? → A: Blame follows Git exactly (user decision of 2026-10-21, fact F7). Git uses every non-empty value from every configuration scope. An empty configuration value does not reset the list. The Git doc says otherwise (`config/blame.adoc:24-28`), but `builtin/blame.c:771` and `:941-947` decide (FR-059).

## User Scenarios & Testing *(mandatory)*

Feature 001 shows the commit details of a selected history row, with the static line "Changed files are not shown in this version." Feature 004 adds the Commit view with file trees, Show in Explorer for a file, a one-line ignore action, and the Submodules group. This feature makes history inspectable and makes the Commit view a place to act on files. Git Extensions is the reference for the functions, and Arbareto must be faster and safer.

### User Story 1 - See the changes of a commit in History (Priority: P1)

A developer selects a commit in History. The changed files of the commit and the diff of the first file show at once. The developer moves through the files with the arrow keys. For a merge commit, the developer picks the parent to compare with.

**Why this priority**: History shows no changes today. Every Git client shows them, and the user asked first for this.

**Independent Test**: In disposable fixtures with normal, merge, root, shallow, rename, mode change, binary, submodule, and very large commits, select each commit. Compare the file list and each diff with Git's own two-tree comparison of the same parent and commit, run by hand.

**Acceptance Scenarios**:

1. **Given** a commit that changes 3 files. **When** I select its row. **Then** the region "Changed files (3)" lists the 3 files in tree order, and the diff of the first file shows.
2. **Given** the file list has focus. **When** I press Down. **Then** the diff of the next file shows within 150 ms, without motion.
3. **Given** a merge commit with 2 parents. **When** I select it. **Then** "Compare with" shows "Parent 1 <short ID>" selected, and the list equals the comparison with parent 1. **When** I select Parent 2. **Then** the list and the diff compare with parent 2.
4. **Given** a root commit. **When** I select it. **Then** every file shows as added, with the line "Compared with an empty tree. This is a root commit."
5. **Given** a shallow clone and a commit whose parent the clone does not hold. **When** I select it. **Then** the region states "Arbareto cannot show the changes. The parent of this commit is not in this shallow clone." and shows no file.
6. **Given** a renamed file at 92% similarity. **When** I select it. **Then** the diff header states "Renamed from <old path> (92% similar)."
7. **Given** a binary file, a mode change, or a submodule entry. **When** I select it. **Then** the diff states "Binary file. Arbareto does not show its changes.", "Mode <old> → <new>.", or "Submodule commit <old short ID> → <new short ID>."
8. **Given** a commit that changes more files than the plan bound. **When** I select it. **Then** the list shows exactly the first files up to the bound and states "This commit changes more files than Arbareto shows. Arbareto shows the first <n>."

---

### User Story 2 - Delete files and folders from the Commit view (Priority: P1)

A developer selects untracked or changed files, or a folder, in the Changes list and presses Delete. A confirmation lists what goes. The files go to the Recycle Bin. With Shift+Delete they are deleted permanently.

**Why this priority**: Build output and scratch files collect in the Untracked section. Today the user must leave the application to delete them. A wrong delete loses work, so the safety rules matter as much as the action.

**Independent Test**: In disposable fixtures, delete untracked files, changed tracked files, folders, links, and marked rows, with Delete and with Shift+Delete. Check that exactly the listed paths are gone, that the index and every other working-file byte stay unchanged, and that each recycled item is in the Recycle Bin. Change a file between the confirmation and the run, and check that nothing is deleted. Each Recycle Bin test purges the items that it moved, and changes no other Recycle Bin item.

**Acceptance Scenarios**:

1. **Given** 3 marked untracked files and the Changes list has focus. **When** I press Delete. **Then** the modal "Move 3 files to the Recycle Bin?" lists them, Cancel has the first focus, and "Move to Recycle Bin" moves them.
2. **Given** one untracked file. **When** I press Shift+Delete. **Then** the modal "Delete 1 file permanently?" states "You cannot undo this.", and "Delete permanently" deletes it.
3. **Given** a tracked file with unstaged changes. **When** I delete it. **Then** the confirmation states "Git tracks 1 of these files. The index does not change. Git then shows them as deleted.", and after the run the Changes list shows the file as deleted.
4. **Given** the folder row logs with 4 listed files and 1 ignored file inside. **When** I delete the folder. **Then** the confirmation states "Arbareto deletes the 4 listed files in logs. Ignored and tracked files that the list does not show stay." The 4 files go, the ignored file stays, and the folder stays because it is not empty.
5. **Given** a confirmation that is open. **When** another program changes one of the files before I confirm. **Then** the run deletes nothing, and the application states that the files changed and asks for a new review.
6. **Given** a symbolic link to a folder outside the repository. **When** I delete the link. **Then** only the link goes. The target and its contents stay.
7. **Given** a submodule row, a conflicted row, or a folder that holds another Git repository. **When** I open its menu. **Then** Delete is unavailable with the reason, such as "Arbareto does not delete a submodule."
8. **Given** a WSL repository. **When** I press Delete. **Then** the permanent confirmation opens with "Files in a WSL distro have no Recycle Bin."
9. **Given** a file that Windows cannot move to the Recycle Bin. **When** I press Delete and confirm. **Then** Windows shows its permanent-delete warning. **When** I select No. **Then** the file stays, and the result names it as kept.

---

### User Story 3 - Folders first in every file tree (Priority: P2)

A developer opens the tree layout of the Commit view. Folders show first, then files, each group from A to Z. The History file tree and the References tree use the same order.

**Why this priority**: Today the order follows Git's status output, which mixes folders and files. Git Extensions shows folders first, and the user expects it.

**Independent Test**: Load fixtures with mixed letter case, digits, punctuation, non-ASCII names, and names that are not valid UTF-8. Compare every shown tree with a reference sort by the rule of FR-015. The fixture of scenario 3 stores its branches as packed refs or in reftable. Loose refs `feature/b` and `Feature/a` share one folder on a case-insensitive volume.

**Acceptance Scenarios**:

1. **Given** the untracked entries `b.txt`, `A/x.txt`, `a.txt`, and `c/y.txt`. **When** the tree layout shows. **Then** the order is `A/`, `c/`, `a.txt`, `b.txt`.
2. **Given** the flat layout of the same entries. **When** it shows. **Then** the order equals the order of the leaves of the tree.
3. **Given** branches `feature/b`, `Feature/a`, and `main` in the References tree. **When** it shows. **Then** folders show first, then `main`, and each group follows the same rule.
4. **Given** a submodule row `lib`, a nested-repository row `x/`, and a file `a.txt`. **When** the tree layout shows. **Then** `lib` and `x/` sort among the folders, before `a.txt`.

---

### User Story 4 - Show a folder in Explorer (Priority: P2)

A developer right-clicks a folder row in the Commit view and selects Show in Explorer. Explorer opens the parent folder with that folder selected.

**Why this priority**: The folder item is unavailable today with the reason "Show in Explorer takes one file. Select a file in the folder." It is small and closes a visible gap.

**Independent Test**: In a disposable fixture, run Show in Explorer on a nested folder, on a folder with non-ASCII characters, and on a folder link. Check the Explorer window and the selected item.

**Acceptance Scenarios**:

1. **Given** the folder row `src/logs/`. **When** I select Show in Explorer. **Then** Explorer shows `src` with `logs` selected.
2. **Given** a folder that someone deleted after the last status read. **When** I select Show in Explorer. **Then** the application states that the folder does not exist, and no Explorer window opens.

---

### User Story 5 - Edit an ignore file with a live preview (Priority: P2)

A developer selects "Add to .gitignore…" on a row. A docked editor shows the whole `.gitignore`, with the new line added at the end and selected. While the developer edits, a preview lists the files that become ignored and the files that stop being ignored. Save writes the whole file.

**Why this priority**: The one-line dialog adds a fixed line. Users need a pattern, such as `*.log`, and need to see what it hides before the save.

**Independent Test**: In disposable fixtures with negations, nested `.gitignore` files, ignored folders, CRLF files, a BOM, and an empty file, type each candidate text. Compare the preview with the ignored set that Git lists after a real save on a copy. Change the file on disk before Save and check that Save refuses.

**Acceptance Scenarios**:

1. **Given** the untracked folder logs. **When** I select "Add to .gitignore…". **Then** the editor "Edit .gitignore" shows the whole file with line numbers, and the last line "/logs/" is selected.
2. **Given** the editor. **When** I type the line `*.log` and stop typing. **Then** "Updating preview…" shows, then "Newly ignored (<n>)" lists the matching untracked files.
3. **Given** a line that a later `!keep.log` line re-includes. **When** the preview updates. **Then** keep.log does not show as newly ignored.
4. **Given** I delete an existing line. **When** the preview updates. **Then** "No longer ignored (<n>)" lists the files that Git then shows as untracked.
5. **Given** a new pattern that matches tracked files. **When** the preview updates. **Then** it states "Tracked files stay tracked." with the count of tracked files that the pattern newly matches.
6. **Given** another program changed `.gitignore` after the editor loaded it. **When** I select Save. **Then** Save refuses, the file keeps the other program's bytes, and the editor asks me to reload.
7. **Given** unsaved text. **When** I select Close. **Then** the modal "Discard changes to .gitignore?" offers Discard and Keep editing.
8. **Given** a `.gitignore` with CRLF line endings. **When** I add a line and save. **Then** every line of the saved file ends with CRLF.
9. **Given** unsaved text in "Edit .gitignore". **When** I select "Add to .gitignore…" on another row. **Then** its line is added at the end and selected. **When** I select Open submodule. **Then** "Discard changes to .gitignore?" opens first.
10. **Given** the editor text already holds the line "/logs/". **When** I select "Add to .gitignore…" on the logs row. **Then** the editor adds no line and selects the existing line.

---

### User Story 6 - Open a submodule and go back (Priority: P2)

A developer double-clicks a row in the Submodules group, or selects Open submodule in its menu. The row menu of a submodule row in the Commit view also offers Open submodule. The window shows the submodule. A header button names the parent repository, and one click goes back.

**Why this priority**: Today the user must open the submodule folder through Open repository and find the parent again afterwards.

**Independent Test**: In submodule fixtures of feature 001, open initialized, uninitialized, and nested submodules from the Submodules group and from the Commit view row menu, and go back. Check that the parent's repository programs never run before trust, that the submodule asks for its own trust, and that an open during a parent mutation refuses.

**Acceptance Scenarios**:

1. **Given** an initialized submodule lib. **When** I press Enter on its row. **Then** the window shows lib, and the header shows "Open parent repository" with the parent folder name.
2. **Given** the submodule is open. **When** I select "Open parent repository". **Then** the window shows the parent again.
3. **Given** an uninitialized submodule. **When** I open its menu in the Submodules group or in the Commit view. **Then** Open submodule is unavailable with "Initialize this submodule first. Select Update submodules."
4. **Given** a trusted parent and a submodule with a hook. **When** the submodule opens and I select Commit. **Then** the trust prompt asks for the submodule. The parent's trust does not apply.
5. **Given** a running operation in the parent. **When** I open a submodule. **Then** the application refuses as busy, and the parent stays open.
6. **Given** a submodule row lib with a changed commit in the Commit view Changes list. **When** I select Open submodule in its row menu. **Then** the window shows lib, as an open from the Submodules group does.

---

### User Story 7 - Blame a file (Priority: P2)

A developer opens Blame on a file from the History diff or from a tracked row of the Commit view. Each run of lines shows its commit, author, and date. The developer selects a line to jump to its commit in History, or runs "Blame before this commit" to look past a commit.

**Why this priority**: Blame is the main tool to find why a line changed. Git Extensions has it, and the user wants a better one.

**Independent Test**: In blame fixtures with renames, moved lines, whitespace changes, an ignore list, a shallow clone, binary files, and submodules, compare every attribution with Git's own blame run by hand with the same options. Cancel a blame of a large file and check that Git stops.

**Acceptance Scenarios**:

1. **Given** a file in the History diff. **When** I select Blame. **Then** the panel "Blame: <path> at <short ID>" replaces the History list, shows progress, and then shows each run of lines with short ID, author, and relative date.
2. **Given** the blame view from the History diff. **When** I press Enter on a line. **Then** History selects that line's commit. **When** I press Escape. **Then** the History list comes back.
3. **Given** a line. **When** I press Alt+Left. **Then** the view shows the blame of the file before that line's commit, at the matching line.
4. **Given** "Ignore whitespace", "Detect moved lines", or "Detect lines from other files". **When** I turn one on. **Then** the attribution equals Git's blame with the same option.
5. **Given** `blame.ignoreRevsFile` names an existing file. **When** I open Blame. **Then** "Skip commits in the ignore list" shows and is on, and "Blaming…" shows without counts. Ignored lines show "?", and unblamable lines show "*". **When** I turn it off. **Then** the attribution equals Git's blame without an ignore list.
6. **Given** `blame.ignoreRevsFile` names a missing file by a relative path. **When** I open Blame. **Then** the view states "Git cannot run blame. The file <path> that blame.ignoreRevsFile names does not exist."
7. **Given** an untracked file or a binary file. **When** I open the row menu. **Then** Blame is unavailable with "Git has no history for this file." or "Arbareto does not blame a binary file."
8. **Given** a running blame. **When** I select Cancel. **Then** Git stops within 1 second, and the view states that the blame stopped.
9. **Given** a tracked row in the Commit view. **When** I select Blame. **Then** the window switches to History, and the blame replaces the History list. **When** I press Escape. **Then** the Commit view shows with that row selected.
10. **Given** a line from a root commit. **When** I press Alt+Left. **Then** nothing runs, and the view states "Git names no earlier version of this line."

---

### User Story 8 - See a full branch name and its tracking state (Priority: P3)

A developer hovers over or focuses a branch name that the sidebar cuts. A card shows the full name, the upstream, the ahead and behind counts, and the worktree that holds the branch.

**Why this priority**: Long branch names are cut in the sidebar and the branch list, and the user cannot read them. It is a convenience.

**Independent Test**: With branch names of several lengths and a narrow sidebar, hover and focus each row. Check that the card shows exactly for the cut names, and that its facts equal Git's own reference read.

**Acceptance Scenarios**:

1. **Given** a cut branch name. **When** I hover over it or focus it. **Then** a card shows the full name, "Upstream: origin/<name>" or "No upstream", and "2 ahead, 1 behind" or "Up to date".
2. **Given** a branch name that fits. **When** I hover over it. **Then** no card shows.
3. **Given** the card is open. **When** I press Escape. **Then** the card closes, and focus stays on the row.
4. **Given** a cut remote branch name in the sidebar. **When** I hover over it. **Then** the card shows only the full name.

---

### User Story 9 - See which branches lost their upstream (Priority: P3)

A developer sees an icon on each local branch whose upstream branch no longer exists, for example after a fetch with prune.

**Why this priority**: It helps to clean up old branches. It is a small visual change.

**Independent Test**: In fixtures with branches without upstream, with a present upstream, with a deleted upstream, and with a removed remote, check that the icon shows exactly for the deleted upstream.

**Acceptance Scenarios**:

1. **Given** a branch whose upstream origin/old was pruned. **When** the sidebar shows. **Then** the row shows the gone icon with the tooltip "The upstream origin/old no longer exists.", and its accessible name holds ", upstream gone".
2. **Given** a branch without an upstream. **When** the sidebar shows. **Then** no icon shows, and the card states "No upstream".
3. **Given** a branch whose remote was removed from the configuration. **When** the sidebar shows. **Then** no icon shows, and the card states "No upstream".

---

### Edge Cases

- A merge commit has more than 63 parents. The picker offers the parents up to the 001 bound, as the history view does.
- A commit's objects are missing, as in a partial clone. The diff shows the feature 001 missing-object remedy and fetches nothing on its own.
- A commit renames more files than the rename limit allows. Git pairs no renames above the limit, and the list shows a delete and an add. Both are true tree facts, and the application states none as a rename.
- A file is deleted from disk between the status read and Delete. The result states "absent" for that file, and the fresh read shows the real state.
- A folder on the path to a file is swapped for a link or a junction after the review. Delete deletes nothing outside the reviewed paths and reports the file as changed.
- Known limit: the Recycle Bin call takes a path. Another program can swap the last component after the identity check and before the move. Then the swapped item goes to the Recycle Bin. In that window, it can also empty a folder on the path and make it a junction. The result states the observed outcome from the fresh read. Delete permanently on Windows has no such gap.
- Known limit: the WSL remove step acts on the last component after its check. A swap of that component in that window deletes the swapped item.
- Known limit: Arbareto does not pass a path of 260 or more characters to the Recycle Bin call. Plain Delete is then unavailable with the reason. Delete permanently stays available.
- Known limit: a file above 1 MiB gets no content digest at review. An edit that keeps its size and last-write time goes unnoticed.
- A file is read-only. Delete permanently does not clear the attribute. The result names the file with the reason access denied.
- A file cannot go to the Recycle Bin, for example on a volume without one. Windows shows its permanent-delete warning. No keeps the file, and the result names it as kept. Yes deletes it, and the result names it as deleted.
- A folder Delete covers more entries than the 004 multi-file limit. Delete is unavailable with the limit, and no file goes.
- Delete is cancelled while it runs. Each file shows its observed state from a fresh read. Cancel is not reported as an undo.
- `.gitignore` is a symbolic link, a folder, above 1 MiB, not valid UTF-8, or holds a NUL. The editor refuses to open it and names the reason.
- `.gitignore` mixes LF and CRLF, or holds a lone CR. The editor refuses with the reason "mixed line endings".
- `.gitignore` does not exist. The editor opens empty, and Save creates the file with LF line endings.
- A subfolder `.gitignore` is a symbolic link, or lies inside an ignored folder. Git does not read it. The preview states that it has no effect.
- On a case-insensitive volume, a listed file name equals `.gitignore` except for letter case. The preview shows "Preview not available" with the reason.
- The repository has more paths than the preview bound. The preview shows "Preview not available" with the bound. Save stays available.
- A preview is cancelled, or the application ends during a preview. The preview's temporary files go after the Cancel. Files that a crash left go at the next preview, on Windows and inside the WSL distro.
- A submodule folder holds a `.git` file whose repository Git cannot find. Open submodule refuses with the reason "submodule-not-initialized".
- The parent's recent-repository entry is gone after a submodule opened. "Open parent repository" states "Open the parent repository with Open repository."
- A nested chain opens level by level. Each open adds a recent-repository entry for that submodule. "Open parent repository" then goes back one level at a time.
- A blamed file is larger than 4 MiB or longer than 100,000 lines. Blame refuses with the limit.
- Blame reaches a boundary commit in a shallow clone. The gutter states "Earlier history is not in this clone." for its lines.
- A line comes from a root commit or a boundary commit, so Git's blame output names no previous commit. "Blame before this commit" is unavailable with "Git names no earlier version of this line."
- A blamed path is a submodule in that commit. Blame states "This path is a submodule. Open the submodule to blame its files."
- Blame starts on a deleted row of the History diff. The blame runs at the chosen parent, where the file exists, and the heading names that parent.
- An upstream is configured, but its remote no longer exists. Git then reports no upstream for the branch. The row shows no gone mark, and the card states "No upstream".

## Requirements *(mandatory)*

### Scope Boundaries

Include the changed files and the diff of a selected History commit, with a parent picker for a merge commit. Include folders-first tree order in every file tree and in the References tree. Include Show in Explorer for a folder row. Include Delete and Delete permanently of Changes-list rows and folders. Include a docked ignore editor for the root `.gitignore` and for `info/exclude`, with an exact preview. Include Open submodule in the same window and a link back to the parent. Include a blame view of committed lines. Include a branch name card and an upstream-gone mark.

Exclude the Files tab of History, blame of uncommitted lines, Open with, File history, a combined diff of a merge commit, and editing of subfolder `.gitignore` files and of `core.excludesFile`. Exclude WSL ignore reads beyond the one ignore file that the editor loads. Exclude Delete of staged-list rows, submodules, and nested repositories. Exclude the commit message spell check and the other WSL parity items (feature 006). Exclude Bitbucket and Jira integration. Exclude the Git Extensions file-list actions that the user did not request: internal edit, difftool, Rename or Move, Reset file to a revision, Assume unchanged, Skip worktree, and Stop tracking.

The no-heuristics rule applies to every requirement. Every decision comes from exact parses of machine-readable Git output, from Git exit codes that the Git documentation defines for that command, from OS facts, or from contract-defined values. Git message text never decides an outcome.

### Dependencies

- Feature 001 provides the history view, the comparison pipeline, the read gate, the trust gate, and the open flow.
- Feature 003 provides the tracking counts that the branch card shows.
- Feature 004 provides the Commit view, its file trees and row menus, the review and run steps of workbench actions, the Submodules group, and Show in Explorer for a file.

### Changes to earlier requirements

This feature changes these requirements for builds that include it. The earlier texts stay unchanged in their own specs until the plan updates them.

- **001 FR-016** (`specs/001-desktop-qualification/spec.md:407`): "Conflicts and unfinished repository operations MUST block mutations in this slice." Save of the ignore editor also runs during an unfinished operation and with conflicts (FR-046). Delete stays blocked (FR-033).
- **001 FR-027** (`specs/001-desktop-qualification/spec.md:424`): "This slice MUST NOT offer discard, reset, force operations, history rewrites, or automatic conflict repair." Delete and Delete permanently of listed working files (FR-020 to FR-033) are allowed behind their confirmations. This extends the 004 exception list (`specs/004-workbench-ux/spec.md:317`).
- **001 plan.md:601**: "Future destructive actions belong in a separate labelled menu with explicit scope confirmation." The rule stays. The separate labelled menu group of FR-023 and the confirmations of FR-026 meet it.
- **001 plan.md:396**: "The static line "Changed files are not shown in this version." stays." The line goes. The selected commit shows its changed files and diff (FR-005 to FR-014).
- **002 spec.md:125**: "Exclude history inspection features: Changes and Files tabs, historical diffs, and branch filtering." This feature adds historical diffs and blame. The Files tab and branch filtering stay excluded.
- **004 FR-045** (`specs/004-workbench-ux/spec.md:401`): "Before the write, the application MUST show the exact line that it adds." The application MUST show the whole new file and the preview before the write (FR-034 to FR-046).
- **004 FR-046** (`specs/004-workbench-ux/spec.md:402`): "The application MUST append the line to the root `.gitignore` or to the path that Git reports for `info/exclude`." The application MUST add the escaped line to the editor text. Save writes the whole file. The line rules of 004 FR-046 stay. A line that already exists is not added again, and the editor selects it (FR-034).
- **004 D9** (`specs/004-workbench-ux/plan.md:270-276`): "Write: the service sends `fileAppend` …". Save replaces the whole file atomically (FR-042). The one-line append goes.
- **004 FR-006** (`specs/004-workbench-ux/spec.md:338`) and **001 contract §11** (`specs/001-desktop-qualification/contracts/operations.md:1599`, "No working-file content crosses."): The ignore editor works on a WSL repository. The bytes of one ignore file, at most 1 MiB, cross out of the distro. The unsaved text crosses into the distro for the preview and the save. The preview path lists cross into the distro on the preview input (FR-043).
- **004 plan.md:483**: "A folder row gives Show in Explorer the reason "Show in Explorer takes one file. Select a file in the folder." (contract gap: `revealPath` takes one entry)." The sentence goes. A folder row offers Show in Explorer (FR-018, FR-019).
- **003 FR-020 and the 004 sidebar text**: The visible ", not present" after an upstream name goes. The gone mark of FR-064 replaces it.

### Functional Requirements

#### Common rules

- **FR-001**: Every outcome MUST come from a documented Git exit code, Git's machine-readable output, an OS fact, or a fresh read. The Git documentation MUST define that exit code for that command. The application MUST NOT classify any result by Git's message text.
- **FR-002**: Every path and revision MUST pass to Git as a literal value after an end-of-options marker where Git supports one.
- **FR-003**: The reads of this feature MUST NOT run a textconv driver, an external diff, or a hook. The History diff, the ignore preview, and the Open submodule checks load the index. An index load can run a command-valued `core.fsmonitor`. So these reads MUST wait behind the feature 001 read gate (001 `contracts/operations.md:1034`). The blame of a commit, the folder reveal, and the branch card load no index. They need no trust approval. The plan MUST verify whether the "Blame before" line read loads the index. If it does, that read MUST wait behind the same gate.
- **FR-004**: Every read of this feature MUST keep the feature 001 SC-005 response targets. Each read MUST offer Cancel. Each read MUST stay inside the output bounds that the plan states.

#### History diff

- **FR-005**: Selecting a History row MUST show three regions with splitters. The regions are the commit details, "Changed files (<n>)", and the diff. In the constrained window profile, the regions MUST show as two tabs, "Commit" and "Changes".
- **FR-006**: The changed-file list MUST equal Git's two-tree comparison of the chosen parent and the commit. Rename detection MUST use a fixed rename limit. The repository configuration MUST NOT change that limit. Each row MUST show the status: added, deleted, modified, renamed, or type change. A rename row MUST also show the old path. Any other status that Git defines MUST refuse the whole list with a typed error.
- **FR-007**: The list MUST show within 300 ms after the selection (SC-001). The first file in tree order MUST show its diff within 150 ms more. A move to another file by keyboard or pointer MUST show its diff within 150 ms. The move MUST show no motion.
- **FR-008**: A merge commit MUST compare with parent 1 by default. The radio group "Compare with" MUST offer each parent as "Parent <i> <short ID>". The parents MUST come from the history read, not from the renderer.
- **FR-009**: A root commit MUST compare with the empty tree. It MUST state "Compared with an empty tree. This is a root commit." A shallow clone can lack the parent of a commit. Then the list MUST show no file. It MUST state "Arbareto cannot show the changes. The parent of this commit is not in this shallow clone."
- **FR-010**: The diff MUST state a rename with its similarity and a mode change with both modes. It MUST state a submodule entry with both commit IDs. A binary file MUST show "Binary file. Arbareto does not show its changes." The binary fact MUST come from Git's numstat output.
- **FR-011**: Missing objects MUST show the feature 001 missing-object remedy. The read MUST NOT fetch objects.
- **FR-012**: The list MUST stop at the plan bound. It MUST then state "This commit changes more files than Arbareto shows. Arbareto shows the first <n>." Each diff MUST stop at the feature 001 diff bounds and state the limit.
- **FR-013**: The file list MUST offer its own Filter files field, with the rules of 004 FR-101. F6 MUST reach the file list and the diff after the commit details. Each list MUST have one Tab stop with roving focus.
- **FR-014**: The History diff MUST hold no stage, unstage, or hunk action.

#### Tree order

- **FR-015**: Siblings in a tree MUST show folders first, then files. A submodule row and a nested-repository row MUST sort as folders. Inside each group, names MUST compare by their bytes after ASCII case folding (A to Z become a to z). Names with equal folded bytes MUST then compare by their raw bytes, so the order is total. The order MUST NOT depend on a locale or on the WebView version.
- **FR-016**: The flat layout MUST use the same comparison on the path components. The flat order then equals the order of the tree leaves.
- **FR-017**: The order MUST apply to the Changes and Staged lists and the History file list. It MUST also apply to the References tree, the ignore preview lists, and the Delete confirmation list.

#### Show in Explorer for a folder

- **FR-018**: A folder row of the Commit view MUST offer Show in Explorer. Explorer MUST open the parent folder with that folder selected.
- **FR-019**: The folder MUST be a proper prefix of an entry path of the shown status read, followed by `/`. A folder that does not exist on disk MUST refuse with the reason, and no Explorer window opens.

#### Delete

- **FR-020**: Delete MUST act only on rows of the Changes list. These are untracked files, tracked files with unstaged changes, their folder rows, and marked rows. One Delete MUST cover at most the feature 004 multi-file limit (004 FR-040). Above it, Delete MUST be unavailable with the limit stated. It MUST NOT delete a part. Staged-list rows MUST NOT offer Delete.
- **FR-021**: Delete MUST be unavailable for a conflicted row, with "Arbareto does not delete a file with a conflict." It MUST be unavailable for a submodule row, with "Arbareto does not delete a submodule." It MUST be unavailable for a folder that holds another Git repository. Its reason MUST be "This folder holds another Git repository." It MUST be unavailable for a path with a name that the Windows name rules refuse, such as a name that ends in a period or a space. Its reason MUST be "Windows does not allow this file name." The Windows Shell and the path rules of the native side cannot act on such a name (research.md R16 N9). Each reason MUST come from the status read and from file facts.
- **FR-022**: A folder Delete MUST delete exactly the Changes-list entries of the status read under that folder. These are the entries that Stage folder covers (004 FR-036 and 004 FR-101). Every such entry MUST count against the FR-020 limit. Then the Delete MUST remove each folder on the way that becomes empty, deepest first. Ignored files and files that the list does not show MUST stay. A folder that is not empty MUST stay.
- **FR-023**: The row menu MUST show a separate labelled group with "Delete…" (Del) and "Delete permanently…" (Shift+Del). The keys MUST act only while the Changes list has focus.
- **FR-024**: Delete MUST move each file to the Recycle Bin on Windows. The result MUST come from Windows' per-item report. An item that Windows reports as moved MUST show as moved to the Recycle Bin.
- **FR-025**: Delete permanently MUST delete each file without the Recycle Bin. It MUST NOT clear a read-only attribute.
- **FR-026**: Each Delete MUST open a modal confirmation with Cancel as the first focus. It MUST state the file count and the first 20 paths in tree order. It MUST state "and <m> more files." for the rest. The recycle title MUST be "Move <n> files to the Recycle Bin?" with the button "Move to Recycle Bin". The permanent title MUST be "Delete <n> files permanently?" with "You cannot undo this." and the button "Delete permanently". With <n> equal to 1, the titles MUST say "1 file". With <m> equal to 1, the rest line MUST say "and 1 more file."
- **FR-027**: When the selection holds tracked files, the confirmation MUST state "Git tracks <k> of these files. The index does not change. Git then shows them as deleted." A folder Delete MUST state "Arbareto deletes the <n> listed files in <folder>. Ignored and tracked files that the list does not show stay."
- **FR-028**: Plain Delete MUST ask Windows to use the Recycle Bin with the Windows permanent-delete warning on. When Windows cannot move an item to the Recycle Bin, Windows asks before a permanent delete. This matches Explorer. The answer No MUST keep the file. The result MUST name each outcome: moved to the Recycle Bin, deleted, or kept.
- **FR-029**: In a WSL repository, plain Delete MUST open the permanent confirmation. The confirmation MUST add the line "Files in a WSL distro have no Recycle Bin."
- **FR-030**: The run MUST bind to the file facts at review: type, size, last-write time, and link target. For a file up to 1 MiB, the facts MUST also hold a content digest. A changed fact MUST stop the delete of that file before it starts. The result MUST report that file as changed. The review MUST expire after the plan time limit. Known limit: an edit of a file above 1 MiB that keeps its size and last-write time goes unnoticed.
- **FR-031**: Delete MUST NOT follow a link or a junction, on the path or at the last component. A link MUST be deleted as itself. Delete MUST NOT change an item outside the reviewed paths through a folder on the path. Known limit: the Recycle Bin call acts by path after the identity check. In that window, another program can swap the last component. It can also empty a folder on the path and make it a junction. Then the Recycle Bin call reaches the item that the change put there. The WSL remove step acts on the last component after its check. A swap of that component in that window reaches the swapped item. Delete permanently on Windows acts on the checked handle and has no such gap.
- **FR-032**: A tracked file MUST lose only its working file. The index MUST NOT change.
- **FR-033**: After every run, a fresh read of each path and a fresh status read MUST decide the result. This applies after success, failure, and Cancel. The result MUST state one outcome per file. The outcomes are moved to the Recycle Bin, deleted, kept, changed, or absent. The other outcomes are not a regular file, error with its code, and stopped. Cancel MUST NOT be reported as an undo. Delete MUST count as a mutation for feature 001 FR-015 and 001 FR-016.

#### Ignore editor

- **FR-034**: The row menus "Add to .gitignore…" and "Add to info/exclude…" MUST open the ignore editor. The editor MUST add the 004 FR-046 line at the end and select it. When the text already holds a line equal to it, the editor MUST add no line. It MUST then select the existing line. The repository menu MUST offer "Edit .gitignore" and "Edit info/exclude". The one-line "Add to .gitignore?" dialog goes.
- **FR-035**: The editor MUST be a docked, non-modal panel. It MUST show the heading "Edit .gitignore" or "Edit info/exclude", the file path, and line numbers. It MUST offer Save and Close. The `info/exclude` path MUST come from Git.
- **FR-036**: The editor MUST open only an absent file or a regular file. A regular file MUST be at most 1 MiB, valid UTF-8, and hold no NUL. A link, a folder, or any other refusal MUST name the reason. A BOM MUST be kept.
- **FR-037**: Line endings MUST round-trip. A file with only LF MUST save with LF. A file with only CRLF MUST load as LF and save with CRLF. A file with mixed endings or a lone CR MUST refuse with the reason "mixed line endings".
- **FR-038**: The preview MUST list exactly the untracked files that Git ignores after a save of the shown text. It MUST compare them with the files that Git ignores now. It MUST show "Newly ignored (<n>)" and "No longer ignored (<n>)". Each group MUST show at most 1,000 paths in tree order and the full count. It MUST state "Tracked files stay tracked." with a count when that count is not zero. The count MUST be the tracked files that the shown text matches and the saved text does not match. The preview MUST NOT write into the worktree, the index, or the Git configuration of the repository.
- **FR-039**: Before it shows a preview, the application MUST check its method against Git's real listing with the saved text. A difference MUST show "Preview not available: <reason>." The same state MUST show, with a typed reason, when the path count exceeds 100,000. For this bound, a folder that both texts ignore MUST count as one path. On a case-insensitive volume, the state MUST also show for a listed name that equals `.gitignore` except for case. It MUST also show for every other case that the plan finds without an exact method. The preview MUST never show an approximate list.
- **FR-040**: The preview MUST show a notice for each subfolder `.gitignore` that Git does not read. This covers a link and a file inside an ignored folder.
- **FR-041**: The preview MUST update after a pause of the plan length after the last edit. A new update MUST cancel the preview that runs. The editor MUST show "Updating preview…" while a preview runs. Save MUST stay available while the preview runs or is not available. Each preview MUST remove its temporary files after it ends, also after Cancel. The next preview MUST remove the temporary files that a crash left, on Windows and inside the WSL distro.
- **FR-042**: Save MUST compare the file on disk with the bytes that the editor loaded. A difference MUST refuse the save and ask for a reload. Save MUST replace the whole file in one atomic step, without following a link. When the loaded file holds no line ending, Save MUST use LF. This covers an absent file, an empty file, and a file of one line. Then the status MUST be read again.
- **FR-043**: The ignore editor MUST work for a WSL repository. The file bytes MUST come from inside the distro, at most 1 MiB, never through a `\\wsl.localhost` read. The preview MUST run inside the distro. The unsaved text MUST cross into the distro for the preview and the save. The preview path lists MUST cross into the distro on the preview input.
- **FR-044**: Close with unsaved text MUST open the modal "Discard changes to <file>?" with "Discard" and "Keep editing". The <file> is ".gitignore" or "info/exclude". With unsaved text, a row action for the same file MUST add its line to the current text. It MUST then select that line. A row action for the other file MUST first open the same modal. Open submodule, Open parent repository, and Open repository MUST also first open it.
- **FR-045**: The editor text MUST be untrusted content. The application MUST show it as plain text and never interpret it as markup.
- **FR-046**: Save MUST count as a mutation for feature 001 FR-015. Save changes no Git state. So Save MUST also run during an unfinished operation, such as a merge or a rebase, and with conflicts. The 004 ignore action also ran then. Delete stays blocked then (FR-033). The stale check of FR-042 MUST still apply.

#### Open submodule

- **FR-047**: In the Submodules group, Enter and a double-click on a row MUST open the submodule in the same window. The row menu MUST offer "Open submodule". The row menu of a submodule row in the Commit view Changes list MUST also offer "Open submodule". Both places MUST use the same checks (FR-048, FR-049) and the same reasons.
- **FR-048**: Open submodule MUST be unavailable for a submodule that is not initialized or whose folder is missing. Its reason MUST be "Initialize this submodule first. Select Update submodules." A nested submodule MUST open one level at a time. Its reason MUST be "Open <parent> first."
- **FR-049**: Before the open, the application MUST check three facts. The path MUST lie below the parent worktree. The index MUST hold exactly one gitlink entry at that path. The repository that Git discovers in that folder MUST be that folder. A failed check MUST refuse with a typed reason. A running operation in the parent MUST refuse the open as busy.
- **FR-050**: The submodule MUST get its own trust state. No trust MUST come from the parent. No repository program of the parent MUST run for the open.
- **FR-051**: The header MUST show a separate icon button "Open parent repository" before the repository button. Its label MUST be the parent folder name, and its tooltip and accessible name MUST give the full path. One click MUST open the parent through the recent-repository list. Each Open submodule MUST add a recent-repository entry for that submodule. So each level of a nested chain can go back. The chain MUST hold at most 8 levels. A parent without a recent entry MUST state "Open the parent repository with Open repository."
- **FR-052**: Open submodule MUST work for WSL repositories under the feature 001 WSL rules.

#### Blame

- **FR-053**: Blame MUST open from a file of the History diff, at that commit. A deleted row MUST blame the file at the chosen parent. Blame MUST also open from a tracked row of the Commit view, at HEAD. For an untracked file, a new file, and an unborn HEAD, Blame MUST be unavailable. Its reason MUST be "Git has no history for this file."
- **FR-054**: The blame view MUST replace the History list in place, with the heading "Blame: <path> at <short ID>". From the History diff, Escape and Back MUST return to the History list. From the Commit view, Blame MUST first switch the window to History. Then Escape and Back MUST return to the Commit view with that row selected.
- **FR-055**: For each run of lines from one commit, the gutter MUST show the short ID, the author, and the relative date. The tooltip MUST show the full date. Age shading MUST use 7 ranked steps. Let c be the count of distinct author times of this file's commits. Let r be the 0-based rank of a commit's author time among them, oldest first. That commit MUST get step floor(7 × r / c) + 1. The shading MUST never use the current time. The date text MUST stay the cue, so forced colors still work. A line from a commit with another file name MUST state "Path in this commit: <name>" in the tooltip.
- **FR-056**: The lines MUST form one list with roving focus. Enter or a click MUST select the line's commit in History. Alt+Left MUST run "Blame before this commit" at the matching line. The match MUST start from the line number in the line's commit, from Git's blame output. It MUST use the exact hunk headers of Git's zero-context diff between the previous version and that version. A line inside a changed hunk MUST map to that hunk's old start. When the old count is 0, it MUST map to the old start plus 1. Every other line MUST move by the sum of (old count − new count) of the hunks before it. A line without a previous commit in Git's blame output MUST make Alt+Left unavailable. Its reason MUST be "Git names no earlier version of this line."
- **FR-057**: The toolbar MUST offer "Ignore whitespace", "Detect moved lines", and "Detect lines from other files", all off at start. Each MUST map to the Git blame option of the same meaning.
- **FR-058**: Every attribution MUST equal Git's own blame with the same options. The sum of all runs MUST equal the line count of the file. Otherwise the result MUST refuse with a typed error.
- **FR-059**: The ignore list MUST be the effective `blame.ignoreRevsFile` list. Git allows several values in every configuration scope. Every non-empty value MUST count, as in Git. An empty configuration value MUST NOT reset the list. "Skip commits in the ignore list" MUST show only when that effective list is not empty. It MUST start on. Turning it off MUST run that one blame without an ignore list. Git then clears all lists through the command-line value `--ignore-revs-file=`. With the list on, ignored lines MUST show "?" and unblamable lines "*". These marks MUST come from Git's own markers.
- **FR-060**: Before Git starts, the service MUST check each relative path of the effective list. The path resolves from the worktree root, where Git runs. A missing file MUST refuse with "Git cannot run blame. The file <path> that blame.ignoreRevsFile names does not exist." Other path forms MUST pass to Git unchanged. When Git then fails, Blame MUST refuse with a typed Git failure and the output tail. Git reads the configured files also when the toggle is off. So the check and the refusal MUST apply in both toggle states.
- **FR-061**: Blame MUST refuse a binary file with "Arbareto does not blame a binary file." It MUST refuse a submodule path with "This path is a submodule. Open the submodule to blame its files." It MUST refuse a file above 4 MiB and a file above 100,000 lines, with the limit. The binary fact MUST come from Git's numstat output.
- **FR-062**: A boundary commit that the shallow list names MUST state "Earlier history is not in this clone."
- **FR-063**: Without an ignore list, Blame MUST show progress with the blamed and total line counts. The progress MUST update at most 4 times per second. With an ignore list, Blame MUST show "Blaming…" without counts. Blame MUST always offer Cancel. Cancel MUST end the Git process tree under feature 001 FR-045.

#### Branch card and gone mark

- **FR-064**: A local branch MUST show the gone mark exactly when two facts hold. The reference read names an upstream for it, and the same read shows no reference of that name. Git names no upstream for a branch whose remote was removed. Such a branch MUST show no mark, and the card MUST state "No upstream". The mark MUST be an icon whose shape is the cue. Its tooltip MUST be "The upstream <name> no longer exists." The accessible name MUST hold ", upstream gone". A branch without an upstream MUST show no mark. The mark MUST show in the sidebar, the branch list, and the card.
- **FR-065**: A cut branch name MUST show a card on pointer hover and on keyboard focus. This applies to the sidebar branch and remote rows, the branch list rows, and the branch button. The branch list is the list that the branch button opens (004 FR-009). "Cut" MUST be a layout fact: the content is wider than the visible box. The application MUST read this fact at hover or focus time. A name that fits MUST NOT show the card.
- **FR-066**: The card of a local branch MUST show the full name. It MUST show "Upstream: <name>" or "No upstream". With a present upstream, it MUST also show "<a> ahead, <b> behind" or "Up to date". These counts MUST come from the feature 003 tracking read. When FR-064 applies, the card MUST show "Upstream gone: <name> no longer exists" in place of the counts. It MUST show "Checked out in <worktree path>" when another worktree holds the branch. The card of a remote row MUST show only the full name. Escape MUST close the card. The accessible name of the row MUST stay unchanged. The card MUST need no new Git read.

#### Visible controls and keyboard

- **FR-067**: Every new control MUST follow 004 FR-085 and 004 FR-087. It MUST have an icon or a label, a tooltip with its shortcut, and an accessible name. It MUST show visible focus and a stated reason when unavailable. Single-key shortcuts MUST act only while their region has focus. Destructive items MUST stay apart from routine items.
- **FR-068**: The History file list, the blame lines, and the preview lists MUST create elements only for rows near the visible area. This follows 002 FR-055.

### Key Entities *(include if feature involves data)*

- **Commit changes**: One commit, the chosen parent, and the list of changed files with status, paths, modes, and object IDs. It belongs to one history view.
- **Delete review**: The paths, the mode (recycle or permanent), the file facts of each path at review, and the expiry time.
- **Delete result**: The observed outcome of each path and the removed folders.
- **Ignore file**: The target (root `.gitignore` or `info/exclude`), its bytes and digest at load, its line-ending form, and its BOM.
- **Ignore preview**: The newly ignored files, the no longer ignored files, the count of newly matched tracked files, notices, or a typed reason why no preview exists.
- **Submodule chain**: The stack of parent repositories, at most 8 levels, each with its recent-repository entry.
- **Blame result**: The file content at the commit, the runs of lines with their commits, and per commit the author, time, summary, previous commit and path, file name, and boundary state.
- **Branch tracking facts**: The full name, the upstream, whether the upstream reference exists, the ahead and behind counts, and the worktree that holds the branch.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On the 1,000-file commit fixture, the changed-file list equals Git's own two-tree comparison exactly. The list shows within 300 ms after the selection, and the first diff within 150 ms more. A move to the next file shows its diff within 150 ms (warm packaged build, median of 10 runs).
- **SC-002**: On the 100,001-file commit fixture, the list shows exactly the first files up to the bound and the limit text. The process tree uses at most 64 MiB more memory than before the selection.
- **SC-003**: In every Delete fixture, the listed paths are absent, all other working-file bytes and the index digest are unchanged, and each recycled item is in the Recycle Bin. In the stale fixture and in the fixtures that swap a folder on the path for a link or a junction, nothing outside the reviewed paths changes. No fixture claims to cover a change during a path-based step (known limit of FR-031). Each Recycle Bin test purges the items that it moved and changes no other Recycle Bin item.
- **SC-004**: Every shown tree equals the reference sort of FR-015, in all fixtures, including names that are not valid UTF-8.
- **SC-005**: In every ignore fixture, the preview equals the change of the ignored set that Git lists after a real save of the same text on a copy. No fixture shows an approximate preview. On Windows, a preview of 100,000 paths shows within 5 s (warm packaged build, median of 10 runs).
- **SC-006**: Every blame attribution equals Git's own blame with the same options, for every line of every fixture. On a 10,000-line file with 5,000 commits and no ignore list, the first progress shows within 500 ms. Cancel ends Git within 1 second, with and without an ignore list.
- **SC-007**: Open submodule and Open parent repository each take at most the time of a normal open of that repository. No repository program of the parent runs before its approval in any fixture.
- **SC-008**: The branch card shows for every cut name and for no name that fits. The gone mark shows exactly for the branches of the FR-064 rule.
- **SC-009**: During every read and action of this feature, the window keeps the feature 001 SC-005 targets: 95% of inputs show a response within 100 ms, and every input within 500 ms.
- **SC-010**: Keyboard-only users complete each P1 story and the ignore editor story. Each new control has an accessible name, visible focus, and a contrast of at least 4.5:1.
- **SC-011**: A review of the requirement-to-test map finds no outcome that Git message text, timing, or a name pattern decides.

## Assumptions

- Delete in a folder covers the rows that Filter files hides, as Stage folder does (004 FR-101). The confirmation counts them all. This is a reviewer default.
- A tracked file with staged and unstaged changes keeps its staged version in the index after Delete. This follows FR-032.
- The ignore editor edits the root `.gitignore` and `info/exclude` only, as Git Extensions does. Subfolder `.gitignore` files still count in the preview.
- Blame opens at HEAD from the Commit view. Uncommitted lines are not blamed, because a working-tree blame runs the clean filter.
- "Blame before this commit" starts from the line's previous commit and path, as Git's own blame output names them.
- The upstream-gone rule of FR-064 agrees with the feature 003 tracking state `gone`. Both come from the same reference read.
- The mockup of this feature comes first, through the arbareto-ux skill, before the frontend work.
- These are reviewer defaults of the clarify pass of 2026-10-21. The "Tracked files stay tracked." count holds only newly matched tracked files (FR-038). A deleted History row blames the file at the chosen parent (FR-053). The card of a remote row shows only the full name (FR-066). The conflicted-row reason text is new (FR-021).

## Design notes for planning

These notes come from the feature design of 2026-10-21 and the ignore preview report of 2026-10-21. The plan decides the final form.

- History list: `diff-tree -r -z --raw -M -l1000 <parent> <commit>` with `--no-lazy-fetch --no-optional-locks --literal-pathspecs`. `diff-tree <merge>` alone prints nothing. A root commit uses the empty tree of the object format. A history row without parents is `root` or `shallow`. Patch and numstat reuse the 001 comparison options with `-M -l1000` and the path pair.
- Bounds: list 100,000 records and 32 MiB, encoded result 8 MiB, patch 4 MiB and 20,000 lines, read deadline 30 s.
- Tree order: one shared comparator module with a unit test.
- Folder reveal: `revealPath` gets an optional `folder`. The shell walk already accepts a folder.
- Delete, Windows: a new shell request walks with `OBJ_DONT_REPARSE` and holds each folder handle without delete share. Permanent delete uses `FileDispositionInfoEx` with POSIX semantics on the checked handle. Recycle uses `IFileOperation` with a `PreDeleteItem` identity check and a `PostDeleteItem` result (`psiNewlyCreated` non-null means recycled). `SHFileOperationW` gives no per-item result and is rejected. Unverified: `FOF_WANTNUKEWARNING` with `FOF_NOCONFIRMATION` on a volume without a Recycle Bin. Recycle Bin tests must restore or purge their own items.
- Delete, Windows target open: a link to a folder is a directory reparse point, and Windows removes it as a directory. So the target open of a link must not use `FILE_NON_DIRECTORY_FILE`, or the open fails (US2 scenario 6).
- Delete, WSL: a new `wslFiles` mode `remove` with `lstat`, `unlink`, and `rmdir`.
- Delete gaps: the Recycle Bin call takes a path, so a swap of the last component between the check and the move stays possible. The WSL `remove` mode also acts by path after its `lstat` check. Files above 1 MiB bind only size and last-write time.
- Ignore read: `readIgnoreFile` reuses the 004 target and fact rules. WSL uses `fileFacts` with `content: true`, at most 1 MiB (recommendation Q1).
- Ignore save: `fileReplace` writes a temporary file in the same folder and renames it over the target with `FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS`. WSL uses `O_CREAT|O_EXCL|O_NOFOLLOW`, `fsync`, and `rename(2)`. `fileAppend` goes. The 004 append also writes LF (`ignore.ts:162`). Git drops a CR before an LF (`ignore.ts:84`).
- Ignore preview: a throwaway shadow repository holds only the ignore files and the unsaved text. `git check-ignore --no-index -z --stdin -v -n` runs there on the real untracked and tracked path lists, with the real `core.ignorecase` and `core.excludesFile`. Gitlinks and skip-worktree `.gitignore` blobs go into the shadow. A self-check with the saved text must equal `ls-files -o -i --exclude-standard -z` and `ls-files -c -i --exclude-standard -z`. `--exclude-from` substitution is wrong for a `.gitignore` edit. Typed limits: path count above the bound, a case-only `.gitignore` name clash, long paths with `core.longpaths` false (unverified), a failed byte check, a failed self-check. Paths that start with `:` get a `./` prefix. Open item: the WSL shadow folder needs a `wslFiles` remove step. The report measured 4.1 to 5.0 s for `check-ignore` on 100,000 paths on Windows. A folder that both texts ignore counts as one path, because Git reads nothing below it (`dir.c:1726-1740`).
- Index loads (F1): `diff-tree` loads the index (`builtin/diff-tree.c:133`), and so do `ls-files` and `ls-files --stage`. An index load runs `tweak_fsmonitor` (`read-cache.c:1967`). Blame of a commit loads the index only for the working tree (`blame.c:205`, `blame.c:290`). Unverified: whether the `diff -U0` read of "Blame before" loads the index.
- Open submodule: a native-first `openSubmodule` reuses the `openWorktree` shell step. `rev-parse --show-superproject-working-tree` is rejected, because it runs `ls-files` in the parent before trust. Unverified: whether an `openWorktree` registration adds a recent-repository entry, which FR-051 needs.
- Blame: always `--no-textconv`, because blame turns textconv on by default (`builtin/blame.c:1001`). `--incremental` without an ignore list. With one, `--porcelain` with `blame.markIgnoredLines` and `blame.markUnblamableLines`, because incremental output prints no markers. Porcelain output prints only after the whole blame ends, so it gives no progress counts. A missing ignore-revs file exits 128, and no command-line form turns it off, so the service checks the file first. `blame.ignoreRevsFile` can repeat, and Git uses every non-empty value. An empty configuration value resets nothing (`builtin/blame.c:771`, `:941-947`; F7), although `config/blame.adoc:24-28` says otherwise. "Blame before" maps lines from `diff -U0` hunk headers. Deadline 120 s, output bound 32 MiB, result 12 MiB.
- Branch card: shadcn `hover-card` at the version that tasks.md pins. `BranchEntry` gets `upstreamPresent` from the same `for-each-ref` read.
- Removed remote (F2): Git finds no fetch refspec for a missing remote (`remote.c:1796-1801`). `branch_get_upstream` then returns NULL (`remote.c:1908`), so `%(upstream)` is empty.

## Research inputs

These facts come from the Git Extensions source, read on 2026-10-21. They describe Git Extensions, not Arbareto. Git Extensions is GPL-3.0, so Arbareto takes ideas only.

- FormAddToGitIgnore offers "Add file(s) to .gitignore" and "… to .git/info/exclude". A pattern box starts with `/<path>` or `/<folder>/`. The preview counts the matching files after a 300 ms pause from the unsaved patterns only. It ignores the existing ignore sources and their precedence. Save appends.
- FormGitIgnore edits the whole `.gitignore` or `info/exclude`, with default templates. It has no preview, asks "Save changes?" on close, and overwrites a file that changed on disk.
- Delete file acts on working-tree and index rows and untracked folders. It asks "Are you sure you want to delete the selected file(s)?", deletes permanently, skips submodules, and unstages index entries first.
- Show in folder runs `explorer.exe /select,<file>`. For a folder, it opens the parent.
- File trees sort folders first with an invariant-culture comparison.
