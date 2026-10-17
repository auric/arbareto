// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T032: `readTracking` through the in-process service (contract Δ3 `readTracking`, data-model §1, FR-019, FR-021, SC-003).
// Every count comes from `rev-list --left-right --count` of the fixture, never from `src/git-service/`.

import { expect } from "bun:test";
import { REF_LISTING_RECORDS } from "../../src/contracts/limits";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { buildCounts, buildMany, COUNT_BRANCHES, COUNT_UNTRACKED, gitRun, leftRight, MANY_BRANCHES, manyCounts, manyName, refMap, UNRELATED_COMMITS, type GitHost } from "./remote-fixtures";
import { caseTest, type Service } from "./service-harness";
import { callsOf, hostFor, register, remoteCalls, subcommandOf, TIMEOUT_MS, withSync } from "./sync-harness";

useFixtureRoot();

const TASK = "T032";
const SHELL = ["shell-double"] as const;

interface Entry {
  name: string;
  invalidUtf8: boolean;
  objectId: string;
  upstream: string | null;
  upstreamObjectId: string | null;
  track: { state: "none" } | { state: "gone" } | { state: "counts"; ahead: number; behind: number };
  current: boolean;
}

async function readTracking(service: Service, path: string) {
  const r = await register(service, path);
  const requestId = service.send("readTracking", {}, { repositoryId: r.repositoryId, repositoryGeneration: r.generation });
  const response = await service.response<{ entries: Entry[]; completeness?: { state: string; code?: string; reason?: string } }>(requestId);
  return { response, operationId: response.operationId! };
}

const byName = (entries: Entry[]) => Object.fromEntries(entries.map((e) => [e.name, e]));

// The oracle entry of one local branch: `%(upstream)` and the `rev-list` counts of the fixture.
function oracleEntry(h: GitHost, repo: string, name: string, current: string | null): Entry {
  const all = refMap(h, repo);
  const upstream = gitRun(h, repo, ["for-each-ref", "--format=%(upstream)", `refs/heads/${name}`]).stdout.toString("utf8").trim() || null;
  const upstreamObjectId = upstream === null ? null : (all[upstream] ?? null);
  const track: Entry["track"] = upstream === null ? { state: "none" } : upstreamObjectId === null ? { state: "gone" } : (([ahead, behind]) => ({ state: "counts" as const, ahead, behind }))(leftRight(h, repo, `refs/heads/${name}`, upstream));
  return { name, invalidUtf8: false, objectId: all[`refs/heads/${name}`]!, upstream, upstreamObjectId, track, current: name === current };
}

describeGit("readTracking (T032)", () => {
  let counts: { h: GitHost; clone: string } | null = null;
  const countsFixture = () => {
    if (counts === null) {
      const h = hostFor("t032-counts");
      counts = { h, clone: buildCounts(h).clone };
    }
    return counts;
  };

  caseTest(TASK, "every count fixture entry equals rev-list --left-right --count; none, gone, a missing remote, slashes, and the 20,000-commit branch stay exact", SHELL, async () => {
    const { h, clone } = countsFixture();
    await withSync("t032-counts", async (service) => {
      const from = service.runner.calls.length;
      const { response } = await readTracking(service, clone);
      expect({ state: response.state, code: response.code }).toEqual({ state: "succeeded", code: undefined });
      const entries = byName(response.result!.entries);
      const names = Object.keys(refMap(h, clone, ["refs/heads"])).map((r) => r.slice("refs/heads/".length));
      expect(Object.keys(entries).sort()).toEqual(names.sort());
      for (const name of names) expect({ name, entry: entries[name] }).toEqual({ name, entry: oracleEntry(h, clone, name, "main") });
      // The constants of the fixture spec, as a second oracle.
      for (const [name, c] of Object.entries(COUNT_BRANCHES)) expect({ name, track: entries[name]!.track }).toEqual({ name, track: { state: "counts", ahead: c.ahead, behind: c.behind } });
      expect(entries.unrelated!.track).toEqual({ state: "counts", ahead: 1, behind: UNRELATED_COMMITS });
      expect(entries["no-upstream"]).toMatchObject({ upstream: null, upstreamObjectId: null, track: { state: "none" } });
      expect(entries.gone).toMatchObject({ upstream: `refs/remotes/${COUNT_UNTRACKED.gone.remote}/gone`, upstreamObjectId: null, track: { state: "gone" } });
      // Research R16 j: `%(upstream)` is empty for an unconfigured remote. The review names `remote-missing` (plan.md "Further reviewer defaults").
      expect(entries["ghost-remote"]).toMatchObject({ upstream: null, upstreamObjectId: null, track: { state: "none" } });
      expect(entries["feature/x"]).toMatchObject({ upstream: "refs/remotes/team/up/feature/x" });
      expect(response.result!.entries.filter((e) => e.current).map((e) => e.name)).toEqual(["main"]);
      expect(remoteCalls(service, from)).toEqual([]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "a detached HEAD gives no current entry", SHELL, async () => {
    const { h, clone } = countsFixture();
    const copy = `${h.root}/detached`;
    h.copy(clone, copy);
    gitRun(h, copy, ["checkout", "-q", "--detach", "HEAD"]);
    await withSync("t032-detached", async (service) => {
      const { response } = await readTracking(service, copy);
      expect(response.state).toBe("succeeded");
      expect(response.result!.entries.filter((e) => e.current)).toEqual([]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "the 200-branch fixture uses one for-each-ref process, and every entry equals its fixture count", SHELL, async () => {
    const h = hostFor("t032-many");
    const { clone } = buildMany(h);
    await withSync("t032-many", async (service) => {
      const { response, operationId } = await readTracking(service, clone);
      expect(response.state).toBe("succeeded");
      const entries = byName(response.result!.entries);
      for (let i = 0; i < MANY_BRANCHES; i++) {
        const [ahead, behind] = manyCounts(i);
        expect({ i, track: entries[manyName(i)]!.track }).toEqual({ i, track: { state: "counts", ahead, behind } });
      }
      const calls = callsOf(service, operationId);
      expect(calls.filter((c) => subcommandOf(c.arguments) === "for-each-ref").map((c) => c.arguments)).toEqual([
        ["--no-lazy-fetch", "--no-optional-locks", "for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(HEAD)", "refs/heads", "refs/remotes"],
      ]);
      expect(calls.every((c) => c.environmentPolicy === "read")).toBe(true);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "a record that breaks a contract check gives MALFORMED_GIT_OUTPUT, and more than REF_LISTING_RECORDS records give OUTPUT_LIMIT", SHELL, async () => {
    const { clone } = countsFixture();
    const oid = "a".repeat(40);
    const isTracking = (args: readonly string[]) => args.some((a) => a.includes("%(upstream:track,nobracket)"));
    await withSync("t032-bounds", async (service) => {
      const cases: [string, string][] = [
        ["four fields", `refs/heads/a\0${oid}\0\0 \n`],
        ["no final LF", `refs/heads/a\0${oid}\0\0\0 `],
        ["other namespace", `refs/tags/a\0${oid}\0\0\0 \n`],
        ["short OID", `refs/heads/a\0${oid.slice(1)}\0\0\0 \n`],
        ["track without upstream", `refs/heads/a\0${oid}\0\0ahead 1\0 \n`],
        ["track grammar", `refs/heads/a\0${oid}\0refs/remotes/o/a\0ahead 01\0 \n`],
        ["two current", `refs/heads/a\0${oid}\0\0\0*\nrefs/heads/b\0${oid}\0\0\0*\n`],
        ["current remote", `refs/remotes/o/a\0${oid}\0\0\0*\n`],
      ];
      for (const [name, bytes] of cases) {
        service.runner.inject.stdout = (call) => (isTracking(call.arguments) ? new TextEncoder().encode(bytes) : undefined);
        const { response } = await readTracking(service, clone);
        expect({ name, state: response.state, code: response.code }).toEqual({ name, state: "failed", code: "MALFORMED_GIT_OUTPUT" });
      }
      const many = Array.from({ length: REF_LISTING_RECORDS + 1 }, (_, i) => `refs/heads/b${i}\0${oid}\0\0\0 \n`).join("");
      service.runner.inject.stdout = (call) => (isTracking(call.arguments) ? new TextEncoder().encode(many) : undefined);
      const { response } = await readTracking(service, clone);
      expect({ state: response.state, code: response.code, completeness: response.result?.completeness }).toEqual({
        state: "limited",
        code: "OUTPUT_LIMIT",
        completeness: { state: "limited", code: "OUTPUT_LIMIT", reason: "REF_LISTING_RECORDS" },
      });
      service.runner.inject.stdout = undefined;
    });
  }, TIMEOUT_MS);
});
