// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { decidePull, decidePushDestination, type PullDecision, type PushDecision, type PushRecord } from "../../src/git-service/sync-parsers";

printOrigin("../../src/git-service/sync-parsers.ts", import.meta.dir);

// Plan.md D4 and D6, data-model §3 and §6 (T016).

type Config = [string, string | null][];
const cfg = (entries: Config) => entries.map(([key, value]) => ({ key, value }));

describe("D4 push destination", () => {
  // A branch `topic` that tracks `origin/topic`, as `for-each-ref` prints it under `push.default=simple`.
  const record = (over: Partial<PushRecord> = {}): PushRecord => ({
    branch: "topic",
    upstream: "refs/remotes/origin/topic",
    upstreamRemote: "origin",
    upstreamRemoteRef: "refs/heads/topic",
    push: "refs/remotes/origin/topic",
    pushRemote: "origin",
    pushRemoteRef: "",
    ...over,
  });
  const REMOTES = ["origin", "fork"];
  const decide = (over: Partial<PushRecord>, config: Config = [], remotes = REMOTES) => decidePushDestination(record(over), remotes, cfg(config));
  const branchDest: Extract<PushDecision, { kind: "destination" }> = { kind: "destination", destination: { remote: "origin", ref: "refs/heads/topic", trackingRef: "refs/remotes/origin/topic", source: "push-default-branch" } };

  test("simple, unset, current, and matching give refs/heads/<branch>", () => {
    expect(decide({})).toEqual(branchDest);
    for (const value of ["simple", "current", "matching"]) expect(decide({}, [["push.default", value]])).toEqual(branchDest);
  });

  test("upstream and tracking give %(upstream:remoteref)", () => {
    const over = { upstream: "refs/remotes/origin/trunk", upstreamRemoteRef: "refs/heads/trunk", push: "refs/remotes/origin/trunk" };
    for (const value of ["upstream", "tracking"]) {
      expect(decide(over, [["push.default", value]])).toEqual({
        kind: "destination",
        destination: { remote: "origin", ref: "refs/heads/trunk", trackingRef: "refs/remotes/origin/trunk", source: "push-default-upstream" },
      });
    }
  });

  test("upstream needs %(upstream:remotename) = R", () => {
    expect(decide({ pushRemote: "fork", push: "refs/remotes/fork/topic" }, [["push.default", "upstream"]])).toEqual({ kind: "refused", reason: "push-remote-differs" });
    expect(decide({ upstreamRemote: ".", upstream: "refs/heads/main" }, [["push.default", "tracking"]])).toEqual({ kind: "refused", reason: "push-remote-differs" });
  });

  test("nothing and other values give invalid-config", () => {
    for (const value of ["nothing", "Simple", "", "bogus"]) expect(decide({}, [["push.default", value]])).toEqual({ kind: "refused", reason: "invalid-config" });
    expect(decide({}, [["push.default", null]])).toEqual({ kind: "refused", reason: "invalid-config" });
  });

  test("the last push.default value wins", () => {
    expect(decide({}, [["push.default", "nothing"], ["push.default", "current"]])).toEqual(branchDest);
    expect(decide({}, [["push.default", "current"], ["push.default", "nothing"]])).toEqual({ kind: "refused", reason: "invalid-config" });
  });

  test("a filled %(push:remoteref) gives remote-push-refspec", () => {
    expect(decide({ pushRemoteRef: "refs/heads/review/topic", push: "refs/remotes/origin/review/topic" }, [["push.default", "nothing"]])).toEqual({
      kind: "destination",
      destination: { remote: "origin", ref: "refs/heads/review/topic", trackingRef: "refs/remotes/origin/review/topic", source: "remote-push-refspec" },
    });
  });

  test("an empty %(push:remotename) gives the panel", () => {
    expect(decide({ pushRemote: "", push: "" })).toEqual({ kind: "panel", prefill: null });
  });

  test("an empty %(push) gives the panel", () => {
    expect(decide({ push: "" })).toEqual({ kind: "panel", prefill: null });
  });

  test("a remote not in git remote gives remote-missing", () => {
    expect(decide({ pushRemote: "gone" })).toEqual({ kind: "refused", reason: "remote-missing" });
    expect(decide({}, [], ["fork"])).toEqual({ kind: "refused", reason: "remote-missing" });
  });

  test("a mirror remote gives mirror", () => {
    expect(decide({}, [["remote.origin.mirror", "true"]])).toEqual({ kind: "refused", reason: "mirror" });
    expect(decide({}, [["remote.origin.mirror", null]])).toEqual({ kind: "refused", reason: "mirror" });
    expect(decide({}, [["remote.origin.mirror", "true"], ["remote.origin.mirror", "false"]])).toEqual(branchDest);
    expect(decide({}, [["remote.fork.mirror", "true"]])).toEqual(branchDest);
    expect(decide({}, [["remote.origin.mirror", "maybe"]])).toEqual({ kind: "refused", reason: "invalid-config" });
  });

  test("an empty %(upstream) gives the panel, pre-filled with the destination", () => {
    expect(decide({ upstream: "", upstreamRemote: "", upstreamRemoteRef: "" }, [["push.default", "current"]])).toEqual({ kind: "panel", prefill: branchDest.destination });
    expect(decide({ upstream: "", upstreamRemote: "", upstreamRemoteRef: "", push: "", pushRemote: "" })).toEqual({ kind: "panel", prefill: null });
    expect(decide({ upstream: "", upstreamRemote: "", upstreamRemoteRef: "" }, [["push.default", "nothing"]])).toEqual({ kind: "panel", prefill: null });
  });
});

describe("D6 pull decision", () => {
  const pull = (ahead: number, behind: number, config: Config = [], mode: "rebase" | "merge" | null = null): PullDecision =>
    decidePull({ ahead, behind, branch: "main", mode, config: cfg(config) });
  const refused = (reason: Extract<PullDecision, { kind: "refused" }>["reason"]): PullDecision => ({ kind: "refused", reason });

  test("behind 0 is up to date, whatever the values", () => {
    expect(pull(0, 0)).toEqual({ kind: "up-to-date" });
    expect(pull(5, 0, [["pull.ff", "only"]])).toEqual({ kind: "up-to-date" });
    expect(pull(5, 0, [["pull.rebase", "interactive"]], "rebase")).toEqual({ kind: "up-to-date" });
  });

  test("only behind with pull.ff=false and a rebase value fast-forwards", () => {
    expect(pull(0, 2, [["pull.ff", "false"], ["pull.rebase", "true"]])).toEqual({ kind: "fast-forward", source: "pull" });
    expect(pull(0, 2, [["pull.ff", "false"], ["branch.main.rebase", "merges"]])).toEqual({ kind: "fast-forward", source: "branch" });
    expect(pull(0, 2, [["pull.ff", "false"], ["pull.rebase", "interactive"]])).toEqual({ kind: "fast-forward", source: "pull" });
    expect(pull(0, 2, [["pull.ff", "false"]], "rebase")).toEqual({ kind: "fast-forward", source: "payload" });
  });

  test("only behind with pull.ff=false and no rebase makes a merge commit (FR-027, O-2)", () => {
    expect(pull(0, 2, [["pull.ff", "false"]])).toEqual({ kind: "merge", ff: "--no-ff", source: "pull-ff" });
    expect(pull(0, 2, [["pull.ff", "false"], ["pull.rebase", "false"]])).toEqual({ kind: "merge", ff: "--no-ff", source: "pull" });
    expect(pull(0, 2, [["pull.ff", "false"], ["pull.rebase", "true"]], "merge")).toEqual({ kind: "merge", ff: "--no-ff", source: "payload" });
  });

  test("only behind with pull.ff other than false fast-forwards", () => {
    expect(pull(0, 2)).toEqual({ kind: "fast-forward", source: null });
    expect(pull(0, 2, [["pull.ff", "true"]])).toEqual({ kind: "fast-forward", source: "pull-ff" });
    expect(pull(0, 2, [["pull.ff", "only"], ["pull.rebase", "true"]])).toEqual({ kind: "fast-forward", source: "pull-ff" });
    expect(pull(0, 2, [["pull.rebase", "false"]])).toEqual({ kind: "fast-forward", source: "pull" });
    expect(pull(0, 2, [], "merge")).toEqual({ kind: "fast-forward", source: "payload" });
  });

  test("pull.ff=only and diverged with no payload refuses ff-only, also with pull.rebase=true", () => {
    expect(pull(1, 1, [["pull.ff", "only"]])).toEqual(refused("ff-only"));
    expect(pull(1, 1, [["pull.ff", "only"], ["pull.rebase", "true"]])).toEqual(refused("ff-only"));
    expect(pull(1, 1, [["pull.ff", "only"], ["branch.main.rebase", "interactive"]])).toEqual(refused("ff-only"));
  });

  test("pull.ff=only and diverged with a payload runs that mode, with --ff for a merge", () => {
    expect(pull(1, 1, [["pull.ff", "only"]], "rebase")).toEqual({ kind: "rebase", rebaseMerges: false, source: "payload" });
    expect(pull(1, 1, [["pull.ff", "only"]], "merge")).toEqual({ kind: "merge", ff: "--ff", source: "payload" });
  });

  test("diverged with no mode gives mode-required", () => {
    expect(pull(1, 1)).toEqual({ kind: "mode-required" });
  });

  test("diverged with a rebase value rebases", () => {
    expect(pull(1, 1, [["pull.rebase", "true"]])).toEqual({ kind: "rebase", rebaseMerges: false, source: "pull" });
    expect(pull(1, 1, [["pull.rebase", null]])).toEqual({ kind: "rebase", rebaseMerges: false, source: "pull" });
    expect(pull(1, 1, [["pull.rebase", "merges"]])).toEqual({ kind: "rebase", rebaseMerges: true, source: "pull" });
    expect(pull(1, 1, [["pull.rebase", "m"]])).toEqual({ kind: "rebase", rebaseMerges: true, source: "pull" });
    expect(pull(1, 1, [["pull.ff", "false"], ["branch.main.rebase", "yes"]])).toEqual({ kind: "rebase", rebaseMerges: false, source: "branch" });
    expect(pull(1, 1, [], "rebase")).toEqual({ kind: "rebase", rebaseMerges: false, source: "payload" });
  });

  test("interactive gives interactive-rebase when diverged", () => {
    expect(pull(1, 1, [["pull.rebase", "interactive"]])).toEqual(refused("interactive-rebase"));
    expect(pull(1, 1, [["branch.main.rebase", "i"]])).toEqual(refused("interactive-rebase"));
  });

  test("diverged with pull.ff=true or false and no rebase value merges", () => {
    expect(pull(3, 4, [["pull.ff", "true"]])).toEqual({ kind: "merge", ff: "--ff", source: "pull-ff" });
    expect(pull(3, 4, [["pull.ff", null]])).toEqual({ kind: "merge", ff: "--ff", source: "pull-ff" });
    expect(pull(3, 4, [["pull.ff", "false"]])).toEqual({ kind: "merge", ff: "--no-ff", source: "pull-ff" });
  });

  test("diverged with rebase false or payload merge merges with the pull.ff option", () => {
    expect(pull(3, 4, [["pull.rebase", "false"]])).toEqual({ kind: "merge", ff: null, source: "pull" });
    expect(pull(3, 4, [["pull.ff", "true"], ["pull.rebase", "false"]])).toEqual({ kind: "merge", ff: "--ff", source: "pull" });
    expect(pull(3, 4, [["pull.ff", "false"]], "merge")).toEqual({ kind: "merge", ff: "--no-ff", source: "payload" });
    expect(pull(3, 4, [], "merge")).toEqual({ kind: "merge", ff: null, source: "payload" });
  });

  test("the payload wins over branch.<name>.rebase, which wins over pull.rebase", () => {
    const both: Config = [["branch.main.rebase", "false"], ["pull.rebase", "merges"]];
    expect(pull(1, 1, both)).toEqual({ kind: "merge", ff: null, source: "branch" });
    expect(pull(1, 1, both, "rebase")).toEqual({ kind: "rebase", rebaseMerges: false, source: "payload" });
    expect(pull(1, 1, [["branch.other.rebase", "false"], ["pull.rebase", "merges"]])).toEqual({ kind: "rebase", rebaseMerges: true, source: "pull" });
    expect(pull(1, 1, [["branch.Main.rebase", "false"], ["pull.rebase", "true"]])).toEqual({ kind: "rebase", rebaseMerges: false, source: "pull" });
  });

  test("the last value wins", () => {
    expect(pull(1, 1, [["pull.rebase", "true"], ["pull.rebase", "false"]])).toEqual({ kind: "merge", ff: null, source: "pull" });
    expect(pull(1, 1, [["pull.ff", "only"], ["pull.ff", "true"]])).toEqual({ kind: "merge", ff: "--ff", source: "pull-ff" });
  });

  test("an invalid value gives invalid-config", () => {
    expect(pull(1, 1, [["pull.ff", "Only"]])).toEqual(refused("invalid-config"));
    expect(pull(1, 1, [["pull.ff", "maybe"]], "merge")).toEqual(refused("invalid-config"));
    expect(pull(1, 1, [["pull.rebase", "preserve"]])).toEqual(refused("invalid-config"));
    expect(pull(0, 0, [["branch.main.rebase", "Merges"]])).toEqual(refused("invalid-config"));
    expect(pull(1, 1, [["branch.main.rebase", "bogus"], ["pull.rebase", "true"]])).toEqual(refused("invalid-config"));
  });

  test("a payload mode reads no rebase value", () => {
    expect(pull(1, 1, [["branch.main.rebase", "bogus"]], "merge")).toEqual({ kind: "merge", ff: null, source: "payload" });
  });

  test("several branch.<name>.merge values give several-merge-refs", () => {
    expect(pull(0, 1, [["branch.main.merge", "refs/heads/a"], ["branch.main.merge", "refs/heads/b"]])).toEqual(refused("several-merge-refs"));
    expect(pull(0, 1, [["branch.main.merge", "refs/heads/a"]])).toEqual({ kind: "fast-forward", source: null });
  });
});
