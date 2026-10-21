// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { ReadGitSettingsResult, ReviewWorkbenchResult, RunWorkbenchResult, SyncSettings } from "../../src/contracts/envelope";
import { sectionOrder } from "../../src/frontend/keyboard/shortcuts";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { contractChecked, fixtureId } from "./bridge-contract";
import { button, click, press, settings, settle, text, tooltipText, type Call } from "./sync-fake";
import type { SettingsViewProps } from "../../src/frontend/settings/SettingsView";
import type { StatusOperation } from "../../src/frontend/status/OperationStatus";

// tasks.md T065 (feature 004, WP22). Story US6. Spec FR-058 to FR-068. Plan D11, D15, O-7, O-10. Contract Δ3 `readGitSettings`, `config-save`, `setSwitchChoice`, Δ14. Data-model §9, §13.

printOrigin("../../src/frontend/settings/SettingsView.tsx", import.meta.dir);
printOrigin("../../src/frontend/settings/git/GitSettingsPage.tsx", import.meta.dir);
printOrigin("../../src/frontend/settings/git/presets.ts", import.meta.dir);
registerDom();
const { createRoot } = await import("react-dom/client");
const { SettingsView } = await import("../../src/frontend/settings/SettingsView");

const TARGET = { repositoryId: fixtureId(1), repositoryGeneration: 1 };
const TOKEN = fixtureId(10);
const LOCAL = "C:/Repos/sample/.git/config";
const GLOBAL = "C:/Users/a/.gitconfig";
const SYSTEM = "C:/Program Files/Git/etc/gitconfig";
const FR060 = ["user.name", "user.email", "core.editor", "commit.template", "credential.helper", "diff.tool", "merge.tool", "core.autocrlf", "i18n.filesencoding", "pull.rebase", "fetch.prune", "merge.autostash", "rebase.autostash", "rebase.autosquash", "rebase.updaterefs", "rerere.enabled", "rerere.autoupdate", "pull.ff", "push.default", "push.autosetupremote"];
const BOOLS = new Set(["fetch.prune", "merge.autostash", "rebase.autostash", "rebase.autosquash", "rebase.updaterefs", "rerere.enabled", "rerere.autoupdate", "push.autosetupremote"]);
const ENUMS: Record<string, string[]> = { "core.autocrlf": ["true", "false", "input"], "pull.rebase": ["true", "false", "merges", "interactive"], "pull.ff": ["true", "false", "only"], "push.default": ["nothing", "current", "upstream", "simple", "matching", "tracking"] };

type Entry = { scope: "system" | "global" | "local" | "worktree" | "command"; origin: string; value: string | null; reading?: string | null };
type ReadOnly = "multi-value" | "included" | "unreadable-value" | null;
function configValue(key: string, entries: Entry[] = [], readOnly: { local?: ReadOnly; global?: ReadOnly } = {}) {
  const full = entries.map((e) => ({ scope: e.scope, origin: e.origin, value: e.value, reading: e.reading === undefined ? e.value : e.reading }));
  const type = BOOLS.has(key) ? { kind: "bool" } : ENUMS[key] ? { kind: "enum", values: ENUMS[key] } : { kind: "text" };
  const scopes = Object.fromEntries((["system", "global", "local", "worktree", "command"] as const).map((s) => [s, full.filter((e) => e.scope === s)]));
  return { key, type, entries: full, effective: full.at(-1) ?? null, scopes, readOnly: { local: readOnly.local ?? null, global: readOnly.global ?? null } };
}
const local = (value: string | null, reading?: string | null): Entry => ({ scope: "local", origin: `file:${LOCAL}`, value, reading });
const global = (value: string | null, reading?: string | null): Entry => ({ scope: "global", origin: `file:${GLOBAL}`, value, reading });
const system = (value: string | null): Entry => ({ scope: "system", origin: `file:${SYSTEM}`, value });

type Values = Record<string, ReturnType<typeof configValue>>;
function gitSettings(over: Values = {}, files: Partial<Record<"local" | "global" | "system", string | null>> = {}) {
  const values = [...FR060.map((key) => over[key] ?? configValue(key)), ...Object.keys(over).filter((k) => !FR060.includes(k)).map((k) => over[k]!)];
  const result = ReadGitSettingsResult.parse({ values, files: { local: LOCAL, global: GLOBAL, system: SYSTEM, ...files } });
  return { requestId: fixtureId(30), operationId: fixtureId(31), state: "succeeded", repositoryGeneration: 1, result };
}
const sync = (fields: Record<string, unknown> = {}) => ({ requestId: fixtureId(32), state: "succeeded", result: SyncSettings.parse({ ...settings("pull"), ...fields }) });
function reviewed(scope: "local" | "global", changes: { key: string; value: string | null; earlier: { origin: string; value: string | null } | null }[]) {
  const result = ReviewWorkbenchResult.parse({ action: "config-save", plan: { scope, changes }, workbenchToken: TOKEN });
  return { requestId: fixtureId(20), operationId: fixtureId(21), state: "succeeded", repositoryGeneration: 1, result };
}
function ran(state: string, fields: Record<string, unknown>, code?: string) {
  const result = RunWorkbenchResult.parse({ action: "config-save", scope: "local", written: [], ...fields });
  return { requestId: fixtureId(22), operationId: fixtureId(23), state, ...(code === undefined ? {} : { code }), repositoryGeneration: 1, result };
}

// `readSyncSettings` and `readGitSettings` answer from the fixtures. Every other call waits for the test.
function createDouble(git: unknown, app: unknown) {
  const calls: Call[] = [];
  const make =
    (operation: string) =>
    (...args: unknown[]) =>
      new Promise((resolve) => {
        const call: Call = { operation, args, done: false, resolve: (r) => void ((call.done = true), resolve(r)) };
        calls.push(call);
        if (operation === "readSyncSettings") setTimeout(() => call.resolve(app), 0);
        if (operation === "readGitSettings") setTimeout(() => call.resolve(double.git), 0);
      });
  const names = ["readSyncSettings", "setSshClient", "chooseSyncPath", "clearSyncPath", "launchPuttygen", "setDefaultPullAction", "setSwitchChoice", "readGitSettings", "reviewWorkbench", "runWorkbench"];
  const bridge = contractChecked(Object.fromEntries(names.map((n) => [n, make(n)]))) as unknown as SettingsViewProps["bridge"];
  const of = (operation: string) => calls.filter((c) => c.operation === operation);
  const double = { bridge, calls, git, of, pending: (operation: string) => of(operation).find((c) => !c.done), writes: () => calls.filter((c) => !c.operation.startsWith("read")).map((c) => c.operation) };
  return double;
}

const roots: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of roots.splice(0)) await unmount();
});
type Options = { git?: unknown; app?: unknown; target?: typeof TARGET | null; page?: string; wsl?: boolean };
async function render(options: Options = {}) {
  const double = createDouble(options.git ?? gitSettings(), options.app ?? sync());
  const operations: StatusOperation[] = [];
  const ended: unknown[] = [];
  let closed = 0;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const target = options.target === undefined ? TARGET : options.target;
  await act(async () =>
    root.render(
      <SettingsView
        bridge={double.bridge}
        target={target}
        wsl={options.wsl ?? false}
        repository={target === null ? null : { worktreeKey: "a".repeat(64), proposals: [] }}
        operationRunning={false}
        onOperation={(op) => void operations.push(op)}
        onEnded={(response) => void ended.push(response)}
        page={options.page}
        onClose={() => void (closed += 1)}
      />,
    ),
  );
  roots.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await settle();
  return { double, operations, ended, closed: () => closed };
}

const view = () => document.querySelector<HTMLElement>('[data-view="settings"]')!;
const section = (name: string) => document.querySelector<HTMLElement>(`[data-section="${name}"]`)!;
const pageNames = () => [...section("pageList").querySelectorAll('[role="tab"]')].map((t) => text(t));
const content = () => section("pageContent");
const row = (key: string) => {
  const found = content().querySelector<HTMLElement>(`[data-key="${key}"]`);
  if (found === null) throw new Error(`no row for ${key}: ${text(content())}`);
  return found;
};
const labelInput = (scope: Element, label: string) => {
  const found = [...scope.querySelectorAll<HTMLLabelElement>("label")].find((l) => text(l) === label);
  if (found === undefined) throw new Error(`no label "${label}" in: ${text(scope)}`);
  return (found.control ?? found.querySelector("input")) as HTMLInputElement;
};
async function page(name: string) {
  const tab = [...section("pageList").querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => text(t) === name);
  if (tab === undefined) throw new Error(`no page "${name}": ${pageNames().join(" | ")}`);
  await click(tab);
}
async function scope(value: "effective" | "local" | "global" | "system") {
  await click(section("scopeBar").querySelector<HTMLInputElement>(`input[name="scope"][value="${value}"]`)!);
}
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
async function answer(call: Call | undefined, response: unknown) {
  if (call === undefined) throw new Error("no pending call");
  await act(async () => call.resolve(response));
  await settle();
}

describe("scopes and sources (FR-058, FR-059)", () => {
  test("the scope bar offers Effective, This repository, Global, and System, with Effective and System read-only", async () => {
    await render({ git: gitSettings({ "fetch.prune": configValue("fetch.prune", [global("true")]) }) });
    const bar = section("scopeBar");
    expect([...bar.querySelectorAll<HTMLInputElement>('input[name="scope"]')].map((i) => i.value)).toEqual(["effective", "local", "global", "system"]);
    expect(text(bar)).toContain("Effective read only");
    expect(text(bar)).toContain("System read only");
    await page("Fetch");
    await scope("effective");
    expect([...row("fetch.prune").querySelectorAll("input, select")].every((c) => (c as HTMLInputElement).disabled || (c as HTMLInputElement).readOnly)).toBe(true);
    await scope("system");
    expect([...row("fetch.prune").querySelectorAll("input, select")].every((c) => (c as HTMLInputElement).disabled || (c as HTMLInputElement).readOnly)).toBe(true);
  });

  test("Effective shows the value with its scope and source file, and This repository names the file that a save writes", async () => {
    await render({ git: gitSettings({ "user.name": configValue("user.name", [system("Sys"), global("Ada")]) }) });
    await scope("effective");
    expect(text(row("user.name"))).toContain("Ada");
    expect(text(row("user.name"))).toContain(`from Global (file:${GLOBAL})`);
    await scope("local");
    expect(text(section("scopeBar"))).toContain(`Writes to ${LOCAL}`);
    await scope("global");
    expect(text(section("scopeBar"))).toContain(`Writes to ${GLOBAL}`);
    await scope("system");
    expect(text(row("user.name"))).toContain("Sys");
    expect(text(row("user.name"))).toContain(`file:${SYSTEM}`);
  });

  test("a global file that the service cannot name makes Global read-only", async () => {
    await render({ git: gitSettings({}, { global: null }) });
    await scope("global");
    expect(text(section("scopeBar"))).toContain("Arbareto cannot name the global Git configuration file, so Global is read only.");
    expect((row("user.name").querySelector("input") as HTMLInputElement).readOnly).toBe(true);
  });

  test("without a repository, Settings shows the app pages, and the Git pages need an open repository", async () => {
    const r = await render({ target: null });
    expect(r.double.of("readGitSettings").length).toBe(0);
    expect(pageNames()).toEqual(["User", "Editor and tools", "Line endings", "Pull and push", "Fetch", "Merge and rebase", "Credentials", "Advanced", "SSH", "Clone", "Branch switch"]);
    expect(text(content())).toContain("SSH client");
    await page("User");
    expect(text(content())).toContain("Git settings need an open repository.");
    await page("Pull and push");
    expect(text(content())).toContain("Git settings need an open repository.");
    expect(text(content())).toContain("Pull button default");
  });
});

describe("pages and controls (FR-060 to FR-062, FR-067)", () => {
  test("the FR-060 pages hold every FR-060 key and the tool keys of the effective tools", async () => {
    const git = gitSettings({ "merge.tool": configValue("merge.tool", [global("bc")]), "mergetool.bc.path": configValue("mergetool.bc.path"), "mergetool.bc.cmd": configValue("mergetool.bc.cmd") });
    await render({ git });
    expect(pageNames().slice(0, 8)).toEqual(["User", "Editor and tools", "Line endings", "Pull and push", "Fetch", "Merge and rebase", "Credentials", "Advanced"]);
    const seen = new Set<string>();
    for (const name of pageNames().slice(0, 8)) {
      await page(name);
      for (const r of content().querySelectorAll<HTMLElement>("[data-key]")) seen.add(r.dataset.key!);
    }
    expect([...seen].sort()).toEqual([...FR060, "mergetool.bc.path", "mergetool.bc.cmd"].sort());
  });

  test("a boolean key offers Not set, On, and Off, and Not set states the effective value and its scope (FR-061)", async () => {
    await render({ git: gitSettings({ "push.autosetupremote": configValue("push.autosetupremote", [global("true")]) }) });
    await page("Pull and push");
    await scope("local");
    const r = row("push.autosetupremote");
    expect(labelInput(r, "Not set").checked).toBe(true);
    expect(labelInput(r, "On").checked).toBe(false);
    expect(labelInput(r, "Off").checked).toBe(false);
    expect(text(r)).toContain("Not set here. Git then uses true from Global.");
    await scope("global");
    expect(labelInput(row("push.autosetupremote"), "On").checked).toBe(true);
    expect(text(row("push.autosetupremote"))).not.toContain("Not set here.");
    await page("Advanced");
    expect(text(row("rerere.enabled"))).toContain("Not set here. No other scope sets it, so Git uses its default.");
  });

  test("the Not set note shows only when the selected scope holds no entry for the key (plan D15)", async () => {
    await render({ git: gitSettings({ "push.autosetupremote": configValue("push.autosetupremote", [global("true"), local("false")]) }) });
    await page("Pull and push");
    await scope("local");
    const r = row("push.autosetupremote");
    expect(labelInput(r, "Off").checked).toBe(true);
    expect(text(r)).not.toContain("Not set here.");
    expect(r.querySelector('[role="radiogroup"]')!.hasAttribute("aria-describedby")).toBe(false);
    await scope("global");
    expect(labelInput(row("push.autosetupremote"), "On").checked).toBe(true);
    expect(text(row("push.autosetupremote"))).not.toContain("Not set here.");
  });

  test("an enumerated key offers Not set and each documented value with a readable label and the exact Git value (FR-061)", async () => {
    const r = await render();
    await page("Pull and push");
    await scope("local");
    expect([...row("push.default").querySelectorAll("label")].map((l) => text(l))).toEqual([
      "Not set",
      "Push nothing without a named branch (nothing)",
      "Current branch to a branch of the same name (current)",
      "Current branch to its upstream branch (upstream)",
      "Current branch to its upstream branch of the same name (simple)",
      "All branches with a remote branch of the same name (matching)",
      "Old name of upstream (tracking)",
    ]);
    expect(row("pull.rebase").querySelector('label span span[class*="muted"]')?.textContent).toBe("(true)");
    await click(labelInput(row("pull.rebase"), "Rebase (true)"));
    await click(button("Save (Ctrl+S)"));
    expect(r.double.pending("reviewWorkbench")!.args[1]).toEqual({ action: "config-save", scope: "local", changes: [{ key: "pull.rebase", value: "true" }] });
  });

  test("the merge and diff tools offer the Git mergetools presets with the exact value, plus Custom (FR-062)", async () => {
    await render();
    await page("Editor and tools");
    await scope("local");
    const select = row("merge.tool").querySelector("select")!;
    const values = [...select.querySelectorAll("option")].map((o) => o.value);
    expect(values).toContain("kdiff3");
    expect(values).toContain("vscode");
    expect(values.at(-1)).toBe("custom");
    await choose(select, "kdiff3");
    expect(text(row("merge.tool"))).toContain("Writes merge.tool=kdiff3.");
    expect(row("diff.tool").querySelector("select")).not.toBeNull();
  });

  test("the editor offers the D15 editor presets, each with the exact core.editor command, plus Custom (FR-062, O-10)", async () => {
    const NPP = '"C:/Program Files/Notepad++/notepad++.exe" -multiInst -notabbar -nosession -noPlugin';
    const SUBL = '"C:/Program Files/Sublime Text/subl.exe" -w';
    const r = await render();
    await page("Editor and tools");
    await scope("local");
    const select = row("core.editor").querySelector("select")!;
    expect([...select.querySelectorAll("option")].map((o) => [o.textContent, o.value])).toEqual([
      ["Not set", ""],
      ["VS Code", "code --wait"],
      ["Notepad++", NPP],
      ["Sublime Text", SUBL],
      ["Notepad", "notepad"],
      ["Custom", "custom"],
    ]);
    await choose(select, NPP);
    expect(text(row("core.editor"))).toContain(`Writes core.editor=${NPP}.`);
    await click(button("Save (Ctrl+S)"));
    expect(r.double.pending("reviewWorkbench")!.args[1]).toEqual({ action: "config-save", scope: "local", changes: [{ key: "core.editor", value: NPP }] });
  });

  test("a stored editor command that equals a preset selects that preset; another command opens Custom (FR-062)", async () => {
    await render({ git: gitSettings({ "core.editor": configValue("core.editor", [local("code --wait")]) }) });
    await page("Editor and tools");
    await scope("local");
    expect(row("core.editor").querySelector("select")!.value).toBe("code --wait");
    expect(row("core.editor").querySelector("input")).toBeNull();
  });

  test("a stored editor command that no preset holds shows Custom with the command in the text field (FR-062)", async () => {
    await render({ git: gitSettings({ "core.editor": configValue("core.editor", [local("code -w")]) }) });
    await page("Editor and tools");
    await scope("local");
    expect(row("core.editor").querySelector("select")!.value).toBe("custom");
    expect(row("core.editor").querySelector<HTMLInputElement>("input")!.value).toBe("code -w");
  });

  test("a WSL workspace offers no Windows presets: the editor and tool rows show Not set and Custom with the D15 note (FR-006, FR-062)", async () => {
    await render({ wsl: true, git: gitSettings({ "core.editor": configValue("core.editor", [local("code --wait")]) }) });
    await page("Editor and tools");
    await scope("local");
    for (const key of ["core.editor", "diff.tool", "merge.tool"]) {
      const select = row(key).querySelector("select")!;
      expect([...select.querySelectorAll("option")].map((o) => [o.textContent, o.value])).toEqual([
        ["Not set", ""],
        ["Custom", "custom"],
      ]);
      expect(text(row(key))).toContain("Presets are Windows commands. A WSL repository needs a command for its distro.");
    }
    expect(row("core.editor").querySelector("select")!.value).toBe("custom");
    expect(row("core.editor").querySelector<HTMLInputElement>("input")!.value).toBe("code --wait");
  });

  test("values show as plain text (FR-067)", async () => {
    await render({ git: gitSettings({ "user.name": configValue("user.name", [global("<b>Ada</b>")]) }) });
    await scope("effective");
    expect(text(row("user.name"))).toContain("<b>Ada</b>");
    expect(row("user.name").querySelector("b")).toBeNull();
  });
});

describe("Open on a page (spec FR-093)", () => {
  test("the page option opens the view on Editor and tools and focuses the view heading", async () => {
    await render({ page: "Editor and tools" });
    const selected = section("pageList").querySelector('[role="tab"][aria-selected="true"]')!;
    expect(text(selected)).toBe("Editor and tools");
    expect(document.activeElement).toBe(view().querySelector("h2"));
  });
});

describe("Find a setting (plan D15)", () => {
  const find = () => section("pageList").querySelector<HTMLInputElement>('input[aria-label="Find a setting"]')!;
  test("the filter keeps the pages and rows whose label or Git key holds the text, without regard to letter case", async () => {
    await render();
    expect(find().getAttribute("aria-keyshortcuts")).toBe("Control+F");
    expect(find().getAttribute("placeholder")).toBe("Find a setting…");
    await type(find(), "PRUNE");
    expect(pageNames()).toEqual(["Fetch"]);
    expect([...content().querySelectorAll<HTMLElement>("[data-key]")].map((e) => e.dataset.key)).toEqual(["fetch.prune"]);
    await type(find(), "user email");
    expect(pageNames()).toEqual(["User"]);
    expect([...content().querySelectorAll<HTMLElement>("[data-key]")].map((e) => e.dataset.key)).toEqual(["user.email"]);
    await type(find(), "autostash");
    expect(pageNames()).toEqual(["Merge and rebase"]);
    expect([...content().querySelectorAll<HTMLElement>("[data-key]")].map((e) => e.dataset.key)).toEqual(["merge.autostash", "rebase.autostash"]);
    await type(find(), "no such setting");
    expect(pageNames()).toEqual([]);
    expect(text(content())).toContain("No setting matches the filter.");
    await type(find(), "");
    expect(pageNames().length).toBe(11);
  });

  test("the filter takes the text literally", async () => {
    await render();
    await type(find(), "user.*");
    expect(pageNames()).toEqual([]);
  });
});

describe("read-only keys (FR-063)", () => {
  test("multi-value lists the values with the reason; included names the file; unreadable-value states the reason", async () => {
    const git = gitSettings({
      "user.email": configValue("user.email", [local("a@x.invalid"), local("b@x.invalid")], { local: "multi-value" }),
      "user.name": configValue("user.name", [{ scope: "local", origin: "file:C:/Repos/sample/.git/extra.inc", value: "Inc" }], { local: "included" }),
      "fetch.prune": configValue("fetch.prune", [local("maybe", null)], { local: "unreadable-value" }),
    });
    await render({ git });
    await scope("local");
    expect(text(row("user.email"))).toContain("a@x.invalid");
    expect(text(row("user.email"))).toContain("b@x.invalid");
    expect(text(row("user.email"))).toContain("This scope sets user.email more than once. Arbareto cannot save one value.");
    expect(text(row("user.name"))).toContain("This value comes from file:C:/Repos/sample/.git/extra.inc. Change it in that file.");
    expect([...row("user.email").querySelectorAll("input")].every((i) => i.readOnly || i.disabled)).toBe(true);
    await page("Fetch");
    expect(text(row("fetch.prune"))).toContain("maybe");
    expect(text(row("fetch.prune"))).toContain("Git cannot read this value as on or off.");
    expect([...row("fetch.prune").querySelectorAll("input")].every((i) => i.disabled)).toBe(true);
  });
});

describe("Save and Cancel (FR-064, FR-065)", () => {
  test("a change shows Changed with the earlier value; Save reviews and runs only the changed keys, then reads again", async () => {
    const r = await render({ git: gitSettings({ "fetch.prune": configValue("fetch.prune", [local("false")]) }) });
    await page("Fetch");
    await scope("local");
    await click(labelInput(row("fetch.prune"), "On"));
    expect(text(row("fetch.prune"))).toContain("Changed");
    expect(text(row("fetch.prune"))).toContain("Was: false");
    expect(text(view())).toContain("1 change. Save writes it to This repository only.");
    expect(r.double.writes()).toEqual([]);
    const reads = r.double.of("readGitSettings").length;
    await click(button("Save (Ctrl+S)"));
    expect(r.double.pending("reviewWorkbench")!.args).toEqual([TARGET, { action: "config-save", scope: "local", changes: [{ key: "fetch.prune", value: "true" }] }]);
    await answer(r.double.pending("reviewWorkbench"), reviewed("local", [{ key: "fetch.prune", value: "true", earlier: { origin: `file:${LOCAL}`, value: "false" } }]));
    expect(r.double.pending("runWorkbench")!.args.slice(0, 2)).toEqual([{ repositoryId: TARGET.repositoryId }, { workbenchToken: TOKEN, start: true }]);
    expect(r.operations.at(-1)?.kind).toBe("runWorkbench");
    r.double.git = gitSettings({ "fetch.prune": configValue("fetch.prune", [local("true")]) });
    await answer(r.double.pending("runWorkbench"), ran("succeeded", { written: ["fetch.prune"] }));
    expect(r.ended.length).toBe(1);
    expect(r.double.of("readGitSettings").length).toBe(reads + 1);
    expect(labelInput(row("fetch.prune"), "On").checked).toBe(true);
    expect(text(row("fetch.prune"))).not.toContain("Changed");
  });

  test("Ctrl+S in the view saves the pending changes with the same review", async () => {
    const r = await render();
    await scope("local");
    const field = row("user.name").querySelector("input")!;
    await type(field, "Bob");
    await press(field, "s", { ctrlKey: true });
    expect(r.double.pending("reviewWorkbench")!.args).toEqual([TARGET, { action: "config-save", scope: "local", changes: [{ key: "user.name", value: "Bob" }] }]);
    expect(button("Save (Ctrl+S)").getAttribute("aria-keyshortcuts")).toBe("Control+S");
  });

  test("Cancel closes an open Custom tool field", async () => {
    await render();
    await page("Editor and tools");
    await scope("local");
    await choose(row("merge.tool").querySelector("select")!, "custom");
    const field = row("merge.tool").querySelector<HTMLInputElement>("input")!;
    await type(field, "mytool");
    expect(text(row("merge.tool"))).toContain("Changed");
    await click(button("Cancel"));
    expect(row("merge.tool").querySelector("input")).toBeNull();
    expect(row("merge.tool").querySelector("select")!.value).toBe("");
  });

  test("Cancel writes nothing and restores the read values", async () => {
    const r = await render();
    await scope("local");
    await type(row("user.name").querySelector("input")!, "Bob");
    expect(text(row("user.name"))).toContain("Was: not set");
    await click(button("Cancel"));
    expect(r.double.writes()).toEqual([]);
    expect(row("user.name").querySelector("input")!.value).toBe("");
    expect(text(row("user.name"))).not.toContain("Changed");
  });

  test("a failed write names the key and shows the bounded end of Git's output", async () => {
    const r = await render();
    await scope("global");
    await type(row("user.name").querySelector("input")!, "Bob");
    await click(button("Save (Ctrl+S)"));
    await answer(r.double.pending("reviewWorkbench"), reviewed("global", [{ key: "user.name", value: "Bob", earlier: null }]));
    await answer(r.double.pending("runWorkbench"), ran("failed", { scope: "global", failed: { key: "user.name", exitCode: 4, reason: "cannot-write" }, outputTail: "error: could not lock config file" }, "GIT_FAILED"));
    expect(text(content())).toContain("Git did not write user.name: cannot-write (exit 4).");
    expect(text(content())).toContain("error: could not lock config file");
  });

  test("STALE_REVIEW reads the values again and asks for a new save", async () => {
    const r = await render();
    await scope("local");
    await type(row("user.name").querySelector("input")!, "Bob");
    await click(button("Save (Ctrl+S)"));
    await answer(r.double.pending("reviewWorkbench"), reviewed("local", [{ key: "user.name", value: "Bob", earlier: null }]));
    const reads = r.double.of("readGitSettings").length;
    await answer(r.double.pending("runWorkbench"), { requestId: fixtureId(22), state: "rejected", code: "STALE_REVIEW" });
    expect(text(content())).toContain("A setting changed after the review. Arbareto read the values again. Check them, then save again.");
    expect(r.double.of("readGitSettings").length).toBe(reads + 1);
  });

  test("a succeeded review with a token and no plan changes names the unknown form, runs nothing, and reads again (plan D15 Malformed result)", async () => {
    const r = await render();
    await scope("local");
    await type(row("user.name").querySelector("input")!, "Bob");
    await click(button("Save (Ctrl+S)"));
    const reads = r.double.of("readGitSettings").length;
    await answer(r.double.pending("reviewWorkbench"), { requestId: fixtureId(20), operationId: fixtureId(21), state: "succeeded", repositoryGeneration: 1, result: { action: "config-save", plan: { scope: "local" }, workbenchToken: TOKEN } });
    expect(r.double.of("runWorkbench").length).toBe(0);
    expect(text(content())).toContain("Save did not complete: the result has an unknown form.");
    expect(r.double.of("readGitSettings").length).toBe(reads + 1);
  });

  test.each([
    ["no earlier field", { key: "user.name", value: "Bob" }],
    ["an earlier value of unknown form", { key: "user.name", value: "Bob", earlier: { origin: 1, value: "Ann" } }],
    ["no key", { value: "Bob", earlier: null }],
    ["an entry that is not an object", null],
  ])("a succeeded review with a plan change of %s names the unknown form, runs nothing, and reads again (plan D15 Malformed result)", async (_, entry) => {
    const r = await render();
    await scope("local");
    await type(row("user.name").querySelector("input")!, "Bob");
    await click(button("Save (Ctrl+S)"));
    const reads = r.double.of("readGitSettings").length;
    await answer(r.double.pending("reviewWorkbench"), { requestId: fixtureId(20), operationId: fixtureId(21), state: "succeeded", repositoryGeneration: 1, result: { action: "config-save", plan: { scope: "local", changes: [entry] }, workbenchToken: TOKEN } });
    expect(r.double.of("runWorkbench").length).toBe(0);
    expect(text(content())).toContain("Save did not complete: the result has an unknown form.");
    expect(r.double.of("readGitSettings").length).toBe(reads + 1);
  });

  test("after a failed new read, Save is unavailable with the read failure as its reason, and Ctrl+S sends nothing (tasks.md T113)", async () => {
    const r = await render();
    await scope("local");
    const field = row("user.name").querySelector("input")!;
    await type(field, "Bob");
    await click(button("Save (Ctrl+S)"));
    r.double.git = { requestId: fixtureId(33), state: "failed", code: "GIT_FAILED" };
    await answer(r.double.pending("reviewWorkbench"), { requestId: fixtureId(20), operationId: fixtureId(21), state: "succeeded", repositoryGeneration: 1, result: { action: "config-save", plan: { scope: "local" }, workbenchToken: TOKEN } });
    expect(text(content())).toContain("The Git settings did not load: GIT_FAILED");
    const save = button("Save (Ctrl+S)");
    expect(save.getAttribute("aria-disabled")).toBe("true");
    const reason = document.getElementById(save.getAttribute("aria-describedby")!)!;
    expect(text(reason)).toBe("The Git settings did not load: GIT_FAILED");
    // 001 plan.md "Disabled controls": only the running and the reconcile reasons are tooltip-only (tasks.md T114).
    expect(reason.closest("[hidden], .sr-only") === null).toBe(true);
    expect(reason.closest('[data-slot="settings-save"]') === null).toBe(false);
    expect(reason.className.split(/\s+/)).toContain("text-muted-text");
    await click(save);
    await press(save, "s", { ctrlKey: true });
    expect(r.double.of("reviewWorkbench")).toHaveLength(1);
  });

  test("a review whose earlier value differs from the shown value runs nothing and reads again", async () => {
    const r = await render();
    await scope("local");
    await type(row("user.name").querySelector("input")!, "Bob");
    await click(button("Save (Ctrl+S)"));
    await answer(r.double.pending("reviewWorkbench"), reviewed("local", [{ key: "user.name", value: "Bob", earlier: { origin: `file:${LOCAL}`, value: "Eve" } }]));
    expect(r.double.of("runWorkbench").length).toBe(0);
    expect(text(content())).toContain("A setting changed after Arbareto read it. Arbareto read the values again. Check them, then save again.");
  });
});

describe("app settings (FR-066, FR-068, O-7)", () => {
  test("Pull and push shows the 003 Pull button default as an Arbareto setting, and a choice sends setDefaultPullAction", async () => {
    const r = await render({ app: sync({ defaultPullAction: "pull-rebase" }) });
    await page("Pull and push");
    const app = content().querySelector<HTMLElement>('[data-slot="pull-default"]')!;
    expect(text(app)).toContain("Arbareto setting for all repositories. Not stored in Git configuration.");
    expect(labelInput(app, "Pull with rebase").checked).toBe(true);
    for (const label of ["Pull (use Git's configuration)", "Pull with merge", "Fetch", "Fetch all remotes"]) expect(labelInput(app, label).checked).toBe(false);
    await click(labelInput(app, "Fetch all remotes"));
    expect(r.double.pending("setDefaultPullAction")!.args[0]).toEqual({ action: "fetch-all" });
  });

  test("Branch switch preselects the stored switch choice and writes a new one with setSwitchChoice", async () => {
    const r = await render({ target: null, app: sync({ switchChoice: "stash" }) });
    await page("Branch switch");
    expect(labelInput(content(), "Stash and reapply").checked).toBe(true);
    expect(text(content())).toContain("Arbareto setting for all repositories. Not stored in Git configuration.");
    await click(labelInput(content(), "Keep changes"));
    expect(r.double.pending("setSwitchChoice")!.args[0]).toEqual({ choice: "keep" });
  });

  // Plan D15 "Malformed result": a succeeded response never shows its state as a code.
  const unknown = { requestId: fixtureId(33), operationId: fixtureId(34), state: "succeeded", repositoryGeneration: 1, result: {} };
  test("a succeeded app settings read of unknown form names the unknown form", async () => {
    await render({ target: null, app: unknown });
    await page("Branch switch");
    expect(text(content())).toContain("The settings did not load: the result has an unknown form.");
    expect(text(content())).not.toContain("succeeded");
  });

  test("a succeeded setting change of unknown form names the unknown form", async () => {
    const r = await render({ target: null, app: sync({ switchChoice: "stash" }) });
    await page("Branch switch");
    await click(labelInput(content(), "Keep changes"));
    await answer(r.double.pending("setSwitchChoice"), unknown);
    expect(text(view())).toContain("The setting change did not complete: the result has an unknown form.");
    expect(text(view())).not.toContain("succeeded");
  });

  test("a succeeded Git settings read of unknown form names the unknown form", async () => {
    await render({ git: unknown });
    expect(text(content())).toContain("The Git settings did not load: the result has an unknown form.");
    expect(text(content())).not.toContain("succeeded");
  });

  test("the 003 pages SSH and Clone hold the SSH client and the default clone folder", async () => {
    await render();
    await page("SSH");
    expect(text(content())).toContain("SSH client");
    expect(text(content())).toContain("Key files for this repository");
    await page("Clone");
    expect(text(content())).toContain("Default clone folder");
  });

  test("Close and Escape return without a write when no change waits", async () => {
    const r = await render();
    await click(button("Close settings"));
    expect(r.closed()).toBe(1);
    await press(view(), "Escape");
    expect(r.closed()).toBe(2);
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
  });

  for (const how of ["Close", "Escape"] as const) {
    test(`${how} with a pending change asks first, with Keep editing focused, and Discard setting changes returns without a write`, async () => {
      const r = await render();
      await scope("local");
      await type(row("user.name").querySelector("input")!, "Bob");
      const close = () => (how === "Close" ? click(button("Close settings")) : press(view(), "Escape"));
      await close();
      expect(r.closed()).toBe(0);
      const popover = document.querySelector<HTMLElement>('[data-slot="popover-content"]')!;
      expect(text(popover)).toContain("Discard the Git setting changes that you did not save?");
      expect(document.activeElement).toBe(button("Keep editing", popover));
      await click(button("Keep editing", popover));
      expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
      expect(r.closed()).toBe(0);
      expect(row("user.name").querySelector("input")!.value).toBe("Bob");
      await close();
      await click(button("Discard setting changes", document.querySelector<HTMLElement>('[data-slot="popover-content"]')!));
      expect(r.closed()).toBe(1);
      expect(r.double.writes()).toEqual([]);
    });
  }
});

describe("F6 order (plan D15)", () => {
  test("the view holds the scope bar, the page list, and the page content in the D15 order", async () => {
    await render();
    expect(sectionOrder("settings")).toEqual(["header", "noticeHeading", "scopeBar", "pageList", "pageContent", "statusRegion"]);
    expect([...view().querySelectorAll<HTMLElement>("[data-section]")].map((e) => e.dataset.section)).toEqual(["scopeBar", "pageList", "pageContent"]);
  });

  test("the page list is one Tab stop, and an arrow key shows the next page at once", async () => {
    await render();
    const tabs = [...section("pageList").querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.filter((t) => t.tabIndex === 0).length).toBe(1);
    await act(async () => tabs[0]!.focus());
    await press(tabs[0]!, "ArrowDown");
    expect(text(content())).toContain("Editor");
  });
});

describe("T076 board fixes (tasks.md T111, plan D16 \"Geometry\")", () => {
  test("the scope bar keeps one row: the file line ends with an ellipsis, and its tooltip gives the full text", async () => {
    await render();
    await scope("local");
    const bar = section("scopeBar");
    expect(bar.className.split(" ")).not.toContain("flex-wrap");
    const file = bar.querySelector<HTMLElement>('[data-slot="scope-file"]')!;
    expect(file.className.split(" ")).toContain("truncate");
    await act(async () => {
      file.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
      file.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      file.dispatchEvent(new MouseEvent("mouseenter"));
      file.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    await act(async () => void (await new Promise((done) => setTimeout(done, 700))));
    await settle();
    expect(tooltipText()).toBe(`Writes to ${LOCAL}`);
  });

  test("the selected scope radio has the full file line as its accessible description (tasks.md T113)", async () => {
    await render();
    await scope("local");
    const radios = [...section("scopeBar").querySelectorAll<HTMLInputElement>('input[name="scope"]')];
    const described = radios.filter((r) => r.hasAttribute("aria-describedby"));
    expect(described.map((r) => r.value)).toEqual(["local"]);
    expect(text(document.getElementById(described[0]!.getAttribute("aria-describedby")!)!)).toBe(`Writes to ${LOCAL}`);
  });

  test("the selected page shows the selected-row fill and the start marker (D16 \"Selection\")", async () => {
    await render();
    await page("Fetch");
    const list = section("pageList").querySelector<HTMLElement>('[role="tablist"]')!;
    expect(list.getAttribute("data-variant")).not.toBe("line");
    const selected = [...list.querySelectorAll<HTMLElement>('[role="tab"]')].filter((t) => t.getAttribute("aria-selected") === "true");
    expect(selected.map((t) => text(t))).toEqual(["Fetch"]);
    expect(selected[0]!.className.split(" ")).toContain("list-row");
  });

  test("the save row is a full-width footer of the view, outside the scrolling page content", async () => {
    await render();
    await scope("local");
    await type(row("user.name").querySelector("input")!, "Bob");
    const save = view().querySelector<HTMLElement>('[data-slot="settings-save"]')!;
    expect(save).not.toBeNull();
    expect(content().contains(save)).toBe(false);
    expect(save.parentElement).toBe(view());
    expect(save.className.split(" ")).not.toContain("sticky");
    expect(text(save)).toContain("1 change. Save writes it to This repository only.");
  });
});
