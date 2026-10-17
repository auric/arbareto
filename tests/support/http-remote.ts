// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Test-only smart HTTP remote (plan.md P0.1, tasks.md T004): `git http-backend` as CGI behind `Bun.serve` on 127.0.0.1, with Basic sign-in.
// The server runs on the event loop. A test starts Git with `Bun.spawn` and awaits it, because `Bun.spawnSync` blocks every answer.

import type { Subprocess } from "bun";

export interface HttpRemoteOptions {
  git: string;
  // `GIT_PROJECT_ROOT`: the folder that holds the served repositories.
  projectRoot: string;
  user: string;
  password: string;
  // The base environment of each CGI process.
  env: Record<string, string>;
}

export interface HttpRemote {
  // `http://127.0.0.1:<port>`.
  url: string;
  port: number;
  hostname: string;
  // Every request counts, also a refused sign-in.
  requests(): number;
  // Responses that passed the pause switch.
  responsesStarted(): number;
  // Body chunks that the throttle switch sent.
  throttledChunks(): number;
  // The process IDs of all CGI processes, in start order.
  pids(): number[];
  // True when Bun holds an exit record for every CGI process. A PID probe is no proof: the OS can reuse a PID after the process ends.
  ended(): boolean;
  // Holds each later response before its first byte, until `resume`.
  pause(): void;
  resume(): void;
  // Sends each body in chunks of `bytes` with `intervalMs` between chunks. Null turns the throttle off.
  throttle(bytes: number | null, intervalMs?: number): void;
  stop(): Promise<void>;
}

const STOP_WAIT_MS = 10_000;

// Rejects when `promise` does not settle within `ms`. The timer never outlives the call.
export async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not end within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// The CGI header block ends at the first empty line (RFC 3875 section 6.2).
function splitCgi(output: Uint8Array): { status: number; headers: Headers; body: Uint8Array<ArrayBuffer> } {
  const bytes = Buffer.from(output);
  const crlf = bytes.indexOf("\r\n\r\n");
  const lf = bytes.indexOf("\n\n");
  const [end, skip] = crlf !== -1 && (lf === -1 || crlf < lf) ? [crlf, 4] : [lf, 2];
  if (end === -1) throw new Error("CGI output has no header block");
  const headers = new Headers();
  let status = 200;
  for (const line of bytes.subarray(0, end).toString("latin1").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) throw new Error(`CGI header refused: ${JSON.stringify(line)}`);
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
    else headers.append(name, value);
  }
  return { status, headers, body: new Uint8Array(bytes.subarray(end + skip)) };
}

export function startHttpRemote(options: HttpRemoteOptions): HttpRemote {
  let requests = 0;
  let started = 0;
  let chunks = 0;
  let gate: { promise: Promise<void>; open: () => void } | null = null;
  let throttle: { bytes: number; intervalMs: number } | null = null;
  const procs: Subprocess[] = [];
  const running = new Set<Subprocess>();
  const expected = `Basic ${Buffer.from(`${options.user}:${options.password}`).toString("base64")}`;

  const body = (bytes: Uint8Array<ArrayBuffer>): BodyInit => {
    const t = throttle;
    if (t === null || bytes.length <= t.bytes) return bytes;
    let at = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (at > 0) await Bun.sleep(t.intervalMs);
        controller.enqueue(bytes.subarray(at, at + t.bytes));
        chunks += 1;
        at += t.bytes;
        if (at >= bytes.length) controller.close();
      },
    });
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      requests += 1;
      if (req.headers.get("authorization") !== expected) return new Response("sign-in required\n", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="arbareto"' } });
      const url = new URL(req.url);
      const input = new Uint8Array(await req.arrayBuffer());
      // git-http-backend(1) "ENVIRONMENT"; REMOTE_USER enables receive-pack.
      const env: Record<string, string> = {
        ...options.env,
        GATEWAY_INTERFACE: "CGI/1.1",
        SERVER_PROTOCOL: "HTTP/1.1",
        REQUEST_METHOD: req.method,
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        CONTENT_LENGTH: String(input.length),
        REMOTE_USER: options.user,
        REMOTE_ADDR: "127.0.0.1",
        GIT_PROJECT_ROOT: options.projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
      };
      const type = req.headers.get("content-type");
      if (type !== null) env.CONTENT_TYPE = type;
      const encoding = req.headers.get("content-encoding");
      if (encoding !== null) env.HTTP_CONTENT_ENCODING = encoding;
      const protocol = req.headers.get("git-protocol");
      if (protocol !== null) {
        env.GIT_PROTOCOL = protocol;
        env.HTTP_GIT_PROTOCOL = protocol;
      }
      const proc = Bun.spawn([options.git, "http-backend"], { env, stdin: input.length > 0 ? new Blob([input]) : "ignore", stdout: "pipe", stderr: "ignore" });
      procs.push(proc);
      running.add(proc);
      const [output] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
      running.delete(proc);
      const cgi = splitCgi(new Uint8Array(output));
      if (gate !== null) await gate.promise;
      started += 1;
      return new Response(body(cgi.body), { status: cgi.status, headers: cgi.headers });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port!,
    hostname: server.hostname!,
    requests: () => requests,
    responsesStarted: () => started,
    throttledChunks: () => chunks,
    pids: () => procs.map((p) => p.pid),
    ended: () => procs.every((p) => p.exitCode !== null || p.signalCode !== null),
    pause() {
      if (gate !== null) return;
      let open = () => {};
      const promise = new Promise<void>((resolve) => (open = resolve));
      gate = { promise, open };
    },
    resume() {
      gate?.open();
      gate = null;
    },
    throttle(bytes, intervalMs = 20) {
      throttle = bytes === null ? null : { bytes, intervalMs };
    },
    async stop() {
      gate?.open();
      gate = null;
      await server.stop(true);
      for (const proc of running) proc.kill();
      await within(Promise.all([...running].map((p) => p.exited)), STOP_WAIT_MS, "the CGI processes");
    },
  };
}
