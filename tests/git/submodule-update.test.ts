// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T223: `updateSubmodules` (contract §12 "Update protocol", "Trust", "Environment and console", "Reconciliation and outcome", "Remedies").
// `src/git-service/submodule-update.ts` comes with T230, which registers the operation in the session. T231 turns the cases into real tests.

import { describe, expect, spyOn } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import policyFile from "../../src/contracts/git-environment.json";
import { APPROVAL_LIFETIME_MS, UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION } from "../../src/contracts/limits";
import { SUBMODULE_PROGRESS_PHASES, SubmoduleProgress, type SubmodulePlanRow } from "../../src/contracts/submodules";
import * as trustModule from "../../src/git-service/trust";
import { printOrigin } from "../origin";
import { FIXTURE_GLOBAL_CONFIG, FIXTURE_ROOT, fixtureDir, fixtureEnv, ownedGit, serviceEnv, useFixtureRoot } from "./fixture-root";
import { fixtureGitPath } from "./git-binary";
import { buildChanged, buildF27, buildF28, buildF29, put, type Built, type F27Variant, type F29Variant } from "./fixtures";
import { fileSha256, rawIndexDigest, refState, submoduleState, workingFileDigests, type SubmoduleUpdateResult } from "./git-oracle";
import {
  applyHunk,
  commit as runCommit,
  commitCalls,
  gitPath,
  mutationFrames,
  outcome,
  progressStates,
  readOk,
  repoOf,
  reviewOk as commitReview,
  selectHunks,
  SUCCEEDED,
  TIMEOUT_MS,
  underTest,
  until,
  valuesOf,
  withService,
} from "./hunk-harness";
import { buildFetchFlags } from "./remote-fixtures";
import { caseTest, NO_TOTAL_DEADLINE_WAIT_MS, once, withFsCalls, withKeptWorkspaces, type Capability, type Service, type ServiceResponse, type SubmoduleCheckpoint } from "./service-harness";
import { callsFrom, gitExe, hostFor, native, register, reviewed as syncReviewed, subcommandOf, sync, withSync } from "./sync-harness";
import { buildWorkbench } from "./workbench-fixtures";
import {
  callsSince,
  checkoutRemedy,
  cloneRemedy,
  commandOf,
  copySuper,
  fetchRemedy,
  fixtureGit,
  gitLocation,
  globalEnv,
  insideSubmodule,
  invalidGitFolder,
  isUpdateStep,
  miniGit,
  miniWorld,
  moduleDirOf,
  NOTES,
  objectsWith,
  oracleExcept,
  oracleOf,
  q,
  ranCanaries,
  canaryLines,
  refusalsOf,
  resultOf,
  resultsOf,
  reviewSubmodules,
  rowOf,
  saveCommand,
  STEP_TEXT,
  stateOf,
  superOf,
  TEXTS,
  underTestSubmodule,
  updateCommand,
  updateSteps,
  updateSubmodules,
  sendUpdate,
  treeGit,
  treeWorld,
  withFixture,
  type MiniWorld,
  type SubmoduleReview,
  type TreeWorld,
} from "./submodule-harness";
import { nestedFlat } from "./submodule-count-fixture";

printOrigin("../../src/contracts/submodules.ts", import.meta.dir);

const TASK = "T223";
const SHELL: Capability[] = ["shell-double"];
const updateCase = (name: string, needs: readonly Capability[], fn: () => Promise<void>) => caseTest(TASK, name, needs, fn, TIMEOUT_MS);

useFixtureRoot();

const update = () => underTestSubmodule("submodule-update");

// Registers the superproject and reviews it. The review must pass without a refusal.
async function reviewedOk(service: Service, dir: string): Promise<{ repositoryId: string; r: SubmoduleReview }> {
  const { repositoryId } = await service.register(dir);
  const r = await reviewSubmodules(service, repositoryId);
  expect({ state: r.response.state, refusals: r.refusals.map((x) => [x.path, x.reason]), token: typeof r.token }).toEqual({ state: "succeeded", refusals: [], token: "string" });
  return { repositoryId, r };
}

// Imports the module under test, then registers, reviews, and runs the update.
async function updated(service: Service, dir: string): Promise<{ repositoryId: string; r: SubmoduleReview; response: ServiceResponse; from: number }> {
  await update();
  const { repositoryId, r } = await reviewedOk(service, dir);
  const from = service.runner.calls.length;
  return { repositoryId, r, response: await updateSubmodules(service, repositoryId, r), from };
}

// The location of a call relative to `base`, with `/`. Null: the registered worktree.
const at = (base: string, args: readonly string[]) => {
  const location = gitLocation(args);
  return location === null ? null : relative(base, resolve(base, location)).replaceAll("\\", "/");
};
const isAt = (base: string, path: string) => (c: { arguments: readonly string[] }) => at(base, c.arguments) === path;
const cmd = (c: { arguments: readonly string[] }) => commandOf(c.arguments).join(" ");
const confirmRuns = (service: Service) => service.runner.frames.filter((f) => f.type === "confirmRun") as ({ programCount: number; uncheckedCount: number; submodulePaths: string[]; callsBefore: number } & Record<string, unknown>)[];
const stderrOf = (c: { stderr?: Uint8Array[] }) => Buffer.concat(c.stderr ?? []).toString("utf8");

// Contract §12 "Update protocol" step 5 and "Environment and console": invariants of every update step.
function checkSteps(service: Service, from: number): void {
  const steps = updateSteps(service, from);
  expect(steps.filter((c) => c.arguments.includes("--recursive")).map((c) => c.arguments)).toEqual([]);
  expect(steps.filter((c) => commandOf(c.arguments)[0] === "fetch" && !c.arguments.includes("--no-recurse-submodules")).map((c) => c.arguments)).toEqual([]);
  expect(steps.filter((c) => c.arguments[0] !== "--no-lazy-fetch" || c.environmentPolicy !== "network").map((c) => [c.environmentPolicy, ...c.arguments])).toEqual([]);
}

const CLONE = (path: string) => ["submodule", "update", "--init", "--progress", "--", `:(literal)${path}`];
const CHECKOUT = (path: string) => ["submodule", "update", "--init", "--no-fetch", "--progress", "--", `:(literal)${path}`];
const FETCH = ["fetch", "--progress", "--no-recurse-submodules"];
const subsOf = (b: Built) => b.facts.notes.submodules as Record<string, { name: string; url: string; recorded: string; head: string | null }>;
const headOf = (b: Built, dir: string) => fixtureGit(b, dir, ["rev-parse", "--verify", "-q", "HEAD"], [0, 1]).trim() || null;
const keptOf = (b: Built, path: string) => resolve(b.root, (b.facts.notes.kept as Record<string, string>)[path]!);
// Contract §12 "Scope": the state after the run equals Git's own update in the copy, with the `except` values, and that update exited `exit`.
const expectOracle = (b: Built, oracle: SubmoduleUpdateResult, exit: number, except?: Parameters<typeof oracleExcept>[1]) => expect({ oracle: oracle.exitCode, state: stateOf(b) }).toEqual({ oracle: exit, state: oracleExcept(oracle, except) });
// The F29 monitor canaries run on an index read in `mid` or `leaf`. The `-c` value reaches the nested commands of `stateOf`.
const DISARM = ["-c", "core.fsmonitor=false"];
const f29State = (b: Built) => stateOf(b, superOf(b), DISARM);

describe("Git's own update (contract §12 \"Scope\", research.md R14 S20)", () => {
  const VARIANTS: F27Variant[] = ["base", "behind-present", "behind-fetch", "deinit-kept", "update-none", "literal-paths", "kept-remote", "spaces", "unreachable-target", "headless-kept"];
  for (const variant of VARIANTS) {
    updateCase(`F27 ${variant}: every submodule HEAD, .git/modules folder, and submodule.* key equals Git's own update --init --recursive, and the superproject raw index digest stays equal`, SHELL, () => {
      const name = `t223-oracle-${variant}`;
      const b = buildF27(gitPath(), name, variant);
      const sup = superOf(b);
      // The owned configuration leaves `fetch.recurseSubmodules` unset.
      expect(fixtureGit(b, sup, ["config", "--get-all", "fetch.recurseSubmodules"], [1])).toBe("");
      const oracle = oracleOf(b, "oracle-copy");
      const index = rawIndexDigest(gitPath(), sup);
      return withFixture(b, name, async (service) => {
        const { response, from } = await updated(service, sup);
        expect(stateOf(b)).toEqual({ heads: oracle.heads, gitDirs: oracle.gitDirs, keys: oracle.keys });
        expect({ oracle: oracle.exitCode, outcome: outcome(response) }).toEqual({ oracle: 0, outcome: SUCCEEDED });
        expect(rawIndexDigest(gitPath(), sup)).toBe(index);
        checkSteps(service, from);
      });
    });
  }

  updateCase(`F27 base: the runner sees the clone steps in depth-first index order, and the nested row runs after its parent clone`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-order", "base");
    const sup = superOf(b);
    return withFixture(b, "t223-order", async (service) => {
      const { from } = await updated(service, sup);
      const steps = updateSteps(service, from);
      expect(steps.map((c) => ({ at: at(sup, c.arguments), prefix: c.arguments.slice(0, 3), command: commandOf(c.arguments) }))).toEqual([
        { at: "", prefix: ["--no-lazy-fetch", "-c", "fetch.recurseSubmodules=no"], command: CLONE("mid") },
        { at: "mid", prefix: ["--no-lazy-fetch", "-c", "fetch.recurseSubmodules=no"], command: CLONE("leaf") },
        { at: "", prefix: ["--no-lazy-fetch", "-c", "fetch.recurseSubmodules=no"], command: CLONE("solo") },
      ]);
    });
  });

  updateCase(`F27 behind-fetch: the fetch-checkout row runs the fetch, the check reads, and the checkout step without a fetch`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-fetch-checkout", "behind-fetch");
    const sup = superOf(b);
    return withFixture(b, "t223-fetch-checkout", async (service) => {
      const { response, from } = await updated(service, sup);
      const calls = callsSince(service, from);
      const fetch = calls.findIndex((c) => at(sup, c.arguments) === "solo" && commandOf(c.arguments).join(" ") === FETCH.join(" "));
      const head = calls.findIndex((c, i) => i > fetch && at(sup, c.arguments) === "solo" && cmd(c) === "rev-parse --verify -q HEAD");
      const refs = calls.findIndex((c, i) => i > fetch && at(sup, c.arguments) === "solo" && cmd(c) === "for-each-ref --contains=HEAD --count=1 --format=%(refname)");
      const checkout = calls.findIndex((c) => at(sup, c.arguments) === "" && cmd(c) === CHECKOUT("solo").join(" "));
      expect({ fetch: fetch >= 0, order: fetch < head && fetch < refs && head < checkout && refs < checkout }).toEqual({ fetch: true, order: true });
      expect(calls[fetch]!.arguments.slice(0, 2)).toEqual(["--no-lazy-fetch", "-C"]);
      expect(resultOf(response, "solo").fetched).toBe(true);
    });
  });

  updateCase(`every update request names the network policy, whose environment sets GIT_PROTOCOL_FROM_USER=0`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-network", "behind-fetch");
    return withFixture(b, "t223-network", async (service) => {
      const { from } = await updated(service, superOf(b));
      expect(policyFile.policies.network.set.GIT_PROTOCOL_FROM_USER).toBe("0");
      const steps = updateSteps(service, from);
      expect(steps.length).toBeGreaterThan(0);
      expect([...new Set(steps.map((c) => c.environmentPolicy))]).toEqual(["network"]);
    });
  });

  updateCase(`F29 base: the first fetch of mid passes --no-recurse-submodules, and its output names no nested submodule (research.md R14 S25)`, SHELL, () => {
    const b = buildF29(gitPath(), "t223-no-recursion", "base");
    const sup = superOf(b);
    return withFixture(b, "t223-no-recursion", async (service) => {
      const { from } = await updated(service, sup);
      const fetches = callsSince(service, from).filter((c) => at(sup, c.arguments) === "mid" && commandOf(c.arguments)[0] === "fetch");
      expect(fetches.length).toBeGreaterThan(0);
      for (const f of fetches) expect({ args: f.arguments.includes("--no-recurse-submodules"), nested: stderrOf(f).includes("leaf") }).toEqual({ args: true, nested: false });
    });
  });

  updateCase(`F27 unreachable-target: the row fetches before its checkout, as Git's own update does`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-unreachable", "unreachable-target");
    const sup = superOf(b);
    const oracle = oracleOf(b, "oracle-copy");
    return withFixture(b, "t223-unreachable", async (service) => {
      const { from } = await updated(service, sup);
      const calls = callsSince(service, from);
      const fetch = calls.findIndex((c) => at(sup, c.arguments) === "solo" && commandOf(c.arguments)[0] === "fetch");
      const checkout = calls.findIndex((c) => cmd(c) === CHECKOUT("solo").join(" "));
      expect({ fetch: fetch >= 0, before: fetch < checkout }).toEqual({ fetch: true, before: true });
      expectOracle(b, oracle, 0);
    });
  });

  updateCase(`F27 kept-remote: the row runs the connect step, the first fetch, remote get-url, and the fallback fetch -- good <target>, then the checkout`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-kept-remote", "kept-remote");
    const sup = superOf(b);
    const target = subsOf(b).solo!.recorded;
    const oracle = oracleOf(b, "oracle-copy");
    return withFixture(b, "t223-kept-remote", async (service) => {
      const { from } = await updated(service, sup);
      const steps = updateSteps(service, from).filter((c) => at(sup, c.arguments) === "solo" || c.arguments.includes(":(literal)solo"));
      expect(steps.map(cmd)).toEqual([CHECKOUT("solo").join(" "), FETCH.join(" "), [...FETCH, "--", "good", target].join(" "), CHECKOUT("solo").join(" ")]);
      const names = callsSince(service, from).filter((c) => at(sup, c.arguments) === "solo" && commandOf(c.arguments).slice(0, 4).join(" ") === "remote get-url --all --");
      expect(names.map((c) => commandOf(c.arguments)[4]).sort()).toEqual(["good", "origin"]);
      expectOracle(b, oracle, 0);
    });
  });

  updateCase(`F27 kept-remote: the first fetch from the missing origin fails, the fallback fetch reaches the target, the row states moved, and the outcome is succeeded`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-first-fetch", "kept-remote");
    const sup = superOf(b);
    const oracle = oracleOf(b, "oracle-copy");
    return withFixture(b, "t223-first-fetch", async (service) => {
      const { response, from } = await updated(service, sup);
      const first = callsSince(service, from).find((c) => at(sup, c.arguments) === "solo" && cmd(c) === FETCH.join(" "))!;
      expect(first.exit?.exitCode).not.toBe(0);
      const row = resultOf(response, "solo");
      expect({ outcome: outcome(response), state: row.state, newCommit: row.newCommit, fetched: row.fetched, connected: row.connected }).toEqual({
        outcome: { state: "succeeded", code: undefined },
        state: "moved",
        newCommit: subsOf(b).solo!.recorded,
        fetched: true,
        connected: true,
      });
      expectOracle(b, oracle, 0);
    });
  });

  updateCase(`F27 literal-paths: the sub[1] row leaves sub1 unchanged`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-literal", "literal-paths");
    const sup = superOf(b);
    const target = subsOf(b)["sub[1]"]!.recorded;
    const oracle = oracleOf(b, "oracle-copy");
    return withFixture(b, "t223-literal", async (service) => {
      await update();
      const { repositoryId, r } = await reviewedOk(service, sup);
      // Index order puts `sub1` before `sub[1]`. Holds the `sub[1]` clone step and moves `sub1`, which a plain `sub[1]` pathspec checks out again (probe S8).
      const release = service.runner.holdStart((c) => c.arguments.includes(":(literal)sub[1]"));
      const requestId = sendUpdate(service, repositoryId, r);
      // The held step blocks the update. A response first means that the step never started.
      await until(() => service.runner.calls.some((c) => c.arguments.includes(":(literal)sub[1]")) || service.responseAt.has(requestId), "sub[1] clone step", TIMEOUT_MS);
      expect(service.runner.calls.some((c) => c.arguments.includes(":(literal)sub[1]"))).toBe(true);
      expect(headOf(b, join(sup, "sub1"))).toBe(subsOf(b).sub1!.recorded);
      fixtureGit(b, join(sup, "sub1"), ["checkout", "-q", "--detach", target]);
      release();
      const response = await service.response(requestId);
      expect({ "sub[1]": resultOf(response, "sub[1]").newCommit, sub1: headOf(b, join(sup, "sub1")) }).toEqual({ "sub[1]": target, sub1: target });
      expectOracle(b, oracle, 0, { heads: { sub1: target } });
    });
  });

  // A local clone copies objects without a pack transfer, so only a fetch step prints the `NN% (a/b)` counter (research.md R14 S20).
  updateCase(`F27 behind-fetch: progress events carry the row index, the row count, and a percentage, and no Git text`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-progress", "behind-fetch");
    return withFixture(b, "t223-progress", async (service) => {
      await update();
      const { repositoryId, r } = await reviewedOk(service, superOf(b));
      const requestId = sendUpdate(service, repositoryId, r);
      await service.response(requestId);
      const events = (service.progress as { requestId?: string; phase?: string }[]).filter((p) => p.requestId === requestId && (SUBMODULE_PROGRESS_PHASES as readonly (string | undefined)[]).includes(p.phase));
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) expect(SubmoduleProgress.safeParse(event).success).toBe(true);
      expect(events.some((e) => valuesOf(e, "percent").length > 0)).toBe(true);
    });
  });

  // T365: the found nested row has no other name in the progress stream.
  updateCase(`F27 base: each progress event names the row of its row index by path, also the found nested row mid/leaf`, SHELL, () => {
    const b = buildF27(gitPath(), "t365-progress-path", "base");
    const sup = superOf(b);
    return withFixture(b, "t365-progress-path", async (service) => {
      await update();
      const { repositoryId, r } = await reviewedOk(service, sup);
      const isStep = (p: { requestId?: string; phase?: string }) => p.requestId === requestId && (SUBMODULE_PROGRESS_PHASES as readonly (string | undefined)[]).includes(p.phase);
      const events = () => (service.progress as { requestId?: string; phase?: string; path?: string; counters?: { rowIndex?: number } }[]).filter(isStep);
      // The held leaf clone step keeps the throttled leaf event from a merge with the solo event.
      const release = service.runner.holdStart(once((c) => isAt(sup, "mid")(c) && c.arguments.includes(":(literal)leaf")));
      const requestId = sendUpdate(service, repositoryId, r);
      await until(() => events().some((e) => e.counters?.rowIndex === 2) || service.responseAt.has(requestId), "row 2 progress event", TIMEOUT_MS);
      release();
      await service.response(requestId);
      for (const event of events()) expect(SubmoduleProgress.safeParse(event).success).toBe(true);
      const rows = ["mid", "mid/leaf", "solo"];
      expect(events().filter((e) => rows[e.counters!.rowIndex! - 1] !== e.path).map((e) => [e.counters?.rowIndex, e.path])).toEqual([]);
      expect(events().some((e) => e.path === "mid/leaf")).toBe(true);
      expect(resultOf(await service.response(requestId), "mid/leaf").found).toBe(true);
    });
  });
});

describe("trust (contract §12 \"Trust\", \"Update protocol\" step 3)", () => {
  updateCase(`F27 base with a stored superproject approval: the update registers submodules, and the next readTrust still reports approved`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-stored-approval", "base");
    const sup = superOf(b);
    const program = put(b.root, "programs/diff.sh", "#!/bin/sh\nexit 0\n").replaceAll("\\", "/");
    fixtureGit(b, sup, ["config", "diff.external", `'${program}'`]);
    const oracle = oracleOf(b, "oracle-copy");
    return withFixture(b, "t223-stored-approval", async (service) => {
      await update();
      const { repositoryId } = await service.register(sup);
      const trust = await service.readTrust(repositoryId);
      const approved = await service.approveTrust(repositoryId);
      expect(approved.result!.persistence).toBe("stored");
      const r = await reviewSubmodules(service, repositoryId);
      expect(outcome(await updateSubmodules(service, repositoryId, r))).toEqual({ state: "succeeded", code: undefined });
      expect(fixtureGit(b, sup, ["config", "--local", "--get", "submodule.solo.url"]).trim()).not.toBe("");
      expect((await service.readTrust(repositoryId)).result!.state).toBe("approved");
      expectOracle(b, oracle, 0);
    });
  });

  updateCase(`F29 base: confirmRun goes out before any update process; a declined reply ends canceled with CANCELED, no update process, and no canary run`, SHELL, () => {
    const b = buildF29(gitPath(), "t223-declined", "base");
    const before = f29State(b);
    return withFixture(b, "t223-declined", async (service) => {
      service.runner.inject.confirmRun = "declined";
      const { response, from } = await updated(service, superOf(b));
      expect(confirmRuns(service)).toHaveLength(1);
      expect(confirmRuns(service)[0]!.callsBefore).toBeLessThanOrEqual(service.runner.calls.length);
      expect({ outcome: outcome(response), steps: updateSteps(service, from).length, canaries: ranCanaries(b) }).toEqual({ outcome: { state: "canceled", code: "CANCELED" }, steps: 0, canaries: [] });
      expect(f29State(b)).toEqual(before);
    });
  });

  updateCase(`F29 base: after approved, the canaries run, and confirmRun precedes the first update step`, SHELL, () => {
    const b = buildF29(gitPath(), "t223-approved", "base");
    return withFixture(b, "t223-approved", async (service) => {
      const { from } = await updated(service, superOf(b));
      const first = service.runner.calls.indexOf(updateSteps(service, from)[0]!);
      expect({ first: first >= 0, before: confirmRuns(service)[0]!.callsBefore <= first }).toEqual({ first: true, before: true });
      expect(ranCanaries(b).length).toBeGreaterThan(0);
    });
  });

  // A `post-checkout` hook in the `solo` Git folder of F27 behind-present. It writes the two variables into the fixture folder.
  function envHook(b: Built): string {
    const file = join(b.root, "hook-env.txt");
    const dir = moduleDirOf(b, superOf(b), "solo");
    put(dir, "hooks/post-checkout", `#!/bin/sh\nprintf '%s %s' "$GIT_TERMINAL_PROMPT" "$GIT_NO_LAZY_FETCH" > '${file.replaceAll("\\", "/")}'\n`);
    return file;
  }

  updateCase(`after an approved confirmRun, a hook sees GIT_TERMINAL_PROMPT=0 and GIT_NO_LAZY_FETCH=1`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-hook-env", "behind-present");
    const file = envHook(b);
    return withFixture(b, "t223-hook-env", async (service) => {
      await updated(service, superOf(b));
      expect(confirmRuns(service)).toHaveLength(1);
      expect(readFileSync(file, "utf8")).toBe("0 1");
    });
  });

  updateCase(`F29 kept-folder: confirmRun counts the kept-folder canaries; none runs before the approved reply, and they run after it`, SHELL, () => {
    const b = buildF29(gitPath(), "t223-kept-confirm", "kept-folder");
    return withFixture(b, "t223-kept-confirm", async (service) => {
      await update();
      const { repositoryId, r } = await reviewedOk(service, superOf(b));
      let reply: (value: "approved") => void = () => {};
      service.runner.inject.confirmRun = () => new Promise((resolve) => (reply = resolve));
      const requestId = sendUpdate(service, repositoryId, r);
      await until(() => confirmRuns(service).length === 1, "confirmRun");
      expect(confirmRuns(service)[0]!.programCount).toBe(r.programs.length);
      expect(ranCanaries(b)).toEqual([]);
      reply("approved");
      await service.response(requestId);
      expect(canaryLines(b, "mid-hook").length).toBeGreaterThan(0);
    });
  });

  updateCase(`F29 relative-hooks: confirmRun goes out with the unchecked count, which includes the reuse row; a declined reply runs no canary`, SHELL, () => {
    const b = buildF29(gitPath(), "t223-relative-declined", "relative-hooks");
    const before = f29State(b);
    return withFixture(b, "t223-relative-declined", async (service) => {
      service.runner.inject.confirmRun = "declined";
      const { r } = await updated(service, superOf(b));
      const unchecked = r.programs.filter((p) => p.digest === "unchecked");
      expect(unchecked.some((p) => "rowId" in p && p.rowId === rowOf(r, "hk-reuse").rowId)).toBe(true);
      expect(confirmRuns(service)[0]!.uncheckedCount).toBe(unchecked.length);
      expect(ranCanaries(b)).toEqual([]);
      expect(f29State(b)).toEqual(before);
    });
  });

  updateCase(`F29 relative-hooks: after approved, the target-tree canaries of all four rows run, as in Git's own update`, SHELL, () => {
    const b = buildF29(gitPath(), "t223-relative-approved", "relative-hooks");
    return withFixture(b, "t223-relative-approved", async (service) => {
      await updated(service, superOf(b));
      for (const path of Object.keys(b.facts.notes.rows as Record<string, string>)) expect({ path, ran: canaryLines(b, `relhooks-${path}`).some((l) => l.startsWith("post-checkout B ")) }).toEqual({ path, ran: true });
    });
  });

  // Holds the `confirmRun` reply until the test runs `change`, then replies `approved`.
  async function recheck(service: Service, dir: string, change: () => void): Promise<{ response: ServiceResponse; from: number; r: SubmoduleReview; repositoryId: string; requestId: string }> {
    await update();
    const { repositoryId, r } = await reviewedOk(service, dir);
    let reply: (value: "approved") => void = () => {};
    service.runner.inject.confirmRun = () => new Promise((resolve) => (reply = resolve));
    const from = service.runner.calls.length;
    const requestId = sendUpdate(service, repositoryId, r);
    await until(() => confirmRuns(service).length === 1, "confirmRun");
    change();
    reply("approved");
    return { response: await service.response(requestId), from, r, repositoryId, requestId };
  }

  updateCase(`re-check: a submodule HEAD that moves while confirmRun is open ends failed with STALE_REVIEW; no update process starts, the mutation frames end with resolved, and the next mutation is not blocked`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-recheck-head", "behind-present");
    envHook(b);
    const sup = superOf(b);
    return withFixture(
      b,
      "t223-recheck-head",
      async (service) => {
        // The `solo` HEAD is its root commit, so the case moves it to the recorded commit.
        let moved: ReturnType<typeof stateOf> | undefined;
        const { response, from, r, repositoryId } = await recheck(service, sup, () => {
          fixtureGit(b, join(sup, "solo"), ["checkout", "-q", "--detach", subsOf(b).solo!.recorded]);
          moved = stateOf(b);
        });
        expect({ outcome: outcome(response), steps: updateSteps(service, from).length }).toEqual({ outcome: { state: "failed", code: "STALE_REVIEW" }, steps: 0 });
        expect(stateOf(b)).toEqual(moved!);
        expect(mutationFrames(service, response.operationId!).at(-1)).toBe("resolved");
        // A repeated request with the consumed token returns this operation.
        const again = await updateSubmodules(service, repositoryId, r);
        expect({ operationId: again.operationId, steps: updateSteps(service, from).length }).toEqual({ operationId: response.operationId, steps: 0 });
        service.runner.inject.confirmRun = "approved";
        const next = await reviewSubmodules(service, repositoryId);
        expect((await updateSubmodules(service, repositoryId, next)).code).not.toBe("BUSY");
      },
      { watchHints: false },
    );
  });

  updateCase(`re-check: a trust-relevant superproject change while confirmRun is open ends failed with TRUST_CHANGED, and no update process starts`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-recheck-trust", "behind-present");
    envHook(b);
    const sup = superOf(b);
    const program = put(b.root, "programs/diff.sh", "#!/bin/sh\nexit 0\n").replaceAll("\\", "/");
    const before = stateOf(b);
    return withFixture(
      b,
      "t223-recheck-trust",
      async (service) => {
        const { response, from } = await recheck(service, sup, () => void fixtureGit(b, sup, ["config", "diff.external", `'${program}'`]));
        expect({ outcome: outcome(response), steps: updateSteps(service, from).length }).toEqual({ outcome: { state: "failed", code: "TRUST_CHANGED" }, steps: 0 });
        expect(stateOf(b)).toEqual(before);
        expect(mutationFrames(service, response.operationId!).at(-1)).toBe("resolved");
      },
      { watchHints: false },
    );
  });

  updateCase(`re-check: without a change, the re-check passes, and the update runs`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-recheck-none", "behind-present");
    envHook(b);
    const oracle = oracleOf(b, "oracle-copy");
    return withFixture(b, "t223-recheck-none", async (service) => {
      const { response } = await recheck(service, superOf(b), () => {});
      expect(outcome(response)).toEqual({ state: "succeeded", code: undefined });
      expect(resultOf(response, "solo").state).toBe("moved");
      expectOracle(b, oracle, 0);
    });
  });

  updateCase(`F29 nested-programs: the nested row ends refused with programs, and the added fsmonitor canary never runs`, SHELL, () => {
    const b = buildF29(gitPath(), "t223-nested-programs", "nested-programs");
    const before = f29State(b);
    const pre = copySuper(b, "pre-update");
    return withFixture(b, "t223-nested-programs", async (service) => {
      const { response } = await updated(service, superOf(b));
      const leaf = resultOf(response, "mid/leaf");
      expect({ state: leaf.state, reason: leaf.reason, text: leaf.text, command: leaf.remedy?.command ?? null }).toEqual({ state: "refused", reason: "programs", text: TEXTS.programs("mid/leaf"), command: null });
      expect(canaryLines(b, "added-fsmonitor")).toEqual([]);
      // Git's own update runs the canaries, so the oracle runs after the canary checks.
      const oracle = oracleOf(b, "oracle-copy", pre);
      expect({ oracle: oracle.exitCode, state: f29State(b) }).toEqual({ oracle: 0, state: oracleExcept(oracle, { keep: before, rows: [["mid/leaf"]] }) });
    });
  });

  updateCase(`F29 row-programs: the second row ends refused with programs, and the changed hook never runs`, SHELL, () => {
    const b = buildF29(gitPath(), "t223-row-programs", "row-programs");
    const before = f29State(b);
    const pre = copySuper(b, "pre-update");
    return withFixture(b, "t223-row-programs", async (service) => {
      const { response } = await updated(service, superOf(b));
      const solo = resultOf(response, "solo");
      expect({ state: solo.state, reason: solo.reason }).toEqual({ state: "refused", reason: "programs" });
      expect(canaryLines(b, "solo-hook").filter((l) => l.startsWith("solo-hook post-checkout"))).toEqual([]);
      // Git's own update runs the canaries, so the oracle runs after the canary checks.
      const oracle = oracleOf(b, "oracle-copy", pre);
      expect({ oracle: oracle.exitCode, state: f29State(b) }).toEqual({ oracle: 0, state: oracleExcept(oracle, { keep: before, rows: [["solo", "solo"]] }) });
    });
  });

  updateCase(`F27 unreachable-target: a listed hook that changes during the first fetch ends the row refused with programs and fetched; no checkout starts, the hook never runs, and the outcome is completed-with-effects`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-fetch-program", "unreachable-target");
    const sup = superOf(b);
    const ran = join(b.root, "hook-ran.txt");
    // Git's own update runs the hook, so the oracle runs before the hook exists.
    const oracle = oracleOf(b, "oracle-copy");
    const head = headOf(b, join(sup, "solo"))!;
    const hook = put(moduleDirOf(b, sup, "solo"), "hooks/post-checkout", `#!/bin/sh\n: > '${ran.replaceAll("\\", "/")}'\n`);
    return withFixture(b, "t223-fetch-program", async (service) => {
      await update();
      const { repositoryId, r } = await reviewedOk(service, sup);
      const release = service.runner.holdStart(once((c) => isAt(sup, "solo")(c) && commandOf(c.arguments)[0] === "fetch"));
      const from = service.runner.calls.length;
      const requestId = sendUpdate(service, repositoryId, r);
      // The held step blocks the update. A response first means that the step never started.
      await until(() => callsSince(service, from).some((c) => isAt(sup, "solo")(c) && commandOf(c.arguments)[0] === "fetch") || service.responseAt.has(requestId), "first fetch", TIMEOUT_MS);
      expect(callsSince(service, from).some((c) => isAt(sup, "solo")(c) && commandOf(c.arguments)[0] === "fetch")).toBe(true);
      writeFileSync(hook, `${readFileSync(hook, "utf8")}# changed\n`);
      release();
      const response = await service.response(requestId);
      const row = resultOf(response, "solo");
      expect({ state: row.state, reason: row.reason, fetched: row.fetched, checkout: callsSince(service, from).filter((c) => cmd(c) === CHECKOUT("solo").join(" ")).length, ran: existsSync(ran) }).toEqual({
        state: "refused",
        reason: "programs",
        fetched: true,
        checkout: 0,
        ran: false,
      });
      expect({ outcome: outcome(response), mid: resultOf(response, "mid").state }).toEqual({ outcome: { state: "completed-with-effects", code: "COMPLETED_WITH_EFFECTS" }, mid: "cloned" });
      expectOracle(b, oracle, 0, { heads: { solo: head } });
    });
  });

  updateCase(`F29 copy with submodule.active in mid: a changed fsmonitor canary before the nested active-set read refuses every row of that level with programs; no ls-files starts there, and the parent row keeps its state`, SHELL, () => {
    const b = buildF29(gitPath(), "t223-nested-active", "base");
    const sup = superOf(b);
    const midDir = join(b.root, (b.facts.notes.programs as Record<string, string>).mid!);
    const config = join(midDir, "config");
    fixtureGit(b, b.root, ["config", "--file", config, "submodule.active", "leaf"]);
    // The canary file lies outside the superproject roots, so its program entry has the digest `unchecked` (contract §12 "Trust"). The case changes the configured value.
    const monitor = fixtureGit(b, b.root, ["config", "--file", config, "--get", "core.fsmonitor"]).trimEnd();
    const checkpoint = (c: SubmoduleCheckpoint) => {
      if (c.point === "nested-active-set" && c.path === "mid") fixtureGit(b, b.root, ["config", "--file", config, "core.fsmonitor", `${monitor} changed`]);
    };
    const before = f29State(b);
    const pre = copySuper(b, "pre-update");
    return withFixture(
      b,
      "t223-nested-active",
      async (service) => {
        const { response, from } = await updated(service, sup);
        expect(callsSince(service, from).filter((c) => isAt(sup, "mid")(c) && commandOf(c.arguments)[0] === "ls-files").map((c) => c.arguments)).toEqual([]);
        expect(resultOf(response, "mid/leaf")).toEqual(expect.objectContaining({ state: "refused", reason: "programs" }));
        expect(resultOf(response, "mid").state).toBe("moved");
        // Git's own update runs the canaries, so the oracle runs after the canary checks. It stops after the `ext` clone fails twice, before the `mid` checkout.
        const oracle = oracleOf(b, "oracle-copy", pre);
        expect({ oracle: oracle.exitCode, state: f29State(b) }).toEqual({ oracle: 1, state: oracleExcept(oracle, { keep: before, rows: [["mid/leaf"]], heads: { mid: subsOf(b).mid!.recorded } }) });
      },
      { submoduleCheckpoint: checkpoint },
    );
  });
});

describe("refusals before and during the run (contract §12 \"Refusals\", \"Update protocol\" step 5)", () => {
  // `updateSubmodules` refuses while a review refusal holds. The review still issues a token (implementer assumption).
  for (const variant of ["update-command", "remote-name"] as const) {
    updateCase(`F28 ${variant}: updateSubmodules refuses with UNSUPPORTED_SUBMODULE, no update process starts, and the canary never runs`, SHELL, () => {
      const b = buildF28(gitPath(), `t223-refuse-${variant}`, variant);
      const before = stateOf(b);
      return withFixture(b, `t223-refuse-${variant}`, async (service) => {
        await update();
        const { repositoryId } = await service.register(superOf(b));
        const r = await reviewSubmodules(service, repositoryId);
        const from = service.runner.calls.length;
        const response = await updateSubmodules(service, repositoryId, r);
        expect({ code: response.code, steps: updateSteps(service, from).length, canaries: ranCanaries(b) }).toEqual({ code: "UNSUPPORTED_SUBMODULE", steps: 0, canaries: [] });
        expect(stateOf(b)).toEqual(before);
      });
    });
  }

  updateCase(`F28 folder: updateSubmodules refuses with folder-not-empty, no process starts, and the modified and the untracked file keep their bytes`, SHELL, () => {
    const b = buildF28(gitPath(), "t223-folder", "folder");
    const folder = b.facts.notes.folder as { path: string; files: Record<string, string> };
    const before = stateOf(b);
    return withFixture(b, "t223-folder", async (service) => {
      await update();
      const { repositoryId } = await service.register(superOf(b));
      const r = await reviewSubmodules(service, repositoryId);
      const from = service.runner.calls.length;
      const response = await updateSubmodules(service, repositoryId, r);
      expect({ code: response.code, reasons: refusalsOf(response).map((x) => x.reason), steps: updateSteps(service, from).length }).toEqual({ code: "UNSUPPORTED_SUBMODULE", reasons: ["folder-not-empty"], steps: 0 });
      expect(Object.fromEntries(Object.keys(folder.files).map((f) => [f, fileSha256(join(superOf(b), folder.path, f))]))).toEqual(folder.files);
      expect(stateOf(b)).toEqual(before);
    });
  });

  updateCase(`F28 moved-folder: after the test moves the folder out, the update reaches the recorded commit, and the moved folder keeps every byte`, SHELL, () => {
    const b = buildF28(gitPath(), "t223-moved-folder", "moved-folder");
    const sup = superOf(b);
    const moved = join(b.root, "moved-solo");
    renameSync(join(sup, "solo"), moved);
    const bytes = workingFileDigests(moved);
    const oracle = oracleOf(b, "oracle-copy");
    return withFixture(b, "t223-moved-folder", async (service) => {
      await updated(service, sup);
      expect({ head: headOf(b, join(sup, "solo")), moved: workingFileDigests(moved) }).toEqual({ head: subsOf(b).solo!.recorded, moved: bytes });
      expectOracle(b, oracle, 0);
    });
  });

  updateCase(`F28 prune: the fetch removes the remote-tracking ref; the row ends refused with unsaved-commits and fetched, HEAD stays, no checkout starts, and the outcome is completed-with-effects`, SHELL, () => {
    const b = buildF28(gitPath(), "t223-prune", "prune");
    const sup = superOf(b);
    const prune = b.facts.notes.prune as { head: string; ref: string };
    const oracle = oracleOf(b, "oracle-copy");
    return withFixture(b, "t223-prune", async (service) => {
      const { response, from } = await updated(service, sup);
      const row = resultOf(response, "solo");
      expect({ state: row.state, reason: row.reason, fetched: row.fetched }).toEqual({ state: "refused", reason: "unsaved-commits", fetched: true });
      expect({ head: headOf(b, join(sup, "solo")), ref: prune.ref in refState(gitPath(), join(sup, "solo")).refs }).toEqual({ head: prune.head, ref: false });
      expect(callsSince(service, from).filter((c) => cmd(c) === CHECKOUT("solo").join(" ")).length).toBe(0);
      expect({ outcome: outcome(response), mid: resultOf(response, "mid").state }).toEqual({ outcome: { state: "completed-with-effects", code: "COMPLETED_WITH_EFFECTS" }, mid: "cloned" });
      expectOracle(b, oracle, 0, { heads: { solo: prune.head } });
    });
  });

  updateCase(`F28 keep: without fetch.prune, the row moves to its recorded commit`, SHELL, () => {
    const b = buildF28(gitPath(), "t223-keep", "keep");
    const oracle = oracleOf(b, "oracle-copy");
    return withFixture(b, "t223-keep", async (service) => {
      const { response } = await updated(service, superOf(b));
      expect({ state: resultOf(response, "solo").state, newCommit: resultOf(response, "solo").newCommit }).toEqual({ state: "moved", newCommit: subsOf(b).solo!.recorded });
      expectOracle(b, oracle, 0);
    });
  });

  // Contract §12 step 5 folder check: an untracked file that appears before the folder check of a `reuse` row.
  for (const [label, build] of [
    ["F27 deinit-kept reuse row", (n: string) => buildF27(gitPath(), n, "deinit-kept")],
    ["F28 moved-folder row without a kept HEAD", (n: string) => buildF28(gitPath(), n, "moved-folder")],
  ] as const) {
    updateCase(`folder re-check, ${label}: a file added after the preflight ends the row refused with folder-not-empty; no process starts for it, the file keeps its bytes, and the other rows continue`, SHELL, () => {
      const name = `t223-folder-recheck-${label.startsWith("F27") ? "kept" : "moved"}`;
      const b = build(name);
      const sup = superOf(b);
      if (b.id === "F28") renameSync(join(sup, "solo"), join(b.root, "moved-solo"));
      mkdirSync(join(sup, "solo"), { recursive: true });
      const added = join(sup, "solo", "added.txt");
      const checkpoint = (c: SubmoduleCheckpoint) => {
        if (c.point === "folder-check" && c.path === "solo") writeFileSync(added, "added after the preflight\n");
      };
      const before = stateOf(b);
      const oracle = oracleOf(b, "oracle-copy");
      return withFixture(
        b,
        name,
        async (service) => {
          const { response, from } = await updated(service, sup);
          const row = resultOf(response, "solo");
          expect({ state: row.state, reason: row.reason, text: row.text }).toEqual({ state: "refused", reason: "folder-not-empty", text: TEXTS.folderNotEmpty("solo") });
          expect(callsSince(service, from).filter((c) => c.arguments.includes(":(literal)solo") || isAt(sup, "solo")(c)).map((c) => c.arguments)).toEqual([]);
          expect(readFileSync(added, "utf8")).toBe("added after the preflight\n");
          expect(resultOf(response, "mid").state).toBe("cloned");
          expectOracle(b, oracle, 0, { keep: before, rows: [["solo", subsOf(b).solo!.name]] });
        },
        { submoduleCheckpoint: checkpoint },
      );
    });
  }

  updateCase(`F27 deinit-kept: the reuse row without a connect step runs its check reads with --git-dir and --work-tree of the kept folder, never in the superproject`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-reuse-check", "deinit-kept");
    const kept = keptOf(b, "solo");
    return withFixture(b, "t223-reuse-check", async (service) => {
      const { from } = await updated(service, superOf(b));
      const checks = callsSince(service, from).filter((c) => cmd(c) === "for-each-ref --contains=HEAD --count=1 --format=%(refname)" || cmd(c) === "rev-parse --verify -q HEAD");
      const inKept = (c: { arguments: readonly string[] }) =>
        c.arguments.some((a) => a.startsWith("--git-dir=") && relative(kept, a.slice(10)) === "") && c.arguments.some((a) => a.startsWith("--work-tree=") && relative(kept, a.slice(12)) === "");
      expect(checks.filter(inKept).length).toBeGreaterThanOrEqual(2);
      expect(checks.filter((c) => cmd(c) === "for-each-ref --contains=HEAD --count=1 --format=%(refname)" && gitLocation(c.arguments) === null).map((c) => c.arguments)).toEqual([]);
    });
  });

  updateCase(`F27 kept-remote: Cancel after the connect step leaves the row connected, and the outcome is failed-with-effects, not canceled`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-connect-cancel", "kept-remote");
    const sup = superOf(b);
    // Git's own connect step in a copy: the step command that the row runs first.
    const copy = copySuper(b, "connect-copy");
    const connect = Bun.spawnSync([fixtureGitPath(gitPath()), "--no-lazy-fetch", "-c", "fetch.recurseSubmodules=no", ...CHECKOUT("solo")], { cwd: copy, env: fixtureEnv(globalEnv(b)), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(connect.exitCode).toBe(128);
    const connected = stateOf(b, copy);
    const oracle = oracleOf(b, "oracle-copy");
    return withFixture(b, "t223-connect-cancel", async (service) => {
      await update();
      const { repositoryId, r } = await reviewedOk(service, sup);
      const release = service.runner.holdStart(once((c) => isAt(sup, "solo")(c) && commandOf(c.arguments)[0] === "fetch"));
      const from = service.runner.calls.length;
      const requestId = sendUpdate(service, repositoryId, r);
      // The held step blocks the update. A response first means that the step never started.
      await until(() => callsSince(service, from).some((c) => isAt(sup, "solo")(c) && commandOf(c.arguments)[0] === "fetch") || service.responseAt.has(requestId), "first fetch", TIMEOUT_MS);
      expect(callsSince(service, from).some((c) => isAt(sup, "solo")(c) && commandOf(c.arguments)[0] === "fetch")).toBe(true);
      await service.cancel(await service.operationId(requestId));
      release();
      const response = await service.response(requestId);
      expect({ outcome: outcome(response), connected: resultOf(response, "solo").connected }).toEqual({ outcome: { state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" }, connected: true });
      // The rows before `solo` end as in Git's own update. The `solo` row ends as after Git's own connect step.
      expectOracle(b, oracle, 0, { keep: connected, rows: [["solo", "solo"]] });
    });
  });

  for (const variant of ["gitdir-extension", "gitdir-outside", "gitdir-nested"] as const satisfies readonly F29Variant[]) {
    updateCase(`F29 ${variant}: the update refuses with gitdir-config and its update command; no process starts, confirmRun never goes out, and no canary runs`, SHELL, () => {
      const b = buildF29(gitPath(), `t223-${variant}`, variant);
      const sup = superOf(b);
      const path = b.facts.notes.gitdirConfig as string | undefined;
      const before = f29State(b);
      return withFixture(b, `t223-${variant}`, async (service) => {
        await update();
        const { repositoryId } = await service.register(sup);
        const r = await reviewSubmodules(service, repositoryId);
        const from = service.runner.calls.length;
        const response = await updateSubmodules(service, repositoryId, r);
        const refusal = refusalsOf(response).find((x) => x.reason === "gitdir-config");
        expect({ code: response.code, text: refusal?.text, command: refusal?.remedy?.command ?? null }).toEqual({ code: "UNSUPPORTED_SUBMODULE", text: TEXTS.gitdirConfig, command: updateCommand(sup, path) });
        expect({ steps: updateSteps(service, from).length, confirmRuns: confirmRuns(service).length, canaries: ranCanaries(b) }).toEqual({ steps: 0, confirmRuns: 0, canaries: [] });
        expect(f29State(b)).toEqual(before);
      });
    });
  }

  updateCase(`F29 base: the ext:: row fails, its canary never runs, and the row carries an outputTail and the clone remedy`, SHELL, () => {
    const b = buildF29(gitPath(), "t223-ext", "base");
    const sup = superOf(b);
    return withFixture(b, "t223-ext", async (service) => {
      const { response } = await updated(service, sup);
      const row = resultOf(response, "ext");
      expect({ state: row.state, tail: typeof row.outputTail, remedy: row.remedy }).toEqual({ state: "failed", tail: "string", remedy: { command: cloneRemedy(sup, "ext"), text: STEP_TEXT.clone } });
      // Feature 004 contract Δ12: the runner end gives the nonzero exit code of the failed clone step.
      expect({ exitCode: typeof row.exitCode, nonzero: (row.exitCode ?? 0) > 0 }).toEqual({ exitCode: "number", nonzero: true });
      expect(canaryLines(b, "ext-url")).toEqual([]);
    });
  });

  updateCase(`F29 base without protocol.file.allow: a file clone row and a fetching row fail, each with the stderr line of Git's own update in its outputTail (research.md R14 S21)`, SHELL, () => {
    const b = buildF29(gitPath(), "t223-no-file", "base");
    const sup = superOf(b);
    // Git's own update of each row in a copy, with the same owned global file.
    const copy = copySuper(b, "oracle-no-file");
    const noFile = { GIT_CONFIG_GLOBAL: join(b.root, b.facts.notes.globalNoFile as string) };
    const own = (args: string[], cwd: string, env = {}) => Bun.spawnSync([fixtureGitPath(gitPath()), "-c", "core.fsmonitor=false", ...args], { cwd, env: fixtureEnv({ ...noFile, ...env }), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const lines = (text: string) => text.split(/\r?\n/).filter((l) => l !== "" && !l.includes(copy.replaceAll("\\", "/")) && !l.includes(copy));
    // The clone row runs Git's own `submodule update`. The fetching row runs its own fetch steps, so its tail holds the fallback fetch of Git's own update without the `submodule--helper` lines.
    // git-submodule.sh sets `GIT_PROTOCOL_FROM_USER=0` for that fetch (contract §12 "Environment and console").
    const expected = {
      solo: lines(own(["submodule", "update", "--init", "--", "solo"], copy).stderr.toString()),
      mid: lines(own(["fetch", "origin", subsOf(b).mid!.recorded], join(copy, "mid"), { GIT_PROTOCOL_FROM_USER: "0" }).stderr.toString()),
    };
    expect({ solo: expected.solo.length > 0, mid: expected.mid.length > 0 }).toEqual({ solo: true, mid: true });
    return withFixture(
      b,
      "t223-no-file",
      async (service) => {
        const { response } = await updated(service, sup);
        for (const path of ["solo", "mid"] as const) {
          const row = resultOf(response, path);
          expect({ path, state: row.state }).toEqual({ path, state: "failed" });
          for (const line of expected[path]) expect({ path, line, inTail: (row.outputTail ?? "").split("\n").includes(line) }).toEqual({ path, line, inTail: true });
        }
      },
      {},
      "globalNoFile",
    );
  });

  updateCase(`F29 base: the hook URL token appears only as <redacted>, never in a log, a diagnostic, or a progress event`, SHELL, () => {
    const b = buildF29(gitPath(), "t223-hook-token", "base");
    return withFixture(b, "t223-hook-token", async (service) => {
      await updated(service, superOf(b));
      for (const [where, value] of [
        ["responses", service.responses],
        ["log", service.log()],
        ["progress", service.progress],
      ] as const)
        expect({ where, token: JSON.stringify(value).includes("TOKEN") }).toEqual({ where, token: false });
    });
  });

  updateCase(`F28 blocked: the blocked row states failed with its HEAD and edit intact, the other row moves, every process runs, and the outcome is failed-with-effects`, SHELL, () => {
    const b = buildF28(gitPath(), "t223-blocked", "blocked");
    const sup = superOf(b);
    const blocked = b.facts.notes.blocked as { path: string; edited: string; moves: string };
    const head = headOf(b, join(sup, blocked.path));
    const edit = fileSha256(join(sup, blocked.path, blocked.edited));
    const oracle = oracleOf(b, "oracle-copy");
    return withFixture(b, "t223-blocked", async (service) => {
      const { response, from } = await updated(service, sup);
      expect(outcome(response)).toEqual({ state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" });
      const row = resultOf(response, blocked.path);
      expect({ state: row.state, head: headOf(b, join(sup, blocked.path)), edit: fileSha256(join(sup, blocked.path, blocked.edited)) }).toEqual({ state: "failed", head, edit });
      expect(row.remedy).toEqual({ command: checkoutRemedy(sup, blocked.path), text: STEP_TEXT.checkout });
      expect(resultOf(response, blocked.moves).state).toBe("moved");
      expect(callsSince(service, from).filter((c) => cmd(c) === CHECKOUT(blocked.path).join(" ")).length).toBe(1);
      expectOracle(b, oracle, 1);
    });
  });

  updateCase(`F28 unregistered-block: the row ends failed with registered, and the outcome is failed-with-effects`, SHELL, () => {
    const b = buildF28(gitPath(), "t223-registered", "unregistered-block");
    const oracle = oracleOf(b, "oracle-copy");
    return withFixture(b, "t223-registered", async (service) => {
      const { response } = await updated(service, superOf(b));
      const row = resultOf(response, "solo");
      expect({ state: row.state, registered: row.registered, outcome: outcome(response) }).toEqual({ state: "failed", registered: true, outcome: { state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" } });
      expectOracle(b, oracle, 1);
    });
  });

  updateCase(`nested registered: a nested clone that registers and then fails carries registered against its level-read baseline`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-nested-registered", "base");
    const sup = superOf(b);
    // A new `mid` commit whose `.gitmodules` URL of `leaf` names a missing folder. The superproject records it.
    const midSrc = join(b.root, "src", "mid");
    fixtureGit(b, midSrc, ["config", "--file", ".gitmodules", "submodule.leaf.url", "../missing-leaf.git"]);
    // The source has no `leaf` folder, so `commit -a` would drop the `leaf` gitlink.
    fixtureGit(b, midSrc, ["add", "--", ".gitmodules"]);
    fixtureGit(b, midSrc, ["commit", "-q", "-m", "missing leaf"]);
    fixtureGit(b, midSrc, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    const mid = fixtureGit(b, midSrc, ["rev-parse", "HEAD"]).trim();
    ownedGit(gitPath(), FIXTURE_ROOT, sup, ["update-index", "-z", "--index-info"], { input: Buffer.from(`160000 ${mid} 0\tmid\0`) });
    fixtureGit(b, sup, ["commit", "-q", "-m", "record mid"]);
    const oracle = oracleOf(b, "oracle-copy");
    return withFixture(b, "t223-nested-registered", async (service) => {
      const { response } = await updated(service, sup);
      const leaf = resultOf(response, "mid/leaf");
      expect({ state: leaf.state, registered: leaf.registered, found: leaf.found }).toEqual({ state: "failed", registered: true, found: true });
      expectOracle(b, oracle, 1);
    });
  });

  updateCase(`a run whose only row ends refused without a change gives completed-with-effects`, SHELL, () => {
    const w = miniWorld("t223-only-refused", [{ name: "solo", path: "solo", url: "../solo.git", at: "second" }]);
    miniGit(w, w.sup.dir, ["submodule", "update", "--init", "-q", "--", "solo"]);
    miniGit(w, join(w.sup.dir, "solo"), ["checkout", "-q", "--detach", w.solo.first]);
    const hook = put(resolve(w.sup.dir, miniGit(w, w.sup.dir, ["rev-parse", "--git-path", "modules/solo"]).trim()), "hooks/post-checkout", "#!/bin/sh\nexit 0\n");
    const sup = w.sup.dir;
    const before = submoduleState(gitPath(), sup, w.env);
    return withMini(w, "t223-only-refused", async (service) => {
      await update();
      const { repositoryId, r } = await reviewedOk(service, sup);
      // The third `rev-parse --verify -q HEAD` in `solo` is the step 5 check: the preflight and the step 3 re-check run it first.
      // The double checks one call more than once, so the count keeps each call object once.
      const seen = new Set<object>();
      const release = service.runner.holdStart((c) => {
        if (isAt(sup, "solo")(c) && cmd(c) === "rev-parse --verify -q HEAD") seen.add(c);
        return seen.size === 3 && [...seen].at(-1) === c;
      });
      const from = service.runner.calls.length;
      const requestId = sendUpdate(service, repositoryId, r);
      // The held step blocks the update. A response first means that the step never started.
      await until(() => seen.size >= 3 || service.responseAt.has(requestId), "step 5 check", TIMEOUT_MS);
      expect(seen.size >= 3).toBe(true);
      writeFileSync(hook, "#!/bin/sh\nexit 1\n");
      release();
      const response = await service.response(requestId);
      expect({ outcome: outcome(response), rows: resultsOf(response).map((x) => [x.path, x.state, x.reason]), checkout: callsSince(service, from).filter((c) => cmd(c) === CHECKOUT("solo").join(" ")).length }).toEqual({
        outcome: { state: "completed-with-effects", code: "COMPLETED_WITH_EFFECTS" },
        rows: [["solo", "refused", "programs"]],
        checkout: 0,
      });
      expect(submoduleState(gitPath(), sup, w.env)).toEqual(before);
    });
  });

  // research.md R14 S38: Git dies on such an entry before a write. The review refuses only rows, so the run fails.
  // Contract §12 "Refusals": the started clone step sets `connected`, which is an effect.
  for (const value of ["!true", "foo"]) {
    caseTest("T230", `F27 update-none with an unmapped .gitmodules entry whose update is ${value}: the review passes, the clone and register rows fail, no submodule.* key appears, and the started clone step makes the outcome failed-with-effects`, SHELL, () => {
      const name = `t230-unmapped-update-${value === "foo" ? "foo" : "command"}`;
      const b = buildF27(gitPath(), name, "update-none");
      const sup = superOf(b);
      for (const [key, v] of [
        ["path", "ghost"],
        ["url", "../ghost.git"],
        ["update", value],
      ])
        fixtureGit(b, sup, ["config", "--file", ".gitmodules", `submodule.ghost.${key}`, v!]);
      const keys = () => fixtureGit(b, sup, ["config", "--local", "--get-regexp", "^submodule\\."], [0, 1]);
      expect(keys()).toBe("");
      const oracle = oracleOf(b, "oracle-copy");
      return withFixture(b, name, async (service) => {
        const { repositoryId, r } = await reviewedOk(service, sup);
        expect(r.rows.map((x) => [x.path, x.action]).sort()).toEqual([
          ["mid", "clone"],
          ["solo", "skip"],
        ]);
        await update();
        const response = await updateSubmodules(service, repositoryId, r);
        expect({ outcome: outcome(response), rows: resultsOf(response).map((x) => [x.path, x.state, x.connected, x.registered]).sort(), keys: keys() }).toEqual({
          outcome: { state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" },
          rows: [
            ["mid", "failed", true, false],
            ["solo", "failed", false, false],
          ],
          keys: "",
        });
        expectOracle(b, oracle, 128);
      });
    }, TIMEOUT_MS);
  }
});

// One service with the owned global file of a mini world.
function withMini(w: MiniWorld, name: string, body: (service: Service) => Promise<void>, options: Parameters<typeof withFixture>[3] = {}): Promise<void> {
  const b: Built = { id: "mini", variant: name, root: w.root, facts: { repos: {}, canaries: {}, disarm: [], notes: { globalConfig: relative(w.root, w.env.GIT_CONFIG_GLOBAL) } } };
  return withFixture(b, name, body, options);
}

describe("clone check, register step, and clone recursion (contract §12 \"Update protocol\" step 5)", () => {
  for (const withCommit of [true, false]) {
    updateCase(`clone check: another Git process sets up the clone row before its clone step${withCommit ? " and commits on its HEAD; the row ends refused with unsaved-commits, the found-folder text, and no command" : "; the row ends refused with changed-after-review"}, no process starts for it, and the canary never runs`, SHELL, () => {
      const name = `t223-clone-check-${withCommit ? "commit" : "plain"}`;
      const b = buildF27(gitPath(), name, "base");
      const sup = superOf(b);
      const ran = join(b.root, "found-hook.txt");
      let commit = "";
      const checkpoint = (c: SubmoduleCheckpoint) => {
        if (c.point !== "clone-check" || c.path !== "solo") return;
        fixtureGit(b, sup, ["submodule", "update", "--init", "-q", "--", "solo"]);
        const solo = join(sup, "solo");
        if (withCommit) {
          put(solo, "local.txt", "local\n");
          fixtureGit(b, solo, ["add", "--", "local.txt"]);
          fixtureGit(b, solo, ["commit", "-q", "-m", "local"]);
        }
        commit = headOf(b, solo)!;
        put(moduleDirOf(b, sup, "solo"), "hooks/post-checkout", `#!/bin/sh\n: > '${ran.replaceAll("\\", "/")}'\n`);
      };
      const oracle = oracleOf(b, "oracle-copy");
      return withFixture(
        b,
        name,
        async (service) => {
          const { response, from } = await updated(service, sup);
          const row = resultOf(response, "solo");
          expect({ state: row.state, reason: row.reason, text: row.text, command: row.remedy?.command ?? null }).toEqual(
            withCommit ? { state: "refused", reason: "unsaved-commits", text: TEXTS.foundFolder("solo", commit), command: null } : { state: "refused", reason: "changed-after-review", text: TEXTS.changedAfterReview("solo"), command: null },
          );
          expect({ steps: updateSteps(service, from).filter((c) => c.arguments.includes(":(literal)solo") || isAt(sup, "solo")(c)).length, ran: existsSync(ran), head: headOf(b, join(sup, "solo")) }).toEqual({ steps: 0, ran: false, head: commit });
          expectOracle(b, oracle, 0, { heads: { solo: commit } });
        },
        { submoduleCheckpoint: checkpoint },
      );
    });
  }

  updateCase(`F27 update-none: the row runs submodule init -- :(literal)solo and no clone, and its submodule.* keys equal Git's own update`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-register", "update-none");
    const sup = superOf(b);
    const oracle = oracleOf(b, "oracle-copy");
    return withFixture(b, "t223-register", async (service) => {
      const { from } = await updated(service, sup);
      const solo = updateSteps(service, from).filter((c) => c.arguments.includes(":(literal)solo"));
      expect(solo.map((c) => commandOf(c.arguments))).toEqual([["submodule", "init", "--", ":(literal)solo"]]);
      expectOracle(b, oracle, 0);
    });
  });

  updateCase(`F27 update-none with submodule.active excluding the row: no process starts for it`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-register-inactive", "update-none");
    const sup = superOf(b);
    fixtureGit(b, sup, ["config", "submodule.active", "mid"]);
    const oracle = oracleOf(b, "oracle-copy");
    return withFixture(b, "t223-register-inactive", async (service) => {
      const { from } = await updated(service, sup);
      expect(updateSteps(service, from).filter((c) => c.arguments.includes(":(literal)solo")).map((c) => c.arguments)).toEqual([]);
      expectOracle(b, oracle, 0);
    });
  });

  updateCase(`F27 headless-kept: the clone step passes -c fetch.recurseSubmodules=no, the nested kept canary does not run before the steps of the nested row, and the result equals Git's own update`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-headless", "headless-kept");
    const sup = superOf(b);
    // Git's own update runs the nested hook (research.md R14 S27), so the oracle runs after the canary check.
    const pre = copySuper(b, "pre-update");
    return withFixture(b, "t223-headless", async (service) => {
      await update();
      const { repositoryId, r } = await reviewedOk(service, sup);
      const from = service.runner.calls.length;
      // The steps of the nested `leaf` row reuse its kept Git folder and run its hooks, as Git's own update does.
      const leafStep = (c: { arguments: readonly string[] }) => c.arguments.includes(":(literal)leaf");
      const release = service.runner.holdStart(once(leafStep));
      const requestId = sendUpdate(service, repositoryId, r);
      // The held step blocks the update. A response first means that the step never started.
      await until(() => callsSince(service, from).some(leafStep) || service.responseAt.has(requestId), "first leaf step", TIMEOUT_MS);
      expect(callsSince(service, from).some(leafStep)).toBe(true);
      expect(ranCanaries(b)).toEqual([]);
      release();
      await service.response(requestId);
      const clone = updateSteps(service, from).find((c) => c.arguments.includes(":(literal)mid"))!;
      expect(clone.arguments.slice(0, 3)).toEqual(["--no-lazy-fetch", "-c", "fetch.recurseSubmodules=no"]);
      expectOracle(b, oracleOf(b, "oracle-copy", pre), 0);
    });
  });
});

describe("read failures (contract §12 \"Update protocol\" step 5)", () => {
  // Injects `code` into the `nth` call that `match` accepts after the update starts.
  function injectNth(service: Service, match: (args: readonly string[]) => boolean, nth: number, code: number, armed: { on: boolean }): void {
    let seen = 0;
    service.runner.inject.exit = (call) => (armed.on && match(call.arguments) && ++seen === nth ? code : undefined);
  }

  // Each variant sends the run confirmation. So the preflight and the step 3 re-check run each check read first, and the third call is the step 5 check.
  for (const [i, [read, variant, command, nth, failedRead]] of ([
    ["for-each-ref", "behind-present", "for-each-ref --contains=HEAD --count=1 --format=%(refname)", 3, "check"],
    ["remote get-url", "kept-remote", "remote get-url --all -- good", 1, "remote-get-url"],
    ["rev-parse --verify -q HEAD (exit 128)", "behind-present", "rev-parse --verify -q HEAD", 3, "check"],
  ] as const).entries()) {
    updateCase(`an injected non-zero exit of ${read} ends the row failed with the read name, and no later process starts for it`, SHELL, () => {
      const name = `t223-read-${i}`;
      const b = buildF27(gitPath(), name, variant);
      const sup = superOf(b);
      const oracle = oracleOf(b, "oracle-copy");
      // In kept-remote, the connect step checks out the HEAD of the kept folder.
      const head = variant === "kept-remote" ? fixtureGit(b, sup, ["--git-dir", keptOf(b, "solo"), "rev-parse", "HEAD"]).trim() : headOf(b, join(sup, "solo"))!;
      return withFixture(b, name, async (service) => {
        await update();
        const { repositoryId, r } = await reviewedOk(service, sup);
        const armed = { on: true };
        injectNth(service, (args) => at(sup, args) === "solo" && commandOf(args).join(" ") === command, nth, 128, armed);
        const from = service.runner.calls.length;
        const response = await updateSubmodules(service, repositoryId, r);
        const row = resultOf(response, "solo");
        expect({ confirmRuns: confirmRuns(service).length, state: row.state, failedRead: row.failedRead, remedy: row.remedy }).toEqual({ confirmRuns: 1, state: "failed", failedRead, remedy: undefined });
        const failedAt = callsSince(service, from).findIndex((c) => c.exit?.exitCode === 128 && cmd(c) === command);
        expect(callsSince(service, from).slice(failedAt + 1).filter((c) => c.arguments.includes(":(literal)solo") || isAt(sup, "solo")(c)).filter((c) => commandOf(c.arguments)[0] !== "rev-parse" && commandOf(c.arguments)[0] !== "for-each-ref" && commandOf(c.arguments)[0] !== "config" && commandOf(c.arguments)[0] !== "symbolic-ref" && commandOf(c.arguments)[0] !== "show-ref").map(cmd)).toEqual([]);
        expectOracle(b, oracle, 0, { heads: { solo: head } });
      });
    });
  }

  updateCase(`F27 deinit-kept: a test-injected error of the run-time folder read ends the reuse row failed with the read name folder`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-read-folder", "deinit-kept");
    const sup = superOf(b);
    const folder = join(sup, "solo");
    let armed = false;
    const before = stateOf(b);
    const oracle = oracleOf(b, "oracle-copy");
    return withFixture(
      b,
      "t223-read-folder",
      async (service) => {
        await update();
        const { repositoryId, r } = await reviewedOk(service, sup);
        const { value: response } = await withFsCalls(
          () => updateSubmodules(service, repositoryId, r),
          (call) => {
            if (armed && relative(folder, call.path) === "") throw Object.assign(new Error(`EACCES: ${call.path}`), { code: "EACCES" });
          },
        );
        const row = resultOf(response, "solo");
        expect({ state: row.state, failedRead: row.failedRead }).toEqual({ state: "failed", failedRead: "folder" });
        expectOracle(b, oracle, 0, { keep: before, rows: [["solo", subsOf(b).solo!.name]] });
      },
      { submoduleCheckpoint: (c) => void (c.point === "folder-check" && c.path === "solo" && (armed = true)) },
    );
  });

  updateCase(`F27 behind-present: an injected rev-list exit 128 makes the row fetch, as Git's is_tip_reachable does`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-read-rev-list", "behind-present");
    const sup = superOf(b);
    const oracle = oracleOf(b, "oracle-copy");
    return withFixture(b, "t223-read-rev-list", async (service) => {
      await update();
      service.runner.inject.exit = (call) => (commandOf(call.arguments)[0] === "rev-list" ? 128 : undefined);
      const { repositoryId, r } = await reviewedOk(service, sup);
      expect(rowOf(r, "solo").action).toBe("fetch-checkout");
      const from = service.runner.calls.length;
      await updateSubmodules(service, repositoryId, r);
      expect(callsSince(service, from).filter((c) => isAt(sup, "solo")(c) && cmd(c) === FETCH.join(" ")).length).toBe(1);
      expectOracle(b, oracle, 0);
    });
  });

  updateCase(`F27 base: a failed level read of mid ends its listed nested row failed; the parent row keeps its state, and the outcome is failed-with-effects`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-read-level", "base");
    const sup = superOf(b);
    const before = stateOf(b);
    const oracle = oracleOf(b, "oracle-copy");
    return withFixture(b, "t223-read-level", async (service) => {
      await update();
      const { repositoryId, r } = await reviewedOk(service, sup);
      service.runner.inject.exit = (call) => (at(sup, call.arguments) === "mid" && commandOf(call.arguments)[0] === "config" && commandOf(call.arguments)[1] === "--blob" ? 128 : undefined);
      const response = await updateSubmodules(service, repositoryId, r);
      expect({ leaf: resultOf(response, "mid/leaf").state, read: resultOf(response, "mid/leaf").failedRead, mid: resultOf(response, "mid").state, outcome: outcome(response) }).toEqual({
        leaf: "failed",
        read: "level",
        mid: "cloned",
        outcome: { state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" },
      });
      // The `leaf` keys live in the `mid` configuration, so the row has no superproject key.
      expectOracle(b, oracle, 0, { keep: before, rows: [["mid/leaf"]] });
    });
  });
});

// Contract §12 "Review reads": `--git-dir=.git` follows `-C <submodule worktree>`. Without it, Git discovery from a `.git` folder that Git refuses finds the superproject.
describe("submodule repository targets (contract §12 \"Review reads\", \"Update protocol\" step 5)", () => {
  const superGitDir = (b: Built) => fixtureGit(b, superOf(b), ["rev-parse", "--absolute-git-dir"]);
  const succeededIn = (service: Service, sup: string, from: number, path: string) => callsSince(service, from).filter((c) => isAt(sup, path)(c) && c.exit?.exitCode === 0).map(cmd);

  caseTest("T231", `a .git folder whose HEAD is not valid, found by the clone check: no read in it succeeds, no step starts for the row, and the failed reconciliation read gives unknown`, SHELL, () => {
    const b = buildF27(gitPath(), "t231-clone-check-git", "base");
    const sup = superOf(b);
    const checkpoint = (c: SubmoduleCheckpoint) => void (c.point === "clone-check" && c.path === "solo" && invalidGitFolder(join(sup, "solo")));
    return withFixture(
      b,
      "t231-clone-check-git",
      async (service) => {
        const { response, from } = await updated(service, sup);
        expect(fixtureGit(b, join(sup, "solo"), ["rev-parse", "--absolute-git-dir"])).toBe(superGitDir(b));
        expect({
          outcome: outcome(response),
          reads: callsSince(service, from).some(isAt(sup, "solo")),
          succeeded: succeededIn(service, sup, from, "solo"),
          steps: updateSteps(service, from).filter((c) => c.arguments.includes(":(literal)solo")).length,
        }).toEqual({ outcome: { state: "unknown", code: "STATE_UNKNOWN" }, reads: true, succeeded: [], steps: 0 });
      },
      { submoduleCheckpoint: checkpoint },
    );
  }, TIMEOUT_MS);

  caseTest("T231", `a mid .git folder whose HEAD is not valid at its level read: no read in it succeeds, no step starts for the nested row, and the failed reconciliation read gives unknown`, SHELL, () => {
    const b = buildF27(gitPath(), "t231-level-git", "base");
    const sup = superOf(b);
    return withFixture(b, "t231-level-git", async (service) => {
      await update();
      const { repositoryId, r } = await reviewedOk(service, sup);
      const from = service.runner.calls.length;
      // The first call in `mid` is the level read after the clone step.
      const inMid = isAt(sup, "mid");
      const release = service.runner.holdStart(once(inMid));
      const requestId = sendUpdate(service, repositoryId, r);
      // The held step blocks the update. A response first means that the step never started.
      await until(() => callsSince(service, from).some(inMid) || service.responseAt.has(requestId), "mid level read", TIMEOUT_MS);
      expect(callsSince(service, from).some(inMid)).toBe(true);
      rmSync(join(sup, "mid", ".git"));
      invalidGitFolder(join(sup, "mid"));
      expect(fixtureGit(b, join(sup, "mid"), ["rev-parse", "--absolute-git-dir"])).toBe(superGitDir(b));
      release();
      const response = await service.response(requestId);
      expect({
        outcome: outcome(response),
        succeeded: succeededIn(service, sup, from, "mid"),
        steps: updateSteps(service, from).filter((c) => c.arguments.includes(":(literal)leaf")).length,
      }).toEqual({ outcome: { state: "unknown", code: "STATE_UNKNOWN" }, succeeded: [], steps: 0 });
    });
  }, TIMEOUT_MS);
});

// Contract §2 and §9: each handler validates its payload and its targets before any Git process starts.
describe("admission (contract §2, §9)", () => {
  caseTest("T231", `a bad payload, a snapshot or review of another workspace, and an old generation refuse reviewSubmodules and updateSubmodules, and no Git process starts`, SHELL, () => {
    const b = buildF27(gitPath(), "t231-admission", "base");
    const sup = superOf(b);
    const other = join(b.root, "other");
    fixtureGit(b, sup, ["worktree", "add", "-q", "--detach", other]);
    // Contract §6 "Registration reuse and release": the seam keeps `other` registered, so its review token stays live.
    return withKeptWorkspaces(() => withFixture(b, "t231-admission", async (service) => {
      await update();
      const o = await reviewedOk(service, other);
      const a = await reviewedOk(service, sup);
      const refused = async (operation: string, payload: object, generation: number) => {
        const from = service.runner.calls.length;
        const response = await service.request(operation, payload, { repositoryId: a.repositoryId, repositoryGeneration: generation });
        return { ...outcome(response), runs: service.runner.calls.length - from };
      };
      const token = (r: SubmoduleReview) => ({ submoduleReviewToken: r.token, start: true });
      const rejected = (code: string) => ({ state: "rejected", code, runs: 0 });
      // Both reviews have one generation, so only the repositoryId binding refuses the snapshot and the review of `other`.
      expect(o.r.read.generation).toBe(a.r.read.generation);
      const others = {
        reviewOther: await refused("reviewSubmodules", { snapshotId: o.r.read.snapshotId }, a.r.read.generation),
        updateOther: await refused("updateSubmodules", token(o.r), a.r.read.generation),
      };
      put(sup, "super.txt", "changed\n");
      const now = await readOk(service, a.repositoryId);
      expect(now.generation).toBeGreaterThan(a.r.read.generation);
      expect({
        reviewPayload: await refused("reviewSubmodules", { snapshotId: now.snapshotId, start: true }, now.generation),
        reviewOther: others.reviewOther,
        reviewOld: await refused("reviewSubmodules", { snapshotId: a.r.read.snapshotId }, a.r.read.generation),
        updatePayload: await refused("updateSubmodules", { ...token(a.r), start: false }, now.generation),
        updateOther: others.updateOther,
        updateOld: await refused("updateSubmodules", token(a.r), a.r.read.generation),
      }).toEqual({
        reviewPayload: rejected("INVALID_REQUEST"),
        reviewOther: rejected("UNKNOWN_TARGET"),
        reviewOld: rejected("REPOSITORY_CHANGED"),
        updatePayload: rejected("INVALID_REQUEST"),
        updateOther: rejected("UNKNOWN_TARGET"),
        updateOld: rejected("REPOSITORY_CHANGED"),
      });
    }));
  }, TIMEOUT_MS);

  // T115, contract §8 "Token invalidation": an equal observation keeps the generation, so acceptance sees a released token.
  caseTest("T115", `a review token that a refresh: true readWorkspace invalidated without a change gives UNKNOWN_TARGET at acceptance, and no Git process starts`, SHELL, () => {
    const b = buildF27(gitPath(), "t115-refreshed", "base");
    return withFixture(b, "t115-refreshed", async (service) => {
      await update();
      const a = await reviewedOk(service, superOf(b));
      const read = await service.readWorkspace(a.repositoryId, { refresh: true, check: "full" });
      expect({ ...outcome(read), generation: read.result?.generation }).toEqual({ ...SUCCEEDED, generation: a.r.read.generation });
      const from = service.runner.calls.length;
      const response = await service.request("updateSubmodules", { submoduleReviewToken: a.r.token, start: true }, { repositoryId: a.repositoryId, repositoryGeneration: a.r.read.generation });
      expect({ ...outcome(response), runs: service.runner.calls.length - from }).toEqual({ state: "rejected", code: "UNKNOWN_TARGET", runs: 0 });
    });
  }, TIMEOUT_MS);
});

describe("quoting (contract §4 \"Quoting rule\", §12 \"Remedies\")", () => {
  const QUOTE = "it's";
  // Runs a remedy command in each PowerShell that the host has. The environment holds the owned global file.
  // Each run starts only when the loop asks for it, so the loop body resets the state before the next shell runs.
  function* inPowerShell(w: MiniWorld, command: string): Generator<{ shell: string; exitCode: number; stdout: string }> {
    for (const shell of ["pwsh", "powershell"].filter((s) => Bun.which(s) !== null)) {
      const p = Bun.spawnSync([shell, "-NoProfile", "-NonInteractive", "-Command", command], { cwd: w.root, env: fixtureEnv(w.env), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      yield { shell, exitCode: p.exitCode, stdout: p.stdout.toString() };
    }
  }

  updateCase(`a submodule path and a kept Git folder with a single quote: the unsaved-commits remedy stays literal in a PowerShell run`, [...SHELL, "powershell"], () => {
    const w = miniWorld("t223-quote-unsaved", [
      { name: QUOTE, path: QUOTE, url: "../solo.git" },
      { name: `kept ${QUOTE}`, path: `kept ${QUOTE}`, url: "../solo.git" },
    ]);
    const sup = w.sup.dir;
    const unsaved = (path: string) => {
      miniGit(w, sup, ["submodule", "update", "--init", "-q", "--", path]);
      put(join(sup, path), "local.txt", "local\n");
      miniGit(w, join(sup, path), ["add", "--", "local.txt"]);
      miniGit(w, join(sup, path), ["commit", "-q", "-m", "local"]);
      return miniGit(w, join(sup, path), ["rev-parse", "HEAD"]).trim();
    };
    const worktreeCommit = unsaved(QUOTE);
    // Git for Windows refuses `--git-dir=<gitfile>` with `\` separators when the gitfile holds a relative path, so the check names the Git folder that Git prints.
    const worktreeGitDir = miniGit(w, join(sup, QUOTE), ["rev-parse", "--absolute-git-dir"]).trim();
    const keptCommit = unsaved(`kept ${QUOTE}`);
    const keptDir = resolve(sup, miniGit(w, sup, ["rev-parse", "--git-path", `modules/kept ${QUOTE}`]).trim());
    miniGit(w, sup, ["submodule", "deinit", "-q", "-f", "--", `kept ${QUOTE}`]);
    return withMini(w, "t223-quote-unsaved", async (service) => {
      await update();
      const { repositoryId } = await service.register(sup);
      const r = await reviewSubmodules(service, repositoryId);
      const commands = Object.fromEntries(r.refusals.filter((x) => x.reason === "unsaved-commits").map((x) => [x.path, x.remedy?.command ?? null]));
      expect(commands).toEqual({ [QUOTE]: saveCommand({ worktree: join(sup, QUOTE) }, worktreeCommit), [`kept ${QUOTE}`]: saveCommand({ gitDir: keptDir }, keptCommit) });
      for (const [path, oid, gitDir] of [
        [QUOTE, worktreeCommit, worktreeGitDir],
        [`kept ${QUOTE}`, keptCommit, keptDir],
      ] as const) {
        for (const run of inPowerShell(w, commands[path]!)) {
          expect({ shell: run.shell, exitCode: run.exitCode }).toEqual({ shell: run.shell, exitCode: 0 });
          const branch = `refs/heads/arbareto-saved-${oid.slice(0, 12)}`;
          expect(miniGit(w, w.root, [`--git-dir=${gitDir}`, "rev-parse", "--verify", "-q", branch]).trim()).toBe(oid);
          miniGit(w, w.root, [`--git-dir=${gitDir}`, "update-ref", "-d", branch]);
        }
      }
    });
  });

  updateCase(`a failed row of a path with a single quote: its checkout remedy stays literal in a PowerShell run`, [...SHELL, "powershell"], () => {
    const w = miniWorld("t223-quote-failed", [{ name: QUOTE, path: QUOTE, url: "../solo.git" }]);
    const sup = w.sup.dir;
    const sub = join(sup, QUOTE);
    miniGit(w, sup, ["submodule", "update", "--init", "-q", "--", QUOTE]);
    miniGit(w, sub, ["checkout", "-q", "--detach", w.solo.first]);
    put(sub, "solo.txt", "edited\n");
    return withMini(w, "t223-quote-failed", async (service) => {
      const { response } = await updated(service, sup);
      const row = resultOf(response, QUOTE);
      expect({ state: row.state, remedy: row.remedy }).toEqual({ state: "failed", remedy: { command: checkoutRemedy(sup, QUOTE), text: STEP_TEXT.checkout } });
      miniGit(w, sub, ["checkout", "-q", "--", "solo.txt"]);
      for (const run of inPowerShell(w, row.remedy!.command!)) {
        expect({ shell: run.shell, exitCode: run.exitCode, head: miniGit(w, sub, ["rev-parse", "HEAD"]).trim() }).toEqual({ shell: run.shell, exitCode: 0, head: w.solo.second });
        miniGit(w, sub, ["checkout", "-q", "--detach", w.solo.first]);
      }
    });
  });

  updateCase(`a branch name with a single quote and one with U+0022: the detach note shows each branch name as plain text`, SHELL, () => {
    const branches = [`o'brien`, `a"b`];
    const w = miniWorld(
      "t223-quote-branch",
      branches.map((_, i) => ({ name: `b${i}`, path: `b${i}`, url: "../solo.git" })),
    );
    const sup = w.sup.dir;
    branches.forEach((branch, i) => {
      miniGit(w, sup, ["submodule", "update", "--init", "-q", "--", `b${i}`]);
      const sub = join(sup, `b${i}`);
      miniGit(w, sub, ["checkout", "-q", "--detach", w.solo.first]);
      // NTFS refuses U+0022 in a file name, so the branch goes into `packed-refs` in sorted order (gitrepository-layout(5)).
      const packed = join(miniGit(w, sub, ["rev-parse", "--absolute-git-dir"]).trim(), "packed-refs");
      const lines = existsSync(packed) ? readFileSync(packed, "utf8").split("\n").filter((l) => l !== "") : [];
      const header = lines.filter((l) => l.startsWith("#"));
      const refs = [...lines.filter((l) => !l.startsWith("#")), `${w.solo.first} refs/heads/${branch}`].sort((x, y) => Buffer.compare(Buffer.from(x.slice(x.indexOf(" "))), Buffer.from(y.slice(y.indexOf(" ")))));
      writeFileSync(packed, [...header, ...refs, ""].join("\n"));
      miniGit(w, sub, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
      expect(miniGit(w, sub, ["rev-parse", "--verify", "-q", "HEAD"]).trim()).toBe(w.solo.first);
    });
    return withMini(w, "t223-quote-branch", async (service) => {
      await update();
      const { r } = await reviewedOk(service, sup);
      branches.forEach((branch, i) => expect(rowOf(r, `b${i}`).notes).toContain(NOTES.detaches(branch)));
    });
  });

  // A submodule whose target needs a fetch from its only remote. The remote names a missing folder, so the first and the fallback fetch fail.
  function fallbackWorld(name: string, remote: string, path = "solo"): { w: MiniWorld; target: string } {
    const w = miniWorld(name, [{ name: path, path, url: "../solo.git", at: "first" }]);
    const sup = w.sup.dir;
    miniGit(w, sup, ["submodule", "update", "--init", "-q", "--", path]);
    const sub = join(sup, path);
    const src = join(w.root, "src");
    put(src, "solo.txt", "solo 3\n");
    miniGit(w, src, ["commit", "-q", "-a", "-m", "solo 3"]);
    miniGit(w, src, ["push", "-q", w.solo.url, "HEAD:refs/heads/main"]);
    const target = miniGit(w, src, ["rev-parse", "HEAD"]).trim();
    ownedGit(gitPath(), FIXTURE_ROOT, sup, ["update-index", "-z", "--index-info"], { input: Buffer.concat([Buffer.from(`160000 ${target} 0\t`), Buffer.from(path), Buffer.from([0])]), env: w.env });
    miniGit(w, sup, ["commit", "-q", "-m", "record"]);
    miniGit(w, sub, ["remote", "remove", "origin"]);
    // `git remote add` refuses these names, so `git config` writes the section (research.md R14 S31).
    miniGit(w, sub, ["config", `remote.${remote}.url`, `${w.root.replaceAll("\\", "/")}/missing.git`]);
    return { w, target };
  }

  for (const [label, remote, path] of [
    ["a remote name with U+0022", `a"b`, "solo"],
    ["a fallback remote name x \\ from the submodule configuration", "x \\", "solo"],
    ["a submodule path with U+201C", "origin2", "sub“q"],
  ] as const) {
    updateCase(`${label} gives no command; the row shows its text`, SHELL, () => {
      const name = `t223-no-command-${label.length}`;
      const { w } = fallbackWorld(name, remote, path);
      return withMini(w, name, async (service) => {
        const { response } = await updated(service, w.sup.dir);
        const row = resultOf(response, path);
        expect({ state: row.state, command: row.remedy?.command ?? null, text: row.remedy?.text }).toEqual({ state: "failed", command: null, text: STEP_TEXT.fetch });
      });
    });
  }

  updateCase(`fetch remedy: without protocol.file.allow, the fetch remedy of a fetching file row fails in PowerShell as Git's own fetch does, and the session keeps its GIT_PROTOCOL_FROM_USER value`, [...SHELL, "powershell"], () => {
    const { w, target } = fallbackWorld("t223-fetch-remedy", "origin");
    const sub = join(w.sup.dir, "solo");
    // The remote names the real `solo.git` again. Only the protocol rule stops the fetch.
    miniGit(w, sub, ["config", "remote.origin.url", w.solo.url]);
    const noFile = put(w.root, "no-file.gitconfig", readFileSync(FIXTURE_GLOBAL_CONFIG, "utf8"));
    const own = Bun.spawnSync([fixtureGitPath(gitPath()), "--no-lazy-fetch", "-C", sub, "fetch", "--no-recurse-submodules"], { env: fixtureEnv({ GIT_CONFIG_GLOBAL: noFile, GIT_PROTOCOL_FROM_USER: "0" }), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(own.exitCode).not.toBe(0);
    const b: Built = { id: "mini", variant: "fetch-remedy", root: w.root, facts: { repos: {}, canaries: {}, disarm: [], notes: { globalConfig: "global.gitconfig", globalNoFile: "no-file.gitconfig" } } };
    return withFixture(
      b,
      "t223-fetch-remedy",
      async (service) => {
        const { response } = await updated(service, w.sup.dir);
        const row = resultOf(response, "solo");
        // The fallback fetch failed last, so the remedy names its remote and target.
        expect(row.remedy).toEqual({ command: fetchRemedy(sub, ` -- ${q("origin")} ${q(target)}`), text: STEP_TEXT.fetch });
        for (const shell of ["pwsh", "powershell"].filter((s) => Bun.which(s) !== null)) {
          const p = Bun.spawnSync([shell, "-NoProfile", "-NonInteractive", "-Command", `$env:GIT_PROTOCOL_FROM_USER = 'kept'; ${row.remedy!.command}; "exit=$LASTEXITCODE"; "value=$env:GIT_PROTOCOL_FROM_USER"`], {
            env: fixtureEnv({ GIT_CONFIG_GLOBAL: noFile }),
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          });
          const out = p.stdout.toString().split(/\r?\n/);
          expect({ shell, exit: out.includes(`exit=${own.exitCode}`), value: out.includes("value=kept"), stderr: p.stderr.toString().replaceAll("\r\n", "\n").includes(own.stderr.toString().replaceAll("\r\n", "\n").trim()) }).toEqual({ shell, exit: true, value: true, stderr: true });
        }
      },
      {},
      "globalNoFile",
    );
  });
});

describe("lifecycle (contract §12 \"Environment and console\", §6, §2)", () => {
  updateCase(`stall: while the double reports stalled for the solo clone step, getOperation returns that step's command in stallRemedy, and no progress event holds it`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-stall", "base");
    const sup = superOf(b);
    return withFixture(b, "t223-stall", async (service) => {
      await update();
      const { repositoryId, r } = await reviewedOk(service, sup);
      const clone = (c: { arguments: readonly string[] }) => c.arguments.includes(":(literal)solo") && commandOf(c.arguments)[0] === "submodule";
      service.runner.inject.stall = clone;
      const release = service.runner.holdStart(clone);
      const requestId = sendUpdate(service, repositoryId, r);
      // The held step blocks the update. A response first means that the step never started.
      await until(() => service.runner.calls.some(clone) || service.responseAt.has(requestId), "solo clone step", TIMEOUT_MS);
      expect(service.runner.calls.some(clone)).toBe(true);
      const operationId = await service.operationId(requestId);
      const remedy = valuesOf((await service.getOperation(operationId)).result, "stallRemedy")[0] as { command?: string; text: string };
      expect(remedy).toEqual({ command: cloneRemedy(sup, "solo"), text: STEP_TEXT.clone });
      release();
      await service.response(requestId);
      expect(JSON.stringify(service.progress).includes(JSON.stringify(remedy.command).slice(1, -1))).toBe(false);
    });
  });

  updateCase(`a second mutation in the same common directory gives BUSY; the mutation frames arrive as started, ended, then resolved; a repeated request with the consumed token returns the first operation`, SHELL, () => {
    const b = buildF27(gitPath(), "t223-busy", "base");
    const sup = superOf(b);
    return withFixture(b, "t223-busy", async (service) => {
      await update();
      const { repositoryId, r } = await reviewedOk(service, sup);
      const second = await reviewSubmodules(service, repositoryId);
      const release = service.runner.holdStart(once((c) => c.arguments.includes(":(literal)mid")));
      const requestId = sendUpdate(service, repositoryId, r);
      // The held step blocks the update. A response first means that the step never started.
      await until(() => service.runner.calls.some((c) => c.arguments.includes(":(literal)mid")) || service.responseAt.has(requestId), "mid clone step", TIMEOUT_MS);
      expect(service.runner.calls.some((c) => c.arguments.includes(":(literal)mid"))).toBe(true);
      expect((await updateSubmodules(service, repositoryId, second)).code).toBe("BUSY");
      release();
      const first = await service.response(requestId);
      expect(mutationFrames(service, first.operationId!)).toEqual(["started", "ended", "resolved"]);
      const from = service.runner.calls.length;
      const again = await updateSubmodules(service, repositoryId, r);
      expect({ operationId: again.operationId, calls: service.runner.calls.length - from }).toEqual({ operationId: first.operationId, calls: 0 });
    });
  });
});

// ---- Feature 004 FR-114: each submodule counts once (T156, contract Δ12 "Submodule count") ----

// Adds `n` gitlinks `x/x<i>` without a clone. Each has `update = none` and a registered URL, so it counts once, and the update does not visit it (contract §12 "Update protocol" step 4).
function addSkipped(w: TreeWorld, n: number): void {
  const names = Array.from({ length: n }, (_, i) => `x${String(i).padStart(3, "0")}`);
  const g = (args: string[], input?: string) => ownedGit(gitPath(), FIXTURE_ROOT, w.sup, args, { env: w.env, ...(input === undefined ? {} : { input: Buffer.from(input) }) });
  appendFileSync(join(w.sup, ".gitmodules"), names.map((name) => `[submodule "${name}"]\n\tpath = x/${name}\n\turl = ../leaf.git\n\tupdate = none\n`).join(""));
  appendFileSync(join(w.sup, ".git", "config"), names.map((name) => `[submodule "${name}"]\n\turl = ${join(w.root, "leaf.git").replaceAll("\\", "/")}\n`).join(""));
  g(["update-index", "--add", "--", ".gitmodules"]);
  g(["update-index", "-z", "--index-info"], names.map((name) => `160000 ${w.leaf.second} 0\tx/${name}\0`).join(""));
}

describe("submodule count (004 FR-114, contract Δ12 \"Submodule count\")", () => {
  // Before FR-114, a level read counted the 128 nested Git directories again. T160 (FR-115): 895 skipped rows fill the bound of 1,024, so one more count gives limit.
  caseTest(
    "T156",
    "case 4: one row with 128 nested rows with flat names and 895 skipped rows fill the bound of 1,024; the update succeeds, so the level read of that row adds no count",
    SHELL,
    async () => {
      const w = nestedFlat("t156-nested", 128);
      addSkipped(w, 895);
      // git-submodule(1) `status`: a leading space means that the checked-out commit equals the recorded commit.
      const status = () => treeGit(w, w.sup, ["submodule", "status", "--recursive", "--", "p"]).split("\n").filter((line) => line !== "");
      const before = status();
      await withService({ name: "t156-nested", environment: serviceEnv(w.env) }, async (service) => {
        await update();
        const { repositoryId } = await service.register(w.sup);
        const r = await reviewSubmodules(service, repositoryId);
        expect({ outcome: outcome(r.response), rows: r.rows.length, refusals: r.refusals.map((x) => [x.reason, x.path]), token: typeof r.token }).toEqual({ outcome: SUCCEEDED, rows: 1_024, refusals: [], token: "string" });
        const response = await service.response(sendUpdate(service, repositoryId, r), 15 * 60_000);
        const states = resultsOf(response).map((row) => [row.path, row.state, row.reason ?? null]);
        expect({ outcome: outcome(response), rows: states.length, changed: states.filter(([, state]) => state !== "unchanged") }).toEqual({ outcome: SUCCEEDED, rows: 1_024, changed: [] });
      });
      expect({ rows: before.length, moved: before.filter((line) => !line.startsWith(" ")), after: status() }).toEqual({ rows: 129, moved: [], after: before });
    },
    25 * 60_000,
  );
});

// ---- Feature 004 FR-115: the update token (T159 case c, contract Δ12 "Update token") ----

// The approval clock passes the 60-second lifetime when the mutation enters its exclusion: after acceptance, before the consume step.
function lateClock(): { approvalClock: () => number; onStarted: () => void; late: () => boolean } {
  let elapsed = 0;
  return { approvalClock: () => performance.now() + elapsed, onStarted: () => void (elapsed = APPROVAL_LIFETIME_MS + 1), late: () => elapsed > 0 };
}

describe("update token (004 FR-115, contract Δ12 \"Update token\", 001 §5 \"Approval lifetime\")", () => {
  const tokenCase = (name: string, fn: () => Promise<void>) => caseTest("T159", name, SHELL, fn, TIMEOUT_MS);
  const EXPIRED = { state: "failed", code: "APPROVAL_EXPIRED" };
  let shared: TreeWorld | null = null;
  const world = () => (shared ??= treeWorld("t159-token", { a: {} }));

  tokenCase("case c: an update whose preflight ends past the approval lifetime still consumes its token and succeeds", async () => {
    const w = world();
    const clock = lateClock();
    await withService({ name: "t159-token-late", environment: serviceEnv(w.env), approvalClock: clock.approvalClock, onStarted: clock.onStarted }, async (service) => {
      await update();
      const { repositoryId, r } = await reviewedOk(service, w.sup);
      const response = await updateSubmodules(service, repositoryId, r);
      expect({ outcome: outcome(response), late: clock.late(), rows: resultsOf(response).map((row) => [row.path, row.state]) }).toEqual({ outcome: SUCCEEDED, late: true, rows: [["a", "unchanged"]] });
    });
  });

  tokenCase("case c: a token past the approval lifetime at acceptance gives APPROVAL_EXPIRED, and no Git process starts", async () => {
    const w = world();
    let elapsed = 0;
    await withService({ name: "t159-token-expired", environment: serviceEnv(w.env), approvalClock: () => performance.now() + elapsed }, async (service) => {
      await update();
      const { repositoryId, r } = await reviewedOk(service, w.sup);
      elapsed = APPROVAL_LIFETIME_MS + 1;
      const from = service.runner.calls.length;
      const response = await updateSubmodules(service, repositoryId, r);
      expect({ ...outcome(response), runs: service.runner.calls.length - from }).toEqual({ state: "rejected", code: "APPROVAL_EXPIRED", runs: 0 });
    });
  });

  tokenCase("case c: commit and applyHunk tokens past the approval lifetime at their consume step give APPROVAL_EXPIRED", async () => {
    const repo = repoOf(buildChanged(gitPath(), "t159-consume-index", "F09"));
    for (const kind of ["commit", "applyHunk"] as const) {
      const clock = lateClock();
      await withService({ name: `t159-consume-${kind}`, approvalClock: clock.approvalClock, onStarted: clock.onStarted }, async (service) => {
        await underTest(kind === "commit" ? "commit" : "hunk-publish");
        const { repositoryId } = await service.register(repo);
        const response =
          kind === "commit"
            ? await runCommit(service, repositoryId, await commitReview(service, repositoryId), "late\n")
            : await (async () => {
                const c = await selectHunks(service, repositoryId, "multi.txt", "unstaged");
                return applyHunk(service, repositoryId, c, c.hunkIds[0]!, "stage");
              })();
        expect({ kind, ...outcome(response), late: clock.late(), commits: commitCalls(service).length }).toEqual({ kind, ...EXPIRED, late: true, commits: 0 });
      });
    }
  });

  tokenCase("case c: a sync token past the approval lifetime at its consume step gives APPROVAL_EXPIRED, and no fetch starts", async () => {
    const { clone } = buildFetchFlags(hostFor("t159-consume-sync"));
    const clock = lateClock();
    await withSync(
      "t159-consume-sync",
      async (service) => {
        const r = await register(service, clone);
        const review = await syncReviewed(service, r, { action: "fetch" });
        const from = service.runner.calls.length;
        const response = await sync(service, r, review.syncReviewToken);
        const fetches = callsFrom(service, from).filter((c) => subcommandOf(c.arguments) === "fetch");
        expect({ ...outcome(response), late: clock.late(), fetches: fetches.length }).toEqual({ ...EXPIRED, late: true, fetches: 0 });
      },
      { approvalClock: clock.approvalClock, onStarted: clock.onStarted },
    );
  });

  tokenCase("case c: a workbench token past the approval lifetime at its consume step gives APPROVAL_EXPIRED", async () => {
    const f = buildWorkbench(gitExe(), "switch-clean", "t159-consume-workbench");
    const clock = lateClock();
    await withSync(
      "t159-consume-workbench",
      async (service) => {
        const r = await service.register(native(f.repo));
        if ((await service.readTrust(r.repositoryId)).result!.approvalRequired.sync) expect((await service.approveTrust(r.repositoryId)).state).toBe("succeeded");
        const reviewed = await service.request<{ workbenchToken: string }>("reviewWorkbench", { action: "switch", target: { ref: "refs/heads/target" }, choice: "keep" }, { repositoryId: r.repositoryId, repositoryGeneration: r.generation });
        expect(outcome(reviewed)).toEqual(SUCCEEDED);
        const response = await service.response(service.send("runWorkbench", { workbenchToken: reviewed.result!.workbenchToken, start: true }, { repositoryId: r.repositoryId }));
        expect({ ...outcome(response), late: clock.late() }).toEqual({ ...EXPIRED, late: true });
      },
      { approvalClock: clock.approvalClock, onStarted: clock.onStarted },
    );
  });
});

// ---- Contract Δ12 "Submodule count": every compare of Git forms is exact (T160) ----

describe("kept Git directories whose names differ only in letter case (contract Δ12, §12 \"Trust\" nested levels)", () => {
  // `p` is at `p1`, which records no submodule. The index records `p2`, which records `X`, and the review cannot read `p2`.
  // So the review lists `X` and its twin `x` as kept Git directories without a row. The level read of `p` after its checkout lists `X`.
  // Null: the OS refuses a second folder name that differs only in letter case.
  function twinWorld(name: string): { sup: string; env: { GIT_CONFIG_GLOBAL: string } } | null {
    const root = fixtureDir(name);
    const env = { GIT_CONFIG_GLOBAL: put(root, "global.gitconfig", `${readFileSync(FIXTURE_GLOBAL_CONFIG, "utf8")}[protocol "file"]\n\tallow = always\n`) };
    const g = (cwd: string, args: string[]) => ownedGit(gitPath(), FIXTURE_ROOT, cwd, args, { env }).toString("utf8").trim();
    const url = (bare: string) => join(root, bare).replaceAll("\\", "/");
    const work = (bare: string) => {
      g(root, ["init", "-q", "--bare", "-b", "main", bare]);
      const dir = join(root, "src", bare);
      mkdirSync(dir, { recursive: true });
      g(dir, ["init", "-q", "-b", "main"]);
      return dir;
    };
    const commit = (dir: string, bare: string, files: Record<string, string>, links: Record<string, string> = {}) => {
      for (const [path, text] of Object.entries(files)) put(dir, path, text);
      g(dir, ["add", "--", ...Object.keys(files)]);
      for (const [path, oid] of Object.entries(links)) g(dir, ["update-index", "--add", "--cacheinfo", `160000,${oid},${path}`]);
      g(dir, ["commit", "-q", "-m", bare]);
      g(dir, ["push", "-q", url(bare), "HEAD:refs/heads/main"]);
      return g(dir, ["rev-parse", "HEAD"]);
    };
    const leaf = commit(work("leaf.git"), "leaf.git", { "file.txt": "leaf\n" });
    const p = work("p.git");
    const p1 = commit(p, "p.git", { "file.txt": "p1\n" });
    commit(work("super.git"), "super.git", { ".gitmodules": `[submodule "p"]\n\tpath = p\n\turl = ../p.git\n` }, { p: p1 });
    g(root, ["clone", "-q", url("super.git"), "super"]);
    const sup = join(root, "super");
    g(sup, ["submodule", "update", "--init", "-q"]);
    const p2 = commit(p, "p.git", { ".gitmodules": `[submodule "X"]\n\tpath = X\n\turl = ../leaf.git\n` }, { X: leaf });
    g(sup, ["update-index", "--cacheinfo", `160000,${p2},p`]);
    const modules = join(sup, ".git", "modules", "p", "modules");
    mkdirSync(modules);
    // `fsutil` exits 0 also when it sets nothing, so the folder state comes from the OS refusal of a second name below.
    if (process.platform === "win32") Bun.spawnSync(["fsutil", "file", "setCaseSensitiveInfo", modules, "enable"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    mkdirSync(join(modules, "probe"));
    try {
      mkdirSync(join(modules, "PROBE"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return null;
    } finally {
      rmSync(join(modules, "probe"), { recursive: true, force: true });
    }
    rmSync(join(modules, "PROBE"), { recursive: true });
    for (const [twin, folder] of [["X", "kept-upper"], ["x", "kept-lower"]] as const) {
      g(root, ["clone", "-q", `--separate-git-dir=${join(modules, twin)}`, url("leaf.git"), join(root, folder)]);
      rmSync(join(root, folder), { recursive: true });
    }
    // A local entry names no program, so the review lists it as an entry of `X` (contract §12 "Trust").
    g(root, [`--git-dir=${join(modules, "X")}`, "config", "arbareto.kept", "X"]);
    return { sup, env };
  }

  caseTest("T160", "a kept Git directory that becomes a row of a level read keeps its confirmed entries beside a twin whose name differs only in letter case", SHELL, async () => {
    const w = twinWorld("t160-twins");
    if (w === null) {
      console.log("SKIP T160 twins: fsutil file setCaseSensitiveInfo did not make the modules folder case-sensitive");
      return;
    }
    await withService({ name: "t160-twins", environment: serviceEnv(w.env) }, async (service) => {
      await update();
      const { repositoryId, r } = await reviewedOk(service, w.sup);
      expect({ rows: r.rows.map((row) => [row.path, row.action]), programs: r.programs.map((x) => x.key) }).toEqual({ rows: [["p", "fetch-checkout"]], programs: expect.arrayContaining(["arbareto.kept"]) });
      const response = await updateSubmodules(service, repositoryId, r);
      const rows = resultsOf(response).map((row) => [row.path, row.state, row.reason ?? null, row.found]);
      console.log(`OBSERVATION T160 twins: ${JSON.stringify(rows)}`);
      expect({ outcome: outcome(response), refused: rows.filter(([, state]) => state === "refused"), nested: rows.filter(([path]) => path === "p/X").length }).toEqual({ outcome: SUCCEEDED, refused: [], nested: 1 });
    });
  }, TIMEOUT_MS);
});

// ---- Feature 004 FR-112, FR-113: the update reads up to 8 rows at once (T152, contract Δ12 "Update reads", "Parallel reads", "Job close") ----

type Call = { operationId: string; arguments: readonly string[] };
type Recorded = ReturnType<typeof callsSince>[number];

// The most calls that ran at the same time, from the start and the duration of each call.
function peakOf(calls: readonly { at: number; durationMs?: number }[]): number {
  const edges = calls.flatMap((c) => [[c.at, 1], [c.at + (c.durationMs ?? 0), -1]] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0;
  let peak = 0;
  for (const [, step] of edges) peak = Math.max(peak, (now += step));
  return peak;
}

// `siblingDeadline` of service-harness.ts with several siblings: the target starts after every sibling started, with a 1 ms deadline.
// Each sibling gets one stdout byte that its paused stdout holds, so only the Job close ends it, with `exitCode` null and no `deadline`.
function siblingsDeadline(service: Service, target: (c: Call) => boolean, siblings: ((c: Call) => boolean)[]): () => void {
  const { runner } = service;
  const isTarget = once(target);
  const held = siblings.map((s) => once(s));
  const started = new Set<readonly string[]>();
  const answered = new Set<readonly string[]>();
  let armed = true;
  const releaseTarget = runner.holdStart(isTarget);
  const releaseHook = runner.holdStart((call) => {
    if (held.some((isSibling) => isSibling(call)) && !started.has(call.arguments)) {
      started.add(call.arguments);
      if (started.size === held.length) releaseTarget();
    } else if (started.size === held.length && armed && isTarget(call)) {
      armed = false;
      // `spawn` reads the deadline synchronously after this check. The reset keeps every later process at its request deadline.
      runner.inject.deadlineMs = 1;
      queueMicrotask(() => void (runner.inject.deadlineMs = null));
    }
    return false;
  });
  const resumes = held.map((isSibling) => runner.pauseStdout(isSibling));
  const prior = runner.inject.stdout;
  runner.inject.stdout = (call) => {
    if (!started.has(call.arguments) || answered.has(call.arguments)) return prior?.(call);
    answered.add(call.arguments);
    return new Uint8Array([0]);
  };
  return () => {
    releaseTarget();
    releaseHook();
    for (const resume of resumes) resume();
    runner.inject.stdout = prior;
  };
}

describe("parallel update reads (004 FR-112, FR-113, contract Δ12 \"Update reads\")", () => {
  const readsCase = (name: string, fn: () => Promise<void>) => caseTest("T152", `T152 ${name}`, SHELL, fn, 5 * 60_000);
  // A test budget for a read of a later row that ends while an earlier read waits. A preflight that reads one row at a time never meets it.
  const AHEAD_WAIT_MS = 30_000;
  const NESTED = Array.from({ length: 10 }, (_, i) => `p/c${i}`);
  // The rows in tree order. b and f are one commit behind their gitlinks. p holds one saved commit after its gitlink.
  const ROWS = ["a", "a/x", "b", "c", "d", "e", "f", "g", "h", "p", ...NESTED];
  const MOVED = ["b", "f", "p"];
  // Contract §12 "Reconciliation and outcome": each moved row ends moved and each other row unchanged, as with one lane.
  const EXPECTED = ROWS.map((path) => [path, MOVED.includes(path) ? "moved" : "unchanged"]);
  let shared: TreeWorld | null = null;
  // The kept Git directory of m has no row. Each update moves b, f, and p to their gitlinks, so each case sets them back first.
  const world = (): TreeWorld => {
    if (shared === null) {
      const w = treeWorld("t152-reads", { a: { x: {} }, b: {}, c: {}, d: {}, e: {}, f: {}, g: {}, h: {}, m: {}, p: Object.fromEntries(NESTED.map((path) => [path.slice(2), {}])) });
      treeGit(w, w.sup, ["rm", "-q", "-f", "m"]);
      const p = join(w.sup, "p");
      treeGit(w, p, ["checkout", "-q", "-b", "work"]);
      treeGit(w, p, ["commit", "-q", "--allow-empty", "-m", "work"]);
      shared = w;
    }
    for (const path of ["b", "f"]) treeGit(shared, join(shared.sup, path), ["checkout", "-q", "--detach", shared.leaf.first]);
    treeGit(shared, join(shared.sup, "p"), ["checkout", "-q", "work"]);
    return shared;
  };
  const withTree = (w: TreeWorld, name: string, body: (service: Service) => Promise<void>) => withService({ name, environment: serviceEnv(w.env) }, body);
  const atRow = (w: TreeWorld, path: string) => isAt(w.sup, path);
  const belowRow = (w: TreeWorld, prefix: string) => (c: { arguments: readonly string[] }) => at(w.sup, c.arguments)?.startsWith(prefix) === true;
  const firstRead = (c: { arguments: readonly string[] }) => cmd(c) === "rev-parse --verify -q HEAD";
  const isConfigList = (c: { arguments: readonly string[] }) => cmd(c) === "config list --show-scope --show-origin -z";
  const isReach = (c: { arguments: readonly string[] }) => commandOf(c.arguments)[0] === "rev-list";
  const isStepOf = (path: string) => (c: { arguments: readonly string[] }) => isUpdateStep(c.arguments) && c.arguments.includes(`:(literal)${path}`);
  const endOf = (c: { at: number; durationMs?: number }) => c.at + (c.durationMs ?? 0);
  const opCalls = (service: Service, operationId: string) => service.runner.calls.filter((c) => c.operationId === operationId);
  const headAt = (w: TreeWorld, path: string) => treeGit(w, join(w.sup, ...path.split("/")), ["rev-parse", "HEAD"]).trim();
  const gitlinkOf = (w: TreeWorld, path: string) => treeGit(w, w.sup, ["ls-files", "-s", "--", path]).split(" ")[1]!;
  const statesOf = (response: ServiceResponse) => resultsOf(response).map((row) => [row.path, row.state]);
  const exited = (w: TreeWorld, paths: readonly string[], match: (c: Call) => boolean) => (calls: readonly Recorded[]) => paths.every((path) => calls.some((c) => atRow(w, path)(c) && match(c) && c.exit !== undefined));

  // Sends a request and holds the stdout of the first call that `held` accepts until `ready` holds for the calls since the send.
  // A red run still waits for the response, so the next case finds no running operation.
  async function holding(service: Service, held: (c: Call) => boolean, ready: (calls: readonly Recorded[]) => boolean, what: string, send: () => string): Promise<ServiceResponse> {
    const from = service.runner.calls.length;
    const release = service.runner.pauseStdout(once(held));
    let id: string | null = null;
    try {
      id = send();
      await until(() => ready(callsSince(service, from)), what, AHEAD_WAIT_MS);
      release();
      return await service.response(id, NO_TOTAL_DEADLINE_WAIT_MS);
    } finally {
      release();
      if (id !== null) await service.response(id, NO_TOTAL_DEADLINE_WAIT_MS).catch(() => undefined);
    }
  }
  // The list review with the hold of `holding`.
  async function reviewHeld(service: Service, repositoryId: string, held: (c: Call) => boolean, ready: (calls: readonly Recorded[]) => boolean, what: string): Promise<SubmoduleReview> {
    const read = await readOk(service, repositoryId);
    const response = await holding(service, held, ready, what, () => service.send("reviewSubmodules", { snapshotId: read.snapshotId }, { repositoryId, repositoryGeneration: read.generation }));
    return {
      read,
      response,
      token: valuesOf(response.result, "submoduleReviewToken")[0] as string | undefined,
      rows: objectsWith<SubmodulePlanRow>(response.result, ["rowId", "action"]),
      programs: objectsWith(response.result, ["key", "digest"]),
      refusals: refusalsOf(response.result),
    };
  }

  readsCase("case a: the review holds the first read of c and the preflight holds the first read of g; the update passes its preflight without STALE_REVIEW, and each row result equals the one-lane result", async () => {
    const w = world();
    await withTree(w, "t152-a", async (service) => {
      await update();
      const { repositoryId } = await service.register(w.sup);
      const r = await reviewHeld(service, repositoryId, (c) => atRow(w, "c")(c) && firstRead(c), exited(w, ["d", "e", "f", "g", "h"], firstRead), "the first reads of d to h while c waits");
      expect({ outcome: outcome(r.response), refusals: r.refusals.map((x) => [x.reason, x.path]), rows: r.rows.map((row) => [row.path, row.action]) }).toEqual({
        outcome: SUCCEEDED,
        refusals: [],
        rows: ROWS.map((path) => [path, MOVED.includes(path) ? "checkout" : "none"]),
      });
      const response = await holding(service, (c) => atRow(w, "g")(c) && firstRead(c), exited(w, ["h"], firstRead), "the first read of h while g waits", () => sendUpdate(service, repositoryId, r));
      expect({ outcome: outcome(response), rows: statesOf(response), heads: MOVED.map((path) => headAt(w, path)) }).toEqual({ outcome: SUCCEEDED, rows: EXPECTED, heads: MOVED.map((path) => gitlinkOf(w, path)) });
    });
  });

  readsCase("case b: the preflight and the level read of p with 10 nested rows each run at least 2 and at most 9 Git processes at once, and each update step runs as the only Git process", async () => {
    const w = world();
    await withTree(w, "t152-b", async (service) => {
      await update();
      const { repositoryId, r } = await reviewedOk(service, w.sup);
      const id = sendUpdate(service, repositoryId, r);
      const operationId = await service.operationId(id);
      const response = await service.response(id, NO_TOTAL_DEADLINE_WAIT_MS);
      const calls = opCalls(service, operationId);
      const steps = calls.filter((c) => isUpdateStep(c.arguments));
      const inside = calls.filter((c) => insideSubmodule(w.sup, c.arguments));
      const preflight = steps.length === 0 ? inside : inside.filter((c) => c.at < steps[0]!.at);
      // The level read of p starts after the step of p and ends with the `cat-file --batch-check` target checks of its rows (contract §12 step 6).
      const stepOfP = steps.find(isStepOf("p"));
      const afterP = stepOfP === undefined ? [] : inside.filter((c) => belowRow(w, "p/")(c) && c.at >= endOf(stepOfP));
      const levelEnd = Math.max(...afterP.filter((c) => cmd(c) === "cat-file --batch-check").map(endOf));
      const level = afterP.filter((c) => c.at < levelEnd);
      const beside = steps.flatMap((s) => calls.filter((c) => c !== s && c.at < endOf(s) && s.at < endOf(c)).map((c) => [cmd(s), cmd(c)]));
      const peaks = { preflight: peakOf(preflight), level: peakOf(level) };
      console.log(`OBSERVATION T152 case b: ${JSON.stringify({ ...peaks, steps: steps.length, levelCalls: level.length })}`);
      expect({ outcome: outcome(response), rows: statesOf(response), preflight: [peaks.preflight >= 2, peaks.preflight <= 9], level: [peaks.level >= 2, peaks.level <= 9], steps: steps.map(cmd), beside }).toEqual({
        outcome: SUCCEEDED,
        rows: EXPECTED,
        preflight: [true, true],
        level: [true, true],
        steps: MOVED.map((path) => CHECKOUT(path).join(" ")),
        beside: [],
      });
    });
  });

  // Contract Δ12 "Job close", note of 2026-11-07: a recorded deadline stops the preflight, so no read that the Job close ended runs again.
  readsCase("case c: a 1 ms deadline on the config list of d while the first reads of b and c wait moves the mutation to reconciling with DEADLINE; no waiting read runs again, and no update process starts", async () => {
    const w = world();
    await withTree(w, "t152-c", async (service) => {
      await update();
      const { repositoryId, r } = await reviewedOk(service, w.sup);
      const from = service.runner.calls.length;
      const isTarget = (c: Call) => atRow(w, "d")(c) && isConfigList(c);
      const release = siblingsDeadline(service, isTarget, ["b", "c"].map((path) => (c: Call) => atRow(w, path)(c) && firstRead(c)));
      let id = "";
      try {
        id = sendUpdate(service, repositoryId, r);
        await until(() => callsSince(service, from).some((c) => isTarget(c) && c.exit !== undefined), "the deadline of the config list of d", AHEAD_WAIT_MS);
      } finally {
        release();
        if (id !== "") await service.response(id, NO_TOTAL_DEADLINE_WAIT_MS).catch(() => undefined);
      }
      const response = await service.response(id, NO_TOTAL_DEADLINE_WAIT_MS);
      const exits = (match: (c: Call) => boolean) => callsSince(service, from).filter(match).map((c) => [c.exit?.exitCode ?? null, c.exit?.deadline ?? null]);
      expect({
        outcome: outcome(response),
        reconciling: progressStates(service, id).includes("reconciling"),
        target: exits(isTarget),
        held: ["b", "c"].map((path) => exits((c) => atRow(w, path)(c) && firstRead(c))),
        steps: updateSteps(service, from).length,
      }).toEqual({ outcome: { state: "failed", code: "DEADLINE" }, reconciling: true, target: [[null, "deadline"]], held: [0, 1].map(() => [[null, null]]), steps: 0 });
    });
  });

  // Review finding (a): a second start of the first read of b exits 1, so a read that runs again fails row b before row d in row order.
  // The target is the second HEAD read of d. The first one starts in the same task as the first reads of e to h, which would get the 1 ms deadline too.
  readsCase("case j: a 1 ms deadline on the symbolic-ref HEAD read of d while the first reads of b and c wait moves the mutation to reconciling with DEADLINE; no waiting read runs again, and no update process starts", async () => {
    const w = world();
    await withTree(w, "t152-j", async (service) => {
      await update();
      const { repositoryId, r } = await reviewedOk(service, w.sup);
      const from = service.runner.calls.length;
      const isTarget = (c: Call) => atRow(w, "d")(c) && cmd(c) === "symbolic-ref -q HEAD";
      const isB = (c: { arguments: readonly string[] }) => atRow(w, "b")(c) && firstRead(c);
      let starts = 0;
      service.runner.inject.exit = (c) => (isB(c) && ++starts === 2 ? 1 : undefined);
      const release = siblingsDeadline(service, isTarget, ["b", "c"].map((path) => (c: Call) => atRow(w, path)(c) && firstRead(c)));
      let id = "";
      try {
        id = sendUpdate(service, repositoryId, r);
        await until(() => callsSince(service, from).some((c) => isTarget(c) && c.exit !== undefined), "the deadline of the HEAD read of d", AHEAD_WAIT_MS);
      } finally {
        release();
        service.runner.inject.exit = undefined;
        if (id !== "") await service.response(id, NO_TOTAL_DEADLINE_WAIT_MS).catch(() => undefined);
      }
      const response = await service.response(id, NO_TOTAL_DEADLINE_WAIT_MS);
      const exits = (match: (c: Call) => boolean) => callsSince(service, from).filter(match).map((c) => [c.exit?.exitCode ?? null, c.exit?.deadline ?? null]);
      expect({
        outcome: outcome(response),
        reconciling: progressStates(service, id).includes("reconciling"),
        target: exits(isTarget),
        held: ["b", "c"].map((path) => exits((c) => atRow(w, path)(c) && firstRead(c))),
        steps: updateSteps(service, from).length,
      }).toEqual({ outcome: { state: "failed", code: "DEADLINE" }, reconciling: true, target: [[null, "deadline"]], held: [0, 1].map(() => [[null, null]]), steps: 0 });
    });
  });

  readsCase("case d: Cancel while 8 preflight reads wait ends the update canceled; no update process starts, and no Git process of the update starts after Cancel or ends after the response", async () => {
    const w = world();
    await withTree(w, "t152-d", async (service) => {
      await update();
      const { repositoryId, r } = await reviewedOk(service, w.sup);
      const from = service.runner.calls.length;
      const held = new Set<object>();
      const dirs = new Set<string>();
      const resume = service.runner.pauseStdout((c) => {
        if (held.has(c)) return true;
        const where = gitLocation(c.arguments);
        if (where === null || !insideSubmodule(w.sup, c.arguments) || !firstRead(c) || dirs.size >= 8 || dirs.has(where)) return false;
        dirs.add(where);
        held.add(c);
        return true;
      });
      let id = "";
      let canceledAt = 0;
      let response: ServiceResponse;
      try {
        id = sendUpdate(service, repositoryId, r);
        await until(() => held.size === 8, "8 waiting preflight reads", AHEAD_WAIT_MS);
        canceledAt = performance.now();
        await service.cancel(await service.operationId(id));
        response = await service.response(id, NO_TOTAL_DEADLINE_WAIT_MS);
      } finally {
        resume();
        if (id !== "") await service.response(id, NO_TOTAL_DEADLINE_WAIT_MS).catch(() => undefined);
      }
      const end = service.responseAt.get(id)!;
      const calls = opCalls(service, await service.operationId(id));
      expect({
        state: response.state,
        held: held.size,
        steps: updateSteps(service, from).length,
        started: calls.filter((c) => c.at > canceledAt).length,
        late: calls.filter((c) => c.durationMs === undefined || c.at + c.durationMs > end).length,
      }).toEqual({ state: "canceled", held: 8, steps: 0, started: 0, late: 0 });
    });
  });

  readsCase("case e: 4 MiB of stderr on the config list of d while the first read of a waits fails the update with OUTPUT_LIMIT, and no update process starts", async () => {
    const w = world();
    await withTree(w, "t152-e", async (service) => {
      await update();
      const { repositoryId, r } = await reviewedOk(service, w.sup);
      const from = service.runner.calls.length;
      const isTarget = (c: Call) => atRow(w, "d")(c) && isConfigList(c);
      // The seam gets a new call object at each check, so a flag keeps the bytes to the first match.
      let hit = false;
      service.runner.inject.stderr = (c) => (!hit && isTarget(c) && (hit = true) ? new Uint8Array(UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION) : undefined);
      // The first read of a gets one stdout byte that its paused stdout holds, so only the Job close of the bound ends it (as `siblingsDeadline`).
      let held: readonly string[] | null = null;
      const isHeld = (c: { arguments: readonly string[] }) => (held === null && atRow(w, "a")(c) && firstRead(c) ? ((held = c.arguments), true) : c.arguments === held);
      service.runner.inject.stdout = (c) => (isHeld(c) ? new Uint8Array([0]) : undefined);
      const resume = service.runner.pauseStdout(isHeld);
      let id = "";
      let response: ServiceResponse;
      try {
        id = sendUpdate(service, repositoryId, r);
        await until(() => callsSince(service, from).some((c) => isTarget(c) && c.exit !== undefined), "the stderr bound on the config list of d", AHEAD_WAIT_MS);
        response = await service.response(id, NO_TOTAL_DEADLINE_WAIT_MS);
      } finally {
        resume();
        service.runner.inject.stderr = undefined;
        service.runner.inject.stdout = undefined;
        if (id !== "") await service.response(id, NO_TOTAL_DEADLINE_WAIT_MS).catch(() => undefined);
      }
      expect({ outcome: outcome(response), steps: updateSteps(service, from).length }).toEqual({ outcome: { state: "failed", code: "OUTPUT_LIMIT" }, steps: 0 });
    });
  });

  readsCase("case f: in the level read of p after its step, a 1 ms deadline on the config list and a failing HEAD read that run at once give the readConfig failure: the run ends with DEADLINE, and no nested row of p fails", async () => {
    const w = world();
    await withTree(w, "t152-f", async (service) => {
      await update();
      const { runner } = service;
      const { repositoryId, r } = await reviewedOk(service, w.sup);
      const inP = atRow(w, "p");
      let armed = false;
      let from = 0;
      const failed = new Set<string>();
      // The reconciliation reads of p get no injected exit.
      const reconciling = () => (service.progress as { phase?: string }[]).some((p) => p.phase === "reconciliation");
      const config = once((c) => armed && inP(c) && isConfigList(c));
      // `rev-parse --verify` exits 1 and `symbolic-ref` exits 129, so the HEAD read fails with GIT_FAILED (contract §12 "Review reads").
      // The seam gets a new call object at each check, so the set keeps each exit to the first match.
      runner.inject.exit = (c) => {
        const code = !armed || reconciling() || !inP(c) ? undefined : firstRead(c) ? 1 : cmd(c) === "symbolic-ref -q HEAD" ? 129 : undefined;
        if (code === undefined || failed.has(cmd(c))) return undefined;
        failed.add(cmd(c));
        return code;
      };
      const releaseHook = runner.holdStart((call) => {
        if (isStepOf("p")(call)) {
          armed = true;
          from = runner.calls.length;
        } else if (config(call)) {
          runner.inject.deadlineMs = 1;
          queueMicrotask(() => void (runner.inject.deadlineMs = null));
        }
        return false;
      });
      let response: ServiceResponse;
      try {
        response = await service.response(sendUpdate(service, repositoryId, r), NO_TOTAL_DEADLINE_WAIT_MS);
      } finally {
        releaseHook();
        runner.inject.exit = undefined;
      }
      const after = callsSince(service, from).filter(inP);
      const configRead = after.find(isConfigList);
      const headRead = after.find(firstRead);
      const nested = resultsOf(response).filter((row) => row.path.startsWith("p/"));
      expect({
        outcome: outcome(response),
        reason: (response.result as { reason?: string } | undefined)?.reason,
        config: configRead?.exit?.deadline ?? null,
        together: headRead !== undefined && configRead !== undefined && headRead.at < endOf(configRead),
        nested: nested.map((row) => [row.path, row.state, row.failedRead ?? null]),
      }).toEqual({
        outcome: { state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" },
        reason: "deadline",
        config: "deadline",
        together: true,
        nested: NESTED.map((path) => [path, "unchanged", null]),
      });
    });
  });

  readsCase("case g: a moved row runs its reach read once, in its read-ahead: the reach read of f ends while the first read of a waits, in the list review and in the preflight", async () => {
    const w = world();
    await withTree(w, "t152-g", async (service) => {
      await update();
      const { repositoryId } = await service.register(w.sup);
      const heldA = (c: Call) => atRow(w, "a")(c) && firstRead(c);
      const reachOf = (from: number) => MOVED.map((path) => callsSince(service, from).filter((c) => atRow(w, path)(c) && isReach(c)).length);
      const reviewFrom = service.runner.calls.length;
      const r = await reviewHeld(service, repositoryId, heldA, exited(w, ["f"], isReach), "the reach read of f while a waits");
      const reviewReach = reachOf(reviewFrom);
      const updateFrom = service.runner.calls.length;
      const response = await holding(service, heldA, exited(w, ["f"], isReach), "the reach read of f while a waits", () => sendUpdate(service, repositoryId, r));
      expect({ review: outcome(r.response), reviewReach, outcome: outcome(response), updateReach: reachOf(updateFrom), rows: statesOf(response) }).toEqual({
        review: SUCCEEDED,
        reviewReach: [1, 1, 1],
        outcome: SUCCEEDED,
        updateReach: [1, 1, 1],
        rows: EXPECTED,
      });
    });
  });

  // The shell walks of the program listing (001 §6 "Walks") start no Git process, so the case counts `listSubmoduleTrust` calls (T156 case 6).
  readsCase("case i: the program listing of the preflight runs at least 2 and at most 8 listings at once; the program list and the digest equal those of one listing at a time", async () => {
    const w = world();
    const dirs = ROWS.map((path) => join(w.sup, ...path.split("/")));
    for (const [i, dir] of dirs.entries()) treeGit(w, dir, ["config", "arbareto.row", ROWS[i]!]);
    const real = trustModule.listSubmoduleTrust;
    let serial = true;
    let started = 0;
    let live = 0;
    let peak = 0;
    let turn: Promise<void> = Promise.resolve();
    const listing = spyOn(trustModule, "listSubmoduleTrust").mockImplementation(async (...args: Parameters<typeof real>) => {
      const index = started++;
      let release = () => {};
      const prior = turn;
      if (serial) {
        turn = new Promise((resolve) => (release = resolve));
        await prior;
      }
      live++;
      peak = Math.max(peak, live);
      try {
        // A later listing ends first, so only the apply order keeps the row order.
        if (!serial) await Bun.sleep(4 * (24 - (index % 24)));
        return await real(...args);
      } finally {
        live--;
        release();
      }
    });
    try {
      await withTree(w, "t152-i", async (service) => {
        await update();
        const { repositoryId } = await service.register(w.sup);
        const r = await reviewSubmodules(service, repositoryId);
        const one = { calls: started, peak };
        serial = false;
        peak = 0;
        const response = await updateSubmodules(service, repositoryId, r);
        const pathOf = new Map(r.rows.map((row) => [row.rowId, row.path]));
        const expectedPaths = [...new Set(r.programs.flatMap((p) => ("rowId" in p ? [pathOf.get(p.rowId) ?? p.rowId] : [])))];
        console.log(`OBSERVATION T152 case i: listing peak ${peak}, one at a time ${one.peak}, review listings ${one.calls}`);
        expect({
          review: outcome(r.response),
          programs: r.programs.length,
          one: one.peak,
          outcome: outcome(response),
          rows: statesOf(response),
          atLeast2: peak >= 2,
          atMost8: peak <= 8,
          confirm: confirmRuns(service).map((f) => [f.programCount, f.uncheckedCount, f.submodulePaths.map((p) => relative(w.sup, p).replaceAll("\\", "/"))]),
        }).toEqual({
          review: SUCCEEDED,
          programs: ROWS.length,
          one: 1,
          outcome: SUCCEEDED,
          rows: EXPECTED,
          atLeast2: true,
          atMost8: true,
          confirm: [[r.programs.length, r.programs.filter((p) => p.digest === "unchecked").length, expectedPaths]],
        });
      });
    } finally {
      listing.mockRestore();
      for (const dir of dirs) treeGit(w, dir, ["config", "--unset", "arbareto.row"]);
    }
  });
});

