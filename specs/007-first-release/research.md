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
14. 001 B-RELEASE and research R7 ("private until version 1") conflict with the 2026-10-24 decisions. Resolved: T027 amends them (Q2).
15. Constitution delivery gate: "Production release MUST remain blocked until update authenticity and tampered-update rejection have verified evidence." Resolved: constitution 4.0.1 defines a production release, and a GitHub pre-release that users download by hand is not one (Q2).
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

Answered on 2026-10-24 (spec Clarifications): Q2: first option (a); then, after the analyze finding C1, option (b): a PATCH amendment to constitution 4.0.1 adds the definition at the delivery gate, and T027 also amends the three 001 spec.md lines. Immutable releases: yes, switched on by the orchestrator at the public switch. Q1, Q3, Q5, Q6, Q7, Q8, and Q9 take the recommended defaults. Q4 keeps the "no tag ruleset" decision.

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

### T001 Fact F1, two clone paths (2026-10-26, reference host, build commit 80292e5a)

- Tools: Bun 1.4.4, `rustc 1.99.0 (b940084d7 2026-09-28)`, `tauri-cli 2.12.0`, makensis `v3.11`.
- Clone c1 ran `bun run build`, `cargo tauri build --target x86_64-pc-windows-msvc --no-bundle -- --locked`, and `cargo tauri bundle --target x86_64-pc-windows-msvc --bundles nsis`. All exited 0.
- Clone c2 ran `bun run package`. It exited 0.
- `arbareto-git.exe` is the same in both clones: SHA-256 `7e613c557eb7c33d17bbc289d8e2dd3e7c0c4f8b5e0862e2e6a9466378c794ab`.
- `dist/` is the same in both clones: hash of the sorted per-file SHA-256 list `f10e8a68b361a661ad8043bca70b81974dc06bd96d8fe83b0c37312a7bcc66c1`.
- `arbareto.exe` differs: c1 `4dc565f5cb26a82a67b801ed4e74724ae59ce35046ea448e6975ad74f68d1963`, c2 `d44f26c66dd06247462b30559f42c07a5ac18bf801a64efe24a2f068aa99a657`. Each file holds its own clone path 10 times and the other clone's path 0 times. The two clone paths have different names, so this run cannot tell a build-stage difference from the path difference. The same-path run below separates them.
- Installer: c1 `5cde8d4a582dca7202fb9288a1c66632b9c72e00fcdb7c8e1f37a894cff3356d` (45922006 bytes), c2 `7e0557207e86a9133587cd9001cc544bfb93557baf7de25f7aa23920134190bd` (45914249 bytes).
- No Sandbox install ran for this pair.
- `OBSERVATION T001: differs arbareto.exe (embedded clone path c1 against c2), Arbareto_0.1.0_x64-setup.exe; same arbareto-git.exe, dist/ (tauri-cli 2.12.0); Sandbox step not run`

### T001 Fact F1, one clone path (2026-10-26, reference host, build commit 80292e5a)

- Tools: `rustc 1.99.0 (b940084d7 2026-09-28)`, `cargo 1.99.0 (5f94df478 2026-08-27)`, `tauri-cli 2.12.0`, Bun 1.4.4, makensis `v3.11`.
- One clone path in local scratch. Run A: fresh clone, then the three-step build. Run B: delete the clone, fresh clone at the same path, then `bun run package`. Both exited 0.
- Built `arbareto.exe`: A `af10412adc0d209cf81753a18ec09a229dd104406e942bd98ea9b93fcf0b50e7`, B `a3df03cd45afffc6f0134a677509355d13dc79e6e18431aec7e8054aa942c9ea`. Both 16219648 bytes.
- The two files differ in 24 bytes in 5 ranges: offset 0xf0 (COFF `TimeDateStamp`), 0xc6b244, 0xc6b260, 0xc6b27c (debug directory `TimeDateStamp` values), and 16 bytes at 0xc6b87c (CodeView RSDS PDB GUID). The cause is the link time and PDB GUID of each link, not the build stage.
- Installer: A `9af79113e479cb258cfc2b28b5afd41a3df9022bd026a04f887e23020e62e071`, B `dd762c6cbb1e843ca5b607672877ba35b75f7a17145cb6c44cb0707c9c94f8ee`. The installers hold the differing `arbareto.exe`. Other installer differences are not checked.
- Windows Sandbox install, `/S`, exit 0 for each. Installed folder `%LOCALAPPDATA%\Arbareto`, three files each:
  - `arbareto-git.exe` same: `7e613c557eb7c33d17bbc289d8e2dd3e7c0c4f8b5e0862e2e6a9466378c794ab`.
  - `uninstall.exe` same: `ac10d423d81e938547a63d2cd1a71e0a5886f31933ef8b6d245968416ea94fbb`.
  - `arbareto.exe` differs: A `1d4fcac3f9aa25227909be3419a49354c3fc596e0aa651b5750c4a283f761c51`, B `b943b4cbd0aac3237c9a273e5ec36465ed1b5a847be080525209a39f7d081c2e`.
- `OBSERVATION T001: differs arbareto.exe (link TimeDateStamp and PDB GUID only, same clone path), Arbareto_0.1.0_x64-setup.exe; same arbareto-git.exe, uninstall.exe, dist/ (tauri-cli 2.12.0)`

### T001 Bundler patch of the main executable (2026-10-26, reference host)

- tauri-bundler 2.10.0 `src/bundle.rs:40-98` (`patch_binary`) replaces the 27-byte marker `__TAURI_BUNDLE_TYPE_VAR_UNK` with `__TAURI_BUNDLE_TYPE_VAR_NSS` in the target `arbareto.exe` before NSIS packs it. `src/bundle.rs:141-145` keeps an unpatched copy, and `src/bundle.rs:213-218` writes it back after each bundle type. So the target file after the bundle step is the unpatched file.
- Check: the built run A and run B files with only that marker replaced give SHA-256 `1d4fcac3...1c51` and `b943b4cb...1c2e`. These are the installed hashes above. The marker is at offset 0xc0d5a2 once in each file. So the installed `arbareto.exe` differs from the built file only in the 3 marker bytes.
- `cargo tauri bundle --help` (tauri-cli 2.12.0) lists `--no-binary-patching`. The help says that the patch rewrites the binary in place and invalidates an existing code signature. The skip costs only per-bundle-type updater support.

### T005 /Brepro experiment (2026-10-26, reference host, build commit 80292e5a)

- Same tools as the one-clone-path run. One clone path in local scratch. Each fresh clone got an untracked `.cargo/config.toml` with `[target.x86_64-pc-windows-msvc] rustflags = ["-C", "link-arg=/Brepro"]`. Run A: the three-step build. Run B: fresh clone, then `bun run package`. Both exited 0.
- Built `arbareto.exe`: A and B both `e02955e4ea560c60bb9884775e927b67c48ff6c5c09b2029417edef35c0085e5`, 16219648 bytes. `cmp` reports 0 differing bytes.
- The COFF `TimeDateStamp` is `0xbc3455e6` (a hash value, not the link time). Without the flag it was `0x6adf1ba0`, the link time.
- With the NSIS marker replaced, both give `ff6e538d2c215095394191bd63611171bcc487211042646b077fcbf6322e14f2`.
- Installers still differ: A `d60d33b70e05c7701b8fb268686428ef9ac768a965fcc5fcbfe9a6f97f983926`, B `c1526ababab0eb8b381a4d3f960419391888af5c97cf34c2cdf965b0a8e692e9`. The cause is not checked. No Sandbox install ran for this pair.
- In the repository, `.cargo/config.toml` sets the flag. A `cargo build --locked --manifest-path src-tauri/Cargo.toml` from the repository root exited 0 without linker warnings, and its debug `arbareto.exe` has the hash `TimeDateStamp` `0xf8fd5fb1`.
- `OBSERVATION T005: same arbareto.exe with /Brepro (e02955e4ea560c60bb9884775e927b67c48ff6c5c09b2029417edef35c0085e5), three-step build against bun run package (tauri-cli 2.12.0); installers differ, cause not checked`

### T002 Fact F2, Bun file-property flags (2026-10-26, reference host, Bun 1.4.4)

- Each flag compiled a one-line stub with `bun build stub.ts --compile --target=bun-windows-x64 <flag>`. Each compile exited 0. A compile with all five flags together also exited 0 and set all fields.
- `OBSERVATION T002: --windows-title -> ProductName`
- `OBSERVATION T002: --windows-publisher -> CompanyName`
- `OBSERVATION T002: --windows-version=0.1.0 -> FileVersion and ProductVersion 0.1.0.0`
- `OBSERVATION T002: --windows-description -> FileDescription`
- `OBSERVATION T002: --windows-copyright -> LegalCopyright`
- Without a flag, the defaults are ProductName `Bun`, CompanyName `Oven`, version `1.4.4`, FileDescription `Bun`, and LegalCopyright `https://bun.com/docs/project/licensing`.

### T003 Fact F3, installer hooks overlay (2026-10-26, reference host, build commit 80292e5a)

- The overlay sets only `bundle.windows.nsis.installerHooks` to the absolute path of a hook file. The hook file defines only an empty `NSIS_HOOK_PREINSTALL`. Both files are in local scratch, outside the repository.
- Build in the run B clone: `cargo tauri build --target x86_64-pc-windows-msvc --bundles nsis --config <overlay> -- --locked`. Exit 0. Installer `9ec4067206cfb95533b3d091292c4a57be4ddf811273741f5284f2c0bcf4e2c1`.
- Windows Sandbox install, `/S`, exit 0. Key `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Arbareto`.
- Without the overlay (runs A and B), the same key holds `DisplayName=Arbareto (Unsigned local test package)`.
- `OBSERVATION T003: DisplayName=Arbareto DisplayVersion=0.1.0`

### T004 Facts F4 and F5, Hunspell fetch and tar (2026-10-26, reference host, git 2.56.0.windows.2)

- `OBSERVATION T004: https://github.com/hunspell/hunspell fetch 0 edb619100791110d3e34f09ec35392ad327c1135`
- `OBSERVATION T004: https://github.com/rotemdan/hunspell-wasm fetch 0 8f755ef64e8b047b77b676f9698b3dfa5cb1887d`
- `OBSERVATION T004: tar bsdtar 3.8.9 - libarchive 3.8.9 zlib/1.2.13.1-motley liblzma/5.8.3 bz2lib/1.0.8 libzstd/1.5.7 cng/2.0 libb2/bundled`

### T005 Fact gate (2026-10-26)

- F1 differs without `/Brepro` and is the same with it. plan.md D1 and D11 change: `.cargo/config.toml` sets `/Brepro`, the two build paths must give the same `arbareto.exe` bytes, and `package:preview:bundle` passes `--no-binary-patching` (plan.md D8).
- F2, F3, F4, and F5 hold as expected. D6 and D8 keep their flag names and sources.

### T008 Rust toolchain (2026-10-26, reference host, base commit 48e9e87c)

- `rustc --version` in the repository root: `rustc 1.99.0 (b940084d7 2026-09-28)`.
- `cargo --version`: `cargo 1.99.0 (5f94df478 2026-08-27)`.
- `rust-toolchain.toml` pins `channel = "1.99.0"`. The local toolchain equals the pin.

### T025 Action commit IDs (2026-10-26)

Each commit ID comes from the release tag of the action repository: `git ls-remote https://github.com/<repo> refs/tags/<tag>` and `gh api repos/<repo>/git/ref/tags/<tag>` (object type `commit`, a lightweight tag). The date is the commit date from `gh api repos/<repo>/commits/<tag>`. Each version was at least two weeks old on 2026-10-26.

| Action | Tag | Commit ID | Commit date |
| --- | --- | --- | --- |
| `actions/checkout` | `v7.0.1` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | 2026-07-17 |
| `actions/upload-artifact` | `v7.0.2` | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | 2026-10-07 |
| `actions/download-artifact` | `v8.0.2` | `9000827ccba6bdab643e8b6fd33ac0654aef8333` | 2026-10-07 |
| `actions/attest` | `v4.2.2` | `1e69f48acb82d1966a394da916b4c1698aa569d6` | 2026-08-04 |
| `signpath/github-action-submit-signing-request` | `v3.0` | `f6d04783b4569d051e0c80105fe66e82819d0092` | 2026-09-10 |

- `signpath/github-action-submit-signing-request` has GitHub releases only for `v1` and `v2`. The tag `v3.0` has no release entry. Its `action.yml` has the same inputs as `v2.3` and a new default `connector-url`.

### T010 and T017 verification run (2026-10-27, reference host, build commit f87219d1)

- Tools: Bun 1.4.4, `rustc 1.99.0 (b940084d7 2026-09-28)`, `cargo 1.99.0 (5f94df478 2026-08-27)`, `tauri-cli 2.12.0`, makensis `v3.11`. The tree was clean before and after the run.
- Exit 0: `bun install --frozen-lockfile`, `bun run build`, `bun run typecheck`, `bun run export:schemas --check`, `cargo check --locked --manifest-path src-tauri/Cargo.toml`, and `cargo test --locked --manifest-path src-tauri/Cargo.toml`.
- `bun run test:contracts`: exit 0, 5,989 pass, 37 skip, 0 fail, 127 files.
- `bun run test:all`: exit 0, 267 of 267 files reported. Parallel step 7,927 pass, 45 skip, 0 fail (227 files). Serial step 791 pass, 10 skip, 0 fail (40 files).
- `cargo check --locked --manifest-path src-tauri/Cargo.toml --target x86_64-unknown-linux-gnu` on Windows: exit 101. The `libdbus-sys` 0.2.7 build script panics because `pkg-config` finds no `dbus-1` for the Linux target. The user moved the Linux check to WSL (2026-10-27).
- Control mutations, each undone byte for byte and rerun green:
  - `check.ts`: `merge-base` exit 1 passes. `tests/git/release-check.test.ts` exit 1.
  - `pins.ts`: one digit of the Bun hash changed. `tests/contracts/release-pins.test.ts` exit 1.
  - `build_channel.rs`: a dirty `preview` identity passes. `cargo test ... build_channel` exit 101.
  - `AboutDialog.tsx`: the release buttons show for `local`. `tests/contracts/about-dialog.test.tsx` exit 1.
  - One untracked file, then `bun run package:preview:exes`: exit 1, `a preview build needs a clean tree: f87219d1c71d34670d847a462d89851df2566b36-dirty`.
- On the clean tree, `bun run package:preview:exes` and `bun run package:preview:bundle` exit 0. Installer `Arbareto_0.1.0_x64-setup.exe`, 46493635 bytes, SHA-256 `31ae0b9b2989646a8c4727f458bedf7fc08c2811f7abc4d32bf6753542b32811`. Built `arbareto.exe` `9c7c2d3578e094d49cf7bef65493deaa80f3dbfa3593b59040a1b2849085363e`, `arbareto-git.exe` `5438d50d61474ea6db702b1a5b77655502ae189f01c705d85138d9ee83a4bf95`.
- Windows Sandbox install, `/S`, exit 0. Key `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Arbareto`: `DisplayName=Arbareto`, `DisplayVersion=0.1.0`, `Publisher=github`. No HKLM entry. Installed folder `%LOCALAPPDATA%\Arbareto`:
  - `arbareto.exe` `9c7c2d35…5363e` (equals the built file, `--no-binary-patching`), ProductName `Arbareto`, CompanyName `github`, version `0.1.0`.
  - `arbareto-git.exe` `5438d50d…83a4bf95` (equals the built file), ProductName `Arbareto`, CompanyName `Ihor Lifanov`, version `0.1.0.0`, FileDescription `Arbareto Git service`.
  - `uninstall.exe` `ac10d423d81e938547a63d2cd1a71e0a5886f31933ef8b6d245968416ea94fbb`.
- Uninstall exit 0. After it, the key, `arbareto.exe`, and the folder are absent.
- In this run the window opened, but the Help menu was not found. So About was not read.
- `OBSERVATION T017: DisplayName=Arbareto DisplayVersion=0.1.0 Publisher=github; installed arbareto.exe and arbareto-git.exe equal the built files; uninstall removes the app`

### T017 About in Windows Sandbox (2026-10-27, reference host, installer 31ae0b9b…42b32811)

- The Sandbox WebView2 runtime is registered (`pv=155.0.4283.45`), but its runtime folder is absent. So the app cannot show its page there.
- The Sandbox script maps the host WebView2 runtime folder read-only (`155.0.4283.62`) and uses it. A registry value `AdditionalBrowserArguments` under HKLM sets `--remote-debugging-port` for `arbareto.exe`, and the script reads the page through that port.
- The boot view read `Preview` and `Build 0.1.0 f87219d1c71d34670d847a462d89851df2566b36`, without `-dirty`.
- After Select Git, About read `Build: 0.1.0 f87219d1c71d34670d847a462d89851df2566b36` and `Preview`, and no `Unsigned local test package` line.
- The start page still read the local line "This test build covers …". Review finding 8 below changes it.
- The uninstall key and `arbareto.exe` named the publisher `github`, and `arbareto.exe` had an empty LegalCopyright. Tauri takes the publisher from the second segment of the bundle identifier when `bundle.publisher` is absent. Fix eb4215bf sets `bundle.publisher` to `Ihor Lifanov` and `bundle.copyright` to `Copyright (c) 2026 Ihor Lifanov`, with a pins test. The Sandbox install of the fixed build is not run yet.
- `OBSERVATION T017: About Build: 0.1.0 f87219d1c71d34670d847a462d89851df2566b36, Preview; Publisher=github before eb4215bf`

### T010 Linux check in WSL (2026-10-27, reference host, WSL Ubuntu-26.04 26.04.1 LTS, build commit f87219d1)

- Steps of README "Development", "Linux check (WSL)": the apt packages, rustup with `--default-toolchain none`, a clone of `007-first-release` in `~` inside the distro, then `cargo check --locked --manifest-path src-tauri/Cargo.toml`. The first `cargo` call installed 1.99.0 from `rust-toolchain.toml`.
- Exit 0, about 1.5 minutes.
- `OBSERVATION T010: WSL Ubuntu-26.04 cargo check --locked exit 0`

### Review of batches 0 and 1 (2026-10-27, independent reviewer, commit f87219d1)

Findings and fixes on branch `f007-review-fixes`. T010 and T017 need a rerun on the fixed commit.

1. Required: `check.ts --mode release` did not compare `HEAD` with the tag commit (spec FR-014). Fix: `git rev-parse --verify` of `HEAD^{commit}` and `refs/tags/<tag>^{commit}`; a difference gives `RELEASE_CHECK not-tag-commit` (contracts §2). Real-Git case: tag on `main`, `HEAD` one commit ahead.
2. The workflow test did not check the `RUSTFLAGS` rule of contracts §1. Fix: a test reads the `env` maps at workflow, job, and step level and refuses `RUSTFLAGS` and `CARGO_ENCODED_RUSTFLAGS`.
3. About sent a second request while one ran. Fix: one busy state; both release buttons are disabled while a request runs.
4. The About test pressed Space with a click after keydown. Fix: the test clicks after keyup when neither key event is cancelled.
5. Missing cases: a `version` key in `tauri.preview.conf.json` (`config-version`) and `--mode release` without `--tag` (`usage`). Fix: both cases.
6. `hunspell-source.ts` printed `null` for a process with no exit code, and `notes.ts` read a block file without a check. Fix: the code is the exit code or the signal name; an absent block gives `RELEASE_NOTES block <file>` (contracts §2).
7. With `ARBARETO_SIGNING=signpath`, an absent `SIGNPATH_API_TOKEN` was not refused before the build. Fix: the build job env sets `SIGNPATH_TOKEN_SET: ${{ secrets.SIGNPATH_API_TOKEN != '' }}`; `check.ts --signing signpath` refuses with `signing-missing SIGNPATH_API_TOKEN` when it is not `true` (plan.md D11).
8. The preview start page showed the local scope line. Plan D7 had no preview text. Fix: plan.md D7 adds "This preview is not a qualified release. The qualification of Windows 11 x64 continues." for About, the Help menu, and the start page.

### T010 and T017 verification rerun (2026-10-27, reference host, build commit 8185cef5)

- The build commit holds the review fixes (93e6e894, merged in f6123fb0) and the publisher fix eb4215bf. Run data is in local scratch.
- Tools: Bun 1.4.4, `rustc 1.99.0 (b940084d7 2026-09-28)`, `cargo 1.99.0 (5f94df478 2026-08-27)`, `tauri-cli 2.12.0`, makensis `v3.11`. `git status --porcelain` printed nothing before and after the run.
- The first driver attempt stopped on a regex error in the driver script before any test step. The second attempt ran all steps.
- Exit 0: `bun install --frozen-lockfile`, `bun run build`, `bun run typecheck`, `bun run export:schemas --check`, `cargo check --locked --manifest-path src-tauri/Cargo.toml`, and `cargo test --locked --manifest-path src-tauri/Cargo.toml` (617 pass, 0 fail, 9 ignored).
- `bun run test:contracts`: exit 0, 6,006 pass, 37 skip, 0 fail, 128 files.
- `bun run test:all`: exit 0, 268 of 268 files reported, 8,796 tests. Parallel step 7,950 pass, 45 skip, 0 fail (228 files). Serial step 791 pass, 10 skip, 0 fail (40 files). All 2,487 `ORIGIN` lines of `test:contracts` and `test:all` name the checkout under test.
- Free memory before `test:all` 11.26 GB, paged pool 6465 MB, nonpaged pool 1810 MB. After it: 9.37 GB, 8274 MB, 2237 MB.
- Linux check in WSL `Ubuntu-26.04`: the clone inside the distro fetched the branch from a Git bundle and checked out 8185cef5 detached. `git rev-parse HEAD` printed 8185cef5, and `git status --porcelain` printed nothing. `cargo check --locked --manifest-path src-tauri/Cargo.toml` exit 0.
- Control mutations, each undone byte for byte and rerun green:
  - `check.ts`: `merge-base` exit 1 passes. `tests/git/release-check.test.ts` exit 1, 1 of 20 fail. Rerun: 20 of 20 pass.
  - `pins.ts`: one digit of the Bun hash changed. `tests/contracts/release-pins.test.ts` exit 1, 2 of 13 fail. Rerun: 13 of 13 pass.
  - `build_channel.rs`: a dirty `preview` identity passes. `cargo test ... build_channel` exit 101, 1 of 4 fail. Rerun: 4 of 4 pass.
  - `AboutDialog.tsx`: the release buttons show for `local`. `tests/contracts/about-dialog.test.tsx` exit 1, 1 of 8 fail. Rerun: 8 of 8 pass.
  - One untracked file, then `bun run package:preview:exes`: exit 1, `a preview build needs a clean tree: 8185cef5920334836f8cad77a6d649f0ce7cf1c6-dirty`.
- On the clean tree, `bun run package:preview:exes` and `bun run package:preview:bundle` exit 0. Installer `Arbareto_0.1.0_x64-setup.exe`, 46483719 bytes, SHA-256 `7bfd68a99fd82c88b09020dfe7ae627b93416a82dcad65feeef46773d5045749`. Built `arbareto.exe` `e14d09a716876b589acbbe540ba0b3fcd147b5d7937482dcee7ad1e853f8d807`, `arbareto-git.exe` `5438d50d61474ea6db702b1a5b77655502ae189f01c705d85138d9ee83a4bf95`.
- Windows Sandbox install (quickstart.md Q4), `/S`, exit 0. Key `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Arbareto`: `DisplayName=Arbareto`, `DisplayVersion=0.1.0`, `Publisher=Ihor Lifanov`.
  - `arbareto.exe`: CompanyName `Ihor Lifanov`, LegalCopyright `Copyright (c) 2026 Ihor Lifanov`, ProductVersion `0.1.0`.
  - `arbareto-git.exe`: CompanyName `Ihor Lifanov`, LegalCopyright `Copyright (c) 2026 Ihor Lifanov`, ProductVersion `0.1.0.0`.
- The app used the mapped host WebView2 runtime, as in the f87219d1 About run. The boot view read `Preview` and `Build 0.1.0 8185cef5920334836f8cad77a6d649f0ce7cf1c6`, without `-dirty`.
- After Select Git, the start page read "This preview is not a qualified release. The qualification of Windows 11 x64 continues." About read `Build: 0.1.0 8185cef5920334836f8cad77a6d649f0ce7cf1c6` and `Preview`, and no `Unsigned local test package` line.
- Uninstall exit 0. This run did not check the key or the installed folder after the uninstall, and it did not read the installed `uninstall.exe` hash. The f87219d1 run showed the removal, but its installer came before eb4215bf. No fact shows that the two uninstallers are equal. So the T017 condition "uninstall removes the app" has no evidence at 8185cef5, and T017 stays open for this one item.
- Reviews: "Review of batches 0 and 1" above is the one independent review of batch 0 (T010) and of batch 1 (T017). Its eight fixes are in 93e6e894. This rerun verifies them.
- `OBSERVATION T010: 8185cef5 every step exit 0; test:all 268 of 268 files, 8796 tests, 0 fail; WSL Ubuntu-26.04 cargo check --locked exit 0`
- `OBSERVATION T017: DisplayName=Arbareto DisplayVersion=0.1.0 Publisher=Ihor Lifanov; CompanyName=Ihor Lifanov in both executables; About Build: 0.1.0 8185cef5920334836f8cad77a6d649f0ce7cf1c6, Preview; uninstall exit 0, removal not checked`
