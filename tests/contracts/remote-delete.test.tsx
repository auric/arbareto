// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { stubLayout } from "./history-fake";
import { answer, button, buttons, click, createWorld, expectChromiumFocus, hoverTooltip, itemLabel, mountWorkbench, oid, press, settle, succeeded, text, unmountAll, type World } from "./sync-fake";
import { fixtureId } from "./bridge-contract";
import { ReviewSyncResult, SyncResult } from "../../src/contracts/envelope";

// tasks.md T015 (feature 011, WP5). Stories US1 and US3. Spec FR-001, FR-004, FR-006, FR-008, FR-012, FR-013, FR-016, SC-008, SC-011. Plan D1, D2, D4, D6, D7, D13.
// The review and run answers follow the 011 contract shapes (commit 14107ca2). Each answer passes its schema before the test sends it.

printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
printOrigin("../../src/frontend/branches/BranchActions.tsx", import.meta.dir);
printOrigin("../../src/frontend/branches/RemoteDeleteConfirm.tsx", import.meta.dir);
printOrigin("../../src/frontend/branches/texts.ts", import.meta.dir);
printOrigin("../../src/frontend/status/OperationStatus.tsx", import.meta.dir);
printOrigin("../../src/frontend/sync/useSync.ts", import.meta.dir);
mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre>{patch}</pre> }));
registerDom();
const workbench = await import("../../src/frontend/app/Workbench");
const { remoteRefusalText } = await import("../../src/frontend/branches/texts");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
afterEach(unmountAll);

const TOKEN = fixtureId(0x500);
const SYNC_TOKEN = fixtureId(0x301);
type Entry = Record<string, unknown>;
const local = (name: string, fields: Entry = {}): Entry => ({ ref: `refs/heads/${name}`, kind: "local", name, invalidUtf8: false, oid: oid(4), upstream: null, tracking: null, heldBy: null, current: false, localName: null, upstreamPresent: null, ...fields });
const remote = (name: string, fields: Entry = {}): Entry => ({ ref: `refs/remotes/${name}`, kind: "remote", name, invalidUtf8: false, oid: oid(9), upstream: null, tracking: null, heldBy: null, current: false, localName: null, upstreamPresent: null, ...fields });
const FEATURE = local("feature", { upstream: "refs/remotes/origin/feature" });
const MAIN = local("main", { oid: oid(1), upstream: "refs/remotes/origin/main", current: true });
const ORIGIN_FEATURE = remote("origin/feature", { localName: "feature", oid: oid(2) });
const ORIGIN_MAIN = remote("origin/main", { localName: "main" });
const ENTRIES = [FEATURE, MAIN, ORIGIN_FEATURE, ORIGIN_MAIN];

// Contract Δ3 `SyncPlan` of a remote branch delete. `count` above the list length gives the X5 line.
const DESTINATION = { remote: "origin", ref: "refs/heads/feature", trackingRef: "refs/remotes/origin/feature", url: "https://example.test/r.git", setUpstream: false, upstreamRebase: false, source: "tracking-ref" };
const commits = (n: number) => Array.from({ length: n }, (_, i) => ({ objectId: oid(0x100 + i), subject: i === 1 ? null : `Sample change ${i + 1}` }));
const plan = (count: number, listed = Math.min(count, 100), withLocal = false) => ({
  remotes: ["origin"],
  destination: DESTINATION,
  lease: { trackingRef: "refs/remotes/origin/feature", expect: oid(2), count, commits: commits(listed) },
  ...(withLocal ? { local: { ref: "refs/heads/feature", oid: oid(4), reflogKeeps: true } } : {}),
});
function checked<T>(schema: { safeParse(value: unknown): { success: boolean; error?: unknown } }, value: T): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`fake breaks the contract: ${String(parsed.error)}`);
  return value;
}
const reviewed = (p: ReturnType<typeof plan>) => succeeded(checked(ReviewSyncResult, { action: "delete-remote-branch", plan: p, syncReviewToken: SYNC_TOKEN }));
const refused = (code: string, result: Record<string, unknown> = {}) => ({ requestId: fixtureId(0x5ff), state: "rejected", code, result: checked(ReviewSyncResult, result) });
const push = (status: string, reasonText: string | null = null) => ({ status, oldObjectId: oid(2), newObjectId: status === "deleted" ? null : oid(2), reasonText, lease: true, upstreamWritten: false, upstreamNotSet: false, outputTail: "" });
const ended = (state: string, result: Record<string, unknown>, code?: string) => ({ requestId: fixtureId(0x5fe), operationId: fixtureId(0x511), state, ...(code === undefined ? {} : { code }), result: checked(SyncResult, { action: "delete-remote-branch", ...result }) });
const X27 = { text: "This command fetches origin and removes the remote-tracking branches whose remote branch is gone.", command: "& git --no-lazy-fetch -C C:\\repo fetch --prune -- origin" };

function deleteWorld(fields: Partial<World> = {}): World {
  const world = createWorld({
    branches: [
      { name: "feature", objectId: oid(4), upstream: "refs/remotes/origin/feature", upstreamObjectId: oid(2), track: { state: "counts", ahead: 0, behind: 0 }, current: false },
      { name: "main", objectId: oid(1), upstream: "refs/remotes/origin/main", upstreamObjectId: oid(9), track: { state: "counts", ahead: 2, behind: 3 }, current: true },
    ],
    remotes: [
      { name: "origin/feature", objectId: oid(2) },
      { name: "origin/main", objectId: oid(9) },
    ],
    ...fields,
  });
  world.answers.readBranches = () => succeeded({ entries: ENTRIES });
  world.answers.reviewWorkbench = () => succeeded({ action: "delete-branch", plan: { ref: "refs/heads/feature", oid: oid(4), onlyHere: 0, reflogKeeps: true, heldBy: null, current: false }, workbenchToken: TOKEN });
  return world;
}

const footer = () => document.querySelector("footer")!;
const alertDialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const openMenuItems = () => [...document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-content"] [role="menuitem"]')];
const syncReviews = (double: { calls: { operation: string; args: unknown[] }[] }) => double.calls.filter((c) => c.operation === "reviewSync").map((c) => c.args[1]);
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
/** A sidebar row by the start of its accessible name. */
async function sidebarRow(name: string): Promise<HTMLElement> {
  const toggle = document.querySelector<HTMLElement>('button[aria-label="Show references"]');
  if (toggle !== null && toggle.getAttribute("aria-expanded") !== "true") await click(toggle);
  await type(document.querySelector<HTMLInputElement>('input[aria-label="Filter references"]')!, name);
  const found = [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter((e) => (e.getAttribute("aria-label") ?? "").startsWith(`${name},`));
  if (found.length !== 1) throw new Error(`expected one sidebar row "${name}", found ${found.length}`);
  return found[0]!;
}
async function contextMenu(element: Element) {
  await act(async () => void element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  await settle();
}
/** Del on the focused sidebar row `name`. */
async function del(name: string) {
  const row = await sidebarRow(name);
  await act(async () => row.focus());
  await press(row, "Delete");
}
/** Del on origin/feature, then the review answer. Returns the open alert dialog. */
async function remoteDialog(p = plan(3), world = deleteWorld()) {
  const double = await mountWorkbench(workbench, world);
  await del("origin/feature");
  await answer(double.pending("reviewSync"), reviewed(p));
  return { double, dialog: alertDialog()! };
}
/** X8 in the remote dialog. Returns the pending `sync` call. */
async function confirmRemote() {
  const { double, dialog } = await remoteDialog();
  await click(button("Delete remote branch", dialog));
  return { double, run: double.pending("sync")! };
}
/** Del on the local row feature, the check box X9, the review answer, then Delete. Returns the pending `sync` call. */
async function confirmCombined() {
  const double = await mountWorkbench(workbench, deleteWorld());
  await del("feature");
  await click(document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!);
  await answer(double.pending("reviewSync"), reviewed(plan(2, 2, true)));
  await click(button("Delete", document.querySelector('[role="dialog"]')!));
  return { double, run: double.pending("sync")! };
}
async function progress(run: { args: unknown[] }, phase: string) {
  await act(async () => (run.args[2] as (e: unknown) => void)({ requestId: fixtureId(0x5fe), operationId: fixtureId(0x511), state: "running", phase, counters: {} }));
  await settle();
}

describe("entry points (plan D1, FR-001)", () => {
  test("the remote-tracking menu holds X1 last in group 2, in the danger style, with the trash icon and the key text Del", async () => {
    await mountWorkbench(workbench, deleteWorld());
    await contextMenu(await sidebarRow("origin/feature"));
    const groups = [...document.querySelectorAll('[data-slot="dropdown-menu-content"] [data-slot="dropdown-menu-group"]')].map((g) => [...g.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(itemLabel));
    expect(groups).toEqual([
      ["Switch", "Merge into current branch (main)…", "Rebase current branch (main) onto origin/feature…"],
      ["Create branch here…", "Add worktree for this branch…", "Delete remote branch…"],
      ["Copy branch name"],
    ]);
    const item = openMenuItems().find((i) => itemLabel(i) === "Delete remote branch…")!;
    expect(item.getAttribute("data-danger")).toBe("true");
    expect(item.getAttribute("aria-keyshortcuts")).toBe("Delete");
    expect(text(item.querySelector('[data-slot$="shortcut"]')!)).toBe("Del");
    expect(item.querySelector('[data-slot="menu-icon"] svg')).not.toBeNull();
  });

  test("a History remote label opens the same menu, and X1 there starts the review of that ref", async () => {
    const world = deleteWorld({ oids: [oid(1), oid(2), oid(3)], remoteLabels: true });
    const double = await mountWorkbench(workbench, world);
    const chip = [...document.querySelectorAll<HTMLElement>('[data-slot="row-labels"] .chip[data-kind="remote"]')].find((c) => text(c) === "origin/feature");
    expect(chip).toBeDefined();
    await contextMenu(chip!);
    expect(openMenuItems().map(itemLabel)).toContain("Delete remote branch…");
    await click(openMenuItems().find((i) => itemLabel(i) === "Delete remote branch…")!);
    expect(syncReviews(double)).toEqual([{ action: "delete-remote-branch", ref: "refs/remotes/origin/feature" }]);
    expect(double.count("reviewWorkbench")).toBe(0);
  });

  test("Del on a remote-tracking row starts the review and never the 004 delete", async () => {
    const double = await mountWorkbench(workbench, deleteWorld());
    await del("origin/feature");
    expect(syncReviews(double)).toEqual([{ action: "delete-remote-branch", ref: "refs/remotes/origin/feature" }]);
    expect(double.count("reviewWorkbench")).toBe(0);
  });

  test("during a merge, Del states the existing blocked reason and starts no review", async () => {
    const double = await mountWorkbench(workbench, deleteWorld({ operationState: "merging" }));
    await del("origin/feature");
    expect(text(footer())).toContain("A merge, a rebase, a cherry-pick, or a revert is in progress.");
    expect(double.count("reviewSync")).toBe(0);
  });

  test("the trust ask of the review names push", async () => {
    const double = await mountWorkbench(workbench, deleteWorld());
    await del("origin/feature");
    await answer(double.pending("reviewSync"), { requestId: fixtureId(0x5ff), state: "rejected", code: "TRUST_REQUIRED" });
    expect(double.pending("approveTrust")!.args[1]).toEqual({ action: "push" });
  });
});

describe("remote confirmation (plan D2, FR-006, SC-008)", () => {
  test("the alert dialog states X2, X3, X4, the list named X30, X5, and X7, with X8 after Cancel", async () => {
    const { dialog } = await remoteDialog(plan(150));
    expect(dialog).not.toBeNull();
    expect(text(document.getElementById(dialog.getAttribute("aria-labelledby")!)!)).toBe("Delete the remote branch origin/feature?");
    expect(text(dialog)).toContain("Git deletes refs/heads/feature on origin, and the remote-tracking branch origin/feature here.");
    expect([...dialog.querySelectorAll("code")].map((c) => text(c))).toContain("refs/heads/feature");
    expect(text(dialog)).toContain("150 commits are on no other branch, tag, or remote-tracking branch here:");
    const list = dialog.querySelector<HTMLElement>('ul[aria-label="Commits only on origin/feature"]')!;
    expect(list).not.toBeNull();
    expect(list.querySelectorAll("li")).toHaveLength(100);
    expect([...list.querySelector("li")!.children].map((c) => text(c))).toEqual([oid(0x100).slice(0, 12), "Sample change 1"]);
    expect(text(dialog)).toContain("and 50 more commits");
    expect(text(dialog)).toContain("Other people can lose work. The delete stops if origin/feature changed since the last fetch.");
    expect([...dialog.querySelectorAll("button")].map((b) => text(b))).toEqual(["Cancel", "Delete remote branch"]);
    expect(button("Delete remote branch", dialog).getAttribute("data-danger")).toBe("true");
  });

  test("one commit takes the singular X4 and the list; a count of 0 states X6 and shows no list", async () => {
    let { dialog } = await remoteDialog(plan(1));
    expect(text(dialog)).toContain("1 commit is on no other branch, tag, or remote-tracking branch here:");
    expect(dialog.querySelectorAll('ul[aria-label="Commits only on origin/feature"] li')).toHaveLength(1);
    await unmountAll();
    ({ dialog } = await remoteDialog(plan(0)));
    expect(text(dialog)).toContain("Another branch, tag, or remote-tracking branch here holds every commit of origin/feature.");
    expect(dialog.querySelector("ul")).toBeNull();
    expect(text(dialog)).not.toContain("more commit");
  });

  test("Cancel has the first focus; no default button: no form, no submit button, no access key", async () => {
    const { dialog } = await remoteDialog();
    expect(document.activeElement).toBe(button("Cancel", dialog));
    expectChromiumFocus(document.activeElement);
    expect(dialog.querySelector("form")).toBeNull();
    expect(dialog.querySelector('[type="submit"]')).toBeNull();
    expect(dialog.querySelector("[accesskey]")).toBeNull();
  });

  test("Enter on the dialog and on Cancel, then Escape, start no delete", async () => {
    const { double, dialog } = await remoteDialog();
    await press(dialog, "Enter");
    expect(double.count("sync")).toBe(0);
    await press(button("Cancel", dialog), "Enter");
    await press(document.activeElement ?? document.body, "Escape");
    expect(alertDialog()).toBeNull();
    expect(double.count("sync")).toBe(0);
  });

  test("Escape closes the dialog and starts no delete", async () => {
    const { double } = await remoteDialog();
    await press(document.activeElement!, "Escape");
    expect(alertDialog()).toBeNull();
    expect(double.count("sync")).toBe(0);
  });

  test("X8 sends sync with the reviewed sync token", async () => {
    const { run } = await confirmRemote();
    expect(run.args[1]).toEqual({ syncReviewToken: SYNC_TOKEN, start: true });
    expect(alertDialog()).toBeNull();
  });

  test("a long name wraps in the dialog and keeps its full text", async () => {
    const { dialog } = await remoteDialog();
    const title = document.getElementById(dialog.getAttribute("aria-labelledby")!)!;
    expect(title.className).toContain("[overflow-wrap:anywhere]");
    expect(title.className).not.toContain("truncate");
  });
});

describe("refusals (plan D4, FR-004, SC-011)", () => {
  const names = { tracking: "origin/feature", branch: "feature", remote: "origin" };
  const cases: [string, string, Record<string, unknown>, string][] = [
    ["X13 default-branch", "SYNC_UNAVAILABLE", { reason: "default-branch" }, "origin/feature is the default branch of origin. Arbareto does not delete the default branch of a remote."],
    ["X14 default-unknown", "SYNC_UNAVAILABLE", { reason: "default-unknown" }, "Arbareto cannot tell the default branch of origin. Fetch origin, or run git remote set-head origin --auto, then try again."],
    ["X15 no-remote-branch", "SYNC_UNAVAILABLE", { reason: "no-remote-branch" }, "No fetch refspec of exactly one remote maps origin/feature to a remote branch, so Arbareto cannot name it."],
    ["X16 not-upstream", "SYNC_UNAVAILABLE", { reason: "not-upstream" }, "origin/feature is no longer the upstream of feature. Close this dialog, then try again."],
    ["X17 UNKNOWN_TARGET", "UNKNOWN_TARGET", {}, "origin/feature no longer exists here."],
    ["the REASONS text of current-branch", "WORKBENCH_UNAVAILABLE", { reason: "current-branch" }, "You cannot delete the current branch. Switch to another branch first."],
    ["the REASONS text of other-worktree", "WORKBENCH_UNAVAILABLE", { reason: "other-worktree", worktree: "C:\\wt\\x" }, "The worktree C:\\wt\\x holds this branch. Open that worktree, or remove it first."],
    ["the fallback of push-urls", "SYNC_UNAVAILABLE", { reason: "push-urls" }, "The action did not start: SYNC_UNAVAILABLE push-urls."],
    ["the fallback of mirror", "SYNC_UNAVAILABLE", { reason: "mirror" }, "The action did not start: SYNC_UNAVAILABLE mirror."],
    ["the fallback of unknown-operation", "SYNC_UNAVAILABLE", { reason: "unknown-operation" }, "The action did not start: SYNC_UNAVAILABLE unknown-operation."],
    ["the fallback of OPERATION_IN_PROGRESS", "OPERATION_IN_PROGRESS", {}, "The action did not start: OPERATION_IN_PROGRESS."],
  ];
  for (const [label, code, result, expected] of cases) {
    test(`${label} gives its text`, () => {
      expect(remoteRefusalText(refused(code, result) as never, names)).toBe(expected);
    });
  }

  // The 011 contract `SyncRefused` names no remote. The renderer has no authoritative remote name for X13 and X14, so it shows the fallback.
  test("without a remote name, X13 and X14 fall back to the code and the reason", () => {
    expect(remoteRefusalText(refused("SYNC_UNAVAILABLE", { reason: "default-branch" }) as never, { ...names, remote: null })).toBe("The action did not start: SYNC_UNAVAILABLE default-branch.");
    expect(remoteRefusalText(refused("SYNC_UNAVAILABLE", { reason: "default-unknown" }) as never, { ...names, remote: null })).toBe("The action did not start: SYNC_UNAVAILABLE default-unknown.");
  });

  for (const [code, result, expected] of [
    ["SYNC_UNAVAILABLE", { reason: "no-remote-branch" }, "No fetch refspec of exactly one remote maps origin/feature to a remote branch, so Arbareto cannot name it."],
    ["UNKNOWN_TARGET", {}, "origin/feature no longer exists here."],
    ["SYNC_UNAVAILABLE", { reason: "push-urls" }, "The action did not start: SYNC_UNAVAILABLE push-urls."],
  ] as const) {
    test(`Del with the refusal ${code} ${"reason" in result ? result.reason : ""} states its text in the status bar and opens no dialog`, async () => {
      const double = await mountWorkbench(workbench, deleteWorld());
      await del("origin/feature");
      await answer(double.pending("reviewSync"), refused(code, result));
      expect(text(footer())).toContain(expected);
      expect(alertDialog()).toBeNull();
      expect(double.count("sync")).toBe(0);
    });
  }
});

describe("run steps and outcomes (plan D6, D7, FR-008, FR-012, FR-013)", () => {
  test("the step text is X19 for sync-push and X28 for sync-delete-local", async () => {
    const { run } = await confirmCombined();
    await progress(run, "sync-push");
    expect(text(footer())).toContain("Deleting the remote branch on origin…");
    await progress(run, "sync-delete-local");
    expect(text(footer())).toContain("Deleting feature…");
    expect(text(footer())).not.toContain("Deleting the remote branch on origin…");
  });

  const remoteOnly: [string, ReturnType<typeof ended>, string][] = [
    ["deleted gives X20", ended("succeeded", { push: push("deleted") }), "Deleted the remote branch origin/feature."],
    ["a stale lease gives X22", ended("failed", { push: push("rejected", "stale info"), reason: "stale-lease", remedy: X27 }, "PUSH_REJECTED"), "origin/feature changed on origin since the last fetch, so Git deleted nothing. Fetch origin, then try again."],
    ["the gone recovery gives X23", ended("succeeded", { push: push("rejected", "stale info"), reason: "stale-lease", remoteGone: true }), "origin lists no branch feature. Arbareto deleted the remote-tracking branch origin/feature."],
    ["a rejection with another reason gives E2", ended("failed", { push: push("rejected", "fetch first"), reason: "rejected" }, "PUSH_REJECTED"), "Rejected by the remote: fetch first"],
    ["remote-rejected gives E2", ended("failed", { push: push("remote-rejected", "pre-receive hook declined"), reason: "remote-rejected" }, "PUSH_REJECTED"), "Rejected by the remote: pre-receive hook declined"],
    ["remote-failure gives E2", ended("failed", { push: push("remote-failure", "remote unpack failed"), reason: "remote-failure" }, "PUSH_REJECTED"), "Rejected by the remote: remote unpack failed"],
    ["a failed push gives E3", ended("failed", { push: push("none"), remedy: { text: "This command runs the step in a terminal.", command: "& git push" } }, "GIT_FAILED"), "Delete remote branch did not complete: GIT_FAILED"],
    ["Cancel gives E4", ended("canceled", { push: push("none") }), "Delete remote branch canceled. The remote can hold this push. Fetch to see the remote state."],
  ];
  for (const [label, response, expected] of remoteOnly) {
    test(`remote only: ${label}`, async () => {
      const { run } = await confirmRemote();
      await answer(run, response);
      expect(text(footer())).toContain(expected);
      expect(text(footer())).not.toContain("feature stays.");
    });
  }

  const combined: [string, ReturnType<typeof ended>, string][] = [
    ["both deleted give X21", ended("succeeded", { push: push("deleted") }), "Deleted feature and the remote branch origin/feature."],
    ["a failed local write gives X24", ended("failed-with-effects", { push: push("deleted"), localNotDeleted: true }, "GIT_FAILED"), "Deleted the remote branch origin/feature. feature stays."],
    ["a stale lease gives X22 and X25", ended("failed", { push: push("rejected", "stale info"), reason: "stale-lease", remedy: X27 }, "PUSH_REJECTED"), "origin/feature changed on origin since the last fetch, so Git deleted nothing. Fetch origin, then try again. feature stays."],
    ["the gone recovery gives X23 and X26", ended("succeeded", { push: push("rejected", "stale info"), reason: "stale-lease", remoteGone: true }), "origin lists no branch feature. Arbareto deleted the remote-tracking branch origin/feature. Deleted the local branch feature."],
    ["the gone recovery and a failed local write give X23 and X25", ended("failed-with-effects", { push: push("rejected", "stale info"), reason: "stale-lease", remoteGone: true, localNotDeleted: true }, "GIT_FAILED"), "origin lists no branch feature. Arbareto deleted the remote-tracking branch origin/feature. feature stays."],
    ["remote-rejected gives E2 and X25", ended("failed", { push: push("remote-rejected", "pre-receive hook declined"), reason: "remote-rejected" }, "PUSH_REJECTED"), "Rejected by the remote: pre-receive hook declined. feature stays."],
    ["a failed push gives E3 and X25", ended("failed", { push: push("none") }, "GIT_FAILED"), "Delete remote branch did not complete: GIT_FAILED. feature stays."],
    ["Cancel gives E4 and X25", ended("canceled", { push: push("none") }), "Delete remote branch canceled. The remote can hold this push. Fetch to see the remote state. feature stays."],
  ];
  for (const [label, response, expected] of combined) {
    test(`combined: ${label}`, async () => {
      const { run } = await confirmCombined();
      await answer(run, response);
      expect(text(footer())).toContain(expected);
    });
  }

  test("the details area has the heading X29 and shows the remedy X27 of a stale lease", async () => {
    const { run } = await confirmRemote();
    await answer(run, ended("failed", { push: push("rejected", "stale info"), reason: "stale-lease", remedy: X27 }, "PUSH_REJECTED"));
    await click(button("Show details"));
    const area = document.querySelector<HTMLElement>('section[data-slot="status-area"]')!;
    expect(text(area.querySelector("h2")!)).toBe("Delete remote branch details");
    expect(text(area)).toContain(X27.text);
    expect(text(area)).toContain(X27.command);
    expect(buttons("Copy command", area)).toHaveLength(1);
  });

  test("a cut status-bar line keeps its full text in a tooltip and in its accessible name", async () => {
    const prototype = HTMLElement.prototype as unknown as Record<string, unknown>;
    const saved = ["scrollWidth", "clientWidth"].map((key) => [key, Object.getOwnPropertyDescriptor(prototype, key)] as const);
    Object.defineProperty(prototype, "scrollWidth", { configurable: true, get: () => 900 });
    Object.defineProperty(prototype, "clientWidth", { configurable: true, get: () => 300 });
    try {
      const { run } = await confirmCombined();
      await answer(run, ended("succeeded", { push: push("rejected", "stale info"), reason: "stale-lease", remoteGone: true }));
      const full = "origin lists no branch feature. Arbareto deleted the remote-tracking branch origin/feature. Deleted the local branch feature.";
      const line = [...footer().querySelectorAll<HTMLElement>('[role="status"]')].find((e) => text(e) === full)!;
      expect(line).toBeDefined();
      expect(line.getAttribute("aria-label")).toBe(full);
      expect(line.hasAttribute("title")).toBe(false);
      expect(await hoverTooltip(line)).toEqual([full]);
    } finally {
      for (const [key, descriptor] of saved) {
        if (descriptor === undefined) delete prototype[key];
        else Object.defineProperty(prototype, key, descriptor);
      }
    }
  });
});
