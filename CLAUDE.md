# Arbareto

## Project constraints

- Read `docs/project-brief.md` for scope, selected architecture, and initial Windows qualification criteria.
- Build a cross-platform, local-first Git client. Deliver and qualify Windows first; target macOS and Linux later. Do not use Electron.
- Keep shared frontend, contracts, and Git service logic portable. Isolate platform-specific behavior without adding a desktop abstraction framework.
- Prefer TypeScript and Bun. Ordinary Git work must not require cloud accounts or AI.
- Use Tauri 2 with a compiled TypeScript/Bun Git service for the first qualification feature.
- Do not implement Electrobun, multiple shell adapters, or a framework-independent desktop abstraction.
- Keep the shell thin. Separate the frontend, Bun Git service, and shared operation contracts.
- Validate the selected architecture through packaged Windows tests first. Record concrete failures and their causes.
- Consider another shell only when a blocking requirement cannot reasonably be satisfied by the current architecture.
- Do not claim Tauri is faster than Electrobun without measurements.
- Do not scaffold or implement the application during repository preparation.

## Spec Kit

- Use GitHub Spec Kit v1.0.12 as the only feature-planning process.
- Constitution: `.specify/memory/constitution.md`. Version 2.0.0 is ratified.
- Active feature: `.specify/feature.json`. It selects `specs/001-desktop-qualification`.
- Read `spec.md`, `plan.md`, and `tasks.md` from the selected feature directory.
- Keep one active feature. Manage Git branches explicitly; branch changes alone do not select a feature.
- Use `/speckit-specify`, `/speckit-clarify`, `/speckit-plan`, and `/speckit-checklist` for requirements and planning.
- Continue with `/speckit-tasks`, `/speckit-analyze`, `/speckit-implement`, and `/speckit-converge` when their prerequisites exist.
- Keep shell qualification evidence in the upstream feature artifacts.
- Do not add Superpowers or OpenSpec planning trees, custom workflows, or orchestration runners.
- Do not add memory ledgers, duplicate plan hierarchies, or automatic multi-agent review loops.
- Preserve the upstream skills, scripts, and templates unless an approved requirement needs a change.

## Git and platform safety

- Protect user changes. Treat Git as authoritative.
- Use the selected Git executable without silently changing user configuration.
- Expose bounded, typed Git operations. Never give the renderer arbitrary shell access.
- Validate service inputs. Spawn processes with argument arrays and literal paths.
- Bound output and support cancellation. Re-read Git state after interrupted operations.
- Treat repository content as untrusted. Never put credentials in logs.
- Resolve linked-worktree identities through Git. Do not assume `.git` is a directory.
- Reject stale staging selections. Verify index contents and unchanged working-file bytes in real temporary repositories.
- Test failure, cancellation, external changes, keyboard access, and destructive-operation safeguards.
- Verify native behavior and performance with packaged builds on each supported platform, not browser-only tests.

## Tool boundaries

- Reuse installed tools. Do not install duplicates or remove tools used by other projects.
- Do not change provider, authentication, CLIProxyAPI configuration, or global permissions.
- Verify CodeGraph's installed upstream identity before using product-specific instructions.
- Create a CodeGraph index only after meaningful source exists and the user approves indexing.
- Use only the verified commands in README.md "Development". Add a command only after it runs green.
