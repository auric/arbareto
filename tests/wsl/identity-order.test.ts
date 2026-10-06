// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T252: the WSL identity stays equal across distro start orders (plan.md F22 start-order variant, contract §11 "Paths and file access").
// Only the two dedicated distros of `ARBARETO_WSL_ORDER_DISTROS` are terminated (tasks.md "Test harness rules"). No Git 2.55.0 is needed.

import { afterAll, describe, expect } from "bun:test";
import { createCollector } from "../../src/git-service/git-runner";
import { createBunRunner, type WslIdentityReply } from "../git/bun-runner";
import { fixtureDir, serviceEnv, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import {
  createOwnedFolder,
  fileSystemType,
  FixtureLost,
  folderInode,
  inDistro,
  orderDistros,
  removeOwnedFolder,
  terminateOrderDistro,
  uncPath,
  wslTest,
  type WslHost,
} from "./wsl-host";

const CASE_TIMEOUT_MS = 600_000;

useFixtureRoot();

interface Distro {
  host: Pick<WslHost, "distro" | "home" | "folder">;
  inode: string;
}

interface Context {
  d: Distro;
  path: string;
  bootstrapId: string;
  gitInstallationId: string;
  operationId: string;
}

const created: Distro["host"][] = [];
afterAll(() => {
  for (const host of created) removeOwnedFolder(host);
});

function prepare(distro: string): Distro {
  const home = inDistro(distro, ["/usr/bin/printenv", "HOME"]).trim();
  const host = { distro, home, folder: `${home}/arbareto-fixtures-${crypto.randomUUID()}` };
  createOwnedFolder(host);
  created.push(host);
  // Contract §11: only type ef53 gives a stable file-system ID (test harness rules).
  const type = fileSystemType(host, host.folder);
  if (type !== "ef53") throw new Error(`wsl-fixture-fs-id: the folder type in ${distro} is ${type}, not ef53`);
  return { host, inode: folderInode(host, host.folder) };
}

describe("WSL identity across start orders (T252)", () => {
  wslTest(
    "each folder identity, and so each worktreeKey, stays equal when the two distros start in both orders",
    ["two-test-distros"],
    async () => {
      const [first, second] = orderDistros()!;
      const distros = [prepare(first), prepare(second)];
      const runner = createBunRunner({ git: GIT ?? "git", directory: fixtureDir(`runner-${crypto.randomUUID()}`), environment: serviceEnv() });
      try {
        // One registered WSL Git per distro, so the double answers identity requests with the two `stat` probes.
        // The shell binds the Git and its helper paths from its own probe parse. `register` names no Linux program.
        const contexts: Context[] = [];
        for (const d of distros) {
          const path = uncPath(d.host, d.host.folder);
          const bootstrapId = runner.addContext("repositoryDiscovery", path);
          const operationId = crypto.randomUUID();
          const output = { stdout: createCollector({ maxBytes: 65536 }), stderr: createCollector({ maxBytes: 65536 }) };
          const probe = await runner.wslProbe({ operationId, bootstrapId, distro: d.host.distro, limits: { deadlineMs: 60_000 }, ...output, signal: new AbortController().signal });
          if (probe.exitCode !== 0) throw new Error(`the Git probe of ${d.host.distro} exited ${probe.exitCode}`);
          const gitInstallationId = crypto.randomUUID();
          await runner.register({ operationId, bootstrapId, gitInstallationId, confirm: true } as never);
          contexts.push({ d, path, bootstrapId, gitInstallationId, operationId });
        }
        const identity = async (c: Context): Promise<WslIdentityReply> => {
          const [reply] = (await runner.identities(c.operationId, { contextKind: "repositoryDiscovery", bootstrapId: c.bootstrapId, gitInstallationId: c.gitInstallationId }, [c.path], new AbortController().signal)) as unknown as WslIdentityReply[];
          // The identity read gives the inode, so it is the inode check of the test harness rules.
          if (!reply || "code" in reply || reply.inode !== c.d.inode) throw new FixtureLost(c.d.host.folder);
          return reply;
        };
        const rounds: WslIdentityReply[][] = [];
        for (const order of [contexts, [...contexts].reverse()]) {
          for (const c of contexts) terminateOrderDistro(c.d.host.distro);
          const round: WslIdentityReply[] = [];
          // Each identity read is the first command after the start of its distro.
          for (const c of order) round.push(await identity(c));
          for (const c of order) {
            const device = inDistro(c.d.host.distro, ["/usr/bin/stat", "--format=%d", "--", c.d.host.folder]).trim();
            const reply = round[order.indexOf(c)] as { fileSystemId: string };
            console.log(`OBSERVATION T252: order ${order.map((o) => o.d.host.distro).join(" then ")}: ${c.d.host.distro} stat %d ${device}, file-system ID ${reply.fileSystemId}`);
          }
          rounds.push(order === contexts ? round : [...round].reverse());
        }
        expect(rounds[1]).toEqual(rounds[0]!);
      } finally {
        await runner.dispose();
      }
    },
    CASE_TIMEOUT_MS,
  );
});
