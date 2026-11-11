// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { printOrigin } from "../origin";
import { fixtureDir, useFixtureRoot } from "../git/fixture-root";
import { encodeFrame, readFrames } from "../../src/git-service/transport";

printOrigin("../../src/git-service/transport.ts", import.meta.dir);

const BINARY = resolve(import.meta.dir, "../../src-tauri/binaries/arbareto-git-x86_64-pc-windows-msvc.exe");
const REPLY_TIMEOUT_MS = 10_000;
const EXIT_TIMEOUT_MS = 5_000;
const TEST_TIMEOUT_MS = 30_000;

// Contract §6 "Startup handshake".
const HANDSHAKE = {
  kind: "handshake",
  handshake: {
    version: 1,
    restarted: false,
    platformScope: "other",
    osBuild: 26200,
    webView2Version: "154.0.4258.37",
    buildIdentity: { version: "0.1.0", commit: "0".repeat(40), channel: "local" },
    markers: [],
    unloadedMarkers: 0,
    damagedMarkers: [],
    trustRecords: [],
  },
} as const;

// Each canary writes a file named after itself into the launch directory. Any such file means that a canary took effect.
const canary = (name: string) => `require("node:fs").writeFileSync(require("node:path").join(process.cwd(), "canary-hit-${name}"), "");\n`;
const hits = (dir: string) => readdirSync(dir).filter((name) => name.startsWith("canary-hit-"));

// research.md R7 "Compiled-service hardening": the four autoload controls, plus runtime controls that a `.env` could try to set.
function writeHostileFiles(dir: string): void {
  writeFileSync(join(dir, "canary-bunfig.ts"), canary("bunfig"));
  writeFileSync(join(dir, "canary-env-options.ts"), canary("env-options"));
  writeFileSync(join(dir, "canary-env-inspect.ts"), canary("env-inspect"));
  writeFileSync(join(dir, "canary-tsconfig.ts"), canary("tsconfig"));
  writeFileSync(join(dir, "canary-package.ts"), canary("package"));
  writeFileSync(join(dir, "bunfig.toml"), 'preload = ["./canary-bunfig.ts", "canary-alias", "#canary"]\n');
  writeFileSync(
    join(dir, ".env"),
    "BUN_BE_BUN=1\nBUN_OPTIONS=--preload ./canary-env-options.ts\nBUN_INSPECT_PRELOAD=./canary-env-inspect.ts\nNODE_ENV=canary\nARBARETO_DOTENV_CANARY=hit\n",
  );
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "canary-alias": ["./canary-tsconfig.ts"] } } }));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "hostile", type: "commonjs", main: "./canary-package.ts", imports: { "#canary": "./canary-package.ts" } }));
}

// The shell starts the service with a sanitized environment (research.md R7). This test passes only the names that a Windows process needs.
function serviceEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["SystemRoot", "SystemDrive", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no result within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

if (!existsSync(BINARY)) {
  describe.skip(`compiled service hardening (T055) (SKIP: ${BINARY} absent; run bun run build:service)`, () => {});
} else {
  const digest = new Bun.CryptoHasher("sha256").update(readFileSync(BINARY)).digest("hex");
  console.log(`ORIGIN ${BINARY} sha256=${digest}`);
  useFixtureRoot();

  describe("compiled service hardening (T055)", () => {
    let launch = "";
    beforeAll(() => {
      launch = fixtureDir("hostile-launch");
      writeHostileFiles(launch);
    });

    // Control: plain Bun in the same directory loads the bunfig preload and the .env file, so these canaries can fire.
    test(
      "control: plain Bun in the launch directory triggers the bunfig and .env canaries",
      async () => {
        writeFileSync(join(launch, "control.ts"), 'require("node:fs").writeFileSync("control-dotenv.txt", String(process.env.ARBARETO_DOTENV_CANARY));\n');
        const proc = Bun.spawn([process.execPath, "control.ts"], { cwd: launch, env: serviceEnvironment(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        let seen: string[] = [];
        let dotenv = "";
        try {
          await within(proc.exited, REPLY_TIMEOUT_MS, "control exit");
          seen = hits(launch);
          dotenv = readFileSync(join(launch, "control-dotenv.txt"), "utf8");
        } finally {
          if (proc.exitCode === null) proc.kill();
          for (const name of [...hits(launch), "control.ts", "control-dotenv.txt"]) if (existsSync(join(launch, name))) unlinkSync(join(launch, name));
        }
        expect(seen.sort()).toEqual(["canary-hit-bunfig", "canary-hit-package", "canary-hit-tsconfig"]);
        expect(dotenv).toBe("hit");
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "hostile .env, bunfig.toml, tsconfig.json, and package.json in the launch directory take no effect",
      async () => {
        const proc = Bun.spawn([BINARY], { cwd: launch, env: serviceEnvironment(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        try {
          proc.stdin.write(encodeFrame(HANDSHAKE as never));
          await proc.stdin.flush();
          const frames = readFrames(proc.stdout);
          const first = await within(frames.next(), REPLY_TIMEOUT_MS, "handshake reply");
          expect(first.done).toBe(false);
          const incoming = first.value as { type: string; body?: Uint8Array };
          expect(incoming.type).toBe("frame");
          const reply = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(incoming.body));
          expect(reply).toEqual({ kind: "handshake", handshake: { sessionId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) } });
          // The service exits at the end of its input.
          proc.stdin.end();
          await within(proc.exited, EXIT_TIMEOUT_MS, "service exit");
          await frames.return(undefined);
        } finally {
          if (proc.exitCode === null) {
            proc.kill();
            await within(proc.exited, EXIT_TIMEOUT_MS, "service kill").catch(() => {});
          }
        }
        const stderr = await within(new Response(proc.stderr).text(), EXIT_TIMEOUT_MS, "service stderr");
        expect(hits(launch)).toEqual([]);
        expect(stderr).not.toMatch(/canary|hostile|bunfig|tsconfig|\.env/i);
        expect(proc.exitCode).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );
  });
}
