// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The repository is public. Tracked text must not name a private local path (`scripts/private-paths.ts`).

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { privatePathHits as lineHits } from "../../scripts/private-paths";
import { printOrigin } from "../origin";

printOrigin("../../scripts/private-paths.ts", import.meta.dir);

const ROOT = join(import.meta.dir, "..", "..");

// CONTRIBUTING.md "Claude Code helper skills" and NOTICE.md list these upstream copies. The project does not edit upstream text.
const VENDORED =
  /^(?:third-party-licenses\/|\.claude\/skills\/(?:animate|animation-vocabulary|find-animation-opportunities|review-animations|frontend-design|shadcn|vercel-react-best-practices|web-design-guidelines|speckit-[^/]+)\/|\.claude\/skills\/ponytail-review\/(?:SKILL\.md|LICENSE)$)/;
// Git's binary rule: a NUL byte in the first 8000 bytes (xdiff-interface.c `FIRST_FEW_BYTES`).
const BINARY_PROBE_BYTES = 8000;

function trackedFiles(): string[] {
  const child = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return child.stdout.toString().split("\0").filter((file) => file !== "");
}

function readTracked(file: string): Buffer | undefined {
  try {
    return readFileSync(join(ROOT, file));
  } catch (error) {
    // A tracked file that the working tree deleted holds no text to publish.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// The scan reads every tracked file; under a full parallel run it can pass the 5 s default.
test("no tracked text file names a private local path", () => {
  console.log(`ORIGIN ${ROOT}`);
  const hits: string[] = [];
  let scanned = 0;
  for (const file of trackedFiles()) {
    if (VENDORED.test(file)) continue;
    const bytes = readTracked(file);
    if (bytes === undefined || bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) continue;
    scanned += 1;
    bytes.toString("utf8").split("\n").forEach((line, index) => {
      for (const reason of lineHits(line)) hits.push(`${file}:${index + 1}: ${reason}`);
    });
  }
  console.log(hits.map((hit) => `SCAN_HIT ${hit}`).join("\n"));
  expect(scanned).toBeGreaterThan(0);
  expect(hits).toEqual([]);
}, 60_000);

// Joined at run time, so the tree scan and the pre-push hook find no private path in this source.
const path = (separator: string, ...parts: string[]) => parts.join(separator);

// Control fixtures: each line must give a hit.
test.each([
  path("\\", "C:", "Users", "jdoe", "repo"),
  path("/", "c:", "users", "Jane Doe", "repo"),
  `"${path("\\\\", "C:", "Users", "jdoe", ".gitconfig")}"`,
  path("/", "D:", "Users", "U2", "x"),
  path("/", "", "home", "jdoe", "repo"),
  path("/", "", "", "wsl.localhost", "Ubuntu", "home", "jdoe", "repo"),
  path("/", "", "home", "user-c5156947", "repo"),
  path("\\", "C:", "Users", "u", "AppData", "Local", "Temp", "claude", "C--x", "scratchpad", "a.txt"),
  path("/", "C:", "Users", "u", "AppData", "Local", "Temp", "arbareto-fixtures-a7cb5252", "t030-f18", "repo"),
  path("/", "", "tmp", "Temp", "arbareto-fixtures-1", "x"),
])("the scan finds a private path in %s", (line) => {
  expect(lineHits(line)).not.toEqual([]);
});

// Control fixtures: synthetic names, dot segments, and placeholders give no hit.
test.each([
  "C:\\Users\\u\\r",
  "file:C:/Users/a/.gitconfig",
  "file:C:/Users/ME/.gitconfig",
  "C:\\Users\\",
  "/home/u/repo",
  "/home/dev/repo/.git/hooks/pre-commit",
  "/home/user/arbareto",
  "/home/./wt",
  "/home/../wt",
  "${w.folder}/home/.config/git/ignore",
  "/home/<user>/repo",
  "<fixture>/t030-f18/repo/.git/info/exclude",
  "local scratch (verify-004)",
])("the scan permits %s", (line) => {
  expect(lineHits(line)).toEqual([]);
});
