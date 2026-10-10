// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T255: the stall notice of a commit and of submodule update steps (contract §6 "Activity and stall notice", §12 "Remedies", data-model §7 `stallRemedy`).
// `src/git-service/stall.ts` comes with T256. T112 and T230 wire it into `commit.ts` and `submodule-update.ts`, and T231 registers the update.
// The double sends the activity events that a test injects (`BunRunner.activity`), as the shell does for a call with `stallMs`.

import { describe, expect } from "bun:test";
import { join, relative, resolve } from "node:path";
import { COMMIT_PROCESS_DEADLINE_MS, STALL_NOTICE_MS } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import type { CallMatch } from "./bun-runner";
import { serviceEnv, useFixtureRoot } from "./fixture-root";
import { buildChanged, buildF27 } from "./fixtures";
import { approve, barrier, commitCalls, commitPayload, gitPath, hookRemedy, isCommitCall, outcome, putHook, repoOf, reviewOk, shortDeadline, SUCCEEDED, todoCase, until, valuesOf, withService } from "./hunk-harness";
import type { Capability, Service } from "./service-harness";
import { checkoutRemedy, cloneRemedy, commandOf, fetchRemedy, gitLocation, miniWorld, reviewSubmodules, sendUpdate, STEP_TEXT, superOf, underTestSubmodule, updateSteps, withFixture } from "./submodule-harness";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);

const TASK = "T255";
const COMMIT_NEEDS = "(needs T256)";
const UPDATE_NEEDS = "(needs T256/T231)";
const SHELL: Capability[] = ["shell-double"];
// Contract §6 "Activity and stall notice": the commit stall text.
const COMMIT_STALL_TEXT = "This command runs only the pre-commit hook and does not commit. It cannot repeat a prompt from another hook or from signing.";
// A marker that a hook writes to stderr. No log and no event may hold it.
const HOOK_MARKER = "ARBARETO-T255-HOOK-MARKER";

useFixtureRoot();

// Prints the ORIGIN line of `stall.ts` and loads it. Before T256, the module is missing, and this throws.
async function underTestStall(): Promise<void> {
  const module = "stall";
  printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
  await import(`../../src/git-service/${module}.ts`);
}

// The `stalled` flags of the progress events of one request, in order.
const stalledFlags = (service: Service, requestId: string) =>
  (service.progress as { requestId?: string; stalled?: unknown }[]).filter((p) => p.requestId === requestId && typeof p.stalled === "boolean").map((p) => p.stalled as boolean);
const stallRemedyOf = async (service: Service, operationId: string) => valuesOf((await service.getOperation(operationId)).result, "stallRemedy") as { command?: string; text: string }[];

// Sends `stalled`, checks the notice and `stallRemedy`, then sends `active` and checks that the field clears.
async function stallAndClear(service: Service, requestId: string, match: CallMatch, expected: { command?: string; text: string }): Promise<void> {
  const operationId = await service.operationId(requestId);
  expect(service.runner.activity(match, "stalled")).toBe(1);
  await until(() => stalledFlags(service, requestId).at(-1) === true, "stalled progress event");
  expect(await stallRemedyOf(service, operationId)).toEqual([expected]);
  expect(service.runner.activity(match, "active")).toBe(1);
  await until(() => stalledFlags(service, requestId).at(-1) === false, "active progress event");
  expect(await stallRemedyOf(service, operationId)).toEqual([]);
  // Contract §2: progress events carry no command.
  if (expected.command !== undefined) expect(JSON.stringify(service.progress).includes(JSON.stringify(expected.command).slice(1, -1))).toBe(false);
}

describe("commit (contract §6 \"Activity and stall notice\")", () => {
  for (const name of ["t255-commit", "t255-commit-“refused"]) {
    const refused = name.includes("“");
    todoCase(TASK, `F09${refused ? " under a folder name with U+201C" : ""}: a stalled commit sets the stalled flag and stallRemedy ${refused ? "with the text only" : "with the pre-commit hook command"}, and the next active event clears both ${COMMIT_NEEDS}`, SHELL, async () => {
      await underTestStall();
      const built = buildChanged(gitPath(), name, "F09");
      const repo = repoOf(built);
      const gate = barrier(built.root, "pre-commit");
      putHook(repo, "pre-commit", `echo ${HOOK_MARKER} >&2\n${gate.body}`);
      await withService({ name }, async (service) => {
        const { repositoryId } = await service.register(repo);
        await approve(service, repositoryId);
        const r = await reviewOk(service, repositoryId);
        const requestId = service.send("commit", commitPayload(r, "stall\n"), { repositoryId, repositoryGeneration: r.read.generation });
        await gate.reached();
        try {
          await stallAndClear(service, requestId, isCommitCall, refused ? { text: COMMIT_STALL_TEXT } : { command: hookRemedy(repo), text: COMMIT_STALL_TEXT });
        } finally {
          gate.release();
        }
        expect(outcome(await service.response(requestId))).toEqual(SUCCEEDED);
        // The commit process gets the commit deadline and the 15-second stall threshold (contract §6 "Process fields").
        expect(commitCalls(service).map((c) => c.limits)).toEqual([{ deadlineMs: COMMIT_PROCESS_DEADLINE_MS, stallMs: STALL_NOTICE_MS }]);
        expect({ log: JSON.stringify(service.log()).includes(HOOK_MARKER), progress: JSON.stringify(service.progress).includes(HOOK_MARKER) }).toEqual({ log: false, progress: false });
      });
    });
  }

  todoCase(TASK, `F09: the notice changes no deadline; a stalled commit still ends at a test-injected deadline with DEADLINE ${COMMIT_NEEDS}`, SHELL, async () => {
    await underTestStall();
    const name = "t255-commit-deadline";
    const built = buildChanged(gitPath(), name, "F09");
    const repo = repoOf(built);
    const gate = barrier(built.root, "pre-commit");
    putHook(repo, "pre-commit", gate.body);
    await withService({ name }, async (service) => {
      const { repositoryId } = await service.register(repo);
      await approve(service, repositoryId);
      const r = await reviewOk(service, repositoryId);
      const deadlineMs = 3_000;
      shortDeadline(service, isCommitCall, deadlineMs).arm();
      const requestId = service.send("commit", commitPayload(r, "stall deadline\n"), { repositoryId, repositoryGeneration: r.read.generation });
      try {
        await gate.reached();
        expect(service.runner.activity(isCommitCall, "stalled")).toBe(1);
        const response = await service.response(requestId);
        expect(outcome(response)).toEqual({ state: "failed", code: "DEADLINE" });
        const [call] = commitCalls(service);
        expect({ deadline: call!.exit?.deadline, bound: call!.durationMs! >= deadlineMs }).toEqual({ deadline: "deadline", bound: true });
      } finally {
        gate.release();
      }
    });
  });
});

describe("submodule update steps (contract §12 \"Remedies\")", () => {
  // F27 behind-fetch: `mid` is a clone row, and `solo` is a fetch-checkout row.
  const at = (sup: string, path: string) => (c: { arguments: readonly string[] }) => {
    const location = gitLocation(c.arguments);
    return location !== null && relative(join(sup, path), resolve(sup, location)) === "";
  };
  const STEPS = [
    { step: "clone", match: (_sup: string) => (c: { arguments: readonly string[] }) => c.arguments.includes(":(literal)mid") && commandOf(c.arguments)[0] === "submodule" && !c.arguments.includes("--no-fetch"), remedy: (sup: string) => ({ command: cloneRemedy(sup, "mid"), text: STEP_TEXT.clone }) },
    { step: "fetch", match: (sup: string) => (c: { arguments: readonly string[] }) => at(sup, "solo")(c) && commandOf(c.arguments)[0] === "fetch", remedy: (sup: string) => ({ command: fetchRemedy(join(sup, "solo")), text: STEP_TEXT.fetch }) },
    { step: "checkout", match: (_sup: string) => (c: { arguments: readonly string[] }) => c.arguments.includes(":(literal)solo") && c.arguments.includes("--no-fetch"), remedy: (sup: string) => ({ command: checkoutRemedy(sup, "solo"), text: STEP_TEXT.checkout }) },
  ] as const;

  for (const { step, match, remedy } of STEPS) {
    todoCase(TASK, `F27 behind-fetch: a stalled ${step} step sets the stalled flag and stallRemedy with the step command, the next active event clears both, and every update request carries the 15-second stall threshold ${UPDATE_NEEDS}`, SHELL, async () => {
      await underTestStall();
      await underTestSubmodule("submodule-update");
      const name = `t255-${step}`;
      const b = buildF27(gitPath(), name, "behind-fetch");
      const sup = superOf(b);
      await withFixture(b, name, async (service) => {
        const { repositoryId } = await service.register(sup);
        const r = await reviewSubmodules(service, repositoryId);
        const from = service.runner.calls.length;
        const release = service.runner.holdStart(match(sup));
        const requestId = sendUpdate(service, repositoryId, r);
        try {
          await until(() => service.runner.calls.slice(from).some(match(sup)), `${step} step`);
          await stallAndClear(service, requestId, match(sup), remedy(sup));
        } finally {
          release();
        }
        expect(outcome(await service.response(requestId))).toEqual(SUCCEEDED);
        const steps = updateSteps(service, from);
        expect(steps.length).toBeGreaterThan(0);
        expect(steps.filter((c) => c.limits?.stallMs !== STALL_NOTICE_MS).map((c) => c.arguments)).toEqual([]);
      });
    });
  }

  todoCase(TASK, `a clone step of a submodule path with U+201C: stallRemedy holds the clone text without a command ${UPDATE_NEEDS}`, SHELL, async () => {
    await underTestStall();
    await underTestSubmodule("submodule-update");
    const name = "t255-refused";
    const path = "q“a";
    const w = miniWorld(name, [{ name: "q", path, url: "../solo.git" }]);
    await withService({ name, environment: serviceEnv(w.env) }, async (service) => {
      const { repositoryId } = await service.register(w.sup.dir);
      const r = await reviewSubmodules(service, repositoryId);
      const clone: CallMatch = (c) => c.arguments.includes(`:(literal)${path}`) && commandOf(c.arguments)[0] === "submodule";
      const release = service.runner.holdStart(clone);
      const requestId = sendUpdate(service, repositoryId, r);
      try {
        await until(() => service.runner.calls.some(clone), "clone step");
        await stallAndClear(service, requestId, clone, { text: STEP_TEXT.clone });
      } finally {
        release();
      }
      await service.response(requestId);
    });
  });
});
