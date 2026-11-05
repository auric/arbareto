// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 010 T016: the commit menu actions through the distro Git of `ARBARETO_WSL_DISTRO` (spec FR-070, SC-008; plan.md D8). `Local: WSL`, alone.
// The oracle is the distro Git's own command on a `cp -a` copy in the same distro. The harness is `workbench-wsl-harness.ts`.
// The service gives the distro Git no fixed commit dates, so new commits count as their tree, subject, and parent shapes (`shapeState`).
// Modes, owners, and link counts come from GNU `find -printf` inside the distro.
// Control: send `mixed` for the Hard case; the byte comparison must fail.

import { expect } from "bun:test";
import { printOrigin } from "../origin";
import { compare, outcome, readOk, SUCCEEDED } from "../git/hunk-harness";
import { fc, fiModes, gitOut, gitRun, importStream, markers } from "../git/remote-fixtures";
import { ANY_EXIT, sendSync } from "../git/sync-harness";
import type { RegistrationResult, Service } from "../git/service-harness";
import { sh } from "./fixtures";
import { hostOf, L, nul, open, type Repo, refusalOf, request, RESPONSE_MS, review, runToken, shapeState, steps, switchTo, token, useWorkbenchWsl, W, WITH_EFFECTS, withWsl } from "./workbench-wsl-harness";
import type { WslHost } from "./wsl-host";

for (const module of ["commit-actions", "sync-review", "status", "workbench-commands"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
printOrigin("./commit-actions-wsl.test.ts", import.meta.dir);
useWorkbenchWsl();

const MAIN = "refs/heads/main";
const MODES = ["soft", "mixed", "hard"] as const;
type Labels = "base" | "m2" | "m3" | "m4" | "t1" | "t2" | "s1" | "x1" | "merge";
interface Fixture {
  w: WslHost;
  repo: string;
  c: Record<Labels, string>;
}

let builds = 0;
// main: base → m2 → m3 → m4. m2 adds new.txt and makes run.sh 100644; m3 deletes new.txt and changes b.txt; m4 makes run.sh 100755 again.
// topic: t1 (t.txt and the 100755 tool.sh) → t2 (b.txt, a conflict on main). side: s1, then the merge of x1.
function build(w: WslHost, name: string): Fixture {
  const h = hostOf(w);
  const repo = `${h.root}/t016-${name}-${++builds}`;
  gitRun(h, h.root, ["init", "-q", "-b", "main", "--", repo]);
  for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"]] as const) gitRun(h, repo, ["config", key, value]);
  const marks = importStream(h, repo, [
    fiModes({ mark: 1, message: "base\n", entries: { "a.txt": ["100644", "a\n"], "b.txt": ["100644", "b\n"], "run.sh": ["100755", "#!/bin/sh\necho 1\n"], ".gitignore": ["100644", "*.log\n"] } }),
    fiModes({ mark: 2, message: "m2\n", from: 1, entries: { "a.txt": ["100644", "a2\n"], "new.txt": ["100644", "new target\n"], "run.sh": ["100644", "#!/bin/sh\necho 2\n"] } }),
    fiModes({ mark: 3, message: "m3\n", from: 2, entries: { "new.txt": null, "b.txt": ["100644", "b main\n"] } }),
    fiModes({ mark: 4, message: "m4\n", from: 3, entries: { "a.txt": ["100644", "a4\n"], "e.txt": ["100644", "e\n"], "run.sh": ["100755", "#!/bin/sh\necho 4\n"] } }),
    fiModes({ mark: 5, ref: "refs/heads/topic", message: "t1\n", from: 1, entries: { "t.txt": ["100644", "t\n"], "tool.sh": ["100755", "#!/bin/sh\necho tool\n"] } }),
    fc({ mark: 6, ref: "refs/heads/topic", message: "t2\n", from: 5, files: { "b.txt": "b topic\n" } }),
    fc({ mark: 7, ref: "refs/heads/side", message: "s1\n", from: 1, files: { "s.txt": "s\n" } }),
    fc({ mark: 8, ref: "refs/heads/xbr", message: "x1\n", from: 1, files: { "x.txt": "x\n" } }),
    fc({ mark: 9, ref: "refs/heads/side", message: "merge x1\n", from: 7, merge: [8], files: { "x.txt": "x\n" } }),
  ]);
  gitRun(h, repo, ["reset", "-q", "--hard", "main"]);
  const labels: Labels[] = ["base", "m2", "m3", "m4", "t1", "t2", "s1", "x1", "merge"];
  return { w, repo, c: Object.fromEntries(labels.map((l, i) => [l, marks.get(i + 1)!])) as Record<Labels, string> };
}

// `cp -a` gives new inodes and change times, so the copy refreshes its index stat data (git-update-index(1) `--refresh`).
function copyOf(f: Fixture): string {
  const h = hostOf(f.w);
  const to = `${f.repo}-oracle`;
  h.copy(f.repo, to);
  gitRun(h, to, ["update-index", "-q", "--refresh"], { allowExit: ANY_EXIT });
  return to;
}
const repoAt = (w: WslHost, dir: string): Repo => ({ w, h: hostOf(w), dir });
const own = (w: WslHost, dir: string, args: string[], allowExit = [0]) => gitRun(hostOf(w), dir, args, { allowExit });

// SC-008: GNU find `%m %U %G %n` gives the mode bits, the owner, the group, and the link count of each working file.
function stats(w: WslHost, dir: string): Record<string, string> {
  const fields = nul(Buffer.from(sh(w, 'cd -- "$1" && find . -path ./.git -prune -o -type f -printf "%P\\0%m %U %G %n\\0"', [dir]).bytes).toString("utf8"));
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) out[fields[i]!] = fields[i + 1]!;
  return out;
}
// The full SC-008 comparison of a fixture and its oracle.
const full = (w: WslHost, dir: string) => ({ state: shapeState(repoAt(w, dir)), stats: stats(w, dir) });

async function approved(s: Service, w: WslHost, dir: string, action: string): Promise<RegistrationResult> {
  const r = await open(s, w, dir);
  const trust = await request<{ approvalRequired: { workbench: boolean } }>(s, "readTrust", {}, { repositoryId: r.repositoryId });
  if (trust.result!.approvalRequired.workbench) expect((await request(s, "approveTrust", { action }, { repositoryId: r.repositoryId })).state).toBe("succeeded");
  return r;
}

async function reviewSync(s: Service, r: RegistrationResult, action: string) {
  const read = await readOk(s, r.repositoryId);
  const reviewed = await request<{ syncReviewToken?: string }>(s, "reviewSync", { action }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });
  return { reviewed, generation: read.generation };
}

W("T016 SC-008: each reset mode on a tree with a staged new file, an unstaged edit, and an untracked file equals the distro Git's own reset on a copy, with the same modes, owners, and link counts", async (w) => {
  for (const mode of MODES) {
    const f = build(w, `reset-${mode}`);
    const h = hostOf(w);
    h.write(`${f.repo}/staged.txt`, "staged\n");
    own(w, f.repo, ["add", "--", "staged.txt"]);
    h.write(`${f.repo}/a.txt`, "a unstaged\n");
    h.write(`${f.repo}/notes.txt`, "notes\n");
    const o = copyOf(f);
    await withWsl(w, `t016-reset-${mode}`, async (s) => {
      const r = await approved(s, w, f.repo, "reset");
      const rv = await token(s, r, { action: "reset", target: f.c.m2, mode });
      expect({ mode, plan: rv.plan }).toMatchObject({ mode, plan: { target: f.c.m2, mode, branch: MAIN, from: f.c.m4, leave: 2, gain: 0, forceNote: null } });
      const from = s.runner.calls.length;
      const response = await runToken(s, r, rv.workbenchToken);
      expect({ mode, ...outcome(response) }).toEqual({ mode, ...SUCCEEDED });
      expect({ mode, steps: steps(s, from) }).toEqual({ mode, steps: [[L, "reset", "--quiet", "--no-recurse-submodules", `--${mode}`, f.c.m2, "--"]] });
      expect(response.result).toMatchObject({ action: "reset", mode, head: { state: "branch", target: MAIN, oid: f.c.m2 } });
    });
    own(w, o, ["reset", "--quiet", "--no-recurse-submodules", `--${mode}`, f.c.m2, "--"]);
    expect({ mode, ...full(w, f.repo) }).toEqual({ mode, ...full(w, o) });
    // Hard writes the m2 run.sh with mode 100644. Soft and Mixed keep the m4 file.
    expect({ mode, run: stats(w, f.repo)["run.sh"]!.split(" ")[0] }).toEqual({ mode, run: mode === "hard" ? "644" : "755" });
  }
});

W("T016 FR-043: Hard refuses a Linux untracked file in the way with UNTRACKED_IN_WAY before any Git step; Soft and Mixed review; every byte, mode, and link count stays", async (w) => {
  const f = build(w, "in-the-way");
  hostOf(w).write(`${f.repo}/new.txt`, "new local\n");
  const before = full(w, f.repo);
  await withWsl(w, "t016-in-the-way", async (s) => {
    const r = await approved(s, w, f.repo, "reset");
    const from = s.runner.calls.length;
    expect(refusalOf(await review(s, r, { action: "reset", target: f.c.m2, mode: "hard" }))).toEqual({ state: "failed", code: "UNTRACKED_IN_WAY", result: { reason: "untracked-in-way", paths: ["new.txt"], more: 0 } });
    for (const mode of ["soft", "mixed"] as const) expect({ mode, ...outcome(await review(s, r, { action: "reset", target: f.c.m2, mode })) }).toEqual({ mode, ...SUCCEEDED });
    expect(steps(s, from)).toEqual([]);
  });
  expect(full(w, f.repo)).toEqual(before);
});

// An annotated tag object holds the tagger date. The comparison drops the `tagger` header (git-tag(1), the tag object format) and keeps the other headers and the message.
function tagObject(w: WslHost, dir: string, ref: string): string {
  const raw = gitOut(hostOf(w), dir, ["cat-file", "tag", ref]);
  const split = raw.indexOf("\n\n");
  const headers = raw.slice(0, split).split("\n").filter((l) => !l.startsWith("tagger "));
  return `${headers.join("\n")}${raw.slice(split)}`;
}

W("T016 SC-004: a lightweight and an annotated tag equal the distro Git's own git tag on a copy", async (w) => {
  const f = build(w, "tags");
  const o = copyOf(f);
  const MESSAGE = "Release 1.0\n\nNotes line\n";
  await withWsl(w, "t016-tags", async (s) => {
    const r = await approved(s, w, f.repo, "tag");
    for (const [name, target, message] of [["v1.0", f.c.base, null], ["rel/2", f.c.m4, MESSAGE]] as const) {
      const rv = await token(s, r, { action: "create-tag", name, target, message });
      const from = s.runner.calls.length;
      const response = await runToken(s, r, rv.workbenchToken);
      expect({ name, ...outcome(response) }).toEqual({ name, ...SUCCEEDED });
      expect({ name, steps: steps(s, from) }).toEqual({ name, steps: [[L, "tag", ...(message === null ? [] : ["-m", message]), "--end-of-options", name, target]] });
    }
  });
  own(w, o, ["tag", "--end-of-options", "v1.0", f.c.base]);
  own(w, o, ["tag", "-m", MESSAGE, "--end-of-options", "rel/2", f.c.m4]);
  const withoutTag = (dir: string) => {
    const x = full(w, dir);
    const { "refs/tags/rel/2": _, ...refs } = x.state.refs;
    return { ...x, state: { ...x.state, refs } };
  };
  expect(withoutTag(f.repo)).toEqual(withoutTag(o));
  for (const dir of [f.repo, o]) expect(gitOut(hostOf(w), dir, ["cat-file", "-t", "refs/tags/rel/2"]).trim()).toBe("tag");
  expect(tagObject(w, f.repo, "refs/tags/rel/2")).toBe(tagObject(w, o, "refs/tags/rel/2"));
  expect(gitOut(hostOf(w), f.repo, ["rev-parse", "refs/tags/v1.0"]).trim()).toBe(f.c.base);
});

W("T016 SC-003: a clean cherry-pick, a clean revert, and a merge revert with -m 1 equal the distro Git's own command on a copy, with the same modes, owners, and link counts", async (w) => {
  const cases: [string, "cherry-pick" | "revert-commit", Labels, number | null, string | null][] = [
    ["clean pick", "cherry-pick", "t1", null, null],
    ["clean revert", "revert-commit", "m4", null, null],
    ["merge revert", "revert-commit", "merge", 1, "side"],
  ];
  for (const [name, action, label, mainline, branch] of cases) {
    const f = build(w, name.replace(" ", "-"));
    if (branch !== null) own(w, f.repo, ["checkout", "-q", branch]);
    const o = copyOf(f);
    const commit = f.c[label];
    const args = [action === "cherry-pick" ? "cherry-pick" : "revert", ...(action === "revert-commit" ? ["--no-edit"] : []), ...(mainline === null ? [] : ["-m", String(mainline)]), commit];
    await withWsl(w, `t016-${name.replace(" ", "-")}`, async (s) => {
      const r = await approved(s, w, f.repo, "cherry-pick");
      const rv = await token(s, r, { action, commit, mainline });
      const from = s.runner.calls.length;
      const response = await runToken(s, r, rv.workbenchToken);
      expect({ name, ...outcome(response) }).toEqual({ name, ...SUCCEEDED });
      expect({ name, steps: steps(s, from) }).toEqual({ name, steps: [[L, ...args]] });
      expect({ name, operationState: response.result!.operationState, unmerged: response.result!.unmerged }).toEqual({ name, operationState: "normal", unmerged: 0 });
    });
    own(w, o, args);
    expect({ name, ...full(w, f.repo) }).toEqual({ name, ...full(w, o) });
  }
});

W("T016 SC-006: a cherry-pick conflict stops as the distro Git does; Abort, and Mark resolved with Continue, equal the distro Git's own commands on a copy", async (w) => {
  for (const finish of ["abort", "continue"] as const) {
    const f = build(w, `pick-${finish}`);
    const o = copyOf(f);
    await withWsl(w, `t016-pick-${finish}`, async (s) => {
      const r = await approved(s, w, f.repo, "cherry-pick");
      const from = s.runner.calls.length;
      const stopped = await runToken(s, r, (await token(s, r, { action: "cherry-pick", commit: f.c.t2, mainline: null })).workbenchToken);
      expect({ finish, ...outcome(stopped), operationState: stopped.result!.operationState, unmerged: stopped.result!.unmerged }).toEqual({ finish, ...WITH_EFFECTS, operationState: "cherry-picking", unmerged: 1 });
      expect(steps(s, from)).toEqual([[L, "cherry-pick", f.c.t2]]);
      own(w, o, ["cherry-pick", f.c.t2], [1]);
      expect({ finish, ...full(w, f.repo) }).toEqual({ finish, ...full(w, o) });
      if (finish === "continue") {
        for (const dir of [f.repo, o]) hostOf(w).write(`${dir}/b.txt`, "resolved\n");
        const c = await compare(s, r.repositoryId, "b.txt", "conflicted");
        expect(outcome(await request(s, "applyFile", { comparisonId: c.comparisonId, snapshotId: c.read.snapshotId, direction: "resolve" }, { repositoryId: r.repositoryId, repositoryGeneration: c.read.generation }))).toEqual(SUCCEEDED);
        own(w, o, ["--literal-pathspecs", "add", "--", "b.txt"]);
      }
      const { reviewed, generation } = await reviewSync(s, r, finish);
      expect({ finish, ...outcome(reviewed) }).toEqual({ finish, ...SUCCEEDED });
      const at = s.runner.calls.length;
      const done = await s.response(sendSync(s, { ...r, generation }, reviewed.result!.syncReviewToken!), RESPONSE_MS);
      expect({ finish, ...outcome(done) }).toEqual({ finish, ...SUCCEEDED });
      expect({ finish, steps: steps(s, at) }).toEqual({ finish, steps: [[L, "cherry-pick", `--${finish}`]] });
    });
    own(w, o, ["cherry-pick", `--${finish}`]);
    expect({ finish, ...full(w, f.repo) }).toEqual({ finish, ...full(w, o) });
    expect(markers(hostOf(w), f.repo)).toEqual([]);
  }
});

W("T016 plan.md D6: with a .git/sequencer folder from a two-commit cherry-pick in the distro, Abort and Continue refuse with sequence; no Git step starts and every byte stays", async (w) => {
  const f = build(w, "sequence");
  own(w, f.repo, ["cherry-pick", f.c.t2, f.c.s1], [1]);
  expect(markers(hostOf(w), f.repo)).toEqual(["CHERRY_PICK_HEAD", "sequencer"]);
  const before = full(w, f.repo);
  await withWsl(w, "t016-sequence", async (s) => {
    const r = await approved(s, w, f.repo, "cherry-pick");
    const from = s.runner.calls.length;
    for (const action of ["abort", "continue"]) expect({ action, ...refusalOf((await reviewSync(s, r, action)).reviewed) }).toEqual({ action, state: "failed", code: "SYNC_UNAVAILABLE", result: { reason: "sequence" } });
    expect(steps(s, from)).toEqual([]);
  });
  expect(full(w, f.repo)).toEqual(before);
});

W("T016 FR-020: Check out this commit gives a detached HEAD and equals the distro Git's own checkout on a copy, with the same modes, owners, and link counts", async (w) => {
  const f = build(w, "detach");
  const o = copyOf(f);
  await withWsl(w, "t016-detach", async (s) => {
    const r = await approved(s, w, f.repo, "switch");
    const rv = await token(s, r, switchTo("keep", { detach: f.c.m2 }));
    const from = s.runner.calls.length;
    const response = await runToken(s, r, rv.workbenchToken);
    expect({ ...outcome(response), head: response.result!.head }).toEqual({ ...SUCCEEDED, head: { state: "detached", oid: f.c.m2 } });
    expect(steps(s, from).filter((a) => a[1] === "checkout")).toEqual([[L, "checkout", "--no-recurse-submodules", "--detach", f.c.m2, "--"]]);
  });
  own(w, o, ["checkout", "-q", "--no-recurse-submodules", "--detach", f.c.m2, "--"]);
  expect(full(w, f.repo)).toEqual(full(w, o));
  expect(full(w, f.repo).state.head).toBe("detached");
  expect(stats(w, f.repo)["run.sh"]!.split(" ")[0]).toBe("644");
});
