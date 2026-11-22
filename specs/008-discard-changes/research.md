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
- Fact (T060, Git v2.55.0 and v2.56.0 `convert.c`): `ls-files --eol` prints the attribute action as `attr/` (`builtin/ls-files.c` `write_eolinfo`, `get_convert_attr_ascii`). `convert_attrs` makes the action CRLF_BINARY for `attr/-text`, and for an empty `attr/` with `core.autocrlf=false`. For CRLF_BINARY, `output_eol` gives EOL_UNSET. So `crlf_to_worktree` writes the blob bytes, and `crlf_to_git` keeps the working bytes.
- Decision: the review splits the working bytes into lines with their own endings. It removes the selected added lines and inserts each selected removed line at its place. Without a line-ending conversion (CRLF_BINARY), a restored line keeps its comparison bytes, as Git's checkout writes them. With any other action, a restored line ends with CRLF for `w/crlf` and with LF for `w/lf`. For any other report, and for a line without an ending, it keeps its comparison bytes. Every other line keeps its raw bytes. `core.autocrlf` comes from the trust listing (the last entry wins, and `false` is the default). A cut listing or a value that Git cannot read refuses with `line-endings`.
- Decision (proof): `git hash-object --path=<path> --stdin` without `-w` of the new bytes must print the blob ID of the expected content. The service computes that ID in memory from the expected content (`blob <size>\0<content>` with the object format hash). A difference refuses with `line-endings`. Probe G3 checks that this command writes no object and loads no index.
- Rationale: Git decides the result through its own conversion. The ending rule reads only Git's own attribute action and `core.autocrlf`, and only to find CRLF_BINARY. `core.eol` never makes CRLF_BINARY, so the rule does not read it. The ending rule only picks the bytes to test, and the proof refuses every case where the pick is wrong.
- Alternatives considered: a re-implementation of `convert.c` `crlf_action` (a copy of Git logic that can drift); a refusal of every file with a conversion (it would refuse the common `core.autocrlf=true` setup on Windows); the `output_eol` ending for every action (it puts a CRLF line into an LF file under `core.autocrlf=true`, against spec FR-015, and it needs the native line ending of the Git build, which no Git output gives). All rejected.

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

- Budgets: spec SC-007. The busy, confirmation, 1 GiB, and Cancel budgets were fixed before the measurement. On 2026-11-15, the user moved the end point of the Cancel budget (R15 "SC-007 Cancel decision"). On 2026-11-17, the user restored the 001 5 s target from Cancel to the outcome (R15 "v0.1.3 packaged result"). The refreshed-diff, multi-file, and 10,000-file memory budgets come from the batch 4 measurements, as a product trade-off under constitution VII. R15 "Batch 4 budget decisions" holds their approval state.
- Fixture: the 001 moderate fixture plus a generated revert fixture: 1,000 tracked files of 4 KiB with unstaged changes, 100 files with staged and unstaged changes, one 1 MiB text file with a 2,000-line diff, and one 8 MiB binary file. `tests/windows/perf-fixtures.ts` builds it into the fixture cache.
- Method: the packaged build, warm, median of 10 runs on the reference PC with Windows Defender on, as 005 SC-001 measured. The times run from the key or click input to the visible state through UI Automation events and the CDP marks of `tests/windows/inspection-perf.test.ts`. Memory: the `PrivateMemorySize64` sum through `scripts/windows/measure-ram.ps1 -Json`. The 1 GiB case measures the service process subtree (`arbareto-git.exe` and its children). The limit case at 10,000 files measures the whole `arbareto.exe` tree. Amended 2026-11-03 (user decision): the "before" value of the limit case and of the 1 GiB case is the median of the 250 ms samples in the 5 s window before the run starts (at the limit, before the confirmation click). The peak growth is the highest sample up to the run end minus that median. The retained growth is the median of the 5 s window that ends 30 s after the run end minus that median. A window with less than 5 s of samples fails the run. The single-sample values and the 5 s minimum stay as `OBSERVATION` lines. R15 "Memory baseline decision, 2026-11-03" records the cause.
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
- W2: the owner, group, and DACL (SDDL) of the new file for an old file with inherited ACEs only, with an explicit ACE, and with a protected DACL. Two more fixtures give the old file other inherited ACEs than a new file in its folder gets: `renamed-in` (the file comes by a rename from a folder with another inheritable ACE) and `folder-ace-after` (`SetKernelObjectSecurity` adds an inheritable ACE to the folder after the file exists, so the ACE reaches no existing file). Then the same with each DACL copy of R8, also before the write (`kernel-auto-inherit-first`). The probe also records the owner of a file that an elevated process created, and the owner that the temporary file gets in an unelevated run (a capability skip without an elevated helper). It records that the SACL needs `SeSecurityPrivilege`.
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
- G5 `crlf-none-index-lf` (superseded by the T060 rule, 2026-11-01): the `proof: "fail"` record and the `G5.crlf-none-index-lf` OBSERVATION lines below test the old rule, which took the `w/crlf` ending. The probe still applies that old rule. The T060 rule (R5) makes the empty `attr/` value with `core.autocrlf=false` CRLF_BINARY, so each restored line keeps its LF comparison bytes. New result (2026-11-01, Git 2.56.0.windows.2): the proof passes. The T060 case of `tests/git/revert-lines.test.ts` passes the plan D13 line oracle and equals Git's `apply -R` on a copy. The T060 cases of `tests/git/revert-bytes.test.ts` give the LF bytes. The run of the five revert files gave 85 pass and 0 fail.
- G6 is a source fact of Git for Windows tag `v2.56.0.windows.2`. `builtin/update-index.c` calls no hook function. Its index write (`write_locked_index`, `builtin/update-index.c:1315`) reaches `do_write_locked_index`, which runs only `post-index-change` (`read-cache.c:3168`). `builtin/checkout-index.c` calls no hook function. It takes the index lock and writes the index only with `--index` and without `--prefix` and `--temp` (`builtin/checkout-index.c:286`, `:347`). R10 stays.
- G7 holds. Git's restore removes the working file of a staged new file. The SC-002 difference stays.
- G8 holds on Windows and in the distro. After the plan D8 write of Git's temporary bytes, status shows no worktree change. The status read keeps the index bytes and their time.
- G9 holds for all 13 fixtures on Windows and for the 12 fixtures without LFS in the distro. No fixture differs. The review runs also check the exit of `checkout-index --temp` and of Git's restore for the head form: both exit 0 in every fixture, so no head-form match comes from two failures. User decision, 2026-10-27: the refusal reason `checkout-temp` is removed from the spec, the contract, and the code. The `filter` and `LFS` refusals stay (spec FR-004).
- G10 holds on Windows and in the distro. Git writes `.merge_file_XXXXXX` in the worktree root, also with `-C sub` and with `--prefix=pre/`. With `-C sub`, the printed path is relative to the subfolder, so plan D5a runs `checkout-index` in the worktree root. `checkout-index --temp` exits 0 while an `index.lock` exists, so it takes no index lock. No hook ran. The control runs show that the fixture hooks run for Git's restore and for `update-index`. In the distro, Git's temporary file has the mode 0600, and Git's restore gives 0755 for mode 100755. So the R4 copy beside the target stays.
- W1 differs from the R8 assumption. The `FileBasicInformation` copy keeps hidden, system, and not-content-indexed. The rename sets the archive attribute in both sequences, as a new file of Git's checkout has it. The copy does not set compressed or sparse, and the call reports no error. Consequence (R8 table): the archive attribute is no compared fact, and a compressed or sparse target refuses with `file-attributes`. The review runs give the same attributes when the copy runs before the write (`copy-first`), in the plan D8 order, through FFI and through the cargo test.
- W2 is the T013 input. The swap keeps the DACL only when it equals the DACL that the folder gives a new file. It loses an explicit ACE and a protected DACL, in a plain fixture folder and in an auto-inherited folder. The owner and the group stay in each unelevated case.
- W2 copy methods, in 6 cases (2 folders and 3 file kinds): `SetKernelObjectSecurity` with `DACL_SECURITY_INFORMATION` keeps the ACEs and the protection flag. It drops `SE_DACL_AUTO_INHERITED`, also with `PROTECTED_DACL_SECURITY_INFORMATION` or `UNPROTECTED_DACL_SECURITY_INFORMATION`, so 4 of 6 cases differ.
- W2 exact copy: `SetKernelObjectSecurity` of the old descriptor with `SE_DACL_AUTO_INHERIT_REQ` set through `SetSecurityDescriptorControl` gives an exact copy in 6 of 6 cases. T002 compares the SDDL, and T003 compares the descriptor bytes. Both calls are in the enabled feature `Win32_Security`. Decision for T013 (user, 2026-10-27): WP3 uses this method. `SetSecurityInfo` and `Win32_Security_Authorization` are not used, so no dependency review runs.
- W2 isolation (review run): in the 6 cases above, the old file has the inherited ACEs that its folder gives a new file, so an exact copy and a merge of the new file's inherited ACEs with the copied explicit ACEs give the same result. The documented rule of `SeSetSecurityDescriptorInfoEx` with `SEF_DACL_AUTO_INHERIT` describes such a merge (Microsoft Learn, `SeSetSecurityDescriptorInfoEx` remarks). Two fixtures separate the two: `renamed-in` (the old file keeps the inherited `AU` ACE of the folder it came from) and `folder-ace-after` (the folder has an inheritable `AU` ACE that the old file lacks; no `old-changed` key appears, so nothing propagated). In both folders, `kernel-auto-inherit` gives `same`: the SDDL (T002) and the owner, group, and DACL bytes (T003) equal the old file. `none`, `kernel`, `kernel-flag`, and `SetSecurityInfo` differ in these fixtures. So NTFS keeps the copied inherited ACEs, and no fixture of the 10 cases reaches the `security` refusal.
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
OBSERVATION T002: W2.plain.inherited-only expected="record" observed={"oldDacl":"D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","none":"same","kernel":"same","kernel-flag":"same","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","set-security-info":"owner=true\u0020group=true\u0020D:AI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","set-security-info-if-differs":"same"} match=true os=10.0.26300.9711
OBSERVATION T002: W2.plain.explicit-ace expected="record" observed={"oldDacl":"D:AI(A;;FR;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","none":"owner=true\u0020group=true\u0020D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","kernel":"owner=true\u0020group=true\u0020D:(A;;FR;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-flag":"owner=true\u0020group=true\u0020D:(A;;FR;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","set-security-info":"same","set-security-info-if-differs":"same"} match=true os=10.0.26300.9711
OBSERVATION T002: W2.plain.protected expected="record" observed={"oldDacl":"D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","none":"owner=true\u0020group=true\u0020D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","kernel":"owner=true\u0020group=true\u0020D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","kernel-flag":"owner=true\u0020group=true\u0020D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","set-security-info":"same","set-security-info-if-differs":"same"} match=true os=10.0.26300.9711
OBSERVATION T002: W2.plain.renamed-in expected="record" observed={"oldDacl":"D:AI(A;ID;0x1200a9;;;AU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","none":"owner=true\u0020group=true\u0020D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","kernel":"owner=true\u0020group=true\u0020D:(A;ID;0x1200a9;;;AU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-flag":"owner=true\u0020group=true\u0020D:(A;ID;0x1200a9;;;AU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","set-security-info":"owner=true\u0020group=true\u0020D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","set-security-info-if-differs":"owner=true\u0020group=true\u0020D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)"} match=true os=10.0.26300.9711
OBSERVATION T002: W2.plain.folder-ace-after expected="record" observed={"oldDacl":"D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","none":"owner=true\u0020group=true\u0020D:(A;;0x1200a9;;;AU)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","kernel":"same","kernel-flag":"same","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","set-security-info":"owner=true\u0020group=true\u0020D:AI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)(A;ID;0x1200a9;;;AU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","set-security-info-if-differs":"owner=true\u0020group=true\u0020D:AI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)(A;ID;0x1200a9;;;AU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","folderDacl":"D:(A;OICI;0x1200a9;;;AU)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;<user>)"} match=true os=10.0.26300.9711
OBSERVATION T002: W2.auto-inherited.inherited-only expected="record" observed={"oldDacl":"D:AI(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","none":"same","kernel":"owner=true\u0020group=true\u0020D:(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-flag":"owner=true\u0020group=true\u0020D:(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","set-security-info":"same","set-security-info-if-differs":"same"} match=true os=10.0.26300.9711
OBSERVATION T002: W2.auto-inherited.explicit-ace expected="record" observed={"oldDacl":"D:AI(A;;FR;;;BU)(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","none":"owner=true\u0020group=true\u0020D:AI(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel":"owner=true\u0020group=true\u0020D:(A;;FR;;;BU)(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-flag":"owner=true\u0020group=true\u0020D:(A;;FR;;;BU)(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","set-security-info":"same","set-security-info-if-differs":"same"} match=true os=10.0.26300.9711
OBSERVATION T002: W2.auto-inherited.protected expected="record" observed={"oldDacl":"D:PAI(A;;0x1200a9;;;BU)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","none":"owner=true\u0020group=true\u0020D:AI(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel":"owner=true\u0020group=true\u0020D:P(A;;0x1200a9;;;BU)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","kernel-flag":"owner=true\u0020group=true\u0020D:P(A;;0x1200a9;;;BU)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","set-security-info":"same","set-security-info-if-differs":"same"} match=true os=10.0.26300.9711
OBSERVATION T002: W2.auto-inherited.renamed-in expected="record" observed={"oldDacl":"D:AI(A;ID;0x1200a9;;;AU)(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","none":"owner=true\u0020group=true\u0020D:AI(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel":"owner=true\u0020group=true\u0020D:(A;ID;0x1200a9;;;AU)(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-flag":"owner=true\u0020group=true\u0020D:(A;ID;0x1200a9;;;AU)(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","set-security-info":"owner=true\u0020group=true\u0020D:AI(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","set-security-info-if-differs":"owner=true\u0020group=true\u0020D:AI(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)"} match=true os=10.0.26300.9711
OBSERVATION T002: W2.auto-inherited.folder-ace-after expected="record" observed={"oldDacl":"D:AI(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","none":"owner=true\u0020group=true\u0020D:(A;;0x1200a9;;;AU)(A;;0x1200a9;;;BU)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)","kernel":"owner=true\u0020group=true\u0020D:(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-flag":"owner=true\u0020group=true\u0020D:(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","set-security-info":"owner=true\u0020group=true\u0020D:AI(A;ID;0x1200a9;;;AU)(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","set-security-info-if-differs":"owner=true\u0020group=true\u0020D:AI(A;ID;0x1200a9;;;AU)(A;ID;0x1200a9;;;BU)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;<user>)","folderDacl":"D:(A;OICI;0x1200a9;;;AU)(A;OICI;0x1200a9;;;BU)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;<user>)"} match=true os=10.0.26300.9711
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
OBSERVATION T003: W2.plain.inherited-only expected="record" observed={"kernel":"same","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","kernel-flag":"same","none":"same"} match=true os=10.0.26300
OBSERVATION T003: W2.plain.explicit-ace expected="record" observed={"kernel":"differs","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","kernel-flag":"differs","none":"differs"} match=true os=10.0.26300
OBSERVATION T003: W2.plain.protected expected="record" observed={"kernel":"differs","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","kernel-flag":"differs","none":"differs"} match=true os=10.0.26300
OBSERVATION T003: W2.plain.renamed-in expected="record" observed={"kernel":"differs","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","kernel-flag":"differs","none":"differs"} match=true os=10.0.26300
OBSERVATION T003: W2.plain.folder-ace-after expected="record" observed={"kernel":"same","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","kernel-flag":"same","none":"differs"} match=true os=10.0.26300
OBSERVATION T003: W2.auto-inherited.inherited-only expected="record" observed={"kernel":"differs","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","kernel-flag":"differs","none":"same"} match=true os=10.0.26300
OBSERVATION T003: W2.auto-inherited.explicit-ace expected="record" observed={"kernel":"differs","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","kernel-flag":"differs","none":"differs"} match=true os=10.0.26300
OBSERVATION T003: W2.auto-inherited.protected expected="record" observed={"kernel":"differs","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","kernel-flag":"differs","none":"differs"} match=true os=10.0.26300
OBSERVATION T003: W2.auto-inherited.renamed-in expected="record" observed={"kernel":"differs","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","kernel-flag":"differs","none":"differs"} match=true os=10.0.26300
OBSERVATION T003: W2.auto-inherited.folder-ace-after expected="record" observed={"kernel":"differs","kernel-auto-inherit":"same","kernel-auto-inherit-first":"same","kernel-flag":"differs","none":"differs"} match=true os=10.0.26300
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

### Batch 0 verification (T011), 2026-10-31

- Code under test: branch `f008-b0-verify` from `4d729e84`, with the `protect-auto-inherit-first` W2 method removed from both probe files. Every `ORIGIN` line names the checkout under test.
- Runs, each alone behind the test gate: `bun run typecheck` exit 0. `bun run export:schemas --check` exit 0. `bun run test:contracts` 6,024 pass, 37 skip, 0 fail. `bun run test:fast` 6,190 pass, 37 skip, 0 fail in 127 files. `cargo test --locked --manifest-path src-tauri/Cargo.toml` 610 pass, 16 ignored, 0 fail.
- Control mutation: without the `revert-files` phase in `src/contracts/operations.ts`, `bun run test:contracts` gives 3 fail (the phase counters, the schema files, and the vector `valid/revert-progress-files.json`). After the restore, it gives 6,024 pass, 37 skip, 0 fail.
- W2 after the removal: the cargo probe `w2_dacl_copy` and the W2 test of `tests/windows/revert-facts.test.ts` give the W2 `OBSERVATION` lines above without the removed key. The decided method stays `kernel-auto-inherit`.
- The batch 0 review ran before this verification. Commit `4d729e84` holds its fixes.

### Batch 1 verification (T024), 2026-10-31

- Code under test: branch `f008-b1-shell` at `41404a35`. Every `ORIGIN` line names the checkout under test. Each run ran alone behind the test gate.
- The batch 1 review ran before this verification. Commits `d0d09b83`, `fbab3f21`, and `41404a35` hold its fixes.
- `bun run typecheck` exit 0. `bun run test:contracts` 6,041 pass, 37 skip, 0 fail in 125 files.
- `bun run test:git` reached its 150-minute limit after 110 of 126 files, with no failed test. A second run of the other 16 files (`submodule-update` to `wsl-files`) gave 480 pass, 2 skip, 0 fail.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml` gave 643 pass, 1 fail, 16 ignored. The failed test is `a_working_replace_writes_the_bytes_and_keeps_the_r8_facts`: its compare `last_write_time() > old_write` depends on the system clock tick. It also fails alone. T054 removes the clock dependency.
- WSL, alone, `ARBARETO_WSL_DISTRO=Ubuntu-26.04`: `tests/wsl/revert-wsl-files.test.ts` and `tests/wsl/revert-facts.test.ts` gave 35 pass, 1 skip (`git-lfs`), 0 fail. The 005 replace cases of `tests/wsl/inspection-wsl.test.ts` (`-t replace`) gave 8 pass, 0 fail.
- Control mutation: the `working` target checks its digest in `held`, not in `check`. Without the SHA-256 compare in `check`, only the 005 test `a_target_that_differs_from_expected_is_stale` turns red. Without the SHA-256 compare in `held`, the T012 test `a_target_whose_facts_or_digest_differ_from_the_frame_is_stale` turns red at its `sha256` case. After the restore, `git diff --exit-code` gives 0, and the stale tests give 5 pass.
- T054 (2026-10-31, on `6e29d554`): the test sets the old last write time to 2020-01-01 through `FileBasicInformation` and compares with that value. It passed 20 of 20 runs alone. `cargo test --locked --manifest-path src-tauri/Cargo.toml` gave 644 pass, 0 fail, 16 ignored. Control: an old value of 2100-01-01 turns the compare red.
- T024 closes with T054 and the green cargo run. The `test:git` run printed no fail line in the 110 files that it reached before its limit. The T033 batch 2 verification runs the whole `test:git` again.

### Batch 2 review (2026-11-01)

- Code under review: the batch 2 merges `3b7635ba` (service, T029, T030) and `ea4ab8a2` (UI, T031, T032) on top of `44058426` (T025 to T028). The review fixes merged as `21d1c632` (service) and `35679983` (UI).
- HIGH, service, fixed in `467cc457`: `in-the-way` came from an untracked status record, so an ignored file at a deleted path passed the review, and the run replaced it. Now the file fact decides: no index entry in the shown read and a present working file (data-model §7).
- Service, fixed in `467cc457`: a `tempRemove` result other than `removed` or `absent` now ends the run `failed-with-effects`, because Git's temporary file can stay (plan D10).
- Service, fixed in `467cc457`: an `unstaged-only` outcome now carries `code` and `reason` under the `not-changed` rules (data-model §8, contract Δ3).
- Service, fixed in `467cc457`: a read end that throws now gives one `failed` response with `GIT_FAILED` (`read-scheduler.ts`).
- UI, fixed in `16fad87e`: the renderer states the 10,000-file limit (spec FR-022, plan D11 `REVERT_LIMIT`).
- UI, fixed in `16fad87e`: the result names the reason of an `unstaged-only` file (plan D11 `REVERT_PARTIAL`).
- UI, fixed in `16fad87e`: a new snapshot or a new comparison patch closes an open confirmation, and a second R during a review opens nothing (data-model §10).
- Open after the review, with their tasks: the `RevertRun` reason `revert-changed` and the index-part refusal reason (T059); the CRLF ending of `restored` without an active conversion (T060); the local `RevertLinesPlan` copy (T061); the `tempRemove` `RunnerRefusal` and `lineReview` scope tests (T062); the `git diff` header reads in `HunkControls.tsx` (T063, after v0.1.0).
- This block records no test result. The block "Batch 2 verification (T033)" records them.

### Batch 2 verification (T033), 2026-11-01

- Code under test: `35679983` in the 008 worktree. Every log begins with an `ORIGIN` line that names the checkout under test. Each run ran alone behind the test gate.
- The batch 2 review ran before this verification. Commits `21d1c632` and `35679983` hold its fixes.
- `bun install --frozen-lockfile` exit 0. `bun run typecheck` exit 0. `bun run build` exit 0.
- `bun run test:contracts` 6,084 pass, 37 skip, 0 fail (6,121 tests in 129 files).
- `bun run test:git` 2,570 pass, 13 skip, 0 fail (2,583 tests in 129 files, about 180 minutes).
- `cargo test --locked --manifest-path src-tauri/Cargo.toml` 644 pass, 16 ignored, 0 fail.
- Control mutation: the restore step of `revert-bytes.ts` gives the raw line text. Then 7 tests turn red: 4 in `tests/git/revert-bytes.test.ts` and 3 in `tests/git/revert-lines.test.ts`, the CRLF cases. After the restore, `git diff --exit-code` gives 0.

### Probe L8 (T057), 2026-11-01

- Code under test: branch `f008-b3-wsl` from `4100255b` with the T055 to T057 changes. Every `ORIGIN` line names the checkout under test.
- `require 'syscall.ph'` loads in `Ubuntu-26.04`. `dpkg -S` names the package `libperl5.40`, so `perl-base` alone does not install the file.
- The probe hides `syscall.ph` with a subroutine at the start of `@INC`. Then `nrs()` gives an empty table.
- Without `syscall.ph`, a `working` replace of a present target replies `error other-error`, and the target keeps its bytes. The `xattr` check of a target with `user.test` gives the same reply. A `fileFacts` `detail` read replies `error` at component 1 with `other-error`.
- A `working` replace of an absent target writes the file without the `linkat` name. `temp_here` then creates the named file `.arbareto-<pid>-replace.tmp` with `O_CREAT|O_EXCL|O_NOFOLLOW`, and `link` gives it the target name. The reply is `replaced`.
- Decision (orchestrator, 2026-11-01): accept this 005 fallback, as R9 and plan.md P0.3 allow. `link` fails on an existing name, so the write never replaces a file. No shell change. The probe now expects the write, and the `match=false` line below is the run before the decision.
- Limit (batch 3 review S3): WSL reverts need `syscall.ph`. On `Ubuntu-26.04` the chain is `git` → `perl` → `libperl5.40`, and `libperl5.40` owns `syscall.ph`. A Git built from source, or a distro whose `git` does not depend on the full `perl`, can lack it. Then the `detail` read of a present file gives an `error` fact, and every revert of a present file refuses at the review with `unreadable` (`revert.ts` `factReason`). An absent target takes the named temporary file below.
- Known window: a stop after `link` and before `unlink` leaves the temporary name as a second link of the target. Until that file goes, each next revert of the target refuses with `hard-link`. A stop before `link` leaves the temporary name as an untracked file ("Contract gaps" of contracts/operations.md). The T045 safety case covers the window.

```text
OBSERVATION T057: versions expected="record" observed={"distro":"Ubuntu-26.04","pretty":"Ubuntu 26.04.1 LTS","perl":"5.040001","git":"2.55.0"} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T057: L8.syscall-ph expected="record" observed={"loads":1,"path":"/usr/lib/x86_64-linux-gnu/perl/5.40/syscall.ph","dpkg":{"exit":0,"owner":"libperl5.40:amd64: /usr/lib/x86_64-linux-gnu/perl/5.40.1/syscall.ph"}} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T057: L8.nrs expected={"exit":0,"nrs":"hidden=1"} observed={"exit":0,"nrs":"hidden=1"} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T057: L8.working-present.reply expected="record" observed="error other-error 0" match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T057: L8.working-present expected={"typed":true,"written":false,"temps":[]} observed={"typed":true,"written":false,"temps":[]} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T057: L8.xattr-check.reply expected="record" observed="error other-error 0" match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T057: L8.xattr-check expected={"typed":true,"written":false,"temps":[]} observed={"typed":true,"written":false,"temps":[]} match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T057: L8.working-absent.reply expected="record" observed="replaced 0 none" match=true git=2.55.0@Ubuntu-26.04
OBSERVATION T057: L8.working-absent expected={"typed":true,"written":false,"temps":[]} observed={"typed":true,"written":true,"temps":[]} match=false git=2.55.0@Ubuntu-26.04
OBSERVATION T057: L8.detail-read expected=["error","1","other-error"] observed=["error","1","other-error"] match=true git=2.55.0@Ubuntu-26.04
```

The rerun after the decision gives the same lines, except:

```text
OBSERVATION T057: L8.working-absent expected={"typed":true,"written":true,"temps":[]} observed={"typed":true,"written":true,"temps":[]} match=true git=2.55.0@Ubuntu-26.04
```

### Revert all unstaged changes tests (T034), 2026-11-01

- The T034 tests of `tests/git/revert-unstaged.test.ts` passed on the code before T035. T021 and T030 had already built the plan D6 path: the `revert-unstaged` review and the D5a writes from the index entries.
- Control: a mutation that skips the write of the second file gives 4 failed T034 tests. So the tests can fail.

### Batch 3 verification (T046), 2026-11-01

- Code under test: the full run on `85898f82`, and the check after the review fixes on `93789a01`. Every `ORIGIN` line named the checkout under test: 386, 802, 59, and 26 lines in the full run, and 568 lines in the check. Each run ran alone behind the test gate.
- Full run on `85898f82`: `bun run typecheck` exit 0. `bun run export:schemas --check` exit 0. `bun run build` exit 0.
- `bun run test:contracts` 6,128 pass, 37 skip, 0 fail.
- `bun run test:git` 2,679 pass, 13 skip, 1 fail (about 182 minutes). The failed test is `tests/git/portable-imports.test.ts`: the renderer took a runtime import of `contracts/file-action` for GITLINK (T061). The review fix P1 moved GITLINK to the leaf module `src/contracts/git-mode.ts`.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml` 652 pass, 16 ignored, 0 fail.
- WSL, alone, `ARBARETO_WSL_DISTRO=Ubuntu-26.04`: `revert-wsl` 12 pass, 0 fail. `revert-wsl-files` 17 pass, 0 fail. `revert-facts` 21 pass, 1 skip. `file-facts` 14 pass, 0 fail. `index-gate` 2 pass, 0 fail. `inspection-wsl` 39 pass, 1 skip.
- Control mutation: without `&& digest === intended` in the run check of `src/git-service/revert.ts`, 12 `revert-races` cases turn red. Among them are the three T044 cases "another writer at before-write and at renamed gives changed-outside" (lines, staged lines, and files). After the restore, the file is byte-equal, and the rerun gives 47 pass, 0 fail.
- The batch 3 review ran before the check. The fix rounds merged as `93789a01`: S1 (the staged lines candidate check, plan D4), S2 (the WSL size pass, contract Δ6), L1 (the status collector), M1 (the double test), and P1 (the GITLINK leaf module).
- Red before the fixes: S1 gave `failed-with-effects` with an index entry that the review never bound. S2 was red on the original code and on the first fix, then green, then red under a control mutation.
- Check on `93789a01`: `bun run typecheck` and the schema check exit 0. `bun run test:contracts` 6,128 pass, 37 skip, 0 fail. `portable-imports` 25 pass, 0 fail. `revert-races` 48 pass, 0 fail. The revert refusal, staged, files, lines, and frame files 110 pass, 0 fail. `revert-unstaged` 7 pass, 0 fail. `bun-runner` 45 pass, 1 skip, 0 fail. `multi-stage` 14 pass, 0 fail. The trust and `workbench-busy` files 122 pass, 2 skip, 0 fail. The 005 files: delete 27 pass, 0 fail; `ignore-editor` 17 pass, 1 skip, 0 fail; `ignore-preview` 26 pass, 0 fail. Cargo 653 pass, 16 ignored, 0 fail. `bun run build` exit 0.
- The batch 3 converge of 2026-11-01 added T064 (after v0.1.0), T065, and T066. T065 and T066 run after T046.

### Batch 4 budget decisions, 2026-11-02

- SC-007 Windows rule: a multi-file revert (Revert file of several files, Revert all unstaged changes) of up to 1,000 files ends within 2 s + 28 ms per file. So 100 files end within 4.8 s, and 1,000 files within 30 s. `tests/windows/revert-perf.test.ts` uses `FILES_100_MS` 4,800 and `UNSTAGED_1000_MS` 30,000.
- Measured on packaged builds: 100 files 3,747.9 to 4,442 ms; 1,000 files 19,529.8 to 23,902.5 ms. The shape is about 2.5 s fixed + 21.4 ms per file.
- The 1 GiB single-file case keeps 30 s and 64 MiB.
- Constitution VII: each changed target below is an explicit product trade-off. A missed budget stays a failure.
- Approval: the user approved these targets on 2026-11-02 as an explicit product trade-off under constitution VII.
- Packaged session 3 (build d477194f, no host sleep, medians of 10 unless noted) decided three more budgets.
- Refreshed diff: a line, hunk, or single-file revert shows the refreshed diff within 1.5 s after the confirmation. Measured: text 1,148.6 ms, hunk 1,184.8 ms, binary 1,320.0 ms. Before the read removal, the same steps took 1,500.6 to 1,719.5 ms. 500 ms cannot hold on the R12 fixture: each full status read costs about 440 to 620 ms, and 001 contract §3 requires one reconcile read after each run.
- WSL multi-file revert: it ends within 2 s + 320 ms per file, so 1,000 files end within 322 s. Measured: 263,418.4 ms (d477194f) and 313,715 ms (an earlier build). T068 holds the WSL speed work.
- Memory at the 004 multi-file limit, later runs (runs 1 to 10): the `PrivateMemorySize64` sum over the `arbareto.exe` process tree rises by at most 320 MiB at the peak, and by at most 32 MiB 30 s after the run end. Run 0 has the bounds of decision A below. Measured peak growth: at most 291.1 MiB over the 10 counted runs, and 303.7 MiB over all 12 runs (run 0, packaged session 3). The WebView2 renderer gave 133 to 232 MiB of it in the early runs. Retained growth 30 s after the end: −120.3 to +25.0 MiB.
- Known limit: over 12 back-to-back 10,000-file cycles, the idle process-tree memory before each run rose from 841 to 1,317 MiB, about 43 MiB per cycle. Each cycle is a run, an external restore, and F5. Before the token fix, the rise was about 83 MiB per cycle. The cause is open. T072 finds it after v0.1.0. The T048 output prints a "before" value per process kind.
- R to the confirmation stays at 500 ms. The step is bimodal on this PC: a slow mode of +100 to 150 ms shows in 20 to 60% of runs, on both builds. The test presses R only when no workspace, comparison, refs, or entries read is pending, so the app is warm and idle.
- Windows cost shape: the first Windows Defender open costs about 4 to 6 ms per file. The sequential shell replace costs about 10.4 ms per file. A run starts about 52 Git processes at about 50 ms each.
- WSL cost shape: a run starts about 1.15 `wsl.exe` processes per file at about 170 ms each. The replace takes about 83% of the time.
- The run does no status read after the writes. Each full read cost about 440 to 620 ms on the perf fixture (packaged build e70c2185). A single-file revert took about 1.6 s to the refreshed diff, and about 1.1 s without the duplicate read.
- Consumed workbench tokens kept their review plan until the repository release, about 19 MiB per 10,000-file cycle. The service now drops the plan at consumption and the payload when the run ends.
- Decision A (2026-11-02), first run at the 004 multi-file limit: the first revert after the app starts (run 0) raises the process tree by at most 400 MiB at the peak, and by at most 80 MiB 30 s after the run end. Each later revert keeps 320 MiB and 32 MiB. Evidence: run 0 peak growth 303.7 MiB (session 3) and 367.5 MiB (session 4); run 0 retained growth 25.0 MiB and 59.9 MiB. The WebView2 GPU process holds 38.3 MiB and 48.0 MiB of that retained growth. Later runs keep about 0 MiB in the GPU process. T072 studies the GPU-process memory after v0.1.0.
- Decision B (2026-11-02), Windows end time above 1,000 files: a revert of more than 1,000 files, up to the 004 multi-file limit, ends within 330 s. A revert of up to 1,000 files keeps 2 s + 28 ms per file. Evidence: the 10,000-file median was 288,560 ms (28.9 ms per file), and the 1,000-file run took 19,480 ms (19.5 ms per file). T067 studies the per-file cost growth above 1,000 files after v0.1.0.
- Approval of decisions A and B: the user approved these targets on 2026-11-02 as an explicit product trade-off under constitution VII.
- After v0.1.0, not a v0.1.0 gate: Windows speed items in T067, WSL speed items in T068. T069 (two index paths of one file), T070 (exact name check in the run), T071 (`reconciling` status text), and T072 (idle memory per cycle) are also after v0.1.0.
- T073: the comparison read listed the line endings of the whole index. On the 11,102-entry perf fixture, `ls-files --eol -z` took 1,777 to 1,968 ms, and the one-path form took 101 to 234 ms (Git 2.56.0.windows.2). The listing now names only the support keys.
- T074: the line review ran 6 serial Git starts (7 for a staged revert). It now starts its independent reads in one round: 2 serial starts (3 for a staged revert). Results of T073 and T074 on packaged build 1f4e1dfd (medians of 10): before, on build d477194f, the lines refreshed diff took 4,058.7 ms and the hunk confirmation took 505.1 ms. After, the text, hunk, binary, and lines confirmation took 306.0, 293.4, 299.8, and 336.3 ms. The text, hunk, binary, and lines refreshed diff took 1,238.3, 1,165.9, 1,191.9, and 1,365.6 ms. The busy state took at most 32.6 ms.

### Requirement-to-test map (T051), 2026-11-02

- This map names the test files and the oracle of each 008 FR and SC. It records no test result. T049 and T050 record the results.
- The SC-010 column states for each row which of the four inputs could decide an outcome: Git message text, timing, a retry count, or a name pattern. "None" means that no outcome of the row depends on any of them.
- `src-tauri/src/file_replace.rs` holds cargo tests in its test module. The `tests/vectors/` files belong to `tests/contracts/revert-contract.test.ts`.

| ID | Test files | Oracle | SC-010 |
| --- | --- | --- | --- |
| FR-001 | No automated test. | A test cannot prove that no code path reads Git message text. The T052 review checks it with this map. | None in the rows below: each oracle is a typed code, an exit code, an OS fact, or a fresh read. |
| FR-002 | `tests/git/revert-frame.test.ts` | Typed codes `BUSY`, `OPERATION_IN_PROGRESS`, and `CONFLICTED`, and the reason `unknown-operation`, before any token. The repository stays unchanged. | None. |
| FR-003 | `tests/git/revert-frame.test.ts` | The recorded argument arrays of every run: each path follows `--` or goes on stdin. The paths `-x` and `:(glob)*` revert to Git's restore bytes. | None. |
| FR-004 | `tests/git/revert-frame.test.ts`, `tests/git/revert-refusal.test.ts`, `tests/git/revert-lines.test.ts` | A revert with a registered `post-checkout` hook runs without trust approval. `core.fsmonitor` profiles and an index-change hook refuse with typed reasons. Filter attributes refuse with the 001 support reason. Limit: no 008 test proves that the hook does not run or that reads wait behind the 001 read gate. | None. |
| FR-005 | `tests/git/revert-refusal.test.ts`, `tests/git/revert-frame.test.ts` | A partial clone without the HEAD blob gives `OBJECT_MISSING` with the 001 remedy before any change. The runner records no fetch, and every argument array starts with `--no-lazy-fetch`. | None. |
| FR-006 | `tests/contracts/revert-keys.test.tsx`, `tests/contracts/shortcuts-008.test.ts` | R in the History diff sends no request. `scopedAction` gives `revertLines` only in the diff scope. | None. |
| FR-007 | `tests/git/revert-races.test.ts`, `tests/git/revert-frame.test.ts` | A change of each bound fact between the review and the run gives `STALE_REVIEW` with `revert-changed`. The index digest and the working bytes stay. | None. |
| FR-008 | `tests/contracts/revert-confirm.test.tsx`, `tests/windows/revert-packaged.test.ts` | The DOM focus and the UI Automation focus are on Cancel. Enter on Cancel, Escape, and a held R send no run. The DOM has no form, no submit button, and no access key. | None. |
| FR-009 | `tests/contracts/revert-confirm.test.tsx` | The exact FR-009 texts, with the singular forms. | None. |
| FR-010 | `tests/contracts/revert-confirm.test.tsx` | The first 20 paths in plan order, then the exact "and <m> more files." or "and 1 more file." text. A path with markup shows as plain text. | None. |
| FR-011 | `tests/git/revert-races.test.ts`, `tests/git/revert-lines.test.ts`, `tests/git/revert-frame.test.ts` | `STALE_REVIEW` with `revert-changed` for a change before the run. A change at the before-write seam gives `changed-outside` from the fresh read. A run after the token lifetime gives `APPROVAL_EXPIRED`. | None. The 60 s lifetime is a contract value. The tests set it through the approval clock seam, not through a wait. |
| FR-012 | `tests/contracts/revert-keys.test.tsx`, `tests/contracts/revert-menus.test.tsx` | The sent review payload names the selected lines or the selected hunk. Without either, no request goes out, and the exact text "No hunk is selected." shows. The hunk "More actions" menu holds the items. | None. |
| FR-013 | `tests/contracts/revert-menus.test.tsx`, `tests/git/revert-refusal.test.ts`, `tests/git/revert-lines.test.ts` | The typed line and support reasons (context-only, deleted file, untracked, binary, symlink, submodule, LFS, filter). An unavailable item sends no request. | None. |
| FR-014 | `tests/git/revert-lines.test.ts`, `tests/git/revert-bytes.test.ts` | The working bytes equal Git's `apply -R` of the same partial patch on a copy. The index stays. | None. |
| FR-015 | `tests/git/revert-lines.test.ts`, `tests/git/revert-staged.test.ts`, `tests/git/revert-bytes.test.ts` | The check-in form of the new bytes equals the expected content. `blobId` equals `git hash-object`. The `restoreEol` cases come from the `ls-files --eol` attribute value and `core.autocrlf`. | None. |
| FR-016 | `tests/git/revert-staged.test.ts` | The index equals Git's `apply --cached -R` of the same partial patch on a copy. The working file loses the same changes. A file with unstaged changes refuses with `unstaged-changes`. | None. |
| FR-017 | `tests/git/revert-staged.test.ts`, `tests/contracts/revert-keys.test.tsx`, `tests/contracts/revert-confirm.test.tsx` | A published index part and a failed write give `failed-with-effects`, and the index equals the oracle. The exact FR-017 text names the reason. | None. |
| FR-018 | `tests/contracts/revert-keys.test.tsx`, `tests/contracts/revert-menus.test.tsx`, `tests/contracts/shortcuts-008.test.ts` | R in each list sends the entry IDs of the focused row or the marked rows. The DOM order puts the Revert group directly above the "Delete from disk" group. | None. |
| FR-019 | `tests/git/revert-files.test.ts`, `tests/git/revert-facts.test.ts` | The index and the working files equal Git's `restore --staged --worktree --source=HEAD` on a copy (probe G9 for the `checkout-index --temp` bytes). | None. |
| FR-020 | `tests/git/revert-files.test.ts`, `tests/git/revert-frame.test.ts`, `tests/git/revert-refusal.test.ts` | A deleted file comes back with its missing folders, as Git's restore does. An untracked or ignored file at the path gives `in-the-way` and keeps its bytes. | None. |
| FR-021 | `tests/git/revert-files.test.ts`, `tests/wsl/revert-wsl.test.ts` | `ls-files --stage -z` has no entry for the staged new file, and its working bytes stay. On an unborn branch, every file follows this rule. | None. |
| FR-022 | `tests/git/revert-files.test.ts`, `tests/contracts/revert-menus.test.tsx`, `tests/contracts/revert-contract.test.ts` | A failed `update-index` and a lock before publication leave the index digest unchanged. One file above `MULTI_FILE_ACTION_FILES` gives `INVALID_REQUEST` before any read. The menu names the first blocking file. | None. |
| FR-023 | `tests/contracts/revert-menus.test.tsx` | The typed status fields of the fixture entries (the untracked category and the submodule field) and a folder row give their reasons. An unavailable item sends no request. | None. |
| FR-024 | `tests/git/revert-files.test.ts` | Binary, CRLF, `working-tree-encoding`, and `ident` files equal Git's restore on a copy. | None. |
| FR-025 | `tests/git/revert-files.test.ts`, `tests/windows/revert-perf.test.ts`, `tests/contracts/revert-contract.test.ts` | A 40 MiB binary file reverts above the 16 MiB frame, and no recorded request carries its bytes. A 1 GiB binary file reverts on the package. `REVERT_FILE_BYTES` bounds the line frame. | None. |
| FR-026 | `tests/contracts/revert-menus.test.tsx`, `tests/git/revert-unstaged.test.ts` | The Changes header menu holds the item. Without unstaged changes, it is unavailable with the exact text "No unstaged changes.", and the service gives `nothing-to-revert`. | None. |
| FR-027 | `tests/git/revert-unstaged.test.ts`, `tests/contracts/revert-menus.test.tsx` | The working files equal Git's `restore .` on a copy. Untracked files and submodule working trees stay byte-identical. The plan covers the rows that Filter files hides. | None. |
| FR-028 | `tests/git/revert-unstaged.test.ts` | Git's `restore .` bytes on a copy. The recorded calls show `checkout-index --temp` and one `fileReplace` with a source per file. The index stays. | None. |
| FR-029 | `tests/git/revert-unstaged.test.ts`, `tests/contracts/revert-contract.test.ts` | One refused entry makes the action unavailable. The value names the first 20 refused files in tree order with their typed reasons. More files than the limit give `limit` before any file read. | None. |
| FR-030 | `tests/git/revert-unstaged.test.ts`, `tests/contracts/revert-keys.test.tsx` | A seam holds the second write. Cancel then stops the action before the next file, and the fresh read counts each outcome and names the files that did not revert. The renderer shows "Checking <n> files…" with Cancel. | None. The stop point comes from the seam. The 1 s bound is a budget check, not an input to the outcome. |
| FR-031 | `tests/git/revert-frame.test.ts` | The recorded argument arrays of every run hold no `apply` without `--cached`, `checkout`, `restore`, `checkout-index` without `--temp`, `reset`, or `stash`. | None. |
| FR-032 | `src-tauri/src/file_replace.rs`, `tests/git/revert-races.test.ts`, `tests/wsl/revert-wsl-files.test.ts` | At each write step seam and at each shell end, the SHA-256 of each target equals its old or its new digest, and the file is present. | None. |
| FR-033 | `src-tauri/src/file_replace.rs`, `tests/git/revert-races.test.ts` | A target that differs from the expected size and SHA-256, or a target swapped after the check, gives `stale` and no rename. Another writer during the run gives `changed-outside`. | None. |
| FR-034 | `src-tauri/src/file_replace.rs`, `tests/git/revert-refusal.test.ts`, `tests/wsl/revert-wsl-files.test.ts` | OS file facts (reparse tag, folder type, link count, read-only attribute) give `not-regular`, `hard-link`, or `read-only`. | None. |
| FR-035 | `src-tauri/src/file_replace.rs`, `tests/windows/revert-facts.test.ts`, `tests/wsl/revert-wsl-files.test.ts` | OS reads of the attributes and the security descriptor before and after the replace (probes W1 and W2, and the ten W2 cases). In WSL: `stat` mode bits and owner, and the `xattr` refusal. | None. |
| FR-036 | `tests/git/revert-races.test.ts`, `tests/git/revert-files.test.ts`, `src-tauri/src/file_replace.rs` | The folder listing after each stop holds no temporary file, except the recorded crash limit. `tempRemove` removes only the name that Git printed, after a size and SHA-256 match. | None. Removal uses the printed name, never a name pattern. |
| FR-037 | `src-tauri/src/file_replace.rs`, `tests/windows/revert-packaged.test.ts` | A held target or a late read-only attribute gives its code, and the rename counter of the thread equals 1. | None. The test counts the renames to prove that no retry happens. |
| FR-038 | `tests/git/revert-refusal.test.ts`, `tests/git/revert-lines.test.ts`, `tests/contracts/revert-contract.test.ts` | Each data-model §7 reason refuses each action where it applies, with its typed code and reason. The index digest and every working byte stay. | None. |
| FR-039 | `tests/git/revert-frame.test.ts`, `tests/git/revert-unstaged.test.ts`, `tests/git/revert-files.test.ts`, `tests/contracts/revert-contract.test.ts` | Each file outcome comes from the fresh `ls-files --stage -z` read and the SHA-256 digests after the run, also after a failure and after Cancel. | None. |
| FR-040 | `tests/contracts/revert-keys.test.tsx`, `tests/contracts/revert-confirm.test.tsx` | The exact FR-040 texts. | None. |
| FR-041 | `tests/git/revert-files.test.ts`, `tests/windows/revert-packaged.test.ts` | The shell reply code (from the OS status) gives `failed` with that code, and the file keeps its old bytes. The package shows the exact sharing-violation text and the 005 form for access denied. | None. |
| FR-042 | `tests/contracts/revert-keys.test.tsx`, `tests/contracts/revert-confirm.test.tsx` | The DOM focus goes to the next entry, then to the previous entry, then to the list heading. After Cancel, the focus returns to the opener. | None. |
| FR-043 | `tests/wsl/revert-wsl.test.ts`, `tests/wsl/revert-wsl-files.test.ts`, `tests/windows/revert-packaged.test.ts` | The results equal Git's own commands on a copy in the distro. The write goes through the `wslFiles` route. | None. |
| FR-044 | `tests/wsl/revert-wsl.test.ts`, `tests/wsl/revert-wsl-files.test.ts`, `tests/wsl/revert-facts.test.ts` | Git's own commands on a copy in the same owned distro folder of `Ubuntu-26.04`. A case that the harness cannot run prints a SKIP line that names its capability and "unverified". | None. |
| FR-045 | `tests/contracts/revert-menus.test.tsx`, `tests/contracts/shortcuts-008.test.ts`, `tests/windows/revert-packaged.test.ts` | DOM labels, tooltips, accessible names, and `aria-keyshortcuts` "R". UI Automation names of the row menu items, and visible focus in the package. | None. |
| FR-046 | `tests/contracts/revert-keys.test.tsx`, `tests/contracts/shortcuts-008.test.ts` | R sends nothing during an IME composition, in an editable field, or as a key repeat. Two quick presses send one review. A composing event gives null. | None. |
| FR-047 | `tests/contracts/revert-confirm.test.tsx`, `tests/windows/revert-packaged.test.ts` | The DOM role is an alert dialog, with the title as its name and the text as its description. UI Automation reads the result from the status region. | None. |
| FR-048 | `tests/windows/revert-perf.test.ts` | The input response times during each review and run against the 001 SC-005 targets. | Timing is the measured value. It decides only the budget verdict, never a revert outcome. |
| FR-049 | `tests/git/revert-frame.test.ts` | A search of every collected log finds no file bytes, no patch text, and no path. | None. |
| SC-001 | `tests/git/revert-lines.test.ts`, `tests/git/revert-staged.test.ts`, `tests/git/revert-bytes.test.ts`, `tests/wsl/revert-wsl.test.ts` | Git's `apply -R` and `apply --cached --reverse` of the same partial patch on a copy. | None. |
| SC-002 | `tests/git/revert-files.test.ts`, `tests/git/revert-unstaged.test.ts`, `tests/wsl/revert-wsl.test.ts` | Git's `restore --staged --worktree --source=HEAD` and `restore .` on a copy. The staged new file keeps its working file. | None. |
| SC-003 | `tests/git/revert-races.test.ts`, `tests/git/revert-frame.test.ts`, `tests/git/revert-lines.test.ts` | A change of the file, the index entry, HEAD, the attributes, or the configuration gives `STALE_REVIEW` with `revert-changed`, or `STALE_SELECTION`. Nothing changes. | None. |
| SC-004 | `tests/git/revert-refusal.test.ts`, `tests/git/revert-files.test.ts`, `tests/git/revert-staged.test.ts`, `tests/git/revert-unstaged.test.ts` | The index digest and every working-file byte before and after each refusal. | None. |
| SC-005 | `tests/git/revert-races.test.ts`, `tests/git/revert-files.test.ts`, `src-tauri/src/file_replace.rs` | At each write step seam and at each shell end, the SHA-256 of each target equals its old or its new digest. The folder listing holds no temporary file, except the recorded crash limit. | None. |
| SC-006 | `tests/contracts/revert-confirm.test.tsx`, `tests/contracts/revert-keys.test.tsx`, `tests/windows/revert-packaged.test.ts` | Enter right after the open, Escape, Cancel, and a held R send no run, and the package keeps the file bytes. Only Tab to the revert button and Enter reverts. | None. |
| SC-007 | `tests/windows/revert-perf.test.ts`, `tests/git/revert-lines.test.ts` | Medians of 10 on the package against the fixed budgets. The runner spy shows that the line review reads start in one round. | Timing is the measured value. It decides only the budget verdict, never a revert outcome. |
| SC-008 | `tests/wsl/revert-wsl.test.ts`, `tests/wsl/revert-wsl-files.test.ts`, `tests/windows/revert-packaged.test.ts` | Git's own commands on a copy in the distro. `stat` mode bits, owner, group, and link count stay. | None. |
| SC-009 | `tests/windows/revert-packaged.test.ts`, `tests/contracts/revert-keys.test.tsx` | UI Automation focus and names, a contrast of at least 4.5:1 in Dark, Light, and forced colors, and element bounds at 150% and 225% text size. The package covers User Story 1 and the Revert file menu and modal by keyboard. The DOM tests cover R for User Stories 2 to 4. | None. |
| SC-010 | No automated test. | The T052 review of this map is the check. | Not applicable. |
| SC-011 | `tests/windows/revert-perf.test.ts` | 95% of inputs show a response within 100 ms, and every input within 500 ms, during each review and run. | Timing is the measured value. It decides only the budget verdict, never a revert outcome. |

### T052 final review, 2026-11-02

- Code under review: `0457d99c` (reviewer, read-only). The review found no CRITICAL and no HIGH issue.
- LOW 1 (batch 4): in `src-tauri/src/file_facts.rs`, `Err(_) => Ok(false)` (line 564) and `entry_name` (lines 627 and 641) give `Ok(false)` on a query or open failure. So an unknown exact-name result becomes `exactName === false`, and `src/git-service/revert.ts:264` refuses with `path` and the letter-case text, not with a typed unknown. The refusal writes nothing. Fix: return `Err(status)` for these statuses. Then `fact()` gives an `error` fact, and `factReason` maps it to `unreadable`. T075 holds the fix.
- LOW 2 (before 008): the WSL `wslFiles` replace script in `src/contracts/wsl-process.json` compares the `lstat` mtime and ctime (`[9]` and `[10]`, line 543) in whole seconds. Another program can write the same size in place in the same second, between the digest read and the rename. The replace then overwrites that write and does not report it. The "Contract gaps" of contracts/operations.md accept this window, but the 1 s resolution makes it wider. Fix: use `Time::HiRes qw(lstat stat)` (core Perl), and check the distro Perl minimum that the contracts name. T076 holds the fix.
- Map gap FR-004: the hook of the `revert-frame.test.ts` case (about line 111) writes `exit 0`, so the test cannot see a hook run. Smallest test: the hook writes a marker file, and the test asserts that the marker is absent after the run. It does not block. T077 holds the test.
- Map gap FR-034: no test asserts that the read-only attribute stays after the refusal (`revert-refusal.test.ts`, about line 617). It does not block. T078 holds the assertion.
- Map gap SC-009: User Stories 2 to 4 have keyboard tests only in the DOM tests. Smallest test: one `revert-packaged.test.ts` case presses R through CDP on a focused Staged row and on the Changes header item, and asserts that the modal opens with Cancel focused. It must land before v0.1.0. Until then, T049 records SC-009 as partial. T079 holds the case.
- Delivery Gates: the plans are met. The independent review is met with this record. The evidence is open (T049, T050). The update authenticity of a production release is not met and is not part of 008: v0.1.0 is a preview with manual updates.
- Not verified: the WSL `walk_parent` and `xattrs` helpers in full; `FileNormalizedNameInformation` on SMB or ReFS volumes; the T047 and T048 test logic beyond the safe process handling.

### Full run (T049), 2026-11-03

- Code under test: build `1f4e1dfd` (T073 and T074 merged). Every log begins with `ORIGIN` lines that name the checkout under test. Each run ran alone behind the test gate. The logs are in local scratch.
- `bun run test:all` with `ARBARETO_WSL_DISTRO=Ubuntu-26.04`: 0 fail (about 182 minutes). `cargo test --locked --manifest-path src-tauri/Cargo.toml`: 656 pass, 0 fail. `bun run build:service`: exit 0.
- `bun run test:windows`: 4 fail.
- Fail 1, the T048 10,000-file limit case: in runs 1 to 10, the peak growth was 338.7 MiB (bound 320), and the retained growth was 45.5 MiB (bound 32). Run 0 passed with a peak growth of 265.3 MiB. The end median of 290.6 s passed. Cancel took 49 ms. This was a Cancel before the first write (T082).
- Cause of fail 1: the "before" value of each growth is one 250 ms sample. After the app frees memory, that sample can move by up to about 60 MiB. No product change. The T050 rerun passed with the same method and the same budgets.
- Fails 2 to 4, 005 inspection cases: T060 SC-007 Open submodule 457 ms, T061 Q6 growth 441.7 MiB, and Q21 first preview 6.8 s. Cause: the 008 branch did not have the main budgets `4cd73b4c` and the speed fix `3a3c1131` (005 T112). The merge `2b0af4be` brought main into 008. The T050 rerun gives these cases green.
- T075 to T079 came after this full run. The targeted rerun covers them: cargo, the WSL revert suites alone, and T047 on a new package (block "Package run (T050)"). `tests/git/revert-refusal.test.ts` and `tests/git/revert-frame.test.ts` gave 68 pass, 0 fail on `7878565b`.
- On `c7bb0ee3` (code of `884ef2cd`), `tests/git/revert-bytes`, `revert-facts`, `revert-files`, `revert-lines`, `revert-races`, `revert-staged`, and `revert-unstaged` gave 140 pass, 0 fail, 0 skip (442 s, `ARBARETO_WSL_DISTRO=Ubuntu-26.04`).
- Control mutation: the block "Package run (T050)" records it. It ran on a control package of `623876bf`.
- The T048 limit case runs again in the combined 007 T028 full run before the v0.1.0 tag. A miss there stays a failure, unless the user approves a trade-off (constitution VII).

### Package run (T050), 2026-11-03

- Build: `623876bf` (main merged, T073 to T079). The installed `arbareto.exe` has SHA-256 `06AFF8E0985512CBF02B5E1AE2A7C0ED1A5142539A2FC095C07C7E348CB43F4A`. The built exe has SHA-256 `98BFED53BC939FA8D97C99E6AB6CD8068E82D4A9DEBF169601995CF8EFBE8155`. The Tauri NSIS installer changes a 3-byte bundle-type marker at install, so the two hashes differ by design.
- Host: Windows 11 Pro 10.0.26300, x64. Windows Defender real-time protection on. Text size 100%. One display.
- Prerequisites: current-user NSIS install; Git 2.56.0.windows.2; Bun 1.4.4; WebView2 Runtime 156.0.4314.58 (read after the run); WSL `Ubuntu-26.04` with Git 2.55.0.
- Every log begins with `ORIGIN` lines that name the checkout under test and the installed exe. Each run ran alone behind the test gate. The logs are in local scratch.
- `bun run typecheck` and `bun run export:schemas --check`: exit 0. `tests/contracts` with `portable-imports`: 6,296 pass, 37 skip, 0 fail. `cargo test --locked --manifest-path src-tauri/Cargo.toml`: 658 pass, 16 ignored, 0 fail.
- WSL, alone, `Ubuntu-26.04`: `tests/wsl/revert-wsl-files.test.ts` and `tests/wsl/revert-wsl.test.ts` 31 pass, 0 fail.
- `tests/windows/revert-packaged.test.ts`: 7 pass, 4 skip, 0 fail. The skips are `text-scale-150`, `text-scale-225`, `full-volume`, and `read-only-volume`. So the 150% and 225% text scale cases are unverified. T029 covers the full-volume and read-only-volume texts through the double replies.
- `tests/windows/inspection-packaged.test.ts` and `tests/windows/inspection-perf.test.ts`: 18 pass, 2 skip, 1 fail. The fail was the 005 T108 run 0 order check. Cause: a test race. `watchIpc` starts after the open, so the test did not record the marks read of the open.
- T108 fix (`7694610a`, test only): a warm-up run, and a check per run that a recorded marks read ended. Rerun on the same installed exe: 100 submodules median 3,175.4 ms (budget 5,500), 256 submodules median 7,779.8 ms (budget 14,080). Control: without the warm-up, run 0 turns red.
- 005 values of the same run: SC-007 medians normal parent 491 ms, submodule 445 ms, parent button 497 ms, normal submodule 420 ms. SC-002 growth 368.7 MiB at the peak and 315.6 MiB settled (bound 624). SC-005 first preview 5,309.4 ms (budget 8,550), flat preview 2,880.8 ms (budget 5,000).
- `tests/windows/revert-perf.test.ts`: 6 pass, 0 fail. Warm, median of 10 unless noted. Values in ms (budget):

| Case | Busy state | Confirmation | Refreshed diff or end |
| --- | --- | --- | --- |
| Text file | 25.1 (100) | 330.7 (500) | 1,110.1 (1,500) |
| Hunk | 31.9 (100) | 314.4 (500) | 971.4 (1,500) |
| Binary file | 20.4 (100) | 304.2 (no assert) | 1,109.7 (1,500) |
| Lines | 35.3 (100) | 365.8 (500) | 1,331.1 (1,500) |
| Revert file, 100 files | | | 3,165.8 (4,800) |
| Revert all unstaged, 1,000 files | 27.5 (no assert) | 1,177.4 (3,000) | 19,282.5 (30,000) |
| 10,000 files | | | 293,306.9 (330,000); Cancel 56.1 (1,000), a Cancel before the first write (T082) |
| 1 GiB binary file | | | 11,865.2 (30,000) |
| WSL, 1,000 files | | | 262,070.9 (322,000) |

- Memory: the 1 GiB binary file raised the service by at most 31.8 MiB (bound 64). The 10,000-file limit: run 0 peak growth 273.1 MiB (bound 400) and retained growth at most 35.1 MiB (bound 80). Runs 1 to 10: peak growth at most 166.1 MiB (bound 320) and retained growth at most 5.1 MiB (bound 32).
- The T048 limit case missed in the T049 full run and passed here, with the same method and the same budgets. The block "Full run (T049)" records the cause.
- The test printed the 5 s window values (median and minimum baseline) as observations only. No verdict uses them.
- Control mutation, on a control package of the same commit: `RevertConfirm.tsx` focuses the revert button first. Then T079 and 5 T047 packaged cases turn red ("the first focus on Cancel did not happen"). 3 T027 DOM cases of `tests/contracts/revert-confirm.test.tsx` also turn red.
- SC-009 focus: the CDP DOM focus is on Cancel. UI Automation `HasKeyboardFocus` (the provider focus, from the same DOM focus) is true on Cancel and false on the other button. This holds for T047 (Revert lines) and for T079 (Revert file and Revert unstaged changes). Control: with the expected values swapped, the T047 and the T079 cases turn red.
- Unverified: the OS system focus (`GetFocusedElement`). The test session never owns the foreground window, because the terminal owns it. Verify the system focus later in Windows Sandbox or a VM.
- SC-009 status: the CDP focus and the UI Automation provider focus are verified for User Stories 1 to 4. The OS system focus and the 150% and 225% text scale cases are unverified.

### Memory baseline decision, 2026-11-03

- Cause: the "before" value of each T048 memory growth was one 250 ms sample. After the app frees memory, that sample can move by up to about 60 MiB. With that same method, the limit case missed in T049 and passed in T050.
- Decision: the user chose "5 s median" on 2026-11-03. The "before" value is the median of the 5 s window before the run. The retained value is the median of the 5 s window that ends 30 s after the run end. The budgets do not change. R12 holds the method.
- Scope: the 10,000-file limit case and the 1 GiB case. Both use `growth()` in `tests/windows/revert-perf.test.ts`.
- Offline replay of the T050 samples through the new code: the limit case passes (run 0 peak 298.5 MiB, retained 61.1 MiB; runs 1 to 10 peak at most 169.8 MiB, retained at most −33.0 MiB). The 1 GiB runs 1 to 10 pass (peak at most 31.8 MiB). The 1 GiB run 0 started 108 ms after the first sample, so its window was short and the new code refuses it. The test now waits for 5 s of samples before run 0.
- The combined 007 T028 full run is the first full run with the median method. It saves the raw samples through `ARBARETO_PERF_SAMPLES_DIR`.

### T053 analyze and converge, 2026-11-03

- Artifacts: spec.md, plan.md, and tasks.md after the memory baseline decision. `/speckit-analyze` found no CRITICAL and no HIGH issue.
- MEDIUM 1: T002 stays open. Its tick needs a green `bun run test:windows` (block "Batch 0 fact gate (T005)"). The T049 run had 4 fails, and T050 ran single suites.
- LOW 1: T058 stays open. It needs a Linux host.
- LOW 2: 32 FR and SC IDs are not named in tasks.md. Each one has a row with test files in the "Requirement-to-test map (T051)", and each named file exists.
- LOW 3: the T049 text still says "Until T079 passes". T079 passes. SC-009 stays partial until T080 passes.
- `/speckit-converge`: converged. It appended no task. The T075 to T079 fixes are in the code: `file_facts.rs` returns `Err(status)`, the WSL replace uses `Time::HiRes`, and `revert-frame`, `revert-refusal`, and `revert-packaged` hold the new cases. The open SC-009 items are T080 (after v0.1.0).
- Not verified: converge checked the map files and the T075 to T079 fixes, not each FR again in the code. T052 did that full check on `0457d99c`.

### SC-007 Cancel decision (T081, T082), 2026-11-15

- Source: a packaged precheck of `tests/windows/revert-perf.test.ts` on the installed v0.1.2 build, 10,000-file case, Cancel during the writes (runs 1 to 10), warm, median.
- Cancel to "Checking the result…": median 164.5 ms (144.5 to 180.7 ms).
- Cancel to the outcome: median 8,056.3 ms (7,901.7 to 8,278.9 ms) in one run. A second run gave a median of 7,715.8 ms, with one run at 19,488.7 ms. The old check applied the 1 s budget to this series, so the case failed.
- User decision of 2026-11-15: an explicit product trade-off under constitution VII (plan.md Constitution Check VII row). The SC-007 Cancel budget runs from Cancel until "Checking the result…" shows, or the outcome if it shows first. Each run records the time from Cancel to the outcome, with no budget. The budget stays 1,000 ms, median of 10.
- Second user decision of 2026-11-15: the 001 5 s Cancel/reconciliation target does not apply to a revert run. 001 SC-008 and 001 contracts/operations.md §5 hold that target. The time from Cancel to the outcome is a known limit (contracts/operations.md Δ5). T083 aims to bring it under 5 s. Other operations keep the 5 s target.
- The test applies the `cancel` check to the Cancel to "Checking the result…" series. It prints the Cancel to the outcome series as an observation with its median, minimum, maximum, and all values.
- T083 (v0.1.3) measures where the time from Cancel to the outcome goes, and shortens it. It aims to bring the time under the 001 5 s target. Plan.md D10 stays: the fresh read decides each outcome.
- Run 0 first failed with "the run_workbench calls were not held within 60000 ms: held 0". The run request left the page, but CDP `Fetch` paused no request. A control without a probe missed in 5 of 6 runs. In each miss, neither the CORS preflight nor the POST paused. The misses came after short and long setup times. `holdIpc` now sends a probe GET after the `Fetch.enable` reply. It presses Enter only after the probe pauses. With the probe, run 0 held in 9 of 9 precheck runs and in f014. A probe that was sent but not awaited also held in 4 of 4 runs. So the `Fetch.enable` reply does not prove that the page requests pause. The browser-side cause stays open. The records are in local scratch `v012-precheck4` and `v012-precheck5`.
- v0.1.2 full run f014, 2026-11-15 to 2026-11-16. Build: code `2d109fff` on branch `v0.1.2-rc`, installer SHA-256 `065fedd6bf2b76387adfd0e2db0ed81c4c1f8572c5e6cc78d1457e616d09981f`, installed `arbareto.exe` SHA-256 `478ac4cc1fedacdebe82be4fcdbfba03be719b1fcd0e36b0b17b59bd88ac225e`. OS: Windows NT 10.0.26300.0, UBR 9974, x64. Git 2.56.0.windows.2, WebView2 157.0.4341.46, Bun 1.4.4. The logs are in local scratch `f014-full`.
- `tests/windows/revert-perf.test.ts` ran as a whole file in its own step: 6 pass, 0 skip, 0 fail. This includes the WSL 1,000-file case in the owned `Ubuntu-26.04` folder. Every `ORIGIN` line named the checkout under test, and the installed app line named exe `478ac4cc…`.
- T081 result: every case passed, so each `refreshed()` call site passed. The 10,000-file run ended with a median of 284,624.7 ms (budget 330,000 ms).
- T081 F5 reply state: `succeeded`. The log prints no line with this state. `refreshed()` throws unless the F5 `read_workspace` reply state is `succeeded` (`revert-perf.test.ts:641` at `2d109fff`). So each pass had that state.
- T081 refusal area text: none. The green run showed no refusal. In control `t081-c2`, the FACTS of the error held `"area":[]`. The mutated dialog match made the refusal, so the status area had no text. The footer read "100 staged files. 10,000 changes, 0 of them untracked.".
- T081 controls, 2026-11-16 (local scratch `v012-controls-f014`). Both ran test patches on the installed f014 exe, from a clean `2d109fff` checkout. `t081-c1` removes the F5 press: 0 pass, 1 fail, with "the restored 100 files: no refresh read_workspace reply after F5 within 60000 ms". `t081-c2` matches the dialog on a wrong text: 0 pass, 1 fail, with "the review refused:" and the FACTS with the `area` field. Control 2 proves only that the error carries the `area` field. No run shows a refusal with area text. This part of T081 stays unverified.
- T082 run 0: the hold sent 1 probe and held the call. The `cancel` reply phase was `preflight`. The case passed. So the `cancel` reply view was `cancel-requested`, and the run reply was `canceled`. All 10,000 files kept their old bytes.
- T082 runs 1 to 10 ended `failed-with-effects`. A run with another state fails the case. A W9 run prints a W9 line and leaves the series (`revert-perf.test.ts:455` and `:1002` at `2d109fff`). The f014 log has 10 counted runs and no W9 line.
- T082 runs 1 to 10, Cancel to "Checking the result…": median 139.1 ms (133.4 to 168.4 ms). The budget is 1,000 ms. The text showed before the outcome in all 10 runs.
- T082 runs 1 to 10, Cancel to the outcome: median 7,776.0 ms (7,565.8 to 7,866.6 ms), no budget.
- T082 control 1 (`t082-c1`): the new case ran against the installed b4a70d35 package (f013 installer SHA-256 `92c79f7a…`, exe `5383f1f7…`). The test came from `2d109fff` with a patch that shortens the case. Run 0 turned red at the `cancel` reply wait: "1 cancel replies did not arrive within 60000 ms: 0". The hold held the call with 1 probe. The run then installed the f014 package again, and its exe hash matched.
- T082 control 2 (`t082-c2`): the loop waits on `startsWith("Reverting ")` again, on the installed f014 exe. Runs 1 to 10 turned red: "Cancel run 1: the run gave {"state":"canceled","code":"CANCELED","files":[]}".
- The older Cancel values 49 ms and 56.1 ms were a Cancel before the first write. 49 ms is in "Full run (T049), 2026-11-03", Fail 1. 56.1 ms is in "Package run (T050), 2026-11-03", the 10,000-file row. Both places now carry this mark.

### T083 split, 2026-11-16

- Source: a packaged measurement build of `a7405f8b`, 10,000-file case of `tests/windows/revert-perf.test.ts`, Cancel during the writes, 10 runs, median. The log is in local scratch `t083-measure`.
- Cancel to the outcome: median 8,120 ms.
- `cancel` sent to the reconcile start: 130 ms.
- Fresh index read: median 2,131 ms (6 `ls-files --stage -z` runs, one per command-line batch).
- Fresh digest read: median 5,757 ms (157 `fileFacts` frames of 64 entries, one after the other).
- Outcome build: 14 ms. Reply: 750 KB. Renderer share: 70 ms.
- So the two fresh reads take about 97% of the time. The reply transport and the renderer are small.
- Fix (T083, contracts Δ3 `runWorkbench`): A, one whole-index `ls-files -z --stage` read when the paths need more than one command-line batch, bound `MUTATION_RAW_INDEX_BYTES`; B, at most `MULTI_FILE_PROOF_CONCURRENCY` (8) `fileFacts` frames at once, with the index read beside them. Plan.md D10 stays: the fresh read decides each outcome.
- Decision point for K: if the packaged SC-011 probe fails with K = 8, use K = 4 with a new constant.
- After the packaged result of the fix, the user decides on the 5 s target for a revert run (contracts Δ5). Until then, Δ5 and spec SC-007 stay as they are.
- T084 limits the `revert-files` events to 4 per second (contracts Δ2). T085 makes the result small: `counts` and the first 20 files that did not revert (data-model §9).
- Known limit of T085: the result lists at most 20 files. So the packaged W9 detection of `tests/windows/revert-perf.test.ts` is exact only up to 20 missed files.

### v0.1.3 packaged result, 2026-11-17

- User decision of 2026-11-17: the 001 5 s Cancel/reconciliation target applies to a revert run again. It replaces the second decision of 2026-11-15.
- Each counted run must reach the outcome within 5,000 ms after Cancel. The known limit left spec Assumptions.
- Build: code `9fef4a7c` on branch `v0.1.3`, with T083, T084, and T085. Installer SHA-256 `f192990f6609ac35ecfe32cea81164cc6128dc65f1f582b10ff245e93f5a7c92`.
- Installed `arbareto.exe` SHA-256 `ca72da37179240de8023b55647f32ddafd2bbad6cf26b6dd8bccb0add177c167`. Service SHA-256 `9b7ea1db0781830865ae6609182b1a5db2e86df3cba8e6bde19166392a335f16`. The exe hash was equal before and after each step.
- Git 2.56.0.windows.2, Bun 1.4.4. The logs are in local scratch `v013-session/logs`.
- S1 ran `tests/windows/revert-perf.test.ts` as a whole file from the `9fef4a7c` checkout: 6 pass, 0 fail. The CDP buffers were 512 MiB and 256 MiB (arm A).
- S3 ran only the 10,000-file limit case from a second `9fef4a7c` checkout: 1 pass, 0 fail. Its test patch set the CDP buffers to 32 MiB and 16 MiB (arm B).
- The arm B patch also printed one `MEMARM` line per run. The committed test has no such line.
- T083, runs 1 to 10, Cancel to "Checking the result…": median 158.5 ms (129.1 to 178.3 ms) in S1. The budget is 1,000 ms. S3 gave a median of 147.6 ms (132.8 to 168.6 ms). The text showed first in 10 of 10 runs in both.
- T083, Cancel to the outcome: median 2,765.3 ms, min 2,713.5 ms, max 2,839.8 ms in S1. S3 gave a median of 2,855.2 ms, min 2,821.1 ms, max 2,900.9 ms.
- The f014 run of v0.1.2 gave a median of 7,776.0 ms for the same series (T082 above).
- `cancel` sent to the end of the `run_workbench` reply: median 2,735.0 ms in S1, 2,820.3 ms in S3.
- Reply bytes: 1,844 in each run of both series. The T083 split had a reply of 750 KB.
- Renderer share (the outcome time minus the reply end): median 33.9 ms (27.5 to 38.0 ms) in S1. S3 gave 33.8 ms (32.3 to 36.7 ms).
- The session test printed the outcome series with no budget. The 5,000 ms check came after the session (user decision 2026-11-17). Every recorded run is below 5,000 ms.
- 10,000-file Revert all unstaged changes, the revert button to the end: median 214,200.0 ms in S1, 214,391.9 ms in S3. The budget is 330,000 ms. f014 gave 284,624.7 ms.
- Limit memory, S1: first run peak 263.4 MiB (budget 400 MiB), retained 46.0 MiB (budget 80 MiB). Later runs: peak max 116.1 MiB (budget 320 MiB), retained max -35.4 MiB (budget 32 MiB).
- Limit memory, S3: first run peak 294.1 MiB, retained 54.0 MiB. Later runs: peak max 197.1 MiB, retained max 19.6 MiB. Each arm ran once, so these margins are single records.
- SC-011 in S1: 18 records with 4,768 inputs. The highest p95 was 88 ms, and the slowest input took 88 ms.
- SC-011 at the limit in S1: the review had 89 inputs (p95 16 ms, max 48 ms). The run had 1,976 inputs (p95 16 ms, max 40 ms).
- SC-011 in S3: 2 records with 2,063 inputs. The highest p95 was 16 ms, and the slowest input took 48 ms.
- Memory arms A and B, 10,000-file limit case. The table gives the private bytes in MiB by run. The renderer and service values are 30 s after the run end: the "before" split plus the retained split. The tree value is the median of the 5 s window before the run.
- Arm B values come from its `MEMARM` lines. Arm A values use the same sum from the "single samples" lines of S1.

  | Run | Renderer A | Renderer B | Service A | Service B | Tree before A | Tree before B |
  | --- | --- | --- | --- | --- | --- | --- |
  | 0 | 181.8 | 182.5 | 392.0 | 389.8 | 765.3 | 749.5 |
  | 1 | 168.6 | 200.0 | 502.6 | 499.0 | 958.3 | 912.0 |
  | 2 | 182.0 | 178.1 | 504.1 | 488.3 | 1,020.5 | 1,010.5 |
  | 3 | 196.2 | 171.6 | 510.8 | 505.2 | 1,030.3 | 1,011.9 |
  | 4 | 254.5 | 172.6 | 512.1 | 516.4 | 1,049.8 | 1,008.3 |
  | 5 | 230.2 | 226.0 | 526.1 | 519.8 | 1,091.6 | 1,004.5 |
  | 6 | 293.5 | 222.0 | 530.8 | 514.1 | 1,118.2 | 1,052.4 |
  | 7 | 260.3 | 220.9 | 530.8 | 532.0 | 1,141.8 | 1,040.1 |
  | 8 | 318.8 | 174.6 | 544.1 | 523.6 | 1,184.5 | 1,039.4 |
  | 9 | 338.4 | 223.9 | 548.9 | 528.8 | 1,164.5 | 1,043.0 |
  | 10 | 318.2 | 225.8 | 550.4 | 531.4 | 1,195.4 | 1,046.6 |
  | 11 | 318.9 | 167.2 | 535.1 | 529.4 | 1,240.0 | 1,051.9 |

- Arm A: the renderer climbed from 181.8 MiB after run 0 to 338.4 MiB after run 9.
- Arm B: the renderer stayed flat, between 167.2 and 226.0 MiB.
- The service rose from about 390 MiB after run 0 to about 500 MiB after run 1. Then it levelled off in both arms.
- From run 0 to run 11, the tree "before" median rose about 43.2 MiB per cycle in arm A. In arm B, it rose about 27.5 MiB per cycle.
- From run 2 to run 11, it rose about 24.4 MiB per cycle in arm A. In arm B, it rose about 4.6 MiB.
- So the large CDP buffers keep the IPC reply bodies in the renderer and inflate its memory.
- Arm B covered only the limit case. The other five cases of the file ran only with the old buffers.
- The harness keeps 512 MiB and 256 MiB in v0.1.3. The SC-007 memory budgets come from runs with these buffer sizes.
- A switch to 32 MiB and 16 MiB needs a calibration run of the SC-007 memory budgets first (target v0.1.4).

### v0.1.3 records (T083, T084, T085), 2026-11-18

- Build: full run f015 on code `e2fa367a`, branch `v0.1.3`. Installer SHA-256 `08706d55…`, installed exe `9ed79992…`.
- The full record is 007 research.md R7 "v0.1.3 records". The logs are in local scratch `f015-full` and `v013-rerun/R`.
- `bun run test:all` exited 0: 10,445 pass, 56 skip, 0 fail (JUnit reports). Every `ORIGIN` line named the checkout under test.
- f015 green counts (pass, skip, fail): `tests/git/revert-files.test.ts` 35, 0, 0. `tests/git/revert-unstaged.test.ts` 9, 0, 0.
- More f015 counts: `tests/contracts/revert-contract.test.ts` 36, 0, 0. `tests/wsl/revert-wsl.test.ts` 13, 0, 0 in `Ubuntu-26.04`.
- `cargo test --locked`: 672 passed, 0 failed, 16 ignored.
- f015 packaged steps: `s5-revert-facts` 12 pass, 0 fail. `s5-revert-packaged` 7 pass, 0 fail. `s5-revert-perf` 5 pass, 1 fail.
- `s5-revert-perf`, 10,000-file case: only `first` failed. Run 0 kept 98.2 MiB 30 s after its end (budget 80 MiB).
- Same case in f015: Cancel to the outcome median 2,875.6 ms, max 2,908.8 ms (budget 5,000 ms). The other fields held.
- User decision of 2026-11-17: rerun the case. T089 holds the baseline window fix, target v0.1.4.
- Rerun R3, 2026-11-18: only the 10,000-file case, at 9a88708d on the f015 build. 1 pass, 0 fail, 60.4 min.
  - R3 run 0: peak growth 254.5 MiB (budget 400 MiB), retained 30.3 MiB (budget 80 MiB).
  - R3 later runs: peak max 167.8 MiB (budget 320 MiB), retained max 26.7 MiB (budget 32 MiB).
  - R3 Cancel to the outcome: median 2,820.9 ms, max 2,858.8 ms (budget 5,000 ms).
  - R3 Cancel to "Checking the result…": median 161.9 ms (budget 1,000 ms). The revert of 10,000 files: median 212,513.4 ms.
  - Every `ORIGIN` line of R3 names the checkout under test or the installed exe.
- The earlier session S1 above ran the whole file on code `9fef4a7c`: 6 pass, 0 fail. Its outcome median was 2,765.3 ms.
- Control of the 5 s budget (local scratch `v013-final/control.log`, exe `9ed79992…`): the same case with the 1,000 ms outcome budget.
  - Cancel to the outcome: median 2,959.1 ms, max 2,981.4 ms. The assert gave `outcome: false`. Result: 0 pass, 1 fail.
  - The control ran from another local worktree. Its `ORIGIN` lines name that worktree.
- T083, T084, T085 (ticked): the 008 rule needs a green Windows run with `ORIGIN` lines in the checkout under test.
- f015 is that run: `test:all` for the Bun and WSL tests, and `s0e-cargo-test` for the Rust tests.
- The tick tree differs from e2fa367a in CHANGELOG.md and 3 test files. The revert tests use only fixture-root.ts. That change raises the root removal timeout and adds the removal time to the log.
- For `revert-perf.test.ts`, f015 plus R3 hold every budget of the 10,000-file case. The other five cases passed in f015.
- The green `test:windows` clause holds only through the user decisions of 2026-11-17 and 2026-11-18 (007 R7).
- T053 and T082 are ticked. T083 depends on T084 and T085, and T085 depends on T084. So the three tasks tick together.
- Reviewer findings of the v0.1.3 review. User decision of 2026-11-18: they ship as tested, and the fixes target v0.1.4.
  - LOW 3: `envelope.ts` and `revert.ts` each hold their own constant for the 20-file cap (T086).
  - LOW 4: the whole-index read of `indexEntriesOf` also serves the D5a batch reads (T087).
  - Suspicion: a canceled `fileFacts` frame may not wait for the shell walk of that frame (T088).

### T088 canceled `fileFacts` walk, 2026-11-21

- Result: the suspicion is true. The service ends a canceled `fileFacts` call before the shell walk of that frame ends.
- 001 contract §6 "Walks" defines this behavior. The service does not wait for the shell after `cancel`, and no reply follows. The "Limit" bullet there covers an I/O that ignores the cancel.
- Service: on an abort, `ask` in `src/git-service/native-runner.ts` resolves `canceled` and then sends `cancel`. It drops a later reply with that `callId`.
- Test: `tests/contracts/native-runner.test.ts`, "an abort sends one cancel with the walk callId and ends the call at once, and a later reply is dropped". The "native runner walks" group gave 6 pass, 0 fail. Its `ORIGIN` lines named the checkout under test.
- Control: without the immediate resolve in `ask`, the test timed out: 0 pass, 1 fail.
- Shell: `cancel` sends `WalkEvent::Stop` (`src-tauri/src/process_requests.rs`). For a `Reply::Walk`, the watchdog sends no reply. It sets the stop flag and calls `CancelSynchronousIo` every 10 ms for at most 5 s (`cancel_io`, `CLOSE_WAIT`).
- The walk checks the flag before each open, query, and 1 MiB read chunk (`src-tauri/src/file_facts.rs`, `check` and `pour`). So the walk ends after its current I/O.
- The cargo test `a_canceled_walk_ends_without_a_reply` covers the shell stop. T088 did not run it.
- The shell double `tests/git/bun-runner.ts` ends a held walk at the abort. It does not model a walk that outlives its call.
- Which frames a stop reaches in `revert.ts`: the review reads use `ctx`, so a Cancel stops them. The review then ends, and no write follows.
- The run reads use `q`, whose signal never aborts (`WorkbenchRun` in `workbench-review.ts`). A Cancel during the writes stops no `fileFacts` frame.
- Only the fresh digest read of the reconcile has sibling frames in flight (up to `MULTI_FILE_PROOF_CONCURRENCY`). The first stop or failure of one frame stops its siblings. The outcome is then unknown, and no write follows.
- Windows effect: each open of the walk shares read, write, and delete access. The walk asks only for read rights. It writes nothing, because `pour` gets no `out` handle.
- Each production open in `src-tauri/src/file_replace.rs` shares read access. So a later write, rename, or `tempRemove` open stays compatible with a stopped walk that still reads.
- A stopped walk sends no fact. So no stale fact enters an outcome.
- Decision (reviewer default, T088): no fix. A fix needs a stop reply in 001 contract §6, and each stop then waits for the walk end. The behavior stays as a known limit in spec Assumptions. The user can still choose a fix.
- Open: a WSL stop ends the `wsl.exe` process of the walk. T088 did not check in a distro when the Linux reader ends.
- User decision 2026-11-21: "Accept no fix". The known limit stays in spec Assumptions.
- Before the T088 tick: check in a distro when the Linux reader ends after `wsl.exe` is killed. Run the cargo test `a_canceled_walk_ends_without_a_reply`.
- Result, 2026-11-22, for the two open items above:
  - The new cargo test `the_real_stop_of_a_file_facts_walk_ends_its_perl_reader` is in `src-tauri/src/wsl.rs` (commit 0faec152). It is next to `the_real_stop_of_one_wsl_exe_ends_only_its_scope`. It runs only on the reference distro Ubuntu-26.04.
  - Method: a `stream` digest walk holds the Perl reader on a 64 GiB sparse file. The walk asks for `digest` and `stream`, as revert reads do.
  - The test sets the stop Event. The walk collector then ends `wsl.exe` with `TerminateProcess`.
  - The test uses the test host `JobHost::run_walk`. It and the product `OperationHost::run_walk` both call `start_and_collect` and `collect`.
  - The test decides from process records only. It checks the cgroup directory of the unit (`test -d /sys/fs/cgroup<cg>`). It checks `/proc/<perl pid>/stat` and its start time (field 22). It does not use `list-units`.
  - Main case: the cgroup and the Perl process were gone at 0 s, 1 s, and 5 s after the stop. The close budget is 5 s.
  - In-test control: `systemctl` is `/bin/true`, so the trap ends nothing. The cgroup and Perl, with the same start time, were alive at 0, 1, and 5 s. So the file holds the reader long enough.
  - Control mutation: the wrapper line `trap 'end; exit 129' HUP` became `trap 'exit 129' HUP`. `src/contracts/wsl-process.json` holds the line, and `include_str!` embeds it. The main case then failed at the 5 s assertion, and Perl stayed alive. The run then restored the line.
  - The cargo test `a_canceled_walk_ends_without_a_reply` passed on the candidate.
  - No scope, process, or fixture folder remained after the runs.
  - So 001 contract §11 holds for `fileFacts` walks: a stop ends the `wsl.exe` of the call, and the wrapper trap ends its scope (`operations.md:1552`, `:1593`).
  - The known limit in spec Assumptions stays as decided: the service does not wait for the walk end. On the reference distro, the reader ends within the close budget. Other distros are not checked.
  - Not shown: the WSL-internal source of the `SIGHUP`. Only repo probe P1 and T392 show it. DeepWiki found no WSL code for it.
  - Environment: the test ran on build 0faec152 on 2026-11-22. `wsl.exe --version` gave WSL 3.0.5.0 and kernel 6.18.58.1-1. `uname -r` in Ubuntu-26.04 gave `6.18.58.1-microsoft-standard-WSL2`.

### T089 first-run retained budget, 2026-11-21

- Offline replay of the saved samples with the window rules of `tests/windows/revert-perf.test.ts`. The replay gives the recorded 98.2 MiB (f015) and 30.3 MiB (R3) exactly.
- Sample files (local scratch): f015 `t048-limit-2026-11-17T18-55-45-333Z.jsonl`, R3 `t048-limit-2026-11-18T10-12-45-159Z.jsonl`, v013-final control `t048-limit-2026-11-17T09-44-10-649Z.jsonl`. Replay output: `t089-replay2.txt`.
- A run 0 baseline window that ends before the review opens raises the retained growth. f015: 98.2 to 122.0 MiB. R3: 30.3 to 65.0 MiB. v013-final 5 s control run: 51.0 to 105.7 MiB.
- With that window, the peak growth also rises by about 24 to 55 MiB.
- The replay tried each 5 s window that ends between 5 s after the sampler start and the confirmation press. The lowest f015 retained growth is 98.2 MiB, at today's window end. No baseline window makes f015 pass.
- No cause is on record. At 30 s after the run end, the renderer holds 185.8 MiB in f015 and 148.7 MiB in R3.
- The service holds +30.3 MiB in f015 and +5.0 MiB in R3. The GPU process holds about +37 to 41 MiB in all three runs.
- Why the runs differ is a hypothesis only.
- User decision 2026-11-21: "Calibrate a first-run budget". The baseline window does not change. The 2026-11-03 method (medians of 5 s windows) stays.
- Calibration: 5 packaged first runs of the 10,000-file case on the v0.1.4 candidate.
- Rule: the run 0 retained budget is the highest run 0 retained growth of those runs plus 64 MiB, rounded up to whole MiB. This is the SC-002 rule (005 research.md "SC-002 calibration", 007 research.md).
- Record for each run: the retained growth and its split over the renderer, the service, and the GPU process.
- The calibrated value replaces only the run 0 retained budget (`LIMIT_FIRST_RETAINED_BYTES`, today 80 MiB). The other SC-007 budgets do not change.
- Control: a run 0 retained budget of 1 MiB must fail on one of the runs (`first: false`).
- Open: the calibration runs. The run 0 retained budget stays pending until this record holds them.
- Result, 2026-11-22: the run 0 retained budget is 164 MiB. The calibration runs below close the open item.
- Build: the installed v0.1.4 candidate from `v0.1.4-rc` at `8234671a`. The exe SHA-256 `16B34481…` matched before and after every run.
- Every `ORIGIN` line names the candidate worktree. Each run started a fresh app with its own profile folder.
- Filter: only the case "at the 004 multi-file limit of 10,000 files". The 2026-11-03 method (medians of 5 s windows) did not change.
- The runs kept `ARBARETO_WSL_DISTRO=Ubuntu-26.04` from the R3 driver. The shared setup of the file touches a WSL fixture.
- Split: the 5 s window median at the retained point (30 s after the run end) minus the window median at the confirmation. Unit: MiB.

| Run | Start | Minutes | Exit | Free GB | Run 0 retained | Run 0 peak | Renderer / service / GPU | Runs 1 to 10 retained max / peak max |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-11-21 21:58 | 61.4 | 1 | 17.31 | 85.8 | 270.3 | +20.4 / +25.0 / +34.7 | 10.0 / 191.3 |
| 2 | 2026-11-21 23:00 | 61.0 | 1 | 14.47 | 91.3 | 274.6 | +18.6 / +34.9 / +36.6 | -17.5 / 154.2 |
| 3 | 2026-11-22 00:01 | 62.1 | 1 | 14.43 | 99.1 | 291.9 | +21.5 / +30.6 / +41.1 | -13.9 / 189.0 |
| 4 | 2026-11-22 01:03 | 61.4 | 1 | 14.50 | 96.4 | 274.1 | +23.6 / +32.5 / +36.8 | -18.5 / 156.4 |
| 5 | 2026-11-22 02:05 | 61.0 | 0 | 14.39 | 34.5 | 256.3 | -16.9 / +12.2 / +37.2 | -0.9 / 154.4 |

- Other process kinds stay within -0.4 to +3.6 MiB. A replay of the samples gives the same totals as the test log lines.
- Runs 1 to 4 failed only the check `first` (80 MiB budget). All other checks passed in all 5 runs.
- Rule: 99.1 + 64 = 163.1 MiB, rounded up to 164 MiB. `LIMIT_FIRST_RETAINED_BYTES` is now 164 MiB.
- Control: the in-test check `first` failed at 80 MiB in runs 1 to 4. A 1 MiB budget fails all 5 runs by the logged values. No separate 1 MiB packaged run was made.
- Comparison: on v0.1.3 code, before the T087 index-read change, f015 run 0 kept 98.2 MiB and R3 kept 30.3 MiB. The f015 service term was about +30.3 MiB.
- The candidate shows the same two levels: 85.8 to 99.1 MiB, and 34.5 MiB. The service term (+12.2 to +34.9 MiB) is at or below the f015 level.
- So the data shows no rise from T087. The GPU process grows by +34.7 to +41.1 MiB in every run. Run 5 is low because the renderer fell by 16.9 MiB.
- Caveat: 5 samples with a wide spread may not show the true maximum. The 64 MiB margin covers this. The candidate full run checks the budget again.
- Logs and samples: local scratch.
