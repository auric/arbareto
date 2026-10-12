# Quickstart: Validate Full History and Commit Message Filter

**Feature**: `specs/002-full-history` | **Plan**: [plan.md](plan.md) | **Contract**: [contracts/operations.md](contracts/operations.md) | **Data model**: [data-model.md](data-model.md)

This guide lists the validation scenarios. It holds no implementation code. The test files that it names do not exist yet. The work packages in plan.md create them.

## Prerequisites

- Windows 11 x64 with the 001 qualification prerequisites (001 plan.md "Technical Context").
- Git for Windows 2.56.0.windows.1 for the P0.2 order facts. The 001 minimum Git stays in force.
- For WSL scenarios: the `Ubuntu-26.04` distro with Git 2.55. Set `ARBARETO_WSL_DISTRO`.
- For app runs: set `ARBARETO_PROFILE_ROOT` to a scratch folder.
- Git Extensions with the maintained commit-graph variant for SC-011.
- Disk space for the H200K and H1M fixtures. The builder caches them under the 001 performance fixture cache.

## Commands

Use only the README "Development" commands:

- `bun install --frozen-lockfile`
- `bun run build`
- `bun run typecheck`
- `bun run export:schemas --check`
- `bun run test:contracts`
- `bun run test:git`
- `bun run test:windows` (after `bun run build:service`)
- `bun run test:all` (full runs alone, never in parallel with another full run)
- `cargo check --locked --manifest-path src-tauri/Cargo.toml`
- `bun run dev`
- `pwsh -File scripts/windows/measure-ram.ps1 [-RootPid <pid>]`

## Scenarios

| # | Scenario | Test home | Expected outcome | Spec |
|---|---|---|---|---|
| Q1 | Build the small graph fixtures and H200K, with and without a commit-graph. H1M builds on demand for Q4, Q14, and Q15. | `tests/git/history-fixtures.ts` | The builder self-check passes: counts, commit-graph state, semantic digest. | SC-001, SC-003 to SC-005 |
| Q2 | Record the Git order facts on Windows Git and on each WSL distro. | `tests/git/history-order.test.ts` | Two runs give equal bytes. `--skip=k` equals the suffix. `--date-order` is equal with and without a commit-graph. `--grep` equals the full order without the non-matches. A failed fact goes to research.md. | FR-004, FR-021 |
| Q3 | Feed rows in random chunk sizes. Rebuild cells from checkpoints. | `tests/git/history-layout.test.ts` | Each rebuilt cell equals one fold over all rows. Each segment ends in the lane of the matching Git parent. | SC-004, FR-011, FR-014 |
| Q4 | Measure Git peak private bytes on H1M during load and search. | `tests/windows/history-git-memory.test.ts` | A number for each Git command, with and without a commit-graph, and the first-step peak and re-read times (T061). The user decided open item O-1 on 2026-10-12: SC-002 excludes Git's child processes. | SC-002 |
| Q5 | Run the matching cases. | `tests/git/history-search-facts.test.ts` | Every match and non-match agrees with FR-023 and FR-024 on Windows and each distro. | SC-007 |
| Q6 | Scroll a view to the end. Cancel and resume at each chunk boundary on H200K. Stop at each D2 stop row and resume. | view tests of WP6 | The rows equal one uninterrupted `rev-list --date-order --parents` run. The commit set equals `git log --branches --remotes --tags refs/stash HEAD`. | SC-001, SC-003 |
| Q7 | Open views on the ref fixtures. | view tests of WP6 | Labels sit on Git's commits. Tags to a tree or a blob add no row. Notes, `refs/pull/`, and older stash entries add no row. Symbolic refs add no label. | SC-015 |
| Q8 | Move a ref and HEAD during a scroll. Change the shallow file, the grafts, or a replace ref. | view tests of WP6 | A ref move gives the notice and keeps the rows. A topology change makes the view stale with `HISTORY_CHANGED topology`. | SC-012, FR-005, FR-006 |
| Q9 | Search, then compare filter mode and highlight mode with Git. | search tests of WP7 | Filter mode shows exactly Git's matches in order. The reduced graph equals the BFS oracle. Next and Previous reach every match. The final count equals Git's count. | SC-008 |
| Q10 | Send each refused text. | search tests of WP7 | Each case gives its typed reason. No Git process starts. | SC-009 |
| Q11 | Cancel a load and a search. | view and search tests | Each stops within 1 s. No process of the operation remains after 5 s. No count shows as final. | SC-010 |
| Q12 | Compare repository bytes before and after each fixture run. | every fixture test | Byte-identical files. No commit-graph file appears. | SC-013 |
| Q13 | Drive the frontend with a fake count of 1M rows. | `tests/contracts/history-*.test.tsx` | Keyboard, refusals, notices, and stable rows after eviction work. No structure grows with the count. | FR-011, FR-031, FR-040 |
| Q14 | Packaged build on H1M without a commit-graph: open, End, scrollbar drag, wheel scroll, search, mode switch, scope switch, Cancel, Refresh after a ref move. End and the scrollbar drag at the comfortable density. | `tests/windows/history-perf.test.ts` | The 001 SC-005 targets hold. `IsHungAppWindow` never reports the window. | SC-014, FR-052 |
| Q15 | Packaged build on H1M: memory over the process tree at each SC-002 checkpoint. | `tests/windows/history-perf.test.ts` | After the first load step ends (its `loadHistory` result arrived), no Git process of the view runs, and the view adds at most 16 MiB (proposed). After End, after a return to the top, and during a search: within 128 MiB. Both bounds count the Arbareto processes (shell, service, WebView2) against the same worktree with a one-commit history. Git's child processes are recorded apart, without a bound. | SC-002 |
| Q16 | Time to the first row, and the time to the first new row of a later load step, and filter latency on H200K, with Git's own times beside them. | `tests/windows/history-perf.test.ts` | Recorded numbers. SC-006 holds. | SC-005, SC-006 |
| Q17 | Git Extensions full scroll and message filter on H200K. | the Git Extensions harness | The upper 95% bound of the median ratio is at most 1.0 for each workflow. | SC-011 |
| Q18 | WSL: scroll, search, and the matching probe in each distro. | `tests/wsl/history-wsl.test.ts` | Same order and matching rules. A missing condition gives `SEARCH_UNSUPPORTED` with a remedy. | FR-046, SC-007 |
| Q19 | Drive the references sidebar with 10,000 refs. | `tests/contracts/references-sidebar.test.tsx` | Only the rows near the visible area exist as elements. Keyboard navigation and the filter reach every ref. Each tree item states its level, position, and set size. | FR-055 |

## Manual check in the app

1. Start the app with `bun run dev` and a scratch `ARBARETO_PROFILE_ROOT`.
2. Open a repository with branches, remote-tracking refs, tags, and a stash.
3. Scroll down past the first rows. Expect more rows and a row that states that more commits exist. Press End. Expect progress with Cancel, then the last commit and the final row count.
4. Type "fix" in the message filter and press Enter. Expect matches in history order and a count that states that it is final at the end.
5. Switch to highlight mode. Expect no new search. Press F3 and Shift+F3 (plan.md D6 shortcuts: Ctrl+F focuses the filter, F3 and Shift+F3 move between matches; research R13 lists the conflict check as unverified). Expect the selection to move across matches without wrap.
6. Create a branch in a terminal. Expect the "References changed" notice. Select Refresh. Expect the new branch label.

## Evidence

Record every result in research.md as R14 and later. Record the build, OS version, architecture, Git version, fixture, and run count. Untested behavior stays unverified.
