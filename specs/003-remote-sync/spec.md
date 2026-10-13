# Feature Specification: Remote Sync

**Feature Branch**: `003-remote-sync`

**Feature Directory**: `specs/003-remote-sync`

**Created**: 2026-10-12

**Status**: Draft

**Input**: User description: "Fetch, pull, and push for the open repository, with progress, Cancel, and a bounded deadline. A rejected push offers pull with rebase, pull with merge, force push with lease, and fetch. Show ahead and behind counts for the current branch and its upstream in the history graph and the branch list. Support PuTTY, plink, and Pageant for SSH remotes. Use the credential helpers that the user configured. Never store or log credentials, and never change the user's Git configuration silently. Avoid feature overload."

## Clarifications

### Session 2026-10-12

- Q: Does Clone belong in this feature? → A: Yes, in feature 003. Clone is User Story 7 (P2) with FR-046 to FR-051 and SC-011. It never recurses into submodules.
- Q: Should the application fetch on its own, for example on a timer or when a repository opens? → A: No, only on user action. The application uses the network only when the user starts a network operation (FR-041). The counts state that they compare with the last fetch (FR-022).
- Q: Which conflict actions does this feature offer after a pull? → A: Abort, Continue, and Skip as application actions (FR-030, FR-042 to FR-045). Abort needs a confirmation. Continue needs an index without unmerged entries, from exact index facts, never conflict markers. Skip applies only to a rebase. The resolve panel stays with branch operations.
- Q: Can the user mark a conflicted file as resolved in the application? → A: Yes. A conflicted file in the changes list gets Mark resolved (FR-052, FR-053, SC-014). It stages the current working bytes of that path, as Git's own whole-file staging of that path does, and so clears its unmerged index stages. The application offers it only for paths that the index reports as unmerged and never reads conflict markers. It checks the index and the file again before it stages, refuses a stale selection, and never edits the file. Continue then works without a terminal. Merge tools and a resolve panel stay out of scope.
- Q: Does the clone panel suggest a destination? → A: Yes. The panel pre-fills an editable destination (FR-054). The parent folder is the parent of the last clone, else the default clone folder that the user set, else empty. The folder name is the last path segment of the URL without a trailing `.git`. The user sees and can edit it before the start, and Clone uses only the path that the user confirms. FR-047 still refuses an existing non-empty destination. The suggestion is a convenience, not a decision from Git output, so the no-heuristics rule does not apply to it.
- Q: How does the user choose between pull with merge and pull with rebase, and does a rebase pull need a confirmation? → A: Use the Git Extensions model, designed better. The toolbar Pull control is a split button (FR-055, FR-056). Its main part runs the default action that the user chose. Its menu lists Pull (use Git's configuration), Pull with merge, Pull with rebase, Fetch, Fetch all remotes, and Set default action. Set default action is a submenu with radio items for those actions. The application settings store the chosen default, never the Git configuration. The icon and tooltip of the main part name the current default. An explicit user choice of a rebase action counts as the confirmation that constitution I asks for, as Git's own pull does (FR-057). This is a user decision.
- Q: How does the split-button rebase agree with constitution I, which asks for a confirmation before a history rewrite? → A: Amend the constitution. Principle I is amended on 2026-10-12: a non-interactive rebase pull counts as confirmed when the user explicitly selects a rebase action, or when the user's own Git configuration selects a rebase for a pull that the user starts. This is a user decision.

## User Scenarios & Testing *(mandatory)*

Feature 001 has no remote operation except Update submodules, and it hides Fetch, Pull, and Push. Feature 002 shows the full history of all branches. This feature adds the remote operations for the open repository and shows how far each branch is ahead of its upstream or behind it. It also adds Clone. The order of the journeys follows a normal work day: fetch, see the difference, push, recover from a rejected push, pull, then SSH with PuTTY. Clone and Commit and push follow by priority.

### User Story 1 - Fetch and see what changed (Priority: P1)

A developer fetches the remote of the current branch, or all remotes. The history and the references sidebar then show the new remote commits.

**Why this priority**: Every other remote decision needs fresh remote-tracking references. Fetch changes no local branch and no working file, so it is the safest first operation.

**Independent Test**: Use disposable repositories with local bare remotes. Add commits, branches, and tags to a remote, then fetch. Compare every remote-tracking reference with Git's own fetch in a copy.

**Acceptance Scenarios**:

1. **Given** a remote with new commits on the upstream branch. **When** I select Fetch. **Then** I see "Fetching from <remote>…" with Cancel, and a percentage where Git reports one. At the end, the history shows the new commits, and the sidebar shows the moved remote-tracking branch.
2. **Given** several remotes. **When** I select Fetch all remotes. **Then** Git fetches each remote, and the result lists each remote with its outcome.
3. **Given** a fetch that changed no reference. **When** it ends. **Then** the result states that nothing changed. The history keeps its rows and its selection.
4. **Given** a slow fetch. **When** I select Cancel, or Git shows no output and transfers no data for 5 minutes. **Then** the fetch stops. The result shows the references that Git actually updated, without a rollback claim.
5. **Given** a fetch that fails, such as an unreachable host or a refused sign-in. **When** it ends. **Then** I see the bounded end of Git's output without credentials, and a copyable terminal command. No local branch, index entry, or working file changed.
6. **Given** a WSL repository. **When** I fetch. **Then** the distro's Git fetches inside the distro, with the distro's credentials, and the results follow scenarios 1 to 5.

---

### User Story 2 - See how far each branch is ahead or behind (Priority: P1)

A developer sees, at a glance, how many commits the current branch and each local branch have that their upstream lacks, and the reverse.

**Why this priority**: The counts tell the developer whether a push or a pull is necessary. Feature 001 moved these counts to this feature.

**Independent Test**: Use fixtures with branches that are ahead, behind, diverged, equal, without an upstream, and with a deleted upstream. Compare each shown count with Git's own count of the two commit ranges.

**Acceptance Scenarios**:

1. **Given** a current branch with 2 commits that its upstream lacks and 3 commits that only the upstream has. **When** the repository opens. **Then** the toolbar, the current branch entry in the sidebar, and the branch label in the history show "↑2 ↓3" with the text "2 ahead, 3 behind" for keyboard and tooltip users.
2. **Given** a local branch equal to its upstream. **When** the sidebar shows it. **Then** it shows an equal mark, not empty space.
3. **Given** a local branch without an upstream. **When** the sidebar shows it. **Then** it shows no counts and states "No upstream".
4. **Given** a local branch whose upstream reference no longer exists after a fetch with pruning. **When** the sidebar shows it. **Then** it states "Upstream gone" and shows no counts.
5. **Given** a fetch, a pull, a push, or a commit. **When** the operation ends. **Then** the counts show the new values without a manual refresh.
6. **Given** an external Git process that moves a branch or a remote-tracking reference. **When** the application detects the change or regains focus. **Then** the counts show the new values.
7. **Given** a detached checkout. **When** the repository opens. **Then** the toolbar shows no counts and states that no branch is checked out.

---

### User Story 3 - Push the current branch (Priority: P1)

A developer pushes the commits of the current branch to its remote branch.

**Why this priority**: Push is the only way to share local work. Without it, the developer must leave the application for every share.

**Independent Test**: Push to local bare remotes. Compare the remote branch and the local remote-tracking reference with Git's own push in a copy. Check that no configuration file changed, except where the user selected Set upstream.

**Acceptance Scenarios**:

1. **Given** a current branch with an upstream and 2 new commits. **When** I select Push. **Then** I see "Pushing to <remote>…" with Cancel. At the end, the remote branch holds the 2 commits, and the counts show "↑0".
2. **Given** a current branch without an upstream. **When** I select Push. **Then** a panel shows the remote and the remote branch name that the push uses. It shows the option "Set upstream", selected, and states that this option writes the upstream into the repository configuration. Nothing starts before my explicit start.
3. **Given** a pre-push hook in an approved repository. **When** I push. **Then** the hook runs. A rejection by the hook shows its bounded output, and nothing reaches the remote.
4. **Given** a pre-push hook in a repository without trust approval. **When** I select Push. **Then** the trust confirmation of feature 001 appears first. A declined confirmation starts nothing.
5. **Given** a detached checkout or a branch without commits. **When** I look at Push. **Then** Push is unavailable and states its reason.
6. **Given** a remote that refuses the update for its own reason, such as a protected branch. **When** the push ends. **Then** I see "Rejected by the remote" and the remote's message as plain text. The application offers no pull or force choice for that case.

---

### User Story 4 - Recover from a rejected push (Priority: P1)

A developer pushes, and the remote branch has commits that the local branch lacks. The application offers the safe ways forward in one place.

**Why this priority**: The user asked for this flow. A rejected push is the most frequent push failure, and a wrong recovery can delete other people's commits.

**Independent Test**: Make the remote branch diverge from the local branch, then push. Run each offered choice in a copy and compare its result with the same Git commands run by hand.

**Acceptance Scenarios**:

1. **Given** a remote branch with commits that the local branch lacks. **When** I push. **Then** the notice band states that the remote rejected the push, and that the remote branch can hold commits that I do not have. It offers Pull with rebase, Pull with merge, Fetch, and Force push with lease. Force push with lease shows as a destructive action, with an icon and text.
2. **Given** that notice. **When** I select Pull with rebase or Pull with merge. **Then** the pull runs as story 5 describes. After a successful pull, the notice offers Push again.
3. **Given** that notice. **When** I select Fetch. **Then** the fetch runs, and the history shows the remote commits beside mine. The notice stays until I push again or dismiss it.
4. **Given** that notice. **When** I select Force push with lease. **Then** a modal confirmation names the remote branch and the number of remote commits that the push removes from that branch, with their subjects. It states that other people can lose work. Cancel has focus.
5. **Given** a confirmed force push. **When** someone else pushed to the remote branch after my last fetch. **Then** the remote refuses the force push, and no remote commit is lost. The notice states that the remote branch changed since the last fetch and offers Fetch.
6. **Given** a confirmed force push and an unchanged remote branch. **When** the push ends. **Then** the remote branch equals my local branch, and the result names the replaced remote commit.

---

### User Story 5 - Pull the upstream into the current branch (Priority: P1)

A developer brings the upstream commits into the current branch, by a fast-forward, a merge, or a rebase.

**Why this priority**: Pull is the daily partner of push, and the push-rejected flow depends on it.

**Independent Test**: Pull into fast-forward, diverged, and conflicting fixtures with each mode. Compare HEAD, the index, the working files, and the operation state with Git's own pull in a copy.

**Acceptance Scenarios**:

1. **Given** a current branch that is only behind its upstream. **When** I select Pull (use Git's configuration). **Then** the branch moves forward to the upstream commit, and the working files follow. No merge commit appears, unless Git's configuration (`pull.ff=false` or `merge.ff=false`) makes Git's own pull create a merge commit. Then Pull creates a merge commit too.
2. **Given** a diverged branch and Git configuration that names a pull mode for this branch. **When** I select Pull (use Git's configuration). **Then** the pull uses that mode, and the result names it.
3. **Given** a diverged branch and no configured pull mode. **When** I select Pull (use Git's configuration). **Then** the application fetches, and then asks me to choose Rebase or Merge for this pull. It changes no configuration.
4. **Given** uncommitted changes that Git refuses to overwrite. **When** I pull. **Then** Git refuses, and I see its bounded output. My working files and index stay unchanged.
5. **Given** a pull that stops with conflicts. **When** it ends. **Then** the notice band names the merge or the rebase in progress, and the Conflicted list shows the files that the index records as unmerged. The notice offers Abort and Continue, and Skip for a rebase. Continue is unavailable and states its reason while the index has unmerged entries.
6. **Given** a pull hook or a filter that needs trust approval. **When** I select Pull. **Then** the feature 001 trust rules apply before any Git process starts.
7. **Given** a slow pull. **When** I cancel it. **Then** the application re-reads HEAD, the index, and the operation state, and reports the actual result. It never claims rollback.
8. **Given** the conflict notice of scenario 5. **When** I select Abort. **Then** a confirmation states what Git restores and what it cannot restore. Cancel has focus. After my confirmation, Git aborts the merge or the rebase, and the result reports the observed HEAD, index, and operation state.
9. **Given** the conflict notice and an index without unmerged entries, after I resolved the files and marked them resolved. **When** I select Continue. **Then** Git continues the merge or the rebase with the message that Git prepared. A rebase that stops again shows the notice again.
10. **Given** the conflict notice of a rebase. **When** I select Skip. **Then** a confirmation names the commit that leaves the rebased branch and states that Git discards the index and working-file changes of that step. Cancel has focus. After my confirmation, Git leaves the current commit out of the rebase and continues. The Skip label states that it leaves that commit out.
11. **Given** the conflict notice and a conflicted file that I edited to its final content. **When** I select Mark resolved on that file. **Then** the file leaves the Conflicted list and shows as staged with its current working bytes. The bytes of the file stay unchanged. When no unmerged entry remains, Continue becomes available.
12. **Given** a conflicted file that another process changed or staged after the list showed it. **When** I select Mark resolved. **Then** the application refuses, changes no index entry, and asks me to refresh and select again.
13. **Given** a diverged branch and Git configuration that sets `pull.ff=only`. **When** I select Pull (use Git's configuration). **Then** the application fetches, then refuses the integration and states that the configuration allows only a fast-forward. No local branch, index entry, or working file changes. Pull with rebase and Pull with merge stay available.
14. **Given** the toolbar Pull split button. **When** I open its menu. **Then** I see Pull (use Git's configuration), Pull with merge, Pull with rebase, Fetch, Fetch all remotes, and Set default action. An action item runs that action at once.
15. **Given** the Set default action submenu. **When** I select Pull with rebase. **Then** the radio item shows the new default, and the icon and tooltip of the main part name Pull with rebase. A later click on the main part runs Pull with rebase without a further confirmation. No Git configuration file changes.

---

### User Story 6 - Use PuTTY for SSH remotes (Priority: P2)

A developer who keeps SSH keys in Pageant uses plink for SSH remotes, as in Git Extensions.

**Why this priority**: The user asked for PuTTY support and deferred it from feature 001 to this feature. Git's own OpenSSH path already works without it.

**Independent Test**: Use a disposable SSH server with a known host key and a test key pair. Fetch and push through plink with Pageant, with an unknown host key, and with a key that Pageant lacks. Compare the user's Git configuration files and PuTTY settings before and after.

**Acceptance Scenarios**:

1. **Given** the SSH client setting "PuTTY (plink)" and a plink program that I selected. **When** I fetch from an SSH remote. **Then** Git uses plink for that fetch, and my Git configuration files stay byte-identical.
2. **Given** a host key that PuTTY does not know. **When** I fetch. **Then** the fetch fails at once instead of waiting for hidden input. The notice offers Connect in a terminal. That action opens a visible terminal that connects once to that host with plink, so I can check and accept the key myself.
3. **Given** a key file that I set for a remote and Pageant not running. **When** I fetch from that remote. **Then** the application starts Pageant with that key file first. Pageant asks for the passphrase in its own window.
4. **Given** the setting "Git's own configuration" (the default). **When** I fetch. **Then** Git uses the SSH program that my configuration selects, and the application sets no SSH variable.
5. **Given** the SSH settings. **When** I select Generate or convert a key. **Then** PuTTYgen starts. The application reads and writes no key file.
6. **Given** a WSL repository. **When** I look at the SSH settings. **Then** they state that PuTTY applies only to Windows repositories. The distro's own SSH setup applies.

---

### User Story 7 - Clone a repository (Priority: P2)

A developer copies a remote repository into a new local folder and starts work in it.

**Why this priority**: The project brief lists Clone for this feature. Users can clone with Git and open the folder through feature 001, so the daily operations of stories 1 to 5 come first.

**Independent Test**: Clone local bare remotes and a disposable SSH server into missing, empty, and non-empty folders. Compare each new repository with Git's own clone in another folder. Compare the destination folder before and after each refusal and each cancellation.

**Acceptance Scenarios**:

1. **Given** a remote URL and a destination folder that does not exist or is empty. **When** I start Clone. **Then** I see "Cloning into <folder>…" with Cancel, and a percentage where Git reports one. At the end, the application opens the new repository through the feature 001 open flow. The feature 001 trust decision shows before the first read of the new repository.
2. **Given** a destination folder that holds any file or folder, or a destination path that is a file. **When** I start Clone. **Then** a refusal names the destination. No Git process starts, and the destination stays unchanged.
3. **Given** a remote that needs sign-in. **When** I clone. **Then** Git uses my configured credential helpers. The application stores and logs no credential. A failure shows the bounded end of Git's output without credentials, and a copyable terminal command.
4. **Given** the SSH client setting "PuTTY (plink)" and an SSH URL. **When** I clone. **Then** Git uses plink for the clone. A key file that I set in the clone panel reaches Pageant before the start. A host key that PuTTY does not know fails the clone at once, and the notice offers Connect in a terminal.
5. **Given** a slow clone. **When** I select Cancel, or Git shows no output and transfers no data for 5 minutes. **Then** the clone stops. The result states whether the destination folder exists and whether it is empty. The application deletes and moves no file.
6. **Given** a remote whose commit records submodules. **When** the clone ends. **Then** Git cloned no submodule. The opened repository offers Update submodules of feature 001.
7. **Given** a destination folder inside a WSL distro. **When** I clone. **Then** the distro's Git clones inside the distro, with the distro's credentials and SSH setup.
8. **Given** a last clone into `D:\src\app`. **When** I enter the URL `https://example.test/team/tool.git` in the clone panel. **Then** the destination shows `D:\src\tool` as editable text. Clone starts only with the destination that the panel shows at my explicit start.

---

### User Story 8 - Commit and push in one step (Priority: P3)

A developer commits the staged changes and pushes the current branch with one action.

**Why this priority**: It saves a step in a frequent flow. Commit and push each work alone without it.

**Independent Test**: Commit and push into a local bare remote. Then repeat with a commit hook rejection and with a rejected push.

**Acceptance Scenarios**:

1. **Given** staged changes, a message, and an upstream. **When** I select Commit and push. **Then** the commit runs as in feature 001. After a successful commit, the push runs as story 3 describes.
2. **Given** a commit that fails or ends with a changed result. **When** it ends. **Then** no push starts, and the feature 001 commit outcome shows.
3. **Given** a successful commit and a rejected push. **When** the push ends. **Then** the commit stays, and the story 4 notice shows.

---

### Edge Cases

- A remote branch name and a remote name can both hold slashes. The application takes the remote and the branch from Git's exact upstream data and never splits a name at a slash.
- A remote URL can hold a user name and a password. Every display, diagnostic, and copyable command shows it without them.
- The remote can send messages to the client, such as a pull request link or a hook message. They show as untrusted plain text without terminal control sequences, and they are never logged.
- A credential helper can show its own sign-in window and wait for the user. The 15-second stall notice then names a sign-in window, and the 5-minute inactivity limit still applies.
- Git can wait for a password or an SSH passphrase on a terminal. Git then fails at once, because the application gives Git no terminal. The failure offers a copyable terminal command.
- A user can set `GIT_SSH` or `GIT_SSH_COMMAND` in the Windows environment, for example to plink without its batch option. Under "Git's own configuration", plink can then wait for hidden input. The 15-second stall notice and the limits still apply.
- A PuTTY host key can change, for example after a server rebuild or an attack. Plink fails at once. Connect in a terminal shows PuTTY's own warning. The application never writes a host key.
- A fetch with pruning can delete the upstream of a local branch. That branch then shows "Upstream gone". The local branch and its commits stay.
- A fetch can recurse into submodules under the user's configuration. Operations of this feature never start Git inside a submodule. Update submodules of feature 001 stays the only submodule network action, and its notice shows after a pull that moved a submodule commit.
- A partial clone can lack objects that a pull checkout needs. The application never downloads missing objects outside the fetch itself. The pull fails before it changes data, or reports its reconciled result (feature 001 FR-025).
- A Git LFS pre-push hook can upload large files, and a pull can run the LFS smudge filter. The feature 001 trust and filter rules apply to both.
- Another process can move the local branch, the index, or a remote-tracking reference while an operation runs. The outcome reports the observed state and never undoes the other change.
- The same branch can have an upstream on a remote that the configuration no longer lists. Fetch and Pull then state that the remote is missing, and nothing starts.
- A push can change several references, for example when Git's push configuration selects more than the current branch. This feature pushes only the current branch to its one destination and names that destination before the start.
- A tag with the same name as a remote branch can make a destination unclear. The application uses full reference names, so Git never picks the wrong reference.
- A fetch can bring a very large number of new references. The result then states the counts and the documented limit, not a partial list as a complete one.
- Ahead or behind counts can be very large, for example after an unrelated history. The counting has the normal deadline. Above the documented bound, the label shows the bound with a plus sign, such as "↓10000+".
- A pull rebase can stop at a commit whose hook fails. The repository then has a rebase in progress, and the notice band names it.
- A merge or a rebase can be in progress when the repository opens, for example after a restart or after a Git command in a terminal. Git's state does not record which command started it. So the notice offers the same conflict actions for every merge or rebase in progress.
- A remote repository can have no commits. Its clone then opens with an unborn branch, as feature 001 shows it.
- Another process can write into the destination folder after the check and before Git creates it. Git then refuses the clone, and the result shows Git's bounded output and the observed folder state.
- A clone URL can end with a slash, have no path segment, or give a folder name that the destination file system refuses. The suggested name is then empty, or the start refuses under FR-047 and feature 001 FR-044. The application never changes the name to make it valid.
- A conflicted file can be missing from the working tree, for example after a delete conflict. Mark resolved then refuses with its reason. The user records the deletion outside the application.
- A clone URL can start with a dash or hold a user name and a password. The application passes it to Git as a literal value, never as an option, and shows it without credentials.

## Requirements *(mandatory)*

### Scope Boundaries

Include Fetch for the remote of the current branch and Fetch all remotes. Include Pull into the current branch by fast-forward, merge, or rebase, through a Pull split button with a default action that the user sets. Include Push of the current branch to one destination, with Set upstream for a branch without an upstream. Include the push-rejected notice with its four choices, and Force push with lease behind a confirmation. Include ahead and behind counts in the toolbar, the references sidebar, and the history branch labels. Include Commit and push. Include Abort and Continue for a merge or a rebase in progress, Skip for a rebase in progress, and Mark resolved for a conflicted file. Include PuTTY support for SSH remotes of Windows repositories: plink, Pageant start with a key file, and a PuTTYgen launch.

Include Clone of one remote URL into one new or empty folder, followed by the feature 001 open flow, with a suggested destination that the user confirms. Exclude clone options: shallow and partial clones, a chosen branch, a chosen remote name, a bare or mirror clone, templates, and submodule recursion.

Exclude branch operations: checkout, create, rename, delete, merge into current, rebase onto, reset, cherry-pick, and revert. Exclude the conflict resolution panel and merge tools. Exclude remote management: add, rename, remove, and edit URLs. Exclude push of tags, push of other branches, push of several branches in one action, and deletion of remote branches. Exclude the Git configuration editor and its presets. Exclude credential setup, credential storage, SSH key creation by the application, and edits of PuTTY settings. Exclude provider integrations, such as pull requests. Exclude automatic, scheduled, and background fetch, including a fetch when a repository opens or the window gets focus.

### Changes to feature 001 requirements

This feature changes these feature 001 requirements for builds that include it. The 001 text stays unchanged in its own spec.

- **001 FR-003**: Push with Set upstream MAY write the upstream of the current branch into the repository configuration, only after the user selects it in the push panel. That is the second named exception to "no configuration change". Under "PuTTY (plink)", the application MAY add the key file that the user saved for a remote to Pageant before an operation on that remote (FR-035). It never removes a key.
- **001 FR-016**: A merge or a rebase in progress blocks every mutation except Abort, Continue, Skip, Mark resolved, Fetch, and Fetch all remotes. Fetch and Fetch all remotes stay allowed, because they change only remote-tracking references. Pull, Push, Force push with lease, Commit and push, and Clone into that repository are refused with `OPERATION_IN_PROGRESS`. This is a reviewer default.
- **001 FR-027**: Force push with lease is allowed behind the FR-024 confirmation. Pull with rebase, Abort, Continue, and Skip are allowed as FR-027 and FR-042 to FR-045 define them. Every other force operation, discard, reset, and history rewrite stays excluded.
- **001 Scope Boundaries**: Clone moves from the 001 exclusions into this feature.
- **001 conflict clarification** ("How does this feature show conflicts?") and the 001 assumption that conflicts stay inspection-only: 001 shows conflicts read-only. This feature changes that. The Conflicted list offers Mark resolved for each conflicted file (FR-052, FR-053), and the notice offers Abort, Continue, and Skip (FR-030, FR-042 to FR-045). The resolve panel and merge tools stay with branch operations.
- **001 FR-038**: Stage file still refuses conflicted entries. Mark resolved (FR-053) is the one action that stages a conflicted path. It uses the FR-038 staging path and its checks.
- **001 FR-051**: Fetch, Pull, Push, and Clone also use the network. The rules of 001 FR-051 apply to them: Git's own transport policy, no hidden terminal prompt, the stall notice, and no credential setup. One exception exists. When the user selects the SSH client "PuTTY (plink)" in the application settings, the application sets the SSH program and its variant for the Git processes that it starts. It never writes them into any Git configuration file or the user environment.
- **001 FR-056**: Fetch, Pull, and Push become visible. Stash and the other later controls stay hidden.
- **001 FR-057**: Each local branch with an upstream shows its ahead and behind counts (FR-019 of this feature).

### Functional Requirements

#### Common rules for remote operations

- **FR-001**: Fetch, Pull, Push, Commit and push, Abort, Continue, Skip, and Mark resolved MUST count as mutations for feature 001 FR-015, FR-016, FR-023, and FR-024. While one runs, another mutation of the same repository MUST be refused as busy. Reads MUST stay available.
- **FR-002**: Each remote operation MUST show its step text with Cancel: "Fetching from <remote>…", "Pulling from <remote>…", "Rebasing…", "Merging…", or "Pushing to <remote>…". It MUST show a percentage only where Git prints its untranslated progress counter. It MUST NOT show a computed or estimated percentage.
- **FR-003**: Each remote operation MUST use the time limits of feature 001: a stall notice after 15 seconds without output and without data transfer, an end after 5 minutes without output and without data transfer, and an end after 4 hours. The stall notice MUST name a hidden prompt or a sign-in window and offer Cancel and a copyable terminal command.
- **FR-004**: After success, failure, cancellation, or a time limit, the application MUST re-read the affected references, HEAD, the index, and the repository operation state. It MUST report the observed result. It MUST NOT claim rollback, retry automatically, or undo a change.
- **FR-005**: Every outcome MUST come from Git exit codes that Git documents for that command, from Git's machine-readable output, or from a fresh read of repository state. The application MUST NOT classify any result by Git's message text, by the remote's message text, or by timing. When no such signal exists, the outcome MUST state that the cause is unknown and show Git's bounded output.
- **FR-006**: Failure output MUST follow the feature 001 FR-019 output rules: bounded, plain text, no terminal control sequences, no credentials in URLs, and never logged. Messages from the remote MUST follow the same rules.
- **FR-007**: Operations of this feature MUST NOT start Git inside a submodule and MUST NOT recurse into submodules, whatever the configuration selects. After an operation that changed a recorded submodule commit, the feature 001 FR-053 notice MUST show.
- **FR-008**: The application MUST use Git's own transport policy, credential helpers, and SSH configuration unchanged, except for FR-033. It MUST NOT store, cache, or log credentials. It MUST NOT add, change, or remove any Git configuration value without an explicit user selection that names the value. Set upstream (FR-016) is the only such selection in this feature. Clone writes only the configuration that Git's own clone writes into the new repository.
- **FR-009**: Repository-controlled hooks and filters that an operation can run MUST follow feature 001 FR-025. This covers the reference-transaction hook during fetch and pull, the pre-push hook, the merge and rebase hooks, and the checkout filters of a pull.
- **FR-010**: In a WSL repository, every operation of this feature MUST run through the distro's Git, with its network access inside the distro. The distro's own credentials and SSH setup MUST apply. Feature 001 FR-045 and FR-046 MUST apply.

#### Fetch

- **FR-011**: Fetch MUST fetch the remote that Git's own fetch without arguments selects for the current branch. Fetch all remotes MUST fetch every configured remote. Both MUST follow the user's configuration for pruning and tags and MUST NOT add options that change them.
- **FR-012**: The fetch result MUST list each updated, created, and deleted remote-tracking reference from Git's machine-readable fetch output. It MUST state when nothing changed. Above the documented limit, it MUST state the counts and the limit.
- **FR-041**: The application MUST use the network only when the user starts Fetch, Fetch all remotes, Pull, Push, Commit and push, Clone, a pull or a fetch from the push-rejected notice, Connect in a terminal, or feature 001 Update submodules. It MUST NOT fetch on a timer, at repository open, at focus return, or in the background.
- **FR-013**: After a fetch that the user started, the history view and the references sidebar MUST refresh without the feature 002 refs-changed notice, and MUST keep the selected commit when the new references reach it.

#### Push

- **FR-014**: Push MUST push only the current branch to one destination: the remote branch that Git's own push of the current branch selects. Before the start, the destination MUST be known as a full reference name. When the current branch has no upstream, or Git's configuration gives no destination, FR-016 MUST apply. When Git gives a destination, the panel MUST pre-fill it.
- **FR-015**: Push MUST read the result for each reference from Git's machine-readable push output. A reference with the status "rejected" MUST start the push-rejected flow (FR-023). A reference with the status "remote rejected" MUST show "Rejected by the remote" with the remote's message, and MUST offer no pull or force choice. Push MUST NOT read the reason text that follows the status, because Git documents it as human-readable only.
- **FR-016**: For a branch without an upstream, Push MUST open a panel before the start. The panel MUST show the remote, with a choice when several remotes exist, and the remote branch name, which defaults to the local branch name. It MUST show the option "Set upstream", selected by default. The panel MUST state that this option writes the upstream of this branch into the repository configuration. Push MUST start only at an explicit start in the panel. For a branch that has an upstream, Set upstream MUST NOT be selected by default.
- **FR-017**: Push MUST be unavailable, with a visible reason, for a detached checkout, a branch without commits, an unfinished repository operation, and a missing remote, and every other case that the plan names as a refusal reason. Each reason MUST come from Git configuration values or repository reads, never from message text.
- **FR-018**: After a push, the remote-tracking reference of the destination MUST show the value that Git's push output reports.

#### Ahead and behind counts

- **FR-019**: The application MUST show the ahead and behind counts of the current branch in the toolbar, of each local branch with an upstream in the references sidebar, and of each local branch label in the history graph. Ahead is the number of commits that the branch reaches and its upstream does not reach. Behind is the reverse. The counts MUST come from the `%(upstream:track,nobracket)` field of one `git for-each-ref` process for all local branches. That field is untranslated. The application MUST NOT read the translated tracking text of `git branch` or `git status`, such as "[ahead 2, behind 3]". This is a reviewer default.
- **FR-020**: Each count MUST show as an arrow with a number and MUST have a text alternative, such as "2 ahead, 3 behind". An equal branch MUST show an equal mark. A branch without an upstream MUST show "No upstream". A branch whose configured upstream reference does not exist MUST show "Upstream gone". Status MUST NOT depend on color alone.
- **FR-021**: The counts MUST refresh after each operation outcome, after each detected reference change, and at focus return. Counting MUST have a finite time limit and a documented bound per count. Above the bound, the label MUST show the bound with a plus sign. A count that has not finished MUST show no number, not a stale number.
- **FR-022**: The tooltip or the details of a count MUST state that the counts compare with the remote-tracking reference from the last fetch, not with the remote itself.

#### Push rejected

- **FR-023**: A rejected push of the current branch MUST show a notice in the notice band. It MUST state that the remote has commits that the local branch lacks or that the push cannot fast-forward. It MUST offer Pull with rebase, Pull with merge, Fetch, and Force push with lease, in this order. The notice MUST stay until a later push succeeds, the user dismisses it, or the branch changes.
- **FR-024**: Force push with lease MUST open a modal confirmation before the start. The confirmation MUST name the remote branch. It MUST list the remote-tracking commits that the push removes from the remote branch, with their count and their subjects, up to the documented bound. It MUST state that other people can lose work. Cancel MUST have the initial focus.
- **FR-025**: Force push with lease MUST bind the push to the exact remote-tracking commit that the confirmation showed. When the remote branch differs from that commit, Git MUST refuse the push, and no remote commit MUST be lost. The notice MUST then state that the remote branch changed since the last fetch and offer Fetch. The application MUST NOT offer a force push without a lease.
- **FR-026**: Pull with rebase and Pull with merge in the notice MUST run FR-027 with that mode. After their success, the notice MUST offer Push.

#### Pull

- **FR-027**: Pull MUST fetch the upstream of the current branch and then integrate it. When the branch is only behind, Pull MUST fast-forward. When Git's configuration (`pull.ff=false`, or `merge.ff=false` without `pull.ff` and without a configured rebase) makes Git's own pull create a merge commit, Pull MUST create a merge commit too. This is a reviewer default (plan O-2). When the branch is diverged and the user selected Pull with merge or Pull with rebase, Pull MUST use that mode, also when `pull.ff=only` is set. Otherwise, when `pull.ff=only` is set, Pull MUST refuse, whatever `pull.rebase` or `branch.<name>.rebase` names. Otherwise Pull MUST use the rebase mode that `branch.<name>.rebase` or `pull.rebase` names, else merge when `pull.ff` is `true` or `false`. When none of these is set, Pull MUST ask the user to choose Rebase or Merge for this pull. The choice MUST NOT change any configuration. The application MUST decide "only behind" and "diverged" from Git's commit counts of HEAD and the upstream after the fetch (plan D6).
- **FR-028**: Pull MUST be unavailable, with a visible reason, for a detached checkout, a branch without an upstream, an unfinished repository operation, and a missing remote, and every other case that the plan names as a refusal reason. Each reason MUST come from Git configuration values or repository reads, never from message text.
- **FR-029**: Pull MUST NOT stash, discard, or reset local changes. When Git refuses to overwrite local changes, the application MUST report the refusal, and the index and working files MUST stay as Git left them.
- **FR-030**: A pull that ends with a merge or a rebase in progress MUST show that state in the notice band at once. The Conflicted list MUST show only the files that the index records as unmerged. The application MUST NOT read conflict markers in file text. The notice MUST offer Abort and Continue for a merge or a rebase in progress, and Skip only for a rebase in progress. The application MUST take the kind of operation in progress from Git's repository state, never from message text. The same actions MUST apply to every merge or rebase in progress, whatever started it. An interactive rebase in progress MUST offer Abort only. Continue and Skip MUST then be unavailable with the reason `interactive-rebase`.
- **FR-042**: Abort MUST open a confirmation before the start. The confirmation MUST state that Git returns the branch, the index, and the working files to their state before the merge or the rebase. For a merge, it MUST state that Git can fail to restore uncommitted changes from before the merge. Cancel MUST have the initial focus.
- **FR-043**: Continue MUST be available only when a fresh read of the index shows no unmerged entry. Otherwise it MUST be unavailable and state the number of unmerged files. Continue MUST use the commit message that Git prepared, with commit hooks and signing as FR-031 requires. Continue MUST NOT stage a file. Only Mark resolved (FR-053) stages a conflicted path.
- **FR-044**: Skip MUST be available only for a rebase in progress. Its label or tooltip MUST state that it leaves the current commit out of the rebased branch. Skip MUST open a confirmation before the start. The confirmation MUST name the commit that leaves the rebased branch and state that Git discards the index and working-file changes of that step. Cancel MUST have the initial focus.
- **FR-045**: After Abort, Continue, or Skip, FR-004 MUST apply. A rebase that stops again MUST show the conflict notice again. The resolve panel and merge tools stay with branch operations.
- **FR-052**: Each entry of the Conflicted list MUST offer Mark resolved. The application MUST offer it only for a path that a fresh read of the index reports with unmerged stages. It MUST NOT read conflict markers or other file text to offer, refuse, or check the action.
- **FR-053**: Mark resolved MUST stage the current working bytes of that one path, as Git's own whole-file staging of that path does. This removes the unmerged stages of the path. It MUST use the feature 001 FR-038 Stage file path and its checks, except the refusal of conflicted entries. Immediately before publication, it MUST read the index and the working file identity and bytes again. It MUST refuse when the path no longer has unmerged stages, or when the file identity or bytes changed since the selection. A refusal MUST require refresh plus reselection. It MUST refuse a missing working file and every other entry kind that 001 FR-038 refuses, and MUST name the reason. It MUST NOT write working-file content. FR-001 and FR-004 MUST apply.
- **FR-031**: A pull MUST respect commit hooks, merge hooks, and signing, as feature 001 FR-019 requires for commit. A merge commit MUST use Git's own default message for merging the remote-tracking ref, for example "Merge remote-tracking branch 'origin/main'". This is a reviewer default. The 001 FR-019 encoding rule applies to a merge commit and to Continue.
- **FR-057**: A rebase pull is a history rewrite. An explicit user choice of a rebase action MUST count as the confirmation that constitution I asks for, as Git's own pull does. These choices count: the Pull with rebase menu item, Pull with rebase in the push-rejected notice, the Rebase choice of the FR-027 mode question, a default action that the user set to Pull with rebase, and Pull (use Git's configuration) when `pull.rebase` or `branch.<name>.rebase` selects a rebase. The application MUST NOT show a further confirmation for these choices. This is a user decision.

#### PuTTY support

- **FR-032**: The application settings MUST offer the SSH client choice "Git's own configuration", the default, and "PuTTY (plink)". The setting MUST apply only to Windows repositories. The settings MUST state that a WSL repository uses the distro's own SSH setup.
- **FR-033**: With "PuTTY (plink)", the user MUST select the plink program. The application MUST then set the SSH program, with plink's batch option, and the plink variant only in the environment of the Git processes that it starts. It MUST NOT write them into Git configuration, the Windows environment, or the registry.
- **FR-034**: Under plink, a host key that PuTTY does not know or that changed MUST make the operation fail at once instead of waiting for input. Every failed network operation under plink MUST offer Connect in a terminal, because no Git signal says that the operation used SSH. That action MUST open a visible terminal that runs `git ls-remote` for that remote through plink without the batch option, so Git parses the URL and the user can check the host key. This is a reviewer default. The application MUST NOT accept, store, or compare host keys itself.
- **FR-035**: The user MUST be able to set one PuTTY key file for each repository and remote in the application's own settings. Before an operation on that remote, the application MUST start Pageant with that key file when Pageant does not run, and MUST add the key file when Pageant runs. Pageant MUST ask for the passphrase in its own window. The application MUST read Pageant's running state only from operating system facts, never from window titles or timing.
- **FR-036**: The application MUST offer Generate or convert a key, which starts PuTTYgen. It MUST NOT read, write, or move a key file itself.
- **FR-037**: A missing or unreadable plink, Pageant, or PuTTYgen program MUST give a refusal that names the program and the path. The operation MUST NOT fall back to another SSH client.

#### Commit and push

- **FR-038**: The commit panel MUST offer Commit and push beside Commit. It MUST run the feature 001 commit. Only after a reconciled intended success MUST it start the push of FR-014. A failed, changed, or uncertain commit result MUST start no push.

#### Clone

- **FR-046**: The application MUST offer Clone in the start view and in the repository menu. The clone panel MUST take a remote URL and a full destination folder path, with the suggestion of FR-054. Clone MUST start only at an explicit start in the panel, and only with the destination that the panel shows at that start.
- **FR-054**: The clone panel MUST pre-fill the destination as an editable suggestion. The parent folder MUST be the parent of the destination of the last successful clone, from the application's own settings. Without one, it MUST be the default clone folder that the user set in the application settings. Without one, it MUST be empty. The folder name MUST be the last path segment of the URL, with trailing separators and one trailing `.git` removed. Without a path segment, the name MUST be empty. The suggestion MUST follow URL edits only until the user edits the destination. The application MUST NOT change the name to make it valid. FR-047 MUST apply to the confirmed destination.
- **FR-047**: Before the start, the application MUST read the destination from operating system facts. When the destination is a file, or a folder that holds any entry, Clone MUST refuse with the destination path, and no Git process MUST start. A missing folder or an empty folder MUST be accepted. A Windows or WSL destination MUST follow feature 001 FR-044.
- **FR-048**: Clone MUST show "Cloning into <folder>…" with Cancel and MUST follow FR-002, FR-003, FR-005, FR-006, FR-008, and FR-010. It MUST pass the URL and the folder to Git as literal values. It MUST NOT add options that change Git's defaults for the remote name, the branch, the history depth, object filters, templates, or submodules. Git MUST clone no submodule.
- **FR-049**: Under "PuTTY (plink)", Clone MUST follow FR-033, FR-034, and FR-037. The clone panel MUST offer one optional PuTTY key file for this clone. FR-035 MUST apply to that key file before the start. The application MUST NOT save it.
- **FR-050**: After failure, cancellation, or a time limit, the result MUST state whether the destination folder exists and whether it is empty, from operating system facts. The application MUST NOT delete, move, or open any file in the destination.
- **FR-051**: Clone succeeds only when Git exits with status 0 and the feature 001 open flow (001 FR-006) resolves the destination as a repository top level. The application MUST then show the new repository. The feature 001 trust decision (001 FR-025) MUST come before the first read of the new repository. Every other result MUST follow FR-050 and show Git's bounded output.

#### Visible controls

- **FR-039**: The toolbar MUST show Fetch, Pull, and Push as icon buttons with tooltips that name the action and its shortcut key. A menu beside Fetch MUST offer Fetch all remotes. Pull MUST be the split button of FR-055. Each control MUST show its unavailable reason when it cannot run.
- **FR-055**: The toolbar Pull control MUST be a split button. Its main part MUST run the default action of FR-056. Its menu MUST list, in this order: Pull (use Git's configuration), Pull with merge, Pull with rebase, Fetch, Fetch all remotes, and Set default action. Pull (use Git's configuration) MUST run FR-027 without a payload mode. Pull with merge and Pull with rebase MUST run FR-027 with that mode. Fetch and Fetch all remotes MUST run FR-011. Each item MUST show its unavailable reason when it cannot run.
- **FR-056**: Set default action MUST be a submenu with one radio item for each of the five action items of FR-055 (all items except Set default action). The default MUST be Pull (use Git's configuration). The application MUST store the chosen default in its own settings, never in Git configuration. The icon and tooltip of the main part MUST name the current default.
- **FR-040**: The history MUST refresh after each operation outcome, and the feature 002 rules for selection and memory MUST apply.

### Key Entities *(include if feature involves data)*

- **Remote**: A configured remote name and its fetch and push URLs, shown without credentials.
- **Upstream link**: A local branch, its configured remote and remote branch, and the remote-tracking reference that stands for it. The reference can be missing ("Upstream gone").
- **Ahead and behind counts**: Two numbers for one local branch and its upstream, from one reference state, with a bound and a not-finished state.
- **Fetch result**: The remotes fetched and each changed remote-tracking reference with its old and new commit.
- **Push request**: The local branch, the full destination reference, the remote, the Set upstream choice, and, for a force push, the expected remote commit.
- **Push result**: The status of the destination reference from Git's machine-readable output, the old and new commit, and the remote's message as untrusted text.
- **Pull request**: The upstream, the chosen or configured mode, and the counts after the fetch that decided fast-forward or integration.
- **Clone request**: The remote URL as a literal value, shown without credentials, the full destination folder path that the user confirmed, and an optional PuTTY key file for this clone.
- **Clone settings**: The parent folder of the last successful clone and the default clone folder that the user set. Both live in the application's own settings.
- **Operation in progress**: A merge or a rebase, as Git's repository state records it, with the number of unmerged index entries.
- **Mark resolved request**: One unmerged path, with the index state and the working file identity and bytes at selection. The application checks them again before publication.
- **SSH client setting**: "Git's own configuration" or "PuTTY (plink)", with the plink path and a PuTTY key file for each repository and remote. It holds no passphrase and no credential.
- **Default pull action**: The action that the main part of the Pull split button runs. It lives in the application's own settings.

## Success Criteria *(mandatory)*

### Measurable Outcomes

These outcomes are targets to measure, not measured results. Only recorded packaged runs on Windows 11 x64 establish them.

- **SC-001**: In every fetch, pull, and push fixture, the resulting local branches, remote-tracking references, remote branches, index, and working files match Git's own command run by hand on a copy. Fixtures use local remotes and cover fast-forward, diverged, conflicting, rejected, and remote-rejected cases.
- **SC-002**: In every rejected-push fixture, the notice offers the four choices, and each choice gives the same result as the same Git commands run by hand. In every force-push fixture where the remote changed after the last fetch, the remote branch keeps every commit.
- **SC-003**: In every count fixture, each shown ahead and behind count equals Git's own count of the two commit ranges. Fixtures cover ahead, behind, diverged, equal, no upstream, upstream gone, names with slashes, and a branch above the count bound. On the moderate fixture with 200 local branches, all counts show within 1 second after the references sidebar shows.
- **SC-004**: After cancellation or a time limit, every remote operation reaches a reconciled or explicitly unknown state within 5 seconds. A step that waits for hidden input shows the stall notice within 20 seconds after its last output or data transfer.
- **SC-005**: In fixtures with a credential in the remote URL and with a credential helper, no credential appears in any display, diagnostic, log, or copyable command.
- **SC-006**: Across every fixture of this feature, the system, global, and repository Git configuration files stay byte-identical, except for the upstream values that a selected Set upstream writes. A new repository from Clone holds only the configuration that Git's own clone writes. The Windows environment and the PuTTY registry settings stay unchanged.
- **SC-007**: In the PuTTY fixtures, fetch and push through plink and Pageant succeed. An unknown host key fails within 5 seconds and offers Connect in a terminal. A key file set for a remote reaches Pageant before the operation starts.
- **SC-008**: While any remote operation runs, the feature 001 SC-005 response targets hold: 95% of tested inputs show a visible response within 100 ms, and every tested input within 500 ms. Network time has no comparison target.
- **SC-009**: In the WSL fixtures, fetch, pull, and push give the SC-001 results through the distro's Git, and no process of an operation remains in the distro after cancellation or closure.
- **SC-010**: In every fixture, each outcome type traces to a Git exit code, a machine-readable Git output, or a repository read. A review of the requirement-to-test mapping finds no outcome decided by message text or timing.
- **SC-011**: In every clone fixture, the new repository's references, HEAD, configuration values, index, and working files match Git's own clone of the same URL in another folder. Each refusal for a non-empty destination starts no Git process and leaves every destination file byte-identical. After each cancellation, the reported folder state matches the folder on disk. No clone starts with a destination that the panel did not show at the explicit start.
- **SC-012**: In every merge and rebase conflict fixture, Abort, Continue, and Skip give the same HEAD, index, working files, and operation state as the same Git commands run by hand on a copy. Continue stays unavailable while the index has an unmerged entry, including a fixture where a resolved file still holds text like conflict markers.
- **SC-013**: In a session that opens repositories, waits 30 minutes, and returns focus several times without a user network action, the local remotes and the SSH server record no connection.
- **SC-014**: In every conflict fixture, Mark resolved gives the same index as Git's own whole-file staging of that path on a copy, and every working-file byte stays unchanged. In every fixture where another process changes or stages the file after the selection, Mark resolved refuses and changes no index entry. A file that still holds text like conflict markers stages normally.

## Assumptions

- Feature 002 ships before this feature. Its full history of all branches, its references sidebar virtualization, and its refs-changed notice are available.
- The minimum Git versions of feature 001 apply: Git for Windows 2.55.0 and distro Git 2.55.0. They support Git's machine-readable push and fetch output, the lease option, and numeric commit counts.
- Qualification uses local bare remotes and a disposable local SSH server with a test key pair. It never contacts a public host or the user's real remotes.
- Git's machine-readable push output gives a fixed status token for each reference, "rejected" or "remote rejected". The reason text after it is human-readable. So the push-rejected notice covers every "rejected" status with one text and does not name the exact reason. This is a reviewer default.
- A lease failure needs no message parsing. The application knows that it sent a lease, so a "rejected" status of a force push with lease means that the remote branch changed. This is a reviewer default.
- Git's tracking text for ahead and behind is translated in `git branch` and `git status`, so the application does not read it. This is a reviewer default.
- The counts come from `git for-each-ref` with `%(upstream:track,nobracket)`. That text is untranslated, and one process serves all branches. One `rev-list` per branch needs about 400 processes and misses SC-003. This is a reviewer default (plan O-1).
- Pull (use Git's configuration) fetches, then fast-forwards, or uses the configured mode, or asks for the mode. It never changes `pull.rebase` or the branch settings. This is a reviewer default.
- A merge from Pull uses Git's default message for the remote-tracking ref, such as "Merge remote-tracking branch 'origin/main'". Git's own pull writes "Merge branch 'main' of <url>". This is a reviewer default (plan O-3).
- Fetch all remotes skips each remote that Git's `git fetch --all` skips (`remote.<name>.skipFetchAll`, `skipDefaultUpdate`). The last value of the two names decides, as in Git. This is a reviewer default (plan O-4).
- Push follows the destination of Git's own push, also in a triangular workflow, where the push remote differs from the fetch remote. Under `push.default=matching`, Git decides from the remote's branches at push time, so the push panel shows. A mirror remote makes Push unavailable with its reason, although Git would push. These are reviewer defaults (plan D4).
- The SSH qualification server is the test package `ssh2` when it runs under Bun. Else it is a WSL `sshd` when `openssh-server` is already installed in the distro. Else the SSH cases stay unverified. This is a reviewer default (plan O-5).
- PuTTY 0.75 or later is needed. The application refuses an older Pageant with its version. This is a reviewer default (plan O-6).
- Pageant and PuTTYgen are the programs in the folder of the selected plink. This is a reviewer default (plan O-7).
- A remote with more than one push URL makes Push unavailable with its reason. This is a reviewer default (plan O-11).
- Lease subjects stop at 100. The count display bound is 10,000. The clone name splits at `/`, `\`, and `:`. These are reviewer defaults.
- A merge or a rebase in progress allows Fetch and Fetch all remotes, because they change only remote-tracking references. It refuses Pull, Push, Force push with lease, Commit and push, and Clone into that repository. This is a reviewer default.
- When the branch is only behind and Git's own pull makes a merge commit, Pull makes a merge commit too. Git does this for `pull.ff=false`, and for `merge.ff=false` without `pull.ff` and without a configured rebase (research R16 e). This is a reviewer default (plan O-2).
- Fetch and Fetch all remotes follow the user's pruning and tag settings. The application adds no prune option. This is a reviewer default.
- Fetch, Pull, Push, and Clone never recurse into submodules. Update submodules of feature 001 stays the only submodule network action. This is a reviewer default.
- Set upstream is selected by default in the push panel for a branch without an upstream, as in Git Extensions. The panel names the configuration change. This is a reviewer default.
- Plink and Git give no machine-readable reason for an SSH failure, such as an unknown host key or a refused key. This is a contract gap. So every failed SSH operation under plink offers Connect in a terminal, and the notice names no cause. This is a reviewer default.
- No Git signal says that a network operation used SSH. So every failed network operation under plink offers Connect in a terminal. It runs `git ls-remote` through plink without the batch option, so Git parses the URL. This is a reviewer default (plan O-9 and O-10).
- Plink runs with its batch option, so a host key prompt fails at once. Connect in a terminal is the accept step. The application never stores host keys. The project brief states this rule.
- Git Extensions stores the key file as `remote.<name>.puttykeyfile` in the repository configuration. That value is repository-controlled. The settings show it as a proposal only. The application uses a key file only after the user saves it in the application settings. It never writes the Git value. This is a reviewer default (plan O-8).
- The Pull split button follows Git Extensions, which lets the user pick the pull action from a menu and set a default. The application stores the default in its own settings. An explicit rebase choice is the confirmation of the history rewrite. The user chose this model.
- The SSH client default is "Git's own configuration". So users who never select PuTTY see no change in how Git connects. This is a reviewer default.
- Force push with lease is the only force push. A plain force push is not offered. This is a reviewer default.
- The push-rejected notice is a notice band row, not a dialog, as in the feature 001 notice design. Only Force push with lease opens a modal confirmation, because it is destructive. This is a reviewer default.
- Commit and push is in scope because the project brief lists it for this feature. It adds no new Git behavior.
- Clone is P2. Fetch, counts, push, push-rejected recovery, and pull serve each work day. Clone runs once for each repository, and Git plus the feature 001 open flow covers it until then. The user chose Clone for this feature.
- The clone panel suggests the destination from the last clone parent and the last path segment of the URL. The suggestion is a convenience, not a decision from Git output. The user sees and confirms the path before the start, so the no-heuristics rule does not apply to it. The user chose this suggestion.
- The application never deletes a folder after a failed or cancelled clone. Git can leave a partial folder when its process ends. The result names the folder, and the user decides.
- The conflict actions apply to every merge or rebase in progress, not only to one that a pull of this session started. Git's state does not record the starting command. This is a reviewer default.
- Mark resolved writes the stage-0 entry with the working-file mode that Git's status reports for the conflicted path. On Windows, that mode equals Git's own whole-file staging, also for an executable file. Symbolic links stay refused. This is a reviewer default (plan D7).
- The user edits conflicted files in an editor and marks each one resolved in the application. Continue becomes available when the next index read shows no unmerged entry. The user chose Mark resolved.
- Mark resolved runs from the stage bar of a Conflicted file, and the Space key runs it, as for Stage file. The button reads "Mark resolved (Space)". This is a reviewer default (plan D12).
- The status and the close prompt name a running sync by its action: "Fetch", "Fetch all remotes", "Pull", "Push", "Force push with lease", "Abort", "Continue", or "Skip". A pull step that integrates after the mode choice is also "Pull". A running clone is "Clone". The start frame of a sync carries its action, and the shell close prompt reads the name from it. This is a reviewer default (plan D12).
- The application never fetches on its own. The user chose network use only on user action, so counts can be older than the remote. FR-022 states this.
- Git Extensions detects a rejected push by matching its English output text. This feature uses Git's machine-readable push output instead, so it borrows the flow but not the detection.
