// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T004: the Bun facts F1 to F7 and F15 of 006 research.md R12. Every server listens on 127.0.0.1 only.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { GIT } from "./git-binary";

const HUNSPELL = printOrigin("hunspell-wasm", import.meta.dir);
// `dictionary-en` exports only `./index.js`, which lies at the package root.
const ENGLISH = join(printOrigin("dictionary-en", import.meta.dir), "..");

const BUN = `bun=${Bun.version}`;
const observe = (fact: string, text: string) => console.log(`OBSERVATION T004: ${fact} ${text} ${BUN}`);
const CHILD_TIMEOUT_MS = 30_000;
const OPENSSL_TIMEOUT_MS = 30_000;
const children: Bun.Subprocess[] = [];

const isFile = (path: string) => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

// Git for Windows layout: `git --exec-path` is `<root>/<mingw64|ucrt64>/libexec/git-core`, and `<root>/usr/bin` holds openssl.exe.
function findOpenssl(): string | null {
  if (GIT !== null) {
    const exec = Bun.spawnSync([GIT, "--exec-path"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const folder = /^([^\r\n]+)\r?\n$/.exec(exec.stdout.toString())?.[1];
    const shipped = folder === undefined ? undefined : join(folder, "..", "..", "..", "usr", "bin", process.platform === "win32" ? "openssl.exe" : "openssl");
    if (exec.exitCode === 0 && shipped !== undefined && isFile(shipped)) return shipped;
  }
  const onPath = Bun.which("openssl");
  return onPath !== null && isFile(onPath) ? onPath : null;
}
const OPENSSL = findOpenssl();
console.log(OPENSSL === null ? "SKIP F3: missing capability openssl (unverified)" : `OPENSSL ${OPENSSL}`);

// A test CA and a server certificate for 127.0.0.1, made in `root`. The repository holds no key.
function makeTls(openssl: string, root: string): { ca: string; cert: string; key: string } {
  writeFileSync(join(root, "server.ext"), "subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n");
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  const steps = [
    ["req", "-x509", ...ec, "-keyout", "ca-key.pem", "-out", "ca.pem", "-days", "2", "-subj", "/CN=Arbareto test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"],
    ["req", ...ec, "-keyout", "server-key.pem", "-out", "server.csr", "-subj", "/CN=127.0.0.1"],
    ["x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca-key.pem", "-CAcreateserial", "-out", "server.pem", "-days", "2", "-extfile", "server.ext"],
  ];
  for (const step of steps) {
    const run = Bun.spawnSync([openssl, ...step], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: OPENSSL_TIMEOUT_MS });
    if (run.exitCode !== 0) throw new Error(`openssl ${step[0]} exit ${run.exitCode}: ${run.stderr.toString()}`);
  }
  return { ca: join(root, "ca.pem"), cert: join(root, "server.pem"), key: join(root, "server-key.pem") };
}

afterAll(() => {
  for (const child of children) if (child.exitCode === null) process.kill(child.pid);
});

// One Bun child that prints one JSON line. `env` replaces the proxy and TLS variables of the parent.
async function child(code: string, env: Record<string, string>): Promise<Record<string, unknown>> {
  const base = { ...process.env };
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED"]) delete base[name];
  const proc = Bun.spawn([process.execPath, "-e", code], { env: { ...base, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: CHILD_TIMEOUT_MS });
  children.push(proc);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (proc.exitCode !== 0) throw new Error(`child exit ${proc.exitCode}: ${err}`);
  return JSON.parse(out.trim().split("\n").at(-1)!) as Record<string, unknown>;
}

// A child step: `ok` is true when the fetch resolved, else `error` holds the rejection name and code.
const ATTEMPT = `const attempt = async (url, init) => { try { const r = await fetch(url, init); await r.arrayBuffer(); return { ok: true, status: r.status }; } catch (e) { return { ok: false, name: e?.name, code: e?.code }; } };`;

describe("006 fetch facts (research.md R12)", () => {
  test("F1: redirect manual returns 301, 302, 303, 307, and 308 unfollowed", async () => {
    let targetHits = 0;
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/target") return new Response(`target ${++targetHits}`);
        return new Response(null, { status: Number(path.slice(1)), headers: { location: "/target" } });
      },
    });
    const seen: number[] = [];
    for (const status of [301, 302, 303, 307, 308]) {
      const response = await fetch(`http://127.0.0.1:${server.port}/${status}`, { redirect: "manual" });
      await response.arrayBuffer();
      seen.push(response.status);
    }
    observe("F1", `statuses=${seen.join(",")} targetHits=${targetHits}`);
    expect(seen).toEqual([301, 302, 303, 307, 308]);
    expect(targetHits).toBe(0);
  });

  test("F2: proxy false ignores HTTP_PROXY, HTTPS_PROXY, and ALL_PROXY", async () => {
    let connections = 0;
    const sockets: Socket[] = [];
    const proxy: NetServer = createServer((socket) => {
      connections += 1;
      sockets.push(socket);
      socket.on("error", () => {});
      socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\ncontent-length: 5\r\nconnection: close\r\n\r\nproxy"));
    });
    await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
    using target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("target") });
    try {
      const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
      const url = `http://127.0.0.1:${target.port}/`;
      const result = await child(
        `${ATTEMPT} const direct = await fetch(${JSON.stringify(url)}, { proxy: false }).then((r) => r.text(), (e) => "error " + e?.code);
         const control = await fetch(${JSON.stringify(url)}).then((r) => r.text(), (e) => "error " + e?.code);
         console.log(JSON.stringify({ direct, control }));`,
        { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl },
      );
      const directConnections = connections;
      observe("F2", `direct=${JSON.stringify(result.direct)} control=${JSON.stringify(result.control)} proxyConnections=${directConnections}`);
      // The control request without `proxy` shows that the child reads the proxy variables for 127.0.0.1.
      expect(result.control).toBe("proxy");
      expect(result.direct).toBe("target");
      expect(connections).toBe(1);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((done) => proxy.close(() => done()));
    }
  });

  test.skipIf(OPENSSL === null)("F3: tls.ca rootCertificates ignores NODE_EXTRA_CA_CERTS, and rejectUnauthorized true beats NODE_TLS_REJECT_UNAUTHORIZED=0", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbareto-f3-"));
    try {
      const pem = makeTls(OPENSSL!, root);
      using server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        tls: { cert: readFileSync(pem.cert, "utf8"), key: readFileSync(pem.key, "utf8") },
        fetch: () => new Response("tls"),
      });
      const url = JSON.stringify(`https://127.0.0.1:${server.port}/`);
      const extra = await child(
        `${ATTEMPT} const tls = require("node:tls");
         console.log(JSON.stringify({ roots: await attempt(${url}, { tls: { ca: tls.rootCertificates } }), plain: await attempt(${url}) }));`,
        { NODE_EXTRA_CA_CERTS: pem.ca },
      );
      const insecure = await child(`${ATTEMPT} console.log(JSON.stringify({ strict: await attempt(${url}, { tls: { rejectUnauthorized: true } }) }));`, { NODE_TLS_REJECT_UNAUTHORIZED: "0" });
      observe("F3", `extraCa.roots=${JSON.stringify(extra.roots)} extraCa.plain=${JSON.stringify(extra.plain)} rejectUnauthorized0.strict=${JSON.stringify(insecure.strict)}`);
      expect((extra.plain as { ok: boolean }).ok).toBe(true);
      expect((extra.roots as { ok: boolean }).ok).toBe(false);
      expect((insecure.strict as { ok: boolean }).ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("F4: a gzip body yields decoded bytes, and a cancel after N + 1 bytes ends the read", async () => {
    const original = new Uint8Array(8 * 1024 * 1024);
    for (let i = 0; i < original.length; i++) original[i] = (i * 7919 + (i >> 11)) & 0xff;
    const gzip = Bun.gzipSync(original);
    const CHUNK = 16 * 1024;
    let sent = 0;
    let cancelled = false;
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            type: "direct",
            async pull(controller: { write(part: Uint8Array): void; flush(): unknown; close(): void }) {
              while (sent < gzip.length && !cancelled) {
                const part = gzip.subarray(sent, sent + CHUNK);
                sent += part.length;
                controller.write(part);
                await controller.flush();
                await Bun.sleep(1);
              }
              controller.close();
            },
            cancel() {
              cancelled = true;
            },
          } as unknown as UnderlyingDefaultSource),
          { headers: { "content-encoding": "gzip" } },
        ),
    });
    const N = 65_536;
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    const reader = response.body!.getReader();
    const parts: Uint8Array[] = [];
    let received = 0;
    while (received <= N) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value);
      received += value.length;
    }
    await reader.cancel();
    const decoded = Buffer.concat(parts);
    const prefixEqual = Buffer.from(original.subarray(0, decoded.length)).equals(decoded);
    observe("F4", `received=${received} N=${N} prefixEqual=${prefixEqual} gzipBytes=${gzip.length} sentAtCancel=${sent}`);
    expect(received).toBeGreaterThan(N);
    expect(prefixEqual).toBe(true);
    expect(sent).toBeLessThan(gzip.length);
  });

  test("F5: an abort during a body read rejects the pending read, and the run flag tells Cancel from the deadline", async () => {
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(1024));
            },
          }),
        ),
    });
    const run = async (cause: "cancel" | "deadline") => {
      const controller = new AbortController();
      let flag: "cancel" | "deadline" | null = null;
      const response = await fetch(`http://127.0.0.1:${server.port}/`, { signal: controller.signal });
      const reader = response.body!.getReader();
      await reader.read();
      const pending = reader.read();
      flag = cause;
      controller.abort();
      const outcome = await pending.then(
        () => "resolved",
        (e: unknown) => `rejected ${(e as Error)?.name}`,
      );
      return { outcome, flag };
    };
    const cancel = await run("cancel");
    const deadline = await run("deadline");
    observe("F5", `cancel=${JSON.stringify(cancel)} deadline=${JSON.stringify(deadline)}`);
    expect(cancel.outcome).toStartWith("rejected");
    expect(deadline.outcome).toStartWith("rejected");
    expect([cancel.flag, deadline.flag]).toEqual(["cancel", "deadline"]);
  });

  test("F6: a closed port rejects with a TypeError that carries code", async () => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = probe.port;
    await probe.stop(true);
    const error = await fetch(`http://127.0.0.1:${port}/`).then(
      () => null,
      (e: unknown) => e,
    );
    const code = (error as { code?: unknown } | null)?.code;
    observe("F6", `typeError=${error instanceof TypeError} name=${(error as Error | null)?.name} code=${String(code)}`);
    expect(error).toBeInstanceOf(TypeError);
    expect(typeof code).toBe("string");
  });
});

describe("006 file facts (research.md R12)", () => {
  test("F7: rm recursive keeps the targets of a junction and a symbolic link, and a same-parent rename succeeds", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbareto-f7-"));
    try {
      const outside = join(root, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "keep.txt"), "keep");
      const folder = join(root, "folder");
      mkdirSync(folder);
      symlinkSync(outside, join(folder, "junction"), "junction");
      let symbolic = "created";
      try {
        symlinkSync(outside, join(folder, "symlink"), "dir");
      } catch (e) {
        symbolic = `refused ${(e as { code?: string }).code}`;
      }
      await rm(folder, { recursive: true });
      const kept = existsSync(join(outside, "keep.txt"));
      const moved = join(root, "moved");
      renameSync(outside, moved);
      const renamed = existsSync(join(moved, "keep.txt")) && !existsSync(outside);
      observe("F7", `symlink=${symbolic} folderGone=${!existsSync(folder)} outsideKept=${kept} rename=${renamed}`);
      expect(existsSync(folder)).toBe(false);
      expect(kept).toBe(true);
      expect(renamed).toBe(true);
      // A refused symbolic link leaves that half of the fact unverified, so the case does not pass.
      expect(symbolic).toBe("created");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("006 engine fact (research.md R12)", () => {
  test("F15: hunspell-wasm loads dictionary-en under Bun", async () => {
    const { createHunspellFromStrings } = (await import(HUNSPELL)) as typeof import("hunspell-wasm");
    const hunspell = await createHunspellFromStrings(readFileSync(join(ENGLISH, "index.aff"), "utf8"), readFileSync(join(ENGLISH, "index.dic"), "utf8"));
    try {
      const receive = hunspell.testSpelling("receive");
      const recieve = hunspell.testSpelling("recieve");
      observe("F15", `receive=${receive} recieve=${recieve}`);
      expect([receive, recieve]).toEqual([true, false]);
    } finally {
      hunspell.dispose();
    }
  });
});
