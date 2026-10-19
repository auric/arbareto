// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T010: the self-check of `tests/support/ssh-server.ts` (plan.md P0.3, O-5). Exit codes and counters decide, never log text.

import { describe, expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { printOrigin } from "../origin";
import { connects } from "../support/git-daemon";
import { within } from "../support/http-remote";
import { makeKeyPair, sshArgs, sshCommand, sshTools, startSshServer, type SshServer, type SshTools } from "../support/ssh-server";
import { GIT } from "./git-binary";
import { useFixtureRoot } from "./fixture-root";
import { buildCredentialRemote, nativeEnv, nativeHost, type GitHost } from "./remote-fixtures";
import { caseTest } from "./service-harness";

printOrigin("../support/ssh-server.ts", import.meta.dir);
useFixtureRoot();

const CASE_MS = 120_000;
const RUN_WAIT_MS = 60_000;

const TASK = "T010";
const NEEDS = ["local-ssh-server"] as const;
const TOOLS: SshTools | null = GIT === null ? null : sshTools(GIT);
if (TOOLS !== null) console.log(`SSH ${TOOLS.ssh}\nSSH_KEYGEN ${TOOLS.keygen}`);

async function run(argv: string[], cwd: string, env: Record<string, string>): Promise<number> {
  const proc = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return within(proc.exited, RUN_WAIT_MS, argv[0]!).catch((e) => {
    proc.kill();
    throw e;
  });
}

interface Setup {
  h: GitHost;
  tools: SshTools;
  server: SshServer;
  bare: string;
  key: string;
  otherKey: string;
  knownHosts: string;
  config: string;
}

async function setup(git: string, name: string): Promise<Setup> {
  const tools = TOOLS!;
  const h = nativeHost(git, name);
  const served = `${h.root}/served`;
  mkdirSync(served, { recursive: true });
  const bare = buildCredentialRemote(h, served);
  const host = makeKeyPair(tools, `${h.root}/host_ed25519`);
  const client = makeKeyPair(tools, `${h.root}/client_ed25519`);
  const other = makeKeyPair(tools, `${h.root}/other_ed25519`);
  const server = await startSshServer({ git, root: served, hostKey: host.privateKey, clientKey: client.publicKey, env: nativeEnv() });
  const knownHosts = `${h.root}/known_hosts`;
  writeFileSync(knownHosts, server.knownHostsLine());
  const config = `${h.root}/ssh_config`;
  writeFileSync(config, "");
  return { h, tools, server, bare, key: client.privateKey, otherKey: other.privateKey, knownHosts, config };
}

describe("local SSH server (T010)", () => {
    caseTest(TASK, "fetch with the client key, fetch with another key, push, connection counter, 127.0.0.1 only, stop", NEEDS, async () => {
      const git = GIT!;
      const s = await setup(git, "ssh-fetch");
      const { h, server } = s;
      const env = (key: string) => nativeEnv({ GIT_SSH_COMMAND: sshCommand(s.tools, { key, knownHosts: s.knownHosts, config: s.config }) });
      const url = server.url("cred.git");
      const dst = `${h.root}/dst`;
      expect(h.run(h.root, ["init", "-q", dst]).exitCode).toBe(0);
      const knownBefore = readFileSync(s.knownHosts);
      try {
        expect(server.hostname).toBe("127.0.0.1");
        expect(await connects("127.0.0.2", server.port)).toBe(false);

        const c0 = server.connections();
        expect(await run([git, "fetch", "-q", url, "+refs/heads/main:refs/remotes/t/main"], dst, env(s.key))).toBe(0);
        expect(server.connections()).toBe(c0 + 1);
        const source = h.run(s.bare, ["rev-parse", "--verify", "refs/heads/main"]).stdout.toString().trim();
        expect(h.run(dst, ["rev-parse", "--verify", "refs/remotes/t/main"]).stdout.toString().trim()).toBe(source);

        const c1 = server.connections();
        expect(await run([git, "fetch", "-q", url, "+refs/heads/main:refs/remotes/u/main"], dst, env(s.otherKey))).not.toBe(0);
        expect(server.connections()).toBe(c1 + 1);
        expect(h.run(dst, ["rev-parse", "--verify", "-q", "refs/remotes/u/main"]).exitCode).not.toBe(0);

        const tree = h.run(dst, ["rev-parse", "--verify", `${source}^{tree}`]).stdout.toString().trim();
        const next = h.run(dst, ["commit-tree", "-p", source, "-m", "next", tree]).stdout.toString().trim();
        expect(next).toMatch(/^[0-9a-f]{40,64}$/);
        const c2 = server.connections();
        expect(await run([git, "push", "-q", url, `${next}:refs/heads/main`], dst, env(s.key))).toBe(0);
        expect(server.connections()).toBe(c2 + 1);
        expect(h.run(s.bare, ["rev-parse", "--verify", "refs/heads/main"]).stdout.toString().trim()).toBe(next);
        expect(server.refused()).toEqual([]);
      } finally {
        await server.stop();
      }
      expect(Buffer.compare(knownBefore, readFileSync(s.knownHosts))).toBe(0);
      expect(server.spawned()).toBe(2);
      expect(server.ended()).toBe(true);
      expect(await connects("127.0.0.1", server.port)).toBe(false);
      console.log(`SSH_SERVER connections=${server.connections()} spawned=${server.spawned()}`);
    }, CASE_MS);

    caseTest(TASK, "refuses every command other than git-upload-pack and git-receive-pack under the owned root", NEEDS, async () => {
      const git = GIT!;
      const s = await setup(git, "ssh-refuse");
      const { h, server } = s;
      const commands = [
        "echo x",
        "git upload-pack '/cred.git'",
        "git-upload-pack '/../cred.git'",
        "git-upload-pack '/./cred.git'",
        "git-upload-pack 'cred.git'",
        "git-upload-pack '/cred.git'; echo x",
        "git-upload-pack '/cred.git' '/cred.git'",
        "git-receive-pack '/a\\b.git'",
        "git-upload-pack '//cred.git'",
      ];
      try {
        for (const command of commands) {
          const argv = [...sshArgs(s.tools, { key: s.key, knownHosts: s.knownHosts, config: s.config }), "-p", String(server.port), "git@127.0.0.1", command];
          expect({ command, exit: await run(argv, h.root, nativeEnv()) }).not.toEqual({ command, exit: 0 });
        }
      } finally {
        await server.stop();
      }
      expect(server.refused()).toEqual(commands);
      expect(server.connections()).toBe(commands.length);
      expect(server.spawned()).toBe(0);
      expect(server.ended()).toBe(true);
    }, CASE_MS);
});
