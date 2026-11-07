# Quickstart: Validate Remote Branch Delete

This guide lists the runs that prove the feature. The test files come from [plan.md](plan.md) D16 and tasks.md. The contract is [contracts/operations.md](contracts/operations.md). The rules are in [spec.md](spec.md). Plan D13 holds the exact texts.

## Prerequisites

- Windows 11 x64 with Git for Windows 2.55 or later, Bun 1.4.4, and the Rust toolchain of the README.
- For the WSL runs: the distro `Ubuntu-26.04` with Git 2.55, and `ARBARETO_WSL_DISTRO=Ubuntu-26.04`. A WSL run runs alone on the host.
- For the packaged runs: `bun run build:service`, then `bun run package`.
- Every app run sets `ARBARETO_PROFILE_ROOT` to a scratch folder.
- No test touches a real repository, a real remote, or the user's Git configuration. Every Git test uses a local bare remote over a file path, an owned `GIT_CONFIG_GLOBAL`, and `GIT_CONFIG_NOSYSTEM=1`.

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

Run each scenario in a disposable repository with a local bare remote.

| ID | Scenario | Expected result |
| --- | --- | --- |
| Q1 | Right-click the remote-tracking row `origin/feature`. Then right-click the History label `origin/feature`. | Both menus show X1 in group 2 with the key text. |
| Q2 | Focus `origin/feature` and press Del. | The confirmation opens with Cancel focused. Enter on Cancel and Escape change nothing. |
| Q3 | Confirm the delete of `origin/feature`. | The remote has no `refs/heads/feature`. `refs/remotes/origin/feature` is gone. A local branch that tracks it shows `gone`. |
| Q4 | Push a commit to `feature` from another clone. Then confirm the delete without a fetch. | Git deletes nothing. The remote keeps the commit. The status bar states X22. |
| Q5 | Select X1 on `origin/main`, the target of `refs/remotes/origin/HEAD`. | The review refuses with X13. No network process starts. |
| Q6 | Run `git remote set-head origin -d` in a terminal. Select X1 on any `origin` branch. | The review refuses with X14. After a fetch, the delete works. |
| Q7 | Open Delete on the local branch `keep` with the upstream `origin/keep`. Check X9 and confirm. | Both refs and the `branch.keep` section are gone. The status bar states X21. |
| Q8 | Repeat Q7 with the bare remote folder renamed. | Both branches stay. The status bar states the failure line with X25. |
| Q9 | Delete `refs/heads/gone1` on the remote from another clone. Then select X1 on `origin/gone1`. | `refs/remotes/origin/gone1` is gone. The status bar states X23. |
| Q10 | Q3, Q4, Q7, and Q9 in a WSL repository on `Ubuntu-26.04`. | The same results as Git in the distro. |

## Test files

| Story | What to run | Expected result |
| --- | --- | --- |
| Contracts | `tests/contracts/remote-delete-contract.test.ts` | Every valid vector passes, and every invalid vector fails. |
| Arrays and parsers | `tests/contracts/sync-commands.test.ts`, `tests/contracts/sync-parsers.test.ts` | The exact delete array with the lease. The P1 to P10 lines parse, including the `(delete):<dst>` alias. |
| Trust | `tests/contracts/trust-classes.test.ts` | `approvalRequired.workbench` implies `approvalRequired.sync`. |
| US1 | `tests/git/remote-delete.test.ts` | Each fixture equals the Git lease delete on a copy. A moved remote branch keeps every commit. |
| US2 | `tests/git/remote-delete-local.test.ts` | Each combined fixture equals the Git commands on a copy. Partial results state the exact state. |
| US3 | `tests/git/remote-delete-gone.test.ts` | A gone branch removes only the stale ref. A moved branch keeps it. |
| Hooks and credentials | `tests/git/pre-push.test.ts`, `tests/git/sync-trust.test.ts`, `tests/git/sync-credentials.test.ts` | The pre-push hook runs only after approval. No credential shows. |
| UI | `tests/contracts/remote-delete.test.tsx`, `tests/contracts/workbench-branches.test.tsx` | The item order, Del, the dialog focus, the check box default, and the texts. |
| US4 | `tests/wsl/remote-delete-wsl.test.ts`, alone | The results equal Git in the distro. No process stays after Cancel. |
| Packaged | `tests/windows/remote-delete-packaged.test.ts`, `tests/windows/remote-delete-perf.test.ts` | The UIA names, the keyboard flow, forced colors, text scale, and the SC-009a to SC-009e budgets. |
