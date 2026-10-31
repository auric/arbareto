# Research: Discard (Revert) Changes

## R1 Sources and fact marks

- Arbareto code: `main` at `80f32119`. File and line references name that commit.
- Git: the Git v2.56.0 source tree in local scratch (`GIT-VERSION-GEN` `DEF_VER=v2.56.0`), and the investigator facts report of 2026-10-27 (local scratch), which read Git v2.55.0. The Git floor of Arbareto stays 2.55.0 (001 FR-040). A fact from the 2.56.0 source is "source fact"; the batch 0 probes repeat it on the installed Git.
- Git Extensions: the source at commit `a816fb0c`, read on 2026-10-27, for ideas only (GPL-3.0).
- Constitution: `.specify/memory/constitution.md` on `main` `80f32119`, footer line "**Version**: 4.0.0 | **Ratified**: 2026-09-28 | **Last Amended**: 2026-10-22". Version 4.0.1 exists only on the branch `007-first-release` (commit `d5ca8587`, a PATCH that defines "production release"). `CLAUDE.md:19` on `main` already names 4.0.1. Principle I, which this feature depends on, is the same in both versions.
- Marks: "Fact" is checked in source or by a run. "Probe" is an open fact with its test in R14. "Decision" is a plan choice.

## R2 Arbareto writes the working file

- Decision: Arbareto computes the new working bytes and replaces the file in one atomic step through the shell (spec FR-031 to FR-036). No Git command writes a working file for a revert.
- Rationale (facts report, Git v2.55.0): `git apply` without `--cached` runs the clean filter on read and the smudge filter on write (`apply.c:2401-2422`, `:4524`). It removes the old file and then writes the new one (`apply.c:4706`). Checkout unlinks the file and then creates it with `O_EXCL` (`entry.c:577`, `:89`). A failure between the steps leaves no file. Hard links and the read-only attribute are lost. The conversion applies to the whole file.
- Alternatives considered: Git Extensions' `git apply --whitespace=nowarn` on the working tree for lines, and `checkout-index --index --force` for files. Rejected for the reasons above. `git restore` and `git checkout -- <path>`: the same write path, and they run `post-checkout` (R10).

## R3 Index part through the existing publication path

- Fact: `publish()` (`src/git-service/hunk-publish.ts:807`) runs research 001 R3 steps 1 to 14: the exclusion, the recovery marker, the owned index lock (`createIndexLock`, or `wslLock` on WSL), `prepare` (the private candidate and its checks), the step 13 publication, and `reconcilePublication`. `applyHunk` (`:1022`) and `applyFile` reach it through `startPublication` (`:793`). `applyFiles` (`multi-publish.ts:494`) calls `publish()` directly.
- Fact: Unstage lines builds the sub-hunk with `subHunk` (`line-patch.ts:38`) in `admit` (`hunk-publish.ts:945-975`), and the candidate applies it in memory (`hunk-candidate.ts:104` `applyToContent`). Unstage files writes the HEAD entries through `update-index -z --index-info` (`commands.ts:411`, `:415`).
- Fact: a workbench run (`workbench-review.ts:303` `execute`) already holds the exclusion and the recovery marker through `runMarked`. A second `publish()` inside it would enter the exclusion again.
- Decision: split `publish()` at its `steps()` closure (`hunk-publish.ts:841-894`). The new export `publishIndex(session, steps)` holds the lock, `prepare`, and the publication, and returns its `Ending` with the owned files. `publish()` keeps the exclusion, the marker, the registry events, and `reconcilePublication`, and calls `publishIndex`. The revert run calls `publishIndex` inside its workbench run, with the existing `prepare` of Unstage lines (staged lines) or of Unstage files (Revert file). So the candidate checks of 001 FR-013 and FR-014 stay one code path.
- Alternatives considered: a second registered operation for the index part (two operations for one confirmation, and two outcomes for one action); a revert through the 004 `applyFiles` request from the renderer after the confirmation (no single review binds both parts). Both rejected.

## R4 Working-file bytes

- Decision for files (user design change, 2026-10-27): Git writes the working-tree form of the index entry to its own temporary file with `git --no-lazy-fetch checkout-index --temp --stdin -z`, in batches of at most 64 paths (plan D5a). The source is the published HEAD entry (Revert file) or the index entry (Revert all unstaged changes). The service reads the size and a streamed SHA-256 of each temporary file. The shell copies the file beside the target with a streamed SHA-256 that must equal those values, and swaps the copy over the target with the expected check. So no file content enters the service, and no size bound applies.
- Decision for lines: the review reads the working bytes (at most `COMPARED_RAW_VERSION_BYTES`, 1 MiB) and applies the reversed sub-hunk to them in memory (R5). On WSL, the bytes cross out through `fileFacts` with `content: true`, as for the 005 ignore editor.
- Source facts (Git v2.56.0): with `--temp`, `open_output_fd` (`entry.c`) creates `.merge_file_XXXXXX` with `mkstemp` in the current folder. `checkout_entry_ca` returns through `write_entry` before it adds `--prefix` (`state->base_dir`), so `--prefix` does not apply to a temporary file. `checkout-index` has `NEED_WORK_TREE` (`git.c`), so Git first enters the worktree root, and the temporary file lands there. `write_tempfile_record` prints `<temp> TAB <path>` and ends the record with NUL under `-z` (`builtin/checkout-index.c`). With `--temp`, `checkout-index` takes no index lock and writes no index (`builtin/checkout-index.c`, the `index_opt && !state.base_dir_len && !to_tempfile` branch). Probes G9 and G10 check these facts and the conversions on the installed Git.
- Decision (copy beside the target): the shell does not rename Git's temporary file over the target. The temporary file lies in the worktree root. A rename into another folder would keep the root ACL on Windows and the 0600 mode of `mkstemp` on WSL. The copy beside the target keeps the 005 replace path: the delete disposition, the facts copy, and a rename inside the target folder.
- Alternatives considered: `git cat-file --filters --path` into the service and one frame per file (the plan of 2026-10-27 before the design change). Rejected by the user: it needed an 8 MiB file bound, and Git Extensions has no such bound. A rename of Git's temporary file over the target: rejected for the ACL and mode reasons above.

## R5 Line-ending round trip

- Fact: Git's check-in conversion turns CRLF into LF line by line and never joins or splits lines (Git `convert.c` `crlf_to_git`). So line i of the working bytes maps to line i of the check-in form. `ls-files --eol -z` reports the working-file form as `w/lf`, `w/crlf`, `w/mixed`, `w/none`, `w/-text`, or empty (`support.ts:81` `EOL_STATS`, from Git `convert.c` `gather_convert_stats_ascii`).
- Decision: the review splits the working bytes into lines with their own endings. It removes the selected added lines and inserts each selected removed line at its place. A restored line ends with CRLF for `w/crlf` and with LF for `w/lf`. For any other report, and for a line without an ending, it keeps its comparison bytes. Every other line keeps its raw bytes.
- Decision (proof): `git hash-object --path=<path> --stdin` without `-w` of the new bytes must print the blob ID of the expected content. The service computes that ID in memory from the expected content (`blob <size>\0<content>` with the object format hash). A difference refuses with `line-endings`. Probe G3 checks that this command writes no object and loads no index.
- Rationale: Git decides the result through its own conversion. No rule of Arbareto re-derives `convert.c`. The ending rule only picks the bytes to test, and the proof refuses every case where the pick is wrong.
- Alternatives considered: a re-implementation of `convert.c` `crlf_action` (a copy of Git logic that can drift); a refusal of every file with a conversion (it would refuse the common `core.autocrlf=true` setup on Windows). Both rejected.

## R6 The `ident` attribute gap

- Fact: `SUPPORT_ATTRIBUTES` (`support.ts:18`) reads `filter`, `diff`, `text`, `eol`, `crlf`, and `working-tree-encoding`, not `ident`. Hunk staging needs no `ident` value, because `apply --cached` acts on the check-in form, where Git collapses `$Id: …$` to `$Id$` (Git `convert.c` `ident_to_git`).
- Fact: a line revert writes working bytes. A restored line that holds `$Id$` would stay collapsed, while Git's checkout expands it (`ident_to_worktree`). The R5 proof cannot see it, because the check-in form collapses both forms.
- Decision: `SUPPORT_ATTRIBUTES` gains `ident` as its seventh entry. `parseAttributes` and its vectors change with it. A line or hunk revert of a path whose `ident` value is `set` refuses with `ident`. Revert file stays available, because `checkout-index --temp` expands `ident` as checkout does (probe G9).
- Decision (intended change of staging, review of 2026-10-30): staging keeps its results, and one refusal is new. The attribute binding of a comparison and of each staging checkpoint now holds `ident` (`multi-publish.ts` checkpoint, `hunk-publish.ts` checkpoints). A change of only the `ident` value between the review and the publication now gives `STALE_SELECTION`. The binding was incomplete before: Git's check-in conversion runs `ident_to_git` when `ident` is set (Git `convert.c` `convert_to_git`), so the staged blob of a whole file depends on that value. The new refusal is kept for staging, and no other staging decision reads `ident`.

## R7 Attribute direction

- Fact: `checkout-index` sets no attribute direction, so it reads attributes in the check-in direction: the working `.gitattributes` first, then the index (Git `attr.c:856`). Branch checkout reads the index first (`attr.c:852`, set in `unpack-trees.c`). `git restore <path>` goes through `checkout_paths`, which sets no direction (source fact, probe G9).
- Decision: the review reads `git check-attr -z --stdin` and `git check-attr --cached -z --stdin` for `text`, `eol`, `crlf`, `ident`, `filter`, `working-tree-encoding`, and `diff` of every path. A difference in any of the first six refuses with `attributes` (spec FR-038). Probe G4 checks the two reads.

## R8 Windows file facts of the atomic replace

The 005 replace (`src-tauri/src/file_replace.rs:118-270`) walks with relative opens and holds the parent folder and the target (read data, read attributes, sharing read and delete). It checks the link count, the size, and the SHA-256. It creates `.arbareto-<hex>.tmp` beside the target, writes, flushes, and renames with `FILE_RENAME_POSIX_SEMANTICS | FILE_RENAME_REPLACE_IF_EXISTS`. A failure sets the delete disposition on the temporary handle. This item lists each file fact, the decision, and the probe that proves it (R14 W1 to W11).

| Fact | Decision | Proof |
| --- | --- | --- |
| Link count | Refuse a count other than 1 with `hard-link` (spec FR-034). The 005 check (`file_replace.rs:156`) gives `NotRegular` today; the reply gains its own reason. | W4 |
| Read-only attribute | Refuse at review with `read-only`. The rename must fail safe when the attribute appears after the check. | W5 |
| Hidden, system, not-content-indexed | Copy the attribute set of the old file to the temporary file before the rename (`FileBasicInformation`). R15: the copy keeps these three. | W1 |
| Archive | No compared fact. R15: the rename sets it in both sequences, also after the copy, as a new file of Git's checkout has it. | W1 |
| Compressed, sparse, integrity stream | Compare the temporary file with the old file after the create. A difference refuses with `file-attributes`. R15: the copy does not set compressed or sparse and reports no error, so such a target refuses. The integrity stream stays unverified (ReFS only). | W1 |
| Encrypted (EFS) | Refuse with `encrypted`. A temporary file in a folder without encryption would hold plain text. | W11 |
| Owner | Refuse with `owner` when the temporary file gets another owner than the old file. A process cannot set another owner without `SeRestorePrivilege`. | W2 |
| DACL | Copy the DACL of the old file to the temporary file before the rename, through `SetKernelObjectSecurity` on the handle (feature `Win32_Security`, enabled). Compare the owner, group, and DACL of the result with the old file. A difference refuses with `security`. R15: the swap loses an explicit ACE and a protected DACL. `SetKernelObjectSecurity` keeps the protection flag but drops `SE_DACL_AUTO_INHERITED`, unless the copied descriptor carries `SE_DACL_AUTO_INHERIT_REQ`; then the copy is exact in 6 of 6 cases. Decision (2026-10-27): copy the old descriptor with `SE_DACL_AUTO_INHERIT_REQ` set. R15 (review of 2026-10-30): the copy is also exact, before and after the write, for a file whose inherited ACEs differ from those that its folder gives a new file (`renamed-in`, `folder-ace-after`), so 10 of 10 cases keep the descriptor. | W2 |
| SACL and mandatory label | Known limit. Reading them needs `SeSecurityPrivilege`. | W2 records it |
| Creation time | Copy the old creation time to the temporary file before the rename (`FileBasicInformation`). Do not rely on file tunneling. R15: tunneling kept the old time in one sequence and not in the other; the copy keeps it in both. | W3 |
| Last write time | The time of the write, as Git's own checkout gives. | W3 |
| Alternate data streams | Known limit: the new file has none. Git's own checkout drops them too. | W7 |
| Temporary file after a crash | Create the temporary file with the delete disposition on close. Clear it just before the rename. A crash before the clear leaves no file. The window between the clear and the rename stays a known limit. | W6 |
| Another program holds the file | The open or the rename fails with its NT status. The reply gives `sharing-violation` or `access-denied`. No retry (spec FR-037). R15: a holder without write or delete sharing gives STATUS_SHARING_VIOLATION. With Windows Defender on, 0 to 2 of 1,000 renames of fresh files gave STATUS_ACCESS_DENIED. | W8, W9 |
| Missing folders | Create each missing folder below its held parent with `FILE_CREATE` and `FILE_DIRECTORY_FILE`, without following a link (spec FR-020). | W10 |
| Git temporary file (whole files) | `fileReplace` with `source` copies it beside the target and deletes it through its handle. An unused one goes through `tempRemove` with its size and SHA-256. A crash between `checkout-index` and that step leaves `.merge_file_<random>` in the worktree root (known limit). | G10, W6 |

- Rule for every row: a probe that shows another behavior changes this table and contracts/operations.md before WP3 starts, and the change runs `/speckit-analyze`.

## R9 WSL file facts and the crash case

The 005 `wslFiles` mode `replace` (`src/contracts/wsl-process.json` `replace_one`) walks to the parent and checks `S_ISREG`, `st_nlink == 1`, the size, and the SHA-256. It creates `.arbareto-$-replace.tmp` with `O_CREAT|O_EXCL|O_NOFOLLOW` and sets the old mode bits with `chmod`. Then it writes, calls `fsync`, renames, and syncs the folder. An absent target gets `link` and `unlink`, so an existing name gives `stale`.

| Fact | Decision | Proof |
| --- | --- | --- |
| Mode bits | Keep: `fchmod` of the old `st_mode & 07777` on the temporary file after the gid copy, the write, and the fsync. Then an `fstat` compare of the mode bits, then `linkat`. A difference refuses with `owner`. R15: an `fchmod` before the write loses the set-group-ID bit, and an `fchown` after the `fchmod` loses the set-user-ID and set-group-ID bits (chown(2)). The 005 `replace_one` runs `chmod` before the write. | L4 |
| Owner (uid) | Refuse with `owner` when `st_uid` differs from the effective uid of the process. | L5 |
| Group (gid) | `fchown(-1, old gid)` on the temporary file, as the first step after the create, before the write and the mode copy. `EPERM` refuses with `owner`. | L4, L5 |
| Link count | Refuse a count other than 1 with `hard-link` (exists as `refused`). | L4 |
| Extended attributes and POSIX ACLs | Refuse with `xattr` when `llistxattr` lists a name. The new file would lose them. R15: `llistxattr` lists `user.test`; the ACL case is unverified. | L6 |
| Temporary file after a crash | Create the file with `O_TMPFILE` in the parent folder, so it has no name. Give it a name with `linkat(…, AT_SYMLINK_FOLLOW)` through `/proc/self/fd/<n>` just before the rename. A crash before the name leaves no file. The window between `linkat` and `rename` stays a known limit. Without `O_TMPFILE` support, keep the 005 temporary name and record the wider window. R15: L1 to L3 hold on `Ubuntu-26.04`. | L1, L2, L3 |
| Missing folders | `mkdir` with mode 0777, which the umask reduces, as Git's checkout does. | L7 |

- Rule: a probe that shows another behavior changes this table and contracts/operations.md before WP3 starts.

## R10 Hooks

- Fact: `checkout_paths` runs `post-checkout` with the flag 0 (`builtin/checkout.c:717`, Git v2.56.0). `cmd_restore` reaches it through `checkout_main` (`:2234`, `:2099`). githooks(5) names only checkout and switch.
- Fact: `update-index` runs only `post-index-change`. The hunk eligibility refuses a repository with that hook (`eligibility.ts:217`). Probe G6 checks the source list of hooks of `update-index`.
- Fact: `builtin/checkout-index.c` calls no hook function, and with `--temp` it writes no index, so `post-index-change` does not run either (source fact, probe G10).
- Decision (user, 2026-10-27): a revert runs no hook. It runs no Git command that runs a hook, so it skips no hook (spec Clarifications). Constitution I forbids a bypass of the hooks of an operation that Git runs. A revert is not such an operation.

## R11 Bounds

- Decision (review of 2026-10-30): `REVERT_FILE_BYTES` = 2 × `COMPARED_RAW_VERSION_BYTES` + `CANONICAL_DIFF_LINES` = 2,117,152 bytes: the frame bound of a line revert. It is the largest reachable size. The new bytes hold the kept working lines, at most the 1 MiB working read (plan D3, D4). They hold the restored lines, at most the other side of the comparison, which the 001 support rule bounds to 1 MiB (`support.ts` `decideSupport`, `size`). The R5 rule adds at most one CR to each restored line, and each restored line is a line of the canonical diff, at most 20,000 (`diff-parser.ts` `checkBounds`). So the 001 bounds are the visible limit of a line revert, and the frame bound never refuses.
- Fact: the base64 text of 2,117,152 bytes is 2,822,872 bytes, which fits `PIPE_FRAME_BYTES` (16 MiB) with the envelope. The WSL `replace` input holds the bytes in hex (4,234,304 bytes), on stdin. Bun 1.4.4 matches the shared `Base64` pattern up to 6,193,148 decoded bytes, and it returns no match above that without an error (probe in local scratch, 2026-10-30). So the `bytes` field uses the shared pattern again, with a margin of 2.9 times.
- Decision (user, 2026-10-27): Revert file and Revert all unstaged changes have no size bound per file and no size bound per action. Git writes the bytes to disk, and the shell streams them. A full disk fails with its code.
- Decision: one action covers at most `MULTI_FILE_ACTION_FILES` (10,000) files (004 FR-040).
- Decision: line revert keeps the 001 comparison bounds: 1 MiB per version (`COMPARED_RAW_VERSION_BYTES`, `COMPARED_NORMALIZED_VERSION_BYTES`) and 20,000 diff lines (`CANONICAL_DIFF_LINES`). The working read of a line revert also keeps 1 MiB, in the unstaged and in the staged scope (plan D3, D4).
- Decision: the workbench review lifetime `APPROVAL_LIFETIME_MS` (60 s) applies (spec FR-011).
- Rationale: the frame bound applies only where bytes cross the service.
- Decision (deadlines of whole files): `checkout-index --temp`, `fileReplace` with `source`, and `fileFacts` with `stream` get `GIT_PROCESS_DEADLINE_MS` plus 1 s for each started 64 MiB of the sizes involved. This rule replaces `REGISTERED_DEADLINE_CAP_MS` (120 s) for these three requests, so a large file gets a finite deadline without a size limit. The rule assumes at least 64 MiB/s of local disk throughput. Probe W9 and the T048 budget run record the measured throughput. Cancel stops every step.

## R12 Performance budgets and the measurement method

- Budgets: spec SC-007, fixed before the measurement.
- Fixture: the 001 moderate fixture plus a generated revert fixture: 1,000 tracked files of 4 KiB with unstaged changes, 100 files with staged and unstaged changes, one 1 MiB text file with a 2,000-line diff, and one 8 MiB binary file. `tests/windows/perf-fixtures.ts` builds it into the fixture cache.
- Method: the packaged build, warm, median of 10 runs on the reference PC with Windows Defender on, as 005 SC-001 measured. The times run from the key or click input to the visible state through UI Automation events and the CDP marks of `tests/windows/inspection-perf.test.ts`. Memory: the process-tree private working set through `scripts/windows/measure-ram.ps1 -Json`.
- WSL: the same fixture copied into the owned distro folder, measured from the Windows package.

## R13 Texts

- Decision: the spec texts of FR-009, FR-012, FR-016, FR-017, FR-020, FR-023, FR-026, FR-030, FR-038, FR-040, and FR-041 are the visible texts. Plan D11 names the constants. New texts follow ASD-STE100 and say "Arbareto", not "we".
- The existing comparison limitation texts (`limitation-text.ts`) and the hunk eligibility texts (`PROFILE_TEXTS`) stay. The line reasons get revert forms (`revert-text.ts`).

## R14 Open facts (batch 0 probes)

Each probe prints `OBSERVATION <task ID>: <fact> <result>` with the Git, Windows, Bun, or distro version. A probe has no implementation of its own. A failed probe is a finding, not a red task. The batch 0 gate task copies each line into R15, and a finding changes R8, R9, plan.md, and contracts/operations.md before the dependent work package starts.

Git facts (`tests/git/revert-facts.test.ts`, real disposable repositories, the selected Git for Windows):

- G1: withdrawn on 2026-10-27. Revert file no longer uses `cat-file --filters` (G9 replaces it).
- G2: withdrawn on 2026-10-27 (G10 replaces it).
- G3: `git hash-object --path=<p> --stdin` without `-w` prints the blob ID of the check-in form, and `git count-objects -v` and the loose object list stay the same. With `core.fsmonitor` set to a command, the command does not run (a marker file stays absent), so the read needs no read gate.
- G4: `git check-attr -z --stdin` and `git check-attr --cached -z --stdin` give the same seven values without a `.gitattributes` change, and differ exactly for the attributes that a staged or unstaged `.gitattributes` change gives the path.
- G5: `git ls-files --eol -z` gives `w/lf`, `w/crlf`, `w/mixed`, `w/none`, and `w/-text` for the matching working files, and the R5 rule with the `hash-object` proof accepts and refuses the cases of data-model §6. Per case, the plan D13 line oracle (`hash-object --path` of the R5 bytes against the blob of `apply --cached -R` after `add` on a copy), and a record of Git's `apply -R` on a copy against the R5 bytes.
- G6: `builtin/update-index.c` in the Git source names only `post-index-change` as a hook. This is a source fact, so the fact gate (T005) records it from the source at the tag of the selected Git version, not this test file.
- G7: `git restore --source=HEAD --staged --worktree -- <p>` on a staged new file removes the working file. This is the documented SC-002 difference.
- G9: for each fixture, the bytes of `git --no-lazy-fetch checkout-index --temp --stdin -z` for the path equal the bytes that `git restore --worktree -- <p>` writes on a copy, and after a HEAD entry in the index, the bytes of `git restore --source=HEAD --staged --worktree -- <p>`. The head form also checks the exit of both commands, so a failure of both cannot match. Fixtures: no conversion; `core.autocrlf=true`; `core.autocrlf=input`; `text eol=crlf`; `text=auto` with an LF blob and with a CRLF blob; `ident`; `working-tree-encoding=UTF-16LE-BOM`; a clean and smudge filter of a test program in the fixture; a Git LFS-tracked file through a test `filter.lfs` program that needs no network (a capability skip `git-lfs` when `git-lfs` is absent); a binary file; an empty file; a file with mode 100755. Each case that differs is a finding for a user decision. The filter and LFS cases are facts only: the review still refuses `filter` and `LFS` (spec FR-004).
- G10: in the same fixtures, the temporary file lands in the worktree root also with `-C <subfolder>` and with `--prefix=<folder>/`; its name is one component; stdout holds exactly `<temp> TAB <path> NUL` per path; `checkout.workers=4` gives the same files; no other file below the worktree root changes (a digest of every file before and after, without the temporary file); the index file bytes and their time stay; no `index.lock` appears; a `post-checkout` hook and a `post-index-change` hook leave no marker file. On WSL (T004), the same case list runs in the distro.
- G8: after an Arbareto-style write of the G9 bytes, `git --no-optional-locks status --porcelain=v2 -z` shows the entry as unchanged, and the index file bytes stay the same.

Windows facts (`tests/windows/revert-facts.test.ts` through `bun:ffi` on NTFS, and the cargo tests of `file_replace.rs`; `Local: Windows`):

- W1: after the 005 replace sequence, the new file's attributes for an old file with hidden, system, archive, not-content-indexed, compressed, and sparse attributes. Then the same with the attribute copy of R8 after the write, and before the write as plan D8 orders it (`copy-first`). The probe records which attributes survive each sequence.
- W2: the owner, group, and DACL (SDDL) of the new file for an old file with inherited ACEs only, with an explicit ACE, and with a protected DACL. Two more fixtures give the old file other inherited ACEs than a new file in its folder gets: `renamed-in` (the file comes by a rename from a folder with another inheritable ACE) and `folder-ace-after` (`SetKernelObjectSecurity` adds an inheritable ACE to the folder after the file exists, so the ACE reaches no existing file). Then the same with each DACL copy of R8, also before the write (`kernel-auto-inherit-first`), and with a protected copy before the auto-inherit copy (`protect-auto-inherit-first`). The probe also records the owner of a file that an elevated process created, and the owner that the temporary file gets in an unelevated run (a capability skip without an elevated helper). It records that the SACL needs `SeSecurityPrivilege`.
- W3: the creation time of the new file without a copy (file tunneling within 15 s, `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\MaximumTunnelEntries` as found), and with the `FileBasicInformation` copy after and before the write. The last write time is the write time.
- W4: a file with 2 hard links refuses, and both names keep their bytes.
- W5: a target with the read-only attribute: the rename with `FILE_RENAME_POSIX_SEMANTICS | FILE_RENAME_REPLACE_IF_EXISTS` fails with its NT status, and the target keeps its bytes.
- W6: a temporary file created with the delete disposition on close, cleared with `FileDispositionInformationEx` (`FILE_DISPOSITION_FLAG_DO_NOT_DELETE | FILE_DISPOSITION_FLAG_ON_CLOSE`), then renamed. A child process that holds the handle and ends by `TerminateProcess` before the clear leaves no file. A kill after the clear and before the rename leaves the file. The rename after the clear succeeds.
- W7: an old file with the stream `Zone.Identifier` and a user stream: the new file has neither.
- W8: the replace while another process holds the target (a) with write access and read sharing, (b) without delete sharing, and (c) mapped as a section. The probe records the NT status of the open and of the rename for each case.
- W9: 1,000 replaces of fresh files with Windows Defender real-time protection on. The probe records each failure and its status. It retries nothing.
- W10: a missing folder chain created below the held parent; a reparse point at a folder name refuses.
- W11: the encrypted attribute of an EFS file reads through `FileBasicInformation`. A capability skip without EFS.

WSL facts (`tests/wsl/revert-facts.test.ts` in the owned folder of `Ubuntu-26.04`, Git 2.55; `Local: WSL`):

- L1: Perl in the distro gives `O_TMPFILE` through `Fcntl`, or the probe records the value from the kernel UAPI header for the distro architecture. `sysopen` with `O_TMPFILE | O_WRONLY` in the owned worktree folder (ext4) succeeds.
- L2: `syscall(SYS_linkat, AT_FDCWD, "/proc/self/fd/<n>", AT_FDCWD, <name>, AT_SYMLINK_FOLLOW)` from Perl gives the unnamed file a name, as an unprivileged user. The probe records the syscall number of the architecture.
- L3: a `kill -9` of the in-distro process after the `O_TMPFILE` create, after `linkat`, and after `rename`. The probe lists the names in the folder after each kill.
- L4: the mode bits 0644, 0755, 0600, and a setgid file keep their value after `chmod` of the temporary file and the rename. For 02755 and 04755, `fchown(-1, gid)` before the write and after the `fchmod`, with the `fstat` mode before `linkat`. A file with 2 links refuses.
- L5: the temporary file gets the effective uid and gid, or the folder gid in a setgid folder. `fchown(-1, gid)` succeeds for a group of the user and fails with `EPERM` for another group.
- L6: `syscall(SYS_llistxattr)` from Perl lists `user.test` and `system.posix_acl_access` of a fixture file. Without the ACL tools in the distro, the probe sets `user.test` only and records the ACL case as a capability skip.
- L7: `mkdir` of a missing folder chain gives the mode 0777 reduced by the umask, as `git restore` creates on a copy.

## R15 Results

### Batch 0 fact gate (T005), 2026-10-27, and the review runs of 2026-10-31

- Host: Windows 11 Pro 26H2, build 10.0.26300.9711, NTFS, Windows Defender real-time protection on, an unelevated token. Git for Windows 2.56.0.windows.2 with git-lfs 3.8.0. Bun 1.4.4. Cargo and rustc 1.99.0. WSL 3.0.3.0 with kernel 6.18.54.1-1.
- Distro: `Ubuntu-26.04` (Ubuntu 26.04.1 LTS, kernel 6.18.54.1-microsoft-standard-WSL2, ext4) with Git 2.55.0, Perl 5.40.1, and the umask 0022.
- Code under test, 2026-10-27: branch `f008-b0` from `4fb49b48`, with the probe files of T001 to T004. Review runs, 2026-10-31: branch `f008-b0-review` from `1a90e7ee`, with the probe changes of the batch 0 review: the W2 fixtures `renamed-in` and `folder-ace-after`, the copy before the write (W1, W2, W3), the L4 `fchown` cases, the G5 line oracle and `apply -R` record, and the G9 head-form exits. Every `ORIGIN` line of the review runs names the checkout under test.
- Runs of 2026-10-27, each alone behind the test gate: `bun test ./tests/git/revert-facts.test.ts` 18 pass. `bun test ./tests/windows/revert-facts.test.ts` 12 pass. `cargo test --locked --manifest-path src-tauri/Cargo.toml -- --ignored --test-threads=1 --nocapture file_replace::tests::revert_facts` 7 pass. `bun test ./tests/wsl/revert-facts.test.ts` with `ARBARETO_WSL_DISTRO=Ubuntu-26.04` 20 pass and 1 skip.
- Review runs of 2026-10-31, the same commands, each alone behind the test gate: 18 pass; 12 pass; 7 pass; 20 pass and 1 skip. The OBSERVATION blocks below hold these runs.
- Ticks: T001, T003, T004, and T005 are ticked after the review runs. T002 stays open: the tick rules of tasks.md need a green `bun run test:windows` for a `tests/windows` task, and that suite starts the packaged app.
- Unverified: the W2 owner of a file that an elevated process created (`elevated-helper`). The L6 name `system.posix_acl_access` (`acl-tools`). The G9 and G10 LFS fixture in the distro (`git-lfs`). The R8 integrity-stream attribute, because it needs ReFS and the host has no ReFS volume.
- Line format: the G9, G10, and G8 checks of one fixture print one OBSERVATION line. It holds the count of checks that hold, each record, and each check that differs. Each check also prints a `DETAIL` line in the run log.

Facts and their consequences:
- G3 holds for SHA-1 and SHA-256. `hash-object --path --stdin` prints the blob ID of the check-in form, writes no object, and runs no `core.fsmonitor` command. `update-index` and `status` run that command. So plan D2 stays: the eligibility refuses an fsmonitor command before each read that loads the index.
- G4 holds. Both reads give the same seven values without a change. They differ exactly for the attributes that a staged or an unstaged `.gitattributes` change gives the path. R7 stays.
- G5 holds. Each data-model §6 row gives its proof result. An empty working file gives `w/none`, and a deleted file gives an empty `w/` value (Git `convert.c` `get_wt_convert_stats_ascii`). The `ident` record shows that the proof passes for a restored `$Id$` line, while Git's restore writes the expanded form. So the R6 refusal `ident` for lines stays.
- G5 line oracle (review run): in each case, `hash-object --path` of the R5 bytes equals the blob of `apply --cached -R` after `add` on a copy exactly when the proof passes. Git's `apply -R` on a copy gives the R5 bytes in `lf-none`, `crlf-none-index-crlf`, `crlf-autocrlf-true`, and `crlf-text-eol-crlf`. In `lf-autocrlf-true` it gives CRLF for every line (`w/crlf`), while the R5 bytes stay LF. So plan D13 compares a line revert with the line oracle, and with `apply -R` only without a conversion.
- G6 is a source fact of Git for Windows tag `v2.56.0.windows.2`. `builtin/update-index.c` calls no hook function. Its index write (`write_locked_index`, `builtin/update-index.c:1315`) reaches `do_write_locked_index`, which runs only `post-index-change` (`read-cache.c:3168`). `builtin/checkout-index.c` calls no hook function. It takes the index lock and writes the index only with `--index` and without `--prefix` and `--temp` (`builtin/checkout-index.c:286`, `:347`). R10 stays.
- G7 holds. Git's restore removes the working file of a staged new file. The SC-002 difference stays.
- G8 holds on Windows and in the distro. After the plan D8 write of Git's temporary bytes, status shows no worktree change. The status read keeps the index bytes and their time.
- G9 holds for all 13 fixtures on Windows and for the 12 fixtures without LFS in the distro. No fixture differs. The review runs also check the exit of `checkout-index --temp` and of Git's restore for the head form: both exit 0 in every fixture, so no head-form match comes from two failures. User decision, 2026-10-27: the refusal reason `checkout-temp` is removed from the spec, the contract, and the code. The `filter` and `LFS` refusals stay (spec FR-004).
- G10 holds on Windows and in the distro. Git writes `.merge_file_XXXXXX` in the worktree root, also with `-C sub` and with `--prefix=pre/`. With `-C sub`, the printed path is relative to the subfolder, so plan D5a runs `checkout-index` in the worktree root. `checkout-index --temp` exits 0 while an `index.lock` exists, so it takes no index lock. No hook ran. The control runs show that the fixture hooks run for Git's restore and for `update-index`. In the distro, Git's temporary file has the mode 0600, and Git's restore gives 0755 for mode 100755. So the R4 copy beside the target stays.
- W1 differs from the R8 assumption. The `FileBasicInformation` copy keeps hidden, system, and not-content-indexed. The rename sets the archive attribute in both sequences, as a new file of Git's checkout has it. The copy does not set compressed or sparse, and the call reports no error. Consequence (R8 table): the archive attribute is no compared fact, and a compressed or sparse target refuses with `file-attributes`. The review runs give the same attributes when the copy runs before the write (`copy-first`), in the plan D8 order, through FFI and through the cargo test.
- W2 is the T013 input. The swap keeps the DACL only when it equals the DACL that the folder gives a new file. It loses an explicit ACE and a protected DACL, in a plain fixture folder and in an auto-inherited folder. The owner and the group stay in each unelevated case.
- W2 copy methods, in 6 cases (2 folders and 3 file kinds): `SetKernelObjectSecurity` with `DACL_SECURITY_INFORMATION` keeps the ACEs and the protection flag. It drops `SE_DACL_AUTO_INHERITED`, also with `PROTECTED_DACL_SECURITY_INFORMATION` or `UNPROTECTED_DACL_SECURITY_INFORMATION`, so 4 of 6 cases differ.
- W2 exact copy: `SetKernelObjectSecurity` of the old descriptor with `SE_DACL_AUTO_INHERIT_REQ` set through `SetSecurityDescriptorControl` gives an exact copy in 6 of 6 cases. T002 compares the SDDL, and T003 compares the descriptor bytes. Both calls are in the enabled feature `Win32_Security`. Decision for T013 (user, 2026-10-27): WP3 uses this method. `SetSecurityInfo` and `Win32_Security_Authorization` are not used, so no dependency review runs.
- W2 isolation (review run): in the 6 cases above, the old file has the inherited ACEs that its folder gives a new file, so an exact copy and a merge of the new file's inherited ACEs with the copied explicit ACEs give the same result. The documented rule of `SeSetSecurityDescriptorInfoEx` with `SEF_DACL_AUTO_INHERIT` describes such a merge (Microsoft Learn, `SeSetSecurityDescriptorInfoEx` remarks). Two fixtures separate the two: `renamed-in` (the old file keeps the inherited `AU` ACE of the folder it came from) and `folder-ace-after` (the folder has an inheritable `AU` ACE that the old file lacks; no `old-changed` key appears, so nothing propagated). In both folders, `kernel-auto-inherit` gives `same`: the SDDL (T002) and the owner, group, and DACL bytes (T003) equal the old file. `none`, `kernel`, `kernel-flag`, and `SetSecurityInfo` differ in these fixtures. So NTFS keeps the copied inherited ACEs, and no fixture of the 10 cases reaches the `security` refusal. The two-call form `protect-auto-inherit-first` (a protected copy, then the auto-inherit copy) also gives `same` in all 10 cases and is not needed.
- W2 order (review run): the copy before the write (`kernel-auto-inherit-first`) gives `same` in all 10 cases, as the copy after the write does. So the plan D8 order keeps the DACL.
- W2 compared facts: the owner and the group stay in every unelevated case, and T003 compares the owner, group, and DACL bytes. So the write and the bound facts compare the owner, the group, and the DACL (`WindowsWorkingFacts.group`, contract Δ6).
- W2 `SetSecurityInfo` gives an exact copy in 5 of 6 cases. In the plain folder, whose default ACEs are not marked inherited, it adds the parent ACEs again. The call only when the DACL differs gives 6 of 6. It needs `Win32_Security_Authorization`, which `src-tauri/Cargo.toml` does not enable (T003 finding for WP3). The SACL read needs `SeSecurityPrivilege` (error 1314).
- W3: file tunneling kept the old creation time in the cargo sequence (relative create, held target) and not in the FFI sequence. So the R8 rule "do not rely on file tunneling" stays. The copy keeps the creation time in both sequences, also before the write (`copy-first`, review run). The last write time is the write time in every sequence.
- W4 holds. A file with 2 links shows the link count 2. An unchecked replace gives the first name the new bytes and leaves the second name with the old bytes. So the `hard-link` refusal stays.
- W5 holds. The rename over a read-only target fails with STATUS_ACCESS_DENIED (0xc0000022). The target keeps its bytes, and no temporary file stays.
- W6 holds through FFI and through the cargo test. A `TerminateProcess` before the clear leaves no file. A kill after the clear leaves the file. The rename after the clear succeeds.
- W7 holds. The new file has neither stream. The known limit stays.
- W8: a holder with write access and read sharing fails the check open with ERROR_SHARING_VIOLATION (32) and the rename with STATUS_SHARING_VIOLATION (0xc0000043). A holder without delete sharing lets the check open succeed and fails the rename with STATUS_SHARING_VIOLATION. A mapped data section with delete sharing lets the replace succeed. The R8 reply codes stay.
- W9: five runs of 1,000 replaces with Windows Defender on gave 2, 1, 2, 0, and 1 failures (the last one is the review run). Each failure was a rename with STATUS_ACCESS_DENIED (0xc0000022), and the target kept its old bytes. Nothing retried. One replace took 4.3 to 4.6 ms. The streamed copy of 256 MiB ran at 519 to 571 MiB/s, above the 64 MiB/s of R11. Consequence: `access-denied` is a real reply on the reference host. Spec FR-037 stays, so such a file ends `failed {access-denied}` with its old bytes.
- W10 holds. The folder chain comes below the held parent, and a second create collides (STATUS_OBJECT_NAME_COLLISION). A junction at a folder name refuses the open and a create through it with STATUS_REPARSE_POINT_ENCOUNTERED (0xc000050b). Nothing appears in the junction target.
- W11 holds. The user had an EFS key, so `EncryptFileW` created none.
- L1 holds. `Fcntl` gives `O_TMPFILE` 020200000, and the `O_TMPFILE` open in the owned ext4 folder succeeds.
- L2 holds. `linkat` through `/proc/self/fd` with `AT_SYMLINK_FOLLOW` names the file as uid 1000. `syscall.ph` gives `SYS_linkat` 265 on x86_64.
- L3 holds. A `kill -9` after the `O_TMPFILE` create leaves no name. A kill after `linkat` leaves `.arbareto-probe.tmp`. A kill after `rename` leaves only the target with the new bytes.
- L4 differs from the R9 sequence. An `fchmod` before the write loses the set-group-ID bit of a 02755 file. An `fchmod` after the fsync keeps it. 0644, 0755, and 0600 stay in both orders. The 005 `replace_one` runs `chmod` before the write. Consequence (R9 table, plan D9, contract Δ11): the mode copy runs after the write and the fsync, just before `linkat`.
- L4 `fchown` (review run): an `fchown(-1, gid)` after the `fchmod` clears the set-group-ID bit of 02755 and the set-user-ID bit of 04755 (both give 0755 in `fstat` and after the rename), as chown(2) states for an unprivileged caller. An `fchown` before the write keeps 02755 and 04755. Consequence (R9 table, plan D9, contract Δ11): the order is the gid copy, the write, `fsync`, `fchmod`, an `fstat` compare of the mode bits, then `linkat`.
- L5 holds. The new file gets the effective uid and gid. `fchown(-1, 4)` succeeds for a group of the user, and gid 0 gives EPERM (1). A setgid folder gives its gid.
- L6 holds for `user.test` (`SYS_setxattr` 188, `SYS_llistxattr` 195). The ACL case is unverified.
- L7 holds. `mkdir` with 0777 gives 0755 under the umask 0022, as Git's restore creates the folders.

OBSERVATION lines of the review runs of 2026-10-31, copied unchanged:

T001 (`tests/git/revert-facts.test.ts`, Windows):

```text
OBSERVATION T001: version expected="2.56.0.windows.2" observed="2.56.0.windows.2" match=true git=2.56.0.windows.2
OBSERVATION T001: G3.sha1.blob-id-of-check-in-form expected={"exit":0,"id":"b77b4eb1d946f923f61785536da9ca5af6909f06"} observed={"exit":0,"id":"b77b4eb1d946f923f61785536da9ca5af6909f06"} match=true git=2.56.0.windows.2
OBSERVATION T001: G3.sha1.no-object-written expected={"loose":["78/981922613b2afb6025042ff6bd878ac1994e85"],"count":"count:\u00201\nsize:\u00200\nin-pack:\u00200\npacks:\u00200\nsize-pack:\u00200\nprune-packable:\u00200\ngarbage:\u00200\nsize-garbage:\u00200\n"} observed={"loose":["78/981922613b2afb6025042ff6bd878ac1994e85"],"count":"count:\u00201\nsize:\u00200\nin-pack:\u00200\npacks:\u00200\nsize-pack:\u00200\nprune-packable:\u00200\ngarbage:\u00200\nsize-garbage:\u00200\n"} match=true git=2.56.0.windows.2
OBSERVATION T001: G3.sha1.fsmonitor-not-run expected=false observed=false match=true git=2.56.0.windows.2
OBSERVATION T001: G3.sha1.control-status-runs-fsmonitor expected=true observed=true match=true git=2.56.0.windows.2
OBSERVATION T001: G3.sha256.blob-id-of-check-in-form expected={"exit":0,"id":"c09df00b34c4829386abb2efa8f5b224ae71f8a18bd6436a4ae201f43427fb55"} observed={"exit":0,"id":"c09df00b34c4829386abb2efa8f5b224ae71f8a18bd6436a4ae201f43427fb55"} match=true git=2.56.0.windows.2
OBSERVATION T001: G3.sha256.no-object-written expected={"loose":["f8/625e43f9e04f24291f77cdbe4c71b3c2a3b0003f60419b3ed06a058d766c8b"],"count":"count:\u00201\nsize:\u00200\nin-pack:\u00200\npacks:\u00200\nsize-pack:\u00200\nprune-packable:\u00200\ngarbage:\u00200\nsize-garbage:\u00200\n"} observed={"loose":["f8/625e43f9e04f24291f77cdbe4c71b3c2a3b0003f60419b3ed06a058d766c8b"],"count":"count:\u00201\nsize:\u00200\nin-pack:\u00200\npacks:\u00200\nsize-pack:\u00200\nprune-packable:\u00200\ngarbage:\u00200\nsize-garbage:\u00200\n"} match=true git=2.56.0.windows.2
OBSERVATION T001: G3.sha256.fsmonitor-not-run expected=false observed=false match=true git=2.56.0.windows.2
OBSERVATION T001: G3.sha256.control-status-runs-fsmonitor expected=true observed=true match=true git=2.56.0.windows.2
OBSERVATION T001: G4.same-without-change expected={"differ":[],"text":"set","eol":"lf"} observed={"differ":[],"text":"set","eol":"lf"} match=true git=2.56.0.windows.2
OBSERVATION T001: G4.unstaged-change expected={"differ":["eol","ident"],"working":{"eol":"crlf","ident":"set"},"cached":{"eol":"lf","ident":"unspecified"}} observed={"differ":["eol","ident"],"working":{"eol":"crlf","ident":"set"},"cached":{"eol":"lf","ident":"unspecified"}} match=true git=2.56.0.windows.2
OBSERVATION T001: G4.staged-change expected={"differ":["text","eol","filter"],"working":{"text":"set","eol":"lf","filter":"unspecified"},"cached":{"text":"unset","eol":"unspecified","filter":"x"}} observed={"differ":["text","eol","filter"],"working":{"text":"set","eol":"lf","filter":"unspecified"},"cached":{"text":"unset","eol":"unspecified","filter":"x"}} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.working-forms expected={"lf.txt":"lf","crlf.txt":"crlf","mixed.txt":"mixed","none.txt":"none","bin.dat":"-text","empty.txt":"none","deleted.txt":""} observed={"lf.txt":"lf","crlf.txt":"crlf","mixed.txt":"mixed","none.txt":"none","bin.dat":"-text","empty.txt":"none","deleted.txt":""} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.lf-none expected={"eol":"lf","proof":"pass"} observed={"eol":"lf","proof":"pass"} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.lf-none.oracle expected={"cachedExit":0,"checkIn":true} observed={"cachedExit":0,"checkIn":true} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.lf-none.apply-reverse expected="record" observed={"exit":0,"sameBytes":true,"eol":"lf"} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.crlf-none-index-crlf expected={"eol":"crlf","proof":"pass"} observed={"eol":"crlf","proof":"pass"} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.crlf-none-index-crlf.oracle expected={"cachedExit":0,"checkIn":true} observed={"cachedExit":0,"checkIn":true} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.crlf-none-index-crlf.apply-reverse expected="record" observed={"exit":0,"sameBytes":true,"eol":"crlf"} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.crlf-autocrlf-true expected={"eol":"crlf","proof":"pass"} observed={"eol":"crlf","proof":"pass"} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.crlf-autocrlf-true.oracle expected={"cachedExit":0,"checkIn":true} observed={"cachedExit":0,"checkIn":true} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.crlf-autocrlf-true.apply-reverse expected="record" observed={"exit":0,"sameBytes":true,"eol":"crlf"} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.crlf-text-eol-crlf expected={"eol":"crlf","proof":"pass"} observed={"eol":"crlf","proof":"pass"} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.crlf-text-eol-crlf.oracle expected={"cachedExit":0,"checkIn":true} observed={"cachedExit":0,"checkIn":true} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.crlf-text-eol-crlf.apply-reverse expected="record" observed={"exit":0,"sameBytes":true,"eol":"crlf"} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.lf-autocrlf-true expected={"eol":"lf","proof":"pass"} observed={"eol":"lf","proof":"pass"} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.lf-autocrlf-true.oracle expected={"cachedExit":0,"checkIn":true} observed={"cachedExit":0,"checkIn":true} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.lf-autocrlf-true.apply-reverse expected="record" observed={"exit":0,"sameBytes":false,"eol":"crlf"} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.crlf-none-index-lf expected={"eol":"crlf","proof":"fail"} observed={"eol":"crlf","proof":"fail"} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.crlf-none-index-lf.oracle expected={"cachedExit":0,"checkIn":false} observed={"cachedExit":0,"checkIn":false} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.crlf-none-index-lf.apply-reverse expected="record" observed={"exit":0,"sameBytes":false,"eol":"lf"} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.mixed expected={"eol":"mixed"} observed={"eol":"mixed"} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.mixed.oracle expected="record" observed={"cachedExit":0,"checkIn":true} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.mixed.apply-reverse expected="record" observed={"exit":0,"sameBytes":true,"eol":"lf"} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.mixed.record expected="record" observed={"proof":"pass","sameAsRestore":true} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.ident expected={"eol":"lf"} observed={"eol":"lf"} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.ident.oracle expected="record" observed={"cachedExit":0,"checkIn":true} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.ident.apply-reverse expected="record" observed={"exit":0,"sameBytes":false,"eol":"lf"} match=true git=2.56.0.windows.2
OBSERVATION T001: G5.ident.record expected="record" observed={"proof":"pass","sameAsRestore":false} match=true git=2.56.0.windows.2
OBSERVATION T001: G7.staged-new-file expected={"exit":0,"working":false,"index":false} observed={"exit":0,"working":false,"index":false} match=true git=2.56.0.windows.2
OBSERVATION T001: G9-G10-G8.none expected={"holds":21} observed={"holds":21,"records":{"G10.none.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"]}} match=true git=2.56.0.windows.2
OBSERVATION T001: G9-G10-G8.autocrlf-true expected={"holds":21} observed={"holds":21,"records":{"G10.autocrlf-true.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"]}} match=true git=2.56.0.windows.2
OBSERVATION T001: G9-G10-G8.autocrlf-input expected={"holds":21} observed={"holds":21,"records":{"G10.autocrlf-input.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"]}} match=true git=2.56.0.windows.2
OBSERVATION T001: G9-G10-G8.text-eol-crlf expected={"holds":21} observed={"holds":21,"records":{"G10.text-eol-crlf.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"]}} match=true git=2.56.0.windows.2
OBSERVATION T001: G9-G10-G8.text-auto-lf-blob expected={"holds":21} observed={"holds":21,"records":{"G10.text-auto-lf-blob.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"]}} match=true git=2.56.0.windows.2
OBSERVATION T001: G9-G10-G8.text-auto-crlf-blob expected={"holds":21} observed={"holds":21,"records":{"G10.text-auto-crlf-blob.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"]}} match=true git=2.56.0.windows.2
OBSERVATION T001: G9-G10-G8.ident expected={"holds":21} observed={"holds":21,"records":{"G10.ident.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"]}} match=true git=2.56.0.windows.2
OBSERVATION T001: G9-G10-G8.working-tree-encoding expected={"holds":21} observed={"holds":21,"records":{"G10.working-tree-encoding.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"]}} match=true git=2.56.0.windows.2
OBSERVATION T001: G9-G10-G8.clean-smudge-filter expected={"holds":21} observed={"holds":21,"records":{"G10.clean-smudge-filter.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"]}} match=true git=2.56.0.windows.2
OBSERVATION T001: G9-G10-G8.lfs expected={"holds":21} observed={"holds":21,"records":{"G10.lfs.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"]}} match=true git=2.56.0.windows.2
OBSERVATION T001: G9-G10-G8.binary expected={"holds":21} observed={"holds":21,"records":{"G10.binary.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"]}} match=true git=2.56.0.windows.2
OBSERVATION T001: G9-G10-G8.empty expected={"holds":21} observed={"holds":21,"records":{"G10.empty.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"]}} match=true git=2.56.0.windows.2
OBSERVATION T001: G9-G10-G8.mode-100755 expected={"holds":22} observed={"holds":22,"records":{"G10.mode-100755.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"],"G9.mode-100755.modes":{"temp":"666","restored":"666"}}} match=true git=2.56.0.windows.2
```

T002 (`tests/windows/revert-facts.test.ts`):

```text
OBSERVATION T002: host.file-system expected="NTFS" observed="NTFS" match=true os=10.0.26300.9711
OBSERVATION T002: host.token-elevated expected="record" observed=false match=true os=10.0.26300.9711
OBSERVATION T002: W1.hidden.005 expected={"set":true,"step":"renamed","attributes":"0x2"} observed={"set":true,"step":"renamed","attributes":"0x20"} match=false os=10.0.26300.9711
OBSERVATION T002: W1.hidden.copy expected={"set":true,"step":"renamed","attributes":"0x2"} observed={"set":true,"step":"renamed","attributes":"0x22"} match=false os=10.0.26300.9711
OBSERVATION T002: W1.hidden.copy-first expected={"set":true,"step":"renamed","attributes":"0x2"} observed={"set":true,"step":"renamed","attributes":"0x22"} match=false os=10.0.26300.9711
OBSERVATION T002: W1.system.005 expected={"set":true,"step":"renamed","attributes":"0x4"} observed={"set":true,"step":"renamed","attributes":"0x20"} match=false os=10.0.26300.9711
OBSERVATION T002: W1.system.copy expected={"set":true,"step":"renamed","attributes":"0x4"} observed={"set":true,"step":"renamed","attributes":"0x24"} match=false os=10.0.26300.9711
OBSERVATION T002: W1.system.copy-first expected={"set":true,"step":"renamed","attributes":"0x4"} observed={"set":true,"step":"renamed","attributes":"0x24"} match=false os=10.0.26300.9711
OBSERVATION T002: W1.archive-clear.005 expected={"set":true,"step":"renamed","attributes":"0x0"} observed={"set":true,"step":"renamed","attributes":"0x20"} match=false os=10.0.26300.9711
OBSERVATION T002: W1.archive-clear.copy expected={"set":true,"step":"renamed","attributes":"0x0"} observed={"set":true,"step":"renamed","attributes":"0x20"} match=false os=10.0.26300.9711
OBSERVATION T002: W1.archive-clear.copy-first expected={"set":true,"step":"renamed","attributes":"0x0"} observed={"set":true,"step":"renamed","attributes":"0x20"} match=false os=10.0.26300.9711
OBSERVATION T002: W1.not-content-indexed.005 expected={"set":true,"step":"renamed","attributes":"0x2000"} observed={"set":true,"step":"renamed","attributes":"0x20"} match=false os=10.0.26300.9711
OBSERVATION T002: W1.not-content-indexed.copy expected={"set":true,"step":"renamed","attributes":"0x2000"} observed={"set":true,"step":"renamed","attributes":"0x2020"} match=false os=10.0.26300.9711
OBSERVATION T002: W1.not-content-indexed.copy-first expected={"set":true,"step":"renamed","attributes":"0x2000"} observed={"set":true,"step":"renamed","attributes":"0x2020"} match=false os=10.0.26300.9711
OBSERVATION T002: W1.compressed.005 expected={"set":true,"step":"renamed","attributes":"0x820"} observed={"set":true,"step":"renamed","attributes":"0x20"} match=false os=10.0.26300.9711
OBSERVATION T002: W1.compressed.copy expected={"set":true,"step":"renamed","attributes":"0x820"} observed={"set":true,"step":"renamed","attributes":"0x20"} match=false os=10.0.26300.9711
OBSERVATION T002: W1.compressed.copy-first expected={"set":true,"step":"renamed","attributes":"0x820"} observed={"set":true,"step":"renamed","attributes":"0x20"} match=false os=10.0.26300.9711
OBSERVATION T002: W1.sparse.005 expected={"set":true,"step":"renamed","attributes":"0x220"} observed={"set":true,"step":"renamed","attributes":"0x20"} match=false os=10.0.26300.9711
OBSERVATION T002: W1.sparse.copy expected={"set":true,"step":"renamed","attributes":"0x220"} observed={"set":true,"step":"renamed","attributes":"0x20"} match=false os=10.0.26300.9711
OBSERVATION T002: W1.sparse.copy-first expected={"set":true,"step":"renamed","attributes":"0x220"} observed={"set":true,"step":"renamed","attributes":"0x20"} match=false os=10.0.26300.9711
OBSERVATION T002: unverified W2.elevated-created-owner (missing capability elevated-helper)
OBSERVATION T002: W2.plain.inherited-only expected="record" observed={"oldDacl":"D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","none":"same","kernel":"same","kernel-flag":"same","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","protect-auto-inherit-first":"same","set-security-info":"owner=true\u0020group=true\u0020D:AI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","set-security-info-if-differs":"same"} match=true os=10.0.26300.9711
OBSERVATION T002: W2.plain.explicit-ace expected="record" observed={"oldDacl":"D:AI(A;;FR;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","none":"owner=true\u0020group=true\u0020D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","kernel":"owner=true\u0020group=true\u0020D:(A;;FR;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-flag":"owner=true\u0020group=true\u0020D:(A;;FR;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","protect-auto-inherit-first":"same","set-security-info":"same","set-security-info-if-differs":"same"} match=true os=10.0.26300.9711
OBSERVATION T002: W2.plain.protected expected="record" observed={"oldDacl":"D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","none":"owner=true\u0020group=true\u0020D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","kernel":"owner=true\u0020group=true\u0020D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","kernel-flag":"owner=true\u0020group=true\u0020D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","protect-auto-inherit-first":"same","set-security-info":"same","set-security-info-if-differs":"same"} match=true os=10.0.26300.9711
OBSERVATION T002: W2.plain.renamed-in expected="record" observed={"oldDacl":"D:AI(A;ID;0x1200a9;;;AU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","none":"owner=true\u0020group=true\u0020D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","kernel":"owner=true\u0020group=true\u0020D:(A;ID;0x1200a9;;;AU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-flag":"owner=true\u0020group=true\u0020D:(A;ID;0x1200a9;;;AU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","protect-auto-inherit-first":"same","set-security-info":"owner=true\u0020group=true\u0020D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","set-security-info-if-differs":"owner=true\u0020group=true\u0020D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)"} match=true os=10.0.26300.9711
OBSERVATION T002: W2.plain.folder-ace-after expected="record" observed={"oldDacl":"D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","none":"owner=true\u0020group=true\u0020D:(A;;0x1200a9;;;AU)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","kernel":"same","kernel-flag":"same","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","protect-auto-inherit-first":"same","set-security-info":"owner=true\u0020group=true\u0020D:AI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)(A;ID;0x1200a9;;;AU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","set-security-info-if-differs":"owner=true\u0020group=true\u0020D:AI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)(A;ID;0x1200a9;;;AU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","folderDacl":"D:(A;OICI;0x1200a9;;;AU)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;<user>)"} match=true os=10.0.26300.9711
OBSERVATION T002: W2.auto-inherited.inherited-only expected="record" observed={"oldDacl":"D:AI(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","none":"same","kernel":"owner=true\u0020group=true\u0020D:(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-flag":"owner=true\u0020group=true\u0020D:(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","protect-auto-inherit-first":"same","set-security-info":"same","set-security-info-if-differs":"same"} match=true os=10.0.26300.9711
OBSERVATION T002: W2.auto-inherited.explicit-ace expected="record" observed={"oldDacl":"D:AI(A;;FR;;;BU)(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","none":"owner=true\u0020group=true\u0020D:AI(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel":"owner=true\u0020group=true\u0020D:(A;;FR;;;BU)(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-flag":"owner=true\u0020group=true\u0020D:(A;;FR;;;BU)(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","protect-auto-inherit-first":"same","set-security-info":"same","set-security-info-if-differs":"same"} match=true os=10.0.26300.9711
OBSERVATION T002: W2.auto-inherited.protected expected="record" observed={"oldDacl":"D:PAI(A;;0x1200a9;;;BU)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","none":"owner=true\u0020group=true\u0020D:AI(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel":"owner=true\u0020group=true\u0020D:P(A;;0x1200a9;;;BU)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","kernel-flag":"owner=true\u0020group=true\u0020D:P(A;;0x1200a9;;;BU)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","protect-auto-inherit-first":"same","set-security-info":"same","set-security-info-if-differs":"same"} match=true os=10.0.26300.9711
OBSERVATION T002: W2.auto-inherited.renamed-in expected="record" observed={"oldDacl":"D:AI(A;ID;0x1200a9;;;AU)(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","none":"owner=true\u0020group=true\u0020D:AI(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel":"owner=true\u0020group=true\u0020D:(A;ID;0x1200a9;;;AU)(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-flag":"owner=true\u0020group=true\u0020D:(A;ID;0x1200a9;;;AU)(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","protect-auto-inherit-first":"same","set-security-info":"owner=true\u0020group=true\u0020D:AI(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","set-security-info-if-differs":"owner=true\u0020group=true\u0020D:AI(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)"} match=true os=10.0.26300.9711
OBSERVATION T002: W2.auto-inherited.folder-ace-after expected="record" observed={"oldDacl":"D:AI(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","none":"owner=true\u0020group=true\u0020D:(A;;0x1200a9;;;AU)(A;;0x1200a9;;;BU)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","kernel":"owner=true\u0020group=true\u0020D:(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-flag":"owner=true\u0020group=true\u0020D:(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","protect-auto-inherit-first":"same","set-security-info":"owner=true\u0020group=true\u0020D:AI(A;ID;0x1200a9;;;AU)(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","set-security-info-if-differs":"owner=true\u0020group=true\u0020D:AI(A;ID;0x1200a9;;;AU)(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","folderDacl":"D:(A;OICI;0x1200a9;;;AU)(A;OICI;0x1200a9;;;BU)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;<user>)"} match=true os=10.0.26300.9711
OBSERVATION T002: W2.new-file-owner expected="record" observed={"elevated":false,"owner":"<user>"} match=true os=10.0.26300.9711
OBSERVATION T002: W2.sacl-open expected=1314 observed=1314 match=true os=10.0.26300.9711
OBSERVATION T002: W3.tunnel-registry expected="record" observed={"MaximumTunnelEntries":{"error":2},"MaximumTunnelEntryAgeInSeconds":{"error":2}} match=true os=10.0.26300.9711
OBSERVATION T002: W3.creation.005 expected="record" observed={"set":true,"step":"renamed","keepsOldCreation":false} match=true os=10.0.26300.9711
OBSERVATION T002: W3.last-write-is-write-time.005 expected={"oldIs2020":true,"recent":true,"equalsOld":false} observed={"oldIs2020":true,"recent":true,"equalsOld":false} match=true os=10.0.26300.9711
OBSERVATION T002: W3.creation.copy expected={"set":true,"step":"renamed","keepsOldCreation":true} observed={"set":true,"step":"renamed","keepsOldCreation":true} match=true os=10.0.26300.9711
OBSERVATION T002: W3.last-write-is-write-time.copy expected={"oldIs2020":true,"recent":true,"equalsOld":false} observed={"oldIs2020":true,"recent":true,"equalsOld":false} match=true os=10.0.26300.9711
OBSERVATION T002: W3.creation.copy-first expected={"set":true,"step":"renamed","keepsOldCreation":true} observed={"set":true,"step":"renamed","keepsOldCreation":true} match=true os=10.0.26300.9711
OBSERVATION T002: W3.last-write-is-write-time.copy-first expected={"oldIs2020":true,"recent":true,"equalsOld":false} observed={"oldIs2020":true,"recent":true,"equalsOld":false} match=true os=10.0.26300.9711
OBSERVATION T002: W4.link-count expected={"linked":true,"links":2,"bytes":{"a":"old\n","b":"old\n"}} observed={"linked":true,"links":2,"bytes":{"a":"old\n","b":"old\n"}} match=true os=10.0.26300.9711
OBSERVATION T002: W4.unchecked-replace expected={"step":"renamed","a":"new\n","b":"old\n","linksAfter":1} observed={"step":"renamed","a":"new\n","b":"old\n","linksAfter":1} match=true os=10.0.26300.9711
OBSERVATION T002: W5.read-only-target expected={"step":"rename","status":"0xc0000022","bytes":"old\n"} observed={"step":"rename","status":"0xc0000022","bytes":"old\n"} match=true os=10.0.26300.9711
OBSERVATION T002: W5.no-temporary-file expected=[] observed=[] match=true os=10.0.26300.9711
OBSERVATION T002: W6.control-close-deletes expected=false observed=false match=true os=10.0.26300.9711
OBSERVATION T002: W6.terminate-before-clear expected={"ready":"held","exists":false} observed={"ready":"held","exists":false} match=true os=10.0.26300.9711
OBSERVATION T002: W6.terminate-after-clear expected={"ready":"held\u0020cleared","exists":true} observed={"ready":"held\u0020cleared","exists":true} match=true os=10.0.26300.9711
OBSERVATION T002: W6.rename-after-clear expected={"step":"renamed","bytes":"new\n","temps":[]} observed={"step":"renamed","bytes":"new\n","temps":[]} match=true os=10.0.26300.9711
OBSERVATION T002: W7.streams expected={"before":{"Zone.Identifier":"present","user.stream":"present"},"step":"renamed","after":{"Zone.Identifier":"error-2","user.stream":"error-2"}} observed={"before":{"Zone.Identifier":"present","user.stream":"present"},"step":"renamed","after":{"Zone.Identifier":"error-2","user.stream":"error-2"}} match=true os=10.0.26300.9711
OBSERVATION T002: W8.write-read expected="record" observed={"ready":"held","checkError":32,"step":"rename","status":"0xc0000043","bytes":"old\n"} match=true os=10.0.26300.9711
OBSERVATION T002: W8.no-delete-share expected="record" observed={"ready":"held","checkError":0,"step":"rename","status":"0xc0000043","bytes":"old\n"} match=true os=10.0.26300.9711
OBSERVATION T002: W8.section expected="record" observed={"ready":"held\u0020mapped","checkError":0,"step":"renamed","status":"0x0","bytes":"new\n"} match=true os=10.0.26300.9711
OBSERVATION T002: W9.defender-real-time expected="on" observed="on" match=true os=10.0.26300.9711
OBSERVATION T002: W9.replaces expected={"failures":[],"wrongBytes":[]} observed={"failures":["697:rename:0xc0000022"],"wrongBytes":["f697.txt"]} match=false os=10.0.26300.9711
OBSERVATION T002: W9.replace-time expected="record" observed={"count":1000,"totalMs":4378,"perReplaceMs":4.38} match=true os=10.0.26300.9711
OBSERVATION T002: W9.streamed-copy-at-least-64-MiBps expected={"flushed":true,"atLeast":true} observed={"flushed":true,"atLeast":true} match=true os=10.0.26300.9711
OBSERVATION T002: W9.streamed-copy-time expected="record" observed={"MiB":256,"ms":443,"MiBps":578.1} match=true os=10.0.26300.9711
OBSERVATION T002: W10.folder-chain expected={"a":"0x0","b":"0x0","exists":true} observed={"a":"0x0","b":"0x0","exists":true} match=true os=10.0.26300.9711
OBSERVATION T002: W10.existing-folder-create expected="0xc0000035" observed="0xc0000035" match=true os=10.0.26300.9711
OBSERVATION T002: W10.junction-at-folder-name expected={"junction":0,"open":"0xc000050b","create":"0xc000050b","outside":[]} observed={"junction":0,"open":"0xc000050b","create":"0xc000050b","outside":[]} match=true os=10.0.26300.9711
OBSERVATION T002: W11.encrypted-attribute expected=true observed=true match=true os=10.0.26300.9711
```

T002 `W9.replaces` lines of the four runs of 2026-10-27 with the same W9 code:

```text
OBSERVATION T002: W9.replaces expected={"failures":[],"wrongBytes":[]} observed={"failures":[],"wrongBytes":[]} match=true os=10.0.26300.9711
OBSERVATION T002: W9.replaces expected={"failures":[],"wrongBytes":[]} observed={"failures":["392:rename:0xc0000022","705:rename:0xc0000022"],"wrongBytes":["f392.txt","f705.txt"]} match=false os=10.0.26300.9711
OBSERVATION T002: W9.replaces expected={"failures":[],"wrongBytes":[]} observed={"failures":["957:rename:0xc0000022"],"wrongBytes":["f957.txt"]} match=false os=10.0.26300.9711
OBSERVATION T002: W9.replaces expected={"failures":[],"wrongBytes":[]} observed={"failures":["513:rename:0xc0000022","812:rename:0xc0000022"],"wrongBytes":["f513.txt","f812.txt"]} match=false os=10.0.26300.9711
```

T003 (`src-tauri/src/file_replace.rs` `revert_facts`):

```text
OBSERVATION T003: W10.junction-at-folder-name expected={"refused":true,"reparse":true} observed={"refused":true,"reparse":true} match=true os=10.0.26300
OBSERVATION T003: W1.hidden-copy.txt expected={"attributes":"0x2","result":{"step":"renamed"},"set":true} observed={"attributes":"0x22","result":{"step":"renamed"},"set":true} match=false os=10.0.26300
OBSERVATION T003: W1.hidden-copy-first.txt expected={"attributes":"0x2","result":{"step":"renamed"},"set":true} observed={"attributes":"0x22","result":{"step":"renamed"},"set":true} match=false os=10.0.26300
OBSERVATION T003: W1.system-005.txt expected={"attributes":"0x4","result":{"step":"renamed"},"set":true} observed={"attributes":"0x20","result":{"step":"renamed"},"set":true} match=false os=10.0.26300
OBSERVATION T003: W1.system-copy.txt expected={"attributes":"0x4","result":{"step":"renamed"},"set":true} observed={"attributes":"0x24","result":{"step":"renamed"},"set":true} match=false os=10.0.26300
OBSERVATION T003: W1.system-copy-first.txt expected={"attributes":"0x4","result":{"step":"renamed"},"set":true} observed={"attributes":"0x24","result":{"step":"renamed"},"set":true} match=false os=10.0.26300
OBSERVATION T003: W1.archive-clear-005.txt expected={"attributes":"0x0","result":{"step":"renamed"},"set":true} observed={"attributes":"0x20","result":{"step":"renamed"},"set":true} match=false os=10.0.26300
OBSERVATION T003: W1.archive-clear-copy.txt expected={"attributes":"0x0","result":{"step":"renamed"},"set":true} observed={"attributes":"0x20","result":{"step":"renamed"},"set":true} match=false os=10.0.26300
OBSERVATION T003: W1.archive-clear-copy-first.txt expected={"attributes":"0x0","result":{"step":"renamed"},"set":true} observed={"attributes":"0x20","result":{"step":"renamed"},"set":true} match=false os=10.0.26300
OBSERVATION T003: W1.not-content-indexed-005.txt expected={"attributes":"0x2000","result":{"step":"renamed"},"set":true} observed={"attributes":"0x20","result":{"step":"renamed"},"set":true} match=false os=10.0.26300
OBSERVATION T003: W1.not-content-indexed-copy.txt expected={"attributes":"0x2000","result":{"step":"renamed"},"set":true} observed={"attributes":"0x2020","result":{"step":"renamed"},"set":true} match=false os=10.0.26300
OBSERVATION T003: W1.not-content-indexed-copy-first.txt expected={"attributes":"0x2000","result":{"step":"renamed"},"set":true} observed={"attributes":"0x2020","result":{"step":"renamed"},"set":true} match=false os=10.0.26300
OBSERVATION T003: W1.compressed-005.txt expected={"attributes":"0x820","result":{"step":"renamed"},"set":true} observed={"attributes":"0x20","result":{"step":"renamed"},"set":true} match=false os=10.0.26300
OBSERVATION T003: W1.compressed-copy.txt expected={"attributes":"0x820","result":{"step":"renamed"},"set":true} observed={"attributes":"0x20","result":{"step":"renamed"},"set":true} match=false os=10.0.26300
OBSERVATION T003: W1.compressed-copy-first.txt expected={"attributes":"0x820","result":{"step":"renamed"},"set":true} observed={"attributes":"0x20","result":{"step":"renamed"},"set":true} match=false os=10.0.26300
OBSERVATION T003: W1.sparse-005.txt expected={"attributes":"0x220","result":{"step":"renamed"},"set":true} observed={"attributes":"0x20","result":{"step":"renamed"},"set":true} match=false os=10.0.26300
OBSERVATION T003: W1.sparse-copy.txt expected={"attributes":"0x220","result":{"step":"renamed"},"set":true} observed={"attributes":"0x20","result":{"step":"renamed"},"set":true} match=false os=10.0.26300
OBSERVATION T003: W1.sparse-copy-first.txt expected={"attributes":"0x220","result":{"step":"renamed"},"set":true} observed={"attributes":"0x20","result":{"step":"renamed"},"set":true} match=false os=10.0.26300
OBSERVATION T003: W2.plain.inherited-only expected="record" observed={"kernel":"same","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","kernel-flag":"same","none":"same","protect-auto-inherit-first":"same"} match=true os=10.0.26300
OBSERVATION T003: W2.plain.explicit-ace expected="record" observed={"kernel":"differs","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","kernel-flag":"differs","none":"differs","protect-auto-inherit-first":"same"} match=true os=10.0.26300
OBSERVATION T003: W2.plain.protected expected="record" observed={"kernel":"differs","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","kernel-flag":"differs","none":"differs","protect-auto-inherit-first":"same"} match=true os=10.0.26300
OBSERVATION T003: W2.plain.renamed-in expected="record" observed={"kernel":"differs","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","kernel-flag":"differs","none":"differs","protect-auto-inherit-first":"same"} match=true os=10.0.26300
OBSERVATION T003: W2.plain.folder-ace-after expected="record" observed={"kernel":"same","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","kernel-flag":"same","none":"differs","protect-auto-inherit-first":"same"} match=true os=10.0.26300
OBSERVATION T003: W2.auto-inherited.inherited-only expected="record" observed={"kernel":"differs","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","kernel-flag":"differs","none":"same","protect-auto-inherit-first":"same"} match=true os=10.0.26300
OBSERVATION T003: W2.auto-inherited.explicit-ace expected="record" observed={"kernel":"differs","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","kernel-flag":"differs","none":"differs","protect-auto-inherit-first":"same"} match=true os=10.0.26300
OBSERVATION T003: W2.auto-inherited.protected expected="record" observed={"kernel":"differs","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","kernel-flag":"differs","none":"differs","protect-auto-inherit-first":"same"} match=true os=10.0.26300
OBSERVATION T003: W2.auto-inherited.renamed-in expected="record" observed={"kernel":"differs","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","kernel-flag":"differs","none":"differs","protect-auto-inherit-first":"same"} match=true os=10.0.26300
OBSERVATION T003: W2.auto-inherited.folder-ace-after expected="record" observed={"kernel":"differs","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","kernel-flag":"differs","none":"differs","protect-auto-inherit-first":"same"} match=true os=10.0.26300
OBSERVATION T003: W3.creation.copy expected={"keepsOldCreation":true,"result":{"step":"renamed"},"set":true} observed={"keepsOldCreation":true,"result":{"step":"renamed"},"set":true} match=true os=10.0.26300
OBSERVATION T003: W3.creation.copy-first expected={"keepsOldCreation":true,"result":{"step":"renamed"},"set":true} observed={"keepsOldCreation":true,"result":{"step":"renamed"},"set":true} match=true os=10.0.26300
OBSERVATION T003: W6.terminate-after-clear expected={"exists":true,"ready":"READY\u0020held\u0020cleared"} observed={"exists":true,"ready":"READY\u0020held\u0020cleared"} match=true os=10.0.26300
OBSERVATION T003: W6.rename-after-clear expected={"bytes":"new\n","result":{"step":"renamed"}} observed={"bytes":"new\n","result":{"step":"renamed"}} match=true os=10.0.26300
```

T004 (`tests/wsl/revert-facts.test.ts`, `Ubuntu-26.04`):

```text
OBSERVATION T004: versions expected="record" observed={"distro":"Ubuntu-26.04","pretty":"Ubuntu\u002026.04.1\u0020LTS","kernel":"6.18.54.1-microsoft-standard-WSL2","perl":"5.040001","git":"2.55.0"} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L1.o-tmpfile expected={"tmpfile":"20200000","source":"Fcntl","open":1,"errno":0,"names":[]} observed={"tmpfile":"20200000","source":"Fcntl","open":1,"errno":0,"names":[]} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L2.linkat expected={"errno":0,"content":"linked\n","links":1} observed={"errno":0,"content":"linked\n","links":1} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L2.syscall expected="record" observed={"nr":265,"source":"syscall.ph","arch":"x86_64","uid":1000,"fileUid":1000} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L3.kill-after-tmpfile expected={"names":["target"],"target":"old\n"} observed={"names":["target"],"target":"old\n"} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L3.kill-after-linkat expected={"names":[".arbareto-probe.tmp","target"],"target":"old\n"} observed={"names":[".arbareto-probe.tmp","target"],"target":"old\n"} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L3.kill-after-rename expected={"names":["target"],"target":"new\n"} observed={"names":["target"],"target":"new\n"} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L4.mode-first-m2755 expected={"after":"2755","content":"new\n"} observed={"after":"755","content":"new\n"} match=false git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L4.mode-first-m600 expected={"after":"600","content":"new\n"} observed={"after":"600","content":"new\n"} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L4.mode-first-m644 expected={"after":"644","content":"new\n"} observed={"after":"644","content":"new\n"} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L4.mode-first-m755 expected={"after":"755","content":"new\n"} observed={"after":"755","content":"new\n"} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L4.mode-last-m2755 expected={"after":"2755","content":"new\n"} observed={"after":"2755","content":"new\n"} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L4.mode-last-m600 expected={"after":"600","content":"new\n"} observed={"after":"600","content":"new\n"} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L4.mode-last-m644 expected={"after":"644","content":"new\n"} observed={"after":"644","content":"new\n"} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L4.mode-last-m755 expected={"after":"755","content":"new\n"} observed={"after":"755","content":"new\n"} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L4.chown-first-m2755 expected={"fstat":"2755","after":"2755","content":"new\n"} observed={"fstat":"2755","after":"2755","content":"new\n"} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L4.chown-first-m4755 expected={"fstat":"4755","after":"4755","content":"new\n"} observed={"fstat":"4755","after":"4755","content":"new\n"} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L4.chown-last-m2755 expected={"fstat":"755","after":"755","content":"new\n"} observed={"fstat":"755","after":"755","content":"new\n"} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L4.chown-last-m4755 expected={"fstat":"755","after":"755","content":"new\n"} observed={"fstat":"755","after":"755","content":"new\n"} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L4.second-link-count expected=2 observed=2 match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L5.effective-ids expected={"uid":1000,"gid":1000} observed={"uid":1000,"gid":1000} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L5.fchown-own-group expected={"changed":1,"errno":0,"gidAfter":4} observed={"changed":1,"errno":0,"gidAfter":4} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L5.setgid-folder-gid expected=4 observed=4 match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L5.fchown-foreign-group expected={"changed":0,"errno":1} observed={"changed":0,"errno":1} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L6.syscalls expected="record" observed={"setxattr":{"errno":0,"nr":188,"result":0},"llistxattr":{"errno":0,"nr":195}} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L6.llistxattr expected=["user.test"] observed=["user.test"] match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L7.mkdir-mode expected={"restore":0,"git":["755","755"],"perl":["755","755"]} observed={"restore":0,"git":["755","755"],"perl":["755","755"]} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: L7.umask expected="record" observed="0022" match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: G9-G10-G8.none expected={"holds":21} observed={"holds":21,"records":{"G10.none.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"]}} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: G9-G10-G8.autocrlf-true expected={"holds":21} observed={"holds":21,"records":{"G10.autocrlf-true.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"]}} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: G9-G10-G8.autocrlf-input expected={"holds":21} observed={"holds":21,"records":{"G10.autocrlf-input.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"]}} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: G9-G10-G8.text-eol-crlf expected={"holds":21} observed={"holds":21,"records":{"G10.text-eol-crlf.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"]}} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: G9-G10-G8.text-auto-lf-blob expected={"holds":21} observed={"holds":21,"records":{"G10.text-auto-lf-blob.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"]}} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: G9-G10-G8.text-auto-crlf-blob expected={"holds":21} observed={"holds":21,"records":{"G10.text-auto-crlf-blob.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"]}} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: G9-G10-G8.ident expected={"holds":21} observed={"holds":21,"records":{"G10.ident.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"]}} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: G9-G10-G8.working-tree-encoding expected={"holds":21} observed={"holds":21,"records":{"G10.working-tree-encoding.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"]}} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: G9-G10-G8.clean-smudge-filter expected={"holds":21} observed={"holds":21,"records":{"G10.clean-smudge-filter.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"]}} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: G9-G10-G8.binary expected={"holds":21} observed={"holds":21,"records":{"G10.binary.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"]}} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: G9-G10-G8.empty expected={"holds":21} observed={"holds":21,"records":{"G10.empty.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"]}} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T004: G9-G10-G8.mode-100755 expected={"holds":22} observed={"holds":22,"records":{"G10.mode-100755.name-form":[".merge_file_XXXXXX",".merge_file_XXXXXX"],"G9.mode-100755.modes":{"temp":"600","restored":"755"}}} match=true git=2.55.0@Ubuntu-26.04
```
