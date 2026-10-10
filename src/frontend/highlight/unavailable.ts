// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

/** The build ships no Oniguruma WASM (research.md R9). Pierre reaches this only for `preferredHighlighter: "shiki-wasm"`. */
export class OnigurumaUnavailableError extends Error {
  override name = "OnigurumaUnavailableError";
  constructor() {
    super("The Oniguruma engine is not in this build. Use the JavaScript engine.");
  }
}
