// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T006: the T005 Git facts (a) to (m) inside the WSL distro (plan.md P0.2). The fixtures live in the owned distro folder and use the distro Git, never `/mnt`.
// Each fact prints `OBSERVATION T006` lines. A `match=false` line is a finding for research.md, not a failure.

import { expect } from "bun:test";
import { FACTS, gitVersion, observationLine } from "../git/remote-facts";
import type { GitHost } from "../git/remote-fixtures";
import { distroGitHost } from "./fixtures";
import { useWslFolder, WSL_MINIMUM_GIT, wslTest, type WslHost } from "./wsl-host";

useWslFolder();

const TASK = "T006";
const FACT_MS = 1_800_000;
const NEEDS = ["distro-git-2.55", "wsl-fixture-fs-id"] as const;
const GLOBAL_TEXT = "[user]\n\tname = Arbareto Fixture\n\temail = fixture@arbareto.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n";

function atLeastFloor(version: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (m === null) return false;
  for (let i = 0; i < 3; i++) if (Number(m[i + 1]) !== WSL_MINIMUM_GIT[i]) return Number(m[i + 1]) > WSL_MINIMUM_GIT[i]!;
  return true;
}

let host: GitHost | undefined;
const h = (w: WslHost) => (host ??= distroGitHost(w, "remote", GLOBAL_TEXT));

wslTest("distro Git version", NEEDS, (w) => {
  const version = gitVersion(h(w));
  console.log(observationLine(TASK, version, { fact: "version", expected: `>=${WSL_MINIMUM_GIT.join(".")}`, observed: version, match: atLeastFloor(version) }));
});

for (const fact of FACTS) {
  wslTest(`(${fact.id}) ${fact.title}`, NEEDS, (w) => {
    const version = gitVersion(h(w));
    const observations = fact.run(h(w));
    expect(observations.length).toBeGreaterThan(0);
    for (const o of observations) console.log(observationLine(TASK, `${version}@${w.distro}`, o));
  }, FACT_MS);
}
