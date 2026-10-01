# Quickstart: Qualification Validation

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Results**: [research.md](research.md)

## Current design and prerequisites

**Design decisions are resolved.** Use the protected candidate protocol for hunks and files and the user's approved standard Git commit policy.

No application, package manifest, build scripts, or executable test suite exists. This guide defines future validation. Commands below require implemented files and verified tools; planning did not execute them.

Proceed through `/speckit-tasks` and `/speckit-analyze` before implementation. Preserve exact hunk checks, approved hooks, and honest late-change outcomes. Do not substitute whole-file staging for a refused hunk, disable hooks, or mark unexecuted tests passed.

## 1. Confirm scope and prerequisites

Use Windows 11 x64. Keep Windows Defender enabled. Use the reference hardware and the separate clean-install environment defined in `plan.md`: a disposable clean Windows 11 x64 environment, a Hyper-V VM or Windows Sandbox.

Reuse the selected Git installation and existing development tools. Do not change global Git configuration, identity, signing, helpers, PATH, or agents.

WSL rows (§8) need a WSL2 distro with a systemd user manager, `setsid` from util-linux, and Git 2.55.0 or later. The user installs them. Never install, update, or configure WSL or a distro for qualification.

Submodule rows (§9) use local bare remotes under the owned fixture root only. No step fetches from the internet. The fixture's owned global file sets `protocol.file.allow=always`. The app never sets it, and the developer's global configuration never gets it.

Read-only inventory commands are available now:

```powershell
git version --build-options
bun --version
rustc --version
cargo --version
```

Compare them with the minimum versions in `plan.md` Technical Context; Bun must be exactly `1.4.2`. Find the MSVC toolset and Windows SDK versions with the Rust link probe in `research.md` R6. Check the selected Git path separately through application setup after implementation.

Before building, verify:

- Bun exactly `1.4.2`. At least the `plan.md` minimum versions: Rust/Cargo `1.98.0`, native cargo-tauri `2.12.0`, MSVC toolset `14.51.36231`, and Windows SDK `10.0.26100.0`.
- Minimum-version dependency declarations, an exact Bun version, and committed Bun/Cargo lockfiles.
- Selected SDK version, native imports, development-only Node requirements, and third-party notice obligations.
- Frontend build compatibility under Bun, without an accidental Node shebang fallback.
- An owned temporary fixture root and isolated fixture configuration.

Fixture runs on the reference host (T149, T153, T160 to T163) start the app only with `bun tests/windows/installed-app.ts --launch <root>`. The launcher points `HOME`, `XDG_CONFIG_HOME`, and `GIT_CONFIG_GLOBAL` into the owned root. It removes Git identity and configuration-injection variables. The developer's global hooks, signing, and identity then never apply to fixtures. System configuration stays active; record its origin and digest. T151 belongs to batch 4, so the T149 smoke run uses the launcher too. The T155 clean environment and the T165 measurement account are isolated by design and do not use the launcher.

Do not install duplicate tools automatically. A missing toolchain component is a prerequisite, not a passing build result.

## 2. Future build and service checks

Run these commands only after implementation adds their required files. They describe standard tool invocations, not existing project scripts.

Run them in this order, as T149 does:

```powershell
bun install --frozen-lockfile
bun run build:notices
bunx --bun tsc --noEmit
bun test tests/contracts tests/git
bun run build
cargo test --locked --manifest-path src-tauri/Cargo.toml -- --show-output
cargo tauri build --target x86_64-pc-windows-msvc --bundles nsis -- --locked
```

`build:notices` runs before `tsc`, because the About window imports the generated `notices.json`. `bun run build` runs before `cargo test`, because Tauri reads `frontendDist` and `externalBin` at compile time (T065). Before T130 exists, skip `build:notices`. T065 runs `bun run build` before the tests, because `tests/windows` needs the sidecar.

`bun run build` runs `build:notices`, then `bunx --bun vite build`, then these two service steps:

```powershell
bun -e "if (Bun.version !== '1.4.2') { console.error('Bun 1.4.2 required, found ' + Bun.version); process.exit(1) }"
bun build src/git-service/main.ts --compile --target=bun-windows-x64 --no-compile-autoload-dotenv --no-compile-autoload-bunfig --no-compile-autoload-tsconfig --no-compile-autoload-package-json --outfile src-tauri/binaries/arbareto-git-x86_64-pc-windows-msvc.exe
```

The implementation must create the output directory and configure that exact sidecar path. Build configuration must package local frontend, worker, theme, grammar, and WASM assets. Build a qualification package only when `git --no-optional-locks status --porcelain --untracked-files=all` prints nothing. The explicit option overrides a user `status.showUntrackedFiles` value. A dirty build shows the `-dirty` marker and never counts as evidence.

Do not use a Vite development server for release qualification. Do not add the Tauri shell plugin or Node runtime to make an unverified path appear successful.

Expected checks:

- Contract tests reject malformed frames, unknown operations, forged IDs, hostile paths, oversized output, and credential-bearing diagnostics.
- Service tests use real Git and owned disposable repositories. Every mutation verifies index, working-file, reference, and operation-state results.
- Native tests verify quoting, intended handle inheritance, suspended creation, Job assignment failures, and independent cancellation.
- The compiled service ignores hostile repository startup files and runtime-control environment variables.
- The release bundle contains no development server, Node executable, unnecessary native build tools, or missing runtime assets.

A blocked or failed check remains blocked or failed. Do not change a budget or skip a safety assertion to obtain a green result.

## 3. Install as a standard user

Perform this stage in the clean-install environment. Do not uninstall Node, Bun, Git, or WebView2 from the developer's workstation.

1. Record the OS image, account privileges, Defender state, package path, and SHA-256 digest. Record the installer's Zone.Identifier stream. Run one case with an Internet zone mark, and record the SmartScreen prompt. Record SmartScreen behavior for a file without a Zone.Identifier. Do not change SmartScreen settings or policy.
2. Confirm that the Windows Apps entry reads “Arbareto (Unsigned local test package)” unless signing was separately verified. Record the installer file name.
3. Install the NSIS current-user package without elevation.
4. Confirm installation stays in the expected user location and uses user-scoped registration.
5. Start the installed executable, not the build directory or development launcher.
6. Select installed Git for Windows explicitly. Verify the displayed path and version.
7. Copy the F02 fixture and the F07 worktree pair from the reference host with their SHA-256 manifest. Verify the copies with `Get-FileHash`. Offline, stage a hunk, unstage a hunk, stage and unstage a file, and commit in both. Copy them back and verify them with `bun tests/windows/make-fixture.ts --snapshot` on the host. Confirm ordinary operations require no cloud account or network after prerequisites exist.
8. Upgrade over the previous package, then uninstall with and without Delete app data. Confirm that data folders, fixtures, and Git configuration match each expected result. Record the default state of the Delete app data option. Then reinstall.

Run separate cases with missing Git, missing WebView2, a Git version below the minimum, a WebView2 version below the minimum, and a changed selected executable. Windows 11 includes the Evergreen WebView2 Runtime. Record the missing-WebView2 case as `unverified` unless a Windows 11 image without the runtime exists.

Apply the Git and WebView2 minimum versions in `plan.md`. Admitted versions permit tests but remain unqualified until evidence passes. Versions below the minimum and unparseable versions must return the specified unsupported error and block dependent behavior.

Use adjacent version strings for deterministic policy tests. Use separately verified installations or disposable images for packaged rejection tests. For Git and WebView2, the rejected case is a version below the minimum. Never alter the developer's runtimes to create these cases.

Expected result: clear prerequisite guidance or a blocked state. A blank window, hidden download, unexpected elevation, or silent Git substitution fails qualification.

Inspect final PE dependencies. Record WebView2 as a preinstalled requirement. Record all build-time downloads separately from end-user prerequisites.

## 4. Inspection and hunk scenarios

Use F01–F11, F15–F17, F19, F20, and F32 from `plan.md`. The fixture helper must refuse paths outside its owned temporary root. Every open starts in History; press Ctrl+1 for the Changes steps.

1. Open an ordinary fixture and each linked worktree.
2. Compare paths, HEAD, status, and the first 100 history rows and parent relationships with independent Git observations.
3. Verify linear, merge, octopus, skewed-date, cutoff, and shallow graphs. Missing parents must not become invented roots.
4. Select staged, unstaged, and untracked entries. Verify their comparison baselines.
5. Verify Unicode/spaced/option-like paths, LF/CRLF, additions, deletions, and staged-deletion/untracked-replacement states.
6. Confirm unsupported files, sparse/split indexes, registered index-change hooks, and executable monitors refuse hunk mutation without bypasses. Set `core.splitIndex=true` at local scope in an F10 copy with an unsplit index. Confirm reason `split-index` for hunk and file actions, and confirm that no `sharedindex.*` file appears in the Git directory.
7. Stage one of two supported hunks with existing staged changes through the protected candidate protocol.
8. Compare exact resulting blobs, modes, stages, flags, and every unrelated logical index entry.
9. Compare every fixture working-file byte. Repeat for unstaging, unborn repositories, and separate worktree indexes.
10. Change files, index, HEAD, attributes, and configuration before each validation checkpoint. Require refusal without canonical index publication.
11. Change a working file after final validation. In the installed build, `bun tests/windows/make-fixture.ts --late-write` writes when publication replaces the index. Verify preservation of the external bytes and truthful late-change reporting.
12. Exercise graph data/layout limits. Retain usable row metadata, disclose the limit, and never fetch missing objects. A layout limit shows node-only cells and the scope-line text "Graph layout limited" with its reason. Then run the F32 mode-switch steps of `plan.md` (SC-012).
13. Stage file: stage a modified binary file, an untracked file, and a deleted file in F02, F05, and F06 copies. Stage each F04 line-ending case. Unstage file: unstage a staged binary file and a staged rename. Compare each index with `git add`, `git restore --staged`, or `git rm --cached` in a disposable copy. Compare every working-file byte. Stage the 512 MiB F16 file and record the time; the larger file shows reason `size`.
14. Change the working file after you select Stage file, and change the staged entry after you select Unstage file. Require `STALE_SELECTION` without canonical index publication. Confirm that symbolic links, submodules, and filtered files refuse with their reason, and that no filter canary runs.
15. Stage the F04 file whose `eol` attribute only the index holds. Confirm reason `blob-proof` with the copyable `add` command, and no canonical index publication. Run the command in PowerShell, and compare the result with `git add` in a copy. Stage the F04 mixed file under `core.safecrlf=true`. Confirm `GIT_FAILED` with Git's output tail as plain text and the `add` command.

Capture state through documented Git protocols and raw file-byte digests. Do not use the application's own parser as the only test oracle.

A matching exit code or screenshot is insufficient. Record exact expected and actual index/tree identities and byte digests.

Do not remove foreign locks, suppress hooks, relocate a selected hunk, or substitute a whole-file action for a refused hunk.

## 5. Commit scenarios

Use F01, F11–F13, F17, and F20 with the approved standard Git handoff design.

1. Review the complete staged scope, including externally staged unsupported files, without index writes or trial commits. Focus starts on Commit staged changes, the default button. Enter commits, and Escape cancels.
2. Verify the review explains approved hooks and possible changes during execution.
3. Enter a nonblank Unicode message and start one ordinary canonical Git commit.
4. Verify parent, destination, tree, message, index, and working bytes against the retained review and fixture expectations.
5. Repeat for the first commit in an unborn repository.
6. Test blank messages, empty scope, missing identity, rejected hooks, denied trust, and signing failure. Start the missing-identity case with `--no-identity`. For a rejected hook, confirm that the app shows the bounded output tail as plain text. Run the displayed remedy command in PowerShell. Confirm that the hook output appears there and that no commit is created. Commit with each F11 terminal-input hook. Each commit shows `HOOK_FAILED` within 10 seconds, and no console window appears (contract §6 "Console and input").
7. Change index/checkout state before handoff, including same-OID branch changes. Require refusal and renewed review.
8. Change state after handoff or through approved hooks. Preserve canonical hook effects and report `completed-with-effects` results without ordinary-success styling.
9. Interrupt before and after publication. Identify actual effects or explicit uncertainty; preserve the draft and never retry automatically.
10. Type newer draft text while Git runs, then switch to History. Completion must not clear those newer edits.
11. Submit a second `commit` with the same review token, and lose a response. The second request returns the first operation's state and `operationId`. Confirm that one Git commit invocation runs.
12. Create ambiguous attribution with another Git process. Require unknown state rather than assigning an unrelated HEAD to this request.
13. Exceed each attribution evidence limit independently: 4 MiB or 10,000 aggregate reference/reflog records. Require unknown state without treating truncated evidence as sufficient.
14. Make status refresh succeed while required attribution remains unknown. Keep mutations blocked until explicit recovery refresh completes the required reconciliation. That refresh states the unknown outcome, and then mutations become available.
15. In the F17 variant whose HEAD commit lacks a blob, commit a staged change. Git runs with `--quiet`, runs every hook, and exits 0. The outcome is `succeeded`, and the uploadpack canary never runs.

Expected result: stable fixtures produce the intended commit. Changed completed results use completed-with-effects; failed executions with effects use failed-with-effects. Unknown state blocks further mutation until successful reconciliation.

Preflight is not atomic with Git execution. Do not add private-index commit publication, injected hooks, automatic rollback, or a false immutable-snapshot claim.

## 6. Cancellation and external changes

Use F13–F18 and F20. Controlled barriers may delay real Git execution; they must not replace it with a mock.

- Cancel a slow read while another read remains active.
- Cancel mutation activity near each publication boundary.
- Close during idle, read, mutation, and reconciliation states.
- Verify the choice to stay open and the explicit interruption warning.
- Crash the service and shell separately.
- Interrupt and close during a commit, then start again. Confirm State unknown and blocked mutations until an explicit refresh.
- Use Restart service with no running operation. Confirm State unknown and blocked mutations until Refresh in the new session. End the WebView2 renderer and use Reload window. Confirm that the page joins the current session.
- Dismiss the recovery marker of a deleted repository through its native confirmation. Confirm that Escape keeps the marker.
- Approve trust through the native confirmation, then restart the application. Confirm that no new approval appears. Change the trust policy, and confirm Trust changed. Revoke trust, and confirm Trust required after a restart. Approve trust in a repository above a program-file digest bound. Confirm that the native confirmation says the approval lasts until Arbareto closes or its Git service restarts. After Restart service, and after an application restart, confirm Trust required.
- Run descendant-spawning fixture hooks and an unrelated Git process with the same executable name. Include a hook grandchild that holds no inherited pipe and outlives its parent.
- Commit with a `post-commit` hook that starts a sleeping background child. The child inherits stdout and stderr and writes to both after Git exits. Confirm that the outcome appears at Git's exit and that the child still runs. Confirm that a refresh succeeds. Close the application. Confirm that no prompt appears and that the child ends within five seconds.
- Repeat with a child that holds the current branch ref lock. Confirm that the next commit fails with the lock path and the lingering process count. Revoke trust, and confirm that the child ends and the count appears.
- Verify no unintended owned process remains after five seconds. Verify unrelated processes and existing agents survive.
- Suppress a watcher notification, then regain focus or request manual refresh.
- Complete external file, index, and reference changes in the foreground. Require visible reconciliation within two seconds.
- Deliver an old comparison response after a newer selection. Confirm it cannot replace the current view.
- Run two instances on one repository. Commit in instance A with an F14 `pre-commit` hook that sleeps 600 seconds. While it runs, stage a hunk and a file in instance B. Do this on the same worktree and on a linked worktree. Confirm `BUSY` with the cross-instance remedy, and no index change. Record whether both instances share one WebView2 browser process.
- Type a draft and wait 1 second. End the renderer and use Reload window. Then end the WebView2 browser process and use Restart Arbareto. Then use Interrupt and close during a commit, and then close normally. After each step, confirm that the draft returns. After a successful commit, and after Clear message, confirm that a relaunch shows an empty message field.

If reconciliation cannot finish within five seconds, report unknown state explicitly. Do not report rollback or allow another mutation.

## 7. Native interface and accessibility

Test the installed application at 100%, 150%, and 200% scaling. Use two real displays for mixed-scale transitions.

Verify:

- Folder-dialog accept/cancel and focus restoration.
- Unicode clipboard round trips and native text selection.
- IME composition without accidental commit or shortcut activation.
- Keyboard-only repository inspection, hunk navigation, review, cancellation, and dialog operation.
- Visible focus inside and outside the diff's shadow root.
- Stable focus and selection during virtualization, refresh, and row removal.
- Non-color cues and rendered contrast from 200% lossless captures (`tests/windows/contrast.ts`).
- Accessible names of controls, native semantics, and visible text labels.
- Live status announcements: Deferred to a later feature; not a qualification check in this slice.
- Narrator navigation: Deferred to a later feature; not a qualification check in this slice.
- Pointer and keyboard panel resizing, Windows snapping, and reachable controls in both densities and themes.
- Graph-row alignment, controlled selection, keyboard parent inspection, and non-color ancestry information.
- Root, page-boundary, shallow-boundary, wide-lane, and graph-only limitation states.
- Every state in the `plan.md` "Required visible states" table.
- Offline worker/highlighting behavior and a bounded readable fallback after worker failure.
- About Arbareto opens offline from the Help menu by keyboard. Every legal notice and third-party notice is reachable, and focus returns to the Help menu button.
- Verify that these reload, find, and print keys start no browser action: Ctrl+R, Shift+F5, Ctrl+F5, Ctrl+Shift+R, Ctrl+F, F3, Ctrl+G, and Ctrl+P. Verify the same for these zoom, navigation, and tool keys: Ctrl+plus, Ctrl+minus, Ctrl+0, Ctrl+wheel, Alt+Left, Alt+Right, F7, Ctrl+J, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C, and F12. Verify that F5 and Escape still reach the page, and that no draft is lost. Record when `AreBrowserAcceleratorKeysEnabled` takes effect relative to first navigation. Record whether pinch zoom stays off.
- Right-click and Shift+F10 on the page open nothing. In editable text and on selected text, the menu shows only Cut, Copy, Paste, and Select all as applicable.
- F10, and Alt pressed alone, focus the first header menu. Arrow keys move, and Escape returns focus. AltGraph text entry never moves focus.
- F6 and Shift+F6 reach every visible section in the plan.md order, in each window profile.
- The first loaded frame after opening a repository shows History with rows, graph, counts, and no selected commit. Ctrl+1 then shows Changes in the No selection state. Background polls show no Refreshing marker.
- Set the Windows Text size to 150% and to 225%. Interface text grows by that factor without clipping. Every essential action stays reachable, by scrolling in the constrained profile where needed.
- In the commit message field, F6, Shift+F6, F10, a lone Alt press, and F5 work. F5 keeps the draft. Ctrl+1, Ctrl+2, Alt+Up, and Alt+Down change nothing there.
- Review commit, Trust, and Update submodules clamp to a 720×480 window at 200%. Their content scrolls, and their buttons stay visible.
- A selected file or commit row shows its selection marker. HEAD and branch labels show as outline badges. Root, outside-page, and shallow graph ends differ by shape and text.

Use the content sizes and UI-01–UI-19 capture cases in `plan.md`. Capture the installed application with actual fixture states. A browser screenshot cannot pass these native scenarios.

## 8. WSL repositories

Prerequisite: a WSL2 distro that runs its systemd user manager and holds Git 2.55.0 or later. The reference distro `Ubuntu-24.04` has Git 2.43.0. So every row below that needs Git 2.55.0 stays `unverified` until the user installs a newer Git in a distro. Never install it, update WSL, or change a distro configuration for these tests. Use F21 to F26 from `plan.md` in the distro's `/tmp` only. Remove them afterwards. The distro's own global and system Git configuration applies to Linux Git. Use a dedicated test distro when one exists. Otherwise record the origin and SHA-256 of that configuration before and after the run.

1. Record the WSL version, the distro name and GUID, the distro Git path and version, and `systemctl --user is-system-running`.
2. On the reference distro now: open an F24 copy. Confirm the refusal "Git 2.43.0 in Ubuntu-24.04 is older than 2.55.0" and that no Git work starts. This row does not need Git 2.55.0.
3. Open a path under a distro name that WSL does not list. Confirm reason `distro-missing`. In the clean-install environment without WSL, confirm reason `wsl-missing`. A distro without `setsid` gives reason `no-setsid`; record that case as `unverified` when no such distro exists.
4. Open F21 through `\\wsl$\`, `\\wsl.localhost\`, an upper-case prefix, and a lower-case distro name. Confirm one workspace, the "WSL: <distro>" label, and the native Git confirmation with the distro Git path and version.
5. Repeat §4 steps 1 to 15 and §5 steps 1 to 8 with F21 copies. Compare each result with the distro's Git. Record the UNC replace result for publication.
6. Stop the dedicated test distro yourself with `wsl --terminate <test distro>`, never a working distro. Open its F22 copy, and press Cancel during "Starting WSL distro". Confirm the unchanged workspace. Open it again, and record the start time.
7. With F25, run a commit whose `post-commit` hook starts a plain, a `nohup`, and a `setsid` child. Confirm that all three keep running after Git exits, as on Windows, and that the outcome counts three. Commit again with the F25 hook that opens `/dev/tty`. It fails within 10 seconds with `GIT_FAILED` and its output tail. Close the application. Within five seconds, `wsl --distribution <distro> --exec pgrep -a sleep` shows none of them. Repeat with Revoke trust, cancellation, a deadline, and a service crash.
8. Keep the window focused, and change a file inside the distro. Confirm that the change appears within two seconds. Move focus away, change a file, and confirm that no poll runs. Return focus, and confirm the change.
9. Set `WSLENV=GIT_TRACE/u` and `GIT_TRACE=1` for the application. Confirm that Linux Git sees neither.
10. Open the F26 cases. Confirm reasons `mixed-location` and `wsl-path`, and reason `path` for the entry.
11. Copy a WSL remedy command, and run it in PowerShell. Confirm that it runs the distro Git with the literal paths.

Record each result in `research.md` R10 as `pass`, `fail`, or `unverified`. A Linux-only or browser run never counts as evidence for these rows.

## 9. Submodule updates

Use F27 to F30 from `plan.md` in the installed build, and F31 in the distro's `/tmp`. Build each fixture on the reference host with `bun tests/windows/make-fixture.ts`. Before and after each step, record every submodule HEAD, the superproject configuration keys, and the `.git/modules` folders with `--snapshot`.

1. Open an F27 copy. Confirm the submodule notice and its count. Confirm that no Git process started inside a submodule during the reads, with a T151 descendant snapshot.
2. Open Update submodules from the notice and from the repository menu. Confirm each row: path, action, notes, and the nested row. Confirm that the token URL shows `<redacted>`, then cancel that review. In the F27 kept-remote copy, confirm that the row lists both remote URLs and marks `origin` as the default. In its copy without the second remote, confirm the differs note.
3. Start the update in a second F27 copy. Confirm "Updating submodule <path> (<i> of <n>)" and a percentage. Compare every HEAD, Git folder, and configuration key with `git submodule update --init --recursive` in a third copy. Confirm that only `sub[1]` changed for its row.
4. Approve trust for the superproject first, then run the update. Confirm that the trust state stays approved and that commit still needs no new approval.
5. Open each F28 case. Confirm each refusal text and remedy. Run each remedy command in PowerShell only in a disposable copy, and confirm its result there. Confirm that the `!<canary>` never runs.
6. Run F28 with the blocked checkout. Confirm `failed-with-effects`, the kept edit, the moved second submodule, and the output tail.
7. Open F29. Confirm the program list in the review. Press Escape in the native Run confirmation, and confirm that no canary runs. Then choose Run, and confirm the canaries run only after it. Repeat with the F29 kept-folder variants: the program list holds their canaries, and none runs before Run. Confirm the `ext::` and `file` failures with a redacted output tail and Copy command.
8. Start the F30 clone, then press Cancel. Confirm a reconciled state within five seconds and `clone-interrupted` with the `.git` file path. Confirm that the app removed no file and that the next review refuses. Delete that file yourself, and confirm that the next update succeeds.
9. Run the F30 silent hook, which sleeps 330 seconds. After about 300 seconds, confirm `DEADLINE` with reason `inactivity` and the inactivity text.
10. When a test SSH server exists, use an SSH URL with an unknown host key. Confirm that the update fails without a wait and shows the SSH message. Otherwise record this step as `unverified`.
11. During an F30 clone, type in the message field and move through the lists. Record the input acknowledgement times in the SC-005 row.
12. In the distro, repeat steps 3, 7, and 8 with F31. Confirm that the hook cannot open `/dev/tty`. After cancellation and close, `pgrep` shows no process of the operation. These steps stay `unverified` until the distro holds Git 2.55.0 or later.

Record SC-017 and the F27 to F31 rows in `research.md` R10. A browser run never counts as evidence for these rows.

## 10. Release measurements

Follow the fixed run counts, timing boundaries, fixtures, and budgets in `plan.md` without modification.

Use installed release artifacts for both Arbareto and Git Extensions. Match Git, hardware, repository copies, power mode, Defender, displays, and cache conditions.

Record every run. Include complete process sets, exited child CPU, private bytes, working-set accounting limits, and measurement uncertainty.

Record prerequisite versions before and after each series. Stop the series when a version changes.

Time both applications with the one capture source of `plan.md` "Capture source". End each run at the visible-content end frame of its condition. Discard one warm-up run per block, and record it. Evaluate each SC-015 condition on the upper bound of its bootstrap 95% interval.

Record product differences, as `plan.md` §Matched-condition comparisons lists them. Do not infer isolated shell speed from product-level results.

Electrobun is source-only in this feature. Do not create or benchmark its adapter without a later approved scope change.

## 11. Record results and enforce release gates

Append each scenario result to `research.md`. Use the qualification record fields in [data-model.md](data-model.md).

Record `pass`, `fail`, or `unverified`; never treat “not run” as passing. Include causes, attempted remedies, retests, and decision impact.

Keep raw trace/test artifact locations and digests in those records. Do not add a separate qualification report or planning hierarchy.

Before public release, separately verify package signatures and authenticated updates. Include modified payloads, wrong keys, version substitution, downgrade attempts, and interrupted update handling.

Automatic updates remain outside this slice. Therefore, completing local qualification cannot establish public release readiness.
