// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// vite.config.ts aliases `shiki/wasm` to this module, so the Oniguruma WASM never enters the build. createOnigurumaEngine refuses before it reads this value.
export default undefined;
