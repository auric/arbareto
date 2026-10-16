# Research: Windows Desktop Qualification

**Date**: 2026-09-28 | **Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

**Evidence level**: Source inspection and read-only host inventory. It also includes Git-behavior probes in throwaway repositories (R2, R4, R5, R13, R14). A Rust link probe ran outside the repository (R6). No application build, installer test, mutation test, or performance measurement has run.

## R1. Scope decision

**Decision**: Keep Tauri-only implementation. Compare Electrobun through source research only.

**Rationale**: The initial two-adapter request conflicted with constitution 1.0.0 and the selected specification. The user selected “Keep Tauri-only implementation” after the scope question.

**Alternatives considered**: A bounded constitutional amendment, or stopping with a feature-only blocked plan. Neither was selected.

One React frontend, one Bun Git service, and shared contracts remain planned. Only one thin Tauri shell is authorized. No generic desktop abstraction, Electrobun prototype, or second product is authorized.

The brief supplies hypotheses, not qualification evidence. Release assets establish distribution artifacts, not working Arbareto behavior. Source inspection establishes implementation facts, not packaged correctness or speed.

## R2. Git baseline, parsing, and identity

**Decision**: Use the explicitly selected installed Git for Windows executable. The initial qualification candidate is `2.55.0.windows.3`.

**Rationale**: The installed executable reports build revision `52ca1113d651127f89477a8763f86ab20f645e1d`. Its exact source supports the inspected protocols.

**Alternatives considered**: Bundled Git, libgit2, and a custom Git implementation. They add distribution or semantic differences without a qualification requirement. "Git engine decision" below compares in-process libraries and records the user decisions of 2026-10-04.

The observed executable is `C:/Git/cmd/git.exe`. This machine observation is not a fixed path requirement. Git is GPL-2.0 licensed and is not redistributed by this feature.

### Git engine decision

**Decision (user, 2026-10-04)**: The Git CLI is the only Git engine. The user rejected git2-rs, because libgit2 runs no hooks.

**Decision (user, 2026-10-04)**: Git logic stays in TypeScript in the Bun service. The user stated: "I want almost all possible logic to be in TypeScript".

**Rationale**: Option A keeps Constitution I, Constitution II, and the Architecture Constraints unchanged. No committed work becomes obsolete.

Option comparison, 2026-10-04:

| Option | Verdict | Reason |
| --- | --- | --- |
| A. Git CLI, logic in the Bun service | Selected | The user prefers it. It keeps Constitution I (hooks, selected Git) and Constitution II (TypeScript and Bun by default). No committed work becomes obsolete. |
| B. Git CLI, logic in the Rust shell | Rejected (user) | It breaks Constitution II and the thin-shell Architecture Constraint. It needs a MAJOR amendment. It deletes `src/git-service` (1,606 lines), `service.rs`, `framing.rs`, and `env_sanitize.rs`. It also deletes the Bun half of the contract §6 channel and most of `tests/contracts` (4,193 lines). |
| C. git2-rs for all work | Rejected (user) | libgit2 runs no hooks (DeepWiki answer on libgit2, 2026-10-04). So it breaks Constitution I: "Operations MUST NOT bypass Git hooks." |
| D. gix for all work | Rejected | gix 0.88.0 (2026-09-25) runs no hooks. It has no reftable and no promisor support (gitoxide `crate-status.md` on main, read 2026-10-04). Its status can start external filter drivers. That conflicts with the contract §7 read gate. |
| E. Git CLI plus an in-process read library | Fallback only | It needs an amendment of Constitution I ("use the selected Git executable"). It also needs a new contract §7 clause. Only history could move. Diffs must equal the `git add -p` hunks (contract §4), and status runs filters. Under TypeScript first, the library would be a Node-API addon. Bun marks `bun:ffi` experimental (bun.com/docs/runtime/ffi, read 2026-10-04). |

Capabilities, 2026-10-04. Only option E uses this table.

| Capability | Git CLI 2.56 | libgit2 1.9.7 / git2 0.21.0 | gix 0.88.0 | isomorphic-git 1.43.0 |
| --- | --- | --- | --- | --- |
| Hooks | Yes | Missing | Missing | Missing |
| External clean and process filters | Yes, behind the contract §7 gate | Missing; built-in and registered filters only | Yes; status can start drivers | Missing |
| Reftable | Yes | On main since 2026-05-06 (PR #7117), not in 1.9.x | Missing | Missing |
| SHA-256 | Yes | Partial (`EXPERIMENTAL_SHA256`) | Partial | Missing |
| Missing objects (partial clone) | Error with `--no-lazy-fetch` | Error, no lazy fetch | Error | Error |
| Commit-graph in the revision walk | Yes | Yes, since 1.2 | Yes | Missing |
| Patches that `git apply` accepts | Yes | xdiff; parity unverified | Missing | Missing |
| Licence | GPL-2.0, not shipped | GPLv2 with linking exception | MIT or Apache-2.0 | MIT |

WSL work still needs the distro Git CLI (contract §11). R13 recorded status through the UNC path at 379 ms, against 165 ms with Linux Git. isomorphic-git also fails F08, F18, and sparse checkouts (isomorphic-git issue #1735). So no pure-TypeScript reader is planned.

Client survey, 2026-10-04:

- Git Extensions: the Git CLI. It runs `git log -z` with `--author-date-order` or `--topo-order`, by its `RevisionSortOrder` setting. It shows rows while `git log` runs.
- GitHub Desktop: dugite, a bundled Git CLI.
- lazygit: the Git CLI only.
- Zed: the Git CLI only since PR #53453 (zed-industries/zed), merged 2026-06-02. That PR removed libgit2. It cited reftable and about 30,000 lines of vendored C.
- GitButler: gix 0.87.1 and a forked git2 0.21.0. `git2-hooks` 0.7.0 runs hooks outside Git. Fetch and push use the Git CLI.
- Sublime Merge: a custom reading library, and "Real Git" for commands.
- Fork and Tower: unverified.

Engine sources: DeepWiki answer on libgit2 (2026-10-04), gitoxide `crate-status.md` on main (read 2026-10-04), libgit2 PR #7117, zed-industries/zed PR #53453, isomorphic-git issue #1735, and bun.com/docs/runtime/ffi (read 2026-10-04). These sources have no pinned revision. The other client facts are research notes of 2026-10-04 without a pinned source. Do not use them for a product claim before T180 confirms the Git Extensions facts.

### Machine-readable reads

- Use `status --porcelain=v2 -z --branch --untracked-files=all` with `--no-optional-locks`, `--ignore-submodules=dirty`, and explicit rename detection.
- Parse NUL-delimited bytes. Handle ordinary, rename, unmerged, untracked, and ignored record forms.
- Read fixed fields before pathname bytes. Rename records contain destination and original paths as separate records.
- Preserve both index and worktree status. Do not merge staged deletion and untracked replacement into one entry.
- Treat incomplete records, overflow, and process failure as incomplete results, never empty success.
- Anchor history to a captured full commit OID. Use `rev-list --parents --max-count=100 --date-order` without path filters.
- Use Git's effective parent relationships and child-before-parent order. Never parse ASCII graph artwork or infer branches from dates.
- Apply `--no-lazy-fetch` to every Git command, and `--no-optional-locks` to every read (R5 partial-clone probe). Missing objects do not authorize network access. The two version probes are the exception, because Git before 2.45.0 rejects the option (contract §7 "Missing objects").
- Read commit objects through `cat-file --batch-command -Z`, using object type and byte length framing.
- Uppercase `-Z` terminates input and output. Lowercase `-z` is not an equivalent output protocol.
- Bound commit objects before reading their content. Render author and subject text without interpreting markup.

**T282 record (2026-10-05)**: T086 keeps one `cat-file --batch-command -Z` process per read. The pack-handle risk did not occur: `repack -a -d` beside an open `cat-file` exited 0 and removed the old pack files. So the T282 condition holds. But a persistent process does not fit contract §6 and §5 (below). It needs a contract change first. It saves 20 to 25 ms and one Git process per history page.

The probe `tests/git/probe-cat-file.ts` ran Git `2.56.0.windows.1` (`C:/Git/ucrt64/bin/git.exe`, the Git that `tests/git/git-binary.ts` selects) on Windows 10.0.26200 (NTFS). This is not the R2 candidate `2.55.0.windows.3`. It used two copies of the maintained M (T164, commit-graph variant) under the owned fixture root. Before `repack`, `count-objects -v` gave one pack (`.idx` and `.pack`) with 39,884 objects, and 11 loose objects from the staged files. Every Git call ran under `LC_ALL=C` with the owned fixture environment. `cat-file` and `rev-list` used the T076 builders, so they passed `--no-lazy-fetch` and `--no-optional-locks`.

Pages: the probe read 30 consecutive history pages of 100 rows. Each page used the T076 `rev-list` form. The next page started at the first parent of the last row. Each page then read its 100 commits with `contents <oid>` commands. The per-read method started one `cat-file` for each page and closed its stdin. The persistent method kept one `cat-file` open for all 30 pages and read exactly 100 frames per page. The methods alternated their order on each page.

Control: both methods gave byte-equal frames on 30 of 30 pages, with no `missing` frame. No page commit was a loose object.

| Method | Git processes per page | Informal median per page (30 pages, range of 3 runs) |
| --- | --- | --- |
| Per read | 2 (`rev-list`, `cat-file`) | `rev-list` 25.1 to 30.7 ms, `cat-file` 21.8 to 26.1 ms |
| Persistent | 1 (`rev-list`), plus 1 `cat-file` per workspace | `rev-list` 25.1 to 30.7 ms, `cat-file` 1.2 to 1.4 ms. The first page, spawn included, took 12.5 to 13.5 ms. |

Repack arms: each copy got a new persistent `cat-file` with `GIT_TRACE_PACK_ACCESS`. Each process read 200 commits (the first and the last page). The trace showed 200 reads from the old pack in each copy. In copy A, the process stayed open. In copy B, the process exited with 0 before `repack`. Then `repack -a -d` ran in each copy with stdin closed.

| Process during `repack -a -d` | Exit | Stderr | Old pack files kept | New pack files |
| --- | --- | --- | --- | --- |
| Open, with the old pack read | 0 | empty | 0 of 2 | `.idx`, `.pack`, `.rev` |
| Closed (control) | 0 | empty | 0 of 2 | `.idx`, `.pack`, `.rev` |

- Each `repack` took 0.7 to 1.4 s. After it, `count-objects -v` gave 0 loose objects, 1 pack with 39,895 objects, and 0 garbage in both copies.
- The open process still read objects after `repack`. It gave the 200 commits byte-equal to its reads before `repack`. The trace showed that these reads used the old, removed pack. It also read the formerly loose blob from the new pack.
- A new `cat-file` after `repack` gave the same bytes in both copies.
- So an open `cat-file` did not block `repack -a -d` and did not make it fail. The control gives the same outcome without the open process.
- Limits: one host and one Git build. The probe did not run `gc`, a second concurrent writer, or another file system. Linux and macOS are not verified.

Contract fit of a persistent process:

- Contract §6 gives each operation its own Job. A read Job closes when the read ends, and read Jobs never linger. A persistent `cat-file` outlives the read that started it. So it can live in no operation Job, and keeping the read Job open breaks the read Job rule.
- Contract §5 gives every Git process a deadline, and a read has 30 seconds. A persistent process lives for the workspace, so the 30-second process deadline cannot apply to it.
- One process reads one command stream. Contract §5 allows 2 concurrent reads per workspace, so two history reads would have to share or wait for it.
- A contract change would need a workspace Job that closes at workspace release, at Revoke trust, and at application close. It would also need a deadline for each page and a new process after a failure or a deadline.
- The saving is one process and 20 to 25 ms per page. T192 measures the full process count of `readHistory` (plan.md "Git processes per read").
- This probe is not qualification evidence, and no Arbareto build ran.

**T081 record (2026-10-05, win32 Git 2.56.0.windows.1)**: `tests/git/snapshot.test.ts` reports which Git output detects each index flag. Each line is an `OBSERVATION`.

- Intent-to-add: `status --porcelain=v2 -z` shows it as the ordinary record `1 .A`, with `mH` and `mI` `000000`.
- Assume-unchanged: `ls-files -z -v` shows it as a lowercase tag: `h`, or `s` together with skip-worktree.
- Skip-worktree: `ls-files -z -v` shows it as the tag `S`, or `s` together with assume-unchanged.
- `ls-files -v` gives an intent-to-add entry the plain tag `H`. So `ls-files -v` alone cannot detect intent-to-add.
- The Linux run is pending.

Sources: [status format and optional locks](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-status.adoc), [cat-file framing](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-cat-file.adoc#L143-L175), [NUL options](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-cat-file.adoc#L266-L275).

### Repository identity

Resolve the working root, worktree Git directory, common directory, actual index, and operation markers through Git.

Use `--show-toplevel`, `--absolute-git-dir`, `--git-common-dir`, and `--git-path index`. Request absolute paths where supported.

**Decision**: Discovery never runs `rev-parse --shared-index-path`. That option calls `repo_read_index` (rev-parse.c:1097-1106). An index load can run a command-valued `core.fsmonitor`, and `restoreWorkspace` runs discovery at launch before trust approval. The service derives split-index state from the raw index bytes instead. The `link` extension holds the shared-index hash, and the file is `$GIT_DIR/sharedindex.<hash>` (gitformat-index.adoc:249-261). `read_index_from` builds that path from the worktree Git directory (read-cache.c:2384).

A Git-behavior probe on 2026-09-30 used Git `2.55.0.windows.3` in a throwaway repository. It used an owned global configuration and `GIT_CONFIG_NOSYSTEM=1`. Local canaries covered command-valued `core.fsmonitor` and clean, smudge, and process filters on a stat-dirty file. They also covered `diff.<driver>.textconv`, `core.pager`, `core.editor`, `core.askPass`, `core.sshCommand`, and `credential.helper`. They also covered the four signing keys, one configured hook, and 28 traditional hook names. No canary ran for these `rev-parse` queries: `--is-bare-repository --is-inside-git-dir`, `--show-toplevel`, `--absolute-git-dir`, and `--git-common-dir`. The same held for `--git-path index`, `--show-object-format`, `--show-ref-format`, and `--git-path hooks`. No canary ran for `symbolic-ref -q HEAD` or `show-ref --head --verify HEAD`. None ran for `config list --show-scope --show-origin -z` or `hook list -z --show-scope`. `rev-parse --shared-index-path` ran the monitor canary twice, also with `--no-optional-locks`. `ls-files -z` did the same.

A second probe ran `update-index --split-index` in a repository and in its linked worktree. Each index then held a `link` extension. Its hash named `sharedindex.<hash>` in the Git directory of that worktree. That path equals the `--shared-index-path` output. These probes are not qualification evidence, and no Arbareto build ran.

Split-index sources: [rev-parse index load](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/rev-parse.c#L1097-L1106), [link extension](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/gitformat-index.adoc#L249-L261), [shared index path](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/read-cache.c#L2384).

Use `--is-bare-repository` and `--is-inside-git-dir` before registration. Either true result refuses the folder with `UNSUPPORTED_REPOSITORY`.

A folder outside every repository fails that first query. Discovery stops at the file system root or at a mount point. Then `setup.c` dies with one of two messages (setup.c:2004-2015). The first is "not a git repository (or any of the parent directories)". The second is "not a git repository (or any parent up to mount point". `die` prints the prefix `fatal: ` and exits with status 128 (usage.c:74, :87). A `.git` file with a missing target dies with "not a git repository: <path>" instead (setup.c:940). So the prefix `fatal: not a git repository (or any` under the fixed C locale separates `NOT_A_REPOSITORY` from the missing-target case, which stays `REPOSITORY_UNAVAILABLE`. No probe ran this case; T068 verifies it. This prefix rule and the dubious-ownership prefix are heuristics under CLAUDE.md "No heuristics". R5 "Heuristics review (2026-10-05)" lists their replacement as open.

**T283 record (2026-10-04)**: T076 must not build the full combined discovery `rev-parse` form. T076 and T082 may build the two-call form below instead of the separate profiles. The two-call form saves five Git processes in each success case and none in a refusal case.

The probe `tests/git/probe-discovery.ts` ran Git `2.56.0.windows.1` (`C:/Git/ucrt64/bin/git.exe`, the Git that `tests/git/git-binary.ts` selects). This is not the R2 candidate `2.55.0.windows.3`. Each call passed `--no-lazy-fetch` and ran under `LC_ALL=C` with the owned fixture environment. The separate form is seven calls in the T082 order: `--is-bare-repository --is-inside-git-dir`, then one call each for `--show-toplevel`, `--absolute-git-dir`, `--git-common-dir`, `--git-path index`, `--show-object-format`, and `--show-ref-format`. The combined form is one `rev-parse` call with these eight options in the same order. `symbolic-ref` and `show-ref` are separate commands, and the combined form does not replace them.

Each repository got local canaries before the probe: command-valued `core.fsmonitor`, `filter.<driver>.clean`, `.smudge`, and `.process`, and `diff.<driver>.textconv`. It also got `gpg.program`, `gpg.openpgp.program`, `gpg.x509.program`, `gpg.ssh.program`, and `gpg.ssh.defaultKeyCommand`. It also got one configured hook and the 28 traditional hook names. `info/attributes` assigned the filter and diff drivers, and every tracked file was stat-dirty. The canaries were in the common directory, so the linked worktrees and the administration folder used them too. The submodule got its own canaries.

Control: in the ordinary repository, the same canaries ran for commands that must run them. `status` ran `fsmonitor`, `filter-clean`, and the `post-index-change` hook. `rev-parse --shared-index-path` ran `fsmonitor`. `show --textconv HEAD` ran `filter-smudge` and `textconv`. `hook run pre-commit` ran the configured hook and the `pre-commit` hook. `hash-object --stdin --path=control.md` ran `filter-process`, and `tag -s` ran `gpg-openpgp-program`.

| Case | Separate exits | Combined exit | Output | Stderr | Separate class | Combined class | Separate canaries | Combined canaries |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ordinary (F07 main) | 0 | 0 | equal | equal | ok | ok | none | none |
| linked worktree (F07 wt-a) | 0 | 0 | equal | equal | ok | ok | none | none |
| separate Git directory (F07 separate) | 0 | 0 | equal | equal | ok | ok | none | none |
| bare (F07 bare.git) | 0/128 | 128 | differs | differs | UNSUPPORTED_REPOSITORY | REPOSITORY_UNAVAILABLE | none | none |
| administration folder (F07 main/.git) | 0/128 | 128 | differs | differs | UNSUPPORTED_REPOSITORY | REPOSITORY_UNAVAILABLE | none | none |
| submodule opened directly (F07 super/sub) | 0 | 0 | equal | equal | ok | ok | none | none |
| missing gitdir target (F07 broken) | 128 | 128 | equal | equal | REPOSITORY_UNAVAILABLE | REPOSITORY_UNAVAILABLE | none | none |
| SHA-256 (F08 sha256) | 0 | 0 | equal | equal | ok | ok | none | none |
| reftable (F18 reftable repo) | 0 | 0 | equal | equal | ok | ok | none | none |
| reftable linked worktree (F18 reftable wt) | 0 | 0 | equal | equal | ok | ok | none | none |
| plain folder (F15 plain) | 128 | 128 | equal | equal | NOT_A_REPOSITORY | NOT_A_REPOSITORY | none | none |
| removed path (F15) | spawn failed, ENOENT | spawn failed, ENOENT | equal | equal | REPOSITORY_UNAVAILABLE | REPOSITORY_UNAVAILABLE | none | none |
| F15 repo | 0 | 0 | equal | equal | ok | ok | none | none |
| dubious ownership (F15 repo, `GIT_TEST_ASSUME_DIFFERENT_OWNER=1`) | 128 | 128 | equal | equal | DUBIOUS_OWNERSHIP | DUBIOUS_OWNERSHIP | none | none |
| dubious ownership (the eight F15 hostile names, same knob) | 128 | 128 | equal | equal | DUBIOUS_OWNERSHIP | DUBIOUS_OWNERSHIP | none | none |

- "Output" compares the joined stdout of the separate calls with the combined stdout. "Separate exits" lists each distinct exit status of the seven calls. The class column applies contract §6 to the first separate call and to the combined call.
- Order: in every success case, the combined stdout holds one line per option in the option order. The lines equal the separate lines byte for byte.
- Bare and administration folder: the combined call prints `true` `true` (bare) or `false` `true` (administration folder) on stdout. Then `--show-toplevel` dies with `fatal: this operation must be run in a work tree` and exit status 128. The separate first call exits 0 with the same two lines, so it keeps `UNSUPPORTED_REPOSITORY`. Classification by exit status and stderr prefix gives `REPOSITORY_UNAVAILABLE` for the combined call. So the combined form loses the contract §6 refusal class.
- Other refusal cases fail in setup before any option runs. Both forms give the same exit status and the same stderr there.
- No form ran a canary in any case.
- Missing gitdir target: Git `2.56.0.windows.1` printed `fatal: gitfile does not point to a valid repository: <path>`, not `not a git repository: <path>`. The class stays `REPOSITORY_UNAVAILABLE`.
Two-call form: call 1 is the flags call `--is-bare-repository --is-inside-git-dir`. Call 2 runs only when call 1 exits 0 and gives no refusal under the T082 rules. Call 2 is one `rev-parse` with the six remaining options in the T082 order. Both calls pass `--no-lazy-fetch` and run under `LC_ALL=C`. The probe compares it with the separate form under the T082 rules: the later separate calls run only when the flags call gives no refusal.

| Case | Separate exits | Two-call exits | Output | Stderr | Separate class | Two-call class | Two-call canaries | Separate processes | Combined processes | Two-call processes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ordinary (F07 main) | 0 | 0 | equal | equal | ok | ok | none | 7 | 1 | 2 |
| linked worktree (F07 wt-a) | 0 | 0 | equal | equal | ok | ok | none | 7 | 1 | 2 |
| separate Git directory (F07 separate) | 0 | 0 | equal | equal | ok | ok | none | 7 | 1 | 2 |
| bare (F07 bare.git) | 0 | 0 | equal | equal | UNSUPPORTED_REPOSITORY | UNSUPPORTED_REPOSITORY | none | 1 | 1 | 1 |
| administration folder (F07 main/.git) | 0 | 0 | equal | equal | UNSUPPORTED_REPOSITORY | UNSUPPORTED_REPOSITORY | none | 1 | 1 | 1 |
| submodule opened directly (F07 super/sub) | 0 | 0 | equal | equal | ok | ok | none | 7 | 1 | 2 |
| missing gitdir target (F07 broken) | 128 | 128 | equal | equal | REPOSITORY_UNAVAILABLE | REPOSITORY_UNAVAILABLE | none | 1 | 1 | 1 |
| SHA-256 (F08 sha256) | 0 | 0 | equal | equal | ok | ok | none | 7 | 1 | 2 |
| reftable (F18 reftable repo) | 0 | 0 | equal | equal | ok | ok | none | 7 | 1 | 2 |
| reftable linked worktree (F18 reftable wt) | 0 | 0 | equal | equal | ok | ok | none | 7 | 1 | 2 |
| plain folder (F15 plain) | 128 | 128 | equal | equal | NOT_A_REPOSITORY | NOT_A_REPOSITORY | none | 1 | 1 | 1 |
| removed path (F15) | spawn failed, ENOENT | spawn failed, ENOENT | equal | equal | REPOSITORY_UNAVAILABLE | REPOSITORY_UNAVAILABLE | none | 0 | 0 | 0 |
| F15 repo | 0 | 0 | equal | equal | ok | ok | none | 7 | 1 | 2 |
| dubious ownership (F15 repo, `GIT_TEST_ASSUME_DIFFERENT_OWNER=1`) | 128 | 128 | equal | equal | DUBIOUS_OWNERSHIP | DUBIOUS_OWNERSHIP | none | 1 | 1 | 1 |
| dubious ownership (the eight F15 hostile names, same knob) | 128 | 128 | equal | equal | DUBIOUS_OWNERSHIP | DUBIOUS_OWNERSHIP | none | 1 | 1 | 1 |

- "Output" and "Stderr" compare the joined bytes of each form. The process columns count started Git processes. A spawn failure starts no process.
- In every success case, call 2 printed the six remaining lines byte for byte equal to the separate calls. Each refusal case kept its contract §6 class, because call 1 decides it and call 2 does not run.
- No two-call run ran a canary.
- Informal timings, not qualification evidence: the ordinary case (F07 main) gave these medians of 20 runs each. The separate form (7 processes) took 160.5 ms. The full combined form (1 process) took 25.8 ms. The two-call form (2 processes) took 42.9 ms.
- This probe is not qualification evidence, and no Arbareto build ran.

Refusal sources: [discovery refusal](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/setup.c#L2004-L2015), [gitfile refusal](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/setup.c#L940), [die prefix and status](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/usage.c#L74-L87).

Keep worktree identity separate from common-directory identity. Resolve physical directory identity after Git discovery. Windows junctions must not create separate mutation exclusion groups.

Record `--show-object-format` and `--show-ref-format`. Do not hardcode SHA-1 lengths or an empty-tree hash.

Record both HEAD's symbolic target and resolved OID. A same-OID branch change still invalidates checkout approval. Distinguish an unborn branch from a failed lookup.

**Decision**: The shell supplies every physical identity. It reads the 64-bit volume serial number and the 128-bit file ID through `GetFileInformationByHandleEx` with `FileIdInfo`. The service requests identities for Git-resolved paths through the contract §6 identity request.

Bun `fs.stat` calls libuv `uv_fs_stat`. On Windows 11 24H2 and later, libuv uses `GetFileInformationByName` with `FileStatBasicByNameInfo`. It sets `st_ino` from the 64-bit `FileId` and ignores `FileId128`. Older builds use `FileInternalInformation`, which also holds only the 64-bit ID. Both paths set `st_dev` from the low 32 bits of the volume serial number.

The 64-bit ID is not a safe identity. ReFS maps only a subset of 128-bit IDs to 64 bits and sets the others to −1. FAT, FAT32, and exFAT generate 64-bit IDs that are neither stable nor unique. The 128-bit ID is stable and unique on NTFS and ReFS. MS-FSCC reserves all zeros for "not supported" and all ones for "cannot be established".

Refusing the 64-bit sentinel alone would exclude Dev Drive repositories. It would still miss FAT and exFAT, because Bun cannot read the file system type. `bun:ffi` could read `FileIdInfo`, but Bun marks it experimental and not for production. Tests may use it as a test double.

A probe on 2026-09-29 used Bun `1.4.2` on the reference host (NTFS). `fs.stat` gave `dev` `0x74214650`, and `FileIdInfo` gave serial `0x4474215074214650`. The low 64 bits of the 128-bit ID equaled `ino`. A junction alias gave the same `FileIdInfo` identity as its target. No ReFS volume was available, so ReFS and Dev Drive stay unverified.

**T077 junction and ReFS record (2026-10-05)**: The T077 test ran the Windows shell double with real `FILE_ID_INFO` reads. Git came from `tests/git/git-binary.ts`. The F07 fixture root was on C: (NTFS, `volumeSerial` `4474215074214650`). Git ran in each junction alias. It resolved `--show-toplevel`, `--absolute-git-dir`, and `--git-common-dir` to the target paths, not the alias paths. The identity of the alias path equals the identity of its target. For `alias-main` and `main`, and for `alias-wt-a` and `wt-a`, all four identities are equal. So a junction alias gives equal identities (F07). The T068 junction case did not run, because `discovery.ts` and `registration.ts` do not exist yet. The T077 runner case is its direct equivalent. The host has no ReFS volume and no Dev Drive. C: and D: are NTFS, H: is a network share, and O: and P: are removable volumes (`PS4_FS`, `PS5_FS`). `fsutil fsinfo volumeinfo` needs elevation on C: and D:, so `System.IO.DriveInfo` gave the file system names. The ReFS case is `unverified`.

Identity sources: [Bun Windows stat](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/sys/lib.rs#L3694-L3695), [Bun uv_fs_stat call](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/sys/sys_uv.rs#L506-L509), [libuv volume serial](https://github.com/oven-sh/libuv/blob/8023581113b276e7c1aee3f82da57ca0893faab1/src/win/fs.c#L1806-L1827), [libuv st_dev](https://github.com/oven-sh/libuv/blob/8023581113b276e7c1aee3f82da57ca0893faab1/src/win/fs.c#L1871), [libuv st_ino](https://github.com/oven-sh/libuv/blob/8023581113b276e7c1aee3f82da57ca0893faab1/src/win/fs.c#L1934), [64-bit file ID on ReFS](https://learn.microsoft.com/windows/win32/api/fileapi/ns-fileapi-by_handle_file_information), [FILE_ID_INFO](https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-file_id_info), [MS-FSCC file ID behavior](https://learn.microsoft.com/openspecs/windows_protocols/ms-fscc/d4bc551b-7aaf-4b4f-ba0e-3a75e7c528f0), [libuv fast stat path](https://github.com/oven-sh/libuv/blob/8023581113b276e7c1aee3f82da57ca0893faab1/src/win/fs.c#L1729-L1765), [libuv slow stat path](https://github.com/oven-sh/libuv/blob/8023581113b276e7c1aee3f82da57ca0893faab1/src/win/fs.c#L1767-L1830), [FILE_STAT_BASIC_INFORMATION](https://learn.microsoft.com/windows-hardware/drivers/ddi/ntifs/ns-ntifs-file_stat_basic_information), [64-bit file ID sentinels](https://learn.microsoft.com/openspecs/windows_protocols/ms-fscc/2d3333fe-fc98-4a6f-98a2-4bb805aff407), [128-bit file ID sentinels](https://learn.microsoft.com/openspecs/windows_protocols/ms-fscc/98860416-1caf-4c80-a9ab-8d61e1ccf5a5), [bun:ffi status](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/docs/runtime/ffi.mdx).

Sources: [path and format discovery](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-rev-parse.adoc#L246-L335), [worktree sharing](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-worktree.adoc), [reference lookup results](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-show-ref.adoc#L75-L79), [unborn staged diff](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-diff.adoc#L45-L55).

## R3. Selected hunk design: protected index publication

**Decision**: Use a protected candidate index with exact verification and explicit validation checkpoints. The former B-HUNK design blocker is resolved by this supported profile, not by claiming repository-wide atomicity.

**Rationale**: Git applies the patch; the service verifies the exact candidate before canonical index publication. Supported operations do not write working-file content.

**Alternatives considered**: Renderer patches, whole-file staging as a hunk fallback, direct live-index patching, and three-way fallback. None provides the selected-hunk publication guarantee. Whole-file staging is a separate explicit action ("Whole-file staging" below).

### Supported profile

Support ordinary full indexes and the specified UTF-8 LF/CRLF text cases. Refuse sparse/split indexes until separately qualified. The raw `link` extension identifies a split index (R2). An effective `core.splitIndex=true` also refuses, because a candidate write then splits the candidate ("Whole-file staging" probe 9).

Refuse any registered `post-index-change` hook and any executable filesystem-monitor integration for hunk mutations. Refuse custom filters, LFS, encoding conversion, unsupported entry types, conflicts, unfinished operations, and incomplete observations.

The derived hook registrations (T280 record) include disabled configured registrations, as `git hook list` does. Initially refuse every `post-index-change` registration rather than infer an executable subset incorrectly. Ordinary commit hooks do not trigger this refusal unless they also register an index-change event.

Refusal does not bypass a hook or change configuration. Trust approval alone does not make an index-change hook safe for exact hunk publication.

`core.fsmonitor=true` enables Git's built-in daemon, not a repository-defined command. Reads run with it from any scope. Hunk actions refuse it as an unqualified monitor profile. When no daemon runs, a command that loads the index runs `git fsmonitor--daemon start`. That command starts `fsmonitor--daemon run --detach` as a background child. Git for Windows creates children without a breakaway flag. A child joins its parent's Job by default, and the Arbareto Jobs forbid breakaway. So the daemon is an owned descendant of the read's operation Job, and Job close ends it. A daemon that a commit starts stays in the commit's lingering Job until application close (R5). This is source reasoning. T153 checks it in the packaged build (unverified).

Monitor sources: [built-in daemon setting](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/config/core.adoc#L64-L66), [daemon spawn](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/fsmonitor-ipc.c#L58-L70), [spawn on missing daemon](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/fsmonitor-ipc.c#L111), [background start](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/fsmonitor--daemon.c#L1511-L1546), [Windows process creation flags](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/compat/mingw.c#L2247-L2270).

### Publication protocol

1. Capture the complete index, checkout identity, selected raw/normalized content, attributes, configuration, trust, and operation state.
2. Retain Git-generated canonical patch data in the service. Give the renderer opaque hunk identifiers only.
3. Enter application mutation exclusion for the resolved common directory.
4. Exclusively create the canonical index's Git-resolved lock. Refuse existing locks; retain ownership and file identity.
5. Revalidate the complete approval and supported profile while holding that lock.
6. Copy the index into an owned private index beside it. Set its last-write time 100 ns before the canonical index time ("Whole-file staging" probe 8). Create an absent empty candidate through Git without creating a canonical index.
7. Apply one service-selected hunk with `git apply --cached` and the private `GIT_INDEX_FILE`.
8. Reverse the selected HEAD-to-index hunk for unstaging. Never reconstruct working files from normalized text.
9. Verify the candidate against independently calculated selected-hunk bytes from captured line intervals, not another applicability test.
10. Verify exact selected entry existence, blob, mode, and stage. Verify every unrelated logical index entry, including its intent-to-add, assume-unchanged, and skip-worktree flags.
11. Recheck canonical index bytes, raw working content, checkout identity, attributes, configuration, trust, and operation markers.
12. Refuse publication on every detected mismatch or eligibility change.
13. Publish the verified candidate through the owned lock using one same-volume replacement.
14. Reconcile actual Git state and release only owned transaction resources before reporting the outcome.

The lock excludes cooperating canonical index writers. It does not freeze working files, configuration, hooks, or references.

Another tool's `git status` can rewrite the index with new stat data only. The raw digest then changes, and the hunk approval becomes invalid. The renderer then issues `readComparison` again and keeps a hunk whose canonical digest is unchanged (contract §8). Poll-time invalidation keeps the raw digest on purpose. Steps 5 and 11 compare raw canonical index bytes with the captured state (FR-014). A logical-entry check at poll time would only move the same `STALE_SELECTION` refusal to publication.

A change detected before publication prevents publication. An observed change afterward produces a changed-result outcome, preserving external bytes without automatic undo or retry.

Unexpected effects during candidate execution prevent publication and remain visible. Uncertain publication or reconciliation produces unknown state and blocks further mutations.

### Source constraints and qualification

- `--cached` avoids direct working-file writes. `--index` also targets working files and is unsuitable.
- Patch applicability and full-index headers do not prove complete blob identity. Git can relocate matching hunks.
- Preserve creation/deletion headers, absent entries, empty blobs, raw bytes, and Git-normalized content distinctly.
- Private-index writes invoke `post-index-change`; refusing that profile is part of the initial supported boundary.
- Configuration can change during execution. Revalidate eligibility and report observed effects; do not claim a security sandbox.
- Candidate application can create unreachable objects. Never remove those objects or run maintenance automatically after refusal.
- Preserve full logical index assertions and every working-file byte in ordinary fixtures.
- Concurrent fixtures verify external writers' resulting bytes separately from application publication.
- Windows replacement, cancellation, owned-lock cleanup, and crash behavior still require real packaged qualification.
- Any `working-tree-encoding` value other than `unspecified` gives reason `encoding`, also `UTF-8`. No source check confirms that Git skips that conversion, so hunk actions refuse it (contract §4).
- The installed build has no test barrier. T161 triggers the late write on the step 13 index replacement (T141 `--late-write`). So the write always follows step 11. Reconciliation can read the file before or after that write. T161 records the branch that ran. T097 covers the `completed-with-effects` branch in process. Whether Bun `fs.watch` on Windows reports the rename to `index` is unverified; T161 records it.

No mutation fixture has run. This is an implementable design with mandatory proof cases, not a runtime pass.

Additional sources: [hook registrations include disabled entries](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/hook.c#L72-L107), [index loading and fsmonitor](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/fsmonitor.c#L792-L811).

Sources: [lock protocol](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/lockfile.h#L5-L31), [Windows replacement behavior](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/compat/mingw.c#L3003-L3150), [apply modes](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-apply.adoc#L60-L95), [apply locking](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/apply.c#L4945-L4963), [hunk relocation](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/apply.c#L3138-L3202), [index-write hook](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/read-cache.c#L3149-L3160), [reference transactions](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-update-ref.adoc).

**T107 F15 record (2026-10-08).** Another process held the index with `FileShare.Read`. The replace failed at once with `EPERM` (Win32 `ERROR_ACCESS_DENIED` through libuv) in 4 to 7 ms, after one try. The index stayed byte-identical, the lock stayed owned, and `release` removed it. The outcome is `failed` with `GIT_FAILED`. The service does not retry. Git for Windows retries `ERROR_ACCESS_DENIED` and `ERROR_SHARING_VIOLATION` after 0, 1, 10, 20, and 40 ms, then fails without a terminal (`compat/mingw.c` `mingw_rename`, `retry_ask_yes_no`). This is a recorded difference.

### Whole-file staging

**Decision (2026-09-30)**: Add `applyFile` with a direction on the hunk candidate protocol (contract §4 "File staging"). The user chose Stage file and Unstage file for this slice. Git Extensions offers both for any file, including binary files.

**Rationale**: `update-index --add --remove` on the private candidate gives the index of `git add`. `update-index --index-info` with the HEAD entries gives the index of `git restore --staged`. Both keep the lock, candidate, checkpoint, and reconciliation rules above.

**Alternatives considered**: `git add`, `git restore --staged`, `git rm --cached`, and `git reset -- <path>` write the canonical index without a verified candidate. `reset` also ran the clean filter of another stat-dirty file (probe 1). `hash-object -w --stdin --path` plus `--index-info` would hash exactly the checked bytes. It loads no index, so its blob differed from `git add` in two cases (probe 5).

Git-behavior probes on 2026-09-30 used Git `2.55.0.windows.3` in throwaway repositories. Each command started with `--no-lazy-fetch`. `GIT_CONFIG_GLOBAL` named an owned file, and `GIT_CONFIG_NOSYSTEM=1` was set. These probes are not qualification evidence.

1. Canaries: a local clean filter, a command-valued `core.fsmonitor`, and a `post-index-change` hook. `hash-object --stdin --path` ran the clean filter only for a path with a `filter` attribute. It ran neither the monitor nor the hook. `update-index --index-info` on a private index ran the monitor and the hook. `ls-files` on that index ran the monitor, and `read-tree --empty` ran the hook. `add`, `update-index --add`, `restore --staged`, `rm --cached`, and `reset -q -- <path>` each ran the monitor and the hook. `reset` also ran the clean filter for another stat-dirty file, and `reset --no-refresh` did not. `add` ran the clean filter for a filtered path.
2. Oracle equality: the candidate form equaled `git add` for CRLF under `core.autocrlf=true`, `ident`, `working-tree-encoding=UTF-16LE-BOM`, `eol=crlf`, binary, and new files. It also equaled `git add` for a deleted file and for a tracked `100755` entry under `core.filemode=false`. It equaled `git add` for new files under `core.filemode=true` too. Without an index file, `read-tree --empty` and then the candidate form equaled `git add`. `--index-info` from porcelain v2 `mH` and `hH` equaled `git restore --staged` for modified, added, deleted, mode-change, and renamed entries. A rename restored the source and removed the destination. In an unborn repository, mode 0 equaled `git rm --cached`. Working bytes stayed unchanged.
3. `core.safecrlf=true` with `core.autocrlf=true` and a mixed file: `update-index --add`, `hash-object -w`, and `git add` each exited 128 with the same message. `hash-object` without `-w` exited 0, because Git applies safecrlf only when it writes an object (object-file.c `get_conv_flags`).
4. Partial clone: HEAD moved by `reset --soft` to a fetched commit whose blob the `blob:none` clone lacked. `update-index --index-info` restored that HEAD entry on a private index and exited 0. No uploadpack canary ran.
5. Index-dependent conversion: with a CRLF blob in the index under `core.autocrlf=true`, `git add` and the candidate form kept CRLF. `hash-object --stdin --path` converted it to LF. With an attribute file that only the index held, again only `hash-object` differed. Git's conversion checks the index blob for CR (convert.c `has_crlf_in_index`), and `hash-object` never loads the index.
6. Size: a 512 MiB incompressible file took 17.7 seconds through `hash-object -w --stdin` and 20.5 seconds through `git add` on the developer host. Git's peak working set was 547 MB for the first. Git reads a file up to `core.bigFileThreshold` into memory, and the default is 512 MiB (object-file.c `index_fd`).

A second probe series on 2026-09-30 used the same Git, setup, and rules. Its scripts live in the session scratch folder, not in the repository. These probes are not qualification evidence either.

7. Blob proofs: each case staged through the candidate form. Proof A compared `cat-file --filters --path=<p> <oid>` with the working bytes by SHA-256. Proof B compared `hash-object --stdin --path=<p>` of the working bytes with the staged object ID. The oracle was `git add` in a copy.

   | Case | Candidate equals `git add` | Proof A | Proof B |
   | --- | --- | --- | --- |
   | `core.autocrlf=true`, LF blob, CRLF working file | yes | pass | pass |
   | `core.autocrlf=true`, CRLF blob in the index | yes | pass | fail |
   | `eol=crlf` in an attribute file that only the index holds | yes | fail | fail |
   | `ident` in an attribute file that only the index holds | yes | pass | pass |
   | `core.autocrlf=true`, LF blob, mixed working file | yes | fail | pass |
   | `core.autocrlf=true`, CRLF blob, mixed working file | yes | pass | fail |
   | `text eol=crlf`, mixed working file | yes | fail | pass |
   | `ident`, unexpanded or expanded keyword | yes | fail | pass |
   | `working-tree-encoding=UTF-16LE-BOM`; `text eol=crlf`; binary; untracked text; `text=auto` with `core.eol=crlf` | yes | pass | pass |
   | CRLF blob, `ident`, and `core.autocrlf=true` | yes | fail | fail |
   | Writer: Git read other content, then the verified bytes returned | no | fail | fail |
   | Writer: Git read only other line endings under `core.autocrlf=true` | yes | pass | pass |
   | Writer in a binary file | no | fail | fail |

   Running proof A with `GIT_INDEX_FILE` set to the candidate gave the same results. Canaries: a local clean and smudge filter on another path, `diff.<driver>.textconv`, and `diff.external` ran for neither proof. A command-valued `core.fsmonitor` also ran for neither proof, while `update-index` on the candidate ran it and `post-index-change`. `cat-file --filters` ran the smudge filter of a path with a `filter` attribute.
8. Candidate time: the first proof run gave a candidate that differed from `git add` once. `update-index --add` ran on a `cp` copy of the index. It kept the old blob of a same-size change in 2 of 20 runs. A `cp -p` copy, which keeps the time, gave 0 of 20. In a second test, a changed file was racy against the index. A published `apply --cached` candidate from a `cp` copy hid that change from later `status` in 10 of 30 runs. A `cp -p` copy gave 0 of 30. Git checks the content of an entry whose mtime is not older than the index file time. A copy with a new time removes that check (racy-git.adoc).
9. Split index: with `core.splitIndex=true` and an unsplit index, `update-index --add` and `apply --cached` on a private candidate each split the candidate. Each wrote a new `sharedindex.<hash>` into the Git directory. A global `core.splitIndex=true` did the same. `read-tree --empty` did not. With an already split index and the setting unset, `apply --cached` wrote a second shared index. `GIT_TEST_SPLIT_INDEX=1` split the candidate without the setting. `update-index --no-split-index` wrote an unsplit candidate with a warning. With `splitIndex.sharedIndexExpire=now` and `splitIndex.maxPercentChange=0`, one candidate write deleted the shared index of the canonical index. `git ls-files` then failed on the canonical index.

Consequences:

- The stage bound is 512 MiB per working file (contract §5). It equals Git's default `core.bigFileThreshold`, and the measured 20.5 seconds fits the 30-second Git step deadline. A larger file gets reason `size` and keeps its `add` remedy. T203 measures the packaged time on the reference host. A miss stays a recorded failure.
- Git sets the mode of a new file. `ce_mode_from_stat` gives `100644` unless `core.filemode` is true and the file has an execute bit (read-cache.h). Git for Windows reports no execute bit (compat/mingw.c `file_attr_to_st_mode`). So the candidate check accepts a regular-file mode for an untracked entry, and the oracle tests fix the value.
- Git reads the working file during the stage step, and its conversion can depend on the index (probe 5). So the service cannot compute the staged blob independently, unlike step 9 of the publication protocol. Step 6 proves the blob instead (contract §4 "Blob proof"). Either proof suffices, because each accepts cases that the other refuses (probe 7). When both fail, the service cannot tell a writer from an unprovable conversion. It refuses with reason `blob-proof` and keeps the `add` remedy. Two conversions that equal `git add` meet this refusal. They are an index-only attribute file with `eol`, and a CR index blob with `ident`. The refusal is fail-closed and stays a recorded limit.
- A candidate copy keeps a last-write time at most the canonical index time (probe 8, contract §4 "Candidate time"). This rule covers hunks and files.
- A split index or `core.splitIndex=true` refuses both operations with reason `split-index` (probe 9). A refused candidate could otherwise have deleted the shared index of the canonical index. The Git child environment drops every `GIT_TEST_*` variable.
- `update-index --index-info` skips a path that fails `verify_path` and still exits 0 (builtin/update-index.c `read_index_info`). So the candidate check compares entries and never trusts the exit status.

Sources: [piped input](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/object-file.c#L1053-L1066), [index_fd threshold](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/object-file.c#L1358-L1377), [conversion flags](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/object-file.c#L33-L41), [CR in index](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/convert.c#L224-L240), [safe autocrlf](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/convert.c#L526-L538), [hash-object](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/hash-object.c#L23-L34), [ce_mode_from_stat](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/read-cache.h#L8-L21), [Windows st_mode](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/compat/mingw.c#L4544-L4569), [index-info](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/update-index.c#L573-L592), [bigFileThreshold](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/config/core.adoc#L460-L465).

Additional sources for probes 7 to 9: [racy Git](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/technical/racy-git.adoc), [split index settings](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/config/splitindex.adoc), [cat-file filters](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-cat-file.adoc), [test variables](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/t/README). The installed Git `2.55.0.windows.3` documentation holds the same racy-git text (lines 80 to 91) and the `splitIndex.sharedIndexExpire` entry.

### Untracked hunk content

**Decision (2026-10-08, T092)**: The untracked read is `--no-lazy-fetch diff --no-index --no-ext-diff --no-textconv --no-color --src-prefix=a/ --dst-prefix=b/ -- /dev/null <path>`. The probe ran without the prefix flags. They change only the patch headers. The new side equals the oracle blob in every probed case, except an attribute file that only the index holds. Under `core.safecrlf=true`, the oracle is `git add -p` (FR-010), and the read equals it ("Re-probe under `core.safecrlf=true`" below). Only the index-only attribute group has no admissible method. It gets no hunk action and reason `line-endings` (R10 "T092 cases without a method").

**Rationale**: Only this form and `hash-object` are reads. Both fail the same case. Only the `diff` form gives bytes without an object write.

**Alternatives considered**: `hash-object --stdin --path=<p>` without `-w` gives an object ID only. Its bytes need `-w`, which writes an object. Intent-to-add on a private index, then `diff-files -p`, equaled every blob. It ran `post-index-change` and the `core.fsmonitor` command, and the `read` policy never sets `GIT_INDEX_FILE` (T026). So it is not a read.

The probe ran on 2026-10-08 with Git `2.56.0.windows.1` at `C:\Git\cmd\git.exe`, not the reference `2.55.0.windows.3`. It was a Bun test in the session scratch folder, not in the repository. It used the fixture root, environment, and builders of `tests/git/fixtures.ts`. Each command started with `--no-lazy-fetch`. Git ran in the worktree root with a path relative to that root. The attribute lookup of `diff --no-index` uses that path, so the read must keep this form. These probes are not qualification evidence.

- Cases: the six `buildF04` variants and the five `buildF04Stage` variants. Each attribute folder got untracked `u-lf.txt`, `u-crlf.txt`, `u-mixed.txt`, and `u-noeol.txt` with the F04 changed text. `u-noeol.txt` is an extra case: LF text without the last LF. In the two `ident` variants, line 5 holds an expanded `$Id: <40 hex> $` keyword. This gives 60 cases.
- Oracle: `git add -- <path>` in a copy of the fixture, then `cat-file blob` of the staged entry. `git add` exited 128 in 3 cases and wrote a blob in 57. The raw bytes differed from the blob in 29 cases, so the probe exercised the conversion.
- Comparison: the probe rebuilt the new side from the `+` lines of the patch and compared it with the blob byte by byte.

| Method | Equal to the blob (57 cases) | Differs from the blob |
| --- | --- | --- |
| `diff --no-index --no-ext-diff --no-textconv --no-color -- /dev/null <p>` | 55 | Index-only `eol=crlf`: `u-crlf.txt` and `u-mixed.txt`, first difference at byte 6 |
| The same with `nul` as the empty side | 55 | The same two cases and offsets |
| `hash-object --stdin --path=<p>` without `-w` (object ID only) | 55 | The same two cases |
| `hash-object -w --stdin --path=<p>` in a copy, then `cat-file blob` | 55 | The same two cases, at byte 6 |
| `add --intent-to-add` on a private index, then `diff-files -p --no-ext-diff --no-textconv` | 57 | None |

In the 3 cases where `git add` exited 128, `hash-object -w` also exited 128. Every other method gave bytes or an object ID.

Canaries: a local clean filter on a tracked stat-dirty file and on a second untracked file, `diff.external`, `diff.<driver>.textconv` on the probed file, a command-valued `core.fsmonitor`, and a `post-index-change` hook.

- The `diff` form and `hash-object` ran no canary for the probed file. Both ran the clean filter for the file with the `filter` attribute (R5 probe, contract §4).
- The private-index `add --intent-to-add` ran the monitor and the hook. Its `diff-files` step ran the monitor, and the clean filter for the filtered file.
- With `color.ui=always`, the `diff` form wrote color escapes without `--no-color` and none with it.

Consequences:

- Index-only attribute file: for check-in, Git reads the working `.gitattributes` and reads the index entry only when that file is absent (attr.c `read_attr`). `diff --no-index` and `hash-object` load no index. Signal: an index entry `.gitattributes` in the folder of the path or an ancestor folder, with no regular working file at that path. The untracked entry then gets reason `line-endings`. This also refuses LF files that the form gives correctly. The refusal is fail-closed and stays a recorded limit.
- `core.safecrlf=true`: under `core.autocrlf=true`, `git add` exited 128 for `u-lf.txt`, `u-mixed.txt`, and `u-noeol.txt`. The read gave bytes, because Git applies safecrlf only when it writes an object (probe 3). FR-010 accepts what `git add` refuses here, as `git add -p` does. The re-probe below uses that oracle, and the read equals it. So `core.safecrlf` gives no untracked refusal.
- `nul` and `/dev/null` both give an absent side in Git for Windows (diff-no-index.c `get_mode`). The form uses `/dev/null`.
- A `filter` attribute from `check-attr` still gives reason `filter` before the read runs (contract §4).
- Patch header settings (source reading, no probe): `diff.noprefix`, `diff.mnemonicPrefix`, `diff.srcPrefix`, `diff.dstPrefix`, and `diff.relative` are UI keys (diff.c `git_diff_ui_config`). `diff-files` and `diff-index` read only the basic keys, so these keys cannot change their headers. Porcelain `diff --no-index` reads them. `repo_diff_setup` applies them before option parsing, so explicit `--src-prefix=a/ --dst-prefix=b/` override them. The untracked read and the tracked patch reads carry both flags, which closes the untested-config item. The tracked patch reads also carry `--no-relative`, which clears `relative_name` (diff.c `diff_opt_relative`). `diff --no-index` sets `relative_name` again after option parsing, so `--no-relative` has no effect there and the form omits it. Git runs in the worktree root, so that prefix is empty.
- Binary signal (T103, 2026-10-08): reason `binary` comes from the `--numstat -z` read of each scope, which prints two `-` fields for a binary file (git-diff(1) `--numstat`). The untracked form prints the two-path record `NUL /dev/null NUL <path> NUL`. The `ls-files --eol` value `-text` is not used, because convert.c `convert_is_binary` also counts a lone CR, and Git's diff still treats such a file as text.

**Re-probe under `core.safecrlf=true`, 2026-10-08.** The run used main `e5fd355`, the same Git, root, and builders, and a fresh fixture root. It set local `core.safecrlf=true` in each of the 11 fixtures and added the same 60 untracked files. The read was the full form with the prefix flags. The oracle ran in a copy: `add -N -- <path>`, then `add -p -- <path>` with `y` lines on stdin. Git state proved that every hunk was staged. `add -p` exited 0, `diff-files --quiet -- <path>` exited 0, and the entry had no intent-to-add flag. The oracle blob was then compared with the new side byte by byte.

| Fixtures | Cases | Equal | Differs |
| --- | --- | --- | --- |
| The six `buildF04` variants | 40 | 40 | None |
| `buildF04Stage` "index-attribute" | 4 | 2 | `u-crlf.txt` and `u-mixed.txt`, first difference at byte 6 |
| The other four `buildF04Stage` variants | 16 | 16 | None |

The `buildF04` "safecrlf" files `u-lf.txt`, `u-mixed.txt`, and `u-noeol.txt` are equal. The only differences are the index-only attribute cases of the first probe.

Sources: [check-in attribute order](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/attr.c#L841-L871), [empty side](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/diff-no-index.c#L81-L95), [conversion flags](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/object-file.c#L33-L41), [diff UI keys](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/diff.c#L360-L426), [diff setup](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/diff.c#L5133-L5175), [relative option](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/diff.c#L5902-L5911), [diff-files basic keys](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/diff-files.c#L34), [diff-index basic keys](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/diff-index.c#L31), [no-index relative names](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/diff-no-index.c#L411-L425).

## R4. Selected commit design: standard Git handoff

**Decision**: Use ordinary canonical `git commit --quiet --file=-` after immediate full preflight. The user explicitly selected Standard Git through `/speckit-clarify` on 2026-09-28.

**Rationale**: Approval authorizes normal Git execution against the freshly reviewed scope, not an immutable-tree transaction. Approved hooks and late external changes can affect execution.

**Alternatives considered**: Private-index commits, plumbing reconstruction, injected transaction hooks, and the previous exact-snapshot promise. Private-index commits add separate index/reference publication and risk hiding hook-produced staging. Injected hooks change the effective hook set. None is selected.

### Preflight and handoff

Review stays read-only. Retain complete staged scope and a bounded index snapshot without `write-tree` or trial commits. Compare the eventual commit tree against that retained snapshot through read-only Git inspection; no preview tree write is required.

1. Enter application mutation exclusion for the common directory.
2. Obtain the canonical index lock for final validation, refusing foreign locks.
3. Compare the complete reviewed index, checkout target/OID, operation state, configuration, trust, and complete staged scope.
4. Validate the message and consume its one-use review token only after successful checks.
5. Refuse every detected mismatch and require renewed review.
6. Release the preflight lock, then start exactly one ordinary `git --no-lazy-fetch commit --quiet --file=-` against the canonical index (R5 partial-clone probes). `--quiet` removes only the summary that Git prints after `post-commit`.
7. Supply the bounded message through stdin. Use no path arguments, `--all`, `--amend`, hook bypass, or signing override.
8. Reconcile relevant Git state before permitting another mutation.

Handoff begins when the preflight lock is released. Git must acquire its own lock. Release and process startup are not atomic.

Git captures its own HEAD, releases its initial index lock before hooks, and rereads the index after `pre-commit`. Its reference comparison uses its internally captured OID, not the application's earlier reviewed identity.

Keep normal hook effects in the canonical index, including after failure. Never hide them in an orphaned private commit index.

### Outcome contract

| Outcome | Required behavior |
| --- | --- |
| Refused before handoff | No commit process started. Show stale, invalid, locked, or trust-related cause. |
| Completed as reviewed | Verify the expected tree, parent, destination, and relevant state. Clear only the unchanged submitted draft. |
| Completed with effects | Identify the created commit where evidence permits. Show differing scope or state; preserve the draft and avoid ordinary-success styling. |
| Failed with effects | Report observed effects after failure or interruption. Preserve the message and all repository changes. |
| Unknown | State that attribution or reconciliation failed. Preserve the draft and block mutations until successful reconciliation. |

Read actual HEAD, reviewed destination, index, relevant working bytes, and operation markers. Use reference/reflog evidence only when needed for attribution. Limit each reconciliation attempt to 4 MiB and 10,000 total reference/reflog records, across all streams and references. Evidence overflow leaves the result unknown; never treat a truncated scan as sufficient attribution. Never assume the current HEAD was created by this request.

Ambiguous evidence stays unknown. An `unknown` attribution is a reported outcome, not a failed reconciliation (FR-020, contract §8). Explicit recovery refresh must perform the required reconciliation before enabling mutations; status success alone cannot clear that block. Retain verification data while recovery remains blocked. Reconciliation cannot exhaustively attribute arbitrary trusted code's filesystem effects.

Suggested message: “Git created commit <OID>. Repository state changed during execution. Review the resulting commit and staged changes.”

Never describe an identified commit as nothing committed. Never retry, reset, amend, undo, or claim rollback automatically.

### Hook, signing, and maintenance evidence

Git trace2 `child_start` events set `child_class` to `hook` and add `hook_name` for hook children. Signing children set no class, so their events show `child_class` `?`. Their `argv` starts with the configured signing program. `GIT_TRACE2_EVENT` overrides a configured `trace2.eventTarget`.

Open question: can these events classify `HOOK_FAILED` and `SIGNING_FAILED` without a heuristic? T091 probes this on Git `2.55.0.windows.3` and records the result here. A trace2 target comes only from a supporting probe result, through the `mutation-trace2` policy. That target would replace a user's own event target. So the service selects it only when no service variable or configuration key names an event target (contract §7). Without structured evidence, T112 returns `GIT_FAILED` with a recorded reason. The requirement stays.

A failed commit shows a bounded, sanitized, and redacted tail of Git stderr (contract §9 "Commit failure output"). `HOOK_FAILED` and a `GIT_FAILED` after handoff also carry a remedy command. It runs `hook run --ignore-missing pre-commit` in a terminal (contract §9). The command uses the selected Git executable and the worktree root, and never the message. An earlier remedy ran `git commit` itself. After a passing hook, Git would open an editor (`git-commit` without `-m` or `-F`). It would then create a commit outside the review. So that command is withdrawn.

A Git-behavior probe on 2026-09-30 used Git `2.55.0.windows.3` in a throwaway repository. It had a rejecting `pre-commit` hook and a configured `hook.<name>.command` for `pre-commit`. `git --no-lazy-fetch hook run --ignore-missing pre-commit` ran both hooks and exited 1. Its output equaled the output of the rejected `git commit --file=-`. The refs, HEAD, and the index digest stayed unchanged, so no commit was created. With stderr discarded, neither command wrote hook stdout to stdout, so Git sends hook stdout to stderr. `hook run --ignore-missing commit-msg` exited 0 without its message-file argument. So only `pre-commit` has a remedy command. This probe is not qualification evidence.

A second probe on 2026-09-30 held `refs/heads/main.lock`, and then `HEAD.lock`, during `git commit --file=-`. Each commit exited 128 with `cannot lock ref 'HEAD'`. HEAD did not move, no `index.lock` remained, and the staged change stayed. Hooks that run before the ref update can still change the index. So such a failure is `GIT_FAILED`, or `failed-with-effects` when reconciliation observes changes (contract §9 "Other locks"). This probe is not qualification evidence.

A Git-behavior probe on 2026-09-30 ran `git commit --file=-` in throwaway repositories with canary programs. A plain commit ran `pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-index-change`, and `post-commit`. It ran `reference-transaction` with `preparing`, `prepared`, `committed`, and `aborted`. It also ran a command-valued `core.fsmonitor`. With `gpg.format=ssh`, `commit.gpgsign=true`, and no `user.signingKey`, Git ran `gpg.ssh.defaultKeyCommand`. With a `key::` signing key, it ran `gpg.ssh.program`. With `gpg.format=x509`, it ran `gpg.x509.program` and not `gpg.program`. `gpg.openpgp.program` took precedence over `gpg.program`. `gpg.program` ran when it was the only signing key. Each signing program ran after the `commit-msg` hook. `gpg.adoc` lists no other command-valued key. `gpg.ssh.allowedSignersFile` and `gpg.ssh.revocationFile` name files for verification only. This probe is not qualification evidence.

Signing sources: [gpg configuration keys](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/config/gpg.adoc#L1-L47).

`git commit` updates HEAD and then runs `git maintenance run --auto`, with `--detach` by default. After that, it runs the `post-commit` hook. Git for Windows builds with `NO_POSIX_GOODIES`, so `daemonize()` fails. Maintenance then continues in the foreground. The commit process waits for it, and the 120-second commit deadline covers it. An interruption there leaves a created commit. Reconciliation classifies that result from observed state. This paragraph is source reasoning from the cited lines, not an observed run. T100 verifies it.

If T100 observes a detached maintenance process, the operation Job still contains it, because the Job forbids breakaway. Reconciliation reports the created commit and names observed maintenance files as foreign. The maintenance process keeps running after the commit, as with command-line Git. The Job then becomes a lingering Job (contract §6 "Lingering Jobs"). It closes when it is empty or the application closes. A `post-commit` hook child and a built-in fsmonitor daemon that the commit starts follow the same rule. An `index.lock` that such a process holds gives `LOCKED` on the next mutation. Another held lock makes Git fail (probe above). The app never removes a lock.

Open question: the maintenance duration on fixture L and the files that an interruption leaves are unverified. T100 probes them with local `gc.auto=1`.

Evidence sources: [trace2 child class](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/trace2/tr2_tgt_event.c#L339-L356), [trace2 event format](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/technical/api-trace2.adoc#L517-L541), [hook name](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/hook.c#L608), [GPG signing child](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/gpg-interface.c#L1011-L1020), [SSH signing child](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/gpg-interface.c#L1058-L1108), [trace2 target override](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/config/trace2.adoc#L15-L17), [HEAD update](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/commit.c#L1947), [maintenance and post-commit](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/commit.c#L1967-L1969), [auto maintenance](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/run-command.c#L1957-L1994), [MinGW build flag](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/config.mak.uname#L729), [daemonize](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/setup.c#L2233-L2237), [foreground fallback](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/gc.c#L1814-L1818).

### Resolution and constitutional boundary

The former B-COMMIT blocker is resolved through the explicitly approved consistency contract, not postchecks presented as prevention.

Constitution 2.0.0 remains unchanged by this design. Principles III/IV require fresh checkpoints, stale refusal, exact application hunk effects, and real assertions. They do not grant control over independent writers or promise immutable results from approved hooks.

Keep ordinary fixtures' exact index and unchanged-byte assertions. Controlled race fixtures verify checkpoint refusal or honest late-change outcomes, depending on the barrier.

No mutation, hook, cancellation, or Windows test has run. Those checks remain required before qualification.

**T091 trace2 probe, 2026-10-07.** The probe used Git 2.56.0.windows.1 in a throwaway repository with an owned `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM=1`. A failing `pre-commit` hook and a failing `gpg.program` signer each ran with `GIT_TRACE2_EVENT` set to an owned file. This probe is not qualification evidence.

- `child_start` carries `child_id`, `child_class`, and `argv`. The class is `hook` with `hook_name` for a hook, and `?` for the `gpg.program` signer.
- `child_exit` carries the same `child_id`, `pid`, and `code`. A failing hook gave 3, and a failing signer gave 5.
- `GIT_TRACE2_EVENT` replaces a global `trace2.eventTarget`. Git never reads a local `trace2.eventTarget`.

Sources: [index lock release](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/commit.c#L482-L494), [post-hook index read](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/commit.c#L1101-L1135), [HEAD capture](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/commit.c#L1815-L1844), [reference update](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/sequencer.c#L1259-L1295), [transaction hook phases](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/refs.c#L2698-L2739), [configured hook ordering](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/hook.c#L546-L550).

**T112 method, 2026-10-09.** T112 sets no trace2 event target, and `src/contracts/git-environment.json` gets no `mutation-trace2` policy. So every commit failure gives `GIT_FAILED`, never `HOOK_FAILED` or `SIGNING_FAILED`. The T091 events can identify a failing hook or signer, but no defined reader receives them. Pinned Git accepts only stderr, one file-descriptor digit, or an absolute file or directory path as an event target. A build with Unix sockets also accepts an `af_unix:` socket ([trace2 target](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/trace2/tr2_dst.c#L312-L356)). Stderr also carries hook output, so a hook can print a line that looks like an event. Contract §6 gives a Git process only stdin, stdout, and stderr, so no other descriptor exists. The contract defines no owned target file or socket, no reader, no bound, and no cleanup for one. This is the recorded reason of each commit `GIT_FAILED`. The §9 output tail still shows the Git and hook output. So the `HOOK_FAILED` and `SIGNING_FAILED` classification stays `unverified` for this reason (T117).

**T113 probes, 2026-10-10.** The probes used Git 2.56.0.windows.1, built from commit `49d759b6`, in throwaway repositories with an owned `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM=1`. Each probe ran on the `files` and the `reftable` ref formats. The two formats gave equal results unless a line names one. These probes are not qualification evidence.

- P1 reflog read: the contract §8 argv exited 0. It printed 5 NUL-ended fields per record, newest first, and its output ended with NUL. With `--date=raw`, `%gd` printed `HEAD@{<epoch> <zone>}`, for example `HEAD@{1791580480 +0300}`. `-n 1` printed only the newest record. A non-ASCII subject printed as UTF-8. An LF in an `update-ref -m` text printed as a space. The `worktree add` record has an empty message. In a linked worktree, the read printed only the records of that worktree. A commit there added no record to the HEAD log of the main worktree.
- P2 edge states: with an unborn HEAD and no log, the read exited 128 and printed nothing. After `switch --orphan` on a repository with a HEAD log, the read also exited 128. `switch --orphan` wrote no record. The first orphan commit added one `commit (initial)` record to the existing HEAD log, so a later read printed all older records too. With `core.logAllRefUpdates=false` from the start, the read exited 0 with 0 bytes. With that value set after a HEAD log existed, each commit still added one record. A record whose commit object was missing did not print, and the read exited 0 with no stderr. The reflog walk skips each record whose new OID does not parse as a commit.
- P3 automatic maintenance: each `git commit` ran `git maintenance run --auto --quiet --detach`. Without `maintenance.strategy`, unscheduled maintenance uses the `geometric` strategy, and that strategy has no `gc` task. So the F12 `gc-auto` fixture (`gc.auto=1`, 2 loose objects in `objects/17`) ran no `gc --auto`, and its 2026-01-01 HEAD records stayed. The `reflog-expire` task runs when the HEAD log holds at least `maintenance.reflog-expire.auto` expired records (default 100). With 99 HEAD records dated 2026-01-01, the commit ran no `reflog expire`. With 100, it ran `reflog expire --all`, and 101 records became 2: the newer first record and the new commit record. With a local `maintenance.strategy=gc`, the commit ran `gc --auto`, which ran `reflog expire --all` and removed the 2026-01-01 records. The new commit record stayed in each run. So when record times increase, an expired tip leaves every record after it. A commit also expires records that carry fixed old times, such as F20 records at 2026-01-01, when 100 or more exist.
- P4: an `update-ref` of the branch that HEAD names added one HEAD record. A commit through HEAD added exactly one HEAD record.
- P5 records inside the window: `update-ref` wrote a record for a no-op update from `<B>` to `<B>`, through argv and through `--stdin`. One `--stdin` session with repeated `start`, `update HEAD`, and `commit` lines added one record per transaction. Records appended to the `files` path from `rev-parse --git-path logs/HEAD` printed in file order, also with older times. The `files` format kept a 30,000-byte `-m` text. The `reftable` format kept 2,048 bytes of a 2,200-byte and of a 30,000-byte text, because it trims each message to half the block size (default 4,096 bytes). So a reftable `reflog-bytes` variant needs about 2,000 records: 2,000 records with 2,200-byte texts and 14 short records printed 4,295,607 bytes, 101,303 bytes above 4 MiB. The same session on `files` printed 4,656,029 bytes. The reftable session took 38 s for 2,000 transactions and 188 s for 10,002 short transactions. The `files` session took 15 s for 2,000. `git refs migrate --ref-format=reftable` kept all 10,002 HEAD records of a `files` repository in 0.6 s, but it trimmed 70,000-byte messages to 2,048 bytes.
- P6: the installed `git-commit.html` has no EXIT STATUS section. The `git-config.html` control has one. So the exit status of `git commit` is not a contract fact.

Residual risks of the contract §8 "Attribution window":

- One external commit on the reviewed HEAD inside the window, while the commit process failed, looks the same as the commit of the request.
- A later record equal to the tip in all five fields, written in the same second, ends the window early.
- The read does not print a record whose commit object is missing. Such a record can hide an ambiguous window.
- With `core.logAllRefUpdates=false` and no HEAD log, every created commit gives `unknown` with reason `ambiguous`.
- An expired tip in a log whose record times do not increase can leave older records in the window. They give only `ambiguous`, never a false attribution.

Sources: [HEAD log of a branch update, files](https://github.com/git-for-windows/git/blob/49d759b698127791a5f3f2759c69b983846711dd/refs/files-backend.c#L2499), [reftable update](https://github.com/git-for-windows/git/blob/49d759b698127791a5f3f2759c69b983846711dd/refs/reftable-backend.c#L1065), [reftable message trim](https://github.com/git-for-windows/git/blob/49d759b698127791a5f3f2759c69b983846711dd/refs/reftable-backend.c#L1600-L1601), [reftable block size](https://github.com/git-for-windows/git/blob/49d759b698127791a5f3f2759c69b983846711dd/refs/reftable-backend.c#L387-L388), [reflog walk](https://github.com/git-for-windows/git/blob/49d759b698127791a5f3f2759c69b983846711dd/reflog-walk.c#L341-L352), [commit maintenance](https://github.com/git-for-windows/git/blob/49d759b698127791a5f3f2759c69b983846711dd/builtin/commit.c#L1967), [reflog-expire condition](https://github.com/git-for-windows/git/blob/49d759b698127791a5f3f2759c69b983846711dd/builtin/gc.c#L301-L326), [geometric strategy](https://github.com/git-for-windows/git/blob/49d759b698127791a5f3f2759c69b983846711dd/builtin/gc.c#L1502), [unscheduled strategy](https://github.com/git-for-windows/git/blob/49d759b698127791a5f3f2759c69b983846711dd/builtin/gc.c#L1578-L1583).

**T114 P1 maintenance lifetime, 2026-10-10.** The probe used Git 2.56.0.windows.1 and only the `files` ref format. The T100 trace2 oracle ran once on a copy of F12 `gc-auto` (`gc.auto=1`, `maintenance.strategy=gc`). The commit started `git maintenance run --auto --quiet --detach`. That process ran `pack-refs`, `reflog expire --all`, and `gc --auto --quiet --no-detach --skip-foreground-tasks`. Every descendant wrote its `exit` event, code 0, before the commit's `child_exit` for it (`t_rel` 0.691 s, code 0). The commit's own `exit` (code 0) came after that. No `git.exe` process with `maintenance` or `gc` in its command line ran after the commit returned (`Win32_Process`). So on this build, `git commit` waits for automatic maintenance, and no maintenance process outlives the commit, despite `--detach`.

## R5. Trust, cancellation, and external writers

**Decision**: Validate each operation at the service boundary. Serialize application mutations conservatively by common-directory identity.

**Rationale**: Application exclusion does not control external Git processes. Watchers are notifications, not transaction logs.

**Alternatives considered**: Per-path mutation queues, timestamp-only checks, unrestricted shell IPC, and PID-name termination. They cannot establish the required boundaries.

Git `2.55.0.windows.3` supports configured hook commands and events, including parallel execution settings. Trust discovery must inspect these settings, not only `.git/hooks` and `core.hooksPath`.

Superseded by the T280 record below. Derive hook registrations from the configuration listing and the hooks folder. Run no `git hook list`. Inspect conditional includes, worktree configuration, filters, signers, executable monitors, and diff tools.

Disable executable preview paths for inspection. Missing trust must block operations that could execute repository-controlled code. Custom filters remain unsupported for hunk mutation after approval.

A Git-behavior probe on 2026-09-29 used Git `2.55.0.windows.3` in throwaway repositories with canary commands. Without `--ignore-submodules=dirty`, `status --porcelain=v2` and `diff-files` started `git status --porcelain=2` inside each submodule. That child ran the submodule's own `core.fsmonitor` and clean filter. With the option, `status` and `diff-files -p` started no child, and status still reported a moved submodule commit. The probe also matched the contract §7 key table and the `i18n.commitEncoding` UTF-8 spellings. This probe is not qualification evidence, and no Arbareto build ran.

A second probe on 2026-09-29 used an owned global configuration and a throwaway repository. A global `core.hooksPath=.githooks` ran the committed `.githooks/pre-commit`. A global `hook.<name>.command=./tools/h.sh` ran the committed script. A global `filter.<driver>.clean=./tools/clean.sh` ran during `diff-files -p`. A global `core.fsmonitor=./tools/fsm.sh` ran during `status`. Each ran with the worktree root as its directory, also when Git started in a subdirectory. `rev-parse --git-path hooks` printed `.githooks` at the root and `../.githooks` in the subdirectory. `git hook list --show-scope` printed `hook from hookdir` without a path. This probe is not qualification evidence.

**T280 record (2026-10-05)**: T080 drops the `hook list` runs. It derives the hook registrations in TypeScript from `config list --show-scope --show-origin -z` and the `rev-parse --git-path hooks` folder. The derivation equals the oracle in every case below, and k = 28 `hook list` runs are saved for each trust listing.

The probe `tests/git/probe-hooks.ts` ran Git `2.56.0.windows.1` (`C:/Git/ucrt64/bin/git.exe`, built from `49d759b698127791a5f3f2759c69b983846711dd`, the peeled tag `v2.56.0.windows.1`). This is not the R2 candidate `2.55.0.windows.3`. Each derivation call and each oracle call for a known event used the `src/git-service/commands.ts` builders `configListArgs`, `hooksPathArgs`, and `hookListArgs`. The arity checks and the unknown-event oracle used the same global options with raw arguments. All calls ran under `LC_ALL=C` with the owned fixture environment. Each case had its own repository and its own global file under the fixture root. The oracle is `git hook list -z --show-scope <event>` for each of the 28 events, compared byte for byte with the derivation, with exit status 0 for a listing and 1 for none.

Event set and arity:

- `hook list` accepted all 28 names of `HOOK_EVENTS` in `commands.ts`. `tools/generate-hooklist.sh` at the build revision makes the same 28 names from `githooks.adoc`. `hook.c` `is_known_hook` checks this list.
- One call lists one event. Two names or no name exit 129 with `fatal: you must specify a hook event name to list` (builtin/hook.c:59-61).
- An unknown name exits 1 with `error: unknown hook event`. A configured hook can name an unknown event. Only `hook list --allow-unknown-hook-name` shows it, and the derivation shows it from the listing.

Output format (builtin/hook.c:72-112):

- Configured hooks come first, then the hooks-folder hook (`list_hooks`, hook.c:535-552). A configured hook prints `<scope>\t<name>`, `<scope>\tdisabled\t<name>`, or `<scope>\tevent-disabled\t<name>`. `event-disabled` wins over `disabled`.
- A hooks-folder hook prints `hook from hookdir` and no path. An empty result exits 1 with `warning: no hooks found for event`.
- The scope is the scope of the last `hook.<name>.event` entry for that event, not of `hook.<name>.command`. The command is the last `hook.<name>.command` value from any scope (hook.c:190-237).

Derivation rules that the probe confirmed (hook.c `hook_config_lookup_all` and `build_hook_config_map`, hook.c:154-450):

- Order: a repeated `hook.<name>.event` removes the earlier entry with `unsorted_string_list_delete_item`, which moves the last entry into the free slot (string-list.c:274-282). Then it appends the name. So the order is not plain last-seen order. A first derivation with plain last-seen order differed for `pre-commit` in the configured case.
- An empty `hook.<name>.event` value removes the name from every event seen so far.
- `hook.<name>.enabled` uses `git_parse_maybe_bool`, and the last value wins. `false`, `0`, and `off` disable. A later `true` enables again.
- `hook.<x>.enabled=false` is an event switch when `<x>` has no `command`, `event`, or valid `parallel` entry (`is_friendly_name`, hook.c:322).
- A disabled hook without a command stays in the list with a warning. An enabled hook without a command, or a friendly name that equals a known event, makes every `hook list` call exit 128. `hook.jobs`, `hook.<event>.jobs`, and `hook.<name>.parallel` do not change the listing.
- Hooks folder: `resolve(<directory where Git ran>, <rev-parse --git-path hooks output>)` joined with the event name. Git lists the entry when `access(path, X_OK)` succeeds (`find_hook`, hook.c:26-64). Git for Windows drops `X_OK` (`mingw_access`, compat/mingw.c:1171-1180), and Bun `accessSync` with `X_OK` also tests only existence on Windows (Bun 1.4.2, checked on this host). So a folder named `pre-commit` and a mode 0644 `commit-msg` were listed on Windows. On POSIX, `X_OK` decides (source rule, not run by this probe).
- Unverified: Git for Windows also tries `<name>.exe` (`STRIP_EXTENSION`, config.mak.uname:541 and :738). The probe has no case for that name, because `tests/git/` stays portable. T080 adds that name from the source rule. `find_hook` tries `<name>` first, then `<name>.exe` (hook.c:35-46).

| Case | Events with hooks | Derivation against oracle | Canaries (derivation / oracle) | Processes (derivation / oracle) |
| --- | --- | --- | --- | --- |
| fresh repository, sample hooks only | 0 | equal | none / none | 2 / 28 |
| every traditional name in `.git/hooks`, plus samples and an unknown name | 28 | equal | none / none | 2 / 28 |
| configured hooks from global, local, worktree, and command scopes, and one unknown event | 5 | equal | none / none | 2 / 29 |
| disabled registrations: per hook (`false`, `0`, `off`), without a command, re-enabled, and per event | 3 | equal | none / none | 2 / 28 |
| global absolute `core.hooksPath` | 2 | equal | none / none | 2 / 28 |
| global relative `core.hooksPath=.githooks`, at the worktree root | 2 | equal | none / none | 2 / 28 |
| the same, in a subdirectory (`../.githooks`) | 2 | equal | none / none | 2 / 28 |
| the same, in a linked worktree | 3 | equal | none / none | 2 / 28 |
| local relative `core.hooksPath=hooks-local` | 1 | equal | none / none | 2 / 28 |
| hooks folder: a folder named `pre-commit`, a mode 0644 `commit-msg` | 2 | equal | none / none | 2 / 28 |
| fatal: `hook.orphan.event` without a command | all exit 128 | equal | none / none | 2 / 28 |
| fatal: friendly name `pre-commit` | all exit 128 | equal | none / none | 2 / 28 |

- The derivation processes are `config list` and `rev-parse --git-path hooks`. T080 needs both for other trust rules. The oracle processes are the `hook list` runs; the configured case adds one run for the unknown event.
- Per trust listing: the `hook list` form starts 30 Git processes (1 + 1 + 28). The derived form starts 2. So k = 28 when T080 lists every known event. The `hook list` form needs one run for each listed event.
- Informal timings, not qualification evidence: in the configured case, 28 `hook list` runs took a median of 548.6 ms, and the two derivation calls took 38.9 ms (10 runs each).
- Control: `hook run pre-commit` ran the canaries in each case that has a control. In the configured case it ran `l1`, `shared`, `g1`, `w`, `c1`, and the hooks-folder hook. Global and relative `core.hooksPath` ran their folder hooks, also from the subdirectory and the linked worktree.
- Disabled control: `hook run pre-commit` ran only the re-enabled hook `d5`. With `hook.pre-push.enabled=false` and `hook.post-merge.enabled=false`, `hook run` still ran the hooks-folder `pre-push` and `post-merge` hooks. The event switch stops only configured hooks.
- Scope control: global `hook.shared.event` with a local `hook.shared.command` listed `global\tshared`, but `hook run` ran the local command. So the `hook list` scope does not classify the command. T080 takes the scope and origin of the `command` entry from the listing.
- No `config list`, `rev-parse --git-path hooks`, or `hook list` call ran a canary.
- This probe is not qualification evidence, and no Arbareto build ran.

Hook sources: [hook list output](https://github.com/git-for-windows/git/blob/49d759b698127791a5f3f2759c69b983846711dd/builtin/hook.c#L59-L112), [hook configuration and hooks folder](https://github.com/git-for-windows/git/blob/49d759b698127791a5f3f2759c69b983846711dd/hook.c#L26-L552), [list removal](https://github.com/git-for-windows/git/blob/49d759b698127791a5f3f2759c69b983846711dd/string-list.c#L274-L282), [mingw_access](https://github.com/git-for-windows/git/blob/49d759b698127791a5f3f2759c69b983846711dd/compat/mingw.c#L1171-L1180), [hook configuration keys](https://github.com/git-for-windows/git/blob/49d759b698127791a5f3f2759c69b983846711dd/Documentation/config/hook.adoc).

Verdict for T080: drop the 28 `hook list` runs, and derive the registrations from the listing and the hooks folder by the rules above (k = 28).

Limit: the classification covers the program that Git starts. A protected command such as `sh ./x.sh` can still run repository files through its arguments. Whether `sh` searches an empty `PATH` entry on Git for Windows is unverified.

**T281 record (2026-10-05)**: The evidence allows one trust listing per workspace generation for `readWorkspace` and `readHistory`. It also allows `rev-list` and `cat-file` to run in parallel with that listing, with their result held until the gate passes. No canary ran before the gate, and no held result reached a refused response. Both results are adopted in contract §7 (2026-10-05).

The probe `tests/git/probe-shared-trust.ts` ran Git `2.56.0.windows.1` (`C:/Git/ucrt64/bin/git.exe`, built from `49d759b698127791a5f3f2759c69b983846711dd`). This is not the R2 candidate `2.55.0.windows.3`. The listing used the `commands.ts` builders `configListArgs` and `hooksPathArgs`. The history read used `shallowPathArgs`, `revListArgs`, and `batchCommandArgs`, and the full read used `statusArgs`. No builder captures HEAD yet, so `symbolic-ref -q HEAD` and `rev-parse --verify HEAD` used the T067 read options. All calls ran under `LC_ALL=C` with the owned fixture environment. `cat-file` got one `contents <oid>` command per `rev-list` row, without `--filters` or `--textconv`.

Method:

- One generation runs one listing. The full read and the history read take the same listing result.
- The history read starts `cat-file`, then runs `symbolic-ref`, `rev-parse`, `rev-parse --git-path shallow`, and `rev-list`. These run beside the listing, so HEAD capture also runs before the gate.
- The probe gate is the contract §7 blocking class for these reads: `filter.<driver>.clean`, `filter.<driver>.process`, and a command-valued `core.fsmonitor` at `local` or `worktree` scope. It checks scope only, because every F17 canary key has local scope. It is not the T080 resolution rule.
- Approval stores the digest of the listing bytes and the hooks path. A refused gate builds the response from the gate code only. The probe then searches both responses for each held commit ID.
- F17 `trust` has the F17 canaries, with `data.dat` and `data.prc` made stat-dirty. Each partial-clone variant got local canaries for `filter.<driver>.clean`, `filter.<driver>.process`, and `core.fsmonitor`, with both files stat-dirty. Its `cat-file` input also held `info <oid>` for the two missing blobs.

| Case | Canaries before approval: listing and held history | Gated full read | History response | Canaries after approval: listing and held history | Gated full read | History response |
| --- | --- | --- | --- | --- | --- | --- |
| F17 trust | none | none | rejected TRUST_REQUIRED, 1 row held, none in a response | none | clean, process, fsmonitor | succeeded, 1 row delivered |
| F17 partial-reset-soft | none | none | rejected TRUST_REQUIRED, 1 row held, none in a response | none | clean, process, fsmonitor | succeeded, 1 row delivered |
| F17 partial-read-tree | none | none | rejected TRUST_REQUIRED, 4 rows held, none in a response | none | clean, process, fsmonitor | succeeded, 4 rows delivered |

- Every held history process exited 0 before and after approval. With `--no-lazy-fetch`, `cat-file` reported the missing blobs, and the `uploadpack` canary did not run.
- Control: after approval, the gated `status` ran the clean, process, and `fsmonitor` canaries in each case. In each partial clone, `cat-file --batch-check` without `--no-lazy-fetch` ran the `uploadpack` canary for a missing blob.
- Stale listing: after approval, a local `core.fsmonitor` edit changed the configuration. A history read with the earlier shared listing passed its gate and ran no canary. A fresh listing gave `TRUST_CHANGED`. Contract §8 puts each configuration origin file in the change tuple, so the next full read starts a new generation.
- Diagnostic only: `diff.external`, `textconv`, and the `pre-commit` hook never ran.

Process counts per read, counted from the started processes on each M and L copy:

- A history read with its own listing starts 7 Git processes: the listing (2) and the history steps (5). The parallel order starts the same 7.
- A full read and a history read in one generation start 10 processes with two listings, and 8 with one shared listing. The probe full read is the `status` step only. So the shared listing removes the 2 listing processes from the second read of a generation.

Informal timings, not qualification evidence (median of 10 interleaved runs on owned copies of the T164 fixtures; both orders returned the same 100 rows):

| Fixture | Listing (ms) | History, §7 order (ms) | History, parallel order (ms) |
| --- | --- | --- | --- |
| M with commit-graph | 37.3 | 123.6 | 91.7 |
| M without commit-graph | 36.7 | 151.1 | 114.7 |
| L with commit-graph | 37.2 | 123.1 | 90.9 |
| L without commit-graph | 36.5 | 581.6 | 559.5 |

- The parallel order saves at most the listing time, about 22 to 37 ms. On L without a commit-graph, the walk dominates, and the saving is 22 ms of 582 ms.
- The cached M with commit-graph carried the CRLF builder digest of another checkout. The probe accepted the builder bytes with LF or CRLF line ends and checked the semantic digest of each copy. All four copies matched.
- This probe is not qualification evidence, and no Arbareto build ran.

Verdict for T080: one trust listing can serve `readWorkspace` and `readHistory` of the same generation. This saves 2 Git processes for the second read. Adopted in contract §7 "Shared listing" (2026-10-05), in a conservative form. Only `readHistory` reuses a listing, and `readWorkspace` always runs its own.

Verdict for T086: `rev-list` and `cat-file` can run in parallel with the trust listing, with their result held until the gate passes. No gated program started, and a refused gate delivered no held row. The process count stays 7, and the wall time drops by at most the listing time. Adopted in contract §7 "Held history steps" (2026-10-05).

**Decision**: Trust approval persists across launches (spec Clarifications, 2026-09-30). The shell stores one record for each worktree, because the fingerprint is per worktree. The record binds the common-directory identity, the worktree identity, the selected Git path, and the fingerprint. A change of any of them gives `TRUST_CHANGED` and needs renewed approval. A Git upgrade behind the same selected path keeps the approval (user decision, 2026-10-04). The record holds no configuration value or credential. A native confirmation with a Cancel default precedes each stored approval (R7). Revoke trust deletes the records of every worktree of that common directory. Over a digest bound, approval lasts for the service session only (contract §7). That session ends when Arbareto closes or at Restart service, and the native confirmation names both.

Closed question, 2026-09-30: the fingerprint covered integration locations, not the contents of program files. A stored approval would survive an edit of a repository hook file. The fingerprint now adds the SHA-256 digest of each repository-controlled program or hook file with a resolved path. Only files inside the worktree root, the Git directory, or the common directory get a digest. So the service never opens an attacker-named UNC or device path. Contract §7 "Program file digests" defines the rule. The bounds are 64 files, 1 MiB per file, and 8 MiB in total. Closed question, 2026-09-30: overflow first blocked approval, so an over-bound repository could never get approval. Now an over-bound repository can get an explicit approval for the service session only. The shell writes no record, and the native confirmation says why (contract §7). Files beyond a bound enter the fingerprint as `unchecked`. The next session reports `untrusted`. T071 and T098 edit an approved hook file and expect `TRUST_CHANGED`. T071 also covers the session-only approval.

Closed question, 2026-09-30: a bare-name program had no digest. Git for Windows looks up a bare name in each non-empty `PATH` entry in order. It tries `<entry>\<name>.exe` first, then `<entry>\<name>` when that is not a directory (`lookup_prog`, mingw.c:1908-1928; `path_lookup`, mingw.c:1993-2021). It skips empty entries (`if (dirlen)`). A relative entry resolves against the directory where Git runs. For hooks, filters, and monitors, that is the worktree root (second probe above). So the service repeats that lookup for each relative entry and digests the first regular file. Without one, the fingerprint records `absent`, so a new file gives `TRUST_CHANGED`. An earlier absolute entry can win the lookup. The digest then covers a file that Git does not start, which errs toward `TRUST_CHANGED`. Decision D9, 2026-10-05: a Windows probe with Git 2.56.0.windows.1 confirmed that Git for Windows skips an empty entry, in the shell form `foo %f` and in the plain form. An explicit `.` entry ran a program from the worktree. So on Windows, the contract counts only an explicit relative entry. On POSIX, an empty entry is the current folder and needs trust.

A probe on 2026-09-30 set four keys with a token in the subsection. They were `url.<URL>.insteadOf`, `http.<URL>.extraheader`, `credential.<URL>.helper`, and `includeIf.hasconfig:remote.*.url:<URL>/**.path`. Each URL had the form `https://u:TOKEN@host.example`. `config list --show-scope --show-origin -z` printed each token unchanged in the key. So contract §7 redacts URL user information in key subsections, origins, and displayed values. Git's `transport_anonymize_url` also removes the user information of a URL for display (transport.c:1695-1734). That function expects a whole URL. So the contract applies the rule to each `://` authority inside a longer text.

Redaction source: [transport_anonymize_url](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/transport.c#L1695-L1734).

A partial-clone probe on 2026-09-30 used Git `2.55.0.windows.3`. It cloned a local repository with `--filter=blob:none` and set a local `remote.origin.uploadpack` to a canary program. Each command then needed a blob that the clone lacked. Without `--no-lazy-fetch`, the canary ran for `status --porcelain=v2 --find-renames`, `diff-index --cached -p`, `diff-files -p`, `ls-files --eol`, and `commit --file=-`. The commit ran it for its rename summary. With `--no-lazy-fetch`, no canary ran. `status`, `diff-index`, and `diff-files` exited 128. `ls-files --eol` exited 0 and printed `i/none` for the missing blob. The commit moved HEAD, ran `post-commit`, and then exited 128 in its summary. A `pre-commit` hook saw `GIT_NO_LAZY_FETCH=1`, and its own `git cat-file` of a missing blob failed without a canary. Without the option, the hook saw no such variable, and its read ran the canary. `cat-file --batch-check` with `--no-lazy-fetch` printed `<oid> missing` and ran no canary. The listing showed `remote.origin.promisor` at local scope, and `git backfill` exists in this version. This probe is not qualification evidence.

A follow-up probe on 2026-09-30 moved HEAD with `reset --soft` to a fetched commit whose blob the `blob:none` clone lacked. It had `pre-commit`, `commit-msg`, and `post-commit` canaries and the uploadpack canary. `--no-lazy-fetch commit --file=-` ran the three hooks and moved HEAD. It then exited 128 in its summary, because the summary needed the missing blob. `--no-lazy-fetch commit --quiet --file=-` in a fresh copy ran the three hooks and moved HEAD with the right parent. It exited 0 and printed nothing, and its tree equaled the index. No uploadpack canary ran in either case. Git prints the summary after `post-commit` and only without `--quiet` (builtin/commit.c:1967-1982). Automatic maintenance still runs with `--quiet`. This probe is not qualification evidence.

Consequence: every app Git command passes `--no-lazy-fetch` (contract §7 "Missing objects"). The option propagates through the environment. So an approved hook cannot fetch objects during an app operation, although command-line Git would fetch them. A hook that needs a missing object then fails, and its message appears in the commit failure output. This is the stricter reading: a fetch can run a program from repository configuration without approval. `ls-files --eol` hides a missing blob, so only the `cat-file --batch-check` object check detects it. The app's commit passes `--quiet`, so the summary step never runs. Reconciliation still classifies every commit from observed state, and the exit status alone decides nothing.

An untracked-read probe on 2026-09-30 ran `git diff --no-index -- /dev/null u.txt`. The repository had local canaries for `diff.external`, `diff.<driver>.textconv`, `filter.<driver>.clean`, and `core.fsmonitor`. Its attribute file selected the driver and the filter for `u.txt`. Without flags, the clean filter and `diff.external` ran. With `--no-ext-diff` only, the clean filter and `textconv` ran. With `--no-textconv` only, the clean filter and `diff.external` ran. With both flags, only the clean filter ran. The `core.fsmonitor` canary never ran. `nul` in place of `/dev/null` behaved the same. So a `diff` form needs both flags, and a `filter` attribute refuses before the command (contract §4). This probe is not qualification evidence.

A read-command probe on 2026-10-01 used Git `2.55.0.windows.3` in a scratch repository. It had local canaries for command-valued `core.fsmonitor` and for clean and smudge filters, with a `filter` attribute. A tracked file was stat-dirty. `check-attr -z --stdin filter` ran the monitor canary once and no filter. `hash-object -t tree --stdin` and `config --file .gitmodules --null --list` ran no canary. `hash-object --stdin --path=<path>` ran the clean filter. Contract §7 lists these results.

A quoting probe on 2026-09-30 used PowerShell `7.6.6` and Windows PowerShell `5.1.26100.9444`, each with `-NoProfile -EncodedCommand`. It built the contract §4 `add` remedy for a file name or a worktree root. The value held U+0027, U+2018, U+2019, U+201A, or U+201B, followed by `; ni <marker>`. The root payload ended with `#`, so the rest of the command parsed as a comment. With only U+0027 doubled, each of the other four ended the string, and the marker file appeared. This happened in both shells, in the file name and in the root. With all five doubled, no marker appeared in the 20 cases, and `git ls-files` listed the staged file. So the contract doubles all five. This probe is not qualification evidence.

A dubious-ownership probe on 2026-10-01 used Git `2.55.0.windows.3` with `GIT_TEST_ASSUME_DIFFERENT_OWNER=1` and `LC_ALL=C`. The scratch folder was named `x'$(calc)'`. `rev-parse --show-toplevel` exited 128. The first stderr line named the raw path between `in repository at '` and a final `'`. The suggested command quoted the path for a POSIX shell: `'` became `'\''`, and `!` became `'\!'`. U+2019 stayed raw, although PowerShell ends a single-quoted string there.

- The PowerShell 7 parser found one subexpression in the suggested command. Its last argument was an expandable string, not the path.
- The contract §4 doubling gave one string constant, and its value equaled the path.
- So the service builds the `safe.directory` command itself (contract §6 "Registration bootstrap"). Every policy removes `GIT_TEST_*`, so the knob reaches Git only in a test harness that runs Git directly (T068).

The commit failure output shows the output of hooks that the user configured or approved, as a terminal run does. The rule below stays for logs: regex redaction cannot make hook output safe to log. So the output tail never enters a log, a `diagnostic`, or a progress event. On screen, the service removes control sequences and redacts URL user information (contract §9). A secret in another form can remain, as in a terminal.

Sources: [relative core.hooksPath](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/config/core.adoc#L512-L521), [hook working directory](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/githooks.adoc#L24-L28), [Windows program lookup](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/compat/mingw.c#L1993-L2021), [per-entry lookup](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/compat/mingw.c#L1908-L1928).

Preserve Git ownership checks. Never set `safe.directory=*`. Process-local safety flags must not rewrite user configuration or bypass required hooks.

Use argument arrays and literal path handling. `--` stops option parsing, but does not disable Git pathspec syntax. Do not accept renderer-provided patches, revisions, environments, or command strings.

Use shell-owned Windows Jobs for the service and individual Git operations. Start processes suspended, assign ownership, then resume them. Keep handles non-inheritable and disable breakaway.

**Lingering Jobs (2026-09-30 decision).** Git or hook processes from a mutation can outlive its Git process, as with command-line Git. The shell keeps such a Job in a lingering set (contract §6). It closes the Job when the Job becomes empty or the application closes. Cancellation, deadline expiry, and Interrupt and close still close the Job at once. Read Jobs never linger. The shell associates the completion port before it assigns the first process. Microsoft advises association while the Job is inactive, because messages for state changes during association can go missing. `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO` reports a Job whose active process count reached zero. Delivery of that message is not guaranteed; a missing message does not prove that the event did not occur. So the shell also reads `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION` for each lingering Job at each `ended` frame. The process handle can signal before Windows removes the child from the Job. The shell reads `JOBOBJECT_BASIC_PROCESS_ID_LIST` while it holds the child handle and leaves out the child PID (T370). A missed message keeps only an empty Job handle until application close, never a process. Kill-on-close at application close keeps SC-008.

Addition, 2026-09-30: a completion probe used PowerShell `7.6.6` and `System.Diagnostics.Process` with redirected pipes. A `post-commit` hook started `(sleep 8; echo late >&2) &` and exited. `git commit --file=-` exited after 253 ms, and stderr reached EOF after 8,339 ms. The late line arrived after the exit. So a process ends at its handle signal, and the shell discards later pipe bytes (contract §6 "Completion signal"). A completion at EOF would reach the 120-second deadline for a longer child and kill it. This probe is not qualification evidence. The shell also tags each mutation Job with its common-directory identity. Revoke trust closes the lingering Jobs with that tag. A cancellation during `reconciling`, or a revoke during a mutation, sets `endProcesses` on `ended`, so that Job never lingers.

Sources: [job limits and notifications](https://learn.microsoft.com/windows/win32/procthread/job-objects#job-limits-and-notifications), [completion port messages](https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-jobobject_associate_completion_port#remarks), [kill-on-close](https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information#members).

Job Objects are process-lifetime controls, not security sandboxes. Trusted code can use external services beyond normal child-process ownership. Qualify supported hook behavior and report this limit.

Retain only allowlisted diagnostic metadata. Arbitrary hook output can contain credentials. Regex redaction alone cannot guarantee safe logs.

After every mutation outcome, reread actual state. Report unexpected or unknown effects without rollback claims. Never retry automatically or remove a lock with uncertain ownership.

Sources: [configured hooks](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/config/hook.adoc#L8-L34), [hook discovery](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-hook.adoc#L115-L149), [conditional configuration](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/config.adoc#L85-L125), [filesystem monitors](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/config/core.adoc#L64-L82), [Windows Jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [suspended creation](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags).

**Heuristics review (2026-10-05)**: A review of the cloud track C6 tasks T080, T082, and T083 applied CLAUDE.md "No heuristics". The contract now holds these rules:

- §7 "Repository-controlled resolution": an identity match decides that a path lies inside a directory. A text comparison never proves that a path is outside.
- §7 "Program file digests": only ENOENT, ENOTDIR, and EISDIR mean `absent`. A directory cannot run as a hook or program. Any other open error fails the listing with `REPOSITORY_UNAVAILABLE`.
- §6 "Registration bootstrap": exit statuses of `symbolic-ref -q HEAD` and `show-ref --exists <ref>` decide the HEAD state. `show-ref --exists` exits 0 for an existing ref, 2 for a missing ref, and 1 for a failed lookup. Git 2.43.0 added it (git-show-ref(1)).
- §7 "Configuration file paths": two `git var` calls give the system and global candidate files. Git 2.42.0 added `GIT_CONFIG_SYSTEM` and `GIT_CONFIG_GLOBAL` to `git var` (git-var(1)). Exit 1 without output comes from `cmd_var` in `builtin/var.c` when Git reads no file of that kind.

These items needed new shell facts. The main session decided each one on 2026-10-05:

- The digest read follows links. Bun has no open without link following on Windows. T309 replaces this reader with `fileFacts`, which follows a link at most 8 hops by the contract §7 rule.
- Until T309, the Bun `lstat` reader cannot resolve links. Decision D2 is its interim rule, and it fails closed. A symbolic link gives `unchecked` with bound `link` and a session-only approval. A device or inode mismatch between `lstat` and the opened handle fails the listing.
- Contract §6 classifies `DUBIOUS_OWNERSHIP` and `NOT_A_REPOSITORY` by stderr prefix (R2 "Repository identity"). T310 replaces both with the merged refusal.
- Contract §12 used `rev-parse --verify -q HEAD` to find an unborn HEAD. Decision D29: a failed `rev-parse --verify` decides nothing. Only the `show-ref --exists` exit status decides unborn (2) or present (0).
- Contract §6 "File facts" records two limits of the shell walk. An SMB server can resolve a junction on its own side, where `OBJ_DONT_REPARSE` cannot see it. The walk also has no deadline and no cancel, as the identity request has none. Decision D30: T312 owns both limits.
  - T312 design, approved by the user and the main session on 2026-10-06. Each `identity` and `fileFacts` request is a walk with a 30-second deadline, the §5 "Other Git process deadline" of one step. The shell runs each walk on its own thread with a watchdog. Today the walk runs on the frame-reader thread, so a blocked open blocks every frame (`service.rs:202-231`, `process_requests.rs:628`, `:656`).
  - At the deadline, the shell replies `{type, callId, deadline: "deadline"}` with no facts or identities. The existing `cancel {callId}` frame stops a walk, and no reply follows. The runner returns `{stop: "deadline" | "canceled"}`, and each caller maps it to the outcome of a Git step deadline or a cancel at that call site.
  - To stop a walk, the shell sets a stop flag and calls `CancelSynchronousIo` on the walk thread. Microsoft Learn "Canceling Pending I/O Operations" allows this from any thread of the process and covers a blocked `CreateFile`. The thread handle from `CreateThread` has `THREAD_ALL_ACCESS`, so it holds the `THREAD_TERMINATE` right that `CancelSynchronousIo` needs. Both opens are synchronous (`file_facts.rs:241`, `bootstrap.rs:51-57`), and `CreateFileW` and `NtOpenFile` take no `OVERLAPPED`.
  - Rejected: a helper process per request, because thread exit uses the same `IoCancelIrp` path (Microsoft Learn "Canceling IRPs"). `TerminateThread` is rejected, because Microsoft calls it a last resort. A `limits` field in the request is rejected, because only tests would use it.
  - Known limit: "There is no guarantee that underlying drivers correctly support cancellation" (Microsoft Learn). A cancel can also come between the flag check and the next open. The walk thread then waits until its I/O returns, and no reply waits for it. The shell does not bound the count of such threads. A bound needs evidence first.
  - U1, verified on 2026-10-06 on Windows 11 build 26200 with NTFS. `CancelSynchronousIo` ends an `NtOpenFile` that waits on a batch oplock break. The open returns `STATUS_CANCELLED` (0xC0000120) within 1 ms, and the oplock stays held. Attribute-only opens break no batch oplock (MS-FSA 2.1.4.12), so only the digest data open waits. The T312 Rust tests R1 to R3 assert this. Without the `CancelSynchronousIo` call, each blocked walk thread stays blocked until the holder closes.
  - U3, verified on 2026-10-06 on Windows 11 build 26200 with NTFS. A `CreateProcessW` that waits on a batch oplock break makes more than one open, and `CancelSynchronousIo` ends each cancelable wait. The start then fails, and no process starts. In about 1 of 10 parallel runs, one wait is not cancelable. The `CancelSynchronousIo` call itself then waits until the oplock holder lets go, and the start then goes on. The T314 tests accept both outcomes.
  - SMB junction limit: it stays. An SMB2 CREATE carries a share-relative path (MS-SMB2 2.2.13), and MS-SMB2 3.3.5.9 forbids only server evaluation of symbolic links. So a server can resolve a junction itself. Git opens the same path through the same server, so the digest binds the bytes that Git runs. A junction text names a server path that the client cannot map, so detection would give only `unchecked` and bind no digest. No SMB probe ran (U2).
  - Sources: Microsoft Learn `CancelSynchronousIo`, "Canceling Pending I/O Operations", "Canceling IRPs", "Synchronous and Asynchronous I/O", `CreateThread`, MS-SMB2 2.2.13 and 3.3.5.9, MS-FSA 2.1.4.12.

Sources: [git-show-ref --exists](https://github.com/git/git/blob/v2.55.0/Documentation/git-show-ref.adoc), [git-symbolic-ref exit status](https://github.com/git/git/blob/v2.55.0/Documentation/git-symbolic-ref.adoc), [git-var paths](https://github.com/git/git/blob/v2.55.0/Documentation/git-var.adoc), [cmd_var](https://github.com/git/git/blob/v2.55.0/builtin/var.c).

### Watcher event source

**Decision**: T088 keeps Bun's built-in `fs.watch` with `recursive: true`. It adds no watcher library.

**Rationale**: Bun 1.4.3 watches recursively on Windows through `ReadDirectoryChangesW` (`src/runtime/node/win_watcher.rs:390-398` at commit c6da4a4d). Bun reports a buffer overflow as a `change` event with a `null` file name. On Windows, `win_watcher.rs:250-253` does this. On Linux, `test/js/node/watch/fs.watch.test.ts:624-625` shows it for `IN_Q_OVERFLOW`. On Linux, a nameless event on a recursive root gives an `undefined` name (`path_watcher.rs:1066`, `node_fs_watcher.rs:948`), and the service re-arms on it too. The service treats every event as a hint, and that event too. The contract §8 change tuple decides every change.

**Alternatives considered**:

- `@parcel/watcher` 2.6.0 (MIT). VS Code uses it. Rejected: its `index.js` loads the platform addon with a dynamic `require`. A `bun build --compile` executable cannot resolve that call (Bun docs `bundler/executables.mdx:886-896`, anomalyco/opencode#37686). It also adds one native `.node` binary per platform.
- `chokidar` 5.0.0. Rejected: its atomic-write and `awaitWriteFinish` logic depends on timing (CLAUDE.md "No heuristics"). The change tuple already decides every change.
- Rust `notify` 8.2.0. It is mature, and rust-analyzer, Deno, and Zed use it. Rejected for now: it moves the watch into the shell and adds an IPC path for hints. The thin-shell rule prefers the service.

**Revisit**: Open this decision again only when T161 or T075 shows missed hints that `fs.watch` cannot deliver.

Sources: [win_watcher.rs](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/runtime/node/win_watcher.rs#L250-L253), [recursive watch](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/runtime/node/win_watcher.rs#L390-L398), [overflow test](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/test/js/node/watch/fs.watch.test.ts#L624-L625), [executables doc](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/docs/bundler/executables.mdx#L886-L896), [opencode#37686](https://github.com/anomalyco/opencode/issues/37686).

## R6. Measurement evidence and reference environment

**Decision**: Measure installed release builds against fixed fixtures and budgets. Use Git Extensions as the SC-015 comparison baseline under matched conditions.

**Rationale**: Development-server timing, vendor package-size claims, and source architecture cannot establish desktop performance.

**Alternatives considered**: Browser-only benchmarks, different hardware, and incomplete process accounting. They cannot support the required comparison.

### Read-only host inventory

These observations identify a proposed performance reference. They do not establish a clean installation or any passing Windows scenario.

| Item | Observed value |
| --- | --- |
| OS | Windows 11 Enterprise 25H2, `10.0.26200.9457`, x64. |
| CPU | AMD Ryzen 7 5800H; 8 cores, 16 logical processors. |
| Memory | Nominal 32 GiB; OS reports `33,654,071,296` usable bytes. |
| Fixture drive | `D:` on Samsung SSD 970 EVO Plus 2TB, NVMe. |
| Active display | 2560×1440 at 165 Hz through AMD Radeon Graphics. |
| GPUs | AMD driver `27.20.21020.6001`; RTX 3060 Laptop GPU driver `32.0.15.9186`. |
| Defender | Antivirus and real-time protection enabled; engine product `4.18.26080.4`. |
| WebView2 | `153.0.4234.48`. On 2026-09-29, the host runs `154.0.4258.37`. That version is the admission minimum (plan.md). |
| Bun | `1.4.2`. |
| Rust / Cargo | `1.98.0`; Rust revision `88d9e12ae`, Cargo revision `797e8a9bc`. |
| Native compiler | Visual Studio 2026 `18.8.12009.203`; MSVC default `14.51.36231`. On 2026-09-29, `vswhere` reports Visual Studio 2026 `18.10.12217.157`. A Rust `x86_64-pc-windows-msvc` probe link with `/VERBOSE:LIB` selected MSVC toolset `14.51.36231`. Its `link.exe` banner reads `14.51.36260.0`. The probe also selected Windows SDK `10.0.26100.0` for `um` and `ucrt`. Visual Studio 2022 and 2019 toolsets are installed, but the probe did not select them. |
| Git Extensions | Installed file/product version `7.2.1.7`. |
| Baseline .NET | Windows Desktop Runtime `10.0.10` is installed. |
| Existing tools | WPR, WPA, Git, Bun, Rust, Cargo, Node, and Git Extensions are present. |
| Accessibility tools | Windows SDK `inspect.exe` and `AccEvent.exe` 10.0.26100.0 are present. Accessibility Insights for Windows and Colour Contrast Analyser are absent on 2026-09-29. No installation was attempted. |
| Unavailable on PATH | `tauri-driver` and `msedgedriver`. No installation was attempted. |

The Windows SDK is present. On 2026-09-29, the x64 `kernel32.Lib` exists for SDK 10.0.19041.0, 10.0.20348.0, 10.0.22000.0, 10.0.22621.0, and 10.0.26100.0. An example path is `C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\um\x64\kernel32.Lib`. Do not infer a complete build toolchain from Visual Studio registration. The probe linked `fn main(){}` in the scratch directory with `rustc --target x86_64-pc-windows-msvc -C link-arg=/VERBOSE:LIB`. The `Searching` lines named the MSVC and SDK library directories above. The probe wrote nothing into the repository.

**T001 toolchain check, 2026-10-02.** The check installed nothing and changed no tool. Every version meets its plan.md Technical Context minimum. Bun equals the exact runtime `1.4.2`.

| Tool | Command or source | Observed value | Minimum | Result |
| --- | --- | --- | --- | --- |
| Git | `git version --build-options` | `git version 2.55.0.windows.3`, `cpu: x86_64`, commit `52ca1113d651127f89477a8763f86ab20f645e1d` | `2.55.0.windows.3` | pass |
| Bun | `bun --version` | `1.4.2` | exactly `1.4.2` | pass |
| Rust | `rustc --version` | `rustc 1.98.0 (88d9e12ae 2026-08-18)` | `1.98.0` | pass |
| Cargo | `cargo --version` | `cargo 1.98.0 (797e8a9bc 2026-08-05)` | `1.98.0` | pass |
| Tauri CLI | `cargo tauri --version` | `tauri-cli 2.12.0` | `2.12.0` | pass |
| MSVC toolset | probe `Searching` path | `C:\Program Files\Microsoft Visual Studio\18\Professional\VC\Tools\MSVC\14.51.36231\lib\x64\msvcrt.lib` | `14.51.36231` | pass |
| Windows SDK | probe `Searching` path | `C:\Program Files (x86)\Windows Kits\10\lib\10.0.26100.0\um\x64\kernel32.lib` and `...\10.0.26100.0\ucrt\x64\ucrt.lib` | `10.0.26100.0` | pass |
| Linker | `link.exe` banner, Hostx64\x64 | `Microsoft (R) Incremental Linker Version 14.51.36260.0` | none | recorded |

The selected SDK x64 `kernel32.Lib` exists at `C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\um\x64\kernel32.Lib`. The probe linked `fn main(){}` with `rustc --target x86_64-pc-windows-msvc -C link-arg=/VERBOSE:LIB` in the session scratch directory, and the link exited with code 0. The probe wrote nothing into the repository.

**Batch 1 observations, 2026-10-03.** T065 copied these test and task records.

- T057, 2026-10-03: build 26200, product type 1 (`VER_NT_WORKSTATION`), native machine `0x8664`, scope `qualification-target`.
- T058, 2026-10-03: WebView2 runtime `154.0.4258.53` is admitted. The plan.md reference value is `154.0.4258.37`.
- T027, 2026-10-03: a tty hook commit ended after 117 ms (95 ms on a second run). A credential hook commit ended after 369 ms (302 ms). A PowerShell console wait ended at the 5 s deadline (5028 ms). An ssh-keygen console wait ended at the 5 s deadline (5018 ms). The T065 runs printed 139 ms and 120 ms (tty), 355 ms and 331 ms (credential), 5018 ms and 5015 ms (PowerShell), and 5019 ms and 5023 ms (ssh-keygen).

**T193 recordings, 2026-10-03.** The user recorded the installed package of build `9eaa7d1` in an elevated session. Each recording used WPR with `-filemode`. The analysis used `xperf -a process -withcmdline`, `xperf -a tracestats`, and a CSV filter of the dumped events. Times are relative to the creation of `arbareto.exe`. These are observations; no budget applies.

| Observation | Light: `GPU` and `arbareto.wprp!Arbareto.Light` | Verbose: `arbareto.wprp!Arbareto.Verbose` |
| --- | --- | --- |
| Trace length and lost events | 15.30 s, 0 lost | 16.29 s, 0 lost |
| `arbareto.exe` created, parent `explorer.exe` | 0 ms | 0 ms |
| Service `arbareto-git.exe` created, parent `arbareto.exe` | +54.9 ms | +49.7 ms |
| First `git.exe` start and end | +102.7 ms to +174.7 ms | +85.9 ms to +154.8 ms |
| WebView2 browser `msedgewebview2.exe` 154.0.4258.53 created | +136.0 ms | +115.8 ms |
| Service creation to browser creation | 81.1 ms | 66.1 ms |
| WebView2 GPU process created | +325.8 ms | +303.7 ms |
| WebView2 renderer created | +527.4 ms | +480.2 ms |
| First `Microsoft-Windows-DXGI` Present of the GPU process | +760.4 ms | +659.2 ms |
| `arbareto:boot-view` mark | Once, as `Microsoft.MSEdgeWebView/performance.mark`, at +1315.4 ms | Once, at +1156.8 ms |
| `toplevel` task events | None, as keyword `0x10000` intends | 684 Begin and 684 End events, the first at +581.9 ms |

- The first `git.exe` is the startup probe of the saved Git: `C:\Git\cmd\git.exe version --build-options`. In the Light trace, it started a child `git.exe` at +123.5 ms.
- In the Verbose trace, the mark appears on the renderer main thread. That thread emits `RendererMain.START_MSG_LOOP`.
- The `toplevel` task events appear on that thread with Begin and End phases. Their name is `ThreadControllerImpl::RunTask`. The `Edge_RunTask` events carry the same name in their name field.
- Each probe through the wrapper also started a `conhost.exe` about 11 ms after the inner `git.exe`. This finding led to the wrapper fix in 744b19b (R10 "Batch reviews").

**Informal Git process timings, 2026-10-04.** These timings are informal. They are not qualification evidence, and they change no budget. The method used PowerShell `Process.Start` with `CreateNoWindow`, with Defender on. Each value is the median of 20 runs. The host ran Git `2.56.0.windows.1`, not the reference version `2.55.0.windows.3`.

| Measurement | Median |
| --- | --- |
| A trivial process | 36 ms |
| `git.exe --version`, started directly | 55 ms |
| `git --version` through the `cmd\git.exe` wrapper | 74 ms |
| L without a commit-graph file: `rev-list --date-order --max-count=100` | 523 ms |
| L without a commit-graph file: `rev-list --max-count=100`, unordered | 60 ms |
| L without a commit-graph file: `rev-list --count`, a full walk of 100,000 commits | 505 ms |

- Without a commit-graph file, Git prints no `--date-order` row before the walk ends. Contract §3 keeps the date order, so a read cannot drop it.
- Cold start is WebView2-bound (T193 table above). Warm reopen and the 0.5 history ratio are Git-process-bound.
- Process estimate, unverified until T192 counts the processes: discovery starts about 4 processes. `readHistory` starts about 7 with its own trust listing, and about 5 with a shared listing (contract §7 "Shared listing"). These are `config list`, `rev-parse --git-path hooks`, `symbolic-ref`, `rev-parse`, the shallow path, `rev-list`, and `cat-file`.
- The trust listing runs no `hook list` (T280 record in R5). `readWorkspace` runs in parallel and repeats the trust listing (contract §7).
- About 11 serial processes run at up to 55 ms each. They exceed the 500 ms warm budget before any parsing.
- Unverified: the process count per read, the pack-handle risk of a persistent `cat-file`, and the fsmonitor daemon lifetime. The L history time with a commit-graph file is also unverified. It is expected near the 60 ms unordered floor. T192 and the probes T281 to T283 settle these items.

**Fixture L commit-graph decision (user, 2026-10-04).** T164 records L in two variants: with and without a commit-graph file. The budgets and comparisons count the maintained variant, which has the commit-graph file. When a history read must walk the whole graph, the app shows a copyable `git commit-graph write --reachable` remedy. The app never runs it. The reviewer defaults add no repair action (spec Clarifications), and the app never runs maintenance (plan.md "Selected mutation protocols"). The trigger rule, its contract clause, and its task stay open. They follow the contract §6 and §7 changes after the probes T280 to T283.

**Batch 2 observations, 2026-10-06.** T090 copied these T192 records from the batch 2 run at main `2b82dbb` (R10 "T090 batch 2 verification"). The host ran Git `2.56.0.windows.1`, not the reference version `2.55.0.windows.3`. CPU is the service process plus its Git children. These are observations; no budget applies here.

| Fixture | Read, 20 runs each | Median wall | Median CPU |
| --- | --- | --- | --- |
| M | check `full` | 412.2 ms | 546.6 ms |
| M | no-change poll, check `changes` | 8.6 ms | 15.0 ms |
| L | check `full` | 1456.2 ms | 1586.1 ms |
| L | no-change poll, check `changes` | 8.9 ms | 15.0 ms |

- `restoreWorkspace`, the first restore in a new service session: 125.6 ms on M and 127.8 ms on L.
- Git processes per read, on M and L, with and without a commit-graph file: discovery 4, trust listing 2, `readWorkspace` check `full` 5, and a no-change check `changes` 0. `readHistory` starts 7 with its own trust listing and 5 with a shared listing. These counts confirm the process estimate above.
- `readHistory` on L, median wall: 166.2 ms with its own listing and 168.1 ms with a shared listing, with a commit-graph file. Without the file: 626.7 ms and 634.9 ms.
- The T192 lines follow verbatim.

```text
OBSERVATION T192: R6 fixture M: 20 check "full" reads: median wall 412.2 ms, median CPU 546.6 ms (CPU = service process plus Git children)
OBSERVATION T192: R6 fixture M: 20 no-change check "changes" reads: median wall 8.6 ms, median CPU 15.0 ms (CPU = service process plus Git children)
OBSERVATION T192: R6 fixture M: restoreWorkspace wall time 125.6 ms (first restore in a new service session)
OBSERVATION T192: R6 fixture L: 20 check "full" reads: median wall 1456.2 ms, median CPU 1586.1 ms (CPU = service process plus Git children)
OBSERVATION T192: R6 fixture L: 20 no-change check "changes" reads: median wall 8.9 ms, median CPU 15.0 ms (CPU = service process plus Git children)
OBSERVATION T192: R6 fixture L: restoreWorkspace wall time 127.8 ms (first restore in a new service session)
OBSERVATION T192: R6 Git processes per read: fixture M with commit-graph: discovery: 20 reads, Git process count 4, median read wall 107.7 ms, median response bytes 286; per process: rev-parse --is-bare-repository --is-inside-git-dir: 20 runs, median CPU 15.6 ms, median wall 26.8 ms, max wall 37.7 ms; rev-parse --show-toplevel --absolute-git-dir --path-format=absolute --git-common-dir --git-path index --show-object-format --show-ref-format: 20 runs, median CPU 15.6 ms, median wall 26.8 ms, max wall 28.6 ms; symbolic-ref -q HEAD: 20 runs, median CPU 15.6 ms, median wall 26.7 ms, max wall 28.4 ms; show-ref --head --verify HEAD: 20 runs, median CPU 15.6 ms, median wall 26.6 ms, max wall 28.9 ms
OBSERVATION T192: R6 Git processes per read: fixture M with commit-graph: trust listing: 20 reads, Git process count 2, median read wall 62.9 ms, median response bytes 2945; per process: config list --show-scope --show-origin -z: 20 runs, median CPU 39.1 ms, median wall 48.4 ms, max wall 87.4 ms; rev-parse --git-path hooks: 20 runs, median CPU 46.9 ms, median wall 47.7 ms, max wall 82.1 ms
OBSERVATION T192: R6 Git processes per read: fixture M with commit-graph: readWorkspace check "full": 20 reads, Git process count 5, median read wall 421.3 ms, median response bytes 11472; per process: config list --show-scope --show-origin -z: 20 runs, median CPU 39.1 ms, median wall 48.6 ms, max wall 66.2 ms; rev-parse --git-path hooks: 20 runs, median CPU 31.3 ms, median wall 47.9 ms, max wall 64.2 ms; status --porcelain=v2 -z --branch --untracked-files=all --find-renames --ignore-submodules=dirty: 20 runs, median CPU 62.5 ms, median wall 66.6 ms, max wall 85.5 ms; ls-files -z --stage -v: 20 runs, median CPU 46.9 ms, median wall 135.6 ms, max wall 160.5 ms; symbolic-ref -q HEAD: 20 runs, median CPU 46.9 ms, median wall 49.4 ms, max wall 57.2 ms
OBSERVATION T192: R6 Git processes per read: fixture M with commit-graph: no-change readWorkspace check "changes": 20 reads, Git process count 0, median read wall 8.4 ms, median response bytes 11472; per process: none
OBSERVATION T192: R6 Git processes per read: fixture M with commit-graph: readHistory with its own trust listing: 20 reads, Git process count 7, median read wall 169.8 ms, median response bytes 24056; per process: symbolic-ref -q HEAD: 20 runs, median CPU 46.9 ms, median wall 55.1 ms, max wall 69.8 ms; rev-parse --verify -q HEAD: 20 runs, median CPU 46.9 ms, median wall 57.8 ms, max wall 76.7 ms; rev-parse --git-path shallow: 20 runs, median CPU 46.9 ms, median wall 59.4 ms, max wall 84.1 ms; config list --show-scope --show-origin -z: 20 runs, median CPU 46.9 ms, median wall 60.0 ms, max wall 86.9 ms; rev-parse --git-path hooks: 20 runs, median CPU 46.9 ms, median wall 49.2 ms, max wall 86.3 ms; rev-list --parents --max-count=100 --date-order <oid>: 20 runs, median CPU 31.3 ms, median wall 49.3 ms, max wall 75.9 ms; cat-file --batch-command -Z: 20 runs, median CPU 39.1 ms, median wall 49.6 ms, max wall 71.5 ms
OBSERVATION T192: R6 Git processes per read: fixture M with commit-graph: readHistory with a shared trust listing: 20 reads, Git process count 5, median read wall 160.3 ms, median response bytes 24056; per process: symbolic-ref -q HEAD: 20 runs, median CPU 46.9 ms, median wall 56.5 ms, max wall 71.6 ms; rev-parse --verify -q HEAD: 20 runs, median CPU 46.9 ms, median wall 52.9 ms, max wall 75.8 ms; rev-parse --git-path shallow: 20 runs, median CPU 46.9 ms, median wall 51.0 ms, max wall 72.6 ms; rev-list --parents --max-count=100 --date-order <oid>: 20 runs, median CPU 31.3 ms, median wall 49.3 ms, max wall 74.4 ms; cat-file --batch-command -Z: 20 runs, median CPU 31.3 ms, median wall 48.2 ms, max wall 62.3 ms
OBSERVATION T192: R6 Git processes per read: fixture M without commit-graph: discovery: 20 reads, Git process count 4, median read wall 107.6 ms, median response bytes 286; per process: rev-parse --is-bare-repository --is-inside-git-dir: 20 runs, median CPU 15.6 ms, median wall 26.3 ms, max wall 40.9 ms; rev-parse --show-toplevel --absolute-git-dir --path-format=absolute --git-common-dir --git-path index --show-object-format --show-ref-format: 20 runs, median CPU 15.6 ms, median wall 26.7 ms, max wall 45.5 ms; symbolic-ref -q HEAD: 20 runs, median CPU 15.6 ms, median wall 26.6 ms, max wall 41.3 ms; show-ref --head --verify HEAD: 20 runs, median CPU 15.6 ms, median wall 26.6 ms, max wall 30.1 ms
OBSERVATION T192: R6 Git processes per read: fixture M without commit-graph: trust listing: 20 reads, Git process count 2, median read wall 63.3 ms, median response bytes 2945; per process: config list --show-scope --show-origin -z: 20 runs, median CPU 46.9 ms, median wall 48.6 ms, max wall 60.2 ms; rev-parse --git-path hooks: 20 runs, median CPU 46.9 ms, median wall 47.9 ms, max wall 50.6 ms
OBSERVATION T192: R6 Git processes per read: fixture M without commit-graph: readWorkspace check "full": 20 reads, Git process count 5, median read wall 425.6 ms, median response bytes 11538; per process: config list --show-scope --show-origin -z: 20 runs, median CPU 31.3 ms, median wall 47.9 ms, max wall 58.2 ms; rev-parse --git-path hooks: 20 runs, median CPU 31.3 ms, median wall 47.6 ms, max wall 51.6 ms; status --porcelain=v2 -z --branch --untracked-files=all --find-renames --ignore-submodules=dirty: 20 runs, median CPU 62.5 ms, median wall 69.0 ms, max wall 83.8 ms; ls-files -z --stage -v: 20 runs, median CPU 62.5 ms, median wall 140.6 ms, max wall 164.3 ms; symbolic-ref -q HEAD: 20 runs, median CPU 46.9 ms, median wall 52.3 ms, max wall 61.2 ms
OBSERVATION T192: R6 Git processes per read: fixture M without commit-graph: no-change readWorkspace check "changes": 20 reads, Git process count 0, median read wall 8.3 ms, median response bytes 11538; per process: none
OBSERVATION T192: R6 Git processes per read: fixture M without commit-graph: readHistory with its own trust listing: 20 reads, Git process count 7, median read wall 190.2 ms, median response bytes 24056; per process: symbolic-ref -q HEAD: 20 runs, median CPU 46.9 ms, median wall 52.9 ms, max wall 80.5 ms; rev-parse --verify -q HEAD: 20 runs, median CPU 46.9 ms, median wall 58.0 ms, max wall 81.8 ms; rev-parse --git-path shallow: 20 runs, median CPU 46.9 ms, median wall 57.9 ms, max wall 86.4 ms; config list --show-scope --show-origin -z: 20 runs, median CPU 46.9 ms, median wall 57.5 ms, max wall 98.2 ms; rev-parse --git-path hooks: 20 runs, median CPU 46.9 ms, median wall 58.1 ms, max wall 71.8 ms; rev-list --parents --max-count=100 --date-order <oid>: 20 runs, median CPU 62.5 ms, median wall 71.2 ms, max wall 88.1 ms; cat-file --batch-command -Z: 20 runs, median CPU 31.3 ms, median wall 49.5 ms, max wall 51.0 ms
OBSERVATION T192: R6 Git processes per read: fixture M without commit-graph: readHistory with a shared trust listing: 20 reads, Git process count 5, median read wall 180.8 ms, median response bytes 24056; per process: symbolic-ref -q HEAD: 20 runs, median CPU 46.9 ms, median wall 56.9 ms, max wall 82.3 ms; rev-parse --verify -q HEAD: 20 runs, median CPU 46.9 ms, median wall 53.4 ms, max wall 78.5 ms; rev-parse --git-path shallow: 20 runs, median CPU 46.9 ms, median wall 50.3 ms, max wall 75.6 ms; rev-list --parents --max-count=100 --date-order <oid>: 20 runs, median CPU 62.5 ms, median wall 70.1 ms, max wall 81.6 ms; cat-file --batch-command -Z: 20 runs, median CPU 31.3 ms, median wall 49.1 ms, max wall 60.7 ms
OBSERVATION T192: R6 Git processes per read: fixture L with commit-graph: discovery: 20 reads, Git process count 4, median read wall 108.1 ms, median response bytes 286; per process: rev-parse --is-bare-repository --is-inside-git-dir: 20 runs, median CPU 15.6 ms, median wall 26.1 ms, max wall 28.1 ms; rev-parse --show-toplevel --absolute-git-dir --path-format=absolute --git-common-dir --git-path index --show-object-format --show-ref-format: 20 runs, median CPU 15.6 ms, median wall 26.4 ms, max wall 29.4 ms; symbolic-ref -q HEAD: 20 runs, median CPU 15.6 ms, median wall 26.8 ms, max wall 37.7 ms; show-ref --head --verify HEAD: 20 runs, median CPU 15.6 ms, median wall 26.4 ms, max wall 28.0 ms
OBSERVATION T192: R6 Git processes per read: fixture L with commit-graph: trust listing: 20 reads, Git process count 2, median read wall 61.0 ms, median response bytes 2945; per process: config list --show-scope --show-origin -z: 20 runs, median CPU 39.1 ms, median wall 47.1 ms, max wall 69.0 ms; rev-parse --git-path hooks: 20 runs, median CPU 31.3 ms, median wall 47.0 ms, max wall 50.0 ms
OBSERVATION T192: R6 Git processes per read: fixture L with commit-graph: readWorkspace check "full": 20 reads, Git process count 5, median read wall 1444.7 ms, median response bytes 11472; per process: config list --show-scope --show-origin -z: 20 runs, median CPU 46.9 ms, median wall 48.4 ms, max wall 69.8 ms; rev-parse --git-path hooks: 20 runs, median CPU 31.3 ms, median wall 47.9 ms, max wall 86.8 ms; status --porcelain=v2 -z --branch --untracked-files=all --find-renames --ignore-submodules=dirty: 20 runs, median CPU 273.4 ms, median wall 89.2 ms, max wall 101.5 ms; ls-files -z --stage -v: 20 runs, median CPU 93.8 ms, median wall 529.3 ms, max wall 545.8 ms; symbolic-ref -q HEAD: 20 runs, median CPU 39.1 ms, median wall 51.1 ms, max wall 69.9 ms
OBSERVATION T192: R6 Git processes per read: fixture L with commit-graph: no-change readWorkspace check "changes": 20 reads, Git process count 0, median read wall 8.2 ms, median response bytes 11472; per process: none
OBSERVATION T192: R6 Git processes per read: fixture L with commit-graph: readHistory with its own trust listing: 20 reads, Git process count 7, median read wall 166.2 ms, median response bytes 24156; per process: symbolic-ref -q HEAD: 20 runs, median CPU 46.9 ms, median wall 52.9 ms, max wall 66.3 ms; rev-parse --verify -q HEAD: 20 runs, median CPU 46.9 ms, median wall 58.5 ms, max wall 72.1 ms; rev-parse --git-path shallow: 20 runs, median CPU 46.9 ms, median wall 58.2 ms, max wall 72.9 ms; config list --show-scope --show-origin -z: 20 runs, median CPU 46.9 ms, median wall 59.7 ms, max wall 79.1 ms; rev-parse --git-path hooks: 20 runs, median CPU 46.9 ms, median wall 50.6 ms, max wall 69.5 ms; rev-list --parents --max-count=100 --date-order <oid>: 20 runs, median CPU 31.3 ms, median wall 49.6 ms, max wall 66.5 ms; cat-file --batch-command -Z: 20 runs, median CPU 31.3 ms, median wall 48.8 ms, max wall 49.9 ms
OBSERVATION T192: R6 Git processes per read: fixture L with commit-graph: readHistory with a shared trust listing: 20 reads, Git process count 5, median read wall 168.1 ms, median response bytes 24156; per process: symbolic-ref -q HEAD: 20 runs, median CPU 46.9 ms, median wall 66.5 ms, max wall 77.3 ms; rev-parse --verify -q HEAD: 20 runs, median CPU 46.9 ms, median wall 62.1 ms, max wall 70.3 ms; rev-parse --git-path shallow: 20 runs, median CPU 46.9 ms, median wall 58.7 ms, max wall 66.4 ms; rev-list --parents --max-count=100 --date-order <oid>: 20 runs, median CPU 31.3 ms, median wall 49.1 ms, max wall 70.1 ms; cat-file --batch-command -Z: 20 runs, median CPU 31.3 ms, median wall 48.3 ms, max wall 51.2 ms
OBSERVATION T192: R6 Git processes per read: fixture L without commit-graph: discovery: 20 reads, Git process count 4, median read wall 109.5 ms, median response bytes 286; per process: rev-parse --is-bare-repository --is-inside-git-dir: 20 runs, median CPU 15.6 ms, median wall 27.1 ms, max wall 46.8 ms; rev-parse --show-toplevel --absolute-git-dir --path-format=absolute --git-common-dir --git-path index --show-object-format --show-ref-format: 20 runs, median CPU 15.6 ms, median wall 27.1 ms, max wall 43.2 ms; symbolic-ref -q HEAD: 20 runs, median CPU 15.6 ms, median wall 27.0 ms, max wall 29.3 ms; show-ref --head --verify HEAD: 20 runs, median CPU 15.6 ms, median wall 27.1 ms, max wall 45.5 ms
OBSERVATION T192: R6 Git processes per read: fixture L without commit-graph: trust listing: 20 reads, Git process count 2, median read wall 62.7 ms, median response bytes 2945; per process: config list --show-scope --show-origin -z: 20 runs, median CPU 31.3 ms, median wall 48.0 ms, max wall 64.8 ms; rev-parse --git-path hooks: 20 runs, median CPU 31.3 ms, median wall 47.9 ms, max wall 50.1 ms
OBSERVATION T192: R6 Git processes per read: fixture L without commit-graph: readWorkspace check "full": 20 reads, Git process count 5, median read wall 1548.4 ms, median response bytes 11538; per process: config list --show-scope --show-origin -z: 20 runs, median CPU 39.1 ms, median wall 61.6 ms, max wall 84.1 ms; rev-parse --git-path hooks: 20 runs, median CPU 31.3 ms, median wall 58.5 ms, max wall 87.5 ms; status --porcelain=v2 -z --branch --untracked-files=all --find-renames --ignore-submodules=dirty: 20 runs, median CPU 226.6 ms, median wall 91.7 ms, max wall 98.6 ms; ls-files -z --stage -v: 20 runs, median CPU 101.6 ms, median wall 510.1 ms, max wall 538.2 ms; symbolic-ref -q HEAD: 20 runs, median CPU 46.9 ms, median wall 59.1 ms, max wall 77.3 ms
OBSERVATION T192: R6 Git processes per read: fixture L without commit-graph: no-change readWorkspace check "changes": 20 reads, Git process count 0, median read wall 9.5 ms, median response bytes 11538; per process: none
OBSERVATION T192: R6 Git processes per read: fixture L without commit-graph: readHistory with its own trust listing: 20 reads, Git process count 7, median read wall 626.7 ms, median response bytes 24156; per process: symbolic-ref -q HEAD: 20 runs, median CPU 46.9 ms, median wall 56.7 ms, max wall 71.8 ms; rev-parse --verify -q HEAD: 20 runs, median CPU 46.9 ms, median wall 57.8 ms, max wall 66.0 ms; rev-parse --git-path shallow: 20 runs, median CPU 46.9 ms, median wall 58.8 ms, max wall 69.6 ms; config list --show-scope --show-origin -z: 20 runs, median CPU 46.9 ms, median wall 60.5 ms, max wall 73.6 ms; rev-parse --git-path hooks: 20 runs, median CPU 46.9 ms, median wall 54.5 ms, max wall 69.0 ms; rev-list --parents --max-count=100 --date-order <oid>: 20 runs, median CPU 500.0 ms, median wall 506.2 ms, max wall 1078.2 ms; cat-file --batch-command -Z: 20 runs, median CPU 46.9 ms, median wall 49.8 ms, max wall 69.2 ms
OBSERVATION T192: R6 Git processes per read: fixture L without commit-graph: readHistory with a shared trust listing: 20 reads, Git process count 5, median read wall 634.9 ms, median response bytes 24156; per process: symbolic-ref -q HEAD: 20 runs, median CPU 46.9 ms, median wall 75.2 ms, max wall 100.7 ms; rev-parse --verify -q HEAD: 20 runs, median CPU 46.9 ms, median wall 70.7 ms, max wall 106.7 ms; rev-parse --git-path shallow: 20 runs, median CPU 46.9 ms, median wall 65.9 ms, max wall 97.2 ms; rev-list --parents --max-count=100 --date-order <oid>: 20 runs, median CPU 484.4 ms, median wall 501.4 ms, max wall 530.2 ms; cat-file --batch-command -Z: 20 runs, median CPU 31.3 ms, median wall 49.8 ms, max wall 70.0 ms
```

**T357 `readRefs` observations, 2026-10-11.** These T192 records come from full run 3 at main `2102871` (R10 "T117 batch 3 verification"). The host ran Git `2.56.0.windows.1`. These are observations; no budget applies here.

- `readRefs` starts 3 Git processes with its own trust listing: `for-each-ref`, `config list`, and `rev-parse --git-path hooks`. With a shared listing, it starts only `for-each-ref`.
- Median read wall on M, own and shared listing: 83.6 ms and 68.7 ms with a commit-graph file, 89.4 ms and 67.0 ms without it.
- Median read wall on L, own and shared listing: 161.4 ms and 142.1 ms with a commit-graph file, 147.2 ms and 140.5 ms without it.
- Median response bytes: 9127 on M and 70951 on L.

Control mutation, 2026-10-11, worktree `D:\dev\rozvio-l6` at main `eec348d`:

- A first edit let `parseRefs` in `src/git-service/refs-parser.ts` pass a record of 7 or 8 fields. `bun test tests/git/refs.test.ts` stayed green: 18 pass, 0 fail. The HEAD check still refused the record, because the eighth field was absent.
- The second edit added the missing HEAD field `" "` to a seven-field record before the field count check. So the parser accepted the record.
- The same command then exited 1: 17 pass, 1 fail. The case "each broken record rule gives failed with MALFORMED_GIT_OUTPUT and no records" failed at `refs.test.ts:338`. Its "a record holds seven fields" entry gave `succeeded`.
- The undo restored the file. Its SHA-256 `a30b65d7ffddbfe2c403b3420e6c1654941e74e979bd3337cea06f6ba9522c71` matched the copy before the edit, and `git status --short` was empty.
- The same command then exited 0: 18 pass, 0 fail.
- Both runs printed `git version 2.56.0.windows.1` at `C:\Git\ucrt64\bin\git.exe`. Both printed 14 `ORIGIN` lines under `D:\dev\rozvio-l6\src`, with `refs-parser.ts`, `refs.ts`, `commands.ts`, `git-runner.ts`, and `session.ts` under `src\git-service`.

The T192 `readRefs` lines follow verbatim.

```text
OBSERVATION T192: R6 Git processes per read: fixture M with commit-graph: readRefs with its own trust listing: 20 reads, Git process count 3, median read wall 83.6 ms, median response bytes 9127; per process: for-each-ref --format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(symref)%00%(upstream)%00%(HEAD) refs/heads refs/remotes refs/tags: 20 runs, median CPU 62.5 ms, median wall 83.0 ms, max wall 109.0 ms; config list --show-scope --show-origin -z: 20 runs, median CPU 46.9 ms, median wall 60.7 ms, max wall 84.7 ms; rev-parse --git-path hooks: 20 runs, median CPU 46.9 ms, median wall 60.7 ms, max wall 81.6 ms
OBSERVATION T192: R6 Git processes per read: fixture M with commit-graph: readRefs with a shared trust listing: 20 reads, Git process count 1, median read wall 68.7 ms, median response bytes 9127; per process: for-each-ref --format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(symref)%00%(upstream)%00%(HEAD) refs/heads refs/remotes refs/tags: 20 runs, median CPU 62.5 ms, median wall 67.9 ms, max wall 115.8 ms
OBSERVATION T192: R6 Git processes per read: fixture M without commit-graph: readRefs with its own trust listing: 20 reads, Git process count 3, median read wall 89.4 ms, median response bytes 9127; per process: for-each-ref --format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(symref)%00%(upstream)%00%(HEAD) refs/heads refs/remotes refs/tags: 20 runs, median CPU 62.5 ms, median wall 86.2 ms, max wall 135.3 ms; config list --show-scope --show-origin -z: 20 runs, median CPU 46.9 ms, median wall 60.8 ms, max wall 125.2 ms; rev-parse --git-path hooks: 20 runs, median CPU 46.9 ms, median wall 61.1 ms, max wall 113.1 ms
OBSERVATION T192: R6 Git processes per read: fixture M without commit-graph: readRefs with a shared trust listing: 20 reads, Git process count 1, median read wall 67.0 ms, median response bytes 9127; per process: for-each-ref --format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(symref)%00%(upstream)%00%(HEAD) refs/heads refs/remotes refs/tags: 20 runs, median CPU 62.5 ms, median wall 66.3 ms, max wall 111.4 ms
OBSERVATION T192: R6 Git processes per read: fixture L with commit-graph: readRefs with its own trust listing: 20 reads, Git process count 3, median read wall 161.4 ms, median response bytes 70951; per process: for-each-ref --format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(symref)%00%(upstream)%00%(HEAD) refs/heads refs/remotes refs/tags: 20 runs, median CPU 156.3 ms, median wall 160.2 ms, max wall 338.1 ms; config list --show-scope --show-origin -z: 20 runs, median CPU 46.9 ms, median wall 59.6 ms, max wall 131.9 ms; rev-parse --git-path hooks: 20 runs, median CPU 46.9 ms, median wall 58.6 ms, max wall 154.7 ms
OBSERVATION T192: R6 Git processes per read: fixture L with commit-graph: readRefs with a shared trust listing: 20 reads, Git process count 1, median read wall 142.1 ms, median response bytes 70951; per process: for-each-ref --format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(symref)%00%(upstream)%00%(HEAD) refs/heads refs/remotes refs/tags: 20 runs, median CPU 125.0 ms, median wall 141.0 ms, max wall 195.3 ms
OBSERVATION T192: R6 Git processes per read: fixture L without commit-graph: readRefs with its own trust listing: 20 reads, Git process count 3, median read wall 147.2 ms, median response bytes 70951; per process: for-each-ref --format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(symref)%00%(upstream)%00%(HEAD) refs/heads refs/remotes refs/tags: 20 runs, median CPU 140.6 ms, median wall 146.1 ms, max wall 193.6 ms; config list --show-scope --show-origin -z: 20 runs, median CPU 46.9 ms, median wall 52.8 ms, max wall 69.1 ms; rev-parse --git-path hooks: 20 runs, median CPU 46.9 ms, median wall 50.1 ms, max wall 63.3 ms
OBSERVATION T192: R6 Git processes per read: fixture L without commit-graph: readRefs with a shared trust listing: 20 reads, Git process count 1, median read wall 140.5 ms, median response bytes 70951; per process: for-each-ref --format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(symref)%00%(upstream)%00%(HEAD) refs/heads refs/remotes refs/tags: 20 runs, median CPU 125.0 ms, median wall 138.9 ms, max wall 220.9 ms
```

Git Extensions `v7.2.1` resolves to `0aea2d6df4c120806c46f1797ba6a45f5d14b345`. Its Windows release includes x64 MSI and portable artifacts. Its release notes require .NET Desktop `10.0.9` or later `10.x` and recommend Git `2.53.0` or later.

Source: [Git Extensions release](https://github.com/gitextensions/gitextensions/releases/tag/v7.2.1).

Give each application a separate WebView2 user-data directory. Include its browser, renderer, GPU, utility, service, Git, and owned helper processes.

Report summed private bytes separately from summed working sets. Shared pages can appear in multiple working sets. Include exited child-process CPU time, not only surviving processes.

Closed question, 2026-09-30: the 1-second foreground poll re-read full status, trust, and the index digest on every tick. On fixture L, polls could run back to back against the 1% idle CPU budget. The poll now runs a stat change check first (contract §8 "Change check"). Without a hint or a change, it starts no Git process. Focus return, manual refresh, and watcher hints still run full reads. T192 records full-read and change-check CPU time on M and L in batch 2. T169 measures the packaged idle CPU. A missed budget stays `fail`.

**History-ready, Commit-panel-ready, Details-ready, and References-ready markers (SC-006, the selection rows, and the references row).** The renderer calls `performance.mark("arbareto:history-painted")` when the plan.md History-ready state commits. Every open ends there (spec FR-034). It calls `performance.mark("arbareto:commit-panel-ready")` when the Commit-panel-ready state commits after a Working directory or Index selection. It calls `arbareto:details-ready` after a commit selection and `arbareto:refs-ready` after a paired reference read (plan.md "Marker and frame source"). The 2026-10-01 name `arbareto:changes-ready` is retired. Chromium exports user timing marks to ETW under the category `blink.user_timing`, keyword `0x10000` (etw_interceptor_win.cc:106, revision `f77ee1168aca5bac8a0a24ab92867858321f5c12`). Microsoft's `WebView2.wprp` enables the WebView2 provider `E16EC3D2-BB0F-4E8F-BDB8-DE0BEA82DC3D` with keyword `0x3F0000054404`, which includes that bit. Its stable Edge provider keyword `0x10000000202F` does not. The owned profile `tests/windows/arbareto.wprp` (T193) enables only that WebView2 provider. Its `Arbareto.Light` level uses keyword `0x10000` for the timing series, and its `Arbareto.Verbose` level uses `0x10200` for the stall workloads. WPR selects a level with `<file>.wprp!<Name>.light` or `.verbose` (Microsoft Learn "WPR Command-Line Options"). WPR runs it together with the built-in `GPU` profile. The same table maps `toplevel` to bit `0x200` (etw_interceptor_win.cc:99). That category carries Chromium's task events, which plan.md "Responsiveness metrics" uses for long tasks. The `arbareto:history-painted` mark uses the same `blink.user_timing` path. T193 and T165 confirm whether the installed runtime emits the marks and the task events through that provider. The task event name and its begin and end fields are unverified until T193 reports them. Profile source: WebView2Feedback commit `874307a3f444dec048f9cfead987ea263d78086e`, `diagnostics/resources/WebView2.wprp`.

Marker sources: [Chromium ETW keywords](https://github.com/chromium/chromium/blob/f77ee1168aca5bac8a0a24ab92867858321f5c12/base/trace_event/etw_interceptor_win.cc#L99-L106), [WebView2 profile](https://github.com/MicrosoftEdge/WebView2Feedback/blob/874307a3f444dec048f9cfead987ea263d78086e/diagnostics/resources/WebView2.wprp), [WebView2 ETW guidance](https://learn.microsoft.com/microsoft-edge/webview2/concepts/performance#telemetry-and-profiling-tools).

**Input injection and frame timing (SC-005, SC-006, SC-015).** Input injection uses the test-only script `tests/windows/inject.ts` (T165). It calls the Windows `SendInput` API through `bun:ffi`. R2 allows `bun:ffi` in tests, not in production. The script needs no installation. It records the QueryPerformanceCounter value at each injection. Arbareto's absolute budgets take presented-frame timing from the WPR trace with GPU and DXGI present events. SC-005, SC-007, and SC-015 take it from the capture source below. On 2026-09-29, `wpr -profiles` on the reference host lists the built-in `GPU` profile (WPR `10.0.26100`). `wpr -profiledetails GPU` lists the `Microsoft-Windows-DXGI` and `Microsoft-Windows-DxgKrnl` providers. The `DesktopComposition` profile lists `Microsoft-Windows-Dwm-Core`. Present-event coverage for WebView2 frames stays unverified until T165 confirms it. Any tool installation needs explicit maintainer approval, recorded in this section.

**Capture source for both applications (SC-015, SC-005, SC-007).** Git Extensions is a WinForms application, so a WebView2 DXGI Present event cannot time it. Both applications therefore use DXGI Desktop Duplication through the test-only script `tests/windows/capture.ts` (T242). Microsoft Learn states these facts, read on 2026-10-01:

- `IDXGIOutput1::DuplicateOutput` creates the duplication from a device on the adapter of the output. By default, only four processes in one session can duplicate outputs; a fifth call gives `DXGI_ERROR_NOT_CURRENTLY_AVAILABLE`. The secure desktop needs `LOCAL_SYSTEM` and gives `E_ACCESSDENIED` otherwise.
- `IDXGIOutputDuplication::AcquireNextFrame` takes a time-out in milliseconds. It returns `DXGI_ERROR_WAIT_TIMEOUT` without a new frame and `DXGI_ERROR_ACCESS_LOST` after a desktop switch or a mode change.
- `DXGI_OUTDUPL_FRAME_INFO.LastPresentTime` is the time of the last desktop image update, which the OS takes from QueryPerformanceCounter. A value of zero means no image update since the previous acquisition. A pointer-only update sets it to zero.
- `AccumulatedFrames` of one means that the caller processed the previous image before a new one arrived. A larger value means that the OS merged several updates.

So the capture time base equals the `inject.ts` time base. The plan.md "Capture source" section derives Δ, the end frame, and the run uncertainty from these facts. No capture has run yet.

Capture sources: [DuplicateOutput](https://learn.microsoft.com/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutput1-duplicateoutput), [AcquireNextFrame](https://learn.microsoft.com/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutputduplication-acquirenextframe), [DXGI_OUTDUPL_FRAME_INFO](https://learn.microsoft.com/windows/win32/api/dxgi1_2/ns-dxgi1_2-dxgi_outdupl_frame_info), [DuplicateOutput1](https://learn.microsoft.com/windows/win32/api/dxgi1_5/nf-dxgi1_5-idxgioutput5-duplicateoutput1).

**Diff context and C8 (T164, T180, T181).** These facts fix the C8 content for both applications:

- A probe on 2026-10-01 with Git `2.55.0.windows.3` changed lines 20 and 28 of a 40-line file. `diff-files -p` printed two hunks with 3 context lines, with and without `-c diff.context=10`.
- `-c diff.interHunkContext=10` also left two hunks. Porcelain `git diff` honored both keys and merged the changes into one hunk. So Arbareto's plumbing reads always show 3 context lines, whatever the user's configuration.
- Git Extensions (DeepWiki answer, 2026-10-01): `AppSettings.NumberOfContextLines` defaults to 3. The viewer passes it as `--unified=<n>` while `ShowEntireFile` is false. `ShowSyntaxHighlightingInDiff` defaults to true.
- The answer did not settle which header lines the viewer shows. So T180 counts its visible diff rows below any header lines.
- plan.md "C8 rows" derives 25 compact and 20 comfortable Arbareto diff rows at 1280×800. The C8 diff holds 18 rows. No application ran for these figures.

**UI Automation driver (T153, T240, T241).** `tauri-driver` and `msedgedriver` are absent (inventory above). The test-only driver `tests/windows/uia.ts` uses UI Automation instead. Microsoft Learn states that a Win32 app shows WebView2 in the accessibility tree as a child of its parent window. It states that Microsoft Edge exposes ARIA roles, states, and properties through UI Automation. It also states that UI Automation does not connect processes that different users start. So the driver runs under the measurement account. T241 confirms each control name on the reference host with the driver and `inspect.exe`. When a name does not resolve, the T241 keyboard fallback covers T153, T167, T181, and T245. C7 then stays `unverified`.

**T240 driver observations, 2026-10-11.** The T240 run of `tests/windows/uia.test.ts` against the installed app gave these facts. They are not qualification evidence.

- WebView2 web content appears in UI Automation only after the first UI Automation request. It appeared 1.4 to 5.8 seconds after the start.
- The web elements belong to the process `msedgewebview2.exe`, not to the app process. So `waitFocus` checks the process of the top-level window.
- The folder picker and the Git task dialog are descendants of the main window.
- A `role="status"` region has an empty Name and LiveSetting Polite. So `findLiveRegions` finds the status regions by LiveSetting.

Driver sources: [WebView2 accessibility tree](https://learn.microsoft.com/microsoft-edge/webview2/concepts/overview-features-apis#rendering-webview2-using-composition), [ARIA and UI Automation in Microsoft Edge](https://learn.microsoft.com/microsoft-edge/accessibility/build/aria-and-ui-automation), [UI Automation overview](https://learn.microsoft.com/windows/win32/winauto/uiauto-uiautomationoverview).

Use the same capture method for baseline and candidate. An elevated trace collector does not qualify elevated application behavior. Run the application and installer as a standard user.

Sources: [WebView2 process grouping](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model), [Windows memory accounting](https://learn.microsoft.com/en-us/windows/win32/psapi/process-memory-usage-information), [CPU accounting](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes), [WPR](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/windows-performance-recorder).

### Test run time, 2026-10-07 (T324)

**Baseline.** One serial run of `bun test tests/contracts tests/git tests/wsl --reporter=junit` at main `d3022b0`, with `ARBARETO_WSL_DISTRO=Ubuntu-26.04`. The host had 16 logical processors, 32 GB of memory, Bun 1.4.2, and Git `2.56.0.windows.1`. This was the first full run with the T091, T194, and T220 fixture builders. Result: 50 files, 2408 tests, 2356 pass, 21 skip, 31 todo, 0 fail, 3648 s. `tests/wsl/registration.test.ts` on `Ubuntu-24.04`: 32 pass, 4 skip, 0 fail, 28 s.

| File | Tests | Seconds |
| --- | --- | --- |
| `tests/git/fixtures.test.ts` | 135 | 1464.6 |
| `tests/git/poll-cost.test.ts` | 12 | 603.1 |
| `tests/git/trust.test.ts` | 116 | 248.7 |
| `tests/git/history-parser.test.ts` | 80 | 202.5 |
| `tests/git/discovery.test.ts` | 39 | 193.1 |
| `tests/git/status-parser.test.ts` | 123 | 156.6 |
| `tests/git/status.test.ts` | 37 | 126.4 |
| `tests/git/external-changes.test.ts` | 46 | 121.0 |
| `tests/git/read-lifecycle.test.ts` | 17 | 88.6 |
| `tests/wsl/reads.test.ts` | 8 | 76.9 |
| `tests/git/history.test.ts` | 33 | 66.8 |
| `tests/git/read-inputs.test.ts` | 18 | 63.8 |
| `tests/wsl/registration.test.ts` | 36 | 46.2 |
| `tests/git/git-installation.test.ts` | 20 | 36.3 |
| `tests/git/snapshot.test.ts` | 16 | 22.9 |
| `tests/git/eligibility.test.ts` | 12 | 22.4 |
| `tests/wsl/lifecycle.test.ts` | 6 | 19.4 |
| `tests/contracts/remedy-command.test.ts` | 190 | 15.5 |
| `tests/git/diagnostics.test.ts` | 5 | 13.2 |
| `tests/wsl/file-facts.test.ts` | 5 | 13.1 |
| `tests/contracts/service-boundary.test.ts` | 74 | 9.7 |
| `tests/git/identity.test.ts` | 8 | 8.3 |
| `tests/wsl/trust.test.ts` | 9 | 7.8 |
| `tests/git/bun-runner.test.ts` | 17 | 5.9 |
| `tests/contracts/git-commands.test.ts` | 74 | 3.0 |
| `tests/git/git-oracle.test.ts` | 1 | 2.4 |
| `tests/contracts/vectors.test.ts` | 190 | 1.9 |
| `tests/git/service-harness.test.ts` | 4 | 1.7 |
| `tests/git/file-facts.test.ts` | 19 | 1.3 |
| `tests/git/portable-imports.test.ts` | 19 | 1.2 |
| `tests/git/fixture-root.test.ts` | 5 | 0.8 |
| `tests/contracts/bridge.test.ts` | 15 | 0.7 |
| `tests/contracts/session-startup.test.ts` | 11 | 0.6 |
| `tests/contracts/native-path.test.ts` | 98 | 0.5 |
| `tests/contracts/boot-view.test.tsx` | 14 | 0.4 |
| `tests/contracts/native-runner.test.ts` | 58 | 0.3 |
| `tests/contracts/log.test.ts` | 26 | 0.2 |
| `tests/wsl/identity-order.test.ts` | 1 | 0.2 |
| `tests/contracts/schemas.test.ts` | 12 | 0.1 |
| `tests/contracts/admission.test.ts` | 27 | 0.1 |
| `tests/contracts/fold-ascii.test.ts` | 3 | 0.1 |
| `tests/contracts/envelope.test.ts` | 471 | 0.1 |
| `tests/contracts/file-action.test.ts` | 37 | 0.1 |
| `tests/contracts/operation-registry.test.ts` | 14 | 0.0 |
| `tests/contracts/environment.test.ts` | 13 | 0.0 |
| `tests/contracts/submodules.test.ts` | 54 | 0.0 |
| `tests/contracts/identity.test.ts` | 9 | 0.0 |
| `tests/contracts/operation-states.test.ts` | 82 | 0.0 |
| `tests/contracts/wsl-route.test.ts` | 28 | 0.0 |
| `tests/contracts/strict-json.test.ts` | 61 | 0.0 |

The 25 slowest cases:

| Case | File | Seconds |
| --- | --- | --- |
| OBSERVATION L without commit-graph: Git process count, process times, and response bytes of 20 reads of each kind | `tests/git/poll-cost.test.ts` | 193.4 |
| L: with no hint and an unchanged stat tuple, a check "changes" read starts no Git process and returns the same snapshotId and generation | `tests/git/poll-cost.test.ts` | 93.4 |
| OBSERVATION L with commit-graph: Git process count, process times, and response bytes of 20 reads of each kind | `tests/git/poll-cost.test.ts` | 84.6 |
| F16 status over-limit | `tests/git/fixtures.test.ts` | 67.9 |
| F16 status at-limit | `tests/git/fixtures.test.ts` | 66.9 |
| OBSERVATION M without commit-graph: Git process count, process times, and response bytes of 20 reads of each kind | `tests/git/poll-cost.test.ts` | 61.1 |
| F16 over-limit: 100000 records plus one from real Git give limited with reason STATUS_LISTING_RECORDS | `tests/git/status-parser.test.ts` | 44.6 |
| F16 at-limit: the whole output parses complete and equals the git-status(1) record rules | `tests/git/status-parser.test.ts` | 44.3 |
| F30 silent-fetch | `tests/git/fixtures.test.ts` | 43.0 |
| OBSERVATION M with commit-graph: Git process count, process times, and response bytes of 20 reads of each kind | `tests/git/poll-cost.test.ts` | 41.4 |
| F30 clone | `tests/git/fixtures.test.ts` | 41.4 |
| F16: exactly 100000 records give a complete result in pages within the Status page bound; each readEntries page ends succeeded while a readHistory and a readWorkspace of the workspace wait at the stdout barrier | `tests/git/status.test.ts` | 35.6 |
| F29 kept-folder | `tests/git/fixtures.test.ts` | 33.2 |
| OBSERVATION L: medians of wall and CPU time for 20 check "full" reads and 20 no-change check "changes" reads | `tests/git/poll-cost.test.ts` | 32.2 |
| F16: more than 100000 records give completeness limited with reason STATUS_LISTING_RECORDS, never an empty success, in pages within the Status page bound | `tests/git/status.test.ts` | 30.9 |
| F15 | `tests/git/fixtures.test.ts` | 29.5 |
| F29 row-programs | `tests/git/fixtures.test.ts` | 29.3 |
| F29 relative-hooks | `tests/git/fixtures.test.ts` | 29.3 |
| F29 kept-nested | `tests/git/fixtures.test.ts` | 27.8 |
| F27 headless-kept | `tests/git/fixtures.test.ts` | 26.8 |
| F29 gitdir-nested | `tests/git/fixtures.test.ts` | 26.4 |
| F29 gitdir-extension | `tests/git/fixtures.test.ts` | 26.2 |
| F29 base | `tests/git/fixtures.test.ts` | 26.2 |
| F29 gitdir-outside | `tests/git/fixtures.test.ts` | 26.0 |
| F29 nested-programs | `tests/git/fixtures.test.ts` | 26.0 |

**Groups.** `tests/groups.json` holds both lists, and `tests/run.ts` reads it. A file that measures wall or CPU time, or asserts a wall-clock budget, runs in the serial step. The code decides membership, not a run time:

- `tests/git/poll-cost.test.ts`: the T192 observations measure wall and CPU time (`process.cpuUsage`, `performance.now`).
- `tests/git/external-changes.test.ts`: watcher hints within `HINT_BUDGET_MS`.
- `tests/git/read-inputs.test.ts`: no watcher hint within `HINT_BUDGET_MS`.
- `tests/git/read-lifecycle.test.ts`: `DEADLINE_MS` and `RECONCILIATION_TARGET_MS` bounds.
- `tests/git/bun-runner.test.ts`: call `durationMs` bounds and `LINGER_MS - 1000` bounds.
- `tests/git/file-facts.test.ts`: elapsed time below `FIFO_BOUND_MS`.
- `tests/git/status-parser-time.test.ts`: one parse below 2000 ms. The other `status-parser.test.ts` cases run in the parallel step.
- `tests/wsl/lifecycle.test.ts`: one close below 10,000 ms.
- A wait loop that throws after a deadline is a bound, not a measurement. Such files stay in the parallel step.
- The `tests/git/fixtures.test.ts` build-time print had no reader in research.md, plan.md, or tasks.md. Round 2 removed it and split the file by fixture family into `tests/git/fixtures-*.test.ts`.

**Two-step run, 2026-10-07.** `bun run test:all` at `d3022b0` plus the T324 changes, with warm caches: 50 files, 2408 tests, 2356 pass, 21 skip, 31 todo, 0 fail. Each file has the baseline test count. The parallel step took 356 s for 41 files, and the serial step took 2385 s for 9 files. Wall time: 2741 s, against 3648 s for the baseline. The lowest free memory was 6.7 GiB. `tests/git/fixtures.test.ts` (1402 s) and `tests/git/poll-cost.test.ts` (596 s) set the serial time.

- The F16 status fixture comes from the performance cache, now in `tests/windows/fixture-cache.ts`. A warm copy takes about 0.14 s, against about 29 s for a build. The F16 fixture check still builds one fresh copy and compares it with the cached copy, raw index bytes included.
- The T194 staging inputs and the T220 blob stay uncached. Generation takes 256 ms for 512 MiB and 137 ms for 300 MB. A copy takes 223 ms and 86 ms, and a SHA-256 reuse check takes 421 ms and 230 ms. F30 remotes also record absolute URLs, so a copied repository refers to the original folder.
- A change of `tests/windows/perf-fixtures.ts` changes the M and L builder digest. The next run then rebuilds M and L, which adds about 22 minutes.

**Two-step run, round 2, 2026-10-07.** `bun run test:all` at `d3b9aad` plus the round 2 changes, with warm caches and 8 workers: 61 files, 2407 tests, 2355 pass, 21 skip, 31 todo, 0 fail. The parallel step took 632 s for 53 files, and the serial step took 887 s for 8 files. Wall time: 1520 s, against 3648 s for the baseline. The lowest free memory was 6.6 GiB. `tests/git/poll-cost.test.ts` (587 s) sets most of the serial time.

- Round 2 ran the `core.filemode` check as an `afterAll` hook of each fixture file. A hook counts as no test, so that run held 2407 tests.

**Two-step run, round 3, 2026-10-08.** The same command and tree, with the `core.filemode` check as the last named case of each fixture file: 61 files, 2418 tests, 2366 pass, 21 skip, 31 todo, 0 fail. The parallel step took 628 s for 53 files, and the serial step took 887 s for 8 files. Wall time: 1516 s, against 3648 s for the baseline. The lowest free memory was 5.1 GiB. `tests/wsl/registration.test.ts` on `Ubuntu-24.04`: 32 pass, 4 skip, 0 fail.

- Each of the 2408 baseline cases maps by name to one case of the two steps. 12 names hold random IDs, so they match after the hex and non-ASCII characters are masked. The 11 fixture files add 10 `core.filemode` cases, because the one baseline case maps to one of them. So the total is 2408 + 10 = 2418.
- The fixture files hold 145 tests: 134 builder cases and 11 `core.filemode` cases. `status-parser.test.ts` (122) and `status-parser-time.test.ts` (1) hold the 123 baseline tests.
- Fixture file times in the 8-worker parallel step: f28b 285 s, worktree 268 s, f30 251 s, f29a 251 s, f16 247 s, repos 211 s, f28a 204 s, f29b 203 s, f27a 200 s, state 152 s, f27b 146 s.
- With 16 workers, the parallel step took 645 s, and two `tests/wsl/reads.test.ts` cases failed. A WSL `readHistory` passed the 30 s `GIT_PROCESS_DEADLINE_MS`, and a runner dispose passed the 5 s default hook bound. The host has 8 physical cores, so `tests/run.ts` starts 8 workers. `ARBARETO_TEST_WORKERS` sets another count.
- The F16 history fixture also comes from the cache. A fresh build takes 653 to 757 ms. A cached copy takes 28 to 122 ms for the digest check and 40 to 73 ms for the copy.
- `bun run test:fast` runs 24 files and 1763 tests in the parallel step in 191 s. `tests/git/history-parser.test.ts` alone takes 191 s.

**Worker memory, 2026-10-08.** The parallel step ran twice with 4 workers: at `a775140`, then with the oracle change below. A sampler read the private bytes of each Bun process about every 2 s. The host had 32 GB of memory and about 12.8 GB free before each run.

| Worker file | Peak before | Peak after |
| --- | --- | --- |
| `tests/git/status-parser.test.ts` | 5331 MB | 5985 MB |
| `tests/git/fixtures-f16.test.ts` | 2010 MB | 692 MB or less |
| `tests/git/status.test.ts` | 1743 MB | 1604 MB |
| Sum of all Bun processes | 6218 MB | 6865 MB |
| Lowest free memory | 7731 MB | 6804 MB |

- The F16 stage-input files are 512 MiB each. The fixture builders already write them in 8 MiB chunks. The oracle `workingFileDigests` read each file whole, four times per check. The oracle now hashes files in 1 MiB chunks.
- The `status-parser.test.ts` worker grows for about 90 s, during the F16 at-limit, F16 over-limit, and 32 MiB listing cases. Its memory goes down when the file ends. This memory comes from the test cases, not from a fixture builder. One worker runs the file, so the worker count does not change this peak.
- The run results: 2588 tests and 0 fail before, and 2591 tests and 0 fail after.
- With 8 workers, the estimate is the two status files plus six workers at 700 MB: about 11.8 GB. This is not a measurement. The 8-worker runs above had at least 5.1 GiB free. `tests/run.ts` keeps 8 workers.

## R7. Tauri and compiled Bun

**Decision**: Retain Tauri 2 and one compiled Bun service. Add only a small Rust IPC and Windows process supervisor.

**Rationale**: Pinned source provides the required packaging and restricted bridge mechanisms. Existing subprocess wrappers do not establish reliable descendant cleanup.

**Alternatives considered**: Tauri's shell plugin, renderer process access, Bun-only child killing, and a separate native helper executable. The first three miss required boundaries. Another executable is unnecessary.

### Minimum native/runtime versions

The versions below are minimum versions, verified on 2026-09-29. The lockfiles record the exact resolved versions. Bun is the exception: the service executable embeds it, and its source defines the startup controls that the shell removes, so Bun stays exact.

| Component | Minimum version | Licence and source |
| --- | --- | --- |
| Tauri application | `2.12.0` | Apache-2.0 OR MIT; revision `447fa9f3f993fe77724189e355078b38ce20baea`. |
| Tauri build | `2.7.0` | Same licence and revision. |
| Native cargo-tauri CLI | `2.12.0` | Same licence and revision. Prefer this over the npm Node wrapper. The reference host has it from `cargo install tauri-cli --locked`. On 2026-09-29, `cargo tauri --version` prints `tauri-cli 2.12.0`. This is the latest stable release. crates.io lists `3.0.0-alpha.3` as a pre-release. The plan stays on Tauri 2. |
| Tauri frontend API | `2.12.0` | Apache-2.0 OR MIT; revision `4f46cfc10da37f5deba2326569f86b0700d97835`. |
| Native dialog plugin | `2.8.0` | Apache-2.0 OR MIT; revision `a2364a5f216324439feedeb25b2db74e7b1eba90`. |
| Win32 bindings | `windows = 0.62.0` | MIT OR Apache-2.0; published source revision `983720fec75dea714cca37d29679eb9369ec7ef7`. |
| Bun compiler/runtime | `1.4.3` (exact) | MIT plus linked-component obligations; revision `c6da4a4d3010e5553438c60f6bd76d981976867c`. |
| Rust/Cargo | `1.98.0` | Apache-2.0 OR MIT plus component notices; Rust revision `88d9e12ae178fab0fb5cc050a94da85685d449ea`. |
| NSIS | `3.11` | Mainly zlib/libpng, with compression-component notices. Tauri pins its download and hash. |
| `serde` / `serde_json` | `1.0.228` / `1.0.145` | MIT OR Apache-2.0; Tauri's `Cargo.lock` selects these versions at the revision above. |

Tauri and the selected plugin require Rust 1.90. The selected Windows binding requires Rust 1.82. The observed Rust 1.98 toolchain satisfies those declared floors, but no project build ran.

Tauri's lock selects Wry `0.57.0`, Tao `0.37.0`, WebView2 COM `0.39.1`, and Windows bindings `0.62.0`. The dialog plugin also depends on filesystem support. That dependency does not justify renderer filesystem permissions.

Use the native dialog through typed Rust commands. Omit the dialog JS package, shell plugin, and clipboard plugin. Native text copy/paste covers this slice.

The `windows` Git tag metadata did not match the published package. The published crate identifies the revision above. Its registry checksum is `9579d0e6970fd5250aa29aba5994052385ff55cf7b28a059e484bb79ea842e42`.

### Win32 binding features

On 2026-09-30, a source inspection read the published `windows-0.62.0.crate`, whose SHA-256 equals the checksum above. Each call in the tasks lives in one feature module. Some calls need a second feature for a parameter type. T006 enables exactly this list. Later tasks add rows, and each addition has a record in R10 "Dependency reviews".

| Feature | Calls and types in the tasks | Evidence in the crate |
| --- | --- | --- |
| `Win32_Foundation` | `HANDLE`, `CloseHandle`, `SetHandleInformation`, `DuplicateHandle`. | `Win32/Foundation/mod.rs`. Every other Win32 feature also enables it. |
| `Win32_Security` | `SECURITY_ATTRIBUTES`. It gates `CreateProcessW`, `CreateJobObjectW`, `CreatePipe`, and `CreateFileW`. | Each function carries `#[cfg(feature = "Win32_Security")]`: Threading `mod.rs:358`, JobObjects `mod.rs:16`, Pipes `mod.rs:42`, FileSystem `mod.rs:359`. |
| `Win32_System_Threading` | `CreateProcessW`, `STARTUPINFOEXW`, `InitializeProcThreadAttributeList`, `UpdateProcThreadAttribute`, `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, `PROC_THREAD_ATTRIBUTE_JOB_LIST`, `ResumeThread`, `TerminateProcess`, `WaitForSingleObject`, `GetExitCodeProcess`, `GetCurrentProcess`, `IsWow64Process2`. It also gates `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`. | `Win32/System/Threading/mod.rs`; JobObjects `mod.rs:190`. |
| `Win32_System_JobObjects` | `CreateJobObjectW`, `SetInformationJobObject`, `QueryInformationJobObject`, `AssignProcessToJobObject`, `TerminateJobObject`, `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Lingering Jobs add `JOBOBJECT_ASSOCIATE_COMPLETION_PORT`, `JobObjectAssociateCompletionPortInformation`, `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION`, `JobObjectBasicProcessIdList`, `JOBOBJECT_BASIC_PROCESS_ID_LIST`, and `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO`. | `Win32/System/JobObjects/mod.rs`. The lingering-Job names have no crate line check; T065 compiles them. |
| `Win32_System_Pipes` | `CreatePipe`. | `Win32/System/Pipes/mod.rs:44`. |
| `Win32_System_IO` | `OVERLAPPED`. It gates `ReadFile` and `WriteFile`. Lingering Jobs add `CreateIoCompletionPort` and `GetQueuedCompletionStatus`. | FileSystem `mod.rs:2112`. The lingering-Job names have no crate line check; T065 compiles them. |
| `Win32_Storage_FileSystem` | `SearchPathW` (T060, mod.rs:2353), `CreateFileW`, `ReadFile`, `WriteFile`, `FlushFileBuffers`, `DeleteFileW`, `MoveFileExW`, `ReplaceFileW`, `GetFileInformationByHandleEx`, `FILE_ID_INFO`, `FileIdInfo`, `FILE_SHARE_READ`, `FILE_SHARE_WRITE`, `FILE_SHARE_DELETE`, `FILE_FLAG_BACKUP_SEMANTICS`, `FILE_READ_ATTRIBUTES`. | `Win32/Storage/FileSystem/mod.rs`; `FileIdInfo` is class 18 at `mod.rs:4767`. |
| `Win32_System_SystemInformation` | `OSVERSIONINFOEXW`, `OSVERSIONINFOW`, `IMAGE_FILE_MACHINE`, `IMAGE_FILE_MACHINE_AMD64`. It gates `IsWow64Process2` and `RtlGetVersion`. | Threading `mod.rs:1130`; Wdk SystemServices `mod.rs:5328`. |
| `Win32_System_SystemServices` | `VER_NT_WORKSTATION`, `VER_NT_DOMAIN_CONTROLLER`, `VER_NT_SERVER`. | `Win32/System/SystemServices/mod.rs:5294-5296`. |
| `Wdk_System_SystemServices` | `RtlGetVersion`. | `Wdk/System/SystemServices/mod.rs:5330`. It takes `*mut OSVERSIONINFOW`. The crate has no `RTL_OSVERSIONINFOEXW` name, so T057 passes a cast `OSVERSIONINFOEXW`. |
| `Win32_System_Registry` | T211 adds it. `RegOpenKeyExW`, `RegEnumKeyExW`, `RegGetValueW`, `RegCloseKey`, `HKEY`, `HKEY_CURRENT_USER`, `KEY_READ`, `RRF_RT_REG_SZ`, `RRF_RT_REG_DWORD`. | The resolved `windows-0.62.2` source, `Win32/System/Registry/mod.rs`: `RegCloseKey` `:12`, `RegEnumKeyExW` `:249`, `RegGetValueW` `:289`, `RegOpenKeyExW` `:376`, `HKEY` `:713`, `HKEY_CURRENT_USER` `:737`, `KEY_READ` `:756`, `RRF_RT_REG_DWORD` `:1817`, `RRF_RT_REG_SZ` `:1822`. No name carries a second-feature `cfg`. The crate `Cargo.toml:629` gives `Win32_System_Registry = ["Win32_System"]`. |
| `Win32_UI_Controls` | `TaskDialogIndirect`, `TASKDIALOGCONFIG`, `TASKDIALOG_BUTTON`. | `Win32/UI/Controls/mod.rs:1267`, `:9116`. |
| `Win32_UI_WindowsAndMessaging` | It gates `TaskDialogIndirect` and `TASKDIALOGCONFIG`. | Controls `mod.rs:1265`, `:9114`. |
| `Foundation` | T247 adds it. `TypedEventHandler` for the `TextScaleFactorChanged` handler. | The resolved `windows-0.62.2` source, `Windows/Foundation/mod.rs:2467` (`TypedEventHandler::new`). `UI` also enables it (`Cargo.toml:308`). |
| `UI_ViewManagement` | T247 adds it. `UISettings`, `UISettings::new`, `TextScaleFactor`, `TextScaleFactorChanged`. | The resolved `windows-0.62.2` source, `Windows/UI/ViewManagement/mod.rs`: `new` `:1858`, `TextScaleFactor` `:1956`, `TextScaleFactorChanged` `:1963`. `UISettings` is `Send` and `Sync` (`:2079`, `:2080`). The feature enables `UI` (`Cargo.toml:341`). |

WebView2 calls go through `webview2-com` `0.39.1`, not through these features. No project build ran, so the list is unverified until T065 compiles it. A missing feature fails that compile; it cannot pass silently.

Sources: [Tauri versions and MSRV](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/Cargo.toml#L40-L58), [runtime dependencies](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-runtime-wry/Cargo.toml#L15-L35), [API revision](https://github.com/tauri-apps/tauri/tree/4f46cfc10da37f5deba2326569f86b0700d97835), [dialog manifest](https://github.com/tauri-apps/plugins-workspace/blob/a2364a5f216324439feedeb25b2db74e7b1eba90/plugins/dialog/Cargo.toml#L35-L57), [published Windows manifest](https://github.com/microsoft/windows-rs/blob/983720fec75dea714cca37d29679eb9369ec7ef7/crates/libs/windows/Cargo.toml#L1-L9), [NSIS pin](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs#L36-L43).

### Compiled-service hardening

Use `bun-windows-x64`. Bun 1.4.3 targets SSE4.2/Nehalem and performs runtime instruction dispatch. Do not repeat older mandatory-AVX2 claims.

Compile with all four implemented autoload controls:

```text
--no-compile-autoload-dotenv
--no-compile-autoload-bunfig
--no-compile-autoload-tsconfig
--no-compile-autoload-package-json
```

The compiler stores these controls in the executable graph. Startup applies them before normal application configuration.

They do not sanitize environment variables. `BUN_BE_BUN=1` can select the Bun CLI instead of the bundled application. `BUN_OPTIONS` supplies startup arguments before TypeScript runs. Explicit configuration arguments also bypass automatic-loading restrictions.

Sanitize runtime-control variables before Rust launches the service. Match environment names case-insensitively on Windows. Use fixed executable arguments and an application-owned startup directory.

`src-tauri/src/env_sanitize.rs` removes the names below from the service environment (T032). The T025 test lists them as Bun reads between process entry and the entry module. `BUN_BYTECODE_DIGEST_OUT` is the exception: Bun reads it at exit. This record verifies each read site, not the read time. The tag `bun-v1.4.3` points directly at commit `c6da4a4d3010e5553438c60f6bd76d981976867c` (GitHub API `git/refs/tags/bun-v1.4.3`, object type `commit`). Each site is a path at that commit. On 2026-10-11, the T366 implementer read each line below in a fetch of that commit.

| Removed name | Bun 1.4.3 read site |
| --- | --- |
| `BUN_BE_BUN` | `src/bun_core/env_var.rs:227` |
| `BUN_OPTIONS` | `src/bun_core/env_var.rs:124` |
| `BUN_FEATURE_FLAG_NO_ORPHANS` | `src/bun_core/env_var.rs:98` |
| Every name that starts with `BUN_JSC_` | `src/jsc/bindings/ZigGlobalObject.cpp:379` checks the prefix, and `:383` sets the JSC option after it. |
| `BUN_DISABLE_STOP_IF_NECESSARY_TIMER` | `src/jsc/bindings/ZigGlobalObject.cpp:509` |
| `BUN_GC_TIMER_INTERVAL` | `src/bun_core/env_var.rs:103` |
| `BUN_GC_RUNS_UNTIL_SKIP_RELEASE_ACCESS` | `src/bun_core/env_var.rs:101` |
| `BUN_GC_TIMER_DISABLE` | `src/bun_core/env_var.rs:102` |
| `BUN_IDLE_GC_SECONDS` | `src/bun_core/env_var.rs:104` |
| `HYPERFINE_RANDOMIZED_ENVIRONMENT_OFFSET` | `src/bun_core/env_var.rs:165` |
| `BUN_INSPECT` | `src/bun_core/env_var.rs:108` |
| `BUN_INSPECT_CONNECT_TO` | `src/bun_core/env_var.rs:109` |
| `BUN_INSPECT_NOTIFY` | `src/js/internal/debugger.ts:249` |
| `BUN_INSPECT_PRELOAD` | `src/bun_core/env_var.rs:110` |
| `NODE_PENDING_DEPRECATION` | `src/bun_core/env_var.rs:187` |
| `NODE_USE_SYSTEM_CA` | `src/bun_core/env_var.rs:189` |
| `_BUN_WATCHER_CHILD` | `src/sys/windows/mod.rs:1519` reads it with `GetEnvironmentVariableW`. Lines 1506-1509 define the name. |
| `NODE_ENV` | `src/runtime/cli/run_command.rs:663` and `src/dotenv/env_loader.rs:203` |
| `BUN_ENV` | `src/dotenv/env_loader.rs:203` |
| `BUN_DISABLE_TRANSPILER` | `src/bundler/transpiler.rs:724` |
| `BUN_CONFIG_MAX_HTTP_REQUESTS` | `src/http/AsyncHTTP.rs:207` |
| `BUN_SHOW_BUN_STACKFRAMES` | `src/jsc/VirtualMachine.rs:4246` |
| `BUN_FEATURE_FLAG_DISABLE_ASYNC_TRANSPILER` | `src/bun_core/env_var.rs:244` |
| `NODE_CHANNEL_FD` | `src/bun_core/env_var.rs:172` |
| `NODE_CHANNEL_SERIALIZATION_MODE` | `src/jsc/VirtualMachine.rs:4261` |
| `NODE_PRESERVE_SYMLINKS` | `src/jsc/VirtualMachine.rs:4291` |
| `BUN_GARBAGE_COLLECTOR_LEVEL` | `src/jsc/VirtualMachine.rs:4295` |
| `BUN_FEATURE_FLAG_FORCE_WAITER_THREAD` | `src/jsc/VirtualMachine.rs:4300` |
| `BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING` | `src/jsc/VirtualMachine.rs:4304` |
| `BUN_FEATURE_FLAG_SYNTHETIC_MEMORY_LIMIT` | `src/jsc/VirtualMachine.rs:4317` |
| `BUN_FEATURE_FLAG_DISABLE_STANDALONE_MADVISE` | `src/bun_core/env_var.rs:278` |
| `BUN_BYTECODE_ORDER_OUT` | `src/jsc/BytecodeOrderRecorder.rs:126` reads it when each VM of a compiled executable starts (`src/jsc/VirtualMachine.rs:3333`). At exit, Bun writes a file to the named path (`BytecodeOrderRecorder.rs:177-178`). `src/bun_core/env_var.rs:50` defines the name. |
| `BUN_BYTECODE_DIGEST_OUT` | `src/jsc/BytecodeOrderRecorder.rs:67` reads it at exit (`src/jsc/VirtualMachine.rs:2281`) and writes a file to the named path. `src/bun_core/env_var.rs:45` defines the name. |

On Windows, Bun 1.4.3 compares environment names without ASCII letter case. The `env_var.rs` reads go through `getenv_z_any_case` (`src/bun_core/util.rs:344`), which compares at lines 409-412. The `DotEnv` map is `CaseInsensitiveAsciiStringArrayHashMap` (`src/dotenv/env_loader.rs:1286`). The `BUN_JSC_` check compares exact bytes (`ZigGlobalObject.cpp:379`). The shell removes each name and the prefix without ASCII letter case (contract §7). So it removes every form that Bun reads. Git child environments (T182) use the same name rule.

Sources: [tag ref](https://api.github.com/repos/oven-sh/bun/git/refs/tags/bun-v1.4.3), [variable registry](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/bun_core/env_var.rs#L45-L278), [JSC options](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/jsc/bindings/ZigGlobalObject.cpp#L373-L387), [virtual machine reads](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/jsc/VirtualMachine.rs#L4246-L4317), [bytecode order and digest files](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/jsc/BytecodeOrderRecorder.rs#L63-L180), [Windows name comparison](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/bun_core/util.rs#L340-L412), [DotEnv map](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/dotenv/env_loader.rs#L1279-L1286), [watcher child](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/sys/windows/mod.rs#L1506-L1519).

Keep Git's controlled child environment separate. Preserve required user authentication settings without modifying PATH, agents, helpers, or persistent configuration.

A Git-behavior probe on 2026-09-29 used Git `2.55.0.windows.3` in a throwaway repository. `GIT_CONFIG_COUNT` pairs and `GIT_CONFIG_PARAMETERS` appeared in `git config list --show-scope` with scope `command`. An environment `core.hooksPath` changed the `git rev-parse --git-path hooks` result. With `GIT_CONFIG` set, `git config list` showed only that file, and a local key disappeared. `git rev-parse` still honored the local `core.hooksPath`. `git var GIT_AUTHOR_IDENT` used `GIT_AUTHOR_NAME` also under `user.useConfigOnly=true`. This probe is not qualification evidence, and no Arbareto build ran.

Sources: [command scope and protected configuration](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-config.adoc#L436-L466), [GIT_CONFIG_COUNT and GIT_CONFIG](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-config.adoc#L484-L505), [identity variables](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git.adoc#L603-L636), [configuration variable names](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/environment.h#L19-L21).

`src/contracts/git-environment.json` defines the fixed policies `probe`, `read`, and `mutation` (T026). Each policy removes the 13 variables that the pinned Git `Documentation/git.adoc` lists under "The Git Repository" (lines 501-601). These are `GIT_INDEX_FILE`, `GIT_INDEX_VERSION`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_DIR`, `GIT_WORK_TREE`, and `GIT_NAMESPACE`. The list also holds `GIT_CEILING_DIRECTORIES`, `GIT_DISCOVERY_ACROSS_FILESYSTEM`, `GIT_COMMON_DIR`, `GIT_DEFAULT_HASH`, `GIT_DEFAULT_REF_FORMAT`, and `GIT_REFERENCE_BACKEND`. The section says that these variables apply to all core Git commands, and that a front end can override them (lines 503-505). Each policy also removes every name that starts with `GIT_TEST_`, and it sets `GIT_TERMINAL_PROMPT=0` (lines 758-760). `probe` and `read` also remove `GIT_CONFIG`, and `probe` sets `LC_ALL=C`. `mutation` sets `GIT_INDEX_FILE` only from the `indexFile` of a service-owned `transactionId`. Each policy lists `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, and `GIT_CONFIG_NOSYSTEM` as preserved (lines 762-778). No Arbareto build used these policies yet, so they stay unverified until T182.

Sources: [repository variables](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git.adoc#L501-L601), [terminal prompt](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git.adoc#L758-L760), [configuration file selection](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git.adoc#L762-L778).

Sources: [CPU configuration](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/scripts/build/config.ts#L1023-L1029), [CPU compiler flag](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/scripts/build/flags.ts#L72-L77), [autoload flag parser](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/runtime/cli/Arguments.rs#L2350-L2431), [executable flag encoding](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/runtime/cli/build_command.rs#L939-L958), [runtime flag application](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/bun.js.rs#L10-L28), [Bun CLI bypass](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/runtime/cli/mod.rs#L1202-L1208), [BUN_OPTIONS](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/runtime/cli/mod.rs#L1356-L1400), [explicit config exception](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/bunfig/arguments.rs#L148-L239).

**Batch 1 observations, 2026-10-03.** T065 copied these test and task records.

- T032, 2026-10-03: `RtlUpcaseUnicodeChar` maps no UTF-16 unit from U+0080 to U+FFFF into ASCII on build 26200. The GitHub tag `bun-v1.4.2` points at commit `744846f844374847c902b5e7fd59b4342a51ef99`.
- T033, 2026-10-03: `CreateFileW("CONOUT$")` fails in a `DETACHED_PROCESS` child and opens in a `CREATE_NO_WINDOW` child (build 26200).
- T034, 2026-10-03: on a file held with share mode 0, an open with `FILE_READ_ATTRIBUTES` and full sharing succeeds. A `GENERIC_READ` open fails with error 32.
- T035, 2026-10-03: a grandchild started from a detached child without `DETACHED_PROCESS` gets its own `conhost.exe` inside the Job. The test harness started that grandchild with creation flags 0. The Git for Windows wrapper is a separate cause: it passes `CREATE_NO_WINDOW` (below).
- T033 follow-up, 2026-10-03: a debug sidecar stayed suspended for hours outside its kill-on-close Job. Its parent ended between `CreateProcessW` with `CREATE_SUSPENDED` and `AssignProcessToJobObject`, so the child kept only the Job of the parent. `spawn.rs` now names the Job in `PROC_THREAD_ATTRIBUTE_JOB_LIST`. Microsoft Learn `UpdateProcThreadAttribute` defines its value: "a pointer to a list of job handles to be assigned to the child process". It works in Windows 10 and later. The test `a_child_whose_parent_dies_before_the_resume_ends_within_5_seconds` failed with the old order and passes with the attribute. The attribute is in the enabled `Win32_System_Threading` feature, so no feature changed.
- Git for Windows wrapper, 2026-10-03 (Git 2.55.0.windows.3, build 26200): `C:\Git\cmd\git.exe` is the wrapper of git-for-windows MINGW-packages `mingw-w64-git/git-wrapper.c`. Without a console, it starts Git with `CREATE_NO_WINDOW`, so Git, its hooks, and `ssh` share a hidden console. `--exec-path` through the wrapper printed `C:/Git/mingw64/libexec/git-core` and one LF. Started with `DETACHED_PROCESS` in a Job, the resolved `C:\Git\mingw64\libexec\git-core\git.exe` ran alone in its Job. The wrapper Job also held `conhost.exe` (test `the_exec_path_git_has_no_console_and_the_wrapper_child_has_one`). The wrapper still starts one Git for the `--exec-path` probe, with a hidden console. `mingw64\bin\git.exe` and `libexec\git-core\git.exe` are separate files on this host (`fsutil hardlink list`). The wrapper also sets `MSYSTEM`, `PLINK_PROTOCOL`, and `HOME`, and extends `PATH` (`setup_environment`). A direct start skips these steps. The Git tests already run `mingw64\bin\git.exe` directly. The `probe` policy keeps `GIT_EXEC_PATH`, so a user value of it steers the resolution, as it steers Git itself.
- T036, 2026-10-03: `cargo tauri dev` without `devUrl` serves `frontendDist` from `http://127.0.0.1:1430/` unless `--no-dev-server` is passed.

Sources: [wrapper console flags](https://github.com/git-for-windows/MINGW-packages/blob/d2d1c3d19ace821cf4814a8d9fcf30fe0034e14e/mingw-w64-git/git-wrapper.c#L853-L867), [wrapper environment](https://github.com/git-for-windows/MINGW-packages/blob/d2d1c3d19ace821cf4814a8d9fcf30fe0034e14e/mingw-w64-git/git-wrapper.c#L124), [job list attribute](https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute).

### Why the Rust supervisor exists

Bun pins libuv revision `8023581113b276e7c1aee3f82da57ca0893faab1`. Its Windows Job enables breakaway and does not reliably contain descendants. Process killing reaches process termination, not a per-operation Job termination.

Bun's inspected parent-death watchdog enables its behavior on Unix. Its Windows-named Job function is empty.

Tauri shell plugin `2.4.0` also uses child-process termination. Its normal exit map is not a crash-cleanup guarantee. Its default line reader can accumulate an unbounded line.

Use separate shell-owned service and operation Jobs. Do not expose native spawning to the renderer. Serialize argument arrays only at `CreateProcessW`, with tested Windows quoting and explicit `lpApplicationName`.

Sources: [Bun libuv pin](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/scripts/build/deps/libuv.ts#L14-L28), [libuv Job flags](https://github.com/oven-sh/libuv/blob/8023581113b276e7c1aee3f82da57ca0893faab1/src/win/process.c#L69-L120), [process termination](https://github.com/oven-sh/libuv/blob/8023581113b276e7c1aee3f82da57ca0893faab1/src/win/process.c#L1354-L1365), [watchdog implementation](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/io/ParentDeathWatchdog.rs#L187-L263), [Tauri shell process handling](https://github.com/tauri-apps/plugins-workspace/blob/a2364a5f216324439feedeb25b2db74e7b1eba90/plugins/shell/src/process/mod.rs#L63-L85), [line buffering](https://github.com/tauri-apps/plugins-workspace/blob/a2364a5f216324439feedeb25b2db74e7b1eba90/plugins/shell/src/process/mod.rs#L466-L479).

### IPC permissions

Local custom Tauri commands do not automatically receive mandatory plugin-style ACL checks. Register application commands with `tauri_build::AppManifest::commands` and grant only the required local main-window capabilities.

Do not grant `shell:*`, broad filesystem access, or remote capabilities. Tauri custom-protocol IPC does not require a listening localhost TCP server.

Sources: [authorization condition](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri/src/webview/mod.rs#L2049-L2088), [application ACL manifest](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-build/src/acl.rs#L85-L116), [custom-protocol IPC](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri/src/ipc/protocol.rs#L32-L63).

### Session delivery

On 2026-09-30, a scan of the pinned `tauri`, `tauri-runtime`, and `tauri-runtime-wry` sources listed every initialization-script setter. Only builder types set one: `tauri::Builder` (app.rs:1810), `WebviewAttributes` (tauri-runtime webview.rs:592, :618), `WebviewBuilder` (webview/mod.rs:943, :1002), and `WebviewWindowBuilder` (webview_window.rs:1008, :1053). Plugins supply theirs when they are built (plugin.rs:69-76). The manager applies the scripts when it creates a webview (manager/webview.rs:398). A live `Webview` or `WebviewWindow` offers `eval` and `reload`, but no script setter. So a script cannot deliver a session that starts after window creation. The shell answers the shell-only `currentSession` operation instead (contract §2). It starts the service before the window, so the first page load finds a session.

Sources: [builder script setter](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri/src/webview/mod.rs#L943), [window builder script setter](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri/src/webview/webview_window.rs#L1008), [attribute setter](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-runtime/src/webview.rs#L592), [manager script collection](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri/src/manager/webview.rs#L398), [live window API](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri/src/webview/webview_window.rs#L2521-L2589).

### Windows distribution decision

Select NSIS `installMode: currentUser`. Its source requests user execution and selects a LocalAppData destination.

For this qualification slice, require preinstalled WebView2 and explicitly select `webviewInstallMode: skip`. Add a native prerequisite check before webview creation. Missing or unsupported runtime versions must produce a clear blocked state.

This avoids hidden downloads and automatic elevation during ordinary installation. It does not qualify prerequisite repair.

Alternatives: `downloadBootstrapper` needs network access; `embedBootstrapper` still downloads the runtime; `offlineInstaller` embeds Evergreen installation. `fixedRuntime` adds browser distribution and servicing responsibility.

Microsoft supports non-elevated per-user Evergreen installation. Enterprise policies can change behavior. Tauri's minimum-version update branch requests `needsadmin=true`; do not silently enter that branch.

Inspect final PE imports and a clean machine. Static CRT settings for the main executable do not prove every sidecar is self-contained.

Sources: [NSIS execution level](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi#L105-L112), [current-user destination](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi#L501-L516), [WebView2 install/update branches](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi#L547-L635), [Windows distribution documentation](https://v2.tauri.app/distribute/windows-installer/), [Microsoft WebView2 distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution).

Microsoft preinstalls the Evergreen Runtime on all Windows 11 devices as part of the operating system. No verified method gives a Windows 11 environment without it. The packaged missing-WebView2 case therefore stays `unverified` (T156). Microsoft's Evergreen Standalone Installer updates an older runtime offline (distribution page, offline deployment).

Source: [Evergreen Runtime on Windows 11](https://learn.microsoft.com/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version#the-evergreen-runtime-distribution-mode).

### Package identification label

Package identification means the installer file name and the Windows Apps entry. The template writes the entry name `DisplayName` from `productName` (installer.nsi:702). It includes the `installerHooks` file at installer.nsi:35-36. It runs `NSIS_HOOK_POSTINSTALL` after the uninstall-key writes (installer.nsi:734-735). Tauri documents that this hook runs after the registry keys are set (tauri-utils config.rs:912-918). NSIS upgrade detection reads the default value, `UninstallString`, and `DisplayVersion`, not `DisplayName` (installer.nsi:219-230).

The template never reads `shortDescription` or `longDescription`, although the bundler passes the first one (nsis/mod.rs:295). The installer file name is `<productName>_<version>_<arch>-setup` (nsis/mod.rs:653-658). A `productName` change would also rename the install folder (installer.nsi:515) and the uninstall key (installer.nsi:67). It would also rename the shortcuts and the executable `FileDescription` (tauri-build lib.rs:849-854). So T008 uses one post-install hook that rewrites only `DisplayName`. The installer file name carries no label.

Sources: [hook include](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi#L35-L36), [uninstall key](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi#L67), [upgrade detection](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi#L219-L230), [DisplayName write](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi#L702), [post-install hook](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi#L734-L735), [hook documentation](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-utils/src/config.rs#L912-L942), [template data](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs#L293-L302), [hook path](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs#L396-L401), [installer file name](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs#L653-L658), [executable description](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-build/src/lib.rs#L849-L854).

### WebView2 failure and accelerator control

wry `v0.57.0` has no `ProcessFailed` handler in `src/webview2/mod.rs`. It disables browser accelerator keys only through its `browser_accelerator_keys` platform attribute (mod.rs:649-651). Its `default_context_menus` attribute sets `AreDefaultContextMenusEnabled` (mod.rs:638). Both default to true (lib.rs:1752-1769), and the builder exposes them (lib.rs:1802-1810, :1883-1890). `set_webview_settings` applies them before `Navigate` (mod.rs:597). A 2026-09-30 scan of `tauri-runtime-wry` `src/lib.rs` at the pinned revision found neither attribute name. The wry crate registers no `AcceleratorKeyPressed` or `ContextMenuRequested` handler. Tauri configuration has no accelerator key. So the shell subscribes to `ProcessFailed` through `with_webview`.

**Accelerator keys and page menu (AC1, D2).** `with_webview` runs after wry has created the webview and started the first navigation (`WebviewMessage::WithWebview`, tauri-runtime-wry lib.rs:3907-3947). Setting changes after `NavigationStarting` apply only at the next top-level navigation (`CoreWebView2Settings`). This app never navigates again, because F5 is a bounded refresh. So `AreBrowserAcceleratorKeysEnabled` set through `with_webview` never protects the first document. The load-bearing mechanism is the controller event `AcceleratorKeyPressed`. It fires for every accelerator key, whatever the setting. Setting `IsBrowserAcceleratorKeyEnabled` to false on its arguments skips the browser action, and the key still reaches the page. `Handled` stays false, so F5 and Escape reach the page. The setting does not cover movement and text-editing keys, such as Ctrl+C, Ctrl+V, Ctrl+A, and Ctrl+Z. The arguments need `ICoreWebView2AcceleratorKeyPressedEventArgs2`. Win32 SDK `1.0.2210.55` introduced it and needs runtime `120.0.2210.55` or later (Microsoft Learn release notes). Admission requires runtime `154.0.4258.37` or later, so every admitted runtime provides it. The handler therefore has no `Handled` fallback. A failed cast is an admission defect; the handler logs it and T157 records it. That `webview2-com` `0.39.1` exposes the interface stays unverified until T065 compiles it. A missing binding fails that compile.

`ContextMenuRequested` on `ICoreWebView2_11` fires only while `AreDefaultContextMenusEnabled` is true, so the shell keeps default menus on and filters items. Item `Name` is the English label in lower camel case, such as `saveAs`, `cut`, `copy`, and `paste`. The filter keeps `cut`, `copy`, `paste`, and `selectAll` for an editable target, and `copy` and `selectAll` for selected text. For every other target, it sets `Handled` to true and shows no menu. Shift+F10 and the Menu key raise the same event. The `selectAll` name follows the documented naming rule but is unverified until T157.

The shell creates the main window hidden and attaches both handlers in one `with_webview` call. That call only queues its closure (tauri-runtime-wry lib.rs:1568-1572). So the closure itself shows the window after both handlers are attached. A hidden window receives no keyboard input, so no key reaches the page before the handlers exist. Tauri keeps `WindowBuilder::visible` for the tao window (tauri-runtime-wry lib.rs:1047-1048). webview2-com `0.39.1` supplies both handler types (callback.rs:162, :490; crate SHA-256 `3f89fca7a704cee10dcb3654c1dbb8941d1783132f1917358af75bec37a7d7e6`). The shell also sets `AreBrowserAcceleratorKeysEnabled` to false in that call; T157 records when it takes effect. No WebView2 run has checked this design (unverified).

Sources: [wry settings](https://github.com/tauri-apps/wry/blob/wry-v0.57.0/src/webview2/mod.rs#L630-L660), [wry attributes](https://github.com/tauri-apps/wry/blob/wry-v0.57.0/src/lib.rs#L1750-L1890), [Tauri with_webview dispatch](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-runtime-wry/src/lib.rs#L3907-L3947), [settings timing](https://learn.microsoft.com/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2settings), [IsBrowserAcceleratorKeyEnabled](https://learn.microsoft.com/microsoft-edge/webview2/reference/win32/icorewebview2acceleratorkeypressedeventargs2), [AreBrowserAcceleratorKeysEnabled](https://learn.microsoft.com/microsoft-edge/webview2/reference/win32/icorewebview2settings3), [browser keys list](https://learn.microsoft.com/microsoft-edge/webview2/concepts/browser-features#additional-keyboard-shortcuts-information), [context menus](https://learn.microsoft.com/microsoft-edge/webview2/how-to/context-menus), [menu item names](https://learn.microsoft.com/microsoft-edge/webview2/reference/win32/icorewebview2contextmenuitem), [SDK 1.0.2210.55 release notes](https://learn.microsoft.com/microsoft-edge/webview2/release-notes/sdk/1-0-2210-55).

The `ProcessFailed` kind decides the shell action (T142, T184). `BrowserProcessExited` closes the WebView, and the app must recreate it. `RenderProcessExited` puts an error page in the main frame, and `Reload` can recover it. `RenderProcessUnresponsive` repeats every few seconds, so the shell takes no automatic action. WebView2 recreates utility and GPU processes. Sandbox helper and PPAPI exits are not fatal. A frame-only renderer exit leaves the top-level document. So only the browser and main-frame renderer exits show a dialog. `UnknownProcessExited` has no documented effect, so it shows no dialog and is only logged. A browser-process exit raises `BrowserProcessExited` separately.

Source: [ProcessFailedKind](https://learn.microsoft.com/dotnet/api/microsoft.web.webview2.core.corewebview2processfailedkind).

Sources: [wry accelerator setting](https://github.com/tauri-apps/wry/blob/wry-v0.57.0/src/webview2/mod.rs#L649-L651), [tauri-runtime-wry](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-runtime-wry/src/lib.rs), [Tauri configuration](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-utils/src/config.rs).

The dialog plugin cannot build a safe close prompt. `tauri-plugin-dialog` `2.8.0` maps `OkCancelCustom` to rfd `0.16` with Common Controls v6. rfd calls `TaskDialogIndirect` with `nDefaultButton` `0`, so the first button is the default. It sets `TDF_ALLOW_DIALOG_CANCELLATION`, so Escape, Alt+F4, and the close button return `IDCANCEL`. The plugin maps `IDCANCEL` and a failed call to the text of the second button. So Enter or Escape selects Interrupt and close, whatever the order. T140 therefore calls `TaskDialogIndirect` directly with a Stay open default. The Git selection, trust approval, and marker dismissal confirmations have the same risk with the plugin. So T060 calls `TaskDialogIndirect` directly with a Cancel default for all three. The file and folder pickers also call `IFileOpenDialog` directly, with `FOS_FORCEFILESYSTEM`. The plugin reported every picker failure as Cancel (R10, 2026-10-11 record). The tauri-build default manifest already requests Common Controls v6.

Sources: [plugin button mapping](https://github.com/tauri-apps/plugins-workspace/blob/a2364a5f216324439feedeb25b2db74e7b1eba90/plugins/dialog/src/desktop.rs#L110-L140), [plugin result mapping](https://github.com/tauri-apps/plugins-workspace/blob/a2364a5f216324439feedeb25b2db74e7b1eba90/plugins/dialog/src/desktop.rs#L215-L258), [rfd task dialog](https://github.com/PolyMeilex/rfd/blob/0.16.0/src/backend/win_cid/message_dialog.rs#L100-L200), [TASKDIALOGCONFIG](https://learn.microsoft.com/windows/win32/api/commctrl/ns-commctrl-taskdialogconfig), [TaskDialogIndirect](https://learn.microsoft.com/windows/win32/api/commctrl/nf-commctrl-taskdialogindirect), [tauri-build manifest](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-build/src/windows-app-manifest.xml).

**Close with only lingering processes.** Closing with lingering processes and no running mutation shows no prompt. The FR-024 prompt exists because interrupting a running mutation has rollback limits. A lingering process belongs to no running operation, and its mutation already stated its reconciled outcome. Ending it at close therefore leaves no unreconciled mutation. Kill-on-close ends it, so no application-owned process remains after closure (SC-008). A prompt would ask a question with no rollback consequence. Decision: `closeIfIdle` closes, and the close ends every lingering Job (contract §6 "Lingering Jobs").

### Windows text size

Question (2026-10-01): does WebView2 follow the Windows Text size setting (WCAG 2.2 success criterion 1.4.4)? Page zoom stays locked at 100% (plan.md "Keyboard and focus").

- Windows scales only text there, from 100% to 225%. Microsoft Learn contrasts it with display scaling, "which resizes everything". WinUI text controls follow it by default. GDI and DirectWrite do not, and Win32 support covers only menus, icons, and toolbars ("Text scaling").
- `UISettings.TextScaleFactor` returns the setting as a double from 1 to 2.25. `TextScaleFactorChanged` fires on each change ("UISettings.TextScaleFactor Property").
- WebView2 `RasterizationScale` "is the combination of the monitor DPI scale and text scaling set by the user". The host should update it when the text scale factor changes. Microsoft's Win32 sample reads `UISettings.TextScaleFactorChanged` for that purpose ("ICoreWebView2Controller3").
- With `ShouldDetectMonitorScaleChanges` true, WebView2 tracks monitor DPI changes only. Text scale stays the host's task (same page).
- Pinned wry `v0.57.0` never sets `RasterizationScale`, `ShouldDetectMonitorScaleChanges`, or `BoundsMode` in `src/webview2/mod.rs`. It has no text-scale code. It sets only the zoom-control settings and a `zoom()` call (mod.rs:639, :660, :1462-1463; 2026-10-01 scan).
- Edge 138 shipped the CSS variable `env(preferred-text-scale)`, and Edge 145 shipped `<meta name="text-scale" content="scale">` (Microsoft Edge web platform release notes). CSS Fonts 5 §2.3 defines the meta: `medium` then follows OS and UA text preferences.
- The CSSWG explainer for `env(preferred-text-scale)` covers this setting. It states that Chrome, Edge, and Firefox on Windows 11 apply a full browser zoom for it. No source states that WebView2 does so without host code.

Decision: Arbareto scales only text, as Windows defines the setting (plan.md "Windows text size"). The shell reads `UISettings.TextScaleFactor` and gives the factor to the page. The page scales font sizes, line heights, and text-holding heights. The rasterization scale stays the monitor scale.

Rejected:

| Alternative | Reason |
| --- | --- |
| Set `RasterizationScale` to DPI scale × text factor, as the Microsoft sample does. | It zooms the whole page. At 225% text and 100% display scale, the 720×480 minimum then needs 1620×1080 physical pixels. At 150% display scale, a 1920×1080 display cannot fit it, and the insufficient-work-area rule would block the user. |
| Rely on the `text-scale` meta element alone. | Whether WebView2 feeds the Windows factor into it is unverified. The fixed DIP metrics would also clip rows unless heights grow with text. |
| Keep text at 100%. | It fails WCAG 1.4.4, because page zoom is locked. |

Unverified: whether WebView2 applies any text zoom by itself. T160 records `devicePixelRatio` at text size 225% in its DevTools run. A value above the display scale means double scaling, and SC-009 then fails. The `windows` crate feature for `UISettings` is a dependency change under the test harness rules (T247).

Sources: [Text scaling](https://learn.microsoft.com/windows/apps/develop/input/text-scaling), [Accessible text requirements](https://learn.microsoft.com/windows/apps/design/accessibility/accessible-text-requirements#text-font-size-and-scale), [UISettings.TextScaleFactor](https://learn.microsoft.com/uwp/api/windows.ui.viewmanagement.uisettings.textscalefactor), [ICoreWebView2Controller3](https://learn.microsoft.com/microsoft-edge/webview2/reference/win32/icorewebview2controller3), [ShouldDetectMonitorScaleChanges](https://learn.microsoft.com/dotnet/api/microsoft.web.webview2.core.corewebview2controller.shoulddetectmonitorscalechanges), [wry webview2 module](https://github.com/tauri-apps/wry/blob/wry-v0.57.0/src/webview2/mod.rs), [Edge 138 notes](https://learn.microsoft.com/microsoft-edge/web-platform/release-notes/138#web-platform-features), [Edge 145 notes](https://learn.microsoft.com/microsoft-edge/web-platform/release-notes/145#web-apis), [CSS Fonts 5 text-scale meta](https://drafts.csswg.org/css-fonts-5/#text-scale-meta), [preferred-text-scale explainer](https://github.com/w3c/csswg-drafts/blob/main/css-env-1/explainers/env-preferred-text-scale.md#windows-11). Document review and a source scan only; no WebView2 run.

### Signing and deferred authenticated updates

Updater `2.13.0` is research-only. Do not add it to this feature's runtime dependencies.

Tauri implements conditional signing for binaries, sidecars, installers, and uninstallers. Verify each final artifact; successful packaging does not establish signing.

The updater's `download()` verifies minisign signatures. `download_and_install()` uses that path. Rust `install(bytes)` alone does not verify supplied bytes.

For future adoption, require signed-version metadata and reject downgrades. `requireSignedVersion` defaults to false. Keep endpoints and keys outside renderer control.

Use the updater's exit callback to stop owned Jobs before installer handoff. Windows update installation can exit without ordinary Rust cleanup.

Public release remains blocked on Authenticode, timestamp/chain validation, update authenticity, tampering, wrong-key, version-substitution, and downgrade tests. A certificate alone does not guarantee SmartScreen reputation.

Sources: [sidecar signing](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-bundler/src/bundle.rs#L345-L380), [signing implementation](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-bundler/src/bundle/windows/sign.rs#L162-L184), [verified download versus install](https://github.com/tauri-apps/plugins-workspace/blob/a2364a5f216324439feedeb25b2db74e7b1eba90/plugins/updater/src/updater.rs#L827-L870), [signed-version verification](https://github.com/tauri-apps/plugins-workspace/blob/a2364a5f216324439feedeb25b2db74e7b1eba90/plugins/updater/src/updater.rs#L1633-L1707), [signed-version default](https://github.com/tauri-apps/plugins-workspace/blob/a2364a5f216324439feedeb25b2db74e7b1eba90/plugins/updater/src/config.rs#L117-L135), [Windows exit](https://github.com/tauri-apps/plugins-workspace/blob/a2364a5f216324439feedeb25b2db74e7b1eba90/plugins/updater/src/updater.rs#L938-L979), [SmartScreen limits](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).

Bun's licence states that it statically links LGPL-licensed JavaScriptCore/WebKit. Include notices and satisfy applicable source/relinking obligations before distribution. Do not label the complete compiled product MIT-only.

Source: [Bun licence and linked components](https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/LICENSE.md#L1-L19).

### Corresponding Source location

The configured location is `https://github.com/auric/arbareto` (plan.md About window). On 2026-09-29, that repository exists but is private. An authenticated `gh api repos/auric/arbareto` returned `"private": true` and size 0. The unauthenticated GitHub API and web page returned HTTP 404. An anonymous `git ls-remote` failed. This checkout has no Git remote.

The maintainer keeps the repository private until version 1. Version 1 is the first working release that implements most Git Extensions features, except plugins. Local test packages need no public source. A public release needs an anonymously obtainable build commit (FR-037). T176 records an anonymous check. B-RELEASE stays blocked until that check passes.

### Profile override live check (T360)

**T360 live check, 2026-10-11.** The check used main `4fa5f29` in the main checkout. Both runs started the app with `bun run dev` and `ARBARETO_PROFILE_ROOT` set to one new empty scratch folder. Run 1 kept the window open for 30 s. Run 2 selected Git and opened a throwaway repository through UIA with "Open folder…". The throwaway repository had one commit. Each snapshot recorded the relative path, size, LastWriteTimeUtc, and SHA-256 of every file. It covered `%APPDATA%\io.github.auric.arbareto` and `%LOCALAPPDATA%\io.github.auric.arbareto`. The second folder holds the default WebView2 data. Roaming held 1 file and Local held 330 files. Each run left 0 differences in both folders. After run 2, `<root>\config\settings.json` held the Git choice and the recent list with the throwaway path. `<root>\data\recovery` and `<root>\data\trust` were created but stayed empty. `<root>\webview2` held 166 files after run 1 and 285 files after run 2. Each normal close of the main window ended all processes within 2 s. A relative value `profile` made `src-tauri\target\debug\arbareto.exe` exit with code 2. Its stderr line was `Arbareto cannot start. ARBARETO_PROFILE_ROOT is not an absolute path: "profile".` That run wrote no file in its working folder or in the real folders. Only the Rust unit test `profile::tests::unset_keeps_the_default_folders` covers the unset case.

Open suspicion, unverified: the first "Open folder…" attempt opened nothing. It used the short 8.3 path form, and the dialog search box also held text. The cause is not isolated.

## R8. Electrobun with explicit Bun execution

**Decision**: Keep Electrobun source-only. Inspect `v2.0.1`, revision `8d09d15db791f346e419efd452d6759750addb62`, released 2026-08-22.

**Rationale**: This is a real implementation with Windows assets, not only a README. It still has unverified application behavior and concrete signing/update gaps.

**Alternatives considered**: Default Cottontail execution, native-main execution, bundled CEF, and immediate comparative implementation. These do not match the clarified Bun comparison scope.

The Bun configuration must explicitly set `build.mainProcess: bun` and `build.bun.entrypoint`. Choosing Bun as package manager is insufficient. The default application runtime is Cottontail.

The launcher reads `Resources/build.json`, starts bundled `bun.exe`, and runs application JavaScript in a Worker. The main thread owns the native event loop.

The release devkit selects Bun `1.4.0`. Hutch `0.24.3`, revision `8bb98ace92aa90ce0fb66f0ea0cee2c10bcf7f87`, copies that runtime into the application. Toolchain overrides exist, but need separate verification.

Electrobun's source is MIT. Its native dependencies and bundled runtime need their own notices. The npm bootstrap declares Node >=18; standalone Hutch is a separate development route. Neither changes the selected application runtime.

Sources: [release](https://github.com/blackboardsh/electrobun/releases/tag/v2.0.1), [Bun configuration](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/package/src/config/ElectrobunConfig.ts#L141-L165), [runtime detection](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/package/src/launcher/main.zig#L328-L359), [Bun executable selection](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/package/src/launcher/main.zig#L453-L475), [Worker/event-loop startup](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/package/src/launcher/main.ts#L238-L258), [Bun version](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/package/src/shared/bun-version.ts#L1-L2), [runtime packaging](https://github.com/blackboardsh/hutch/blob/8bb98ace92aa90ce0fb66f0ea0cee2c10bcf7f87/src/electrobun.zig#L4719-L4752), [npm bootstrap](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/npm/electrobun/package.json#L20-L36), [licence](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/LICENSE#L1-L21).

### Windows implementation and release evidence

| Area | Source finding and limit |
| --- | --- |
| Platform | Upstream declares Windows 11+. Windows native assets are x64. ARM emulation is not Arbareto qualification. |
| System renderer | `bundleCEF` defaults false. Native Windows rendering uses installed WebView2 and checks for a missing runtime. |
| CEF option | CEF `147.0.10+gd58e84d`, Chromium `147.0.7727.118`. Bundling and selecting CEF are separate settings. |
| CEF caveat | The native factory can fall back to WebView2. CEF initialization sets `no_sandbox = true`. |
| Browser transport | Typed RPC uses a native-core localhost WebSocket, per-webview AES-GCM, and native postMessage fallback. |
| Cancellation | RPC timeout rejects a promise. It does not cancel a Git subprocess or establish tree cleanup. |
| Native payload | Launcher, Bun, native core/wrapper/asar libraries, update helpers, and optional CEF/WebGPU components. |
| Native rebuild | Zig `0.16.0`, MSVC/C++ tools, Windows SDK, CMake, and WebView2 SDK dependencies. |
| Reproducibility caveat | The inspected WebView2 NuGet download lacks an explicit version pin. |
| Installer | Setup ZIP; executable requests `asInvoker`; payload installs under LocalAppData with HKCU registration. |
| Windows signing | Absent from the inspected packaging pipeline. Hutch's signing decision is macOS-only. |
| Update authentication | Bundle hashes and identity checks do not authenticate the publisher. Additional signature verification is required. |
| Update handoff | Windows uses Task Scheduler and PowerShell. Managed-device and standard-user behavior remain untested. |

Sources: [platform declaration](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/docs/src/content/docs/electrobun/guides/compatability.mdx#L6-L20), [renderer configuration](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/package/src/config/ElectrobunConfig.ts#L443-L463), [missing WebView2 detection](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/package/src/native/win/nativeWrapper.cpp#L7105-L7116), [CEF constants](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/package/src/shared/cef-version.ts#L1-L5), [CEF sandbox setting](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/package/src/native/win/nativeWrapper.cpp#L6988-L7002), [renderer fallback](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/package/src/native/win/nativeWrapper.cpp#L8688-L8706), [browser transport](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/package/src/browser/index.ts#L51-L259), [RPC timeouts](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/package/src/shared/rpc.ts#L187-L279), [native dependency pins](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/package/src/shared/build-dependencies.ts#L1-L11), [WebView2 SDK download](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/package/build.ts#L2103-L2127).

Installer/update sources: [installer creation](https://github.com/blackboardsh/hutch/blob/8bb98ace92aa90ce0fb66f0ea0cee2c10bcf7f87/src/electrobun.zig#L2400-L2440), [execution manifest](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/package/src/extractor/extractor.manifest#L20-L25), [installation paths](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/package/src/extractor/main.zig#L1228-L1235), [Windows signing documentation](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/docs/src/content/docs/electrobun/guides/code-signing.mdx#L6-L9), [signing implementation](https://github.com/blackboardsh/hutch/blob/8bb98ace92aa90ce0fb66f0ea0cee2c10bcf7f87/src/electrobun.zig#L1194-L1197), [authentication warning](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/docs/src/content/docs/electrobun/guides/updates.mdx#L40-L52), [update payload identity check](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/package/src/extractor/main.zig#L7039-L7087), [Windows update task](https://github.com/blackboardsh/electrobun/blob/8d09d15db791f346e419efd452d6759750addb62/package/src/sdks/main/core/WindowsUpdateTask.ts#L38-L83).

The inspected core x64 archive contains `native-devkit.json` with Bun 1.4.0, but not `bun.exe`. Its compressed size is 10,492,653 bytes. Its SHA-256 is `b0251163afc64c622a92c26fa37281d637ae83503e89396e581e618572494e0a`.

That size is not an application-size measurement. The release is not marked immutable; retain asset digests. Source and archive inspection do not qualify installation, cleanup, security, or performance.

Sources: [core release asset](https://github.com/blackboardsh/electrobun/releases/download/v2.0.1/electrobun-core-win-x64.tar.gz), [artifact manifest](https://github.com/blackboardsh/electrobun/releases/download/v2.0.1/electrobun-artifacts.json), [release metadata](https://api.github.com/repos/blackboardsh/electrobun/releases/tags/v2.0.1).

### Fair trade-offs

| Dimension | Tauri plus compiled Bun | Electrobun with Bun |
| --- | --- | --- |
| Application language | TypeScript frontend/service plus small Rust shell. | TypeScript shell/service APIs; native framework remains Zig/C++ with FFI. |
| Boundary | Separate service process and explicit typed bridge. | Bun application Worker shares a runtime process with native integration. |
| Renderer | System WebView2 in this plan. | System WebView2 or separately qualified bundled CEF. |
| Packaging | Rust/MSVC build and compiled service packaging. | Managed Bun/native devkit packaging; rebuilding native parts requires additional tools. |
| Security work | Configure application ACLs, Jobs, signing, and later authenticated updates. | Validate RPC and lifecycle; add Windows signing and publisher-authenticated update verification. |
| Performance | Unmeasured. | Unmeasured. |

A future approved comparison must use the same React assets and Bun Git-service workload. Compare system WebView2 first. Treat CEF as a separate renderer experiment. Follow the matched procedure in `plan.md`; do not add a second adapter now.

### Bunv material-change check

No material change was found at `862514b1db6c36b3f803b56e6718f8853d3a5784`, dated 2025-05-19. The manifest remains version `0.0.1`, without a desktop build or CLI implementation. Its entry point remains `console.log("Hello via Bun!");`.

Keep it rejected for this feature. Do not expand research without a concrete implementation change.

Sources: [manifest](https://github.com/bunvjs/bunv/blob/862514b1db6c36b3f803b56e6718f8853d3a5784/package.json#L1-L12), [entry point](https://github.com/bunvjs/bunv/blob/862514b1db6c36b3f803b56e6718f8853d3a5784/index.ts#L1).

## R9. Shared frontend and selective T3 reuse

**Decision**: Use React, Base UI-based shadcn, Tailwind, and Pierre display components. Use TanStack Virtual for large change lists.

**Rationale**: The inspected peer ranges align. Headless list control and service-owned hunk identity fit this bounded workspace.

**Alternatives considered**: Mixed Radix/Base UI components, T3's complete frontend stack, Legend List, custom diff rendering, and nested diff virtualizers. None is needed for this slice.

### Minimum frontend versions

The versions below are minimum versions for caret ranges, verified on 2026-09-29. `bun.lock` records the exact resolved versions.

| Packages | Minimum version | Licence / role |
| --- | --- | --- |
| `react`, `react-dom` | `19.3.0` | MIT; frontend runtime. |
| `@types/react`, `@types/react-dom` | `19.3.0` | MIT; development only. |
| `typescript` | `7.0.2` | Apache-2.0; development compiler. |
| `vite` / `@vitejs/plugin-react` | `8.3.1` / `6.1.1` | MIT; development/build only. |
| `tailwindcss`, `@tailwindcss/vite` | `4.3.3` | MIT; CSS build tools. |
| `@base-ui/react` | `1.8.0` | MIT; frontend primitives. |
| `shadcn` | `4.21.0` | MIT; component generator. Only its CSS ships (T123, T130). |
| `@pierre/diffs` | `1.5.1` | Apache-2.0; diff display. |
| `shiki`, `@shikijs/transformers` | `4.5.0` | MIT plus distributed asset notices; highlighting. |
| `@tanstack/react-virtual` / `@tanstack/virtual-core` | `3.14.13` / `3.17.11` | MIT; list virtualization. |
| Selected component helpers | `cn 0.4.0`, `class-variance-authority 0.7.1`, `tw-animate-css 1.4.0` | MIT, Apache-2.0, MIT. The generator emitted these on 2026-09-29. `cn` replaces `clsx` and `tailwind-merge` and has no dependencies. Include only helpers emitted by selected components. |
| Component icons | `@hugeicons/react 1.1.10`, `@hugeicons/core-free-icons 4.3.5` | MIT, MIT. The `mira` preset selects Hugeicons. The icon package declares `sideEffects: false`, so the bundle keeps only imported icons. |

React DOM requires React 19.3. Base UI accepts React 17–19; Pierre accepts React 18.3.1 or 19. Plugin React 6 accepts Vite 8. Tailwind's plugin accepts Vite 5–8. Pierre accepts Shiki 3 or 4.

These are manifest compatibility checks, not successful Bun builds or WebView2 tests. Do not add optional date libraries, React Compiler, Sass, or devtools.

Manifest sources: [React DOM](https://registry.npmjs.org/react-dom/19.3.0), [TypeScript](https://registry.npmjs.org/typescript/7.0.2), [Vite](https://registry.npmjs.org/vite/8.3.1), [React plugin](https://registry.npmjs.org/@vitejs/plugin-react/6.1.1), [Tailwind plugin](https://registry.npmjs.org/@tailwindcss/vite/4.3.3), [Base UI](https://registry.npmjs.org/@base-ui/react/1.8.0), [Pierre](https://registry.npmjs.org/@pierre/diffs/1.5.1), [TanStack Virtual](https://registry.npmjs.org/@tanstack/react-virtual/3.14.13).

### Development native dependencies

TypeScript 7 uses platform-native compiler packages, including `@typescript/typescript-win32-x64@7.0.2`. Its launcher starts `tsc.exe` through a child-process API.

Vite uses Rolldown `1.2.9` with an MSVC native binding. Tailwind uses Oxide `4.3.3`. Lightning CSS appears at `1.32.0` and `1.33.0` with MPL-2.0 licensing.

These are build dependencies, not product runtime libraries. Vite declares Node `^20.19.0 || >=22.12.0`. Explicit Bun execution needs a real build test; the declaration does not prove Bun compatibility.

Node disclosure (Constitution II), from the npm registry `engines` fields read on 2026-09-30:

| Package | Declared Node range | How it runs |
| --- | --- | --- |
| `typescript` `7.0.2`, `@typescript/typescript-win32-x64` `7.0.2` | `>=16.20.0` | `bunx --bun tsc --noEmit` (T065, T149). |
| `vite` `8.3.1`, `@vitejs/plugin-react` `6.1.1`, `rolldown` `1.2.9` | `^20.19.0 \|\| >=22.12.0` | `bunx --bun vite build` in `build:frontend` (T003). |
| `shadcn` `4.21.0` | `>=20.18.1` | `bunx --bun shadcn@4.21.0` (T123). Only its CSS enters the bundle. |
| `@tailwindcss/oxide` `4.3.3` | `>= 20` | Inside the Vite process under Bun. |
| `lightningcss` `1.32.0`, `1.33.0` | `>= 12.0.0` | Inside the Vite process under Bun. |
| `tailwindcss` `4.3.3`, `@tailwindcss/vite` `4.3.3`, `@types/react`, `@types/react-dom`, `@types/bun` | No `engines` field | Build input or type declarations only. |

The mitigation is `bunx --bun` or `bun run` for every tool. None of these packages enters the product runtime, and T154 confirms that the bundle holds no Node executable. Bun compatibility of each tool stays unverified until T065 runs the build.

Source: `engines` fields at `https://registry.npmjs.org/<package>/<version>` for each row.

Use `bunx --bun vite build`. Bare `bunx vite` can honor the Node shebang. Qualify type checking and bundling under Bun 1.4.3 without relying on a Node executable.

Source: [Bun Vite execution guidance](https://bun.sh/docs/guides/ecosystem/vite). Native package versions come from the manifests of the versions above.

### Base UI configuration

Use the shadcn generator `4.21.0` with `--base base --preset mira --yes`. On 2026-09-29, version `4.21.0` rejected `--preset base-mira`. It listed the presets `nova`, `vega`, `maia`, `lyra`, `mira`, `luma`, `sera`, and `rhea`. The `mira` run wrote style `base-mira`, `rsc: false`, `tsx: true`, and icon library `hugeicons`. It also added the Inter font, `shadcn` as a runtime dependency, and `tw-animate-css`. T123 removes the font and keeps `shadcn` as a development dependency. The registry serves `dropdown-menu` and `menubar`, but `menu` returns HTTP 404.

The maintainer keeps Hugeicons for now. The generated components use three icons: X, Check, and ChevronRight. A later switch to `lucide-react` (ISC) or inline SVG is a small change. Set `iconLibrary` in `components.json`, re-add or edit the three icon imports, and record a dependency review in R10.

For Tailwind v4, use the actual frontend CSS path and CSS variables. There is no separate `base` field in the inspected schema. The style prefix selects the Base UI family.

Use Base UI's `render` composition, not Radix `asChild`. Start with CSS layout and accessible resizing. Do not automatically add `react-resizable-panels`.

Pinning the generator does not freeze its remote registry. Record the registry revision and commit reviewed generated source.

Sources at shadcn revision `7c9eaba1c0a6404c990c144a654792e3313c650d`: [CLI selection](https://github.com/shadcn-ui/ui/blob/7c9eaba1c0a6404c990c144a654792e3313c650d/packages/shadcn/src/commands/init.ts#L134-L145), [schema](https://github.com/shadcn-ui/ui/blob/7c9eaba1c0a6404c990c144a654792e3313c650d/packages/shadcn/src/registry/schema.ts#L28-L62), [base resolution](https://github.com/shadcn-ui/ui/blob/7c9eaba1c0a6404c990c144a654792e3313c650d/packages/shadcn/src/utils/get-config.ts#L323-L331).

### Pierre API and authority boundary

Inspect `diffs-v1.5.1` at `8f360ae1b39fcbbdaccacbcd8dbbf94fb10a3c38` and its published tarball.

`PatchDiff` accepts a raw patch string and requires one file. `parsePatchFiles` exposes strict parsing through its error flag. Use public exports, not T3's older deep imports.

Use strict parsing of the service's single-file patch. Verify the displayed hunk mapping before enabling controls. Pierre's hunk indexes and slot names are presentation identifiers, not staging capabilities.

Keep accessible hunk controls outside deprecated separator callbacks. Never build patches from DOM selection, visual line numbers, accept/reject utilities, or recomputed display diffs.

On 2026-09-29, strict `parsePatchFiles` from `@pierre/diffs` `1.5.1` returned no error for text without a patch. It ran under Bun without a DOM. Each parsed hunk exposes `deletionStart`, `deletionCount`, `additionStart`, `additionCount`, and `hunkSpecs`. The mapper compares these values with the service hunks and checks the file and hunk counts itself (T178).

Sources: [PatchDiff](https://github.com/pierrecomputer/pierre/blob/8f360ae1b39fcbbdaccacbcd8dbbf94fb10a3c38/packages/diffs/src/react/PatchDiff.tsx#L13-L80), [strict parser](https://github.com/pierrecomputer/pierre/blob/8f360ae1b39fcbbdaccacbcd8dbbf94fb10a3c38/packages/diffs/src/utils/parsePatchFiles.ts#L677-L684), [deprecated separator callback](https://github.com/pierrecomputer/pierre/blob/8f360ae1b39fcbbdaccacbcd8dbbf94fb10a3c38/packages/diffs/src/components/FileDiff.ts#L263-L275), [presentation hunk data](https://github.com/pierrecomputer/pierre/blob/8f360ae1b39fcbbdaccacbcd8dbbf94fb10a3c38/packages/diffs/src/types.ts#L737-L748).

### Virtualization, workers, and WebView2

Use Pierre's React Virtualizer for diff rows. Do not wrap those rows in TanStack Virtual. The initial 100-entry history can remain an ordinary list unless measurements justify virtualization.

Start with two highlighting workers, not Pierre's default eight. Preserve a bounded plain-text fallback if highlighting fails. Bound long-line tokenization and intraline work independently from DOM virtualization.

Bundle worker modules and the shipped Shiki languages and themes locally ("Highlight set" below). Use a Vite worker factory and ES worker chunks. The portable worker is not a standalone single asset. Do not use CDN assets or unnecessary inline/blob workers.

Pierre uses an open shadow root. Style it with inherited tokens and application-owned CSS. Never interpolate repository content into `unsafeCSS`.

Tailwind's Chrome 111 floor does not establish the complete frontend's minimum browser version. Pierre also uses newer CSS features. Test the installed WebView2 runtime with local workers, the content policy, selection, copy, and focus (T160).

Enforce 1 MiB raw and normalized sides before decoding. Count diff lines before highlighting or parsing. Count canonical patch lines once, independently of split/unified presentation.

Keep focused virtual rows mounted, or use a persistent focus container. Preserve stable selected IDs. Restore focus after dialogs and refresh. Exclude IME, editable targets, AltGraph, and shadow-root text input from global shortcuts.

Sources: [Pierre Virtualizer](https://github.com/pierrecomputer/pierre/blob/8f360ae1b39fcbbdaccacbcd8dbbf94fb10a3c38/packages/diffs/src/react/Virtualizer.tsx#L18-L65), [virtualized component selection](https://github.com/pierrecomputer/pierre/blob/8f360ae1b39fcbbdaccacbcd8dbbf94fb10a3c38/packages/diffs/src/react/utils/useFileDiffInstance.ts#L185-L209), [worker options](https://github.com/pierrecomputer/pierre/blob/8f360ae1b39fcbbdaccacbcd8dbbf94fb10a3c38/packages/diffs/src/worker/types.ts#L148-L172), [worker engine loading](https://github.com/pierrecomputer/pierre/blob/8f360ae1b39fcbbdaccacbcd8dbbf94fb10a3c38/packages/diffs/src/worker/worker.ts#L186-L198), [published tarball](https://registry.npmjs.org/@pierre/diffs/-/diffs-1.5.1.tgz), [shadow root](https://github.com/pierrecomputer/pierre/blob/8f360ae1b39fcbbdaccacbcd8dbbf94fb10a3c38/packages/diffs/src/components/File.ts#L1359-L1366), [unsafe CSS insertion](https://github.com/pierrecomputer/pierre/blob/8f360ae1b39fcbbdaccacbcd8dbbf94fb10a3c38/packages/diffs/src/components/File.ts#L1536-L1543), [Base UI focus management](https://github.com/mui/base-ui/blob/47b40521eab921c2756bf9bdb0b0f07fbfdb8c8c/packages/react/src/dialog/popup/DialogPopup.tsx#L97-L142).

### Highlight set

Decision (user, option B, 2026-10-10): the comparison view ships a chosen language set, one light theme, one dark theme, and only the JavaScript RegExp engine. The build holds no other Shiki grammar, no other theme, and no Oniguruma WASM.

- Before (T338 baseline build): `dist/assets` held 326 files and 12,229,659 bytes. It held about 240 grammar chunks, 75 theme chunks, both engines, and the Oniguruma WASM inlined twice. After: 44 files and 2,863,298 bytes.
- Engine: `@shikijs/engine-javascript` `4.5.0` through `shiki/engine/javascript`. Its dependencies `oniguruma-to-es` `4.3.6`, `oniguruma-parser` `0.12.2`, `regex` `6.1.0`, `regex-recursion` `6.0.2`, and `regex-utilities` `2.3.0` are MIT, and each package holds its `LICENSE`.
- Themes: `github-light` for the light theme and `github-dark` for the dark theme. Both are MIT (primer/github-vscode-theme). Pierre's own default themes `pierre-light` and `pierre-dark` do not ship. `PatchView` and `PatchPool` pass `theme: { light: "github-light", dark: "github-dark" }`.
- Languages (Shiki id, all MIT in `tm-grammars` `1.32.22`): bat, c, csharp, css, diff, docker, go, html, ini, java, javascript, json, jsonc, jsx, kotlin, make, markdown, php, powershell, python, rust, scss, shellscript, sql, swift, tsx, typescript, xml. The import closure of these grammars holds no other grammar.
- Dropped: `yaml` and `toml` (no licence in `tm-grammars` `index.js`, no `NOTICE` entry). `cpp` (it imports `glsl`, which has no licence). `ruby` (it imports `yaml` and `glsl`). No chosen grammar failed with the JavaScript engine. Shiki's compatibility report (4.4.3) lists all chosen grammars as supported, and `tests/contracts/highlight.test.ts` tokenizes each one with Shiki 4.5.0.
- File language: Pierre maps the file name with its own table (`dist/utils/getFiletypeFromFileName.js`). Pierre maps `.sh` and `.bash` to `zsh` and `.bat` and `.cmd` to `cmd`. The `shellscript` and `bat` grammars declare these names as aliases. Pierre maps `.h` to `objective-cpp`, which does not ship.
- A name outside the set: Pierre's `resolveLanguage` throws, and the highlight task fails with a logged error. So `PatchView` parses the patch with Pierre's `getSingularPatch` and renders `FileDiff`. When Pierre's name for either side is not a shipped id or alias, it sets the language override `text` (`src/frontend/highlight/language.ts`). Pierre then takes its plain-text path. Otherwise Pierre picks the language of each side.
- Hook: Pierre `1.5.1` has no option for the bundled grammar set. `preferredHighlighter` selects the engine only at run time. `registerCustomLanguage` and `registerCustomTheme` add loaders, but `resolveLanguage.js` and `shared_highlighter.js` import the full `shiki` entry, and `themeResolution.js` imports all 65 Shiki themes through `@pierre/theming/themes`. The worker imports `shiki/engine/oniguruma` and `import("shiki/wasm")`.
- Module swap: `vite.config.ts` `resolve.alias` maps the exact ids `shiki`, `shiki/engine/oniguruma`, `shiki/wasm`, and `@pierre/theming/themes` to `src/frontend/highlight/`. Vite applies the aliases to the worker build too. These modules export only the names that Pierre imports. They load the chosen grammars and themes through `shiki/langs/<id>.mjs` and `shiki/themes/<name>.mjs`. `createOnigurumaEngine` throws `OnigurumaUnavailableError`.
- Update risk: the swap depends on Pierre's import names and on Shiki's grammar content and aliases. `tests/contracts/highlight.test.ts` fails when Pierre imports another name or another Shiki entry, when a grammar alias changes, or when the installed Shiki is not `4.5.0`. Re-check this section and R10 at each Pierre or Shiki update.
- Build check: a Vite plugin in `vite.config.ts` reads the module ids of each chunk in the page build and the worker build (`src/frontend/highlight/guard.ts`). It fails the build for a grammar or theme outside the set, a full-bundle Shiki module, an Oniguruma module, a Pierre theme module, `AGFzbQ` (the base64 WebAssembly header), or `loadWasm`. The page build must hold every shipped grammar and theme.

Sources: [Pierre tarball](https://registry.npmjs.org/@pierre/diffs/-/diffs-1.5.1.tgz) (`dist/worker/worker.js:1-3,1817-1822`, `dist/highlighter/languages/resolveLanguage.js:3-13`, `dist/highlighter/shared_highlighter.js:10-18`, `dist/highlighter/themes/themeResolution.js:3-12`, `dist/worker/WorkerPoolManager.js:616-646`, `dist/renderers/DiffHunksRenderer.js:515-525`), [tm-grammars 1.32.22](https://registry.npmjs.org/tm-grammars/-/tm-grammars-1.32.22.tgz), [tm-themes 1.12.12](https://registry.npmjs.org/tm-themes/-/tm-themes-1.12.12.tgz), [Shiki JavaScript engine compatibility](https://shiki.style/references/engine-js-compat), [Pierre worker pool docs](https://diffs.com/docs).

### Stored drafts

Decision (user, 2026-09-30): the page stores each worktree's draft in IndexedDB of its origin (plan.md "Stored drafts").

- IndexedDB 3.0 §2.7: "A transaction represents an atomic and durable set of data access and data mutation operations." So a record is whole or absent.
- The durability hint `strict` "is a hint to the user agent to flush any operating system I/O buffers before a `complete` event is fired". The draft store asks for it on every write. It stays a hint, so T163 checks the restore after Restart Arbareto.
- The store lives in the application-specific WebView2 user-data folder. Upgrade keeps it, and Delete app data at uninstall removes it (plan.md "Windows installation and native checks").
- Rejected: `localStorage`. It offers no transaction and no durability hint. Rejected: a shell-owned file per worktree. It would add two shell operations and a new frame path for the same result.
- Bun has no IndexedDB, so T249 tests the store logic against a double. Only the installed build (T153, T163) tests the real engine.

Source: [Indexed Database API 3.0, §2.7 Transactions](https://w3c.github.io/IndexedDB/#transaction-construct). Document review only; no WebView2 run.

### Content Security Policy

T008 sets this directive map in `app.security.csp`. No WebView2 run has checked it yet (unverified).

| Directive | Sources | Reason |
| --- | --- | --- |
| `default-src` | `'self'` | Local assets, images, fonts, and workers from the app origin. |
| `script-src` | `'self'` | Tauri adds build-time script hashes and nonces. |
| `style-src` | `'self'` | Tauri adds nonces here for inline `<style>` in `index.html`. |
| `style-src-elem` | `'self' 'unsafe-inline'` | Pierre appends `<style>` elements at run time. |
| `style-src-attr` | `'unsafe-inline'` | Pierre diff HTML carries `style` attributes. |
| `connect-src` | `ipc: http://ipc.localhost` | Tauri IPC fetch; the pinned configuration documents these sources. |
| `object-src` | `'none'` | No plugin content. |
| `base-uri` | `'none'` | No `<base>` element. |
| `form-action` | `'none'` | No form submission. |

Pierre `1.5.1` exposes `preferredHighlighter`, with the values `shiki-js` and `shiki-wasm`. Its default is `shiki-js`, the Shiki JavaScript RegExp engine. Shiki states that this engine supports all built-in languages since 3.9.1. It uses the RegExp `v` flag. So no WebAssembly compiles, and the policy needs no `'wasm-unsafe-eval'`. Since T338, the build holds no `shiki/wasm` chunk ("Highlight set").

Pierre builds diff HTML with `style` attributes and inserts it with `innerHTML` or `insertAdjacentHTML`. It also appends `<style>` elements into its shadow root at run time. Tauri adds hashes and nonces only to the `script-src` and `style-src` keys. It does so only for build-time HTML. A nonce in a directive makes the browser ignore `'unsafe-inline'` there. So the inline-style sources stay in `style-src-elem` and `style-src-attr`, which Tauri never changes.

Tauri sends the policy only as a header of HTML responses. It sends no policy header with worker scripts. How WebView2 applies the page policy to workers is unverified. The Windows IPC fetch goes to `http://ipc.localhost`. When the policy blocks it, Tauri falls back to `postMessage` with only a console warning. T160 therefore reads the Console and Issues panels.

Sources: [Pierre tarball](https://registry.npmjs.org/@pierre/diffs/-/diffs-1.5.1.tgz) (`dist/highlighter/shared_highlighter.js:14-18`, `dist/worker/worker.js:1817-1821`, `dist/renderers/DiffHunksRenderer.js:934`, `dist/utils/hostTheme.js`), [Shiki RegExp engines](https://shiki.style/guide/regex-engines), [Tauri nonce and hash injection](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri/src/manager/mod.rs#L86-L158), [policy on HTML only](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri/src/manager/mod.rs#L422-L439), [response header](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri/src/protocol/tauri.rs#L182-L184), [IPC fallback](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri/scripts/ipc-protocol.js), [documented IPC sources](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-utils/src/config.rs#L2889), [WebView2 argument append](https://learn.microsoft.com/microsoft-edge/webview2/reference/win32/webview2-idl#createcorewebview2environmentwithoptions).

### T3 Code frontend reuse map

Inspected revision: `ed57bed8e71b2e89a9350c94bda0dacc71cd4817`. T3 uses patched Pierre `1.3.0-beta.10` and patched Legend List `3.3.5`. Do not copy its dependency graph as a compatible baseline.

| Frontend source | Adaptation | Required correction or exclusion |
| --- | --- | --- |
| `preview/RightPanelResizeHandle.tsx`, `hooks/useResizableWidth.ts` | Clamped widths, pointer capture, and cancellation. | Add keyboard resizing, tab access, values, and visible focus. |
| `diffs/StyledDiffCodeView.tsx` | Keep CSS dimensions consistent with virtualized row metrics. | Do not copy beta metrics, broad unsafe CSS, or removed focus outlines. |
| `DiffWorkerPoolProvider.tsx` | Local worker loading, readiness, and theme updates. | Do not copy its global cache/pool sizes without measurements. |
| `diffs/AnnotatableCodeView.tsx` | Bind controlled selection to file identity. | Exclude comments/chat stores and any staging authority. |
| `DiffPanelShell.tsx`, loading/error boundaries | Status announcements, decorative skeleton handling, and selection-keyed recovery. | Exclude infinite-loading machinery for one bounded selected diff. |
| `keybindings.ts`, `lib/editableFocus.ts` | Exact modifiers, layout-aware keys, and editable-target exclusions. | Add IME and shadow-root coverage. Do not copy its command framework. |

Use TanStack's headless list API for stable keys, measurement, and overscan. T3's Legend List is also MIT and supports a React entry point. The selection is design fit, not a measured speed advantage.

Sources: [T3 frontend manifest](https://github.com/pingdotgg/t3code/blob/ed57bed8e71b2e89a9350c94bda0dacc71cd4817/apps/web/package.json#L14-L59), [catalog versions](https://github.com/pingdotgg/t3code/blob/ed57bed8e71b2e89a9350c94bda0dacc71cd4817/pnpm-workspace.yaml#L39-L52), [patches](https://github.com/pingdotgg/t3code/blob/ed57bed8e71b2e89a9350c94bda0dacc71cd4817/pnpm-workspace.yaml#L187-L188), [resize handle](https://github.com/pingdotgg/t3code/blob/ed57bed8e71b2e89a9350c94bda0dacc71cd4817/apps/web/src/components/preview/RightPanelResizeHandle.tsx#L17-L32), [diff styling](https://github.com/pingdotgg/t3code/blob/ed57bed8e71b2e89a9350c94bda0dacc71cd4817/apps/web/src/components/diffs/StyledDiffCodeView.tsx#L280-L323), [worker provider](https://github.com/pingdotgg/t3code/blob/ed57bed8e71b2e89a9350c94bda0dacc71cd4817/apps/web/src/components/DiffWorkerPoolProvider.tsx#L36-L128), [selection](https://github.com/pingdotgg/t3code/blob/ed57bed8e71b2e89a9350c94bda0dacc71cd4817/apps/web/src/components/diffs/AnnotatableCodeView.tsx#L124-L269), [key matching](https://github.com/pingdotgg/t3code/blob/ed57bed8e71b2e89a9350c94bda0dacc71cd4817/apps/web/src/keybindings.ts#L89-L139), [TanStack React adapter](https://github.com/TanStack/virtual/blob/78371e851e90fd74e984deeb0c3fd8098e2cd4f3/packages/react-virtual/src/index.tsx#L266-L281), [Legend List manifest](https://registry.npmjs.org/@legendapp/list/3.3.5).

Do not reuse T3's Electron integration, server, authentication, agent architecture, application stores, or build-system replacement.

### Frontend licence obligations

Preserve T3's MIT notice for substantial copied code: copyright 2026 T3 Tools Inc. Preserve shadcn's MIT notice for generated or adapted components.

Pierre, its theme packages, and class-variance-authority use Apache-2.0. Retain licences and applicable attribution. Mark modified upstream files and reproduce supplied NOTICE content. The inspected Pierre tarball had no NOTICE file.

Pierre's `diff@9.0.0` dependency uses BSD-3-Clause. Shiki distributions include grammar, TextMate, and WASM-related notices. Retain the resolved asset licences, not only top-level package labels.

Lightning CSS's MPL-2.0 applies to its tool distribution. Generated CSS alone does not relicense the application.

If the implementation copies code from VS Code's `scmHistory.ts`, retain Microsoft's MIT notice. The About window displays the bundled notice inventory (plan.md, About window). The NOTICE.md section 7(b) attribution relies on these Appropriate Legal Notices.

Sources: [T3 licence](https://github.com/pingdotgg/t3code/blob/ed57bed8e71b2e89a9350c94bda0dacc71cd4817/LICENSE#L1-L21), [shadcn licence](https://github.com/shadcn-ui/ui/blob/7c9eaba1c0a6404c990c144a654792e3313c650d/LICENSE.md), [Pierre distribution](https://registry.npmjs.org/@pierre/diffs/-/diffs-1.5.1.tgz).

## R10. Research conclusion and qualification register

All planning unknowns now have a decision, cited source finding, or explicit blocking conclusion. No unsupported framework or performance claim substitutes for evidence.

The initial constitutional scope conflict and former mutation design blockers are resolved. The user approved standard Git commit semantics explicitly. The hunk profile uses protected candidate publication and refuses unsafe integrations. Implementation tasks can now cover these designs; runtime qualification remains unverified.

| Evidence group | Status | Cause / next required evidence |
| --- | --- | --- |
| Version, source, and licence research | Source-inspected | Dependency graph and final distribution notices still need build-time verification. |
| Hunk publication | Design selected; unverified | Test exact candidate publication, profile refusals, checkpoint races, and external-byte preservation. |
| Commit handoff | Approved design; unverified | Test ordinary canonical Git, hook effects, late changes, attribution, and no automatic retry. |
| History graph | Components source-inspected; rendering unverified | Verify parent topology, shallow/page boundaries, controlled selection, themes, and row alignment. |
| Bun/native lifecycle | Unverified | Verify Jobs, startup controls, framing, and descendant cleanup in packaged Windows tests. |
| Standard-user installer | Unverified | Build and test preinstalled, missing, and unsupported prerequisite states. |
| Native UI and accessibility | Unverified | Test installed builds, keyboard, DPI, focus, clipboard, and IME. Narrator tests: Deferred to a later feature; not a qualification check in this slice. |
| Release performance | Unverified | Run the fixed protocol in `plan.md`; retain every result. |
| WSL repositories | Probed on the host; unverified | Install Git 2.55.0 or later in a WSL2 distro. Then run the T207 to T209 and T213 suites, and T219 in the installed build (R13). |
| Submodule update | Probed with Git 2.55.0.windows.3; unverified | Run the T221 to T225 and T232 suites, then T237 and T238 in the installed build (R14). The SSH prompt failure needs a test SSH server. Every WSL row needs distro Git 2.55.0 or later. |
| Electrobun packaged comparison | Not in scope | Source comparison only; no comparative performance result exists. |
| Package signing and authenticated updates | Public release blocked | Deferred implementation and required verification remain incomplete. |

Future records must identify scenario, build/package digest, environment, fixtures, steps, actual result, failure cause, attempted remedy, and retest. Keep those records here. Do not add a separate qualification report.

**T065 batch 1 verification, 2026-10-03.** The run used commit `9eaa7d1e253cf845c5e6129f9a632180e34c6c8a` on a clean tree. Every command exited with code 0. Every version meets its plan.md minimum.

| Tool | Source | Value | Minimum | Result |
| --- | --- | --- | --- | --- |
| Rust | `rustc --version` | `rustc 1.98.0 (88d9e12ae 2026-08-18)` | `1.98.0` | pass |
| Cargo | `cargo --version` | `cargo 1.98.0 (797e8a9bc 2026-08-05)` | `1.98.0` | pass |
| Tauri CLI | `cargo tauri --version` | `tauri-cli 2.12.0` | `2.12.0` | pass |
| Bun | `bun --version` | `1.4.2` | exactly `1.4.2` | pass |
| MSVC toolset | T001 link probe (R6) | `14.51.36231` | `14.51.36231` | pass |
| Windows SDK | T001 link probe (R6) | `10.0.26100.0` | `10.0.26100.0` | pass |
| NSIS | `makensis.exe /VERSION` after the build | `v3.11` | `3.11` | pass |
| Git | Bun test output | `git version 2.55.0.windows.3` at `C:\Git\mingw64\bin\git.exe` | `2.55.0.windows.3` | pass |
| WebView2 | T058 observation (R6) | `154.0.4258.53` | `154.0.4258.37` | pass |

- The pinned bundler downloaded `nsis-3.11.zip` and `nsis_tauri_utils.dll` v0.5.3 in this build. It validated both hashes and extracted NSIS into `%LOCALAPPDATA%\tauri\NSIS`.
- `bun test tests/contracts tests/git tests/windows`: 976 pass, 0 fail, 0 skip. All 40 `ORIGIN` lines point into `D:\dev\rozvio\src` or to the sidecar `D:\dev\rozvio\src-tauri\binaries\arbareto-git-x86_64-pc-windows-msvc.exe`.
- `cargo test`: 193 pass, 0 fail, 2 ignored. The ignored tests are the `child_entry` re-execution entries in `jobs` and `settings`, not capability skips. `ORIGIN` is `D:\dev\rozvio\src-tauri`.
- Installer: `src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\Arbareto_0.1.0_x64-setup.exe`, 32838528 bytes, SHA-256 `9e3623af445a4e00b5191e18333c0af64e458da4b7ab6c5f79551a3a259f60a9`. `package.json` and `src-tauri/Cargo.toml` hold version `0.1.0`.
- The release `arbareto.exe` holds the identity `9eaa7d1e253cf845c5e6129f9a632180e34c6c8a` and no `-dirty` string. A byte search of the binary found it.
- Header checks for the SPDX line and the copyright line printed nothing.
- Manifest changes since T003 and T006: five script-only `package.json` edits, and the T059 feature record below. Commit b564d14 wrote `tauri` and `tauri-build` in table form with `features = []`. The versions stayed `2.12.0` and `2.7.0`, and `Cargo.lock` did not change. So that edit is not a dependency change.
- Control mutation: without the duplicate-key check in `strict-json.ts`, `bun test tests/contracts` failed in 7 `strict-json.test.ts` cases and 1 `service-boundary.test.ts` case. The undone run passed 947 tests.
- Native control mutation: removing only the check before `frame()` in `ipc.rs` left `cargo test` green. `frame()` runs before `prepare` and checks the same bound through `framing::public_request_body`. So an oversized native-first request with a valid `requestId` never reached a dialog. The early check alone gives `FRAME_LIMIT` to an oversized envelope without a valid `requestId` and to an oversized `currentSession`. No test covered these two cases. With both checks removed, both T029 `FRAME_LIMIT` tests failed. The undone run passed 193 tests. Both files are byte-identical to HEAD.
- Gap fix, 2026-10-03: the `ipc.rs` test `an_envelope_above_1_mib_gets_frame_limit_before_any_other_check_or_native_step` covers these two cases. It also checks oversized `chooseGit` and `chooseRepository` requests: `FRAME_LIMIT`, no `prepare` call, no frame, and no pending request. With only the early check removed, the test fails: the envelope without a `requestId` gets `INVALID_REQUEST`. With that assertion also removed, the oversized `currentSession` gets `succeeded`. The undone run passes.
- Build identity: with an untracked `src/build-identity-probe.txt`, the debug build printed `ARBARETO_BUILD_IDENTITY=9eaa7d1e253cf845c5e6129f9a632180e34c6c8a-dirty`. After its removal, the next build printed the value without `-dirty`. Cargo reported the missing `arbareto-build-identity.always-rerun` file and ran the script again.
- Installed-package boot check, build `9eaa7d1`: passed. The user installed the package as the current user. The boot view showed a service session, the admitted Git, scope `qualification-target`, and "Unsigned local test package". It showed the identity `9eaa7d1e253cf845c5e6129f9a632180e34c6c8a` without `-dirty`. No console window opened. The sidecar exited within 100 ms.
- The user ran the elevated T193 recordings at both levels on that package. R6 "T193 recordings, 2026-10-03" holds the observations.

**T065 rerun, 2026-10-03.** The rerun used commit `744b19bb91555fd2313902e5e266148b0e5941ed` on a clean tree. Every command exited with code 0. The tree was clean again after the run.

- `bun install --frozen-lockfile` changed nothing. `bunx --bun tsc --noEmit` and `bun run build` passed.
- `bun test tests/contracts tests/git tests/windows`: 1005 pass, 0 fail, 0 skip, in 18 files. 40 `ORIGIN` lines point into `D:\dev\rozvio\src` or to the sidecar. 8 `GLOBAL_ORIGIN` lines point to the fixture home `.gitconfig` under the temporary directory.
- The Bun run printed `git version 2.55.0.windows.3` at `C:\Git\cmd\git.exe`.
- `cargo test`: 206 pass, 0 fail, 2 ignored. The ignored tests are the same two `child_entry` entries. `ORIGIN` is `D:\dev\rozvio\src-tauri`.
- Installer: `src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\Arbareto_0.1.0_x64-setup.exe`, 32851738 bytes, SHA-256 `9d13c479d31bc1537f74c5161d97caf45d006846c30989ffd88a3b16a31f9959`. NSIS is `v3.11`. `package.json` and `src-tauri/Cargo.toml` hold version `0.1.0`.
- A byte search of the release `arbareto.exe` found `744b19bb91555fd2313902e5e266148b0e5941ed` and no `-dirty` string.
- Both header checks printed nothing.
- Control mutation: without the duplicate-key check in `strict-json.ts`, `bun test tests/contracts` failed in 7 `strict-json.test.ts` cases and 1 `service-boundary.test.ts` case. The undone run passed 973 tests.
- Native control mutation: the run removed only the `if` block of the early 1 MiB check in `ipc.rs`. The test `an_envelope_above_1_mib_gets_frame_limit_before_any_other_check_or_native_step` failed alone; 205 tests passed. The two older T029 `FRAME_LIMIT` tests stayed green, because `frame()` checks the same bound. The undone run passed 206 tests.
- Both mutated files are byte-identical to HEAD after the undo.
- Build identity: with the untracked probe file, the debug build printed `ARBARETO_BUILD_IDENTITY=744b19bb91555fd2313902e5e266148b0e5941ed-dirty`. After its removal, the next build printed the value without `-dirty`. Cargo reported the missing `arbareto-build-identity.always-rerun` file.
- Release binary boot, not installed: the release `arbareto.exe` opened the `Arbareto` window with the children `arbareto-git.exe` and `msedgewebview2.exe`. The view showed this text, line by line, and a Select Git action: "Build: 0.1.0 744b19bb91555fd2313902e5e266148b0e5941ed"; "Unsigned local test package"; "Platform scope: qualification-target"; "Detected Git version: none"; "Minimum Git version: 2.55.0.windows.3"; "Qualification: unverified"; "Git changed: GIT_CHANGED". The saved Git is the wrapper `C:\Git\cmd\git.exe`, so `GIT_CHANGED` is the expected result. `CloseMainWindow()` closed the app with exit code 0, and no process stayed.
- Installed-package check, 2026-10-03: the user installed the 744b19b package as the current user. The saved Git was the wrapper C:\Git\cmd\git.exe, so the boot view showed GIT_CHANGED. Select Git proposed C:\Git\mingw64\libexec\git-core\git.exe, version 2.55.0.windows.3, and the user chose Use this Git. The boot view then showed the selected Git as admitted. After a restart, the app kept the selection without a prompt, so the saved path and digest revalidated. T065 passes.

**T289 Linux portability check, 2026-10-06.** A cloud session on Linux x86_64 ran at main `5bb4e34`. A Linux run qualifies nothing and ticks no task.

- Signature check: `gpg --status-fd 1 --verify` of `rust-1.98.0-x86_64-unknown-linux-gnu.tar.xz.asc` exited 0 with `VALIDSIG 108F66205EAEB0AAA8DD5E1C85AB96E6FA1BE5FE`. `sha256sum` gave the pinned `ed8ee2df70909c88cbaf87a6cfa3920dac00b537de12a6abe6906641e0f5952f`.
- `ARBARETO_CLOUD_RUST=1 ARBARETO_FORCE_CLOUD_SETUP=1 bash .claude/cloud-setup.sh` exited 0. `cargo fetch --locked` for the Linux target passed.
- `rustc --version` printed `rustc 1.98.0 (88d9e12ae 2026-08-18)`. `cargo --version` printed `cargo 1.98.0 (797e8a9bc 2026-08-05)`. Both resolve to `/usr/local/bin`.
- `cargo check --locked --manifest-path src-tauri/Cargo.toml --target x86_64-unknown-linux-gnu` exited 101. This is the expected red result before T290.
- First error: `` error[E0425]: cannot find type `IMarshal` in module `windows_core::imp` `` at `windows-future-0.3.2/src/bindings.rs:87:51`. The crate stopped with ``could not compile `windows-future` (lib) due to 16 previous errors``.
- `cargo tree -i windows-future` shows that `windows-future` 0.3.2 comes through `windows` 0.62.2. `arbareto`, `webview2-com` 0.39.1, and `webview2-com-sys` 0.39.1 pull in `windows`.
- Cargo did not reach the `arbareto` sources. No `-sys` build script named a missing library, so the apt package list stays unchanged.
- Cause: `src-tauri/Cargo.toml` lists `windows` and `webview2-com` without a target gate. T290 moves them to `[target.'cfg(windows)'.dependencies]`.

**T291 Linux portability check, 2026-10-06.** A session in the local WSL distro `Ubuntu-26.04` (Ubuntu 26.04.1) ran the check. It was not a cloud session. A Linux run qualifies nothing and ticks no task.

- Toolchain: `ARBARETO_LOCAL_TOOLS=1` was set, so the run used rustup stable `rustc 1.99.0 (b940084d7 2026-09-28)`, not the pinned 1.98.0.
- `cargo check --locked --manifest-path src-tauri/Cargo.toml --target x86_64-unknown-linux-gnu` exited 0 with 0 warnings.
- `bun test tests/contracts tests/git/portable-imports.test.ts`: 1556 pass, 17 skip, 7 todo, 0 fail.
- `cargo test --locked --lib --target x86_64-unknown-linux-gnu`: 22 passed.
- Control mutation: the removal of `#[cfg(windows)]` above `mod jobs;` gave exit 101. The first error was `E0432 unresolved import crate::bootstrap` at `src/jobs.rs:29`. The restore gave exit 0.
- The full Linux run `bun test tests/contracts tests/git` on that branch gave 2163 pass, 54 skip, 25 todo, 0 fail.
- Five Linux-only test fixes came first, in commit `c60ebcb`. All five changed tests only. No product code changed.

**T090 batch 2 verification, 2026-10-06.** The run used main `2b82dbb` in the worktree `D:\dev\rozvio-l1`. Both commands exited with code 0.

- `bunx --bun tsc --noEmit` printed nothing.
- `bun test tests/contracts tests/git tests/wsl`: 2245 pass, 33 skip, 25 todo, 0 fail. Bun ran 2303 tests in 50 files.
- The run printed `git version 2.56.0.windows.1` at `C:\Git\cmd\git.exe`. No test skipped for an absent Git.
- 129 `ORIGIN` lines: 128 point into `D:\dev\rozvio-l1\src`, 61 of them into `src\git-service`. One points to `D:\dev\rozvio-l1\tests\git`. 8 `GLOBAL_ORIGIN` lines point to the fixture home `.gitconfig` under the temporary directory.
- WSL: the distro `Ubuntu-24.04` has Git `2.43.0` (T207 observation below). The F24 floor tests and the T207, T209, and T212 seam cases ran and passed.

Skips. Each capability skip is `unverified`:

| Capability | Skipped cases | Status |
| --- | --- | --- |
| `distro-git-2.55` | 15 WSL cases: 4 T207 registration, 6 T208 read, and 5 T209 lifetime cases | unverified |
| `two-test-distros` | T252: identity and `worktreeKey` across both distro start orders | unverified |
| `other-account-owner` | T308: dubious ownership through the service. One F15 subcase in a passing test. | unverified |
| `fifo` | T304: a FIFO gives `other` without a hang | unverified |
| `disposable-volume` | One F15 subcase in a passing test | unverified |
| other platform | 13 POSIX golden vectors and 2 POSIX program-digest cases. These are platform skips, not capability skips. | not applicable on Windows |

- The run also counted 25 `todo` tests. They are not capability skips.
- The F10 observations print with the tag `T081`, not `F10`. They come from the F10 flags test at `tests/git/snapshot.test.ts:325`, where `TASK` is `T081`. The three `OBSERVATION T081` lines in the block below hold them. The F05 and F07 records are also in that block.
- F15 prints no `OBSERVATION` line. Its batch 2 results are passing tests. A plain folder gives the merged `REPOSITORY_UNAVAILABLE` refusal (T310), through discovery and through `chooseRepository` (`tests/git/discovery.test.ts:198`, `:472`). A removed path gives the `UNKNOWN_TARGET` refusal of the context check, not the merged refusal (`discovery.test.ts:491`). Git's ownership refusal under `GIT_TEST_ASSUME_DIFFERENT_OWNER=1` and all eight hostile names give the merged refusal, and no marker file appears (`discovery.test.ts:162`, `:178`). So the service no longer classifies the dubious-ownership stderr (R5 "Heuristics review (2026-10-05)", T310). The F15 fixture check passes (`tests/git/fixtures-repos.test.ts:40`). The subcases `other-account-owner` and `disposable-volume` stay `unverified` (table above).

Control mutation, 2026-10-06, worktree `D:\dev\rozvio-l1` at main `9a76a90`:

- The edit removed `--ignore-submodules=dirty` from the status builder in `src/git-service/commands.ts`.
- `bun test tests/git/status.test.ts -t "no submodule canary runs"` exited 1: 0 pass, 1 fail. The F05 canary test failed at `status.test.ts:339`. Four canary logs existed: the fsmonitor and clean canaries of `sub-same` and `sub-moved`.
- The undo restored the file. Its SHA-256 `86195f697afb67b9daf763dbb6e723c4abc467bcfe878a5541dfbbdc7d547ab1` matched the copy before the edit, and `git diff` was empty.
- The same command then exited 0: 1 pass, 0 fail.
- Both runs printed `git version 2.56.0.windows.1` at `C:\Git\ucrt64\bin\git.exe`. Both printed 13 `ORIGIN` lines under `D:\dev\rozvio-l1\src`, with `git-runner.ts`, `session.ts`, `status.ts`, `registration.ts`, and `trust.ts` under `src\git-service`.

Batch 2 `OBSERVATION` lines other than T192 (R6 "Batch 2 observations" holds the T192 lines), verbatim:

```text
OBSERVATION T261: pwsh 7.6.6 passed 66 parser checks
OBSERVATION T261: Windows PowerShell 5.1 5.1.26100.9444 passed 66 parser checks
OBSERVATION T261: pwsh 7.6.6 passed 68 argument checks
OBSERVATION T261: git version 2.56.0.windows.1 at C:\Git\cmd\git.exe
OBSERVATION T261: Windows PowerShell 5.1 5.1.26100.9444 passed 68 argument checks
OBSERVATION T261: git version 2.56.0.windows.1 at C:\Git\cmd\git.exe
OBSERVATION T308: git version 2.56.0.windows.1: corrupt loose ref of the HEAD target: `symbolic-ref -q HEAD` exits with 128
OBSERVATION T308: git version 2.56.0.windows.1: corrupt loose ref of the HEAD target: `show-ref --head --verify HEAD` exits with 128
OBSERVATION T308: git version 2.56.0.windows.1: corrupt loose ref of the HEAD target: `show-ref --exists refs/heads/main` exits with 1
OBSERVATION T308: git version 2.56.0.windows.1: discovery calls for a corrupt loose ref of the HEAD target: [{"args":"rev-parse --is-bare-repository --is-inside-git-dir","exitCode":0},{"args":"rev-parse --show-toplevel --absolute-git-dir --path-format=absolute --git-common-dir --git-path index --show-object-format --show-ref-format","exitCode":0},{"args":"symbolic-ref -q HEAD","exitCode":128}]
OBSERVATION T066: F03 long path of 275 UTF-16 units: Bun wrote and read it back = true; Git without core.longpaths lists it as untracked = false
OBSERVATION T286: F16 history-traversal rev-list --parents output is 8159 bytes for 100 rows, below HISTORY_STREAM_BYTES 131072
OBSERVATION T077: F07 alias-main -> main: Git resolved ["C:/Users/user/AppData/Local/Temp/arbareto-fixtures-842214f1-6aaa-459e-a371-94e3e2bcd61d/t077-f07-junction/main","C:/Users/user/AppData/Local/Temp/arbareto-fixtures-842214f1-6aaa-459e-a371-94e3e2bcd61d/t077-f07-junction/main/.git","C:/Users/user/AppData/Local/Temp/arbareto-fixtures-842214f1-6aaa-459e-a371-94e3e2bcd61d/t077-f07-junction/main/.git"] through the alias and ["C:/Users/user/AppData/Local/Temp/arbareto-fixtures-842214f1-6aaa-459e-a371-94e3e2bcd61d/t077-f07-junction/main","C:/Users/user/AppData/Local/Temp/arbareto-fixtures-842214f1-6aaa-459e-a371-94e3e2bcd61d/t077-f07-junction/main/.git","C:/Users/user/AppData/Local/Temp/arbareto-fixtures-842214f1-6aaa-459e-a371-94e3e2bcd61d/t077-f07-junction/main/.git"] through the target.
OBSERVATION T077: F07 alias-main identities [{"volumeSerial":"4474215074214650","fileId":"8be0070000004f000000000000000000"},{"volumeSerial":"4474215074214650","fileId":"8be0070000004f000000000000000000"},{"volumeSerial":"4474215074214650","fileId":"95e00700000046000000000000000000"},{"volumeSerial":"4474215074214650","fileId":"95e00700000046000000000000000000"}], main identities [{"volumeSerial":"4474215074214650","fileId":"8be0070000004f000000000000000000"},{"volumeSerial":"4474215074214650","fileId":"8be0070000004f000000000000000000"},{"volumeSerial":"4474215074214650","fileId":"95e00700000046000000000000000000"},{"volumeSerial":"4474215074214650","fileId":"95e00700000046000000000000000000"}], equal [true,true,true,true].
OBSERVATION T077: F07 alias-wt-a -> wt-a: Git resolved ["C:/Users/user/AppData/Local/Temp/arbareto-fixtures-842214f1-6aaa-459e-a371-94e3e2bcd61d/t077-f07-junction/wt-a","C:/Users/user/AppData/Local/Temp/arbareto-fixtures-842214f1-6aaa-459e-a371-94e3e2bcd61d/t077-f07-junction/main/.git/worktrees/wt-a","C:/Users/user/AppData/Local/Temp/arbareto-fixtures-842214f1-6aaa-459e-a371-94e3e2bcd61d/t077-f07-junction/main/.git"] through the alias and ["C:/Users/user/AppData/Local/Temp/arbareto-fixtures-842214f1-6aaa-459e-a371-94e3e2bcd61d/t077-f07-junction/wt-a","C:/Users/user/AppData/Local/Temp/arbareto-fixtures-842214f1-6aaa-459e-a371-94e3e2bcd61d/t077-f07-junction/main/.git/worktrees/wt-a","C:/Users/user/AppData/Local/Temp/arbareto-fixtures-842214f1-6aaa-459e-a371-94e3e2bcd61d/t077-f07-junction/main/.git"] through the target.
OBSERVATION T077: F07 alias-wt-a identities [{"volumeSerial":"4474215074214650","fileId":"f9c80a00000053000000000000000000"},{"volumeSerial":"4474215074214650","fileId":"f9c80a00000053000000000000000000"},{"volumeSerial":"4474215074214650","fileId":"f1c80a0000004a000000000000000000"},{"volumeSerial":"4474215074214650","fileId":"95e00700000046000000000000000000"}], wt-a identities [{"volumeSerial":"4474215074214650","fileId":"f9c80a00000053000000000000000000"},{"volumeSerial":"4474215074214650","fileId":"f9c80a00000053000000000000000000"},{"volumeSerial":"4474215074214650","fileId":"f1c80a0000004a000000000000000000"},{"volumeSerial":"4474215074214650","fileId":"95e00700000046000000000000000000"}], equal [true,true,true,true].
OBSERVATION T077: the fixture root is C:\Users\user\AppData\Local\Temp\arbareto-fixtures-842214f1-6aaa-459e-a371-94e3e2bcd61d.
OBSERVATION T081: intent-to-add: detected by ["--no-lazy-fetch","--no-optional-locks","status","--porcelain=v2","-z"] as ordinary record "1 .A" (mH and mI "000000") (win32 Git 2.56.0.windows.1)
OBSERVATION T081: assume-unchanged: detected by ["--no-lazy-fetch","--no-optional-locks","ls-files","-z","-v"] as a lowercase tag ("h", or "s" with skip-worktree) (win32 Git 2.56.0.windows.1)
OBSERVATION T081: skip-worktree: detected by ["--no-lazy-fetch","--no-optional-locks","ls-files","-z","-v"] as tag "S" (or "s" with assume-unchanged) (win32 Git 2.56.0.windows.1)
OBSERVATION T069: F05 read 1 left lfs.repositoryformatversion in the local configuration: true
OBSERVATION T069: git version 2.56.0.windows.1: diff-files -z --ignore-submodules=dirty on F05 sub-same (submodule HEAD matches) started 0 child processes
OBSERVATION T069: git version 2.56.0.windows.1: diff-files -z --ignore-submodules=dirty on all of F05 (sub-moved HEAD differs) started 0 child processes
OBSERVATION T069: git version 2.56.0.windows.1: control diff-files -z without --ignore-submodules=dirty on sub-same started 4 child processes
OBSERVATION T207: F24 distro Git in Ubuntu-24.04: git version 2.43.0
OBSERVATION T207: Git probe exit 0, git /usr/bin/git, git version 2.43.0, gitfs ef53:fedc9aa3bd65bc57, scope 0
```

**T323 typify gate, 2026-10-07.** The gate checked typify `0.8.0` against the four channel schemas that the shell does not type yet.

- Fact: typify makes an internally tagged enum only when each branch is a flat object with its own `type` const. The code is `typify-impl-0.8.0/src/enums.rs:293` `maybe_internally_tagged_enum`, `util.rs:662` `get_object`, and `convert.rs:1555-1610`.
- `process-request`, `process-reply`, `mutation-reply`, and `trust-reply` reuse `type` values across branches. typify then gives `#[serde(untagged)]` enums, and each const becomes a plain `String` field `type_`. serde then picks a branch by shape.
- Tried layouts and results:
  - A nested `oneOf` with one inner `oneOf` for each `type` value: untagged at both levels.
  - A merged branch that holds the `type` const and a `oneOf` of the shapes: untagged, and the const is still a `String`.
  - A `z.union` root of titled group unions: one struct with flattened optional fields.
  - A `z.xor` root of titled group unions: an untagged root with named group enums. In `process-request`, the `run` and `identity` groups become `#[serde(tag = "contextKind")]`.
- Inside each `type` group, the shapes have disjoint field sets, so an untagged group enum is exact.
- Two shape collisions cross groups. The five `process-reply` deadline shapes `{callId, deadline}` differ only by `type`. `ConfirmDeclined` and `ConfirmRunReply` `{callId, result}` also differ only by `type`.
- typify writes a branch with one shape inline in the untagged root, so that branch gets no type of its own. A zod `id` puts the branch in `definitions`, and typify then names its struct. The shell reads six `process-request` branches through these named structs.
- The `z.xor` form keeps the accepted message set and the TypeScript types. The four roots gave the same `safeParse` result in 22,332 cases: each of the 188 vector texts and its mutated copies, against each root. A type-equality check of `z.infer` and `z.input` compiled, and its control line failed.
- Decision: the shell reads the exact `type` value first, then parses the generated group type. It never reads a frame into the untagged root enum. tasks.md T323 holds the design.
- No typify release after `0.8.0` was checked.

**T212 WSL read run, 2026-10-07.** Two WSL runs checked the T212 read tests.

- On `Ubuntu-26.04` with Git `2.55.0`, `bun test tests/wsl` on the tree of main `bb46f2c` gave 56 pass, 3 skip, 6 todo, and 0 fail. The skips are two `distro-git-below-2.55` cases and one `two-test-distros` case.
- On `Ubuntu-24.04` with Git `2.43.0`, `tests/wsl/registration.test.ts` gave 32 pass, 4 skip, and 0 fail. Both F24 cases passed.
- Control mutation: `src/git-service/discovery.ts:179` returned the Linux path unchanged. All 6 live `reads.test.ts` cases then failed.
- Two T208 comparison cases are now todo cases for T115.

**T092 cases without a method, 2026-10-08.** No admissible untracked read equals the oracle blob in two F04 cases (R3 "Untracked hunk content"). The refusal signal is an index-only `.gitattributes` in the folder of the path or an ancestor folder. So it also refuses the other untracked files under that folder, whose read is correct. Each refused case gets no hunk action and reason `line-endings`. This is a recorded limit. SC-003 records each case, and the requirement does not change. The probes ran on main `763fcac` and `e5fd355` with Git `2.56.0.windows.1` at `C:\Git\cmd\git.exe`. No retest is planned.

These are refusals. They do not fail the hunk and file staging correctness gate. SC-003 stays `fail` for these cases until a product decision accepts the limit.

- `fail`: index-only `.gitattributes` with `*.txt eol=crlf` (`buildF04Stage` "index-attribute"), untracked `u-crlf.txt`. No method: the read differs from the blob at byte 6.
- `fail`: the same fixture, untracked `u-mixed.txt`. No method: the read differs from the blob at byte 6.
- `fail`: the same fixture, untracked `u-lf.txt`. Refused by the folder signal; the read equals the blob.
- `fail`: the same fixture, untracked `u-noeol.txt`. Refused by the folder signal; the read equals the blob.

The `core.safecrlf=true` cases of the first probe are not refused. The re-probe with the `git add -p` oracle of FR-010 found the read equal (R3).

**T117 batch 3 verification, 2026-10-11.** Full run 3 used main `2102871` in the main checkout `D:\dev\rozvio`. Every command exited with code 0.

- `bunx --bun tsc --noEmit` printed nothing. `export-schemas.ts --check` found the schema files current, and the build passed.
- `bun run test:all` with 6 workers and the WSL distro `Ubuntu-26.04` reported 134 of 134 files. Parallel step: 121 files, 4384 pass, 36 skip, 4 todo, 0 fail. Serial step: 13 files, 244 pass, 6 skip, 0 fail.
- `tests/wsl/registration.test.ts` on `Ubuntu-24.04` with Git `2.43.0`: 34 pass, 4 skip, 0 fail. `bun test tests/windows`: 70 pass, 1 skip, 0 fail.
- `cargo test`: 433 passed, 3 ignored. Clippy and `cargo fmt --check` printed no finding.
- Each of the 58 Git blocks printed `C:\Git\ucrt64\bin\git.exe` and `git version 2.56.0.windows.1`, built from commit `49d759b698127791a5f3f2759c69b983846711dd`. No test skipped for an absent Git.
- 1177 `ORIGIN` lines, all under `D:\dev\rozvio`. 1175 point into `src`, 723 of them into `src\git-service`. One names `node_modules\@pierre\diffs\package.json`, and one names `src` itself. 8 `GLOBAL_ORIGIN` lines point to the fixture home `.gitconfig` under the temporary directory.
- The 4 todo cases name T146, T148, and T236. These are batch 4 tasks, so no `test.todo` case names a batch 3 task.
- T196 stage time: `update-index` of 536,870,912 bytes on F16 took 15843.6 ms.

Control mutation, 2026-10-11, worktree `D:\dev\rozvio-l6` at main `60db4f0`:

- The edit changed `applyCachedArgs` in `src/git-service/commands.ts` from `apply --cached` to `apply --index`.
- `bun test tests/git/hunk-stage.test.ts` exited 1: 0 pass, 8 fail. The first failure at `hunk-stage.test.ts:60` got state `failed` with `GIT_FAILED`, not `succeeded`.
- The undo restored the file. Its SHA-256 `edfcccc71b67862e3ada2722cff555ed7683e1428329d8e7b028df1ef5680295` matched the copy before the edit, and `git status --short` was empty.
- The same command then exited 0: 8 pass, 0 fail.
- Both runs printed `git version 2.56.0.windows.1` at `C:\Git\ucrt64\bin\git.exe`. Both printed 17 `ORIGIN` lines under `D:\dev\rozvio-l6\src`, 8 of them for `src\git-service\hunk-publish.ts`.

Skips. Each capability skip is `unverified`:

| Capability | Skipped cases | Status |
| --- | --- | --- |
| `distro-git-below-2.55` | 2 F24 cases in `registration.test.ts` on `Ubuntu-26.04`. The `Ubuntu-24.04` run did not skip them and had 0 failures. | unverified |
| `distro-git-2.55` | 4 registration cases on `Ubuntu-24.04` | unverified |
| `two-test-distros` | T252: identity and `worktreeKey` across both distro start orders | unverified |
| `other-account-owner` | T308: dubious ownership through the service. One F15 subcase in a passing test. | unverified |
| `disposable-volume` | T096: F15 full volume. One F15 subcase in a passing test. | unverified |
| `fifo` | T304: a FIFO gives `other` without a hang | unverified |
| `restart-keeps-lingering` | T100: a lingering child from an earlier service session ends at revoke | unverified |
| `ssh-server` | 3 T224 SSH cases: unknown host key, and a passphrase key through `core.sshCommand` with and without arguments | unverified |
| installed app | 1 `tests/windows` case: no uninstall entry `HKCU\...\Uninstall\Arbareto` | unverified |
| other platform | 29 golden vectors, 2 POSIX trust cases, and 1 Linux-only pipe case in `bun-runner.test.ts`. These are platform skips, not capability skips. | not applicable on Windows |

**Full run 8, 2026-10-12.** Full run 8 used main `dbcb658` in the main checkout `D:\dev\rozvio`, with Bun 1.4.2 and no other load on the PC. Every command exited with code 0.

- `bun install --frozen-lockfile`, `bunx --bun tsc --noEmit`, `export-schemas.ts --check`, and `bun run build` passed. The startup chunk was 633.37 kB, and the About chunk was 527.57 kB.
- `bun run test:contracts`: 58 files, 2,872 pass, 29 skip, 0 fail, 118 s.
- `bun run test:all` with 6 workers and the WSL distro `Ubuntu-26.04` reported 136 of 136 files and 4,767 tests, in about 95 min. Parallel step: 123 files, 4,480 pass, 36 skip, 0 todo, 0 fail, 3,018.8 s. Serial step: 13 files, 245 pass, 6 skip, 0 fail, 2,664.0 s.
- `tests/wsl/registration.test.ts` on `Ubuntu-24.04` with Git 2.43.0: 38 pass, 4 skip, 0 fail. `bun run test:windows`: 70 pass, 1 skip, 0 fail, 484 s.
- `cargo test --locked`: 435 passed, 0 failed, 4 ignored. The ignored tests are 3 child entries and the T370 load probe, so that probe did not run. Clippy with `-D warnings` and `cargo fmt --check` printed no finding.
- Each of the 58 Git blocks printed `C:\Git\cmd\git.exe` and `git version 2.56.0.windows.1`, built from commit `49d759b698127791a5f3f2759c69b983846711dd`. No test skipped for an absent Git.
- 1,215 `ORIGIN` lines, all under `D:\dev\rozvio`. 1,213 point into `src`, 729 of them into `src\git-service`. 8 `GLOBAL_ORIGIN` lines.
- The test skips are the same as in the table above. The Rust run ignores 3 child entries and the T370 load probe. No `test.todo` case remains in `tests/`.
- The T370 load probe ran alone at main `5a27e51`: `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib a_child_without_descendants -- --ignored` exited with code 0, 1 passed, 0 failed, 10.43 s test time. Control mutation at `a293fdd` in a scratch worktree, as T370 states it: `Supervisor::active_descendants` read `ActiveProcesses` after the wait again. The default `cargo test --locked` run then exited with code 101, with `jobs::tests::the_active_descendants_leave_out_the_exited_process_and_a_failed_query_gives_none` red, and the probe exited with code 101, because 1 of 1600 exit replies counted a process. After the undo, both runs exited with code 0 (435 passed, and the probe passed).

Earlier runs of this batch:

- Run 1 at `667a1df`: the lane palette test failed, because it did not expect the Graphite dark lane values of T361. Commit `45be610` fixed the test. The F27 stall case failed under load, because the 10 s wait ended before the held checkout step. Commit `fa2b311` makes the wait end at the step or the response.
- Run 2 at `f89768d`: the commit preflight deadline case at `mutation-lifecycle.test.ts:635` failed under load. The exit continuation ran before the due 1 ms deadline timer. Commit `fa2b311` makes the runner double end the call with the injected deadline when it passed before the exit.
- Run 4 at `82e2752`: the fixture removal after the WSL cases failed with `EBUSY` on a runner `launch` folder. Commit `fa66530` added a wait for empty WSL Jobs to the `dispose()` of the double.
- Run 5 at `ec6699a`: a Rust test failed in the full `cargo test` run and passed alone. An exit reply counted the exited child as an active descendant, because Windows removes a process from its Job after its handle signals. T370 (commit `18c7a8f`) fixed it.
- Run 6 at `f29e2be`: `dispose()` failed with "WSL Jobs still hold processes [[48544,55412]] after 30000 ms", then `EBUSY`. Cause: the double started each `wsl.exe` in the runner `launch` folder. Its `wslhost.exe` inherits that current directory and lives until the Linux relay closes the interop channel. WSL sets no bound for that lifetime. So the Job wait waited on an unbounded process.
- Fix after run 6: the double starts each `wsl.exe` in the temporary directory, as the shell starts it in its own launch folder (`process_requests.rs` `wsl_host`). It has no WSL Job wait. The case "the launch folder can move while a WSL commit hook runs" in `tests/wsl/mutations.test.ts` gave `EBUSY` before the fix and passes after it. With `launchDirectory` back at the Git call site, it gives `EBUSY` again.
- Run 7 at `a55f1e6`: Claude Code stopped `test:all` for low host memory in its last serial file, `tests/wsl/submodules.test.ts`. All other steps passed.
- Run 7b at `a55f1e6`, 4 workers: the parallel step passed, with 4,516 tests, 4,480 pass, 0 fail, and 36 skip. The memory guard stopped the serial step in the same file. Cause: the F31 fixtures of the silent-fetch and big-clone cases stayed on disk until `afterAll`. Their Linux page cache grew the WSL VM by about 3.5 GB. The fix removes each case's F31 fixtures after the case.
- Proof run of the fix, `tests/wsl/submodules.test.ts` alone on Ubuntu-26.04: 13 pass and 0 fail. The vmmemWSL peak was 3,873 MB, the minimum host available memory was 5,003 MB, and Linux `Cached` fell back to about 265 MB after each large case.

Batch 3 `OBSERVATION` lines, verbatim. T093 and T094 hold the F03 and F10 observations:

```text
OBSERVATION T093: Bun 1.4.2 readFileSync of the 275-unit relative path returned the written bytes
OBSERVATION T093: Bun readdirSync of collide/ gives ["Name.txt"] for index paths collide/Name.txt and collide/name.txt
OBSERVATION T093: Bun realpathSync.native of a.txt gives on-disk name "A.txt"
OBSERVATION T094: git version 2.56.0.windows.1 apply --cached kept the flags of unrelated entries (F10 flags): before [{"path":"conflict.txt","intentToAdd":false,"assumeUnchanged":false,"skipWorktree":true},{"path":"ita.txt","intentToAdd":true,"assumeUnchanged":false,"skipWorktree":false},{"path":"keep.txt","intentToAdd":false,"assumeUnchanged":true,"skipWorktree":false}] after [{"path":"conflict.txt","intentToAdd":false,"assumeUnchanged":false,"skipWorktree":true},{"path":"ita.txt","intentToAdd":true,"assumeUnchanged":false,"skipWorktree":false},{"path":"keep.txt","intentToAdd":false,"assumeUnchanged":true,"skipWorktree":false}]
OBSERVATION T196: F04 autocrlf-false crlf.txt eol {"index":"crlf","working":"crlf","attr":""} proof A
OBSERVATION T196: F04 autocrlf-false lf.txt eol {"index":"lf","working":"lf","attr":""} proof A
OBSERVATION T196: F04 autocrlf-false mixed.txt eol {"index":"mixed","working":"mixed","attr":""} proof A
OBSERVATION T196: F04 autocrlf-true crlf.txt eol {"index":"lf","working":"crlf","attr":""} proof A
OBSERVATION T196: F04 autocrlf-true lf.txt eol {"index":"lf","working":"lf","attr":""} proof B
OBSERVATION T196: F04 autocrlf-true mixed.txt eol {"index":"lf","working":"mixed","attr":""} proof B
OBSERVATION T196: F04 autocrlf-input crlf.txt eol {"index":"lf","working":"crlf","attr":""} proof B
OBSERVATION T196: F04 autocrlf-input lf.txt eol {"index":"lf","working":"lf","attr":""} proof A
OBSERVATION T196: F04 autocrlf-input mixed.txt eol {"index":"lf","working":"mixed","attr":""} proof B
OBSERVATION T196: F04 eol-crlf crlf.txt eol {"index":"lf","working":"crlf","attr":"text=auto"} proof A
OBSERVATION T196: F04 eol-crlf lf.txt eol {"index":"lf","working":"lf","attr":"text=auto"} proof B
OBSERVATION T196: F04 eol-crlf mixed.txt eol {"index":"lf","working":"mixed","attr":"text=auto"} proof B
OBSERVATION T196: F04 attributes auto/crlf.txt eol {"index":"lf","working":"crlf","attr":"text=auto"} proof B
OBSERVATION T196: F04 attributes auto/lf.txt eol {"index":"lf","working":"lf","attr":"text=auto"} proof A
OBSERVATION T196: F04 attributes auto/mixed.txt eol {"index":"lf","working":"mixed","attr":"text=auto"} proof B
OBSERVATION T196: F04 attributes binary/crlf.txt eol {"index":"crlf","working":"crlf","attr":"-text"} proof A
OBSERVATION T196: F04 attributes binary/lf.txt eol {"index":"lf","working":"lf","attr":"-text"} proof A
OBSERVATION T196: F04 attributes binary/mixed.txt eol {"index":"mixed","working":"mixed","attr":"-text"} proof A
OBSERVATION T196: F04 attributes crlf/crlf.txt eol {"index":"lf","working":"crlf","attr":"text"} proof B
OBSERVATION T196: F04 attributes crlf/lf.txt eol {"index":"lf","working":"lf","attr":"text"} proof A
OBSERVATION T196: F04 attributes crlf/mixed.txt eol {"index":"lf","working":"mixed","attr":"text"} proof B
OBSERVATION T196: F04 attributes eol/crlf.txt eol {"index":"lf","working":"crlf","attr":"text eol=crlf"} proof A
OBSERVATION T196: F04 attributes eol/lf.txt eol {"index":"lf","working":"lf","attr":"text eol=crlf"} proof B
OBSERVATION T196: F04 attributes eol/mixed.txt eol {"index":"lf","working":"mixed","attr":"text eol=crlf"} proof B
OBSERVATION T196: F04 attributes text/crlf.txt eol {"index":"lf","working":"crlf","attr":"text"} proof B
OBSERVATION T196: F04 attributes text/lf.txt eol {"index":"lf","working":"lf","attr":"text"} proof A
OBSERVATION T196: F04 attributes text/mixed.txt eol {"index":"lf","working":"mixed","attr":"text"} proof B
OBSERVATION T196: F04 stage-index-crlf f.txt proof A (research R3 probe 7 expects A)
OBSERVATION T196: F04 stage-mixed-over-lf f.txt proof B (research R3 probe 7 expects B)
OBSERVATION T196: F04 stage-ident f.txt proof B (research R3 probe 7 expects B)
OBSERVATION T196: F16 update-index of 536,870,912 bytes took 15843.624700000044 ms; git version 2.56.0.windows.1
OBSERVATION T100: git version 2.56.0.windows.1 git commit with local gc.auto=1 started ["git","maintenance","run","--auto","--quiet","--detach"] and waited for it (trace2 child_exit before exit)
OBSERVATION T100: git version 2.56.0.windows.1 automatic maintenance ran 972.371 ms (trace2 child_exit t_rel)
OBSERVATION T100: git version 2.56.0.windows.1 a maintenance process did not outlive the commit process
OBSERVATION T100: a commit deadline during automatic maintenance left these new Git-directory files outside objects and logs: []
OBSERVATION T232: the F31 sleeping hook reached stalled 15085 ms after its checkout step started (threshold 15000 ms)
OBSERVATION T233: the F31 read hook reached stalled 3038 ms after its checkout step started (injected limit 3000 ms)
```

**T117 submodule cases without a comparison, 2026-10-11.** These update cases compare no submodule state with Git's own update in a copy:

- F30 child-hook (`submodule-lifecycle.test.ts`, Cancel during reconciling and lingering child) and F31 linger (`tests/wsl/submodules.test.ts`): the cases check process ends. The F27 oracle cases cover the update result.
- Loopback 401 (`submodule-lifecycle.test.ts`): the remote is a test server that answers every request with 401. The case checks the failed row, `registered`, the redacted tail, and the remedy.
- Invalid `.git` folder at the clone check and at the level read (T231): the test writes the folder during the run, and the outcome is unknown. Git's own update has no defined result for that folder.
- Admission refusals (T231 bad payload, foreign snapshot, old generation): no Git process starts, so the cases check that no process starts.
- Remedy and quoting cases (unsaved-commits and checkout remedies in PowerShell, detach note, rows without a command, fetch remedy): the cases check texts and commands, not an update result.
- F30 silent-hook deadlines, SSH cases, stall, and BUSY: the cases check a deadline, a step, or a notice. The F27 and F30 oracle cases cover their fixtures.

**T149 tool versions, 2026-10-13.** The T149 run used main `e951ad2` in the main checkout `C:\Projects\arbareto`. Read-only commands read these values on the same host after the run.

| Tool | Source | Value | Minimum | Result |
| --- | --- | --- | --- | --- |
| Rust | `rustc --version` | `rustc 1.99.0 (b940084d7 2026-09-28)` | `1.98.0` | pass |
| Cargo | `cargo --version` | `cargo 1.99.0 (5f94df478 2026-08-27)` | `1.98.0` | pass |
| Tauri CLI | `cargo tauri --version` | `tauri-cli 2.12.0` | `2.12.0` | pass |
| Bun | `bun --version`, and `bun test v1.4.3 (c6da4a4d3)` in the run log | `1.4.3` | exactly `1.4.3` | pass |
| MSVC toolset | `vswhere` and `Microsoft.VCToolsVersion.default.txt` of Visual Studio Enterprise 2022 `17.14.36221.1`, the only installation. The release `arbareto.exe` has linker version 14.44 and Rich build 35207. | `14.44.35207` | `14.51.36231` | fail |
| Windows SDK | `Windows Kits\10\Lib`. Only this version has `um\x64\kernel32.lib`. | `10.0.19041.0` | `10.0.26100.0` | fail |
| NSIS | `makensis.exe /VERSION` in `%LOCALAPPDATA%\tauri\NSIS`, extracted by this run's bundler | `v3.11` | `3.11` | pass |
| Git | Run log, 58 Git blocks | `git version 2.56.0.windows.2` at `C:\Program Files\Git\ucrt64\bin\git.exe`, built from commit `cc4dbf752a05efdc0e04e71fd3e8110d11bdd35c` | `2.55.0.windows.3` | pass |
| WebView2 | Registry value `pv` of `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`. The HKLM and HKCU keys do not exist. | `154.0.4258.62` | `154.0.4258.37` | pass |

- The MSVC toolset and the Windows SDK are below the plan.md minimums. The build still exited 0.

**T149 notice entries outside both lists, 2026-10-13.** `bun run build:notices` wrote 209 entries. The first list is the source-map package names of `bunx --bun vite build --sourcemap`, 37 maps, plus `tailwindcss`, `tw-animate-css`, and `shadcn` from `src/frontend/index.css`: 49 names. The second list is the T149 `cargo tree` command: 131 crates without `arbareto`. Each name on either list has an inventory entry. These 30 entries are on neither list:

| Entries | Path into the inventory | Reason for neither list |
| --- | --- | --- |
| `@types/hast` 3.0.5, `@types/mdast` 4.0.4, `@types/unist` 3.0.3 | Dependencies of `shiki`, `@shikijs/*`, `hast-util-to-html`, and `mdast-util-to-hast` | Types only. Each package holds only `index.d.ts`, and its `main` is empty. |
| `mdast-util-to-hast` 13.2.1 | `@pierre/diffs` > `hast-util-to-html` | `hast-util-to-html` is its only dependent. It names the package only in JSDoc `@import` comments (`lib/handle/raw.js:3`, `lib/handle/text.js:3`). |
| `@ungap/structured-clone` 1.4.0, `devlop` 1.1.0, `dequal` 2.0.3, `micromark-util-character` 2.1.1, `micromark-util-encode` 2.0.1, `micromark-util-sanitize-uri` 2.0.1, `micromark-util-symbol` 2.0.1, `micromark-util-types` 2.0.3, `trim-lines` 3.0.1, `unist-util-is` 6.0.1, `unist-util-position` 5.0.0, `unist-util-stringify-position` 4.0.0, `unist-util-visit` 5.1.0, `unist-util-visit-parents` 6.0.2, `vfile` 6.0.3, `vfile-message` 4.0.3 | `mdast-util-to-hast` and its dependencies | In `bun.lock`, every dependent of these packages is `mdast-util-to-hast` or a package below it. |
| `shiki` 4.5.0 | Root `dependencies` | `vite.config.ts` aliases `shiki`, `shiki/engine/oniguruma`, and `shiki/wasm` to `src/frontend/highlight/`. The other reached entries, `shiki/core` and `shiki/engine/javascript`, only re-export `@shikijs/core` and `@shikijs/engine-javascript`. `shiki` declares `sideEffects: false`. |
| `@shikijs/engine-oniguruma` 4.5.0 | `shiki` | Only the `shiki/dist` modules `index`, `engine-oniguruma`, `wasm`, and `core-unwasm` import it. The aliases replace the first three entries. `core-unwasm` loads only under the `unwasm` export condition. The `guard.ts` `REFUSED` list fails the build on any module of this package. |
| `@pierre/theme` 2.0.0 | `@pierre/diffs` | Only `@pierre/theming/dist/collections/pierre.js` imports it, through `themes.js`. `vite.config.ts` aliases `@pierre/theming/themes`. The `guard.ts` `REFUSED` list fails the build on both modules. |
| `@babel/runtime` 7.29.7 | `@base-ui/react` and `@base-ui/utils` | Only the CommonJS `.js` files of both packages require it: 435 files, no `.mjs` file. The `import` condition of their `exports` maps to the `.mjs` files. |
| `reselect` 5.3.0 | `@base-ui/react` > `@base-ui/utils` | Only `@base-ui/utils/store/createSelectorMemoized` imports it. `@base-ui/react` 1.8.0 imports only `ReactStore` from `@base-ui/utils/store`. `@base-ui/utils` declares `sideEffects: false`. |
| `zod` 4.6.5 | Root `dependencies` | The renderer imports it only with `import type` (`TrustDialog.tsx:5`). `build:service` compiles it into the service executable. That executable holds `ZodError`. T149 lists neither that executable nor its packages. |
| `tm-grammars` 1.32.22, `tm-themes` 1.12.12 | Separate rule in `notices.ts` (`TM_GRAMMARS_VERSION`, `TM_THEMES_VERSION`) | They are not installed packages. The shipped `@shikijs/langs` and `@shikijs/themes` files come from these releases (T338 record in "Dependency reviews"). |
| Bun runtime and linked components 1.4.3 | Separate rule in `notices.ts` | The service executable embeds the Bun runtime. The typescript-go notice is the file `typescript-go-NOTICE.txt` of this entry, not a separate entry. |
| NSIS | Separate rule in `notices.ts` (`nsisShipped`) | The installer is an NSIS 3.11 executable. |

T149 needs one more run on the final main HEAD after T373 to T376. Run the package build, the install, and the F02 smoke on that build.

**T377 WSL scope start, 2026-10-13.** The feature 002 full run on 270a0a8 failed once in "F31 silent-fetch" of `tests/wsl/submodules.test.ts` on Ubuntu-26.04. Its `reviewSubmodules` step ended `failed` with `REPOSITORY_UNAVAILABLE`. The distro journal showed an unattended upgrade of libc6 that re-executed systemd at 06:28 UTC. In that window, the `systemd-run --user --scope` call of a read started no scope and exited 1. The wrapper passed status 1 on as the Git status, and the re-read of data-model §7 then gave `REPOSITORY_UNAVAILABLE`. systemd v258 `src/run/run.c` ends with `DEFINE_MAIN_FUNCTION_WITH_POSITIVE_FAILURE(run)`, so every start failure exits 1, and `--quiet` hides the job result. No exit status tells a scope that did not start from a Git exit. Fix: the wrapper writes the start byte `S` inside the scope before the program starts (contract §11 "Process launch"). A WSL run without it ends `refused` with `PROCESS_OWNERSHIP_FAILED`. The real-distro case `the_real_wrapper_writes_the_start_byte_only_inside_a_started_scope` asserts stdout `Sout` with exit 3 for a started scope. It asserts no byte for `systemd-run` replaced by `/usr/bin/false` and for a unit name in use. Control mutations: `runRead` that maps a refusal to exit 1 turned the two read-lifecycle cases and the WSL read case red with `REPOSITORY_UNAVAILABLE`.

**T378 WSL argument expansion, 2026-10-13.** systemd NEWS 254 added `systemd-run --expand-environment=no` and kept expansion off for `--scope`. NEWS 258 turned it on for `--scope`. systemd v258 `src/run/run.c` expands the scope command line in the client with `replace_env_argv` before `execvpe`. A 2026-10-13 probe sent the five arguments `a${HOME}`, `b$$`, `$HOME`, `$ARBARETO_UNSET`, and `c$HOME` through `systemd-run --user --scope --quiet --collect -- /bin/sh -c 'printf "%s\n" "$#" "$@"' sh`:

| Distro | systemd | Default | With `--expand-environment=no` | `noexpand` |
| --- | --- | --- | --- | --- |
| Ubuntu-26.04 | 259 (259.5-0ubuntu3.4) | 4 arguments: `a/home/user`, `b$`, `/home/user`, `c$HOME`. stderr: "Referenced but unset environment variable evaluates to an empty string: ARBARETO_UNSET". | 5 arguments, each unchanged. | 0 |
| Ubuntu-24.04 | 255 (255.4-1ubuntu8.17) | 5 arguments, each unchanged. | 5 arguments, each unchanged. | 0 |

So on systemd 258 and later, a Git path such as `a${HOME}` or `b$$x`, and a `-C` folder with such a name, reached Git as another path. Fix: the probe prints `noexpand` and `verbatim`, and the wrapper passes `--expand-environment=no` when `noexpand` is 0 (contract §11 "Argument expansion"). With the fix, the two T378 cases of `tests/wsl/reads.test.ts` passed on Ubuntu-26.04. Control mutation: an empty `noexp` in `wslWrapped` of `tests/git/bun-runner.ts` turned both red. The `a${HOME}` comparison held no changed line. The folder case gave `REPOSITORY_UNAVAILABLE` with "fatal: cannot change to '…/t378-/home/user-c5156947/repo'".

**T379 scope-arguments reason, 2026-10-13.** A failed `noexpand` or `verbatim` fact now gives reason `scope-arguments`, not `no-user-manager`, because systemd runs and only `systemd-run` changes the arguments.

**T149 locked-session focus failures, 2026-10-13.** In the T149 run on main `f6708df`, the session was locked, and `LockApp.exe` held the foreground. Three `tests/windows/uia.test.ts` cases failed. "focuses the probe field" timed out on `waitFocus` after 2000 ms; it fails without the app too. The installed-app case timed out on `waitFocus` for "Select Git" after 10000 ms. The fixture cleanup then failed with `EBUSY` on `app\profile\webview2\EBWebView\CrashpadMetrics-active.pma`. A read-only probe on 2026-10-13 found the session locked (`WTSSessionInfoEx` `SessionFlags` 0, `WTS_SESSIONSTATE_LOCK`) with `LockApp.exe` in the foreground, but the input desktop was still `Default`. So the focus cases skip with capability `input-desktop` unless the session flags are `WTS_SESSIONSTATE_UNLOCK` and the input desktop is `Default`. `OwnedProcess.stop` now waits until each process of the owned tree is signaled, so the fixture removal follows the release of its files.

### Scenario records

This table holds one record for each qualification scenario: SC-001 to SC-019 (spec.md "Success Criteria"), F01 to F33 (plan.md fixture register), and UI-01 to UI-22 (plan.md UI scenarios). Each record holds the data-model §8 fields. A result is only `pass`, `fail`, or `unverified`. A record whose only evidence is source inspection stays `unverified`, and its evidence cell names `source-inspected`. An empty cell means that no fact exists yet. Record results as numbers and observations. Redact secrets before you keep evidence.

Column contents:

- Build: application revision and package digest.
- Profile and package: release profile, and unsigned or signed package status.
- Environment: dependency versions, Git path and version, WebView2 version, OS revision, architecture, installer prerequisites, hardware, display scales, Defender status, and power mode.
- Fixtures: fixture IDs with seed or digest.
- Steps: reproduction steps and measurement method.
- Actual result: run count and individual observations.
- Mutation assertions: exact index, working-file, reference, and operation-state assertions.
- Evidence: raw evidence location and digest.
- Retest: retest result.

| ID | Result | Build | Profile and package | Environment | Fixtures | Steps | Actual result | Mutation assertions | Evidence | Failure cause | Attempted remedy | Retest | Remaining blocker | Decision impact |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SC-001 | `unverified` | | | | | | | | | | | | | |
| SC-002 | `unverified` | | | | | | | | | | | | | |
| SC-003 | `unverified` | | | | | | | | | | | | | |
| SC-004 | `unverified` | | | | | | The `HOOK_FAILED` and `SIGNING_FAILED` classification is `unverified` (R4 "T112 method, 2026-10-09", T117). Every commit failure gives `GIT_FAILED`. | | | | | | The contract defines no trace2 event target, reader, bound, or cleanup for the service (R4). | |
| SC-005 | `unverified` | | | | | | | | | | | | | |
| SC-006 | `unverified` | | | | | | | | | | | | | |
| SC-007 | `unverified` | | | | | | | | | | | | | |
| SC-008 | `unverified` | | | | | | | | | | | | | |
| SC-009 | `unverified` | | | | | | | | | | | | | |
| SC-010 | `unverified` | | | | | | | | | | | | | |
| SC-011 | `unverified` | | | | | | | | | | | | | |
| SC-012 | `unverified` | | | | | | | | | | | | | |
| SC-013 | `unverified` | | | | | | | | | | | | | |
| SC-014 | `unverified` | | | | | | | | | | | | | |
| SC-015 | `unverified` | | | | | | | | | | | | | |
| SC-016 | `unverified` | | | | | | | | | | | | | |
| SC-017 | `unverified` | | | | | | | | | | | | | |
| SC-018 | `unverified` | | | | | | | | | | | | | |
| SC-019 | `unverified` | | | | | | | | | | | | | |
| F01 | `unverified` | | | | | | | | | | | | | |
| F02 | `unverified` | | | | | | | | | | | | | |
| F03 | `unverified` | | | | | | | | | | | | | |
| F04 | `unverified` | | | | | | | | | | | | | |
| F05 | `unverified` | | | | | | | | | | | | | |
| F06 | `unverified` | | | | | | | | | | | | | |
| F07 | `unverified` | | | | | | | | | | | | | |
| F08 | `unverified` | | | | | | | | | | | | | |
| F09 | `unverified` | | | | | | | | | | | | | |
| F10 | `unverified` | | | | | | | | | | | | | |
| F11 | `unverified` | | | | | | | | | | | | | |
| F12 | `unverified` | | | | | | | | | | | | | |
| F13 | `unverified` | | | | | | | | | | | | | |
| F14 | `unverified` | | | | | | | | | | | | | |
| F15 | `unverified` | | | | | | | | | | | | | |
| F16 | `unverified` | | | | | | | | | | | | | |
| F17 | `unverified` | | | | | | | | | | | | | |
| F18 | `unverified` | | | | | | | | | | | | | |
| F19 | `unverified` | | | | | | | | | | | | | |
| F20 | `unverified` | | | | | | | | | | | | | |
| F21 | `unverified` | | | | | | | | | | | | | |
| F22 | `unverified` | | | | | | | | | | | | | |
| F23 | `unverified` | | | | | | | | | | | | | |
| F24 | `unverified` | | | | | | | | | | | | | |
| F25 | `unverified` | | | | | | | | | | | | | |
| F26 | `unverified` | | | | | | | | | | | | | |
| F27 | `unverified` | | | | | | | | | | | | | |
| F28 | `unverified` | | | | | | | | | | | | | |
| F29 | `unverified` | | | | | | | | | | | | | |
| F30 | `unverified` | | | | | | | | | | | | | |
| F31 | `unverified` | | | | | | | | | | | | | |
| F32 | `unverified` | | | | | | | | | | | | | |
| F33 | `unverified` | | | | | | | | | | | | | |
| UI-01 | `unverified` | | | | | | | | | | | | | |
| UI-02 | `unverified` | | | | | | | | | | | | | |
| UI-03 | `unverified` | | | | | | | | | | | | | |
| UI-04 | `unverified` | | | | | | | | | | | | | |
| UI-05 | `unverified` | | | | | | | | | | | | | |
| UI-06 | `unverified` | | | | | | | | | | | | | |
| UI-07 | `unverified` | | | | | | | | | | | | | |
| UI-08 | `unverified` | | | | | | | | | | | | | |
| UI-09 | `unverified` | | | | | | | | | | | | | |
| UI-10 | `unverified` | | | | | | | | | | | | | |
| UI-11 | `unverified` | | | | | | | | | | | | | |
| UI-12 | `unverified` | | | | | | | | | | | | | |
| UI-13 | `unverified` | | | | | | | | | | | | | |
| UI-14 | `unverified` | | | | | | | | | | | | | |
| UI-15 | `unverified` | | | | | | | | | | | | | |
| UI-16 | `unverified` | | | | | | | | | | | | | |
| UI-17 | `unverified` | | | | | | | | | | | | | |
| UI-18 | `unverified` | | | | | | | | | | | | | |
| UI-19 | `unverified` | | | | | | | | | | | | | |
| UI-20 | `unverified` | | | | | | | | | | | | | |
| UI-21 | `unverified` | | | | | | | | | | | | | |
| UI-22 | `unverified` | | | | | | | | | | | | | |

### Batch reviews

Each batch verification task passes only after one independent review of its batch is recorded here (plan.md, Constitution Check). A record names the batch, the reviewer, the reviewed scope, and the findings. It also names the causes, corrections, and unverified claims. T116 records the batch 3 review here. One review runs per batch; no automatic review loop runs.

**Batch 1, 2026-10-03.** Two independent subagent reviewers checked batch 1. Neither reviewer wrote the reviewed code. The TypeScript review covered `src/`, `tests/`, and the build files at commit 3b6fe62. The shell review covered `src-tauri/` at commit a1ad44e. Both reviews ran the test suites and printed ORIGIN lines for the code under test. The TypeScript review turned one control mutation red.

| Finding | Failure and cause | Remedy |
| --- | --- | --- |
| TS B1 (blocker) | Fixture Git kept `GIT_DIR`, `GIT_INDEX_FILE`, and other repository-location variables. A probe committed into a foreign repository. | d395070: fixture Git removes the `git-environment.json` probe list and `GIT_TEST_*`. |
| TS M1 | The startup Git check had no deadline. Queued public frames grew without a bound. | d395070: a 30 s deadline, and at most 8 queued frames. |
| TS M2 | A cancel during the Git confirmation left a bound `gitInstallationId` without `release`. | 2d8afee: the service releases an ID that the user approved after a cancel. |
| Shell B1 | A marker of a deleted repository could not be dismissed. The context needed the identity of a missing folder. | 2d8afee: dismissal of a missing worktree path needs no context. |
| Shell B2 | Some forwarded requests never got a response. The shell skipped the strict decode and the size check after `prepare`. | 2d8afee: strict decode and bound before the forward, and every failure gives an answer. |
| Shell B3 | A refused identity read showed as `canceled`. | 2d8afee: the refusal keeps its code. The next commit makes a missing or unreadable saved Git path no candidate, so the next contract §3 source follows. |
| Shell B4 | Nothing saved `lastRepository`, so `restoreWorkspace` never restored. | 2d8afee: a succeeded `chooseRepository` saves its native context path. |
| Shell B13 | One damaged marker file counted as unloaded and blocked mutations. | 56ac9c2: the boot view lists each damaged marker. It blocks nothing, and the user can dismiss it. |
| TS m1 | `seenRequests` and the session log had no bound. | 56ac9c2: the service keeps the last 65,536 request IDs and at most 1,000 log entries. |
| Qualification: Job gap | A suspended debug sidecar stayed outside its kill-on-close Job. The parent ended between `CreateProcessW` and `AssignProcessToJobObject`. | 744b19b: each child starts inside its Job through `PROC_THREAD_ATTRIBUTE_JOB_LIST`. Two crash tests of the installed app after the assignment ended the sidecar within 77 ms. |
| Qualification: Git wrapper | The Git for Windows wrapper `cmd\git.exe` gave Git a hidden console. A prompt would then wait and not fail fast. | 744b19b: resolution reads `--exec-path` and runs the real `git.exe`. |

Open items and reasons:

- TS m1, mutation records: the mutation records have no bound. The contract keeps them for the service session.
- TS m5: some tests assert only that nothing happens in a window. They are bounded and cannot fail spuriously, but a slow host can hide a late event.
- Shell B10: the per-session maps in `process_requests.rs` have no bound. They clear only at a service exit.
- Shell S1 to S11: suspicions only. No reviewer proved them.
- Shell B5 remark: the shell closes the Job on a ninth unacknowledged input chunk. The contract does not state this rule.

**Batch 2, 2026-10-06.** Six independent reviews checked batch 2. An implementer fixed each finding, and the main session merged the fix. The review commits and task records hold the findings.

| Review | Scope | Merge |
| --- | --- | --- |
| C6 | Discovery, registration, trust, status, history, and read scheduling (T080, T082 to T087). Trust reads through shell fileFacts and the merged discovery refusal (T304 to T311). | be0dce8, 4657164 |
| T088 | External change watching and the change check | 2a2baba, 19f8aed |
| T312 | Shell walk threads with deadline and cancel | ea09f5b |
| T212 | WSL reads through the bound distro (T212, T315 to T317) | 32cf70c |
| T314 | Blocking opens and process waits off the shell frame reader | 2b82dbb (fix b425772) |
| T318 | `readTrust` refusal and WSL marker dismissal | 2aa0091 |

Open items: the capability skips in R10 "T090 batch 2 verification" stay `unverified`.

**Batch 3, 2026-10-11 (T116).** One independent subagent safety review checked batch 3 at main 9ccdfc2. An implementer fixed the findings on branch b2-l3. Each behavioral fix has a test, and one control mutation turned that test red. The test runs printed ORIGIN lines for the code under test. The WSL tests ran in Ubuntu-26.04.

| Finding | Failure and cause | State and proof |
| --- | --- | --- |
| B3-1 (high) | `after_exit` gave an earlier anchor answer, or 0, when no new answer came. The Windows exit reply gave 0 for a failed or closed Job query. The test double did the same. `processEnd` took such a 0 as the process-end fact. | Fixed. `activeDescendants` is `null` without a count (contract §6, §11). `processEnd` needs count 0 and an `exitCode` that is not null (§4). Tests: `wsl::tests::after_exit_without_a_new_answer_or_with_an_unknown_count_gives_no_count`, `process_requests::tests::a_run_after_a_run_cancel_starts_in_a_new_job_of_the_same_operation`, and the `processEnd` cases in `tests/git/wsl-files.test.ts`. |
| B3-2 (high) | The anchor printed count 0 when `systemctl --user show` failed or a listed `cgroup.procs` was unreadable. | Fixed. The anchor prints `- -`, and the shell gives no count (§11). An absent cgroup directory counts 0, because Linux removes only an empty cgroup. Test: `wsl::tests::the_real_anchor_prints_an_unknown_count_for_a_failed_listing_or_an_unreadable_cgroup_procs`. |
| B3-3 (medium-high) | A WSL commit reconciled without the process-end fact after a Cancel, the commit deadline, the diagnostic cancel, or a refusal after the start. | Fixed. Contract §4 "Commit process end". Tests: the commit cases in `tests/git/submodule-reconcile.test.ts`, and the canceled pre-commit hook case in `tests/wsl/mutations.test.ts`. |
| B3-4 (medium) | A WSL submodule update skipped the process-end run after the diagnostic cancel of a step or a refusal of a step start. | Fixed. Contract §12 "WSL repositories". Tests: the limit and refused cases in `tests/git/submodule-reconcile.test.ts`, and "F31 refused" in `tests/wsl/submodules.test.ts`. |
| B3-5 (low) | A `lock` reply outside the contract form, and a refusal of the `lock` request, gave no unknown lock. So no token-only `remove` followed. | Fixed. Contract §4 "Stopped or failed `lock`". Test: the refusal and off-contract `wslLock` cases in `tests/git/wsl-files.test.ts`. |
| B3-6 (lean) | `createIndexLock` had its own file ID test parameter and skipped `noFileId`. | Fixed. The file ID cases of `tests/git/index-lock.test.ts` use `fileIdSeam`. |
| B3-7 (lean) | Three modules built the lingering text. | Fixed. `lingeringText` in `hunk-publish.ts`. This change keeps every text, and the text tests pass. No control mutation applies. |
| Wrapper start race | Suspicion only. | Open, unverified. No reviewer proved it. |
| `branch.<x>.remote` value that starts with `-` | Suspicion only. `defaultRemote` (`submodule-remote.ts`) can choose such a value. | Open, unverified. No reviewer proved it. |

Open items and reasons:

- An exit without a count gives the lingering count 0, so the outcome shows no lingering sentence. The count changes no outcome (contract §6 "Lingering Jobs").

**Batch 4, 2026-10-11 (T149).** One independent subagent review checked batch 4 on main up to 82e2752 and the T367 commit 5ed5d00. The review read the code only and ran no tests, because full run 4 was running. It covered the workbench mounts, focus order and focus return, the status area, the submodule notice, review and update flow, the progress contract (T365, T367), the pane sizes (T364), the boot view (T363), and the commit tray (T146). Findings: B4-1 (high) the retry after APPROVAL_EXPIRED uses a stale snapshot ID; B4-2 (medium) Update submodules and Start update stay enabled during a running mutation; B4-3 (medium) focus finds Cancel by its English text; B4-4 codes are not in the code font; B4-5 final periods differ from plan.md "Status and fallback texts"; B4-6 the declined Run is inferred (contract gap); B4-7 no aria-selected; B4-8 an unknown row shows an empty path; B4-9 the JSON schema does not carry the refine rules; one duplicate helper; one portability suspicion.

| Finding | Failure and cause | State and proof |
| --- | --- | --- |
| B4-1 (high) | The new review after `APPROVAL_EXPIRED` named the snapshot of the dialog open. Each full read issues a new snapshot ID (contract §8). A second defect hid it: the dialog closed at the `accepted` event. Contract §2 sends that event before the approval checks, so a real `APPROVAL_EXPIRED` never reached the retry. | Fixed (T368). The dialog closes when the state leaves `accepted` (data-model §7) or at a terminal state other than `rejected`. The new review names the current generation and snapshot ID. Tests: "B4-1" in `tests/contracts/submodule-ui.test.tsx` and in `tests/contracts/workbench-mount.test.tsx`. Control mutation: the opened snapshot ID in the new review turned the workbench case red. |
| B4-1 follow-up | Each terminal `updateSubmodules` response started a full read, also an `APPROVAL_EXPIRED` one while the dialog stayed open. That read raced the new review. | Fixed (T368). An `APPROVAL_EXPIRED` update records its outcome and starts no read, because it started no Git process (contract §9). Every other end, such as `REPOSITORY_CHANGED`, keeps the full read. Tests: "B4-1" in `tests/contracts/renderer-freshness.test.ts`, and the two B4-1 read cases in `workbench-mount.test.tsx`. Control mutation: the read without the skip turned the `renderer-freshness.test.ts` case red. |
| B4-2 (medium) | Update submodules in the notice band and the menu, and Start update, ignored the workbench mutation block. A new update replaced the running operation in the status bar. The dialog also showed the busy reason for its own pending request. | Fixed (T368). They stay focusable and disabled while the block holds. The visible `BLOCKED_TEXT` reason is the description. The request ID of the dialog request exempts only that request from the Start update block. Tests: "B4-2" in `submodule-ui.test.tsx` and `workbench-mount.test.tsx`. Control mutation: the full block on Start update turned the own-request case red. |
| Switcher block | The workbench passed `busy={false}` to the repository switcher, against plan.md "Switch repository". | Fixed (T368). The switcher gets `busy` while a mutation runs. Test: "plan.md Switch repository" in `workbench-mount.test.tsx`. Control mutation: `busy={false}` turned it red. |
| T367 vector | `tests/vectors/valid/progress-running.json` held a `fetch` event without `path`, which the T367 refine refuses. | Fixed. T368 gave the valid vector a `path`. T367 then added the `path` rule to `progress` in `src-tauri/src/schema.rs`, gave the `fetch` event in `src-tauri/src/ipc.rs` a `path`, and added `tests/vectors/invalid/progress-fetch-without-path.json` (3120706). |
| B4-3 (medium) | The workbench found Cancel by the text "Cancel". | Fixed (T368). `StatusRegionHandle.cancel()` gives the Cancel element. Test: "B4-3" in `submodule-ui.test.tsx`. |
| B4-4 | The commit tray and the boot view showed codes in the body font. | Fixed (T368). They use `codeText`. Tests: "B4-4" in `tests/contracts/commit-tray.test.tsx` and `tests/contracts/boot-view.test.tsx`. |
| B4-5 | `codeText` added a final period. plan.md listed five texts that end in a code with a period. | Fixed (T368). `codeText` adds no period, and the plan.md rows match. Tests: the Select Git and Submodule review texts in `workbench-mount.test.tsx`, and "B4-4 and B4-5" in `commit-tray.test.tsx`. |
| B4-6 | The status bar decides "declined" from a `canceled` outcome without its own Cancel. No contract field names the cause. | Open, contract gap. plan.md "Status area" now states the invariant: the status bar is the only renderer Cancel sender of a mutation. T369 guards it: "T369" in `tests/contracts/workbench-mount.test.tsx`. |
| B4-7 | The review list options had no `aria-selected`. | Fixed (T368). Test: "B4-7" in `submodule-ui.test.tsx`. |
| B4-8 | A program with a row ID outside the plan showed an empty path. | Fixed (T368). The row shows its row ID in the code font. The contract has no refusal code for this case, and the program carries the row ID. Test: "B4-8" in `submodule-ui.test.tsx`. |
| B4-9 | `progress.schema.json` does not hold the `refine` rules. | Fixed in the contract text. Contract §1 "Schemas" states that the JSON Schema files do not hold the `refine` rules. The zod schemas hold them, and the shell `progress` check in `src-tauri/src/schema.rs` holds the same `phase`, `path`, and `distro` rules. No test applies. |
| Duplicate helper | `repositoryName` (`OperationStatus.tsx`) repeated `folderName` (`RepositorySwitcher.tsx`). | Fixed (T368). Only `folderName` stays. The status text tests pass. No control mutation applies. |
| Portability suspicion | `folderName` splits on "/" and "\". On POSIX, "\" is a name character. | Deferred to the macOS and Linux feature, as a contract gap. Contract §3 defines `worktreeRoot` only for the Windows and WSL forms: Windows (forward slashes) and WSL (UNC). The renderer has no platform value (`src/contracts/native-path.ts`: WebView2 has no `process`). The macOS and Linux targets must add both facts. |
| Trust report rows | `entries` and `hooks` had no count bound. The 4 MiB trust input bound alone allows about 300,000 entries, because the shortest `config list -z` record has 14 bytes. An untrusted `.git/config` could then make the Trust dialog render every row and stop responding. | Fixed (T372). `readTrust` refuses a report above 4,096 entries or 256 hooks with `OUTPUT_LIMIT` and the bound name. Tests: "T372" cases in `tests/git/trust.test.ts` and `tests/contracts/commit-tray.test.tsx`. Control mutation: without the entries check, the 4,097-entry case turned red. |
| WSL conhost count | A WSL `read` run without an anchor starts with `CREATE_NO_WINDOW`, so its conhost can still be in the Job count after `wsl.exe` exits. When a WSL hunk or file publish failed before its first `mutation` step, `executionLast` took the count of the last checkpoint read. The outcome then showed a false lingering sentence. Nobody has measured the conhost delay. | Fixed (T371). `recording` keeps the execution count only from `mutation`-policy runs, and `executionLast` is 0 when none ran. Test: "recording" in `tests/git/hunk-publish.test.ts`. Control mutation: the read counts kept again turned it red. |

**Batch 4 second review, 2026-10-13 (T149).** One independent subagent review checked batch 4 again. An investigator verified each finding and proposed the fixes. An implementer fixed B4R2-1, S2, and the T240 focus defect on branch b16-review-fixes, from main e951ad2. A later implementer fixed B4R2-2 (2ac428a). The test runs printed ORIGIN lines for the code under test.

| Finding | Failure and cause | State and proof |
| --- | --- | --- |
| B4R2-1 (low) | After a failed `AssignProcessToJobObject`, `ownTree` in `tests/git/win32.ts` waited up to 5 s on the process handle. A signal in that time counted as an exit. A wait result is a timing decision. | Fixed (T373). The root counts as exited only when `GetExitCodeProcess` succeeds and its code is not `STILL_ACTIVE` (259). Otherwise `ownTree` throws at once. Probe: 15 of 1,640 races failed the assignment, all with `GetLastError` 5 and exit code 0. Test: "ownTree does not throw for a fast Git command that exits during the assignment" in `tests/git/bun-runner.test.ts`. Control mutation: `exited = false` turned it red. |
| B4R2-2 (low) | The repository menu busy reason and the revoke status were `MenubarLabel` elements. `MenubarLabel` is the Base UI `Menu.GroupLabel`, so each text also named its group. | Fixed (T374). Both texts are plain `div` elements. Update submodules keeps the reason as its description through `aria-describedby`, and the status keeps `role="status"` outside an `aria-hidden` subtree. Test: "B4-2: while a mutation runs, …" in `tests/contracts/workbench-mount.test.tsx`. It asserts that neither group has `aria-labelledby` and that the status has no `aria-hidden` ancestor. `bun test tests/contracts/workbench-mount.test.tsx` gave 69 pass and 0 fail (2ac428a). Control mutation: `MenubarLabel` for the busy reason turned the `aria-labelledby` assertion red. |
| B4R2-3 | T366 stayed open, so no record showed that a full run used Bun 1.4.3. | Closed by the T366 record in "Dependency reviews". |
| S1: limited trust read | A `limited` `readTrust` result never shows its report (`Workbench.tsx`, `CommitTray.tsx`). Contract operations §3 and plan.md "Required visible states" define a text only for a failed read. §9 says that a `limited` result carries the §5 bound as its reason, but `TrustReport` has no `reason`. | Open, contract gap. The user decides. |
| S2: NSIS version | `NSIS_VERSION` in `src/frontend/build/notices.ts` came from the tauri-bundler 2.10.0 source, but no check tied it to the CLI that runs. The bundler reuses a cached `%LOCALAPPDATA%\tauri\NSIS` folder whatever its version. | Fixed (T375). For a Tauri Windows build (`TAURI_ENV_PLATFORM`), `build:notices` refuses a `cargo tauri --version` stdout other than `tauri-cli 2.12.0\n`. tauri-cli 2.12.0 pins `tauri-bundler = "=2.10.0"`. It also refuses a reused `makensis.exe /VERSION` stdout other than `v3.11`. Tests: the tauri-cli and makensis cases in `tests/contracts/notices.test.ts`. Control mutation: `tauriCliProblem` that always returns `[]` turned the tauri-cli case red. |
| T240 focus | Found in the T149 runs, not by the review. `tests/windows/uia.test.ts` invoked the start page option "Open folder… (Ctrl+O)". The filter combobox "Filter recent repositories" holds DOM focus and names the option through `aria-activedescendant`, so Invoke cannot focus the option. After the picker Cancel, focus returned to the document, and `waitFocus` timed out on every run. | Fixed (T376). The test focuses the combobox and confirms with `waitFocus` that UIA reports the option as focused before the invoke. Test: `bun test tests/windows/uia.test.ts` alone passed 7 of 7 against the installed main e951ad2 app. Control: the test without the two lines failed in two earlier runs. |
| T380 static frame | User report, 2026-10-16: a two-finger touchpad swipe moved the whole view sideways. wry 0.57.0 `set_webview_settings` already sets `IsSwipeNavigationEnabled` ([ICoreWebView2Settings6](https://learn.microsoft.com/microsoft-edge/webview2/reference/win32/icorewebview2settings6)) and `IsPinchZoomEnabled` ([ICoreWebView2Settings5](https://learn.microsoft.com/microsoft-edge/webview2/reference/win32/icorewebview2settings5)) to false, and `IsZoomControlEnabled` ([ICoreWebView2Settings](https://learn.microsoft.com/microsoft-edge/webview2/reference/win32/icorewebview2settings)) to false through `zoom_hotkeys_enabled(false)`. Both swipe and pinch changes apply only after the next navigation. | Fixed in CSS (T380). The root gets `overflow: hidden` and `overscroll-behavior: none`, and each pane gets `overscroll-behavior: contain`. The shell does not change. A packaged touchpad check stays open. |

### Dependency reviews

After T003 and T006, each dependency change gets one record here (plan.md, Tool and runtime boundaries). A record names the task and each added, removed, or changed package. It gives the old and new resolved versions, the licence, the reason, the reviewer, and the findings. It also lists the qualification checks that ran again.

- T059, 2026-10-03: the `windows` crate gets the feature `Win32_Security_Cryptography`. The resolved version stays `0.62.2`, and `Cargo.lock` does not change. Licence: MIT OR Apache-2.0. Reason: the shell hashes the mutation mutex name with `BCryptHash` and `BCRYPT_SHA256_ALG_HANDLE` (contract §6 "Recovery markers"). It also takes marker IDs from `BCryptGenRandom`. The feature adds no crate. Reviewer: the T059 implementer; the main session reviews the diff. Findings: none. Checks that ran again: `cargo test --locked`, `cargo clippy --locked --all-targets -- -D warnings`, and `cargo fmt --check`.
- T272, 2026-10-04: `package.json` adds the dependency `zod` `^4.6.5`. It resolves to `4.6.5`. Before, `bun.lock` held `zod` `4.6.5` only as the nested entry `@modelcontextprotocol/sdk/zod`, and `zod` `3.25.76` at the top level for `shadcn`. After, `zod` `4.6.5` is the top-level entry. `shadcn` and `@shadcn/registry` keep `zod` `3.25.76` as nested entries. Licence: MIT. Reason: zod is the single contract source (contract §1 "Schemas", IPC decision 2026-10-04). In the decision probe, it passed 51 envelope tests in Bun `1.4.2`. It validated a 1 MiB envelope in 1.65 ms. `z.toJSONSchema` keeps `additionalProperties: false`, string lengths, integer bounds, patterns, and literals as `const`. Reviewer: the T272 implementer; the main session reviews the diff. Findings: the package has no install script. The `allowsEval` probe in `zod/v4/core/util.js` calls `new Function` and falls back under a strict CSP. The renderer imports only types, so this probe never runs in WebView2. zod `4.6.5` `.max()` counts code points, as JSON Schema `maxLength` does (`zod/v4/core/checks.js:271-273`). The decision probe assumed UTF-16 units. So UTF-16 unit bounds and byte bounds stay explicit checks. Checks that ran again: `bun install --frozen-lockfile`, `bun run typecheck`, `bun run build`, `bun run test:contracts`, `bun run test:git`, and `bun test tests/windows/service-hardening.test.ts`.
- T274, 2026-10-04: `src-tauri/Cargo.toml` adds the build dependency `typify` `0.8.0` with `default-features = false`, so its proc macro is not built. `Cargo.lock` adds `typify` `0.8.0` and `typify-impl` `0.8.0`, both Apache-2.0. The lockfile already held the other dependencies of `typify-impl`. These are `heck` `0.5.0`, `log` `0.4.34`, `proc-macro2` `1.0.107`, `quote` `1.0.47`, `schemars` `0.8.22`, and `semver` `1.0.28`. They also include `serde` `1.0.229`, `serde_json` `1.0.151`, `syn` `3.0.6`, `thiserror` `2.0.21`, and `unicode-ident` `1.0.26`. The same change adds the build dependencies `schemars` `0.8.22` (MIT) and `serde_json` `1.0.151` (MIT OR Apache-2.0). Neither adds a lockfile entry. Reason: `src-tauri/build.rs` generates the serde types of the shell-read frames from `src/contracts/schemas/` (contract §1 "Schemas"). Reviewer: the T274 implementer; the main session reviews the diff. Findings: typify runs only at build time. Apache-2.0 is compatible with AGPL-3.0-or-later. typify needs a `title` on every union branch; without one it panicked at `type_entry.rs:377` in the decision probe. It drops `const` values and integer ranges, and its `maxLength` counts characters, not UTF-16 units. So the shell keeps those checks explicit. Checks that ran again: `cargo test --locked` twice, `cargo clippy --locked --all-targets -- -D warnings`, and `cargo fmt --check`.
- T274, 2026-10-04: `src-tauri/Cargo.toml` adds the dependency `regress` `^0.12.0`. `Cargo.lock` adds `regress` `0.12.0` (MIT OR Apache-2.0). Its only dependency `memchr` `2.8.3` was already in the lockfile. Reason: the typify output checks each schema `pattern` with `regress::Regex`. Regress implements ECMAScript regular expressions, so a zod pattern keeps its meaning in Rust. Reviewer: the T274 implementer; the main session reviews the diff. Findings: the crate ships in the shell binary. So the third-party notice inventory (plan.md "Tool and runtime boundaries") must list it. Checks that ran again: the T274 checks above.
- T211, 2026-10-04: the `windows` crate gets the feature `Win32_System_Registry`. The resolved version stays `0.62.2`, and `Cargo.lock` does not change. Licence: MIT OR Apache-2.0. Reason: the shell reads the `DistributionName` and `Version` values under `HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss` (contract §11 "Distro checks"). R7 "Win32 binding features" lists the calls. The feature adds no crate. Reviewer: an independent branch review; the main session reviews the diff. Findings: the record and the R7 row were missing, and this record adds them. Checks that ran again: `cargo test --locked`, `cargo clippy --locked --all-targets -- -D warnings`, and `cargo fmt --check`.
- T332, 2026-10-10: `src-tauri/Cargo.toml` adds the dependency `time` `^0.3.55` with the features `formatting` and `macros`. It resolves to `0.3.55`. `Cargo.lock` only adds `time` to the `arbareto` dependency list. It adds no package. Tauri already used `time` `0.3.55`, `time-core` `0.1.9`, and `time-macros` `0.2.32` through `cookie` and `plist`, with these features enabled. Licence: MIT OR Apache-2.0 for all three. Reason: `settings.rs` formatted the marker `startedAt` and the trust `approvedAt` with a hand-built calendar. A clock before 1970 then wrote 1970-01-01 without an error. Now `utc_from` takes `OffsetDateTime::from_unix_timestamp_nanos` and a fixed format with nine fraction digits and `Z`. A clock outside the `time` year range gives an `io::Error`. `OffsetDateTime::now_utc()` panics there, so the shell does not call it. Reviewer: the T332 implementer; the main session reviews the diff. Findings: the crate already shipped in the shell binary, so the notice inventory gains no package. Checks that ran again: `cargo test --locked settings`, `cargo test --locked schema`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo fmt --check`, and `bun test tests/contracts/`. Tools: rustc `1.99.0`, cargo `1.99.0`.
- T333, 2026-10-10: `src-tauri/Cargo.toml` adds the dependency `base64` `^0.23`. It resolves to `0.23.1`. `Cargo.lock` only adds `base64 0.23.1` to the `arbareto` dependency list. It adds no package. Tauri already used `base64` `0.23.1` at run time through `plist` and `tauri-utils`, with the features `std` and `simd-unsafe`. `base64` `0.22.1` is also in the lock, but only for build tools. Licence: MIT OR Apache-2.0. Reason: `process_requests.rs` encoded and decoded standard base64 by hand. Now `encode_base64` and `chunk` use `base64::engine::general_purpose::STANDARD`. Its `PAD` configuration requires canonical padding and refuses trailing bits, so every refused vector of the hand-built decoder stays refused. The empty text decodes to 0 bytes, and `chunk` refuses 0 bytes. Reviewer: the T333 implementer; the main session reviews the diff. Findings: the crate already shipped in the shell binary, so the notice inventory gains no package. Checks that ran again: `cargo update -p arbareto --offline` (it locked 0 packages), `cargo test --locked` with the filters `webview`, `process_requests`, `settings`, `bootstrap`, and `jobs`, `cargo clippy --locked --all-targets -- -D warnings`, and `cargo fmt --check`. Tools: rustc `1.99.0`, cargo `1.99.0`.
- T333, 2026-10-10: `src-tauri/Cargo.toml` adds the dependency `uuid` `^1.26`. It resolves to `1.26.1`. `Cargo.lock` only adds `uuid` to the `arbareto` dependency list. It adds no package. Tauri already used `uuid` `1.26.1` at run time through `tauri-utils`, with the features `std`, `rng`, `v4`, and `serde`. Licence: Apache-2.0 OR MIT. Reason: `settings.rs` `random_id` set the UUID version and variant bits by hand. Now `uuid::Builder::from_random_bytes` sets them, and `hyphenated` formats the text. The bytes still come from `BCryptGenRandom`, so an RNG failure still gives an `io::Error`. `Uuid::new_v4` panics on an RNG failure, so the shell does not call it. Reviewer: the T333 implementer; the main session reviews the diff. Findings: the crate already shipped in the shell binary, so the notice inventory gains no package. Checks that ran again: `cargo update -p arbareto --offline` (it locked 0 packages), `cargo test --locked` with the filters `webview`, `process_requests`, `settings`, `bootstrap`, and `jobs`, `cargo clippy --locked --all-targets -- -D warnings`, and `cargo fmt --check`. Tools: rustc `1.99.0`, cargo `1.99.0`.
- T333, 2026-10-10: `webview2-com-sys` `0.39.1` (MIT, already a dependency through `webview2-com`) gives `CompareBrowserVersions`. `Cargo.toml` and `Cargo.lock` do not change for it. Reason: `webview.rs` compared the four version parts by hand. `GetAvailableCoreWebView2BrowserVersionString` appends the channel name for Beta, Dev, and Canary, so the hand-built parse refused a newer preview runtime. Microsoft Learn (WebView2 Win32 globals) says to pass that text directly, that the channel information is ignored, and that the call returns `E_INVALIDARG` for text it cannot parse. Findings: the call runs in the statically linked loader, so `cargo test` runs it without a webview. A probe on 2026-10-10 found that the loader refuses only text that does not start with a digit. It compares `154.0.4258.37.1`, `154.+0.4258.37`, and `154.0.4258.37 x` as equal to the minimum, and `-154.0.4258.37` as newer. The only input is the loader output itself, so the shell accepts the loader rule. The shell still refuses text over 64 bytes, non-ASCII text, and text with a NUL before the call. Every call failure gives `WEBVIEW_UNSUPPORTED`. Checks that ran again: `cargo update -p arbareto --offline` (it locked 0 packages), `cargo test --locked` with the filters `webview`, `process_requests`, `settings`, `bootstrap`, and `jobs`, `cargo clippy --locked --all-targets -- -D warnings`, and `cargo fmt --check`. Tools: rustc `1.99.0`, cargo `1.99.0`.
- T123, 2026-10-09: `bunx --bun shadcn@4.21.0 init --base base --preset mira --yes`, then `add button tabs dialog dropdown-menu menubar --yes`. `package.json` adds the dependencies `@hugeicons/core-free-icons` `^4.3.5`, `@hugeicons/react` `^1.1.10`, `class-variance-authority` `^0.7.1`, `cn` `^0.4.0`, and `tw-animate-css` `^1.4.0`. They resolve to `4.3.5` (MIT), `1.1.10` (MIT), `0.7.1` (Apache-2.0), `0.4.0` (MIT), and `1.4.0` (MIT). `bun.lock` also adds `clsx` `2.1.1` (MIT) for `class-variance-authority`. Before, `bun.lock` held `cn` `0.2.6` only for `shadcn`. After, `cn` `0.4.0` is the top-level entry, and `shadcn` and `@shadcn/registry` keep `cn` `0.2.6` as nested entries. The `shadcn` devDependency keeps the range `^4.21.0`, and it resolves to `4.21.4` instead of `4.21.1`. `@shadcn/registry` moves from `0.1.0` to `0.1.3`. The lockfile drops `cosmiconfig` `9.0.2` and its 11 transitive packages. `menubar` adds no package. Licence: MIT and Apache-2.0, both compatible with AGPL-3.0-or-later. Reason: the Base UI shadcn components for the frame (plan.md "Keyboard and focus"). `src/frontend/lib/utils.ts` exports `cn` from the `cn` package. Its package description names it a replacement for `clsx` and `tailwind-merge`, and it has no dependencies. `tailwind-merge` is not in the lockfile. Reviewer: the T123 implementer; the main session reviews the diff. Findings: no added package has an install script. The generated components import `cn` from `cn`, not from `@/lib/utils`. The generator puts `tw-animate-css` in `dependencies`, but the `base-mira` registry index lists it as a devDependency. `src/frontend/index.css` imports `tw-animate-css`. `package.json` and `bun.lock` hold no `@fontsource-variable/inter`, because the plan uses system fonts. Checks that ran again: `bun install --frozen-lockfile`, `bun run typecheck`, `bun test tests/contracts/boot-view.test.tsx`, and `bun run build:frontend`.
- T263, T258, and T264, 2026-10-10: `package.json` adds the devDependency `@happy-dom/global-registrator` `^20.14.6`. It resolves to `20.14.6`. `bun.lock` adds `@happy-dom/global-registrator` `20.14.6` (MIT) and `happy-dom` `20.14.6` (MIT). It also adds `ws` `8.22.0` (MIT), `entities` `7.0.1` (BSD-2-Clause), `@types/ws` `8.18.2` (MIT), `whatwg-mimetype` `3.0.0` (MIT), `buffer-image-size` `0.6.4` (MIT), and `@types/whatwg-mimetype` `3.0.2` (MIT). `@types/node` `26.6.4` was already in the lockfile through `bun-types`. Licence: MIT and BSD-2-Clause, both compatible with AGPL-3.0-or-later. Reason: the Stage key, View menu, and Alt+Up/Alt+Down cases need focus, keyboard events, and a mounted tree. The Bun test documentation uses happy-dom with this registrator. Each DOM test file registers the DOM itself (`tests/dom.ts` `registerDom()`) and removes it in `afterAll`, so no other test file runs with a DOM. Reviewer: the T263 implementer; the main session reviews the diff. Findings: no added package has an install script. No file in `src/` imports these packages. `happy-dom` and the registrator declare `engines.node` `>=20.0.0`. Version `20.14.6` was published on 2026-10-08. `register()` throws on a second call, and `unregister()` returns a Promise. React DOM checks for the DOM once at module load, so each DOM test file loads React DOM after `registerDom()`. Checks that ran again: `bun install --frozen-lockfile`, `bun run build:frontend`, `bun run typecheck`, and `bun test` on the changed files, `boot-view`, `shortcuts`, `preferences`, `layout-profiles`, and `envelope`. Tools: Bun `1.4.2`.
- T338, 2026-10-10: `build:notices` takes the Cargo crate set from the T149 oracle `cargo tree -e normal,no-proc-macro --target x86_64-pc-windows-msvc --prefix none --locked --offline`. Before, the `cargo metadata --filter-platform x86_64-pc-windows-msvc` closure held 182 crates, and the oracle held 136. The 46 extra crates came from features that build dependencies enable, because `cargo metadata` unifies features across dependency kinds. Examples are `selectors` 0.38.0 (through `tauri-utils` from `tauri-build`), `quote`, and `proc-macro2`. The resolve graph also listed the optional `tray-icon` 0.25.1, but `tauri` has no `tray-icon` feature. Now both sets hold the same 136 crates. No package changes. Reviewer: the T338 implementer.
- T338, 2026-10-10: `third-party-licenses/npm/lru_map@0.4.1/README.md`, SHA-256 `d444ac3606db5ac9790b4aa809172b9f7d88fe7a0093a1b01fd0abefb277dc05`. Source: https://raw.githubusercontent.com/rsms/js-lru/77c51e90dbcf4ffc0d27e6bc04a012a6b54a05e1/README.md. The commit is the npm `gitHead` of `lru_map` 0.4.1; the repository has no tags. At that commit, the MIT licence text is the last section of `README.md`. The repository added `LICENSE.txt` only later, in `f9381a69e17c194e927581a85782e79cc87095d3`. The file is byte-identical to the `README.md` of the installed package. Licence: MIT.
- T338, 2026-10-10: `third-party-licenses/cargo/webview2-com@0.39.1/LICENSE` and `third-party-licenses/cargo/webview2-com-sys@0.39.1/LICENSE`, each SHA-256 `0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73`. Source: https://raw.githubusercontent.com/wravery/webview2-rs/edc2caf886175ccaebe86078c9cfe1ae2a187328/LICENSE. Both crates give this commit in their published `.cargo_vcs_info.json`. Licence: MIT.
- T338, 2026-10-10: `third-party-licenses/cargo/alloc-stdlib@0.3.0/LICENSE`, SHA-256 `c0c56f26d9c051cac4d200c34c84e7ae9aaa853e01a982a1df08b09931e518ae`. Source: https://raw.githubusercontent.com/dropbox/rust-alloc-no-stdlib/0a81fd6928ea3b33c8cd484aa4575d50ffb98012/LICENSE. The crate gives this commit in its published `.cargo_vcs_info.json`. Licence: BSD-3-Clause.
- T338, 2026-10-10: `third-party-licenses/runtime/bun@1.4.2/LICENSE.md`, SHA-256 `b9caf52728691b4057e371232c221a132883198be2f3d2ddf92c90404c984b1a`. Source: https://raw.githubusercontent.com/oven-sh/bun/744846f844374847c902b5e7fd59b4342a51ef99/LICENSE.md. The tag `bun-v1.4.2` points to this commit. The file lists the statically linked libraries and links to their licences. It does not hold the full LGPL-2 text.
- T338, 2026-10-10: the build ships only the R9 "Highlight set", so `build:notices` lists `tm-grammars` 1.32.22 and `tm-themes` 1.12.12 and no Oniguruma WASM. Sources: https://registry.npmjs.org/tm-grammars/-/tm-grammars-1.32.22.tgz (SHA-256 `6d75b2699fe65499bfb81d7e002d79116f2e9d56c417d3fcdd128c239db9e1b1`, npm integrity matches) and https://registry.npmjs.org/tm-themes/-/tm-themes-1.12.12.tgz (SHA-256 `5356259b4fdb1b5a769eb2df5b7223ebac5190a15987520c0e453d5cdb2c1cca`). Source `NOTICE` SHA-256: `26b10bb42960080d6dfabcd1d4f2ae69a5bf104b30fea399c646f598551e7519` (tm-grammars) and `5562622d13daf3f745bca7ccdc2bf3f77d6720cf5d41f1ee34e3e46cf4e226f9` (tm-themes). Version link: no installed package pins these versions; `@shikijs/langs` 4.5.0 and `@shikijs/themes` 4.5.0 give the ranges `^1.32.22` and `^1.12.12`. Each shipped grammar in `@shikijs/langs` 4.5.0 equals `grammars/<id>.json` of tm-grammars 1.32.22 without the Shiki keys `aliases`, `embeddedLangs`, and `embeddedLangsLazy` (deep compare, 28 of 28). The shipped grammar files and the `github-light` theme equal these upstream releases. The `github-dark` file equals its upstream release, and its loader in `src/frontend/highlight/set.ts` changes two foregrounds at load time: comments `#6a737d` → `#959da5` and `markup.changed` `#ffab70` → `#ffffff` (plan.md "Dark palettes").
- T338, 2026-10-10: `third-party-licenses/npm/tm-grammars@1.32.22/NOTICE`, SHA-256 `647f5d117ab213d5f1a261714906dd89e663ae88dde0eb13149d011991d73a0d`, and `third-party-licenses/npm/tm-themes@1.12.12/NOTICE`, SHA-256 `a10afb6869fd79ddbba61e34b65e047b41e0dbb15192f32e7a3bf66f9f0a8504`. Each file is one per package. It keeps the source preamble and the blocks that cover a shipped file. The `Files:` line of a kept block lists only the shipped files. All other bytes are verbatim. tm-grammars keeps three MIT blocks (Microsoft vscode, fwcd/vscode-kotlin, jtbandes/swift-tmlanguage). tm-themes keeps one MIT block (primer/github-vscode-theme). `LICENSE` in both folders is the package MIT licence, SHA-256 `7a9d8d01038aeacf9e5bcdabbddf2a7815200dce9fc1118468cc553e00ae3eee`, byte-identical to the tarball file.
- T247, 2026-10-10: the `windows` crate gets the features `Foundation` and `UI_ViewManagement`. `UI_ViewManagement` also enables `UI`. The resolved version stays `0.62.2`, and `Cargo.lock` does not change. Licence: MIT OR Apache-2.0. Reason: the shell reads `UISettings.TextScaleFactor` and subscribes to `TextScaleFactorChanged` (plan.md "Windows text size", contract §2 `text-scale`). R7 "Win32 binding features" lists the calls. The features add no crate. Reviewer: the main session reviews the diff. Findings: none. Checks that ran again: `cargo test --locked`, `cargo clippy --locked --all-targets -- -D warnings`, and `cargo fmt --check`.
- Picker fix, 2026-10-11: `src-tauri/Cargo.toml` removes the dependency `tauri-plugin-dialog` `2.8.0`. `Cargo.lock` removes `tauri-plugin-dialog` `2.8.1`, `tauri-plugin-fs` `2.6.0`, `tauri-plugin` `2.7.1`, and `rfd` `0.16.0`. It also removes `windows-sys` `0.60.2`, `windows-targets` `0.53.5`, and the eight `windows_*` `0.53.1` target crates. It adds no package. The `windows` crate gets the features `Win32_System_Com`, `Win32_UI_Shell`, and `Win32_UI_Shell_Common`. The resolved version stays `0.62.2`. Licence of the new features: MIT OR Apache-2.0. Reason: rfd sets only `FOS_PICKFOLDERS` and turns every picker error into `None`. So Select Folder on search results gave a Cancel, and the user saw nothing. The shell now calls `IFileOpenDialog` with `FOS_FORCEFILESYSTEM` and gives `PICKER_FAILED` for each failure other than `ERROR_CANCELLED` (contract §3). Reviewer: the main session reviews the diff. Findings: none. Checks that ran again: `cargo test --locked`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo fmt --check`, `bun run typecheck`, `bun run export:schemas --check`, `bun install --frozen-lockfile`, and a live dev-build check of the folder picker.
- T366, 2026-10-11: the exact Bun pin moves from `1.4.2` (commit `744846f844374847c902b5e7fd59b4342a51ef99`) to `1.4.3`. The tag `bun-v1.4.3` points at commit `c6da4a4d3010e5553438c60f6bd76d981976867c`, released 2026-10-10. `@types/bun` stays `~1.4.2`, because npm has no `@types/bun` 1.4.3. `bun.lock` does not change. Licence: MIT plus linked-component obligations. `third-party-licenses/runtime/bun@1.4.3/LICENSE.md` replaces the `bun@1.4.2` folder, SHA-256 `056696884250b0d682365260cf1487a6501b1665a343ec60e23a1e647043c572`. Source: https://raw.githubusercontent.com/oven-sh/bun/c6da4a4d3010e5553438c60f6bd76d981976867c/LICENSE.md. The file adds one Apache-2.0 row: the `bun check` type checker is a port of typescript-go and ships TypeScript diagnostic messages and `lib.*.d.ts` files. Reason: the pinned runtime moves to the current release. Reviewer: the main session reviews the diff. Findings: Bun 1.4.3 reads two new variables in a compiled executable, `BUN_BYTECODE_ORDER_OUT` and `BUN_BYTECODE_DIGEST_OUT` (R7). Each one makes the service write a file at a path that the caller chooses. The shell now removes both. The compiled service holds TypeScript diagnostic texts, for example `Type '{0}' is not assignable to type '{1}'.`, and the name `lib.es5.d.ts`. The 1.4.2 `bun.exe` holds neither. Decision: ship the typescript-go `NOTICE.txt`, because Apache-2.0 §4(d) requires it. `third-party-licenses/runtime/bun@1.4.3/typescript-go-NOTICE.txt`, SHA-256 `f5c708b59114507b8b27b48181b6883d106bbca0c1634bbee45b5e344237b66b`. Source: https://raw.githubusercontent.com/microsoft/typescript-go/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/NOTICE.txt. Bun pins this revision in `test/cli/check/typescript-go/version.json`, and the tag `typescript/v7.0.2` points at it. Bun `src/sema/messages.rs` names typescript-go 7.0.2 as the source of the messages. `scripts/update-typescript-libs.ts` takes the `lib.*.d.ts` files from npm `typescript@7.0.2`. The `NOTICE.txt` of npm `typescript` 7.0.2 and `@typescript/typescript-win32-x64` 7.0.2 is byte-identical to the source file. The Bun copy in `test/cli/check/typescript-go/NOTICE.txt` differs only in line ends (LF instead of CRLF). microsoft/TypeScript at `4d4f005c8541e0255a9d8791205fdce326e462bc` has no `NOTICE` file. It has `LICENSE.txt` (Apache-2.0) and `ThirdPartyNoticeText.txt`, and `LICENSE.txt` does not name that file. `build:notices` adds every file of the runtime folder to the Bun entry, and it refuses a runtime folder without `LICENSE.md` or `typescript-go-NOTICE.txt` (`BUN_RUNTIME_FILES`). Checks that ran again on Bun 1.4.3: `bun install --frozen-lockfile`, `bun run typecheck`, `bun run export:schemas --check`, `bun run build`, `bun run test:contracts`, `bun run test:windows`, `cargo test --locked`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo fmt --check`, and T366 live checks 1, 4, 5, and 7. After the NOTICE change: `bun run build:notices` and `bun test tests/contracts/notices.test.ts`. Control mutation: without the NOTICE file, `build:notices` exits 1 with `NOTICE_PROBLEM Bun runtime 1.4.3: no typescript-go-NOTICE.txt`, and the T366 case of `notices.test.ts` fails.
- T366 live checks, 2026-10-12, Bun 1.4.3 (revision `c6da4a4d3010e5553438c60f6bd76d981976867c`) on Windows. Probes: `tests/windows/probe-bun-runtime.ts` (checks 1, 4, 5, and 6) and `tests/git/probe-bun-watch.ts` (checks 2 and 3). Check 1 passes: the compiled service from `c64f4e7` gets both `BUN_BYTECODE_*` variables and a closed stdin, exits 0, and writes both files (order file 3 bytes, digest file 0 bytes). Check 2 passes: after the removal of the watched directory, 1001 `rename` events come in 2000 ms, 501 of them in the second half, with no `error` event. 1000 files written while the event loop is blocked give one `change` event with a `null` name (libuv `uv_directory_watcher_buffer_size` 4096). Check 3 fails on Ubuntu-26.04 (Bun 1.4.3 installed for the user, revision `c6da4a4d`), 3 of 3 runs: the removal of a recursively watched root gives `rename "sub/a.txt"`, `rename "sub"`, and `rename` with an `undefined` name, then silence, with no `error` event. No event has a `null` name. The Bun 1.4.2 source gives the same value: `path_watcher.rs:1086-1094` keeps an empty relative path for a recursive root, and `node_fs_watcher.rs:917-927` emits `undefined` for an empty name. Only `IN_Q_OVERFLOW` gives `null` (`path_watcher.rs:293-304`). So `watch.ts` does not re-arm after this event on Linux. Check 3 passes on 2026-10-12 after the fix: `watch.ts` also re-arms on an `undefined` name, and the probe verdict expects that name. `VERDICT T366-3 PASS: an undefined name, then silence (last of 3 events: rename undefined, 0 null names, 0 errors)`, 3 of 3 runs, Bun 1.4.3 revision `c6da4a4d` on Ubuntu-26.04. Check 4 passes: `typeof resourceUsage().cpuTime.total` is `bigint`. Check 5 passes: `bun test ./a.test.ts` runs only `a.test.ts`, and the control `bun test a.test.ts` also runs `xa.test.ts` (junit report). `docs/test/discovery.mdx` is byte-identical at the 1.4.2 and 1.4.3 commits. Check 6 passes: a Bun parent killed through `proc.kill()` exits 143, and its Bun child ends (process record by PID and creation time). Checks 1 to 6 pass, so the Bun 1.4.2 behaviour comments now name Bun 1.4.3.
- NSIS licence, 2026-10-12: `third-party-licenses/tools/nsis@3.11/COPYING`, SHA-256 `e7dd514003ab96cb3ddccbc028fe5c795fccf57dc41f21cfb9d4dd16ead23bf5`, 15632 bytes. Source: entry `nsis-3.11/COPYING` of https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip, zip SHA-1 `ef7ff767e5cbd9edd22add3a32c9b8f4500bb10d`. Tauri bundler 2.10.0 `nsis/mod.rs:38-41` pins this URL and SHA-1. Licence: zlib/libpng, bzip2, CPL-1.0. Reason: `cargo tauri build` runs `beforeBuildCommand` before the bundler downloads NSIS. `build:notices` read `%LOCALAPPDATA%\tauri\NSIS\COPYING`, so a machine without an earlier bundle could not build. Now `build:notices` reads the vendored copy (`NSIS_VERSION`). It refuses a bundler copy that differs from it. Reviewer: the main session reviews the diff. Checks: `bun test tests/contracts/notices.test.ts`, `bun run build:notices` on a machine without `%LOCALAPPDATA%\tauri\NSIS`, `bun run build`, and `bun run typecheck`. Control mutation: without the vendored file, `build:notices` exits 1 with `NOTICE_PROBLEM NSIS: no licence text`, and two NSIS cases of `notices.test.ts` fail.
- T366 `@types/bun`, 2026-10-13: the devDependency `@types/bun` moves from `~1.4.2` to `~1.4.3`. npm published `@types/bun` 1.4.3 on 2026-10-12. `bun.lock` changes `@types/bun` from `1.4.2` to `1.4.3`, and `bun-types` from `1.4.2` to `1.4.3`. `bun-types` 1.4.3 adds the dependency `undici-types` `*`. `bun.lock` already held `undici-types` `8.9.0` through `@types/node`, so no package is added. Licence: MIT for both. Reason: T366 kept `~1.4.2` only until npm had `@types/bun` 1.4.3. Reviewer: the main session reviews the diff. Findings: `build:notices` writes a byte-identical `notices.json` with 209 entries, because no shipped package changes. Checks that ran again: `bun install --frozen-lockfile`, `bun run typecheck`, `bun run build:notices`, `bun test tests/git/bun-runner.test.ts`, and `bun test tests/contracts/notices.test.ts`.
- T366 close, 2026-10-13: the user decided that the T149 full run on main `e951ad2` on 2026-10-13 satisfies the clause "Full run 4 runs on Bun 1.4.3". The run numbering changed after T366 was written. The run used `bun test v1.4.3 (c6da4a4d3)`. `test:all` on Ubuntu-26.04 with 6 workers ran 136 files and 4,774 tests with 0 failures. Every ORIGIN line is under `C:\Projects\arbareto\`. The Ubuntu-24.04 registration file gave 38 pass and 4 skip. `test:windows` gave 107 pass, 4 skip, and 0 fail. `cargo test` gave 435 passed and 4 ignored. `cargo clippy -D warnings` and `cargo fmt --check` passed. The `drafts.ts` and `close.rs` control mutations turned red, then green again. The `@types/bun` record above closes the last clause.

## R11. Planning artifact checks

Mechanical checks on 2026-09-28 found no broken local document links or unresolved template markers. The sentence-length check found no prose sentences above 20 words.

The active feature and branch remain `001-desktop-qualification`. No tracked files changed. Only new artifacts inside the selected feature were written.

No application package or source tree was created. `/speckit-tasks` later created `tasks.md` (T001 to T187 at that time). No application build, mutation test, installer test, or benchmark ran.

The extension configuration was absent before planning and during the post-plan check. No extension hooks required execution.

One independent document review completed. It found three contract inconsistencies. All three received document corrections; no application behavior was tested.

| Finding | Correction |
| --- | --- |
| Registration needed IDs before discovery could issue them. | Added native-owned probe/discovery contexts, fixed permitted queries, expiry, and permanent-ID issuance rules. |
| Required request generation was missing from the strict envelope. | Added `repositoryGeneration`, operation-specific requirements, and refresh/cancellation exceptions. |
| Unsupported prerequisite versions had no admission rule. | Added an exact local-package whitelist, separate admission/qualification states, error codes, and rejection cases. |
| Git and WebView2 admission and the manifests used exact versions. | On 2026-09-29, moved Git and WebView2 admission to minimum versions. Moved manifests to minimum versions under constitution `2.0.0`. Lockfiles keep the exact resolved versions. Bun stays exact. |

The last row records a 2026-09-29 policy change, not a review finding.

The Git and WebView2 minimum versions are conservative qualification boundaries, not claims about upstream minimum versions. Broader support requires reviewed evidence.

That review covered the initial architecture artifacts. The later interface review corrected category handling and revision-bound draft clearing. No automatic review loop ran.

### Graph and mutation update, 2026-09-29

The user answered one clarification and selected standard Git commit behavior. The update changes clarification, scenarios, scope, requirements, entities, success criteria, and assumptions in `spec.md`.

The spec-quality checklist is re-validated after the 2026-09-29 decisions. That step records the result in `checklists/requirements.md`. These checks assess specification quality, not implementation readiness or runtime qualification.

Mechanical checks covered six design documents, including table-cell sentences. Local links, code fences, sentence lengths, and placeholder checks passed. A re-run after the About window update checked FR-001–FR-037, SC-001–SC-014, F01–F20, and UI-01–UI-15. It found them unique, consecutive, and validly referenced. Note, 2026-10-01: the whole-file staging, WSL, and submodule updates changed the ranges. At that time, they were FR-001–FR-054 and SC-001–SC-017. They were also F01–F31, UI-01–UI-16, and T001–T245. The speed remediation of 2026-10-01 adds SC-015 conditions C1–C20. The UX remediation of 2026-10-01 extends the ranges to F01–F32, UI-01–UI-19, and T001–T251. The fourth safety remediation of 2026-10-01 extends the task range to T001–T252. The fetch-order and stall decisions extend it to T001–T257, and the fifth analysis remediation to T001–T260. The verification remediation of 2026-10-01 adds no task. The H1 safety remediation of 2026-10-01 extends the task range to T001–T262. The H2 UX and speed remediation of 2026-10-01 extends it to T001–T264.

All 54 checked color pairs pass their applicable numerical contrast thresholds: 30 token pairs and 24 lane pairs. The graph's 24 stroke/background pairs have a minimum ratio of 4.66:1. Divider pairs are informational and have no threshold. Rendered accessibility and Windows behavior remain untested.

The clarification post-hook configuration is absent. No application files, build outputs, executable tests, or additional planning hierarchy were created. The constitution and tracked repository files remain unchanged by that update. Later on 2026-09-29, constitution `2.0.0` amended Principle VIII to minimum versions with committed lockfiles. R11 records that policy change.

One independent review of this update found two material contract gaps. Both received document corrections. No additional review cycle ran.

| Finding and cause | Correction and required proof |
| --- | --- |
| Commit attribution required bounded evidence but defined no aggregate output limit. Frame limits did not bound the stream. | Added 4 MiB and 10,000-record aggregate reference/reflog limits per reconciliation attempt. Overflow leaves the result unknown. F20 tests both limits. |
| A successful status refresh could clear an unresolved-attribution block. The model and operation contract had different recovery conditions. | Recovery refresh now performs required reconciliation before enabling mutations. Status success alone cannot release the gate. F20 tests the distinction. |

These corrections have not received runtime verification. Hunk publication, commit effects, attribution, cleanup, and cancellation remain untested. Graph correctness, rendered accessibility, screenshots, installation, performance, signing, and authenticated updates also remain unverified.

### Safety and lifecycle remediation, 2026-09-30

A `/speckit-analyze` pass found safety and lifecycle gaps. The maintainer also decided that trust approval persists across launches. Document corrections follow; the R2, R4, and R5 probes and the R7 source scan support them.

| Finding and cause | Correction and required proof |
| --- | --- |
| Discovery ran `rev-parse --shared-index-path`, which loads the index. A probe ran a local `core.fsmonitor` canary before trust approval. | Discovery drops the option. Split-index state comes from the raw `link` extension. T068 adds a discovery canary case. |
| `gpg.ssh.defaultKeyCommand` ran during a commit, but the signing list omitted it. | Contract §7 adds it to the signing programs and the value allowlist. T071 and T098 expect `TRUST_REQUIRED`. |
| Key subsections and origins carried URL credentials into displays. | The service redacts URL user information before display or logging. T014, T071, T073, and UI-06 check canaries. |
| The commit task skipped the mutation exclusion and the recovery marker. | T112 enters the T106 exclusion and waits for `started`. T098 adds commit `BUSY`, `LOCKED`, and marker-order cases. |
| `TRUST_CHANGED` had no clearing rule. | Contract §7 defines refresh plus reselection, or renewed approval. T071 and T096 test both paths. |
| Only a renderer dialog confirmed trust approval. | The shell shows a native confirmation with a Cancel default before it stores an approval (T060). |
| Markers of deleted repositories never resolved. A failed marker write gave `SERVICE_UNAVAILABLE`. | Explicit dismissal with a native confirmation, and the code `RECOVERY_MARKER_FAILED`. T052 and T100 test the limit above 64. |
| After Restart service, the page kept invalid repository IDs. | The page runs `restoreWorkspace` again. Mutations stay blocked until a refresh in the new session. T188 tests the bridge. |
| An initialization script cannot carry a session that starts later. | The shell starts the service first and answers `currentSession`. |
| Each open registered a new workspace until `WORKSPACE_LIMIT`. | Registration reuses the same worktree and releases another repository. A contract check opens 20 times. |
| Stat-only index rewrites and the 60-second lifetime expired hunk approvals. | The renderer requests the comparison again and keeps a hunk with an unchanged digest. Poll-time invalidation stays raw. |
| A hook rejection showed no reason, because hook output stays hidden. | `HOOK_FAILED` and a `GIT_FAILED` after handoff carry a remedy command. Clear message sits beside `completed-with-effects`. |
| Minor gaps: running state after a service crash, trace2 override, hunk recovery rule, T149 isolation, and the T171 dirty build. | Contract, plan, and task corrections. T151 moves to batch 4, before T149. |

These corrections have not received runtime verification.

### Build, coverage, and ordering remediation, 2026-09-30

A second `/speckit-analyze` pass found build, implementability, coverage, and ordering gaps. Document corrections follow; npm registry reads, the `windows` crate source, and the pinned Tauri and Cargo sources support them.

| Finding and cause | Correction and required proof |
| --- | --- |
| Only Vite disclosed its Node range (Constitution II). | plan.md Technical Context and R9 list every declared range and the `bunx --bun` mitigation. |
| `cargo test` needed `dist/` and the sidecar before any service build. | T189 builds both from a stub before the Rust tests. |
| Hunk eligibility had no batch 2 test, and the built-in monitor had no refusal test. | T190 tests eligibility, and T096 adds `core.fsmonitor=true`. |
| A stored trust approval survived edits of repository hook files. | Contract §7 adds program file digests. T071 and T098 edit a hook file. |
| The Git selection confirmation used the dialog plugin. | T060 uses `TaskDialogIndirect` with a Cancel default. |
| No task created the startup contexts for the saved Git path and the last repository. | Contract §6 "Startup contexts"; T060, T063, and T183. |
| The notice generator and the native suites had no failing-first check or control mutation. | T191 tests the generator. T065 and T149 add native control mutations. |
| Other gaps: `windows` features, maintenance detach, minimum-version wording, stale-code sequence, F14 builders, packaged triggers, and build identity reruns. | Contract, plan, quickstart, and task corrections. |

These corrections have not received runtime verification.

### UX, speed, and journey remediation, 2026-09-30

A third `/speckit-analyze` pass found UX, speed, and user-journey gaps. The maintainer decided the launch view and the right-click scope (spec Clarifications, 2026-09-30). Sources in R2, R5, R6, and R7 and Microsoft Learn support the corrections.

| Finding and cause | Correction and required proof |
| --- | --- |
| The cold done frame needed a selected diff and History, but nothing selected a diff. | plan.md defines the done frame, the marker, the `GPU` profile, and the DXGI present provider. T193 authors `tests/windows/arbareto.wprp`; T165 only confirms. |
| Every poll ran a full read, and poll cost was first measured in batch 5. | Contract §8 adds a stat change check. T192 records read and poll CPU on M and L in batch 2, so T164 moves to batch 2. |
| `readHistory` waited for a status snapshot. | It binds the generation and the captured HEAD and runs beside `readWorkspace`. T070 and T072 test it. |
| The cold path was serial and first timed in batch 5. | plan.md lists the critical path and the permitted overlaps. T193 and T192 record observations. |
| A setting set after creation cannot protect the first document, and Tauri exposes neither wry attribute. | The hidden window gets `AcceleratorKeyPressed` and `ContextMenuRequested` handlers before it shows (R7). T051, T058, and T157 cover them. |
| Unsupported entries showed no way forward. | Contract §4 adds copyable whole-file remedies. T093 runs each remedy in a copy. |
| An over-bound repository could never get trust approval. | A session-only approval stores no record (contract §7). T071 covers it. |
| A bare-name program in a relative `PATH` entry had no digest. | The service repeats the Git for Windows lookup and digests the repository file (R5). T071 covers it. |
| Density rows left no room for the focus ring, and the narrow comparison fell below 220 DIPs. | plan.md adds row heights, a row button, and a height budget. T122 checks each profile. |
| Near lane pairs were hard to tell apart. | Lightness changes give an OKLab pair distance of at least 0.101. The minimum lane contrast stays 4.66:1. T118 checks the palette. |
| Other gaps: success copy, No selection, F6 stops, menu bar access, roles, and review Tab order. Others are key hints, HEAD labels, selected-hunk shape, Git proposal, scope text, `NOT_A_REPOSITORY`, and state names. | Contract, data-model, plan, quickstart, checklist, and task corrections. |

These corrections have not received runtime verification.

### Safety remediation, fourth pass, 2026-09-30

A fourth `/speckit-analyze` pass found safety gaps. Document corrections follow; the R4 and R5 probes support them. The probes used Git `2.55.0.windows.3`, PowerShell `7.6.6`, and Windows PowerShell `5.1.26100.9444`.

| Finding and cause | Correction and required proof |
| --- | --- |
| Only history and object reads passed `--no-lazy-fetch`. In a partial clone, other reads and `commit` ran a repository `remote.origin.uploadpack` canary without approval. | Every app Git command passes `--no-lazy-fetch`. A missing object gives `OBJECT_MISSING` through a `cat-file --batch-check` object check. FR-025 covers every operation. F17, T066, T071, and T098 add a partial-clone canary. |
| Remedies doubled only U+0027. PowerShell also ends a single-quoted string at U+2018, U+2019, U+201A, and U+201B. | Contract §4 doubles all five. T093 and T098 test each character in a file name and in a worktree root. |
| Completion named no exit signal. A `post-commit` child held Git's stderr for 8 seconds after Git exited. | Completion is the process handle signal, and the shell discards later pipe bytes. T023, T027, T045, T153, and T163 cover it. |
| The untracked read `diff --no-index` ran `diff.external`, `textconv`, and the clean filter. Contract §7 did not list it. | A `diff` form carries `--no-ext-diff --no-textconv`, and a `filter` attribute refuses first. Contract §7, T067, T071, and T101 list it. |
| Only reads and commit had deadlines. The state table lacked rows for a mutation deadline, cancellation or close during reconciliation, and revoke with lingering processes. | Contract §5 adds a 30-second deadline for each other Git process. data-model §7 adds the rows. T013 and T100 test them. |
| `LOCKED` was promised for any lock that a lingering process holds. Only a failed creation of the app's own `index.lock` gives `LOCKED`. | Other locks give `GIT_FAILED` or `failed-with-effects` with the observed lock paths and the lingering count. T098, T100, and T153 add a ref-lock child. |
| The session-only approval text said "until Arbareto closes", but Restart service also ends the session. | The confirmation names both ends. The spec, plan, data model, and contract agree. T071 and T163 check Restart service. |
| A hook rejection hid the hook output, and the remedy ran `git commit`. After a passing hook, that command would create a commit outside the review. | The failure shows a bounded, sanitized, redacted output tail. The remedy runs `hook run --ignore-missing pre-commit`. T098 proves that it creates no commit. |

These corrections have not received runtime verification.

### Whole-file staging and commit summary, 2026-09-30

The user added Stage file and Unstage file to this slice. The safety pass also found a commit exit status that reconciliation had to override. The R3 and R5 probes support the corrections.

| Finding and cause | Correction and required proof |
| --- | --- |
| Binary files, renames, and other whole-file changes needed a terminal. | FR-038 and the operation `applyFile` on the hunk candidate protocol (contract §4 "File staging"). The operation count became 19 at that time, and the submodule update later raised it to 21. T194 to T203 add fixtures, contract types, real-Git tests, the service, the renderer control, and a packaged step. |
| `hash-object --stdin --path` differed from `git add` for a CRLF index blob and for an index-only attribute file. | Stage runs `update-index --add --remove` on the candidate. Working-file digests bind the bytes. The residual gap for identical rewrites is stated in R3. |
| In a partial clone, `commit --file=-` exited 128 in its summary after HEAD moved. | The commit passes `--quiet`. T098 expects exit 0, all three hooks, and `succeeded` for F17. |

These corrections have not received runtime verification.

### Staging proofs and WSL repositories, 2026-09-30

A safety package closed two staging gaps and found a third. The user added WSL2 repositories to this slice (spec Clarifications, 2026-09-30). The R3 probes 7 to 9 and the R13 probes P1 to P5 support the corrections.

| Finding and cause | Correction and required proof |
| --- | --- |
| Stage file could not detect a writer that changed and restored the working file during the Git step. | Step 6 proves the staged blob by `cat-file --filters` or `hash-object --stdin --path`. Without a proof, it refuses with `STALE_SELECTION` or reason `blob-proof`. T196 and T197 cover each branch. |
| A candidate copy got a new file time, so Git lost its racy-entry check. A published hunk candidate hid a working change in 10 of 30 runs. | The candidate time stays at most the canonical index time, for hunks and files. T094 and T196 repeat a racy fixture 20 times. |
| `core.splitIndex=true` split a private candidate and wrote into the Git directory. One write deleted the shared index of the canonical index. | Refuse it from any scope with reason `split-index`, and drop `GIT_TEST_*` variables. F10, T190, T096, and T197 cover both operations. |
| Windows Git cannot serve a WSL repository, and a Windows Job does not own Linux processes. | Contract §11: distro Git 2.55.0 or later, a systemd user scope per process, and an anchor for lingering processes. FR-039 to FR-046, SC-016, F21 to F26, and T204 to T219. |
| `FileIdInfo` fails on WSL paths, and `--cd` with a missing directory runs in `/`. | WSL identity comes from Linux `stat`. Git gets the directory through `-C`. |

These corrections have not received runtime verification.

### Submodule update and probe fixes, 2026-10-01

The user added submodule initialization and recursive update to this slice (spec Clarifications, 2026-09-30). The R13 P3 and R14 probes support the corrections.

| Finding and cause | Correction and required proof |
| --- | --- |
| The Windows Git probe passed `--no-lazy-fetch`. Git before 2.45.0 rejects it, so `GIT_UNSUPPORTED` could not name the found version. | Both version probes run without it, outside any repository. Contract §7 states the exception once. T053 and T067 test it. |
| A WSL distro without a systemd user session had an open choice between a refusal and an ownership limit. | The user chose the refusal. The remedy names `systemd=true` under `[boot]` in `/etc/wsl.conf` and a distro restart. |
| Submodules were read-only. | FR-047 to FR-054, SC-017, and US7 add Update submodules. Contract §12 defines `reviewSubmodules` and `updateSubmodules`, so the operation count becomes 21. F27 to F31 and T220 to T238 add fixtures and tests. |
| The update runs submodule programs that the superproject trust listing cannot see (S3, S6). | A per-run native confirmation lists them. The stored fingerprint omits the registration keys, so no approval loop starts. |
| A plain submodule pathspec matched another submodule (S8). | Each update process passes `:(literal)<path>`. T223 uses a `sub[1]` fixture. |
| `wsl.exe` relays no output without a console, and a hidden console gives the Linux command a terminal (S10). | Contract §11 names `CREATE_NO_WINDOW`. WSL `network` mode runs Git through `setsid --wait`, so SSH prompts fail. Replaced on 2026-10-01: every wrapper mode uses `setsid --wait` ("UX, start mode, and WSL terminal remediation" below). |

These corrections have not received runtime verification.

### Speed measurement and test driver remediation, 2026-10-01

A cross-artifact analysis found these gaps in the speed measurement and the packaged test driver. The user decided two items on 2026-09-30 (spec Clarifications).

| Finding and cause | Correction and required proof |
| --- | --- |
| Only update processes had a console rule. A commit hook that runs `ssh` could wait on a hidden console until its deadline. | Contract §6 "Console and input": `DETACHED_PROCESS` for every Git process, `GIT_TERMINAL_PROMPT=0` in every policy, and closed stdin. T024, T026, and T027 test it, and T162 repeats the hook case. WSL outside `network` mode stays an open limit. Closed later on 2026-10-01: every wrapper mode uses `setsid --wait`. |
| C1 and C2 ended Arbareto in Changes and Git Extensions on its grid (constitution VIII). The first History paint had no mark and no budget. | The History-ready frame, the `arbareto:history-painted` mark, and three First History paint budgets. C1 and C2 end both applications at history rows with graph and counts. Arbareto opens in its last mode (FR-034). Superseded on 2026-10-01: every open shows History (FR-034; next table). |
| One frame source (WebView2 DXGI Present) could not time Git Extensions, and Δ had no meaning for it. | DXGI Desktop Duplication for both applications (T242), Δ as one refresh interval, visible-content end frames, warm-up runs, and bootstrap intervals (T243). |
| Fixture L had no comparison target, and SC-007 named no fixture. | C13 to C16 on L with ratio at most 1.0 (user decision). SC-007, C4, and T168 name M. |
| The review dialog had no default button, and C7 had no key sequence. | Commit staged changes is the default (user decision). C7 sends Ctrl+Enter, then Enter, and reports one time. T239 tests the dialog. |
| T153 had no UI driver, and the lingering count was shown nowhere. | T240 and T241 add a UI Automation driver with an `inject.ts` fallback. T138 shows the count in the status text. |
| SC-005 stalls had no metric or workload list. | plan.md "Responsiveness metrics" defines input response, renderer long tasks, 250 ms probes, and nine workloads. These were the values at that time. Since the third verification remediation, probes run every 100 ms over ten workloads. |
| Frequent actions, the open path, and the external-change start lacked conditions or tools. | C8 to C12, one folder-picker path for C2, and the T244 change helper. Shutdown gains the lingering-child class. |
| WSL speed had only a hand-off line. | WSL budgets and C17 to C20 (T245). They stay `unverified` until distro Git 2.55.0 or later exists. |

These corrections have not received runtime verification.

### UX, start mode, and WSL terminal remediation, 2026-10-01

The user decided four items on 2026-10-01 and one on 2026-09-30 (spec Clarifications). A UX review found the other gaps. The rows below replace the earlier "last mode" row and the WSL open-limit note of the previous table.

| Finding and cause | Correction and required proof |
| --- | --- |
| A repository opened in the last chosen mode, Changes by default. Git Extensions opens on its history grid. | User decision: every open shows History. FR-034, SC-006, the History-ready frame, the Changes-ready frame, and the `arbareto:changes-ready` mark. The First History paint cold and warm rows merged into SC-006 with unchanged budgets. A Changes switch row joined the History switch row. T132, T160, T166, T181. |
| Cold comparisons used 10 runs per application on every fixture. | User decision: 10 on M, 5 on L and W-M, with blocks of 3, 3, 2, and 2. The cold series needs 52 reboots, and SC-006 reuses those runs. A straddling interval is `inconclusive`, never a pass, and SC-015 then records `fail`. |
| The added read conditions had ratio 1.0. | User decision: C8, C11, and C12 need at most 0.5; C9 and C10 keep 1.0. |
| A WSL hook outside `network` mode could wait on the hidden terminal until its deadline. | User decision: `setsid --wait` in every wrapper mode. Plain children now linger and count, as on Windows. A distro without `setsid` gets reason `no-setsid`, and the submodule reason `wsl-setsid` is gone. R13 records the needed re-probe; T209 runs it. |
| Drafts lived only in renderer memory, so reload, restart, and Interrupt and close lost them (FR-020). | User decision of 2026-09-30: stored drafts in IndexedDB, keyed by the new `worktreeKey`. T121, T139, T249, T250, T153, T163. |
| The selected row differed from Canvas only by fill (1.13:1 light, 1.59:1 dark). | A 2 DIP selection marker at 5.18:1 or more (T124, T133, T144, T158). |
| HEAD and branch labels differed from the subject only by Accent color. | Outline badges with a forced-colors mapping, in UI-14 and in the row's accessible name (T144). |
| Keys in the message field were unclassified. | The plan.md Message row lists the working and the ignored keys; T186 tests each. |
| Page zoom was locked, and nothing followed the Windows Text size setting (WCAG 1.4.4). | R7 "Windows text size": text-only scaling from `UISettings.TextScaleFactor`, SC-009, T246 to T248, T157, T160, and UI-17. |
| Only About had sizing rules. | plan.md "Dialog sizes" for Review commit, Trust, and Update submodules; UI-18. |
| Shallow and outside-page ends had no shape, and their strings drifted. The overflow drawing was undefined. | A dashed continuation with "Outside loaded page", and a two-bar stub with "Shallow history boundary". Node-only cells and the scope-line limit text (T118, T135, T144). |
| No artifact defined the SC-012 mode-switch fixture. | F32, T251, and the T160 step. |
| FR-015 did not say whether it covered one instance or all. | All instances. A named mutex per common-directory identity gives `BUSY` (contract §6). T052, T059, T106, and the T163 overlap cases. A later decision narrowed the scope to one logon session (third remediation table below). |
| A failed Stage file showed only a command. The toolbar had no narrow layout. | `outputTail` for a failed `stage` (contract §9) and the plan.md "Hunk toolbar layout" wrap rule. |
| WSL states had no capture, and the state count was stale. | UI-19 and the plan.md "State coverage" map of 29 states. |

Register rows grow from 64 to 68: F32 and UI-17 to UI-19. These corrections have not received runtime verification.

### Third verification remediation, 2026-10-01

Three read-only verification passes found these gaps. Probes R14 S11 and S12 and the R5 read-command probe of 2026-10-01 back the safety rows.

| Finding and cause | Correction and required proof |
| --- | --- |
| The submodule program list covered only initialized submodules. Kept Git directories of deinitialized submodules ran their programs without `confirmRun` (S11). | Contract §12 walks `modules` recursively and lists every kept Git directory. FR-050, SC-017, F29 variants, T222, and T223. |
| §6 closed every stdin pipe, but the WSL anchor needs stdin until `ended`. | A named §6 exception. T205 and T209 test that the anchor lives across a whole mutation. |
| A fetching row showed the parent URL, but Git fetches from the submodule remotes (S12). | The row lists every remote URL and marks the default remote. FR-048, an F27 variant, and T222. |
| The lingering remedy offered Revoke trust without a trust ID. | Revoke trust appears only with a current trust ID (contract §3, §9; plan.md). |
| The quoting rule named only three values. | It covers every interpolated remedy value. T223 adds quote characters in a submodule path and branch. |
| `Local\` names cover one logon session, but FR-015 covers every instance. | Closed, 2026-10-01, by a design decision: keep `Local\`. FR-015 now covers every instance in the same Windows logon session. `index.lock` still guards each index across sessions. Windows client editions run one interactive session per user, so this covers the normal case. Contract §6, plan.md, and the qualification checklist state the scope. |
| Speed conditions had a 30-second run limit, an ambiguous diff input, a free animation setting, and no restore procedure. | Per-condition run limits, the "Diff selection" input, Animation effects Off, and "Restore start state" with the T244 `--restore-state` mode. |
| WSL freshness had no margin, and 250 ms probes missed some stalls. | WSL full read at most 0.4 seconds, 100 ms probes, ten workloads, and named probe targets. |
| The C11 target can fall below one refresh interval after the uncertainty shift. | T180 takes one Git Extensions sample first and stops for a product decision when needed. |
| Three `[P]` pairs edited one file or depended on each other. | T035, T235, and T246 lose `[P]` and name their dependencies. |

The register keeps 68 rows. The two switch budgets stay plan budgets, and the SC-005 row cites them. These corrections have not received runtime verification.

### Safety and test remediation, fourth analysis, 2026-10-01

The fourth `/speckit-analyze` pass found these safety and test gaps. The R5 dubious-ownership probe, R13 P6, and R14 S13 to S18 back the rows. No probe is qualification evidence.

| Finding and cause | Correction and required proof |
| --- | --- |
| S1: a `reuse` row ran `checkout -q -f` and overwrote a changed tracked file. The `clone-interrupted` remedy could create that row (R14 S13). | Reason `folder-not-empty` for a folder with any entry. The `clone-interrupted` remedy moves the folder out. FR-049 now has eight cases (nine after H1 S02). Contract §12, data-model §9, F28 variants, T222 to T224, and quickstart §9. |
| S2: the program list left out `clone` rows. A global relative `core.hooksPath` ran cloned hooks without a confirmation. `checkout` and `fetch-checkout` rows ran target-tree hooks (R14 S14). | Each relative value from any scope gives an `unchecked` entry for every row whose worktree the update writes. FR-050, contract §7 and §12, the F29 relative-hooks variant, T222, and T223. |
| S3: a remote-tracking ref passed the `unsaved-commits` check, and a pruning fetch removed it (R14 S15). | Replaced by a user decision on 2026-10-01: the update fetches first and checks every ref again before each checkout. See "User decisions on fetch order and stall notice" below. |
| S4: the `DUBIOUS_OWNERSHIP` state offered Git's command for a POSIX shell. PowerShell parsed `$(calc)` in it (R5). | The service builds the command with the §4 rule. Contract §6, data-model §2, the spec edge case, F15, and T068. |
| S5: the inactivity limit counted only output, but fetch and checkout print nothing (R14 S16). | A changed Job I/O sum, or the anchor I/O sum in WSL, also counts. FR-052, contract §5, §6, §11, and §12, the F30 silent-fetch variant, T205, T224, T225, T228, and T232. |
| T1: WSL identities used the Linux device number, which can follow the disk attach order (R13 P6). | Identity is the distro GUID, the `findmnt` UUID, and the inode, with reason `no-fs-uuid`. FR-043, contract §3 and §11, data-model §1 and §2, F22, T205, T206, and T252. |
| T2: contract §6 claimed that no process can wait on a hidden console. A native console read under a hook waited (R14 S17). | Contract §6, plan.md, and R14 state the deadline bound. A user decision on 2026-10-01 added the stall notice. F11 console variants, T027, T162, and T224. |
| T3: `confirmRun` had no time limit, and step 4 started without a re-check. | The review reads run again after `approved`. Contract §12, data-model §6, and T223. |
| C1: no fixture covered the `path` refusal. | The F28 path variant, T222, and quickstart §9 step 5. |
| C3: seam-only WSL cases sat behind the Git 2.55.0 gate. | They run first in T207 and T209, and the harness rule exempts them. |
| C4: the FR-051 prompt rule had no runnable test on the update path (R14 S18). | A T224 loopback 401 case with `http` and `https` variants, and an SSH passphrase variant. |

The register keeps 68 rows. These corrections have not received runtime verification.

### User decisions on fetch order and stall notice, 2026-10-01

The user made two decisions on 2026-10-01 (spec Clarifications). R14 S19 to S24 back the design. No probe is qualification evidence.

| Decision and cause | Change and required proof |
| --- | --- |
| Fetch first, then check. The fourth-analysis rule ignored `refs/remotes` for fetching rows and refused the normal state of most submodules (R14 S15). | Every ref counts at the review. Each fetching row runs Git's own fetch and fallback fetch (S19). Then a check of HEAD and every ref and a checkout with `--no-fetch` follow (S20). A failed check ends the row `refused`, and the others continue. The app visits nested levels itself. FR-047, FR-049, FR-050, FR-052, contract §5, §7, §9, §11, and §12, and data-model §7 and §9. Also F27 to F31, T220 to T238, T253, and T254. |
| The fetch step needs Git's transport policy. Without `GIT_PROTOCOL_FROM_USER=0`, it allowed a `file` remote that Git's own update refused (S21). | The `network` policy and the WSL wrapper set it. T223, T227, and T232. |
| A `reuse` row fetched from the wrong folder. A relative hooks path then named the superproject's hooks (S22). | The connect step runs first through Git, then the fetch runs in the connected folder. T223 and T230. |
| A nested level can need programs that the confirmation did not cover. | Such a level refuses with `programs`. The F29 nested-programs variant, T222, and T223. |
| Show the stall. A shell-run passphrase prompt waited unseen until the 300-second limit (R14 S17). | After 15 seconds without output and without I/O, the status shows a notice with Cancel and a terminal command (S24). It applies to commit and to submodule steps. FR-019, FR-051, SC-004, SC-017, contract §5 and §6, F11, F30, and F31. Also T027, T162, T224, T225, T228, T234, T236, and T255 to T257. |

The register keeps 68 rows. These changes have not received runtime verification.

### UX decisions and fifth analysis remediation, 2026-10-01

The user decided two items on 2026-10-01 (spec Clarifications). The fifth `/speckit-analyze` pass found the other gaps. Probe R14 S25 and the R6 diff-context probe back two rows. No probe is qualification evidence.

| Finding and cause | Correction and required proof |
| --- | --- |
| No key staged a file from the lists, so the review loop needed the toolbar. | User decision: Space stages or unstages the focused entry, and focus moves to the next entry. FR-038, the plan.md Stage key row, T133, T201, T202, T258, and quickstart §4 step 17. T203 runs the keystroke check. |
| The Update submodules outcome had no defined place, and its rows could not fit the status bar. | User decision: a bounded status area above the status bar, never a dialog. FR-052, plan.md "Status area" and "Height budget", T122, T126, T138, T234, T236, T260, UI-08, and UI-16. |
| U1/J2: the submodule notice and the blocking state showed only above the Changes lists. Every open shows History, so US7 scenario 1 could not pass. | A notice band below the mode bar in both modes, with its own F6 stop. The scope line counts conflicts apart. FR-016, FR-053, US7 scenario 1, T137, T144, T235, T259, UI-10, UI-16, and quickstart §9 step 1. |
| U2: the header had no wrap or truncation rule, and the cited ellipsis rule did not exist. | plan.md "Header layout" and "Long text", budget rows for 720×480 at 100% and 225% text, T128, T157, and UI-17. |
| U4: no installed-build task checked keyboard-only submodule, WSL start, and stall-notice paths. | T162, T219, and T237 run them. They use quickstart §5 step 6, §8 step 6, and §9 steps 2, 3, and 7 to 9. |
| U5: dialogs and the update had no first-focus or return-focus rules. | The heading takes first focus in the review and Trust dialogs. Focus goes to Cancel, the opener, or the area heading. T136 adds its test, and T234 adds the cases. |
| J1: the C8 diff needed about 51 rows, but Arbareto shows about 25 at 1280×800 compact. | A two-hunk C8 file with 18 rows, the row arithmetic, Compact density, and pinned context and highlighting. T180 measures the Git Extensions rows, and C8 stays `unverified` when they fall short. T164, T165, and T181. |
| J3: no rule combined C1 to C20, and T181 recorded SC-015 before T245. | plan.md "SC-015 roll-up". T181 records its conditions, and T245 writes the result. |
| C2: the keyboard fallback covered only T153. | T241 extends it to T167, T181, and T245. Under it, C7 stays `unverified`. |
| U11: progress strings had three forms. | "Starting WSL distro <name>…", "Loading…", and "Refreshing…" everywhere, as the "…" rule requires. |
| The first fetch of a row recursed into nested submodules before their level check (S25). | `--no-recurse-submodules` on both fetch steps and the fetch remedy. Contract §12, plan.md, T223, and T227. |

The register keeps 68 rows. These corrections have not received runtime verification.

### Verification remediation, 2026-10-01

Two read-only verification passes found these gaps. R13 P7 and the Git Extensions source back two rows. Answers that start with "Reviewer default" record analysis decisions (spec Clarifications). No probe is qualification evidence.

| Finding and cause | Correction and required proof |
| --- | --- |
| V1-01: a tolerated failed first fetch counted as a failed process. A run that matched Git's own success ended `failed-with-effects`. | That fetch counts as exit 0 when its row reaches the target. Contract §12 and T223. |
| V1-02: the connect step writes the Git link and removes the kept index, but reconciliation reads HEAD only. | The `connected` flag counts as an effect, like `fetched`. FR-052, contract §12, data-model §7 and §9, plan.md, T223, and T234. |
| V1-03: the re-check after an approved `confirmRun` had no outcome and no marker rule. | It ends `failed` with `STALE_REVIEW` or `TRUST_CHANGED`, without a process, and resolves the marker. Contract §9 and §12, data-model §7, and T223. |
| V1-04 to V1-06: the check before a `reuse` step read HEAD and refs, not the folder. In an empty folder, a check read could resolve to the superproject. | A folder check before the first step of every `reuse` row. The check reads use `--git-dir` and `--work-tree`. FR-049, contract §12, and T223. |
| V1-07: the relative-hooks variant had no `reuse` row. | F29, T222, T223, and quickstart §9 step 7. |
| V1-08 and V1-09: plan.md left out `no-fs-uuid` and `folder-not-empty` in two summaries. | The Repository refused row and the submodule summary. |
| V1-10: FR-047 forbade the forced checkout that Git's own update runs. | FR-047 forbids a force option. The empty-folder rule protects that checkout. |
| V1-11: the `findmnt` UUID came from udev data, which can be missing right after a start (P7). | The `statfs` ID of an ext4 file system. FR-043, contract §9 and §11, data-model §1 and §2, T205 to T207, T211, T252, and the harness rule. |
| V1-12: contract §6 did not bound a native child that waits after its hook exits. | That child lingers until Revoke trust or close. |
| R1 to R3, V2-02, V2-03, V2-12: Space and the file buttons left focus, bytes, pending reads, and refusals open. | Reviewer defaults. FR-038, FR-052, plan.md, C10, T133, T180, T201 to T203, T234, T258, and T260. |
| V2-01 and V2-14: at 225% text, the comfortable status area minimum is 179 DIPs, above the 168 DIP cap. | The minimum wins, and the work area scrolls. plan.md "Status area", T122, and UI-17. |
| V2-04, V2-10, V2-11, and V2-15: some captures and keyboard checks were missing. | UI-05, T203, quickstart §5 step 6, T237, and T160. |
| V2-05 and V2-08: the stall notice could remove a focused control, and two F6 rules differed. | A focused notice stays until focus leaves it. One F6 rule. plan.md and T260. |
| V2-13: count texts had no singular form. | plan.md "Long text", contract §9 and §12, T259, and T260. |
| V2-06, V2-07, and V2-17: stale task ranges and the order of the clarifications. | plan.md, this file, and spec Clarifications. |

The register keeps 68 rows. These corrections have not received runtime verification.

### Safety remediation H1, 2026-10-01

A further `/speckit-analyze` pass found these safety gaps. R14 S26 to S33 back the rows. Answers that start with "Reviewer default" record analysis decisions (spec Clarifications). No probe is qualification evidence.

| Finding and cause | Correction and required proof |
| --- | --- |
| S01: the clone step re-checked nothing. Another tool initialized the path after the review, and the step ran an unlisted hook. A local commit lost its last ref (S26). | Reviewer default: a clone check before each clone step. A changed row ends `refused` with `unsaved-commits` or the run reason `changed-after-review`. FR-049, contract §10 and §12, data-model §7 and §9, T223, and T230. |
| S02: the fallback fetch passed the remote name with no `--`. A remote named `--upload-pack=<program>` ran that program (S31). | `--` before every remote name. Reviewer default: the review refuses a `-`-led remote name with `remote-name`, so FR-049 has nine cases. Contract §9, §10, and §12, data-model §9, F28, T221 to T223, and T227. |
| S03: the §4 rule named only some values. Windows PowerShell 5.1 merged a `"`-led value with the next argument into one Git option (S28). | Reviewer default: no command for a value with a double quote, a control character, or invalid UTF-8. The rule names every value kind. One shared builder (T261, T262). Contract §4, §6, and §10, T093, T098, and T223. |
| S04: the `update-mode`, `gitdir-config`, and `limit` remedies run Git's own recursive update without the app's checks. | Their text states the skipped checks, the forced checkout, and a configured update command. The review lists them last, and `gitdir-config` names its path when it can. FR-049, contract §12, T221, and T222. |
| S05: no rule covered a failed check, level, `remote get-url`, or `rev-list` read, or a folder read error. | Exit statuses decide. A failed read ends its row `failed` and never counts as absent. `rev-list` follows Git's `is_tip_reachable`. Contract §12, data-model §7 and §9, and T223. |
| S06: Git's own update registers an active, uninitialized `update = none` submodule, and the app did not. | Reviewer default: a register step with `submodule init` for that path (S33). FR-047, contract §12, data-model §9, F27, T223, T227, and T230. |
| S07: `--init` could write a registration, and then Git refused the checkout. The outcome said that no row changed. | A fourth row flag, `registered`, from a comparison of the `submodule.*` keys with the preflight. It counts as an effect. Contract §12, data-model §7 and §9, plan.md, F28, T221, T223, and T234. |
| S08/T1: the pasted fetch remedy allowed the `file` transport that the app's fetch blocks (S21). | Reviewer default: the remedy sets `GIT_PROTOCOL_FROM_USER=0` for that one command (S30). WSL uses `/usr/bin/env`. FR-051, contract §11 and §12, T221, and T223. |
| S09: programs were re-checked before each nested level only. | A row program re-check before the first step of every row, with reason `programs`. Contract §12, F29, and T223. |
| S10, T8, T9, T10: wording gaps. | "After the step 3 decision", the recorded differences, one text per hook-command context, and the plan.md step names. |
| S11: the save-branch remedy lacked `--no-lazy-fetch`. | It is the first Git argument. Contract §12 and T221. |
| T2: the anchor pipe exchange changed the Job `IO_COUNTERS` each second (S29). | A WSL Job uses only output and the anchor I/O sum. Contract §6 and §12, plan.md, T225, and T228. |
| T3: no channel carried the stall command while a step ran. | The field `stallRemedy`, read through `getOperation`. Contract §6, data-model §7, plan.md, T223, T224, T234, and T255 to T257. |
| T4: Git resolves a relative `.gitmodules` URL from the raw parent remote URL, with a current-folder fallback (S32). | Contract §12, T253, and T254. |
| T5: a clone step of a headless `reuse` row let Git's fetch run a nested kept hook (S27). | `-c fetch.recurseSubmodules=no` on every clone step. A connect step failed there (S27). Contract §12, F27, T223, and T227. |
| T6: contract §12 and data-model §7 disagreed for a run with only refused rows. | Both now give `completed-with-effects`. |
| C1: no reason covered a distro without the program that identifies folders. | `WSL_UNAVAILABLE` reason `no-coreutils`. Contract §9 and §11, data-model §1, F23, T207, T212, T225, and T228. |
| C4: the 5-second bound after the inactivity limit was never timed. | T224 asserts it, and T237 measures it with quickstart §9 step 9. |

The register keeps 68 rows. These corrections have not received runtime verification.

### UX and speed remediation H2, 2026-10-01

The fifth `/speckit-analyze` pass found these UX and speed gaps. R13 P8 and three DeepWiki answers on the Git Extensions source back four rows. Answers that start with "Reviewer default" record analysis decisions (spec Clarifications). No probe is qualification evidence.

| Finding and cause | Correction and required proof |
| --- | --- |
| J1: WSL fixtures lived in `/tmp`, which each distro start empties (P8). | The `<home>/arbareto-fixtures-<random>` folder, and an inode check with `fixture-lost` after each restart. F22 and W-M in plan.md, the harness rule, T206, T219, T232, T238, T245, T252, and quickstart §8 and §9. |
| J2: the Git Extensions commit dialog selects the first file and loads its diff, and Arbareto selects none. | Reviewer default: the C12 region holds only the list panes of each application. "Product differences" names the diff load. T180 confirms the selection, and T242 takes the region. |
| J3: warm-up runs were discarded, so absolute bounds could skip slow cold runs. | Reviewer default: warm-up runs count toward every absolute budget and never enter a median or ratio. See plan.md "Warm-up rule", T166, T168, T181, T245, and quickstart §10. |
| J4: a run without a region change could add runs without limit, or make the condition `unverified`. | Reviewer default: one-off and repeatable kinds, at most 3 added runs per block, then `unverified`. See plan.md "Invalid capture", T242, and quickstart §10. |
| J5, J10: C6, C9, and C10 named a button but no key or focus. C3 lacked the Git Extensions counts. | The plan.md "Mutation inputs" table sets the keys. Arbareto uses Enter on the focused hunk button, and Space on the focused entry for C10. Git Extensions uses S, U, and Enter. T180 confirms each key. The C3 end content names the counts. |
| J9: relative date text could change during a series. | Fixed fixture timestamps from 2020-01-01, the 365-day rule of `GetRelativeDateString`, and a 7-day margin. T164 and T180. |
| U1: band rows, results, and stall notices switched the layout profile, so a notice could sit off-screen. | User decision, 2026-10-01 (first a reviewer default): the client size, text size, and density alone choose the profile. The wide and narrow floors reserve two band rows and the area minimum. A 960×640 window, and a 1280×800 window at 225% text, are now constrained in both densities. See plan.md "Height budget", T122, T126, T128, and UI-16. |
| U2, U3: percentages repeated the announcement, the band had no name, and focus could land on an empty stop. | Live text rules, a second live element for refusals, the "Notices" heading, the empty-stop skip, and the focus fallback. See plan.md, T137, T138, T186, T259, and T260. |
| U4/J6, U5: no rule covered Space on a loading entry or during a file action. The hunk keys at the ends had none either. | Reviewer defaults: wait for the pending comparison, a visible busy reason, and disabled ends with reasons. See T145, T258, and T264. |
| U6: the help line wrapped to two lines at 100% text and to five at 225%. Subgroup headings had no height. | One line with an end ellipsis. The full text is the description and shows in the No selection hint. Density rows of 26/28 and 18/20 DIPs. See plan.md, T122, T133, T137, and checklists/ux.md CHK001 and CHK009. |
| J8, U7, U12: commit focus, hook failure place, modal shortcuts, and motion had no rule. | Reviewer defaults: focus to Cancel, then the "Commit details" area. Shortcuts stop during a modal state. No motion under reduced motion. T124, T138, T147, T157, T186, T239, and T260. |
| C2, C3, C5, C7 to C11: test and task gaps. | T263 tests a runtime theme and density change. T241 covers T242, and T119 adds a focus-return case. T167 owns workload 9, and quickstart §8 adds three refusals. T235 depends on T236, and T202 on T145. T041 dispatches 19 service operations. |
| U11: checklists/ux.md had no items for the workbench additions. | Unchecked CHK050 to CHK054 and a corrected note. |

The register keeps 68 rows. These corrections have not received runtime verification.

### Verification remediation, 2026-10-01

Two verification passes over H1 and H2 found these gaps. R14 S34 backs the V1-01 row. Answers that start with "Reviewer default" record analysis decisions (spec Clarifications). No probe is qualification evidence.

| Finding and cause | Correction and required proof |
| --- | --- |
| V1-01: Windows PowerShell 5.1 quotes an argument with white space. A trailing `\` then escaped the closing quote, or two became one (S34). | Reviewer default: no command for a value that ends in `\`, except a drive root. No built Windows path ends in a separator, except a drive root. The §11 escaping sentence is corrected. Contract §4 and §11, T261, and T262. T261 runs each command in both shells through `rev-parse --sq-quote`. |
| V1-02: programs were re-checked only before the first step of a row. A fetch can run 4 hours before the checkout, the register step, and a nested active-set read. | A program re-check before each process that can start a program. FR-050, contract §10 and §12, data-model §7, and T223. |
| V1-03: nested rows had no `registered` baseline. | The level read is the baseline when no preflight value exists. An absent key counts as a difference. Contract §12, data-model §9, and T223. |
| V1-04, V1-05: no F29 copy set the gitdir key in a submodule folder, and two task assertions were incomplete. | F29, T222, and T223. |
| V1-06: the clone-check remedy ran `git branch` in an unreviewed Git folder, so its hook could run in the terminal. | Reviewer default: no command for that case. FR-049, contract §12, data-model §9, T221, and T223. |
| V1-07: `env` reads an argument with `=` as an assignment. | No WSL fetch remedy for a Git path with `=`. Contract §11 and §12, and T221. |
| D1: the user approved the stable layout profile. | Spec Clarifications U1 is now a user answer. |
| D2: an Arbareto run without a region change could hide a defect as `unverified`. | Reviewer default: that block gives `missed`, and its absolute row fails. Git Extensions stays `unverified`. plan.md "Invalid capture", T181, T242, T243, and quickstart §10. |
| V2-01, V2-10, V2-11: warm-up counts, the inode check, and invalid warm-up runs had gaps. | Two Arbareto warm-up runs per fixture, an inode check before each C17 run, and "Invalid captures and absolute rows". |
| V2-02, V2-07: commit focus at the outcome named only some states. | Every terminal state. Focus on Cancel moves to the message field in Changes and to the area heading in History. See plan.md Confirm row, UI-06, T147, T162, and T260. |
| V2-05: the WSL badge grew with the distro name. | Reviewer default: a fixed 160 DIP width times the text factor, with an end ellipsis. See plan.md "Header layout", T216, and UI-19. |
| V2-03, V2-04, V2-06, V2-08, V2-12, V2-14 to V2-16, D3: steps, keys, captures, names, and figures. | quickstart §4 steps 17 and 18, T167, T180, T203, T241, T242, T264, UI-16, plan.md "Roles", and spec Clarifications. |

The register keeps 68 rows. These corrections have not received runtime verification.

### Redesign decisions, 2026-10-10

The user approved a redesign after a mockup review (spec Clarifications, 2026-10-10). The older rows above keep their history.

| Finding and cause | Correction and required proof |
| --- | --- |
| The Changes and History modes split one Git Extensions view into two, and the review dialog added a step before each commit. | User decision: one view with the Working directory and Index rows, a dock for the commit panel or the commit details, and Commit with Ctrl+Enter without a dialog. Spec FR-017, FR-034, FR-036, SC-012, SC-015; plan.md "Chosen layout: one view"; T341 to T355. |
| No control reopened an earlier repository, and the header held no repository identity control. | User decision: a recent-repositories switcher as the first toolbar control and on the start page, with 20 entries in native settings. The native Windows title bar stays; a custom title bar follows feature 002 (`docs/project-brief.md` "Later features"). Spec FR-055, SC-018; contract §3 "Recent repositories"; T343, T344, T350, T351. |
| The history rows showed only HEAD and the current branch. | User decision: a read-only references sidebar and reference chips. One `for-each-ref` call with a NUL-separated format reads them after each full status read (contract §3 "References result"). A probe on Git 2.56.0.windows.1 on 2026-10-10 confirmed the format: eight fields, LF records, `%(HEAD)` `*` only on the current branch, and full peel of a tag of a tag. T356 repeats it on the admitted Git. Spec FR-057, SC-019; T356 to T359. |
| The change plan proposed a 60% dock default. At 1280×800 compact it leaves 9 diff rows, below the 18 rows of C8. | Reviewer default: one remembered height for each panel. The commit panel keeps three history rows; the commit details take 40% (plan.md "Dock region", "C8 rows"). |

The register grows to 73 rows: SC-018, SC-019, F33, UI-20, and UI-21. These corrections have not received runtime verification.

**T356 probes, 2026-10-11.** The probes used Git 2.56.0.windows.1 on the F33 copies of `tests/git/refs.test.ts`. They are not qualification evidence.

- A tag of a tag peels to the commit: `%(*objectname)` gives the commit ID, not the inner tag ID.
- Git leaves out a loose ref with a broken name, `refs/heads/bad..name`. It prints only a stderr warning and exits 0.
- On Windows, MSYS maps the byte `\001` in a file name to U+F001.

## R12. History graph component and data decision

**Decision**: No inspected package fits the contract. Build the workbench's own History rows with Base UI controls and theme tokens. Implement Arbareto's own lane function, modeled on VS Code's per-row swimlane model.

**Rationale**: The inspected components require adaptations for controlled selection, compact geometry, or accurate incomplete ancestry. A general graph editor adds interactions this workbench does not need.

Lane state is a pure page-wide function. Row N's input lanes are row N−1's output lanes. Each row renders its own SVG cell at the row height, so alignment is structural. Keep the lane rules in `plan.md`. They cover the first-parent lane and free-slot reuse. Unrelated pending ancestry never moves. Each outside-page parent gets one continuation.

Later paging or virtualization continues from the last row's output lanes without a graph redesign. This reconciles the brief's virtualized-graph direction (`docs/project-brief.md` lines 27 and 44) with this slice's 100-row page.

**Alternatives considered**:

| Candidate | Pin and licence | Source findings and decision |
| --- | --- | --- |
| `@tomplum/react-git-log@3.5.1` | `e02bfbb6f92f54e25fc9c2897895c6be892b0ef1`; Apache-2.0; released 2026-02-07. | Closest candidate; React/DOM peers `>=19.0.0`. Internal selection, 40px base geometry, and partial-merge continuation assumptions require adaptation. Not selected. |
| `@gitgraph/react@1.6.0` | `9239bab87f6f00dc4c5da1d1f5b3efec47827748`; MIT; released 2021-03-06. | Archived; depends on core `1.5.0`. Branch reconstruction and second-parent-only merge paths do not fit this bounded DAG contract. |
| `@dolthub/gitgraph-react@1.6.4` | `d3c0c029be5d3d6afbb5528d07b57bc289fe7832`; MIT source; released 2023-05-03. | Real-history fork, but last observed repository activity was May 2023. Its merge-path limitation remains; published packages omit licence files. |
| mermaid gitGraph `12.0.0` | Tag commit `98a0945418c76238f15df2afaddbba4272656c3b`; MIT; released 2026-09-10. | Reject. Input is a scripted command language, not a parent list. Each commit belongs to one named branch. `merge` makes exactly two parents; the first is always the current branch. No octopus merge exists; issue #4791 and PR #7950 are open. Several roots and merges from unknown branches have no support. It renders one SVG without row-height control, so rows cannot align with a list. Defaults limit `maxEdges` to 500 and `maxTextSize` to 50,000. Commit click support is unreleased; PR #7292 is open. |
| `commit-graph@2.4.0` | npm `gitHead` `24a8533e7373b16056a1d03833c546ed3235cf87`; published 2026-03-29; licence conflict. | Reject. `package.json` says MIT, but the `LICENSE` file at that commit is Apache-2.0. The repository has no tags. It draws one absolutely positioned SVG for all rows. It sorts commits by committer date before a depth-first pass. Selection is internal state with only an `onCommitClick` callback. It has no keyboard handlers and no virtualization. It adds react-icons, react-infinite-scroller, react-tooltip, and reactjs-popup. |
| VS Code Source Control Graph, `scmHistory.ts` | Commit `25c94ab342a6b167d4b97ade0829955d4f7e094e`; MIT, Microsoft. | Reference model, not a package. Its lane loop has about 50 lines. Each row's input lanes are the previous row's output lanes. It renders one SVG per 22 px row. It handles any parent count and keeps outside-page parents as open lanes. It appends new lanes instead of reusing free slots. It shifts later lanes left when a lane ends. Source reading shows that a root commit drops other open lanes from its output; this was not executed. Load more recomputes from the first row. |
| SourceGit `src/Models/CommitGraph.cs` | Commit `e308279e9669c71be5187a9ae68cc5c8370b82fb`; repository MIT; the file has no header. | C# reference. It makes one pass in list order with open paths and color recycling. It draws a bezier link for each extra parent. It ends open paths at the bottom edge. |
| Git Extensions RevisionGraph | Commit `e265607b631a7fd32b60c317ba096209fabf0135`; GPL-3.0 per `LICENSE.md`. | Behavior reference only. Do not copy or port its code. The graph directory has about 2,700 lines of C#, including rendering. It caps layout at 40 lanes and straightens lanes with look-ahead. It caches rendered rows. A lane color differs from its left and right neighbors and from its originating lane. |
| vscode-git-graph (mhutchie) | `LICENSE` at commit `7594c9152a1f62aa9bf95f9d3cfc4cf606886a3d`; modified MIT. | Reject. Its licence states: "Permission is NOT GRANTED to publish, distribute, sublicense, and/or sell derivative works". |
| `@gitkraken/gitkraken-components@11.3.0` | npm tarball; proprietary GitKraken Components License. | Reject. The licence permits use only as a GitLens component under a GitKraken agreement. It forbids stand-alone or integrated distribution. |
| d3-dag, `@dagrejs/dagre`, elkjs, cytoscape | Not pinned; general DAG layout. elkjs uses EPL-2.0 or GPL-3.0-or-later. | Reject. They compute their own layers and do not keep one commit per list row. |

Tomplum accepts parent hashes but also requires a per-entry branch string and applies its own temporal/topological ordering. Its paged renderer creates one continuation per merge with missing parents, not one for each missing parent. It also assumes childless non-HEAD commits continue above the page.

Its selection notifies consumers but lacks a controlled selected-OID interface. Node focus/Enter support does not establish full row-keyboard navigation. Geometry begins at 40px; RGB-string helpers require adaptation for semantic CSS tokens.

Tomplum adds usehooks, classnames, dayjs, fastpriorityqueue, and react-tiny-popover. React/DOM also appear as dependencies. Its tooling declares Node >=22. Standard browser renderers are plausible under Bun/Vite/WebView2, but no integration was executed.

The original Gitgraph and Dolt fork reverse imported input and reconstruct branches from refs or first-parent ancestry. Their merge path code uses `parents[1]`, omitting additional or unavailable parents.

These findings do not classify the libraries as unsuitable for every product. They explain why Arbareto builds its own History rows and owns only the bounded lane function.

Sources: [Tomplum package](https://registry.npmjs.org/@tomplum/react-git-log/3.5.1), [entry contract](https://github.com/TomPlum/react-git-log/blob/e02bfbb6f92f54e25fc9c2897895c6be892b0ef1/packages/library/src/types/GitLogEntry.ts#L3-L38), [partial parents](https://github.com/TomPlum/react-git-log/blob/e02bfbb6f92f54e25fc9c2897895c6be892b0ef1/packages/library/src/modules/Graph/strategies/Grid/GraphMatrixBuilder/VirtualEdgeRenderer.ts#L40-L80), [selection](https://github.com/TomPlum/react-git-log/blob/e02bfbb6f92f54e25fc9c2897895c6be892b0ef1/packages/library/src/components/GitLogCore/GitLogCore.tsx#L75-L88), [geometry](https://github.com/TomPlum/react-git-log/blob/e02bfbb6f92f54e25fc9c2897895c6be892b0ef1/packages/library/src/constants/constants.ts#L1-L11), [original merge paths](https://github.com/nicoespeon/gitgraph.js/blob/9239bab87f6f00dc4c5da1d1f5b3efec47827748/packages/gitgraph-core/src/branches-paths.ts#L114-L144), [Dolt merge paths](https://github.com/dolthub/gitgraph.js/blob/d3c0c029be5d3d6afbb5528d07b57bc289fe7832/packages/gitgraph-core/src/branches-paths.ts#L114-L144), [mermaid gitGraph syntax](https://github.com/mermaid-js/mermaid/blob/98a0945418c76238f15df2afaddbba4272656c3b/packages/mermaid/src/docs/syntax/gitgraph.md), [mermaid limits](https://github.com/mermaid-js/mermaid/blob/98a0945418c76238f15df2afaddbba4272656c3b/packages/mermaid/src/schemas/config.schema.yaml#L87-L96), [mermaid #4791](https://github.com/mermaid-js/mermaid/issues/4791), [#7950](https://github.com/mermaid-js/mermaid/pull/7950), [#7292](https://github.com/mermaid-js/mermaid/pull/7292), [commit-graph package](https://registry.npmjs.org/commit-graph/2.4.0), [commit-graph source](https://github.com/liuliu-dev/CommitGraph/tree/24a8533e7373b16056a1d03833c546ed3235cf87), [VS Code lanes](https://github.com/microsoft/vscode/blob/25c94ab342a6b167d4b97ade0829955d4f7e094e/src/vs/workbench/contrib/scm/browser/scmHistory.ts), [SourceGit graph](https://github.com/sourcegit-scm/sourcegit/blob/e308279e9669c71be5187a9ae68cc5c8370b82fb/src/Models/CommitGraph.cs), [Git Extensions graph](https://github.com/gitextensions/gitextensions/tree/e265607b631a7fd32b60c317ba096209fabf0135/src/app/GitUI/UserControls/RevisionGrid/Graph), [vscode-git-graph licence](https://github.com/mhutchie/vscode-git-graph/blob/7594c9152a1f62aa9bf95f9d3cfc4cf606886a3d/LICENSE), [GitKraken components](https://registry.npmjs.org/@gitkraken/gitkraken-components/-/gitkraken-components-11.3.0.tgz).

### History protocol

Use `rev-list --parents --max-count=100 --date-order <captured-OID>` for the visible page. Git's date ordering keeps children before parents. Do not independently sort author dates.

Use effective traversal parents from Git; replacement/graft semantics must not be silently replaced with timestamp-based guesses. Read metadata through bounded `cat-file --batch-command -Z` frames.

Resolve shallow state and its boundary path through Git. Bound that metadata read and revalidate it with the captured checkout. Use raw parent headers only to explain shallow boundaries where traversal deliberately hides parents.

Each outside-page parent remains a distinct identity, not a fabricated root. No further page, branch filter, or automatic fetch is introduced. Show current HEAD and its symbolic branch only; other ref decorations remain outside this slice.

Limit traversal output to 128 KiB, 100 rows, 64 parents per commit, and 1,024 parent references overall. Limit shallow metadata to 4 MiB. Overflow produces explicit limited data, never truncated ancestry presented as complete.

The renderer caps layout at 24 lanes and 4,096 segments. A layout limit preserves the complete row/parent representation and does not block unrelated mutations.

No additional virtualization library is needed for 100 rows. Each History row renders its own SVG ancestry cell from its input and output lanes. The cell uses the shared 26/34 DIP row height.

Sources: [parent output and date ordering](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/rev-list-options.adoc), [no implicit object fetch](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git.adoc).

All graph findings are source inspection. No package installation, application run, screenshot, or rendered accessibility test occurred.

## R13. WSL repositories

**Decision (2026-09-30)**: Open WSL2 repositories under `\\wsl$\` and `\\wsl.localhost\` with Git inside their distro (contract §11). The user decided the scope, the Git 2.55 floor, the start on demand, and the poll schedule (spec Clarifications, 2026-09-30). Each Linux process runs in a systemd user scope, so the app owns the processes that Git and hooks start. On 2026-10-01, the user also chose `setsid --wait` for every Linux process ("Consequences and open items").

**Rationale**: Git for Windows on a WSL path is slower and refuses the repository for dubious ownership. Linux Git reads its own file system. `wsl.exe --exec` passes each argument without a Linux shell. A systemd scope was the only probed boundary that held detached Linux processes (P1).

**Alternatives considered**:

| Alternative | Finding | Decision |
| --- | --- | --- |
| Git for Windows on the UNC path | Status on 5,000 files took 379 ms median, against 165 ms through Linux Git. Without an override, Git refused the repository with "detected dubious ownership". | Reject. An override such as `safe.directory=*` changes Git behavior (FR-003). |
| A login shell, such as `bash -lc` | A shell expands arguments. Git Extensions moved to `--exec` after a login shell expanded `refs/sessions/**` (issue #13156, PR #13271). | Reject. |
| `setsid` sessions, ended through `wsl.exe` | A detaching child calls `setsid()` again, as Git `daemonize()` does. A session kill misses it. | Reject. |
| A PID namespace through `unshare --user --pid --fork` | It worked for the user in P1. Its init ends every namespace process when Git exits (pid_namespaces(7)). A user namespace also changes the rules that hooks run under. | Reject. |
| A stated limit: the app cannot own Linux processes | P1 proves an ownership mechanism, so a limit claim is not needed. | Reject. |
| A watcher inside Linux | Out of scope by user decision. | Polls instead (contract §11 "Change polling"). |

### Other clients

The earlier research dispatch of 2026-09-30 reported these facts. This pass re-read only the Git Extensions source clone.

| Client | WSL behavior |
| --- | --- |
| Git Extensions 4.0 and later | PR #9702 added WSL support. It detects the `\\wsl$\` and `\\wsl.localhost\` prefixes (PathUtil.cs:13-14) and takes the distro from the first segment. It runs `wsl -d {distro} --cd "{UNC path}" --exec {git} …` (GitExecutor.cs:26-35). It polls WSL status every 60 seconds, because FileSystemWatcher misses changes there (GitStatusMonitor.cs:36-39, microsoft/WSL#4581). GPL-3.0: Arbareto borrows behavior only, never code. |
| GitKraken | No support across the two file systems. |
| Fork, Sublime Merge | A `wslgit` shim. |
| SourceTree | No WSL support. |

### Platform facts

- Host: WSL `2.7.12.0`, kernel `6.18.33.2-2`, Windows `10.0.26200.9457`. Distros: `Ubuntu-24.04` (default, running, WSL2, Linux Git `2.43.0`) and `Ubuntu` (stopped, WSL2). Git for Windows `2.55.0.windows.3`.
- Each `wsl.exe` start cost about 150 to 260 ms. Linux Git status on 5,000 files took 165 ms median.
- `fs.watch` in Node and Bun threw `EISDIR` on `\\wsl.localhost\` paths.
- Killing `wsl.exe`, or closing a kill-on-close Job that held it, ended the Linux command while it ran.
- The distro's Git configuration applies. An SSH agent that `.bashrc` starts does not load under `--exec` (Git Extensions #11839).
- WSL keeps a background Linux process alive after its console closes ([background task support](https://devblogs.microsoft.com/commandline/background-task-support-in-wsl/)). The systemd manager runs only on WSL 2, and `[boot] systemd=true` in `/etc/wsl.conf` enables it ([systemd in WSL](https://learn.microsoft.com/windows/wsl/systemd)).

### Probes P1 to P5

The probes ran on 2026-09-30 on the host above. They used only session scratch folders, the distro's `/tmp`, and systemd user scopes named `arbareto-probe-*`. The probes removed all three afterwards, and `pgrep` then found no probe process. They changed no WSL or distro configuration. They started no stopped distro and ran no `--shutdown`, `--terminate`, `--unregister`, or `--install`. These probes are not qualification evidence.

**P1. Process lifetime.**

- After `wsl.exe --exec sh -c "sleep … & …"` returned, a plain background child ended. So did one with its standard streams on `/dev/null`. A child under `nohup`, `setsid`, `setsid -f`, or `trap "" HUP` survived. Each survivor was a child of the invocation's `Relay` process, which PID 1 adopted. The pattern matches a `SIGHUP` to the command's session.
- A kill-on-close Job that held `wsl.exe` did not help after `wsl.exe` exited: detached children survived its close. During a run, a Job close ended the main command, but detached and `nohup` children survived.
- `taskkill /F` of `wsl.exe` delivered `SIGHUP` to the command, and its trap ran.
- A POSIX `sh` defers a trap while a foreground child runs. So a wrapper that waited in the foreground left its children alive after a Job close (S4). A wrapper that starts the program in the background and calls `wait` ran its trap at once (S4b).
- `systemd-run --user --scope --quiet --collect --unit=<u>` passed stdin, stdout, and the exit status (S3: 5; S5b: 6, with 7 bytes of stdin). The arguments `a b`, `$HOME`, and `*` stayed literal. systemd 258 and later expand `$HOME` in a `--scope` command line (R10 "T378 WSL argument expansion"). A detached child stayed in the scope, and `systemctl --user kill --signal=SIGKILL <u>` ended it. systemd then removed the scope. Starts took 213 to 257 ms with and without a scope.
- The read wrapper ended the scope after the program exited, and no detached child survived (S3).
- An anchor in the Job ended a lingering detached child at the Job close (S1). With its stdin closed, the anchor exited 4 seconds after a 4-second child ended (S2).
- Ten cancellation runs closed the Job during a run with a detached, a `nohup`, and a foreground child. Ten lingering runs closed the Job after Git exited. All twenty runs left no Linux process 1 second after the close.
- In `mutation` mode, a plain background child with its streams on `/dev/null` ended when the wrapper exited (S6).
- `unshare --user --map-current-user --pid --fork` ran a shell as PID 1 in a new namespace. The kernel allowed 62,587 user namespaces.
- Outcome: the scope, wrapper, and anchor mechanism of contract §11. The app owns Linux processes that detach or ignore `SIGHUP`. In these probes, other children ended at Git's exit. The 2026-10-01 design change below replaces that behavior.

**P2. Git resolution.**

- The `PATH` of an `--exec` process held 81 entries under `/mnt/`, because `appendWindowsPath` defaults to true ([wsl.conf](https://learn.microsoft.com/windows/wsl/wsl-config#wslconf)).
- `command -v git` gave `/usr/bin/git`, an ELF file (first bytes `\177E`), version `2.43.0`. `command -v git.exe` gave `/mnt/c/Git/mingw64/bin/git.exe`. It ran Git `2.55.0.windows.3` through interop, and its first bytes were `MZ`. The `WSLInterop` binary-format entry existed.
- `systemd-run` and `systemctl` resolved to `/usr/bin`. An empty `systemd-run --user --scope` call exited 0.
- Rule: resolve once per distro with `command -v` and `readlink -f`. Refuse a path under `/mnt/`, a file that starts with `MZ`, and a version with `.windows.`.

**P3. Command line, working directory, and distro names.**

- `--exec` passed each argument literally, also from PowerShell 7: `a b$c é`, `it's`, `-lead`, `*`, `--x=**`, and `;echo pwned`.
- `--cd <Linux path>` worked with spaces, `$`, `é`, a leading `-`, and a `\` in a Linux name. `--cd <UNC path>` worked for both prefixes, an upper-case prefix, and a lower-case distro name, when the path used only `\`. A UNC path that mixed `\` and `/` gave `Wsl/E_INVALIDARG`. `--cd` with a missing directory ran the command in `/` and exited 0.
- `git --no-lazy-fetch rev-parse …` failed on Git `2.43.0` with "unknown option: --no-lazy-fetch".
- `wsl.exe -d ubuntu-24.04` worked for the distro `Ubuntu-24.04`. A missing distro printed `Wsl/Service/WSL_E_DISTRO_NOT_FOUND` and exited nonzero.
- `wsl.exe --list --quiet` printed UTF-16LE. With `WSL_UTF8=1`, it printed UTF-8. `--list --verbose` printed localized headers and state words. `--list --running --quiet` lists only running distros ([basic commands](https://learn.microsoft.com/windows/wsl/basic-commands#list-installed-linux-distributions)).
- The key `HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss` held one GUID subkey for each distro, with `DistributionName` and `Version` 2. Its `DefaultDistribution` named the default GUID.
- `wslpath -u` of the UNC path equaled the string conversion. `wslpath -w` gave the `\\wsl.localhost\` form.
- Outcome: `--cd /`, then `git --no-lazy-fetch -C <Linux path>`. `--no-lazy-fetch` stays the first Git argument, and a missing directory fails in Git.

**P4. Environment.**

- An `--exec` process held `DBUS_SESSION_BUS_ADDRESS`, `DISPLAY`, `HOME`, `HOSTTYPE`, `LANG=C.UTF-8`, `LOGNAME`, `NAME`, `PATH`, and `PULSE_SERVER`. It also held `SHELL`, `TERM`, `USER`, `WAYLAND_DISPLAY`, `WSL2_GUI_APPS_ENABLED`, `WSLENV`, `WSL_DISTRO_NAME`, `WSL_INTEROP`, `WT_PROFILE_ID`, `WT_SESSION`, and `XDG_RUNTIME_DIR`. It held no `GIT_*` variable.
- Windows values of `GIT_TRACE`, `GIT_DIR`, and `GIT_CONFIG_GLOBAL` did not reach Linux. The inherited `WSLENV` was `WT_SESSION:WT_PROFILE_ID:`. With `WSLENV=GIT_TRACE/u`, `GIT_TRACE` reached Linux. `WSLENV` names the variables that WSL shares ([WSLENV](https://learn.microsoft.com/windows/wsl/filesystems#share-environment-variables-between-windows-and-wsl-with-wslenv)). So a user's `WSLENV` can forward any `GIT_*` variable, and the shell clears it.
- systemd ran as PID 1 (`[boot] systemd=true`). The user manager reported `running`, and `XDG_RUNTIME_DIR` and the bus address were set under `--exec`. Processes outside a scope ran in `0::/init.scope`.

**P5. File primitives on `\\wsl.localhost`.**

- `GetFileInformationByHandleEx` with `FileIdInfo` failed with error 50 for files and directories under both prefixes.
- Linux `stat` gave one device number and distinct inode numbers. Bun `fs.stat` on the UNC path gave the size, the time, and an inode number, but device 0.
- `CreateFileW` with `CREATE_NEW` created `index.lock`, and a second call failed with error 80. `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING` replaced `index` with a copy, and Linux `git status` read it.
- Windows showed the Linux time `.175527414` as `.1755275`. Setting that time made the Linux time `.175527500`, 86 ns later than the original. `File.Copy` gave the same rounded time.
- `stat --file-system` reported `v9fs` for `/mnt/c` and `ext2/ext3` for `/`, `/tmp`, and `/home`.
- WSL showed a Linux name with `\` as U+F05C in the UNC listing.

**P6. Identity sources and I/O accounting (2026-10-01).**

- The probe ran in the running `Ubuntu-24.04`, kernel `6.18.33.2-microsoft-standard-WSL2`, as the default user. It started no distro and changed no configuration.
- `stat --format=%d` of a `/tmp` folder gave 2096, which is device 8:48 (`/dev/sdd`). `lsblk` listed the disks `sda` to `sde`. The second distro `Ubuntu` was stopped, so no start-order comparison ran (T252).
- `findmnt -no UUID -T <folder>` gave `3255683f-53a2-4fdf-91cf-b4c1041e2a62` as the normal user. `blkid` as that user printed nothing, because `/dev/sdd` allows only `root` and `disk`. `/dev/disk/by-uuid` held the UUID, so the value came from udev data.
- `stat -f --format=%i` gave `fedc9aa3bd65bc57`. That equals the XOR of the two little-endian 64-bit halves of the UUID, as ext4 derives its file-system ID.
- `dpkg -S` showed that util-linux 2.39.3 provides both `/usr/bin/findmnt` and `/usr/bin/setsid`.
- A user scope listed only the `cpu`, `memory`, and `pids` controllers, and it had no `io.stat` file. `/proc/<pid>/io` of a scope process was readable.
- A shell ran `dd` for 50 MiB. After it reaped `dd`, its own `rchar` had grown by 52,460,986 bytes.
- Re-probe, 2026-10-10: kernel `6.18.40.1-microsoft-standard-WSL2` in `Ubuntu-26.04` has `# CONFIG_TASKSTATS is not set` and no `/proc/<pid>/io`. WSL2-Linux-Kernel commit 7e83488 (2026-07-30) removed the option. A `systemd-run --user --scope` unit had a readable `cpu.stat`. Its `usage_usec` grew while a process ran and stayed unchanged while it slept. So the anchor uses the CPU-time sum of the scope `cpu.stat` files (contract §11 "Process ownership").

**P7. File-system ID source (2026-10-01).**

- The probe ran in the running `Ubuntu-24.04`, kernel `6.18.33.2-microsoft-standard-WSL2`, as the default user. It started and stopped no distro and changed no configuration. It removed its one folder in `/tmp`.
- `stat --dereference --file-system --format=%t:%i` gave `ef53:fedc9aa3bd65bc57` for `/`, `/tmp`, the home folder, and the Git file. In this distro, `/tmp` lies on the root ext4 disk, not on tmpfs.
- Linux `include/linux/statfs.h` `uuid_to_fsid` XORs the two little-endian 64-bit halves of a UUID. `fs/ext4/super.c` `ext4_statfs` sets `f_fsid` with it from the superblock UUID (Linux v6.18).
- GNU `stat` prints the two 32-bit words of `f_fsid` in reverse order. For UUID `3255683f-53a2-4fdf-91cf-b4c1041e2a62`, that gives `fedc9aa3bd65bc57`, the probed value.
- `statfs` reads the mounted superblock, so it needs no udev data. `blkid -p /dev/sdd` failed with "Permission denied" for the user. `udevadm info` held `ID_FS_UUID`, so `findmnt` took its UUID from udev data.
- `systemd-udev-trigger` became active at 3.95 seconds of monotonic time, and user space started at 3.23 seconds. A `findmnt` read before then could give an empty UUID.
- `/mnt/c` gave `1021997:100000000` (`v9fs`). `/dev/shm` and `/run/user/1000` gave type `1021994` (tmpfs) with different IDs for the two mounts. Linux `fs/xfs/xfs_super.c` derives the XFS ID from the device number.
- Consequence: the identity uses the `statfs` ID for type `ef53` only, and `findmnt` leaves the design (contract §11). Other types give `no-fs-uuid`. So XFS and btrfs folders are refused, although `findmnt` covered them. WSL tests skip with `wsl-fixture-fs-id` when `/tmp` is not ext4. Superseded by P8: the fixture folder moved to the home folder, and the skip now checks that folder.

**P8. Fixture folder lifetime (2026-10-01).**

- The read-only check ran in the running `Ubuntu-24.04` as the default user. It started and stopped no distro and changed no configuration. The second distro `Ubuntu` stayed stopped.
- `/usr/lib/tmpfiles.d/tmp.conf` holds `D /tmp 1777 root root 30d`. `/etc/tmpfiles.d/` is empty, so nothing overrides it.
- `systemd-tmpfiles-setup.service` runs `systemd-tmpfiles --create --remove --boot --exclude-prefix=/dev`. With `--remove`, a `D` line empties its folder. So each distro start empties `/tmp` (tmpfiles.d(5)).
- `systemd-tmpfiles-clean.timer` runs daily. With the `30d` age, it also removes `/tmp` entries older than 30 days.
- The only rule for `/home` is `Q /home 0755 - - -`, which creates the folder and sets no age. No user tmpfiles folder exists. So nothing cleans the home folder.
- `stat --file-system --format=%t:%i` gave `ef53:fedc9aa3bd65bc57` for `/home/<user>` and `/tmp`. The home folder therefore lies on the same ext4 disk and keeps the `statfs` identity of P7.
- Consequence: WSL fixtures live in `<home>/arbareto-fixtures-<random>`, never in `/tmp`. The harness takes `<home>` from `/usr/bin/printenv HOME` through `wsl.exe --exec`. Before C17, F22, and T252, a step records the folder inode and checks it after the restart. A lost folder stops the step with `fixture-lost` (tasks.md test harness rules).

### Consequences and open items

- The route runs before any `FileIdInfo` request. WSL identity comes from the distro GUID, the UUID-derived `statfs` ID, and the `stat` inode (contract §11, P7). Design change, 2026-10-01: the device number left the identity, because it can follow the disk attach order (P6). A folder without that ID gives reason `no-fs-uuid`.
- The candidate time rule of contract §4 steps 100 ns back. So a rounded UNC time cannot fall after the Linux time.
- A distro without a systemd user manager is refused with reason `no-user-manager`. Closed question, 2026-09-30: the user chose this refusal over an ownership limit (spec Clarifications, 2026-09-30). The remedy tells the user to set `systemd=true` under `[boot]` in `/etc/wsl.conf` and restart the distro (contract §11).
- WSL rows stay `unverified` until a WSL2 distro with Git 2.55.0 or later exists. The reference distro has Git 2.43.0. The user must install a newer Git; the app and its tests never install it. The Git floor refusal can run on the reference distro now.
- Git PPA remedy (user decision, 2026-10-04): on an Ubuntu distro, the reason `version` refusal carries a copyable command. The command adds `ppa:git-core/ppa` and installs its Git (contract §11 "Git per distro"). The app never runs it. On 2026-10-04, the PPA offered `1:2.55.0-0ppa1~ubuntu24.04.2` for noble. Ubuntu's own `git` package reports `2.43.0`, also with backported CVE fixes. The version check cannot see backports, so the floor stays 2.55.0. Unverified: that every Ubuntu WSL image holds `add-apt-repository` (package `software-properties-common`). No probe ran the command.
- P1 proved ownership: a single-scope `cgroup.procs` count, a glob kill, the anchor exit after stdin closes, and the Job-close kill. The anchor count protocol is a design, not a probe result: one count for each stdin line, summed over `arbareto-<operationId>-*.scope`. The I/O sum on the same line is a design too, based on P6. T205 and T209 test both.
- Unverified: a stopped-distro start time (the probes started no distro), a WSL1 distro, and a distro without systemd. Also unverified: `virtiofs` drive mounts, the atomicity of a replace over the WSL file share, and packaged behavior.
- Design change, 2026-10-01 (spec Clarifications): every wrapper mode now runs its program through `setsid --wait`, not only `network` mode. Reason: a WSL hook in `mutation` mode could open `/dev/tty` on the hidden console and wait until the commit deadline. R14 probe S10 showed that `setsid --wait` under `CREATE_NO_WINDOW` blocks the `/dev/tty` open and passes the exit status. Consequence: Git's children get no `SIGHUP` at the wrapper exit, so the P1 S6 result no longer describes the product. A plain background child now lingers in its scope, as on Windows. The anchor counts it, and the Job close ends it. A distro without `setsid` is refused with reason `no-setsid`.
- Re-probe needed for that change, before T209 can pass. The probe must show this under `setsid --wait` inside a scope in `mutation` mode. A plain, a `nohup`, and a `setsid` child each survive Git's exit. The anchor counts all three, and a Job close ends them within 1 second. A hook that opens `/dev/tty` fails at once. Git's own `daemonize()` still detaches maintenance inside the scope. T209 runs these cases and reports them here. No probe has run them yet.

### WSL file facts and identity (T212, 2026-10-06)

**Decision** (user, 2026-10-06: "Require Perl"): one fixed Perl script, `/usr/bin/perl`, answers the WSL `fileFacts` requests. The WSL identity probe uses Perl for its failure result too (contract §11). A distro without `/usr/bin/perl` gets `WSL_UNAVAILABLE` with reason `no-perl` at registration.

**Gap 3 evidence**:

- GNU coreutils and findutils report no errno. `stat --printf` exits 1 for every failure, and the cause is only in the message text. `find -printf` exits 0 when all files are OK and above 0 when some error occurred (findutils manual), with no cause per file. `readlink` exits 1 for "not a link" and for an error alike. `test -e` is false for `ENOENT`, `EACCES`, and `EIO` alike. A message text is no contract (CLAUDE.md "No heuristics").
- `head -c | sha256sum` hides a `head` failure behind the pipe, and dash has no `pipefail` (unverified for dash 0.5.12 and later). `env` and `sh -c exec` give errno-based exit statuses 126 and 127, but only by running the file.
- Perl `$!` gives the numeric `errno` in numeric context (perlvar). `Fcntl` gives `O_NOFOLLOW` and `O_DIRECTORY`, and `chdir(HANDLE)` uses `fchdir`, so the walk is relative to handles, as on Windows.
- `perl-base` is `[essential]` in Debian bookworm and Ubuntu noble (packages.debian.org, packages.ubuntu.com). The noble file list holds `/usr/bin/perl`, `Errno.pm`, `Fcntl.pm`, and `POSIX.pm`. `Digest::SHA` is in `libperl`, not `perl-base` (unverified), so the shell computes the digests.
- Fedora, Arch, openSUSE, and AlmaLinux: their full `git` package brings `/usr/bin/perl`, and `git-core` alone does not. Unverified.
- The script passed `perl -c` and a smoke run on Cygwin Perl 5.42 against a scratch tree. It has not run on Linux. No distro ran in that session.

**Rejected: a shell walk over `\\wsl.localhost`**. `FileIdInfo` fails with error 50 on that share (P5). No probe covered relative `NtOpenFile`, `OBJ_DONT_REPARSE`, or `FILE_OPEN_REPARSE_POINT` on the 9P redirector. Linux symbolic links show as unfollowable Linux targets (microsoft/WSL#5118) or as LX symlink tags, which give tag `other` and so `unchecked`. `OBJ_CASE_INSENSITIVE` meets case-sensitive ext4, and the share shows no execute bits. A link that the server resolves would be followed below a root, against spec Clarifications 2026-10-05. A probe (P9) must run before any change of this decision.

**Open measurements in T212**: W6, the `fileFacts` cost per WSL read against the WSL full-read budget (each request starts one `wsl.exe` at 150 to 260 ms). W7, the 60-second context lifetime against a cold distro start. T212 reports both numbers, and the main session decides later. W6 result: the probe-mode wrapper cost 208 ms, Perl phase 1 for 29 entries 242 ms (187 to 376 ms), phase 2 for 2 digests 202 ms, and the identity script for 3 paths 206 ms. The estimated full read as built is 1.3 to 1.5 seconds in 6 serial stages of up to 10 `wsl.exe` starts. That broke the 0.4-second budget, so probe P10 ran.

### Probe P10: pre-started `wsl.exe` processes (2026-10-06)

**Decision** (user, 2026-10-06: "Relax targets only"): Arbareto starts no `wsl.exe` processes in advance. The WSL targets follow the current cost: WSL full read at most 1.5 seconds, WSL outside change within 4.5 seconds, WSL warm reopen within 4 seconds, and WSL cold open within 5.2 seconds (spec Clarifications, 2026-10-06; plan.md "WSL budgets"). T245 confirms them in the packaged run.

**Method**: reference distro `Ubuntu-24.04`, warm, Windows 11. A spare `wsl.exe --exec /usr/bin/perl -e <waiter>` blocked on stdin. A take wrote one length-prefixed argv frame, the waiter wrote one ack byte and ran `exec` on the frame argv. W-M lived in an owned `<home>/arbareto-fixtures-*` folder. No distro configuration changed. 25 runs per form, and 30 runs for `git status`.

**Results**:

- Gate (perf.md recommendation 3): a spare stage must cost at most 50 ms, and Linux `git status` on W-M at most 0.2 seconds.
- Spare stage, from frame write to exit, median: 12.6 ms for a bare `true` (9.6 to 27.6 ms), and 85.7 ms for the wrapper with `true` (61.2 to 104.5 ms). It fails the 50 ms bar. Cold `wsl.exe` start to exit: 247.4 ms for the wrapper with `true`. The ack came after 0.4 ms.
- Inside Linux, medians: `true` 1.8 ms, `setsid --wait true` 3.4 ms, a `systemd-run` scope with `true` 17.9 ms, `systemctl kill` 20.2 ms, and the read-mode wrapper with `true` 51.6 ms. So the systemd scope wrapper alone costs about 52 ms per process, and a spare cannot reach the bar while every process runs in its own scope.
- Linux `git status` on W-M through the product arguments: median 28.7 ms (21.2 to 58.5 ms, n=30). It passes the 0.2-second bar.
- Job membership: a running spare joins a pool Job and then the operation Job (nested Jobs). Closing the operation Job ended the spare after 7 to 8 ms, and the Linux scope was gone about 0.7 seconds later. The inner `C:\Program Files\WSL\wsl.exe` child cannot join the operation Job: `AssignProcessToJobObject` failed with error 5. A `TerminateProcess` of the outer or the inner `wsl.exe` still ended the whole tree.

**Rejected: pre-started spares.** A spare stage costs 86 ms, above the 50 ms bar, because the per-process systemd scope costs about 52 ms inside Linux. The inner `wsl.exe` also stays outside the operation Job. Spares would also keep the distro running and pin the approved program paths. So the user relaxed the targets instead.

Evidence: the P10 scripts and logs (`latency.log`, `wrapper-linux.log`, `status-linux.log`, `job-nested3.log`, `job-suspended.log`, `tree-inner.log`, `tree-outer.log`) in the session scratchpad of 2026-10-06, and the T212 read-cost analysis (`perf.md`).

### WSL in-distro file work, 2026-10-07

The user asked for this design on 2026-10-07. The main session made the decision.

**Crossings found** (read-only audit of main `3def0f3`):

| Place | Crossing through `\\wsl.localhost` |
| --- | --- |
| `status.ts:606` `readRawIndex`, `read-steps.ts:24` `readBounded` | The raw index, up to 64 MiB plus 1 byte, in each `readWorkspace`, also in the 1-second WSL poll. `eligibility.ts:48-114` parses every byte. |
| `snapshot.ts:170` | The shared index. |
| `snapshot.ts:279-357` `readWorkingVersion` | Up to 1 MiB for each bound path. |
| T105 (planned) | Whole working files, up to 512 MiB, for the `stage` SHA-256. |
| T200 and T214 (planned) | The same reads at steps 3 and 7 and after publication. Proof B streams the bytes back through `wsl.exe` stdin. Proof A pipes the `cat-file --filters` output out. |
| T109, T110, and T214 (planned) | The index copy, the candidate, the recheck, the lock write, and the rename. |
| T111 and T112 (planned) | The compare of the retained raw index. |
| T113 and T114 (planned) | Working bytes and digests. |

**Decision**: bulk file work of a WSL repository stays inside the distro. Only facts, sizes, SHA-256 digests, object IDs, exit statuses, and link targets cross. The new request `wslFiles` (contract §6 "WSL file work") has the modes `digest`, `indexDigest`, `hashObject`, `catFile`, `lock`, `candidate`, `publish`, and `remove` (`remove` added in the T325 review, 2026-10-08). A WSL read takes the index digest in the first phase-1 `fileFacts` request of its trust listing, so it adds no `wsl.exe` start (contract §11 "Change polling"). An unchanged digest reuses the retained raw-index part. The read computes the hunk eligibility from the retained `link` hash and its own listing (contract §11 "Change polling"; corrected in the analyze review, 2026-10-08). Reasons:

- Reads through 9P and Linux reads of `/mnt` (drvfs) are slow. No probe measured the byte throughput.
- No probe verified an atomic replace through 9P. A Linux `rename(2)` on one file system is atomic (POSIX.1-2024 `rename`).
- Process cost (P10): about 200 to 250 ms for each `wsl.exe` start and about 52 ms for each systemd scope. So new work joins a process that already runs, or runs once per comparison or staging step.
- The WSL scripts reach the distro as argv. `include_str!` embeds `src/contracts/wsl-process.json` in `src-tauri/src/wsl.rs:72`. The `fileFacts` text runs as `/usr/bin/perl -e <text>` in the wrapper (`wsl.rs:873-891`), with NUL-ended stdin tokens. `wslFiles` uses the same form.

Design choices of this record:

- Index publication uses modes of the same request, not a second request type. The modes map to protocol steps 2, 4, and 8 (contract §4).
- Perl core `utime` sets whole seconds (`doio.c` `apply`, `OP_UTIME`, sets `tv_usec` to 0), and Perl `stat` gives whole seconds. So the candidate and the published lock get the whole seconds of their source time. An earlier time only makes more entries racy (contract §4 "Candidate time"). `Time::HiRes` could set nanoseconds, but its presence in `perl-base` is unverified.
- The removal of an owned lock or candidate uses mode `remove` (T325 review, 2026-10-08). Correction, 2026-10-08: this replaces the first rule, an unlink through UNC.
- `indexDigest` digests `sharedindex.<hash>` only when the request names the hash from the last parse. A file-name search would be a heuristic.

**Rejected**:

- `sha256sum < "$p"` in `sh`: the redirect failure gives no `errno`.
- `git cat-file … | sha256sum` in dash: dash has no `pipefail`, so Git's exit status is lost.
- `git hash-object <file>`: it hashes the converted blob and follows a final link. The approval binds the raw SHA-256 (contract §4 "Binding").
- `Digest::SHA` in Perl: it can be missing from `perl-base` (unverified, see "WSL file facts and identity").
- Lock ownership by device, inode, and size 0 (T325 first round): ext4 gives a freed inode to the next new file at once. A deleted and recreated `index.lock` got the same inode in 3 of 3 runs on Ubuntu-26.04 (review, 43395 → 43395). Git's own new lock is also empty, so `publish` could fill and rename a lock that Git owns.
- `FS_IOC_GETVERSION` as a generation check: it is file-system-specific.

**Verified (T325, 2026-10-08)**:

- The `sha256sum` line matches `^[0-9a-f]{64} [ *]-\n$` with GNU coreutils 9.4 (`/usr/bin/sha256sum`, Ubuntu-24.04) and uutils coreutils 0.10.0 (`/usr/lib/cargo/bin/coreutils/sha256sum`, Ubuntu-26.04). Both print the space mode character for `-`.
- `IO::Handle` loads from `perl-base` in Ubuntu-26.04. `publish` uses its `sync` for `fsync`.
- The T325 WSL test recreated a deleted lock with `O_CREAT|O_EXCL` and got the same device and inode again.

**Decision (T325 review, 2026-10-08)**: lock ownership by a token. The service sends 32 random bytes as 64 hex digits with `lock`, and Perl writes them into the new lock. `publish` requires the same device, inode, and content. Git's lock is empty or starts with `DIRC`, so it never equals the token. `publish` holds the lock descriptor through the rename, so the inode cannot be reused before the last `lstat` (contract §4 "WSL index publication").

**Unverified**:

- Perl pipe-opens of 512 MiB within the 30-second walk deadline.
- `Digest::SHA` and `Time::HiRes` in `perl-base`.
- The byte-throughput savings. No probe measured them.

**Limit (T105, 2026-10-08)**: a WSL comparison sets `diskPath` to the index path bytes (`src/git-service/comparison.ts`). Linux name lookup is exact, so a found file has the index name. A folder with the ext4 `casefold` attribute looks up names without letter case. The service does not detect such a folder. So a letter-case difference there gets no `path` refusal (contract §11 "Paths and file access"). No probe ran with a `casefold` folder.

### WSL mutation probes (T214 WP0, 2026-10-10)

**Method**: Windows 11, Git for Windows 2.56.0.windows.1, test distro `Ubuntu-26.04` with Git 2.55.0, warm (the host detection had started the distro). The probes ran from the worktree `D:\dev\rozvio-l1` at `66610af` as scratch tests outside `tests/`. P2 and P3 ran through the test double `tests/git/bun-runner.ts` on a fresh F21 copy in the owned fixture folder. They did not run the Rust shell. The user Git configuration kept its SHA-256 `958958de…6bdd4`.

**Commands** (the scratch files lie outside the repository):

- P1: `bun test <scratch>/p1.test.ts` from the worktree root. Exit 0, 1 pass.
- P2 and P3: `ARBARETO_WSL_DISTRO=Ubuntu-26.04 bun test <scratch>/p2.test.ts` from the worktree root. The probe case passed. The process exit was 1, from an `EBUSY` in the scratch file's hook order: the fixture-root `afterAll` ran before the runner disposal. The leftover Windows fixture folder was removed by hand.

**Results**:

- P1 (U1). `withFsCalls` of `tests/git/service-harness.ts` spies on the `node:fs/promises` namespace. It recorded both `open` calls that `src/git-service/hunk-candidate.ts` makes through its named import: the canonical index in `copy` and the candidate in `readCandidate`. So the UNC `open` check of `tests/wsl/mutations.test.ts` sees the candidate read of the §4 `link` check, and its filter must skip names that start with `arbareto-candidate-`.
- P2 (U2). Two `run` calls of `["--no-lazy-fetch","version"]` with the `mutation` policy gave exit 0 and `activeDescendants` 0. The first started the anchor.
- P2 (U3). `wslFiles` `candidate` gave a `candidate` reply with equal index and candidate digests. `apply --cached` with the UNC candidate path as `indexFile` gave exit 0. `ls-files --stage` with that candidate as `GIT_INDEX_FILE` showed the blob of the working `multi.txt` (`e9ebb14a`). The canonical index kept `ce94570e`. The double maps the UNC path to the Linux path, as the shell does (`process_requests.rs`). No packaged run verified the shell mapping.
- P3 (R1). The `version` runs took 226 ms (with the anchor start) and 183 ms. The `candidate` walk took 186 ms, and `apply --cached` took 194 ms. So each WSL step costs about 180 to 230 ms, and the first `version` run adds about that much to each WSL mutation. plan.md has no WSL mutation budget.

**Remaining risk (G12)**: a write-then-restore of a working file during the comparison diff can bind a hunk that Git read from the version in between. The `digest` results before and after the diff are equal, so no check sees the change.

Sources: [WSL basic commands](https://learn.microsoft.com/windows/wsl/basic-commands), [WSLENV](https://learn.microsoft.com/windows/wsl/filesystems#share-environment-variables-between-windows-and-wsl-with-wslenv), [wsl.conf](https://learn.microsoft.com/windows/wsl/wsl-config#wslconf), [systemd in WSL](https://learn.microsoft.com/windows/wsl/systemd), [background tasks](https://devblogs.microsoft.com/commandline/background-task-support-in-wsl/), Git Extensions source clone (PathUtil.cs, GitExecutor.cs, GitStatusMonitor.cs), git-config(1) `maintenance.autoDetach`, pid_namespaces(7).

## R14. Submodule initialization and update

**Decision (2026-09-30)**: Add Update submodules to this slice. The user decided the scope: initialize and update every submodule recursively (spec Clarifications, 2026-09-30). The operations are `reviewSubmodules` and `updateSubmodules` (contract §12). They raise the operation count from 19 to 21.

**Rationale**: `docs/project-brief.md` line 53 placed submodule management in a later release. The user moved initialization and recursive update into this slice. Git Extensions runs `git submodule update --init --recursive` for all submodules by default, through a process dialog (`SubmoduleUpdateCommand`). Arbareto borrows that behavior, not its GPL-3.0 code.

**Decisions and reasons**:

| Decision | Reason |
| --- | --- |
| Two operations: a read-only review with a one-use token, then the update. | This mirrors `reviewCommit` and `commit`. The token binds the reviewed plan, and a changed plan refuses the start. |
| Separate clone, connect, fetch, check, and checkout steps for each submodule (2026-10-01). The clone, connect, and checkout steps pass `-- :(literal)<path>`. | The app checks the refs between Git's fetch and its checkout (S20). It knows "i of n" and each exit status without parsing translated text. A plain pathspec matched the wrong submodule (S8). |
| The review runs ten fixed commands inside initialized submodules. | These commands load no index and ran no canary (S3, S23). They narrow the rule that reads never start Git inside a submodule. Reads keep that rule. Since 2026-10-01, they also run in each kept Git directory, with `--work-tree` set to that directory (S11). The `rev-list` read decides whether a row fetches, as in Git's own update (S19). |
| Refuse commits that no ref holds. Every ref counts. | Git detaches HEAD without a warning, and only the reflog keeps such commits until expiry (S4). This slice offers no action that can drop commits (FR-027). |
| Refuse update modes `merge`, `rebase`, and `!command` for existing submodules. | Merge and rebase can leave an unfinished operation. A local `!command` ran a repository command (S5). |
| Refuse an interrupted clone, with the folder path as remedy. | Git cannot recover it alone. Deleting the `.git` file let Git recover (S9), and so did moving the folder out (S13). Since 2026-10-01 the remedy moves the folder, because a deleted `.git` file can expose changed files (S13). The app never repairs state. |
| Report Git's refusal to overwrite local changes as a failed row. | Git kept the changes and continued with the other submodules (S7). |
| A native confirmation for each run when submodules hold programs. | An update ran submodule monitors, filters, hooks, and transport programs (S3, S6). Their configuration lies inside the Git directory, so it is repository-controlled. |
| The stored fingerprint omits the submodule registration keys. | Git's initialization writes only URL, active, and copied update keys (S1, S5), and none names a program. So the update keeps a stored approval, and no approval loop starts. |
| Keep Git's protocol defaults, and never set a protocol key. | Git blocked `ext` and `file` in submodule clones by default (S6). |
| `GIT_TERMINAL_PROMPT=0`, and no console for the update process. | Git then never prompts on a terminal. Git starts `ssh` detached when it has no console (compat/mingw.c:2251-2261). |
| The `network` policy sets `GIT_PROTOCOL_FROM_USER=0` (2026-10-01). | Git's submodule command sets it for its children (git-submodule.sh:29-30). The app's own fetch allowed a `file` remote without it (S21). |
| `setsid --wait` in WSL `network` mode. Replaced on 2026-10-01: every wrapper mode uses it (R11 "UX, start mode, and WSL terminal remediation"). | `wsl.exe` needs a console, and with a hidden console the Linux command could open `/dev/tty` (S10). |
| Keep `--no-lazy-fetch`. | It did not block explicit submodule clones or fetches (S1, S6). |
| A 300-second inactivity deadline and a 4-hour ceiling for each update process. | A fixed 30-second deadline kills large clones. Git prints progress while a transfer advances. The window leaves time for a credential helper sign-in. |
| Progress from the untranslated `NN% (a/b)` counter only. | Git translates every other progress text (progress.c:134). |
| A `reuse` row needs an absent or empty folder (2026-10-01). | Git's reuse checkout runs `checkout -q -f` and overwrote a changed tracked file (S13). |
| The `clone-interrupted` remedy moves the folder out of the repository (2026-10-01). | After the move, Git recreated the folder and finished, and the moved folder kept every byte (S13). Deleting only `.git` exposed changed files to `checkout -q -f`. |
| Relative values from every scope give `unchecked` entries for rows whose worktree the update writes (2026-10-01). | A global relative `core.hooksPath` ran cloned and target-tree hooks without a confirmation (S14). |
| Fetch first, check HEAD and every ref again, then check out with `--no-fetch` (user decision, 2026-10-01). | A pruning fetch removed the only ref that held HEAD (S15). The check after the fetch refused that row and kept HEAD (S20). The replaced rule ignored `refs/remotes` and refused the normal state of most submodules. |
| A `reuse` row that fetches connects first, through Git (2026-10-01). | A fetch run from another folder ran the superproject's relative hooks (S22). The connect step keeps Git's own order and folder. |
| The app visits nested levels itself. A level that needs unconfirmed programs stops with reason `programs` (2026-10-01). | FR-048 requires that the review lists every program. A new dialog during the run would show unlisted programs. |
| A stall notice after 15 seconds without activity, for commit and submodule steps (user decision, 2026-10-01). | A blocked console read changed no Job I/O counter (S24). The deadlines stay as the backstop. |
| Activity for the inactivity limit is output or a changed Job I/O sum (2026-10-01). | Fetch and checkout print nothing, and the Job counters showed the silent transfer (S16). |
| The review reads run again after an approved `confirmRun` (2026-10-01). | The dialog has no time limit. Without a re-check, step 4 would start on unchecked state. |
| A clone check before each clone step (H1, 2026-10-01). | A clone step after a foreign initialization ran an unlisted hook and dropped the last ref of a commit (S26). |
| `--` before every remote name, and the `remote-name` refusal (H1). | A `-`-led remote name became a fetch option and ran a program (S31). `remote.<name>.url` is a Git-written key, so the program list cannot show it. |
| No copyable command for a value with a double quote, a control character, or invalid UTF-8 (H1). | Windows PowerShell 5.1 changed such arguments (S28). |
| `-c fetch.recurseSubmodules=no` on every clone step (H1). | The fetch inside a clone step ran a nested kept hook before its level check (S27). Hooks then see the value, a recorded difference. |
| A register step for an active, unregistered `update = none` row (H1). | Git's own update writes those keys (S5), and `submodule init` for the path wrote the same keys (S33). |
| The fetch remedy sets `GIT_PROTOCOL_FROM_USER=0` for one command (H1). | A pasted plain fetch allowed `file` (S21). The script block form worked in both shells (S30). |
| A WSL Job ignores its `IO_COUNTERS` (H1). | The anchor pipe exchange changes them each second (S29). |
| Read failures end the row `failed` (H1). | A read error taken as an absent state could reach a forced checkout. Exit statuses decide, because Git translates messages. |

**Alternatives considered**:

| Alternative | Finding | Decision |
| --- | --- | --- |
| One `git submodule update --init --recursive` process without a pathspec | "i of n" then needs translated messages or a fixed C locale for hooks. Git printed "aborting" after a failed clone (S6). | Reject. |
| Pass `--checkout` to override configured update modes | It changes the configured behavior silently for one run. | Reject; refuse those modes instead. |
| Persist submodule program approval in the trust record | It changes the record format, and submodule Git directories appear and change with each update. | Reject; confirm each run. |
| Detect dirty submodules before the start | Status inside a submodule loads its index and can run its monitor and filters before confirmation. | Reject; Git's own refusal becomes a failed row. |
| Delete an interrupted clone automatically | FR-016 forbids automatic repair. | Reject; show the file path. |
| Ignore `refs/remotes` and refspec destinations for fetching rows (fourth analysis rule) | It refused the normal state of most submodules. | Reject; the user chose fetch first (2026-10-01). |
| Run Git's own `update --init --recursive` for each top-level row | Fetch and checkout run in one process, so no check fits between them (S15). | Reject (2026-10-01). |
| Ask a new `confirmRun` for a nested level | The review never listed those programs (FR-048). | Reject; stop that level with `programs`. |
| A pseudoconsole whose input the shell closes, for shell-run prompts | No probe tested it, and it changes the console rule. | Not chosen; the user chose the stall notice (2026-10-01). |
| `submodule--helper get-default-remote` for the fallback remote | It is internal Git plumbing. | Reject for the product; T253 uses it as a test oracle. |
| A connect step before the fetch of a `reuse` row without a kept HEAD (H1) | The `--no-fetch` checkout after it failed with "Unable to find current revision" (S27). | Reject; the clone step passes `-c fetch.recurseSubmodules=no`. |
| Only the `remote-name` refusal, without `--` (H1) | A nested level can add a remote after the review. One guard then remains. | Reject; use both. |
| A `& { $env:... }` block without `finally` for the fetch remedy (H1) | `$env:` changes the whole process, not the script block scope. | Reject; `finally` restores the value. |

### Probes S1 to S40

The probes ran on 2026-09-30 and 2026-10-01 with Git `2.55.0.windows.3` on the R13 host. They used only session scratch folders and the distro's `/tmp`. Each used an owned `GIT_CONFIG_GLOBAL` with `protocol.file.allow=always` and `GIT_CONFIG_NOSYSTEM=1`. The remotes were local bare repositories: a superproject with two submodules, one of which held a nested submodule. No probe fetched from the internet. These probes are not qualification evidence.

**S1. Initialization, index, output, and `--no-lazy-fetch`.**

- `git --no-lazy-fetch submodule update --init --recursive --progress` exited 0. It cloned both submodules and the nested one.
- Initialization added `submodule.<name>.active=true` and `submodule.<name>.url` to the superproject `.git/config`. The raw index SHA-256 stayed equal.
- Stdout held one "Submodule path '<path>': checked out '<OID>'" line for each submodule, nested included.
- Stderr held the registration lines, "Cloning into '<absolute path>'...", `remote:` counters, and "Receiving objects: NN% (a/b)" segments ended by CR.
- Before the update, status reported nothing for the uninitialized submodules, and their folders were empty.

**S2. Keys in a cloned submodule Git directory.** `config list --show-scope --show-origin` in each cloned submodule showed only local keys that Git wrote. They were `core.repositoryformatversion`, `core.filemode`, `core.bare`, `core.logallrefupdates`, `core.symlinks`, `core.ignorecase`, and `core.worktree`. Also `remote.origin.url`, `remote.origin.fetch`, `branch.main.remote`, `branch.main.merge`, and, in the parent of the nested one, `submodule.leaf.active` and `submodule.leaf.url`. The hooks folders held only `*.sample` files, and `git hook list post-checkout` found no hook. The worktree `.git` files held relative `gitdir:` paths into `.git/modules/<name>`.

**S3. Canaries during review reads and during the update.**

- Canaries sat in the superproject, in a submodule, and in its nested submodule. They covered command-valued `core.fsmonitor`, clean and smudge filters with a `* filter=f` attribute, 28 hook names, `core.sshCommand`, `core.askPass`, and `credential.helper`.
- Inside the submodule, none ran for these commands, each with `--no-lazy-fetch --no-optional-locks -C <submodule>`:
  - `rev-parse --verify -q HEAD`, `rev-parse --absolute-git-dir`, `rev-parse --git-path hooks`, and `symbolic-ref -q HEAD`.
  - `config list --show-scope --show-origin -z` and `hook list -z --show-scope post-checkout`.
  - `for-each-ref --contains=HEAD --count=1 --format=%(refname)`, `cat-file -e`, and `cat-file --batch-check`.
  - `ls-tree -z` and `ls-tree -r -z --full-tree`, `config --blob <OID>:.gitmodules --null --list`, and `rev-list --count HEAD --not --glob=*`.
- In the superproject, `config --file .gitmodules --null --list` ran no canary. `ls-files -z --stage` and `diff-files -p --ignore-submodules=dirty` ran only the superproject monitor, which the read gate covers.
- `diff-files -p --ignore-submodules=dirty` printed "Subproject commit <OID>" for the moved HEAD of a submodule. It ran no submodule canary.
- The update ran the superproject monitor and the submodule monitor, smudge filter, `post-checkout`, `post-index-change`, and `reference-transaction`. It also ran the nested monitor.

**S4. A commit that no ref holds.** A local commit on the detached HEAD of a submodule gave an empty `for-each-ref --contains=HEAD`. `rev-list --count HEAD --not --glob=*` printed 1. Porcelain v2 status showed `SC..` with the recorded OIDs only. The update checked out the recorded commit and printed no warning. The local commit stayed only in the submodule reflog.

**S5. Update modes and the active set.**

- A `.gitmodules` value `update = !<canary>` made initialization fail with "fatal: invalid value for 'submodule.leaf2.update'" and exit 128. No canary ran, and no local key appeared.
- A local `submodule.leaf2.update=!<canary>` ran the canary with the target OID.
- Initialization copied a `.gitmodules` value `update = rebase` into the local configuration.
- A just-cloned submodule with `update = rebase` got a checkout on a detached HEAD. The source forces a checkout for `merge`, `rebase`, and `none` after a clone (builtin/submodule--helper.c:2143-2147).
- An uninitialized submodule with `.gitmodules` `update = none` got registered with a copied `update none` key. Git printed "Skipping submodule 'leaf2'" and cloned nothing (builtin/submodule--helper.c:2298). So `none` never reaches the forced checkout.
- With `submodule.active` unset, `update --init` changed an explicit `submodule.leaf2.active=false` to `true`, with and without a pathspec. Initialization sets the key when the submodule is not active (builtin/submodule--helper.c:596-597).
- With `submodule.active=mid`, `update --init` without a pathspec initialized only `mid`. It wrote only `submodule.mid.url`.

**S6. Transports, fetch, and environment.**

- An `ext::` URL gave "fatal: transport 'ext' not allowed" twice and exit 1. Git printed "Failed to clone 'leaf2' a second time, aborting". No canary ran.
- With an owned global file without `protocol.file.allow`, a `file://` URL gave "transport 'file' not allowed". Git's submodule command sets `GIT_PROTOCOL_FROM_USER=0` (git-submodule.sh:29-30). Git's `file` default is `user` (git-config(1) `protocol.allow`).
- A recorded commit that the submodule lacked made the update fetch it. The submodule's local `remote.origin.uploadpack` canary ran, and the update exited 0.
- A submodule `post-checkout` hook saw `GIT_NO_LAZY_FETCH=1`, and `GIT_TERMINAL_PROMPT=0` when the caller set it.

**S7. Local changes that block a checkout.** One submodule held a local edit to a file that its target commit changes. Another submodule needed a move. The update printed "Your local changes to the following files would be overwritten by checkout". It then printed "Unable to checkout '<OID>' in submodule path 'leaf2'" and exited 1. The other submodule moved. The blocked submodule kept its HEAD and its edit.

**S8. Pathspec magic.** A superproject held the submodules `sub[1]` and `sub1`. `update --init -- 'sub[1]'` initialized `sub1` only, because Git read `[1]` as a glob. `update --init -- ':(literal)sub[1]'` initialized `sub[1]` only.

**S9. A killed clone.**

- PowerShell started the update of a 300 MB submodule remote and ended the process tree with `taskkill /T /F` after 1.2 seconds.
- The kill left `.git/modules/big` with `config`, `HEAD`, empty `refs`, and one `objects/pack/tmp_pack_*` file. It also left the `big/.git` file and the registered `submodule.big.url` and `active`. No lock file remained.
- The next `update --init --recursive` failed with "fatal: Unable to find current revision in submodule path 'big'" and exit 128.
- After only `big/.git` was deleted, the next update fetched into the kept Git directory and checked out the recorded commit. After both were deleted, it cloned again. Both exited 0.
- A separate case: `git submodule deinit` removed the whole `submodule.leaf2` section and kept `.git/modules/leaf2`. The next `update --init` reused that Git directory without a clone.
- A kept Git directory can hold a commit that no ref holds. `--git-dir=.git/modules/leaf2` with `rev-parse`, `for-each-ref --contains=HEAD`, and `config list` found it and ran no canary. The reuse update then left that commit, which stayed only in the reflog.

**S10. Consoles, terminals, and distro Git.**

- Python `subprocess` started `wsl.exe --exec /bin/sh -c <script>` with three creation flags. With `DETACHED_PROCESS`, the script ran and wrote a marker file, but `wsl.exe` relayed no stdout or stderr. With `CREATE_NO_WINDOW` or no flag, the output arrived. The script printed "not a tty" for stdin, but it opened `/dev/tty`.
- Under `CREATE_NO_WINDOW`, `setsid --wait /bin/sh -c <script>` could not open `/dev/tty`, and the exit status 7 passed through.
- Git for Windows under `DETACHED_PROCESS` printed its version normally.
- Distro Git 2.43.0 rejected `git --no-lazy-fetch version` with "unknown option: --no-lazy-fetch". Its `version --build-options` worked. Git added the option in 2.45.0 (RelNotes/2.45.0.adoc).
- Distro Git 2.43.0 without `--no-lazy-fetch` printed the same checked-out line and `NN% (a/b)` segments. It blocked `ext` and `file` the same way. The §11 floor refuses this Git, so these lines only confirm that the formats match.

**S11. Kept Git directories, nested reuse, and review reads (2026-10-01).**

- A superproject held submodule `s1`, and `s1` held the nested submodule `s2`. All three were initialized. Canaries sat in `.git/modules/s1` and `.git/modules/s1/modules/s2`. They covered command-valued `core.fsmonitor`, `post-checkout`, `post-index-change`, and `reference-transaction`.
- `git submodule deinit -f s1` emptied the `s1` folder and removed the `submodule.s1` keys. Both Git directories stayed.
- `git --no-lazy-fetch submodule update --init --recursive -- ':(literal)s1'` reconnected both Git directories in one process. Every canary in both directories ran. Neither submodule had a `.git` entry before the update.
- `--git-dir=.git/modules/s1/modules/s2` failed with "cannot chdir" to its `core.worktree`, because the `s1` folder was empty. With `--work-tree=<same directory>` added, every contract §12 review read ran there, and no canary ran. The `unsaved-commits` remedy `branch` with both options created its branch and ran the `reference-transaction` hook, as a terminal run does.
- `rev-parse --absolute-git-dir` failed with "not a git repository" for `.git/modules` and `.git/modules/s1/modules`. `config list` there printed only the global entries.
- `ls-remote --get-url` in `.git/modules/s1` ran no canary, also with `remote.origin.uploadpack`, `core.sshCommand`, and `credential.helper` canaries. The contract does not use it (S12).

**S12. Fetch remote of a reused submodule (2026-10-01).**

- The kept `.git/modules/s1` lacked the recorded commit. Its `remote.origin.url` named a missing folder, and the `.gitmodules` URL was valid.
- The update registered the `.gitmodules` URL in the superproject configuration. Its fetch then failed with "'<missing folder>' does not appear to be a git repository" and exit 128.
- After the kept `remote.origin.url` named the valid remote, the same update exited 0 at the recorded commit.
- A second case kept the missing `origin` and added a remote `good` with the `.gitmodules` URL. The `origin` fetch failed. Git printed "Unable to fetch in submodule path 's1'; trying to directly fetch <OID>". The fetch by commit ID from `good` succeeded, and the update exited 0.
- Source, Git v2.55.0: the first fetch is `git fetch` without a remote (builtin/submodule--helper.c:2644-2665). It uses the remote of the checked-out branch, else the only remote, else `origin` (remote.c:666-680). With `fetch.all` true, it fetches every remote (builtin/fetch.c:2700-2720). A fetch by commit ID prefers the remote whose URL equals the `.gitmodules` URL (builtin/submodule--helper.c:77-115).
- A scratch repository confirmed the default rule. A single remote named `upstream` received the fetch. With two remotes and no `origin`, `ls-remote --get-url` failed with "No remote configured".
- So the review lists every remote URL of a fetching row and marks the default remote (contract §12 "Plan").

**S13. Reuse rows and folder state (2026-10-01).**

- A superproject held one initialized submodule. The probe changed a tracked file, added an untracked file, and deleted the `.git` file. The row became `reuse`.
- `git --no-lazy-fetch submodule update --init --recursive -- ':(literal)sub'` exited 0. `GIT_TRACE` showed `git checkout -q -f <OID>` in the submodule. The tracked file held the committed bytes again, and the untracked file stayed.
- After `deinit -f`, the folder was empty, and the update succeeded. After the folder was removed, Git recreated it and succeeded.
- An emulated interrupted clone removed the refs of the kept Git directory, so `rev-parse --verify -q HEAD` failed. The update then failed with "Unable to find current revision". After the probe moved the whole folder out, the update exited 0 at the recorded commit. The moved folder kept `.git`, `f`, and `g`.
- The same emulated state, with a changed tracked file and only `.git` deleted, ran `checkout -q -f`. The file lost its change.
- A `clone` row into a folder with a file failed with "clone of ... failed", and the file kept its bytes.

**S14. Relative hooks path in submodules (2026-10-01).**

- An owned global file set `core.hooksPath=.githooks`. The submodule remote held `.githooks/post-checkout` and `.githooks/reference-transaction` canaries. Commits A and B each wrote their own tag.
- `clone` row: the update ran `reference-transaction A` and `post-checkout A` from the cloned tree. Under the earlier rule, the program list of this row was empty, so no confirmation went out.
- `fetch-checkout` row from A to B: the fetch ran `reference-transaction A` from the current tree. The checkout then ran `reference-transaction B` and `post-checkout B` from the target tree.
- `checkout` row from A to a local B: the update ran `reference-transaction B` and `post-checkout B`.

**S15. Remote-tracking refs and prune (2026-10-01).**

- A submodule HEAD was detached at commit X, which only `refs/remotes/origin/feat` held. The submodule set `fetch.prune=true`. The remote deleted `feat`, and the superproject recorded a commit that needed a fetch.
- `for-each-ref --contains=HEAD --count=1` printed `refs/remotes/origin/feat`, so the earlier rule passed. With `--exclude=refs/remotes`, it printed nothing.
- The update exited 0, and its fetch removed `refs/remotes/origin/feat`. No ref contained X, and only the HEAD reflog kept it.
- `--exclude=refs/remotes`, `--exclude=refs/remotes/`, and `--exclude=refs/remotes/origin` each excluded `refs/remotes/origin/a/b`. `--exclude=refs/remotes/origin/*` did not. `--exclude=refs/heads/feat-*` excluded `refs/heads/feat-1`.
- Decision, 2026-10-01: the user chose fetch first and a check after the fetch (S20). The design uses no `--exclude` pattern.

**S16. Silent transfers and Job I/O counters (2026-10-01).**

- `GIT_TRACE` of a `fetch-checkout` row showed `git fetch` without a progress option, then `git checkout -q <OID>`.
- A Python `ctypes` probe assigned processes to a Job and read `JobObjectBasicAndIoAccountingInformation`. A 20 MiB socket download to memory raised `OtherTransferCount` by about 21 MB. `ReadTransferCount` stayed almost unchanged.
- An idle process changed no `IO_COUNTERS` field in 3 seconds.
- A silent `git fetch -q` of a 40 MB blob from a local remote wrote no output byte. Its Job read 120,049,500 bytes and wrote 160,053,980 bytes.
- Microsoft Learn states that the Job counters cover every process that was ever in the Job.

**T225 record (2026-10-08).**

- A silent `git fetch -q` of a 300 MB blob from a local remote ran under a 2-second inactivity limit. It exited 0 after 70 to 74 seconds. No false inactivity end occurred.
- The Job I/O sum rose every second, from about 9.5 MB to 2.08 GB.
- The F11 commit hook and the F30 fetch both waited on `ssh-keygen`. Each sent `stalled` 15.5 to 15.6 seconds after its last activity.

**S17. Consoles of shell-run programs (2026-10-01).**

- A Python harness started `git --no-lazy-fetch commit --quiet --file=-` with `DETACHED_PROCESS` and `GIT_TERMINAL_PROMPT=0`. It closed the stdin pipe after the message. Each `pre-commit` hook ran one variant, and the harness killed the tree after 15 seconds.
- `read -r line < /dev/tty` failed at once with "No such device or address". Plain `Read-Host` returned at once, because its stdin was redirected. `cmd /c pause` also returned at once.
- `powershell.exe -NoProfile -Command "Read-Host -AsSecureString x"` waited until the kill. So did Windows OpenSSH `ssh-keygen -y -f <key>` with a passphrase key, also with `< /dev/null`. A `sleep 20` control also reached the kill.
- Started directly with `DETACHED_PROCESS`, the same `ssh-keygen -y` failed at once with "incorrect passphrase supplied". Started with `CREATE_NO_WINDOW`, it waited until the kill.
- `GIT_TRACE` showed that a `core.sshCommand` without arguments started `ssh.exe` directly. With `-o BatchMode=no` added, Git started `sh.exe -c` instead.
- The results match an MSYS2 runtime that gives a native console program an invisible console when the shell has none. This research did not read the runtime source.

**S18. Loopback HTTP 401 (2026-10-01).**

- A Python server on `127.0.0.1` answered every request with 401 and `WWW-Authenticate: Basic`. A superproject held one gitlink with the URL `http://127.0.0.1:<port>/x.git`.
- With `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, and `DETACHED_PROCESS`, the update exited 1 after 1.9 seconds. Stderr held "could not read Username for 'http://127.0.0.1:<port>': terminal prompts disabled".
- With `http://u@127.0.0.1:<port>/x.git`, stderr held "could not read Password for 'http://u@127.0.0.1:<port>'". So the output tail needs URL redaction there.
- The probe used `http`, which needs no certificate. T224 adds an `https` variant with a test certificate authority.

The probes S19 to S24 ran on 2026-10-01 with the same Git and setup. The remotes were `leaf`, `mid` with `leaf` nested, `solo`, and a superproject that held `mid` and `solo`. Scripts and traces stay in the session scratch folder.

**S19. What Git's own update runs (`GIT_TRACE`).**

- Clone rows: `submodule--helper clone` ran `git clone --no-checkout --progress --separate-git-dir <modules folder> <URL> <path>`. Git cloned both top-level submodules before the first checkout.
- Each submodule then ran `rev-list -n 1 <target> --not --all` twice and `checkout -q -f <target>`. Then `submodule--helper update --recursive --super-prefix=<path>/ --jobs=1 --init --progress` ran inside it.
- A `fetch-checkout` row ran `rev-list`, then `git fetch` with no option, remote, or refspec. The fetch started `git maintenance run --auto --no-quiet --detach`. Then `rev-list` and `checkout -q <target>` ran.
- A target that existed locally without a ref made `rev-list` print it. Git ran `git fetch`, then `git fetch origin <target>`. The second fetch exited 0, because the object was local. Then `checkout -q <target>` ran.
- A `reuse` row with a missing target: the clone helper connected the kept Git directory without a clone process. Then `rev-list`, `git fetch`, `rev-list`, and `checkout -q -f <target>` ran.
- Each submodule child ran with `cd <path>` and `GIT_DIR=.git`.

**S20. The update steps of contract §12.**

- Prune case: HEAD at commit Y was held only by `refs/remotes/origin/feat`, with `fetch.prune=true`. The remote deleted `feat`, and the target needed a fetch.
- The review read printed `refs/remotes/origin/feat`, so the row passed. `GIT_PROTOCOL_FROM_USER=0 git --no-lazy-fetch -C <submodule> fetch --progress` exited 0 and removed that ref. Its stderr held `NN% (a/b)` segments.
- After the fetch, `rev-list` found the target reachable. HEAD still pointed to Y, and `for-each-ref --contains=HEAD` printed nothing. So the row refused, and no checkout process ran.
- The same case without `fetch.prune` kept the ref. `submodule update --init --no-fetch --progress -- ':(literal)solo'` then ran only `checkout -q <target>`.
- `--no-fetch` without `--recursive` moved `mid` and left its nested `leaf` at the old commit. A second step `-C mid submodule update --init --no-fetch -- ':(literal)leaf'` moved `leaf`.
- HEADs, the `submodule.*` keys of both levels, and the `modules` folders equaled Git's own `--recursive` in a copy. Clone rows gave the same equality with the same two-step order.
- `--no-fetch` with a missing target printed "fatal: unable to read tree" and "Unable to checkout". It exited 128 and kept HEAD.

**S21. Transport policy of the fetch step.**

- An owned global file without `protocol.file.allow` was in use, and the row needed a fetch.
- Git's own update printed "transport 'file' not allowed" twice. It then printed that direct fetching of the commit failed, and it exited 128.
- The app's `git -C <submodule> fetch` without `GIT_PROTOCOL_FROM_USER` exited 0. With `GIT_PROTOCOL_FROM_USER=0`, it printed "transport 'file' not allowed" and exited 128.

**S22. Fetch folder of a `reuse` row.**

- An owned global file set `core.hooksPath=.githooks`. `reference-transaction` canaries sat in the kept Git directory, in its `hooks` folder, and in the superproject root. The kept Git directory lacked the target.
- Git's own update ran no canary.
- `-C <superproject root> --git-dir=<kept> --work-tree=<kept> fetch` ran the superproject root canary four times. With an absent folder as `--work-tree`, the result was the same, and the fetch created no folder.
- `-C <empty submodule folder> --git-dir=<kept> fetch` ran no canary. So a relative hooks path follows the start folder of the fetch.
- The connect step `submodule update --init --no-fetch` registered the URL, wrote the `.git` file, and removed the kept index. It failed with "unable to read tree" and exit 128, and HEAD stayed.
- Then `-C <folder> fetch` ran no canary, and the checkout step ran `checkout -q <target>`. HEAD reached the target, and status was empty. An unchanged second file was present and clean.

**S23. The `rev-list` read and the remote inputs.**

- Canaries covered `core.fsmonitor`, filters with an attribute, 28 hook names, `remote.origin.uploadpack`, `core.sshCommand`, `core.askPass`, and `credential.helper`.
- `rev-list -n 1 <target> --not --all` ran none of them. A reachable target gave exit 0 and no output. A missing one gave exit 128 and "bad object".
- A target present without a ref gave exit 0 and printed its ID. The kept-directory form gave the same results.
- `remote get-url --all <name>` applied `url.<base>.insteadOf` and ran no canary.
- `submodule--helper get-default-remote <path>` printed the remote whose rewritten URL equaled the `.gitmodules` URL. With one remote, it printed `origin`.

**S24. Job I/O counters during hidden prompts.**

- A Python `ctypes` harness started Git with `DETACHED_PROCESS` and `CREATE_SUSPENDED`. It assigned a kill-on-close Job and read `IO_COUNTERS` once per second for 30 seconds.
- A `pre-commit` hook ran Windows OpenSSH `ssh-keygen -y -f <passphrase key> < /dev/null`. The counters changed only in the first second, and no output arrived.
- A `pre-commit` hook ran `powershell.exe -NoProfile -Command "Read-Host -AsSecureString x"`. The last change came at second 11, during the PowerShell start.
- A `sleep 40` control behaved like the `ssh-keygen` case.
- `git fetch ssh://localhost/x.git` ran with `core.sshCommand` set to `ssh-keygen -y -f <key> #`. The arguments made Git start `sh`. The counters changed only in the first second.
- The Job close ended every process, and no `ssh-keygen` or PowerShell process remained.

**S25. Nested recursion of the submodule fetch.**

- A superproject held `mid`, and `mid` held a populated nested `inner`. Upstream, `mid` recorded a new `inner` commit that the local `inner` lacked. No `fetch.recurseSubmodules` or `submodule.recurse` key was set.
- `GIT_PROTOCOL_FROM_USER=0 git --no-lazy-fetch -C mid fetch --progress` printed "Fetching submodule inner". It fetched the new `inner` commit.
- The fallback form `fetch --progress origin <mid commit ID>` also printed "Fetching submodule inner" and fetched that commit.
- With `--no-recurse-submodules`, both forms fetched only `mid`, and `inner` still lacked the commit.
- With the new `inner` commit already present, the default fetch did not recurse. With `-c fetch.recurseSubmodules=true`, it recursed again.
- Consequence: both §12 fetch steps pass `--no-recurse-submodules`. The update visits each nested level itself, after the level read and check. With the default configuration, the result equals Git's own update. With `fetch.recurseSubmodules=true`, nested remote-tracking refs can differ (contract §12 "Update protocol").

The probes S26 to S33 ran on 2026-10-01 for the H1 safety remediation. They used Git `2.55.0.windows.3`, PowerShell `7.6.6`, Windows PowerShell `5.1.26100.9444`, and Python `3.12.9`. Each used an owned `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM=1` in a session scratch folder. Scripts and traces stay in that folder.

**S26. A clone step after a foreign initialization.**

- The review state of `solo` was a `clone` row: no `.git` entry and no `modules/solo`.
- Another Git process then ran `submodule update --init -- solo`, committed on the detached HEAD, and added a `post-checkout` canary to `modules/solo/hooks`. No ref held that commit.
- The reviewed clone step `submodule update --init --progress -- ':(literal)solo'` exited 0. It checked out the recorded commit, and the unlisted canary ran.
- Afterwards no ref contained the local commit. Only the reflog kept it.

**S27. Nested recursion of a clone step.**

- `mid` held a nested `inner`. Both were deinitialized, so `modules/mid` and `modules/mid/modules/inner` stayed. Upstream, `mid` recorded a new `inner` commit, and the superproject recorded a new `mid` commit. A `reference-transaction` canary sat in the kept `inner` Git directory.
- Case A: the kept `mid` HEAD was a detached commit, and the target was missing. Case D: `modules/mid/HEAD` named a missing branch, so `rev-parse --verify -q HEAD` found no commit.
- In both cases, the clone step ran `git fetch` in `mid`. That fetch ran `git fetch --recurse-submodules-default on-demand --submodule-prefix=inner/` in the kept `inner` Git directory. The canary ran 4 times, before any nested level check.
- Case E, without a kept HEAD: the connect step exited 128, and `fetch --no-recurse-submodules` ran no nested fetch. The `--no-fetch` checkout then exited 128 with "Unable to find current revision". So a connect step cannot replace the clone step there.
- Case G: the clone step with `-c fetch.recurseSubmodules=no` exited 0, and no canary ran. After the app's nested steps, the HEADs, both `submodule.*` key sets, and the nested refs equaled Git's own `--recursive` update.
- Case H: the same with `submodule.inner.fetchRecurseSubmodules=on-demand` in the kept `mid` configuration. No canary ran. builtin/fetch.c:2819 skips `fetch_submodules` when the value resolves to `no`.
- A `post-checkout` hook printed `GIT_CONFIG_PARAMETERS='fetch.recurseSubmodules'='no'` and `GIT_NO_LAZY_FETCH=1`. So hooks see the option.

**S28. PowerShell argument passing to Git.**

- A UTF-8 script with a BOM ran `git rev-parse --sq-quote` with single-quoted values. `GIT_TRACE` wrote the argument list that Git received to a file.
- PowerShell 7.6.6 passed every value literally.
- Windows PowerShell 5.1 passed `'"--upload-pack=MARK' 0123abcd` as one argument: `--upload-pack=MARK 0123abcd`.
- It passed `'a" --recurse-submodules=yes "b'` as `a --recurse-submodules=yes b`. A `-C` value with `"` and spaces also lost its quotes.
- Both shells passed U+201C, U+201D, and U+201E literally, also as the first character. They passed TAB, CR LF, `$(x)`, and a backtick literally. Doubled U+0027 and U+2019 stayed literal.

**S29. Job I/O counters with a pipe partner.**

- A Python `ctypes` harness assigned an idle child and a pipe partner to one Job. It read `JobObjectBasicAndIoAccountingInformation` once per second.
- Without an exchange, no `IO_COUNTERS` field changed in 4 seconds.
- With one line each second, each second added one read operation and one write operation. Read bytes rose by 2 and write bytes by 5. `OtherTransferCount` stayed unchanged.
- So a WSL Job, whose anchor exchanges one line each second, never shows an unchanged sum.

**S30. One-command `GIT_PROTOCOL_FROM_USER` in the fetch remedy.**

- The form `& { $p = $env:GIT_PROTOCOL_FROM_USER; $env:GIT_PROTOCOL_FROM_USER = '0'; try { & '<git>' ... fetch --no-recurse-submodules } finally { $env:GIT_PROTOCOL_FROM_USER = $p } }` ran in both shells.
- The remote was a local folder, and the owned global file had no `protocol.file.allow`. Each run printed "transport 'file' not allowed" and exited 128.
- With the variable unset before, it stayed unset. With `x` before, it was `x` again. `$p` did not exist after the block.
- The same fetch without the variable exited 0.
- In the running `Ubuntu-24.04` distro, `wsl.exe --exec /usr/bin/env GIT_PROTOCOL_FROM_USER=0 /usr/bin/git ... fetch` refused a `file` remote. Without the variable, it fetched. The distro Git was 2.43.0, so the run omitted `--no-lazy-fetch`.

**S31. A remote name that starts with `-`.**

- A repository held the remote `--upload-pack=m.sh`, and `m.sh` wrote a marker.
- `fetch --progress --no-recurse-submodules '--upload-pack=m.sh' <ID>` exited 128, and the marker held `RAN <ID>`.
- With `--` before the name, Git fetched the commit from that remote, and no marker appeared.
- `remote get-url --all` without `--` exited 129 with "unknown option". With `--`, it printed the URL.

**S32. Relative URL resolution and `insteadOf`.**

- The owned global file set `url.<folder>/real/.insteadOf=fake:`. The superproject came from `fake:super.git`, and `.gitmodules` held `../sub.git`.
- `submodule init` wrote `fake:sub.git`, from the raw `remote.origin.url`. `remote get-url origin` showed the rewritten path.
- Without `remote.origin.url`, Git warned and resolved the URL against the superproject worktree folder.
- In the cloned submodule, `remote get-url --all -- origin` showed the rewritten path, so it differed from the resolved URL. `get-default-remote` printed `origin`, the only remote.

**S33. Registration of an `update = none` submodule.**

- `.gitmodules` set `update = none` for the uninitialized `leaf2`. A second submodule, `solo`, had no mode.
- Copy A ran `submodule update --init --recursive`. Copy B ran `submodule init -- ':(literal)leaf2'`.
- Variants: no activation keys, an explicit `submodule.leaf2.active=false`, and `submodule.active=leaf2`.
- In each variant, the `submodule.leaf2.*` keys of both copies were equal. They were `url`, `update none`, and `active true` where Git sets it. Neither copy cloned `leaf2`.

The probe S34 ran on 2026-10-01 for the verification remediation. It used Git `2.55.0.windows.3`, PowerShell `7.6.6`, Windows PowerShell `5.1.26100.9444`, and Python `3.12.9`. It used an owned `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM=1` in a session scratch folder. Scripts stay in that folder.

**S34. Trailing backslashes in PowerShell arguments.**

- A Python script wrote UTF-8 scripts with a BOM. Each line ran `& '<git>' rev-parse --sq-quote` with single-quoted values by the contract §4 rule. Git echoed the arguments that it received. Each script ran through `-NoProfile -File` in both shells. It ran with `C:\Git\cmd\git.exe` and with `C:\Git\mingw64\bin\git.exe`, and both gave the same results.
- Windows PowerShell 5.1 changed each value that held white space and ended in `\`. `'x \' ' --upload-pack=evil'` arrived as `x " ` and `--upload-pack=evil`. `'x \\' 'next'` arrived as `x \` and `next`. `'a b\\\' 'next'` arrived as one argument, `a b\" next`.
- `--git-dir='D:\my repo\m\sub\' --work-tree='D:\my repo\m\sub\'` arrived as two other arguments, split at the space of the second value. `':(literal)a b\'` merged with the next argument.
- U+00A0, U+2002, and U+3000 before a trailing `\` caused the same merge. So 5.1 treats them as white space.
- 5.1 passed each of these literally: `x\` and `x\\` without white space, `-C 'D:\'`, `-C 'D:\.'`, and `'a \ b'`. It also passed `'x /'` and a `\` before a doubled U+0027 or U+2019. It passed each path without a trailing `\` literally.
- PowerShell 7.6 passed every value literally. With `$PSNativeCommandArgumentPassing = 'Legacy'`, 7.6 still passed each trailing `\` literally. That mode still dropped a U+0022, as 5.1 did in S28.
- A second script built commands by the final rule. It removed trailing separators except at a drive root. It built no command for a value that ends in `\`. Every accepted command gave Git the intended arguments in both shells, with both Git paths. This included the forward-slash forms `D:/my repo` and `D:/`. The rule refused the remote names `x \` and `x\`.
- No probe ran Git with a UNC share root or passed `\` through `wsl.exe`.

The probe S35 ran on 2026-10-08 for the T229 discovery notice. It used Git `2.56.0.windows.1` and Git `2.55.0` on Ubuntu-26.04.

**S35. Notice file checks and `.gitmodules` sources.**

- In a WSL repository, the worktree root is a `\\wsl.localhost\…` path (`src/git-service/discovery.ts`). A Windows `lstat` of each gitlink `.git` path crossed 9P once per gitlink. Contract §11 does not allow this, so the notice uses `fileFacts` requests with `digest: false`.
- In WSL, a gitlink `a/sub` with `a` as a symbolic link gave porcelain v2 `1 AD S... a/sub`. Git saw no worktree entry. `lstat("a/sub/.git")` followed the link and found an entry.
- `config --file .gitmodules --null --list` exited 128 for a broken section line, with partial records on stdout. It also exited 128 for an absent file, and 0 for `path` without a value. No exit status identifies an invalid file. The `status` form of the app exited 0 with the same broken file.
- A non-boolean `submodule.<name>.active=maybe`: `status` exited 0. `submodule status`, `submodule update`, and `submodule update --init` exited 128 with "bad boolean config value".
- `config --blob :.gitmodules` loaded the index. With a command-valued `core.fsmonitor`, it ran the hook. With `core.fsmonitor=true`, it started `git fsmonitor--daemon`.
- `config --blob HEAD:.gitmodules`, `config --blob <object ID>`, and `config --file` started no child.

The probes S36 to S40 ran on 2026-10-10 for T230. They used Git `2.56.0.windows.1` and Bun `1.4.2`. Each used the owned fixture root of `tests/git/fixture-root.ts`, an owned `GIT_CONFIG_GLOBAL`, and `GIT_CONFIG_NOSYSTEM=1`. The real global file kept its digest. Scripts stay in the session scratch folder.

**S36. An appended LF and the `.gitmodules` listing.**

- F27 `base`. `config --file .gitmodules --null --list` exited 0 before and after one LF was appended to the worktree `.gitmodules`.
- Both outputs had the same 108 bytes, with SHA-256 `5100f6a8…`. The file SHA-256 changed from `c209101e…` to `f2322d0d…`.
- Porcelain v2 status then reported `.gitmodules` as `.M`.
- So the listing does not show a byte change of the file. A binding of the file digest shows it (contract §12 "Update protocol" step 2).

**S37. What a failed clone step leaves.**

- F27 `base`, the `clone` row `solo`. The step was `--no-lazy-fetch -c fetch.recurseSubmodules=no -C <super> submodule update --init --progress -- :(literal)solo`, with `GIT_TERMINAL_PROMPT=0` and `GIT_PROTOCOL_FROM_USER=0`.
- Case A: the worktree `.gitmodules` URL `ext::sh -c echo% x`. Git printed "transport 'ext' not allowed".
- Case B: the URL `../solo.git`, a local folder, with a global file without `protocol.file.allow`. Git printed "transport 'file' not allowed".
- Case C: the loopback server of `tests/git/http-401.ts`, which answers 401. Git printed "terminal prompts disabled", and the server counted 2 requests.
- In each case, the step exited 1, not 128. Git tried the clone twice ("a second time, aborting").
- Before and after the step, the worktree path was an empty folder without a `.git` entry. No `modules/solo` existed.
- Before the step, the superproject `config --local` held no `submodule.*` key. After it, it held `submodule.solo.active` and `submodule.solo.url`.
- So a failed clone of an unregistered row leaves no `.git` entry and no Git directory, but it registers the row. The row ends `failed` with `registered`, which is an effect. Only a killed clone left the `clone-interrupted` state (S9).

**S38. An unmapped `.gitmodules` entry with a refused `update` value.**

- F27 `behind-present`: `solo` is initialized at `main~1`, and `mid` is not initialized. The worktree `.gitmodules` got `submodule.ghost` with `path = ghost` and `url = ../ghost.git`. Copy A added `update = !true`, and copy B added `update = foo`. The index had no gitlink `ghost`.
- In both copies, each of these steps exited 128 with "invalid value for 'submodule.ghost.update'": the clone step for `mid`, the register step `submodule init -- :(literal)mid`, and the checkout step `submodule update --init --no-fetch --progress -- :(literal)solo`.
- No step wrote a `submodule.*` key. The keys stayed `submodule.solo.active` and `submodule.solo.url`. No `mid/.git` entry appeared, and the `solo` HEAD did not change.
- `--no-lazy-fetch -C <super>/solo fetch --progress --no-recurse-submodules` exited 0 in both copies.
- So such an entry makes every `submodule` step fail before a write, but a fetch step runs. A started clone step, connect step, or `reuse` checkout step sets `connected`, which is an effect. So the update ends `failed-with-effects` when one of these steps started (contract §12 "Refusals"). It ends `failed` with `GIT_FAILED` only when no row has the `fetched`, `connected`, or `registered` flag. A row that fetches first still gets `fetched`.

**S39. The binding of two reviews of one unchanged repository.**

- F27 `base` at commit `8c2f489`. One service session reviewed the superproject twice through `reviewSubmodules`. The probe wrapped `createApprovals` with `mock.module` and recorded the binding of each submodule approval.
- Both reviews succeeded with the `clone` rows `mid` and `solo` and no program. Each review gave other row IDs.
- The `review` hashes were equal (`f5e14a84…`). The `programs` hashes differed (`f86a7521…` and `63d37f86…`). The trust views were equal (`untrusted`).
- Cause: the program inputs hold one `[row ID, listing fingerprint]` entry for each row, and the row ID is random (`src/git-service/submodule-review.ts` `ownerKey`). F27 `base` has no nested row, so `parentRowId` did not change the `review` hash here.
- So a preflight that reviews again gives `STALE_REVIEW` for every repository with a row.

**S40. Bun `test.todo` with `--todo`.**

- A file held two `test.todo` cases. One body failed an `expect`, and one body passed.
- `bun test` ran no body. It reported 2 todo cases and exited 0.
- `bun test --todo` ran both bodies. The failed body printed its error and counted as todo. The passed body counted as a failure with "this test is marked as todo but passes". The run exited 1.
- `bun test --todo -t <name>` ran only the matching body, with the same results: exit 0 for the failed body, and exit 1 for the passed body.
- So `--todo -t` runs a `todoCase` body. A green body shows as a failure that names the todo mark. A red body shows its error, and the run exits 0.

### Security notes

- CVE-2024-32002: recursive clones on case-insensitive file systems with symbolic links could run code. The advisory GHSA-8h77-4q3w-gfgv lists fixed versions 2.45.1, 2.44.1, 2.43.4, 2.42.2, 2.41.1, 2.40.2, and 2.39.4. Git for Windows `2.55.0.windows.3` and the distro floor 2.55.0 both contain the fix.
- CVE-2025-48384: broken configuration quoting of a submodule path could run code. The advisory GHSA-vwqx-4fm8-6qc9 lists fixed versions 2.43.7, 2.44.4, 2.45.4, 2.46.4, 2.47.3, 2.48.2, 2.49.1, and 2.50.1. Both admitted Git floors contain the fix.
- A distro package can backport fixes without a version change. The floor compares versions only, so a backport never admits an older Git.
- Defense in depth: the run confirmation lists submodule programs before any runs. Git's protocol defaults block `ext` and unrequested `file` transports.

### Credential helpers

- `GIT_TERMINAL_PROMPT=0` makes Git fail instead of prompting on a terminal (Git `Documentation/git.adoc`).
- Git Credential Manager reads `GIT_TERMINAL_PROMPT` for its terminal prompts only. Its GUI prompts follow `GCM_GUI_PROMPT` or `credential.guiPrompt`, and `GCM_INTERACTIVE` turns off all interaction (GCM `docs/environment.md`; DeepWiki answer on `IsTerminalPromptsEnabled`). So its sign-in window can still appear. The app sets none of these GCM values.
- Unverified: the SSH prompt failure without a console. No SSH server was available. T224 and T237 run it when a test SSH server exists, and record `unverified` otherwise. S17 showed that a direct native passphrase read fails at once, and that one under `sh` waits. S24 showed that such a wait does no I/O, so the stall notice detects it.

### Consequences and open items

- Contract §12 holds the protocol, and FR-047 to FR-054 and SC-017 hold the requirements. F27 to F31, T220 to T238, T253 to T257, T261, and T262 hold the tests.
- Speed: network time has no Git Extensions comparison and no budget. The SC-005 input and stall budgets still apply while the update runs. T167 measures them as stall workload 9 during F30 clones, with 100 counted typing and navigation actions.
- Closed item, 2026-10-01: contract §6 "Console and input" now starts every Git for Windows process without a console. Git without a console starts each child with `DETACHED_PROCESS` (compat/mingw.c:2247-2263). Every policy sets `GIT_TERMINAL_PROMPT=0`, and each stdin pipe closes after its input. T027 and T162 test a hook that waits for terminal input. Open at that time: a WSL hook outside `network` mode kept the hidden terminal. Closed later on 2026-10-01: every wrapper mode uses `setsid --wait` (contract §11 "Process launch"). Reopened later on 2026-10-01 by S17 (below).
- Closed item, 2026-10-01, by a design decision: Git 2.55 offers `extensions.submodulePathConfig`. It places each submodule Git directory by `submodule.<name>.gitdir`, not under `modules/<name>` (git-config(1)). Contract §12 assumes the default layout for `reuse` rows and the kept-directory walk. Under the extension, the review can miss the programs of a kept Git directory. Decision: `reviewSubmodules` refuses with `UNSUPPORTED_SUBMODULE` reason `gitdir-config`. The refusal applies when the extension is enabled or any `submodule.<name>.gitdir` is set. The remedy runs the update in a terminal. FR-049, contract §9 and §12, data-model §9, an F29 variant, and T223 carry the rule. No real-Git run has verified the refusal yet.
- Unverified: every WSL row, because the reference distro has Git 2.43.0. Also the SSH prompt failure, a real credential helper window, and packaged behavior.
- Reopened item, 2026-10-01: the console rule holds only for programs that Git starts directly. Under a hook, a native console read waited until the kill (S17). Contract §6 now states the real bound: the deadline of the operation. The stall notice shows the wait before that deadline (S24).
- Closed item, 2026-10-01, by a user decision: a `core.sshCommand` with arguments to Windows OpenSSH waits on an invisible console. After 15 seconds without activity, the status shows the stall notice with Cancel and a terminal command. The 300-second limit stays as the backstop. The same notice covers commit hooks. Contract §6 "Activity and stall notice", FR-019, FR-051, F11, F30, T027, T162, T224, T225, and T255 to T257 carry it.
- Closed item, 2026-10-01, by a user decision: the S15 rule refused a common state. The update now fetches first, checks HEAD and every ref again, and checks out with `--no-fetch` (S20). Contract §12 "Update protocol", FR-047, FR-049, F28, T222, T223, and T230 carry it.
- Unverified: the stall notice in the packaged shell, and the WSL wrapper value `GIT_PROTOCOL_FROM_USER=0`. Also the fallback remote rule for a relative `.gitmodules` URL (T253, T232).
- Design limit: a `reuse` row can skip the fetch of Git's own update. This happens when its kept Git directory holds the target without a ref. Its connect step checks out at once. A skipped fetch cannot remove a ref.
- Unverified: the Job I/O signal in the packaged shell, and the WSL CPU-time sum during a real fetch (T225, T232).
- Closed item, 2026-10-01: the first fetch of a row recursed into nested submodules on demand (S25). Both fetch steps now pass `--no-recurse-submodules`. Contract §12, plan.md, T223, and T227 carry it.
- Closed item, H1, 2026-10-01: the fetch inside a clone step recursed into a nested kept Git directory (S27). Every clone step now passes `-c fetch.recurseSubmodules=no`. Recorded difference: hooks see that value through `GIT_CONFIG_PARAMETERS`, so a hook's own fetch does not recurse.
- Closed item, H1, 2026-10-01: a WSL Job ignores its `IO_COUNTERS`, because the anchor exchange changes them (S29). Unverified: the anchor CPU-time sum during a real WSL fetch (T225, T232).
- Unverified, H1: PowerShell versions other than 7.6.6 and 5.1.26100.9444 (S28). The quoting rule refuses U+201C to U+201E and control characters by the stricter reading. S28 kept them literal.
- Unverified, verification remediation: PowerShell versions other than 7.6.6 and 5.1.26100.9444 for trailing `\` (S34). Also a UNC share root as a command path, and `\` through `wsl.exe`. The rule refuses a trailing `\` without white space by the stricter reading, and S34 kept it literal.
- T261, 2026-10-03: pwsh 7.6.6 and Windows PowerShell 5.1.26100.9444 each passed 66 parser checks and 68 argument checks, with Git 2.55.0.windows.3. The T065 run printed the same results.

Sources: [submodule--helper update strategy](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/submodule--helper.c#L2107-L2147), [initialization active key](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/submodule--helper.c#L596-L597), [current revision failure](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/submodule--helper.c#L2834-L2838), [GIT_PROTOCOL_FROM_USER](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/git-submodule.sh#L29-L30), [detached ssh](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/compat/mingw.c#L2251-L2261), [progress counter](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/progress.c#L134), [protocol policy](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/config/protocol.adoc), [environment variables](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git.adoc), [RelNotes 2.45.0](https://github.com/git/git/blob/master/Documentation/RelNotes/2.45.0.adoc), [GHSA-8h77-4q3w-gfgv](https://github.com/git/git/security/advisories/GHSA-8h77-4q3w-gfgv), [GHSA-vwqx-4fm8-6qc9](https://github.com/git/git/security/advisories/GHSA-vwqx-4fm8-6qc9), [GCM environment](https://github.com/git-ecosystem/git-credential-manager/blob/main/docs/environment.md), [submodule fetch](https://github.com/git/git/blob/v2.55.0/builtin/submodule--helper.c#L2644-L2665), [submodule default remote](https://github.com/git/git/blob/v2.55.0/builtin/submodule--helper.c#L77-L115), [default remote](https://github.com/git/git/blob/v2.55.0/remote.c#L666-L680), [fetch.all](https://github.com/git/git/blob/v2.55.0/builtin/fetch.c#L2700-L2720), [nested Git directory refusal](https://github.com/git/git/blob/v2.55.0/submodule.c#L2402-L2442).

## R15. Frontend bundler comparison: Bun and Vite (T313)

**Purpose**: Compare Bun's bundler with `bunx --bun vite build` for `src/frontend`, without a change to any build input.

**Recommendation (2026-10-05)**: Keep Vite. Bun 1.4.2 does not rewrite a `new Worker(new URL(…, import.meta.url))` URL. Without a second entry point, Bun emits no worker file. With one, the page still requests the `.ts` source. So Bun fails R9. A worker runs only when the build lists it as an entry with a fixed output name. `bun-plugin-tailwind` `0.1.2` holds Tailwind `4.1.14`, not the locked `4.3.3`. Under matching conditions, the Bun build was 380.3 ms faster without the probe and 230.7 ms faster with it. That gain does not outweigh these failures. Look at a switch again only when Bun bundles worker modules and the plugin follows the locked Tailwind version.

### Method

- Checks 1 and 2 are build time and output size.
- Commit `9960120`. Each trial ran in a copy from `git archive 9960120`, after `bun install --frozen-lockfile`. The repository stayed unchanged.
- Host: Linux cloud container, `x86_64`, Ubuntu 24.04.4, kernel 6.18.44, 4 vCPU Intel Xeon at 2.10 GHz, 16 GB. These are not Windows numbers.
- Vite: `build:frontend` from the repository, which runs `bunx --bun vite build` with the repository `vite.config.ts`.
- Bun: in the Bun copies only, `build:frontend` runs `bun build-bun.ts`. That script calls `Bun.build({ entrypoints: ["./src/frontend/index.html"], outdir: "./dist", target: "browser", format: "esm", splitting: true, minify: true, sourcemap: "none", jsx: { development: false }, define: { "process.env.NODE_ENV": "\"production\"" }, plugins: [bun-plugin-tailwind], metafile: true })`. The Bun CLI accepts no plugins, so the API is necessary (`bun-types` `1.4.2`, `docs/bundler/html-static.mdx`).
- Timing: both ways ran as `bun run build:frontend`, with `BUN_OPTIONS` unset. A Bun driver measured the wall clock of that process with `performance.now()`. One warm-up run was discarded, then 5 runs followed. Before each run, the driver deleted `dist`, `node_modules/.vite`, `node_modules/.cache`, and `node_modules/.vite-temp`. `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` turned off Bun's transpiler cache for both ways.
- Sizes: bytes on disk. Gzip bytes come from zlib level 9.
- Probe: the checks 3 to 6 used one probe, identical in both copies. It adds `src/frontend/probe/`: a worker, a shared module, a lazy module, and a Tailwind component. `main.tsx` imports `./index.css` and two `@/probe/…` modules. At `9960120`, no module imports `index.css`, so the unchanged build emits no CSS.
- Vite facts came from `generateBundle` in the main and worker builds, and from `this.resolve`. Bun facts came from the metafile. The oxc parser (`rolldown/parseAst`) parsed each output as a module. Headless Chromium `141.0.7390.37` (Playwright `1.56.1`) loaded each output from a local static server.
- The raw logs and scripts stayed in the session scratch directory. They were not kept.

### Versions

| Item | Version |
| --- | --- |
| Bun | `1.4.2` (`/usr/local/bin/bun`) |
| `vite` / `rolldown` | `8.3.2` / `1.2.12` (`bun.lock`; `package.json` `^8.3.1`). R9 names Rolldown `1.2.9`. |
| `@vitejs/plugin-react` | `6.1.1` |
| `tailwindcss`, `@tailwindcss/vite`, `@tailwindcss/oxide` | `4.3.3` |
| `lightningcss` | `1.33.0` and `1.32.0` |
| `react`, `react-dom` | `19.3.0` |
| `bun-plugin-tailwind` (trial only) | `0.1.2`, the `latest` tag, published 2025-10-09. Its `index.mjs` embeds the `tailwindcss` manifest version `4.1.14` (`index.mjs:26264-26265`). Its Oxide manifests also give `4.1.14` (from `index.mjs:11614`). The output banner also shows `v4.1.14`. Its peer dependency added `bun@1.4.2` and twelve `@oven/bun-*@1.4.2` platform packages to the trial lock. |
| shadcn CLI | `4.21.0` through `bunx --bun shadcn@4.21.0`. `bun.lock` resolves the `shadcn` dev dependency to `4.21.1`. |

### Build time (Linux cloud container)

| Build | Runs (ms) | Median (ms) |
| --- | --- | --- |
| Vite, `9960120` unchanged | 546.3, 507.5, 640.9, 498.9, 546.5 | 546.3 |
| Bun, `9960120` unchanged | 157.2, 170.8, 165.0, 166.0, 176.5 | 166.0 |
| Vite, with probe | 531.5, 545.9, 478.9, 468.7, 525.4 | 525.4 |
| Bun, with probe | 273.6, 322.8, 268.6, 294.7, 306.3 | 294.7 |

### Output

| Build | Files: bytes (gzip) | Total bytes |
| --- | --- | --- |
| Vite, unchanged | `assets/index-CdaoxUVW.js` 226,336 (70,230); `index.html` 319 | 226,655 |
| Bun, unchanged | `chunk-18w0n4nh.js` 220,248 (68,743); `index.html` 313 | 220,561 |
| Vite, with probe | `assets/index-CFph830q.js` 227,005 (70,555); `assets/index-CqW2oqFI.css` 5,418 (1,928); `assets/probe.worker-DRYppA-N.js` 212 (183); `assets/probe-lazy-guDQre9Z.js` 48 (66); `index.html` 393 | 233,076 |
| Bun, with probe | `chunk-kmwn20qd.js` 220,876 (69,072); `chunk-1bqhmsnr.css` 18,285 (4,362); `index.html` 376 | 239,537 |

Vite writes asset URLs from `/`. Bun writes them relative to the page (`./`).

### Results

| Check | Vite | Bun |
| --- | --- | --- |
| 3. ES worker chunks (R9) | Pass. The worker build ran with format `es`. Its entry chunk holds `probe.worker.ts` and the shared module. It imports `probe-lazy` on demand. The page calls `new Worker(new URL("/assets/probe.worker-DRYppA-N.js", "" + import.meta.url), { type: "module" })`, and that file exists. No chunk calls `new Blob` or `createObjectURL`. In Chromium, the worker ran from that file and posted the expected value. All requests stayed on the page origin. | Fail. The metafile shows no import from `start.ts`, and Bun emits no worker file. The output keeps `new URL("./probe.worker.ts", import.meta.url)`. Chromium got HTTP 404 for `/probe.worker.ts`, and the worker failed. A second trial added the worker as an entry point. The Bun documentation gives this step for executables. Bun then emitted `probe/probe.worker.js` and its chunks as ES modules. The page still requested `./probe.worker.ts`, and Chromium got HTTP 404 again. Bun states: "We may eventually detect statically-known paths in `new Worker(path)` and bundle them automatically" (`bun-types` `1.4.2`, `docs/bundler/executables.mdx`). |
| 3. Worker with a fixed name (extra trial) | The same source change still builds with Vite. Vite resolved `./probe.worker.js` to `probe.worker.ts` and emitted the same files with the same hashes. | A third trial set `naming.entry` to `[name].[ext]` and changed the source URL to `./probe.worker.js`. Bun emitted `probe.worker.js`, and the worker ran in Chromium and posted the expected value. The source then names a Bun output path. Each worker must also be a listed entry in the build script. |
| 4. Tailwind v4 | Pass. The banner shows `v4.3.3`, and no `@import` remains. The output has 12 theme variables and 13 utility rules, one for each probe class. | Fail. The CSS compiles: no `@import` remains, and Chromium computed the same probe styles as in the Vite build. But the compiler is Tailwind `4.1.14` (see Versions). The output has 34 theme variables and 121 utility rules. All 13 Vite utility rules are present. Their declarations are equal when whitespace tokens are ignored. With `root: "./src/frontend"`, the output has 14 theme variables and 38 utility rules. The plugin scans from `build.config.root` or `process.cwd()` (`index.mjs:40935`). It also reads candidates from each non-CSS module that Bun parses (`index.mjs:40948-40951`). The Vite plugin scans the Vite root only. Which file gave each extra candidate is not proven (open). |
| 5. React JSX | Pass. The module graph holds `react-jsx-runtime.production.js`, `react.production.js`, and `react-dom-client.production.js`, and no development file. The AST has no `jsxDEV`. Its only `process` member references are `process.emit`. | Pass, with the same facts from the metafile and the AST. |
| 5. Render in Chromium (with check 5) | The probe component rendered. Without the Tauri host, the app stayed at its "Loading…" fallback. No page error. The only console error is a 404 for `http://localhost:4331/favicon.ico`. | The probe component rendered. The app stayed at the same fallback. No page error. The only console error is a 404 for `http://localhost:4332/favicon.ico`. The worker request for `/probe.worker.ts` also got HTTP 404. |
| 6. `@` alias | Pass. `this.resolve` gave `src/frontend/probe/start.ts`, `ProbeView.tsx`, and `probe-shared.ts`, and each importer's graph holds them. Source: `resolve.alias` in `vite.config.ts`. | Pass. The metafile maps the same three specifiers to the same three files. Source: `paths` in `tsconfig.json`. |
| 7. shadcn generator | Open. Exit 1 on the unchanged copy. Message: "You are not authorized to access the item at https://ui.shadcn.com/init?…". A separate `curl https://ui.shadcn.com/` got HTTP 403 from the cloud proxy on CONNECT. No file changed, and `bun run build:frontend` then exited 0. | Open. The copy had no `vite.config.ts`, no Vite packages in `package.json` or `bun.lock`, and `types: ["bun"]`. Exit 1 with the same message. No file changed, and `bun build-bun.ts` then exited 0. Without `vite.config.*`, shadcn `4.21.0` sets the framework to `manual`, not `vite` (`dist/chunk-B2MD6U5O.js`). |

`components.json` does not exist at `9960120`. T123 added it later, in `f1f5658`. So the check of its paths is open.

### Dev-dependency delta of a switch

- Removes: `vite` `^8.3.1` (`8.3.2`), `@vitejs/plugin-react` `^6.1.1` (`6.1.1`), and `@tailwindcss/vite` `^4.3.3` (`4.3.3`).
- `bun.lock` loses 72 entries. Among them are `rolldown` `1.2.12` and 15 bindings. Also `@tailwindcss/node` and `@tailwindcss/oxide` `4.3.3` with their platform packages. Also `lightningcss` `1.32.0` and `1.33.0` with their platform packages.
- Adds: `bun-plugin-tailwind` `0.1.2`. `bun.lock` gains 14 entries: the plugin, `bun@1.4.2`, and twelve `@oven/bun-*@1.4.2` packages.
- Keeps: `tailwindcss` `4.3.3`. Without it, the Bun build failed: "Can't resolve 'tailwindcss'". So Tailwind `4.1.14` code would compile the `4.3.3` CSS entry.
- Other changes: removal of `vite.config.ts`, and `vite/client` out of the `tsconfig.json` types. Also a build script file for `Bun.build` and a new `build:frontend` script.
- Nothing else needs Vite. The repository has no Vitest. `bun run dev` runs `bun run build`, then `cargo tauri dev --no-dev-server`. `tauri.conf.json` names no dev URL, and its `beforeBuildCommand` runs `bun run build`. Both use only the `build:frontend` script name. Only the shadcn framework detection and the R9 text ("Use a Vite worker factory") name Vite.

### Open for Windows

- Packaged load of the build output through the Tauri `build.frontendDist` in WebView2 (T008), with the probe worker.
- Clean build time on the Windows reference host, as the median of 5 runs, for each way.
- The shadcn check with `bunx --bun shadcn@4.21.0 init --base base --preset mira --yes`, on a host that reaches `ui.shadcn.com`.
- The `components.json` path check. T123 added the file in `f1f5658`, after this comparison.

**Closing decision** (main session, 2026-10-05): The four open checks above do not run. The Bun way already fails the R9 worker rule, so no switch follows. The packaged Vite build is already qualified through T008. Open this comparison again only when a Bun release bundles worker modules and the Tailwind plugin follows the locked Tailwind version. The R15 recommendation stays unchanged.

Sources: the Bun documentation in `bun-types` `1.4.2` (`docs/bundler/html-static.mdx`, `docs/bundler/executables.mdx`), the `bun-plugin-tailwind` `0.1.2` file `index.mjs`, the `@tailwindcss/vite` `4.3.3` file `dist/index.mjs`, [bun-plugin-tailwind 0.1.2](https://registry.npmjs.org/bun-plugin-tailwind/0.1.2), [Tailwind Vite plugin 4.3.3](https://registry.npmjs.org/@tailwindcss/vite/4.3.3). The raw logs and scripts stayed in the session scratch directory. They were not kept.
