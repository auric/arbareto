// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T008: `reviewWorkbench` and `runWorkbench` with action `create-tag` (feature 010 contract Δ3, data-model §2 to §6, plan.md D3, SC-004, SC-007).
// The oracle is Git's own `git tag` on a copy. Fresh Git reads decide every expectation, never message text.
// Control: return a token for `name: null`; the open-review case must fail.

import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { printOrigin } from "../origin";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { fc, gitOut, gitPaths, gitRun, importStream, refMap, type GitHost } from "./remote-fixtures";
import { caseTest, keepConfigs, type RegistrationResult, type Service, type ServiceResponse } from "./service-harness";
import { hostFor, INTEGRATE_ENV, native, refreshIndex, register, repoShape, TIMEOUT_MS, until, withSync as syncService } from "./sync-harness";
import { hookEvents, logHooks } from "./workbench-fixtures";

// FR-005: each case keeps the bytes of every configuration file of the repositories that it registers.
const withSync = (name: string, body: (service: Service) => Promise<void>, options?: Parameters<typeof syncService>[2]) => syncService(name, (service) => keepConfigs(service, body), options);

for (const module of ["commit-actions", "workbench-review"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
useFixtureRoot();

const TASK = "T008";
const SHELL = ["shell-double"] as const;
const L = "--no-lazy-fetch";
const SUCCEEDED = { state: "succeeded", code: undefined };
const WITH_EFFECTS = { state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" };
const outcome = (r: { state: string; code?: string }) => ({ state: r.state, code: r.code });
const refusal = (r: ServiceResponse<unknown>) => ({ ...outcome(r), result: r.result });
const unavailable = (reason: string, extra: object = {}) => ({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason, ...extra } });

interface TagPlan {
  name: string | null;
  target: string;
  annotated: boolean;
  signs: { light: boolean; annotated: boolean };
}
interface Reviewed {
  action: string;
  plan: TagPlan;
  workbenchToken?: string;
}
interface TagRun {
  action: string;
  head: { state: string; target?: string; oid?: string };
  refs: { ref: string }[];
  tag: { name: string; oid: string; annotated: boolean } | null;
  outputTail?: string;
}

const TAG = (name: string | null, target: string, message: string | null = null) => ({ action: "create-tag", name, target, message });
const review = (service: Service, r: RegistrationResult, payload: object) => service.request<Reviewed>("reviewWorkbench", payload, { repositoryId: r.repositoryId, repositoryGeneration: r.generation });
const sendRun = (service: Service, r: RegistrationResult, token: string) => service.send("runWorkbench", { workbenchToken: token, start: true }, { repositoryId: r.repositoryId });

async function reviewed(service: Service, r: RegistrationResult, payload: object): Promise<Reviewed & { workbenchToken: string }> {
  const response = await review(service, r, payload);
  expect({ ...outcome(response), result: response.state === "succeeded" ? "result" : response.result }).toEqual({ ...SUCCEEDED, result: "result" });
  expect(typeof response.result!.workbenchToken).toBe("string");
  return response.result as Reviewed & { workbenchToken: string };
}

const run = async (service: Service, r: RegistrationResult, payload: object) => service.response<TagRun>(sendRun(service, r, (await reviewed(service, r, payload)).workbenchToken));
const steps = (service: Service, from = 0) => service.runner.calls.slice(from).filter((c) => c.environmentPolicy === "integrate").map((c) => [...c.arguments]);
const isTag = (call: { arguments: readonly string[] }) => call.arguments[1] === "tag";
// Every Git process of the service after `from`.
const processes = (service: Service, from = 0) => service.runner.calls.length - from;

const stateOf = (h: GitHost, repo: string) => ({ ...repoShape(h, repo), refs: refMap(h, repo), headOid: gitOut(h, repo, ["rev-parse", "--verify", "-q", "HEAD"]).trim() });

function build(h: GitHost, name: string): { repo: string; base: string; main: string } {
  const repo = `${h.root}/${name}`;
  gitRun(h, h.root, ["init", "-q", "-b", "main", "--", repo]);
  for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"]] as const) gitRun(h, repo, ["config", key, value]);
  const marks = importStream(h, repo, [fc({ mark: 1, message: "base\n", files: { "a.txt": "a\n" } }), fc({ mark: 2, message: "main\n", from: 1, files: { "a.txt": "a2\n" } })]);
  gitRun(h, repo, ["reset", "-q", "--hard", "main"]);
  return { repo, base: marks.get(1)!, main: marks.get(2)! };
}

// A signer that reads the payload and fails (research.md R2 P8).
function failingSigner(h: GitHost): { program: string; ran: string } {
  const program = `${h.root}/signer.sh`;
  const ran = `${h.root}/signer.ran`;
  h.write(program, `#!/bin/sh\ncat > /dev/null\n: > '${ran}'\nexit 1\n`);
  return { program, ran };
}

async function approved(service: Service, repo: string): Promise<RegistrationResult> {
  const r = await register(service, repo);
  const trust = await service.readTrust(r.repositoryId);
  if (trust.result!.approvalRequired.workbench) expect((await service.approveTrust(r.repositoryId, "tag")).state).toBe("succeeded");
  return r;
}

describeGit("create tag here (T008)", () => {
  let copies = 0;
  const copyOf = (h: GitHost, repo: string) => {
    const to = `${h.root}/copy-${++copies}`;
    h.copy(repo, to);
    return refreshIndex(h, to);
  };

  caseTest(TASK, "SC-004: a lightweight and an annotated tag equal Git's own git tag on a copy; the annotated step passes -m without -a", SHELL, async () => {
    const h = hostFor("t008-kinds");
    const f = build(h, "kinds");
    const o = copyOf(h, f.repo);
    const MESSAGE = "Release 1.0\n\nNotes line\n";
    await withSync("t008-kinds", async (service) => {
      const r = await approved(service, f.repo);
      const light = await reviewed(service, r, TAG("v1.0", f.base));
      expect(light.plan).toEqual({ name: "v1.0", target: f.base, annotated: false, signs: { light: false, annotated: false } });
      let from = service.runner.calls.length;
      const one = await service.response<TagRun>(sendRun(service, r, light.workbenchToken));
      expect(outcome(one)).toEqual(SUCCEEDED);
      expect(one.result).toEqual({ action: "create-tag", head: { state: "branch", target: "refs/heads/main", oid: f.main }, refs: [{ ref: "refs/tags/v1.0" }], tag: { name: "v1.0", oid: f.base, annotated: false } });
      expect(steps(service, from)).toEqual([[L, "tag", "--end-of-options", "v1.0", f.base]]);
      const annotated = await reviewed(service, r, TAG("rel/2", f.main, MESSAGE));
      expect(annotated.plan).toEqual({ name: "rel/2", target: f.main, annotated: true, signs: { light: false, annotated: false } });
      from = service.runner.calls.length;
      const two = await service.response<TagRun>(sendRun(service, r, annotated.workbenchToken));
      expect(outcome(two)).toEqual(SUCCEEDED);
      expect(steps(service, from)).toEqual([[L, "tag", "-m", MESSAGE, "--end-of-options", "rel/2", f.main]]);
      expect(two.result!.tag).toEqual({ name: "rel/2", oid: gitOut(h, f.repo, ["rev-parse", "refs/tags/rel/2"]).trim(), annotated: true });
    });
    gitRun(h, o, ["tag", "--end-of-options", "v1.0", f.base], { env: INTEGRATE_ENV });
    gitRun(h, o, ["tag", "-m", MESSAGE, "--end-of-options", "rel/2", f.main], { env: INTEGRATE_ENV });
    expect(stateOf(h, f.repo)).toEqual(stateOf(h, o));
    expect(gitOut(h, f.repo, ["cat-file", "-t", "refs/tags/rel/2"]).trim()).toBe("tag");
  }, TIMEOUT_MS);

  caseTest(TASK, "plan.md D3: the open review with name null gives the plan with no token and changes no ref; UNKNOWN_TARGET refuses a missing target", SHELL, async () => {
    const h = hostFor("t008-open");
    const f = build(h, "open");
    const before = stateOf(h, f.repo);
    await withSync("t008-open", async (service) => {
      const r = await approved(service, f.repo);
      const response = await review(service, r, TAG(null, f.base));
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect(response.result).toEqual({ action: "create-tag", plan: { name: null, target: f.base, annotated: false, signs: { light: false, annotated: false } } });
      for (const name of [null, "fresh"]) expect({ name, ...refusal(await review(service, r, TAG(name, "0123456789abcdef0123456789abcdef01234567"))) }).toEqual({ name, state: "failed", code: "UNKNOWN_TARGET", result: undefined });
      expect(steps(service)).toEqual([]);
    });
    expect(stateOf(h, f.repo)).toEqual(before);
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-032 and P8: with tag.gpgSign=true and a failing gpg.program the open review states both signing facts and no refusal; a named lightweight tag refuses tag-signing; an annotated tag fails as Git's own git tag on a copy", SHELL, async () => {
    const h = hostFor("t008-gpgsign");
    const signer = failingSigner(h);
    const f = build(h, "gpgsign");
    gitRun(h, f.repo, ["config", "tag.gpgSign", "true"]);
    gitRun(h, f.repo, ["config", "gpg.program", signer.program]);
    const o = copyOf(h, f.repo);
    await withSync("t008-gpgsign", async (service) => {
      const r = await approved(service, f.repo);
      const open = await review(service, r, TAG(null, f.base));
      expect({ ...outcome(open), result: open.result }).toEqual({ ...SUCCEEDED, result: { action: "create-tag", plan: { name: null, target: f.base, annotated: false, signs: { light: true, annotated: true } } } });
      expect(refusal(await review(service, r, TAG("light", f.base)))).toEqual(unavailable("tag-signing"));
      expect(existsSync(native(signer.ran))).toBe(false);
      const response = await run(service, r, TAG("signed", f.base, "m\n"));
      expect(outcome(response)).toEqual({ state: "failed", code: "GIT_FAILED" });
      expect({ tag: response.result!.tag, refs: response.result!.refs, tail: typeof response.result!.outputTail }).toEqual({ tag: null, refs: [], tail: "string" });
      expect(existsSync(native(signer.ran))).toBe(true);
    });
    expect(gitRun(h, o, ["tag", "-m", "m\n", "--end-of-options", "signed", f.base], { env: INTEGRATE_ENV, allowExit: [128] }).exitCode).toBe(128);
    expect(gitRun(h, o, ["tag", "--end-of-options", "light", f.base], { env: INTEGRATE_ENV, allowExit: [128] }).exitCode).toBe(128);
    expect(refMap(h, f.repo)).toEqual(refMap(h, o));
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-032 and P8: with tag.forceSignAnnotated=true the open review states that only the annotated kind signs; a lightweight tag runs, and an annotated tag fails as Git's own git tag on a copy", SHELL, async () => {
    const h = hostFor("t008-force");
    const signer = failingSigner(h);
    const f = build(h, "force");
    gitRun(h, f.repo, ["config", "tag.forceSignAnnotated", "true"]);
    gitRun(h, f.repo, ["config", "gpg.program", signer.program]);
    const o = copyOf(h, f.repo);
    await withSync("t008-force", async (service) => {
      const r = await approved(service, f.repo);
      const open = await review(service, r, TAG(null, f.base));
      expect(open.result).toEqual({ action: "create-tag", plan: { name: null, target: f.base, annotated: false, signs: { light: false, annotated: true } } });
      expect(outcome(await run(service, r, TAG("light", f.base)))).toEqual(SUCCEEDED);
      expect(existsSync(native(signer.ran))).toBe(false);
      const signed = await run(service, r, TAG("signed", f.base, "m\n"));
      expect({ ...outcome(signed), tag: signed.result!.tag }).toEqual({ state: "failed", code: "GIT_FAILED", tag: null });
      expect(existsSync(native(signer.ran))).toBe(true);
    });
    gitRun(h, o, ["tag", "--end-of-options", "light", f.base], { env: INTEGRATE_ENV });
    expect(gitRun(h, o, ["tag", "-m", "m\n", "--end-of-options", "signed", f.base], { env: INTEGRATE_ENV, allowExit: [128] }).exitCode).toBe(128);
    expect(refMap(h, f.repo)).toEqual(refMap(h, o));
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-031 and FR-032: an existing name gives name-exists, a signing value that is no boolean gives invalid-config also for the open review, and a message above 8 KiB is refused; no ref changes", SHELL, async () => {
    const h = hostFor("t008-refusals");
    const f = build(h, "refusals");
    gitRun(h, f.repo, ["tag", "taken", f.base]);
    const before = stateOf(h, f.repo);
    await withSync("t008-refusals", async (service) => {
      const r = await approved(service, f.repo);
      expect(refusal(await review(service, r, TAG("taken", f.main)))).toEqual(unavailable("name-exists", { ref: "refs/tags/taken" }));
      expect(outcome(await review(service, r, TAG("big", f.main, "x".repeat(8 * 1024 + 1))))).toEqual({ state: "rejected", code: "INVALID_REQUEST" });
      expect(outcome(await review(service, r, TAG("blank", f.main, " \n")))).toEqual({ state: "rejected", code: "INVALID_REQUEST" });
      expect(steps(service)).toEqual([]);
    });
    expect(stateOf(h, f.repo)).toEqual(before);
    for (const key of ["tag.gpgSign", "tag.forceSignAnnotated"]) {
      const g = build(h, `config-${key}`);
      gitRun(h, g.repo, ["config", key, "maybe"]);
      const o = copyOf(h, g.repo);
      // builtin/tag.c `git_tag_config` reads both keys with `git_config_bool`, which stops Git on such a value.
      expect(gitRun(h, o, ["tag", "--end-of-options", "x", g.base], { allowExit: [128] }).exitCode).toBe(128);
      await withSync(`t008-config-${key}`, async (service) => {
        const r = await approved(service, g.repo);
        for (const name of [null, "x"]) for (const message of [null, "m\n"]) expect({ key, name, message, ...refusal(await review(service, r, TAG(name, g.base, message))) }).toEqual({ key, name, message, ...unavailable("invalid-config") });
      });
      expect(refMap(h, g.repo)).toEqual(refMap(h, o));
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-031 and P9: names that check-ref-format refuses give invalid-name; a leading '-' gives invalid-name and HEAD and @ give reserved-name before any Git process; an empty name is refused; no ref changes", SHELL, async () => {
    const h = hostFor("t008-names");
    const f = build(h, "names");
    const o = copyOf(h, f.repo);
    const before = stateOf(h, f.repo);
    await withSync("t008-names", async (service) => {
      const r = await approved(service, f.repo);
      for (const name of ["a..b", "x.lock", "a b"]) {
        expect({ name, check: gitRun(h, o, ["check-ref-format", `refs/tags/${name}`], { allowExit: [0, 1] }).exitCode }).toEqual({ name, check: 1 });
        expect({ name, ...refusal(await review(service, r, TAG(name, f.base))) }).toEqual({ name, ...unavailable("invalid-name") });
      }
      for (const [name, reason] of [["-x", "invalid-name"], ["HEAD", "reserved-name"], ["@", "reserved-name"]] as const) {
        // Research.md R2 P9: check-ref-format accepts these names, and `git tag` refuses `-x` and `HEAD`.
        expect({ name, check: gitRun(h, o, ["check-ref-format", `refs/tags/${name}`], { allowExit: [0, 1] }).exitCode }).toEqual({ name, check: 0 });
        const from = service.runner.calls.length;
        expect({ name, ...refusal(await review(service, r, TAG(name, f.base))) }).toEqual({ name, ...unavailable(reason) });
        expect({ name, processes: processes(service, from) }).toEqual({ name, processes: 0 });
      }
      expect(outcome(await review(service, r, TAG("", f.base)))).toEqual({ state: "rejected", code: "INVALID_REQUEST" });
      expect(steps(service)).toEqual([]);
    });
    expect(stateOf(h, f.repo)).toEqual(before);
  }, TIMEOUT_MS);

  caseTest(TASK, "contract §5: a check-ref-format exit code null gives GIT_FAILED, not invalid-name, and the review issues no token", SHELL, async () => {
    const h = hostFor("t008-name-null-exit");
    const f = build(h, "name-null-exit");
    await withSync("t008-name-null-exit", async (service) => {
      const r = await approved(service, f.repo);
      service.runner.inject.exit = (call) => (call.arguments.includes("check-ref-format") ? null : undefined);
      const response = await review(service, r, TAG("v1", f.base));
      service.runner.inject.exit = undefined;
      expect({ ...outcome(response), token: response.result?.workbenchToken }).toEqual({ state: "failed", code: "GIT_FAILED", token: undefined });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "SC-007 and FR-004: the reference-transaction hook runs only after the workbench approval, and its log equals Git's own git tag on a copy (research.md R2 P3c)", SHELL, async () => {
    const h = hostFor("t008-hooks");
    const f = build(h, "hooks");
    const o = copyOf(h, f.repo);
    const [log, oracleLog] = [`${h.root}/hooks.log`, `${h.root}/hooks-oracle.log`];
    logHooks(gitPaths(h, f.repo, ["hooks"])[0]!, log);
    logHooks(gitPaths(h, o, ["hooks"])[0]!, oracleLog);
    await withSync("t008-hooks", async (service) => {
      const r = await register(service, f.repo);
      expect((await service.readTrust(r.repositoryId)).result!.approvalRequired.workbench).toBe(true);
      expect(refusal(await review(service, r, TAG("v1", f.base)))).toEqual({ state: "failed", code: "TRUST_REQUIRED", result: { trustGate: "repository" } });
      expect({ steps: steps(service), log: existsSync(native(log)) }).toEqual({ steps: [], log: false });
      expect((await service.approveTrust(r.repositoryId, "tag")).state).toBe("succeeded");
      expect(outcome(await run(service, r, TAG("v1", f.base)))).toEqual(SUCCEEDED);
      expect(outcome(await run(service, r, TAG("v2", f.base, "m\n")))).toEqual(SUCCEEDED);
    });
    gitRun(h, o, ["tag", "--end-of-options", "v1", f.base], { env: INTEGRATE_ENV });
    gitRun(h, o, ["tag", "-m", "m\n", "--end-of-options", "v2", f.base], { env: INTEGRATE_ENV });
    expect(hookEvents(native(log))).toEqual(["reference-transaction"]);
    expect(h.read(log)?.toString()).toBe(h.read(oracleLog)?.toString());
    expect(refMap(h, f.repo)).toEqual(refMap(h, o));
  }, TIMEOUT_MS);

  caseTest(TASK, "P16: a reference-transaction hook that writes another ref and exits 1 in the prepared state leaves no tag, and the outcome is failed-with-effects as Git's own git tag on a copy", SHELL, async () => {
    const h = hostFor("t008-p16");
    const f = build(h, "p16");
    const o = copyOf(h, f.repo);
    // The inner update-ref runs the hook again, so the variable ends that recursion.
    const hook = `#!/bin/sh\n[ -n "$ARBARETO_P16" ] && exit 0\n[ "$1" = prepared ] || exit 0\nARBARETO_P16=1 git update-ref refs/hooked ${f.base}\nexit 1\n`;
    for (const repo of [f.repo, o]) h.write(`${gitPaths(h, repo, ["hooks"])[0]!}/reference-transaction`, hook);
    await withSync("t008-p16", async (service) => {
      const r = await approved(service, f.repo);
      const response = await run(service, r, TAG("v1", f.base));
      expect(outcome(response)).toEqual(WITH_EFFECTS);
      expect({ tag: response.result!.tag, refs: response.result!.refs, tail: typeof response.result!.outputTail }).toEqual({ tag: null, refs: [{ ref: "refs/hooked" }], tail: "string" });
    });
    expect(gitRun(h, o, ["tag", "--end-of-options", "v1", f.base], { env: INTEGRATE_ENV, allowExit: [128] }).exitCode).toBe(128);
    expect(refMap(h, f.repo)).toEqual(refMap(h, o));
    expect(refMap(h, f.repo)["refs/tags/v1"]).toBeUndefined();
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-003 and FR-007: an external tag write after the review gives STALE_REVIEW, the 60 s expiry gives APPROVAL_EXPIRED, and Cancel before the step changes nothing", SHELL, async () => {
    const h = hostFor("t008-stale");
    const f = build(h, "stale");
    await withSync("t008-stale", async (service) => {
      const r = await approved(service, f.repo);
      const rv = await reviewed(service, r, TAG("v1", f.main));
      gitRun(h, f.repo, ["tag", "v1", f.base]);
      const before = stateOf(h, f.repo);
      expect(outcome(await service.response(sendRun(service, r, rv.workbenchToken)))).toEqual({ state: "failed", code: "STALE_REVIEW" });
      expect(steps(service)).toEqual([]);
      expect(stateOf(h, f.repo)).toEqual(before);
      const held = await reviewed(service, r, TAG("v2", f.main));
      const release = service.runner.holdStart(isTag);
      const requestId = sendRun(service, r, held.workbenchToken);
      const operationId = await service.operationId(requestId);
      await until(() => service.runner.calls.some((c) => c.operationId === operationId && isTag(c)), "held tag");
      await service.cancel(operationId);
      release();
      const response = await service.response<TagRun>(requestId);
      expect({ ...outcome(response), tag: response.result!.tag }).toEqual({ state: "canceled", code: "CANCELED", tag: null });
      expect(stateOf(h, f.repo)).toEqual(before);
    });
    let clock = 0;
    await withSync("t008-expired", async (service) => {
      const r = await approved(service, f.repo);
      const rv = await reviewed(service, r, TAG("v3", f.main));
      clock += 60_001;
      const from = service.runner.calls.length;
      expect(outcome(await service.response(sendRun(service, r, rv.workbenchToken)))).toEqual({ state: "rejected", code: "APPROVAL_EXPIRED" });
      expect(processes(service, from)).toBe(0);
    }, { approvalClock: () => clock });
  }, TIMEOUT_MS);
});
