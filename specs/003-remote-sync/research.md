# Research: Remote Sync

**Feature**: `specs/003-remote-sync` | **Date**: 2026-10-12 | **Plan**: [plan.md](plan.md)

## Sources and fact marks

The facts come from these sources:
- the 001 contract and code on `main` (c64f4e7), read on 2026-10-12;
- the Git source and documentation through DeepWiki (git/git) and git-scm.com, 2026-10-12;
- the PuTTY manual (latest), chapters 7 and 9, 2026-10-12.

Marks:
- **documented**: Git, PuTTY, or Win32 documentation, the 001 contract, or source with a file and function.
- **experiment**: a run showed it. No such run exists yet for 003. P0.2 and P0.3 create them.
- **unverified**: a recollection or an inference. The plan names the step that checks it.

Line numbers in Git source are not recorded here. P0.2 records the Git version of each fact.

## R1 Machine-readable outputs

- **Decision**: Fetch reads `fetch --porcelain`. Push reads `push --porcelain`. Counts read `for-each-ref` `%(upstream:track,nobracket)` and `rev-list --left-right --count`. Operation kinds read the 001 marker paths. Unmerged files read the index stages.
- **Rationale**:
  - `fetch --porcelain` prints `<flag> <old-object-id> <new-object-id> <local-reference>` on stdout. Flags: space, `+`, `-`, `t`, `*`, `!`, `=`. **documented** (git-fetch(1) OUTPUT)
  - `--porcelain` refuses `--recurse-submodules=yes|on-demand` and defaults recursion to off. **documented** (builtin/fetch.c)
  - `fetch --all --porcelain` passes `--porcelain` to each child. **documented** (builtin/fetch.c `add_options_to_argv`)
  - Whether `--progress` still prints the counter with `--porcelain` is open. DeepWiki said no, without a source line. **unverified** (P0.2 a)
  - `push --porcelain` prints `<flag>\t<from>:<to>\t<summary> (<reason>)` to stdout. Summaries `[rejected]`, `[remote rejected]`, `[remote failure]`, `[up to date]`, and `[new branch]` are not marked for translation. **documented** (git-push(1) OUTPUT; transport.c `print_ref_status`)
  - Push prints `To <url>` with `transport_anonymize_url`, and `Done` when the push had no error. **documented** (transport.c)
  - Porcelain `from` and `to` are full ref names. **unverified** (P0.2 b)
  - git-push(1) calls the reason "human-readable". So the app never classifies by it (FR-015). **documented**
  - Exit codes of fetch and push: non-zero on any failed ref. Git documents no finer codes, so the porcelain lines and the observed refs decide. **documented** (gap)
- **Alternatives considered**:
  - The human output on stderr: translated. Rejected.
  - `git status -sb` and `git branch -vv` tracking text: translated (`setup_ref_filter_porcelain_msg`). Rejected.
  - `git fetch --all` in one process: one exit code for all remotes, so no outcome for each remote. Rejected for Fetch all.

## R2 Push destination

- **Decision**: The plan.md D4 rule. Git computes the remote and the tracking ref. The service adds only the three `push.default` cases for the remote ref name.
- **Rationale**:
  - `branch_get_push_1` applies the `remote.<name>.push` refspecs first, then mirror, then `push.default`: `nothing` errors; `matching` and `current` use the branch name; `upstream` uses the upstream; `simple` and unset need the upstream tracking ref to equal the tracking ref of the branch name. **documented** (remote.c)
  - `%(push)` is the local tracking ref of that destination. It is empty when Git reports an error. **documented** (ref-filter.c `populate_value`)
  - `%(push:remoteref)` is filled only when `remote.<R>.push` maps the branch. **documented** (remote.c `remote_ref_for_branch`)
  - `%(push:remotename)` and `%(upstream:remotename)` print only an explicit remote. **documented** (ref-filter.c)
  - `%(upstream)` is empty when `branch.<name>.remote` names an unconfigured remote. **documented** (DeepWiki), **unverified** (P0.2 j)
  - With `simple`, Git's push treats a triangular push like `current`. `branch_get_push_1` does not, so the app shows the FR-016 panel there. **documented** (builtin/push.c `setup_default_push_refspecs`), **unverified** as a fixture (P0.2 d)
- **Alternatives considered**:
  - `git push --dry-run` before the start: it contacts the remote and can run `pre-push`. Rejected.
  - A plain `git push` without a refspec: `matching` pushes several refs. Rejected (spec edge case).
  - `git push <remote> HEAD`: `refspec_append_mapped` ignores the `simple` name check. Rejected.

## R3 Pull: fetch, count, decide, integrate

- **Decision**: The app's fetch, then a count from `rev-list --left-right --count`, then a local `merge` or `rebase` against the remote-tracking ref. The mode rule is plan.md D6.
- **Rationale**:
  - `run_merge` spawns `git merge … FETCH_HEAD` with the `pull.ff` option and the autostash option. **documented** (builtin/pull.c)
  - `run_rebase` spawns `git rebase --onto <merge head> <fork point or merge head>`. The fork point comes from `merge-base --fork-point` with the remote-tracking ref. **documented** (builtin/pull.c `get_rebase_fork_point`, `get_rebase_newbase_and_upstream`)
  - `rebase --fork-point <upstream>` replays the same commits onto the same base. **unverified** (P0.2 e)
  - With rebase configured, a pull that can fast-forward does so (Git 2.27 and later). **documented** (builtin/pull.c; RelNotes 2.27.0)
  - Divergence with neither `pull.rebase` nor `pull.ff` makes Git die with advice. **documented** (builtin/pull.c)
  - An explicit `--rebase` or `--no-rebase` overrides `pull.ff=only`: `cmd_pull` turns `--ff-only` into `--ff` when `opt_rebase >= 0`, "so that an explicit '--rebase' can override a config setting of pull.ff=only". A configured `pull.rebase` does not override it: "ff-only takes precedence over rebase" dies on divergence (t7601 "pull.ff=only overrides pull.rebase=true"). **documented** (builtin/pull.c `cmd_pull`, DeepWiki git/git; P0.2 e records it as an experiment)
  - With rebase configured and a pull that can fast-forward, Git forces `--ff-only`, also with `pull.ff=false`. **documented** (builtin/pull.c), **unverified** as a fixture (P0.2 e)
  - `pull.rebase` values: `true`, `false`, `merges`, `interactive`. `branch.<name>.rebase` overrides `pull.rebase`. **documented** (git-config(1); builtin/pull.c `config_get_rebase`)
  - `merge` and `rebase` do not honor `submodule.recurse`. **documented** (Documentation/config/submodule.adoc list), **unverified** as a fixture (P0.2 h)
- **Alternatives considered**:
  - One `git pull` process: Git decides inside it. FR-027 needs the counts after the fetch, and a "mode required" result from Git is only an exit 128 with English text. Rejected.
  - `git merge FETCH_HEAD`: it gives Git's own pull message, but FETCH_HEAD can change between the fetch and the merge. `fetch.writeFetchHEAD=false` also stops it. Rejected (O-3).
  - A second `git pull` after the user picks a mode: it fetches twice. Rejected.

## R4 Conflict actions and the editor

- **Decision**: Abort with `merge --abort` or `rebase --abort`. Continue with `commit --quiet` (merging) or `rebase --continue`. Skip with `rebase --skip`. All under the `integrate` policy with `GIT_EDITOR=:`.
- **Rationale**:
  - `merge --continue` checks `MERGE_HEAD` and runs `git commit` with no argument. **documented** (builtin/merge.c)
  - `git commit` opens the editor unless `-m`, `-F`, or `--no-edit` is given. With `--no-edit`, the default cleanup keeps the `# Conflicts:` comment lines. With an editor, cleanup `strip` removes them. **unverified** (recollection of builtin/commit.c; P0.2 f)
  - Git skips the editor when its name is `:`. **unverified** (recollection of editor.c `launch_specified_editor`; P0.2 f)
  - `GIT_EDITOR` overrides `core.editor`. **documented** (git-var(1))
  - Non-interactive `rebase --continue` opens no editor without a terminal. **documented** (sequencer.c, DeepWiki)
  - `merge` opens no editor without a terminal, unless `GIT_MERGE_AUTOEDIT` asks. **documented** (builtin/merge.c `default_edit_option`)
- **Alternatives considered**:
  - `commit --no-edit`: it keeps the comment lines. Rejected.
  - `merge --continue`: without `--quiet`, the commit summary can exit 128 in a partial clone after the commit exists (001 research R5). Rejected for the exit code. The message is the same.

## R5 Transport policy and environment

- **Decision**: The new policy `remote` for fetch, push, and clone. The new policy `integrate` for merge, rebase, commit, abort, and skip. The 001 `network` policy stays for submodules.
- **Rationale**:
  - Built-in defaults: `http`, `https`, `git`, and `ssh` are `always`; `ext` is `never`; `file` and unknown protocols are `user`. **documented** (git-config(1); transport.c)
  - A plain local path counts as `file`. **documented**
  - `user` means usable only when `GIT_PROTOCOL_FROM_USER` is unset or `1`. **documented**
  - The 001 `network` policy sets `GIT_PROTOCOL_FROM_USER=0` (`git-environment.json`). A user fetch from a local remote would then fail, while Git's own fetch works. **documented**; **experiment** for submodules (001 probe S21); P0.2 g for 003.
  - `fetch`, `push`, `clone`, and `pull` do not set the variable for themselves. Only `git submodule` does (git-submodule.sh). **documented** (001 §12)
  - `--no-lazy-fetch` did not block an explicit fetch or clone (001 probes S1, S6, S20). **experiment**
- **Alternatives considered**:
  - Reuse `network` and set `protocol.file.allow=always` with `-c`: that changes Git's transport policy (FR-008). Rejected.

## R6 Progress, cancellation, deadlines, and re-reads

- **Decision**: The 001 network limits and stall notice for every `sync` and `clone` process. The untranslated counter for the percentage. Re-reads after every end.
- **Rationale**:
  - Git prints the counter with the untranslated format `"%3u%% (%"PRIuMAX"/%"PRIuMAX")%s"` (progress.c). The app parses nothing else. **documented** (001 §12 "Progress")
  - The Job I/O sum covers file, network, and device I/O. **documented** (Win32 `GetProcessIoCounters`, `IO_COUNTERS`)
  - A silent local fetch moved 120 MB without an output byte (001 probe S16). So output alone is no activity signal. **experiment**
  - A credential helper window or Pageant's passphrase prompt does no I/O, so the stall notice names a sign-in window. **documented** (001 §12)
  - Cancellation is no rollback. A remote can hold a push that the app canceled. The result says that Fetch shows the remote state. **documented** (constitution I)
- **Alternatives considered**: a computed percentage over the Git phases. FR-002 forbids it. Rejected.

## R7 Credentials

- **Decision**: Git's own helpers run unchanged. `GIT_TERMINAL_PROMPT=0` in every policy. No storage, cache, or log of a credential.
- **Rationale**:
  - `GIT_TERMINAL_PROMPT=0` turns off terminal prompts only. Askpass programs and GUI helpers still run. **documented** (git(1); prompt.c; 001 research R14)
  - Git Credential Manager shows its own window. **documented** (001 §12)
  - URL user information is redacted by the 001 rule. Git also anonymizes the `To` line. **documented**
  - A remedy with a URL that holds user information gives no command, only text. **documented** (001 §4 quoting rule)
- **Alternatives considered**: an app askpass helper. FR-008 forbids credential handling. Rejected.

## R8 PuTTY

- **Decision**: `GIT_SSH_COMMAND='<plink>' -batch` and `GIT_SSH_VARIANT=plink`, only in the child environment. `pageant --encrypted <key>` before the run. `git ls-remote` through plink without `-batch` in a visible console for Connect in a terminal.
- **Rationale**:
  - `-batch` makes plink abandon a connection with an unknown host key instead of prompting. **documented** (PuTTY manual §7.2.3.1)
  - The PuTTY manual §7.4 shows `GIT_SSH_COMMAND="C:\Program Files\PuTTY\plink.exe" -batch` for batch use. **documented**
  - Git adds `-batch` only for `tortoiseplink`. `plink` gets `-P` for a port. **documented** (connect.c `push_ssh_options`)
  - `GIT_SSH_COMMAND` runs through the shell. It overrides `GIT_SSH` and `core.sshCommand`. `GIT_SSH_VARIANT` overrides the variant guess. **documented** (connect.c)
  - "If Pageant is already running, this syntax loads keys into the existing Pageant." **documented** (PuTTY manual §9.3.1)
  - `--encrypted` adds a key without decryption. Pageant prompts at first use. **documented** (PuTTY manual §9.5; PuTTY 0.75 and later, **unverified**)
  - `WaitForInputIdle` returns when a GUI process waits for input with no input pending. **documented** (Win32). Pageant is idle after its start. **unverified** (P0.3)
  - Git and plink give no machine-readable SSH failure reason. **documented** (gap; spec Assumptions)
- **Alternatives considered**:
  - `GIT_SSH` without arguments: it cannot pass `-batch`. Rejected.
  - `GIT_SSH_VARIANT=tortoiseplink` with plink to get `-batch`: it misnames the program. Rejected.
  - A process scan for a running Pageant: not needed, because the same command fits both states. Rejected.
  - Plink against a host and port that the app parses from the URL: it copies Git's URL grammar and its `insteadOf` rules. Rejected (O-9).
  - Reading the `.ppk` public part: FR-036 and the spirit of FR-035. Rejected.

## R9 Ahead and behind counts

- **Decision**: One `readTracking` read with `%(upstream:track,nobracket)`. Pull uses `rev-list --left-right --count` for its decision.
- **Rationale**:
  - The `msgs` defaults in ref-filter.c are "Untranslated plumbing messages". Only `git branch` and `git tag` load the translated ones. **documented** (ref-filter.c; builtin/branch.c; builtin/tag.c)
  - The track counts use `stat_tracking_info` with `AHEAD_BEHIND_FULL`, so they are exact. **documented**
  - The forms are `[ahead N]`, `[behind N]`, `[ahead N, behind M]`, and `[gone]`. `nobracket` drops the brackets. Equal gives an empty value. **documented** (git-for-each-ref(1))
  - `%(ahead-behind:<committish>)` takes one base for all refs, so it cannot count against each upstream. **documented**
  - 200 `rev-list` pairs need about 400 process starts. In WSL each start costs about 250 ms (002 research). **unverified** cost; P12 measures the chosen path.
- **Alternatives considered**: per-branch `rev-list` (O-1 alternative). `%(ahead-behind)` grouped by upstream. Both rejected for cost or fit.

## R10 Mark resolved through the 001 staging path

- **Decision**: `applyFile` direction `resolve`. Step 5 runs `update-index --add --remove -z --stdin` on the candidate, then the 001 verification and blob proof.
- **Rationale**:
  - `update-index --add` on an unmerged path removes stages 1 to 3 and adds stage 0 from the working file, as `add_to_index` does for `git add`. **unverified** (P0.2 i)
  - The stage-0 mode comes from `ce_mode_from_stat` with the entry that `index_name_pos_also_unmerged` finds. The status `u` record field `mW` is the expected mode. **unverified** (P0.2 i)
  - 001 refuses conflicted entries in `decideFileAction` (`file-action.ts:146-148`) and at acceptance (`file-publish.ts:219-220`). **documented**
  - `hunk-publish.ts:628-635` assumes no stage above 0 in the retained WSL index. **documented**
- **Alternatives considered**: `git add -- <path>` as a separate command. It writes the canonical index without the candidate, the verification, or the stale check. Rejected (FR-053).

## R11 Clone

- **Decision**: `git clone --progress --no-recurse-submodules -- <url> <destination>` after an OS destination check, then the 001 discovery and registration.
- **Rationale**:
  - Clone creates missing parent folders. It refuses a non-empty existing destination. **documented** (builtin/clone.c)
  - Clone does not honor `submodule.recurse`, and recursion needs `--recurse-submodules`. **documented** (Documentation/config/submodule.adoc)
  - Whether a killed clone removes its folder is not known. FR-050 reports the observed folder only. **unverified**
  - `--` keeps a URL that starts with `-` literal. Git also blocks SSH host names that start with `-`. **documented** (001 probe S31; connect.c)
- **Alternatives considered**: Git's `git_url_basename` for the suggestion. It changes characters, which FR-054 forbids. Rejected.

## R12 WSL

- **Decision**: The same operations through the wrapper in the new modes `remote` and `integrate`. PuTTY is not available there.
- **Rationale**:
  - WSLENV is empty, so no Windows variable reaches Linux. **documented** (001 §11)
  - `setsid --wait` removes the terminal, so SSH and credential prompts fail at once. **documented** (001 §12)
  - The anchor CPU-time sum is the activity signal. It is unverified for a real fetch. **unverified** (001 §12; P11)
- **Alternatives considered**: none.

## R13 Tests without network

- **Decision**:
  - Local bare remotes.
  - `git http-backend` behind `Bun.serve` with Basic sign-in on 127.0.0.1.
  - `git daemon` on 127.0.0.1 for SC-013. An access hook counts service requests; no log text decides.
  - An SSH server in the test process (O-5) or a WSL `sshd`.
  - Inert key fixtures.
  - Windows Sandbox for every case that starts plink, Pageant, or PuTTYgen (T084 configuration).
- **Rationale**:
  - The `git http-backend` CGI serves smart HTTP. **documented** (git-http-backend(1))
  - `git daemon --access-hook` runs a program for each service request. **documented** (git-daemon(1))
  - Windows on this PC has no `sshd`: neither Git for Windows nor System32 has one. PuTTY 0.8x is installed. **experiment** (2026-10-12 listing)
  - Windows PuTTYgen has no command line, so the test `.ppk` is an inert fixture. **unverified**
- **Alternatives considered**: public hosts. Forbidden by the spec. Rejected.

## R14 Git Extensions comparison

- Git Extensions detects a rejected push by English output text. The app takes only the flow, not the detection. **documented** (spec Assumptions)
- Git Extensions starts Pageant with no argument, waits for input idle, then loads the key. **unverified** (DeepWiki recollection; GPL, ideas only)

## R15 Open facts

These stay **unverified** until the named step runs:
- `fetch --porcelain` with `--progress` prints the counter: P0.2 a.
- Porcelain push `from:to` are full names: P0.2 b.
- `%(upstream)` with an unconfigured remote: P0.2 j.
- `pull.ff=only` precedence as an experiment, `rebase --fork-point` equality, the matrix against Git's pull: P0.2 e.
- `rebase --skip` leaves the index and working files equal to HEAD of the next step: P0.2 l.
- Pageant `--encrypted` with an unreadable key file exits non-zero: P0.3.
- `GIT_EDITOR=:` and the commit cleanup: P0.2 f.
- `submodule.recurse` and merge or rebase: P0.2 h.
- `update-index --add` on unmerged paths and the mode: P0.2 i.
- The `skipFetchAll` set: P0.2 k.
- Pageant `--encrypted` and `WaitForInputIdle`: P0.3.
- `ssh2` under Bun: P0.3 (O-5).
- WSL activity on a real fetch: P11.
- SC-003 time for 200 branches: P12.

## Results

P0 to P12 record their results here as R16 and later. Record times and counts as numbers.
