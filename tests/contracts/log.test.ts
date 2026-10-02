// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { printOrigin } from "../origin";
import { createSessionLog } from "../../src/git-service/log";

const LOG_PATH = printOrigin("../../src/git-service/log.ts", import.meta.dir);

const CANARY = "ghp_ArbaretoCanary0123456789abcdefABCDEF";
const URL_CANARY = `https://canary-user:${CANARY}@example.invalid/repo.git`;
const KEY_WITH_URL = `http.https://canary-user:${CANARY}@example.invalid/.extraheader`;

const NOT_ALLOWLISTED = [
  "message",
  "stderr",
  "stdout",
  "outputTail",
  "hookOutput",
  "patch",
  "environment",
  "configuration",
  "path",
  "remoteUrl",
  "command",
  "credential",
  "authorization",
  "password",
  "token",
];

const owned: string[] = [];
const ownedDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  owned.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of owned) rmSync(dir, { recursive: true, force: true });
});

function tryRecord(log: ReturnType<typeof createSessionLog>, entry: Record<string, unknown>) {
  try {
    log.record(entry as never);
  } catch {
    // A refused entry is a valid outcome. The log content is checked below.
  }
}

const SAFE_ENTRY = {
  kind: "commit",
  operationId: crypto.randomUUID(),
  durationMs: 12,
  code: "GIT_FAILED",
  count: 1,
};

describe("session log", () => {
  test("keeps an allowlisted entry", () => {
    const log = createSessionLog();
    log.record(SAFE_ENTRY as never);
    expect(log.entries()).toContainEqual(expect.objectContaining(SAFE_ENTRY));
  });

  test.each(NOT_ALLOWLISTED.map((f) => [f]))("a canary in field %s never reaches the log", (field) => {
    const log = createSessionLog();
    tryRecord(log, { ...SAFE_ENTRY, [field]: CANARY });
    tryRecord(log, { ...SAFE_ENTRY, [field]: URL_CANARY });
    tryRecord(log, { ...SAFE_ENTRY, [field]: { nested: [CANARY] } });
    const text = JSON.stringify(log.entries());
    expect(text).not.toContain(CANARY);
  });

  test("a canary in a nested effect summary never reaches the log", () => {
    const log = createSessionLog();
    tryRecord(log, { ...SAFE_ENTRY, effects: { stderr: CANARY, head: URL_CANARY } });
    expect(JSON.stringify(log.entries())).not.toContain(CANARY);
  });

  test("a configuration key name with a URL token never reaches the log", () => {
    const log = createSessionLog();
    tryRecord(log, { ...SAFE_ENTRY, [KEY_WITH_URL]: "x" });
    tryRecord(log, { ...SAFE_ENTRY, kind: KEY_WITH_URL });
    tryRecord(log, { ...SAFE_ENTRY, code: KEY_WITH_URL });
    tryRecord(log, { ...SAFE_ENTRY, operationId: KEY_WITH_URL });
    tryRecord(log, { ...SAFE_ENTRY, effects: { [KEY_WITH_URL]: 1 } });
    const text = JSON.stringify(log.entries());
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("canary-user");
  });

  test.each([["kind"], ["operationId"], ["code"], ["durationMs"], ["count"]])(
    "a canary in allowlisted field %s never reaches the log",
    (field) => {
      const log = createSessionLog();
      tryRecord(log, { ...SAFE_ENTRY, [field]: CANARY });
      tryRecord(log, { ...SAFE_ENTRY, [field]: URL_CANARY });
      expect(JSON.stringify(log.entries())).not.toContain(CANARY);
    },
  );

  test("writes no file", () => {
    const watched = ownedDir("arbareto-log-cwd-");
    const scriptDir = ownedDir("arbareto-log-script-");
    const script = join(scriptDir, "write-log.ts");
    writeFileSync(
      script,
      [
        `import { createSessionLog } from ${JSON.stringify(pathToFileURL(LOG_PATH).href)};`,
        "const log = createSessionLog();",
        `const entry = ${JSON.stringify(SAFE_ENTRY)};`,
        "for (let i = 0; i < 1000; i++) log.record({ ...entry, count: i });",
        `try { log.record({ ...entry, stderr: ${JSON.stringify(CANARY)} }); } catch {}`,
        "console.log('ENTRIES ' + log.entries().length);",
      ].join("\n"),
    );
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
      TEMP: watched,
      TMP: watched,
      TMPDIR: watched,
      HOME: watched,
      USERPROFILE: watched,
      APPDATA: watched,
      LOCALAPPDATA: watched,
      XDG_CACHE_HOME: watched,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    };
    const child = Bun.spawnSync([process.execPath, script], { cwd: watched, env, timeout: 20_000, stdout: "pipe", stderr: "pipe" });
    expect(new TextDecoder().decode(child.stderr)).toBe("");
    expect(child.exitCode).toBe(0);
    expect(new TextDecoder().decode(child.stdout)).toContain("ENTRIES ");
    expect(readdirSync(watched, { recursive: true })).toEqual([]);
  });
});
