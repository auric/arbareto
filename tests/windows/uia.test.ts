// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, describe, expect, test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { printOrigin } from "../origin";
import { srcImportHits } from "./src-imports";
import { withProbe } from "./probe-window";
import { fixtureDir, fixtureGit, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { appEnv, findInstalledApp, PROBE_TIMEOUT_MS, startInstalledApp, WAIT_MS, waitExit, type OwnedProcess } from "./installed-app";
import { close, collapse, ControlType, expand, find, findLiveRegions, focus, foregroundSkip, inputDesktopSkip, invoke, isEnabled, isSelected, MAX_CALL_MS, MAX_WAIT_MS, readText, readValue, select, setValue, UiaError, waitFocus, type Element } from "./uia";

const UIA = printOrigin("./uia.ts", import.meta.dir);
const TEST_TIMEOUT_MS = 60_000;
// Each UIA wait can pass its bound by one call. The stuck case waits once for the probe window and once for the stuck thread.
const STUCK_TEST_TIMEOUT_MS = 2 * (MAX_WAIT_MS + MAX_CALL_MS);
// The installed-app case runs nine UIA waits, two process-record probes (the start and the `stop` audit), the `stop` wait, and `waitExit`.
const APP_WAITS = 9;
const APP_TEST_TIMEOUT_MS = APP_WAITS * (MAX_WAIT_MS + MAX_CALL_MS) + 2 * PROBE_TIMEOUT_MS + 2 * WAIT_MS;
// Microsoft Learn "Process Security and Access Rights".
const PROCESS_SUSPEND_RESUME = 0x0800;
// `UIAutomationCoreApi.h`: the element is gone.
const UIA_E_ELEMENTNOTAVAILABLE = 0x8004_0201;
// The T241 case runs 14 UIA waits, a menu-close wait, 6 state waits, and 3 status-text waits, plus the same probes and waits as the case above.
const T241_WAITS = 24;
const T241_TEST_TIMEOUT_MS = T241_WAITS * (MAX_WAIT_MS + MAX_CALL_MS) + 2 * PROBE_TIMEOUT_MS + 2 * WAIT_MS;
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

// Polls the live regions until one reads `text`, and returns the texts that each poll read.
async function waitStatus(processId: number, text: string): Promise<string[]> {
  const seen = new Set<string>();
  for (const until = performance.now() + MAX_WAIT_MS; performance.now() < until; await Bun.sleep(50)) {
    for (const region of await findLiveRegions(processId, Math.max(0, Math.ceil(until - performance.now())))) seen.add(await using(region, readText));
    if (seen.has(text)) return [...seen];
  }
  throw new Error(`no status region reads ${JSON.stringify(text)} after ${MAX_WAIT_MS} ms: ${JSON.stringify([...seen])}`);
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
          expect(readValue(field)).toBe("new text");
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
    const owned = new Set<OwnedProcess>();
    afterAll(() => {
      for (const app of owned) app.stop();
    });
    useFixtureRoot();
    const found = findInstalledApp();
    const live = "app" in found ? found.app : null;
    const reason = live === null ? (found as { skip: string }).skip : noFocus;
    if (reason !== null) console.log(`SKIP installed app: ${reason}`);

    test.skipIf(reason !== null)(
      "selects Git, opens and cancels the folder picker, and reads the status regions",
      async () => {
        const app = startInstalledApp(live!, appEnv(fixtureDir("app"), false));
        owned.add(app);
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

    // T241 needs no keyboard focus, so a locked session does not skip it.
    const repoReason = live === null ? (found as { skip: string }).skip : GIT === null ? "Git executable absent" : null;
    if (repoReason !== null) console.log(`SKIP T241 names: ${repoReason}`);

    test.skipIf(repoReason !== null)(
      "T241: opens a fixture repository through UIA patterns and resolves the workbench names",
      async () => {
        const repo = fixtureDir("repo");
        fixtureGit(GIT!, repo, ["init", "-q"]);
        writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
        fixtureGit(GIT!, repo, ["add", "a.txt"]);
        fixtureGit(GIT!, repo, ["commit", "-q", "-m", "first"]);
        writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\n");
        // A git:// remote that accepts and never answers keeps a fetch running until Cancel.
        const sockets: unknown[] = [];
        const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: (socket) => void sockets.push(socket), data() {} } });
        fixtureGit(GIT!, repo, ["remote", "add", "origin", `git://127.0.0.1:${silent.port}/silent`]);
        const top = fixtureGit(GIT!, repo, ["rev-parse", "--show-toplevel"]).trimEnd();
        const app = startInstalledApp(live!, appEnv(fixtureDir("t241-app"), false));
        owned.add(app);
        const found = async (name: string, controlType?: number, body: (element: Element) => unknown = () => {}) => {
          await using(await find(app.pid, name, MAX_WAIT_MS, controlType), body);
          console.log(`T241_NAME ${JSON.stringify(name)} found`);
        };
        // A render can replace an element, so each poll finds it again. `act` runs until `done` holds.
        const actUntil = async (name: string, controlType: number | undefined, done: (element: Element) => boolean, act: (element: Element) => void) => {
          for (const end = performance.now() + MAX_WAIT_MS; ; await Bun.sleep(10)) {
            const element = await find(app.pid, name, Math.max(0, Math.ceil(end - performance.now())), controlType);
            try {
              if (done(element)) return console.log(`T241_NAME ${JSON.stringify(name)} found`);
              act(element);
            } catch (error) {
              if (!(error instanceof UiaError && error.hresult === UIA_E_ELEMENTNOTAVAILABLE)) throw error;
            } finally {
              element.release();
            }
            if (performance.now() >= end) throw new Error(`${JSON.stringify(name)} did not reach its state after ${MAX_WAIT_MS} ms`);
          }
        };
        // Each hunk control and Fetch stay disabled until their data arrives.
        const invokeEnabled = (name: string) => {
          let invoked = false;
          return actUntil(name, ControlType.Button, () => invoked, (button) => {
            if (!isEnabled(button)) return;
            invoke(button);
            invoked = true;
          });
        };
        try {
          await found("Select Git", ControlType.Button, invoke);
          await found("Use this Git", undefined, invoke);
          await found(OPEN_FOLDER, undefined, invoke);
          // The Windows folder picker: the Edit has the Name of its label, and its dialog window has the Name of the OK button.
          await found("Folder:", ControlType.Edit, (field) => setValue(field, repo));
          await found("Select Folder", ControlType.Button, invoke);
          // `RepositorySwitcher.tsx`: the trigger label is the folder name and the Git worktree root.
          await found(`${basename(top)}, ${top}`, ControlType.Button);
          await found("References", ControlType.Tree);
          // React sets `aria-selected` after the select event, so the property changes later.
          await actUntil("Working directory, 1 working change", undefined, isSelected, select);
          await found("Commit (Ctrl+Enter)", ControlType.Button);
          // The renderer applies the value after the call returns.
          await actUntil("Commit message", ControlType.Edit, (field) => readValue(field) === "T241 message", (field) => setValue(field, "T241 message"));
          // A row click shows the file. Invoke runs the click.
          await actUntil("a.txt", undefined, isSelected, invoke);
          await found("Stage file (Space)", ControlType.Button);
          await invokeEnabled("Next hunk");
          await invokeEnabled("Stage selected hunk");
          console.log(`STATUS_TEXT ${JSON.stringify(await waitStatus(app.pid, "Hunk staged"))}`);
          // `specialParts` in `HistoryView.tsx`: the Index row name. The renderer takes it and the new generation from the same reconcile read (T381).
          await found("Index, 1 staged");
          await invokeEnabled("Fetch");
          // A refused review starts no fetch. The wait error then holds the status texts.
          console.log(`STATUS_TEXT ${JSON.stringify(await waitStatus(app.pid, "Fetching from origin…"))}`);
          // The sync toolbar Cancel is named "Cancel Fetch", so "Cancel" is the status bar control.
          await found("Cancel", ControlType.Button, invoke);
          console.log(`STATUS_TEXT ${JSON.stringify(await waitStatus(app.pid, "Fetch canceled"))}`);
          // `RepositoryMenu.tsx`: the menu holds Revoke trust. The Base UI menu exists in the tree only while it is open.
          await found("Repository", ControlType.MenuItem, expand);
          await found("Revoke trust", ControlType.MenuItem);
          await found("Repository", ControlType.MenuItem, collapse);
          // A single probe with a zero bound gives TIMEOUT once the closed menu leaves the tree.
          for (const end = performance.now() + MAX_WAIT_MS; ; await Bun.sleep(10)) {
            if ((await code(async () => (await find(app.pid, "Revoke trust", 0, ControlType.MenuItem)).release())) === "TIMEOUT") break;
            if (performance.now() >= end) throw new Error(`the Repository menu stays open ${MAX_WAIT_MS} ms after collapse`);
          }
        } finally {
          app.stop();
          silent.stop(true);
          expect(await waitExit(app)).not.toBeNull();
        }
      },
      T241_TEST_TIMEOUT_MS,
    );
  });
});
