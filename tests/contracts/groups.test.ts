// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { checkGroups } from "../groups";

// T324: `bun tests/run.ts` runs only the files of `tests/groups.json`. A file in no group never runs, so every contract run checks the groups.

printOrigin("../groups.ts", import.meta.dir);

test("each discovered test file is in exactly one group, and each entry names a discovered file", () => {
  expect(checkGroups().problems).toEqual([]);
});
