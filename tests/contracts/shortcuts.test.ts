// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import {
  bandFocusFallback,
  createShortcutHandler,
  nextSection,
  sectionOrder,
  type SectionState,
  type ShortcutAction,
  type ShortcutContext,
} from "../../src/frontend/keyboard/shortcuts";

printOrigin("../../src/frontend/keyboard/shortcuts.ts", import.meta.dir);

// Plain stand-ins for DOM nodes. The handler reads only these fields and the composed path.
type Node = { tagName: string; type?: string; isContentEditable?: boolean; value?: string; selectionStart?: number; selectionEnd?: number };
const body: Node = { tagName: "BODY" };
const button: Node = { tagName: "BUTTON", type: "button" };
const list: Node = { tagName: "DIV" };
const messageField: Node = { tagName: "TEXTAREA", value: "draft message", selectionStart: 5, selectionEnd: 5 };
const otherTextarea: Node = { tagName: "TEXTAREA", value: "" };
const textInput: Node = { tagName: "INPUT", type: "text", value: "" };
const contentEditable: Node = { tagName: "DIV", isContentEditable: true };
const comparisonPane: Node = { tagName: "SECTION" };
const toolbar: Node = { tagName: "DIV" };
const toolbarButton: Node = { tagName: "BUTTON", type: "button" };
const shadowHost: Node = { tagName: "DIFFS-CONTAINER" };
const shadowRoot: Node = { tagName: "#shadow-root" };
const shadowInput: Node = { tagName: "INPUT", type: "text", value: "" };
const shadowLine: Node = { tagName: "DIV" };
const dialog: Node = { tagName: "DIV" };
const dialogButton: Node = { tagName: "BUTTON", type: "button" };

const PATHS = {
  body: [body],
  button: [button, body],
  list: [list, body],
  message: [messageField, body],
  otherTextarea: [otherTextarea, body],
  textInput: [textInput, body],
  contentEditable: [contentEditable, body],
  shadowInput: [shadowInput, shadowRoot, shadowHost, body],
  comparison: [comparisonPane, body],
  comparisonToolbar: [toolbarButton, toolbar, comparisonPane, body],
  comparisonShadow: [shadowLine, shadowRoot, shadowHost, comparisonPane, body],
  dialog: [dialogButton, dialog, body],
} as const;

type KeyOptions = {
  key: string;
  code?: string;
  type?: "keydown" | "keyup";
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  altGraph?: boolean;
  repeat?: boolean;
  composing?: boolean;
  path?: readonly Node[];
};

type FakeEvent = ReturnType<typeof keyEvent>;
function keyEvent(options: KeyOptions) {
  const path = options.path ?? PATHS.body;
  // Shadow DOM retargets `target` to the host at document level; only `composedPath()[0]` names the inner node.
  const hostIndex = path.indexOf(shadowRoot);
  const event = {
    type: options.type ?? "keydown",
    key: options.key,
    code: options.code ?? "",
    ctrlKey: options.ctrl ?? false,
    shiftKey: options.shift ?? false,
    altKey: options.alt ?? false,
    metaKey: options.meta ?? false,
    repeat: options.repeat ?? false,
    isComposing: options.composing ?? false,
    target: hostIndex >= 0 ? path[hostIndex + 1] : path[0],
    composedPath: () => [...path],
    getModifierState: (name: string) => name === "AltGraph" && (options.altGraph ?? false),
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  return event;
}

const CONTEXT: ShortcutContext = { messageField, comparisonPane, modalOpen: false, menuOpen: false, reviewValid: true };

// One fresh handler per key, so lone-Alt state never leaks between cases.
const press = (options: KeyOptions, context: Partial<ShortcutContext> = {}): ShortcutAction | null =>
  createShortcutHandler()(keyEvent(options) as never, { ...CONTEXT, ...context });

const sequence = (events: readonly KeyOptions[], context: Partial<ShortcutContext> = {}): (ShortcutAction | null)[] => {
  const handle = createShortcutHandler();
  return events.map((options) => handle(keyEvent(options) as never, { ...CONTEXT, ...context }));
};

const loneAlt = (path: readonly Node[] = PATHS.body, extra: Partial<KeyOptions> = {}): KeyOptions[] => [
  { key: "Alt", code: "AltLeft", alt: true, path, ...extra },
  { key: "Alt", code: "AltLeft", type: "keyup", path, ...extra, alt: false },
];

const CTRL_1 = { key: "1", code: "Digit1", ctrl: true } as const;
const CTRL_2 = { key: "2", code: "Digit2", ctrl: true } as const;
const F5 = { key: "F5", code: "F5" } as const;
const F6 = { key: "F6", code: "F6" } as const;
const SHIFT_F6 = { key: "F6", code: "F6", shift: true } as const;
const F10 = { key: "F10", code: "F10" } as const;
const ALT_UP = { key: "ArrowUp", code: "ArrowUp", alt: true } as const;
const ALT_DOWN = { key: "ArrowDown", code: "ArrowDown", alt: true } as const;
const CTRL_ENTER = { key: "Enter", code: "Enter", ctrl: true } as const;

describe("global shortcuts", () => {
  test("Ctrl+1 selects Changes and Ctrl+2 selects History", () => {
    expect(press(CTRL_1)).toEqual({ type: "selectMode", mode: "changes" });
    expect(press(CTRL_2)).toEqual({ type: "selectMode", mode: "history" });
    expect(press({ ...CTRL_1, path: PATHS.list })).toEqual({ type: "selectMode", mode: "changes" });
  });

  test("modifiers match exactly: Ctrl+Shift+1, Ctrl+Alt+1, and Ctrl+Meta+1 do nothing", () => {
    expect(press({ ...CTRL_1, shift: true })).toBeNull();
    expect(press({ ...CTRL_1, key: "!", shift: true })).toBeNull();
    expect(press({ ...CTRL_1, alt: true })).toBeNull();
    expect(press({ ...CTRL_1, meta: true })).toBeNull();
    expect(press({ ...CTRL_2, shift: true, key: "@" })).toBeNull();
    expect(press({ key: "1", code: "Digit1" })).toBeNull();
  });

  test("a key during IME composition does nothing", () => {
    for (const options of [CTRL_1, CTRL_2, F5, F6, SHIFT_F6, F10]) expect(press({ ...options, composing: true })).toBeNull();
    expect(press({ ...ALT_UP, composing: true, path: PATHS.comparison })).toBeNull();
  });

  test("a key with the AltGraph modifier state does nothing", () => {
    expect(press({ ...CTRL_1, altGraph: true })).toBeNull();
    expect(press({ ...CTRL_2, altGraph: true })).toBeNull();
    expect(press({ ...ALT_DOWN, altGraph: true, path: PATHS.comparison })).toBeNull();
  });

  test("Ctrl+1 in an editable target or in a text input inside a shadow root does nothing", () => {
    for (const path of [PATHS.message, PATHS.otherTextarea, PATHS.textInput, PATHS.contentEditable, PATHS.shadowInput]) {
      expect(press({ ...CTRL_1, path })).toBeNull();
      expect(press({ ...CTRL_2, path })).toBeNull();
    }
  });

  test("F5 gives one bounded refresh request and never a page reload", () => {
    expect(press(F5)).toEqual({ type: "refresh" });
    expect(press({ ...F5, ctrl: true })).toBeNull();
    expect(press({ ...F5, shift: true })).toBeNull();
    expect(press({ ...F5, type: "keyup" })).toBeNull();
  });

  test("a key event with repeat true activates nothing", () => {
    for (const options of [CTRL_1, CTRL_2, F5, F6, SHIFT_F6, F10]) expect(press({ ...options, repeat: true })).toBeNull();
    expect(press({ ...ALT_UP, repeat: true, path: PATHS.comparison })).toBeNull();
    expect(press({ ...CTRL_ENTER, repeat: true, path: PATHS.message })).toBeNull();
  });

  test("no single-letter key and no Space maps to an action", () => {
    const letters = [..."abcdefghijklmnopqrstuvwxyz"];
    for (const path of [PATHS.body, PATHS.list, PATHS.button, PATHS.comparison]) {
      for (const letter of letters) {
        const code = `Key${letter.toUpperCase()}`;
        expect(press({ key: letter, code, path })).toBeNull();
        expect(press({ key: letter.toUpperCase(), code, shift: true, path })).toBeNull();
      }
      expect(press({ key: " ", code: "Space", path })).toBeNull();
    }
  });

  test("F6 gives the next section and Shift+F6 the previous one", () => {
    expect(press(F6)).toEqual({ type: "focusSection", direction: "next" });
    expect(press(SHIFT_F6)).toEqual({ type: "focusSection", direction: "previous" });
    expect(press({ ...F6, ctrl: true })).toBeNull();
  });

  test("F10 and a lone Alt press and release give focus menu bar", () => {
    expect(press(F10)).toEqual({ type: "focusMenuBar" });
    expect(sequence(loneAlt())).toEqual([null, { type: "focusMenuBar" }]);
  });

  test("Alt with the AltGraph state, or Alt with another key between, gives nothing", () => {
    expect(sequence(loneAlt(PATHS.body, { altGraph: true }))).toEqual([null, null]);
    const [down, up] = loneAlt();
    expect(sequence([down, { key: "x", code: "KeyX", alt: true }, up])).toEqual([null, null, null]);
    expect(sequence([down, { ...ALT_DOWN }, up])).toEqual([null, null, null]);
    expect(press({ ...F10, shift: true })).toBeNull();
  });

  test("Alt+Up and Alt+Down give previous and next hunk anywhere in the comparison pane", () => {
    for (const path of [PATHS.comparison, PATHS.comparisonToolbar, PATHS.comparisonShadow]) {
      expect(press({ ...ALT_UP, path })).toEqual({ type: "selectHunk", direction: "previous" });
      expect(press({ ...ALT_DOWN, path })).toEqual({ type: "selectHunk", direction: "next" });
    }
    expect(press({ ...ALT_UP, path: PATHS.list })).toBeNull();
    expect(press({ ...ALT_DOWN, path: PATHS.body })).toBeNull();
    expect(press({ ...ALT_DOWN, ctrl: true, path: PATHS.comparison })).toBeNull();
  });

  test("events that give nothing are never default-prevented", () => {
    const handle = createShortcutHandler();
    for (const options of [
      { key: "Tab", code: "Tab" },
      { key: "Enter", code: "Enter" },
      { key: " ", code: "Space" },
      { key: "a", code: "KeyA" },
      { ...CTRL_1, shift: true },
    ]) {
      const event = keyEvent(options);
      expect(handle(event as never, CONTEXT)).toBeNull();
      expect(event.defaultPrevented).toBe(false);
    }
  });
});

describe("commit message field (plan.md Message row)", () => {
  const inMessage = (options: KeyOptions, context: Partial<ShortcutContext> = {}) => press({ ...options, path: PATHS.message }, context);

  test("F6 gives the next section, and Shift+F6 the previous one", () => {
    expect(inMessage(F6)).toEqual({ type: "focusSection", direction: "next" });
    expect(inMessage(SHIFT_F6)).toEqual({ type: "focusSection", direction: "previous" });
  });

  test("F10 gives focus menu bar", () => {
    expect(inMessage(F10)).toEqual({ type: "focusMenuBar" });
  });

  test("a lone Alt press and release gives focus menu bar", () => {
    expect(sequence(loneAlt(PATHS.message))).toEqual([null, { type: "focusMenuBar" }]);
  });

  test("F5 gives one refresh request and leaves the draft and caret unchanged", () => {
    const before = { ...messageField };
    const handle = createShortcutHandler();
    const event = keyEvent({ ...F5, path: PATHS.message });
    expect(handle(event as never, CONTEXT)).toEqual({ type: "refresh" });
    expect(messageField).toEqual(before);
  });

  test("Tab gives nothing, so the native behavior runs", () => {
    const event = keyEvent({ key: "Tab", code: "Tab", path: PATHS.message });
    expect(createShortcutHandler()(event as never, CONTEXT)).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  test("Shift+Tab gives nothing, so the native behavior runs", () => {
    const event = keyEvent({ key: "Tab", code: "Tab", shift: true, path: PATHS.message });
    expect(createShortcutHandler()(event as never, CONTEXT)).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  test("Enter gives nothing, so the native newline runs", () => {
    const event = keyEvent({ key: "Enter", code: "Enter", path: PATHS.message });
    expect(createShortcutHandler()(event as never, CONTEXT)).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  test("Shift+F10 gives nothing, so the built-in text menu opens", () => {
    const event = keyEvent({ key: "F10", code: "F10", shift: true, path: PATHS.message });
    expect(createShortcutHandler()(event as never, CONTEXT)).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  test("Ctrl+1 gives nothing", () => {
    expect(inMessage(CTRL_1)).toBeNull();
  });

  test("Ctrl+2 gives nothing", () => {
    expect(inMessage(CTRL_2)).toBeNull();
  });

  test("Alt+Up gives nothing", () => {
    expect(inMessage(ALT_UP)).toBeNull();
  });

  test("Alt+Down gives nothing", () => {
    expect(inMessage(ALT_DOWN)).toBeNull();
  });

  test("with isComposing true, each key of the row gives nothing", () => {
    for (const options of [F6, SHIFT_F6, F10, F5, CTRL_ENTER, CTRL_1, CTRL_2, ALT_UP, ALT_DOWN, { key: "Tab", code: "Tab" }, { key: "Enter", code: "Enter" }]) {
      expect(inMessage({ ...options, composing: true })).toBeNull();
    }
    expect(sequence(loneAlt(PATHS.message, { composing: true }))).toEqual([null, null]);
  });

  test("Ctrl+Enter opens Review commit only when the review is valid, and never commits", () => {
    expect(inMessage(CTRL_ENTER, { reviewValid: true })).toEqual({ type: "openReview" });
    expect(inMessage(CTRL_ENTER, { reviewValid: false })).toBeNull();
    expect(inMessage({ ...CTRL_ENTER, shift: true })).toBeNull();
  });

  test("in another editable target, Ctrl+Enter and every other action shortcut do nothing", () => {
    for (const path of [PATHS.otherTextarea, PATHS.textInput, PATHS.contentEditable, PATHS.shadowInput]) {
      for (const options of [CTRL_ENTER, CTRL_1, CTRL_2, ALT_UP, ALT_DOWN]) expect(press({ ...options, path })).toBeNull();
    }
    expect(press({ ...CTRL_ENTER, path: PATHS.body })).toBeNull();
    expect(press({ ...CTRL_ENTER, path: PATHS.list })).toBeNull();
  });
});

describe("modal state (plan.md Keyboard and focus)", () => {
  for (const [name, context] of [
    ["a modal dialog", { modalOpen: true }],
    ["a menu", { menuOpen: true }],
  ] as const) {
    test(`with ${name} open, F5, Ctrl+1, Ctrl+2, F6, Shift+F6, Alt+Up, and Alt+Down give nothing`, () => {
      for (const options of [F5, CTRL_1, CTRL_2, F6, SHIFT_F6]) {
        expect(press(options, context)).toBeNull();
        expect(press({ ...options, path: PATHS.dialog }, context)).toBeNull();
      }
      expect(press({ ...ALT_UP, path: PATHS.comparison }, context)).toBeNull();
      expect(press({ ...ALT_DOWN, path: PATHS.comparisonToolbar }, context)).toBeNull();
    });
  }

  test("Ctrl+Enter inside the review dialog gives nothing", () => {
    expect(press({ ...CTRL_ENTER, path: PATHS.dialog }, { modalOpen: true, reviewValid: true })).toBeNull();
  });
});

const CHANGES_ORDER = ["header", "modeTabs", "noticeHeading", "workingChanges", "staged", "comparison", "composer", "statusRegion"];
const HISTORY_ORDER = ["header", "modeTabs", "noticeHeading", "historyList", "inspector", "statusRegion"];

const state = (fields: Partial<SectionState> = {}): SectionState => ({
  mode: "changes",
  hidden: [],
  bandRows: 1,
  status: { text: true, toggle: false, cancel: false },
  ...fields,
});

const walk = (s: SectionState, direction: "next" | "previous", from: string, steps: number): string[] => {
  const seen: string[] = [];
  let current = from;
  for (let i = 0; i < steps; i++) {
    current = nextSection(s, current as never, direction) as string;
    seen.push(current);
  }
  return seen;
};

describe("F6 section order", () => {
  test("the Changes and History orders follow plan.md", () => {
    expect<string[]>([...sectionOrder("changes")]).toEqual(CHANGES_ORDER);
    expect<string[]>([...sectionOrder("history")]).toEqual(HISTORY_ORDER);
  });

  test("F6 walks the order and wraps; Shift+F6 reverses it", () => {
    expect(walk(state(), "next", "header", 8)).toEqual([...CHANGES_ORDER.slice(1), "header"]);
    expect(walk(state(), "previous", "header", 8)).toEqual([...CHANGES_ORDER].reverse());
    expect(walk(state({ mode: "history" }), "next", "header", 6)).toEqual([...HISTORY_ORDER.slice(1), "header"]);
    expect(walk(state({ mode: "history" }), "previous", "header", 6)).toEqual([...HISTORY_ORDER].reverse());
  });

  test("the band stop targets the band heading, and a band without rows is skipped", () => {
    expect(nextSection(state(), "modeTabs", "next")).toBe("noticeHeading");
    expect(nextSection(state({ bandRows: 0 }), "modeTabs", "next")).toBe("workingChanges");
    expect(nextSection(state({ bandRows: 0 }), "workingChanges", "previous")).toBe("modeTabs");
    expect(nextSection(state({ mode: "history", bandRows: 0 }), "modeTabs", "next")).toBe("historyList");
  });

  test("hidden sections are skipped", () => {
    expect(nextSection(state({ hidden: ["staged"] }), "workingChanges", "next")).toBe("comparison");
    expect(nextSection(state({ hidden: ["composer"] }), "comparison", "next")).toBe("statusRegion");
    expect(nextSection(state({ hidden: ["staged", "comparison"] }), "composer", "previous")).toBe("workingChanges");
  });

  test("a status region without text, toggle, and Cancel is skipped", () => {
    const empty = { text: false, toggle: false, cancel: false };
    expect(nextSection(state({ status: empty }), "composer", "next")).toBe("header");
    expect(nextSection(state({ status: empty }), "header", "previous")).toBe("composer");
    expect(nextSection(state({ mode: "history", status: empty }), "inspector", "next")).toBe("header");
    for (const status of [
      { text: true, toggle: false, cancel: false },
      { text: false, toggle: true, cancel: false },
      { text: false, toggle: false, cancel: true },
    ]) {
      expect(nextSection(state({ status }), "composer", "next")).toBe("statusRegion");
    }
  });
});

describe("band focus fallback", () => {
  test("a disappearing band control falls back to the band heading while the band keeps a row", () => {
    expect(bandFocusFallback(state({ bandRows: 1 }))).toBe("noticeHeading");
    expect(bandFocusFallback(state({ mode: "history", bandRows: 2 }))).toBe("noticeHeading");
  });

  test("without band rows, it falls back to the next F6 stop", () => {
    expect(bandFocusFallback(state({ bandRows: 0 }))).toBe("workingChanges");
    expect(bandFocusFallback(state({ bandRows: 0, hidden: ["workingChanges"] }))).toBe("staged");
    expect(bandFocusFallback(state({ mode: "history", bandRows: 0 }))).toBe("historyList");
  });
});
