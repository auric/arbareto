// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T035: Open submodule, service part (feature 005 plan.md D11, contract Δ3 `openSubmodule`, data-model §9, spec FR-047 to FR-052, SC-007, quickstart.md Q26).
// The shell binds the joined path in a `repositoryDiscovery` context and forwards `{repositoryId, bootstrapId, path}`. The test plays that native step.

import { describe, expect } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenSubmoduleResult } from "../../src/contracts/envelope";
import { printOrigin } from "../origin";
import { buildSubmodules, faGit, type FaFixture } from "./file-actions-fixtures";
import { useFixtureRoot } from "./fixture-root";
import { approve, gitPath, outcome, readOk, SUCCEEDED, until, withService } from "./hunk-harness";
import { caseTest, type Capability, type RegistrationResult, type Service, type ServiceResponse } from "./service-harness";
import { canary } from "./workbench-fixtures";

for (const module of ["submodule-open", "session"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
useFixtureRoot();

const TASK = "T035";
const SHELL: Capability[] = ["shell-double"];
const TIMEOUT_MS = 120_000;

let builds = 0;
const world = (): FaFixture & { sup: string } => buildSubmodules(gitPath(), `t035-sub-${++builds}`);
const git = (repo: string, args: string[]) => faGit(gitPath(), repo, args).toString("utf8");

// The native step of contract Δ3: the shell joins `path` to the worktree root and binds the folder in a `repositoryDiscovery` context.
function openSubmodule(service: Service, parent: RegistrationResult, root: string, path: string): Promise<ServiceResponse<RegistrationResult | { reason: string }>> {
  const bootstrapId = service.runner.addContext("repositoryDiscovery", join(root, ...path.split("/")));
  return service.request("openSubmodule", { repositoryId: parent.repositoryId, bootstrapId, path });
}

const refusal = (response: ServiceResponse<unknown>) => ({ state: response.state, code: response.code, result: response.result });
const unavailable = (reason: string) => ({ state: "failed", code: "SUBMODULE_UNAVAILABLE", result: { reason } });

describe("the checks in plan.md D11 order", () => {
  caseTest(TASK, "a path that is no stage-0 gitlink gives not-submodule; an absent .git, a .git that resolves elsewhere, and a .git file with a missing Git folder give submodule-not-initialized", SHELL, () =>
    withService({ name: "t035-checks" }, async (service) => {
      const w = world();
      const head = git(w.sup, ["rev-parse", "HEAD"]).trim();
      git(w.sup, ["update-index", "--add", "--cacheinfo", `160000,${head},fake`]);
      mkdirSync(join(w.sup, "fake", ".git"), { recursive: true });
      const parent = await service.register(w.sup);
      for (const path of ["super.txt", "missing", "mid/leaf"]) {
        const response = await openSubmodule(service, parent, w.sup, path);
        expect({ path, ...refusal(response) }).toEqual({ path, ...unavailable("not-submodule") });
        expect(OpenSubmoduleResult.safeParse(response.result).success).toBe(true);
      }
      for (const path of ["bare", "fake", "broken"]) expect({ path, ...refusal(await openSubmodule(service, parent, w.sup, path)) }).toEqual({ path, ...unavailable("submodule-not-initialized") });
      // The parent stays registered after each refusal.
      expect(outcome(await service.readWorkspace(parent.repositoryId))).toEqual(SUCCEEDED);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a submodule folder that is a link gives path", ["shell-double", "symlink"], () =>
    withService({ name: "t035-link" }, async (service) => {
      const w = world();
      const head = git(w.sup, ["rev-parse", "HEAD"]).trim();
      git(w.sup, ["update-index", "--add", "--cacheinfo", `160000,${head},lnk`]);
      symlinkSync(join(w.sup, "solo"), join(w.sup, "lnk"), "dir");
      const parent = await service.register(w.sup);
      expect(refusal(await openSubmodule(service, parent, w.sup, "lnk"))).toEqual(unavailable("path"));
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "SC-007: an untrusted parent with a command-valued core.fsmonitor gives TRUST_REQUIRED, and the canary marker stays absent", SHELL, () =>
    withService({ name: "t035-gate" }, async (service) => {
      const w = world();
      const parent = await service.register(w.sup);
      await readOk(service, parent.repositoryId);
      const monitor = canary(w.root, "t035-parent-fsmonitor");
      git(w.sup, ["config", "core.fsmonitor", monitor.command]);
      expect(outcome(await openSubmodule(service, parent, w.sup, "solo"))).toEqual({ state: "failed", code: "TRUST_REQUIRED" });
      expect(existsSync(monitor.log)).toBe(false);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a running parent mutation gives BUSY before any process", SHELL, () =>
    withService({ name: "t035-busy" }, async (service) => {
      const w = world();
      writeFileSync(join(w.sup, "scratch.txt"), "s\n");
      const parent = await service.register(w.sup);
      const fresh = await readOk(service, parent.repositoryId);
      const entry = fresh.entries.find((e) => e.path === "scratch.txt")!;
      const review = await service.request<{ workbenchToken: string }>("reviewWorkbench", { action: "delete", snapshotId: fresh.snapshotId, entryIds: [entry.entryId], mode: "permanent" }, { repositoryId: parent.repositoryId, repositoryGeneration: fresh.generation });
      expect(outcome(review)).toEqual(SUCCEEDED);
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      service.runner.inject.holdWalk = (kind) => (kind === "fileDelete" ? gate : Promise.resolve());
      const requestId = service.send("runWorkbench", { workbenchToken: review.result!.workbenchToken, start: true }, { repositoryId: parent.repositoryId });
      try {
        await until(() => service.runner.frames.some((f) => f.type === "fileDelete"), "fileDelete frame");
        const calls = service.runner.calls.length;
        expect(outcome(await openSubmodule(service, parent, w.sup, "solo"))).toEqual({ state: "rejected", code: "BUSY" });
        expect(service.runner.calls.length).toBe(calls);
      } finally {
        release();
        service.runner.inject.holdWalk = null;
      }
      expect(outcome(await service.response(requestId))).toEqual(SUCCEEDED);
    }),
    TIMEOUT_MS,
  );
});

describe("the open (plan.md D11 steps 5 and 6, spec FR-049 to FR-051)", () => {
  caseTest(TASK, "an initialized submodule registers in place of the parent, and a nested one opens one level at a time", SHELL, () =>
    withService({ name: "t035-open" }, async (service) => {
      const w = world();
      const parent = await service.register(w.sup);
      const solo = await openSubmodule(service, parent, w.sup, "solo");
      expect(outcome(solo)).toEqual(SUCCEEDED);
      expect(OpenSubmoduleResult.safeParse(solo.result).success).toBe(true);
      const soloResult = solo.result as RegistrationResult;
      // The shell stores the recent entry of this result (contract Δ6 `registered_root`).
      expect(soloResult.worktreeRoot.replaceAll("\\", "/")).toBe(git(join(w.sup, "solo"), ["rev-parse", "--show-toplevel"]).trim());
      expect(soloResult.repositoryId).not.toBe(parent.repositoryId);
      expect(outcome(await service.readWorkspace(parent.repositoryId))).toEqual({ state: "rejected", code: "UNKNOWN_TARGET" });
      expect(outcome(await service.readWorkspace(soloResult.repositoryId))).toEqual(SUCCEEDED);
      // Back to the parent, then down to mid and its nested leaf.
      const again = await service.register(w.sup);
      const mid = await openSubmodule(service, again, w.sup, "mid");
      expect(outcome(mid)).toEqual(SUCCEEDED);
      const midResult = mid.result as RegistrationResult;
      const leaf = await openSubmodule(service, midResult, join(w.sup, "mid"), "leaf");
      expect(outcome(leaf)).toEqual(SUCCEEDED);
      expect((leaf.result as RegistrationResult).worktreeRoot.replaceAll("\\", "/")).toBe(git(join(w.sup, "mid", "leaf"), ["rev-parse", "--show-toplevel"]).trim());
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "FR-050: the submodule gets its own trust state; its command-valued core.fsmonitor runs only after its own approval", SHELL, () =>
    withService({ name: "t035-trust" }, async (service) => {
      const w = world();
      const monitor = canary(w.root, "t035-sub-fsmonitor");
      git(join(w.sup, "solo"), ["config", "core.fsmonitor", monitor.command]);
      const parent = await service.register(w.sup);
      await approve(service, parent.repositoryId);
      const opened = await openSubmodule(service, parent, w.sup, "solo");
      expect(outcome(opened)).toEqual(SUCCEEDED);
      const sub = opened.result as RegistrationResult;
      expect(outcome(await service.readWorkspace(sub.repositoryId))).toEqual({ state: "failed", code: "TRUST_REQUIRED" });
      expect(existsSync(monitor.log)).toBe(false);
      await approve(service, sub.repositoryId);
      expect(outcome(await service.readWorkspace(sub.repositoryId))).toEqual(SUCCEEDED);
      expect(existsSync(monitor.log)).toBe(true);
    }),
    TIMEOUT_MS,
  );
});
