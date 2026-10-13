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
  - Push prints `To <url>` with `transport_anonymize_url`. **documented** (transport.c)
  - Push also prints `Done` after a rejected push. So `Done` decides nothing. **experiment** (R16 b)
  - Porcelain `from` and `to` are full ref names. **experiment** (R16 b)
  - git-push(1) calls the reason "human-readable". So the app never classifies by it (FR-015). **documented**
  - Exit codes of fetch and push: non-zero on any failed ref. Git documents no finer codes, so the porcelain lines and the observed refs decide. **documented** (gap)
- **Alternatives considered**:
  - The human output on stderr: translated. Rejected.
  - `git status -sb` and `git branch -vv` tracking text: translated (`setup_ref_filter_porcelain_msg`). Rejected.
  - `git fetch --all` in one process: one exit code for all remotes, so no outcome for each remote. Rejected for Fetch all.

## R2 Push destination

- **Decision**: The plan.md D4 rule. Git computes the remote and the tracking ref. The service adds the `push.default` cases for the remote ref name, as builtin/push.c `setup_default_push_refspecs` selects them. The R16 (d) fact drives the rule.
- **Rationale**:
  - `branch_get_push_1` applies the `remote.<name>.push` refspecs first, then mirror, then `push.default`: `nothing` errors; `matching` and `current` use the branch name; `upstream` uses the upstream; `simple` and unset need the upstream tracking ref to equal the tracking ref of the branch name. **documented** (remote.c)
  - `%(push)` is the local tracking ref of that destination. It is empty when Git reports an error. **documented** (ref-filter.c `populate_value`)
  - `%(push:remoteref)` is filled only when `remote.<R>.push` maps the branch. **documented** (remote.c `remote_ref_for_branch`)
  - `%(push:remotename)` and `%(upstream:remotename)` print only an explicit remote. **documented** (ref-filter.c)
  - `%(upstream)` is empty when `branch.<name>.remote` names an unconfigured remote. **documented** (DeepWiki), **unverified** (P0.2 j)
  - With `simple` or unset, Git's push treats a triangular push like `current`: the push remote differs from the fetch remote, and the destination is `refs/heads/<branch>`. `branch_get_push_1` does not, so `%(push)` is empty there. FR-014 asks for the destination of Git's own push, so D4 follows Git and has no tracking ref for that destination. **documented** (builtin/push.c `setup_default_push_refspecs`, `is_same_remote`), **experiment** (R16 d)
  - The fetch remote of `is_same_remote` is `branch.<name>.remote`, else `origin`. A push without a `<repository>` argument and without an explicit remote uses `origin`. **documented** (git-push(1) DESCRIPTION; remote.c `remote_for_branch`)
  - `matching` pushes a branch only when the remote has a branch of the same name. Git decides it from the refs that the remote advertises at push time. **documented** (git-config(1) `push.default`), **experiment** (R16 d)
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
  - The `msgs` defaults in ref-filter.c are "Untranslated plumbing messages". Only `git branch` and `git tag` load the translated ones. **documented** (ref-filter.c; builtin/branch.c; builtin/tag.c), **unverified** as an experiment (R16 c)
  - The track counts use `stat_tracking_info` with `AHEAD_BEHIND_FULL`, so they are exact. **documented**
  - The forms are `[ahead N]`, `[behind N]`, `[ahead N, behind M]`, and `[gone]`. `nobracket` drops the brackets. Equal gives an empty value. **documented** (git-for-each-ref(1))
  - `%(ahead-behind:<committish>)` takes one base for all refs, so it cannot count against each upstream. **documented**
  - 200 `rev-list` pairs need about 400 process starts. In WSL each start costs about 250 ms (002 research). **unverified** cost; P12 measures the chosen path.
- **Alternatives considered**: per-branch `rev-list` (O-1 alternative). `%(ahead-behind)` grouped by upstream. Both rejected for cost or fit.

## R10 Mark resolved through the 001 staging path

- **Decision**: `applyFile` direction `resolve`. Step 5 runs `hash-object -w -- <path>` on the working file, then `update-index -z --index-info` on the candidate with `<mW> SP <oid> TAB <path>`. Then the 001 verification and blob proof follow.
- **Rationale**:
  - `update-index --add` on an unmerged path does not equal `git add` on Windows. With `core.symlinks=false` and `core.filemode=false`, it writes `100644` where `git add` keeps `120000` or `100755`. **experiment** (R16 i)
  - The status `u` record field `mW` equals the `git add` stage-0 mode in every fixture. **experiment** (R16 i)
  - A stage-0 entry that `update-index --index-info` adds replaces every unmerged entry of the path. **documented** (read-cache.c `add_index_entry_with_check`), **experiment** (R16 i2)
  - `hash-object -w -- <path>` applies the conversion of the path attributes, as `git add` does. A path with a `filter` driver is refused (data-model §9), so no filter driver runs. **documented** (git-hash-object(1)), **experiment** (R16 i2)
  - 001 refuses conflicted entries in `decideFileAction` (`file-action.ts:146-148`) and at acceptance (`file-publish.ts:219-220`). **documented**
  - `hunk-publish.ts:628-635` assumes no stage above 0 in the retained WSL index. **documented**
- **Alternatives considered**:
  - `git add -- <path>` as a separate command. It writes the canonical index without the candidate, the verification, or the stale check. Rejected (FR-053).
  - `update-index --add --remove -z --stdin` as for 001 Stage file. It loses the link and exec modes on Windows (R16 i). Rejected.

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
- The untranslated `for-each-ref` track text under a German locale: P0.2 c. It needs a German catalog and a `de_DE.UTF-8` locale (R16 c).
- `%(upstream)` with an unconfigured remote: P0.2 j.
- `pull.ff=only` precedence as an experiment, `rebase --fork-point` equality, the matrix against Git's pull: P0.2 e.
- `rebase --skip` leaves the index and working files equal to HEAD of the next step: P0.2 l.
- Pageant `--encrypted` with an unreadable key file exits non-zero: P0.3.
- `GIT_EDITOR=:` and the commit cleanup: P0.2 f.
- `submodule.recurse` and merge or rebase: P0.2 h.
- `update-index --index-info` with mode `mW` equals `git add` on each unmerged kind: P0.2 i2.
- Pageant `--encrypted` and `WaitForInputIdle`: P0.3.
- `ssh2` under Bun: P0.3 (O-5).
- WSL activity on a real fetch: P11.
- SC-003 time for 200 branches: P12.

## Results

P0 to P12 record their results here as R16 and later. Record times and counts as numbers.

## R16 Batch 0 Git facts (P0.2)

Git versions: Windows Git for Windows 2.56.0.windows.2 on the reference PC, and WSL `Ubuntu-26.04` Git 2.55.0. The fact code is `tests/git/remote-facts.ts`. This record holds the facts that change the design. T013 copies every `OBSERVATION` line.

- **(b) Push porcelain**: `from` and `to` are full ref names. `To` is the first line. Push also prints `Done` as the last line after a rejected push. The `b.done-absent-on-failure` expectation was wrong. The fact now checks `b.done-line-last-on-rejection`. **experiment** (Windows 2.56.0.windows.2, WSL 2.55.0). Design change: `Done` decides nothing (contract Δ3, R1).
- **(c) Track text under a German locale**: the proof did not run. Windows Git has no German message catalog, and the distro has no `de_DE.UTF-8` locale. So `c.translation-active` cannot show an active translation. The claim stays **documented** (ref-filter.c `msgs`) and **unverified** as an experiment. To verify it, the reference host needs a Git build with the German catalog, and the distro needs the `de_DE.UTF-8` locale. Installing them is the user's decision. The project installs nothing.
- **(d) Push destination against `push --dry-run --porcelain`**: three cases differ from the first D4 rule. **experiment** (Windows 2.56.0.windows.2, WSL 2.55.0).
  - `push.default=current` on a branch without an upstream: Git pushes to `refs/heads/<branch>` on `origin`. The first rule gave no destination. Design change: D4 step 1 takes `origin` when no remote is explicit, so the panel pre-fills this destination (FR-014, FR-016).
  - `push.default=matching` on a branch without a same-name remote branch: Git pushes nothing for the branch. The first rule gave `refs/heads/<branch>`. Design change: `matching` gives no destination, and the panel shows.
  - Unset `push.default` (`simple`) with `branch.<name>.pushRemote` or `remote.pushDefault` (a triangular workflow): Git pushes to `refs/heads/<branch>` on the push remote. The first rule showed the panel. Design change: D4 follows Git, with no tracking ref (R2).
  - Two push URLs and a mirror remote: Git pushes. The app refuses both on purpose, with reasons `push-urls` (O-11) and `mirror`. The fact confirms that the refusal is a deliberate difference from Git.
  - The fact `d` now applies the new D4 rule. Every variant equals Git's push, destination and URL, except the deliberate `matching`, `mirror`, and two-URL cases. **experiment** (Windows 2.56.0.windows.2, WSL 2.55.0, 2026-10-13).
- **(e) Only behind with `merge.ff=false` and no `pull.ff`**: Git's pull makes a merge commit, also with `--no-rebase`. With `pull.rebase=true` or `pull.ff=true`, it fast-forwards. **experiment** (Windows 2.56.0.windows.2, WSL 2.55.0). Cause: without `pull.ff`, builtin/pull.c `run_merge` passes no ff option, so `merge.ff` applies. Design change: D6 merges with no ff option there, instead of `merge --ff-only` (data-model §6, plan D6). This is a reviewer default under O-2: follow Git.
- **(i) Mark resolved staging**: on Windows, the repository has `core.symlinks=false` and `core.filemode=false`. There, `update-index --add --remove -z --stdin` writes `100644` for the symbolic link stage and for the exec-bit stage. `git add` keeps `120000` and `100755`. The porcelain v2 `u` record field `mW` equals the `git add` mode in every fixture. **experiment** (Windows 2.56.0.windows.2). Design change: step 5 hashes the working file and writes stage 0 with mode `mW` through `update-index --index-info` (plan D7, contract Δ4). Symbolic links stay refused (data-model §9). The new fact (i2) must verify the new step on Windows and WSL.
- **(i2) Mark resolved step 5**: `hash-object -w -- <path>`, then `update-index -z --index-info` with `<mW> SP <oid> TAB <path>`, gives the same index as `git add` for `UU`, `AA`, `AU`, `UA`, `DU`, `UD`, the exec-bit file, and the `filter` file. The stage-0 entry replaces stages 1 to 3, and no other entry changes. **experiment** (Windows 2.56.0.windows.2 with `core.symlinks=false` and `core.filemode=false`; WSL 2.55.0 with `core.filemode=true`, 2026-10-13). A real symbolic link makes `hash-object` follow the link (exit 128 on WSL). On Windows with `core.symlinks=false` it exits 0. Symbolic links stay refused (data-model §9).
- **(k) `git fetch --all` remote set**: Git skips a remote when `remote.<name>.skipFetchAll` or `remote.<name>.skipDefaultUpdate` is true. The last value of the two names wins. Fixture: r1 none; r2 `skipFetchAll=true`; r3 `skipDefaultUpdate=true`; r4 `skipFetchAll=false`, then `skipDefaultUpdate=true`; r5 `skipDefaultUpdate=true`, then `skipFetchAll=false`. Observed fetched set: r1 and r5. **experiment** (Windows 2.56.0.windows.2, WSL 2.55.0). Design change: O-4, plan D3, and contract Δ3 use the last value of the two names. The `k` expectation in `tests/git/remote-facts.ts` now uses the same rule and matches (2026-10-13).
- **(m) Non-boolean skip and mirror values**: with `remote.r2.skipFetchAll=maybe`, `git fetch --all` exits non-zero and fetches no remote. `remote.r2.skipDefaultUpdate=maybe` gives the same result. `git fetch -- r1` also exits non-zero and fetches nothing when r2 holds such a value. With `remote.r1.mirror=maybe`, `git push -- r1` exits non-zero and does not change the remote ref. With `remote.r2.mirror=maybe`, `git push -- r1` gives the same result. The same push without the value creates the ref. **experiment** (Windows 2.56.0.windows.2, WSL 2.55.0, 2026-10-13). Cause: remote.c `handle_config` reads these values with `git_config_bool`, which stops on a value that `git_parse_maybe_bool` rejects. Design change: Fetch, Fetch all, and the fetch step of Pull give `invalid-config` when any remote holds an invalid skip value. Push gives `invalid-config` when any remote holds an invalid `mirror` value. No Git process starts (plan D3, D4; contract Δ3). Extension (2026-10-13): remote.c `handle_config` reads `mirror`, `skipDefaultUpdate`, `skipFetchAll`, `prune`, and `pruneTags` with `git_config_bool`. A probe on 2.56.0.windows.2 showed that an invalid `skipFetchAll`, `skipDefaultUpdate`, or `prune` value on any remote also stops `git push` with exit 128. Design change: every review refuses with `invalid-config` on these five keys, before the `remote` read. The `pruneTags` case, the fetch case with `mirror`, and the `git remote` case stay **unverified** until T005 (m) runs.
- **Version**: T005 expected 2.56.0.windows.1. The reference PC has 2.56.0.windows.2. The fact tasks now record the observed version and do not require one build.
