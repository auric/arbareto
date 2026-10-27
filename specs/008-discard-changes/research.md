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
- Decision: `SUPPORT_ATTRIBUTES` gains `ident` as its seventh entry. `parseAttributes` and its vectors change with it. A line or hunk revert of a path whose `ident` value is `set` refuses with `ident`. Revert file stays available, because `checkout-index --temp` expands `ident` as checkout does (probe G9). Staging keeps its behavior.

## R7 Attribute direction

- Fact: `checkout-index` sets no attribute direction, so it reads attributes in the check-in direction: the working `.gitattributes` first, then the index (Git `attr.c:856`). Branch checkout reads the index first (`attr.c:852`, set in `unpack-trees.c`). `git restore <path>` goes through `checkout_paths`, which sets no direction (source fact, probe G9).
- Decision: the review reads `git check-attr -z --stdin` and `git check-attr --cached -z --stdin` for `text`, `eol`, `crlf`, `ident`, `filter`, `working-tree-encoding`, and `diff` of every path. A difference in any of the first six refuses with `attributes` (spec FR-038). Probe G4 checks the two reads.

## R8 Windows file facts of the atomic replace

The 005 replace (`src-tauri/src/file_replace.rs:118-270`) walks with relative opens and holds the parent folder and the target (read data, read attributes, sharing read and delete). It checks the link count, the size, and the SHA-256. It creates `.arbareto-<hex>.tmp` beside the target, writes, flushes, and renames with `FILE_RENAME_POSIX_SEMANTICS | FILE_RENAME_REPLACE_IF_EXISTS`. A failure sets the delete disposition on the temporary handle. This item lists each file fact, the decision, and the probe that proves it (R14 W1 to W11).

| Fact | Decision | Proof |
| --- | --- | --- |
| Link count | Refuse a count other than 1 with `hard-link` (spec FR-034). The 005 check (`file_replace.rs:156`) gives `NotRegular` today; the reply gains its own reason. | W4 |
| Read-only attribute | Refuse at review with `read-only`. The rename must fail safe when the attribute appears after the check. | W5 |
| Hidden, system, archive, not-content-indexed | Copy the attribute set of the old file to the temporary file before the rename (`FileBasicInformation`). | W1 |
| Compressed, sparse, integrity stream | Compare the temporary file with the old file after the create. A difference refuses with `file-attributes`. | W1 |
| Encrypted (EFS) | Refuse with `encrypted`. A temporary file in a folder without encryption would hold plain text. | W11 |
| Owner | Refuse with `owner` when the temporary file gets another owner than the old file. A process cannot set another owner without `SeRestorePrivilege`. | W2 |
| DACL | Conditional on W2 (user decision, 2026-10-27). When W2 shows that the swap loses the file's own DACL, copy the DACL with its protection flag to the temporary file before the rename, through `SetKernelObjectSecurity` on the handle (feature `Win32_Security`, enabled). When that call cannot set the protection flag, use `SetSecurityInfo` (feature `Win32_Security_Authorization`, through its dependency review). Compare the owner, group, and DACL of the result with the old file. A difference refuses with `security`. When W2 shows that the swap keeps the DACL, no copy runs. | W2 |
| SACL and mandatory label | Known limit. Reading them needs `SeSecurityPrivilege`. | W2 records it |
| Creation time | Copy the old creation time to the temporary file before the rename (`FileBasicInformation`). Do not rely on file tunneling. | W3 |
| Last write time | The time of the write, as Git's own checkout gives. | W3 |
| Alternate data streams | Known limit: the new file has none. Git's own checkout drops them too. | W7 |
| Temporary file after a crash | Create the temporary file with the delete disposition on close. Clear it just before the rename. A crash before the clear leaves no file. The window between the clear and the rename stays a known limit. | W6 |
| Another program holds the file | The open or the rename fails with its NT status. The reply gives `sharing-violation` or `access-denied`. No retry (spec FR-037). | W8, W9 |
| Missing folders | Create each missing folder below its held parent with `FILE_CREATE` and `FILE_DIRECTORY_FILE`, without following a link (spec FR-020). | W10 |
| Git temporary file (whole files) | `fileReplace` with `source` copies it beside the target and deletes it through its handle. An unused one goes through `tempRemove` with its size and SHA-256. A crash between `checkout-index` and that step leaves `.merge_file_<random>` in the worktree root (known limit). | G10, W6 |

- Rule for every row: a probe that shows another behavior changes this table and contracts/operations.md before WP3 starts, and the change runs `/speckit-analyze`.

## R9 WSL file facts and the crash case

The 005 `wslFiles` mode `replace` (`src/contracts/wsl-process.json` `replace_one`) walks to the parent and checks `S_ISREG`, `st_nlink == 1`, the size, and the SHA-256. It creates `.arbareto-$-replace.tmp` with `O_CREAT|O_EXCL|O_NOFOLLOW` and sets the old mode bits with `chmod`. Then it writes, calls `fsync`, renames, and syncs the folder. An absent target gets `link` and `unlink`, so an existing name gives `stale`.

| Fact | Decision | Proof |
| --- | --- | --- |
| Mode bits | Keep: `chmod` of the old `st_mode & 07777` on the temporary file (exists). | L4 |
| Owner (uid) | Refuse with `owner` when `st_uid` differs from the effective uid of the process. | L5 |
| Group (gid) | `fchown(-1, old gid)` on the temporary file. `EPERM` refuses with `owner`. | L5 |
| Link count | Refuse a count other than 1 with `hard-link` (exists as `refused`). | L4 |
| Extended attributes and POSIX ACLs | Refuse with `xattr` when `llistxattr` lists a name. The new file would lose them. | L6 |
| Temporary file after a crash | Create the file with `O_TMPFILE` in the parent folder, so it has no name. Give it a name with `linkat(…, AT_SYMLINK_FOLLOW)` through `/proc/self/fd/<n>` just before the rename. A crash before the name leaves no file. The window between `linkat` and `rename` stays a known limit. Without `O_TMPFILE` support, keep the 005 temporary name and record the wider window. | L1, L2, L3 |
| Missing folders | `mkdir` with mode 0777, which the umask reduces, as Git's checkout does. | L7 |

- Rule: a probe that shows another behavior changes this table and contracts/operations.md before WP3 starts.

## R10 Hooks

- Fact: `checkout_paths` runs `post-checkout` with the flag 0 (`builtin/checkout.c:717`, Git v2.56.0). `cmd_restore` reaches it through `checkout_main` (`:2234`, `:2099`). githooks(5) names only checkout and switch.
- Fact: `update-index` runs only `post-index-change`. The hunk eligibility refuses a repository with that hook (`eligibility.ts:217`). Probe G6 checks the source list of hooks of `update-index`.
- Fact: `builtin/checkout-index.c` calls no hook function, and with `--temp` it writes no index, so `post-index-change` does not run either (source fact, probe G10).
- Decision (user, 2026-10-27): a revert runs no hook. It runs no Git command that runs a hook, so it skips no hook (spec Clarifications). Constitution I forbids a bypass of the hooks of an operation that Git runs. A revert is not such an operation.

## R11 Bounds

- Decision: `REVERT_FILE_BYTES` = 8 MiB (8,388,608): the frame bound of a line revert. The base64 text of 8 MiB is 11,184,812 bytes, which fits `PIPE_FRAME_BYTES` (16 MiB) with the envelope. The WSL `replace` input holds the bytes in hex (16 MiB), on stdin. The 001 comparison bound (1 MiB) is the smaller bound today. A chunked transfer can lift the frame bound later.
- Decision (user, 2026-10-27): Revert file and Revert all unstaged changes have no size bound per file and no size bound per action. Git writes the bytes to disk, and the shell streams them. A full disk fails with its code.
- Decision: one action covers at most `MULTI_FILE_ACTION_FILES` (10,000) files (004 FR-040).
- Decision: line revert keeps the 001 comparison bounds: 1 MiB per version (`COMPARED_RAW_VERSION_BYTES`, `COMPARED_NORMALIZED_VERSION_BYTES`) and 20,000 diff lines (`CANONICAL_DIFF_LINES`).
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
- G5: `git ls-files --eol -z` gives `w/lf`, `w/crlf`, `w/mixed`, `w/none`, and `w/-text` for the matching working files, and the R5 rule with the `hash-object` proof accepts and refuses the cases of data-model §6.
- G6: `builtin/update-index.c` in the Git source names only `post-index-change` as a hook. This is a source fact, so the fact gate (T005) records it from the source at the tag of the selected Git version, not this test file.
- G7: `git restore --source=HEAD --staged --worktree -- <p>` on a staged new file removes the working file. This is the documented SC-002 difference.
- G9: for each fixture, the bytes of `git --no-lazy-fetch checkout-index --temp --stdin -z` for the path equal the bytes that `git restore --worktree -- <p>` writes on a copy, and after a HEAD entry in the index, the bytes of `git restore --source=HEAD --staged --worktree -- <p>`. Fixtures: no conversion; `core.autocrlf=true`; `core.autocrlf=input`; `text eol=crlf`; `text=auto` with an LF blob and with a CRLF blob; `ident`; `working-tree-encoding=UTF-16LE-BOM`; a clean and smudge filter of a test program in the fixture; a Git LFS-tracked file through a test `filter.lfs` program that needs no network (a capability skip `git-lfs` when `git-lfs` is absent); a binary file; an empty file; a file with mode 100755. Each case that differs becomes a `checkout-temp` refusal (spec FR-038). The filter and LFS cases are facts only: the review still refuses `filter` and `LFS` (spec FR-004).
- G10: in the same fixtures, the temporary file lands in the worktree root also with `-C <subfolder>` and with `--prefix=<folder>/`; its name is one component; stdout holds exactly `<temp> TAB <path> NUL` per path; `checkout.workers=4` gives the same files; no other file below the worktree root changes (a digest of every file before and after, without the temporary file); the index file bytes and their time stay; no `index.lock` appears; a `post-checkout` hook and a `post-index-change` hook leave no marker file. On WSL (T004), the same case list runs in the distro.
- G8: after an Arbareto-style write of the G9 bytes, `git --no-optional-locks status --porcelain=v2 -z` shows the entry as unchanged, and the index file bytes stay the same.

Windows facts (`tests/windows/revert-facts.test.ts` through `bun:ffi` on NTFS, and the cargo tests of `file_replace.rs`; `Local: Windows`):

- W1: after the 005 replace sequence, the new file's attributes for an old file with hidden, system, archive, not-content-indexed, compressed, and sparse attributes. Then the same with the attribute copy of R8. The probe records which attributes survive each sequence.
- W2: the owner, group, and DACL (SDDL) of the new file for an old file with inherited ACEs only, with an explicit ACE, and with a protected DACL. Then the same with the DACL copy of R8. The probe also records the owner of a file that an elevated process created, and the owner that the temporary file gets in an unelevated run (a capability skip without an elevated helper). It records that the SACL needs `SeSecurityPrivilege`.
- W3: the creation time of the new file without a copy (file tunneling within 15 s, `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\MaximumTunnelEntries` as found), and with the `FileBasicInformation` copy. The last write time is the write time.
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
- L4: the mode bits 0644, 0755, 0600, and a setgid file keep their value after `chmod` of the temporary file and the rename. A file with 2 links refuses.
- L5: the temporary file gets the effective uid and gid, or the folder gid in a setgid folder. `fchown(-1, gid)` succeeds for a group of the user and fails with `EPERM` for another group.
- L6: `syscall(SYS_llistxattr)` from Perl lists `user.test` and `system.posix_acl_access` of a fixture file. Without the ACL tools in the distro, the probe sets `user.test` only and records the ACL case as a capability skip.
- L7: `mkdir` of a missing folder chain gives the mode 0777 reduced by the umask, as `git restore` creates on a copy.

## R15 Results

The batch 0 gate task (tasks.md) adds the probe results here, with the date, the host build, and the versions.
