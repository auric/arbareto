// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// plan.md "Keyboard and focus". Only Ctrl+Enter in the message field commits, and the page handler maps no single-letter key or Space.

/** The docked panel below the history list (plan.md "Dock region"), or the feature 004 Settings view (plan.md D15 F6 order). */
export type Panel = "commit" | "details" | "settings";
export type Section =
  | "header"
  | "noticeHeading"
  | "references"
  | "historyList"
  | "workingChanges"
  | "staged"
  | "comparison"
  | "composer"
  | "commitDetails"
  | "scopeBar"
  | "pageList"
  | "pageContent"
  | "statusRegion";

export type ShortcutAction =
  | { type: "refresh" }
  | { type: "openFolder" }
  | { type: "openSwitcher" }
  | { type: "focusSection"; direction: "next" | "previous" }
  | { type: "focusMenuBar" }
  | { type: "selectHunk"; direction: "next" | "previous" }
  | { type: "commit" }
  // Feature 002 plan.md D6 "Shortcuts".
  | { type: "focusFilter" }
  | { type: "match"; direction: "next" | "previous" }
  | { type: "toggleScope" }
  // Feature 003 plan.md D12: Fetch, the Pull main part, and Push.
  | { type: "sync"; control: "fetch" | "pull" | "push" };

export type ShortcutContext = {
  messageField: object | null;
  comparisonPane: object | null;
  modalOpen: boolean;
  menuOpen: boolean;
  commitEnabled: boolean;
};

export type ShortcutEvent = Pick<KeyboardEvent, "type" | "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "repeat" | "isComposing" | "getModifierState" | "preventDefault"> & {
  composedPath(): readonly unknown[];
};

type Target = { tagName?: string; type?: string; isContentEditable?: boolean };

// HTML input types that take no typed text.
const NON_TEXT_INPUTS = new Set(["button", "submit", "reset", "checkbox", "radio", "image", "file", "color", "range", "hidden"]);

export function isEditable(target: Target | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable === true) return true;
  const tag = target.tagName?.toUpperCase();
  if (tag === "TEXTAREA") return true;
  return tag === "INPUT" && !NON_TEXT_INPUTS.has((target.type ?? "text").toLowerCase());
}

const mods = (e: ShortcutEvent) => `${+e.ctrlKey}${+e.shiftKey}${+e.altKey}${+e.metaKey}`;
const NONE = "0000";
const CTRL = "1000";
const SHIFT = "0100";
const ALT = "0010";
const CTRL_SHIFT = "1100";

/** One handler per page. It keeps the lone-Alt state between events. */
export function createShortcutHandler() {
  let altArmed = false;

  function resolve(e: ShortcutEvent, context: ShortcutContext): ShortcutAction | null {
    if (e.isComposing || e.getModifierState("AltGraph")) {
      altArmed = false;
      return null;
    }
    if (e.type === "keyup") {
      const lone = altArmed && e.key === "Alt";
      altArmed = false;
      return lone ? { type: "focusMenuBar" } : null;
    }
    if (e.type !== "keydown") return null;
    if (e.key === "Alt") {
      if (!e.repeat) altArmed = mods(e) === ALT;
      return null;
    }
    altArmed = false;
    if (e.repeat) return null;

    const path = e.composedPath();
    const target = path[0] as Target | undefined;
    const editable = isEditable(target);
    const inMessage = context.messageField !== null && target === context.messageField;
    const blocked = context.modalOpen || context.menuOpen;
    const m = mods(e);

    if (e.key === "F10" && m === NONE) return { type: "focusMenuBar" };
    if (blocked) return null;
    if (e.key === "F5" && m === NONE) return { type: "refresh" };
    if (e.key === "F6" && (m === NONE || m === SHIFT)) return { type: "focusSection", direction: m === SHIFT ? "previous" : "next" };
    if (e.key === "Enter" && m === CTRL) return inMessage && context.commitEnabled ? { type: "commit" } : null;
    // These keys type no text, so they work in text fields too. The 001 accelerator handler turns off the WebView2 find keys.
    if (e.key === "F3" && (m === NONE || m === SHIFT)) return { type: "match", direction: m === SHIFT ? "previous" : "next" };
    if (m === CTRL && e.key.toLowerCase() === "f") return { type: "focusFilter" };
    if (m === CTRL_SHIFT && e.key.toLowerCase() === "b") return { type: "toggleScope" };
    if (editable) return null;
    // `key` is the letter of the active layout (UI Events KeyboardEvent key). Caps Lock gives the capital without Shift.
    const letter = m === CTRL ? e.key.toLowerCase() : null;
    if (letter === "o") return { type: "openFolder" };
    if (letter === "r") return { type: "openSwitcher" };
    if (m === CTRL && e.key === "ArrowDown") return { type: "sync", control: "pull" };
    if (m === CTRL && e.key === "ArrowUp") return { type: "sync", control: "push" };
    if (m === CTRL_SHIFT && e.key === "ArrowDown") return { type: "sync", control: "fetch" };
    if (m === ALT && (e.key === "ArrowUp" || e.key === "ArrowDown") && context.comparisonPane !== null && path.includes(context.comparisonPane)) {
      return { type: "selectHunk", direction: e.key === "ArrowUp" ? "previous" : "next" };
    }
    return null;
  }

  return (event: ShortcutEvent, context: ShortcutContext): ShortcutAction | null => {
    const action = resolve(event, context);
    if (action) event.preventDefault();
    return action;
  };
}

/** Feature 005 plan.md D15: the History regions where Ctrl+F focuses Filter files. */
export const HISTORY_FILES_SCOPE = '[data-slot="changed-files"], [data-slot="history-diff"]';

/** Feature 004 and 005 plan.md D15 keyboard map, Ctrl+F: the filter of the active view. History keeps the 002 history filter outside Changed files and the diff. Settings has "Find a setting". */
export function filterTarget(view: "history" | "commit" | "settings", focused: { closest(selector: string): unknown } | null = null): "history" | "historyFiles" | "files" | "settings" {
  if (view === "history") return focused?.closest(HISTORY_FILES_SCOPE) ? "historyFiles" : "history";
  return view === "commit" ? "files" : "settings";
}

// Feature 004 plan.md D15 keyboard map. A region calls `scopedAction` from its own key handler, so each key acts only there (spec FR-087).

/** The focused region of a scoped key. */
// Feature 005 plan.md D15 adds the Changes list, the Submodules group row, and the ignore editor panel.
export type KeyScope = "localBranchRow" | "remoteBranchRow" | "historyRow" | "diff" | "fileList" | "message" | "panel" | "settingsView" | "changesList" | "submoduleRow" | "ignoreEditor";
export type ScopedAction =
  | "switch"
  | "merge"
  | "rebase"
  | "createBranch"
  | "rename"
  | "delete"
  | "stageLines"
  | "unstageLines"
  | "stageEntry"
  | "previousHunk"
  | "nextHunk"
  | "primary"
  | "save"
  | "deleteFiles"
  | "deletePermanently"
  | "openSubmodule"
  | "closeEditor";
const BRANCH_ROWS: readonly KeyScope[] = ["localBranchRow", "remoteBranchRow"];
/** `aria` is the `aria-keyshortcuts` value, `text` is the visible key text. */
export const KEYS: Record<ScopedAction, { aria: string; text: string; scopes: readonly KeyScope[] }> = {
  switch: { aria: "Control+.", text: "Ctrl+.", scopes: BRANCH_ROWS },
  merge: { aria: "Control+M", text: "Ctrl+M", scopes: BRANCH_ROWS },
  rebase: { aria: "Control+Shift+E", text: "Ctrl+Shift+E", scopes: BRANCH_ROWS },
  createBranch: { aria: "Control+B", text: "Ctrl+B", scopes: [...BRANCH_ROWS, "historyRow"] },
  rename: { aria: "F2", text: "F2", scopes: ["localBranchRow"] },
  delete: { aria: "Delete", text: "Del", scopes: ["localBranchRow"] },
  stageLines: { aria: "S", text: "S", scopes: ["diff"] },
  unstageLines: { aria: "U", text: "U", scopes: ["diff"] },
  stageEntry: { aria: "Space", text: "Space", scopes: ["fileList"] },
  previousHunk: { aria: "Alt+ArrowUp", text: "Alt+Up", scopes: ["diff"] },
  nextHunk: { aria: "Alt+ArrowDown", text: "Alt+Down", scopes: ["diff"] },
  primary: { aria: "Control+Enter", text: "Ctrl+Enter", scopes: ["message", "panel"] },
  save: { aria: "Control+S", text: "Ctrl+S", scopes: ["settingsView", "ignoreEditor"] },
  deleteFiles: { aria: "Delete", text: "Del", scopes: ["changesList"] },
  deletePermanently: { aria: "Shift+Delete", text: "Shift+Del", scopes: ["changesList"] },
  openSubmodule: { aria: "Enter", text: "Enter", scopes: ["submoduleRow"] },
  closeEditor: { aria: "Escape", text: "Esc", scopes: ["ignoreEditor"] },
};
const BY_KEY = new Map(Object.entries(KEYS).flatMap(([action, k]) => k.scopes.map((scope) => [`${scope} ${k.aria}`, action as ScopedAction] as const)));

// The browser KeyboardEvent, not the React event: React events carry no `isComposing`.
export type ScopedKeyEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "isComposing">;

/** The D15 action of a key in `scope`, or null. A single letter matches without regard to Caps Lock. */
export function scopedAction(event: ScopedKeyEvent, scope: KeyScope): ScopedAction | null {
  if (event.isComposing) return null;
  const key = event.key === " " ? "Space" : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const aria = [event.ctrlKey && "Control", event.shiftKey && "Shift", event.altKey && "Alt", event.metaKey && "Meta", key].filter(Boolean).join("+");
  return BY_KEY.get(`${scope} ${aria}`) ?? null;
}

export type SectionState = {
  panel: Panel;
  hidden: readonly Section[];
  bandRows: number;
  status: { text: boolean; toggle: boolean; cancel: boolean };
};

const ORDERS: Record<Panel, readonly Section[]> = {
  commit: ["header", "noticeHeading", "references", "historyList", "workingChanges", "staged", "comparison", "composer", "statusRegion"],
  details: ["header", "noticeHeading", "references", "historyList", "commitDetails", "statusRegion"],
  settings: ["header", "noticeHeading", "scopeBar", "pageList", "pageContent", "statusRegion"],
};

/** The F6 order. It is the same in every profile. */
export function sectionOrder(panel: Panel): readonly Section[] {
  return ORDERS[panel];
}

function isStop(state: SectionState, section: Section): boolean {
  if (state.hidden.includes(section)) return false;
  if (section === "noticeHeading") return state.bandRows > 0;
  if (section === "statusRegion") return state.status.text || state.status.toggle || state.status.cancel;
  return true;
}

/** The next visible F6 stop after `current`, with wrap. Null when no section is a stop. */
export function nextSection(state: SectionState, current: Section, direction: "next" | "previous"): Section | null {
  const order = sectionOrder(state.panel);
  const step = direction === "next" ? 1 : -1;
  const index = order.indexOf(current);
  const start = index >= 0 ? index : direction === "next" ? -1 : order.length;
  for (let i = 1; i <= order.length; i++) {
    const section = order[(((start + step * i) % order.length) + order.length) % order.length]!;
    if (isStop(state, section)) return section;
  }
  return null;
}

/** The focus target when a focused band control disappears. */
export function bandFocusFallback(state: SectionState): Section | null {
  return state.bandRows > 0 ? "noticeHeading" : nextSection(state, "noticeHeading", "next");
}
