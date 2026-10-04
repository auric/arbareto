// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The WSL2 distro of the WSL tests (tasks.md "Test harness rules"). Every call is a `wsl.exe` argument array without a Linux shell string.
// The tests never install a package, change WSL or distro configuration, or run `--install`, `--update`, `--shutdown`, `--terminate`, or `--unregister`.
// The one exception is `terminateOrderDistro`: T252 ends the two dedicated distros that `ARBARETO_WSL_ORDER_DISTROS` names, and no other distro.

import { afterAll, beforeAll, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import wslProcess from "../../src/contracts/wsl-process.json";
import { printOrigin } from "../origin";

printOrigin("../../src/contracts/wsl-process.json", import.meta.dir);

export const WSL_EXE = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe");
// Contract §11 "Process launch": strict UTF-8 output, and no Windows variable reaches Linux.
export const WSL_ENV: Record<string, string> = { ...(process.env as Record<string, string>), WSL_UTF8: "1", WSLENV: "" };
export const PROBE_TEXT: string = wslProcess.probe.join("\n");
export const WSL_MINIMUM_GIT = [2, 55, 0] as const;
// Contract §5 WSL distro start: 60 seconds. A cold start of the reference distro took 10 to 13 seconds (2026-10-04).
const START_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = 30_000;
const OWNED = /^arbareto-fixtures-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class FixtureLost extends Error {
  constructor(readonly path: string) {
    super(`fixture-lost: ${path}`);
  }
}

export interface WslResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

// One `wsl.exe` process. `args` follow the program, so `--distribution` selects the distro.
export function wslExec(args: string[], options: { input?: Uint8Array; timeoutMs?: number; env?: Record<string, string> } = {}): WslResult {
  const proc = Bun.spawnSync([WSL_EXE, ...args], {
    env: options.env ?? WSL_ENV,
    stdin: options.input ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeoutMs ?? CALL_TIMEOUT_MS,
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

// Runs one program in the distro with `--exec`. Throws on a nonzero exit unless `allowExit` names it.
export function inDistro(distro: string, program: string[], options: { input?: Uint8Array; allowExit?: number[]; timeoutMs?: number } = {}): string {
  const result = wslExec(["--distribution", distro, "--cd", "/", "--exec", ...program], options);
  if (!(options.allowExit ?? [0]).includes(result.exitCode ?? -1)) {
    throw new Error(`${program.join(" ")} in ${distro} exited ${result.exitCode}: ${result.stderr}${result.stdout}`);
  }
  return result.stdout;
}

// The facts of the contract §11 Git probe text. The line format is the one of `src/contracts/wsl-process.json` `probe`.
export interface ProbeFacts {
  paths: Record<string, string>;
  magic: Record<string, string>;
  absent: string[];
  version?: string;
  gitfs?: string;
  gitfile?: string;
  pathEnv?: string;
  scope?: string;
}

export function parseProbe(text: string): ProbeFacts {
  const facts: ProbeFacts = { paths: {}, magic: {}, absent: [] };
  for (const line of text.split("\n")) {
    const [kind, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (kind === "path") facts.paths[rest[0]!] = rest.slice(1).join(" ");
    else if (kind === "magic") facts.magic[rest[0]!] = rest[1]!;
    else if (kind === "absent") facts.absent.push(value);
    else if (kind === "version") facts.version = value;
    else if (kind === "gitfs") facts.gitfs = value;
    else if (kind === "gitfile") facts.gitfile = value;
    else if (kind === "pathenv") facts.pathEnv = value;
    else if (kind === "scope") facts.scope = value;
  }
  return facts;
}

export interface RegistryKey {
  guid: string;
  name: string;
  version: number;
}

// `reg.exe` prints value names and types untranslated. The shell reads the same key through the registry API (T211).
export function registryKeys(): RegistryKey[] {
  const proc = Bun.spawnSync(["reg.exe", "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss", "/s"], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) return [];
  const keys: RegistryKey[] = [];
  let current: Partial<RegistryKey> | null = null;
  for (const line of proc.stdout.toString().split(/\r?\n/)) {
    const guid = /\\Lxss\\(\{[0-9a-fA-F-]+\})$/.exec(line)?.[1];
    if (guid) {
      current = { guid };
      keys.push(current as RegistryKey);
      continue;
    }
    const value = /^\s+(DistributionName|Version)\s+REG_(?:SZ|DWORD)\s+(.*)$/.exec(line);
    if (current && value) {
      if (value[1] === "DistributionName") current.name = value[2];
      else current.version = Number.parseInt(value[2]!, 16);
    }
  }
  return keys.filter((k) => typeof k.name === "string" && typeof k.version === "number");
}

export function listDistros(running: boolean): string[] | null {
  const result = wslExec(running ? ["--list", "--running", "--quiet"] : ["--list", "--quiet"]);
  if (result.exitCode !== 0) return null;
  return result.stdout.split(/\r?\n/).filter((name) => name !== "");
}

export interface WslHost {
  distro: string;
  guid: string;
  home: string;
  probe: ProbeFacts;
  gitVersion: string | null;
  // The owned folder name of this test process. `useWslFolder` creates it before the first test of a file.
  folder: string;
}

export type WslCapability = "wsl" | "wsl2-distro" | "systemd-user-manager" | "setsid" | "distro-git-2.55" | "distro-git-below-2.55" | "wsl-fixture-fs-id" | "two-test-distros";

function gitAtLeastFloor(version: string | null): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (!m) return false;
  const parts = m.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) if (parts[i] !== WSL_MINIMUM_GIT[i]) return parts[i]! > WSL_MINIMUM_GIT[i]!;
  return true;
}

function detect(): WslHost | { missing: WslCapability } {
  if (process.platform !== "win32" || !existsSync(WSL_EXE)) return { missing: "wsl" };
  const listed = listDistros(false);
  if (listed === null) return { missing: "wsl" };
  let distro = process.env.ARBARETO_WSL_DISTRO;
  if (!distro) {
    // Without `--distribution`, wsl.exe runs the default distro.
    const named = wslExec(["--exec", "/usr/bin/printenv", "WSL_DISTRO_NAME"], { timeoutMs: START_TIMEOUT_MS });
    distro = named.exitCode === 0 ? named.stdout.trim() : "";
  }
  const key = registryKeys().find((k) => k.name === distro);
  if (!distro || !listed.includes(distro) || !key || key.version !== 2) return { missing: "wsl2-distro" };
  const probe = wslExec(["--distribution", distro, "--cd", "/", "--exec", "/bin/sh", "-c", PROBE_TEXT, "sh"], { timeoutMs: START_TIMEOUT_MS });
  if (probe.exitCode !== 0) return { missing: "wsl2-distro" };
  const facts = parseProbe(probe.stdout);
  const home = inDistro(distro, ["/usr/bin/printenv", "HOME"]).trim();
  const host: WslHost = {
    distro,
    guid: key.guid,
    home,
    probe: facts,
    gitVersion: /^git version (\S+)$/.exec(facts.version ?? "")?.[1] ?? null,
    folder: `${home}/arbareto-fixtures-${crypto.randomUUID()}`,
  };
  console.log(`WSL ${distro} ${key.guid} home=${home} git=${facts.paths.git ?? "absent"} ${facts.version ?? ""} scope=${facts.scope ?? "absent"}`);
  return host;
}

// Detection starts the distro, so it runs only when a WSL test file asks for it.
let detection: WslHost | { missing: WslCapability } | undefined;
function detected(): WslHost | { missing: WslCapability } {
  detection ??= detect();
  return detection;
}

export function wslHost(): WslHost | null {
  const found = detected();
  return "missing" in found ? null : found;
}

// The capability that a case lacks, or null. Every case needs WSL and a WSL2 distro.
export function missingCapability(needs: readonly WslCapability[] = []): WslCapability | null {
  const host = detected();
  if ("missing" in host) return host.missing;
  for (const need of needs) {
    if (need === "systemd-user-manager" && host.probe.scope !== "0") return need;
    if (need === "setsid" && !host.probe.paths.setsid) return need;
    if (need === "distro-git-2.55" && !gitAtLeastFloor(host.gitVersion)) return need;
    // The F24 floor case needs a distro Git below the floor (test harness rules).
    if (need === "distro-git-below-2.55" && (host.gitVersion === null || gitAtLeastFloor(host.gitVersion))) return need;
    if (need === "wsl-fixture-fs-id" && fixtureFileSystem() !== "ef53") return need;
    if (need === "two-test-distros" && orderDistros() === null) return need;
  }
  return null;
}

// Declares one WSL case. A missing capability declares a skipped case whose name ends with that capability.
export function wslTest(name: string, needs: readonly WslCapability[], body: (host: WslHost) => Promise<void> | void, timeoutMs?: number): void {
  const missing = missingCapability(needs);
  if (missing !== null) {
    console.log(`SKIP ${missing}: ${name}`);
    test.skip(`${name} (SKIP: ${missing})`, () => {});
    return;
  }
  test(name, () => body(detected() as WslHost), timeoutMs);
}

// ---- Owned fixture folder ----

function assertOwned(host: WslHost, linuxPath: string): void {
  const prefix = `${host.home}/`;
  if (!linuxPath.startsWith(prefix) || !OWNED.test(linuxPath.slice(prefix.length))) throw new Error(`not an owned WSL fixture folder: ${linuxPath}`);
}

// Research R13 P7: only type ef53 gives a stable file-system ID, so the app refuses other folders (contract §11).
function fileSystemType(host: WslHost, linuxPath: string): string {
  return inDistro(host.distro, ["/usr/bin/stat", "--file-system", "--format=%t", "--", linuxPath]).trim();
}

export function createOwnedFolder(host: WslHost, linuxPath = host.folder): void {
  assertOwned(host, linuxPath);
  // `mkdir` without `-p` fails when the name exists.
  inDistro(host.distro, ["/usr/bin/mkdir", "--", linuxPath]);
  console.log(`WSL_FIXTURE_ROOT ${host.distro} ${linuxPath}`);
}

export function removeOwnedFolder(host: WslHost, linuxPath = host.folder): void {
  assertOwned(host, linuxPath);
  inDistro(host.distro, ["/usr/bin/rm", "-rf", "--one-file-system", "--", linuxPath]);
  const left = wslExec(["--distribution", host.distro, "--cd", "/", "--exec", "/usr/bin/test", "-e", linuxPath]);
  console.log(`WSL_FIXTURE_ROOT_REMOVED ${host.distro} ${linuxPath} exists=${left.exitCode === 0}`);
}

// The type check of the folder itself, before any fixture exists. Each file creates the folder again.
let fixtureType: string | null | undefined;
function fixtureFileSystem(): string | null {
  if (fixtureType !== undefined) return fixtureType;
  const host = wslHost();
  if (host === null) return (fixtureType = null);
  createOwnedFolder(host);
  try {
    fixtureType = fileSystemType(host, host.folder);
  } finally {
    removeOwnedFolder(host);
  }
  return fixtureType;
}

// Each test file owns the folder from its first test to its last, as `useFixtureRoot` does on Windows.
export function useWslFolder(): void {
  const host = wslHost();
  if (host === null || fixtureFileSystem() !== "ef53") return;
  beforeAll(() => {
    createOwnedFolder(host);
    if (fileSystemType(host, host.folder) !== "ef53") throw new Error("the folder type changed");
  });
  afterAll(() => {
    endScopes(host);
    removeOwnedFolder(host);
  });
}

export function folderInode(host: WslHost, linuxPath: string): string {
  return inDistro(host.distro, ["/usr/bin/stat", "--format=%i", "--", linuxPath]).trim();
}

// The restart check of the test harness rules. A missing folder or another inode stops the step with `fixture-lost`.
export function checkFolderInode(host: WslHost, linuxPath: string, inode: string): void {
  const result = wslExec(["--distribution", host.distro, "--cd", "/", "--exec", "/usr/bin/stat", "--format=%i", "--", linuxPath], { timeoutMs: START_TIMEOUT_MS });
  if (result.exitCode !== 0 || result.stdout.trim() !== inode) throw new FixtureLost(linuxPath);
}

// ---- Paths ----

export function uncPath(host: WslHost, linuxPath: string, prefix = "wsl.localhost", distro = host.distro): string {
  const segments = linuxPath.split("/").filter((s) => s !== "");
  return [`\\\\${prefix}\\${distro}`, ...segments].join("\\");
}

// ---- Scopes and processes ----

export function listScopes(host: WslHost, pattern = "arbareto-*"): string[] {
  const out = inDistro(host.distro, [host.probe.paths.systemctl ?? "/usr/bin/systemctl", "--user", "list-units", "--all", "--no-legend", "--plain", pattern]);
  return out.split("\n").filter((l) => l.trim() !== "").map((l) => l.trim().split(/\s+/)[0]!);
}

// Ends every scope of the operations that this process started. Each operation ID is a fresh UUID.
const started = new Set<string>();
export function recordOperation(operationId: string): void {
  started.add(operationId);
}

export function endScopes(host: WslHost): void {
  const systemctl = host.probe.paths.systemctl;
  if (!systemctl) return;
  for (const operationId of started) {
    inDistro(host.distro, [systemctl, "--user", "kill", "--signal=SIGKILL", "--", `arbareto-${operationId}-*.scope`], { allowExit: [0, 1] });
  }
  started.clear();
}

export function pgrep(host: WslHost, pattern: string): string[] {
  const out = inDistro(host.distro, ["/usr/bin/pgrep", "-a", "-f", "--", pattern], { allowExit: [0, 1] });
  return out.split("\n").filter((l) => l.trim() !== "");
}

// ---- T252 start order ----

export function orderDistros(): [string, string] | null {
  const names = (process.env.ARBARETO_WSL_ORDER_DISTROS ?? "").split(",").map((n) => n.trim()).filter((n) => n !== "");
  if (names.length !== 2 || names[0] === names[1]) return null;
  const listed = listDistros(false) ?? [];
  return names.every((n) => listed.includes(n)) ? [names[0]!, names[1]!] : null;
}

// Only for the two distros that `ARBARETO_WSL_ORDER_DISTROS` names (test harness rules).
export function terminateOrderDistro(distro: string): void {
  const named = orderDistros();
  if (named === null || !named.includes(distro)) throw new Error(`not a dedicated order distro: ${distro}`);
  const result = wslExec(["--terminate", distro]);
  if (result.exitCode !== 0) throw new Error(`--terminate ${distro} exited ${result.exitCode}: ${result.stdout}`);
}
