// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import type { BridgeResponse } from "../../src/frontend/bridge";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";

printOrigin("../../src/frontend/layout/text-scale.ts", import.meta.dir);
registerDom();
const { createTextScale, textHeight } = await import("../../src/frontend/layout/text-scale");

// plan.md "Windows text size" and contract §2 `text-scale`, §3 `currentSession`.
// The double stands for `createBridge(onSessionChange, onTextScale)`: it holds the event handler and one `currentSession` call.
function bridgeDouble(answer: BridgeResponse) {
  let resolve: (response: BridgeResponse) => void = () => {};
  let handler: (value: unknown) => void = () => {};
  const calls: string[] = [];
  return {
    calls,
    bridge: {
      create: (onTextScale: (value: unknown) => void) => {
        calls.push("createBridge");
        handler = onTextScale;
      },
      currentSession: () => {
        calls.push("currentSession");
        return new Promise<BridgeResponse>((r) => (resolve = r));
      },
    },
    answer: async (response: BridgeResponse = answer) => {
      resolve(response);
      await Promise.resolve();
      await Promise.resolve();
    },
    emit: (value: unknown) => handler(value),
  };
}

const session = (textScale: unknown): BridgeResponse => ({ requestId: crypto.randomUUID(), state: "succeeded", result: { sessionId: crypto.randomUUID(), textScale } });
const unavailable = (textScale: unknown): BridgeResponse => ({ requestId: crypto.randomUUID(), state: "rejected", code: "SERVICE_UNAVAILABLE", result: { textScale } });

function freshRoot() {
  const root = document.createElement("div");
  document.body.append(root);
  return root;
}
// The main.tsx order: the bridge subscribes first, then the page reads `currentSession`.
function connectTextScale(bridge: ReturnType<typeof bridgeDouble>["bridge"], root: HTMLElement) {
  const scale = createTextScale(root);
  bridge.create(scale.event);
  void bridge.currentSession().then(scale.session);
  return scale;
}
const cssScale = (root: HTMLElement) => root.style.getPropertyValue("--text-scale");

describe("text scale factor", () => {
  test("the factor is 1 before any value arrives", () => {
    const double = bridgeDouble(session(1.5));
    const root = freshRoot();
    const scale = connectTextScale(double.bridge, root);
    expect(double.calls).toEqual(["createBridge", "currentSession"]);
    expect(scale.current()).toBe(1);
  });

  for (const [name, response] of [
    ["succeeded", session(1.5)],
    ["SERVICE_UNAVAILABLE", unavailable(1.5)],
  ] as const) {
    test(`the textScale of a ${name} currentSession result sets --text-scale`, async () => {
      const double = bridgeDouble(response);
      const root = freshRoot();
      const scale = connectTextScale(double.bridge, root);
      await double.answer();
      expect(cssScale(root)).toBe("1.5");
      expect(scale.current()).toBe(1.5);
    });
  }

  test("each text-scale event replaces the factor and notifies the subscribers", async () => {
    const double = bridgeDouble(session(1.25));
    const root = freshRoot();
    const scale = connectTextScale(double.bridge, root);
    await double.answer();
    let notified = 0;
    scale.subscribe(() => notified++);
    double.emit(2);
    expect(cssScale(root)).toBe("2");
    double.emit(2.25);
    expect(cssScale(root)).toBe("2.25");
    expect(scale.current()).toBe(2.25);
    expect(notified).toBe(2);
  });

  test("a currentSession result after an event never replaces the event value", async () => {
    const double = bridgeDouble(session(1.25));
    const root = freshRoot();
    const scale = connectTextScale(double.bridge, root);
    double.emit(1.75);
    await double.answer();
    expect(scale.current()).toBe(1.75);
    expect(cssScale(root)).toBe("1.75");
  });

  const INVALID: unknown[] = [0.99, 2.2501, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1.5", null, undefined, {}];
  for (const value of INVALID) {
    test(`the value ${String(value)} gives 1 from currentSession and from an event`, async () => {
      const double = bridgeDouble(session(value));
      const root = freshRoot();
      const scale = connectTextScale(double.bridge, root);
      await double.answer();
      expect(scale.current()).toBe(1);
      expect(cssScale(root)).toBe("1");
      double.emit(2);
      double.emit(value);
      expect(scale.current()).toBe(1);
      expect(cssScale(root)).toBe("1");
    });
  }

  test("a currentSession response without a result gives 1", async () => {
    const double = bridgeDouble(session(2));
    const root = freshRoot();
    const scale = connectTextScale(double.bridge, root);
    await double.answer({ requestId: null, state: "rejected", code: "SERVICE_UNAVAILABLE" });
    expect(scale.current()).toBe(1);
    expect(cssScale(root)).toBe("1");
  });

  test("the range ends 1 and 2.25 are kept", async () => {
    const double = bridgeDouble(session(1));
    const root = freshRoot();
    const scale = connectTextScale(double.bridge, root);
    await double.answer();
    expect(scale.current()).toBe(1);
    double.emit(2.25);
    expect(scale.current()).toBe(2.25);
  });
});

describe("text-holding height", () => {
  test("a compact row is 26 at 1, 35 at 1.5, and 48.5 at 2.25", () => {
    expect(textHeight("compact", 26, 1)).toBe(26);
    expect(textHeight("compact", 26, 1.5)).toBe(35);
    expect(textHeight("compact", 26, 2.25)).toBe(48.5);
  });

  test("a comfortable row grows by the 20 DIP line height", () => {
    expect(textHeight("comfortable", 34, 1)).toBe(34);
    expect(textHeight("comfortable", 34, 1.5)).toBe(44);
    expect(textHeight("comfortable", 34, 2.25)).toBe(59);
  });
});

describe("message editor", () => {
  test("a factor change keeps the editor node, the draft, and its caret", async () => {
    const double = bridgeDouble(session(1));
    const root = freshRoot();
    const editor = document.createElement("textarea");
    root.append(editor);
    editor.value = "Fix the parser\n\nDetails";
    editor.focus();
    editor.setSelectionRange(4, 10);
    connectTextScale(double.bridge, root);
    await double.answer();
    double.emit(2.25);
    expect(root.querySelector("textarea")).toBe(editor);
    expect(editor.isConnected).toBe(true);
    expect(editor.value).toBe("Fix the parser\n\nDetails");
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([4, 10]);
    expect(document.activeElement).toBe(editor);
  });
});
