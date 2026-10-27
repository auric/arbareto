# Quickstart: Validate Discard (Revert) Changes

This guide lists the runs that prove the feature. The test files and their steps come from [plan.md](plan.md) D13 and tasks.md. The contract is [contracts/operations.md](contracts/operations.md). The rules are in [spec.md](spec.md).

## Prerequisites

- Windows 11 x64 with Git for Windows 2.55 or later, Bun 1.4.4, and the Rust toolchain of the README.
- For the WSL runs: the distro `Ubuntu-26.04` with Git 2.55 and `/usr/bin/perl`, and `ARBARETO_WSL_DISTRO=Ubuntu-26.04`. A WSL run runs alone on the host.
- For the packaged runs: `bun run build:service`, then `bun run package`, and the reference PC with Windows Defender real-time protection on.
- Every app run sets `ARBARETO_PROFILE_ROOT` to a scratch folder.
- No test touches a real repository or the user's Git configuration. Every Git test uses an owned `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM=1`.

## Commands

Use only the README "Development" commands:

- `bun install --frozen-lockfile`
- `bun run typecheck`
- `bun run export:schemas --check`
- `bun run test:contracts`
- `bun run test:git`
- `bun run test:all` (the full run; set `ARBARETO_WSL_DISTRO` for the WSL files)
- `cargo test --locked --manifest-path src-tauri/Cargo.toml`
- `bun run test:windows` (after `bun run build:service`)
- `bun run package`

## Scenarios

| Story | What to run | Expected result |
| --- | --- | --- |
| Batch 0 facts | `bun test tests/git/revert-facts.test.ts`, `bun test tests/windows/revert-facts.test.ts`, the WSL file alone | One `OBSERVATION` line per probe G3 to G10, W1 to W11, and L1 to L7. Research R15 records them. |
| US1 unstaged lines | `tests/git/revert-lines.test.ts` | The working bytes equal `git apply -R` of the same partial patch on a copy. The index digest stays. The CRLF and proof cases of data-model §6 pass or refuse as listed. |
| US2 files | `tests/git/revert-files.test.ts` | The index and the working files equal `git restore --staged --worktree --source=HEAD` on a copy, except that a staged new file keeps its working file. A 40 MiB file reverts, and no request carries its bytes. No `.merge_file_*` file stays after the run. |
| US3 all unstaged | `tests/git/revert-unstaged.test.ts` | The working files equal `git restore .` on a copy. The index, the untracked files, and the submodules stay. One refused entry makes the action unavailable. |
| US4 staged lines | `tests/git/revert-staged.test.ts` | The index equals `git apply --cached -R` on a copy, and the working file loses the same lines. A file with unstaged changes refuses. |
| Refusals | `tests/git/revert-refusal.test.ts` | Each data-model §7 reason refuses with its code and reason, and nothing changes. |
| Races and interruption | `tests/git/revert-races.test.ts`, the cargo tests of `file_replace.rs` | A change between the review and the run changes nothing. An index part followed by a stale file gives `unstaged-only`. A stop at each write step leaves the old or the new bytes. |
| Keys and modal | `tests/contracts/revert-confirm.test.tsx`, `revert-menus.test.tsx`, `revert-keys.test.tsx` | Cancel has the first focus. Enter, Escape, and a held R change nothing. The menus show the destructive groups and the reasons. |
| US5 WSL | `tests/wsl/revert-wsl.test.ts`, alone | The US1 to US4 results equal Git in the distro. Mode bits, owner, and link count stay. A staged part refuses with `shared-repository`. |
| Packaged | `tests/windows/revert-packaged.test.ts`, `tests/windows/revert-perf.test.ts` | The keyboard flow through UI Automation, forced colors, text scale, a file in use, and the SC-007 budgets. |

## Manual checks in the packaged build

1. Open a disposable repository with a modified file. Select 2 changed lines in the diff and press R. Check that Cancel has the focus, then press Enter. Nothing changes.
2. Press R again, press Tab to reach "Revert lines", and press Enter. The 2 lines go from the working file, and the status bar states "Arbareto reverted 2 lines in <file>."
3. Mark 3 files in the Changes list and press R. The modal lists them. Revert them, and check that they leave both lists.
4. Open the Changes header menu and select "Revert all unstaged changes…". Check the counts, then Cancel.
5. Open the file in another program that holds it open without write sharing, then revert it. The result names the sharing violation, and the file keeps its bytes.
