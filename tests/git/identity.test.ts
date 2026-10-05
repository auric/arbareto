// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { RunnerRefusal, type GitRunner, type ProcessContext } from "../../src/git-service/git-runner";
import { IDENTITY_REMEDY, requestIdentities, sameIdentity } from "../../src/git-service/identity";
import { createBunRunner, type BunRunner } from "./bun-runner";
import { FIXTURE_ROOT, fixtureDir, fixtureGit, serviceEnv, useFixtureRoot } from "./fixture-root";
import { buildF07 } from "./fixtures";
import { describeGit } from "./git-binary";
import { missingCapability } from "./service-harness";

const IDENTITY_MODULE = printOrigin("../../src/git-service/identity.ts", import.meta.dir);
printOrigin("../../src/git-service/git-runner.ts", import.meta.dir);

useFixtureRoot();

const id = () => crypto.randomUUID();
const F07_TIMEOUT_MS = 120_000;
const REFUSED = { ok: false, code: "UNSUPPORTED_REPOSITORY", remedy: "Open the repository from an NTFS or ReFS volume" } as const;

describeGit(
  "T077 identity requests (contract §6 \"Registration bootstrap\")",
  (git) => {
    let runner: BunRunner;
    let gitInstallationId: string;
    let repo: string;

    // The double binds one operation to each context, so each request gets a new context.
    const discovery = (path: string): { operationId: string; context: ProcessContext } => ({
      operationId: id(),
      context: { contextKind: "repositoryDiscovery", bootstrapId: runner.addContext("repositoryDiscovery", path), gitInstallationId },
    });
    const request = (path: string, paths: string[]) => {
      const { operationId, context } = discovery(path);
      return requestIdentities(runner, operationId, context, paths);
    };
    // The Git-resolved worktree root, Git directory, and common directory.
    const resolved = (dir: string) => fixtureGit(git, dir, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"]).trimEnd().split("\n");

    beforeAll(async () => {
      repo = fixtureDir("repo");
      fixtureGit(git, repo, ["init", "-q"]);
      runner = createBunRunner({ git, directory: fixtureDir("runner"), environment: serviceEnv() });
      gitInstallationId = id();
      const probe = runner.addContext("gitProbe", git);
      expect(await runner.register({ operationId: id(), bootstrapId: probe, gitInstallationId, version: "2.55.0", digest: "c".repeat(64), confirm: false })).toEqual({ result: "approved" });
    });

    afterAll(async () => {
      await runner.dispose();
    });

    test("one request returns the shell identity of each Git-resolved path in order", async () => {
      const paths = resolved(repo);
      const result = await request(repo, paths);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.identities.length).toBe(paths.length);
      expect(sameIdentity(result.identities[1]!, result.identities[2]!)).toBe(true);
      expect(sameIdentity(result.identities[0]!, result.identities[1]!)).toBe(false);
      expect(runner.identityCalls.at(-1)!.paths).toEqual(paths);
    });

    test("an identity comes only from the shell reply, never from fs.stat", async () => {
      // No file exists at this path, so only the injected reply can name it.
      const absent = join(repo, "absent");
      const injected = { volumeSerial: "0123456789abcdef", fileId: "0123456789abcdef0123456789abcdef" };
      runner.inject.identities.set(absent, injected);
      try {
        expect(await request(repo, [absent])).toEqual({ ok: true, identities: [injected] });
      } finally {
        runner.inject.identities.delete(absent);
      }
      const source = new Bun.Transpiler({ loader: "ts" }).transformSync(readFileSync(IDENTITY_MODULE, "utf8"));
      expect(source).not.toMatch(/node:fs|\bstat|Bun\.file/);
    });

    for (const [label, fileId] of [
      ["all-zero", "0".repeat(32)],
      ["all-ones", "f".repeat(32)],
    ] as const) {
      test(`an ${label} file ID in a shell reply gives UNSUPPORTED_REPOSITORY with the NTFS or ReFS remedy`, async () => {
        const [root, gitDirectory] = resolved(repo);
        runner.inject.identities.set(gitDirectory!, { volumeSerial: "0123456789abcdef", fileId });
        try {
          expect(await request(repo, [root!, gitDirectory!])).toEqual(REFUSED);
        } finally {
          runner.inject.identities.delete(gitDirectory!);
        }
      });
    }

    test("a refused identity entry gives UNSUPPORTED_REPOSITORY", async () => {
      expect(await request(repo, [join(repo, "absent")])).toEqual(REFUSED);
    });

    test("a malformed entry or a reply of the wrong length gives UNSUPPORTED_REPOSITORY", async () => {
      const replying = (replies: unknown[]) => ({ ...runner, identities: async () => replies }) as unknown as GitRunner;
      const { operationId, context } = discovery(repo);
      expect(await requestIdentities(replying([{ volumeSerial: "0123456789abcdef" }]), operationId, context, [repo])).toEqual(REFUSED);
      expect(await requestIdentities(replying([]), operationId, context, [repo])).toEqual(REFUSED);
      expect(IDENTITY_REMEDY).toBe(REFUSED.remedy);
    });

    test("a runner refusal keeps its own code", async () => {
      const refusing = { ...runner, identities: async () => Promise.reject(new RunnerRefusal("GIT_CHANGED")) } as unknown as GitRunner;
      const { operationId, context } = discovery(repo);
      await expect(requestIdentities(refusing, operationId, context, [repo])).rejects.toMatchObject({ code: "GIT_CHANGED" });
      const unknown: ProcessContext = { contextKind: "repositoryDiscovery", bootstrapId: id(), gitInstallationId };
      await expect(requestIdentities(runner, id(), unknown, [repo])).rejects.toMatchObject({ code: "UNKNOWN_TARGET" });
      await expect(request(repo, Array(9).fill(repo))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    });

    test("F07: a junction alias gives the identities of its target", async () => {
      const built = buildF07(git, "t077-f07-junction");
      const aliases = built.facts.notes.junctions as Record<string, string> | undefined;
      if (aliases === undefined) {
        console.log("OBSERVATION T077: F07 junction unverified, because the host refused the junction.");
        return;
      }
      for (const [alias, target] of Object.entries(aliases)) {
        const aliasDir = join(built.root, alias);
        const targetDir = join(built.root, target);
        const viaAlias = resolved(aliasDir);
        const viaTarget = resolved(targetDir);
        const a = await request(aliasDir, [aliasDir, ...viaAlias]);
        const t = await request(targetDir, [targetDir, ...viaTarget]);
        if (!a.ok || !t.ok) throw new Error(`identity refused for ${alias}`);
        const equal = a.identities.map((identity, i) => sameIdentity(identity, t.identities[i]!));
        console.log(`OBSERVATION T077: F07 ${alias} -> ${target}: Git resolved ${JSON.stringify(viaAlias)} through the alias and ${JSON.stringify(viaTarget)} through the target.`);
        console.log(`OBSERVATION T077: F07 ${alias} identities ${JSON.stringify(a.identities)}, ${target} identities ${JSON.stringify(t.identities)}, equal ${JSON.stringify(equal)}.`);
        expect({ alias, equal }).toEqual({ alias, equal: equal.map(() => true) });
      }
      console.log(`OBSERVATION T077: the fixture root is ${FIXTURE_ROOT}.`);
    }, F07_TIMEOUT_MS);
  },
  missingCapability("shell-double"),
);
