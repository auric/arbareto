---
name: arbareto-ux
description: >
  Arbareto UX reference and rules. Load it first for any Arbareto UI work:
  designing, mocking up, building, or reviewing a window, pane, list, toolbar,
  sidebar, context menu, dialog, notice, settings page, or commit and diff view.
  It names Git Extensions as the layout reference, the user's UX rules, the
  skills to pair with it, and the mockup-first delivery flow. Use it even when
  the request only says "UI", "layout", "screen", "frontend", or "make it look
  like Git Extensions".
---

Load this skill before you design or build Arbareto UI. The rules below come from the user (2026-10-10). The plan.md design tokens, fonts, layout, and texts override any other skill advice.

## 1. Reference: Git Extensions

Git Extensions is a Windows Git GUI under GPL-3.0. Borrow behavior and layout ideas only. Never copy its code, icons, or other assets. Arbareto must be much faster than it.

- **Main window.** A menu bar. A toolbar of icon buttons with tooltips: refresh, layout toggles, open repository with a recent-repositories dropdown, current-branch dropdown, fetch, pull, and push with ahead/behind counts, commit with the change count, stash, file explorer, settings, branch filter, text filter.
- **Left sidebar.** A tree with its own scrollbar and a search box. Groups: Branches (current branch in bold, ahead/behind counts), Remotes, Worktrees, Tags, Submodules (nested, with a "no branch" state), Stashes.
- **Center.** The revision graph list. Special rows "Working directory" and "Commit index" sit above the commits and show change counts or a clean mark. Branch and remote labels are colored chips. Columns: subject, author avatar and name, relative date, short ID. The list has its own scrollbar.
- **Bottom.** Tabs Commit, Diff, and File tree. Commit shows author, date, hash, child and parent links, and "contained in branches/tags". Diff shows a file tree with a filter on the left and the diff on the right, with line numbers and a toolbar. Each region scrolls by itself. Splitters separate the regions.
- **Context menus.** On a commit: checkout, create branch here, rebase current branch on, reset current branch to here, create tag, cherry-pick, revert, copy hash. On a branch: checkout, merge into current branch, rebase current branch on this branch, create, rename, delete.
- **Commit workflow.** Unstaged and staged lists with Stage and Unstage buttons between them. The diff is beside the lists. The message editor is below. Buttons: Commit, Commit & push. An Amend checkbox loads the current commit message. Also Stash staged changes and Reset changes. A status line shows the committer, branch → upstream, and the staged count.
- **Push rejected (non-fast-forward).** A notice offers Pull with rebase, Pull with merge, Force push with lease, and Cancel.
- **Settings.** Git config by scope: effective, local, global, system. Presets for popular diff tools, merge tools, and editors. Line-ending choices.

## 2. Arbareto UX rules

- Keep everything important visible and at hand.
- Prefer an icon with an accessible name and a hover tooltip to a long or truncated text label.
- Never truncate meaning unless a tooltip and the accessible name give the full text.
- Give every pane its own scrollbar. The window as a whole never scrolls. Put splitters between panes.
- Show the item at once when a click or an arrow key selects it (diff, commit details).
- Prefer docked, non-modal panels and inline notices. Use a modal dialog only for a destructive confirmation or a native OS picker.
- Avoid feature overload. Show the most used actions. Put the rest in menus.
- Keyboard first: one Tab stop per list, roving focus, visible focus.
- Meet WCAG AA contrast. Support forced colors, light and dark themes, and compact and comfortable density.

## 3. Tools to pair with this skill

- `frontend-design`: visual direction, within the plan.md tokens.
- `web-design-guidelines`: review of UI code and mockups.
- `vercel-react-best-practices`: React code (client-side rules only).
- `shadcn`: components. Run the generator only as `shadcn@4.21.0`, never `@latest`.
- Project rules in CLAUDE.md: no heuristics; no mock data shown as real; every visible text comes from plan.md.

## 4. Delivery flow

1. **Mockup.** Build a static HTML mockup for the user's review. Use only sample data that is clearly marked as sample, never private repository data. Change no plan.md or code in this step.
2. **Plan.** After the user approves, update plan.md (texts, layout, tokens) through the Spec Kit flow: `/speckit-plan`, then `/speckit-tasks`, then `/speckit-analyze`.
3. **Code.** Implement only the recorded tasks. Show honest states (loading, empty, error, refused). Never show a placeholder as real Git data.
