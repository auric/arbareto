# Feature Specification: Remote Sync

**Feature Branch**: `003-remote-sync`

**Feature Directory**: `specs/003-remote-sync`

**Created**: 2026-10-12

**Status**: Draft

**Input**: User description: "Fetch, pull, and push for the open repository, with progress, Cancel, and a bounded deadline. A rejected push offers pull with rebase, pull with merge, force push with lease, and fetch. Show ahead and behind counts for the current branch and its upstream in the history graph and the branch list. Support PuTTY, plink, and Pageant for SSH remotes. Use the credential helpers that the user configured. Never store or log credentials, and never change the user's Git configuration silently. Avoid feature overload."

## User Scenarios & Testing *(mandatory)*

Feature 001 has no remote operation except Update submodules, and it hides Fetch, Pull, and Push. Feature 002 shows the full history of all branches. This feature adds the remote operations for the open repository and shows how far each branch is ahead of its upstream or behind it. The order of the journeys follows a normal work day: fetch, see the difference, push, recover from a rejected push, pull, then SSH with PuTTY.

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

1. **Given** a current branch that is only behind its upstream. **When** I select Pull. **Then** the branch moves forward to the upstream commit, and the working files follow. No merge commit appears.
2. **Given** a diverged branch and Git configuration that names a pull mode for this branch. **When** I select Pull. **Then** the pull uses that mode, and the result names it.
3. **Given** a diverged branch and no configured pull mode. **When** I select Pull. **Then** the application fetches, and then asks me to choose Rebase or Merge for this pull. It changes no configuration.
4. **Given** uncommitted changes that Git refuses to overwrite. **When** I pull. **Then** Git refuses, and I see its bounded output. My working files and index stay unchanged.
5. **Given** a pull that stops with conflicts. **When** it ends. **Then** the notice band names the merge or the rebase in progress, and the Conflicted list shows the files that the index records as unmerged. The notice offers the conflict actions of FR-030.
6. **Given** a pull hook or a filter that needs trust approval. **When** I select Pull. **Then** the feature 001 trust rules apply before any Git process starts.
7. **Given** a slow pull. **When** I cancel it. **Then** the application re-reads HEAD, the index, and the operation state, and reports the actual result. It never claims rollback.

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

### User Story 7 - Commit and push in one step (Priority: P3)

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

## Requirements *(mandatory)*

### Scope Boundaries

Include Fetch for the remote of the current branch and Fetch all remotes. Include Pull into the current branch by fast-forward, merge, or rebase. Include Push of the current branch to one destination, with Set upstream for a branch without an upstream. Include the push-rejected notice with its four choices, and Force push with lease behind a confirmation. Include ahead and behind counts in the toolbar, the references sidebar, and the history branch labels. Include Commit and push. Include PuTTY support for SSH remotes of Windows repositories: plink, Pageant start with a key file, and a PuTTYgen launch.

Exclude Clone. [NEEDS CLARIFICATION: Does Clone belong in this feature? The project brief lists it for remote sync, but the user's 003 list omits it. Recommended: no. Clone needs a destination flow, a new trust decision, and a first checkout, so it comes with a later repository feature.]

Exclude branch operations: checkout, create, rename, delete, merge into current, rebase onto, reset, cherry-pick, and revert. Exclude the conflict resolution panel and its Continue and Skip actions. Exclude remote management: add, rename, remove, and edit URLs. Exclude push of tags, push of other branches, push of several branches in one action, and deletion of remote branches. Exclude the Git configuration editor and its presets. Exclude credential setup, credential storage, SSH key creation by the application, and edits of PuTTY settings. Exclude provider integrations, such as pull requests. Exclude automatic or scheduled fetch. [NEEDS CLARIFICATION: Should the application fetch on its own, for example on a timer or when a repository opens? Recommended: no. Network access then happens only at an explicit user action, and the counts state that they compare with the last fetch.]

### Changes to feature 001 requirements

This feature changes these feature 001 requirements for builds that include it. The 001 text stays unchanged in its own spec.

- **001 FR-003**: Push with Set upstream MAY write the upstream of the current branch into the repository configuration, only after the user selects it in the push panel. That is the second named exception to "no configuration change".
- **001 FR-027**: Force push with lease is allowed behind the FR-024 confirmation of this feature. Every other force operation stays excluded.
- **001 FR-051**: Fetch, Pull, and Push also use the network. The rules of 001 FR-051 apply to them: Git's own transport policy, no hidden terminal prompt, the stall notice, and no credential setup. One exception exists. When the user selects the SSH client "PuTTY (plink)" in the application settings, the application sets the SSH program and its variant for the Git processes that it starts. It never writes them into any Git configuration file or the user environment.
- **001 FR-056**: Fetch, Pull, and Push become visible. Stash and the other later controls stay hidden.
- **001 FR-057**: Each local branch with an upstream shows its ahead and behind counts (FR-019 of this feature).

### Functional Requirements

#### Common rules for remote operations

- **FR-001**: Fetch, Pull, Push, and Commit and push MUST count as mutations for feature 001 FR-015, FR-016, FR-023, and FR-024. While one runs, another mutation of the same repository MUST be refused as busy. Reads MUST stay available.
- **FR-002**: Each remote operation MUST show its step text with Cancel: "Fetching from <remote>…", "Pulling from <remote>…", "Rebasing…", "Merging…", or "Pushing to <remote>…". It MUST show a percentage only where Git prints its untranslated progress counter. It MUST NOT show a computed or estimated percentage.
- **FR-003**: Each remote operation MUST use the time limits of feature 001: a stall notice after 15 seconds without output and without data transfer, an end after 5 minutes without output and without data transfer, and an end after 4 hours. The stall notice MUST name a hidden prompt or a sign-in window and offer Cancel and a copyable terminal command.
- **FR-004**: After success, failure, cancellation, or a time limit, the application MUST re-read the affected references, HEAD, the index, and the repository operation state. It MUST report the observed result. It MUST NOT claim rollback, retry automatically, or undo a change.
- **FR-005**: Every outcome MUST come from Git exit codes that Git documents for that command, from Git's machine-readable output, or from a fresh read of repository state. The application MUST NOT classify any result by Git's message text, by the remote's message text, or by timing. When no such signal exists, the outcome MUST state that the cause is unknown and show Git's bounded output.
- **FR-006**: Failure output MUST follow the feature 001 FR-019 output rules: bounded, plain text, no terminal control sequences, no credentials in URLs, and never logged. Messages from the remote MUST follow the same rules.
- **FR-007**: Operations of this feature MUST NOT start Git inside a submodule and MUST NOT recurse into submodules, whatever the configuration selects. After an operation that changed a recorded submodule commit, the feature 001 FR-053 notice MUST show.
- **FR-008**: The application MUST use Git's own transport policy, credential helpers, and SSH configuration unchanged, except for FR-033. It MUST NOT store, cache, or log credentials. It MUST NOT add, change, or remove any Git configuration value without an explicit user selection that names the value. Set upstream (FR-016) is the only such selection in this feature.
- **FR-009**: Repository-controlled hooks and filters that an operation can run MUST follow feature 001 FR-025. This covers the reference-transaction hook during fetch and pull, the pre-push hook, the merge and rebase hooks, and the checkout filters of a pull.
- **FR-010**: In a WSL repository, every operation of this feature MUST run through the distro's Git, with its network access inside the distro. The distro's own credentials and SSH setup MUST apply. Feature 001 FR-045 and FR-046 MUST apply.

#### Fetch

- **FR-011**: Fetch MUST fetch the remote that Git's own fetch without arguments selects for the current branch. Fetch all remotes MUST fetch every configured remote. Both MUST follow the user's configuration for pruning and tags and MUST NOT add options that change them.
- **FR-012**: The fetch result MUST list each updated, created, and deleted remote-tracking reference from Git's machine-readable fetch output. It MUST state when nothing changed. Above the documented limit, it MUST state the counts and the limit.
- **FR-013**: After a fetch that the user started, the history view and the references sidebar MUST refresh without the feature 002 refs-changed notice, and MUST keep the selected commit when the new references reach it.

#### Push

- **FR-014**: Push MUST push only the current branch to one destination: the remote branch that Git's own push of the current branch selects. Before the start, the destination MUST be known as a full reference name. When Git's configuration gives no destination for the current branch, FR-016 MUST apply.
- **FR-015**: Push MUST read the result for each reference from Git's machine-readable push output. A reference with the status "rejected" MUST start the push-rejected flow (FR-023). A reference with the status "remote rejected" MUST show "Rejected by the remote" with the remote's message, and MUST offer no pull or force choice. Push MUST NOT read the reason text that follows the status, because Git documents it as human-readable only.
- **FR-016**: For a branch without an upstream, Push MUST open a panel before the start. The panel MUST show the remote, with a choice when several remotes exist, and the remote branch name, which defaults to the local branch name. It MUST show the option "Set upstream", selected by default. The panel MUST state that this option writes the upstream of this branch into the repository configuration. Push MUST start only at an explicit start in the panel.
- **FR-017**: Push MUST be unavailable, with a visible reason, for a detached checkout, a branch without commits, an unfinished repository operation, and a missing remote.
- **FR-018**: After a push, the remote-tracking reference of the destination MUST show the value that Git's push output reports.

#### Ahead and behind counts

- **FR-019**: The application MUST show the ahead and behind counts of the current branch in the toolbar, of each local branch with an upstream in the references sidebar, and of each local branch label in the history graph. Ahead is the number of commits that the branch reaches and its upstream does not reach. Behind is the reverse. The counts MUST come from Git's numeric output for exactly these two commit ranges. The application MUST NOT read Git's translated tracking text, such as "[ahead 2, behind 3]".
- **FR-020**: Each count MUST show as an arrow with a number and MUST have a text alternative, such as "2 ahead, 3 behind". An equal branch MUST show an equal mark. A branch without an upstream MUST show "No upstream". A branch whose configured upstream reference does not exist MUST show "Upstream gone". Status MUST NOT depend on color alone.
- **FR-021**: The counts MUST refresh after each operation outcome, after each detected reference change, and at focus return. Counting MUST have a finite time limit and a documented bound per count. Above the bound, the label MUST show the bound with a plus sign. A count that has not finished MUST show no number, not a stale number.
- **FR-022**: The tooltip or the details of a count MUST state that the counts compare with the remote-tracking reference from the last fetch, not with the remote itself.

#### Push rejected

- **FR-023**: A rejected push of the current branch MUST show a notice in the notice band. It MUST state that the remote has commits that the local branch lacks or that the push cannot fast-forward. It MUST offer Pull with rebase, Pull with merge, Fetch, and Force push with lease, in this order. The notice MUST stay until a later push succeeds, the user dismisses it, or the branch changes.
- **FR-024**: Force push with lease MUST open a modal confirmation before the start. The confirmation MUST name the remote branch. It MUST list the remote-tracking commits that the push removes from the remote branch, with their count and their subjects, up to the documented bound. It MUST state that other people can lose work. Cancel MUST have the initial focus.
- **FR-025**: Force push with lease MUST bind the push to the exact remote-tracking commit that the confirmation showed. When the remote branch differs from that commit, Git MUST refuse the push, and no remote commit MUST be lost. The notice MUST then state that the remote branch changed since the last fetch and offer Fetch. The application MUST NOT offer a force push without a lease.
- **FR-026**: Pull with rebase and Pull with merge in the notice MUST run FR-027 with that mode. After their success, the notice MUST offer Push.

#### Pull

- **FR-027**: Pull MUST fetch the upstream of the current branch and then integrate it. When the branch is only behind, Pull MUST fast-forward. When the branch is diverged, Pull MUST use the mode that Git's configuration names for this branch or for all pulls. When no mode is configured, Pull MUST ask the user to choose Rebase or Merge for this pull. The choice MUST NOT change any configuration. The application MUST decide "only behind" and "diverged" from the counts of FR-019 after the fetch.
- **FR-028**: Pull MUST be unavailable, with a visible reason, for a detached checkout, a branch without an upstream, an unfinished repository operation, and a missing remote.
- **FR-029**: Pull MUST NOT stash, discard, or reset local changes. When Git refuses to overwrite local changes, the application MUST report the refusal, and the index and working files MUST stay as Git left them.
- **FR-030**: A pull that ends with a merge or a rebase in progress MUST show that state in the notice band at once. The Conflicted list MUST show only the files that the index records as unmerged. The application MUST NOT read conflict markers in file text. The notice MUST offer these conflict actions: [NEEDS CLARIFICATION: Which conflict actions does this feature offer after a pull? Recommended: Abort only, behind a confirmation that states Git's limits, plus copyable terminal commands for Continue and Skip. Continue, Skip, and the resolve panel stay with branch operations.]
- **FR-031**: A pull MUST respect commit hooks, merge hooks, and signing, as feature 001 FR-019 requires for commit. A merge commit MUST use Git's own default message.

#### PuTTY support

- **FR-032**: The application settings MUST offer the SSH client choice "Git's own configuration", the default, and "PuTTY (plink)". The setting MUST apply only to Windows repositories. The settings MUST state that a WSL repository uses the distro's own SSH setup.
- **FR-033**: With "PuTTY (plink)", the user MUST select the plink program. The application MUST then set the SSH program, with plink's batch option, and the plink variant only in the environment of the Git processes that it starts. It MUST NOT write them into Git configuration, the Windows environment, or the registry.
- **FR-034**: Under plink, a host key that PuTTY does not know or that changed MUST make the operation fail at once instead of waiting for input. Every failed SSH operation under plink MUST offer Connect in a terminal. That action MUST open a visible terminal that runs plink once against that host and port, without the batch option, so the user can check the host key. The application MUST NOT accept, store, or compare host keys itself.
- **FR-035**: The user MUST be able to set one PuTTY key file for each remote in the application's own settings. Before an operation on that remote, the application MUST start Pageant with that key file when Pageant does not run, and MUST add the key file when Pageant runs. Pageant MUST ask for the passphrase in its own window. The application MUST read Pageant's running state only from operating system facts, never from window titles or timing.
- **FR-036**: The application MUST offer Generate or convert a key, which starts PuTTYgen. It MUST NOT read, write, or move a key file itself.
- **FR-037**: A missing or unreadable plink, Pageant, or PuTTYgen program MUST give a refusal that names the program and the path. The operation MUST NOT fall back to another SSH client.

#### Commit and push

- **FR-038**: The commit panel MUST offer Commit and push beside Commit. It MUST run the feature 001 commit. Only after a reconciled intended success MUST it start the push of FR-014. A failed, changed, or uncertain commit result MUST start no push.

#### Visible controls

- **FR-039**: The toolbar MUST show Fetch, Pull, and Push as icon buttons with tooltips that name the action and its shortcut key. A menu beside Fetch MUST offer Fetch all remotes. Each control MUST show its unavailable reason when it cannot run.
- **FR-040**: The history MUST refresh after each operation outcome, and the feature 002 rules for selection and memory MUST apply.

### Key Entities *(include if feature involves data)*

- **Remote**: A configured remote name and its fetch and push URLs, shown without credentials.
- **Upstream link**: A local branch, its configured remote and remote branch, and the remote-tracking reference that stands for it. The reference can be missing ("Upstream gone").
- **Ahead and behind counts**: Two numbers for one local branch and its upstream, from one reference state, with a bound and a not-finished state.
- **Fetch result**: The remotes fetched and each changed remote-tracking reference with its old and new commit.
- **Push request**: The local branch, the full destination reference, the remote, the Set upstream choice, and, for a force push, the expected remote commit.
- **Push result**: The status of the destination reference from Git's machine-readable output, the old and new commit, and the remote's message as untrusted text.
- **Pull request**: The upstream, the chosen or configured mode, and the counts after the fetch that decided fast-forward or integration.
- **SSH client setting**: "Git's own configuration" or "PuTTY (plink)", with the plink path and a PuTTY key file for each remote. It holds no passphrase and no credential.

## Success Criteria *(mandatory)*

### Measurable Outcomes

These outcomes are targets to measure, not measured results. Only recorded packaged runs on Windows 11 x64 establish them.

- **SC-001**: In every fetch, pull, and push fixture, the resulting local branches, remote-tracking references, remote branches, index, and working files match Git's own command run by hand on a copy. Fixtures use local remotes and cover fast-forward, diverged, conflicting, rejected, and remote-rejected cases.
- **SC-002**: In every rejected-push fixture, the notice offers the four choices, and each choice gives the same result as the same Git commands run by hand. In every force-push fixture where the remote changed after the last fetch, the remote branch keeps every commit.
- **SC-003**: In every count fixture, each shown ahead and behind count equals Git's own count of the two commit ranges. Fixtures cover ahead, behind, diverged, equal, no upstream, upstream gone, names with slashes, and a branch above the count bound. On the moderate fixture with 200 local branches, all counts show within 1 second after the references sidebar shows.
- **SC-004**: After cancellation or a time limit, every remote operation reaches a reconciled or explicitly unknown state within 5 seconds. A step that waits for hidden input shows the stall notice within 20 seconds after its last output or data transfer.
- **SC-005**: In fixtures with a credential in the remote URL and with a credential helper, no credential appears in any display, diagnostic, log, or copyable command.
- **SC-006**: Across every fixture of this feature, the system, global, and repository Git configuration files stay byte-identical, except for the upstream values that a selected Set upstream writes. The Windows environment and the PuTTY registry settings stay unchanged.
- **SC-007**: In the PuTTY fixtures, fetch and push through plink and Pageant succeed. An unknown host key fails within 5 seconds and offers Connect in a terminal. A key file set for a remote reaches Pageant before the operation starts.
- **SC-008**: While any remote operation runs, the feature 001 SC-005 response targets hold: 95% of tested inputs show a visible response within 100 ms, and every tested input within 500 ms. Network time has no comparison target.
- **SC-009**: In the WSL fixtures, fetch, pull, and push give the SC-001 results through the distro's Git, and no process of an operation remains in the distro after cancellation or closure.
- **SC-010**: In every fixture, each outcome type traces to a Git exit code, a machine-readable Git output, or a repository read. A review of the requirement-to-test mapping finds no outcome decided by message text or timing.

## Assumptions

- Feature 002 ships before this feature. Its full history of all branches, its references sidebar virtualization, and its refs-changed notice are available.
- The minimum Git versions of feature 001 apply: Git for Windows 2.55.0 and distro Git 2.55.0. They support Git's machine-readable push and fetch output, the lease option, and numeric commit counts.
- Qualification uses local bare remotes and a disposable local SSH server with a test key pair. It never contacts a public host or the user's real remotes.
- Git's machine-readable push output gives a fixed status token for each reference, "rejected" or "remote rejected". The reason text after it is human-readable. So the push-rejected notice covers every "rejected" status with one text and does not name the exact reason. This is a reviewer default.
- A lease failure needs no message parsing. The application knows that it sent a lease, so a "rejected" status of a force push with lease means that the remote branch changed. This is a reviewer default.
- Git's tracking text for ahead and behind is translated, so the application uses Git's numeric counts instead. This is a reviewer default.
- The toolbar Pull fetches, then fast-forwards, or uses the configured mode, or asks for the mode. It never changes `pull.rebase` or the branch settings. This is a reviewer default.
- Fetch and Fetch all remotes follow the user's pruning and tag settings. The application adds no prune option. This is a reviewer default.
- Fetch, Pull, and Push never recurse into submodules. Update submodules of feature 001 stays the only submodule network action. This is a reviewer default.
- Set upstream is selected by default in the push panel, as in Git Extensions. The panel names the configuration change. This is a reviewer default.
- Plink and Git give no machine-readable reason for an SSH failure, such as an unknown host key or a refused key. This is a contract gap. So every failed SSH operation under plink offers Connect in a terminal, and the notice names no cause. This is a reviewer default.
- Plink runs with its batch option, so a host key prompt fails at once. Connect in a terminal is the accept step. The application never stores host keys. The project brief states this rule.
- The PuTTY key file for each remote lives in the application's own settings. Git Extensions stores it as `remote.<name>.puttykeyfile` in the Git configuration. The application reads that value as the initial key file when its own setting is empty, and never writes it. This is a reviewer default.
- The SSH client default is "Git's own configuration". So users who never select PuTTY see no change in how Git connects. This is a reviewer default.
- Force push with lease is the only force push. A plain force push is not offered. This is a reviewer default.
- The push-rejected notice is a notice band row, not a dialog, as in the feature 001 notice design. Only Force push with lease opens a modal confirmation, because it is destructive. This is a reviewer default.
- Commit and push is in scope because the project brief lists it for this feature. It adds no new Git behavior.
- Git Extensions detects a rejected push by matching its English output text. This feature uses Git's machine-readable push output instead, so it borrows the flow but not the detection.
