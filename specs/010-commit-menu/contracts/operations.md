# Operation Contract Deltas: History Commit Menu

This file lists only the changes to the feature 001 contract (`specs/001-desktop-qualification/contracts/operations.md`) and to the 002 to 008 deltas. "001 §n" and "00n Δn" name those sections. Every rule that no delta replaces stays in force.

## Δ1 Transport (001 §1)

- `WORKBENCH_ACTIONS` gains `reset`, `create-tag`, `cherry-pick`, and `revert-commit` (`channel.ts:882-902`).
- `WORKBENCH_STARTED_ACTIONS` gains the same four (`channel.ts:904-926`).
- No new operation name. `reviewWorkbench` reviews the four actions, and `runWorkbench` runs them.
- Keep explicit range checks in Rust (001 §1).

## Δ2 Envelope (001 §2)

- `MUTATIONS` keeps `runWorkbench`. No new mutation operation.
- New phases: `reset`, `tag`, `cherry-pick`, and `revert-commit` (`operations.ts:161`). They have no counters. Rust `progress()` gives them `&[]`.
- New sync phases: `sync-cherry-pick` and `sync-revert` for Abort of the new kinds, with `SYNC_COUNTERS` (`operations.ts:172`, `:207`). Continue keeps `sync-continue`.
- Events carry no path and no Git text.

## Δ3 Public operations (001 §3)

Every argument array starts with `--no-lazy-fetch`. Reads add `--no-optional-locks` and `--literal-pathspecs`. `<oid>` passes `isObjectId`. `L` below stands for `--no-lazy-fetch`.

### `reviewWorkbench` (004 Δ3)

- New payload forms (data-model §3):
  - `ReviewReset { action: "reset", target: ObjectId, mode: "soft" | "mixed" | "hard" }`.
  - `ReviewCreateTag { action: "create-tag", name: TagName | null, target: ObjectId, message: TagMessage | null }`. `name: null` is the open review of the popover. It skips the name reads and the command-line bound. It returns the plan with no token.
  - `ReviewCherryPick { action: "cherry-pick", commit: ObjectId, mainline: 1..64 | null }`.
  - `ReviewRevertCommit { action: "revert-commit", commit: ObjectId, mainline: 1..64 | null }`.
- Common refusals (004 Δ3): `OPERATION_IN_PROGRESS`, `unknown-operation`, and `BUSY`. The four actions are not in `IN_PROGRESS_ALLOWED`.
- `reset` reads, in order:
  1. HEAD (`unborn`, `detached`).
  2. `indexState` (`CONFLICTED`).
  3. `cat-file --batch-command` `info <oid>^{commit}` (`UNKNOWN_TARGET`).
  4. `rev-list --count <target>..HEAD` and `rev-list --count HEAD..<target>`.
  5. `rev-list --count HEAD --not <target> --exclude=<branch> --branches --tags --remotes`.
  6. The force note, then `trackedStatus`.
  7. Hard only: `diff-index --cached -R -z --no-renames --name-status <target> --` and the 004 in-the-way facts (`limit`, `UNTRACKED_IN_WAY`).
- `create-tag` reads, in order:
  1. `tagNameRefusal`, with no Git process.
  2. `check-ref-format refs/tags/<name>`. Exit 0 passes. Another exit gives `invalid-name`.
  3. `show-ref --exists refs/tags/<name>`. 0 gives `name-exists`. 2 passes. Another exit gives `GIT_FAILED`.
  4. `info <oid>^{commit}` (`UNKNOWN_TARGET`).
  5. The trust listing values of `tag.gpgsign` and `tag.forcesignannotated` (`invalid-config`, `tag-signing`). The plan holds `signs: { light, annotated }`. The open review gives no `tag-signing` refusal.
  6. The command-line bound (`message-size`).
- `cherry-pick` and `revert-commit` read, in order:
  1. HEAD (`unborn`, `detached`).
  2. `indexState` (`CONFLICTED`).
  3. `info <oid>^{commit}` (`UNKNOWN_TARGET`).
  4. `rev-list --parents -n 1 <oid> --` (`limit`).
  5. The mainline rule (`mainline-needed`, `not-merge`, `INVALID_REQUEST`).
  6. Cherry-pick only: `merge-base --is-ancestor <oid> HEAD`. 0 gives `already-on-branch`. 1 passes. Another exit gives `GIT_FAILED`.
  7. `trackedChanges()` (`dirty-tree`).
- Plans: `ResetPlan`, `CreateTagPlan`, `CherryPickPlan`, and `RevertCommitPlan` (data-model §3).

### `runWorkbench` (004 Δ3)

- Every action: the frame's full observation again. A difference gives `STALE_REVIEW`. Then the step. Then a fresh `observe` and the outcome mapping of data-model §4.
- Steps:
  - `reset`: `[L, "reset", "--quiet", "--no-recurse-submodules", "--<mode>", oid, "--"]`.
  - `create-tag` lightweight: `[L, "tag", "--end-of-options", name, oid]`.
  - `create-tag` annotated: `[L, "tag", "-m", message, "--end-of-options", name, oid]`. No `-a`, no `-f`, and no `--no-sign`.
  - `cherry-pick`: `[L, "cherry-pick", ("-m", n)?, oid]`.
  - `revert-commit`: `[L, "revert", "--no-edit", ("-m", n)?, oid]`.
  - No `--` after the object ID of cherry-pick and revert. No `-x`, `-s`, `-n`, `--no-gpg-sign`, `--allow-empty`, or `--empty`.
- Run results: `ResetRun { action, mode, head, refs, trackedChanges, outputTail? }`, `CreateTagRun { action, head, refs, tag: { name, oid, annotated } | null, outputTail? }`, and `PickRun { action, head, refs, operationState, unmerged, outputTail? }` for both pick actions.
- Stop state: Git can stop a cherry-pick or a revert. The fresh `observe` then gives `operationState` `cherry-picking` (marker `CHERRY_PICK_HEAD`) or `reverting` (marker `REVERT_HEAD`), with the `unmerged` count. The outcome is `failed-with-effects`. With unmerged > 0, the result has no `outputTail`. With unmerged 0, for example an empty pick, the result has the `outputTail` of the step. A `.git/sequencer` marker without either pseudoref gives `sequencer-active`, not a stop state.
- `RUN_ACTIONS` (`envelope.ts:1897`) gains the four actions.

### `reviewSync` and `sync` (003 Δ3)

- Abort and Continue accept the operation states `cherry-picking` and `reverting`.
- `SyncPlan.operationState` widens to the two states (`envelope.ts:1314`).
- `abortArgs`: `[L, "cherry-pick", "--abort"]` or `[L, "revert", "--abort"]`. `continueArgs`: `[L, "cherry-pick", "--continue"]` or `[L, "revert", "--continue"]`.
- Skip refuses with `not-rebasing` in both states.
- A `.git/sequencer` marker refuses Abort and Continue with `sequence`. The fact comes from the status reader marker facts.
- Continue refuses with `CONFLICTED` while unmerged > 0, and with `nothing-to-commit` when `diff-index --cached --quiet HEAD --` gives exit 0.
- An Abort or a Continue that ends with the stop still in place gives `integration: { state: "stopped", operation, unmerged }` with `operation` `cherry-picking` or `reverting`. Only the actions `abort` and `continue` carry a pick stop in `integration`. A pull or an integrate stops only in a merge or a rebase.
- A pick state with an unreadable sequencer fact refuses Abort and Continue with `unknown-operation`.
- The Abort phase is `sync-cherry-pick` or `sync-revert`. The outcome follows the 003 rule of `runConflictAction` (`sync-integrate.ts:347-351`).

## Δ5 Finite bounds (001 §5)

- `IN_THE_WAY_PATHS` 100 for the Hard refusal list. `DISCARD_CHECK_PATHS` 20,000 for the in-the-way candidates. More candidates refuse with `limit`.
- `BRANCH_NAME_BYTES` 255 for the tag name, as for a branch name.
- `MERGE_MESSAGE_BYTES` 8 KiB for the tag message. `WINDOWS_COMMAND_LINE_UNITS` for the tag step.
- Mainline at most 64 (`HISTORY_PARENTS_PER_COMMIT`).
- The output tail stays at `DIAGNOSTIC_RETAINED_BYTES_PER_STREAM` 64 KiB.
- No new limit constant.

## Δ6 Shell (001 §6)

- `TRUST_ACTIONS` gains `reset`, `tag`, `cherry-pick`, and `revert` (`channel.ts:970`).
- `dialogs.rs` `action_sentence` gains the four trust sentences of plan D11.
- `close.rs` `Mutation` gains the four close-prompt names of plan D11.
- `schema.rs` gains the four phases and the four started actions.
- No argument allowlist applies to `registeredOperation` runs. The shell checks the policy fit by the started kind (004 contract `:222`).

## Δ7 Startup, trust, and environment (001 §7)

- `reset`, `create-tag`, `cherry-pick`, and `revert-commit` use the trust class `workbench`. Its events cover every hook that probes P2, P3, P3b, and P3c observed (`trust.ts:677-689`). `gpg.program` counts for the class (`trust.ts:408-409`).
- Abort and Continue use the class `sync`. Its events cover the pre-commit and commit-msg hooks of Continue (`trust.ts:673-675`).
- Steps run under policy `integrate`: `GIT_TERMINAL_PROMPT=0` and `GIT_EDITOR=:` (003 contract `:216`).
- The actions write no configuration.

## Δ8 Freshness, cancellation, and outcome (001 §8)

- A review lives 60 s and is single use (`limits.ts:68`).
- Cancel stops the step. A fresh `observe` reports the result. Cancel is never a rollback.
- Git documents no exit status for reset, cherry-pick, revert, tag, and checkout. Their outcomes come from fresh reads (data-model §4).

## Δ9 Error codes (001 §9)

- New workbench reasons: `tag-signing`, `already-on-branch`, `mainline-needed`, and `not-merge` (`errors.ts:109-166`).
- New sync reasons: `nothing-to-commit` and `sequence` (`errors.ts:73-95`).
- An empty tag name gives `INVALID_REQUEST`. A leading `-` gives `invalid-name`. `HEAD` and `@` give `reserved-name`.
- Reused reasons: `detached`, `unborn`, `dirty-tree`, `name-exists`, `invalid-name`, `reserved-name`, `message-size`, `invalid-config`, `limit`, `path`, `unreadable`, and `not-rebasing`.
- Reused codes: `UNTRACKED_IN_WAY`, `UNKNOWN_TARGET`, `CONFLICTED`, `STALE_REVIEW`, `GIT_FAILED`, and `INVALID_REQUEST`.

## Δ10 Required contract checks (001 §10)

- `bun run export:schemas` regenerates `src/contracts/schemas/*.json`. The Rust build regenerates its types from them (`schema.rs:4`).
- Vectors in `tests/vectors/valid/commit-*.json` and `tests/vectors/invalid/commit-*.json` cover each payload, plan, run result, and reason. The invalid vectors hold a mode outside the enum and a mainline of 0 and of 65. They also hold a tag name with NUL and a message above 8 KiB.

## Δ11 WSL repositories (001 §11)

- No change. The same argument arrays run through the 006 route. The process-end wait applies before every read.

## Contract gaps

- None known. A probe finding of T001 changes this file first.
