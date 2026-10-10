// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Call this at the top level of a test file that needs a DOM. Then load React DOM and the module under test with `await import(...)`.
// React DOM reads the DOM at module evaluation, and a static import evaluates before this call.
// Without `--isolate`, test files share one global object. So the file removes its DOM in `afterAll`, and the other files run without a DOM.
export function registerDom(): void {
  GlobalRegistrator.register();
  // React 19 `act` warns unless this global is true.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  afterAll(async () => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    await GlobalRegistrator.unregister();
  });
}
