# Arbareto — Windows-first, cross-platform Git client project brief

Research reviewed: 28 September 2026.
Status: planning input. Spec Kit v1.0.12 is initialized. The application code is in this repository; the README [Status](../README.md#status) section gives its state. Use Tauri 2 with a compiled TypeScript/Bun Git service for the first qualification feature. Packaged Windows tests are in `tests/windows`. The `research.md` file of each feature in [specs/](../specs/) records the qualification runs. Validate the selected architecture through packaged Windows tests.

## Product

Build a cross-platform, local-first Git client. Deliver and qualify Windows first, then extend support to macOS and Linux. Target broad Git Extensions functional coverage and a calm, compact developer interface inspired by T3 Code. Prefer TypeScript and Bun. Do not use Electron. Use an upstream development workflow, not a new orchestration framework. No mandatory cloud account or AI dependency for ordinary Git work.

Windows-first sets delivery order, not a permanent platform restriction. Keep shared frontend, contracts, and Git service logic portable. Isolate unavoidable platform-specific behavior within the selected Tauri/Bun architecture. Qualify packaged builds separately before claiming support for macOS or Linux.

Working name: **Arbareto** (ar-buh-RET-oh); executable name `arbareto`.
Naming status: on 2026-09-28, `arbareto` was free on GitHub, npm, crates.io, winget, and the .com, .app and .dev domains. A registered-trademark check is still open. This is a development name, not a claim of exclusive ownership.

## Selected architecture and deferred alternatives

| Area | Decision or proposal | Reason and qualification |
| --- | --- | --- |
| Desktop shell | Tauri 2 with a compiled TypeScript/Bun Git service | Selected for the first qualification feature. Supports sidecar packaging, scoped frontend permissions, and signature-enforcing updates. Requires Rust and platform-specific build tools. Initial Windows builds require MSVC. [S1–S3] |
| Deferred shell research | Electrobun | Not selected for implementation. Do not prototype it during the first qualification feature. References remain for deferred research only. [S4–S6] |
| Rejected for present implementation | bunvjs/bunv | The inspected main entry point is a hello-world script and its manifest does not implement the advertised desktop build workflow. Reconsider only after concrete implementation and packaged Windows evidence exist. [S7] |
| Other evaluated candidates | webview-bun, Tronbun, BunDesk | Respectively: a low-level binding requiring additional product infrastructure; an explicitly alpha framework; and a real framework whose own production-parity work remains incomplete. These are alternatives, not equivalent production-ready choices. [S8–S10] |
| Git engine | Installed native Git, initially Git for Windows, called through bounded typed operations | Use existing Git semantics rather than build a Git implementation. Record the chosen executable and its version; do not silently replace the user's Git configuration. |
| UI | React, TypeScript, Tailwind, one Base UI-based shadcn component system | Reuse the applicable direction from T3 Code without copying its Electron shell, Node server, or agent orchestration. [S11] |
| Development | Bun package management and scripts; Vite explicitly run under Bun | Avoid accidental Node execution through a CLI's shebang. The documented invocation is `bunx --bun vite`. [S12] |
| Diff display | Evaluate @pierre/diffs first; keep editable merge tooling separately qualified | A visual diff component is not an authoritative patch/staging engine. Its editing mode is currently described as beta. [S13] |
| History virtualization | TanStack Virtual | Headless control fits aligned graph lanes and revision rows. This is a design-fit choice, not a measured speed advantage over T3 Code's list component. [S14] |
| Process and test runtime | Bun | Compile the background service for distribution; keep unit and Git-fixture tests under Bun. [S15] |
| Development process | GitHub Spec Kit v1.0.12 for this guide | One upstream source of feature requirements, plans, and tasks. Do not add parallel Superpowers and OpenSpec planning trees. [S16] |

Use Tauri 2 for the first qualification feature. Do not implement Electrobun, multiple shell adapters, or a framework-independent desktop abstraction. Validate the selected architecture through packaged Windows tests. Record concrete failures, their causes, and attempted remedies. Consider another shell only when a blocking requirement cannot reasonably be satisfied by the current architecture. Do not claim Tauri is faster than Electrobun without measurements.

## Feature coverage target

The Git Extensions manual is a scope reference, not a claim that this application has implemented anything. The phases below are proposed priorities, not dates or measured parity percentages. Git Extensions' own plugin inventory is explicitly incomplete. [S17]

| Area | Target | Proposed phase |
| --- | --- | --- |
| Repository workspace | Open, initialize, clone, recent repositories, grouping, switch repositories | Daily-use release |
| Status and changes | Tracked/untracked/ignored distinctions; staged and unstaged state; refresh after external changes | Daily-use release |
| Diff review | Unified/split views, whitespace options, file status and rename display, binary-file fallback | Daily-use release |
| Staging | Stage/unstage files, hunks, selected lines; support a file in both staged and unstaged lists | Daily-use release |
| Commit | Message composition, commit, amend, author identity, hook failures, signing status | Daily-use release |
| History | Virtualized graph and rows, revision details, branch filtering, search, compare revisions | Daily-use release |
| Branches and tags | Create, switch, rename/delete, tracking; create/delete tags | Daily-use release |
| Remotes | Add/edit/remove remotes, fetch, push, explicit pull behavior, progress and authentication cancellation | Daily-use release |
| Stash | Create, inspect, apply, pop, drop; surface resulting conflicts | Daily-use release |
| Basic conflict handling | Detect operation state, show conflicted files, launch configured merge tool, continue/abort | Daily-use release |
| Rewrite and recovery | Cherry-pick, revert, reset variants, reflog inspection, recover reachable retained objects | Power-user release |
| Advanced rebase | Reword, reorder, squash, fixup, drop, autosquash, rebase-onto, continue/skip/abort | Power-user release |
| Integrated merge | Review base/current/incoming/result; edit and validate result before marking resolved | Power-user release |
| Worktrees | Discover, add, remove, lock/prune/repair where supported; navigate shared repositories correctly | Power-user release |
| Submodules | Discover, add, initialize/update, inspect nested status, navigate, remove with explicit safeguards | Power-user release |
| File archaeology | File history, blame, historical file viewing, revision comparison | Power-user release |
| Patch workflows | Export/apply patches and patch series, operation recovery, notes | Power-user release |
| Configuration | Git executable, identity, signing, SSH, external diff/merge/editor tools, ignore patterns, shortcuts, density/theme | Start early; expand through power-user release |
| Maintenance | Explicit repository maintenance, retained-object recovery, author-data corrections with rewrite safeguards | Advanced coverage |
| Provider integration | GitHub clone/fork/PR/upstream workflows; CI/build status; later provider adapters | Advanced coverage |
| Windows integration | Open from Explorer, application CLI/deep links, external editor/terminal launch | Basic launch early; deeper integration later |
| Plugin-function equivalents | Obsolete-branch cleanup, large-object discovery, scheduled fetch, statistics, release notes, external visualizers | Advanced coverage, individually scoped |
| Extension compatibility | Functional equivalents where useful; no promise of loading Git Extensions .NET plugins | Explicit non-goal for binary compatibility |

Additional product requirements, not represented here as verified Git Extensions parity: Git LFS handling, sparse/shallow repositories, repository trust, no cloud dependency, malformed-output robustness, large-repository performance budgets, and future Windows ARM qualification.

Do not count a button or happy-path command as completion. Each feature needs success, failure, cancellation/interruption where meaningful, external-change, and safety scenarios.

## Interface direction

Use a source-control workbench, not a dashboard of cards or an AI-chat-first layout. Keep the content dense enough for daily development while maintaining readable text, resizeable panels, visible focus, and a comfortable-density option. The frontend-design skill's planning/review approach informs this brief; its generic website motifs are not product requirements. [S18]

### Initial tokens (design proposal)

| Role | Value |
| --- | --- |
| Workspace background | `#17181C` |
| Elevated surface | `#202228` |
| Main text | `#E8E9ED` |
| Secondary text | `#ABB0BB` |
| Selection/focus accent | `#8CB4F8` |
| Structural border | `#343740` |

Use a separate accessible semantic diff palette with plus/minus and text/status cues, never color alone. Develop a light theme with the same semantic roles. UI typography: Segoe UI Variable with system fallbacks. Code: Cascadia Code, Consolas, monospace. Font sizes and contrast require actual screenshot/accessibility validation; these values are not a completed accessibility audit.

### Layout options

Choose one persistent frame with Changes and History modes. A full always-visible five-pane layout would retain too much Git Extensions visual congestion. A chat-first layout would hide the application's primary work.

```text
Repository / branch                         Fetch   Pull   Push   Search
------------------------------------------------------------------------
Repositories / refs | Changes: unstaged / staged | Diff                 |
                    |                           |                      |
                    |                           |                      |
                    | Commit message + action   |                      |
------------------------------------------------------------------------
Operation progress / errors / command details (collapsible)
```

History mode replaces the changes workspace with a commit graph and a selected-revision inspector; preserve repository, filter, scroll and selection state. Offer a bottom-inspector option for narrow windows rather than forcing tiny three-column panes.

Use explicit labels: Stage selected lines, Unstage, Discard changes, Continue rebase. Keep destructive commands out of the primary toolbar. Provide keyboard and context-menu equivalents. Preserve Windows caption behavior, snapping, accessibility, DPI scaling, and IME input. Review screenshots of populated, empty, loading, error and conflict states, not just the attractive happy path.

## Implementation boundaries

Use one repository with three source boundaries: frontend, TypeScript/Bun Git service, and shared operation contracts. Keep Tauri 2 as a thin platform layer. Do not add multiple shell adapters or a framework-independent desktop abstraction. Do not add generic plugin platforms, universal command buses, event sourcing, or monorepo machinery without a concrete requirement.

The UI must not receive arbitrary shell access. Expose explicit operations against registered repository IDs. Validate parameters in the service. Use argument-array process spawning, literal-path handling, bounded output, cancellation, and a trusted Git executable. Escaping a command string is not the security design.

Keep shared code portable. Do not assume Windows path syntax, filesystem case rules, shell names, or Git locations in shared code. Limit platform-specific behavior to the boundaries that need it.

Git remains authoritative. Use NUL-delimited machine-readable status, not localized human output. Background status reads should avoid optional index locks. Cache immutable object data and invalidate mutable status/ref views after both application operations and external changes. Watchers are hints, not a complete transaction log. [S19]

Linked worktrees share some state while keeping other state, such as their indexes, separate. Determine repository and common-directory identity using Git. Do not assume `.git` is always a directory. Start conservatively with app-initiated mutation serialization across a shared repository, while acknowledging that external Git processes are not controlled by that queue. [S20]

Partial staging must be computed against the correct index and working-file snapshots. Reject stale selections. Tests must assert the resulting index contents and unchanged working-file bytes, not just a successful command exit.

Treat repository content as untrusted text. Disable unnecessary executable diff/preview integrations for untrusted repositories. Keep hooks and configured tools explicit. Never embed credentials in operation logs. A cancellation is not proof of rollback; re-read Git's operation state. Reflog recovery does not recover arbitrary never-committed discarded files.

For compiled Bun distribution, disable unintended working-directory configuration autoload and sanitize runtime-control environment variables. Use an application-owned launch directory, not an arbitrary checked-out repository. Review the compiled executable flags against the pinned Bun version. [S15]

An integrated terminal is a separate feature. Bun's current documentation includes Windows ConPTY, but lifecycle behavior differs across Windows versions; verify PowerShell, Git Bash, resize, Unicode, interruption and child-process cleanup before shipping. [S21]

## Development tools and skills

Default MCP selection: Context7 remote for targeted documentation; GitHub's official server with a small read-only tool selection, or the existing `gh` CLI when it suffices. Do not enable an all-tools preset. [S22–S23]

First local exploration tool: the existing CodeGraph installation, after verifying its actual upstream identity and version. The comparison here targets `colbymchenry/codegraph` / `@colbymchenry/codegraph`; another product called CodeGraph must be assessed separately. Activate indexing after meaningful source exists. Use narrow graph queries, check freshness and validate findings against files and compiler/tests. Do not treat static graph edges as complete coverage of dynamic or IPC behavior. [S33]

CodeGraph bundles a Node runtime; it is not Bun-native. Its documentation describes default-on telemetry, which can be disabled. Its own residual-context benchmark warns that fewer processed tokens can still leave more context resident; there is no independent Serena-versus-CodeGraph result established here. Disable telemetry for this setup and do not add blanket tool permissions. [S34–S36]

Serena remains an optional semantic-editing/LSP tool, not a default second indexer. Its TypeScript backend explicitly requires Node and npm on PATH. Prefer normal editor/compiler capabilities unless there is a demonstrated unmet refactoring need. Neither development tool ships with Arbareto. A strict prohibition on all development-time Node runtimes would exclude CodeGraph as well as this Serena backend. [S37]

On demand: DeepWiki for source-repository orientation, shadcn skills for UI assembly, and the existing context-mode installation for genuinely large logs. Check retrieved claims against pinned source. Do not add a second memory ledger or always-loaded repository summary. [S24–S27]

Skills: Anthropic frontend-design for screen planning; shadcn's official skill for components; Vercel react-best-practices for applicable client-side performance guidance and web-design-guidelines for review. Do not install unrelated deployment/Next.js skills. [S18, S25, S28]

Superpowers is a valid alternative complete process. Its existing executing-plans route is lower-orchestration than per-task subagents. Do not run its full automatic planning workflow in parallel with Spec Kit. Focused debugging/testing skills may be evaluated separately, without duplicating feature plans. [S29]

Playwright CLI plus skills is a useful optional browser-inspection tool, but its published requirements include Node. It is not silently Bun-native. For a no-Node development environment, use the documented direct tauri-driver route with a non-Node WebDriver client for packaged Windows tests. Bun.WebView is another experimental renderer-testing candidate, not a desktop shell or complete native-UI test solution. [S30–S32]

## First Spec Kit feature: Tauri 2 desktop qualification

### Bootstrap

The repository already has Spec Kit v1.0.12. The commands below are reference instructions for a new repository; do not rerun initialization here. Python/uv and Rust/MSVC are development dependencies. No Node runtime is proposed for the distributed app.

```powershell
uvx --from git+https://github.com/github/spec-kit.git@v1.0.12 specify init arbareto --integration claude --script ps --non-interactive
cd arbareto
```

The guide pins Spec Kit to v1.0.12. Claude uses `/speckit-...` skills; Codex uses `$speckit-...`. Its active feature is recorded in `.specify/feature.json`; changing Git branches alone does not change it. Branches are managed explicitly in the guide, without an additional Git extension. Preserve the upstream specify/clarify/plan/checklist/tasks/analyze/implement/converge flow. [S16, S38]

### Constitution input

Protect user changes. Treat Git as authoritative. Do not use Electron. Deliver Windows first while preserving portability for later macOS and Linux support. Use Tauri 2 with a compiled TypeScript/Bun Git service for the first qualification feature. Justify native code by a concrete platform requirement. Verify risky Git behavior with real temporary repositories. Preserve keyboard accessibility. Validate the selected architecture through packaged Windows tests. Record concrete failures and their causes. Measure packaged Windows performance. Use only upstream Spec Kit artifacts for planning. Do not add custom orchestration files, automatic multi-agent review loops, or duplicate plan trees. Never mark a Windows behavior verified from a browser-only test.

### Feature input for the specification step

> Build a packaged Windows qualification slice for a cross-platform, local-first Git client. Preserve portability for later macOS and Linux qualification. Use Tauri 2 with a compiled TypeScript/Bun Git service. Open ordinary repositories and linked worktrees. Show status, a bounded history page, and a selected file diff. Support staging and unstaging one selected hunk. Create a commit in a disposable test repository. Keep the UI interactive while Git is busy, and reconcile external changes. Do not implement Electrobun, multiple shell adapters, or a framework-independent desktop abstraction. Do not implement the full application or a new development framework. Validate the selected architecture through packaged Windows tests. Record concrete failures and their causes. Consider another shell only when a blocking requirement cannot reasonably be satisfied by the current architecture. Do not claim Tauri is faster than Electrobun without measurements.

Keep architecture qualification evidence, failures, causes, and attempted remedies in the native Spec Kit plan/research artifacts. Do not create separate qualification documents.

### Acceptance scenarios

| Scenario | Required evidence |
| --- | --- |
| Packaging | Install and start as a standard Windows user; no globally installed Node or Bun required by the product. Record WebView2/Git prerequisites. |
| Native experience | Folder dialog, clipboard, focus restoration, shortcuts, DPI scaling, IME, window resize/snap and application shutdown behave correctly. |
| Git parsing | Tests cover Unicode/spaced paths, CRLF, renames, binary files, empty/unborn repositories, linked worktrees and simultaneous staged/unstaged changes. |
| Partial staging | Only selected changes enter the index; working-file bytes remain intact; stale selection is refused or safely refreshed. |
| External changes | Another Git process can change refs/index; the app detects stale state instead of overwriting it blindly. |
| Lifecycle | Long reads can be canceled; closing the app does not leave unintended child processes; interrupted mutations surface the real resulting state. |
| Security | Renderer cannot request arbitrary commands; malformed inputs are rejected. The plan identifies an authenticated update path and its verification tasks. If updater implementation is included in this slice, tampered-update rejection must be tested; otherwise production release remains explicitly blocked on that later verification, rather than being marked passed. |
| Architecture qualification | Test the packaged Tauri 2 application and compiled Git service on Windows. Record concrete failures, their causes, and attempted remedies. |
| Performance | Measure the packaged Tauri 2 application on agreed repositories and hardware. Record cold/warm behavior, UI stalls, CPU, and complete process-tree memory. Use Git Extensions as a baseline under matching conditions. Do not claim Tauri is faster than Electrobun without measurements. |

Use Windows 11 x64 as the initial proposed qualification environment, not an assertion about the user's installed OS. Decide Windows 10 and ARM support explicitly before promising them. Include Defender-enabled runs, a moderate development repository and a large-history fixture. This initial scope does not remove macOS or Linux from the product targets. Define their supported versions and architectures before qualification. Passing on one operating system does not qualify another.

Proposed starting budgets, not measurements: visible input acknowledgement within 100 ms; cached repository switching within 500 ms; cold usable workspace around 1.5 seconds on agreed hardware; no long main-thread stalls while loading history. Report misses honestly and revise targets only with an explicit product trade-off, not to make a test green.

### Normal delivery after qualification

Use upstream specification, clarification where needed, plan, requirements checklist, tasks, analysis, implementation and convergence steps. One active feature at a time. Start implementation in a fresh context with the active feature files and relevant source/tests; do not load all past specifications. Use one independent review for meaningful changes, with extra scrutiny for destructive operations. Preserve upstream artifacts as the durable record, not extra generated status documents.

Next slices: reliable changes/commit workflow; history navigation; remotes and authentication; branch/stash/conflict workflows; advanced history; worktrees/submodules; remaining coverage. Small bug fixes should not regenerate the entire product specification.

## Primary references

All URLs below were inspected as research sources; moving main branches may change. They are not dependency pins.

- S1: Tauri sidecars — https://v2.tauri.app/develop/sidecar/
- S2: Tauri updater — https://v2.tauri.app/plugin/updater/
- S3: Tauri capabilities / Windows distribution — https://tauri.app/security/capabilities/ ; https://v2.tauri.app/distribute/windows-installer/
- S4: Electrobun runtime selection — https://framework.blackboard.sh/electrobun/guides/native-main-process/
- S5: Electrobun signing — https://framework.blackboard.sh/electrobun/guides/code-signing/
- S6: Electrobun updates / releases — https://framework.blackboard.sh/electrobun/guides/updates/ ; https://github.com/blackboardsh/electrobun/releases
- S7: Bunv implementation — https://github.com/bunvjs/bunv ; https://raw.githubusercontent.com/bunvjs/bunv/main/index.ts ; https://raw.githubusercontent.com/bunvjs/bunv/main/package.json
- S8: webview-bun — https://github.com/tr1ckydev/webview-bun
- S9: Tronbun — https://github.com/ydeshayes/tronbun
- S10: BunDesk — https://github.com/liooil/bundesk
- S11: T3 Code source — https://github.com/pingdotgg/t3code ; https://raw.githubusercontent.com/pingdotgg/t3code/main/apps/web/package.json ; https://raw.githubusercontent.com/pingdotgg/t3code/main/apps/web/components.json ; https://raw.githubusercontent.com/pingdotgg/t3code/main/apps/desktop/src/main.ts
- S12: Bun and Vite — https://bun.com/guides/ecosystem/vite
- S13: Pierre Diffs — https://diffs.com/
- S14: TanStack Virtual — https://tanstack.com/virtual/latest/docs/introduction
- S15: Bun compilation — https://bun.com/docs/bundler/executables ; https://bun.com/docs/bundler
- S16: Spec Kit — https://github.github.io/spec-kit/quickstart.html ; https://github.github.io/spec-kit/reference/integrations.html
- S17: Git Extensions scope — https://git-extensions-documentation.readthedocs.io/en/main/ ; https://git-extensions-documentation.readthedocs.io/en/main/browse_repository.html ; https://git-extensions-documentation.readthedocs.io/en/main/commit.html ; https://git-extensions-documentation.readthedocs.io/en/main/branches.html ; https://git-extensions-documentation.readthedocs.io/en/main/remote_feature.html ; https://git-extensions-documentation.readthedocs.io/en/main/modify_history.html ; https://git-extensions-documentation.readthedocs.io/en/main/maintenance.html ; https://git-extensions-documentation.readthedocs.io/en/main/plugins.html
- S18: Anthropic frontend-design — https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md
- S19: Git status — https://git-scm.com/docs/git-status
- S20: Git worktrees — https://git-scm.com/docs/git-worktree ; https://git-scm.com/docs/gitrepository-layout
- S21: Bun subprocesses and terminals — https://bun.com/docs/runtime/child-process
- S22: Context7 — https://github.com/upstash/context7
- S23: GitHub MCP — https://github.com/github/github-mcp-server
- S24: DeepWiki — https://docs.devin.ai/work-with-devin/deepwiki-mcp
- S25: shadcn tooling — https://ui.shadcn.com/docs/mcp ; https://ui.shadcn.com/docs/new
- S26: Serena — https://github.com/oraios/serena
- S27: context-mode — https://github.com/mksglu/context-mode
- S28: Vercel skills — https://github.com/vercel-labs/agent-skills
- S29: Superpowers — https://github.com/obra/superpowers
- S30: Playwright CLI — https://github.com/microsoft/playwright-cli
- S31: Tauri WebDriver — https://v2.tauri.app/develop/tests/webdriver/
- S32: Bun.WebView — https://bun.com/docs/runtime/webview

- S33: CodeGraph source and integration — https://github.com/colbymchenry/codegraph ; https://colbymchenry.github.io/codegraph/reference/integrations/
- S34: CodeGraph runtime — https://raw.githubusercontent.com/colbymchenry/codegraph/main/BUNDLING.md
- S35: CodeGraph telemetry — https://raw.githubusercontent.com/colbymchenry/codegraph/main/TELEMETRY.md
- S36: CodeGraph author-run residual context benchmark — https://raw.githubusercontent.com/colbymchenry/codegraph/main/docs/benchmarks/residual-context-occupancy.md
- S37: Serena semantic features and TypeScript backend — https://oraios.github.io/serena/01-about/025_features.html ; https://raw.githubusercontent.com/oraios/serena/main/src/solidlsp/language_servers/typescript_language_server.py
- S38: Pinned Spec Kit docs — https://raw.githubusercontent.com/github/spec-kit/v1.0.12/docs/quickstart.md ; https://raw.githubusercontent.com/github/spec-kit/v1.0.12/docs/reference/integrations.md

## Later features

- PuTTY support for SSH: plan it with the feature that adds fetch, push, and pull. Let the user choose plink or OpenSSH. Start Pageant and load the remote key on request, and launch PuTTYgen. Set `GIT_SSH` only for processes that Arbareto starts, and never change the user Git configuration. A plink host-key prompt must fail fast and offer an accept step. This needs an amendment of feature 001 FR-051.
- Feature order after 001 (user decision, 2026-10-11): 002 is full history, and 003 is remote sync. Remote sync builds on the history graph. Feature 001 keeps its 100-commit first page.
- Full history (feature 002): the user can scroll to every commit, and RAM stays bounded. Read history in pages with a cursor. Define an exact paging rule across merges. Bind each page to one captured set of refs and the generation. The default set is all branches, as in the default Git Extensions view. Build graph lanes incrementally. Use a virtualized list that drops pages far off screen. Load commit bodies only for the details pane. Set a RAM budget.
- Commit message filter (feature 002): Git searches the whole history with `rev-list --grep`, and `--fixed-strings` is the default. The matches come back through the same pages. Filter mode shows only the matches, with a reduced graph. Highlight mode shows the full graph, with Next match and Previous match. Author and content filters come later on the same mechanism.
- Speed baseline for feature 002: compare matched work with Git Extensions, for a full scroll and for a message filter.
- Remote sync (feature 003): Fetch, Pull, Push, ahead and behind counts in the toolbar and the references sidebar, the push-rejected notice, Commit & push, and Clone. The status read already parses `# branch.upstream` and `# branch.ab`. PuTTY support stays as its own bullet.
- Branch operations: checkout, merge, rebase, reset, cherry-pick, revert, and tag creation. Add the branch and commit context menus, actions on the references sidebar entries, and "Contained in branches and tags". Add the conflict panel, its band actions (Resolve, Continue, Skip, Abort), and the step and resolved counts. Take the resolved state only from index records, never from file text.
- Amend, with history rewriting: the Amend checkbox, the loaded last message, and a "not pushed yet" note from upstream data (003).
- History inspection: the Changes and Files tabs of the commit details, historical diffs, branch filtering, author and content filters on the 002 filter mechanism, and a column header row.
- Stash: the toolbar button, the Stashes group of the references sidebar, and "Stash staged".
- Submodule and worktree management, with the Submodules and Worktrees groups of the references sidebar.
- Settings and presets: Git configuration by scope (effective, local, global, system), and presets for diff tools, merge tools, and editors.
- Recent repositories follow-up: pinned entries, and opening a folder by drag and drop.
- Custom title bar after feature 002, as in the Zed editor. The app menu, the repository switcher, and the branch move into a drawn title bar. It has its own window buttons and Snap Layouts. The toolbar row then goes, and each floor loses one header row (40/44 DIPs). Facts for Tauri 2.12.1 (tao 0.37.1, wry 0.57.0, webview2-com 0.39.1), checked on 2026-10-10; the feature copies them into its own research.md:
  - Decorations off: tao removes `WS_CAPTION` and keeps `WS_SYSMENU`, and `WM_NCCALCSIZE` returns 0 (`tao-0.37.1/src/platform_impl/windows/window_state.rs:241,268-269`, `event_loop.rs:2074-2124`).
  - Resize borders: Tauri adds the child window `TAURI_DRAG_RESIZE_BORDERS` for resize hit tests (`tauri-runtime-wry-2.12.1/src/lib.rs:5215-5217`, `undecorated_resizing.rs:117-196`). The default `shadow` true lets DWM draw the shadow (`tauri-utils-2.10.1/src/config.rs:2441`).
  - Drag region: wry enables WebView2 non-client region support, so CSS `app-region: drag` works. It moves the window, opens the system menu on a right click, and maximizes on a double click (`wry-0.57.0/src/webview2/mod.rs:668`). `data-tauri-drag-region` needs extra window permissions and shows no system menu.
  - Snap Layouts: Windows 11 shows them only when `WM_NCHITTEST` returns `HTMAXBUTTON` over the maximize button (Microsoft Learn "Support snap layouts for desktop apps on Windows 11"). The shell needs a small native child window over the HTML maximize button. tauri-plugin-frame `snap_overlay` (MIT) uses that method. Reject tauri-plugin-decorum, because it sends Win+Z, which is input simulation. The WebView2 Window Controls Overlay is prerelease only, and webview2-com-sys 0.39.1 has no binding for it.
  - Accessibility and checks: the HTML buttons need the names "Minimize", "Maximize" or "Restore", and "Close", and forced-colors styles. Alt+Space must still open the system menu. Test Snap Layouts hover, drag, double-click maximize, resize on every edge, the maximized taskbar gap, forced colors, 100/150/200% scaling, and mixed-DPI moves. The native title text keeps naming the window in the taskbar and Alt+Tab (`set_title`).
- Repository tabs in the later custom title bar: an idea to evaluate there. Each tab would hold one open worktree; feature 001 opens one repository at a time.
