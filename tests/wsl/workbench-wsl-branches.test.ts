// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// 004 T081 and 006 T034 service cases: switch, branches, merge, and rebase through the distro Git (quickstart.md Q5 to Q12). The harness is `workbench-wsl-harness.ts`.

import { describe, expect } from "bun:test";
import { join } from "node:path";
import { same } from "../git/fact-runner";
import { commit, compare, outcome, readOk, SUCCEEDED, until } from "../git/hunk-harness";
import { fc, gitRun, importStream, refMap } from "../git/remote-fixtures";
import { ANY_EXIT, sendSync } from "../git/sync-harness";
import { type WbFixtureName } from "../git/workbench-fixtures";
import { sh } from "./fixtures";
import { at, bytes, changed, confirms, copy, count, type DistroFixture, hostOf, inTheWay, L, MESSAGE, message, open, out, own, reachable, recordLines, refusalOf, type Repo, request, RESPONSE_MS, review, reviewRun, run, type RunResult, runToken, sendRun, shapeState, shared, stashValue, state, steps, subcommands, subjects, switchTo, TARGET, text, token, unavailable, useWorkbenchWsl, valueOf, W, WITH_EFFECTS, withWsl } from "./workbench-wsl-harness";

useWorkbenchWsl();

describe("switch through the distro Git (quickstart.md Q5 to Q8)", () => {
  W("Q5 SC-001: a clean and a dirty tree with Keep changes, Stash and reapply, and Discard changes equal the distro Git's own commands on a copy", async (w) => {
    const oracle: Record<string, string[][]> = {
      keep: [["checkout", "-q", "--no-guess", "target", "--"]],
      stash: [["stash", "push", "--quiet", "-m", MESSAGE], ["checkout", "-q", "--no-guess", "target", "--"], ["stash", "apply", "--index"], ["stash", "drop", "--quiet"]],
      discard: [["stash", "push", "--quiet", "-m", MESSAGE], ["checkout", "-q", "--no-guess", "target", "--"], ["stash", "drop", "--quiet"]],
    };
    const expected: Record<string, string[]> = { keep: ["checkout"], stash: ["stash push", "checkout", "stash apply", "stash drop"], discard: ["stash push", "checkout", "stash drop"] };
    for (const [fixture, choice] of [["switch-clean", "keep"], ["switch-dirty", "keep"], ["switch-dirty", "stash"], ["switch-dirty", "discard"]] as const) {
      const f = copy(w, fixture);
      const o = copy(w, fixture);
      await withWsl(w, `t081-switch-${fixture}-${choice}`, async (s) => {
        const r = await open(s, w, f.repo);
        const rv = await token(s, r, switchTo(choice));
        expect(rv.plan).toMatchObject({ target: { local: TARGET }, choice, inTheWay: null, unreachable: null, heldBy: null });
        const from = s.runner.calls.length;
        const response = await runToken(s, r, rv.workbenchToken);
        expect({ fixture, choice, ...outcome(response) }).toEqual({ fixture, choice, ...SUCCEEDED });
        expect(response.result).toMatchObject({ action: "switch", head: { state: "branch", target: TARGET, oid: f.oids.target } });
        expect(response.result!.stash?.state ?? null).toBe(choice === "keep" ? null : "dropped");
        expect(subcommands(s, from)).toEqual(expected[choice]!);
      });
      for (const args of oracle[choice]!) own(o, args);
      expect({ fixture, choice, state: shapeState(at(f)) }).toEqual({ fixture, choice, state: shapeState(at(o)) });
    }
  });

  W("Q6 FR-011: Keep changes with a conflicting change fails as the distro Git refuses and changes nothing; Discard with an untracked file in the way refuses before any Git step", async (w) => {
    const f = copy(w, "switch-conflict");
    const before = shapeState(at(f));
    const u = copy(w, "switch-untracked");
    u.h.write(`${u.repo}/b.txt`, "b changed\n");
    const untracked = shapeState(at(u));
    await withWsl(w, "t081-keep-conflict", async (s) => {
      const r = await open(s, w, f.repo);
      const response = await reviewRun(s, r, switchTo("keep"));
      expect(outcome(response)).toEqual({ state: "failed", code: "GIT_FAILED" });
      expect(response.result).toMatchObject({ action: "switch", head: { state: "branch", target: "refs/heads/main", oid: f.oids.base }, stash: null, conflicted: 0 });
      const ru = await open(s, w, u.repo);
      const from = s.runner.calls.length;
      expect(refusalOf(await review(s, ru, switchTo("discard")))).toEqual({ state: "failed", code: "UNTRACKED_IN_WAY", result: { reason: "untracked-in-way", paths: ["new.txt"], more: 0 } });
      expect(steps(s, from)).toEqual([]);
    });
    expect(shapeState(at(f))).toEqual(before);
    expect(shapeState(at(u))).toEqual(untracked);
  });

  W("Q7 FR-012: Stash and reapply with a reapply conflict keeps the stash and shows the unmerged entry; a failed checkout reapplies nothing; both equal the distro Git's own commands on a copy", async (w) => {
    const f = copy(w, "switch-conflict");
    const o = copy(w, "switch-conflict");
    const g = copy(w, "switch-untracked");
    const p = copy(w, "switch-untracked");
    for (const x of [g, p]) x.h.write(`${x.repo}/b.txt`, "b changed\n");
    await withWsl(w, "t081-reapply", async (s) => {
      const r = await open(s, w, f.repo);
      const from = s.runner.calls.length;
      const response = await reviewRun(s, r, switchTo("stash"));
      expect(outcome(response)).toEqual(WITH_EFFECTS);
      expect(subcommands(s, from)).toEqual(["stash push", "checkout", "stash apply"]);
      expect(response.result).toMatchObject({ head: { state: "branch", target: TARGET, oid: f.oids.target }, stash: { oid: stashValue(at(f)), state: "kept-conflicts" }, conflicted: 1 });
      const rg = await open(s, w, g.repo);
      const next = s.runner.calls.length;
      const failed = await reviewRun(s, rg, switchTo("stash"));
      expect(outcome(failed)).toEqual(WITH_EFFECTS);
      expect(subcommands(s, next)).toEqual(["stash push", "checkout"]);
      expect(failed.result).toMatchObject({ head: { state: "branch", target: "refs/heads/main", oid: g.oids.base }, stash: { oid: stashValue(at(g)), state: "kept-failed-checkout" }, conflicted: 0 });
      // Feature 003 contract Δ3 `reviewSync` and `clone`: a remedy is text only for a WSL Git, so the command is null.
      const remedy = (failed.result as { remedy?: { text: unknown; command: unknown } }).remedy;
      expect({ text: typeof remedy?.text, command: remedy?.command }).toEqual({ text: "string", command: null });
    });
    own(o, ["stash", "push", "--quiet", "-m", MESSAGE]);
    own(o, ["checkout", "-q", "--no-guess", "target", "--"]);
    own(o, ["stash", "apply", "--index", stashValue(at(o))!], [1]);
    expect(shapeState(at(f))).toEqual(shapeState(at(o)));
    own(p, ["stash", "push", "--quiet", "-m", MESSAGE]);
    own(p, ["checkout", "-q", "--no-guess", "target", "--"], [1]);
    expect(shapeState(at(g))).toEqual(shapeState(at(p)));
    expect(g.h.read(`${g.repo}/new.txt`)!.toString("utf8")).toBe("new local\n");
  });

  W("Q8 FR-013: a remote branch with one and zero mapping refspecs, a branch of another worktree with its Linux path, and a switch away from an unreachable detached commit", async (w) => {
    const f = copy(w, "switch-clean");
    const o = copy(w, "switch-clean");
    const z = copy(w, "switch-clean");
    const zero = shapeState(at(z));
    const b = shared(w, "branches");
    const holder = recordLines(out(at(b), ["worktree", "list", "--porcelain", "-z"])).find((lines) => lines.includes("branch refs/heads/wt-held"))!;
    expect(valueOf(holder, "worktree")).toBe(`${b.root}/wt-other`);
    await withWsl(w, "t081-track", async (s) => {
      const r = await open(s, w, f.repo);
      const from = s.runner.calls.length;
      expect(outcome(await reviewRun(s, r, switchTo("keep", { track: { ref: "refs/remotes/one/topic", name: "topic" } })))).toEqual(SUCCEEDED);
      expect(steps(s, from)).toEqual([[L, "checkout", "--no-guess", "--no-recurse-submodules", "-b", "topic", "--track=direct", "refs/remotes/one/topic", "--"]]);
      const rz = await open(s, w, z.repo);
      const next = s.runner.calls.length;
      expect(refusalOf(await review(s, rz, switchTo("keep", { track: { ref: "refs/remotes/zero/topic", name: "typed-zero" } })))).toEqual(unavailable("no-tracking-refspec"));
      expect(steps(s, next)).toEqual([]);
      const rb = await open(s, w, b.repo);
      expect(refusalOf(await review(s, rb, switchTo("keep", { ref: "refs/heads/wt-held" })))).toEqual(unavailable("other-worktree", { worktree: valueOf(holder, "worktree") }));
      const detached = await open(s, w, `${b.root}/wt-detached`);
      expect((await token(s, detached, switchTo("keep", { ref: "refs/heads/merged" }))).plan.unreachable).toBe(b.oids.unreachable!);
    });
    own(o, ["checkout", "-q", "-b", "topic", "--track", "one/topic", "--"]);
    expect(shapeState(at(f))).toEqual(shapeState(at(o)));
    expect(shapeState(at(z))).toEqual(zero);
  });

  W("T034 Q8 FR-013 and 004 research.md R21 F8: a remote branch with two mapping refspecs tracks as the distro Git's own checkout --track on a copy", async (w) => {
    const f = copy(w, "switch-clean");
    const o = copy(w, "switch-clean");
    await withWsl(w, "t034-track-two", async (s) => {
      const r = await open(s, w, f.repo);
      const from = s.runner.calls.length;
      expect(outcome(await reviewRun(s, r, switchTo("keep", { track: { ref: "refs/remotes/two/x/topic", name: "typed-two" } })))).toEqual(SUCCEEDED);
      expect(steps(s, from)).toEqual([[L, "checkout", "--no-guess", "--no-recurse-submodules", "-b", "typed-two", "--track=direct", "refs/remotes/two/x/topic", "--"]]);
    });
    own(o, ["checkout", "-q", "-b", "typed-two", "--track", "two/x/topic", "--"]);
    expect(shapeState(at(f))).toEqual(shapeState(at(o)));
  });
});

describe("branches, merge, and rebase through the distro Git (quickstart.md Q9 to Q12)", () => {
  W("Q9 FR-015 to FR-018: create with and without switch, rename, delete with the onlyHere count, and the current-branch refusal equal the distro Git's own commands on a copy", async (w) => {
    const f = copy(w, "branches");
    const o = copy(w, "branches");
    const start = f.oids.second!;
    // F10: the commits that Git's own branch -D makes unreachable.
    const c = copy(w, "branches");
    const before = reachable(at(c));
    own(c, ["branch", "-D", "--end-of-options", "feature/a/b"]);
    const after = reachable(at(c));
    const onlyHere = [...before].filter((x) => !after.has(x)).length;
    await withWsl(w, "t081-branches", async (s) => {
      const r = await open(s, w, f.repo);
      let from = s.runner.calls.length;
      expect(outcome(await reviewRun(s, r, { action: "create-branch", name: "new-a", start, switchTo: false }))).toEqual(SUCCEEDED);
      expect(outcome(await reviewRun(s, r, { action: "create-branch", name: "new-b", start, switchTo: true }))).toEqual(SUCCEEDED);
      expect(outcome(await reviewRun(s, r, { action: "rename-branch", ref: "refs/heads/unmerged", name: "renamed" }))).toEqual(SUCCEEDED);
      expect(steps(s, from)).toEqual([
        [L, "branch", "--end-of-options", "new-a", start],
        [L, "checkout", "--no-recurse-submodules", "-b", "new-b", start, "--"],
        [L, "branch", "-m", "--end-of-options", "unmerged", "renamed"],
      ]);
      const rv = await token(s, r, { action: "delete-branch", ref: "refs/heads/feature/a/b" });
      expect(rv.plan).toMatchObject({ ref: "refs/heads/feature/a/b", oid: f.refs["refs/heads/feature/a/b"], onlyHere, heldBy: null, current: false });
      from = s.runner.calls.length;
      expect(outcome(await runToken(s, r, rv.workbenchToken))).toEqual(SUCCEEDED);
      expect(steps(s, from).map((a) => a[1])).toEqual(["update-ref"]);
      expect(refusalOf(await review(s, r, { action: "delete-branch", ref: "refs/heads/new-b" }))).toEqual(unavailable("current-branch"));
    });
    own(o, ["branch", "--end-of-options", "new-a", start]);
    own(o, ["checkout", "-q", "-b", "new-b", start, "--"]);
    own(o, ["branch", "-m", "--end-of-options", "unmerged", "renamed"]);
    own(o, ["branch", "-D", "--end-of-options", "feature/a/b"]);
    expect(shapeState(at(f))).toEqual(shapeState(at(o)));
  });

  W("Q10 FR-021 to FR-023: Merge commit, a fast-forward, Squash, and a pre-merge-commit hook that rejects equal the distro Git's own merge on a copy", async (w) => {
    const MERGE = (o: object = {}) => ({ action: "merge", ref: "refs/heads/topic", result: "merge", noFastForward: false, noCommit: false, message: null, ...o });
    for (const [fixture, options, flags] of [["merge-diverged", {}, []], ["merge-ff", {}, []], ["merge-diverged", { result: "squash" }, ["--squash"]]] as [WbFixtureName, object, string[]][]) {
      const f = copy(w, fixture);
      const o = copy(w, fixture);
      await withWsl(w, `t081-merge-${fixture}-${flags.join("")}`, async (s) => {
        const r = await open(s, w, f.repo);
        const rv = await token(s, r, MERGE(options));
        const from = s.runner.calls.length;
        expect({ fixture, flags, ...outcome(await runToken(s, r, rv.workbenchToken)) }).toEqual({ fixture, flags, ...SUCCEEDED });
        const preview = rv.plan.preview as string | null;
        const message = flags.length > 0 ? [] : ["--no-log", "-m", preview!.replace(/\n$/, "")];
        expect(steps(s, from)).toEqual([[L, "merge", "--no-autostash", "--no-edit", ...flags, ...message, "--end-of-options", "refs/heads/topic"]]);
      });
      gitRun(o.h, o.repo, ["merge", "--no-edit", ...flags, "topic"]);
      expect({ fixture, flags, state: shapeState(at(f)) }).toEqual({ fixture, flags, state: shapeState(at(o)) });
    }
    // A repository hook is repository-controlled, so the merge asks once (plan.md D12).
    const f = copy(w, "merge-diverged");
    const o = copy(w, "merge-diverged");
    for (const x of [f, o]) x.h.write(`${x.repo}/.git/hooks/pre-merge-commit`, "#!/bin/sh\nexit 1\n");
    await withWsl(w, "t081-merge-hook", async (s) => {
      const r = await open(s, w, f.repo);
      expect(outcome(await review(s, r, MERGE()))).toEqual({ state: "failed", code: "TRUST_REQUIRED" });
      expect(outcome(await s.approveTrust(r.repositoryId, "merge"))).toEqual(SUCCEEDED);
      expect(confirms(s).length).toBe(1);
      const response = await reviewRun(s, r, MERGE());
      expect({ ...outcome(response), operationState: response.result!.operationState }).toEqual({ ...WITH_EFFECTS, operationState: "merging" });
    });
    gitRun(o.h, o.repo, ["merge", "--no-edit", "topic"], { allowExit: [1] });
    expect(shapeState(at(f))).toEqual(shapeState(at(o)));
  });

  W("Q11 FR-024 to FR-027: rebase with patch-same commits, Autosquash, Autostash, and rebase.updateRefs equals the distro Git's own rebase on a copy; the plan counts equal Git's counts", async (w) => {
    const REBASE = (o: object = {}) => ({ action: "rebase", ref: "refs/heads/up", autostash: false, autosquash: false, ...o });
    const cases: [WbFixtureName, object, string[], ((x: DistroFixture) => void) | null][] = [
      ["rebase-mix", {}, ["--no-autostash", "--no-autosquash"], null],
      ["rebase-fixup", { autosquash: true }, ["--no-autostash", "--autosquash"], null],
      ["rebase-mix", { autostash: true }, ["--autostash", "--no-autosquash"], (x) => x.h.write(`${x.repo}/f.txt`, "f changed\n")],
      ["rebase-update-refs", {}, ["--no-autostash", "--no-autosquash"], null],
    ];
    for (const [fixture, options, flags, prepare] of cases) {
      const f = copy(w, fixture);
      const o = copy(w, fixture);
      prepare?.(f);
      prepare?.(o);
      const up = f.oids.up!;
      const movedBefore = refMap(o.h, o.repo);
      gitRun(o.h, o.repo, ["rebase", ...flags, "--end-of-options", "refs/heads/up"]);
      const created = subjects(at(o), [`${up}..HEAD`]).length;
      const movedAfter = refMap(o.h, o.repo);
      const movedRefs = Object.keys(movedBefore).filter((k) => k.startsWith("refs/heads/") && movedBefore[k] !== movedAfter[k]).sort();
      await withWsl(w, `t081-rebase-${fixture}-${flags.join("")}`, async (s) => {
        const r = await open(s, w, f.repo);
        const rv = await token(s, r, REBASE(options));
        // F13: the moved count equals the commits of Git's own rebase. F16: the moved-branch list leaves out the branch of another worktree.
        if (!("autosquash" in options)) expect({ fixture, moved: rv.plan.moved }).toEqual({ fixture, moved: created });
        if (fixture === "rebase-update-refs") expect(rv.plan.movedBranches).toEqual({ refs: movedRefs, more: 0 });
        const from = s.runner.calls.length;
        expect({ fixture, flags, ...outcome(await runToken(s, r, rv.workbenchToken)) }).toEqual({ fixture, flags, ...SUCCEEDED });
        expect(steps(s, from).filter((a) => a[1] === "rebase")).toEqual([[L, "rebase", ...flags, "--end-of-options", "refs/heads/up"]]);
      });
      expect({ fixture, flags, state: shapeState(at(f)) }).toEqual({ fixture, flags, state: shapeState(at(o)) });
    }
  });

  W("T034 Q9 FR-017 and FR-019: Delete of a branch that another worktree holds names its Linux path; a branch that moved after the review gives STALE_REVIEW before the run, update-ref refuses it during the run, and no ref changes", async (w) => {
    const b = copy(w, "branches");
    const holder = recordLines(out(at(b), ["worktree", "list", "--porcelain", "-z"])).find((lines) => lines.includes("branch refs/heads/wt-held"))!;
    const f = copy(w, "branches");
    const g = copy(w, "branches");
    const DELETE = { action: "delete-branch", ref: "refs/heads/unmerged" };
    await withWsl(w, "t034-delete", async (s) => {
      const rb = await open(s, w, b.repo);
      const held = shapeState(at(b));
      let from = s.runner.calls.length;
      expect(refusalOf(await review(s, rb, { action: "delete-branch", ref: "refs/heads/wt-held" }))).toEqual(unavailable("other-worktree", { worktree: valueOf(holder, "worktree") }));
      expect(steps(s, from)).toEqual([]);
      expect(shapeState(at(b))).toEqual(held);
      const r = await open(s, w, f.repo);
      const rv = await token(s, r, DELETE);
      own(f, ["update-ref", "refs/heads/unmerged", f.oids.tagged!]);
      const moved = shapeState(at(f));
      from = s.runner.calls.length;
      expect(outcome(await runToken(s, r, rv.workbenchToken))).toEqual({ state: "failed", code: "STALE_REVIEW" });
      expect(steps(s, from)).toEqual([]);
      expect(shapeState(at(f))).toEqual(moved);
      const rg = await open(s, w, g.repo);
      const during = await token(s, rg, DELETE);
      const release = s.runner.holdStart((c) => c.arguments[1] === "update-ref");
      from = s.runner.calls.length;
      const requestId = sendRun(s, rg, during.workbenchToken);
      await until(() => s.runner.calls.slice(from).some((c) => c.arguments[1] === "update-ref"), "the held update-ref", RESPONSE_MS);
      own(g, ["update-ref", "refs/heads/unmerged", g.oids.tagged!]);
      const external = shapeState(at(g));
      release();
      const response = await s.response<RunResult>(requestId, RESPONSE_MS);
      // The fresh reads see the external move as an effect, and `update-ref` exited nonzero, so the delete failed.
      expect({ ...outcome(response), refs: response.result!.refs }).toEqual({ ...WITH_EFFECTS, refs: [{ ref: "refs/heads/unmerged" }] });
      expect(s.runner.calls.slice(from).find((c) => c.arguments[1] === "update-ref")!.exit!.exitCode).not.toBe(0);
      expect(steps(s, from).map((a) => a[1])).toEqual(["update-ref"]);
      expect(shapeState(at(g))).toEqual(external);
    });
    expect(out(at(g), ["rev-parse", "--verify", "-q", "refs/heads/unmerged"]).trim()).toBe(g.oids.tagged!);
  });

  W("T034 Q10 FR-022 and SC-005: No fast-forward, Don't commit, both, and Squash of a fast-forward equal the distro Git's own merge with the same options on a copy", async (w) => {
    const MERGE = (o: object) => ({ action: "merge", ref: "refs/heads/topic", result: "merge", noFastForward: false, noCommit: false, message: null, ...o });
    // The T081 Q10 case runs Merge commit and Squash of `merge-diverged` and the fast-forward of `merge-ff`, so these complete the 004 combinations.
    const combinations: [WbFixtureName, object, string[]][] = [
      ["merge-diverged", { noFastForward: true }, ["--no-ff"]],
      ["merge-diverged", { noCommit: true }, ["--no-commit"]],
      ["merge-diverged", { noFastForward: true, noCommit: true }, ["--no-ff", "--no-commit"]],
      ["merge-ff", { noFastForward: true }, ["--no-ff"]],
      ["merge-ff", { noFastForward: true, noCommit: true }, ["--no-ff", "--no-commit"]],
      ["merge-ff", { result: "squash" }, ["--squash"]],
    ];
    for (const [fixture, options, flags] of combinations) {
      const label = `${fixture} ${flags.join(" ")}`;
      const f = copy(w, fixture);
      const o = copy(w, fixture);
      await withWsl(w, `t034-merge-${fixture}-${flags.join("")}`, async (s) => {
        const r = await open(s, w, f.repo);
        const rv = await token(s, r, MERGE(options));
        const from = s.runner.calls.length;
        expect({ label, ...outcome(await runToken(s, r, rv.workbenchToken)) }).toEqual({ label, ...SUCCEEDED });
        const message = flags.includes("--squash") ? [] : ["--no-log", "-m", (rv.plan.preview as string).replace(/\n$/, "")];
        expect({ label, steps: steps(s, from) }).toEqual({ label, steps: [[L, "merge", "--no-autostash", "--no-edit", ...flags, ...message, "--end-of-options", "refs/heads/topic"]] });
      });
      gitRun(o.h, o.repo, ["merge", "--no-edit", ...flags, "topic"]);
      expect({ label, state: shapeState(at(f)) }).toEqual({ label, state: shapeState(at(o)) });
    }
  });

  W("T034 Q11 FR-024: with a bare remote in the owned distro folder, the force note names the ref of the distro Git's own topic@{push}, the held count equals Git's counts, and the rebase equals Git's own rebase on a copy", async (w) => {
    const h = hostOf(w);
    const remote = `${h.root}/q11-origin-${crypto.randomUUID().slice(0, 8)}.git`;
    gitRun(h, h.root, ["init", "-q", "--bare", "--", remote]);
    const f = copy(w, "rebase-mix");
    const o = copy(w, "rebase-mix");
    // The fixture `origin` names a host that no test reaches. Both copies get the same bare remote, so their configuration bytes stay equal.
    for (const x of [f, o]) own(x, ["config", "--local", "remote.origin.url", remote]);
    own(f, ["push", "-q", remote, `${f.oids.empty}:refs/heads/topic`]);
    for (const x of [f, o]) own(x, ["fetch", "-q", "origin"]);
    const up = f.oids.up!;
    const trackingRef = out(at(o), ["rev-parse", "--symbolic-full-name", "topic@{push}"]).trim();
    const rewritten = count(at(o), [`${up}..HEAD`]);
    const held = rewritten - count(at(o), [`${up}..HEAD`, "--not", "--remotes"]);
    await withWsl(w, "t034-force-note", async (s) => {
      const r = await open(s, w, f.repo);
      const rv = await token(s, r, { action: "rebase", ref: "refs/heads/up", autostash: false, autosquash: false });
      expect({ forceNote: rv.plan.forceNote, rewritten: rv.plan.rewritten, held: rv.plan.held }).toEqual({ forceNote: { trackingRef }, rewritten, held });
      expect(outcome(await runToken(s, r, rv.workbenchToken))).toEqual(SUCCEEDED);
    });
    expect({ trackingRef, held: held > 0 }).toEqual({ trackingRef: "refs/remotes/origin/topic", held: true });
    own(o, ["rebase", "--no-autostash", "--no-autosquash", "--end-of-options", "refs/heads/up"]);
    expect(shapeState(at(f))).toEqual(shapeState(at(o)));
  });

  W("Q12 FR-023 and FR-027: a merge and a rebase that stop with conflicts; the 003 Abort, Skip, and Mark resolved with Continue finish them as the distro Git's own commands do", async (w) => {
    const h = hostOf(w);
    let n = 0;
    // The fact (l) history of feature 003: `up` changes `a.txt`, and `main` holds `step a` (`a.txt`) and `step b` (`b.txt`).
    const conflictRepo = (): string => {
      const repo = `${h.root}/q12-${++n}`;
      gitRun(h, h.root, ["init", "-q", "-b", "main", "--", repo]);
      for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"]] as const) gitRun(h, repo, ["config", key, value]);
      importStream(h, repo, [
        fc({ mark: 1, message: "base\n", files: { "a.txt": "base\n" } }),
        fc({ mark: 2, ref: "refs/heads/up", message: "up\n", from: 1, files: { "a.txt": "up\n" } }),
        fc({ mark: 3, message: "step a\n", from: 1, files: { "a.txt": "topic\n" } }),
        fc({ mark: 4, message: "step b\n", from: 3, files: { "b.txt": "topic\n" } }),
      ]);
      gitRun(h, repo, ["reset", "-q", "--hard", "main"]);
      return repo;
    };
    const repoAt = (dir: string): Repo => ({ w, h, dir });
    const copyOf = (repo: string) => {
      const to = `${repo}-oracle`;
      h.copy(repo, to);
      gitRun(h, to, ["update-index", "-q", "--refresh"], { allowExit: ANY_EXIT });
      return to;
    };
    const label = (state: ReturnType<typeof shapeState>) => ({ ...state, files: { ...state.files, "a.txt": "label" } });
    for (const [kind, finish] of [["merge", "abort"], ["merge", "continue"], ["rebase", "abort"], ["rebase", "skip"], ["rebase", "continue"]] as const) {
      const repo = conflictRepo();
      const oracle = copyOf(repo);
      await withWsl(w, `t081-stop-${kind}-${finish}`, async (s) => {
        const r = await open(s, w, repo);
        const payload = kind === "merge" ? { action: "merge", ref: "refs/heads/up", result: "merge", noFastForward: false, noCommit: false, message: null } : { action: "rebase", ref: "refs/heads/up", autostash: false, autosquash: false };
        const stopped = await reviewRun(s, r, payload);
        expect({ kind, ...outcome(stopped), operationState: stopped.result!.operationState, unmerged: stopped.result!.unmerged }).toEqual({ kind, ...WITH_EFFECTS, operationState: kind === "merge" ? "merging" : "rebasing", unmerged: 1 });
        if (kind === "merge") gitRun(h, oracle, ["merge", "--no-edit", "up"], { allowExit: [1] });
        else gitRun(h, oracle, ["rebase", "--no-autostash", "--no-autosquash", "--end-of-options", "refs/heads/up"], { allowExit: [1] });
        // Contract gap of T023: the full-ref merge argv labels the conflict side `refs/heads/up`, where Git's own `git merge up` writes `up`.
        expect({ kind, state: label(shapeState(repoAt(repo))) }).toEqual({ kind, state: label(shapeState(repoAt(oracle))) });
        if (finish === "continue") {
          h.write(`${repo}/a.txt`, "resolved\n");
          h.write(`${oracle}/a.txt`, "resolved\n");
          const c = await compare(s, r.repositoryId, "a.txt", "conflicted");
          const resolved = await request(s, "applyFile", { comparisonId: c.comparisonId, snapshotId: c.read.snapshotId, direction: "resolve" }, { repositoryId: r.repositoryId, repositoryGeneration: c.read.generation });
          expect(outcome(resolved)).toEqual(SUCCEEDED);
          gitRun(h, oracle, ["add", "--", "a.txt"]);
        }
        const read = await readOk(s, r.repositoryId);
        const reviewed = await s.response<{ syncReviewToken?: string }>(s.send("reviewSync", { action: finish }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation }), RESPONSE_MS);
        expect({ kind, finish, ...outcome(reviewed) }).toEqual({ kind, finish, ...SUCCEEDED });
        const done = await s.response(sendSync(s, { ...r, generation: read.generation }, reviewed.result!.syncReviewToken!), RESPONSE_MS);
        expect({ kind, finish, ...outcome(done) }).toEqual({ kind, finish, ...SUCCEEDED });
      });
      if (kind === "merge") gitRun(h, oracle, finish === "abort" ? ["merge", "--abort"] : ["commit", "--quiet"]);
      else gitRun(h, oracle, ["rebase", `--${finish}`], { allowExit: ANY_EXIT });
      expect({ kind, finish, state: shapeState(repoAt(repo)) }).toEqual({ kind, finish, state: shapeState(repoAt(oracle)) });
    }
  });
});
