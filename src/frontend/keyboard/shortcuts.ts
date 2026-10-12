// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// plan.md "Keyboard and focus". Only Ctrl+Enter in the message field commits, and no single-letter key or Space maps to an action.

/** The docked panel below the history list (plan.md "Dock region"). */
export type Panel = "commit" | "details";
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
  | { type: "toggleScope" };

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

export type SectionState = {
  panel: Panel;
  hidden: readonly Section[];
  bandRows: number;
  status: { text: boolean; toggle: boolean; cancel: boolean };
};

const ORDERS: Record<Panel, readonly Section[]> = {
  commit: ["header", "noticeHeading", "references", "historyList", "workingChanges", "staged", "comparison", "composer", "statusRegion"],
  details: ["header", "noticeHeading", "references", "historyList", "commitDetails", "statusRegion"],
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
