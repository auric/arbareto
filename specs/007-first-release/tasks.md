---

description: "Task list for the First Release (Preview v0.1.0) feature"
---

# Tasks: First Release (Preview v0.1.0)

**Input**: Design documents from `specs/007-first-release/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/release.md, quickstart.md, and checklists/requirements.md.

**Tests**: The spec (SC-001 to SC-008) and plan.md "Steps" require tests. Each code task has a failing-test task before it. The facts F1 to F5 run first, and a failed fact changes plan.md before the dependent task starts. No test passes by default.

**Organization**: Phases follow plan.md "Work packages, in run order": WP1 and WP2 (batch 0), WP3 and WP4 (batch 1), WP5, WP6, and WP7 (batch 2), WP8 (batch 3). Phase 8 holds the signing switch-on. It waits for the SignPath approval and does not gate v0.1.0. Story phases carry `[USn]` labels. Phases 1, 2, and 6 carry no label.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: The task touches different files from the other `[P]` tasks in its group and depends on no incomplete task of that group. A sub-heading starts a new group. "Depends on" names the exact order.
- **[Story]**: The user story from spec.md (US1 to US5). A task that serves several stories carries the first story and names the others.
- **WP and agent**: Each task names its plan.md work package. Each phase heading names the agent.
- **Local tags**: `Local: Rust` needs the local Rust toolchain. `Local: Windows` needs the Windows reference host. `Local: package` needs a packaged Windows build. `Local: network` needs reads of github.com. `GitHub` needs the orchestrator and the user's OK for that GitHub step. Cloud sessions do not run these tasks. A skip never counts as a pass.
- **Earlier specs**: Only T027 edits `specs/001-desktop-qualification/`, as the user asked on 2026-10-24 (plan.md D12).
- **Portability**: Shared TypeScript code and the generic test harness hold no Win32 FFI. The release scripts are Windows build tools, but they hold no FFI either: they start processes with argument arrays and literal paths.

## Path Conventions

- Paths follow plan.md "Project Structure": `.github/workflows/`, `.github/release-notes/`, `scripts/release/`, `src/contracts/`, `src/frontend/`, `src-tauri/`, `tests/contracts/`, and `tests/git/`.
- Feature evidence goes only into `specs/007-first-release/research.md` "R7. Results".
- Release script outputs go to a scratch folder outside the checkout, or below `RUNNER_TEMP` on GitHub.

## Harness and tick rules

- The 001 "Test harness rules" stay in force (`specs/001-desktop-qualification/tasks.md`): `printOrigin`, the control mutation, Git discovery through `tests/git/git-binary.ts`, capability skips, `tests/groups.json`, owned fixture roots, and the source headers.
- Every Git test uses an owned `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM=1`. No test touches the user's configuration.
- No test uses the network. `hunspell-source.ts` takes an upstream base option, and its tests point it at local bare repositories. Only T004, T026, and the GitHub tasks read github.com.
- Each new test file in `tests/contracts` or `tests/git` adds its line to `tests/groups.json` in the same task.
- App runs set `ARBARETO_PROFILE_ROOT` to a scratch folder.
- A task is ticked only after a green full run (`bun run test:all`) on Windows that verifies it, with `ORIGIN` lines in the checkout under test. A `GitHub` task is ticked only after its run record is in research.md R7. A fact task is ticked when its `OBSERVATION` line is in research.md R7.
- Batch verification tasks use only the README "Development" commands, plus the commands that their batch made green and added there.
- No heuristics: every outcome comes from a documented exit code, machine-readable output (`cargo metadata`, `gh api` JSON, `git status --porcelain`), a SHA-256, an OS fact, or a contract value. A test that asserts a refusal asserts its exit code and its first token pair (contracts/release.md §2), never free text.

## Batch-to-story mapping

| Batch | Phases | Plan steps | Tasks | Stories | Work packages (agent) |
| --- | --- | --- | --- | --- | --- |
| 0. Facts, pins, checks | 1, 2 | P0, P1 | T001–T010 | Foundational | WP1 (scout), then WP2 (implementer) |
| 1. Application changes | 3 | P2 | T011–T017 | US1, US4 | WP3 (implementer-xhigh, local Rust), then WP4 (frontend-implementer) |
| 2. Release files, workflow, 001 | 4, 5, 6 | P3, P4, P5 | T018–T028 | US2, US3, US4 | WP5 and WP6 (implementer, disjoint files), then WP7 (implementer) |
| 3. Dry run and release | 7 | P6, P7 | T029–T033 | US1, US2, US3 | WP8 (scout runs, orchestrator GitHub steps) |
| Later. Signing switch-on | 8 | — | T034–T037 | US5 | User, orchestrator, implementer |

---

## Phase 1: Facts (Batch 0, P0, WP1)

**Agent**: scout.

**Purpose**: Prove the build facts that the design depends on (plan.md "Facts to verify").

- [ ] T001 [P] Fact F1: build the package in two stages on the reference host and compare it with the one-step build (WP1). `Local: package`. In a clean scratch clone of this branch: `bun run build`, `cargo tauri build --target x86_64-pc-windows-msvc --no-bundle -- --locked`, then `cargo tauri bundle --target x86_64-pc-windows-msvc --bundles nsis`. In a second scratch clone: `bun run package`. Install each installer into its own Windows Sandbox and list the installed folder with SHA-256 per file. Print `OBSERVATION T001: <same|differs> <file list>` with the tauri-cli version. A differing file is a finding for the fact gate. Spec: FR-041.
- [ ] T002 [P] Fact F2: compile a stub with Bun 1.4.4 and each Windows file property flag (WP1). `Local: Windows`. Try `bun build --compile --windows-title=X --windows-publisher=X --windows-version=0.1.0 --windows-description=X --windows-copyright=X`. Read `(Get-Item <exe>).VersionInfo` and print `OBSERVATION T002: <flag> -> <VersionInfo field or rejected>` for each flag. Docs: `docs/bundler/executables.mdx` at `bun-v1.4.4`, "Windows-specific flags". Spec: FR-034.
- [ ] T003 [P] Fact F3: build with a scratch `--config` overlay that sets `bundle.windows.nsis.installerHooks` to a hook file without `NSIS_HOOK_POSTINSTALL` (WP1). `Local: package`. Keep the overlay and the hook file outside the repository. Install in Windows Sandbox and read `DisplayName` and `DisplayVersion` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`. Print `OBSERVATION T003: DisplayName=<value> DisplayVersion=<value>`. Expected: `Arbareto` and `0.1.0` (tauri-bundler 2.10.0 `installer.nsi:702-704`). Spec: FR-033.
- [ ] T004 [P] Facts F4 and F5: in a scratch folder, `git init`, `git fetch --depth 1 https://github.com/hunspell/hunspell edb619100791110d3e34f09ec35392ad327c1135`, and `git rev-parse FETCH_HEAD^{commit}`; the same for `https://github.com/rotemdan/hunspell-wasm` at `8f755ef64e8b047b77b676f9698b3dfa5cb1887d` (WP1). `Local: network`. Then run `C:\Windows\System32\tar.exe --version`. Print `OBSERVATION T004: <repo> fetch <exit code> <commit>` and `OBSERVATION T004: tar <version line>`. Spec: FR-023.

### Fact gate

- [ ] T005 Copy every `OBSERVATION` line of T001 to T004 into research.md R7 (WP1). A failed F1 changes plan.md D1 and D11 before T014. A failed F2 changes plan.md D8 before T014. A failed F3 changes plan.md D8 before T014. A failed F4 or F5 changes plan.md D6 before T021. Each change runs `/speckit-analyze`. Depends on T001 to T004.

**Checkpoint**: Every build fact has an observation.

---

## Phase 2: Pins and release checks (Batch 0, P1, WP2)

**Agent**: implementer.

**Purpose**: The pinned tool record and the tag, version, and tree checks that every release run uses.

### Tests (write first; they must fail)

- [ ] T006 [P] Write failing tests in the new `tests/contracts/release-pins.test.ts` (P1, WP2). The `scripts/release/pins.ts` record (data-model §5) must equal: `package.json` `packageManager` (`bun@1.4.4`) and the version in the `build:service` check; `rust-toolchain.toml` `channel` (`1.99.0`) and `targets` (`x86_64-pc-windows-msvc`, `x86_64-unknown-linux-gnu`); `TAURI_CLI_VERSION` (`tauri-cli 2.12.0\n`) and `NSIS_VERSION` in `src/frontend/build/notices.ts`. `bunWindowsZipSha256` must be `cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5`. No updater: `cargo metadata` lists no `tauri-plugin-updater` package, and `src-tauri/tauri.conf.json` and `src-tauri/tauri.preview.conf.json` (after T014 creates it; T014 makes the test require the file) have no `plugins.updater` key and no `bundle.createUpdaterArtifacts` key. The workflow file checks join in T024. Add the file to `tests/groups.json` (`parallel`). Spec: FR-005, FR-011.
- [ ] T007 [P] Write failing real-Git tests in the new `tests/git/release-check.test.ts` (P1, WP2). Each case builds an owned fixture repository with a bare `origin` that holds `main`, and runs `bun scripts/release/check.ts` as a child with an argument array. Cases and expected results (contracts/release.md §2): tag `v0.1.0` on `main` with Cargo and `package.json` at `0.1.0` exits 0; tag `v0.1.1` gives `RELEASE_CHECK tag-version`; tag `v0.1` gives `RELEASE_CHECK tag-version`; `package.json` `0.1.1` gives `RELEASE_CHECK version-mismatch`; a `version` key in `src-tauri/tauri.conf.json` gives `RELEASE_CHECK config-version`; a tag on a commit outside `origin/main` gives `RELEASE_CHECK not-on-main`; an unknown tag commit gives `RELEASE_CHECK git-failed` with the `git merge-base` exit code; one untracked file gives `RELEASE_CHECK dirty`; `--signing other` gives `RELEASE_CHECK signing-value`; `--signing signpath` without `SIGNPATH_PROJECT_SLUG` gives `RELEASE_CHECK signing-missing SIGNPATH_PROJECT_SLUG`; `--mode dry-run` skips the tag and `main` checks and keeps the version and tree checks. The fixture `Cargo.toml` is a minimal manifest that `cargo metadata --no-deps` reads. `Local: Rust`. Add the file to `tests/groups.json` (`parallel`). Spec: FR-012 to FR-014.

### Implementation

- [ ] T008 Create `scripts/release/pins.ts` with the data-model §5 record and `rust-toolchain.toml` at the repository root with `channel = "1.99.0"`, `profile = "minimal"`, `components = ["clippy", "rustfmt"]`, and `targets = ["x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"]` (P1, WP2). Run `rustc --version` in the repository root and record the line in research.md R7. Make T006 pass. Spec: FR-011. Depends on T006.
- [ ] T009 Create `scripts/release/check.ts` (plan.md D3; contracts/release.md §2) (P1, WP2). Options `--mode release --tag <name>` or `--mode dry-run`, and `--signing off|signpath`. Version from `cargo metadata --no-deps --format-version 1 --manifest-path src-tauri/Cargo.toml` (package `arbareto`). `git merge-base --is-ancestor <tag commit> origin/main`: exit 0 passes, exit 1 is `not-on-main`, any other exit is `git-failed <code>`. Tree: `git --no-optional-locks status --porcelain --untracked-files=all` must print nothing. Every process starts with an argument array. Make T007 pass. Spec: FR-012 to FR-014, FR-040. Depends on T007, T008.

### Batch 0 verification

- [ ] T010 Run the batch 0 verification: `bun install --frozen-lockfile`, `bun run build`, `bun run typecheck`, `bun run export:schemas --check`, `bun run test:contracts`, `cargo check --locked --manifest-path src-tauri/Cargo.toml`, `cargo check --locked --manifest-path src-tauri/Cargo.toml --target x86_64-unknown-linux-gnu`, and `bun run test:all` (WP2). `Local: Rust`. `Local: Windows`. Pass condition: every command exits 0 with `ORIGIN` lines under this checkout. Control mutations, each undone and rerun green: (1) in `check.ts`, treat `merge-base` exit 1 as a pass; the `not-on-main` case fails; (2) in `pins.ts`, change the Bun hash by one digit; the pins test fails. The task passes only after one independent review of batch 0 is recorded in research.md R7. Depends on T005, T008, T009.

**Checkpoint**: Pins and checks exist and run locally.

---

## Phase 3: User Story 1 - Application changes for the preview (Batch 1, P2) 🎯 MVP

**Agent**: implementer-xhigh (WP3, `Local: Rust`), then frontend-implementer (WP4).

**Goal**: A preview build shows "Preview" and the release links in About, refuses a dirty tree, carries Arbareto file properties in both executables, and names "Arbareto" in "Installed apps". Serves US1 and US4.

**Independent Test**: `bun run package:preview:exes` and `bun run package:preview:bundle` on a clean tree give an installer. In Windows Sandbox, About shows `0.1.0`, `Preview`, and the commit; "Installed apps" shows "Arbareto".

### Tests (write first; they must fail)

- [ ] T011 [P] [US1] Write failing tests for the build channel and the handshake change (P2, WP3). Rust: move the channel rule into the new `src-tauri/src/build_channel.rs` (no dependency, used by `build.rs` through `#[path = "src/build_channel.rs"] mod build_channel;` and by the library under `#[cfg(test)]`); cases: unset and empty give `local`, `preview` gives `preview`, `Preview` and `release` fail; `preview` with a `-dirty` identity fails; `local` keeps `-dirty`. Contracts: in `tests/contracts/{envelope,schemas}.test.ts` and the handshake vectors, `buildIdentity` is `{version, commit, channel}` with `channel` `"local"` or `"preview"`; a vector with `signing` fails as an unknown key; `channel: "release"` fails. Rust: the `open_release_link` URL builder in the new `src-tauri/src/release_link.rs` (a pure function, no dependency on the 006 `links.rs`), tests: version `0.1.0`, repository `https://github.com/auric/arbareto`, commit `<40 hex>` give exactly the two contracts/release.md §5 URLs; `local` gives `RELEASE_LINK_UNAVAILABLE`; any other target value fails validation. `Local: Rust`. Spec: FR-002, FR-014, FR-031, FR-032.

### Implementation

- [ ] T012 [US1] Implement the build channel and the handshake field (plan.md D4) in `src-tauri/build.rs`, `src-tauri/src/build_channel.rs`, `src-tauri/src/service.rs`, `src/contracts/channel.ts`, `src/contracts/envelope.ts`, and the regenerated `src/contracts/schemas/` (P2, WP3). `build.rs` prints `cargo:rerun-if-env-changed=ARBARETO_RELEASE_CHANNEL` and the new `ARBARETO_RELEASE_CHANNEL` rustc env value. `service.rs` sends `"channel"` instead of `"signing"`. Keep `src/frontend/about/AboutDialog.tsx` and `src/frontend/boot/BootView.tsx` compiling with the `local` marker as today; WP4 adds the preview display. Run `bun run export:schemas`. Make the channel and contract parts of T011 pass. `Local: Rust`. Spec: FR-002, FR-014. Depends on T011.
- [ ] T013 [US4] Implement the URL builder in `src-tauri/src/release_link.rs`, and add the shell command `open_release_link` with its command registration, capability grant, and contract entry; it opens the URL through the 006 `src-tauri/src/links.rs` opener (plan.md D7; contracts/release.md §5) (P2, WP3). The command part needs feature 006 on `main`. Until then that part waits. The renderer sends only `{target}`. The shell builds the URL from `CARGO_PKG_REPOSITORY`, `CARGO_PKG_VERSION`, and `ARBARETO_BUILD_IDENTITY`. `ShellExecuteW` result 32 or less gives `RELEASE_LINK_OPEN_FAILED`. Make the link part of T011 pass. `Local: Rust`. Spec: FR-031, FR-032. Depends on T011, T012.
- [ ] T014 [US1] Add `src-tauri/tauri.preview.conf.json` (only `bundle.windows.nsis.installerHooks` = `./installer-hooks.preview.nsh`), `src-tauri/installer-hooks.preview.nsh` (no `NSIS_HOOK_POSTINSTALL`), the `package.json` scripts `package:preview:exes` and `package:preview:bundle` (plan.md D8), and the Bun Windows file properties in `build:service` with the flag names that T002 observed (P2, WP3). Extend `tests/contracts/release-pins.test.ts`: the `build:service` version value equals the `cargo metadata` version, and both preview scripts set `ARBARETO_RELEASE_CHANNEL=preview` and name the overlay. Run both scripts on a clean tree; record the installer SHA-256 and the tool version lines in research.md R7. `Local: Rust`. `Local: package`. Spec: FR-033, FR-034. Depends on T003, T005, T012.
- [ ] T015 [P] [US1] Write failing component tests in the new `tests/contracts/about-dialog.test.tsx` (add it to `tests/groups.json`) and in `tests/contracts/boot-view.test.tsx` (P2, WP4). `channel: "local"`: About and the boot view show `Unsigned local test package` and no release button. `channel: "preview"`: both show `Preview`; About shows the buttons `Hunspell source` and `Source at this commit`; Tab reaches each button, Enter and Space call the bridge with `{target: "hunspell-source"}` and `{target: "tag-source"}`; a `RELEASE_LINK_OPEN_FAILED` result shows the typed failure text. Assert roles and accessible names, not text positions. Spec: FR-002, FR-030 to FR-032.
- [ ] T016 [US1] Implement the preview marker and the two buttons in `src/frontend/about/AboutDialog.tsx`, the marker in `src/frontend/boot/BootView.tsx`, and the bridge call in `src/frontend/bridge.ts` (plan.md D7; contracts/release.md §6) (P2, WP4). The buttons follow the 006 licence link button. Make T015 pass. Spec: FR-002, FR-030 to FR-032. Depends on T013, T015.

### Batch 1 verification

- [ ] T017 [US1] Run the batch 1 verification: `bun install --frozen-lockfile`, `bun run build`, `bun run typecheck`, `bun run export:schemas --check`, `cargo test --locked --manifest-path src-tauri/Cargo.toml`, `bun run test:all`, then `bun run package:preview:exes` and `bun run package:preview:bundle` on a clean tree, and the Sandbox install of quickstart.md Q4 (WP4). `Local: Rust`. `Local: package`. Pass condition: every command exits 0 with `ORIGIN` lines under this checkout; About shows `0.1.0`, `Preview`, and the commit without `-dirty`; "Installed apps" shows "Arbareto"; uninstall removes the app. Control mutations, each undone and rerun green: (1) in `build_channel.rs`, accept a dirty `preview` identity; the Rust case fails; (2) in `AboutDialog.tsx`, show the buttons for `local`; the component test fails; (3) add an untracked file and run `bun run package:preview:exes`; the build fails. The task passes only after one independent review of batch 1 is recorded in research.md R7. Depends on T014, T016.

**Checkpoint**: A local preview package installs and shows the preview identity.

---

## Phase 4: User Story 4 - Release files and notes (Batch 2, P3, WP5)

**Agent**: implementer.

**Goal**: The notices text, the Hunspell source archive, the checksum file, the release notes, `CHANGELOG.md`, and the README download section. Serves US4, US2, and US3.

**Independent Test**: quickstart.md Q2 makes four release files in a scratch folder, and `sums.ts verify` exits 0.

### Tests (write first; they must fail)

- [ ] T018 [P] [US4] Write failing tests in the new `tests/contracts/release-files.test.ts` (P3, WP5). `notices-text.ts`: for a fixed `notices.json`, every package with its version and every licence text appears exactly once, in JSON order; a missing input gives `RELEASE_NOTICES input`. `sums.ts`: `write` gives lines matching `^[0-9a-f]{64}  [A-Za-z0-9._-]+$`, sorted, LF, one final LF; `verify` passes, and a changed byte, a missing file, and an extra file give `RELEASE_SUMS mismatch`, `missing`, and `extra`. `notes.ts`: `--version 0.1.0 --signing off` holds the `CHANGELOG.md` `## [0.1.0]` section, then `preview.md`, `prerequisites.md`, and `unsigned.md`; `--signing signpath` uses `signed.md` instead of `unsigned.md`; the exported `releaseNotes` gives no notes for a changelog without a `## [0.1.0]` section, and the CLI with `--version 0.0.0` gives `RELEASE_NOTES missing`. The exported `hunspellSource` function with the upstream base of two local bare repositories and injected pins (their tip commits, because a fixture cannot hold the real pinned commit IDs): the archive holds `hunspell/`, `hunspell-wasm/`, and `SOURCE.txt` with both commit IDs; a pin that the upstream lacks gives `RELEASE_SOURCE fetch hunspell/hunspell` and no archive. Add the file to `tests/groups.json` (`parallel`). Spec: FR-020 to FR-023, FR-025, FR-026.

### Implementation

- [ ] T019 [P] [US4] Create `scripts/release/notices-text.ts` (plan.md D6) with the rendering as an exported pure function (P3, WP5). Spec: FR-022. Depends on T018.
- [ ] T020 [P] [US3] Create `scripts/release/sums.ts` with `write <dir>` and `verify <dir>` (plan.md D5) (P3, WP5). Spec: FR-021. Depends on T018.
- [ ] T021 [P] [US4] Create `scripts/release/hunspell-source.ts` (plan.md D6) (P3, WP5). Pins come from `pins.ts`. Default upstream base `https://github.com`; `--upstream` replaces it for tests. `SOURCE.txt` text as plan.md D6. Pack with the literal path `C:\Windows\System32\tar.exe -czf`. Run it once with the default upstream into a scratch folder (`Local: network`) and record the archive size and SHA-256 in research.md R7. Spec: FR-023. Depends on T005, T018.
- [ ] T022 [P] [US2] Create `scripts/release/notes.ts`, `CHANGELOG.md` with the `## [0.1.0] - <release date>` section of user-visible features (README "Features" after 005 and 006), and `.github/release-notes/{preview,prerequisites,unsigned,signed}.md` (plan.md D9) (P3, WP5). `unsigned.md` states the SmartScreen prompt, that unsigned builds do not run when Smart App Control is on, and the PowerShell `Get-FileHash`, `sha256sum --check`, and `gh attestation verify <file> -R auric/arbareto` commands. `preview.md` states that the 001 qualification continues and gates v1.0. `signed.md` holds the code signing policy placeholder and the unsigned uninstaller and plugin DLL note. No internal history, task ID, or test run in any block. Make the notes part of T018 pass. Spec: FR-003, FR-025 to FR-027, FR-046. Depends on T018.
- [ ] T023 [US2] Update `README.md` (plan.md D10) (P3, WP5): the "Download" section with the Releases link, the prerequisites, the checksum and attestation commands, the SmartScreen prompt, and the sentence "Unsigned builds do not run when Smart App Control is on."; the Status bullet names the preview; "Development" adds `bun run package:preview:exes` and `bun run package:preview:bundle` after T017 ran them green. Spec: FR-027, FR-029. Depends on T017, T022.

**Checkpoint**: Every release file and the notes build locally.

---

## Phase 5: User Story 2 - The release workflow (Batch 2, P4, WP6)

**Agent**: implementer.

**Goal**: `.github/workflows/release.yml` with the build and publish jobs, the dry-run triggers, attestations, and the gated sign stages. Serves US2, US3, and US5.

**Independent Test**: The workflow contract test passes, and the local rehearsal of quickstart.md Q2 and Q3 passes.

### Tests (write first; they must fail)

- [ ] T024 [P] [US2] Write failing tests in the new `tests/contracts/release-workflow.test.ts` that parse `.github/workflows/release.yml` with `Bun.YAML.parse` (P4, WP6). Every rule of contracts/release.md §1: workflow `permissions` is `{}`; the three triggers and no other; `build` on `windows-2025` with exactly `contents: read` and `actions: read` and no environment; `publish` with `needs: build`, `environment: release`, the tag-only `if`, and exactly `contents: write`, `id-token: write`, `attestations: write`; every `uses:` matches `^[\w.-]+/[\w./-]+@[0-9a-f]{40}$`; no `actions/cache`; no `continue-on-error: true`; each SignPath step carries `if: vars.ARBARETO_SIGNING == 'signpath'`; the build job calls `check.ts`, `package:preview:exes`, `package:preview:bundle`, `notices-text.ts`, `hunspell-source.ts`, and `sums.ts write`; the publish job checks `github.event.repository.private`, calls `sums.ts verify`, `actions/attest`, and `gh release create` with `--draft --prerelease --verify-tag`. Extend `tests/contracts/release-pins.test.ts`: the workflow runner label, the Bun URL, and the hash equal `pins.ts`. Add the file to `tests/groups.json` (`parallel`). Spec: FR-010, FR-011, FR-017 to FR-019, FR-024, FR-040.

### Implementation

- [ ] T025 [US2] Write `.github/workflows/release.yml` (plan.md D1 to D5, D9, D11) (P4, WP6). Read each action's commit ID from its release tag (`actions/checkout`, `actions/upload-artifact`, `actions/download-artifact`, `actions/attest`, `signpath/github-action-submit-signing-request`) and record name, tag, commit ID, and the date in research.md R7. Every output path is below `$env:RUNNER_TEMP` except the Tauri target folder. The build job runs `check.ts` before and after the build. After the build it prints the image version (`$env:ImageVersion`), the `package` version lines, the MSVC toolset from `VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt` below the `vswhere -latest -property installationPath` folder, and the Windows SDK that the linker used, read by the 001 T001 link probe method (001 tasks.md line 70). The publish job lists releases with `gh api --paginate`, fails on a published release with the tag, reuses a draft, and publishes with `gh release edit --draft=false --prerelease --latest=false`. Make T024 pass. Spec: FR-001, FR-004, FR-010 to FR-019, FR-024, FR-040 to FR-043. Depends on T009, T019 to T022, T024.
- [ ] T026 [US2] Rehearse the build job locally (quickstart.md Q2 and Q3) on a clean clone of this branch (P4, WP6). `Local: package`. `Local: network`. Pass condition: four files in the scratch folder, `sums.ts verify` exits 0, `git status --porcelain --untracked-files=all` prints nothing after the run, and each Q3 control mutation fails as stated. Record the file names, sizes, SHA-256 values, and tool versions in research.md R7. Depends on T014, T025.

---

## Phase 6: 001 amendments (Batch 2, P5, WP7)

**Agent**: implementer.

- [ ] T027 Amend the 001 artifacts (plan.md D12) (P5, WP7): `specs/001-desktop-qualification/plan.md` B-RELEASE row (current state "v1.0 release blocked", with a note that cites the constitution 4.0.1 definition of a production release), plan.md:613 and plan.md:1047; research.md R7 "Corresponding Source location" (a dated paragraph: public before the preview, user decision 2026-10-24); tasks.md T176 and T177 ("the v1.0 release"; T177 passes on a B-RELEASE row that says the v1.0 release is blocked). `specs/001-desktop-qualification/spec.md` line 23 (Clarification), line 529 (Assumption), FR-033, and SC-011: "public release" becomes "the v1.0 release", with a dated note (2026-10-24) that cites constitution 4.0.1. Line 37 (Clarification, "stays private"): the answer states that the repository is public since 2026-10-25, with a dated note that cites constitution 4.0.1. Then run `/speckit-analyze` for 001 with `SPECIFY_FEATURE_NO_PERSIST=1` and fix its findings. Spec: FR-003, FR-007.

### Batch 2 verification

- [ ] T028 Run the batch 2 verification: `bun install --frozen-lockfile`, `bun run build`, `bun run typecheck`, `bun run export:schemas --check`, `cargo test --locked --manifest-path src-tauri/Cargo.toml`, and `bun run test:all` (WP6). `Local: Rust`. `Local: Windows`. Pass condition: every command exits 0 with `ORIGIN` lines under this checkout, and T026 is recorded. Control mutations, each undone and rerun green: (1) replace one action commit ID with `@v4` in the workflow; the workflow test fails; (2) give `build` `contents: write`; the workflow test fails; (3) in `sums.ts`, skip the extra-file check; the `extra` case fails. The task passes only after one independent review of batch 2 is recorded in research.md R7, with security scrutiny of the workflow permissions and the SignPath token use. Depends on T023, T026, T027.

**Checkpoint**: The workflow is complete and rehearsed locally. Nothing has run on GitHub yet.

---

## Phase 7: Dry run and release (Batch 3, P6 and P7, WP8)

**Agent**: scout for runs and records. The orchestrator does each `GitHub` step after the user's OK.

- [ ] T029 [US2] Dry run on GitHub (quickstart.md Q5) (P6, WP8). `GitHub`. The orchestrator pushes the branch head to `release-dry-run` in the private repository. Pass condition: `build` succeeds, `publish` is skipped, the `release-files` artifact passes `sums.ts verify`, and the in-job `check.ts` after the build passes. Record the run URL, the image version, every tool version, the MSVC toolset, and the Windows SDK in research.md R7 (fact F6, `tar.exe` for F5). Then the orchestrator deletes the `release-dry-run` branch. Spec: FR-010 to FR-016. Depends on T028.
- [ ] T030 [US1] Install the dry-run installer in Windows Sandbox (quickstart.md Q4) (P6, WP8). `Local: package`. Pass condition as T017. Record the installer SHA-256 and the results in research.md R7. Spec: SC-001, SC-004. Depends on T029.
- [ ] T031 [US2] Release settings (P7, WP8). `GitHub`. After the user's public switch: confirm `"private": false` with an anonymous `gh api repos/auric/arbareto`; create the environment `release` with the user as required reviewer and the deployment tag rule `v*`; switch on immutable releases; confirm that `main` holds features 005 and 006. Record each setting and its read-back in research.md R7. Spec: FR-004, FR-006, FR-018, FR-028. Depends on T030.
- [ ] T032 [US3] Release v0.1.0 (quickstart.md Q6) (P7, WP8). `GitHub`. Merge this feature into `main` first. The orchestrator tags `v0.1.0` on `main` and pushes the tag; the user approves `publish`. Pass condition: a pre-release "Arbareto Preview v0.1.0", not latest, marked immutable, with four files; `sums.ts verify` on the downloads exits 0; `gh attestation verify` passes for each file and fails for a copy with one changed byte; an asset upload to the release is refused; the Sandbox install passes as T030; both About links open their targets while signed out. Record everything in research.md R7. Spec: SC-001 to SC-007. Depends on T031.

### Batch 3 verification

- [ ] T033 Run the batch 3 verification (WP8): confirm that research.md R7 holds the T029 to T032 records, and that the release page and the README show the Smart App Control sentence. Control mutation: push a tag `v0.1.99` on a scratch commit outside `main` in a disposable fork or after the user's OK; the run fails with `RELEASE_CHECK not-on-main`, and no release appears; delete the tag. The task passes only after one independent review of batch 3 is recorded in research.md R7. Depends on T032.

**Checkpoint**: Preview v0.1.0 is public, verifiable, and immutable.

---

## Phase 8: User Story 5 - Signing switch-on (after the SignPath approval)

**Agent**: user (T034), orchestrator and implementer (T035 to T037). This phase does not gate v0.1.0.

- [ ] T034 [US5] The user applies to SignPath Foundation at https://signpath.org/apply with the repository URL, the `AGPL-3.0-or-later` licence, the v0.1.0 release URL, and the README description, and confirms MFA on GitHub (research.md R1). The user asks SignPath about the uninstaller, the NSIS plugin DLL, and one approval per release. Record the dates and the answers in research.md R7. Spec: FR-045. Depends on T032.
- [ ] T035 [US5] Add the "Code signing policy" section to `README.md` and complete `.github/release-notes/signed.md`: the SignPath text, the team roles (the user as author, reviewer, and approver), and the privacy statement of research.md R1. Spec: FR-044, FR-046. Depends on T034.
- [ ] T036 [US5] Configure SignPath and the switch (orchestrator with the user). `GitHub`. SignPath artifact configuration: stage 1 `<zip-file>` with two `<pe-file>` entries and the product name and version restrictions; stage 2 `<pe-file>`. Repository variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_POLICY_SLUG`, and the secret `SIGNPATH_API_TOKEN`; then `ARBARETO_SIGNING=signpath`. Confirm that the workflow file did not change (spec SC-008). Spec: FR-040. Depends on T035.
- [ ] T037 [US5] Release a signed test version (for example v0.1.1) and check it (P7). `GitHub`. `Local: package`. `Get-AuthenticodeSignature` reports `Valid` for the installer and for the installed `arbareto.exe` and `arbareto-git.exe`; the checksums and attestations cover the signed files. Control: reject the stage 1 request in SignPath on a second test run; the run fails, and no release appears. Record in research.md R7. Spec: FR-041 to FR-043. Depends on T036.

---

## Dependencies & Execution Order

- Batch 0: T001 to T004 in parallel, then T005; T006 and T007 in parallel, then T008, T009, T010.
- Batch 1: T011, then T012, then T013 (waits for 006 on `main`) and T014; T015 after T012; T016 after T013 and T015; T017 last.
- Batch 2: WP5 (T018 to T023) and WP6 (T024 to T026) in disjoint files; T025 needs T019 to T022; T027 any time in batch 2; T028 last.
- Batch 3: T029 to T033 in order. T031 needs the user's public switch. T032 needs 005 and 006 on `main` and this feature merged.
- Phase 8 after T032 and the SignPath approval.

### Parallel examples

- Batch 0: T001, T002, T003, and T004 (four independent fact runs); T006 and T007.
- Batch 1: T015 can start when T012 lands.
- Batch 2: T019, T020, T021, and T022 after T018; T024 alongside WP5.

## Coverage

| Requirement | Tasks |
| --- | --- |
| FR-001, FR-002 | T011, T012, T015, T016, T025, T032 |
| FR-003 | T022, T027 |
| FR-004 | T025, T031 |
| FR-005 | T006, T008 |
| FR-006 | T031 |
| FR-007 | T027 |
| FR-010 to FR-016 | T006 to T009, T024 to T026, T029 |
| FR-017 to FR-019 | T024, T025, T032 |
| FR-020 to FR-024 | T018 to T022, T024, T025, T032 |
| FR-025 to FR-027 | T018, T022, T023 |
| FR-028 | T031, T032 |
| FR-029 | T023 |
| FR-030 to FR-032 | T011, T013, T015, T016, T032 |
| FR-033, FR-034 | T002, T003, T014, T017 |
| FR-040 to FR-043 | T024, T025, T036, T037 |
| FR-044 to FR-046 | T022, T034, T035 |
| SC-001, SC-004 | T017, T030, T032 |
| SC-002, SC-003 | T018, T020, T032 |
| SC-005 | T007, T010, T017, T033 |
| SC-006 | T029, T032 (times recorded) |
| SC-007 | T032 |
| SC-008 | T024, T036 |

## Implementation Strategy

- MVP: batches 0 and 1 give a local preview package with the preview identity (US1). Stop and validate with the user.
- Batch 2 adds the release files, the notes, the workflow, and the 001 amendments, all checked locally.
- Batch 3 runs the dry run, then the real release after the public switch.
- Phase 8 follows the SignPath approval.
- Each batch ends with its verification task, the control mutations, and one independent review.

## Notes

- Run `/speckit-analyze` after every edit of this file.
- Run `/speckit-converge` at the end of each batch.
- The orchestrator commits after each task or logical group.
- The tauri-cli 2.12.4 and NSIS 3.13 update is not part of this feature (user, 2026-10-24). After it, `pins.ts`, `notices.ts`, and the NSIS licence folder change together.
