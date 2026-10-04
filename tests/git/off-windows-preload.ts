// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The preload of the `portable-imports.test.ts` child run. It reports Linux, and each `dlopen` call throws.

import { mock } from "bun:test";
import * as ffi from "bun:ffi";

mock.module("bun:ffi", () => ({
  ...ffi,
  dlopen: () => {
    throw new Error("dlopen called off Windows");
  },
}));
Object.defineProperty(process, "platform", { value: "linux" });

for (const module of ["./fixture-root", "./git-oracle", "./bun-runner", "./fixtures", "./service-harness"]) await import(module);
console.log("PORTABLE_IMPORTS loaded");
