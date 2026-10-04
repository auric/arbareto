// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T252: the WSL identity stays equal across distro start orders (plan.md F22 start-order variant, contract §11 "Paths and file access").
// Only the two dedicated distros of `ARBARETO_WSL_ORDER_DISTROS` are terminated (tasks.md "Test harness rules"). No Git 2.55.0 is needed.

import { afterAll, describe, expect } from "bun:test";
import { createBunRunner, type WslIdentityReply } from "../git/bun-runner";
import { fixtureDir, serviceEnv, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import {
  FixtureLost,
  inDistro,
  orderDistros,
  parseProbe,
  PROBE_TEXT,
  registryKeys,
  terminateOrderDistro,
  uncPath,
  wslExec,
  wslTest,
  type WslHost,
} from "./wsl-host";

const CASE_TIMEOUT_MS = 600_000;
const OWNED = (home: string) => `${home}/arbareto-fixtures-${crypto.randomUUID()}`;

useFixtureRoot();

interface Distro {
  name: string;
  guid: string;
  home: string;
  folder: string;
  inode: string;
  helpers: { git: string; systemdRun: string; systemctl: string; setsid: string };
}

const created: Distro[] = [];
afterAll(() => {
  for (const d of created) inDistro(d.name, ["/usr/bin/rm", "-rf", "--one-file-system", "--", d.folder]);
});

function prepare(name: string): Distro {
  const probe = parseProbe(wslExec(["--distribution", name, "--cd", "/", "--exec", "/bin/sh", "-c", PROBE_TEXT, "sh"], { timeoutMs: 60_000 }).stdout);
  const home = inDistro(name, ["/usr/bin/printenv", "HOME"]).trim();
  const folder = OWNED(home);
  inDistro(name, ["/usr/bin/mkdir", "--", folder]);
  const guid = registryKeys().find((k) => k.name === name)?.guid ?? "";
  const inode = inDistro(name, ["/usr/bin/stat", "--format=%i", "--", folder]).trim();
  const d: Distro = {
    name,
    guid,
    home,
    folder,
    inode,
    helpers: { git: probe.paths.git ?? "/usr/bin/git", systemdRun: probe.paths["systemd-run"]!, systemctl: probe.paths.systemctl!, setsid: probe.paths.setsid! },
  };
  created.push(d);
  return d;
}

describe("WSL identity across start orders (T252)", () => {
  wslTest(
    "each folder identity, and so each worktreeKey, stays equal when the two distros start in both orders",
    ["two-test-distros"],
    async () => {
      const [first, second] = orderDistros()!;
      const distros = [prepare(first), prepare(second)];
      const runner = createBunRunner({ git: GIT ?? "git", directory: fixtureDir(`runner-${crypto.randomUUID()}`), environment: serviceEnv() });
      // One registered WSL Git per distro, so the double answers identity requests with the two `stat` probes.
      const contexts = distros.map((d) => {
        const host = { distro: d.name } as WslHost;
        const path = uncPath(host, d.folder);
        const bootstrapId = runner.addContext("repositoryDiscovery", path);
        const gitInstallationId = crypto.randomUUID();
        return { d, path, bootstrapId, gitInstallationId, operationId: crypto.randomUUID() };
      });
      for (const c of contexts) {
        const { git, systemdRun, systemctl, setsid } = c.d.helpers;
        await runner.register({
          operationId: c.operationId,
          bootstrapId: c.bootstrapId,
          gitInstallationId: c.gitInstallationId,
          version: "unused",
          digest: "0".repeat(64),
          confirm: true,
          wsl: { distro: c.d.name, guid: c.d.guid, git, systemdRun, systemctl, setsid, gitIdentity: "unused" },
        } as never);
      }
      const identity = async (c: (typeof contexts)[number]): Promise<WslIdentityReply> => {
        const [reply] = (await runner.identities(c.operationId, { contextKind: "repositoryDiscovery", bootstrapId: c.bootstrapId, gitInstallationId: c.gitInstallationId }, [c.path])) as unknown as WslIdentityReply[];
        // The identity read gives the inode, so it is the inode check of the test harness rules.
        if (!reply || "code" in reply || reply.inode !== c.d.inode) throw new FixtureLost(c.d.folder);
        return reply;
      };
      const rounds: WslIdentityReply[][] = [];
      for (const order of [contexts, [...contexts].reverse()]) {
        for (const c of contexts) terminateOrderDistro(c.d.name);
        const round: WslIdentityReply[] = [];
        // Each identity read is the first command after the start of its distro.
        for (const c of order) round.push(await identity(c));
        for (const c of order) {
          const device = inDistro(c.d.name, ["/usr/bin/stat", "--format=%d", "--", c.d.folder]).trim();
          const reply = round[order.indexOf(c)] as { fileSystemId: string };
          console.log(`OBSERVATION T252: order ${order.map((o) => o.d.name).join(" then ")}: ${c.d.name} stat %d ${device}, file-system ID ${reply.fileSystemId}`);
        }
        rounds.push(order === contexts ? round : [...round].reverse());
      }
      expect(rounds[1]).toEqual(rounds[0]!);
      await runner.dispose();
    },
    CASE_TIMEOUT_MS,
  );
});
