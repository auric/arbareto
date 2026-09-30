# Research: Windows Desktop Qualification

**Date**: 2026-09-28 | **Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

**Evidence level**: Source inspection and read-only host inventory. It also includes Git-behavior probes in throwaway repositories (R2, R4, R5) and a Rust link probe outside the repository (R6). No application build, installer test, mutation test, or performance measurement has run.

## R1. Scope decision

**Decision**: Keep Tauri-only implementation. Compare Electrobun through source research only.

**Rationale**: The initial two-adapter request conflicted with constitution 1.0.0 and the selected specification. The user selected “Keep Tauri-only implementation” after the scope question.

**Alternatives considered**: A bounded constitutional amendment, or stopping with a feature-only blocked plan. Neither was selected.

One React frontend, one Bun Git service, and shared contracts remain planned. Only one thin Tauri shell is authorized. No generic desktop abstraction, Electrobun prototype, or second product is authorized.

The brief supplies hypotheses, not qualification evidence. Release assets establish distribution artifacts, not working Arbareto behavior. Source inspection establishes implementation facts, not packaged correctness or speed.

## R2. Git baseline, parsing, and identity

**Decision**: Use the explicitly selected installed Git for Windows executable. The initial qualification candidate is `2.55.0.windows.3`.

**Rationale**: The installed executable reports build revision `52ca1113d651127f89477a8763f86ab20f645e1d`. Its exact source supports the inspected protocols.

**Alternatives considered**: Bundled Git, libgit2, and a custom Git implementation. They add distribution or semantic differences without a qualification requirement.

The observed executable is `C:/Git/cmd/git.exe`. This machine observation is not a fixed path requirement. Git is GPL-2.0 licensed and is not redistributed by this feature.

### Machine-readable reads

- Use `status --porcelain=v2 -z --branch --untracked-files=all` with `--no-optional-locks`, `--ignore-submodules=dirty`, and explicit rename detection.
- Parse NUL-delimited bytes. Handle ordinary, rename, unmerged, untracked, and ignored record forms.
- Read fixed fields before pathname bytes. Rename records contain destination and original paths as separate records.
- Preserve both index and worktree status. Do not merge staged deletion and untracked replacement into one entry.
- Treat incomplete records, overflow, and process failure as incomplete results, never empty success.
- Anchor history to a captured full commit OID. Use `rev-list --parents --max-count=100 --date-order` without path filters.
- Use Git's effective parent relationships and child-before-parent order. Never parse ASCII graph artwork or infer branches from dates.
- Apply `--no-lazy-fetch` and `--no-optional-locks` to history/object reads. Missing objects do not authorize network access.
- Read commit objects through `cat-file --batch-command -Z`, using object type and byte length framing.
- Uppercase `-Z` terminates input and output. Lowercase `-z` is not an equivalent output protocol.
- Bound commit objects before reading their content. Render author and subject text without interpreting markup.

Sources: [status format and optional locks](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-status.adoc), [cat-file framing](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-cat-file.adoc#L143-L175), [NUL options](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-cat-file.adoc#L266-L275).

### Repository identity

Resolve the working root, worktree Git directory, common directory, actual index, and operation markers through Git.

Use `--show-toplevel`, `--absolute-git-dir`, `--git-common-dir`, and `--git-path index`. Request absolute paths where supported.

**Decision**: Discovery never runs `rev-parse --shared-index-path`. That option calls `repo_read_index` (rev-parse.c:1097-1106). An index load can run a command-valued `core.fsmonitor`, and `restoreWorkspace` runs discovery at launch before trust approval. The service derives split-index state from the raw index bytes instead. The `link` extension holds the shared-index hash, and the file is `$GIT_DIR/sharedindex.<hash>` (gitformat-index.adoc:249-261). `read_index_from` builds that path from the worktree Git directory (read-cache.c:2384).

A Git-behavior probe on 2026-09-30 used Git `2.55.0.windows.3` in a throwaway repository. It used an owned global configuration and `GIT_CONFIG_NOSYSTEM=1`. Local canaries covered command-valued `core.fsmonitor` and clean, smudge, and process filters on a stat-dirty file. They also covered `diff.<driver>.textconv`, `core.pager`, `core.editor`, `core.askPass`, `core.sshCommand`, and `credential.helper`. They also covered the four signing keys, one configured hook, and 28 traditional hook names. No canary ran for these `rev-parse` queries: `--is-bare-repository --is-inside-git-dir`, `--show-toplevel`, `--absolute-git-dir`, and `--git-common-dir`. The same held for `--git-path index`, `--show-object-format`, `--show-ref-format`, and `--git-path hooks`. No canary ran for `symbolic-ref -q HEAD` or `show-ref --head --verify HEAD`. None ran for `config list --show-scope --show-origin -z` or `hook list -z --show-scope`. `rev-parse --shared-index-path` ran the monitor canary twice, also with `--no-optional-locks`. `ls-files -z` did the same.

A second probe ran `update-index --split-index` in a repository and in its linked worktree. Each index then held a `link` extension. Its hash named `sharedindex.<hash>` in the Git directory of that worktree. That path equals the `--shared-index-path` output. These probes are not qualification evidence, and no Arbareto build ran.

Split-index sources: [rev-parse index load](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/rev-parse.c#L1097-L1106), [link extension](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/gitformat-index.adoc#L249-L261), [shared index path](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/read-cache.c#L2384).

Use `--is-bare-repository` and `--is-inside-git-dir` before registration. Either true result refuses the folder with `UNSUPPORTED_REPOSITORY`.

A folder outside every repository fails that first query. Discovery stops at the file system root or at a mount point. Then `setup.c` dies with one of two messages (setup.c:2004-2015). The first is "not a git repository (or any of the parent directories)". The second is "not a git repository (or any parent up to mount point". `die` prints the prefix `fatal: ` and exits with status 128 (usage.c:74, :87). A `.git` file with a missing target dies with "not a git repository: <path>" instead (setup.c:940). So the prefix `fatal: not a git repository (or any` under the fixed C locale separates `NOT_A_REPOSITORY` from the missing-target case, which stays `REPOSITORY_UNAVAILABLE`. No probe ran this case; T068 verifies it.

Refusal sources: [discovery refusal](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/setup.c#L2004-L2015), [gitfile refusal](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/setup.c#L940), [die prefix and status](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/usage.c#L74-L87).

Keep worktree identity separate from common-directory identity. Resolve physical directory identity after Git discovery. Windows junctions must not create separate mutation exclusion groups.

Record `--show-object-format` and `--show-ref-format`. Do not hardcode SHA-1 lengths or an empty-tree hash.

Record both HEAD's symbolic target and resolved OID. A same-OID branch change still invalidates checkout approval. Distinguish an unborn branch from a failed lookup.

**Decision**: The shell supplies every physical identity. It reads the 64-bit volume serial number and the 128-bit file ID through `GetFileInformationByHandleEx` with `FileIdInfo`. The service requests identities for Git-resolved paths through the contract §6 identity request.

Bun `fs.stat` calls libuv `uv_fs_stat`. On Windows 11 24H2 and later, libuv uses `GetFileInformationByName` with `FileStatBasicByNameInfo`. It sets `st_ino` from the 64-bit `FileId` and ignores `FileId128`. Older builds use `FileInternalInformation`, which also holds only the 64-bit ID. Both paths set `st_dev` from the low 32 bits of the volume serial number.

The 64-bit ID is not a safe identity. ReFS maps only a subset of 128-bit IDs to 64 bits and sets the others to −1. FAT, FAT32, and exFAT generate 64-bit IDs that are neither stable nor unique. The 128-bit ID is stable and unique on NTFS and ReFS. MS-FSCC reserves all zeros for "not supported" and all ones for "cannot be established".

Refusing the 64-bit sentinel alone would exclude Dev Drive repositories. It would still miss FAT and exFAT, because Bun cannot read the file system type. `bun:ffi` could read `FileIdInfo`, but Bun marks it experimental and not for production. Tests may use it as a test double.

A probe on 2026-09-29 used Bun `1.4.2` on the reference host (NTFS). `fs.stat` gave `dev` `0x74214650`, and `FileIdInfo` gave serial `0x4474215074214650`. The low 64 bits of the 128-bit ID equaled `ino`. A junction alias gave the same `FileIdInfo` identity as its target. No ReFS volume was available, so ReFS and Dev Drive stay unverified.

Identity sources: [Bun Windows stat](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/sys/lib.rs#L3694-L3695), [Bun uv_fs_stat call](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/sys/sys_uv.rs#L506-L509), [libuv volume serial](https://github.com/oven-sh/libuv/blob/8023581113b276e7c1aee3f82da57ca0893faab1/src/win/fs.c#L1806-L1827), [libuv st_dev](https://github.com/oven-sh/libuv/blob/8023581113b276e7c1aee3f82da57ca0893faab1/src/win/fs.c#L1871), [libuv st_ino](https://github.com/oven-sh/libuv/blob/8023581113b276e7c1aee3f82da57ca0893faab1/src/win/fs.c#L1934), [64-bit file ID on ReFS](https://learn.microsoft.com/windows/win32/api/fileapi/ns-fileapi-by_handle_file_information), [FILE_ID_INFO](https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-file_id_info), [MS-FSCC file ID behavior](https://learn.microsoft.com/openspecs/windows_protocols/ms-fscc/d4bc551b-7aaf-4b4f-ba0e-3a75e7c528f0), [libuv fast stat path](https://github.com/oven-sh/libuv/blob/8023581113b276e7c1aee3f82da57ca0893faab1/src/win/fs.c#L1729-L1765), [libuv slow stat path](https://github.com/oven-sh/libuv/blob/8023581113b276e7c1aee3f82da57ca0893faab1/src/win/fs.c#L1767-L1830), [FILE_STAT_BASIC_INFORMATION](https://learn.microsoft.com/windows-hardware/drivers/ddi/ntifs/ns-ntifs-file_stat_basic_information), [64-bit file ID sentinels](https://learn.microsoft.com/openspecs/windows_protocols/ms-fscc/2d3333fe-fc98-4a6f-98a2-4bb805aff407), [128-bit file ID sentinels](https://learn.microsoft.com/openspecs/windows_protocols/ms-fscc/98860416-1caf-4c80-a9ab-8d61e1ccf5a5), [bun:ffi status](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/docs/runtime/ffi.mdx).

Sources: [path and format discovery](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-rev-parse.adoc#L246-L335), [worktree sharing](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-worktree.adoc), [reference lookup results](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-show-ref.adoc#L75-L79), [unborn staged diff](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-diff.adoc#L45-L55).

## R3. Selected hunk design: protected index publication

**Decision**: Use a protected candidate index with exact verification and explicit validation checkpoints. The former B-HUNK design blocker is resolved by this supported profile, not by claiming repository-wide atomicity.

**Rationale**: Git applies the patch; the service verifies the exact candidate before canonical index publication. Supported operations do not write working-file content.

**Alternatives considered**: Renderer patches, whole-file staging, direct live-index patching, and three-way fallback. None provides the selected-hunk publication guarantee.

### Supported profile

Support ordinary full indexes and the specified UTF-8 LF/CRLF text cases. Refuse sparse/split indexes until separately qualified. The raw `link` extension identifies a split index (R2).

Refuse any registered `post-index-change` hook and any executable filesystem-monitor integration for hunk mutations. Refuse custom filters, LFS, encoding conversion, unsupported entry types, conflicts, unfinished operations, and incomplete observations.

`git hook list` includes disabled configured registrations. Initially refuse every `post-index-change` registration rather than infer an executable subset incorrectly. Ordinary commit hooks do not trigger this refusal unless they also register an index-change event.

Refusal does not bypass a hook or change configuration. Trust approval alone does not make an index-change hook safe for exact hunk publication.

`core.fsmonitor=true` enables Git's built-in daemon, not a repository-defined command. Reads run with it from any scope. Hunk actions refuse it as an unqualified monitor profile. When no daemon runs, a command that loads the index runs `git fsmonitor--daemon start`. That command starts `fsmonitor--daemon run --detach` as a background child. Git for Windows creates children without a breakaway flag. A child joins its parent's Job by default, and the Arbareto Jobs forbid breakaway. So the daemon is an owned descendant of the read's operation Job, and Job close ends it. This is source reasoning. T153 checks it in the packaged build (unverified).

Monitor sources: [built-in daemon setting](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/config/core.adoc#L64-L66), [daemon spawn](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/fsmonitor-ipc.c#L58-L70), [spawn on missing daemon](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/fsmonitor-ipc.c#L111), [background start](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/fsmonitor--daemon.c#L1511-L1546), [Windows process creation flags](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/compat/mingw.c#L2247-L2270).

### Publication protocol

1. Capture the complete index, checkout identity, selected raw/normalized content, attributes, configuration, trust, and operation state.
2. Retain Git-generated canonical patch data in the service. Give the renderer opaque hunk identifiers only.
3. Enter application mutation exclusion for the resolved common directory.
4. Exclusively create the canonical index's Git-resolved lock. Refuse existing locks; retain ownership and file identity.
5. Revalidate the complete approval and supported profile while holding that lock.
6. Copy the index into an owned private index beside it. Create an absent empty candidate through Git without creating a canonical index.
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
- The installed build has no test barrier. T161 triggers the late write on the step 13 index replacement (T141 `--late-write`). So the write always follows step 11. Reconciliation can read the file before or after that write. T161 records the branch that ran. T097 covers the `completed-with-effects` branch in process. Whether Bun `fs.watch` on Windows reports the rename to `index` is unverified; T161 records it.

No mutation fixture has run. This is an implementable design with mandatory proof cases, not a runtime pass.

Additional sources: [hook registrations include disabled entries](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/hook.c#L72-L107), [index loading and fsmonitor](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/fsmonitor.c#L792-L811).

Sources: [lock protocol](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/lockfile.h#L5-L31), [Windows replacement behavior](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/compat/mingw.c#L3003-L3150), [apply modes](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-apply.adoc#L60-L95), [apply locking](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/apply.c#L4945-L4963), [hunk relocation](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/apply.c#L3138-L3202), [index-write hook](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/read-cache.c#L3149-L3160), [reference transactions](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-update-ref.adoc).

## R4. Selected commit design: standard Git handoff

**Decision**: Use ordinary canonical `git commit --file=-` after immediate full preflight. The user explicitly selected Standard Git through `/speckit-clarify` on 2026-09-28.

**Rationale**: Approval authorizes normal Git execution against the freshly reviewed scope, not an immutable-tree transaction. Approved hooks and late external changes can affect execution.

**Alternatives considered**: Private-index commits, plumbing reconstruction, injected transaction hooks, and the previous exact-snapshot promise. Private-index commits add separate index/reference publication and risk hiding hook-produced staging. Injected hooks change the effective hook set. None is selected.

### Preflight and handoff

Review stays read-only. Retain complete staged scope and a bounded index snapshot without `write-tree` or trial commits. Compare the eventual commit tree against that retained snapshot through read-only Git inspection; no preview tree write is required.

1. Enter application mutation exclusion for the common directory.
2. Obtain the canonical index lock for final validation, refusing foreign locks.
3. Compare the complete reviewed index, checkout target/OID, operation state, configuration, trust, and complete staged scope.
4. Validate the message and consume its one-use review token only after successful checks.
5. Refuse every detected mismatch and require renewed review.
6. Release the preflight lock, then start exactly one ordinary `git commit --file=-` against the canonical index.
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

Hook output never reaches the interface (R5). So `HOOK_FAILED` and a commit `GIT_FAILED` carry a remedy command that reruns the commit in a terminal (contract §9). The command uses the selected Git executable and the worktree root, and never the message.

A Git-behavior probe on 2026-09-30 ran `git commit --file=-` in throwaway repositories with canary programs. A plain commit ran `pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-index-change`, and `post-commit`. It ran `reference-transaction` with `preparing`, `prepared`, `committed`, and `aborted`. It also ran a command-valued `core.fsmonitor`. With `gpg.format=ssh`, `commit.gpgsign=true`, and no `user.signingKey`, Git ran `gpg.ssh.defaultKeyCommand`. With a `key::` signing key, it ran `gpg.ssh.program`. With `gpg.format=x509`, it ran `gpg.x509.program` and not `gpg.program`. `gpg.openpgp.program` took precedence over `gpg.program`. `gpg.program` ran when it was the only signing key. Each signing program ran after the `commit-msg` hook. `gpg.adoc` lists no other command-valued key. `gpg.ssh.allowedSignersFile` and `gpg.ssh.revocationFile` name files for verification only. This probe is not qualification evidence.

Signing sources: [gpg configuration keys](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/config/gpg.adoc#L1-L47).

`git commit` updates HEAD and then runs `git maintenance run --auto`, with `--detach` by default. After that, it runs the `post-commit` hook. Git for Windows builds with `NO_POSIX_GOODIES`, so `daemonize()` fails. Maintenance then continues in the foreground. The commit process waits for it, and the 120-second commit deadline covers it. An interruption there leaves a created commit. Reconciliation classifies that result from observed state. This paragraph is source reasoning from the cited lines, not an observed run. T100 verifies it.

If T100 observes a detached maintenance process, the operation Job still contains it, because the Job forbids breakaway. Reconciliation reports the created commit and names observed maintenance files as foreign. The operation Job closes when the operation ends, and that ends the detached process (contract §4).

Open question: the maintenance duration on fixture L and the files that an interruption leaves are unverified. T100 probes them with local `gc.auto=1`.

Evidence sources: [trace2 child class](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/trace2/tr2_tgt_event.c#L339-L356), [trace2 event format](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/technical/api-trace2.adoc#L517-L541), [hook name](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/hook.c#L608), [GPG signing child](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/gpg-interface.c#L1011-L1020), [SSH signing child](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/gpg-interface.c#L1058-L1108), [trace2 target override](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/config/trace2.adoc#L15-L17), [HEAD update](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/commit.c#L1947), [maintenance and post-commit](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/commit.c#L1967-L1969), [auto maintenance](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/run-command.c#L1957-L1994), [MinGW build flag](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/config.mak.uname#L729), [daemonize](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/setup.c#L2233-L2237), [foreground fallback](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/gc.c#L1814-L1818).

### Resolution and constitutional boundary

The former B-COMMIT blocker is resolved through the explicitly approved consistency contract, not postchecks presented as prevention.

Constitution 2.0.0 remains unchanged by this design. Principles III/IV require fresh checkpoints, stale refusal, exact application hunk effects, and real assertions. They do not grant control over independent writers or promise immutable results from approved hooks.

Keep ordinary fixtures' exact index and unchanged-byte assertions. Controlled race fixtures verify checkpoint refusal or honest late-change outcomes, depending on the barrier.

No mutation, hook, cancellation, or Windows test has run. Those checks remain required before qualification.

Sources: [index lock release](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/commit.c#L482-L494), [post-hook index read](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/commit.c#L1101-L1135), [HEAD capture](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/commit.c#L1815-L1844), [reference update](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/sequencer.c#L1259-L1295), [transaction hook phases](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/refs.c#L2698-L2739), [configured hook ordering](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/hook.c#L546-L550).

## R5. Trust, cancellation, and external writers

**Decision**: Validate each operation at the service boundary. Serialize application mutations conservatively by common-directory identity.

**Rationale**: Application exclusion does not control external Git processes. Watchers are notifications, not transaction logs.

**Alternatives considered**: Per-path mutation queues, timestamp-only checks, unrestricted shell IPC, and PID-name termination. They cannot establish the required boundaries.

Git `2.55.0.windows.3` supports configured hook commands and events, including parallel execution settings. Trust discovery must inspect these settings, not only `.git/hooks` and `core.hooksPath`.

Use bounded `git hook list -z --show-scope` discovery for relevant events. Inspect conditional includes, worktree configuration, filters, signers, executable monitors, and diff tools.

Disable executable preview paths for inspection. Missing trust must block operations that could execute repository-controlled code. Custom filters remain unsupported for hunk mutation after approval.

A Git-behavior probe on 2026-09-29 used Git `2.55.0.windows.3` in throwaway repositories with canary commands. Without `--ignore-submodules=dirty`, `status --porcelain=v2` and `diff-files` started `git status --porcelain=2` inside each submodule. That child ran the submodule's own `core.fsmonitor` and clean filter. With the option, `status` and `diff-files -p` started no child, and status still reported a moved submodule commit. The probe also matched the contract §7 key table and the `i18n.commitEncoding` UTF-8 spellings. This probe is not qualification evidence, and no Arbareto build ran.

A second probe on 2026-09-29 used an owned global configuration and a throwaway repository. A global `core.hooksPath=.githooks` ran the committed `.githooks/pre-commit`. A global `hook.<name>.command=./tools/h.sh` ran the committed script. A global `filter.<driver>.clean=./tools/clean.sh` ran during `diff-files -p`. A global `core.fsmonitor=./tools/fsm.sh` ran during `status`. Each ran with the worktree root as its directory, also when Git started in a subdirectory. `rev-parse --git-path hooks` printed `.githooks` at the root and `../.githooks` in the subdirectory. `git hook list --show-scope` printed `hook from hookdir` without a path. This probe is not qualification evidence.

Limit: the classification covers the program that Git starts. A protected command such as `sh ./x.sh` can still run repository files through its arguments. Whether `sh` searches an empty `PATH` entry on Git for Windows is unverified.

**Decision**: Trust approval persists across launches (spec Clarifications, 2026-09-30). The shell stores one record for each worktree, because the fingerprint is per worktree. The record binds the common-directory identity, the worktree identity, the Git installation digest, and the fingerprint. A change of any of them gives `TRUST_CHANGED` and needs renewed approval. The record holds no configuration value or credential. A native confirmation with a Cancel default precedes each stored approval (R7). Revoke trust deletes the records of every worktree of that common directory. Over a digest bound, approval lasts for the service session only (contract §7).

Closed question, 2026-09-30: the fingerprint covered integration locations, not the contents of program files. A stored approval would survive an edit of a repository hook file. The fingerprint now adds the SHA-256 digest of each repository-controlled program or hook file with a resolved path. Only files inside the worktree root, the Git directory, or the common directory get a digest. So the service never opens an attacker-named UNC or device path. Contract §7 "Program file digests" defines the rule. The bounds are 64 files, 1 MiB per file, and 8 MiB in total. Closed question, 2026-09-30: overflow first blocked approval, so an over-bound repository could never get approval. Now an over-bound repository can get an explicit approval for the service session only. The shell writes no record, and the native confirmation says why (contract §7). Files beyond a bound enter the fingerprint as `unchecked`. The next session reports `untrusted`. T071 and T098 edit an approved hook file and expect `TRUST_CHANGED`. T071 also covers the session-only approval.

Closed question, 2026-09-30: a bare-name program had no digest. Git for Windows looks up a bare name in each non-empty `PATH` entry in order. It tries `<entry>\<name>.exe` first, then `<entry>\<name>` when that is not a directory (`lookup_prog`, mingw.c:1908-1928; `path_lookup`, mingw.c:1993-2021). It skips empty entries (`if (dirlen)`). A relative entry resolves against the directory where Git runs. For hooks, filters, and monitors, that is the worktree root (second probe above). So the service repeats that lookup for each relative entry and digests the first regular file. Without one, the fingerprint records `absent`, so a new file gives `TRUST_CHANGED`. An earlier absolute entry can win the lookup. The digest then covers a file that Git does not start, which errs toward `TRUST_CHANGED`. The contract still treats an empty entry as relative, which is conservative.

A probe on 2026-09-30 set four keys with a token in the subsection. They were `url.<URL>.insteadOf`, `http.<URL>.extraheader`, `credential.<URL>.helper`, and `includeIf.hasconfig:remote.*.url:<URL>/**.path`. Each URL had the form `https://u:TOKEN@host.example`. `config list --show-scope --show-origin -z` printed each token unchanged in the key. So contract §7 redacts URL user information in key subsections, origins, and displayed values. Git's `transport_anonymize_url` also removes the user information of a URL for display (transport.c:1695-1734). That function expects a whole URL. So the contract applies the rule to each `://` authority inside a longer text.

Redaction source: [transport_anonymize_url](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/transport.c#L1695-L1734).

Sources: [relative core.hooksPath](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/config/core.adoc#L512-L521), [hook working directory](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/githooks.adoc#L24-L28), [Windows program lookup](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/compat/mingw.c#L1993-L2021), [per-entry lookup](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/compat/mingw.c#L1908-L1928).

Preserve Git ownership checks. Never set `safe.directory=*`. Process-local safety flags must not rewrite user configuration or bypass required hooks.

Use argument arrays and literal path handling. `--` stops option parsing, but does not disable Git pathspec syntax. Do not accept renderer-provided patches, revisions, environments, or command strings.

Use shell-owned Windows Jobs for the service and individual Git operations. Start processes suspended, assign ownership, then resume them. Keep handles non-inheritable and disable breakaway.

Job Objects are process-lifetime controls, not security sandboxes. Trusted code can use external services beyond normal child-process ownership. Qualify supported hook behavior and report this limit.

Retain only allowlisted diagnostic metadata. Arbitrary hook output can contain credentials. Regex redaction alone cannot guarantee safe logs.

After every mutation outcome, reread actual state. Report unexpected or unknown effects without rollback claims. Never retry automatically or remove a lock with uncertain ownership.

Sources: [configured hooks](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/config/hook.adoc#L8-L34), [hook discovery](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-hook.adoc#L115-L149), [conditional configuration](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/config.adoc#L85-L125), [filesystem monitors](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/config/core.adoc#L64-L82), [Windows Jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [suspended creation](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags).

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

Git Extensions `v7.2.1` resolves to `0aea2d6df4c120806c46f1797ba6a45f5d14b345`. Its Windows release includes x64 MSI and portable artifacts. Its release notes require .NET Desktop `10.0.9` or later `10.x` and recommend Git `2.53.0` or later.

Source: [Git Extensions release](https://github.com/gitextensions/gitextensions/releases/tag/v7.2.1).

Give each application a separate WebView2 user-data directory. Include its browser, renderer, GPU, utility, service, Git, and owned helper processes.

Report summed private bytes separately from summed working sets. Shared pages can appear in multiple working sets. Include exited child-process CPU time, not only surviving processes.

Closed question, 2026-09-30: the 1-second foreground poll re-read full status, trust, and the index digest on every tick. On fixture L, polls could run back to back against the 1% idle CPU budget. The poll now runs a stat change check first (contract §8 "Change check"). Without a hint or a change, it starts no Git process. Focus return, manual refresh, and watcher hints still run full reads. T192 records full-read and change-check CPU time on M and L in batch 2. T169 measures the packaged idle CPU. A missed budget stays `fail`.

**Usable-workspace marker (SC-006, SC-015 C1 and C2).** The renderer calls `performance.mark("arbareto:usable-workspace")` when the plan.md done state commits. Chromium exports user timing marks to ETW under the category `blink.user_timing`, keyword `0x10000` (etw_interceptor_win.cc:106, revision `f77ee1168aca5bac8a0a24ab92867858321f5c12`). Microsoft's `WebView2.wprp` enables the WebView2 provider `E16EC3D2-BB0F-4E8F-BDB8-DE0BEA82DC3D` with keyword `0x3F0000054404`, which includes that bit. Its stable Edge provider keyword `0x10000000202F` does not. The owned profile `tests/windows/arbareto.wprp` (T193) enables only that WebView2 provider with keyword `0x10000`. WPR runs it together with the built-in `GPU` profile. Whether the installed runtime emits the mark through that provider is unverified until T193 and T165 confirm it. Profile source: WebView2Feedback commit `874307a3f444dec048f9cfead987ea263d78086e`, `diagnostics/resources/WebView2.wprp`.

Marker sources: [Chromium ETW keywords](https://github.com/chromium/chromium/blob/f77ee1168aca5bac8a0a24ab92867858321f5c12/base/trace_event/etw_interceptor_win.cc#L106), [WebView2 profile](https://github.com/MicrosoftEdge/WebView2Feedback/blob/874307a3f444dec048f9cfead987ea263d78086e/diagnostics/resources/WebView2.wprp), [WebView2 ETW guidance](https://learn.microsoft.com/microsoft-edge/webview2/concepts/performance#telemetry-and-profiling-tools).

**Input injection and frame timing (SC-005, SC-006, SC-015).** Input injection uses the test-only script `tests/windows/inject.ts` (T165). It calls the Windows `SendInput` API through `bun:ffi`. R2 allows `bun:ffi` in tests, not in production. The script needs no installation. It records the QueryPerformanceCounter value at each injection. Presented-frame timing comes from the WPR trace with GPU and DXGI present events. On 2026-09-29, `wpr -profiles` on the reference host lists the built-in `GPU` profile (WPR `10.0.26100`). `wpr -profiledetails GPU` lists the `Microsoft-Windows-DXGI` and `Microsoft-Windows-DxgKrnl` providers. The `DesktopComposition` profile lists `Microsoft-Windows-Dwm-Core`. Present-event coverage for WebView2 frames stays unverified until T165 confirms it. Any tool installation needs explicit maintainer approval, recorded in this section.

Use the same capture method for baseline and candidate. An elevated trace collector does not qualify elevated application behavior. Run the application and installer as a standard user.

Sources: [WebView2 process grouping](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model), [Windows memory accounting](https://learn.microsoft.com/en-us/windows/win32/psapi/process-memory-usage-information), [CPU accounting](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes), [WPR](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/windows-performance-recorder).

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
| Bun compiler/runtime | `1.4.2` (exact) | MIT plus linked-component obligations; revision `744846f844374847c902b5e7fd59b4342a51ef99`. |
| Rust/Cargo | `1.98.0` | Apache-2.0 OR MIT plus component notices; Rust revision `88d9e12ae178fab0fb5cc050a94da85685d449ea`. |
| NSIS | `3.11` | Mainly zlib/libpng, with compression-component notices. Tauri pins its download and hash. |
| `serde` / `serde_json` | `1.0.228` / `1.0.145` | MIT OR Apache-2.0; Tauri's `Cargo.lock` selects these versions at the revision above. |

Tauri and the selected plugin require Rust 1.90. The selected Windows binding requires Rust 1.82. The observed Rust 1.98 toolchain satisfies those declared floors, but no project build ran.

Tauri's lock selects Wry `0.57.0`, Tao `0.37.0`, WebView2 COM `0.39.1`, and Windows bindings `0.62.0`. The dialog plugin also depends on filesystem support. That dependency does not justify renderer filesystem permissions.

Use the native dialog through typed Rust commands. Omit the dialog JS package, shell plugin, and clipboard plugin. Native text copy/paste covers this slice.

The `windows` Git tag metadata did not match the published package. The published crate identifies the revision above. Its registry checksum is `9579d0e6970fd5250aa29aba5994052385ff55cf7b28a059e484bb79ea842e42`.

### Win32 binding features

On 2026-09-30, a source inspection read the published `windows-0.62.0.crate`, whose SHA-256 equals the checksum above. Each call in the tasks lives in one feature module. Some calls need a second feature for a parameter type. T006 enables exactly this list.

| Feature | Calls and types in the tasks | Evidence in the crate |
| --- | --- | --- |
| `Win32_Foundation` | `HANDLE`, `CloseHandle`, `SetHandleInformation`, `DuplicateHandle`. | `Win32/Foundation/mod.rs`. Every other Win32 feature also enables it. |
| `Win32_Security` | `SECURITY_ATTRIBUTES`. It gates `CreateProcessW`, `CreateJobObjectW`, `CreatePipe`, and `CreateFileW`. | Each function carries `#[cfg(feature = "Win32_Security")]`: Threading `mod.rs:358`, JobObjects `mod.rs:16`, Pipes `mod.rs:42`, FileSystem `mod.rs:359`. |
| `Win32_System_Threading` | `CreateProcessW`, `STARTUPINFOEXW`, `InitializeProcThreadAttributeList`, `UpdateProcThreadAttribute`, `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, `ResumeThread`, `TerminateProcess`, `WaitForSingleObject`, `GetExitCodeProcess`, `GetCurrentProcess`, `IsWow64Process2`. It also gates `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`. | `Win32/System/Threading/mod.rs`; JobObjects `mod.rs:190`. |
| `Win32_System_JobObjects` | `CreateJobObjectW`, `SetInformationJobObject`, `QueryInformationJobObject`, `AssignProcessToJobObject`, `TerminateJobObject`, `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. | `Win32/System/JobObjects/mod.rs`. |
| `Win32_System_Pipes` | `CreatePipe`. | `Win32/System/Pipes/mod.rs:44`. |
| `Win32_System_IO` | `OVERLAPPED`. It gates `ReadFile` and `WriteFile`. | FileSystem `mod.rs:2112`. |
| `Win32_Storage_FileSystem` | `SearchPathW` (T060, mod.rs:2353), `CreateFileW`, `ReadFile`, `WriteFile`, `FlushFileBuffers`, `DeleteFileW`, `MoveFileExW`, `ReplaceFileW`, `GetFileInformationByHandleEx`, `FILE_ID_INFO`, `FileIdInfo`, `FILE_SHARE_READ`, `FILE_SHARE_WRITE`, `FILE_SHARE_DELETE`, `FILE_FLAG_BACKUP_SEMANTICS`, `FILE_READ_ATTRIBUTES`. | `Win32/Storage/FileSystem/mod.rs`; `FileIdInfo` is class 18 at `mod.rs:4767`. |
| `Win32_System_SystemInformation` | `OSVERSIONINFOEXW`, `OSVERSIONINFOW`, `IMAGE_FILE_MACHINE`, `IMAGE_FILE_MACHINE_AMD64`. It gates `IsWow64Process2` and `RtlGetVersion`. | Threading `mod.rs:1130`; Wdk SystemServices `mod.rs:5328`. |
| `Win32_System_SystemServices` | `VER_NT_WORKSTATION`, `VER_NT_DOMAIN_CONTROLLER`, `VER_NT_SERVER`. | `Win32/System/SystemServices/mod.rs:5294-5296`. |
| `Wdk_System_SystemServices` | `RtlGetVersion`. | `Wdk/System/SystemServices/mod.rs:5330`. It takes `*mut OSVERSIONINFOW`. The crate has no `RTL_OSVERSIONINFOEXW` name, so T057 passes a cast `OSVERSIONINFOEXW`. |
| `Win32_UI_Controls` | `TaskDialogIndirect`, `TASKDIALOGCONFIG`, `TASKDIALOG_BUTTON`. | `Win32/UI/Controls/mod.rs:1267`, `:9116`. |
| `Win32_UI_WindowsAndMessaging` | It gates `TaskDialogIndirect` and `TASKDIALOGCONFIG`. | Controls `mod.rs:1265`, `:9114`. |

WebView2 calls go through `webview2-com` `0.39.1`, not through these features. No project build ran, so the list is unverified until T065 compiles it. A missing feature fails that compile; it cannot pass silently.

Sources: [Tauri versions and MSRV](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/Cargo.toml#L40-L58), [runtime dependencies](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-runtime-wry/Cargo.toml#L15-L35), [API revision](https://github.com/tauri-apps/tauri/tree/4f46cfc10da37f5deba2326569f86b0700d97835), [dialog manifest](https://github.com/tauri-apps/plugins-workspace/blob/a2364a5f216324439feedeb25b2db74e7b1eba90/plugins/dialog/Cargo.toml#L35-L57), [published Windows manifest](https://github.com/microsoft/windows-rs/blob/983720fec75dea714cca37d29679eb9369ec7ef7/crates/libs/windows/Cargo.toml#L1-L9), [NSIS pin](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs#L36-L43).

### Compiled-service hardening

Use `bun-windows-x64`. Bun 1.4.2 targets SSE4.2/Nehalem and performs runtime instruction dispatch. Do not repeat older mandatory-AVX2 claims.

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

Keep Git's controlled child environment separate. Preserve required user authentication settings without modifying PATH, agents, helpers, or persistent configuration.

A Git-behavior probe on 2026-09-29 used Git `2.55.0.windows.3` in a throwaway repository. `GIT_CONFIG_COUNT` pairs and `GIT_CONFIG_PARAMETERS` appeared in `git config list --show-scope` with scope `command`. An environment `core.hooksPath` changed the `git rev-parse --git-path hooks` result. With `GIT_CONFIG` set, `git config list` showed only that file, and a local key disappeared. `git rev-parse` still honored the local `core.hooksPath`. `git var GIT_AUTHOR_IDENT` used `GIT_AUTHOR_NAME` also under `user.useConfigOnly=true`. This probe is not qualification evidence, and no Arbareto build ran.

Sources: [command scope and protected configuration](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-config.adoc#L436-L466), [GIT_CONFIG_COUNT and GIT_CONFIG](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-config.adoc#L484-L505), [identity variables](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git.adoc#L603-L636), [configuration variable names](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/environment.h#L19-L21).

Sources: [CPU configuration](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/scripts/build/config.ts#L869-L876), [CPU compiler flag](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/scripts/build/flags.ts#L69-L74), [autoload flag parser](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/runtime/cli/Arguments.rs#L2254-L2335), [executable flag encoding](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/runtime/cli/build_command.rs#L918-L934), [runtime flag application](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/bun.js.rs#L10-L28), [Bun CLI bypass](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/runtime/cli/mod.rs#L1192-L1198), [BUN_OPTIONS](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/runtime/cli/mod.rs#L1345-L1385), [explicit config exception](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/bunfig/arguments.rs#L136-L229).

### Why the Rust supervisor exists

Bun pins libuv revision `8023581113b276e7c1aee3f82da57ca0893faab1`. Its Windows Job enables breakaway and does not reliably contain descendants. Process killing reaches process termination, not a per-operation Job termination.

Bun's inspected parent-death watchdog enables its behavior on Unix. Its Windows-named Job function is empty.

Tauri shell plugin `2.4.0` also uses child-process termination. Its normal exit map is not a crash-cleanup guarantee. Its default line reader can accumulate an unbounded line.

Use separate shell-owned service and operation Jobs. Do not expose native spawning to the renderer. Serialize argument arrays only at `CreateProcessW`, with tested Windows quoting and explicit `lpApplicationName`.

Sources: [Bun libuv pin](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/scripts/build/deps/libuv.ts#L14-L28), [libuv Job flags](https://github.com/oven-sh/libuv/blob/8023581113b276e7c1aee3f82da57ca0893faab1/src/win/process.c#L69-L120), [process termination](https://github.com/oven-sh/libuv/blob/8023581113b276e7c1aee3f82da57ca0893faab1/src/win/process.c#L1354-L1365), [watchdog implementation](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/io/ParentDeathWatchdog.rs#L212-L292), [Tauri shell process handling](https://github.com/tauri-apps/plugins-workspace/blob/a2364a5f216324439feedeb25b2db74e7b1eba90/plugins/shell/src/process/mod.rs#L63-L85), [line buffering](https://github.com/tauri-apps/plugins-workspace/blob/a2364a5f216324439feedeb25b2db74e7b1eba90/plugins/shell/src/process/mod.rs#L466-L479).

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

The dialog plugin cannot build a safe close prompt. `tauri-plugin-dialog` `2.8.0` maps `OkCancelCustom` to rfd `0.16` with Common Controls v6. rfd calls `TaskDialogIndirect` with `nDefaultButton` `0`, so the first button is the default. It sets `TDF_ALLOW_DIALOG_CANCELLATION`, so Escape, Alt+F4, and the close button return `IDCANCEL`. The plugin maps `IDCANCEL` and a failed call to the text of the second button. So Enter or Escape selects Interrupt and close, whatever the order. T140 therefore calls `TaskDialogIndirect` directly with a Stay open default. The Git selection, trust approval, and marker dismissal confirmations have the same risk with the plugin. So T060 calls `TaskDialogIndirect` directly with a Cancel default for all three. The file and folder pickers still use the plugin, because a picker has no accept-by-Escape hazard. The tauri-build default manifest already requests Common Controls v6.

Sources: [plugin button mapping](https://github.com/tauri-apps/plugins-workspace/blob/a2364a5f216324439feedeb25b2db74e7b1eba90/plugins/dialog/src/desktop.rs#L110-L140), [plugin result mapping](https://github.com/tauri-apps/plugins-workspace/blob/a2364a5f216324439feedeb25b2db74e7b1eba90/plugins/dialog/src/desktop.rs#L215-L258), [rfd task dialog](https://github.com/PolyMeilex/rfd/blob/0.16.0/src/backend/win_cid/message_dialog.rs#L100-L200), [TASKDIALOGCONFIG](https://learn.microsoft.com/windows/win32/api/commctrl/ns-commctrl-taskdialogconfig), [TaskDialogIndirect](https://learn.microsoft.com/windows/win32/api/commctrl/nf-commctrl-taskdialogindirect), [tauri-build manifest](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-build/src/windows-app-manifest.xml).

### Signing and deferred authenticated updates

Updater `2.13.0` is research-only. Do not add it to this feature's runtime dependencies.

Tauri implements conditional signing for binaries, sidecars, installers, and uninstallers. Verify each final artifact; successful packaging does not establish signing.

The updater's `download()` verifies minisign signatures. `download_and_install()` uses that path. Rust `install(bytes)` alone does not verify supplied bytes.

For future adoption, require signed-version metadata and reject downgrades. `requireSignedVersion` defaults to false. Keep endpoints and keys outside renderer control.

Use the updater's exit callback to stop owned Jobs before installer handoff. Windows update installation can exit without ordinary Rust cleanup.

Public release remains blocked on Authenticode, timestamp/chain validation, update authenticity, tampering, wrong-key, version-substitution, and downgrade tests. A certificate alone does not guarantee SmartScreen reputation.

Sources: [sidecar signing](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-bundler/src/bundle.rs#L345-L380), [signing implementation](https://github.com/tauri-apps/tauri/blob/447fa9f3f993fe77724189e355078b38ce20baea/crates/tauri-bundler/src/bundle/windows/sign.rs#L162-L184), [verified download versus install](https://github.com/tauri-apps/plugins-workspace/blob/a2364a5f216324439feedeb25b2db74e7b1eba90/plugins/updater/src/updater.rs#L827-L870), [signed-version verification](https://github.com/tauri-apps/plugins-workspace/blob/a2364a5f216324439feedeb25b2db74e7b1eba90/plugins/updater/src/updater.rs#L1633-L1707), [signed-version default](https://github.com/tauri-apps/plugins-workspace/blob/a2364a5f216324439feedeb25b2db74e7b1eba90/plugins/updater/src/config.rs#L117-L135), [Windows exit](https://github.com/tauri-apps/plugins-workspace/blob/a2364a5f216324439feedeb25b2db74e7b1eba90/plugins/updater/src/updater.rs#L938-L979), [SmartScreen limits](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).

Bun's licence states that it statically links LGPL-licensed JavaScriptCore/WebKit. Include notices and satisfy applicable source/relinking obligations before distribution. Do not label the complete compiled product MIT-only.

Source: [Bun licence and linked components](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/LICENSE.md#L1-L19).

### Corresponding Source location

The configured location is `https://github.com/auric/arbareto` (plan.md About window). On 2026-09-29, that repository exists but is private. An authenticated `gh api repos/auric/arbareto` returned `"private": true` and size 0. The unauthenticated GitHub API and web page returned HTTP 404. An anonymous `git ls-remote` failed. This checkout has no Git remote.

The maintainer keeps the repository private until version 1. Version 1 is the first working release that implements most Git Extensions features, except plugins. Local test packages need no public source. A public release needs an anonymously obtainable build commit (FR-037). T176 records an anonymous check. B-RELEASE stays blocked until that check passes.

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
| `shiki`, `@shikijs/transformers` | `4.4.3` | MIT plus distributed asset notices; highlighting. |
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

Use `bunx --bun vite build`. Bare `bunx vite` can honor the Node shebang. Qualify type checking and bundling under Bun 1.4.2 without relying on a Node executable.

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

Bundle worker modules, Shiki languages/themes, and WASM-related chunks locally. Use a Vite worker factory and ES worker chunks. The portable worker is not a standalone single asset. Do not use CDN assets or unnecessary inline/blob workers.

Pierre uses an open shadow root. Style it with inherited tokens and application-owned CSS. Never interpolate repository content into `unsafeCSS`.

Tailwind's Chrome 111 floor does not establish the complete frontend's minimum browser version. Pierre also uses newer CSS features. Test the installed WebView2 runtime with local workers, the content policy, selection, copy, and focus (T160).

Enforce 1 MiB raw and normalized sides before decoding. Count diff lines before highlighting or parsing. Count canonical patch lines once, independently of split/unified presentation.

Keep focused virtual rows mounted, or use a persistent focus container. Preserve stable selected IDs. Restore focus after dialogs and refresh. Exclude IME, editable targets, AltGraph, and shadow-root text input from global shortcuts.

Sources: [Pierre Virtualizer](https://github.com/pierrecomputer/pierre/blob/8f360ae1b39fcbbdaccacbcd8dbbf94fb10a3c38/packages/diffs/src/react/Virtualizer.tsx#L18-L65), [virtualized component selection](https://github.com/pierrecomputer/pierre/blob/8f360ae1b39fcbbdaccacbcd8dbbf94fb10a3c38/packages/diffs/src/react/utils/useFileDiffInstance.ts#L185-L209), [worker options](https://github.com/pierrecomputer/pierre/blob/8f360ae1b39fcbbdaccacbcd8dbbf94fb10a3c38/packages/diffs/src/worker/types.ts#L148-L172), [worker engine loading](https://github.com/pierrecomputer/pierre/blob/8f360ae1b39fcbbdaccacbcd8dbbf94fb10a3c38/packages/diffs/src/worker/worker.ts#L186-L198), [published tarball](https://registry.npmjs.org/@pierre/diffs/-/diffs-1.5.1.tgz), [shadow root](https://github.com/pierrecomputer/pierre/blob/8f360ae1b39fcbbdaccacbcd8dbbf94fb10a3c38/packages/diffs/src/components/File.ts#L1359-L1366), [unsafe CSS insertion](https://github.com/pierrecomputer/pierre/blob/8f360ae1b39fcbbdaccacbcd8dbbf94fb10a3c38/packages/diffs/src/components/File.ts#L1536-L1543), [Base UI focus management](https://github.com/mui/base-ui/blob/47b40521eab921c2756bf9bdb0b0f07fbfdb8c8c/packages/react/src/dialog/popup/DialogPopup.tsx#L97-L142).

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

Pierre `1.5.1` exposes `preferredHighlighter`, with the values `shiki-js` and `shiki-wasm`. Its default is `shiki-js`, the Shiki JavaScript RegExp engine. Shiki states that this engine supports all built-in languages since 3.9.1. It uses the RegExp `v` flag. So no WebAssembly compiles, and the policy needs no `'wasm-unsafe-eval'`. Vite still emits the lazy `shiki/wasm` chunk, so T130 keeps its notice.

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
| Electrobun packaged comparison | Not in scope | Source comparison only; no comparative performance result exists. |
| Package signing and authenticated updates | Public release blocked | Deferred implementation and required verification remain incomplete. |

Future records must identify scenario, build/package digest, environment, fixtures, steps, actual result, failure cause, attempted remedy, and retest. Keep those records here. Do not add a separate qualification report.

### Batch reviews

Each batch verification task passes only after one independent review of its batch is recorded here (plan.md, Constitution Check). A record names the batch, the reviewer, the reviewed scope, and the findings. It also names the causes, corrections, and unverified claims. T116 records the batch 3 review here. One review runs per batch; no automatic review loop runs. No batch review exists yet.

### Dependency reviews

After T003 and T006, each dependency change gets one record here (plan.md, Tool and runtime boundaries). A record names the task and each added, removed, or changed package. It gives the old and new resolved versions, the licence, the reason, the reviewer, and the findings. It also lists the qualification checks that ran again. No dependency review exists yet.

## R11. Planning artifact checks

Mechanical checks on 2026-09-28 found no broken local document links or unresolved template markers. The sentence-length check found no prose sentences above 20 words.

The active feature and branch remain `001-desktop-qualification`. No tracked files changed. Only new artifacts inside the selected feature were written.

No application package or source tree was created. `/speckit-tasks` later created `tasks.md` (T001 to T187). No application build, mutation test, installer test, or benchmark ran.

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

Mechanical checks covered six design documents, including table-cell sentences. Local links, code fences, sentence lengths, and placeholder checks passed. A re-run after the About window update found FR-001–FR-037, SC-001–SC-014, F01–F20, and UI-01–UI-15 unique, consecutive, and validly referenced. Note, 2026-09-30: the spec now also holds SC-015, so the current range is SC-001–SC-015.

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
| A hook rejection showed no reason, because hook output stays hidden. | `HOOK_FAILED` and a commit `GIT_FAILED` carry a remedy command. Clear message sits beside `completed-with-effects`. |
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

