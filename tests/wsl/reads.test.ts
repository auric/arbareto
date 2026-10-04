// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T208: WSL reads through the public operations (contract §3, §11). Every case needs Git 2.55.0 in the distro.

import { afterEach, describe, expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import { createBunRunner, type BunRunner } from "../git/bun-runner";
import { fixtureDir, serviceEnv, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { buildF21, buildF25, buildF26, distroGit, globalConfig, startSession, writeLinux, type WslSession } from "./fixtures";
import { inDistro, uncPath, useWslFolder, wslTest, type WslCapability, type WslHost } from "./wsl-host";

const CASE_TIMEOUT_MS = 180_000;
const NEEDS: WslCapability[] = ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "distro-git-2.55"];
// The service environment of the T208 environment case. WSL forwards only the names that `WSLENV` holds (research R13 P4).
const CANARY_ENV = { WSLENV: "GIT_TRACE/u:GIT_ARBARETO_CANARY/u", GIT_TRACE: "1", GIT_ARBARETO_CANARY: "1", GIT_DIR: "C:\\arbareto-canary-git-dir" };

useFixtureRoot();
useWslFolder();

let runners: BunRunner[] = [];
afterEach(async () => {
  for (const runner of runners) await runner.dispose();
  runners = [];
});

function setup(host: WslHost, environment = serviceEnv()): { runner: BunRunner; s: WslSession } {
  const runner = createBunRunner({ git: GIT ?? "git", directory: fixtureDir(`runner-${crypto.randomUUID()}`), environment, wslGlobalConfig: globalConfig(host) });
  runners.push(runner);
  return { runner, s: startSession(runner) };
}

interface Workspace {
  repositoryId: string;
  generation: number;
}

async function register(s: WslSession, path: string): Promise<Workspace> {
  const response = await s.response(s.chooseRepository(path));
  expect(response).toMatchObject({ state: "succeeded" });
  return response.result as unknown as Workspace;
}

async function read(s: WslSession, w: Workspace, operation: string, payload: object = {}, generation = false) {
  const extra = { repositoryId: w.repositoryId, ...(generation ? { repositoryGeneration: w.generation } : {}) };
  return s.response(s.request(operation, payload, extra));
}

async function approve(s: WslSession, w: Workspace): Promise<void> {
  const trust = await read(s, w, "readTrust");
  const fingerprint = (trust.result as { fingerprint: string }).fingerprint;
  expect(await read(s, w, "approveTrust", { fingerprint, approve: true }, true)).toMatchObject({ state: "succeeded" });
}

const sortedLines = (text: string) => text.split("\n").filter((l) => l !== "").sort();

describe("WSL reads (T208)", () => {
  wslTest(
    "F21 status, history, comparisons, and the trust listing equal the distro Git's own output",
    NEEDS,
    async (host) => {
      const f21 = buildF21(host);
      const { s } = setup(host);
      const w = await register(s, f21.paths[1]!);
      const status = await read(s, w, "readWorkspace", { refresh: false, check: "full" });
      expect(status).toMatchObject({ state: "succeeded" });
      const text = JSON.stringify(status.result);
      const own = distroGit(f21.repo, ["status", "--porcelain=v2", "--untracked-files=all"]);
      for (const line of sortedLines(own)) expect(text).toContain(line.split(" ").at(-1)!);
      const history = await read(s, w, "readHistory", {}, true);
      expect(history).toMatchObject({ state: "succeeded" });
      for (const oid of sortedLines(distroGit(f21.repo, ["rev-list", "HEAD"]))) expect(JSON.stringify(history.result)).toContain(oid);
      const entry = (status.result as { entries: { entryId: string; path: string }[]; snapshotId: string }).entries.find((e) => e.path === "multi.txt");
      const comparison = await read(s, w, "readComparison", { snapshotId: (status.result as { snapshotId: string }).snapshotId, entryId: entry!.entryId }, true);
      expect(comparison).toMatchObject({ state: "succeeded" });
      const hunks = sortedLines(distroGit(f21.repo, ["diff", "--no-ext-diff", "--no-textconv", "--", "multi.txt"])).filter((l) => l.startsWith("@@"));
      expect((comparison.result as { hunks: unknown[] }).hunks).toHaveLength(hunks.length);
      const trust = await read(s, w, "readTrust");
      const keys = sortedLines(distroGit(f21.repo, ["config", "--list", "--name-only", "--show-scope"])).map((l) => l.split("\t").at(-1)!);
      for (const key of keys) expect(JSON.stringify(trust.result)).toContain(key);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "program-file digests read the file through the UNC path, and an edit gives TRUST_CHANGED",
    NEEDS,
    async (host) => {
      const f25 = buildF25(host);
      const { s } = setup(host);
      const w = await register(s, uncPath(host, f25.filter.dir));
      expect(await read(s, w, "readWorkspace", { refresh: false, check: "full" })).toMatchObject({ code: "TRUST_REQUIRED" });
      await approve(s, w);
      expect(await read(s, w, "readWorkspace", { refresh: false, check: "full" })).toMatchObject({ state: "succeeded" });
      writeLinux(host, `${f25.filter.dir}/clean.sh`, "#!/bin/sh\nexec cat\n", "755");
      expect(await read(s, w, "readWorkspace", { refresh: false, check: "full" })).toMatchObject({ code: "TRUST_CHANGED" });
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "a bare-name program resolves through the Linux PATH without .exe",
    NEEDS,
    async (host) => {
      const f25 = buildF25(host);
      distroGit(f25.filter, ["config", "filter.canary.clean", "arbareto-bare-canary"]);
      const { s } = setup(host);
      const w = await register(s, uncPath(host, f25.filter.dir));
      const listing = JSON.stringify((await read(s, w, "readTrust")).result);
      const entries = (host.probe.pathEnv ?? "").split(":").filter((e) => e.startsWith("/"));
      for (const entry of entries) expect(listing).toContain(`${entry}/arbareto-bare-canary`);
      expect(listing).not.toContain("arbareto-bare-canary.exe");
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "no Windows variable of the service environment reaches Linux Git, also one that WSLENV names",
    NEEDS,
    async (host) => {
      const f25 = buildF25(host);
      const log = `${f25.filter.dir}/../filter-env.log`;
      writeLinux(host, `${f25.filter.dir}/clean.sh`, `#!/bin/sh\nenv > '${log}'\nexec cat\n`, "755");
      const { s } = setup(host, serviceEnv(CANARY_ENV));
      const w = await register(s, uncPath(host, f25.filter.dir));
      await approve(s, w);
      expect(await read(s, w, "readWorkspace", { refresh: true, check: "full" })).toMatchObject({ state: "succeeded" });
      const env = inDistro(host.distro, ["/usr/bin/cat", "--", log]);
      console.log(`OBSERVATION T208: filter environment names ${sortedLines(env).map((l) => l.split("=")[0]).join(" ")}`);
      expect(env).not.toMatch(/^GIT_TRACE=/m);
      expect(env).not.toMatch(/^GIT_ARBARETO_CANARY=/m);
      expect(env).not.toContain(CANARY_ENV.GIT_DIR);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "an entry with \\ in its Linux name gets reason path",
    NEEDS,
    async (host) => {
      if (GIT === null) throw new Error("F26 needs the Windows Git");
      const f26 = buildF26(host, GIT);
      const { s } = setup(host);
      const w = await register(s, f26.entries.path);
      const status = await read(s, w, "readWorkspace", { refresh: false, check: "full" });
      const result = status.result as { entries: { entryId: string; path: string }[]; snapshotId: string };
      const entry = result.entries.find((e) => e.path === f26.entries.entry);
      expect(entry).toBeDefined();
      const comparison = await read(s, w, "readComparison", { snapshotId: result.snapshotId, entryId: entry!.entryId }, true);
      expect(comparison.result).toMatchObject({ supportDecision: "path", fileActionDecision: "path" });
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "the candidate of a read never exists, and no watcher starts for a WSL workspace",
    NEEDS,
    async (host) => {
      const f21 = buildF21(host);
      const watch = spyOn(fs, "watch");
      try {
        const { s } = setup(host);
        const w = await register(s, f21.paths[0]!);
        await read(s, w, "readWorkspace", { refresh: true, check: "full" });
        await read(s, w, "readHistory", {}, true);
        const gitDir = distroGit(f21.repo, ["rev-parse", "--absolute-git-dir"]).trim();
        const names = inDistro(host.distro, ["/usr/bin/ls", "-A", "--", gitDir]);
        expect(names).not.toContain("arbareto-candidate-");
        expect(watch).not.toHaveBeenCalled();
      } finally {
        watch.mockRestore();
      }
    },
    CASE_TIMEOUT_MS,
  );
});

