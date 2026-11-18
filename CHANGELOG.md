# Changelog

Each section lists the changes that a user of Arbareto sees in that release.

## [0.1.3]

A preview release for Windows 11 x64.

### Changed

- Cancel of a large revert now ends faster. At 10,000 files, the result shows in about 2.8 s instead of about 8 s.
- A revert of many files sends its progress at most 4 times per second. This lowers the memory peak of the window.
- The result of a large revert is much smaller. The status bar still names the first 20 files that did not revert.
- In WSL repositories, the submodule marks of the Commit view load faster. Arbareto now starts one WSL call per step, not one per Git command. In our tests, the marks of 100 submodules loaded in about 11 s instead of about 17 s.
- A Cancel press while Arbareto shows "Checking the result…" now shows "Cancel requested".
- A click on selected text in Blame keeps the selection, the scroll position and the focus on the selected line.
- Before the branch list loads, a branch key or a right-click on a branch shows "The branches are still loading." Arbareto then loads the branches again.

## [0.1.2] - 2026-11-16

A preview release for Windows 11 x64.

### Added

- You can select static text and copy it with Ctrl+C. This includes the submodule preview in the Commit view and in History, the code text of Blame lines, the notices, the status texts of an operation, and the path heading of a comparison.

### Changed

- When Git rejects a remote branch delete for a stale lease, the message now starts with "Git deleted nothing: <reason>." The reason is the text of Git.
- When Git gives no reason text, the message shows only "Git deleted nothing."
- Arbareto does not delete a remote branch through a remote helper. This includes a `<transport>::` URL, a `remote.<name>.vcs` entry, `ftp://` and `ftps://` URLs, and an unknown or uppercase scheme. The message is "The remote of <tracking> pushes through a remote helper. Git cannot show that a remote helper keeps the lease, so Arbareto does not delete this branch."
- Arbareto does not force push with lease through a remote helper. The status bar shows "This branch pushes through a remote helper. Git cannot show that a remote helper keeps the lease, so Arbareto does not force push this branch."
- For an `http://` or `https://` push URL, the confirmations of a remote branch delete and of a force push add "Over a dumb HTTP server, Git cannot check this."
- A `GIT_SMART_HTTP` value in your environment no longer reaches Git. An HTTP push thus keeps the lease check.
- The History message filter shows its key in a tooltip: "Filter commit messages (Ctrl+F)".
- In a repository with many submodules, the Commit view shows the local-edit marks of the first submodules sooner. Arbareto reads the submodules in groups of 16 and shows the marks of each group when it arrives. The marks of a submodule no longer wait for all other submodules.
- A Cancel right after the start of an operation now always counts. The status bar shows "Cancel requested" at once. Before, Arbareto could lose a Cancel that came before the first progress report, and the operation ran to the end. This occurred in all versions since 0.1.0. It affects Revert, Stage, Commit, fetch, pull, push, and the other operations in the status bar. In History, the Cancel and Escape of a message search now count in the same way.

## [0.1.1] - 2026-11-13

A preview release for Windows 11 x64.

### Changed

- A rejected force push with lease or a rejected remote branch delete shows the reason text of Git: "PUSH_REJECTED rejected: <reason>".
- Arbareto reports a stale lease only when a new read of the remote branch shows that it changed.
- For a force push, this read uses the push URL when it differs from the fetch URL. This includes the form `user@host:path`.
- In WSL, Arbareto runs the git command of a distro only when it is an ELF program file. A script or an unreadable file gets a message with the fix.
- In WSL, you can clone into a folder that does not exist yet.
- In a filtered History, a row that needs more than 24 graph lanes draws no lines. It now names its matching ancestors.
- The README and the release notes give the attestation command with `--signer-workflow`. The command then accepts only files from the Arbareto release workflow.
- When Git stalls during a clone, the Clone dialog shows "Git may be waiting for input." and the stall notice. The notice offers Cancel and "Copy command".
- A revert shows "Checking the result…" while Arbareto reads the status again.
- While the status read after an operation runs, the status no longer shows "State unknown". The actions stay blocked until the read ends.
- After Refresh or a restart of the Git service, the footer no longer stays at "State unknown" or "Refreshing". The actions become available again.
- In the worktree, branch, and commit menus, the reason "The status read after the last operation is still running." shows only in the tooltip.
- Screen readers get distinct names for the two Occitan licence texts: "Licence text of Occitan, 1 of 2" and "Licence text of Occitan, 2 of 2".
- Keyboard focus stays in place when the window switches to the narrow layout.
- Arbareto hides a password with "?" or "#" in a URL, as Git does.
- Arbareto accepts Git for Windows by the x64 header of its program file, not by the text of `git version --build-options`.

## [0.1.0] - 2026-11-11

The first preview release for Windows 11 x64.

### Added

- History of the whole repository, with a commit graph in branch lanes and the details of the selected commit.
- The changed files of a commit in the history view, with their diffs.
- Blame of a file.
- Commit message search, with steps through the matches in the full graph.
- Working changes and a diff view. Stage and unstage files, folders, hunks, or selected lines.
- Revert selected lines, hunks, files, or all unstaged changes, after a confirmation.
- Delete files and folders from the Commit view.
- Folders come first in every file tree. Show a folder in Explorer.
- Edit an ignore file with a live preview.
- Open a submodule as a repository, and go back to its parent.
- A changed submodule shows its new and removed commits in the preview, and its local edits in the Commit view.
- The full branch name and its tracking state. Branches that lost their upstream are marked.
- Spell check of the commit message. A marked word offers suggestions, Ignore, and Add to dictionary. English works offline.
- More spell check languages: download a dictionary or import its files, and select up to 3 languages. Settings lists the personal word list.
- Commit, amend the last commit, and commit and push in one step.
- Fetch, pull, and push with the upstream branch. You choose the default pull mode. Ahead and behind counts show on each branch.
- Recovery from a rejected push, with force push with lease after a confirmation.
- Clone a repository.
- Branches: switch, create, rename, delete, merge, and rebase. Resolve a conflicted file, or open it in your merge tool.
- Delete a remote branch from its menu, after a confirmation. The local branch Delete dialog can also delete its remote branch. Git refuses the delete when the remote branch changed since the last fetch.
- A merge or a rebase with conflicts lists the conflicted files first and offers Resolve conflicts.
- A commit menu in History: check out a commit, create a branch or a tag, and copy the commit ID.
- Reset the current branch to a commit: Soft, Mixed, or Hard. Hard asks for a confirmation first.
- Cherry-pick a commit or revert it. Abort or continue a stopped cherry-pick or revert.
- A sidebar with branches, remote-tracking branches, tags, worktrees, and submodules. Add and remove worktrees. Update submodules.
- The Submodules group shows a folder tree. Each folder shows the count of all submodules below it, nested ones included. Above 1,024 folders, the group shows the submodule rows without folder rows, and one line states this.
- Each checked-out submodule shows its branch, or "no branch" for a detached HEAD. A branch with an upstream shows its ahead and behind counts. A gone upstream is marked.
- The Submodules group and Update submodules work with up to 1,024 submodules, nested ones included. The Commit view checks local edits in the first 256 submodules of the open repository, in Git index order. Only these submodules can show the "modified content" or "untracked content" mark.
- The fold-out panel "Keys in the tree" below the Submodules group lists the tree keys and the submodule menu items. It starts open. Arbareto keeps its open or closed state after a restart.
- Git settings by scope: system, global, and local.
- Repositories inside WSL 2 distros, through the Git of the distro. Global Git settings of the distro can be saved.
- A repository trust prompt before Arbareto runs programs that the repository configures.
- Keyboard shortcuts and keyboard focus for the main actions.
- System, light, and dark themes, with three dark palettes. The interface supports Windows contrast themes.
- About shows the version, the preview marker, the build commit, and the third-party notices.
- In a preview build, About has two buttons. "Source at this commit" opens the source of the build commit. "Hunspell source" opens the Hunspell source archive of the release.
