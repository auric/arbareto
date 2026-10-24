// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import type { ChangeEntry } from "../../src/contracts/envelope";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { fixtureId } from "./bridge-contract";
import { b64, contextMenu, describedBy, entry, expectChromiumFocus, item, menuItem, menuItems, menuLabels, openCommitView, pressKey, statusBar, tree } from "./commit-fake";
import { stubLayout } from "./history-fake";
import { answer, button, click, createWorld, settle, snapshot, succeeded, text, unmountAll, type World } from "./sync-fake";

// tasks.md T048 (feature 005, WP7). Stories US2, US4, US7. Spec FR-017 to FR-033, FR-053, FR-054, FR-067. Plan D5, D6, D15 ("Commit view row menu", "Delete confirmation", "Delete run texts"), contract Δ3, Δ8.

printOrigin("../../src/frontend/changes/ChangesPane.tsx", import.meta.dir);
printOrigin("../../src/frontend/changes/file-actions.ts", import.meta.dir);
printOrigin("../../src/frontend/changes/DeleteConfirm.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
printOrigin("../../src/frontend/keyboard/shortcuts.ts", import.meta.dir);

mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children?: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre data-slot="patch-double">{patch}</pre> }));
registerDom();
const workbench = await import("../../src/frontend/app/Workbench");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
afterEach(() => unmountAll());

const TOKEN = fixtureId(0x7d0);
const groupLabels = () => [...document.querySelectorAll('[data-slot="dropdown-menu-label"]')].map((l) => text(l));
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
type Plan = { mode: "recycle" | "permanent"; entryIds: string[]; files: { count: number; paths: string[] }; tracked: number; folder: string | null; wsl: boolean };
const plan = (entries: ChangeEntry[], fields: Partial<Plan> = {}): Plan => ({
  mode: "recycle",
  entryIds: entries.map((e) => e.entryId),
  files: { count: entries.length, paths: entries.slice(0, 20).map((e) => e.pathBytes) },
  tracked: entries.filter((e) => e.category === "unstaged").length,
  folder: null,
  wsl: false,
  ...fields,
});
const reviewed = (p: Plan) => succeeded({ action: "delete", plan: p, workbenchToken: TOKEN });
const rejected = (code: string, result?: unknown) => ({ requestId: fixtureId(0x7d1), state: "rejected", code, ...(result === undefined ? {} : { result }) });

async function setup(entries: ChangeEntry[], fields: Partial<World> = {}) {
  const world = createWorld({ entries, ...fields });
  const double = await openCommitView(workbench, world);
  return { world, double };
}
async function deleteBy(row: HTMLElement, shift = false) {
  await act(async () => row.focus());
  return pressKey(row, "Delete", { shiftKey: shift });
}

describe("row menu (CommitActions board, plan D15)", () => {
  test("an untracked file row shows the three groups in order, with the labelled Delete from disk group", async () => {
    await setup([entry("untracked", "notes.txt")]);
    await contextMenu(item("Changes", "notes.txt"));
    expect(menuLabels()).toEqual(["Stage file", "Blame", "Copy path", "Show in Explorer", "Add to .gitignore…", "Add to info/exclude…", "Delete…", "Delete permanently…"]);
    expect(groupLabels()).toEqual(["Delete from disk"]);
    expect(menuItem("Delete…").getAttribute("aria-keyshortcuts")).toBe("Delete");
    expect(menuItem("Delete permanently…").getAttribute("aria-keyshortcuts")).toBe("Shift+Delete");
    expect(menuItem("Delete…").querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent).toBe("Del");
    expect(menuItem("Delete permanently…").querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent).toBe("Shift+Del");
    for (const label of ["Delete…", "Delete permanently…"]) {
      expect(menuItem(label).getAttribute("data-danger")).toBe("true");
      expect(menuItem(label).querySelector('[data-slot="menu-icon"] svg')).not.toBeNull();
    }
    // The ellipsis marks the editor step; Blame has no history for an untracked row (FR-053).
    expect(describedBy(menuItem("Blame"))).toBe("Git has no history for this file.");
  });

  test("a tracked file row has no ignore group; a staged row has no Delete group (FR-020)", async () => {
    await setup([entry("unstaged", "a.ts"), entry("staged", "b.ts")]);
    await contextMenu(item("Changes", "a.ts"));
    expect(menuLabels()).toEqual(["Stage file", "Blame", "Copy path", "Show in Explorer", "Delete…", "Delete permanently…"]);
    expect(describedBy(menuItem("Blame"))).toBe("");
    await pressKey(document.activeElement ?? document.body, "Escape");
    await contextMenu(item("Staged", "b.ts"));
    expect(menuLabels()).toEqual(["Unstage file", "Blame", "Copy path", "Show in Explorer"]);
    expect(groupLabels()).toEqual([]);
  });

  test("a submodule row offers Open submodule and no Blame, and Delete states the submodule reason", async () => {
    await setup([entry("unstaged", "lib", { submodule: "SC..", xy: ".M" })]);
    await contextMenu(item("Changes", "lib"));
    expect(menuLabels()).toEqual(["Stage file", "Open submodule", "Copy path", "Show in Explorer", "Delete…", "Delete permanently…"]);
    expect(describedBy(menuItem("Delete…"))).toBe("Arbareto does not delete a submodule.");
    expect(describedBy(menuItem("Delete permanently…"))).toBe("Arbareto does not delete a submodule.");
  });

  test("a folder row offers Show in Explorer without a reason (spec FR-018)", async () => {
    await setup([entry("untracked", "logs/1.log"), entry("untracked", "logs/2.log")]);
    await contextMenu(item("Changes", "logs"));
    expect(menuLabels()).toEqual(["Stage folder", "Copy path", "Show in Explorer", "Add to .gitignore…", "Add to info/exclude…", "Delete…", "Delete permanently…"]);
    expect(describedBy(menuItem("Show in Explorer"))).toBe("");
  });

  const reasons: [string, () => ChangeEntry[], string, Partial<World>?][] = [
    ["a conflicted row", () => [entry("conflicted", "c.ts", { xy: "UU" })], "Arbareto does not delete a file with a conflict."],
    ["a nested repository", () => [entry("untracked", "vendor/x/")], "This folder holds another Git repository."],
    ["an unstaged deletion", () => [entry("unstaged", "gone.ts", { xy: ".D" })], "This file is already deleted from the working tree."],
  ];
  // Review fix 3: each path component takes the Windows name rule of the shell (src/contracts/native-path.ts).
  reasons.push(
    ["a name that ends in a period", () => [entry("untracked", "a.")], "Windows does not allow this file name."],
    ["a name that ends in a space", () => [entry("untracked", "trail ")], "Windows does not allow this file name."],
    ["a reserved device name", () => [entry("unstaged", "con.txt")], "Windows does not allow this file name."],
  );

  test("a file below a folder name that Windows refuses is unavailable with the name text (review fix 3)", async () => {
    await setup([entry("untracked", "dir./x.txt"), entry("untracked", "ok.txt")]);
    await contextMenu(item("Changes", "dir."));
    expect(describedBy(menuItem("Delete…"))).toBe("Windows does not allow this file name.");
    await pressKey(document.activeElement ?? document.body, "Escape");
    await contextMenu(item("Changes", "ok.txt"));
    expect(describedBy(menuItem("Delete…"))).toBe("");
  });
  for (const [name, entries, reason] of reasons) {
    test(`Delete is unavailable for ${name} with its reason from the status read (FR-021, US2-7)`, async () => {
      const list = entries();
      await setup(list);
      const path = list[0]!.path.endsWith("/") ? list[0]!.path.slice(0, -1) : list[0]!.path;
      await contextMenu(item("Changes", path));
      expect(describedBy(menuItem("Delete…"))).toBe(reason);
      expect(describedBy(menuItem("Delete permanently…"))).toBe(reason);
    });
  }

  test("a folder that holds a conflicted entry refuses with the conflicted reason", async () => {
    await setup([entry("unstaged", "src/a.ts"), entry("conflicted", "src/b.ts", { xy: "UU" })]);
    await contextMenu(item("Changes", "src"));
    expect(describedBy(menuItem("Delete…"))).toBe("Arbareto does not delete a file with a conflict.");
  });

  test("a folder above the 10,000-file limit is unavailable with the limit (FR-020)", async () => {
    const many = Array.from({ length: 10_001 }, (_, i) => entry("untracked", `big/f${i}.txt`));
    await setup(many);
    await contextMenu(item("Changes", "big"));
    expect(describedBy(menuItem("Delete…"))).toBe("Delete covers at most 10,000 files.");
  });

  test("an unfinished operation gives the 004 text; conflicts give the conflicted count (spec FR-033)", async () => {
    await setup([entry("untracked", "n.txt")], { operationState: "merging" });
    await contextMenu(item("Changes", "n.txt"));
    expect(describedBy(menuItem("Delete…"))).toBe("A Git operation is in progress. Finish it first.");
    await unmountAll();
    await setup([entry("untracked", "n.txt"), entry("conflicted", "c.ts", { xy: "UU" })], { operationState: "merging" });
    await contextMenu(item("Changes", "n.txt"));
    expect(describedBy(menuItem("Delete…"))).toBe("Resolve the 1 conflicted file first.");
  });
});

describe("Delete keys (FR-023, plan D15 keyboard map)", () => {
  test("Del on 3 marked untracked rows reviews them with mode recycle; Shift+Del reviews mode permanent", async () => {
    const files = [entry("untracked", "a.txt"), entry("untracked", "b.txt"), entry("untracked", "c.txt")];
    const { double } = await setup(files);
    await click(item("Changes", "a.txt"));
    await act(async () => void item("Changes", "c.txt").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    await settle();
    const event = await deleteBy(item("Changes", "c.txt"));
    expect(event.defaultPrevented).toBe(true);
    const review = double.pending("reviewWorkbench")!;
    expect(review.args[1]).toEqual({ action: "delete", snapshotId: expect.any(String), entryIds: files.map((f) => f.entryId), mode: "recycle" });
    await answer(review, rejected("CANCELED"));
    await deleteBy(item("Changes", "c.txt"), true);
    expect((double.pending("reviewWorkbench")!.args[1] as { mode: string }).mode).toBe("permanent");
  });

  test("Del without a selection acts on the focused row; a folder row sends its folder bytes and every Changes entry below it", async () => {
    const files = [entry("untracked", "logs/1.log"), entry("untracked", "logs/2.log"), entry("untracked", "n.txt")];
    const { double } = await setup(files);
    await deleteBy(item("Changes", "logs"));
    expect(double.pending("reviewWorkbench")!.args[1]).toEqual({ action: "delete", snapshotId: expect.any(String), entryIds: [files[0]!.entryId, files[1]!.entryId], folder: b64("logs"), mode: "recycle" });
  });

  test("Del acts only while the Changes list has focus: the Staged list and Filter files send nothing", async () => {
    const { double } = await setup([entry("untracked", "n.txt"), entry("staged", "s.ts")]);
    await deleteBy(item("Staged", "s.ts"));
    const filter = document.querySelector<HTMLInputElement>('input[aria-label="Filter files"]')!;
    await act(async () => filter.focus());
    await pressKey(filter, "Delete");
    expect(double.count("reviewWorkbench")).toBe(0);
  });

  test("Del with marked rows and an unmarked focused row acts on the focused row only (decision U5)", async () => {
    const files = [entry("untracked", "a.txt"), entry("untracked", "b.txt"), entry("untracked", "c.txt")];
    const { double } = await setup(files);
    await click(item("Changes", "a.txt"));
    await act(async () => void item("Changes", "b.txt").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    await settle();
    await deleteBy(item("Changes", "c.txt"));
    expect((double.pending("reviewWorkbench")!.args[1] as { entryIds: string[] }).entryIds).toEqual([files[2]!.entryId]);
  });

  test("Del on a name that Windows refuses states the reason and sends no review (review fix 3)", async () => {
    const { double } = await setup([entry("untracked", "a.")]);
    await deleteBy(item("Changes", "a."));
    expect(double.count("reviewWorkbench")).toBe(0);
    expect(statusBar()).toContain("Windows does not allow this file name.");
  });

  test("Del on an unavailable row states the reason and sends no review", async () => {
    const { double } = await setup([entry("unstaged", "lib", { submodule: "SC..", xy: ".M" })]);
    await deleteBy(item("Changes", "lib"));
    expect(double.count("reviewWorkbench")).toBe(0);
    expect(statusBar()).toContain("Arbareto does not delete a submodule.");
  });
});

describe("Delete confirmation (DeleteConfirm board, FR-026 to FR-029)", () => {
  async function confirmFor(files: ChangeEntry[], p: Plan, shift = false, fields: Partial<World> = {}) {
    const { double } = await setup(files, fields);
    await deleteBy(item("Changes", files[0]!.path), shift);
    await answer(double.pending("reviewWorkbench"), reviewed(p));
    return double;
  }

  test("Delete on one untracked file: title, list, buttons, and Cancel with the first focus", async () => {
    const files = [entry("untracked", "notes.txt")];
    await confirmFor(files, plan(files));
    const d = dialog()!;
    expect(text(d.querySelector("h2")!)).toBe("Move 1 file to the Recycle Bin?");
    expect([...d.querySelectorAll("li")].map((li) => text(li))).toEqual(["notes.txt"]);
    const footer = [...d.querySelectorAll("button")].map((b) => text(b));
    expect(footer).toEqual(["Cancel", "Move to Recycle Bin"]);
    expect(text(document.activeElement!)).toBe("Cancel");
    expectChromiumFocus(document.activeElement);
    expect(text(d)).not.toContain("You cannot undo this.");
  });

  test("Shift+Delete: the permanent title, the warning, and the button (US2-2)", async () => {
    const files = [entry("untracked", "notes.txt")];
    await confirmFor(files, plan(files, { mode: "permanent" }), true);
    const d = dialog()!;
    expect(text(d.querySelector("h2")!)).toBe("Delete 1 file permanently?");
    expect(text(d)).toContain("You cannot undo this.");
    expect([...d.querySelectorAll("button")].map((b) => text(b))).toEqual(["Cancel", "Delete permanently"]);
  });

  test("the first 20 paths in the plan order, the rest line, the tracked line, and the plural title (US2-1, US2-3)", async () => {
    const files = Array.from({ length: 22 }, (_, i) => entry(i === 0 ? "unstaged" : "untracked", `f${String(i).padStart(2, "0")}.txt`));
    await confirmFor(files, plan(files, { tracked: 1 }));
    const d = dialog()!;
    expect(text(d.querySelector("h2")!)).toBe("Move 22 files to the Recycle Bin?");
    expect([...d.querySelectorAll("li")].map((li) => text(li))).toEqual(files.slice(0, 20).map((f) => f.path));
    expect(text(d)).toContain("and 2 more files.");
    expect(text(d)).toContain("Git tracks 1 of these files. The index does not change. Git then shows them as deleted.");
  });

  test("one more file says and 1 more file.", async () => {
    const files = Array.from({ length: 21 }, (_, i) => entry("untracked", `g${String(i).padStart(2, "0")}.txt`));
    await confirmFor(files, plan(files));
    expect(text(dialog()!)).toContain("and 1 more file.");
  });

  test("a folder Delete states the folder line above the list (US2-4)", async () => {
    const files = [entry("untracked", "logs/1.log"), entry("untracked", "logs/2.log")];
    const { double } = await setup(files);
    await deleteBy(item("Changes", "logs"));
    await answer(double.pending("reviewWorkbench"), reviewed(plan(files, { folder: b64("logs") })));
    const d = dialog()!;
    const line = [...d.querySelectorAll("p")].find((p) => text(p).startsWith("Arbareto deletes"))!;
    expect(text(line)).toBe("Arbareto deletes the 2 listed files in logs. Ignored and tracked files that the list does not show stay.");
    expect(line.compareDocumentPosition(d.querySelector("ul")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("a WSL repository: plain Delete reviews mode permanent and shows the WSL line (FR-029, US2-8)", async () => {
    const files = [entry("untracked", "notes.txt")];
    const world = createWorld({ entries: files });
    world.answers.readWorkspace = () => succeeded({ ...snapshot(world), location: { kind: "wsl", distro: "Ubuntu-26.04", git: { version: "2.55.0", path: "/usr/bin/git" } } });
    const double = await openCommitView(workbench, world);
    await deleteBy(item("Changes", "notes.txt"));
    const review = double.pending("reviewWorkbench")!;
    expect((review.args[1] as { mode: string }).mode).toBe("permanent");
    await answer(review, reviewed(plan(files, { mode: "permanent", wsl: true })));
    const d = dialog()!;
    expect(text(d.querySelector("h2")!)).toBe("Delete 1 file permanently?");
    expect(text(d)).toContain("Files in a WSL distro have no Recycle Bin.");
    expect(text(d)).toContain("You cannot undo this.");
  });

  test("the long-path refusal shows its text with Close in place of the confirmation (decision U3)", async () => {
    const files = [entry("untracked", "deep.txt")];
    const { double } = await setup(files);
    await deleteBy(item("Changes", "deep.txt"));
    await answer(double.pending("reviewWorkbench"), rejected("WORKBENCH_UNAVAILABLE", { reason: "long-path" }));
    const d = dialog()!;
    expect(text(d.querySelector("h2")!)).toBe("Arbareto does not move a path of 260 or more characters to the Recycle Bin. Use Delete permanently…");
    expect([...d.querySelectorAll("button")].map((b) => text(b))).toEqual(["Close"]);
    expect(text(document.activeElement!)).toBe("Close");
    await click(button("Close", d));
    expect(dialog()).toBeNull();
    expect(double.count("runWorkbench")).toBe(0);
  });

  test("the review refusal path states the Windows name text", async () => {
    const files = [entry("untracked", "a.txt")];
    const { double } = await setup(files);
    await deleteBy(item("Changes", "a.txt"));
    await answer(double.pending("reviewWorkbench"), rejected("WORKBENCH_UNAVAILABLE", { reason: "path" }));
    expect(statusBar()).toContain("Windows does not allow this file name.");
  });

  const refusalTexts: [unknown, string][] = [
    [rejected("WORKBENCH_UNAVAILABLE", { reason: "unreadable" }), "Arbareto cannot read one of these files, so Delete is unavailable."],
    [rejected("WORKBENCH_UNAVAILABLE", { reason: "no-recycle-bin" }), "Files in a WSL distro have no Recycle Bin. Use Delete permanently…"],
    [rejected("STALE_SELECTION"), "The files changed after the status read. Select Refresh (F5), then delete again."],
  ];
  for (const [response, sentence] of refusalTexts) {
    test(`the review refusal states "${sentence}" (review fix 5)`, async () => {
      const files = [entry("untracked", "a.txt")];
      const { double } = await setup(files);
      await deleteBy(item("Changes", "a.txt"));
      await answer(double.pending("reviewWorkbench"), response);
      expect(statusBar()).toContain(sentence);
      expect(statusBar()).not.toContain("did not start");
    });
  }

  test("the notices block is the dialog description, so the tracked, WSL, and irreversible lines are read (review fix 8)", async () => {
    const files = [entry("unstaged", "a.ts")];
    await confirmFor(files, plan(files, { mode: "permanent", wsl: true }), true);
    const described = describedBy(dialog()!);
    expect(described).toContain("Git tracks 1 of these files.");
    expect(described).toContain("Files in a WSL distro have no Recycle Bin.");
    expect(described).toContain("You cannot undo this.");
  });

  test("Cancel closes the dialog and runs nothing", async () => {
    const files = [entry("untracked", "notes.txt")];
    const double = await confirmFor(files, plan(files));
    await click(button("Cancel", dialog()!));
    expect(dialog()).toBeNull();
    expect(double.count("runWorkbench")).toBe(0);
  });
});

describe("Delete run (plan D15 Delete run texts, FR-033, contract Δ8)", () => {
  async function run(files: ChangeEntry[], p: Plan) {
    const { double } = await setup(files);
    await deleteBy(item("Changes", files[0]!.path));
    await answer(double.pending("reviewWorkbench"), reviewed(p));
    await click(button(p.mode === "recycle" ? "Move to Recycle Bin" : "Delete permanently", dialog()!));
    const runCall = double.pending("runWorkbench")!;
    expect(runCall.args.slice(0, 2)).toEqual([{ repositoryId: fixtureId(1) }, { workbenchToken: TOKEN, start: true }]);
    return { double, runCall };
  }
  const outcome = (e: ChangeEntry, value: string, extra: Record<string, unknown> = {}) => ({ entryId: e.entryId, outcome: value, ...(value === "recycled" ? { recycledPath: "C:\\$Recycle.Bin\\S-1\\$R1" } : {}), ...extra });
  const result = (entries: unknown[]) => ({ action: "delete", entries, folders: [] });

  test("the status bar names the run, its progress, and the moved count; the reads follow (contract Δ8)", async () => {
    const files = [entry("untracked", "a.txt"), entry("untracked", "b.txt"), entry("unstaged", "c.ts")];
    const { double, runCall } = await run(files, plan(files));
    const onProgress = runCall.args[2] as (event: unknown) => void;
    await act(async () => onProgress({ requestId: fixtureId(0x7d2), operationId: fixtureId(0x7d3), state: "running", phase: "delete-files", counters: { fileIndex: 2, fileCount: 3 }, stalled: false }));
    await settle();
    expect(statusBar()).toContain("Deleting files (2 of 3)…");
    const reads = double.count("readWorkspace");
    const views = double.count("openHistory");
    await answer(runCall, succeeded(result(files.map((f) => outcome(f, "recycled")))));
    expect(statusBar()).toContain("Moved 3 files to the Recycle Bin.");
    expect(double.count("readWorkspace")).toBeGreaterThan(reads);
    // The History view opens again, so the Working directory row counts the tracked file as deleted.
    expect(double.count("openHistory")).toBeGreaterThan(views);
  });

  test("one recycled file and a permanent delete use their own texts", async () => {
    const one = [entry("untracked", "a.txt")];
    const first = await run(one, plan(one));
    await answer(first.runCall, succeeded(result([outcome(one[0]!, "recycled")])));
    expect(statusBar()).toContain("Moved 1 file to the Recycle Bin.");
    await unmountAll();
    const two = [entry("untracked", "a.txt"), entry("untracked", "b.txt")];
    const second = await run(two, plan(two, { mode: "permanent" }));
    await answer(second.runCall, succeeded(result(two.map((f) => outcome(f, "deleted")))));
    expect(statusBar()).toContain("Deleted 2 files permanently.");
  });

  test("mixed outcomes name each non-zero part, and the details list each path with its outcome", async () => {
    const files = [entry("untracked", "a.txt"), entry("untracked", "b.txt"), entry("untracked", "c.txt"), entry("untracked", "d.txt")];
    const { runCall } = await run(files, plan(files));
    const entries = [outcome(files[0]!, "recycled"), outcome(files[1]!, "kept"), outcome(files[2]!, "changed"), outcome(files[3]!, "error", { code: "access-denied" })];
    await answer(runCall, { ...succeeded(result(entries)), state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" });
    expect(statusBar()).toContain("Delete finished: 1 moved to the Recycle Bin, 1 kept, 1 changed, 1 failed.");
    await click(button("Show details"));
    const area = document.querySelector('section[data-slot="status-area"]')!;
    expect(text(area)).toContain("Delete files details");
    for (const line of ["a.txt: Moved to the Recycle Bin", "b.txt: Kept", "c.txt: Changed, not deleted", "d.txt: Not deleted: access-denied"]) expect(text(area)).toContain(line);
  });

  test("a canceled run states the stopped parts", async () => {
    const files = [entry("untracked", "a.txt"), entry("untracked", "b.txt")];
    const { runCall } = await run(files, plan(files));
    await answer(runCall, { ...succeeded(result([outcome(files[0]!, "stopped"), outcome(files[1]!, "absent")])), state: "canceled", code: "CANCELED" });
    expect(statusBar()).toContain("Delete stopped: 1 not on disk, 1 stopped.");
  });

  test("STALE_REVIEW files-changed and APPROVAL_EXPIRED take their texts (US2-5)", async () => {
    const files = [entry("untracked", "a.txt")];
    const first = await run(files, plan(files));
    await answer(first.runCall, { requestId: fixtureId(0x7d4), state: "failed", code: "STALE_REVIEW", result: { action: "delete", reason: "files-changed" } });
    expect(statusBar()).toContain("The files changed after the review. Arbareto deleted nothing. Select Refresh (F5), then delete again.");
    await unmountAll();
    const second = await run(files, plan(files));
    await answer(second.runCall, rejected("APPROVAL_EXPIRED"));
    expect(statusBar()).toContain("The review expired. Select Delete again.");
  });
});

describe("folder Show in Explorer (US4, FR-018, FR-019)", () => {
  test("a folder row sends revealPath with the folder bytes and an entry below it", async () => {
    const files = [entry("untracked", "logs/1.log"), entry("untracked", "logs/2.log")];
    const { double } = await setup(files);
    await contextMenu(item("Changes", "logs"));
    await click(menuItem("Show in Explorer"));
    expect(double.pending("revealPath")!.args[0]).toEqual({ repositoryId: fixtureId(1), entryId: files[0]!.entryId, folder: b64("logs") });
  });

  test("an absent folder states the refresh text", async () => {
    const files = [entry("untracked", "logs/1.log")];
    const { double } = await setup(files);
    await contextMenu(item("Changes", "logs"));
    await click(menuItem("Show in Explorer"));
    await answer(double.pending("revealPath"), rejected("UNKNOWN_TARGET", { reason: "absent" }));
    expect(statusBar()).toContain("logs does not exist. Select Refresh (F5).");
  });

  test("an absent file states the same text", async () => {
    const { double } = await setup([entry("untracked", "n.txt")]);
    await contextMenu(item("Changes", "n.txt"));
    await click(menuItem("Show in Explorer"));
    await answer(double.pending("revealPath"), rejected("UNKNOWN_TARGET", { reason: "absent" }));
    expect(statusBar()).toContain("n.txt does not exist. Select Refresh (F5).");
  });
});

describe("Commit view Blame (US7, FR-053, FR-054)", () => {
  test("Blame is unavailable for a staged addition and for an unborn HEAD", async () => {
    await setup([entry("staged", "new.ts", { xy: "A." })]);
    await contextMenu(item("Staged", "new.ts"));
    expect(describedBy(menuItem("Blame"))).toBe("Git has no history for this file.");
    await unmountAll();
    await setup([entry("staged", "first.ts")], { head: { state: "unborn", target: "refs/heads/main" } as World["head"] });
    await contextMenu(item("Staged", "first.ts"));
    expect(describedBy(menuItem("Blame"))).toBe("Git has no history for this file.");
  });

  test("Blame switches to History with the snapshot source; Escape returns to the Commit view with the row selected", async () => {
    const files = [entry("unstaged", "src/a.ts"), entry("unstaged", "z.ts")];
    const { double } = await setup(files);
    await contextMenu(item("Changes", "z.ts"));
    await click(menuItem("Blame"));
    const blame = double.pending("readBlame")!;
    expect(blame.args[1]).toEqual({ source: { snapshotId: expect.any(String), entryId: files[1]!.entryId }, options: { ignoreWhitespace: false, detectMoves: false, detectCopies: false, ignoreList: true } });
    const history = document.querySelector<HTMLElement>('[data-view="history"]')!;
    expect(history.hidden).toBe(false);
    expect(text(history)).toContain("Blame: z.ts at");
    await pressKey(history.querySelector('section[data-slot="blame-view"]')!, "Escape");
    expect(document.querySelector<HTMLElement>('section[aria-label="Commit view"]')).not.toBeNull();
    const row = item("Changes", "z.ts");
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(row);
    expectChromiumFocus(document.activeElement);
    expect(tree("Changes")).not.toBeNull();
  });
});

test("the row menu creates no Delete items for the Untracked section row", async () => {
  await setup([entry("untracked", "n.txt")]);
  await contextMenu(tree("Changes").querySelector<HTMLElement>('[data-section-row="untracked"]')!);
  expect(menuItems().map((i) => text(i))).not.toContain("Delete…");
});
