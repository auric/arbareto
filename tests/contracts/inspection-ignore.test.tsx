// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import type { ChangeEntry } from "../../src/contracts/envelope";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { fixtureId } from "./bridge-contract";
import { b64, contextMenu, entry, expectChromiumFocus, item, menuItem, openCommitView, pressKey, statusBar, typeInto } from "./commit-fake";
import { stubLayout } from "./history-fake";
import { answer, button, click, createWorld, REGISTRATION, settle, succeeded, text, unmountAll, type Call } from "./sync-fake";

// tasks.md T049 (feature 005, WP7). Story US5. Spec FR-034 to FR-046, FR-067, FR-068. Plan D8, D9, D10, D15 ("Ignore editor", "Ignore editor keys", "Ignore editor texts").

printOrigin("../../src/frontend/ignore/IgnoreEditor.tsx", import.meta.dir);
printOrigin("../../src/frontend/state/workbench.ts", import.meta.dir);
printOrigin("../../src/frontend/changes/ChangesPane.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/RepositoryMenu.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);

mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children?: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre data-slot="patch-double">{patch}</pre> }));
registerDom();
const workbench = await import("../../src/frontend/app/Workbench");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
afterEach(() => unmountAll());

const FILE = "C:\\repo\\.gitignore";
const SHA = "a".repeat(64);
const loaded = (text: string, fields: Record<string, unknown> = {}) => succeeded({ target: "gitignore", file: FILE, state: "file", text, lineEnding: "lf", bom: false, expected: { size: text.length, sha256: SHA }, ...fields });
const rejected = (code: string, result?: unknown) => ({ requestId: fixtureId(0x8d1), state: "rejected", code, ...(result === undefined ? {} : { result }) });
const editor = () => document.querySelector<HTMLElement>('[data-slot="ignore-editor"]');
const field = () => editor()!.querySelector<HTMLTextAreaElement>("textarea")!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const preview = () => editor()!.querySelector<HTMLElement>('[role="region"][aria-label="Preview"]')!;
const pause = (ms: number) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
const utf8 = (s: string) => Buffer.from(s, "utf8").toString("base64");

async function setup(entries: ChangeEntry[] = [entry("untracked", "logs/1.log"), entry("untracked", "notes.txt")]) {
  const world = createWorld({ entries });
  const double = await openCommitView(workbench, world);
  return { world, double };
}
/** Opens the editor through the row item of `row` and answers its read with `text`. */
async function openFrom(double: Awaited<ReturnType<typeof setup>>["double"], row: string, label = "Add to .gitignore…", response: unknown = loaded("node_modules/")) {
  await contextMenu(item("Changes", row));
  await click(menuItem(label));
  const read = double.pending("readIgnoreFile");
  if (read !== undefined) await answer(read, response);
}
const selected = () => field().value.slice(field().selectionStart, field().selectionEnd);
async function openMenubar(name: string) {
  const trigger = [...document.querySelectorAll<HTMLElement>('[role="menubar"] [role="menuitem"]')].find((e) => text(e) === name)!;
  await act(async () => trigger.focus());
  await click(trigger);
}
function previewCall(double: Awaited<ReturnType<typeof setup>>["double"]): Call {
  const call = double.pending("previewIgnore");
  if (call === undefined) throw new Error("no previewIgnore call");
  return call;
}

describe("entry points and layout (FR-034, FR-035, IgnoreEditor board)", () => {
  test("Add to .gitignore… on a folder row reads the file, docks the editor, adds the line, and selects it (US5-1)", async () => {
    const { double } = await setup();
    await contextMenu(item("Changes", "logs"));
    await click(menuItem("Add to .gitignore…"));
    const read = double.pending("readIgnoreFile")!;
    expect(read.args.slice(0, 2)).toEqual([{ repositoryId: fixtureId(1), repositoryGeneration: 1 }, { target: "gitignore" }]);
    await answer(read, loaded("node_modules/"));
    const e = editor()!;
    // The editor takes the diff region of the Commit view.
    expect(e.closest('[data-section="comparison"]')).not.toBeNull();
    expect(text(e.querySelector("h2")!)).toBe("Edit .gitignore");
    const path = e.querySelector<HTMLElement>('[data-slot="ignore-path"]')!;
    expect(text(path)).toBe(FILE);
    expect(path.getAttribute("title")).toBe(FILE);
    expect(field().value).toBe("node_modules/\n/logs/\n");
    expect(selected()).toBe("/logs/");
    expect(field().getAttribute("spellcheck")).toBe("false");
    expect(field().getAttribute("wrap")).toBe("off");
    expect(field().getAttribute("aria-label")).toBe("Edit .gitignore");
    expect(e.querySelector<HTMLElement>('[data-slot="line-numbers"]')!.style.width).toBe("44px");
    expect(preview().style.width).toBe("340px");
    expect([...e.querySelectorAll('[role="separator"]')].map((s) => s.getAttribute("aria-label"))).toContain("Resize editor and preview");
    expect([...e.querySelectorAll('[data-slot="ignore-actions"] button')].map((b) => text(b))).toEqual(["Close", "Save"]);
    expect(document.activeElement).toBe(field());
    expectChromiumFocus(document.activeElement);
  });

  test("an equal existing line adds nothing and selects that line (US5-10)", async () => {
    const { double } = await setup();
    await openFrom(double, "notes.txt", "Add to .gitignore…", loaded("a\n/notes.txt\nb\n"));
    expect(field().value).toBe("a\n/notes.txt\nb\n");
    expect(selected()).toBe("/notes.txt");
  });

  test("Add to info/exclude… reads the exclude target and names it in the heading", async () => {
    const { double } = await setup();
    await contextMenu(item("Changes", "notes.txt"));
    await click(menuItem("Add to info/exclude…"));
    const read = double.pending("readIgnoreFile")!;
    expect(read.args[1]).toEqual({ target: "exclude" });
    await answer(read, succeeded({ target: "exclude", file: "C:\\repo\\.git\\info\\exclude", state: "absent", text: "", lineEnding: "none", bom: false, expected: "absent" }));
    expect(text(editor()!.querySelector("h2")!)).toBe("Edit info/exclude");
    expect(field().value).toBe("/notes.txt\n");
  });

  test("the Repository menu items open the editor without a line; an open from History switches to the Commit view", async () => {
    const world = createWorld({ entries: [entry("untracked", "notes.txt")] });
    const { mountWorkbench } = await import("./sync-fake");
    const double = await mountWorkbench(workbench, world);
    await openMenubar("Repository");
    expect([...document.querySelectorAll('[data-slot="menubar-content"] [role="menuitem"]')].map((i) => text(i))).toContain("Edit .gitignore");
    await click(menuItem("Edit info/exclude"));
    expect(document.querySelector('section[aria-label="Commit view"]')).not.toBeNull();
    expect(double.pending("readIgnoreFile")!.args[1]).toEqual({ target: "exclude" });
    await answer(double.pending("readIgnoreFile"), loaded("x\n", { target: "exclude", file: "C:\\repo\\.git\\info\\exclude" }));
    expect(field().value).toBe("x\n");
  });

  const refusals: [string, string][] = [
    ["ignore-link", ".gitignore is a symbolic link. Arbareto edits only a regular file."],
    ["ignore-folder", ".gitignore is a folder. Arbareto edits only a regular file."],
    ["ignore-not-regular", ".gitignore is a special file. Arbareto edits only a regular file."],
    ["ignore-size", ".gitignore is larger than 1 MiB. Arbareto does not edit it."],
    ["ignore-not-utf8", ".gitignore is not valid UTF-8 text. Arbareto does not edit it."],
    ["ignore-nul", ".gitignore holds a NUL character. Arbareto does not edit it."],
    ["ignore-lone-cr", ".gitignore holds a CR without an LF. Arbareto does not edit it."],
    ["path", "Git names an info/exclude path outside the Git folder. Arbareto does not edit it."],
  ];
  for (const [reason, sentence] of refusals) {
    test(`the open refusal ${reason} shows its text in place of the editor text`, async () => {
      const { double } = await setup();
      await openFrom(double, "notes.txt", "Add to .gitignore…", rejected("WORKBENCH_UNAVAILABLE", { reason }));
      expect(text(editor()!)).toContain(sentence);
      expect(editor()!.querySelector("textarea")).toBeNull();
    });
  }

  test("an unreadable file names the code", async () => {
    const { double } = await setup();
    await openFrom(double, "notes.txt", "Add to .gitignore…", rejected("REPOSITORY_CHANGED"));
    expect(text(editor()!)).toContain("Arbareto cannot read .gitignore: REPOSITORY_CHANGED.");
  });
});

describe("preview (FR-038 to FR-041, plan D9)", () => {
  test("a preview goes 400 ms after the last edit as base64, shows Updating preview…, and a new edit cancels the running one (US5-2)", async () => {
    const { double } = await setup();
    await openFrom(double, "notes.txt");
    await typeInto(field(), "*.log\n");
    expect(double.count("previewIgnore")).toBe(0);
    await pause(450);
    const first = previewCall(double);
    expect(first.args[1]).toEqual({ target: "gitignore", text: utf8("*.log\n"), snapshotId: expect.any(String) });
    const status = preview().querySelector('[role="status"]')!;
    expect(text(status)).toBe("Updating preview…");
    (first.args[2] as (event: unknown) => void)({ requestId: fixtureId(0x8d2), operationId: fixtureId(0x8d3), state: "running", phase: "preview", counters: {}, stalled: false });
    await typeInto(field(), "*.log\n*.tmp\n");
    await pause(450);
    expect(double.calls.filter((c) => c.operation === "cancel").map((c) => c.args[0])).toEqual([{ operationId: fixtureId(0x8d3) }]);
    expect(double.count("previewIgnore")).toBe(2);
    // The answer of the canceled preview shows nothing.
    await answer(first, succeeded({ preview: { newlyIgnored: { count: 9, paths: [] }, noLongerIgnored: { count: 0, paths: [] }, trackedMatched: 0, notices: { entries: [], more: 0 } } }));
    expect(text(preview())).not.toContain("Newly ignored (9)");
  });

  test("the groups, the more line, the tracked note, and the notices (US5-2, US5-4, US5-5)", async () => {
    // happy-dom has no layout: each preview list gets a 220 px box.
    const proto = HTMLElement.prototype;
    const saved = (["offsetHeight", "clientHeight"] as const).map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const);
    for (const [key, base] of saved)
      Object.defineProperty(proto, key, { configurable: true, get: function (this: HTMLElement) { return this.dataset.slot === "preview-list" ? 220 : (base?.get?.call(this) ?? 0); } });
    try {
      await groups();
    } finally {
      for (const [key, base] of saved) Object.defineProperty(proto, key, base!);
    }
  });
  async function groups() {
    const { double } = await setup();
    await openFrom(double, "notes.txt");
    await typeInto(field(), "*.log\n");
    await pause(450);
    await answer(
      previewCall(double),
      succeeded({
        preview: {
          newlyIgnored: { count: 1_002, paths: Array.from({ length: 1000 }, (_, i) => b64(`logs/${String(i).padStart(4, "0")}.log`)) },
          noLongerIgnored: { count: 1, paths: [b64("keep.log")] },
          trackedMatched: 2,
          notices: { entries: [{ kind: "link", pathBytes: b64("a/.gitignore") }, { kind: "inside-ignored", pathBytes: b64("build/.gitignore") }], more: 0 },
        },
      }),
    );
    const p = text(preview());
    expect(p).toContain("Newly ignored (1,002)");
    expect(p).toContain("No longer ignored (1)");
    expect(p).toContain("Tracked files stay tracked.");
    const note = preview().querySelector('[data-slot="tracked-note"]')!;
    expect([...note.querySelectorAll("span")].map((span) => text(span))).toEqual(["Tracked files stay tracked.", "2"]);
    expect(p).toContain("a/.gitignore is a symbolic link. Git does not read it.");
    expect(p).toContain("build/.gitignore is inside an ignored folder. Git does not read it.");
    // Spec FR-068: the 1,000 rows of a group render only near the visible area.
    const rows = preview().querySelectorAll('[data-slot="preview-path"]');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(200);
  }

  test("No longer ignored stacks under the Newly ignored list and does not split the height (IgnoreEditor board, T074)", async () => {
    const { double } = await setup();
    await openFrom(double, "notes.txt");
    await typeInto(field(), "*.log\n");
    await pause(450);
    await answer(previewCall(double), succeeded({ preview: { newlyIgnored: { count: 2, paths: [b64("a.log"), b64("b.log")] }, noLongerIgnored: { count: 0, paths: [] }, trackedMatched: 0, notices: { entries: [], more: 0 } } }));
    // A grid row of `minmax(0, max-content)` takes the content height and gives the free space to no group, so the second group starts below the first list.
    const stack = preview().querySelector<HTMLElement>('[data-slot="preview-groups"]')!;
    expect(stack.className.split(" ")).toEqual(expect.arrayContaining(["grid", "content-start", "grid-rows-[minmax(0,max-content)_minmax(0,max-content)]"]));
    const groups = [...stack.children] as HTMLElement[];
    expect(groups.map((g) => text(g.querySelector("h3")!))).toEqual(["Newly ignored (2)", "No longer ignored (0)"]);
    for (const group of groups) expect(group.className.split(" ")).not.toContain("flex-1");
  });

  test("the more line follows the 1,000 rows of a group", async () => {
    const { double } = await setup();
    await openFrom(double, "notes.txt");
    await typeInto(field(), "*.log\n");
    await pause(450);
    await answer(previewCall(double), succeeded({ preview: { newlyIgnored: { count: 3, paths: [b64("a.log"), b64("b.log"), b64("c.log")] }, noLongerIgnored: { count: 0, paths: [] }, trackedMatched: 0, notices: { entries: [], more: 0 } } }));
    expect(text(preview())).not.toContain("more paths");
    expect(preview().querySelector('[data-slot="tracked-note"]')).toBeNull();
  });

  const reasons: [string, string][] = [
    ["paths", "Preview not available: the preview checks more than 100,000 paths."],
    ["listing", "Preview not available: Git lists more paths or ignore files than the preview reads."],
    ["name-case", "Preview not available: a file name differs from .gitignore only in letter case."],
    ["shadow-copy", "Preview not available: Arbareto cannot copy the ignore files for the preview."],
    ["self-check", "Preview not available: the preview does not match Git for the saved text."],
    ["unreadable", "Preview not available: Arbareto cannot read an ignore file of this repository."],
    ["deadline", "Preview not available: the preview took longer than 30 seconds."],
  ];
  for (const [reason, sentence] of reasons) {
    test(`the unavailable reason ${reason} shows its text, and Save stays available`, async () => {
      const { double } = await setup();
      await openFrom(double, "notes.txt");
      await typeInto(field(), "*.log\n");
      await pause(450);
      await answer(previewCall(double), succeeded({ unavailable: { reason } }));
      expect(text(preview())).toContain(sentence);
      expect(button("Save", editor()!).hasAttribute("disabled")).toBe(false);
    });
  }

  test("a failed preview names the code; the read gate shows the trust text", async () => {
    const { double } = await setup();
    await openFrom(double, "notes.txt");
    await typeInto(field(), "*.log\n");
    await pause(450);
    await answer(previewCall(double), { requestId: fixtureId(0x8d4), state: "failed", code: "GIT_FAILED" });
    expect(text(preview())).toContain("Preview not available: Git failed with GIT_FAILED.");
    await typeInto(field(), "*.log\nx\n");
    await pause(450);
    await answer(previewCall(double), rejected("TRUST_REQUIRED"));
    expect(text(preview())).toContain("Arbareto reads no changes until you trust this repository.");
    expect(button("Trust…", preview())).not.toBeNull();
  });

  test("a text with a lone surrogate gets no preview and no Save, with its text (plan D9)", async () => {
    const { double } = await setup();
    await openFrom(double, "notes.txt");
    await typeInto(field(), "a\uD800\n");
    await pause(450);
    expect(double.count("previewIgnore")).toBe(0);
    expect(text(preview())).toContain("The text holds an invalid character. Arbareto cannot save it or show a preview.");
    const save = button("Save", editor()!);
    expect(save.getAttribute("aria-disabled") === "true" || save.hasAttribute("disabled")).toBe(true);
    await click(save);
    expect(double.count("reviewWorkbench")).toBe(0);
  });

  test("the text renders as plain text, never as markup (FR-045)", async () => {
    const { double } = await setup();
    await openFrom(double, "notes.txt", "Add to .gitignore…", loaded("<b>bold</b>\n<img src=x>\n"));
    expect(field().value.startsWith("<b>bold</b>\n<img src=x>\n")).toBe(true);
    expect(editor()!.querySelector("b, img")).toBeNull();
  });
});

describe("save, close, and keys (FR-042, FR-044, FR-046, plan D15)", () => {
  async function opened() {
    const ctx = await setup();
    await openFrom(ctx.double, "notes.txt");
    return ctx;
  }
  const saveReviewed = succeeded({ action: "ignore-save", plan: { target: "gitignore", file: FILE, size: 24, sha256: "b".repeat(64) }, workbenchToken: fixtureId(0x8e0) });

  test("Save reviews the text with the loaded state, runs the token, and states Saved .gitignore.", async () => {
    const { double } = await opened();
    await click(button("Save", editor()!));
    const review = double.pending("reviewWorkbench")!;
    expect(review.args[1]).toEqual({ action: "ignore-save", target: "gitignore", text: utf8("node_modules/\n/notes.txt\n"), expected: { size: 13, sha256: SHA } });
    await answer(review, saveReviewed);
    const run = double.pending("runWorkbench")!;
    expect(run.args[1]).toEqual({ workbenchToken: fixtureId(0x8e0), start: true });
    const reads = double.count("readWorkspace");
    await answer(run, succeeded({ action: "ignore-save", outcome: "replaced" }));
    expect(statusBar()).toContain("Saved .gitignore.");
    expect(double.count("readWorkspace")).toBeGreaterThan(reads);
    // The saved text is the loaded text now, so Close asks nothing.
    await click(button("Close", editor()!));
    expect(dialog()).toBeNull();
    expect(editor()).toBeNull();
  });

  test("Ctrl+S in the editor saves; Ctrl+S outside the editor panel does not", async () => {
    const { double } = await opened();
    const save = await pressKey(field(), "s", { ctrlKey: true });
    expect(save.defaultPrevented).toBe(true);
    expect(double.count("reviewWorkbench")).toBe(1);
    await answer(double.pending("reviewWorkbench"), rejected("CANCELED"));
    await pressKey(item("Changes", "notes.txt"), "s", { ctrlKey: true });
    expect(double.count("reviewWorkbench")).toBe(1);
  });

  test("Escape runs Close only without an IME composition, and Close with unsaved text opens the discard modal (US5-7)", async () => {
    await opened();
    await pressKey(field(), "Escape", { isComposing: true } as KeyboardEventInit);
    expect(dialog()).toBeNull();
    expect(editor()).not.toBeNull();
    // T067: a real key press can mount the modal during the same keydown, so the Base UI dismiss listener on `document` must not see it.
    const seen: string[] = [];
    const spy = (event: KeyboardEvent) => void seen.push(event.key);
    document.addEventListener("keydown", spy);
    await pressKey(field(), "Escape");
    document.removeEventListener("keydown", spy);
    expect(seen).toEqual([]);
    const d = dialog()!;
    expect(text(d.querySelector("h2")!)).toBe("Discard changes to .gitignore?");
    expect([...d.querySelectorAll("button")].map((b) => text(b))).toEqual(["Keep editing", "Discard"]);
    expect(text(document.activeElement!)).toBe("Keep editing");
    await click(button("Keep editing", d));
    expect(dialog()).toBeNull();
    expect(field().value).toBe("node_modules/\n/notes.txt\n");
    await click(button("Close", editor()!));
    await click(button("Discard", dialog()!));
    expect(editor()).toBeNull();
  });

  test("a same-file row action adds its line; an other-file row action opens the modal first (US5-9, FR-044)", async () => {
    const { double } = await opened();
    await contextMenu(item("Changes", "logs"));
    await click(menuItem("Add to .gitignore…"));
    expect(double.count("readIgnoreFile")).toBe(1);
    expect(field().value).toBe("node_modules/\n/notes.txt\n/logs/\n");
    expect(selected()).toBe("/logs/");
    await contextMenu(item("Changes", "logs"));
    await click(menuItem("Add to info/exclude…"));
    expect(text(dialog()!.querySelector("h2")!)).toBe("Discard changes to .gitignore?");
    expect(double.count("readIgnoreFile")).toBe(1);
    await click(button("Discard", dialog()!));
    expect(double.pending("readIgnoreFile")!.args[1]).toEqual({ target: "exclude" });
  });

  test("Open folder… with unsaved text opens the modal first (FR-044)", async () => {
    const { double } = await opened();
    await openMenubar("Repository");
    await click(menuItem("Open folder…"));
    expect(text(dialog()!.querySelector("h2")!)).toBe("Discard changes to .gitignore?");
    expect(double.count("chooseRepository")).toBe(0);
    await click(button("Discard", dialog()!));
    expect(double.count("chooseRepository")).toBe(1);
  });

  test("a stale save shows the notice with Reload, which asks first with unsaved text (US5-6)", async () => {
    const { double } = await opened();
    await click(button("Save", editor()!));
    await answer(double.pending("reviewWorkbench"), { requestId: fixtureId(0x8e1), state: "rejected", code: "STALE_REVIEW", result: { reason: "ignore-changed" } });
    expect(text(editor()!)).toContain(".gitignore changed on disk after Arbareto loaded it. Arbareto did not save your text.");
    expect(field().value).toBe("node_modules/\n/notes.txt\n");
    await click(button("Reload", editor()!));
    expect(text(dialog()!.querySelector("h2")!)).toBe("Discard changes to .gitignore?");
    await click(button("Discard", dialog()!));
    expect(double.count("readIgnoreFile")).toBe(2);
  });

  const saveRefusals: [unknown, string][] = [
    [rejected("WORKBENCH_UNAVAILABLE", { reason: "ignore-size" }), "The text is larger than 1 MiB. Arbareto did not save it."],
    [rejected("WORKBENCH_UNAVAILABLE", { reason: "ignore-nul" }), "The text holds a NUL character. Arbareto did not save it."],
    [rejected("BUSY"), "A Git operation is running. Its progress and Cancel are in the status bar."],
    [rejected("GIT_FAILED"), "Save did not complete: GIT_FAILED."],
  ];
  for (const [response, sentence] of saveRefusals) {
    test(`a save refusal shows "${sentence}" and keeps the text`, async () => {
      const { double } = await opened();
      await click(button("Save", editor()!));
      await answer(double.pending("reviewWorkbench"), response);
      expect(text(editor()!) + statusBar()).toContain(sentence);
      expect(field().value).toBe("node_modules/\n/notes.txt\n");
    });
  }

  test("Save stays available during a merge with conflicts (FR-046)", async () => {
    const world = createWorld({ entries: [entry("untracked", "notes.txt"), entry("conflicted", "c.ts", { xy: "UU" })], operationState: "merging" });
    const double = await openCommitView(workbench, world);
    await openFrom(double, "notes.txt");
    await click(button("Save", editor()!));
    expect(double.count("reviewWorkbench")).toBe(1);
  });

  test("Tab keeps focus movement: the textarea handles no Tab", async () => {
    await opened();
    const tab = await pressKey(field(), "Tab");
    expect(tab.defaultPrevented).toBe(false);
  });
});

// ---- Batch 3 review fixes ----

const comparison = () => document.querySelector<HTMLElement>('[data-section="comparison"]')!;
const composer = () => document.querySelector<HTMLElement>('[data-section="composer"]')!;

describe("F6 with the editor (plan D15 F6 order)", () => {
  test("a remembered diff control in the hidden diff does not take F6: F6 reaches the editor (review fix 1)", async () => {
    const { double } = await setup();
    await click(item("Changes", "notes.txt"));
    const copy = button("Copy path", comparison());
    await act(async () => copy.focus());
    expect(document.activeElement).toBe(copy);
    // A refused read shows no textarea, so the editor takes no focus of its own.
    await openFrom(double, "notes.txt", "Add to .gitignore…", rejected("WORKBENCH_UNAVAILABLE", { reason: "ignore-link" }));
    expect(copy.closest("[hidden]")).not.toBeNull();
    const message = composer().querySelector<HTMLElement>("textarea")!;
    await act(async () => message.focus());
    await pressKey(message, "F6", { shiftKey: true });
    expect(editor()!.contains(document.activeElement)).toBe(true);
  });

  test("the preview is its own F6 stop after the editor (review fix 13)", async () => {
    const { double } = await setup();
    await openFrom(double, "notes.txt");
    expect(document.activeElement).toBe(field());
    await pressKey(field(), "F6");
    expect(preview().contains(document.activeElement)).toBe(true);
    await pressKey(document.activeElement!, "F6");
    expect(composer().contains(document.activeElement)).toBe(true);
    await pressKey(document.activeElement!, "F6", { shiftKey: true });
    expect(preview().contains(document.activeElement)).toBe(true);
    await pressKey(document.activeElement!, "F6", { shiftKey: true });
    expect(document.activeElement).toBe(field());
  });
});

describe("every open asks first with unsaved text (FR-044, review fix 2)", () => {
  async function dirty(world = createWorld({ entries: [entry("untracked", "notes.txt")] })) {
    const double = await openCommitView(workbench, world);
    await openFrom(double, "notes.txt");
    return double;
  }
  // The switcher popup is a dialog too, so the modal is found by its title.
  const discard = async () => {
    const modal = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) => d.querySelector("h2") !== null)!;
    expect(text(modal.querySelector("h2")!)).toBe("Discard changes to .gitignore?");
    await click(button("Discard", modal));
  };

  test("a recent entry of the repository switcher", async () => {
    const world = createWorld({ entries: [entry("untracked", "notes.txt")] });
    world.answers.listRecentRepositories = () => succeeded({ entries: [{ entryId: fixtureId(0x8f0), path: "C:\\other", location: { kind: "native" }, openedAt: "2026-10-10T08:00:00Z", current: false }] });
    const double = await dirty(world);
    await click(document.querySelector<HTMLElement>('header button[aria-keyshortcuts="Control+R"]')!);
    const option = [...document.querySelectorAll<HTMLElement>('[role="listbox"][aria-label="Recent repositories"] [role="option"]')][1]!;
    await click(option);
    expect(double.count("openRecentRepository")).toBe(0);
    await discard();
    expect(double.count("openRecentRepository")).toBe(1);
  });

  test("Open of another worktree", async () => {
    const world = createWorld({ entries: [entry("untracked", "notes.txt")] });
    const wt = (path: string, fields: Record<string, unknown> = {}) => ({ path, invalidUtf8: false, head: "1".repeat(40), branch: null, bare: false, detached: false, headUnresolved: false, locked: null, prunable: null, main: false, current: false, ...fields });
    world.answers.readWorktrees = () => succeeded({ entries: [wt("C:/repo", { branch: "refs/heads/main", main: true, current: true }), wt("C:/wt/repo-other", { branch: "refs/heads/other" })] });
    const double = await dirty(world);
    const toggle = document.querySelector<HTMLElement>('button[aria-label="Show references"]');
    if (toggle !== null && toggle.getAttribute("aria-expanded") !== "true") await click(toggle);
    const row = [...document.querySelectorAll<HTMLElement>('[data-slot="worktrees-group"] [role="option"]')].find((r) => (r.getAttribute("aria-label") ?? "").startsWith("repo-other,"))!;
    await act(async () => void row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })));
    await settle();
    expect(double.count("openWorktree")).toBe(0);
    await discard();
    expect(double.count("openWorktree")).toBe(1);
  });

  test("the clone start", async () => {
    const double = await dirty();
    await openMenubar("Repository");
    await click(menuItem("Clone…"));
    const panel = document.querySelector<HTMLElement>('section[data-slot="clone-panel"]')!;
    const input = (label: string) => {
      const found = [...panel.querySelectorAll<HTMLLabelElement>("label")].find((l) => text(l) === label)!;
      return (found.control ?? found.querySelector("input")) as HTMLInputElement;
    };
    await typeInto(input("Remote URL"), "https://example.invalid/team/tool.git");
    await typeInto(input("Destination folder"), "D:\\src\\tool");
    await click(button("Clone", panel));
    expect(double.count("clone")).toBe(0);
    await discard();
    expect(double.count("clone")).toBe(1);
  });
});

describe("the added line follows Git's trailing-space rule (review fix 10)", () => {
  test('an existing "/notes.txt " equals the line, so nothing is added and that line is selected', async () => {
    const { double } = await setup();
    await openFrom(double, "notes.txt", "Add to .gitignore…", loaded("a\n/notes.txt  \nb\n"));
    expect(field().value).toBe("a\n/notes.txt  \nb\n");
    expect(selected()).toBe("/notes.txt  ");
  });

  test("trimTrailingSpaces drops only an unquoted U+0020 run (dir.c trim_trailing_spaces)", async () => {
    const { trimTrailingSpaces } = await import("../../src/frontend/state/workbench");
    // Git 2.56.0.windows.2 check-ignore on a probe repository, 2026-10-24: "a  " matches a; "b\ " matches "b " only.
    expect(trimTrailingSpaces("a  ")).toBe("a");
    expect(trimTrailingSpaces("b\\ ")).toBe("b\\ ");
    expect(trimTrailingSpaces("b\\  ")).toBe("b\\ ");
    expect(trimTrailingSpaces("c\\")).toBe("c\\");
    expect(trimTrailingSpaces("d \t")).toBe("d \t");
    expect(trimTrailingSpaces("e f")).toBe("e f");
  });

  test('an escaped trailing space keeps the space, so "/notes.txt\\ " differs and the line is added', async () => {
    const { double } = await setup();
    await openFrom(double, "notes.txt", "Add to .gitignore…", loaded("/notes.txt\\ \n"));
    expect(field().value).toBe("/notes.txt\\ \n/notes.txt\n");
  });
});

describe("preview texts (review fixes 4, 5, 7)", () => {
  test("the notices end with the count of the notices that the result leaves out", async () => {
    const { double } = await setup();
    await openFrom(double, "notes.txt");
    await typeInto(field(), "*.log\n");
    await pause(450);
    await answer(previewCall(double), succeeded({ preview: { newlyIgnored: { count: 0, paths: [] }, noLongerIgnored: { count: 0, paths: [] }, trackedMatched: 0, notices: { entries: [{ kind: "link", pathBytes: b64("a/.gitignore") }], more: 3 } } }));
    expect(text(preview())).toContain("and 3 more");
  });

  test("one status element stays above the state and carries the warnings", async () => {
    const { double } = await setup();
    await openFrom(double, "notes.txt");
    await typeInto(field(), "*.log\n");
    await pause(450);
    const status = preview().querySelector('[role="status"]')!;
    expect(text(status)).toBe("Updating preview…");
    await answer(previewCall(double), succeeded({ unavailable: { reason: "paths" } }));
    expect(preview().querySelector('[role="status"]')).toBe(status);
    expect(text(status)).toBe("Preview not available: the preview checks more than 100,000 paths.");
    await typeInto(field(), "*.log\nx\n");
    await pause(450);
    await answer(previewCall(double), { requestId: fixtureId(0x8d5), state: "failed", code: "GIT_FAILED" });
    expect(preview().querySelector('[role="status"]')).toBe(status);
    expect(text(status)).toBe("Preview not available: Git failed with GIT_FAILED.");
  });

  test("the open refusal unreadable has no code (contract Δ3 readIgnoreFile)", async () => {
    const { double } = await setup();
    await openFrom(double, "notes.txt", "Add to .gitignore…", rejected("WORKBENCH_UNAVAILABLE", { reason: "unreadable" }));
    expect(text(editor()!)).toContain("Arbareto cannot read .gitignore.");
    expect(text(editor()!)).not.toContain("unreadable");
  });
});

// ---- tasks.md T093, T094, T097 (user report and request of 2026-10-25) ----

describe("the selected-line fill stays inside the text box (T093, FR-035)", () => {
  test("the wrapper of the fill clips it, and the preview region does not clip", async () => {
    const { double } = await setup();
    await openFrom(double, "notes.txt");
    const wrapper = field().parentElement!;
    expect(wrapper.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(wrapper.className.split(" ")).toContain("overflow-hidden");
    // The notices list and the tracked note have no scroller of their own.
    expect(preview().className.split(" ")).not.toContain("overflow-hidden");
  });
});

describe("the preview states before a preview (T094, FR-041)", () => {
  test("the idle preview shows its text after the open", async () => {
    const { double } = await setup();
    await openFrom(double, "notes.txt");
    expect(text(preview())).toBe("Change the text to see its effect on ignored files.");
  });

  test("an edit without a status snapshot shows the no-snapshot text and sends no preview", async () => {
    const { world, double } = await setup();
    await openFrom(double, "notes.txt");
    // Registration reuse (contract §6) gives the same repositoryId, so the editor stays open while the new full read runs.
    world.answers.readWorkspace = undefined;
    await openMenubar("Repository");
    await click(menuItem("Open folder…"));
    // The added line is unsaved text. Discard keeps the editor open with the loaded text.
    await click(button("Discard", dialog()!));
    await answer(double.pending("chooseRepository"), succeeded(REGISTRATION));
    expect(editor()).not.toBeNull();
    await typeInto(field(), "*.log\n");
    await pause(450);
    expect(double.count("previewIgnore")).toBe(0);
    expect(text(preview())).toBe("The preview needs a file status read. Press F5, then change the text.");
  });
});

describe("Line endings (T097, FR-037, US5-11, US5-12)", () => {
  const group = () => editor()!.querySelector<HTMLElement>('[role="radiogroup"]')!;
  const radios = () => [...group().querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  const radio = (label: "LF" | "CRLF") => radios().find((r) => text(r.closest("label")!) === label)!;
  const checked = () => radios().filter((r) => r.checked).map((r) => text(r.closest("label")!));
  const EXCLUDE = "C:\\repo\\.git\\info\\exclude";
  const mixed = loaded("a\nb\nc\nd\ne\n", { target: "exclude", file: EXCLUDE, lineEnding: "mixed", lineCounts: { lf: 3, crlf: 2 } });
  const reviewed = (size: number) => succeeded({ action: "ignore-save", plan: { target: "exclude", file: EXCLUDE, size, sha256: "b".repeat(64) }, workbenchToken: fixtureId(0x8e2) });
  async function openMixed() {
    const ctx = await setup();
    await openFrom(ctx.double, "notes.txt", "Add to info/exclude…", mixed);
    return ctx;
  }

  const forms: [string, Record<string, unknown>, string][] = [
    ["lf", {}, "LF"],
    ["crlf", { lineEnding: "crlf" }, "CRLF"],
    ["none", { lineEnding: "none" }, "LF"],
  ];
  for (const [form, fields, shown] of forms) {
    test(`a ${form} file preselects ${shown}`, async () => {
      const { double } = await setup();
      await openFrom(double, "notes.txt", "Add to .gitignore…", loaded("x", fields));
      expect(text(document.getElementById(group().getAttribute("aria-labelledby")!)!)).toBe("Line endings");
      expect(group().closest('[data-slot="ignore-actions"]')).not.toBeNull();
      expect(checked()).toEqual([shown]);
      expect(text(editor()!)).not.toContain("Mixed (");
    });
  }

  test("an absent file preselects LF", async () => {
    const { double } = await setup();
    await openFrom(double, "notes.txt", "Add to info/exclude…", succeeded({ target: "exclude", file: EXCLUDE, state: "absent", text: "", lineEnding: "none", bom: false, expected: "absent" }));
    expect(checked()).toEqual(["LF"]);
  });

  test("a mixed file opens editable with no option, the note, Save unavailable with its reason, and a preview (US5-11)", async () => {
    const { double } = await openMixed();
    expect(checked()).toEqual([]);
    expect(text(document.getElementById(group().getAttribute("aria-describedby")!)!)).toBe("Mixed (3 LF, 2 CRLF)");
    expect(field().readOnly || field().disabled).toBe(false);
    const save = button("Save", editor()!);
    expect(save.getAttribute("aria-disabled") === "true" || save.hasAttribute("disabled")).toBe(true);
    expect(text(document.getElementById(save.getAttribute("aria-describedby")!)!)).toBe("Select LF or CRLF before Save.");
    await click(save);
    await pressKey(field(), "s", { ctrlKey: true });
    expect(double.count("reviewWorkbench")).toBe(0);
    await typeInto(field(), "a\nb\n");
    await pause(450);
    expect(previewCall(double).args[1]).toEqual({ target: "exclude", text: utf8("a\nb\n"), snapshotId: expect.any(String) });
  });

  test("CRLF for a mixed file goes in the preview and the save; after the save the control shows CRLF without the note", async () => {
    const { double } = await openMixed();
    await click(radio("CRLF"));
    expect(checked()).toEqual(["CRLF"]);
    const save = button("Save", editor()!);
    expect(save.hasAttribute("disabled") || save.getAttribute("aria-disabled") === "true").toBe(false);
    expect(save.getAttribute("aria-describedby")).toBeNull();
    await typeInto(field(), "a\nb\n");
    await pause(450);
    expect(previewCall(double).args[1]).toEqual({ target: "exclude", text: utf8("a\nb\n"), snapshotId: expect.any(String), lineEnding: "crlf" });
    await click(save);
    const review = double.pending("reviewWorkbench")!;
    expect(review.args[1]).toEqual({ action: "ignore-save", target: "exclude", text: utf8("a\nb\n"), expected: { size: 10, sha256: SHA }, lineEnding: "crlf" });
    await answer(review, reviewed(6));
    await answer(double.pending("runWorkbench"), succeeded({ action: "ignore-save", outcome: "replaced" }));
    expect(checked()).toEqual(["CRLF"]);
    expect(text(editor()!)).not.toContain("Mixed (");
    // The saved form is the file form now, so the next save sends no form.
    await click(button("Save", editor()!));
    expect(double.pending("reviewWorkbench")!.args[1]).toEqual({ action: "ignore-save", target: "exclude", text: utf8("a\nb\n"), expected: { size: 6, sha256: "b".repeat(64) } });
  });

  test("CRLF for an LF file converts it: both requests carry the form (US5-12)", async () => {
    const { double } = await setup();
    await openFrom(double, "notes.txt");
    await click(radio("CRLF"));
    await typeInto(field(), "*.log\n");
    await pause(450);
    expect(previewCall(double).args[1]).toEqual({ target: "gitignore", text: utf8("*.log\n"), snapshotId: expect.any(String), lineEnding: "crlf" });
    await click(button("Save", editor()!));
    expect(double.pending("reviewWorkbench")!.args[1]).toEqual({ action: "ignore-save", target: "gitignore", text: utf8("*.log\n"), expected: { size: 13, sha256: SHA }, lineEnding: "crlf" });
  });

  test("a CRLF file without a choice sends no form in the preview and the save", async () => {
    const { double } = await setup();
    await openFrom(double, "notes.txt", "Add to .gitignore…", loaded("node_modules/", { lineEnding: "crlf" }));
    await typeInto(field(), "*.log\n");
    await pause(450);
    expect(previewCall(double).args[1]).toEqual({ target: "gitignore", text: utf8("*.log\n"), snapshotId: expect.any(String) });
    await click(button("Save", editor()!));
    expect(double.pending("reviewWorkbench")!.args[1]).toEqual({ action: "ignore-save", target: "gitignore", text: utf8("*.log\n"), expected: { size: 13, sha256: SHA } });
  });
});
