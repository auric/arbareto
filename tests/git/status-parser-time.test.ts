// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The T285 parser case that asserts a parse time. It runs in the serial step (T324).

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as LIMITS from "../../src/contracts/limits";
import { statusArgs } from "../../src/git-service/commands";
import { printOrigin } from "../origin";
import { FIXTURE_ROOT, ownedGit, useFixtureRoot } from "./fixture-root";
import { buildF02 } from "./fixtures";
import { describeGit } from "./git-binary";
import { parseChunks } from "./status-parse-chunks";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/git-service/commands.ts", import.meta.dir);
printOrigin("../../src/git-service/status-parser.ts", import.meta.dir);

const TASK = "T285";
const TIMEOUT_MS = 120_000;

useFixtureRoot();

describeGit("status parser (T285)", (git) => {
  describe("bounds (contract §5)", () => {
    // git-status(1) "Porcelain Format Version 2": each header starts with "# " and comes before the records. With `-z`, NUL ends each one.
    const headersOf = (label: "F02") => {
      const built = buildF02(git, "t285-f02");
      const listing = ownedGit(git, FIXTURE_ROOT, join(built.root, "repo"), statusArgs());
      let end = 0;
      while (end < listing.length && listing.subarray(end, end + 2).toString("latin1") === "# ") end = listing.indexOf(0, end) + 1;
      if (end === 0) throw new Error(`${label} status gave no header`);
      return Buffer.from(listing.subarray(0, end));
    };

    test(
      `one untracked path of 0xff bytes that fills ${LIMITS.STATUS_LISTING_BYTES} bytes parses complete in bounded time`,
      () => {
        const head = headersOf("F02");
        const listing = Buffer.alloc(LIMITS.STATUS_LISTING_BYTES, 0xff);
        head.copy(listing);
        listing.write("? ", head.length, "latin1");
        listing[listing.length - 1] = 0;
        const pathBytes = listing.length - head.length - 3;
        const start = performance.now();
        const result = parseChunks(listing, LIMITS.NATIVE_CHUNK_BYTES);
        const ms = performance.now() - start;
        console.log(`FACTS ${TASK} 0xff path of ${pathBytes} bytes: ${Math.round(ms)} ms`);
        expect(result.state).toBe("complete");
        if (result.state !== "complete") return;
        expect(result.records.length).toBe(1);
        const path = result.records[0]!.path;
        expect({ bytes: path.bytes.length, every: path.bytes.every((b) => b === 0xff), display: path.display === "\\xff".repeat(pathBytes) }).toEqual({ bytes: pathBytes, every: true, display: true });
        // ponytail: coarse guard, not a benchmark. The per-byte string build took 3.3 s to 15.8 s, the fix about 0.35 s. Use a timing harness for tighter limits.
        expect(ms).toBeLessThan(2000);
      },
      TIMEOUT_MS,
    );
  });
});
