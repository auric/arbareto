// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Test-only `git daemon` on 127.0.0.1 (plan.md P0.1, tasks.md T004). The access hook appends one line per service request to an owned counter file.
// git-daemon(1) "--access-hook": the daemon runs the hook for each service request, with the service name as its first argument. The hook inherits the daemon environment.

// On Windows, `git daemon` runs `git-daemon.exe` as a child, and a kill of the root ends the root only. The daemon therefore runs in an owned tree.
// Run as a script, the file is a gate: it waits for one byte on stdin, then runs its arguments. The owner assigns the gate to the tree before that byte, so each later child joins the tree.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { within } from "./http-remote";

// As `HOST_SCRIPT` of tests/git/bun-runner.ts: a static import of the host module would load `kernel32.dll` off Windows.
const { ownTree } = require(join(import.meta.dir, "..", "git", process.platform === "win32" ? "win32.ts" : "linux.ts")) as typeof import("../git/win32");

export interface GitDaemonOptions {
  git: string;
  // `--base-path`: the folder that holds the served repositories.
  basePath: string;
  // Owned files. The helper writes the hook and the hook writes the counter.
  hookFile: string;
  counterFile: string;
  // The base environment of the daemon.
  env: Record<string, string>;
}

export interface GitDaemon {
  // `git://127.0.0.1:<port>`.
  url: string;
  port: number;
  // The gate process, the root of the owned tree.
  pid: number;
  // Lines in the counter file: one per service request.
  accessCount(): number;
  // True when Bun holds an exit record for the daemon. A PID probe is no proof: the OS can reuse a PID after the process ends.
  ended(): boolean;
  stop(): Promise<void>;
}

const READY_MS = 10_000;
const STOP_WAIT_MS = 10_000;
const START_ATTEMPTS = 3;

// A free port from the OS. Another process can take it before the daemon binds, so the start retries.
async function freePort(): Promise<number> {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

// True when a TCP connection to `host:port` opens.
export async function connects(host: string, port: number): Promise<boolean> {
  try {
    const socket = await within(Bun.connect({ hostname: host, port, socket: { data() {} } }), 5_000, `connect ${host}:${port}`);
    socket.end();
    return true;
  } catch {
    return false;
  }
}

export async function startGitDaemon(options: GitDaemonOptions): Promise<GitDaemon> {
  writeFileSync(options.hookFile, '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$ARBARETO_DAEMON_COUNTER"\nexit 0\n');
  chmodSync(options.hookFile, 0o755);
  const slash = (p: string) => p.replaceAll("\\", "/");
  for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
    const port = await freePort();
    const proc: Subprocess<"pipe", "ignore", "ignore"> = Bun.spawn(
      [process.execPath, import.meta.path, options.git, "daemon", "--verbose", `--base-path=${options.basePath}`, "--export-all", `--access-hook=${slash(options.hookFile)}`, "--listen=127.0.0.1", `--port=${port}`],
      { env: { ...options.env, ARBARETO_DAEMON_COUNTER: slash(options.counterFile) }, stdin: "pipe", stdout: "ignore", stderr: "ignore" },
    );
    let tree: ReturnType<typeof ownTree>;
    try {
      tree = ownTree(proc.pid, true);
    } catch (error) {
      proc.kill();
      await within(proc.exited, STOP_WAIT_MS, `git daemon gate ${proc.pid}`);
      throw error;
    }
    // Ends the tree, then waits for the exit record of the gate.
    const stop = async () => {
      tree.end();
      tree.close();
      await within(proc.exited, STOP_WAIT_MS, `git daemon gate ${proc.pid}`);
    };
    proc.stdin.write("go");
    proc.stdin.end();
    const deadline = Date.now() + READY_MS;
    let ready = false;
    while (!ready && proc.exitCode === null && Date.now() < deadline) {
      ready = await connects("127.0.0.1", port);
      if (!ready) await Bun.sleep(100);
    }
    if (ready) {
      return {
        url: `git://127.0.0.1:${port}`,
        port,
        pid: proc.pid,
        accessCount: () => (existsSync(options.counterFile) ? readFileSync(options.counterFile, "utf8").split("\n").filter((l) => l !== "").length : 0),
        ended: () => proc.exitCode !== null || proc.signalCode !== null,
        stop,
      };
    }
    await stop();
  }
  throw new Error(`git daemon did not accept a connection after ${START_ATTEMPTS} starts`);
}

if (import.meta.main) {
  const { done } = await Bun.stdin.stream().getReader().read();
  // A closed stdin without a byte means that the owner ended before the assignment.
  if (done) process.exit(1);
  const child = Bun.spawn(process.argv.slice(2), { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  process.exit(await child.exited);
}
