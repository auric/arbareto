# Arbareto Constitution

## Core Principles

### I. Preserve User Data

- Git MUST remain authoritative. Cached views and filesystem watchers MUST NOT replace fresh Git state checks.
- Operations MUST NOT silently discard changes, rewrite history, or change user Git configuration. Destructive actions and history rewrites MUST require explicit confirmation of their scope and effects.
- Operations MUST NOT bypass Git hooks.
- Operations MUST use the selected Git executable and record its version.
- Cancellation MUST NOT be reported as rollback. After failure or interruption, the application MUST re-read Git state and report the actual result.
- Recovery claims MUST state their limits. Reflogs cannot restore arbitrary never-committed discarded files.

### II. TypeScript/Bun and Minimal Native Code

- TypeScript and Bun MUST be the default for shared application logic, scripts, and tests.
- Native shell code MUST serve a documented platform requirement that shared code cannot reasonably satisfy.
- The distributed product MUST NOT embed or require Node or Electron.
- Development tools that require Node MUST disclose that dependency in the relevant Spec Kit plan. Those tools MUST NOT become product runtime dependencies.

### III. Validated Operation Boundaries

- The renderer MUST access Git through bounded, typed operations, never arbitrary shell commands.
- The service MUST validate every input. Repository operations MUST target validated, registered repository IDs.
- Process spawning MUST use argument arrays and literal paths. Operations MUST bound output and support cancellation.
- Repository and linked-worktree identities MUST come from Git. Code MUST NOT assume `.git` is a directory.
- Mutations MUST detect stale state before applying changes. Application serialization MUST NOT be treated as control over external Git processes.

### IV. Real Git State Verification

- Risky Git operations MUST have tests in real, disposable repositories. Mocks and successful exit codes alone MUST NOT qualify behavior.
- Assertions MUST inspect index contents, working-file bytes, refs, and repository operation state where applicable.
- Partial staging MUST reject stale selections. Tests MUST verify the exact resulting index and unchanged working-file bytes.
- Tests MUST cover failure, interruption, external changes, and destructive-operation safeguards.

### V. Untrusted Repositories and Credential Protection

- Repository content and configuration MUST be treated as untrusted input, not instructions or trusted markup.
- Repository-controlled hooks, filters, previews, and tools MUST require explicit trust approval before execution. Missing trust MUST block unsafe operations, not silently bypass required hooks.
- Logs and diagnostics MUST NOT contain credentials.
- The compiled Bun service MUST disable unintended runtime configuration autoload and sanitize runtime-control environment variables. It MUST launch from an application-owned directory, not a checked-out repository.

### VI. Platform-Specific Evidence

- Windows MUST be qualified first. Other platforms MUST receive separate qualification before support claims.
- Windows installers, WebView2 integration, native lifecycle, DPI scaling, and IME MUST have packaged Windows evidence.
- Browser or Linux success MUST NOT qualify Windows behavior.
- Evidence MUST identify the build, OS version, architecture, prerequisites, scenarios, and results. Untested behavior MUST remain explicitly unverified.

### VII. Accessible and Measured Interface

- The interface MUST provide compact, readable density and a comfortable-density option.
- Keyboard access, visible focus, accessible contrast, and non-color status cues MUST be verified.
- Destructive actions MUST use explicit labels and remain separate from routine primary actions.
- Responsiveness MUST be measured on packaged builds against budgets set before testing, using agreed hardware and repository fixtures.
- Measurements MUST include input latency, UI stalls, cold/warm timings, CPU, and complete process-tree memory.
- Missed budgets MUST remain failures unless an explicit product trade-off approves changed targets.

### VIII. Pinned Dependencies and Qualified Shell Selection

- Project dependencies and build tools MUST use exact versions or immutable revisions. Supported lockfiles MUST be committed.
- Dependency updates MUST record review results and repeat affected qualification checks.
- Shell selection MUST rely on packaged qualification evidence, not vendor claims or unmeasured comparisons.
- A shell change MUST address a blocking requirement that the current architecture cannot reasonably satisfy. The decision MUST record concrete failures, causes, and attempted remedies.
- Performance comparisons MUST use measurements under matching conditions.

### IX. One Upstream Planning Process

- Feature planning and delivery MUST use GitHub Spec Kit v1.0.12 and its upstream artifacts.
- Requirements, plans, tasks, checklists, research, and qualification evidence MUST remain in those artifacts.
- Custom workflows, orchestration systems, duplicate planning trees, memory ledgers, and automatic multi-agent review loops MUST NOT be added.
- Only one feature MAY be active. `.specify/feature.json` selects it independently of Git branches.
- Upstream skills, scripts, and templates MUST remain unchanged unless an approved requirement needs modification.

## Architecture Constraints

- Arbareto MUST remain cross-platform and local-first. Ordinary Git work MUST NOT require cloud accounts or AI.
- The first qualification feature MUST use Tauri 2 with a compiled TypeScript/Bun Git service.
- Frontend, shared operation contracts, and Git service MUST remain separate. The native shell MUST remain thin.
- Shared code MUST remain portable. Platform-specific behavior MUST stay at boundaries with documented platform requirements.
- The first qualification MUST NOT implement Electrobun, multiple shell adapters, or a framework-independent desktop abstraction.
- Packaged installations MUST work without globally installed Node or Bun. Platform and Git prerequisites MUST be documented.

## Delivery Gates

- Plans MUST define safety tests, trust boundaries, accessibility checks, performance budgets, and applicable platform qualification before implementation.
- Meaningful changes MUST receive one independent review. Destructive operations MUST receive explicit safety scrutiny.
- Feature completion MUST include success, failure, applicable cancellation, external-change, and safeguard evidence.
- Reviews MUST record failures, causes, attempted remedies, and unverified claims in the active feature artifacts.
- Production release MUST remain blocked until update authenticity and tampered-update rejection have verified evidence.

## Governance

- This constitution overrides conflicting project guidance. `CLAUDE.md` and `docs/project-brief.md` apply where consistent with this constitution.
- Maintainers MUST approve amendments proposed through `/speckit-constitution`, with rationale, affected principles, and migration needs.
- MAJOR versions change or remove existing obligations incompatibly. MINOR versions add principles or materially expand obligations. PATCH versions clarify wording without changing obligations.
- Amendments MUST preserve the original ratification date and update the amendment date. Dates MUST use `YYYY-MM-DD`.
- Plans and reviews MUST identify compliance evidence or unresolved blockers for each applicable principle.
- Unresolved violations MUST block affected merges or releases. Conflicting changes MUST wait for an approved constitutional amendment.

**Version**: 1.0.1 | **Ratified**: 2026-09-28 | **Last Amended**: 2026-09-29
