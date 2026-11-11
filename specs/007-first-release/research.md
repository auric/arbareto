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
- Immutable releases lock the tag and the assets after publication, and they create a release attestation. GitHub recommends: create a draft, attach all assets, then publish (https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases). A deleted immutable release blocks reuse of its tag name. This setting meets FR-028. It is a repository setting. The orchestrator switches it on at the public switch (spec FR-028).
- Environments: required reviewers can approve jobs that reference the environment (up to six). On GitHub Free, required reviewers and environment secrets are available only for public repositories. Environment secrets reach a job only after the approval. "Prevent self-reviews" exists, but a single maintainer cannot use it. Deployment branch and tag rules restrict which `GITHUB_REF` values can deploy (https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).
- Proposed job split (for the plan):
  - `build` job: `permissions: contents: read, actions: read`. With signing off, no step reads a secret value. The job env `SIGNPATH_TOKEN_SET` holds only the result of `secrets.SIGNPATH_API_TOKEN != ''`. With signing on, only the steps "Sign the executables" and "Sign the installer" read `SIGNPATH_API_TOKEN`, through their `api-token` input. The job uploads the release files as the workflow artifact `release-files`. With signing on, these files hold the signed installer.
  - Signing: the workflow has no `sign` job. plan.md D11 puts both SignPath stages into the `build` job, behind `if: vars.ARBARETO_SIGNING == 'signpath'`. The SignPath token is a repository secret, so `build` uses no environment. Only `publish` uses the environment `release`.
  - `publish` job: environment `release` with the user as required reviewer and the tag rule `v*`. `contents: write`, `id-token: write`, `attestations: write`. The `build` step "Make the release files" writes `SHA256SUMS.txt` with `sums.ts write`. The `publish` step "Verify the release files" checks it with `sums.ts verify`. Then `publish` attests every file and creates the draft with `gh release create --draft --prerelease`, uploads, and publishes.
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

### T017 Uninstall in Windows Sandbox (2026-10-28, reference host, installer 7bfd68a9…d5045749, build commit 8185cef5)

- The installer is the file of the 8185cef5 rerun. Its SHA-256 on the host and in the Sandbox is `7bfd68a99fd82c88b09020dfe7ae627b93416a82dcad65feeef46773d5045749`. The commits after 8185cef5 change only `specs/`.
- Install `/S`, exit 0. Key `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Arbareto`: `DisplayName=Arbareto`, `DisplayVersion=0.1.0`, `Publisher=Ihor Lifanov`. No HKLM entry.
- Installed folder `%LOCALAPPDATA%\Arbareto`, three files:
  - `arbareto.exe` 17217024 bytes, `e14d09a716876b589acbbe540ba0b3fcd147b5d7937482dcee7ad1e853f8d807` (equals the built file).
  - `arbareto-git.exe` 116802048 bytes, `5438d50d61474ea6db702b1a5b77655502ae189f01c705d85138d9ee83a4bf95` (equals the built file).
  - `uninstall.exe` 79264 bytes, `5b03c9ae81700718248168ff47415188f787a08d2c5cd3c5781750678061a24e`. This differs from the f87219d1 uninstaller `ac10d423…6ea94fbb`.
- The Start menu shortcut `Arbareto.lnk` exists after the install.
- `uninstall.exe /S`, exit 0. No temporary NSIS uninstaller process (`Un_*`, `Au_*`) was left.
- After the uninstall: the HKCU key is absent, the installed folder is absent, and the Start menu shortcut is absent.
- With this record, every T017 pass condition has evidence at 8185cef5.
- `OBSERVATION T017: 8185cef5 uninstall.exe 5b03c9ae81700718248168ff47415188f787a08d2c5cd3c5781750678061a24e; uninstall exit 0; HKCU key, install folder, and Start menu shortcut absent after the uninstall`

### T021 Hunspell source archive with the default upstream (2026-10-28, reference host, branch commit d55d42aa)

- Tools: Bun 1.4.4, `git version 2.56.0.windows.2`, `C:\Windows\System32\tar.exe` (bsdtar 3.8.9, T004).
- `bun scripts/release/hunspell-source.ts --out <scratch>` with the default upstream `https://github.com`. Exit 0.
- Archive `arbareto-0.1.0-hunspell-source.tar.gz`, 2224921 bytes, SHA-256 `c990870ad75c1bf30b684ea0f2d541f49f62352674d83d5fdac67cfbdb311d9a`.
- `tar.exe -tzf` lists 792 entries: 733 below `hunspell/`, 58 below `hunspell-wasm/`, and `SOURCE.txt`.
- `SOURCE.txt` names commit `edb619100791110d3e34f09ec35392ad327c1135` for `hunspell/` and `8f755ef64e8b047b77b676f9698b3dfa5cb1887d` for `hunspell-wasm/`. These equal `pins.ts`.
- `OBSERVATION T021: default upstream exit 0; arbareto-0.1.0-hunspell-source.tar.gz 2224921 bytes c990870ad75c1bf30b684ea0f2d541f49f62352674d83d5fdac67cfbdb311d9a`

### T026 Local rehearsal of the build job, first run (2026-10-28, reference host, clone of `f007-b2` at d55d42aa)

- Tools: Bun 1.4.4, `rustc 1.99.0 (b940084d7 2026-09-28)`, `cargo 1.99.0 (5f94df478 2026-08-27)`, `tauri-cli 2.12.0`, makensis `v3.11`, `git version 2.56.0.windows.2`, bsdtar 3.8.9.
- A fresh `git clone --no-local` in local scratch. `git status --porcelain --untracked-files=all` printed nothing before the run, after the run, and after the control mutations.
- Exit 0: `check.ts --mode dry-run --signing off` before and after the build, `bun install --frozen-lockfile`, `bun run build`, `bun run package:preview:exes`, `bun run package:preview:bundle`, `hunspell-source.ts`, `sums.ts write`, `sums.ts verify`, and `notes.ts --version 0.1.0 --signing off`.
- Exit 1: `notices-text.ts --out <scratch>` printed `RELEASE_NOTICES input <clone>\src\frontend\generated\notices.json`. The file exists. Its schema in `notices-text.ts` is strict and has no `note` key, but the Hunspell package entry of `notices.json` has a `note`. So the run made three release files, not four.
- Files: `Arbareto_0.1.0_x64-setup.exe` 46488481 bytes `f194bec81c626d71ccd4419aaaf31a257e461797e65dd9817f0448fcc76e2e40`; `arbareto-0.1.0-hunspell-source.tar.gz` 2224912 bytes `8be9447567df47c01acc948a938a7b9a9f7aba9f01d0544de6202754b04148b2`; `SHA256SUMS.txt`.
- The source archive differs from the T021 archive (2224921 bytes, `c990870a…b311d9a`). The pins are the same. `git archive`, `tar.exe -xf`, and `tar.exe -czf` run again, so the archive bytes are not reproducible. No rule asks for reproducible archive bytes.
- Fix: the schema accepts an optional `note`, and the text prints it as `  Note: <text>` below the package. A new case runs the CLI with a fixture that has a note. Control mutation: without `note` in the schema, that case fails (1 of 14). Undone and rerun green.
- The fixed script with `--input` set to the clone's `notices.json`: exit 0, `arbareto-0.1.0-third-party-notices.txt` 650568 bytes `00971cc0a0227009c3134f93603a2542f4101b15cfcc798624412ff035d115ac`, one `Note:` line.
- Quickstart Q3 control mutations, each undone: `package.json` version `0.1.1` gives `RELEASE_CHECK version-mismatch 0.1.0 0.1.1`, exit 1; one untracked file gives `RELEASE_CHECK dirty`, exit 1, and `package:preview:exes` exits 1 with the `build.rs` panic `a preview build needs a clean tree: d55d42aa…-dirty`; one changed installer byte gives `sums.ts verify` exit 1 with `RELEASE_SUMS mismatch`, and the restored byte gives exit 0; `actions/checkout@v4` in `release.yml` fails `tests/contracts/release-workflow.test.ts` (1 of 12), and the restored file passes.
- T026 is not met. It needs a rerun on a clean clone of the commit that holds the fix.
- `OBSERVATION T026: d55d42aa notices-text.ts exit 1 (strict schema without note); other steps exit 0; three files; sums verify exit 0; porcelain empty; Q3 mutations fail as stated`

### T026 Local rehearsal of the build job, second run (2026-10-31, reference host, clone of `007-first-release` at a58a7da0)

- Tools: Bun 1.4.4, `rustc 1.99.0`, `cargo 1.99.0`, `tauri-cli 2.12.0`, makensis `v3.11`.
- A fresh `git clone --no-local` in local scratch. `git rev-parse HEAD` in the clone printed a58a7da0b57e5c354cb0bb1b59e3c40b9f94252c.
- Exit 0, in order: `bun install --frozen-lockfile`, `check.ts` before the build, `bun run build`, `bun run package:preview:exes`, `bun run package:preview:bundle`, `notices-text.ts`, `hunspell-source.ts`, `sums.ts write`, `sums.ts verify`, and `notes.ts`.
- The verified folder holds exactly four files:
  - `Arbareto_0.1.0_x64-setup.exe` 46493363 bytes `a45032c89c0d44bb6ddd9c59c06966038901728b4099b7ea627029d68829aeb6`.
  - `arbareto-0.1.0-hunspell-source.tar.gz` 2224921 bytes `d836bf3dbb2f12fc676ad124a87ba3224415aeb091bc66a0f7d1e4e3e8c21f0b`. The archive bytes are not reproducible (see the first run).
  - `arbareto-0.1.0-third-party-notices.txt` 650568 bytes `00971cc0a0227009c3134f93603a2542f4101b15cfcc798624412ff035d115ac`.
  - `SHA256SUMS.txt` 304 bytes `d9fe756b667573ae8098125a9900e247fd323893c0305ba3d5e5375ce14eb051`.
- `notes.ts` wrote `arbareto-0.1.0-release-notes.md` (3578 bytes) to a separate `notes` folder. This differs from the literal Q2 text.
- `git status --porcelain --untracked-files=all` in the clone printed nothing after the install, after the rehearsal, after the Q3 controls, and at the end.
- Quickstart Q3 control mutations, each undone and rerun green: `package.json` version `0.1.1` gives `RELEASE_CHECK version-mismatch 0.1.0 0.1.1`, exit 1; one untracked file gives `RELEASE_CHECK dirty`, exit 1, and `package:preview:exes` exits 1; one changed installer byte gives `sums.ts verify` exit 1 with `RELEASE_SUMS mismatch`, and the original file gives exit 0.
- Commit 195b03df changed the release scripts and the workflow after this run. So T026 runs once more on the final branch head before the `v0.1.0` tag, together with the T028 full run. T026 stays open.
- `OBSERVATION T026: a58a7da0 every Q2 step exit 0; four files; sums verify exit 0; porcelain empty; Q3 mutations fail as stated; rerun needed after 195b03df`

### T028 run at a58a7da0 (build commit a58a7da0)

- `bun run test:all` had one failure: the SC-002 case of `tests/git/commit-changes.test.ts`, with `rejected` and `UNKNOWN_TARGET`.
- Cause: a Windows temp clean-up deleted the refs of the cached test repository. The cache reused the damaged entry. 007 code did not cause the failure.
- 005 T113 (848764d0, merged in 99bace2f) rebuilds a cached test repository when its refs changed. Main 99bace2f is merged into this branch at 61892fbc.

### Review of batch 2 (independent reviewer, fix commit 195b03df, 2026-10-31)

The review ran as an independent reviewer pass on batch 2. Its fixes are in 195b03df:

1. A reused draft release with an asset that this run does not build refuses with `RELEASE_CHECK exists`.
2. The notices generator, About, and the notices text use one schema in `src/contracts/notices.ts`.
3. The Hunspell source archive writes `info/attributes`, so `export-ignore` and `export-subst` in the tree have no effect.
4. The README states the 0.1.0 download in the future tense. T032 changes it after the publish.
5. New tests: workflow expressions, token scope, publish order, the sums format, and the stale-asset refusal.

Security scrutiny of the workflow permissions and the SignPath token, from `tests/contracts/release-workflow.test.ts` and `release.yml`:

- Permissions: the workflow sets `permissions: {}`. The test "workflow permissions are empty" checks it.
- `build` has exactly `contents: read` and `actions: read` and no environment. The test "build runs on windows-2025 with exactly contents: read and actions: read, and no environment" checks it.
- `publish` needs `build`, uses the environment `release`, runs only for `v*` tag pushes, and has exactly `contents: write`, `id-token: write`, and `attestations: write`. A test checks each of these. Its checkout sets `persist-credentials: false`.
- Every `uses:` names a full 40-hex commit ID. A test checks it.
- No `run` block holds an expression. The test "no run block holds an expression" checks it.
- The secret `SIGNPATH_API_TOKEN` appears only in the two SignPath `api-token` inputs and in `SIGNPATH_TOKEN_SET`. A test checks it. `SIGNPATH_TOKEN_SET` holds only the boolean `secrets.SIGNPATH_API_TOKEN != ''`, not the token.
- Each SignPath step runs only when `ARBARETO_SIGNING` is `signpath`. A test checks it.
- In `publish`, `sums.ts verify` runs before `actions/attest`, and `actions/attest` runs before the publish step. A test checks the order.

### T028 partial verification (2026-10-31, reference host, build commit 61892fbc)

- Scope: the steps that need no full run. The full `bun run test:all` run is still open. The orchestrator runs it once before the `v0.1.0` tag.
- `tests/git/commit-changes.test.ts` alone: exit 0, 16 pass, 0 fail. All `ORIGIN` lines name the checkout under test.
- Control mutations, each undone byte for byte (`git diff --exit-code` exit 0) and rerun green:
  - `release.yml`: the `publish` checkout uses `actions/checkout@v4`. `tests/contracts/release-workflow.test.ts` exit 1, 1 of 17 fail ("every uses: names a full 40-hex commit ID"). Rerun: 17 of 17 pass.
  - `release.yml`: `build` gets `contents: write`. The workflow test exit 1, 1 of 17 fail ("build runs on windows-2025 with exactly contents: read and actions: read, and no environment"). Rerun: 17 of 17 pass.
  - `sums.ts`: the extra-file check is removed. `tests/contracts/release-files.test.ts` exit 1, 1 of 20 fail ("an extra file gives RELEASE_SUMS extra"). Rerun in the run below: pass.
- `tests/contracts/release-files.test.ts`, `release-workflow.test.ts`, `release-pins.test.ts`, and `tests/git/release-check.test.ts` together: exit 0, 70 pass, 0 fail, 4 files. All `ORIGIN` lines name the checkout under test.
- `bun run typecheck` exit 0. `bun run export:schemas --check` exit 0.
- `git status --porcelain --untracked-files=all` printed nothing after the restores.
- Not run here: `bun install --frozen-lockfile`, `bun run build`, `cargo test`, and `bun run test:all`.
- `OBSERVATION T028: 61892fbc commit-changes 16 pass 0 fail; three control mutations fail as stated and pass after the restore; four release test files 70 pass 0 fail; typecheck and schema check exit 0; test:all open`

### T027 `/speckit-analyze` for 001 (2026-11-06, branch `007-reconcile`)

- Run: `check-prerequisites.ps1 -Json -RequireSpec -RequireTasks -IncludeTasks` with `SPECIFY_FEATURE_DIRECTORY=specs/001-desktop-qualification` and `SPECIFY_FEATURE_NO_PERSIST=1`. Exit 0.
- Scope: 76 requirements (FR and SC), 409 tasks (353 done, 56 open). 60 of 76 requirements have an explicit ID in 001 tasks.md.
- Counts: 0 CRITICAL, 1 HIGH, 3 MEDIUM, 1 LOW.
- HIGH, fixed: 001 research.md R7 "Corresponding Source location" kept the rule "private until version 1" next to the 2026-10-24 paragraph, and spec.md line 37 states that the repository is public since 2026-10-25. The 2026-10-24 paragraph now states that it replaces that rule.
- MEDIUM, fixed (two findings): 001 plan.md B-RELEASE row and line 613 said that the repository "becomes public" before the preview. spec.md line 37 says that it is public since 2026-10-25. Both lines now state that fact.
- MEDIUM, open: 16 requirements have no explicit ID in 001 tasks.md: FR-001, FR-006, FR-009, FR-010, FR-011, FR-014, FR-016, FR-018, FR-029, FR-031, FR-032, FR-038, FR-049, FR-050, FR-051, FR-054. The 007 amendments do not touch them.
- LOW, no change: 001 plan.md "Constitution Check" cites constitution 3.0.0. The 4.0.1 sync report keeps these rows correct.
- No CRITICAL or HIGH finding on the 007 amendments stays open.
- `OBSERVATION T027: 001 analyze 0 CRITICAL, 1 HIGH fixed, 2 MEDIUM fixed, 1 MEDIUM open, 1 LOW`

### T031 Release settings, partial (2026-11-09, GitHub API, `auric/arbareto`)

- The orchestrator set the values through the GitHub API at the user's request. A GET read back each value.
- History: the first `PUT environments/release` and `POST environments/release/deployment-branch-policies` returned HTTP 200, with `can_admins_bypass` `true` (the GitHub default).
- A second `PUT environments/release` with the full body returned HTTP 200. It sets `can_admins_bypass` to `false` to meet spec FR-018.
- Environment `release`, final read-back:
  - Required reviewer: `auric` (type `User`).
  - `prevent_self_review`: `false`. A single maintainer cannot use self-review prevention (research R3).
  - `can_admins_bypass`: `false`. An admin cannot skip the required approval.
  - Wait timer: none.
  - `deployment_branch_policy`: `{"protected_branches": false, "custom_branch_policies": true}`.
  - Deployment policy: one policy, `{"name": "v*", "type": "tag"}`.
- Immutable releases: already on before this step (`{"enabled": true, "enforced_by_owner": false}`). No change.
- Repository: `"private": false`. Only the signed-in account read this value.
- Anonymous public check (2026-11-09T10:42:51Z): an unauthenticated `GET https://api.github.com/repos/auric/arbareto` returned HTTP 200.
  - The request sent no token and did not use `gh`. `gh api` sends the stored token of a signed-in account, so this call is the anonymous form of the T031 check.
  - Response: `"full_name": "auric/arbareto"`, `"private": false`, `"visibility": "public"`, `"default_branch": "main"`, `"archived": false`.
  - The response body and the request time are in local scratch. The HTTP status comes from the orchestrator record.
- Open: the check that `main` holds features 005, 006, 008, 010, and 011 and the 004 Submodules tree (004 User Story 12).
- T031 stays open until this check passes.
- `OBSERVATION T031: environment release set (reviewer auric, admin bypass off, tag policy v*); immutable releases on; anonymous check private false; main content check open`

### T024 Bun pin case (2026-11-09, reference host, the tree that fcdcf041 commits)

- `bun test ./tests/contracts/release-workflow.test.ts`: exit 0, 18 pass, 0 fail. The `ORIGIN` line names the checkout under test.
- Control mutation, undone byte for byte: in the `build` "Install Bun" step only, `RELEASE_CHECK pin` becomes `RELEASE_CHECK pinX`. The workflow test exit 1, 1 of 18 fail ("each Install Bun step compares the zip hash with BUN_ZIP_SHA256 and exits 1 with RELEASE_CHECK pin bun-windows-x64.zip").
- `release.yml` SHA-256 before the mutation and after the restore: `0266D50EE523BA7D79DA0CC33B96C8A17BDE9B3164E0A16DDB7A070837ED8AE4`.

### 6bb2235d review cases (2026-11-09, reference host, the tree that 6bb2235d commits)

- `bun test ./tests/contracts/release-files.test.ts`: exit 0, 21 pass, 0 fail. The `ORIGIN` lines name the checkout under test.
- `bun test ./tests/contracts/release-workflow.test.ts`: exit 0, 19 pass, 0 fail. The `ORIGIN` line names the `release.yml` of the checkout under test.
- Control 1, undone byte for byte: the `info/attributes` line in `hunspell-source.ts` goes back to `* -export-ignore -export-subst`. The release-files test exit 1, 1 of 21 fail ("core.autocrlf=true in the Git config leaves the archive files equal to the pinned blobs").
- `hunspell-source.ts` SHA-256 before the mutation and after the restore: `4601BF2D2E683D190DB4D7469FDDD0563436056E72B9C079B816EE4BB49C7EBC`.
- Control 2, undone byte for byte: in `release.yml`, `RELEASE_CHECK not-tag-commit` becomes `RELEASE_CHECK xnot-tag-commit`. The workflow test exit 1, 1 of 19 fail ("a tag on another commit than GITHUB_SHA gives RELEASE_CHECK not-tag-commit and no release change").
- `release.yml` SHA-256 before the mutation and after the restore: `54B0CE4B2B7E0AC2492C57E3DF9AECD611077B95FF0DC5B085E340FA7AB987D5`.
- Fact (2026-11-09, read-only `gh api` check): `repos/git/git/commits/refs/tags/v2.45.0` returns `786a3e4b8d754d2b14b1208b98eeb0a554ef19a8`. This is the commit of the annotated tag, equal to the `refs/tags/v2.45.0^{}` line of `git ls-remote`. `repos/git/git/commits/tags/v2.45.0` returns HTTP 422. So the publish step uses the `refs/tags/<tag>` form.
- Fact (2026-11-09, GitHub docs "Events that trigger workflows", `push` table): `GITHUB_SHA` is the "Tip commit pushed to the ref." actions/checkout `src/ref-helper.ts` `testRef` compares `github.context.sha` with `rev-parse <ref>^{commit}`.
- T032 gives the live check of the publish tag check.

### T029 dry run 1 (2026-11-09, GitHub, build commit 9a8707ce)

- Run: https://github.com/auric/arbareto/actions/runs/42683284963. Job `build` failed at "Build the executables". Steps 1 to 6 passed.
- Cause: `build:frontend` ran `bunx --bun vite build`, and the step printed `bun: command not found: bunx`. "Install Bun" puts the folder of `bun-windows-x64.zip` on `PATH`. The zip holds only `bun.exe`.
- Fix: `build:frontend` runs `bun x --bun vite build`. `bun x` is a `bun` subcommand, so it needs no second file. `bun x --bun vite --version` on the reference host prints `vite/8.3.5`.
- Second defect, found in the same check: `package:preview:exes` ended with `"$LOCALAPPDATA/tauri/NSIS/makensis.exe" -VERSION`. tauri-cli 2.12.0 `build.rs:132` skips the bundler for `--no-bundle`. Only the bundler gets the NSIS toolset (tauri-bundler 2.10.0 `nsis/mod.rs:80-96`). A new runner has no `makensis.exe` at this step. Fix: `package:preview:exes` skips the NSIS print. `package:preview:bundle` and "Record the build tools" still print the NSIS version.
- New case in `tests/contracts/release-workflow.test.ts`: every package script that a build step runs, through `bun run`, nested scripts, and the Tauri `beforeBuildCommand`, starts only `bun`, `cargo` or `rustc` after their install step, or `makensis.exe` after the bundler ran.
- Reference host, the fixed tree: `bun run typecheck` exit 0. `bun test ./tests/contracts/release-workflow.test.ts ./tests/contracts/release-pins.test.ts` exit 0, 33 pass, 0 fail. `bun test ./tests/contracts` exit 0, 6868 pass, 37 skip, 0 fail. The `ORIGIN` lines name the checkout under test.
- Control 1, undone byte for byte: `build:frontend` goes back to `bunx --bun vite build`. The workflow test exit 1, 1 of 20 fail, with `build:frontend: bunx --bun vite build`.
- Control 2, undone byte for byte: `package:preview:exes` gets the NSIS print back. The workflow test exit 1, 1 of 20 fail, with the `makensis.exe` part of `package:preview:exes`.
- `package.json` SHA-256 before each mutation and after each restore: `A63E412C3391E0A238931107428BF95F56AB4239AFFAA7FC5B00CF32588FAB5B`.
- Rerun: dry run 2.

### T029 dry run 2 (2026-11-10, GitHub, build commit 5f31d07a)

- Run: https://github.com/auric/arbareto/actions/runs/42771011191. The push fast-forwarded `release-dry-run` from 9a8707ce. Result: success.
- Job `build` succeeded. Steps: checkout, "Install Bun", "Install Rust and the Tauri CLI", "Install packages", "Check the tag, version, and tree before the build", "Build the executables", "Build the installer", "Record the build tools", "Make the release files", "Check the tag, version, and tree after the build", upload-artifact. The five signing steps were skipped (signing off). Job `publish` was skipped.
- Times (`gh run view --json jobs`, second resolution): job `build` 16 min 50 s. "Install Rust and the Tauri CLI" 8 min 52 s, with the `cargo install tauri-cli` build. "Install packages" 1 min 4 s. "Build the executables" 5 min 21 s. "Build the installer" 1 min 7 s. "Make the release files" 3 s.
- `check.ts --mode dry-run --signing off` after the build: success. The `release-files` artifact passes `bun scripts/release/sums.ts verify`, exit 0.
- Image `windows-2025-vs2026` 20261103.298.1, Windows Server 2025 Datacenter 10.0.26100, runner 2.338.2.
- Tools: rustc 1.99.0 (b940084d7 2026-09-28), cargo 1.99.0 (5f94df478 2026-08-27), tauri-cli 2.12.0, bun 1.4.4, NSIS v3.11. MSVC toolset 14.51.36231 (Visual Studio 18 Enterprise). Windows SDK 10.0.26100.0.
- Artifact files, size in bytes and SHA-256:
  - `Arbareto_0.1.0_x64-setup.exe`: 46,600,550, `5c2ece4748edb0f37e98fa5c2bb6526ba41dbf88dec3b19fa6f0560e7196dfe6`.
  - `arbareto-0.1.0-hunspell-source.tar.gz`: 2,211,093, `36f0e8eef304e99b837f95354b376cda5f1edbff29e398b2aa6f6ffcbf328dd9`.
  - `arbareto-0.1.0-third-party-notices.txt`: 650,568, `00971cc0a0227009c3134f93603a2542f4101b15cfcc798624412ff035d115ac`.
  - `SHA256SUMS.txt`: 304, `6acec9ff7c94756d36b63808a1c6a4053c8f0f9084062e0afecaa79e9347242e`.
- Archive against the pins: unpacked with System32 `tar.exe -xzf`, compared with upstream bare clones in local scratch.
  - hunspell `edb61910…`: 721 files in both, the same list. 720 files have equal SHA-256. `README` is a symlink (mode 120000) in Git and in the archive. Its target text `README.md` equals the Git blob.
  - hunspell-wasm `8f755ef6…`: 51 files in both, the same list, all equal.
  - The archive root also holds `SOURCE.txt`.
- The artifact holds no release notes file, as designed. Only the `publish` job makes it (`release.yml:206-208` tag condition, `:258` notes.ts to `RUNNER_TEMP`, `:268` and `:275` gh release).
- Against the local rehearsal of 9a8707ce (2026-11-09, reference host, driver log in local scratch): the third-party notices are identical. The tool versions are the same: rustc 1.99.0, cargo 1.99.0, tauri-cli 2.12.0, bun 1.4.4, NSIS v3.11. The installer differs (local 46,599,710 bytes, `eded3c5f…`). The build commits differ, so this comparison does not show the cause. The local run left out `hunspell-source.ts`, because it reads github.com. So its `SHA256SUMS.txt` (200 bytes) lists two names. The CI file (304 bytes) lists three names: the installer, the archive, and the notices.
- Next: the orchestrator deletes the `release-dry-run` branch. T029 stays open until T028 passes.

### T028 pre-tag verification (2026-11-10 at b9fbda78, 2026-11-11 at e89a5faa)

- Source: the driver logs in local scratch.
- Run 1 at b9fbda78 (2026-11-10, Bun 1.4.4) on Windows 11 x64: `bun install --frozen-lockfile`, `bun run build`, `bun run typecheck`, and `bun run export:schemas --check` exit 0.
- Run 1: `cargo test --locked --manifest-path src-tauri/Cargo.toml` exit 0, 666 passed, 0 failed, 16 ignored. `bun run package` exit 0. The SHA-256 of the installed exe equals the build.
- Run 1: `bun run test:all` exit 1. Parallel part: 9089 pass, 45 skip, 51 fail. Serial part: 976 pass, 25 skip, 0 fail.
- All 51 fails are in `tests/contracts/workbench-worktrees.test.tsx`. The case "more than 200 worktrees" took 5019.80 ms, over the 5 s Bun default. Then the 50 later cases of that file failed.
- Run 1: `bun run test:windows` stopped at its 400 min limit. Two cases failed:
  - 010 T018 SC-010d and SC-011 in `commit-menu-perf.test.ts`: Hard median 4097 ms, budget 4000 ms.
  - 005 T060 SC-007 in `inspection-packaged.test.ts`, with 3 opens per kind.
- Run 1: three `test:windows` files did not start: `submodule-update-packaged`, `uia`, and `workbench-packaged`.
- Run 1: `bun test ./tests/gate` 175 pass, 0 fail.
- User decision 2026-11-10: a targeted rerun replaces a second full `test:all`.
- User decision 2026-11-11: fix the tests, then do one targeted run on the final head. The run includes the five Windows files and the T026 rehearsal.
- Test-only fixes:
  - dcde6cc1: 30 s per-case limits in 8 heavy DOM and fixture test files.
  - 78a5cee3: SC-007 compares the medians of 7 opens per kind. The 150 ms allowance does not change.
  - 823c0d1f: CHANGELOG text.
- `git diff b9fbda78 e89a5faa -- src src-tauri package.json bun.lock scripts` is empty. So the product code is the same at both commits, and the packaged steps ran the installed b9fbda78 build.
- Run 2 at e89a5faa (2026-11-11) on Windows 11 x64: install, typecheck, schema check, and `tests/groups` exit 0.
- Run 2: the 8 changed test files give 291 pass, 0 fail. The "more than 200 worktrees" case passes. Control: the 30 s limit of the "more than 200 worktrees" case became 1 s. That case and 50 later cases failed, and 22 passed. The restore left the tree clean.
- Run 2: `bun test --parallel=8 --isolate ./tests/contracts` gives 6869 pass, 37 skip, 0 fail, 143 files.
- Windows files at e89a5faa:
  - `submodule-update-packaged`: 5 pass, 0 skip, 0 fail.
  - `uia`: 11 pass, 0 skip, 0 fail.
  - `workbench-packaged`: 8 pass, 6 skip. The T082 live-input cases need `ARBARETO_LIVE_INPUT=1`.
  - `commit-menu-perf`: 8 pass, 0 skip, 0 fail.
  - `inspection-packaged`: 11 pass, 1 skip. The skip is FR-028 N2: no volume without a Recycle Bin.
- 005 T060 SC-007, 7 opens per kind: submodule open median 428 ms, normal parent 365 ms, parent button 349 ms, normal submodule 347 ms. The allowance is 150 ms. The gap is 63 ms.
- SC-007 control: with the allowance set to -1000, the case fails. The hash after the restore is equal.
- 010 T018 SC-010d medians, budget in brackets: Hard 3460.6 ms (4000), Detached checkout 2139.8 (4000), Continue 810.9 (2000), Cherry-pick 748.8 (2000), Revert 693.7 (2000), Mixed 626.4 (2000), Create tag 632.2 (1000), Soft 549.8 (1000), Abort 461.1 (2000).
- SC-011: every Windows series has at least 20 inputs, p95 at most 64 ms, and max at most 88 ms.
- 010 T018 control: the probe interval becomes 25 ms instead of 10 ms. The case fails: Abort got 12 inputs, minimum 20. The hash after the restore is equal.
- The 2026-11-10 Hard miss (4097 ms): an A/B run on 2026-11-11 gave 3258 ms and 3196.9 ms with the old probe, and 3147.1 ms with the release probe. The A/B rules out the probe. The cause stays unknown.
- Platform split:
  - Run 1 used OS build 26300 before KB5132061. KB5132061 was installed on 2026-11-11 at 01:41, during `test:windows`.
  - Run 1 used WebView2 157.0.4341.42. This value is probable and comes from the update log.
  - The A/B run and run 2 used OS 26300.9974 and WebView2 157.0.4341.46. WebView2 was updated on 2026-11-11 at 08:32.
- Run 2 tools: Bun 1.4.4, cargo and rustc 1.99.0, Git 2.56.0.windows.2, makensis 3.11.
- ORIGIN: every test step of run 2 printed `ORIGIN` lines in the checkout under test. No line names another origin.
- T028 control mutations at e89a5faa in the T026 clone, each undone, the clone clean after each:
  - m4: `@v4` in the workflow. The workflow test fails.
  - m5: `build` gets `contents: write`. The workflow test fails.
  - m6: `sums.ts` without the extra-file check. The `extra` case fails.
- `OBSERVATION T028: b9fbda78 test:all 51 fail in one file by the 5 s timeout, test:windows 2 fail and 3 files not started; e89a5faa after test-only fixes: tests/contracts 0 fail, five Windows files 0 fail, three control mutations fail as stated`
- T028 rests on the two user decisions above, not on one green `test:all` run.

### Review of 6bb2235d and 5f31d07a (independent reviewer, 2026-11-11)

No finding blocks T028. The workflow permissions, the `release` environment gate, the commit-ID pins, and the SignPath token use did not change since 195b03df. The publish tag check compares the tag commit with `GITHUB_SHA` exactly and refuses on a `gh` failure. The `info/attributes` line turns off every working-tree conversion in `git archive` and changes no user config.

- Low: the tag check runs before the asset upload, so a tag move during the upload is not detected. Move the check before `--draft=false`. Deferred to v0.1.1.
- Low: no test covers a tree `text eol=crlf`, `ident`, or `filter` attribute. Deferred to v0.1.1.
- Suspicion: `--upstream` accepts an option-like value. Add `--end-of-options` before the fetch URL. Deferred to v0.1.1.

### T026 Local rehearsal of the build job, third run (2026-11-11, clean clone at e89a5faa)

- Exit 0 in the targeted run: c0 to c6 and c8 to c11. These are the install, `check.ts --mode dry-run --signing off`, the build, `package:preview:exes`, `package:preview:bundle`, `notices-text.ts`, `sums.ts write` and `verify`, `notes.ts`, and `cargo tauri --version` (tauri-cli 2.12.0).
- The driver left out c7 (`hunspell-source.ts`), because it reads the network. On the same day, c7 ran in the same clean clone: exit 0, 9 s. Then `sums.ts write` and `verify` ran again on the four files: exit 0.
- The verified folder holds exactly four files:
  - `Arbareto_0.1.0_x64-setup.exe` 46601572 bytes `b83a762792cde895086e60e69de1c7b36397ee79a9c9ce7ad83ddca37896cb65`.
  - `arbareto-0.1.0-third-party-notices.txt` 650568 bytes `00971cc0a0227009c3134f93603a2542f4101b15cfcc798624412ff035d115ac`.
  - `arbareto-0.1.0-hunspell-source.tar.gz` 2211093 bytes `6dc4bdde6c15ab6909d7d1a6a5ebe98b2f13e718e509a95f18613e2ddb2eee90`.
  - `SHA256SUMS.txt` 304 bytes `25e5d4a062e86151cd26d17fd1dbc7437767adaa24f31d902e8a19d372c95dc5`.
- The release notes file has 5443 bytes, `06e7bd112e194519a7c9a1d4767d683fb32e45831a3b2500dd1c56ea2dd987be`.
- Archive content check by the T029 method:
  - `hunspell` pin edb619100791110d3e34f09ec35392ad327c1135: 721 files.
  - `hunspell-wasm` pin 8f755ef64e8b047b77b676f9698b3dfa5cb1887d: 51 files.
  - The file lists equal `git ls-tree`. 0 SHA-256 mismatches. The one symlink is a symlink, and its target is the blob text.
- The archive hash differs from dry run 2. The size is the same, 2211093 bytes. The gzip header MTIME is the build time, and the tar entries carry the commit time. So the archive bytes are not reproducible, but the content is.
- `git status --porcelain --untracked-files=all` in the clone printed nothing after the install, after Q2, and at the end.
- Q3: m1, m2a, m2b, m3, m4, m5, and m6 exit 1 as stated. m7 gives 74 pass. m8 and m9 exit 0.
- Tools: Bun 1.4.4 (`bun install v1.4.4 (38afee6c8)`), `rustc 1.99.0 (b940084d7 2026-09-28)`, `cargo 1.99.0 (5f94df478 2026-08-27)`, `git version 2.56.0.windows.2`, makensis `v3.11`, `tauri-cli 2.12.0`.
- `OBSERVATION T026: e89a5faa every Q2 step exit 0 (c7 in a second step); four files; sums verify exit 0; archive content equals both pins; porcelain empty; Q3 mutations fail as stated`

### T031 release settings read-back (2026-11-11, GitHub API, `auric/arbareto`)

- 2026-11-11T16:35:17Z: an unauthenticated `GET https://api.github.com/repos/auric/arbareto` sent no token. Response: `"full_name": "auric/arbareto"`, `"private": false`, `"visibility": "public"`.
- `environments/release` (16:35:18Z): required reviewer `auric`. `deployment_branch_policy` is `{"custom_branch_policies":true,"protected_branches":false}`. Deployment branch policies: one, `{"name":"v*","type":"tag"}`.
- `immutable-releases` (16:35:19Z): `{"enabled":true,"enforced_by_owner":false}`.
- FR-006: `origin/main` at a7ba0473 holds 005 (63c11bf0, 11d447aa), 006 (0d2cfbe1), 008 (6ee8f7fd), 010 (5ac06581), 011 (49577237), and the 004 Submodules tree (6b405b35, 5fb6d74f, 95ce6cc1).
- e89a5faa contains all of `origin/main`.
- `OBSERVATION T031: public, environment release with reviewer auric and tag policy v*, immutable releases on; main at a7ba0473 holds 005, 006, 008, 010, 011, and the 004 Submodules tree`

### T030 Sandbox install of the dry-run installer (2026-11-11, reference host, dry run 2 build commit 5f31d07a)

- Source: artifact `release-files` of run https://github.com/auric/arbareto/actions/runs/42771011191.
- Files, bytes, SHA-256:
  - `Arbareto_0.1.0_x64-setup.exe` 46600550 bytes `5c2ece4748edb0f37e98fa5c2bb6526ba41dbf88dec3b19fa6f0560e7196dfe6`.
  - `arbareto-0.1.0-hunspell-source.tar.gz` 2211093 bytes `36f0e8eef304e99b837f95354b376cda5f1edbff29e398b2aa6f6ffcbf328dd9`.
  - `arbareto-0.1.0-third-party-notices.txt` 650568 bytes `00971cc0a0227009c3134f93603a2542f4101b15cfcc798624412ff035d115ac`.
  - `SHA256SUMS.txt` 304 bytes `6acec9ff7c94756d36b63808a1c6a4053c8f0f9084062e0afecaa79e9347242e`.
- `sums.ts verify` exit 0. All four files equal the "T029 dry run 2" record.
- Host: Windows 11 Pro x64, build 26300.9974.
- The Sandbox WebView2 is registered (`pv=156.0.4314.50`), but its runtime folder is absent. The script maps the host runtime 157.0.4341.46 read-only, as in the T017 record.
- The script maps host Git 2.56.0.windows.2 read-only. Networking is off.
- Install `/S` as the Sandbox user `WDAGUtilityAccount`: exit 0, no `consent.exe` process.
- The Sandbox user is an administrator. So this run proves only a silent per-user install.
- The app starts. About shows `Build: 0.1.0 5f31d07adb69459d1bf78b7e038b86f7992bd807` and `Preview`, without `-dirty`.
- The start page shows "This preview is not a qualified release. The qualification of Windows 11 x64 continues."
- HKCU `Software\Microsoft\Windows\CurrentVersion\Uninstall\Arbareto`: `DisplayName=Arbareto`, `DisplayVersion=0.1.0`, `Publisher=Ihor Lifanov`. No HKLM entry. The Settings page was not opened.
- `arbareto.exe` 17552384 bytes `a2a2afb8b838a67160127dc44d2a880e95da5f3a79373fdaa469d57ed7cf530c`. CompanyName `Ihor Lifanov`, LegalCopyright `Copyright (c) 2026 Ihor Lifanov`.
- `arbareto-git.exe` 116966912 bytes `b1ef33ea57a95da48ab74738483b723147a984f5212bd008fc267bb8fed16715`. CompanyName `Ihor Lifanov`, LegalCopyright `Copyright (c) 2026 Ihor Lifanov`.
- `uninstall.exe` 79264 bytes `5b03c9ae81700718248168ff47415188f787a08d2c5cd3c5781750678061a24e`. This equals the 8185cef5 uninstaller record.
- `uninstall.exe /S` exit 0. After it, the HKCU key, the install folder, and the Start menu shortcut are absent.
- Outside `specs/` and `tests/`, 5f31d07a..e89a5faa changes only `CHANGELOG.md` and `README.md`. So this installer holds the release code.
- The installer manifest (read with the Windows SDK `mt.exe`, NSIS 3.11 build) has `requestedExecutionLevel level="asInvoker" uiAccess="false"`. So Windows asks for no elevation.
- A second Sandbox run on 2026-11-11 created the standard user `arbstd`: member of `Users` only, no Administrators SID in `whoami /groups`, Medium integrity level.
- As `arbstd`, `setup.exe /S` exit 0 (not 740). The user's `%LOCALAPPDATA%\Arbareto` holds `arbareto.exe` (17552384 bytes), `arbareto-git.exe` (116966912), and `uninstall.exe` (79264). The HKCU uninstall key holds `DisplayName=Arbareto`, `DisplayVersion=0.1.0`, `Publisher=Ihor Lifanov`. No HKLM uninstall entry exists.
- As `arbstd`, `uninstall.exe /S` exit 0. Then the HKCU key and the folder are absent.
- This proves SC-001 "no administrator rights" for the silent `/S` install on a fresh Windows 11 x64. It does not cover the interactive installer pages or domain policies.
- `OBSERVATION T030: dry run 2 installer 5c2ece47…7196dfe6, sums verify exit 0; silent install exit 0 as an administrator Sandbox user; About Build: 0.1.0 5f31d07adb69459d1bf78b7e038b86f7992bd807, Preview; HKCU entry only; uninstall exit 0, key, folder, and shortcut absent; standard user install and uninstall exit 0`
