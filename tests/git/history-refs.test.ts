// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T023: the ref capture and the row labels of a history view (plan.md P3; contract Δ3 `openHistory`; data-model §2).
// Spec FR-001, FR-047, FR-048, FR-049, FR-050, SC-015.

import { describe, expect } from "bun:test";
import { printOrigin } from "../origin";
import { FIXTURE_ROOT, useFixtureRoot } from "./fixture-root";
import { buildSmallFixtures, repositoryDigest, startPoints, type SmallFixture, type SmallName } from "./history-fixtures";
import { allRows, commitGraphFiles, git, gitPath, gitText, load, opened, openView, oracle, rows as readRows, type ViewRow } from "./history-view-harness";
import { caseTest, openService, type Service } from "./service-harness";

printOrigin("../../src/git-service/history-view.ts", import.meta.dir);
printOrigin("../../src/git-service/refs-parser.ts", import.meta.dir);

const TASK = "T023";
const SHELL = ["shell-double"] as const;
const TIMEOUT_MS = 300_000;
const KINDS: [string, string][] = [
  ["refs/heads/", "branch"],
  ["refs/remotes/", "remote"],
  ["refs/tags/", "tag"],
];

useFixtureRoot();

async function withService(name: string, body: (service: Service) => Promise<void>): Promise<void> {
  const service = await openService({ git: gitPath(), name, watchHints: false });
  try {
    await body(service);
  } finally {
    await service.dispose();
  }
}

const small = (folder: string, name: SmallName) => buildSmallFixtures(gitPath(), folder, [name])[0]!;

// The FR-047 labels as Git gives them: each non-symbolic ref of the namespaces whose object peels to a commit, on that commit.
function expectedLabels(repo: string): string[] {
  const listed = gitText(repo, ["--no-optional-locks", "for-each-ref", "--format=%(refname)%00%(symref)", "refs/heads", "refs/remotes", "refs/tags", "refs/stash"])
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.split("\0") as [string, string])
    .filter(([name, symref]) => symref === "" && !name.startsWith("refs/stash/"));
  const peeled = gitText(repo, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: Buffer.from(listed.map(([name]) => `${name}^{}\n`).join("")) })
    .split("\n")
    .filter((l) => l !== "");
  return listed.flatMap(([name], i) => {
    const [oid, type] = peeled[i]!.split(" ");
    if (type !== "commit") return [];
    const kind = name === "refs/stash" ? ["refs/", "stash"] : KINDS.find(([prefix]) => name.startsWith(prefix))!;
    return [`${oid} ${kind[1]} ${name.slice(kind[0]!.length)}`];
  });
}

const labelsOf = (rows: readonly ViewRow[]) => rows.flatMap((r) => r.labels.map((l) => `${r.oid} ${l.kind} ${l.name}`));

async function viewOf(service: Service, fixture: SmallFixture, scope: "all" | "current" = "all"): Promise<{ rows: ViewRow[]; repositoryId: string; generation: number }> {
  const { repositoryId, generation } = await service.register(fixture.repo);
  const view = await opened(service, repositoryId, generation, scope);
  const loaded = await load(service, repositoryId, view.viewId, { end: true });
  expect(loaded.state).toBe("succeeded");
  return { rows: await allRows(service, repositoryId, view.viewId, loaded.result!.rows), repositoryId, generation };
}

describe("SC-015: the all-branches view (contract Δ3 capture)", () => {
  for (const name of ["tag-chains", "tag-tree-blob", "stash", "notes", "pull-ref", "remote-head", "tips-50", "criss-cross"] as const) {
    caseTest(
      TASK,
      `${name}: the rows are Git's commits of the FR-047 set, each label sits on Git's commit for its ref, and the repository bytes stay equal`,
      SHELL,
      () =>
        withService(`t023-${name}`, async (service) => {
          const fixture = small(`t023-${name}`, name);
          const before = repositoryDigest(fixture.repo);
          const { rows } = await viewOf(service, fixture);
          expect(rows.map((r) => ({ oid: r.oid, parents: r.parents }))).toEqual(oracle(fixture.repo, startPoints(gitPath(), FIXTURE_ROOT, fixture.repo)));
          expect(labelsOf(rows).sort()).toEqual(expectedLabels(fixture.repo).sort());
          expect(rows.filter((r) => r.checkout).map((r) => r.oid)).toEqual([fixture.expect.headOid!]);
          expect(repositoryDigest(fixture.repo)).toBe(before);
          expect(commitGraphFiles(fixture.repo)).toEqual([]);
        }),
      TIMEOUT_MS,
    );
  }

  caseTest(
    TASK,
    "a tag chain labels its end commit, several refs on one commit give one row with all labels, and a tag to a tree or a blob adds no row and no label",
    SHELL,
    () =>
      withService("t023-tags", async (service) => {
        const chains = small("t023-tags", "tag-chains");
        const { rows } = await viewOf(service, chains);
        const at = (mark: number) => rows.filter((r) => r.oid === chains.oids.get(mark));
        expect(at(2).map((r) => r.labels.map((l) => l.name).sort())).toEqual([["v1", "v1-outer", "v1-outer-outer"]]);
        expect(at(4).map((r) => r.labels.map((l) => `${l.kind} ${l.name}`).sort())).toEqual([["branch main", "tag also-4", "tag v4"]]);
        const trees = small("t023-tree-blob", "tag-tree-blob");
        const other = await viewOf(service, trees);
        expect(other.rows.map((r) => r.oid)).toEqual([trees.oids.get(2)!, trees.oids.get(1)!]);
        expect(labelsOf(other.rows)).toEqual([`${trees.oids.get(2)} branch main`]);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "the notes ref, refs/pull/1/head, and the older stash entries add no row, and the stash shows as kind stash",
    SHELL,
    () =>
      withService("t023-hidden", async (service) => {
        for (const [name, marks] of [
          ["notes", [4]],
          ["pull-ref", [4]],
          ["stash", [4, 5]],
        ] as const) {
          const fixture = small(`t023-hidden-${name}`, name);
          const { rows } = await viewOf(service, fixture);
          const oids = new Set(rows.map((r) => r.oid));
          expect({ name, shown: marks.filter((m) => oids.has(fixture.oids.get(m)!)) }).toEqual({ name, shown: [] });
          if (name === "stash") expect(rows.find((r) => r.oid === fixture.oids.get(7))!.labels).toEqual([{ kind: "stash", name: "stash", invalidUtf8: false }]);
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a symbolic remote HEAD ref adds no label, and the R13 facts are recorded",
    SHELL,
    () =>
      withService("t023-symbolic", async (service) => {
        const fixture = small("t023-symbolic", "remote-head");
        const { rows } = await viewOf(service, fixture);
        expect(labelsOf(rows).filter((l) => l.endsWith(" origin/HEAD"))).toEqual([]);
        expect(labelsOf(rows).filter((l) => l.endsWith(" remote origin/main"))).toEqual([`${fixture.oids.get(4)} remote origin/main`]);
        // Research R13: `%(objectname)` of a symbolic ref.
        const symbolic = gitText(fixture.repo, ["for-each-ref", "--format=%(objectname)", "refs/remotes/origin/HEAD"]).trim();
        const target = gitText(fixture.repo, ["rev-parse", "refs/remotes/origin/main"]).trim();
        console.log(`OBSERVATION ${TASK}: %(objectname) of the symbolic ref refs/remotes/origin/HEAD ${symbolic === target ? "gives" : "does not give"} the target OID (experiment)`);
        // Research R13: the pattern `refs/stash` and `refs/stash/x`. The view skips such a record.
        const tree = gitText(fixture.repo, ["rev-parse", "HEAD^{tree}"]).trim();
        const hidden = gitText(fixture.repo, ["commit-tree", "-m", "only refs/stash/x", tree]).trim();
        git(fixture.repo, ["update-ref", "refs/stash/x", hidden]);
        const listed = gitText(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/stash"]).split("\n").filter((l) => l !== "");
        console.log(`OBSERVATION ${TASK}: the for-each-ref pattern refs/stash ${listed.includes("refs/stash/x") ? "matches" : "does not match"} refs/stash/x (experiment)`);
        const again = await viewOf(service, fixture);
        expect(again.rows.some((r) => r.oid === hidden)).toBe(false);
        expect(labelsOf(again.rows).filter((l) => l.includes("stash"))).toEqual([]);
      }),
    TIMEOUT_MS,
  );
});

describe("checkout, scope, and the ref bound (spec FR-048, FR-049)", () => {
  caseTest(
    TASK,
    "a detached HEAD marks its row",
    SHELL,
    () =>
      withService("t023-detached", async (service) => {
        const fixture = small("t023-detached", "detached");
        const { rows } = await viewOf(service, fixture);
        expect(rows.filter((r) => r.checkout).map((r) => r.oid)).toEqual([fixture.oids.get(2)!]);
        expect(labelsOf(rows)).toEqual([`${fixture.oids.get(3)} branch main`]);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "the current-branch view holds exactly git rev-list HEAD and shows the FR-047 labels, and a scope switch opens a new view with a new ref set",
    SHELL,
    () =>
      withService("t023-current", async (service) => {
        const fixture = small("t023-current", "tips-50");
        const head = fixture.expect.headOid!;
        const { repositoryId, generation } = await service.register(fixture.repo);
        const all = await opened(service, repositoryId, generation, "all");
        expect(all.startCount).toBe(50);
        const current = await opened(service, repositoryId, generation, "current");
        expect({ scope: current.scope, startCount: current.startCount }).toEqual({ scope: "current", startCount: 1 });
        await load(service, repositoryId, current.viewId, { end: true });
        const expected = oracle(fixture.repo, [head]);
        const rows = await allRows(service, repositoryId, current.viewId, expected.length);
        expect(rows.map((r) => ({ oid: r.oid, parents: r.parents }))).toEqual(expected);
        expect(labelsOf(rows).sort()).toEqual(expectedLabels(fixture.repo).filter((l) => rows.some((r) => l.startsWith(`${r.oid} `))).sort());
        expect(rows[0]!.checkout).toBe(true);
        // A scope switch captures the refs again.
        git(fixture.repo, ["update-ref", "refs/heads/new", head]);
        const switched = await opened(service, repositoryId, generation, "all");
        expect(switched.viewId).not.toBe(current.viewId);
        expect(switched.refsDigest).not.toBe(all.refsDigest);
        await load(service, repositoryId, switched.viewId, { row: 0 });
        const tip = await readRows(service, repositoryId, switched.viewId, { oid: head }, 1);
        expect(tip.result!.rows![0]!.labels.map((l) => l.name)).toContain("new");
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "the 10,001-ref fixture gives OUTPUT_LIMIT with reason REF_LISTING_RECORDS and no view",
    SHELL,
    () =>
      withService("t023-many", async (service) => {
        const fixture = small("t023-many", "refs-10001");
        const { repositoryId, generation } = await service.register(fixture.repo);
        const response = await openView(service, repositoryId, generation);
        expect({ state: response.state, code: response.code, result: response.result as unknown }).toEqual({ state: "limited", code: "OUTPUT_LIMIT", result: { reason: "REF_LISTING_RECORDS" } });
      }),
    TIMEOUT_MS,
  );
});
