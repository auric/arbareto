// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T053: Choose ours, Choose theirs, and Open in merge tool (spec FR-089 to FR-097, SC-015, plan.md D7, contract Δ3 `choose-side` and `mergetool`, data-model §11, quickstart.md Q13 and Q14).
// The oracle is Git's own `checkout --ours`, `checkout --theirs`, and `mergetool` on a second build of the same fixture.

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SUBMODULE_UPDATE_CEILING_MS } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import { FIXTURE_HOME, fixtureDir, useFixtureRoot } from "./fixture-root";
import { put } from "./fixtures";
import { workingFileDigests } from "./git-oracle";
import { caseTest, type RegistrationResult, type Service, type ServiceResponse } from "./service-harness";
import { gitExe, native, TIMEOUT_MS, until, withSync } from "./sync-harness";
import { buildWorkbench, canary, FIXTURE_MERGE_RESULT, repoOf, wb, type WbRepo } from "./workbench-fixtures";

for (const module of ["resolve", "workbench-review", "session"]) {
  try {
    printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
  } catch {
    console.log(`ORIGIN absent src/git-service/${module}.ts`);
  }
}
printOrigin("../../src/contracts/envelope.ts", import.meta.dir);
// Until T060 imports `resolve.ts` in `session.ts`, this import registers the resolve actions in the dispatcher of `workbench-review.ts`.
await import("../../src/git-service/resolve");

useFixtureRoot();

const TASK = "T053";
const SHELL = ["shell-double"] as const;
const L = "--no-lazy-fetch";
const SUCCEEDED = { state: "succeeded", code: undefined };
const outcome = (r: { state: string; code?: string }) => ({ state: r.state, code: r.code });
const unavailable = (reason: string) => ({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason } });
const refused = (response: ServiceResponse<unknown>) => ({ ...outcome(response), result: response.result });

// The entries of the conflict fixtures (`workbench-fixtures.ts` `buildConflict`) with their porcelain v2 XY code and the data-model §11 text.
const KINDS = {
  "uu.txt": ["UU", "Both modified"],
  "aa.txt": ["AA", "Both added"],
  "au.txt": ["AU", "Added by us"],
  "ua.txt": ["UA", "Added by them"],
  "du.txt": ["DU", "Deleted by us"],
  "ud.txt": ["UD", "Deleted by them"],
  "dd.txt": ["DD", "Both deleted"],
  link: ["UU", "Both modified"],
} as const;
const PATHS = Object.keys(KINDS) as (keyof typeof KINDS)[];

interface Reviewed {
  action: string;
  plan: Record<string, unknown>;
  workbenchToken: string;
}

interface ResolveRun {
  action: string;
  staged: boolean;
  operationState: string;
  outputTail?: string;
}

type Variant = "merge" | "rebase";
let builds = 0;
const build = (variant: Variant): WbRepo => repoOf(buildWorkbench(gitExe(), variant === "merge" ? "conflict-merge" : "conflict-rebase", `t053-${variant}-${++builds}`));
const git = (r: WbRepo, args: string[], allowExit: readonly number[] | "any" = [0], input?: string) => wb(r, args, { allowExit, ...(input === undefined ? {} : { input }) });
const text = (r: WbRepo, args: string[]) => git(r, args).stdout.toString("utf8");
const oid = (r: WbRepo, rev: string) => text(r, ["rev-parse", "--verify", "-q", rev]).trim();
const b64 = (path: string) => Buffer.from(path).toString("base64");

// git-ls-files(1) `--stage -z` of one path: `<mode> SP <object> SP <stage> TAB <path> NUL`.
function stagesOf(r: WbRepo, path: string) {
  return text(r, ["--literal-pathspecs", "ls-files", "-z", "--stage", "--", path])
    .split("\0")
    .filter((record) => record !== "")
    .map((record) => {
      const [mode, object, stage] = record.slice(0, record.indexOf("\t")).split(" ");
      return { stage: Number(stage), mode, oid: object };
    });
}

// SC-015: the index, every working byte, HEAD, the refs, and the operation markers.
function stateOf(r: WbRepo) {
  return {
    index: text(r, ["ls-files", "-s", "-z"]),
    files: workingFileDigests(r.dir),
    head: oid(r, "HEAD"),
    refs: text(r, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    merging: git(r, ["show-ref", "--exists", "MERGE_HEAD"], [0, 2]).exitCode,
    rebasing: git(r, ["show-ref", "--exists", "REBASE_HEAD"], [0, 2]).exitCode,
  };
}

// Keys in the owned global file of this test process (`fixture-root.ts`). The case removes them again.
async function withGlobal(entries: [string, string][], body: () => Promise<void>): Promise<void> {
  const home: WbRepo = { git: gitExe(), dir: FIXTURE_HOME, env: {} };
  for (const [key, value] of entries) git(home, ["config", "--global", key, value]);
  try {
    await body();
  } finally {
    for (const [key] of entries) git(home, ["config", "--global", "--unset-all", key], [0, 5]);
  }
}

const open = (service: Service, r: WbRepo): Promise<RegistrationResult> => service.register(native(r.dir));

// The shown read and one conflicted entry of it (contract Δ3: `choose-side` and `mergetool` name an entry of the shown snapshot).
async function shown(service: Service, r: RegistrationResult, path: string) {
  const read = await service.readWorkspace(r.repositoryId);
  expect(outcome(read)).toEqual(SUCCEEDED);
  const entry = read.result!.entries.find((e) => e.path === path && e.category === "conflicted");
  expect({ path, listed: entry !== undefined }).toEqual({ path, listed: true });
  return { generation: read.result!.generation, entry: { snapshotId: read.result!.snapshotId, entryId: entry!.entryId } };
}

async function review(service: Service, r: RegistrationResult, path: string, payload: { action: "choose-side"; side: "ours" | "theirs" } | { action: "mergetool" }) {
  const at = await shown(service, r, path);
  return service.request<Reviewed>("reviewWorkbench", { ...payload, ...at.entry }, { repositoryId: r.repositoryId, repositoryGeneration: at.generation });
}

async function reviewed(service: Service, r: RegistrationResult, path: string, payload: Parameters<typeof review>[3]): Promise<Reviewed> {
  const response = await review(service, r, path, payload);
  expect({ path, ...outcome(response), result: response.state === "succeeded" ? "result" : response.result }).toEqual({ path, ...SUCCEEDED, result: "result" });
  return response.result!;
}

const sendRun = (service: Service, r: RegistrationResult, token: string) => service.send("runWorkbench", { workbenchToken: token, start: true }, { repositoryId: r.repositoryId });
const run = (service: Service, r: RegistrationResult, token: string) => service.response<ResolveRun>(sendRun(service, r, token));

// The steps after `from`: every process under the policies `integrate` and `mergetool`.
const steps = (service: Service, from = 0) =>
  service.runner.calls
    .slice(from)
    .filter((c) => c.environmentPolicy === "integrate" || c.environmentPolicy === "mergetool")
    .map((c) => ({ policy: c.environmentPolicy, args: [...c.arguments] }));
const gitCommands = (service: Service, from: number) => service.runner.calls.slice(from).map((c) => c.arguments.find((a) => !a.startsWith("-")));

const names = (r: WbRepo) => ({ ours: { oid: oid(r, "main"), refs: ["refs/heads/main"] }, theirs: { oid: oid(r, "topic"), refs: ["refs/heads/topic"] } });
const operationOf = (variant: Variant) => (variant === "merge" ? "merging" : "rebasing");

for (const variant of ["merge", "rebase"] as const) {
  caseTest(
    TASK,
    `FR-089 to FR-092 and quickstart Q13 (${variant}): each kind gives its text and the side names; Choose ours and Choose theirs equal Git's own checkout on a copy and keep the path unmerged; a side that Git refuses gives side-missing, and a link stage gives side-not-regular`,
    SHELL,
    async () => {
      for (const side of ["ours", "theirs"] as const) {
        const f = build(variant);
        const o = build(variant);
        const ran: string[] = [];
        await withSync(`t053-choose-${variant}-${side}`, async (service) => {
          const r = await open(service, f);
          for (const path of PATHS) {
            const stages = stagesOf(f, path);
            const response = await review(service, r, path, { action: "choose-side", side });
            // FR-092: a link stage is no regular file. Git's own checkout would write it, so the copy gets no command.
            if (path === "link") {
              expect({ path, ...refused(response) }).toEqual({ path, ...unavailable("side-not-regular") });
              continue;
            }
            // Git's own command on the copy decides whether the side exists.
            if (git(o, ["--literal-pathspecs", "checkout", `--${side}`, "--", path], "any").exitCode !== 0) {
              expect({ path, ...refused(response) }).toEqual({ path, ...unavailable("side-missing") });
              continue;
            }
            expect({ path, ...outcome(response) }).toEqual({ path, ...SUCCEEDED });
            const [xy, kind] = KINDS[path];
            expect(response.result!.plan).toEqual({ path: b64(path), kind: { xy, text: kind }, stages, names: names(f), operation: operationOf(variant), side });
            const from = service.runner.calls.length;
            const done = await run(service, r, response.result!.workbenchToken);
            expect({ path, ...outcome(done), result: done.result }).toEqual({ path, ...SUCCEEDED, result: { action: "choose-side", staged: false, operationState: operationOf(variant) } });
            expect(steps(service, from)).toEqual([{ policy: "integrate", args: [L, "--literal-pathspecs", "checkout", "--no-recurse-submodules", `--${side}`, "--", path] }]);
            expect(stagesOf(f, path)).toEqual(stages);
            ran.push(path);
          }
        });
        expect(ran).toEqual(side === "ours" ? ["uu.txt", "aa.txt", "au.txt", "ud.txt"] : ["uu.txt", "aa.txt", "ua.txt", "du.txt"]);
        expect(stateOf(f)).toEqual(stateOf(o));
      }
    },
    TIMEOUT_MS,
  );
}

// A conflicted `[ab].txt` beside the tracked `a.txt` and `b.txt`. As a glob, `[ab].txt` matches both of them.
function bracketFixture(): WbRepo {
  const r: WbRepo = { git: gitExe(), dir: join(fixtureDir("t053-brackets"), "repo"), env: {} };
  mkdirSync(r.dir, { recursive: true });
  git(r, ["init", "-q", "-b", "main"]);
  for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.filemode", "false"]] as const) git(r, ["config", key, value]);
  const write = (content: Record<string, string>) => Object.entries(content).forEach(([path, bytes]) => put(r.dir, path, bytes));
  write({ "[ab].txt": "ab base\n", "a.txt": "a\n", "b.txt": "b\n" });
  git(r, ["add", "-A"]);
  git(r, ["commit", "-q", "-m", "base"]);
  git(r, ["checkout", "-q", "-b", "topic"]);
  write({ "[ab].txt": "ab theirs\n" });
  git(r, ["commit", "-q", "-a", "-m", "theirs"]);
  git(r, ["checkout", "-q", "main"]);
  write({ "[ab].txt": "ab ours\n" });
  git(r, ["commit", "-q", "-a", "-m", "ours"]);
  git(r, ["merge", "--no-edit", "topic"], [1]);
  write({ "a.txt": "a changed\n", "b.txt": "b changed\n" });
  return r;
}

caseTest(TASK, "FR-004 and contract Δ3: Choose ours for a conflicted [ab].txt changes only [ab].txt, and every byte of the changed a.txt and b.txt stays", SHELL, async () => {
  const r = bracketFixture();
  const bytes = (path: string) => readFileSync(join(r.dir, path)).toString("latin1");
  const index = text(r, ["ls-files", "-s", "-z"]);
  await withSync("t053-brackets", async (service) => {
    const reg = await open(service, r);
    const rv = await reviewed(service, reg, "[ab].txt", { action: "choose-side", side: "ours" });
    expect(outcome(await run(service, reg, rv.workbenchToken))).toEqual(SUCCEEDED);
  });
  expect({ a: bytes("a.txt"), b: bytes("b.txt"), ab: bytes("[ab].txt") }).toEqual({ a: "a changed\n", b: "b changed\n", ab: "ab ours\n" });
  expect(text(r, ["ls-files", "-s", "-z"])).toBe(index);
}, TIMEOUT_MS);

caseTest(TASK, "FR-092: a change of the working file or the stages after the review gives STALE_REVIEW, a change of the stages after the shown read gives STALE_SELECTION, and no step starts", SHELL, async () => {
  const f = build("merge");
  await withSync("t053-stale", async (service) => {
    const r = await open(service, f);
    // A full read replaces the shown snapshot, so each run follows its review without a read between them.
    const from = service.runner.calls.length;
    const working = await reviewed(service, r, "uu.txt", { action: "choose-side", side: "theirs" });
    writeFileSync(join(f.dir, "uu.txt"), "edited after the review\n");
    expect(outcome(await run(service, r, working.workbenchToken))).toEqual({ state: "failed", code: "STALE_REVIEW" });
    const stages = await reviewed(service, r, "aa.txt", { action: "choose-side", side: "ours" });
    // `git add` replaces the stages 2 and 3 of the path with one stage-0 entry.
    git(f, ["add", "--", "aa.txt"]);
    expect(outcome(await run(service, r, stages.workbenchToken))).toEqual({ state: "failed", code: "STALE_REVIEW" });
    expect(steps(service, from)).toEqual([]);
    const at = await shown(service, r, "ud.txt");
    git(f, ["add", "--", "ud.txt"]);
    const response = await service.request("reviewWorkbench", { action: "choose-side", side: "ours", ...at.entry }, { repositoryId: r.repositoryId, repositoryGeneration: at.generation });
    expect(outcome(response)).toEqual({ state: "failed", code: "STALE_SELECTION" });
    expect(steps(service, from)).toEqual([]);
  });
  expect(readFileSync(join(f.dir, "uu.txt"), "utf8")).toBe("edited after the review\n");
}, TIMEOUT_MS);

caseTest(TASK, "SC-015 and FR-089: the working text decides nothing; a file without conflict markers gets the same plan and the same step", SHELL, async () => {
  const f = build("merge");
  await withSync("t053-markers", async (service) => {
    const r = await open(service, f);
    const marked = await reviewed(service, r, "uu.txt", { action: "choose-side", side: "ours" });
    writeFileSync(join(f.dir, "uu.txt"), "no conflict markers\n");
    const plain = await reviewed(service, r, "uu.txt", { action: "choose-side", side: "ours" });
    expect(plain.plan).toEqual(marked.plan);
    expect(outcome(await run(service, r, plain.workbenchToken))).toEqual(SUCCEEDED);
  });
  expect(readFileSync(join(f.dir, "uu.txt"), "utf8")).toBe("uu ours\n");
}, TIMEOUT_MS);

for (const variant of ["merge", "rebase"] as const) {
  caseTest(
    TASK,
    `FR-093 to FR-096 and quickstart Q13 (${variant}): Open in merge tool equals Git's own mergetool on a copy under the policy mergetool with empty stdin and the ceiling alone; the fresh read says Git staged the path; the .orig backup stays; the delete forms give stages-missing and a link stage side-not-regular`,
    SHELL,
    () =>
      withGlobal([["merge.tool", "fixture"]], async () => {
        const f = build(variant);
        const o = build(variant);
        const origin = originOf(f, "merge.tool");
        await withSync(`t053-mergetool-${variant}`, async (service) => {
          const r = await open(service, f);
          for (const path of PATHS) {
            const stages = stagesOf(f, path);
            const response = await review(service, r, path, { action: "mergetool" });
            if (path === "link") {
              expect({ path, ...refused(response) }).toEqual({ path, ...unavailable("side-not-regular") });
              continue;
            }
            // FR-094: Git's mergetool asks on its terminal for a delete conflict, so only stages 2 and 3 of regular files pass.
            if (path !== "uu.txt" && path !== "aa.txt") {
              expect({ path, ...refused(response) }).toEqual({ path, ...unavailable("stages-missing") });
              continue;
            }
            const [xy, kind] = KINDS[path];
            expect({ path, ...outcome(response) }).toEqual({ path, ...SUCCEEDED });
            expect(response.result!.plan).toEqual({ path: b64(path), kind: { xy, text: kind }, stages, names: names(f), operation: operationOf(variant), tool: { name: "fixture", scope: "global", origin } });
            const from = service.runner.calls.length;
            const done = await run(service, r, response.result!.workbenchToken);
            expect({ path, ...outcome(done), result: done.result }).toEqual({ path, ...SUCCEEDED, result: { action: "mergetool", staged: true, operationState: operationOf(variant) } });
            expect(steps(service, from)).toEqual([{ policy: "mergetool", args: [L, "--literal-pathspecs", "mergetool", "--tool=fixture", "--no-prompt", "--", path] }]);
            const call = service.runner.calls.slice(from).find((c) => c.environmentPolicy === "mergetool")!;
            expect({ input: call.input, limits: call.limits }).toEqual({ input: undefined, limits: { ceilingMs: SUBMODULE_UPDATE_CEILING_MS } });
            expect(progressPhases(service, done.operationId)).toContain("mergetool");
            git(o, ["--literal-pathspecs", "mergetool", "--tool=fixture", "--no-prompt", "--", path], [0], "");
          }
          // FR-096: the fresh status read lists the backup files, and the service deletes none.
          const read = await service.readWorkspace(r.repositoryId);
          expect(read.result!.entries.filter((e) => e.category === "untracked").map((e) => e.path).toSorted()).toEqual(["aa.txt.orig", "uu.txt.orig"]);
        });
        expect(stateOf(f)).toEqual(stateOf(o));
        expect(readFileSync(join(f.dir, "uu.txt"), "utf8")).toBe(FIXTURE_MERGE_RESULT);
        expect(stagesOf(f, "uu.txt").map((s) => s.stage)).toEqual([0]);
      }),
    TIMEOUT_MS,
  );
}

// git-config(1) `list --show-origin -z`: `<scope> NUL <origin> NUL <key> LF <value> NUL` for each entry. The last entry of a key wins.
function originOf(r: WbRepo, key: string): string | undefined {
  const fields = text(r, ["config", "list", "--show-scope", "--show-origin", "-z"]).split("\0");
  let origin: string | undefined;
  for (let i = 0; i + 2 < fields.length; i += 3) if (fields[i + 2]!.split("\n")[0] === key) origin = fields[i + 1];
  return origin;
}

function progressPhases(service: Service, operationId: string | undefined): unknown[] {
  return service.progress.filter((e) => (e as { operationId?: string }).operationId === operationId).map((e) => (e as { phase?: string }).phase);
}

caseTest(TASK, "FR-096: the exit code never decides; a tool that leaves the file unchanged stages nothing, as Git's own mergetool on a copy, and an injected exit 0 without a process also leaves the path unmerged", SHELL, () =>
  withGlobal([["merge.tool", "keep"], ["mergetool.keep.cmd", "true"]], async () => {
    const f = build("merge");
    const o = build("merge");
    await withSync("t053-exit", async (service) => {
      const r = await open(service, f);
      const kept = await reviewed(service, r, "uu.txt", { action: "mergetool" });
      const from = service.runner.calls.length;
      const done = await run(service, r, kept.workbenchToken);
      expect({ ...outcome(done), staged: done.result?.staged }).toEqual({ state: "failed", code: "GIT_FAILED", staged: false });
      expect(service.runner.calls.slice(from).find((c) => c.environmentPolicy === "mergetool")!.exit!.exitCode).not.toBe(0);
      const injected = await reviewed(service, r, "aa.txt", { action: "mergetool" });
      service.runner.inject.exit = (call) => (call.arguments.includes("mergetool") ? 0 : undefined);
      try {
        const zero = await run(service, r, injected.workbenchToken);
        expect({ ...outcome(zero), staged: zero.result?.staged }).toEqual({ state: "failed", code: "GIT_FAILED", staged: false });
      } finally {
        service.runner.inject.exit = undefined;
      }
    });
    git(o, ["--literal-pathspecs", "mergetool", "--tool=keep", "--no-prompt", "--", "uu.txt"], "any", "");
    expect(stateOf(f)).toEqual(stateOf(o));
  }),
TIMEOUT_MS);

caseTest(TASK, "FR-093: without a merge.tool value, Open in merge tool gives no-merge-tool before the stage read", SHELL, async () => {
  const f = build("merge");
  await withSync("t053-no-tool", async (service) => {
    const r = await open(service, f);
    const at = await shown(service, r, "uu.txt");
    const from = service.runner.calls.length;
    const response = await service.request("reviewWorkbench", { action: "mergetool", ...at.entry }, { repositoryId: r.repositoryId, repositoryGeneration: at.generation });
    expect(refused(response)).toEqual(unavailable("no-merge-tool"));
    expect(gitCommands(service, from)).not.toContain("ls-files");
  });
}, TIMEOUT_MS);

// A console merge tool that writes its Windows process ID and then waits. It ends itself after 120 s, so a failed Cancel leaves no process.
function blockingTool(): { command: string; pidFile: string } {
  const dir = fixtureDir("t053-blocking-tool");
  const script = put(dir, "tool.ts", 'require("node:fs").writeFileSync(process.argv[3], String(process.pid));\nsetTimeout(() => process.exit(3), 120_000);\n');
  const pidFile = join(dir, "tool.pid");
  const slash = (p: string) => p.replaceAll("\\", "/");
  return { command: `'${slash(process.execPath)}' '${slash(script)}' "$MERGED" '${slash(pidFile)}'`, pidFile };
}

const alive = (pid: number): boolean => {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
};

caseTest(TASK, "FR-095: while the tool runs, the operation is in the phase mergetool; Cancel ends Git, its shell, and the tool, and the path stays unmerged", SHELL, async () => {
  const tool = blockingTool();
  let pid = null as number | null;
  try {
    await withGlobal([["merge.tool", "block"], ["mergetool.block.cmd", tool.command]], async () => {
      const f = build("merge");
      const index = text(f, ["ls-files", "-s", "-z"]);
      await withSync("t053-cancel", async (service) => {
        const r = await open(service, f);
        const rv = await reviewed(service, r, "uu.txt", { action: "mergetool" });
        const requestId = sendRun(service, r, rv.workbenchToken);
        const operationId = await service.operationId(requestId);
        await until(() => existsSync(tool.pidFile), "the merge tool start", 60_000);
        pid = Number(readFileSync(tool.pidFile, "utf8"));
        expect(alive(pid)).toBe(true);
        expect(progressPhases(service, operationId)).toContain("mergetool");
        await service.cancel(operationId);
        const done = await service.response<ResolveRun>(requestId);
        expect({ ...outcome(done), staged: done.result?.staged }).toEqual({ state: "canceled", code: "CANCELED", staged: false });
        expect(alive(pid)).toBe(false);
      });
      expect(text(f, ["ls-files", "-s", "-z"])).toBe(index);
    });
  } finally {
    if (pid !== null && alive(pid)) process.kill(pid);
  }
}, TIMEOUT_MS);

// FR-097 last sentence: Git's checkout and Git's mergetool run the hooks of the class `workbench` (research.md R9, R21 F19).
caseTest(TASK, "FR-097 and quickstart Q14: a repository-controlled post-checkout hook refuses Choose ours and Open in merge tool with TRUST_REQUIRED before the stage read, and the canary does not run", SHELL, () =>
  withGlobal([["merge.tool", "fixture"]], async () => {
    const f = build("merge");
    const hook = canary(join(f.dir, ".."), "post-checkout");
    put(f.dir, ".git/hooks/post-checkout", `#!/bin/sh\nexec ${hook.command} "$@"\n`);
    await withSync("t053-trust", async (service) => {
      const r = await open(service, f);
      for (const payload of [{ action: "choose-side", side: "ours" }, { action: "mergetool" }] as const) {
        const at = await shown(service, r, "uu.txt");
        const from = service.runner.calls.length;
        const response = await service.request("reviewWorkbench", { ...payload, ...at.entry }, { repositoryId: r.repositoryId, repositoryGeneration: at.generation });
        expect({ action: payload.action, ...outcome(response) }).toEqual({ action: payload.action, state: "failed", code: "TRUST_REQUIRED" });
        expect(gitCommands(service, from).filter((c) => c === "ls-files" || c === "checkout" || c === "mergetool")).toEqual([]);
      }
    });
    expect(existsSync(hook.log)).toBe(false);
  }),
TIMEOUT_MS);

// Spec FR-097 and plan.md D12: a repository-controlled `mergetool.<tool>.cmd` needs the trust class `mergetool`, which T060 adds to `trust.ts`.
// Until then, the dispatcher gates `mergetool` with the class `workbench`, which lists no merge tool key. Run with `bun test --todo` to see the gap.
test.todo("FR-097 and quickstart Q14: a merge tool from the repository scope in an untrusted repository gives TRUST_REQUIRED before any Git process of the action, and the canary does not run (T060)", async () => {
  const f = build("merge");
  const tool = canary(join(f.dir, ".."), "repository-tool");
  git(f, ["config", "--local", "merge.tool", "repository"]);
  git(f, ["config", "--local", "mergetool.repository.cmd", `${tool.command} "$MERGED"`]);
  await withSync("t053-repository-tool", async (service) => {
    const r = await open(service, f);
    const at = await shown(service, r, "uu.txt");
    const from = service.runner.calls.length;
    const response = await service.request("reviewWorkbench", { action: "mergetool", ...at.entry }, { repositoryId: r.repositoryId, repositoryGeneration: at.generation });
    expect(outcome(response)).toEqual({ state: "failed", code: "TRUST_REQUIRED" });
    expect(gitCommands(service, from)).not.toContain("ls-files");
    expect(steps(service, from)).toEqual([]);
  });
  expect(existsSync(tool.log)).toBe(false);
});
