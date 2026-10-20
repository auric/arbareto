// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// tasks.md T067 (feature 004, WP24). Story US8. Spec FR-076 to FR-082. Plan D13, D15. Contract Δ12.
//
// The interface that T073 builds in `src/frontend/submodules/SubmodulesGroup.tsx`:
// - `useSubmoduleUpdate({ bridge, repositoryId, current, onOperation, onReviewFailed })` holds the one-click flow.
//   `current()` gives the target and the snapshot ID of the shown read. `onOperation` gets each `trackOperation` report.
// - `SubmodulesGroup({ update, runningReason, blockedReason, onCancel })` shows the Submodules group of the sidebar.

import { afterEach, describe, expect, test } from "bun:test";
import { act, useState, type ReactNode } from "react";
import { SubmoduleHostLine, SubmodulePlanRow, SubmoduleRowResult } from "../../src/contracts/submodules";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { contractChecked, fixtureId } from "./bridge-contract";
import { answer, button, buttons, click, menuItem, press, settle, text, type Call } from "./sync-fake";

printOrigin("../../src/frontend/submodules/SubmodulesGroup.tsx", import.meta.dir);
printOrigin("../../src/frontend/status/OperationStatus.tsx", import.meta.dir);
registerDom();
const { createRoot } = await import("react-dom/client");
const { SubmodulesGroup, useSubmoduleUpdate } = await import("../../src/frontend/submodules/SubmodulesGroup");
const { OperationStatus } = await import("../../src/frontend/status/OperationStatus");
type StatusOperation = import("../../src/frontend/status/OperationStatus").StatusOperation;

const RUNNING_REASON = "A Git operation is running. Its progress and Cancel are in the status bar.";
const TARGET = { repositoryId: fixtureId(1), repositoryGeneration: 3 };
const SNAPSHOT = fixtureId(2);
const TOKEN = fixtureId(10);
const OPERATION_ID = fixtureId(11);
const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const short = (oid: string) => oid.slice(0, 12);

const ROW_A = fixtureId(20);
const ROW_A1 = fixtureId(21);
const ROW_B = fixtureId(22);
const planRow = (fields: Partial<SubmodulePlanRow> & { rowId: string; path: string }) =>
  SubmodulePlanRow.parse({ pathBytes: btoa(fields.path), name: fields.path, depth: 0, parentRowId: null, url: null, head: OLD, target: NEW, remotes: [], action: "fetch-checkout", notes: [], refusal: null, ...fields });
const A = planRow({ rowId: ROW_A, path: "libs/a" });
const A1 = planRow({ rowId: ROW_A1, path: "libs/a/deps/c", depth: 1, parentRowId: ROW_A, head: null, action: "clone" });
const B = planRow({ rowId: ROW_B, path: "vendor/b" });
const review = (fields: Record<string, unknown> = {}) => ({ generation: 3, rows: [A, A1, B], programs: [], refusals: [], hosts: [], submoduleReviewToken: TOKEN, ...fields });
const reviewed = (fields: Record<string, unknown> = {}) => ({ requestId: fixtureId(30), operationId: fixtureId(31), state: "succeeded", repositoryGeneration: 3, result: review(fields) });
const rowResult = (fields: Record<string, unknown>) => SubmoduleRowResult.parse({ oldCommit: null, newCommit: null, fetched: false, connected: false, found: false, registered: false, ...fields });
const ended = (state: string, rows: unknown[], code?: string) => ({ requestId: fixtureId(32), operationId: OPERATION_ID, state, ...(code === undefined ? {} : { code }), result: { rows } });
const progress = (phase: "fetch" | "update", path: string, rowIndex: number, percent?: number) => ({
  requestId: fixtureId(33),
  operationId: OPERATION_ID,
  state: "running",
  phase,
  path,
  counters: { rowIndex, rowCount: 3, ...(percent === undefined ? {} : { percent }) },
  stalled: false,
});

function createDouble() {
  const calls: Call[] = [];
  const make = (operation: string) => (...args: unknown[]) =>
    new Promise((resolve) => {
      const call: Call = { operation, args, done: false, resolve: (r) => void ((call.done = true), resolve(r)) };
      calls.push(call);
    });
  const bridge = contractChecked({ reviewSubmodules: make("reviewSubmodules"), updateSubmodules: make("updateSubmodules") });
  const of = (operation: string) => calls.filter((c) => c.operation === operation);
  return { bridge, calls, of, pending: (operation: string) => of(operation).find((c) => !c.done) };
}
type Double = ReturnType<typeof createDouble>;
const payloads = (d: Double, operation: string) => d.of(operation).map((c) => c.args[1]);

const roots: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of roots.splice(0)) await unmount();
});
async function render(node: ReactNode) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(node));
  roots.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
}

// The list-only review of the first read (FR-077). `listed: null` leaves it pending.
async function mount(options: { runningReason?: string | null; blockedReason?: string | null; listed?: unknown | null } = {}) {
  const double = createDouble();
  const operations: StatusOperation[] = [];
  const failures: string[] = [];
  let cancels = 0;
  let attentions = 0;
  let trusts = 0;
  let snapshot = SNAPSHOT;
  let setShown!: (id: string) => void;
  const handle: { update: ReturnType<typeof useSubmoduleUpdate> | null } = { update: null };
  function Harness() {
    const [op, setOp] = useState<StatusOperation | null>(null);
    const [shown, set] = useState(SNAPSHOT);
    setShown = set;
    const update = useSubmoduleUpdate({
      bridge: double.bridge as never,
      repositoryId: TARGET.repositoryId,
      snapshotId: shown,
      current: () => ({ target: TARGET, snapshotId: snapshot }),
      onOperation: (next: StatusOperation) => {
        operations.push(next);
        setOp(next);
      },
      onReviewFailed: (code: string) => void failures.push(code),
      onAttention: () => void attentions++,
    });
    handle.update = update;
    const own = op !== null && op.response === null ? RUNNING_REASON : null;
    return <SubmodulesGroup update={update} runningReason={options.runningReason ?? own} blockedReason={options.blockedReason ?? null} onCancel={() => void cancels++} onTrustReads={() => void trusts++} />;
  }
  await render(<Harness />);
  await settle();
  const listed = options.listed === undefined ? reviewed({ submoduleReviewToken: fixtureId(14) }) : options.listed;
  if (listed !== null) await answer(double.pending("reviewSubmodules"), listed);
  /** A new read with a new snapshot ID (contract §8). */
  const read = async (id: string) => {
    snapshot = id;
    await act(async () => setShown(id));
    await settle();
  };
  return { double, operations, failures, cancels: () => cancels, attentions: () => attentions, trusts: () => trusts, read, handle };
}

const group = () => document.querySelector<HTMLElement>('[data-slot="submodules-group"]')!;
const rows = () => [...group().querySelectorAll<HTMLElement>('[role="treeitem"]')];
const row = (path: string) => rows().find((r) => r.dataset.path === path)!;
const rowState = (path: string) => text(row(path).querySelector('[data-slot="row-state"]')!);
const describedText = (element: Element) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((ref) => text(document.getElementById(ref)!))
    .join(" ");
const sendProgress = (d: Double, event: unknown) => act(async () => (d.pending("updateSubmodules")!.args[2] as (e: unknown) => void)(event));

async function started() {
  const view = await mount();
  await click(button("Update submodules", group()));
  await answer(view.double.pending("reviewSubmodules"), reviewed());
  return view;
}

describe("rows at rest (FR-077)", () => {
  test("the first read lists the rows with one review that starts no update, and the group shows the loading text while it waits", async () => {
    const { double } = await mount({ listed: null });
    expect(double.of("reviewSubmodules").map((c) => c.args.slice(0, 2))).toEqual([[TARGET, { snapshotId: SNAPSHOT }]]);
    expect(text(group().querySelector('[data-slot="list-loading"]')!)).toBe("Arbareto reads the submodules.");
    expect(rows()).toHaveLength(0);
    await answer(double.pending("reviewSubmodules"), reviewed());
    expect(rows().map((r) => r.dataset.path)).toEqual(["libs/a", "libs/a/deps/c", "vendor/b"]);
    expect(group().querySelector('[data-slot="list-loading"]')).toBeNull();
    expect(double.of("updateSubmodules")).toHaveLength(0);
  });

  test("a list review keeps refusals and host lines away, and starts no update", async () => {
    const hosts = [{ path: "vendor/b", fetch: { kind: "host", name: "git.example.net" }, settings: { kind: "host", name: "github.com" } }];
    const refusals = [{ code: "UNSUPPORTED_SUBMODULE", reason: "inactive", path: "libs/a", text: "Submodule libs/a is not active.", remedy: null }];
    const view = await mount({ listed: reviewed({ hosts, refusals }) });
    expect(group().querySelector('[data-slot="host-line"], [data-slot="refusal-line"]')).toBeNull();
    expect(view.attentions()).toBe(0);
    expect(view.double.of("updateSubmodules")).toHaveLength(0);
  });

  test("a read without a run or a Refresh lists nothing; the read after a run lists the rows again", async () => {
    const view = await mount();
    await view.read(fixtureId(3));
    expect(view.double.of("reviewSubmodules")).toHaveLength(1);
    await click(button("Update submodules", group()));
    await answer(view.double.pending("reviewSubmodules"), reviewed());
    await answer(view.double.pending("updateSubmodules"), ended("succeeded", [rowResult({ rowId: ROW_A, path: "libs/a", state: "moved", oldCommit: OLD, newCommit: NEW })]));
    expect(view.double.of("reviewSubmodules")).toHaveLength(2);
    await view.read(fixtureId(4));
    expect(payloads(view.double, "reviewSubmodules")).toEqual([{ snapshotId: SNAPSHOT }, { snapshotId: fixtureId(3) }, { snapshotId: fixtureId(4) }]);
    await answer(view.double.pending("reviewSubmodules"), reviewed({ rows: [A, B] }));
    expect(rows().map((r) => r.dataset.path)).toEqual(["libs/a", "vendor/b"]);
    expect(view.double.of("updateSubmodules")).toHaveLength(1);
  });

  test("the read after a Refresh lists the rows again", async () => {
    const view = await mount();
    await act(async () => view.handle.update!.refreshed());
    await view.read(fixtureId(5));
    expect(payloads(view.double, "reviewSubmodules")).toEqual([{ snapshotId: SNAPSHOT }, { snapshotId: fixtureId(5) }]);
    expect(view.double.of("updateSubmodules")).toHaveLength(0);
  });

  test("a list that needs trust shows the reads text with Trust…, which asks and lists again at the next read", async () => {
    for (const code of ["TRUST_REQUIRED", "TRUST_CHANGED"]) {
      const view = await mount({ listed: { requestId: fixtureId(30), state: "failed", code } });
      const failure = group().querySelector<HTMLElement>('[data-slot="list-failure"]')!;
      expect(text(failure.querySelector("p")!)).toBe("Arbareto reads no changes until you trust this repository.");
      expect(view.failures).toEqual([]);
      expect(text(group())).not.toContain("Arbareto reads the submodules.");
      await click(button("Trust…", failure));
      expect(view.trusts()).toBe(1);
      await view.read(fixtureId(6));
      expect(payloads(view.double, "reviewSubmodules")).toEqual([{ snapshotId: SNAPSHOT }, { snapshotId: fixtureId(6) }]);
      for (const unmount of roots.splice(0)) await unmount();
    }
  });

  test("another list failure names its code", async () => {
    await mount({ listed: { requestId: fixtureId(30), state: "failed", code: "DEADLINE" } });
    expect(text(group().querySelector('[data-slot="list-failure"]')!)).toBe("Arbareto cannot read the submodules: DEADLINE.");
  });

  // Plan D15 "Malformed result": a succeeded review without the fields that the group reads.
  const UNKNOWN_FORM = "The submodules did not load: the result has an unknown form.";
  test("a succeeded list review of unknown form names the unknown form", async () => {
    await mount({ listed: { requestId: fixtureId(31), state: "succeeded", result: {} } });
    expect(text(group().querySelector('[data-slot="list-failure"]')!)).toBe(UNKNOWN_FORM);
  });

  test("a succeeded Update review of unknown form names the unknown form and starts no update", async () => {
    const view = await mount();
    await click(button("Update submodules", group()));
    await answer(view.double.pending("reviewSubmodules"), { requestId: fixtureId(32), state: "succeeded", result: { rows: [] } });
    expect(text(group().querySelector('[data-slot="list-failure"]')!)).toBe(UNKNOWN_FORM);
    expect(view.double.pending("updateSubmodules")).toBeUndefined();
  });
});

describe("one click (FR-076)", () => {
  test("Update submodules sends reviewSubmodules for the shown snapshot, then updateSubmodules with the token at once, and no dialog opens", async () => {
    const { double } = await mount();
    await click(button("Update submodules", group()));
    expect(double.of("reviewSubmodules").map((c) => c.args.slice(0, 2))).toEqual([
      [TARGET, { snapshotId: SNAPSHOT }],
      [TARGET, { snapshotId: SNAPSHOT }],
    ]);
    await answer(double.pending("reviewSubmodules"), reviewed());
    expect(payloads(double, "updateSubmodules")).toEqual([{ submoduleReviewToken: TOKEN, start: true }]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  test("a review without rows shows No submodules found.", async () => {
    const { double } = await mount();
    await click(button("Update submodules", group()));
    await answer(double.pending("reviewSubmodules"), reviewed({ rows: [] }));
    expect(text(group())).toContain("No submodules found.");
  });

  test("a failed review reports its code and sends no update", async () => {
    const { double, failures } = await mount();
    await click(button("Update submodules", group()));
    await answer(double.pending("reviewSubmodules"), { requestId: fixtureId(30), state: "failed", code: "DEADLINE" });
    expect(failures).toEqual(["DEADLINE"]);
    expect(double.of("updateSubmodules")).toHaveLength(0);
  });
});

describe("rows and progress (FR-077)", () => {
  test("rows nest under their parent, and a planned row without events is Waiting", async () => {
    await started();
    expect(rows().map((r) => [r.dataset.path, r.getAttribute("aria-level")])).toEqual([
      ["libs/a", "1"],
      ["libs/a/deps/c", "2"],
      ["vendor/b", "1"],
    ]);
    expect(rows().map((r) => r.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(["libs/a", "libs/a/deps/c", "vendor/b"].map(rowState)).toEqual(["Waiting", "Waiting", "Waiting"]);
  });

  test("progress events map to rows by path: Fetching with the percentage, then Updating; the header shows Updating <i> of <n> and Cancel", async () => {
    const view = await started();
    await sendProgress(view.double, progress("fetch", "libs/a", 1, 62));
    expect(rowState("libs/a")).toBe("Fetching 62%");
    expect(text(group().querySelector('[data-slot="group-header"]')!)).toContain("Updating 1 of 3");
    await sendProgress(view.double, progress("update", "libs/a/deps/c", 2));
    expect(rowState("libs/a/deps/c")).toBe("Updating");
    // The steps of the earlier row ended, but only the result names Done or Failed (no heuristics).
    expect(rowState("libs/a")).toBe("Waiting for the result");
    expect(rowState("vendor/b")).toBe("Waiting");
    expect(text(group().querySelector('[data-slot="group-header"]')!)).toContain("Updating 2 of 3");
    await click(button("Cancel", group()));
    expect(view.cancels()).toBe(1);
  });

  test("the header writes the row counters with a thousands separator, as the worktree button does", async () => {
    const view = await started();
    await sendProgress(view.double, { ...progress("fetch", "libs/a", 1), counters: { rowIndex: 1000, rowCount: 1200 } });
    expect(text(group().querySelector('[data-slot="group-header"]')!)).toContain("Updating 1,000 of 1,200");
  });
});

describe("results (FR-081, FR-082)", () => {
  async function finished() {
    const view = await started();
    const tail = "fatal: Could not read from remote repository.\n";
    await answer(
      view.double.pending("updateSubmodules"),
      ended(
        "failed-with-effects",
        [
          rowResult({ rowId: ROW_A, path: "libs/a", state: "moved", oldCommit: OLD, newCommit: NEW, fetched: true }),
          rowResult({ rowId: ROW_A1, path: "libs/a/deps/c", state: "cloned", newCommit: NEW, connected: true, registered: true }),
          rowResult({ rowId: ROW_B, path: "vendor/b", state: "failed", fetched: true, outputTail: tail, exitCode: 128 }),
        ],
        "GIT_FAILED",
      ),
    );
    return { ...view, tail };
  }

  test("each row shows its observed result, the header shows the totals, and registration changes show as one line", async () => {
    await finished();
    expect(rowState("libs/a")).toBe("Done");
    expect(text(row("libs/a"))).toContain(`Checked out ${short(NEW)}`);
    expect(rowState("libs/a/deps/c")).toBe("Done");
    expect(text(row("libs/a/deps/c"))).toContain(`Cloned, at ${short(NEW)}`);
    expect(rowState("vendor/b")).toBe("Failed");
    expect(text(row("vendor/b").querySelector('[data-slot="exit-code"]')!)).toBe("Git exit code 128.");
    expect(text(group().querySelector('[data-slot="group-header"]')!)).toContain("2 updated, 1 failed");
    const info = [...group().querySelectorAll('[data-slot="registration-line"]')];
    expect(info.map((e) => text(e))).toEqual(["Git changed the repository settings of 1 submodule."]);
    expect(buttons("Update anyway")).toHaveLength(0);
  });

  test("a failed step without an exit code says so and never shows a number", async () => {
    const view = await started();
    await answer(view.double.pending("updateSubmodules"), ended("failed", [rowResult({ rowId: ROW_B, path: "vendor/b", state: "failed", outputTail: "", exitCode: null })], "GIT_FAILED"));
    expect(text(row("vendor/b").querySelector('[data-slot="exit-code"]')!)).toBe("Git gave no exit code for this step.");
  });

  test("a failed read shows no exit code line", async () => {
    const view = await started();
    await answer(view.double.pending("updateSubmodules"), ended("failed", [rowResult({ rowId: ROW_B, path: "vendor/b", state: "failed", failedRead: "check" })], "GIT_FAILED"));
    expect(row("vendor/b").querySelector('[data-slot="exit-code"]')).toBeNull();
  });

  test("Show output shows the bounded output tail as plain text", async () => {
    const { tail } = await finished();
    expect(row("vendor/b").querySelector("pre")).toBeNull();
    await click(button("Show output", row("vendor/b")));
    expect(row("vendor/b").querySelector("pre")!.textContent).toBe(tail);
  });

  test("Retry of a failed row reviews that row only", async () => {
    const { double } = await finished();
    expect(buttons("Retry", row("libs/a"))).toHaveLength(0);
    await click(button("Retry", row("vendor/b")));
    expect(payloads(double, "reviewSubmodules").at(-1)).toEqual({ snapshotId: SNAPSHOT, scope: { path: "vendor/b" } });
  });

  test("the row menu Update reviews that row and its nested rows; the rows above the scope row keep their state", async () => {
    const { double } = await finished();
    await act(async () => void row("libs/a/deps/c").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await settle();
    expect(document.querySelector('[role="menu"]')!.getAttribute("aria-label")).toBe("Actions for libs/a/deps/c");
    await click(menuItem("Update"));
    expect(payloads(double, "reviewSubmodules").at(-1)).toEqual({ snapshotId: SNAPSHOT, scope: { path: "libs/a/deps/c" } });
    // Contract Δ12: the rows above the scope row show as action `none`.
    const scoped = fixtureId(12);
    await answer(double.pending("reviewSubmodules"), reviewed({ rows: [{ ...A, action: "none" }, A1], submoduleReviewToken: scoped }));
    expect(payloads(double, "updateSubmodules").at(-1)).toEqual({ submoduleReviewToken: scoped, start: true });
    expect(rowState("libs/a")).toBe("Done");
    expect(rowState("libs/a/deps/c")).toBe("Waiting");
    expect(rowState("vendor/b")).toBe("Failed");
    await answer(
      double.pending("updateSubmodules"),
      ended("succeeded", [
        rowResult({ rowId: ROW_A, path: "libs/a", state: "unchanged", oldCommit: NEW, newCommit: NEW }),
        rowResult({ rowId: ROW_A1, path: "libs/a/deps/c", state: "unchanged", oldCommit: NEW, newCommit: NEW }),
      ]),
    );
    expect(text(row("libs/a"))).toContain(`Checked out ${short(NEW)}`);
    expect(text(row("libs/a/deps/c"))).toContain("No change");
    expect(rowState("vendor/b")).toBe("Failed");
  });

  test("Shift+F10 on a focused row opens its menu", async () => {
    await finished();
    await act(async () => row("vendor/b").focus());
    await press(row("vendor/b"), "F10", { shiftKey: true });
    expect(document.querySelector('[role="menu"]')!.getAttribute("aria-label")).toBe("Actions for vendor/b");
  });

  for (const [name, init] of [
    ["Shift+F10", { key: "F10", shiftKey: true }],
    ["the Menu key", { key: "ContextMenu" }],
  ] as const)
    test(`${name} on a focused row moves the focus to the first menu item, so the focus outline shows (D16)`, async () => {
      await finished();
      await act(async () => row("vendor/b").focus());
      await press(row("vendor/b"), init.key, init);
      const first = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"] [role="menuitem"]');
      expect(first).not.toBeNull();
      expect(document.activeElement).toBe(first!);
    });

  test("UNKNOWN_TARGET of a scoped review reads the rows again and starts no update", async () => {
    const { double, failures } = await finished();
    await click(button("Retry", row("vendor/b")));
    await answer(double.pending("reviewSubmodules"), { requestId: fixtureId(30), state: "rejected", code: "UNKNOWN_TARGET" });
    expect(failures).toEqual(["UNKNOWN_TARGET"]);
    expect(payloads(double, "reviewSubmodules").at(-1)).toEqual({ snapshotId: SNAPSHOT });
    const updates = double.of("updateSubmodules").length;
    await answer(double.pending("reviewSubmodules"), reviewed({ rows: [A, A1], submoduleReviewToken: fixtureId(13) }));
    expect(double.of("updateSubmodules")).toHaveLength(updates);
    expect(rows().map((r) => r.dataset.path)).toEqual(["libs/a", "libs/a/deps/c"]);
  });

  test("the status bar states the totals", async () => {
    const op: StatusOperation = { requestId: fixtureId(40), kind: "updateSubmodules", progress: null, response: null };
    const done = {
      ...op,
      response: ended("failed-with-effects", [
        rowResult({ rowId: ROW_A, path: "libs/a", state: "moved", oldCommit: OLD, newCommit: NEW }),
        rowResult({ rowId: ROW_A1, path: "libs/a/deps/c", state: "cloned", newCommit: NEW }),
        rowResult({ rowId: ROW_B, path: "vendor/b", state: "failed" }),
      ]) as StatusOperation["response"],
    };
    const bridge = contractChecked({ cancel: () => new Promise(() => {}), getOperation: () => new Promise(() => {}) }) as never;
    await render(
      <OperationStatus bridge={bridge} operation={done} worktreeRoot="C:\work\super" head={null} trusted={false} panel="details" modalOpen={false} refusal={null} onFocusMessageField={() => {}} onClearMessage={() => {}} onRefresh={() => {}} />,
    );
    expect([...document.querySelectorAll('[role="status"]')].map((e) => text(e))).toContain("Update submodules finished. 2 updated, 1 failed.");
  });
});

describe("refusals (FR-078)", () => {
  const UNSAVED = "Submodule vendor/b is at commit 111111111111, which the update can leave without a branch, tag, or other ref. Save it with the command, then use Refresh.";
  const UNSAVED_COMMAND = `& 'C:\\Git\\cmd\\git.exe' --no-lazy-fetch -C 'C:\\work\\super\\vendor\\b' --git-dir=.git branch 'arbareto-saved-111111111111' '${OLD}'`;
  const PARENT = "Submodule libs/a is not initialized. Update libs/a first, then update submodule libs/a/deps/c.";
  const INACTIVE = "Submodule libs/a is not active, and Arbareto does not activate submodules. Activate it with the command, then update it again.";
  const REGISTER = "& 'C:\\Git\\cmd\\git.exe' --no-lazy-fetch -C 'C:\\work\\super' submodule init -- ':(literal)libs/a'";
  const REGISTER_TEXT = "This command registers this submodule in a terminal. Then use Update submodules again.";
  const refusal = (reason: string, path: string, text: string, remedy: unknown) => ({ code: "UNSUPPORTED_SUBMODULE", reason, path, text, remedy });

  test("each refusal shows as one line with its text, Show remedy reveals the remedy, and no update starts", async () => {
    const { double, attentions } = await mount();
    await click(button("Update submodules", group()));
    await answer(
      double.pending("reviewSubmodules"),
      reviewed({
        refusals: [
          refusal("unsaved-commits", "vendor/b", UNSAVED, { command: UNSAVED_COMMAND }),
          refusal("parent-not-initialized", "libs/a/deps/c", PARENT, null),
          refusal("inactive", "libs/a", INACTIVE, { command: REGISTER, text: REGISTER_TEXT }),
        ],
      }),
    );
    expect(double.of("updateSubmodules")).toHaveLength(0);
    const lines = [...group().querySelectorAll<HTMLElement>('[data-slot="refusal-line"]')];
    expect(lines.map((l) => text(l.querySelector("p")!))).toEqual([UNSAVED, PARENT, INACTIVE]);
    // A refusal never waits unseen: the first line takes focus, and the workbench hears of it.
    expect(attentions()).toBe(1);
    expect(document.activeElement === lines[0]).toBe(true);
    expect(buttons("Show remedy", lines[1]!)).toHaveLength(0);
    const show = button("Show remedy", lines[2]!);
    expect(show.getAttribute("aria-expanded")).toBe("false");
    expect(text(lines[2]!)).not.toContain(REGISTER);
    await click(show);
    expect(show.getAttribute("aria-expanded")).toBe("true");
    expect(text(lines[2]!)).toContain(REGISTER_TEXT);
    expect(lines[2]!.querySelector("code")!.textContent).toBe(REGISTER);
    expect(buttons("Copy command", lines[2]!)).toHaveLength(1);
  });
});

describe("host lines (FR-079)", () => {
  const hosts = [
    SubmoduleHostLine.parse({ path: "vendor/b", fetch: { kind: "host", name: "git.example.net" }, settings: { kind: "host", name: "github.com" } }),
    SubmoduleHostLine.parse({ path: "libs/a", fetch: { kind: "local" }, settings: { kind: "unknown" } }),
  ];
  const hostLine = () => group().querySelector<HTMLElement>('[data-slot="host-line"]');

  async function withHosts() {
    const view = await mount();
    await click(button("Update submodules", group()));
    await answer(view.double.pending("reviewSubmodules"), reviewed({ hosts }));
    return view;
  }

  test("one line names both hosts of each row before Git starts", async () => {
    const { double, attentions } = await withHosts();
    expect(double.of("updateSubmodules")).toHaveLength(0);
    expect(attentions()).toBe(1);
    expect(document.activeElement === hostLine()).toBe(true);
    expect([...hostLine()!.querySelectorAll("li")].map((e) => text(e))).toEqual([
      "vendor/b will fetch from git.example.net. The repository settings name github.com.",
      "libs/a will fetch from this computer. The repository settings name a host that Arbareto cannot name.",
    ]);
    expect(buttons("Update anyway", hostLine()!)).toHaveLength(1);
  });

  test("Cancel sends nothing and removes the line", async () => {
    const { double } = await withHosts();
    await click(button("Cancel", hostLine()!));
    expect(hostLine()).toBeNull();
    expect(double.of("updateSubmodules")).toHaveLength(0);
  });

  test("Cancel moves the focus to Update submodules, so the focus never drops to the page", async () => {
    await withHosts();
    await click(button("Cancel", hostLine()!));
    expect(document.activeElement).toBe(button("Update submodules", group()));
  });

  test("Update anyway moves the focus to Update submodules, so the focus never drops to the page", async () => {
    await withHosts();
    await click(button("Update anyway", hostLine()!));
    expect(hostLine()).toBeNull();
    expect(document.activeElement).toBe(button("Update submodules", group()));
  });

  test("Update anyway sends the same token with confirmHosts; STALE_REVIEW reason hosts shows the line again", async () => {
    const { double } = await withHosts();
    await click(button("Update anyway", hostLine()!));
    expect(hostLine()).toBeNull();
    expect(payloads(double, "updateSubmodules")).toEqual([{ submoduleReviewToken: TOKEN, start: true, confirmHosts: true }]);
    await answer(double.pending("updateSubmodules"), { requestId: fixtureId(32), state: "rejected", code: "STALE_REVIEW", result: { reason: "hosts" } });
    expect(hostLine()).not.toBeNull();
    await click(button("Update anyway", hostLine()!));
    expect(payloads(double, "updateSubmodules")).toEqual([
      { submoduleReviewToken: TOKEN, start: true, confirmHosts: true },
      { submoduleReviewToken: TOKEN, start: true, confirmHosts: true },
    ]);
  });
});

describe("running rule (plan D15)", () => {
  test("while an operation runs, Update submodules is unavailable, its reason is only in the tooltip and the description, and a click sends nothing", async () => {
    const { double } = await mount({ runningReason: RUNNING_REASON });
    const update = button("Update submodules", group());
    expect(update.getAttribute("aria-disabled")).toBe("true");
    expect(describedText(update)).toBe(RUNNING_REASON);
    expect(document.getElementById(update.getAttribute("aria-describedby")!)!.classList.contains("sr-only")).toBe(true);
    await click(update);
    // Only the list review of the first read went out.
    expect(double.calls.map((c) => c.operation)).toEqual(["reviewSubmodules"]);
  });

  test("another blocking reason shows as a visible line", async () => {
    const reason = "Git has a merge in progress. Finish or abort it first.";
    const { double } = await mount({ blockedReason: reason });
    const update = button("Update submodules", group());
    expect(update.getAttribute("aria-disabled")).toBe("true");
    expect(describedText(update)).toBe(reason);
    expect(document.getElementById(update.getAttribute("aria-describedby")!)!.classList.contains("sr-only")).toBe(false);
    await click(update);
    // Only the list review of the first read went out.
    expect(double.calls.map((c) => c.operation)).toEqual(["reviewSubmodules"]);
  });
});

describe("T076 board fixes (tasks.md T111, Submodules board)", () => {
  test("the group name is a toggle with a chevron: it hides and shows the rows, and keeps its heading", async () => {
    await mount();
    const heading = group().querySelector("h3")!;
    const toggle = heading.querySelector<HTMLButtonElement>("button")!;
    expect(toggle).not.toBeNull();
    expect(text(toggle)).toBe("Submodules");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(rows()).toHaveLength(3);
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(rows()).toHaveLength(0);
    await click(toggle);
    expect(rows()).toHaveLength(3);
  });

  test("a collapsed group keeps the host line visible (plan D15 \"Header\", tasks.md T113)", async () => {
    const view = await mount();
    await click(button("Update submodules", group()));
    await answer(view.double.pending("reviewSubmodules"), reviewed({ hosts: [SubmoduleHostLine.parse({ path: "vendor/b", fetch: { kind: "host", name: "git.example.net" }, settings: { kind: "host", name: "github.com" } })] }));
    await click(group().querySelector<HTMLButtonElement>("h3 button")!);
    expect(rows()).toHaveLength(0);
    const line = group().querySelector<HTMLElement>('[data-slot="host-line"]');
    expect(line).not.toBeNull();
    expect(text(line!)).toContain("vendor/b will fetch from git.example.net.");
  });

  test("each row shows the submodule icon before its path", async () => {
    await mount();
    for (const r of rows()) expect(r.querySelector('[data-slot="row-icon"] svg[aria-hidden="true"]')).not.toBeNull();
  });
});
