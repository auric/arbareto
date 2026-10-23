// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The child file of the early-hook test in installed-app.test.ts. Its test times out on purpose, so the name holds no `.test`.
// Run as `bun test ./tests/windows/early-hook-fixture.ts` with ARBARETO_EARLY_HOOK set to `<records>|<ready file>`.

import { afterAll, describe, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fixtureDir, useFixtureRoot } from "../git/fixture-root";
import { spawnOwned, type OwnedProcess } from "./installed-app";

const BODY_TIMEOUT_MS = 5_000;
const READY_MS = 4_000;

describe("early hook", () => {
  // Bun 1.4.4 runs `afterAll` hooks in declaration order, also when a test timeout leaves its body running. This hook must come before the fixture root removal.
  let owned: OwnedProcess | undefined;
  afterAll(() => owned?.stop());
  useFixtureRoot();

  test(
    "the body outlives its timeout",
    async () => {
      const [records, ready] = process.env.ARBARETO_EARLY_HOOK!.split("|");
      // At the timeout, Bun ends the spawned root only. The `cmd.exe` root leaves a Bun child, as the app leaves its WebView2 children.
      // The child holds its working folder in the fixture root, so the root removal fails while it runs.
      const argv = [process.env.ComSpec!, "/d", "/c", process.execPath, join(import.meta.dir, "..", "git", "win32.ts"), records!, "60000", ready!];
      owned = spawnOwned(argv, fixtureDir("tree"), process.env as Record<string, string>);
      for (const until = performance.now() + READY_MS; !existsSync(ready!) && performance.now() < until; ) await Bun.sleep(10);
      await Bun.sleep(60_000);
    },
    BODY_TIMEOUT_MS,
  );
});
