// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T033: the matching probe and the matching rules through `searchHistory` (plan.md P5, D5; contract Δ3 "Matching probe", Δ7).
// Spec FR-022, FR-023, FR-024, FR-025, SC-007.

import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { GIT_PROCESS_DEADLINE_MS } from "../../src/contracts/limits";
import { MATCHING_PROBE_COMMITS, MATCHING_PROBE_GREPS, MATCHING_PROBE_RUNS, MATCHING_PROBE_STREAM, MATCHING_PROBE_TIP, MATCHING_PROBE_WSL_FOLDER } from "../../src/contracts/matching-probe";
import { isIdentifier } from "../../src/contracts/operations";
import { probeScriptArgs } from "../../src/git-service/commands";
import { RunnerRefusal, type GitCall, type GitExit, type GitRunner } from "../../src/git-service/git-runner";
import { probeMatching } from "../../src/git-service/history-search";
import type { Workspace } from "../../src/git-service/registration";
import { printOrigin } from "../origin";
import { FIXED_IDENTITY, FIXTURE_HOME, fixtureDir, serviceEnv, useFixtureRoot } from "./fixture-root";
import { GIT } from "./git-binary";
import { repositoryDigest } from "./history-fixtures";
import { allFilterRows, git, gitPath, grepOracle, isProbe, isReplaceRead, isSearch, opened, oracle, probeLabel as label, probeOidsOf as oidsOf, SC007_CASES as CASES, search, waitFor, type Searched } from "./history-view-harness";
import { caseTest, openService, type OpenOptions, type Service, type ServiceResponse } from "./service-harness";

printOrigin("../../src/git-service/history-search.ts", import.meta.dir);
printOrigin("../../src/contracts/matching-probe.ts", import.meta.dir);

const TASK = "T033";
const SHELL = ["shell-double"] as const;
const TIMEOUT_MS = 300_000;
const WINDOWS = process.platform === "win32";

useFixtureRoot();

async function withService(name: string, body: (service: Service) => Promise<void>, options: Partial<OpenOptions> = {}): Promise<void> {
  const service = await openService({ git: gitPath(), name, watchHints: false, ...options });
  try {
    await body(service);
  } finally {
    await service.dispose();
  }
}

// A repository that holds the probe commits of `src/contracts/matching-probe.ts` on its checked-out branch.
function probeRepo(name: string): string {
  const repo = fixtureDir(`${name}/repo`);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["fast-import", "--quiet"], { input: MATCHING_PROBE_STREAM });
  git(repo, ["symbolic-ref", "HEAD", "refs/heads/probe"]);
  expect(oracle(repo).map((r) => r.oid).toSorted()).toEqual(MATCHING_PROBE_COMMITS.map((c) => c.oid).toSorted());
  return repo;
}

type Outcome = { state: string; code?: string; oids: string[] };

// The filter rows of one search, or its refusal.
async function searchOids(service: Service, repositoryId: string, viewId: string, text: string): Promise<Outcome> {
  const request = service.send("searchHistory", { viewId, text }, { repositoryId });
  const searchId = await service.operationId(request);
  const done: ServiceResponse<Searched> = await service.response<Searched>(request);
  if (done.state !== "succeeded") return { state: done.state, code: done.code!, oids: [] };
  return { state: done.state, oids: (await allFilterRows(service, repositoryId, viewId, searchId, done.result!.matches!)).map((r) => r.oid) };
}

describe("matching probe (contract Δ3 \"Matching probe\")", () => {
  caseTest(
    TASK,
    "the probe runs once per Git installation in a session, after the fingerprint check and before the search, in a new folder under os.tmpdir() that it removes",
    SHELL,
    () =>
      withService("t033-once", async (service) => {
        const repo = probeRepo("t033-once");
        const before = repositoryDigest(repo);
        const { repositoryId, generation } = await service.register(repo);
        const view = await opened(service, repositoryId, generation);
        for (const text of ["probe", "ascii"]) expect((await search(service, repositoryId, view.viewId, text)).state).toBe("succeeded");
        const calls = service.runner.calls;
        const probes = calls.filter(isProbe);
        const dir = probes[0]!.arguments.at(-1)!;
        expect(probes.map((c) => c.arguments.slice(1, 3).map((a) => (a === `--git-dir=${dir}` ? "--git-dir" : a)).join(" "))).toEqual(["init --bare", "--git-dir fast-import", ...MATCHING_PROBE_RUNS.map(() => "--git-dir --no-optional-locks")]);
        expect({ parent: dirname(dir), name: basename(dir).startsWith("arbareto-probe-"), exists: existsSync(dir) }).toEqual({ parent: tmpdir(), name: true, exists: false });
        for (const call of probes.slice(1)) expect(call.arguments[1]).toBe(`--git-dir=${dir}`);
        for (const call of probes) expect(call.environmentPolicy).toBe("search");
        expect(Buffer.from(probes[1]!.input!).equals(Buffer.from(MATCHING_PROBE_STREAM))).toBe(true);
        for (const call of probes.slice(2)) expect(Buffer.from(call.input!).toString()).toBe(`${MATCHING_PROBE_TIP}\n`);
        // T035 order: the fingerprint check, then the probe, then the search.
        const first = calls.indexOf(probes[0]!);
        expect(calls.findIndex(isReplaceRead)).toBeLessThan(first);
        expect(calls.findIndex(isSearch)).toBeGreaterThan(calls.indexOf(probes.at(-1)!));
        // The probe writes nothing inside the user repository.
        expect(repositoryDigest(repo)).toBe(before);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a probe mismatch gives SEARCH_UNSUPPORTED reason matching with a remedy, no search starts, and the next search keeps the probe result",
    SHELL,
    () =>
      withService(
        "t033-mismatch",
        async (service) => {
          const repo = probeRepo("t033-mismatch");
          const { repositoryId, generation } = await service.register(repo);
          const view = await opened(service, repositoryId, generation);
          const refused = await search(service, repositoryId, view.viewId, "probe");
          expect({ state: refused.state, code: refused.code, reason: refused.result?.reason, command: refused.result?.remedy?.command }).toEqual({ state: "failed", code: "SEARCH_UNSUPPORTED", reason: "matching", command: null });
          expect(refused.result!.remedy!.text.length).toBeGreaterThan(0);
          expect(service.runner.calls.filter(isSearch)).toEqual([]);
          const probes = service.runner.calls.filter(isProbe).length;
          const again = await search(service, repositoryId, view.viewId, "probe");
          expect({ state: again.state, code: again.code, reason: again.result?.reason }).toEqual({ state: "failed", code: "SEARCH_UNSUPPORTED", reason: "matching" });
          expect({ probes: service.runner.calls.filter(isProbe).length, searches: service.runner.calls.filter(isSearch).length }).toEqual({ probes, searches: 0 });
        },
        // The test-only session option: one expected match leaves each run, so the real probe output no longer equals it.
        { historyProbeRuns: MATCHING_PROBE_RUNS.map((run) => ({ grep: run.grep, matches: run.matches.slice(1) })) },
      ),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a failed probe folder or probe step gives GIT_FAILED, not SEARCH_UNSUPPORTED, makes the view stale, removes the folder, and keeps no probe answer",
    SHELL,
    () =>
      withService("t033-step-failed", async (service) => {
        const repo = probeRepo("t033-step-failed");
        const { repositoryId, generation } = await service.register(repo);
        const view = await opened(service, repositoryId, generation);
        const folder = spyOn(fsp, "mkdtemp").mockImplementation((async () => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }) as never);
        let noFolder: ServiceResponse<Searched>;
        try {
          noFolder = await search(service, repositoryId, view.viewId, "probe");
        } finally {
          folder.mockRestore();
        }
        expect({ state: noFolder.state, code: noFolder.code }).toEqual({ state: "failed", code: "GIT_FAILED" });
        expect(service.runner.calls.filter(isProbe)).toEqual([]);
        // Contract Δ8 condition 4: the view is stale, so a later search of it refuses with the same code and starts no probe.
        const again = await search(service, repositoryId, view.viewId, "probe");
        expect({ state: again.state, code: again.code, probes: service.runner.calls.filter(isProbe).length }).toEqual({ state: "failed", code: "GIT_FAILED", probes: 0 });
        // Refresh opens a new view.
        const second = await opened(service, repositoryId, generation);
        service.runner.inject.exit = (call) => (isProbe(call) && call.arguments[1] === "init" ? 128 : undefined);
        let noInit: ServiceResponse<Searched>;
        try {
          noInit = await search(service, repositoryId, second.viewId, "probe");
        } finally {
          service.runner.inject.exit = undefined;
        }
        expect({ state: noInit.state, code: noInit.code }).toEqual({ state: "failed", code: "GIT_FAILED" });
        const init = service.runner.calls.filter(isProbe);
        expect(init.length).toBe(1);
        expect(existsSync(init[0]!.arguments.at(-1)!)).toBe(false);
        expect(service.runner.calls.filter(isSearch)).toEqual([]);
        // No answer was kept, so the search of the next view runs the probe again.
        const third = await opened(service, repositoryId, generation);
        expect((await search(service, repositoryId, third.viewId, "probe")).state).toBe("succeeded");
        expect(service.runner.calls.filter(isProbe).length).toBe(1 + 2 + MATCHING_PROBE_RUNS.length);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a search canceled during the probe removes the probe folder",
    SHELL,
    () =>
      withService("t033-probe-cancel", async (service) => {
        const repo = probeRepo("t033-probe-cancel");
        const { repositoryId, generation } = await service.register(repo);
        const view = await opened(service, repositoryId, generation);
        const isImport = (call: { arguments: readonly string[] }) => isProbe(call) && call.arguments.includes("fast-import");
        const release = service.runner.holdStart(isImport);
        try {
          const request = service.send("searchHistory", { viewId: view.viewId, text: "probe" }, { repositoryId });
          const searchId = await service.operationId(request);
          await waitFor("the held probe import", () => service.runner.calls.some(isImport));
          await service.cancel(searchId);
          release();
          expect((await service.response(request)).state).toBe("canceled");
        } finally {
          release();
        }
        const dir = service.runner.calls.find(isProbe)!.arguments.at(-1)!;
        expect({ parent: dirname(dir), exists: existsSync(dir) }).toEqual({ parent: tmpdir(), exists: false });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a failed probe folder removal gives the session log entry of the search the cause probe-folder-remove, and no path",
    SHELL,
    () =>
      withService("t033-remove-failed", async (service) => {
        const repo = probeRepo("t033-remove-failed");
        const { repositoryId, generation } = await service.register(repo);
        const view = await opened(service, repositoryId, generation);
        const rm = fsp.rm;
        const isProbeFolder = (path: unknown) => dirname(String(path)) === tmpdir() && basename(String(path)).startsWith("arbareto-probe-");
        const refused = spyOn(fsp, "rm").mockImplementation(((path: string, options?: object) => (isProbeFolder(path) ? Promise.reject(Object.assign(new Error("busy"), { code: "EBUSY" })) : rm(path, options))) as never);
        let searchId: string;
        try {
          const request = service.send("searchHistory", { viewId: view.viewId, text: "probe" }, { repositoryId });
          searchId = await service.operationId(request);
          expect((await service.response(request)).state).toBe("succeeded");
        } finally {
          refused.mockRestore();
        }
        const dir = service.runner.calls.find(isProbe)!.arguments.at(-1)!;
        expect(existsSync(dir)).toBe(true);
        await rm(dir, { recursive: true, force: true });
        expect(service.log().filter((e) => (e as { operationId?: string }).operationId === searchId)).toEqual([expect.objectContaining({ kind: "searchHistory", cause: "probe-folder-remove" })]);
        expect(JSON.stringify(service.log())).not.toContain(basename(dir));
      }),
    TIMEOUT_MS,
  );
});

// T063: the WSL probe is one `run` with `script: "matchingProbe"` (contract Δ3 "Matching probe", Δ6). A stub runner gives the script output.
describe("WSL matching probe script (contract Δ3 \"Matching probe\", Δ6)", () => {
  const TIP_LINE = `${MATCHING_PROBE_TIP}\n`;
  const lines = (oids: readonly string[]) => oids.map((oid) => `${oid}\n`).join("");
  const CONTRACT = MATCHING_PROBE_RUNS.map((run) => `${lines(run.matches)}end 0\n`).join("");
  const workspace = {
    repositoryId: crypto.randomUUID(),
    gitInstallationId: crypto.randomUUID(),
    wsl: { distro: "Ubuntu-26.04", path: "/usr/bin/git" },
  } as unknown as Workspace;

  type Reply = { stdout?: string; exit?: Partial<GitExit>; during?: () => void };
  function stub(reply: Reply) {
    const calls: GitCall[] = [];
    const runner = {
      async run(call: GitCall): Promise<GitExit> {
        calls.push(call);
        reply.during?.();
        if (reply.stdout !== undefined) call.stdout.push(new TextEncoder().encode(reply.stdout));
        return { exitCode: 0, activeDescendants: 0, ...reply.exit };
      },
    } as unknown as GitRunner;
    return { runner, calls };
  }

  async function probe(reply: Reply, controller = new AbortController()) {
    const { runner, calls } = stub(reply);
    const folder = spyOn(fsp, "mkdtemp");
    let removeFailed = 0;
    try {
      const result = await probeMatching(runner, { operationId: crypto.randomUUID(), signal: controller.signal, workspace }, MATCHING_PROBE_RUNS, () => removeFailed++);
      return { result, calls, folders: folder.mock.calls.length, removeFailed };
    } finally {
      folder.mockRestore();
    }
  }

  test("the probe is one search run of the matchingProbe script with the fixed stream, and the contract output passes", async () => {
    const { result, calls, folders, removeFailed } = await probe({ stdout: CONTRACT });
    expect({ result, calls: calls.length, folders, removeFailed }).toEqual({ result: "pass", calls: 1, folders: 0, removeFailed: 0 });
    const call = calls[0]!;
    const dir = call.arguments[0]!;
    expect(dir.slice(0, MATCHING_PROBE_WSL_FOLDER.length)).toBe(MATCHING_PROBE_WSL_FOLDER);
    expect(isIdentifier(dir.slice(MATCHING_PROBE_WSL_FOLDER.length))).toBe(true);
    expect({ script: call.script, policy: call.environmentPolicy, context: call.context, limits: call.limits, transaction: call.transaction }).toEqual({
      script: "matchingProbe",
      policy: "search",
      context: { contextKind: "registeredOperation", gitInstallationId: workspace.gitInstallationId, repositoryId: workspace.repositoryId },
      limits: { deadlineMs: GIT_PROCESS_DEADLINE_MS },
      transaction: undefined,
    });
    expect([...call.arguments]).toEqual(probeScriptArgs(dir, MATCHING_PROBE_TIP, MATCHING_PROBE_GREPS));
    expect(Buffer.from(call.input!).equals(Buffer.from(MATCHING_PROBE_STREAM))).toBe(true);
    // Each probe takes a new folder.
    expect((await probe({ stdout: CONTRACT })).calls[0]!.arguments[0]).not.toBe(dir);
  });

  test.each([
    ["one expected OID missing from run 2", `${lines(MATCHING_PROBE_RUNS[0]!.matches)}end 0\n${lines(MATCHING_PROBE_RUNS[1]!.matches.slice(1))}end 0\n`],
    ["a non-matching probe commit in run 1", `${lines([...MATCHING_PROBE_RUNS[0]!.matches, MATCHING_PROBE_RUNS[0]!.nonMatches[0]!])}end 0\n${lines(MATCHING_PROBE_RUNS[1]!.matches)}end 0\n`],
    ["an empty run 1", `end 0\n${lines(MATCHING_PROBE_RUNS[1]!.matches)}end 0\n`],
  ])("an exact output with %s gives mismatch", async (_name, stdout) => {
    expect((await probe({ stdout })).result).toBe("mismatch");
  });

  test.each([
    ["an end 1 line", `${lines(MATCHING_PROBE_RUNS[0]!.matches)}end 1\n${lines(MATCHING_PROBE_RUNS[1]!.matches)}end 0\n`, { failed: "GIT_FAILED" }],
    ["an end 128 line in run 2", `${lines(MATCHING_PROBE_RUNS[0]!.matches)}end 0\nend 128\n`, { failed: "GIT_FAILED" }],
    ["a malformed line", `${lines(MATCHING_PROBE_RUNS[0]!.matches)}end 0\nfatal: x\nend 0\n`, { failed: "MALFORMED_GIT_OUTPUT" }],
    ["an uppercase OID", `${MATCHING_PROBE_TIP.toUpperCase()}\n${CONTRACT}`, { failed: "MALFORMED_GIT_OUTPUT" }],
    ["an end line with a leading zero", `${lines(MATCHING_PROBE_RUNS[0]!.matches)}end 00\n${lines(MATCHING_PROBE_RUNS[1]!.matches)}end 0\n`, { failed: "MALFORMED_GIT_OUTPUT" }],
    ["a third run", `${CONTRACT}end 0\n`, { failed: "MALFORMED_GIT_OUTPUT" }],
    ["an OID after the last end line", `${CONTRACT}${TIP_LINE}`, { failed: "MALFORMED_GIT_OUTPUT" }],
    ["one end line", `${lines(MATCHING_PROBE_RUNS[0]!.matches)}end 0\n${lines(MATCHING_PROBE_RUNS[1]!.matches)}`, { failed: "MALFORMED_GIT_OUTPUT" }],
    ["no final line feed", CONTRACT.slice(0, -1), { failed: "MALFORMED_GIT_OUTPUT" }],
    ["no output", "", { failed: "MALFORMED_GIT_OUTPUT" }],
  ])("%s gives no answer", async (_name, stdout, failed) => {
    expect((await probe({ stdout })).result as unknown).toEqual(failed);
  });

  test("a nonzero script exit, a deadline, a diagnostic limit, a refusal, and a cancel give no answer", async () => {
    expect((await probe({ stdout: CONTRACT, exit: { exitCode: 1 } })).result).toEqual({ failed: "GIT_FAILED" });
    expect((await probe({ stdout: CONTRACT, exit: { exitCode: 125 } })).result).toEqual({ failed: "GIT_FAILED" });
    expect((await probe({ stdout: CONTRACT, exit: { exitCode: null, deadline: "deadline" } })).result).toEqual({ stop: "deadline" });
    expect((await probe({ stdout: CONTRACT, exit: { diagnosticLimit: true } })).result).toEqual({ failed: "OUTPUT_LIMIT" });
    const refusing = {
      run: async () => {
        throw new RunnerRefusal("INVALID_REQUEST", "matchingProbe");
      },
    } as unknown as GitRunner;
    expect(await probeMatching(refusing, { operationId: crypto.randomUUID(), signal: new AbortController().signal, workspace }, MATCHING_PROBE_RUNS, () => {})).toEqual({ failed: "INVALID_REQUEST" });
    const controller = new AbortController();
    const canceled = await probe({ stdout: CONTRACT, exit: { exitCode: null }, during: () => controller.abort() }, controller);
    expect({ result: canceled.result, calls: canceled.calls.length }).toEqual({ result: { stop: "canceled" }, calls: 1 });
    const before = new AbortController();
    before.abort();
    const early = await probe({ stdout: CONTRACT }, before);
    expect({ result: early.result, calls: early.calls.length }).toEqual({ result: { stop: "canceled" }, calls: 0 });
  });
});

describe("matching rules (FR-022 to FR-024, SC-007)", () => {
  // tasks.md T033: the Windows end-to-end case is `Local: Windows`.
  const windowsCase = (name: string, body: () => Promise<void>) => {
    if (GIT !== null && WINDOWS) return void test(name, body, TIMEOUT_MS);
    console.log(`OBSERVATION ${TASK}: "${name}" runs only on Windows (Local: Windows); it did not run on ${process.platform}`);
    test.skip(name, body, TIMEOUT_MS);
  };

  windowsCase("each SC-007 case matches exactly its probe commits end to end, in the order of Git's own search", () =>
    withService("t033-cases", async (service) => {
      const repo = probeRepo("t033-cases");
      const { repositoryId, generation } = await service.register(repo);
      const view = await opened(service, repositoryId, generation);
      for (const [text, labels] of CASES) {
        const got = await searchOids(service, repositoryId, view.viewId, text);
        expect({ text, state: got.state, labels: got.oids.map(label).toSorted() }).toEqual({ text, state: "succeeded", labels: oidsOf(labels).map(label).toSorted() });
        expect({ text, order: got.oids }).toEqual({ text, order: grepOracle(repo, text) });
      }
    }),
  );

  caseTest(
    TASK,
    "the results stay equal under another LC_ALL and LANG, a user i18n.logOutputEncoding=ISO-8859-1 and grep.patternType=perl, and an inherited GIT_CONFIG_PARAMETERS",
    SHELL,
    async () => {
      const repo = probeRepo("t033-env");
      const config = join(FIXTURE_HOME, "t033-hostile.gitconfig");
      writeFileSync(config, `[user]\n\tname = ${FIXED_IDENTITY.name}\n\temail = ${FIXED_IDENTITY.email}\n[i18n]\n\tlogOutputEncoding = ISO-8859-1\n[grep]\n\tpatternType = perl\n`);
      const hostile = serviceEnv({ LC_ALL: "C", LANG: "C", LC_CTYPE: "C", GIT_CONFIG_GLOBAL: config, GIT_CONFIG_PARAMETERS: "'i18n.logoutputencoding'='ISO-8859-1'" });
      // FR-022: "probe." matches every probe message as a Perl pattern, and none as literal text.
      const texts = [...CASES.map(([text]) => text), "probe.", "PROBE"];
      const results: Outcome[][] = [];
      for (const [name, environment] of [["t033-default", undefined], ["t033-hostile", hostile]] as const) {
        await withService(
          name,
          async (service) => {
            const { repositoryId, generation } = await service.register(repo);
            const view = await opened(service, repositoryId, generation);
            const outcomes: Outcome[] = [];
            for (const text of texts) outcomes.push(await searchOids(service, repositoryId, view.viewId, text));
            results.push(outcomes);
          },
          environment === undefined ? {} : { environment },
        );
      }
      const [plain, changed] = results as [Outcome[], Outcome[]];
      expect(changed.map((o, i) => ({ text: texts[i], ...o }))).toEqual(plain.map((o, i) => ({ text: texts[i], ...o })));
      if (WINDOWS) {
        expect(plain.filter((o) => o.state !== "succeeded")).toEqual([]);
        expect({ literal: plain.at(-2)!.oids, folded: plain.at(-1)!.oids.length }).toEqual({ literal: [], folded: MATCHING_PROBE_COMMITS.length });
      } else console.log(`OBSERVATION ${TASK}: on ${process.platform}, the searches ended ${JSON.stringify([...new Set(plain.map((o) => o.code ?? o.state))])}`);
    },
    TIMEOUT_MS,
  );
});
