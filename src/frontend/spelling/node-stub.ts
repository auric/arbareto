// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The renderer build maps `fs/promises` and `module` to this file. `hunspell-wasm` 0.3.0 imports them only on Node code paths.
const fail = (name: string) => () => {
  throw new Error(`${name} is a Node API. The renderer has no Node runtime.`);
};

export const readFile = fail("fs/promises readFile");
export const createRequire = fail("module createRequire");
