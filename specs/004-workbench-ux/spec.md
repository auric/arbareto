# Feature Specification: Workbench UX

**Feature Branch**: `004-workbench-ux`

**Feature Directory**: `specs/004-workbench-ux`

**Created**: 2026-10-16

**Status**: Draft

**Input**: User description: "Workbench UX after Git Extensions, but better. A branch button with search, double-click checkout with a confirmation, and a choice for local changes. A branch context menu with merge and rebase panels. A large commit workspace with untracked handling, visible stage buttons, hunk and line staging, multi-select, and a 72-column guide. Worktrees, a Git settings view by scope, a calmer trust prompt, and a one-click submodule update. Spell check of the commit message later."

## Clarifications

### Session 2026-10-16

The user accepted every recommended default: "I'm good with your recommendations, I may ask for change later."

- Q: Do trust prompts stay, or go away as in Git Extensions? → A: They stay, as option (d). The application asks only when an action would run a repository program, in one native dialog with the details collapsed, and a status chip shows the state (FR-069 to FR-073). Constitution principle V stays unchanged.
- Q: What does a trust approval bind to, and does it survive edits of hook scripts? → A: It binds to the repository folder, the worktree folder, the selected Git installation, and the trust policy version (FR-071). Edits and additions of hook scripts and program files do not ask again. The per-file program digests of feature 001 go away.
- Q: Does a switch need a confirmation when nothing would change? → A: A double-click in the references sidebar always confirms. A pick in the branch list on a clean working tree switches at once (FR-009).
- Q: Does the local-changes choice offer "Don't ask again"? → A: No. The choice shows whenever tracked changes exist. Settings sets the preselected choice, and Discard changes can never be the default (FR-010).
- Q: Where does "No upstream" show? → A: Only in the branch list and in the accessible names, not as visible text in the references sidebar (FR-008).
- Q: Which keyboard shortcuts do the branch actions and the remote operations use? → A: The Git Extensions defaults: Fetch Ctrl+Shift+Down, Pull Ctrl+Shift+P, Push Ctrl+Shift+Up, and the branch menu keys of the mockup (FR-014). The plan checks each key against the feature 001 shortcut map for conflicts. (Corrected below: Pull Ctrl+Down and Push Ctrl+Up.)
- Q: Is the commit workspace a full view or a large docked panel? → A: A full view that the user switches to from History (FR-033).
- Q: Does a submodule that fetches from a new host wait for the user? → A: Yes. The update waits for one "Update anyway" click (FR-079).
- Q: Does Git settings open inside the main window or in its own window? → A: As a full view inside the main window, with Close (FR-068).
- Q: Does this feature resolve conflicted files, although feature 003 deferred the resolve panel and merge tools to branch operations? → A: Yes, as P2. A simple resolve view offers Choose ours, Choose theirs, Open in merge tool, and the 003 Mark resolved (User Story 9, FR-089 to FR-097). The merge tool comes from `merge.tool` and `mergetool.<tool>.cmd`, and it runs through `git mergetool --tool=<tool>`. A merge tool from local or worktree scope is repository-controlled and needs trust.

Plan-driven corrections (plan O-1 to O-4, O-9, O-12, O-15, O-16, and an orchestrator decision from the approved Commit board):

- The branch action is "Switch", not "Checkout": menu item "Switch (Ctrl+.)", confirmation "Switch to <branch>?", and button "Switch" (design standard D-S1, FR-014). "Check out the commit only" stays for a detached HEAD.
- The Git Extensions source defaults are Pull Ctrl+Down and Push Ctrl+Up, not Ctrl+Shift+P and Ctrl+Shift+Up. The feature 003 toolbar keys equal the source and stay: Fetch Ctrl+Shift+Down, Pull Ctrl+Down, and Push Ctrl+Up (FR-014).
- Choose ours, Choose theirs, and Open in merge tool also run during a merge or a rebase (001 FR-016 change).
- Git deletes the reflog of the branch together with the branch. The delete confirmation states recovery only through HEAD's reflog, from Git's reflog read (FR-018).
- The force-push note shows only when the tracking ref of the push destination holds rewritten commits (FR-024).
- Feature 001 has no mode shortcuts, so the view switch has no key (FR-033).
- Line staging also refuses a hunk of a deleted file (`deleted-file`) and a part of a hunk that holds Git's "No newline at end of file" marker (`eof-newline`) (FR-044).
- SC-009 accepts the `branch.<name>` section writes of Git's own branch create, rename, and delete.
- The commit workspace offers "Amend last commit" as P2 (User Story 11, FR-098 to FR-100). Amend leaves the Scope Boundaries exclusions.

### Session 2026-10-19

- Q: Does feature 004 deliver the commit message spell check? → A: No. The user postponed it on 2026-10-19. User Story 10, FR-083, FR-084, and SC-012 move to a later feature. Feature 004 keeps their text as the input for that feature.

## User Scenarios & Testing *(mandatory)*

Feature 001 shows a read-only references sidebar and a docked commit panel. Feature 002 shows the full history of all branches. Feature 003 adds Fetch, Pull, Push, Clone, and the conflict actions Abort, Continue, Skip, and Mark resolved. This feature adds the daily branch and commit work around them: switch branches, run branch actions, merge, rebase, commit with fine staging, resolve conflicted files, and manage worktrees. It also edits Git settings, makes trust prompts calmer, and makes the submodule update a single click. Git Extensions is the reference for the functions. The design follows the mockup boards of 2026-10-16.

### User Story 1 - Switch to another branch (Priority: P1)

A developer selects the branch button in the toolbar, types part of a branch name, and switches to it. A double-click on a branch in the references sidebar does the same after a confirmation. When local changes exist, the developer chooses what happens to them.

**Why this priority**: The toolbar branch label does nothing today. Switching branches is the most frequent branch action, and every other branch action needs it.

**Independent Test**: In disposable repositories, switch between local branches, from a remote branch, and from a detached HEAD, with and without local changes. Compare HEAD, the index, and every working-file byte with Git's own commands run by hand on a copy.

**Acceptance Scenarios**:

1. **Given** a repository with several local and remote branches. **When** I select the branch button and type "log". **Then** the list shows only the branches whose names contain "log", local branches first.
2. **Given** the branch list. **When** I select a local branch with no local changes. **Then** the application switches to it, and the toolbar, the sidebar, and the history show the new current branch.
3. **Given** the references sidebar. **When** I double-click a local branch. **Then** a confirmation "Switch to <branch>?" opens next to the row, with Cancel focused first.
4. **Given** 4 uncommitted changes. **When** I start a switch. **Then** the confirmation states the count and offers Keep changes, Stash and reapply, and Discard changes, with the default preselected.
5. **Given** Keep changes and a local change that conflicts with the target branch. **When** I select Switch. **Then** Git refuses, the branch stays, and every working-file byte and index entry stays unchanged.
6. **Given** Stash and reapply. **When** the reapply conflicts. **Then** the switch stays done, the conflicted files show in the Conflicted list, and the stash entry stays with its commit ID shown.
7. **Given** Discard changes. **When** I confirm with "Discard and switch". **Then** Git removes the changes to tracked files, untracked files stay, and the target branch is current.
8. **Given** a remote branch without a local branch. **When** I select it. **Then** the panel offers a new local branch that tracks it, with the name from the remote's fetch rule, or a detached checkout of the commit.
9. **Given** a branch that another worktree holds. **When** I select it. **Then** the list offers "Open <worktree>" instead of a switch.

---

### User Story 2 - Act on a branch from its context menu (Priority: P1)

A developer right-clicks a branch in the references sidebar or in the history and runs Switch, Merge into current branch, Rebase current branch onto, Create branch here, Rename, Delete, or Copy branch name.

**Why this priority**: The sidebar has no branch actions today. Git Extensions users expect this menu for daily work.

**Independent Test**: In disposable repositories, run each item on merged, unmerged, current, and other-worktree branches. Compare the references with Git's own commands. Check that an unmerged branch always gets the warning and a merged branch never gets it.

**Acceptance Scenarios**:

1. **Given** a local branch. **When** I open its context menu. **Then** it shows Switch, Merge into current branch (<current>)…, Rebase current branch (<current>) onto <branch>…, Create branch here…, Rename…, Delete…, Push, and Copy branch name, each with its shortcut.
2. **Given** the current branch. **When** I open its context menu. **Then** the items that cannot run stay focusable and state their reason.
3. **Given** a branch with 2 commits that no other branch, tag, or remote-tracking branch holds. **When** I select Delete. **Then** the confirmation states "<branch> has 2 commits that no other branch has. Deleting the branch loses them." Cancel has the first focus.
4. **Given** a branch that the current branch contains. **When** I select Delete. **Then** the confirmation states that the delete loses no commits.
5. **Given** a new name that Git does not accept as a branch name. **When** I rename or create a branch. **Then** the field states the refusal, and no reference changes.
6. **Given** any branch. **When** I select Copy branch name. **Then** the clipboard holds the short branch name.

---

### User Story 3 - Merge or rebase with clear options (Priority: P1)

A developer merges a branch into the current branch, or rebases the current branch onto another branch, from a docked panel. The panel states what will happen before the start. Conflicts use the feature 003 actions.

**Why this priority**: Merge and rebase are core Git work. Without them the user needs a terminal.

**Independent Test**: In disposable fixtures, run each option and each combination that the panel allows. Compare HEAD, the references, the index, the working files, and the operation state with Git's own commands. In conflict fixtures, finish with Abort, Continue, Skip, and Mark resolved from feature 003.

**Acceptance Scenarios**:

1. **Given** the Merge panel for feature/login. **When** it opens. **Then** it states how many commits each side lacks and whether fast-forward is possible.
2. **Given** the Merge panel. **When** I select Squash, No fast-forward, or Don't commit. **Then** the merge result equals Git's own merge with the same option.
3. **Given** the Rebase panel. **When** it opens. **Then** it states how many commits the rebase moves, and how many of them a remote-tracking branch already holds.
4. **Given** a rebase that rewrites a commit that the tracking ref of the push destination holds. **When** the panel opens. **Then** it states that the next push needs Force push with lease. A rewritten commit that only another remote-tracking branch holds shows in the held count and gives no note.
5. **Given** a merge or a rebase that stops with conflicts. **When** it stops. **Then** the notice band shows the feature 003 conflict notice with Abort, Continue, and Skip where they apply.

---

### User Story 4 - Commit with fine and fast staging (Priority: P1)

A developer opens a large commit workspace. Many untracked files sit in their own collapsed section. The developer stages a file with a visible button, stages a folder, stages a hunk or selected lines, and writes a message with a 72-column guide.

**Why this priority**: The user reported the commit panel as unusable with many untracked files. Hunk staging and whole-file staging have no visible buttons today.

**Independent Test**: In disposable fixtures with up to 100,000 untracked files, stage files, folders, a multi-selection, hunks, and lines. Check the exact index contents and unchanged working-file bytes after each action. Measure the response targets of feature 001 SC-005.

**Acceptance Scenarios**:

1. **Given** 1,248 untracked files and 10 modified files. **When** the workspace opens. **Then** the modified files show first, and the Untracked section shows its count and starts collapsed.
2. **Given** the tree layout. **When** I right-click an untracked folder. **Then** the menu offers Stage folder, Add to .gitignore, Add to info/exclude, Copy path, and Show in Explorer.
3. **Given** a file row with pointer hover or keyboard focus. **When** I select its stage button or press Space. **Then** only that file is staged, and focus moves to the next row.
4. **Given** three selected files. **When** I select "Stage selected (3)". **Then** all three are staged in one index update, or none is staged and the reason shows.
5. **Given** a diff with three hunks. **When** I select "Stage hunk" on the second hunk. **Then** only that hunk is staged, as in feature 001.
6. **Given** a selection of three changed lines in the diff. **When** I select "Stage 3 lines" or press S while the diff has focus. **Then** only those lines are staged, and the working file stays unchanged.
7. **Given** a summary line of 80 characters. **When** I type it. **Then** the counter shows 80/72, and a guide marks column 72. The commit stays possible.
8. **Given** "Add to .gitignore" on the folder logs. **When** I confirm. **Then** the application adds the line "/logs/" to the root `.gitignore`, and the folder leaves the Untracked section.
9. **Given** the text "login" in Filter files. **When** I select "Stage all changes". **Then** the lists show only the files whose path holds "login", and Stage all changes stages every change, also the hidden ones.

---

### User Story 5 - Work in several worktrees (Priority: P2)

A developer opens the worktree button in the toolbar, sees every worktree of the repository, opens one, adds a new one for a branch, or removes one. The remove can delete its branch too.

**Why this priority**: Worktrees replace stash juggling for parallel work. The feature is valuable, but branch and commit work come first.

**Independent Test**: In disposable repositories with linked worktrees, add, open, remove, and prune worktrees. Compare `git worktree list` output and the references with Git's own commands. Check that uncommitted changes never disappear without the explicit check box.

**Acceptance Scenarios**:

1. **Given** a repository with three worktrees. **When** I open the worktree button. **Then** it lists each worktree with its folder, branch, and state, and marks the current and the main worktree.
2. **Given** another worktree. **When** I select Open. **Then** the window shows that worktree.
3. **Given** Add worktree with a new branch. **When** I confirm. **Then** Git creates the folder and the branch from the selected commit.
4. **Given** a worktree with uncommitted changes. **When** I select Remove. **Then** the confirmation states the counts, and Remove stays unavailable until I check "Delete my uncommitted changes too".
5. **Given** Remove with "Also delete the branch" on an unmerged branch. **When** the confirmation opens. **Then** it states how many commits the branch delete loses.
6. **Given** a worktree folder that someone deleted. **When** I select Prune missing worktrees. **Then** Git removes its record, and the list no longer shows it.

---

### User Story 6 - Edit Git settings by scope (Priority: P2)

A developer opens Git settings, sees each value with its scope and source file, and changes a value in this repository or in the global settings.

**Why this priority**: Git Extensions users edit identity, tools, line endings, and pull behavior there. Without it they need a terminal. It is less frequent than branch work.

**Independent Test**: With disposable configuration files, change each listed key in each writable scope. Check that only that key changes in only that file, and that every other byte stays the same.

**Acceptance Scenarios**:

1. **Given** the Effective scope. **When** I read a value. **Then** it shows the value and the file that sets it, and its control is read-only.
2. **Given** the scope This repository. **When** I change fetch.prune to On and select Save. **Then** Git writes only that key into the repository configuration file.
3. **Given** a boolean key that this scope does not set. **When** I read it. **Then** it shows "Not set" and the effective value with its scope.
4. **Given** pending changes. **When** I select Cancel. **Then** no file changes.
5. **Given** the page Pull and push. **When** I read it. **Then** it shows the Pull button default action of feature 003, marked as an Arbareto setting that is not in Git configuration.

---

### User Story 7 - Trust a repository once, only when needed (Priority: P2)

A developer opens a repository with its own hooks. Arbareto asks nothing until an action would run a repository program. Then one native dialog asks once, with the details collapsed. A status chip shows the trust state.

**Why this priority**: The user found the trust dialogs scary and hard to understand. The current flow asks twice and shows raw configuration lines and a fingerprint.

**Independent Test**: In fixtures with and without repository programs, run reads, staging, commit, and the feature 003 operations. Count the prompts, and check that no repository program runs before approval.

**Acceptance Scenarios**:

1. **Given** a repository without repository programs. **When** I use it for a full session. **Then** no trust prompt shows, and no trust chip shows.
2. **Given** a repository with a pre-commit hook. **When** I select Commit the first time. **Then** one native dialog asks "Do you trust this repository?", with Not now as the default button.
3. **Given** that dialog. **When** I select Show details. **Then** it lists the folder, the hooks, and the filters by name.
4. **Given** Not now. **When** I look at the commit area. **Then** it states "Commit needs trust. Select Not trusted in the status bar to trust this repository.", and Commit is unavailable.
5. **Given** a trusted repository. **When** I select Stop trusting this repository in the chip menu. **Then** Git runs no repository program until I trust it again.

---

### User Story 8 - Update submodules with one click (Priority: P2)

A developer selects Update submodules. The update starts at once. Each submodule shows its progress inline in the Submodules group. A failed submodule offers Retry.

**Why this priority**: The user found the review dialog and its selection over-engineered. The update is rare but must be fast to start.

**Independent Test**: In submodule fixtures of feature 001, run the update with one click. Check that no dialog opens when no safety fact applies, that the results equal feature 001, and that each FR-049 refusal still refuses.

**Acceptance Scenarios**:

1. **Given** five submodules and no safety fact. **When** I select Update submodules. **Then** the update starts without a dialog, and each submodule row shows Waiting, Fetching with a percentage, Done, or Failed.
2. **Given** a failed submodule. **When** the update ends. **Then** its row shows the reason, the Git exit code, Retry, and Show output. The other submodules show Done.
3. **Given** a submodule that fetches from a host that the repository settings do not name. **When** I select Update submodules. **Then** one line in the Submodules group states both hosts before Git starts, and the update waits until I select Update anyway.
4. **Given** a submodule with hooks. **When** the update would run them. **Then** the native Run confirmation of FR-050 opens first.
5. **Given** one submodule row. **When** I select Update in its context menu. **Then** only that submodule and its nested submodules update.

---

### User Story 9 - Resolve a conflicted file (Priority: P2)

A merge or a rebase stops with conflicts. The developer selects a conflicted file and takes one side, or opens the file in the configured merge tool. Then the developer marks the file resolved with the feature 003 action.

**Why this priority**: Feature 003 offers only Mark resolved, so the user edits each conflicted file in another program. Git Extensions offers both sides and the merge tool next to the file. Merge and rebase come first.

**Independent Test**: In conflict fixtures for merge and rebase, run Choose ours, Choose theirs, and Open in merge tool with a fixture merge tool. Compare the working files and the index with Git's own `git checkout --ours`, `git checkout --theirs`, and `git mergetool` on a copy. Check that no repository-controlled merge tool runs before approval.

**Acceptance Scenarios**:

1. **Given** a merge of feature/login that stops with a conflict in app.ts. **When** I select app.ts in the Conflicted list. **Then** the resolve view names both sides, "main" and "feature/login", and the conflict kind "Both modified".
2. **Given** the resolve view. **When** I select Choose theirs and confirm. **Then** app.ts holds the feature/login version, and the file stays in the Conflicted list until I select Mark resolved.
3. **Given** `merge.tool` set to a tool in the global settings. **When** I select Open in merge tool. **Then** the tool opens for app.ts only. When the tool reports success, the file leaves the Conflicted list, because Git staged it.
4. **Given** no `merge.tool` value. **When** I open the resolve view. **Then** Open in merge tool is unavailable with the reason "Set a merge tool in Git settings".
5. **Given** a merge tool from the repository settings and an untrusted repository. **When** I select Open in merge tool. **Then** the FR-070 trust dialog opens before Git starts.
6. **Given** a conflict where one side deleted the file. **When** I open the resolve view. **Then** Open in merge tool and the choice of the deleted side are unavailable with the reason.

---

### User Story 10 - See spelling mistakes in the commit message (Priority: P3, moved to a later feature)

**Moved**: The user postponed this story on 2026-10-19 (Clarifications). A later feature delivers it. Feature 004 does not build it.

A developer writes a commit message. Misspelled English words get a wavy underline. The context menu offers suggestions.

**Why this priority**: It is a convenience. Git Extensions has it, and the user wants it later.

**Independent Test**: Type a fixture message with known misspellings. Check each mark and each suggestion, and check that no network connection starts.

**Acceptance Scenarios**:

1. **Given** the word "recieve" in the message. **When** I type it. **Then** it gets a wavy underline that does not depend on color alone.
2. **Given** a marked word. **When** I open its context menu. **Then** it offers suggestions, and a selection replaces the word.
3. **Given** a commit message with marked words. **When** I commit. **Then** the commit runs unchanged. Spell check never blocks a commit.

---

### User Story 11 - Amend the last commit (Priority: P2)

A developer checks "Amend last commit" in the commit workspace. The message of the last commit loads into the editor. Commit replaces the last commit with the staged changes and the edited message.

**Why this priority**: Git Extensions offers Amend next to Commit, and the approved Commit board shows it. Branch and commit work come first.

**Independent Test**: In disposable fixtures, amend with and without staged changes, on a branch whose upstream holds HEAD and on one whose upstream does not. Compare the tree, the parents, the message, and the references with Git's own `git commit --amend` on a copy.

**Acceptance Scenarios**:

1. **Given** a draft message and a HEAD commit "Add login form". **When** I check Amend last commit. **Then** the editor shows "Add login form". When I clear the box, the draft comes back.
2. **Given** Amend last commit and one staged file. **When** I select Commit. **Then** HEAD is a new commit with the parents of the earlier HEAD, the staged file, and the edited message.
3. **Given** a HEAD commit that origin/main already holds. **When** I select Commit with Amend last commit. **Then** a modal confirmation states that the amend rewrites a commit that origin/main has and that the next push needs Force push with lease. Cancel has the first focus.
4. **Given** a HEAD commit that the upstream does not hold, or no upstream. **When** I select Commit with Amend last commit. **Then** the amend runs without a confirmation.

---

### Edge Cases

- HEAD is detached at a commit that no reference holds. A switch makes that commit unreachable except through the reflog. The confirmation names the commit and states this.
- The target branch would overwrite an untracked file. Git refuses the switch. The branch, the index, and every working file stay unchanged, and the result names the refusal from a fresh read.
- Discard changes is selected, and the target branch would overwrite an untracked file. The switch refuses before Git starts and names the files. Untracked files never disappear.
- Stash and reapply finds nothing to stash. The switch runs as Keep changes and creates no stash.
- The checkout succeeds, but the reapply fails or conflicts. The stash stays, and the result names its commit ID. The conflicted paths show in the Conflicted list of feature 003.
- The checkout fails after the stash. The application does not reapply, the stash stays, and the result names its commit ID and Git's own command to reapply it.
- A remote branch name maps to no local name through the remote's fetch rule, or to several. The local name field starts empty, and the user types it.
- A local branch with the proposed name exists. Create and switch refuses and names the branch. It offers to switch to that branch.
- The branch to delete moves after the confirmation opened. The delete refuses, and a new confirmation states the new facts.
- The branch to delete is the current branch, or another worktree holds it. Delete is unavailable with the reason.
- A merge or a rebase is in progress. Switch, Merge, Rebase, and branch Delete are unavailable with the reason. The toolbar shows "Rebasing" or "Merging".
- A hook rejects the merge commit. The merge stays in progress as Git leaves it, and the feature 003 notice shows.
- The working tree has 100,000 untracked files. The Untracked section stays collapsed until the user opens it, and the window keeps its response targets.
- A line selection holds only context lines. "Stage lines" is unavailable with the reason.
- The diff changed after the line selection. Line staging refuses, as feature 001 hunk staging does, and asks for a refresh and a new selection.
- During a rebase, Git's "ours" is the branch that receives the commits, and "theirs" is the commit that the rebase applies. The resolve view names each side by its branch or commit, so the swap shows correctly.
- `merge.tool` names a tool that Git does not know, or the user closes the tool without a save. Git's mergetool stages nothing. The fresh index read shows the path as still conflicted.
- Git's mergetool leaves a backup file, such as `app.ts.orig`, when `mergetool.keepBackup` is on. The file shows in the Untracked section. The application does not delete it.
- `.gitignore` is a symbolic link, a folder, or not valid text. Add to .gitignore refuses and names the reason. It never follows the link.
- The ignore line already exists in the file. The application adds no second copy and states it.
- A worktree folder lies on a removable drive that is absent. Git reports it as prunable. Remove is unavailable, and Prune covers it.
- A worktree is locked. Remove and Prune skip it, and the row states the lock and its reason text as untrusted text.
- A configuration key has several values in one scope. Its control is read-only and lists the values.
- A configuration value comes from an included file. The view names that file. The key is read-only in that scope, and Save refuses it.
- The repository folder or the Git selection changes. Trust asks again before the next repository program runs.
- A WSL repository has hooks. The same trust rules apply through the distro's Git, as feature 001 FR-046 states.
- A submodule update is cancelled. Each row shows its observed state from a fresh read, as feature 001 FR-023 requires.
- Later feature (User Story 10): spell check has no dictionary for the message language. Only English words get marks. No mark is no proof of correct spelling.

## Requirements *(mandatory)*

### Scope Boundaries

Include a branch button with a searchable branch list, double-click switch with a confirmation, a local-changes choice, and remote-branch checkout with a new tracking branch. Include a branch context menu with Switch, Merge into current branch, Rebase current branch onto, Create branch here, Rename, Delete, and Copy branch name. Push in that menu comes from feature 003. Include docked Merge and Rebase panels with their options. Include a resolve view for a conflicted file with Choose ours, Choose theirs, Open in merge tool, and the 003 Mark resolved. Include a commit workspace with an Untracked section, a tree layout, folder staging, multi-select, Stage all untracked, ignore actions, visible stage buttons, visible hunk buttons, line staging, and a message editor with a 72-column guide. Include Amend last commit as P2.

Include a worktree button with a list, Open, Add, Remove, and Prune. Include a Git settings view by scope. Include the trust redesign: one native prompt, only when an action would run a repository program, and a status chip. Include the one-click submodule update with inline progress and a per-submodule Update and Retry. English spell check of the commit message moves to a later feature (Clarifications, 2026-10-19).

Exclude a merge editor inside the application, the resolve of several files in one action, and rerere management. Exclude interactive rebase, reset, cherry-pick, revert, tags, and stash management other than the stash of the switch choice. Exclude Commit and push (feature 003), discard of single files, hunks, or lines, and push of other branches. Exclude remote branch delete and remote management. Exclude the dubious-ownership dialog and its `safe.directory` command (feature 001 Clarifications, 2026-10-10). Exclude the commit message spell check (User Story 10). The later feature excludes dictionaries other than English, and every spell check that uses the network or AI.

Already built in other tasks, and not specified here: the current branch in bold in the sidebar, and the inline copy buttons in the commit details (feature 002 tasks T067 and T068). The static app frame is the feature 001 fix T380. This feature adds no requirement for it.

The no-heuristics rule applies to every requirement. Every decision comes from exact parses of machine-readable Git output, from Git exit codes that the Git documentation defines for that command, from OS facts, or from contract-defined values. Git message text never decides an outcome.

### Dependencies

- Feature 003 must ship first or together. This feature uses its conflict notice and its actions Abort, Continue, Skip, and Mark resolved (003 FR-030, FR-042 to FR-045, FR-052, FR-053). It uses Push (003 FR-014 to FR-016), the ahead and behind counts (003 FR-019 to FR-022), and the Pull default action (003 FR-055, FR-056).
- Feature 002 provides the history view, the references sidebar list, and the branch context menu item of 002 FR-049.

### Changes to earlier requirements

This feature changes these requirements for builds that include it. The earlier texts stay unchanged in their own specs.

- **001 Scope Boundaries**: Branch management, line-level staging, staging several files in one action, worktree creation and management, and reference actions move into this feature.
- **001 FR-003**: The Git settings view (FR-058 to FR-068) MAY write Git configuration, only at an explicit Save of the user, only into the selected scope. Add to .gitignore and Add to info/exclude MAY write those files at an explicit user action (FR-046).
- **001 FR-016**: A merge or a rebase that this feature starts follows the 003 change of 001 FR-016. Only Abort, Continue, Skip, Mark resolved, Choose ours, Choose theirs, Open in merge tool, Fetch, and Fetch all remotes run while it is in progress.
- **001 FR-025, FR-050 and contract §7 "Startup, trust, and environment"**: Trust follows FR-069 to FR-075 of this feature. One native prompt replaces the in-app Trust dialog and the second fingerprint box. The approval binding follows FR-071. The contract §7 "Program file digests" go away.
- **001 FR-027**: Discard changes in a switch (FR-010, FR-011), Choose ours and Choose theirs (FR-091), branch delete (FR-017 to FR-019), Rebase current branch onto (FR-024 to FR-027), worktree remove with changes (FR-055), and the amend of a commit that the upstream holds (FR-100) are allowed behind their confirmations. Reset, force push other than 003, and other history rewrites stay excluded.
- **001 FR-034**: The commit panel becomes the commit workspace of FR-029 to FR-033. The commit MAY run `--amend` (FR-098 to FR-100).
- **001 FR-038**: Stage file and Unstage file keep their checks. Folder staging, multi-select, Stage all untracked, and line staging extend them (FR-034 to FR-044).
- **001 FR-047 to FR-050, and contract §12 "Submodules"**: The review dialog and its explicit start go away. A per-submodule Update and Retry are allowed. FR-076 to FR-082 of this feature state the new rules. The FR-049 refusals and the FR-050 run confirmation stay.
- **001 FR-056**: The branch button, the worktree button, and Git settings become visible. Stash stays hidden as a control.
- **001 FR-057**: The references sidebar gets a branch context menu, the Worktrees group, and the Submodules group.
- **001 Clarifications, repository switcher**: The repository button shows the worktree folder name only. Its tooltip and its accessible name give the full path (plan.md D15 "Repository button"). The recent repositories list keeps the folder name and the path.
- **002 FR-005**: After an operation of this feature that the user started, the history and the sidebar refresh without the refs-changed notice. They keep the selected commit when the new references reach it, as 003 FR-013 states for fetch.
- **002 FR-049**: The branch context menu holds the items of FR-014. The item "Show only this branch's history" stays on the current branch.
- **003 Scope Boundaries and FR-045**: The branch operations, the Git configuration editor, the resolve panel, and merge tools that 003 excludes come into this feature (FR-089 to FR-097).
- **003 FR-020**: The references sidebar shows "No upstream" only in the accessible name of the row, not as visible text (FR-008). The branch list keeps the visible text.

### Functional Requirements

#### Common rules

- **FR-001**: Every mutation of this feature MUST count as a mutation for feature 001 FR-015, FR-016, FR-023, and FR-024. While one runs, another mutation of the same repository MUST be refused as busy.
- **FR-002**: Every outcome MUST come from a Git exit code that the Git documentation defines for that command, from Git's machine-readable output, or from a fresh read of repository state. The application MUST NOT classify any result by Git's message text.
- **FR-003**: After success, failure, or cancellation, the application MUST re-read HEAD, the affected references, the index, the worktree list, and the operation state. It MUST report the observed result.
- **FR-004**: Every reference name, path, and option value MUST pass to Git as a literal value after an end-of-options marker where Git supports one. A name that Git could read as an option MUST be refused with a reason.
- **FR-005**: Repository programs that an operation can run MUST follow the trust rules of FR-069 to FR-075. This covers the post-checkout, pre-merge-commit, commit, pre-rebase, and post-rewrite hooks.
- **FR-006**: Every operation of this feature MUST work for WSL repositories through the distro's Git, under the feature 001 WSL rules.

#### Branch switching

- **FR-007**: The toolbar MUST show a branch button with the current branch name and the 003 ahead and behind counts. For a detached HEAD, it MUST show "Detached at <short ID>". During a merge or a rebase, it MUST show "Merging" or "Rebasing", and the switch MUST be unavailable with the reason.
- **FR-008**: The branch button MUST open a list with a search field that has the first focus. The list MUST show the local branches, then the remote-tracking branches, from one machine-readable reference read. Typing MUST filter the names by a literal, case-insensitive match. Enter MUST pick the first match. The list MUST also offer New branch… and stay usable by keyboard alone. A local branch without an upstream MUST show "No upstream" in the list and in the accessible name of its list row and its sidebar row. The references sidebar MUST NOT show "No upstream" as visible text.
- **FR-009**: A double-click on a branch in the references sidebar MUST open the switch confirmation next to the row. A double-click MUST always open "Switch to <branch>?", also on a clean working tree. A pick in the branch list MUST switch at once when a fresh status read shows no tracked change and FR-013 states no unreachable commit. Otherwise the pick MUST open the same confirmation.
- **FR-010**: When a fresh status read shows tracked changes, the confirmation MUST state their count and offer three choices. "Keep changes" switches as Git's own checkout does, and Git refuses when a change conflicts. "Stash and reapply" stashes the tracked changes, switches, and then reapplies that stash. "Discard changes" removes the changes to tracked files and switches. The Settings view MUST set which choice is preselected. Discard changes MUST NOT be a default. The confirmation MUST NOT offer "Don't ask again". The choice MUST show whenever tracked changes exist. A switch to the current branch MUST be refused with the reason. On a branch without a first commit, Stash and reapply and Discard changes MUST be refused with the reason. Git can stash only after the first commit.
- **FR-011**: Discard changes MUST change the action button label to "Discard and switch". The confirmation MUST state "Delete changes to tracked files. Untracked files stay. You cannot undo this." Before Git starts, the application MUST compare the untracked paths with the target tree. When the target would overwrite an untracked file, the switch MUST refuse and name the files.
- **FR-012**: Stash and reapply MUST reapply exactly the stash commit that it created, by its commit ID, never by its list position. After a reapply with conflicts, the stash MUST stay, and the result MUST name its commit ID. After a failed checkout, the application MUST NOT reapply. A fresh index read, not Git's message, MUST decide whether conflicts exist.
- **FR-013**: A pick of a remote-tracking branch MUST open a panel. It MUST offer "Create local branch" with a name field that tracks the remote branch, and "Check out the commit only" with the detached-HEAD effect stated. The default name MUST come from the fetch refspecs of the remote that maps the remote-tracking reference. When no refspec or several refspecs map it, the field MUST start empty. "Create local branch" MUST be available only when the fetch refspecs of exactly one remote map the remote-tracking reference. Git's own tracking setup refuses every other case after it changes the working files. Otherwise "Create local branch" MUST be unavailable with the reason, and "Check out the commit only" stays available. The name field MUST refuse the name `@` (FR-015). A branch that another worktree holds MUST offer "Open <worktree>" instead of a switch. A switch to an existing branch named `@` MUST be refused with the reason before Git starts, because Git reads `@` as HEAD. A switch away from a detached commit that no other reference holds MUST name that commit and state that only the reflog keeps it.

#### Branch context menu and branch actions

- **FR-014**: A local branch in the references sidebar and in the history labels MUST have a context menu. The items are, in this order: Switch (Ctrl+.), Merge into current branch (<current>)… (Ctrl+M), Rebase current branch (<current>) onto <branch>… (Ctrl+Shift+E), Create branch here… (Ctrl+B), Rename… (F2), Delete… (Del), Push (from 003), and Copy branch name. A remote-tracking branch MUST offer Switch, Merge into current branch, Rebase current branch onto, Create branch here, and Copy branch name. An item that cannot run MUST stay focusable and state its reason. The menu keys are the Git Extensions defaults. They act only on the focused branch row, and Create branch here also on the selected history row (plan D15). The window MUST also keep the feature 003 keys Fetch (Ctrl+Shift+Down), Pull with the 003 FR-056 default action (Ctrl+Down), and Push (Ctrl+Up). These equal the Git Extensions defaults. They act in the window but not in an editable field. No key of this feature collides with a key of features 001 to 003 (plan D15).
- **FR-015**: Create branch here MUST take a name and create a branch at the selected commit. Git's own branch-name check MUST decide whether the name is valid. The name `@` MUST be refused with the reason, because Git reads `@` as HEAD in a revision argument. The panel MUST offer "Switch to the new branch", checked by default. A name that an existing branch holds MUST be refused.
- **FR-016**: Rename MUST rename the local branch, as Git's own branch rename does, and Git's own name check MUST apply. The new name `@` MUST be refused (FR-015). The upstream setting moves with it, as Git moves it.
- **FR-017**: Delete MUST be unavailable for the current branch and for a branch that another worktree holds, with the reason. The worktree list MUST come from Git's machine-readable worktree output.
- **FR-018**: Before Delete, the application MUST count the commits that the branch holds and that no other branch, tag, or remote-tracking branch holds. Git's commit count MUST give that number. When it is above zero, the modal confirmation MUST state the number and that the delete loses those commits. When it is zero, the confirmation MUST state that no commit is lost. Cancel MUST have the first focus. Git deletes the reflog of the branch together with the branch. So the confirmation MUST state recovery only through HEAD's reflog, from Git's reflog read. When HEAD's reflog holds the branch tip, it MUST state that HEAD's reflog keeps that commit for a limited time. Otherwise it MUST state that no reflog keeps that commit after the delete.
- **FR-019**: Delete MUST bind to the branch commit that the confirmation showed. When the branch moved, Git MUST refuse the delete, and no reference changes.
- **FR-020**: Copy branch name MUST put the short branch name on the clipboard.

#### Merge and rebase

- **FR-021**: Merge into current branch MUST open a docked panel. It MUST state how many commits each side lacks and whether fast-forward is possible. Git's commit counts and Git's ancestry check MUST give these facts.
- **FR-022**: The merge panel MUST offer one result: Merge commit, which follows Git's own merge configuration, or Squash. It MUST offer the options No fast-forward and Don't commit. It MUST show an editable merge commit message, prefilled with Git's own default message. The message editor MUST enforce the merge message limit of the plan (8 KiB), so that the message fits Git's command line. Above the limit, Merge commit MUST be unavailable with the limit stated. Each option MUST map to the Git merge option of the same meaning. The panel MUST disable combinations that Git refuses, with the reason.
- **FR-023**: A merge MUST respect hooks and signing, as feature 001 FR-019 requires for commit. A merge that stops with conflicts MUST show the feature 003 conflict notice (003 FR-030).
- **FR-024**: Rebase current branch onto MUST open a docked panel. It MUST state how many commits the rebase moves. It MUST state how many of them a remote-tracking branch holds. It MUST state that the next push needs Force push with lease only when the tracking ref of the 003 push destination of the current branch holds at least one rewritten commit.
- **FR-025**: The rebase panel MUST offer Autostash and Autosquash. Autostash MUST start from the effective `rebase.autoStash` value and name its source. Autosquash MUST start unchecked, because `rebase.autoSquash` affects only an interactive rebase. Interactive rebase MUST show as unavailable, with the reason "Not in this version".
- **FR-026**: The Rebase button of the panel MUST count as the confirmation of the history rewrite that constitution principle I asks for. The panel MUST name the moved commits and the rewrite effect before the start.
- **FR-027**: Rebase MUST be non-interactive. A rebase that stops with conflicts MUST show the feature 003 conflict notice. Continue, Skip, and Abort MUST follow 003 FR-042 to FR-045.
- **FR-028**: Merge and Rebase MUST be unavailable for a detached HEAD, a branch without commits, and an operation in progress, with the reason.

#### Conflict resolve

- **FR-089**: A selected entry of the 003 Conflicted list MUST show the resolve view in the diff area. The view MUST name the path, both sides, and the conflict kind. The kind MUST come from the unmerged status code of Git's porcelain v2 status read, such as "Both modified" for `UU` and "Deleted by them" for `UD`. The view MUST offer Choose ours, Choose theirs, Open in merge tool, and the 003 Mark resolved. It MUST NOT read conflict markers or other file text to offer, refuse, or check an action.
- **FR-090**: Each side MUST show its branch or commit from the operation state. During a merge, ours is the current branch and theirs is the merged commit. During a rebase, ours is the branch that receives the commits and theirs is the commit that the rebase applies, as the Git checkout documentation states. The item labels MUST hold these names, such as "Choose theirs (feature/login)".
- **FR-091**: Choose ours and Choose theirs MUST replace the working file with the version of that side, as Git's own `git checkout --ours -- <path>` and `git checkout --theirs -- <path>` do. The path MUST stay unmerged until Mark resolved. A modal confirmation MUST state "Replace <path> with the <name> version. Your edits to this file are lost.", and Cancel MUST have the first focus.
- **FR-092**: Choose ours or Choose theirs MUST be unavailable, with the reason, when the index has no stage for that side, or when that stage is not a regular file. The action MUST bind to the index stages and the working file identity and bytes at selection, as 003 FR-053 binds Mark resolved. A change before the start MUST refuse the action and ask for a refresh.
- **FR-093**: Open in merge tool MUST run Git's own `git mergetool --tool=<tool> --no-prompt -- <path>` for that one path. `<tool>` MUST be the effective `merge.tool` value from the FR-059 read. Without a `merge.tool` value, the item MUST be unavailable with the reason "Set a merge tool in Git settings", and it MUST offer the page Editor and tools. The application MUST NOT change or override Git configuration for the run, such as `mergetool.keepBackup` or `mergetool.<tool>.trustExitCode`.
- **FR-094**: Open in merge tool MUST be available only when the index has stage 2 and stage 3 for the path and both are regular files. Git's mergetool asks on its terminal for delete, symbolic-link, and submodule conflicts, and when it cannot trust the tool's exit code. Git's standard input MUST be empty, so such a question ends the run and never waits.
- **FR-095**: Open in merge tool MUST count as a mutation for FR-001, because Git's mergetool stages the path after the tool reports success. While the tool runs, the row MUST state "Open in <tool>" and offer Cancel. Cancel MUST end the Git process tree under feature 001 FR-045.
- **FR-096**: After the tool exits or after Cancel, a fresh index read MUST decide the result. The exit status of Git's mergetool MUST NOT decide it, because the Git documentation defines none. A path without unmerged stages MUST leave the Conflicted list, with the statement that Git staged it. A path that stays unmerged MUST stay in the list, with Mark resolved available. Files that Git's mergetool leaves, such as `<path>.orig`, MUST show from the fresh status read. The application MUST NOT delete them.
- **FR-097**: The merge tool MUST follow the trust rules of FR-069 to FR-075. The feature 001 contract §7 "Repository-controlled resolution" MUST classify the `mergetool.<tool>.cmd` and `mergetool.<tool>.path` entries and a bare tool program. So an entry from local or worktree scope is repository-controlled, and so is an entry from a file or a program inside the repository roots. A repository-controlled merge tool MUST get approval before Git starts. A merge tool from global or system scope with its program outside the roots MUST run without the trust prompt, as the feature 001 Clarifications state for Git LFS. The hooks and filters that Git's checkout and Git's mergetool can run MUST also follow FR-069.

#### Commit workspace

- **FR-029**: The commit workspace MUST show the Changes list, the Staged list, the diff of the selected file, and the message editor at once. Each region MUST have its own scrollbar and a pointer and keyboard splitter.
- **FR-030**: The Changes list MUST show the tracked changes first, then the Untracked section with its count. The Untracked section MUST start collapsed. Every count MUST come from the status read.
- **FR-031**: Each list MUST offer a tree layout and a flat layout. In the tree layout, each folder MUST show the count of the files that the status read lists under it.
- **FR-032**: Each file row MUST show a stage or unstage button on pointer hover and on keyboard focus. The button MUST have an accessible name, such as "Stage file login.ts". Space MUST keep the feature 001 FR-038 behavior.
- **FR-033**: The commit workspace MUST be a full view that replaces the history view, without the references sidebar. The toolbar MUST offer History and Commit switches. Feature 001 defines no mode shortcut, so the view switch has no key. Every feature 001 key keeps its action.
- **FR-034**: Each list MUST support multi-select with Ctrl and Shift and the pointer, and with Shift+arrow keys. The list header MUST then offer "Stage selected (<n>)" or "Unstage selected (<n>)".
- **FR-035**: The Changes header MUST offer Stage all changes. The Untracked section MUST offer Stage all untracked. The Staged header MUST offer Unstage all.
- **FR-036**: A folder in the tree layout MUST offer Stage folder or Unstage folder. The action covers exactly the entries of that list under that folder in the shown status read.
- **FR-037**: The diff MUST show a visible "Stage hunk" or "Unstage hunk" button on each hunk, and Previous hunk and Next hunk buttons. Each hunk action MUST keep the feature 001 FR-013 and FR-014 rules.
- **FR-038**: Stage selected, Stage folder, Stage all untracked, and Stage all changes MUST update the index in one step for all files of the action, or change nothing. Each file MUST pass the feature 001 FR-038 checks. One refused file MUST refuse the whole action and name the file and its reason.
- **FR-039**: A multi-file action MUST bind to the status read that the user saw. When a fresh read before publication shows another set of entries, the action MUST refuse and require a refresh.
- **FR-040**: The plan MUST document the largest file count of one multi-file action. Above it, the action MUST be unavailable with the limit stated. It MUST NOT stage a part.
- **FR-041**: Line staging MUST stage exactly the selected added and removed lines of one hunk. Unselected removed lines stay, and unselected added lines stay out of the index. Line unstaging MUST do the reverse from the staged diff.
- **FR-042**: Line staging MUST keep the feature 001 FR-013 and FR-014 safety rules. It MUST NOT write working-file content. It MUST verify the resulting index entry before publication, and refuse a stale selection.
- **FR-043**: The user MUST select lines by pointer drag over the line numbers and by Shift+arrow keys. The diff MUST then show "Stage <n> lines" or "Unstage <n> lines". S MUST stage and U MUST unstage the selected lines only while the diff has focus.
- **FR-044**: Line staging MUST be unavailable, with the reason, for a selection with only context lines, for a selection in two hunks, for a hunk of a deleted file (`deleted-file`), for an unstage of lines of a staged new file (`new-file`), for a part of a hunk whose body holds Git's "No newline at end of file" marker on either side (`eof-newline`; the whole hunk stays available), and for every comparison that feature 001 FR-011 marks as unsupported.
- **FR-045**: A file or a folder in the Untracked section MUST offer Add to .gitignore and Add to info/exclude. Before the write, the application MUST show the exact line that it adds.
- **FR-046**: The line MUST be the path from the worktree root with a leading "/". A folder MUST end with "/". Each character with a pattern meaning MUST get a backslash escape, as the gitignore documentation defines. The application MUST append the line to the root `.gitignore` or to the path that Git reports for `info/exclude`. It MUST add a line break first when the file does not end with one. It MUST refuse a symbolic link, a non-regular file, and a line that already exists. It MUST then read the status again.
- **FR-047**: The message editor MUST show a guide at column 72 and a counter for the summary line, such as "47/72". It MUST mark a non-empty line 2. Columns MUST count Unicode code points. The guide and the marks MUST NOT block a commit and MUST NOT change the text.
- **FR-048**: The status bar of the workspace MUST state the staged count, the change count, and the untracked count, such as "3 staged files. 1,258 changes, 1,248 of them untracked."
- **FR-101**: The commit workspace MUST offer one Filter files field for the Changes and Staged lists. It MUST filter the shown rows by a literal substring of the path, without regard to letter case, as the branch list filter does. Ctrl+F MUST focus it in the Commit view, and MUST keep focusing the history filter in the History view. The filter MUST NOT change the scope of Stage all changes, Stage all untracked, Unstage all, Stage folder, or Unstage folder. A row that the filter hides MUST leave the selection, so Stage selected never covers a hidden row. Counts MUST keep the values of the status read.
- **FR-098**: The commit workspace MUST offer the check box "Amend last commit" next to the message editor. It MUST be unavailable, with the reason, for an unborn branch and while a merge or a rebase is in progress. Checking it MUST load the message of HEAD's commit into the editor and keep the earlier draft. Clearing it MUST restore that draft. While it is checked, the workspace MUST state "Commit replaces commit <short ID>." For a commit that no upstream holds, this statement and Commit count as the history-rewrite confirmation of constitution principle I, as FR-026 states for Rebase.
- **FR-099**: Commit with Amend last commit MUST run Git's own `commit --amend` through the feature 001 commit pipeline, with the message on standard input (`--file=-`). The feature 001 hooks, signing, and review rules MUST apply. The amend MUST bind to the HEAD commit whose message the box loaded. When HEAD moved, the amend MUST refuse and ask for a refresh. An amend without staged changes MUST be allowed, so the user can change only the message.
- **FR-100**: Before an amend on a branch with an upstream, the application MUST check whether the upstream holds HEAD's commit, with Git's `merge-base --is-ancestor HEAD <upstream>`. Exit 0 means it holds, and exit 1 means it does not. Any other exit MUST refuse the amend. When the upstream holds the commit, Commit MUST first open a modal destructive confirmation: "Amend rewrites commit <short ID>, which <upstream> already has. The next push needs Force push with lease." Cancel MUST have the first focus. When the repository holds no ref of the upstream (Git's `show-ref --exists` exit 2), or Git stores the configured `branch.<name>.merge` upstream as no remote-tracking branch, the application cannot check, and it MUST NOT assume that the amend is safe. Commit MUST then first open the same modal confirmation with the text "Arbareto cannot check whether <upstream> holds this commit. Amend rewrites it if it was pushed." This confirmation is the history-rewrite confirmation of constitution principle I for a commit that the upstream holds.

#### Worktrees

- **FR-049**: The toolbar MUST show a worktree button with the current worktree name and the worktree count. Its list MUST show each worktree from Git's machine-readable worktree output, with its folder, branch or detached commit, and its locked and prunable states. It MUST mark the current and the main worktree. It MUST offer a filter, Add worktree…, and Prune missing worktrees.
  - Note: the current mark comes from the identity of each record path. A record path without an exact identity form, or an identity refusal other than a missing folder, refuses the whole list with a typed error and shows no worktree (contract Δ3 `readWorktrees`). This cannot occur with Windows paths.
- **FR-050**: The references sidebar MUST show a Worktrees group with the same worktrees. A double-click on a worktree that is not current MUST open it.
- **FR-051**: Open MUST show the selected worktree in the window through the feature 001 open flow. It MUST keep the draft of each worktree under feature 001 FR-034.
- **FR-052**: Add worktree MUST offer a new branch from the selected commit, or an existing branch. The existing-branch list MUST leave out the branches that a worktree holds and state why. An existing branch named `@` MUST be refused with the reason before Git starts (FR-015). The folder field MUST start with a suggestion from the branch name, which the user can edit. The suggestion is a convenience, not a decision. Before the start, the application MUST check from OS facts that the folder does not exist or is empty. The panel MUST offer "Switch to it after creating". Browse… MUST open the native folder picker for the parent folder. Arbareto appends the suggested folder name, and the folder field stays editable.
- **FR-053**: Add worktree MUST NOT change Git configuration, such as `worktree.useRelativePaths`.
- **FR-054**: Remove MUST be unavailable for the main worktree, the current worktree, a locked worktree, and a worktree that Git's worktree output marks as prunable, with the reason. For a prunable worktree, the reason points to Prune missing worktrees. Remove MUST open a modal confirmation that names the folder and states that the commits stay in the repository.
- **FR-055**: Before the confirmation, the application MUST read the status of that worktree. When it has tracked changes or untracked files, the confirmation MUST state both counts. Remove MUST stay unavailable until the user checks "Delete my uncommitted changes too". Only then MUST the application pass Git's force option for that worktree. A worktree with initialized submodules MUST need the same check box, because Git removes it only with its force option (git-worktree(1)). A changed status before the start MUST refuse the remove.
- **FR-056**: The confirmation MUST offer "Also delete the branch" for a worktree on a branch. The branch delete MUST follow FR-018 and FR-019 and run only after the worktree remove succeeded.
- **FR-057**: Prune missing worktrees MUST be available only when Git's worktree output marks a worktree as prunable. It MUST run Git's own worktree prune. Otherwise it MUST state "No worktree is missing".

#### Git settings

- **FR-058**: The Git settings view MUST offer the scopes Effective, This repository, Global, and System. Effective and System MUST be read-only. Without an open repository, Settings MUST show the app pages, and the Git configuration pages MUST state that they need an open repository. Later work: global Git settings without an open repository, where This repository MUST be unavailable (Assumptions, plan.md D15).
- **FR-059**: The view MUST read all values with their scope and their source file from one machine-readable Git read. Each value MUST show its source. The header MUST name the file that a save writes to.
- **FR-060**: The view MUST offer the keys of the Git Extensions Git Config and Advanced pages: `user.name`, `user.email`, `core.editor`, `commit.template`, `credential.helper`, `diff.tool`, `difftool.<tool>.path`, `difftool.<tool>.cmd`, `merge.tool`, `mergetool.<tool>.path`, `mergetool.<tool>.cmd`, `core.autocrlf`, `i18n.filesEncoding`, `pull.rebase`, `fetch.prune`, `merge.autostash`, `rebase.autostash`, `rebase.autosquash`, `rebase.updateRefs`, `rerere.enabled`, and `rerere.autoUpdate`. It MUST also offer `pull.ff`, `push.default`, and `push.autoSetupRemote`. The pages are User, Editor and tools, Line endings, Pull and push, Fetch, Merge and rebase, Credentials, and Advanced.
- **FR-061**: A boolean key MUST offer three states: Not set, On, and Off. "Not set" MUST state the effective value and its scope. An enumerated key MUST offer Not set and each value that the Git documentation defines.
- **FR-062**: The editor and the diff and merge tool keys MUST offer presets from a contract-defined list, plus Custom. A preset MUST show the exact value that it writes.
- **FR-063**: A key with several values in one scope MUST be read-only and list the values with the reason. A key whose one value in a scope comes from an included file, and a boolean key whose value Git cannot read as on or off, MUST also be read-only in that scope with the reason. Save MUST refuse a read-only key.
- **FR-064**: A changed control MUST show "Changed" and the earlier value. Save MUST write only the changed keys into only the selected scope, through Git's own configuration command. Cancel MUST write nothing.
- **FR-065**: After Save, the view MUST read the values again and show them. A failed write MUST name the key and show the bounded end of Git's output.
- **FR-066**: The page Pull and push MUST show the Pull button default action of 003 FR-056 with its five choices. It MUST state that it is an Arbareto setting for all repositories and not stored in Git configuration.
- **FR-067**: The view MUST show values as untrusted plain text. It MUST NOT run a configured program to test it.
- **FR-068**: The Settings view MUST also hold the preselected switch choice of FR-010. Git settings MUST open as a full view inside the main window, with Close. Close MUST return to the earlier view and MUST NOT write a pending change. Esc or Close with pending local or global changes MUST ask first, with Keep editing as the first focus.

#### Trust

- **FR-069**: The application MUST ask for trust only when an action would run a repository program. These actions are a commit with commit hooks, a read with a repository filter or monitor, the 003 network operations with their hooks, and the hooks of FR-005. Opening and inspecting a repository without such programs MUST NOT ask. The trust prompt MUST stay. Constitution principle V stays unchanged.
- **FR-070**: The prompt MUST be one native dialog. Its main text MUST be "Do you trust this repository?". Its content MUST name the action that asked, such as "Git runs them when you commit.". The trust chip asks for the repository as a whole, so its content names no action: "Git runs them for the actions that need them.". It MUST offer Trust and Not now, and Not now MUST be the default button. Enter and Esc MUST choose Not now. A collapsed "Show details" MUST list the folder, the hooks by name with their folder, and the filters and monitors by name with their scope. The prompt MUST NOT show a fingerprint or raw configuration lines in its main text.
- **FR-071**: The approval MUST bind to the repository folder, the worktree folder, the selected Git installation, and the trust policy version. A change of any of them MUST ask again. Edits and additions of hook scripts and program files in the approved folders MUST NOT ask again. The approval MUST NOT hold per-file program digests. So hook rewrites by tools such as Git LFS do not ask again.
- **FR-072**: After Not now, Git MUST run no repository program. Each blocked action MUST state its reason inline, such as "Commit needs trust. Select Not trusted in the status bar to trust this repository.". Reads that need trust MUST state "Arbareto reads no changes until you trust this repository." and offer Trust….
- **FR-073**: The status bar MUST show a trust chip, Trusted or Not trusted, only when the repository has its own programs. Its menu MUST offer "Trust this repository…" and "Stop trusting this repository". Its tooltip MUST state whether Git runs this repository's programs.
- **FR-074**: Stop trusting MUST end the processes of repository programs that still run, under feature 001 FR-045. The result MUST state "Arbareto no longer trusts this repository." and the number of stopped programs when it is above zero. That number is the count of processes that Arbareto ended.
- **FR-075**: Program discovery MUST keep the feature 001 contract §7 rules: exact configuration reads with scopes, hook folder reads from OS facts, and no run of a program to decide trust.

#### Submodule update

- **FR-076**: Update submodules MUST start at once from one click, with no review dialog and no selection. It MUST keep the feature 001 FR-047 update steps for every submodule.
- **FR-077**: The Submodules group of the references sidebar MUST show each submodule as a row, nested ones indented under their parent. During the update, each row MUST show Waiting, Fetching or Updating with Git's percentage where Git reports one, Done, or Failed. The group header MUST show "Updating <i> of <n>" and Cancel.
- **FR-078**: The FR-049 refusal checks of feature 001 MUST run before Git starts. A refusal MUST show as one line in the Submodules group with its reason and "Show remedy". The update MUST NOT start.
- **FR-079**: A submodule that fetches from a host other than the host in the repository settings MUST show one line that names both hosts, before Git starts. The update MUST wait until the user selects "Update anyway" on that line. One selection MUST cover all hosts that the line names, for this run only. Cancel MUST start nothing.
- **FR-080**: Programs from submodule settings and hooks MUST keep the feature 001 FR-050 run confirmation, as one native dialog. It MUST name the submodules and the number of programs. Cancel MUST be the default button.
- **FR-081**: A submodule row MUST offer Update in its context menu, and a failed row MUST offer Retry. Both MUST update that submodule and its nested submodules only, with the same checks and the same confirmation. They MUST also refuse a submodule whose parent is not initialized and a submodule that is not active (contract Δ12).
- **FR-082**: After the run, each row MUST show its observed result, such as "Checked out 4e1a9c0". A failed row MUST show the reason, the Git exit code, and Show output with the bounded output tail. The status bar MUST state the totals, such as "Update submodules finished. 4 updated, 1 failed.". Registration changes MUST show as one information line, with no extra click.

#### Spell check (moved to a later feature)

FR-083 and FR-084 move to a later feature (Clarifications, 2026-10-19). Feature 004 does not implement them.

- **FR-083**: The message editor MUST mark misspelled English words with a wavy underline and a non-color cue. The context menu of a marked word MUST offer suggestions and Ignore. The editor MUST show the chip "Spelling: English".
- **FR-084**: Spell check MUST run on the computer without a network connection and without AI. It MUST NOT block a commit or change the text without a user selection.

#### Visible controls and keyboard

- **FR-085**: Every new control MUST have an icon or a text label, a tooltip that names the action and its shortcut, an accessible name, and visible focus. The accessible name of a menu item MUST be its label only. The menu item MUST give its shortcut in `aria-keyshortcuts`, and its visible shortcut text MUST be hidden from assistive technology. Selectable text and editable fields MUST keep the built-in menu with Copy, unless the element has its own action menu. Unavailable controls MUST state their reason. Destructive actions MUST use explicit labels and MUST stay apart from routine primary actions.
- **FR-086**: The branch list, the worktree list, and the file lists MUST create elements only for the rows near the visible area, as 002 FR-055 requires for the sidebar. The worktree list is the list of the worktree button. The sidebar Worktrees group shows at most 1,000 records. The Submodules group needs no virtualization, because the 001 contract §5 "Submodule review" bound caps it at 256 rows.
- **FR-087**: Single-letter shortcuts MUST act only while their region has focus. A new single-letter shortcut MUST NOT act globally.
- **FR-088**: The window MUST keep the feature 001 SC-005 response targets during every operation of this feature.

### Key Entities *(include if feature involves data)*

- **Branch entry**: A local or remote-tracking branch with its full reference name, its commit, its upstream, its ahead and behind counts from 003, and the worktree that holds it.
- **Switch request**: The target branch or commit, the local-changes choice, the status read that the confirmation showed, and for a remote branch the new local name and its upstream.
- **Switch stash**: The commit ID of the stash that a switch created. It stays until a reapply without conflicts ends.
- **Branch delete check**: The branch commit at confirmation and the count of commits that only this branch holds.
- **Merge request**: The source branch, the result kind, the options, and the message.
- **Rebase request**: The target branch, the moved commits, the count of moved commits that a remote-tracking branch holds, the Autostash value with its source, and the Autosquash value.
- **File selection**: A set of entries of one list from one status read. It binds a multi-file action.
- **Line selection**: The selected added and removed lines of one hunk, bound to the shown diff.
- **Ignore line**: The escaped, anchored path and its target file, `.gitignore` or `info/exclude`.
- **Worktree entry**: The folder, the branch or detached commit, the main, current, locked, and prunable states, from Git's worktree output.
- **Configuration value**: A key, a scope, a value, and its source file. A key can have several values in one scope.
- **Trust approval**: The repository folder, the worktree folder, the selected Git installation, the trust policy version, and the time of approval. It holds no per-file program digest.
- **Amend request**: The HEAD commit and its message at the check, the upstream, and the result of the upstream check.
- **Resolve request**: One unmerged path, its index stages with their modes, the action, the side names from the operation state, and the working file identity and bytes at selection.
- **Submodule row**: The path, the nesting level, the state, the observed commit, and for a failure the exit code and the output tail.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In every switch fixture, HEAD, the index, the working files, and the stash list equal Git's own commands run by hand on a copy. Fixtures cover clean and dirty trees, conflicting changes, untracked files in the way, remote branches, detached HEAD, and other-worktree branches.
- **SC-002**: In every Discard fixture, no untracked file changes or disappears. In every Stash and reapply fixture, no change is lost: it is in the working files or in the named stash.
- **SC-003**: A user switches to any branch from the toolbar in at most three inputs: open the list, type, and press Enter.
- **SC-004**: In every delete fixture, the warning shows exactly when Git counts at least one commit that only the branch holds. A branch that moved after the confirmation never gets deleted.
- **SC-005**: In every merge and rebase fixture, HEAD, the references, the index, the working files, and the operation state equal Git's own command with the same options. Each stated count equals Git's own count.
- **SC-006**: In every staging fixture, the index equals the expected index exactly, and every working-file byte stays unchanged. Fixtures cover folders, multi-select, Stage all untracked, hunks, and lines of added, removed, and mixed hunks.
- **SC-007**: With 100,000 untracked files, the workspace opens, scrolls, and stages a single file within the feature 001 SC-005 targets: 95% of inputs show a response within 100 ms, and every input within 500 ms.
- **SC-008**: In every worktree fixture, the worktree list and the references equal Git's own commands. No worktree with changes is removed without the explicit check box.
- **SC-009**: In every settings fixture, a save changes only the selected keys in the selected scope file. All other bytes of every configuration file stay identical. Across all other fixtures of this feature, every Git configuration file stays byte-identical, except the `branch.<name>` sections that Git's own branch create, rename, and delete write. Those sections equal the result of Git's own branch commands on a copy.
- **SC-010**: In a fixture without repository programs, a full session shows no trust prompt. In a fixture with hooks, the first commit shows exactly one prompt. No repository program runs before approval in any fixture.
- **SC-011**: In every submodule fixture without a safety fact, the update starts with one click and opens no dialog. Each result equals the feature 001 result. Each FR-049 refusal case still refuses and changes nothing.
- **SC-012**: In the spelling fixture, every listed misspelling gets a mark and no listed correct word gets one. No network connection starts. SC-012 moves to a later feature with User Story 10.
- **SC-013**: A review of the requirement-to-test map finds no outcome that Git message text, timing, or a name pattern decides.
- **SC-014**: Keyboard-only users complete each P1 story. Each control has an accessible name, visible focus, and a contrast of at least 4.5:1.
- **SC-015**: In every conflict fixture, Choose ours, Choose theirs, and Open in merge tool give the same working files and index as Git's own `git checkout --ours`, `git checkout --theirs`, and `git mergetool` with the same fixture tool on a copy. No repository-controlled merge tool runs before approval. No action reads conflict markers.
- **SC-016**: In every amend fixture, the tree, the parents, the message, and the references equal Git's own `git commit --amend` on a copy. The rewrite confirmation shows exactly when `merge-base --is-ancestor HEAD <upstream>` exits 0.

## Assumptions

- Feature 003 ships before this feature or with it. Its conflict actions and its Pull default action are available.
- The stash of Stash and reapply covers tracked changes, as Git's own stash does by default. Untracked files stay in the folder and go along with the switch. This is a reviewer default.
- Reapply restores the index state of the stash where Git can. This is a reviewer default (plan decides the Git option).
- Untracked files that Git ignores are not protected by FR-011. Git treats ignored files as replaceable. This is a reviewer default.
- Create branch here has "Switch to the new branch" checked, as Git Extensions has it. This is a reviewer default.
- Merge and Rebase need a current branch. Git allows a merge on a detached HEAD, but the panel refuses it. This is a reviewer default.
- Line staging works inside one hunk. Git Extensions allows a selection across hunks. This is a reviewer default.
- Discard of single files, hunks, or lines stays out of scope, although Git Extensions offers Reset selected lines. This is a reviewer default.
- The Untracked section always starts collapsed. This is a reviewer default from the mockup.
- The ignore actions write a fixed, anchored line, not a pattern that the user types. Git Extensions offers a pattern box. This is a reviewer default.
- The settings view leaves out signing keys (`commit.gpgSign`, `user.signingKey`). Git Extensions has no settings page for them. `core.longpaths` and `init.defaultBranch` are candidates for later. This is a reviewer default.
- The settings view adds `pull.ff`, which Git Extensions does not offer, because the "When I pull" control needs it. This is a reviewer default from the mockup.
- Settings opens with or without an open repository. Without one, it shows the app pages only, and the Git configuration pages need an open repository. Global Git settings without an open repository come later.
- `credential.helper` is a text field without a program scan. This is a reviewer default.
- `push.autoSetupRemote` changes Git's behavior. The 003 push panel (003 FR-016) still decides what Arbareto shows. The plan checks that 003 reads the effective value. This is a reviewer default.
- For the later spell check feature: English is the first spell check language. More dictionaries come later. The dictionary source and its license are a plan decision.
- Interactive rebase comes in a later feature.
- The resolve view acts on one file at a time. The merge tool runs only on a user selection, never on its own after a conflict. This is a reviewer default.
- The mockup boards of 2026-10-16 are the design reference: Main, BranchSwitcher, BranchContext, MergeRebase, Commit, Worktrees, Settings, Trust, and Submodules.

## Research inputs

These facts come from the Git Extensions source at commit 813f48be (2026-10-13) and from DeepWiki answers of 2026-10-16. They describe Git Extensions, not Arbareto.

- A double-click on a local branch checks it out. A confirmation shows only when the setting `ConfirmBranchCheckout` is on, and its default is off.
- The checkout dialog offers Don't change, Merge, Stash, and Reset for local changes. A setting can skip the dialog.
- Stash runs only for a dirty tree. After the checkout, Git Extensions asks whether to apply the stash again. After a failed checkout, it offers no pop.
- Git Extensions always deletes with Git's force option. It finds unmerged branches from `git branch --merged` output itself, and it treats a detached HEAD as unmerged.
- The merge dialog offers No fast-forward, Squash, No commit, a log message count, and a custom message. The rebase dialog offers Interactive, Autosquash, Autostash, a specific range, Rebase merges, Ignore date, and Committer date is author date.
- Line staging builds a patch and applies it to the index with Git's apply command. Reset selected lines asks for an explicit Yes.
- The file list has a Show untracked files switch, tree and flat layouts, and Add file to .gitignore or to .git/info/exclude with a pattern box and a match count.
- Spell check uses NetSpell dictionaries, with en-US as default, per repository.
- Worktree delete removes the folder and runs Git's prune. It does not delete the branch. The main worktree is refused. Add sets `worktree.useRelativePaths` when it is unset. Arbareto does not copy that change (FR-053).
- Git settings show Effective, Local, Global, and System scopes. Only Local and Global are saved. No page edits `push.default` or signing keys.
- Submodule update always runs `git submodule update --init --recursive` in a progress window, without an options dialog.
- Git Extensions detects dubious ownership from message text. Arbareto must not copy that detection.
