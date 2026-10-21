// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T223: `updateSubmodules` (contract §12 "Update protocol", "Trust", "Environment and console", "Reconciliation and outcome", "Remedies").
// `src/git-service/submodule-update.ts` comes with T230, which registers the operation in the session. T231 turns the cases into real tests.

import { describe, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import policyFile from "../../src/contracts/git-environment.json";
import { SUBMODULE_PROGRESS_PHASES, SubmoduleProgress } from "../../src/contracts/submodules";
import { printOrigin } from "../origin";
import { FIXTURE_GLOBAL_CONFIG, FIXTURE_ROOT, fixtureEnv, ownedGit, useFixtureRoot } from "./fixture-root";
import { buildF27, buildF28, buildF29, put, type Built, type F27Variant, type F29Variant } from "./fixtures";
import { fileSha256, rawIndexDigest, refState, submoduleState, workingFileDigests, type SubmoduleUpdateResult } from "./git-oracle";
import { gitPath, mutationFrames, outcome, readOk, SUCCEEDED, TIMEOUT_MS, until, valuesOf } from "./hunk-harness";
import { caseTest, once, withFsCalls, withKeptWorkspaces, type Capability, type Service, type ServiceResponse, type SubmoduleCheckpoint } from "./service-harness";
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
  invalidGitFolder,
  miniGit,
  miniWorld,
  moduleDirOf,
  NOTES,
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
  withFixture,
  type MiniWorld,
  type SubmoduleReview,
} from "./submodule-harness";

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
    const connect = Bun.spawnSync([gitPath(), "--no-lazy-fetch", "-c", "fetch.recurseSubmodules=no", ...CHECKOUT("solo")], { cwd: copy, env: fixtureEnv(globalEnv(b)), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
    const own = (args: string[], cwd: string, env = {}) => Bun.spawnSync([gitPath(), "-c", "core.fsmonitor=false", ...args], { cwd, env: fixtureEnv({ ...noFile, ...env }), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
    const own = Bun.spawnSync([gitPath(), "--no-lazy-fetch", "-C", sub, "fetch", "--no-recurse-submodules"], { env: fixtureEnv({ GIT_CONFIG_GLOBAL: noFile, GIT_PROTOCOL_FROM_USER: "0" }), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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

