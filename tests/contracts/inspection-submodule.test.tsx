// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { fixtureId } from "./bridge-contract";
import { b64, contextMenu, describedBy, entry, item, menuItem, menuLabels, openCommitView, pressKey, statusBar } from "./commit-fake";
import { stubLayout } from "./history-fake";
import { answer, click, createWorld, mountWorkbench, settle, succeeded, text, unmountAll, type World } from "./sync-fake";

// tasks.md T050 (feature 005, WP7). Story US6. Spec FR-044, FR-047 to FR-052, FR-067. Plan D11, D15 ("Submodules", "Parent button"), data-model §9, contract Δ3 `openSubmodule`, Δ12.

printOrigin("../../src/frontend/submodules/SubmodulesGroup.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/ParentButton.tsx", import.meta.dir);
printOrigin("../../src/frontend/changes/ChangesPane.tsx", import.meta.dir);
printOrigin("../../src/frontend/state/workbench.ts", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);

mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children?: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre data-slot="patch-double">{patch}</pre> }));
registerDom();
const workbench = await import("../../src/frontend/app/Workbench");

// The wide profile shows the Submodules group below the references (004 plan D15 "P2 regions").
const happy = (window as unknown as { happyDOM: { setInnerWidth(n: number): void; setInnerHeight(n: number): void } }).happyDOM;
const before = { width: window.innerWidth, height: window.innerHeight };
let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
beforeEach(() => {
  happy.setInnerWidth(1600);
  happy.setInnerHeight(900);
});
afterEach(async () => {
  await unmountAll();
  happy.setInnerWidth(before.width);
  happy.setInnerHeight(before.height);
});

const PARENT_ENTRY = fixtureId(0x9e0);
const CHILD = { repositoryId: fixtureId(2), generation: 1, worktreeKey: "b".repeat(64) };
type Row = { path: string; depth?: number; parent?: string; action?: string; pathBytes?: string };
let rowIds = 0x9f00;
function rows(list: Row[]) {
  const ids = new Map<string, string>();
  return list.map((row) => {
    const rowId = fixtureId(rowIds++);
    ids.set(row.path, rowId);
    return {
      rowId,
      pathBytes: row.pathBytes ?? b64(row.path),
      path: row.path,
      name: row.path,
      depth: row.depth ?? 0,
      parentRowId: row.parent === undefined ? null : ids.get(row.parent)!,
      url: "https://example.invalid/lib.git",
      head: "1".repeat(40),
      target: "1".repeat(40),
      remotes: [],
      action: row.action ?? "none",
      notes: [],
      refusal: null,
    };
  });
}
const listed = (list: Row[]) => () => succeeded({ generation: 1, rows: rows(list), programs: [], refusals: [], hosts: [], submoduleReviewToken: fixtureId(0x9e1) });
const recent = (current: boolean) => () => succeeded({ entries: [{ entryId: PARENT_ENTRY, path: "C:\\repo", location: { kind: "native" }, openedAt: "2026-10-23T10:00:00Z", current }] });
const rejected = (code: string, result?: unknown) => ({ requestId: fixtureId(0x9e2), state: "rejected", code, ...(result === undefined ? {} : { result }) });
const groupRow = (path: string) => document.querySelector<HTMLElement>(`[data-slot="submodules-group"] [role="treeitem"][data-path="${path}"]`)!;
const parentButton = () => document.querySelector<HTMLElement>('header button[data-slot="parent-button"]');

async function setup(list: Row[], fields: Partial<World> = {}, current = true) {
  const world = createWorld(fields);
  world.answers.reviewSubmodules = listed(list);
  world.answers.listRecentRepositories = recent(current);
  const double = await mountWorkbench(workbench, world);
  await settle();
  return { world, double };
}
/** Answers the pending `openSubmodule` with the registration of the submodule and the reads of the new repository. */
async function opened(double: Awaited<ReturnType<typeof setup>>["double"]) {
  await answer(double.pending("openSubmodule"), succeeded(CHILD));
  await settle();
}

describe("Submodules group open (FR-047, US6-1)", () => {
  test("Enter on a row reads the recent list first, then sends openSubmodule with the parent and the path", async () => {
    const { double } = await setup([{ path: "lib" }]);
    const row = groupRow("lib");
    await act(async () => row.focus());
    const event = await pressKey(row, "Enter");
    expect(event.defaultPrevented).toBe(true);
    await settle();
    const names = double.names();
    expect(names.lastIndexOf("listRecentRepositories")).toBeLessThan(names.lastIndexOf("openSubmodule"));
    expect(double.pending("openSubmodule")!.args[0]).toEqual({ repositoryId: fixtureId(1), path: "lib" });
  });

  test("a double-click on a row opens it", async () => {
    const { double } = await setup([{ path: "lib" }]);
    await act(async () => void groupRow("lib").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    await settle();
    expect(double.pending("openSubmodule")!.args[0]).toEqual({ repositoryId: fixtureId(1), path: "lib" });
  });

  test("the row menu offers Open submodule first, before Update and Copy path", async () => {
    const { double } = await setup([{ path: "lib" }]);
    await contextMenu(groupRow("lib"));
    expect(menuLabels()).toEqual(["Open submodule", "Update", "Copy path"]);
    await click(menuItem("Open submodule"));
    await settle();
    expect(double.pending("openSubmodule")!.args[0]).toEqual({ repositoryId: fixtureId(1), path: "lib" });
  });
});

describe("availability (SubmoduleOpen board, FR-048, US6-3)", () => {
  const cases: [string, Row[], string, string][] = [
    ["an uninitialized clone row", [{ path: "lib", action: "clone" }], "lib", "Initialize this submodule first. Select Update submodules."],
    ["a reuse row", [{ path: "lib", action: "reuse" }], "lib", "Initialize this submodule first. Select Update submodules."],
    ["a nested row", [{ path: "lib" }, { path: "lib/inner", depth: 1, parent: "lib" }], "lib/inner", "Open lib first."],
    ["a path that is not valid UTF-8", [{ path: "bad\uFFFD", pathBytes: Buffer.from([0x62, 0x61, 0x64, 0xff]).toString("base64") }], "bad\uFFFD", "The submodule path is not valid UTF-8, so Arbareto cannot open it."],
  ];
  for (const [name, list, path, reason] of cases) {
    test(`${name} gives "${reason}", and Enter sends nothing`, async () => {
      const { double } = await setup(list);
      await contextMenu(groupRow(path));
      expect(describedBy(menuItem("Open submodule"))).toBe(reason);
      await pressKey(document.activeElement!, "Escape");
      await act(async () => groupRow(path).focus());
      await pressKey(groupRow(path), "Enter");
      expect(double.count("openSubmodule")).toBe(0);
      // Review fix 6: Enter and a double-click show the reason in the status line.
      expect(statusBar()).toContain(reason);
    });
  }

  test("a double-click on an unavailable row shows its reason and sends nothing (review fix 6)", async () => {
    const { double } = await setup([{ path: "lib", action: "clone" }]);
    expect(statusBar()).not.toContain("Initialize this submodule first.");
    await act(async () => void groupRow("lib").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    await settle();
    expect(double.count("openSubmodule")).toBe(0);
    expect(statusBar()).toContain("Initialize this submodule first. Select Update submodules.");
  });

  test("the Commit view row takes the reason of the group row with the same path bytes", async () => {
    const world = createWorld({ entries: [entry("unstaged", "lib", { submodule: "SC..", xy: ".M" })] });
    world.answers.reviewSubmodules = listed([{ path: "lib", action: "clone" }]);
    await openCommitView(workbench, world);
    await contextMenu(item("Changes", "lib"));
    expect(describedBy(menuItem("Open submodule"))).toBe("Initialize this submodule first. Select Update submodules.");
  });

  test("a Commit view row without a loaded group row stays available and opens the same way (US6-6)", async () => {
    const world = createWorld({ entries: [entry("unstaged", "lib", { submodule: "SC..", xy: ".M" })] });
    world.answers.reviewSubmodules = undefined;
    world.answers.listRecentRepositories = recent(true);
    const double = await openCommitView(workbench, world);
    await contextMenu(item("Changes", "lib"));
    expect(describedBy(menuItem("Open submodule"))).toBe("");
    await click(menuItem("Open submodule"));
    await settle();
    expect(double.pending("openSubmodule")!.args[0]).toEqual({ repositoryId: fixtureId(1), path: "lib" });
  });
});

describe("parent chain and button (FR-051, US6-2, data-model §9)", () => {
  test("after an open, the parent button shows the parent folder name, tooltip, and name; one click opens the parent entry and pops the stack", async () => {
    const { double } = await setup([{ path: "lib" }]);
    await act(async () => groupRow("lib").focus());
    await pressKey(groupRow("lib"), "Enter");
    await settle();
    await opened(double);
    const parent = parentButton()!;
    expect(parent).not.toBeNull();
    expect(parent.getAttribute("aria-label")).toBe("Open parent repository repo, C:\\repo");
    expect(text(parent)).toBe("repo");
    expect(parent.querySelector("svg")).not.toBeNull();
    // The button sits before the repository button.
    expect(document.querySelector("header button")).toBe(parent);
    await click(parent);
    const open = double.pending("openRecentRepository")!;
    expect(open.args[0]).toEqual({ entryId: PARENT_ENTRY });
    await answer(open, succeeded({ repositoryId: fixtureId(1), generation: 2, worktreeKey: "a".repeat(64) }));
    expect(parentButton()).toBeNull();
  });

  test("without a current recent entry the stack holds entryId null, so the click states the Open repository text and clears it", async () => {
    const { double } = await setup([{ path: "lib" }], {}, false);
    await act(async () => groupRow("lib").focus());
    await pressKey(groupRow("lib"), "Enter");
    await settle();
    await opened(double);
    await click(parentButton()!);
    expect(double.count("openRecentRepository")).toBe(0);
    expect(statusBar()).toContain("Open the parent repository with Open repository.");
    expect(parentButton()).toBeNull();
  });

  for (const code of ["UNKNOWN_TARGET", "REPOSITORY_UNAVAILABLE"]) {
    test(`${code} from the parent open states the Open repository text and clears the stack`, async () => {
      const { double } = await setup([{ path: "lib" }]);
      await act(async () => groupRow("lib").focus());
      await pressKey(groupRow("lib"), "Enter");
      await settle();
      await opened(double);
      await click(parentButton()!);
      await answer(double.pending("openRecentRepository"), rejected(code));
      expect(statusBar()).toContain("Open the parent repository with Open repository.");
      expect(parentButton()).toBeNull();
    });
  }

  test("every other open clears the stack", async () => {
    const { double } = await setup([{ path: "lib" }]);
    await act(async () => groupRow("lib").focus());
    await pressKey(groupRow("lib"), "Enter");
    await settle();
    await opened(double);
    expect(parentButton()).not.toBeNull();
    await pressKey(document.body, "o", { ctrlKey: true, keyCode: 79 } as KeyboardEventInit);
    await answer(double.pending("chooseRepository"), succeeded({ repositoryId: fixtureId(3), generation: 1, worktreeKey: "c".repeat(64) }));
    expect(parentButton()).toBeNull();
  });

  test("a refused open keeps the parent and pushes nothing", async () => {
    const { double } = await setup([{ path: "lib" }]);
    await act(async () => groupRow("lib").focus());
    await pressKey(groupRow("lib"), "Enter");
    await settle();
    await answer(double.pending("openSubmodule"), rejected("BUSY"));
    expect(parentButton()).toBeNull();
    expect(statusBar()).toContain("A Git operation is running in this repository. Wait for its result, then open the submodule.");
  });
});

describe("refusal texts (plan D15 Submodules, US6-5)", () => {
  const cases: [unknown, string][] = [
    [rejected("SUBMODULE_UNAVAILABLE", { reason: "not-submodule" }), "Git lists no submodule at lib."],
    [rejected("SUBMODULE_UNAVAILABLE", { reason: "submodule-not-initialized" }), "Initialize this submodule first. Select Update submodules."],
    [rejected("SUBMODULE_UNAVAILABLE", { reason: "path" }), "The submodule path holds a link, so Arbareto cannot open it."],
    [rejected("TRUST_REQUIRED"), "Open submodule did not complete: TRUST_REQUIRED."],
  ];
  for (const [response, sentence] of cases) {
    test(`"${sentence}"`, async () => {
      const { double } = await setup([{ path: "lib" }]);
      await act(async () => groupRow("lib").focus());
      await pressKey(groupRow("lib"), "Enter");
      await settle();
      await answer(double.pending("openSubmodule"), response);
      expect(statusBar()).toContain(sentence);
    });
  }

  test("the eighth level of a chain refuses with the chain text", async () => {
    const { double } = await setup([{ path: "lib" }]);
    for (let level = 0; level < 8; level++) {
      await act(async () => groupRow("lib").focus());
      await pressKey(groupRow("lib"), "Enter");
      await settle();
      await opened(double);
    }
    await contextMenu(groupRow("lib"));
    expect(describedBy(menuItem("Open submodule"))).toBe("Arbareto opens at most 8 nested submodules in a row. Open this submodule with Open repository.");
  });
});
