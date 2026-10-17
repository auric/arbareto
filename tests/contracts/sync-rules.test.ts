// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { decidePull, decidePushDestination, invalidRemoteValue, parsePushRecord, upstreamRebase, type PullDecision, type PushDecision, type PushDestination, type PushRecord } from "../../src/git-service/sync-parsers";
import { urlHelper } from "../../src/git-service/trust";
import { RECORDED } from "./sync-recorded";

printOrigin("../../src/git-service/sync-parsers.ts", import.meta.dir);
printOrigin("../../src/git-service/trust.ts", import.meta.dir);

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
  const noUpstream = { upstream: "", upstreamRemote: "", upstreamRemoteRef: "" };
  const branchDest: Extract<PushDecision, { kind: "destination" }> = { kind: "destination", destination: { remote: "origin", ref: "refs/heads/topic", trackingRef: "refs/remotes/origin/topic", source: "push-default-branch" } };

  test("simple, unset, and current give refs/heads/<branch>", () => {
    expect(decide({})).toEqual(branchDest);
    for (const value of ["simple", "current"]) expect(decide({}, [["push.default", value]])).toEqual(branchDest);
  });

  test("matching always gives the panel (R16 d)", () => {
    expect(decide({}, [["push.default", "matching"]])).toEqual({ kind: "panel", prefill: null });
    expect(decide(noUpstream, [["push.default", "matching"]])).toEqual({ kind: "panel", prefill: null });
  });

  test("current with no upstream and no explicit remote pre-fills refs/heads/<branch> on origin (R16 d)", () => {
    expect(decide({ ...noUpstream, pushRemote: "" }, [["push.default", "current"]])).toEqual({ kind: "panel", prefill: branchDest.destination });
    expect(decide({ ...noUpstream, pushRemote: "", push: "" }, [["push.default", "current"]])).toEqual({ kind: "panel", prefill: { ...branchDest.destination, trackingRef: null } });
  });

  test("an empty %(push:remotename) and no origin gives the panel", () => {
    expect(decide({ ...noUpstream, pushRemote: "" }, [["push.default", "current"]], ["fork"])).toEqual({ kind: "panel", prefill: null });
  });

  test("simple or unset with a push remote other than the fetch remote is triangular (R16 d)", () => {
    const triangular: PushDestination = { remote: "fork", ref: "refs/heads/topic", trackingRef: null, source: "push-default-triangular" };
    const over = { pushRemote: "fork", push: "" };
    expect(decide(over)).toEqual({ kind: "destination", destination: triangular });
    expect(decide(over, [["push.default", "simple"]])).toEqual({ kind: "destination", destination: triangular });
    expect(decide(over, [["branch.topic.remote", "origin"]])).toEqual({ kind: "destination", destination: triangular });
    expect(decide({ ...over, push: "refs/remotes/fork/topic" })).toEqual({ kind: "destination", destination: triangular });
    expect(decide({ ...noUpstream, ...over })).toEqual({ kind: "panel", prefill: triangular });
  });

  test("the fetch remote is the last branch.<name>.remote value, else origin", () => {
    const over = { pushRemote: "fork", push: "refs/remotes/fork/topic" };
    expect(decide(over, [["branch.topic.remote", "fork"]])).toEqual({ kind: "destination", destination: { remote: "fork", ref: "refs/heads/topic", trackingRef: "refs/remotes/fork/topic", source: "push-default-branch" } });
    expect(decide(over, [["branch.topic.remote", "origin"], ["branch.topic.remote", "fork"]])).toMatchObject({ destination: { source: "push-default-branch" } });
    expect(decide(over, [["branch.topic.remote", "fork"], ["branch.topic.remote", "origin"]])).toMatchObject({ destination: { source: "push-default-triangular" } });
    expect(decide(over, [["branch.other.remote", "fork"]])).toMatchObject({ destination: { source: "push-default-triangular" } });
    expect(decide(over, [["branch.topic.remote", null]])).toEqual({ kind: "refused", reason: "invalid-config" });
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

  // builtin/push.c `get_upstream_ref`: "has multiple upstream branches, refusing to push" with exit 128 (Git 2.56.0.windows.2).
  test("several branch.<name>.merge values give several-merge-refs under simple and upstream", () => {
    const merges: Config = [["branch.topic.merge", "refs/heads/topic"], ["branch.topic.merge", "refs/heads/other"]];
    const several: PushDecision = { kind: "refused", reason: "several-merge-refs" };
    expect(decide({}, merges)).toEqual(several);
    for (const value of ["simple", "upstream", "tracking"]) expect(decide({}, [...merges, ["push.default", value]])).toEqual(several);
    expect(decide({}, [["branch.topic.merge", "refs/heads/topic"], ["branch.other.merge", "refs/heads/other"]])).toEqual(branchDest);
    // `current` and a triangular `simple` push read no upstream.
    expect(decide({}, [...merges, ["push.default", "current"]])).toEqual(branchDest);
    expect(decide({ pushRemote: "fork", push: "" }, merges)).toMatchObject({ destination: { source: "push-default-triangular" } });
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

  test("an empty %(push:remotename) takes origin", () => {
    expect(decide({ pushRemote: "" })).toEqual(branchDest);
    expect(decide({ pushRemote: "", push: "" })).toEqual({ kind: "panel", prefill: null });
  });

  test("simple with the fetch remote and an empty %(push) gives the panel", () => {
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

  // Research R16 m: remote.c `handle_config` reads each `remote.<name>.mirror` entry with `git_config_bool`, which dies on a bad value.
  test("an invalid mirror value of any remote gives invalid-config, also without an upstream", () => {
    const invalid: PushDecision = { kind: "refused", reason: "invalid-config" };
    expect(decide({}, [["remote.fork.mirror", "maybe"]])).toEqual(invalid);
    expect(decide(noUpstream, [["remote.fork.mirror", "maybe"]])).toEqual(invalid);
    expect(decide({}, [["remote.gone.mirror", "2x"]])).toEqual(invalid);
    expect(decide({}, [["remote.a.b.mirror", "maybe"]])).toEqual(invalid);
    expect(decide({}, [["remote..mirror", "maybe"]])).toEqual(invalid);
    expect(decide({}, [["remote.fork.mirror", "maybe"], ["remote.fork.mirror", "false"]])).toEqual(invalid);
    // remote.c skips a remote name that starts with "/", and `remote.mirror` names no remote.
    expect(decide({}, [["remote./x.mirror", "maybe"], ["remote.mirror", "maybe"], ["remote.fork.mirrors", "maybe"], ["branch.fork.mirror", "maybe"]])).toEqual(branchDest);
  });

  // T005 (d) observed these destinations from `push --dry-run --porcelain` on the same fixture variants.
  test("recorded records give the destination of Git's own push", () => {
    const remotes = ["origin", "second"];
    const recorded = (key: string, branch: string, config: Config) => {
      const r = parsePushRecord(new TextEncoder().encode(RECORDED[`push-record.${key}`]!.stdout), branch, "sha1");
      if (r === null || r === "absent") throw new Error(`recorded ${key} refused`);
      return decidePushDestination(r, remotes, cfg(config));
    };
    const at = (remote: string, ref: string, trackingRef: string | null, source: PushDestination["source"]): PushDestination => ({ remote, ref, trackingRef, source });
    expect(recorded("push.default=unset/topic", "topic", [["branch.topic.remote", "origin"]])).toEqual({ kind: "destination", destination: at("origin", "refs/heads/topic", "refs/remotes/origin/topic", "push-default-branch") });
    expect(recorded("push.default=current/noup", "noup", [["push.default", "current"]])).toEqual({ kind: "panel", prefill: at("origin", "refs/heads/noup", "refs/remotes/origin/noup", "push-default-branch") });
    expect(recorded("remote.origin.push/renamed", "renamed", [["branch.renamed.remote", "origin"], ["remote.origin.push", "refs/heads/renamed:refs/heads/mapped"]])).toEqual({ kind: "destination", destination: at("origin", "refs/heads/mapped", "refs/remotes/origin/mapped", "remote-push-refspec") });
    expect(recorded("branch.pushRemote/topic", "topic", [["branch.topic.remote", "origin"], ["branch.topic.pushremote", "second"]])).toEqual({ kind: "destination", destination: at("second", "refs/heads/topic", null, "push-default-triangular") });
    expect(recorded("push.default=upstream/renamed", "renamed", [["branch.renamed.remote", "origin"], ["push.default", "upstream"]])).toEqual({ kind: "destination", destination: at("origin", "refs/heads/other-name", "refs/remotes/origin/other-name", "push-default-upstream") });
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

  test("only behind with pull.ff true or only fast-forwards", () => {
    expect(pull(0, 2, [["pull.ff", "true"]])).toEqual({ kind: "fast-forward", source: "pull-ff" });
    expect(pull(0, 2, [["pull.ff", "only"], ["pull.rebase", "true"]])).toEqual({ kind: "fast-forward", source: "pull-ff" });
    expect(pull(0, 2, [["pull.ff", "only"]], "merge")).toEqual({ kind: "fast-forward", source: "payload" });
  });

  test("only behind with no pull.ff and no rebase merges with no option, so merge.ff applies (R16 e)", () => {
    expect(pull(0, 2)).toEqual({ kind: "merge", ff: null, source: null });
    expect(pull(0, 2, [["pull.rebase", "false"]])).toEqual({ kind: "merge", ff: null, source: "pull" });
    expect(pull(0, 2, [], "merge")).toEqual({ kind: "merge", ff: null, source: "payload" });
    expect(pull(0, 2, [["merge.ff", "false"]])).toEqual({ kind: "merge", ff: null, source: null });
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
    expect(pull(0, 1, [["branch.main.merge", "refs/heads/a"]])).toEqual({ kind: "merge", ff: null, source: null });
  });
});

// Contract Δ3 `reviewSync` and research R16 m: remote.c `handle_config` reads five `remote.<name>` keys with `git_config_bool`.
// Git reads every entry, so an invalid value refuses also when a later entry is valid.
describe("the remote value check of every review", () => {
  const check = (config: Config) => invalidRemoteValue(cfg(config));
  const KEYS = ["mirror", "skipfetchall", "skipdefaultupdate", "prune", "prunetags"];

  test("an invalid value of any of the five keys on any remote refuses", () => {
    for (const key of KEYS) {
      expect(check([[`remote.fork.${key}`, "maybe"]])).toBe(true);
      expect(check([[`remote.a.b.${key}`, "2x"]])).toBe(true);
      expect(check([[`remote..${key}`, "maybe"]])).toBe(true);
      expect(check([[`remote.fork.${key}`, "maybe"], [`remote.fork.${key}`, "false"]])).toBe(true);
    }
  });

  test("a parseMaybeBool value passes", () => {
    for (const key of KEYS) for (const value of ["true", "false", "yes", "off", "", "0", "2", "1k", null]) expect(check([[`remote.origin.${key}`, value]])).toBe(false);
    expect(check([])).toBe(false);
  });

  test("a name that starts with '/', a key without a remote name, and other keys pass", () => {
    for (const key of KEYS) {
      expect(check([[`remote./x.${key}`, "maybe"]])).toBe(false);
      expect(check([[`remote.${key}`, "maybe"]])).toBe(false);
      expect(check([[`branch.fork.${key}`, "maybe"]])).toBe(false);
      expect(check([[`remote.fork.${key}s`, "maybe"]])).toBe(false);
    }
    expect(check([["remote.fork.url", "maybe"], ["remote.fork.tagopt", "maybe"], ["fetch.prune", "maybe"]])).toBe(false);
  });

  // remote.c `handle_config` stops on these keys without `=`: exit 128, or 139 for `tagopt` and `followremotehead`.
  const STRING_KEYS = [
    "branch.main.remote", "branch.main.pushremote", "branch.main.merge", "branch.a.b.merge", "url.https://x/.insteadof", "url.https://x/.pushinsteadof", "remote.pushdefault",
    ...["url", "pushurl", "push", "fetch", "receivepack", "uploadpack", "tagopt", "proxy", "proxyauthmethod", "vcs", "serveroption", "negotiationrestrict", "negotiationinclude", "followremotehead"].map((k) => `remote.fork.${k}`),
  ];

  test("a string key without a value refuses", () => {
    for (const key of STRING_KEYS) {
      expect(check([[key, null]])).toBe(true);
      expect(check([[key, null], [key, "x"]])).toBe(true);
      expect(check([[key, ""]])).toBe(false);
      expect(check([[key, "x"]])).toBe(false);
    }
  });

  // Recorded on 2.56.0.windows.2: `[branch ""]` made `git remote` and `%(upstream)` exit 128 for `remote` and for an unknown variable. `[remote ""]` did not.
  test("an empty branch subsection refuses for every variable and value", () => {
    for (const [key, value] of [["branch..remote", "o"], ["branch..foo", "x"], ["branch..merge", null]] as const) expect(check([[key, value]])).toBe(true);
    expect(check([["remote..url", "x"], ["remote..foo", "x"]])).toBe(false);
  });

  test("a valueless key that Git reads without a value check, or skips, passes", () => {
    const skipped = ["remote./x.url", "remote.url", "branch.remote", "url.insteadof", "branch.main.rebase", "remote.fork.mirror", "pushremote", "remote.fork.pushremote", "branch.main.pushdefault", "core.sshcommand"];
    for (const key of skipped) expect(check([[key, null]])).toBe(false);
  });

  test("the D4 rule refuses on a valueless string key of another branch", () => {
    const record: PushRecord = { branch: "topic", upstream: "refs/remotes/origin/topic", upstreamRemote: "origin", upstreamRemoteRef: "refs/heads/topic", push: "refs/remotes/origin/topic", pushRemote: "origin", pushRemoteRef: "" };
    expect(decidePushDestination(record, ["origin"], cfg([["branch.main.pushremote", null]]))).toEqual({ kind: "refused", reason: "invalid-config" });
  });

  test("the D4 rule refuses on each of the five keys", () => {
    const record: PushRecord = { branch: "topic", upstream: "", upstreamRemote: "", upstreamRemoteRef: "", push: "", pushRemote: "origin", pushRemoteRef: "" };
    for (const key of KEYS) expect(decidePushDestination(record, ["origin", "fork"], cfg([[`remote.fork.${key}`, "maybe"]]))).toEqual({ kind: "refused", reason: "invalid-config" });
  });
});

// Contract Δ3 Set upstream. Recorded on 2.56.0.windows.2 with `push --set-upstream`: `remote` and `always` wrote `branch.<name>.rebase true`,
// `never` and `local` wrote none, and `bogus`, `Always`, or a key without a value made `rev-parse --git-path hooks` exit 128.
describe("branch.autoSetupRebase for a remote upstream", () => {
  const rebase = (config: Config) => upstreamRebase(cfg(config));

  test("remote and always add the rebase value; never, local, and unset do not", () => {
    expect([rebase([]), ...["never", "local", "remote", "always"].map((v) => rebase([["branch.autosetuprebase", v]]))]).toEqual([false, false, false, true, true]);
  });

  test("the last entry wins", () => {
    expect(rebase([["branch.autosetuprebase", "always"], ["branch.autosetuprebase", "never"]])).toBe(false);
    expect(rebase([["branch.autosetuprebase", "never"], ["branch.autosetuprebase", "remote"]])).toBe(true);
  });

  test("an entry that Git refuses gives null, also before a valid one", () => {
    for (const value of ["bogus", "Always", "", null]) expect(rebase([["branch.autosetuprebase", value]])).toBeNull();
    expect(rebase([["branch.autosetuprebase", "bogus"], ["branch.autosetuprebase", "always"]])).toBeNull();
  });

  test("other keys do not count", () => {
    expect(rebase([["branch.main.autosetuprebase", "always"], ["branch.autosetupmerge", "always"]])).toBe(false);
  });
});

// Plan.md D11 remote helpers. Recorded on 2.56.0.windows.2 with `GIT_TRACE` and `ls-remote`: `foo://x/y` and `foo::x` ran `git remote-foo`;
// `http`, `https`, `ftp`, and `ftps` ran Git's own curl helpers; the ssh forms, `git://`, `file://`, `host:path`, and `C:/path` ran no helper.
describe("remote helper URLs (transport.c `transport_get`)", () => {
  test("a <name>:: prefix and an unknown <scheme>:// select a helper", () => {
    const cases: [string, string | null][] = [
      ["foo://x/y", "foo"],
      ["foo::x", "foo"],
      ["a.b-c+d://x", "a.b-c+d"],
      ["::x", ""],
      ["rsync::x", "rsync"],
      ["ext::sh -c true", "ext"],
      // starts_with and the Makefile helper names compare case-sensitively.
      ["HTTPS://x", "HTTPS"],
      // A DOS drive path can name a bundle file, which the service does not read.
      ["C://x", "C"],
    ];
    for (const [url, helper] of cases) expect({ url, helper: urlHelper(url) }).toEqual({ url, helper });
  });

  test("Git's own transports and its curl helpers select none", () => {
    for (const url of ["https://h/x", "http://h/x", "ftp://h/x", "ftps://h/x", "ssh://h/x", "git+ssh://h/x", "ssh+git://h/x", "git://h/x", "file:///C:/x", "host:path/x", "C:/path", "/srv/x.git", "rsync://h/x", "-x://h", ""]) {
      expect({ url, helper: urlHelper(url) }).toEqual({ url, helper: null });
    }
  });
});
