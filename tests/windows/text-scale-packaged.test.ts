// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T422: the WebView2 page of the installed package scales text once (plan.md "Windows text size", research.md R7). Spec FR-035, SC-009. `Local: package`.
// The case reads `devicePixelRatio` and `--text-scale` through CDP. It sets no CDP emulation, because an emulated device scale hides the defect.
// The expected device scale comes from the OS: `GetDpiForWindow` of the app window, divided by 96. The expected text factor comes from the Windows Text size.
// The case can fail only above Text size 100%. At 100% it is a regression guard.
// Control above 100%: remove the `webview::rasterize` calls in src-tauri/src/lib.rs; the case must fail.
// Control at 100%: pass `scale * 2.0` to `webview::rasterize`; the case must fail.

import { afterAll, describe, expect, test } from "bun:test";
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { release } from "node:os";
import { printOrigin } from "../origin";
import { fixtureDir, useFixtureRoot } from "../git/fixture-root";
import { connectPage, freePort, type Cdp } from "./cdp";
import { appEnv, findInstalledApp, PROBE_TIMEOUT_MS, processRecords, startInstalledApp, WAIT_MS, waitExit, windowsTextSize, type OwnedProcess } from "./installed-app";
import { MAX_WAIT_MS } from "./uia";

for (const helper of ["./cdp.ts", "./installed-app.ts"]) printOrigin(helper, import.meta.dir);
// The package under test holds these sources. The `ORIGIN` line of `findInstalledApp` names the installed binary and its SHA-256.
for (const source of ["../../src-tauri/src/webview.rs", "../../src-tauri/src/lib.rs", "../../src/frontend/layout/text-scale.ts"]) printOrigin(source, import.meta.dir);

const TASK = "T422";
// src-tauri/src/service.rs `window_title(None)`: the title of the main window before a repository opens.
const WINDOW_TITLE = "Arbareto";
// Microsoft Learn "GetDpiForWindow": 96 is the DPI of scale 100%.
const BASE_DPI = 96;
const TEXT_UNITS = 256;
const POLL_MS = 100;

const { ptr: P, i32, u32 } = FFIType;
const open = () =>
  dlopen("user32.dll", {
    FindWindowExW: { args: [P, P, P, P], returns: P },
    GetWindowThreadProcessId: { args: [P, P], returns: u32 },
    GetWindowTextW: { args: [P, P, i32], returns: i32 },
    GetDpiForWindow: { args: [P], returns: u32 },
  }).symbols;
let user32: ReturnType<typeof open> | undefined;

// The DLL exists only on Windows, so the import of this file must not open it.
function win(): ReturnType<typeof open> {
  if (process.platform !== "win32") throw new Error("the packaged text scale test needs Windows");
  return (user32 ??= open());
}

// The top-level windows of process `pid` whose title equals `title`.
function topWindows(pid: number, title: string): Pointer[] {
  const u = win();
  const owner = new Uint32Array(1);
  const text = new Uint16Array(TEXT_UNITS);
  const found: Pointer[] = [];
  for (let hwnd = u.FindWindowExW(null, null, null, null); typeof hwnd === "number" && hwnd !== 0; hwnd = u.FindWindowExW(null, hwnd, null, null)) {
    u.GetWindowThreadProcessId(hwnd, ptr(owner));
    if (owner[0] !== pid) continue;
    const length = u.GetWindowTextW(hwnd, ptr(text), TEXT_UNITS);
    if (Buffer.from(text.buffer, 0, length * 2).toString("utf16le") === title) found.push(hwnd);
  }
  return found;
}

if (process.platform !== "win32") console.log(`SKIP ${TASK}: missing capability windows`);

describe.skipIf(process.platform !== "win32")("T422 packaged text scale", () => {
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
  // Bun 1.4.4 runs `afterAll` hooks in declaration order. This hook must come before the fixture root removal.
  afterAll(stopOwned, 2 * WAIT_MS + PROBE_TIMEOUT_MS);
  useFixtureRoot();

  const discovery = findInstalledApp();
  const installed = "app" in discovery ? discovery.app : null;
  if (installed !== null) console.log(`APP ${TASK}: exe=${installed.exe} sha256=${installed.sha256}`);
  const others = installed === null ? [] : processRecords().filter((r) => r.name.toLowerCase() === installed.mainBinaryName.toLowerCase());
  const reason = installed === null ? (discovery as { skip: string }).skip : others.length > 0 ? `another-instance: ${installed.mainBinaryName} runs as PID ${others.map((r) => r.pid).join(", ")}` : null;
  if (reason !== null) console.log(`SKIP ${TASK} installed app: ${reason}`);

  test.skipIf(reason !== null)(
    "FR-035: devicePixelRatio equals the window DPI scale, and --text-scale equals the Windows Text size",
    async () => {
      const size = windowsTextSize();
      if (size === 100) console.log(`OBSERVATION ${TASK}: Text size 100%; the case can fail only above 100%, so this run is a regression guard`);
      const env = appEnv(fixtureDir("t422-app"), false);
      const port = freePort();
      env.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port}`;
      const app = startInstalledApp(installed!, env);
      owned.add(app);
      console.log(`STARTED ${TASK}: ${app.pid} port=${port} profile=${env.set.ARBARETO_PROFILE_ROOT}`);
      const c = await connectPage(port, MAX_WAIT_MS);
      sockets.add(c);

      const TEXT_SCALE = `document.documentElement.style.getPropertyValue('--text-scale')`;
      let textScale = "";
      for (const end = performance.now() + MAX_WAIT_MS; (textScale = await c.evaluate<string>(TEXT_SCALE)) === ""; await Bun.sleep(POLL_MS)) {
        if (performance.now() >= end) throw new Error(`--text-scale stayed empty for ${MAX_WAIT_MS} ms`);
      }
      const windows = topWindows(app.pid, WINDOW_TITLE);
      expect(windows.length).toBe(1);
      const dpi = win().GetDpiForWindow(windows[0]!);
      const page = await c.evaluate<{ dpr: number; width: number; height: number }>(`({ dpr: devicePixelRatio, width: innerWidth, height: innerHeight })`);
      const product = String((await c.send("Browser.getVersion")).product);
      console.log(`RECORD ${TASK}: os=${release()} webview2=${product} textSize=${size}% dpi=${dpi} dpr=${page.dpr} inner=${page.width}x${page.height} --text-scale=${textScale}`);

      expect(Math.fround(page.dpr)).toBe(Math.fround(dpi / BASE_DPI));
      expect(Number(textScale)).toBe(size / 100);
    },
    2 * MAX_WAIT_MS + 2 * PROBE_TIMEOUT_MS + 2 * WAIT_MS,
  );
});
