# Quickstart: Validate History Inspection and Commit View File Actions

**Feature**: `specs/005-inspection-file-actions` | **Plan**: [plan.md](plan.md) | **Contract**: [contracts/operations.md](contracts/operations.md) | **Data model**: [data-model.md](data-model.md)

This guide lists the validation scenarios. It holds no implementation code. The work packages in plan.md create the named test files.

## Prerequisites

- Windows 11 x64 with the 001 qualification prerequisites.
- Git for Windows 2.56 for the P0 facts. The 001 minimum Git 2.55.0 stays in force.
- Main at 3575a15 or later, with features 001 to 004.
- WSL `Ubuntu-26.04` with Git 2.55 for the WSL scenarios. Set `ARBARETO_WSL_DISTRO`. Run the WSL tests alone.
- For N2: a volume without a Recycle Bin (such as a removable FAT32 volume or a VHD with the Recycle Bin turned off for it). Without it, N2 skips with a recorded capability and stays unverified.
- For app runs: set `ARBARETO_PROFILE_ROOT` to a scratch folder.
- Every test uses an owned `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM=1`. No test touches the user's own configuration.
- Each Recycle Bin test purges every item that it moved, through the reply `recycledPath`. It changes no other Recycle Bin item.

## Commands

Use only the README "Development" commands:

- `bun install --frozen-lockfile`
- `bun run build`
- `bun run typecheck`
- `bun run export:schemas --check`
- `bun run test:contracts`
- `bun run test:git`
- `bun run test:windows` (after `bun run build:service`)
- `bun run test:all` (alone, never in parallel with another full run)
- `cargo check --locked --manifest-path src-tauri/Cargo.toml`
- `cargo test --locked --manifest-path src-tauri/Cargo.toml`
- `bun run dev`
- `bun run package`

## Scenarios

| # | Scenario | Test home | Expected outcome | Spec |
|---|---|---|---|---|
| Q1 | Build the 005 fixtures. | `tests/git/history-diff-fixtures.ts`, `tests/git/file-actions-fixtures.ts` | Self-check: commit trees, counts, the ignored set, the index digest. | SC-001 to SC-008 |
| Q2 | Record the Git facts F1 to F19. | `tests/git/history-diff-facts.test.ts`, `tests/git/file-actions-facts.test.ts` | Each fact passes, or research.md R17 records the failure and the contract changes before P4 or P5. | FR-001 to FR-004 |
| Q3 | Record the native facts N1 to N11 and N3b (packaged and cargo). | `tests/windows/delete-facts.test.ts`, cargo tests | The recycle result per item, the warning on a volume without a Recycle Bin, links and junctions as links in both modes, the cancel of the rest, the POSIX disposition, the held folder handle, the atomic replace, the folder reveal, names that end in a dot or a space, long paths, the Shell move beside the held handle. The cargo test removes the empty folders `a/b/c` in one request. A skip stays unverified. | FR-024 to FR-031, FR-042 |
| Q4 | Select normal, merge, root, shallow, rename, mode, binary, submodule, and type-change commits, and a commit that replaces the file `a` with the folder `a/`. | `tests/git/commit-changes.test.ts` | The list equals `git diff-tree -r -z --raw -M -l1000 <parent> <commit>` on a copy. Root: every file added, with the root text. Shallow: no file, with the shallow text. Each diff equals Git's patch for the path pair. The diff of `a` holds only `a`, not `a/x`. Each fact line shows. | US1, FR-006, FR-008 to FR-011 |
| Q5 | Select Parent 2 of a merge commit. | `tests/git/commit-changes.test.ts`, `tests/contracts/inspection-history.test.tsx` | The list and the diff equal the comparison with parent 2. The radio group names each parent by its short ID. | US1-3, FR-008 |
| Q6 | Select the 1,000-file and the 100,001-file commits (packaged). | `tests/windows/inspection-perf.test.ts` | 1,000 files: the list within 300 ms, the first diff within 150 ms more, the next file within 150 ms (median of 10). 100,001 files: exactly the first files up to the bound and the limit text; process-tree memory at most 64 MiB above the start. | SC-001, SC-002, FR-007, FR-012 |
| Q7 | Select a commit in an untrusted repository with a command-valued `core.fsmonitor`. | `tests/git/commit-changes.test.ts` | The trust text and "Trust…" show. The canary marker stays absent until approval. | FR-003 |
| Q8 | Select a commit whose blob is missing in a partial clone. | `tests/git/commit-changes.test.ts` | The 001 missing-object remedy shows. No fetch runs. | FR-011 |
| Q9 | Keyboard: Down in Changed files, Alt+Down in the diff, F6, Ctrl+F in Changed files and in the history list. | `tests/contracts/inspection-history.test.tsx`, `tests/contracts/shortcuts-005.test.ts` | Each arrow shows its diff at once, without motion. F6 reaches Changed files and the diff after the commit details. Ctrl+F focuses Filter files only inside Changed files or the diff. | FR-007, FR-013 |
| Q10 | Show the trees of mixed case, digits, punctuation, non-ASCII, and invalid UTF-8 names; branches `feature/b`, `Feature/a`, `main` as packed refs; a submodule row and a nested repository among files. | `tests/contracts/tree-order.test.ts`, `tests/contracts/inspection-tree.test.tsx` | Each tree equals the reference sort of FR-015. The flat order equals the tree leaf order. Submodule and nested-repository rows sort as folders. | US3, SC-004, FR-015 to FR-017 |
| Q11 | Show in Explorer on a nested folder, a non-ASCII folder, a folder link, and a folder deleted after the status read (packaged). | `tests/windows/inspection-packaged.test.ts` | Explorer opens the parent with the folder selected. The deleted folder gives "<path> does not exist. Select Refresh (F5)." and no window. | US4, FR-018, FR-019 |
| Q12 | Delete 3 marked untracked files; Delete permanently 1 file; Delete a changed tracked file. | `tests/git/delete.test.ts`, `tests/windows/inspection-packaged.test.ts` | The listed paths are absent. Each recycled item is in the Recycle Bin, then purged. The `.git/index` SHA-256 and every other working byte stay. The tracked file shows as deleted. | US2-1 to US2-3, SC-003, FR-024, FR-025, FR-032 |
| Q13 | Delete the folder `logs` with 4 listed files and 1 ignored file; Delete the folder `a` whose only listed file is `a/b/c/x`. | `tests/git/delete.test.ts` | `logs`: the 4 files go. The ignored file and the folder stay. The confirmation states the folder line. `a`: the file goes, then `c`, `b`, and `a` go. | US2-4, FR-022, FR-027 |
| Q14 | Change a file after the review; swap a folder on the way for a link and for a junction; delete a link to a folder outside; Delete an untracked `a.` beside a tracked `a` (N9). | `tests/git/delete.test.ts`, `tests/windows/delete-facts.test.ts` | The changed file: nothing is deleted, and the text asks for a new review. The swaps: nothing outside the reviewed paths changes. The link: only the link goes, and the target stays. `a.`: the identity check stops it, and `a` stays. | US2-5, US2-6, SC-003, FR-030, FR-031 |
| Q15 | Open the row menu of a submodule row, a conflicted row, and a nested-repository folder; a selection above 10,000 files; Delete during a merge. | `tests/contracts/inspection-delete.test.tsx`, `tests/git/delete.test.ts` | Delete is unavailable with the stated reason. The merge gives `OPERATION_IN_PROGRESS`. | US2-7, FR-020, FR-021, FR-033 |
| Q16 | Delete in a WSL repository, also with a folder swapped for a link during the walk; Delete a read-only file permanently; Delete a file that another program holds open without delete sharing; plain Delete of a path of 260 or more characters; Cancel during a Delete. | `tests/wsl/inspection-wsl.test.ts`, `tests/git/delete.test.ts`, `tests/windows/delete-facts.test.ts` | WSL: the permanent confirmation with the WSL line, and the swap changes nothing outside the reviewed paths. Read-only: the file stays, with access denied. Held file: the file stays, with `sharing-violation`. Long path: plain Delete is unavailable with the `long-path` text, and Delete permanently works. Cancel: each file states its fresh outcome, never an undo. | US2-8, FR-025, FR-029, FR-031, FR-033 |
| Q17 | Plain Delete of a file, a junction, and a folder symbolic link on a volume without a Recycle Bin, then No, then Yes (packaged, N2, N3b). | `tests/windows/delete-facts.test.ts` | Windows shows its warning. No keeps the item, and the result names it as kept. Yes deletes it, and the result names it as deleted. For the two links, each target folder and its files stay. | US2-9, FR-028, FR-031 |
| Q18 | Add to .gitignore on the folder `logs`; type `*.log`; add `!keep.log`; delete a line; match a tracked file. | `tests/git/ignore-preview.test.ts`, `tests/contracts/inspection-ignore.test.tsx` | The editor selects "/logs/". Each preview equals the change of the ignored set that Git lists after a real save on a copy. "Tracked files stay tracked." shows with the count of newly matched tracked files. | US5-1 to US5-5, SC-005, FR-034, FR-038 |
| Q19 | Preview with nested `.gitignore` files, ignored folders, an empty ignored folder, a `.gitignore` link, a `.gitignore` inside an ignored folder, a skip-worktree `.gitignore` absent on disk, gitlinks, a nested repository, and the report cases C0 to C8 and W1. | `tests/git/ignore-preview.test.ts` | The self-check passes, and every preview equals the real save. The two notices show. No fixture shows an approximate preview. | SC-005, FR-038 to FR-040 |
| Q20 | Preview above 100,000 paths, with the case-variant names `.GITIGNORE` and `.gıtignore` on a case-insensitive folder, with a failed self-check (a test double changes one RI or RT record). | `tests/git/ignore-preview.test.ts` | "Preview not available: <reason>." with the typed reason. Save stays available. | FR-039 |
| Q21 | Preview of 100,000 paths on Windows (packaged), first and later previews. | `tests/windows/inspection-perf.test.ts` | Every preview within 5 s, the first one too (median of 10 each, plan O-3). The test records the first and the later times apart. | SC-005 |
| Q22 | Cancel a preview; kill the service during a preview, then preview again (Windows and WSL). | `tests/git/ignore-preview.test.ts`, `tests/wsl/inspection-wsl.test.ts` | No shadow folder stays after Cancel. The leftover of the killed run goes at the next preview. | FR-041 |
| Q23 | Save after another program changed the file; Close with unsaved text; a CRLF file; a BOM file; an absent file; an existing line; a second row action with unsaved text; Open submodule with unsaved text; Save during a merge with conflicts; a 1 MiB text of short lines; a text with a lone surrogate. | `tests/git/ignore-editor.test.ts`, `tests/contracts/inspection-ignore.test.tsx` | Save refuses and keeps the other bytes, with the reload notice. The discard modal shows. CRLF stays CRLF, the BOM stays, an absent file saves with LF. The existing line is selected, not added. The same-file row action adds its line; Open submodule asks first. Save during the merge succeeds, and the merge state stays. The 1 MiB text fits one request. The lone surrogate gets no preview and no Save. | US5-6 to US5-10, FR-036, FR-037, FR-042, FR-044, FR-046 |
| Q24 | Open a linked, a folder, a 1 MiB plus 1 byte, a non-UTF-8, a NUL, and a mixed-ending `.gitignore`. | `tests/git/ignore-editor.test.ts` | The editor refuses each with its D15 text. | FR-036, FR-037 |
| Q25 | The ignore editor in a WSL repository: read, preview, save. | `tests/wsl/inspection-wsl.test.ts` | Equal results through the distro's Git. No `\\wsl.localhost` read. The text and lists cross only on stdin. | FR-043 |
| Q26 | Open initialized, uninitialized, and nested submodules from the Submodules group and from the Commit view; go back; open during a parent mutation; a submodule with a hook after a trusted parent. | `tests/git/submodule-open.test.ts`, `tests/contracts/inspection-submodule.test.tsx` | The window shows the submodule; the parent button names the parent; one click goes back, level by level. Uninitialized: the FR-048 text. Busy: refused, the parent stays. The trust prompt asks for the submodule. No parent program runs. | US6, SC-007, FR-047 to FR-052 |
| Q27 | Blame from the History diff and from a Commit view row, with each option, with an ignore list on and off (relative, `~/`, and missing `:(optional)` values, and an empty value after a non-empty one), with a missing ignore file, a binary file, a submodule path, a shallow boundary, a root line, and a 4 MiB plus 1 byte file. | `tests/git/blame.test.ts`, `tests/contracts/inspection-blame.test.tsx` | Every attribution equals `git blame --porcelain` with the same options. The marks, the boundary text, and each refusal show. Escape returns to the History list or to the Commit view row. | US7, SC-006, FR-053 to FR-062 |
| Q28 | Blame before this commit on lines inside, before, and after changed hunks, and on a pure insertion, also with `diff.interHunkContext=3` set. | `tests/git/blame.test.ts`, `tests/contracts/line-map.test.ts` | The new blame focuses the line of the FR-056 map. A root line gives "Git names no earlier version of this line." | US7-3, US7-10, FR-056 |
| Q29 | Blame the 10,000-line, 5,000-commit file, then Cancel (packaged). | `tests/windows/inspection-perf.test.ts` | The first progress within 500 ms without an ignore list. Cancel ends Git within 1 s, with and without an ignore list. | SC-006, FR-063 |
| Q30 | Hover and focus cut and uncut names in the sidebar, the branch list, and the branch button, in a narrow sidebar; branches with a pruned upstream, a removed remote, and no upstream. | `tests/contracts/inspection-card.test.tsx`, `tests/git/branch-gone.test.ts` | The card shows only for cut names, with the facts of Git's own reference read. Escape closes it. The gone mark shows only for the pruned upstream. | US8, US9, SC-008, FR-064 to FR-066 |
| Q31 | Keyboard-only runs of US1, US2, and US5; each key of the plan D15 map; contrast in Dark, Light, and forced colors. | `tests/contracts/shortcuts-005.test.ts`, `tests/windows/inspection-packaged.test.ts` | Each story completes by keyboard. No key acts outside its scope. Contrast at least 4.5:1. | SC-010, FR-067 |
| Q32 | Input latency during each read and action of this feature (packaged). | `tests/windows/inspection-perf.test.ts` | 95% of inputs within 100 ms, every input within 500 ms. | SC-009 |
| Q33 | The WSL rows of Q4, Q12 to Q16, Q18 to Q20, Q23, Q26, and Q27 in Ubuntu-26.04. | `tests/wsl/inspection-wsl.test.ts` | Same results through the distro's Git. No remaining process after Cancel or close. | FR-043, FR-052 |
| Q34 | Review of the requirement-to-test map. | review checklist | No outcome depends on Git message text, timing, or a name pattern. | SC-011 |

## Manual checks in the packaged build

- History: the three regions with splitters, the parent picker of a merge commit, the two tabs in the constrained window profile.
- Blame: the gutter, the age shades, the legend, the marks, and Alt+Left; no browser back navigation.
- Commit view: the "Delete from disk" group, Del and Shift+Del only in the Changes list, the confirmation with Cancel focused first.
- The Windows permanent-delete warning on a volume without a Recycle Bin, owned by the Arbareto window.
- The ignore editor: line numbers, the selected new line, "Updating preview…", the discard modal, and Ctrl+S.
- The parent button after Open submodule, its tooltip with the full path, and one click back.
- The branch card on hover and on focus, and Escape.
- Forced colors (Aquatic) and Light for the row menu, the card, and the blame view.
