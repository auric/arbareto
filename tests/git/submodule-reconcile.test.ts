// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T230: the `updateSubmodules` lock set (contract §8 "Observed locks") and the recovery row states (contract §8 "Recovery statement").
// The lock and recovery cases run no Git process: a null HEAD reads no branch ref, and a row without a `.git` entry or a kept directory gets no Git read.
// The `registered` case is the control for that flag as the only effect.
// T116 adds the WSL process-end cases of the update and of the commit reconciliation (contract §4 "Commit process end", §12 "WSL repositories").

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { probeGit } from "../../src/git-service/git-installation";
import type { ObserveContext } from "../../src/git-service/hunk-publish";
import type { RetainedUpdate, UpdateRowRead } from "../../src/git-service/reconcile";
import { createRegistrations } from "../../src/git-service/registration";
import { createTrust } from "../../src/git-service/trust";
import type { RecordedCall } from "./bun-runner";
import { fixturePath, serviceEnv, useFixtureRoot } from "./fixture-root";
import { gitPath, underTest, until, withService } from "./hunk-harness";
import { caseTest, once, type Service } from "./service-harness";
import { countPath, flatName, nestedFlat } from "./submodule-count-fixture";
import { commandOf, gitLocation, insideSubmodule, treeGit } from "./submodule-harness";

type Reconcile = typeof import("../../src/git-service/reconcile");
type Recovery = typeof import("../../src/git-service/recovery");

const IDENTITY = { volumeSerial: "0".repeat(16), fileId: "1".repeat(32) };
const TARGET = "2".repeat(40);

useFixtureRoot();

describe("submoduleLocks (contract §8 \"Observed locks\")", () => {
  // A files-format workspace in a new folder. Its Git directory is also its common directory.
  function workspaceAt(name: string) {
    const gitDir = fixturePath(name, ".git");
    mkdirSync(gitDir, { recursive: true });
    const workspace = { worktreeRoot: fixturePath(name), indexPath: `${gitDir}/index`, gitDirectory: gitDir, commonDirectory: gitDir, refFormat: "files" };
    return { gitDir, ctx: { workspace, installation: { selectedPath: null }, signal: new AbortController().signal } as unknown as ObserveContext };
  }

  test("the set adds the superproject config.lock and index.lock and HEAD.lock of each plan Git directory, and names only existing files", async () => {
    const { submoduleLocks } = (await underTest("reconcile")) as Reconcile;
    const { gitDir, ctx } = workspaceAt("locks-set");
    const modules = ["a", "b"].map((m) => `${gitDir}/modules/${m}`);
    for (const dir of modules) mkdirSync(dir, { recursive: true });
    for (const file of ["index.lock", "config.lock", "modules/a/index.lock", "modules/a/HEAD.lock", "modules/b/HEAD.lock"]) writeFileSync(join(gitDir, file), "");
    expect(await submoduleLocks(ctx, null, [...modules, modules[0]!])).toEqual([`${gitDir}/index.lock`, `${gitDir}/config.lock`, `${modules[0]}/index.lock`, `${modules[0]}/HEAD.lock`, `${modules[1]}/HEAD.lock`]);
  });

  // Feature 004 contract Δ12 "Submodule bound" (T159 case g): `SUBMODULE_FOREIGN_CAP` is 5 + 2 × 1,024 = 2,053. Literal values, so a bound of 256 turns the case red.
  test("the list holds at most 5 + 2 × 1,024 files", async () => {
    const { submoduleLocks } = (await underTest("reconcile")) as Reconcile;
    const { gitDir, ctx } = workspaceAt("locks-cap");
    for (const file of ["index.lock", "HEAD.lock", "packed-refs.lock", "config.lock"]) writeFileSync(join(gitDir, file), "");
    const modules = Array.from({ length: 1_024 + 4 }, (_, i) => `${gitDir}/modules/m${i}`);
    for (const dir of modules) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/index.lock`, "");
      writeFileSync(`${dir}/HEAD.lock`, "");
    }
    const locks = await submoduleLocks(ctx, null, modules);
    if (!Array.isArray(locks)) throw new Error(`no locks: ${JSON.stringify(locks)}`);
    expect({ length: locks.length, first: locks[0], last: locks.at(-1) }).toEqual({ length: 2_053, first: `${gitDir}/index.lock`, last: `${modules[1_024]}/index.lock` });
    // The case writes 1,028 folders and 2,060 lock files and takes 3.1 to 3.5 s, near the 5 s Bun default.
  }, 30_000);
});

// Contract §11 "Paths and file access" and §12 "WSL repositories": a WSL workspace whose lock files lie in a local folder, so `lstat` reads no distro.
// `|` is valid in a Git ref name and a Linux name, but a Windows name cannot hold it.
function wslWorkspace(name: string, runs: { arguments: string[]; environmentPolicy: string }[], exits: ({ exitCode: number; activeDescendants: number } | Error)[], stdout = "") {
  const gitDir = fixturePath(name, ".git");
  mkdirSync(gitDir, { recursive: true });
  const workspace = {
    repositoryId: crypto.randomUUID(),
    gitInstallationId: crypto.randomUUID(),
    worktreeRoot: "\\\\wsl.localhost\\Arbareto-Test\\home\\u\\repo",
    indexPath: `${gitDir}\\index`,
    gitDirectory: gitDir,
    commonDirectory: gitDir,
    refFormat: "files",
    objectFormat: "sha1",
    wsl: { distro: "Arbareto-Test", guid: "{00000000-0000-4000-8000-000000000000}", path: "/usr/bin/git", wslExecutable: "C:\\Windows\\System32\\wsl.exe", systemdRun: "/usr/bin/systemd-run", systemctl: "/usr/bin/systemctl", setsid: "/usr/bin/setsid", noexpand: true },
  };
  const runner = {
    async run(call: { arguments: string[]; environmentPolicy: string; stdout: { push(b: Uint8Array): void } }) {
      runs.push({ arguments: call.arguments, environmentPolicy: call.environmentPolicy });
      const exit = exits.shift();
      if (exit === undefined) throw new Error("no queued run reply");
      if (exit instanceof Error) throw exit;
      if (stdout !== "") call.stdout.push(new TextEncoder().encode(stdout));
      return exit;
    },
    resolved: () => {},
    lingeringCount: async () => 0,
  };
  const ctx = { runner, workspace, operationId: crypto.randomUUID(), signal: new AbortController().signal, installation: { selectedPath: null } } as unknown as ObserveContext;
  return { gitDir, ctx, runner };
}

describe("WSL names without a UNC form (contract §11 \"Paths and file access\")", () => {
  test("a plan Git directory without a UNC form is an unavailable observation with UNSUPPORTED_REPOSITORY", async () => {
    const { submoduleLocks } = (await underTest("reconcile")) as Reconcile;
    const { ctx } = wslWorkspace("unc-locks", [], []);
    expect(await submoduleLocks(ctx, null, ["/home/u/repo/.git/modules/a|b"])).toEqual({ code: "UNSUPPORTED_REPOSITORY" });
  });

  test("a branch ref path without a UNC form is an unavailable observation with UNSUPPORTED_REPOSITORY", async () => {
    const { observedLocks } = (await underTest("hunk-publish")) as typeof import("../../src/git-service/hunk-publish");
    const runs: { arguments: string[]; environmentPolicy: string }[] = [];
    const { ctx } = wslWorkspace("unc-ref", runs, [{ exitCode: 0, activeDescendants: 0 }], "/home/u/repo/.git/refs/heads/a|b\n");
    expect(await observedLocks(ctx, { state: "branch", target: "refs/heads/a|b", oid: TARGET } as never)).toEqual({ code: "UNSUPPORTED_REPOSITORY" });
    expect(runs.map((r) => r.arguments.at(-1))).toEqual(["refs/heads/a|b"]);
  });
});

describe("process end before a WSL update reconciliation (contract §12 \"WSL repositories\")", () => {
  const update = { rows: [] } as unknown as RetainedUpdate;
  function registry(state: string) {
    const events: { type: string; code?: string }[] = [];
    return {
      events,
      get: () => ({ state, lingeringDescendants: 0 }),
      apply: (_op: string, event: { type: string; code?: string }) => void events.push(event),
      progress: () => {},
    };
  }
  const reconcile = async (canceled: boolean, deadline: string | null, ctx: ObserveContext, reg: ReturnType<typeof registry>, halt: { diagnosticLimit?: boolean; refused?: boolean } = {}) => {
    const { reconcileUpdate } = (await underTest("reconcile")) as Reconcile;
    const trust = { listTrust: async () => ({ ok: false, code: "GIT_FAILED" }), gate: () => null };
    await reconcileUpdate({
      registry: reg as never,
      runner: ctx.runner as never,
      retained: new Map(),
      operationId: ctx.operationId,
      markerId: "marker",
      ctx: { ...ctx, trust } as unknown as ObserveContext,
      update,
      head: { state: "detached", oid: TARGET } as never,
      canceled,
      deadline,
      lingeringDescendants: 0,
      diagnosticLimit: halt.diagnosticLimit ?? false,
      refused: halt.refused ?? false,
      foreign: [],
      remedy: () => null,
    });
  };

  test("after a Cancel, the version run comes first, and without its fact reconciliation fails with no read", async () => {
    const runs: { arguments: string[]; environmentPolicy: string }[] = [];
    const { ctx } = wslWorkspace("process-end-none", runs, [new (await import("../../src/git-service/git-runner")).RunnerRefusal("UNKNOWN_TARGET")]);
    const reg = registry("cancel-requested");
    await reconcile(true, null, ctx, reg);
    expect({ runs, last: reg.events.at(-1) }).toEqual({ runs: [{ arguments: ["--no-lazy-fetch", "version"], environmentPolicy: "mutation" }], last: { type: "reconciliation-read-failed", code: "GIT_FAILED" } });
  });

  test("after a deadline, a count of 0 is the fact, and reconciliation reads follow", async () => {
    const runs: { arguments: string[]; environmentPolicy: string }[] = [];
    const { ctx } = wslWorkspace("process-end-fact", runs, [{ exitCode: 0, activeDescendants: 0 }]);
    const reg = registry("running");
    let listed = 0;
    const trust = { listTrust: async () => (listed++, { ok: false, code: "OUTPUT_LIMIT" }), gate: () => null };
    const { reconcileUpdate } = (await underTest("reconcile")) as Reconcile;
    await reconcileUpdate({ registry: reg as never, runner: ctx.runner as never, retained: new Map(), operationId: ctx.operationId, markerId: "m", ctx: { ...ctx, trust } as unknown as ObserveContext, update, head: { state: "detached", oid: TARGET } as never, canceled: false, deadline: "inactivity", lingeringDescendants: 0, refused: false, foreign: [], remedy: () => null });
    expect({ runs, listed, last: reg.events.at(-1) }).toEqual({ runs: [{ arguments: ["--no-lazy-fetch", "version"], environmentPolicy: "mutation" }], listed: 1, last: { type: "reconciliation-read-failed", code: "OUTPUT_LIMIT" } });
  });

  // T116 B3-4: the §9 diagnostic cancel closes the Job, and a refusal after the start leaves open whether Git ran.
  test.each([
    ["the diagnostic limit", { diagnosticLimit: true }],
    ["a refused step start", { refused: true }],
  ] as const)("after %s, the version run comes first, and without its fact reconciliation fails with no read", async (_name, halt) => {
    const runs: { arguments: string[]; environmentPolicy: string }[] = [];
    const { ctx } = wslWorkspace(`process-end-${Object.keys(halt)[0]}`, runs, [new (await import("../../src/git-service/git-runner")).RunnerRefusal("UNKNOWN_TARGET")]);
    const reg = registry("running");
    await reconcile(false, null, ctx, reg, halt);
    expect({ runs, last: reg.events.at(-1) }).toEqual({ runs: [{ arguments: ["--no-lazy-fetch", "version"], environmentPolicy: "mutation" }], last: { type: "reconciliation-read-failed", code: "GIT_FAILED" } });
  });

  test("control: a run that ends without Cancel or deadline sends no version run", async () => {
    const runs: { arguments: string[]; environmentPolicy: string }[] = [];
    const { ctx } = wslWorkspace("process-end-plain", runs, []);
    const reg = registry("running");
    await reconcile(false, null, ctx, reg);
    expect({ runs, last: reg.events.at(-1) }).toEqual({ runs: [], last: { type: "reconciliation-read-failed", code: "GIT_FAILED" } });
  });
});

// T116 B3-3: contract §4 "Commit process end".
describe("process end before a WSL commit reconciliation (contract §4 \"Commit process end\")", () => {
  const VERSION = { arguments: ["--no-lazy-fetch", "version"], environmentPolicy: "mutation" };
  async function reconcile(name: string, exit: { exitCode: number | null; activeDescendants: number | null } | null, exits: ({ exitCode: number; activeDescendants: number } | Error)[]) {
    const { RunnerRefusal } = await import("../../src/git-service/git-runner");
    const { reconcileCommit } = (await underTest("reconcile")) as Reconcile;
    const runs: { arguments: string[]; environmentPolicy: string }[] = [];
    // Each read after the queued exits gets a refusal, so reconciliation ends unknown without a Git process.
    const { ctx } = wslWorkspace(name, runs, [...exits, ...Array.from({ length: 8 }, () => new RunnerRefusal("UNKNOWN_TARGET"))]);
    const refusing = async () => {
      throw new RunnerRefusal("UNKNOWN_TARGET");
    };
    let resolved = 0;
    const runner = { ...ctx.runner, wslFiles: refusing, resolved: () => void resolved++, lingeringCount: async () => 0 };
    const events: { type: string; code?: string }[] = [];
    const results: unknown[] = [];
    const registry = {
      get: () => ({ state: "running", lingeringDescendants: 0 }),
      apply: (_op: string, event: { type: string; code?: string }, result?: unknown) => void (events.push(event), results.push(result)),
      progress: () => {},
    };
    await reconcileCommit({
      registry: registry as never,
      runner: runner as never,
      retained: new Map(),
      operationId: ctx.operationId,
      markerId: "marker",
      ctx: { ...ctx, runner, reader: { operationState: refusing } } as never,
      review: {} as never,
      binding: { head: { state: "unborn", target: "refs/heads/main" }, reviewedIndex: { rawIndexDigest: null, sharedIndex: null }, operationState: "normal" } as never,
      tip: null,
      exit: exit as never,
      outputTail: "tail",
      foreign: [],
      remedy: () => null,
    });
    return { runs, last: events.at(-1), result: results.at(-1), resolved };
  }

  test.each([
    ["a Job close (exitCode null)", { exitCode: null, activeDescendants: null }],
    ["a refusal after the start (no exit)", null],
  ] as const)("after %s, the version run comes first, and without its fact the outcome is unknown with the tail and the marker stays", async (_name, exit) => {
    const { RunnerRefusal } = await import("../../src/git-service/git-runner");
    const r = await reconcile(`commit-end-none-${exit === null}`, exit, [new RunnerRefusal("UNKNOWN_TARGET")]);
    expect(r).toEqual({ runs: [VERSION], last: { type: "reconciliation-read-failed", code: "GIT_FAILED" }, result: { outputTail: "tail", lingeringDescendants: 0 }, resolved: 0 });
  });

  test("after a Job close, a count of 0 is the fact, and reconciliation reads follow", async () => {
    const r = await reconcile("commit-end-fact", { exitCode: null, activeDescendants: null }, [{ exitCode: 0, activeDescendants: 0 }]);
    expect({ first: r.runs[0], reads: r.runs.length > 1, versions: r.runs.filter((x) => Bun.deepEquals(x, VERSION)).length }).toEqual({ first: VERSION, reads: true, versions: 1 });
  });

  test("control: a commit process that exits by itself sends no version run", async () => {
    const r = await reconcile("commit-end-plain", { exitCode: 0, activeDescendants: 0 }, []);
    expect({ reads: r.runs.length > 0, versions: r.runs.filter((x) => Bun.deepEquals(x, VERSION)).length }).toEqual({ reads: true, versions: 0 });
  });
});

describe("classifyUpdate: the registered flag alone (contract §12 \"Reconciliation and outcome\")", () => {
  test("a failed step whose only effect is a registration gives failed-with-effects", async () => {
    const { classifyUpdate } = (await underTest("reconcile")) as Reconcile;
    const old = "1".repeat(40);
    const keys = { "submodule.solo.active": ["true"] };
    const { event, rows } = classifyUpdate({
      rows: [
        {
          rowId: "00000000-0000-4000-8000-000000000001",
          path: "solo",
          found: false,
          planned: "moved",
          oldCommit: old,
          target: TARGET,
          baseline: {},
          phase: { fetched: false, connected: false, failedStep: { firstFetch: false, outputTail: "fatal: failed\n", exitCode: 1, remedy: { command: null, text: "retry" } } },
          observed: { value: { head: old, gitEntry: true, refs: true, keys } },
        },
      ],
      stop: null,
    });
    expect({ event, registered: rows[0]!.registered }).toEqual({ event: { type: "failed-with-effects" }, registered: true });
  });
});

describe("recovery of an unknown update (contract §8 \"Recovery statement\")", () => {
  test("the refresh states each retained row from new reads, sends resolved, and drops the retained update", async () => {
    const { createRecovery } = (await underTest("recovery")) as Recovery;
    const workspace = { repositoryId: "repo", commonIdentity: IDENTITY, worktreeIdentity: [IDENTITY], worktreeRoot: fixturePath("recovery"), objectFormat: "sha1" };
    const resolved: string[] = [];
    // The superproject configuration still holds the keys that the failed clone wrote (research R14 S37).
    const entry = (key: string, value: string) => ({ scope: "local", origin: "file:.git/config", key, value, exact: true, originBytes: new Uint8Array(), keyValueBytes: new TextEncoder().encode(`${key}\n${value}`) });
    const listing = { entries: [entry("submodule.solo.active", "true"), entry("submodule.solo.url", "C:/fixture/solo.git")], fingerprint: "f" };
    const runner = { resolved: (id: string) => resolved.push(id), fileFacts: async (r: { files: unknown[] }) => r.files.map(() => ({ kind: "absent" })) };
    const trust = { listTrust: async () => ({ ok: true, listing }), gate: () => null, view: () => ({ state: "trusted" }) };
    const updates = new Map<string, RetainedUpdate>([
      [
        "op",
        {
          rows: [
            {
              rowId: "00000000-0000-4000-8000-000000000001",
              path: "solo",
              found: false,
              planned: "cloned",
              oldCommit: null,
              target: TARGET,
              baseline: {},
              phase: { fetched: false, connected: true, failedStep: { firstFetch: false, outputTail: "fatal: clone failed\n", exitCode: 128, remedy: { command: null, text: "clone" } } },
              read: { components: ["solo"], name: "solo", kept: null, parent: null },
            },
          ],
        },
      ],
    ]);
    const recovery = createRecovery({
      runner,
      registry: { get: () => undefined },
      trust,
      reader: { recoveryState: () => "ready" },
      publications: new Map(),
      commits: new Map(),
      updates,
    } as unknown as Parameters<Recovery["createRecovery"]>[0]);
    recovery.settled({ operationId: "op", workspace } as never, "marker", [IDENTITY] as never);
    const outcome = { result: "succeeded", value: { head: { state: "branch", target: "refs/heads/main", oid: TARGET } } };
    const refreshed = await recovery.refresh({ operationId: "read", signal: new AbortController().signal, workspace, installation: {} } as never, outcome as never);
    expect({ recovery: (refreshed as { value?: { recovery?: unknown } }).value?.recovery, resolved, kept: updates.has("op") }).toEqual({
      recovery: {
        outcome: "unknown",
        submoduleResults: [
          { rowId: "00000000-0000-4000-8000-000000000001", path: "solo", state: "failed", oldCommit: null, newCommit: null, fetched: false, connected: true, found: false, registered: true, outputTail: "fatal: clone failed\n", exitCode: 128, remedy: { command: null, text: "clone" } },
        ],
      },
      resolved: ["marker"],
      kept: false,
    });
  });
});

// Feature 004 FR-113, contract Δ12 "Update reads": the reconciliation reads up to 8 rows at once and applies in row order (T152 case h).
describe("parallel reconciliation reads (004 FR-113, contract Δ12 \"Update reads\")", () => {
  // The most calls that ran at the same time, from the start and the duration of each call.
  const peakOf = (calls: readonly { at: number; durationMs?: number }[]) => {
    const edges = calls.flatMap((c) => [[c.at, 1], [c.at + (c.durationMs ?? 0), -1]] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let now = 0;
    let peak = 0;
    for (const [, step] of edges) peak = Math.max(peak, (now += step));
    return peak;
  };

  const cmd = (c: { arguments: readonly string[] }) => commandOf(c.arguments).join(" ");
  type Match = (c: { arguments: readonly string[] }) => boolean;
  // Row p and its 9 nested rows, in the index order of their paths. `observe` runs `observeUpdateRows` in a new operation and gives its Git calls inside the submodules.
  async function withRows(name: string, body: (rows: { w: ReturnType<typeof nestedFlat>; service: Service; paths: string[]; atRow: (path: string) => Match; observe: (lanes: number) => Promise<{ read: Awaited<ReturnType<Reconcile["observeUpdateRows"]>>; calls: RecordedCall[] }> }) => Promise<void>) {
    const { observeUpdateRows } = (await underTest("reconcile")) as Reconcile;
    const nested = Array.from({ length: 9 }, (_, i) => ({ path: countPath(i), name: flatName(i) })).sort((a, b) => (a.path < b.path ? -1 : 1));
    const w = nestedFlat(name, 9);
    const paths = ["p", ...nested.map((e) => `p/${e.path}`)];
    const parent: UpdateRowRead = { components: ["p"], name: "p", kept: null, parent: null };
    const reads: UpdateRowRead[] = [parent, ...nested.map((e) => ({ components: ["p", ...e.path.split("/")], name: e.name, kept: null, parent }))];
    const atRow = (path: string) => (c: { arguments: readonly string[] }) => {
      const location = gitLocation(c.arguments);
      return location !== null && relative(join(w.sup, ...path.split("/")), resolve(w.sup, location)) === "";
    };
    await withService({ name, environment: serviceEnv(w.env) }, async (service) => {
      const probed = await probeGit(service.runner, { bootstrapId: service.runner.addContext("gitProbe", gitPath()), executablePath: gitPath() });
      if (!("installation" in probed)) throw new Error(`probe failed: ${JSON.stringify(probed)}`);
      const registrations = createRegistrations({ runner: service.runner, unfinishedMutation: () => false });
      const registered = await registrations.register({ operationId: crypto.randomUUID(), bootstrapId: service.runner.addContext("repositoryDiscovery", w.sup), installation: probed.installation, signal: new AbortController().signal });
      if (!registered.ok || !("repositoryId" in registered.result)) throw new Error(`registration failed: ${JSON.stringify(registered)}`);
      const workspace = registrations.get(registered.result.repositoryId)!;
      const trust = createTrust({ runner: service.runner, environment: serviceEnv(w.env) });
      const observe = async (lanes: number) => {
        const operationId = crypto.randomUUID();
        const ctx = { runner: service.runner, trust, workspace, installation: probed.installation, operationId, signal: new AbortController().signal } as unknown as ObserveContext;
        const read = await observeUpdateRows(ctx, reads, lanes);
        return { read, calls: service.runner.calls.filter((c) => c.operationId === operationId && insideSubmodule(w.sup, c.arguments)) };
      };
      await body({ w, service, paths, atRow, observe });
    });
  }

  caseTest("T152", "T152 case h: the reconciliation of 10 rows gives the same observations in row order with 1 and 8 lanes; 8 lanes run at least 2 Git processes at once and one config list in the parent, and a failing read of row 4 gives that failure", ["shell-double"], async () => {
    await withRows("t152-reconcile", async ({ w, service, paths, atRow, observe: run }) => {
      const observe = async (lanes: number) => {
        const { read, calls } = await run(lanes);
        return { read, peak: peakOf(calls), parentConfig: calls.filter((c) => atRow("p")(c) && cmd(c) === "config list --show-scope --show-origin -z").length };
      };
      const one = await observe(1);
      const eight = await observe(8);
      // Row 4 fails with GIT_FAILED after its HEAD read. Row 7 fails with MALFORMED_GIT_OUTPUT before that, without a process.
      service.runner.inject.exit = (c) => (atRow(paths[4]!)(c) && cmd(c) === "rev-parse --absolute-git-dir" ? 128 : undefined);
      service.runner.inject.stdout = (c) => (atRow(paths[7]!)(c) && cmd(c) === "rev-parse --verify -q HEAD" ? new TextEncoder().encode("x\n") : undefined);
      let failing: Awaited<ReturnType<typeof observe>>;
      try {
        failing = await observe(8);
      } finally {
        service.runner.inject.exit = undefined;
        service.runner.inject.stdout = undefined;
      }
      console.log(`OBSERVATION T152 case h: peak 1 lane ${one.peak}, 8 lanes ${eight.peak}`);
      expect({
        same: Bun.deepEquals(one.read, eight.read, true),
        heads: "value" in eight.read ? eight.read.value.observations.map((o) => o.head) : eight.read,
        gitDirs: "value" in eight.read ? eight.read.value.gitDirs.length : eight.read,
        peaks: [one.peak, eight.peak >= 2, eight.peak <= 9],
        parentConfig: [one.parentConfig, eight.parentConfig],
        failing: failing.read,
      }).toEqual({
        same: true,
        heads: paths.map((path) => treeGit(w, join(w.sup, ...path.split("/")), ["rev-parse", "HEAD"]).trim()),
        gitDirs: 10,
        peaks: [1, true, true],
        parentConfig: [1, 1],
        failing: { code: "GIT_FAILED" },
      });
    });
  }, 5 * 60_000);

  // Contract Δ12 "Parallel reads", Failures: after the first failed row in row order, no later read starts.
  caseTest("T152", "T152 case k: row p fails at its first read while the first reads of rows 1 to 7 wait; no later reconciliation read starts, and each read ends before the result", ["shell-double"], async () => {
    await withRows("t152-reconcile-stop", async ({ service, paths, atRow, observe }) => {
      const { runner } = service;
      const firstRead = (c: { arguments: readonly string[] }) => cmd(c) === "rev-parse --verify -q HEAD";
      const isFailing = (c: { arguments: readonly string[] }) => atRow("p")(c) && firstRead(c);
      const later = paths.slice(1, 8).map(atRow);
      // Row p gives a HEAD line that is no object ID, so it fails with MALFORMED_GIT_OUTPUT without a process.
      runner.inject.stdout = (c) => (isFailing(c) ? new TextEncoder().encode("x\n") : undefined);
      const held = new Set<object>();
      const heldRows = new Set<number>();
      const resume = runner.pauseStdout((c) => {
        if (held.has(c)) return true;
        const row = later.findIndex((match) => match(c));
        if (row < 0 || heldRows.has(row) || !firstRead(c)) return false;
        heldRows.add(row);
        held.add(c);
        return true;
      });
      let pending: ReturnType<typeof observe> | null = null;
      let result: Awaited<ReturnType<typeof observe>>;
      try {
        pending = observe(8);
        await until(() => held.size === 7 && runner.calls.some((c) => isFailing(c) && c.exit !== undefined), "the failed read of p while the first reads of rows 1 to 7 wait", 60_000);
      } finally {
        resume();
        runner.inject.stdout = undefined;
        result = await pending!;
      }
      const doneAt = performance.now();
      const failed = result.calls.filter(isFailing);
      const failedAt = failed.length === 1 && failed[0]!.durationMs !== undefined ? failed[0]!.at + failed[0]!.durationMs : Number.POSITIVE_INFINITY;
      expect({
        read: result.read,
        failed: failed.length,
        late: result.calls.filter((c) => c.at > failedAt).map((c) => [gitLocation(c.arguments), cmd(c)]),
        open: result.calls.filter((c) => c.durationMs === undefined || c.at + c.durationMs > doneAt).length,
      }).toEqual({ read: { code: "MALFORMED_GIT_OUTPUT" }, failed: 1, late: [], open: 0 });
    });
  }, 5 * 60_000);

  // Contract Δ12 "Job close", note of 2026-11-07: a recorded deadline decides before an earlier failed row.
  // `reconcileUpdate` turns the deadline stop into `reconciliation-read-deadline`, so the update ends `unknown` with DEADLINE, not with the code of row p.
  caseTest("T152", "T152 case l: row p fails at its first read, and then the held first read of row 3 records a 1 ms deadline: the reconciliation reads end with the deadline stop", ["shell-double"], async () => {
    await withRows("t152-reconcile-deadline", async ({ service, paths, atRow, observe }) => {
      const { runner } = service;
      const firstRead = (c: { arguments: readonly string[] }) => cmd(c) === "rev-parse --verify -q HEAD";
      const isFailing = (c: { arguments: readonly string[] }) => atRow("p")(c) && firstRead(c);
      const isTarget = (c: { arguments: readonly string[] }) => atRow(paths[3]!)(c) && firstRead(c);
      runner.inject.stdout = (c) => (isFailing(c) ? new TextEncoder().encode("x\n") : undefined);
      // The start hold comes first, so the deadline hook sees the target only after its release.
      const heldTarget = once(isTarget);
      const releaseTarget = runner.holdStart(heldTarget);
      let armed = true;
      const releaseHook = runner.holdStart((call) => {
        if (armed && heldTarget(call)) {
          armed = false;
          runner.inject.deadlineMs = 1;
          queueMicrotask(() => void (runner.inject.deadlineMs = null));
        }
        return false;
      });
      let pending: ReturnType<typeof observe> | null = null;
      let result: Awaited<ReturnType<typeof observe>>;
      try {
        pending = observe(8);
        await until(() => runner.calls.some((c) => isFailing(c) && c.exit !== undefined) && runner.calls.some(isTarget), "the failed read of p and the held read of row 3", 60_000);
        releaseTarget();
        // The held read checks the start holds again in a later microtask. The hook must still be there then.
        result = await pending;
      } finally {
        releaseTarget();
        releaseHook();
        runner.inject.stdout = undefined;
        await pending?.catch(() => undefined);
      }
      const exits = (match: Match) => result.calls.filter(match).map((c) => [c.exit?.exitCode ?? null, c.exit?.deadline ?? null]);
      expect({ read: result.read, failing: exits(isFailing), target: exits(isTarget) }).toEqual({ read: { stop: "deadline" }, failing: [[0, null]], target: [[null, "deadline"]] });
    });
  }, 5 * 60_000);
});
