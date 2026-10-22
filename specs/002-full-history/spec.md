# Feature Specification: Full History and Commit Message Filter

**Feature Branch**: `002-full-history`

**Feature Directory**: `specs/002-full-history`

**Created**: 2026-10-11

**Status**: Draft

**Input**: User description: "Full history with bounded RAM. Commit bodies load only for the details pane. A commit message filter has filter and highlight modes. Compare the speed with Git Extensions and set a RAM budget."

## Clarifications

### Session 2026-10-11

- Q: Which commits does the history view show? → A: All branches, as the default Git Extensions view shows them. The view binds to one ref set, captured when it opens. Rows show the labels of the captured refs, and the current checkout stays marked. One switch selects all branches or the current branch, with all branches as the default. Remote-tracking refs come only from the local repository.
- Q: How fast must the history view be, and may it stop responding? → A: Keep the SC-011 gate: a median time ratio of at most 1.0 against Git Extensions. The window must never hang during any 002 workflow. The user said: "UX should not hang like never, Git Extensions does this all the time, I mean hangs."
- Q: Is the 128 MiB memory budget of SC-002 confirmed? → A: Yes. The measurement rules of SC-002 stay.
- Q: When does a message search start? → A: Only at Enter. A pause in typing does not start a search.

### Session 2026-10-12

- Q: Should history load the whole stream, or load progressively and unload the rows that are not visible? → A: The user said: "yes, we should do progressive loading, and unload what's not visible". The user also said: "the same approach we should use for all other lists we have, also for branch view". FR-054 and FR-055 encode this.
- Q: Do Git's own processes count toward the 128 MiB budget of SC-002? → A: No. The user said: "no, we should not count git own memory, we can do nothing about it". SC-002 bounds only the Arbareto processes and records the Git peaks apart (plan.md O-1).
- Q: How does the user select the branch scope of the history? → A: No tabs. A View menu checkbox, a branch context menu item, and a chip select it. The user said: "i don't like we have tabs for current branch and all branches … it should be nice looking interface". The user approved the mockups (plan.md D6): "no, that's enough i guess, i am ok". FR-049 encodes this.

### Session 2026-10-16

- Q: How does the references sidebar mark the current branch, and where do the copy buttons of the commit details sit? → A: The user asked for the current branch in bold. The user also asked for each copy button next to the value that it copies. T067 and T068 built both requests. FR-056 and FR-057 encode this.

## User Scenarios & Testing *(mandatory)*

Feature 001 shows one history page of at most 100 commits. This feature replaces that limit with the full history of a captured ref set. The default set covers all branches. The order of the journeys follows the reading flow: scroll, filter, then highlight.

### User Story 1 - Scroll to every commit (Priority: P1)

A developer opens a repository with a long history and scrolls to any commit, also the first commit.

**Why this priority**: Feature 001 stops at 100 commits. Every later history feature, and remote sync in feature 003, needs the full history.

**Independent Test**: Open disposable fixtures with known histories of up to 200,000 commits. Scroll to the end and compare every row and graph edge with Git. On a 1,000,000-commit fixture, press End, and measure the memory of the complete process tree near the top, after End, and during a search.

**Acceptance Scenarios**:

1. **Given** a history of more than 100 commits. **When** I scroll down. **Then** more commits show, and no page limit stops me.
2. **Given** a history of 1,000,000 commits. **When** I press End. **Then** the view shows its loading progress with Cancel, and then the last commit. Memory stays within the budget.
3. **Given** rows that already show. **When** more rows load, or I scroll away and back. **Then** each shown row keeps its position, its text, and its graph cell.
4. **Given** a long history. **When** I read it. **Then** each commit that the captured refs reach shows exactly once, and children precede parents.
5. **Given** a selected commit. **When** the details pane opens. **Then** it shows the full message up to the existing 16 KiB bound. The history rows hold only the subject.
6. **Given** the view shows history. **When** the checkout moves, or a ref is added, removed, or moved. **Then** the rows stay unchanged, and a notice states that the refs changed and offers Refresh.
7. **Given** that notice. **When** I select Refresh. **Then** a new view starts from the current refs and keeps the selected commit when the new refs reach it.
8. **Given** a repository with several local branches, remote-tracking branches, and tags. **When** history opens. **Then** the commits of all these refs show. Each row shows the labels of its refs, and the current checkout row is marked.
9. **Given** the all-branches view. **When** I switch to the current branch. **Then** only the commits that the current checkout reaches show, as in feature 001. **When** I switch back. **Then** all branches show again.
10. **Given** a long load, a scroll, a search, or a refresh. **When** I type, click, scroll, or press Cancel. **Then** the window responds, and Cancel stays available while Git works.
11. **Given** a long history. **When** I open it and read only the first rows. **Then** no Git process of the view runs after those rows show, and the view uses almost no memory.
12. **Given** a repository with thousands of refs. **When** the references sidebar shows them. **Then** it creates elements only for the rows near the visible area, and keyboard navigation reaches every ref.

---

### User Story 2 - Show only the commits whose message matches (Priority: P1)

A developer types text into the message filter and presses Enter. The view then shows only the commits whose message contains that text.

**Why this priority**: A filter over loaded rows only gives wrong answers in a long history. Git searches the whole history, so the result is complete.

**Independent Test**: Search fixtures with known messages, also Ukrainian text and a legacy encoding. Compare the shown matches and their order with Git's own search.

**Acceptance Scenarios**:

1. **Given** a history of 1,000,000 commits. **When** I filter by a word. **Then** every commit whose message contains the word shows, in history order, and no other commit shows.
2. **Given** filter mode. **When** matches show. **Then** a reduced graph joins each match to its nearest matching ancestors. A joined line that skips commits looks different from a direct parent line, also without color.
3. **Given** the filter text "Виправлення". **When** the search runs. **Then** messages with "виправлення" and "ВИПРАВЛЕННЯ" match.
4. **Given** the filter text "ß". **When** the search runs. **Then** a message with "ẞ" matches, and a message with only "SS" does not match.
5. **Given** a commit message that Git stores in a legacy encoding with its encoding name. **When** I filter by a word of that message. **Then** the commit matches.
6. **Given** a running search. **When** I clear the text or press Escape. **Then** the search stops, and the full history returns with the selection kept.
7. **Given** filter text with a line break, a NUL character, or a backslash followed by "E". **When** I try to search. **Then** the application refuses the text and states the reason. No search starts.
8. **Given** no commit matches. **When** the search ends. **Then** the view states that no commit message contains the text.

---

### User Story 3 - Step through matches in the full graph (Priority: P2)

A developer keeps the full history and graph, and moves from one match to the next across the whole history.

**Why this priority**: Context around a match matters during review. Filter mode removes that context.

**Independent Test**: Search fixtures with known match positions. Step with Next match and Previous match, and compare each position and the final count with Git.

**Acceptance Scenarios**:

1. **Given** highlight mode. **When** the search runs. **Then** the full graph stays, and each matching row shows a mark that does not depend on color.
2. **Given** a match far below the loaded rows. **When** I select Next match. **Then** the view loads the rows up to that match and selects it.
3. **Given** a running search. **When** matches arrive. **Then** the count states that more can follow. **When** the search ends. **Then** the count is final and states that it is final.
4. **Given** the first match or the last match is selected. **When** I select Previous match or Next match. **Then** the selection stays, and the view states that no earlier or later match exists.
5. **Given** a finished search. **When** I switch between filter mode and highlight mode. **Then** no new search starts, and the selected commit stays selected when it is in the new view.

---

### Edge Cases

- The checkout moves during a scroll. The view keeps its captured refs and order. A notice offers Refresh. The view never mixes rows of two ref sets.
- A ref is added, removed, or moved during a scroll. The view keeps its captured ref set, its rows, and its labels. A notice offers Refresh. A new ref shows only in a new view.
- A branch is rewritten or deleted after capture. The view stays valid while Git can read its commits. When Git reports a missing commit of the view, the view becomes stale with a typed reason. Shown rows stay, and Refresh starts a new view.
- A shallow clone ends at its shallow boundary. The graph marks the boundary as in feature 001. The filter states that it searched only the commits that the clone holds.
- An empty repository has no refs and no commits. History shows the empty state, and the filter is unavailable with a stated reason.
- The current branch is unborn, but other refs exist. The all-branches view shows the commits of the other refs, and no row is marked as the checkout. The current-branch view shows the empty state.
- HEAD is detached. The all-branches view includes the detached commit, marks it as the current checkout, and states that HEAD is detached. The current-branch view shows the history of that commit.
- A tag points to a tree or a blob, also through a chain of tags. It adds no row and no history label. A tag chain that ends at a commit labels that commit.
- Several refs point to the same commit. That commit shows once, with the labels of all its refs.
- A remote-tracking ref exists only from an earlier fetch. The view shows it as the local repository stores it. The view never contacts a remote.
- A history holds only merges, or many parallel lines. The graph width limit applies to each row. A row above the limit states the limit and keeps its parent information accessible.
- Commits have equal dates, or a child has an older date than its parent. Children still precede parents. The order never comes from dates alone.
- The user cancels a search, or changes the text during a search. The old search stops. A new search starts only at Enter. A partial count never shows as final.
- Git works slowly during a load, a search, or a refresh. The window keeps its response targets, and Cancel stays available.
- A repository lies in a WSL2 distro. Scroll and filter work through the distro's Git, with the same order and matching rules. Without the matching conditions there, the application refuses the filter with a typed reason and a remedy.
- Filter text starts with "-", or holds quotes or pattern characters. Git searches it as literal text, never as an option or a pattern.
- Filter text holds leading or trailing spaces. The search keeps them.
- A message is not valid text and names no encoding. The row shows replacement characters and the encoding label, as in feature 001. Matching of its non-text bytes is not promised.
- The process that reads history fails during a scroll. Shown rows stay, the view states the failure, and Refresh starts a new view.
- The repository has no commit-graph file. The first row waits longer, and each later load step waits as long again. The application never writes one.

## Requirements *(mandatory)*

### Scope Boundaries

Include the full history of one captured ref set, loaded in steps, a scrollable virtual list, and graph lanes for every row. Include a virtual list for the references sidebar. Include a switch between all branches and the current branch. Include commit bodies for the details pane only. Include one commit message filter with filter mode and highlight mode. Include a memory budget and speed comparisons with Git Extensions.

Exclude remote sync, ahead and behind counts, and remote operations (feature 003). Exclude several patterns, AND matching, and inverted matching. Exclude author, committer, date, path, and content filters. They come later on the same mechanism. Exclude history inspection features: Changes and Files tabs, historical diffs, and branch filtering. Git Extensions calls that filter "Show filtered branches". Exclude the reflog and older stash entries from the history rows.

The application never writes a commit-graph file, an index of messages, or any other repository data to make reads faster. It never starts repository maintenance.

Feature 001 rules stay in force unless a requirement here replaces them. FR-008 loses its 100-commit limit. FR-036 loses its page boundary.

### Functional Requirements

#### History view

- **FR-001**: History MUST cover the commits that the captured ref set reaches. The default scope is all branches. FR-047 defines the all-branches ref set, and FR-048 defines the current-branch ref set.
- **FR-002**: A history view MUST bind to one ref set and the repository generation, both captured when the view opens. It MUST NOT bind to HEAD alone. A later generation with the same refs and the same commits MUST keep the view.
- **FR-003**: Each commit that the captured refs reach MUST show exactly once. Every such commit MUST be reachable by scrolling, with no page limit, up to 4,000,000 commits in one view. At that bound, the load MUST end with a typed limit refusal. The loaded rows MUST stay, and the view MUST state the limit. Exception: a commit with more than 64 parents MUST end the load with a typed output-limit refusal.
- **FR-004**: Rows MUST keep one order for the life of a view. A row MUST NOT change its position after it shows. Children MUST precede parents. Dates alone MUST NOT decide the order.
- **FR-005**: The checkout can move, or a ref can change after capture. The view MUST then keep its rows and labels. It MUST show a notice that states the change and offers Refresh.
- **FR-006**: A new view MUST start only when the user asks for it, or when the view is stale. The contract MUST define every stale condition. Git's report of a missing commit of the view MUST be one of them.
- **FR-007**: A stale view MUST keep its shown rows, state its typed reason, and offer Refresh. It MUST NOT invent rows or edges.
- **FR-008**: Refresh MUST capture a new ref set in the same scope. It MUST keep the selected commit when the new refs reach it. The view MUST then load the rows up to that commit, with visible progress and Cancel. Otherwise it MUST select the current checkout commit. Without a checkout commit, it MUST select the first commit row. Cancel of that load MUST keep the loaded rows. It MUST select the checkout commit when that row is loaded. Otherwise it MUST select the first commit row.
- **FR-009**: End MUST load the rows up to the last commit, with visible progress and Cancel. Cancel MUST keep the loaded rows and the selection.
- **FR-010**: Until the last row is known, the view MUST state that more rows exist. The scroll range MUST then end after the loaded rows. The view MUST NOT show an estimated row count or scroll size. When the last row is known, the view MUST show the final row count.
- **FR-011**: The text and the graph cells of rows off screen MUST leave memory beyond a fixed cache bound. When such rows show again, they MUST show the same commit, text, and graph cell at the same position.
- **FR-012**: The view MUST stay usable during a load. Scrolling, selection, and Cancel MUST respond within the targets of FR-052.
- **FR-013**: The Working directory and Index rows MUST stay above the commits in every mode, as in feature 001.

#### Progressive load

- **FR-054**: The view MUST load commits in steps. A step MUST end at a stop row that is a fixed function of row counts only: the last needed row, the read-ahead, and the loaded row count (plan.md D2). The Git process of the step MUST then end. A new step MUST start when the shown rows come within the read-ahead of the last loaded row. The read-ahead and the step size MUST be row counts. They MUST NOT depend on time. End, a message search, and Refresh or a scope switch with a kept selection MUST load beyond the read-ahead. After Cancel or a deadline of a step, a new step MUST start only when the user scrolls to the end of the loaded rows.

#### Graph

- **FR-014**: The graph of each row MUST equal the graph of one layout of the whole history. It MUST NOT depend on the rows that loaded before or the scroll path.
- **FR-015**: Edges MUST follow Git parent identities across the whole history. Roots and shallow boundaries MUST stay distinct by shape and by text.
- **FR-016**: The graph width limit MUST apply to each row. A row above the limit MUST state the limit. Its parent information MUST stay accessible without color or pointer use. The graph column can grow while rows load. It MUST NOT shrink during the life of a view.

#### Commit details

- **FR-017**: The commit message body MUST load only when the details pane shows that commit. History rows MUST hold the subject, author, date, and references, not the body.
- **FR-018**: The details pane MUST keep the feature 001 body bound of 16 KiB. A longer body MUST end at a character boundary and state that it is cut.
- **FR-057**: The heading row of the details pane MUST hold no button. The Copy commit ID button MUST sit in the ID row and copy the full ID, also for a commit over the text limit. The Copy message button MUST follow the subject. It MUST copy the subject, a blank line, and the body. Each parent MUST have its own button "Copy parent ID <short ID>" that copies that parent ID. The short ID is the first 12 hexadecimal digits.

#### Message filter

- **FR-019**: The filter MUST search the whole message of every commit in the view: subject and body. The 16 KiB display bound MUST NOT limit the search.
- **FR-020**: Git MUST perform the search over the whole history. The application MUST NOT filter only the loaded rows.
- **FR-021**: The matches MUST come back in the full-history order of the view, with the non-matches removed. They MUST load through the same bounded mechanism as the rows.
- **FR-022**: Matching MUST be literal. Pattern characters, quotes, and a leading "-" MUST match as plain text.
- **FR-023**: Matching MUST ignore case through simple one-to-one Unicode case folding. Examples: "є" matches "Є", and "ß" matches "ẞ". "ß" MUST NOT match "SS". The application verifies this rule on the matching probe cases. For other characters, it relies on Git's caseless matching, and the contract records this gap.
- **FR-024**: Matching MUST give the same result for every user locale and every log output setting. It MUST cover non-ASCII text and messages that Git stores in a legacy encoding with its encoding name.
- **FR-025**: Without the matching conditions of FR-023 and FR-024, the filter MUST refuse with a typed reason and a remedy. It MUST NOT fall back to another matching rule.
- **FR-026**: Filter text MUST hold at most 1,024 bytes in UTF-8. Longer text MUST get a typed refusal.
- **FR-027**: Empty filter text MUST mean no filter. The view MUST then show the full history.
- **FR-028**: Filter text with a line break, a NUL character, or a backslash followed by "E" MUST get a typed refusal. No search MUST start. The refusal MUST name the found character. A line break is U+000A or U+000D.
- **FR-029**: The search MUST start only at Enter. A pause in typing MUST NOT start a search.
- **FR-030**: A changed text, a cleared text, Escape, and closing the repository MUST stop the running search. A stopped search MUST NOT show a count as final.
- **FR-031**: The filter MUST have an accessible name and a keyboard shortcut. The shortcut MUST show as the 001 rules require.

#### Filter mode

- **FR-032**: Filter mode MUST show only the matching commits, in the full-history order.
- **FR-033**: Filter mode MUST show a reduced graph. Each match MUST join to its nearest matching ancestors. A nearest matching ancestor is a matching ancestor with no other match on some parent path between the two.
- **FR-034**: A reduced edge that skips commits MUST look different from a direct parent edge. The difference MUST NOT depend on color alone.
- **FR-035**: When no commit matches, the view MUST state that no commit message contains the text.

#### Highlight mode

- **FR-036**: Highlight mode MUST show the full history and the full graph. Each matching row MUST show a mark that does not depend on color.
- **FR-037**: Next match and Previous match MUST move the selection across the whole history. This includes rows that did not load yet. They MUST load the rows up to the target with visible progress and Cancel.
- **FR-038**: At the first or the last match, Previous match or Next match MUST keep the selection. The view MUST state that no earlier or later match exists. The selection MUST NOT wrap.
- **FR-039**: While the search runs, the match count MUST state that more matches can follow. When the search ends, the count MUST become final and state that.
- **FR-040**: Next match and Previous match MUST have keyboard shortcuts and accessible names.

#### Modes and selection

- **FR-041**: A switch between filter mode and highlight mode MUST NOT start a new search when the text is unchanged.
- **FR-042**: A mode switch MUST keep the selected commit when the new view holds it. In filter mode, a non-matching selection MUST move to the next match in history order. With no later match, it MUST move to the last match.

#### Memory and repository data

- **FR-043**: The memory of a history view MUST grow only with the rows that it loaded. After the first load step ends (its `loadHistory` result arrived), the view MUST run no Git process and MUST add at most 16 MiB (SC-002). On the SC-002 fixture, End and a search MUST stay within the SC-002 budget. The SC-002 bounds count the Arbareto processes and exclude Git's child processes. Above 1,000,000 loaded commits, memory grows with the loaded rows up to the FR-003 bound.
- **FR-044**: The application MUST NOT write a commit-graph file, a message index, or any other repository data to make reads faster. It MUST NOT start repository maintenance.
- **FR-045**: History reads and searches MUST bound their output and support cancellation, as the feature 001 operation rules require.

#### WSL repositories

- **FR-046**: Scroll, graph, and filter MUST work for WSL2 repositories through the distro's Git. The same order, matching, ref set, and memory rules MUST apply.

#### History scope and refs

- **FR-047**: The all-branches ref set MUST hold HEAD and the refs under `refs/heads/`, `refs/remotes/`, and `refs/tags/`. It MUST also hold the `refs/stash` ref. The remote HEAD refs under `refs/remotes/` MUST belong to the set. The set MUST NOT hold refs under `refs/notes/` or any other namespace, such as `refs/pull/` or `refs/changes/`. Older stash entries MUST NOT show as rows. Unlike Git Extensions, the set shows branch history only and adds no rows that are not history. The ref set MUST hold at most 10,000 refs. A larger set MUST get a typed output-limit refusal that names the ref listing bound.
- **FR-048**: The current-branch ref set MUST hold only HEAD. The current-branch view MUST show the feature 001 history scope on the 002 mechanism. The current-branch view MUST start only from HEAD. Its rows MUST show the labels of the FR-047 refs that the view captured.
- **FR-049**: The history view MUST select all branches or the current branch without tabs. The default MUST be all branches. A View menu checkbox "Current branch only" MUST switch between the two scopes. The branch context menu MUST show the item "Show only this branch's history" only on the current branch, and the item MUST select the current-branch scope. While the current-branch scope is active, the history heading MUST show the removable chip "Current branch only ✕". Removal of the chip MUST select all branches. A switch MUST start a new view with a newly captured ref set. It MUST keep the selected commit when the new view holds it. A filter text MUST stay, and its search MUST run again on the new view in the same mode.
- **FR-050**: Each row MUST show a label for each captured ref that points to its commit. A tag MUST label the commit at the end of its tag chain. A tag that ends at a tree or a blob MUST add no row and no history label. The row of the captured checkout commit MUST show a mark that does not depend on color. A detached HEAD MUST show as detached. A symbolic ref, such as a remote HEAD ref, MUST add no label, as in feature 001.
- **FR-051**: The application MUST read remote-tracking refs only from the local repository. History MUST NOT contact a remote. Fetch stays in feature 003.

#### Responsiveness

- **FR-052**: The window MUST never stop responding during a 002 workflow. The workflows are open, load, a full scroll, End, and a search. They also include a mode switch, a scope switch, Cancel, and Refresh after a ref change. Each input MUST get a visible response within the feature 001 SC-005 targets. An interface task MUST NOT run longer than the SC-005 bound of 500 ms.
- **FR-053**: Cancel MUST stay available and respond while Git works. The application MUST NOT wait for a Git process before it handles input.

#### Other lists

- **FR-055**: The references sidebar MUST create elements only for the rows near the visible area. Keyboard navigation, the sidebar filter, and the expanded state MUST cover every ref. Each tree item MUST state its level, its position, and its set size, because not all items exist as elements.
- **FR-056**: The references sidebar MUST show the name of the current branch in bold. The current branch row MUST have `aria-current="true"`. Its accessible name MUST hold "Current", but its visible text MUST NOT. Other rows MUST NOT be bold or have `aria-current`. A detached HEAD MUST mark no row.

### Key Entities *(include if feature involves data)*

- **History view**: One captured ref set, its scope, the repository generation at capture, the row order, the loaded row count, and the final row count when it is known. Its stale state has a typed reason.
- **Captured ref set**: The scope, each ref name with its commit, the checkout commit, and the detached state of HEAD. The scope is all branches or the current branch. It does not change during the life of a view.
- **History row**: One commit with its position, subject, author, date, ref labels, checkout mark, parent identities, and graph cell. Its text can leave memory and come back unchanged.
- **Commit details**: The full message of one selected commit, up to the 16 KiB bound, with the feature 001 encoding rules.
- **Message search**: The filter text, its mode, and its state: running, finished, stopped, or refused. It holds its matches in history order and the match count with a final flag.
- **Reduced graph**: The matches of one search and the edges to their nearest matching ancestors. Each edge records whether it skips commits.
- **Memory budget**: The limit for the history view in the Arbareto processes (the shell, the service, and the WebView2 processes), and the measured use at each checkpoint. The measurement samples the complete process tree and records each Git process apart, without a bound.

## Success Criteria *(mandatory)*

### Measurable Outcomes

These outcomes are qualification targets, not measured results. Only recorded packaged tests can establish whether they pass. The user confirmed the SC-002 budget, its process scope, and the SC-011 ratio. SC-014 reuses the feature 001 SC-005 targets. The SC-002 first-screen bound and the SC-006 and SC-010 values are proposed. The plan fixes the fixtures, hardware, run counts, and timing boundaries before measurement.

- **SC-001**: On a 200,000-commit fixture, a scroll to the end shows every row from first to last as in Git's commit list, each commit exactly once. On a 1,000,000-commit fixture, End reaches the last commit, and the last row matches Git's last commit of the same captured ref set.
- **SC-002**: On a 1,000,000-commit fixture, the history view adds private memory to the Arbareto processes within two bounds. The Arbareto processes are the shell, the service, and the WebView2 processes. Both bounds exclude the Git child processes. After the first load step ends (its `loadHistory` result arrived), no Git process of the view runs, and the view adds at most 16 MiB. After End shows the last commit, after a return to the top, and during a filter search, the view adds at most 128 MiB. The base is the same worktree with a one-commit history. The measurement samples the complete process tree. Each record states the loaded row count. The record also states the peak private memory of each Git process next to the peak of the same Git command run alone. The Git peaks are recorded (research.md R14), but no bound applies to them.
- **SC-003**: In every order fixture, no shown row changes its position during the view's life. Fixtures include equal dates, clock skew, merges, and a history that holds only merges.
- **SC-004**: In every graph fixture, each graph cell equals the cell of one full layout of the whole history. Edges match Git parents. Rows above the width limit state the limit.
- **SC-005**: Time to the first row is recorded on the 200,000-commit fixture, with and without a commit-graph file. The time to the first new row of a later load step is recorded too. Git's own time to its first output under the same conditions is recorded next to it. No fixed target applies, because Git sets the floor. The record states the time that the application adds. Each record states the cache state. A cold run follows a reboot. A warm run follows one discarded run. Both use the feature 001 rules (001 plan.md "Measurements and budgets").
- **SC-006**: Filter latency is recorded on the 200,000-commit fixture: the time to the first match and to the final count. Git's own search time under the same conditions is recorded next to it. The application adds at most 10% or 500 ms to the time to the final count, whichever is larger. Each record states the cache state. A cold run follows a reboot. A warm run follows one discarded run. Both use the feature 001 rules (001 plan.md "Measurements and budgets").
- **SC-007**: In the matching fixture, every match and non-match agrees with FR-023 and FR-024. This holds on Windows and on each qualified WSL distro. Cases include "Виправлення" in lower and upper case, and the pairs є/Є, і/І, ї/Ї, and ґ/Ґ. They also include "ß" against "ẞ" and "SS", and a legacy-encoded message. Characters outside the probe stay unverified.
- **SC-008**: In every filter fixture, filter mode shows exactly Git's matches in full-history order. The reduced graph joins each match to exactly its nearest matching ancestors. Highlight mode reaches every match with Next match and Previous match, and the final count equals Git's match count.
- **SC-009**: Each refused text case shows its typed reason and starts no Git process. Cases are a line break, a NUL character, a backslash followed by "E", and more than 1,024 bytes.
- **SC-010**: A cancelled search and a cancelled load stop within one second. No process of that operation remains five seconds later. The view shows the full history or the loaded rows, and no count shows as final.
- **SC-011**: Against Git Extensions 7.2.1 (installed build 7.2.1.7, as pinned by feature 001 SC-015 and T180) under matched conditions, two workflows have a median time ratio of at most 1.0. They are a full scroll to the last commit, and a message filter over the whole history. Both run on the 200,000-commit fixture. The record states the work that each tool performs. The gate value is the upper bound of the 95% interval of the median ratio. This is the feature 001 SC-015 rule (001 plan.md "Measurements and budgets" and "Matched-condition comparisons").
- **SC-012**: The checkout moves, or a ref is added, removed, or moved during a scroll. No shown row or label changes. The notice appears within the feature 001 external-change target. Refresh shows the history of the new ref set. In a WSL repository, a change of a ref other than HEAD shows the notice at the next focus return, Refresh, or mutation outcome.
- **SC-013**: After every fixture run, the repository files are byte-identical to their state before the run. No commit-graph file or other repository data appears.
- **SC-014**: In the packaged application, every 002 workflow of FR-052 meets the feature 001 SC-005 targets. The workloads use the 1,000,000-commit fixture and slow Git activity. At least 95% of tested inputs get a visible acknowledgement within 100 ms. Every tested input gets a visible response within 500 ms. No interface task runs longer than 500 ms. Windows never reports the window as not responding. Cancel responds in every workflow while Git works.
- **SC-015**: In every ref fixture, the all-branches view shows exactly Git's commits for the FR-047 ref set. Each commit shows exactly once. Each label sits on the commit that Git gives for its ref, with annotated and nested tags. Tags that end at a tree or a blob add no row. The checkout row is marked, also for a detached HEAD. The current-branch view shows exactly Git's commit list for HEAD. Fixtures include remote HEAD refs, the stash ref, and several refs on one commit. They also include an unborn current branch beside other refs, and an empty repository. A notes ref, a ref in another namespace, and older stash entries add no rows.

## Assumptions

- The user chose all branches as the default scope (Clarifications). FR-047 lists explicit ref namespaces instead of the Git Extensions exclusion list. The namespace list is a reviewer default, not a user decision.
- Older stash entries are not part of this feature, and only the stash ref shows. A later stash feature adds them. This is a reviewer default, not a user decision.
- A scope switch runs an active search again on the new view (FR-049). This is a reviewer default, not a user decision.
- The shortcut of the "Current branch only" checkbox is Ctrl+Shift+B (FR-049). This is a reviewer default, not a user decision.
- The SC-002 base is the same worktree with a one-commit history (plan.md O-1, design SI-1). The base leaves out the fixed cost of the history view, so the bounds measure only growth with history size. This is a reviewer default, not a user decision.
- Graph data uses about 46 to 90 bytes for each loaded commit (plan.md D3), plus an 8 MiB cache of row text. Near the top, the view holds about 2,000 commits. After End or a search, it holds every commit. The budget applies to 1,000,000 commits. A larger history stays reachable up to the FR-003 view bound, and its memory grows with the loaded rows. This estimate is unverified. Qualification records a budget miss as a failure. The budget scope at 1,000,000 commits is a reviewer default, not a user decision.
- The read-ahead of 1,024 rows and the step rule are reviewer defaults (FR-054). Each step loads at least as many rows as the view holds. So the steps of a full scroll grow with the logarithm of the row count.
- A later load step reads the history again from the first row, with no skip count. The service compares each re-read row with the held row at the same position, by commit and parents. The first difference makes the view stale. Git documents no unique order, so a one-row overlap check cannot prove the skipped rows. The full compare uses only exact parses of Git output. The step size rule keeps the re-read rows of all steps that reach their stop row or the end below twice the final row count. A canceled step adds at most the rows it re-read. This is a reviewer default, not a user decision.
- The view shows only the rows of a load step whose topology check finished. When the user cancels a step before that check ends, the step's rows stay hidden. The next step reads them again, compares them, and shows them. This is a reviewer default, not a user decision.
- A failed read of commit text makes the whole view stale, as a failed load does (FR-006, FR-007). This covers a missing commit object and commit text that Git cannot give in the expected form. This is a reviewer default, not a user decision.
- Decision 2026-10-13: every `HISTORY_CHANGED` makes the view stale. A search merge break and a re-read difference both give reason `order`, and both make the view stale (contract Δ8 condition 3). This is a reviewer default, not a user decision.
- Decision 2026-10-13: a refused load of a stale complete view carries `{complete: true, reason}` with the stale reason. Only the limit reasons `HISTORY_VIEW_COMMITS` and `HISTORY_PARENTS_PER_COMMIT` never come with `complete: true` (contract Δ3 "Refusal result"). This is a reviewer default, not a user decision.
- Decision 2026-10-13: a failed matching probe step gives `GIT_FAILED` or `MALFORMED_GIT_OUTPUT`, not `SEARCH_UNSUPPORTED`, and makes the view stale. The service keeps no probe answer, so the search of a new view runs the probe again (contract Δ8 condition 4). This is a reviewer default, not a user decision.
- Decision 2026-10-13: WSL search runs the matching probe as one `run` frame with the field `script: "matchingProbe"`. No new channel frame exists (contract Δ3 "Matching probe", Δ6, Δ11). This is a reviewer default, not a user decision.
- Decision 2026-10-13: a trust revoke gates an open view. A later `loadHistory`, `readHistoryRows`, or `searchHistory` refuses with the gate code and starts no Git process (contract Δ7). This is a reviewer default, not a user decision.
- Known limit: Git can report a missing commit that lies several steps below every start point of the view. Then the view becomes stale with a general Git failure, not with the missing-commit reason (FR-006). Feature 001 has the same limit. This is a reviewer default, not a user decision.
- Known limit: the topology of each loaded row stays for the life of the view, at about 46 to 90 bytes per commit (unverified). Only the row text and the graph cells leave memory (FR-011). A return to the top does not free the topology. This is a reviewer default, not a user decision.
- Known limit: the changes list creates elements only for the visible rows, but it holds up to 100,000 entries of the status listing in memory (`STATUS_LISTING_RECORDS`). The references sidebar holds up to 10,000 refs. A larger ref set gets the FR-047 refusal. These are feature 001 bounds. Keeping these bounds is a reviewer default, not a user decision. Lists other than the history view and the references sidebar keep their feature 001 behavior in this feature: the changes list (already virtual, up to 100,000 entries in memory) and the diff lines. A diff holds up to 20,000 lines and 4 MiB (`CANONICAL_DIFF_LINES`, `CANONICAL_DIFF_BYTES`).
- A history view holds at most 4,000,000 commits (FR-003). That bound costs about 185 to 360 MB (about 46 B per commit when the typed arrays are nearly full, about 90 B just after a doubling) of service memory (unverified, plan.md D3). A larger bound needs a measured memory design. This is a reviewer default, not a user decision.
- The plan review set these rules: the FR-003 view bound and parent exception, the FR-008 Cancel selection, the FR-016 column growth, the FR-028 line-break characters, the FR-047 ref bound, the FR-048 labels, the FR-050 symbolic refs, the SC-011 statistic, the SC-012 WSL timing, the FR-026 byte bound, the FR-038 no-wrap rule, the FR-042 selection move, and the SC-010 values. These are reviewer defaults, not user decisions.
- The user confirmed the SC-011 ratio. The SC-002 first-screen bound, the SC-006 target, and the SC-010 values are proposed, and the plan confirms them before measurement. Feature 001 speed targets stay in force on the moderate fixture.
- SC-014 reuses the feature 001 SC-005 response targets. It adds no new values.
- The fixtures are synthetic disposable repositories of 200,000 and 1,000,000 commits, built at test time. They include merges, equal dates, clock skew, a shallow clone, and legacy-encoded messages. The fixture sizes and contents are reviewer defaults, not user decisions. Only the memory and responsiveness records use the 1,000,000-commit fixture: Git memory, End, a search, and the compressed list. Correctness, timings, and the Git Extensions comparison use the 200,000-commit fixture. This split is a reviewer default, not a user decision.
- The plan selects the Git Extensions workflow that searches the whole history for the message filter comparison. Its quick search covers only loaded rows, so it is not matched work.
- Git Extensions loads history in no fixed order and reorders rows after they show. Arbareto keeps one order, so the comparison measures matched work, not identical behavior.
- macOS and Linux stay unqualified. The matching rules need separate verification there and in each WSL distro before support claims.

## Research inputs

These facts come from an investigation on 2026-10-11 with Git 2.56.0.windows.1 on synthetic repositories. The plan uses them and names the mechanisms.

- Each view reads one ordered history stream, bound to the captured ref set, in load steps. A later step runs the same read again. Each row that the view holds must come again at the same position. Only the rows after them are new. The application keeps only the compact topology of each loaded commit (research.md R1 and R2).
- Paging with skip counts gives the same order, but each page walks the history again. A deep page takes about 0.9 s at 200,000 commits without a commit-graph file, and 0.18 s with one.
- A cursor that restarts from the parents not yet sent gives a different order. The investigation rejects it.
- Git documents no unique order. Repeatability of the order across two views is an experiment fact only. The spec requires one order only within one view.
- Without a commit-graph file, the first row waits for a walk of the whole graph: about 1 s at 200,000 commits. With a commit-graph file, it takes 48 ms.
- Without a commit-graph file, Git sorts the whole graph before its first row, so each later load step pays that walk again. With a commit-graph file, Git walks only the rows that a step reads (Git source).
- Git's message search keeps the real parents of each match. Its own graph output breaks at parents that do not match. The application must build the reduced graph itself.
- The matches of Git's message search come in exactly the full-history order, with the non-matches removed.
- Case folding of non-ASCII text needs Git to run with a UTF-8 locale and UTF-8 log output. The application must set both for the search.
- On a Git build with the PCRE2 library, literal matching wraps the pattern in quote marks. A backslash followed by "E" ends them. This Git defect causes the FR-028 refusal.
- Git reports no signal that tells whether it uses PCRE2. This is a contract gap. Linux, macOS, and each WSL distro need verification before the application relies on them.
- Today's lane layout can run page by page with equal results. Its state is the output lane array and the lane count. This is proven from the code, not tested yet.
- The page-wide graph width limit of feature 001 must become a rule for each row.
- Git Extensions streams the history with no order option and reorders rows after they show. Its quick search covers only the loaded rows.
- The default Git Extensions view is "Show all branches". It reads HEAD and every ref of the repository. By default it excludes the `refs/notes/commits` ref and the refs under `refs/sessions/` and `refs/copilot/checkpoints/`. It includes the stash ref, and it adds older stash entries from the stash list. It shows no reflog entries by default. Source: DeepWiki on gitextensions/gitextensions, 2026-10-11.
- Git Extensions also offers "Show current branch only" and "Show filtered branches". The current-branch choice reads the current commit and the stash ref.
