# Research: Remote Sync

**Feature**: `specs/003-remote-sync` | **Date**: 2026-10-12 | **Plan**: [plan.md](plan.md)

## Sources and fact marks

The facts come from these sources:
- the 001 contract and code on `main` (a4c6fb1), read on 2026-10-12;
- the Git source and documentation through DeepWiki (git/git) and git-scm.com, 2026-10-12;
- the PuTTY manual (latest), chapters 7 and 9, 2026-10-12.

Marks:
- **documented**: Git, PuTTY, or Win32 documentation, the 001 contract, or source with a file and function.
- **experiment**: a run showed it. R16 holds the P0.2 runs of 003. P0.3 creates the SSH server and PuTTY runs.
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
  - Git skips the editor when its name is `:`. **documented** (editor.c `launch_specified_editor`, R18), **experiment** (P0.2 f, R18)
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
  - Windows PuTTYgen has command-line options, but they only pre-select GUI settings. No option saves a file. So the user saves the test `.ppk` in the PuTTYgen GUI, and it is an inert fixture. **documented** (PuTTY manual 0.85, §8.2.16)
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
- **(m) Non-boolean skip and mirror values**: with `remote.r2.skipFetchAll=maybe`, `git fetch --all` exits non-zero and fetches no remote. `remote.r2.skipDefaultUpdate=maybe` gives the same result. `git fetch -- r1` also exits non-zero and fetches nothing when r2 holds such a value. With `remote.r1.mirror=maybe`, `git push -- r1` exits non-zero and does not change the remote ref. With `remote.r2.mirror=maybe`, `git push -- r1` gives the same result. The same push without the value creates the ref. **experiment** (Windows 2.56.0.windows.2, WSL 2.55.0, 2026-10-13). Cause: remote.c `handle_config` reads these values with `git_config_bool`, which stops on a value that `git_parse_maybe_bool` rejects. Design change: Fetch, Fetch all, and the fetch step of Pull give `invalid-config` when any remote holds an invalid skip value. Push gives `invalid-config` when any remote holds an invalid `mirror` value. No Git process starts (plan D3, D4; contract Δ3). Extension (2026-10-13): remote.c `handle_config` reads `mirror`, `skipDefaultUpdate`, `skipFetchAll`, `prune`, and `pruneTags` with `git_config_bool`. A probe on 2.56.0.windows.2 showed that an invalid `skipFetchAll`, `skipDefaultUpdate`, or `prune` value on any remote also stops `git push` with exit 128. Design change: every review refuses with `invalid-config` on these five keys, before the `remote` read. The `pruneTags` case, the fetch case with `mirror`, and the `git remote` case stay **unverified** until T005 (m) runs. Extension (2026-10-13, valueless keys): a key line without `=` gives the listing no value. remote.c `handle_config` stops on such an entry of `branch.<name>.remote`, `pushRemote`, `merge`, `url.<base>.insteadOf`, `pushInsteadOf`, `remote.pushDefault`, and `remote.<name>.url`, `pushurl`, `push`, `fetch`, `receivepack`, `uploadpack`, `proxy`, `proxyAuthMethod`, `vcs`, `serverOption`, `negotiationRestrict`, and `negotiationInclude` (`git_config_string`, `config_error_nonbool`, `parse_transport_option`). `remote.<name>.tagOpt` and `followRemoteHEAD` pass the missing value to `strcmp`. A probe on 2.56.0.windows.2 showed exit 128 for `git remote`, `for-each-ref %(push)`, and `push --dry-run` with a bare `branch.main.pushremote`, `branch.zz.merge`, `remote.o.vcs`, `url.x.insteadOf`, or `remote.pushDefault`. A bare `remote.o.tagOpt` or `followRemoteHEAD` gave exit 139. Design change: every review refuses with `invalid-config` on such an entry, before the `remote` read. T005 and T006 (m) assert the bare `pushRemote` case. **documented** (remote.c, config.c, transport.c at v2.56.0.windows.2), **experiment** (Windows 2.56.0.windows.2; the `pushRemote` case also on WSL Ubuntu-26.04 Git 2.55.0, 2026-10-13).
- **(d) T089 cases**: three of five new variants differed from the first D4 rule. **experiment** (Windows 2.56.0.windows.2, 2026-10-19). Decisions of 2026-10-19: D4 follows Git for `push.autoSetupRemote`; the push remote `.` gets its own reason; a remote without a URL stays as it is (T091).
  - `push.autoSetupRemote=true` on `noup`, without `push.default`: Git's dry run exits 0 with `*` `refs/heads/noup:refs/heads/noup` `[new branch]` to origin. D4 shows the panel without a pre-fill. Finding: D4 differs. Cause: builtin/push.c `get_upstream_ref` returns `refs/heads/<branch>` when the branch has no `branch.<name>.merge` and `push.autoSetupRemote` is on.
  - The same with `push.default=upstream`: Git pushes the same line. D4 gives `push-remote-differs`, so the panel has no pre-fill. Finding: D4 differs, for the same cause.
  - `branch.topic.remote=nourl` with only `remote.nourl.fetch`: `git remote` lists `nourl`. `remote get-url --push --all -- nourl` exits 0 and prints `nourl`. D4 gives `refs/heads/topic` with URL `nourl`. Git's dry run exits 128 with no porcelain line, because no repository exists at the path `nourl`. Cause: remote.c `remotes_remote_get_1` uses the name of a remote without a URL as its URL (`add_url_alias`). With `url.<second>.insteadOf=nourl`, Git pushes `refs/heads/topic:refs/heads/topic` to the second remote, and D4 gives the same destination and URL. So the destination equals Git's. The review accepts a URL that is only the remote name.
  - `branch.topic.pushRemote=.`: `%(push:remotename)` is `.`. `git remote` does not list `.`, and `remote get-url` exits 2. Git's dry run exits 0 with `=` `refs/heads/topic:refs/heads/topic` `[up to date]` to `.`. D4 gives `remote-missing`. Finding: D4 refuses where Git pushes. D3 gives `local-upstream` for `.`, but D4 has no such rule.
  - Decision for the remote without a URL: accepted. The review shows Git's own destination, and the push then fails with Git's exit code.
- **(d) T091 D4 change**: every case now equals Git's dry run, except the deliberate `local-push-remote`, `matching`, `mirror`, and two-URL cases, and the accepted remote without a URL. **experiment** (Windows 2.56.0.windows.2; WSL Ubuntu-26.04 Git 2.55.0 with the same results; 2026-10-19).
  - `push.autoSetupRemote=true` on `noup` under unset, `simple`, `upstream`, `tracking`, and `current`: Git exits 0 with `*` `refs/heads/noup:refs/heads/noup` `[new branch]` to origin. D4 pre-fills the panel with that destination, and Set upstream is selected.
  - Under `matching`, Git exits 0 and pushes only same-name branches, so it prints no `noup` line. D4 shows the panel. Under `nothing`, Git exits 128, and D4 shows the panel without a pre-fill.
  - A true entry and a later false entry: Git still pushes `noup` and would set the upstream. Cause: builtin/push.c `git_push_config` sets the flag on a true entry and clears it on no entry.
  - `push.autoSetupRemote=maybe`: `git push` exits 128, also with an explicit refspec. D4 gives `invalid-config` for every push.
  - `branch.noup.merge` without `branch.noup.remote`: Git pushes as with no merge entry, because remote.c `set_merge` drops the merge entries. With `branch.noup.remote=origin` and a merge entry, Git exits 128, and D4 shows the panel without a pre-fill.
  - `push.default=upstream` with `branch.noup.pushRemote=second`: Git exits 128, because the push remote differs from `remote_for_branch`. D4 gives `push-remote-differs`.
  - The push remote `.`: D4 gives `local-push-remote` on purpose. Git pushes into the repository itself.
  - remote.c `remotes_remote_for_branch` (lines 673 to 687) returns the only configured remote when exactly one remote exists, not `origin`. The first D4 step 1 and D3 took `origin`. Decision of 2026-10-19: D3 and D4 follow Git through one helper `defaultRemote` (T091). The cases below are **experiment** (Windows 2.56.0.windows.2; WSL Ubuntu-26.04 Git 2.55.0 with the same results; 2026-10-19).
  - Single remote `up` (origin renamed, second removed), branch `noup`: `push.default=current` exits 0 with `*` `refs/heads/noup:refs/heads/noup` `[new branch]` to `up`, and `%(push:remotename)` is empty; D4 pre-fills that destination. `simple` and `upstream` exit 128 with no line; D4 shows the panel without a pre-fill. `push.autoSetupRemote=true` exits 0 with the same `*` line; D4 pre-fills it.
  - Two remotes `up` and `second` without `origin`, `current`: Git exits 128 with no line, because the default is `origin`. D4 shows the panel. Two remotes with `origin`, `current`: Git pushes to origin, and D4 pre-fills that destination.
  - Fetch without a remote argument takes the same default through `remote_get(NULL)` (builtin/fetch.c line 2761). A probe with the single remote `up` fetched `refs/remotes/up/main` with exit 0, on a branch and on a detached HEAD. With two remotes and no `origin`, the fetch exited 0 and fetched nothing. D3 gives `remote-missing` there on purpose, because the app always names the remote.
- **(m) T090 empty branch subsection**: with `[branch ""]` and `remote = o` in the repository file, `git remote`, `for-each-ref --format=%(push)`, `git fetch -- r1`, and `git push --dry-run --porcelain -- r1 <refspec>` each exit 128 and change no local or remote ref. The controls without the section exit 0. **experiment** (Windows 2.56.0.windows.2; WSL Ubuntu-26.04 Git 2.55.0 with the same results; 2026-10-19). The fetch names `r1`, because `o` names no remote and would fail without the section. This confirms the `stopsGit` refusal of batch 2.
- **Version**: T005 expected 2.56.0.windows.1. The reference PC has 2.56.0.windows.2. The fact tasks now record the observed version and do not require one build.

## R17 Batch 1 verification (T025)

Runs of 2026-10-13 in `C:\Projects\arbareto-l5` on `f003-spec`, for T014 to T026 and T029. Host: Windows 11 Pro 10.0.26300 x64, Bun 1.4.3, Git 2.56.0.windows.2. WSL: Ubuntu-26.04 with Git 2.55.0. The first run is on 8087fe4. The rerun is on 13a3c72, after the review fixes of ea807f9 and the merge of main. The rerun `test:all` used `ARBARETO_WSL_DISTRO=Ubuntu-26.04` and `ARBARETO_TEST_WORKERS=6`. The batch 1 review is recorded ("Batch reviews").

| Step | 8087fe4 | 13a3c72 |
|---|---|---|
| `bun install --frozen-lockfile` | 0 | 0, no changes |
| `bun run build` | 0 | 0 |
| `bun run typecheck` | 0 | 0 |
| `bun run export:schemas --check` | 0 | 1: `clone-result.schema.json` is stale |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml` | 0 | 0 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | 0: 454 passed, 0 failed, 4 ignored | 0: 455 passed, 0 failed, 4 ignored |
| `bun run test:all` | 1: 163 files, 5,490 tests. Parallel step: 140 files, 5,093 pass, 37 skip, 1 fail, 2,443.2 s. Serial step: 23 files, 350 pass, 9 skip, 0 fail, 2,947.8 s. | 1: 163 files, 5,496 tests. Parallel step: 140 files, 5,099 pass, 37 skip, 1 fail, 2,076.9 s. Serial step: 23 files, 350 pass, 9 skip, 0 fail, 2,777.9 s. |

- The 8087fe4 failure: the portability test "shared source outside the platform files holds no native path rule" found a drive-letter class in `src/contracts/clone-name.ts`. ea807f9 fixes it. `clone-name.ts` takes `hasDrivePrefix` from `native-path.ts`.
- The 13a3c72 failure: "the committed schema files equal a fresh export" in `tests/contracts/schemas.test.ts`. The T379 merge from main added the reason `scope-arguments`, and the committed `clone-result.schema.json` did not hold it. The same cause made `export:schemas --check` exit 1.
- Close step: `bun run export:schemas` changed only `clone-result.schema.json`, with one added line `"scope-arguments"` (69e30ce). Then `bun run export:schemas --check` exited 0, and `bun run typecheck` exited 0. `bun test tests/contracts` ran 69 files, 3,523 tests: 3,493 pass, 30 skip, 0 fail. It printed 217 `ORIGIN` lines, all under `C:\Projects\arbareto-l5`. The generated file was the only `test:all` failure of the rerun. So the regeneration and the contracts rerun close it. No full rerun ran.
- `ORIGIN`: each `test:all` printed 1,306 lines, all under `C:\Projects\arbareto-l5`. Each control mutation run also printed its line under this checkout.
- 13a3c72 `test:all` skips (46), by the reason that the run printed: `ssh-server` 3; `other-account-owner` 2; `history-fixture-h1m` 2; `disposable-volume` 2; `restart-keeps-lingering` 1; `fifo` 1; `distro-git-below-2.55` 2; `two-test-distros` 1; `empty-locpath-hides-c-utf8` 1. 31 more skips print no reason.

T087: the green `test:all` of 2026-10-18 on a22e924 (R19) runs every batch 0 and batch 1 test file, and its `ORIGIN` lines are under `C:\Projects\arbareto-l5`. It is the green full run for T001 to T006, T014 to T024, T026, T029, and T025.

Control mutation: in the D4 rule of `src/git-service/sync-parsers.ts`, `push.default=nothing` maps to `refs/heads/<branch>`. Each run went red with the edit, and green after the undo.

| Run | Red: `tests/contracts/sync-rules.test.ts` | Green |
|---|---|---|
| 8087fe4 | 3 of 39 fail: "nothing and other values give invalid-config", "the last push.default value wins", and "an empty %(upstream) gives the panel, pre-filled with the destination". | 39 pass |
| 13a3c72 | 3 of 43 fail, the same three cases. | 43 pass |

Ticks. Each task cites its proof.

| Task | Proof |
|---|---|
| T001 | `tests/git/remote-fixtures.test.ts` is in `parallel` and passes in both `test:all` runs, with the 20,000-commit and digest cases. |
| T002 | `tests/git/remote-fixtures.ts` builds every fixture, and T001 passes. |
| T003 | `tests/git/remote-servers.test.ts` is in `parallel` and passes in both runs. It checks 127.0.0.1, the counters, and stop by PID. |
| T004 | `tests/support/http-remote.ts` and `tests/support/git-daemon.ts` exist, and T003 passes. |
| T005 | `tests/git/remote-facts.test.ts` is in `parallel` and prints 170 `OBSERVATION T005` lines on 13a3c72 (166 on 8087fe4) for (a) to (m) and (i2), each with the Git version. The 8 lines with `match=false` are R16 c, d, and i. |
| T006 | `tests/wsl/sync-wsl.test.ts` is in `serial` with its reason and passes in both runs. It prints 170 `OBSERVATION T006` lines on 13a3c72 (166 on 8087fe4), with Git 2.55.0. The 4 lines with `match=false` are R16 c and d. |
| T014 | `tests/contracts/sync-commands.test.ts` is in `tests/groups.json` `parallel` and passes in both `test:all` runs. |
| T015 | `tests/contracts/sync-parsers.test.ts` is in `parallel` and passes in both runs. |
| T016 | `tests/contracts/sync-rules.test.ts` passes on 13a3c72 with `several-merge-refs` (ea807f9), and the control mutation turns it red. |
| T017 | `tests/contracts/clone-name.test.ts` is in `parallel` and passes in both runs. |
| T018 | `tests/contracts/file-action.test.ts` passes in both runs. |
| T019 | The contract, envelope, schema, vector, and operation state tests pass in the close step contracts rerun. |
| T020 | T014 passes. The review found that every argv builder matches contract Δ3. |
| T021 | T015 and T016 pass. `invalidRemoteValue` is exported for T040. The review found no message text read. |
| T022 | T017 passes, and the portability test passes on 13a3c72. |
| T023 | T018 passes. |
| T024 | T019 passes, and `export:schemas --check` exits 0 after 69e30ce. |
| T026 | `cargo test` passes on 13a3c72: 455 passed, 0 failed. |
| T029 | `cargo test` and `tests/contracts/bridge.test.ts` pass. `src-tauri/permissions/autogenerated` holds the new command files, and `capabilities/main.json` grants them. |
| T025 | On 13a3c72, every command exits 0 except `export:schemas --check` and `test:all`. Both failed only on the stale schema file. The close step closes that failure without a full rerun. `ORIGIN` lines are under this checkout. The mutation went red, then green. "Batch reviews" holds the batch 1 review. |

## R18 Batch 3 Git facts (T044 to T050)

Git version: Git for Windows 2.56.0.windows.2 on the reference PC. The tests are `tests/git/sync-pull.test.ts`, `sync-conflicts.test.ts`, and `mark-resolved.test.ts`.

- **`rebase-merge/interactive`**: a plain `git rebase` of the merge backend writes the file, and `git status` reports "interactive rebase in progress". The only state file that differs from `git rebase -i` is `drop_redundant_commits`, which records `--empty=drop` and is no fact about an interactive rebase. **experiment** (Windows 2.56.0.windows.2). **documented** (builtin/rebase.c `init_basic_state`, DeepWiki git/git). Design change: every rebase stop allows Abort, Continue, and Skip, and no review reads the file (plan D7, FR-030, contract Δ3).
- **Editor of Continue**: the `integrate` policy sets `GIT_EDITOR=:`. git-var(1) gives the order `GIT_EDITOR`, `core.editor`, `VISUAL`, `EDITOR`. editor.c `launch_specified_editor` starts no program when the editor is `:` (`if (strcmp(editor, ":"))`). **documented** (git-var(1), editor.c, DeepWiki git/git). The app's `rebase --continue` at a conflict stop of a merge-backend pull rebase and at a fixup stop of an `--autosquash` rebase equals Git's own `rebase --continue` with `GIT_EDITOR=:`. **experiment** (Windows 2.56.0.windows.2).
- **Pull merge message**: the merge argv takes the feature 004 D5 preview of `fmt-merge-msg` for the short remote-tracking name with `--no-log -m`. The message equals Git's own `git merge origin/<branch>`, with `merge.log` true and the " into <branch>" suffix. Without `-m`, the full ref argument gives "Merge remote-tracking branch 'refs/remotes/origin/<branch>' into <branch>". **experiment** (Windows 2.56.0.windows.2). A merge conflict marker names the merge argument, so it differs from the label of Git's own pull (O-3, accepted).
- **Todo `exec` lines**: Git runs each `exec` line of `rebase-merge/git-rebase-todo` with the shell, so a planted todo would run commands on Continue or Skip. sequencer.c (git/git master, last change cfbffcd, 2026-10-05): `todo_list_parse_insn_buffer` ends a line at LF and drops a final CR; `parse_insn_line` drops leading spaces and tabs (`bol += strspn(bol, " \t")`); `todo_command_info` holds `[TODO_EXEC] = { 'x', "exec" }`; `is_command` accepts the name or the abbreviation before a space, a tab, LF, CR, or the end; `sequencer_parse_todo_command` tries every command before `starts_with(s, comment_line_str)`. So a line whose first word is `exec` or `x` is an exec command whatever `core.commentChar` holds, and a comment line never is one. **documented** (source). An older order with the comment test first would make `x ...` a comment under `core.commentChar=x`; the rule then refuses a line that Git skips, which is a safe refusal and never misses an exec line. Design change: contract Δ3 read 9 and reason `rebase-exec` (plan D7).
- **`git am` state**: `git am --3way` with a conflicting patch leaves `rebase-apply/applying`, which the 001 `stateOf` maps to `unknown`. Every conflict action gives `unknown-operation`. **experiment** (Windows 2.56.0.windows.2).

## R19 Batch 3 and 4 verification (T051, T066)

Run of 2026-10-18 in `C:\Projects\arbareto-l5` on `f003-spec` at a22e924. The `test:all` run used `ARBARETO_WSL_DISTRO=Ubuntu-26.04` and `ARBARETO_TEST_WORKERS=6`. The batch 3 and batch 4 reviews are recorded ("Batch reviews").

| Step | a22e924 |
|---|---|
| `bun install --frozen-lockfile` | 0 |
| `bun run build` | 0 |
| `bun run typecheck` | 0 |
| `bun run export:schemas --check` | 0 |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml` | 0 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | 0: 503 passed, 0 failed, 4 ignored |
| `bun run test:all` | 0. Parallel step: 5,327 pass, 0 fail, 37 skip. Serial step: 395 pass, 0 fail, 9 skip. |
| `bun run test:windows` | 0: 108 pass, 0 fail, 5 skip |

- `ORIGIN`: every line is under `C:\Projects\arbareto-l5`.
- Skips: every skip names a missing capability. The cargo cases that start plink, Pageant, or PuTTYgen return early without `ARBARETO_SANDBOX=1` or without PuTTY, so cargo counts them as passed.
- Two earlier runs were red for setup causes. `static-frame.test.ts` was in no group (fixed on main in 1ed74b0). The shell vector check did not list `sync-result` and `clone-result` (fixed in 55993eb). A test probed a PID that Windows had reused (fixed in a22e924).
- T051 control mutation: without `--no-autostash` in `mergeArgs` (`src/git-service/sync-commands.ts:111`), the FR-029 case of `tests/git/sync-pull.test.ts` failed. After the undo, the file passed (13 of 13).
- T066 control mutation: with the OID pairing check of `src/frontend/state/tracking.ts:41` bypassed, the stale-count case of `tests/contracts/sync-counts.test.tsx` failed. After the undo, the file passed (12 of 12).
- T066 pull target: `tests/git/connect-terminal.test.ts` holds the case "a failed pull fetch under plink keeps one target, and the terminal gets the remote name", and it passed.
- T056 key check: no 001 or 002 action uses Ctrl+Shift+Down, Ctrl+Down, or Ctrl+Up. The case "the sync keys do not change the 001 and 002 shortcut actions" of `tests/contracts/sync-toolbar.test.tsx` checks it against `createShortcutHandler`.
- T064: the 002 frontend exists. `tests/contracts/sync-history.test.tsx` (T057) is in `parallel` and passed: the FR-013 refresh with `{oid}`, the FR-040 refresh after a push, and the FR-019 counts on branch labels. The labels are in `src/frontend/history/HistoryList.tsx`, and `Workbench.tsx` starts the refresh. `HistoryView.tsx` needed no change, and the T064 text now names these files.
- T043 control mutation, 2026-10-17 on a22e924: in the lease branch of `pushArgs` (`src/git-service/sync-commands.ts:88`), `--force-with-lease=<dst>:<expect>` became `--force`. `bun test tests/git/sync-rejected.test.ts` exited 1: 5 pass, 3 fail. The stale-lease case "FR-025: a remote that moved after the last fetch refuses the lease with stale-lease, and the remote keeps every commit and object" received `succeeded` instead of `PUSH_REJECTED` `stale-lease`. The cases "D5: the force-push review reads the tracking OID…" and "FR-025: no push process of this file forces without a lease" also failed. After the undo, `git diff --stat -- src` was empty, and the file bytes equal HEAD. The rerun exited 0: 8 pass, 0 fail, with 18 `ORIGIN` lines, all under `C:\Projects\arbareto-l5`. No other `bun test`, `cargo`, or `test:all` process ran during either run.
- T088: `NATIVE_FIRST` (`src-tauri/src/ipc.rs:69`) holds `clone` and the six settings operations. The cargo tests `a_clone_runs_its_native_step_and_forwards_the_native_payload`, `the_six_settings_operations_are_answered_natively_and_never_forwarded`, and `the_feature_003_rust_checks_refuse_before_any_dialog` pass in this run. Together, the first two cover all seven names: each is answered or prepared natively, and no settings request is forwarded; five names also have a `NATIVE_FIRST.contains` assert.

Ticks: T044 to T051, T052 to T065, T085, T086, and T066 cite this run. Batch 2 ticks T028 and T031 to T042, because their tests are in `tests/groups.json` and pass in this run. T087 and T088 cite this run. T027 and T030 stay open: their Sandbox and PuTTY cases did not run. T043 stays open, although its control mutation passed and the batch 2 review is recorded: its scope includes T027 and T030, whose Sandbox cases wait for T013.

## R20 Batch 5 verification (T074, automated part)

Run of 2026-10-18 in `C:\Projects\arbareto-l2` on `f003-b5-conflicts` at 9b510b3. The `test:all` run used `ARBARETO_WSL_DISTRO=Ubuntu-26.04` and `ARBARETO_TEST_WORKERS=6`. The batch 5 review is recorded ("Batch reviews").

| Step | 9b510b3 |
|---|---|
| `bun install --frozen-lockfile` | 0 |
| `bun run build` | 0 |
| `bun run typecheck` | 0 |
| `bun run test:all` | 0. Parallel step: 5,366 pass, 0 fail, 37 skip. Serial step: 395 pass, 0 fail, 9 skip. |

- `ORIGIN`: every line is under `C:\Projects\arbareto-l2`.
- Skips: the 15 distinct skip reasons are the same as in R19.
- T074 control mutation: with the Continue condition at `src/frontend/sync/ConflictActions.tsx:68` set to `false`, `tests/contracts/sync-conflicts.test.tsx` failed at "Continue is unavailable while the unmerged count is above 0 and states the count (FR-043)": 17 pass, 1 fail. After the undo, the file passed (18 of 18).
- Extra run, not part of T074: `bun run test:windows` had 2 UIA focus failures. This branch predates the main harness fix 353c7c1, which adds the `foreground` capability skip.
- Manual check: the quickstart.md "Manual check in the app" has not run. It needs the user's input.

Ticks: T067 to T073 cite this run and the batch 5 review. T074 stays open until the manual check runs.

## R21 `ssh2` under Bun (P0.3, T007, T008)

Probe of 2026-10-19 in a scratch folder outside the checkout. Host: Windows 11 Pro 10.0.26300. Bun 1.4.3. `ssh2` 1.17.0, the npm `latest`, published 2025-08-20. Git 2.56.0.windows.2. Git's `ssh.exe` is OpenSSH_10.5p1. The repository `package.json` and `bun.lock` did not change.

- **Install**: `bun add ssh2@1.17.0` exited 0. **experiment**
  - `ssh2` 1.17.0 has the optional dependency `cpu-features` `~0.0.10`. Bun installed `cpu-features` 0.0.10. **experiment**
  - Bun ran the `cpu-features` install script (`node-gyp rebuild`). It compiled a native addon in about 30 s. **experiment**
  - The `ssh2` native crypto binding has no build output. `bindingAvailable` is `false`, so `ssh2` uses its JavaScript crypto. **experiment**
  - The Bun 1.4.3 default trusted list holds `cpu-features` and `ssh2`. **documented** (`src/install/default-trusted-dependencies.txt` at `bun-v1.4.3`)
- **Server**: the `ssh2` `Server` listens on 127.0.0.1, port 0. The host key is ed25519 from `utils.generateKeyPairSync`. Sign-in is public key only. The exec handler accepts only `git-upload-pack '/<name>'` and `git-receive-pack '/<name>'`. It runs `git upload-pack` or `git receive-pack` with an argument array. **experiment**
- **Client**: Git `fetch` and `push` with `GIT_SSH_COMMAND` set to Git's own `ssh.exe`. Options: `-F <owned empty file>`, `-i <test key>`, `UserKnownHostsFile=<owned file>`, `GlobalKnownHostsFile=/dev/null`, `StrictHostKeyChecking=yes`, `BatchMode=yes`, `IdentitiesOnly=yes`, and `IdentityAgent=none`. `GIT_CONFIG_GLOBAL` and `HOME` name the scratch folder, and `GIT_CONFIG_NOSYSTEM=1` is set. No path names `~/.ssh`. **experiment**
- **Results**: three runs gave the same results. **experiment**
  - Fetch with the allowed key: exit 0. The fetched ref equals the source HEAD. The connection counter rises by 1.
  - Fetch with another key: exit 128. No ref is written. The connection counter rises by 1.
  - Push to the bare remote: exit 0. The remote ref moves to the new commit. The connection counter rises by 1.
  - The owned known-hosts file has equal bytes after the runs.
  - The server received only the two exec commands above.
  - Each run printed `RESULT pass` before the 90 s guard timer of the probe.
- **Result**: pass. `ssh2` 1.17.0 runs under Bun 1.4.3 as a local SSH server for Git's `ssh.exe`.
- **Not checked**: the probe did not list `~/.ssh`, and it did not list processes after a run. T010 checks that stop leaves no process.
- **O-5 record (T008)**: the reviewer default applies. T011 adds the test devDependency `ssh2` 1.17.0 (plan.md O-5).
- **User decision, 2026-10-19**: the repository `bun install` must not build the optional `cpu-features` native addon. `ssh2` works without it, because it uses its JavaScript crypto. The build needs a C++ toolchain on every development computer.
  - Mechanism: `"trustedDependencies": []` in `package.json`. **documented** (Bun docs, "Lifecycle scripts", bun.com/docs/pm/lifecycle, read 2026-10-19)
  - The docs state: a defined `trustedDependencies` replaces the default list. An empty array allows no package scripts, also none from the default list. `bun install --frozen-lockfile` then ignores the default list. **documented** (same page)
  - `bun.lock` has no `trustedDependencies` entry for the empty list. The empty list in `package.json` still blocked both install scripts: `bun install` printed "Blocked 2 postinstalls", and `node_modules/cpu-features/build` does not exist. `bun pm untrusted` reports 0 untrusted dependencies with scripts, but the install reports 2 blocked postinstalls. **experiment** (T011, Bun 1.4.3, 2026-10-19)
  - Bun 1.4.4 writes `"trustedDependencies": []` into `bun.lock`. The empty list still blocks both install scripts. After `bun install --frozen-lockfile` in a fresh folder, `node_modules/cpu-features/build` does not exist. `bun pm untrusted` lists the blocked `install` scripts of `ssh2` 1.17.0 and `cpu-features` 0.0.10. **experiment** (T390 follow-up, Bun 1.4.4, 2026-10-23)
  - The `--ignore-scripts` flag and `install.ignoreScripts` in `bunfig.toml` also stop all lifecycle scripts. They are not used, because the flag must be on every install, and the repository has no `bunfig.toml`. **documented** (same page)
  - Today no installed package of the repository declares a `preinstall`, `install`, or `postinstall` script. So the empty list blocks no script that the repository uses. **experiment** (`node_modules` listing of the main checkout at 6593305, 2026-10-19)
  - T011 check: after `bun install`, `node_modules/cpu-features/build` does not exist.
- **T007 rerun, 2026-10-21**: a second probe in a scratch folder outside the checkout passed. Bun 1.4.3. `ssh2` 1.17.0, the newest npm release, published 2025-08-20. Git 2.56.0.windows.2. Client `OpenSSH_10.5p1, OpenSSL 3.5.9`. **experiment**
  - Install: `bun add ssh2@1.17.0` with `"trustedDependencies": []` exited 0. Bun printed "Blocked 2 postinstalls", and `node_modules/cpu-features/build` does not exist. So no lifecycle script ran, and `ssh2` uses its JavaScript crypto.
  - Fetch: the server on 127.0.0.1 had a generated ed25519 host key and checked the client key signature. Git's `ssh.exe` used `-F none`, `IdentitiesOnly=yes`, `IdentityAgent=none`, an owned `UserKnownHostsFile`, `GlobalKnownHostsFile=none`, `StrictHostKeyChecking=yes`, and `BatchMode=yes`. Each of the client key types ed25519, rsa-3072 (sha256 signature), and ecdsa-p256 fetched 3 of 3 times with exit 0, so 9 of 9 fetches passed. `FETCH_HEAD` equals the seed commit.
  - Refusals: a known-hosts file with another host key gave exit 128. A client key that the server does not accept gave exit 128. `~/.ssh/known_hosts` did not change.
  - Exit status: with `child.stdout.pipe(channel)`, every fetch exited 1, although the pack arrived. The pipe ends the channel before `channel.exit(code)` sends the exit status, so `ssh` exits 255. The server must pipe with `{ end: false }` and send `exit(code)`, then `end()`, on the `close` event of the child. `tests/support/ssh-server.ts` (lines 197 to 204) does this.
  - Not checked: an SSH agent, Pageant, `.ppk` keys, plink, and keys with a passphrase.
- **O-5 result (T008)**: the T007 rerun confirms the record above. The test devDependency stays `ssh2` 1.17.0, installed without lifecycle scripts. T007 and T008 tick together with T010.

## R22 Main full run 5 (cc73e83)

Run of 2026-10-21 in `C:\Projects\arbareto-l3` at cc73e83, clean tree. Main c36f81e is cc73e83 plus documents. `bun run test:all` exited 0: 7,230 tests, 0 fail, 50 skip. `cargo test --locked` exited 0: 553 pass, 4 ignored. Every `ORIGIN` line in the two logs is under `C:\Projects\arbareto-l3`. The JUnit reports are `parallel.xml` and `serial.xml` of that run.

- T089: `tests/git/remote-facts.test.ts` "(d) D4 destination equals push --dry-run --porcelain" and `tests/wsl/sync-wsl.test.ts` "(d) D4 destination equals push --dry-run --porcelain" pass. Each prints `match=true` for every `d.push.autoSetupRemote*` and `d.remote-without-url+insteadOf` line. `d.remote-without-url` and `d.push-remote-dot` print `match=false`, as R16 (d) accepts and decides.
- T090: `tests/git/remote-facts.test.ts` and `tests/wsl/sync-wsl.test.ts` "(m) non-boolean mirror, skipFetchAll, skipDefaultUpdate, prune, and pruneTags values, a valueless pushRemote, and an empty branch subsection" pass. The `m.empty-branch-subsection.remote`, `.push-record`, `.fetch-r1`, and `.push-dry-run-r1` lines print `match=true` on Windows and in the distro. `tests/contracts/sync-rules.test.ts` "an empty branch subsection refuses for every variable and value" passes.
- T091: the (d) fact lines of the 12 `push.autoSetupRemote` variants and of `single-remote-up`, `two-remotes-without-origin`, and `two-remotes-with-origin` print `match=true` on Windows and in the distro. Only `matching`, `mirror`, `two-push-urls`, and `push-remote-dot` differ, and each carries its `deliberate` reason. `tests/contracts/sync-rules.test.ts` passes "simple, unset, upstream, and tracking pre-fill refs/heads/<branch> on the push remote", "matching gives the panel and nothing gives no pre-fill", "any true entry sets the flag, and a false entry does not clear it", "an invalid value gives invalid-config, also with an upstream", "merge entries count only with branch.<name>.remote (remote.c set_merge)", "upstream and tracking compare the push remote with the fetch remote", "a push remote . gives local-push-remote (R16 d)", "the default remote is the branch remote, else the only remote, else origin", and "a single remote is the push and the fetch remote without branch.<name>.remote". `tests/contracts/sync-contract.test.ts` passes with the reason `local-push-remote`.

Ticks: T089, T090, and T091 cite this run. T027 and T030 stay open: cargo captures the `SKIP sandbox` and `SKIP putty` lines, so no record shows that their Sandbox and PuTTY cases ran.

## R23 SC-010 mapping review (T081)

Review of 2026-10-21 at c36f81e. Read only. Scope: the Coverage rows of FR-005 and SC-010, the outcome assertions of `tests/git/sync-fetch.test.ts`, `sync-push.test.ts`, `sync-rejected.test.ts`, `sync-trust.test.ts`, `sync-pull.test.ts`, `tracking.test.ts`, and `clone.test.ts`, and the code that decides each outcome in `src/git-service/sync.ts`, `sync-review.ts`, `sync-parsers.ts`, `sync-integrate.ts`, `tracking.ts`, `clone.ts`, and `resolve.ts`.

- Exit codes: `GIT_FAILED`, the fetch state of each remote, a clone, and Continue come from exit status 0 or not 0. `no-skip-commit` and the theirs side of a conflict come from exit 2 of `git show-ref --exists` (git-show-ref(1)).
- Machine-readable output: push states, `PUSH_REJECTED` reasons `rejected` and `remote-rejected`, and created, updated, and deleted refs come from the `--porcelain` flag and summary fields (sync-parsers.ts `PUSHED`, `REFUSED`, the fetch flags). `stale-lease` is a `[rejected]` status of a push with a lease (contract Δ3, Δ9). The D4 destination comes from `for-each-ref` `%(push)` and `config -z` entries. `MALFORMED_GIT_OUTPUT` is any record outside the contract Δ3 grammar.
- Repository reads: `completed-with-effects`, the observed list, `STALE_REVIEW`, and the pull decision come from ref listings, `rev-list --left-right --count`, HEAD, and the operation state read after each process.
- OS facts: `canceled` needs a process without an exit status, and `destinationFacts` and the PuTTY version come from OS reads.
- Tests: every `toContain` on `outputTail` checks shown text or redaction beside an asserted code. No test outcome comes from a text match.
- Contract time limits: `DEADLINE`, the stall notice, and the Pageant `not-ready` reply come from the contract bounds `PROCESS_LIMITS` and 30 s. These are contract values, not a classification. The effects after them come from repository reads.
- Finding: `readTracking` takes `gone` and the counts from `%(upstream:track,nobracket)`. ref-filter.c translates these words (`msgs`), and only `LC_ALL=C` keeps them English. A translated word fails the `TRACK` grammar and gives `MALFORMED_GIT_OUTPUT`, so no wrong state results. The translation proof R16 (c) stays **unverified**. The counts equal `rev-list --left-right --count` in `tracking.test.ts` (SC-003).
- No outcome comes from a message text, a remote text, or a timing measurement.

T081 stays open: it depends on T074, which waits for the manual check (R20).

## Batch reviews

Each batch verification task passes only after one independent review of its batch is recorded here.

**Batch 1, 2026-10-13.** Independent batch 1 review, reviewer agent (Opus), 2026-10-13. Scope: commits 19f741a, f3ae46d, 353204e, e390780, 5428fa9, f104885, and d01861c (T014 to T024, T026, T029) on f003-spec at 8087fe4, for `sync-commands.ts`, `sync-parsers.ts`, `clone-name.ts`, `file-action.ts`, the `src/contracts/` deltas, the schemas and vectors, the shell files, `bridge.ts`, and their tests, without the merges of main. No test ran in the review. Verdict: fix first. Items and state, all fixed in ea807f9: D4 gave a destination for `simple` (same remote) and `upstream` with two `branch.<name>.merge` values, and Git refuses that push with exit 128; D4 now gives `several-merge-refs`; a lease commit above `HISTORY_COMMIT_OBJECT_BYTES` had no valid form, and the `Lease` subject is now nullable (read 6, data-model §2); a valueless key that remote.c `handle_config` reads as a string stopped `git remote`, `for-each-ref`, and `git push`, and every review now refuses each key of that list with `invalid-config` (R16 m, probe on 2.56.0.windows.2); the shell admitted a `remote` or `integrate` run for any started mutation, and now admits it only for an operation of kind `sync`. The portability scan hit of the T025 run is also fixed in ea807f9 (R17). Pass: every argv builder matches contract Δ3; every parser reads exact Git output and no message text; the D6 decision follows builtin/pull.c; Constitution I holds; the `remote` and `integrate` policies match contract Δ7 on Windows and in WSL; the shell allowlist and grants are complete. Open: T030 and T031 add `clone` and the six settings operations to `NATIVE_FIRST`, so the Rust clone URL rule and the `chooseSyncPath` rule run for them; an empty branch name (`[branch ""] remote = o`) also stops Git, and no rule or test covers it (owner: T040); `clone-name.ts` imports `native-path.ts`, which uses `process`, so the renderer cannot import it, and T070 (`CloneDialog`) needs a renderer-safe drive-prefix rule first. Not verified: the `push.autoSetupRemote=true` pre-fill; a `branch.<name>.remote` that names a remote without a URL (`is_same_remote` with NULL); a push remote `.` gives `remote-missing`.

**Batch 2, 2026-10-17.** Independent batch 2 review, reviewer agent (Opus), 2026-10-17. Scope: commits 7f17e52, cd1a40b, 210a873, and 24035fa, with the merges e3ac665 and b023d07 (T027, T028, T030 to T042), on f003-spec at 24035fa. No test ran in the review. Verdict: fix first. Blocking: a fetch runs a repository-controlled `core.alternateRefsCommand` through the shell, and the `sync` class does not count it (`trust.ts` `programKey`, plan D11); a probe on 2.56.0.windows.2 with `objects/info/alternates` wrote the canary. Blocking: `PUSH_REJECTED` carries no reason, because the `SyncResult` schema has no reason field, so `stale-lease` never goes out (T042, contract Δ3 and Δ9, data-model §8). Open: a fetch-all `PUTTY_UNAVAILABLE` after a fetched remote has no `reason`, `program`, or `path` (`sync.ts:308-315`); an empty branch subsection still gives `GIT_FAILED`, not `invalid-config` (batch 1 item, owner T040); Cancel waits up to 30 s for the `pageant` reply, so record the contract gap or add a cancel frame; `STALE_REVIEW` has a test only for the lease, so add cases for HEAD, the remote list, the push URL, the token repeat, and `pageant` per remote in fetch-all; contract Δ3 does not list the `--set-upstream` stdout line that `pushLines` drops (resolved later: fbe50a6 drops `--set-upstream`). Pass: the argv equals Δ3; no force without a lease; the trust gate runs at review and at `sync`; the five-key check runs before `git remote`; each bound value is re-read; no decision uses message text or timing; output tails, plan URLs, and trust values are redacted; logs hold no URL; `pageant` goes before each remote on a Windows Git only; a connect target exists only for a reply other than `git`; the shell `sync`-kind rule and the clone exemption hold; clone contexts stay held until `closeJob`; `terminal` takes no path; `NATIVE_FIRST` holds `clone` and the settings operations; PuTTY programs start only under the Sandbox gate; no registry writes; the tests use real Git; the T043 control is meaningful. Not verified: a repeated `pageant --encrypted` for a held key; PowerShell 5.1 passing of a target with `"`; `trackingOf` against remote.c.
Resolution: acc663d fixes `core.alternateRefsCommand`, the `PUSH_REJECTED` reason, the fetch-all PuTTY fields, and the empty branch subsection, and adds the new `STALE_REVIEW` cases. 37184d5, 823a6e3, and 6b87eb2 fix the remote helpers and `insteadOf`. The `pageant` Cancel item is a contract gap: contracts/operations.md "Contract gaps" states "A Cancel during the `pageant` wait has no effect until the shell replies, at most 30 s. No frame stops that wait."

**Batch 3, 2026-10-17.** Independent batch 3 review, reviewer agent (Opus), 2026-10-17. Scope: 75babcb (T044 to T050) and the merge afeb61a. Verdict: no blocking finding and no heuristic. Items and state, all fixed in b2ae641: fetch and pull now use one fetch path; success needs a normal operation state; the pull mode binding; the reason `unknown-operation`; the text for an unreadable todo; the `index.lock` test. Found during batch 3 and fixed in 75babcb: the `rebase-exec` rule (R18).

**Batch 4, 2026-10-17.** Independent batch 4 review, reviewer agent (Opus) with `web-design-guidelines`, 2026-10-17. Scope: the service fbe50a6..f003-b4-svc (T052 to T055) and the UI 24035fa..3c31e8a (T056 to T065, T085, T086). Verdict: the service is clean. UI items, fixed in 8ad76df: the force push fails closed; Commit and push works on an unborn branch; the push waits for the reconcile read; the accessibility fixes. Service fixes are in bb2c634. The connect target fact is in 16d5644.

**Batch 5, 2026-10-18.** Independent batch 5 review, reviewer agent (Opus) with `ponytail-review`, `web-design-guidelines`, and the `arbareto-ux` rules, 2026-10-18. Scope: 0bdcb3c..a9be3a1 (clone and settings UI) and 4d52e81..f003-b5-conflicts (pull mode choice, conflict actions, Mark resolved). Verdict: no security finding and no heuristic. Fix first, fixed in 9b510b3: three new test files were in no group; a new `tests/groups.ts` check now runs in every contracts run through `tests/contracts/groups.test.ts`. Medium, fixed in 9b510b3: the clone panel could close while a clone ran; the pull mode row could go stale. Low, fixed in 9b510b3: Continue during a loading status read; Cancel before the operation ID; Clear plink while plink is in use; an arrow key opened the plink picker; two D12 contradictions; an unused ref; the mode row took focus from an editable field. Fixed earlier: `connectTarget` replaced the Connect in a terminal inference (16d5644). Also in this batch: in 77a979c, the Pull reason checks the operation state before the HEAD form, as contract Δ3 does.
