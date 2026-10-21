// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The shared parts of the fact tests T003 to T005 (research.md R21). T006 parses the OBSERVATION lines, so their format must not change.

import { expect, test } from "bun:test";
import { fixtureDir } from "./fixture-root";
import { wb } from "./workbench-fixtures";

// plan.md D2: every argument array starts with `--no-lazy-fetch`. Reads add `--no-optional-locks` and `--literal-pathspecs`.
export const STEP = ["--no-lazy-fetch"];
export const READ = ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs"];

export interface Observation {
  fact: string;
  expected: unknown;
  observed: unknown;
  match: boolean;
}

export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const obs = (fact: string, expected: unknown, observed: unknown, match = same(expected, observed)): Observation => ({ fact, expected, observed, match });
// JSON without spaces, so each `key=value` field of an OBSERVATION line is one token.
const token = (v: unknown) => JSON.stringify(v ?? null).replaceAll(" ", "\\u0020");
// `host` is the last field, `git=<version>` or `os=<release>`.
export const observationLine = (task: string, o: Observation, host: string) =>
  `OBSERVATION ${task}: ${o.fact.replaceAll(" ", "_")} expected=${token(o.expected)} observed=${token(o.observed)} match=${o.match} ${host}`;

// tasks.md T003 names Git 2.56.0.windows.2 on Windows. Other hosts record the version only.
const EXPECTED_VERSION = process.platform === "win32" ? "2.56.0.windows.2" : "record";

// One test for the Git version, then one test per fact. Call it inside `describeGit`.
export function factTests(task: string, git: string, facts: [string, string, (git: string) => Observation[]][], timeoutMs: number): void {
  let version = "";
  const versionOf = () => {
    if (version !== "") return version;
    const out = wb({ git, dir: fixtureDir(`${task}-version`), env: {} }, ["version"]).stdout.toString("utf8").trim();
    const m = /^git version (\S+)$/.exec(out);
    if (m === null) throw new Error(`git version output refused: ${JSON.stringify(out)}`);
    return (version = m[1]!);
  };

  test("Git version", () => {
    const v = versionOf();
    console.log(observationLine(task, obs("version", EXPECTED_VERSION, v, EXPECTED_VERSION === "record" || v === EXPECTED_VERSION), `git=${v}`));
  }, timeoutMs);

  for (const [id, title, fact] of facts) {
    test(`${id} ${title}`, () => {
      const observations = fact(git);
      expect(observations.length).toBeGreaterThan(0);
      for (const o of observations) console.log(observationLine(task, o, `git=${versionOf()}`));
    }, timeoutMs);
  }
}
