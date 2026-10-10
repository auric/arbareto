# Implementation Plan: Windows Desktop Qualification

**Branch**: `001-desktop-qualification` | **Date**: 2026-09-29 | **Spec**: [spec.md](spec.md)

**Input**: `specs/001-desktop-qualification/spec.md` and the user's planning request.

**Status**: Planning artifacts only. Graph and mutation designs are selected. Implementation, real-Git tests, and packaged qualification remain unverified. This update does not implement application code.

## Summary

Plan one installable Windows 11 x64 qualification slice. Keep a React frontend, Bun Git service, shared contracts, and thin Tauri shell.

Compare Tauri and Electrobun using pinned source and Windows release documentation. Do not implement Electrobun. The user selected Tauri-only implementation after the constitutional scope conflict was identified.

The slice covers repository inspection, a bounded history graph, supported text diffs, single-hunk actions, and a local commit workflow. It covers these for repositories in WSL2 distros too, through the distro's Git. It also covers Update submodules: a reviewed, recursive initialization and update, the first network operation (contract §12). It excludes the broader product features listed in the specification.

Hunks use protected candidate-index publication with exact verification. The user approved standard Git commits after fresh preflight. Report late changes explicitly; neither preflight nor application queues freeze independent writers.

See [research.md](research.md) for the resolved design decisions, source citations, component comparison, and remaining qualification evidence.

## Technical Context

**Language/Version**: TypeScript `7.0.2`, Bun `1.4.2`, Rust/Cargo `1.98.0`. Versions are minimum versions, verified on 2026-09-29, except Bun. Bun `1.4.2` is exact, because the service executable embeds it and its source defines the startup controls that the shell removes. Native code serves IPC, Windows lifecycle, native machine detection, and WebView2 control requirements only. Native build tools: MSVC toolset `14.51.36231` and Windows SDK `10.0.26100.0`, as minimum versions. NSIS `3.11` is the version that the pinned Tauri bundler downloads and checks by hash (research.md R7). Each is the version that the reference host used on 2026-09-29. A Rust `x86_64-pc-windows-msvc` probe link on the reference host selected them (research.md R6).

**Development tools that declare Node** (Constitution II): the npm registry `engines` fields on 2026-09-30 declare these Node ranges. `typescript` `7.0.2` and its native package `@typescript/typescript-win32-x64` `7.0.2`: `>=16.20.0`. `vite` `8.3.1`, `@vitejs/plugin-react` `6.1.1`, and the transitive `rolldown` `1.2.9`: `^20.19.0 || >=22.12.0`. `shadcn` `4.21.0`: `>=20.18.1`. The transitive `@tailwindcss/oxide` `4.3.3`: `>= 20`. The transitive `lightningcss` `1.32.0` and `1.33.0`: `>= 12.0.0`. `tailwindcss` `4.3.3`, `@tailwindcss/vite` `4.3.3`, `@types/react`, `@types/react-dom`, and `@types/bun` declare no `engines` field. Mitigation: every tool runs under Bun through `bunx --bun` or `bun run` (T003, T065, T123, T149). The `--bun` flag makes Bun run a package binary that has a Node shebang. No build under Bun has run yet, so Bun compatibility stays unverified until T065. None of these tools enters the product runtime. T154 confirms that the bundle holds no Node executable (research.md R9).

**Primary Dependencies**: Minimum versions, verified on 2026-09-29: React/DOM `19.3.0`; Vite `8.3.1`; React plugin `6.1.1`; Tailwind/Vite plugin `4.3.3`. UI libraries: Base UI `1.8.0`, Pierre Diffs `1.5.1`, and TanStack React Virtual `3.14.13`. Use shadcn `4.21.0` for selected Base UI components, not a second component system.

**Desktop Dependencies**: Minimum versions, verified on 2026-09-29: Tauri/API/CLI `2.12.0`; `tauri-build` `2.7.0`; native dialog `2.8.0`; Win32 bindings `windows` `0.62.0`. Declare WebView2 COM bindings `webview2-com` `0.39.1` as a direct dependency. Declare `serde` `1.0.228` and `serde_json` `1.0.145`. Tauri's lock selects these versions at the pinned revision. Wry `0.57.0` requires `^0.39`, and Tauri's lock selects `0.39.1`. Typed Rust commands own dialogs; omit the dialog JS package. Use native `cargo-tauri`, not an unverified Node-wrapper substitution. `windows` and `webview2-com` are Windows-only dependencies (`[target.'cfg(windows)'.dependencies]`).

**Contract schemas**: Minimum versions, verified on 2026-10-04. zod `4.6.5` (TypeScript, MIT) is the single contract source (contract §1 "Schemas"). Its schemas define the envelope, the payloads, the implemented results, the progress event, the handshake, and the channel frames. TypeScript types come from `z.infer`. The service bundles zod. The renderer imports only types, so zod adds no renderer code. `bun run export:schemas` writes the JSON Schema files (draft-07) to the committed folder `src/contracts/schemas/`. The Rust build dependency typify `0.8.0` (Apache-2.0) generates serde types from these files in `src-tauri/build.rs`. It reads them through schemars `0.8.22`, which the lockfile already held. The generated pattern checks use the runtime crate regress `0.12.0`. The exported path schema holds only the platform-independent rules. Each side checks native absoluteness at runtime. The service uses `src/contracts/native-path.ts`, and the shell uses `Path::is_absolute`. typify drops `const` values and integer ranges, and JSON Schema has no byte bound. So both sides keep explicit checks for these rules. zod `max`, JSON Schema `maxLength`, and typify count code points, so the UTF-16 path bound is explicit too. serde also reads a struct from a JSON array. So the shell compares the JSON shape of each typed value with its input. The golden vector files `tests/vectors/valid/*.json` and `tests/vectors/invalid/*.json` run in `bun test` and in `cargo test`. Research: the IPC decision of 2026-10-04 (research.md R10 "Dependency reviews"). A vector with a `platform` field runs only on that platform.

**Storage**: Git repositories remain authoritative. Store selected Git, last repository, and window bounds in application-owned native settings. Store recovery markers and trust approval records in application-owned native storage (contract §6 and §7). Persist theme, density, and pane proportions as bounded webview preferences. Keep snapshots, hunk approvals, and commit review tokens in the service session. Keep drafts and view hints in renderer memory; they survive a service restart. No database, event store, or durable operation queue.

**Testing**: Bun contract/parser tests and real disposable Git repositories. Add Rust tests for native ownership and framing. Qualify installed release builds through Windows interactions and process measurements. Browser tests cannot pass native gates.

**Target Platform**: Windows 11 x64. Initial qualification reference: 25H2 `10.0.26200.9457`, Git for Windows minimum `2.55.0.windows.3`, and WebView2 minimum `154.0.4258.37`. Both minimums are the versions on the reference host on 2026-09-29, which the batch verifications run. These are planned qualification points, not tested support claims. WSL repositories also need WSL2, and a systemd user manager and `setsid` in the distro. They also need Git `2.55.0` or later there (user decision, 2026-09-30). The reference host has WSL `2.7.12.0`, and its `Ubuntu-24.04` distro has Git `2.43.0` (research R13). A Linux `cargo check` and Linux Bun runs guard portability only. They make no support claim. A shell build for another platform prints an unsupported-platform message and exits with code 1.

**Project Type**: Local-first desktop application. No ordinary-workflow cloud account, AI dependency, Node runtime, or Electron runtime.

**Performance Goals**: SC-005 through SC-008 and SC-015, with fixed procedures and supplementary resource ceilings below. All figures remain unmeasured.

**Constraints**: One shell; no arbitrary renderer commands; minimum-version manifests with committed lockfiles and frozen installs; exact Bun runtime; bounded output; cancellation; external-change reconciliation. Supported hunk actions must preserve working bytes. Updater implementation remains excluded. Each later manifest or lockfile change needs a review record. Each package build records its tool versions (Tool and runtime boundaries).

**Scale/Scope**: One main workspace, a read-only graph of at most 100 checkout-reachable commits, and one selected comparison. A submodule review holds at most 256 submodules and 8 nesting levels (contract §5). Comparison sides remain at most 1 MiB, with at most 20,000 diff lines. No history search, pagination, line staging, or worktree management. Build the workbench from the selected component family; add no graph package.

### Provisional prerequisite admission

Admit Git and WebView2 from a minimum version in local qualification packages. Each minimum is the version on the reference host on 2026-09-29. No packaged run has passed yet. So each minimum stays provisional until T065 and T154 record a passing run with it. A failed run changes no minimum. It records `fail` with its cause in research.md R10, and the affected gate stays blocked. Raising a minimum to a version with a passing run needs a recorded review and repeated affected qualification. A lower minimum needs its own recorded passing run. Neither minimum is an upstream requirement or a forward-compatibility claim.

| Prerequisite | Admitted versions | Rejection |
| --- | --- | --- |
| Git | Git for Windows x64 `2.55.0.windows.3` or later. This value is the provisional reference-host version, not an upstream requirement. Compare `major.minor.patch` numerically, then the `windows.N` number. On other platforms, the service admits Git 2.55.0 or later. This makes no support claim. | Missing: `GIT_UNAVAILABLE`. A lower or unparseable version, another architecture, or an unrecognized implementation: `GIT_UNSUPPORTED`. |
| WebView2 | Windows x64 runtime `154.0.4258.37` or later. This value is the provisional reference-host version, not an upstream requirement. The admission compares with `CompareBrowserVersions`, which ignores the channel name, so a preview runtime at or above the minimum is admitted. | Missing: `WEBVIEW_UNAVAILABLE`. A lower or unparseable version: `WEBVIEW_UNSUPPORTED`. |
| Platform | Windows 11 x64 on a native AMD64 machine: `getEnvironment` reports platform scope `qualification-target`. Windows 11 needs OS build 22000 or later and product type `VER_NT_WORKSTATION` from `RtlGetVersion`. Windows Server 2025 also reports build 26100, so the product type separates it. | Not rejected. Other builds or machines report `other` and run with the "Unqualified platform" label. No error code applies. |

“Admitted” permits qualification testing. “Qualified” requires recorded passing evidence. No admitted version of either prerequisite is tested yet. The runtime `qualification` status comes from a build-time list of version sets with recorded passing evidence (data-model §1). This slice ships that list empty, so `qualification` stays `unverified`.

Git and WebView2 versions below the minimum remain unsupported by this local test package. Show the detected and minimum versions explicitly. The repository menu shows the "Unqualified platform" label beside the selected Git version when it applies. Results from unqualified platforms never count as qualification evidence. Block dependent startup or Git operations without silent substitution, download, upgrade, or downgrade.

Use deterministic admission tests for each prerequisite. A version below the minimum is rejected. The minimum and newer versions are admitted. These strings are test inputs, not claims that corresponding releases exist.

Packaged rejection tests require a separately verified installation of a Git or WebView2 version below the minimum, or a disposable image. Record its actual version and digest. Lowering a minimum requires its own recorded passing run on the reference host. It also requires a recorded dependency review and repeated affected qualification.

Keep the clean-install environment offline after prerequisite installation. On the reference host, record Git and WebView2 versions before and after each series. A version change voids that series until the series repeats with the new recorded version.

### Tool and runtime boundaries

- Run Vite explicitly under Bun. Do not rely on its Node shebang.
- Disclose Node-engine requirements in development tools (Technical Context lists each range). Do not ship those tools or Node with the product.
- Compile the Bun service for Windows x64. Disable runtime configuration autoload using the verified Bun flags.
- Launch the service from an application-owned directory. Never use a checked-out repository as its startup directory.
- Use the installed Git executable selected by the user. Do not bundle Git or alter global configuration.
- Change a contract type only in its zod schema. Then run `bun run export:schemas`, and commit the changed files in `src/contracts/schemas/`. The check `bun run export:schemas --check` fails on a stale schema file. After the first commit, `bun run export:schemas` followed by `git diff --exit-code src/contracts/schemas` gives the same check. Never edit a generated schema file or the generated Rust types by hand.
- Reuse installed build tools. The Windows SDK x64 libraries are present (research.md R6, 2026-09-29). Builds need at least MSVC toolset `14.51.36231` and Windows SDK `10.0.26100.0`. T001 and T154 record the versions that ran.
- Declare direct dependencies with minimum-version caret ranges and commit supported lockfiles during implementation. Install from the lockfiles unchanged: `bun install --frozen-lockfile` and Cargo `--locked`. Keep the Bun runtime exact. Generate the third-party notice inventory for every shipped package from the resolved Bun and Cargo lockfiles at build time. Bundle it with the package. Packaging fails when any resolved package lacks licence text in the inventory. The About window displays this inventory (FR-037).
- After T003 and T006, every dependency change needs a review record. A dependency change adds or removes a dependency, or changes its version, in `package.json` or `src-tauri/Cargo.toml`. A change to `bun.lock` or `src-tauri/Cargo.lock` is also a dependency change. A script-only `package.json` edit needs no record. The record goes into research.md R10 "Dependency reviews". It names the task and each added, removed, or changed package. It gives the old and new resolved versions, the licence, the reason, the reviewer, and the findings. It lists the qualification checks that ran again. A batch verification fails when a dependency change in its batch has no record.
- Every task that builds a package records the build tool versions that ran. These are `rustc`, `cargo`, `cargo tauri`, `bun`, the MSVC toolset, the Windows SDK, and NSIS. The pinned bundler extracts NSIS into `%LOCALAPPDATA%\tauri\NSIS` (research.md R7). Read its version there with `makensis.exe /VERSION`. Each version must be at least its Technical Context minimum.

## Constitution Check

**Pre-research gate**: PASS after the user selected Tauri-only implementation. Constitution `2.0.0` applies. Its 2026-09-29 amendments renamed the product and changed the Principle VIII dependency rules to minimum versions with committed lockfiles.

**Post-design gate**: Design resolved under the explicit checkpoint contract and approved standard Git commit policy. Constitution `2.0.0` applies. The design follows the amended Principle VIII. Real-repository and packaged proof cases remain mandatory; no runtime pass is claimed.

| Principle | Planning evidence | Post-design status |
| --- | --- | --- |
| I. Preserve User Data | Exact hunk and file staging effects, canonical Git commits, no bypasses, no rollback, explicit late effects. Update submodules refuses unreferenced submodule commits, passes no `--force`, and repairs nothing. It refuses a reused folder that holds files, because Git's own reuse checkout overwrites them. It checks each submodule again before its clone. Its review names each configuration write (contract §12). A remedy that runs Git's own update states that it skips these checks. | Design conforms to the approved policy; runtime tests remain unverified. |
| II. TypeScript/Bun and Minimal Native Code | Shared TypeScript logic; Rust only for shell, IPC, Windows process ownership, and bounded platform calls. `IsWow64Process2` reads the native machine, which the x64 service cannot observe. The WebView2 `ProcessFailed` subscription covers renderer failure, which wry does not handle. The WebView2 `AcceleratorKeyPressed` and `ContextMenuRequested` handlers block browser keys and page menu items, and Tauri exposes neither (research R7). Contract §6 adds `FileIdInfo` identity requests and recovery marker files. T140 calls `TaskDialogIndirect` for a safe close prompt (research R7). T060 uses the same call for the Git selection, trust approval, and marker dismissal confirmations. For WSL, the shell reads the distro list and the registration key. It starts the wrapper, the anchor, and the identity probe (contract §11). A Windows Job cannot own Linux processes without them. Every Git process starts without a console (contract §6 "Console and input"). Update submodules adds one native run confirmation (contract §12). Each Win32 module compiles only for Windows (`#[cfg(windows)]` in `src-tauri/src/lib.rs`). | Design conforms. Packaged runtime evidence remains unverified. |
| III. Validated Operation Boundaries | Typed operations, fresh checkpoints, owned index lock, bounds, and explicit handoff. | Design defined; no repository-wide atomicity claim. |
| IV. Real Git State Verification | Exact ordinary fixtures and separate controlled-writer assertions. | Test design defined; no tests run. |
| V. Untrusted Repositories | Fingerprint-bound persistent trust with a native confirmation; conditional mutation trust (contract §7); unsafe staging profiles refused; approved commit hooks preserved. Submodule programs need a native confirmation for each update run. Files that the update writes, and that a relative path names, enter it as unchecked. Git's transport policy stays unchanged, and Git itself never prompts on a terminal (contract §12). A native program that `sh` starts can wait on an invisible console until the deadline (contract §6). After 15 seconds without activity, the status shows a stall notice with Cancel and a terminal command. | No hook bypass or configuration change; runtime qualification remains unverified. |
| VI. Platform-Specific Evidence | Installed Windows checks and explicit unsupported platforms. WSL repository behavior needs packaged Windows evidence too (T219, T238). A Linux-only run never qualifies it. A Linux portability check is no evidence for any platform. | Unverified. No browser result counts as Windows evidence. WSL rows stay `unverified` until a distro with Git 2.55.0 or later exists. |
| VII. Accessible and Measured Interface | Keyboard, contrast, focus, density, DPI, IME, and fixed measurements, including SC-015 matched-condition targets. Every budget, metric, workload, and capture source is fixed before testing (§Measurements and budgets). | Validation defined; unverified. |
| VIII. Locked Dependencies and Shell Selection | Minimum-version manifests, committed lockfiles, frozen installs, an exact embedded Bun runtime, and immutable research citations. Matched-condition comparison methods with one capture source and equal end-frame content for both applications (§Matched-condition comparisons). Dependency reviews (research R10). | Tauri retained without superiority claims. Runtime qualification remains unverified. |
| IX. One Upstream Planning Process | Only this feature's upstream artifacts change. | Conforms. No custom planning tree or orchestration runner. |
| Architecture constraints | One Tauri shell and compiled Bun service; shared portable code. Shared TypeScript takes native path rules only from `src/contracts/native-path.ts`. A scan test and a Linux `cargo check` guard portability (T287 to T291). Service tests also run on Linux through the shell double (T292 to T297). Only Windows runs count. | Conforms to the clarified scope. |
| Production release | Signing and authenticated-update verification remain required. | BLOCKED; updater implementation is outside this slice. |

The approved decisions permit `/speckit-tasks`, followed by `/speckit-analyze`. Implementation still requires that upstream sequence and an explicit implementation request. Failing safety tests block affected changes; unexecuted tests never count as passes. The Delivery Gates require one independent review of each meaningful change. Each of the six batches therefore gets one independent review. Its verification task (T065, T090, T117, T149, T171, or T177) passes only after that review is recorded. The record goes into research.md R10 under "Batch reviews". T116 is the batch 3 review. One review per batch runs; no automatic review loop runs (Principle IX).

## Project Structure

### Documentation: this feature

```text
specs/001-desktop-qualification/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── operations.md
└── checklists/
    ├── requirements.md
    ├── ux.md
    └── qualification.md
```

`/speckit-tasks` created `tasks.md`. It holds T001 to T264. The spec records graph requirements and the approved commit clarification. Its quality checklist remains separate from implementation qualification.

### Proposed source layout: not created

```text
src/
├── frontend/
├── git-service/
└── contracts/
src-tauri/
├── src/
├── capabilities/
└── binaries/
tests/
├── contracts/
├── git/
├── windows/
└── wsl/
```

**Structure Decision**: Use one Bun-managed project and the conventional Tauri directory. Do not add workspace machinery or multiple shell packages.

The frontend owns presentation and interaction. The service owns Git semantics and validation. Contracts define bounded operations. Rust owns native windows, restricted IPC, process lifetime, native machine detection, and WebView2 failure and accelerator control.

## Architecture and interface decisions

### Frontend

#### UI direction and scope

Make the diff the main work surface. Lists identify scope; the bottom tray prepares the complete commit. Use flat panes and useful separators, not decorative cards.

Keep native Windows caption, resize, snap, and system-menu behavior. Use one persistent repository header with a menu bar (repository, View, and Help menus), and a Changes/History mode bar. History includes the bounded read-only graph. Do not add AI, search, or future-feature controls. Update submodules is the only network control (contract §12).

Application context menus are deferred in this slice (spec Clarifications, 2026-09-30). This defers the "keyboard and context-menu equivalents" item of `docs/project-brief.md` line 101 for context menus only. Every action stays reachable by a visible control and by keyboard. The built-in page menu keeps only Cut, Copy, Paste, and Select all for editable and selected text (research R7).

This section plans the interface only. Mutation eligibility follows the explicit profile, checkpoint, and outcome rules below. Show actionable refusal reasons, not internal design-blocker identifiers.

Use the selected Base UI-based shadcn family, Tailwind, and Pierre. Keep the service authoritative for comparisons and hunk identifiers. Display selection never constructs a staging patch.

Git Extensions is the primary workflow and graph reference. T3 Code is the visual-style reference. Borrow behavior and layout ideas only.

#### T3 source inspection and selective reuse

T3 revision `ed57bed8e71b2e89a9350c94bda0dacc71cd4817` supplies a reference, not a product template.

Its component configuration selects `base-mira`, TSX, no RSC, Tailwind CSS variables, and `src/index.css`. It uses zinc defaults, Lucide, and `~/` aliases. Additional coss/spell registries are not Arbareto dependencies.

Its CSS maps semantic theme roles and includes Segoe UI/Consolas fallbacks. Its 7–10px metadata tokens are too small for this plan. Runtime theme overrides mean the zinc preset is not its complete palette.

Borrow restrained surfaces, thin separators, labelled diff controls, sticky scope headers, and deliberate selection reveal. Do not copy branding, icons, theme machinery, or its Electron/server/agent architecture.

The inspected custom tab strip lacks explicit accessible-tab declarations. Use proper Base UI tabs instead. Add keyboard resizing and visible diff focus; do not copy the previously identified pointer-only splitter or removed outline.

Do not adopt Pierre Trees, Legend List, or T3's dependency patches merely to reproduce its appearance. Use native text controls for the commit message.

Sources: [component configuration](https://github.com/pingdotgg/t3code/blob/ed57bed8e71b2e89a9350c94bda0dacc71cd4817/apps/web/components.json#L1-L28), [font tokens](https://github.com/pingdotgg/t3code/blob/ed57bed8e71b2e89a9350c94bda0dacc71cd4817/apps/web/src/index.css#L155-L174), [theme roles](https://github.com/pingdotgg/t3code/blob/ed57bed8e71b2e89a9350c94bda0dacc71cd4817/apps/web/src/index.css#L1185-L1251), [custom tabs](https://github.com/pingdotgg/t3code/blob/ed57bed8e71b2e89a9350c94bda0dacc71cd4817/apps/web/src/components/RightPanelTabs.tsx#L1122-L1177), [diff controls](https://github.com/pingdotgg/t3code/blob/ed57bed8e71b2e89a9350c94bda0dacc71cd4817/apps/web/src/components/DiffPanel.tsx#L868-L910), [selection reveal](https://github.com/pingdotgg/t3code/blob/ed57bed8e71b2e89a9350c94bda0dacc71cd4817/apps/web/src/components/diffs/DiffFileTree.tsx#L132-L164). Existing licence and reuse findings remain in `research.md` R9.

#### Git Extensions reference

Git Extensions v7.2.1 (2026-08-18) is the primary workflow reference. The release tag resolves to `0aea2d6df4c120806c46f1797ba6a45f5d14b345` (`research.md` R6). Source inspection used main commit `e265607b631a7fd32b60c317ba096209fabf0135` (2026-09-27), which follows that release.

Borrow these behaviors. History works like its revision grid: a list with a graph column is the navigation surface. A repository opens in History, as Git Extensions opens on its browse window (spec Clarifications, 2026-10-01). The selected-commit inspector sits below the list, like its `CommitInfoPosition.BelowList` option. Graph rows render individually, with a lane cap and a visible limit. A lane color differs from its neighbors. Its commit workflow uses an unstaged list, a staged list, one diff, and a message box.

Its destructive resets use a separate dialog with explicit scope (`FormResetChanges`). This applies only to future destructive actions.

Avoid these patterns. Two dense toolbars crowd the main window (issue #6361, now closed). `FormCommit` opens as a modal dialog; Arbareto keeps the commit tray in the main frame. Do not keep five panes always visible (brief line 86). `Program.cs` sets `HighDpiMode.SystemAware` (issue #6409); Arbareto qualifies per-monitor scaling. Do not let a diff toolbar cover output (issue #10358).

Keyboard differences are deliberate. Git Extensions commits with Ctrl+Enter; Arbareto's Ctrl+Enter opens Review commit for the spec's safety review. Enter then commits, because Commit staged changes is the review's default button. Git Extensions uses Ctrl+1–Ctrl+4 to focus commit panes. Arbareto uses F6/Shift+F6 for panes and Ctrl+1/Ctrl+2 for modes.

Git Extensions uses GPL-3.0. Borrow behavior and layout ideas only. Do not copy or port its code.

Sources: [revision graph](https://github.com/gitextensions/gitextensions/blob/e265607b631a7fd32b60c317ba096209fabf0135/src/app/GitUI/UserControls/RevisionGrid/Graph/RevisionGraph.cs#L20), [info position](https://github.com/gitextensions/gitextensions/blob/e265607b631a7fd32b60c317ba096209fabf0135/src/app/GitCommands/Settings/AppSettings.CommitInfoPosition.cs), [commit keys](https://github.com/gitextensions/gitextensions/blob/e265607b631a7fd32b60c317ba096209fabf0135/src/app/GitUI/CommandsDialogs/FormCommit.cs#L2283-L2290), [pane keys](https://github.com/gitextensions/gitextensions/blob/e265607b631a7fd32b60c317ba096209fabf0135/src/app/GitUI/Hotkey/HotkeySettingsManager.cs#L200-L203), [modal commit](https://github.com/gitextensions/gitextensions/blob/e265607b631a7fd32b60c317ba096209fabf0135/src/app/GitUI/GitUICommands.cs#L670-L678), [DPI mode](https://github.com/gitextensions/gitextensions/blob/e265607b631a7fd32b60c317ba096209fabf0135/src/app/GitExtensions/Program.cs#L49), [licence](https://github.com/gitextensions/gitextensions/blob/e265607b631a7fd32b60c317ba096209fabf0135/LICENSE.md), [#6361](https://github.com/gitextensions/gitextensions/issues/6361), [#6409](https://github.com/gitextensions/gitextensions/issues/6409), [#10358](https://github.com/gitextensions/gitextensions/issues/10358). This is source inspection; no package installation, application run, screenshot, or rendered test occurred.

#### Two feasible layouts

**A. Diff-first workspace with a bottom commit tray.** Keep changed-file groups beside a wide diff; place complete commit preparation below both.

```text
Native Windows caption
Open repository   Repository / worktree / HEAD    View   Help   Refresh
Changes (Ctrl+1) | History (Ctrl+2)
+-----------------------+---------------------------------------------+
| Working changes       | Path and comparison scope                   |
| Unstaged / Untracked  | Previous hunk  Next hunk  Stage selected hunk|
| Conflicted if present |                                             |
|-----------------------| Selected diff                               |
| Staged (count)        |                                             |
| file rows             |                                             |
+-----------------------+---------------------------------------------+
| Complete staged scope | Commit message                              |
| count and review      |                              Review commit  |
+---------------------------------------------------------------------+
Operation and reconciliation status                         Cancel
```

**B. Three-column preparation workspace.** Keep working changes left, the diff center, and staged files plus the composer right.

```text
Open repository   Repository / worktree / HEAD           View   Refresh
Changes | History
+----------------+-------------------------------+--------------------+
| Working changes| Path and comparison scope     | Staged files       |
|                | Hunk controls                 |                    |
|                |                               |--------------------|
|                | Selected diff                 | Commit message     |
|                |                               | Review commit      |
+----------------+-------------------------------+--------------------+
Operation and reconciliation status                         Cancel
```

| Task or constraint | Layout A | Layout B |
| --- | --- | --- |
| Review a diff | Preserves a wide reading surface at common logical widths. | Good on wide windows; two sidebars reduce code width. |
| Stage one hunk | Hunk controls remain next to the comparison. | Same capability, with more horizontal context switching. |
| Inspect staged changes | Both categories remain visible in one lane. | Separate staged column is immediately visible. |
| Compose a commit | Wide multiline field and explicit full-scope review. | Narrower message field beside the diff. |
| Changes/History continuity | Reuses one frame and stores mode-specific context. | Feasible, but the preparation column changes meaning between modes. |
| Narrow/high-DPI window | Stacks the inspector below the file band. | Must move the right column below; effectively approaches A. |

**Choose A.** B remains feasible above approximately 1440 DIPs, but its extra column costs diff width. Do not implement a layout picker or a second workbench structure.

Left-align paths, labels, message text, and code. Right-align compact counts and dates where alignment aids scanning. Use whitespace and rules to distinguish regions, not shadows or repeated containers.

#### Chosen layout, sizes, and DPI

All sizes below are client-area DIPs/CSS pixels, excluding the native caption. The normal measurement workspace remains 1280×800 DIPs.

| Profile | Behavior |
| --- | --- |
| Wide: width at least 1120, height at least the wide floor | Changes lane defaults to 280 DIPs. Diff fills remaining width. Commit tray spans the bottom. |
| Narrow: width 960–1119, height at least the narrow floor | Working changes and Staged sections share a horizontal file band above the full-width diff. Commit tray remains below. |
| Constrained: every other size from 720×480 | Use the same sections in one vertically scrolling work area. The notice band is its first section, and the status area is its last section. History stacks the list and the inspector; the list keeps its own bounded scroll region, at least 220 DIPs high. Keep header, mode navigation, and operation status reachable. The comparison keeps its own bounded scroll region, at least 220 DIPs high. The work area never grows to the full diff height. Wheel and keyboard scrolling must not trap focus. F6 reaches every visible section ("Keyboard and focus"). |
| Native minimum | 720×480 DIPs. Qualify snap regions only when their client area meets this minimum. |
| Full-workbench floor | The narrow floor at 960 DIPs width: 734 DIPs high compact and 806 comfortable at 100% text ("Height budget"). Smaller supported windows use the constrained profile rather than clipped panes. |

Profile choice. Only the client size, the Windows text size, and the density choose the profile (spec Clarifications, 2026-10-01). Content never chooses it. So no notice band row, status area, stall notice, or outcome switches the profile. A longer repository path never switches it either. The floors reserve that content instead ("Height budget").

In wide Changes mode, permit a 240–400 DIP file lane while retaining at least 520 DIPs for the diff. The commit tray defaults to 168 DIPs compact and 192 DIPs comfortable.

The tray minimum is 144 DIPs compact or 160 DIPs comfortable. Limit expansion to 35% of available height, preserving a 240 DIP wide comparison pane.

In narrow mode, the file band defaults to 128 DIPs. Its minimum is the Working changes minimum below: 102 DIPs compact and 118 comfortable at 100% text. Its maximum is the larger of 160 DIPs and that minimum. Keep at least 220 DIPs for the comparison pane. Pane minima include their headers and toolbars. The hunk reason line takes its height from the diff viewport inside that minimum ("Long text"). At 100% text, the 220 DIP minimum then keeps 7 diff rows compact and 6 comfortable. At 225% text, the grown 265/270 DIP minimum keeps 2 diff rows in both densities. Each extra hunk toolbar row adds its height to the comparison pane minimum ("Hunk toolbar layout").

Section minima. A file section scrolls inside its bounds, so its minimum shows only its first content:

- Working changes: its pane heading, one subgroup heading, the help line, and one file row. That is 32+26+18+26 = 102 DIPs compact and 36+28+20+34 = 118 comfortable.
- Staged: its pane heading and one file row. That is 32+26 = 58 DIPs compact and 36+34 = 70 comfortable.
- Wide lane: Working changes, the 8 DIP divider, and Staged. That is 168 DIPs compact and 196 comfortable. The 240 DIP comparison minimum beside it is larger at 100% text.

Height budget. The fixed rows are the header rows, the mode bar, and the status bar (density table). Each horizontal splitter takes 8 DIPs. A floor is the smallest client height of a profile. It holds the fixed rows, the splitters, the section minima, and two reserves:

- The band reserve: two notice band rows of one text line each, for the blocking row and the submodule row. The recovery row is outside the reserve. Its height follows the Overflow rule.
- The area reserve: the status area minimum.

The reserves count even while the band and the area are absent. Their space is not left blank then: the sections use it. When band rows or the area appear, sections shrink toward their minima, and the profile stays. A floor counts the header rows that its items need at that width and text size ("Header layout"). The items are Open repository, the menu bar, Refresh, the HEAD and WSL badges, and the 160 DIP path minimum. The WSL badge has a fixed width ("Header layout"), so a long distro name adds no header row. So the repository content never changes a floor. Text size grows every text-holding height by the text-size rule below. With g = 0 at 100% text, and g = 22.5 compact or 25 comfortable at 225% text:

- Wide floor: fixed rows, both reserves, 1 splitter, the tray minimum, and the content row. The content row is the larger of the comparison minimum (240 + 2g) and the lane minimum.
- Narrow floor: fixed rows, both reserves, 2 splitters, the file band minimum, a 220 + 2g comparison, and the tray minimum.
- The History floor never exceeds the Changes floor: its list minimum of 240 DIPs is never above the comparison minimum. So the mode never changes the profile.

The 100% columns assume one header row from 960 DIPs width, and the 225% columns assume two. Both are estimates, and T157 records the real row count. Only three cases have an estimate: 100% text from 960 DIPs width (one row), 100% text at 720 DIPs width (two rows), and 225% text from 720 DIPs width (two rows). Every other width and text size, such as 150% text, counts two header rows and uses the constrained profile until T157 records a measured count.

| Floor | Compact, 100% text | Comfortable, 100% text | Compact, 225% text, 2 header rows | Comfortable, 225% text, 2 header rows |
| --- | ---: | ---: | ---: | ---: |
| Wide | 40+32+32+64+84+8+240+144 = 644 | 44+36+36+72+104+8+240+160 = 700 | 125+54.5+54.5+109+151.5+8+303+166.5 = 972 | 138+61+61+122+179+8+346+185 = 1100 |
| Narrow | 40+32+32+64+84+16+102+220+144 = 734 | 44+36+36+72+104+16+118+220+160 = 806 | 125+54.5+54.5+109+151.5+16+192+265+166.5 = 1134 | 138+61+61+122+179+16+218+270+185 = 1250 |

At 225% text, the lane minimum exceeds the comparison minimum. Compact Working changes takes 54.5+48.5+40.5+48.5 = 192 DIPs. With the 8 DIP divider and 103 for Staged, the compact lane takes 303 DIPs. Comfortable gives 218+8+120 = 346 DIPs. With one header row, the 225% wide floors are 909.5 and 1031 DIPs. They still exceed 800.

| Client size and text size | Compact | Comfortable |
| --- | --- | --- |
| 1280×800, 100% | 644 ≤ 800: wide. The work area below the fixed rows is 800−104 = 696 DIPs. | 700 ≤ 800: wide. 800−116 = 684 DIPs. |
| 1280×800, 225% | 972 > 800: constrained. The viewport is 800−234 = 566 DIPs. | 1100 > 800: constrained. 800−260 = 540 DIPs. |
| 960×640, 100% | Narrow floor 734 > 640: constrained. The viewport is 640−104 = 536 DIPs. | 806 > 640: constrained. 640−116 = 524 DIPs. |
| 960×640, 225% | 1134 > 640: constrained. 640−234 = 406 DIPs. | 1250 > 640: constrained. 640−260 = 380 DIPs. |
| 720×480, 100%, 2 header rows | Constrained by width. 480−144 = 336 DIPs. | Constrained by width. 480−160 = 320 DIPs. |
| 720×480, 225%, 2 header rows | Constrained by width. 480−234 = 246 DIPs. | Constrained by width. 480−260 = 220 DIPs. |

So 960×640 and 1120×640 use the constrained profile in both densities. A 960 DIP window uses the narrow profile from 734 or 806 DIPs height. A 1120 DIP window uses the wide profile from 644 or 700 DIPs height. In the constrained profile, the notice band and the status area scroll with the work area. So they take no viewport height, and the list and comparison regions keep their 220 DIP minimums. The 720×480 rows assume two header rows ("Header layout"). Their viewport holds a whole 220 DIP region at 100% text.

At 225% text, each text-holding height grows by 1.25 × its line height. With the 18/20 DIP line height, that is 22.5 DIPs compact and 25 comfortable. The comparison minimum then grows to 265 or 270 DIPs, through its heading and toolbar. A wrapped toolbar row adds 54.5 or 61 DIPs more. That region is taller than the 246 or 220 DIP viewport. The region keeps its minimum, and the work area scrolls it into view. UI-17 records this case.

Overflow. A band row can wrap beyond its one reserved text line. In every profile, the work area is the region between the mode bar and the status bar. In the wide and narrow profiles, it holds the band, the sections, the tray, and the status area. After the sections reach their minima, it scrolls vertically, and the band and the area scroll with it. The profile stays. A newly shown band row or status area notice scrolls into view in every profile. The work area never scrolls the focused control out of view for it. When both cannot show, the focused control stays visible. The status bar text still names the stall ("Required visible states", Busy). Such scrolling never moves focus.

Default sizes do not always fit. At 960×806 comfortable, the narrow floor, two notice band rows and the open area use both reserves. The file band default is 128 DIPs, and the tray default is 192. They leave 806−116−176−16−128−192 = 178 DIPs for the comparison. Layout clamps the file band and the tray toward their minima until the comparison has 220 DIPs. The file band shrinks first, and the tray shrinks only after the file band reaches its minimum. In the wide profile, only the tray shrinks, because the lane sits beside the comparison. In the constrained profile, the work area scrolls, so layout applies only the section bounds. The floor guarantees that the minima fit.

Clamp default sizes to available space before layout. Shrink resizable sections to their minima before using the scrolling of the work area. Font or control measurements can require the constrained profile even above the nominal full-workbench floor. Such a measurement depends only on the client size, the text size, and the density.

Header layout. The header holds Open repository, the repository identity, the menu bar, and "Refresh (F5)". The identity is the repository path, the "WSL: <distro>" badge when present, and HEAD with its branch.

- One header row holds every item when the path keeps at least 160 DIPs of width.
- Otherwise the header wraps into two rows. The first row holds Open repository, the menu bar, and Refresh. The second row holds the identity, left-aligned.
- A control that does not fit in the first row moves to the start of the second row, in order. Further overflow wraps into a third row the same way.
- Each header row has the header row height, grown by the text-size rule. Each extra row adds that height to the fixed rows of "Height budget".
- The path gets a middle ellipsis. It keeps the drive or root and the last folder name, and its accessible name holds the full path.
- The branch name gets a middle ellipsis only after the path reaches its minimum. Its accessible name holds the full name.
- Open repository, the menus, Refresh, and the "HEAD" text never truncate. They never shrink below their label width or move into a menu.
- The WSL badge has a fixed width of 160 DIPs, multiplied by the Windows text-size factor. It never moves into a menu. "WSL: " stays whole, and a distro name that does not fit gets an end ellipsis. The badge's accessible name holds the full "WSL: <distro>" text. The repository menu shows the full label.
- The repository menu shows the full path and the full branch name, wrapped.
- Estimate at 720 DIPs and 225% text: Open repository, the three menus, and Refresh need about 730 DIPs with gaps. So Refresh starts the second row, and the budget assumes two rows. T157 measures the real wrap. A third row stays inside the constrained rule.

Long text. Single-line text never clips without an ellipsis, and the full text stays available:

- A file-list row shows its path on one line. A long path keeps the file name whole and gets a middle ellipsis in its folder part. A file name that alone does not fit gets an end ellipsis. The option's accessible name holds the full path.
- The WSL badge keeps its fixed width and ellipsizes a long distro name ("Header layout"). Its accessible name and the repository menu hold the full name.
- A History subject stays on one row with an end ellipsis. The row's accessible name holds the full subject, and the inspector shows it wrapped.
- The comparison heading keeps the pane heading height. It shows the path, the comparison scope, the comparison sides, and a "Copy path" row button. The path gets a middle ellipsis in its folder part and keeps the file name whole. A file name that alone does not fit gets an end ellipsis. Only then do the sides get an end ellipsis, and then the scope. Copy path never truncates. The heading's accessible name holds the full path, scope, and sides. Copy path copies the full path, and Tab reaches it ("Keyboard and focus", Comparison row). No tooltip holds the path.
- The reason line below the hunk toolbar stays on one line with an end ellipsis ("Hunk toolbar layout"). It is 18 DIPs high compact and 20 comfortable, grown by the text-size rule. It takes that height from the diff viewport inside the comparison minimum ("Height budget"). So a reason never changes a pane minimum, a floor, or the profile. The disabled control that the reason explains carries the full reason as its accessible description. A refused entry also shows the full reason wrapped beside its limitation in the comparison pane. With no running operation, the status bar refusal text holds it too ("Keyboard and focus", Stage key row). No tooltip holds it.
- The History scope line stays on one line and never wraps ("History graph design"). Its counts, the "<c> conflicted, " prefix, and its Warning icons never truncate. When the line does not fit, the checkout name gets a middle ellipsis first. It shrinks until one character stays on each side of the ellipsis. Then "Up to 100 commits" gets an end ellipsis, and then the limit text. The line's accessible name holds the full text. The limit text also stays the accessible description of the History list.
- The Unstaged help line stays on one line with an end ellipsis ("Task flow and command placement"). The Unstaged listbox carries the full text as its accessible description. The comparison pane shows the full text wrapped, below the No selection hint. No tooltip holds it. At 100% text, the 77 characters need about 462 DIPs, and the default lane leaves about 256. At 225% text, they would need about five wrapped lines, or 202 DIPs.
- The status bar text stays on one line with an end ellipsis. The live region keeps the full text, and the status area shows it wrapped. A truncated status text always shows the "Show details" toggle.
- Dialog lists and the status area wrap their text instead of truncating it.
- A count of 1 takes the singular noun and verb in every text with a count. Examples are "1 file has conflicts", "1 working change, 1 staged", and "1 program". The blocking row then ends with ", with 1 conflicted file". The lingering sentence then reads "1 process that Git or a hook started still runs".

Notice band. Repository-level notices show in one band below the mode bar, in History and in Changes. The band appears with the first complete read after an open, so History shows it at once. It holds at most three rows, in this order:

1. The blocking row (FR-016). With an unfinished operation, it reads "A <merge, rebase, cherry-pick, or revert> is in progress." With conflicts, the sentence ends with ", with <n> conflicted files." instead of the period. A `sequencer-active` state reads "A cherry-pick or revert sequence is in progress." An `unknown` state reads "Arbareto cannot identify the Git operation in progress." Both take the same conflict ending. Conflicts alone read "<n> files have conflicts." The second sentence is always "Arbareto blocks changes until you finish it outside Arbareto and select Refresh (F5)."
2. The submodule row ("Required visible states", Submodule notice).
3. The recovery row ("Required visible states", Recovery statement).

- Each row shows the Warning icon and text, never color alone. A row is 32 DIPs high compact and 36 comfortable, grown by the text-size rule. Its text wraps, and the row grows.
- In the wide and narrow profiles, the band sits below the mode bar. It scrolls only during an overflow ("Height budget", Overflow). In the constrained profile, it is the first section of the scrolling work area.
- The band is one F6 stop in both modes ("Keyboard and focus"). F6 skips it while it holds no row. Its only control is Update submodules on the submodule row. The recovery row has no control.
- The band is a named region. Its visible heading "Notices" sits at its start, beside the first row, and takes no row height. The heading names the region and is the F6 focus target of the band. It takes focus only from code, so Tab never stops on it. From the heading, Tab reaches Update submodules when that row shows.
- When a band row with focus disappears, focus moves to the band heading while the band keeps a row. Otherwise focus moves to the next F6 stop. So no focus is lost (FR-005).

Status area. The status region is the status bar plus the status area above it. The status bar keeps one line: the operation or outcome text, the details toggle, and Cancel. Its text is the polite live region (`role="status"`). That text holds the complete outcome sentence, with the lingering sentence. Live text rules:

- Only four announced events add or change live text: an operation start, a new step, a stall, and the outcome. Each changes it once.
- The stall sentence is its own node inside the live element. It is added at the stall and removed at the next activity. A polite region announces additions and text changes, not removals. So the removal announces nothing.
- A percentage is no announced event. It shows as "<p>%" in a separate element after the live text, outside every live region.
- A Space refusal shows in a second polite live element of the status bar ("Keyboard and focus", Stage key row). While it shows, the outcome text stays unchanged in the first live element. It is only hidden from view and stays in the accessibility tree. When the refusal clears, its node is removed, and the outcome text shows again without a second announcement.
- A live-node change is an added node or a changed text inside a live element, between two consecutive rendered states. A removed node is no change. T260 counts these changes.

The status area holds the details:

- Each Update submodules row with its result ("Required visible states", Updating submodules).
- The output tail of a failed row as plain text, with its remedy and Copy command.
- The stall notice with its command and Copy command ("Required visible states", Busy).
- The lingering sentence of an outcome, wrapped.
- A failed commit, `HOOK_FAILED` or a commit `GIT_FAILED`: the output tail as plain text. `HOOK_FAILED` and a `GIT_FAILED` after handoff add the remedy, the contract §9 command with Copy command (Confirm row).
- A `completed-with-effects` commit: the created commit ID, the observed difference, the suggested message, and Clear message.

The area heading reads "<operation> details", such as "Update submodules details" or "Commit details". Its first content line repeats the full outcome or operation text.

- Opening: the area opens by itself when a stall notice appears. It also opens for an Update submodules outcome and for a failed or `completed-with-effects` commit. An outcome with the lingering sentence opens it too. So does every commit outcome in History while Cancel has focus (Confirm row). Opening never moves focus, except by the focus rules below and the Confirm row.
- Toggle: whenever the area has content, the status bar shows one toggle button, "Show details" or "Hide details". It carries `aria-expanded`, and pointer and keyboard both use it. The area heading holds a second "Hide details" button. Escape inside the area collapses it and moves focus to the toggle.
- Closing: collapsing keeps the content, and the toggle reopens it. The content clears when the next operation starts or another repository opens, as the outcome text does. The toggle then disappears. No timer collapses or clears the area. A stall notice that holds focus stays until focus leaves it ("Required visible states", Busy). An area that opened only for a stall notice collapses when the notice hides, unless focus is inside the area.
- Height: the area follows its content, between its minimum and its maximum. The minimum is the heading plus two file rows: 32+52 = 84 DIPs compact and 36+68 = 104 comfortable. The maximum is the smaller of two values. One is 35% of the client height. The other is the height that the profile leaves after its fixed rows, splitters, and section minima.
- Example: at 1280×800 wide without a band, the maximum is 280 DIPs compact. That is min(0.35 × 800, 800 − 104 − 8 − 240 − 144). Comfortable gives min(280, 800 − 116 − 8 − 240 − 160) = 276 DIPs.
- The wide and narrow floors reserve the minimum, so the area never changes the profile ("Height budget"). In the constrained profile, the area is the last section of the scrolling work area. Its maximum is the larger of two values: 35% of the client height and its minimum. At 720×480 and 100% text, that is 168 DIPs, and the minimum fits below it in both densities.
- At 225% text, the minimum grows to 54.5 + 2 × 48.5 = 151.5 DIPs compact and 61 + 2 × 59 = 179 DIPs comfortable. Comfortable exceeds 168 DIPs at 720×480, so the minimum wins, and the maximum is 179 DIPs. The work area scrolls the area into view, as for the comparison region.
- Opening or closing the area never overwrites remembered pane sizes. Sections shrink toward their minima while it is open, and return afterwards.
- Content: the content region is one scrolling region and one Tab stop, so keys can scroll it. Its Copy buttons follow in reading order. An output tail sits inside that region as plain text, with no nested scroll region.
- Focus: the status region is the last F6 stop, with the pane rule of "Keyboard and focus". The first F6 entry after the area opens focuses the area heading. Later entries restore the last valid target inside the region. With the area collapsed, the first entry focuses the first status bar control. A status region without text, toggle, and Cancel has no F6 stop, so F6 skips it.
- When Update submodules reaches its outcome, focus moves to the area heading. Exception: focus in an editable field stays there, so typing continues. Focus in an open dialog also stays there, and the outcome waits in the area. When that dialog closes, focus returns to its opener (spec Clarifications, 2026-10-01).

Working changes contains distinct Unstaged and Untracked subgroups with labelled counts. Show a separate Conflicted subgroup first when present. Staged remains a separate section. A path appears in every applicable category, including staged deletion with an untracked replacement.

Working changes and Staged have labelled headers and independent scroll positions. Their wide-mode divider can resize the allocation. Never collapse either section into an unlabelled zero-height region.

Use an 8 DIP splitter hit area with a thin visible rule. Add accessible separator names, orientation, bounds, and current values. Pointer capture must release after cancellation or lost capture.

History uses a full-width, row-aligned ancestry graph and a compact selected-commit inspector below. Show commit ID, subject, author, date, and parent relationships. The inspector also shows the static line "Changed files are not shown in this version." It holds no control for that line. Hide the commit composer without clearing its draft.

The commit tray (Changes) and the selected-commit inspector (History) share one bottom region and one remembered height. That region uses the tray bounds: 168/192 DIP default, 144/160 DIP minimum, and 35% maximum. The list above keeps its height when the mode changes. Keep at least 240 DIPs for the History list, as for the wide comparison pane.

The graph covers at most 100 commits reachable from the captured checkout. Label that scope explicitly. Do not add historical file inspection, branch filtering, search, pagination, node editing, or History mutation actions.

Clamp restored window bounds to the current work area before showing the window. Report an insufficient work area if no supported client size fits. Store pane sizes in logical units, not physical pixels. Constrained layouts must not overwrite remembered wide-pane proportions.

After DPI, density, or font changes, remeasure virtual rows and restore a valid scroll anchor. Do not remount the editor or replace its text selection. Reflow must never activate a hunk or commit action.

Windows text size. Interface text follows the Windows Text size setting, from 100% to 225% (FR-035, research R7 "Windows text size"). Windows scales only text there, not the whole interface, so Arbareto scales only text too:

- The shell reads `UISettings.TextScaleFactor` when it creates the window and at each `TextScaleFactorChanged` event. The value lies from 1.00 to 2.25.
- The `currentSession` result carries the factor, and each change reaches the page as a `text-scale` event (contract §2).
- The page sets the CSS variable `--text-scale` to the factor. Every UI, code, and message font size and line height multiplies by it.
- Every height that holds text grows by (factor − 1) × its line height. This covers rows, buttons, pane headings, bars, the badges, and the tray minimum. At factor 1, every metric equals the density table.
- Lane spacing, node radius, splitter hit areas, focus outlines, and spacing keep their DIP values.
- The shell leaves the WebView2 rasterization scale at the monitor scale, as pinned wry does. So the factor never scales the page twice.
- Profile thresholds stay in DIPs. Larger text makes section minima larger, so the constrained profile applies earlier, as the rule above permits. At 225% text, the 720×480 native minimum works in the constrained profile.
- Text never clips. Long single-line text follows "Long text" above and keeps its full accessible name. A text-size change is a font change for the remeasurement rule above.

#### Compact token system

Use eight base roles per theme. These values are proposals for rendered qualification, not screenshots or a completed accessibility audit.

| Role | Dark | Light | Use |
| --- | --- | --- | --- |
| Canvas | `#17181C` | `#F4F5F7` | Workspace and inactive regions. |
| Surface | `#202228` | `#FFFFFF` | Editors, menus, and dialogs. |
| Text | `#E8E9ED` | `#20242C` | Primary labels and readable content. |
| Muted text | `#ABB0BB` | `#576171` | Secondary metadata and explicit disabled reasons. |
| Divider | `#343740` | `#DDE0E6` | Decorative pane separators, section rules, and splitters at rest. |
| Control border | `#687487` | `#778294` | Inputs, buttons, focusable boundaries, and splitters on hover or drag. |
| Accent | `#8CB4F8` | `#245CB5` | Active context, focus, and the single primary review action. |
| Hover fill | `#242833` | `#EBECEF` | Neutral pointer hover on rows and buttons; differs in hue from the blue-tinted Selected row fill. |

| Semantic role | Dark text / fill | Light text / fill | Non-color cue |
| --- | --- | --- | --- |
| Added | `#8DD5A5` / `#183026` | `#17613B` / `#E9F5ED` | Plus marker and Added label. |
| Removed/error | `#F0A4AB` / `#38232B` | `#9F2636` / `#FCECEE` | Minus marker or error icon, with explicit text. |
| Warning/stale | `#E6C479` / `#332D1E` | `#765500` / `#FFF4D4` | Warning icon and actionable explanation. |
| Selected row | Text / `#2B3C54` | Text / `#DCE8FA` | The selection marker, a short Accent bar at the left edge of the row (below). Also the scope label and the accessible selected state. |
| Selected hunk | Accent bar on Surface | Accent bar on Surface | A 3 DIP left bar beside the hunk lines and the visible label "Selected hunk" in the hunk header. |

Keep action blue distinct from added/removed semantics. Do not color entire panes to indicate status. The primary accent button uses Surface as its text color.

The selected hunk shape differs from the focus outline. The focus outline surrounds the focused element on all four sides. The selected-hunk bar marks only the left edge, and its label names the state in text. Both can appear together.

The selection marker carries the selected state of a list row without the fill. It is 2 DIPs wide, and 16 DIPs high compact or 20 comfortable. It sits vertically centered at the left edge of the row, with 1 DIP corners. The Selected row fill reaches only 1.59:1 dark and 1.13:1 light against Canvas. Accent on the Selected row fill reaches 5.33:1 dark and 5.18:1 light (2026-10-01 numeric check). Every selected option draws the marker: file-list rows and History rows. Hover and focus never draw it. The marker differs from the selected-hunk bar by place and shape. The marker is a short bar on a list row. The hunk bar is 3 DIPs wide and runs beside every line of its hunk.

Controls on a Selected row fill draw no Control border. Control border on the dark Selected row is 2.36:1, below the 3:1 non-text threshold. Such a control keeps its text label and the focus outline.

Use a two-DIP focus outline with a two-DIP offset. Reserve enough space to prevent clipping. Do not remove outlines inside Pierre's shadow root.

Hover never selects, focuses, or activates, and it never carries the only copy of information. Graph cells follow the hover state of their row.

Disabled controls use Muted text and a Divider border, with no Accent; they are exempt from the 3:1 control threshold. Every disabled mutation control keeps its visible reason text. Use Base UI `focusableWhenDisabled` for these controls.

The numeric sRGB check passed 30 selected token pairs, including text on the Selected row and Hover fill. Minimum normal-text contrast was 5.06:1 (muted text on the light Selected row); control-border contrast was at least 3.36:1. The focus/accent contrast on selected fills was at least 5.18:1. Control border on the Selected row fill is outside that set, because the rule above forbids it. The selected-hunk bar (Accent on Surface) is 7.57:1 dark and 6.42:1 light, from the 2026-09-30 numeric check.

Dividers are decorative and need no 3:1 contrast. For information, divider contrast is 1.49:1 on Canvas and 1.34:1 on Surface (dark), and 1.21:1 and 1.32:1 (light). A keyboard-focused splitter shows the focus ring. Qualify splitter discoverability in the rendered accessibility review.

These calculations do not qualify syntax palettes, composited overlays, or rendered focus. T158 measures them and every token pair in installed-build captures with `tests/windows/contrast.ts` (T179). Text needs 4.5:1, and non-text parts need 3:1. Respect forced colors and reduced motion.

Motion. Four parts can animate. The first two are the Base UI dialog transitions and the menu and menu bar popups. The third is the `tw-animate-css` enter and exit classes of the shadcn components. The fourth is the status area expand and collapse. Under `prefers-reduced-motion: reduce`, none of them moves or fades. Each state change then shows at once, with no transition and no animation. The Windows setting Animation effects Off sets that media feature (MDN `prefers-reduced-motion`, Windows 11). The measurement profile sets Animation effects Off (§Matched-condition comparisons), so measured runs use the reduced state. T157 checks both settings in the installed build.

The CSS Color Adjust Level 1 forced-colors list includes `fill` and `stroke`. Chromium's user-agent sheet sets `forced-color-adjust: preserve-parent-color` on `svg`, so explicit SVG fills and strokes keep their author colors. Under `@media (forced-colors: active)`, draw lanes and nodes with system colors or `currentColor`. Selection uses Highlight and HighlightText, and the focus outline uses Highlight. The selection marker uses HighlightText on the Highlight row fill. The selected-hunk bar uses Highlight, and its label uses CanvasText. HEAD and branch badges draw their text and outline in CanvasText, and in HighlightText on a selected row. Boundary marks keep their dash and bar shapes in CanvasText. Diff lines keep plus/minus glyphs, and disabled controls use GrayText. Sources: [spec §3.1–3.2](https://www.w3.org/TR/2025/CR-css-color-adjust-1-20251216/#forced-colors-properties), [Chromium svg.css](https://github.com/chromium/chromium/blob/f77ee1168aca5bac8a0a24ab92867858321f5c12/third_party/blink/renderer/core/css/svg.css#L92-L104); source inspection only, not a WebView2 run.

Use Segoe UI Variable, Segoe UI, then system sans-serif. Use Cascadia Code, Consolas, then system monospace for diffs and object IDs. Do not download fonts or copy T3's tiny metadata scale.

| Metric | Compact | Comfortable |
| --- | ---: | ---: |
| UI text | 12 DIPs; headings 14 | 13 DIPs; headings 14 |
| Code/message text | 12 / 18 DIP line height | 13 / 20 DIP line height |
| File/history row | 26 DIPs | 34 DIPs |
| Standard button | 28 DIPs high | 36 DIPs high |
| Row button (pane headings, toolbars, status bar, mode tabs) | 24 DIPs high | 28 DIPs high |
| Pane heading | 32 DIPs high | 36 DIPs high |
| Subgroup heading (Conflicted, Unstaged, Untracked, with its count) | 26 DIPs high | 28 DIPs high |
| Unstaged help line (one line, end ellipsis) | 18 DIPs high | 20 DIPs high |
| Hunk reason line (one line, end ellipsis) | 18 DIPs high | 20 DIPs high |
| Header row (standard buttons and menu bar) | 40 DIPs high | 44 DIPs high |
| Mode bar | 32 DIPs high | 36 DIPs high |
| Notice band row | 32 DIPs high | 36 DIPs high |
| Hunk toolbar | 32 DIPs high | 36 DIPs high |
| Status bar | 32 DIPs high | 36 DIPs high |
| Status area heading; area minimum with two rows | 32; 84 DIPs | 36; 104 DIPs |

A row that holds a control is at least 8 DIPs taller than that control. This leaves room for the 2 DIP focus outline and its 2 DIP offset on both sides. A subgroup heading holds no control, but it takes focus when its list empties. So it is 8 DIPs taller than its 18/20 DIP line. The help line takes no focus, so it is one line high. Both grow by the text-size rule. Pane headings, toolbars, the mode bar, and notice band rows use the row button. So do the status area heading and the status bar. The header, the commit tray, and dialogs use the standard button. The 24 DIP row button meets the 24×24 minimum target size of WCAG 2.2 (2.5.8).

Use 4/8/12/16 DIP spacing, 4 DIP control corners, and square pane boundaries. Avoid all-caps labels and decorative monospace metadata. Keep helper prose below 80 characters where practical.

Soft-wrap the message without inserting line breaks into its value. Use unified diffs in this slice, preserving code lines with horizontal scrolling. Turn code ligatures off (`font-variant-ligatures: none`) in diffs and object IDs, so literal operators stay visible.

Default Theme to System, with explicit Light and Dark choices. Default density to Compact, with Comfortable as the option (constitution VII). Put theme, density, and Reset pane sizes in a small View menu. Use no animated page entrances or shimmering placeholders.

The repository menu exposes the selected Git path/version and Select Git. Select Git first proposes a found `git.exe` in the native Git selection confirmation (contract §3 "Git proposal"). Its buttons are Use this Git, Choose another Git, and Cancel, the default. After a Git update at the same path (`GIT_CHANGED`), that confirmation shows the old and new versions. Nothing is selected without explicit approval (FR-003). It shows the "Unqualified platform" label when it applies. It also provides Review repository trust and Revoke trust. Approval uses the issued fingerprint and explicit Approve or Cancel actions. A native confirmation then names the repository and the fingerprint, and Cancel is its default (contract §7). Approval persists across launches until Revoke trust deletes it. Never preselect approval; revocation does not silently cancel running work. The repository menu also holds Update submodules, which opens the submodule review (contract §12). The item stays focusable when disabled and shows its reason.

For a WSL repository, the repository menu shows "WSL: <distro>" and the approved distro Git path and version. Select Git stays for Git for Windows. The distro Git gets its own native confirmation (contract §11 "Git per distro"). Its buttons are Use this Git and Cancel, the default.

A small Help menu holds one item, About Arbareto. It opens the About window below. The View and repository menus stay unchanged.

#### Task flow and command placement

| Task | Required interaction |
| --- | --- |
| Review a diff | Select a category entry. The sticky header names path, scope, and comparison sides, and holds Copy path ("Long text"). When Changes first shows after an open, no entry is selected (spec Clarifications, 2026-09-30). |
| Select a hunk | Next hunk and Previous hunk select a hunk, as do Alt+Down and Alt+Up. Mark the selected hunk with its bar and label, not its fill color. With no selected hunk, Next hunk selects the anchored hunk, or else the first hunk. Previous hunk selects the anchored hunk, or else the last hunk. The anchored hunk is the hunk that a successful hunk action anchored the viewport to. At the last hunk, Next hunk is disabled with the reason "No next hunk". At the first hunk, Previous hunk is disabled with the reason "No previous hunk". A disabled direction stays focusable, and its key does nothing. |
| Stage or unstage | Show Stage selected hunk for Unstaged or Untracked text, and Unstage selected hunk only for Staged. Show Stage file for an Unstaged or Untracked entry, and Unstage file for a Staged entry. File actions also cover binary files, deletions, and staged renames (contract §4 "File staging"). Space on a focused Unstaged, Untracked, or Staged entry starts the same file action ("Keyboard and focus", Stage key row). The Unstaged heading carries one line of help: "Enter shows a file. Space stages or unstages it. The toolbar stages one hunk." The line keeps one line with an end ellipsis ("Long text"). |
| Inspect the index | Select the staged entry, even when the same path also appears unstaged. Never infer scope from filename alone. |
| Compose a commit | Keep the plain multiline message and complete staged-file count visible in the bottom tray. |
| Review and commit | Review commit opens a bounded scope dialog containing repository, HEAD, full staged list, and message preview. The button label shows its key: "Review commit (Ctrl+Enter)". The Refresh button reads "Refresh (F5)". Key hints are visible text, not tooltips, and add no control. |
| Confirm | Commit staged changes requires a separate explicit activation after review. It is the default button of the review dialog, so Enter there commits (spec Clarifications, 2026-09-30). It is never the message field's Enter behavior. Commit staged changes closes the review and moves focus to Cancel in the status bar, as Start update does. A failed commit, `HOOK_FAILED` or a commit `GIT_FAILED`, opens the "Commit details" status area with the output tail. `HOOK_FAILED` and a `GIT_FAILED` after handoff also show the remedy. The draft stays unless a `succeeded` outcome clears it. Focus at the outcome (spec Clarifications, 2026-10-01): the rule covers every commit terminal state of data-model §7. These are `succeeded`, `canceled` (`CANCELED`), `completed-with-effects`, `failed-with-effects`, and `unknown` (`STATE_UNKNOWN`). They also include `failed` and `rejected` with every contract §9 code. Examples are `HOOK_FAILED`, `GIT_FAILED`, `SIGNING_FAILED`, `DEADLINE`, `STALE_REVIEW`, `TRUST_CHANGED`, `LOCKED`, `BUSY`, `COMMIT_ENCODING_UNSUPPORTED`, and `RECOVERY_MARKER_FAILED`. In Changes, focus moves to the message field, also from Cancel. In History, focus on Cancel moves to the heading of the "Commit details" area, which the outcome opens. Other focus in History stays, and the outcome waits in the area when it opens. Focus in an open dialog stays, and the outcome waits in the area. |
| Switch modes | A repository always opens in History (spec Clarifications, 2026-10-01). Ctrl+1 or the Changes tab opens Changes, and Ctrl+2 returns. Change the content region, not the repository or checkout. Restore valid per-mode context without replaying operations. |
| Update submodules | The submodule notice or the repository menu opens the review dialog. It lists each submodule, its redacted URL, its action, and its notes. It also lists the submodule programs and any refusal. An `unchecked` program entry reads "Arbareto cannot check this file before the run." Start update is a separate explicit activation. A native Run confirmation follows when programs are listed. The status region then shows the progress and Cancel. The outcome lists each row in the status area, never in a dialog ("Status area"). |

Use explicit comparison labels:

- Staged: current commit to index; use an empty committed baseline when unborn.
- Unstaged: index to working file.
- Untracked: empty version to working file, never the ordinary unstaged index baseline.
- Conflicted: status and available index-stage metadata only; no ordinary two-sided hunk workflow.

Hunk controls live outside deprecated Pierre separator callbacks. Map them to service-issued hunk IDs. Keep them disabled for unsupported, conflicted, incomplete, stale, expired, busy, or safety-blocked state. Also keep them disabled when reads need trust approval, or the trust fingerprint changed.

File controls map to the file-action decision of the selected comparison. Keep them disabled with the visible reason for refused, conflicted, incomplete, stale, expired, busy, or safety-blocked state. Apply the same trust rule as hunk controls. A successful file action refreshes both categories, and the entry leaves its category. After a toolbar button or Space, focus and selection move to the next entry of that list (Stage key row). Without a next entry, they move to the previous entry, then to the category heading. The new entry shows its comparison, as on Enter (spec Clarifications, 2026-10-01). Git Extensions also selects the next file and shows its diff after "Stage" (§Matched-condition comparisons). C10 ends at that comparison. The status region shows "File staged" or "File unstaged".

Limitation text: the reason line, the comparison pane, and the accessible description show one sentence for each data-model §5 "Support decision" reason. They never show the raw reason value. A file-action refusal with the same reason shows the same sentence. `blob-proof` keeps its contract §4 text.
- `binary`: "Git reports binary content in this file."
- `encoding`: "This file is not valid UTF-8 text, or Git converts its encoding."
- `size`: "This file is larger than the Arbareto size limit."
- `rename`: "This change is a rename."
- `mode`: "This change alters the file mode."
- `type`: "This change alters the file type, or the path is not a regular file."
- `symlink`: "This entry is a symbolic link."
- `submodule`: "This entry is a submodule or a nested repository."
- `LFS`: "Git LFS manages this file."
- `filter`: "A Git filter applies to this file."
- `state`: "This file has conflicts."
- `line-endings`: "This file has mixed line endings, or only the index holds its line-ending attributes."
- `index-flag`: "This entry is intent-to-add, assume-unchanged, or skip-worktree."
- `path`: "Arbareto cannot match this path to exactly one file."

A Stage file `GIT_FAILED` shows the contract §9 `outputTail` below the toolbar. It is plain text in a bounded, scrollable, read-only region, as for a failed commit. The `add` remedy command and Copy command follow it (contract §4 "Limitation remedies").

Hunk toolbar layout. The toolbar holds Previous hunk, Next hunk, the hunk action, and the file action, in that order. One component owns the toolbar container, its wrap rule, and its reason line (T145). The file action renders into a file-action slot of that container (T202). When they do not fit in one row, the toolbar wraps. The file action moves to a second row first, left-aligned, and then the hunk action. Buttons keep their full text labels. They never shrink below their label width, truncate, or move into a menu. Each extra row adds one toolbar row of 32/36 DIPs, grown by the text-size rule. That height adds to the 220 DIP comparison pane minimum, and the constrained profile scroll absorbs it. A disabled file action shows its reason text on its own line below the buttons. That reason line follows "Long text": one line with an end ellipsis, and no added pane height.

A successful hunk action refreshes both categories and the comparison. Clear the old hunk selection. Do not automatically select another hunk or change comparison scope. Anchor the viewport to the surviving hunk with the same ordinal, or to the last hunk when fewer remain. Anchoring does not select that hunk and shows no notice. The status region shows "Hunk staged" or "Hunk unstaged" ("Required visible states", Succeeded).

Commit review includes externally staged binary or otherwise unsupported files as explicit metadata. Do not imply that an unpreviewed file is absent from the commit.

Review states: “Git will run approved hooks. They or other Git tools can change the result during execution.” Keep this disclosure beside the explicit Commit staged changes action, not behind a tooltip.

Commit failure retains the message and shows the actual outcome. Bind each submission to its worktree, draft revision, and submitted text in renderer state.

A reconciled `succeeded` outcome clears only that unchanged submitted draft. Preserve later edits and other worktrees' drafts, including completion while History is visible. These UI fields do not change the public commit payload. Explicit user clearing remains available through Clear message, also beside a `completed-with-effects` result. Cancellation never claims rollback.

A failed commit shows the contract §9 `outputTail` as plain text. It holds the last 100 lines, at most 16 KiB, of Git and hook stderr. The service removes control sequences and redacts URL user information, and no log receives it. `HOOK_FAILED` and a `GIT_FAILED` after handoff also show the contract §9 remedy command with Copy command. The command runs only the pre-commit hook in a terminal and never starts a commit.

Do not display Discard, Reset, force operations, or automatic repair in this slice. Future destructive actions belong in a separate labelled menu with explicit scope confirmation.

#### About window

About Arbareto opens an in-app modal dialog, not a second native window. Use Base UI dialog and tab semantics. The tabs are Overview, License, and Third-party notices.

| Tab | Content |
| --- | --- |
| Overview | Product name, version, build identity, and the "Unsigned local test package" and "Unqualified platform" labels when they apply. The static line "This test build covers opening repositories, status, diffs, hunk and file staging, local commits, submodule updates, and one history page." The copyright notice and the attribution "Arbareto by Ihor Lifanov". The no-warranty sentence and the permission to convey under the license. The licence name, AGPL-3.0-or-later, with a pointer to the License tab. The Corresponding Source location: the repository `https://github.com/auric/arbareto` and the commit of this build. A build from a dirty tree shows the `-dirty` marker. |
| License | The full AGPL text and the NOTICE.md additional terms. Show them in a read-only, selectable, scrollable region with the code font. |
| Third-party notices | Packages grouped by licence name, with full licence text from the bundled inventory. |

The build embeds the notice texts, the source repository location, and the build identity. The source location is `package.json` `repository.url`, `https://github.com/auric/arbareto`. The repository stays private until version 1 (research.md R7). Anonymous access to the build commit is a B-RELEASE condition. The build identity is the full commit ID from `git rev-parse HEAD`. It gets the suffix `-dirty` when `git --no-optional-locks status --porcelain --untracked-files=all` prints any line. This follows the style of `git describe --always --dirty`, but it also counts untracked files. The explicit option overrides a user `status.showUntrackedFiles` value. The About window and the boot view show the `-dirty` marker. The qualification package build (T154) refuses a dirty tree. So does each batch verification that builds a package. The one exception is the T171 control build. It is dirty by design, shows `-dirty`, and never counts as evidence. Initial focus goes to the dialog heading. Escape closes the dialog, and focus returns to the Help menu button.

The default size is 560×480 DIPs, and "Dialog sizes" below sets the clamp and the scroll region. The constrained profile keeps every tab and its content reachable. Opening the dialog starts no network request, update check, or Git operation. Use no logo art or splash screen; text comes first. The executable resource icon is exempt from this rule. The pinned `tauri-build` needs it (T008), and it is a solid-color placeholder without logo art.

#### Dialog sizes

Every in-app dialog follows one size rule:

| Dialog | Default size | Scrolling content region |
| --- | --- | --- |
| Review commit | 640×560 DIPs | Repository and HEAD lines, the staged list, and the message preview. |
| Trust required or changed | 560×440 DIPs | Policy summary and the persistence explanation. |
| Update submodules | 800×600 DIPs | Submodule list, program list, notes, and refusal texts. |
| About Arbareto | 560×480 DIPs | The active tab panel. |

- Each dialog clamps to the main window client area minus 16 DIPs on each side. So at 720×480 it is at most 688×448 DIPs.
- The heading row stays at the top, and the button row stays at the bottom. Only the content region between them scrolls. So every button stays visible at each size, density, display scale, and text size.
- The review disclosure text sits in the button row, beside Commit staged changes. It wraps above the buttons when the row is too narrow.
- A content region without a focusable child is one Tab stop, so the keyboard can scroll it. A list inside the region keeps its own roving focus.
- Wheel and keyboard scrolling stay inside the region, and the page behind never scrolls.
- The dialog remeasures after a DPI, density, or text-size change and keeps the focused control.

#### Keyboard and focus

| Context | Keyboard behavior |
| --- | --- |
| General controls | Tab/Shift+Tab reaches every action; Enter/Space activates the focused button. |
| Mode tabs | Base UI tab semantics; arrows and Home/End navigate Changes/History. Ctrl+1/Ctrl+2 selects a mode outside editable input. The tab labels show the keys as visible text: "Changes (Ctrl+1)" and "History (Ctrl+2)". |
| Pane navigation | F6 moves forward and Shift+F6 backward through the visible sections, then wraps. Changes stops: header, mode tabs, notice band, Working changes, Staged, comparison, composer, status region. History stops: header, mode tabs, notice band, History list, inspector, status region. The narrow and constrained profiles keep the same order. F6 skips a hidden or collapsed section, a notice band without rows, and an empty status region ("Status area"). The band stop focuses the band heading "Notices" ("Notice band"). Restore each section's last valid focus target. After the status area opens, the first F6 entry into the status region focuses the area heading ("Status area"). Later entries restore the last valid target inside the region. |
| File/history list | Arrows, Home/End, and Page keys navigate; Enter selects the focused entry. Reveal only deliberate navigation, not every refresh. |
| Stage key (Space) | Space acts in the Conflicted, Unstaged, Untracked, and Staged lists (spec Clarifications, 2026-10-01). It starts Stage file in Unstaged and Untracked, and Unstage file in Staged. In Conflicted, it shows the refusal of the file action. An unselected entry first becomes selected, and its comparison is read, as on Enter. The action then uses that comparison's file-action decision and every FR-038 check. That read fixes the bytes that the stale check binds, so Space stages the current file bytes, as `git add` does. A shown comparison binds the bytes that it showed, and a change after the display gives `STALE_SELECTION`. A focus or selection change before the comparison arrives cancels the pending Space action, and nothing is sent. A selected entry whose comparison read is still pending follows the same rule. Space then waits for that comparison and binds to its bytes, and no second read starts. This covers a second Space on the next entry while its comparison loads. After `succeeded`, focus and selection move to the next entry of that list. Without a next entry, they move to the previous entry, then to the category heading. The newly selected entry shows its comparison, as on Enter. A refused entry changes nothing and keeps focus. A Conflicted entry is a refused entry. The reason line below the hunk toolbar shows the reason with the Warning icon. With no running operation, the status bar shows "<Stage file or Unstage file> is unavailable: <reason>" with the icon. That text sits in the second live element of the status bar ("Status area", live text rules). It clears when focus or selection changes or an operation starts. The previous outcome text then shows again without a second announcement. While an operation runs, the status bar keeps its operation and stall texts. Only the reason line then shows the refusal. A failed action keeps focus and selection on the entry. Space does nothing in the History list, in an editable field, or during IME composition. It also does nothing while a dialog or a menu is open. Space with a modifier key, or with `repeat` true, does nothing. While a file action runs, Space sends nothing. The reason line then shows "A file action is running. Wait for its result." as text. That busy reason never enters the live text. It clears when the action ends, or when focus or selection changes. |
| Comparison | Previous hunk and Next hunk buttons select a hunk. Alt+Up and Alt+Down do the same anywhere in the comparison pane, its header and hunk toolbar included. The header holds the Copy path row button, and Tab reaches it before Previous hunk ("Long text"). Without a selected hunk, and at the first or last hunk, they follow the "Select a hunk" task row. No global single-letter mutation shortcuts. |
| Modal state | These keys do nothing while a modal dialog or a menu is open: F5, Ctrl+1, and Ctrl+2. The same holds for F6, Shift+F6, Alt+Up, and Alt+Down. The dialog or menu keeps its own keys, such as Tab, Escape, and the arrow keys. |
| File actions | Stage file and Unstage file are buttons in the hunk toolbar, after the hunk buttons. Tab reaches them, and Enter or Space activates them. They have no global shortcut key. Space on a file-list entry starts the same action (Stage key row). After success, a button moves focus and selection to the next entry, as Space does (Stage key row). Focus then leaves the toolbar for that list entry. |
| Splitter | Arrow keys resize by 8 DIPs; Shift+Arrow uses 32 DIPs. Home/End selects documented bounds. |
| Message | Enter inserts a newline. Ctrl+Enter opens Review commit only when valid; it never commits directly. Navigation keys always work in the field: Tab, Shift+Tab, F6, Shift+F6, F10, and a lone Alt press. F5 also works there: it requests the bounded refresh and keeps the draft and the caret. Native text keys keep their behavior, and Shift+F10 opens the built-in text menu. The field ignores the other action shortcuts: Ctrl+1, Ctrl+2, Alt+Up, and Alt+Down. During IME composition, every key of this row goes to the IME. |
| Dialog | Trap focus with Base UI semantics. Escape cancels; return focus to the opener or the nearest surviving logical control. |
| Review dialog | Tab order: heading, staged list, message preview, Cancel, Commit staged changes. Initial focus goes to Commit staged changes, which is the default button. Enter activates the focused button, so Enter commits on open. Escape cancels. Ctrl+Enter inside the dialog does nothing. The Ctrl+Enter that opened the dialog never commits. An Enter keydown with `repeat` true does nothing. So does one that began before the dialog opened. Commit staged changes closes the dialog and moves focus to Cancel in the status bar, as Start update does. At the outcome, focus follows the Confirm row of "Task flow and command placement". |
| Submodule review dialog | Initial focus goes to the dialog heading, never to Start update. Tab order: heading, submodule list, program list, Cancel, Start update. The dialog has no default button, so Enter activates only the focused button. Each list is one listbox with roving focus. Each Copy command and Copy path button follows its list. Escape cancels and returns focus to the opener. Start update closes the dialog and moves focus to Cancel in the status bar. The native Run confirmation then opens when programs are listed, and Run keeps focus on Cancel. A declined Run confirmation ends the operation `canceled`, and the review token stays consumed (contract §12 "Update protocol" step 3). Focus then returns to the opener: Update submodules in the notice band, or the repository menu button. Without the opener, focus goes to the nearest surviving logical control. At the outcome, focus follows the "Status area" focus rule. |
| Trust dialog | Initial focus goes to the dialog heading, never to Approve. Tab order: heading, policy text, Cancel, Approve. The dialog has no default button, so Enter activates only the focused button. Escape cancels and returns focus to the opener or the nearest surviving logical control. A declined native confirmation returns focus to Approve and stores nothing. After an approval, focus returns to the opener or the nearest surviving logical control. |
| Status area | The details toggle in the status bar opens and collapses the area with Enter, Space, or a click. Escape inside the area collapses it and moves focus to the toggle. The content region is one Tab stop and scrolls with arrow, Page, Home, and End keys. Its Copy buttons follow in reading order, then "Hide details". |
| Refresh | The labelled Refresh button and F5 request a bounded workspace refresh, never a webview reload. In History, F5 requests `readWorkspace` with `refresh: true` and `readHistory` together. |
| Menu bar | The header menus form one WAI-ARIA menubar: repository, View, and Help. Tab reaches the menu bar once. F10, or Alt pressed and released alone, focuses its first menu. Left and Right move between menus, and Down or Enter opens one. Escape closes an open menu, then returns focus to the control that had it before the menu bar. Alt with AltGraph state or with another key never moves focus. |
| Right-click and Shift+F10 | No application context menu exists in this slice. Editable and selected text keep the built-in Cut, Copy, Paste, and Select all items. Elsewhere, nothing opens. |
| Unavailable control | Previous hunk, Next hunk, Stage selected hunk, Unstage selected hunk, Stage file, and Unstage file stay focusable when disabled. Review commit, Commit staged changes, Update submodules, and Start update also stay focusable when disabled. Activation does nothing. The visible reason is the accessible description. |

Mode selection keeps focus on the active mode tab. Restore the remembered pane target when the user enters that pane. Hidden panes must not receive focus.

Suppress action shortcuts during IME composition and repeated activation. Preserve native clipboard, text selection, undo, AltGraph, system-menu, and window-close behavior. The shell creates the main window hidden. One `with_webview` call attaches the WebView2 `AcceleratorKeyPressed` and `ContextMenuRequested` handlers. Its closure shows the window after both handlers exist, because the call only queues the closure (research R7). The accelerator handler sets `IsBrowserAcceleratorKeyEnabled` to false for every key. It never sets `Handled`, so F5 and Escape reach the page. Reload, find, print, zoom, history navigation, caret browsing, downloads, and developer tools then do nothing. A setting change after the first navigation would not protect the loaded page, so the handler is the protection. Keep Tauri's default `zoomHotkeysEnabled: false`, so page zoom stays at 100%. Release builds omit developer tools.

Roles. Each file category (Conflicted, Unstaged, Untracked, Staged) is one WAI-ARIA listbox of options, named by its heading and count. Each listbox is one Tab stop with roving focus. Arrow keys move focus, and Enter selects. The History list is one listbox. Each option's accessible name holds the full row text. It starts with the HEAD and branch labels when present. Then come the subject, short ID, author, date, parent count, and boundary label. History rows hold no interactive child; parent actions live in the inspector. The inspector is a region named "Selected commit" by its visible heading. That name differs from the "Commit details" status area heading. `aria-selected="true"` marks only the selected option, never the focused one. Focus shows through the focus outline.

Initially focus Commit staged changes in the commit review, the default button (spec Clarifications, 2026-09-30). Commit is not destructive, so the destructive-action rules do not apply. Opening the dialog must not also activate confirmation ("Review dialog" row above). After rejection, return to the message field or offending review state without deleting text. Every commit outcome follows the Confirm row of "Task flow and command placement". So focus never stays on a Cancel button that the outcome removes.

Keep focused virtual rows mounted or use a persistent active-item focus container. Do not use recycled row indexes as identity. Pierre's virtualization owns diff rows; TanStack only handles large change lists.

A 100-entry History page can use ordinary rows unless measurement shows a need. Virtualization does not remove parsing, memory, or line-count limits.

When an action removes the selected entry, focus a surviving list control or category heading. Space and the file buttons use the Stage key row order: next entry, previous entry, then heading. They also select that entry. Other removals, such as a hunk action or an external change, use the same order for focus only. Do not silently switch to the opposite category. Announce the outcome once through an appropriate live region. This slice does not verify the announcement.

#### Selection, scroll, and stored context

Maintain view context by validated worktree identity and mode. Keep the Changes category/entry, History commit ID, message value/caret, pane scroll anchors, and last logical focus target.

Keep category-specific selections for Staged, Unstaged, Untracked, and Conflicted entries. The same path must not merge their identities. Restore the active category explicitly. Selection tokens remain service-owned and can expire while another mode is visible.

On mode return, restore context only if its identity and snapshot remain valid. Revalidate first when state changed. Preserve the draft and safe view hints, but never restore an obsolete hunk approval.

Keep list scroll anchors by stable entry/commit ID plus offset. If an anchor disappears, use a nearby surviving row and announce the change. That row is the surviving row nearest to the anchor position in the previous list, with offset 0. At equal distance, the row below the anchor wins. This slice does not verify the announcement. Do not repeatedly auto-scroll background refreshes to selection.

Preserve diff scroll only while its canonical comparison remains unchanged. When an external change alters the content, clear hunk selection and reset the comparison viewport with an explicit notice. The notice text is "The file changed outside Arbareto. The view shows the new version." After the application's own successful hunk action, anchor to the nearest surviving hunk ordinal instead ("Task flow and command placement"). That anchor selects nothing and shows no notice.

When a hunk approval expires or becomes invalid, request the comparison again automatically. Keep the hunk selection only when the new comparison has a hunk with the same canonical digest (contract §8). A stat-only index rewrite by another Git tool still invalidates the approval, and this request restores it.

Theme, density, and pane changes must preserve the valid selection and editor caret. Recalculate scroll geometry without inventing a new staging selection. A theme or density change from the View menu at run time keeps the draft and its caret. It also keeps the selected entry and the selected hunk. After the menu closes, focus returns to the control that had it before the menu bar. The change sends no Git request and remounts no pane. T263 tests this, and T157 checks it in the installed build.

Persist scalar theme, density, and pane preferences in application-owned webview storage. A repository always opens in History (FR-034), so no mode preference exists. The page sends `readHistory` beside the first full read ("Cold-start critical path"). Keep native window bounds and selected Git in native settings. Keep view hints in renderer memory; they survive a service restart. Keep hunk approvals and commit review tokens in the service session. Trust approvals persist in native storage (contract §7).

Stored drafts (FR-034, spec Clarifications 2026-09-30). The page keeps each draft in renderer memory and stores a copy in application-owned webview storage:

- The store is one IndexedDB object store of the page origin. Its key is the contract §3 `worktreeKey`. So a WSL worktree gets one key under both path prefixes.
- A record holds the key, the message text, the draft revision, and the write time. The text keeps the contract §5 bound: 64 KiB of UTF-8 without NUL.
- The store holds at most 256 records. A write for a new key above 256 deletes the record with the oldest write time.
- Each draft edit starts one `readwrite` transaction with durability `strict`. That hint asks the engine to flush the operating system buffers before `complete` (research R9 "Stored drafts"). T163 checks the result after Restart Arbareto. While a write runs, later edits wait, and the next write carries the latest text. So at most the edits of one running write can be lost.
- A transaction replaces the whole record, so no reader sees a partial record.
- No log, diagnostic, trace, or telemetry receives draft text.
- At page load, after each `restoreWorkspace` or registration result, the page reads the record of that key. It fills the memory draft and puts the caret at the end. A memory draft that already exists wins.
- A reconciled `succeeded` commit deletes the record only when it still holds the submitted revision. Clear message deletes the record.
- A failed read or write keeps the memory draft. The composer then shows "The draft could not be saved. It stays until Arbareto closes."
- Two instances that edit one worktree share the store, and the last write wins. A service restart does not touch the store.

#### History graph design

Keep the commit list as the navigation surface. The ancestry column explains relationships; it is not a draggable diagram or branch-management surface.

| History layout | Benefit | Cost and decision |
| --- | --- | --- |
| Row-aligned lanes with a bottom inspector | One scrolling surface, compact metadata, stable keyboard selection, and direct Changes/History continuity. Matches Git Extensions' commit-info-below-list option. | Choose this layout. |
| Free-positioned graph with a side inspector | Useful for spatial exploration of small diagrams. | Reject for this slice: pan/zoom and scattered labels reduce revision-scanning efficiency. |

```text
Changes (Ctrl+1) | History (Ctrl+2)
Current checkout: main / HEAD  Up to 100 commits  21 working changes, 11 staged  Refresh
+------------+--------------------------------------+-----------------+
| Ancestry   | Subject                              | Author Date ID  |
|   o        | [HEAD] [main] Current change         |                 |
|   |\       | Merge                                |                 |
|   | o      | Side-line change                     |                 |
|   o |      | Earlier change                       |                 |
|   |/       |                                      |                 |
|   o        | Common parent                        |                 |
|   :        | Outside loaded page                  |                 |
+------------+--------------------------------------+-----------------+
| Selected commit: subject, full ID, author/date, ordered parent IDs   |
+--------------------------------------------------------------------+
```

The sketch shows relationships, not a fabricated application screenshot. Real rows use Git-supplied IDs and parent links.

**Component choice:** build the workbench's own History rows with Base UI controls, tokens, and focus behavior. Each row draws its own ancestry cell with native SVG. See `research.md` R12 for the full candidate table, including mermaid.

Source inspection compared `@tomplum/react-git-log@3.5.1`, `@gitgraph/react@1.6.0`, and `@dolthub/gitgraph-react@1.6.4`. The closest candidate lacks controlled selected-OID state and faithful per-parent continuation at some partial merges. Its 40px geometry also conflicts with the selected density tokens. The older packages have first/second-parent and maintenance limitations. The re-evaluation also rejected mermaid gitGraph and `commit-graph`. It took VS Code's MIT per-row model and SourceGit as references. See `research.md` R12 for pins and evidence.

Do not fork a package, add a general graph editor, or reconstruct fictional branches to satisfy a component API. This decision reuses the workbench rather than importing another styling, selection, or layout system.

**Data and rendering rules:**

- Use the service's child-before-parent order. Never resort rows by displayed dates or component-specific branch guesses.
- Position nodes at row centers using the same 26/34 DIP height token as their metadata rows.
- Each History row renders its own ancestry cell from its input and output lanes. The cell uses the shared row height. Rows and cells share one scroll container. 100 rows need no virtualization layer; later virtualization reuses the cells.
- Set the graph column width to the page's maximum concurrent lanes × lane spacing, plus side padding. Cap it at 24 lanes.
- Assign lanes to pending parent OIDs. Reuse an existing parent lane; allocate a free lane only when necessary.
- Draw every ordered parent edge, including octopus merges. Colors identify visual paths, not permanent branch ownership.
- Reserve the node lane for its first parent when available. Release completed lanes deterministically without moving unrelated pending ancestry.
- Mark each distinct outside-page parent with an open continuation and an accessible parent entry. Never turn it into a root. The continuation is a dashed 2 DIP line in the lane color. It runs from the node to the bottom edge of the cell. Its dashes and gaps are 3 DIPs long. Its text is "Outside loaded page" in the row's accessible name and in the inspector parent list.
- Mark shallow boundaries separately. An unavailable parent is not a proven root; missing objects must not trigger a fetch. The shallow mark is a solid 6 DIP stub below the node. The stub ends in two 8 DIP horizontal bars, 2 DIPs apart. Its text is "Shallow history boundary" in the row's accessible name and in the inspector parent list.
- A true root commit ends its lane at the node, with no downward edge or continuation mark. Its accessible text says Root commit.
- A row without parents is a root when its `shallow` field is false (contract §3 "HistoryPage result"). It is the shallow boundary when its `shallow` field is true. Only the row's `shallow` field decides. The renderer never deduces it from `boundaries.shallow` or from the count of rows without parents.
- So the three ends differ by shape: no line, a dashed line, or a stub with two bars. Each also has its own text, so none relies on color.
- Bound layout to 24 concurrent lanes and 4,096 path segments. On overflow, keep rows and parent metadata with Graph layout limited. The whole page then switches to node-only cells. Each cell draws its node in one lane, hollow for a merge, and no edge or boundary mark. The column narrows to one lane. Node-only cells never imply ancestry.
- A layout limit ends the scope line with the Warning icon and a text. The text is "Graph layout limited: more than 24 lanes" or "Graph layout limited: more than 4,096 segments". The History list takes that text as its accessible description. Rows, accessible parent text, and the inspector parent list stay complete.
- A graph-only layout limit does not invalidate an otherwise complete status or commit review.

Use 12 DIP lane spacing compact and 14 DIPs comfortable, with 12 DIP side padding. Use two-DIP paths and restrained round joins. Draw normal nodes at three-DIP radius. The graph cell holds no label. A merge node is hollow at the same radius: a lane-colored stroke with a Canvas or Surface fill. Selection adds a separate Accent outer ring 3 DIPs outside any selected node; a selected merge node shows both.

Give each new lane a color that differs from its left neighbor, right neighbor, and originating lane. Four colors always satisfy this rule. Git Extensions uses the same behavior.

| Lane role | Dark | Light |
| --- | --- | --- |
| Teal | `#4BB9B2` | `#06726E` |
| Sky | `#80D2F0` | `#00516B` |
| Violet | `#B59AE7` | `#724AAB` |
| Magenta | `#F7A6DF` | `#993582` |

These decorative lane colors stay at least 30° in OKLCH hue from Accent, Added, Removed/error, and Warning. The smallest gap is 31.3° (light Sky to Accent). Every lane pair in one theme has an OKLab distance of at least 0.10. The near pairs teal/sky and violet/magenta differ in lightness to meet it. The minimum distance is 0.101 (light Violet to Magenta). Lane colors are supplementary; lane position and accessible parent text carry identity. All 24 stroke/background pairs, against Canvas, Surface, and Selected row, exceed 3:1 numerically; the minimum is 4.66:1. The 2026-09-30 numeric check computed these values. Rendered contrast remains unverified.

**Interaction and responsive behavior:**

- A click selects the same commit row and inspector. Double-click never checks out a commit or changes a reference.
- Keep `selectedOid` controlled by workspace state. Use Up/Down, Home/End, and Page keys; Enter selects the focused row.
- SVG nodes have no separate tab stops. Expose commit identity, merge-parent count, and ordered parent relationships through accessible text.
- An inspector parent action selects that OID only when it exists in the loaded page. Otherwise show Outside loaded page without navigation.
- Use the existing focus ring, not lane color, for keyboard focus. Keep selection distinct from current HEAD.
- Show HEAD and its current branch only from the captured checkout identity. Do not imply other branch labels were discovered. Put the labels at the start of the subject cell, as Git Extensions places ref labels. Draw "HEAD" and the branch name as outline badges with Accent text. A badge has a 1 DIP Accent outline, 4 DIP corners, and 4 DIP side padding. A badge is 18 DIPs high compact and 20 comfortable, grown by the text-size rule. An 8 DIP gap separates the last badge from the subject. The outline is the shape cue, so a badge never differs from the subject by color alone. Accent reaches 8.45:1 dark and 5.88:1 light on Canvas (2026-10-01 numeric check). On the Selected row fill, it reaches at least 5.18:1. A detached HEAD shows only the "HEAD" badge. The row's accessible name starts with "HEAD, branch <name>" or "HEAD, detached". The badges never widen the graph column, and the width formula above excludes them.
- The scope line shows the change counts of the latest complete read: "<n> working changes, <m> staged". The first number counts the Unstaged and Untracked entries. The second counts the Staged entries. With conflicts, the line starts with "<c> conflicted, " and the Warning icon, and <c> counts the Conflicted entries. Before a complete read, the line shows the Loading placeholder instead (FR-034).
- Keep subjects on one row, with the "Long text" ellipsis. Move author/date columns into the inspector at narrow widths; retain accessible metadata for each row.
- A short ID is the first 12 hex digits of the full object ID, as in the remedy texts. Rows and the inspector show the author time in the local time zone through `Intl.DateTimeFormat` with the system locale, as date and time to the minute. The inspector also shows the full time in ISO 8601 UTC.
- A row with a non-null `encoding` or a true `invalidUtf8` (contract §3) shows an encoding label. The service decodes the subject and the author as UTF-8 and never converts from the declared encoding. Bytes that are not valid UTF-8 show as U+FFFD replacement characters. With a non-null `encoding`, the row shows the encoding name, and the row's accessible name includes "Declared encoding: <encoding>". The inspector then shows "Declared encoding: <encoding>. Arbareto shows the subject and the author as UTF-8 without conversion. Bytes that are not valid UTF-8 show as replacement characters." With a true `invalidUtf8`, the row also shows the badge "Invalid UTF-8". The row's accessible name ends with "Some bytes of this commit are not valid UTF-8 and show as replacement characters." The inspector shows the same sentence, after the declared encoding text when `encoding` is not null. Only the `encoding` and `invalidUtf8` fields set the label. The renderer never scans the subject text.
- At 720 DIPs, 24 comfortable lanes leave room for the subject and short ID. Clamp pane sizes without clipping actions.
- Preserve selected OID and scroll anchor across refresh when still loaded. Otherwise explain that the prior selection left the page.
- New commits do not auto-scroll a user away from their reading position. Refresh updates the page and announces changed scope. This slice does not verify the announcement.
- Density, theme, and DPI changes recompute geometry without remounting the message editor or authorizing any Git operation.
- Use no force simulation, node dragging, zoom toolbar, animated edge entrances, or extra history filters.

#### Required visible states

| State | Presentation and behavior |
| --- | --- |
| No repository | Plain Open repository action; no dashboard, clone button, or invented sample changes. One static line: "This test build covers opening repositories, status, diffs, hunk and file staging, local commits, submodule updates, and one history page." |
| Repository refused | Name the refusal reason and show a copyable remedy. Keep the current workspace unchanged. Offer Open repository, and never offer repair, configuration changes, or lock removal. A discovery `REPOSITORY_UNAVAILABLE` shows the selected folder, the remedy "Run `git status` in this folder", and Git's output tail as plain text, without Copy command (contract §6 "Registration bootstrap"). WSL refusals show the contract §9 texts for `WSL_UNAVAILABLE`. Its reasons are `wsl-missing`, `distro-missing`, `not-wsl2`, `no-user-manager`, `no-setsid`, `no-coreutils`, and `start-failed`. They also show `GIT_UNSUPPORTED` with reason `version`, `windows-git`, or `no-fs-uuid`. `UNSUPPORTED_REPOSITORY` shows reasons `wsl-path`, `mixed-location`, and `no-fs-uuid`. The `GIT_UNSUPPORTED` `no-fs-uuid` text comes from contract §11 "Git per distro", and the other one from contract §9. The version text names the found and the required version. Each refusal shows the Removed/error icon, its reason text, and its remedy. A command remedy gets Copy command. |
| WSL location | The header shows the text label "WSL: <distro>" beside the repository path, in both densities and themes. The label is text, never color alone. It is an outline badge like the HEAD badge, 8 DIPs after the path. It has the fixed width of "Header layout". It uses Text color and a 1 DIP Control border outline. Forced colors draw it in CanvasText. The repository menu repeats the label above the distro Git path and version. |
| Starting WSL distro | Registration or restore of a stopped distro shows "Starting WSL distro <name>…" in the status region with Cancel. Cancel keeps focus reachable and returns it to Open repository. Canceled shows the unchanged workspace and "WSL start canceled. The distro can keep starting." A deadline shows the `DEADLINE` error with Open repository. The text is static: no spinner, animation, or percentage shows. The workspace behind it stays as it was, and typing, scrolling, and mode changes stay available. |
| Empty/clean | Say Working tree clean when confirmed. Unborn History says No commits yet. Empty stages disable review with an explanation. |
| Loading | Keep the frame stable. New repositories show placeholders labelled "Loading…". A user Refresh action (F5, Refresh, or the State unknown Refresh) retains prior content with the Refreshing marker, "Refreshing…". Polls and focus-return reads update in place and show no marker. No fabricated progress percentage. |
| No selection | A repository opens in History without a selected commit. The inspector then says "Select a commit to see its details". No file is selected when Changes first shows after an open. The same holds when the selected entry leaves without a file action. Changes shows the status lists with counts and HEAD. The comparison pane shows the hint "Select a file to view its changes". Below it, the full Unstaged help line shows wrapped ("Long text"). Hunk controls are absent. |
| Normal | Show path, staged/unstaged scope, one selected comparison, explicit hunk and file controls, and staged count. |
| Succeeded | After a reconciled `succeeded` commit, the status region says "Committed <short ID> to <branch>". On a detached HEAD, it says "Committed <short ID> on detached HEAD". After a hunk action, it says "Hunk staged" or "Hunk unstaged". After a file action, it says "File staged" or "File unstaged". When the outcome carries a nonzero `lingeringDescendants` count, the text adds the lingering sentence: "<count> processes that Git or a hook started still run. Closing Arbareto ends them." When the workspace holds a current trust ID, the text adds: "Revoke trust also ends them." An untrusted repository has no trust ID to revoke (contract §9 "Lingering count"). Every other mutation outcome state adds the same sentence. The status area repeats the lingering sentence, wrapped ("Status area"). The live region announces the text once. The text stays until the next operation starts or another repository opens. No timer removes it. |
| Staged plus unstaged | Show the path in both categories with independent state. Headers make the current comparison direction explicit. |
| Untracked | Label the category explicitly and show an empty comparison baseline. Keep any same-path staged deletion separate. |
| Conflicted/unfinished operation | Name the conflict or the merge, rebase, cherry-pick, revert, or sequencer state, or say that Arbareto cannot identify the operation. Block mutations; offer Refresh after external resolution, never repair. The notice band shows the blocking row in both modes from the first complete read after an open ("Notice band"). The History scope line counts conflicts apart from working changes. |
| Unsupported/binary | Retain metadata and the specific limitation. Disable hunk actions. Do not show an empty text diff or execute a preview. Enable Stage file or Unstage file when the file-action decision accepts the entry. For a refused entry, show the reason and the service's copyable remedy command with Copy command (contract §4 "Limitation remedies"). |
| Trust required/changed | Show a safe policy summary and explicit approval, followed by a native confirmation. Approval persists across launches. Over a program-file digest bound, the approval lasts until Arbareto closes or its Git service restarts (contract §7). The dialog and the native confirmation both say why. Explain hook/tool execution; a changed repository, Git installation, or fingerprint requires renewed approval. Also show this state before the first status read when repository configuration defines read-time commands. Commit review shows this state only when the commit can run repository-controlled code (contract §7 "Mutation trust"). |
| Busy | Keep typing, scrolling, mode changes, and cancellation available. Identify operation and repository; disable conflicting mutations only. Stall notice: a silent commit or submodule step shows the contract §6 notice after 15 seconds. The notice sits in the status area ("Status area"). The status bar text then adds "Git may be waiting for input." Silent means no output and no data transfer. The text is: "Git may be waiting for a prompt that Arbareto cannot show, or for a sign-in window. To answer a hidden prompt, select Cancel and run this command in a terminal." Below it, the command shows in the code font with Copy command and its contract §6 or §12 text. The renderer reads that command from `stallRemedy` with one `getOperation` call after the `stalled` event (contract §6). When the contract §4 rule refuses a value, only the text shows. The notice uses the Warning icon and text, never color alone. It hides at the next activity. When focus is inside the notice, the notice stays until focus leaves it, so no focused control disappears (FR-005). The status bar drops "Git may be waiting for input." at the activity. The live region announces it once per stall. Cancel keeps its place and focus order. |
| Error | Put a safe explanation and recovery action beside the affected pane. Preserve message and selection where valid. Never offer forced unlock or repair. For `LOCKED`, show the Git-resolved lock path with Copy path and Refresh. Show the contract §9 `LOCKED` remedy text. For `HOOK_FAILED` and a commit `GIT_FAILED`, show `outputTail` as plain text. For `HOOK_FAILED` and a `GIT_FAILED` after handoff, also show the contract §9 remedy command with Copy command. A Stage file `GIT_FAILED` shows its `outputTail` the same way, with the `add` remedy command. Show each lock path that a failed commit observed with Copy path and the contract §9 "Other locks" text. |
| Stale selection | State that the comparison or staged scope changed. Invalidate approval immediately; refresh and require reselection or renewed review. |
| Large history | Graph only the first 100 checkout-reachable commits. Show page/shallow boundaries and the scope limit, without pagination or implied complete-history counts. |
| Completed with effects | Show any identified commit and the observed difference. Preserve the draft; offer review and Clear message, never automatic retry, undo, or ordinary-success styling. |
| Graph layout limited | Keep commit rows and accessible parents. Explain lane/segment limits without invented edges or disabling unrelated Git workflows. The cells turn node-only, and the scope line ends with the Warning icon and the limit text ("History graph design"). |
| Limited output | Identify the exceeded limit. Do not present truncation as complete or allow dependent mutations. |
| Cancel requested | Keep the label until Git or the process tree confirms the end (FR-021). Conflicting controls stay disabled. |
| Canceled | Show the reconciled state and never claim rollback (FR-021). If reconciliation fails, show State unknown. |
| Close during mutation | The native close prompt names the running operation and explains rollback limits (FR-024). Its buttons are Stay open and Interrupt and close. Stay open is the default button. Enter, Escape, Alt+F4, the title-bar close button, and a dialog failure all mean Stay open. Only an explicit activation of Interrupt and close interrupts. A renderer request never confirms interruption. Stay open returns focus to the last logical focus target. Processes that outlive a completed mutation cause no prompt, and closing ends them (research R7). |
| State unknown | Show State unknown and Refresh. This one name covers an interrupted or unreported operation outcome and a restarted service session. Block mutations until reconciliation succeeds; do not claim cancellation reversed changes. Each recovery marker offers Dismiss. It succeeds only for a gone repository and after a native confirmation (contract §6). The outcome stays unknown. The recovery marker list sits above the workbench header (T330). It takes at most 40% of the client height and scrolls inside that height. No floor reserves it, and it never chooses the profile. Layout does not subtract its height, so the work area below it scrolls. |
| Recovery statement | A `readWorkspace` result with `recovery` (contract §8 "Recovery statement") shows the recovery row of the notice band ("Notice band"), in History and in Changes. The row stays until the next read with `refresh: true` or until another repository opens. It shows the Warning icon and text, never color alone, and it has no control. It shows one sentence for each field that the statement holds, in field order. `outcome` `unknown` gives no sentence. `outcome` `none` reads "The earlier session ended, and Arbareto found nothing to reconcile." `attribution` `identified` reads "The interrupted commit exists as <short ID>." `attribution` `none` reads "The interrupted operation made no commit." `attribution` `unknown` reads "Arbareto cannot tell if the interrupted operation made a commit, because <reason>." Reason `ambiguous` gives "the branch history does not identify one commit". Reason `evidence-limit` gives "the branch history holds more records than Arbareto checks". Reason `no-retained-request` reads instead "Arbareto cannot tell what the interrupted operation changed, because this Git service session has no record of its request." `indexMatch` `published` reads "The interrupted hunk or file action reached the index." `not-published` reads "The interrupted hunk or file action did not reach the index." `neither` reads "The index matches neither the state before nor the state after the interrupted hunk or file action." With `foreign`, the row adds "Another Git process or a crash can have left these files. Remove them only after all Git tools stop, including other Arbareto windows." Each path of `foreign` follows on its own line in the code font. With `foreignTotal`, the list ends with "and <n> more files", where <n> is `foreignTotal` minus the listed paths. A count of 1 reads "and 1 more file". |
| Submodule notice | The submodule row of the notice band, in History and in Changes: "Some submodules are not initialized or not at their recorded commit. Count: <n>." It shows that text and the Update submodules button. The "Count: <n>" form needs no singular rule. The notice uses text and the Warning/stale icon, never color alone. History shows it with the first complete read after an open. For F6, it belongs to the notice band stop. It disappears after a read that finds no such submodule. |
| Submodule review | The dialog title is "Update submodules", and "Dialog sizes" sets its size. Each row is one listbox option with the path, the redacted URL in the code font, and the action. A `reuse` or `fetch-checkout` row also lists each redacted submodule remote URL. The default remote shows "(default)" after it (contract §12 "Plan"). A nested row is indented 16 DIPs per level, and its accessible name gives the parent path. The actions read "Clone", "Reuse the existing Git folder", or "Check out <new>". Other actions read "Fetch, then move from <old> to <new>", "No change", or "Skip". Notes and refusal texts come from contract §12. A refusal disables Start update and shows its remedy with Copy command or Copy path. The disclosure line reads: "Git connects to each URL. Your credential helper can show its own window." The program list reads: "Programs from submodule settings and hooks that Git can run". It includes kept Git folders, and an entry without a plan row names its Git folder. |
| Updating submodules | The status region shows "Fetching submodule <path> (<i> of <n>)…" or "Updating submodule <path> (<i> of <n>)…". It shows "<p>%" when Git reports a percentage, with Cancel. The percentage stays outside the live text, so only a new step is announced ("Status area"). Typing, scrolling, and mode changes stay available. A step without activity for 15 seconds shows the Busy stall notice with the contract §12 command of that step. The status area lists each submodule of the outcome in one row: path, icon, and state text ("Status area"). The contract §12 row states read "Cloned", "Moved from <old> to <new>", "No change", and "Failed". The others read "Clone interrupted", "Changed elsewhere to <short ID>", and "Refused" with the contract §12 refusal text. A row with the `fetched` flag adds "Git fetched in this submodule." A row with the `found` flag adds "Found during the update." An unchanged or failed row with the `connected` flag adds "Git connected the submodule folder." An unchanged or failed row with the `registered` flag adds "Git changed the settings of this submodule." A row whose read failed adds "Arbareto could not read this submodule. Use Refresh, then try again." Cloned and moved rows use the Added icon. Interrupted, changed-elsewhere, and refused rows use the Warning icon. Failed rows use the Removed/error icon, and unchanged rows use none. A failed row shows its output tail as plain text and its remedy with Copy command. A refused row shows its remedy with Copy command when it has one. An interrupted row shows its folder path and the move-out remedy with Copy path. An inactivity deadline shows: "Git sent no output and transferred no data for 5 minutes, so Arbareto stopped it." Success says "Submodules updated" in the status bar. No dialog shows the outcome. |
| Component stopped | A service exit shows the native Git service stopped dialog (T142) with Restart service and Close Arbareto. Restart signals the new session to the page without a reload, so drafts survive. The page runs `restoreWorkspace` again and shows State unknown until Refresh (FR-023). A renderer exit shows a native dialog with Reload window and Close Arbareto. A browser process exit offers Restart Arbareto, which relaunches the application, and Close Arbareto. An unresponsive renderer causes no automatic action. |

Use complete Git observations for state labels. A failed read cannot produce Working tree clean. Error and warning text must remain understandable without color.

Status and fallback texts. `<code>` is the contract §9 code, or the result state when the result has no code. Each code shows in the code font.

- Header HEAD text: "Detached HEAD" on a detached HEAD, and "<branch>, no commits yet" on an unborn branch.
- A failed trust read from the repository menu: "Trust review did not complete: <code>." A failed `approveTrust`: "Trust approval did not complete: <code>."
- Revoke trust: "Trust revoked. The revoke ended <n> processes." (singular: "1 process"). A `revokeTrust` `DEADLINE`: "Trust revoked. The process count is unknown, because the revoke reached its deadline." The service revocation stays then (contract §5 "Deadline outcomes"). Any other failure: "Revoke trust did not complete: <code>."
- A failed open: "The repository did not open: <code>", followed by the refusal content of "Repository refused".
- A `limited` read: "Incomplete: <code> <reason>. Changes that depend on this view stay blocked." Without a reason, only the code shows.
- A trust dialog over a program-file digest bound: "Reached bound: <bound text>." and then the session-only text. The bound texts are those of contract §7 "Program file digests", as in the native confirmation.
- Splitter accessible names: "Resize file lane" (wide), "Resize file band" (narrow), and "Resize bottom region".
- A failed clipboard write: the status bar shows "Copy failed. Select the text and copy it with Ctrl+C."
- Interim texts until T148 replaces the T330 mount: the Unstaged help line "Enter shows a file. Hunk and file staging are available after batch 3.", the commit place "Commit is available after batch 3.", and the submodule row suffix "Update submodules is available after batch 3."

#### Screenshot review during implementation

Capture the installed release build with real disposable fixtures. No screenshot currently exists. These captures are review targets, not claimed passes or substitute Git assertions.

Record build, fixture, theme, density, client size, OS/runtime, and scale for each capture. Use stable fixture paths and no credentials or personal repositories.

| Capture | Actual state and interaction to review | Configuration |
| --- | --- | --- |
| UI-01 | No repository; folder dialog accepted and canceled; focus returns to Open repository. | 1280×800, dark/compact, 100%. |
| UI-02 | F01 empty/unborn Changes and History; explicit empty scope and disabled review. | 960×640, light/comfortable, 100%. |
| UI-03 | Controlled initial loading and refresh with retained prior content and visible focus. The loaded frame is History with rows, graph, counts, and no selected commit. After Ctrl+1, Changes shows the No selection state with counts, HEAD, and its hint. | 1280×800, dark/comfortable, 100%. |
| UI-04 | F02 normal diff with a selected hunk, its bar and label, visible path/scope, and keyboard focus on another control. The selected file row shows its selection marker. | Matching dark/light captures, compact, 1280×800, 100%. |
| UI-05 | F02 same path in Staged/Unstaged; F06 staged deletion plus untracked replacement with an empty baseline. Capture qualified hunk outcomes, with "Hunk staged" in the status region and the anchored viewport. Capture a Stage file outcome with "File staged", focus and selection on the next entry, and its comparison. Capture the Space states. They are the refusal text with its Warning icon, focus on the next entry, and the truncated Unstaged help line. Capture the busy reason after a Space during a running file action. | 1280×800, comfortable, 150%. |
| UI-06 | Draft, complete review, F11 trust approval with its native confirmation, and hook rejection with retained message and restored focus. After Commit staged changes, focus sits on Cancel in the status bar. The "Commit details" status area shows the output tail and remedy command of the rejection. Focus returns to the message field. The F11 copy holds URL user-information key canaries; the capture shows `<redacted>` and no canary token. A commit `GIT_FAILED` from the F14 ref-lock variant opens the same area. It shows the lock path, the output tail, the remedy command, and the lingering count. Focus moves to the message field. The UI-13 commit with unexpected effects opens the area too. It shows the commit ID, the observed difference, the suggested message, and Clear message. | 1280×800, light/comfortable, 100%; mutation gates must already pass. |
| UI-07 | F05 binary entry and F16 oversized comparison, each with its disabled hunk reason and an enabled Stage file. F05 symbolic link or filtered entry with its specific reason and the copyable whole-file remedy command. An F04 mixed file under `core.safecrlf=true` with its failed Stage file output tail and `add` remedy. The F16 comparison also shows the Limited output state. | 960×640, dark/compact, 150%. |
| UI-08 | F13/F14 busy work, cancel requested, canceled, close during mutation, unknown recovery, and typing during a delayed successful commit. An F11 console-variant commit with the stall notice and its Copy command in the open status area. An F14 lingering outcome with its sentence in the status bar and in the status area. Collapse the area by keyboard and reopen it with the toggle. Preserve newer edits when completion arrives in History. The native Git service stopped dialog with Restart service, a draft that survives the restart, and the native renderer-failure dialog. | 1280×800, dark/comfortable, 100%; never fake enabled mutation controls. |
| UI-09 | F09 stale selected hunk and staged-scope change; refreshed content cannot restore the old approval. | 960×640, light/compact, 150%. |
| UI-10 | F10 conflicts, unfinished operations, and locks; F15 unavailable repository. Capture History right after the open, before any key press. The notice band shows the blocking row, and the scope line counts conflicts apart. Then capture Changes with the same band. At 960×640, the window size alone gives the constrained profile ("Height budget"), with or without the band. Show explicit mutation blockers and no repair action. Refused bare repository with its remedy text. Dubious ownership, a missing `.git` target, and a folder outside every repository each show the merged `REPOSITORY_UNAVAILABLE` refusal: the remedy text, Git's message as plain text, and no copyable command. | 960×640, light/comfortable, 100%. |
| UI-11 | F19/L graph with linear, merge, and octopus ancestry and long subjects. Show a root, the dashed "Outside loaded page" continuation, and the two-bar "Shallow history boundary" mark. Each shows its inspector text. Show the HEAD and branch badges in the subject cell and a selected row with its marker. First show History with no selected commit. Return to Changes without losing valid context. | 1280×800, dark/compact, 150%; matching light/comfortable capture. |
| UI-12 | Pointer/keyboard splitters, both densities, graph-row alignment, constrained layouts, and cross-display focus/IME behavior. Include the node-only Graph layout limited page with its scope-line text, and keyboard parent inspection. Include the wrapped hunk toolbar with Stage file on its second row at 720×480. Include the narrow profile at its floor, with the file band at its minimum and a one-line help line. | 1440×900 at 100%; 960×640 at 150%/200%; 720×480 at 200%, both themes. Narrow floor: 960×806, light/comfortable, 100%. |
| UI-13 | F11/F20 hook refusal for hunks, standard commit disclosure, and a commit created with unexpected effects. Show the actual result and retained draft. Also capture a reconciled `succeeded` commit with "Committed <short ID> to <branch>" in the status region. | 1280×800, both themes, comfortable, 100%; real mutation evidence required. |
| UI-14 | Windows contrast theme (forced colors) in the installed build. Graph lanes and nodes, boundary marks, the focus ring, and row selection with its marker remain visible. So do the HEAD, branch, and WSL badges, diff plus/minus markers, and disabled reasons. | 1280×800, 100%; one dark and one light contrast theme. |
| UI-15 | About window Overview, License, and Third-party notices tabs with keyboard focus, offline. Focus returns to the Help menu button on close. | 1280×800, dark/compact, 100%; 720×480, light/comfortable, 200%. |
| UI-16 | F27 History right after the open, before any key press, with the submodule row in the notice band. The same band in Changes. The review with clone, move, and nested rows. F28 refusal with its remedy. The native Run confirmation for F29. F30 progress with "Fetching submodule <path> (<i> of <n>)…" and "Updating submodule <path> (<i> of <n>)…", a percentage, and Cancel. A failed row with its output tail and Copy command. The status area with the outcome list: a cloned, a moved, a failed, an interrupted, and a refused row. Each row shows its icon and text, and focus sits on the area heading. The collapsed area with its toggle. The F30 stall variant with the stall notice in the area. A successful run with "Submodules updated". At 720×480, the open area as the last section of the scrolling work area. At 960×640, the window size alone gives the constrained profile, as "Height budget" states. No-reflow pair: at 1120×700 comfortable, the wide floor, use an F30 stall-variant copy with one changed tracked file. Show its comparison with a selected hunk while the update runs. Capture one frame before and one after the stall notice opens the area. Both frames show the wide profile. The lane and the comparison keep their left edges and widths, and the selected hunk stays at its viewport position. Overflow frame ("Height budget", Overflow): use 200% text. Size the window to 960 DIPs width and the narrow floor height that `src/frontend/layout/profiles.ts` returns. Use a copy of the outcome-list case, so the submodule band row shows. Type in the message field while the update runs. At the outcome, the band row wraps to two or more lines. The wrapped row and the open area together exceed the two reserves. The work area scrolls, and the profile stays narrow. The message field keeps focus and stays in view, and its focus outline shows. | 1280×800, dark/compact, 100%; 960×640, light/comfortable, 150%. No-reflow pair: 1120×700, dark/comfortable, 100%. Overflow frame: 960 DIPs wide at the narrow floor, light/compact, 200%. |
| UI-17 | Windows text size 150% and 225%. Show F02 Changes with a selected hunk, F19 History, the commit tray, and one dialog. Text grows by the factor, and no label clips. Every essential action stays reachable, by scrolling in the constrained profile where needed. At 720×480 and 225% text, show the wrapped header with a long path and a long branch name. Each shows its middle ellipsis. Repeat that header with the F21 "WSL: <distro>" badge; that part stays `unverified` until distro Git 2.55.0 exists (research R13). Add a long-text frame at 720×480 and 225% text. It shows the comparison heading with a long path, its middle ellipsis, and Copy path. It shows a reason line too long for one line, with its end ellipsis. It also shows the History scope line with a long checkout name and the limit text. They shrink by the "Long text" order. No label clips, and the heading keeps its height. Add a comfortable 720×480 frame at 225% text with the notice band and the open status area. The area has its 179 DIP minimum. The area scrolls into view, and no label clips. | 1280×800 and 720×480, dark/compact, 100% display scale; 1280×800, light/comfortable, 150% display scale. Band frame: 720×480, dark/comfortable, 100% display scale. |
| UI-18 | Review commit with a long F02 staged list, and Trust required with its session-approval text. Update submodules with an F27 list. Each dialog clamps, its content region scrolls, and its buttons stay visible. | 720×480 at 200%, both themes and both densities; 1280×800 at 100%, dark/compact. |
| UI-19 | F21 "WSL: <distro>" badge in the header and the repository menu. An F21 copy in a dedicated test distro with a 30-character name shows the fixed-width badge with an end ellipsis. The header keeps its row count, and the repository menu shows the full name. F22 "Starting WSL distro <name>…" with Cancel, and the canceled text. F23, F24, and F26 refusals with their reasons and remedies. | 1280×800, dark/compact, 100%; 960×640, light/comfortable, 150%. |

State coverage. "Required visible states" has 29 rows, and each maps to at least one capture:

- UI-01: No repository. UI-02: Empty/clean. UI-03: Loading and No selection.
- UI-04: Normal. UI-05: Staged plus unstaged, Untracked, and Succeeded.
- UI-06: Trust required/changed and Error. UI-07: Unsupported/binary, Limited output, and Error.
- UI-08: Busy, Cancel requested, Canceled, Close during mutation, State unknown, Component stopped, and Succeeded with the lingering sentence.
- UI-09: Stale selection. UI-10: Repository refused, Conflicted/unfinished operation, and Error.
- UI-11: Large history. UI-12: Graph layout limited. UI-13: Completed with effects and Succeeded.
- UI-16: Submodule notice, Submodule review, and Updating submodules.
- UI-19: WSL location, Starting WSL distro, and Repository refused for WSL reasons.

UI-19 steps that need distro Git 2.55.0 or later stay `unverified` until it exists (research R13). The F24 refusal and the `distro-missing` refusal run on the reference host now.

Provide enough work area for the requested client size, native chrome, and taskbar. Use a larger qualification display if needed. Record the actual work area; clipped captures cannot pass. Use the supported constrained profile when a smaller work area requires it. Every capture at 960×640 shows the constrained profile ("Height budget").

Review screenshots for hierarchy, clipping, readable syntax, semantic contrast, visible focus, and clear scope. Pair them with keyboard, IME, native, and exact Git-state tests. Screenshots alone cannot prove these behaviors. Narrator tests: Deferred to a later feature; not a qualification check in this slice.

#### Design check against the brief

Choose A over the three-column arrangement because high DPI reduces logical width. Keep the full staged scope visible without compressing the diff into a narrow column.

Reject decorative cards, chat-first navigation, copied branding, tiny metadata, inaccessible custom tabs, and hidden destructive shortcuts. Retain system fonts and restrained blue because they fit the Windows workbench brief. Git Extensions is the primary workflow reference, and T3 Code is the visual-style reference.

Source inspection, document review, and numeric contrast checks do not qualify rendered behavior. Interface screenshots, accessibility, and native qualification remain unverified. This interface plan does not change the mutation or public-release gates.

### Service and native shell

Use private inherited pipes between the shell and compiled service. No localhost HTTP server or renderer-visible process API is needed.

The renderer sends only contract operations. The shell checks command origin, framing, operation kind, and message bounds. The service validates full operation semantics.

Native dialogs provide repository and executable selection. Native confirmations with a Cancel default guard Git selection, trust approval, marker dismissal, and the submodule program run (contract §12). The Git selection confirmation can propose a found `git.exe` (contract §3 "Git proposal"). Service registration returns opaque identifiers. Renderer input cannot become a filesystem or executable capability directly.

The shell supervises the service and Git operations with separate Windows Jobs. Create each child suspended and already in its Job through `PROC_THREAD_ATTRIBUTE_JOB_LIST`, then resume it. A failed creation starts no process. A failed resume terminates the child (contract §6). A process that Git or a hook starts during a mutation can outlive the mutation, as with command-line Git. The shell then keeps that mutation's Job in a lingering set. It closes the Job when the Job becomes empty or the application closes. It also closes the Job when Revoke trust applies to that repository (contract §6 "Lingering Jobs"). Cancellation, deadline expiry, and Interrupt and close still close the operation Job at once. A process ends at its handle signal, never at pipe EOF. Later pipe output is discarded (contract §6 "Completion signal"). Every Git process has a deadline (contract §5).

Only the private service channel can request bounded Git process execution. The shell pins the selected executable and validates ownership and limits. Native code does not implement Git commands or staging semantics. The shell starts the service and every Git process with `DETACHED_PROCESS`. So Git and each child that it starts directly, hooks and `ssh` included, have no console. A hook runs under the MSYS2 `sh.exe`, which gives each native console program an invisible console. A program that reads that console directly waits until the operation deadline. That is 120 seconds for a commit and 300 seconds of inactivity for an update. Closed stdin did not end that wait (research R14 S17). User decision, 2026-10-01: after 15 seconds without output and without I/O, the status shows a stall notice. It offers Cancel and a terminal command (contract §6 "Activity and stall notice"). The shell reads the Job I/O counters once per second for the commit and each submodule update process. Every environment policy sets `GIT_TERMINAL_PROMPT=0`. Each stdin pipe closes after its bounded input (contract §6 "Console and input"). The WSL anchor is the one exception. Its stdin stays open until `ended`, so it outlives each Git process of its mutation. The shell starts every `wsl.exe` with `CREATE_NO_WINDOW`, because a detached `wsl.exe` relayed no output (contract §11). The contract §11 wrapper runs each program that it wraps through `setsid --wait` (spec Clarifications, 2026-10-01). So no WSL hook can open the hidden terminal. The bootstrap probe and the anchor run without the wrapper, and neither runs a repository program.

Use one active application service per instance. Allow more than one application instance. Each instance treats the others as external writers. Write native settings by whole-file replacement, and the last writer wins.

Cross-instance mutation exclusion (FR-015). The service exclusion covers one instance. At each `started` frame, the shell also takes a named mutex for the common-directory identity (contract §6 "Recovery markers"). A mutex that another instance holds refuses the mutation with `BUSY` before any lock or Git process. So linked worktrees of one repository never mutate at once, also across instances. Git's own `index.lock` still refuses a second write to one index, as `LOCKED`. Scope: the mutex name is `Local\`, so it covers one logon session. FR-015 states this scope. Instances in two logon sessions do not exclude each other. Between them, only `index.lock` guards each index, and two linked worktrees can mutate at once. Design decision, 2026-10-01: keep `Local\`. Windows client editions run one session per user, so this covers the normal case (research R11).

At startup, the shell starts the service and completes the handshake before it creates the main window. The page gets each `sessionId` from the shell-only `currentSession` operation (contract §2). Pinned Tauri sets initialization scripts only on builders. So a script cannot carry a new session to a reloaded page (research R7).

Cold-start critical path. These steps run in order, and the listed overlaps are permitted:

1. The shell starts the service process. While the Bun runtime starts, the shell reads the platform facts, the WebView2 version, and the native settings.
2. The shell sends the handshake frame and waits for the reply. The main window waits for that reply (contract §2).
3. The shell creates the main window hidden, attaches the WebView2 handlers, and shows it (research R7). The service runs its startup Git probe during this step.
4. The page loads, calls `currentSession`, and calls `restoreWorkspace`. That call waits for the Git probe and runs discovery.
5. The page sends `readWorkspace` with `check: "full"` and `readHistory` beside it. The two reads fill the two workspace read slots (contract §5). The page paints the History-ready frame defined in "Measurements and budgets".

Every open ends at the History-ready frame, because a repository always opens in History (FR-034). The Changes lists render from the same full read when the user presses Ctrl+1. T193 records the step times in batch 1, and T192 records read times in batch 2. Both are observations, not budget results.

On unexpected service exit, show the native Git service stopped dialog with a Restart service action. A restart starts a new session and invalidates old identifiers. The shell then sends the page a `service-session` event, and the page calls `currentSession` (contract §2). The page does not reload, so drafts survive. It runs `restoreWorkspace` again and blocks every mutation until a `refresh: true` read in the new session (FR-023, contract §8). For each recovery marker, and for each request without a terminal response, show State unknown (contract §6). Never restart the service or reload the window automatically.

wry does not handle WebView2 `ProcessFailed`. The shell subscribes to that event and shows the Component stopped state. The research.md R7 section cites the wry and Tauri source for this fact and for both handlers.

### WSL repositories

The user added WSL2 repositories to this slice (spec Clarifications, 2026-09-30). Contract §11 defines the rules, and research.md R13 holds the probes.

- Route: a folder under `\\wsl$\` or `\\wsl.localhost\` is a WSL repository. The service decides the route before any identity request, because `FileIdInfo` fails there. Identity is the distro GUID plus the UUID-derived file-system ID and the inode. The Linux device number can follow the disk attach order (research R13 P6). Only ext2, ext3, and ext4 derive that ID from their UUID. `stat --file-system` reads it without udev data (research R13 P7).
- Git: each distro gets one approved Linux Git, 2.55.0 or later. The shell never runs Git for Windows on a WSL path.
- Processes: the shell starts `wsl.exe` in the operation Job, with an empty `WSLENV`. A constant wrapper runs each program in its own systemd user scope. A mutation also starts an anchor in its Job. A Job close delivers `SIGHUP`, and the trap ends the scopes. So the existing Job rules keep their meaning for Linux processes, and a shell crash also ends them. `src/contracts/wsl-process.json` holds the wrapper and anchor texts for the shell, the service, and the test double.
- Files: bulk file work stays inside the distro through `wslFiles` (contract §6 "WSL file work"). Only the contract §11 crossings use the UNC path. Git gets the Linux worktree root through `-C` and the candidate through the wrapper.
- Freshness: no watcher runs. While the window has focus, the renderer polls with a full read 1 second after the previous poll ends. A poll never runs beside another read of that workspace. Focus return, manual refresh, and each outcome also run a full read.
- Start: a stopped distro starts with the first probe, under a 60-second deadline, with "Starting WSL distro <name>…" and Cancel.
- Prerequisites: WSL2, a systemd user manager in the distro, and Git 2.55.0 or later there. The distro also needs `setsid` from util-linux, and `/usr/bin/stat` and `/usr/bin/env` from coreutils. The app installs and configures none of them. The reference distro has Git 2.43.0, so WSL qualification rows stay `unverified` until the user installs a newer Git.
- Native code serves the WSL platform boundary (Constitution II). It makes the list calls and reads the registration key. It starts the wrapper, the anchor, and the identity probe. Shared Git semantics stay in the service.
- Terminal: every wrapper mode runs its program through `setsid --wait` (spec Clarifications, 2026-10-01). So no Linux Git process or hook has a controlling terminal (contract §11, §12). A `/dev/tty` open or an SSH prompt fails at once. A child that keeps running after Git exits stays in its scope, lingers, and counts, as on Windows. The Git probe resolves `setsid`, and its absence refuses the distro with reason `no-setsid`. This design change needs a re-probe (research R13).
- Update submodules uses wrapper mode `network`, which the §7 `network` policy selects on the service side. Its inactivity limit reads the anchor I/O sum: `rchar` plus `wchar` of each scope process (contract §11 "Process ownership"). The user scope has no `io` controller (research R13 P6). A WSL Job never uses its `IO_COUNTERS`, because the anchor pipe exchange changes them each second (research R14 S29).

### Freshness and reconciliation

Serialize application mutations by resolved common-directory identity. Reject overlapping submissions rather than queueing approvals that can become stale.

Observe worktree, worktree-administration, and common-directory changes. Debounce hints: trailing 100 ms, with a maximum wait of 1000 ms (contract §8 "Watcher hints"). A lost watch makes every poll of that workspace run in full until the workspace is registered again. Poll relevant foreground state every second. Each poll is one `readWorkspace` with `check: "changes"` (contract §8 "Change check"). It runs a full read only after a watcher hint or a changed stat tuple. Otherwise it starts no Git process and returns the last snapshot. A poll starts no read while an earlier read of that workspace is pending. This bound follows the contract §5 read concurrency caps. Polls show no Refreshing marker. The poll cost counts in the idle CPU budget. T192 records the CPU time of each read kind on M and L in batch 2. T169 measures packaged idle CPU.

SC-007 stays reachable. The watcher hint is the primary path. An external file, index, or ref change gives a hint 100 ms after the last event, and at most 1000 ms after the first event. The next poll tick, at most 1 second later, then runs a full read. The stat tuple backs up missed hints for the index, HEAD, the current branch ref, and `packed-refs`. In a reftable repository, the `reftable/tables.list` files replace HEAD, the branch ref, and `packed-refs` (contract §8 "Change check"). It also covers the configuration and program files and the selected working file. A missed hint for another working file recovers on focus return or manual refresh, as SC-007 permits. The 2-second budget therefore holds when a full read on M takes at most about 0.9 seconds. T192 records that read time, and T168 measures the packaged result.

Refresh on focus return and manual request. Focus return sends `check: "full"`. Invalidate approvals immediately after relevant changes. Generation and selection identifiers suppress obsolete read results.

WSL repositories replace the watcher and the change check with focused polls (contract §11 "Change polling"). The next poll starts 1 second after the previous read ends. A change can land just after a poll reads its file. That poll then ends at most one read time r later. The next poll starts 1 second after that and ends after another r. So the change shows after at most 1 + 2r seconds plus the response transfer and render. The WSL targets of 2026-10-06 (spec Clarifications, research R13 "Probe P10") are r at most 1.5 seconds and 4.5 seconds for an outside change. With r at 1.5 seconds, 1 + 2r is 4.0 seconds, and 0.5 seconds remain for transfer and render. T245 confirms the target in the packaged run. The plan §Measurements and budgets section makes both values budgets ("WSL budgets").

Every mutation still needs direct state validation. Watchers, polling, and generations do not create an atomic snapshot.

After every mutation outcome, reconcile actual Git state before enabling another mutation. Failed reconciliation produces an explicit unknown state. An explicit recovery refresh must complete recovery reconciliation before enabling mutations (contract §8). An unknown attribution is a stated result, not a permanent block. Polls and focus return never send `refresh: true`. A successful status read alone cannot clear the block.

### Selected mutation protocols

The former design blockers are resolved by the approved checkpoint contract. Qualification remains required; source reasoning is not a test pass.

**Hunk publication:** acquire the Git-resolved canonical index lock, revalidate, and prepare one private candidate index. Apply the service-selected patch through Git and verify the independently calculated exact result. Recheck relevant state before one same-volume publication through the owned lock. Reconcile afterward.

Support ordinary full indexes first. Refuse sparse indexes (`index.sparse=true`) and split indexes. A split index carries a `link` extension in its raw bytes; the service reads it without starting Git. Also refuse an effective `core.splitIndex=true` from any scope, with reason `split-index` (contract §4 "Split index"). A candidate copy keeps a time at most the canonical index time. So Git keeps its racy-entry check (contract §4 "Candidate time"). Also refuse registered `post-index-change` hooks, executable fsmonitor, the built-in fsmonitor daemon, custom conversions, and existing unsupported file/state cases. Registered disabled index-change hooks also cause refusal until their interpretation receives separate qualification.

Do not disable hooks or monitors to make a hunk operation pass. Ordinary commit hooks remain supported. Preserve external writers' bytes and report changes observed after publication without undo or retry.

**File staging:** use the same exclusion, lock, private candidate, checkpoints, publication, and reconciliation as hunk publication (contract §4 "File staging"). Stage runs `update-index --add --remove` on the candidate, so Git reads the working file and converts it as `git add` does. Unstage writes the HEAD entries of the changed paths into the candidate with `update-index --index-info`. A staged rename changes both paths. Working-file digests before and after the Git step bind the staged bytes. Git's conversion can depend on the index, so the service cannot recompute the blob. It proves the blob instead. Either the working-tree form of the blob equals the verified bytes, or `hash-object` of those bytes gives its ID. Without a proof, it refuses with `STALE_SELECTION` or reason `blob-proof` (contract §4 "Blob proof"). The same profile refusals apply, and a stage path with a `filter` attribute is refused. A stage working file above 512 MiB gets reason `size` (research R3).

**Submodule update:** `reviewSubmodules` reads the superproject and each initialized submodule with ten fixed commands. None loads an index or runs a repository program (research R14 S3). It also walks the kept Git directories below `modules`, at every depth. Git reuses them and runs their programs (research R14 S11). It returns the plan, the refusals, the submodule program list, and a one-use token. A fetching row lists the remotes of the submodule, because Git fetches from them (research R14 S12). `updateSubmodules` enters the mutation exclusion, waits for the recovery marker, and revalidates the whole review. It asks for the native Run confirmation when programs are listed. Then it visits the rows depth first, in index order (contract §12 "Update protocol"). A row that fetches runs Git's own fetch first, with `GIT_PROTOCOL_FROM_USER=0` and `--no-recurse-submodules`. A `reuse` row that fetches runs the connect step before that fetch. When the target stays unreachable, the fallback fetch by commit ID follows, with `--` before the remote name. The service visits the nested levels itself (research R14 S25). The service then checks HEAD and its refs again. Then `--no-lazy-fetch submodule update --init --no-fetch --progress -- :(literal)<path>` checks out, without `--recursive`. A `clone` row runs the same command without `--no-fetch`, with `-c fetch.recurseSubmodules=no`, after the clone check. Contract §12 "Update protocol" lists every step. After each parent checkout, the service reads the nested level and applies the same checks. Each process has a 300-second inactivity deadline and a 4-hour ceiling, and Cancel ends the running tree. Activity is a forwarded output byte or a changed Job I/O sum. Fetch and checkout print nothing (research R14 S16). The shell reads the sum through `JobObjectBasicAndIoAccountingInformation` once per second. After 15 seconds without activity, the status shows the stall notice. The `network` policy sets `GIT_TERMINAL_PROMPT=0`, and the process has no console. Reconciliation re-reads every row and reports its state. It names each interrupted clone and removes no file. The refusals cover unreferenced submodule commits and merge, rebase, or command update modes. They also cover interrupted clones, non-empty folders of reused Git folders, missing `.gitmodules` entries, paths, and limits. Before the first step of a reused row, the service checks its folder again. A custom submodule Git directory layout (`extensions.submodulePathConfig` or `submodule.<name>.gitdir`) also refuses, with reason `gitdir-config`. Design decision, 2026-10-01: the kept-directory walk reads only the default layout (research R14). Contract §12 holds the full rules.

Design decisions of the fourth analysis, 2026-10-01 (research R11 "Safety and test remediation, fourth analysis"):

- A `reuse` row needs an absent or empty folder, or it refuses with `folder-not-empty`. Git checks out a reused folder with `checkout -q -f` (research R14 S13). The `clone-interrupted` remedy moves the folder out of the repository instead of deleting its `.git` file.
- A relative `core.hooksPath` or program path from any scope gives `unchecked` entries. Each row whose worktree the update writes gets one. Git runs the target-tree files there, also for a `clone` row (research R14 S14). So `confirmRun` goes out.
- Replaced by a user decision, 2026-10-01: every ref counts at the review. The update fetches first and checks HEAD and its refs again before each checkout. A pruning fetch removed the only ref that held HEAD (research R14 S15). With the check, that row keeps HEAD and ends `refused` (research R14 S20).
- User decision, 2026-10-01: a commit or submodule step without output and without I/O shows the stall notice after 15 seconds. The deadlines stay unchanged (contract §6 "Activity and stall notice").
- After an approved `confirmRun`, the update runs the review reads again before the first update process. The dialog has no time limit.

Design decisions of the H1 safety remediation, 2026-10-01 (research R11 "Safety remediation H1"):

- Clone check: before each clone step, the worktree `.git` entry and `modules/<name>` must match the preflight. Otherwise the row ends `refused` with `unsaved-commits` or `changed-after-review`, and no process starts (research R14 S26).
- Every command passes `--` before a remote name (research R14 S31). The review refuses a remote name that starts with `-` with `remote-name`.
- The contract §4 quoting rule names every value kind. It gives no command for a value with a double quote, a control character, or invalid UTF-8 (research R14 S28). It also gives none for a value that ends in `\`, except a drive root. No built Windows path ends in a separator, except a drive root (research R14 S34). One shared builder applies it (T262).
- Each clone step passes `-c fetch.recurseSubmodules=no`. A connect step cannot replace it for a `reuse` row without a kept HEAD (research R14 S27).
- An active, unregistered `update = none` row runs `submodule init` for its path, so the settings equal Git's own update (research R14 S33).
- The fetch remedy sets `GIT_PROTOCOL_FROM_USER=0` for that one command (research R14 S30).
- A WSL Job uses only output and the anchor I/O sum (research R14 S29). The stall command reaches the renderer through `stallRemedy` and `getOperation`.
- Read failures end their row `failed` and never count as an absent state. A fourth row flag, `registered`, reports a settings write against the preflight or level-read baseline. The service re-checks the programs before each process that can start one: each step and each nested active-set read.
- The clone check gives `unsaved-commits` without a command, because nobody reviewed the found Git folder. A WSL fetch remedy needs a Git path without `=`.
- The `update-mode`, `gitdir-config`, and `limit` remedies state that they skip the app's checks. The review lists them after every other refusal.

**WSL repositories:** the same protocols run through the distro's Git (contract §11). The service reaches repository files inside the distro through `wslFiles`, and Git gets Linux paths. Only the contract §11 crossings use the `\\wsl.localhost` path. Every Linux process runs in a systemd user scope, and each Job close ends its scopes.

**Commit review:** capture the complete staged scope and a bounded retained index snapshot through read-only Git inspection. Do not call `write-tree` or run a trial commit during review. Keep expected scope as captured index data rather than requiring a preview tree write.

**Commit handoff:** enter the mutation exclusion and wait for the recovery marker. Lock for final preflight, compare reviewed index/checkout/trust, consume the token, then release that lock. Start one selected-Git `--no-lazy-fetch commit --quiet --file=-` against the canonical index, with the bounded message on stdin. `--quiet` removes only Git's summary after the commit, which can need a missing blob in a partial clone (research R5). Every other app Git command also passes `--no-lazy-fetch`. So no partial-clone fetch runs a repository transport program (contract §7 "Missing objects").

The lock release starts the execution window. Git runs existing approved hooks and signing. Do not use a private commit index, inject guards, reconstruct commits, or override user identity/signing configuration. After it updates HEAD, `git commit` runs automatic maintenance and then the `post-commit` hook. Source reasoning says that maintenance runs in the foreground on Git for Windows (research R4); T100 verifies it. Then the 120-second commit deadline covers both, and reconciliation classifies an interrupted result from observed state. If maintenance detaches, it keeps running like command-line Git and ends at application close (contract §4). A `post-commit` hook child and a built-in fsmonitor daemon follow the same rule. The commit completes at Git's process exit, even while such a descendant holds Git's stderr (contract §6 "Completion signal"). The outcome records how many such descendants still run. An `index.lock` that one holds gives `LOCKED` on the next mutation. Another held lock makes Git fail with `GIT_FAILED` or `failed-with-effects` (contract §9 "Other locks").

**Reconciliation:** compare the actual commit tree against the retained reviewed index using bounded read-only Git inspection. A retained verification copy is not the index used for committing. Check parent, destination, index, relevant working bytes, and operation markers.

Use bounded reference/reflog evidence where needed; never attribute current HEAD to this request automatically. Ambiguity produces unknown state. `succeeded`, `completed-with-effects`, `failed-with-effects`, and `unknown` are distinct outcomes.

Preserve drafts after `completed-with-effects`, `failed-with-effects`, or `unknown` results, including later edits made during execution. Do not offer automatic retry or rollback. Known checkpoint mismatches refuse execution/publication rather than becoming `completed-with-effects` outcomes.

Keep lock ownership and candidate identity until reconciliation. Remove only known owned temporary files after their processes stop. Retain uncertain recovery state; never delete another process's lock or run maintenance automatically.

The exact protocol, bounds, and source evidence are in `contracts/operations.md` and `research.md` R3/R4.

## Qualification sequence

1. Generate and analyze upstream tasks from the selected graph and mutation designs. Keep their required proof cases explicit.
2. Declare minimum dependency versions, commit the lockfiles, and verify the existing native toolchain. Do not install duplicate tools.
3. Establish the four source boundaries and package a minimal Tauri/Bun handshake as a standard-user installer.
4. Qualify framing, origin checks, startup hardening, cancellation, and process cleanup before enabling repository mutations.
5. Add Git-derived identity, bounded inspection, and the shared frontend. Verify real fixtures and native interaction.
6. Enable hunk, file staging, commit, and submodule update pathways only after their blocking proof cases pass.
7. Run installed release-build qualification and matched Git Extensions measurements.
8. Record failures, causes, remedies, and retests in `research.md`. Keep public release blocked on deferred signing/update gates.

This sequence is planning guidance, not a generated task list or permission to implement now.

## Real-repository fixture matrix

Use disposable repositories under an explicitly owned temporary root. Never target developer repositories. Isolate fixture identity, signing, hooks, and configuration from the user's environment. Fixture runs of the installed app on the reference host start through the T151 launcher. These are T149, T153, T160 to T163, and T237. T151 therefore belongs to batch 4. The T155 clean environment and the T165 measurement account are isolated by design and do not use the launcher.

| ID | Fixture | Required evidence |
| --- | --- | --- |
| F01 | Empty and unborn repositories; first added text; empty files. | Correct empty history, entry existence, first commit, and unavailable metadata-only hunk actions. |
| F02 | Multiple hunks; one path staged and unstaged; unrelated staged paths. A racy variant changes a file with the same size in the second of the last index write. | Exact selected hunk and unchanged unrelated index entries and working bytes. Stage file and Unstage file give the index of `git add` and `git restore --staged` in a disposable copy. In 20 runs of the racy variant, Stage file stages the new bytes. After a hunk publication, `status` still shows an unrelated racy change (contract §4 "Candidate time"). |
| F03 | `space dir/雪 café.txt`, option-like names, bracket names, and missing final newlines. A working path of 260 or more UTF-16 units, a case-only rename, and two case-colliding index paths. | Literal path identity and exact bytes. Use names valid on Windows. Record long-path results as observed, and never change `core.longpaths`. Record whether Bun reads paths of 260 or more UTF-16 units and returns the on-disk letter case. |
| F04 | LF, CRLF, and mixed files under each `core.autocrlf` value, `core.eol`, `core.safecrlf`, and `text`, `text=auto`, `-text`, `eol`, `crlf` attributes. | Canonical index bytes match the `git add -p` result, and raw working bytes stay unchanged. Mixed files and normalization-only differences offer no hunk action. Record how the service gets Git-normalized content for untracked-file hunks, because `git diff --no-index` may skip attribute conversion. A candidate `diff` form carries `--no-ext-diff --no-textconv`, and a `filter` attribute refuses before any candidate runs (contract §4). T092 runs this probe before the T093 tests. A case that no method matches gets no hunk action. SC-003 then records that case as `fail`, and the requirement does not change. Stage file equals `git add` in every accepted case, including a CRLF blob in the index under `core.autocrlf=true`. Proof A accepts that case, and proof B accepts mixed files and `ident` (contract §4 "Blob proof"). Two cases refuse with reason `blob-proof` and the `add` remedy. They are an `eol` attribute that only the index holds, and a CRLF blob with `ident`. With `core.safecrlf=true`, a mixed file gives `GIT_FAILED`, as `git add` refuses it. |
| F05 | Rename, binary, invalid UTF-8, mode/type change, symlink, submodule, LFS, custom filter, and encoding conversion. | Accurate metadata and explicit refusal of unsupported hunks without fallback. Stage file accepts binary, invalid UTF-8, encoding conversion, and a reported mode change. Unstage file restores both paths of a staged rename. Type change, symlink, submodule, LFS, and custom filter refuse the file action with their reason, and no filter canary runs. No Git process starts inside a submodule during superproject reads, with a canary in the submodule's local configuration. Record whether `diff-files -z --ignore-submodules=dirty` starts no child when the submodule HEAD matches the recorded commit. |
| F06 | Added/deleted text; staged deletion followed by untracked replacement. | Correct comparison scope and entry creation/removal. Stage file removes a deleted file's entry and adds an untracked file. In an unborn repository, Unstage file equals `git rm --cached`. |
| F07 | Two linked worktrees, distinct indexes, shared refs; junction aliases. A submodule checkout opened directly, a separate Git directory, a bare repository, and a `.git` file with a missing target. | Correct worktree identity and conservative common-repository exclusion. |
| F08 | SHA-1, SHA-256, detached HEAD, and same-OID branch changes. | Correct OID parsing, baseline, and symbolic-target validation. |
| F09 | External file/index/ref/attribute/configuration changes before each validation checkpoint. | Refuse handoff/publication; no silently relocated hunk or overwritten external bytes. |
| F10 | Existing locks, conflicts, merge/rebase/cherry-pick/revert state, split/sparse indexes. `core.splitIndex=true` at local and at global scope with an unsplit index, and `GIT_TEST_SPLIT_INDEX=1` in the service environment. Intent-to-add, assume-unchanged, and skip-worktree entries, including a sparse checkout with a full index. | Explicit blockers; no lock removal, repair, or unqualified mutation. Each split index and each `core.splitIndex=true` refuses hunk and file actions with reason `split-index`. Git never gets `GIT_TEST_SPLIT_INDEX`, so that case stages. No case writes a `sharedindex.*` file. Refuse hunk and file actions on flagged entries, and keep every unrelated entry's flags. Record how the service detects intent-to-add entries; porcelain v2 status `.A` is assumed. Record whether `apply --cached` keeps flags on unrelated entries. |
| F11 | Traditional/configured hooks, disabled registrations, post-index-change, executable fsmonitor, and changing/rejected commit hooks. Terminal-input variants: a `pre-commit` hook that reads `/dev/tty`, and one that runs `git credential fill` for an `https` host without a helper. Console variants (research R14 S17): a hook that runs `powershell.exe -NoProfile -Command "Read-Host -AsSecureString x"`. Another runs Windows OpenSSH `ssh-keygen -y` on a passphrase key under the owned root. | Refuse unsafe hunk and file staging profiles; preserve normal commit hooks, real index effects, drafts, and truthful outcomes. A rejected commit shows a bounded, sanitized, redacted output tail. The pre-commit remedy command creates no commit. Each terminal-input hook fails within 10 seconds, far below the 120-second commit deadline. The commit gives `HOOK_FAILED` with the hook's output tail, and no window or console appears (contract §6 "Console and input"). Each console variant shows the stall notice with Cancel and the pre-commit command. It appears 15 to 17 seconds after the last activity. It waits until the commit deadline, and a test can inject a short one. The Job then closes with every descendant, no commit exists, and the outcome reconciles. |
| F12 | Missing identity, signing failure, blank message, empty index, repeated submission, and non-UTF-8 `i18n.commitEncoding`. A commit that triggers automatic maintenance through local `gc.auto=1`. | No bypass or configuration change; no duplicate commit. Record whether the commit process waits for maintenance and how long it runs. A detached maintenance process keeps running after the commit and ends at application close. |
| F13 | Cancellation before/during/after publication; delayed completion; failed reconciliation. | Exact resulting state; no false rollback or automatic retry. |
| F14 | Slow real Git work, descendant-spawning hooks, service crash, shell crash, and shutdown. A hook grandchild that holds no inherited pipe and outlives its parent. A read with local `core.fsmonitor=true` and no running daemon. A `post-commit` hook that starts a sleeping background child. The child inherits stdout and stderr and writes to both after Git exits. A variant child holds a ref lock. | Owned process cleanup within five seconds; unrelated Git and agents survive. The orphaned grandchild and any daemon that a read started also end. The `post-commit` child outlives its commit, the outcome records one lingering descendant, and application close ends it within five seconds. The commit completes at Git's exit, and the late output appears nowhere. The ref-lock variant makes the next commit give `GIT_FAILED` with the lock path and the lingering count. Revoke trust ends the child and reports the count. Record whether WebView2 processes exit after a shell crash. |
| F15 | Removed/inaccessible repositories, sharing violations, and full disposable volume. A repository that another account owns. A plain folder outside every repository. Dubious-ownership stderr captured from Git with `GIT_TEST_ASSUME_DIFFERENT_OWNER=1`, in a folder named `x'$(ni <marker>)'` and in one folder per PowerShell quote character. | Actionable failure and preserved data. Never fill or alter the developer's volume. The plain folder, the other-account repository, and each dubious-ownership folder give `REPOSITORY_UNAVAILABLE`. Each refusal names the selected folder, shows the remedy "Run `git status` in this folder", and holds Git's message in the output tail. No command is offered, and no marker appears (contract §6 "Registration bootstrap"). |
| F16 | Exact 1 MiB/20,000-line boundaries and values above them; oversized status/history; malformed records. A 512 MiB working file and one of 512 MiB plus 1 byte. | Complete framing or explicit limits; no mutation from incomplete data. The 512 MiB file stages within the Git step deadline, and the larger file gets reason `size` with its remedy. |
| F17 | Malicious markup, diagnostic credential canaries, hostile runtime variables, `.env`, and `bunfig.toml`. Repository-scope `filter.<driver>.clean`, `filter.<driver>.process`, and command-valued `core.fsmonitor` with an execution canary. The clean-filter program lives inside the worktree at `tools/clean.sh`. A partial clone with missing blobs and a local `remote.origin.uploadpack` canary. One variant moves HEAD with `reset --soft` to a fetched commit whose blobs the clone lacks. Untracked-read canaries for `diff.external`, `diff.<driver>.textconv`, and a clean filter. | No active content, runtime injection, arbitrary commands, or credential-bearing logs. No canary runs before trust approval. The uploadpack canary never runs, also after approval; affected reads give `OBJECT_MISSING`. Unstage file shows `OBJECT_MISSING` with no file action and no fetch. A commit whose summary would need a missing blob exits 0 with `--quiet`. |
| F18 | Missed watcher notifications and externally completed changes. | Foreground update within two seconds after a watcher hint. The change check covers a missed hint for the index, HEAD, the current branch ref, and the selected working file. In a reftable repository, it reads the `reftable/tables.list` files for HEAD and refs. Those also update within two seconds. A missed hint for another working file recovers on focus return or manual refresh. |
| F19 | Linear, merge, octopus, skewed-date, root, shallow, cutoff, SHA-256, and wide-lane history. A commit with a legacy `encoding` header. | Exact Git parent relationships; explicit boundaries/limits; no fetched objects or invented branches; keyboard and density alignment. Invalid UTF-8 subjects and authors show replacement characters and an encoding label. |
| F20 | Changes after final hunk validation or commit handoff; competing commits, ambiguous attribution, and reference/reflog evidence overflow. | Preserve external bytes; report completed/failed-with-effects or unknown; retain drafts and never retry or undo automatically. Exercise 4 MiB and 10,000-record limits independently. Status-only success cannot unblock unknown attribution; require successful recovery reconciliation. Recovery reconciliation with unknown attribution states that outcome and then enables mutations. |
| F21 | WSL repository in the Linux file system of a WSL2 distro with Git 2.55.0 or later. The path holds spaces, `$`, and `é`. It is opened through `\\wsl$\`, `\\wsl.localhost\`, an upper-case prefix, and a lower-case distro name. It has a linked worktree, the F02 changes, a binary file, and a `pre-commit` hook. | One `repositoryId` for every path form, and the "WSL: <distro>" label. Status, history, comparisons, hunk and file staging, and a commit match the distro's Git. Working bytes stay unchanged. No Windows `GIT_*` value, also one that `WSLENV` names, reaches Linux Git. A focused change inside the distro shows within 4.5 seconds. |
| F22 | A stopped WSL2 distro that holds an F21 copy. The tester stops only a dedicated test distro before the run. Start-order variant: two dedicated test distros, each with an owned folder under the distro user's home folder. No WSL fixture lives in `/tmp`, because each distro start empties it (research R13). | "Starting WSL distro <name>…" with Cancel. Cancel leaves the workspace unchanged, and the app stops no distro. A later open succeeds. Before the result counts, the F21 copy folder still exists after the restart with its recorded inode. Otherwise the step stops with `fixture-lost`. Record the start time. The start-order variant starts both distros in both orders. Each folder keeps its identity and its `worktreeKey`. Record each `stat %d` value and each file-system ID, read right after each start (T252). |
| F23 | A distro name that WSL does not list, a WSL1 distro, and a computer without WSL. A distro without a systemd user manager, a distro without `setsid`, and a distro without `/usr/bin/stat` or `/usr/bin/env`. | `WSL_UNAVAILABLE` with reason `distro-missing`, `not-wsl2`, `wsl-missing`, `no-user-manager`, `no-setsid`, or `no-coreutils`, each with its remedy. The clean-install environment covers the computer without WSL. A case that the host cannot create stays `unverified`. |
| F24 | Distro Git below 2.55.0; the reference distro has 2.43.0. A `git` command that resolves to Git for Windows through interop, in a dedicated test distro. | `GIT_UNSUPPORTED` with reason `version` and the text "Git 2.43.0 in <distro> is older than 2.55.0". Reason `windows-git` for the interop case. No Git work starts. |
| F25 | WSL hooks that start a plain background child, a `nohup` child, and a `setsid` child. A slow hook for cancellation and deadlines. A `pre-commit` hook that reads `/dev/tty`. | All three children linger after Git exits, as on Windows, and the outcome counts three. Revoke trust or close ends them within five seconds. The `/dev/tty` hook fails within 10 seconds, and the commit gives `GIT_FAILED` with its output tail. Cancellation, a deadline, and a service crash leave no process of the operation. `pgrep` in the distro confirms each case, and no `arbareto-*` scope remains. |
| F26 | A repository under the distro's `/mnt/c` mount opened through the WSL prefix. A Windows worktree whose Git directory lies in WSL. A Linux folder name with `:` and an entry name with `\`. | `UNSUPPORTED_REPOSITORY` with reason `mixed-location` for the first two, and reason `wsl-path` for the folder. The entry shows reason `path` and no hunk or file action. |
| F27 | Local bare submodule remotes under the owned root. A superproject clone with two uninitialized top-level submodules, one of which holds a nested submodule, two levels deep. Variants: a submodule behind its recorded commit with the commit present, and one whose recorded commit needs a fetch. Also a deinitialized submodule with a kept Git folder, and an uninitialized one with `.gitmodules` `update = none`. Also the paths `sub[1]` and `sub1`. A kept-remote variant: a deinitialized submodule whose kept Git folder lacks the recorded commit. Its `remote.origin.url` names a missing folder, and a second remote holds the `.gitmodules` URL. A copy without the second remote shows the differs note. Paths with spaces and `é`. A review-only URL with `https://u:TOKEN@host.example/`. Unreachable-target variant: an initialized submodule holds its recorded commit, but no ref reaches it (research R14 S19). Headless-kept variant: a kept Git folder has no HEAD commit (research R14 S27). Its nested kept Git folder holds a canary. The test's owned global file sets `protocol.file.allow=always`. | The notice lists the submodules, and no Git process starts inside them during reads. The review shows each action, note, and nested row, and `<redacted>` for the token URL. The update equals `git submodule update --init --recursive` in a copy: HEADs, Git folders, and configuration keys. `:(literal)` reaches only `sub[1]`. A stored superproject approval stays `approved`. The kept-remote row lists both remotes, redacted, and marks `origin` as the default. Its update equals Git's own update in a copy. The `origin` fetch fails, and the fetch by commit ID from the second remote succeeds (research R14 S12). The unreachable-target row is `fetch-checkout`. It fetches, then checks out, as Git's own update does in a copy. The `update = none` row gets the `submodule.*` keys of Git's own update and no clone. The headless-kept row runs its clone step, the nested canary never runs then, and the result equals Git's own update. |
| F28 | Submodule safety cases: a detached HEAD with a commit that no ref holds. A local `submodule.<name>.update` of `merge`, `rebase`, and `!<canary>`. Also a `.gitmodules` `update = !<canary>`, a gitlink without a `.gitmodules` entry, and an interrupted clone state. Also a submodule with a local edit that its target commit changes, beside a submodule that needs a move. An explicit `active=false` without `submodule.active`, and a `submodule.active` pathspec. Active-value variant: a `submodule.<name>.active` value that is no Git boolean. A deinitialized submodule whose kept Git folder holds a commit that no ref holds. Folder variant: an initialized submodule with a modified tracked file and an untracked file, whose `.git` file is then deleted. Moved-folder variant: the interrupted clone state, whose whole folder the test moves out of the repository. Path variant: a gitlink whose path holds invalid UTF-8 bytes, written through `update-index -z --index-info`, with a `.gitmodules` entry. Prune variant: only `refs/remotes/origin/feat` holds the submodule HEAD, and local `fetch.prune=true` is set. The remote deletes that branch, and the target needs a fetch (research R14 S15). Keep variant: the same layout without `fetch.prune` (research R14 S20). Remote-name variant: a kept Git folder that needs a fetch holds a remote named `--upload-pack=<canary>` (research R14 S31). Unregistered-block variant: an initialized submodule without `submodule.<name>.url` in the superproject configuration holds a local edit that blocks its checkout. | Each refusal gives `UNSUPPORTED_SUBMODULE` with its reason and remedy, and nothing changes. The folder variant gives `folder-not-empty`, and both files keep their bytes. The moved-folder variant updates to the recorded commit, and the moved folder keeps every byte. The path variant gives `path`, and no process starts. The prune variant passes the review. Its fetch removes the ref, so the row ends `refused` with `unsaved-commits` and no checkout. Its HEAD stays, and the outcome is `completed-with-effects`. The keep variant fetches, passes the check, and moves. The `!<canary>` never runs. The blocked submodule keeps its HEAD and edit, the other moves, and the outcome is `failed-with-effects`. The review notes the activation, and the pathspec case shows `skip`. The remote-name variant gives `remote-name`, and the canary never runs. The unregistered-block row ends `failed` with `registered`, and the outcome is `failed-with-effects`. |
| F29 | Canaries in an initialized submodule and its nested submodule cover `core.fsmonitor`, and clean and smudge filters with an attribute. They also cover every traditional hook, `core.sshCommand`, `credential.helper`, and `remote.origin.uploadpack`. A hook that prints `https://u:TOKEN@host.example/`. An `ext::<canary>` URL, and a `file` URL with an owned global file without `protocol.file.allow`. Kept-folder variant: a deinitialized top-level submodule keeps its Git folder and its nested Git folder, each with the same canaries. A third variant keeps the Git folder of a deinitialized nested submodule inside an initialized submodule. A non-Git folder and a submodule name with `/` sit under `modules`. Gitdir-config variant: one copy enables `extensions.submodulePathConfig`, and another sets one `submodule.<name>.gitdir` to a folder outside `modules`. A third copy sets one `submodule.<name>.gitdir` in the Git folder of an initialized submodule. Each holds the same canaries. Relative-hooks variant (research R14 S14): an owned global file with `core.hooksPath=.githooks`. The submodule remote holds `.githooks/post-checkout` and `.githooks/reference-transaction` canaries that differ between commits. The variant has a `clone` row, a `reuse` row, a `checkout` row, and a `fetch-checkout` row. Nested-programs variant: an approved `post-checkout` canary of a submodule adds a `core.fsmonitor` canary to the configuration of its nested submodule. Row-programs variant: the approved `post-checkout` canary of the first row changes a hook file of the second row. | No canary runs during the review or before the native Run confirmation. The gitdir-config copies refuse with `UNSUPPORTED_SUBMODULE` reason `gitdir-config` and the terminal remedy, and nothing changes. The first two remedies have no path. The third names that submodule path, and its remedy is the update command for that path. The program list holds every kept-folder canary with its origin and digest, and the non-Git folder adds none. A declined confirmation starts no process. The `ext::` canary never runs, and both transports fail with a redacted output tail and a remedy. The hook sees `GIT_TERMINAL_PROMPT=0` and `GIT_NO_LAZY_FETCH=1`. In the relative-hooks variant, each of the four rows lists an `unchecked` hooks directory, and `confirmRun` goes out. No canary runs before Run. After Run, the target-tree canaries run. In the nested-programs variant, the nested row ends `refused` with `programs`, and the added canary never runs. The other rows update. In the row-programs variant, the second row ends `refused` with `programs`, and the changed hook never runs. |
| F30 | A 300 MB submodule remote. A submodule `post-checkout` hook that sleeps 330 seconds without output. In-process tests inject a short inactivity deadline instead. A hook that starts a background child. Silent-fetch variant: the recorded commit of an initialized submodule adds the 300 MB file. Its row then runs a silent `git fetch` (research R14 S16). Stall variant (research R14 S24): a submodule `core.sshCommand` with arguments runs Windows OpenSSH `ssh-keygen -y`. It reads a passphrase key under the owned root. The remote URL is `ssh://localhost/x.git`. In-process tests inject a short stall threshold. | Cancel during the clone reaches a reconciled state within five seconds and reports `clone-interrupted` with the folder path. No file is removed, and the next review refuses with that reason. The inactivity and ceiling deadlines give `DEADLINE` with their reason. The background child lingers, counts, and ends at close. The silent fetch writes no output byte for longer than an injected 3-second limit. It still completes, because its Job I/O sum changes. The stall variant shows the stall notice with Cancel and the fetch command. It appears 15 to 17 seconds after the last activity. Cancel ends the Job, and no log holds output. |
| F31 | An F27 and F29 copy in the Linux file system of a WSL2 distro with Git 2.55.0 or later. A hook that tries to open `/dev/tty`. A hook that sleeps 60 seconds without output. | The same results through the distro Git, with clones inside the distro. The hook cannot open `/dev/tty`, and it sees `GIT_TERMINAL_PROMPT=0`. `pgrep` finds no process of the operation after cancellation or close. The sleeping hook shows the stall notice within 20 seconds through the anchor I/O sum. |
| F32 | Mode-switch fixture (SC-012): an F02 copy with 150 linear commits and 60 more unstaged text files. So the History list and the Unstaged list both scroll at 1280×800. The F02 path keeps two unstaged hunks. | The open shows History with no selected commit. Select a commit and scroll History to row 60. Press Ctrl+1. Select the F02 path in Unstaged and its second hunk, scroll Unstaged to row 40, and type a draft. Ctrl+2 and then Ctrl+1 restore the entry, its scope, the hunk selection, the scroll anchor, and the draft. Focus stays on the active mode tab, and F6 reaches the last focused target of each section. Then press Ctrl+2, and an external process appends one line to the F02 path. Ctrl+1 restores the entry, its scope, the scroll anchor, and the draft. No hunk shows the selected bar, and the comparison shows the change notice. Stage selected hunk stays disabled until a new hunk selection. Ctrl+2 restores the selected commit and its scroll anchor. |

The harness can control race barriers, but must still execute real Git. Mocks and process exit codes cannot qualify mutations.

For each mutation, compare the full logical index, selected blob bytes, all fixture working-file bytes, refs, and operation markers. Distinguish application effects from deliberate external-writer effects.

## Windows installation and native checks

Use an NSIS current-user package with explicit prerequisites. Label unsigned local artifacts “Unsigned local test package”. Package identification means the installer file name and the Windows Apps (Add or Remove Programs) entry. The pinned NSIS template writes the entry name `DisplayName` from `productName` `Arbareto` (installer.nsi:702). The bundle identifier is `io.github.auric.arbareto`; it does not change for the label. It then runs the `NSIS_HOOK_POSTINSTALL` macro (installer.nsi:734-735). The installer hook file of T008 rewrites `DisplayName` to "Arbareto (Unsigned local test package)". The template never reads `shortDescription` or `longDescription`. The installer file name comes from `productName` and the version (nsis/mod.rs:653-658), so it carries no label. research.md R7 cites these lines.

Qualify installation, launch, upgrade, uninstall, and reinstall under a clean standard-user account. Do not remove development runtimes from the current workstation. The clean environment has no Bun, so build the fixtures on the reference host with T141. Copy them into the clean environment with a SHA-256 manifest, and verify the copies there with `Get-FileHash`. Offline, stage and unstage a hunk and a file, then commit, in F02 and in an F07 linked worktree. Copy the fixtures back to the host and verify them with the T141 `--snapshot` command. F07 copies use relative worktree links (`git worktree add --relative-paths`), so the links survive the move.

A SmartScreen prompt for the unsigned package is expected and does not fail B-WINDOWS. Record a policy block as an environment limitation.

Upgrade and uninstall keep native settings and webview data. The uninstaller's Delete app data option removes both application data folders, including WebView2 data. This slice writes no log files. Its allowlisted logs (contract §7) stay in memory. Record the default state of the Delete app data option.

The shell treats OS build 22000 or later with product type `VER_NT_WORKSTATION` as Windows 11. Both values come from `RtlGetVersion` with `RTL_OSVERSIONINFOEXW`. A server product type gives scope `other`. It reads the native machine with `IsWow64Process2`. Record whether `IsWow64Process2` reports the native ARM64 machine under x64 emulation.

Use a disposable clean Windows 11 x64 environment for clean-install checks: a Hyper-V VM or Windows Sandbox. Choose one option before batch 5. For the Hyper-V option, assign four virtual CPUs, 8 GiB RAM, and a 64 GiB disk. Record the choice, its exact OS image, and its settings before execution.

Test these prerequisite states separately:

- Git and WebView2 already installed at the qualification versions; installation and ordinary work remain offline.
- Missing Git; the app blocks Git work and provides explicit selection/install guidance.
- Missing WebView2; the installer/native startup reports the prerequisite without a blank window. Microsoft ships the Evergreen Runtime as part of Windows 11, and no verified method removes it. The packaged case stays `unverified` until a Windows 11 image without the runtime exists.
- Unsupported versions; the app reports the exact detected version and blocked capability.
- Git removed or replaced after selection; no silent substitution occurs.
- Standard-user paths contain Unicode and spaces; no unexpected elevation or machine-wide writes occur.

Do not bundle Git. Initially require preinstalled WebView2; use no hidden runtime download. Record bootstrapper, offline-runtime, and fixed-runtime alternatives in research.

Native checks cover folder accept/cancel, focus restoration, Unicode clipboard, shortcuts, resize/snap, both densities, both themes, and IME composition. Include keyboard pane resizing and Changes/History context restoration. Run at 100%, 150%, and 200% scaling, including mixed-scale display transitions. Also run at the Windows text sizes 150% and 225%. Use the frontend window profiles and UI-01–UI-19 capture cases above.

Use a real two-display environment for mixed-scale checks. A single-display browser emulation cannot pass them. Record any unavailable equipment as unverified.

## Fixed release-build measurement protocol

### Reference hardware and fixtures

Use the physical reference recorded in `research.md`: Ryzen 7 5800H, nominal 32 GiB RAM, and Samsung 970 EVO Plus NVMe. Use Windows `10.0.26200.9457`, the recorded drivers, and the admitted WebView2 version installed at run time for the initial series. The reference host runs WebView2 `154.0.4258.37` on 2026-09-29.

Connect AC power. Use Balanced power mode without battery saver. Keep Defender enabled and record its engine/signature versions. Record thermal state and background activity; do not disable security software to improve results.

| Fixture | Fixed construction |
| --- | --- |
| M: moderate | 10,000 tracked files, 5,000 commits, 32 refs, and approximately 20 MiB checked-out content. |
| L: large history | 50,000 tracked files, 100,000 commits, 256 refs, and approximately 100 MiB checked-out content. |
| Commit-graph variants | T164 builds M and L in two variants: with a commit-graph file and without one. The maintained variant has the file. Research R6 records the user decision of 2026-10-04 for L, and M follows the same rule. Every M and L budget row uses the maintained variant. So does every SC-015 condition on M or L, for both applications. M-D copies the maintained M. W-M keeps its construction from the `fast-import` stream. T192 records both variants, and no comparison series uses the variant without the file. When a history read must walk the whole graph, Arbareto shows a copyable remedy. Its form is `& '<selected Git path>' --no-lazy-fetch -C '<worktree root>' commit-graph write --reachable`, quoted by the T262 builder (contract §4 quoting rule). The app never runs it. The trigger rule, its contract clause, and its task stay open. They follow the contract §6 and §7 changes after T280 to T283. |
| M-D: large diff | A copy of M plus one modified UTF-8 text file of 10,000 lines, at most 100 bytes each. Lines 501 to 9,500 change, so the diff stays below the FR-010 limits. Only SC-015 workflow C5 uses it. |
| W-M: WSL moderate | A copy of M in the Linux file system of a WSL2 distro with Git 2.55.0 or later. T245 builds it from the M `fast-import` stream in the owned fixture folder in the distro user's home folder. It never lies in `/tmp`, which each distro start empties (research R13). Only the WSL rows use it. |
| Shared changes | 10 staged paths, 10 unstaged paths, 10 untracked paths, and one path with both staged and unstaged hunks. That path has two staged hunks and one unstaged hunk (C6, C9). One unstaged path is the C8 file `perf/c8.ts`: 300 lines of TypeScript, each at most 80 bytes. Lines 100 and 200 each change in place, which gives two hunks. With 3 context lines, its unified diff holds 18 rows ("C8 rows" in §Matched-condition comparisons). |
| Reproducibility | Fixed seed `42`, fixed identities/timestamps, fixed attributes, and recorded semantic fixture digests. Commit timestamps start at 2020-01-01T00:00:00Z and advance 1 second per commit. So all M and L commits fall before 2020-01-03T00:00:00Z. The C7 author and committer dates are 2020-01-03T00:00:00Z ("Relative dates" in §Matched-condition comparisons). |

Create deterministic history with native Git fixture tooling. Use independent identical copies for each candidate. Record actual object, file, commit, and byte counts before testing. Also record whether each copy holds a commit-graph file. M, M-D, L, and W-M contain no linked worktrees.

### Measurements and budgets

| Metric | Boundary and repetitions | Qualification budget |
| --- | --- | --- |
| Cold usable workspace (SC-006) | Process creation to the History-ready frame defined below. These are the C1 and C13 Arbareto runs (§Matched-condition comparisons). They give 10 counted runs on M and 5 on L, each after a reboot. Each fixture adds 2 Arbareto warm-up runs, one for each Arbareto block of the ABBA order (§Matched-condition comparisons, "Warm-up rule"). | Every M run at most 1.5 seconds, warm-up runs included. Report L without inventing an existing target. |
| Warm reopen (SC-006) | Confirmed repository selection to the History-ready frame, in a warm application. These are the C2 and C14 Arbareto runs: 20 counted runs per fixture and the block warm-up runs. | Every M run at most 500 ms, warm-up runs included. Report L without a target. |
| First History paint after a switch | Ctrl+2 in Changes to the History-ready frame, after the open settled, so the page is loaded. These are the C11 Arbareto runs, warm-up runs included. | p95 at most 100 ms and maximum at most 500 ms on M. |
| First Changes paint after a switch | Ctrl+1 in History to the Changes-ready frame defined below, after the open settled. These are the C12 Arbareto runs, warm-up runs included. | p95 at most 100 ms and maximum at most 500 ms on M. |
| Input acknowledgement | Input injection to first visible response during slow Git activity ("Responsiveness metrics" below). Each of typing, navigation, resize, and cancellation gets 100 counted actions. Use a copy of fixture L with the foreground poll active. A commit runs with an approved `pre-commit` hook that outlives the commit deadline. Each cancellation action cancels one such commit. An action counts only when the WPR trace shows an owned `git.exe` alive at injection. | p95 at most 100 ms for each action class. |
| UI stalls | Every probe input and every counted input of the workload list in "Responsiveness metrics" below. Renderer main-thread tasks from the WebView2 trace over the same workloads. | No input waits more than 500 ms for its first visible response. No renderer main-thread task runs longer than 500 ms. |
| External changes | External change start to visible reconciled state on M. The T244 helper records the start. Twenty runs each for file, index, and ref changes. | At most two seconds in an idle foreground workspace. |
| Cancellation | User request to reconciled or explicitly unknown state. Twenty controlled slow-operation runs. | At most five seconds. |
| Shutdown | Confirmed closure to no remaining unintended owned process. Ten runs each for idle, reads, mutations, and idle with one F14 lingering child. | At most five seconds; unrelated processes survive every run. |
| Idle memory | Entire owned process set after 30 seconds settling; sample for 60 seconds at 100 ms intervals. | p95 private bytes at most 500 MiB on M and 750 MiB on L. |
| Active memory | Same process set during workload; include short-lived process peaks. | Peak private bytes at most 1 GiB. |
| Idle CPU | Sum kernel/user CPU over the 60-second idle interval, normalized by 16 logical processors. | Mean at most 1% of machine CPU. |
| Active CPU and package size | Total CPU-seconds, peak usage, installer bytes, installed bytes, and prerequisite footprint. | Report values. No unsupported superiority claim or invented pass threshold. |
| Git processes per read | For each read kind: the Git process count, the wall time of each process, and the response bytes. The read kinds are discovery, the trust listing, `readWorkspace` with `check: "full"`, a no-change `readWorkspace` with `check: "changes"`, and `readHistory`. Count `readHistory` with its own trust listing. Also count it with the reused listing of a full `readWorkspace` of its generation (contract §7 "Shared listing"). T192 runs 20 reads of each kind on M and L, in both commit-graph variants. | Report values. No invented pass threshold. |
| Git Extensions comparison | Conditions C1 to C20 and run counts in §Matched-condition comparisons. | SC-015 covers C1 to C3, C8, C11, and C12. For each, the upper 95% bound of the median ratio is at most 0.5. For C4 to C7, C9, C10, and C13 to C20, it is at most 1.0. |

The memory and idle-CPU ceilings are additional proposed engineering limits fixed by this plan. So are the two switch rows. These two are plan budgets, not SC-006 results. Research R6 records them under their row names, and the SC-005 row of R10 cites each result by that name. A missed switch budget makes that SC-005 row `fail`. Changing any budget needs an explicit recorded trade-off.

Open and switch derivation. Every open sends `readHistory` beside the full `readWorkspace`, in the second read slot (contract §5). So SC-006 now ends at the History-ready frame, with the unchanged 1.5-second and 500 ms budgets. Before 2026-10-01, separate First History paint rows had the same figures for a History-mode open. They merged into the SC-006 rows, and no budget grew. The switch rows reuse the SC-005 figures, because a switch after a settled open starts no Git read.

**WSL budgets.** These rows use W-M with the distro running and focus on the window. They stay `unverified` until a WSL2 distro with Git 2.55.0 or later exists (research R13).

| Metric | Boundary and repetitions | Qualification budget |
| --- | --- | --- |
| WSL external changes | Change start inside the distro to visible reconciled state, with the 1-second poll. The T244 helper records the start. Twenty runs each for file, index, and ref changes. | At most 4.5 seconds (SC-007). |
| WSL full read | One poll `readWorkspace` with `check: "full"`, from request to response. Twenty runs. | Every run at most 1.5 seconds ("Freshness and reconciliation"). |
| WSL cold open | Process creation to the History-ready frame, with W-M as the retained repository. These are the 5 counted C17 Arbareto runs and the 2 Arbareto block warm-up runs. Reboot before each run, then start the distro before the app. | Every run at most 5.2 seconds, warm-up runs included ("WSL open derivation"). |
| WSL warm reopen | Confirmed selection of W-M to the History-ready frame. These are the 20 counted C18 Arbareto runs and the block warm-up runs. | Every run at most 4 seconds, warm-up runs included. |

WSL open derivation. Each `wsl.exe` start took about 150 to 260 ms, and a scope start 213 to 257 ms (research R13). The budget adds 200 ms for each serial `wsl.exe` stage on the critical path to the Windows budget. Calls that run in parallel count as one stage. The cold path has six stages:

1. The distro list calls (contract §11 "Distro checks").
2. The Git probe of the distro (contract §11 "Git per distro").
3. The discovery queries (contract §6).
4. The identity `stat` probe (contract §11 "Paths and file access").
5. The trust listing (contract §7).
6. The full read, with `readHistory` beside it.

The warm budget assumes that a reopen does not repeat the Git probe. Contract §11 runs one bootstrap probe per distro. So it has five stages. A repeated probe makes the warm budget stricter, not looser. Before 2026-10-06, the budgets were cold 1.5 s + 6 × 0.2 s = 2.7 s and warm 0.5 s + 5 × 0.2 s = 1.5 s. The warm budget no longer holds. The T212 stage model estimates about 15 serial stages on the reopen path: the distro list, the Git probe, four discovery queries, the identity, the shell identity reread, the first full read, and `readHistory` beside it. P10 rejected pre-started `wsl.exe` processes (research R13 "Probe P10"). So the user set the warm reopen target to 4 seconds on 2026-10-06 (spec Clarifications), and T245 confirms it. The cold budget keeps the cold-minus-warm difference of the formula above: the Windows difference (1.5 s − 0.5 s) plus the one extra cold stage (0.2 s). Cold: 4 s + 1.0 s + 0.2 s = 5.2 s. The budgets stay fixed when an implementation adds stages, and a miss stays `fail`. SC-015 C17 to C20 compare W-M with Git Extensions (§Matched-condition comparisons).

Update submodules: network time has no Git Extensions comparison and no budget. Git Extensions offers the same command, but network conditions cannot match. SC-005 input acknowledgement and the UI stall budget still apply while the update runs. T167 owns stall workload 9. During F30 clones, it injects 100 counted typing actions and 100 counted navigation actions by the Input acknowledgement method. An action counts only when an owned `git.exe` is alive at its injection. Each class needs a p95 of at most 100 ms. T167 records them in the SC-005 row.

**History-ready frame (SC-006 usable workspace, warm reopen, WSL open, the History switch row, and SC-015 History conditions).** Every open ends here (FR-034). The History-ready frame is the first presented frame that shows the History mode in this state:

- The History list shows every row that fits its region at the fixed window size. Each row has its ancestry cell drawn. No commit is selected.
- The scope line shows the checkout, "Up to 100 commits", and the change counts of a complete read. That read reports `completeness` `complete` and `recoveryState` `ready`.
- Inspection controls are enabled. The Changes and History mode tabs, Refresh, Open repository, the menu bar, and all visible History rows accept activation.
- No Loading placeholder and no Refreshing marker shows.

The renderer calls `performance.mark("arbareto:history-painted")` in the first `requestAnimationFrame` callback after React commits that state (T132, T144). It calls the mark once for each repository open, History refresh, and switch to History that reaches the state.

**Changes-ready frame (the Changes switch row; C12 uses only its list panes, "C12 region").** The Changes-ready frame is the first presented frame that shows the Changes mode in this state:

- Every status list (Conflicted when present, Unstaged, Untracked, and Staged) is complete, with its count. The read reports `completeness` `complete` and `recoveryState` `ready`.
- The header shows HEAD. After an open, the comparison pane shows the No selection hint "Select a file to view its changes".
- Inspection controls are enabled. The mode tabs, Refresh, Open repository, the menu bar, and all visible status rows accept activation. None is disabled, none shows a placeholder, and no Refreshing marker shows.

Mutation controls are outside this definition. No file is selected, so no diff and no hunk control shows.

Marker and frame source. The renderer calls `performance.mark("arbareto:changes-ready")` in the first `requestAnimationFrame` callback after React commits the Changes-ready state (T132). It calls the mark once for each switch to Changes that reaches that state. The page calls `performance.mark("arbareto:boot-view")` once for each page life, when the first view after a `succeeded` environment read renders (T064, T330). That view is the boot view with the environment facts when a check blocks, or the workbench when all checks pass. T193 records whether that mark appears; it has no budget. WPR records the built-in `GPU` profile together with `tests/windows/arbareto.wprp` (T193). That owned profile enables the WebView2 ETW provider `E16EC3D2-BB0F-4E8F-BDB8-DE0BEA82DC3D` (research R6). Its `Arbareto.Light` level uses keyword `0x10000` (`blink.user_timing`), which carries the marks. Its `Arbareto.Verbose` level uses `0x10200`, which adds bit `0x200` (`toplevel`) for the task events of "Responsiveness metrics". Every timing series uses the Light level: SC-006, the switch rows, SC-007, and SC-015. So per-task tracing never loads Arbareto during a comparison. Only the stall workloads use the Verbose level. The present-event provider is `Microsoft-Windows-DXGI` from the `GPU` profile. The History-ready frame is the first DXGI Present event of the app's WebView2 GPU process after the `arbareto:history-painted` mark. The Changes-ready frame follows the same rule after the `arbareto:changes-ready` mark. Warm reopen uses the same marker and frame source. These marks time Arbareto's absolute budgets: SC-006, the WSL open rows, and the switch rows. They also cross-check the capture source below. T193 authors the profile, and T165 only confirms that the trace holds the marks and the present events. When T165 cannot confirm them, the affected rows stay `unverified`; the definition does not change.

**Capture source (SC-015, SC-005, and SC-007).** Both applications use one capture source: DXGI Desktop Duplication of the reference output. Git Extensions is a WinForms application, so a WebView2 Present event cannot time it. The test-only script `tests/windows/capture.ts` (T242) calls the API through `bun:ffi`, like `inject.ts`. It needs no installation, and no binary enters the repository. Microsoft Learn states these API facts (research R6):

- `IDXGIOutput1::DuplicateOutput` creates the duplication. By default, at most four processes can duplicate outputs in one session.
- `IDXGIOutputDuplication::AcquireNextFrame` waits for the next desktop image with a bounded time-out. It returns `DXGI_ERROR_ACCESS_LOST` after a desktop switch or a mode change.
- `DXGI_OUTDUPL_FRAME_INFO.LastPresentTime` is the QueryPerformanceCounter value of the last desktop update. So it shares the time base of `inject.ts`.
- An `AccumulatedFrames` value above 1 means that the desktop updated more than once since the previous acquired image.
- A pointer-only update sets `LastPresentTime` to 0. The script skips such frames and parks the pointer outside the region.

| Term | Definition |
| --- | --- |
| Region | One fixed screen rectangle per series: the client area of the matched window at the fixed outer bounds. C12 uses the list-pane rectangle of each application instead (§Matched-condition comparisons, "C12 region"). The script copies only that rectangle of each frame and hashes it. It records `LastPresentTime`, `AccumulatedFrames`, and the hash of each frame. |
| Mask | For each condition and application, a calibration capture records 5 seconds of the settled end state. Pixels that change there, such as a blinking caret, form the mask. Every comparison ignores masked pixels. |
| Settled frame | The last frame of a run, after 3 seconds without a region change, or at the run limit (below). It must show the end content of its condition. The first counted run of each block saves it as a lossless PNG, and the tester checks that content once. Every later run of the block must settle on the same hash. |
| End frame | The first frame after the start event from which the region equals the settled frame. Its time is its `LastPresentTime`. |
| Run limit | 30 seconds by default. It must cover each application's documented detection delay plus the 3-second settle time. C4 and C16 use 60 seconds. Git Extensions waits 1 second after a file event. It waits 30 seconds after its previous status read (GitStatusMonitor.cs:23, :28). The sum of 30 + 1 + 3 seconds leaves 26 seconds for its status read. C20 uses 90 seconds. Git Extensions polls WSL paths every 60 seconds (GitStatusMonitor.cs:36-39). The sum of 60 + 3 seconds leaves 27 seconds for its status read. |
| Δ | One refresh interval of the reference output in its current mode. DWM updates the desktop at most once per refresh, so one interval bounds the timing error of an end frame. The R6 display runs at 165 Hz, so Δ is about 6.06 ms. T165 records the actual rate. |
| Run uncertainty u | Δ by default. With `AccumulatedFrames` above 1 on the end frame, u is the gap to the previous frame when that gap exceeds Δ. |
| Invalid capture | Two kinds exist. A one-off failure comes from the desktop: `DXGI_ERROR_ACCESS_LOST` or a secure-desktop switch. A repeatable failure comes from the run: no region change after the start event, or another settled hash. Record each such run as `capture-invalid` with its cause and kind. Never drop a run silently. Each invalid counted run adds one run at the end of its block, up to 3 added runs per block. An invalid warm-up run adds no run, because no ratio uses it. It still counts toward the two end rules below. A second repeatable failure with the same cause in one block ends the block. So does a fourth invalid run. The condition then becomes `unverified` for that application, with its causes. Exception (spec Clarifications, 2026-10-01): when the ending cause is no region change in Arbareto runs, the condition becomes `missed`. Arbareto then showed no result, which is an Arbareto defect. The same cause in Git Extensions runs gives `unverified`. Another settled hash gives `unverified` for both applications. An `unverified` condition never counts as a pass, and a `missed` condition gives `fail` ("SC-015 roll-up"). Absolute rows: see "Invalid captures and absolute rows" below. |
| Start events | Input conditions: the QPC value that `inject.ts` records for the start input. Cold conditions: `capture.ts` starts the application and records the QPC value just before the process call; the WPR process-start event cross-checks it. External changes: the QPC value that the T244 helper records just before it starts the change. |
| Cross-check | For each Arbareto run with a mark, record d, the capture end time minus the time of the mark-based frame. A negative d, or a d above 2Δ, flags the run in research.md R6 for review. It changes no result. |

**Responsiveness metrics (SC-005).** Two metrics define input acknowledgement and UI stalls:

- Input response: the time from an injected input to the first captured frame that differs from the frame before it. Masked pixels do not count. The capture source above supplies it. A WebView2 DXGI Present after the input cross-checks each response frame.
- Long tasks: renderer main-thread tasks from the WebView2 trace of the `Arbareto.Verbose` level. Its keyword bit `0x200` (`toplevel`) carries Chromium's task events (research R6). A task lasts from its begin event to its end event on the renderer main thread. T193 and T165 confirm that these events appear. Without them, the long-task part stays `unverified`.

An idle page presents no frames, so a stall stays invisible without input. So `inject.ts` sends one probe input every 100 ms during each workload below. A stall longer than 600 ms then always delays a probe by more than 500 ms. The renderer long-task metric covers shorter stalls. Each workload names its probe target. A History target gets Down and Up in turn in the History list. A message target gets one typed character in the message field. It needs Changes, so the harness first presses Ctrl+1. Ctrl+1 and Ctrl+2 leave focus on the mode tab (F32). So the T240 driver moves focus to the target before the first probe and after each mode switch. Probes start when the target exists and has focus. Probe inputs never count toward the acknowledgement budget. Stall workloads run apart from the SC-015 runs.

Workload list:

1. Cold open of L as the retained repository. Target: History.
2. Warm reopen of M and of L. Target: History.
3. History refresh on L. Target: History.
4. The slow-commit and cancellation workload on L (Input acknowledgement row). Target: message.
5. Large diff display on M-D. Target: message.
6. Hunk staging, hunk unstaging, and file staging on M. Target: message.
7. Both mode switches on M. Target: History after Ctrl+2, and message after Ctrl+1.
8. External file, index, and ref changes on L. Target: message.
9. The F30 submodule clone, with the 100 counted typing and navigation actions above (T167). Target: message.
10. Cold open and warm reopen of W-M (T245). Target: History. This workload stays `unverified` until a WSL2 distro with Git 2.55.0 or later exists.

Cold timing excludes first-use prerequisite installation and manual repository selection. Retain the previously selected repository setting. Stop all owned processes before reboot.

Report every run, median, nearest-rank p95, maximum, and measurement uncertainty. Do not discard failed runs silently or replace maximum budgets with averages.

Use WPR/WPA and process accounting for CPU, lifetime, and long tasks. Take visible responses from the capture source above. JavaScript handler timestamps alone do not prove visible acknowledgement. Inject input with the test-only script `tests/windows/inject.ts` (T165). It calls `SendInput` through `bun:ffi` and records the QueryPerformanceCounter value of each input. SC-006, the WSL open rows, and the switch rows take frame timing from the WPR trace (research.md R6). SC-005, SC-007, the WSL change row, and SC-015 take it from the capture source. The frames, marks, profile, present-event provider, and capture source are fixed above. Before measurement, T165 and T242 confirm them without change.

Sum private bytes without calling summed working sets unique physical memory. Include exited children in CPU totals. Use an application-specific WebView2 user-data directory for attribution.

### Matched-condition comparisons

Git Extensions `7.2.1.7` is the SC-015 baseline. Record its .NET `10.0.10` prerequisite separately. Do not present a product baseline as an isolated shell benchmark.

Match these conditions for both applications:

- Use the reference host, power mode, Defender state, display, scale, and outer window bounds of the T166 series. Both applications use the 1280×800 DIP client size of "Chosen layout, sizes, and DPI".
- Arbareto runs in Compact density, its default, with the Windows Text size at 100%. T165 records both values.
- Use the same Git executable path, not only the same version. Confirm the image path of each started `git.exe` in the WPR process trace. For W-M, confirm with `ps -eo args` in the distro that both applications run the same Linux Git path.
- Use independent identical copies of M, M-D, L, and W-M (T164, T245). Each application keeps one copy for a whole series, at one path. Mutation runs (C6, C7, C9, and C10) restore that copy in place ("Restore start state" below). So the repository path and identity never change, and neither application registers a new repository.
- Set the Windows setting Animation effects (Settings, Accessibility, Visual effects) to Off for both applications. Off removes the window open and close animation of the Git Extensions commit dialog. So C11 and C12 time content, not animation, which is the stricter case for Arbareto. Off also gives Arbareto its reduced-motion state ("Motion"). T165 and T180 record the value.
- Run both applications under one dedicated standard Windows account. Run WPR traces from an elevated session, while both applications run under that standard account. Keep the user's own Git Extensions settings and Git configuration unchanged.
- Run one application at a time. Use `tests/windows/inject.ts`, the capture source, one region per condition, and one Δ for both ("Capture source" above). C12 is the exception: it uses the list-pane rectangle of each application ("C12 region").
- Arbareto opens every repository in History (FR-034). So C1 to C3, C12 to C15, and C17 to C19 start there. C4 to C11, C16, and C20 start in Changes. For them, the harness presses Ctrl+1 after the open settles.
- Restore start state. Before each run, the harness resets four things, in this order:
  1. Repository content. The T244 helper restores a changed file, index entry, or ref. After a mutation run, its `--restore-state` mode restores the copy from the snapshot that it took before the series. It rewrites the index file under `index.lock`, the changed working files, HEAD, and the refs. It writes contents only. It never recreates the top-level folder or the `.git` folder, so their file IDs and the trust records stay valid.
  2. Draft. The commit message is empty: Clear message in Arbareto, and an empty message box in Git Extensions.
  3. Git Extensions settings. The settings file SHA-256 equals the T180 value. Another digest stops the series, and the tester restores the file while Git Extensions is closed.
  4. Mode, selection, and focus of the condition, set through the T240 driver. "Mutation inputs" below fixes them for C6, C9, and C10. For a mutation condition, Git Extensions closes and reopens its commit dialog, so the dialog reads the restored status.
- The 60-second idle wait follows each repository content restore.
- For C7, the harness that starts both applications sets fixed `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` values: both 2020-01-03T00:00:00Z. With the restored start state and the same message, each run of one application then creates the same commit. So the settled frames of a block keep one hash. Contract §7 keeps both variables for Arbareto's Git children. Neither application starts through the T151 launcher, which removes them. No other condition shows per-run text in its end content.
- Relative dates. Git Extensions shows relative dates by default: `RelativeDate` is true. Above 365 days, its text gives the age in whole days divided by 365, as years. The source is `GetRelativeDateString` (DeepWiki answer of 2026-10-01). The fixture and C7 timestamps lie from 2020-01-01 to 2020-01-03 ("Reference hardware and fixtures"). So the year count of a shown row changes only on the days that complete 365·k days of age. No series runs within 7 days of such a day. For k = 7, those days are 2026-12-30 to 2027-01-01, so no series runs from 2026-12-23 to 2027-01-08. T180 records `RelativeDate` without a change and the date text of the top grid row.

Start the Git Extensions profile from default settings. The first launch shows first-run prompts (Program.cs:122-165). Discard and record that run. Change only these settings, and record all other values as defaults:

- `CheckForUpdates` false. The default true starts an update check (AppSettings.cs:1808-1811).
- `MaxRevisionGraphCommits` 100. The default 100000 reads all M commits (AppSettings.cs:1340-1344).
- `ShowCurrentBranchOnly` true. The default false reads all refs (AppSettings.cs:1282). Record whether the value persists after a restart. If it does not persist, the affected conditions stay `unverified`.
- `CloseProcessDialog` true. The default keeps the commit output dialog open until a click (AppSettings.cs:1274-1277, FormStatus.cs:190-192).
- `StartWithRecentWorkingDir` true. Without a command-line argument, Git Extensions then opens `RecentWorkingDir` at startup (`Program.GetWorkingDir`). So both applications restore their last repository, and neither gets a path argument. T180 opens the fixture copy once, so `RecentWorkingDir` names it.
- The window positions of the browse window and the commit dialog: both equal the matched outer bounds. So both dialogs fill the capture region.
- Git command: the executable that Arbareto uses.

Record `CloseCommitDialogAfterCommit` without a change; its default is true, so the commit dialog closes after a commit. Also record `RevisionSortOrder` without a change, with its default. It selects `--author-date-order` or `--topo-order` for the Git Extensions `git log -z` (research R2 "Git engine decision"). Also record these diff settings without a change, and confirm each default: `NumberOfContextLines` 3, `ShowSyntaxHighlightingInDiff` true, and `ShowEntireFile` false. Git Extensions passes the first as `--unified=3` while `ShowEntireFile` is false (DeepWiki answer, 2026-10-01). The DeepWiki answers of 2026-10-01 on the Git Extensions source give the last two setting names and defaults. T180 confirms them in the installed build. Record the settings file SHA-256 before and after each series. Confirm in the WPR process trace that the Git Extensions `git log` command reads at most 100 commits.

Git Extensions controls (DeepWiki answers, 2026-10-01; T180 confirms each name through the T240 driver):

- Open: Ctrl+O opens "Open local repository" (`FormOpenDirectory`). Its "Browse..." button opens the Windows folder picker through `OsShellUtil.PickFolder`. A picked folder fills the directory box and opens at once (`Load.PerformClick`).
- Commit dialog: Ctrl+Space in the browse window opens `FormCommit`. Escape closes it. When it opens with unstaged files, it focuses the Unstaged list, selects the first file, and shows its diff. The source is `LoadUnstagedOutput` (DeepWiki answer of 2026-10-01). T180 confirms this selection.
- Staging: the "Stage" button stages the selected files. In the diff viewer, S runs "Stage selected lines", and U runs "Unstage selected lines". Ctrl+2 (`FocusSelectedDiff`) focuses the diff viewer. The commands `StageSelectedFile` and `UnStageSelectedFile` are obsolete and have no key (DeepWiki answer of 2026-10-01).
- After "Stage", the Unstaged list selects the next file, and `UnstagedSelectionChanged` shows its diff. `FormCommit.Stage` calls `StoreNextItemToSelect` before and `SelectStoredNextItem` after (Git Extensions source, master `e265607b` of 2026-09-27). After the last file, Git Extensions selects the first file, and Arbareto selects the previous one. So C10 stages the first entry.
- Commit: Ctrl+Enter in the commit message commits.
- File list: Down moves the selection in the commit dialog list. `UnstagedSelectionChanged` then shows the diff of the selected file. Enter in the Unstaged list runs `Unstaged_DoubleClick`, which calls `Stage` for the selected file. Only C10 sends Enter in that list.

Mutation inputs (C6, C9, and C10). Each application gets one key press with a fixed focus. Arbareto takes the keys from "Keyboard and focus". Git Extensions takes them from the list above, and T180 confirms each one through the T240 driver. A key that T180 cannot confirm leaves its condition `unverified`.

| ID | Arbareto start state and input | Git Extensions start state and input |
| --- | --- | --- |
| C6 | The hunk is selected through Alt+Down, and focus is on Stage selected hunk. Enter activates the focused button (General controls row). | Ctrl+2 focuses the unstaged diff viewer, and exactly the lines of that hunk are selected. S runs "Stage selected lines". |
| C9 | One staged hunk is selected through Alt+Down, and focus is on Unstage selected hunk. Enter activates it. | The staged file is selected, Ctrl+2 focuses its diff viewer, and exactly the lines of that hunk are selected. U runs "Unstage selected lines". |
| C10 | The first Unstaged entry is focused and selected, and its comparison shows. Space starts Stage file (Stage key row), so the action binds the shown bytes. | The dialog selected the first Unstaged file and focused the list when it opened. Enter runs `Unstaged_DoubleClick`, which stages that file. |

Diff selection (C5 and C8). Both applications get one key press that selects the file entry and shows its diff. Arbareto: arrow keys move only focus in a file list, and Enter selects ("Keyboard and focus"). So the start state focuses the entry, and Enter is the start input. Git Extensions: the start state selects the entry above, and Down is the start input. T180 confirms the Git Extensions behavior.

C8 rows. Each C8 hunk shows 9 rows. They are one hunk header row, 3 context rows, one removed row, one added row, and 3 more context rows. The two hunks give 18 rows. Arbareto, 1280×800, Compact:

- Below the fixed rows: 800 − 40 − 32 − 32 = 696 DIPs. Beside the default tray and its splitter, the comparison pane gets 696 − 168 − 8 = 520 DIPs.
- Its heading and hunk toolbar take 32 + 32 = 64 DIPs. The diff viewport keeps 456 DIPs: 25 rows of 18 DIPs.
- Comfortable, for the bound: 800 − 116 − 192 − 8 − 72 = 412 DIPs, which hold 20 rows of 20 DIPs.
- So all 18 rows fit in both densities, with 7 or 2 rows to spare. The spare rows cover renderer rows and one reason line below the toolbar.

Git Extensions: T180 measures how many diff rows its commit dialog viewer shows at the matched bounds. The count excludes any header lines that the viewer shows above the first hunk. C8 runs only when that count is at least 18. Otherwise C8 stays `unverified` with that cause, and the C8 file never changes to fit.

Context and highlighting are fixed for both applications. Arbareto reads diffs through `diff-files -p --no-textconv --no-ext-diff --no-relative --src-prefix=a/ --dst-prefix=b/ --ignore-submodules=dirty` and `diff-index --cached -p --no-textconv --no-ext-diff --no-relative --src-prefix=a/ --dst-prefix=b/ --ignore-submodules=dirty`. Untracked files use `diff --no-index --no-ext-diff --no-textconv --no-color --src-prefix=a/ --dst-prefix=b/ -- /dev/null <path>`, whose creation patch has one hunk and no context lines. The two plumbing commands always use 3 context lines and ignore `diff.context` and `diff.interHunkContext` (research R6, probe of 2026-10-01). Git Extensions uses `NumberOfContextLines` 3. Arbareto highlights the TypeScript through Shiki, and Git Extensions keeps `ShowSyntaxHighlightingInDiff` true. The settled frame of each application includes its highlighting.

C5 target. C5 keeps the ratio 1.0. Large-diff display belongs to the workflows of the 2026-09-29 answer, which set 1.0 for every workflow outside the 0.5 group. The 2026-10-01 answer moved only the added read workflows (C8, C11, and C12) to 0.5 (spec Clarifications).

Each end frame follows "Capture source": the first frame from which the region equals the settled frame. The table gives the end content that the settled frame must show.

| ID | Workflow, fixture, and target | Start event | Arbareto end content | Git Extensions end content |
| --- | --- | --- | --- | --- |
| C1 | Cold launch, M; ratio at most 0.5 | `capture.ts` starts the application after a reboot. Arbareto restores M and opens it in History. Git Extensions starts without an argument and opens M from `RecentWorkingDir`. | The History-ready frame. | The browse grid rows that fit, each with its graph cell, and the counts on the Workspace and Index rows. No loading indicator shows. |
| C2 | Warm reopen, M; ratio at most 0.5 | Enter in the Folder box of the Windows folder picker, with the M path typed; it activates Select Folder. Another repository is open before each run. Arbareto reaches the picker through Open repository. Git Extensions reaches it through Ctrl+O and "Browse...". | Same as C1. | Same as C1. |
| C3 | History refresh, M; ratio at most 0.5 | F5 in History (Arbareto) and in the browse grid (Git Extensions). | The History-ready frame after the Refreshing marker clears. | The refreshed grid rows that fit, with the graph and no loading indicator. The Workspace and Index rows show their counts. |
| C4 | External file change, M; ratio at most 1.0 | The T244 helper starts one file write. Both applications stay idle in the foreground for 60 seconds before it. | Changes shows the changed status and its counts. | The changed Workspace row count or Commit button count. |
| C5 | Large diff, M-D; ratio at most 1.0 | The diff selection input on the large file entry ("Diff selection" above). Git Extensions uses its commit dialog list. | Diff text fills the viewport with highlighting and no loading indicator. | The same content in the commit dialog diff viewer. |
| C6 | Stage one hunk, M; ratio at most 1.0 | The C6 input of "Mutation inputs": Enter on the focused Stage selected hunk (Arbareto). S in the focused diff viewer, with exactly that hunk's lines selected (Git Extensions). | The file in Staged and the refreshed diff. | The same content in the commit dialog. |
| C7 | Local commit, M; ratio at most 1.0 | Ctrl+Enter in the commit message (both). For Arbareto, `inject.ts` then sends Enter when the T240 driver reports focus on Commit staged changes. | "Committed <short ID> to <branch>" and Staged with count 0. | The commit dialog closed and the new commit as the top grid row. The Index row shows no staged change, or it is absent. |
| C8 | Normal diff, M; ratio at most 0.5 | The diff selection input on the C8 file entry in Unstaged ("Diff selection" above). Git Extensions uses its commit dialog list. | Every row of both C8 hunks in the viewport ("C8 rows"), highlighted, with no loading indicator. | The same content in the commit dialog diff viewer. |
| C9 | Unstage one hunk, M; ratio at most 1.0 | The C9 input of "Mutation inputs": Enter on the focused Unstage selected hunk, with one staged hunk selected (Arbareto). U in the focused staged diff viewer, with exactly that hunk's lines selected (Git Extensions). | The hunk in Unstaged, one hunk left in Staged, and the refreshed diff. | The same content in the commit dialog. |
| C10 | Stage whole file, M; ratio at most 1.0 | The C10 input of "Mutation inputs": Space on the focused, selected first Unstaged entry with its comparison shown (Arbareto). Enter in the Unstaged list with that one file selected (Git Extensions). T180 confirms that both lists show the same first two entries. | The file in Staged with updated counts, and the second entry selected with its comparison shown and no loading indicator. | The file in the staged list with updated counts. The second file is selected, with its diff and no loading indicator. |
| C11 | Changes to History, M; ratio at most 0.5 | Ctrl+2 in Changes after the open settled (Arbareto). Escape in the commit dialog over the loaded browse window (Git Extensions). | The History-ready frame. | The commit dialog gone, and the grid content of C1. |
| C12 | History to Changes, M; ratio at most 0.5 | Ctrl+1 in History after the open settled (Arbareto). Ctrl+Space in the loaded browse window (Git Extensions). | The Changes lists with their counts, inside the C12 region. | The commit dialog with its unstaged and staged lists, their counts, and no loading indicator, inside the C12 region. |
| C13 | Cold launch, L; ratio at most 1.0 | As C1, with L. | As C1. | As C1. |
| C14 | Warm reopen, L; ratio at most 1.0 | As C2, with L. | As C1. | As C1. |
| C15 | History refresh, L; ratio at most 1.0 | As C3. | As C3. | As C3. |
| C16 | External file change, L; ratio at most 1.0 | As C4. | As C4. | As C4. |
| C17 | Cold launch, W-M; ratio at most 1.0 | As C1, with W-M. The tester starts the distro after the reboot and before the start event. | As C1. | As C1. |
| C18 | Warm reopen, W-M; ratio at most 1.0 | As C2, with W-M. | As C1. | As C1. |
| C19 | History refresh, W-M; ratio at most 1.0 | As C3. | As C3. | As C3. |
| C20 | External file change, W-M; ratio at most 1.0 | The T244 helper starts one file write inside the distro. The window keeps focus. | As C4. | As C4. |

C17 to C20 stay `unverified` until a WSL2 distro with Git 2.55.0 or later exists (research R13).

C7 reports one time for Arbareto: the end frame time minus the start input time, minus the driver gap g. The gap g runs from the driver's focus observation to the Enter injection, both on the QPC clock. It removes harness reaction time only; the review dialog time stays in the result.

C12 region. Git Extensions selects the first unstaged file when its commit dialog opens, and it loads that diff. Arbareto selects no file after a switch (FR-034). So the C12 region holds only the list panes of each application. For Arbareto, these are the Working changes and Staged sections with their headings and counts. For Git Extensions, they are the Unstaged and Staged lists with their headings and counts. The diff viewer of each application lies outside the region, as if masked. T180 records the Git Extensions rectangle at the matched bounds, and T242 records the Arbareto rectangle. The First Changes paint row keeps the full Changes-ready frame.

Mode-switch pairing (C11 and C12). Git Extensions shows history only in its browse window and working changes only in its modal commit dialog. So opening that dialog is its step from history to changes, and closing it is the step back. Arbareto takes the same steps with Ctrl+1 and Ctrl+2 in one window. Both pairs end at the same content class: history rows with graph and counts, or the change lists with counts. The DeepWiki answer of 2026-10-01 states that Escape in `FormCommit` starts no grid refresh. T181 records every `git.exe` that each switch starts.

Product differences. These belong to the products, and the matched conditions above still hold, so none of them is a confounder:

- C4, C16, and C20: Git Extensions waits 1 second after a file event. It waits 30 seconds after its previous status read (GitStatusMonitor.cs:23, :28, :560). For WSL paths, it polls every 60 seconds (GitStatusMonitor.cs:36-39). Do not compare a repeated change inside 30 seconds. The run limits of "Capture source" cover these delays.
- C6, C7, C9, and C10: Arbareto adds validation, candidate verification, and reconciliation (§Selected mutation protocols). C7 also includes the review dialog.
- C11: the Git Extensions grid stays loaded under the modal dialog, and Arbareto shows the page that its open loaded.
- C1 to C3 and C13 to C15: Arbareto reads history in `--date-order` (contract §3). Git Extensions uses `--author-date-order` or `--topo-order` by `RevisionSortOrder`. It shows grid rows while `git log` runs. On L, T180 records when its first grid rows show and whether `git log` had ended then. That observation shows whether its end frame comes before its full walk. So it shows whether the C13 to C15 target of 1.0 is reachable.
- C12: the Git Extensions commit dialog reads status when it opens. Arbareto shows its current snapshot and revalidates only after a change. Git Extensions also selects the first unstaged file and loads its diff. The C12 region leaves that diff load out, but its list still shows the selected file.

Do not compare input acknowledgement, stalls, cancellation, shutdown, memory, CPU, package size, installation, or first run. Their own budgets and reports above stay unchanged.

Use ABBA order: Arbareto, Git Extensions, Git Extensions, Arbareto. Every cold run follows a reboot. C1 uses cold blocks of 5 runs, so each application gets 10 counted cold runs. C13 and C17 use cold blocks of 3, 3, 2, and 2 runs, in that order. So each application gets 5 counted cold runs there (spec Clarifications, 2026-10-01). Five runs give a wider bootstrap interval than ten. The user accepted that width on L and W-M to save reboots. Every other condition uses blocks of 10 runs, 20 counted runs per application. Each block starts with one warm-up run of the same kind. A cold warm-up run also follows a reboot. Record each warm-up run apart from the counted runs.

Warm-up rule (spec Clarifications, 2026-10-01). Warm-up runs are recorded. They count toward every absolute budget that their runs serve: each "every run" bound, each maximum, and each p95. They never enter a comparison median, ratio, or bootstrap interval. So the SC-006 rows, the WSL open rows, and the switch rows include Arbareto warm-up runs. These come from C1, C2, C11 to C14, C17, and C18. SC-015 excludes the warm-up runs of both applications.

Reboot total. C1 needs 24 reboots: 20 counted runs and 4 warm-up runs, for both applications. C13 and C17 need 14 each: 10 counted runs and 4 warm-up runs. Each application gets 2 of those warm-up runs. So the cold series needs 52 reboots. SC-006 and the WSL cold open row reuse the Arbareto runs of C1, C13, and C17. So they add no reboot. An added run after an invalid capture adds its reboot ("Invalid capture").

W-M survival check. After the reboot before each C17 run, warm-up runs included, the tester starts the distro. T245 then confirms that the W-M folder exists with its recorded inode, before the start event of that run. A missing folder or another inode stops the series with `fixture-lost`. The check reuses the reboots above and adds none.

For each application and condition, report every counted run, the median, the nearest-rank p95, and the maximum. Report the warm-up runs beside them. With ten or five runs, the nearest-rank p95 equals the maximum. The median of an even count is the mean of the two middle values. With five runs, the median is the third value. Five runs allow only 126 distinct resamples per application, so their interval is coarse. Before the ratio, add the run uncertainty u to each Arbareto time, and subtract u from each Git Extensions time. The ratio is the Arbareto median divided by the Git Extensions median. The test-only script `tests/windows/ratio.ts` (T243) computes a percentile bootstrap 95% interval of that ratio. It draws 10,000 resamples with seed 42. Each resample draws the runs of each application with replacement, at their original counts. R6 labels each condition by its interval. It is `met` when the upper bound meets the target, and `missed` when the lower bound exceeds it. It is `inconclusive` when the interval contains the target. A block that "Invalid capture" ends gives `missed` or `unverified` by that rule, and no interval then applies. Only `met` counts as a pass.

Invalid captures and absolute rows. The SC-006 rows, the WSL open rows, and the switch rows use mark-based Arbareto times ("Marker and frame source"). They do not use the capture. So every Arbareto run with a mark-based time counts toward them. These are counted runs, warm-up runs, added runs, and `capture-invalid` runs. With marks that T165 confirmed, a run without its mark within the run limit exceeds every bound of its row. An Arbareto block of C1, C2, C11 to C14, C17, or C18 can end early. Its row then keeps every recorded run. A run above a bound makes the row `fail`. A block that ends `missed` for no region change makes the row `fail` too, by the stricter reading. Otherwise the row stays `unverified`, because it lacks its counted runs, with the causes of the block.

Record times, intervals, and ratios as numbers in research.md R6 and the SC-015 row of R10. Never record them as comparative adjectives (T177).

SC-015 roll-up. One rule combines C1 to C20 into the SC-015 result. Any `missed` or `inconclusive` condition gives `fail`. Otherwise any `unverified` condition gives `unverified`. Only twenty `met` conditions give `pass`. T181 records the labels of its conditions and writes no SC-015 result. T245 writes the final SC-015 row after C17 to C20. While C17 to C20 stay `unverified` (research R13), the result is `unverified`, even when C1 to C16 are all `met`.

A `missed` or `inconclusive` condition makes SC-015 `fail`, because its target is not shown to hold. An inconclusive interval never counts as a pass. Record the condition ID, its label, both medians, the ratio, and the interval in research.md R10. The miss counts under B-PERFORMANCE. It stays `fail` unless an explicit product trade-off approves a revised target. T170 records its cause and remedy, and T173 applies the attribution rule. Only a shell-attributable miss can lead to consideration of another shell. A condition that Git Extensions cannot run stays `unverified`. A condition that reaches the "Invalid capture" limit for either application is `unverified` too.

Electrobun receives no packaged measurement in this scope. A future approved comparison must reuse the same frontend, contracts, and Git-service workload.

Align Bun versions where supported, renderer versions, fixtures, and build optimizations. Otherwise disclose those differences as confounders. Measure complete process sets, installation behavior, signing, and update verification for both candidates.

## Hard blockers and evidence rules

| Gate | Failure condition | Current state |
| --- | --- | --- |
| Hunk and file staging correctness | A detected mismatch still publishes, the candidate is wrong, working content is written, or required hooks are bypassed. | Design resolved; real-Git and Windows proof cases unverified. The T092 untracked `line-endings` refusals (research R10) are refusals. They do not fail the hunk and file staging correctness gate. SC-003 stays `fail` for these cases until a product decision accepts the limit. |
| Commit outcomes | Preflight mismatch is ignored, duplicate invocation occurs, effects are hidden, or `completed-with-effects` results appear as `succeeded`. | Standard Git policy approved; real-Git and Windows proof cases unverified. |
| Graph correctness | False ancestry, missing boundary labels, inaccessible selection, or row/lane misalignment. | Design selected; real-DAG and packaged UI proof cases unverified. |
| Submodule update | A submodule program runs before its confirmation, or a refusal case changes data. A blocked transport opens, or a prompt waits. An outcome hides a changed submodule or an interrupted clone. | Design selected; real-Git and packaged proof cases unverified. Known gap: a native SSH prompt that `sh` starts waits until the inactivity deadline (contract §6, research R14 S17). |
| B-BOUNDARY | Arbitrary renderer execution, unvalidated inputs, runtime injection, or credentials in retained diagnostics. | Unverified. |
| B-LIFECYCLE | Orphaned owned processes, unrelated termination, false rollback claims, or mutations after failed reconciliation. A Linux process of a WSL operation that survives its Job close counts as orphaned. | Unverified. |
| B-INSPECTION | Incorrect identity/parsing or incomplete data presented as complete. | Unverified. |
| B-WINDOWS | Standard-user installation fails, prerequisites are misleading, or essential native actions fail. | Unverified. |
| B-PERFORMANCE | A fixed responsiveness, lifecycle, resource, or SC-015 comparison budget fails without an approved trade-off. | Unverified. |
| B-RELEASE | Required licences/notices (FR-037, SC-014), package signing, update authenticity, or tampered-update rejection lack passing evidence. An anonymous request cannot get the build commit from the Corresponding Source location. | Public release blocked. The source repository stays private until version 1 (research.md R7). |

Keep scenario results, build identifiers, causes, attempted remedies, and decision impact in `research.md`. Reference raw test artifacts by path and digest. Do not add separate qualification reports or planning hierarchies.

A failure is shell-attributable when a minimal Tauri app reproduces it. Build that app from the Tauri versions in the committed `Cargo.lock`, and record them. A trace into Tauri, wry, or WebView2 code also makes it shell-attributable. So does a documented missing shell capability. Consider another shell only after a shell-attributable B-WINDOWS or B-PERFORMANCE failure. Record each attempted remedy: a dependency version change, a configuration change, or a native workaround. A remedy is reasonable when it keeps the constitution's shell and dependency rules. The resolved Git consistency decisions do not provide evidence against Tauri. A minimal Tauri app reproduces a cold-launch miss (C1, C13, or C17) when its median cold start exceeds the bound. Measure that start from process creation to its first presented frame. An SC-015 miss in any other condition is shell-attributable only through a trace or a documented missing capability.

## Complexity Tracking

| Constraint | Why needed | Simpler alternative rejected because |
| --- | --- | --- |
| Small Rust process supervisor | Windows descendant ownership, cancellation, and crash cleanup require native Jobs. | Bun/Tauri child termination alone does not establish the required tree cleanup. |
| Native platform and WebView2 calls | The Unqualified platform label needs the native machine under emulation. Renderer failure needs WebView2 `ProcessFailed`. Browser accelerators need the WebView2 controller. | wry does not handle `ProcessFailed`. Tauri configuration has no accelerator key. The x64 service's `process.arch` reports the build architecture, not the native machine. |
| One mutation per common repository | Linked worktrees share refs and other state. | Per-path or per-worktree concurrency adds risk without measured need. |
| WSL wrapper, systemd scopes, and anchor | A Windows Job holds `wsl.exe` and its console host, but no Linux process. Detached Linux processes survived its close (research R13 P1). | A `setsid` session alone misses a process that detaches again; the wrapper uses `setsid` only to remove the terminal. A PID namespace ends lingering processes at Git's exit. A stated limit would break SC-008. |
| Service-owned diff snapshots | Staging must bind to exact Git and working-file state. | Renderer selection and patch applicability do not establish freshness. |

These choices do not waive runtime safety tests. The graph adds only bounded lane rendering, not a reusable graph framework. Add no further abstraction until a concrete requirement justifies it.
