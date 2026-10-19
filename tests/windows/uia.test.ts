// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, describe, expect, test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import { printOrigin } from "../origin";
import { srcImportHits } from "./src-imports";
import { withProbe } from "./probe-window";
import { fixtureDir, useFixtureRoot } from "../git/fixture-root";
import { appEnv, findInstalledApp, PROBE_TIMEOUT_MS, startInstalledApp, WAIT_MS, waitExit, type OwnedProcess } from "./installed-app";
import { close, find, findLiveRegions, focus, foregroundSkip, inputDesktopSkip, invoke, isSelected, MAX_CALL_MS, MAX_WAIT_MS, readText, select, setValue, UiaError, waitFocus, type Element } from "./uia";

const UIA = printOrigin("./uia.ts", import.meta.dir);
const TEST_TIMEOUT_MS = 60_000;
// Each UIA wait can pass its bound by one call. The stuck case waits once for the probe window and once for the stuck thread.
const STUCK_TEST_TIMEOUT_MS = 2 * (MAX_WAIT_MS + MAX_CALL_MS);
// The installed-app case runs nine UIA waits, two process-record probes (the start and the `stop` audit), the `stop` wait, and `waitExit`.
const APP_WAITS = 9;
const APP_TEST_TIMEOUT_MS = APP_WAITS * (MAX_WAIT_MS + MAX_CALL_MS) + 2 * PROBE_TIMEOUT_MS + 2 * WAIT_MS;
// Microsoft Learn "Process Security and Access Rights".
const PROCESS_SUSPEND_RESUME = 0x0800;
const OPEN_FOLDER = "Open folder… (Ctrl+O)";

const code = async (body: () => unknown) => {
  try {
    await body();
  } catch (error) {
    if (error instanceof UiaError) return error.code;
    throw error;
  }
  return null;
};

// A focus wait that times out while another process owns the foreground prints a SKIP line and returns null.
async function focusedOrSkip(label: string, processId: number, name: string, timeoutMs: number): Promise<bigint | null> {
  try {
    return await waitFocus(processId, name, timeoutMs);
  } catch (error) {
    const skip = error instanceof UiaError && error.code === "TIMEOUT" ? foregroundSkip(processId) : null;
    if (skip === null) throw error;
    console.log(`SKIP ${label}: ${skip}`);
    return null;
  }
}

// Releases each element after the body.
async function using<T>(element: Element, body: (element: Element) => T | Promise<T>): Promise<T> {
  try {
    return await body(element);
  } finally {
    element.release();
  }
}

// An owned WPF window off screen. `ShowActivated="False"` keeps the desktop focus with the user.
const FIXTURE = `
Add-Type -AssemblyName PresentationFramework
$w = [Windows.Markup.XamlReader]::Parse(@'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Title="UIA probe" ShowActivated="False" ShowInTaskbar="False" WindowStartupLocation="Manual" Left="-20000" Top="-20000" Width="300" Height="300">
  <StackPanel>
    <TextBox AutomationProperties.Name="Probe field" Text="probe text"/>
    <GroupBox AutomationProperties.Name="Probe group">
      <StackPanel>
        <TextBlock Text="alpha"/>
        <TextBlock Text="beta"/>
      </StackPanel>
    </GroupBox>
    <ListBox AutomationProperties.Name="Probe list">
      <ListBoxItem Content="first"/>
      <ListBoxItem Content="second"/>
    </ListBox>
  </StackPanel>
</Window>
'@)
$w.Show()
[Windows.Threading.Dispatcher]::Run()
`;

describe.skipIf(process.platform !== "win32")("T240 UI Automation driver", () => {
  afterAll(() => close());
  const noFocus = inputDesktopSkip();
  if (noFocus !== null) console.log(`SKIP focus cases: ${noFocus}`);

  test("no file under src/ imports bun:ffi or the driver", () => {
    expect(srcImportHits([UIA])).toEqual([]);
  });

  test("bad arguments refuse before any search", async () => {
    expect(await code(() => find(0, "x", 10))).toBe("BAD_ARGUMENT");
    expect(await code(() => find(process.pid, "", 10))).toBe("BAD_ARGUMENT");
    expect(await code(() => find(process.pid, "x", MAX_WAIT_MS + 1))).toBe("BAD_ARGUMENT");
    expect(await code(() => waitFocus(process.pid, "x", -1))).toBe("BAD_ARGUMENT");
  });

  test(
    "finds and reads elements of an owned WPF window, and refuses with typed errors",
    () =>
      withProbe(FIXTURE, async ({ pid }) => {
        // A WPF TextBox has the Text pattern.
        expect(await using(await find(pid, "Probe field", MAX_WAIT_MS), readText)).toBe("probe text");
        // A GroupBox has no Text pattern, so the Names of its descendants join.
        expect(await using(await find(pid, "Probe group", 2000), readText)).toBe("alphabeta");
        // A WPF TextBlock has no Invoke pattern.
        expect(await using(await find(pid, "alpha", 2000), (text) => code(() => invoke(text)))).toBe("NO_PATTERN");
        const released = await find(pid, "beta", 2000);
        released.release();
        expect(await code(() => readText(released))).toBe("RELEASED");
        expect(await code(() => find(pid, "no such element", 50))).toBe("TIMEOUT");
        expect(await code(() => findLiveRegions(pid, 50))).toBe("TIMEOUT");
        // The fixture never takes focus.
        expect(await code(() => waitFocus(pid, "Probe field", 50))).toBe("TIMEOUT");
      }),
    TEST_TIMEOUT_MS,
  );

  test(
    "selects the second list item",
    () =>
      withProbe(FIXTURE, async ({ pid }) => {
        await using(await find(pid, "second", MAX_WAIT_MS), (item) => {
          expect(isSelected(item)).toBe(false);
          select(item);
          expect(isSelected(item)).toBe(true);
        });
      }),
    TEST_TIMEOUT_MS,
  );

  test(
    "sets the value of the probe field",
    () =>
      withProbe(FIXTURE, async ({ pid }) => {
        await using(await find(pid, "Probe field", MAX_WAIT_MS), (field) => {
          setValue(field, "new text");
          expect(readText(field)).toBe("new text");
        });
      }),
    TEST_TIMEOUT_MS,
  );

  test.skipIf(noFocus !== null)(
    "focuses the probe field",
    () =>
      withProbe(FIXTURE, async ({ pid }) => {
        await using(await find(pid, "Probe field", MAX_WAIT_MS), focus);
        const qpc = await focusedOrSkip("focuses the probe field", pid, "Probe field", 2000);
        if (qpc !== null) expect(qpc).toBeGreaterThan(0n);
      }),
    TEST_TIMEOUT_MS,
  );

  test(
    "a search in a process with a suspended window thread fails with TIMEOUT within MAX_WAIT_MS",
    () =>
      withProbe(FIXTURE, async ({ pid }) => {
        // The first search runs while the thread pumps, and it waits for the window.
        await using(await find(pid, "Probe field", MAX_WAIT_MS), () => {});
        const { OpenProcess, CloseHandle } = dlopen("kernel32.dll", { OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr }, CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 } }).symbols;
        const nt = dlopen("ntdll.dll", { NtSuspendProcess: { args: [FFIType.ptr], returns: FFIType.i32 }, NtResumeProcess: { args: [FFIType.ptr], returns: FFIType.i32 } }).symbols;
        const handle = OpenProcess(PROCESS_SUSPEND_RESUME, 0, pid);
        if (handle === null) throw new Error(`OpenProcess failed for the probe ${pid}`);
        console.log(`STUCK_PROBE ${pid}`);
        try {
          expect(nt.NtSuspendProcess(handle)).toBe(0);
          const started = performance.now();
          expect(await code(() => find(pid, "no such element", 50))).toBe("TIMEOUT");
          const elapsed = performance.now() - started;
          console.log(`STUCK_ELAPSED_MS ${elapsed.toFixed(0)}`);
          expect(elapsed).toBeLessThan(MAX_WAIT_MS);
        } finally {
          nt.NtResumeProcess(handle);
          CloseHandle(handle);
        }
      }),
    STUCK_TEST_TIMEOUT_MS,
  );

  describe("installed app", () => {
    // Bun 1.4.3 runs `afterAll` hooks in declaration order, also when a test timeout leaves its body running. This hook must come before the fixture root removal.
    let owned: OwnedProcess | undefined;
    afterAll(() => owned?.stop());
    useFixtureRoot();
    const found = findInstalledApp();
    const live = "app" in found ? found.app : null;
    const reason = live === null ? (found as { skip: string }).skip : noFocus;
    if (reason !== null) console.log(`SKIP installed app: ${reason}`);

    test.skipIf(reason !== null)(
      "selects Git, opens and cancels the folder picker, and reads the status regions",
      async () => {
        const app = (owned = startInstalledApp(live!, appEnv(fixtureDir("app"), false)));
        try {
          // A new profile holds no Git selection, so the boot view offers Select Git. Its task dialog names the Git that the host finds.
          const label = "selects Git, opens and cancels the folder picker";
          const selected = await using(await find(app.pid, "Select Git", MAX_WAIT_MS), async (button) => {
            focus(button);
            if ((await focusedOrSkip(label, app.pid, "Select Git", MAX_WAIT_MS)) === null) return false;
            invoke(button);
            return true;
          });
          if (!selected) return;
          await using(await find(app.pid, "Use this Git", MAX_WAIT_MS), invoke);
          // The start page option text, `OPEN_FOLDER` in src/frontend/app/RepositorySwitcher.tsx. `find` matches the whole Name.
          // The combobox holds DOM focus. UIA reports its active descendant as the focused element.
          await using(await find(app.pid, "Filter recent repositories", MAX_WAIT_MS), focus);
          if ((await focusedOrSkip(label, app.pid, OPEN_FOLDER, MAX_WAIT_MS)) === null) return;
          await using(await find(app.pid, OPEN_FOLDER, MAX_WAIT_MS), invoke);
          await using(await find(app.pid, "Cancel", MAX_WAIT_MS), invoke);
          console.log(`FOCUS_QPC ${await waitFocus(app.pid, OPEN_FOLDER, MAX_WAIT_MS)}`);
          const regions = await findLiveRegions(app.pid, MAX_WAIT_MS);
          for (const region of regions) console.log(`STATUS_TEXT ${JSON.stringify(await using(region, readText))}`);
        } finally {
          app.stop();
          expect(await waitExit(app)).not.toBeNull();
        }
      },
      APP_TEST_TIMEOUT_MS,
    );
  });
});
