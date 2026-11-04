# Quickstart: Validate the History Commit Menu

This guide lists the runs that prove the feature. The test files come from [plan.md](plan.md) D14 and tasks.md. The contract is [contracts/operations.md](contracts/operations.md). The rules are in [spec.md](spec.md). Plan D11 holds the exact texts.

## Prerequisites

- Windows 11 x64 with Git for Windows 2.55 or later, Bun 1.4.4, and the Rust toolchain of the README.
- For the WSL runs: the distro `Ubuntu-26.04` with Git 2.55, and `ARBARETO_WSL_DISTRO=Ubuntu-26.04`. A WSL run runs alone on the host.
- For the packaged runs: `bun run build:service`, then `bun run package`.
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

Run each scenario in a disposable repository.

| ID | Scenario | Expected result |
| --- | --- | --- |
| Q1 | Right-click a commit row. Then right-click a branch chip. | The commit menu opens, the row is selected, and its details dock. The chip opens the branch menu. |
| Q2 | Shift+F10 on a row with labels. Right, then Shift+F10. Left, then Left. | The commit menu, then the branch menu. The live region announces the commit. |
| Q3 | Copy commit ID. | The clipboard holds the full object ID. |
| Q4 | Check out this commit on a clean tree. | The confirmation shows the detach note, and Cancel has the focus. Then the branch button shows the detached state. |
| Q5 | Create tag v2 as lightweight. Set `tag.gpgSign=true` in the owned configuration and try again. | v2 exists. With signing, the lightweight choice refuses. An annotated tag with a message works. |
| Q6 | Reset Mixed 2 commits back with a staged new file. | The popover counts 2 commits. The outcome shows. The staged new file becomes untracked. |
| Q7 | Reset Hard with an untracked file at a target path. Then remove the file and review again. | The refusal lists the path, and nothing changes. Then the Hard dialog opens with Cancel focused. Escape cancels. The danger button runs. |
| Q8 | Cherry-pick a commit from another branch. | A new commit with the picked message is on the branch. |
| Q9 | Cherry-pick with a conflict. Resolve the file, select Mark resolved, then Continue. | The band shows the conflict row. After Continue, the commit exists and the state is normal. |
| Q10 | Revert with a conflict, then Abort. | The confirmation shows. The state is normal, and HEAD is unchanged. |
| Q11 | Revert a merge commit. | Parent 1 is preselected. The result equals `git revert -m 1` on a copy. |
| Q12 | Q6 to Q9 in a WSL repository on Ubuntu-26.04. | The same results as Git in the distro. |
| Q13 | Set `tag.gpgSign=true` in the owned configuration. Open Create tag here, then select Annotated tag. | Before any typing, Lightweight tag shows the tag-signing reason, and Create tag is unavailable. After the switch, the popover states that Git signs the tag. |
| Q14 | Cherry-pick with 2 conflicted files. Mark one file resolved, then the other. | Resolve conflicts shows while a file is unmerged. Continue shows after the last Mark resolved. Abort shows always. |

## Test files

| Story | What to run | Expected result |
| --- | --- | --- |
| Contracts | `tests/contracts/commit-actions-contract.test.ts`, `tests/contracts/tag-name.test.ts` | Every valid vector passes, and every invalid vector fails. |
| US1 | `tests/contracts/commit-menu.test.tsx`, `tests/contracts/workbench-branches.test.tsx` | The opening, label, and availability rules of plan D1. |
| US2 | `tests/git/create-tag.test.ts` | The refs equal `git tag` on a copy, with and without signing configuration. |
| US3 | `tests/git/reset.test.ts` | Each mode equals `git reset --<mode>` on a copy. Hard refuses an untracked file in the way. |
| US4 | `tests/git/cherry-pick-revert.test.ts`, `tests/git/sync-conflicts.test.ts`, `tests/contracts/sync-conflicts.test.tsx` | The results equal Git on a copy. Abort and Continue equal `--abort` and `--continue`. |
| Popovers | `tests/contracts/commit-actions.test.tsx` | Mixed preselected, Lightweight preselected, the Hard dialog focus and keys. |
| US5 | `tests/wsl/commit-actions-wsl.test.ts`, alone | The results equal Git in the distro. Mode bits, owner, and link count stay. |
| Packaged | `tests/windows/commit-menu-packaged.test.ts`, `tests/windows/commit-menu-perf.test.ts` | The UIA names, the keyboard flow, forced colors, text scale, and the SC-010a to SC-011 budgets. |
