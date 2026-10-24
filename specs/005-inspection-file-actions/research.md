# Research: History Inspection and Commit View File Actions

## R1 Sources and fact marks

- Git documentation: git-diff-tree(1), diff-format(5), git-diff(1) `--numstat`, git-ls-files(1) `--directory`, git-ls-tree(1), git-cat-file(1), git-check-ignore(1), gitignore(5), git-blame(1) "THE PORCELAIN FORMAT" and "INCREMENTAL OUTPUT", config/blame.adoc, git-config(1), git-rev-parse(1), git-for-each-ref(1).
- Git source: the Git 2.56 tree at `scratchpad\gitrepo` (commit a018953), read on 2026-10-21. The Git 2.55 sources and docs at `scratchpad\f005-plan\git255`. Line numbers below are Git 2.56 unless marked.
- The ignore preview report of 2026-10-21 (`scratchpad\ignore-preview\report.md`), with its fixture scripts in `scratchpad\ignore-preview\fx\`. It ran on Git 2.56 Windows and Git 2.55 WSL.
- The feature design of 2026-10-21 (`scratchpad\f005\design.md`), with probes on Git 2.56.0.windows.2 fixtures under `scratchpad\f005-plan\fx1`.
- The plan review probe of 2026-10-21 on Git 2.56.0.windows.2: a hand-made repository without commits under `scratchpad\f005-review\fx1`, read with `ls-files` only (R8, F10, F19).
- The fact probes of 2026-10-21 (`scratchpad\f005\facts.md`, scripts and outputs in `scratchpad\f005-facts\`) on Git 2.56.0.windows.2 and WSL Git 2.55.0: F7, F10, F13, F19, and the `.gitignore` name case (R8, R11, R16, R17).
- Microsoft Learn: `IFileOperation`, `IFileOperation::SetOperationFlags`, `IFileOperationProgressSink::PreDeleteItem` and `PostDeleteItem`, `FILE_DISPOSITION_INFO_EX`, `FILE_RENAME_INFO` (`FileRenameInfoEx`), `NtCreateFile`, `SHOpenFolderAndSelectItems`.
- Repository code at main a42f4a4, read through CodeGraph and by line: `src/git-service/{comparison,commands,diff-parser,history-view,history-topology,history-layout,ignore,session,registration,refs-parser,submodule-review}.ts`, `src/contracts/{limits,channel,envelope,ignore-line,submodules}.ts`, `src/frontend/{changes/file-tree.ts,changes/ChangesPane.tsx,changes/PatchView.tsx,refs/ReferencesSidebar.tsx,branches/BranchButton.tsx,history/CommitDetails.tsx}`, `src-tauri/src/{service,settings,process_requests,file_append,wsl}.rs`, `src/contracts/wsl-process.json`.
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
  - `PreDeleteItem` gets `psiItem`, "the item to be deleted" (doc). So the check reads its `SIGDN_FILESYSPATH` path, opens it as a Win32 path without following a link, and compares `FILE_ID_INFORMATION` with the checked handle. `SIGDN_FILESYSPATH` fails for an item without a file system path (doc, `SIGDN`). A failure cancels too.
  - The Shell does not support names that end in a space or a period (doc, "Naming Files, Paths, and Namespaces"). Win32 normalization removes such an end, and only `\\?\` skips it (doc, ".NET file path formats"). So the parse of an untracked `a.` can name a tracked `a`, and the compare cancels it (N9). The same compare catches a `.{CLSID}` folder name that moves the parse into a namespace folder.
  - A folder that the walk holds without `FILE_SHARE_DELETE` blocks a second `DELETE` open of it. So the folder step deletes each candidate through its own held handle, deepest first. A POSIX disposition removes the name when that handle closes (doc, `FILE_DISPOSITION_INFORMATION_EX`).
  - Another program that holds a file without delete sharing makes the target open fail with `STATUS_SHARING_VIOLATION`. The code name is `sharing-violation` (code, `file_facts.rs:581`).
  - `FOF_WANTNUKEWARNING` "sends a warning if a file is being destroyed during a delete operation rather than recycled", and it "partially overrides `FOF_NOCONFIRMATION`" (doc). The exact dialog and the `hrDelete` value after No are unverified (N2).
  - `FOFX_EARLYFAILURE` cancels the rest after one failure (doc). The plan leaves it out (plan O-7).
- The Recycle Bin call takes a path (`SHCreateItemFromParsingName`), so a swap of the last component after `PreDeleteItem` reaches the swapped item. Another program can also empty a held folder on the path and make it a junction. `FSCTL_SET_REPARSE_POINT` needs only `FILE_WRITE_DATA` or `FILE_WRITE_ATTRIBUTES` and an empty folder (doc, MS-FSA 2.1.5.10.37), and share modes do not control attribute access. The spec states both limits (FR-031).
- Long paths: the review refuses plain Delete for a path of 260 or more UTF-16 units (`MAX_PATH`) with `long-path`. Delete permanently uses the relative NT walk, which has no such limit. The Shell result for such a path is unverified (N10).
- Alternatives considered: `SHFileOperationW` (no per-item result; design R4); `DeleteFileW` (follows nothing at the last component, but opens by path again after the check); moving files into an own trash folder (no Windows Recycle Bin, so "just like in Windows" fails).

## R6 Delete in WSL

- Decision: a new `wslFiles` mode `delete` with `lstat`, the bound compare, `unlink`, and `rmdir` (plan D7).
- Rationale: the WSL route already runs every file write inside the distro through `wslFiles` (code, `wsl.rs:1549-1587` mode `append`). The name `remove` is taken: it removes an owned lock or candidate in the Git directory (code, `wsl-process.json` `remove`). A WSL distro has no Recycle Bin, so plain Delete opens the permanent confirmation (spec Clarifications).
- Walk: per folder, `lstat`, `chdir`, and `stat(".")` with the `lstat` device and inode. The working folder is then that folder, so a link swapped into the path later cannot move it. `unlink`, `rmdir`, and `rename` name the last component only. Perl core has these calls (`perlfunc`; `Fcntl` `O_NOFOLLOW`).
- Limit: POSIX has no unlink by identity, so a swap of the last name between its check and the act stays open (spec FR-031).
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
  - `check-ignore --no-index` loads no index (source, check-ignore.c:187), so the shadow checks read no shadow index entry as "seen".
  - `git init --template=` creates no `info/exclude` (report, verified). `checkout-index` needs `core.autocrlf=false` and `core.eol=lf` on Windows (report step 4).
  - Gitlinks, nested repositories, and folder inputs need an empty folder in the shadow (report E1). A skip-worktree `.gitignore` needs its index blob (report E5; dir.c `read_skip_worktree_file_from_index`).
  - A stdin path that starts with `:` is read as pathspec magic, and `--literal-pathspecs` exits 128. A `./` prefix reads it literally (report, verified on WSL; unverified on Windows, where NTFS cannot hold `:`).
  - The shadow gets the real `core.ignorecase` and `core.excludesFile` with `-c`, because `git init` writes its own `core.ignorecase` (report).
- Universe: `ls-files -o -z --directory --no-empty-directory` prints a folder without tracked entries as one record (doc, git-ls-files(1) `--directory`; experiment F10). An expansion `ls-files -o -z -- <d>/` lists every untracked file below it. For a nested repository the expansion prints the one record `<d>/` (source, dir.c:2045; probed 2026-10-21), not zero records.
- Self-check: the S shadow and Git's index-aware listings must give equal verdicts on every input before any preview shows (spec FR-039). This guards against config keys that the report did not test. The listings are `ls-files -o -i --exclude-standard --directory -z` (RI) and `ls-files -c -i --exclude-standard -z` (RT). They load the index, so they wait behind the read gate that the preview passes anyway.
  - Why not the real `check-ignore --no-index`: with `--no-index`, Git skips the index fallback for a skip-worktree `.gitignore` that is absent on disk (source, check-ignore.c:187, dir.c:1174-1178). The S shadow holds that blob, so every path below that file differed, and the preview always showed `self-check` (plan review finding 5).
  - Why not `check-ignore` with the index: each stdin path runs `check_ignore` once (source, check-ignore.c:146), and each run walks the whole index for "seen" (:105, pathspec.c:50-56), so 100,000 paths times 100,000 entries is too slow.
  - Why not RI without `--directory`: Git then recurses into every untracked folder (source, dir.c:2074) and lists each file below an ignored folder, such as `node_modules`. That exceeds the listing bound and gives no verdict for a collapsed folder input.
  - Record forms of RI (source and probe of 2026-10-21; F19): an excluded folder gives one record `<d>/` without recursion (dir.c:2094-2096). A folder that is not excluded but holds only ignored paths gives `<d>/` beside its records (dir.c:2163-2188, :2661-2663). An empty excluded folder gives `<d>/`. An ignored nested repository gives `<x>/` only when the repository itself is excluded and its parent is not (dir.c:2041-2046). Inside an excluded folder, the folder record covers the repository (dir.c:2088-2096; probed, F10). RI takes no pathspec, because a pathspec below an excluded folder can exit 128 (builtin/ls-files.c:154-155; probed, F10). `-i` uses no untracked cache (dir.c:3011-3014). So a folder input is ignored when RI holds `<d>/` and no record below it (plan D9).
  - Cost: two listings of about one `ls-files -o -z` each (0.68 to 0.73 s at 100,000 files on Windows, report) in place of one more `check-ignore` run (4.1 to 5.0 s).
- Name case: Git opens `<folder>/.gitignore` by that exact name (source, dir.c `prep_exclude`, wrapper.c:828 `open_nofollow`). On a case-insensitive folder the open can find another listed name, such as `.GITIGNORE`. On Windows NTFS, Git reads `.GITIGNORE` and reports its rules as `.gitignore`. In WSL ext4 the open does not find it (probed). A name compare cannot know the case rule of each volume. So one `fileFacts` entry per folder opens the exact name with the case rule of the volume (code, `file_facts.rs:502` `OBJ_CASE_INSENSITIVE`), and a found file gives `name-case` (plan D9).
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
  - `blame.ignoreRevsFile` repeats in every configuration scope, and blame uses every non-empty value (source, builtin/blame.c:764-772, :941-947; probed, F7). An empty configuration value resets nothing. The doc says it does (config/blame.adoc:24-28), but the source and F7 decide. Git reads every listed file in `build_ignorelist` before an empty command-line value clears the list, so a missing file exits 128 in both toggle states (probed; source).
  - The value passes through `git_config_pathname`, which expands `~/` and `%(prefix)/` and drops a missing `:(optional)` value (source, config.c:1320-1336). `config get --all --type=path -z` calls the same function (source, builtin/config.c:350, :527-533). So the service reads the values through it and classifies no prefix (plan review finding 12).
  - The blame handler stores the values with `string_list_insert` (source, builtin/blame.c:771), which keeps them sorted and without duplicates. An empty value then sorts first and clears nothing in `build_ignorelist` (source, :941-947). The doc says an empty value resets the list (config/blame.adoc:24-28). Git's own test covers only the empty command-line value (t/t8013-blame-ignore-revs.sh:119-128). F7 decided it on 2026-10-21 on both Gits: `-c a`, `-c ""`, `-c b` uses a and b, and a local a stays after `-c ""`. `--ignore-revs-file` is a string list option (:997) that appends after the configuration values, so there an empty value clears the list. A missing file exits 128 in every case (oidset.c:81-83). `config get --all --type=path -z` prints an empty value as an empty record, so the parser accepts empty records. The user decided on 2026-10-21 that blame follows Git exactly (plan O-9, spec FR-059).
  - `blame.showRoot` changes the `boundary` header (source, builtin/blame.c:742). So the shallow state comes from the shallow file, not from `boundary`.
  - A last line without LF counts as a line (source, blame.c `find_line_starts`).
  - `ls-tree -l` gives the mode, the type, and the size in one record without the index (doc, git-ls-tree(1) `--long`). A gitlink has type `commit`.
  - The binary fact comes from `git diff --numstat` of the empty tree and the commit for that path (spec FR-061). `git diff` of two trees loads no index (R13). `diff-tree` would load it.
- Alternatives considered: `--line-porcelain` (repeats all headers per line, larger output); two runs, incremental then porcelain (twice the time, clarify Q3); dropping the marks (loses FR-059); `-c blame.ignoreRevsFile=` (does not prevent the exit 128, design).

## R12 Blame before this commit

- Decision: `diff -U0 --inter-hunk-context=0 --no-textconv --no-ext-diff --no-color <old blob> <new blob>` and the hunk-header map of spec FR-056 (plan D12). `--inter-hunk-context` defaults to `diff.interHunkContext` (doc, diff-options), and a user value merges hunks and moves the mapped line.
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

- Decision: `upstreamPresent` from the 003 track state of the paired tracking entry of the same read, and the gone rule `upstream !== null && upstreamPresent === false` (plan D13). Without a paired entry, `upstreamPresent` is null and no mark shows (WP2 review, 2026-10-22).
- Rationale: `%(upstream)` prints the mapped ref also when that ref is missing (design R9). The branch listing holds only `refs/heads` and `refs/remotes`, so a listing compare marks `branch.b.merge=refs/tags/v1` with remote `.` as gone, although Git resolves it (probed, Git 2.56.0, WP2 review). A missing remote gives no fetch refspec, so `branch_get_upstream` returns NULL and `%(upstream)` is empty (source, remote.c:1796-1801, :1908; clarify F2). The 003 `%(upstream:track,nobracket)` `gone` agrees, and `for-each-ref` prints it untranslated (source, ref-filter.c:50, design R9).
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
- F7: a missing relative `blame.ignoreRevsFile` exits 128 with and without `--ignore-revs-file=`; an empty configuration value after a non-empty value resets nothing (O-9, probed 2026-10-21); `--ignore-revs-file=` clears; a `~/` value and a missing `:(optional)` value through `config get --all --type=path -z`.
- F8: the attribution equals `git blame --porcelain` with `-w`, `-M`, and `-C` on every fixture line.
- F9: the `diff -U0 --inter-hunk-context=0` hunk headers of two blobs and the FR-056 map on the fixtures, also with `diff.interHunkContext=3` in the configuration.
- F10: `ls-files -o -z --directory --no-empty-directory` prints each folder without tracked entries as one record, and a nested repository as `x/`; the expansion lists every untracked file below the folder; a nested repository expands to the one record `x/` (probed 2026-10-21 on Git 2.56.0.windows.2). RI gives `<x>/` only for an excluded repository whose parent is not excluded, and RI with a pathspec below an excluded folder exits 128 (probed 2026-10-21 on both Gits).
- F11: the S shadow equals the verdicts from the self-check listings RI and RT for the report cases C0 to C8 and W1, with folder inputs, gitlinks, and a skip-worktree `.gitignore` absent on disk; the C shadow preview equals the change of `ls-files -o -i --exclude-standard -z` and `ls-files -c -i --exclude-standard -z` after a real save on a copy.
- F12: the folder collapse equals the per-file check for every fixture.
- F13: the `./` stdin prefix for a path that starts with `:`, and the form of the echoed pathname field. Settled on 2026-10-21: a `./` path is literal on Windows and in WSL, and Git echoes the input unchanged. On Windows `\` is also a separator (compat/win32/path-utils.h:9), so the service sends only `/`. The test repeats it on both Gits.
- F14: `hash-object --stdin-paths` with C-quoted lines in the shadow context; the `checkout-index` byte check; the `info/exclude` placement through the second index.
- F15: on Windows, with `core.longpaths` false in the user configuration, `-c core.longpaths=true` lets the shadow `hash-object --stdin-paths`, `checkout-index`, and `check-ignore` handle a shadow path of 260 or more UTF-16 units. Result (R17): false for a global or system value; the shadow therefore reads neither file.
- F16: open submodule facts: the `ls-files --stage` gitlink record; the discovery of an uninitialized folder resolves to the parent; a `.git` file with a missing Git directory fails the discovery.
- F17: `%(upstream)` for a pruned upstream (name present, ref missing) and for a removed remote (empty).
- F18: `rev-parse --path-format=absolute --git-path info/exclude` in a linked worktree (004 F23 again).
- F19: the RI record forms of `ls-files -o -i --exclude-standard --directory -z`: an excluded folder as one record, a folder of only ignored paths as `<d>/` beside its records, an empty excluded folder, an ignored nested repository as `<x>/`, a folder that a nested `.gitignore` excludes. The probe of 2026-10-21 on Git 2.56.0.windows.2 showed each form; the test repeats it with tracked and skip-worktree entries on both Gits. Also the `name-case` open of `.gitignore` in a folder that holds only `.GITIGNORE` (`name-case` on Windows, no rules in WSL) or only `.gıtignore` (no rules on both routes). Settled on 2026-10-21: RI and RT read a skip-worktree `.gitignore` that is absent on disk from its index blob, and the shadow verdicts equal them (dir.c:1000-1015, :1174-1178). D9 needs no change.
- N1: `IFileOperation` recycle of a file gives S_OK with a non-null `psiNewlyCreated`, and the item is in the Recycle Bin. The test purges it.
- N2: on a volume without a Recycle Bin, `FOF_WANTNUKEWARNING` with `FOF_NOCONFIRMATION` shows the Windows warning; No keeps the file and gives the recorded `hrDelete`; Yes deletes it with a null `psiNewlyCreated`.
- N3: a symbolic link to a folder and a junction go to the Recycle Bin as links, and the targets stay.
- N3b: on a volume without a Recycle Bin, plain Delete of a junction and of a folder symbolic link, answered with Yes in the Windows warning: each link goes, and each target folder and its files stay.
- N4: a `PreDeleteItem` failure cancels the later items, and they reply `stopped`.
- N5: `FileDispositionInfoEx` with POSIX semantics on a file, a file link, a folder link, and a junction; a read-only file gives `STATUS_CANNOT_DELETE`; the result on a volume without POSIX delete.
- N6: a held folder handle without `FILE_SHARE_DELETE` blocks a rename of that folder by another process.
- N7: `FileRenameInfoEx` replace while another reader holds the target; the no-replace form on an existing name.
- N8: `SHOpenFolderAndSelectItems` on a folder selects it in its parent.
- N9: an untracked `a.` and an untracked `a ` (made through `\\?\`) beside a clean tracked `a`. Plain Delete of each: `PreDeleteItem` finds another file ID and cancels, the item replies `stopped`, and `a` stays. The test records the `SIGDN_FILESYSPATH` value of each item.
- N10: plain Delete of a file whose full path holds 260 or more UTF-16 units, through `SHCreateItemFromParsingName` and `DeleteItem` in a test harness. The test records the HRESULTs. The review rule `long-path` stays until this fact shows a recycle with the right `PostDeleteItem` result.
- N11: the Shell move of a file while the shell holds the checked target handle (share READ|WRITE|DELETE). The move succeeds, or the test records the sharing conflict and the `hrDelete`.

Unverified points (they stay unverified until their test runs):
- The `FOF_WANTNUKEWARNING` dialog together with `FOF_NOCONFIRMATION`, and the `hrDelete` value after No (N2).
- `SHCreateItemFromParsingName` and `DeleteItem` on a junction recycle the link, not the target (N3). The Shell permanent delete of a link after the warning keeps the target (N3b).
- The Shell parse of names that end in a dot or a space (N9), of long paths (N10), and the Shell move beside the held target handle (N11).
- `FileDispositionInfoEx` on a volume without POSIX delete support (N5, plan O-4).
- The `ls-files --directory` collapse rule of F10. The report used `--directory` only for display. The probe of 2026-10-21 covered only a repository without tracked entries.
- `-c core.longpaths=true` for long shadow paths (F15, report "Not verified").
- `core.ignorecase` and `core.excludesFile` as the only matching keys. The self-check guards it (report).
- A global `core.attributesFile` that changes the `checkout-index` bytes. The OID check catches it (report).
- `hash-object` on a linked `info/exclude` follows the link (report).
- The submodule recent entry: the code stores it for `openWorktree` (R10). `openSubmodule` needs the same `registered_root` change, and P0 checks it in the package.
- The shadcn `hover-card` item in the `base-mira` registry of `shadcn@4.21.0` (R14).
- The `diff -U0` index load: settled by source (R12). F4 confirms it with a canary.

## R17 Results

The results of F1 to F19, N1 to N11, and N3b go here when WP3, WP4, and WP5 run them.

The fact probes of 2026-10-21 ran before the tests, on Git 2.56.0.windows.2 and WSL Git 2.55.0:
- F7: blame uses every non-empty `blame.ignoreRevsFile` value from every scope. An empty configuration value resets nothing. `--ignore-revs-file=` clears the list. A missing file exits 128. O-9 is decided: blame follows Git (user, 2026-10-21).
- F10: an ignored nested repository gives an RI record `<x>/` only when x is excluded and its parent is not. Inside an excluded folder, only the folder record shows. RI with a pathspec below an excluded folder exits 128.
- F13: a `./` stdin path is literal on both routes. On Windows `.\sub\x` also matches `sub/x`.
- F19: RI and RT read a skip-worktree `.gitignore` from its index blob, and the S shadow verdicts equal them. Windows NTFS opens `.GITIGNORE` for `.gitignore`, and Git reports the rules as `.gitignore`. NTFS does not open `.gıtignore` for `.gitignore`. WSL ext4 opens neither.
- Not checked: the Git 2.55 blame source. Only the experiment covers Git 2.55.

**Batch 0 verification (T005), 2026-10-22.** Run in `C:\Projects\arbareto-l2` on f005-impl at 59feb9f, with `ARBARETO_WSL_DISTRO=Ubuntu-26.04`.
- `bun install --frozen-lockfile`, `bun run build`, `cargo check --locked`, `bun run build:service`, `bun run typecheck`, and `bun run export:schemas --check`: exit 0.
- `bun run test:contracts`: exit 0, 5,048 pass, 33 skip, 0 fail, 5,081 tests in 103 files.
- `ARBARETO_TEST_WORKERS=6 bun run test:all`: exit 0, 126 min. Parallel group: 6,862 pass, 40 skip, 0 fail, 6,902 tests in 196 files. Serial group: 602 pass, 10 skip, 0 fail, 612 tests in 31 files.
- `cargo test --locked` in `src-tauri`: exit 0, 555 passed, 0 failed, 4 ignored.
- Every `ORIGIN` line is under `C:\Projects\arbareto-l2`: 300 in the contract run, 1,904 in the full run. All 87 `GIT_CORE` lines name one Git.
- Skips: no new skip against run 7. The 14 H200K skips of run 7 are gone, because those cases ran.
- Facts: batch 0 has no fact test, so no 005 test printed an `OBSERVATION` line.
- Control mutation: without the raw-byte compare in `compareNames`, `tests/contracts/tree-order.test.ts` failed (9 pass, 5 fail), with the totality case. After the undo, the file had its original SHA-256, and 14 of 14 passed.

**Batch 0 review, 2026-10-22.** Independent batch 0 review, reviewer agent, on 26f8de4. Skills: `ponytail-review`, and a manual correctness, security, heuristics, constitution, and contract review. Verdict: no crash, no security hole, and no heuristic. Resolution: 59feb9f fixes all items.
- Medium: the five new `bridge.ts` target methods had no `Exact` guard. The fix adds the guard and five `@ts-expect-error` cases.
- Medium: the schema export dropped `const`, so `Shadow.op` is now `z.enum(["create"])`. `DeleteExpected.kind` stays a serde tag, and the new vector `process-file-delete-link-as-file.json` checks it.
- Medium: `comparePaths` split both paths for each compare (1,845 ms for 100,000 paths). `treeKey` and `compareKeys` build each key once (241 to 273 ms).
- Low: T013 now names the Windows `fileFacts` `content` refusal. The 001 contract §5 has an amendment line for the 2 MiB bound. Plan D3 names `COMMIT_CHANGES_RESULT_BYTES`, and data-model §8 follows the Δ3 NUL rule.
- Gap: the `ignorePreview` run context had no fields. It now has `contextKind`, `gitInstallationId`, `shadowId`, `shadowRepository`, and `shadowIndex`, with one valid and two invalid vectors. The service and the shell refuse it until T041 and T015.

WP2 (2026-10-22):
- R16 open point closed: the `base-mira` registry of `shadcn@4.21.0` has `hover-card`. `bunx --bun shadcn@4.21.0 add hover-card` created `src/frontend/components/ui/hover-card.tsx` on `@base-ui/react` PreviewCard (Base UI 1.8.0). It added no dependency.

WP3 shell facts of 2026-10-22 (cargo tests in `file_delete.rs` and `file_replace.rs`, Windows 11 build 26300):
- N6: a held folder handle blocks a rename only with `FILE_LIST_DIRECTORY` in its access. NT records the share mode only for an open with read, write, or delete access (`IoSetShareAccess`).
- N7: the Win32 `SetFileInformationByHandle(FileRenameInfoEx)` refuses a relative name with a `RootDirectory` (`0x80070057`). `NtSetInformationFile(FileRenameInformationEx)` resolves the name below the parent handle. A collision gives `STATUS_OBJECT_NAME_COLLISION`.
- D10: the reparse tag query needs `FILE_READ_ATTRIBUTES` on the target handle.
- N1 and N11: the Shell moves each checked file to the Recycle Bin while the checked handle stays open. `recycledPath` is a file system path below `<drive>\$Recycle.Bin\<SID>\`, and the `$I` item lies beside the `$R` item.
- N3: a junction goes to the Recycle Bin as a link, and its target stays.
- N4: a `PreDeleteItem` cancel makes `PerformOperations` fail. The cancelled item still gets `PostDeleteItem` with `0x800704C7` (`ERROR_CANCELLED`), so it replies `kept`. Each later item gets no call and replies `stopped`. An item that moved before the cancel keeps its `recycled` result.
- N9: an untracked `x.` or `x ` beside a tracked `x` replies `kept` with `0x800704C7`. Both files stay. The request path rule refuses such a name, so only the cargo test reaches this step.
- Shadow `GIT_DIR` (Git 2.56.0.windows.2 source, `builtin/init-db.c` `guess_repository_type`): with `GIT_DIR` set, `git init` makes a bare repository unless `GIT_DIR` is exactly `.git` or ends in `/.git`. A `<cwd>\.git` value gave `core.bare=true`, and `checkout-index` failed. `GIT_DIR=.git` gives `core.bare=false` and no `core.worktree` (cargo test, and the real-WSL test on Ubuntu-26.04).
- F15 (Git 2.56.0.windows.2 source and probe): `are_long_paths_enabled` (`compat/mingw.c:285`) caches the first `core.longpaths` value that it finds. `repo_read_config` (`config.c:2313`) marks the config set ready, then reads system, global, the repository file, and the command line in that order. A long-path check while it reads sees only the system and global values. So a global `core.longpaths=false` wins over `-c core.longpaths=true` and over `GIT_CONFIG_COUNT`, although `git config` reports `true`. A system-scope value acts the same way. Closed: on Windows the shadow sets `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` to one empty file in the shadow folder (contract Δ6). The cargo fact tests with an owned global and an owned system `core.longpaths=false` check out a path of 260 or more UTF-16 units (exit 128 before, 0 after).
- Dependency: `windows-core` `0.62.2` is a direct dependency, because the `#[implement]` macro of the `IFileOperationProgressSink` sink names that crate. It is the version that `windows` `0.62.2` already uses.
- Crate features: WP3 added no `windows` crate feature. The installed list already holds `Win32_UI_Shell`, `Win32_System_Com`, and `Wdk_Storage_FileSystem`.

**Batch 1 verification (T027) part A, 2026-10-22.** Run 2 in `C:\Projects\arbareto-l2` on f005-impl at ccc56c2, with `ARBARETO_WSL_DISTRO=Ubuntu-26.04`.
- `bun install --frozen-lockfile`, `bun run build`, `bun run typecheck`, `bun run export:schemas --check`, `cargo check --locked`, and `bun run build:service`: exit 0.
- `cargo test --locked`: exit 0, 591 passed, 0 failed, 9 ignored.
- `ARBARETO_TEST_WORKERS=6 bun run test:all`: exit 0, 124 min. Parallel group: 6,997 pass, 40 skip, 0 fail, 7,037 tests in 201 files. Serial group: 660 pass, 10 skip, 0 fail, 670 tests in 34 files.
- Every `ORIGIN` line is under `C:\Projects\arbareto-l2`: 1,921 in the full run. All 88 `GIT_CORE` lines name one Git.
- Skips: 40 and 10, the same counts as batch 0.
- Kernel pool from 12:11 to 14:17: paged 2,819 to 4,650 MiB, nonpaged 1,402 to 1,856 MiB. During `test:all`, the lowest free memory was 15,791 MB, and the Bun processes of the run peaked at 4,197 MB private.
- Control mutations, each red, then undone with the original SHA-256 and green: (1) status `C` accepted in `commit-changes.ts`: `tests/contracts/diff-parser.test.ts` failed. (2) `--no-textconv` dropped in `blame.ts`: the textconv canary case of `tests/git/blame.test.ts` failed. (3) `FILE_NON_DIRECTORY_FILE` on the target open in `file_delete.rs`: `a_folder_link_deletes_the_link_and_keeps_the_target` failed.
- Run 1 at fef5c75 stopped at `cargo test` on one real-WSL test, `the_real_destination_mode_reads_the_entry_then_one_child`. An investigator proved the code path unchanged since batch 0, and the test passed 5 of 5 times alone. Commit ccc56c2 makes two real-WSL asserts print the deadline flag, the exit code, and stdout, so a next failure shows its cause.
- Still open: `bun run test:windows` (with T012) and the board comparison. Both wait for the user's open 001 T149 step, because `test:windows` tests the installed package and the board comparison starts the app.
- T014 waits for the Recycle Bin cases (the ignored cargo tests and T012) in the T027 part B run.

T018 facts, on Git 2.56.0.windows.2. T012 printed no line yet (it is a `tests/windows` file):
- `OBSERVATION T018: Git version git version 2.56.0.windows.2 equals git version 2.56.0.windows.2: holds (git version 2.56.0.windows.2)`
- `OBSERVATION T018: F1 raw grammar A D M R092 T, gitlink and link records, empty-tree roots in SHA-1 and SHA-256, and an empty diff-tree <merge>: holds (git version 2.56.0.windows.2)`
- `OBSERVATION T018: F2 -l1000 gives 1,001 D and 1,001 A records, diff.renameLimit=5000 changes nothing, and -l2000 pairs all 1,001: holds (git version 2.56.0.windows.2)`
- `OBSERVATION T018: F3 the rename patch header order of diff.c fill_metainfo, its parse, and a type change as two sections with one numstat record: holds (git version 2.56.0.windows.2)`
- `OBSERVATION T018: F4 canary runs {"diff-tree":true,"ls-files":true} and stays absent {"diff trees":false,"diff blobs":false,"ls-tree":false,"cat-file":false,"blame":false,"check-ignore":false,"config":false}: holds (git version 2.56.0.windows.2)`
- `OBSERVATION T018: F5 ls-tree blob, link, and gitlink records [["100644","blob","fbbee861521bd5355538b096fa3998541cd33909","     ","11","a.txt"],["120000","blob","8d14cbf983b3fad683171c9418998d9f68340823","      ","5","lnk"],["160000","commit","1111111111111111111111111111111111111111","      ","-","lib"]] with a %7s size field, and a missing tree exit 128: holds (git version 2.56.0.windows.2)`
- `OBSERVATION T018: F6 incremental and porcelain headers, marks only in porcelain with the -c keys, and a last line without LF counted: holds (git version 2.56.0.windows.2)`
- `OBSERVATION T018: F7 missing file exits 128/128/128, an empty value keeps 1 of 1 marks, --ignore-revs-file= leaves 0, config get lists ".revs\u0000\u0000C:/Users/user/AppData/Local/Temp/arbareto-fixtures-4a9972a4-1a20-4011-b156-d1f6982768aa/home/home.revs\u0000.revs\u0000": holds (git version 2.56.0.windows.2)`
- `OBSERVATION T018: F8 incremental equals porcelain tale.txt:true other.txt:true nolf.txt:true story.txt:true tale.txt-w:true other.txt-w:true nolf.txt-w:true story.txt-w:true tale.txt-M:true other.txt-M:true nolf.txt-M:true story.txt-M:true tale.txt-C:true other.txt-C:true nolf.txt-C:true story.txt-C:true tale.txt-w-M-C:true other.txt-w-M-C:true nolf.txt-w-M-C:true story.txt-w-M-C:true: holds (git version 2.56.0.windows.2)`
- `OBSERVATION T018: F9 3 hunks same=true mapped=true; 1 hunks same=true mapped=true; 2 hunks same=true mapped=true; 1 hunks same=true mapped=true; diff.interHunkContext=3 merges hunks without the option: true: holds (git version 2.56.0.windows.2)`
- `OBSERVATION T018: F17 pruned upstream "refs/remotes/origin/gone" missing, removed remote "": holds (git version 2.56.0.windows.2)`
- Every fact holds, so contracts/operations.md and plan.md need no change.

**Batch 1 reviews, 2026-10-22.** Three independent reviewer agents, one per work package. Skills: `ponytail-review` and a manual correctness, security, heuristics, constitution, and contract review; `web-design-guidelines` and `arbareto-ux` for WP2. Control mutations of the fixes turned their cases red: one in WP2, four in WP3, and two in WP4.

WP2 (T006 to T011), review of acda0e9, fixes in a26a57f. No heuristic. Tree order, key cost, and the card accessibility were correct.
- High: the gone mark came from the `readBranches` listing, so the upstream `refs/tags/v1` with remote `.` showed "gone". Fix: `upstreamPresent` from the 003 track state `gone` of the paired tracking entry, null without a pair, with a new T006 case.
- Medium: the branch list hid the 003 note "Upstream gone" (contract Δ14). Fix: the note stays beside the mark.
- Medium: `Workbench.tsx` did not pass `branches` to the sidebar, so "Checked out in" never showed (FR-066). Fix: the prop and a Workbench test.
- Medium: ref names that are not valid UTF-8 sorted by lossy text. Fix: `RefEntry.nameBytes` and the raw byte sort.
- Low: Escape in the branch list also closed the list. Fix: `onEscape` on `SwitcherList`.
- Low: a native `title` repeated the card. Fix: the title is gone.

WP3 (T012 to T015), review of 709d32c, fixes in 820ea90. No path deletes outside the root, follows a link, or removes an unlisted file.
- High: a cancelled Recycle Bin batch dropped the sink results, so recycled items replied `kept`. Fix: the shell always takes the outcomes after `Unadvise`, and a panic gives `error other-error`.
- High: a WSL delete or replace that stopped after some unlinks replied that nothing changed. Fix: the reply `interrupted`.
- High: a digest request with a huge size could abort the shell. Fix: `digest` above 1 MiB refuses.
- High: the shadow allowlist admitted `checkout-index` without `core.autocrlf=false`, `core.eol=lf`, and on Windows `core.longpaths`. Fix: only the exact Δ6 arrays pass.
- Medium: the leftover sweep removed a live owner's folder when `OpenProcess` failed for another reason. Fix: only `ERROR_INVALID_PARAMETER` means that the owner is gone.
- Medium: shadow Git could use a `.git` above the shadow folder. Fix: `GIT_DIR=<cwd>/.git`.
- Medium: the WSL scratch sweep and remove did not filter by owner and followed links. Fix: the uid filter and the `walk_parent` no-follow walk.
- Medium: no test covered the Recycle Bin mode. Fix: ignored cargo tests for N1, N3, N4, N9, and N11, run on demand, that purge only their own items.
- Medium: the `stopped` reply was ambiguous. Fix: `stopped` for a whole Windows request without a change, `interrupted` for a WSL outcome that is not known.
- Low: unrelated folder trees refuse; the lock stays held during the shadow removal; a name lookup failure gives `error`; a replace that never started gives `stopped`.
- Text: contract Δ10 and plan D14 "Allowlist" state that the service builds the arrays (001 §6).
- Follow-ups: a broken WSL `replace` output gives `interrupted`; the shadow-create sweep removes leftovers outside the state lock.

WP4 (T016 to T026), review of ce6dfa0, fixes in 3d6c5e3. No heuristic, and no read runs a repository program in an untrusted repository.
- The "Blame before this commit" line never reached the renderer. Fix: `focusLine` in the result.
- The focus clamp gave 1 for an empty previous version. Fix: no `focusLine`.
- A binary or oversize previous version gave `MALFORMED_GIT_OUTPUT` or `OUTPUT_LIMIT`. Fix: the blame checks of (P, Q) run before the blob diff.
- A submodule row of `readCommitFile` skipped the read gate. Fix: the gate runs first.
- A sibling Git step could outlive its read. Fix: a `Promise.allSettled` helper.
- The diff driver canaries did not cover the diff of "Blame before this commit". Fix: `diff.<driver>.command` and `diff.external` canaries.
- A `readCommitChanges` that `BUSY` refused dropped the older listing. Fix: the drop happens only when the read runs.
- The patch bound counts dropped sections. Contract Δ3 records it as a known limit.
- Text: the data-model §11 zero-count hunk rule (xdiff `xdl_format_hunk_hdr`, F9), the plan D12 `ls-tree -l` size `%7s`, the reason `path` for paths that are not valid UTF-8, one `commits` entry per (oid, previous, filename) origin, and the Δ2 generation rule.

**Batch 2 and 3 verification (T047 and T058) part A, 2026-10-24.** Run 2 in `C:\Projects\arbareto-l2` on f005-impl at 66c19f3, with `ARBARETO_WSL_DISTRO=Ubuntu-26.04`. One run covers the commands of T047 and T058.
- `bun install --frozen-lockfile`, `bun run build`, `bun run typecheck`, and `bun run export:schemas --check`: exit 0.
- `cargo test --locked`: exit 0, 588 passed, 0 failed, 9 ignored.
- `bun run test:contracts`: exit 0, 5,409 pass, 33 skip, 0 fail, 5,442 tests in 114 files.
- `ARBARETO_TEST_WORKERS=6 bun run test:all`: exit 0, 136 min. Parallel group: 7,249 pass, 41 skip, 0 fail, 7,290 tests in 210 files. Serial group: 710 pass, 10 skip, 0 fail, 720 tests in 36 files.
- Every `ORIGIN` line is under `C:\Projects\arbareto-l2`: 335 in the contract run, 1,958 in the full run (229 on stdout, 1,729 on stderr). All 90 `GIT_CORE` lines of the full run name one Git.
- Skips: one new skip against batch 1, "T033 a FIFO .gitignore refuses with ignore-not-regular" (missing capability `fifo`).
- Kernel pool from 08:27 to 12:42: paged 2,802 to 4,977 MiB, nonpaged 1,438 to 1,991 MiB. During `test:all`, the lowest free memory was 12,827 MB, and the Bun processes of the run peaked at 4,883 MB private.
- Control mutations, each red, then undone with the original SHA-256 and a clean `git diff`, then green:
  - T047 (1): in `file-delete.ts`, `observe` memoizes `observeDelete` per request, so the check phase reuses the review facts. The US2-5 case of `tests/git/delete.test.ts` failed. Deviation: the task says "skip the check phase"; the mutation removes only its fresh fact read.
  - T047 (2): in `ignore-preview.ts`, `base.selfCheck = null`. The case "a changed RI or RT record gives self-check" of `tests/git/ignore-preview.test.ts` failed.
  - T047 (3): in `CommitChanges.tsx`, the `compareKeys` sort is gone, so the service order stays. Two cases of `tests/contracts/inspection-history.test.tsx` failed: the first file in tree order after a row selection, and "the rows follow comparePaths order". Deviation: the task names one case.
  - T058 (1): in `shortcuts.ts`, `deleteFiles` also gets the scope `fileList`. The case "Delete and Shift+Delete act only in the Changes list (FR-023)" of `tests/contracts/shortcuts-005.test.ts` failed (16 pass, 1 fail).
  - T058 (2): in `DeleteConfirm.tsx`, the first focus moves to the danger button. The case "Cancel with the first focus" of `tests/contracts/inspection-delete.test.tsx` failed.
  - T058 (3): in `IgnoreEditor.tsx`, Close discards the text first, so the discard modal does not open. The US5-7 case of `tests/contracts/inspection-ignore.test.tsx` failed. Deviation: the mutation discards the text in place of a skip of the modal call.
- Still open: the board comparisons of T047 and T058. They and the batch 2 and batch 3 review records complete T047 and T058. Both tasks stay unticked until then.

T030 facts, on Git 2.56.0.windows.2, from the full run above:
- `OBSERVATION T030: F10 ls-files -o --directory --no-empty-directory gives one record per folder without tracked entries, nested/ for a repository, and no emptyign/: ["Upper.LOG","build/out.o","deep/","ign/","keep.log","local","nested/","node_modules/","secret.txt","sub/deeper/","sub/local","sub/secret.txt","sub/y.log","swt/a.swt","swt/b.txt","untr/","x.log"] holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F10 the expansion of untr/ lists every untracked file below it holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F10 the expansion of deep/ lists every untracked file below it holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F10 the expansion of ign/ lists every untracked file below it holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F10 the expansion of node_modules/ lists every untracked file below it holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F10 the expansion of sub/deeper/ lists every untracked file below it holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F10 a nested repository expands to the one record nested/: ["nested/"] holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F10 RI gives nested/ for an excluded repository whose parent is not excluded, and ign/ alone covers ign/inner-repo: ["Upper.LOG","build/out.o","deep/","deep/tmp/","deep/tmp/sub/","deep/tmp/z","ign/","nested/","node_modules/","secret.txt","sub/local","sub/secret.txt","swt/a.swt","untr/a.bak","x.log"] holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F10 RI with the pathspec ign/inner-repo/ below the excluded ign/ exits 128 holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F11 the S shadow equals Git's ignored and tracked-matched listings: {"ignored":["Upper.LOG","build/out.o","deep/tmp/sub/w","deep/tmp/z","ign/inner.txt","ign/other.txt","node_modules/pkg/.gitignore","node_modules/pkg/index.js","secret.txt","sub/local","sub/secret.txt","swt/a.swt","untr/a.bak","x.log"],"trackedMatched":["build/keep.txt"]} holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F11 C0 unchanged root: the C shadow equals the real save holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F11 C1 root: drop folders, add *.txt and !a.txt: the C shadow equals the real save holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F11 C2 sub: anchored and negation: the C shadow equals the real save holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F11 C3 info/exclude: the C shadow equals the real save holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F11 C4 case: *.LOG, DEEP/, nested/: the C shadow equals the real save holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F11 C5 ignored folder with a negation inside, ** forms: the C shadow equals the real save holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F11 C6 sub: folder-only and leading **: the C shadow equals the real save holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F11 C7 empty root: the C shadow equals the real save holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F11 C8 CRLF, BOM, and trailing spaces: the C shadow equals the real save holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F11 E1 gitlink against mod/: the C shadow equals the real save holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F11 W1: the C shadow equals the real save holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F12 every file below the ignored folder ign/ is ignored holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F12 every file below the ignored folder node_modules/ is ignored holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F13 ./:x.log matches the pattern :x.log and Git echoes ./:x.log; the bare :x.log gives pattern "" holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F13 on Windows sub\y.log gives the verdict of sub/y.log: [{"source":"sub/.gitignore","pattern":"!*.log","path":"sub\\y.log"},{"source":"sub/.gitignore","pattern":"!*.log","path":"sub/y.log"}] holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F14 init with GIT_DIR <dir>/.git gives core.bare false holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F14 on Windows init with a GIT_DIR that ends in a backslash and .git gives core.bare true, so checkout-index finds no work tree holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F14 init --template= creates no info/exclude holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F14 a C-quoted --stdin-paths line gives the OID of the bytes holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F14 checkout-index writes equal bytes (true) and an empty folder for a gitlink (true) holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F14 checkout-index --prefix=.git/info/ of the entry exclude writes .git/info/exclude with equal bytes holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F15 at 357 units without a global core.longpaths: {"units":357,"info":0,"without":128,"checkout":0,"stderr":"","same":true,"matched":true} holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F15 at 363 units with a global core.longpaths=false: the global value wins over -c core.longpaths=true; the checkout exits 128 ("fatal: cannot create directory at 'nnnnn"), and git config names true holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F16 ls-files -z --stage -- solo gives one stage-0 gitlink record: ["160000 0159e6a3b1218140f459361bb9f9f37689703ba9 0\tsolo"] holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F16 the uninitialized folder bare resolves to the superproject top level holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F16 rev-parse in broken, whose .git file names a missing folder, exits 128 holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F18 the linked worktree gives "C:/Users/user/AppData/Local/Temp/arbareto-fixtures-a7cb5252-a7fb-46a8-bdf0-ae9200b1dfea/t030-f18/repo/.git/info/exclude\n" holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F19 RI records ["Upper.LOG","build/out.o","deep/","deep/tmp/","deep/tmp/sub/","deep/tmp/z","emptyign/","ign/","node_modules/","secret.txt","sub/deeper/","sub/local","sub/secret.txt","swt/a.swt","untr/a.bak","x.log"]; RT records ["build/keep.txt"] holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F19 an excluded folder is one record without records below it holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F19 a folder of only ignored paths gives deep/ beside deep/tmp/z holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F19 RI reads the skip-worktree swt/.gitignore from its index blob holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F19 RT holds build/keep.txt below the excluded /build/: true holds (git version 2.56.0.windows.2)`
- `OBSERVATION T030: F19 name case: up/a.txt source "up/.gitignore", dot/a.txt pattern "", ignored ["up/a.txt"] holds (git version 2.56.0.windows.2)`
- F15 global case: the global `core.longpaths=false` wins over `-c core.longpaths=true`. The checkout exits 128, and `git config` names `true`. This is the expected result. The shadow reads no global or system file, so the cargo F15 tests exit 0. Source: Git for Windows `compat/mingw.c` `are_long_paths_enabled()` caches the first system or global value.
- The full run printed the F15 global line with an old label and "DOES NOT HOLD" for the same values. The test pins this negative fact on purpose. The line above comes from the corrected label, in a run of `tests/git/file-actions-facts.test.ts` alone on 2026-10-24 (24 pass, 0 fail, both `ORIGIN` lines under `C:\Projects\arbareto-l2`).
- Every other fact holds, so contracts/operations.md and plan.md need no change.

**Batch 2 reviews, 2026-10-22.** Two independent reviewer agents, one per work package. Skills: `ponytail-review` and a manual correctness, security, and heuristics review; `web-design-guidelines` and `arbareto-ux` for WP6. Neither review ran the tests.

WP5 (T028 to T042), review of d4ca6a9 (diff fef5c75..d4ca6a9), fixes in b3887a0, with the shell fix d52ac3c and the test double fix 427c3fe. No path deletes an unreviewed file, a file in a submodule or a nested repository, a junction target, or a file outside the worktree.
- High: a Cancel after the shell removed files replied `canceled` without effects (001 data-model §7). Fix: the removed counts come before the cancel check, plan D6 follows, and a test cancels during the delete phase.
- High: a file that went absent during a request without a reply counted as no effect. Fix: a null, `stopped`, or `interrupted` reply with an absent fresh fact counts as an effect, so the state is `failed-with-effects` (plan D6 table).
- High (shell, outside WP5): every Windows shadow `checkout-index` exited 128, so each preview gave `shadow-copy`. The test double used `/` separators and hid the defect. Fix: d52ac3c sets `GIT_DIR=.git` (see "Shadow `GIT_DIR`" above). The review proposed `GIT_WORK_TREE=<cwd>`. 427c3fe makes the double copy the shell form exactly.
- Medium, heuristic: `DEADLINE` came from "not aborted". Fix: the code comes from the timeout signal or the walk stop; another end gives `GIT_FAILED`.
- Medium: `PREVIEW_PATHS` was checked per `check-ignore` call. Fix: one check per preview, on the inputs without the folder probes, before the first check.
- Medium: save refused a CR, but the preview accepted it. Fix: a CR gives `INVALID_REQUEST` for `previewIgnore` and `ignore-save`.
- Medium: Delete and Save had no `core.fsmonitor` canary in an untrusted repository. Fix: one canary test per action.
- Low: the submodule check compared lossy UTF-8 text. Fix: a byte compare.
- Low: every run-time refusal became `STALE_REVIEW` `files-changed`, also `OPERATION_IN_PROGRESS` and `UNKNOWN_TARGET`. Fix: only the fact refusal of the action gives it. Other refusals pass through.
- F15 answer: a global `core.longpaths=false` wins over `-c`, `GIT_CONFIG_COUNT`, and a local value. Fix: d52ac3c gives the Windows shadow an empty global and system configuration (contract Δ6).
- Lean: the two binary-search prefix helpers of `ignore-preview.ts` can be one function.

WP6 (T043 to T046), review of 205a70b (diff fef5c75..205a70b), fixes in f72b3b7, with the T065 source in fe3eaf0 (service) and d3945ba (renderer). No heuristic, injection, or data-loss issue.
- High: an option toggle after "Blame before this commit" gave `UNKNOWN_TARGET`, because the service keeps one blame result per workspace. Fix: the new source `{blameId}` (T065). A renderer-only replay is not exact, because `-w`, `-M`, and `-C` can change the owner commit of a line.
- High: Enter or a click on a blame line did nothing when History had not loaded that commit (FR-056). Fix: the store loads the commit by its ID, then selects it.
- Medium: the History diff ended the shared Pierre worker pool at each blame open and dock change. Fix: one `PatchPool` for the session in `Workbench.tsx`.
- Medium: no test covered the `REPOSITORY_CHANGED` retry, `inspection.reset()`, or a toggle after "Blame before this commit". Fix: one case each.
- Medium: visible texts without a plan line: "1 hunk", the two splitter names, the 240 to 400 px bounds, "Diff of the selected file", and the `path` and `DISPLAY_MAPPING_FAILED` diff texts. Fix: plan D3 lines.
- Low: Back reset the Changed files width and layout. Fix: the widths stay in Workbench state.
- Low: History shortcuts acted on the hidden History list while blame was open. Low, lean: one hunk count, and the formatter. The fix commit does not name these items.
- Suspicions, not verified: a stale first blame source after a History Refresh (the `{blameId}` source covers it); no Trust… action for a file read that needs trust; F6 stops in a hidden tab panel.

**Batch 3 review.** Independent review of WP7 and T057, reviewer agent, on 6e131f7 (diff 794efca..6e131f7). Fixes in a6411bd. Skills: `ponytail-review`, `web-design-guidelines`, `arbareto-ux`, and a manual correctness, security, and heuristics review. Verdict: nothing deletes or writes a file that the Delete confirmation did not show. No heuristic: `deleteReason` and `blameReason` use exact porcelain v2 fields.
- Medium: F6 skipped the ignore editor, because the remembered element sat in a hidden wrapper. Fix: F6 reaches the ignore editor and then the preview (D15 "F6 order").
- Medium: a recent entry, a worktree open, or a clone start dropped unsaved ignore text without the modal. Fix (U1): every open of another repository guards the text (FR-044, D8).
- Low-medium: the Delete items did not show the `path` reason for a name such as `a.`. Fix: `deleteReason` checks each component with the contract Windows name rule.
- Low: the preview notices dropped the count. Fix (U2): "and <n> more" after the notices.
- Low: refusals without a plan text showed raw codes. Fix (U2): plan texts for `unreadable`, `no-recycle-bin`, and `STALE_SELECTION`, and the ignore open text `unreadable` without a code.
- Low: Enter or a double-click on an unavailable submodule row gave no feedback. Fix: the reason shows in the status line.
- Low: some ignore editor outcomes had no live region. Fix: one persistent status element above the preview state.
- Low: the Delete dialog announced only its title. Fix: the notices block is the dialog description (`aria-describedby`).
- Low: the duplicate-line check did not follow Git's trailing-space rule (gitignore(5), dir.c `trim_trailing_spaces`). Fix (U4): the compare trims the existing line, and D8 follows.
- Low, lean: T057 leftovers. Fix: the phase `ignore`, the WSL `append` mode with its test block, the plan walk line, and the duplicate `IGNORE_FILE` and `IgnoreTarget` are gone.
- Low: the delete review state lives in `ChangesPane`, not in `state/workbench.ts`. Fix (U6): D15 "State" names `ChangesPane`.
- Low: the preview was not its own F6 stop. Fix: D15 "F6 order" names the preview stop.
- User decisions of 2026-10-24: U3 shows a `long-path` refusal in place of the confirmation. U5 lets Del with an unmarked focused row act on that row only (plan D15).
- Suspicions, not verified: Escape on a focused Back in the blame view may close the tooltip first; a cancel before the first preview progress event has no `operationId`; `reviewDelete` relies on the shell envelope check for `result.plan`.

**Wrong ticks of T013 and T015, found 2026-10-24.** T013 and T015 were ticked, but the shell `openSubmodule` native step and its cargo tests did not exist. `prepare` in `src-tauri/src/service.rs` had no `openSubmodule` case, so every Open submodule ended with `SERVICE_UNAVAILABLE` in the shell. `registered_root` and the last-repository `finish` case did not name `openSubmodule` either. The ticks were wrong. T066 adds the step and its tests and closes the gap.

**Board comparisons of T027, T047, and T058, 2026-10-24.** Run on f005-impl at 1da5b639 with `bun run dev`, `ARBARETO_PROFILE_ROOT` in a scratch folder, an owned Git configuration, and the CDP port 9333. The run sent no OS input. Each capture is 1600×1000 at scale 1. Light and Dark come from View ▸ Theme. Forced colors is the CDP `Emulation.setEmulatedMedia` emulation, not a Windows contrast theme. Classes: (a) app defect, (b) board out of date with the plan, (c) acceptable. The repository keeps no evidence images in `specs/`, so the screenshots stay local in the orchestrator scratchpad: `f005-boards/shots/` before the fixes and `f005-fix-shots/` after T066 to T077. They are not repository files.
- T027, boards Main, BranchCard, Light, and ForcedColors. Shots: `t027-main-dark.png`, `t027-sidebar-gone-card-dark.png`, `t027-sidebar-track-card-dark.png`, `t027-sidebar-remote-card-dark.png`, `t027-branchlist-gone-card-dark.png`, `t027-sidebar-gone-card-light.png`, `t027-sidebar-gone-card-forced.png`.
  - (c) The card texts, icons, and widths match plan D13 and FR-066. The row name gains ", upstream gone" once, and Escape closes the card while the list stays open. Remote branches nest by folder, with folders first. The card and the mark follow the Light tokens. Forced colors give the card a 1 px CanvasText edge, the gone mark keeps currentColor, and the focus outline is Highlight. A long sidebar row has no room for "→ <upstream>", as on the board, and the card gives the full text.
  - (a) In the branch list, the note "Upstream gone" shrank to 0 px for a long name. T069 fixes it: the note and the mark do not shrink. The "Open <worktree>" note keeps the 004 T116 rule. After: `after-t069-branchlist-gone-card-dark.png`.
  - (a) The branch list card anchored to the name span and covered the gone mark. T069 fixes it: the card anchors to the option row. After: `after-t069-branchlist-gone-card-dark.png`.
  - (a, before 005) The heading showed "References" without the count, and the filter had no placeholder (004 plan.md:528). T075 fixes both. After: `after-main-dark.png` shows "References 10" and "Filter references".
  - Open: the board sidebar rows show branch and folder icons and a worktree mark, and the app shows none. The plan is silent. No task of T066 to T077 covers it. T080 builds it from the Main and BranchCard boards.
  - Not reached: the branch-button card, because the name `main` is not cut.
- T047, boards Main, HistoryStates, Blame, Light, and ForcedColors. Shots: `t047-merge-dark.png`, `t047-submodule-entry-dark.png`, `t047-root-commit-dark.png`, `t047-constrained-changes-tab-900x700-dark.png`, `t047-blame-dark.png`, `t047-blame-before-dark.png`, `t047-blame-submodule-refusal-dark.png`, `t047-merge-light.png`, `t047-blame-light.png`, `t047-blame-forced.png`.
  - (c) The region widths 268 and 288 px, the splitter names, "Changed files (n)", "Compare with" with "Parent 1 <id>", folders first, the status letter colors, the file row names, and the hunk button tooltips match the plan. The root-commit note and the constrained tabs "Commit" and "Changes" match. The blame heading, "Back (Esc)", the three toggles with `aria-pressed`, "40 lines", the 20 px rows, the gutter columns, the refusal texts, the Tab order, and the arrow keys match. The age-bar colors equal the Light tokens. Forced colors give Canvas age bars and a Highlight selected line. The Blame button has no icon. The reason of the unavailable "Blame before this commit" makes the heading two rows tall.
  - (a) In the 268 px Commit details region, full IDs and emails did not wrap, and the region scrolled sideways. T070 fixes it. After: `after-t068-refresh-dark.png` shows the short parent and child IDs and the wrapped ID and email.
  - (a) After Refresh (F5) with a selected commit, the dock showed "Arbareto cannot read the changed files: UNKNOWN_TARGET." T068 fixes it, and T077 fixes the same race for a Refresh during a search. After: `after-t068-refresh-dark.png` shows "Changed files (1)" after F5.
  - (a) The file and submodule rows had no file or cube icon. T073 fixes it. After: `after-t068-refresh-dark.png` and `after-t073-menu-untracked-dark.png`.
  - (a) The blame author was cut, and the gutter tooltip held only the date and the path. T071 fixes it: the tooltip starts with the author, and plan D15 follows. After: `after-t071-blame-dark.png`.
  - (a) After Escape, the focus went to the History filter button. T071 fixes it: the focus goes to the History list. After: `after-t071-back-focus-dark.png`.
  - (a) In forced colors, the number of the selected line stayed Text on Highlight, and a Canvas age bar stayed on it. T072 fixes it. After: `after-t072-blame-forced.png`.
  - (a, before 005) The diff stayed dark in Light. T396 on main fixes it (2439ac41, merged into f005-impl by 1af32a56), not a task of T066 to T077.
  - (b) The board draws two line-number columns and `@@` headers, but plan D3 names the 001 PatchView. The board shows a cube icon on the submodule fact row, but the plan names the info icon. The board keeps "[text TBD]" for the legend, progress, stopped, and limit texts, which the plan holds.
  - Not reached: the shallow, limit, rename, mode, and binary cells of HistoryStates, because the sample has none.
- T058, boards CommitActions, DeleteConfirm, IgnoreEditor, SubmoduleOpen, BranchCard, Light, and ForcedColors. Shots: `t058-menu-untracked-folder-dark.png`, `t058-menu-tracked-file-dark.png`, `t058-menu-submodule-row-dark.png`, `t058-commit-view-dark.png`, `t058-delete-folder-recycle-dark.png`, `t058-delete-tracked-recycle-dark.png`, `t058-delete-permanent-dark.png`, `t058-ignore-editor-dark.png`, `t058-ignore-discard-dark.png`, `t058-submodule-unavailable-menu-dark.png`, `t058-menu-tracked-file-light.png`, `t058-menu-untracked-folder-forced.png`, `t058-menu-tracked-file-forced.png`, `t058-delete-permanent-forced.png`, and the T027 shots for BranchCard.
  - (c) The item order, the "Delete from disk" label, "Add to .gitignore…" only on Untracked rows, "Blame" on tracked rows, the submodule Delete reasons, the 28 px rows, the keyboard open, and Escape back to the row match. The Delete titles, buttons, folder line, tracked line, and "You cannot undo this." match FR-026 to FR-028. The notices are the `aria-describedby` text, Cancel has the first focus, and Tab stays in the dialog. The editor heading, the path tooltip, the 342 px preview, the splitter, the textarea, the two groups, the button order, and the discard texts match. "Open submodule" comes first, and Enter on an uninitialized row puts its reason in the status line. The menu follows the Light tokens. Forced colors give the menu and the dialog a 1 px CanvasText edge, and the Delete items stay CanvasText. The branch card results equal T027.
  - (a) The row menu was 235 or 466 px wide, and only Delete had an icon. T073 fixes it: 300 px with the reason on a second line, and the board icons. After: `after-t073-menu-untracked-dark.png` and `after-t073-menu-submodule-dark.png`.
  - (a) With unsaved text, a real Escape in the editor field did nothing. Cause: the Base UI dismiss listener on `document` closed the discard modal in the same keydown. T067 fixes it with `stopPropagation`. After: `after-t067-escape-discard-dark.png`.
  - (a) The two preview groups split the height. T074 fixes it. After: `after-t074-preview-dark.png`.
  - (a) Open submodule always failed with `SERVICE_UNAVAILABLE`, because `prepare` had no `openSubmodule` case. T066 fixes it. After: `after-t066-submodule-open-parent-dark.png` shows the open submodule with the parent button.
  - (a) In forced colors, every menu item drew a 2 px CanvasText box from the `outline-hidden` class. T072 fixes it. After: `after-t072-menu-submodule-forced.png`.
  - (b, decided) The recycle title used the trash icon, but plan D15 names the alert icon. Decision: both titles use the alert icon. T076 fixes it. After: `after-t076-delete-recycle-dark.png`.
  - (a, before 005) The diff stayed dark in Light, as in T047. T396 fixes it.
  - (b) The board keeps "[text TBD]" for the group label, the reason, the stale save, and the refusals. Its submodule menu has no "Show in Explorer", which the plan lists.
  - Not reached: the WSL variant of the Delete confirmation.
- Run notes: the driver mode `seq` keeps one CDP session, because each new session reset the 1600×1000 override. A script-sent Ctrl+S saved `/notes/` into the sample repository only. The texts were compared by reading the rendered board PNGs.

**Review of the board comparison fixes, 2026-10-24.** Independent reviewer agent on fe6c69f4 (T066 to T076). Verdict: fix needed. The fixes are in feb51099 (T077), merged by 520fd09d.
- Medium: a Refresh during an active search left the Changed files pane on "Arbareto reads the changed files." without end. T077 fixes it.
- Low: two copies of the selected-in-view check. T077 fixes it with the store function `readView`.
- Low: duplicated menu markup in `action-menu.tsx`. T077 fixes it with one label and reason span set.
- Low: a redundant `forced-color-adjust` line. Not changed: the `.age-bar` rule sets `auto`, so the selected-row rule needs `none`, and `tests/contracts/inspection-blame.test.tsx:252` asserts the rule body.
- Verified: the `submodule_path` traversal rules (`is_component`, 001 §6), the WSL UNC branch, the parity with `openWorktree`, that `stopPropagation` takes no other Escape, and that the tests were red before the fixes.
- Suspicions, not verified: a junction at a gitlink path, the WSL path length cap, and no `prepare` test with a WSL root.

**T398 follow-up on main, 2026-10-24.** The frontend network scan of `tests/contracts/boot-view.test.tsx` matched the `fetch` local and the "cargo fetch" message text that T398 (c7e2f68e) added to `src/frontend/build/notices.ts`. 9a4fa109 names the cargo command once in `fetchCommand` and calls the result `cargoFetch`, so the scan finds no network API.

**Batch 4 tests T059 to T061, written 2026-10-24.** In `C:\Projects\arbareto-l6` on 005-batch4 at 520fd09d. No task is ticked: the T063 run decides.
- T059 `tests/wsl/inspection-wsl.test.ts`, alone on Ubuntu-26.04 with `ARBARETO_WSL_DISTRO=Ubuntu-26.04`: 34 pass, 6 skip, 0 fail, 40 tests, 307 s. All 21 `ORIGIN` lines are under the worktree. The distro Git is 2.55.0.
- F1 to F14 and F16 to F19 hold on Git 2.55.0. F15 is a Windows fact, so it skips with `windows-path-rules`. F13: `OBSERVATION T059: F13 ./:x.log matches the pattern :x.log and Git echoes ./:x.log; the bare :x.log gives pattern "" holds (git version 2.55.0)`. So a stdin path that starts with `:` is literal in the `./` form in WSL too, and the contract needs no change.
- The `wslFiles` cases run the Perl text through the wrapper with the operation IDs `0f0f0f0f-0000-4000-8009-*`. `delete`: listed files, a link as a link, and folders deepest first go; a stale entry with and without a digest and an absent entry stay. A folder swapped for a link before the walk gives `not-regular`. A swap during the walk, held by a test seam in place of `sha256sum`, deletes only the reviewed file in the held folder, the next entry gives `not-regular`, and the link target stays. Cancel during the walk ends the scope and every process within 1 s, and the reply is `interrupted`. `replace`: a present and an absent target, `stale`, and `refused` for a link at the target and for a folder link before the walk; during the walk, the held folder gets the bytes. `scratch`: `create` at mode 0700, `sweep`, `remove` without following a link, and refusals for other names.
- Control mutation: without the size check of `delete_one` in `src/contracts/wsl-process.json`, the delete case failed (`stale` became `deleted`). After the undo, the file had its original SHA-256, and the case passed.
- Unverified rows: the service run of a WSL Delete, Cancel during it, the WSL preview, the WSL shadow removal after Cancel and after a killed run, and the WSL Save. `tests/git/bun-runner.ts` refuses a WSL `fileDelete`, `fileReplace`, `shadow`, and `ignorePreview` run, so these rows skip with `shell-double-wsl-file-actions`.
- Fact: Windows `tar.exe` (bsdtar 3.8.9) ends with an access violation on the file name `.gıtignore` (U+0131), so the F19 case-name fixture sends that one file as bytes.
- Fact: the WSL `ignore-save` review makes the seven operation-marker `stat` calls through `\\wsl.localhost`. 001 contract §11 "Paths and file access" keeps them. No call reads the ignore file through UNC (FR-043).
- T060 `tests/windows/inspection-packaged.test.ts` and T061 `tests/windows/inspection-perf.test.ts` need the installed package. Without it, all 13 cases skip and name the reason. T061 measures page timing through CDP and the Event Timing API. The 001 capture check stays a recorded skip until 001 T165, T240, T242, and T244 close.

**T062 review of the requirement-to-test map (quickstart.md Q34), 2026-10-24.** Scope: the "Coverage" rows FR-001 to FR-068 and SC-001 to SC-011 of tasks.md, the 005 service modules (`commit-changes.ts`, `blame.ts`, `blame-parser.ts`, `line-map.ts`, `file-delete.ts`, `ignore.ts`, `ignore-text.ts`, `ignore-preview.ts`, `submodule-open.ts`), the 005 renderer parts, the shell delete, replace, and shadow code, and the Perl modes. Method: a read of the decision points, and a scan for Git message text, clocks, timers, letter-case folds, and name matches. Result: no outcome depends on Git message text, timing, or a name pattern.
- Git output: each outcome comes from an exit code, a raw `-z` record, a porcelain v2 field, the `ls-tree` record form, or the `check-ignore -z -v -n` record. Git stderr goes only into `outputTail` for display.
- Names: the rules that name a form are contract or OS rules. Porcelain v2 `<sub>` `S` marks a submodule. An untracked record that ends with `/` is a nested repository (git-status(1)). The Windows component rule follows the Microsoft naming rules (001 §6). `:(optional)`, `~/`, and `%(prefix)/` are git-config(1) path forms. A shadow leftover goes by its data-model §13 name and the OS process record of its owner. Tree order compares bytes (`compareNames`).
- Time: the process deadlines, also the 30 s deadline of each preview process, and the 60 s review token are contract bounds with typed codes (`DEADLINE`, `APPROVAL_EXPIRED`). The 400 ms preview pause sets only the send time (contract Δ3 `previewIgnore`). The blame progress rate limit sets only the event count.
- Tests: refusal tests assert the code and the reason. The T060 checks assert app texts of plan D15, not Git text. The T061 timings measure the SC budgets and decide no product outcome.
- Open coverage, not a heuristic: the T059 rows that skip with `shell-double-wsl-file-actions`, the T060 and T061 rows until T063 runs the package, N2 and the FR-028 warning (`volume-without-recycle-bin`), and the 001 capture check of T061.
- Plan question: SC-007 names "a normal open" without a definition. T060 takes Repository ▸ Open folder… with the folder picker, driven by UI Automation without human time, as the normal open.

**Batch 4 follow-ups T078 to T080, 2026-10-24.** In `C:\Projects\arbareto-l6` on 005-batch4 after a1f883d8. No task is ticked: the T063 run decides.
- T078: `tests/git/bun-runner.ts` now serves a WSL `fileDelete`, `fileReplace`, `shadow`, and `ignorePreview` run by the shell route, with a `file:line` reference to `src-tauri/src` at each rule. The five T059 rows that skipped with `shell-double-wsl-file-actions` now run. `tests/wsl/inspection-wsl.test.ts` alone on Ubuntu-26.04: 39 pass, 1 skip (F15), 0 fail, 40 tests, 438 s. All 21 `ORIGIN` lines are under the worktree. All 50 `OBSERVATION` lines hold on Git 2.55.0.
- T078 no regression: `tests/git/delete.test.ts` and `tests/git/ignore-editor.test.ts` gave 40 pass, 1 skip (`fifo`), 0 fail. `tests/git/ignore-preview.test.ts` gave 21 pass, 0 fail.
- T078 control mutation: the leftover rule of `shadow.rs:138` without the gone-owner branch made the Q22 row fail ("the leftover shadow folder: not within 60000 ms"). After the undo, the file had its original SHA-256.
- Fact: a folder whose only other file is ignored stays after a WSL Delete with its reviewed files, as `kept`. In the swap case, the walk deletes the first file in the held folder, and the fresh read finds both paths through the link. So the service reports `changed` and `not-regular`, with `STALE_REVIEW`, and nothing outside the reviewed paths changes.
- Fact: the WSL Save run reads the raw index once through UNC (an `open` of `.git\index`), because the status read after the save has no retained digest. 001 contract §11 "Paths and file access" and "Change polling" keep this read. No call reads the ignore file through UNC.
- Double limit: `processCreationTime` gives null for any failed process open, so the double counts such a shadow owner as gone. The shell counts only `ERROR_INVALID_PARAMETER` as gone (`shadow.rs:89`).
- T079: `tests/windows/cdp.ts` holds one key table and `keyEvents`, with F5 (116), F10 (121), and Shift (16, modifier bit 8). `tests/windows/inspection-packaged.test.ts` uses it. The new `tests/windows/cdp.test.ts` checks the events without a package. Control mutation: F10 with the virtual key of F5 made the Shift+F10 case fail.
- T080: the sidebar folder rows show the Muted folder icon, the branch and remote-tracking rows the branch icon, and the tag rows the tag icon of the History list. A local branch that another worktree holds shows the Muted worktree icon of the card, with the tooltip and the row name "Checked out in <path>". The boards show no tag row. The first folder under Remotes keeps the folder icon: a remote name can hold `/`, so the reference name does not give it. Control mutation: without the mark, the worktree case failed.

## Plan review 2026-10-21

The independent plan review of 2026-10-21 found no Critical issue and three High issues in the Delete design. First, the `PreDeleteItem` check compares the held handle with itself and must compare the identity of `psiItem` instead. Second, the WSL `delete` and `replace` modes act by full path and must hold each folder through `chdir` with a device and inode check. Third, the held folder handles block the deepest-first folder removal. The review also found that a folder on the path can become a junction after it is emptied, so the FR-031 limit must name that case too. In the ignore preview, the `--no-index` self-check cannot agree with the shadow for a skip-worktree `.gitignore`. The fix is a typed limit or a self-check against the index-aware listings. The 2 MiB request bound needs base64 text, and the single-file patch read must keep only sections whose paths match exactly. The rest of the method is exact for the report cases, and it runs no repository program before trust approval. The blame and History diff commands are correct apart from two small fixes: `--inter-hunk-context=0` for the line map, and `config --type=path` for the ignore list.

This pass changed: the `PreDeleteItem` compare of `psiItem` (D7, N9); the WSL folder walk with `chdir` and `stat(".")` (D7, D10, Δ11); the folder removal through the held `DELETE` handles with the `a/b/c` cargo test (D7); the junction case in FR-031 and in the contract gaps; the self-check against the index-aware listings RI and RT, which keeps the skip-worktree blob step (D9, F11, F19); the base64 editor text and the 2 MiB bound (D1, O-6, Δ5); the exact section filter of `readCommitFile` (D3, Q4); the `long-path` refusal of plain Delete (D6, N10); N3b and N11; `-c core.longpaths=true` for the shadow, without the `long-path` preview limit (D9, F15); `config get --all --type=path` and `--inter-hunk-context=0` (D12); the exact shadow folder; the R path order; `sharing-violation`; the `name-case` open by the volume case rule (D9); the `fileReplace` rename window in the contract gaps; Save during an unfinished operation and with conflicts (spec FR-046, D10, Δ3); the decided open items O-1 to O-8. It added O-9 for the `blame.ignoreRevsFile` reset rule and corrected F10: a nested repository expands to the one record `x/`. The 004 contract already holds `ignore-not-regular` and `ignore-size` (004 contracts/operations.md:271), so Δ9 keeps them and drops only `not-regular`.
