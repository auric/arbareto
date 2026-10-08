// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T229: `reviewSubmodules` rules that the T222 cases do not cover (contract §12 "Review reads", "Refusals" `active-value`, data-model §6 "Submodule review").

import { describe, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { gitmodulesIndexArgs } from "../../src/git-service/commands";
import { printOrigin } from "../origin";
import { useFixtureRoot } from "./fixture-root";
import { buildF27, buildF28 } from "./fixtures";
import { gitPath, TIMEOUT_MS } from "./hunk-harness";
import { caseTest, type Capability } from "./service-harness";
import { fixtureGit, reviewSubmodules, rowOf, superOf, withFixture } from "./submodule-harness";

printOrigin("../../src/git-service/submodule-review.ts", import.meta.dir);
printOrigin("../../src/git-service/session.ts", import.meta.dir);

const TASK = "T229";
const SHELL: Capability[] = ["shell-double"];

useFixtureRoot();

describe("active-value (contract §12 \"Refusals\")", () => {
  caseTest(TASK, "a submodule.<name>.active value that is no Git boolean gives active-value with its text and no command", SHELL, () => {
    const b = buildF28(gitPath(), "t229-active-value", "inactive");
    fixtureGit(b, superOf(b), ["config", "submodule.solo.active", "maybe"]);
    return withFixture(b, "t229-active-value", async (service) => {
      const { repositoryId } = await service.register(superOf(b));
      const r = await reviewSubmodules(service, repositoryId);
      expect(r.response.state).toBe("succeeded");
      expect(r.refusals.map((x) => ({ path: x.path, reason: x.reason, text: x.text, command: x.remedy?.command ?? null }))).toEqual([
        { path: "solo", reason: "active-value", text: "Submodule solo has a submodule.solo.active value that is not true or false. Fix it in a terminal, then use Refresh.", command: null },
      ]);
      expect(rowOf(r, "solo").refusal).toBe("active-value");
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "a boolean value in another spelling gives no refusal", SHELL, () => {
    const b = buildF28(gitPath(), "t229-active-yes", "inactive");
    fixtureGit(b, superOf(b), ["config", "submodule.solo.active", "yes"]);
    return withFixture(b, "t229-active-yes", async (service) => {
      const { repositoryId } = await service.register(superOf(b));
      const r = await reviewSubmodules(service, repositoryId);
      expect(r.refusals).toEqual([]);
    });
  }, TIMEOUT_MS);
});

describe("review reads and token (contract §12 \"Review reads\", data-model §6)", () => {
  caseTest(TASK, "without a worktree .gitmodules, the review reads the index blob by its stage-0 object ID and never names :.gitmodules", SHELL, () => {
    const b = buildF27(gitPath(), "t229-review-index", "base");
    const oid = fixtureGit(b, superOf(b), ["rev-parse", ":.gitmodules"]).trim();
    rmSync(join(superOf(b), ".gitmodules"));
    return withFixture(b, "t229-review-index", async (service) => {
      const { repositoryId } = await service.register(superOf(b));
      const from = service.runner.calls.length;
      const r = await reviewSubmodules(service, repositoryId);
      expect({ mid: rowOf(r, "mid").action, solo: rowOf(r, "solo").action }).toEqual({ mid: "clone", solo: "clone" });
      const args = service.runner.calls.slice(from).map((c) => c.arguments);
      expect(args.filter((a) => a.includes("--blob"))).toContainEqual(gitmodulesIndexArgs(oid, "sha1"));
      expect(args.flat().filter((a) => a.startsWith(":"))).toEqual([]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "a review with a refusal still issues a token, because the token binds the refusals", SHELL, () => {
    const b = buildF28(gitPath(), "t229-review-token", "no-url");
    return withFixture(b, "t229-review-token", async (service) => {
      const { repositoryId } = await service.register(superOf(b));
      const r = await reviewSubmodules(service, repositoryId);
      expect({ state: r.response.state, reasons: r.refusals.map((x) => x.reason), token: typeof r.token }).toEqual({ state: "succeeded", reasons: ["no-url"], token: "string" });
    });
  }, TIMEOUT_MS);
});
