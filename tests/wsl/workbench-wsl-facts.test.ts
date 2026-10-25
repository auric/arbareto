// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// 004 T081 Git facts F1 to F24 and F29 to F31 in the distro (research.md R21). The harness is `workbench-wsl-harness.ts`.

import { describe, expect } from "bun:test";
import { observationLine } from "../git/fact-runner";
import { wslTest, type WslHost } from "./wsl-host";
import { FACT_MS, FACTS, hostOf, NEEDS, TASK, useWorkbenchWsl } from "./workbench-wsl-harness";

useWorkbenchWsl();

describe("Git facts F1 to F24 and F29 to F31 in the distro (T081, research.md R21)", () => {
  const versionOf = (w: WslHost) => `git=${(w.gitVersion ?? "unknown")}@${w.distro}`;
  for (const [id, title, fact] of FACTS) {
    wslTest(`${id} ${title}`, NEEDS, (w) => {
      hostOf(w);
      const observations = fact(w);
      expect(observations.length).toBeGreaterThan(0);
      for (const o of observations) console.log(observationLine(TASK, o, versionOf(w)));
    }, FACT_MS);
  }
});
