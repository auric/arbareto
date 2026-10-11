# Feature Specification: Full History and Commit Message Filter

**Feature Branch**: `002-full-history`

**Feature Directory**: `specs/002-full-history`

**Created**: 2026-10-11

**Status**: Draft

**Input**: User description: "Full history with bounded RAM. Commit bodies load only for the details pane. A commit message filter has filter and highlight modes. Compare the speed with Git Extensions and set a RAM budget."

## User Scenarios & Testing *(mandatory)*

Feature 001 shows one history page of at most 100 commits. This feature replaces that limit with the full history of the captured checkout. The order of the journeys follows the reading flow: scroll, filter, then highlight.

### User Story 1 - Scroll to every commit (Priority: P1)

A developer opens a repository with a long history and scrolls to any commit, also the first commit.

**Why this priority**: Feature 001 stops at 100 commits. Every later history feature, and remote sync in feature 003, needs the full history.

**Independent Test**: Open disposable fixtures with known histories up to 1,000,000 commits. Scroll to the end and compare every row and graph edge with Git. Measure the memory of the complete process tree.

**Acceptance Scenarios**:

1. **Given** a history of more than 100 commits. **When** I scroll down. **Then** more commits show, and no page limit stops me.
2. **Given** a history of 1,000,000 commits. **When** I press End. **Then** the view shows its loading progress with Cancel, and then the last commit. Memory stays within the budget.
3. **Given** rows that already show. **When** more rows load, or I scroll away and back. **Then** each shown row keeps its position, its text, and its graph cell.
4. **Given** a long history. **When** I read it. **Then** each commit that the captured head reaches shows exactly once, and children precede parents.
5. **Given** a selected commit. **When** the details pane opens. **Then** it shows the full message up to the existing 16 KiB bound. The history rows hold only the subject.
6. **Given** the view shows history. **When** the checkout moves to another commit. **Then** the rows stay unchanged, and a notice states that the checkout changed and offers Refresh.
7. **Given** that notice. **When** I select Refresh. **Then** a new view starts from the new head and keeps the selected commit when the new head reaches it.

---

### User Story 2 - Show only the commits whose message matches (Priority: P1)

A developer types text into the message filter. The view then shows only the commits whose message contains that text.

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

- The checkout moves during a scroll. The view keeps its captured head and order. A notice offers Refresh. The view never mixes rows of two heads.
- A branch is rewritten, so the captured head is no longer on a branch. The view stays valid while Git can read its commits. When Git reports a missing commit of the view, the view becomes stale with a typed reason. Shown rows stay, and Refresh starts a new view.
- A shallow clone ends at its shallow boundary. The graph marks the boundary as in feature 001. The filter states that it searched only the commits that the clone holds.
- An unborn branch has no commits. History shows the empty state, and the filter is unavailable with a stated reason.
- A history holds only merges, or many parallel lines. The graph width limit applies to each row. A row above the limit states the limit and keeps its parent information accessible.
- Commits have equal dates, or a child has an older date than its parent. Children still precede parents. The order never comes from dates alone.
- The user cancels a search, or changes the text during a search. The old search stops. A partial count never shows as final.
- A repository lies in a WSL2 distro. Scroll and filter work through the distro's Git, with the same order and matching rules. Without the matching conditions there, the application refuses the filter with a typed reason and a remedy.
- Filter text starts with "-", or holds quotes or pattern characters. Git searches it as literal text, never as an option or a pattern.
- Filter text holds leading or trailing spaces. The search keeps them.
- A message is not valid text and names no encoding. The row shows replacement characters and the encoding label, as in feature 001. Matching of its non-text bytes is not promised.
- The process that reads history fails during a scroll. Shown rows stay, the view states the failure, and Refresh starts a new view.
- The repository has no commit-graph file. The first row waits longer, and the application never writes one.

## Requirements *(mandatory)*

### Scope Boundaries

Include the full history of one captured head, a scrollable virtual list, and graph lanes for every row. Include commit bodies for the details pane only. Include one commit message filter with filter mode and highlight mode. Include a memory budget and speed comparisons with Git Extensions.

Exclude remote sync, ahead and behind counts, and remote operations (feature 003). Exclude several patterns, AND matching, and inverted matching. Exclude author, committer, date, path, and content filters. They come later on the same mechanism. Exclude history inspection features: Changes and Files tabs, historical diffs, and branch filtering.

The application never writes a commit-graph file, an index of messages, or any other repository data to make reads faster. It never starts repository maintenance.

Feature 001 rules stay in force unless a requirement here replaces them. FR-008 loses its 100-commit limit. FR-036 loses its page boundary.

### Functional Requirements

#### History view

- **FR-001**: History MUST cover the commits reachable from the captured current checkout [NEEDS CLARIFICATION: history scope. The project brief says one captured HEAD, the current checkout. Git Extensions shows all branches by default. This spec uses the current checkout as the default. The user has not confirmed this default yet.]
- **FR-002**: A history view MUST bind to one captured head commit and the repository generation at capture. A later generation with the same head MUST keep the view.
- **FR-003**: Each commit that the captured head reaches MUST show exactly once. Every such commit MUST be reachable by scrolling, with no page or count limit.
- **FR-004**: Rows MUST keep one order for the life of a view. A row MUST NOT change its position after it shows. Children MUST precede parents. Dates alone MUST NOT decide the order.
- **FR-005**: When the checkout moves to another commit, the view MUST keep its rows. It MUST show a notice that names the captured head and offers Refresh.
- **FR-006**: A new view MUST start only when the user asks for it, or when the view is stale. The contract MUST define every stale condition. Git's report of a missing commit of the view MUST be one of them.
- **FR-007**: A stale view MUST keep its shown rows, state its typed reason, and offer Refresh. It MUST NOT invent rows or edges.
- **FR-008**: Refresh MUST keep the selected commit when the new head reaches it. The view MUST then load the rows up to that commit, with visible progress and Cancel. Otherwise it MUST select the new head.
- **FR-009**: End MUST load the rows up to the last commit, with visible progress and Cancel. Cancel MUST keep the loaded rows and the selection.
- **FR-010**: Until the last row is known, the view MUST state that more rows exist. When it is known, the view MUST show the final row count.
- **FR-011**: Rows far off screen MAY leave memory. When they show again, they MUST show the same commit, text, and graph cell at the same position.
- **FR-012**: The view MUST stay usable during a load. Scrolling, selection, and Cancel MUST respond within the feature 001 responsiveness targets (SC-005 of feature 001).
- **FR-013**: The Working directory and Index rows MUST stay above the commits in every mode, as in feature 001.

#### Graph

- **FR-014**: The graph of each row MUST equal the graph of one layout of the whole history. It MUST NOT depend on the rows that loaded before or the scroll path.
- **FR-015**: Edges MUST follow Git parent identities across the whole history. Roots and shallow boundaries MUST stay distinct by shape and by text.
- **FR-016**: The graph width limit MUST apply to each row. A row above the limit MUST state the limit. Its parent information MUST stay accessible without color or pointer use.

#### Commit details

- **FR-017**: The commit message body MUST load only when the details pane shows that commit. History rows MUST hold the subject, author, date, and references, not the body.
- **FR-018**: The details pane MUST keep the feature 001 body bound of 16 KiB. A longer body MUST end at a character boundary and state that it is cut.

#### Message filter

- **FR-019**: The filter MUST search the whole message of every commit in the view: subject and body. The 16 KiB display bound MUST NOT limit the search.
- **FR-020**: Git MUST perform the search over the whole history. The application MUST NOT filter only the loaded rows.
- **FR-021**: The matches MUST come back in the full-history order of the view, with the non-matches removed. They MUST load through the same bounded mechanism as the rows.
- **FR-022**: Matching MUST be literal. Pattern characters, quotes, and a leading "-" MUST match as plain text.
- **FR-023**: Matching MUST ignore case through simple one-to-one Unicode case folding. Examples: "є" matches "Є", and "ß" matches "ẞ". "ß" MUST NOT match "SS".
- **FR-024**: Matching MUST give the same result for every user locale and every log output setting. It MUST cover non-ASCII text and messages that Git stores in a legacy encoding with its encoding name.
- **FR-025**: Without the matching conditions of FR-023 and FR-024, the filter MUST refuse with a typed reason and a remedy. It MUST NOT fall back to another matching rule.
- **FR-026**: Filter text MUST hold at most 1,024 bytes in UTF-8. Longer text MUST get a typed refusal.
- **FR-027**: Empty filter text MUST mean no filter. The view MUST then show the full history.
- **FR-028**: Filter text with a line break, a NUL character, or a backslash followed by "E" MUST get a typed refusal. No search MUST start. The refusal MUST name the found character.
- **FR-029**: The search MUST start at Enter. It MUST also start when the text stays unchanged for a delay that the plan sets.
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

- **FR-043**: The whole history view MUST stay within the RAM budget of SC-002. This includes a search and the end of a full scroll.
- **FR-044**: The application MUST NOT write a commit-graph file, a message index, or any other repository data to make reads faster. It MUST NOT start repository maintenance.
- **FR-045**: History reads and searches MUST bound their output and support cancellation, as the feature 001 operation rules require.

#### WSL repositories

- **FR-046**: Scroll, graph, and filter MUST work for WSL2 repositories through the distro's Git. The same order, matching, and memory rules MUST apply.

### Key Entities *(include if feature involves data)*

- **History view**: One captured head commit, the repository generation at capture, the row order, and the known row count. Its stale state has a typed reason.
- **History row**: One commit with its position, subject, author, date, references, parent identities, and graph cell. Its text can leave memory and come back unchanged.
- **Commit details**: The full message of one selected commit, up to the 16 KiB bound, with the feature 001 encoding rules.
- **Message search**: The filter text, its mode, and its state: running, finished, stopped, or refused. It holds its matches in history order and the match count with a final flag.
- **Reduced graph**: The matches of one search and the edges to their nearest matching ancestors. Each edge records whether it skips commits.
- **Memory budget**: The limit for the whole history view in the complete process tree, and the measured use at each checkpoint.

## Success Criteria *(mandatory)*

### Measurable Outcomes

These outcomes are proposed qualification targets, not measured results. Only recorded packaged tests can establish whether they pass. The plan fixes the fixtures, hardware, run counts, and timing boundaries before measurement.

- **SC-001**: On a 1,000,000-commit fixture, End reaches the last commit. The last row matches Git's last commit of the same head. Every row from first to last matches Git's commit list, each commit exactly once.
- **SC-002**: On a 1,000,000-commit fixture, the whole history view adds at most 128 MiB of memory. The base is the same workspace before history opens. The measure covers the complete process tree. It holds at the end of a full scroll, after a return to the top, and during a filter search.
- **SC-003**: In every order fixture, no shown row changes its position during the view's life. Fixtures include equal dates, clock skew, merges, and a history that holds only merges.
- **SC-004**: In every graph fixture, each graph cell equals the cell of one full layout of the whole history. Edges match Git parents. Rows above the width limit state the limit.
- **SC-005**: Time to the first row is recorded on 200,000-commit and 1,000,000-commit fixtures, with and without a commit-graph file. Git's own time to its first output under the same conditions is recorded next to it. No fixed target applies, because Git sets the floor. The record states the time that the application adds.
- **SC-006**: Filter latency is recorded on the 1,000,000-commit fixture: the time to the first match and to the final count. Git's own search time under the same conditions is recorded next to it. The application adds at most 10% or 500 ms to the time to the final count, whichever is larger.
- **SC-007**: In the matching fixture, every match and non-match agrees with FR-023 and FR-024. This holds on Windows and on each qualified WSL distro. Cases include "Виправлення" in lower and upper case, and the pairs є/Є, і/І, ї/Ї, and ґ/Ґ. They also include "ß" against "ẞ" and "SS", and a legacy-encoded message.
- **SC-008**: In every filter fixture, filter mode shows exactly Git's matches in full-history order. The reduced graph joins each match to exactly its nearest matching ancestors. Highlight mode reaches every match with Next match and Previous match, and the final count equals Git's match count.
- **SC-009**: Each refused text case shows its typed reason and starts no Git process. Cases are a line break, a NUL character, a backslash followed by "E", and more than 1,024 bytes.
- **SC-010**: A cancelled search and a cancelled load stop within one second. No process of that operation remains five seconds later. The view shows the full history or the loaded rows, and no count shows as final.
- **SC-011**: Against Git Extensions under matched conditions, two workflows have a median time ratio of at most 1.0. They are a full scroll to the last commit, and a message filter over the whole history. Both run on the 200,000-commit and 1,000,000-commit fixtures. The record states the work that each tool performs.
- **SC-012**: When the checkout moves during a scroll, no shown row changes. The notice appears within the feature 001 external-change target. Refresh shows the new head's history.
- **SC-013**: After every fixture run, the repository files are byte-identical to their state before the run. No commit-graph file or other repository data appears.

## Assumptions

- The history scope defaults to the current checkout, as the project brief states. The user has not confirmed it. FR-001 holds the open question.
- The 128 MiB budget comes from the research estimate: about 40 bytes of graph data for each commit, plus a 32 MiB cache of row text. At 1,000,000 commits that is about 72 MiB. The rest is headroom for measurement. Qualification records a miss as a failure.
- The SC-006 and SC-011 targets are proposed targets. The plan confirms them before measurement. Feature 001 speed targets stay in force on the moderate fixture.
- The fixtures are synthetic disposable repositories of 200,000 and 1,000,000 commits, built at test time. They include merges, equal dates, clock skew, a shallow clone, and legacy-encoded messages.
- The plan selects the Git Extensions workflow that searches the whole history for the message filter comparison. Its quick search covers only loaded rows, so it is not matched work.
- Git Extensions loads history in no fixed order and reorders rows after they show. Arbareto keeps one order, so the comparison measures matched work, not identical behavior.
- macOS and Linux stay unqualified. The matching rules need separate verification there and in each WSL distro before support claims.

## Research inputs

These facts come from an investigation on 2026-10-11 with Git 2.56.0.windows.1 on synthetic repositories. The plan uses them and names the mechanisms.

- Each view reads one history stream, bound to the captured head. It reads only as fast as rows are needed. This gives an exact order by construction.
- Paging with skip counts gives the same order, but each page walks the history again. A deep page takes about 0.9 s at 200,000 commits without a commit-graph file, and 0.18 s with one.
- A cursor that restarts from the parents not yet sent gives a different order. The investigation rejects it.
- Git documents no unique order. Repeatability of the order across two views is an experiment fact only. The spec requires one order only within one view.
- Without a commit-graph file, the first row waits for a walk of the whole graph: about 1 s at 200,000 commits. With a commit-graph file, it takes 48 ms.
- Git's message search keeps the real parents of each match. Its own graph output breaks at parents that do not match. The application must build the reduced graph itself.
- The matches of Git's message search come in exactly the full-history order, with the non-matches removed.
- Case folding of non-ASCII text needs Git to run with a UTF-8 locale and UTF-8 log output. The application must set both for the search.
- On a Git build with the PCRE2 library, literal matching wraps the pattern in quote marks. A backslash followed by "E" ends them. This Git defect causes the FR-028 refusal.
- Git reports no signal that tells whether it uses PCRE2. This is a contract gap. Linux, macOS, and each WSL distro need verification before the application relies on them.
- Today's lane layout can run page by page with equal results. It must carry the output lane array and the set of sent commits. This is proven from the code, not tested yet.
- The page-wide graph width limit of feature 001 must become a rule for each row.
- Git Extensions streams the history with no order option and reorders rows after they show. Its quick search covers only the loaded rows.
