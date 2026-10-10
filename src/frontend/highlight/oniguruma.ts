// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// vite.config.ts aliases `shiki/engine/oniguruma` to this module. Its exports equal the names Pierre imports (tests/contracts/highlight.test.ts).

import { OnigurumaUnavailableError } from "./unavailable";

export function createOnigurumaEngine(_wasm?: unknown): never {
  throw new OnigurumaUnavailableError();
}
