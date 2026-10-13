// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T207: WSL registration through `chooseRepository` (contract §3, §11). `src/git-service/wsl.ts` (T212) serves it.
// The F24 floor case and the seam cases need no Git 2.55.0 (tasks.md "Test harness rules"). They run before the other cases.

import { afterEach, describe, expect, test } from "bun:test";
import { createCollector, type GitRunner, type WslRunner } from "../../src/git-service/git-runner";
import { requestWslIdentities, type PhysicalIdentity } from "../../src/git-service/identity";
import { dismissWslMarker, type DismissalOutcome } from "../../src/git-service/registration";
import { approveWslGit, checkWslProbe, parseWslProbe, probeWslGit, routeRegistration, type WslGit } from "../../src/git-service/wsl";
import { createBunRunner, type BunRunner } from "../git/bun-runner";
import { fixtureDir, serviceEnv, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { printOrigin } from "../origin";
import { buildF21, buildF24, buildF26, globalConfig, SEAM_GIT_INODE, SEAM_INODE, seamProbe, seamRepository, startSession, type ProbeChange, type WslSession } from "./fixtures";
import { inDistro, isUbuntu, listScopes, parseProbe, uncPath, useWslFolder, WSL_EXE, wslTest, type WslHost } from "./wsl-host";

printOrigin("../../src/git-service/git-runner.ts", import.meta.dir);
printOrigin("../../src/git-service/registration.ts", import.meta.dir);
printOrigin("../../src/git-service/wsl.ts", import.meta.dir);
printOrigin("../../src/git-service/discovery.ts", import.meta.dir);

const CASE_TIMEOUT_MS = 180_000;
const MINIMUM = "2.55.0";
// Contract §11 "Git per distro": the third sentence of an Ubuntu version refusal.
const PPA_TEXT = "This command adds the official git-core PPA and installs its Git.";

useFixtureRoot();
useWslFolder();

let runners: BunRunner[] = [];
// Each dispose ends the WSL scopes of the runner through `wsl.exe`, so the hook takes the case bound.
afterEach(async () => {
  for (const runner of runners) await runner.dispose();
  runners = [];
}, CASE_TIMEOUT_MS);

function setup(host: WslHost, markers: object[] = []): { runner: BunRunner; s: WslSession } {
  const runner = createBunRunner({
    git: GIT ?? "git",
    directory: fixtureDir(`runner-${crypto.randomUUID()}`),
    environment: serviceEnv(),
    wslGlobalConfig: globalConfig(host),
  });
  runners.push(runner);
  return { runner, s: startSession(runner, { markers }) };
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
      // Contract §11: an Ubuntu distro adds the PPA sentence. The next case checks its command.
      const text = `Git ${found} in ${host.distro} is older than 2.55.0. Install Git 2.55.0 or later in the distro.${isUbuntu(probe) ? ` ${PPA_TEXT}` : ""}`;
      expect(response).toMatchObject({ state: "failed", code: "GIT_UNSUPPORTED", result: { reason: "version", detectedVersion: found, minimumVersion: MINIMUM, text } });
      // Only the probe ran. No confirmation, no Git registration, and no Git command.
      expect(runner.spawned).toBe(1);
      expect(runner.wslConfirmations).toEqual([]);
      expect(runner.wslSaved.size).toBe(0);
      expectNoScope(host);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "F24 on an Ubuntu distro: the version refusal carries the Git PPA remedy command byte for byte",
    ["distro-git-below-2.55", "ubuntu-distro"],
    async (host) => {
      const { runner, s } = setup(host);
      const response = await s.response(s.chooseRepository(uncPath(host, host.folder)));
      expect(response).toMatchObject({ state: "failed", code: "GIT_UNSUPPORTED", result: { reason: "version", detectedVersion: host.gitVersion, minimumVersion: MINIMUM } });
      expect(response.result?.text).toBe(`Git ${host.gitVersion} in ${host.distro} is older than 2.55.0. Install Git 2.55.0 or later in the distro. ${PPA_TEXT}`);
      // Contract §11 "Git per distro": the app never runs this command.
      expect(response.result?.command).toBe(
        `& '${WSL_EXE}' --distribution '${host.distro}' --user root --cd / --exec /bin/sh -c 'add-apt-repository -y ppa:git-core/ppa && apt-get update && apt-get install -y git'`,
      );
      expect(runner.spawned).toBe(1);
      expect(runner.wslConfirmations).toEqual([]);
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
  // T212 review S3: a failed WSL identity read carries the WSL remedy, not the NTFS or ReFS one.
  test("a failed or foreign WSL identity reply refuses with the WSL identity remedy", async () => {
    const git = { guid: "{c6d24ae9-40f2-40bf-b35d-bf0b6ca4ea00}", distro: "Ubuntu-24.04" };
    const refused = { ok: false, code: "UNSUPPORTED_REPOSITORY", result: { text: "Arbareto cannot read the identity of this folder in Ubuntu-24.04. Check that the folder exists on the distro's own disk." } } as const;
    const context = { contextKind: "repositoryDiscovery" as const, bootstrapId: crypto.randomUUID(), gitInstallationId: crypto.randomUUID() };
    const path = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\r";
    for (const reply of [{ code: "UNSUPPORTED_REPOSITORY" }, { code: "UNSUPPORTED_REPOSITORY", reason: "absent" }, { distroGuid: "{8f51b15e-5f05-4b6d-8d78-5765530f558a}", fileSystemId: "1", inode: "2" }]) {
      const runner = { identities: async () => [reply] } as unknown as GitRunner;
      expect({ reply, outcome: await requestWslIdentities(runner, crypto.randomUUID(), context, [path], git, new AbortController().signal) }).toEqual({ reply, outcome: refused });
    }
  });

  // T212 review S4: Linux Git reads `PATH` when it runs, so the bare-name rule takes the `PATH` of the latest probe.
  test("a reused session Git takes the PATH of the latest probe and asks for no confirmation", async () => {
    const session = { gitInstallationId: crypto.randomUUID(), distro: "Ubuntu-24.04", guid: "{c6d24ae9-40f2-40bf-b35d-bf0b6ca4ea00}", path: "/usr/bin/git", version: "2.55.0", identity: "fedc9aa3bd65bc57:7:1:1", pathEnv: "/usr/bin", wslExecutable: "C:\\Windows\\System32\\wsl.exe", systemdRun: "/usr/bin/systemd-run", systemctl: "/usr/bin/systemctl", setsid: "/usr/bin/setsid", noexpand: true };
    const { gitInstallationId: _id, ...probed } = { ...session, pathEnv: "/home/u/bin:/usr/bin" };
    const runner = { register: () => Promise.reject(new Error("no confirmation")) } as unknown as GitRunner;
    const approved = await approveWslGit(runner, { operationId: crypto.randomUUID(), bootstrapId: crypto.randomUUID() }, probed, session, undefined);
    expect(approved).toMatchObject({ ok: true, reused: true, changed: false, git: { gitInstallationId: session.gitInstallationId, pathEnv: "/home/u/bin:/usr/bin" } });
  });

  // T378, contract §11 "Git per distro": `noexpand` is the `$?` of `systemd-run --expand-environment=no --version`.
  // Only `verbatim 0` shows that a probe scope got its arguments unchanged. Any other value refuses like a failed scope test.
  test("T378: the probe facts noexpand and verbatim set the wrapper flag, and a missing or malformed value gives WSL_UNAVAILABLE reason no-user-manager", () => {
    const programs = ["git", "systemd-run", "systemctl", "setsid", "stat", "env", "perl", "sha256sum"].flatMap((name) => [`path ${name} /usr/bin/${name}`, `magic ${name} -`]);
    const base = ["pathenv /usr/bin", "selfs ef53:fedc9aa3bd65bc57", "selino 4242", "selstat ok", "version git version 2.55.0", "gitfs ef53:fedc9aa3bd65bc57", "gitfile 7:1:1", "scope 0"];
    const checked = (facts: string[]) => {
      const parsed = parseWslProbe(new TextEncoder().encode(`${[...programs, ...base, ...facts].join("\n")}\n`));
      if (parsed === null) return "unparsed";
      const result = checkWslProbe("Ubuntu-26.04", parsed, "C:\\Windows\\System32\\wsl.exe");
      return result.ok ? result.git.noexpand : result;
    };
    const refused = {
      ok: false,
      code: "WSL_UNAVAILABLE",
      result: {
        reason: "no-user-manager",
        text: "Arbareto needs the systemd user manager in this distro to end the processes that Git starts. Set systemd=true under [boot] in /etc/wsl.conf, then restart the distro.",
      },
    } as const;
    expect(checked(["noexpand 0", "verbatim 0"])).toBe(true);
    for (const status of ["1", "2", "255"]) expect({ status, found: checked([`noexpand ${status}`, "verbatim 0"]) }).toEqual({ status, found: false });
    for (const facts of [["verbatim 0"], ["noexpand ", "verbatim 0"], ["noexpand 00", "verbatim 0"], ["noexpand 01", "verbatim 0"], ["noexpand -1", "verbatim 0"], ["noexpand 256", "verbatim 0"], ["noexpand 0 ", "verbatim 0"], ["noexpand yes", "verbatim 0"]]) {
      expect({ facts, found: checked(facts) }).toEqual({ facts, found: refused });
    }
    for (const facts of [["noexpand 0"], ["noexpand 0", "verbatim 1"], ["noexpand 0", "verbatim "], ["noexpand 0", "verbatim 00"], ["noexpand 1", "verbatim 2"], ["noexpand 0", "verbatim 0 "], ["noexpand 0", "verbatim yes"]]) {
      expect({ facts, found: checked(facts) }).toEqual({ facts, found: refused });
    }
    // Each line kind appears at most once.
    expect(checked(["noexpand 0", "noexpand 0", "verbatim 0"])).toBe("unparsed");
    expect(checked(["noexpand 0", "verbatim 0", "verbatim 0"])).toBe("unparsed");
  });

  // Contract §6 "Walks" (T314): a `register` deadline reply gives DEADLINE.
  test("a register deadline reply gives DEADLINE", async () => {
    const probed = { distro: "Ubuntu-24.04", guid: "{c6d24ae9-40f2-40bf-b35d-bf0b6ca4ea00}", path: "/usr/bin/git", version: "2.55.0", identity: "fedc9aa3bd65bc57:7:1:1", pathEnv: "/usr/bin", wslExecutable: "C:\\Windows\\System32\\wsl.exe", systemdRun: "/usr/bin/systemd-run", systemctl: "/usr/bin/systemctl", setsid: "/usr/bin/setsid", noexpand: true };
    const runner = { register: async () => ({ stop: "deadline" }) } as unknown as GitRunner;
    const approved = await approveWslGit(runner, { operationId: crypto.randomUUID(), bootstrapId: crypto.randomUUID() }, probed, undefined, undefined);
    expect(approved).toEqual({ ok: false, code: "DEADLINE" });
  });

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

  wslTest(
    "a version refusal in a distro whose os-release ID is not ubuntu carries no command",
    [],
    async (host) => {
      const { runner, s } = seamed(host, { version: "git version 2.43.0", osid: "debian" });
      const response = await s.response(s.chooseRepository(folder(host)));
      expect(response).toMatchObject({
        state: "failed",
        code: "GIT_UNSUPPORTED",
        result: { reason: "version", detectedVersion: "2.43.0", minimumVersion: MINIMUM, text: `Git 2.43.0 in ${host.distro} is older than 2.55.0. Install Git 2.55.0 or later in the distro.` },
      });
      expect(response.result).not.toHaveProperty("command");
      expect(runner.wslConfirmations).toEqual([]);
      expectNoScope(host);
    },
    CASE_TIMEOUT_MS,
  );

  for (const program of ["stat", "env", "sha256sum"]) {
    wslTest(
      `a probe without /usr/bin/${program} gives WSL_UNAVAILABLE reason no-coreutils with its remedy text`,
      [],
      async (host) => {
        const { runner, s } = seamed(host, { version: `git version ${MINIMUM}`, absent: [program] });
        const response = await s.response(s.chooseRepository(folder(host)));
        expect(response).toMatchObject({
          state: "failed",
          code: "WSL_UNAVAILABLE",
          result: { reason: "no-coreutils", text: `Arbareto needs the stat, env, and sha256sum programs in /usr/bin of ${host.distro}. Install the coreutils package in the distro, then open the folder again.` },
        });
        expect(runner.wslConfirmations).toEqual([]);
        expectNoScope(host);
      },
      CASE_TIMEOUT_MS,
    );
  }

  // gaps.md W1: the probe prints the context path lines, and the service refuses the path before any Git rule after the path programs.
  const pathCases: [string, ProbeChange, string, Record<string, string>][] = [
    ["selfs type 1021994 (tmpfs)", { selfs: "1021994:9a8b7c6d5e4f3021" }, "UNSUPPORTED_REPOSITORY", { reason: "no-fs-uuid", text: "Arbareto cannot read a file-system UUID for this folder. Open a folder on the distro's own disk." }],
    ["selfs type 1021997 (v9fs)", { selfs: "1021997:9a8b7c6d5e4f3021" }, "UNSUPPORTED_REPOSITORY", { reason: "mixed-location", text: "The worktree and its Git directories must all lie inside one WSL distro, or all on Windows." }],
    ["selstat absent", { selstat: "absent" }, "UNSUPPORTED_REPOSITORY", { text: "Arbareto cannot read the identity of this folder in DISTRO. Check that the folder exists on the distro's own disk." }],
    ["selstat error", { selstat: "error" }, "UNSUPPORTED_REPOSITORY", { text: "Arbareto cannot read the identity of this folder in DISTRO. Check that the folder exists on the distro's own disk." }],
    ["a selino line that is no canonical inode", { selino: "0042" }, "UNSUPPORTED_REPOSITORY", { text: "Arbareto cannot read the identity of this folder in DISTRO. Check that the folder exists on the distro's own disk." }],
    ["no /usr/bin/perl", { absent: ["perl"] }, "WSL_UNAVAILABLE", { reason: "no-perl", text: "Arbareto needs Perl in DISTRO to check hook and program files. Install the distro's perl package, then open the repository again." }],
  ];
  for (const [label, change, code, result] of pathCases) {
    wslTest(
      `a probe with ${label} gives ${code} ${result.reason ?? "with the WSL identity remedy"} before the Git confirmation`,
      [],
      async (host) => {
        const { runner, s } = seamed(host, { version: `git version ${MINIMUM}`, ...change });
        const response = await s.response(s.chooseRepository(folder(host)));
        const expected = Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.replace("DISTRO", host.distro)]));
        expect(response).toMatchObject({ state: "failed", code, result: expected });
        // Contract §6 "Registration bootstrap": the selected directory identity comes before execution.
        expect(runner.spawned).toBe(0);
        expect(runner.wslConfirmations).toEqual([]);
        expectNoScope(host);
      },
      CASE_TIMEOUT_MS,
    );
  }

  // T318, contract §6 "Dismissal" and decision W13: the WSL marker allowances. Every other result keeps STATE_UNKNOWN.
  const refresh: DismissalOutcome = { ok: false, code: "STATE_UNKNOWN", result: { remedy: { text: "Open this repository and use Refresh." } } };
  const OTHER_INODE = "9999";
  const markerOf = (host: WslHost, inode: string) => ({ commonIdentity: { distroGuid: host.guid, fileSystemId: host.probe.gitfs!.split(":")[1]!, inode } });
  const dismiss = (runner: GitRunner & WslRunner & { addContext: BunRunner["addContext"] }, path: string, options: { marker?: { commonIdentity: PhysicalIdentity }; session?: WslGit } = {}) => {
    const gits = new Map(options.session === undefined ? [] : [[options.session.guid, options.session]]);
    const bootstrapId = runner.addContext("repositoryDiscovery", path);
    const marker = options.marker ?? { commonIdentity: { distroGuid: "{c6d24ae9-40f2-40bf-b35d-bf0b6ca4ea00}", fileSystemId: "1", inode: OTHER_INODE } };
    return dismissWslMarker(runner, { operationId: crypto.randomUUID(), bootstrapId, signal: new AbortController().signal, starting: () => {} }, marker, gits);
  };
  // The approved session Git of the distro, as a registration of `path` approves it through the injected probe.
  async function sessionGit(runner: BunRunner, path: string): Promise<WslGit> {
    const operationId = crypto.randomUUID();
    const bootstrapId = runner.addContext("repositoryDiscovery", path);
    const signal = new AbortController().signal;
    const route = routeRegistration(await runner.wslDistros({ operationId, bootstrapId }));
    if ("ok" in route || route.kind !== "wsl") throw new Error(`route: ${JSON.stringify(route)}`);
    const probed = await probeWslGit(runner, route, { operationId, bootstrapId, signal, starting: () => {} });
    if (!probed.ok) throw new Error(`probe: ${JSON.stringify(probed)}`);
    const approved = await approveWslGit(runner, { operationId, bootstrapId }, probed.git, undefined, undefined);
    if (!approved.ok) throw new Error(`approve: ${JSON.stringify(approved)}`);
    return approved.git;
  }

  wslTest(
    "a WSL marker dismissal is allowed when the list does not name the distro, and no process starts",
    [],
    async (host) => {
      const { runner } = setup(host);
      const missing = `arbareto-missing-${crypto.randomUUID().slice(0, 8)}`;
      expect(await dismiss(runner, `\\\\wsl.localhost\\${missing}\\home\\u\\r`)).toEqual({ ok: true });
      expect(runner.spawned).toBe(0);
      expectNoScope(host);
    },
    CASE_TIMEOUT_MS,
  );

  // A listed distro without its registration key is no unlisted distro. The dismissal stays refused.
  test("a WSL marker dismissal for a listed distro without a registration key gives STATE_UNKNOWN", async () => {
    const path = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\r";
    const runner = {
      addContext: () => crypto.randomUUID(),
      wslDistros: async () => ({ path, wslExecutable: WSL_EXE, listed: ["Ubuntu-24.04"], running: [], keys: [], saved: [] }),
      wslProbe: () => Promise.reject(new Error("no probe")),
    } as unknown as GitRunner & WslRunner & { addContext: BunRunner["addContext"] };
    expect(await dismiss(runner, path)).toEqual(refresh);
  });

  // Contract §11 "Route" folds only ASCII letters. U+212A KELVIN SIGN folds to `k` only under Unicode folding.
  test("a WSL marker dismissal is allowed when the distro segment matches a listed distro only under Unicode folding", async () => {
    const path = "\\\\wsl.localhost\\Kali\\home\\u\\r";
    const runner = {
      addContext: () => crypto.randomUUID(),
      wslDistros: async () => ({ path, wslExecutable: WSL_EXE, listed: ["Kali"], running: [], keys: [], saved: [] }),
      wslProbe: () => Promise.reject(new Error("no probe")),
    } as unknown as GitRunner & WslRunner & { addContext: BunRunner["addContext"] };
    expect(await dismiss(runner, path)).toEqual({ ok: true });
  });

  const dismissalCases: [string, ProbeChange, DismissalOutcome][] = [
    ["selstat absent", { selstat: "absent" }, { ok: true }],
    ["selstat error", { selstat: "error" }, refresh],
    ["selstat ok and no session Git", {}, refresh],
    // Contract §11 "Git per distro": the program checks come before the path lines.
    ["selstat absent without /usr/bin/perl", { selstat: "absent", absent: ["perl"] }, refresh],
  ];
  for (const [label, change, expected] of dismissalCases) {
    wslTest(
      `a WSL marker dismissal with a probe ${label} gives ${expected.ok ? "allowed" : expected.code}`,
      [],
      async (host) => {
        const { runner } = seamed(host, { version: `git version ${MINIMUM}`, ...change });
        expect(await dismiss(runner, folder(host))).toEqual(expected);
        expect(runner.wslConfirmations).toEqual([]);
        expectNoScope(host);
      },
      CASE_TIMEOUT_MS,
    );
  }

  wslTest(
    "a WSL marker dismissal whose probe passes its deadline gives DEADLINE",
    [],
    async (host) => {
      const { runner } = setup(host);
      runner.inject.wslProbe = { deadline: true };
      expect(await dismiss(runner, folder(host))).toEqual({ ok: false, code: "DEADLINE" });
      expectNoScope(host);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "W13: a WSL marker dismissal is allowed when discovery call 1 of the session Git exits nonzero",
    ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "perl"],
    async (host) => {
      const { runner } = seamed(host, { version: `git version ${MINIMUM}` });
      const session = await sessionGit(runner, folder(host));
      // The probe seam reports the folder, and the real distro Git meets no folder there.
      const gone = uncPath(host, `${host.folder}/gone-${crypto.randomUUID().slice(0, 8)}`);
      expect(await dismiss(runner, gone, { marker: markerOf(host, SEAM_GIT_INODE), session })).toEqual({ ok: true });
      expect(runner.spawned).toBe(1);
      expectNoScope(host);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "W13: a WSL marker dismissal is allowed only when the common-directory identity differs from the marker",
    ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "perl"],
    async (host) => {
      const { runner } = setup(host);
      const repo = seamRepository(host, runner);
      const session = await sessionGit(runner, repo.path);
      expect(await dismiss(runner, repo.path, { marker: markerOf(host, OTHER_INODE), session })).toEqual({ ok: true });
      expect(await dismiss(runner, repo.path, { marker: markerOf(host, SEAM_GIT_INODE), session })).toEqual(refresh);
      // A session Git of another path than the probe found runs no discovery.
      expect(await dismiss(runner, repo.path, { marker: markerOf(host, OTHER_INODE), session: { ...session, path: "/usr/local/bin/git" } })).toEqual(refresh);
      expect(runner.spawned).toBe(0);
      expectNoScope(host);
    },
    CASE_TIMEOUT_MS,
  );

  // T115: `dismissRecoveryMarker` of the session routes a WSL marker to the WSL rule, with the approved Git of the distro that the path routes to.
  // `distroGuid`: another GUID stands for a marker of an earlier distro with the same name.
  const wslMarker = (host: WslHost, path: string, inode: string, distroGuid = host.guid) => ({
    markerId: crypto.randomUUID(),
    kind: "commit",
    startedAt: new Date().toISOString(),
    worktreeRoot: path,
    commonDirectory: `${path}\\.git`,
    commonIdentity: { ...markerOf(host, inode).commonIdentity, distroGuid },
  });
  const REFUSED = { state: "failed", code: "STATE_UNKNOWN", result: { remedy: { text: "Open this repository and use Refresh." } } };
  const dismissed = (s: WslSession, runner: BunRunner, markerId: string, path: string) =>
    s.response(s.request("dismissRecoveryMarker", { markerId, bootstrapId: runner.addContext("repositoryDiscovery", path) }));

  wslTest(
    "T115: the session allows a WSL marker dismissal when the list does not name the distro, and no process starts",
    [],
    async (host) => {
      const path = `\\\\wsl.localhost\\arbareto-missing-${crypto.randomUUID().slice(0, 8)}\\home\\u\\r`;
      const marker = wslMarker(host, path, OTHER_INODE);
      const { runner, s } = setup(host, [marker]);
      expect(await dismissed(s, runner, marker.markerId, path)).toMatchObject({ state: "succeeded", result: { outcome: "unknown" } });
      expect(runner.spawned).toBe(0);
      expectNoScope(host);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "T115: a WSL marker dismissal in a stopped distro gives phase wsl-starting with the listed distro name",
    [],
    async (host) => {
      const marker = wslMarker(host, folder(host), OTHER_INODE);
      const { runner, s } = setup(host, [marker]);
      runner.inject.wslProbe = { stdout: seamProbe(host, { version: `git version ${MINIMUM}` }) };
      runner.inject.wslRunning = [];
      const release = runner.holdStart();
      const requestId = s.request("dismissRecoveryMarker", { markerId: marker.markerId, bootstrapId: runner.addContext("repositoryDiscovery", folder(host)) });
      const deadline = Date.now() + 30_000;
      while (!s.progressOf(requestId).some((p) => p.phase === "wsl-starting") && Date.now() < deadline) await Bun.sleep(10);
      release();
      expect(s.progressOf(requestId).filter((p) => p.phase === "wsl-starting")).toMatchObject([{ distro: host.distro }]);
      // No session Git of the distro, so the rule refuses after the probe.
      expect(await s.response(requestId)).toMatchObject(REFUSED);
      expectNoScope(host);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "T115: the session decides a WSL marker dismissal with the approved Git of the distro, by the common-directory identity",
    ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "perl"],
    async (host) => {
      const other = wslMarker(host, folder(host), OTHER_INODE);
      const same = wslMarker(host, folder(host), SEAM_GIT_INODE);
      const { runner, s } = setup(host, [other, same]);
      const repo = seamRepository(host, runner);
      // No session Git of the distro yet, so no discovery runs.
      expect(await dismissed(s, runner, other.markerId, repo.path)).toMatchObject(REFUSED);
      expect(await s.response(s.chooseRepository(repo.path))).toMatchObject({ state: "succeeded" });
      const running = s.request("dismissRecoveryMarker", { markerId: other.markerId, bootstrapId: runner.addContext("repositoryDiscovery", repo.path) });
      expect(await s.response(running)).toMatchObject({ state: "succeeded", result: { outcome: "unknown" } });
      // Contract §11 "Distro start": the running list names the distro, so no `wsl-starting` event comes.
      expect(s.progressOf(running).filter((p) => p.phase === "wsl-starting")).toEqual([]);
      expect(await dismissed(s, runner, same.markerId, repo.path)).toMatchObject(REFUSED);
      expect(runner.spawned).toBe(0);
      expectNoScope(host);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "T115: a WSL marker of an earlier distro GUID with the same name is decided with the approved Git of the current distro, and is allowed",
    ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "perl"],
    async (host) => {
      const earlier = wslMarker(host, folder(host), SEAM_GIT_INODE, `{${crypto.randomUUID()}}`);
      const { runner, s } = setup(host, [earlier]);
      const repo = seamRepository(host, runner);
      expect(await s.response(s.chooseRepository(repo.path))).toMatchObject({ state: "succeeded" });
      expect(await dismissed(s, runner, earlier.markerId, repo.path)).toMatchObject({ state: "succeeded", result: { outcome: "unknown" } });
      expect(runner.spawned).toBe(0);
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
      // T339 (b): the event names the listed distro, so the renderer can show "Starting WSL distro <name>…".
      expect(starting).toMatchObject({ distro: host.distro });
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
      // The shell binds only a probe that passes every contract §11 rule, the Git floor included.
      runner.inject.wslProbe = { stdout: seamProbe(host, { version: `git version ${MINIMUM}` }) };
      expect(await probe(bootstrapId, operationId)).toMatchObject({ exitCode: 0 });
      // A Linux program path from the service is refused.
      const programs = { distro: host.distro, git: "/tmp/evil", systemdRun: "/tmp/evil", systemctl: "/tmp/evil", setsid: "/tmp/evil" };
      await expect(runner.register({ operationId, bootstrapId, gitInstallationId: crypto.randomUUID(), confirm: true, wsl: programs } as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(runner.wslConfirmations).toEqual([]);
      const gitInstallationId = crypto.randomUUID();
      expect(await runner.register({ operationId, bootstrapId, gitInstallationId, confirm: true } as never)).toEqual({ result: "approved" });
      expect(runner.wslConfirmations).toEqual([{ distro: host.distro, path: host.probe.paths.git, version: MINIMUM }]);
      expect(runner.wslSaved.get(host.guid)).toEqual({
        distro: host.distro,
        git: host.probe.paths.git,
        version: MINIMUM,
        gitIdentity: `${host.probe.gitfs?.split(":")[1]}:${host.probe.gitfile}`,
      });
      // A probe that fails a contract §11 rule binds nothing.
      const other = crypto.randomUUID();
      const unbound = runner.addContext("repositoryDiscovery", path);
      runner.inject.wslProbe = { stdout: seamProbe(host, { version: `git version ${MINIMUM}`, absent: ["setsid"] }) };
      expect(await probe(unbound, other)).toMatchObject({ exitCode: 0 });
      await expect(runner.register({ operationId: other, bootstrapId: unbound, gitInstallationId: crypto.randomUUID(), confirm: true } as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(runner.wslConfirmations).toHaveLength(1);
      // gaps.md W1: a context binds once, so a second probe of a bound context is refused.
      runner.inject.wslProbe = { stdout: seamProbe(host, { version: `git version ${MINIMUM}` }) };
      await expect(probe(bootstrapId, operationId)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    },
    CASE_TIMEOUT_MS,
  );

  // gaps.md W1 and W2: a registration that starts no process. The discovery output and the identities are seams.
  const SEAM_NEEDS = ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "perl"] as const;

  wslTest(
    "a seam WSL registration binds the context identity at the probe, and worktreeKey is the SHA-256 of the identity text",
    SEAM_NEEDS,
    async (host) => {
      const { runner, s } = setup(host);
      const repo = seamRepository(host, runner);
      const requestId = s.chooseRepository(repo.path);
      // No process starts at context creation (gaps.md W1).
      expect(runner.spawned).toBe(0);
      const response = await s.response(requestId);
      expect(response).toMatchObject({ state: "succeeded" });
      const fileSystemId = host.probe.gitfs!.split(":")[1]!;
      const key = new Bun.CryptoHasher("sha256").update(`${host.guid}:${fileSystemId}:${SEAM_INODE}`).digest("hex");
      expect((response.result as { worktreeKey: string }).worktreeKey).toBe(key);
      expect(runner.spawned).toBe(0);
      // The shell read the context identity again before `register` (gaps.md W1).
      expect(runner.wslIdentityLog.filter((e) => e.path === repo.path)).toHaveLength(2);
      expectNoScope(host);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "a context identity that changes between the probe and register gives UNKNOWN_TARGET and registers nothing",
    SEAM_NEEDS,
    async (host) => {
      const { runner, s } = setup(host);
      const repo = seamRepository(host, runner);
      // The selected folder now reads as another inode than the probe bound.
      runner.inject.wslStat.set(repo.path, { inode: "9999", fileSystem: host.probe.gitfs! });
      expect(await s.response(s.chooseRepository(repo.path))).toMatchObject({ state: "failed", code: "UNKNOWN_TARGET" });
      // A later registration of the same folder through a new context still works, so nothing stayed bound.
      runner.inject.wslStat.set(repo.path, { inode: SEAM_INODE, fileSystem: host.probe.gitfs! });
      expect(await s.response(s.chooseRepository(repo.path))).toMatchObject({ state: "succeeded" });
      expectNoScope(host);
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
      // gaps.md W2: the canonical form, with no file-system type.
      expect(root?.reply).toEqual({ distroGuid: host.guid, fileSystemId: expect.stringMatching(/^[1-9a-f][0-9a-f]{0,15}$/), inode: expect.stringMatching(/^[1-9]\d*$/) });
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
