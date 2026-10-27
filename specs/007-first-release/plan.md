# Implementation Plan: First Release (Preview v0.1.0)

**Branch**: `007-first-release` | **Date**: 2026-10-24 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/007-first-release/spec.md`, research from `research.md` R1 to R6, and the user answers of 2026-10-24 (spec Clarifications).

## Summary

A tag `v0.1.0` on `main` starts one GitHub Actions workflow on `windows-2025`. The `build` job checks the tag and the tree, installs pinned tools, builds the two executables (`cargo tauri build --no-bundle`), runs an optional SignPath step, packs the NSIS installer (`cargo tauri bundle --bundles nsis`), runs an optional second SignPath step, and makes the release files: the installer, `SHA256SUMS.txt`, the third-party notices text, and the Hunspell source archive. The `publish` job waits for the maintainer in the `release` environment, attests every file, creates a draft pre-release from the `CHANGELOG.md` section, uploads the files, and publishes. One repository variable switches signing on. The application gains a build channel (`local` or `preview`): About shows "Preview" and two release links, and the release "Installed apps" entry reads "Arbareto". A dry-run trigger builds without publishing, so the workflow runs on GitHub before the public switch. The plan also amends 001 B-RELEASE and R7 so that they gate v1.0.

## Technical Context

**Language/Version**: TypeScript `7.0.2` on Bun `1.4.4` (exact, constitution VIII exception) for the release scripts and tests. Rust `1.99.0` through a new `rust-toolchain.toml` (001 minimum `1.98.0` stays the minimum). GitHub Actions workflow YAML.

**Primary Dependencies**: No new package. Build tools: tauri-cli `2.12.0` (`cargo install --locked`; it pins tauri-bundler `=2.10.0`, which downloads NSIS `3.11` by SHA-1, research R2). GitHub-hosted runner `windows-2025` (Windows Server 2025 with Visual Studio 2026, image `20261007.264.1` on 2026-10-24). Actions, each by full commit SHA: `actions/checkout`, `actions/upload-artifact`, `actions/download-artifact`, `actions/attest`, and, for the signing switch, `signpath/github-action-submit-signing-request`. The preinstalled `gh` CLI creates the release. The GitHub JavaScript actions run on the runner's own Node: a CI-only Node use (constitution II disclosure). Windows `C:\Windows\System32\tar.exe` packs the source archive.

**Storage**: None. Release files live as GitHub workflow artifacts and release assets.

**Testing**: `bun test` contract tests for the release scripts, the workflow file, the notices text, and the About changes. `cargo test --locked` for the build channel in `build.rs`. A packaged install in Windows Sandbox (`scripts/windows/clean-install.wsb`). A dry-run workflow run on GitHub, then the real tag run.

**Target Platform**: Windows 11 x64 (Windows 10 x64 runs unqualified). Build host: GitHub-hosted `windows-2025`, and the reference host for local checks.

**Project Type**: Desktop application release process.

**Performance Goals**: SC-006 starting budgets: build job at most 90 minutes, approval to published release at most 15 minutes. These are not measurements.

**Constraints**: No secret in the build path except the optional SignPath token. No cache in the release workflow (research R2). No heuristic: every check uses an exit code that the tool documents, machine-readable output (`cargo metadata`, `gh api` JSON, `git status --porcelain`), a SHA-256, or a contract value.

**Scale/Scope**: One installer per release, four release files, one workflow file, six release scripts, about ten application files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Plan evidence | State |
| --- | --- | --- |
| I. Preserve User Data | The release changes no Git behavior. The installer stays current-user NSIS with its uninstaller. | Pass |
| II. TypeScript/Bun and Minimal Native Code | Release scripts are TypeScript under Bun. Rust changes only `build.rs` (channel input), the handshake field, and one link command that reuses the 006 `links.rs` opener. CI-only Node: the GitHub JavaScript actions (disclosed here). The product embeds no Node. | Pass |
| III. Validated Operation Boundaries | The renderer never sends a URL. `openReleaseLink` takes a closed enum, and the shell builds each URL from compile-time constants (D7). | Pass |
| IV. Real Git State Verification | The tag and tree checks run real Git in disposable repositories in tests (`merge-base --is-ancestor`, `status --porcelain`). | Pass |
| V. Untrusted Repositories and Credentials | The build job has no write token and no secret when signing is off. The SignPath token never reaches logs. Upstream Hunspell trees are fetched by commit ID, and Git verifies the object hashes. | Pass |
| VI. Platform-Specific Evidence | The packaged installer from the dry run installs in Windows Sandbox (quickstart Q4). The preview claims no qualification (spec FR-003). | Pass |
| VII. Accessible and Measured Interface | The two About links are buttons with names, focus, and keyboard access, as the 006 licence link. No new budget. | Pass |
| VIII. Locked Dependencies | Every tool and action has an exact pin. `bun install --frozen-lockfile` and Cargo `--locked` stay. The run record lists every version (spec FR-016). | Pass |
| IX. One Upstream Planning Process | All records stay in `specs/007-first-release/`. The 001 amendments edit 001 artifacts only where the user asked (D12). | Pass |
| Delivery gate: update authenticity | Constitution 4.0.1 defines a production release as a release that users get through an in-app updater or a stable (not pre-release) distribution channel. The preview is a GitHub pre-release that users download by hand, with no updater, so the gate does not apply to it. 001 B-RELEASE gates v1.0 (D12). | Pass |

Post-design re-check: no change. No violation needs the Complexity Tracking table.

## Project Structure

### Documentation (this feature)

```text
specs/007-first-release/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── release.md
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
.github/workflows/release.yml          new: the release workflow (D1 to D5)
.github/release-notes/                 new: fixed release-note blocks (D9)
rust-toolchain.toml                    new: Rust 1.99.0 (D2)
.cargo/config.toml                     new: /Brepro link flag for x86_64-pc-windows-msvc (D1)
CHANGELOG.md                           new: user-visible changes per release (D9)
README.md                              Download section, code signing policy placeholder, Status text (D10)
package.json                           build:service Windows file properties (D8)
scripts/release/
├── check.ts                           tag, version, main, and tree checks (D3)
├── notices-text.ts                    notices.json to the notices text file (D6)
├── hunspell-source.ts                 the Hunspell source archive (D6)
├── sums.ts                            SHA256SUMS.txt write and verify (D5)
├── notes.ts                           release notes from CHANGELOG.md and the fixed blocks (D9)
└── pins.ts                            the pinned tool versions and hashes (D2)
src-tauri/build.rs                     ARBARETO_RELEASE_CHANNEL; preview refuses a dirty tree (D4)
src-tauri/src/service.rs               handshake buildIdentity.channel (D4)
src-tauri/src/release_link.rs          new: open_release_link URL builder (D7)
src-tauri/src/links.rs                 the 006 opener that open_release_link calls (D7)
src-tauri/src/build_channel.rs         new: channel rule shared by build.rs and tests (D4)
src-tauri/tauri.preview.conf.json      new: release overlay, installer hook path (D8)
src-tauri/installer-hooks.preview.nsh  new: no DisplayName override (D8)
src/contracts/channel.ts, envelope.ts  buildIdentity.channel replaces signing (D4)
src/contracts/schemas/                 regenerated JSON Schema files
src/frontend/about/AboutDialog.tsx     preview marker, two release links (D7)
src/frontend/boot/BootView.tsx         marker by channel (D4)
tests/contracts/release-*.test.ts      new contract tests (Steps)
tests/git/release-check.test.ts        new real-Git tests for check.ts
specs/001-desktop-qualification/       plan.md B-RELEASE and lines 613 and 1047, research.md R7, tasks.md T176 and T177 (D12)
```

**Structure Decision**: The release logic lives in `scripts/release/` as plain Bun scripts that the workflow and the local checks both run. The workflow holds only tool installs, script calls, and the job structure. No release code enters the renderer bundle or the service.

## Design decisions

### D1 Workflow triggers and jobs

- File: `.github/workflows/release.yml`. Workflow-level `permissions: {}`. Each job states its own permissions (spec FR-019).
- Triggers:
  - `push` with `tags: ['v*']`: the release run.
  - `push` with `branches: ['release-dry-run']`: the dry run. It runs `build` only.
  - `workflow_dispatch`: a dry run from `main` after the merge. It runs `build` only.
- `concurrency: group: release-${{ github.ref }}`, `cancel-in-progress: false`.
- Job `build` (`runs-on: windows-2025`, `timeout-minutes: 120`, `permissions: { contents: read, actions: read }`): steps in D2 to D6. It uploads one workflow artifact `release-files` (retention 7 days).
- Build bytes (fact F1, research R7 T001 and T005): the two-stage build (`package:preview:exes`, then `package:preview:bundle`) and the one-step `bun run package` from the same clone path give the same `arbareto.exe` bytes (SHA-256). The repository `.cargo/config.toml` sets `-C link-arg=/Brepro` for `x86_64-pc-windows-msvc`, so `link.exe` writes hash values for the PE `TimeDateStamp`, the debug directory timestamps, and the PDB GUID. Without the flag, these 24 bytes differ on each link. A workflow or job `RUSTFLAGS` value replaces the config `rustflags`, so the workflow sets no `RUSTFLAGS`.
- Job `publish` (`runs-on: windows-2025`, because the only Bun pin is the Windows archive; `needs: build`, `if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')`, `environment: release`, `timeout-minutes: 30`, `permissions: { contents: write, id-token: write, attestations: write }`): steps in D5 and D9.
- Environment `release` (orchestrator setting step, after the public switch): required reviewer the user; deployment tag rule `v*`; no branch. GitHub Free offers required reviewers only for public repositories (research R3). So the publish job cannot run before the public switch.
- Public check: the publish job fails when `github.event.repository.private` is not `false` (spec FR-004). This is an event payload value.

### D2 Pins

- `scripts/release/pins.ts` exports one record: Bun `1.4.4`, `bun-windows-x64.zip` SHA-256 `cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5`, Rust `1.99.0`, tauri-cli `2.12.0`, NSIS `v3.11`, runner `windows-2025`. A contract test compares it with `package.json` (`packageManager`, the `build:service` check), `rust-toolchain.toml`, `TAURI_CLI_VERSION` and `NSIS_VERSION` in `src/frontend/build/notices.ts`, and the workflow file.
- `rust-toolchain.toml` at the repository root: `channel = "1.99.0"`, `profile = "minimal"`, `components = ["clippy", "rustfmt"]`, `targets = ["x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"]`. rustup reads it from the working folder and its parents. The cloud setup installs Rust from a tarball without rustup and is not affected; its `1.98.0` stays the minimum (001 plan.md:23).
- Bun on the runner: download `https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-windows-x64.zip` into `$env:RUNNER_TEMP`, compare `Get-FileHash -Algorithm SHA256` with the pin, extract there, and prepend the folder to `GITHUB_PATH`. No `setup-bun` action.
- Rust on the runner: `rustup toolchain install` reads `rust-toolchain.toml`. Then `rustc --version` must print `rustc 1.99.0 `.
- tauri-cli: `cargo install tauri-cli --version 2.12.0 --locked`. Then `cargo tauri --version` must print `tauri-cli 2.12.0`. The notices check (T375) also refuses any other value.
- Actions: each `uses:` names a 40-hex commit ID and the version tag in a trailing comment. The workflow contract test refuses any other form. The implementer reads each SHA from the action repository tag at implementation time and records it in research.md R7.
- No `actions/cache` step (research R2).

### D3 Tag, version, and tree checks (`scripts/release/check.ts`)

- Input: `--mode release --tag <name>` or `--mode dry-run`.
- Version: `cargo metadata --no-deps --format-version 1 --manifest-path src-tauri/Cargo.toml`, package `arbareto`, field `version`. `package.json` `version` must equal it. `src-tauri/tauri.conf.json` and the preview overlay must have no `version` key, because Tauri then takes the `Cargo.toml` value (research R4).
- Release mode: the tag must match `^v(\d+\.\d+\.\d+)$`, and the captured value must equal the version. Else exit 1 with `RELEASE_CHECK tag-version <tag> <version>`.
- Release mode: `git merge-base --is-ancestor <tag commit> origin/main`. Exit 0 passes. Exit 1 fails with `RELEASE_CHECK not-on-main`. Any other exit fails with `RELEASE_CHECK git-failed <code>` (git-merge-base(1) defines 0 and 1). `actions/checkout` runs with `fetch-depth: 0`.
- Both modes: `git --no-optional-locks status --porcelain --untracked-files=all` must print nothing, before and after the build (spec FR-014).
- Release mode: `gh api repos/{owner}/{repo}/releases --paginate` JSON; a published release with the same `tag_name` fails with `RELEASE_CHECK exists`. A draft with that tag is reused (spec FR-015, FR-017). This check runs in the publish job, because the build job has no `contents: write` token and drafts need it to be visible.
- All downloads and outputs go below `$env:RUNNER_TEMP`, never into the checkout.

### D4 Build channel and clean identity

- `build.rs` reads `ARBARETO_RELEASE_CHANNEL`. Absent or empty gives `local`. `preview` gives `preview`. Any other value fails the build. `cargo:rerun-if-env-changed=ARBARETO_RELEASE_CHANNEL`.
- For `preview`, a `-dirty` identity fails the build. `local` keeps today's `-dirty` suffix.
- The handshake `buildIdentity` replaces `signing: "unsigned"` with `channel: "local" | "preview"`. Reason: the binary cannot know whether a later step signs it. The channel is a build fact. Release notes state the signing state (spec FR-026).
- Display: `local` shows "Unsigned local test package" in About and in the boot view, as today (001 FR-033). `preview` shows "Preview" in About and in the boot view.
- `src/contracts/channel.ts` and `src/contracts/envelope.ts` change together, and `bun run export:schemas` regenerates the schema files.

### D5 Release files, checksums, and attestation

- Names, with `<v>` the version:
  - `Arbareto_<v>_x64-setup.exe` (the tauri-bundler NSIS name).
  - `arbareto-<v>-third-party-notices.txt`.
  - `arbareto-<v>-hunspell-source.tar.gz`.
  - `SHA256SUMS.txt`.
- `scripts/release/sums.ts write <dir>` writes one line per other file, `<lowercase hex>  <name>`, sorted by name, LF ends. `sums.ts verify <dir>` recomputes each value and fails on any mismatch, a missing file, or an extra file.
- The publish job runs `sums.ts verify` after the download, then `actions/attest` with `subject-path` for all four files.
- Immutable releases: an orchestrator setting step at the public switch (user, 2026-10-24). The workflow does not change it.

### D6 Notices text and Hunspell source archive

- `scripts/release/notices-text.ts` reads `src/frontend/generated/notices.json` from the same build and writes the text file: the project licence and notice, then each licence group, each package with its version, and each licence text. The rendering is a pure function with a contract test: every package and every text of the JSON appears once, in JSON order.
- `scripts/release/hunspell-source.ts`:
  - For each pin (hunspell/hunspell `edb619100791110d3e34f09ec35392ad327c1135`, rotemdan/hunspell-wasm `8f755ef64e8b047b77b676f9698b3dfa5cb1887d`): `git init` in a temp folder, `git fetch --depth 1 https://github.com/<repo> <commit>`, then `git rev-parse FETCH_HEAD^{commit}` must equal the pin. Git verifies the object IDs on fetch.
  - `git archive --format=tar --prefix=<repo-name>/ <commit>`, extracted into one staging folder.
  - `SOURCE.txt` in the staging root: both repository URLs, both commit IDs, the licence "LGPL-2.1 (Hunspell is also available under GPL-2.0 and MPL-1.1)", the statement that the 30 files of `hunspell-wasm/lib/hunspell/` equal `hunspell/src/hunspell/` (006 F16), and the statement that the Emscripten version of the shipped `hunspell.wasm` is not recorded upstream.
  - `C:\Windows\System32\tar.exe -czf` packs the staging folder. The shell path is literal.
- The 006 D18 note in About stays. D7 adds the release asset link.

### D7 About links and preview marker

- New shell command `open_release_link` with argument `{ "target": "hunspell-source" | "tag-source" }`. It is enabled only for the `preview` channel. A `local` build refuses with a typed error.
- The shell builds each URL from compile-time constants: `CARGO_PKG_REPOSITORY` (`https://github.com/auric/arbareto`), `CARGO_PKG_VERSION`, and `ARBARETO_BUILD_IDENTITY`.
  - `hunspell-source`: `<repository>/releases/download/v<version>/arbareto-<version>-hunspell-source.tar.gz`.
  - `tag-source`: `<repository>/tree/<commit>`.
- It opens the URL with the 006 `links.rs` opener (`ShellExecuteW` after `CoInitializeEx`). This needs feature 006 on `main`.
- About Overview, `preview` channel: the line "Preview", a "Hunspell source" button next to the D18 note, and a "Source at this commit" button in the Corresponding Source line. `local` channel: no buttons; the text stays as today.
- Release link failure text, 004 D15 pattern: "<button> did not complete: <code>." The button label is "Hunspell source" or "Source at this commit". The code is the response code, such as `RELEASE_LINK_OPEN_FAILED`. The text shows below the buttons and clears after a successful open.
- A contract test in Rust checks both URLs for a fixed version and commit.

### D8 Release installer name and service file properties

- `src-tauri/tauri.preview.conf.json` sets `bundle.windows.nsis.installerHooks` to `./installer-hooks.preview.nsh`. tauri-cli 2.12.0 merges `--config` files as a JSON merge patch (`src/helpers/config.rs`), so the string replaces the local hook path.
- `installer-hooks.preview.nsh` defines no `NSIS_HOOK_POSTINSTALL`. The bundler then writes `DisplayName` `${PRODUCTNAME}` (tauri-bundler 2.10.0 `installer.nsi:702`), so "Installed apps" shows "Arbareto" and version `0.1.0`.
- Two new `package.json` scripts carry both inputs together, so they cannot disagree: `package:preview:exes` (`ARBARETO_RELEASE_CHANNEL=preview cargo tauri build --no-bundle --target x86_64-pc-windows-msvc --config src-tauri/tauri.preview.conf.json -- --locked`) and `package:preview:bundle` (`ARBARETO_RELEASE_CHANNEL=preview cargo tauri bundle --bundles nsis --no-binary-patching --target x86_64-pc-windows-msvc --config src-tauri/tauri.preview.conf.json`; D11 states why), followed by the same version prints as `package`. Bun Shell runs the `NAME=value command` form on Windows. The workflow and the local rehearsal call only these scripts. README "Development" lists them after they run green.
- `build:service` adds the Bun Windows file properties. The property that becomes the PE `ProductName` gets "Arbareto", because SignPath requires the project name as the product name of every signed file (research R1). The others: publisher "Ihor Lifanov", version `0.1.0`, description "Arbareto Git service", copyright "Copyright (c) 2026 Ihor Lifanov". The exact CLI flag names and the PE fields they set are fact F2. The pins test compares the version with `Cargo.toml`.

### D9 Release notes and changelog

- `CHANGELOG.md`: one `## [<version>] - <date>` section per release, user-visible changes only (global changelog rule). The 0.1.0 section lists the feature set of README "Features" after 005 and 006.
- `.github/release-notes/` holds the fixed blocks: `preview.md` (preview and qualification state, spec FR-003), `prerequisites.md` (spec FR-027), `unsigned.md` (SmartScreen prompt, Smart App Control block, checksum and attestation commands, spec FR-026), and `signed.md` (code signing policy, unsigned uninstaller and plugin DLL, spec FR-044, FR-046).
- `scripts/release/notes.ts --version <v> --signing off|signpath` writes the notes: the CHANGELOG section, then the blocks. A missing section fails with `RELEASE_NOTES missing <version>`.
- The publish job: `gh release create v<v> --draft --prerelease --verify-tag --title "Arbareto Preview v<v>" --notes-file <notes>` when no draft exists, `gh release upload --clobber` for the files of a draft, then `gh release edit v<v> --draft=false --prerelease --latest=false`.

### D10 README

- A "Download" section: the Releases link, the prerequisites, the checksum command for PowerShell and for `sha256sum`, the `gh attestation verify <file> -R auric/arbareto` command, the SmartScreen prompt, and the sentence "Unsigned builds do not run when Smart App Control is on." (user, 2026-10-24).
- The Status bullet "No installer release exists yet" changes to name the preview.
- A "Code signing policy" section waits for the SignPath approval (signing switch-on tasks).

### D11 Signing switch

- Repository variable `ARBARETO_SIGNING`: `off` (default when unset) or `signpath`. Any other value fails the build job.
- With `signpath`, the build job also needs the variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_POLICY_SLUG`, and the repository secret `SIGNPATH_API_TOKEN`. A missing value fails the job.
- Stage 1 sign: `actions/upload-artifact` of a ZIP with `arbareto.exe` and `arbareto-git.exe`, then the SignPath action with `wait-for-completion: true`, a 3,600 s bound, and `output-artifact-directory` below `RUNNER_TEMP`. The signed files replace the unsigned ones in the target folder. Then `cargo tauri bundle`.
- Bundler patch (research R7 T001): without `--no-binary-patching`, `cargo tauri bundle` replaces the marker `__TAURI_BUNDLE_TYPE_VAR_UNK` with `__TAURI_BUNDLE_TYPE_VAR_NSS` in `arbareto.exe` before NSIS packs it (tauri-bundler 2.10.0 `src/bundle.rs:40-98`). This invalidates a stage 1 signature (tauri-cli 2.12.0 `bundle --help`). Only the updater reads the marker, and the preview has no updater (spec FR-005). So `package:preview:bundle` always passes `--no-binary-patching` (D8), with signing on and off.
- Release comparison: each installed file equals its build input byte for byte. `arbareto.exe` equals the target file after stage 1 (or after the stage 1 sign), and `arbareto-git.exe` equals `src-tauri/binaries/arbareto-git-x86_64-pc-windows-msvc.exe`. The local `bun run package` keeps the patch, so its installed `arbareto.exe` differs from the built file in the 3 marker bytes only.
- Stage 2 sign: `upload-artifact` with `archive: false` of the installer, then the SignPath action again.
- A failed, rejected, or timed-out request fails the job (spec FR-043). No step continues on error.
- The token is a repository secret, not an environment secret, so the build job needs no approval wait. SignPath requires a manual approval for each request, and its `github-scm-policies` can restrict the source refs (research R1).
- The workflow contains both sign stages from the start, behind `if: vars.ARBARETO_SIGNING == 'signpath'`. They cannot run before the SignPath approval. Their first run is a switch-on task.

### D12 001 amendments (user, 2026-10-24)

- 001 plan.md B-RELEASE row: the current state says "v1.0 release blocked". The condition keeps licences, signing, update authenticity, and tampered-update rejection. A note cites the constitution 4.0.1 definition: a GitHub pre-release that users download by hand is not a production release.
- 001 plan.md:613 and :1047: "private until version 1" and "public release blocked" change to the public preview and the v1.0 gate.
- 001 research.md R7 "Corresponding Source location": add a dated paragraph: the repository becomes public before the preview (user, 2026-10-24); the v1.0 gate stays.
- 001 tasks.md T176 and T177: "public release" changes to "the v1.0 release". T177's pass condition reads "says that the v1.0 release is blocked". Then `/speckit-analyze` runs for 001 with `SPECIFY_FEATURE_NO_PERSIST=1`.
- 001 spec.md line 23 (Clarification), line 529 (Assumption), FR-033, and SC-011: "public release" changes to "the v1.0 release", with a dated note that cites constitution 4.0.1 (user, 2026-10-24).
- 001 spec.md line 37 (Clarification, "stays private"): the answer states that the repository is public since 2026-10-25, with a dated note that cites constitution 4.0.1.

## Facts to verify before the dependent work

| ID | Fact | Check | Blocks |
| --- | --- | --- | --- |
| F1 | `cargo tauri build --no-bundle` then `cargo tauri bundle --bundles nsis` gives an installer with the same files as the one-step build. tauri-cli 2.12.0 has both (`src/build.rs:49`, `src/lib.rs:149`). | Local: package. Compare the file list and hashes of the installed folder. Result (research R7 T001, T005): same with `/Brepro`; the bundler patches 3 marker bytes. | D1, D11 |
| F2 | The Bun 1.4.4 CLI flags for the Windows title, publisher, version, description, and copyright, and the PE `VersionInfo` fields they set. The docs show the `Bun.build` form only (research R1). | Local: Windows. `bun build --compile` a stub, read `(Get-Item).VersionInfo`. | D8 |
| F3 | A `--config` overlay replaces `installerHooks`, and the installed `DisplayName` is "Arbareto". | Local: package, Sandbox. Read the uninstall key. | D8 |
| F4 | `git fetch --depth 1 <url> <commit>` works on github.com for both pins. | Local: network. | D6 |
| F5 | `C:\Windows\System32\tar.exe` exists on `windows-2025` and the reference host. | Dry run and local. | D6 |
| F6 | The MSVC toolset and Windows SDK versions on the runner. | Dry run record. | spec FR-016 |

## Steps (riskiest proof first)

1. P0 facts F1 to F5 locally.
2. P1 pins, `rust-toolchain.toml`, and `check.ts` with real-Git tests.
3. P2 build channel, handshake change, About and boot view, link command, installer overlay, service properties (tests first).
4. P3 notices text, Hunspell archive, sums, notes, CHANGELOG, README.
5. P4 workflow file and its contract test. Local end-to-end rehearsal of the build job steps (quickstart Q2).
6. P5 001 amendments and `/speckit-analyze` for 001.
7. P6 dry run on GitHub (`release-dry-run` branch push, orchestrator step after the user's OK), Sandbox install of the dry-run installer.
8. P7 after the public switch and 005 and 006 on `main`: the settings steps, the tag, the approval, and the published-release checks.

## Work packages, in run order

| WP | Agent | Files | Steps |
| --- | --- | --- | --- |
| WP1 | scout | none (facts F1 to F5 into research.md R7) | P0 |
| WP2 | implementer | `scripts/release/{pins,check}.ts`, `rust-toolchain.toml`, `tests/contracts/release-pins.test.ts`, `tests/git/release-check.test.ts`, `tests/groups.json` | P1 |
| WP3 | implementer-xhigh (local Rust) | `src-tauri/build.rs`, `src-tauri/src/service.rs`, `src-tauri/src/links.rs` (006), command registration, `src-tauri/tauri.preview.conf.json`, `src-tauri/installer-hooks.preview.nsh`, `package.json` `build:service`, `src/contracts/{channel,envelope}.ts`, schema files, contract tests | P2 (shell and contracts) |
| WP4 | frontend-implementer | `src/frontend/about/AboutDialog.tsx`, `src/frontend/boot/BootView.tsx`, their tests | P2 (UI) |
| WP5 | implementer | `scripts/release/{notices-text,hunspell-source,sums,notes}.ts`, `CHANGELOG.md`, `.github/release-notes/*`, `README.md`, tests | P3 |
| WP6 | implementer | `.github/workflows/release.yml`, `tests/contracts/release-workflow.test.ts` | P4 |
| WP7 | implementer | `specs/001-desktop-qualification/{plan,research,tasks}.md` | P5 |
| WP8 | scout (runs), orchestrator (GitHub steps) | research.md R7 records | P6, P7 |

## Batches

- Batch 0: WP1, then WP2. Runs now, on `007-first-release` from `main`.
- Batch 1: WP3, then WP4 (WP4 needs the WP3 contract). Needs 006 on `main` for `links.rs`. Until then, WP3 starts without the link command, and the link task waits.
- Batch 2: WP5 and WP6 in disjoint files, then WP7.
- Batch 3: WP8. Needs the user's OK for the dry-run branch push. The tag run needs the public switch and 005 and 006 merged.

## Risks

- The SignPath stages cannot run before the approval. Their YAML is checked only by the contract test. Mitigation: switch-on tasks with a test release `v0.1.1` (research R1 Q9).
- `windows-2025` updates weekly. The pins hold the versions; the run record shows the image.
- `cargo install tauri-cli` builds from source on each run. Guess: 5 to 10 minutes.
- The dry run on the private repository uses paid minutes at the Windows rate. Guess: under 200 of the 2,000 Free minutes.
- The uninstaller and the NSIS plugin DLL stay unsigned under SignPath (user, Q3).
