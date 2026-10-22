// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T124: keyboard checks in the installed package through the WebView2 CDP endpoint (T121 to T123).
// The keys go to the page through CDP `Input.dispatchKeyEvent`. The test sends no OS input and never moves the pointer.
// It does not replace one live-input check of the native key path (tests/windows/inject.ts, ARBARETO_LIVE_INPUT).

import { afterAll, describe, expect, test } from "bun:test";
import { isAbsolute, relative } from "node:path";
import { sectionOrder } from "../../src/frontend/keyboard/shortcuts";
import { printOrigin } from "../origin";
import { fixtureDir, fixturePath, FIXTURE_ROOT, useFixtureRoot } from "../git/fixture-root";
import { buildF02 } from "../git/fixtures";
import { GIT } from "../git/git-binary";
import { connectPage, freePort, MOD, type Cdp } from "./cdp";
import { appEnv, findInstalledApp, processRecords, startInstalledApp, type OwnedProcess } from "./installed-app";
import { close, ControlType, expand, find, invoke, MAX_WAIT_MS, setValue, type Element } from "./uia";

for (const helper of ["./cdp.ts", "./uia.ts", "./installed-app.ts", "../git/fixtures.ts", "../git/fixture-root.ts", "../../src/frontend/keyboard/shortcuts.ts"]) printOrigin(helper, import.meta.dir);

const TASK = "T124";
const CASE_MS = 120_000;
// A view change and a status read after a key stay far below it.
const KEY_WAIT_MS = 5_000;

// `OPEN_FOLDER` in src/frontend/app/RepositorySwitcher.tsx.
const OPEN_FOLDER = "Open folder… (Ctrl+O)";
// `WORKING_ROW` in src/frontend/history/HistoryList.tsx.
const WORKING_ROW = "working-directory";
// The `navButton` label in src/frontend/changes/HunkControls.tsx.
const PREVIOUS_HUNK = "Previous hunk";

interface Active {
  tag: string | null;
  role: string | null;
  label: string | null;
  section: string | null;
  changed: boolean;
}
// `window.__prev` holds the element that had focus before the last key.
const ACTIVE = `(() => { const a = document.activeElement; const s = a?.closest('[data-section]'); return { tag: a?.tagName ?? null, role: a?.getAttribute('role') ?? null, label: a?.getAttribute('aria-label') ?? null, section: s?.dataset.section ?? null, changed: a !== window.__prev }; })()`;
const MARK = "window.__prev = document.activeElement; true";

async function use<T>(element: Promise<Element>, body: (element: Element) => T): Promise<T> {
  const found = await element;
  try {
    return body(found);
  } finally {
    found.release();
  }
}
const uia = <T>(pid: number, name: string, type: number | undefined, body: (element: Element) => T) => use(find(pid, name, MAX_WAIT_MS, type), body);

describe.skipIf(process.platform !== "win32")("T124 packaged keys through CDP", () => {
  // Bun 1.4.3 runs `afterAll` hooks in declaration order. This hook must come before the fixture root removal.
  let app: OwnedProcess | null = null;
  let cdp: Cdp | null = null;
  afterAll(() => {
    cdp?.close();
    app?.stop();
    close();
  });
  useFixtureRoot();

  const discovery = findInstalledApp();
  const installed = "app" in discovery ? discovery.app : null;
  const others = installed === null ? [] : processRecords().filter((r) => r.name.toLowerCase() === installed.mainBinaryName.toLowerCase());
  const reason =
    installed === null ? (discovery as { skip: string }).skip : GIT === null ? "Git executable absent" : others.length > 0 ? `another-instance: ${installed.mainBinaryName} runs as PID ${others.map((r) => r.pid).join(", ")}` : null;
  if (reason !== null) console.log(`SKIP installed app: ${reason}`);

  let session: Promise<{ pid: number; cdp: Cdp }> | null = null;
  // One app session serves all cases in order. The first case starts it.
  const open = () => (session ??= start());
  async function start(): Promise<{ pid: number; cdp: Cdp }> {
    const built = buildF02(GIT!, "F02", "base");
    const repo = fixturePath(relative(FIXTURE_ROOT, built.root), "repo");
    if (repo === "" || !isAbsolute(repo)) throw new Error(`the repository path is not absolute: ${JSON.stringify(repo)}`);
    console.log(`REPO ${TASK}: ${repo}`);
    const env = appEnv(fixtureDir("keys-app"), false);
    const port = freePort();
    env.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port}`;
    console.log(`CDP_PORT ${TASK}: ${port}`);
    app = startInstalledApp(installed!, env);
    console.log(`STARTED ${TASK}: ${app.pid} profile=${env.set.ARBARETO_PROFILE_ROOT}`);
    const pid = app.pid;
    // A new profile holds no Git selection, so the boot view offers Select Git (uia.test.ts T241).
    await uia(pid, "Select Git", ControlType.Button, invoke);
    await uia(pid, "Use this Git", undefined, invoke);
    await uia(pid, OPEN_FOLDER, undefined, invoke);
    // The Windows folder picker: the Edit has the Name of its label, and its dialog window has the Name of the OK button.
    await uia(pid, "Folder:", ControlType.Edit, (field) => setValue(field, repo));
    await uia(pid, "Select Folder", ControlType.Button, invoke);
    await uia(pid, "References", ControlType.Tree, () => {});
    cdp = await connectPage(port, MAX_WAIT_MS);
    console.log(`CDP_PAGE ${TASK}: ${cdp.url}`);
    return { pid, cdp };
  }

  async function press(c: Cdp, name: string, modifiers = 0, commands?: string[]): Promise<Active> {
    await c.evaluate(MARK);
    await c.key(name, modifiers, commands);
    const active = await c.poll<Active>(ACTIVE, (a) => a.changed, KEY_WAIT_MS);
    console.log(`KEY ${TASK}: ${name} mods=${modifiers} -> ${JSON.stringify(active)}`);
    return active;
  }

  test.skipIf(reason !== null)(
    "Enter on the History Working directory row moves focus to a Working changes row",
    async () => {
      const { cdp: c } = await open();
      const row = await c.evaluate<string | null>(`(() => { const l = document.querySelector('[data-history-list]'); l.focus(); return document.getElementById(l.getAttribute('aria-activedescendant'))?.dataset.rowId ?? null; })()`);
      // The list keeps focus and moves `aria-activedescendant` only.
      if (row !== WORKING_ROW) await c.key("Home");
      expect(await c.evaluate<string | null>(`document.getElementById(document.querySelector('[data-history-list]').getAttribute('aria-activedescendant'))?.dataset.rowId ?? null`)).toBe(WORKING_ROW);
      await c.evaluate(MARK);
      await c.key("Enter");
      const active = await c.poll<Active>(ACTIVE, (a) => a.role === "treeitem" && a.section === "workingChanges", KEY_WAIT_MS);
      console.log(`KEY ${TASK}: Enter -> ${JSON.stringify(active)}`);
      expect({ role: active.role, section: active.section }).toEqual({ role: "treeitem", section: "workingChanges" });
    },
    CASE_MS,
  );

  test.skipIf(reason !== null)(
    "with no file selected, each F6 moves focus to another section of the Commit view",
    async () => {
      const { cdp: c } = await open();
      expect(await c.evaluate<number>(`document.querySelectorAll('[data-section=workingChanges] [role=treeitem][aria-selected=true], [data-section=staged] [role=treeitem][aria-selected=true]').length`)).toBe(0);
      let previous = (await c.evaluate<Active>(ACTIVE)).section;
      const seen: (string | null)[] = [previous];
      // Each visible stop of the Commit order gets focus once in one round.
      for (let i = 0; i < sectionOrder("commit").length; i++) {
        const active = await press(c, "F6");
        seen.push(active.section);
        expect({ step: i + 1, changed: active.changed, sameSection: active.section === previous }).toEqual({ step: i + 1, changed: true, sameSection: false });
        previous = active.section;
      }
      console.log(`F6_ORDER ${TASK}: ${JSON.stringify(seen)}`);
    },
    CASE_MS,
  );

  test.skipIf(reason !== null)(
    "with a file selected, F6 goes from Working changes to Staged to the diff, and Alt+Down there disables Previous hunk",
    async () => {
      const { cdp: c } = await open();
      const focused = await c.evaluate<number>(
        `(() => { const rows = [...document.querySelectorAll('[role=treeitem][aria-label="multi.txt"]')].filter((e) => e.closest('[data-section]')?.dataset.section === 'workingChanges'); rows[0]?.focus(); return rows.length; })()`,
      );
      expect(focused).toBe(1);
      await c.key("Enter");
      const selected = await c.poll<Active & { selected: boolean }>(
        `(() => ({ ...${ACTIVE}, selected: document.activeElement?.getAttribute('aria-selected') === 'true' }))()`,
        (a) => a.selected && a.section === "workingChanges",
        KEY_WAIT_MS,
      );
      expect({ selected: selected.selected, section: selected.section, label: selected.label }).toEqual({ selected: true, section: "workingChanges", label: "multi.txt" });
      const previousHunk = `[...document.querySelectorAll('[data-section=comparison] button')].filter((b) => b.getAttribute('aria-label') === ${JSON.stringify(PREVIOUS_HUNK)}).map((b) => b.disabled || b.getAttribute('aria-disabled') === 'true')`;
      // The first diff of a session remounts the comparison view under the Pierre worker pool (ComparisonViewMount `pool`), and the focus inside it goes to BODY.
      // The hunk controls render only after that remount, so F6 waits for them.
      expect(await c.poll<boolean[]>(previousHunk, (v) => v.length > 0, KEY_WAIT_MS)).toEqual([false]);
      const order = [(await press(c, "F6")).section, (await press(c, "F6")).section];
      expect(order).toEqual(["staged", "comparison"]);
      expect((await c.evaluate<Active>(ACTIVE)).section).toBe("comparison");
      await c.key("ArrowDown", MOD.Alt);
      expect(await c.poll<boolean[]>(previousHunk, (v) => v[0] === true, KEY_WAIT_MS)).toEqual([true]);
    },
    CASE_MS,
  );

  test.skipIf(reason !== null)(
    "About Overview: the Build line is selectable, and Ctrl+A selects only inside the About panel",
    async () => {
      const { pid, cdp: c } = await open();
      // A menubar trigger has ExpandCollapse and no Invoke in UIA.
      await uia(pid, "Help", ControlType.MenuItem, expand);
      await uia(pid, "About Arbareto", ControlType.MenuItem, invoke);
      expect(await c.poll<boolean>(`!!document.querySelector('[role=dialog] [role=tabpanel]')`, (v) => v, KEY_WAIT_MS)).toBe(true);
      const build = await c.evaluate<{ count: number; userSelect: string | null; text: string | null }>(
        `(() => { const p = [...document.querySelectorAll('[role=dialog] [role=tabpanel] p')].filter((e) => e.textContent.startsWith('Build:')); return { count: p.length, userSelect: p[0] ? getComputedStyle(p[0]).userSelect : null, text: p[0]?.textContent ?? null }; })()`,
      );
      console.log(`ABOUT_BUILD ${TASK}: ${JSON.stringify(build)}`);
      expect(build.count).toBe(1);
      expect(build.userSelect).not.toBe("none");
      await c.evaluate(`document.querySelector('[role=dialog] [role=tabpanel]').focus(); true`);
      await c.key("a", MOD.Ctrl, ["selectAll"]);
      const selection = await c.evaluate<{ ranges: number; inside: boolean; text: string }>(
        `(() => { const s = getSelection(); const panel = document.querySelector('[role=dialog] [role=tabpanel]'); return { ranges: s.rangeCount, inside: s.rangeCount === 1 && panel.contains(s.getRangeAt(0).commonAncestorContainer), text: String(s) }; })()`,
      );
      console.log(`ABOUT_SELECTION ${TASK}: ${JSON.stringify({ ...selection, text: selection.text.slice(0, 80) })}`);
      expect({ ranges: selection.ranges, inside: selection.inside, hasBuild: selection.text.includes(build.text ?? "\0") }).toEqual({ ranges: 1, inside: true, hasBuild: true });
    },
    CASE_MS,
  );

  test.skipIf(reason !== null)(
    "Escape closes About",
    async () => {
      const { cdp: c } = await open();
      expect(await c.evaluate<boolean>(`!!document.querySelector('[role=dialog]')`)).toBe(true);
      await c.key("Escape");
      expect(await c.poll<boolean>(`!!document.querySelector('[role=dialog]')`, (v) => !v, KEY_WAIT_MS)).toBe(false);
    },
    CASE_MS,
  );
});
