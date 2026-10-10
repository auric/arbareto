// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T151: find, isolate, and start the installed Arbareto package. Run as `bun tests/windows/installed-app.ts --launch <root> [--no-identity]`.

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, sep } from "node:path";
import tauri from "../../src-tauri/tauri.conf.json";
import { FIXED_IDENTITY, ownedPath, removedByT043 } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { ownTree, processCreationTime } from "../git/win32";

export type RefusalCode = "ENTRY_INVALID" | "OUTSIDE_LOCALAPPDATA" | "BAD_ROOT" | "ANOTHER_INSTANCE";

export class InstalledAppRefusal extends Error {
  constructor(
    readonly code: RefusalCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

// The values that the Tauri NSIS template writes under `UNINSTKEY` (tauri-bundler 2.10.0 `installer.nsi`).
export interface UninstallEntry {
  installLocation: unknown;
  mainBinaryName: unknown;
}

export interface InstalledApp {
  exe: string;
  mainBinaryName: string;
  sha256: string;
}

export type Discovery = { app: InstalledApp } | { skip: string };

// Bounds of the PowerShell probes.
const PROBE_TIMEOUT_MS = 30_000;
const PROBE_MAX_BYTES = 16 * 1024 * 1024;
export const WAIT_MS = 10_000;

function powershellJson(script: string): unknown {
  const root = process.env.SystemRoot;
  if (!root) throw new Error("SystemRoot is not set");
  const proc = Bun.spawnSync(
    [join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n${script}`],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BYTES },
  );
  if (proc.exitCode !== 0) throw new Error(`powershell exited ${proc.exitCode}: ${proc.stderr.toString()}`);
  return JSON.parse(proc.stdout.toString());
}

// SHCTX is HKCU for `installMode` `currentUser` (src-tauri/tauri.conf.json). The key name is `${PRODUCTNAME}`.
export function readUninstallEntry(): UninstallEntry | null {
  const key = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${tauri.productName}`;
  return powershellJson(
    `$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key}')
if ($null -eq $k) { 'null' } else { ConvertTo-Json -Compress -InputObject @{ installLocation = $k.GetValue('InstallLocation'); mainBinaryName = $k.GetValue('MainBinaryName') } }`,
  ) as UninstallEntry | null;
}

const fold = (path: string) => path.toLowerCase();
const sha256 = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

// The template writes `InstallLocation` as `"$INSTDIR"` and `MainBinaryName` as `${MAINBINARYNAME}.exe`.
export function findInstalledApp(read: () => UninstallEntry | null = readUninstallEntry, localAppData = process.env.LOCALAPPDATA): Discovery {
  if (process.platform !== "win32") return { skip: "the installed package exists only on Windows" };
  const entry = read();
  if (entry === null) return { skip: `no uninstall entry HKCU\\...\\Uninstall\\${tauri.productName}` };
  const { installLocation: location, mainBinaryName: name } = entry;
  if (typeof location !== "string" || location.length < 3 || !location.startsWith('"') || !location.endsWith('"')) {
    throw new InstalledAppRefusal("ENTRY_INVALID", `InstallLocation is not a quoted path: ${JSON.stringify(location)}`);
  }
  if (typeof name !== "string" || name === "" || basename(name) !== name) {
    throw new InstalledAppRefusal("ENTRY_INVALID", `MainBinaryName is not a file name: ${JSON.stringify(name)}`);
  }
  const exe = join(location.slice(1, -1), name);
  if (!isAbsolute(exe)) throw new InstalledAppRefusal("ENTRY_INVALID", `InstallLocation is not absolute: ${location}`);
  if (!existsSync(exe) || !statSync(exe).isFile()) return { skip: `the uninstall entry names a missing file: ${exe}` };
  if (!localAppData) throw new InstalledAppRefusal("OUTSIDE_LOCALAPPDATA", "LOCALAPPDATA is not set");
  const real = realpathSync.native(exe);
  // Windows paths ignore case.
  if (!fold(real).startsWith(fold(realpathSync.native(localAppData) + sep))) {
    throw new InstalledAppRefusal("OUTSIDE_LOCALAPPDATA", `${real} is outside ${localAppData}`);
  }
  const app = { exe: real, mainBinaryName: name, sha256: sha256(real) };
  console.log(`ORIGIN ${app.exe} sha256=${app.sha256}`);
  return { app };
}

export interface AppEnv {
  env: Record<string, string>;
  set: { HOME: string; XDG_CONFIG_HOME: string; GIT_CONFIG_GLOBAL: string; ARBARETO_PROFILE_ROOT: string };
  removed: string[];
}

// `USERPROFILE` stays, and no `GIT_CONFIG_NOSYSTEM` applies, so system configuration stays active.
// `ARBARETO_PROFILE_ROOT` (T360, src-tauri/src/profile.rs) must name an existing folder, or the app exits with code 2.
export function appEnv(root: string, noIdentity: boolean, base: Record<string, string | undefined> = process.env): AppEnv {
  if (!isAbsolute(root) || !existsSync(root) || !statSync(root).isDirectory()) throw new InstalledAppRefusal("BAD_ROOT", `not an existing absolute folder: ${root}`);
  const owned = realpathSync.native(root);
  const home = ownedPath(owned, "home");
  const set = {
    HOME: home,
    XDG_CONFIG_HOME: ownedPath(owned, "home", ".config"),
    GIT_CONFIG_GLOBAL: ownedPath(owned, "home", ".gitconfig"),
    ARBARETO_PROFILE_ROOT: ownedPath(owned, "profile"),
  };
  mkdirSync(set.XDG_CONFIG_HOME, { recursive: true });
  mkdirSync(set.ARBARETO_PROFILE_ROOT, { recursive: true });
  writeFileSync(set.GIT_CONFIG_GLOBAL, noIdentity ? "[user]\n\tuseConfigOnly = true\n" : `[user]\n\tname = ${FIXED_IDENTITY.name}\n\temail = ${FIXED_IDENTITY.email}\n`);
  const env: Record<string, string> = {};
  const removed: string[] = [];
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || key.toUpperCase() in set) continue;
    if (removedByT043(key) || key.toUpperCase() === "GIT_CONFIG_NOSYSTEM") removed.push(key);
    else env[key] = value;
  }
  return { env: { ...env, ...set }, set, removed };
}

// Prints names and owned values only. A removed value can hold a credential.
export function printEnv(result: AppEnv): void {
  for (const [key, value] of Object.entries(result.set)) console.log(`ENV set ${key}=${value}`);
  for (const key of result.removed) console.log(`ENV removed ${key}`);
}

// `git config list -z --show-origin` prints `<origin>NUL<key>LF<value>NUL` for each entry.
export function printSystemConfig(git: string, env: Record<string, string>): void {
  const proc = Bun.spawnSync([git, "config", "list", "--system", "--show-origin", "-z"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BYTES });
  if (proc.exitCode !== 0) throw new Error(`git config list --system exited ${proc.exitCode}: ${proc.stderr.toString()}`);
  const fields = proc.stdout.toString().split("\0");
  const files = new Set<string>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    console.log(`SYSTEM_CONFIG ${fields[i]} ${fields[i + 1]!.replace("\n", "=")}`);
    if (fields[i]!.startsWith("file:")) files.add(fields[i]!.slice("file:".length));
  }
  for (const file of files) console.log(`SYSTEM_CONFIG_SHA256 ${file} ${existsSync(file) ? sha256(file) : "missing"}`);
}

export interface ProcessRecord {
  pid: number;
  parent: number;
  name: string;
  commandLine: string | null;
  // `CreationDate` as a FILETIME in decimal. CIM keeps microseconds only.
  created: string | null;
}

export function processRecords(): ProcessRecord[] {
  return powershellJson(
    `$r = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; name = $_.Name; commandLine = $_.CommandLine; created = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc().ToString() } else { $null } } })
ConvertTo-Json -Compress -InputObject $r`,
  ) as ProcessRecord[];
}

// A parent PID can belong to a newer process after the parent exits. A child is never older than its parent.
export function descendants(rootPid: number, records: ProcessRecord[] = processRecords()): ProcessRecord[] {
  const root = records.find((r) => r.pid === rootPid);
  if (!root) return [];
  const found: ProcessRecord[] = [];
  const queue = [root];
  for (let parent = queue.shift(); parent; parent = queue.shift()) {
    for (const r of records) {
      if (r.parent !== parent.pid || r.pid === parent.pid || r.created === null || parent.created === null || BigInt(r.created) < BigInt(parent.created)) continue;
      if (found.includes(r)) continue;
      found.push(r);
      queue.push(r);
    }
  }
  return found;
}

// Each record file is `<pid>-<FILETIME>` (`recordProcess` of tests/git/win32.ts). A process survives when that PID still has that creation time.
export function survivingRecords(directory: string): string[] {
  return readdirSync(directory).filter((name) => {
    const match = /^(\d+)-(\d+)$/.exec(name);
    return match !== null && processCreationTime(Number(match[1])) === BigInt(match[2]!);
  });
}

export interface OwnedProcess {
  pid: number;
  exited: Promise<number>;
  // Ends the owned tree only.
  stop(): void;
}

// The app is a GUI process, so no output is read.
export function spawnOwned(argv: string[], cwd: string, env: Record<string, string>): OwnedProcess {
  const proc = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const tree = ownTree(proc.pid);
  let open = true;
  return {
    pid: proc.pid,
    exited: proc.exited,
    stop() {
      if (!open) return;
      open = false;
      tree.end();
      tree.close();
    },
  };
}

// The exit code, or null at the bound.
export function waitExit(owned: OwnedProcess, ms = WAIT_MS): Promise<number | null> {
  return Promise.race([owned.exited, Bun.sleep(ms).then(() => null)]);
}

// An instance without the override uses the default WebView2 user-data folder (identifier `io.github.auric.arbareto`), so any other instance refuses the start.
export function startInstalledApp(app: InstalledApp, env: AppEnv, records: ProcessRecord[] = processRecords()): OwnedProcess {
  const others = records.filter((r) => fold(r.name) === fold(app.mainBinaryName));
  if (others.length > 0) throw new InstalledAppRefusal("ANOTHER_INSTANCE", `${app.mainBinaryName} runs as PID ${others.map((r) => r.pid).join(", ")}`);
  return spawnOwned([app.exe], env.set.ARBARETO_PROFILE_ROOT, env.env);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const root = args[1];
  const noIdentity = args[2] === "--no-identity";
  if (args[0] !== "--launch" || root === undefined || args.length > (noIdentity ? 3 : 2)) {
    console.error("usage: bun tests/windows/installed-app.ts --launch <root> [--no-identity]");
    process.exit(2);
  }
  try {
    const found = findInstalledApp();
    if ("skip" in found) {
      console.log(`SKIP ${found.skip}`);
      process.exit(1);
    }
    const result = appEnv(root, noIdentity);
    printEnv(result);
    if (GIT === null) console.log("SKIP system configuration: Git executable absent");
    else printSystemConfig(GIT, result.env);
    const owned = startInstalledApp(found.app, result);
    console.log(`STARTED ${owned.pid}`);
    // A Bun 1.4.2 child ends when the Bun process exits, so the launcher stays until the app exits.
    console.log(`EXITED ${await owned.exited}`);
  } catch (error) {
    if (!(error instanceof InstalledAppRefusal)) throw error;
    console.log(`REFUSED ${error.message}`);
    process.exit(1);
  }
}
