// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T007: `reviewWorkbench` and `runWorkbench` with action `reset` (feature 010 contract Δ3, data-model §2 to §6, plan.md D4, SC-001, SC-002, SC-007).
// The oracle is Git's own `reset --<mode>` on a copy. Fresh Git reads decide every expectation, never message text.
// Control: build the Hard candidates from `diff-tree HEAD <target>`; the P4b case must fail.

import { expect } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { printOrigin } from "../origin";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { fc, fiModes, gitOut, gitPaths, gitRun, importStream, markers, refMap, type GitHost } from "./remote-fixtures";
import { caseTest, keepConfigs, type RegistrationResult, type Service, type ServiceResponse } from "./service-harness";
import { gitExe, hostFor, native, refreshIndex, register, repoShape, TIMEOUT_MS, until, withSync as syncService } from "./sync-harness";
import { hookEvents, logHooks } from "./workbench-fixtures";

// FR-005: each case keeps the bytes of every configuration file of the repositories that it registers.
const withSync = (name: string, body: (service: Service) => Promise<void>, options?: Parameters<typeof syncService>[2]) => syncService(name, (service) => keepConfigs(service, body), options);

for (const module of ["commit-actions", "workbench-review", "switch"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
useFixtureRoot();

const TASK = "T007";
const SHELL = ["shell-double"] as const;
const L = "--no-lazy-fetch";
const MAIN = "refs/heads/main";
const MODES = ["soft", "mixed", "hard"] as const;
type Mode = (typeof MODES)[number];
const SUCCEEDED = { state: "succeeded", code: undefined };
const WITH_EFFECTS = { state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" };
const outcome = (r: { state: string; code?: string }) => ({ state: r.state, code: r.code });
const refusal = (r: ServiceResponse<unknown>) => ({ ...outcome(r), result: r.result });
const unavailable = (reason: string) => ({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason } });

interface ResetPlan {
  target: string;
  mode: Mode;
  branch: string;
  from: string;
  leave: number;
  gain: number;
  reflogOnly: number;
  forceNote: { trackingRef: string } | null;
  trackedChanges: number;
  ignoredReplaced: number;
}
interface Reviewed {
  action: string;
  plan: ResetPlan;
  workbenchToken: string;
}
interface ResetRun {
  action: string;
  mode: Mode;
  head: { state: string; target?: string; oid?: string };
  refs: { ref: string }[];
  trackedChanges: number;
  outputTail?: string;
}

const RESET = (target: string, mode: Mode) => ({ action: "reset", target, mode });
const review = (service: Service, r: RegistrationResult, payload: object) => service.request<Reviewed>("reviewWorkbench", payload, { repositoryId: r.repositoryId, repositoryGeneration: r.generation });
const sendRun = (service: Service, r: RegistrationResult, token: string) => service.send("runWorkbench", { workbenchToken: token, start: true }, { repositoryId: r.repositoryId });

async function reviewed(service: Service, r: RegistrationResult, payload: object): Promise<Reviewed> {
  const response = await review(service, r, payload);
  expect({ ...outcome(response), result: response.state === "succeeded" ? "result" : response.result }).toEqual({ ...SUCCEEDED, result: "result" });
  expect(typeof response.result!.workbenchToken).toBe("string");
  return response.result!;
}

const run = async (service: Service, r: RegistrationResult, payload: object) => service.response<ResetRun>(sendRun(service, r, (await reviewed(service, r, payload)).workbenchToken));
const steps = (service: Service, from = 0) => service.runner.calls.slice(from).filter((c) => c.environmentPolicy === "integrate").map((c) => [...c.arguments]);
const isReset = (call: { arguments: readonly string[] }) => call.arguments[1] === "reset";

// SC-001: HEAD, every ref, the index entries, every working byte, and the markers.
const stateOf = (h: GitHost, repo: string) => ({ ...repoShape(h, repo), refs: refMap(h, repo), headOid: gitRun(h, repo, ["rev-parse", "--verify", "-q", "HEAD"], { allowExit: [0, 1] }).stdout.toString("utf8").trim() });
const count = (h: GitHost, repo: string, args: string[]) => Number(gitOut(h, repo, ["rev-list", "--count", ...args]).trim());
// The tracked records of `status --porcelain=v2 -z --untracked-files=no`. Header lines start with `#`; a rename record holds a second path field.
function trackedRecords(h: GitHost, repo: string): number {
  const fields = gitOut(h, repo, ["status", "--porcelain=v2", "-z", "--untracked-files=no", "--ignore-submodules=dirty"]).split("\0").filter((f) => f !== "");
  let n = 0;
  for (let i = 0; i < fields.length; i++) {
    if (fields[i]!.startsWith("#")) continue;
    n++;
    if (fields[i]!.startsWith("2 ")) i++;
  }
  return n;
}

function initRepo(h: GitHost, path: string): string {
  gitRun(h, h.root, ["init", "-q", "-b", "main", "--", path]);
  for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"]] as const) gitRun(h, path, ["config", key, value]);
  return path;
}

interface Fixture {
  repo: string;
  // Commit labels of the construction.
  c: Record<"base" | "m2" | "m3" | "m4" | "other", string>;
}

// base → m2 → m3 → m4 on main, and `other` from base. m2 writes the in-the-way paths and m3 deletes them again.
// `extra` adds commits after the five marks, from mark 6 on.
function build(h: GitHost, name: string, extra: Buffer[] = []): Fixture {
  const repo = initRepo(h, `${h.root}/${name}`);
  const marks = importStream(h, repo, [
    fc({ mark: 1, message: "base\n", files: { "a.txt": "a\n", "b.txt": "b\n", "p.txt": "p\n", ".gitignore": "*.log\n" } }),
    fc({ mark: 2, message: "m2\n", from: 1, files: { "a.txt": "a2\n", "new.txt": "new target\n", "d/f.txt": "f target\n", dirfile: "dirfile target\n", "build.log": "log target\n" } }),
    fiModes({ mark: 3, message: "m3\n", from: 2, entries: { "new.txt": null, "d/f.txt": null, dirfile: null, "build.log": null, "c.txt": ["100644", "c\n"] } }),
    fc({ mark: 4, message: "m4\n", from: 3, files: { "a.txt": "a4\n", "e.txt": "e\n" } }),
    fc({ mark: 5, ref: "refs/heads/other", message: "other\n", from: 1, files: { "o.txt": "o\n" } }),
    ...extra,
  ]);
  gitRun(h, repo, ["reset", "-q", "--hard", "main"]);
  return { repo, c: { base: marks.get(1)!, m2: marks.get(2)!, m3: marks.get(3)!, m4: marks.get(4)!, other: marks.get(5)! } };
}

// A staged new file (P4d, P4e), an unstaged edit, and an unrelated untracked file.
function dirty(h: GitHost, repo: string): void {
  h.write(`${repo}/staged.txt`, "staged\n");
  gitRun(h, repo, ["add", "--", "staged.txt"]);
  h.write(`${repo}/a.txt`, "a unstaged\n");
  h.write(`${repo}/notes.txt`, "notes\n");
}

async function approved(service: Service, repo: string): Promise<RegistrationResult> {
  const r = await register(service, repo);
  const trust = await service.readTrust(r.repositoryId);
  if (trust.result!.approvalRequired.workbench) expect((await service.approveTrust(r.repositoryId, "reset")).state).toBe("succeeded");
  return r;
}

describeGit("reset current branch to here (T007)", () => {
  let copies = 0;
  const copyOf = (h: GitHost, repo: string) => {
    const to = `${h.root}/copy-${++copies}`;
    h.copy(repo, to);
    return refreshIndex(h, to);
  };

  caseTest(TASK, "SC-001: each mode two commits back on a tree with a staged new file and an unstaged edit equals Git's own reset on a copy; each count equals rev-list --count", SHELL, async () => {
    const h = hostFor("t007-modes");
    for (const mode of MODES) {
      const f = build(h, `modes-${mode}`);
      dirty(h, f.repo);
      const o = copyOf(h, f.repo);
      await withSync(`t007-modes-${mode}`, async (service) => {
        const r = await approved(service, f.repo);
        const rv = await reviewed(service, r, RESET(f.c.m2, mode));
        expect(rv.plan).toEqual({
          target: f.c.m2,
          mode,
          branch: MAIN,
          from: f.c.m4,
          leave: count(h, f.repo, [`${f.c.m2}..HEAD`]),
          gain: count(h, f.repo, [`HEAD..${f.c.m2}`]),
          reflogOnly: count(h, f.repo, ["HEAD", "--not", f.c.m2, "--exclude=main", "--branches", "--tags", "--remotes"]),
          forceNote: null,
          trackedChanges: trackedRecords(h, f.repo),
          ignoredReplaced: 0,
        });
        expect([rv.plan.leave, rv.plan.gain, rv.plan.reflogOnly, rv.plan.trackedChanges]).toEqual([2, 0, 2, 2]);
        const from = service.runner.calls.length;
        const response = await service.response<ResetRun>(sendRun(service, r, rv.workbenchToken));
        expect({ mode, ...outcome(response) }).toEqual({ mode, ...SUCCEEDED });
        expect(steps(service, from)).toEqual([[L, "reset", "--quiet", "--no-recurse-submodules", `--${mode}`, f.c.m2, "--"]]);
        gitRun(h, o, ["reset", "--quiet", "--no-recurse-submodules", `--${mode}`, f.c.m2, "--"]);
        expect(response.result).toEqual({ action: "reset", mode, head: { state: "branch", target: MAIN, oid: f.c.m2 }, refs: [{ ref: MAIN }], trackedChanges: trackedRecords(h, o) });
      });
      expect({ mode, state: stateOf(h, f.repo) }).toEqual({ mode, state: stateOf(h, o) });
      // Git-reset(1) and research.md R2 P4d, P4e: Mixed keeps the staged new file as an untracked file; Hard deletes it. Unrelated untracked files stay.
      expect({ mode, staged: existsSync(native(`${f.repo}/staged.txt`)), notes: h.read(`${f.repo}/notes.txt`)?.toString() }).toEqual({ mode, staged: mode !== "hard", notes: "notes\n" });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "SC-001 and FR-042: a target outside the branch history and a tracking ref that holds a commit that leaves give the counts of rev-list --count and the force note", SHELL, async () => {
    const h = hostFor("t007-outside");
    const f = build(h, "outside");
    const bare = `${h.root}/remote.git`;
    gitRun(h, h.root, ["init", "-q", "--bare", "--", bare]);
    gitRun(h, f.repo, ["config", "remote.origin.url", native(bare)]);
    gitRun(h, f.repo, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    gitRun(h, f.repo, ["config", "branch.main.remote", "origin"]);
    gitRun(h, f.repo, ["config", "branch.main.merge", MAIN]);
    gitRun(h, f.repo, ["update-ref", "refs/remotes/origin/main", f.c.m3]);
    const o = copyOf(h, f.repo);
    await withSync("t007-outside", async (service) => {
      const r = await approved(service, f.repo);
      const rv = await reviewed(service, r, RESET(f.c.other, "mixed"));
      const counts = {
        leave: count(h, f.repo, [`${f.c.other}..HEAD`]),
        gain: count(h, f.repo, [`HEAD..${f.c.other}`]),
        reflogOnly: count(h, f.repo, ["HEAD", "--not", f.c.other, "--exclude=main", "--branches", "--tags", "--remotes"]),
      };
      expect(counts).toEqual({ leave: 3, gain: 1, reflogOnly: 1 });
      expect(rv.plan).toEqual({ target: f.c.other, mode: "mixed", branch: MAIN, from: f.c.m4, ...counts, forceNote: { trackingRef: "refs/remotes/origin/main" }, trackedChanges: 0, ignoredReplaced: 0 });
      expect(outcome(await service.response<ResetRun>(sendRun(service, r, rv.workbenchToken)))).toEqual(SUCCEEDED);
    });
    gitRun(h, o, ["reset", "--quiet", "--mixed", f.c.other, "--"]);
    expect(stateOf(h, f.repo)).toEqual(stateOf(h, o));
  }, TIMEOUT_MS);

  caseTest(TASK, "SC-001: each mode with the target at the branch tip, on a clean and a dirty tree, equals Git's own reset on a copy, and the branch ref does not move", SHELL, async () => {
    const h = hostFor("t007-tip");
    for (const tree of ["clean", "dirty"] as const) {
      for (const mode of MODES) {
        const f = build(h, `tip-${tree}-${mode}`);
        if (tree === "dirty") dirty(h, f.repo);
        const o = copyOf(h, f.repo);
        await withSync(`t007-tip-${tree}-${mode}`, async (service) => {
          const r = await approved(service, f.repo);
          const rv = await reviewed(service, r, RESET(f.c.m4, mode));
          expect({ tree, mode, counts: [rv.plan.leave, rv.plan.gain, rv.plan.reflogOnly, rv.plan.forceNote] }).toEqual({ tree, mode, counts: [0, 0, 0, null] });
          const response = await service.response<ResetRun>(sendRun(service, r, rv.workbenchToken));
          expect({ tree, mode, ...outcome(response), refs: response.result?.refs }).toEqual({ tree, mode, ...SUCCEEDED, refs: [] });
        });
        gitRun(h, o, ["reset", "--quiet", "--no-recurse-submodules", `--${mode}`, f.c.m4, "--"]);
        expect({ tree, mode, state: stateOf(h, f.repo) }).toEqual({ tree, mode, state: stateOf(h, o) });
      }
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-041 and data-model §6: detached, unborn, CONFLICTED, an operation in progress, and UNKNOWN_TARGET refuse; no step starts and every byte stays", SHELL, async () => {
    const h = hostFor("t007-refusals");
    const detached = build(h, "detached");
    gitRun(h, detached.repo, ["checkout", "-q", "--detach", "main"]);
    const unborn = build(h, "unborn");
    gitRun(h, unborn.repo, ["checkout", "-q", "--orphan", "fresh"]);
    const conflicted = build(h, "conflicted");
    // Unmerged index entries without a marker (git-update-index(1) `--index-info`).
    const blob = gitOut(h, conflicted.repo, ["rev-parse", "HEAD:a.txt"]).trim();
    gitRun(h, conflicted.repo, ["update-index", "--index-info"], { input: Buffer.from(`0 ${"0".repeat(40)}\ta.txt\n100644 ${blob} 1\ta.txt\n100644 ${blob} 2\ta.txt\n100644 ${blob} 3\ta.txt\n`) });
    const merging = build(h, "merging", [fc({ mark: 6, ref: "refs/heads/topic", message: "topic\n", from: 4, files: { "a.txt": "a topic\n" } }), fc({ mark: 7, message: "m5\n", from: 4, files: { "a.txt": "a main\n" } })]);
    gitRun(h, merging.repo, ["reset", "-q", "--hard", "main"]);
    gitRun(h, merging.repo, ["merge", "--no-edit", "topic"], { allowExit: [1] });
    const missing = build(h, "missing");
    const cases: [string, string, (c: Fixture["c"]) => string, { state: string; code: string; result: unknown }][] = [
      ["detached", detached.repo, (c) => c.m2, unavailable("detached")],
      ["unborn", unborn.repo, (c) => c.m2, unavailable("unborn")],
      ["conflicted", conflicted.repo, (c) => c.m2, { state: "failed", code: "CONFLICTED", result: { unmerged: 1 } }],
      ["merging", merging.repo, (c) => c.m2, { state: "failed", code: "OPERATION_IN_PROGRESS", result: undefined }],
      ["missing commit", missing.repo, () => "0123456789abcdef0123456789abcdef01234567", { state: "failed", code: "UNKNOWN_TARGET", result: undefined }],
      ["tree object", missing.repo, (c) => gitOut(h, missing.repo, ["rev-parse", `${c.m2}^{tree}`]).trim(), { state: "failed", code: "UNKNOWN_TARGET", result: undefined }],
    ];
    const fixtures: Record<string, Fixture> = { detached, unborn, conflicted, merging, "missing commit": missing, "tree object": missing };
    for (const [name, repo, target, expected] of cases) {
      const before = stateOf(h, repo);
      await withSync(`t007-refusal-${name.replace(" ", "-")}`, async (service) => {
        const r = await approved(service, repo);
        for (const mode of MODES) {
          const from = service.runner.calls.length;
          expect({ name, mode, ...refusal(await review(service, r, RESET(target(fixtures[name]!.c), mode))) }).toEqual({ name, mode, ...expected });
          expect({ name, mode, steps: steps(service, from) }).toEqual({ name, mode, steps: [] });
        }
      });
      expect({ name, state: stateOf(h, repo) }).toEqual({ name, state: before });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-043 and SC-002: Hard with an untracked file at a target path, an untracked file where the target has a folder, an index-removed path (P4b), or an untracked folder where the target has a file refuses with UNTRACKED_IN_WAY; every byte stays", SHELL, async () => {
    const h = hostFor("t007-in-the-way");
    const cases: [string, (f: Fixture) => void, (f: Fixture) => string, string[]][] = [
      ["P4 file", (f) => h.write(`${f.repo}/new.txt`, "new local\n"), (f) => f.c.m2, ["new.txt"]],
      ["P4 file in place of a folder", (f) => h.write(`${f.repo}/d`, "d local\n"), (f) => f.c.m2, ["d"]],
      [
        "P4b index-removed path",
        (f) => {
          gitRun(h, f.repo, ["rm", "-q", "--cached", "--", "p.txt"]);
          h.write(`${f.repo}/p.txt`, "p edited\n");
        },
        (f) => f.c.m3,
        ["p.txt"],
      ],
      ["folder in place of a file", (f) => h.write(`${f.repo}/dirfile/inner.txt`, "inner\n"), (f) => f.c.m2, ["dirfile"]],
    ];
    for (const [name, prepare, target, paths] of cases) {
      const f = build(h, `way-${paths[0]}`);
      prepare(f);
      const before = stateOf(h, f.repo);
      await withSync(`t007-way-${paths[0]}`, async (service) => {
        const r = await approved(service, f.repo);
        const from = service.runner.calls.length;
        expect({ name, ...refusal(await review(service, r, RESET(target(f), "hard"))) }).toEqual({ name, state: "failed", code: "UNTRACKED_IN_WAY", result: { reason: "untracked-in-way", paths, more: 0 } });
        expect({ name, steps: steps(service, from) }).toEqual({ name, steps: [] });
        // Soft and Mixed leave the working files, so no path is in their way.
        for (const mode of ["soft", "mixed"] as const) expect({ name, mode, ...outcome(await review(service, r, RESET(target(f), mode))) }).toEqual({ name, mode, ...SUCCEEDED });
      });
      expect({ name, state: stateOf(h, f.repo) }).toEqual({ name, state: before });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-043: 101 untracked files in the way list the first 100 paths with more 1, and more than DISCARD_CHECK_PATHS candidates refuse with limit; every byte stays", SHELL, async () => {
    const h = hostFor("t007-bounds");
    const names = Array.from({ length: 101 }, (_, i) => `w${String(i).padStart(3, "0")}.txt`);
    const many = build(h, "many", [fc({ mark: 6, ref: "refs/heads/wide", message: "wide\n", from: 4, files: Object.fromEntries(names.map((n) => [n, `${n} target\n`])) })]);
    for (const n of names) h.write(`${many.repo}/${n}`, `${n} local\n`);
    const huge = build(h, "huge", [fc({ mark: 6, ref: "refs/heads/huge", message: "huge\n", from: 4, files: Object.fromEntries(Array.from({ length: 20_001 }, (_, i) => [`f${String(i).padStart(5, "0")}.txt`, "x\n"])) })]);
    const wide = gitOut(h, many.repo, ["rev-parse", "wide"]).trim();
    const big = gitOut(h, huge.repo, ["rev-parse", "huge"]).trim();
    expect(gitOut(h, huge.repo, ["diff-index", "--cached", "-R", "--name-only", big, "--"]).split("\n").filter((l) => l !== "").length).toBe(20_001);
    const states = [stateOf(h, many.repo), stateOf(h, huge.repo)];
    await withSync("t007-bounds-many", async (service) => {
      const r = await approved(service, many.repo);
      expect(refusal(await review(service, r, RESET(wide, "hard")))).toEqual({ state: "failed", code: "UNTRACKED_IN_WAY", result: { reason: "untracked-in-way", paths: names.slice(0, 100), more: 1 } });
    });
    await withSync("t007-bounds-huge", async (service) => {
      const r = await approved(service, huge.repo);
      const from = service.runner.calls.length;
      expect(refusal(await review(service, r, RESET(big, "hard")))).toEqual(unavailable("limit"));
      expect(steps(service, from)).toEqual([]);
    });
    expect([stateOf(h, many.repo), stateOf(h, huge.repo)]).toEqual(states);
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-043 and P4c: an ignored file in the way does not refuse; the review counts it, and Hard replaces it as Git's own reset --hard on a copy", SHELL, async () => {
    const h = hostFor("t007-ignored");
    const f = build(h, "ignored");
    h.write(`${f.repo}/build.log`, "log local\n");
    const o = copyOf(h, f.repo);
    await withSync("t007-ignored", async (service) => {
      const r = await approved(service, f.repo);
      const rv = await reviewed(service, r, RESET(f.c.m2, "hard"));
      expect(rv.plan.ignoredReplaced).toBe(1);
      for (const mode of ["soft", "mixed"] as const) expect((await reviewed(service, r, RESET(f.c.m2, mode))).plan.ignoredReplaced).toBe(0);
      expect(outcome(await service.response<ResetRun>(sendRun(service, r, rv.workbenchToken)))).toEqual(SUCCEEDED);
    });
    gitRun(h, o, ["reset", "--quiet", "--hard", f.c.m2, "--"]);
    expect(stateOf(h, f.repo)).toEqual(stateOf(h, o));
    expect(h.read(`${f.repo}/build.log`)?.toString()).toBe("log target\n");
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-044 and P4c: an ignored folder where the target has a file counts each ignored file in it, as git ls-files --others --ignored lists them, and Hard replaces it as Git's own reset --hard on a copy", SHELL, async () => {
    const h = hostFor("t007-ignored-folder");
    const f = build(h, "ignored-folder");
    for (const name of ["x.txt", "y.txt", "z/w.txt"]) h.write(`${f.repo}/build.log/${name}`, `${name} local\n`);
    const o = copyOf(h, f.repo);
    const listed = gitOut(h, o, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", "build.log"]).split("\0").filter((p) => p !== "");
    expect(listed.sort()).toEqual(["build.log/x.txt", "build.log/y.txt", "build.log/z/w.txt"]);
    await withSync("t007-ignored-folder", async (service) => {
      const r = await approved(service, f.repo);
      const rv = await reviewed(service, r, RESET(f.c.m2, "hard"));
      expect(rv.plan.ignoredReplaced).toBe(listed.length);
      expect(outcome(await service.response<ResetRun>(sendRun(service, r, rv.workbenchToken)))).toEqual(SUCCEEDED);
    });
    gitRun(h, o, ["reset", "--quiet", "--hard", f.c.m2, "--"]);
    expect(stateOf(h, f.repo)).toEqual(stateOf(h, o));
    expect(h.read(`${f.repo}/build.log`)?.toString()).toBe("log target\n");
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-003: a new untracked file in the way after the Hard review gives STALE_REVIEW; a moved branch gives STALE_REVIEW; the 60 s expiry gives APPROVAL_EXPIRED; no step starts", SHELL, async () => {
    const h = hostFor("t007-stale");
    const f = build(h, "stale");
    await withSync("t007-stale", async (service) => {
      const r = await approved(service, f.repo);
      const rv = await reviewed(service, r, RESET(f.c.m2, "hard"));
      h.write(`${f.repo}/new.txt`, "new local\n");
      const before = stateOf(h, f.repo);
      const from = service.runner.calls.length;
      expect(outcome(await service.response(sendRun(service, r, rv.workbenchToken)))).toEqual({ state: "failed", code: "STALE_REVIEW" });
      expect(steps(service, from)).toEqual([]);
      expect(stateOf(h, f.repo)).toEqual(before);
      rmSync(native(`${f.repo}/new.txt`));
      const mixed = await reviewed(service, r, RESET(f.c.m2, "mixed"));
      gitRun(h, f.repo, ["update-ref", MAIN, f.c.m3]);
      expect(outcome(await service.response(sendRun(service, r, mixed.workbenchToken)))).toEqual({ state: "failed", code: "STALE_REVIEW" });
      expect(steps(service, from)).toEqual([]);
    });
    const g = build(h, "expired");
    let clock = 0;
    await withSync("t007-expired", async (service) => {
      const r = await approved(service, g.repo);
      const rv = await reviewed(service, r, RESET(g.c.m2, "soft"));
      clock += 60_001;
      const from = service.runner.calls.length;
      expect(outcome(await service.response(sendRun(service, r, rv.workbenchToken)))).toEqual({ state: "rejected", code: "APPROVAL_EXPIRED" });
      expect(service.runner.calls.length).toBe(from);
    }, { approvalClock: () => clock });
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-007: Cancel before the step starts no step and changes nothing; a step killed while index.lock exists gives failed-with-effects", SHELL, async () => {
    const h = hostFor("t007-cancel");
    const f = build(h, "cancel");
    const before = stateOf(h, f.repo);
    await withSync("t007-cancel", async (service) => {
      const r = await approved(service, f.repo);
      const rv = await reviewed(service, r, RESET(f.c.m2, "hard"));
      const release = service.runner.holdStart(isReset);
      const requestId = sendRun(service, r, rv.workbenchToken);
      const operationId = await service.operationId(requestId);
      await until(() => service.runner.calls.some((c) => c.operationId === operationId && isReset(c)), "held reset");
      await service.cancel(operationId);
      release();
      const response = await service.response<ResetRun>(requestId);
      expect(outcome(response)).toEqual({ state: "canceled", code: "CANCELED" });
      expect(response.result!.head).toEqual({ state: "branch", target: MAIN, oid: f.c.m4 });
    });
    expect(stateOf(h, f.repo)).toEqual(before);

    const k = build(h, "killed");
    const lock = native(gitPaths(h, k.repo, ["index.lock"])[0]!);
    const started = `${h.root}/killed.started`;
    const stop = `${h.root}/killed.release`;
    // The hook runs in the process tree of `git reset`, so the kill ends it with the lock in place. It waits at most 30 seconds.
    h.write(`${k.repo}/.git/hooks/reference-transaction`, `#!/bin/sh\n[ "$1" = prepared ] || exit 0\n: > '${lock}'\n: > '${started}'\ni=0\nwhile [ ! -f '${stop}' ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done\nexit 0\n`);
    try {
      await withSync("t007-killed", async (service) => {
        const r = await approved(service, k.repo);
        const requestId = sendRun(service, r, (await reviewed(service, r, RESET(k.c.m2, "soft"))).workbenchToken);
        await until(() => existsSync(native(started)), "reference-transaction hook start", 30_000);
        await service.cancel(await service.operationId(requestId));
        const response = await service.response<ResetRun>(requestId);
        expect(steps(service).length).toBe(1);
        expect(service.runner.calls.filter(isReset).map((c) => c.exit?.exitCode)).toEqual([null]);
        expect(outcome(response)).toEqual(WITH_EFFECTS);
        expect(markers(h, k.repo)).toContain("index.lock");
      });
    } finally {
      h.write(stop, "");
      rmSync(lock, { force: true });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "SC-007 and FR-004: hooks run only after the workbench approval, with the event set of research.md R2 P3 and the log of Git's own reset on a copy", SHELL, async () => {
    const h = hostFor("t007-hooks");
    const P3: Record<Mode, string[]> = { soft: ["reference-transaction"], mixed: ["post-index-change", "reference-transaction"], hard: ["post-index-change", "reference-transaction"] };
    for (const mode of MODES) {
      const f = build(h, `hooks-${mode}`);
      const o = copyOf(h, f.repo);
      const [log, oracleLog] = [`${h.root}/hooks-${mode}.log`, `${h.root}/hooks-${mode}-oracle.log`];
      logHooks(gitPaths(h, f.repo, ["hooks"])[0]!, log);
      logHooks(gitPaths(h, o, ["hooks"])[0]!, oracleLog);
      await withSync(`t007-hooks-${mode}`, async (service) => {
        const r = await register(service, f.repo);
        expect((await service.readTrust(r.repositoryId)).result!.approvalRequired.workbench).toBe(true);
        const from = service.runner.calls.length;
        expect({ mode, ...refusal(await review(service, r, RESET(f.c.m2, mode))) }).toEqual({ mode, state: "failed", code: "TRUST_REQUIRED", result: { trustGate: "repository" } });
        expect({ mode, steps: steps(service, from), log: existsSync(native(log)) }).toEqual({ mode, steps: [], log: false });
        expect((await service.approveTrust(r.repositoryId, "reset")).state).toBe("succeeded");
        expect({ mode, ...outcome(await run(service, r, RESET(f.c.m2, mode))) }).toEqual({ mode, ...SUCCEEDED });
      });
      gitRun(h, o, ["reset", "--quiet", "--no-recurse-submodules", `--${mode}`, f.c.m2, "--"]);
      expect({ mode, events: hookEvents(native(log)) }).toEqual({ mode, events: P3[mode] });
      expect({ mode, log: h.read(log)?.toString() }).toEqual({ mode, log: h.read(oracleLog)?.toString() });
    }
  }, TIMEOUT_MS);
});
