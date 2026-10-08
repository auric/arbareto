// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T326: the index-hash gate of WSL reads (contract §11 "Change polling", §6 "Index digest in a read"). Every case needs Git 2.55.0 in the distro.

import { afterEach, describe, expect } from "bun:test";
import type { IndexedFileFactsRequest, WslIndexResult } from "../../src/git-service/git-runner";
import { readRawIndex } from "../../src/git-service/status";
import { createBunRunner, type BunRunner } from "../git/bun-runner";
import { fixtureDir, serviceEnv, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { buildF21, distroGit, globalConfig, startSession, writeLinux, type WslSession } from "./fixtures";
import { useWslFolder, wslTest, type WslCapability, type WslHost } from "./wsl-host";

const CASE_TIMEOUT_MS = 180_000;
const NEEDS: WslCapability[] = ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "distro-git-2.55"];

useFixtureRoot();
useWslFolder();

let runners: BunRunner[] = [];
afterEach(async () => {
  for (const runner of runners) await runner.dispose();
  runners = [];
}, CASE_TIMEOUT_MS);

// `reads` counts the UNC reads of the index bytes. `digests` holds the `index` of each `fileFacts` request and its result.
function setup(host: WslHost) {
  const runner = createBunRunner({ git: GIT ?? "git", directory: fixtureDir(`runner-${crypto.randomUUID()}`), environment: serviceEnv(), wslGlobalConfig: globalConfig(host) });
  runners.push(runner);
  const digests: { index: IndexedFileFactsRequest["index"]; result: WslIndexResult | "stop" }[] = [];
  const indexed = runner.indexedFileFacts;
  runner.indexedFileFacts = async (request, signal) => {
    const reply = await indexed(request, signal);
    digests.push({ index: request.index, result: "stop" in reply ? "stop" : reply.index });
    return reply;
  };
  const seam = { reads: 0 };
  const s = startSession(runner, {
    readRawIndex: (path) => {
      seam.reads++;
      return readRawIndex(path);
    },
  });
  return { s, seam, digests };
}

async function poll(s: WslSession, repositoryId: string) {
  return s.response(s.request("readWorkspace", { refresh: false, check: "full" }, { repositoryId }));
}

async function register(s: WslSession, path: string): Promise<string> {
  const response = await s.response(s.chooseRepository(path));
  expect(response).toMatchObject({ state: "succeeded" });
  return (response.result as { repositoryId: string }).repositoryId;
}

const ELIGIBLE = { state: "succeeded", result: { hunkEligibility: { eligible: true } } };
const SPLIT = { state: "succeeded", result: { hunkEligibility: { eligible: false, reason: "split-index" } } };

describe("WSL index-hash gate (T326)", () => {
  wslTest(
    "the second poll of an unchanged repository reads no index bytes through UNC",
    NEEDS,
    async (host) => {
      const f21 = buildF21(host);
      const { s, seam, digests } = setup(host);
      const id = await register(s, f21.paths[1]!);
      expect(await poll(s, id)).toMatchObject(ELIGIBLE);
      expect(seam.reads).toBe(1);
      expect(await poll(s, id)).toMatchObject(ELIGIBLE);
      expect(seam.reads).toBe(1);
      // Each read asks for the digest once, in its trust listing. No shared index exists, so no request names one.
      expect(digests.map((d) => d.index)).toEqual([{}, {}]);
      expect(digests.map((d) => d.result)).toEqual([expect.objectContaining({ kind: "index", index: expect.objectContaining({ kind: "digest" }) }), expect.anything()]);
      // The listing gives the other eligibility inputs, so a new hook changes the eligibility without an index read.
      writeLinux(host, `${f21.repo.dir}/.git/hooks/post-index-change`, "#!/bin/sh\n", "755");
      expect(await poll(s, id)).toMatchObject({ state: "succeeded", result: { hunkEligibility: { eligible: false, reason: "index-change-hook" } } });
      expect(seam.reads).toBe(1);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "a changed index reads the bytes through UNC again and gives the new eligibility",
    NEEDS,
    async (host) => {
      const f21 = buildF21(host);
      const { s, seam, digests } = setup(host);
      const id = await register(s, f21.paths[1]!);
      expect(await poll(s, id)).toMatchObject(ELIGIBLE);
      expect(seam.reads).toBe(1);
      // git-update-index(1) `--split-index` writes a `link` extension and a shared index file.
      distroGit(f21.repo, ["update-index", "--split-index"]);
      expect(await poll(s, id)).toMatchObject(SPLIT);
      expect(seam.reads).toBe(2);
      // The next request names the shared index of the last parse, and equal digests read nothing.
      expect(await poll(s, id)).toMatchObject(SPLIT);
      expect(seam.reads).toBe(2);
      const shared = digests.at(-1)!;
      expect(shared.index.sharedIndex).toMatch(/^[0-9a-f]{40}$/);
      expect(shared.result).toMatchObject({ kind: "index", index: { kind: "digest" }, sharedIndex: { kind: "digest" } });
      distroGit(f21.repo, ["update-index", "--no-split-index"]);
      expect(await poll(s, id)).toMatchObject(ELIGIBLE);
      expect(seam.reads).toBe(3);
    },
    CASE_TIMEOUT_MS,
  );
});
