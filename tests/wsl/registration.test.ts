// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T207: WSL registration through `chooseRepository` (contract §3, §11). `src/git-service/wsl.ts` (T212) serves it.
// The F24 floor case and the seam cases need no Git 2.55.0 (tasks.md "Test harness rules"). They run before the other cases.

import { afterEach, describe, expect } from "bun:test";
import { createCollector } from "../../src/git-service/git-runner";
import { createBunRunner, type BunRunner } from "../git/bun-runner";
import { fixtureDir, serviceEnv, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { printOrigin } from "../origin";
import { buildF21, buildF24, buildF26, globalConfig, seamProbe, startSession, type WslSession } from "./fixtures";
import { inDistro, listScopes, parseProbe, uncPath, useWslFolder, wslTest, type WslHost } from "./wsl-host";

printOrigin("../../src/git-service/git-runner.ts", import.meta.dir);

const CASE_TIMEOUT_MS = 180_000;
const MINIMUM = "2.55.0";

useFixtureRoot();
useWslFolder();

let runners: BunRunner[] = [];
afterEach(async () => {
  for (const runner of runners) await runner.dispose();
  runners = [];
});

function setup(host: WslHost): { runner: BunRunner; s: WslSession } {
  const runner = createBunRunner({
    git: GIT ?? "git",
    directory: fixtureDir(`runner-${crypto.randomUUID()}`),
    environment: serviceEnv(),
    wslGlobalConfig: globalConfig(host),
  });
  runners.push(runner);
  return { runner, s: startSession(runner) };
}

// Contract §11 "Process ownership": after each probe, no `arbareto-*` scope of the test remains.
function expectNoScope(host: WslHost): void {
  expect(listScopes(host)).toEqual([]);
}

describe("WSL registration (T207)", () => {
  wslTest(
    "F24: a distro Git below 2.55.0 gives GIT_UNSUPPORTED reason version, and no Git work starts",
    ["wsl-fixture-fs-id", "distro-git-below-2.55"],
    async (host) => {
      const f24 = buildF24(host);
      console.log(`OBSERVATION T207: F24 distro Git in ${host.distro}: ${f24.versionText}`);
      // The real probe through the double, before the service runs it.
      const observer = setup(host).runner;
      const bootstrapId = observer.addContext("repositoryDiscovery", f24.path);
      const stdout = createCollector({ maxBytes: 65536 });
      const stderr = createCollector({ maxBytes: 65536 });
      const exit = await observer.wslProbe({ operationId: crypto.randomUUID(), bootstrapId, distro: host.distro, limits: { deadlineMs: 60_000 }, stdout, stderr, signal: new AbortController().signal });
      const probe = parseProbe(new TextDecoder().decode(stdout.take()));
      console.log(`OBSERVATION T207: Git probe exit ${exit.exitCode}, git ${probe.paths.git}, ${probe.version}, gitfs ${probe.gitfs}, scope ${probe.scope}`);
      expect(exit.exitCode).toBe(0);
      const found = /^git version (\S+)$/.exec(probe.version ?? "")?.[1];
      expect(found).toBeDefined();

      const { runner, s } = setup(host);
      const response = await s.response(s.chooseRepository(f24.path));
      expect(response).toMatchObject({
        state: "failed",
        code: "GIT_UNSUPPORTED",
        result: { reason: "version", detectedVersion: found, minimumVersion: MINIMUM, text: `Git ${found} in ${host.distro} is older than 2.55.0. Install Git 2.55.0 or later in the distro.` },
      });
      // Only the probe ran. No confirmation, no Git registration, and no Git command.
      expect(runner.spawned).toBe(1);
      expect(runner.wslConfirmations).toEqual([]);
      expect(runner.wslSaved.size).toBe(0);
      expectNoScope(host);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "a distro name that the list does not name gives WSL_UNAVAILABLE reason distro-missing",
    [],
    async (host) => {
      const { runner, s } = setup(host);
      const missing = `arbareto-missing-${crypto.randomUUID().slice(0, 8)}`;
      const response = await s.response(s.chooseRepository(`\\\\wsl.localhost\\${missing}\\home`));
      expect(response).toMatchObject({
        state: "failed",
        code: "WSL_UNAVAILABLE",
        result: { reason: "distro-missing", text: `No registered WSL distro has the name ${missing}. Open the folder through a listed distro.` },
      });
      expect(runner.spawned).toBe(0);
      expectNoScope(host);
    },
    CASE_TIMEOUT_MS,
  );
});

describe("WSL registration seams (T207)", () => {
  const seamed = (host: WslHost, change: Parameters<typeof seamProbe>[1]) => {
    const pair = setup(host);
    pair.runner.inject.wslProbe = { stdout: seamProbe(host, change) };
    return pair;
  };
  const folder = (host: WslHost) => uncPath(host, host.folder);

  wslTest(
    "a probe without setsid gives WSL_UNAVAILABLE reason no-setsid with its remedy text",
    [],
    async (host) => {
      const { runner, s } = seamed(host, { version: `git version ${MINIMUM}`, absent: ["setsid"] });
      const response = await s.response(s.chooseRepository(folder(host)));
      expect(response).toMatchObject({
        state: "failed",
        code: "WSL_UNAVAILABLE",
        result: { reason: "no-setsid", text: `Arbareto needs the setsid program in ${host.distro}. Install the util-linux package in the distro, then open the folder again.` },
      });
      expect(runner.wslConfirmations).toEqual([]);
      expectNoScope(host);
    },
    CASE_TIMEOUT_MS,
  );

  for (const program of ["stat", "env"]) {
    wslTest(
      `a probe without /usr/bin/${program} gives WSL_UNAVAILABLE reason no-coreutils with its remedy text`,
      [],
      async (host) => {
        const { runner, s } = seamed(host, { version: `git version ${MINIMUM}`, absent: [program] });
        const response = await s.response(s.chooseRepository(folder(host)));
        expect(response).toMatchObject({
          state: "failed",
          code: "WSL_UNAVAILABLE",
          result: { reason: "no-coreutils", text: `Arbareto needs the stat and env programs in /usr/bin of ${host.distro}. Install the coreutils package in the distro, then open the folder again.` },
        });
        expect(runner.wslConfirmations).toEqual([]);
        expectNoScope(host);
      },
      CASE_TIMEOUT_MS,
    );
  }

  wslTest(
    "an identity probe with type 1021994 (tmpfs) gives UNSUPPORTED_REPOSITORY reason no-fs-uuid before any Git command",
    [],
    async (host) => {
      const { runner, s } = seamed(host, { version: `git version ${MINIMUM}` });
      runner.inject.wslStat.set(folder(host), { inode: "4242\n", fileSystem: "1021994:9a8b7c6d5e4f3021\n" });
      const response = await s.response(s.chooseRepository(folder(host)));
      expect(response).toMatchObject({
        state: "failed",
        code: "UNSUPPORTED_REPOSITORY",
        result: { reason: "no-fs-uuid", text: "Arbareto cannot read a file-system UUID for this folder. Open a folder on the distro's own disk." },
      });
      // Contract §6 "Registration bootstrap": the selected directory identity comes before execution.
      expect(runner.spawned).toBe(0);
      expect(runner.wslIdentityLog.map((e) => e.path)).toContain(folder(host));
      expectNoScope(host);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "a Git file identity with a type other than ef53 gives GIT_UNSUPPORTED reason no-fs-uuid",
    [],
    async (host) => {
      const { runner, s } = seamed(host, { version: `git version ${MINIMUM}`, gitfs: "1021994:9a8b7c6d5e4f3021" });
      const response = await s.response(s.chooseRepository(folder(host)));
      expect(response).toMatchObject({
        state: "failed",
        code: "GIT_UNSUPPORTED",
        result: { reason: "no-fs-uuid", text: `Arbareto cannot read a file-system UUID for Git in ${host.distro}. Install Git on the distro's own disk.` },
      });
      expect(runner.wslConfirmations).toEqual([]);
      expectNoScope(host);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "a stopped distro gives phase wsl-starting, and Cancel ends canceled with the workspace unchanged",
    [],
    async (host) => {
      const { runner, s } = seamed(host, { version: `git version ${MINIMUM}` });
      runner.inject.wslRunning = [];
      const release = runner.holdStart();
      const requestId = s.chooseRepository(folder(host));
      const deadline = Date.now() + 30_000;
      while (!s.progressOf(requestId).some((p) => p.phase === "wsl-starting") && Date.now() < deadline) await Bun.sleep(10);
      const starting = s.progressOf(requestId).find((p) => p.phase === "wsl-starting");
      expect(starting).toBeDefined();
      const cancel = s.request("cancel", { operationId: starting!.operationId });
      expect(await s.response(cancel)).toMatchObject({ state: "succeeded" });
      release();
      expect(await s.response(requestId)).toMatchObject({ state: "canceled", code: "CANCELED" });
      expect(runner.wslConfirmations).toEqual([]);
      expect(runner.wslSaved.size).toBe(0);
      expectNoScope(host);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "a probe past its deadline gives DEADLINE",
    [],
    async (host) => {
      const { runner, s } = setup(host);
      runner.inject.wslProbe = { deadline: true };
      expect(await s.response(s.chooseRepository(folder(host)))).toMatchObject({ state: "failed", code: "DEADLINE" });
      expectNoScope(host);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "a wsl.exe failure gives WSL_UNAVAILABLE reason start-failed with the bounded wsl.exe text",
    [],
    async (host) => {
      const { runner, s } = setup(host);
      // Research R13 P3: wsl.exe printed this text on stdout and exited with a nonzero status.
      const text = "There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n";
      runner.inject.wslProbe = { stdout: text, exitCode: 4294967295 };
      const response = await s.response(s.chooseRepository(folder(host)));
      expect(response).toMatchObject({
        state: "failed",
        code: "WSL_UNAVAILABLE",
        result: { reason: "start-failed", text: `WSL could not start distro ${host.distro}. Start it in a terminal, then open the folder again.` },
      });
      expect(String(response.result?.detail)).toContain("Wsl/Service/WSL_E_DISTRO_NOT_FOUND");
      expectNoScope(host);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "the WSL register carries only the context ID, the issued ID, and confirm, and the shell takes the Git from its own probe parse",
    ["systemd-user-manager", "setsid"],
    async (host) => {
      const { runner } = setup(host);
      const path = uncPath(host, host.folder);
      const probe = async (bootstrapId: string, operationId: string) => {
        const output = { stdout: createCollector({ maxBytes: 65536 }), stderr: createCollector({ maxBytes: 65536 }) };
        return runner.wslProbe({ operationId, bootstrapId, distro: host.distro, limits: { deadlineMs: 60_000 }, ...output, signal: new AbortController().signal });
      };
      const operationId = crypto.randomUUID();
      const bootstrapId = runner.addContext("repositoryDiscovery", path);
      // A register before any probe has no bound facts.
      await expect(runner.register({ operationId, bootstrapId, gitInstallationId: crypto.randomUUID(), confirm: true } as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      runner.inject.wslProbe = { stdout: seamProbe(host) };
      expect(await probe(bootstrapId, operationId)).toMatchObject({ exitCode: 0 });
      // A Linux program path from the service is refused.
      const programs = { distro: host.distro, git: "/tmp/evil", systemdRun: "/tmp/evil", systemctl: "/tmp/evil", setsid: "/tmp/evil" };
      await expect(runner.register({ operationId, bootstrapId, gitInstallationId: crypto.randomUUID(), confirm: true, wsl: programs } as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(runner.wslConfirmations).toEqual([]);
      const gitInstallationId = crypto.randomUUID();
      expect(await runner.register({ operationId, bootstrapId, gitInstallationId, confirm: true } as never)).toEqual({ result: "approved" });
      expect(runner.wslConfirmations).toEqual([{ distro: host.distro, path: host.probe.paths.git, version: host.gitVersion ?? "" }]);
      expect(runner.wslSaved.get(host.guid)).toEqual({
        distro: host.distro,
        git: host.probe.paths.git,
        version: host.gitVersion ?? "",
        gitIdentity: `${host.probe.gitfs?.split(":")[1]}:${host.probe.gitfile}`,
      });
      // A probe that fails a contract §11 rule binds nothing.
      const other = crypto.randomUUID();
      const unbound = runner.addContext("repositoryDiscovery", path);
      runner.inject.wslProbe = { stdout: seamProbe(host, { absent: ["setsid"] }) };
      expect(await probe(unbound, other)).toMatchObject({ exitCode: 0 });
      await expect(runner.register({ operationId: other, bootstrapId: unbound, gitInstallationId: crypto.randomUUID(), confirm: true } as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(runner.wslConfirmations).toHaveLength(1);
    },
    CASE_TIMEOUT_MS,
  );
});

describe("WSL registration with Git 2.55.0 (T207)", () => {
  wslTest(
    "F21 through both prefixes, an upper-case prefix, and a lower-case distro name gives one repositoryId and one worktreeKey",
    ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "distro-git-2.55"],
    async (host) => {
      const f21 = buildF21(host);
      const { runner, s } = setup(host);
      const results = [];
      for (const path of f21.paths) {
        const response = await s.response(s.chooseRepository(path));
        expect(response).toMatchObject({ state: "succeeded" });
        results.push(response.result as { repositoryId: string; worktreeKey: string });
      }
      expect(new Set(results.map((r) => r.repositoryId)).size).toBe(1);
      expect(new Set(results.map((r) => r.worktreeKey)).size).toBe(1);
      expect(results[0]!.worktreeKey).toMatch(/^[0-9a-f]{64}$/);
      // The worktree root identity holds the file-system ID and the inode, and no device number.
      const root = runner.wslIdentityLog.find((e) => e.path === uncPath(host, f21.repo.dir));
      expect(root?.reply).toEqual({ distroGuid: host.guid, fileSystemId: expect.stringMatching(/^[0-9a-f]+$/), inode: expect.stringMatching(/^\d+$/), fileSystemType: "ef53" });
      const device = inDistro(host.distro, ["/usr/bin/stat", "--format=%d", "--", f21.repo.dir]).trim();
      console.log(`OBSERVATION T207: F21 stat %d ${device}, identity ${JSON.stringify(root?.reply)}`);
      expect(JSON.stringify(runner.wslIdentityLog)).not.toContain(`"${device}"`);
      // One confirmation for the distro Git. It names the distro, the Git path, and the version.
      expect(runner.wslConfirmations).toEqual([{ distro: host.distro, path: host.probe.paths.git, version: host.gitVersion ?? "" }]);
      expectNoScope(host);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "Cancel in the native Git confirmation registers nothing",
    ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "distro-git-2.55"],
    async (host) => {
      const f21 = buildF21(host);
      const { runner, s } = setup(host);
      runner.inject.wslConfirm = "declined";
      expect(await s.response(s.chooseRepository(f21.paths[1]!))).toMatchObject({ state: "canceled" });
      expect(runner.wslConfirmations).toEqual([{ distro: host.distro, path: host.probe.paths.git, version: host.gitVersion ?? "" }]);
      expect(runner.wslSaved.size).toBe(0);
      expectNoScope(host);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "a changed Git identity gives GIT_CHANGED and a new confirmation",
    ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "distro-git-2.55"],
    async (host) => {
      const f21 = buildF21(host);
      const { runner, s } = setup(host);
      expect(await s.response(s.chooseRepository(f21.paths[1]!))).toMatchObject({ state: "succeeded" });
      const [inode, size, time] = (host.probe.gitfile ?? "0:0:0").split(":");
      runner.inject.wslProbe = { stdout: seamProbe(host, { gitfile: `${inode}:${Number(size) + 1}:${time}` }) };
      const second = startSession(runner);
      expect(await second.response(second.chooseRepository(f21.paths[0]!))).toMatchObject({ state: "failed", code: "GIT_CHANGED" });
      expect(runner.wslConfirmations).toHaveLength(2);
      expectNoScope(host);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "F26: a repository under /mnt/c gives mixed-location, and a folder name with : gives wsl-path",
    ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "distro-git-2.55"],
    async (host) => {
      if (GIT === null) throw new Error("F26 needs the Windows Git");
      const f26 = buildF26(host, GIT);
      const { s } = setup(host);
      expect(await s.response(s.chooseRepository(f26.mounted.path))).toMatchObject({
        state: "failed",
        code: "UNSUPPORTED_REPOSITORY",
        result: { reason: "mixed-location", text: "The worktree and its Git directories must all lie inside one WSL distro, or all on Windows." },
      });
      expect(await s.response(s.chooseRepository(f26.colonPath))).toMatchObject({
        state: "failed",
        code: "UNSUPPORTED_REPOSITORY",
        result: { reason: "wsl-path", text: "This path holds a name that Windows cannot show. Open another folder." },
      });
      expectNoScope(host);
    },
    CASE_TIMEOUT_MS,
  );
});
