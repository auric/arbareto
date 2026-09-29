# Implementation Plan: Windows Desktop Qualification

**Branch**: `001-desktop-qualification` | **Date**: 2026-09-29 | **Spec**: [spec.md](spec.md)

**Input**: `specs/001-desktop-qualification/spec.md` and the user's planning request.

**Status**: Planning artifacts only. Graph and mutation designs are selected. Implementation, real-Git tests, and packaged qualification remain unverified. This update does not implement application code.

## Summary

Plan one installable Windows 11 x64 qualification slice. Keep a React frontend, Bun Git service, shared contracts, and thin Tauri shell.

Compare Tauri and Electrobun using pinned source and Windows release documentation. Do not implement Electrobun. The user selected Tauri-only implementation after the constitutional scope conflict was identified.

The slice covers repository inspection, a bounded history graph, supported text diffs, single-hunk actions, and a local commit workflow. It excludes the broader product features listed in the specification.

Hunks use protected candidate-index publication with exact verification. The user approved standard Git commits after fresh preflight. Report late changes explicitly; neither preflight nor application queues freeze independent writers.

See [research.md](research.md) for the resolved design decisions, source citations, component comparison, and remaining qualification evidence.

## Technical Context

**Language/Version**: TypeScript `7.0.2`, Bun `1.4.2`, Rust/Cargo `1.98.0`. Versions are minimum versions, verified on 2026-09-29, except Bun. Bun `1.4.2` is exact, because the service executable embeds it and its source defines the startup controls that the shell removes. Native code serves IPC, Windows lifecycle, native machine detection, and WebView2 control requirements only. Native build tools: MSVC toolset `14.51.36231` and Windows SDK `10.0.26100.0`, as minimum versions. NSIS `3.11` is the version that the pinned Tauri bundler downloads and checks by hash (research.md R7). Each is the lowest verified version. On 2026-09-29, a Rust `x86_64-pc-windows-msvc` probe link on the reference host selected them (research.md R6).

**Primary Dependencies**: Minimum versions, verified on 2026-09-29: React/DOM `19.3.0`; Vite `8.3.1`; React plugin `6.1.1`; Tailwind/Vite plugin `4.3.3`. UI libraries: Base UI `1.8.0`, Pierre Diffs `1.5.1`, and TanStack React Virtual `3.14.13`. Use shadcn `4.21.0` for selected Base UI components, not a second component system.

**Desktop Dependencies**: Minimum versions, verified on 2026-09-29: Tauri/API/CLI `2.12.0`; `tauri-build` `2.7.0`; native dialog `2.8.0`; Win32 bindings `windows` `0.62.0`. Declare WebView2 COM bindings `webview2-com` `0.39.1` as a direct dependency. Declare `serde` `1.0.228` and `serde_json` `1.0.145`. Tauri's lock selects these versions at the pinned revision. Wry `0.57.0` requires `^0.39`, and Tauri's lock selects `0.39.1`. Typed Rust commands own dialogs; omit the dialog JS package. Use native `cargo-tauri`, not an unverified Node-wrapper substitution.

**Storage**: Git repositories remain authoritative. Store selected Git, last repository, and window bounds in application-owned native settings. Persist theme, density, and pane proportions as bounded webview preferences. Keep snapshots and approvals in the service session. Keep drafts and view hints in renderer memory; they survive a service restart. No database, event store, or durable operation queue.

**Testing**: Bun contract/parser tests and real disposable Git repositories. Add Rust tests for native ownership and framing. Qualify installed release builds through Windows interactions and process measurements. Browser tests cannot pass native gates.

**Target Platform**: Windows 11 x64. Initial qualification reference: 25H2 `10.0.26200.9457`, Git for Windows minimum `2.55.0.windows.3`, and WebView2 minimum `154.0.4258.37`. Both minimums are the versions on the reference host on 2026-09-29, which the batch verifications run. These are planned qualification points, not tested support claims.

**Project Type**: Local-first desktop application. No ordinary-workflow cloud account, AI dependency, Node runtime, or Electron runtime.

**Performance Goals**: SC-005 through SC-008 and SC-015, with fixed procedures and supplementary resource ceilings below. All figures remain unmeasured.

**Constraints**: One shell; no arbitrary renderer commands; minimum-version manifests with committed lockfiles and frozen installs; exact Bun runtime; bounded output; cancellation; external-change reconciliation. Supported hunk actions must preserve working bytes. Updater implementation remains excluded. Each later manifest or lockfile change needs a review record. Each package build records its tool versions (Tool and runtime boundaries).

**Scale/Scope**: One main workspace, a read-only graph of at most 100 checkout-reachable commits, and one selected comparison. Comparison sides remain at most 1 MiB, with at most 20,000 diff lines. No history search, pagination, line staging, or worktree management. Build the workbench from the selected component family; add no graph package.

### Provisional prerequisite admission

Admit Git and WebView2 from a minimum version in local qualification packages. Each minimum is the lowest verified version. The lowest verified version is the lowest version with a recorded passing packaged run on the reference host. T065 and T154 record the versions that ran. A lower minimum needs its own recorded passing run. Neither minimum is an upstream requirement or a forward-compatibility claim.

| Prerequisite | Admitted versions | Rejection |
| --- | --- | --- |
| Git | Git for Windows x64 `2.55.0.windows.3` or later. This value is the lowest verified version, not an upstream requirement. Compare `major.minor.patch` numerically, then the `windows.N` number. | Missing: `GIT_UNAVAILABLE`. A lower or unparseable version, another architecture, or an unrecognized implementation: `GIT_UNSUPPORTED`. |
| WebView2 | Windows x64 runtime `154.0.4258.37` or later. This value is the lowest verified version, not an upstream requirement. Compare the four numeric parts numerically. | Missing: `WEBVIEW_UNAVAILABLE`. A lower or unparseable version: `WEBVIEW_UNSUPPORTED`. |
| Platform | Windows 11 x64 on a native AMD64 machine: `getEnvironment` reports platform scope `qualification-target`. Windows 11 needs OS build 22000 or later and product type `VER_NT_WORKSTATION` from `RtlGetVersion`. Windows Server 2025 also reports build 26100, so the product type separates it. | Not rejected. Other builds or machines report `other` and run with the "Unqualified platform" label. No error code applies. |

“Admitted” permits qualification testing. “Qualified” requires recorded passing evidence. No admitted version of either prerequisite is tested yet. The runtime `qualification` status comes from a build-time list of version sets with recorded passing evidence (data-model §1). This slice ships that list empty, so `qualification` stays `unverified`.

Git and WebView2 versions below the minimum remain unsupported by this local test package. Show the detected and minimum versions explicitly. The repository menu shows the "Unqualified platform" label beside the selected Git version when it applies. Results from unqualified platforms never count as qualification evidence. Block dependent startup or Git operations without silent substitution, download, upgrade, or downgrade.

Use deterministic admission tests for each prerequisite. A version below the minimum is rejected. The minimum and newer versions are admitted. These strings are test inputs, not claims that corresponding releases exist.

Packaged rejection tests require a separately verified installation of a Git or WebView2 version below the minimum, or a disposable image. Record its actual version and digest. Lowering a minimum requires its own recorded passing run on the reference host. It also requires a recorded dependency review and repeated affected qualification.

Keep the clean-install environment offline after prerequisite installation. On the reference host, record Git and WebView2 versions before and after each series. A version change voids that series until the series repeats with the new recorded version.

### Tool and runtime boundaries

- Run Vite explicitly under Bun. Do not rely on its Node shebang.
- Disclose Node-engine requirements in development tools. Do not ship those tools or Node with the product.
- Compile the Bun service for Windows x64. Disable runtime configuration autoload using the verified Bun flags.
- Launch the service from an application-owned directory. Never use a checked-out repository as its startup directory.
- Use the installed Git executable selected by the user. Do not bundle Git or alter global configuration.
- Reuse installed build tools. The Windows SDK x64 libraries are present (research.md R6, 2026-09-29). Builds need at least MSVC toolset `14.51.36231` and Windows SDK `10.0.26100.0`. T001 and T154 record the versions that ran.
- Declare direct dependencies with minimum-version caret ranges and commit supported lockfiles during implementation. Install from the lockfiles unchanged: `bun install --frozen-lockfile` and Cargo `--locked`. Keep the Bun runtime exact. Generate the third-party notice inventory for every shipped package from the resolved Bun and Cargo lockfiles at build time. Bundle it with the package. Packaging fails when any resolved package lacks licence text in the inventory. The About window displays this inventory (FR-037).
- After T003 and T006, every dependency change needs a review record. A dependency change adds or removes a dependency, or changes its version, in `package.json` or `src-tauri/Cargo.toml`. A change to `bun.lock` or `src-tauri/Cargo.lock` is also a dependency change. A script-only `package.json` edit needs no record. The record goes into research.md R10 "Dependency reviews". It names the task and each added, removed, or changed package. It gives the old and new resolved versions, the licence, the reason, the reviewer, and the findings. It lists the qualification checks that ran again. A batch verification fails when a dependency change in its batch has no record.
- Every task that builds a package records the build tool versions that ran. These are `rustc`, `cargo`, `cargo tauri`, `bun`, the MSVC toolset, the Windows SDK, and NSIS. The pinned bundler extracts NSIS into `%LOCALAPPDATA%\tauri\NSIS` (research.md R7). Read its version there with `makensis.exe /VERSION`. Each version must be at least its Technical Context minimum.

## Constitution Check

**Pre-research gate**: PASS after the user selected Tauri-only implementation. Constitution `2.0.0` applies. Its 2026-09-29 amendments renamed the product and changed the Principle VIII dependency rules to minimum versions with committed lockfiles.

**Post-design gate**: Design resolved under the explicit checkpoint contract and approved standard Git commit policy. Constitution `2.0.0` applies. The design follows the amended Principle VIII. Real-repository and packaged proof cases remain mandatory; no runtime pass is claimed.

| Principle | Planning evidence | Post-design status |
| --- | --- | --- |
| I. Preserve User Data | Exact hunk effects, canonical Git commits, no bypasses, no rollback, explicit late effects. | Design conforms to the approved policy; runtime tests remain unverified. |
| II. TypeScript/Bun and Minimal Native Code | Shared TypeScript logic; Rust only for shell, IPC, Windows process ownership, and bounded platform calls. `IsWow64Process2` reads the native machine, which the x64 service cannot observe. The WebView2 `ProcessFailed` subscription covers renderer failure, which wry does not handle. The `with_webview` accelerator setting has no Tauri configuration key. Contract §6 adds `FileIdInfo` identity requests and recovery marker files. T140 calls `TaskDialogIndirect` for a safe close prompt (research R7). | Design conforms. Packaged runtime evidence remains unverified. |
| III. Validated Operation Boundaries | Typed operations, fresh checkpoints, owned index lock, bounds, and explicit handoff. | Design defined; no repository-wide atomicity claim. |
| IV. Real Git State Verification | Exact ordinary fixtures and separate controlled-writer assertions. | Test design defined; no tests run. |
| V. Untrusted Repositories | Fingerprint-bound trust; conditional mutation trust (contract §7); unsafe hunk profiles refused; approved commit hooks preserved. | No hook bypass or configuration change; runtime qualification remains unverified. |
| VI. Platform-Specific Evidence | Installed Windows checks and explicit unsupported platforms. | Unverified. No browser result counts as Windows evidence. |
| VII. Accessible and Measured Interface | Keyboard, contrast, focus, density, DPI, IME, and fixed measurements, including SC-015 matched-condition targets. | Validation defined; unverified. |
| VIII. Locked Dependencies and Shell Selection | Minimum-version manifests, committed lockfiles, frozen installs, an exact embedded Bun runtime, and immutable research citations. Matched-condition comparison methods and dependency reviews (research R10). | Tauri retained without superiority claims. Runtime qualification remains unverified. |
| IX. One Upstream Planning Process | Only this feature's upstream artifacts change. | Conforms. No custom planning tree or orchestration runner. |
| Architecture constraints | One Tauri shell and compiled Bun service; shared portable code. | Conforms to the clarified scope. |
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

`/speckit-tasks` created `tasks.md`. It holds T001 to T187. The spec records graph requirements and the approved commit clarification. Its quality checklist remains separate from implementation qualification.

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
└── windows/
```

**Structure Decision**: Use one Bun-managed project and the conventional Tauri directory. Do not add workspace machinery or multiple shell packages.

The frontend owns presentation and interaction. The service owns Git semantics and validation. Contracts define bounded operations. Rust owns native windows, restricted IPC, process lifetime, native machine detection, and WebView2 failure and accelerator control.

## Architecture and interface decisions

### Frontend

#### UI direction and scope

Make the diff the main work surface. Lists identify scope; the bottom tray prepares the complete commit. Use flat panes and useful separators, not decorative cards.

Keep native Windows caption, resize, snap, and system-menu behavior. Use one persistent repository header with View and Help menus, and a Changes/History mode bar. History includes the bounded read-only graph. Do not add AI, remote-operation, search, or future-feature controls.

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

Borrow these behaviors. History works like its revision grid: a list with a graph column is the navigation surface. Commit details sit below the list, like its `CommitInfoPosition.BelowList` option. Graph rows render individually, with a lane cap and a visible limit. A lane color differs from its neighbors. Its commit workflow uses an unstaged list, a staged list, one diff, and a message box.

Its destructive resets use a separate dialog with explicit scope (`FormResetChanges`). This applies only to future destructive actions.

Avoid these patterns. Two dense toolbars crowd the main window (issue #6361, now closed). `FormCommit` opens as a modal dialog; Arbareto keeps the commit tray in the main frame. Do not keep five panes always visible (brief line 86). `Program.cs` sets `HighDpiMode.SystemAware` (issue #6409); Arbareto qualifies per-monitor scaling. Do not let a diff toolbar cover output (issue #10358).

Keyboard differences are deliberate. Git Extensions commits with Ctrl+Enter; Arbareto's Ctrl+Enter opens Review commit for the spec's safety review. Git Extensions uses Ctrl+1–Ctrl+4 to focus commit panes. Arbareto uses F6/Shift+F6 for panes and Ctrl+1/Ctrl+2 for modes.

Git Extensions uses GPL-3.0. Borrow behavior and layout ideas only. Do not copy or port its code.

Sources: [revision graph](https://github.com/gitextensions/gitextensions/blob/e265607b631a7fd32b60c317ba096209fabf0135/src/app/GitUI/UserControls/RevisionGrid/Graph/RevisionGraph.cs#L20), [info position](https://github.com/gitextensions/gitextensions/blob/e265607b631a7fd32b60c317ba096209fabf0135/src/app/GitCommands/Settings/AppSettings.CommitInfoPosition.cs), [commit keys](https://github.com/gitextensions/gitextensions/blob/e265607b631a7fd32b60c317ba096209fabf0135/src/app/GitUI/CommandsDialogs/FormCommit.cs#L2283-L2290), [pane keys](https://github.com/gitextensions/gitextensions/blob/e265607b631a7fd32b60c317ba096209fabf0135/src/app/GitUI/Hotkey/HotkeySettingsManager.cs#L200-L203), [modal commit](https://github.com/gitextensions/gitextensions/blob/e265607b631a7fd32b60c317ba096209fabf0135/src/app/GitUI/GitUICommands.cs#L670-L678), [DPI mode](https://github.com/gitextensions/gitextensions/blob/e265607b631a7fd32b60c317ba096209fabf0135/src/app/GitExtensions/Program.cs#L49), [licence](https://github.com/gitextensions/gitextensions/blob/e265607b631a7fd32b60c317ba096209fabf0135/LICENSE.md), [#6361](https://github.com/gitextensions/gitextensions/issues/6361), [#6409](https://github.com/gitextensions/gitextensions/issues/6409), [#10358](https://github.com/gitextensions/gitextensions/issues/10358). This is source inspection; no package installation, application run, screenshot, or rendered test occurred.

#### Two feasible layouts

**A. Diff-first workspace with a bottom commit tray.** Keep changed-file groups beside a wide diff; place complete commit preparation below both.

```text
Native Windows caption
Open repository   Repository / worktree / HEAD    View   Help   Refresh
Changes | History
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
| Wide: width at least 1120, height at least 640 | Changes lane defaults to 280 DIPs. Diff fills remaining width. Commit tray spans the bottom. |
| Narrow: width 960–1119, height at least 640 | Working changes and Staged sections share a horizontal file band above the full-width diff. Commit tray remains below. |
| Constrained: width 720–959 or height 480–639 | Use the same sections in one vertically scrolling work area. History stacks the list and the inspector; the list keeps its own bounded scroll region, at least 220 DIPs high. Keep header, mode navigation, and operation status reachable. The comparison keeps its own bounded scroll region, at least 220 DIPs high. The work area never grows to the full diff height. Wheel and keyboard scrolling must not trap focus. F6 reaches every section. |
| Native minimum | 720×480 DIPs. Qualify snap regions only when their client area meets this minimum. |
| Full-workbench floor | 960×640 DIPs. Smaller supported windows use the constrained profile rather than clipped panes. |

In wide Changes mode, permit a 240–400 DIP file lane while retaining at least 520 DIPs for the diff. The commit tray defaults to 168 DIPs compact and 192 DIPs comfortable.

The tray minimum is 144 DIPs compact or 160 DIPs comfortable. Limit expansion to 35% of available height, preserving a 240 DIP wide comparison pane.

In narrow mode, the file band defaults to 128 DIPs and permits 96–160 DIPs. Keep at least 220 DIPs for the comparison pane. Pane minima include their headers and toolbars.

Clamp default sizes to available space before layout. Shrink resizable sections to their minima before using the constrained scrolling profile. Font or control measurements can require that profile even above the nominal full-workbench floor.

Working changes contains distinct Unstaged and Untracked subgroups with labelled counts. Show a separate Conflicted subgroup first when present. Staged remains a separate section. A path appears in every applicable category, including staged deletion with an untracked replacement.

Working changes and Staged have labelled headers and independent scroll positions. Their wide-mode divider can resize the allocation. Never collapse either section into an unlabelled zero-height region.

Use an 8 DIP splitter hit area with a thin visible rule. Add accessible separator names, orientation, bounds, and current values. Pointer capture must release after cancellation or lost capture.

History uses a full-width, row-aligned ancestry graph and a compact selected-commit inspector below. Show commit ID, subject, author, date, and parent relationships. Hide the commit composer without clearing its draft.

The commit tray (Changes) and the selected-commit inspector (History) share one bottom region and one remembered height. That region uses the tray bounds: 168/192 DIP default, 144/160 DIP minimum, and 35% maximum. The list above keeps its height when the mode changes. Keep at least 240 DIPs for the History list, as for the wide comparison pane.

The graph covers at most 100 commits reachable from the captured checkout. Label that scope explicitly. Do not add historical file inspection, branch filtering, search, pagination, node editing, or History mutation actions.

Clamp restored window bounds to the current work area before showing the window. Report an insufficient work area if no supported client size fits. Store pane sizes in logical units, not physical pixels. Constrained layouts must not overwrite remembered wide-pane proportions.

After DPI, density, or font changes, remeasure virtual rows and restore a valid scroll anchor. Do not remount the editor or replace its text selection. Reflow must never activate a hunk or commit action.

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
| Selected row | Text / `#2B3C54` | Text / `#DCE8FA` | Selection marker, scope label, and accessible selected state. |

Keep action blue distinct from added/removed semantics. Do not color entire panes to indicate status. The primary accent button uses Surface as its text color.

Use a two-DIP focus outline with a two-DIP offset. Reserve enough space to prevent clipping. Do not remove outlines inside Pierre's shadow root.

Hover never selects, focuses, or activates, and it never carries the only copy of information. Graph cells follow the hover state of their row.

Disabled controls use Muted text and a Divider border, with no Accent; they are exempt from the 3:1 control threshold. Every disabled mutation control keeps its visible reason text. Use Base UI `focusableWhenDisabled` for these controls.

The numeric sRGB check passed 30 selected token pairs, including text on the Selected row and Hover fill. Minimum normal-text contrast was 5.06:1 (muted text on the light Selected row); control-border contrast was at least 3.36:1. The focus/accent contrast on selected fills was at least 5.18:1.

Dividers are decorative and need no 3:1 contrast. For information, divider contrast is 1.49:1 on Canvas and 1.34:1 on Surface (dark), and 1.21:1 and 1.32:1 (light). A keyboard-focused splitter shows the focus ring. Qualify splitter discoverability in the rendered accessibility review.

These calculations do not qualify syntax palettes, composited overlays, or rendered focus. T158 measures them and every token pair in installed-build captures with `tests/windows/contrast.ts` (T179). Text needs 4.5:1, and non-text parts need 3:1. Respect forced colors and reduced motion.

The CSS Color Adjust Level 1 forced-colors list includes `fill` and `stroke`. Chromium's user-agent sheet sets `forced-color-adjust: preserve-parent-color` on `svg`, so explicit SVG fills and strokes keep their author colors. Under `@media (forced-colors: active)`, draw lanes and nodes with system colors or `currentColor`. Selection uses Highlight and HighlightText, and the focus outline uses Highlight. The selected hunk uses a Highlight border, diff lines keep plus/minus glyphs, and disabled controls use GrayText. Sources: [spec §3.1–3.2](https://www.w3.org/TR/2025/CR-css-color-adjust-1-20251216/#forced-colors-properties), [Chromium svg.css](https://github.com/chromium/chromium/blob/f77ee1168aca5bac8a0a24ab92867858321f5c12/third_party/blink/renderer/core/css/svg.css#L92-L104); source inspection only, not a WebView2 run.

Use Segoe UI Variable, Segoe UI, then system sans-serif. Use Cascadia Code, Consolas, then system monospace for diffs and object IDs. Do not download fonts or copy T3's tiny metadata scale.

| Metric | Compact | Comfortable |
| --- | ---: | ---: |
| UI text | 12 DIPs; headings 14 | 13 DIPs; headings 14 |
| Code/message text | 12 / 18 DIP line height | 13 / 20 DIP line height |
| File/history row | 26 DIPs | 34 DIPs |
| Standard button | 28 DIPs high | 36 DIPs high |
| Pane heading | 28 DIPs high | 34 DIPs high |

Use 4/8/12/16 DIP spacing, 4 DIP control corners, and square pane boundaries. Avoid all-caps labels and decorative monospace metadata. Keep helper prose below 80 characters where practical.

Soft-wrap the message without inserting line breaks into its value. Use unified diffs in this slice, preserving code lines with horizontal scrolling. Disable code ligatures where they obscure literal operators.

Default Theme to System, with explicit Light and Dark choices. Default density to Compact, with Comfortable as the option (constitution VII). Put theme, density, and Reset pane sizes in a small View menu. Use no animated page entrances or shimmering placeholders.

The repository menu exposes the selected Git path/version and Select Git. It shows the "Unqualified platform" label when it applies. It also provides Review repository trust and Revoke trust. Approval uses the issued fingerprint and explicit Approve for this session or Cancel actions. Never preselect approval; revocation does not silently cancel running work.

A small Help menu holds one item, About Arbareto. It opens the About window below. The View and repository menus stay unchanged.

#### Task flow and command placement

| Task | Required interaction |
| --- | --- |
| Review a diff | Select a category entry. The sticky header names path, scope, and comparison sides. |
| Select a hunk | Use an explicit hunk control or keyboard navigation. Mark the selected hunk without relying on its fill color. |
| Stage or unstage | Show Stage selected hunk for Unstaged or Untracked text, and Unstage selected hunk only for Staged. |
| Inspect the index | Select the staged entry, even when the same path also appears unstaged. Never infer scope from filename alone. |
| Compose a commit | Keep the plain multiline message and complete staged-file count visible in the bottom tray. |
| Review and commit | Review commit opens a bounded scope dialog containing repository, HEAD, full staged list, and message preview. |
| Confirm | Commit staged changes requires a separate explicit activation after review. It is never the message field's Enter behavior. |
| Switch modes | Change the content region, not the repository or checkout. Restore valid per-mode context without replaying operations. |

Use explicit comparison labels:

- Staged: current commit to index; use an empty committed baseline when unborn.
- Unstaged: index to working file.
- Untracked: empty version to working file, never the ordinary unstaged index baseline.
- Conflicted: status and available index-stage metadata only; no ordinary two-sided hunk workflow.

Hunk controls live outside deprecated Pierre separator callbacks. Map them to service-issued hunk IDs. Keep them disabled for unsupported, conflicted, incomplete, stale, expired, busy, or safety-blocked state. Also keep them disabled when reads need trust approval, or the trust fingerprint changed.

A successful hunk action refreshes both categories and the comparison. Clear the old hunk selection. Do not automatically select another hunk or change comparison scope.

Commit review includes externally staged binary or otherwise unsupported files as explicit metadata. Do not imply that an unpreviewed file is absent from the commit.

Review states: “Git will run approved hooks. They or other Git tools can change the result during execution.” Keep this disclosure beside the explicit Commit staged changes action, not behind a tooltip.

Commit failure retains the message and shows the actual outcome. Bind each submission to its worktree, draft revision, and submitted text in renderer state.

A reconciled `succeeded` outcome clears only that unchanged submitted draft. Preserve later edits and other worktrees' drafts, including completion while History is visible. These UI fields do not change the public commit payload. Explicit user clearing remains available; cancellation never claims rollback.

Do not display Discard, Reset, force operations, or automatic repair in this slice. Future destructive actions belong in a separate labelled menu with explicit scope confirmation.

#### About window

About Arbareto opens an in-app modal dialog, not a second native window. Use Base UI dialog and tab semantics. The tabs are Overview, License, and Third-party notices.

| Tab | Content |
| --- | --- |
| Overview | Product name, version, build identity, and the "Unsigned local test package" and "Unqualified platform" labels when they apply. The copyright notice and the attribution "Arbareto by Ihor Lifanov". The no-warranty sentence and the permission to convey under the license. The licence name, AGPL-3.0-or-later, with a pointer to the License tab. The Corresponding Source location: the repository `https://github.com/auric/arbareto` and the commit of this build. A build from a dirty tree shows the `-dirty` marker. |
| License | The full AGPL text and the NOTICE.md additional terms. Show them in a read-only, selectable, scrollable region with the code font. |
| Third-party notices | Packages grouped by licence name, with full licence text from the bundled inventory. |

The build embeds the notice texts, the source repository location, and the build identity. The source location is `package.json` `repository.url`, `https://github.com/auric/arbareto`. The repository stays private until version 1 (research.md R7). Anonymous access to the build commit is a B-RELEASE condition. The build identity is the full commit ID from `git rev-parse HEAD`. It gets the suffix `-dirty` when `git --no-optional-locks status --porcelain` prints any line. This follows the style of `git describe --always --dirty`, but it also counts untracked files. The About window and the boot view show the `-dirty` marker. The qualification package build (T154) refuses a dirty tree. So does each batch verification that builds a package. Initial focus goes to the dialog heading. Escape closes the dialog, and focus returns to the Help menu button.

The default size is about 560×480 DIPs, clamped to the work area. The constrained profile keeps every tab and its content reachable. Opening the dialog starts no network request, update check, or Git operation. Use no logo art or splash screen; text comes first.

#### Keyboard and focus

| Context | Keyboard behavior |
| --- | --- |
| General controls | Tab/Shift+Tab reaches every action; Enter/Space activates the focused button. |
| Mode tabs | Base UI tab semantics; arrows and Home/End navigate Changes/History. Ctrl+1/Ctrl+2 selects a mode outside editable input. |
| Pane navigation | F6/Shift+F6 moves among the active list, comparison/inspector, and composer; restore each pane's last valid focus target. |
| File/history list | Arrows, Home/End, and Page keys navigate; Enter selects the focused entry. Reveal only deliberate navigation, not every refresh. |
| Comparison | Previous/Next hunk buttons; Alt+Up/Alt+Down while focus is within the comparison. No global single-letter mutation shortcuts. |
| Splitter | Arrow keys resize by 8 DIPs; Shift+Arrow uses 32 DIPs. Home/End selects documented bounds. |
| Message | Enter inserts a newline. Ctrl+Enter opens Review commit only when valid; it never commits directly. Other action shortcuts stay ignored in this field. |
| Dialog | Trap focus with Base UI semantics. Escape cancels; return focus to the opener or the nearest surviving logical control. |
| Refresh | The labelled Refresh button and F5 request a bounded workspace refresh, never a webview reload. |
| Help menu | Tab reaches the Help menu button. Enter, Space, or Down Arrow opens the menu; arrows move and Escape closes it. No global shortcut exists. |
| Unavailable control | Stage selected hunk, Unstage selected hunk, Review commit, and Commit staged changes stay focusable when disabled. Activation does nothing. The visible reason is the accessible description. |

Mode selection keeps focus on the active mode tab. Restore the remembered pane target when the user enters that pane. Hidden panes must not receive focus.

Suppress action shortcuts during IME composition and repeated activation. Preserve native clipboard, text selection, undo, AltGraph, system-menu, and window-close behavior. Disable WebView2 browser accelerator keys through the Tauri `with_webview` controller. Keep Tauri's default `zoomHotkeysEnabled: false`, so page zoom stays at 100%. Release builds omit developer tools.

Initially focus the commit review heading, not its confirmation button. Opening the dialog must not also activate confirmation. After rejection, return to the message field or offending review state without deleting text. After a reconciled `succeeded` outcome in Changes, focus the message field. In History, keep focus unchanged.

Keep focused virtual rows mounted or use a persistent active-item focus container. Do not use recycled row indexes as identity. Pierre's virtualization owns diff rows; TanStack only handles large change lists.

A 100-entry History page can use ordinary rows unless measurement shows a need. Virtualization does not remove parsing, memory, or line-count limits.

When an action removes the selected entry, focus a surviving list control or category heading. Do not silently switch to the opposite category. Announce the outcome once through an appropriate live region. This slice does not verify the announcement.

#### Selection, scroll, and stored context

Maintain view context by validated worktree identity and mode. Keep the Changes category/entry, History commit ID, message value/caret, pane scroll anchors, and last logical focus target.

Keep category-specific selections for Staged, Unstaged, Untracked, and Conflicted entries. The same path must not merge their identities. Restore the active category explicitly. Selection tokens remain service-owned and can expire while another mode is visible.

On mode return, restore context only if its identity and snapshot remain valid. Revalidate first when state changed. Preserve the draft and safe view hints, but never restore an obsolete hunk approval.

Keep list scroll anchors by stable entry/commit ID plus offset. If an anchor disappears, use a nearby surviving row and announce the change. This slice does not verify the announcement. Do not repeatedly auto-scroll background refreshes to selection.

Preserve diff scroll only while its canonical comparison remains unchanged. When content changes, clear hunk selection and reset the comparison viewport with an explicit notice.

Theme, density, and pane changes must preserve the valid selection and editor caret. Recalculate scroll geometry without inventing a new staging selection.

Persist scalar theme, density, and pane preferences in application-owned webview storage. Keep native window bounds and selected Git in native settings. Keep drafts and view hints in renderer memory; they survive a service restart. Keep all Git approvals in the service session.

#### History graph design

Keep the commit list as the navigation surface. The ancestry column explains relationships; it is not a draggable diagram or branch-management surface.

| History layout | Benefit | Cost and decision |
| --- | --- | --- |
| Row-aligned lanes with a bottom inspector | One scrolling surface, compact metadata, stable keyboard selection, and direct Changes/History continuity. Matches Git Extensions' commit-info-below-list option. | Choose this layout. |
| Free-positioned graph with a side inspector | Useful for spatial exploration of small diagrams. | Reject for this slice: pan/zoom and scattered labels reduce revision-scanning efficiency. |

```text
Changes | History
Current checkout: main / HEAD     Up to 100 commits           Refresh
+------------+--------------------------------------+-----------------+
| Ancestry   | Subject                              | Author Date ID  |
|   o HEAD   | Current change                       |                 |
|   |\       | Merge                                |                 |
|   | o      | Side-line change                     |                 |
|   o |      | Earlier change                       |                 |
|   |/       |                                      |                 |
|   o        | Common parent                        |                 |
|   :        | Parent outside this page             |                 |
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
- Mark each distinct outside-page parent with an open continuation and an accessible parent entry. Never turn it into a root.
- Mark shallow boundaries separately. An unavailable parent is not a proven root; missing objects must not trigger a fetch.
- A true root commit ends its lane at the node, with no downward edge or continuation mark. Its accessible text says Root commit.
- Bound layout to 24 concurrent lanes and 4,096 path segments. On overflow, keep rows and parent metadata with Graph layout limited.
- A graph-only layout limit does not invalidate an otherwise complete status or commit review.

Use 12 DIP lane spacing compact and 14 DIPs comfortable, with 12 DIP side padding. Use two-DIP paths and restrained round joins. Draw normal nodes at three-DIP radius with an explicit HEAD badge. A merge node is hollow at the same radius: a lane-colored stroke with a Canvas or Surface fill. Selection adds a separate Accent outer ring 3 DIPs outside any selected node; a selected merge node shows both.

Give each new lane a color that differs from its left neighbor, right neighbor, and originating lane. Four colors always satisfy this rule. Git Extensions uses the same behavior.

| Lane role | Dark | Light |
| --- | --- | --- |
| Teal | `#60CCC5` | `#06726E` |
| Sky | `#7ACBE9` | `#0F6E89` |
| Violet | `#C2A7F4` | `#724AAB` |
| Magenta | `#E999D2` | `#993582` |

These decorative lane colors stay at least 30° in OKLCH hue from Accent, Added, Removed/error, and Warning. Lane colors are supplementary; lane position and accessible parent text carry identity. All 24 stroke/background pairs, against Canvas, Surface, and Selected row, exceed 3:1 numerically; the minimum is 4.66:1. Rendered contrast remains unverified.

**Interaction and responsive behavior:**

- A click selects the same commit row and inspector. Double-click never checks out a commit or changes a reference.
- Keep `selectedOid` controlled by workspace state. Use Up/Down, Home/End, and Page keys; Enter selects the focused row.
- SVG nodes have no separate tab stops. Expose commit identity, merge-parent count, and ordered parent relationships through accessible text.
- An inspector parent action selects that OID only when it exists in the loaded page. Otherwise show Outside loaded page without navigation.
- Use the existing focus ring, not lane color, for keyboard focus. Keep selection distinct from current HEAD.
- Show HEAD and its current branch only from the captured checkout identity. Do not imply other branch labels were discovered.
- Keep subjects on one row. Move author/date columns into the inspector at narrow widths; retain accessible metadata for each row.
- At 720 DIPs, 24 comfortable lanes leave room for the subject and short ID. Clamp pane sizes without clipping actions.
- Preserve selected OID and scroll anchor across refresh when still loaded. Otherwise explain that the prior selection left the page.
- New commits do not auto-scroll a user away from their reading position. Refresh updates the page and announces changed scope. This slice does not verify the announcement.
- Density, theme, and DPI changes recompute geometry without remounting the message editor or authorizing any Git operation.
- Use no force simulation, node dragging, zoom toolbar, animated edge entrances, or extra history filters.

#### Required visible states

| State | Presentation and behavior |
| --- | --- |
| No repository | Plain Open an existing repository action; no dashboard, clone button, or invented sample changes. |
| Repository refused | Name the refusal reason and show a copyable remedy. Keep the current workspace unchanged. Offer Open repository, and never offer repair, configuration changes, or lock removal. |
| Empty/clean | Say Working tree clean when confirmed. Unborn History says No commits yet. Empty stages disable review with an explanation. |
| Loading | Keep the frame stable. New repositories show labelled placeholders; refresh retains prior content marked Refreshing. No fabricated progress percentage. |
| Normal | Show path, staged/unstaged scope, one selected comparison, explicit hunk control, and staged count. |
| Staged plus unstaged | Show the path in both categories with independent state. Headers make the current comparison direction explicit. |
| Untracked | Label the category explicitly and show an empty comparison baseline. Keep any same-path staged deletion separate. |
| Conflicted/unfinished operation | Name the conflict or merge/rebase/cherry-pick/revert state. Block mutations; offer Refresh after external resolution, never repair. |
| Unsupported/binary | Retain metadata and the specific limitation. Disable hunk actions. Do not show an empty text diff or execute a preview. |
| Trust required/changed | Show a safe policy summary and explicit session approval. Explain hook/tool execution; changed fingerprints require renewed approval. Also show this state before the first status read when repository configuration defines read-time commands. Commit review shows this state only when the commit can run repository-controlled code (contract §7 "Mutation trust"). |
| Busy | Keep typing, scrolling, mode changes, and cancellation available. Identify operation and repository; disable conflicting mutations only. |
| Error | Put a safe explanation and recovery action beside the affected pane. Preserve message and selection where valid. Never offer forced unlock or repair. For `LOCKED`, show the Git-resolved lock path with Copy path and Refresh. Show the contract §9 `LOCKED` remedy text. |
| Stale selection | State that the comparison or staged scope changed. Invalidate approval immediately; refresh and require reselection or renewed review. |
| Large history | Graph only the first 100 checkout-reachable commits. Show page/shallow boundaries and the scope limit, without pagination or implied complete-history counts. |
| Completed with effects | Show any identified commit and the observed difference. Preserve the draft; offer review, never automatic retry, undo, or ordinary-success styling. |
| Graph layout limited | Keep commit rows and accessible parents. Explain lane/segment limits without invented edges or disabling unrelated Git workflows. |
| Limited output | Identify the exceeded limit. Do not present truncation as complete or allow dependent mutations. |
| Cancel requested | Keep the label until Git or the process tree confirms the end (FR-021). Conflicting controls stay disabled. |
| Canceled | Show the reconciled state and never claim rollback (FR-021). If reconciliation fails, show Unknown after interruption. |
| Close during mutation | The native close prompt names the running operation and explains rollback limits (FR-024). Its buttons are Stay open and Interrupt and close. Stay open is the default button. Enter, Escape, Alt+F4, the title-bar close button, and a dialog failure all mean Stay open. Only an explicit activation of Interrupt and close interrupts. A renderer request never confirms interruption. Stay open returns focus to the last logical focus target. |
| Unknown after interruption | Show State unknown and Refresh. Block mutations until reconciliation succeeds; do not claim cancellation reversed changes. |
| Component stopped | A service exit shows the native Service stopped dialog (T142) with Restart service and Close Arbareto. Restart delivers the new session to the page without a reload, so drafts survive. A renderer exit shows a native dialog with Reload window and Close Arbareto. A browser process exit offers Restart Arbareto, which relaunches the application, and Close Arbareto. An unresponsive renderer causes no automatic action. |

Use complete Git observations for state labels. A failed read cannot produce Working tree clean. Error and warning text must remain understandable without color.

#### Screenshot review during implementation

Capture the installed release build with real disposable fixtures. No screenshot currently exists. These captures are review targets, not claimed passes or substitute Git assertions.

Record build, fixture, theme, density, client size, OS/runtime, and scale for each capture. Use stable fixture paths and no credentials or personal repositories.

| Capture | Actual state and interaction to review | Configuration |
| --- | --- | --- |
| UI-01 | No repository; folder dialog accepted and canceled; focus returns to Open repository. | 1280×800, dark/compact, 100%. |
| UI-02 | F01 empty/unborn Changes and History; explicit empty scope and disabled review. | 960×640, light/comfortable, 100%. |
| UI-03 | Controlled initial loading and refresh with retained prior content and visible focus. | 1280×800, dark/comfortable, 100%. |
| UI-04 | F02 normal diff with a selected hunk, visible path/scope, and keyboard focus. | Matching dark/light captures, compact, 1280×800, 100%. |
| UI-05 | F02 same path in Staged/Unstaged; F06 staged deletion plus untracked replacement with an empty baseline. Capture qualified hunk outcomes. | 1280×800, comfortable, 150%. |
| UI-06 | Draft, complete review, F11 trust approval, and hook rejection with retained message and restored focus. | 1280×800, light/comfortable, 100%; mutation gates must already pass. |
| UI-07 | F05 binary/unsupported and F16 oversized comparison with specific disabled reasons. | 960×640, dark/compact, 150%. |
| UI-08 | F13/F14 busy work, cancel requested, canceled, close during mutation, unknown recovery, and typing during a delayed successful commit. Preserve newer edits when completion arrives in History. The native Service stopped dialog with Restart service, a draft that survives the restart, and the native renderer-failure dialog. | 1280×800, dark/comfortable, 100%; never fake enabled mutation controls. |
| UI-09 | F09 stale selected hunk and staged-scope change; refreshed content cannot restore the old approval. | 960×640, light/compact, 150%. |
| UI-10 | F10 conflicts, unfinished operations, and locks; F15 unavailable repository. Show explicit mutation blockers and no repair action. Refused bare repository, dubious ownership, and missing `.git` target, each with its copyable remedy. | 960×640, light/comfortable, 100%. |
| UI-11 | F19/L graph with linear, merge, and octopus ancestry, page/shallow boundaries, and long subjects. Return to Changes without losing valid context. | 1280×800, dark/compact, 150%; matching light/comfortable capture. |
| UI-12 | Pointer/keyboard splitters, both densities, graph-row alignment, constrained layouts, and cross-display focus/IME behavior. Include graph limits and keyboard parent inspection. | 1440×900 at 100%; 960×640 at 150%/200%; 720×480 at 200%, both themes. |
| UI-13 | F11/F20 hook refusal for hunks, standard commit disclosure, and a commit created with unexpected effects. Show the actual result and retained draft. | 1280×800, both themes, comfortable, 100%; real mutation evidence required. |
| UI-14 | Windows contrast theme (forced colors) in the installed build. Graph lanes and nodes, focus ring, row selection, diff plus/minus markers, and disabled reasons remain visible. | 1280×800, 100%; one dark and one light contrast theme. |
| UI-15 | About window Overview, License, and Third-party notices tabs with keyboard focus, offline. Focus returns to the Help menu button on close. | 1280×800, dark/compact, 100%; 720×480, light/comfortable, 200%. |

Provide enough work area for the requested client size, native chrome, and taskbar. Use a larger qualification display if needed. Record the actual work area; clipped captures cannot pass. Use the supported constrained profile when a smaller work area requires it.

Review screenshots for hierarchy, clipping, readable syntax, semantic contrast, visible focus, and clear scope. Pair them with keyboard, IME, native, and exact Git-state tests. Screenshots alone cannot prove these behaviors. Narrator tests: Deferred to a later feature; not a qualification check in this slice.

#### Design check against the brief

Choose A over the three-column arrangement because high DPI reduces logical width. Keep the full staged scope visible without compressing the diff into a narrow column.

Reject decorative cards, chat-first navigation, copied branding, tiny metadata, inaccessible custom tabs, and hidden destructive shortcuts. Retain system fonts and restrained blue because they fit the Windows workbench brief. Git Extensions is the primary workflow reference, and T3 Code is the visual-style reference.

Source inspection, document review, and numeric contrast checks do not qualify rendered behavior. Interface screenshots, accessibility, and native qualification remain unverified. This interface plan does not change the mutation or public-release gates.

### Service and native shell

Use private inherited pipes between the shell and compiled service. No localhost HTTP server or renderer-visible process API is needed.

The renderer sends only contract operations. The shell checks command origin, framing, operation kind, and message bounds. The service validates full operation semantics.

Native dialogs provide repository and executable selection. Service registration returns opaque identifiers. Renderer input cannot become a filesystem or executable capability directly.

The shell supervises the service and Git operations with separate Windows Jobs. Start each child suspended, assign its Job, then resume it.

Only the private service channel can request bounded Git process execution. The shell pins the selected executable and validates ownership and limits. Native code does not implement Git commands or staging semantics.

Use one active application service per instance. Allow more than one application instance. Each instance treats the others as external writers. Write native settings by whole-file replacement, and the last writer wins.

On unexpected service exit, show the native Service stopped dialog with a Restart service action. A restart starts a new session and invalidates old identifiers. The shell then sends the page a `service-session` event with the new `sessionId` (contract §2). The page does not reload, so drafts survive. For each recovery marker, and for each request without a terminal response, show Previous outcome unknown (contract §6). Never restart the service or reload the window automatically.

wry does not handle WebView2 `ProcessFailed`. The shell subscribes to that event and shows the Component stopped state. research.md R7 cites the wry and Tauri source for this fact and for the accelerator setting.

### Freshness and reconciliation

Serialize application mutations by resolved common-directory identity. Reject overlapping submissions rather than queueing approvals that can become stale.

Observe worktree, worktree-administration, and common-directory changes. Debounce hints for 100 ms. Poll relevant foreground state every second. Each poll is one full `readWorkspace` read (T088), with or without a hint. A poll starts no read while an earlier read of that workspace is pending. This bound follows the contract §5 read concurrency caps. The poll cost counts in the idle CPU budget, and T169 measures it.

Refresh on focus return and manual request. Invalidate approvals immediately after relevant changes. Generation and selection identifiers suppress obsolete read results.

Every mutation still needs direct state validation. Watchers, polling, and generations do not create an atomic snapshot.

After every mutation outcome, reconcile actual Git state before enabling another mutation. Failed reconciliation produces an explicit unknown state. An explicit recovery refresh must complete recovery reconciliation before enabling mutations (contract §8). An unknown attribution is a stated result, not a permanent block. Polls and focus return never send `refresh: true`. A successful status read alone cannot clear the block.

### Selected mutation protocols

The former design blockers are resolved by the approved checkpoint contract. Qualification remains required; source reasoning is not a test pass.

**Hunk publication:** acquire the Git-resolved canonical index lock, revalidate, and prepare one private candidate index. Apply the service-selected patch through Git and verify the independently calculated exact result. Recheck relevant state before one same-volume publication through the owned lock. Reconcile afterward.

Support ordinary full indexes first. Refuse sparse indexes (`index.sparse=true`) and split indexes. Also refuse registered `post-index-change` hooks, executable fsmonitor, the built-in fsmonitor daemon, custom conversions, and existing unsupported file/state cases. Registered disabled index-change hooks also cause refusal until their interpretation receives separate qualification.

Do not disable hooks or monitors to make a hunk operation pass. Ordinary commit hooks remain supported. Preserve external writers' bytes and report changes observed after publication without undo or retry.

**Commit review:** capture the complete staged scope and a bounded retained index snapshot through read-only Git inspection. Do not call `write-tree` or run a trial commit during review. Keep expected scope as captured index data rather than requiring a preview tree write.

**Commit handoff:** lock for final preflight, compare reviewed index/checkout/trust, consume the token, then release that lock. Start one selected-Git `commit --file=-` against the canonical index, with the bounded message on stdin.

The lock release starts the execution window. Git runs existing approved hooks and signing. Do not use a private commit index, inject guards, reconstruct commits, or override user identity/signing configuration. After it updates HEAD, `git commit` runs automatic maintenance in the foreground on Windows. Then it runs the `post-commit` hook (research R4). The 120-second commit deadline covers both, and reconciliation classifies an interrupted result from observed state.

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
6. Enable hunk and commit pathways only after their blocking proof cases pass.
7. Run installed release-build qualification and matched Git Extensions measurements.
8. Record failures, causes, remedies, and retests in `research.md`. Keep public release blocked on deferred signing/update gates.

This sequence is planning guidance, not a generated task list or permission to implement now.

## Real-repository fixture matrix

Use disposable repositories under an explicitly owned temporary root. Never target developer repositories. Isolate fixture identity, signing, hooks, and configuration from the user's environment. Fixture runs of the installed app on the reference host (T153, T160 to T163) start through the T151 launcher. T149 is a smoke run before T151 exists. It changes only its F02 fixture and records the current user's Git configuration origin. The T155 clean environment and the T165 measurement account are isolated by design and do not use the launcher.

| ID | Fixture | Required evidence |
| --- | --- | --- |
| F01 | Empty and unborn repositories; first added text; empty files. | Correct empty history, entry existence, first commit, and unavailable metadata-only hunk actions. |
| F02 | Multiple hunks; one path staged and unstaged; unrelated staged paths. | Exact selected hunk and unchanged unrelated index entries and working bytes. |
| F03 | `space dir/雪 café.txt`, option-like names, bracket names, and missing final newlines. A working path of 260 or more UTF-16 units, a case-only rename, and two case-colliding index paths. | Literal path identity and exact bytes. Use names valid on Windows. Record long-path results as observed, and never change `core.longpaths`. Record whether Bun reads paths of 260 or more UTF-16 units and returns the on-disk letter case. |
| F04 | LF, CRLF, and mixed files under each `core.autocrlf` value, `core.eol`, `core.safecrlf`, and `text`, `text=auto`, `-text`, `eol`, `crlf` attributes. | Canonical index bytes match the `git add -p` result, and raw working bytes stay unchanged. Mixed files and normalization-only differences offer no hunk action. Record how the service gets Git-normalized content for untracked-file hunks, because `git diff --no-index` may skip attribute conversion. T092 runs this probe before the T093 tests. A case that no method matches gets no hunk action. SC-003 then records that case as `fail`, and the requirement does not change. |
| F05 | Rename, binary, invalid UTF-8, mode/type change, symlink, submodule, LFS, custom filter, and encoding conversion. | Accurate metadata and explicit refusal of unsupported hunks without fallback. No Git process starts inside a submodule during superproject reads, with a canary in the submodule's local configuration. Record whether `diff-files -z --ignore-submodules=dirty` starts no child when the submodule HEAD matches the recorded commit. |
| F06 | Added/deleted text; staged deletion followed by untracked replacement. | Correct comparison scope and entry creation/removal. |
| F07 | Two linked worktrees, distinct indexes, shared refs; junction aliases. A submodule checkout opened directly, a separate Git directory, a bare repository, and a `.git` file with a missing target. | Correct worktree identity and conservative common-repository exclusion. |
| F08 | SHA-1, SHA-256, detached HEAD, and same-OID branch changes. | Correct OID parsing, baseline, and symbolic-target validation. |
| F09 | External file/index/ref/attribute/configuration changes before each validation checkpoint. | Refuse handoff/publication; no silently relocated hunk or overwritten external bytes. |
| F10 | Existing locks, conflicts, merge/rebase/cherry-pick/revert state, split/sparse indexes. Intent-to-add, assume-unchanged, and skip-worktree entries, including a sparse checkout with a full index. | Explicit blockers; no lock removal, repair, or unqualified mutation. Refuse hunk actions on flagged entries, and keep every unrelated entry's flags. Record how the service detects intent-to-add entries; porcelain v2 status `.A` is assumed. Record whether `apply --cached` keeps flags on unrelated entries. |
| F11 | Traditional/configured hooks, disabled registrations, post-index-change, executable fsmonitor, and changing/rejected commit hooks. | Refuse unsafe hunk profiles; preserve normal commit hooks, real index effects, drafts, and truthful outcomes. |
| F12 | Missing identity, signing failure, blank message, empty index, repeated submission, and non-UTF-8 `i18n.commitEncoding`. A commit that triggers automatic maintenance through local `gc.auto=1`. | No bypass or configuration change; no duplicate commit. Record whether the commit process waits for maintenance and how long it runs. |
| F13 | Cancellation before/during/after publication; delayed completion; failed reconciliation. | Exact resulting state; no false rollback or automatic retry. |
| F14 | Slow real Git work, descendant-spawning hooks, service crash, shell crash, and shutdown. A hook grandchild that holds no inherited pipe and outlives its parent. A read with local `core.fsmonitor=true` and no running daemon. | Owned process cleanup within five seconds; unrelated Git and agents survive. The orphaned grandchild and any daemon that a read started also end. Record whether WebView2 processes exit after a shell crash. |
| F15 | Removed/inaccessible repositories, sharing violations, and full disposable volume. A repository that another account owns. | Actionable failure and preserved data. Never fill or alter the developer's volume. Record whether Git for Windows honors the fixed C locale for the ownership message. |
| F16 | Exact 1 MiB/20,000-line boundaries and values above them; oversized status/history; malformed records. | Complete framing or explicit limits; no mutation from incomplete data. |
| F17 | Malicious markup, diagnostic credential canaries, hostile runtime variables, `.env`, and `bunfig.toml`. Repository-scope `filter.<driver>.clean`, `filter.<driver>.process`, and command-valued `core.fsmonitor` with an execution canary. | No active content, runtime injection, arbitrary commands, or credential-bearing logs. No canary runs before trust approval. |
| F18 | Missed watcher notifications and externally completed changes. | Foreground update within two seconds; focus/manual refresh recovery. |
| F19 | Linear, merge, octopus, skewed-date, root, shallow, cutoff, SHA-256, and wide-lane history. A commit with a legacy `encoding` header. | Exact Git parent relationships; explicit boundaries/limits; no fetched objects or invented branches; keyboard and density alignment. Invalid UTF-8 subjects and authors show replacement characters and an encoding label. |
| F20 | Changes after final hunk validation or commit handoff; competing commits, ambiguous attribution, and reference/reflog evidence overflow. | Preserve external bytes; report completed/failed-with-effects or unknown; retain drafts and never retry or undo automatically. Exercise 4 MiB and 10,000-record limits independently. Status-only success cannot unblock unknown attribution; require successful recovery reconciliation. Recovery reconciliation with unknown attribution states that outcome and then enables mutations. |

The harness can control race barriers, but must still execute real Git. Mocks and process exit codes cannot qualify mutations.

For each mutation, compare the full logical index, selected blob bytes, all fixture working-file bytes, refs, and operation markers. Distinguish application effects from deliberate external-writer effects.

## Windows installation and native checks

Use an NSIS current-user package with explicit prerequisites. Label unsigned local artifacts “Unsigned local test package”. Package identification means the installer file name and the Windows Apps (Add or Remove Programs) entry. The pinned NSIS template writes the entry name `DisplayName` from `productName` `Arbareto` (installer.nsi:702). The bundle identifier is `io.github.auric.arbareto`; it does not change for the label. It then runs the `NSIS_HOOK_POSTINSTALL` macro (installer.nsi:734-735). The installer hook file of T008 rewrites `DisplayName` to "Arbareto (Unsigned local test package)". The template never reads `shortDescription` or `longDescription`. The installer file name comes from `productName` and the version (nsis/mod.rs:653-658), so it carries no label. research.md R7 cites these lines.

Qualify installation, launch, upgrade, uninstall, and reinstall under a clean standard-user account. Do not remove development runtimes from the current workstation. The clean environment has no Bun, so build the fixtures on the reference host with T141. Copy them into the clean environment with a SHA-256 manifest, and verify the copies there with `Get-FileHash`. Offline, stage a hunk, unstage a hunk, and commit in F02 and in a linked worktree of F07. Copy the fixtures back to the host and verify them with the T141 `--snapshot` command. F07 copies use relative worktree links (`git worktree add --relative-paths`), so the links survive the move.

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

Native checks cover folder accept/cancel, focus restoration, Unicode clipboard, shortcuts, resize/snap, both densities, both themes, and IME composition. Include keyboard pane resizing and Changes/History context restoration. Run at 100%, 150%, and 200% scaling, including mixed-scale display transitions. Use the frontend window profiles and UI-01–UI-15 capture cases above.

Use a real two-display environment for mixed-scale checks. A single-display browser emulation cannot pass them. Record any unavailable equipment as unverified.

## Fixed release-build measurement protocol

### Reference hardware and fixtures

Use the physical reference recorded in `research.md`: Ryzen 7 5800H, nominal 32 GiB RAM, and Samsung 970 EVO Plus NVMe. Use Windows `10.0.26200.9457`, the recorded drivers, and the admitted WebView2 version installed at run time for the initial series. The reference host runs WebView2 `154.0.4258.37` on 2026-09-29.

Connect AC power. Use Balanced power mode without battery saver. Keep Defender enabled and record its engine/signature versions. Record thermal state and background activity; do not disable security software to improve results.

| Fixture | Fixed construction |
| --- | --- |
| M: moderate | 10,000 tracked files, 5,000 commits, 32 refs, and approximately 20 MiB checked-out content. |
| L: large history | 50,000 tracked files, 100,000 commits, 256 refs, and approximately 100 MiB checked-out content. |
| M-D: large diff | A copy of M plus one modified UTF-8 text file of 10,000 lines, at most 100 bytes each. Lines 501 to 9,500 change, so the diff stays below the FR-010 limits. Only SC-015 workflow C5 uses it. |
| Shared changes | 10 staged paths, 10 unstaged paths, 10 untracked paths, and one path with both staged and unstaged hunks. |
| Reproducibility | Fixed seed `42`, fixed identities/timestamps, fixed attributes, and recorded semantic fixture digests. |

Create deterministic history with native Git fixture tooling. Use independent identical copies for each candidate. Record actual object, file, commit, and byte counts before testing. M, M-D, and L contain no linked worktrees.

### Measurements and budgets

| Metric | Boundary and repetitions | Qualification budget |
| --- | --- | --- |
| Cold usable workspace | Process creation to painted, fresh status/history/selected diff and enabled inspection. Five runs per fixture; reboot before each run. | Every M run at most 1.5 seconds. Report L without inventing an existing target. |
| Warm reopen | Confirmed repository selection to the same fresh usable state. Twenty runs per fixture in a warm application. | Every M run at most 500 ms. |
| Input acknowledgement | Input injection to first presented visible response during slow Git activity. 100 counted actions each for typing, navigation, resize, and cancellation. Use a copy of fixture L with the foreground poll active. A commit runs with an approved `pre-commit` hook that outlives the commit deadline. Each cancellation action cancels one such commit. An action counts only when the WPR trace shows an owned `git.exe` alive at injection. | p95 at most 100 ms for each action class. |
| UI stalls | Presented-frame/interaction trace during all workloads. Include loading and cancellation. | No unresponsive interval above 500 ms. |
| External changes | External operation completion to visible reconciled state. Twenty runs each for file, index, and ref changes. | At most two seconds in an idle foreground workspace. |
| Cancellation | User request to reconciled or explicitly unknown state. Twenty controlled slow-operation runs. | At most five seconds. |
| Shutdown | Confirmed closure to no remaining unintended owned process. Ten runs each for idle, reads, and mutations. | At most five seconds; unrelated processes survive every run. |
| Idle memory | Entire owned process set after 30 seconds settling; sample for 60 seconds at 100 ms intervals. | p95 private bytes at most 500 MiB on M and 750 MiB on L. |
| Active memory | Same process set during workload; include short-lived process peaks. | Peak private bytes at most 1 GiB. |
| Idle CPU | Sum kernel/user CPU over the 60-second idle interval, normalized by 16 logical processors. | Mean at most 1% of machine CPU. |
| Active CPU and package size | Total CPU-seconds, peak usage, installer bytes, installed bytes, and prerequisite footprint. | Report values. No unsupported superiority claim or invented pass threshold. |
| Git Extensions comparison | Workflows C1 to C7 and run counts in §Matched-condition comparisons. | SC-015: cold launch, warm reopen, and history refresh median ratio at most 0.5; every other compared workflow at most 1.0. |

The memory and idle-CPU ceilings are additional proposed engineering limits fixed by this plan. Changing any budget needs an explicit recorded trade-off.

Cold timing excludes first-use prerequisite installation and manual repository selection. Retain the previously selected repository setting. Stop all owned processes before reboot.

Report every run, median, nearest-rank p95, maximum, and measurement uncertainty. Do not discard failed runs silently or replace maximum budgets with averages.

Use WPR/WPA and process accounting for CPU, lifetime, and stalls. Correlate visible responses with presented frames or timestamped video. JavaScript handler timestamps alone do not prove visible acknowledgement. Inject input with the test-only script `tests/windows/inject.ts` (T165). It calls `SendInput` through `bun:ffi` and records the QueryPerformanceCounter value of each input. Take presented-frame timing from the WPR trace with GPU and DXGI present events (research.md R6). Before measurement, T165 confirms the frame source and records the usable-workspace marker.

Sum private bytes without calling summed working sets unique physical memory. Include exited children in CPU totals. Use an application-specific WebView2 user-data directory for attribution.

### Matched-condition comparisons

Git Extensions `7.2.1.7` is the SC-015 baseline. Record its .NET `10.0.10` prerequisite separately. Do not present a product baseline as an isolated shell benchmark.

Match these conditions for both applications:

- Use the reference host, power mode, Defender state, display, scale, and outer window bounds of the T166 series.
- Use the same Git executable path, not only the same version. Confirm the image path of each started `git.exe` in the WPR process trace.
- Use independent identical copies of M and M-D (T164). Start each mutation run from a fresh copy.
- Run both applications under one dedicated standard Windows account. Run WPR traces from an elevated session, while both applications run under that standard account. Keep the user's own Git Extensions settings and Git configuration unchanged.
- Run one application at a time. Use `tests/windows/inject.ts`, the T165 frame source, and the T165 frame rate for both.

Start the Git Extensions profile from default settings. The first launch shows first-run prompts (Program.cs:122-165). Discard and record that run. Change only these settings, and record all other values as defaults:

- `CheckForUpdates` false. The default true starts an update check (AppSettings.cs:1808-1811).
- `MaxRevisionGraphCommits` 100. The default 100000 reads all M commits (AppSettings.cs:1340-1344).
- `ShowCurrentBranchOnly` true. The default false reads all refs (AppSettings.cs:1282). Record whether the value persists after a restart. If it does not persist, record all-branch history as a confounder.
- `CloseProcessDialog` true. The default keeps the commit output dialog open until a click (AppSettings.cs:1274-1277, FormStatus.cs:190-192).
- Git command: the executable that Arbareto uses.

Record the settings file SHA-256 before and after each series. Confirm in the WPR process trace that the Git Extensions `git log` command reads at most 100 commits.

| ID | Workflow and fixture | Start event | Arbareto done | Git Extensions done | Runs per application |
| --- | --- | --- | --- | --- | --- |
| C1 | Cold launch, M | Process creation after reboot. Git Extensions starts with `browse <M path>`. Arbareto uses its retained repository setting. | The T166 usable-workspace frame. | The first frame with the first 100 grid rows, the graph, and counts on the Workspace and Index rows. | 5 |
| C2 | Warm reopen, M | The input that confirms M in the open control. The same other repository is open before each run. | Same as C1. | Same as C1. | 20 |
| C3 | History refresh, M | The refresh input in the history view (F5 in Git Extensions). | The first frame with the refreshed first page and graph. | The first frame with the refreshed first 100 grid rows. | 20 |
| C4 | External file change, M | Completion of one external file write. Both applications stay idle in the foreground for 60 seconds before it. | The first frame with the changed status. | The first frame with the changed Workspace row or Commit button count. | 20 |
| C5 | Large diff, M-D | The input that selects the large file. | The first frame with diff text in the viewport. | The same frame in the commit dialog diff viewer. | 20 |
| C6 | Stage one hunk, M | The stage input. Git Extensions uses Stage selected lines with exactly that hunk's lines selected. | The first frame with the file in Staged and the refreshed diff. | The same frame in the commit dialog. | 20 |
| C7 | Local commit, M | The commit input. Arbareto time adds Ctrl+Enter to the ready review and confirm to done. | The first frame with the created commit identity and an empty Staged section. | The first browse-grid frame with the new commit as the top row. | 20 |

Record these differences as confounders. In C1, Git Extensions starts with a `browse` argument, and Arbareto uses its retained repository setting. In C1 and C2, the Arbareto done frame also shows a selected diff. In C4, Git Extensions waits 1 second after a file event and 30 seconds after its previous status read (GitStatusMonitor.cs:23, :28, :560). Do not compare a repeated change inside 30 seconds. In C6 and C7, Arbareto adds validation, candidate verification, and reconciliation (§Selected mutation protocols).

Do not compare input acknowledgement, stalls, cancellation, shutdown, memory, CPU, package size, installation, first run, or fixture L. Their own budgets and reports above stay unchanged.

Use ABBA order: Arbareto, Git Extensions, Git Extensions, Arbareto, then repeat. Cold runs follow this order across reboots. Other workflows use blocks of 10 runs in this order.

For each application and workflow, report every run, the median, the nearest-rank p95, and the maximum. With five cold runs, the p95 equals the maximum. The ratio is the Arbareto median divided by the Git Extensions median. Evaluate SC-015 on that ratio.

Let Δ be one frame interval of the capture. A workflow passes only when its ratio holds with Arbareto times plus Δ and Git Extensions times minus Δ.

Record times and ratios as numbers in research.md R6 and the SC-015 row of R10. Never record them as comparative adjectives (T177).

A workflow that misses the SC-015 target makes SC-015 `fail`. Record the workflow ID, both medians, and the ratio in research.md R10. The miss counts under B-PERFORMANCE. It stays `fail` unless an explicit product trade-off approves a revised target. T170 records its cause and remedy, and T173 applies the attribution rule. Only a shell-attributable miss can lead to consideration of another shell. A workflow that Git Extensions cannot run stays `unverified`.

Electrobun receives no packaged measurement in this scope. A future approved comparison must reuse the same frontend, contracts, and Git-service workload.

Align Bun versions where supported, renderer versions, fixtures, and build optimizations. Otherwise disclose those differences as confounders. Measure complete process sets, installation behavior, signing, and update verification for both candidates.

## Hard blockers and evidence rules

| Gate | Failure condition | Current state |
| --- | --- | --- |
| Hunk correctness | A detected mismatch still publishes, the candidate is wrong, working content is written, or required hooks are bypassed. | Design resolved; real-Git and Windows proof cases unverified. |
| Commit outcomes | Preflight mismatch is ignored, duplicate invocation occurs, effects are hidden, or `completed-with-effects` results appear as `succeeded`. | Standard Git policy approved; real-Git and Windows proof cases unverified. |
| Graph correctness | False ancestry, missing boundary labels, inaccessible selection, or row/lane misalignment. | Design selected; real-DAG and packaged UI proof cases unverified. |
| B-BOUNDARY | Arbitrary renderer execution, unvalidated inputs, runtime injection, or credentials in retained diagnostics. | Unverified. |
| B-LIFECYCLE | Orphaned owned processes, unrelated termination, false rollback claims, or mutations after failed reconciliation. | Unverified. |
| B-INSPECTION | Incorrect identity/parsing or incomplete data presented as complete. | Unverified. |
| B-WINDOWS | Standard-user installation fails, prerequisites are misleading, or essential native actions fail. | Unverified. |
| B-PERFORMANCE | A fixed responsiveness, lifecycle, resource, or SC-015 comparison budget fails without an approved trade-off. | Unverified. |
| B-RELEASE | Required licences/notices (FR-037, SC-014), package signing, update authenticity, or tampered-update rejection lack passing evidence. An anonymous request cannot get the build commit from the Corresponding Source location. | Public release blocked. The source repository stays private until version 1 (research.md R7). |

Keep scenario results, build identifiers, causes, attempted remedies, and decision impact in `research.md`. Reference raw test artifacts by path and digest. Do not add separate qualification reports or planning hierarchies.

A failure is shell-attributable when a minimal Tauri app reproduces it. Build that app from the Tauri versions in the committed `Cargo.lock`, and record them. A trace into Tauri, wry, or WebView2 code also makes it shell-attributable. So does a documented missing shell capability. Consider another shell only after a shell-attributable B-WINDOWS or B-PERFORMANCE failure. Record each attempted remedy: a dependency version change, a configuration change, or a native workaround. A remedy is reasonable when it keeps the constitution's shell and dependency rules. The resolved Git consistency decisions do not provide evidence against Tauri. A minimal Tauri app reproduces an SC-015 C1 miss when its median cold start exceeds the C1 target bound. Measure that start from process creation to its first presented frame. An SC-015 miss in C2 to C7 is shell-attributable only through a trace or a documented missing capability.

## Complexity Tracking

| Constraint | Why needed | Simpler alternative rejected because |
| --- | --- | --- |
| Small Rust process supervisor | Windows descendant ownership, cancellation, and crash cleanup require native Jobs. | Bun/Tauri child termination alone does not establish the required tree cleanup. |
| Native platform and WebView2 calls | The Unqualified platform label needs the native machine under emulation. Renderer failure needs WebView2 `ProcessFailed`. Browser accelerators need the WebView2 controller. | wry does not handle `ProcessFailed`. Tauri configuration has no accelerator key. The x64 service's `process.arch` reports the build architecture, not the native machine. |
| One mutation per common repository | Linked worktrees share refs and other state. | Per-path or per-worktree concurrency adds risk without measured need. |
| Service-owned diff snapshots | Staging must bind to exact Git and working-file state. | Renderer selection and patch applicability do not establish freshness. |

These choices do not waive runtime safety tests. The graph adds only bounded lane rendering, not a reusable graph framework. Add no further abstraction until a concrete requirement justifies it.
