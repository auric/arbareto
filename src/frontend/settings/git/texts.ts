// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 004 plan.md D15 "Settings" texts, D11, spec FR-058 to FR-068, data-model §9.

export type Scope = "effective" | "local" | "global" | "system";
export type EntryScope = "system" | "global" | "local" | "worktree" | "command" | "submodule" | "unknown";

const SCOPE_NAMES: Record<EntryScope, string> = { system: "System", global: "Global", local: "This repository", worktree: "Worktree", command: "Command line", submodule: "Submodule", unknown: "Unknown scope" };
const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n.toLocaleString("en-US")} ${many}`);

// Labels of the FR-060 keys in Git's canonical form. A tool key takes the label of its section and variable.
const LABELS: Record<string, string> = {
  "user.name": "User name",
  "user.email": "User email",
  "core.editor": "Editor",
  "commit.template": "Commit message template",
  "credential.helper": "Credential helper",
  "diff.tool": "Diff tool",
  "difftool.path": "Diff tool path",
  "difftool.cmd": "Diff tool command",
  "merge.tool": "Merge tool",
  "mergetool.path": "Merge tool path",
  "mergetool.cmd": "Merge tool command",
  "core.autocrlf": "Line ending conversion",
  "i18n.filesencoding": "File encoding",
  "pull.rebase": "Pull with rebase",
  "pull.ff": "Fast-forward on pull",
  "push.default": "Which branch to push",
  "push.autosetupremote": "Set upstream on first push",
  "fetch.prune": "Remove deleted remote branches",
  "merge.autostash": "Autostash before a merge",
  "rebase.autostash": "Autostash before a rebase",
  "rebase.autosquash": "Autosquash in an interactive rebase",
  "rebase.updaterefs": "Move branches with the rebase",
  "rerere.enabled": "Reuse recorded conflict resolutions",
  "rerere.autoupdate": "Stage reused resolutions",
};

/** Spec FR-061 and plan D11 enumerations: a readable label for each exact Git value. The option shows the value after the label. */
export const ENUM_LABELS: Record<string, Record<string, string>> = {
  "core.autocrlf": { true: "Windows style: check out CRLF, commit LF", false: "No conversion", input: "Commit with LF only" },
  "pull.rebase": { true: "Rebase", false: "Merge", merges: "Rebase and keep merge commits", interactive: "Interactive rebase" },
  "pull.ff": { true: "Fast-forward when possible", false: "Always create a merge commit", only: "Fast-forward only" },
  "push.default": {
    nothing: "Push nothing without a named branch",
    current: "Current branch to a branch of the same name",
    upstream: "Current branch to its upstream branch",
    simple: "Current branch to its upstream branch of the same name",
    matching: "All branches with a remote branch of the same name",
    tracking: "Old name of upstream",
  },
};

export const TEXTS = {
  heading: "Settings",
  close: "Close settings",
  scope: "Scope",
  scopeName: (scope: EntryScope) => SCOPE_NAMES[scope],
  readOnlyMark: "read only",
  writesTo: (file: string) => `Writes to ${file}`,
  readsFrom: (file: string) => `Reads from ${file}`,
  effectiveNote: "Shows the value that Git uses, and its source.",
  noGlobalFile: "Arbareto cannot name the global Git configuration file, so Global is read only.",
  noLocalFile: "Arbareto cannot name the repository configuration file, so This repository is read only.",
  pages: "Settings pages",
  // Plan D15 "Find a setting".
  find: "Find a setting",
  findTooltip: "Find a setting (Ctrl+F)",
  noMatch: "No setting matches the filter.",
  needsRepository: "Git settings need an open repository.",
  loading: "The Git settings are still loading…",
  loadFailed: "The Git settings did not load: ",
  label: (key: string) => {
    const first = key.indexOf(".");
    const last = key.lastIndexOf(".");
    return LABELS[key] ?? LABELS[`${key.slice(0, first)}${key.slice(last)}`] ?? key;
  },
  notSet: "Not set",
  on: "On",
  off: "Off",
  custom: "Custom",
  from: (scope: EntryScope, origin: string) => `from ${SCOPE_NAMES[scope]} (${origin})`,
  notSetOther: (value: string, scope: EntryScope) => `Not set here. Git then uses ${value} from ${SCOPE_NAMES[scope]}.`,
  notSetDefault: "Not set here. No other scope sets it, so Git uses its default.",
  writesPreset: (key: string, value: string) => `Writes ${key}=${value}.`,
  emptyRemoves: "An empty field removes the key from this scope.",
  changed: "Changed",
  was: (value: string | null) => `Was: ${value ?? "not set"}`,
  // Plan.md D15 "Settings read-only reasons". `<file>` is the origin of the entry.
  readOnly: {
    "multi-value": (key: string) => `This scope sets ${key} more than once. Arbareto cannot save one value.`,
    included: (file: string) => `This value comes from ${file}. Change it in that file.`,
    "unreadable-value": () => "Git cannot read this value as on or off.",
  },
  pending: (n: number, scope: EntryScope) => (n === 1 ? `1 change. Save writes it to ${SCOPE_NAMES[scope]} only.` : `${plural(n, "change", "changes")}. Save writes them to ${SCOPE_NAMES[scope]} only.`),
  cancel: "Cancel",
  save: "Save",
  saving: "Arbareto saves the Git settings.",
  // Status bar names of a run (plan.md D15 "Status bar names" form).
  run: ["Save Git settings", "Saving Git settings", "Save Git settings details"] as [string, string, string],
  saved: "Git saved the settings.",
  unavailable: "Save is unavailable: ",
  failed: "Save did not complete: ",
  writeFailed: (key: string, reason: string | undefined, exit: number | null) => `Git did not write ${key}${reason === undefined ? "" : `: ${reason}`}${exit === null ? "" : ` (exit ${exit})`}.`,
  staleKey: (key: string) => `${key} changed before its write, so Arbareto did not write it.`,
  staleReview: "A setting changed after the review. Arbareto read the values again. Check them, then save again.",
  changedOutside: "A setting changed after Arbareto read it. Arbareto read the values again. Check them, then save again.",
  // Spec FR-066, FR-068, data-model §9 `appSettings`.
  appSetting: "Arbareto setting for all repositories. Not stored in Git configuration.",
  pullDefault: "Pull button default",
  pullDefaultNote: "The Pull button runs this action. Its menu offers the others.",
  switchChoice: "Local changes at a branch switch",
  switchChoiceNote: "The switch confirmation preselects this choice.",
  keep: "Keep changes",
  stash: "Stash and reapply",
  appFailed: "The setting did not change: ",
};
