# Quickstart: Validate Remote Sync

**Feature**: `specs/003-remote-sync` | **Plan**: [plan.md](plan.md) | **Contract**: [contracts/operations.md](contracts/operations.md) | **Data model**: [data-model.md](data-model.md)

This guide lists the validation scenarios. It holds no implementation code. The work packages in plan.md create the named test files.

## Prerequisites

- Windows 11 x64 with the 001 qualification prerequisites.
- Git for Windows 2.56 for the P0 facts. The 001 minimum Git stays in force.
- PuTTY 0.75 or later for the PuTTY scenarios (O-6). Windows Sandbox for the registry cases.
- An SSH server per O-5. Without it, the SSH scenarios skip and stay unverified.
- WSL `Ubuntu-26.04` with Git 2.55 for WSL scenarios. Set `ARBARETO_WSL_DISTRO`.
- For app runs: set `ARBARETO_PROFILE_ROOT` to a scratch folder.
- No test contacts a public host.

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
- `bun run dev`

## Scenarios

| # | Scenario | Test home | Expected outcome | Spec |
|---|---|---|---|---|
| Q1 | Build the remote fixtures. | `tests/git/remote-fixtures.ts` | Self-check: refs, counts, markers. | SC-001 to SC-003 |
| Q2 | Record the Git facts (a) to (k). | `tests/git/remote-facts.test.ts` | Each fact passes, or research.md records the failure. | FR-005, FR-015, FR-019 |
| Q3 | Record the PuTTY facts. | `tests/windows/putty-facts.test.ts` | Unknown host fails within 5 s. The quoted plink path works. Pageant loads `--encrypted`. | SC-007 |
| Q4 | Fetch and Fetch all against bare remotes. | `tests/git/sync-fetch.test.ts` | Remote-tracking refs equal Git's fetch on a copy. Each remote has its outcome. "Nothing changed" when no line. | SC-001, FR-011, FR-012 |
| Q5 | Cancel and the inactivity end during a slow fetch. | `tests/git/sync-fetch.test.ts` (serial) | Reconciled within 5 s. The observed changes list. No rollback text. | SC-004, FR-004 |
| Q6 | Counts on every count fixture. | `tests/git/tracking.test.ts` | Each count equals `rev-list --left-right --count`. Gone, no upstream, equal, slashes, 10000+. | SC-003 |
| Q7 | Push with an upstream, without one (Set upstream), and to a protected branch. | `tests/git/sync-push.test.ts` | The remote ref and the tracking ref equal Git's push. Only the upstream keys changed. The remote rejection shows plain text and no choices. | SC-001, SC-006, FR-014 to FR-018 |
| Q8 | The push destination matrix. | `tests/git/sync-push.test.ts` | Each destination equals Git's own dry-run push, or the panel shows. | FR-014 |
| Q9 | Rejected push and the four choices. | `tests/git/sync-rejected.test.ts` | Each choice equals the Git commands by hand. A lease after a remote change loses no commit. | SC-002, FR-023 to FR-026 |
| Q10 | Pull: fast-forward, diverged with each mode, mode required, refused overwrite, cancel. | `tests/git/sync-pull.test.ts` | HEAD, index, files, and state equal Git's pull on a copy. No config change. | SC-001, FR-027 to FR-031 |
| Q11 | Abort, Continue, Skip on merge and rebase conflicts. | `tests/git/sync-conflicts.test.ts` | Equal to the Git commands by hand. Continue blocked with an unmerged entry and with marker-like text. | SC-012, FR-042 to FR-045 |
| Q12 | Mark resolved on each unmerged kind, and stale selections. | `tests/git/mark-resolved.test.ts` | Index equals `git add`. Working bytes unchanged. Stale gives `STALE_SELECTION`, and no index entry changes. | SC-014, FR-052, FR-053 |
| Q13 | Trust before pre-push, merge hooks, and transport programs. | `tests/git/sync-trust.test.ts` | `TRUST_REQUIRED` before any process. No canary runs. | FR-009 |
| Q14 | Credentials in the URL and from a helper (http-backend). | `tests/git/sync-credentials.test.ts` | The secret is in no result, event, log, remedy, or tail. | SC-005 |
| Q15 | Configuration byte identity across all fixtures. | each sync test | System, global, and local files unchanged, except Set upstream. | SC-006 |
| Q16 | Clone into a missing folder, an empty folder, a non-empty folder, and a file; cancel; empty remote; submodules. | `tests/git/clone.test.ts` | Equal to Git's clone. Refusals start no Git. Folder state after cancel equals disk. No submodule cloned. | SC-011, FR-046 to FR-051 |
| Q17 | Clone suggestion cases. | `tests/contracts/clone-name.test.ts` | `https://example.test/team/tool.git` with the last parent `D:\src` gives `D:\src\tool`. | FR-054 |
| Q18 | Fetch, push, and clone through plink and Pageant (Sandbox). | `tests/windows/putty-facts.test.ts` | Success. Unknown host fails fast and offers Connect in a terminal. Registry unchanged. | SC-007, SC-006 |
| Q19 | WSL fetch, pull, push, cancel, close. | `tests/wsl/sync-wsl.test.ts` | SC-001 results. No process remains in the distro. | SC-009 |
| Q20 | Counts timing on the 200-branch fixture, packaged. | `tests/windows/sync-perf.test.ts` | All counts within 1 s after the sidebar shows. Cold and warm runs. | SC-003 |
| Q21 | Input response during a fetch, a push, and a clone, packaged. | `tests/windows/sync-packaged.test.ts` | 95% within 100 ms, all within 500 ms. | SC-008 |
| Q22 | 30 minutes with focus returns and no network action. | `tests/windows/no-network.test.ts` | The `git daemon` log and the SSH log show no connection. | SC-013, FR-041 |
| Q23 | Requirement-to-test review. | review of tasks.md | No outcome decided by message text or timing. | SC-010 |
| Q24 | Component tests: toolbar, counts, push panel, notices, force confirmation, conflict actions, Mark resolved, clone panel, settings. | `tests/contracts/sync-*.test.tsx` | Keyboard, focus, text alternatives, Cancel focus, destructive styling. | FR-020, FR-024, FR-039 |

## Manual check in the app

1. Start the app with `ARBARETO_PROFILE_ROOT` set. Open a fixture clone with a diverged branch.
2. Check the toolbar and sidebar counts and their tooltips.
3. Push. Check the rejected notice and its four choices. Use Force push with lease and check the modal.
4. Pull with each mode. Make a conflict. Use Mark resolved, then Continue.
5. Select PuTTY in the settings. Fetch from the SSH fixture with an unknown host key. Use Connect in a terminal.
6. Clone a bare fixture with the suggested destination.

## Evidence

Record build, OS version, Git version, PuTTY version, distro, and results in research.md "Results". Untested scenarios stay unverified.
