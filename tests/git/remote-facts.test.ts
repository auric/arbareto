// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T005: the Git facts (a) to (m) of plan.md P0.2 with the Git under test. Each fact prints `OBSERVATION T005` lines. A `match=false` line is a finding for research.md, not a failure.

import { expect, test } from "bun:test";
import { describeGit } from "./git-binary";
import { useFixtureRoot } from "./fixture-root";
import { FACTS, gitVersion, observationLine } from "./remote-facts";
import { nativeHost, type GitHost } from "./remote-fixtures";

useFixtureRoot();

const TASK = "T005";
// Plan P0.2 names Windows Git 2.56 and requires no exact build. Other hosts record the version only.
const EXPECTED_VERSION = process.platform === "win32" ? "2.56.x" : "record";
const FACT_MS = 600_000;

describeGit("Git facts for remote sync (T005)", (git) => {
  let host: GitHost;
  const h = () => (host ??= nativeHost(git, "facts"));

  test("Git version", () => {
    const version = gitVersion(h());
    const match = EXPECTED_VERSION === "record" || version.startsWith("2.56.");
    console.log(observationLine(TASK, version, { fact: "version", expected: EXPECTED_VERSION, observed: version, match }));
  });

  for (const fact of FACTS) {
    test(`(${fact.id}) ${fact.title}`, () => {
      const version = gitVersion(h());
      const observations = fact.run(h());
      expect(observations.length).toBeGreaterThan(0);
      for (const o of observations) console.log(observationLine(TASK, version, o));
    }, FACT_MS);
  }
});
