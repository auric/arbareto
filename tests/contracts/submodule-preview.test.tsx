// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import type { OnProgress } from "../../src/frontend/bridge";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { fixtureId } from "./bridge-contract";
import { b64, contextMenu, describedBy, entry, item, menuLabels, openCommitView, pressKey } from "./commit-fake";
import { stubLayout } from "./history-fake";
import { button, buttons, click, createWorld, hoverTooltip, mountWorkbench, oid, settle, succeeded, text, unmountAll, type World } from "./sync-fake";

// tasks.md T109 and T110 (feature 005, WP9). Story US10. Spec FR-069 to FR-076, FR-010, FR-047. Plan D19, data-model §15 and §16, contract Δ3 `readSubmoduleChange` and `readSubmoduleWork`.

printOrigin("../../src/frontend/changes/SubmodulePreview.tsx", import.meta.dir);
printOrigin("../../src/frontend/changes/ChangesPane.tsx", import.meta.dir);
printOrigin("../../src/frontend/history/CommitChanges.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);

mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children?: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre data-slot="patch-double">{patch}</pre> }));
registerDom();
const workbench = await import("../../src/frontend/app/Workbench");

// The wide profile shows the lists and the diff side by side (004 plan D15 "P2 regions").
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

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const LIMITATION = "This entry is a submodule or a nested repository.";
const commits = (n: number, base: number) => Array.from({ length: n }, (_, i) => ({ oid: oid(base + i), subject: `Subject ${base + i}` }));
type State = Record<string, unknown>;
const change = (path: string, state: State, fields: Record<string, unknown> = {}) => ({ pathBytes: b64(path), path, kind: "submodule", old: OLD, new: NEW, state, limited: false, ...fields });
const commitState = (added: number, removed: number) => ({ state: "commits", added, removed, addedCommits: commits(Math.min(added, 50), 0x100), removedCommits: commits(Math.min(removed, 50), 0x200) });
const checked = (path: string, modified: boolean, untracked: boolean) => ({ pathBytes: b64(path), path, state: "checked", modified, untracked });
type Work = { entries?: unknown[]; extraRows?: string[]; limited?: number };
const work = ({ entries = [], extraRows = [], limited = 0 }: Work) => (args: unknown[]) =>
  succeeded({ snapshotId: (args[1] as { snapshotId: string }).snapshotId, entries, extraRows: extraRows.map((p) => ({ pathBytes: b64(p), path: p })), limited });
const rejected = (code: string, result?: unknown) => ({ requestId: fixtureId(0x9e2), state: "rejected", code, ...(result === undefined ? {} : { result }) });
// A submodule comparison: the service gives the support reason `submodule` (001 plan "Limitation text").
const submoduleComparison = (args: unknown[]) => {
  const payload = args[1] as { snapshotId: string; entryId: string };
  return succeeded({ comparisonId: fixtureId(0x7ff), snapshotId: payload.snapshotId, entryId: payload.entryId, scope: "index-to-worktree", completeness: { state: "complete" }, patch: b64(""), hunks: [], support: "submodule", fileAction: "stage", remedy: null });
};
const recent = () => succeeded({ entries: [{ entryId: fixtureId(0x9e0), path: "C:\\repo", location: { kind: "native" }, openedAt: "2026-10-23T10:00:00Z", current: true }] });

const preview = (path = "lib") => document.querySelector<HTMLElement>(`section[aria-label="Submodule ${path}"]`);
const terms = (region: Element) => [...region.querySelectorAll("dt")].map((dt) => text(dt));
const value = (region: Element, term: string) => {
  const dt = [...region.querySelectorAll("dt")].find((d) => text(d) === term);
  return dt === undefined ? null : text(dt.nextElementSibling!);
};
const listItems = (region: Element, heading: string) => {
  const h = [...region.querySelectorAll("h3")].find((e) => text(e) === heading);
  return h === undefined ? null : [...h.nextElementSibling!.querySelectorAll("li")].map((li) => text(li));
};

type Setup = { entries: World["entries"]; change?: ((args: unknown[]) => unknown) | undefined; work?: ((args: unknown[]) => unknown) | undefined };
async function setup({ entries, change: read, work: readWork }: Setup) {
  const world = createWorld({ entries });
  world.answers.readComparison = submoduleComparison;
  world.answers.readSubmoduleChange = read;
  world.answers.readSubmoduleWork = readWork;
  world.answers.listRecentRepositories = recent;
  const double = await openCommitView(workbench, world);
  return { world, double };
}
// Porcelain v2 `1` record modes mH, mI, mW: the index side holds the gitlink.
const GITLINK = ["160000", "160000", "160000"];
const LIB = () => entry("unstaged", "lib", { submodule: "SC..", xy: ".M", modes: GITLINK });

describe("Commit view preview layout (T109 case 1, FR-069 to FR-071, FR-074)", () => {
  test("an unstaged submodule row shows the heading, the tag, Open submodule, Commit, Change, Working tree, and the list with and <n> more", async () => {
    const lib = LIB();
    const { double } = await setup({ entries: [lib], change: () => succeeded(change("lib", commitState(55, 0))), work: work({ entries: [checked("lib", true, true)] }) });
    await click(item("Changes", "lib"));
    const region = preview()!;
    expect(region).not.toBeNull();
    expect(text(region.querySelector("h2")!)).toBe("lib");
    expect(text(region)).toContain("Submodule");
    expect(buttons("Open submodule", region)).toHaveLength(1);
    expect(terms(region)).toEqual(["Commit", "Change", "Working tree"]);
    expect(value(region, "Commit")).toBe(`${OLD.slice(0, 12)} → to ${NEW.slice(0, 12)}`);
    expect(region.querySelector('dd [aria-hidden="true"]')?.textContent?.trim()).toBe("→");
    expect(value(region, "Change")).toBe("55 new commits");
    expect(value(region, "Working tree")).toBe("modified content, untracked content");
    const listed = listItems(region, "New commits")!;
    expect(listed).toHaveLength(51);
    expect(listed[0]).toBe(`${oid(0x100).slice(0, 12)} Subject 256`);
    expect(listed.at(-1)).toBe("and 5 more");
    expect(listItems(region, "Removed commits")).toBeNull();
    const call = double.pending("readSubmoduleChange") ?? double.calls.findLast((c) => c.operation === "readSubmoduleChange")!;
    expect((call.args[1] as { source: Record<string, unknown> }).source).toMatchObject({ kind: "workspace", entryId: lib.entryId });
    expect(text(document.body)).not.toContain(LIMITATION);
  });

  test("a staged row with removed and new commits joins both counts and shows both lists; one removed commit is singular", async () => {
    const lib = entry("staged", "lib", { submodule: "SC..", xy: "M.", modes: GITLINK });
    await setup({ entries: [lib], change: () => succeeded(change("lib", commitState(2, 1))), work: work({ entries: [checked("lib", false, false)] }) });
    await click(item("Staged", "lib"));
    const region = preview()!;
    expect(value(region, "Change")).toBe("2 new commits, 1 removed commit");
    expect(value(region, "Working tree")).toBe("No local edits.");
    expect(listItems(region, "New commits")).toHaveLength(2);
    expect(listItems(region, "Removed commits")).toEqual([`${oid(0x200).slice(0, 12)} Subject 512`]);
  });

  test("the subject of a commit row has the house tooltip with the full subject, and no native title", async () => {
    await setup({ entries: [LIB()], change: () => succeeded(change("lib", commitState(1, 0))), work: work({ entries: [checked("lib", false, false)] }) });
    await click(item("Changes", "lib"));
    const subject = [...preview()!.querySelectorAll("li span")].find((s) => text(s) === "Subject 256")!;
    expect(await hoverTooltip(subject)).toEqual(["Subject 256"]);
    expect(preview()!.querySelector("[title]")).toBeNull();
  });
});

describe("Commit view preview states (T109 case 2, FR-072 to FR-074)", () => {
  type Case = [string, Partial<Setup>, (region: HTMLElement) => void];
  const cases: Case[] = [
    ["missing", { change: () => succeeded(change("lib", { state: "missing", which: "new" })) }, (r) => {
      expect(text(r)).toContain("Fetch the submodule first.");
      expect(terms(r)).toEqual(["Commit", "Working tree"]);
      expect(value(r, "Commit")).toBe(`${OLD.slice(0, 12)} → to ${NEW.slice(0, 12)}`);
    }],
    ["not-initialized", { change: () => succeeded(change("lib", { state: "not-initialized" })) }, (r) => expect(text(r)).toContain("Initialize this submodule first. Select Update submodules.")],
    ["nested", { change: () => succeeded(change("lib", commitState(1, 0), { kind: "nested" })) }, (r) => {
      expect(text(r)).toContain("Nested repository");
      expect(text(r)).toContain("The .gitmodules file does not name this repository.");
      expect(value(r, "Change")).toBe("1 new commit");
    }],
    ["single", { change: () => succeeded(change("lib", { state: "single" }, { old: null })) }, (r) => {
      expect(value(r, "Commit")).toBe(NEW.slice(0, 12));
      expect(r.querySelector('dd [aria-hidden="true"]')).toBeNull();
      expect(r.querySelector("h3")).toBeNull();
    }],
    ["reason programs", { work: work({ entries: [{ pathBytes: b64("lib"), path: "lib", state: "unchecked", reason: "programs" }] }) }, (r) =>
      expect(value(r, "Working tree")).toBe("Arbareto does not read the working tree of this submodule. Its settings name a program that a status read can run.")],
    ["a work entry that is not initialized", { work: work({ entries: [{ pathBytes: b64("lib"), path: "lib", state: "not-initialized" }] }) }, (r) =>
      expect(value(r, "Working tree")).toBe("Initialize this submodule first. Select Update submodules.")],
    ["a gitlink past the 256 bound", { work: work({ entries: [], limited: 1 }) }, (r) => expect(value(r, "Working tree")).toBe("Arbareto checks at most 256 submodules for local edits.")],
    ["a failed work entry", { work: work({ entries: [{ pathBytes: b64("lib"), path: "lib", state: "unchecked", reason: "failed", code: "DEADLINE" }] }) }, (r) => expect(value(r, "Working tree")).toBe("Working tree is unavailable: DEADLINE")],
    ["a failed work read", { work: () => rejected("OUTPUT_LIMIT") }, (r) => expect(value(r, "Working tree")).toBe("Working tree is unavailable: OUTPUT_LIMIT")],
    ["the pending reads", { change: undefined, work: undefined }, (r) => {
      expect(value(r, "Commit")).toBe("Arbareto reads the Git facts.");
      expect(value(r, "Working tree")).toBe("Arbareto reads the Git facts.");
    }],
    ["a failed change read", { change: () => rejected("GIT_FAILED") }, (r) => expect(value(r, "Commit")).toBe("Submodule change is unavailable: GIT_FAILED")],
    ["a path refusal", { change: () => ({ ...rejected("SUBMODULE_UNAVAILABLE", { reason: "path" }), state: "failed" }) }, (r) => expect(value(r, "Commit")).toBe("Submodule change is unavailable: SUBMODULE_UNAVAILABLE")],
  ];
  for (const [name, fields, check] of cases) {
    test(`${name} shows its D19 text and never the limitation text`, async () => {
      await setup({ entries: [LIB()], change: () => succeeded(change("lib", commitState(1, 0))), work: work({ entries: [checked("lib", false, false)] }), ...fields });
      await click(item("Changes", "lib"));
      const region = preview();
      expect(region).not.toBeNull();
      check(region!);
      expect(text(document.body)).not.toContain(LIMITATION);
    });
  }
});

describe("rows with only local edits (T109 case 3, FR-075)", () => {
  async function extra() {
    const files = [entry("unstaged", "vendor/a.ts"), entry("unstaged", "vendor/b.ts")];
    const setupResult = await setup({ entries: files, work: work({ entries: [checked("vendor/dep", true, true)], extraRows: ["vendor/dep"] }) });
    return { ...setupResult, files };
  }

  test("Changes lists the row with M, the marks, the tooltip, and the D19 name; the counts add it", async () => {
    await extra();
    const row = item("Changes", "vendor/dep");
    expect(row.getAttribute("aria-label")).toBe("vendor/dep, submodule, modified, modified content, untracked content");
    expect(row.querySelector('[data-slot="status-letter"]')!.textContent).toBe("M");
    const marks = row.querySelector<HTMLElement>('[data-slot="submodule-marks"]')!;
    expect(text(marks)).toBe("modified content, untracked content");
    expect(await hoverTooltip(marks)).toEqual(["The submodule has local edits. Its commit is unchanged."]);
    expect(describedBy(row)).toBe("The submodule has local edits. Its commit is unchanged.");
    const heading = document.querySelector('[data-list-heading="Changes"]')!;
    expect([...heading.children].map((e) => text(e))).toEqual(["Changes", "3"]);
    expect(item("Changes", "vendor").getAttribute("aria-label")).toBe("vendor, 3");
  });

  test("Stage all changes, Stage folder, and Stage selected leave the row out; its stage button gives the D19 reason", async () => {
    const { double, files } = await extra();
    await click(button("Stage all changes"));
    expect((double.pending("applyFiles")!.args[1] as { entryIds: string[] }).entryIds).toEqual(files.map((f) => f.entryId));
    await act(async () => double.pending("applyFiles")!.resolve(rejected("BUSY")));
    await settle();
    await contextMenu(item("Changes", "vendor"));
    await click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) => text(m).startsWith("Stage folder"))!);
    expect((double.pending("applyFiles")!.args[1] as { entryIds: string[] }).entryIds).toEqual(files.map((f) => f.entryId));
    await act(async () => double.pending("applyFiles")!.resolve(rejected("BUSY")));
    await settle();
    await click(item("Changes", "vendor/a.ts"));
    await act(async () => void item("Changes", "vendor/b.ts").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })));
    await settle();
    await act(async () => void item("Changes", "vendor/dep").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })));
    await settle();
    expect(buttons("Stage selected (3)")).toHaveLength(0);
    const stage = buttons("Stage file dep", item("Changes", "vendor/dep"))[0]!;
    expect(stage.getAttribute("aria-disabled") === "true" || stage.hasAttribute("disabled")).toBe(true);
    expect(describedBy(stage)).toBe("The submodule commit is unchanged. Commit the local edits inside the submodule first.");
  });

  test("a selected row shows its Working tree text alone and sends no readSubmoduleChange; its menu offers Open submodule and Copy path", async () => {
    const { double } = await extra();
    await click(item("Changes", "vendor/dep"));
    const region = preview("vendor/dep")!;
    expect(region).not.toBeNull();
    expect(terms(region)).toEqual(["Working tree"]);
    expect(value(region, "Working tree")).toBe("modified content, untracked content");
    expect(double.count("readSubmoduleChange")).toBe(0);
    expect(double.count("readComparison")).toBe(0);
    await contextMenu(item("Changes", "vendor/dep"));
    expect(menuLabels()).toEqual(["Open submodule", "Copy path"]);
  });

  test("a submodule row with a changed commit shows the marks, and the selected row adds the Change text and new commits to its name", async () => {
    await setup({ entries: [LIB()], change: () => succeeded(change("lib", commitState(3, 0))), work: work({ entries: [checked("lib", true, false)] }) });
    expect(item("Changes", "lib").getAttribute("aria-label")).toBe("lib, submodule, modified, modified content");
    await click(item("Changes", "lib"));
    const row = item("Changes", "lib");
    expect(row.getAttribute("aria-label")).toBe("lib, submodule, modified, new commits, modified content");
    expect(text(row)).toContain("3 new commits");
    expect(describedBy(row)).not.toContain("The submodule has local edits.");
  });
});

describe("reads (T109 case 4, FR-076)", () => {
  test("a new selection cancels the running preview read", async () => {
    const { double } = await setup({ entries: [LIB(), entry("unstaged", "a.ts")], change: undefined, work: work({}) });
    await click(item("Changes", "lib"));
    const read = double.pending("readSubmoduleChange")!;
    await act(async () => (read.args[2] as OnProgress)({ requestId: "r", operationId: fixtureId(0x7a1), state: "accepted", counters: {} } as never));
    await click(item("Changes", "a.ts"));
    expect(double.calls.filter((c) => c.operation === "cancel").map((c) => c.args[0])).toContainEqual({ operationId: fixtureId(0x7a1) });
    expect(preview()).toBeNull();
  });

  test("each new snapshot sends a new readSubmoduleWork with its snapshotId", async () => {
    const { world, double } = await setup({ entries: [LIB()], work: work({}) });
    const sent = () => double.calls.filter((c) => c.operation === "readSubmoduleWork").map((c) => (c.args[1] as { snapshotId: string }).snapshotId);
    const reads = () => double.calls.filter((c) => c.operation === "readWorkspace" && c.done);
    expect(sent().length).toBeGreaterThanOrEqual(1);
    const count = sent().length;
    world.entries = [LIB(), entry("unstaged", "b.ts")];
    await pressKey(document.body, "F5");
    await settle();
    expect(sent().length).toBe(count + 1);
    expect(reads().length).toBeGreaterThanOrEqual(2);
    expect(new Set(sent()).size).toBe(sent().length);
  });
});

describe("keyboard (T109 case 5, FR-047)", () => {
  test("Open submodule is the one Tab stop of the preview, F6 reaches it, and it runs the FR-047 open", async () => {
    const { double } = await setup({ entries: [LIB()], change: () => succeeded(change("lib", commitState(2, 0))), work: work({ entries: [checked("lib", false, false)] }) });
    await click(item("Changes", "lib"));
    const region = preview()!;
    const stops = [...region.querySelectorAll<HTMLElement>('button, input, textarea, [tabindex="0"]')].filter((e) => !e.hasAttribute("disabled"));
    expect(stops.map((e) => text(e))).toEqual(["Open submodule"]);
    const row = item("Changes", "lib");
    await act(async () => row.focus());
    // Plan D19 "Keyboard": F6 reaches the preview after the file lists (Changes, then Staged).
    await pressKey(row, "F6");
    expect(document.activeElement?.closest('[data-section="staged"]')).not.toBeNull();
    await pressKey(document.activeElement!, "F6");
    expect(document.activeElement).toBe(button("Open submodule", region));
    await click(document.activeElement!);
    await settle();
    expect(double.pending("openSubmodule")!.args[0]).toEqual({ repositoryId: fixtureId(1), path: "lib" });
  });
});

describe("History preview (T110, FR-010, FR-069 to FR-073)", () => {
  const P1 = oid(0x31);
  const P2 = oid(0x32);
  function history(world: World, parents: string[]) {
    world.answers.readCommitChanges = (args) => {
      const p = args[1] as { viewId: string; oid: string; parent: number };
      return succeeded({ changesId: fixtureId(0x6100 + p.parent), viewId: p.viewId, oid: p.oid, parents, base: { kind: "parent", index: p.parent, oid: parents[p.parent] }, files: [{ fileId: 0, status: "modified", pathBytes: b64("lib"), kind: "submodule" }], completeness: { state: "complete" } });
    };
    world.answers.readCommitFile = (args) => {
      const p = args[1] as { changesId: string; fileId: number };
      return succeeded({ changesId: p.changesId, fileId: p.fileId, facts: { submodule: { old: OLD, new: NEW } }, binary: false, patch: null, completeness: { state: "complete" } });
    };
    world.answers.readSubmoduleChange = () => succeeded(change("lib", commitState(2, 0)));
    world.answers.readSubmoduleWork = work({ entries: [checked("lib", true, true)] });
  }
  async function selectCommit(world: World) {
    const double = await mountWorkbench(workbench, world);
    const option = document.querySelector<HTMLElement>(`section[aria-label="History"] [role="option"][data-row-id="${world.oids[0]}"]`)!;
    await click(option);
    await settle();
    const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => text(t) === "Changes");
    if (tab !== undefined) await click(tab);
    return double;
  }

  test("a submodule row of Changed files shows the preview without the Working tree row, and no Submodule commit fact", async () => {
    const world = createWorld();
    history(world, [P1]);
    const double = await selectCommit(world);
    const region = preview()!;
    expect(region).not.toBeNull();
    expect(terms(region)).toEqual(["Commit", "Change"]);
    expect(value(region, "Change")).toBe("2 new commits");
    expect(listItems(region, "New commits")).toHaveLength(2);
    expect(text(document.body)).not.toContain("Submodule commit");
    // Review fix 9: the preview shows no readCommitFile result, so a submodule row sends none.
    expect(double.count("readCommitFile")).toBe(0);
    const call = double.calls.findLast((c) => c.operation === "readSubmoduleChange")!;
    expect((call.args[1] as { source: unknown }).source).toMatchObject({ kind: "commit", oid: world.oids[0], parent: 0, record: 0 });
  });

  test("a merge commit with another parent sends the new parent", async () => {
    const world = createWorld();
    history(world, [P1, P2]);
    const double = await selectCommit(world);
    const radio = [...document.querySelectorAll<HTMLInputElement>('[role="radiogroup"][aria-label="Compare with"] input')][1]!;
    await click(radio);
    await settle();
    const call = double.calls.findLast((c) => c.operation === "readSubmoduleChange")!;
    expect((call.args[1] as { source: unknown }).source).toMatchObject({ kind: "commit", parent: 1, record: 0 });
    expect(preview()).not.toBeNull();
  });
});

// --- Review fixes of 2026-10-31 ------------------------------------------------------------------------------------

/** Answers each call later: `next()` answers the oldest open call with `respond`. */
function slow(respond: (args: unknown[]) => unknown) {
  const open: { args: unknown[]; done(value: unknown): void }[] = [];
  return {
    answer: (args: unknown[]) => new Promise((done) => void open.push({ args, done })),
    open,
    async next() {
      const call = open.shift()!;
      await act(async () => call.done(respond(call.args)));
      await settle();
    },
  };
}

describe("review fix 1: one readSubmoduleChange slot for both views", () => {
  test("switching views and a new snapshot in History never show CANCELED", async () => {
    // Contract Δ3: a new request for the same window cancels the running one. The double does the same.
    const open: { args: unknown[]; done(value: unknown): void }[] = [];
    const world = createWorld({ entries: [LIB()] });
    world.answers.readComparison = submoduleComparison;
    world.answers.readSubmoduleWork = work({ entries: [checked("lib", false, false)] });
    world.answers.readSubmoduleChange = (args) =>
      new Promise((done) => {
        for (const old of open.splice(0)) old.done({ requestId: fixtureId(0x9e3), state: "canceled", code: "CANCELED" });
        open.push({ args, done });
      });
    const parents = [oid(0x31)];
    world.answers.readCommitChanges = (args) => {
      const p = args[1] as { viewId: string; oid: string; parent: number };
      return succeeded({ changesId: fixtureId(0x6200), viewId: p.viewId, oid: p.oid, parents, base: { kind: "parent", index: 0, oid: parents[0] }, files: [{ fileId: 0, status: "modified", pathBytes: b64("lib"), kind: "submodule" }], completeness: { state: "complete" } });
    };
    world.answers.readCommitFile = (args) => {
      const p = args[1] as { changesId: string; fileId: number };
      return succeeded({ changesId: p.changesId, fileId: p.fileId, facts: { submodule: { old: OLD, new: NEW } }, binary: false, patch: null, completeness: { state: "complete" } });
    };
    const finish = async () => {
      for (const call of open.splice(0)) await act(async () => call.done(succeeded(change("lib", commitState(1, 0)))));
      await settle();
    };
    await openCommitView(workbench, world);
    await click(item("Changes", "lib"));
    await finish();
    await click(button("History", document.querySelector('header nav[aria-label="Views"]')!));
    await click(document.querySelector<HTMLElement>(`section[aria-label="History"] [role="option"][data-row-id="${world.oids[0]}"]`)!);
    await settle();
    const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => text(t) === "Changes");
    if (tab !== undefined) await click(tab);
    await pressKey(document.body, "F5");
    await settle();
    expect(text(document.body)).not.toContain("CANCELED");
    await finish();
    expect(text(document.body)).not.toContain("CANCELED");
    expect(value(preview()!, "Change")).toBe("1 new commit");
    await click(button("Commit", document.querySelector('header nav[aria-label="Views"]')!));
    await finish();
    expect(text(document.body)).not.toContain("CANCELED");
    expect(value(preview()!, "Change")).toBe("1 new commit");
  });
});

describe("review fix 2: a real selection wins over a local-edits row", () => {
  test("Resolve conflicts after a local-edits row shows the resolve view of the first Conflicted row (004 FR-106)", async () => {
    const conflicted = entry("conflicted", "a.txt", { xy: "UU" });
    const world = createWorld({ operationState: "merging", entries: [conflicted] });
    world.answers.readSubmoduleWork = work({ entries: [checked("dep", true, false)], extraRows: ["dep"] });
    await openCommitView(workbench, world);
    await click(item("Changes", "dep"));
    expect(preview("dep")).not.toBeNull();
    await click(button("Resolve conflicts", document.querySelector('[data-slot="conflict-row"]')!));
    expect(preview("dep")).toBeNull();
    expect(document.querySelector('[data-slot="resolve-view"]')).not.toBeNull();
  });
});

describe("review fix 3 and 8: the local-edits rows across snapshots", () => {
  test("a focused local-edits row keeps its focus and its selection across a new snapshot", async () => {
    const reads = slow(work({ entries: [checked("dep", true, false)], extraRows: ["dep"] }));
    const world = createWorld({ entries: [entry("unstaged", "a.ts")] });
    world.answers.readSubmoduleWork = reads.answer;
    await openCommitView(workbench, world);
    await reads.next();
    await click(item("Changes", "dep"));
    await act(async () => item("Changes", "dep").focus());
    await pressKey(document.body, "F5");
    await settle();
    expect(reads.open).toHaveLength(1);
    const row = item("Changes", "dep");
    expect(document.activeElement).toBe(row);
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(text(row.querySelector('[data-slot="submodule-marks"]')!)).toBe("modified content");
    // Only the Working tree text of the selected row waits for the read of the new snapshot.
    expect(value(preview("dep")!, "Working tree")).toBe("Arbareto reads the Git facts.");
    await reads.next();
    expect(value(preview("dep")!, "Working tree")).toBe("modified content");
  });

  test("three snapshots during one slow read give two reads in total, and the marks appear", async () => {
    const reads = slow(work({ entries: [checked("dep", true, true)], extraRows: ["dep"] }));
    const world = createWorld({ entries: [entry("unstaged", "a.ts")] });
    world.answers.readSubmoduleWork = reads.answer;
    const double = await openCommitView(workbench, world);
    const sent = () => double.calls.filter((c) => c.operation === "readSubmoduleWork");
    expect(sent()).toHaveLength(1);
    for (let i = 0; i < 3; i++) await pressKey(document.body, "F5");
    await settle();
    expect(sent()).toHaveLength(1);
    await reads.next();
    expect(text(item("Changes", "dep").querySelector('[data-slot="submodule-marks"]')!)).toBe("modified content, untracked content");
    expect(sent()).toHaveLength(2);
    const ids = sent().map((c) => (c.args[1] as { snapshotId: string }).snapshotId);
    expect(ids[1]).not.toBe(ids[0]);
    await reads.next();
    expect(sent()).toHaveLength(2);
    expect(item("Changes", "dep")).not.toBeNull();
  });
});

describe("review fix 4: the Working tree row follows the index side of the record", () => {
  test("a staged gitlink deletion has no Working tree row", async () => {
    const gone = entry("staged", "lib", { submodule: "SC..", xy: "D.", modes: ["160000", "000000", "000000"] });
    await setup({ entries: [gone], change: () => succeeded(change("lib", { state: "single" }, { new: null })), work: work({ entries: [] }) });
    await click(item("Staged", "lib"));
    expect(terms(preview()!)).toEqual(["Commit"]);
    expect(text(preview()!)).not.toContain("256");
  });

  test("an index gitlink without an entry while limited is 0 contradicts the contract and states a typed code", async () => {
    await setup({ entries: [LIB()], change: () => succeeded(change("lib", commitState(1, 0))), work: work({ entries: [], limited: 0 }) });
    await click(item("Changes", "lib"));
    expect(value(preview()!, "Working tree")).toBe("Working tree is unavailable: STATE_UNKNOWN");
  });
});

describe("review fix 6: a folder of only local-edits rows", () => {
  test("its Stage folder states the D19 reason, and its menu leaves out Show in Explorer", async () => {
    await setup({ entries: [entry("unstaged", "a.ts")], work: work({ entries: [checked("vendor/dep", true, false)], extraRows: ["vendor/dep"] }) });
    const folder = item("Changes", "vendor");
    const stage = buttons("Stage folder vendor", folder)[0]!;
    expect(stage.getAttribute("aria-disabled") === "true" || stage.hasAttribute("disabled")).toBe(true);
    expect(describedBy(stage)).toBe("The submodule commit is unchanged. Commit the local edits inside the submodule first.");
    await contextMenu(folder);
    expect(menuLabels()).not.toContain("Show in Explorer");
    expect(describedBy([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) => text(m).startsWith("Stage folder"))!)).toBe(
      "The submodule commit is unchanged. Commit the local edits inside the submodule first.",
    );
  });
});
