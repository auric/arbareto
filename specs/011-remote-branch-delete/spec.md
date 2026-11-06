# Feature Specification: Remote Branch Delete

**Feature Branch**: `011-remote-branch-delete`

**Feature Directory**: `specs/011-remote-branch-delete`

**Created**: 2026-11-06

**Status**: Draft

**Input**: User description (2026-11-06): delete a remote branch from Arbareto, as feature 011. Offer it on a remote-tracking branch. Offer it also as a check box in the local branch Delete dialog. Ship it before the first public package, v0.1.0. Inputs: the user decisions of 2026-11-06 and the design plan with its Git probes of 2026-11-06 (local scratch).

## Clarifications

### Session 2026-11-06

The user gave these decisions on 2026-11-06. Each decision is binding.

- Q: When does remote branch delete ship? → A: Before the v0.1.0 tag, as feature 011.
- Q: Does the local Delete dialog also delete the remote branch? → A: When the branch has an upstream remote-tracking branch, the dialog offers a check box (plan D13 X9). It is unchecked by default. One confirmation covers both deletes (FR-010).
- Q: Can the user delete the default branch of a remote? → A: No. The review refuses the branch that `refs/remotes/<remote>/HEAD` names after the last fetch, with the reason. When that ref is absent, the review refuses and tells the user to fetch (FR-004).
- Q: Which budgets apply? → A: The budgets of SC-009a to SC-009e, as the design plan proposed them. Each cold run has a budget of 2 times the warm budget of its measure. WSL times are recorded only.
- Q: What happens when the remote branch is already gone? → A: After a stale-lease refusal, Arbareto checks the remote with `ls-remote --exit-code`. When the branch is gone, Arbareto removes the stale remote-tracking ref and says so. The removal binds to the shown object ID (FR-012).
- Q: Does Del on a remote-tracking row open the confirmation? → A: Yes. Cancel has the first focus, so one key never deletes (FR-001).
- Q: Does the stale outcome offer a Fetch button? → A: No. The outcome names Fetch as text only (plan D13 X22).
- Q: Which menu label applies? → A: "Delete remote branch…" (plan D13 X1).
- Q: When do the code tasks start? → A: After the user approves the mockup (T002) and after feature 010 merges into `main`. Both features change the same files.

## User Scenarios & Testing *(mandatory)*

Feature 003 pushes branches. Feature 004 deletes local branches and excludes remote branch delete. Git Extensions offers "Delete remote branch" on a remote branch. Today the user must leave Arbareto for this action. After a merged pull request, a stale remote branch stays until the user opens a terminal.

### User Story 1 - Delete one remote branch from its remote-tracking branch (Priority: P1)

A developer right-clicks a remote-tracking branch in the References sidebar or a remote label in History. The developer selects the delete item, reads the plan, and confirms. Git deletes the branch on the remote and the remote-tracking branch here.

**Why this priority**: This is the core action. Every other story reuses its review, its lease, and its outcome rules.

**Independent Test**: In disposable fixtures with a local bare remote, each result equals Git's own `push --force-with-lease=<dst>:<expect> -- <remote> :<dst>` on a copy. A remote branch that moved after the last fetch keeps every commit.

**Acceptance Scenarios**:

1. **Given** a remote-tracking row `origin/feature`. **When** I open its menu. **Then** group 2 shows X1 after "Add worktree for this branch…", in the danger style, with the key text "Del".
2. **Given** a History remote label `origin/feature`. **When** I open its menu. **Then** the same menu with X1 opens.
3. **Given** a focused remote-tracking row. **When** I press Del. **Then** the review starts, and the confirmation opens with Cancel focused.
4. **Given** the confirmation for a branch with 3 commits that no other ref here holds. **When** it opens. **Then** it shows X2, X3, X4, the 3 commits, and X7.
5. **Given** that confirmation. **When** I press Enter on Cancel or press Escape. **Then** the dialog closes, and nothing changes.
6. **Given** that confirmation. **When** I select X8. **Then** Git deletes `refs/heads/feature` on the remote and `refs/remotes/origin/feature` here. The status bar states X20.
7. **Given** another clone pushed a commit to `feature` after my last fetch. **When** I confirm. **Then** Git deletes nothing, the remote keeps every commit, and the status bar states X22.
8. **Given** `refs/remotes/origin/HEAD` names `origin/main`. **When** I select X1 on `origin/main`. **Then** the review refuses with X13, and no network process starts.
9. **Given** no `refs/remotes/origin/HEAD`. **When** I select X1 on any `origin` branch. **Then** the review refuses with X14, and no network process starts.

---

### User Story 2 - Delete a local branch and its remote branch together (Priority: P1)

A developer deletes a local branch from the 004 Delete dialog. The developer checks the box X9 to delete its upstream remote branch too. One confirmation covers both.

**Why this priority**: After a merged pull request, the user deletes both branches. One dialog saves a second flow (user decision, 2026-11-06).

**Independent Test**: In disposable fixtures, the combined delete equals the same Git commands on a copy: the lease delete, then `update-ref --no-deref -d`, then `config --remove-section`. A failed remote delete leaves both branches unchanged.

**Acceptance Scenarios**:

1. **Given** a local branch `keep` with the upstream `origin/keep`. **When** I open Delete. **Then** the 004 dialog shows X9, unchecked, and Cancel has the first focus.
2. **Given** a local branch with no upstream, or an upstream that is a local branch. **When** I open Delete. **Then** the dialog shows no check box.
3. **Given** the dialog. **When** I check X9. **Then** X12 shows while the review runs, and Delete is unavailable.
4. **Given** the review ends with a plan. **When** the plan shows. **Then** X10 or X11, the commit list, the reflog line, and X7 show.
5. **Given** the box is checked and the review refuses. **When** the refusal shows. **Then** its text shows under the box as an alert, and Delete stays unavailable.
6. **Given** the box is checked. **When** I uncheck it. **Then** the 004 plan shows again, and Delete deletes only the local branch.
7. **Given** the box is checked with a plan. **When** I select Delete. **Then** Git deletes the remote branch first, then the local branch and its `branch.<name>` section. The status bar states X21.
8. **Given** the network fails during the remote delete. **When** the run ends. **Then** both branches stay, and the status bar states the failure with X25.
9. **Given** the remote delete succeeds and the local delete fails. **When** the run ends. **Then** the status bar states X24, and the local branch keeps its tip.

---

### User Story 3 - Remove a remote-tracking branch whose remote branch is gone (Priority: P2)

Another clone deleted the remote branch. Fetch does not prune by default, so the remote-tracking branch stays here. The developer deletes it with the same item.

**Why this priority**: Without this story, every retry gives the same stale refusal (research R2 P9). The user decided option (a) of design question Q1 on 2026-11-06.

**Independent Test**: In disposable fixtures, a gone remote branch gives X23, and only the stale remote-tracking ref goes. A remote branch that moved keeps the remote-tracking ref.

**Acceptance Scenarios**:

1. **Given** `origin/gone1` here and no `refs/heads/gone1` on the remote. **When** I confirm X8. **Then** the lease delete refuses, the check finds no branch, Arbareto removes `refs/remotes/origin/gone1`, and the status bar states X23.
2. **Given** the remote branch moved after the last fetch. **When** I confirm. **Then** the check finds the branch, nothing changes, and the status bar states X22.
3. **Given** the remote has a `pushurl` that differs from its fetch URL. **When** the lease refuses. **Then** Arbareto does not check the remote and states X22.
4. **Given** the combined delete and a gone remote branch. **When** I confirm. **Then** Arbareto removes the stale ref and deletes the local branch. The status bar states X23, then X26.

---

### User Story 4 - Delete a remote branch from a WSL repository (Priority: P2)

A developer deletes a remote branch in a repository inside a WSL distro.

**Why this priority**: Feature 006 gives WSL repositories parity. The P1 stories ship first on Windows.

**Independent Test**: The WSL fixtures on `Ubuntu-26.04` give the same results as Git's own commands in the distro. No process stays in the distro after Cancel.

**Acceptance Scenarios**:

1. **Given** a WSL repository with a bare remote in the distro. **When** I delete a remote branch, and once combined with its local branch. **Then** each result equals Git's own commands in the distro on a copy.
2. **Given** a WSL repository. **When** the lease is stale, or the branch is the default branch. **Then** the result equals the Windows result.

---

### Edge Cases

- A branch name holds a slash, such as `a/b`. Git deletes `refs/heads/a/b` and `refs/remotes/origin/a/b` (research R2 P19).
- A branch name holds non-ASCII UTF-8, or the repository uses SHA-256 object IDs. T001 probes both (research R5 U3).
- A remote-tracking ref that no fetch refspec maps back to a remote branch, or that two remotes map. The review refuses with X15 (FR-003).
- A fetch refspec maps into `refs/tags/`, or the forward mapping names another ref. The review refuses with X15.
- The remote has several push URLs, or it is a mirror. The review refuses with the existing reason (FR-005).
- The remote refuses the delete: `receive.denyDeletes`, its own HEAD branch, a checked-out branch of a non-bare remote, or a pre-receive hook. The remote-tracking ref stays, and the outcome states the remote reason as display text (research R2 P3 to P6).
- A stale local `refs/remotes/<remote>/HEAD` names an old default. The new default of the remote stays deletable here. Git servers refuse their HEAD branch by default (research R2 P4, plan R4).
- `remote.<name>.followRemoteHEAD=never` keeps `refs/remotes/<remote>/HEAD` absent. Every branch of that remote refuses with X14 (research R2 P13). A fetch does not create the ref then, so X14 also names `git remote set-head`.
- A local pre-push hook declines. Git deletes nothing. The outcome is the shared failure outcome with the terminal remedy (research R2 P7).
- An approved pre-push hook commits on the local branch during a combined run. The local delete refuses the moved tip, and the outcome states X24.
- Local branches that track the deleted remote branch keep their upstream setting and show `gone` (research R2 P12, FR-009).
- The remote hides refs (`uploadpack.hideRefs`). The gone check can find no branch while the remote keeps it. Arbareto then removes only the stale ref whose commits the confirmation listed (plan R11).
- The user cancels after the remote delete and before the local delete. The outcome states X24 (FR-013).
- The review stays open for more than 60 seconds. The run changes nothing and refuses with `APPROVAL_EXPIRED`, as the 003 flows do.
- A trust ask opens from inside the open Delete dialog. The focus goes back to the dialog after the shell dialog closes (research R5 U6).
- A detached or an unborn HEAD does not refuse a remote-only delete.

## Requirements *(mandatory)*

### Scope Boundaries

Include the delete of one remote branch from its remote-tracking row in the References sidebar. Include the same delete from a remote label in History. Include Del on a focused remote-tracking row. Include the check box X9 in the 004 local Delete dialog. Include the gone recovery of User Story 3, the refusals, the outcomes, and WSL parity.

Exclude the delete of several branches in one action, prune, and tag delete. Exclude a remote ref outside `refs/heads/`, remote management, and any delete without a lease. Exclude a network read during a review, such as `ls-remote --symref`. Exclude a Fetch button in the stale outcome.

The no-heuristics rule applies to every requirement. Every decision comes from one of four sources. These are exact parses of machine-readable Git output and Git exit codes that the Git documentation defines for that command. The others are OS facts and contract-defined values. Git message text, timing, retry counts, and name patterns never decide an outcome.

### Dependencies

- Feature 001 provides the operation registry with Cancel and the outcome reconciliation (FR-023). It also provides the mutation block (FR-015, FR-016), the trust approval, the stall notice (FR-051), and the WSL rules.
- Feature 003 provides the sync action frame, the push step, and the `sync` trust class. It also provides Pageant, the remedies, the connect target, and the force-push commit list.
- Feature 004 provides the References sidebar and the branch menu on rows and History labels (FR-014). It also provides the local Delete dialog (FR-017 to FR-019).
- Feature 006 provides the WSL route.
- Feature 008 provides the alert dialog pattern of a destructive confirmation (FR-008, FR-047).
- Feature 010 changes the same files. The 011 code starts on `main` after 010 merges (plan R7).
- The first public package, v0.1.0, waits for this feature (user decision, 2026-11-06).

### Changes to earlier requirements

This feature changes these requirements for builds that include it. The earlier texts stay unchanged in their own files until task T023 amends them (plan D14).

- **001 FR-027** (`specs/001-desktop-qualification/spec.md:424`): the delete of a remote branch with a lease is allowed behind its confirmation (011 FR-006, FR-007).
- **003 Scope Boundaries** (`specs/003-remote-sync/spec.md:226`): "deletion of remote branches" goes. The delete of one remote branch comes with this feature. Push of several branches and of tags stays excluded.
- **003 FR-041** (`specs/003-remote-sync/spec.md:261`): the network actions gain the remote branch delete. Reviews stay offline.
- **003 FR-025** (`specs/003-remote-sync/spec.md:283`): no change. 011 FR-007 applies the same lease rule to a delete.
- **004 Scope Boundaries** (`specs/004-workbench-ux/spec.md:349`): "Exclude remote branch delete" goes. Remote management stays excluded.
- **004 FR-014** (`specs/004-workbench-ux/spec.md:407`): a remote-tracking branch also offers X1 with Del.
- **004 FR-017 to FR-019** (`specs/004-workbench-ux/spec.md:410-412`): with the 011 check box checked, the FR-018 count covers both refs. FR-019 binds the local part.
- **004 plan D16 "Branch menu groups"** (`specs/004-workbench-ux/plan.md:570`): group 2 of a remote-tracking branch gains X1.
- **007 spec** `:19` and **007 FR-006** (`:159`, branch `007-first-release`): this feature is a v0.1.0 blocker.
- README "Features" and the CHANGELOG 0.1.0 section (branch `007-first-release`): the user-visible change only.

### Functional Requirements

#### Entry points

- **FR-001**: A remote-tracking branch in the References sidebar and in the History labels MUST offer X1 with the key text "Del". X1 MUST sit in menu group 2 after "Add worktree for this branch…", in the danger style. Del on a focused remote-tracking row MUST start the same review. An item that cannot run MUST stay focusable and state its reason.

#### Review

- **FR-002**: The review MUST bind the remote, the full remote ref, and the remote-tracking ref with its object ID. It MUST also bind exactly one push URL and the commits that the delete removes from every ref here. The review MUST NOT use the network.
- **FR-003**: The remote and the remote ref MUST come from the fetch refspecs. Exactly one remote and one `refs/heads/` source MUST map the remote-tracking ref. The forward mapping MUST give the same ref. Otherwise the review MUST refuse with `no-remote-branch`.
- **FR-004**: The review MUST refuse the branch that `refs/remotes/<remote>/HEAD` names, with `default-branch`. When that ref is absent or not symbolic, the review MUST refuse with `default-unknown`. That refusal MUST name Fetch and `git remote set-head` as the next steps.
- **FR-005**: The review MUST refuse while an operation is in progress. It MUST refuse a missing remote-tracking ref with `UNKNOWN_TARGET`. It MUST refuse without trust approval of the `sync` class. It MUST also refuse several push URLs and a mirror remote.

#### Confirmation and run

- **FR-006**: The confirmation MUST be a modal alert dialog. It MUST name the remote branch. It MUST list the removed commits with their count and subjects, up to 100. It MUST state that other people can lose work, and that the delete stops on a remote change. Cancel MUST have the first focus. The dialog MUST NOT have a default button.
- **FR-007**: The delete MUST bind to the shown remote-tracking object ID through the Git lease `--force-with-lease=<dst>:<expect>`. Git MUST refuse when the remote branch differs, so no remote commit is lost. The application MUST NOT offer a delete without a lease.
- **FR-008**: The outcome MUST come from the push porcelain line, the exit code, and the listings before and after. A stale lease line names its source `(delete):<dst>`, and the parse MUST accept it. Network, credential, and hook failures MUST share one outcome with the terminal remedy (003 FR-006, 001 FR-051).
- **FR-009**: The remote-only delete MUST change no Git configuration. Local branches that track the deleted branch MUST keep their upstream setting.

#### Combined delete

- **FR-010**: When the branch upstream is a listed remote-tracking branch, the local Delete dialog MUST offer the check box X9. It MUST be unchecked by default. One confirmation MUST cover both deletes. The checked plan MUST state the commits that both deletes remove together.
- **FR-011**: The combined delete MUST delete the remote branch first. The local delete MUST follow 004 FR-018 and FR-019. It MUST run only after a successful remote delete or a gone recovery. Each partial result MUST be stated.

#### Gone recovery

- **FR-012**: After a stale-lease refusal, the application MUST check the remote with `ls-remote --exit-code -- <remote> <dst>`. It MUST check only when the fetch URL equals the push URL byte for byte. Exit 2, or exit 0 with no exact `<dst>` line, means gone. Then the application MUST remove the remote-tracking ref with `update-ref --no-deref -d <ref> <expect>`, and say so. Any other result MUST keep the stale outcome.

#### Common rules

- **FR-013**: Cancel MUST NOT be reported as rollback. The application MUST reconcile and state that the remote can hold the delete.
- **FR-014**: Hooks and transport programs MUST follow 003 FR-009 and run only after trust approval of the `sync` class.
- **FR-015**: WSL repositories MUST give the same results through the Git of the distro (feature 006).
- **FR-016**: Every visible text MUST come from plan D13. Keyboard access and visible focus MUST hold for every new control. The controls MUST work in forced colors, both themes, both densities, and at 150% and 225% text scale.

### Key Entities *(include if feature involves data)*

- **Remote delete review**: The remote, the remote ref, and the remote-tracking ref with its object ID. It also holds one push URL, the removed commits, and the optional local branch facts. It is single-use and lives 60 s.
- **Remote delete plan**: The facts that the confirmation shows: the names, the redacted URL, the commit count and list, and the local reflog fact.
- **Run result**: The push status, the gone fact, the local fact, the changed refs, and the remedy where one applies.
- **Dialog state**: The remote overlay, and the check box state of the local Delete dialog. It lives in the renderer only.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Each remote-only fixture matches the same Git lease delete on a copy. The check compares local refs, remote refs, HEAD, and config bytes.
- **SC-002**: Some fixtures move the remote branch after the last fetch. In each of them, the remote keeps every commit, and no local ref changes.
- **SC-003**: Each `default-branch` and `default-unknown` refusal starts no network process.
- **SC-004**: Each combined fixture matches the same Git commands on a copy. Each partial-failure fixture reports the exact state.
- **SC-005**: No credential shows in any display, diagnostic, log, or command (003 SC-005).
- **SC-006**: The configuration files stay byte-identical. The only exception is the removed `branch.<name>` section of a combined delete.
- **SC-007**: Hooks run only after approval.
- **SC-008**: Keyboard-only users complete User Stories 1 to 3. Each control has an accessible name, visible focus, and a contrast of at least 4.5:1. This also holds in a contrast theme and at 150% and 225% text.
- **SC-009a**: Measure: input to menu paint on a remote-tracking row, for right-click and Shift+F10. Fixture: M-D. Samples: 40 opens per run on distinct rows (20 + 20). Budget: p95 at most 100 ms, and every open at most 500 ms (001 SC-005).
- **SC-009b**: Measure: item activation, or the check-box click, to the confirmation with its plan or refusal. Fixture: M-D, target `d01` with 150 commits that only it holds. Samples: 10 warm runs and 1 warm-up run per form (remote, combined). Budget: median at most 500 ms, and every run at most 1 s.
- **SC-009c**: Measure: Delete button to outcome text, remote only, with a local bare remote over a file path. Fixture: M-D. Samples: 10 warm runs and 1 warm-up run. Budget: median at most 1.5 s, and every run at most 3 s.
- **SC-009d**: Measure: Delete button to outcome text, combined. Fixture: M-D. Samples: 10 warm runs and 1 warm-up run. Budget: median at most 2 s, and every run at most 4 s.
- **SC-009e**: During each SC-009c and SC-009d run, typing in the history filter keeps the 001 SC-005 targets. Each run has at least 20 inputs.
- **SC-010**: The WSL fixtures give the SC-001 and SC-004 results, and no process remains in the distro after Cancel.
- **SC-011**: Each outcome traces to an exit code, a porcelain field, or a repository read. The requirement-to-test map finds no decision by message text, timing, retry counts, or name patterns.

The SC-009 runs use the packaged build, warm, on the agreed hardware. The warm-up run counts for the every-run bound, never for the median (001 spec.md:95). The same runs record CPU seconds and process-tree private bytes, with no budget. Each SC-009a to SC-009d measure also measures one cold run after a new app start. Each cold run has a budget of 2 times the warm budget of its measure. The warm budget is the median budget, and the p95 budget for SC-009a (user decision, 2026-11-06; 010 decision 2026-11-05). The WSL times of SC-009b to SC-009d on `Ubuntu-26.04` (10 + 1 runs) are recorded, with no budget.

## Assumptions

- `{tracking}` in X9 is the short name of the remote-tracking ref, such as `origin/feature`. With the default fetch refspec, it equals the `<remote>/<name>` of the user decision. With another refspec, X3 names the remote and the remote ref. This is a reviewer default.
- The remote delete is a 003 sync action, not a 004 workbench action. Only the syncer has Pageant, the push remedies, the connect target, and the network stall handling (plan D9).
- The trust ask names the existing action `push`. So the shell trust dialog needs no new sentence (plan D9).
- The default branch comes only from the local `refs/remotes/<remote>/HEAD` symref. A stale symref is a known limit (plan R4).
- The texts are proposals. Plan D13 records them, and the WP1 mockup confirms the layout.
- The icons come from the free hugeicons set. The delete item uses the trash icon `Delete02Icon` of the local Delete item.
- Feature 010 merges into `main` before any 011 code task starts (research R5 A1).

## Research inputs

- Git Extensions offers "Delete remote branch" on a remote branch (design plan Q4). This spec did not read the Git Extensions source again. Git Extensions is GPL-3.0, so Arbareto takes ideas only.
- The Git probes of 2026-11-06 ran on Git 2.56.0.windows.2 and on `Ubuntu-26.04` with Git 2.55.0, in scratch repositories (research R2). Task T001 runs them again.
