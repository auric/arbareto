// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T178: `src/frontend/changes/hunk-mapping.ts` (contract §4, research.md R9). The comparisons come from `src/git-service/comparison.ts`.

import { describe, expect, test } from "bun:test";
import type { ComparisonHunk } from "../../src/contracts/envelope";
import { printOrigin } from "../origin";
import { buildF01, buildF02, buildF03, buildF04, buildF06, type Built } from "./fixtures";
import { useFixtureRoot } from "./fixture-root";
import { compare, gitPath, one, readOk, repoOf, TIMEOUT_MS, underTest, withService } from "./hunk-harness";
import { caseTest, type Capability } from "./service-harness";

printOrigin("../../src/frontend/changes/hunk-mapping.ts", import.meta.dir);
const { mapHunks } = await import("../../src/frontend/changes/hunk-mapping");

const TASK = "T178";
const SHELL: Capability[] = ["shell-double"];
const FAILED = { ok: false, code: "DISPLAY_MAPPING_FAILED" };

useFixtureRoot();

// The renderer decodes the base64 patch as strict UTF-8 (ComparisonView).
const decode = (base64: string) => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(base64, "base64"));

type Mapped = { patch: string; hunks: ComparisonHunk[] };

// Every supported comparison with hunks of every listed entry of one fixture.
async function supported(name: string, build: (git: string, name: string) => Built): Promise<Mapped[]> {
  const mapped: Mapped[] = [];
  await withService({ name }, async (service) => {
    const repo = repoOf(build(gitPath(), name));
    await underTest("comparison");
    const { repositoryId } = await service.register(repo);
    const read = await readOk(service, repositoryId);
    for (const entry of read.entries) {
      const c = await compare(service, repositoryId, entry.path, entry.category, read);
      const result = c.response.result as { support?: unknown; hunks?: ComparisonHunk[]; patch?: string } | undefined;
      if (c.response.state !== "succeeded" || result?.support !== "supported" || (result.hunks?.length ?? 0) === 0) continue;
      mapped.push({ patch: decode(one<string>(result, "patch")), hunks: result.hunks! });
    }
  });
  return mapped;
}

function expectMapped({ patch, hunks }: Mapped) {
  const mapping = mapHunks(patch, hunks);
  expect(mapping.ok).toBe(true);
  if (!mapping.ok) return;
  expect(mapping.hunkIds).toEqual(hunks.map((h) => h.hunkId));
  expect(mapping.file.hunks.map((h, ordinal) => ({ ordinal, oldStart: h.deletionStart, oldCount: h.deletionCount, newStart: h.additionStart, newCount: h.additionCount }))).toEqual(
    hunks.map((h) => ({ ordinal: h.ordinal, oldStart: h.oldStart, oldCount: h.oldCount, newStart: h.newStart, newCount: h.newCount })),
  );
}

describe("T178 supported comparisons map hunk by hunk", () => {
  const fixtures: [string, (git: string, name: string) => Built][] = [
    ["F01", (git, name) => buildF01(git, name, "unborn-added")],
    ["F02", (git, name) => buildF02(git, name)],
    ["F03", (git, name) => buildF03(git, name)],
    ["F04", (git, name) => buildF04(git, name, "autocrlf-false")],
    ["F06", (git, name) => buildF06(git, name)],
  ];
  for (const [id, build] of fixtures) {
    caseTest(
      TASK,
      `${id}: every Pierre hunk of a supported comparison maps to the service hunk with the same ordinal and ranges`,
      SHELL,
      async () => {
        const mapped = await supported(`t178-${id.toLowerCase()}`, build);
        expect(mapped.length).toBeGreaterThan(0);
        for (const m of mapped) expectMapped(m);
      },
      TIMEOUT_MS,
    );
  }

  caseTest(
    TASK,
    "F01 and F06: one-line hunks, whose headers omit the count, and empty-side ranges map",
    SHELL,
    async () => {
      const mapped = [...(await supported("t178-oneline-f01", (git, name) => buildF01(git, name, "unborn-added"))), ...(await supported("t178-oneline-f06", buildF06))];
      const hunks = mapped.flatMap((m) => m.hunks);
      // `@@ -0,0 +1 @@` and `@@ -1 +0,0 @@`: Git omits a count of 1.
      expect(mapped.some((m) => /^@@ -\d+ \+|^@@ -\d+,\d+ \+\d+ @@/m.test(m.patch))).toBe(true);
      expect(hunks.some((h) => h.oldCount === 1 || h.newCount === 1)).toBe(true);
      expect(hunks.some((h) => h.oldCount === 0)).toBe(true);
      expect(hunks.some((h) => h.newCount === 0)).toBe(true);
      for (const m of mapped) expectMapped(m);
    },
    TIMEOUT_MS,
  );
});

describe("T178 mismatches give DISPLAY_MAPPING_FAILED and no hunk ID", () => {
  // A canonical two-hunk text patch, as `src/git-service/comparison.ts` sends it.
  const PATCH = [
    "diff --git a/multi.txt b/multi.txt",
    "--- a/multi.txt",
    "+++ b/multi.txt",
    "@@ -1,3 +1,3 @@",
    "-line 1",
    "+line 1 changed",
    " line 2",
    " line 3",
    "@@ -9 +9,2 @@",
    " line 9",
    "+line 10 added",
    "",
  ].join("\n");
  const SECOND_FILE = ["diff --git a/other.txt b/other.txt", "--- a/other.txt", "+++ b/other.txt", "@@ -1 +1 @@", "-old", "+new", ""].join("\n");
  const hunk = (ordinal: number, oldStart: number, oldCount: number, newStart: number, newCount: number): ComparisonHunk =>
    ({ hunkId: crypto.randomUUID(), ordinal, oldStart, oldCount, newStart, newCount, digest: "0".repeat(64) }) as ComparisonHunk;
  const HUNKS = [hunk(0, 1, 3, 1, 3), hunk(1, 9, 1, 9, 2)];

  test("the control: the matching service hunks map", () => {
    expectMapped({ patch: PATCH, hunks: HUNKS });
  });

  const cases: [string, string, ComparisonHunk[]][] = [
    ["a missing service hunk", PATCH, HUNKS.slice(0, 1)],
    ["an extra service hunk", PATCH, [...HUNKS, hunk(2, 20, 1, 21, 1)]],
    ["an old start shifted by one line", PATCH, [HUNKS[0]!, { ...HUNKS[1]!, oldStart: 10 }]],
    ["a new start shifted by one line", PATCH, [{ ...HUNKS[0]!, newStart: 2 }, HUNKS[1]!]],
    ["a count shifted by one line", PATCH, [HUNKS[0]!, { ...HUNKS[1]!, newCount: 3 }]],
    ["a patch with two files", PATCH + SECOND_FILE, HUNKS],
    ["text without a patch", "This is not a patch.\n", []],
    ["text without a patch and service hunks", "This is not a patch.\n", HUNKS],
  ];
  for (const [name, patch, hunks] of cases) {
    test(name, () => {
      const mapping = mapHunks(patch, hunks);
      expect(mapping).toEqual(FAILED as never);
      expect("hunkIds" in mapping).toBe(false);
    });
  }
});
