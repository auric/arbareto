// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T052: feature 004 contract Δ12 "Submodules" and plan.md D13: the one-click update, the scope of one row, the host lines with `confirmHosts`,
// the `unchecked` entries of the run confirmation, and Cancel. The 001 §12 refusals still refuse (SC-011). T058 implements these rules.

import { describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as submodules from "../../src/contracts/submodules";
import type { SubmodulePlanRow, SubmoduleProgram } from "../../src/contracts/submodules";
import { printOrigin } from "../origin";
import { fixtureEnv, useFixtureRoot } from "./fixture-root";
import { buildF27, buildF28, buildF29, type Built, type F28Variant } from "./fixtures";
import { rawIndexDigest } from "./git-oracle";
import { gitPath, outcome, readOk, SUCCEEDED, TIMEOUT_MS, until, valuesOf } from "./hunk-harness";
import { caseTest, once, type Capability, type Service, type ServiceResponse } from "./service-harness";
import {
  actionsOf,
  callsSince,
  commandOf,
  copySuper,
  fixtureGit,
  globalEnv,
  objectsWith,
  oracleOf,
  ranCanaries,
  refusalsOf,
  resultOf,
  resultsOf,
  stateOf,
  superOf,
  underTestSubmodule,
  updateSteps,
  withFixture,
  type SubmoduleRefusal,
} from "./submodule-harness";

printOrigin("../../src/git-service/submodule-review.ts", import.meta.dir);
printOrigin("../../src/git-service/submodule-update.ts", import.meta.dir);
printOrigin("../../src/contracts/submodules.ts", import.meta.dir);

const TASK = "T052";
const SHELL: Capability[] = ["shell-double"];
const scopeCase = (name: string, fn: () => Promise<void>) => caseTest(TASK, name, SHELL, fn, TIMEOUT_MS);

useFixtureRoot();

// Contract Δ12 host line: `fetch` and `settings` name a host, this computer, or an unknown host (plan.md D13).
type Host = { kind: "host"; name: string } | { kind: "local" } | { kind: "unknown" };
type HostLine = { path: string; fetch: Host; settings: Host };

interface Review {
  response: ServiceResponse;
  generation: number;
  token: string | undefined;
  rows: SubmodulePlanRow[];
  programs: SubmoduleProgram[];
  refusals: SubmoduleRefusal[];
  // The `hosts` value of the result. Undefined: the result holds no host lines.
  hosts: unknown;
}

// `reviewSubmodules` of a fresh read, with `scope` when `path` is given (contract Δ12).
async function review(service: Service, repositoryId: string, path?: string): Promise<Review> {
  await underTestSubmodule("submodule-review");
  const read = await readOk(service, repositoryId);
  const response = await service.request("reviewSubmodules", { snapshotId: read.snapshotId, ...(path === undefined ? {} : { scope: { path } }) }, { repositoryId, repositoryGeneration: read.generation });
  return {
    response,
    generation: read.generation,
    token: valuesOf(response.result, "submoduleReviewToken")[0] as string | undefined,
    rows: objectsWith<SubmodulePlanRow>(response.result, ["rowId", "action"]),
    programs: objectsWith<SubmoduleProgram>(response.result, ["key", "digest"]),
    refusals: refusalsOf(response.result),
    hosts: valuesOf(response.result, "hosts")[0],
  };
}

// A review without refusal: the token goes out, and the result holds host lines.
async function reviewOk(service: Service, repositoryId: string, path?: string): Promise<Review> {
  const r = await review(service, repositoryId, path);
  expect({ outcome: outcome(r.response), refusals: r.refusals.map((x) => [x.path, x.reason]), token: typeof r.token, hosts: Array.isArray(r.hosts) }).toEqual({ outcome: SUCCEEDED, refusals: [], token: "string", hosts: true });
  return r;
}

// `updateSubmodules` with the review token, at once, as the one click of contract Δ12 sends it.
async function update(service: Service, repositoryId: string, r: Review, confirmHosts = false): Promise<ServiceResponse> {
  await underTestSubmodule("submodule-update");
  return service.request("updateSubmodules", { submoduleReviewToken: r.token, start: true, ...(confirmHosts ? { confirmHosts: true } : {}) }, { repositoryId, repositoryGeneration: r.generation });
}

// Git's own update of one row in a copy: `git -C <parent> submodule update --init --recursive -- :(literal)<path>`. `parent` is relative to the superproject.
function scopedOracle(b: Built, name: string, parent: string, path: string) {
  const copy = copySuper(b, name);
  const run = Bun.spawnSync([gitPath(), "submodule", "update", "--init", "--recursive", "--", `:(literal)${path}`], { cwd: join(copy, parent), env: fixtureEnv(globalEnv(b)), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { copy, exitCode: run.exitCode, ...stateOf(b, copy) };
}

// The `submodule.*` keys of a repository configuration file, as `git config --local -z --get-regexp` prints them.
const submoduleKeys = (b: Built, dir: string) => fixtureGit(b, dir, ["config", "--local", "-z", "--get-regexp", "^submodule\\."], [0, 1]);
// The HEAD of a populated path, or null without a `.git` entry.
const freshHead = (b: Built, dir: string) => (existsSync(join(dir, ".git")) ? fixtureGit(b, dir, ["rev-parse", "--verify", "-q", "HEAD"], [0, 1]).trim() || null : null);

describe("one click (contract Δ12, 001 FR-048 change)", () => {
  scopeCase("F27 base: a review without refusal and host lines gives a token; the update with it at once equals Git's own update", async () => {
    const b = buildF27(gitPath(), "t052-one-click", "base");
    const sup = superOf(b);
    const oracle = oracleOf(b, "oracle-copy");
    await withFixture(b, "t052-one-click", async (service) => {
      const { repositoryId } = await service.register(sup);
      const r = await reviewOk(service, repositoryId);
      expect(r.hosts).toEqual([]);
      const response = await update(service, repositoryId, r);
      expect({ oracle: oracle.exitCode, outcome: outcome(response), state: stateOf(b) }).toEqual({ oracle: 0, outcome: SUCCEEDED, state: { heads: oracle.heads, gitDirs: oracle.gitDirs, keys: oracle.keys } });
    });
  });
});

describe("refusals still refuse (001 FR-049, SC-011)", () => {
  type Case = { id: string; reason: string; build: (name: string) => Built; config?: string[] };
  const f28 = (variant: F28Variant, reason: string): Case => ({ id: `F28 ${variant}`, reason, build: (name) => buildF28(gitPath(), name, variant) });
  const CASES: Case[] = [
    f28("detached-unsaved", "unsaved-commits"),
    f28("update-command", "update-mode"),
    f28("gitmodules-command", "update-mode"),
    f28("no-url", "no-url"),
    f28("interrupted", "clone-interrupted"),
    f28("folder", "folder-not-empty"),
    f28("remote-name", "remote-name"),
    {
      id: "F27 base with submodule.solo.active=maybe",
      reason: "active-value",
      build: (name) => {
        const b = buildF27(gitPath(), name, "base");
        fixtureGit(b, superOf(b), ["config", "submodule.solo.active", "maybe"]);
        return b;
      },
    },
    { id: "F29 gitdir-extension", reason: "gitdir-config", build: (name) => buildF29(gitPath(), name, "gitdir-extension"), config: ["-c", "core.fsmonitor=false"] },
  ];
  CASES.forEach((c, i) => {
    scopeCase(`${c.id}: the review refuses with ${c.reason}, and the one-click update gives UNSUPPORTED_SUBMODULE, starts no process, and changes nothing`, async () => {
      const name = `t052-refuse-${i}`;
      const b = c.build(name);
      const sup = superOf(b);
      const before = { state: stateOf(b, sup, c.config), index: rawIndexDigest(gitPath(), sup) };
      await withFixture(b, name, async (service) => {
        const { repositoryId } = await service.register(sup);
        const r = await review(service, repositoryId);
        expect(r.refusals.map((x) => x.reason)).toContain(c.reason);
        const from = service.runner.calls.length;
        const response = await update(service, repositoryId, r);
        expect({ code: response.code, reasons: refusalsOf(response).map((x) => x.reason), steps: updateSteps(service, from).length, canaries: ranCanaries(b) }).toEqual({
          code: "UNSUPPORTED_SUBMODULE",
          reasons: r.refusals.map((x) => x.reason),
          steps: 0,
          canaries: [],
        });
      });
      expect({ state: stateOf(b, sup, c.config), index: rawIndexDigest(gitPath(), sup) }).toEqual(before);
    });
  });
});

describe("scope (contract Δ12, spec FR-081)", () => {
  scopeCase("F28 detached-unsaved: a scoped review of mid holds no refusal of solo; its update changes only mid and its nested rows, as Git's own update of mid does", async () => {
    const b = buildF28(gitPath(), "t052-scope-top", "detached-unsaved");
    const sup = superOf(b);
    const soloHead = freshHead(b, join(sup, "solo"));
    const oracle = scopedOracle(b, "oracle-copy", "", "mid");
    await withFixture(b, "t052-scope-top", async (service) => {
      const { repositoryId } = await service.register(sup);
      const full = await review(service, repositoryId);
      expect(full.refusals.map((x) => [x.path, x.reason])).toEqual([["solo", "unsaved-commits"]]);
      const r = await reviewOk(service, repositoryId, "mid");
      expect({ rows: r.rows.map((row) => row.path), hosts: r.hosts }).toEqual({ rows: ["mid"], hosts: [] });
      const from = service.runner.calls.length;
      const response = await update(service, repositoryId, r);
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect(updateSteps(service, from).filter((c) => commandOf(c.arguments).includes(":(literal)solo"))).toEqual([]);
      expect({ oracle: oracle.exitCode, state: stateOf(b) }).toEqual({ oracle: 0, state: { heads: oracle.heads, gitDirs: oracle.gitDirs, keys: oracle.keys } });
      expect(freshHead(b, join(sup, "solo"))).toBe(soloHead);
    });
  });

  scopeCase("F28 detached-unsaved: a scoped review of solo keeps the unsaved-commits refusal, and its update refuses", async () => {
    const b = buildF28(gitPath(), "t052-scope-refused", "detached-unsaved");
    await withFixture(b, "t052-scope-refused", async (service) => {
      const { repositoryId } = await service.register(superOf(b));
      const r = await review(service, repositoryId, "solo");
      expect(r.refusals.map((x) => [x.path, x.reason])).toEqual([["solo", "unsaved-commits"]]);
      const from = service.runner.calls.length;
      const response = await update(service, repositoryId, r);
      expect({ code: response.code, steps: updateSteps(service, from).length }).toEqual({ code: "UNSUPPORTED_SUBMODULE", steps: 0 });
    });
  });

  scopeCase("F27 base with mid populated and leaf on a branch: a scoped review of mid/leaf passes through mid, and only leaf moves, as Git's own update in mid does", async () => {
    const b = buildF27(gitPath(), "t052-scope-nested", "base");
    const sup = superOf(b);
    const mid = join(sup, "mid");
    fixtureGit(b, sup, ["submodule", "update", "--init", "--recursive", "--", "mid"]);
    const leaf = join(mid, "leaf");
    const recorded = freshHead(b, leaf)!;
    fixtureGit(b, leaf, ["checkout", "-q", "-b", "side"]);
    fixtureGit(b, leaf, ["commit", "-q", "--allow-empty", "-m", "side"]);
    const midHead = freshHead(b, mid);
    const oracle = scopedOracle(b, "oracle-copy", "mid", "leaf");
    const before = { super: submoduleKeys(b, sup), mid: submoduleKeys(b, mid) };
    await withFixture(b, "t052-scope-nested", async (service) => {
      const { repositoryId } = await service.register(sup);
      const r = await reviewOk(service, repositoryId, "mid/leaf");
      expect(actionsOf(r)).toEqual({ mid: "none", "mid/leaf": "checkout" });
      // Contract §12 "Trust": the step of a nested row runs Git in its parent worktree, so the list holds the programs of mid too. No other row holds one.
      const owners = new Set(r.programs.map((p) => ("rowId" in p ? r.rows.find((row) => row.rowId === p.rowId)?.path : "dir")));
      expect([...owners].every((o) => o === "mid" || o === "mid/leaf")).toBe(true);
      const from = service.runner.calls.length;
      const response = await update(service, repositoryId, r);
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect(updateSteps(service, from).map((c) => commandOf(c.arguments))).toEqual([["submodule", "update", "--init", "--no-fetch", "--progress", "--", ":(literal)leaf"]]);
      expect({ mid: resultOf(response, "mid").state, leaf: resultOf(response, "mid/leaf").state }).toEqual({ mid: "unchanged", leaf: "moved" });
      expect({ oracle: oracle.exitCode, state: stateOf(b) }).toEqual({ oracle: 0, state: { heads: oracle.heads, gitDirs: oracle.gitDirs, keys: oracle.keys } });
      expect({ mid: freshHead(b, mid), leaf: freshHead(b, leaf) }).toEqual({ mid: midHead, leaf: recorded });
      expect({ super: submoduleKeys(b, sup), mid: submoduleKeys(b, mid) }).toEqual({ super: before.super, mid: submoduleKeys(b, join(oracle.copy, "mid")) });
    });
  });

  for (const variant of ["base", "headless-kept"] as const) {
    scopeCase(`F27 ${variant}: a scoped review of mid/leaf without an initialized mid refuses with parent-not-initialized, and the update starts no process`, async () => {
      const b = buildF27(gitPath(), `t052-scope-parent-${variant}`, variant);
      const sup = superOf(b);
      const before = stateOf(b);
      await withFixture(b, `t052-scope-parent-${variant}`, async (service) => {
        const { repositoryId } = await service.register(sup);
        const r = await review(service, repositoryId, "mid/leaf");
        expect(r.refusals.map((x) => [x.path, x.reason, x.remedy ?? null])).toEqual([["mid/leaf", "parent-not-initialized", null]]);
        expect(r.refusals[0]!.text).toBe("Submodule mid is not initialized. Update mid first, then update submodule mid/leaf.");
        const from = service.runner.calls.length;
        const response = await update(service, repositoryId, r);
        expect({ code: response.code, steps: updateSteps(service, from).length }).toEqual({ code: "UNSUPPORTED_SUBMODULE", steps: 0 });
      });
      expect(stateOf(b)).toEqual(before);
    });
  }

  scopeCase("F27 base: a scope path that names no row fails with UNKNOWN_TARGET and gives no token", async () => {
    const b = buildF27(gitPath(), "t052-scope-unknown", "base");
    await withFixture(b, "t052-scope-unknown", async (service) => {
      const { repositoryId } = await service.register(superOf(b));
      const r = await review(service, repositoryId, "nothing");
      expect({ outcome: outcome(r.response), token: r.token }).toEqual({ outcome: { state: "failed", code: "UNKNOWN_TARGET" }, token: undefined });
    });
  });
});

describe("host lines (contract Δ12, plan.md D13, spec FR-079)", () => {
  // F27 behind-fetch: `solo` fetches from its local `origin`. The registered URL names another host, so the review gives one host line.
  const OTHER = "https://git.example.net/solo.git";

  scopeCase("F27 behind-fetch with submodule.solo.url on another host: one host line names both hosts; the update without confirmHosts gives STALE_REVIEW reason hosts and starts no process; with confirmHosts the same token runs and equals Git's own update", async () => {
    const b = buildF27(gitPath(), "t052-hosts", "behind-fetch");
    const sup = superOf(b);
    fixtureGit(b, sup, ["config", "submodule.solo.url", OTHER]);
    const oracle = oracleOf(b, "oracle-copy");
    await withFixture(b, "t052-hosts", async (service) => {
      const { repositoryId } = await service.register(sup);
      const r = await reviewOk(service, repositoryId);
      expect(r.hosts).toEqual([{ path: "solo", fetch: { kind: "local" }, settings: { kind: "host", name: "git.example.net" } }] satisfies HostLine[]);
      const from = service.runner.calls.length;
      const refused = await update(service, repositoryId, r);
      expect({ outcome: outcome(refused), reason: valuesOf(refused.result, "reason"), steps: updateSteps(service, from).length }).toEqual({ outcome: { state: "rejected", code: "STALE_REVIEW" }, reason: ["hosts"], steps: 0 });
      const response = await update(service, repositoryId, r, true);
      expect({ oracle: oracle.exitCode, outcome: outcome(response), state: stateOf(b) }).toEqual({ oracle: 0, outcome: SUCCEEDED, state: { heads: oracle.heads, gitDirs: oracle.gitDirs, keys: oracle.keys } });
    });
  });

  scopeCase("F27 behind-fetch: hosts compare without ASCII case; each remote on another host gives one line, and the settings URL keeps its form", async () => {
    const b = buildF27(gitPath(), "t052-hosts-case", "behind-fetch");
    const sup = superOf(b);
    const solo = join(sup, "solo");
    fixtureGit(b, sup, ["config", "submodule.solo.url", "ssh://git@Git.Example.NET:2222/solo.git"]);
    fixtureGit(b, solo, ["remote", "set-url", "origin", "https://git.example.net/solo.git"]);
    fixtureGit(b, solo, ["remote", "add", "mirror", "git@mirror.example:solo.git"]);
    await withFixture(b, "t052-hosts-case", async (service) => {
      const { repositoryId } = await service.register(sup);
      const r = await reviewOk(service, repositoryId);
      expect(r.hosts).toEqual([{ path: "solo", fetch: { kind: "host", name: "mirror.example" }, settings: { kind: "host", name: "Git.Example.NET" } }] satisfies HostLine[]);
    });
  });

  scopeCase("F27 behind-fetch with submodule.solo.url on another host: a scoped review of mid gives no host line, and its update runs at once and leaves solo", async () => {
    const b = buildF27(gitPath(), "t052-hosts-scope", "behind-fetch");
    const sup = superOf(b);
    fixtureGit(b, sup, ["config", "submodule.solo.url", OTHER]);
    const soloHead = freshHead(b, join(sup, "solo"));
    await withFixture(b, "t052-hosts-scope", async (service) => {
      const { repositoryId } = await service.register(sup);
      const r = await reviewOk(service, repositoryId, "mid");
      expect(r.hosts).toEqual([]);
      const response = await update(service, repositoryId, r);
      expect({ outcome: outcome(response), solo: freshHead(b, join(sup, "solo")), mid: freshHead(b, join(sup, "mid")) !== null }).toEqual({ outcome: SUCCEEDED, solo: soloHead, mid: true });
    });
  });

  // git-fetch(1) "GIT URLS", transport.c `transport_get`, connect.c `parse_connect_url`, `host_end`, `get_host_and_port`, `get_port`, and `url_is_local_not_ssh`.
  const host = (name: string): Host => ({ kind: "host", name });
  const LOCAL: Host = { kind: "local" };
  const UNKNOWN: Host = { kind: "unknown" };
  const VECTORS: [string, "windows" | "posix", Host][] = [
    ["https://github.com/org/repo.git", "windows", host("github.com")],
    ["https://user:secret@GitHub.com:443/org/repo.git", "windows", host("GitHub.com")],
    ["ssh://git@host.xz:2222/path/repo.git", "windows", host("host.xz")],
    ["ssh://[::1]:22/repo.git", "windows", host("::1")],
    ["git+ssh://host.xz/repo.git", "posix", host("host.xz")],
    ["git://host.xz/~user/repo.git", "windows", host("host.xz")],
    ["ftps://host.xz/repo.git", "windows", host("host.xz")],
    ["git@github.com:org/repo.git", "windows", host("github.com")],
    ["host.xz:repo.git", "posix", host("host.xz")],
    ["user@[::1]:repo.git", "windows", host("::1")],
    ["[host.xz:2222]:repo.git", "windows", host("host.xz")],
    ["[host.xz]x:repo.git", "windows", UNKNOWN],
    ["a@b@host.xz:repo.git", "windows", UNKNOWN],
    ["file:///C:/repos/solo.git", "windows", LOCAL],
    ["C:/repos/solo.git", "windows", LOCAL],
    ["C:/repos/solo.git", "posix", host("C")],
    ["/srv/solo.git", "posix", LOCAL],
    ["./foo:bar", "posix", LOCAL],
    ["../solo.git", "windows", LOCAL],
    ["ext::sh -c touch% /tmp/x", "windows", UNKNOWN],
    ["persistent-https::host/repo", "windows", UNKNOWN],
    ["svn://host.xz/repo", "windows", UNKNOWN],
    ["SSH://host.xz/repo", "windows", UNKNOWN],
    ["https://h%61st.xz/repo", "windows", UNKNOWN],
    ["https://host.xz", "windows", UNKNOWN],
    ["rsync://host.xz/repo", "windows", UNKNOWN],
    ["ssh://host.xz:abc/repo", "windows", host("host.xz:abc")],
  ];
  scopeCase("the URL host grammar gives the host, this computer, or an unknown host", async () => {
    // A namespace read, so the file loads before T058 adds the exports.
    const exported = submodules as unknown as Record<string, unknown>;
    const urlHost = exported.submoduleUrlHost as ((url: string, platform: "windows" | "posix") => Host) | undefined;
    expect(typeof urlHost).toBe("function");
    expect(VECTORS.map(([url, platform]) => [url, platform, urlHost!(url, platform)])).toEqual(VECTORS);
    const same = exported.sameSubmoduleHost as (a: Host, b: Host) => boolean;
    expect([same(host("GitHub.com"), host("github.com")), same(LOCAL, LOCAL), same(UNKNOWN, UNKNOWN), same(host("a"), LOCAL)]).toEqual([true, true, false, false]);
  });
});

describe("run confirmation (contract Δ12 confirmRun and §12 \"Trust\")", () => {
  scopeCase("F29 relative-hooks: each unchecked entry is the relative core.hooksPath of a row that the update writes, and confirmRun counts exactly them", async () => {
    const b = buildF29(gitPath(), "t052-unchecked", "relative-hooks");
    await withFixture(b, "t052-unchecked", async (service) => {
      service.runner.inject.confirmRun = "declined";
      const { repositoryId } = await service.register(superOf(b));
      const r = await reviewOk(service, repositoryId);
      const writes = new Set(r.rows.filter((row) => ["clone", "reuse", "checkout", "fetch-checkout"].includes(row.action)).map((row) => row.rowId));
      const unchecked = r.programs.filter((p) => p.digest === "unchecked");
      expect(unchecked.length).toBeGreaterThan(0);
      expect(unchecked.filter((p) => p.key !== "core.hooksPath" || !("rowId" in p) || !writes.has(p.rowId))).toEqual([]);
      const response = await update(service, repositoryId, r);
      expect(outcome(response)).toEqual({ state: "canceled", code: "CANCELED" });
      const frames = service.runner.frames.filter((f) => f.type === "confirmRun") as { programCount: number; uncheckedCount: number }[];
      expect(frames.map((f) => [f.programCount, f.uncheckedCount])).toEqual([[r.programs.length, unchecked.length]]);
    });
  });

  scopeCase("F27 base: without relative values, unknown nested values, or kept folders without a row, no entry is unchecked", async () => {
    const b = buildF27(gitPath(), "t052-unchecked-none", "base");
    await withFixture(b, "t052-unchecked-none", async (service) => {
      const { repositoryId } = await service.register(superOf(b));
      const r = await reviewOk(service, repositoryId);
      expect(r.programs.filter((p) => p.digest === "unchecked")).toEqual([]);
    });
  });
});

describe("Cancel (001 §12 \"Reconciliation and outcome\")", () => {
  scopeCase("F27 base: Cancel during the one-click update states each row from a fresh read", async () => {
    const b = buildF27(gitPath(), "t052-cancel", "base");
    const sup = superOf(b);
    await withFixture(b, "t052-cancel", async (service) => {
      const { repositoryId } = await service.register(sup);
      const r = await reviewOk(service, repositoryId);
      const isSoloClone = (c: { arguments: readonly string[] }) => commandOf(c.arguments).join(" ") === "submodule update --init --progress -- :(literal)solo";
      const release = service.runner.holdStart(once(isSoloClone));
      const from = service.runner.calls.length;
      await underTestSubmodule("submodule-update");
      const requestId = service.send("updateSubmodules", { submoduleReviewToken: r.token, start: true }, { repositoryId, repositoryGeneration: r.generation });
      await until(() => callsSince(service, from).some(isSoloClone) || service.responseAt.has(requestId), "solo clone", TIMEOUT_MS);
      await service.cancel(await service.operationId(requestId));
      release();
      const response = await service.response(requestId);
      expect(response.state).not.toBe("succeeded");
      const rows = resultsOf(response);
      expect(rows.map((row) => row.path).sort()).toEqual(["mid", "mid/leaf", "solo"]);
      expect(rows.map((row) => [row.path, row.newCommit])).toEqual(rows.map((row) => [row.path, freshHead(b, join(sup, row.path))]));
    });
  });
});
