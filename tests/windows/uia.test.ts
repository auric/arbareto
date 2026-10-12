// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { srcImportHits } from "./src-imports";
import { fixtureDir, useFixtureRoot } from "../git/fixture-root";
import { appEnv, findInstalledApp, startInstalledApp, waitExit } from "./installed-app";
import { close, find, findLiveRegions, invoke, MAX_WAIT_MS, readText, UiaError, waitFocus, type Element } from "./uia";

const UIA = printOrigin("./uia.ts", import.meta.dir);
const TEST_TIMEOUT_MS = 60_000;
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
  </StackPanel>
</Window>
'@)
$w.Show()
[Windows.Threading.Dispatcher]::Run()
`;

describe.skipIf(process.platform !== "win32")("T240 UI Automation driver", () => {
  afterAll(() => close());

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
    async () => {
      const shell = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const fixture = Bun.spawn([shell, "-NoProfile", "-NonInteractive", "-Command", FIXTURE], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
      try {
        // A WPF TextBox has the Text pattern.
        expect(await using(await find(fixture.pid, "Probe field", MAX_WAIT_MS), readText)).toBe("probe text");
        // A GroupBox has no Text pattern, so the Names of its descendants join.
        expect(await using(await find(fixture.pid, "Probe group", 2000), readText)).toBe("alphabeta");
        // A WPF TextBlock has no Invoke pattern.
        expect(await using(await find(fixture.pid, "alpha", 2000), (text) => code(() => invoke(text)))).toBe("NO_PATTERN");
        const released = await find(fixture.pid, "beta", 2000);
        released.release();
        expect(await code(() => readText(released))).toBe("RELEASED");
        expect(await code(() => find(fixture.pid, "no such element", 50))).toBe("TIMEOUT");
        expect(await code(() => findLiveRegions(fixture.pid, 50))).toBe("TIMEOUT");
        // The fixture never takes focus.
        expect(await code(() => waitFocus(fixture.pid, "Probe field", 50))).toBe("TIMEOUT");
      } finally {
        fixture.kill();
        await fixture.exited;
      }
    },
    TEST_TIMEOUT_MS,
  );

  describe("installed app", () => {
    useFixtureRoot();
    const found = findInstalledApp();
    const live = "app" in found ? found.app : null;
    if (live === null) console.log(`SKIP installed app: ${(found as { skip: string }).skip}`);

    test.skipIf(live === null)(
      "selects Git, opens and cancels the folder picker, and reads the status regions",
      async () => {
        const owned = startInstalledApp(live!, appEnv(fixtureDir("app"), false));
        try {
          // A new profile holds no Git selection, so the boot view offers Select Git. Its task dialog names the Git that the host finds.
          await using(await find(owned.pid, "Select Git", MAX_WAIT_MS), invoke);
          await using(await find(owned.pid, "Use this Git", MAX_WAIT_MS), invoke);
          // The start page option text, `OPEN_FOLDER` in src/frontend/app/RepositorySwitcher.tsx. `find` matches the whole Name.
          await using(await find(owned.pid, OPEN_FOLDER, MAX_WAIT_MS), invoke);
          await using(await find(owned.pid, "Cancel", MAX_WAIT_MS), invoke);
          console.log(`FOCUS_QPC ${await waitFocus(owned.pid, OPEN_FOLDER, MAX_WAIT_MS)}`);
          const regions = await findLiveRegions(owned.pid, MAX_WAIT_MS);
          for (const region of regions) console.log(`STATUS_TEXT ${JSON.stringify(await using(region, readText))}`);
        } finally {
          owned.stop();
          expect(await waitExit(owned)).not.toBeNull();
        }
      },
      TEST_TIMEOUT_MS,
    );
  });
});
