// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, beforeEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import * as React from "react";

// React 19.3.0 react.development.js: `act` sets `actQueue` to an array and sets it back to null when its outermost scope ends.
const REACT_INTERNALS = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: { actQueue?: unknown } }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

// Base UI picks React.useLayoutEffect or a no-op once, when this module evaluates (`typeof document`). Every later file reuses that choice.
const ISO_LAYOUT_EFFECT = Bun.resolveSync("@base-ui/utils/useIsoLayoutEffect", import.meta.dir);

/** The short inspect form of a DOM node: tag, role, aria-label, id, and the first 60 characters of text. */
function shortNode(this: Node): string {
  const text = JSON.stringify((this.textContent ?? "").slice(0, 60));
  if (this.nodeType !== 1) return `<${this.nodeName} text=${text}>`;
  const element = this as Element;
  const attr = (name: string) => (element.hasAttribute(name) ? ` ${name}=${JSON.stringify(element.getAttribute(name))}` : "");
  return `<${element.tagName}${attr("role")}${attr("aria-label")}${attr("id")} text=${text}>`;
}

// Call this at the top level of a test file that needs a DOM. Then load React DOM and the module under test with `await import(...)`.
// React DOM reads the DOM at module evaluation, and a static import evaluates before this call.
// Without `--isolate`, test files share one global object. So the file removes its DOM in `afterAll`, and the other files run without a DOM.
export function registerDom(): void {
  GlobalRegistrator.register();
  // Bun lists each evaluated ES module in `require.cache`. A module that is not there yet evaluates later, with this DOM.
  const loaded = require.cache[ISO_LAYOUT_EFFECT]?.exports as { useIsoLayoutEffect?: unknown } | undefined;
  if (loaded !== undefined && loaded.useIsoLayoutEffect !== React.useLayoutEffect) {
    throw new Error(
      "Base UI evaluated without a DOM, so its layout effects are no-ops for every later test file. A test file imported a module that loads Base UI before registerDom(), or without it. Call registerDom() first, then load React DOM and Base UI modules with `await import(...)`.",
    );
  }
  // Bun 1.4.4 prints a failed matcher operand through this hook. Without it, Bun walks the whole happy-dom and React graph, which takes minutes and can lose the failure.
  Object.defineProperty(Node.prototype, Symbol.for("nodejs.util.inspect.custom"), { configurable: true, value: shortNode });
  // React 19 `act` warns unless this global is true.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The production build of React has no `actQueue` field and no `act`.
  if (REACT_INTERNALS === undefined || !("actQueue" in REACT_INTERNALS)) throw new Error("React exposes no act queue. The DOM tests need the development build of React 19.");
  // Bun does not stop the body of a timed-out case. A pending `act` scope breaks the later cases, so they must not run.
  beforeEach(() => {
    if (REACT_INTERNALS.actQueue !== null) throw new Error("React act queue still pending: a previous case timed out and its body still runs, or it did not await an act() call");
  });
  afterAll(async () => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    await GlobalRegistrator.unregister();
  });
}
