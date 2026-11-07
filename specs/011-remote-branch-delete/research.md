# Research: Remote Branch Delete

## R1 Sources and fact marks

- Arbareto code: the design plan read origin/main `65959ceb` and the branch `010-commit-menu` at `22cdcac9`. This spec checked a sample of its line references on `65959ceb`. The sample is `channel.ts:878`, `errors.ts:71`, `shortcuts.ts:182`, `sync.ts:150`, `sync-review.ts:400`, `branch-ops.ts:163`, `admission.ts:9`, and 004 `plan.md:570`. Each matched. Every implementer checks the other references on the base of the task.
- Git: Git for Windows 2.56.0.windows.2 on the reference PC, and Git 2.55.0 in `Ubuntu-26.04` (Ubuntu 26.04.1 LTS).
- Probe setup: a local bare remote over a file path, an owned `GIT_CONFIG_GLOBAL`, `-c user.name=Sample -c user.email=sample@example.invalid`, `GIT_TERMINAL_PROMPT=0`, and `LC_ALL=C`. Push options: `--no-lazy-fetch push --porcelain --progress --no-recurse-submodules --no-follow-tags`.
- Probe scripts: `probe.sh` and `probe2.sh`, with `wsl-run.sh` and `wsl-run2.sh` for the distro. Raw outputs: `win.txt` and `wsl.txt` (`probe.sh`), `win2.txt` and `wsl2.txt` (`probe2.sh`). They are in local scratch, with the design plan of 2026-11-06. The probe repositories were deleted after the runs.
- The raw outputs use their own section labels. The R2 column "Raw label" maps each fact to its section.
- Git source: tag `v2.55.0` of git/git (`transport.c`, `remote.c`, `builtin/receive-pack.c`).
- Git documentation: the Git 2.56 pages that Git for Windows installs (git-push(1), git-ls-remote(1), git-symbolic-ref(1), git-update-ref(1), git-rev-list(1)). T001 copies the cited sections as text into its local scratch folder.
- Constitution: `.specify/memory/constitution.md` on `main` `65959ceb`, footer "**Version**: 4.0.0 | **Ratified**: 2026-09-28 | **Last Amended**: 2026-10-22".
- Marks: "Probe" is a fact that a probe run showed. "Source" is a fact of the Git source. "Doc" is a fact of the Git documentation. "Code" is a fact of the Arbareto source. "Decision" is a plan choice.

## R2 Probe facts (Git 2.56.0.windows.2 and Git 2.55.0 in `Ubuntu-26.04`)

| ID | Case | stdout status line | Exit | Other facts | Raw label | Used by |
|---|---|---|---|---|---|---|
| P1 | delete `:refs/heads/feature` | `-\t:refs/heads/feature\t[deleted]` | 0 | `To <url>` and `Done` lines around it | `win.txt` P1a | plan D5, D6 |
| P1b | `--delete -- origin refs/heads/feature2` | `-\t:refs/heads/feature2\t[deleted]` | 0 | the same form as P1 | `win.txt` P1b | plan D5 |
| P2 | delete a missing remote branch, no lease | `-\t:refs/heads/nope\t[deleted]` | 0 | stderr `remote: warning: deleting a non-existent ref`; a stale tracking ref goes too | `win.txt` P1c, P1c2, P1c3 | plan D5 (lease required) |
| P3 | `receive.denyDeletes=true` | `!\t:refs/heads/feature3\t[remote rejected] (deletion prohibited)` | 1 | tracking ref kept | `win.txt` P1d | plan D6, T009 |
| P4 | bare remote, its HEAD branch, `receive.denyDeleteCurrent` unset | `!\t:refs/heads/main\t[remote rejected] (deletion of the current branch prohibited)` | 1 | tracking ref kept | `win.txt` P1e, P3b | plan R4, T009 |
| P5 | non-bare remote, branch checked out, `denyDeleteCurrent` unset or `refuse` | `!\t:refs/heads/feature3\t[remote rejected] (branch is currently checked out)` | 1 | tracking ref kept | `win.txt` P1f, P1f2 | T009 |
| P6 | remote pre-receive exits 1 | `!\t:refs/heads/feature8\t[remote rejected] (pre-receive hook declined)` | 1 | tracking ref kept | `win.txt` P1g | T009 |
| P7 | local pre-push exits 1 | no stdout | 1 | pre-push stdin: `(delete) <zero oid> refs/heads/feature8 <remote oid>` | `win.txt` P1h, P1h2 | plan D6, T011 |
| P8 | lease, remote moved | `!\t(delete):refs/heads/feature4\t[rejected] (stale info)` | 1 | tracking ref kept | `win.txt` P2a | plan D5 alias, T007 |
| P9 | lease, remote branch absent | `!\t(delete):refs/heads/feature6\t[rejected] (stale info)` | 1 | tracking ref kept | `win.txt` P2c | plan D8, T007 |
| P10 | lease equal | `-\t:refs/heads/feature4\t[deleted]` | 0 | tracking ref removed | `win.txt` P2b | plan D5, T001 control |
| P11 | no lease, remote moved | `-\t:refs/heads/feature5\t[deleted]` | 0 | the moved commits leave the remote branch | `win.txt` P2a "no lease" | plan R2, T006 |
| P12 | after P1 | none | none | `refs/remotes/origin/feature` gone; `branch.feature.remote` and `.merge` kept; `%(upstream:track,nobracket)` is `gone` | `win.txt` P3 (three sections) | spec FR-009 |
| P13 | default branch | none | see facts | After a clone, `symbolic-ref -q refs/remotes/origin/HEAD` prints `refs/remotes/origin/main` (exit 0). Absent, non-symbolic, or unknown remote: exit 1, no output. A plain fetch creates the absent symref (default `followRemoteHEAD`). With `followRemoteHEAD=never`, it stays absent. A remote HEAD change does not move an existing symref. `ls-remote --symref origin HEAD` prints `ref: refs/heads/main\tHEAD` (a network read, not used). | `win.txt` P4 (nine sections); `win2.txt` Q3 | plan D4 read 6, spec FR-004 |
| P14 | commits only the remote branch holds | `2` | 0 | `rev-list --count <tip> --not --branches --tags --exclude=origin/feature4 --remotes` gives 2. The form `--exclude=refs/remotes/origin/feature4` excludes nothing and gives 0 (control). The combined form with `--exclude=feature4 --branches` gives 2, where the local-only count gives 0. | `win.txt` P5 | plan D4 read 10, D7 |
| P15 | `ls-remote --exit-code -- origin refs/heads/keep` | `<oid>\trefs/heads/keep` | 0 | absent: exit 2, no output. Pattern `b` matches `refs/heads/a/b` (tail match), so parse exact lines. | `win2.txt` Q1 | plan D5, D8 |
| P16 | URLs | one URL line | 0 | `remote get-url --all` and `--push --all` print the same line without `pushurl`. With `pushurl`, the push line differs. | `win2.txt` Q2 | plan D4 read 9, D8 |
| P17 | combined | no stdout for the local steps | 0, 0, 0 | lease delete, then `update-ref --no-deref -d refs/heads/keep <oid>`, then `config --local --remove-section branch.keep`; both refs gone | `win2.txt` Q5 | plan D6 step 7, D7 |
| P18 | gone recovery | P9 form | 1, 2, 0 | the lease delete is stale; `ls-remote --exit-code` exits 2; `update-ref --no-deref -d refs/remotes/origin/gone1 <expect>` removes the stale ref | `win2.txt` Q6 | plan D8 |
| P19 | name with a slash | `-\t:refs/heads/a/b\t[deleted]` | 0 | `refs/remotes/origin/a/b` removed | `win2.txt` Q4 | T009 |
| P20 | WSL parity | same as Windows | same | `Ubuntu-26.04` Git 2.55.0 output equals the Windows output after path and object ID normalization, for every probe above | `wsl.txt`, `wsl2.txt` | plan D10, SC-010 |

- `\t` in the table stands for one TAB byte.
- Probe timing basis (plan D11): through Git Bash on the reference host, a push delete took 259 to 441 ms in 10 runs. Three review reads took 276 to 430 ms in 10 runs. In WSL: 16 to 18 ms and 11 to 15 ms. These times set no outcome.

## R3 Git source and documentation facts

Git source, tag `v2.55.0`:

- Source `transport.c:620-640` `print_ref_status`: porcelain prints `<flag>\t<from>:<to>\t<summary>[ (<msg>)]`, or `<flag>\t:<to>\t...` without a source ref.
- Source `transport.c:664-690` `print_ok_ref_status`: a deletion prints `-` and `[deleted]` with no source ref. The flag `-` prints only when `ref->deletion` is set.
- Source `transport.c:743`: `[rejected] (remote does not support deleting refs)` prints no source ref.
- Source `transport.c:773`: `[rejected] (stale info)` prints `ref->peer_ref`. `remote.c:1105-1110` `alloc_delete_ref` names that ref `(delete)`. So a stale lease line reads `(delete):<dst>` (P8, P9).
- Source `transport.c:788-796`: `[remote rejected]` and `[remote failure]` print no source ref for a deletion.
- Source `transport.c:574-616` `update_one_tracking_ref`: after a successful deletion, Git deletes the tracking ref of the fetch refspec mapping, with no old-value check.
- Source `builtin/receive-pack.c` `update`: `deny_deletes` refuses `refs/heads/` deletes with "deletion prohibited". The current branch or a worktree branch takes `deny_delete_current`.

Git documentation:

- Doc git-push(1) `--porcelain`: Git writes machine-readable output. Each ref status line is tab-separated and goes to stdout.
- Doc git-push(1) "OUTPUT": the flag `-` marks a successfully deleted ref. The flag `!` marks a ref that Git rejected or failed to push.
- Doc git-push(1) `--force-with-lease=<refname>:<expect>`: Git updates or deletes the named ref only when its current remote value equals `<expect>`.
- Doc git-ls-remote(1) `--exit-code`: Git exits with status 2 when no matching ref is found on the remote.
- Doc git-symbolic-ref(1) `-q`: Git gives no error message for a ref that is not symbolic, and exits with a non-zero status.
- Doc git-update-ref(1) `-d`: Git deletes the ref after it verifies that the ref still holds `<oldvalue>`.
- Doc git-rev-list(1) `--exclude=<glob>`: the patterns for `--remotes` do not start with `refs/remotes`.
- Minimum Git: Windows 2.55.0.windows.3 (`admission.ts:9`), WSL 2.55.0 (`wsl-route.ts:12`).

## R4 Decisions

- Decision: the delete is a 003 sync action, `delete-remote-branch`. Only the syncer has Pageant, the push remedies, the connect target, the `remote` policy, and the stall handling (plan D9).
- Decision: every delete passes `--force-with-lease=<dst>:<expect>`. Without it, Git deletes moved and absent branches (P2, P11). `pushArgs` throws for a delete without a lease.
- Decision: the parse matches the argv refspec `:<dst>` or the alias `(delete):<dst>` (R3 `transport.c:773`, `remote.c:1105-1110`). No other form decides.
- Decision: the default branch comes from the local `symbolic-ref -q`, not from `ls-remote --symref`. A review must not use the network (003 FR-041, SC-013).
- Decision: exit 1 of `symbolic-ref -q` refuses with `default-unknown` (user decision 2026-11-06, design Q5). No other fact names the default branch.
- Decision: the removed-commit count runs one `rev-list` over both tips in the combined form (P14).
- Decision: the remote delete runs before the local delete (plan D7).
- Decision (user, 2026-11-06, design Q1 option a): after a stale lease, the run checks the remote with `ls-remote --exit-code` only when the fetch URL equals the push URL (P16). Exit 2, or exit 0 with no exact `<dst>` line, means gone (P15). The removal binds the expect value (P18, R3 git-update-ref(1)).
- Decision: network, credential, and pre-push hook failures share one outcome. Git reports the three only through message text.
- Decision: the trust ask names the action `push`. The `sync` gate covers the local writes, because `approvalRequired.workbench` implies `approvalRequired.sync` (`trust.ts:1475-1476`).

## R5 Unverified assumptions

- U1 (resolved by T001, Probe and Doc): `push.useForceIfIncludes=true` in the owned global configuration does not change a lease delete with an explicit expect. An equal expect gives the P10 line and exit 0. A wrong expect gives the P8 line and exit 1. git-push(1) `--force-if-includes` calls this combination a no-op.
- U2 (unverified): `[rejected] (remote does not support deleting refs)` (`transport.c:743`) needs a server without the delete-refs capability. No probe caused it. T007 covers its `:<dst>` line form from the R3 source format. No real-server test exists, so this item stays an assumption.
- U3 (resolved by T001, Probe): a lease delete of `refs/heads/fëature-ж` gives `-	:refs/heads/fëature-ж	[deleted]` and exit 0. The status line holds the raw UTF-8 bytes, without quotes or escapes. The tracking ref goes. In a SHA-256 repository, a lease delete with a 64-digit expect gives the P10 line and exit 0. A wrong 64-digit expect gives the P8 line and exit 1.
- U4 (resolved by T005, Check): the generated Rust identifier of the new action is `A::DeleteRemoteBranch` (`StartedAction::DeleteRemoteBranch`). See R7 "Shell (T005)".
- U5 (unverified): fixtures L and M hold no remote-tracking refs, so M-D adds them. T020 checks the fixture shape.
- U6 (unverified): the native trust dialog returns the focus to the open in-app dialog (plan R8). T019 checks it through UIA.
- U7 (resolved by T004, Check): eight schema files change, see R7 "Contract schemas (T004)". The design plan expected six. The phase `sync-delete-local` also changes `progress` and `run-workbench-result`.
- U8 (resolved by T001, Probe): Git runs the pre-push hook when the lease rejects every ref. The hook wrote its log line. The push printed the P8 line and exited 1.
- A1 (assumption): 010 merges into `main` before any 011 code task starts. Every code task depends on it.

## R6 Budgets and the measurement method

- The budgets of spec SC-009a to SC-009e come from the design plan section C. The user accepted them on 2026-11-06, before any measured run.
- The method follows 001: the packaged build, warm, on the agreed hardware. The warm-up run counts for the every-run bound, never for the median (001 spec.md:95).
- Each cold run has a budget of 2 times the warm budget of its measure: the median budget, and the p95 budget for SC-009a.
- The records (CPU seconds, process-tree private bytes, WSL times) have no budget.

## R7 Results

### Probe rerun (T001)

- Date: 2026-11-06. Git for Windows 2.56.0.windows.2 (`Program Files\Git\cmd\git.exe`). Git 2.55.0 in `Ubuntu-26.04` (Ubuntu 26.04.1 LTS).
- Scripts: `probe.sh`, `probe2.sh`, and the new `probe3.sh` (control, U1, U3, U8), with one WSL wrapper. The doc sections of R3 are in `r3-sections.txt`. All files are in local scratch `f011-t001`.
- P1 to P20: every R2 row is confirmed. After path, object ID, and timing normalization, the new outputs equal the earlier outputs on both platforms. The Windows and WSL outputs equal each other for all three scripts (P20).
- Control: P10 with a wrong expect (the parent commit) printed `!	(delete):refs/heads/c1	[rejected] (stale info)` and exit 1. A changed status line made the comparison fail, so the comparison can show a difference.
- U1, U3, and U8: resolved, see R5.
- Doc text: git-update-ref(1) names the old value `<old-oid>`. git-symbolic-ref(1) `-q` names "a symbolic ref but a detached HEAD". The meaning of R3 does not change.
- The probe repositories were deleted on both sides after the run.

### Mockup review (T002)

- Date: 2026-11-06. The user approved the 14 boards and the eight open points as proposed.
- 1: the combined already-gone outcome states X23, then X26.
- 2: X14 names Fetch and `git remote set-head {remote} --auto`.
- 3: the local Delete button stays visible while the check-box review runs or refuses. It is disabled and focusable, with the reason under the check box.
- 4: new texts X28 (local delete step), X29 (details heading), and X30 (commit list name).
- 5: a cut status-bar line keeps its full text in a tooltip and in its accessible name.
- 6: the remote confirmation keeps the alert dialog, the warning icon, and X7. The local 004 dialog keeps its look.
- 7: the commit list shows up to `SYNC_LEASE_COMMITS` (100) commits, then X5.
- 8: in forced colors, the danger red goes. The button text and the title state the danger.

### Contract schemas (T004)

- Date: 2026-11-06. `bun run export:schemas --check` before the export named eight stale files. The export changed the same eight files.
- `mutation-request`: the started action `delete-remote-branch`.
- `renderer-envelope` and `service-envelope`: the payload `ReviewDeleteRemoteBranch`.
- `review-sync-result`: the action, the source `tracking-ref`, the plan field `local`, the four new sync reasons, the four workbench reasons, and `worktree`.
- `sync-result`: the action, the status `deleted`, `remoteGone`, and `localNotDeleted`.
- `progress`, `operation-result`, and `run-workbench-result`: the phase `sync-delete-local`.
- The phase `sync-delete-local` carries no counter. `update-ref` and `config` print no progress.

### Shell (T005)

- Date: 2026-11-06. `bun run export:schemas --check` reported current schema files. The scripts and logs are in local scratch `f011-wp3`.
- typify in `src-tauri/build.rs` generated `StartedAction::DeleteRemoteBranch` and `ProgressPhase::SyncDeleteLocal`.
- `close.rs`: `Mutation::DeleteRemoteBranch` is under `StartedKind::Sync`, with the close name X18. A `workbench` frame with this action names no mutation.
- `schema.rs`: `progress` lets `sync-delete-local` carry no counter, as `PHASE_COUNTERS` in `operations.ts` does.
- The started-action test list holds `delete-remote-branch`. The no-counter phase test holds `sync-delete-local`.
- Red: before the change, the close-name test, the started-action test, and the phase test failed.
- Control: without the sync mapping arm, the close-name test and the started-action test failed. The restored `close.rs` has the original SHA-256.
- Green: `cargo test --locked` gave 658 passed, 0 failed, and 16 ignored. The golden vector count stays 274 on Windows.
- T005 adds no vector. The 011 vectors use `renderer-envelope`, `review-sync-result`, and `sync-result`, and the shell reads none of them.

### Packaged and perf runs (T021)

Run 2 on 2026-11-07, packaged NSIS build, warm, in the foreground, alone, under the test gate and the full-run lock. Each case ran once, so no Kernel-Power 42 event repeated a case. The driver, the case logs, and the record draft are in local scratch `f011-pkg`.

- Build: commit `f15e91fc` on `011-code`, with no tracked changes. Installed `arbareto.exe` SHA-256 `828852892f9cbfbff0f0c82b67b9b896856ab87a91d3d4334c79ff1baedc74e5`. It equals the built exe after the NSIS marker patch (1 hit). The `APP` lines of all 15 cases name this hash, and the `ORIGIN` lines name the l4 files.
- OS: Windows 11 Pro 26H2, build 26300.9711. Git: 2.56.0.windows.2. Bun: 1.4.4. Text size: 100%. WSL: `Ubuntu-26.04` with Git 2.55.0.
- Control: a clone of `f15e91fc` gives the first focus to the danger button of `AlertConfirm` (`RevertConfirm.tsx`). Its installed SHA-256 is `1a4c97875fca1be7025960a9b0bc69cfb5c278a436d1f271325333539769e392`. The FR-006 Cancel focus case failed with exit 1, 0 pass, and 1 fail. Red line: `error: the DOM focus on Cancel did not happen within 10000 ms: "Delete remote branch"`.
- T019: 7 cases pass, 0 fail, and the text-size case skips 2 tests.
- FR-001, FR-006: X1 has its UIA name and ends group 2. Pass.
- FR-006: the remote dialog gives Cancel the first focus (UIA `HasKeyboardFocus`), has no default button, and Escape changes nothing. Pass.
- FR-010: the checked local Delete dialog gives Cancel the first focus. Pass.
- U6: after the trust ask for a pre-push hook, the focus returns to the check box "Also delete the remote branch origin/feature". Pass.
- SC-008, FR-016: Dark, Light, and forced colors keep named controls, visible focus, and texts at 4.5:1. Each danger button keeps a border in forced colors. Pass. Forced colors is the CDP `forced-colors` emulation, not a Windows contrast theme.
- FR-016: in Compact and Comfortable, the menu and both dialogs lie inside the window with no horizontal overflow. Pass.
- SC-008 at 150% and 225% text: 2 skips, because the OS text size is 100%. These two cases stay unverified, as for feature 010.
- US1, US2: one remote delete and one combined delete by keyboard through a local bare remote. The Git listings confirm both. Pass.
- The focus cases prove the provider focus, which is the DOM focus source. The system focus stays unverified, because Windows Terminal owned the foreground.
- Fixtures: M (5,000 commits, 32 refs, 10,000 files, commit graph) and M-D (88 remote-tracking refs, 87 remote heads, 150 commits that only `d01` holds). Both came from the perf fixture cache.

| Measure | Median (budget) | Every-run max (budget) | Cold (budget) |
|---|---|---|---|
| SC-009a menu paint, 40 opens | p95 12.8 ms (100 ms); every open 9.9 to 14.9 ms | 14.9 ms (500 ms) | 25.3 ms (200 ms) |
| SC-009b remote (X1) | 245.9 ms (500 ms) | 391.6 ms (1 s) | 271.2 ms (1 s) |
| SC-009b combined (X9 click) | 295.1 ms (500 ms) | 430.6 ms (1 s) | - |
| SC-009c remote only | 866 ms (1.5 s) | 966.1 ms (3 s) | 753.7 ms (3 s) |
| SC-009d combined | 926.1 ms (2 s) | 1,913 ms (4 s) | 1,493.2 ms (4 s) |

- Every T020 budget passes. The test measures one cold run per measure SC-009a to SC-009d. SC-009b measures its cold run on the remote form.
- SC-009e: each SC-009c run has 77 to 116 history-filter inputs, and each SC-009d run has 88 to 231. Input p95 is at most 24 ms, and max is at most 32 ms (001 SC-005: p95 100 ms, every input 500 ms).
- Records, no budget: CPU 0.281 s to 10.5 s per run, and process-tree private bytes 676 MB to 957 MB (88 runs of SC-009b to SC-009d, Windows and WSL).

WSL records in `Ubuntu-26.04`, no budget (spec clarification). The repository shape hashes in the distro equal the Windows hashes for `for-each-ref` and `status --porcelain=v2`.

| Record | Median | Every-run max | Cold |
|---|---|---|---|
| SC-009b WSL remote | 1,847.5 ms | 1,971.5 ms | 1,699.4 ms |
| SC-009b WSL combined | 2,173 ms | 2,264.3 ms | - |
| SC-009c WSL remote only | 3,670.6 ms | 3,789.6 ms | 3,640 ms |
| SC-009d WSL combined | 4,632.6 ms | 4,870 ms | 4,962.1 ms |

- SC-009e in WSL: 324 to 384 inputs per SC-009c run and 434 to 490 per SC-009d run. Input p95 is at most 24 ms, and max is at most 40 ms.

Run 1 at `6b97a4c2`, on the same host and tools, gave the "before" values. Its control also turned red. Three cases failed:

- SC-008, FR-016 themes: a test defect. The checked dialog focus check did not press Tab after the UIA toggle. Fixed in `f15e91fc`.
- FR-016 densities: a test defect. The density check did not wait for the checked item and the unmounted menu. Fixed in `f15e91fc`.
- SC-009b combined: median 995.9 ms (500 ms) and every-run max 1,388.9 ms (1 s). The review ran 19 Git processes in series. Fixed in `5dad4994`: the independent reads start together. Run 2 gives 295.1 ms; the remote form went from 472.8 ms to 245.9 ms.

### Requirement-to-test map (T022)

Review 2026-11-07 by the reviewer on `f15e91fc`. The map below adds the later fixes and tests up to `b2006241`. Test files are in `tests/git/`, `tests/contracts/`, `tests/wsl/`, and `tests/windows/`.

| ID | Test file and case | Coverage |
|---|---|---|
| FR-001 | `remote-delete.test.tsx` X1 menu cases, History remote label, Del starts the review, "during a merge, X1 in the menu stays focusable, is aria-disabled, states the blocked reason…"; `remote-delete-packaged.test.ts` "FR-001, FR-006: X1 ends group 2…" (t1 pass) | yes |
| FR-002 | `remote-delete.test.ts` "SC-001…", "D4 read 10…"; `remote-delete-local.test.ts` "§5 deadline first…" (reads 2 and 3, read 10); `remote-delete-contract.test.ts` "contract Δ3 plan" (4); `sync-commands.test.ts` "no review read contacts a remote" | yes |
| FR-003 | `remote-delete.test.ts` "D4 read 3…"; `remote-delete.test.tsx` "X15 no-remote-branch gives its text" | yes |
| FR-004 | `remote-delete.test.ts` "SC-003…"; `remote-delete-local.test.ts` "D4 order: read 6 default-branch wins…"; `remote-delete.test.tsx` X13/X14, "Del with the refusal X13 shows it in the refusal slot…", "a later delete clears the old refusal…"; `sync-parsers.test.ts` "parseSymref…"; `remote-delete-wsl.test.ts` "T018 SC-003…" | yes |
| FR-005 | `remote-delete.test.ts` refusals before any network process; `remote-delete-local.test.ts` "D4 order: … config-in-include wins over the earlier-read push-urls"; `sync-parsers.test.ts` "push URLs (O-11)" (5); `remote-delete.test.tsx` "X17 UNKNOWN_TARGET…", Del during a merge | yes |
| FR-006 | `remote-delete.test.tsx` "remote confirmation (plan D2, FR-006, SC-008)" (9, with "a count above 999 groups its digits…"); `remote-delete.test.ts` "D4 read 10…"; `remote-delete-packaged.test.ts` "FR-006: the remote dialog gives Cancel…" (t2 pass, control c1 red) | yes |
| FR-007 | `sync-commands.test.ts` lease cases; `remote-delete.test.ts` "SC-002…"; `remote-delete-contract.test.ts` invalid vectors; `remote-delete-wsl.test.ts` "T018 SC-002…" | yes |
| FR-008 | `sync-parsers.test.ts` "remote branch delete porcelain (feature 011)"; `remote-delete.test.ts` "P3 to P6…", "P7…", "FR-008: a credential helper that exits non-zero gives GIT_FAILED with status none and the terminal remedy…"; `remote-delete-local.test.ts` "D7: a network failure…" (asserts STEP_REMEDY); `remote-delete.test.tsx` "remote only: a failed push gives E3" | yes |
| FR-009 | `remote-delete.test.ts` "SC-001: …" (branch `keep` keeps `branch.keep.remote` and `.merge`; config bytes equal); `remote-delete-wsl.test.ts` "T018 SC-001…" | yes |
| FR-010 | `workbench-branches.test.tsx` "local Delete with the remote check box (feature 011 plan D3)" (6); `remote-delete.test.tsx` "local dialog marks" (2); `remote-delete-packaged.test.ts` "FR-010: the local Delete dialog…" (t3 pass) | yes |
| FR-011 | `remote-delete-local.test.ts` SC-004 and D7 cases, D4 order, STALE_REVIEW, not-upstream, "§5 deadline first…" (reads 5 to 9, read 7, `deleteFacts`, the 004 delete-branch review); `remote-delete-gone.test.ts` "D7: the combined form…"; `remote-delete.test.tsx` combined cases | yes |
| FR-012 | `remote-delete-gone.test.ts` P18, D8, P16, P15, hook case; `remote-delete.test.ts` "P9 and P16…"; `sync-commands.test.ts` "gone check"; `sync-parsers.test.ts` parseLsRemote, P15; `remote-delete.test.tsx` X23; `remote-delete-wsl.test.ts` "T018 plan.md D8…" | yes |
| FR-013 | `remote-delete.test.ts` "Δ8: Cancel…"; `remote-delete-local.test.ts` "D7: Cancel…"; `remote-delete.test.tsx` E4, E4 + X25; `remote-delete-wsl.test.ts` "T018 SC-010…" | yes |
| FR-014 | `sync-trust.test.ts` "011 SC-007…"; `remote-delete.test.ts` trust required, P7; `trust-classes.test.ts` (2); `remote-delete.test.tsx` trust ask names push; `remote-delete-packaged.test.ts` "U6: with a pre-push hook…" (t4 pass) | yes |
| FR-015 | `remote-delete-wsl.test.ts` all 6 T018 cases (6/0, control red) | yes |
| FR-016 | `remote-delete.test.tsx` X2 to X30, E2 to E4, wrap, tooltip; `workbench-branches.test.tsx` X9 to X12; cargo `close.rs`, `schema.rs` (28/0); `remote-delete-packaged.test.ts` t5 themes, t6 densities pass; t7 text size skipped | yes, with the text-size skip accepted (010 precedent) |
| SC-001 | `remote-delete.test.ts` "SC-001…"; `remote-delete-wsl.test.ts` "T018 SC-001…" | yes |
| SC-002 | `remote-delete.test.ts` "SC-002…", "P9 and P16…"; `remote-delete-gone.test.ts` "D8: a moved remote branch…"; `remote-delete-wsl.test.ts` "T018 SC-002…" | yes |
| SC-003 | `remote-delete.test.ts` "SC-003…"; `remote-delete-wsl.test.ts` "T018 SC-003…" | yes |
| SC-004 | `remote-delete-local.test.ts` SC-004, D6 step 7, D7, P14; `remote-delete-gone.test.ts` combined; `remote-delete-wsl.test.ts` "T018 SC-004…" | yes |
| SC-005 | `sync-credentials.test.ts` "011 SC-005…"; `remote-delete.test.ts` "FR-008: a credential helper…" | yes |
| SC-006 | config bytes compared as a Buffer in `remote-delete.test.ts`, `remote-delete-local.test.ts`, `remote-delete-wsl.test.ts` (harness `stateOf` uses `rev-parse --path-format=absolute --git-path config`) | yes |
| SC-007 | `sync-trust.test.ts` "011 SC-007…"; `remote-delete.test.ts` trust cases; `remote-delete-packaged.test.ts` "U6…" (t4 pass) | yes |
| SC-008 | `remote-delete-packaged.test.ts` t2, t3, t5, t6, t8 pass (t5 forced colors through the CDP emulation, not a Windows contrast theme); contract focus cases; t7 text size skipped (machine at 100 %) | yes, with the text-size skip accepted (010 precedent) |
| SC-009a | `remote-delete-perf.test.ts` "SC-009a, U5…" (r1 pass) | yes |
| SC-009b | `remote-delete-perf.test.ts` "SC-009b…" (r2 pass, combined median 295.1 ms); `remote-delete.test.ts` "SC-009b: the combined review starts the worktree list before read 5 ends…"; WSL record w1 | yes |
| SC-009c | `remote-delete-perf.test.ts` "SC-009c, SC-009e…" (r3 pass); WSL record w2 | yes |
| SC-009d | `remote-delete-perf.test.ts` "SC-009d, SC-009e…" (r4 pass); WSL record w3 | yes |
| SC-009e | inside the r3 and r4 cases (pass) | yes |
| SC-010 | `remote-delete-wsl.test.ts` "T018 SC-001…", "T018 SC-004…", "T018 SC-010…" | yes |
| SC-011 | `remote-delete.test.tsx` "refusals (plan D4, FR-004, SC-011)"; `remote-delete-local.test.ts` "§5 deadline first…" (the deadline decides, not the exit of the closed sibling); T022 review of `observeRemoteDelete`, `localOf`, `deleteFacts`, `commitsOf`, `observeSync`, `runDelete`, `parsePushPorcelain`, `deleteOutcome` at `f15e91fc` | yes |

- Coverage marks: the map gives test coverage. The pass or fail result of a budget is in R7 "Packaged and perf runs (T021)", run 2.
- Totals: 31 IDs (16 FR, 15 SC). 29 are yes, 2 are yes with the accepted text-size skip, and 0 have no test. SC-011 passes.
- The "§5 deadline first" case follows 001 contract §5 "Deadline outcomes". It covers seven parallel read waves of the remote, the combined, and the 004 delete-branch reviews. It is new in `b2006241`.
- Control: the reviewer removed FR-009 from the map. The coverage check then printed "missing FR-009".

Review findings and outcomes:

- 0 CRITICAL and 0 HIGH findings.
- M1: in a parallel review wave, a read at its deadline did not decide first. Fixed by `b2006241`.
- L1: each parallel review wave now waits for all its reads. Fixed by `b2006241`.
- L2: the dialogs printed counts above 999 without digit groups. Fixed by `b2006241` for the remote confirmation, and by the feature close fix for the force-push count "It removes {n} commits".
- L3: accepted. A cut commit subject keeps its full text in the DOM and in the accessible name. A focusable row would add Tab stops to the list.
- Evidence: the T021 run 2 results above (build `f15e91fc`) and the T018 WSL run at `e609153c` (6 pass, 0 fail, control red).
