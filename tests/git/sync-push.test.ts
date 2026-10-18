// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T034: `reviewSync` and `sync` with `push` (contract Δ3, data-model §3 and §5, plan.md D4, O-11, FR-006, FR-014 to FR-018, FR-038, SC-001, SC-006, SC-010).
// The oracles are Git's own `push --dry-run --porcelain` and Git's own push on a copy with its own copy of the remote.

import { expect } from "bun:test";
import { rmSync } from "node:fs";
import { SUBMODULE_UPDATE_CEILING_MS, SUBMODULE_UPDATE_INACTIVITY_MS, STALL_NOTICE_MS } from "../../src/contracts/limits";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { commit, psQuote, reviewOk } from "./hunk-harness";
import { buildCounts, buildPush, configDigests, ESC_MESSAGE, fc, gitRun, importStream, PUSH_VARIANTS, pushVariant, refMap, revParse, setConfig, type GitHost, type PushFixture } from "./remote-fixtures";
import { caseTest } from "./service-harness";
import { copyWithRemotes, gitExe, hostFor, localConfig, native, register, remoteCalls, reviewed, reviewSync, run, sendSync, subcommandOf, sync, TIMEOUT_MS, withSync, type SyncResult, refusalOf } from "./sync-harness";

useFixtureRoot();

const TASK = "T034";
const SHELL = ["shell-double"] as const;
const NETWORK_LIMITS = { inactivityMs: SUBMODULE_UPDATE_INACTIVITY_MS, ceilingMs: SUBMODULE_UPDATE_CEILING_MS, stallMs: STALL_NOTICE_MS };
const PUSH = (remote: string, refspec: string, extra: string[] = []) => ["--no-lazy-fetch", "push", "--porcelain", "--progress", "--no-recurse-submodules", "--no-follow-tags", ...extra, "--", remote, refspec];
// The values of transport.c `set_upstreams` for `push --set-upstream`.
const UPSTREAM = (branch: string, remote: string, dst: string) => [
  ["--no-lazy-fetch", "config", "--local", "--", `branch.${branch}.remote`, remote],
  ["--no-lazy-fetch", "config", "--local", "--", `branch.${branch}.merge`, dst],
];
const isPush = (call: { arguments: readonly string[] }) => subcommandOf(call.arguments) === "push";
const outcome = (r: { state: string; code?: string }) => ({ state: r.state, code: r.code });
const SUCCEEDED = { state: "succeeded", code: undefined };

type Expected =
  | { kind: "destination"; remote: string; ref: string; source: string }
  | { kind: "panel"; prefill: { remote: string; ref: string } | null; setUpstream: boolean }
  | { kind: "refused"; reason: string }
  | { kind: "failed"; code: string };

// Plan.md D4 for each T002 variant. `bogus` breaks every Git read of HEAD (config.c `git_default_push_config`), so the review fails before D4,
// and the 001 re-read of a failed read gives REPOSITORY_UNAVAILABLE.
function expectedOf(name: string): Expected {
  const [setting, branch] = name.split("/") as [string, "topic" | "renamed" | "noup"];
  const d = (remote: string, ref: string, source: string): Expected => ({ kind: "destination", remote, ref, source });
  const panel = (prefill: { remote: string; ref: string } | null = null): Expected => ({ kind: "panel", prefill, setUpstream: branch === "noup" });
  const value = setting.startsWith("push.default=") ? setting.slice("push.default=".length) : null;
  if (value === "bogus") return { kind: "failed", code: "REPOSITORY_UNAVAILABLE" };
  if (value === "simple" || value === "unset") return branch === "topic" ? d("origin", "refs/heads/topic", "push-default-branch") : panel();
  if (value === "current") return branch === "noup" ? panel({ remote: "origin", ref: "refs/heads/noup" }) : d("origin", `refs/heads/${branch}`, "push-default-branch");
  if (value === "matching") return panel();
  if (value === "upstream" || value === "tracking") return branch === "noup" ? panel() : d("origin", branch === "topic" ? "refs/heads/topic" : "refs/heads/other-name", "push-default-upstream");
  if (value === "nothing") return branch === "noup" ? panel() : { kind: "refused", reason: "invalid-config" };
  if (setting === "remote.origin.push") return d("origin", "refs/heads/mapped", "remote-push-refspec");
  if (setting === "branch.pushRemote" || setting === "remote.pushDefault") return d("second", "refs/heads/topic", "push-default-triangular");
  if (setting === "two-push-urls") return { kind: "refused", reason: "push-urls" };
  if (setting === "mirror") return { kind: "refused", reason: "mirror" };
  if (setting === "unconfigured-push-remote") return { kind: "refused", reason: "remote-missing" };
  throw new Error(`no expectation for ${name}`);
}

// Git's own destination: the porcelain line of the branch and the `To` URL of `push --dry-run`.
function gitDryRun(h: GitHost, repo: string, branch: string): { to: string; url: string } | null {
  const out = gitRun(h, repo, ["push", "--dry-run", "--porcelain", "--no-recurse-submodules", "--no-follow-tags"], { allowExit: [0, 1, 128] }).stdout.toString("utf8");
  const lines = out.split("\n");
  const line = lines.map((l) => l.split("\t")).find((f) => f.length === 3 && f[1]!.startsWith(`refs/heads/${branch}:`));
  const url = lines.find((l) => l.startsWith("To "))?.slice(3);
  return line === undefined || url === undefined ? null : { to: line[1]!.slice(`refs/heads/${branch}:`.length), url };
}

const urlOf = (f: PushFixture, remote: string) => (remote === "origin" ? f.origin : f.second);

describeGit("sync push (T034)", () => {
  let fixture: { h: GitHost; f: PushFixture } | null = null;
  const pushFixture = () => {
    if (fixture === null) {
      const h = hostFor("t034-push");
      fixture = { h, f: buildPush(h) };
    }
    return fixture;
  };
  let copies = 0;
  // A copy of the push clone with its own copies of both remotes, on `branch`.
  const own = (branch: string, config: [string, string][] = []) => {
    const { h, f } = pushFixture();
    const copy = copyWithRemotes(h, f.clone, { origin: f.origin, second: f.second }, `own-${++copies}`);
    gitRun(h, copy.repo, ["checkout", "-q", branch]);
    for (const [k, v] of config) gitRun(h, copy.repo, ["config", "--add", k, v]);
    return { h, ...copy };
  };

  caseTest(TASK, "D4: for each T002 configuration, the review destination equals the to field and URL of Git's push --dry-run --porcelain, or the review shows the panel or refuses on purpose", SHELL, async () => {
    const { h, f } = pushFixture();
    // One registered copy takes each variant in turn, because a session holds at most REGISTERED_WORKSPACES workspaces.
    const repo = pushVariant(h, f, PUSH_VARIANTS[0]!, `${h.root}/variant-${++copies}`);
    const configPath = `${repo}/.git/config`;
    gitRun(h, repo, ["config", "--unset-all", "push.default"], { allowExit: [0, 5] });
    const base = h.read(configPath)!;
    await withSync("t034-matrix", async (service) => {
      const r = await register(service, repo);
      for (const v of PUSH_VARIANTS) {
        h.write(configPath, base);
        gitRun(h, repo, ["checkout", "-q", v.branch]);
        setConfig(h, repo, v.config.map(([k, value]) => [k, value.replace("{origin}", f.origin).replace("{second}", f.second)] as const));
        const expected = expectedOf(v.name);
        const from = service.runner.calls.length;
        const response = await reviewSync(service, r, { action: "push" });
        const git = gitDryRun(h, repo, v.branch);
        const label = { variant: v.name };
        if (expected.kind === "destination") {
          expect({ ...label, ...outcome(response) }).toEqual({ ...label, ...SUCCEEDED });
          const dest = response.result!.plan.destination!;
          expect({ ...label, remote: dest.remote, ref: dest.ref, source: dest.source, url: dest.url, setUpstream: dest.setUpstream }).toEqual({ ...label, remote: expected.remote, ref: expected.ref, source: expected.source, url: urlOf(f, expected.remote), setUpstream: false });
          expect({ ...label, git }).toEqual({ ...label, git: { to: expected.ref, url: urlOf(f, expected.remote) } });
          expect(typeof response.result!.syncReviewToken).toBe("string");
        } else if (expected.kind === "panel") {
          expect({ ...label, ...outcome(response), token: response.result?.syncReviewToken }).toEqual({ ...label, ...SUCCEEDED, token: undefined });
          expect({ ...label, needs: response.result!.plan.needsDestination }).toEqual({ ...label, needs: { remotes: ["origin", "second"], prefill: expected.prefill, setUpstream: expected.setUpstream, upstreamRebase: false } });
          if (expected.prefill !== null) expect({ ...label, git }).toEqual({ ...label, git: { to: expected.prefill.ref, url: f.origin } });
        } else if (expected.kind === "refused") {
          expect({ ...label, ...refusalOf(response) }).toEqual({ ...label, state: "failed", code: "SYNC_UNAVAILABLE", result: { reason: expected.reason } });
        } else {
          expect({ ...label, ...outcome(response) }).toEqual({ ...label, state: "failed", code: expected.code });
        }
        expect(remoteCalls(service, from)).toEqual([]);
      }
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "SC-001: the remote branch and the tracking ref equal Git's own push on a copy; full ref names, no tag, and equal configuration bytes", SHELL, async () => {
    const a = own("topic");
    const b = own("topic");
    gitRun(a.h, a.repo, ["tag", "local-tag"]);
    gitRun(b.h, b.repo, ["push", "-q", "origin"]);
    const before = configDigests(a.h, a.repo);
    const base = revParse(a.h, a.repo, "refs/remotes/origin/topic");
    await withSync("t034-push", async (service) => {
      const r = await register(service, a.repo);
      const review = await reviewed(service, r, { action: "push" });
      expect(review.plan.destination).toMatchObject({ remote: "origin", ref: "refs/heads/topic", trackingRef: "refs/remotes/origin/topic", setUpstream: false, source: "push-default-branch" });
      const from = service.runner.calls.length;
      const requestId = sendSync(service, r, review.syncReviewToken);
      const response = await service.response<SyncResult>(requestId);
      expect(outcome(response)).toEqual(SUCCEEDED);
      const head = revParse(a.h, a.repo, "HEAD");
      expect(response.result!.push).toMatchObject({ status: "pushed", oldObjectId: base, newObjectId: head, lease: false, upstreamWritten: false });
      expect(refMap(a.h, a.remotes.origin!)).toEqual(refMap(b.h, b.remotes.origin!));
      expect(refMap(a.h, a.repo, ["refs/remotes"])).toEqual(refMap(b.h, b.repo, ["refs/remotes"]));
      expect(refMap(a.h, a.remotes.origin!, ["refs/tags"])).toEqual({});
      expect(remoteCalls(service, from).map((c) => [c.arguments, c.environmentPolicy, c.limits])).toEqual([[PUSH("origin", "refs/heads/topic:refs/heads/topic"), "remote", NETWORK_LIMITS]]);
      expect((service.progress as { requestId?: string; phase?: string }[]).some((p) => p.requestId === requestId && p.phase === "sync-push")).toBe(true);
      expect(configDigests(a.h, a.repo)).toEqual(before);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-016: a branch without an upstream gives the panel and no token; Set upstream writes only branch.<name>.remote and .merge; without it the configuration bytes stay equal", SHELL, async () => {
    const a = own("noup");
    const b = own("noup");
    const config = localConfig(a.h, a.repo);
    const digests = configDigests(b.h, b.repo);
    await withSync("t034-panel", async (service) => {
      const r = await register(service, a.repo);
      const panel = await reviewSync(service, r, { action: "push" });
      expect({ ...outcome(panel), token: panel.result?.syncReviewToken, needs: panel.result?.plan.needsDestination }).toEqual({ ...SUCCEEDED, token: undefined, needs: { remotes: ["origin", "second"], prefill: null, setUpstream: true, upstreamRebase: false } });
      for (const destination of [{ remote: "origin", branch: "bad..name", setUpstream: true }, { remote: "nowhere", branch: "noup", setUpstream: true }]) {
        expect((await reviewSync(service, r, { action: "push", destination })).code).toBe("INVALID_REQUEST");
      }
      const from = service.runner.calls.length;
      const response = await run(service, r, { action: "push", destination: { remote: "origin", branch: "noup", setUpstream: true } });
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect(response.result!.push).toMatchObject({ status: "created", upstreamWritten: true, upstreamNotSet: false });
      expect(response.result!.remedy).toBeUndefined();
      // Contract Δ3 Set upstream: the push carries no --set-upstream, and the two writes follow it under the same policy.
      expect(remoteCalls(service, from).map((c) => [c.arguments, c.environmentPolicy])).toEqual([
        [PUSH("origin", "refs/heads/noup:refs/heads/noup"), "remote"],
        ...UPSTREAM("noup", "origin", "refs/heads/noup").map((args) => [args, "remote"]),
      ]);
      const head = revParse(a.h, a.repo, "HEAD");
      expect(refMap(a.h, a.remotes.origin!, ["refs/heads/noup"])).toEqual({ "refs/heads/noup": head });
      expect(localConfig(a.h, a.repo)).toEqual([...config, "branch.noup.remote=origin", "branch.noup.merge=refs/heads/noup"]);

      const s = await register(service, b.repo);
      const plain = await run(service, s, { action: "push", destination: { remote: "second", branch: "noup", setUpstream: false } });
      expect(outcome(plain)).toEqual(SUCCEEDED);
      expect(plain.result!.push).toMatchObject({ status: "created", upstreamWritten: false });
      expect(refMap(b.h, b.remotes.second!, ["refs/heads/noup"])).toEqual({ "refs/heads/noup": revParse(b.h, b.repo, "HEAD") });
      expect(configDigests(b.h, b.repo)).toEqual(digests);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "Δ3 Set upstream with branch.autoSetupRebase=always: the three writes give configuration bytes equal to Git's own push --set-upstream on a copy", SHELL, async () => {
    const a = own("noup", [["branch.autoSetupRebase", "always"]]);
    // The copy keeps the remote URLs of `a`, so only Git's own upstream writes can differ.
    const oracle = `${a.h.root}/oracle-${++copies}`;
    a.h.copy(a.repo, oracle);
    await withSync("t034-upstream-rebase", async (service) => {
      const r = await register(service, a.repo);
      // FR-016: the panel names the rebase key, and the review binds it.
      expect((await reviewSync(service, r, { action: "push" })).result!.plan.needsDestination!.upstreamRebase).toBe(true);
      const review = await reviewed(service, r, { action: "push", destination: { remote: "origin", branch: "noup", setUpstream: true } });
      expect(review.plan.destination).toMatchObject({ setUpstream: true, upstreamRebase: true });
      const from = service.runner.calls.length;
      const response = await sync(service, r, review.syncReviewToken);
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect(response.result!.push).toMatchObject({ status: "created", upstreamWritten: true, upstreamNotSet: false });
      expect(remoteCalls(service, from).slice(1).map((c) => c.arguments)).toEqual([
        ...UPSTREAM("noup", "origin", "refs/heads/noup"),
        ["--no-lazy-fetch", "config", "--local", "--", "branch.noup.rebase", "true"],
      ]);
    });
    gitRun(a.h, oracle, ["push", "-q", "--set-upstream", "origin", "noup"]);
    expect(localConfig(a.h, a.repo).filter((l) => l.startsWith("branch.noup."))).toEqual(["branch.noup.remote=origin", "branch.noup.merge=refs/heads/noup", "branch.noup.rebase=true"]);
    expect(a.h.read(`${a.repo}/.git/config`)).toEqual(a.h.read(`${oracle}/.git/config`));
  }, TIMEOUT_MS);

  caseTest(TASK, "Δ3 Set upstream: a locked configuration after a successful first push gives succeeded with upstreamNotSet and the copyable remedy; the remote branch exists and the configuration stays equal", SHELL, async () => {
    const a = own("noup");
    const config = localConfig(a.h, a.repo);
    const lock = `${a.repo}/.git/config.lock`;
    await withSync("t034-upstream-locked", async (service) => {
      const r = await register(service, a.repo);
      const review = await reviewed(service, r, { action: "push", destination: { remote: "origin", branch: "noup", setUpstream: true } });
      // git-config(1): a write that cannot lock the file exits non-zero.
      a.h.write(lock, "");
      try {
        const response = await sync(service, r, review.syncReviewToken);
        expect(outcome(response)).toEqual(SUCCEEDED);
        expect(response.result!.push).toMatchObject({ status: "created", upstreamWritten: false, upstreamNotSet: true });
        const step = (key: string, value: string) => `& ${psQuote(gitExe())} --no-lazy-fetch -C ${psQuote(r.worktreeRoot)} config --local -- '${key}' '${value}'`;
        expect(response.result!.remedy).toEqual({
          text: "The push succeeded, but Arbareto could not set the upstream. This command sets it.",
          command: `${step("branch.noup.remote", "origin")}; ${step("branch.noup.merge", "refs/heads/noup")}`,
        });
        expect(refMap(a.h, a.remotes.origin!, ["refs/heads/noup"])).toEqual({ "refs/heads/noup": revParse(a.h, a.repo, "HEAD") });
      } finally {
        rmSync(native(lock));
      }
      expect(localConfig(a.h, a.repo)).toEqual(config);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "D4 step 4: a triangular simple branch pushes to refs/heads/<branch> on the push remote as Git does, keeps its upstream bytes, and Force push with lease gives no-lease", SHELL, async () => {
    const a = own("topic", [["branch.topic.pushRemote", "second"]]);
    const b = own("topic", [["branch.topic.pushRemote", "second"]]);
    gitRun(b.h, b.repo, ["push", "-q"]);
    const before = configDigests(a.h, a.repo);
    await withSync("t034-triangular", async (service) => {
      const r = await register(service, a.repo);
      const review = await reviewed(service, r, { action: "push" });
      expect(review.plan.destination).toMatchObject({ remote: "second", ref: "refs/heads/topic", trackingRef: null, source: "push-default-triangular" });
      expect(outcome(await sync(service, r, review.syncReviewToken))).toEqual(SUCCEEDED);
      expect(refMap(a.h, a.remotes.second!)).toEqual(refMap(b.h, b.remotes.second!));
      expect(configDigests(a.h, a.repo)).toEqual(before);
      const force = await reviewSync(service, r, { action: "force-push" });
      expect(refusalOf(force)).toEqual({ state: "failed", code: "SYNC_UNAVAILABLE", result: { reason: "no-lease" } });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "matching gives the panel; a chosen destination pushes only the current branch with one full refspec and --no-follow-tags", SHELL, async () => {
    const a = own("topic", [["push.default", "matching"]]);
    const origin = refMap(a.h, a.remotes.origin!);
    await withSync("t034-matching", async (service) => {
      const r = await register(service, a.repo);
      expect((await reviewSync(service, r, { action: "push" })).result!.plan.needsDestination).toBeDefined();
      const from = service.runner.calls.length;
      expect(outcome(await run(service, r, { action: "push", destination: { remote: "origin", branch: "topic", setUpstream: false } }))).toEqual(SUCCEEDED);
      expect(remoteCalls(service, from).map((c) => c.arguments)).toEqual([PUSH("origin", "refs/heads/topic:refs/heads/topic")]);
      expect(refMap(a.h, a.remotes.origin!)).toEqual({ ...origin, "refs/heads/topic": revParse(a.h, a.repo, "HEAD") });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-017: detached, unborn, remote-missing, mirror, push-urls, push-remote-differs, invalid-config, the five invalid remote values, and OPERATION_IN_PROGRESS refuse before any process", SHELL, async () => {
    const { f } = pushFixture();
    const cases: [string, () => ReturnType<typeof own>, { code: string; reason?: string }][] = [
        ["detached", () => (({ h, repo, remotes }) => (gitRun(h, repo, ["checkout", "-q", "--detach"]), { h, repo, remotes }))(own("topic")), { code: "SYNC_UNAVAILABLE", reason: "detached" }],
        ["unborn", () => (({ h, repo, remotes }) => (gitRun(h, repo, ["checkout", "-q", "--orphan", "fresh"]), { h, repo, remotes }))(own("topic")), { code: "SYNC_UNAVAILABLE", reason: "unborn" }],
        ["remote-missing", () => own("topic", [["branch.topic.pushRemote", "nowhere"]]), { code: "SYNC_UNAVAILABLE", reason: "remote-missing" }],
        ["mirror", () => own("topic", [["remote.mirror.url", f.second], ["remote.mirror.mirror", "true"], ["branch.topic.pushRemote", "mirror"]]), { code: "SYNC_UNAVAILABLE", reason: "mirror" }],
        ["push-urls", () => own("topic", [["remote.origin.pushurl", f.origin], ["remote.origin.pushurl", f.second]]), { code: "SYNC_UNAVAILABLE", reason: "push-urls" }],
        ["push-remote-differs", () => own("topic", [["push.default", "upstream"], ["branch.topic.pushRemote", "second"]]), { code: "SYNC_UNAVAILABLE", reason: "push-remote-differs" }],
        ["invalid-config", () => own("topic", [["push.default", "nothing"]]), { code: "SYNC_UNAVAILABLE", reason: "invalid-config" }],
        // remote.c `handle_config` refuses an empty branch subsection, so `git remote` exits 128 (probe on 2.56.0.windows.2).
        [
          "empty branch subsection",
          () => {
            const c = own("topic");
            const path = `${c.repo}/.git/config`;
            c.h.write(path, `${c.h.read(path)!.toString("utf8")}[branch ""]\n\tremote = o\n`);
            return c;
          },
          { code: "SYNC_UNAVAILABLE", reason: "invalid-config" },
        ],
        ...["mirror", "skipFetchAll", "skipDefaultUpdate", "prune", "pruneTags"].map((key): [string, () => ReturnType<typeof own>, { code: string; reason?: string }] => [`remote.second.${key}`, () => own("topic", [[`remote.second.${key}`, "maybe"]]), { code: "SYNC_UNAVAILABLE", reason: "invalid-config" }]),
        [
          "merging",
          () => {
            const c = own("topic");
            gitRun(c.h, c.repo, ["checkout", "-q", "-b", "side"]);
            gitRun(c.h, c.repo, ["commit", "-q", "--allow-empty", "-m", "side"]);
            gitRun(c.h, c.repo, ["checkout", "-q", "topic"]);
            gitRun(c.h, c.repo, ["merge", "-q", "--no-ff", "--no-commit", "side"]);
            return c;
          },
          { code: "OPERATION_IN_PROGRESS" },
        ],
      ];
    for (const [i, [name, build, expected]] of cases.entries()) {
      await withSync(`t034-refusal-${i}`, async (service) => {
        const r = await register(service, build().repo);
        const from = service.runner.calls.length;
        const response = await reviewSync(service, r, { action: "push" });
        expect({ name, ...outcome(response), reason: (response.result as { reason?: string } | undefined)?.reason }).toEqual({ name, state: "failed", code: expected.code, reason: expected.reason });
        expect({ name, calls: remoteCalls(service, from) }).toEqual({ name, calls: [] });
      });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-015: a pre-receive refusal gives PUSH_REJECTED with status remote-rejected and plain reason text without ESC sequences; a non-fast-forward gives status rejected", SHELL, async () => {
    const a = own("topic");
    const refusing = `${a.h.root}/refusing.git`;
    gitRun(a.h, a.h.root, ["init", "-q", "--bare", "-b", "main", "--", refusing]);
    a.h.write(`${refusing}/hooks/pre-receive`, `#!/bin/sh\nprintf '\\033[31mremote message\\033[0m\\n' >&2\nexit 1\n`);
    gitRun(a.h, a.repo, ["remote", "add", "refusing", refusing]);
    const b = own("topic");
    importStream(b.h, b.remotes.origin!, [fc({ mark: 1, ref: "refs/heads/topic", message: "remote only\n", from: undefined, files: { "remote-only.txt": "r\n" } })], { force: true });
    const remoteTopic = refMap(b.h, b.remotes.origin!);
    await withSync("t034-rejected", async (service) => {
      const r = await register(service, a.repo);
      const refused = await run(service, r, { action: "push", destination: { remote: "refusing", branch: "topic", setUpstream: false } });
      expect(outcome(refused)).toEqual({ state: "failed", code: "PUSH_REJECTED" });
      expect(refused.result!.reason).toBe("remote-rejected");
      expect(refused.result!.push).toMatchObject({ status: "remote-rejected", lease: false });
      expect(refused.result!.push!.outputTail).toContain("remote message");
      expect(refused.result!.push!.outputTail.includes("\u001b")).toBe(false);
      expect(ESC_MESSAGE.includes("\u001b")).toBe(true);
      expect(refMap(a.h, refusing)).toEqual({});

      const s = await register(service, b.repo);
      const rejected = await run(service, s, { action: "push" });
      expect(outcome(rejected)).toEqual({ state: "failed", code: "PUSH_REJECTED" });
      expect(rejected.result!.push).toMatchObject({ status: "rejected", lease: false });
      expect(refMap(b.h, b.remotes.origin!)).toEqual(remoteTopic);
    });
  }, TIMEOUT_MS);

  // Contract Δ3 `sync` step 2: a changed fingerprint is a trust difference only when `approvalRequired.sync` holds on either side.
  caseTest(TASK, "data-model §2: a changed HEAD, remote list, or push URL after the review gives STALE_REVIEW; with an approved sync-class hook, a changed push URL gives TRUST_CHANGED; no remote process starts", SHELL, async () => {
    const setPushUrl = (c: ReturnType<typeof own>) => gitRun(c.h, c.repo, ["remote", "set-url", "--push", "origin", c.remotes.second!]);
    const cases: [string, string, (c: ReturnType<typeof own>) => void, string, boolean][] = [
      ["HEAD", "push", (c) => gitRun(c.h, c.repo, ["commit", "-q", "--allow-empty", "-m", "after the review"]), "STALE_REVIEW", false],
      ["remote list", "fetch-all", (c) => gitRun(c.h, c.repo, ["remote", "add", "third", c.remotes.origin!]), "STALE_REVIEW", false],
      ["push URL", "push", setPushUrl, "STALE_REVIEW", false],
      ["push URL with an approved pre-push hook", "push", setPushUrl, "TRUST_CHANGED", true],
    ];
    for (const [i, [name, action, change, code, hooked]] of cases.entries()) {
      const a = own("topic");
      if (hooked) a.h.write(`${a.repo}/.git/hooks/pre-push`, "#!/bin/sh\nexit 0\n");
      await withSync(`t034-stale-${i}`, async (service) => {
        const r = await register(service, a.repo);
        if (hooked) {
          const trust = await service.readTrust(r.repositoryId);
          expect({ name, sync: trust.result!.approvalRequired.sync }).toEqual({ name, sync: true });
          expect((await service.approveTrust(r.repositoryId)).state).toBe("succeeded");
        }
        const review = await reviewed(service, r, { action });
        change(a);
        const from = service.runner.calls.length;
        const response = await sync(service, r, review.syncReviewToken);
        expect({ name, ...outcome(response) }).toEqual({ name, state: "failed", code });
        expect({ name, calls: remoteCalls(service, from) }).toEqual({ name, calls: [] });
      });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "Δ8: a canceled push says that the remote can hold the push", SHELL, async () => {
    const a = own("topic");
    const origin = refMap(a.h, a.remotes.origin!);
    await withSync("t034-cancel", async (service) => {
      const r = await register(service, a.repo);
      const review = await reviewed(service, r, { action: "push" });
      const release = service.runner.holdStart(isPush);
      const requestId = sendSync(service, r, review.syncReviewToken);
      const end = performance.now() + 10_000;
      while (!service.runner.calls.some(isPush) && performance.now() < end) await Bun.sleep(20);
      await service.cancel(await service.operationId(requestId));
      release();
      const response = await service.response<SyncResult>(requestId);
      expect(outcome(response)).toEqual({ state: "canceled", code: "CANCELED" });
      expect(response.result!.remedy).toEqual({ text: "The remote can hold this push. Fetch to see the remote state.", command: null });
      expect(refMap(a.h, a.remotes.origin!)).toEqual(origin);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-018: after a push of a branch whose remote name holds a slash, the tracking ref shows the pushed value", SHELL, async () => {
    const h = hostFor("t034-slash");
    const counts = buildCounts(h);
    gitRun(h, counts.clone, ["checkout", "-q", "feature/x"]);
    gitRun(h, counts.clone, ["reset", "-q", "--hard", "refs/remotes/team/up/feature/x"]);
    gitRun(h, counts.clone, ["commit", "-q", "--allow-empty", "-m", "slash"]);
    await withSync("t034-slash", async (service) => {
      const r = await register(service, counts.clone);
      const review = await reviewed(service, r, { action: "push" });
      expect(review.plan.destination).toMatchObject({ remote: "team/up", ref: "refs/heads/feature/x", trackingRef: "refs/remotes/team/up/feature/x" });
      const response = await sync(service, r, review.syncReviewToken);
      expect(outcome(response)).toEqual(SUCCEEDED);
      const head = revParse(h, counts.clone, "HEAD");
      expect(refMap(h, counts.clone, ["refs/remotes/team/up/feature/x"])).toEqual({ "refs/remotes/team/up/feature/x": head });
      expect(response.result!.push!.newObjectId).toBe(head);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-038: a rejected push after a commit keeps the commit and gives PUSH_REJECTED reason rejected", SHELL, async () => {
    const a = own("topic");
    importStream(a.h, a.remotes.origin!, [fc({ mark: 1, ref: "refs/heads/topic", message: "remote only\n", from: undefined, files: { "remote-only.txt": "r\n" } })], { force: true });
    a.h.write(`${a.repo}/committed.txt`, "committed\n");
    gitRun(a.h, a.repo, ["add", "--", "committed.txt"]);
    await withSync("t034-commit-push", async (service) => {
      const r = await register(service, a.repo);
      const review = await reviewOk(service, r.repositoryId);
      expect(outcome(await commit(service, r.repositoryId, review, "commit then push\n"))).toEqual(SUCCEEDED);
      const committed = revParse(a.h, a.repo, "HEAD");
      const read = await service.readWorkspace(r.repositoryId);
      const rejected = await run(service, { ...r, generation: read.result!.generation }, { action: "push" });
      expect(outcome(rejected)).toEqual({ state: "failed", code: "PUSH_REJECTED" });
      expect({ status: rejected.result!.push!.status, reason: rejected.result!.reason }).toEqual({ status: "rejected", reason: "rejected" });
      expect(revParse(a.h, a.repo, "HEAD")).toBe(committed);
    });
  }, TIMEOUT_MS);
});
