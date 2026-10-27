// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Only the default worker factory of engine.ts imports this module. Under Bun the import fails at link time, so no worker code runs in a test.
export { default } from "./spell-worker?worker&url";
