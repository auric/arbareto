// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Test-only loopback server (research.md R14 S18). It answers every request with 401 and `WWW-Authenticate: Basic`, and it counts requests.

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export interface Http401 {
  // `http://127.0.0.1:<port>/x.git`, or `https://` in TLS mode.
  url: string;
  requests(): number;
  stop(): void;
}

// The server runs on the event loop. A test starts Git with `Bun.spawn` and awaits it, because `Bun.spawnSync` blocks every answer.
export function startHttp401(tls?: { key: string; cert: string }): Http401 {
  let count = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    ...(tls === undefined ? {} : { tls: { key: Bun.file(tls.key), cert: Bun.file(tls.cert) } }),
    fetch() {
      count += 1;
      return new Response("authentication required\n", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="arbareto"' } });
    },
  });
  return { url: `${tls === undefined ? "http" : "https"}://127.0.0.1:${server.port}/x.git`, requests: () => count, stop: () => server.stop(true) };
}

// The `openssl` program of the Git installation under test. Git for Windows ships it in `<prefix>/bin` and `/usr/bin` beside the exec path `<prefix>/libexec/git-core`.
// Null means the capability `openssl` is absent.
export function gitOpenssl(git: string): string | null {
  const proc = Bun.spawnSync([git, "--exec-path"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git --exec-path exited ${proc.exitCode}`);
  const execPath = proc.stdout.toString().trim();
  const name = process.platform === "win32" ? "openssl.exe" : "openssl";
  return [resolve(execPath, "..", "..", "bin", name), resolve(execPath, "..", "..", "..", "usr", "bin", name)].find((p) => existsSync(p)) ?? null;
}

// Creates a key and a self-signed certificate for `127.0.0.1` and `localhost` in `dir`. The certificate serves as the CA in `http.sslCAInfo`.
// Git 2.56.0.windows.1 with the default schannel backend honored `http.sslCAInfo` without `http.schannelUseSSLCAInfo` in a probe on 2026-10-07.
export function loopbackCertificate(openssl: string, dir: string): { key: string; cert: string } {
  mkdirSync(dir, { recursive: true });
  const key = join(dir, "loopback-key.pem");
  const cert = join(dir, "loopback-cert.pem");
  const args = ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"];
  const proc = Bun.spawnSync([openssl, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`openssl req exited ${proc.exitCode}: ${proc.stderr.toString()}`);
  return { key, cert };
}
