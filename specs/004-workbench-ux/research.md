# Research: Workbench UX

## R1 Sources and fact marks

- Git documentation: git-checkout(1), git-switch(1), git-stash(1), git-branch(1), git-update-ref(1), git-check-ref-format(1), git-rev-list(1), git-merge(1), git-merge-base(1), git-fmt-merge-msg(1), git-rebase(1), git-mergetool(1), git-worktree(1), git-config(1), gitignore(5), githooks(5), gitattributes(5), gitrevisions(7), git-fetch(1) "GIT URLS".
- Git source through DeepWiki (git/git), asked on 2026-10-16: builtin/branch.c, builtin/checkout.c, builtin/stash.c, builtin/worktree.c, builtin/config.c, builtin/merge.c, sequencer.c, wt-status.c, builtin/cat-file.c. DeepWiki gives function names, not line numbers.
- Microsoft Learn: TASKDIALOGCONFIG, TaskDialog, CoreWebView2.ContextMenuRequested, "Customize context menus in WebView2".
- Git Extensions source through DeepWiki (gitextensions/gitextensions), 2026-10-16, and the scratchpad research of 2026-10-16 (commit 813f48be).
- Repository code at main 6a3933c: `src/git-service/commands.ts`, `hunk-candidate.ts`, `diff-parser.ts`, `src-tauri/src/dialogs.rs`, `src/frontend/keyboard/shortcuts.ts`, `src/contracts/limits.ts`, `node_modules/@pierre/diffs` 1.5.1 type definitions.
- Marks: "doc" is a Git or Microsoft documentation statement. "source" is a source statement through DeepWiki. "code" is this repository. "experiment" needs a P0 test, listed in R21. "unverified" has no source yet.

## R2 Branch switch

- Decision: `checkout`, not `switch`. Local: `checkout --no-guess --no-recurse-submodules <branch> --`. New tracking branch: `checkout --no-guess --no-recurse-submodules -b <name> --track=direct <refs/remotes/...> --`. Commit only: `checkout --no-recurse-submodules --detach <oid> --`.
- Rationale: `--` after the branch makes Git read no path (doc). `--no-guess` turns off the DWIM that creates a tracking branch for a missing local name (doc). `checkout` honors `submodule.recurse` unless `--no-recurse-submodules` is given (doc, git-checkout(1) `--recurse-submodules`), and the 001 rule keeps Git out of submodules. `--track=direct` names the tracking mode, so `branch.autoSetupMerge=inherit` cannot change it (doc).
- A branch that `-b` creates exists only after the switch succeeds: `switch_branches` returns when `merge_working_tree` fails, before `update_refs_for_switch` (source). The DeepWiki answer stated the call order but drew the opposite conclusion, so F2 checks it (experiment).
- Default local name: for each remote, each `remote.<name>.fetch` refspec whose destination pattern matches the remote-tracking ref maps it back to its source. Exactly one mapping to a `refs/heads/` source gives the name. Zero or several give an empty field (spec FR-013). Git's own DWIM uses the same remote fetch refspecs (source, remote.c `query_refspecs`; unverified function name).
- Clean check: `status --porcelain=v2 -z --untracked-files=no --ignore-submodules=dirty`. Only tracked changes decide the choice (spec FR-010), so untracked files cost no listing.
- Alternatives considered: `git switch` (its documentation marked it experimental in older versions; `checkout` covers every case); `git checkout <branch>` without `--` (a path of the same name changes the meaning).

## R3 Stash and reapply, and Discard through a stash

- Decision: `stash push --quiet -m <text>`, verified by the `refs/stash` value and reflog. Reapply with `stash apply --index <S>` by commit ID. Drop with `stash drop --quiet stash@{n}` after a reflog read finds S at n.
- Rationale: `stash apply` accepts any commit that looks like a stash, so the commit ID binds the exact stash (doc, git-stash(1)). `stash drop` takes only a reflog entry (doc). `stash push` without changes prints a message, creates no stash, and exits 0 (source, builtin/stash.c `do_push_stash`). So an unchanged `refs/stash` after exit 0 means "nothing stashed".
- Verification of S: S differs from the earlier value P, the reflog lists S then P, and S^1 equals the bound HEAD. An external stash between the steps gives another observation, and the switch stops before the checkout.
- `--index`: Git tries to restore the index too, and can fail when the index changes conflict (doc). A refused apply keeps S, and the result offers `git stash apply <S>` without `--index` as a copyable command. F5 records whether a refused `--index` apply changes any file.
- Discard: `checkout --force` "throws away local changes and any untracked files or directories that are in the way" (doc, git-checkout(1) `--force`). So Discard stashes the tracked changes and runs the plain checkout. Git then refuses untracked files in the way by its own rule. A refused checkout reapplies S on the unchanged HEAD, which restores every change. A succeeded checkout drops S.
- Alternatives considered: `checkout --force` after an own check (a missed case deletes files); `reset --hard` then checkout (a refused checkout leaves the changes lost); `stash create` plus `stash store` (needs a separate working-tree reset).

## R4 The untracked-in-the-way check

- Decision: the D3 check names the files before Git starts (spec FR-011). Git's own checkout stays the guard.
- Paths: `diff-tree -r -z --no-renames --name-status <HEAD> <target>` lists the paths that the checkout writes or removes. For A, M, and T records, the path and each leading folder are candidates. For D records, the path is a candidate.
- Facts: `fileFacts` without link following (001 §6). A file or link at a candidate counts only when the index has no stage-0 entry at that path. A folder where the target writes a file counts. Discard stashes the tracked changes first, so the check compares no bytes. F7 observed that this rule equals Git's verdict in all 6 cases (R21).
- Ignored files: `check-ignore -z --stdin --no-index` removes ignored candidates. Git treats ignored files as replaceable, and the spec Assumptions accept that. The read has no `--literal-pathspecs` (R21 F1).
- Bound: 20,000 candidate paths (`DISCARD_CHECK_PATHS`). Above it, Discard is unavailable with the limit.
- Case folding on Windows can make the check refuse a case that Git allows. A case that the check misses loses nothing, because Git's own plain checkout refuses it (R3).

## R5 Branch create, rename, delete

- Decision: create with `checkout -b <name> <oid> --` or `branch --end-of-options <name> <oid>`; rename with `branch -m --end-of-options <old> <new>`; delete with `update-ref --no-deref -d refs/heads/<name> <oid>` plus `config --local --remove-section branch.<name>`.
- Rationale: `delete_branches` resolves the branch, then calls `refs_delete_refs` with no expected old value (source). So `branch -D` cannot bind the shown commit, and FR-019 needs that binding. `update-ref -d <ref> <oldvalue>` verifies the old value (doc). `delete_branches` then removes the `branch.<name>` section with `repo_config_rename_section(..., NULL)` in the repository configuration (source). `--no-deref` copies its `REF_NO_DEREF` (source).
- Worktree check: `delete_branches` refuses a branch that `branch_checked_out` reports (source). `update-ref` has no such check, so the review reads the worktree list first (spec FR-017). The window between that read and the delete equals Git's own window.
- Reflog: the files backend removes the reflog of a deleted ref; for reftable the answer was indirect (source, unverified for reftable). F9 compares `reflog exists refs/heads/<name>` with Git's own `branch -D`.
- Rename: `copy_or_rename_branch` renames the section, moves the reflog, and updates each worktree HEAD (source).
- Name check: `check-ref-format --branch` exits non-zero for a name that is not valid (doc). It also expands `@{-n}`, so the printed name must equal the input.
- Alternatives considered: `branch -D` after an own compare (no binding); `update-ref --stdin` with `verify` (no gain over the one-line form).

## R6 Unmerged commit count and the reflog statement

- Decision: `rev-list --count <oid> --not --exclude=<name> --branches --tags --remotes`.
- Rationale: `--exclude` takes a pattern without `refs/heads/` when it applies to `--branches` (doc, git-rev-list(1)). A ref name holds no `*`, `?`, `[`, or `\` (doc, git-check-ref-format(1)), so the pattern matches only that branch.
- Reflog: Git deletes the branch reflog (R5). Only the HEAD reflog of a worktree can keep the tip. `reflog exists HEAD` exits 0 when it exists (doc). `log -g -z --no-show-signature --format=%H HEAD --` lists its entries; the 001 `reflogArgs` already reads this log (code). The read stops at 10,000 entries (`REFLOG_SCAN_ENTRIES`). A tip that the read does not reach gives the "No reflog keeps" text. That text can be too strict, but it never claims a recovery that does not exist.
- Alternatives considered: `branch --merged` output as Git Extensions does (it counts only HEAD ancestry, not other refs).

## R7 Merge

- Decision, Merge commit: `merge --no-autostash --no-edit [--no-ff] [--no-commit] --no-log -m <message> --end-of-options <ref>`, with the full ref and the preview or the edited text (R21 F12).
- Decision, Squash: `merge --no-autostash --no-edit --squash --end-of-options <ref>`. Git ignores `-m` with `--squash` (R21 F30).
- Counts: `rev-list --left-right --count HEAD...<oid>` (doc). Fast-forward: `merge-base --is-ancestor HEAD <oid>`, exit 0 true and 1 false (doc).
- Message preview: `merge_name` writes `<oid>\t\tbranch '<name>' of .` for a local branch (source, recalled; DeepWiki did not return that function). `fmt-merge-msg` formats a merge message from such lines (doc). F12 checks equality with Git's own message, `merge.log`, and the " into <branch>" suffix.
- `-m` with `merge.log` true appends a shortlog to the given message, and `--no-log` stops it (source, t7600). So the Merge commit argv always sends `-m` together with `--no-log`. The preview already holds the shortlog when `merge.log` is true (F12).
- `--squash` with `--no-ff` is refused, and `--no-commit` still fast-forwards (doc, source).
- `--no-autostash`: 003 N-4 keeps the app from adding an autostash to merge.
- Alternatives considered: `-m` only for an edited message (with the full ref, Git writes `Merge branch 'refs/heads/topic'`, F12); the short name in the argv (a tag of the same name can win).

## R8 Rebase counts and options

- Decision: moved count `rev-list --count --right-only --cherry-pick --no-merges <oid>...HEAD`; rewritten count `rev-list --count <oid>..HEAD`; held count by `--not --remotes`; force note by `--not <T>` of the 003 push tracking ref.
- Rationale: `sequencer_make_script` walks `upstream...orig_head` with `right_only`, `cherry_mark` unless `--reapply-cherry-picks`, and `max_parents=1` unless `--rebase-merges`, and drops PATCHSAME commits (source). With an explicit upstream, the default is `--no-fork-point` (doc, git-rebase(1)). Empty commits can make the counts differ (source note), so F13 compares the count with the commits that Git's own rebase creates.
- Options: the argv always passes the explicit Autostash and Autosquash forms, so Git does what the check boxes show. On Git 2.56, `rebase.autoSquash=true` alone does not squash in a non-interactive rebase (experiment, F15). So Autosquash starts unchecked and takes no default from `rebase.autoSquash`.
- Moved branches: `rebase.updateRefs` moves local branches whose tips lie in the rewritten range (doc, git-rebase(1) `--update-refs`). Git moves the branches of the `update-ref` lines of its todo list (source, sequencer.c `todo_list_add_update_ref_commands`; plan D6). Git adds a line for each local branch whose ref value is a commit of the todo list. Git skips the HEAD branch and each branch that `branch_checked_out` names. F16 confirmed that Git does not move a branch that another worktree checks out (experiment). The review does not read Git's todo list. It builds the same selection from its own reads (`src/git-service/merge-rebase.ts` `updatedRefs`). First, it lists `refs/heads` and drops each branch that the `branch` attribute of another worktree record names (`worktree list --porcelain -z`). Second, it walks `rev-list --right-only --cherry-mark --parents <onto>...HEAD`, with `--no-merges` unless `rebase.rebaseMerges` turns rebase merges on. Third, it keeps each branch whose ref value is a walk commit. A patch-same commit counts only when it is empty, because builtin/rebase.c sets `keep_empty`. A `cat-file` batch read of the trees decides this: the commit tree equals the parent tree, or the empty tree for a root commit. The current branch counts when the rebase rewrites at least one commit. The review reads no moved list when `rebase.updateRefs` is off.
- Dirty tree: Git refuses a rebase with tracked changes unless `--autostash` (doc). F14 confirms it on both Git versions.

## R9 Conflict resolve and merge tool

- Choose a side: `checkout --ours -- <path>` and `checkout --theirs -- <path>` check out stage 2 or 3 of an unmerged path, and the path stays unmerged (doc, git-checkout(1)). During a rebase, the sides swap (doc). The file checkout runs `post-checkout` with flag 0 (doc, githooks(5)). It can run smudge filters and write the index, so the `workbench` class applies. F19 confirmed that it writes the index and runs `post-index-change`, and that the path stays unmerged, during a merge and a rebase.
- Merge tool: `mergetool --tool=<tool> --no-prompt -- <path>` (doc, git-mergetool(1)). The script writes the stage files with `checkout-index`, runs the tool, and runs `git add` when the tool reports success. Without a trusted exit code, it asks on its terminal; empty standard input ends that question as "no" (experiment, F21 confirmed). The documentation defines no exit status, so a fresh index read decides (spec FR-096).
- `mergetool.keepBackup` and `mergetool.<tool>.trustExitCode` stay unchanged (spec FR-093).
- Merge drivers: gitattributes(5) "Defining a custom merge driver" runs `merge.<driver>.driver` for a path with `merge=<driver>`. Merge, rebase, and stash apply run it. 001 trust discovery lists no merge driver (001 contract §7 "Trust discovery includes …"). D12 adds it.

## R10 Multi-file staging

- Decision: the 001 `applyFile` candidate path with a path list: `update-index --add --remove -z --stdin`, one verification, one publication.
- Rationale: FR-036 and FR-039 bind the action to the shown read. `add -- <folder>` stages every current file under the folder, also files that the read did not show. It also writes the canonical index without the candidate check. `add --pathspec-from-file` has the same canonical-index issue.
- Proof A batch: `cat-file --batch --filters` needs `<object> <path>` per input line; Git splits at the first white space and skips the run of white space (source). Its header gives the stored blob size, not the filtered length (F26), so the records cannot be framed. Decision: each file takes the single-file proofs until plan O-17 is resolved.
- Bound: 10,000 files and 512 MiB. The 512 MiB value is the 001 streamed input bound (`STREAMED_PROCESS_INPUT_BYTES`, code). P9 records the time of a 10,000-file action.

## R11 Line staging

- Decision: the service builds one sub-hunk from the retained hunk and the renderer's line ordinals. The 001 pipeline applies and verifies it.
- Stage (index to working file, applied forward): an unselected `-` line becomes a context line, and an unselected `+` line goes. Unstage (HEAD to index, applied with `--reverse`): an unselected `+` line becomes a context line, and an unselected `-` line goes. The old count is context plus `-` lines; the new count is context plus `+` lines. This is the line edit that `git add -p` allows (unverified source name, add-patch.c).
- Starts: the old and new starts of the retained header stay. 001 already applies one hunk of a multi-hunk diff with its original header (code, `prepareCandidate`). A side count of 0 takes the start of the line before, as xdiff writes it.
- No `--unidiff-zero` and no `--recount`: the sub-hunk keeps its context, and the service computes exact counts.
- Verification: `applyToContent(base, subHunk, reverse)` computes the expected blob, and the exact entry check runs (code). A wrong patch therefore refuses and never publishes. Exception: in a hunk with an incomplete-line marker, both compute the same joined lines (F25). So the refusal runs before the apply.
- Refusals: context lines only; two hunks; a deleted-file hunk, because a partial deletion needs a modify header; any partial selection in a hunk whose body holds an incomplete-line marker on either side. F25 covers each case.
- Contract: 001 §4 forbids line ranges from the renderer. Δ4 allows ordinals inside one service-retained hunk only.
- Pierre 1.5.1 has `enableLineSelection`, `controlledSelection`, and `onLineSelected` with a `SelectedLineRange` (code, `managers/InteractionManager.d.ts`).

## R12 Ignore lines

- Decision: the app appends one line by a native file write. No Git command writes `.gitignore` or `info/exclude`.
- Escapes (doc, gitignore(5)): a leading `/` anchors at the folder of the file; a trailing `/` matches folders only; `*`, `?`, and `[` are glob characters, and a backslash quotes them; trailing spaces are ignored unless quoted with a backslash; a line that starts with `#` or `!` needs a backslash, which the leading `/` avoids.
- Target of `info/exclude`: `rev-parse --path-format=absolute --git-path info/exclude`. A linked worktree gets the common folder file (doc, gitrepository-layout(5); F23).
- Refusals: a link, a non-regular file, invalid UTF-8, a NUL, a file above 1 MiB, and an existing equal line (spec FR-046).

## R13 Worktrees

- `worktree list --porcelain -z`: attribute lines `worktree <path>`, `bare`, `HEAD <oid>`, `detached`, `branch <ref>`, `locked [<reason>]`, `prunable <reason>`. Each line ends with NUL, and one more NUL ends the record. With `-z`, reasons are not quoted (source; t2402).
- `worktree add` populates the new worktree with `reset --hard --no-recurse-submodules` (source, `checkout_worktree`). So `submodule.recurse` does not apply.
- `worktree prune` uses `TIME_MAX` as the default expiry and does not prune locked worktrees (source).
- `worktree remove` refuses a worktree with changes or untracked files without `--force`, and a locked one without a second `--force` (doc).
- Git Extensions sets `worktree.useRelativePaths`; the app does not (spec FR-053).

## R14 Git configuration read and write

- Read: `config list --show-scope --show-origin -z` lists entries in Git's read order, so the last entry of a key is the effective value (doc). The 001 trust listing uses it (code, `configListArgs`).
- Write: `config set` and `config unset` work with `--local` and `--global` (doc). Exit codes: 1 invalid key, 2 no name, 3 invalid file, 4 cannot write, 5 no matching or several matching lines, 6 invalid regular expression (doc).
- `--`: the documentation does not state it for `config set`. Git's option parser stops at `--` (unverified for this subcommand). F22 checks a value that starts with `-`.
- `--global` file: `~/.gitconfig` when it exists, else the XDG file when it exists, else `~/.gitconfig` (doc, source `git_global_config`).
- Merge and diff tool presets: the file names of Git's `mergetools/` folder (Git source tree). F24 records the list of each Git version from `git mergetool --tool-help` exit 0 and the folder listing of the Git installation; the plan takes names only from the folder.
- Editor presets: Git Extensions lists vi, Notepad, Notepad++, VS Code, Zed, and Sublime Text (Git Extensions `EditorHelper.cs`). The exact values are unverified (O-10). O-10 closed on 2026-10-19 by user decision: plan.md D11 gives the sources, and D15 gives the commands.

## R15 Trust option (d)

- Decision: one native task dialog, asked only when an action would run a repository program. The approval binds to folders, the Git selection, and the policy version.
- Rationale: the user found two confirmations and the fingerprint text hard to understand (spec US7). Spec Clarifications 2026-10-16 decide the binding.
- Discovery stays the 001 §7 rules (spec FR-075), plus merge drivers (R9).
- Classes: R9 and the githooks(5) entries name the programs that each new command can run:
  - checkout: `post-checkout`, `reference-transaction`, filters, `core.fsmonitor`, `post-index-change`;
  - stash push and apply: filters, merge drivers, `core.fsmonitor`, `post-index-change`, `reference-transaction`;
  - merge: `pre-merge-commit`, `prepare-commit-msg`, `commit-msg`, `post-merge`, `reference-transaction`, merge drivers, filters, signing, `pre-auto-gc`;
  - rebase: `pre-rebase`, `post-checkout`, `post-rewrite`, `post-commit`, `prepare-commit-msg`, `reference-transaction`, merge drivers, filters, signing, `pre-auto-gc`;
  - worktree add: `post-checkout`, `reference-transaction`, filters; worktree remove runs the clean filter and `core.fsmonitor` of that worktree (experiment, F18 confirmed);
  - branch create, rename, delete, and `update-ref`: `reference-transaction`.
- One class covers the union (ponytail ceiling, plan N-2).

## R16 Submodule update redesign

- The 001 §12 protocol stays. Only the start, the scope, the host lines, and the texts change.
- Host grammar (doc, git-fetch(1) "GIT URLS"): `ssh://[user@]host.xz[:port]/path`, `git://`, `http[s]://`, `ftp[s]://`; the scp form `[user@]host.xz:path` holds only when no slash comes before the first colon; a local path and `file://` name no host.
- Host names compare without regard to case (RFC 4343 §2). A URL with user information is redacted first (001 §7).

## R17 Native dialogs, context menus, Explorer reveal

- Task dialog: `pszMainInstruction`, `pszContent`, `pszExpandedInformation`, `pszCollapsedControlText`, `pszExpandedControlText`, `pButtons`, `nDefaultButton` (doc, Microsoft Learn TASKDIALOGCONFIG). The expanded text shows below the content unless `TDF_EXPAND_FOOTER_AREA`. `TDF_ALLOW_DIALOG_CANCELLATION` lets Escape, Alt+F4, and the close button close the dialog, and the result is `IDCANCEL` (doc, TaskDialog). Hyperlinks need `TDF_ENABLE_HYPERLINKS`, which the doc warns against for unsafe content.
- The shell already uses `TaskDialogIndirect` with `TDF_ALLOW_DIALOG_CANCELLATION` and Cancel as `IDCANCEL` (code, `dialogs.rs`).
- Context menus: WebView2 raises `ContextMenuRequested` only when the page has not disabled the menu (doc). So a page `contextmenu` handler with `preventDefault` shows the app menu, and the 001 shell handler needs no change. In the package, N2 confirmed that UIA `ShowContextMenu` opens the app menu. Right-click and Shift+F10 wait for T082.
- Menu item names: Core-AAM 1.2 §3.5.2.53 maps `aria-keyshortcuts` to the UIA property `AcceleratorKey`. Chromium does the same: Blink `ax_object.cc` copies `aria-keyshortcuts` into `kKeyShortcuts`, and `ax_platform_node_win.cc` returns `kKeyShortcuts` for `UIA_AcceleratorKeyPropertyId`. WebView2 uses Chromium, but no package check confirms the mapping yet. T082 reads it.
- Explorer: `SHOpenFolderAndSelectItems` opens a folder with an item selected (Microsoft Learn; not fetched in this session, unverified). N5 checks it.

## R18 Commit workspace scale

- The status read keeps the 001 bounds: 100,000 records and 32 MiB (code, `STATUS_LISTING_RECORDS`, `STATUS_LISTING_BYTES`). The renderer receives pages of 8 MiB (code, `STATUS_PAGE_BYTES`).
- Porcelain v2 order: changed records, unmerged records, then untracked and ignored records (source, `wt_porcelain_v2_print`). So a cut inside the untracked records leaves the tracked and unmerged lists complete. The service knows the kind of the last parsed record, so `cut: "untracked"` is exact.
- The virtual list: `@tanstack/react-virtual` renders only visible rows; feature 002 R8 found its rebuild cost acceptable up to 100,000 rows (002 plan D6). The Untracked rows build lazily.
- Git's own listing time with 100,000 untracked files is Git's cost. SC-007 measures the window, not Git.

## R19 Keyboard map

- Git Extensions defaults (source, HotkeySettingsManager.cs `CreateDefaultSettings`): Pull Ctrl+Down, Fetch Ctrl+Shift+Down, Push Ctrl+Up, Commit Ctrl+Space, Checkout branch Ctrl+., Create branch Ctrl+B, Merge branches Ctrl+M, Rebase Ctrl+Shift+E; left panel Delete and F2.
- Deviation: spec FR-014 names Pull Ctrl+Shift+P and Push Ctrl+Shift+Up as Git Extensions defaults. The source does not. The plan keeps the 003 D12 keys (O-1).
- 001 keys (code, `shortcuts.ts`): F5, F6, Shift+F6, F10, Ctrl+Enter, Ctrl+O, Ctrl+R, Alt+Up, Alt+Down. 002 keys: Ctrl+F, F3, Shift+F3, Ctrl+Shift+B. No new key collides with them.
- Commit Ctrl+Space stays out, because it toggles some IMEs (001 plan "Icons").

## R20 Spell check

- Decision (proposed): `nspell` with `dictionary-en`, in the renderer. The T077 check below supports it.
- Rationale: offline, deterministic for the SC-012 fixture, and no AI. Git Extensions uses NetSpell dictionaries (Git Extensions source).
- `nspell` facts (npm registry, 2026-10-17): version 2.1.5, published 2021-01-17, the last release. License MIT; the package file `license` holds "(The MIT License) Copyright (c) 2016 Titus Wormer".
- `nspell` upkeep: maintainer `wooorm`; repository github.com/wooorm/nspell, not archived, last push 2021-01-17, 9 open issues (GitHub API). The code is stable, but nobody changes it.
- `nspell` form: CommonJS (`main: lib/index.js`, `require`). Vite bundles CommonJS. One runtime dependency: `is-buffer` `^2.0.0` (2.0.5, MIT, file `LICENSE`).
- `dictionary-en` facts (npm registry): version 4.0.0, published 2023-11-03, the last release. SPDX expression in `package.json`: `(MIT AND BSD)`. No runtime dependencies.
- `dictionary-en` upkeep: maintainer `wooorm`; repository github.com/wooorm/dictionaries (folder `dictionaries/en`), not archived, last push 2024-09-09, 15 open issues.
- `dictionary-en` word list: Hunspell en_US 2020.12.07 from SCOWL size 60 (wordlist.sourceforge.net). The package file `license` (15,731 bytes) is the SCOWL README with its copyright section.
- Word list license (package `license` file): SCOWL is "Copyright 2000-2018 by Kevin Atkinson" with a permissive grant that requires the copyright and permission notice in all copies. The `.aff` file is derived from Ispell under Geoff Kuenning's BSD license. Parts come from public-domain lists (Moby, others).
- `dictionary-en` files: `index.aff` 3,086 bytes, `index.dic` 551,762 bytes.
- `dictionary-en` export form: ESM only, `exports: "./index.js"`. `index.js` uses `node:fs/promises` `readFile(new URL('index.aff', import.meta.url))` with top-level await. This does not run in the renderer.
- Compatibility: MIT, BSD (Ispell), and the SCOWL grant are permissive, and AGPL-3.0-or-later code can include them (GNU license list: MIT/Expat and modified BSD are GPL-compatible). Each requires only its notice in copies.
- Notices: `src/frontend/build/notices.ts` `npmClosure` takes runtime packages from `bun.lock`, and `LICENSE_NAMES` matches the file name `license`. So `nspell`, `is-buffer`, and `dictionary-en` get their license files in the inventory without a code change. T079 must check that the full `dictionary-en` `license` text appears in the generated inventory.
- Browser load: the package `exports` map exposes only `./index.js`, so `import "dictionary-en/index.dic?raw"` fails resolution. Use a Vite `resolve.alias` to the package folder, or copy the two files into `src/frontend/commit/`, and import them with `?raw` (Vite 8.3.2 as installed; `vite/client.d.ts` declares `*?raw`).
- No network: `?raw` inlines the text into the JS chunk, so no request happens at run time. Do not use `?url`: it emits a separate asset that the page fetches.
- Bundle cost: dictionary text 554,848 bytes raw, 191,840 bytes gzip -9 (`.dic` 190,834, `.aff` 1,006). `nspell` and `is-buffer` add about 28 KB of unminified JS. Load the dictionary with a dynamic `import()` so it stays out of the startup chunk.
- Alternative `hunspell-asm` 4.0.2 (MIT, last change 2022-06-18): a WASM Hunspell. It also needs the same dictionary files and a WASM load. It gives no benefit over `nspell` here.
- Alternative WebView2 built-in check (`spellcheck="true"`): suggestions appear only in the native default context menu, as items of kind `spellCheck` (Microsoft Learn, ICoreWebView2ContextMenuItem). The page cannot read them. Arbareto draws its own context menu, so FR-083 suggestions and Ignore need Win32 `ContextMenuRequested` code in the shell. That code is not portable.
- WebView2 language and network: Microsoft Learn does not document which spell checker or language WebView2 uses, or whether it needs network. Unverified. The result also depends on the Windows dictionaries, so SC-012 has no fixed oracle.
- Recommendation (awaits the orchestrator's approval): add `nspell` `^2.1.5` and `dictionary-en` `^4.0.0` in T079, load `index.aff` and `index.dic` through a Vite alias with `?raw` in a dynamic import, and keep WebView2 spell check off.

## R21 Open facts (P0 list)

Each fact runs on Windows Git 2.56 and WSL Ubuntu-26.04 Git 2.55, compared with Git's own command on a copy. Results go into the Results section below.
- F1: every argv of contract Δ3 is accepted, including `--end-of-options` and `--` positions. On WSL, T081 checks whether `check-ignore --no-index` reads a stdin path that starts with `:` literally.
- F2: `checkout -b` with a refused switch creates no branch.
- F3: Keep changes with a conflicting change leaves HEAD, the index, and every working byte unchanged.
- F4: the stash protocol observations (S, P, the reflog pair, S^1) for one and two earlier stashes, and for "nothing to stash".
- F5: `stash apply --index` that Git refuses changes no file.
- F6: Discard through a stash equals `checkout --force` for tracked files, and keeps untracked files.
- F7: the untracked-in-the-way check names a path exactly in the cases that Git refuses.
- F8: `checkout -b <new> --track=direct refs/remotes/<r>/<b>` writes the same `branch.<new>` keys as `git checkout --track <r>/<b>`.
- F9: `update-ref -d` plus `--remove-section` equals `branch -D` in refs, reflogs, and configuration bytes; a moved branch makes `update-ref -d` exit non-zero and change nothing.
- F10: the unmerged count equals the commits that `branch -D` makes unreachable from every branch, tag, and remote-tracking ref.
- F11: `check-ref-format --branch` exit and output for valid names, invalid names, and `@{-1}`.
- F12: the `fmt-merge-msg` preview equals Git's own merge message, with and without `merge.log`, on `main` and on another branch.
- F13: the moved count equals the commits that Git's own rebase creates, with patch-same, empty, and merge commits.
- F14: rebase with tracked changes and `--no-autostash` exits non-zero and changes nothing.
- F15: whether `rebase.autoSquash=true` squashes in a non-interactive rebase, and the explicit `--autosquash` and `--no-autosquash` forms.
- F16: the moved-branch list, without the branches of other worktrees, equals the refs that `--update-refs` moves.
- F17: `worktree add -- <path> <branch>` checks out the branch, not a detached HEAD, also when a tag of the same name exists.
- F18: `worktree remove` without `--force` runs the filters and the monitor of that worktree (canary).
- F19: `checkout --ours -- <path>` writes the index and runs `post-index-change` (canary).
- F20: the `worktree list --porcelain -z` grammar for locked and prunable records with and without reasons, and a path with spaces.
- F21: `mergetool --no-prompt` with an untrusted exit code and empty standard input stages nothing and exits.
- F22: `config set --local -- <key> -value` writes the value `-value`.
- F23: the `info/exclude` path in a linked worktree.
- F24: the merge tool names of each Git version.
- F25: the sub-hunk apply equals the expected blob for every selection of the line fixtures, for stage and unstage.
- F26: `cat-file --batch --filters -Z` input and output form.
- F27: `update-index --add --remove -z --stdin` with 10,000 paths equals `git add` of the same paths.
- F28: a status read cut by a lowered record bound inside the untracked records keeps every tracked record.
- F29: with an existing `refs/heads/@`, what `checkout --no-guess --no-recurse-submodules @ --`, `worktree add -- <path> @`, and `branch -m --end-of-options @ <new>` do.
- F30: `merge --squash` with `--no-log -m <msg>`: the exit, whether `SQUASH_MSG` holds `<msg>`, the bytes against `merge --squash` without `-m` on a copy, and the message of the later `commit --quiet --file=-`.
- F31: `hash-object --stdin-paths` against the index after `git add`, for an `eol=crlf` file, a plain file, a name with a space, and a leading space; raw and C-quoted lines; a CR before LF; a bad quote.
- N1: the task dialog shows the main instruction, the content, and the collapsed details; Enter and Escape return Not now (UI Automation).
- N2: a page `contextmenu` handler with `preventDefault` shows the app menu in the package, and Shift+F10 reaches it.
- N3: a fixture merge tool runs inside the operation Job.
- N4: Cancel ends Git, its shell, and the fixture tool.
- N5: `SHOpenFolderAndSelectItems` selects the path.
- N6: the fixture tool window comes to the front.

### Results

Run of 2026-10-17: Windows Git 2.56.0.windows.2, Windows 10.0.26300, commit a220d42. T003 (`tests/git/workbench-facts.test.ts`) passed 53 tests, and T004 (`tests/git/staging-facts.test.ts`) passed 5 tests. N1 to N6 come from three clean T005 runs (`tests/windows/native-facts.test.ts`) of the same day in the installed package. A `mismatch` below is a `match=false` line. The design already handles each of them. The WSL run of F1 to F31 waits for T081.

Rerun of 2026-10-18 for T006 and T020 on f004-impl at 1cab2ad in `C:\Projects\arbareto-l4`: Windows Git 2.56.0.windows.2, Windows 10.0.26300. Source: `C:\Users\user\AppData\Local\Temp\claude\C--Projects-arbareto\8bd0e319-3a63-441e-a5a8-cff2008c0012\scratchpad\verify-004\observations-r2.txt`, 342 `OBSERVATION` lines. T003 has 215 lines, T004 has 92, and T005 has 35. Of these, 193, 83, and 15 are F and N lines; the other lines come from earlier feature tests with the same task IDs. T003 has 7 `match=false` lines (F11, five F12 lines, F16). T004 has 6 (two F25, four F26). T005 has none, and 2 `unverified` lines (N1 Enter and Escape, N2 right-click and Shift+F10, both `live-input`). Each line below has the same mark and line counts in this rerun, except N6, which now matches.
- F1, match (62 of 62 lines, rerun of 2026-10-17 on f004-b0-fixes): every argv of contract Δ3 exits as expected. The rerun adds `--no-show-signature` to both reflog reads, the global `--literal-pathspecs` to `choose-side`, `--no-log -m` to each merge form with `--no-ff` and `--no-commit`, and the D6 moved count without `--no-merges`. `check-ignore -z --stdin --no-index` with `--literal-pathspecs` exits 128, as contract Δ3 states, and the contract form without the flag exits 0. Design change from the first run: that one read drops `--literal-pathspecs` (plan D3, contract Δ3). Without the flag, a stdin path that starts with `:` can be read as pathspec magic, so plan D3 refuses such a candidate with reason `path`. NTFS cannot hold `:`, so T081 checks the literal read on WSL.
- F2, match: `checkout -b` with a refused switch exits 1, `show-ref --exists` then exits 2, and no file changes, for the track and the start-point forms.
- F3, match: Keep changes with a conflicting change exits 1 and changes nothing.
- F4, match: the stash creates S, and the reflog holds S, or S and P for one and two earlier stashes, and S^1 is HEAD. "Nothing to stash" exits 0, creates no stash, and keeps the reflog.
- F5, match: `stash apply --index` that Git refuses exits 128 and changes no file.
- F6, match: Discard through a stash equals `checkout --force` for tracked files, and keeps the untracked file bytes.
- F7, match: in the tracked-conflict case, the first rule (no stage-0 entry with the same bytes) named `a.txt`, which Git allows after the Discard stash. The narrower rule counts a file or link only when the index has no stage-0 entry at that path. It equals Git's verdict in all 6 cases. Design change: R4, plan D3, and contract Δ3 use the narrower rule.
- F8, match: `checkout -b <new> --track=direct refs/remotes/<r>/<b>` writes the same `branch.<new>` keys as `git checkout --track <r>/<b>`.
- F9, match: `update-ref -d` plus `--remove-section` equals `branch -D` in refs, reflogs, and configuration bytes. With a moved branch, `update-ref -d` exits 1 and changes nothing.
- F10, match: the unmerged counts equal the commits that `branch -D` makes unreachable (2, 0, 0, and 1 in the fixture).
- F11, mismatch (1 of 26 lines): `check-ref-format --branch @` exits 0 and prints `@`, so Git accepts `@` as a branch name. Design change: the name rule refuses `@` with reason `reserved-name` (F29, plan D3, D4, contract Δ3).
- F12, mismatch (5 of 15 lines): the `fmt-merge-msg` preview with the short display name equals Git's own `git merge <short name>` message in all 5 cases (main, another branch, `merge.log` on each, a remote-tracking source). The full-ref argv without `-m` writes `Merge branch 'refs/heads/topic'`, which differs from the preview in all 5 cases. With `--no-log -m <preview>`, the full-ref argv equals Git's own message. Design change: the merge argv keeps `--end-of-options <full ref>` and always passes `--no-log -m <preview or edited text>` (plan D5, contract Δ3, data-model §5).
- F13, match: the moved count is 4 and equals the commits that Git's own rebase creates, with patch-same, empty, and merge commits. F13.force-note records `notTracked` 3 and `rewritten` 6, so the force note shows.
- F14, match: rebase with tracked changes and `--no-autostash` exits 1 and changes nothing.
- F15, match: F15.config-only records exit 0 and the subjects `feature`, `other`, `fixup! feature`, so `rebase.autoSquash=true` alone keeps the `fixup!` commit in a non-interactive rebase. `--autosquash` squashes it, and `--no-autosquash` keeps it. Design change: Autosquash starts unchecked and takes no default from `rebase.autoSquash` (spec FR-025, plan D6).
- F16, mismatch (1 of 3 lines): `for-each-ref --merged=HEAD --no-merged=<oid>` also lists `refs/heads/wt-part`, which another worktree checks out, and Git's `--update-refs` does not move it. The list without the branches of the other worktree records equals the moved refs. Design change: plan D6 and contract Δ3 remove those branches.
- F17, match: `worktree add -- <path> <branch>` checks out `refs/heads/<branch>`, also when a tag of the same name exists.
- F18, match (canary): `worktree remove` without `--force` runs the clean filter and `core.fsmonitor` of that worktree. The `workbench` class covers both, and plan D10 applies the trust of that worktree.
- F19, match (canary): `checkout --ours -- <path>` writes the index, runs `post-index-change` and `post-checkout` with flag 0, and leaves stages 1 to 3, during a merge and a rebase. During a rebase, "ours" is the upstream side, so the resolve view names each side by its branch (spec FR-090, plan D7).
- F20, match: `worktree list --porcelain -z` gives the main worktree first, a path with spaces, `locked` with and without a reason (a reason can hold a newline), and `prunable <reason>`.
- F21, match: with the fixture tool, `mergetool --no-prompt` stages the result and keeps a backup. With a tool that leaves the file unchanged, an untrusted exit code, and empty standard input, it exits 1, stages nothing, and leaves the working file unchanged.
- F22, match: `config set --local -- <key> -value` writes `-value` and changes no other file. After the unset, `config get` exits 1.
- F23, match: in a linked worktree, the `info/exclude` path is `repo/.git/info/exclude` of the main worktree, and `check-ignore` honors it.
- F24, record: F24.mergetools-folder observes 24 merge tool names in Git 2.56.0.windows.2: araxis, bc, codecompare, deltawalker, diffmerge, diffuse, ecmerge, emerge, examdiff, guiffy, gvimdiff, kdiff3, kompare, meld, nvimdiff, opendiff, p4merge, smerge, tkdiff, tortoisemerge, vimdiff, vscode, winmerge, xxdiff. WSL Ubuntu-26.04 Git 2.55.0 lists the same 24 names (T081).
- F25, mismatch (2 of 48 lines): a partial line selection in an end-of-file hunk makes `apply --cached` join two lines. It writes `one\ntwo\nthreethree changed` with exit 0, for stage and unstage. `applyToContent` computes the same blob, so the 001 entry check cannot catch it. Every other selection equals the expected blob. Design change: any partial selection in a hunk with an incomplete-line marker on either side refuses with `eof-newline` before the apply. The whole hunk stays available (plan D8, contract Δ4, spec FR-044).
- F26, mismatch (4 of 27 lines): the `cat-file --batch --filters -Z` header gives the stored blob size (4), not the filtered length (6). The header form, the NUL record end, and the content match the single-file proof A. The batch proof A cannot frame its records when a filter changes the length. Design change: each file of a file set takes the 001 single-file proofs. A batch replacement is open (plan O-17).
- F27, match: `update-index --add --remove -z --stdin` with 10,000 paths gives the same index entries and the same `write-tree` as `git add`, and removes the deleted path.
- F28, match: porcelain v2 lists tracked and unmerged records before untracked records. The record order implies that a lowered bound inside the untracked records keeps every tracked, unmerged, and staged record. The cut lines are records: each observes an empty lost list (cut at 24 of 45 and at 29 of 49).
- F29, match: with `refs/heads/@` at another commit, `checkout --no-guess --no-recurse-submodules @ --` exits 0 and changes nothing, because Git reads `@` as HEAD. `worktree add -- <path> @` checks out `refs/heads/@`. `branch -m --end-of-options @ from-at` renames `refs/heads/@`. Design change: the name rule refuses `@` with reason `reserved-name` for create, the new name of rename, and the track name. Switch and worktree add refuse an existing `@` before any Git process. Rename from `@` and delete stay available (plan D3, D4, D10, contract Δ3, Δ9).
- F30, match: `merge --no-autostash --no-edit --squash --no-log -m <msg> --end-of-options refs/heads/topic` exits 0 and leaves HEAD unchanged. Git ignores `-m`: F30.squash-msg-holds-m observes `false`, so `SQUASH_MSG` does not hold `<msg>`, and it equals the bytes of the argv without `-m`. The later `commit --quiet --file=-` commits the given text. Design change: the Squash argv sends no `--no-log -m`. The later commit is the 001 commit, and its message is the commit box text (plan D5, contract Δ3, data-model §5).
- F31, match: `hash-object --stdin-paths` prints one object ID per line in input order. The IDs equal the index after `git add` for an `eol=crlf` file, a plain file, `with space.txt`, and ` lead.txt`, with raw lines and with C-quoted lines. Git strips a CR before the LF. A line that starts with `"` and fails C unquoting exits 128. The index bytes stay unchanged. NTFS cannot hold LF, CR, or tab in a name, so T081 checks those names on WSL. Open: Git reads the working file itself, not the verified bytes, so this check does not meet 001 §4 "Blob proof" (plan O-17).
- O-17 measurement, 2026-10-18: Windows Git 2.56.0.windows.2, AMD Ryzen 7 4800H with 16 logical processors, f004-wp9 after 4cf3a14, a scratch test outside the repository. Stage all untracked of 2,000 files took 104.0 s with 1 proof at once, 42.5 s with 4, 33.8 s with 8, and 33.4 s with 12. The proof part took 87.5 s, 26.8 s, 18.7 s, and 18.1 s. So `MULTI_FILE_PROOF_CONCURRENCY` is 8. `update-index` took 8.3 s to 9.2 s for 2,000 files and 39.7 s for 10,000 files, at most 4.6 ms for each file. One step 7 status process took 0.06 ms for each file. So `MULTI_FILE_STEP_MS_PER_FILE` is 15 ms, more than 3 times that cost. With the final values, 2,000 files took 36.6 s, and 10,000 files took 166.5 s. The 10,000-file split: 16.3 s before step 1, 1.6 s for step 3, 40.8 s for the candidate with `update-index`, 98.7 s for the proofs, 3.5 s for step 7 with 5 status processes, and 5.5 s for reconciliation. Before the user decision, `update-index` with 10,000 files passed the 30-second deadline twice.
- N1, match in part: UI Automation reads the main instruction, the content, and the collapsed control. The details are not in the UIA tree while collapsed. Invoke on "Show details" makes them readable. The first focus is on "Not now", and Invoke on "Not now" returns `IDCANCEL` (hr 0). Enter and Escape are unverified, because they need live input (T082).
- N2, match in part: in the installed package, `IUIAutomationElement3::ShowContextMenu` on the current branch row opens the app menu (hr 0). A right-click and Shift+F10 are unverified, because they need live input (T082). The accessible name of a menu item includes its shortcut text, for example `Show only this branch's history Ctrl+Shift+B`. This breaks the rule of spec FR-085 that the name is the label only (plan D15 action menu, O-18).
- N3, match: the fixture merge tool runs inside the operation Job. The probe starts Git as `spawn.rs` does: a kill-on-close Job, a `JOB_LIST` and `HANDLE_LIST` attribute list, suspended, and `DETACHED_PROCESS`. Design change: plan D14 states that the shell starts the operation process through `spawn.rs`, not the service.
  - Open: under concurrent load, the tool start stalled in 2 of about 150 runs (plan O-19).
- N4, match: Cancel ends `git.exe`, `sh.exe`, `conhost.exe`, and the tool. No process remains (plan D14).
- N5, match: `SHOpenFolderAndSelectItems` returns hr 0 and selects the path.
- N6, match (2 of 2 lines, rerun of 2026-10-18 at 1cab2ad): `N6.plain` and `N6.allow` observe `foreground: true` and `idleMs: 0`, and `native-merge-tool.exe` holds the foreground at ready. So both variants came to the front with the desktop in use. The runs of 2026-10-17 gave 5 of 6. The failed run gave `foreground:false` for both variants on an idle desktop, while another process held the foreground. No evidence shows that `ASFW_ANY` is needed or helps. Design change: plan D14 drops the conditional `AllowSetForegroundWindow` call. O-8 stays open until the T082 live-input check.
- WSL run of 2026-10-21 (T081, `tests/wsl/workbench-wsl.test.ts`): Ubuntu-26.04, distro Git 2.55.0, f004-t081, committed as 0ac1739. The file passed 48 tests with 1 skip in 1,348 s and printed 204 `OBSERVATION T081` lines. The Windows builder made each fixture, and a `tar` stream copied it into the owned distro folder. F2 to F10, F13 to F15, F17 to F24, and F29 to F31 match. F11 (`@`), F12 (five contract-argv lines), and F16 (`wt-part`) give the same mismatches as on Windows, and the design already handles them.
  - F1, 63 of 66 lines match. Every argv of contract Δ3 exits as expected. The read is `check-ignore -z --stdin --no-index` without `--literal-pathspecs`. It does not read a stdin path that starts with `:` literally. The ignore lines `:x.txt` and `:(top)y.txt` match only the literal names. With the stdin paths `:x.txt` and `:(top)y.txt`, Git exits 1 and prints no path. So Git reads both as pathspec magic. The control paths `x.txt` and `y.txt` also exit 1.
  - F1 stdin forms, follow-up of the T081 review. Source: gitglossary(7) "pathspec", pathspec.c `parse_short_magic` and `init_pathspec_item`, builtin/check-ignore.c (Git v2.55.0). The forms ran on WSL Git 2.55.0 and on Windows Git 2.56.0.windows.2, with the same results. Each line is the stdin form, the exit, and the `-z` output:
    - `./:x.txt`: exit 0, `./:x.txt`. `./:(top)y.txt`: exit 0, `./:(top)y.txt`.
    - `:(top):x.txt`: exit 0, `:(top):x.txt`. `:(top):(top)y.txt`: exit 0, `:(top):(top)y.txt`.
    - `:/::x.txt`: exit 0, `:/::x.txt`. `:::x.txt`: exit 0, `:::x.txt`.
    - Controls: `::x.txt` exits 1 with no output, because it names `x.txt`. `:(literal):x.txt` exits 128, because check-ignore refuses every magic except `top`.
  - So four stdin forms name a path with a leading `:` literally. The contract gap of the first WSL run is void. Git prints the stdin form, not the matched path (check-ignore.c `pathspec.items[i].original`). So the reader must map each output record back to its candidate.
  - Possible plan D3 change: send each candidate as `./<path>` or `:(top)<path>`, and drop the `path` refusal for a leading `:`. Product code stays unchanged until the plan decides.
  - F31, match: the names with LF, CR, and tab are in the index after `add --pathspec-from-file=- --pathspec-file-nul`. C-quoted `hash-object --stdin-paths` lines give the index IDs of all three. Raw lines give the index IDs of the CR and tab names, so Git strips only a CR before the LF. The index bytes stay unchanged.
  - F21, match with `mergetool.fixture.trustExitCode=true` in the owned distro global file.
  - F21 without `trustExitCode`: git-mergetool--lib.sh `run_merge_cmd` (lines 341 to 343) touches `$BACKUP`, runs the tool, and calls `check_unchanged`. `check_unchanged` (line 144) decides by `test "$MERGED" -nt "$BACKUP"`.
  - F21 times, follow-up of the T081 review: the fixture tool recorded `stat --format=%.9Y` of both files inside its command. Both times were `1792544068.950922700`, and the `/bin/sh` (dash 0.5.12) `test -nt` gave false. Git then exited 1, kept stages 1 to 3, and left the original bytes.
  - With an empty standard input, `read answer || return 1` (line 152) fails the merge. Then git-mergetool.sh `merge_file` (lines 406 to 409) runs `mv -- "$BACKUP" "$MERGED"`. So Git puts the backup over the tool result (Git v2.55.0, the same lines in the distro copy).
  - User-visible limit: a merge tool without `trustExitCode` loses its result when `$MERGED` keeps the file time of `$BACKUP`. Git does this, not the service. Spec FR-096 lets the fresh read decide, so the path stays unmerged.
  - Plan D18 merge tool mode: a tool that opens `/dev/tty` gets exit status 2 from the open under `setsid --wait`. The run ends with `GIT_FAILED`, and the path stays unmerged.
  - After Cancel and after a simulated close while a tool runs, `pgrep` finds no tool process. No `arbareto-*` scope remains.
  - Contract Δ6 `fileAppend`: the `wslFiles` text in mode `append` creates an absent target, appends to an expected state, gives `stale` for a changed state, and gives `refused` for a link. `check-ignore` then matches the new lines.
  - Harness gap: the T206 double has no WSL `worktreeAdd` route and no WSL `append` or `destination` mode. So Add worktree through the service stays unverified on WSL, and the append case runs the Perl text directly without the wrapper. The shell has both routes (`src-tauri/src/process_requests.rs`, `src-tauri/src/wsl.rs`).
- Rerun of 2026-10-21 for the T081 review follow-up, on f004-t081 after 0ac1739. `tests/wsl/workbench-wsl.test.ts` passed 48 tests with 1 skip in 1,302 s and printed 212 `OBSERVATION T081` lines. `tests/git/workbench-facts.test.ts` passed 53 tests. The new `F1.colon.form` and `F21.untrusted-fixture-tool-times` lines above come from these runs. The other mismatches are those of the first runs.
  - The service double now forwards `XDG_CONFIG_HOME=<owned home>/.config` to WSL Git. `wsl.exe` ignores a `HOME` in `WSLENV`, so service WSL Git keeps the real `HOME`. The default ignore and attributes files now come from the owned home (git-config(1) `core.excludesFile`, `core.attributesFile`). Q15 checks it with an ignore line in the owned home.
- Not covered yet: every F and N fact has a test. These parts have no result: Add worktree through the service on WSL (T081 harness gap), Enter and Escape of N1, and the right-click and Shift+F10 of N2 (T082 live input).
- Not covered yet on WSL: the T081 service cases run a subset of Q5 to Q23. The Windows tests cover these parts, but no WSL case runs them:
  - Q8: a remote branch with two mapping refspecs.
  - Q9: the delete of a branch of another worktree, and a branch that moved after the review.
  - Q10: every merge option combination. Only Merge commit, a fast-forward, Squash, and the hook case run.
  - Q11: the force note for the push tracking ref.
  - Q13: the AU, UA, UD, and DD entries, and the symlink stage. Only UU, DU, and AA run.
  - Q15: a folder, all changes, one refused file, and an external change (`STALE_SELECTION`).
  - Q16: the added and removed hunks, and the refusals.
  - Q20: Open worktree, and the remove of a locked worktree and of the main worktree.
  - Q22: Not now, Stop trusting, and the version 1 record.
  - Q23: a refusal, the host line, Retry, and Cancel.

## R22 Batch 0 and 1 verification (T006, T020)

Run of 2026-10-18 in `C:\Projects\arbareto-l4` on f004-impl at 1cab2ad. One run serves T006 and T020. The batch 0 and batch 1 reviews are recorded ("Batch reviews").
- `bun install --frozen-lockfile`, `bun run export:schemas --check`, `cargo check --locked --manifest-path src-tauri/Cargo.toml`, and `bun run build:service`: exit 0.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml`: exit 0, 540 passed, 0 failed, 4 ignored.
- `ARBARETO_WSL_DISTRO=Ubuntu-26.04 ARBARETO_TEST_WORKERS=6 bun run test:all`: exit 0. Parallel group: 5,813 pass, 0 fail, 37 skip. Serial group: 453 pass, 0 fail, 9 skip. Every `ORIGIN` line is under `C:\Projects\arbareto-l4`. The 15 distinct skip reasons are capabilities.
- `bun run test:windows`: exit 0, 113 pass, 0 fail, 4 skip (`live-input` twice, `history-fixture-h1m` twice). Its `ORIGIN` lines name the installed package.
- `bun run typecheck`: exit 1 on 1cab2ad, TS2740 in `src/frontend/changes/FileControls.tsx`. Cause: after main merged into f004-impl, the `FileActionValue` filter in `src/contracts/envelope.ts` did not narrow its type. c2e803d fixes it with a type-only change. On c2e803d, `bun run typecheck` exits 0, and `bun test tests/contracts` with `portable-imports` gives 4,167 pass, 30 skip, 0 fail. The full run's typecheck was red. Only typecheck and the contract tests check the fix; no full run ran on c2e803d.
- T006 control mutation: the unmerged branch fixture with 1 commit made the T001 self-check fail (`branches`: 52 pass, 1 fail). After the undo, 53 of 53 passed.
- T020 control mutation: without the `[` escape in `src/contracts/ignore-line.ts`, `tests/contracts/ignore-line.test.ts` failed (8 pass, 1 fail). After the undo, 9 of 9 passed.
- Facts: "Results" holds each `OBSERVATION` line of this run with its mark (R21).

## R23 Batch 2 verification (T035)

Run of 2026-10-18 in `C:\Projects\arbareto-l4` on f004-impl at 00bf0b3. The batch 2 review is recorded ("Batch reviews").
- `bun install --frozen-lockfile`, `bun run build`, `bun run typecheck`, `bun run export:schemas --check`, and `bun test tests/contracts/groups.test.ts` (1 pass): exit 0.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml`: exit 0, 542 passed, 0 failed, 4 ignored.
- `ARBARETO_WSL_DISTRO=Ubuntu-26.04 ARBARETO_TEST_WORKERS=6 bun run test:all`: exit 0. Parallel group: 6,005 pass, 0 fail, 39 skip. Serial group: 466 pass, 0 fail, 9 skip. Every `ORIGIN` line is under `C:\Projects\arbareto-l4`. The 15 distinct skip reasons are capabilities.
- `bun run test:windows`: exit 0, 112 pass, 0 fail, 5 skip. Two UIA focus cases printed the `foreground` capability skip: owner pid 10616, lock timeout 2147483647, idle about 2.6 hours.
- Control mutation 1: the mutation removed the expected object ID from the `update-ref --no-deref -d` builder `deleteRefArgs` (`src/git-service/workbench-commands.ts:252`). `branch-ops.ts` builds its delete step with it. The moved-branch case and the F9 case of `tests/git/branch-ops.test.ts` failed (7 pass, 2 fail). After the undo, 9 of 9 passed.
- Control mutation 2: the mutation made `stashApplyArgs` (`src/git-service/workbench-commands.ts:228`) reapply by `stash@{0}`. `switch.ts` builds its reapply step with it. The two-earlier-stashes case and the SC-001/SC-002 case of `tests/git/switch.test.ts` failed (20 pass, 2 fail). After the undo, 22 of 22 passed.
- Earlier run, for context: a green run on 17aaa20, before the review fixes, gave 5,971/0/39 and 466/0/9, cargo 542 passed, and `test:windows` 112 passed.

## R24 Mockup board update (T036)

- Commit 4ac9b99 and the scratchpad `ux-004/` work did T036. The boards already had the correct keys, Switch, and Amend. The Submodules board shows the running rule. `ux-004/gen/check.mjs` is clean on all nine boards.

## R25 Batch 3 verification (T048)

Run of 2026-10-18 in `C:\Projects\arbareto-l4` on f004-impl at 00c9157. The batch 3 review is recorded ("Batch reviews").
- `bun install --frozen-lockfile`, `bun run build`, `bun run typecheck`, `bun run export:schemas --check`, and `bun test tests/contracts/groups.test.ts`: exit 0.
- `bun run test:all`: exit 0. Parallel group: 6,109 pass, 0 fail, 39 skip. Serial group: 520 pass, 0 fail, 9 skip.
- `bun run test:windows`: 112 pass, 0 fail, 5 skip. Two of the skips are the `foreground` capability skips.
- In every step, each `ORIGIN` repository root is under `C:\Projects\arbareto-l4`. The `test:windows` `ORIGIN` lines also name the installed app and its fixture copy, as in R23.
- `bun run test:contracts`: 4,394 pass, 1 fail. Cause: a `mock.module` of PatchView in another file reached `comparison-view.test.tsx` in the single-process run. 2f31806 fixes the leak. On 2f31806, `bun run test:contracts` gives 4,395 pass, 32 skip, 0 fail.
- Control mutation: the mutation let S act outside the diff (`src/frontend/keyboard/shortcuts.ts:143`). `tests/contracts/shortcuts-004.test.ts` failed (4 pass, 3 fail). After the undo, 7 of 7 passed.
- Earlier run, for context: a green run on eaf5f6f, before the review fixes, gave 6,095/0/39 and 513/0/9.

Screenshots on 2f31806: `bun run dev` with a scratch profile and a scratch repository. UI Automation and window messages drove the app, with no input. `PrintWindow(PW_RENDERFULLCONTENT)` made the images: `1-branch-switcher.png`, `2-branch-context.png`, `3-merge-panel.png`, and `4-commit-view.png` in the orchestrator scratchpad `t048/shots/`. Differences against the T036 boards:
- Branch list:
  - The filter has no search icon and no placeholder.
  - The Local and Remote headers show no counts.
  - The current branch has no check mark.
  - The list has no "Manage branches" row.
  - Ctrl+B is inline, not right-aligned.
  - The popover is about 600 px wide, not 380 px. It is anchored below the button, not right-aligned.
- Top bar:
  - The branch button has no ↑/↓ chips.
  - The worktree button is absent. Batch 5 adds it.
  - The menubar, Refresh, and the Commit icon are on a second row, not at the right end.
  - The repository button shows the full long path.
- Branch menu:
  - The items and the keys match.
  - The items have no icons, and the groups have no separators.
  - The Push reason is on a second line. The board puts it at the right of the same line.
  - A focus border surrounds the whole menu.
  - The menu covers its row.
- Merge panel:
  - The panel docks at full width.
  - The panel has no branch icon and no "Before" tag, and it has an extra × close.
  - The panel has an extra "Result" label and a `merge.ff` source line.
  - The options need scrolling.
  - The buttons are Merge then Cancel, left-aligned. The board has Cancel then Merge, right-aligned.
- Commit view:
  - The view has no Filter files box.
  - The help line is cut off in the sidebar and repeated in the diff pane.
  - The status letters are grey, not coloured.
  - The Staged block sits low, with empty space above it.
  - The message box has two columns, and the right part is empty.
  - Commit is not the primary button.
  - The view has no Author, Branch, and Staged summary.
  - The board says "Commit & push". The app says "Commit and push", which ASD-STE100 prefers.
  - The diff pane showed its empty state because no file was selected.

## R26 Batch 3 follow-up verification (T093)

Run of 2026-10-20 in `C:\Projects\arbareto-l7` on f004-impl at 180dbce.
- `bun run build` and `bun run typecheck`: exit 0.
- `bun run test:contracts`: exit 0. 4,708 pass, 33 skip, 0 fail. All 291 `ORIGIN` lines are under `C:\Projects\arbareto-l7`.
- Control mutation: in `src/frontend/changes/ChangesPane.tsx`, Stage all changes took only the rows that match the filter. `tests/contracts/workbench-commit.test.tsx` failed: 64 pass, 1 fail ("login shows only the rows whose path holds it, and Stage all changes still stages every change"). After the undo, 65 of 65 passed.
- Later: R27 records `bun run test:all`. "Batch reviews" records the independent review of T087 to T092 ("T093 review").

Screenshots: the R25 method. `bun run dev` ran with `ARBARETO_PROFILE_ROOT` in a scratch folder and a scratch fixture repository. UI Automation patterns, `IUIAutomationElement3::ShowContextMenu`, and window messages drove the app, with no input. `PrintWindow(PW_RENDERFULLCONTENT)` made the images. The display scale is 125%, so 1 DIP is 1.25 image pixels. The files are in the orchestrator scratchpad `t093-l7/shots/`. Results against plan.md D15 and D16:
- Top bar (`0-main.png`, `5-960-history.png`): one 40 DIP row at 1280 and at 960 DIPs width. The repository button shows "work". Its accessible name holds the full path. All R25 top bar differences are gone, except the ↑/↓ chips: the button shows "=", because the fixture branch has no ahead or behind commits.
- Branch list (`1-branch-list.png`, `5-960-branch-list.png`): 380 DIPs wide, with a search icon and the placeholder "Find a branch". The headings "Local branches 3" and "Remote branches 2" show Muted counts and are 26 DIPs high. The current row shows a check mark. "New branch…" shows Ctrl+B in a right-aligned Muted column. The list has no "Manage branches" row. The popover starts at the button start: the end alignment does not fit left of a button that ends at 279 DIPs, so the popover moves into the window.
- Branch menu (`2-branch-menu.png`, `2b-branch-menu-focused-item.png`): 28 DIP rows with 16 DIP icons, and separators between the three D16 groups. The Push reason is on the item line. The focus outline marks only the focused item. The menu opens beside the sidebar row, and the row stays visible.
- Merge panel (`3-merge-panel.png`, `5-960-merge-panel.png`): the 32 DIP head shows the Accent merge glyph, the title, and Close. The foot shows Cancel, then "Merge (Ctrl+Enter)", right-aligned. The content is taller than the cap, so the dock takes 60% of the work area (544 of 907 image pixels) and the content scrolls.
- Commit view (`4-commit-view.png`, `4b-commit-view-untracked.png`, `4c-commit-view-filter.png`, `4d-commit-view-no-match.png`, `5-960-commit-view.png`): Filter files is above the trees, with a search icon and the tooltip "Filter files (Ctrl+F)". The sidebar has no help line. The diff empty state shows it. M is Warning, A and ? are Added, and D is Removed. The Staged list starts directly below the splitter. "APP" matches `src/app` without regard to letter case. The headings and the status bar keep the counts of the status read. "zzz" shows "No file matches the filter.".
- Board differences that T087 to T092 do not cover: the merge panel keeps the "Result" label and the `merge.ff` source line, the message box has an empty right column, and Commit is not the primary button.
- At 960 DIPs width, the narrow file band shows about two rows, because Filter files takes one row of the 001 file band default.

Follow-up (T106), 2026-10-20, in `C:\Projects\arbareto-l7` on f004-t093-fu at 16faf8a. The Commit view now takes its layout from its own width (plan.md D16 "Geometry"). At 960 DIPs, the lists sit left of the diff in a 280 DIP lane (`t093fu-l7/shots/960-commit-view.png`), and Changes and Staged show all eight rows of the fixture. An `openWorktree` refusal `UNKNOWN_TARGET` shows the D15 worktree text. Each sidebar Worktrees row has a tooltip with its full accessible name. "No file matches the filter." sits in a `role="status"` region that is always present. The six new or changed cases failed before the fixes. One control mutation per fix turned its case red, and the undo turned it green again. `bun run typecheck` and `bun run build` exit 0. `bun test tests/contracts` gives 4,713 pass, 33 skip, 0 fail. `tests/git/portable-imports.test.ts` gives 23 pass. All 292 `ORIGIN` lines are under `C:\Projects\arbareto-l7`. Open: in the 960 DIP tray, the message help line overlaps the hook note of the right column.

Follow-up (menu focus), 2026-10-20, on f004-menu-focus at 347b89d: Shift+F10 and the Menu key on a sidebar branch, history, Worktrees, submodule, or Changes row now move the focus to the first menu item, also an unavailable one (spec FR-014). Base UI 1.8.0 focused the popup, because a menu without a trigger records no open method. A right-click keeps the Base UI popup focus.

## R27 Full run, 2026-10-20

Run of 2026-10-20 in `C:\Projects\arbareto-l4` on f004-impl at 8e6b82e. The run finished in two parts at this one commit. The logs are in the orchestrator scratchpad `full-004-l4b/` and `full-004-l4c/`.
- Part 1, 06:07 to 08:37: `ARBARETO_WSL_DISTRO=Ubuntu-26.04 ARBARETO_TEST_WORKERS=6 bun run test:all`. Parallel step: exit 0, 194 files, 6,523 pass, 0 fail, 40 skip. Serial step: 28 of 30 files ran with no failure.
- The driver timeout of 150 minutes then stopped part 1 inside `tests/wsl/submodules.test.ts`. The orchestrator sets this timeout. It is not a test failure. `bun run test:all` gave no exit code of its own.
- Every `ORIGIN` line of part 1 is under `C:\Projects\arbareto-l4`.
- Part 2, 08:41 to 09:10: the two serial files that part 1 did not finish ran as the serial step runs them, each in one `bun test` process with `ARBARETO_WSL_DISTRO=Ubuntu-26.04`. `tests/wsl/submodules.test.ts`: 13 pass, 0 fail. `tests/wsl/sync-wsl.test.ts`: 15 pass, 0 fail.
- `cargo test --locked` in `src-tauri`: exit 0, 553 passed, 0 failed, 4 ignored.
- `bun test tests/wsl/registration.test.ts` with `ARBARETO_WSL_DISTRO=Ubuntu-24.04`: 39 pass, 4 skip (`distro-git-2.55`), 0 fail.
- `bun test tests/windows`: 114 pass, 6 skip, 1 fail. The failure is `tests/windows/perf-fixtures.test.ts:88`: a cached M fixture kept its manifest but not its kept fast-import stream. This is 001 test setup, not 004 code. Main 95a9a1e fixes it (T164): such a fixture now rebuilds.
- Reruns at 559eaeb, after the menu focus fix 6ae2f87 and the main merge with 95a9a1e (`rerun-004-l4/`): `bun run typecheck` and `bun run export:schemas --check` exit 0. `bun test tests/contracts`: 4,726 pass, 33 skip, 0 fail. `bun test tests/windows`: 116 pass, 6 skip, 0 fail, and the perf fixtures are reused.
- Not in this run: `bun install --frozen-lockfile`, `bun run build`, `cargo check`, `bun run build:service`, `bun run dev`, and the control mutations of T062 and T076. No full run ran on 559eaeb.
- Memory finding: two earlier runs of the day stopped at the 4,500 MB memory guard. A failing DOM `toBe` in `tests/contracts/workbench-branches.test.tsx:410` made Bun 1.4.3 format a message of about 17 GB, and Bun then reported a pass (investigator, scratchpad `diag-004-l4/`).
- Main 8e29a33 gives DOM nodes a short inspect form in `tests/dom.ts`, so a failed DOM assertion fails fast and shows. 8950870 fixes the real defect: a key-opened row menu focuses its first item. 8e6b82e holds both commits.
- Review: "Batch reviews" records the T093 independent review of T087 to T092 ("T093 review"). It passed with follow-ups, and T106 fixes them (R26).
- Ticks from this run: T099 and T106.

## R28 Evidence records, 2026-10-20

Runs of 2026-10-20 in `C:\Projects\arbareto-l5` on f004-evidence at 14104a0, with the new cases of this section. Every `ORIGIN` line is under `C:\Projects\arbareto-l5`. After each undo, `git diff` of the mutated file is empty.

Control mutations:
- T096: one merge case of `tests/git/merge-rebase.test.ts` ran `git config merge.log true` after the run. The file failed (35 pass, 1 fail): the `.git/config` digest changed. After the undo, 36 of 36 passed.
- T100: without `aria-setsize` in `src/frontend/components/switcher-popover.tsx`, `workbench-branches.test.tsx` and `workbench-worktrees.test.tsx` failed (106 pass, 2 fail). After the undo, 108 of 108 passed.
- T101: Right did nothing in `src/frontend/history/HistoryList.tsx`. `workbench-branches.test.tsx` failed (52 pass, 2 fail). After the undo, 54 of 54 passed.
- T102: without `-w` in the Sublime Text command of `presets.ts`, `workbench-settings.test.tsx` failed (34 pass, 1 fail). After the undo, 35 of 35 passed.
- T104: the message field of `src/frontend/commit/CommitTray.tsx` ignored the stored draft. `workbench-worktrees.test.tsx` failed (53 pass, 1 fail). After the undo, 54 of 54 passed.
- T105: `src/git-service/branches.ts` kept `hasLocal`. The service harness schema check failed `tests/git/read-branches.test.ts` (1 pass, 4 fail). After the undo, 5 of 5 passed.

New cases:
- T097: `tests/git/workbench-busy.test.ts` adds the reverse order: a held `commit`, then a `runWorkbench` merge; a held `runWorkbench` switch, then a `runWorkbench` merge. Each second run gives `BUSY`, starts no Git process, and changes nothing. With the same-repository check of `src/git-service/exclusion.ts` removed, all 4 cases failed (`GIT_FAILED`, not `BUSY`). After the undo, 4 of 4 passed.
- T098: `tests/git/branch-ops.test.ts` adds Cancel for create, create with switch, and rename. `tests/git/worktrees.test.ts` adds Cancel for add with a new branch and prune. Each run is cancelled at its one Git step and at the first read after it. At the step, the result is `canceled` with no refs, and the state equals an untouched copy. After the step, the result is `succeeded`, the refs equal the refs that Git's own command changes on a copy, and the state equals that copy.
- T098 control mutations in `conclude` of `src/git-service/workbench-review.ts`: a canceled run reported `failed-with-effects`, and both new cases failed at the step half. A done run always reported `differing-effects`, and both new cases failed at the after half. After each undo, both passed.
- After the new cases: `bun run typecheck` exit 0. `workbench-busy`, `branch-ops`, `worktrees`, `tests/contracts/groups.test.ts`, and `tests/git/portable-imports.test.ts`: 59 pass, 0 fail.

Failing-first records:
- The ticked batches T006, T020, T035, and T048 record control mutations only. No ticked task of batches 0 to 3 records a failing-first run. The 004 commits hold each test file and its code in one commit.
- Method for this record: the tree of the parent commit, with `tests/` of the task commit, in a scratch folder (`git archive`). `node_modules` is a junction to the l5 copy. The l5 lock file only adds `ssh2` 1.17.0, a test dependency. Every `ORIGIN` line and every module path is under the scratch folder.
- This shows the tests red against the code before the task commit. It does not show the first version of the tests, because the commit holds the final version.
- T049, tests of 61e4ba6 on b424d61: `tests/git/worktrees.test.ts` fails at load. `src/git-service/worktrees` does not exist.
- T050, cfd5e92 on 118821a: `tests/git/git-settings.test.ts` fails at load. `src/git-service/git-settings` does not exist.
- T051, 1240846 on b424d61: `tests/git/trust-v2.test.ts` gives 0 pass, 11 fail.
- T052, 4f9da6f on b424d61: `tests/git/submodule-scope.test.ts` gives 10 pass, 13 fail.
- T053, 515dda1 on 118821a: `tests/git/resolve.test.ts` fails at load. `src/git-service/resolve` does not exist.
- T054, 3b1622a on e781ee7: `tests/git/commit-amend.test.ts` fails at load, because the service harness imports `ReadGitSettingsResult`, which e781ee7 does not export. This red does not test the amend code.
- T064, 5c1dbff on c73d655: `workbench-worktrees.test.tsx` fails at load. `src/frontend/worktrees/WorktreeActions.tsx` does not exist.
- T065, d1cf6bd on c73d655: `workbench-settings.test.tsx` fails at load. `src/frontend/settings/SettingsView.tsx` does not exist.
- T066, 0c32e3a on c73d655: `workbench-trust.test.tsx` fails at load. `src/frontend/trust/TrustChip.tsx` does not exist.
- T067, 22dd93e on c73d655: `workbench-submodules.test.tsx` fails at load. `src/frontend/submodules/SubmodulesGroup.tsx` does not exist.
- T068, 0380c82 on c73d655: `workbench-resolve.test.tsx` fails at load. `src/frontend/resolve/ResolveView.tsx` does not exist.
- T069, c62b42c on 2d19977: `workbench-amend.test.tsx` gives 5 pass, 7 fail.
- T092, fd5b63d on b424d61: `workbench-commit.test.tsx` and `shortcuts-004.test.ts` give 53 pass, 11 fail, 3 errors. The kept lines name 7 Filter files cases and 3 T091 cases of the same commit. They do not name the 11th failure. This tree has no short DOM form (R27), so the log grew to 1.8 GB.
- T094, a6f318c on 5850a95, with `tests/dom.ts` of 14104a0: the five contract files and `workbench-worktrees.test.tsx` give 1,443 pass, 33 skip, 28 fail. The failures are the `chooseWorktreeFolder` and Browse cases. The cargo tests of T094 did not run.
- T095, 516dc09 on 3e25b8f, with `tests/dom.ts` of 14104a0: the seven named files give 670 pass, 33 skip, 38 fail. The named failures are 29 vector cases, 1 DD side-name case of `workbench-resolve.test.tsx`, and 4 cases of `workbench-worktrees.test.tsx`. No case of `tests/git/worktrees.test.ts`, `tests/git/resolve.test.ts`, `workbench-amend.test.tsx`, or `commit-tray.test.tsx` is named, so this record does not show those parts red.
- T105, 0eadd40 on b1d72af, with `tests/dom.ts` of 14104a0: `workbench-contract.test.ts` and the four `tests/git` files give 113 pass, 6 fail. The failures are the field-free contract case and five service cases that compare the results without the removed fields.

## R29 Verification runs for T062, T076, and T093, 2026-10-20 and 2026-10-21

Three runs in `C:\Projects\arbareto-l4` on f004-impl. The logs are in the orchestrator scratchpad `verify-004-l4/`, `verify2-004-l4/`, and `verify3-004-l4/`. Runs 1 and 2 fail the T062, T076, and T093 pass condition. Run 3 at b35cdd0 passes it.

Run 1, 2026-10-20, at 51f9ab2:
- `bun install --frozen-lockfile`, `bun run build`, `bun run typecheck`, `bun run export:schemas --check`, `bun run build:service`, and `cargo check`: exit 0.
- `bun run test:contracts`: 4,740 pass, 33 skip, 0 fail.
- `bun run test:all`: exit 0 in 124 minutes. Parallel step: 6,547 pass. Serial step: 535 pass.
- `cargo test`: 553 passed. `bun test tests/wsl/registration.test.ts` on Ubuntu-24.04: 39 pass.
- Every `ORIGIN` repository root is under `C:\Projects\arbareto-l4`.
- `bun test tests/windows`: 115 pass, 6 skip, 1 fail. In the native facts, N2 failed: `ElementFromHandle` returned 0x800705B4, `HRESULT_FROM_WIN32(ERROR_TIMEOUT)`. The file alone then gave 4 pass, 0 fail.
- T062 `cmd` mutation: 14 pass, 1 fail. The red case was a D12 class case, not a Q14 case. Thus the run did not show the Q14 check red.
- T062 `rewritesUpstream` false: 5 pass, 6 fail; after the undo, 11 of 11 passed. T076 confirmation dialog skip: 17 pass, 1 fail; after the undo, 18 of 18 passed.
- T093 filtered Stage all: the first mutation form left 69 of 69 green. A second form gave 68 pass, 1 fail. After the undo, 69 of 69 passed.
- Memory: the bun.exe private-bytes samples are invalid, because each sample is 0.
- Verdict: fail, because of the N2 failure in `tests/windows` and the T062 `cmd` red on a D12 case.
- Fixes: main f0bc552 adds 0x800705B4 to the UIA retry set. f23aab9 adds a Q14 `cmd` case, and 2c507ca merges it.

Run 2, 2026-10-20 21:50 to 2026-10-21 about 01:30, at 97f4fbc, on a clean tree:
- `bun install --frozen-lockfile`, `bun run build`, `bun run build:service`, `bun run typecheck`, `bun run export:schemas --check`, and `cargo check`: exit 0.
- `bun run test:contracts`: 4,768 pass, 33 skip, 0 fail.
- 21:56 to 00:32: `ARBARETO_WSL_DISTRO=Ubuntu-26.04 ARBARETO_TEST_WORKERS=6 bun run test:all`: exit 1. Parallel step: 194 files, 6,574 pass, 40 skip, 1 fail. Serial step: 30 files, 536 pass, 9 skip, 0 fail. All 224 files ran, with 7,160 tests.
- All 1,865 `ORIGIN` lines of `test:all` are under `C:\Projects\arbareto-l4`.
- The failure: `tests/git/submodule-review.test.ts:775`, "a modules walk above 256 folders gives limit", after 45.5 s. It expected one `limit` refusal and received `[]`. The file alone then gave 76 pass, 0 fail.
- `bun test tests/windows`: 116 pass, 6 skip, 0 fail. Of its 28 `ORIGIN` lines, two are outside `C:\Projects\arbareto-l4`. They are the installed app `%LOCALAPPDATA%\Arbareto\arbareto.exe` (SHA d39f9131, the main 9a07799 package) and its fixture home copy (SHA b5d54c39).
- N1: 7 lines match. N2: the `app-menu-by-uia-show-context-menu` line gives `menu:false` and `match=false`. This line is an observation line by design, and it ran against the main package. N3, N4 (conhost seen), N5, and N6 match.
- `cargo test --locked`: 553 passed, 4 ignored. `bun test tests/wsl/registration.test.ts` on Ubuntu-24.04: 39 pass, 4 skip (`distro-git-2.55`).
- Skips in `test:all`: 15 skips print a SKIP reason. They are ssh-server 3, disposable-volume 2, history-fixture-h1m 2, other-account-owner 2, distro-git-below-2.55 2, fifo 1, restart-keeps-lingering 1, empty-locpath-hides-c-utf8 1, and two-test-distros 1. 34 skips print no reason line. Skips in `tests/windows`: display-off, live input 2, WSL distro unset 1, and history-fixture-h1m 2.
- Skip trace (scout, scratchpad `skips97.txt` and `skips51.txt`): all 49 skips have a cause, and 51f9ab2 has the same set. 36 platform skips print no SKIP line: 33 other-platform golden vectors (`vectors.test.ts:89`), 2 POSIX trust cases (`trust.test.ts:1730`, `:1799`), and 1 Linux pipe case (`bun-runner.test.ts:159`). 13 capability or WSL skips print SKIP lines. Two F15 SKIP lines are fixture notes, not skipped tests.
- Skip-count gap: 33 other-platform golden vectors skip. The 001 record (001 research.md:1902) and the 002 record (002 research.md:390) say 29. Thus 4 skips have no count in those records.
- Control mutations, each red and then green after the undo, with a clean tree after each:
  - T062 `cmd` (`trust.ts:398`): 14 pass, 2 fail. The Q14 case is red, and a D12 class case is also red. After the undo, 16 of 16 passed.
  - T062 `rewritesUpstream` false at three exits (`commit-review.ts:109,128,133`): 5 pass, 6 fail, with the FR-100 case red. After the undo, 11 of 11 passed.
  - T076 confirmation dialog skip (`CommitTray.tsx:225`, `confirmRewrite` kept): 14 pass, 4 fail. After the undo, 18 of 18 passed.
  - T093 filtered Stage all (`ChangesPane.tsx:160-161`, `query` in the dependencies): 69 pass, 1 fail (Q29). After the undo, 70 of 70 passed.
- Memory: the lowest free memory was 9,551 MB. The peak bun.exe size was 2,268 MB. The memory guard did not stop a step.
- Overlap: at 00:59, after `test:all`, the T081 agent ran `tests/wsl/workbench-wsl.test.ts`. The verifier gate waited for it.
- Verdict: fail, because `bun run test:all` gave exit 1.
- Cause (investigator, scratchpad `modwalk/`): a product defect. `reviewSubmodules` ran on the read scheduler with the 30 s total read deadline. 001 contracts operations.md:435 exempts it from that deadline. Under load, the walk review took more than 30 s and ended `failed` with `DEADLINE`. The test checked only the refusals, so it received `[]`. `readDeadlineMs: 3000` gives the same result.
- Fix: 001 T382, 294db02. Main 40818b3 merges it, and 0baf5ea merges main into f004-impl.

Second board comparison (T076), at 97f4fbc. The first comparison ran at 5a3b2f2.
- Fixed: T110, T111, and T114.
- T109 item (1) regressed. T112 item (5) is not fixed.
- 7 new blockers:
  - The top bar branch button at 960 and at 1024 DIPs.
  - At 960 DIPs in the Comfortable density, the sync reason overlaps History.
  - The Commit reason is cut, and it has no tooltip.
  - The worktree row branch is 0 px wide.
  - A branch row that another worktree holds cuts the branch name.
  - In forced colors, Submodules row 1 fails with a contrast of 1.48:1.
  - The History label "+4999" is clipped.
- Fixes: T115, T116, and T117. Open.

Work after run 2:
- T081 follow-up, 5e1d243 (merge 6a77e56): the WSL double sets `XDG_CONFIG_HOME`, because `wsl.exe` ignores `HOME` in WSLENV. Q7 asserts the WSL remedy. F1: four colon forms read literally on stdin on both hosts, so the F1 gap is void. F21: Git moves `$BACKUP` over a fast tool result. R21 lists the Q8 to Q23 parts that WSL does not cover yet. R21 has the details.
- T115 53cec58 (merge 4c0103a), T116 e9e0f1f (merge 582213b), and T117 4787e32 (merge 4a0a5af) fix the second board comparison findings.

Third board comparison (T076), 2026-10-21 at about 06:45, at 4436e44 (scratchpad `t076c-l4/`):
- Renderer proof: the page loaded `index-CSFjSzTx.js` from the l4 `dist`, build 4436e442.
- Fixed: T115 (1), (3), (4), and (5); T116 (1) to (5); T117 (1) and (2).
- Not reachable: T115 (2) and T112 (5), because the button always takes the full width.
- T109 to T114: no regression. Screenshots cannot check T113 (1), (3), (4), and (5), or T114 (2) to (5), (7), and (8).
- Contrast scan: 0 low pairs in 8 views. A control scan at threshold 21 failed, as expected.
- N1: the header wrap order. Decision: natural wrap. T118 puts the order into D15. N2: the tooltip edge in forced colors (T118). N3: during a run, the Submodules header shows "Up…", as D15 allows.
- Board-only differences: one more History label at 1280 (correct by 002 "Labels"), the Commit tray button order, the Submodules row icons, and the references filter placeholder.

T115 to T117 review, 2026-10-21: 2 Medium findings go to T118. "Batch reviews" records the review.

T118, f09c725 (merge b35cdd0): each worktree row mark keeps its first character and "…". In forced colors, a disabled button in a selected row shows GrayText on Canvas, and a tooltip gets the dialog edge. A virtual references tree shows an empty group text below its heading. Plan D15 "Top bar row" states the exact wrap order, and the 001 test title names the D15 rule.

Long-path investigation, 2026-10-21 (scratchpad `longpath/`):
- Git for Windows refuses an absolute path of 260 or more units without `core.longpaths` (mingw.c `handle_long_path`). A ref path is the root plus 17 units plus the branch name. Reads fail when the root plus the branch name is 243 or more units. Git cannot create the ref at 238 or more units.
- Discovery: `symbolic-ref -q HEAD` exits 128, so discovery gives `REPOSITORY_UNAVAILABLE`, as 001 operations.md:522 states. This is correct. Contract gap: the refusal has no reason, and the remedy `git status` exits 0.
- A worktree record with HEAD 000… and with neither a branch nor detached is the unresolved marker of Git. The app shows it as "Detached at 0000…". This is a defect, and T119 fixes it.
- `for-each-ref` drops the long loose ref and writes only a warning to stderr. This is a known limit.

Run 3, 2026-10-21 06:24 to 09:18, at b35cdd0, on a clean tree:
- `bun install --frozen-lockfile`, `bun run build`, `cargo check --locked`, `bun run build:service`, `bun run typecheck`, and `bun run export:schemas --check`: exit 0.
- `bun run test:contracts`: 4,779 pass, 33 skip, 0 fail.
- 06:30 to 09:00: `ARBARETO_WSL_DISTRO=Ubuntu-26.04 ARBARETO_TEST_WORKERS=6 bun run test:all`: exit 0 in 150 minutes. Parallel step: 194 files, 6,626 tests, 6,586 pass, 40 skip, 0 fail, in 3,416 s. Serial step: 31 files, 595 tests, 585 pass, 10 skip, 0 fail, in 5,599 s. All 225 files ran, with 7,221 tests, 0 fail, and 50 skip.
- All 1,883 `ORIGIN` lines of `test:all` are under `C:\Projects\arbareto-l4`.
- `bun test tests/windows`: 116 pass, 6 skip, 0 fail. Of its 28 `ORIGIN` lines, two are outside `C:\Projects\arbareto-l4`. They are the installed app `%LOCALAPPDATA%\Arbareto\arbareto.exe` (SHA d39f9131, the main 9a07799 package) and its fixture home copy (SHA b5d54c39).
- N2: the `app-menu-by-uia-show-context-menu` line gives `menu:false` and `match=false`. This line is an observation line by design, and it ran against the main package. N1 (7 lines), N3, N4, and N5 match. N6 `plain` and `allow` give `foreground:false` and `match=false`, with `foregroundOwnerAtReady` bun.exe and an idle time of about 29,600 s. In run 2, both N6 lines matched. The failed run of 2026-10-17 in R21 N6 had the same pattern: an idle desktop, and another process held the foreground. O-8 stays open until T082.
- `cargo test --locked`: 553 passed, 4 ignored. `bun test tests/wsl/registration.test.ts` on Ubuntu-24.04: 39 pass, 4 skip.
- Control mutations, each red on its named case and then green after the undo, with a clean tree after each:
  - T062 `cmd` (`trust.ts:398`): 14 pass, 2 fail. The Q14 case is red, and a D12 class case is also red. After the undo, 16 of 16 passed.
  - T062 `rewritesUpstream` false at three exits (`commit-review.ts:109,128,133`): 5 pass, 6 fail, with the FR-100 case red. After the undo, 11 of 11 passed.
  - T076 confirmation dialog skip (`CommitTray.tsx:225`): 14 pass, 4 fail, with the named case red. After the undo, 18 of 18 passed.
  - T093 filtered Stage all (`ChangesPane.tsx:160-161`, `query` in the dependencies): 70 pass, 1 fail (Q29). After the undo, 71 of 71 passed.
- Skips: one new skip against run 2. `tests/wsl/workbench-wsl.test.ts:1648`, Q20 FR-052 "Add worktree in a WSL repository", is a static `test.skip` with the SKIP reason `wsl-worktree-add-route` (T081). 0ac1739 adds the file.
- Memory: the lowest free memory was 9,975 MB. The peak bun.exe size was 2,304 MB, in `test:contracts`. The memory guard did not stop a step.
- Deviation: the first `test:all` start did not read the environment variables and started no test.
- Not in this run: the `bun run dev` board comparison, screenshots, live-input steps, and reviews.
- Verdict: the agent-runnable pass condition of T062, T076, and T093 holds at b35cdd0.

Open items:
- The Remove dialog cannot show the branch-delete note at once. The facts come only after a review with `deleteBranch` true, so this needs a contract change (T110 skip).
- FR-061: a pending "Not set" choice for a key that the scope sets shows no note until Save.
- The perf fixture stream digest gap.
- The host-lines box of `SubmodulesGroup` keeps `overflow-y-auto`. It is not changed.
- `tests/windows` ran against the main 9a07799 package. Batch 7 records N1 to N6 again with a 004 package.
- F1: plan D3 can send candidates as `./<path>` or `:(top)<path>` and drop the `path` refusal for a leading `:`. This is a feature 005 leftover. The product does not change.
- Q7: the WSL remedy text says "This command applies them again.", but the command is null (a text-only remedy). This text defect is a feature 005 leftover.
- T081 M4: the dedupe of the 650 repeated lines of the WSL and Windows facts tests is deferred.
- During a run, the Submodules header shows "Up…" at 1280, because Cancel takes the room. The tooltip shows the full text (T116).
- At 720×480, the Commit message field is about 9 DIP high, and the reason lines sit inside the tray scroll. Run 2 shows the same. This is pre-existing, and the 001 constrained sizes apply.
- Feature 005 candidates from the long-path work: a discovery refusal reason after exit 128 (`symbolic-ref --no-recurse`, `show-ref --exists`, a shell allow-list). The silent `for-each-ref` drop stays a known limit.
- Board-only: the Submodules board shows done and running icons and a progress bar. The app shows only the submodule icon.

Process deviation, 2026-10-21, at about 02:13: the board-comparison agent opened `C:\Projects\arbareto` in the dev app for about one minute. An empty picker path caused it. `git status` of that checkout stayed clean, and it had no `index.lock`. The times of `index`, `HEAD`, and `config` are older than the open. The fix preamble now requires a path check before each open.

Task records for the tick audit:
- T111 plan-rule checks (2026-10-20, T111 agent): (A) the worktree ask after Not now from the trust chip does not break plan.md D15 "Trust texts". A canceled chip ask records `declined`, and every later `askTrust` returns false until the repository changes. A temporary probe (chip Not now, then Remove worktree) sent 1 `approveTrust` and 1 `reviewWorkbench`, so nothing asked a second time. (B) The Submodules header during a run does not break D15 "Header". Every submodule progress event carries `rowIndex` and `rowCount` (`src/contracts/submodules.ts`). Board shot 44 was taken before the first event, while the Run confirmation still waited. With no counter yet, the header shows no count.
- T112 (3) check (2026-10-20, T109 agent): the "Stage all changes is unavailable" line wraps in full. Only the scroll edge of the Changes list cuts it, with about 74 DIP visible at 1280×800, as 001 plan.md "Constrained sizes" allows. No change.
- T115 (5) check (2026-10-21, T115 agent): 960×800 Comfortable uses the constrained profile. The file band gets the Working changes minimum of 118 DIP, room for one help line and one row. The "Stage all changes is unavailable" line wraps to 3 lines, so the band scrolls. The T112 (3) rule covers this case. No change.
- Deviation, before screenshots: T112 has no before shot at 720×480 and no 1280×800 before shot during a merge (`scratchpad\t112-l7\`). T115 has no before shot at 1024×640 Comfortable with and without a merge, at 1024×640 Compact without a merge, or at 960×800 Comfortable without a merge. The second board comparison (`t076b-l4\shots\`) and the T115 crops give the before state for the other sizes. The third board comparison at 4436e44 checks the after state at all sizes.

## Batch reviews

Each batch verification task passes only after one independent review of its batch is recorded here.

**Batch 0, 2026-10-18.** Independent batch 0 review, reviewer agent, 2026-10-18. Scope: the fact tests and the fixture builder (T001 to T005). Verdict: fix first. Items: F1 did not run every contract argv; some T005 skips printed `SKIP`, not `unverified`; some checks could not fail; one Git process ran outside the isolated environment; a leftover tool was only logged; the fixture cache was reused by key alone. Suspicions: the WSL `:` candidate path, an N4 PID reuse, and the 001 `acquireLock`. Resolution: fe8f75f fixes all items and suspicions, and 6262511 merges it. The `:` rule refuses with reason `path`.

**Batch 1, 2026-10-18.** Independent batch 1 review, reviewer agent, 2026-10-18. Scope: WP4 to WP6 (T007 to T019). Verdict: no blocking finding and no heuristic. Medium: a registered run could do `worktree add`, and also `clone`. Low: the `exclude` target must be exactly `info/exclude`; the IPv6 scp host; `urlHost` for custom schemes; hard links on append targets. Lean: one `latin1`. Resolution: e357520 fixes all items.

**Batch 2, 2026-10-18.** Independent batch 2 review, reviewer agent, 2026-10-18. Scope: d8a3755..17aaa20 (WP7 to WP10, T021 to T034). Verdict: no data-safety or security defect.
- Medium, fixed in e42c49a: two command-line checks measured `selectedPath`, not the started `executablePath`. One `stepUnits` helper now measures both.
- Duplicates merged in e42c49a: `refTarget`, `readWorktrees`, `oidList`, and `revCount`.
- Suspicions settled in e42c49a:
  - The moved-branch list follows Git's update-refs selection (sequencer.c).
  - Git's merge and rebase never recurse into submodules (submodule.c:203). A test shows it.
  - `rebase.backend=apply` without Autosquash refuses with `apply-backend`.
  - A duplicate run of one token gets the repeat answer.
  - An included branch configuration refuses with `config-in-include`.
  - End signals replace two timing waits in tests.
  - The ignore review needs no gate.
  - The minimum Git 2.55 is above 2.44, which `--autosquash` needs.
- Earlier fixes during the batch, from the WP7 to WP10 reports:
  - Track needs exactly one mapping refspec (25c09f0).
  - Squash with `merge.ff=false`, `mergeoptions`, and the status headers (1f223f1).
  - Parallel exact proofs, the user's O-17 choice (7ee3d86).
  - One reply for each `fileAppend` (94b5dba).
- Open: the "may move" list cannot see a branch that another worktree rebases (contract gap, plan D6).

Open: the merge tool start stall (plan O-19, R21 N3). bd077e1 adds its diagnostics: the N3 test records each stall as a `match=false` finding with Git output, `GIT_TRACE`, and the Job members.

**Batch 3, 2026-10-18.** Independent batch 3 review, reviewer agent, 2026-10-18. Scope: f388750..eaf5f6f (WP11 to WP14, T037 to T047). Skills: `ponytail-review`, `web-design-guidelines`, and `arbareto-ux`. Verdict: fix first.
- Medium: a re-review that the user did not see could switch to Discard.
- Medium: S and U acted outside the diff body.
- Medium: `aria-setsize` and `aria-posinset` were missing.
- Medium: the counts were recomputed for each progress event.
- Medium: the IME guard was dead code.
- Resolution: 0769649 fixes the five Mediums, the Low items, and the suspicions (focus after Close, the stale notice, and the Segmented control height). 00c9157 merges it.
- Open: the renderer does not validate review results at run time, because `portable-imports` forbids zod in the renderer (contract gap).
- Open: on a History row with several branch labels, the keyboard reaches only the menu of the first label.

**Batch 4.** Independent batch 4 review, reviewer agent. Scope: WP15 to WP20 (T049 to T061). Verdict: trust v2 holds. No Critical or High finding. Fix the Amend unknown-upstream gap before qualification.
- Fix check, 2026-10-19: the batch 5 reviewer found that all 7 fixes pass.
- Open: one strict UTF-8 decoder covers only the three files that the fixes touched. About 20 module copies remain.

**Batch 5 start exception, 2026-10-19.** Batch 5 started before T062, because the batch 4 service contracts were merged and stable. T062 still gates the ticks.

**Batch 5, 2026-10-19.** Independent batch 5 review, reviewer agent, 2026-10-19, at 32e7771. Scope: WP21 to WP25 and WP29 (T064 to T075). Verdict: approve after fixes. No Critical or High finding. 5 Medium and 6 Low findings. The integration pass fixes them.

**T093 review, 2026-10-20.** Independent T093 review, reviewer agent, 2026-10-20. The review was read-only and ran no command. Scope: T087 to T093 on f004-impl at 16faf8a. It covers the fidelity merges 118821a (fd5b63d) and 37226cf (89fb32c), their callers in `Workbench.tsx`, `profiles.ts`, `requests.ts`, `WorktreeButton.tsx`, and `WorktreesGroup.tsx`, and the T093 screenshots at 1280 and 960 DIPs (R26). Skills: `ponytail-review` (no must-fix item), `web-design-guidelines` (the `src/frontend` changes of these merges), and a manual correctness, security, no-heuristics, keyboard, and accessibility review. Verdict: pass with follow-ups. No finding blocked the ticks of T087 to T093.
- Medium: a picker context counted its 60 s age from a time before the picker opened (`src-tauri/src/service.rs`, `dialogs.rs`). Main a747ed7 fixes it (001 T060).
- Medium: at 960 DIPs, the Commit view showed about two file rows. T106 fixes it.
- Low, fixed in T106: an `openWorktree` refusal `UNKNOWN_TARGET` showed the raw code. A cut sidebar Worktrees row had no tooltip. "No file matches the filter." was not a status region. D16 did not state the fallback of the branch list alignment.
- Lean, not done: the DOM lookup of the Ctrl+F "Find a setting" field, and `filterTarget`.
- Suspicions checked in T106: F6 on Filter files is not a defect, because D15 names the stop "Changes". The filter does not stay after a repository switch.
- Not checked: a row menu beside a full-width row.
- Later fact: the test at `tests/contracts/workbench-branches.test.tsx:404-411` failed, but Bun reported a pass (R27 memory finding). The review could not see this failure. 8950870 and 6ae2f87 fix the menu focus.

**Batch 5 rerun, 2026-10-20.** Independent batch 5 review by the reviewer agent at 4c7d284 (`f004-impl`). Base: c73d655, the batch 4 wiring merge, which is the parent of the first batch 5 commit 5c1dbff. Scope: the diff from c73d655 to HEAD for `src/frontend/{worktrees,settings,trust,submodules,resolve}/*`, `commit/CommitTray.tsx`, `app/Workbench.tsx`, `app/RepositoryMenu.tsx`, `components/{action-menu,switcher-popover}.tsx`, `refs/ReferencesSidebar.tsx`, `tests/dom.ts`, and the six `tests/contracts/workbench-{worktrees,settings,trust,submodules,resolve,amend}.test.tsx` files. The scope includes T094, T095, T096 to T106, 8950870 and 6ae2f87. Skills: `ponytail-review` on the scope; `web-design-guidelines` (fetched 2026-10-20) on the UI files; `arbareto-ux` for the rules. The manual review checked correctness, security, no heuristics, keyboard and accessibility against plan.md D15 and D16. Verdict: pass with follow-ups. No Critical or High finding. 3 Medium findings block ticks. 5 Low findings do not block. The result paragraphs "Batch 5 rerun review, 2026-10-20" and "T107 follow-up, 2026-10-20" below record the test results.
- Medium, blocks T094, fixed in T107 (0797bc6): `AddWorktreePanel.tsx:98-100`. Browse before a branch name gives the picked parent itself as the folder. The folder then stays fixed after the user types a name.
- Medium, blocks T070, fixed in T107 (0797bc6): `WorktreeActions.tsx:186-192` with `RemoveConfirm:296-302`. A succeeded `worktree-remove` review with a token and no `plan` makes Remove available with no counts.
- Medium, blocks T071, fixed in T107 (0797bc6): `GitSettingsPage.tsx:119-124`. A succeeded `config-save` review without `plan.changes` becomes `[]`, and Save runs. The T107 follow-ups (5dac6be) also refuse a plan entry of unknown form.
- Low, fixed in T107 (0797bc6): `ResolveView.tsx:180`. A token without a plan shows nothing.
- Low, keyboard, fixed in T107 (0797bc6): `SubmodulesGroup.tsx:423`. Host-line Cancel leaves focus on `body`.
- Low, accessibility, doc change in T107 (0797bc6): `SubmodulesGroup.tsx:519-548`. Retry and Show output sit inside a `treeitem` with `tabIndex={-1}`; the row menu gives the same actions. Plan.md D15 now names the row menu path.
- Low, copy, fixed in T107 (0797bc6): counts without thousands separators at `WorktreesGroup.tsx:72`, `SubmodulesGroup.tsx:382,385,391,459`.
- Low, suspicion, decided as a defect and fixed in the T107 follow-ups (5dac6be): `GitSettingsPage.tsx:241-243`. The boolean note "Not set here. …" shows also when the selected scope sets the key. D15 did not say when the note shows. D15 now says so.
- No-heuristics check: no decision reads English message text or a substring of Git output.
- Security: no `innerHTML`, `eval`, or shell text in the scope.
- Test check: all six batch 5 test files call `registerDom()`. No skipped tests, no optional-chained clicks, no expects inside conditions.
- `ponytail-review`: no lean finding.
- Open for T076: the `bun run dev` board check: worktree button, worktree list, sidebar Worktrees group, Add worktree panel, Remove dialog, Settings view, trust chip, Submodules group, resolve view, amend box; light, dark, forced colors, both densities, focus outlines.

**Batch 5 rerun review, 2026-10-20.** Independent reviewer, at 4c7d284. Scope: batch 5 after the integration fixes. 3 Medium, 3 Low, and 1 doc finding. T107 fixes them. Medium: Browse… before a branch name set the bare parent as the folder; a `worktree-remove` review and a `config-save` review without a plan made the action available. Low: a resolve review without a plan showed nothing; host-line Cancel dropped the focus to the page; the group counts had no thousands separator. Doc: plan D15 now names the row menu path for Retry and Show output. Result: 8 new contract cases failed first and pass after the fixes. One control mutation per fix turns its case red. `bun test tests/contracts` gives 4,734 pass and 0 fail, and the typecheck, the build, and `tests/git/portable-imports.test.ts` pass. Decided after the review: the Settings boolean note "Not set here. …" shows only when the selected scope does not set the key. The T107 follow-ups fix it, and plan D15 says so (e67cd0c).

**T107 follow-up, 2026-10-20.** Update anyway of a submodule host line now moves the focus to Update submodules. A `config-save` plan entry of unknown form now gives the "Malformed result" text, reads again, and runs nothing. The boolean note "Not set here." now shows only when the selected scope holds no entry for the key; plan D15 says so. 6 new contract cases and 1 changed case failed first, and one control mutation per fix turns its cases red. `bun test tests/contracts` with `tests/git/portable-imports.test.ts` gives 4,763 pass and 0 fail, and the typecheck and the build pass.

**Menu focus follow-up, 2026-10-20.** The 002 current-branch menu of `refs/ReferencesSidebar.tsx` now uses `ActionMenu`, so Shift+F10 and the Menu key focus its first item (plan D15 "Action menu"). The other key-opened row menus already pass `byKey`.

**Batch 4 rerun, 2026-10-20.** Independent batch 4 review, reviewer agent, 2026-10-20. Scope: 118821a..4c7d284, the T049 to T061 service, contract, and shell files at HEAD with the fixes 2d19977, 5850a95, c4a6a32, cdece9f, b1d72af, and 95c9fd1. Skills: `ponytail-review`, and a manual correctness, security, and no-heuristics review of the trust, resolve, worktree, settings, submodule, and amend code. `web-design-guidelines` did not run, because the scope holds no web UI. Verdict: pass with follow-ups. No data-loss defect. The result paragraph "Batch 4 rerun review, 2026-10-20 (T108)" below records the fixes and the test results.
- Medium, blocks T060, fixed in T108 (a41849a): `trust.ts` takes the `merge.tool` value as the program name, but Git runs the program of `translate_merge_tool_path` for a built-in tool, so the PATH rule checks the wrong name. Fix: decide by the PATH entries, and record the contract gap in plan.md D12.
- Low, fixed in T108 (a41849a): the amend token binds `rewritesUpstream` but not the upstream name (contract gap, data-model §2).
- Low, fixed in T108 (a41849a): remove the "ORIGIN absent" scaffolding from 7 test files.
- Suspicion, recorded in T108 (a41849a): host lines do not apply `insteadOf` (contract gap, plan.md D13).
- Suspicion, checked in T108 and not a defect: the Stop trusting BUSY check runs only at acceptance. Only the contract delta sentence changed (a41849a).
- No batch 4 test asserts on DOM nodes, so the 8e29a33 case does not apply.

**Batch 4 rerun review, 2026-10-20 (T108).** Independent review at 4c7d284. Fixes in `C:\Projects\arbareto-l6` on f004-b4-fixes. Medium: a global `merge.tool=bc` without `mergetool.bc.path` ran a repository `bcompare.exe` through an absolute `PATH` entry without approval. git-mergetool--lib `get_merge_tool_path` runs the `translate_merge_tool_path` output (Git 2.56.0.windows.2, lines 478 to 505), and `mergetools/bc` gives `bcomp` or `bcompare`. Now any relative entry or any entry inside the roots needs the class `mergetool` (plan.md D12). Low: the amend token now binds the upstream. A `.git/remotes/origin` `Pull:` line changes the upstream without a configuration change, so the confirmed amend ran before the fix. A configuration change gives `TRUST_CHANGED` first. Lean: the seven "ORIGIN absent" blocks are gone. Doc: D13 records the `insteadOf` gap, and contract Δ7 records the revoke `BUSY` rule. Each new case failed with its fix undone and passed with it. Checks: typecheck, schema check, `tests/contracts` (4726 pass, 0 fail), and ten `tests/git` files (267 pass, 2 fail). The 2 failures are the `trust.test.ts` "bare-name lookup" cases. They fail the same way with the trust.ts of 14104a0.

**T109 to T111 review, 2026-10-20.** Independent reviewer at 58cc755 (T109, T110, T111, range 2c507ca..58cc755). Skills: `ponytail-review`, `web-design-guidelines`, `arbareto-ux`, and a manual correctness, no-heuristics, keyboard, accessibility, and forced-colors review. No Critical or High finding. Medium: SaveRow shows an enabled Save after a failed settings read, and the click does nothing (GitSettingsPage.tsx SaveRow); T113 gives Save the read reason. Medium: plan.md D15 "Top bar row" says the controls never wrap, but its new last sentence and the 001 header model wrap them; T112 limits the first rule to one header row. Low: the Commit trust reason is chosen by text equality (T113); the scope file tooltip cannot open by keyboard (T113); the switcher text move also changes the branch list (T113 plan text); the Submodules collapse test does not check the host lines (T113). Lean: `wraps` can be a required prop (T112). The keyboard model, focus outlines, forced-colors pairs, the trust dialog shield icon, and the new tests passed review. Fixes: T112 8de9b33 (merge e32f5a1), T113 3d38d50 (merge 4b7cbfb).

**T381 merge, T112, T113 review, 2026-10-20.** Independent reviewer at 4b7cbfb (range 58cc755..4b7cbfb). Skills: `ponytail-review`, `web-design-guidelines`, `arbareto-ux`, manual review. High: in the constrained profile a collapsed References section unmounts the Submodules group, so a host line or refusal from the menu or the notice band waits unseen. Medium: plan D15 "Top bar unavailable reasons" does not name the reconcile reason; Save gives the read loading or failure reason only in the tooltip. Low: the branch, Fetch options, and Pull menus show quiet reasons as visible text; the toolbar puts the reconcile reason before the unknown-state reason; the expanded constrained section has two nested scrollers; the Submodules Update focus target is found by its English label. T114 fixes them (6cede43, merge 97f4fbc).

**T081, 2026-10-21.** Independent T081 review, reviewer agent, 2026-10-21. Scope: 97f4fbc..0ac1739 (`tests/wsl/workbench-wsl.test.ts`, the `distroGitHost` move, `wslGlobalConfig` in `service-harness.ts`, R21). Skills: `ponytail-review` and a manual correctness, security, and heuristics review; `web-design-guidelines` was not used, because the diff has no UI code. Verdict: no data-safety, security, or heuristic defect, and the moves are behaviour-neutral. Medium: service WSL Git processes keep the real `HOME`, so `~/.config/git` ignore and attributes files apply; Q7 logs the WSL remedy command instead of asserting the 003 Δ3 / 001 §11 form; R21 does not list the Q5 to Q23 parts with no WSL case; F1 to F31 repeat about 650 lines of `workbench-facts.test.ts` instead of sharing a `GitHost` form. Low: the copied repositories keep `core.filemode=false`; the F21 cause rests on message text and an unverified timestamp; small duplicate helpers; a conditional trust approval in Q23; long R21 sentences. The `trustExitCode` choice is sound. Record its user-visible limit. Suspicions: `./:x.txt` or `:(top):x.txt` may be a literal stdin form, which would void the F1 gap; the tty result may not come from `setsid`; Git may restore the backup over a fast tool's result. Fixes: the T081 follow-up commit on f004-t081 after 0ac1739. M4 stays open.

**T115 to T117 review, 2026-10-21.** Independent review of T115 to T117 (`bf5cd04..4436e44`), reviewer agent, 2026-10-21. Skills: `ponytail-review`, `web-design-guidelines`, `arbareto-ux`, and a manual correctness, accessibility, forced-colors, and heuristics review. Fix two Medium findings first. A worktree row with a long name clips its marks completely with no "…" (`WorktreeButton.tsx:92-106`). In forced colors, a disabled Submodules Retry in a selected row looks enabled, because `.list-row[aria-selected="true"] button` overrides the GrayText rule (`index.css:490`). Low: a virtual references tree still shows empty texts after the tree; the new cases mostly check class names; a 001 test title is stale; T115 (3) and (5) need screenshots. No heuristics and no over-engineering. Fixes: T118 (f09c725).
