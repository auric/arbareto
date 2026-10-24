# Research: First Release (Preview v0.1.0)

Research date: 2026-10-24. Each fact cites a source URL or a repository file. A line that starts with "Guess:" is not verified. "Unverified" marks a fact that needs a check during the plan or the implementation.

## R1. SignPath Foundation

### Eligibility (source: https://signpath.org/terms)

- No malware and no potentially unwanted programs.
- An OSI-approved licence for all components, without commercial dual-licensing. Arbareto uses `AGPL-3.0-or-later` (`LICENSE`, `package.json`).
- No proprietary component. System Libraries in the GPL-3.0 section 1 sense may be in signed packages. The WebView2 Runtime is not in the installer (`webviewInstallMode` `skip` in `src-tauri/tauri.conf.json`).
- The project is actively maintained.
- "Released: The project must already be released in the form that should be signed." So a first, unsigned release must exist before the application.
- "Documented: The project's functionality must be described on its download page."
- Signing certificates from SignPath Foundation add these conditions:
  - Every team member uses multi-factor authentication for SignPath and for GitHub.
  - The project names Authors, Reviewers, and Approvers. For a single-maintainer project, the user holds all three roles.
  - The project home page and the download or release pages carry a section or link named "Code signing policy". It contains the text "Free code signing provided by SignPath.io, certificate by SignPath Foundation", the team roles and members, and a privacy statement. The proposed statement is the SignPath default: "This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it". Arbareto sends data only on user actions: fetch, pull, push, clone, and the 006 dictionary download.
  - All signed binaries must have product name and product version metadata, enforced by SignPath file metadata restrictions. Upstream OSS project binaries must not be signed with the project subscription, but they may be inside signed installers.
  - "Binary artifacts must be built from source code in a verifiable way." "Every release needs manual approval for signing."
  - Software must not change system configuration without warnings, and it must provide an uninstaller. The NSIS installer has one.
- A code of conduct for the project is not a SignPath condition. The "Code of conduct" heading on the terms page is the SignPath Foundation code of conduct for projects (draft). One applicant added a `CODE_OF_CONDUCT.md` to improve its chances (https://zenn.dev/shm_7ec/articles/signpath-oss-code-signing?locale=en). Guess: it helps the review, but nothing requires it.

### Application process

- Form: https://signpath.org/apply (also https://signpath.org/apply.html). The page renders the form with scripts, so the field list was not read directly.
- A 2026 applicant report lists the fields: project and repository URL, licence, download or release URL, project description, and a contact e-mail. It recommends a root `LICENSE`, a README that states what the product is and where to download it, build instructions, and a code signing policy page (https://zenn.dev/shm_7ec/articles/signpath-oss-code-signing?locale=en).
- After the application, SignPath reviews it, may ask questions by e-mail, and then sends setup guidance: SignPath project creation, GitHub integration, and signing policy design (same source).
- Time to approval: SignPath publishes no figure. One project guide says "Usually takes 1-2 business days" (https://prism-studio.readthedocs.io/en/v1.12.0/GITHUB_SIGNING.html). Tabularis, a desktop database client, reports acceptance and "over the next few weeks" of pipeline integration (https://tabularis.dev/blog/signpath-code-signing). Guess: plan for 1 to 3 weeks from application to the first signed release.

### Signing with GitHub Actions (source: https://docs.signpath.io/trusted-build-systems/github)

- Prerequisites: the predefined Trusted Build System "GitHub.com" is added to the SignPath organization and linked to the SignPath project. The SignPath GitHub App is installed for audit log evaluation.
- SignPath checks that a GitHub workflow made the build, that GitHub (not the build script) supplied the origin metadata, that the artifact is stored as a GitHub workflow artifact before the request, and, for OSS projects, that every job up to the request ran on GitHub-hosted runners.
- Artifact flow: `actions/upload-artifact` (v4 or later) uploads the unsigned files, and its `artifact-id` output goes to `signpath/github-action-submit-signing-request` as `github-artifact-id`. With `wait-for-completion: true` and `output-artifact-directory`, the action downloads the signed files. The default wait is 600 seconds (`wait-for-completion-timeout-in-seconds`). The action needs `api-token`, `organization-id`, `project-slug`, and `signing-policy-slug`. Its `github-token` needs `actions: read` and `contents: read`.
- `upload-artifact` makes a ZIP by default. Then the SignPath artifact configuration root must be `<zip-file>`. `archive: false` uploads one file as itself.
- Pipeline policies can require GitHub-hosted runners and ruleset constraints on the source branch, for example `non_fast_forward` and pull request reviews (`github-scm-policies`).
- Supported formats (https://docs.signpath.io/artifact-configuration/reference): `<pe-file>` (EXE, DLL), `<msi-file>`, `<cab-file>`, `<msix-file>`, `<zip-file>` with nested files, and others. No NSIS format is listed. So SignPath can sign the NSIS installer as one PE file, but it cannot open it and sign the files inside.

### Consequence for the build design

- tauri-bundler 2.10.4 signs, when signing is configured: the main binary (`src/bundle.rs:168-169`), each external binary such as the service sidecar (`src/bundle.rs:347-379`), the NSIS plugin DLLs (`src/bundle/windows/nsis/mod.rs:688-695`), the uninstaller through `!uninstfinalize` (`installer.nsi:102`), and the installer (`mod.rs:733-734`). Source: crate `tauri-bundler` 2.10.4 from https://static.crates.io/crates/tauri-bundler/tauri-bundler-2.10.4.crate.
- A Tauri `signCommand` runs once per file during the bundle step. With SignPath, each call would be a separate signing request with its own manual approval, and each file must first be a GitHub workflow artifact. Guess: a `signCommand` cannot satisfy the SignPath GitHub connector, because it cannot run `actions/upload-artifact` from inside the bundler.
- Proposed design (unverified, for the plan): split the build into two stages.
  - Stage 1: `cargo tauri build --no-bundle` (tauri-cli 2.12.4 `src/build.rs:49,132`) builds `arbareto.exe`. `bun run build:service` builds the sidecar. Upload both in one ZIP. One SignPath request signs both nested PE files.
  - Stage 2: `cargo tauri bundle --bundles nsis` (tauri-cli 2.12.4 `src/lib.rs:149,278`) packs the signed files. Upload the installer with `archive: false`. A second SignPath request signs it.
  - With signing off, both requests are skipped, and the same stages run. This meets FR-040.
  - Open limits: the uninstaller that `!uninstfinalize` makes and the Tauri NSIS plugin `nsis_tauri_utils.dll` stay unsigned in this design. Signing the plugin DLL may break the SignPath rule against signing upstream binaries. Ask SignPath during onboarding.
  - Two manual approvals per release. Guess: one approval is possible if SignPath accepts a ZIP that holds the stage 2 input. Ask SignPath.
- Metadata restriction: the service sidecar today carries Bun's own file properties. Bun 1.4.4 `bun build --compile` accepts Windows `title`, `publisher`, `version`, `description`, and `copyright` options (https://raw.githubusercontent.com/oven-sh/bun/bun-v1.4.4/docs/bundler/executables.mdx, "Windows-specific flags"). The documentation shows them in the `Bun.build` API. The CLI form was not checked. These options set product name and version, as SignPath requires (FR-034). Unverified: whether SignPath treats the Bun-compiled sidecar as an "upstream OSS binary". It is Arbareto's own build output that embeds the Bun runtime.

### What the repository must have before the application

| Item | State on main 53f9a123 | Source |
| --- | --- | --- |
| OSI licence file at the root | Present: `LICENSE` (AGPL-3.0) and `NOTICE.md` | repository |
| Public repository | Missing: `auric/arbareto` is private | user decision 2026-10-24 |
| A release in the form to sign | Missing: no release and no tag | SignPath terms "Released" |
| README with function and download location | Partly: function yes; it says "No installer release exists yet" | `README.md` Status |
| Build instructions | Present: README "Build from source" and "Development" | `README.md` |
| CI build on GitHub-hosted runners | Missing: `.github/` holds only `ISSUE_TEMPLATE/` | repository |
| Code signing policy section | Missing | SignPath terms |
| Privacy statement | Missing | SignPath terms |
| MFA on GitHub | Unverified: the user's account setting | SignPath terms |
| Code of conduct | Missing, not required | R1 above |
| `SECURITY.md`, `CONTRIBUTING.md` | Present | repository |

## R2. Tauri 2 Windows build in GitHub Actions

### tauri-apps/tauri-action against the own script

- `tauri-apps/tauri-action` builds the app and can create or update a GitHub release and upload assets (https://raw.githubusercontent.com/tauri-apps/tauri-action/dev/README.md). By default it runs the project's CLI through `npm|pnpm|yarn|bun tauri`, or it installs a global `@tauri-apps/cli` when it finds none. `tauriScript` can point at a `tauri-cli` binary path without spaces.
- Arbareto runs the cargo-installed native CLI (`cargo tauri`), and `build:notices` refuses any CLI output other than `tauri-cli 2.12.0` for a Windows Tauri build (001 tasks.md T375; `src/frontend/build/notices.ts`). The npm `@tauri-apps/cli` package runs on Node. Constitution II requires a Node development tool to be disclosed in the plan.
- The action creates the release in the same job as the build. That job then needs `contents: write`, which conflicts with FR-019. The action also has no SignPath stage between the executable build and the bundle step.
- Recommendation: do not use `tauri-action`. Use the repository's own commands (`bun run build`, `cargo tauri build`/`bundle`, and the `package` version prints), and create the release with the preinstalled `gh` CLI in a separate publish job. This keeps one build path for local and CI packages.

### Tool pins

| Tool | Pin | Fact | Source |
| --- | --- | --- | --- |
| Bun | `1.4.4`, `bun-windows-x64.zip` SHA-256 `cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5` | `.claude/cloud-setup.sh` pins the Linux zip `bf8ccbfb…fccb395c`; that value equals the `bun-linux-x64.zip` line of the same file. The baseline Windows zip is `0f20ce66…c78d99`. | https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/SHASUMS256.txt |
| Rust | Proposed `1.99.0` | The reference host runs `rustc 1.99.0 (b940084d7 2026-09-28)`. 001 plan.md states `1.98.0` as the minimum. `.claude/cloud-setup.sh` installs `1.98.0`. The runner image has `1.99.0` today but updates weekly. The repository has no `rust-toolchain.toml`. | local `rustc --version`; 001 plan.md:23; runner readme below |
| Tauri CLI | `2.12.0` today, or `2.12.4` after the pending update | crates.io: `2.12.4` (2026-10-21) is the latest stable. tauri-cli 2.12.0 pins `tauri-bundler =2.10.0`, and 2.12.4 pins `=2.10.4`. `cargo install tauri-cli --version 2.12.x --locked` builds it from source. | https://crates.io/api/v1/crates/tauri-cli and `/2.12.4/dependencies` |
| NSIS | `3.11` with tauri-cli 2.12.0, `3.13` with tauri-cli 2.12.4 | tauri-bundler 2.10.0 downloads `nsis-3.11.zip` (SHA-1 `EF7FF767…00BB10D`). tauri-bundler 2.10.4 downloads `nsis-3.13.zip` (SHA-1 `DB14F8AF2EA346B786C6AE19343F61AAF5E09B8E`). Both use `nsis_tauri_utils` v0.5.3. The bundler checks the hash. | `src/bundle/windows/nsis/mod.rs:38-44` of both crates |
| Runner | `windows-2025` | `windows-latest`, `windows-2025`, and `windows-2025-vs2026` select the same image: Windows Server 2025 with Visual Studio 2026. Image `20261007.264.1`, OS `10.0.26100`, Rust 1.99.0, Git `2.56.0.windows.2`, PowerShell 7.6.6, Windows SDK `10.1.26100.8249`. `-latest` moves to a new OS after an announcement. | https://raw.githubusercontent.com/actions/runner-images/main/README.md; https://raw.githubusercontent.com/actions/runner-images/main/images/windows/Windows2025-VS2026-Readme.md |

- Pending task: the overnight dependency update of 2026-10-23 left "Tauri CLI 2.12.4 + NSIS 3.13" as its own task: a new `TAURI_CLI_VERSION` pin and the NSIS 3.13 licence text in `third-party-licenses/tools/`, as in T375. No task ID exists yet in 001 tasks.md. Guess: decide it before the first release, so that the release does not ship an NSIS version that the next local build replaces.
- The runner image has Visual Studio 2026 build tools. The reference host uses MSVC toolset `14.44.35207` and Windows SDK `10.0.19041.0` (001 plan.md:23). These are minimum versions, so a newer toolset is allowed. The run record must show the toolset and SDK that ran (FR-016). Unverified: the MSVC toolset version on the image.
- Preview pin: use `windows-2025`, not `windows-latest`, so an OS move needs an explicit change.

### Caching

- GitHub warns that privileged workflows share the cache of the default branch with other privileged triggers (https://docs.github.com/en/actions/reference/security/secure-use, "Mitigating the risks of untrusted code checkout").
- Recommendation: no cache restore in the release workflow. `cargo install tauri-cli --locked` then takes a full source build on each release. Guess: about 5 to 10 minutes on a standard runner. This fits SC-006.

### Action pinning

- GitHub docs: pin actions to a full-length commit SHA. A new "workflow dependency lockfile" feature supersedes SHA pinning, but it is in public preview and subject to change (https://docs.github.com/en/actions/concepts/security/workflow-dependency-lockfiles).
- Recommendation: pin by full commit SHA now, with the version tag in a comment. Keep the action set small: `actions/checkout`, `actions/upload-artifact`, `actions/download-artifact`, `actions/attest`, and, later, `signpath/github-action-submit-signing-request`. The GitHub-provided JavaScript actions run on the runner's Node. This is a CI-only Node use (constitution II disclosure).

### Cost

- Standard GitHub-hosted runners are free for public repositories (https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## R3. Supply chain

- Attestations: `actions/attest-build-provenance` v4 is a wrapper on `actions/attest` (https://raw.githubusercontent.com/actions/attest-build-provenance/main/README.md). The how-to uses `actions/attest@v4` with `subject-path`, and the job needs `id-token: write`, `contents: read`, and `attestations: write` (https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations). Users verify with `gh attestation verify <file> -R auric/arbareto` (same page).
- Attestations are available for public repositories on all current plans. On Free, Pro, or Team plans, private repositories cannot use them (https://raw.githubusercontent.com/actions/attest-build-provenance/main/README.md, note). So the workflow cannot attest before the public switch (FR-004).
- Immutable releases lock the tag and the assets after publication, and they create a release attestation. GitHub recommends: create a draft, attach all assets, then publish (https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases). A deleted immutable release blocks reuse of its tag name. This setting meets FR-028. It is a repository setting, so the user switches it on.
- Environments: required reviewers can approve jobs that reference the environment (up to six). On GitHub Free, required reviewers and environment secrets are available only for public repositories. Environment secrets reach a job only after the approval. "Prevent self-reviews" exists, but a single maintainer cannot use it. Deployment branch and tag rules restrict which `GITHUB_REF` values can deploy (https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).
- Proposed job split (for the plan):
  - `build` job: `permissions: contents: read`. No secrets. Uploads the unsigned files as a workflow artifact.
  - `sign` job (only with signing on): environment `release`, `actions: read`, `contents: read`, the SignPath token as an environment secret.
  - `publish` job: environment `release` with the user as required reviewer and the tag rule `v*`. `contents: write`, `id-token: write`, `attestations: write`. It attests, writes the checksum file, creates the draft with `gh release create --draft --prerelease`, uploads, and publishes.
  - Workflow-level `permissions: {}` so each job states its own.
- Tag protection: rulesets can target tags with `fnmatch` patterns (https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets). The user decided on 2026-10-24 "No tag ruleset" for the public switch. Immutable releases plus the environment tag rule cover the published tags. A tag ruleset would also stop someone with write access from creating `v*` tags. There is only one maintainer, so this adds little (open question Q4).
- Checksums: one `SHA256SUMS.txt` file in `sha256sum` format (`<hex>  <name>`). PowerShell users compare with `(Get-FileHash <file> -Algorithm SHA256).Hash`. The checksum file itself is covered by the release attestation of an immutable release.

## R4. What the repository has today (main 53f9a123)

| Item | State | Source |
| --- | --- | --- |
| `bun run package` | `cargo tauri build --target x86_64-pc-windows-msvc --bundles nsis -- --locked`, then prints `rustc`, `cargo`, `cargo tauri`, `bun`, and `makensis -VERSION`. Output: `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`. | `package.json` scripts |
| Frontend and service build | `beforeBuildCommand` is `bun run build`: `build:notices`, `build:frontend`, `build:service`. `build:service` refuses a Bun other than `1.4.4` and compiles `arbareto-git-x86_64-pc-windows-msvc.exe` with all autoload options off. | `src-tauri/tauri.conf.json`, `package.json` |
| Build identity | `build.rs` sets `ARBARETO_BUILD_IDENTITY` to `git rev-parse HEAD`, plus `-dirty` when `git --no-optional-locks status --porcelain --untracked-files=all` prints a line. A failed Git call fails the build. | `src-tauri/build.rs:80,125-153` |
| Notices | `build:notices` writes `src/frontend/generated/notices.json` (ignored by Git). It pins `tauri-cli 2.12.0` and NSIS `v3.11` for Windows Tauri builds. Licence texts that packages lack are in `third-party-licenses/` (agent-skills, cargo, npm, runtime `bun@1.4.4`, tools `nsis@3.11`). | `src/frontend/build/notices.ts:322`; `third-party-licenses/` |
| Version source | `src-tauri/Cargo.toml` `version = "0.1.0"`. `tauri.conf.json` has no `version`, so Tauri uses the `Cargo.toml` version. `package.json` also says `0.1.0`. | tauri-utils 2.10.2 `src/config.rs:4106-4108` ("If removed the version number from `Cargo.toml` is used") |
| Installer mode | NSIS, `installMode` `currentUser`, WebView2 install `skip`. | `src-tauri/tauri.conf.json` |
| Installer hook | Sets the uninstall `DisplayName` to "Arbareto (Unsigned local test package)". | `src-tauri/installer-hooks.nsh` |
| Hunspell note | 006 D18 note names rotemdan/hunspell-wasm `8f755ef` (`lib/hunspell/`, `Makefile`) and hunspell/hunspell `edb6191`. F16: the 30 files of `lib/hunspell/` equal `src/hunspell/` at `edb6191`. The Emscripten version is not recorded, so a byte-equal rebuild stays unverified. | 006 branch `specs/006-wsl-parity-spellcheck/plan.md:418`, `research.md:229` |
| CI | None. `.github/` holds only `ISSUE_TEMPLATE/`. | repository |
| Release gate in 001 | B-RELEASE: "Public release blocked" until licences/notices, package signing, update authenticity, and tampered-update rejection have passing evidence. The repository "stays private until version 1". | 001 plan.md:1410, research.md:1429 |

### Gaps

1. No release workflow and no CI at all.
2. No Windows Bun pin: `.claude/cloud-setup.sh` pins only the Linux zip.
3. No Rust toolchain file. The runner Rust moves weekly.
4. The tauri-cli 2.12.4 and NSIS 3.13 update has no task. The notices check pins 2.12.0 and 3.11.
5. The build identity fails as `-dirty` if a CI step writes an untracked file in the checkout (for example a downloaded Bun zip). The workflow must keep downloads outside the checkout.
6. No tag-to-version check exists.
7. No standalone third-party notices file: the inventory exists only as `src/frontend/generated/notices.json`, embedded in the app.
8. No Hunspell source archive step, and About links the upstream repository, not the release asset (FR-031).
9. About has no preview marker and no link to the source of the tag (FR-002, FR-032). Unverified: what About shows today for the source link; 001 plan.md:613 names `package.json` `repository.url`.
10. The installer `DisplayName` says "Unsigned local test package" for every build (FR-033).
11. The service sidecar carries Bun file properties, not Arbareto's (FR-034, SignPath metadata rule).
12. No release notes source and no changelog file.
13. README says "No installer release exists yet" and has no download, verification, or code signing policy section.
14. 001 B-RELEASE and research R7 ("private until version 1") conflict with the 2026-10-24 decisions. The preview needs a recorded reading or an amendment there (open question Q2).
15. Constitution delivery gate: "Production release MUST remain blocked until update authenticity and tampered-update rejection have verified evidence." The preview needs a recorded reading that a pre-release without an updater is not a production release (open question Q2).
16. No `CODE_OF_CONDUCT.md` (optional).

## R5. Windows SmartScreen and Smart App Control

- SmartScreen checks publisher reputation and file hash reputation. An unsigned file starts at zero reputation for each new version. Reputation transfers between versions only when both are signed with the same publisher identity (https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).
- Unsigned or self-signed: "Windows protected your PC". The user must select "Run anyway". Enterprise policy can block the bypass (same page, certificate table).
- A newly signed file (OV or EV): still flagged as unrecognized until reputation accumulates, but the verified publisher name shows. "EV certificates no longer bypass SmartScreen." Reputation builds from download volume, with no exact threshold; "it can take several weeks and hundreds of clean installs". No submission mechanism exists for consumer endpoints (same page).
- Microsoft advice: sign every release, keep one signing identity, do not modify signed files, and tell early users about the prompt (same page, "Minimizing SmartScreen warnings in practice").
- Smart App Control (Windows 11, enforcement mode) blocks unsigned files unless they have a positive reputation. Its checks apply to all executable files, not only downloads (same page, tip). Code signed by a CA in the Microsoft Trusted Root Program can run when the intelligence service has no prediction (https://learn.microsoft.com/windows/apps/develop/smart-app-control/overview). Microsoft asks developers to sign all binaries, including installers, temporary installer files, and uninstallers (https://learn.microsoft.com/windows/security/book/application-security-application-and-driver-control).
- Consequence: on a Windows 11 PC with Smart App Control on, the unsigned preview does not run, and the user cannot override it per file. The release notes must say so (FR-026). The R1 design leaves the uninstaller and the NSIS plugin DLL unsigned. Guess: Smart App Control may then still block the uninstaller of a signed release.
- Tauri docs repeat that EV no longer gives instant reputation since 2024, and that signing every release with the same certificate carries reputation forward (https://v2.tauri.app/distribute/sign/windows/).

## R6. Open product questions

Each question is a real user choice. Each has a recommended default.

Answered on 2026-10-24 (spec Clarifications): Q2 takes option (a), and the constitution text stays unchanged. Immutable releases: yes, switched on by the orchestrator at the public switch. Q1, Q3, Q5, Q6, Q7, Q8, and Q9 take the recommended defaults. Q4 keeps the "no tag ruleset" decision.

- **Q1. Version and tag form.** Options: `v0.1.0` with the GitHub pre-release flag, or `v0.1.0-preview.1`. Recommendation: `v0.1.0` with the pre-release flag and "Preview" in the title. The user named "v0.1.0", 0.x already marks pre-1.0, and a SemVer suffix complicates the Windows file version (four numbers) and a later updater order.
- **Q2. Gate reading for the preview.** The constitution blocks a "production release" until update authenticity has evidence, and 001 B-RELEASE says "Public release blocked". Options: (a) record in this feature that a pre-release without an updater is not a production release, and amend 001 plan.md B-RELEASE and research.md R7 to name v1.0; (b) a PATCH amendment of the constitution that defines "production release". Recommendation: (a) now, and (b) only if a later review finds the reading unclear.
- **Q3. Sign the uninstaller and the NSIS plugin DLL.** With SignPath, the R1 two-stage design leaves both unsigned. Options: accept that and record it, or ask SignPath for a flow that signs them (more approvals per release). Recommendation: ask SignPath at onboarding; until then, accept and record the limit.
- **Q4. Tag protection.** The user decided "No tag ruleset" on 2026-10-24. Options: keep that and rely on immutable releases and the environment tag rule, or add a `v*` tag ruleset (block deletion and update). Recommendation: keep the decision; switch on immutable releases.
- **Q5. Tauri CLI for the first release.** Options: ship with tauri-cli 2.12.0 and NSIS 3.11 (current pins, the version that all 001 evidence used), or do the 2.12.4 and NSIS 3.13 update first. Recommendation: 2.12.0 for v0.1.0, because the qualification evidence exists for it; do the update after the preview.
- **Q6. Installed apps name.** Options: "Arbareto" for release builds, or "Arbareto Preview". Recommendation: "Arbareto", with the version `0.1.0`; the local `bun run package` build keeps "(Unsigned local test package)".
- **Q7. Code of conduct.** Not required by SignPath. Recommendation: skip it for v0.1.0; add the Contributor Covenant only if the user wants it.
- **Q8. Release notes source.** Options: a file per version in the repository (for example `docs/releases/v0.1.0.md`), or a `CHANGELOG.md` with one section per version. Recommendation: `CHANGELOG.md`, one section per release, user-visible changes only (global changelog rule).
- **Q9. Order of steps.** SignPath approves only released projects. Recommendation: public switch → v0.1.0 unsigned → SignPath application with the release URL → signing switch on for v0.1.1 or v0.2.0.

## Sources

- SignPath Foundation home: https://signpath.org/
- SignPath Foundation conditions: https://signpath.org/terms
- SignPath application form: https://signpath.org/apply
- SignPath GitHub trusted build system: https://docs.signpath.io/trusted-build-systems/github
- SignPath artifact configuration reference: https://docs.signpath.io/artifact-configuration/reference
- SignPath action: https://github.com/SignPath/github-action-submit-signing-request
- Applicant report (Zenn, 2026): https://zenn.dev/shm_7ec/articles/signpath-oss-code-signing?locale=en
- PRISM signing guide: https://prism-studio.readthedocs.io/en/v1.12.0/GITHUB_SIGNING.html
- Tabularis SignPath announcement: https://tabularis.dev/blog/signpath-code-signing
- tauri-action README: https://raw.githubusercontent.com/tauri-apps/tauri-action/dev/README.md
- Tauri Windows code signing: https://v2.tauri.app/distribute/sign/windows/
- Tauri config reference: https://v2.tauri.app/reference/config/
- tauri-cli versions: https://crates.io/api/v1/crates/tauri-cli
- tauri-bundler 2.10.0 and 2.10.4 crates: https://static.crates.io/crates/tauri-bundler/tauri-bundler-2.10.0.crate, https://static.crates.io/crates/tauri-bundler/tauri-bundler-2.10.4.crate
- tauri-cli 2.12.4 crate: https://static.crates.io/crates/tauri-cli/tauri-cli-2.12.4.crate
- tauri-utils 2.10.2 crate: https://static.crates.io/crates/tauri-utils/tauri-utils-2.10.2.crate
- Bun 1.4.4 checksums: https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/SHASUMS256.txt
- Bun executables docs at 1.4.4: https://raw.githubusercontent.com/oven-sh/bun/bun-v1.4.4/docs/bundler/executables.mdx
- Runner images: https://raw.githubusercontent.com/actions/runner-images/main/README.md
- Windows Server 2025 VS2026 image: https://raw.githubusercontent.com/actions/runner-images/main/images/windows/Windows2025-VS2026-Readme.md
- Attest build provenance: https://raw.githubusercontent.com/actions/attest-build-provenance/main/README.md
- Artifact attestations concept: https://docs.github.com/en/actions/concepts/security/artifact-attestations
- Artifact attestations how-to: https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations
- Secure use reference: https://docs.github.com/en/actions/reference/security/secure-use
- Workflow dependency lockfiles: https://docs.github.com/en/actions/concepts/security/workflow-dependency-lockfiles
- Deployments and environments: https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
- Immutable releases: https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases
- About rulesets: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
- GitHub Actions billing: https://docs.github.com/en/billing/concepts/product-billing/github-actions
- SmartScreen reputation: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- SmartScreen overview: https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/
- Smart App Control overview: https://learn.microsoft.com/windows/apps/develop/smart-app-control/overview
- Application and driver control: https://learn.microsoft.com/windows/security/book/application-security-application-and-driver-control

## R7. Results

Fact results F1 to F6 (plan.md "Facts to verify"), the action commit IDs (plan.md D2), the dry-run record, the Sandbox install, and the release checks go here. Each entry names the date, the build commit, the runner image or the host, the tool versions that ran, and the result.
