# Quickstart: Qualification Validation

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Results**: [research.md](research.md)

## Current design and prerequisites

**Design decisions are resolved.** Use the protected hunk publication protocol and the user's approved standard Git commit policy.

No application, package manifest, build scripts, or executable test suite exists. This guide defines future validation. Commands below require implemented files and verified tools; planning did not execute them.

Proceed through `/speckit-tasks` and `/speckit-analyze` before implementation. Preserve exact hunk checks, approved hooks, and honest late-change outcomes. Do not substitute whole-file staging, disable hooks, or mark unexecuted tests passed.

## 1. Confirm scope and prerequisites

Use Windows 11 x64. Keep Windows Defender enabled. Use the reference hardware and the separate clean-install environment defined in `plan.md`: a disposable clean Windows 11 x64 environment, a Hyper-V VM or Windows Sandbox.

Reuse the selected Git installation and existing development tools. Do not change global Git configuration, identity, signing, helpers, PATH, or agents.

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
7. Copy the F02 fixture and the F07 worktree pair from the reference host with their SHA-256 manifest. Verify the copies with `Get-FileHash`. Offline, stage a hunk, unstage a hunk, and commit in both. Copy them back and verify them with `bun tests/windows/make-fixture.ts --snapshot` on the host. Confirm ordinary operations require no cloud account or network after prerequisites exist.
8. Upgrade over the previous package, then uninstall with and without Delete app data. Confirm that data folders, fixtures, and Git configuration match each expected result. Record the default state of the Delete app data option. Then reinstall.

Run separate cases with missing Git, missing WebView2, a Git version below the minimum, a WebView2 version below the minimum, and a changed selected executable. Windows 11 includes the Evergreen WebView2 Runtime. Record the missing-WebView2 case as `unverified` unless a Windows 11 image without the runtime exists.

Apply the Git and WebView2 minimum versions in `plan.md`. Admitted versions permit tests but remain unqualified until evidence passes. Versions below the minimum and unparseable versions must return the specified unsupported error and block dependent behavior.

Use adjacent version strings for deterministic policy tests. Use separately verified installations or disposable images for packaged rejection tests. For Git and WebView2, the rejected case is a version below the minimum. Never alter the developer's runtimes to create these cases.

Expected result: clear prerequisite guidance or a blocked state. A blank window, hidden download, unexpected elevation, or silent Git substitution fails qualification.

Inspect final PE dependencies. Record WebView2 as a preinstalled requirement. Record all build-time downloads separately from end-user prerequisites.

## 4. Inspection and hunk scenarios

Use F01–F11, F15–F17, F19, and F20 from `plan.md`. The fixture helper must refuse paths outside its owned temporary root.

1. Open an ordinary fixture and each linked worktree.
2. Compare paths, HEAD, status, and the first 100 history rows and parent relationships with independent Git observations.
3. Verify linear, merge, octopus, skewed-date, cutoff, and shallow graphs. Missing parents must not become invented roots.
4. Select staged, unstaged, and untracked entries. Verify their comparison baselines.
5. Verify Unicode/spaced/option-like paths, LF/CRLF, additions, deletions, and staged-deletion/untracked-replacement states.
6. Confirm unsupported files, sparse/split indexes, registered index-change hooks, and executable monitors refuse hunk mutation without bypasses.
7. Stage one of two supported hunks with existing staged changes through the protected candidate protocol.
8. Compare exact resulting blobs, modes, stages, flags, and every unrelated logical index entry.
9. Compare every fixture working-file byte. Repeat for unstaging, unborn repositories, and separate worktree indexes.
10. Change files, index, HEAD, attributes, and configuration before each validation checkpoint. Require refusal without canonical index publication.
11. Change a working file after final validation. In the installed build, `bun tests/windows/make-fixture.ts --late-write` writes when publication replaces the index. Verify preservation of the external bytes and truthful late-change reporting.
12. Exercise graph data/layout limits. Retain usable row metadata, disclose the limit, and never fetch missing objects.

Capture state through documented Git protocols and raw file-byte digests. Do not use the application's own parser as the only test oracle.

A matching exit code or screenshot is insufficient. Record exact expected and actual index/tree identities and byte digests.

Do not remove foreign locks, suppress hooks, relocate a selected hunk, or substitute a whole-file action.

## 5. Commit scenarios

Use F01, F11–F13, and F20 with the approved standard Git handoff design.

1. Review the complete staged scope, including externally staged unsupported files, without index writes or trial commits.
2. Verify the review explains approved hooks and possible changes during execution.
3. Enter a nonblank Unicode message and start one ordinary canonical Git commit.
4. Verify parent, destination, tree, message, index, and working bytes against the retained review and fixture expectations.
5. Repeat for the first commit in an unborn repository.
6. Test blank messages, empty scope, missing identity, rejected hooks, denied trust, and signing failure. Start the missing-identity case with `--no-identity`. For a rejected hook, run the displayed remedy command in PowerShell, and confirm that the hook output appears there.
7. Change index/checkout state before handoff, including same-OID branch changes. Require refusal and renewed review.
8. Change state after handoff or through approved hooks. Preserve canonical hook effects and report `completed-with-effects` results without ordinary-success styling.
9. Interrupt before and after publication. Identify actual effects or explicit uncertainty; preserve the draft and never retry automatically.
10. Type newer draft text while Git runs, then switch to History. Completion must not clear those newer edits.
11. Submit a second `commit` with the same review token, and lose a response. The second request returns the first operation's state and `operationId`. Confirm that one Git commit invocation runs.
12. Create ambiguous attribution with another Git process. Require unknown state rather than assigning an unrelated HEAD to this request.
13. Exceed each attribution evidence limit independently: 4 MiB or 10,000 aggregate reference/reflog records. Require unknown state without treating truncated evidence as sufficient.
14. Make status refresh succeed while required attribution remains unknown. Keep mutations blocked until explicit recovery refresh completes the required reconciliation. That refresh states the unknown outcome, and then mutations become available.

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
- Approve trust through the native confirmation, then restart the application. Confirm that no new approval appears. Change the trust policy, and confirm Trust changed. Revoke trust, and confirm Trust required after a restart. Approve trust in a repository above a program-file digest bound. Confirm that the native confirmation limits the approval to this session. After a restart, confirm Trust required.
- Run descendant-spawning fixture hooks and an unrelated Git process with the same executable name. Include a hook grandchild that holds no inherited pipe and outlives its parent.
- Commit with a `post-commit` hook that starts a sleeping background child. Confirm that the child still runs after the commit and that a refresh succeeds. Close the application. Confirm that no prompt appears and that the child ends within five seconds.
- Verify no unintended owned process remains after five seconds. Verify unrelated processes and existing agents survive.
- Suppress a watcher notification, then regain focus or request manual refresh.
- Complete external file, index, and reference changes in the foreground. Require visible reconciliation within two seconds.
- Deliver an old comparison response after a newer selection. Confirm it cannot replace the current view.
- Run two instances on one repository. Confirm that the second instance receives `LOCKED` or a stale refusal, never a silent overwrite. Record whether both instances share one WebView2 browser process.

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
- The first loaded frame after opening a repository shows the No selection state. Background polls show no Refreshing marker.

Use the content sizes and UI-01–UI-15 capture cases in `plan.md`. Capture the installed application with actual fixture states. A browser screenshot cannot pass these native scenarios.

## 8. Release measurements

Follow the fixed run counts, timing boundaries, fixtures, and budgets in `plan.md` without modification.

Use installed release artifacts for both Arbareto and Git Extensions. Match Git, hardware, repository copies, power mode, Defender, displays, and cache conditions.

Record every run. Include complete process sets, exited child CPU, private bytes, working-set accounting limits, and measurement uncertainty.

Record prerequisite versions before and after each series. Stop the series when a version changes.

Record baseline layout differences. Do not infer isolated shell speed from product-level results.

Electrobun is source-only in this feature. Do not create or benchmark its adapter without a later approved scope change.

## 9. Record results and enforce release gates

Append each scenario result to `research.md`. Use the qualification record fields in [data-model.md](data-model.md).

Record `pass`, `fail`, or `unverified`; never treat “not run” as passing. Include causes, attempted remedies, retests, and decision impact.

Keep raw trace/test artifact locations and digests in those records. Do not add a separate qualification report or planning hierarchy.

Before public release, separately verify package signatures and authenticated updates. Include modified payloads, wrong keys, version substitution, downgrade attempts, and interrupted update handling.

Automatic updates remain outside this slice. Therefore, completing local qualification cannot establish public release readiness.
