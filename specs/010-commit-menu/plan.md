# Implementation Plan: History Commit Menu

**Branch**: `010-commit-menu` | **Date**: 2026-11-04 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/010-commit-menu/spec.md`, and the design plan of 2026-11-04 with its Git probes (local scratch).

**Related**: [research.md](research.md) | [data-model.md](data-model.md) | [contracts/operations.md](contracts/operations.md) | [quickstart.md](quickstart.md)

**Mockup** (T002, user approval of 2026-11-04 with the orchestrator defaults): [History commit menu mockup](https://claude.ai/artifact/7s2QiFoeBkVbwsnNHqfTLQ). Boards: the D10 list. The decisions are in "Open items and reviewer defaults".

## Summary

History gets a context menu on each commit row. The menu holds seven items in four groups (D11 "Menu"). Check out and Create branch reuse the 004 actions. Copy is a renderer action. Reset, Create tag, Cherry-pick, and Revert are four new workbench actions. Each has a review and a single-use run (004 contract Δ3). A stopped cherry-pick or revert ends in the app through Abort and Continue in the Notices band.

Five facts drive the design (research R2 and R3):
- `reset --hard` overwrites an untracked file at a target path, and it replaces an untracked file by a folder (P4). So Hard refuses an untracked file in the way, as the 004 Discard-and-switch does.
- `diff-tree HEAD <target>` misses a path that `git rm --cached` removed from the index (P4b). `diff-index --cached -R <target>` catches it (P15). So the Hard check lists its candidates from the index.
- `tag -m` without `-a` respects `tag.forceSignAnnotated`, and an explicit `-a` overrides it (P8, git-tag(1)). So the annotated step passes `-m` only.
- A single cherry-pick or revert leaves `CHERRY_PICK_HEAD` or `REVERT_HEAD` and no `.git/sequencer` (P1, P2c). The status reader already maps them to `cherry-picking` and `reverting`. So the 003 conflict row can finish them.
- Git documents no exit status for reset, cherry-pick, revert, tag, and checkout. So their outcomes come from fresh reads. Only check-ref-format, show-ref `--exists`, merge-base `--is-ancestor`, and diff-index `--quiet` decide through their documented exit codes.

## Technical Context

**Language/Version**: The 001 to 008 versions stay: TypeScript `7.0.2`, Bun `1.4.4` (exact), Rust/Cargo `1.99.0`.

**Primary Dependencies**: No new package and no new Rust crate. The icons come from the installed free hugeicons set.

**Storage**: None. The feature changes repository data only through Git commands.

**Testing**: Bun tests in real disposable repositories with Git oracles on a copy (`tests/git`). Contract tests and golden vectors (`tests/contracts`, `tests/vectors`). Cargo tests for the shell. Packaged tests through UI Automation and CDP (`tests/windows`). WSL tests on `Ubuntu-26.04` with Git 2.55 (`tests/wsl`).

**Target Platform**: Windows 11 x64 with WebView2 and Git for Windows (2.56.0.windows.2 on the reference PC). WSL2 repositories run the distro's Git. The Git floor stays 2.55.0 on Windows (`admission.ts:9`) and in WSL (`wsl-route.ts:12`).

**Project Type**: Local-first desktop application: Tauri 2 shell, compiled Bun Git service, React renderer.

**Performance Goals**: Spec SC-010a to SC-011 (D9). The user approved the budgets on 2026-11-04, before any measured run.

**Constraints**: Every argument array starts with `--no-lazy-fetch` (001 contract §7). Reads add `--no-optional-locks --literal-pathspecs` (`workbench-commands.ts:12`). Object IDs pass `isObjectId` (`workbench-commands.ts:48-51`), so no ID reads as an option. Steps run under policy `integrate`, which sets `GIT_TERMINAL_PROMPT=0` and `GIT_EDITOR=:` (003 contract `:216`). Every outcome comes from a fresh read or a documented exit code (spec FR-001).

**Scale/Scope**: Seven menu items, four new workbench actions, and two new conflict-row kinds. The bounds stay: `IN_THE_WAY_PATHS` 100, `DISCARD_CHECK_PATHS` 20,000, `MERGE_MESSAGE_BYTES` 8 KiB, `WINDOWS_COMMAND_LINE_UNITS`, and at most 64 parents (`HISTORY_PARENTS_PER_COMMIT`, `limits.ts:32`). No new limit constant.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Checked against principles I to IX of `.specify/memory/constitution.md` version 4.0.0 on `main` `f0d79499`, footer "**Version**: 4.0.0 | **Ratified**: 2026-09-28 | **Last Amended**: 2026-10-22".

| Principle | How the design meets it | Status |
|---|---|---|
| I. Preserve user data | Principle I says: "resets ... MUST require explicit confirmation of their scope and effects". The Reset popover states the scope and the effects, and it is the explicit confirmation of Soft and Mixed. Hard asks again in the 008 alert dialog with Cancel first. Hard refuses an untracked file in the way (D4). A stop ends in the app (D6). Hooks run as Git runs them (spec FR-005). | Pass |
| II. TypeScript/Bun | The reviews, plans, and outcome rules are TypeScript (D13). Rust changes only names, sentences, and phases (D7). | Pass |
| III. Validated boundaries | Four typed payloads with zod schemas and explicit Rust checks (contract Δ3). The tag name passes a contract rule and `check-ref-format` (D3). Every list has a bound (contract Δ5). | Pass |
| IV. Real Git verification | Every story test runs in a real disposable repository and compares with Git's own command on a copy (D14). | Pass |
| V. Untrusted repositories | No repository program runs before trust approval (spec FR-004). Paths and Git output show as plain text. | Pass |
| VI. Platform evidence | Packaged Windows tests for the menu, the keys, the Hard dialog focus, forced colors, text scale, and the budgets (WP7). WSL tests on Ubuntu-26.04 (WP6). | Pass |
| VII. Accessible and measured | Every item has a label, an icon, an accessible name, and a stated reason when unavailable (D1). Reset has its own group, and only the Hard option has the danger color. The budgets were fixed before measurement (D9). | Pass |
| VIII. Locked dependencies | No new package and no new crate. | Pass |
| IX. One planning process | All artifacts stay in `specs/010-commit-menu`. The contract lists only deltas. The earlier specs change only in WP8 (D12). | Pass |

No violation, so Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/010-commit-menu/
├── spec.md
├── plan.md                 # This file
├── research.md             # Phase 0
├── data-model.md           # Phase 1
├── quickstart.md           # Phase 1
├── contracts/
│   └── operations.md       # Phase 1: deltas to the 001 to 008 contracts
├── checklists/
│   └── requirements.md
└── tasks.md                # Phase 2
```

### Source Code (repository root)

```text
src/
├── contracts/              # channel.ts (actions), envelope.ts (payloads, plans, runs), errors.ts (reasons), operations.ts (phases)
│                           # new: tag-name.ts (tagNameRefusal); schemas/
├── git-service/            # workbench-commands.ts (argv builders), switch.ts (exports, generalized inTheWayCheck), merge-rebase.ts (exports),
│                           # sync-commands.ts, sync-review.ts, sync-integrate.ts (stop kinds), status.ts (marker facts), session.ts
│                           # new: commit-actions.ts (reset, create-tag, cherry-pick, revert-commit)
└── frontend/               # history/HistoryList.tsx, branches/{BranchActions.tsx,texts.ts}, changes/{RevertConfirm,HunkControls}.tsx,
                            # sync/{ConflictActions.tsx,useSync.ts}, app/{NoticeBand,Workbench}.tsx, commit/CommitTray.tsx,
                            # trust/ask.ts, status/OperationStatus.tsx
                            # new: history/{CommitActions.tsx, commit-texts.ts}
src-tauri/src/              # close.rs (Mutation names), dialogs.rs (action_sentence), schema.rs (phases, started actions)
tests/
├── contracts/              # new: commit-actions-contract.test.ts, tag-name.test.ts, commit-menu.test.tsx, commit-actions.test.tsx
│                           # changed: workbench-commands.test.ts, sync-conflicts.test.tsx, workbench-branches.test.tsx
├── git/                    # new: reset.test.ts, create-tag.test.ts, cherry-pick-revert.test.ts; changed: sync-conflicts.test.ts, workbench-fixtures.ts
├── vectors/                # new: valid/commit-*.json and invalid/commit-*.json
├── wsl/                    # new: commit-actions-wsl.test.ts; changed: workbench-wsl-harness.ts
└── windows/                # new: commit-menu-packaged.test.ts, commit-menu-perf.test.ts; changed: perf-fixtures.ts (fixture M-R)
```

**Structure Decision**: The three-part layout stays: renderer, Bun service, and shared contracts, with a thin Tauri shell. Shared code holds no Win32 FFI. Windows-only behavior stays in `src-tauri/src/` and `tests/windows/`.

## Design

This plan numbers its design sections by topic. The design plan of 2026-11-04 (local scratch) holds the same content in sections A to J.

### Steps (riskiest proof first)

| Step | Files and symbols | Behavior change | Tests that prove it | Main risk |
|---|---|---|---|---|
| P0 Git facts | local scratch only (T001) | None. | P1 to P15 of research R2 on the installed Git. | A fact differs on the current Git. Then research, this plan, and the contract change first. |
| P1 Mockup | local scratch only (T002) | None. | User approval of the D10 boards. | The layout changes texts. D11 changes first. |
| P2 Contracts | `src/contracts/*`, `tests/vectors/` (WP2) | Adds the four actions, phases, payloads, plans, runs, and reasons. | Schema tests, vectors, the tag-name rule test. | typify drops ranges. Keep explicit Rust checks. |
| P3 Shell | `close.rs`, `dialogs.rs`, `schema.rs` (WP3) | Names, trust sentences, and phases of the new actions. | Cargo tests. | The typify build fails while a schema and `close.rs` disagree (plan R6). |
| P4 Service | new `commit-actions.ts`, `workbench-commands.ts`, `switch.ts`, `merge-rebase.ts`, sync files, `status.ts` (WP4) | US2 to US4 in the service. | SC-001 to SC-007 in `tests/git`. | The Hard in-the-way check misses a path (P4b). |
| P5 Frontend | `history/*`, `branches/*`, `sync/*`, `app/*` (WP5) | The menu, keys, popovers, the Hard dialog, and the band row. | Component tests per FR. | The amended label key rule changes tested 004 behavior (plan R3). |
| P6 WSL | `tests/wsl/commit-actions-wsl.test.ts` (WP6) | None (tests). | US5, SC-008. | `gitPathExists` without the WSL mapping (research R5 U1). |
| P7 Qualification | `tests/windows/commit-menu-*.test.ts` (WP7) | None (tests). | SC-009, SC-010a to SC-011. | Menu placement beside a full-width row (research R5 U2). |

Each step writes its tests first.

### D1 Menu

Opening:
- A right-click on a commit row body selects the row first, as a click does (`HistoryList.tsx:500-504`). The details dock as for a click.
- A right-click on a branch or remote-tracking chip keeps the 004 branch menu. `LabelChip` calls `stopPropagation` (`HistoryList.tsx:150`).
- Shift+F10 or the Menu key on the selected commit row opens the commit menu while no label is active. After Left or Right makes a label active, the keys open the branch menu of that label. This matches the 004 D15 "History labels" text: "no label is active until Left or Right moves it" (004 `plan.md:382`). Today the code opens label 0 without a move (`HistoryList.tsx:416`, `:472`).
- Left on the first label makes no label active, and the live region states `COMMIT_ANNOUNCE`. Right from no label goes to the first label.
- The Working directory row, the Commit index row, the More commits row, and a Loading row open no menu. Shift+F10 there does nothing, as on a 004 folder row (004 FR-108).
- The menu anchors to the row option, as the 005 Changes row menu does (`ChangesPane.tsx:1184`). `byKey` focuses the first item (`action-menu.tsx:57`). On close, focus goes back to the history listbox, because the option is no focus target under `aria-activedescendant`. An item that opens a popover hands the focus off, as `BranchActions.tsx:348` does.
- Geometry (mockup defaults 2 and 3): a right-click opens the menu below the row, at the pointer x. Shift+F10 and the Menu key open it below the row, at the row start. The menu stays inside the window. When any item shows a reason, the menu is 320 px wide, and each reason wraps below its label.
- The confirm popover never extends past the window. Its height is at most the available height, and its body scrolls.
- Focus: a refusal of the named Create tag review, such as a tag that exists, puts the focus on Tag name. The last Mark resolved removes its row button. When the focus was on that button, Continue in the band takes the focus. This applies in all four in-app states: merge, rebase, cherry-pick, and revert.

Items and groups: the labels, order, and groups of D11 "Menu". Create branch here keeps `KEYS.createBranch` (Ctrl+B, `shortcuts.ts:180`). No item gets a new key. Git Extensions has none for these items. A new key needs the 004 R13 collision check. `ITEM_REVERT` is the label that 008 reserved (008 `spec.md:358`). Reset has its own group (constitution VII). The Reset item has no danger color. The Hard option in the popover has it, as Discard does (`BranchActions.tsx:556`). On a detached or unborn HEAD, the Reset label drops the branch name, as `T.merge(null)` does (`branches/texts.ts:55`).

Availability: the client reads the latest `readWorkspace` head and operation state, and `mutationReason` (`Workbench.tsx:1773`). The service review checks every rule again.

| Condition | Unavailable items | Reason (D11 key or source) |
|---|---|---|
| A mutation runs | all but Copy | `RUNNING_REASON` (`running-tooltip.tsx:10`), quiet |
| State unknown or refreshing | all but Copy | `BLOCKED_TEXT.unknown` and `.refreshing` (`HunkControls.tsx:34-46`) |
| Merge, rebase, cherry-pick, or revert in progress | all but Copy | `BLOCKED_TEXT.operation`, new text in D11 |
| Conflicts without a marker, `sequencer-active`, unknown operation | all but Copy | `BLOCKED_TEXT.conflicted` (`HunkControls.tsx:35`) |
| Detached HEAD | Cherry-pick, Revert, Reset | `TEXTS.detached` (`integrate/texts.ts:64`) |
| Unborn current branch | Cherry-pick, Revert, Reset | `TEXTS.unborn` (`integrate/texts.ts:65`) |
| Detached HEAD at this commit | Check out | `AT_COMMIT` (D11) |

- A root commit has no reason (P5, P12). A merge commit has no menu reason. The popover asks for the parent (D5).
- The review keeps these rules: already on the branch, dirty tree, tag name, and signing.

Keyboard and accessibility (arbareto-ux skill §2, 004 FR-085 and FR-087, 008 FR-045):
- The list stays one Tab stop. No chip or row gets a tabindex.
- Each item has a label, an icon, and an accessible name. An unavailable item stays focusable and states its reason (`action-menu.tsx:105-114`).
- Popovers focus the first field or the preselected radio first. The Check out confirmation keeps Cancel first (D2). Escape cancels and returns focus to the list.
- The Hard dialog follows 008 FR-008 and FR-047. It is an alert dialog, and Cancel has the first focus. It has no default button and no access key on the danger button. Enter on Cancel cancels, and Escape cancels. The result goes to the status region.
- Forced colors, both themes, both densities, and 150% and 225% text scale.
- Keys and selection have no motion. Menu and popover motion follow the 004 plan "Motion".

### D2 Check out, Create branch, Copy

- Check out reuses the 004 `switch` with `target: { detach: <oid> }` (`envelope.ts:282-286`, `switch.ts:208-359`). The step is `checkout --no-recurse-submodules --detach <oid> --` (`workbench-commands.ts:241-243`).
- Frontend: `useBranchActions` gets `checkout(oid, anchor)`. It calls `reviewSwitch({ detach: oid }, shortId(oid), anchor, true, await preset())` (`BranchActions.tsx:168`). `confirm = true`, so the confirmation always shows.
- `SwitchConfirm` (`BranchActions.tsx:527-569`) for a detach target uses `CHECKOUT_TITLE`, `T.detachNote`, and `CHECKOUT_BUTTON` (D11). With the Discard choice, the button is `CHECKOUT_DISCARD_BUTTON`, as `T.discardSwitch` is for a switch. The first focus stays on Cancel, the `ConfirmPopover` default (`confirm-popover.tsx:38`). The Keep, Stash, and Discard choices, the unreachable note, and the in-the-way refusal stay as 004 FR-009 to FR-013. The outcome is `OUTCOME.detached`.
- Refusals and binding stay as in 004 (`switch.ts:222-263`).
- Create branch reuses `branches.create(oid, anchor)` (`Workbench.tsx:786`, `BranchActions.tsx:237-241`). No service change.
- Copy commit ID calls `useCopy()(row.oid)` (`RepositoryStates.tsx:31`). It copies the full object ID, as `CommitDetails.tsx:130,144` does. It is always available.

### D3 Create tag

Payload `{ action: "create-tag", name: TagName | null, target: ObjectId, message: TagMessage | null }`. A `null` message gives a lightweight tag.

- Popover: `TAG_LIGHT` is preselected each time (user decision, 2026-11-04). A typed message selects `TAG_ANNOTATED`. With `TAG_ANNOTATED` and a blank message, the button is unavailable with `TAG_MESSAGE_NEEDED`. The renderer sends `message: null` for `TAG_LIGHT`. A switch back to `TAG_LIGHT` clears the Message field. The radio group has the legend `TAG_KIND`.
- Reviews: the popover reviews when it opens, with `name: null` and `message: null`. That review runs reads 4 and 5 and skips reads 1, 2, 3, and 6. It returns the plan with no token. It does not refuse with `tag-signing`. The 004 Create branch popover reviews only on confirm (`BranchActions.tsx:243-252`), so this open review is new.
- Signing facts: the plan holds `signs: { light, annotated }`. `light` is the effective `tag.gpgSign`. `annotated` is true when `tag.gpgSign` or `tag.forceSignAnnotated` is true. With `TAG_ANNOTATED` and `signs.annotated`, the popover shows `TAG_SIGNS`. With `TAG_LIGHT` and `signs.light`, it shows `TAG_REASON.tag-signing`, and Create tag is unavailable. A kind switch starts no review.
- Create tag reviews again with the name and the message, and then runs with the new token. A `name-exists` refusal shows after Create tag.
- While Tag name is empty, Create tag stays unavailable. It needs no reason text.
- Reads, in order (the contract Δ3 numbering):
  1. Precheck, before any Git process: the new contract rule `tagNameRefusal` in `src/contracts/tag-name.ts`, a mirror of `branch-name.ts`. An empty name, NUL, or a control character gives `INVALID_REQUEST`, as `branchNameRefusal` does. A leading `-` gives `invalid-name` (P9). `HEAD` (P9) and `@` give `reserved-name`. The byte bound is `BRANCH_NAME_BYTES` (255), as in `branch-name.ts`. `isObjectId(target)` holds. The message is strict UTF-8, not blank, and at most `MERGE_MESSAGE_BYTES` 8 KiB (`limits.ts:167`).
  2. `check-ref-format refs/tags/<name>`: exit 0 passes. Another exit gives `invalid-name`.
  3. `show-ref --exists refs/tags/<name>`: 0 gives `name-exists` `{ ref }`. 2 passes. Another exit gives `GIT_FAILED`. Reuse `refExists` (`branch-ops.ts:42-46`).
  4. Target commit: `cat-file --batch-command` with `info <oid>^{commit}`. Reuse `detachCommit` (`switch.ts:136-146`), exported. Missing gives `UNKNOWN_TARGET`.
  5. Signing facts from the trust listing entries: the last `tag.gpgsign` and `tag.forcesignannotated`, parsed with `parseMaybeBool`, as `merge-rebase.ts:82-91` does. A value that is no boolean gives `invalid-config`, because `git_tag_config` dies on it for every tag command. A review with a name refuses a lightweight tag with `tag-signing` when `signs.light` is true (P8). It binds the `signs` value of the selected kind.
  6. Command-line bound: `stepUnits(ctx, "integrate", args) > WINDOWS_COMMAND_LINE_UNITS` gives `message-size`, as `merge-rebase.ts:236` does.
- Step `tag`: lightweight `[L, "tag", "--end-of-options", name, oid]`. Annotated `[L, "tag", "-m", message, "--end-of-options", name, oid]`. No `-a`, so `tag.forceSignAnnotated` applies (P8). No `-f`, no `--no-sign`. Git cleans the message with its default `strip` mode.
- Bound: `{ absent: true, signs }`, with the `signs` value of the selected kind. The dispatcher binds HEAD, state, and trust.
- Outcome from a fresh `observe`: intended = exit 0, and only `refs/tags/<name>` is new. A lightweight value equals the target. An annotated value differs, and `info <value>^{commit}` gives the target. HEAD and state are unchanged. Reuse the `settle` pattern (`branch-ops.ts:81-100`). No new ref, and nothing changed: `no-effects`, `failed`, `GIT_FAILED` with the output tail. Any other fact set with a change: `failed-with-effects` with the changed facts. Probe P16 shows such a case. A reference-transaction hook writes another ref and aborts the tag.
- Push stays out of scope (003 `spec.md:226`). The outcome text says so.

### D4 Reset current branch to here

Payload `{ action: "reset", target: ObjectId, mode: "soft" | "mixed" | "hard" }`. The popover preselects Mixed each time (user decision, 2026-11-04). A mode change reviews again, because the token binds the payload, as the switch choice does (`BranchActions.tsx:192-193`).

- Reads, in order, after the dispatcher:
  1. An unborn HEAD gives `unborn`. A detached HEAD gives `detached` (reviewer default, as 004 FR-028).
  2. `indexState`: unmerged > 0 gives `CONFLICTED`, as `merge-rebase.ts:276-278` does.
  3. Target commit (`detachCommit`).
  4. Counts through `revCount` (`workbench-review.ts:154`): `leave = rev-list --count <target>..HEAD`; `gain = rev-list --count HEAD..<target>`; `reflogOnly = rev-list --count HEAD --not <target> --exclude=<branch> --branches --tags --remotes`. The last form follows `unmergedCountArgs` (`workbench-commands.ts:151-154`).
  5. Force note: reuse `forceNoteOf(ctx, head, target, leave, entries)` (`merge-rebase.ts:131-153`), exported. It names the tracking ref when that ref holds a commit that leaves.
  6. Tracked status: `trackedStatus` (`switch.ts:43-53`), exported. It gives a digest and a count.
  7. Hard only, the in-the-way check. Generalize `inTheWayCheck` (`switch.ts:160-206`) so that it takes the candidate listing. Reset passes `diff-index --cached -R -z --no-renames --name-status <target> --` (P15). This listing also catches the `git rm --cached` path of P4b, which `diff-tree HEAD <target>` misses. `discardCandidates`, `sortFacts`, `untrackedOf`, `ignoreRead`, and `inTheWay` stay as they are (`switch-check.ts`). More than `DISCARD_CHECK_PATHS` candidates give `limit`, as the 004 check does (`switch-check.ts:45`, `switch.ts:167`). A non-empty verdict gives `UNTRACKED_IN_WAY` `{ reason: "untracked-in-way", paths (first 100), more }`. The check also returns the count of ignored candidates (`counted.length - left.length`) as `ignoredReplaced`, because Git replaces them (P4c). Hard reset counts each ignored file below an ignored folder in the way, from `ls-files -z --others --ignored --exclude-standard -- <folders>`. The folder itself does not count. Switch with Discard does not run that read, and there an ignored folder counts as one.
- A target at the branch tip is valid. Then the branch ref does not move.
- Plan: `{ target, mode, branch, from, leave, gain, reflogOnly, forceNote, trackedChanges, ignoredReplaced }`. Bound: the plan fields and the tracked digest.
- Step `reset`: `[L, "reset", "--quiet", "--no-recurse-submodules", "--<mode>", oid, "--"]` (P3). `--` ends the revision, and no path follows. `--no-recurse-submodules` keeps `submodule.recurse` from a reset of submodule worktrees, as the switch does.
- Outcome from `observe` and `trackedStatus`. Intended for every mode: exit 0, and HEAD `{ branch, same ref, oid: target }`. No ref other than `refs/heads/<branch>` changed, and that ref equals `target`. The state is normal, and no lock exists. Soft: the index fingerprint is unchanged. Mixed: `diff-index --cached --quiet <target> --` gives exit 0. Hard: the same, and `trackedChanges()` (`merge-rebase.ts:122-128`, `--ignore-submodules=all`) is false. `changed` covers refs, HEAD, the index fingerprint, the tracked digest, the state, or a lock, as `switch.ts:352` does.
- Effects per mode (git-reset(1) and the probes):
  - Soft: the index and the working files stay. The difference between the old tip and the target shows as staged changes. Untracked files stay.
  - Mixed: the working files stay. The index equals the target. Staged new files become untracked (P4e). Untracked files stay.
  - Hard: the index and the tracked working files equal the target. Unstaged and staged changes go, also staged new files (P4d). Untracked files that are not in the way stay. An untracked file in the way refuses (read 7). Git replaces ignored files in the way (P4c). Submodule worktrees stay. The 001 submodule notice then offers Update submodules.
  - Every mode: the commits of `<target>..HEAD` leave the branch. Git sets ORIG_HEAD. With `reflogOnly > 0`, only the reflog keeps them, for a limited time.
- Confirmation: the popover is the explicit confirmation of Soft and Mixed (constitution I). For Hard, the popover button opens the 008-style alert dialog (D13 `AlertConfirm`). Its danger button runs.

### D5 Cherry-pick commit and Revert commit

Payloads `{ action: "cherry-pick" | "revert-commit", commit: ObjectId, mainline: integer 1..64 | null }`. 64 is `HISTORY_PARENTS_PER_COMMIT` (`limits.ts:32`).

- Renderer: a row with two or more parents sends `mainline: 1`, so parent 1 is preselected. Another row sends `null`. The popover shows the parents of the review result, not of the row (research R5 U4). A `mainline-needed` or `not-merge` refusal shows the parents or the D11 text, and the user selects again.
- Reads, in order, after the dispatcher:
  1. An unborn HEAD gives `unborn`. A detached HEAD gives `detached` (reviewer default, 004 FR-028 precedent). Git allows both.
  2. `indexState` unmerged gives `CONFLICTED`.
  3. Commit (`detachCommit`).
  4. Parents: `rev-list --parents -n 1 <oid> --`. Grafts, replace refs, and the shallow boundary apply, as in the sequencer. The output is `<oid> <p1> ... LF`. More than 64 parents gives `limit`.
  5. Mainline: a merge (2 or more parents) with `mainline: null` gives `mainline-needed` `{ parents }`. One or no parent with a mainline gives `not-merge`. A mainline above the parent count gives `INVALID_REQUEST`.
  6. Cherry-pick only: `merge-base --is-ancestor <oid> HEAD`. 0 gives `already-on-branch`. 1 passes. Another exit gives `GIT_FAILED`.
  7. Clean tree: `trackedChanges()` (`merge-rebase.ts:122-128`) true gives `dirty-tree`. The Git docs state "This requires your working tree to be clean". P10 shows that Git allows some dirty cases, so the doc rule is the exact contract.
- Plan: `{ commit, parents, mainline, branch }`. Bound: the plan and `clean: true`.
- Steps: cherry-pick `[L, "cherry-pick", ...(mainline ? ["-m", String(n)] : []), oid]`. Revert `[L, "revert", "--no-edit", ...(mainline ? ["-m", String(n)] : []), oid]`. No `--`, because Git would read later items as paths, and a full object ID is unambiguous. No `-x`, `-s`, `-n`, `--no-gpg-sign`, `--allow-empty`, or `--empty`.
- Message: Git's own. This feature does not edit it. The popover names Amend last commit (004 FR-099) for a change.
- Hooks and signing: each P2 event is in `WORKBENCH_EVENTS` (`trust.ts:677-689`). `gpg.program` counts for the class `workbench` (`trust.ts:408-409`).
- Outcome from `observe` and `trackedChanges`. The first row that matches decides.
  - `intended-effects-confirmed`: exit 0, state normal, and HEAD on the same branch. One new commit has the parents `[old HEAD]` (`parentsOf`, `sync-integrate.ts:87`). Only the branch ref moved, and no tracked changes exist. Text `PICK_DONE` or `REVERT_DONE`.
  - State `cherry-picking` or `reverting` with unmerged > 0: `failed-with-effects` with `{ operationState, unmerged }`. Text `PICK_STOPPED_CONFLICTS` or `REVERT_STOPPED_CONFLICTS`.
  - The same state with unmerged 0 (P6 empty pick, P11 signing failure, a failed hook): `failed-with-effects` with the output tail. Text `PICK_STOPPED` or `REVERT_STOPPED`.
  - Any other fact set with a change: `failed-with-effects` with the changed facts.
  - Exit not 0, no marker, and nothing changed (P7, P10): `no-effects`, `failed`, `GIT_FAILED` with the output tail.

### D6 Finish a stopped cherry-pick or revert

This section extends 003 FR-030 and 004 FR-102. Today these states show `FINISH_OUTSIDE` (`NoticeBand.tsx:24-25`). An action that the app starts must end in the app.

- Notices band: add `cherry-picking` and `reverting` to `ACTIONS_IN_APP` (`NoticeBand.tsx:25`). Show `ConflictRow` for them (`Workbench.tsx:2401`).
- `ConflictRow` (`ConflictActions.tsx:23`, `:62-169`): widen `Kind`. Labels `ABORT_PICK` and `ABORT_REVERT`. Continue stays as today. The row keeps the 004 FR-102 rule. Resolve conflicts shows while files are unmerged. Continue shows after the last Mark resolved. Abort shows always. Skip stays hidden (`:71` hides it unless rebasing).
- `ConflictConfirm` (`:183-223`): kind texts for cherry-pick and revert, titles and body of D11 "Band". No merge sentence. The danger button is `ABORT_PICK_BUTTON` or `ABORT_REVERT_BUTTON`. Today the button text is built as `Abort ${kind}` (`ConflictActions.tsx:214`).
- Service, sync path (class `sync`; `SYNC_EVENTS` hold the pre-commit and commit-msg events that Continue runs, P1 and P2c; `trust.ts:673-675`):
  - `IntegrationKind` and `kind()` (`sync-commands.ts:31-37`): `cherry-picking` maps to `cherry-pick`, and `reverting` maps to `revert`.
  - `abortArgs` stays `[L, kind, "--abort"]`. `continueArgs`: merge `commit --quiet`, rebase `rebase --continue`, cherry-pick `cherry-pick --continue`, revert `revert --continue`. With a stdin that is not a TTY, Git then runs `commit --no-edit --cleanup=strip` (P1).
  - `observeConflictAction` (`sync-review.ts:330-356`): accept the two states. Skip gives `not-rebasing` (existing reason). A `sequencer` marker gives the new reason `sequence` for Abort and Continue. Another tool started a multi-commit sequence then, and its Abort moves HEAD back, which the confirmation does not state. Read the marker from the status reader marker facts (`status.ts:481-507`), which are WSL-aware through `wslIdentityPath`. Do not use `gitPathExists` (`sync-review.ts:253-262`), which stats the path without the WSL mapping (research R5 U1).
  - Continue: unmerged > 0 gives `CONFLICTED` (existing). `diff-index --cached --quiet HEAD --` exit 0 gives the new reason `nothing-to-commit` (git-commit(1) `--allow-empty` rule; P6, P13).
  - `operationStateOf` (`sync-review.ts:513`) and `SyncPlan.operationState` (`envelope.ts:1314`): widen to the two states, so the Abort confirmation names its kind.
  - `integrationOf` (`sync-integrate.ts:164-169`): `stopped` also for the two states.
  - Phases: `StepPhase` (`sync-integrate.ts:24`) has no phase for these kinds. `runConflictAction` picks `sync-merge` or `sync-rebase` for Abort (`:334`). Add `sync-cherry-pick` and `sync-revert` to `StepPhase` and to the sync phases with `SYNC_COUNTERS` (`operations.ts:172`, `:207`). Abort uses them. Continue keeps `sync-continue`. Widen the kind cast at `:328`.
  - Outcome: the 003 rule of `runConflictAction` (`sync-integrate.ts:347-351`) applies unchanged. Data-model §5 states it.
  - The resolve view gets no theirs name during `cherry-picking` (`resolve.ts:101-104` gives none). This stays out of scope.
- Frontend states:
  - `operationBlock` (`HunkControls.tsx:50-51`): `operation` also for the two states. The reason is then the quiet `operation` text, and Mark resolved stays (`FileControls.tsx:76`).
  - `amendReason` (`CommitTray.tsx:108-111`): block Amend for the two states too.
  - `useSync` trust action (`useSync.ts:124`): Abort and Continue ask with `cherry-pick` during `cherry-picking`, with `revert` during `reverting`, else with `pull` (`ask.ts:23-33`).
- The conflict row shows `NOTHING_PICK`, `NOTHING_REVERT`, or `SEQUENCE` in place of its "is unavailable" code line for these reasons (`ConflictActions.tsx:150`).
- `sequencer-active` (no `CHERRY_PICK_HEAD` or `REVERT_HEAD`) stays outside-only (001 behavior). The app starts no sequence.

### D7 Trust and shell

- `TRUST_ACTIONS` gains `reset`, `tag`, `cherry-pick`, and `revert` (`channel.ts:970`).
- Rust `dialogs.rs` `action_sentence` (`:438-456`) gains the four `TRUST_*` sentences of D11.
- `close.rs` `Mutation` variants (`:186-266`) gain the four `CLOSE_*` names of D11.
- `schema.rs` progress phases (`:380-415`) and the started-action test list (`:2258-2275`) gain the four actions. The progress phases also gain `sync-cherry-pick` and `sync-revert` (D6).
- The shell checks the policy fit by the started kind (004 contract `:222`). No argument allowlist applies to `registeredOperation` runs. The allowlists in `bootstrap.rs:497-527` cover only probe and discovery contexts.

### D8 WSL parity (feature 006)

- The same argument arrays run through the 006 route. Steps run under policy `integrate`, and the wrapper mode `integrate` exports `GIT_EDITOR=:` (003 contract `:261`). No new wrapper mode.
- `runWorkbench` waits for the process-end fact before any read (`workbench-review.ts:382-387`, 001 contract §11).
- The Hard in-the-way check uses the `requestFacts` path of the 004 Discard check, which has a WSL test (`tests/wsl/workbench-wsl-branches.test.ts:58`).
- Hooks and signing run in the distro under the same trust classes.
- New test file `tests/wsl/commit-actions-wsl.test.ts` on `tests/wsl/workbench-wsl-harness.ts`. Distro `Ubuntu-26.04` (Git 2.55, the WSL minimum). The file runs alone. Cases:
  - Each reset mode equals Git in the distro on a copy.
  - Hard refuses a Linux untracked file in the way.
  - Lightweight and annotated tags.
  - Cherry-pick clean, a conflict with Mark resolved and Continue, and Abort.
  - Revert clean, and a merge with `-m 1`.
  - Detached checkout.
  - Abort and Continue with a `.git/sequencer` folder refuse with `sequence`.
  - The mode bits, owner, and link count of each written file stay (008 SC-008 style).

### D9 Budgets (constitution VII)

The user approved these budgets on 2026-11-04, before any measured run. The runs use the packaged build, warm, on the agreed hardware. The warm-up run counts for the every-run bound, never for the median (001 spec.md:95).

| SC | Measure | Fixture | Samples | Budget |
|---|---|---|---|---|
| SC-010a | Input to menu paint (right-click and Shift+F10) | L (100,000 commits, 256 refs), History open | 40 per run (20 + 20, distinct rows) | p95 at most 100 ms; every open at most 500 ms (001 SC-005) |
| SC-010b | Item activation to the popover with plan or refusal | M (5,000 commits, 10,000 files) | 10 warm + 1 warm-up per action | median at most 300 ms; every run at most 500 ms |
| SC-010c | Hard review with the in-the-way check, target 100 commits back, about 1,000 changed paths | M-R (new, from M) | 10 + 1 | median at most 1 s; every run at most 2 s |
| SC-010d | Run button to outcome text | M and M-R | 10 + 1 per action | Medians: Soft 1 s, Mixed 2 s, Hard (M-R) 4 s, Create tag 1 s. Cherry-pick and Revert of a 10-file commit: 2 s. Abort and Continue: 2 s. Detached checkout (M-R): 4 s. Every run: at most 2 times its budget. |
| SC-011 | Input response while each run goes (typing in the history filter) | M | at least 20 inputs per run | 001 SC-005 targets |
| record | CPU seconds and process-tree private bytes per run | M | the same runs | recorded, no budget |
| record | WSL times of SC-010b and SC-010d | Ubuntu-26.04 | 10 + 1 | recorded, no budget |
| cold | Cold time of each SC-010 measure: the first run after a new app start | L, M, M-R | 1 per measure | 2 times its warm budget, set before any run (user decision, 2026-11-04). The warm budget is the median budget of the measure, and the p95 budget for SC-010a (decision 2026-11-05). |

- Fixture M-R is new in `tests/windows/perf-fixtures.ts`. It derives from M and puts the reset target 100 commits back with about 1,000 changed paths.
- Fixtures L and M come from 001 `plan.md:1134-1135` (research R5 U3).

### D10 Mockup first (arbareto-ux skill §4)

- Boards: Menu, Menu-unavailable, Reset (3 modes), Hard-confirm, and Tag (both kinds and a refusal). More boards: Cherry-pick (plain and merge parents), Revert, Band-cherry-pick, Checkout-confirm, and Forced-colors.
- The mockup is static HTML in local scratch, with sample data marked as sample. It picks the icons from the free hugeicons set. `GitBranchIcon`, `PlusSignIcon`, `Tag01Icon`, `Undo03Icon`, and `Copy01Icon` are in use already.
- The user approves the boards before any code task (T003 onward) starts. A changed text goes into D11 first.

### D11 Texts

`src/frontend/history/commit-texts.ts` holds the new texts. The band texts go into the sync texts of `ConflictActions.tsx`, and the trust and close texts go into Rust. Every visible text of this feature is in this section once. The mockup confirms the layout. Texts marked "new in spec" did not exist in the design plan.

Menu:

| Key | Text |
|---|---|
| `MENU_NAME` | "Actions for commit <short ID>" |
| `ITEM_CHECKOUT` (group 1) | "Check out this commit (detached HEAD)…" |
| `ITEM_BRANCH` (group 1, Ctrl+B) | "Create branch here…" |
| `ITEM_TAG` (group 1) | "Create tag here…" |
| `ITEM_PICK` (group 2) | "Cherry-pick commit…" |
| `ITEM_REVERT` (group 2) | "Revert commit…" |
| `ITEM_RESET` (group 3) | "Reset current branch (<branch>) to here…" |
| `ITEM_RESET_NO_BRANCH` (group 3) | "Reset current branch to here…" |
| `ITEM_COPY` (group 4) | "Copy commit ID" |
| `AT_COMMIT` | "HEAD is at this commit." |
| `BLOCKED_TEXT.operation` (changed) | "A merge, a rebase, a cherry-pick, or a revert is in progress. Finish it with Mark resolved and the actions in the Notices band." |
| `COMMIT_ANNOUNCE` | "Commit <short ID>." |

Check out:

| Key | Text |
|---|---|
| `CHECKOUT_TITLE` | "Check out commit <short ID>?" |
| `T.detachNote` (existing) | "No branch. New commits belong to no branch (detached HEAD)." |
| `CHECKOUT_BUTTON` | "Check out" |
| `CHECKOUT_DISCARD_BUTTON` | "Discard and check out" |
| `OUTCOME.detached` | "Checked out <short ID>. HEAD is detached." |

Create tag:

| Key | Text |
|---|---|
| `TAG_TITLE` | "Create tag at <short ID>" |
| `TAG_NAME` | "Tag name" |
| `TAG_LIGHT` | "Lightweight tag" |
| `TAG_LIGHT_HINT` | "A name for this commit. Git stores no message." |
| `TAG_ANNOTATED` | "Annotated tag" |
| `TAG_KIND` (radio group legend) | "Tag kind" |
| `TAG_ANNOTATED_HINT` | "Git stores a tag object with your name, the date, and a message." |
| `TAG_MESSAGE` | "Message" |
| `TAG_MESSAGE_NEEDED` (new in spec) | "Type a message for an annotated tag." |
| `TAG_SIGNS` | "Git signs this tag. Your Git configuration asks for it." |
| `TAG_BUTTON` | "Create tag" |
| `TAG_REASON.invalid-name` | "Git does not accept this tag name." |
| `TAG_REASON.reserved-name` | "Git reads HEAD and @ as names of the current commit. Use another tag name." |
| `TAG_REASON.name-exists` | "The tag <name> exists. Use another name." |
| `TAG_REASON.tag-signing` | "Your Git configuration signs every tag, and a signed tag needs a message. Select Annotated tag." |
| `TAG_REASON.message-size` | "The message is too long. Use at most 8 KiB." |
| `TAG_REASON.invalid-config` | "A tag setting in your Git configuration is not valid, so Git stops." |
| `TAG_DONE` | "Created tag <name> at <short ID>. Arbareto does not push tags." |

Reset:

| Key | Text |
|---|---|
| `RESET_TITLE` | "Reset <branch> to <short ID>?" |
| `RESET_LEGEND` | "Reset mode" |
| `RESET_SOFT` | "Soft" |
| `RESET_SOFT_HINT` | "Git keeps the index and the working files. The differences show as staged changes." |
| `RESET_MIXED` | "Mixed" |
| `RESET_MIXED_HINT` | "Git keeps the working files and resets the index. All changes show as unstaged changes." |
| `RESET_HARD` (danger) | "Hard" |
| `RESET_HARD_HINT` | "Git resets the index and the working files. Git deletes all changes to tracked files." |
| `RESET_LEAVE` | "<n> commits leave <branch>." |
| `RESET_GAIN` | "<branch> gets <m> commits." |
| `RESET_REFLOG` | "<k> of these commits are on no other branch or tag. Only Git's reflog keeps them for a limited time." |
| `RESET_FORCE` | "The reset removes commits that <tracking> holds, so the next push needs Force push with lease." |
| `RESET_TRACKED` | "You have <c> changes to tracked files." |
| `RESET_BUTTON` | "Reset" |
| `RESET_HARD_BUTTON` | "Reset hard…" |
| `IN_THE_WAY_LEAD` (before the path list) | "These untracked paths are in the way of Hard reset:" |
| `IN_THE_WAY_TAIL` (after the list; every path shows) | "Move or delete them first." |
| `IN_THE_WAY_TAIL_MORE` (after the list; `more` > 1) | "<n> more paths do not show. Move or delete them first." |
| `IN_THE_WAY_TAIL_MORE.one` (after the list; `more` = 1) | "1 more path does not show. Move or delete them first." |
| `HARD_TITLE` | "Reset <branch> hard to <short ID>?" |
| `HARD_BODY` | "Git deletes <c> changes to tracked files, also staged new files. Untracked files stay." |
| `HARD_BODY_CLEAN` (c = 0) | "Git sets the index and the working files to <short ID>." |
| `HARD_IGNORED` | "Git replaces <g> ignored files with the files of <short ID>." |
| `NO_UNDO` (existing 008) | "You cannot undo this." |
| `HARD_CANCEL` | "Cancel" |
| `HARD_CONFIRM` | "Reset hard" |
| `RESET_DONE` (every mode) | "Reset <branch> to <short ID>." |

The Hard dialog repeats `RESET_REFLOG` as a notice when `reflogOnly > 0`.

Singular forms. A count of 1 uses these texts, as `files(n)` in `NoticeBand.tsx:27` does. Other counts use the texts above, formatted with `toLocaleString("en-US")`.

| Key | Text for a count of 1 |
|---|---|
| `RESET_LEAVE.one` | "1 commit leaves <branch>." |
| `RESET_GAIN.one` | "<branch> gets 1 commit." |
| `RESET_REFLOG.one` | "1 of these commits is on no other branch or tag. Only Git's reflog keeps it for a limited time." |
| `RESET_TRACKED.one` | "You have 1 change to tracked files." |
| `HARD_BODY.one` | "Git deletes 1 change to tracked files, also staged new files. Untracked files stay." |
| `HARD_IGNORED.one` | "Git replaces 1 ignored file with the file of <short ID>." |

Cherry-pick and Revert:

| Key | Text |
|---|---|
| `PICK_TITLE` | "Cherry-pick <short ID> to <branch>?" |
| `PICK_BODY` | "Git applies the changes of this commit to <branch> as a new commit. Git copies its message and its author. To change the message, use Amend last commit." |
| `PICK_PARENT_LEGEND` | "This is a merge commit. Select the parent that Git compares it with." |
| `PARENT_OPTION` | "Parent <i>: <short ID> <subject>" |
| `PICK_BUTTON` | "Cherry-pick" |
| `PICK_REASON.already-on-branch` | "<branch> already has this commit." |
| `PICK_REASON.dirty-tree` | "Commit or stash your changes first. Git cherry-picks only onto a clean working tree." |
| `NOT_MERGE` (Cherry-pick and Revert) | "This commit is no merge commit." |
| `PICK_DONE` (new in spec) | "Cherry-picked <short ID> to <branch>." |
| `PICK_STOPPED_CONFLICTS` | "The cherry-pick stopped with <n> conflicted files. Resolve them, then select Continue in the Notices band." |
| `PICK_STOPPED_CONFLICTS.one` | "The cherry-pick stopped with 1 conflicted file. Resolve it, then select Continue in the Notices band." |
| `PICK_STOPPED` | "The cherry-pick stopped. Read the Git output, then select Continue or Abort in the Notices band." |
| `REVERT_TITLE` | "Revert <short ID> on <branch>?" |
| `REVERT_BODY` | "Git creates a new commit on <branch> that undoes the changes of this commit. Git writes the commit message. To change it, use Amend last commit." |
| `REVERT_PARENT_LEGEND` | "This is a merge commit. Select the parent to keep." |
| `REVERT_BUTTON` | "Revert" |
| `REVERT_REASON.dirty-tree` | "Commit or stash your changes first. Git reverts only on a clean working tree." |
| `REVERT_DONE` (new in spec) | "Reverted <short ID> on <branch>." |
| `REVERT_STOPPED_CONFLICTS` (new in spec) | "The revert stopped with <n> conflicted files. Resolve them, then select Continue in the Notices band." |
| `REVERT_STOPPED_CONFLICTS.one` (new in spec) | "The revert stopped with 1 conflicted file. Resolve it, then select Continue in the Notices band." |
| `REVERT_STOPPED` (new in spec) | "The revert stopped. Read the Git output, then select Continue or Abort in the Notices band." |

These codes and reasons reuse existing texts. They get no new text:
- `detached` and `unborn`: `TEXTS.detached` and `TEXTS.unborn` (`integrate/texts.ts:64-65`).
- `CONFLICTED` of a workbench review: `TEXTS.conflicted(n)` (`integrate/texts.ts:68`), as `refusalText` does (`branches/texts.ts:116`).
- `CONFLICTED` of a sync Continue review: the same `TEXTS.conflicted(n)`. Resolve conflicts replaces Continue while files are unmerged, so only a race gives this refusal.
- `UNKNOWN_TARGET`, `INVALID_REQUEST`, `limit`, and `GIT_FAILED`: the 004 fallback of `refusalText` with the code and the reason (`branches/texts.ts:120`).
- `mainline-needed`: no text. The popover shows the parent choice from the refusal `{ parents }`, with parent 1 preselected.
- `STALE_REVIEW`: the existing 004 stale text.

Band:

| Key | Text |
|---|---|
| `ABORT_PICK` | "Abort cherry-pick…" |
| `ABORT_REVERT` | "Abort revert…" |
| `ABORT_PICK_TITLE` | "Abort the cherry-pick?" |
| `ABORT_REVERT_TITLE` | "Abort the revert?" |
| `ABORT_PICK_BUTTON` | "Abort cherry-pick" |
| `ABORT_REVERT_BUTTON` | "Abort revert" |
| `ABORT_PICK_BODY` | "Git returns the branch, the index, and the working files to their state before the cherry-pick." |
| `ABORT_REVERT_BODY` (new in spec) | "Git returns the branch, the index, and the working files to their state before the revert." |
| `NOTHING_PICK` | "The cherry-pick makes no change. Select Abort to end it." |
| `NOTHING_REVERT` | "The revert makes no change. Select Abort to end it." |
| `SEQUENCE` | "A cherry-pick or revert sequence is in progress. Finish it in a terminal." |

Expiry:

| Key | Text |
|---|---|
| `EXPIRED` | "The review expired. Arbareto changed nothing. Select <action> again." |

`<action>` is the close-prompt name of the action (`CLOSE_*` below). Abort and Continue keep their 003 expiry texts.

Status bar (the 004 `RUN_TEXTS` form, `BranchActions.tsx:80-85`). The status bar shows "<running text> in <folder>…" while a run is in progress:

| Key | Text |
|---|---|
| `RUNNING_RESET` | "Resetting" |
| `RUNNING_TAG` | "Creating tag" |
| `RUNNING_PICK` | "Cherry-picking" |
| `RUNNING_REVERT` | "Reverting" |
| `RUN_HEADING` (area heading) | "<action> details" |

`<action>` is the close-prompt name of the action (`CLOSE_*` below).

Review in progress: the Reset, Cherry-pick, and Revert popovers reuse the 004 `SwitchConfirm` pending text "Loading…" (`BranchActions.tsx:559`) while their review runs. The confirm button stays unavailable.

Trust sentences and close-prompt names (Rust, D7):

| Key | Text |
|---|---|
| `TRUST_RESET` | "Git runs them when you reset a branch." |
| `TRUST_TAG` | "Git runs them when you create a tag." |
| `TRUST_PICK` | "Git runs them when you cherry-pick a commit." |
| `TRUST_REVERT` | "Git runs them when you revert a commit." |
| `CLOSE_RESET` | the text of `RESET_BUTTON` |
| `CLOSE_TAG` | the text of `TAG_BUTTON` |
| `CLOSE_PICK` | the text of `PICK_BUTTON` |
| `CLOSE_REVERT` | "Revert commit" |

### D12 Earlier spec lines and docs

WP8 (T020) amends the earlier specs in the style "Note (2026-11-04, user decision): …". T020 starts only after the branches `main-tree-marks-perf` and `main-tree-render-perf` merge, because both change 004 `plan.md` and `tasks.md`.

- 001 `spec.md:316` and the FR-016 delta (`:407`). Text: "Feature 010 adds Abort and Continue for a cherry-pick or a revert in progress (010 FR-060)."
- 001 FR-027 (`spec.md:424`): after the 008 amendment, add "Amended by feature 010 (2026-11-04, user decision): …". It allows Reset current branch to here (010 FR-040 to FR-046), Cherry-pick commit and Revert commit (FR-050 to FR-053), and Abort and Continue of a stopped cherry-pick or revert (FR-060 to FR-063). Each action runs only after its review and its confirmation.
- 003 `spec.md:226`: reset, cherry-pick, and revert come with feature 010 from the History commit menu. Push of tags stays excluded. 003 FR-030 (`:291`): Abort and Continue also for a cherry-pick or a revert in progress. Skip only for a rebase.
- 004 `spec.md:349`: reset, cherry-pick, revert, and tags come with feature 010. 004 FR-014 (`spec.md:407`) and plan D15 "History labels" (`plan.md:382`) get one change. Shift+F10 and the Menu key open the commit menu while no label is active (010 FR-010, FR-015).
- 007 `spec.md:19` and FR-006 (`:159`): feature 010 is a v0.1.0 blocker. `plan.md:189`, `:241`, `:261`: add 010 next to 005, 006, and 008. The 007 files are not on `main` at `f0d79499`. They exist on the branch `007-first-release`. T020 amends them where 007 lives at that time.
- 008 `spec.md:192`: "Revert all changes, which would be Git's `reset --hard`", Git's commit revert, and branch reset come with feature 010. 008 FR-006 (`spec.md:228`): `ITEM_REVERT` of feature 010 is no 008 revert action. `spec.md:358` stays valid.
- 004 FR-103 (`spec.md:441`) and SC-017 (`:584`): the History Working directory row and its dock also name the conflicted count during a cherry-pick and a revert. The dock also offers Resolve conflicts then (approved Stopped board, 2026-11-05).
- README "Features" and the CHANGELOG 0.1.0 section get the user-visible changes only.

In-flight branches (2026-11-04):
- `main-tree-marks-perf`: `src/git-service/submodule-review.ts`, `tests/git/submodule-review.test.ts`, and 004 `plan.md`, `tasks.md`, `research.md`, `contracts/operations.md`.
- `main-tree-render-perf`: 004 `plan.md` and `tasks.md`, `tests/contracts/workbench-submodules.test.tsx`, and `tests/windows/submodule-tree-packaged.test.ts`.
- Neither branch overlaps the code of this plan. Both overlap 004 `plan.md` (D15) and `tasks.md`. 004 `spec.md` has no overlap.

### D13 Frontend and service modules

- Menu: `HistoryList.tsx` gets `onCommitMenu?(oid, anchor, byKey)`. A row `onContextMenu` exists only on commit rows (`commitRow`, `:511-587`). The Shift+F10 branch of `onKeyDown` (`:414-422`) opens the commit menu when `activeLabel === null`. `labelAt` allows "no label" after Left on the first label. A right-click passes the pointer x. `CommitMenu` anchors `ActionMenu` with `side="bottom"` below the row, at the pointer x or at the row start for a key. It sets `width={320}` when any item has a reason (D1 "Geometry").
- Popover: `ConfirmPopover` (`confirm-popover.tsx`) caps its height at `--available-height` and scrolls its body. Its width is at most the window width minus 32 px.
- Focus: `CommitActions.tsx` focuses Tag name after a refusal of the named tag review. `ConflictActions.tsx` focuses Continue when the last conflict resolves and the focus fell to the page (D1 "Focus").
- Actions hook: new `src/frontend/history/CommitActions.tsx` (`useCommitActions`), modeled on `useBranchActions`. It holds the menu state, the groups, and the reasons. It holds the Reset, Tag, Cherry-pick, and Revert popovers (`ConfirmPopover`) and the Hard dialog. It runs actions through `trackOperation`, shows the outcome texts, and sends `workbench.ended`.
- Hard dialog: extract the body of `RevertConfirm` (`RevertConfirm.tsx:36-79`) into an exported `AlertConfirm({ title, body, paths, more, notices, button, onConfirm, onCancel, finalFocus })`. `RevertConfirm` calls it. No 008 behavior changes.
- Service module: new `src/git-service/commit-actions.ts` registers `reset`, `create-tag`, `cherry-pick`, and `revert-commit` through `registerWorkbenchAction` (`workbench-review.ts:117`). Import it in `session.ts:55-59`. The argument builders go into `workbench-commands.ts`. `switch.ts` exports `detachCommit`, `trackedStatus`, and the generalized `inTheWayCheck`. `merge-rebase.ts` exports `trackedChanges` and `forceNoteOf`.
- `status.ts` exposes the marker facts of `status.ts:481-507` on the reader, for the `sequence` refusal of D6.
- The dispatcher (`workbench-review.ts`) already gives these parts:
  - The trust gate per class (`:287-295`).
  - HEAD capture and markers (`:296-301`).
  - `OPERATION_IN_PROGRESS` and `unknown-operation` for every non-normal state (`:303-304`).
  - The 60 s token (`:276`, `limits.ts:68`).
  - The second observation at run and `STALE_REVIEW` (`:312-326`, `:399-401`).
  - The `before` observation (`:409`).
  - Steps under policy `integrate` with `PROCESS_LIMITS.network` and the 15 s stall notice (`:355-378`).
  - The stderr tail bound `DIAGNOSTIC_RETAINED_BYTES_PER_STREAM` 64 KiB (`:363-364`, `limits.ts:55`).
  - The WSL process-end wait (`:382-387`), and `conclude` (`:190-199`).

### D14 Tests and fixtures

- Oracles: Git's own `reset --<mode>`, `tag`, `cherry-pick`, `revert`, `checkout --detach`, `--abort`, and `--continue` on a copy of the fixture. Tests compare HEAD, `for-each-ref`, `ls-files --stage -z`, and working bytes by SHA-256.
- A test that asserts a refusal asserts its code and reason, never a message text (spec SC-012).
- Every Git test uses an owned `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM=1`. Signing fixtures set a failing `gpg.program` in the owned configuration, as probe P8 does.
- Hook fixtures write one log line per event, as the probe scripts do. A test asserts the event set after approval and an empty log before it.
- Each new file in `tests/contracts`, `tests/git`, or `tests/wsl` adds its line to `tests/groups.json` in the same task.

### Invariants

1. A registered workbench action refuses every non-normal operation state before its own reads, unless `IN_PROGRESS_ALLOWED` lists it (`workbench-review.ts:121-123`, `:303-304`). The four new actions are not listed.
2. A token lives 60 s and is single use. The run observes again from its own trust listing (`workbench-review.ts:270-278`, `:398-406`; `limits.ts:68`).
3. `observe` lists all refs (`for-each-ref` without a pattern, `sync-commands.ts:71-73`). It also lists HEAD, the index, the markers, and `index.lock` after a killed step (`sync-integrate.ts:74-84`).
4. Workbench steps run under policy `integrate` with network limits and the stall notice (`workbench-review.ts:355-378`). The shell checks the policy fit by started kind (004 contract `:222`).
5. The class `workbench` covers every hook event that P2, P3, P3b, and P3c observed (`trust.ts:677-689`), and signing programs (`trust.ts:408-409`). The class `sync` covers the pre-commit and commit-msg events of Continue (`trust.ts:673-675`).
6. A single cherry-pick or revert leaves `CHERRY_PICK_HEAD` or `REVERT_HEAD` and no `.git/sequencer` (P1, P2c). `stateOf` maps them to `cherry-picking` and `reverting` (`status.ts:273-282`).
7. Mark resolved works in every non-normal state. The service skips the state refusal for `resolve` (`file-publish.ts:258-261`), and the control ignores the `conflicted` and `operation` blocks (`FileControls.tsx:76`). Choose ours, Choose theirs, and the merge tool are in `IN_PROGRESS_ALLOWED` (`workbench-review.ts:123`).
8. The in-the-way logic treats a path as untracked only without a stage-0 index entry (`switch-check.ts:69-79`). It treats ignored files as replaceable (`switch-check.ts:88-99`).
9. A `runWorkbench` outcome refreshes History and the branch list (`state/workbench.ts:99-104`).
10. Git documents exit codes only for the reads that decide here: check-ref-format, show-ref `--exists`, merge-base `--is-ancestor`, and diff-index `--quiet`. Reset, cherry-pick, revert, tag, and checkout outcomes come from fresh reads.

## Risks

- R1 Time-of-check window of the Hard in-the-way check. A file can appear after the run observation and before the Git step. The 004 Discard has the same window. The run observation repeats the check (`workbench-review.ts:399`), so the window is short.
- R2 A missing blob in a partial clone (`--no-lazy-fetch`): Git can write some files before it fails. The outcome is then `failed-with-effects` with the changed facts, as for the 004 switch.
- R3 The amended label key rule changes behavior that tests codify (`workbench-branches.test.tsx:465-491`, `:524-557`). T012 updates them, and T020 amends 004.
- R4 Abort of a sequence that another tool started would move HEAD back. The `sequence` refusal prevents it.
- R5 Signing through a GUI pinentry can wait for the user. The step has the 15 s stall notice and Cancel (`workbench-review.ts:365`).
- R6 The Rust typify build fails while a schema and `close.rs` disagree. T005 runs after T004.
- R7 A reset to a commit outside the branch history moves many commits. The counts and the force note show it before the run.

## Open items and reviewer defaults

- The user answered Q1 to Q4 of the design plan on 2026-11-04 (spec Clarifications). For Q1, the user chose this option. "The popover still lets you type a message, which makes it annotated." D3 follows it.
- Mockup decisions (user approval of 2026-11-04, orchestrator defaults):
  - The stopped band keeps the 004 FR-102 rule (D6).
  - The Check out confirmation keeps Cancel as the first focus (D2).
  - The Create tag popover reviews when it opens and again on Create tag (D3).
  - A switch back to `TAG_LIGHT` clears the Message field (D3).
  - The in-the-way refusal splits into a lead, the path list, and a tail (D11).
  - An empty tag name keeps Create tag unavailable, with no text (D3).
- The reviewer defaults of spec Assumptions stand. They are the detached and unborn refusals, the clean-tree rule, and the checkout confirmation. Git's messages and no Skip also stand.
- The user approved the texts marked "new in spec" in D11 with the mockup.

## Phases

### Batches

| Batch | Work packages | Content |
| --- | --- | --- |
| 0 | WP-S, then WP1 | These artifacts and the probe rerun (T001), then the mockup for user approval (T002). |
| 1 | WP2, then WP3 and WP4 | The contracts, then the Rust shell (local) and the service actions. WP4 starts after WP2. |
| 2 | WP5 (beside WP4 in its own worktree) | The menu, the popovers, the Hard dialog, and the band row. |
| 3 | WP6 alone, WP7, then WP7r | The WSL tests, the packaged and perf tests, then the packaged runs. |
| 4 | WP8 | The amendments, README, and CHANGELOG, after the merges of `main-tree-marks-perf` and `main-tree-render-perf`. |

Each batch ends with its verification, one independent review (`reviewer`), and `/speckit-converge`. A WSL run runs alone on the host.

### Work packages, in run order

| WP | Agent | Scope (files) | Depends on |
|---|---|---|---|
| WP-S | implementer | `specs/010-commit-menu/*` and T001; then `/speckit-analyze` | none |
| WP1 | frontend-implementer | T002 mockup in local scratch (no repo files) | WP-S; the user's approval ends it |
| WP2 | implementer-xhigh | T003, T004: `src/contracts/{channel,envelope,errors,operations,tag-name}.ts`, `src/contracts/schemas/*.json`, `tests/contracts/commit-actions-contract.test.ts`, `tests/contracts/tag-name.test.ts`, `tests/vectors/**` | WP1 approval |
| WP3 | implementer-xhigh (`Local: Rust`) | T005: `src-tauri/src/{close,dialogs,schema}.rs` | WP2 |
| WP4 | implementer-xhigh | T006 to T011: `src/git-service/{commit-actions,workbench-commands,switch,merge-rebase,sync-commands,sync-review,sync-integrate,status,session}.ts`, `tests/contracts/workbench-commands.test.ts`, `tests/git/{reset,create-tag,cherry-pick-revert,sync-conflicts}.test.ts`, `tests/git/workbench-fixtures.ts` | WP2 |
| WP5 | frontend-implementer | T012 to T015: the frontend files of Project Structure, `tests/contracts/{commit-menu,commit-actions,sync-conflicts,workbench-branches}.test.tsx` | WP1, WP2 (WP4 can run beside it in its own worktree) |
| WP6 | implementer-xhigh (`Local: WSL`, alone) | T016: `tests/wsl/commit-actions-wsl.test.ts`, `tests/wsl/workbench-wsl-harness.ts` | WP4 |
| WP7 | implementer (`Local: package`) | T017, T018: `tests/windows/commit-menu-packaged.test.ts`, `tests/windows/commit-menu-perf.test.ts`, `tests/windows/perf-fixtures.ts` | WP3, WP4, WP5 |
| WP7r | scout (`Local: package`) | T019 packaged and perf runs, alone, in the foreground | WP7 |
| WP8 | implementer | T020: the files of D12 | `main-tree-marks-perf` and `main-tree-render-perf` merged |

## Agent context

No agent context file changes. The `CLAUDE.md` files stay as they are.

## Complexity Tracking

No violation.
