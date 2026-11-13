# Feature Specification: History Commit Menu

**Feature Branch**: `010-commit-menu`

**Feature Directory**: `specs/010-commit-menu`

**Created**: 2026-11-04

**Status**: Draft

**Input**: User description (2026-11-04): a context menu on a commit row in History, as feature 010. The items are Check out this commit (detached HEAD), Create branch here, Create tag here, and Cherry-pick commit. The other items are Revert commit, Reset current branch to here, and Copy commit ID. Ship all items before the first public package, v0.1.0. Inputs: the user decisions of 2026-11-04 and the design plan with its Git probes of 2026-11-04 (local scratch).

## Clarifications

### Session 2026-11-04

The user gave these decisions on 2026-11-04. Each decision is binding.

- Q: Which items does the commit menu hold, and when do they ship? → A: The seven items of the Input line. All items ship before v0.1.0 (FR-011).
- Q: Which reset modes does Reset offer? → A: Soft, Mixed, and Hard. Mixed is preselected each time the popover opens (FR-040).
- Q: How does Hard ask? → A: With the 008 confirmation. It is an alert dialog, and Cancel has the first focus. No button is the default, and there is no backup (FR-044).
- Q: Which tag kind does Create tag preselect? → A: Lightweight. The user chose this option. "The popover still lets you type a message, which makes it annotated." So a typed message makes the tag annotated (FR-030).
- Q: What do Cherry-pick and Revert do on a merge commit? → A: They offer a parent choice. Parent 1 is preselected (FR-050).
- Q: What does Hard do with an untracked file in the way? → A: It refuses and lists the paths, as the 004 Discard-and-switch does. Git replaces ignored files in the way, and the dialog states their count (FR-043, FR-044).
- Q: Which budgets apply? → A: The budgets of SC-010a to SC-011 and the records apply. The design plan proposed them.
- Q: Do cold runs have a budget? → A: Yes. Each cold run has a budget of 2 times its warm budget. The budget was set before any run (SC-010a to SC-010d).
- Q: Where does a stopped cherry-pick or revert end? → A: In the app. The Notices band offers Abort and Continue (FR-060 to FR-063).

### Session 2026-11-04 (mockup approval)

The user approved the mockup on 2026-11-04 with the orchestrator defaults (plan.md "Mockup").

- Q: Which actions does the stopped band offer? → A: The 004 FR-102 rule. Resolve conflicts shows while files are unmerged. Continue shows after the last Mark resolved. Abort shows always (FR-060).
- Q: Which control has the first focus in the Check out confirmation? → A: Cancel, as in the 004 switch confirmation (FR-020).
- Q: When does Create tag review? → A: When the popover opens, and again on Create tag. A `name-exists` refusal shows after Create tag (FR-031).
- Q: What happens to the message after a switch back to Lightweight tag? → A: The Message field clears (FR-030).
- Q: What does an empty tag name do? → A: Create tag stays unavailable. No text shows (FR-030).
- Q: How does the in-the-way refusal read? → A: A lead sentence, the path list, and a tail. The tail names the count of hidden paths only when some paths do not show (plan D11).

## User Scenarios & Testing *(mandatory)*

Feature 002 shows the full history. Feature 004 adds the branch menu on history labels and Create branch from a commit. Git Extensions offers a commit menu with checkout, branch, tag, cherry-pick, revert, and reset. Today Arbareto has no menu on a commit row. 003 and 004 exclude reset, cherry-pick, revert, and tags. The user must leave Arbareto for these actions.

### User Story 1 - Open the commit menu, copy the ID, and check out the commit (Priority: P1)

A developer right-clicks a commit row in History, or presses Shift+F10 on the selected row. The commit menu opens. The developer copies the commit ID, or checks out the commit as a detached HEAD.

**Why this priority**: The menu is the entry point of every other story. Copy commit ID and a detached checkout are daily tasks in Git Extensions.

**Independent Test**: In the packaged app, right-click and Shift+F10 open the menu on a commit row. A branch chip keeps its 004 branch menu. Copy commit ID gives the full object ID. A detached checkout gives the same HEAD, index, and working files as Git's own `checkout --detach` on a copy.

**Acceptance Scenarios**:

1. **Given** History with a commit row. **When** I right-click the row body. **Then** the row becomes selected, and its details dock. The menu `MENU_NAME` (plan D11) opens with its first item focused.
2. **Given** the same row. **When** I right-click a branch chip on it. **Then** the 004 branch menu opens, not the commit menu.
3. **Given** a selected row with labels and no active label. **When** I press Shift+F10 or the Menu key. **Then** the commit menu opens.
4. **Given** that row. **When** I press Right, then Shift+F10. **Then** the branch menu of the first label opens.
5. **Given** the first label is active. **When** I press Left. **Then** no label is active, and the live region states `COMMIT_ANNOUNCE`.
6. **Given** the Working directory row, the Commit index row, the "More commits exist." row, or a Loading row. **When** I right-click it or press Shift+F10. **Then** no menu opens.
7. **Given** the commit menu. **When** I select Copy commit ID. **Then** the clipboard holds the full object ID.
8. **Given** a clean tree. **When** I select `ITEM_CHECKOUT`. **Then** the confirmation `CHECKOUT_TITLE` shows the detach note. After `CHECKOUT_BUTTON`, the status states `OUTCOME.detached`.
9. **Given** a detached HEAD at this commit. **When** I open the menu. **Then** the check-out item is unavailable with `AT_COMMIT`.

---

### User Story 2 - Create a branch or a tag at a commit (Priority: P1)

A developer creates a branch or a tag at a commit from the commit menu.

**Why this priority**: Tags mark releases. A branch at an old commit starts a fix. Both are routine in Git Extensions.

**Independent Test**: In disposable fixtures, each tag equals Git's own `git tag` on a copy, with and without signing configuration. Create branch here equals the 004 Create branch result.

**Acceptance Scenarios**:

1. **Given** the commit menu. **When** I select `ITEM_BRANCH` or press Ctrl+B on the selected row. **Then** the 004 Create branch popover opens with this commit as the start point.
2. **Given** the commit menu. **When** I select `ITEM_TAG`. **Then** the popover `TAG_TITLE` opens with `TAG_LIGHT` preselected.
3. **Given** that popover. **When** I type the name v1 and select `TAG_BUTTON`. **Then** Git creates a lightweight tag v1 at the commit, and the status states `TAG_DONE`.
4. **Given** that popover. **When** I type a message. **Then** `TAG_ANNOTATED` becomes selected, and Git creates an annotated tag with that message.
5. **Given** `tag.gpgSign=true` in the Git configuration. **When** I create a lightweight tag. **Then** the review refuses with the tag-signing text, and no ref changes.
6. **Given** an existing tag v1. **When** I create v1 again. **Then** the review refuses with `TAG_REASON.name-exists`, and no ref changes.

---

### User Story 3 - Reset the current branch to a commit (Priority: P1)

A developer resets the current branch to a commit with the mode Soft, Mixed, or Hard. The popover states the effects before the run. Hard asks again in an alert dialog.

**Why this priority**: Reset removes unwanted local commits or squashes them. Git Extensions offers it in the commit menu. Today the user needs a terminal.

**Independent Test**: Each mode runs in disposable fixtures. HEAD, the refs, the index, and the working-file bytes equal Git's own `git reset --<mode>` on a copy. Hard refuses an untracked file in the way and changes nothing.

**Acceptance Scenarios**:

1. **Given** the commit menu on a branch. **When** I select `ITEM_RESET`. **Then** the popover `RESET_TITLE` opens with `RESET_MIXED` preselected and states the counts.
2. **Given** that popover with Mixed. **When** I select "Reset". **Then** HEAD and main point to the commit, the working files stay, and a staged new file becomes untracked.
3. **Given** that popover. **When** I select Hard. **Then** the review runs again, and the button becomes `RESET_HARD_BUTTON`.
4. **Given** Hard and an untracked file at a path that the target tracks. **When** the review ends. **Then** it refuses with the in-the-way text and the path, and nothing changes.
5. **Given** Hard and no file in the way. **When** I select `RESET_HARD_BUTTON`. **Then** the alert dialog `HARD_TITLE` opens with `HARD_CANCEL` focused. It states `NO_UNDO`.
6. **Given** that dialog. **When** I press Enter on Cancel or press Escape. **Then** the dialog closes, and nothing changes.
7. **Given** that dialog and ignored files in the way. **When** it opens. **Then** it states how many ignored files Git replaces.
8. **Given** a reset that removes commits that the upstream branch holds. **When** the popover opens. **Then** it states that the next push needs Force push with lease.
9. **Given** a detached or unborn HEAD. **When** I open the menu. **Then** the reset item is unavailable with its reason.

---

### User Story 4 - Cherry-pick or revert a commit, and finish a stop in the app (Priority: P1)

A developer cherry-picks a commit to the current branch, or reverts a commit on it. When Git stops with conflicts or another stop, the developer finishes the operation in the Notices band.

**Why this priority**: Cherry-pick moves a fix between branches. Revert undoes a published commit. An operation that the app starts must end in the app (user decision, 2026-11-04).

**Independent Test**: In disposable fixtures, clean and conflicting cases give the same result as Git's own command on a copy. Abort and Continue give the same result as `git cherry-pick --abort` and `--continue`, and the revert forms.

**Acceptance Scenarios**:

1. **Given** a commit of another branch and a clean tree. **When** I select `ITEM_PICK` and then `PICK_BUTTON`. **Then** a new commit with the message and author of the picked commit is on the current branch.
2. **Given** a commit that the current branch already has. **When** the review ends. **Then** it refuses with `PICK_REASON.already-on-branch`.
3. **Given** a merge commit. **When** I open the Cherry-pick or the Revert popover. **Then** it lists the parents, and parent 1 is preselected.
4. **Given** a cherry-pick with a conflict. **When** Git stops. **Then** the Notices band shows the conflict row with Resolve conflicts and `ABORT_PICK`.
5. **Given** that stop. **When** I resolve the files, select Mark resolved, and then Continue. **Then** Git creates the commit, and the state is normal.
6. **Given** a stopped revert. **When** I select `ABORT_REVERT` and confirm. **Then** the state is normal, and HEAD has its old value.
7. **Given** a stop where the index equals HEAD. **When** I select Continue. **Then** the review refuses with `NOTHING_PICK`.
8. **Given** uncommitted changes to tracked files. **When** the Cherry-pick review ends. **Then** it refuses with the dirty-tree text, and nothing changes.

---

### User Story 5 - Use the commit menu in a WSL repository (Priority: P2)

A developer uses the same items in a repository inside a WSL distro.

**Why this priority**: Feature 006 gives WSL repositories parity. The P1 stories ship first on Windows.

**Independent Test**: The WSL fixtures on Ubuntu-26.04 give the same results as Git's own commands in the distro. Mode bits, owner, and link count of each written file stay.

**Acceptance Scenarios**:

1. **Given** a WSL repository. **When** I run each reset mode, a tag, a cherry-pick, a revert, and a detached checkout. **Then** each result equals Git's own command in the distro on a copy.
2. **Given** a WSL repository and a Linux untracked file in the way. **When** I review Hard. **Then** the review refuses and lists the path.

---

### Edge Cases

- The user right-clicks a row while a mutation runs. The menu opens. Every item except Copy commit ID is unavailable with the running reason.
- A status read after the last operation runs. Every item except Copy commit ID is unavailable with the reconcile reason.
- A merge, a rebase, a cherry-pick, or a revert is in progress. Every item except Copy commit ID is unavailable with the operation reason (FR-012).
- The commit is a root commit. Cherry-pick and Revert stay available, because Git handles a root commit (research R2 P5, P12).
- The commit has more than 64 parents. Cherry-pick and Revert refuse with `limit`.
- The cherry-pick picks a change that HEAD already has, but the commit is no ancestor of HEAD. Git stops with no conflict. Continue refuses with `nothing-to-commit`, and Abort ends the stop (research R2 P6).
- Commit signing fails during a cherry-pick. Git stops with no conflict, and the index differs from HEAD. The band offers Continue and Abort with the Git output (research R2 P11).
- A hook stops a cherry-pick or a revert. The result is the same stop as a signing failure.
- Another tool started a multi-commit cherry-pick or revert sequence. Abort and Continue refuse with `sequence` (FR-062).
- Only a `.git/sequencer` folder exists, with no `CHERRY_PICK_HEAD` and no `REVERT_HEAD`. The state stays outside-only, as in 001.
- A file appears in the way after the Hard review. The run observation repeats the in-the-way check. A file can still appear after that and before the Git step. The 004 Discard has the same known window (plan R1).
- A partial clone misses a blob of the target. Git can write some files before it fails. The outcome is failed with effects, with the changed facts (plan R2).
- A signing program waits for a passphrase. The step shows the 15 s stall notice, and Cancel stays available (plan R5).
- The reset target is outside the branch history. The popover counts the commits that leave and arrive, and the reflog-only commits, before the run.
- The tag name is valid for `check-ref-format`, but `git tag` refuses it, such as `-x` or `HEAD`. The precheck refuses it before Git runs (research R2 P9).
- The review stays open for more than 60 seconds. The run changes nothing and states the expiry text (FR-003).
- Shift+F10 on a row with no labels. The commit menu opens.

## Requirements *(mandatory)*

### Scope Boundaries

Include the commit-row context menu in History with its seven items. Include the reviews, popovers, the Hard dialog, refusals, results, keys, and WSL parity. Include Abort and Continue for a single cherry-pick or revert in progress in the Notices band.

Exclude push of tags, tag delete, tag replace (`-f`), and explicit signed tags (`-s`, `-u`). Exclude `-x`, `--signoff`, `--no-commit`, `--empty`, and an editable cherry-pick or revert message. Exclude Skip for a single cherry-pick or revert. Exclude actions on several selected commits. Exclude "Rebase current branch on" and new keys. Exclude `reset --keep` and `reset --merge`. Exclude the theirs name in the resolve view during a cherry-pick, and a "Cherry-picking" text on the branch button. Exclude a multi-commit sequence, which stays outside-only.

The no-heuristics rule applies to every requirement. Every decision comes from one of four sources. These are exact parses of machine-readable Git output and Git exit codes that the Git documentation defines for that command. The others are OS facts and contract-defined values. Git message text, timing, retry counts, and name patterns never decide an outcome.

### Dependencies

- Feature 001 provides the operation registry with Cancel and the outcome reconciliation (FR-023). It also provides the mutation block (FR-015, FR-016), the trust approval, and the WSL rules.
- Feature 002 provides the History list and its commit rows.
- Feature 003 provides the Notices band conflict row with Abort and Continue (FR-030), and the sync trust class.
- Feature 004 provides the branch menu on history labels (FR-014) and the switch with a detached target (FR-009 to FR-013). It also provides Create branch and the review and run frame of workbench actions. It provides the conflict tools too (FR-089 to FR-097, FR-102).
- Feature 006 provides the WSL route.
- Feature 008 provides the alert dialog of the destructive confirmation (FR-008, FR-047), and the reserved label "Revert commit…".
- The first public package, v0.1.0, waits for this feature (user decision, 2026-11-04).

### Changes to earlier requirements

This feature changes these requirements for builds that include it. The earlier texts stay unchanged in their own files until task T020 amends them (plan D12).

- **001** `specs/001-desktop-qualification/spec.md:316` and **FR-016** (`:407`): a cherry-pick or a revert in progress stays a block for other mutations. Feature 010 adds Abort and Continue for it (FR-060).
- **003 Scope Boundaries** (`specs/003-remote-sync/spec.md:226`): reset, cherry-pick, and revert come with this feature from the History commit menu. Push of tags stays excluded.
- **003 FR-030** (`specs/003-remote-sync/spec.md:291`): Abort and Continue also apply to a cherry-pick or a revert in progress. Skip stays for a rebase only.
- **004 Scope Boundaries** (`specs/004-workbench-ux/spec.md:349`): reset, cherry-pick, revert, and tags come with this feature.
- **004 FR-014** (`specs/004-workbench-ux/spec.md:407`) and **004 plan D15 "History labels"** (`specs/004-workbench-ux/plan.md:382`) change. Shift+F10 and the Menu key open the commit menu while no label is active (FR-010, FR-015).
- **007 spec** `:19` and **007 FR-006** (`:159`): this feature is a v0.1.0 blocker. The 007 plan adds 010 next to 005, 006, and 008.
- **008 Scope Boundaries** (`specs/008-discard-changes/spec.md:192`): Git's commit revert and branch reset come with this feature. "Revert all changes", which would be Git's `reset --hard`, comes as Reset Hard.
- **008 FR-006** (`specs/008-discard-changes/spec.md:228`): "Revert commit…" of this feature is not an 008 revert action. 008 `spec.md:358` stays valid.

### Functional Requirements

#### Common rules

- **FR-001**: Every outcome MUST come from a documented Git exit code or Git's machine-readable output. An OS fact or a fresh read is also valid. The Git documentation MUST define that exit code for that command. Git message text MUST NOT decide an outcome.
- **FR-002**: Each action except Copy commit ID MUST have a review step and a run step (004 contract Δ3). Each MUST count as a mutation for 001 FR-015, FR-016, FR-023, and FR-024.
- **FR-003**: The review MUST bind HEAD, the operation state, the trust listing, and the action facts of data-model §2. The run MUST observe them again. A difference MUST give `STALE_REVIEW`. A review MUST expire after 60 s with the expiry text of plan D11.
- **FR-004**: Reset, Create tag, Cherry-pick, and Revert MUST use the trust class `workbench`. Abort and Continue MUST use the class `sync`. A repository program MUST NOT run before approval.
- **FR-005**: The actions MUST respect hooks and signing (001 FR-019, 004 FR-023). They MUST pass no hook bypass and no signing override. They MUST write no configuration.
- **FR-006**: A failed step MUST show its bounded output tail as plain text (001 contract §6, 64 KiB).
- **FR-007**: Cancel in the status bar MUST stop the step. Fresh reads MUST report the result. The result MUST NOT report Cancel as a rollback.
- **FR-008**: An action MUST NOT download objects (`--no-lazy-fetch`). A missing target MUST refuse with `UNKNOWN_TARGET` before any change.

#### Menu

- **FR-010**: A right-click on a commit row body MUST select the row, as a click does. It MUST then open the commit menu. The details MUST dock as for a click. A right-click on a branch or remote-tracking chip MUST keep the 004 branch menu. Shift+F10 or the Menu key on the selected commit row MUST open the commit menu while no label is active. After Left or Right makes a label active, the keys MUST open the branch menu of that label. The menu MUST anchor to the row. Its first item MUST get the focus. On close, the focus MUST go back to the history list.
- **FR-011**: The menu MUST hold these items in four groups, in this order. Group 1: "Check out this commit (detached HEAD)…", "Create branch here…" (Ctrl+B), "Create tag here…". Group 2: "Cherry-pick commit…", "Revert commit…". Group 3: "Reset current branch (<branch>) to here…", or "Reset current branch to here…" on a detached or unborn HEAD. Group 4: "Copy commit ID". The items MUST NOT get new keys.
- **FR-012**: The menu MUST apply the availability rules of plan D1 "Availability". While a mutation runs or the state is unknown or refreshing or a status read is `reconciling` (001 T411), only Copy commit ID MUST stay available. The same rule applies during a merge, a rebase, a cherry-pick, or a revert, and with conflicts without a marker. On a detached or unborn HEAD, Cherry-pick, Revert, and Reset MUST be unavailable. On a detached HEAD at this commit, Check out MUST be unavailable. Each unavailable item MUST state its reason. The service review MUST check every rule again.
- **FR-013**: The Working directory row and the Commit index row MUST NOT open a menu. The "More commits exist." row and a Loading row MUST NOT open one either. Shift+F10 on them MUST do nothing.
- **FR-014**: The history list MUST stay one Tab stop. Each item MUST have a label, an icon, and an accessible name. An unavailable item MUST stay focusable. The menu's accessible name MUST be `MENU_NAME` (plan D11). A popover MUST focus its first field or its preselected radio. The Check out confirmation is the exception (FR-020). Escape MUST cancel and return the focus to the list. Keys and selection MUST have no motion. The controls MUST work in forced colors, both themes, both densities, and at 150% and 225% text scale.
- **FR-015**: Left on the first label MUST make no label active and announce `COMMIT_ANNOUNCE`. Right from no active label MUST make the first label active.

#### Check out, Create branch, Copy

- **FR-020**: Check out this commit MUST use the 004 switch with a detached target (004 FR-009 to FR-013). The confirmation MUST always show, with the detach note. Cancel MUST have its first focus. The Keep, Stash, and Discard choices and the in-the-way refusal MUST stay as in 004.
- **FR-021**: Create branch here MUST be the 004 Create branch action (004 FR-014) with this commit as the start point. Ctrl+B on the selected row MUST open it.
- **FR-022**: Copy commit ID MUST copy the full object ID. It MUST always be available.

#### Create tag

- **FR-030**: The popover MUST have the field Tag name, the choice "Lightweight tag" or "Annotated tag", and the field Message. "Lightweight tag" MUST be preselected each time. A typed message MUST select "Annotated tag". A switch back to "Lightweight tag" MUST clear the message. An annotated tag with a blank message MUST NOT run. An empty Tag name MUST keep Create tag unavailable. The popover MUST review when it opens and again on Create tag.
- **FR-031**: A name MUST pass the contract rule of plan D3 and `check-ref-format refs/tags/<name>` with exit 0. An existing tag MUST refuse. The popover MUST NOT offer a replace (`-f`).
- **FR-032**: A lightweight tag MUST refuse when the effective `tag.gpgSign` is true. An annotated tag MUST pass `-m` without `-a`, so `tag.gpgSign` and `tag.forceSignAnnotated` apply. The open review MUST return the signing facts of both tag kinds. The open review MUST NOT refuse with `tag-signing`. The popover MUST state when Git signs the selected kind. A configuration value that is not a boolean MUST refuse with `invalid-config`.
- **FR-033**: The message MUST be strict UTF-8, not blank, at most 8 KiB, and within the command-line bound.
- **FR-034**: Arbareto MUST NOT push tags. The result MUST say so.

#### Reset

- **FR-040**: The popover MUST offer Soft, Mixed, and Hard. Mixed MUST be preselected each time. A mode change MUST start a new review.
- **FR-041**: Reset MUST be unavailable on a detached HEAD and on an unborn branch. Unmerged index entries MUST refuse with `CONFLICTED`.
- **FR-042**: The popover MUST state the target, the commits that leave the branch, and the commits that arrive. It MUST state the commits that only the reflog keeps, the force-push note, and the count of tracked changes.
- **FR-043**: Hard MUST refuse when an untracked file or folder that is not ignored is in the way. It MUST list the first 100 paths and count the rest. It MUST change nothing. Ignored files in the way MUST NOT refuse. The review MUST count them. More than 20,000 candidate paths MUST refuse with `limit`. The refusal MUST change nothing. Note (2026-11-06): the check MUST also cover a path where the index equals the target and the working tree differs. A nested Git repository in an ignored folder in the way MUST refuse with its folder path (research R2 P17, P18). The check MUST also cover an assume-unchanged entry whose file the user replaced (research R2 P19). A skip-worktree entry is no candidate, because Git keeps its working bytes.
- **FR-044**: Hard MUST open the 008 alert dialog (008 FR-008, FR-047) with the texts of plan D11. Cancel MUST have the first focus. The dialog MUST NOT have a default button. The dialog MUST state the count of replaced ignored files and `NO_UNDO`. Arbareto MUST NOT keep a backup. Note (2026-11-06): a nested Git repository in an ignored folder is not a replaced ignored file. FR-043 refuses it.
- **FR-045**: The step MUST be `reset --quiet --no-recurse-submodules --<mode> <oid> --`.
- **FR-046**: The outcome checks of plan D4 MUST decide the result.

#### Cherry-pick and Revert

- **FR-050**: The popover MUST state what Git does. A merge commit MUST show its parents and a parent choice, with parent 1 preselected.
- **FR-051**: The review MUST refuse a detached HEAD, an unborn branch, `CONFLICTED`, `dirty-tree`, `mainline-needed`, and `not-merge`. Cherry-pick MUST also refuse `already-on-branch`.
- **FR-052**: The steps MUST be the argument arrays of plan D5. Git MUST write the message. The popover MUST name Amend last commit for a change of the message.
- **FR-053**: The outcome mapping of plan D5 MUST decide the result. The results are confirmed, stopped with conflicts, and stopped without conflicts. The other results are failed with effects and failed with no change.

#### Finish a stop

- **FR-060**: During `cherry-picking` and `reverting`, the Notices band MUST show the 003 conflict row with Resolve conflicts, Abort, and Continue. It MUST NOT show Skip. The row MUST keep the 004 FR-102 rule: Resolve conflicts while files are unmerged, then Continue. Abort MUST always show.
- **FR-061**: Abort MUST run `<kind> --abort`. Continue MUST run `<kind> --continue`. Both MUST follow the 003 confirmation and outcome rules.
- **FR-062**: Continue MUST refuse with `CONFLICTED` while files are unmerged. It MUST refuse with `nothing-to-commit` when the index equals HEAD. A `.git/sequencer` folder MUST refuse Abort and Continue with `sequence`.
- **FR-063**: Mark resolved, Choose ours, Choose theirs, and Open in merge tool MUST work as 004 FR-089 to FR-097.

#### WSL repositories

- **FR-070**: Every action MUST work with the WSL Git selection with the same argument arrays, refusals, and outcome rules (006).

#### Responsiveness

- **FR-080**: The window MUST keep the 001 SC-005 targets during every review and run of this feature.

### Key Entities *(include if feature involves data)*

- **Commit menu state**: The commit, the anchor, and the opening input (pointer or key). It lives in the renderer only.
- **Commit action review**: The action, the bound HEAD, operation state, trust listing, and action facts. It is single-use and lives 60 s.
- **Action plan**: The facts that the popover shows, such as counts, parents, the signing fact, and the in-the-way verdict.
- **Run result**: HEAD, the changed refs, the operation state, unmerged counts, and the output tail where one applies.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Each reset fixture runs once in the app and once with Git's own `reset --<mode>` on a copy. HEAD, the refs, the index, and every working-file byte are equal. Each count equals Git's `rev-list --count`.
- **SC-002**: In every in-the-way fixture (research R2 P4, P4b, and a folder case), Hard refuses, and every byte stays.
- **SC-003**: In every cherry-pick and revert fixture, the result equals Git's own command on a copy. The fixtures are clean, conflict, merge with `-m`, root, empty stop, and signing failure.
- **SC-004**: In every tag fixture, the refs equal Git's own `git tag` on a copy. The fixtures are lightweight, annotated, `tag.gpgSign`, `tag.forceSignAnnotated`, an existing name, and invalid names.
- **SC-005**: The detached checkout fixtures equal the 004 SC-001 oracle.
- **SC-006**: In every stop fixture, Abort and Continue equal Git's own `--abort` and `--continue` on a copy.
- **SC-007**: No repository program runs before approval. Each hook event of research R2 P1 to P3 is in the trust class of its action.
- **SC-008**: Every WSL fixture equals Git's own command in the distro. Mode bits, owner, and link count stay.
- **SC-009**: Keyboard-only users complete User Stories 1 to 4. Each control has an accessible name, visible focus, and a contrast of at least 4.5:1. This also holds in a contrast theme and at 150% and 225% text.
- **SC-010a**: Measure: input to menu paint, for right-click and Shift+F10. Fixture: L (100,000 commits, 256 refs), with History open. Samples: 40 opens per run on distinct rows (20 + 20). Budget: p95 at most 100 ms, and every open at most 500 ms.
- **SC-010b**: Measure: item activation to the popover with its plan or refusal. Fixture: M (5,000 commits, 10,000 files). Samples: 10 warm runs and 1 warm-up run per action. Budget: median at most 300 ms, and every run at most 500 ms.
- **SC-010c**: Measure: the Hard review with the in-the-way check. The target is 100 commits back, with about 1,000 changed paths. Fixture: M-R. Samples: 10 warm runs and 1 warm-up run. Budget: median at most 1 s, and every run at most 2 s.
- **SC-010d**: Run button to outcome text, on fixtures M and M-R, 10 warm runs and 1 warm-up run per action. Median budgets: Soft 1 s, Mixed 2 s, Hard on M-R 4 s, and Create tag 1 s. Cherry-pick and Revert of a 10-file commit: 2 s. Abort and Continue: 2 s. Detached checkout on M-R: 4 s. Every run at most 2 times its budget.
- **SC-011**: During each SC-010d run, typing in the history filter keeps the 001 SC-005 targets. Each run has at least 20 inputs.
- **SC-012**: A review of the requirement-to-test map finds no outcome that message text or timing decides. Retry counts and name patterns decide no outcome either.

The SC-010 and SC-011 runs use the packaged build, warm, on the agreed hardware. The warm-up run counts for the every-run bound, never for the median (001 spec.md:95). The same runs record CPU seconds and process-tree private bytes, with no budget. Each SC-010 measure also measures one cold run after a new app start. Each cold run has a budget of 2 times its warm budget. The budget was set before any run (user decision, 2026-11-04). The warm budget of a cold run is the median budget of its measure, and the p95 budget for SC-010a (decision 2026-11-05). The WSL times of SC-010b and SC-010d on Ubuntu-26.04 (10 + 1 runs) are recorded, with no budget.

## Assumptions

- Cherry-pick, Revert, and Reset are unavailable on a detached HEAD and on an unborn branch. 004 FR-028 does the same for merge. Git allows them. This is a reviewer default.
- Cherry-pick and Revert need a clean tracked tree, as the Git documentation states. Git allows some dirty cases (research R2 P10). This is a reviewer default.
- Check out this commit always shows its confirmation, because the result is a detached HEAD. This is a reviewer default.
- Git replaces ignored files in the way of Hard, and the dialog counts them. The 004 spec has the same assumption for ignored files. The user confirmed this on 2026-11-04.
- Git writes the cherry-pick and revert messages. Amend last commit changes them. This is a reviewer default.
- Skip stays hidden for a single cherry-pick or revert. Abort gives the same result (research R2 P1b). This is a reviewer default.
- The texts are proposals. The plan records them in D11, and the WP1 mockup confirms the layout.
- The icons come from the free hugeicons set. The mockup picks them.

## Research inputs

- Git Extensions offers the parent choice for a merge commit. It creates a lightweight tag by default (design plan Q1 and Q2). This spec did not read the Git Extensions source again. Git Extensions is GPL-3.0, so Arbareto takes ideas only.
- The Git probes of 2026-11-04 ran on Git 2.56.0.windows.2 in scratch repositories (research R2). Task T001 runs them again.
