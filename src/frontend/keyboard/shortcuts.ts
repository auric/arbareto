// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// plan.md "Keyboard and focus". No action commits, and no single-letter key or Space maps to an action.

export type Mode = "changes" | "history";
export type Section = "header" | "modeTabs" | "noticeHeading" | "workingChanges" | "staged" | "comparison" | "composer" | "statusRegion" | "historyList" | "inspector";

export type ShortcutAction =
  | { type: "selectMode"; mode: Mode }
  | { type: "refresh" }
  | { type: "focusSection"; direction: "next" | "previous" }
  | { type: "focusMenuBar" }
  | { type: "selectHunk"; direction: "next" | "previous" }
  | { type: "openReview" };

export type ShortcutContext = {
  messageField: object | null;
  comparisonPane: object | null;
  modalOpen: boolean;
  menuOpen: boolean;
  reviewValid: boolean;
};

export type ShortcutEvent = Pick<KeyboardEvent, "type" | "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "repeat" | "isComposing" | "getModifierState" | "preventDefault"> & {
  composedPath(): readonly unknown[];
};

type Target = { tagName?: string; type?: string; isContentEditable?: boolean };

// HTML input types that take no typed text.
const NON_TEXT_INPUTS = new Set(["button", "submit", "reset", "checkbox", "radio", "image", "file", "color", "range", "hidden"]);

function isEditable(target: Target | undefined): boolean {
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
    if (e.key === "Enter" && m === CTRL) return inMessage && context.reviewValid ? { type: "openReview" } : null;
    if (editable) return null;
    // `code` keeps the physical digit key on every layout (UI Events KeyboardEvent code).
    if (m === CTRL && e.code === "Digit1") return { type: "selectMode", mode: "changes" };
    if (m === CTRL && e.code === "Digit2") return { type: "selectMode", mode: "history" };
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
  mode: Mode;
  hidden: readonly Section[];
  bandRows: number;
  status: { text: boolean; toggle: boolean; cancel: boolean };
};

const ORDERS: Record<Mode, readonly Section[]> = {
  changes: ["header", "modeTabs", "noticeHeading", "workingChanges", "staged", "comparison", "composer", "statusRegion"],
  history: ["header", "modeTabs", "noticeHeading", "historyList", "inspector", "statusRegion"],
};

/** The F6 order. It is the same in every profile. */
export function sectionOrder(mode: Mode): readonly Section[] {
  return ORDERS[mode];
}

function isStop(state: SectionState, section: Section): boolean {
  if (state.hidden.includes(section)) return false;
  if (section === "noticeHeading") return state.bandRows > 0;
  if (section === "statusRegion") return state.status.text || state.status.toggle || state.status.cancel;
  return true;
}

/** The next visible F6 stop after `current`, with wrap. Null when no section is a stop. */
export function nextSection(state: SectionState, current: Section, direction: "next" | "previous"): Section | null {
  const order = sectionOrder(state.mode);
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
