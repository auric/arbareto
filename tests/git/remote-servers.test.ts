// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T003: the self-check of `tests/support/http-remote.ts` and `tests/support/git-daemon.ts` (plan.md P0.1). Counters decide, never log text.

import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { connects, startGitDaemon } from "../support/git-daemon";
import { startHttpRemote, within } from "../support/http-remote";
import { describeGit } from "./git-binary";
import { useFixtureRoot } from "./fixture-root";
import { buildCredentialRemote, credentialHelper, HTTP_PASSWORD, HTTP_USER, nativeEnv, nativeHost, type GitHost } from "./remote-fixtures";

useFixtureRoot();

const CASE_MS = 120_000;
const GIT_WAIT_MS = 60_000;

interface Run {
  exitCode: number;
  stdout: string;
}

// The servers answer on this event loop, so Git runs asynchronously.
function gitAsync(git: string, cwd: string, args: string[]): { proc: ReturnType<typeof Bun.spawn>; done: Promise<Run> } {
  const proc = Bun.spawn([git, ...args], { cwd, env: nativeEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const done = (async () => {
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited]);
    return { exitCode, stdout };
  })();
  return { proc, done };
}

const finish = (run: { proc: ReturnType<typeof Bun.spawn>; done: Promise<Run> }) =>
  within(run.done, GIT_WAIT_MS, "git").catch((e) => {
    run.proc.kill();
    throw e;
  });

async function waitFor(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${what} within ${ms} ms`);
    await Bun.sleep(50);
  }
}

describeGit("local HTTP remote and git daemon (T003)", (git) => {
  let host: GitHost;
  const h = () => (host ??= nativeHost(git, "servers"));

  test("HTTP: Basic sign-in, request counter, 127.0.0.1 only, pause, throttle, stop", async () => {
    const project = `${h().root}/http`;
    mkdirSync(project, { recursive: true });
    buildCredentialRemote(h(), project);
    const server = startHttpRemote({ git, projectRoot: project, user: HTTP_USER, password: HTTP_PASSWORD, env: nativeEnv() });
    try {
      expect(server.hostname).toBe("127.0.0.1");
      expect(await connects("127.0.0.1", server.port)).toBe(true);
      expect(await connects("127.0.0.2", server.port)).toBe(false);
      const helper = (password: string) => ["-c", `credential.helper=${credentialHelper(HTTP_USER, password)}`];
      const repo = `${server.url}/cred.git`;

      const good = await finish(gitAsync(git, h().root, [...helper(HTTP_PASSWORD), "clone", "-q", "--", repo, `${h().root}/http-good`]));
      expect(good.exitCode).toBe(0);

      const before = server.requests();
      const bad = await finish(gitAsync(git, h().root, [...helper("wrong"), "clone", "-q", "--", repo, `${h().root}/http-bad`]));
      expect(bad.exitCode).not.toBe(0);
      expect(server.requests()).toBeGreaterThan(before);

      server.pause();
      const startedBefore = server.responsesStarted();
      const requestsBefore = server.requests();
      const held = gitAsync(git, h().root, [...helper(HTTP_PASSWORD), "ls-remote", "--", repo]);
      // The first request gets 401 before the pause gate; the signed-in request waits there.
      await waitFor(() => server.requests() >= requestsBefore + 2, GIT_WAIT_MS, "the signed-in request");
      expect(server.responsesStarted()).toBe(startedBefore);
      expect(held.proc.exitCode).toBeNull();
      server.resume();
      const released = await finish(held);
      expect(released.exitCode).toBe(0);
      expect(server.responsesStarted()).toBeGreaterThan(startedBefore);

      server.throttle(64, 5);
      const slow = await finish(gitAsync(git, h().root, [...helper(HTTP_PASSWORD), "clone", "-q", "--", repo, `${h().root}/http-slow`]));
      server.throttle(null);
      expect(slow.exitCode).toBe(0);
      expect(server.throttledChunks()).toBeGreaterThan(1);
    } finally {
      await server.stop();
    }
    expect(server.pids().length).toBeGreaterThan(0);
    expect(server.ended()).toBe(true);
    console.log(`HTTP_REMOTE requests=${server.requests()} cgi=${server.pids().length}`);
  }, CASE_MS);

  test("git daemon: the access hook counts one service request per ls-remote, 127.0.0.1 only, stop", async () => {
    const base = `${h().root}/daemon`;
    mkdirSync(base, { recursive: true });
    buildCredentialRemote(h(), base);
    const daemon = await startGitDaemon({ git, basePath: base, hookFile: `${h().root}/daemon-hook.sh`, counterFile: `${h().root}/daemon-count.txt`, env: nativeEnv() });
    try {
      expect(await connects("127.0.0.2", daemon.port)).toBe(false);
      const before = daemon.accessCount();
      const run = await finish(gitAsync(git, h().root, ["ls-remote", "--", `${daemon.url}/cred.git`]));
      expect(run.exitCode).toBe(0);
      expect(daemon.accessCount()).toBe(before + 1);
    } finally {
      await daemon.stop();
    }
    expect(daemon.ended()).toBe(true);
    console.log(`GIT_DAEMON access=${daemon.accessCount()} pid=${daemon.pid}`);
  }, CASE_MS);

  // A kill of the `git` root alone left `git-daemon.exe` running without a parent.
  test.skipIf(process.platform !== "win32")("git daemon: stop after a served fetch leaves no git-daemon.exe of the tree", async () => {
    const { descendants } = await import("../windows/installed-app");
    const { processCreationTime } = await import("./win32");
    const base = `${h().root}/daemon-tree`;
    mkdirSync(base, { recursive: true });
    buildCredentialRemote(h(), base);
    const daemon = await startGitDaemon({ git, basePath: base, hookFile: `${h().root}/daemon-tree-hook.sh`, counterFile: `${h().root}/daemon-tree-count.txt`, env: nativeEnv() });
    let members: { pid: number; name: string; created: bigint | null }[] = [];
    try {
      const fetched = await finish(gitAsync(git, h().root, ["clone", "-q", "--", `${daemon.url}/cred.git`, `${h().root}/daemon-tree-clone`]));
      expect(fetched.exitCode).toBe(0);
      members = descendants(daemon.pid).map((r) => ({ pid: r.pid, name: r.name, created: processCreationTime(r.pid) }));
    } finally {
      await daemon.stop();
    }
    console.log(`GIT_DAEMON_TREE ${members.map((m) => `${m.name}:${m.pid}`).join(" ")}`);
    expect(members.some((m) => m.name.toLowerCase() === "git-daemon.exe" && m.created !== null)).toBe(true);
    expect(members.filter((m) => m.created !== null && processCreationTime(m.pid) === m.created)).toEqual([]);
  }, CASE_MS);
});
