// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// 004 T081 and 006 T034 service cases: conflict resolve, the merge tool, and staging through the distro Git (quickstart.md Q13 to Q19). The harness is `workbench-wsl-harness.ts`.

import { describe, expect } from "bun:test";
import { join } from "node:path";
import { STATUS_LISTING_RECORDS } from "../../src/contracts/limits";
import { same } from "../git/fact-runner";
import { serviceEnv } from "../git/fixture-root";
import { applyHunk, commit, compare, hunksOf, outcome, patchOf, readOk, resultOf, reviewOk, selectHunks, subcommand, SUCCEEDED, valuesOf, type Comparison, type Direction } from "../git/hunk-harness";
import { gitRun, stageEntries } from "../git/remote-fixtures";
import { openService, type ChangeEntry, type HunkCheckpoint, type RegistrationResult, type Service, type WorkspaceResult } from "../git/service-harness";
import { gitExe } from "../git/sync-harness";
import { FIXTURE_MERGE_RESULT } from "../git/workbench-fixtures";
import { globalConfig, sh } from "./fixtures";
import { listScopes, pgrep } from "./wsl-host";
import { AFTER_CLOSE_MS, at, bytes, canary, changed, confirms, copy, type DistroFixture, EMPTY, hostOf, indexDigest, L, MERGETOOL_MS, nul, open, out, own, refusalOf, request, RESPONSE_MS, type Reviewed, run, type RunResult, runToken, sendRun, shapeState, stages, state, steps, TASK, text, unavailable, useWorkbenchWsl, W, withWsl, XDG_IGNORED } from "./workbench-wsl-harness";

useWorkbenchWsl();

describe("conflict resolve and the merge tool through the distro Git (quickstart.md Q13, Q14, plan.md D18)", () => {
  // The shown read and one conflicted entry of it (contract Δ3).
  async function shown(s: Service, r: RegistrationResult, path: string) {
    const read = await readOk(s, r.repositoryId);
    const entry = read.entries.find((e) => e.path === path && e.category === "conflicted");
    expect({ path, listed: entry !== undefined }).toEqual({ path, listed: true });
    return { generation: read.generation, entry: { snapshotId: read.snapshotId, entryId: entry!.entryId } };
  }
  async function resolveReview(s: Service, r: RegistrationResult, path: string, payload: object) {
    const sel = await shown(s, r, path);
    return request<Reviewed>(s, "reviewWorkbench", { ...payload, ...sel.entry }, { repositoryId: r.repositoryId, repositoryGeneration: sel.generation });
  }
  async function resolveRun(s: Service, r: RegistrationResult, path: string, payload: object) {
    const response = await resolveReview(s, r, path, payload);
    expect({ path, ...outcome(response) }).toEqual({ path, ...SUCCEEDED });
    return { plan: response.result!.plan, done: await runToken(s, r, response.result!.workbenchToken) };
  }

  W("Q13 FR-089 to FR-096: Choose ours, Choose theirs, and Open in merge tool equal the distro Git's own checkout and mergetool on a copy; the merge tool runs under the mergetool policy", async (w) => {
    hostOf(w, "[merge]\n\ttool = fixture\n");
    const f = copy(w, "conflict-merge");
    const o = copy(w, "conflict-merge");
    const g = copy(w, "conflict-rebase");
    const p = copy(w, "conflict-rebase");
    await withWsl(w, "t081-resolve", async (s) => {
      const r = await open(s, w, f.repo);
      for (const [path, side] of [["uu.txt", "ours"], ["du.txt", "theirs"]] as const) {
        const from = s.runner.calls.length;
        const { done } = await resolveRun(s, r, path, { action: "choose-side", side });
        expect({ path, ...outcome(done), result: done.result }).toEqual({ path, ...SUCCEEDED, result: { action: "choose-side", staged: false, operationState: "merging" } });
        expect(steps(s, from)).toEqual([[L, "--literal-pathspecs", "checkout", "--no-recurse-submodules", `--${side}`, "--", path]]);
      }
      const from = s.runner.calls.length;
      const { plan, done } = await resolveRun(s, r, "aa.txt", { action: "mergetool" });
      expect(plan.tool).toMatchObject({ name: "fixture", scope: "global" });
      expect({ ...outcome(done), result: done.result }).toEqual({ ...SUCCEEDED, result: { action: "mergetool", staged: true, operationState: "merging" } });
      expect(steps(s, from, ["integrate", "mergetool"])).toEqual([[L, "--literal-pathspecs", "mergetool", "--tool=fixture", "--no-prompt", "--", "aa.txt"]]);
      expect(s.runner.calls.slice(from).filter((c) => c.environmentPolicy === "mergetool").map((c) => c.input)).toEqual([undefined]);
      const rg = await open(s, w, g.repo);
      const { done: rebased } = await resolveRun(s, rg, "uu.txt", { action: "choose-side", side: "ours" });
      expect({ ...outcome(rebased), result: rebased.result }).toEqual({ ...SUCCEEDED, result: { action: "choose-side", staged: false, operationState: "rebasing" } });
    });
    own(o, ["--literal-pathspecs", "checkout", "--ours", "--", "uu.txt"]);
    own(o, ["--literal-pathspecs", "checkout", "--theirs", "--", "du.txt"]);
    gitRun(o.h, o.repo, ["--literal-pathspecs", "mergetool", "--tool=fixture", "--no-prompt", "--", "aa.txt"], { input: EMPTY, timeoutMs: MERGETOOL_MS });
    own(p, ["--literal-pathspecs", "checkout", "--ours", "--", "uu.txt"]);
    expect(shapeState(at(f))).toEqual(shapeState(at(o)));
    expect(shapeState(at(g))).toEqual(shapeState(at(p)));
    expect(f.h.read(`${f.repo}/aa.txt`)!.toString("utf8")).toBe(FIXTURE_MERGE_RESULT);
  });

  W("T034 Q13 FR-089 to FR-092: AU, UA, UD, DD, and the link stage give their kinds, plans, and refusals; Choose ours and Choose theirs equal the distro Git's own checkout on a copy and keep each path unmerged", async (w) => {
    // The entries of `buildConflict` with their porcelain v2 XY code and the data-model §11 text.
    const KINDS: Record<string, [string, string]> = { "uu.txt": ["UU", "Both modified"], "aa.txt": ["AA", "Both added"], "au.txt": ["AU", "Added by us"], "ua.txt": ["UA", "Added by them"], "du.txt": ["DU", "Deleted by us"], "ud.txt": ["UD", "Deleted by them"], "dd.txt": ["DD", "Both deleted"], link: ["UU", "Both modified"] };
    for (const side of ["ours", "theirs"] as const) {
      const f = copy(w, "conflict-merge");
      const o = copy(w, "conflict-merge");
      const stagesOf = (path: string) => stageEntries(f.h, f.repo, [path]).map((e) => ({ stage: e.stage, mode: e.mode, oid: e.oid }));
      const names = { ours: { oid: out(at(f), ["rev-parse", "main"]).trim(), refs: ["refs/heads/main"] }, theirs: { oid: out(at(f), ["rev-parse", "topic"]).trim(), refs: ["refs/heads/topic"] } };
      const ran: string[] = [];
      await withWsl(w, `t034-choose-${side}`, async (s) => {
        const r = await open(s, w, f.repo);
        for (const [path, [xy, kind]] of Object.entries(KINDS)) {
          const stages = stagesOf(path);
          const response = await resolveReview(s, r, path, { action: "choose-side", side });
          // FR-092: a link stage is no regular file, so the copy gets no command.
          if (path === "link") {
            expect({ path, ...refusalOf(response) }).toEqual({ path, ...unavailable("side-not-regular", { names }) });
            continue;
          }
          // Git's own command on the copy decides whether the side exists.
          if (run(at(o), ["--literal-pathspecs", "checkout", `--${side}`, "--", path]).exitCode !== 0) {
            expect({ path, ...refusalOf(response) }).toEqual({ path, ...unavailable("side-missing", { names }) });
            continue;
          }
          expect({ path, ...outcome(response) }).toEqual({ path, ...SUCCEEDED });
          expect(response.result!.plan).toEqual({ path: Buffer.from(path).toString("base64"), kind: { xy, text: kind }, stages, names, operation: "merging", side });
          const from = s.runner.calls.length;
          const done = await runToken(s, r, response.result!.workbenchToken);
          expect({ path, ...outcome(done), result: done.result }).toEqual({ path, ...SUCCEEDED, result: { action: "choose-side", staged: false, operationState: "merging" } });
          expect(steps(s, from)).toEqual([[L, "--literal-pathspecs", "checkout", "--no-recurse-submodules", `--${side}`, "--", path]]);
          expect(stagesOf(path)).toEqual(stages);
          ran.push(path);
        }
      });
      expect(ran).toEqual(side === "ours" ? ["uu.txt", "aa.txt", "au.txt", "ud.txt"] : ["uu.txt", "aa.txt", "ua.txt", "du.txt"]);
      expect({ side, state: shapeState(at(f)) }).toEqual({ side, state: shapeState(at(o)) });
    }
  });

  W("Q14 FR-097: a merge tool from the repository scope in an untrusted repository gives TRUST_REQUIRED before any Git process of the action, and the canary does not run", async (w) => {
    const f = copy(w, "conflict-merge");
    const tool = canary(at(f), f.root, "repository-tool");
    own(f, ["config", "--local", "merge.tool", "repository"]);
    own(f, ["config", "--local", "mergetool.repository.cmd", `${tool.command} "$MERGED"`]);
    await withWsl(w, "t081-repository-tool", async (s) => {
      const r = await open(s, w, f.repo);
      expect((await s.readTrust(r.repositoryId)).result!.approvalRequired).toEqual({ reads: false, commit: false, sync: false, workbench: false, mergetool: true });
      const sel = await shown(s, r, "uu.txt");
      const from = s.runner.calls.length;
      const response = await request(s, "reviewWorkbench", { action: "mergetool", ...sel.entry }, { repositoryId: r.repositoryId, repositoryGeneration: sel.generation });
      expect(outcome(response)).toEqual({ state: "failed", code: "TRUST_REQUIRED" });
      expect(s.runner.calls.slice(from).map((c) => c.arguments.find((a) => !a.startsWith("-")))).not.toContain("ls-files");
      expect(steps(s, from, ["integrate", "mergetool"])).toEqual([]);
      expect(confirms(s)).toEqual([]);
    });
    expect(f.h.existing([tool.log])).toEqual([]);
  });

  W("plan.md D18: a merge tool that needs a terminal ends at once, because setsid --wait removes the terminal; the path stays unmerged", async (w) => {
    const f = copy(w, "conflict-merge");
    const log = `${f.root}/tty.log`;
    // The tool opens /dev/tty and records the exit status of that open. Its program lies outside the repository, so it needs no approval (plan.md D12).
    const tool = `${w.folder}/home/tty-tool.sh`;
    const h = hostOf(w, `[merge]\n\ttool = tty\n[mergetool "tty"]\n\tcmd = '${tool}'\n`);
    h.write(tool, `#!/bin/sh\n( : </dev/tty ) 2>/dev/null\nprintf 'tty=%s\\n' "$?" > '${log}'\n`);
    const index = stageEntries(f.h, f.repo);
    await withWsl(w, "t081-tty-tool", async (s) => {
      const r = await open(s, w, f.repo);
      const { done } = await resolveRun(s, r, "uu.txt", { action: "mergetool" });
      // FR-096: the exit code decides nothing. The fresh read says Git staged nothing.
      expect({ ...outcome(done), staged: done.result?.staged }).toEqual({ state: "failed", code: "GIT_FAILED", staged: false });
    });
    const tty = f.h.read(log)?.toString("utf8") ?? null;
    console.log(`OBSERVATION ${TASK}: D18.tty-open expected="tty=<nonzero>" observed=${JSON.stringify(tty).replaceAll(" ", "\\u0020")} match=${tty !== null && /^tty=[1-9][0-9]*\n$/.test(tty)} git=${w.gitVersion}@${w.distro}`);
    expect(tty).toMatch(/^tty=[1-9][0-9]*\n$/);
    expect(stageEntries(f.h, f.repo)).toEqual(index);
  });

  for (const ending of ["cancel", "close"] as const) {
    W(`FR-095 and contract §11: after ${ending === "cancel" ? "Cancel" : "a simulated close"} while the merge tool runs, pgrep finds no tool process, no arbareto-* scope remains, and the path stays unmerged`, async (w) => {
      const f = copy(w, "conflict-merge");
      const pattern = `sleep 300 0.${crypto.getRandomValues(new Uint32Array(1))[0]}`;
      // `exec` replaces the script command line, so the `sleep` arguments carry the pattern.
      const tool = `${w.folder}/home/block-tool.sh`;
      const h = hostOf(w, `[merge]\n\ttool = block\n[mergetool "block"]\n\tcmd = '${tool}'\n`);
      h.write(tool, `#!/bin/sh\nexec ${pattern}\n`);
      const index = stageEntries(f.h, f.repo);
      const s = await openService({ git: gitExe(), name: `t081-block-${ending}`, environment: serviceEnv(), wslGlobalConfig: globalConfig(w) });
      try {
        const r = await open(s, w, f.repo);
        const reviewed = await resolveReview(s, r, "uu.txt", { action: "mergetool" });
        expect(outcome(reviewed)).toEqual(SUCCEEDED);
        const requestId = sendRun(s, r, reviewed.result!.workbenchToken);
        const operationId = await s.operationId(requestId);
        const deadline = Date.now() + 60_000;
        while (pgrep(w, pattern).length === 0) {
          if (Date.now() > deadline) throw new Error("the merge tool start: not within 60000 ms");
          await Bun.sleep(200);
        }
        expect(s.progress.filter((e) => (e as { operationId?: string }).operationId === operationId).map((e) => (e as { phase?: string }).phase)).toContain("mergetool");
        if (ending === "cancel") {
          await s.cancel(operationId);
          const done = await s.response<RunResult>(requestId, RESPONSE_MS);
          expect({ ...outcome(done), staged: done.result?.staged }).toEqual({ state: "canceled", code: "CANCELED", staged: false });
        } else s.runner.failService();
        await Bun.sleep(AFTER_CLOSE_MS);
        expect(pgrep(w, pattern)).toEqual([]);
        expect(pgrep(w, operationId)).toEqual([]);
        expect(listScopes(w)).toEqual([]);
      } finally {
        await s.dispose();
      }
      expect(listScopes(w)).toEqual([]);
      expect(stageEntries(f.h, f.repo)).toEqual(index);
    });
  }
});

describe("staging through the distro Git (quickstart.md Q15, Q16, Q19)", () => {
  async function allEntries(s: Service, repositoryId: string, read: WorkspaceResult): Promise<ChangeEntry[]> {
    const entries = [...read.entries];
    for (let cursor = read.cursor; cursor !== null; ) {
      const page = await s.readEntries(repositoryId, read.generation, read.snapshotId, cursor);
      expect(["succeeded", "limited"]).toContain(page.state);
      entries.push(...page.result!.entries);
      cursor = page.result!.cursor;
    }
    return entries;
  }
  const applyFiles = (s: Service, repositoryId: string, read: WorkspaceResult, ids: readonly string[], direction: Direction, kind: string, folder?: string) =>
    s.response(s.send("applyFiles", { snapshotId: read.snapshotId, entryIds: ids, direction, kind, ...(folder === undefined ? {} : { folder: Buffer.from(folder).toString("base64") }) }, { repositoryId }), RESPONSE_MS);

  W("Q15 FR-034 to FR-040: Stage selected, Stage all untracked, and Unstage all equal the distro Git's add and reset of the same paths, and every working byte stays", async (w) => {
    const cases: [string, Direction, string, (e: ChangeEntry) => boolean, string[], boolean][] = [
      ["selected", "stage", "selected", (e) => (e.category === "unstaged" && ["src/a.txt", "docs/d.txt"].includes(e.path)) || (e.category === "untracked" && e.path === "top-new.txt"), ["add", "--", "src/a.txt", "docs/d.txt", "top-new.txt"], false],
      ["all-untracked", "stage", "all-untracked", (e) => e.category === "untracked", ["add", "--", "src/lib/new.txt", "src/new-dir/n1.txt", "src/new-dir/n2.txt", "top-new.txt"], false],
      ["all-staged", "unstage", "all-staged", (e) => e.category === "staged", ["reset", "-q"], true],
    ];
    for (const [label, direction, kind, choose, oracle, addFirst] of cases) {
      const f = copy(w, "staging-tree");
      const o = copy(w, "staging-tree");
      for (const x of [f, o]) x.h.write(`${x.repo}/${XDG_IGNORED}`, "ignored by the owned home\n");
      if (addFirst) for (const x of [f, o]) own(x, ["add", "-A"]);
      const files = f.h.digests(f.repo);
      // git-status(1) porcelain v2: `? <path>` is an untracked record.
      const untracked = nul(out(at(o), ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all"])).filter((rec) => rec.startsWith("? ")).map((rec) => rec.slice(2)).sort();
      expect(untracked).not.toContain(XDG_IGNORED);
      await withWsl(w, `t081-files-${label}`, async (s) => {
        const r = await open(s, w, f.repo);
        const read = await readOk(s, r.repositoryId);
        const entries = await allEntries(s, r.repositoryId, read);
        expect({ label, untracked: entries.filter((e) => e.category === "untracked").map((e) => e.path).sort() }).toEqual({ label, untracked });
        const chosen = entries.filter(choose);
        expect(chosen.length).toBeGreaterThan(0);
        const response = await applyFiles(s, r.repositoryId, read, chosen.map((e) => e.entryId), direction, kind);
        expect({ label, ...outcome(response) }).toEqual({ label, ...SUCCEEDED });
      });
      own(o, oracle);
      expect({ label, index: stageEntries(f.h, f.repo) }).toEqual({ label, index: stageEntries(o.h, o.repo) });
      expect({ label, files: f.h.digests(f.repo) }).toEqual({ label, files });
    }
  });

  // The owned candidate files of the multi-file publication (004 plan.md O-17) in the Git folder of the main worktree.
  const candidates = (f: DistroFixture) => nul(sh(f.w, 'for p in "$1"/arbareto-candidate-*; do [ -e "$p" ] && printf "%s\\0" "$p"; done; exit 0', [`${f.repo}/.git`]).stdout);
  const UNDER = ["src/a.txt", "src/lib/deep/c.txt", "src/lib/new.txt", "src/new-dir/n1.txt", "src/new-dir/n2.txt"];

  W("T034 Q15 FR-034 to FR-036: Stage folder, Stage all changes, and Unstage folder equal the distro Git's add and reset of the same paths, and every working byte stays", async (w) => {
    const cases: [string, Direction, string, (e: ChangeEntry) => boolean, string[], boolean][] = [
      ["stage folder", "stage", "folder", (e) => e.category !== "staged" && UNDER.includes(e.path), ["add", "--", ...UNDER], false],
      ["stage all changes", "stage", "all-changes", (e) => e.category !== "staged", ["add", "-A"], false],
      ["unstage folder", "unstage", "folder", (e) => e.category === "staged" && UNDER.includes(e.path), ["reset", "-q", "--", ...UNDER], true],
    ];
    for (const [label, direction, kind, choose, oracle, addFirst] of cases) {
      const f = copy(w, "staging-tree");
      const o = copy(w, "staging-tree");
      if (addFirst) for (const x of [f, o]) own(x, ["add", "-A"]);
      const files = f.h.digests(f.repo);
      await withWsl(w, `t034-files-${label.replaceAll(" ", "-")}`, async (s) => {
        const r = await open(s, w, f.repo);
        const read = await readOk(s, r.repositoryId);
        const chosen = (await allEntries(s, r.repositoryId, read)).filter(choose);
        expect({ label, paths: [...new Set(chosen.map((e) => e.path))].sort() }).toEqual({ label, paths: kind === "folder" ? UNDER : expect.any(Array) });
        const response = await applyFiles(s, r.repositoryId, read, chosen.map((e) => e.entryId), direction, kind, kind === "folder" ? "src" : undefined);
        expect({ label, ...outcome(response) }).toEqual({ label, ...SUCCEEDED });
      });
      own(o, oracle);
      expect({ label, index: stageEntries(f.h, f.repo) }).toEqual({ label, index: stageEntries(o.h, o.repo) });
      expect({ label, files: f.h.digests(f.repo) }).toEqual({ label, files });
      expect(candidates(f)).toEqual([]);
    }
  });

  W("T034 Q15 FR-038 to FR-040: one refused file refuses the whole set with its entry and reason; a change of the set after step 5 gives STALE_SELECTION; neither publishes anything", async (w) => {
    const f = copy(w, "staging-tree");
    // git-add(1) `-N`: an intent-to-add entry, which the 001 decision refuses with reason `index-flag`.
    own(f, ["add", "-N", "--", "top-new.txt"]);
    const g = copy(w, "staging-tree");
    let fire = false;
    const hunkCheckpoint = (c: HunkCheckpoint) => {
      if (fire && c.step === 5) {
        fire = false;
        g.h.write(`${g.repo}/top-new.txt`, "changed during staging\n");
      }
    };
    const s = await openService({ git: gitExe(), name: "t034-set-refusals", environment: serviceEnv(), wslGlobalConfig: globalConfig(w), hunkCheckpoint });
    try {
      const r = await open(s, w, f.repo);
      const read = await readOk(s, r.repositoryId);
      const entries = await allEntries(s, r.repositoryId, read);
      const pick = (category: string, path: string) => entries.find((e) => e.category === category && e.path === path)!;
      const ita = pick("unstaged", "top-new.txt");
      const before = { index: indexDigest(at(f)), files: f.h.digests(f.repo) };
      const response = await applyFiles(s, r.repositoryId, read, [pick("unstaged", "src/a.txt").entryId, ita.entryId], "stage", "selected");
      expect({ ...outcome(response), reason: (response.result as { reason?: string }).reason, entryId: (response.result as { entryId?: string }).entryId }).toEqual({ state: "rejected", code: "UNSUPPORTED_COMPARISON", reason: "index-flag", entryId: ita.entryId });
      expect(s.runner.calls.filter((c) => c.operationId === response.operationId && subcommand(c.arguments) === "update-index")).toEqual([]);
      expect({ index: indexDigest(at(f)), files: f.h.digests(f.repo), candidates: candidates(f) }).toEqual({ ...before, candidates: [] });

      const rg = await open(s, w, g.repo);
      const gRead = await readOk(s, rg.repositoryId);
      const gEntries = await allEntries(s, rg.repositoryId, gRead);
      const ids = [gEntries.find((e) => e.category === "unstaged" && e.path === "src/a.txt")!, gEntries.find((e) => e.category === "untracked" && e.path === "top-new.txt")!].map((e) => e.entryId);
      const index = indexDigest(at(g));
      fire = true;
      const stale = await applyFiles(s, rg.repositoryId, gRead, ids, "stage", "selected");
      expect(outcome(stale)).toEqual({ state: "failed", code: "STALE_SELECTION" });
      expect({ index: indexDigest(at(g)), candidates: candidates(g), changed: g.h.read(`${g.repo}/top-new.txt`)!.toString("utf8") }).toEqual({ index, candidates: [], changed: "changed during staging\n" });
      expect(out(at(g), ["show", ":src/a.txt"])).toBe(out(at(g), ["show", "HEAD:src/a.txt"]));
    } finally {
      await s.dispose();
    }
    expect(listScopes(w)).toEqual([]);
  });

  // One hunk: its header values and its body lines without LF.
  function hunkOf(c: Comparison) {
    const all = hunksOf(patchOf(resultOf(c)));
    expect(all.length).toBe(1);
    const rows = all[0]!.split("\n");
    if (rows.at(-1) === "") rows.pop();
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(rows[0]!)!;
    return { oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]), body: rows.slice(1) };
  }
  // Research.md R11, as `tests/git/line-stage.test.ts` states it.
  function expectedContent(base: Buffer, h: ReturnType<typeof hunkOf>, picked: number[], direction: Direction): Buffer {
    const lines = base.toString("latin1").split(/(?<=\n)/);
    const [start, n] = direction === "stage" ? [h.oldStart, h.oldCount] : [h.newStart, h.newCount];
    const from = n === 0 ? start : start - 1;
    const region: string[] = [];
    h.body.forEach((line, i) => {
      const kind = line[0];
      const chosen = picked.includes(i + 1);
      if (kind === " ") region.push(`${line.slice(1)}\n`);
      else if (direction === "stage" ? (kind === "-" ? !chosen : chosen) : kind === "+" ? !chosen : chosen) region.push(`${line.slice(1)}\n`);
    });
    return Buffer.from([...lines.slice(0, from), ...region, ...lines.slice(from + n)].join(""), "latin1");
  }

  W("Q16 FR-041 to FR-044: staging and unstaging selected lines of the mixed hunk gives the expected index blob through the distro Git, and the working file stays", async (w) => {
    const f = copy(w, "staging-hunks");
    const r = at(f);
    const blob = (path: string) => stageEntries(f.h, f.repo, [path]).find((e) => e.stage === 0)?.oid ?? null;
    const content = (oid: string) => gitRun(f.h, f.repo, ["cat-file", "blob", oid]).stdout;
    const files = f.h.digests(f.repo);
    await withWsl(w, "t081-lines", async (s) => {
      const reg = await open(s, w, f.repo);
      for (const [direction, category] of [["stage", "unstaged"], ["unstage", "staged"]] as const) {
        if (direction === "unstage") own(f, ["add", "--", "mixed.txt"]);
        const c = await selectHunks(s, reg.repositoryId, "mixed.txt", category);
        const h = hunkOf(c);
        const changes = h.body.flatMap((line, i) => (line[0] === "+" || line[0] === "-" ? [i + 1] : []));
        const picked = [changes[0]!, changes.at(-1)!];
        const base = content(blob("mixed.txt")!);
        const expected = out(r, ["hash-object", "--stdin"], { input: expectedContent(base, h, picked, direction) }).trim();
        const response = await applyHunk(s, reg.repositoryId, c, c.hunkIds[0]!, direction, { lines: picked });
        expect({ direction, ...outcome(response) }).toEqual({ direction, ...SUCCEEDED });
        expect({ direction, oid: blob("mixed.txt") }).toEqual({ direction, oid: expected });
      }
    });
    expect(f.h.digests(f.repo)).toEqual(files);
  });

  W("T034 Q16 FR-041 to FR-044: every line selection of the added and removed hunks stages and unstages the expected blob; deleted-file, new-file, eof-newline, binary, an invalid ordinal, and a stale working file refuse and change nothing", async (w) => {
    const f = copy(w, "staging-hunks");
    const r = at(f);
    const blob = (path: string) => stageEntries(f.h, f.repo, [path]).find((e) => e.stage === 0)?.oid ?? null;
    const content = (oid: string) => gitRun(f.h, f.repo, ["cat-file", "blob", oid]).stdout;
    const changeOrdinals = (body: string[]) => body.flatMap((line, i) => (line[0] === "+" || line[0] === "-" ? [i + 1] : []));
    const subsets = (ordinals: number[]) => Array.from({ length: (1 << ordinals.length) - 1 }, (_, m) => ordinals.filter((_, i) => ((m + 1) & (1 << i)) !== 0));
    const lines = (s: Service, id: string, c: Comparison, direction: Direction, picked: number[]) => applyHunk(s, id, c, c.hunkIds[0]!, direction, { lines: picked });
    await withWsl(w, "t034-lines", async (s) => {
      const reg = await open(s, w, f.repo);
      const id = reg.repositoryId;
      const files = f.h.digests(f.repo);
      for (const path of ["added.txt", "removed.txt"]) {
        for (const [direction, category] of [["stage", "unstaged"], ["unstage", "staged"]] as const) {
          if (direction === "unstage") own(f, ["add", "--", path]);
          const all = changeOrdinals(hunkOf(await selectHunks(s, id, path, category)).body);
          for (const picked of subsets(all)) {
            const c = await selectHunks(s, id, path, category);
            const h = hunkOf(c);
            const base = content(blob(path)!);
            const expected = out(r, ["hash-object", "--stdin"], { input: expectedContent(base, h, picked, direction) }).trim();
            expect({ path, direction, picked, ...outcome(await lines(s, id, c, direction, picked)) }).toEqual({ path, direction, picked, ...SUCCEEDED });
            expect({ path, direction, picked, oid: blob(path) }).toEqual({ path, direction, picked, oid: expected });
            // `reset` and `add` write only the index, so each selection starts from the same side.
            own(f, direction === "stage" ? ["reset", "-q", "--", path] : ["add", "--", path]);
          }
          own(f, ["reset", "-q", "--", path]);
        }
      }
      expect(f.h.digests(f.repo)).toEqual(files);

      // Each refusal changes no index entry and no working byte.
      const refused = async (path: string, category: "unstaged" | "staged", direction: Direction, pick: (all: number[], body: string[]) => number[], expected: { code: string; reason?: string }) => {
        const before = { index: stageEntries(f.h, f.repo), files: f.h.digests(f.repo) };
        const c = await selectHunks(s, id, path, category);
        const h = hunkOf(c);
        const response = await lines(s, id, c, direction, pick(changeOrdinals(h.body), h.body));
        const reason = (response.result as { reason?: string } | undefined)?.reason;
        expect({ path, state: response.state, code: response.code, ...(expected.reason === undefined ? {} : { reason }) }).toEqual({ path, state: "rejected", ...expected });
        expect({ path, index: stageEntries(f.h, f.repo), files: f.h.digests(f.repo) }).toEqual({ path, ...before });
        return response.operationId!;
      };
      f.h.write(`${f.repo}/fresh.txt`, "fresh 1\nfresh 2\n");
      own(f, ["add", "--", "fresh.txt"]);
      await refused("deleted.txt", "unstaged", "stage", (all) => all, { code: "UNSUPPORTED_COMPARISON", reason: "deleted-file" });
      await refused("fresh.txt", "staged", "unstage", (all) => [all[0]!], { code: "UNSUPPORTED_COMPARISON", reason: "new-file" });
      // 004 research.md R21 F25: each partial end-of-file selection refuses before `apply --cached` runs.
      const eof = changeOrdinals(hunkOf(await selectHunks(s, id, "eof.txt", "unstaged")).body);
      for (const picked of subsets(eof).filter((x) => x.length < eof.length)) {
        const operationId = await refused("eof.txt", "unstaged", "stage", () => picked, { code: "UNSUPPORTED_COMPARISON", reason: "eof-newline" });
        expect(s.runner.calls.filter((call) => call.operationId === operationId && subcommand(call.arguments) === "apply")).toEqual([]);
      }
      // The file holds one hunk, so the whole hunk stages the working bytes, as the distro Git's own hash-object of the file names them.
      const c = await selectHunks(s, id, "eof.txt", "unstaged");
      expect(outcome(await lines(s, id, c, "stage", changeOrdinals(hunkOf(c).body)))).toEqual(SUCCEEDED);
      expect(blob("eof.txt")).toBe(out(r, ["hash-object", "--", "eof.txt"]).trim());
      for (const pick of [(_: number[], body: string[]) => [body.findIndex((l) => l[0] === " ") + 1], (_: number[], body: string[]) => [body.length + 1], () => []]) {
        await refused("mixed.txt", "unstaged", "stage", pick, { code: "INVALID_REQUEST" });
      }
      // A working file that changed after the line selection refuses as a stale selection, and its new bytes stay.
      const index = stageEntries(f.h, f.repo);
      const selected = await selectHunks(s, id, "mixed.txt", "unstaged");
      f.h.write(`${f.repo}/mixed.txt`, "changed after the selection\n");
      const changed = f.h.digests(f.repo);
      expect(outcome(await lines(s, id, selected, "stage", [changeOrdinals(hunkOf(selected).body)[0]!])).code).toBe("STALE_SELECTION");
      expect({ index: stageEntries(f.h, f.repo), files: f.h.digests(f.repo) }).toEqual({ index, files: changed });
      // 001 FR-011: lines of a binary comparison give reason binary.
      f.h.write(`${f.repo}/bin.dat`, Uint8Array.of(1, 0, 2, 0, 3));
      own(f, ["add", "--", "bin.dat"]);
      own(f, ["commit", "-q", "-m", "binary", "--", "bin.dat"]);
      f.h.write(`${f.repo}/bin.dat`, Uint8Array.of(1, 0, 2, 0, 4));
      const binaryBefore = { index: stageEntries(f.h, f.repo), files: f.h.digests(f.repo) };
      const binary = await compare(s, id, "bin.dat", "unstaged");
      const response = await applyHunk(s, id, binary, crypto.randomUUID(), "stage", { lines: [1] });
      expect({ ...outcome(response), reason: (response.result as { reason?: string } | undefined)?.reason }).toEqual({ state: "rejected", code: "UNSUPPORTED_COMPARISON", reason: "binary" });
      expect({ index: stageEntries(f.h, f.repo), files: f.h.digests(f.repo) }).toEqual(binaryBefore);
    });
  });

  W("Q19 FR-030 and FR-048: a read cut inside the untracked records gives cut untracked with the complete tracked and staged lists of the distro Git", async (w) => {
    const f = copy(w, "staging-tree");
    own(f, ["add", "--", "docs/d.txt"]);
    sh(w, 'for d in $(seq -f %03.0f 0 99); do mkdir -p "u/$d" && seq -f "u/$d/f%04.0f.txt" 0 999 | xargs touch; done', [], { cwd: f.repo });
    // git-status(1) porcelain v2 without untracked files: the tracked entries by category, as `readWorkspace` splits XY.
    // The fixture has no rename (`2 `) or unmerged (`u `) record, so every record is an ordinary `1 ` record.
    const records = nul(out(at(f), ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=no"]));
    expect(records.filter((rec) => !rec.startsWith("1 "))).toEqual([]);
    const tracked = records.flatMap((rec) => {
      const fields = rec.split(" ");
      const path = fields.slice(8).join(" ");
      return [...(fields[1]![0] !== "." ? [`staged ${path}`] : []), ...(fields[1]![1] !== "." ? [`unstaged ${path}`] : [])];
    }).sort();
    await withWsl(w, "t081-cut", async (s) => {
      const r = await open(s, w, f.repo);
      const read = await s.readWorkspace(r.repositoryId);
      expect(outcome(read)).toEqual({ state: "limited", code: "OUTPUT_LIMIT" });
      const result = read.result as WorkspaceResult & { cut?: string | null };
      expect({ completeness: result.completeness, cut: result.cut }).toEqual({ completeness: { state: "limited", code: "OUTPUT_LIMIT", reason: "STATUS_LISTING_RECORDS" }, cut: "untracked" });
      const entries = await allEntries(s, r.repositoryId, result);
      expect(entries.filter((e) => e.category !== "untracked").map((e) => `${e.category} ${e.path}`).sort()).toEqual(tracked);
      expect(entries.length).toBe(STATUS_LISTING_RECORDS);
      const committed = await reviewOk(s, r.repositoryId, result);
      expect(valuesOf(committed.response.result, "pathBytes")).toEqual([Buffer.from("docs/d.txt").toString("base64")]);
    });
  });
});
