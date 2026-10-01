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
- Apply `--no-lazy-fetch` to every Git command, and `--no-optional-locks` to every read (R5 partial-clone probe). Missing objects do not authorize network access. The two version probes are the exception, because Git before 2.45.0 rejects the option (contract §7 "Missing objects").
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

**Alternatives considered**: Renderer patches, whole-file staging as a hunk fallback, direct live-index patching, and three-way fallback. None provides the selected-hunk publication guarantee. Whole-file staging is a separate explicit action ("Whole-file staging" below).

### Supported profile

Support ordinary full indexes and the specified UTF-8 LF/CRLF text cases. Refuse sparse/split indexes until separately qualified. The raw `link` extension identifies a split index (R2). An effective `core.splitIndex=true` also refuses, because a candidate write then splits the candidate ("Whole-file staging" probe 9).

Refuse any registered `post-index-change` hook and any executable filesystem-monitor integration for hunk mutations. Refuse custom filters, LFS, encoding conversion, unsupported entry types, conflicts, unfinished operations, and incomplete observations.

`git hook list` includes disabled configured registrations. Initially refuse every `post-index-change` registration rather than infer an executable subset incorrectly. Ordinary commit hooks do not trigger this refusal unless they also register an index-change event.

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
- The installed build has no test barrier. T161 triggers the late write on the step 13 index replacement (T141 `--late-write`). So the write always follows step 11. Reconciliation can read the file before or after that write. T161 records the branch that ran. T097 covers the `completed-with-effects` branch in process. Whether Bun `fs.watch` on Windows reports the rename to `index` is unverified; T161 records it.

No mutation fixture has run. This is an implementable design with mandatory proof cases, not a runtime pass.

Additional sources: [hook registrations include disabled entries](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/hook.c#L72-L107), [index loading and fsmonitor](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/fsmonitor.c#L792-L811).

Sources: [lock protocol](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/lockfile.h#L5-L31), [Windows replacement behavior](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/compat/mingw.c#L3003-L3150), [apply modes](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-apply.adoc#L60-L95), [apply locking](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/apply.c#L4945-L4963), [hunk relocation](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/apply.c#L3138-L3202), [index-write hook](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/read-cache.c#L3149-L3160), [reference transactions](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git-update-ref.adoc).

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

A failed commit shows a bounded, sanitized, and redacted tail of Git stderr (contract §9 "Commit failure output"). `HOOK_FAILED` and a commit `GIT_FAILED` also carry a remedy command. It runs `hook run --ignore-missing pre-commit` in a terminal (contract §9). The command uses the selected Git executable and the worktree root, and never the message. An earlier remedy ran `git commit` itself. After a passing hook, Git would open an editor (`git-commit` without `-m` or `-F`). It would then create a commit outside the review. So that command is withdrawn.

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

**Decision**: Trust approval persists across launches (spec Clarifications, 2026-09-30). The shell stores one record for each worktree, because the fingerprint is per worktree. The record binds the common-directory identity, the worktree identity, the Git installation digest, and the fingerprint. A change of any of them gives `TRUST_CHANGED` and needs renewed approval. The record holds no configuration value or credential. A native confirmation with a Cancel default precedes each stored approval (R7). Revoke trust deletes the records of every worktree of that common directory. Over a digest bound, approval lasts for the service session only (contract §7). That session ends when Arbareto closes or at Restart service, and the native confirmation names both.

Closed question, 2026-09-30: the fingerprint covered integration locations, not the contents of program files. A stored approval would survive an edit of a repository hook file. The fingerprint now adds the SHA-256 digest of each repository-controlled program or hook file with a resolved path. Only files inside the worktree root, the Git directory, or the common directory get a digest. So the service never opens an attacker-named UNC or device path. Contract §7 "Program file digests" defines the rule. The bounds are 64 files, 1 MiB per file, and 8 MiB in total. Closed question, 2026-09-30: overflow first blocked approval, so an over-bound repository could never get approval. Now an over-bound repository can get an explicit approval for the service session only. The shell writes no record, and the native confirmation says why (contract §7). Files beyond a bound enter the fingerprint as `unchecked`. The next session reports `untrusted`. T071 and T098 edit an approved hook file and expect `TRUST_CHANGED`. T071 also covers the session-only approval.

Closed question, 2026-09-30: a bare-name program had no digest. Git for Windows looks up a bare name in each non-empty `PATH` entry in order. It tries `<entry>\<name>.exe` first, then `<entry>\<name>` when that is not a directory (`lookup_prog`, mingw.c:1908-1928; `path_lookup`, mingw.c:1993-2021). It skips empty entries (`if (dirlen)`). A relative entry resolves against the directory where Git runs. For hooks, filters, and monitors, that is the worktree root (second probe above). So the service repeats that lookup for each relative entry and digests the first regular file. Without one, the fingerprint records `absent`, so a new file gives `TRUST_CHANGED`. An earlier absolute entry can win the lookup. The digest then covers a file that Git does not start, which errs toward `TRUST_CHANGED`. The contract still treats an empty entry as relative, which is conservative.

A probe on 2026-09-30 set four keys with a token in the subsection. They were `url.<URL>.insteadOf`, `http.<URL>.extraheader`, `credential.<URL>.helper`, and `includeIf.hasconfig:remote.*.url:<URL>/**.path`. Each URL had the form `https://u:TOKEN@host.example`. `config list --show-scope --show-origin -z` printed each token unchanged in the key. So contract §7 redacts URL user information in key subsections, origins, and displayed values. Git's `transport_anonymize_url` also removes the user information of a URL for display (transport.c:1695-1734). That function expects a whole URL. So the contract applies the rule to each `://` authority inside a longer text.

Redaction source: [transport_anonymize_url](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/transport.c#L1695-L1734).

A partial-clone probe on 2026-09-30 used Git `2.55.0.windows.3`. It cloned a local repository with `--filter=blob:none` and set a local `remote.origin.uploadpack` to a canary program. Each command then needed a blob that the clone lacked. Without `--no-lazy-fetch`, the canary ran for `status --porcelain=v2 --find-renames`, `diff-index --cached -p`, `diff-files -p`, `ls-files --eol`, and `commit --file=-`. The commit ran it for its rename summary. With `--no-lazy-fetch`, no canary ran. `status`, `diff-index`, and `diff-files` exited 128. `ls-files --eol` exited 0 and printed `i/none` for the missing blob. The commit moved HEAD, ran `post-commit`, and then exited 128 in its summary. A `pre-commit` hook saw `GIT_NO_LAZY_FETCH=1`, and its own `git cat-file` of a missing blob failed without a canary. Without the option, the hook saw no such variable, and its read ran the canary. `cat-file --batch-check` with `--no-lazy-fetch` printed `<oid> missing` and ran no canary. The listing showed `remote.origin.promisor` at local scope, and `git backfill` exists in this version. This probe is not qualification evidence.

A follow-up probe on 2026-09-30 moved HEAD with `reset --soft` to a fetched commit whose blob the `blob:none` clone lacked. It had `pre-commit`, `commit-msg`, and `post-commit` canaries and the uploadpack canary. `--no-lazy-fetch commit --file=-` ran the three hooks and moved HEAD. It then exited 128 in its summary, because the summary needed the missing blob. `--no-lazy-fetch commit --quiet --file=-` in a fresh copy ran the three hooks and moved HEAD with the right parent. It exited 0 and printed nothing, and its tree equaled the index. No uploadpack canary ran in either case. Git prints the summary after `post-commit` and only without `--quiet` (builtin/commit.c:1967-1982). Automatic maintenance still runs with `--quiet`. This probe is not qualification evidence.

Consequence: every app Git command passes `--no-lazy-fetch` (contract §7 "Missing objects"). The option propagates through the environment. So an approved hook cannot fetch objects during an app operation, although command-line Git would fetch them. A hook that needs a missing object then fails, and its message appears in the commit failure output. This is the stricter reading: a fetch can run a program from repository configuration without approval. `ls-files --eol` hides a missing blob, so only the `cat-file --batch-check` object check detects it. The app's commit passes `--quiet`, so the summary step never runs. Reconciliation still classifies every commit from observed state, and the exit status alone decides nothing.

An untracked-read probe on 2026-09-30 ran `git diff --no-index -- /dev/null u.txt`. The repository had local canaries for `diff.external`, `diff.<driver>.textconv`, `filter.<driver>.clean`, and `core.fsmonitor`. Its attribute file selected the driver and the filter for `u.txt`. Without flags, the clean filter and `diff.external` ran. With `--no-ext-diff` only, the clean filter and `textconv` ran. With `--no-textconv` only, the clean filter and `diff.external` ran. With both flags, only the clean filter ran. The `core.fsmonitor` canary never ran. `nul` in place of `/dev/null` behaved the same. So a `diff` form needs both flags, and a `filter` attribute refuses before the command (contract §4). This probe is not qualification evidence.

A read-command probe on 2026-10-01 used Git `2.55.0.windows.3` in a scratch repository. It had local canaries for command-valued `core.fsmonitor` and for clean and smudge filters, with a `filter` attribute. A tracked file was stat-dirty. `check-attr -z --stdin filter` ran the monitor canary once and no filter. `hash-object -t tree --stdin` and `config --file .gitmodules --null --list` ran no canary. `hash-object --stdin --path=<path>` ran the clean filter. Contract §7 lists these results.

A quoting probe on 2026-09-30 used PowerShell `7.6.6` and Windows PowerShell `5.1.26100.9444`, each with `-NoProfile -EncodedCommand`. It built the contract §4 `add` remedy for a file name or a worktree root. The value held U+0027, U+2018, U+2019, U+201A, or U+201B, followed by `; ni <marker>`. The root payload ended with `#`, so the rest of the command parsed as a comment. With only U+0027 doubled, each of the other four ended the string, and the marker file appeared. This happened in both shells, in the file name and in the root. With all five doubled, no marker appeared in the 20 cases, and `git ls-files` listed the staged file. So the contract doubles all five. This probe is not qualification evidence.

The commit failure output shows the output of hooks that the user configured or approved, as a terminal run does. The rule below stays for logs: regex redaction cannot make hook output safe to log. So the output tail never enters a log, a `diagnostic`, or a progress event. On screen, the service removes control sequences and redacts URL user information (contract §9). A secret in another form can remain, as in a terminal.

Sources: [relative core.hooksPath](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/config/core.adoc#L512-L521), [hook working directory](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/githooks.adoc#L24-L28), [Windows program lookup](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/compat/mingw.c#L1993-L2021), [per-entry lookup](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/compat/mingw.c#L1908-L1928).

Preserve Git ownership checks. Never set `safe.directory=*`. Process-local safety flags must not rewrite user configuration or bypass required hooks.

Use argument arrays and literal path handling. `--` stops option parsing, but does not disable Git pathspec syntax. Do not accept renderer-provided patches, revisions, environments, or command strings.

Use shell-owned Windows Jobs for the service and individual Git operations. Start processes suspended, assign ownership, then resume them. Keep handles non-inheritable and disable breakaway.

**Lingering Jobs (2026-09-30 decision).** Git or hook processes from a mutation can outlive its Git process, as with command-line Git. The shell keeps such a Job in a lingering set (contract §6). It closes the Job when the Job becomes empty or the application closes. Cancellation, deadline expiry, and Interrupt and close still close the Job at once. Read Jobs never linger. The shell associates the completion port before it assigns the first process. Microsoft advises association while the Job is inactive, because messages for state changes during association can go missing. `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO` reports a Job whose active process count reached zero. Delivery of that message is not guaranteed; a missing message does not prove that the event did not occur. So the shell also reads `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION` for each lingering Job at each `ended` frame. The count read after a child's exit wait is taken to exclude that child (unverified; T023 verifies). A missed message keeps only an empty Job handle until application close, never a process. Kill-on-close at application close keeps SC-008.

Addition, 2026-09-30: a completion probe used PowerShell `7.6.6` and `System.Diagnostics.Process` with redirected pipes. A `post-commit` hook started `(sleep 8; echo late >&2) &` and exited. `git commit --file=-` exited after 253 ms, and stderr reached EOF after 8,339 ms. The late line arrived after the exit. So a process ends at its handle signal, and the shell discards later pipe bytes (contract §6 "Completion signal"). A completion at EOF would reach the 120-second deadline for a longer child and kill it. This probe is not qualification evidence. The shell also tags each mutation Job with its common-directory identity. Revoke trust closes the lingering Jobs with that tag. A cancellation during `reconciling`, or a revoke during a mutation, sets `endProcesses` on `ended`, so that Job never lingers.

Sources: [job limits and notifications](https://learn.microsoft.com/windows/win32/procthread/job-objects#job-limits-and-notifications), [completion port messages](https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-jobobject_associate_completion_port#remarks), [kill-on-close](https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information#members).

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

**History-ready and Changes-ready markers (SC-006 and the switch rows).** The renderer calls `performance.mark("arbareto:history-painted")` when the plan.md History-ready state commits. Every open ends there (spec FR-034). It calls `performance.mark("arbareto:changes-ready")` when the Changes-ready state commits after a switch. Chromium exports user timing marks to ETW under the category `blink.user_timing`, keyword `0x10000` (etw_interceptor_win.cc:106, revision `f77ee1168aca5bac8a0a24ab92867858321f5c12`). Microsoft's `WebView2.wprp` enables the WebView2 provider `E16EC3D2-BB0F-4E8F-BDB8-DE0BEA82DC3D` with keyword `0x3F0000054404`, which includes that bit. Its stable Edge provider keyword `0x10000000202F` does not. The owned profile `tests/windows/arbareto.wprp` (T193) enables only that WebView2 provider. Its `Arbareto.Light` level uses keyword `0x10000` for the timing series, and its `Arbareto.Verbose` level uses `0x10200` for the stall workloads. WPR selects a level with `<file>.wprp!<Name>.light` or `.verbose` (Microsoft Learn "WPR Command-Line Options"). WPR runs it together with the built-in `GPU` profile. The same table maps `toplevel` to bit `0x200` (etw_interceptor_win.cc:99). That category carries Chromium's task events, which plan.md "Responsiveness metrics" uses for long tasks. The `arbareto:history-painted` mark uses the same `blink.user_timing` path. T193 and T165 confirm whether the installed runtime emits the marks and the task events through that provider. The task event name and its begin and end fields are unverified until T193 reports them. Profile source: WebView2Feedback commit `874307a3f444dec048f9cfead987ea263d78086e`, `diagnostics/resources/WebView2.wprp`.

Marker sources: [Chromium ETW keywords](https://github.com/chromium/chromium/blob/f77ee1168aca5bac8a0a24ab92867858321f5c12/base/trace_event/etw_interceptor_win.cc#L99-L106), [WebView2 profile](https://github.com/MicrosoftEdge/WebView2Feedback/blob/874307a3f444dec048f9cfead987ea263d78086e/diagnostics/resources/WebView2.wprp), [WebView2 ETW guidance](https://learn.microsoft.com/microsoft-edge/webview2/concepts/performance#telemetry-and-profiling-tools).

**Input injection and frame timing (SC-005, SC-006, SC-015).** Input injection uses the test-only script `tests/windows/inject.ts` (T165). It calls the Windows `SendInput` API through `bun:ffi`. R2 allows `bun:ffi` in tests, not in production. The script needs no installation. It records the QueryPerformanceCounter value at each injection. Arbareto's absolute budgets take presented-frame timing from the WPR trace with GPU and DXGI present events. SC-005, SC-007, and SC-015 take it from the capture source below. On 2026-09-29, `wpr -profiles` on the reference host lists the built-in `GPU` profile (WPR `10.0.26100`). `wpr -profiledetails GPU` lists the `Microsoft-Windows-DXGI` and `Microsoft-Windows-DxgKrnl` providers. The `DesktopComposition` profile lists `Microsoft-Windows-Dwm-Core`. Present-event coverage for WebView2 frames stays unverified until T165 confirms it. Any tool installation needs explicit maintainer approval, recorded in this section.

**Capture source for both applications (SC-015, SC-005, SC-007).** Git Extensions is a WinForms application, so a WebView2 DXGI Present event cannot time it. Both applications therefore use DXGI Desktop Duplication through the test-only script `tests/windows/capture.ts` (T242). Microsoft Learn states these facts, read on 2026-10-01:

- `IDXGIOutput1::DuplicateOutput` creates the duplication from a device on the adapter of the output. By default, only four processes in one session can duplicate outputs; a fifth call gives `DXGI_ERROR_NOT_CURRENTLY_AVAILABLE`. The secure desktop needs `LOCAL_SYSTEM` and gives `E_ACCESSDENIED` otherwise.
- `IDXGIOutputDuplication::AcquireNextFrame` takes a time-out in milliseconds. It returns `DXGI_ERROR_WAIT_TIMEOUT` without a new frame and `DXGI_ERROR_ACCESS_LOST` after a desktop switch or a mode change.
- `DXGI_OUTDUPL_FRAME_INFO.LastPresentTime` is the time of the last desktop image update, which the OS takes from QueryPerformanceCounter. A value of zero means no image update since the previous acquisition. A pointer-only update sets it to zero.
- `AccumulatedFrames` of one means that the caller processed the previous image before a new one arrived. A larger value means that the OS merged several updates.

So the capture time base equals the `inject.ts` time base. The plan.md "Capture source" section derives Δ, the end frame, and the run uncertainty from these facts. No capture has run yet.

Capture sources: [DuplicateOutput](https://learn.microsoft.com/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutput1-duplicateoutput), [AcquireNextFrame](https://learn.microsoft.com/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutputduplication-acquirenextframe), [DXGI_OUTDUPL_FRAME_INFO](https://learn.microsoft.com/windows/win32/api/dxgi1_2/ns-dxgi1_2-dxgi_outdupl_frame_info), [DuplicateOutput1](https://learn.microsoft.com/windows/win32/api/dxgi1_5/nf-dxgi1_5-idxgioutput5-duplicateoutput1).

**UI Automation driver (T153, T240, T241).** `tauri-driver` and `msedgedriver` are absent (inventory above). The test-only driver `tests/windows/uia.ts` uses UI Automation instead. Microsoft Learn states that a Win32 app shows WebView2 in the accessibility tree as a child of its parent window. It states that Microsoft Edge exposes ARIA roles, states, and properties through UI Automation. It also states that UI Automation does not connect processes that different users start. So the driver runs under the measurement account. T241 confirms each control name on the reference host with the driver and `inspect.exe`.

Driver sources: [WebView2 accessibility tree](https://learn.microsoft.com/microsoft-edge/webview2/concepts/overview-features-apis#rendering-webview2-using-composition), [ARIA and UI Automation in Microsoft Edge](https://learn.microsoft.com/microsoft-edge/accessibility/build/aria-and-ui-automation), [UI Automation overview](https://learn.microsoft.com/windows/win32/winauto/uiauto-uiautomationoverview).

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
| `Win32_System_JobObjects` | `CreateJobObjectW`, `SetInformationJobObject`, `QueryInformationJobObject`, `AssignProcessToJobObject`, `TerminateJobObject`, `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Lingering Jobs add `JOBOBJECT_ASSOCIATE_COMPLETION_PORT`, `JobObjectAssociateCompletionPortInformation`, `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION`, and `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO`. | `Win32/System/JobObjects/mod.rs`. The lingering-Job names have no crate line check; T065 compiles them. |
| `Win32_System_Pipes` | `CreatePipe`. | `Win32/System/Pipes/mod.rs:44`. |
| `Win32_System_IO` | `OVERLAPPED`. It gates `ReadFile` and `WriteFile`. Lingering Jobs add `CreateIoCompletionPort` and `GetQueuedCompletionStatus`. | FileSystem `mod.rs:2112`. The lingering-Job names have no crate line check; T065 compiles them. |
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
| WSL repositories | Probed on the host; unverified | Install Git 2.55.0 or later in a WSL2 distro. Then run the T207 to T209 and T213 suites, and T219 in the installed build (R13). |
| Submodule update | Probed with Git 2.55.0.windows.3; unverified | Run the T221 to T225 and T232 suites, then T237 and T238 in the installed build (R14). The SSH prompt failure needs a test SSH server. Every WSL row needs distro Git 2.55.0 or later. |
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

Mechanical checks covered six design documents, including table-cell sentences. Local links, code fences, sentence lengths, and placeholder checks passed. A re-run after the About window update checked FR-001–FR-037, SC-001–SC-014, F01–F20, and UI-01–UI-15. It found them unique, consecutive, and validly referenced. Note, 2026-10-01: the whole-file staging, WSL, and submodule updates changed the ranges. At that time, they were FR-001–FR-054 and SC-001–SC-017. They were also F01–F31, UI-01–UI-16, and T001–T245. The speed remediation of 2026-10-01 adds SC-015 conditions C1–C20. The UX remediation of 2026-10-01 extends the ranges to F01–F32, UI-01–UI-19, and T001–T251.

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
- `systemd-run --user --scope --quiet --collect --unit=<u>` passed stdin, stdout, and the exit status (S3: 5; S5b: 6, with 7 bytes of stdin). The arguments `a b`, `$HOME`, and `*` stayed literal. A detached child stayed in the scope, and `systemctl --user kill --signal=SIGKILL <u>` ended it. systemd then removed the scope. Starts took 213 to 257 ms with and without a scope.
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

### Consequences and open items

- The route runs before any `FileIdInfo` request, and WSL identity comes from Linux `stat` plus the distro GUID (contract §11).
- The candidate time rule of contract §4 steps 100 ns back. So a rounded UNC time cannot fall after the Linux time.
- A distro without a systemd user manager is refused with reason `no-user-manager`. Closed question, 2026-09-30: the user chose this refusal over an ownership limit (spec Clarifications, 2026-09-30). The remedy tells the user to set `systemd=true` under `[boot]` in `/etc/wsl.conf` and restart the distro (contract §11).
- WSL rows stay `unverified` until a WSL2 distro with Git 2.55.0 or later exists. The reference distro has Git 2.43.0. The user must install a newer Git; the app and its tests never install it. The Git floor refusal can run on the reference distro now.
- P1 proved ownership: a single-scope `cgroup.procs` count, a glob kill, the anchor exit after stdin closes, and the Job-close kill. The anchor count protocol is a design, not a probe result: one count for each stdin line, summed over `arbareto-<operationId>-*.scope`. T205 and T209 test it.
- Unverified: a stopped-distro start time (the probes started no distro), a WSL1 distro, and a distro without systemd. Also unverified: `virtiofs` drive mounts, the atomicity of a replace over the WSL file share, and packaged behavior.
- Design change, 2026-10-01 (spec Clarifications): every wrapper mode now runs its program through `setsid --wait`, not only `network` mode. Reason: a WSL hook in `mutation` mode could open `/dev/tty` on the hidden console and wait until the commit deadline. R14 probe S10 showed that `setsid --wait` under `CREATE_NO_WINDOW` blocks the `/dev/tty` open and passes the exit status. Consequence: Git's children get no `SIGHUP` at the wrapper exit, so the P1 S6 result no longer describes the product. A plain background child now lingers in its scope, as on Windows. The anchor counts it, and the Job close ends it. A distro without `setsid` is refused with reason `no-setsid`.
- Re-probe needed for that change, before T209 can pass. The probe must show this under `setsid --wait` inside a scope in `mutation` mode. A plain, a `nohup`, and a `setsid` child each survive Git's exit. The anchor counts all three, and a Job close ends them within 1 second. A hook that opens `/dev/tty` fails at once. Git's own `daemonize()` still detaches maintenance inside the scope. T209 runs these cases and reports them here. No probe has run them yet.

Sources: [WSL basic commands](https://learn.microsoft.com/windows/wsl/basic-commands), [WSLENV](https://learn.microsoft.com/windows/wsl/filesystems#share-environment-variables-between-windows-and-wsl-with-wslenv), [wsl.conf](https://learn.microsoft.com/windows/wsl/wsl-config#wslconf), [systemd in WSL](https://learn.microsoft.com/windows/wsl/systemd), [background tasks](https://devblogs.microsoft.com/commandline/background-task-support-in-wsl/), Git Extensions source clone (PathUtil.cs, GitExecutor.cs, GitStatusMonitor.cs), git-config(1) `maintenance.autoDetach`, pid_namespaces(7).

## R14. Submodule initialization and update

**Decision (2026-09-30)**: Add Update submodules to this slice. The user decided the scope: initialize and update every submodule recursively (spec Clarifications, 2026-09-30). The operations are `reviewSubmodules` and `updateSubmodules` (contract §12). They raise the operation count from 19 to 21.

**Rationale**: `docs/project-brief.md` line 53 placed submodule management in a later release. The user moved initialization and recursive update into this slice. Git Extensions runs `git submodule update --init --recursive` for all submodules by default, through a process dialog (`SubmoduleUpdateCommand`). Arbareto borrows that behavior, not its GPL-3.0 code.

**Decisions and reasons**:

| Decision | Reason |
| --- | --- |
| Two operations: a read-only review with a one-use token, then the update. | This mirrors `reviewCommit` and `commit`. The token binds the reviewed plan, and a changed plan refuses the start. |
| One Git process for each top-level submodule, with `-- :(literal)<path>`. | The app then knows "i of n" and each exit status without parsing translated text. A plain pathspec matched the wrong submodule (S8). |
| The review runs nine fixed commands inside initialized submodules. | These commands load no index and ran no canary (S3). They narrow the rule that reads never start Git inside a submodule. Reads keep that rule. Since 2026-10-01, they also run in each kept Git directory, with `--work-tree` set to that directory (S11). |
| Refuse commits that no ref holds. | Git detaches HEAD without a warning, and only the reflog keeps such commits until expiry (S4). This slice offers no action that can drop commits (FR-027). |
| Refuse update modes `merge`, `rebase`, and `!command` for existing submodules. | Merge and rebase can leave an unfinished operation. A local `!command` ran a repository command (S5). |
| Refuse an interrupted clone, with the `.git` file path as remedy. | Git cannot recover it alone, and deleting that one file let Git recover (S9). The app never repairs state. |
| Report Git's refusal to overwrite local changes as a failed row. | Git kept the changes and continued with the other submodules (S7). |
| A native confirmation for each run when submodules hold programs. | An update ran submodule monitors, filters, hooks, and transport programs (S3, S6). Their configuration lies inside the Git directory, so it is repository-controlled. |
| The stored fingerprint omits the submodule registration keys. | Git's initialization writes only URL, active, and copied update keys (S1, S5), and none names a program. So the update keeps a stored approval, and no approval loop starts. |
| Keep Git's protocol defaults, and never set a protocol key. | Git blocked `ext` and `file` in submodule clones by default (S6). |
| `GIT_TERMINAL_PROMPT=0`, and no console for the update process. | Git then never prompts on a terminal. Git starts `ssh` detached when it has no console (compat/mingw.c:2251-2261). |
| `setsid --wait` in WSL `network` mode. Replaced on 2026-10-01: every wrapper mode uses it (R11 "UX, start mode, and WSL terminal remediation"). | `wsl.exe` needs a console, and with a hidden console the Linux command could open `/dev/tty` (S10). |
| Keep `--no-lazy-fetch`. | It did not block explicit submodule clones or fetches (S1, S6). |
| A 300-second inactivity deadline and a 4-hour ceiling for each update process. | A fixed 30-second deadline kills large clones. Git prints progress while a transfer advances. The window leaves time for a credential helper sign-in. |
| Progress from the untranslated `NN% (a/b)` counter only. | Git translates every other progress text (progress.c:134). |

**Alternatives considered**:

| Alternative | Finding | Decision |
| --- | --- | --- |
| One `git submodule update --init --recursive` process without a pathspec | "i of n" then needs translated messages or a fixed C locale for hooks. Git printed "aborting" after a failed clone (S6). | Reject. |
| Pass `--checkout` to override configured update modes | It changes the configured behavior silently for one run. | Reject; refuse those modes instead. |
| Persist submodule program approval in the trust record | It changes the record format, and submodule Git directories appear and change with each update. | Reject; confirm each run. |
| Detect dirty submodules before the start | Status inside a submodule loads its index and can run its monitor and filters before confirmation. | Reject; Git's own refusal becomes a failed row. |
| Delete an interrupted clone automatically | FR-016 forbids automatic repair. | Reject; show the file path. |

### Probes S1 to S12

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

### Security notes

- CVE-2024-32002: recursive clones on case-insensitive file systems with symbolic links could run code. The advisory GHSA-8h77-4q3w-gfgv lists fixed versions 2.45.1, 2.44.1, 2.43.4, 2.42.2, 2.41.1, 2.40.2, and 2.39.4. Git for Windows `2.55.0.windows.3` and the distro floor 2.55.0 both contain the fix.
- CVE-2025-48384: broken configuration quoting of a submodule path could run code. The advisory GHSA-vwqx-4fm8-6qc9 lists fixed versions 2.43.7, 2.44.4, 2.45.4, 2.46.4, 2.47.3, 2.48.2, 2.49.1, and 2.50.1. Both admitted Git floors contain the fix.
- A distro package can backport fixes without a version change. The floor compares versions only, so a backport never admits an older Git.
- Defense in depth: the run confirmation lists submodule programs before any runs. Git's protocol defaults block `ext` and unrequested `file` transports.

### Credential helpers

- `GIT_TERMINAL_PROMPT=0` makes Git fail instead of prompting on a terminal (Git `Documentation/git.adoc`).
- Git Credential Manager reads `GIT_TERMINAL_PROMPT` for its terminal prompts only. Its GUI prompts follow `GCM_GUI_PROMPT` or `credential.guiPrompt`, and `GCM_INTERACTIVE` turns off all interaction (GCM `docs/environment.md`; DeepWiki answer on `IsTerminalPromptsEnabled`). So its sign-in window can still appear. The app sets none of these GCM values.
- Unverified: the SSH prompt failure without a console. No SSH server was available. T224 and T237 run it when a test SSH server exists, and record `unverified` otherwise.

### Consequences and open items

- Contract §12 holds the protocol, and FR-047 to FR-054 and SC-017 hold the requirements. F27 to F31 and T220 to T238 hold the tests.
- Speed: network time has no Git Extensions comparison and no budget. The SC-005 input and stall budgets still apply while the update runs. T237 samples them during an F30 clone.
- Closed item, 2026-10-01: contract §6 "Console and input" now starts every Git for Windows process without a console. Git without a console starts each child with `DETACHED_PROCESS` (compat/mingw.c:2247-2263). Every policy sets `GIT_TERMINAL_PROMPT=0`, and each stdin pipe closes after its input. T027 and T162 test a hook that waits for terminal input. Open at that time: a WSL hook outside `network` mode kept the hidden terminal. Closed later on 2026-10-01: every wrapper mode uses `setsid --wait` (contract §11 "Process launch").
- Closed item, 2026-10-01, by a design decision: Git 2.55 offers `extensions.submodulePathConfig`. It places each submodule Git directory by `submodule.<name>.gitdir`, not under `modules/<name>` (git-config(1)). Contract §12 assumes the default layout for `reuse` rows and the kept-directory walk. Under the extension, the review can miss the programs of a kept Git directory. Decision: `reviewSubmodules` refuses with `UNSUPPORTED_SUBMODULE` reason `gitdir-config`. The refusal applies when the extension is enabled or any `submodule.<name>.gitdir` is set. The remedy runs the update in a terminal. FR-049, contract §9 and §12, data-model §9, an F29 variant, and T223 carry the rule. No real-Git run has verified the refusal yet.
- Unverified: every WSL row, because the reference distro has Git 2.43.0. Also the SSH prompt failure, a real credential helper window, and packaged behavior.

Sources: [submodule--helper update strategy](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/submodule--helper.c#L2107-L2147), [initialization active key](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/submodule--helper.c#L596-L597), [current revision failure](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/builtin/submodule--helper.c#L2834-L2838), [GIT_PROTOCOL_FROM_USER](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/git-submodule.sh#L29-L30), [detached ssh](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/compat/mingw.c#L2251-L2261), [progress counter](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/progress.c#L134), [protocol policy](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/config/protocol.adoc), [environment variables](https://github.com/git-for-windows/git/blob/52ca1113d651127f89477a8763f86ab20f645e1d/Documentation/git.adoc), [RelNotes 2.45.0](https://github.com/git/git/blob/master/Documentation/RelNotes/2.45.0.adoc), [GHSA-8h77-4q3w-gfgv](https://github.com/git/git/security/advisories/GHSA-8h77-4q3w-gfgv), [GHSA-vwqx-4fm8-6qc9](https://github.com/git/git/security/advisories/GHSA-vwqx-4fm8-6qc9), [GCM environment](https://github.com/git-ecosystem/git-credential-manager/blob/main/docs/environment.md), [submodule fetch](https://github.com/git/git/blob/v2.55.0/builtin/submodule--helper.c#L2644-L2665), [submodule default remote](https://github.com/git/git/blob/v2.55.0/builtin/submodule--helper.c#L77-L115), [default remote](https://github.com/git/git/blob/v2.55.0/remote.c#L666-L680), [fetch.all](https://github.com/git/git/blob/v2.55.0/builtin/fetch.c#L2700-L2720), [nested Git directory refusal](https://github.com/git/git/blob/v2.55.0/submodule.c#L2402-L2442).

