# Research: History Inspection and Commit View File Actions

## R1 Sources and fact marks

- Git documentation: git-diff-tree(1), diff-format(5), git-diff(1) `--numstat`, git-ls-files(1) `--directory`, git-ls-tree(1), git-cat-file(1), git-check-ignore(1), gitignore(5), git-blame(1) "THE PORCELAIN FORMAT" and "INCREMENTAL OUTPUT", config/blame.adoc, git-config(1), git-rev-parse(1), git-for-each-ref(1).
- Git source: the Git 2.56 tree at `scratchpad\gitrepo` (commit a018953), read on 2026-10-21. The Git 2.55 sources and docs at `scratchpad\f005-plan\git255`. Line numbers below are Git 2.56 unless marked.
- The ignore preview report of 2026-10-21 (`scratchpad\ignore-preview\report.md`), with its fixture scripts in `scratchpad\ignore-preview\fx\`. It ran on Git 2.56 Windows and Git 2.55 WSL.
- The feature design of 2026-10-21 (`scratchpad\f005\design.md`), with probes on Git 2.56.0.windows.2 fixtures under `scratchpad\f005-plan\fx1`.
- Microsoft Learn: `IFileOperation`, `IFileOperation::SetOperationFlags`, `IFileOperationProgressSink::PreDeleteItem` and `PostDeleteItem`, `FILE_DISPOSITION_INFO_EX`, `FILE_RENAME_INFO` (`FileRenameInfoEx`), `NtCreateFile`, `SHOpenFolderAndSelectItems`.
- Repository code at main 3575a15, read through CodeGraph and by line: `src/git-service/{comparison,commands,diff-parser,history-view,history-topology,history-layout,ignore,session,registration,refs-parser,submodule-review}.ts`, `src/contracts/{limits,channel,envelope,ignore-line,submodules}.ts`, `src/frontend/{changes/file-tree.ts,changes/ChangesPane.tsx,changes/PatchView.tsx,refs/ReferencesSidebar.tsx,branches/BranchButton.tsx,history/CommitDetails.tsx}`, `src-tauri/src/{service,settings,process_requests,file_append,wsl}.rs`, `src/contracts/wsl-process.json`.
- Git Extensions source (GPL-3.0, ideas only), read on 2026-10-21 (spec "Research inputs").
- Marks: "doc" is a documentation statement. "source" is a Git source statement. "code" is this repository. "report" is the ignore preview report. "probed" is a design probe of 2026-10-21. "experiment" needs a P0 test, listed in R16. "unverified" has no source and no test yet.

## R2 History diff

- Decision: `diff-tree -r -z --raw -M -l1000 <base> <commit>` with the 001 read options for the list, and `diff-tree` with the 001 `PATCH_OPTIONS` or `NUMSTAT_OPTIONS`, `-M -l1000`, and the path pair for one file (plan D3).
- Rationale: `diff-tree <merge>` alone prints nothing, and the two-tree form works for any parent (probed). A root commit compares with the empty tree of `emptyTreeArgs()`, which covers SHA-1 and SHA-256 (code, `commands.ts:296`; probed). The raw `-z` record grammar is fixed (doc, diff-format(5)). `-l1000` fixes the rename limit, so `diff.renameLimit` cannot change the list (doc, diff-options `-l<num>`). diff-tree prints full object IDs, because it sets `abbrev = 0` (source, builtin/diff-tree.c:134).
- Parents come from the history view topology (`history-topology.ts:143` `parents`, `:190` `rowOf`), not from the renderer (code). A row without parents is `shallow` when the shallow set holds it, else `root` (code, `history-layout.ts:83`).
- The path-pair patch pairs a rename inside its pathspec (probed). `parsePatch` accepts no rename header today (code, `diff-parser.ts:129-157`). It gains `similarity index`, `rename from`, and `rename to` from diff.c `fill_metainfo` (source).
- A type change prints two patch sections (experiment F3). The diff then shows the fact line only.
- Missing objects take the 001 §7 path (code, `comparison.ts:474-483`).
- Bounds: the status listing bounds (100,000 records, 32 MiB), because the raw record has the same form; the 8 MiB encoded page of `readHistoryRows`; the 001 canonical diff bounds (code, `limits.ts:21-24`, `:36`).
- Alternatives considered: `git log -p` or `git show` (porcelain, they read diff UI configuration and print commit headers); `diff-tree <commit>` (prints nothing for a merge, design R1); a combined diff of a merge (spec excludes it).

## R3 Tree order

- Decision: folders first; then names by bytes after the ASCII fold of A to Z; then raw bytes (plan D4). One module `src/contracts/tree-order.ts` serves the renderer and the service.
- Rationale: Git Extensions sorts folders first with `StringComparer.InvariantCulture` (Git Extensions source, `PathFirstComparer`). A culture collator and `toLowerCase` depend on the WebView2 ICU data and fail on bytes that are not valid UTF-8. An ASCII fold on bytes gives the same order on every build. It differs from Git Extensions only for non-ASCII letter case pairs.
- Today `file-tree.ts:33` keeps the status read order, and `ReferencesSidebar.tsx:104` keeps the first-entry order (code). No test asserts an order.
- Packed refs or reftable hold `feature/b` and `Feature/a` apart. Loose refs on a case-insensitive volume share one folder (clarify F6), so the US3 fixture uses packed refs.
- Alternatives considered: Explorer `StrCmpLogicalW` (natural number order, locale-dependent, Windows only); Git's own tree order (byte order with folders as `name/`, which mixes folders and files).

## R4 Show a folder in Explorer

- Decision: `revealPath` gains `folder`. The shell walk stays (plan D5).
- Rationale: the walk already accepts a `Directory` fact (code, `process_requests.rs:1263-1272`). `SHOpenFolderAndSelectItems` on a folder item opens the parent with the folder selected (doc; experiment N8). The folder check reuses the `reviewIgnore` prefix rule (code, `ignore.ts:129-133`).
- The walk reply gains `absent`, so the service can state "does not exist" from a fact. Today every walk refusal gives `UNKNOWN_TARGET` (004 contract Δ3).
- Alternatives considered: `explorer.exe /select,` (Git Extensions; a command line with a path, no fact result).

## R5 Delete on Windows

- Decision: a new shell request `fileDelete`. A no-follow relative walk holds each folder handle without `FILE_SHARE_DELETE`. Delete permanently uses `FileDispositionInfoEx` with POSIX semantics on the checked handle. The Recycle Bin uses `IFileOperation` with a progress sink (plan D7).
- Rationale:
  - `NtCreateFile` with `OBJ_DONT_REPARSE` relative to the parent handle keeps the walk below the root by identity (code, `file_append.rs:5`, `:139`). `CreateFileW` follows a reparse point on the way (004 D14).
  - A folder handle open without `FILE_SHARE_DELETE` blocks another `DELETE` open, so no process can rename that folder during the request (doc, `NtCreateFile` share access; experiment N6).
  - A link to a folder is a directory reparse point, so the target open must not pass `FILE_NON_DIRECTORY_FILE` (clarify contradiction 7).
  - `FILE_DISPOSITION_FLAG_POSIX_SEMANTICS` removes the name at once. Without `FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE`, a read-only file is not deleted (doc, `FILE_DISPOSITION_INFO_EX`; experiment N5).
  - `IFileOperationProgressSink::PostDeleteItem` gives `hrDelete` and `psiNewlyCreated` per item. "If the item was fully deleted, this value is NULL" (doc). `PreDeleteItem` can return a failure that cancels this and all later items (doc).
  - `FOF_WANTNUKEWARNING` "sends a warning if a file is being destroyed during a delete operation rather than recycled", and it "partially overrides `FOF_NOCONFIRMATION`" (doc). The exact dialog and the `hrDelete` value after No are unverified (N2).
  - `FOFX_EARLYFAILURE` cancels the rest after one failure (doc). The plan leaves it out (plan O-7).
- The Recycle Bin call takes a path (`SHCreateItemFromParsingName`), so a swap of the last component after `PreDeleteItem` reaches the swapped item. The spec states this limit (FR-031).
- Alternatives considered: `SHFileOperationW` (no per-item result; design R4); `DeleteFileW` (follows nothing at the last component, but opens by path again after the check); moving files into an own trash folder (no Windows Recycle Bin, so "just like in Windows" fails).

## R6 Delete in WSL

- Decision: a new `wslFiles` mode `delete` with `lstat`, the bound compare, `unlink`, and `rmdir` (plan D7).
- Rationale: the WSL route already runs every file write inside the distro through `wslFiles` (code, `wsl.rs:1549-1587` mode `append`). The name `remove` is taken: it removes an owned lock or candidate in the Git directory (code, `wsl-process.json` `remove`). A WSL distro has no Recycle Bin, so plain Delete opens the permanent confirmation (spec Clarifications).
- Limit: POSIX has no `unlinkat` on an identity, so the steps act by path after `lstat` (spec FR-031).
- Alternatives considered: `rm` through `wsl.exe --exec` (follows no link with `-r`, but gives no per-entry fact); `\\wsl.localhost` deletes (user rule against UNC file work).

## R7 Ignore read and text codec

- Decision: `readIgnoreFile` reuses `targetOf` and `factOf` (code, `ignore.ts:93-120`). WSL reads the one file through `fileFacts` `content` (recommendation Q1). The codec keeps the BOM, round-trips LF and CRLF, and refuses mixed endings (plan D8).
- Rationale:
  - Git skips a UTF-8 BOM in an ignore file (source, dir.c:1242 `skip_utf8_bom`). So the BOM stays as the file has it.
  - A `textarea` value normalizes CR and CRLF to LF (doc, HTML "textarea" API value). So only a file with one line-ending form can round-trip exactly. Mixed endings and a lone CR refuse.
  - Git drops a CR before an LF in a pattern line (code, `ignore.ts:84`). A file without a line ending saves with LF, as the 004 append wrote LF (code, `ignore.ts:162`; clarify F5).
  - The WSL `fileFacts` digest probe already sends the bytes to the shell, which hashes and drops them (code, `wsl.rs:1094` `fact`; recommendation Q1). Forwarding at most 1 MiB to the service needs no UNC read.
- Alternatives considered: a code editor component (a new dependency and its own normalization rules); a UNC read of the file (user rule).

## R8 Ignore preview method

- Decision: a shadow repository that holds only the ignore files, with `check-ignore --no-index -z --stdin -v -n` on the real path lists, plus a folder collapse by Git's excluded-folder rule and a self-check against the real repository (plan D9).
- Rationale (report, all 11 cases "shadow==truth" on Windows and WSL):
  - The ranking of pattern groups is `EXC_CMDL`, `EXC_DIRS`, `EXC_FILE`, the last list first, the last pattern first (source, dir.c `last_matching_pattern_from_lists`). `--exclude-from` lands in `EXC_FILE`, so it is wrong for a `.gitignore` edit (report S1, S2, S2b, S3).
  - `check-ignore` calls the same `last_matching_pattern` that the directory walk uses (source, check-ignore.c:112; dir.c `is_excluded`). Its `prep_exclude` reads `<dir>/.gitignore` and checks each parent as a folder, so the shadow needs only the ignore files.
  - An excluded parent folder ends the walk, and every path below takes that folder pattern (source, dir.c:1731-1745). So a folder that both texts ignore counts as one path, and no path below it needs a check (spec FR-039; experiment F12).
  - In-tree `.gitignore` files open with `PATTERN_NOFOLLOW` (source, dir.c:1779). `info/exclude` and `core.excludesFile` follow a link (report Q1).
  - `check-ignore --no-index` loads no index (source, check-ignore.c:187), so the real self-check runs no `core.fsmonitor`.
  - `git init --template=` creates no `info/exclude` (report, verified). `checkout-index` needs `core.autocrlf=false` and `core.eol=lf` on Windows (report step 4).
  - Gitlinks, nested repositories, and folder inputs need an empty folder in the shadow (report E1). A skip-worktree `.gitignore` needs its index blob (report E5; dir.c `read_skip_worktree_file_from_index`).
  - A stdin path that starts with `:` is read as pathspec magic, and `--literal-pathspecs` exits 128. A `./` prefix reads it literally (report, verified on WSL; unverified on Windows, where NTFS cannot hold `:`).
  - The shadow gets the real `core.ignorecase` and `core.excludesFile` with `-c`, because `git init` writes its own `core.ignorecase` (report).
- Universe: `ls-files -o -z --directory --no-empty-directory` prints a folder without tracked entries as one record (doc, git-ls-files(1) `--directory`; experiment F10). An expansion `ls-files -o -z -- <d>/` lists every untracked file below it.
- Self-check: the S shadow and the real `check-ignore --no-index` must give equal verdicts on every input before any preview shows (spec FR-039). This guards against config keys that the report did not test.
- Cost (report): `check-ignore` 4.1 to 5.0 s for 100,000 paths on Windows (3.9 to 4.7 s without `-v`), 0.52 to 0.68 s for 10,000; 0.28 to 0.34 s in WSL. `ls-files -o -z` at 100,000 files 0.68 to 0.73 s on Windows and 0.08 s in WSL. A full shadow of empty files costs 58 s to create and 37 s to delete at 100,000 on Windows, so it is out. The WSL pipe carries about 2.5 to 2.8 MB at 100,000 paths.
- Alternatives considered: `--exclude-from` substitution (wrong, report Q1); a full shadow of every path (58 s); `GIT_WORK_TREE` alone (does not cover `info/exclude`, report); a temporary index with `ls-files -c -i` (faster, about 1.5 s plus 0.5 s at 100,000, but it does not name the pattern, and the notices need the source field); Git Extensions `ls-files -o -m -c -i -x <pattern>` (ignores the existing sources and their precedence, spec Research inputs).

## R9 Ignore save

- Decision: `fileReplace` writes a temporary file in the same folder and renames it over the target in one step (plan D10).
- Rationale: `FileRenameInfoEx` with `FILE_RENAME_FLAG_REPLACE_IF_EXISTS|FILE_RENAME_FLAG_POSIX_SEMANTICS` replaces the target name in one call, also while a reader holds it with `FILE_SHARE_DELETE` (doc; experiment N7). Without `FILE_RENAME_FLAG_REPLACE_IF_EXISTS`, the rename fails when the name exists, so an absent target stays absent until Save. POSIX `rename(2)` is atomic on one file system (doc, POSIX.1-2024). `link(2)` fails with `EEXIST` on an existing name (doc).
- The stale check compares size and SHA-256 with the loaded state. Git Extensions overwrites a changed file (spec Research inputs); this check fixes that.
- Alternatives considered: the 004 `fileAppend` (appends one line only); an in-place rewrite (a crash leaves a cut file); `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING` (takes paths, so the walk identity is lost).

## R10 Open submodule

- Decision: a native-first `openSubmodule` that reuses the `openWorktree` shell step and the 001 discovery and registration (plan D11).
- Rationale:
  - `ls-files -z --stage -- <path>` gives the gitlink record of the parent index (doc). It loads the parent index, so it waits behind the parent read gate (source, builtin/ls-files.c:681).
  - The discovery profiles load no index (code, `commands.ts:33-46`). An uninitialized folder resolves to the parent toplevel, so the identity compare refuses it (experiment F16).
  - Registration releases the parent, because the common identity differs, and an unfinished mutation of the parent gives `BUSY` (code, `registration.ts:179-180`).
  - Each `openWorktree` success stores a recent entry: `registered_root` matches `openWorktree` (code, `service.rs:760-768`), and `remember` stores the entry (code, `service.rs:1050-1068`). The design marked this unverified; the code settles it. `openSubmodule` joins the same list.
  - The recent list result names no `worktreeKey`, only `current` (code, `envelope.ts:576-591`). So the renderer takes the parent entry as the `current` entry before the open. The list holds at most 20 entries (code, `settings.rs:272`), so a chain of 8 fits, and other opens can still push the parent out.
- Alternatives considered: `rev-parse --show-superproject-working-tree` for the back link (it runs `ls-files` in the parent, which can run the parent `core.fsmonitor` before trust, design R6); a new window per submodule (user decision: same window).

## R11 Blame

- Decision: `blame --incremental --no-textconv --encoding=none` without an ignore list, and `-c blame.markIgnoredLines=true -c blame.markUnblamableLines=true blame --porcelain --no-textconv --encoding=none` with one (plan D12).
- Rationale:
  - Blame sets `allow_textconv = 1` (source, builtin/blame.c:1026), so `--no-textconv` is needed.
  - Incremental output prints the group and commit headers as Git finds them, so it gives progress counts. It prints no ignore markers (probed). Porcelain prints `unblamable` and `ignored` per line only with the mark keys (source, builtin/blame.c `emit_porcelain_per_line_details`), and only after the whole blame ends.
  - `blame.ignoreRevsFile` repeats, and an empty value resets the list (doc, config/blame.adoc:24-28; source, builtin/blame.c:764-772). Git reads every listed file in `build_ignorelist` before an empty command-line value clears the list, so a missing file exits 128 in both toggle states (probed; source).
  - The value passes through `git_config_pathname`, which expands `~/` and `%(prefix)/` (source). So only a plain relative value gets the worktree-root check.
  - `blame.showRoot` changes the `boundary` header (source, builtin/blame.c:742). So the shallow state comes from the shallow file, not from `boundary`.
  - A last line without LF counts as a line (source, blame.c `find_line_starts`).
  - `ls-tree -l` gives the mode, the type, and the size in one record without the index (doc, git-ls-tree(1) `--long`). A gitlink has type `commit`.
  - The binary fact comes from `git diff --numstat` of the empty tree and the commit for that path (spec FR-061). `git diff` of two trees loads no index (R13). `diff-tree` would load it.
- Alternatives considered: `--line-porcelain` (repeats all headers per line, larger output); two runs, incremental then porcelain (twice the time, clarify Q3); dropping the marks (loses FR-059); `-c blame.ignoreRevsFile=` (does not prevent the exit 128, design).

## R12 Blame before this commit

- Decision: `diff -U0 --no-textconv --no-ext-diff --no-color <old blob> <new blob>` and the hunk-header map of spec FR-056 (plan D12).
- Rationale: with two blob arguments, `git diff` runs `builtin_diff_blobs` (source, builtin/diff.c:628), which reads no index (builtin/diff.c:115). `refresh_index_quietly` runs only when `skip_stat_unmatch` exceeds 1 (builtin/diff.c:650), and a pair of valid object IDs never raises it (source, diff.c:7366). So the read waits behind no gate. The design marked this unverified; the source settles it, and F4 checks it with a canary.
- The original line number comes from the blame group header (doc, git-blame(1) porcelain `<orig line>`). The previous commit and path come from the `previous` header (doc).
- The diff options follow the user's own diff configuration, such as `diff.algorithm`. The map uses Git's own zero-context diff, as the spec states.
- Alternatives considered: a second blame of the previous version without a map (the focus would start at line 1); an own diff algorithm (not Git's fact).

## R13 Index loads of the reads

| Command | Loads the index | Source |
|---|---|---|
| `diff-tree` | Yes | builtin/diff-tree.c:132 |
| `ls-files` | Yes | builtin/ls-files.c:681 |
| `update-index`, `checkout-index` (shadow only) | Yes, the shadow index | builtin/update-index.c:1110, builtin/checkout-index.c:262 |
| `check-ignore --no-index` | No | builtin/check-ignore.c:187 |
| `git diff` of two trees or two blobs | No | builtin/diff.c dispatches to `builtin_diff_tree` (:642) or `builtin_diff_blobs` (:628); only :163-167, :246, :285 read the index |
| `blame <commit> -- <path>` | No | blame.c:205, :290 read it only in `fake_working_tree_commit` |
| `ls-tree`, `cat-file`, `hash-object` | No | no `repo_read_index` call in builtin/ls-tree.c, builtin/cat-file.c, builtin/hash-object.c |
| `rev-parse --git-path` | No | builtin/rev-parse.c:1092 reads it only for `--shared-index-path` |

- An index load runs `tweak_fsmonitor`, which can start a command-valued `core.fsmonitor` (source, read-cache.c; clarify F1). The 001 contract blocks such reads until trust approval (001 `contracts/operations.md:1034`).

## R14 Branch gone mark and card

- Decision: `upstreamPresent` from the same `for-each-ref` read, and the gone rule `upstream !== null && !upstreamPresent` (plan D13).
- Rationale: `%(upstream)` prints the mapped ref also when that ref is missing (design R9). `RefEntry` already computes `upstreamPresent` this way (code, `refs-parser.ts:94`). A missing remote gives no fetch refspec, so `branch_get_upstream` returns NULL and `%(upstream)` is empty (source, remote.c:1796-1801, :1908; clarify F2). The 003 `%(upstream:track,nobracket)` `gone` agrees, and `for-each-ref` prints it untranslated (source, ref-filter.c:50, design R9).
- "Cut" is the layout fact `scrollWidth > clientWidth` of the name element (doc, CSSOM View). It needs no text measure.
- The card uses Base UI PreviewCard, which `@base-ui/react` already ships (code, `package.json`). The shadcn `hover-card` wrapper of the `base-mira` registry is unverified until WP2 runs the generator.
- Alternatives considered: a `title` attribute (no keyboard access, no structure); a second `for-each-ref` read (spec FR-066 forbids a new read).

## R15 Dates and age shades

- Decision: rank-based shades over the distinct author times of the file, and a relative date text with fixed thresholds (plan D12).
- Rationale: the spec defines the rank rule (FR-055). A rank needs no current time, so a stored screenshot keeps its shades. The relative text uses the current time, because it is text, not shade. The thresholds match the board samples ("8 days ago", "2 weeks ago").
- Alternatives considered: equal time buckets between the oldest and the newest commit (one old commit compresses every other commit into one step); `Intl.RelativeTimeFormat` (its text depends on the WebView2 locale data, and plan.md owns every visible text).

## R16 Open facts (P0 list)

Each Git fact runs on Windows Git 2.56 and WSL Ubuntu-26.04 Git 2.55, compared with Git's own command on a copy. Each records the observed version.

- F1: the raw `-z` grammar of `diff-tree -r -z --raw -M -l1000` for A, D, M, R, T, a gitlink, and a link; the root form against the empty tree for SHA-1 and SHA-256; `diff-tree <merge>` alone prints nothing.
- F2: above `-l1000`, Git prints a D and an A record, and `diff.renameLimit` has no effect.
- F3: the path-pair patch of a rename parses with the extended header rules; the patch form of a type change.
- F4: canaries. `diff-tree` and `ls-files` run a command-valued `core.fsmonitor`. `git diff` of two trees and two blobs, `ls-tree`, `cat-file`, `blame <commit>`, and `check-ignore --no-index` do not.
- F5: the `ls-tree -z -l --full-tree <oid> -- <path>` record for a blob, a link, and a gitlink; a missing tree in a partial clone exits non-zero with `--no-lazy-fetch`.
- F6: both blame grammars, with `previous`, `filename`, `boundary`, the porcelain marks under the `-c` keys, no marks in incremental output, and the line count with a last line without LF.
- F7: a missing relative `blame.ignoreRevsFile` exits 128 with and without `--ignore-revs-file=`; an empty value resets; `--ignore-revs-file=` clears; a `~/` value.
- F8: the attribution equals `git blame --porcelain` with `-w`, `-M`, and `-C` on every fixture line.
- F9: the `diff -U0` hunk headers of two blobs and the FR-056 map on the fixtures.
- F10: `ls-files -o -z --directory --no-empty-directory` prints each folder without tracked entries as one record, and a nested repository as `x/`; the expansion lists every untracked file below the folder; a nested repository expands to zero records.
- F11: the S shadow equals the real `check-ignore --no-index` for the report cases C0 to C8 and W1, with folder inputs, gitlinks, and a skip-worktree `.gitignore`; the C shadow preview equals the change of `ls-files -o -i --exclude-standard -z` and `ls-files -c -i --exclude-standard -z` after a real save on a copy.
- F12: the folder collapse equals the per-file check for every fixture.
- F13: the `./` stdin prefix for a path that starts with `:` (WSL), and the form of the echoed pathname field.
- F14: `hash-object --stdin-paths` with C-quoted lines in the shadow context; the `checkout-index` byte check; the `info/exclude` placement through the second index.
- F15: Windows shadow paths of 260 or more UTF-16 units with `core.longpaths` false.
- F16: open submodule facts: the `ls-files --stage` gitlink record; the discovery of an uninitialized folder resolves to the parent; a `.git` file with a missing Git directory fails the discovery.
- F17: `%(upstream)` for a pruned upstream (name present, ref missing) and for a removed remote (empty).
- F18: `rev-parse --path-format=absolute --git-path info/exclude` in a linked worktree (004 F23 again).
- N1: `IFileOperation` recycle of a file gives S_OK with a non-null `psiNewlyCreated`, and the item is in the Recycle Bin. The test purges it.
- N2: on a volume without a Recycle Bin, `FOF_WANTNUKEWARNING` with `FOF_NOCONFIRMATION` shows the Windows warning; No keeps the file and gives the recorded `hrDelete`; Yes deletes it with a null `psiNewlyCreated`.
- N3: a symbolic link to a folder and a junction go to the Recycle Bin as links, and the targets stay.
- N4: a `PreDeleteItem` failure cancels the later items, and they reply `stopped`.
- N5: `FileDispositionInfoEx` with POSIX semantics on a file, a file link, a folder link, and a junction; a read-only file gives `STATUS_CANNOT_DELETE`; the result on a volume without POSIX delete.
- N6: a held folder handle without `FILE_SHARE_DELETE` blocks a rename of that folder by another process.
- N7: `FileRenameInfoEx` replace while another reader holds the target; the no-replace form on an existing name.
- N8: `SHOpenFolderAndSelectItems` on a folder selects it in its parent.

Unverified points (they stay unverified until their test runs):
- The `FOF_WANTNUKEWARNING` dialog together with `FOF_NOCONFIRMATION`, and the `hrDelete` value after No (N2).
- `SHCreateItemFromParsingName` and `DeleteItem` on a junction recycle the link, not the target (N3).
- `FileDispositionInfoEx` on a volume without POSIX delete support (N5, plan O-4).
- The `ls-files --directory` collapse rule of F10. The report used `--directory` only for display.
- Long shadow paths with `core.longpaths` false (F15, report "Not verified").
- The `./` stdin prefix on Windows (F13; NTFS cannot hold `:`).
- `core.ignorecase` and `core.excludesFile` as the only matching keys. The self-check guards it (report).
- A global `core.attributesFile` that changes the `checkout-index` bytes. The OID check catches it (report).
- `hash-object` on a linked `info/exclude` follows the link (report).
- The submodule recent entry: the code stores it for `openWorktree` (R10). `openSubmodule` needs the same `registered_root` change, and P0 checks it in the package.
- The shadcn `hover-card` item in the `base-mira` registry of `shadcn@4.21.0` (R14).
- The `diff -U0` index load: settled by source (R12). F4 confirms it with a canary.

## R17 Results

The results of F1 to F18 and N1 to N8 go here when WP3, WP4, and WP5 run them.
