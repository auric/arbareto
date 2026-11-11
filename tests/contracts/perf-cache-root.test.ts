// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// `ARBARETO_PERF_CACHE` moves the persistent fixture cache out of the temporary directory, which Windows clean-up empties.

import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { perfCacheRoot } from "../windows/perf-fixtures";

printOrigin("../windows/perf-fixtures.ts", import.meta.dir);

test("ARBARETO_PERF_CACHE: a value that is not absolute is refused, and an absolute folder is the cache root", () => {
  for (const value of ["", "cache", "./cache", "C:cache"]) expect(() => perfCacheRoot(value)).toThrow("set ARBARETO_PERF_CACHE to an absolute folder");
  expect(perfCacheRoot(import.meta.dir)).toBe(realpathSync.native(import.meta.dir));
  expect(perfCacheRoot(undefined)).toBe(join(realpathSync.native(tmpdir()), "arbareto-perf-fixtures"));
});
