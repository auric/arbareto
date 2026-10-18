// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T047: `applyFile` direction `resolve`, Mark resolved (contract Δ4, data-model §9, plan.md D7, FR-001, FR-004, FR-052, FR-053, SC-014).
// The oracle is Git's own `git add -- <path>` on a copy. No step reads file text for a decision.

import { expect } from "bun:test";
import { renameSync, rmSync, truncateSync } from "node:fs";
import { WHOLE_FILE_STAGE_INPUT_BYTES } from "../../src/contracts/limits";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { compare, outcome, SUCCEEDED, type Comparison } from "./hunk-harness";
import { buildMergeConflict, gitOut, gitRun, MARKER_TEXT, stageEntries, type GitHost } from "./remote-fixtures";
import { caseTest, type Service, type ServiceResponse } from "./service-harness";
import { hostFor, native, refreshIndex, register, subcommandOf, sync, reviewed, TIMEOUT_MS, until, withSync } from "./sync-harness";

useFixtureRoot();

const TASK = "T047";
const SHELL = ["shell-double"] as const;
// Data-model §9: the accepted kinds of `buildMergeConflict`, with `exec.sh` as the exec-bit stage.
const ACCEPTED: Record<string, string> = { "uu.txt": "UU", "aa.txt": "AA", "au.txt": "AU", "ua.txt": "UA", "du.txt": "DU", "ud.txt": "UD", "exec.sh": "UU" };

const applyFile = (service: Service, repositoryId: string, c: Comparison, direction = "resolve"): Promise<ServiceResponse<{ reason?: string }>> =>
  service.request("applyFile", { comparisonId: c.comparisonId, snapshotId: c.read.snapshotId, direction }, { repositoryId, repositoryGeneration: c.read.generation });

// git-status(1) porcelain v2 `u` record: "u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>".
function worktreeModes(h: GitHost, repo: string): Record<string, string> {
  const modes: Record<string, string> = {};
  for (const record of gitRun(h, repo, ["status", "--porcelain=v2", "-z", "--untracked-files=no"]).stdout.toString("utf8").split("\0")) {
    const m = /^u \S\S \S{4} \d{6} \d{6} \d{6} (\d{6}) [0-9a-f]+ [0-9a-f]+ [0-9a-f]+ ([\s\S]+)$/.exec(record);
    if (m) modes[m[2]!] = m[1]!;
  }
  return modes;
}

describeGit("Mark resolved (T047)", () => {
  let copies = 0;
  const copyOf = (h: GitHost, repo: string) => {
    const to = `${h.root}/copy-${++copies}`;
    h.copy(repo, to);
    return refreshIndex(h, to);
  };
  // The fixture filter driver is repository-controlled, so the reads need approval (001 contract §7).
  async function registered(service: Service, repo: string): Promise<string> {
    const r = await register(service, repo);
    const trust = await service.readTrust(r.repositoryId);
    expect((await service.approveTrust(r.repositoryId)).state).toBe("succeeded");
    return r.repositoryId;
  }
  const decision = (c: Comparison) => (c.response.result as { fileAction?: string } | undefined)?.fileAction;

  caseTest(TASK, "SC-014: each accepted unmerged kind gives the index of Git's own git add on a copy, one stage-0 entry in mode mW, every other entry unchanged, and unchanged working bytes; marker-like text stages normally", SHELL, async () => {
    const h = hostFor("t047-accepted");
    const { repo } = buildMergeConflict(h, "merge");
    h.write(`${repo}/uu.txt`, MARKER_TEXT);
    await withSync("t047-accepted", async (service) => {
      const id = await registered(service, repo);
      for (const [path, kind] of Object.entries(ACCEPTED)) {
        const mW = worktreeModes(h, repo)[path];
        const oracle = copyOf(h, repo);
        const files = h.digests(repo);
        const c = await compare(service, id, path, "conflicted");
        expect({ path, kind, state: c.response.state, decision: decision(c) }).toEqual({ path, kind, state: "succeeded", decision: "resolve" });
        const response = await applyFile(service, id, c);
        expect({ path, kind, ...outcome(response) }).toEqual({ path, kind, ...SUCCEEDED });
        gitRun(h, oracle, ["--literal-pathspecs", "add", "--", path]);
        expect({ path, kind, index: stageEntries(h, repo) }).toEqual({ path, kind, index: stageEntries(h, oracle) });
        expect({ path, kind, entries: stageEntries(h, repo, [path]).map((e) => ({ mode: e.mode, stage: e.stage })) }).toEqual({ path, kind, entries: [{ mode: mW!, stage: 0 }] });
        expect({ path, kind, files: h.digests(repo) }).toEqual({ path, kind, files });
      }
      // Research R16 i: with core.filemode=false, `git add` keeps the exec bit of the stage.
      if (process.platform === "win32") expect(stageEntries(h, repo, ["exec.sh"])[0]!.mode).toBe("100755");
      // Other unmerged stages stay.
      expect(stageEntries(h, repo).filter((e) => e.stage > 0).map((e) => `${e.path}:${e.stage}`)).toEqual(["dd.txt:1", "filtered.txt:1", "filtered.txt:2", "filtered.txt:3", "link:1", "link:2", "link:3"]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "data-model §9: a symbolic link stage, a filter path, DD, a missing working file, a gitlink, and a file above 512 MiB give their reasons and change no index entry", SHELL, async () => {
    const h = hostFor("t047-refused");
    const { repo } = buildMergeConflict(h, "merge");
    rmSync(native(`${repo}/uu.txt`));
    const commit = gitOut(h, repo, ["rev-parse", "HEAD"]).trim();
    gitRun(h, repo, ["update-index", "-z", "--index-info"], { input: Buffer.from([1, 2, 3].map((s) => `160000 ${commit} ${s}\tsub\0`).join("")) });
    truncateSync(native(`${repo}/aa.txt`), WHOLE_FILE_STAGE_INPUT_BYTES + 1);
    const cases: [string, string][] = [["link", "symlink"], ["filtered.txt", "filter"], ["dd.txt", "missing"], ["uu.txt", "missing"], ["sub", "submodule"], ["aa.txt", "size"]];
    await withSync("t047-refused", async (service) => {
      const id = await registered(service, repo);
      for (const [path, reason] of cases) {
        const index = stageEntries(h, repo);
        const c = await compare(service, id, path, "conflicted");
        expect({ path, decision: decision(c) }).toEqual({ path, decision: reason });
        const response = await applyFile(service, id, c);
        expect({ path, code: response.code, reason: response.result?.reason }).toEqual({ path, code: "UNSUPPORTED_COMPARISON", reason });
        expect({ path, index: stageEntries(h, repo) }).toEqual({ path, index });
      }
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-053: changed bytes, a replaced file, a staged or resolved path, and a changed operation state after the selection give STALE_SELECTION and change no index entry", SHELL, async () => {
    const h = hostFor("t047-stale");
    const changes: [string, (repo: string) => void][] = [
      ["bytes", (repo) => h.write(`${repo}/uu.txt`, "other bytes\n")],
      [
        // An atomic save: a new file takes the path.
        "replaced",
        (repo) => {
          h.write(`${repo}/uu.tmp`, "saved by an editor\n");
          renameSync(native(`${repo}/uu.tmp`), native(`${repo}/uu.txt`));
        },
      ],
      ["staged", (repo) => gitRun(h, repo, ["--literal-pathspecs", "add", "--", "uu.txt"])],
      [
        "resolved",
        (repo) => {
          const oid = gitOut(h, repo, ["hash-object", "-w", "--", "uu.txt"]).trim();
          gitRun(h, repo, ["update-index", "-z", "--index-info"], { input: Buffer.from(`100644 ${oid}\tuu.txt\0`) });
        },
      ],
      ["state", (repo) => gitRun(h, repo, ["merge", "--quit"])],
    ];
    for (const [name, change] of changes) {
      const { repo } = buildMergeConflict(h, `stale-${name}`);
      await withSync(`t047-stale-${name}`, async (service) => {
        const id = await registered(service, repo);
        const c = await compare(service, id, "uu.txt", "conflicted");
        expect(decision(c)).toBe("resolve");
        change(repo);
        const index = stageEntries(h, repo);
        const response = await applyFile(service, id, c);
        expect({ name, ...outcome(response) }).toEqual({ name, state: "failed", code: "STALE_SELECTION" });
        expect({ name, index: stageEntries(h, repo) }).toEqual({ name, index });
      });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "contract Δ4: the bound state decides by equality, so Mark resolved works with unmerged entries and no merge marker, as Git's own git add does", SHELL, async () => {
    const h = hostFor("t047-no-marker");
    const { repo } = buildMergeConflict(h, "merge");
    gitRun(h, repo, ["merge", "--quit"]);
    const oracle = copyOf(h, repo);
    await withSync("t047-no-marker", async (service) => {
      const id = await registered(service, repo);
      const read = await service.readWorkspace(id);
      expect(read.result!.operationState).toBe("conflicted");
      const c = await compare(service, id, "aa.txt", "conflicted");
      expect(outcome(await applyFile(service, id, c))).toEqual(SUCCEEDED);
    });
    gitRun(h, oracle, ["--literal-pathspecs", "add", "--", "aa.txt"]);
    expect(stageEntries(h, repo)).toEqual(stageEntries(h, oracle));
  }, TIMEOUT_MS);

  caseTest(TASK, "contract Δ4 step 5: Mark resolved runs hash-object -w and update-index --index-info with mode mW, never update-index --add, git add, or a file write", SHELL, async () => {
    const h = hostFor("t047-steps");
    const { repo } = buildMergeConflict(h, "merge");
    const mW = worktreeModes(h, repo)["exec.sh"]!;
    await withSync("t047-steps", async (service) => {
      const id = await registered(service, repo);
      const c = await compare(service, id, "exec.sh", "conflicted");
      const from = service.runner.calls.length;
      expect(outcome(await applyFile(service, id, c))).toEqual(SUCCEEDED);
      const calls = service.runner.calls.slice(from);
      const hash = calls.filter((x) => subcommandOf(x.arguments) === "hash-object" && x.arguments.includes("-w"));
      const update = calls.filter((x) => subcommandOf(x.arguments) === "update-index");
      expect({ hash: hash.map((x) => x.arguments), update: update.map((x) => x.arguments), add: calls.filter((x) => subcommandOf(x.arguments) === "add").length }).toEqual({
        hash: [["--no-lazy-fetch", "hash-object", "-w", "--", "exec.sh"]],
        update: [["--no-lazy-fetch", "update-index", "-z", "--index-info"]],
        add: 0,
      });
      const oid = stageEntries(h, repo, ["exec.sh"])[0]!.oid;
      expect(Buffer.from(update[0]!.input!).toString("utf8")).toBe(`${mW} ${oid}\texec.sh\0`);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-001: Mark resolved is a mutation, so a second mutation gives BUSY while it runs", SHELL, async () => {
    const h = hostFor("t047-busy");
    const { repo } = buildMergeConflict(h, "merge");
    await withSync("t047-busy", async (service) => {
      const id = await registered(service, repo);
      const c = await compare(service, id, "aa.txt", "conflicted");
      const r = { repositoryId: id, generation: c.read.generation, worktreeKey: "", worktreeRoot: "" };
      const abort = await reviewed(service, r, { action: "abort" });
      const isHash = (x: { arguments: readonly string[] }) => subcommandOf(x.arguments) === "hash-object" && x.arguments.includes("-w");
      const release = service.runner.holdStart(isHash);
      const pending = applyFile(service, id, c);
      await until(() => service.runner.calls.some(isHash), "hash-object call");
      expect(outcome(await sync(service, r, abort.syncReviewToken))).toEqual({ state: "rejected", code: "BUSY" });
      release();
      expect(outcome(await pending)).toEqual(SUCCEEDED);
    });
  }, TIMEOUT_MS);
});
