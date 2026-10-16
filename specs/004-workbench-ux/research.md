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
- Facts: `fileFacts` without link following (001 §6). A file, link, or folder at a candidate that the index does not hold at stage 0 with the same bytes counts. A folder where the target writes a file counts.
- Ignored files: `check-ignore -z --stdin --no-index` removes ignored candidates. Git treats ignored files as replaceable, and the spec Assumptions accept that.
- Bound: 20,000 candidate paths (`DISCARD_CHECK_PATHS`). Above it, Discard is unavailable with the limit.
- Case folding on Windows can make the check refuse a case that Git allows. This is a superset, so it never lets a loss through.

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
- Reflog: Git deletes the branch reflog (R5). Only the HEAD reflog of a worktree can keep the tip. `reflog exists HEAD` exits 0 when it exists (doc). `log -g -z --format=%H HEAD --` lists its entries; the 001 `reflogArgs` already reads this log (code). The read stops at 10,000 entries (`REFLOG_SCAN_ENTRIES`). A tip that the read does not reach gives the "No reflog keeps" text. That text can be too strict, but it never claims a recovery that does not exist.
- Alternatives considered: `branch --merged` output as Git Extensions does (it counts only HEAD ancestry, not other refs).

## R7 Merge

- Decision: `merge --no-autostash --no-edit [--no-ff] [--squash] [--no-commit] [--no-log -m <message>] --end-of-options <ref>`.
- Counts: `rev-list --left-right --count HEAD...<oid>` (doc). Fast-forward: `merge-base --is-ancestor HEAD <oid>`, exit 0 true and 1 false (doc).
- Message preview: `merge_name` writes `<oid>\t\tbranch '<name>' of .` for a local branch (source, recalled; DeepWiki did not return that function). `fmt-merge-msg` formats a merge message from such lines (doc). F12 checks equality with Git's own message, `merge.log`, and the " into <branch>" suffix.
- `-m` with `merge.log` true appends a shortlog to the given message, and `--no-log` stops it (source, t7600). So the app sends `-m` only for an edited message, together with `--no-log`.
- `--squash` with `--no-ff` is refused, and `--no-commit` still fast-forwards (doc, source).
- `--no-autostash`: 003 N-4 keeps the app from adding an autostash to merge.
- Alternatives considered: always `-m` with the preview (a preview mismatch would change Git's message).

## R8 Rebase counts and options

- Decision: moved count `rev-list --count --right-only --cherry-pick --no-merges <oid>...HEAD`; rewritten count `rev-list --count <oid>..HEAD`; held count by `--not --remotes`; force note by `--not <T>` of the 003 push tracking ref.
- Rationale: `sequencer_make_script` walks `upstream...orig_head` with `right_only`, `cherry_mark` unless `--reapply-cherry-picks`, and `max_parents=1` unless `--rebase-merges`, and drops PATCHSAME commits (source). With an explicit upstream, the default is `--no-fork-point` (doc, git-rebase(1)). Empty commits can make the counts differ (source note), so F13 compares the count with the commits that Git's own rebase creates.
- Options: the argv always passes the explicit Autostash and Autosquash forms, so Git does what the check boxes show. F15 records whether `rebase.autoSquash` affects a non-interactive rebase on Git 2.55 and 2.56 (unverified; Git 2.44 enabled `--autosquash` without `-i`).
- Moved branches: `rebase.updateRefs` moves local branches whose tips lie in the rewritten range (doc, git-rebase(1) `--update-refs`). `for-each-ref --merged=HEAD --no-merged=<oid> refs/heads` lists those tips. F16 compares the list with Git's own result.
- Dirty tree: Git refuses a rebase with tracked changes unless `--autostash` (doc). F14 confirms it on both Git versions.

## R9 Conflict resolve and merge tool

- Choose a side: `checkout --ours -- <path>` and `checkout --theirs -- <path>` check out stage 2 or 3 of an unmerged path, and the path stays unmerged (doc, git-checkout(1)). During a rebase, the sides swap (doc). The file checkout runs `post-checkout` with flag 0 (doc, githooks(5)). It can run smudge filters and write the index, so the `workbench` class applies (F19 records `post-index-change`).
- Merge tool: `mergetool --tool=<tool> --no-prompt -- <path>` (doc, git-mergetool(1)). The script writes the stage files with `checkout-index`, runs the tool, and runs `git add` when the tool reports success. Without a trusted exit code, it asks on its terminal; empty standard input ends that question as "no" (unverified; F21). The documentation defines no exit status, so a fresh index read decides (spec FR-096).
- `mergetool.keepBackup` and `mergetool.<tool>.trustExitCode` stay unchanged (spec FR-093).
- Merge drivers: gitattributes(5) "Defining a custom merge driver" runs `merge.<driver>.driver` for a path with `merge=<driver>`. Merge, rebase, and stash apply run it. 001 trust discovery lists no merge driver (001 contract §7 "Trust discovery includes …"). D12 adds it.

## R10 Multi-file staging

- Decision: the 001 `applyFile` candidate path with a path list: `update-index --add --remove -z --stdin`, one verification, one publication.
- Rationale: FR-036 and FR-039 bind the action to the shown read. `add -- <folder>` stages every current file under the folder, also files that the read did not show. It also writes the canonical index without the candidate check. `add --pathspec-from-file` has the same canonical-index issue.
- Proof A batch: `cat-file --batch --filters` needs `<object> <path>` per input line; Git splits at the first white space and skips the run of white space (source). So a path that starts with white space takes the single-file proof A. F26 checks the `-Z` form.
- Bound: 10,000 files and 512 MiB. The 512 MiB value is the 001 streamed input bound (`STREAMED_PROCESS_INPUT_BYTES`, code). P9 records the time of a 10,000-file action.

## R11 Line staging

- Decision: the service builds one sub-hunk from the retained hunk and the renderer's line ordinals. The 001 pipeline applies and verifies it.
- Stage (index to working file, applied forward): an unselected `-` line becomes a context line, and an unselected `+` line goes. Unstage (HEAD to index, applied with `--reverse`): an unselected `+` line becomes a context line, and an unselected `-` line goes. The old count is context plus `-` lines; the new count is context plus `+` lines. This is the line edit that `git add -p` allows (unverified source name, add-patch.c).
- Starts: the old and new starts of the retained header stay. 001 already applies one hunk of a multi-hunk diff with its original header (code, `prepareCandidate`). A side count of 0 takes the start of the line before, as xdiff writes it.
- No `--unidiff-zero` and no `--recount`: the sub-hunk keeps its context, and the service computes exact counts.
- Verification: `applyToContent(base, subHunk, reverse)` computes the expected blob, and the exact entry check runs (code). A wrong patch therefore refuses and never publishes.
- Refusals: context lines only; two hunks; a deleted-file hunk, because a partial deletion needs a modify header; a partial selection in a hunk with an incomplete-line marker. F25 covers each case.
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
- Editor presets: Git Extensions lists vi, Notepad, Notepad++, VS Code, Zed, and Sublime Text (Git Extensions `EditorHelper.cs`). The exact values are unverified (O-10).

## R15 Trust option (d)

- Decision: one native task dialog, asked only when an action would run a repository program. The approval binds to folders, the Git selection, and the policy version.
- Rationale: the user found two confirmations and the fingerprint text hard to understand (spec US7). Spec Clarifications 2026-10-16 decide the binding.
- Discovery stays the 001 §7 rules (spec FR-075), plus merge drivers (R9).
- Classes: R9 and the githooks(5) entries name the programs that each new command can run:
  - checkout: `post-checkout`, `reference-transaction`, filters, `core.fsmonitor`, `post-index-change`;
  - stash push and apply: filters, merge drivers, `core.fsmonitor`, `post-index-change`, `reference-transaction`;
  - merge: `pre-merge-commit`, `prepare-commit-msg`, `commit-msg`, `post-merge`, `reference-transaction`, merge drivers, filters, signing, `pre-auto-gc`;
  - rebase: `pre-rebase`, `post-checkout`, `post-rewrite`, `post-commit`, `prepare-commit-msg`, `reference-transaction`, merge drivers, filters, signing, `pre-auto-gc`;
  - worktree add: `post-checkout`, `reference-transaction`, filters; worktree remove runs a status check in that worktree (unverified; F18);
  - branch create, rename, delete, and `update-ref`: `reference-transaction`.
- One class covers the union (ponytail ceiling, plan N-2).

## R16 Submodule update redesign

- The 001 §12 protocol stays. Only the start, the scope, the host lines, and the texts change.
- Host grammar (doc, git-fetch(1) "GIT URLS"): `ssh://[user@]host.xz[:port]/path`, `git://`, `http[s]://`, `ftp[s]://`; the scp form `[user@]host.xz:path` holds only when no slash comes before the first colon; a local path and `file://` name no host.
- Host names compare without regard to case (RFC 4343 §2). A URL with user information is redacted first (001 §7).

## R17 Native dialogs, context menus, Explorer reveal

- Task dialog: `pszMainInstruction`, `pszContent`, `pszExpandedInformation`, `pszCollapsedControlText`, `pszExpandedControlText`, `pButtons`, `nDefaultButton` (doc, Microsoft Learn TASKDIALOGCONFIG). The expanded text shows below the content unless `TDF_EXPAND_FOOTER_AREA`. `TDF_ALLOW_DIALOG_CANCELLATION` lets Escape, Alt+F4, and the close button close the dialog, and the result is `IDCANCEL` (doc, TaskDialog). Hyperlinks need `TDF_ENABLE_HYPERLINKS`, which the doc warns against for unsafe content.
- The shell already uses `TaskDialogIndirect` with `TDF_ALLOW_DIALOG_CANCELLATION` and Cancel as `IDCANCEL` (code, `dialogs.rs`).
- Context menus: WebView2 raises `ContextMenuRequested` only when the page has not disabled the menu (doc). So a page `contextmenu` handler with `preventDefault` shows the app menu, and the 001 shell handler needs no change. N2 confirms it in the package.
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

- Decision: `nspell` with `dictionary-en`, in the renderer.
- Rationale: offline, deterministic for the SC-012 fixture, and no AI. Git Extensions uses NetSpell dictionaries (Git Extensions source).
- Alternatives considered: the WebView2 spell checker (its result depends on the Windows dictionaries and user word lists, so the test has no fixed oracle; unverified whether WebView2 exposes suggestions to the page).
- Unverified: the licenses (`nspell` MIT; `dictionary-en` under the SCOWL terms), the bundle size, and how `dictionary-en` loads its files in a browser build.

## R21 Open facts (P0 list)

Each fact runs on Windows Git 2.56 and WSL Ubuntu-26.04 Git 2.55, compared with Git's own command on a copy. Results go into the Results section below.
- F1: every argv of contract Δ3 is accepted, including `--end-of-options` and `--` positions.
- F2: `checkout -b` with a refused switch creates no branch.
- F3: Keep changes with a conflicting change leaves HEAD, the index, and every working byte unchanged.
- F4: the stash protocol observations (S, P, the reflog pair, S^1) for one and two earlier stashes, and for "nothing to stash".
- F5: `stash apply --index` that Git refuses changes no file.
- F6: Discard through a stash equals `checkout --force` for tracked files, and keeps untracked files.
- F7: the untracked-in-the-way check finds each Git refusal case of the fixtures.
- F8: `checkout -b <new> --track=direct refs/remotes/<r>/<b>` writes the same `branch.<new>` keys as `git checkout --track <r>/<b>`.
- F9: `update-ref -d` plus `--remove-section` equals `branch -D` in refs, reflogs, and configuration bytes; a moved branch makes `update-ref -d` exit non-zero and change nothing.
- F10: the unmerged count equals the commits that `branch -D` makes unreachable from every branch, tag, and remote-tracking ref.
- F11: `check-ref-format --branch` exit and output for valid names, invalid names, and `@{-1}`.
- F12: the `fmt-merge-msg` preview equals Git's own merge message, with and without `merge.log`, on `main` and on another branch.
- F13: the moved count equals the commits that Git's own rebase creates, with patch-same, empty, and merge commits.
- F14: rebase with tracked changes and `--no-autostash` exits non-zero and changes nothing.
- F15: whether `rebase.autoSquash=true` squashes in a non-interactive rebase.
- F16: the moved-branch list equals the refs that `--update-refs` moves.
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
- N1: the task dialog shows the main instruction, the content, and the collapsed details; Enter and Escape return Not now (UI Automation).
- N2: a page `contextmenu` handler with `preventDefault` shows the app menu in the package, and Shift+F10 reaches it.
- N3: a fixture merge tool runs inside the operation Job.
- N4: Cancel ends Git, its shell, and the fixture tool.
- N5: `SHOpenFolderAndSelectItems` selects the path.
- N6: the fixture tool window comes to the front.

## Results

No P0 step has run yet.
