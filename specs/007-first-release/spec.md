# Feature Specification: First Release (Preview v0.1.0)

**Feature Branch**: `007-first-release`

**Feature Directory**: `specs/007-first-release`

**Created**: 2026-10-24

**Status**: Draft

**Input**: User description: "Feature 007 first release: a GitHub pre-release 'preview v0.1.0' after features 005 and 006 merge into main, and before feature 008 (Linux). A tag-triggered GitHub Actions workflow on a Windows runner builds the NSIS installer and attaches the installer, SHA-256 checksums, the third-party notices, and an archive of the exact Hunspell sources. Apply to SignPath Foundation; ship unsigned with checksums if the approval is not in; plan signing so it can be switched on later without redesign. Manual updates only. Release notes list only user-visible changes. The repository must be public before the release." Inputs: the user decisions of 2026-10-24, constitution 4.0.0, 001 plan.md B-RELEASE and research.md R7 and R10, and 006 plan.md D18 and research.md F16.

## Clarifications

### Session 2026-10-24

The user gave these decisions on 2026-10-24. They are fixed inputs for this feature.

- Q: What is the first release? → A: A GitHub pre-release named "preview v0.1.0". It comes after features 005 and 006 merge into `main`, and before feature 008 (Linux). It is clearly marked as a preview (FR-001, FR-002).
- Q: Does the preview end the 001 qualification? → A: No. The full 001 qualification and its release gate (001 T177) continue, and they gate v1.0 (FR-003).
- Q: How is the release built? → A: A GitHub Actions workflow on a GitHub-hosted Windows runner. A pushed `v*` tag starts it. It builds the current-user NSIS installer (FR-010).
- Q: Which files go with the release? → A: The installer, a SHA-256 checksum file, the third-party notices, and an archive of the exact Hunspell sources (FR-020 to FR-024).
- Q: Which Hunspell sources go in the archive? → A: hunspell/hunspell commit `edb619100791110d3e34f09ec35392ad327c1135` and rotemdan/hunspell-wasm commit `8f755ef64e8b047b77b676f9698b3dfa5cb1887d` (its build files). Every release carries the archive, and About links it (FR-023, FR-031).
- Q: Is the preview signed? → A: The maintainer applies to SignPath Foundation. If the approval is not in, v0.1.0 ships unsigned with SHA-256 checksums. The signing step must switch on later without a redesign (FR-040 to FR-044).
- Q: How do users update? → A: Manual downloads from GitHub Releases. No in-app updater in this feature (FR-005).
- Q: What do the release notes contain? → A: Only changes that a user of the application sees. No internal history, review rounds, or test runs (FR-025).
- Q: Must the repository be public? → A: Yes, before the release. The user gives that OK separately (FR-004).

### Session 2026-10-24 (answers to research.md R6)

- Q: Is the preview a production release under the constitution delivery gate on update authenticity? → A: No. A GitHub pre-release with no updater is not a production release. Constitution 4.0.1 (PATCH, 2026-10-24) defines the term at the delivery gate: "A production release is a release that users get through an in-app updater or a stable (not pre-release) distribution channel. A GitHub pre-release that users download by hand is not a production release." 001 plan.md B-RELEASE, 001 research.md R7, and the three 001 spec.md "public release" lines change so that they gate v1.0, not every public release (FR-003, FR-007).
- Q: Are releases immutable? → A: Yes. The orchestrator switches on immutable releases at the public switch. It is a repository setting step, not a workflow step (FR-028).
- Q: Which tag form? → A: `v0.1.0` with the GitHub pre-release flag and "Preview" in the title (FR-001).
- Q: Which signing scope with SignPath? → A: The two executables and the installer. The uninstaller and the Tauri NSIS plugin DLL stay unsigned until SignPath confirms a flow for them. The release notes record this limit (FR-041, FR-046).
- Q: Which Tauri CLI builds v0.1.0? → A: tauri-cli `2.12.0` with NSIS `3.11`, the pins of all 001 evidence. The 2.12.4 and NSIS 3.13 update comes after the preview (FR-011).
- Q: Which "Installed apps" name? → A: "Arbareto" for a release build. The local package keeps "Arbareto (Unsigned local test package)" (FR-033).
- Q: Is a code of conduct needed? → A: No, not for v0.1.0.
- Q: Where do the release notes come from? → A: `CHANGELOG.md`, one section per release, user-visible changes only (FR-025).
- Q: In which order do public switch, release, and SignPath come? → A: Public switch, then v0.1.0 unsigned, then the SignPath application with the release URL, then signing for a later version (FR-045).
- Q: What do users learn about Smart App Control? → A: The release notes and the README download section state that unsigned builds do not run when Smart App Control is on (FR-026, FR-029).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Download and install the preview (Priority: P1)

A Windows 11 user finds Arbareto on GitHub. The Releases page shows "preview v0.1.0" as a pre-release. The page states that the build is a preview, which prerequisites it needs, whether it is signed, and what Windows may show at install. The user downloads the installer, checks its SHA-256 value against the checksum file, installs it for the current user, and starts Arbareto. About shows the version, a preview marker, and the build commit of the release tag.

**Why this priority**: A downloadable, installable package is the purpose of the feature. Without it, nothing else has value.

**Independent Test**: In a clean Windows 11 x64 Sandbox with only the documented prerequisites, download the release installer from the public release page, verify its SHA-256 value, install it, and start the application. About must show `0.1.0`, the preview marker, and the full commit ID of the tag.

**Acceptance Scenarios**:

1. **Given** the published preview release, **When** a user opens the Releases page, **Then** the release is marked as a pre-release, its title and notes say "preview", and the notes list the prerequisites, the signing state, and the known Windows warnings.
2. **Given** the downloaded installer and the checksum file, **When** the user computes the SHA-256 value of the installer, **Then** the value equals the line for that file in the checksum file.
3. **Given** a clean Windows 11 x64 machine with Git for Windows and the WebView2 Runtime, **When** the user runs the installer as a standard user, **Then** the installation needs no administrator rights, and Arbareto starts without a globally installed Node or Bun.
4. **Given** the installed preview, **When** the user opens About, **Then** it shows version `0.1.0`, the preview marker, and a build identity that equals the full commit ID of the tag, without `-dirty`.
5. **Given** the installed preview, **When** the user removes it from Windows "Installed apps", **Then** the uninstaller removes the application.

---

### User Story 2 - Publish a release from a tag (Priority: P1)

The maintainer pushes a `v*` tag on a commit of `main`. A release workflow on a GitHub-hosted Windows runner checks the inputs, builds the installer with pinned tools, produces the release files, and waits for the maintainer's approval. After the approval, it publishes a pre-release with all files at once. Any failed check stops the run, and nothing is published.

**Why this priority**: The installer of User Story 1 must come from a repeatable, auditable build. A hand-built local package gives no provenance and cannot be signed through SignPath later.

**Independent Test**: In a scratch fork or a disposable repository, push a test tag. The run must build, record the tool versions, stop for approval, and then publish a pre-release with every required file. Push a second tag whose version does not match the application version. That run must fail before the build, and no release may appear.

**Acceptance Scenarios**:

1. **Given** a tag `v0.1.0` on a commit of `main` and an application version `0.1.0`, **When** the tag is pushed, **Then** the workflow builds the installer and produces the full release file set.
2. **Given** a tag whose version differs from the application version, **When** the tag is pushed, **Then** the workflow fails before the build, with a message that names both values.
3. **Given** a tag on a commit that is not on `main`, **When** the tag is pushed, **Then** the workflow fails, and no release appears.
4. **Given** a completed build, **When** the maintainer has not approved the publish step, **Then** no release is visible to the public.
5. **Given** an approved publish step, **When** one file upload fails, **Then** the release stays a draft or is absent, and the run reports the failed file. No partial public release appears.
6. **Given** a finished run, **When** the maintainer reads the run record, **Then** it lists the versions of every build tool that ran and the runner image version.

---

### User Story 3 - Verify that a download is authentic (Priority: P2)

A careful user or a packager checks that the installer came from this repository's release workflow at the tag commit. The user checks the SHA-256 value, verifies the build provenance attestation with a documented command, and sees that the release files cannot change after publication.

**Why this priority**: Without signing, provenance and checksums are the only authenticity evidence. They also support the later SignPath application.

**Independent Test**: Download every release file. Run the documented checksum check and the documented attestation check. Both must pass. Change one byte of a copy of the installer. Both checks must then fail for the copy.

**Acceptance Scenarios**:

1. **Given** the release files, **When** the user runs the documented attestation check on the installer, **Then** it reports that the repository's release workflow built the file at the tag commit.
2. **Given** a copy of the installer with one changed byte, **When** the user runs the checksum check and the attestation check, **Then** both checks fail.
3. **Given** a published release, **When** anyone tries to replace a release file or move the tag, **Then** GitHub refuses the change.

---

### User Story 4 - Get the licences and the source (Priority: P2)

A user or a distributor wants the licence texts of every third-party component and the source of the shipped Hunspell code. The release carries the third-party notices and the Hunspell source archive. About in the installed application links the Hunspell source archive of that release and the source of the tag.

**Why this priority**: The licences of shipped components (LGPL-2.1 Hunspell, AGPL-3.0-or-later Arbareto, and others) require this information. A public release without it is not acceptable.

**Independent Test**: Download the notices file and the Hunspell source archive from the release. The notices must equal the inventory that About shows. The archive must hold the two pinned commits, with their commit IDs recorded. Open About in the installed preview, and follow the Hunspell source link and the source link. Each must reach the file or the tag of this release without a sign-in.

**Acceptance Scenarios**:

1. **Given** the release, **When** the user downloads the third-party notices file, **Then** it holds the same entries and licence texts as About in the installed application.
2. **Given** the release, **When** the user unpacks the Hunspell source archive, **Then** it holds the tree of hunspell/hunspell at `edb619100791110d3e34f09ec35392ad327c1135` and the tree of rotemdan/hunspell-wasm at `8f755ef64e8b047b77b676f9698b3dfa5cb1887d`, and a file that names both commits and their origin.
3. **Given** the installed preview, **When** the user follows the Hunspell source link in About while signed out of GitHub, **Then** the link reaches the Hunspell source archive of the same release.
4. **Given** the installed preview, **When** the user follows the source link in About while signed out, **Then** the link reaches the source of the tag commit.

---

### User Story 5 - Switch on code signing later (Priority: P3)

After SignPath Foundation approves the project, the maintainer switches on signing. The next release signs the application executables, the service executable, and the installer through SignPath, with a manual approval per release. The release page and the README then carry the code signing policy that SignPath requires. Until then, releases stay unsigned, and the release notes say so.

**Why this priority**: Signing reduces Windows warnings, but SignPath requires a public repository and an existing release before it approves. So the first release ships unsigned, and signing follows.

**Independent Test**: With signing switched off, a release run produces unsigned files and states "unsigned" in the notes. With signing switched on and a failing or rejected signing request, the run fails, and no unsigned file is published in its place.

**Acceptance Scenarios**:

1. **Given** signing switched off, **When** a release runs, **Then** the files are unsigned, and the release notes state that the build is unsigned and how to verify it.
2. **Given** signing switched on, **When** a release runs and SignPath returns signed files, **Then** every Arbareto executable in the installer and the installer itself carry a valid signature, and the checksums and attestations cover the signed files.
3. **Given** signing switched on, **When** the signing request fails, times out, or is rejected, **Then** the run fails, and no release appears. The run never falls back to unsigned files.
4. **Given** signing switched on, **When** the maintainer compares the workflow with the unsigned version, **Then** the change is limited to the documented switch, the SignPath identifiers, and the stored secret.

---

### Edge Cases

- The tag version and the application version differ: the run fails before the build (FR-012).
- The tag points to a commit that `main` does not contain: the run fails (FR-013).
- The repository is still private: the release workflow refuses to publish, because a private release is invisible to the public and attestations are not available there (FR-004).
- A tag with the same version already has a published release: the run fails, and the existing release stays unchanged (FR-015).
- The build identity ends in `-dirty` because a build step created an untracked file: the run fails (FR-014).
- A pinned tool cannot be installed at its pinned version, or its download does not match its pinned hash: the run fails (FR-011).
- The runner image updates its preinstalled Rust, Git, or Visual Studio: the build still uses the pinned versions, and the run record shows the image version (FR-011, FR-016).
- The Tauri CLI or NSIS version differs from the notices check pin: the notices check refuses the build (FR-022).
- An upstream Hunspell repository is unreachable, or a fetched tree does not match its pinned commit: the run fails, and no archive is made (FR-023).
- An asset upload or the publish step fails after the approval: the release stays a draft or absent, and a rerun completes it without a second tag (FR-017).
- Signing is switched on, and SignPath is slow: the run waits within a fixed time bound, then fails (FR-043).
- Windows SmartScreen shows "Windows protected your PC" for the unsigned installer: the release notes describe the prompt and the checksum check (FR-026).
- Smart App Control is on in enforcement mode: Windows blocks the unsigned preview with no override. The release notes state this limit (FR-026).
- Windows 10 x64: the application runs with the label "Unqualified platform". The release notes name Windows 11 x64 as the qualified platform (FR-027).

## Requirements *(mandatory)*

### Functional Requirements

#### Release scope and gates

- **FR-001**: The first public release MUST be a GitHub pre-release with the tag `v0.1.0` and a title that contains "Preview". It MUST NOT be marked as the latest release.
- **FR-002**: The installed application MUST show a preview marker in About. The marker MUST come from the build configuration of the release, not from a guess at run time.
- **FR-003**: The preview MUST NOT claim the 001 qualification. The release notes MUST state that the qualification of Windows 11 x64 continues and that v1.0 needs it. The 001 release gate (T177, B-RELEASE) stays the gate for v1.0.
- **FR-004**: The release workflow MUST publish only from the public `auric/arbareto` repository. It MUST refuse to publish when the repository is private. The public switch stays the user's own step.
- **FR-005**: The preview MUST NOT contain an in-app updater or an update check. Users update by a manual download from GitHub Releases.
- **FR-006**: Features 005 and 006 MUST be merged into `main` before the release tag is created.
- **FR-007**: 001 plan.md B-RELEASE, 001 research.md R7, and 001 spec.md (the Clarification at line 23, the Assumption at line 529, and FR-033) MUST gate the v1.0 release, not every public release. They MUST cite the constitution 4.0.1 definition of a production release.

#### Build

- **FR-010**: A pushed tag that matches `v*` MUST start the release workflow. The workflow MUST build the current-user NSIS installer on a GitHub-hosted Windows x64 runner. Other events MUST NOT start the publish step.
- **FR-011**: Every build tool MUST be pinned: Bun at `1.4.4` with the published SHA-256 value of its Windows archive, the Rust toolchain, the Tauri CLI, and the NSIS version that the pinned Tauri CLI downloads and checks. Every third-party action MUST be pinned by a full commit ID. A pin mismatch MUST fail the run.
- **FR-012**: The workflow MUST compare the tag version with the application version that the build embeds. A difference MUST fail the run before the build.
- **FR-013**: The workflow MUST fail when `main` does not contain the tag commit.
- **FR-014**: The build identity MUST be the full commit ID of the tag commit without `-dirty`. A dirty identity MUST fail the run.
- **FR-015**: The workflow MUST fail when a release with the same tag already exists. It MUST NOT change or replace a published release.
- **FR-016**: The run record MUST list the runner image version and the versions of `rustc`, `cargo`, the Tauri CLI, `bun`, NSIS, the MSVC toolset, and the Windows SDK that ran.
- **FR-017**: The workflow MUST create the release as a draft, attach every file, and only then publish it. A rerun of a failed run for the same tag MUST complete the draft without a new tag.
- **FR-018**: The publish step MUST wait for the approval of a required reviewer, and it MUST run only for `v*` tags.
- **FR-019**: Each workflow job MUST receive only the permissions it needs. The build job MUST NOT have write access to repository contents.

#### Release files and notes

- **FR-020**: The release MUST carry the installer, a SHA-256 checksum file, the third-party notices file, and the Hunspell source archive.
- **FR-021**: The checksum file MUST list the SHA-256 value of every other release file, in the format that `sha256sum --check` and PowerShell `Get-FileHash` comparisons accept.
- **FR-022**: The third-party notices file MUST come from the same inventory that the build embeds for About. A build whose notices check fails MUST fail the run.
- **FR-023**: The Hunspell source archive MUST hold the tree of hunspell/hunspell at `edb619100791110d3e34f09ec35392ad327c1135` and the tree of rotemdan/hunspell-wasm at `8f755ef64e8b047b77b676f9698b3dfa5cb1887d`. The workflow MUST verify each fetched tree against its pinned commit ID. The archive MUST hold a text file that names both repositories, both commit IDs, and the LGPL-2.1 licence. It MUST state that the Emscripten version of the shipped `hunspell.wasm` is not recorded upstream.
- **FR-024**: The workflow MUST create a build provenance attestation for every release file.
- **FR-025**: The release notes MUST list only changes that a user of the application sees. They MUST NOT contain internal history, review rounds, task IDs, or test runs. The maintainer writes them in the repository before the tag.
- **FR-026**: The release notes MUST state the signing state. For an unsigned release, they MUST describe the SmartScreen prompt, the Smart App Control block, and the checksum and attestation checks.
- **FR-027**: The release notes MUST list the prerequisites: Windows 11 x64 (Windows 10 x64 runs unqualified), Git for Windows `2.55.0.windows.3` or later, the Microsoft Edge WebView2 Runtime, and, for WSL repositories, WSL 2 with Git `2.55.0` or later.
- **FR-028**: The release MUST be immutable after publication: its files and its tag MUST NOT change. The repository setting "immutable releases" provides this. The orchestrator switches it on at the public switch.
- **FR-029**: The README MUST have a download section. It MUST link the Releases page, list the prerequisites, show the checksum and attestation checks, and state that an unsigned build does not run when Smart App Control is on.

#### Application changes

- **FR-030**: About MUST show the version, the preview marker, and the build identity.
- **FR-031**: About MUST link the Hunspell source archive of the release that matches the installed version. The link MUST work without a sign-in.
- **FR-032**: About MUST link the source of the tag commit of the installed build.
- **FR-033**: The "Installed apps" entry of a release build MUST name Arbareto and its version. The marker "Unsigned local test package" MUST stay only on local builds.
- **FR-034**: The service executable MUST carry the product name and version of Arbareto in its file properties, as the application executable does.

#### Signing

- **FR-040**: The workflow MUST have one signing switch. When it is off, the release is unsigned. When it is on, the release is signed through SignPath. No other workflow change MUST be necessary to switch signing on, apart from the SignPath identifiers and the stored secret.
- **FR-041**: When signing is on, the workflow MUST sign the application executable and the service executable before the installer packs them, and then sign the installer.
- **FR-042**: When signing is on, the checksums and the attestations MUST cover the signed files.
- **FR-043**: When signing is on and a signing request fails, is rejected, or exceeds its time bound, the run MUST fail. It MUST NOT publish unsigned files.
- **FR-044**: Before the first signed release, the README and the release notes MUST carry a "Code signing policy" section with the text and the team roles that SignPath Foundation requires.
- **FR-045**: The maintainer's SignPath application MUST meet the published SignPath Foundation conditions (research.md R1). The application is the user's own step. It follows the v0.1.0 release, because SignPath accepts only released projects.
- **FR-046**: When signing is on, the release notes MUST state that the uninstaller and the NSIS plugin DLL are unsigned.

### Key Entities

- **Release**: One GitHub pre-release. Attributes: tag, tag commit, version, title, notes, pre-release flag, signing state, publication state (draft or published).
- **Release file set**: The installer, the checksum file, the notices file, and the Hunspell source archive. Each file has a name, a SHA-256 value, and an attestation.
- **Build record**: The runner image version and the tool versions of one run, kept with the run.
- **Signing switch**: One setting that selects unsigned or SignPath-signed output, plus the SignPath identifiers and the stored secret.
- **Hunspell source archive**: The two upstream trees at their pinned commits and the origin file.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A clean Windows 11 x64 Sandbox with only the documented prerequisites installs and starts the preview from the public release page. The install needs no administrator rights.
- **SC-002**: The SHA-256 value of every downloaded release file equals its line in the checksum file: 4 of 4 files.
- **SC-003**: The documented attestation check passes for every release file, and it fails for a copy with one changed byte.
- **SC-004**: About in the installed preview shows `0.1.0`, the preview marker, and the full tag commit ID without `-dirty`.
- **SC-005**: A tag with a wrong version, a tag outside `main`, a dirty identity, and a pin mismatch each fail the run, and none of them creates a public release: 4 of 4.
- **SC-006**: From the approval to the published release takes at most 15 minutes. The build before the approval takes at most 90 minutes on a GitHub-hosted runner. These are starting budgets, not measurements.
- **SC-007**: Both About links (Hunspell source archive and tag source) reach their targets without a sign-in.
- **SC-008**: Switching signing on changes only the signing switch, the SignPath identifiers, and the stored secret. The rest of the workflow file stays unchanged.

## Assumptions

- The repository is public before the tag. The user gives that OK separately, and the main ruleset and security features follow the public switch (user decisions, 2026-10-24).
- SignPath Foundation approves only released projects (research.md R1). So v0.1.0 ships unsigned, and the application follows the release.
- The version stays `0.1.0` in `src-tauri/Cargo.toml`, and Tauri takes the application version from there (research.md R4).
- A GitHub-hosted runner for a public repository is free (research.md R2).
- The installer stays current-user NSIS and does not install the WebView2 Runtime, as `bun run package` builds it today.
- English is the only bundled dictionary. Downloaded dictionaries do not ship with the release (006 plan.md D18).
- Linux and macOS packages are out of scope. Feature 008 covers Linux.
