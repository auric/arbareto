// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Test-only SSH server on 127.0.0.1 (plan.md P0.3 and O-5, tasks.md T011, research.md R21). It uses the `ssh2` devDependency.
// Sign-in is public key only, for one client key. A connection runs `git upload-pack` or `git receive-pack` for one repository under the owned root.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import { within } from "./http-remote";

// The `ssh2` 1.17.0 members that this file uses. The package ships no type declarations.
interface ParsedKey {
  type: string;
  getPublicSSH(): Buffer;
  verify(data: Buffer, signature: Buffer, hashAlgo?: string): boolean | Error;
}
interface AuthContext {
  method: string;
  key: { algo: string; data: Buffer };
  signature?: Buffer;
  blob?: Buffer;
  hashAlgo?: string;
  accept(): void;
  reject(methods?: string[]): void;
}
type ExecStream = Duplex & { stderr: Duplex; exit(code: number): void };
interface Session {
  on(event: "exec", listener: (accept: () => ExecStream, reject: () => void, info: { command: string }) => void): void;
}
interface Connection {
  on(event: "authentication", listener: (ctx: AuthContext) => void): void;
  on(event: "ready" | "close", listener: () => void): void;
  on(event: "session", listener: (accept: () => Session) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  end(): void;
}
interface Ssh2 {
  Server: new (config: { hostKeys: Buffer[] }, listener: (client: Connection) => void) => {
    listen(port: number, host: string, callback: () => void): void;
    address(): { address: string; port: number };
    close(callback: () => void): void;
    on(event: "error", listener: (error: Error) => void): void;
  };
  utils: { parseKey(data: Buffer | string): ParsedKey | ParsedKey[] | Error };
}
// A lazy load keeps `ssh2` out of each harness user that only reads the capability.
const ssh2 = (): Ssh2 => require("ssh2") as Ssh2;

export interface SshTools {
  ssh: string;
  keygen: string;
}

// Git for Windows ships OpenSSH in `<prefix>/usr/bin`, three levels above the exec path `<prefix>/mingw64/libexec/git-core`.
// Other platforms take `ssh` and `ssh-keygen` from PATH. Null means the capability `local-ssh-server` is absent.
export function sshTools(git: string): SshTools | null {
  if (process.platform !== "win32") {
    const ssh = Bun.which("ssh");
    const keygen = Bun.which("ssh-keygen");
    return ssh !== null && keygen !== null ? { ssh, keygen } : null;
  }
  const proc = Bun.spawnSync([git, "--exec-path"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) return null;
  const bin = resolve(proc.stdout.toString().trim(), "..", "..", "..", "usr", "bin");
  const ssh = resolve(bin, "ssh.exe");
  const keygen = resolve(bin, "ssh-keygen.exe");
  return existsSync(ssh) && existsSync(keygen) ? { ssh, keygen } : null;
}

const slash = (p: string) => p.replaceAll("\\", "/");

// An ed25519 key pair without a passphrase. `path` must not exist.
export function makeKeyPair(tools: SshTools, path: string): { privateKey: string; publicKey: string } {
  const proc = Bun.spawnSync([tools.keygen, "-q", "-t", "ed25519", "-N", "", "-C", "arbareto-test", "-f", slash(path)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`ssh-keygen exited ${proc.exitCode}: ${proc.stderr.toString()}`);
  return { privateKey: path, publicKey: `${path}.pub` };
}

export interface SshClientFiles {
  key: string;
  knownHosts: string;
  // An owned empty file, so that `ssh` reads no user configuration.
  config: string;
}

// No option names `~/.ssh`, and no agent or global known-hosts file takes part.
export function sshArgs(tools: SshTools, files: SshClientFiles): string[] {
  return [
    slash(tools.ssh), "-F", slash(files.config), "-i", slash(files.key),
    "-o", `UserKnownHostsFile=${slash(files.knownHosts)}`, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "StrictHostKeyChecking=yes",
    "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
  ];
}

// `GIT_SSH_COMMAND`: Git runs it through the shell, so each word is in POSIX single quotes.
export function sshCommand(tools: SshTools, files: SshClientFiles): string {
  return sshArgs(tools, files).map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(" ");
}

export interface SshServerOptions {
  git: string;
  // The folder that holds the served repositories.
  root: string;
  // OpenSSH private host key file, and the public key file of the one allowed client key.
  hostKey: string;
  clientKey: string;
  // The environment of each Git child.
  env: Record<string, string>;
}

export interface SshServer {
  hostname: string;
  port: number;
  // `ssh://git@127.0.0.1:<port>/<path>`.
  url(path: string): string;
  // The `known_hosts` line for the host key at this port.
  knownHostsLine(): string;
  // TCP connections that reached the server.
  connections(): number;
  // Exec commands that the server refused, in order.
  refused(): string[];
  // Git children that the server started.
  spawned(): number;
  // True when the listener is closed and Bun holds an exit record for each Git child.
  ended(): boolean;
  stop(): Promise<void>;
}

const STOP_WAIT_MS = 10_000;

// connect.c sends `<program> <path>`, with the path in `sq_quote_buf` form. That form quotes `'` and `!` outside the single quotes, so a path with them does not match.
const EXEC = /^(git-upload-pack|git-receive-pack) '([^'!]*)'$/;
// Contract of this server: `/` and one or more segments of these characters. A segment never starts with `.`, so `.` and `..` cannot occur.
const PATH = /^\/([A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*)$/;

// The Git argv for an exec command, or null to refuse it. The resolved target must lie under the resolved root.
function gitArgv(git: string, root: string, command: string): string[] | null {
  const exec = EXEC.exec(command);
  const path = exec === null ? null : PATH.exec(exec[2]!);
  if (exec === null || path === null) return null;
  let target: string;
  try {
    target = realpathSync.native(resolve(root, ...path[1]!.split("/")));
  } catch {
    return null;
  }
  if (!target.startsWith(realpathSync.native(root) + sep)) return null;
  return [git, exec[1] === "git-upload-pack" ? "upload-pack" : "receive-pack", target];
}

function publicKey(file: string): ParsedKey {
  const parsed = ssh2().utils.parseKey(readFileSync(file));
  if (parsed instanceof Error) throw parsed;
  if (Array.isArray(parsed)) throw new Error(`${file} holds more than one key`);
  return parsed;
}

export async function startSshServer(options: SshServerOptions): Promise<SshServer> {
  const allowed = publicKey(options.clientKey);
  const allowedBlob = allowed.getPublicSSH();
  const hostPublic = readFileSync(`${options.hostKey}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
  let connections = 0;
  const refused: string[] = [];
  const children: ChildProcess[] = [];
  const clients = new Set<Connection>();
  let closed = false;

  const server = new (ssh2().Server)({ hostKeys: [readFileSync(options.hostKey)] }, (client) => {
    connections++;
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      if (ctx.method !== "publickey") return ctx.reject(["publickey"]);
      const blob = ctx.key.data;
      const same = ctx.key.algo === allowed.type && blob.length === allowedBlob.length && timingSafeEqual(blob, allowedBlob);
      if (!same) return ctx.reject();
      // RFC 4252 section 7: a query without a signature only asks whether the key is acceptable.
      if (ctx.signature === undefined || ctx.blob === undefined) return ctx.accept();
      return allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true ? ctx.accept() : ctx.reject();
    });
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        // ssh2 rejects each session request without a listener: shell, pty, subsystem, env, and others.
        acceptSession().on("exec", (accept, reject, info) => {
          const argv = gitArgv(options.git, options.root, info.command);
          if (argv === null) {
            refused.push(info.command);
            return reject();
          }
          const stream = accept();
          const child = spawn(argv[0]!, argv.slice(1), { env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
          children.push(child);
          stream.pipe(child.stdin!);
          child.stdout!.pipe(stream, { end: false });
          child.stderr!.pipe(stream.stderr, { end: false });
          child.stdin!.on("error", () => {});
          child.on("close", (code) => {
            stream.exit(code ?? 255);
            stream.end();
          });
        });
      });
    });
  });
  server.on("error", () => {});
  await within(new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res())), STOP_WAIT_MS, "ssh2 listen");
  const address = server.address();
  const childEnded = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null;

  return {
    hostname: address.address,
    port: address.port,
    url: (path) => `ssh://git@127.0.0.1:${address.port}/${path}`,
    knownHostsLine: () => `[127.0.0.1]:${address.port} ${hostPublic}\n`,
    connections: () => connections,
    refused: () => [...refused],
    spawned: () => children.length,
    ended: () => closed && children.every(childEnded),
    async stop() {
      const done = new Promise<void>((res) => server.close(() => res()));
      for (const client of clients) client.end();
      for (const child of children) if (!childEnded(child)) child.kill();
      await within(done, STOP_WAIT_MS, "ssh2 close");
      closed = true;
      await within(Promise.all(children.map((c) => (childEnded(c) ? Promise.resolve() : new Promise((res) => c.once("exit", res))))), STOP_WAIT_MS, "ssh git children");
    },
  };
}
