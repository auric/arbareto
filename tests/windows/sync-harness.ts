// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Shared helpers of the feature 003 packaged sync tests (T077 sync-perf.test.ts, T078 sync-packaged.test.ts).

import { afterAll, afterEach, expect } from "bun:test";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, sep } from "node:path";
import tauri from "../../src-tauri/tauri.conf.json";
import { fixtureGitPath, GIT } from "../git/git-binary";
import { credentialHelper, gitRun, HTTP_PASSWORD, HTTP_USER, type GitHost } from "../git/remote-fixtures";
import type { Cdp } from "./cdp";
import {
  findInstalledApp,
  InstalledAppRefusal,
  PROBE_TIMEOUT_MS,
  powershellJson,
  processRecords,
  readUninstallEntry,
  WAIT_MS,
  waitExit,
  type AppEnv,
  type InstalledApp,
  type OwnedProcess,
} from "./installed-app";
import { median } from "./ratio";
import { close, find, inputDesktopSkip, invoke, isEnabled, MAX_WAIT_MS, UiaError, type Element } from "./uia";

// UIA_E_ELEMENTNOTAVAILABLE: a render replaced the element.
export const UIA_E_ELEMENTNOTAVAILABLE = 0x8004_0201;

export const js = (value: unknown) => JSON.stringify(value);

// ---- Statistic (001 plan.md "Responsiveness metrics": every run, median, nearest-rank p95, maximum) ----

export type Summary = { n: number; median: number; p95: number; max: number };

export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) return { n: 0, median: Number.NaN, p95: Number.NaN, max: Number.NaN };
  const sorted = values.toSorted((a, b) => a - b);
  return { n: values.length, median: median(sorted), p95: sorted[Math.ceil(0.95 * sorted.length) - 1]!, max: sorted.at(-1)! };
}

// ---- Gate ----

const fold = (path: string) => path.toLowerCase();
const sha256 = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

// `findInstalledApp` without the hash, so a cold run does not read the executable before its start. The checks are the same.
export function locateInstalledApp(localAppData = process.env.LOCALAPPDATA): { app: InstalledApp } | { skip: string } {
  if (process.platform !== "win32") return { skip: "the installed package exists only on Windows" };
  const entry = readUninstallEntry();
  if (entry === null) return { skip: `no uninstall entry HKCU\\...\\Uninstall\\${tauri.productName}` };
  const { installLocation: location, mainBinaryName: name } = entry;
  if (typeof location !== "string" || location.length < 3 || !location.startsWith('"') || !location.endsWith('"')) {
    throw new InstalledAppRefusal("ENTRY_INVALID", `InstallLocation is not a quoted path: ${js(location)}`);
  }
  if (typeof name !== "string" || name === "" || basename(name) !== name) throw new InstalledAppRefusal("ENTRY_INVALID", `MainBinaryName is not a file name: ${js(name)}`);
  const exe = join(location.slice(1, -1), name);
  if (!isAbsolute(exe)) throw new InstalledAppRefusal("ENTRY_INVALID", `InstallLocation is not absolute: ${location}`);
  if (!existsSync(exe) || !statSync(exe).isFile()) return { skip: `the uninstall entry names a missing file: ${exe}` };
  if (!localAppData) throw new InstalledAppRefusal("OUTSIDE_LOCALAPPDATA", "LOCALAPPDATA is not set");
  const real = realpathSync.native(exe);
  if (!fold(real).startsWith(fold(realpathSync.native(localAppData) + sep))) throw new InstalledAppRefusal("OUTSIDE_LOCALAPPDATA", `${real} is outside ${localAppData}`);
  return { app: { exe: real, mainBinaryName: name, sha256: "not hashed before the cold run" } };
}

// Prints the `ORIGIN` line that `findInstalledApp` prints, after the cold run.
export function printOriginAfter(app: InstalledApp): void {
  console.log(`ORIGIN ${app.exe} sha256=${sha256(app.exe)}`);
}

export type Gate = { installed: InstalledApp | null; reason: string | null };

// The skip reason of the app cases: no package, no Git, another instance, no live-input opt-in, or a locked session.
export function liveGate(task: string, what: string, hash = true): Gate {
  const discovery = hash ? findInstalledApp() : locateInstalledApp();
  const installed = "app" in discovery ? discovery.app : null;
  if (installed !== null) console.log(`APP ${task}: exe=${installed.exe} sha256=${installed.sha256}`);
  const others = installed === null ? [] : processRecords().filter((r) => fold(r.name) === fold(installed.mainBinaryName));
  const reason =
    installed === null
      ? (discovery as { skip: string }).skip
      : GIT === null
        ? "Git executable absent"
        : others.length > 0
          ? `another-instance: ${installed.mainBinaryName} runs as PID ${others.map((r) => r.pid).join(", ")}`
          : process.env.ARBARETO_LIVE_INPUT !== "1"
            ? `live input needs the measurement account: set ARBARETO_LIVE_INPUT=1 (001 T165); ${what}`
            : inputDesktopSkip();
  if (reason !== null) console.log(`SKIP ${task}: ${reason}`);
  return { installed, reason };
}

// Microsoft Learn "Memory integrity and VBS enablement": BootId is a counter that increments on each successful boot.
export function bootId(): number {
  const value = powershellJson(
    `$k = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters')
if ($null -eq $k) { 'null' } else { ConvertTo-Json -InputObject $k.GetValue('BootId') }`,
  );
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`PrefetchParameters BootId is not an integer: ${js(value)}`);
  return value;
}

// ---- Owned apps ----

// Bun 1.4.4 runs `afterAll` hooks in declaration order. Call this before `useFixtureRoot`, so the apps end before the fixture root removal.
export function useOwnedApps(): { owned: Set<OwnedProcess>; sockets: Set<Cdp> } {
  const owned = new Set<OwnedProcess>();
  const sockets = new Set<Cdp>();
  const stopOwned = async () => {
    for (const c of sockets) c.close();
    sockets.clear();
    for (const app of owned) {
      owned.delete(app);
      app.stop();
      if ((await waitExit(app)) === null) throw new Error(`the app PID ${app.pid} did not exit within ${WAIT_MS} ms of the end`);
    }
  };
  afterEach(stopOwned, 2 * WAIT_MS + PROBE_TIMEOUT_MS);
  afterAll(async () => {
    await stopOwned();
    close();
  }, 2 * WAIT_MS + PROBE_TIMEOUT_MS);
  return { owned, sockets };
}

// A failure of the body stays the reported failure. A cleanup failure is reported only when the body passed.
export async function guarded(task: string, body: () => Promise<void>, cleanup: () => Promise<unknown[]>): Promise<void> {
  let failed = false;
  try {
    await body();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const errors = await cleanup();
    if (errors.length > 0) {
      if (failed) console.log(`CLEANUP ${task}: ${errors.map(String).join("; ")}`);
      else throw new AggregateError(errors, "the cleanup failed");
    }
  }
}

// ---- UIA ----

export async function use<T>(element: Promise<Element>, body: (element: Element) => T): Promise<T> {
  const found = await element;
  try {
    return body(found);
  } finally {
    found.release();
  }
}
export const uia = <T>(pid: number, name: string, type: number | undefined, body: (element: Element) => T) => use(find(pid, name, MAX_WAIT_MS, type), body);

// A render can replace the element, so each poll finds it again. Returns `performance.now()` just before the Invoke call.
export async function invokeWhenEnabled(pid: number, name: string, type: number, ms = MAX_WAIT_MS): Promise<number> {
  for (const end = performance.now() + ms; ; await Bun.sleep(10)) {
    // uia.ts refuses a search bound above MAX_WAIT_MS.
    const element = await find(pid, name, Math.min(MAX_WAIT_MS, Math.max(0, Math.ceil(end - performance.now()))), type);
    try {
      if (isEnabled(element)) {
        const at = performance.now();
        invoke(element);
        return at;
      }
    } catch (error) {
      if (!(error instanceof UiaError && error.hresult === UIA_E_ELEMENTNOTAVAILABLE)) throw error;
    } finally {
      element.release();
    }
    if (performance.now() >= end) throw new Error(`${js(name)} was not enabled within ${ms} ms`);
  }
}

// ---- Credentials ----

// Each Git call of the app uses this owned global file. The empty value clears the system helpers, so Git Credential Manager never stores the fixture credential or opens a prompt.
export function credentialConfig(h: GitHost, env: AppEnv): void {
  const file = env.set.GIT_CONFIG_GLOBAL;
  const helper = credentialHelper(HTTP_USER, HTTP_PASSWORD);
  gitRun(h, h.root, ["config", "--file", file, "--add", "credential.helper", ""]);
  gitRun(h, h.root, ["config", "--file", file, "--add", "credential.helper", helper]);
  const proc = Bun.spawnSync([fixtureGitPath(GIT!), "config", "--get-all", "--show-scope", "credential.helper"], { cwd: h.root, env: env.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: PROBE_TIMEOUT_MS });
  const lines = proc.stdout.toString().split("\n").filter((l) => l !== "");
  expect({ exit: proc.exitCode, last: lines.slice(-2) }).toEqual({ exit: 0, last: ["global\t", `global\t${helper}`] });
}
