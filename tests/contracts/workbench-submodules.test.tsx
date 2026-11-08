// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// tasks.md T067 (feature 004, WP24). Story US8. Spec FR-076 to FR-082. Plan D13, D15. Contract Δ12.
//
// The interface that T073 builds in `src/frontend/submodules/SubmodulesGroup.tsx`:
// - `useSubmoduleUpdate({ bridge, repositoryId, current, onOperation, onReviewFailed })` holds the one-click flow.
//   `current()` gives the target and the snapshot ID of the shown read. `onOperation` gets each `trackOperation` report.
// - `SubmodulesGroup({ update, runningReason, blockedReason, onCancel })` shows the Submodules group of the sidebar.
// tasks.md T142 (feature 004, WP31). Story US12. Spec FR-107 to FR-111. Plan D20, D15 "Tree rows". Data-model §12 "Tree node", §15.
// - `buildSubmoduleTree({ rows, found, marks, closed })` in `src/frontend/submodules/submodule-tree.ts` gives the shown tree rows.
// - `SubmodulesGroup` takes `repository`, the worktree key that keeps the closed folders for the window session.
// tasks.md T147 (feature 004). Plan D20 "Group": above 200 shown rows, the group mounts only the rows in view. Plan D15 "Tree rows": the shrink order.

import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { act, useState, type ReactNode } from "react";
import { SUBMODULE_TREE_FOLDERS } from "../../src/contracts/limits";
import { SubmoduleBranch, SubmoduleHostLine, SubmodulePlanRow, SubmoduleRowResult } from "../../src/contracts/submodules";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { contractChecked, fixtureId } from "./bridge-contract";
import { answer, button, buttons, click, hoverTooltip, menuItem, press, settle, text, type Call } from "./sync-fake";

printOrigin("../../src/frontend/submodules/SubmodulesGroup.tsx", import.meta.dir);
printOrigin("../../src/frontend/status/OperationStatus.tsx", import.meta.dir);
printOrigin("../../src/frontend/submodules/submodule-tree.ts", import.meta.dir);
printOrigin("../../src/frontend/state/tracking.ts", import.meta.dir);
registerDom();
const { createRoot } = await import("react-dom/client");
const { SubmodulesGroup, useSubmoduleUpdate } = await import("../../src/frontend/submodules/SubmodulesGroup");
const { OperationStatus } = await import("../../src/frontend/status/OperationStatus");
const { buildSubmoduleTree } = await import("../../src/frontend/submodules/submodule-tree");
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
const review = (fields: Record<string, unknown> = {}) => ({ generation: 3, rows: [A, A1, B], branches: [], programs: [], refusals: [], hosts: [], submoduleReviewToken: TOKEN, ...fields });
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
let repositories = 0;
// `hints`: the harness gives the group a sidebar column with the "Keys in the tree" slot as its last block (plan D20 "Place").
async function mount(options: { runningReason?: string | null; blockedReason?: string | null; listed?: unknown | null; repository?: string; onOpen?: (path: string) => void; hints?: { min: number; open?: boolean } } = {}) {
  // The closed folders last for the window session per repository, so each mount gets its own key unless the case names one.
  const repository = options.repository ?? `repository-${repositories++}`;
  const double = createDouble();
  const operations: StatusOperation[] = [];
  const failures: string[] = [];
  let cancels = 0;
  let attentions = 0;
  let trusts = 0;
  let snapshot = SNAPSHOT;
  let setShown!: (id: string) => void;
  const handle: { update: ReturnType<typeof useSubmoduleUpdate> | null } = { update: null };
  const hintCalls: boolean[] = [];
  let setSlotShown!: (shown: boolean) => void;
  function Harness() {
    const [op, setOp] = useState<StatusOperation | null>(null);
    const [shown, set] = useState(SNAPSHOT);
    const [slot, setSlot] = useState<HTMLElement | null>(null);
    const [slotShown, showSlot] = useState(true);
    const [hintsOpen, setHintsOpen] = useState(options.hints?.open ?? true);
    setShown = set;
    setSlotShown = showSlot;
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
    const hints = options.hints;
    const node = (
      <SubmodulesGroup
        update={update}
        repository={repository}
        runningReason={options.runningReason ?? own}
        blockedReason={options.blockedReason ?? null}
        onCancel={() => void cancels++}
        onTrustReads={() => void trusts++}
        onOpen={options.onOpen}
        {...(hints === undefined
          ? {}
          : {
              hintsSlot: slotShown ? slot : null,
              hintsOpen,
              hintsMin: hints.min,
              onHintsOpen: (open: boolean) => {
                hintCalls.push(open);
                setHintsOpen(open);
              },
            })}
      />
    );
    if (hints === undefined) return node;
    return (
      <div data-slot="sidebar-column">
        <div>{node}</div>
        {slotShown ? <div ref={setSlot} data-slot="key-hints-slot" /> : null}
      </div>
    );
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
  const showSlot = (shown: boolean) => act(async () => setSlotShown(shown));
  return { double, operations, failures, cancels: () => cancels, attentions: () => attentions, trusts: () => trusts, read, handle, hintCalls, showSlot };
}

const group = () => document.querySelector<HTMLElement>('[data-slot="submodules-group"]')!;
// Submodule rows carry `data-path`. Folder rows do not.
const rows = () => [...group().querySelectorAll<HTMLElement>('[role="treeitem"][data-path]')];
const items = () => [...group().querySelectorAll<HTMLElement>('[role="treeitem"]')];
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
    // FR-107: libs > a > deps > c, and vendor > b.
    expect(rows().map((r) => [r.dataset.path, r.getAttribute("aria-level")])).toEqual([
      ["libs/a", "2"],
      ["libs/a/deps/c", "4"],
      ["vendor/b", "2"],
    ]);
    // One Tab stop: the first row of the tree, the folder "libs".
    expect(items().map((r) => r.getAttribute("tabindex"))).toEqual(["0", "-1", "-1", "-1", "-1", "-1"]);
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

  test("the header keeps one line: its status text shrinks first, ends with an ellipsis, and its tooltip gives the full text (T116, plan D15 Header)", async () => {
    const view = await started();
    await sendProgress(view.double, progress("fetch", "libs/a", 1, 62));
    const status = group().querySelector<HTMLElement>('[data-slot="header-status"]')!;
    expect(status.hasAttribute("title")).toBe(false);
    expect(await hoverTooltip(status)).toEqual(["Updating 1 of 3"]);
    expect(status.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-w-0", "truncate"]));
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

  test("the header totals keep one line, end with an ellipsis, and give the full text in the tooltip (T116, plan D15 Header)", async () => {
    await finished();
    const status = group().querySelector<HTMLElement>('[data-slot="header-status"]')!;
    expect(status.hasAttribute("title")).toBe(false);
    expect(await hoverTooltip(status)).toEqual(["2 updated, 1 failed"]);
    expect(status.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-w-0", "truncate"]));
  });

  test("in forced colors, a selected row shows its state text and its buttons in HighlightText on Highlight, and a disabled button in GrayText on Canvas (T116, T118, plan D16)", () => {
    const css = readFileSync(printOrigin("../../src/frontend/index.css", import.meta.dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
    const rules = [...forced.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.replace(/\s+/g, " ").trim(), body: m[2]!.replace(/\s+/g, " ").trim() }));
    const state = rules.find((r) => r.selector.startsWith('.list-row[aria-selected="true"] :is(') && r.selector.includes(".text-removed"));
    expect(state?.body).toBe("color: HighlightText;");
    const controls = rules.find((r) => r.selector === '.list-row[aria-selected="true"] button');
    expect(controls?.body).toBe("background: Highlight; color: HighlightText; border-color: HighlightText;");
    // T118: a disabled button in a selected row needs a later rule, because the selected-row rule outranks the GrayText rule.
    const disabled = rules.findIndex((r) => r.selector === '.list-row[aria-selected="true"] button:is(:disabled, [aria-disabled="true"], [data-disabled])');
    expect(rules[disabled]?.body).toBe("background: Canvas; color: GrayText; border-color: GrayText;");
    expect(disabled).toBeGreaterThan(rules.indexOf(controls!));
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

  // Plan D15 "Rows at rest": a failed list keeps the rows of the last list beside the failure line.
  test("a failed list after a run keeps the rows with the failure line, and the failed row keeps Retry and Show output", async () => {
    const view = await finished();
    await view.read(fixtureId(8));
    await answer(view.double.pending("reviewSubmodules"), { requestId: fixtureId(30), state: "failed", code: "DEADLINE" });
    expect(text(group().querySelector('[data-slot="list-failure"]')!)).toBe("Arbareto cannot read the submodules: DEADLINE.");
    expect(rows().map((r) => r.dataset.path)).toEqual(["libs/a", "libs/a/deps/c", "vendor/b"]);
    expect(rowState("vendor/b")).toBe("Failed");
    expect([buttons("Retry", row("vendor/b")).length, buttons("Show output", row("vendor/b")).length]).toEqual([1, 1]);
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

// tasks.md T142: the approved boards Main and BranchMarks (sample data). 10 rows, 2 of them nested under app-shared.
const BOARD_IDS = Object.fromEntries(
  ["http", "core", "ui", "fmt", "lint", "icons", "app", "zlib", "minizip", "docs"].map((name, i) => [name, fixtureId(0x100 + i)]),
) as Record<string, string>;
const ICONS = "vendor/icon-pack-sample-extended-glyph-set";
const BOARD = [
  planRow({ rowId: BOARD_IDS.http!, path: "libs/net/http" }),
  planRow({ rowId: BOARD_IDS.core!, path: "libs/core" }),
  planRow({ rowId: BOARD_IDS.ui!, path: "libs/ui" }),
  planRow({ rowId: BOARD_IDS.fmt!, path: "vendor/tools/fmt" }),
  planRow({ rowId: BOARD_IDS.lint!, path: "vendor/tools/lint" }),
  planRow({ rowId: BOARD_IDS.icons!, path: ICONS, head: null, action: "clone" }),
  planRow({ rowId: BOARD_IDS.app!, path: "app-shared" }),
  planRow({ rowId: BOARD_IDS.zlib!, path: "app-shared/third_party/zlib", depth: 1, parentRowId: BOARD_IDS.app! }),
  planRow({ rowId: BOARD_IDS.minizip!, path: "app-shared/third_party/contrib/minizip", depth: 1, parentRowId: BOARD_IDS.app! }),
  planRow({ rowId: BOARD_IDS.docs!, path: "docs-theme" }),
];
// [kind, label, level, count] in the shown order.
const BOARD_TREE = [
  ["folder", "libs", 1, 3],
  ["folder", "net", 2, 1],
  ["submodule", "http", 3, null],
  ["submodule", "core", 2, null],
  ["submodule", "ui", 2, null],
  ["folder", "vendor", 1, 3],
  ["folder", "tools", 2, 2],
  ["submodule", "fmt", 3, null],
  ["submodule", "lint", 3, null],
  ["submodule", "icon-pack-sample-extended-glyph-set", 2, null],
  ["submodule", "app-shared", 1, null],
  ["folder", "third_party", 2, 2],
  ["folder", "contrib", 3, 1],
  ["submodule", "minizip", 4, null],
  ["submodule", "zlib", 3, null],
  ["submodule", "docs-theme", 1, null],
];
type Tree = ReturnType<typeof buildSubmoduleTree>;
const shape = (tree: Tree) => {
  if (tree.state !== "tree") throw new Error(`tree state ${tree.state}`);
  return tree.rows.map((r) => [r.kind, r.label, r.level, r.kind === "folder" ? r.count : null]);
};
const build = (rows: readonly SubmodulePlanRow[], fields: Partial<Parameters<typeof buildSubmoduleTree>[0]> = {}) => buildSubmoduleTree({ rows, found: [], marks: new Map(), closed: new Set(), ...fields });
const UPSTREAM = "refs/remotes/origin/main";
const mark = (rowId: string, fields: Record<string, unknown>) => SubmoduleBranch.parse({ rowId, ...fields });
const BOARD_MARKS = [
  mark(BOARD_IDS.http!, { state: "branch", ref: "refs/heads/main", upstream: UPSTREAM, track: { state: "counts", ahead: 0, behind: 0 } }),
  mark(BOARD_IDS.core!, { state: "detached" }),
  mark(BOARD_IDS.ui!, { state: "branch", ref: "refs/heads/main", upstream: UPSTREAM, track: { state: "counts", ahead: 1, behind: 0 } }),
  mark(BOARD_IDS.fmt!, { state: "branch", ref: "refs/heads/release/2.x", upstream: "refs/remotes/origin/release/2.x", track: { state: "counts", ahead: 0, behind: 3 } }),
  mark(BOARD_IDS.lint!, { state: "branch", ref: "refs/heads/lint", upstream: "refs/remotes/origin/lint", track: { state: "gone" } }),
  mark(BOARD_IDS.app!, { state: "branch", ref: "refs/heads/main", upstream: UPSTREAM, track: { state: "counts", ahead: 2, behind: 1 } }),
  mark(BOARD_IDS.zlib!, { state: "unread", ref: "refs/heads/main", code: "GIT_FAILED" }),
  mark(BOARD_IDS.minizip!, { state: "branch", ref: "refs/tags/v1", upstream: null, track: { state: "none" } }),
  mark(BOARD_IDS.docs!, { state: "branch", ref: "refs/heads/draft", upstream: null, track: { state: "none" } }),
];
// Four folders of their own per row: `t<i>a/t<i>b/t<i>c/t<i>d/s`.
const folderRows = (count: number) => Array.from({ length: count }, (_, i) => planRow({ rowId: fixtureId(0x1000 + i), path: `t${i}a/t${i}b/t${i}c/t${i}d/s` }));

describe("tree builder (FR-107, FR-111, data-model §12)", () => {
  test("the board set gives the board tree in any input order: folders first, the 005 tree order, and counts of all rows below", () => {
    const orders = [BOARD, [...BOARD].reverse(), [5, 8, 0, 9, 3, 7, 1, 6, 4, 2].map((i) => BOARD[i]!)];
    for (const order of orders) expect(shape(build(order))).toEqual(BOARD_TREE);
  });

  test("a nested row shows in the folders of its path below the parent, directly below the parent row", () => {
    const tree = build(BOARD);
    if (tree.state !== "tree") throw new Error("malformed");
    const at = tree.rows.findIndex((r) => r.label === "zlib");
    expect(tree.rows[tree.rows[at]!.parent]!.label).toBe("third_party");
    expect(tree.rows[tree.rows[tree.rows[at]!.parent]!.parent]!.label).toBe("app-shared");
    expect(tree.rows.filter((r) => r.kind === "folder").map((r) => [r.key, r.path])).toEqual([
      ["f:libs", "libs"],
      ["f:libs/net", "libs/net"],
      ["f:vendor", "vendor"],
      ["f:vendor/tools", "vendor/tools"],
      ["f:app-shared/third_party", "app-shared/third_party"],
      ["f:app-shared/third_party/contrib", "app-shared/third_party/contrib"],
    ]);
    const zlib = tree.rows[at]!;
    expect([zlib.key, zlib.path]).toEqual([`s:${btoa("app-shared/third_party/zlib")}`, "app-shared/third_party/zlib"]);
  });

  test("a folder counts the nested rows of its submodules too", () => {
    const parent = planRow({ rowId: fixtureId(0x200), path: "ext/app" });
    const child = planRow({ rowId: fixtureId(0x201), path: "ext/app/deps/z", depth: 1, parentRowId: parent.rowId });
    expect(shape(build([parent, child]))).toEqual([
      ["folder", "ext", 1, 2],
      ["submodule", "app", 2, null],
      ["folder", "deps", 3, 1],
      ["submodule", "z", 4, null],
    ]);
  });

  test("closed keys hide the rows below, and the WAI-ARIA positions count the shown siblings", () => {
    const tree = build(BOARD, { closed: new Set(["f:libs", `s:${btoa("app-shared")}`]) });
    expect(shape(tree)).toEqual([
      ["folder", "libs", 1, 3],
      ["folder", "vendor", 1, 3],
      ["folder", "tools", 2, 2],
      ["submodule", "fmt", 3, null],
      ["submodule", "lint", 3, null],
      ["submodule", "icon-pack-sample-extended-glyph-set", 2, null],
      ["submodule", "app-shared", 1, null],
      ["submodule", "docs-theme", 1, null],
    ]);
    if (tree.state !== "tree") throw new Error("malformed");
    expect(tree.rows.map((r) => [r.pos, r.size, r.open])).toEqual([
      [1, 4, false],
      [2, 4, true],
      [1, 2, true],
      [1, 2, null],
      [2, 2, null],
      [2, 2, null],
      [3, 4, false],
      [4, 4, null],
    ]);
  });

  test("found rows show their full path at the end of the root level", () => {
    const tree = build([BOARD[1]!], { found: [{ rowId: fixtureId(0x300), path: "x/found" }] });
    expect(shape(tree)).toEqual([
      ["folder", "libs", 1, 1],
      ["submodule", "core", 2, null],
      ["submodule", "x/found", 1, null],
    ]);
  });

  test("the marks join the rows by rowId", () => {
    const tree = build(BOARD, { marks: new Map(BOARD_MARKS.map((m) => [m.rowId, m])) });
    if (tree.state !== "tree") throw new Error("malformed");
    const ui = tree.rows.find((r) => r.label === "ui")!;
    expect(ui.kind === "submodule" && ui.mark).toEqual(BOARD_MARKS[2]!);
    const icons = tree.rows.find((r) => r.label === "icon-pack-sample-extended-glyph-set")!;
    expect(icons.kind === "submodule" && icons.mark).toBeNull();
  });

  const parent = planRow({ rowId: fixtureId(0x400), path: "a" });
  for (const [name, child] of [
    ["a depth that is not the parent depth + 1", planRow({ rowId: fixtureId(0x401), path: "a/b", depth: 2, parentRowId: parent.rowId })],
    ["path bytes that do not start with the parent bytes and 0x2F", planRow({ rowId: fixtureId(0x401), path: "a/b", pathBytes: btoa("ab/b"), depth: 1, parentRowId: parent.rowId })],
    ["a display path with another count of /", planRow({ rowId: fixtureId(0x401), path: "a/b/c", pathBytes: btoa("a/b"), depth: 1, parentRowId: parent.rowId })],
    ["a parent that is not in the list", planRow({ rowId: fixtureId(0x401), path: "a/b", depth: 1, parentRowId: fixtureId(0x499) })],
  ] as const)
    test(`${name} gives the malformed state`, () => expect(build([parent, child]).state).toBe("malformed"));

  test("1,024 folders show; one more gives no folder rows, and each nested row stays below its parent with its path below the parent", () => {
    expect(SUBMODULE_TREE_FOLDERS).toBe(1_024);
    const at = build(folderRows(256));
    if (at.state !== "tree") throw new Error("malformed");
    expect(at.bounded).toBe(false);
    expect(at.rows.filter((r) => r.kind === "folder")).toHaveLength(1_024);
    const rows = folderRows(256);
    const nested = planRow({ rowId: fixtureId(0x2000), path: `${rows[0]!.path}/n/x`, depth: 1, parentRowId: rows[0]!.rowId });
    const over = build([...rows, nested]);
    if (over.state !== "tree") throw new Error("malformed");
    expect(over.bounded).toBe(true);
    expect(over.rows.filter((r) => r.kind === "folder")).toHaveLength(0);
    expect(over.rows.slice(0, 3).map((r) => [r.label, r.level])).toEqual([
      ["t0a/t0b/t0c/t0d/s", 1],
      ["n/x", 2],
      ["t100a/t100b/t100c/t100d/s", 1],
    ]);
  });
});

describe("Submodules group tree (FR-107 to FR-111)", () => {
  const boardReview = (fields: Record<string, unknown> = {}) => reviewed({ rows: BOARD, branches: BOARD_MARKS, ...fields });
  const item = (label: string) => items().find((r) => r.querySelector('[data-slot="row-label"]')?.textContent === label)!;
  const focused = () => document.activeElement as HTMLElement;
  const focusedLabel = () => focused().querySelector('[data-slot="row-label"]')?.textContent;

  test("role tree with levels, positions, all folders and parent rows open at first, and one Tab stop", async () => {
    await mount({ listed: boardReview() });
    expect(group().querySelector('[role="tree"]')).not.toBeNull();
    expect(items().map((r) => [r.querySelector('[data-slot="row-label"]')?.textContent ?? null, Number(r.getAttribute("aria-level"))])).toEqual(BOARD_TREE.map(([, label, level]) => [label, level]));
    expect(items().filter((r) => r.hasAttribute("aria-expanded")).map((r) => [r.querySelector('[data-slot="row-label"]')?.textContent, r.getAttribute("aria-expanded")])).toEqual([
      ["libs", "true"],
      ["net", "true"],
      ["vendor", "true"],
      ["tools", "true"],
      ["app-shared", "true"],
      ["third_party", "true"],
      ["contrib", "true"],
    ]);
    expect(["aria-posinset", "aria-setsize"].map((a) => item("vendor").getAttribute(a))).toEqual(["2", "4"]);
    expect(items().filter((r) => r.getAttribute("tabindex") === "0")).toEqual([item("libs")]);
    expect(item("libs").style.paddingLeft).toBe("8px");
    expect(item("minizip").style.paddingLeft).toBe("44px");
    // FR-107: the header count stays the count of all submodule rows.
    expect(text(group().querySelector('[data-slot="group-header"]')!)).toContain("10");
  });

  test("folder rows: the folder icon, the name, the count, and the name '<folder>, folder, <n>'", async () => {
    await mount({ listed: boardReview() });
    expect(item("vendor").getAttribute("aria-label")).toBe("vendor, folder, 3");
    expect(text(item("vendor").querySelector('[data-slot="folder-count"]')!)).toBe("3");
    expect(item("vendor").querySelector('[data-slot="folder-icon"]')).not.toBeNull();
    expect(item("vendor").hasAttribute("data-path")).toBe(false);
  });

  test("the marks of plan D15 'Tree rows': branch, no branch, counts, =, gone mark, no count, and the accessible names", async () => {
    await mount({ listed: boardReview() });
    const markText = (path: string) => row(path).querySelector('[data-slot="branch-mark"]')?.textContent ?? null;
    const countText = (path: string) => row(path).querySelector('[data-slot="track-count"]')?.textContent ?? null;
    expect(BOARD.map((r) => [r.path, markText(r.path), countText(r.path), row(r.path).querySelector('[data-slot="gone-mark"]') !== null])).toEqual([
      ["libs/net/http", "main", "=", false],
      ["libs/core", "no branch", null, false],
      ["libs/ui", "main", "↑1 ↓0", false],
      ["vendor/tools/fmt", "release/2.x", "↑0 ↓3", false],
      ["vendor/tools/lint", "lint", null, true],
      [ICONS, null, null, false],
      ["app-shared", "main", "↑2 ↓1", false],
      ["app-shared/third_party/zlib", "main", null, false],
      ["app-shared/third_party/contrib/minizip", "refs/tags/v1", null, false],
      ["docs-theme", "draft", null, false],
    ]);
    const head = short(OLD);
    expect(BOARD.map((r) => row(r.path).getAttribute("aria-label"))).toEqual([
      `libs/net/http, main, 0 ahead, 0 behind, ${head}`,
      `libs/core, no branch, ${head}`,
      `libs/ui, main, 1 ahead, 0 behind, ${head}`,
      `vendor/tools/fmt, release/2.x, 0 ahead, 3 behind, ${head}`,
      `vendor/tools/lint, lint, upstream gone, ${head}`,
      ICONS,
      `app-shared, main, 2 ahead, 1 behind, ${head}`,
      `app-shared/third_party/zlib, main, counts are unavailable: GIT_FAILED, ${head}`,
      `app-shared/third_party/contrib/minizip, refs/tags/v1, No upstream, ${head}`,
      `docs-theme, draft, No upstream, ${head}`,
    ]);
  });

  test("the tooltips give the full path, the branch and upstream, the 003 count text, and the gone text", async () => {
    await mount({ listed: boardReview() });
    expect(await hoverTooltip(row("libs/ui").querySelector('[data-slot="row-label"]')!)).toEqual(["libs/ui"]);
    expect(await hoverTooltip(item("tools").querySelector('[data-slot="row-label"]')!)).toEqual(["vendor/tools"]);
    expect(await hoverTooltip(row("libs/ui").querySelector('[data-slot="branch-mark"]')!)).toEqual(["main → origin/main"]);
    expect(await hoverTooltip(row("docs-theme").querySelector('[data-slot="branch-mark"]')!)).toEqual(["draft"]);
    expect(await hoverTooltip(row("libs/ui").querySelector('[data-slot="track-count"]')!)).toEqual([
      "1 ahead, 0 behind. Counts compare with the remote-tracking branch from the last fetch, not with the remote itself.",
    ]);
    expect(await hoverTooltip(row("vendor/tools/lint").querySelector('[data-slot="gone-mark"]')!)).toEqual(["The upstream origin/lint no longer exists."]);
    // The mark and the label shrink and end with an ellipsis.
    for (const slot of ["row-label", "branch-mark"]) expect(row("libs/ui").querySelector(`[data-slot="${slot}"]`)!.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-w-0", "truncate"]));
  });

  // 001 plan.md "Icons": the row keeps the tooltip text that its accessible name leaves out in its description.
  test("the accessible description gives the full folder path, the upstream, and the 003 count note", async () => {
    await mount({ listed: boardReview() });
    const counts = "Counts compare with the remote-tracking branch from the last fetch, not with the remote itself.";
    expect([item("tools"), item("libs")].map((r) => r.getAttribute("aria-description"))).toEqual(["vendor/tools", "libs"]);
    expect(BOARD.map((r) => [r.path, row(r.path).getAttribute("aria-description")])).toEqual([
      ["libs/net/http", `main → origin/main. ${counts}`],
      ["libs/core", null],
      ["libs/ui", `main → origin/main. ${counts}`],
      ["vendor/tools/fmt", `release/2.x → origin/release/2.x. ${counts}`],
      ["vendor/tools/lint", "lint → origin/lint"],
      [ICONS, null],
      ["app-shared", `main → origin/main. ${counts}`],
      ["app-shared/third_party/zlib", null],
      ["app-shared/third_party/contrib/minizip", null],
      ["docs-theme", null],
    ]);
  });

  test("Up, Down, Home, and End move the focus; Right opens a closed row, then goes to the first child; Left closes an open row, else goes to the parent", async () => {
    await mount({ listed: boardReview() });
    await act(async () => item("libs").focus());
    await press(focused(), "ArrowDown");
    expect(focusedLabel()).toBe("net");
    await press(focused(), "ArrowUp");
    expect(focusedLabel()).toBe("libs");
    await press(focused(), "End");
    expect(focusedLabel()).toBe("docs-theme");
    await press(focused(), "Home");
    expect(focusedLabel()).toBe("libs");
    await press(focused(), "ArrowLeft");
    expect(item("libs").getAttribute("aria-expanded")).toBe("false");
    expect(item("net")).toBeUndefined();
    expect(focusedLabel()).toBe("libs");
    await press(focused(), "ArrowRight");
    expect(item("libs").getAttribute("aria-expanded")).toBe("true");
    expect(focusedLabel()).toBe("libs");
    await press(focused(), "ArrowRight");
    expect(focusedLabel()).toBe("net");
    await press(focused(), "ArrowRight");
    expect(focusedLabel()).toBe("http");
    // A leaf: Right does nothing, and Left goes to the parent.
    await press(focused(), "ArrowRight");
    expect(focusedLabel()).toBe("http");
    await press(focused(), "ArrowLeft");
    expect(focusedLabel()).toBe("net");
    expect(item("net").getAttribute("aria-expanded")).toBe("true");
    expect(items().filter((r) => r.getAttribute("tabindex") === "0")).toEqual([item("net")]);
    // A parent submodule row closes and opens as a folder does.
    await act(async () => item("zlib").focus());
    await press(focused(), "ArrowLeft");
    expect(focusedLabel()).toBe("third_party");
    await press(focused(), "ArrowLeft");
    await press(focused(), "ArrowLeft");
    expect(focusedLabel()).toBe("app-shared");
    await press(focused(), "ArrowLeft");
    expect(item("app-shared").getAttribute("aria-expanded")).toBe("false");
    expect(item("zlib")).toBeUndefined();
  });

  test("Enter opens or closes a folder row, and opens the submodule of a submodule row", async () => {
    const opened: string[] = [];
    await mount({ listed: boardReview(), onOpen: (path) => void opened.push(path) });
    await act(async () => item("vendor").focus());
    await press(focused(), "Enter");
    expect(item("vendor").getAttribute("aria-expanded")).toBe("false");
    await press(focused(), "Enter");
    expect(item("vendor").getAttribute("aria-expanded")).toBe("true");
    expect(opened).toEqual([]);
    await act(async () => item("core").focus());
    await press(focused(), "Enter");
    expect(opened).toEqual(["libs/core"]);
  });

  test("a folder row has no menu: no Shift+F10, no Menu key, no right-click; a submodule row has its menu", async () => {
    await mount({ listed: boardReview() });
    await act(async () => item("libs").focus());
    await press(focused(), "F10", { shiftKey: true });
    await press(focused(), "ContextMenu");
    await act(async () => void item("libs").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await settle();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await act(async () => item("core").focus());
    await press(focused(), "ContextMenu");
    expect(document.querySelector('[role="menu"]')!.getAttribute("aria-label")).toBe("Actions for libs/core");
  });

  test("a click on a folder row opens or closes it", async () => {
    await mount({ listed: boardReview() });
    await click(item("tools"));
    expect(item("tools").getAttribute("aria-expanded")).toBe("false");
    expect(item("fmt")).toBeUndefined();
  });

  test("the closed rows last for the window session per repository: a remount with the same repository keeps them, another repository opens all", async () => {
    await mount({ listed: boardReview(), repository: "kept-repository" });
    await act(async () => item("libs").focus());
    await press(focused(), "ArrowLeft");
    for (const unmount of roots.splice(0)) await unmount();
    await mount({ listed: boardReview(), repository: "kept-repository" });
    expect(item("libs").getAttribute("aria-expanded")).toBe("false");
    for (const unmount of roots.splice(0)) await unmount();
    await mount({ listed: boardReview(), repository: "other-repository" });
    expect(item("libs").getAttribute("aria-expanded")).toBe("true");
  });

  test("the marks change with the rows: in the list review after a Refresh, and in the unscoped Update review", async () => {
    const view = await mount({ listed: boardReview({ branches: [] }) });
    expect(row("libs/ui").querySelector('[data-slot="branch-mark"]')).toBeNull();
    await act(async () => view.handle.update!.refreshed());
    await view.read(fixtureId(7));
    await answer(view.double.pending("reviewSubmodules"), boardReview());
    expect(text(row("libs/ui").querySelector('[data-slot="track-count"]')!)).toBe("↑1 ↓0");
    await click(button("Update submodules", group()));
    const moved = mark(BOARD_IDS.ui!, { state: "branch", ref: "refs/heads/main", upstream: UPSTREAM, track: { state: "counts", ahead: 0, behind: 0 } });
    await answer(view.double.pending("reviewSubmodules"), boardReview({ branches: [moved] }));
    expect(text(row("libs/ui").querySelector('[data-slot="track-count"]')!)).toBe("=");
    expect(row("libs/core").querySelector('[data-slot="branch-mark"]')).toBeNull();
  });

  test("a scoped review keeps the marks of the list", async () => {
    const view = await mount({ listed: boardReview() });
    await act(async () => void row("libs/ui").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await settle();
    await click(menuItem("Update"));
    await answer(view.double.pending("reviewSubmodules"), reviewed({ rows: [BOARD[2]!], branches: [] }));
    expect(text(row("libs/ui").querySelector('[data-slot="track-count"]')!)).toBe("↑1 ↓0");
  });

  test("a review without an array `branches` has an unknown form", async () => {
    const { branches: _, ...value } = review();
    await mount({ listed: { requestId: fixtureId(31), state: "succeeded", result: value } });
    expect(text(group().querySelector('[data-slot="list-failure"]')!)).toBe("The submodules did not load: the result has an unknown form.");
  });

  test("a malformed parent chain gives the Malformed result state and no tree", async () => {
    const bad = planRow({ rowId: fixtureId(0x401), path: "a/b", depth: 1, parentRowId: fixtureId(0x499) });
    await mount({ listed: reviewed({ rows: [planRow({ rowId: fixtureId(0x400), path: "a" }), bad] }) });
    expect(text(group().querySelector('[data-slot="list-failure"]')!)).toBe("The submodules did not load: the result has an unknown form.");
    expect(group().querySelector('[role="tree"]')).toBeNull();
  });

  test("above 1,024 folders the bound line shows, and no folder row", async () => {
    const rows = folderRows(256);
    const nested = planRow({ rowId: fixtureId(0x2000), path: `${rows[0]!.path}/n/x`, depth: 1, parentRowId: rows[0]!.rowId });
    await mount({ listed: reviewed({ rows: [...rows, nested] }) });
    expect(text(group().querySelector('[data-slot="tree-bound"]')!)).toBe("The submodule paths have more than 1,024 folders, so the group shows no folder rows.");
    expect(items().every((r) => r.hasAttribute("data-path"))).toBe(true);
  });

  test("at 1,024 folders no bound line shows", async () => {
    await mount({ listed: reviewed({ rows: folderRows(256) }) });
    expect(group().querySelector('[data-slot="tree-bound"]')).toBeNull();
  });
});

// tasks.md T147, plan D20 "Group": above 200 shown rows, the group mounts only the rows in view, as the References tree does (feature 002 T062).
describe("virtual tree", () => {
  // happy-dom has no layout. The stub gives the group scroll region a height of 400 px and each virtual row the compact row height.
  let restore: () => void = () => {};
  beforeAll(() => {
    const proto = HTMLElement.prototype;
    const keys = ["clientHeight", "offsetHeight", "scrollHeight", "scrollTop", "scrollTo", "getBoundingClientRect"] as const;
    const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const);
    const tops = new WeakMap<Element, number>();
    const region = (e: Element) => e.getAttribute("data-slot") === "submodules-scroll";
    const content = (e: Element) => parseFloat(e.querySelector<HTMLElement>('[role="presentation"]')?.style.height ?? "") || 0;
    Object.defineProperty(proto, "clientHeight", { configurable: true, get: function (this: Element) { return region(this) ? 400 : 0; } });
    Object.defineProperty(proto, "scrollHeight", { configurable: true, get: function (this: Element) { return region(this) ? content(this) : 0; } });
    // The tree sits at the region top and moves up as the region scrolls, as in Chromium.
    const rect = Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect")!.value as (this: Element) => DOMRect;
    Object.defineProperty(proto, "getBoundingClientRect", {
      configurable: true,
      writable: true,
      value: function (this: HTMLElement) {
        const scroller = this.getAttribute("role") === "tree" ? this.closest<HTMLElement>('[data-slot="submodules-scroll"]') : null;
        return scroller === null ? rect.call(this) : ({ x: 0, y: -scroller.scrollTop, top: -scroller.scrollTop, bottom: -scroller.scrollTop, left: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect);
      },
    });
    Object.defineProperty(proto, "offsetHeight", { configurable: true, get: function (this: Element) { return region(this) ? 400 : this.hasAttribute("data-index") ? 26 : 0; } });
    Object.defineProperty(proto, "scrollTop", { configurable: true, get: function (this: Element) { return tops.get(this) ?? 0; }, set: function (this: Element, v: number) { tops.set(this, Math.max(0, v)); } });
    Object.defineProperty(proto, "scrollTo", {
      configurable: true,
      writable: true,
      value: function (this: HTMLElement, options: ScrollToOptions | number, y?: number) {
        this.scrollTop = typeof options === "object" ? (options.top ?? this.scrollTop) : (y ?? 0);
        this.dispatchEvent(new Event("scroll"));
      },
    });
    restore = () => {
      for (const [key, descriptor] of saved) {
        if (descriptor === undefined) delete (proto as unknown as Record<string, unknown>)[key];
        else Object.defineProperty(proto, key, descriptor);
      }
    };
  });
  afterAll(() => restore());
  const wait = () =>
    act(async () => {
      for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const focused = () => document.activeElement as HTMLElement;
  const at = (e: Element) => [e.getAttribute("role"), e.getAttribute("aria-level"), e.getAttribute("aria-posinset"), e.getAttribute("aria-setsize")];
  const expected = (r: { level: number; pos: number; size: number }) => ["treeitem", String(r.level), String(r.pos), String(r.size)];
  const shownRows = (rows: readonly SubmodulePlanRow[]) => {
    const tree = build(rows);
    if (tree.state !== "tree") throw new Error("malformed");
    return tree.rows;
  };

  for (const n of [64, 256]) {
    test(`with ${n} submodules in ${n * 5} rows, fewer than 80 rows are mounted, also after Left and Right on a folder`, async () => {
      const rows = folderRows(n);
      expect(shownRows(rows)).toHaveLength(n * 5);
      await mount({ listed: reviewed({ rows }) });
      await wait();
      const mounted = () => items().length;
      console.log(`MOUNTED T147: ${n * 5} rows, ${mounted()} mounted`);
      expect(mounted()).toBeLessThan(80);
      expect(mounted()).toBeGreaterThan(0);
      const folder = items()[0]!;
      expect(folder.getAttribute("aria-expanded")).toBe("true");
      await act(async () => folder.focus());
      await press(focused(), "ArrowLeft");
      await wait();
      expect(items()[0]!.getAttribute("aria-expanded")).toBe("false");
      expect(mounted()).toBeLessThan(80);
      await press(focused(), "ArrowRight");
      await wait();
      expect(items()[0]!.getAttribute("aria-expanded")).toBe("true");
      expect(focused()).toBe(items()[0]!);
      expect(mounted()).toBeLessThan(80);
    });
  }

  test("End, Home, and Left to a parent focus a mounted row with the right level and position", async () => {
    const rows = folderRows(256);
    const shown = shownRows(rows);
    await mount({ listed: reviewed({ rows }) });
    await wait();
    await act(async () => items()[0]!.focus());
    await press(focused(), "End");
    await wait();
    const last = shown.at(-1)!;
    expect(focused().isConnected).toBe(true);
    expect([focused().dataset.path, ...at(focused())]).toEqual([last.path, ...expected(last)]);
    await press(focused(), "ArrowLeft");
    await wait();
    const parent = shown[last.parent]!;
    expect([focused().getAttribute("aria-description"), ...at(focused())]).toEqual([parent.path, ...expected(parent)]);
    await press(focused(), "Home");
    await wait();
    expect([focused().getAttribute("aria-description"), ...at(focused())]).toEqual([shown[0]!.path, ...expected(shown[0]!)]);
    expect(items().filter((r) => r.getAttribute("tabindex") === "0")).toEqual([focused()]);
  });

  test("Left on the last of 300 rows in one folder focuses the folder row, which was not mounted", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => planRow({ rowId: fixtureId(0x3000 + i), path: `big/s${String(i).padStart(3, "0")}` }));
    await mount({ listed: reviewed({ rows }) });
    await wait();
    await act(async () => items()[0]!.focus());
    await press(focused(), "End");
    await wait();
    expect([focused().dataset.path, ...at(focused())]).toEqual(["big/s299", "treeitem", "2", "300", "300"]);
    expect(items().some((r) => r.getAttribute("aria-description") === "big")).toBe(false);
    await press(focused(), "ArrowLeft");
    await wait();
    expect([focused().getAttribute("aria-description"), ...at(focused())]).toEqual(["big", "treeitem", "1", "1", "1"]);
  });

  test("above 1,024 folders, the first mounted row is the first path among 256 root rows; at 1,024 folders, it is the folder of the first path", async () => {
    const rows = folderRows(256);
    const nested = planRow({ rowId: fixtureId(0x2000), path: `${rows[0]!.path}/n/x`, depth: 1, parentRowId: rows[0]!.rowId });
    await mount({ listed: reviewed({ rows: [...rows, nested] }) });
    await wait();
    expect(items().length).toBeLessThan(80);
    expect([items()[0]!.dataset.path, ...at(items()[0]!)]).toEqual([rows[0]!.path, "treeitem", "1", "1", "256"]);
    for (const unmount of roots.splice(0)) await unmount();
    await mount({ listed: reviewed({ rows }) });
    await wait();
    expect([items()[0]!.hasAttribute("data-path"), items()[0]!.getAttribute("aria-description"), ...at(items()[0]!)]).toEqual([false, "t0a", "treeitem", "1", "1", "256"]);
  });

  test("a tree of 80 rows mounts all 80 rows", async () => {
    await mount({ listed: reviewed({ rows: folderRows(16) }) });
    await wait();
    expect(items()).toHaveLength(80);
    expect(group().querySelector("[data-index]")).toBeNull();
  });
});

// tasks.md T147, plan D15 "Tree rows": the at-rest short ID shrinks first, then the branch mark, then the name. Each keeps its first character and "…".
// happy-dom has no layout: `scrollWidth` and `clientWidth` are 0. This test checks the DOM structure that gives the order in Chromium.
describe("row shrink order", () => {
  const classes = (e: Element | null | undefined) => (e?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  // A part that shrinks: one grid cell with the cut text and a hidden copy of "<first character>…" that sets the minimum width.
  const expectPart = (shown: Element, floor: string) => {
    const cell = shown.parentElement!;
    expect(classes(cell)).toEqual(expect.arrayContaining(["grid", "grid-cols-[minmax(auto,max-content)]"]));
    expect(classes(cell)).not.toContain("min-w-0");
    expect(classes(shown)).toEqual(expect.arrayContaining(["col-start-1", "row-start-1", "min-w-0", "truncate"]));
    const copy = cell.querySelector('[data-slot="shrink-floor"]')!;
    expect([text(copy), copy.getAttribute("aria-hidden")]).toEqual([floor, "true"]);
    expect(classes(copy)).toEqual(expect.arrayContaining(["invisible", "col-start-1", "row-start-1", "whitespace-nowrap"]));
    return cell;
  };

  test("in a 240 px tree, the ID part takes the free width first, the mark part next, and the name last; no part uses a flex weight", async () => {
    await mount({ listed: reviewed({ rows: BOARD, branches: BOARD_MARKS }) });
    group().style.width = "240px";
    const ui = row("libs/ui");
    const label = ui.querySelector('[data-slot="row-label"]')!;
    expect(classes(label)).toEqual(expect.arrayContaining(["min-w-0", "truncate"]));
    // The tail starts at width 0 and grows into the free width. Its minimum is its content minimum, so the name shrinks only after the tail parts reach their floors.
    const tail = label.nextElementSibling;
    expect(tail?.getAttribute("data-slot")).toBe("row-tail");
    expect(classes(tail)).toEqual(expect.arrayContaining(["flex", "flex-1"]));
    expect(classes(tail)).not.toContain("min-w-0");
    const [marks, id] = [...(tail?.children ?? [])];
    // The ID cell also starts at width 0, so it gives way before the mark group, which keeps its content width.
    expect(classes(id)).toEqual(expect.arrayContaining(["flex-1", "justify-end"]));
    expect(expectPart(ui.querySelector('[data-slot="row-state"]')!, `${OLD[0]}…`)).toBe(id as HTMLElement);
    expect(classes(marks)).not.toContain("flex-1");
    expect(classes(marks)).not.toContain("min-w-0");
    expect(expectPart(ui.querySelector('[data-slot="branch-mark"]')!, "m…").parentElement).toBe(marks as HTMLElement);
    expect(text(ui.querySelector('[data-slot="branch-mark"]')!)).toBe("main");
    expect(text(ui.querySelector('[data-slot="row-state"]')!)).toBe(short(OLD));
    // "no branch" keeps "n…". A row without a mark has no mark part.
    expectPart(row("libs/core").querySelector('[data-slot="branch-mark"]')!, "n…");
    expect(row(ICONS).querySelector('[data-slot="branch-mark"]')).toBeNull();
    const weights = [...group().querySelectorAll('[role="treeitem"] *')].flatMap(classes).filter((c) => c.startsWith("shrink-["));
    expect(weights).toEqual([]);
  });
});

// tasks.md T163, plan D20 "Keys in the tree", spec FR-116 and US12 scenario 8. The expected texts are the D20 table in table order.
describe("keys in the tree", () => {
  const TEXTS = [
    "Keys in the tree",
    "Up, Down",
    "Go to the previous or the next row.",
    "Right",
    "Open a closed row. On an open row, go to the first child.",
    "Left",
    "Close an open row. On another row, go to the parent.",
    "Home, End",
    "Go to the first or the last row.",
    "Enter",
    "Open the submodule. On a folder row, open or close the folder.",
    "Shift+F10, Menu key",
    "Open the row menu: Open submodule, Update, Copy path. A failed row adds Retry, and Show output when it has output. Folder rows have no menu.",
  ];
  const NO_ROOM = "Make the sidebar wider or the window taller to show the keys.";
  // D20 "Desk heights" at 1280×800 and 100% text, 240 DIPs: H, P_open, and the button height (P_closed − 21).
  const COMPACT = [728, 441, 24] as const;
  const COMFORTABLE = [720, 623, 28] as const;
  const MIN = { compact: 58, comfortable: 70 };

  // One fake observer list. The test feeds each observed element its border-box height (plan D20 "No toggle").
  type Observed = { callback: ResizeObserverCallback; targets: Set<Element> };
  const observers = new Set<Observed>();
  class FakeResizeObserver {
    readonly observed: Observed;
    constructor(callback: ResizeObserverCallback) {
      this.observed = { callback, targets: new Set() };
      observers.add(this.observed);
    }
    observe(target: Element) {
      this.observed.targets.add(target);
    }
    unobserve(target: Element) {
      this.observed.targets.delete(target);
    }
    disconnect() {
      observers.delete(this.observed);
    }
  }
  let savedObserver: unknown;
  beforeAll(() => {
    savedObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = FakeResizeObserver as never;
  });
  afterAll(() => void (globalThis.ResizeObserver = savedObserver as never));

  const column = () => document.querySelector<HTMLElement>('[data-slot="sidebar-column"]')!;
  const slot = () => document.querySelector<HTMLElement>('[data-slot="key-hints-slot"]')!;
  const outer = () => document.querySelector<HTMLElement>('[data-slot="key-hints"]');
  const content = () => document.querySelector<HTMLElement>('[data-slot="key-hints-content"]')!;
  const hintsButton = () => button("Keys in the tree");
  const keyList = () => document.getElementById(hintsButton().getAttribute("aria-controls") ?? "")!;
  const tree = () => group().querySelector<HTMLElement>('[role="tree"]')!;
  const tabStopRow = () => tree().querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')!;
  async function feed(sidebar: number, open: number, buttonHeight: number) {
    const size = (target: Element) => {
      if (target === column()) return sidebar;
      if (target === content()) return open;
      if (target === hintsButton()) return buttonHeight;
      throw new Error(`unexpected observed element ${target.tagName}`);
    };
    await act(async () => {
      for (const o of [...observers]) o.callback([...o.targets].map((target) => ({ target, borderBoxSize: [{ blockSize: size(target), inlineSize: 240 }] })) as never, o as never);
    });
  }
  async function shown(open = true) {
    const view = await mount({ hints: { min: MIN.compact, open } });
    await feed(...COMPACT);
    return view;
  }
  const shapeOf = (icon: typeof ArrowDown01Icon) => icon.map(([, attributes]) => String((attributes as { d?: string }).d));
  const chevron = () => [...hintsButton().querySelectorAll("svg")].map((svg) => [...svg.children].map((c) => c.getAttribute("d") ?? ""));
  const describedTexts = () => describedText(tree());

  test("(1) the open form renders in the slot and shows the 13 D20 texts in table order; each key name is its own kbd", async () => {
    await shown();
    expect(hintsButton().getAttribute("aria-expanded")).toBe("true");
    const items = [...keyList().children];
    expect(items.map((e) => e.tagName)).toEqual(Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? "DT" : "DD")));
    expect([text(hintsButton()), ...items.map((e) => text(e))]).toEqual(TEXTS);
    const kbds = [...content().querySelectorAll("kbd")];
    expect(kbds.map((k) => text(k))).toEqual(["Up", "Down", "Right", "Left", "Home", "End", "Enter", "Shift+F10", "Menu key"]);
    // The ", " between two key names is a plain text node.
    const parts = (dt: Element) => [...dt.childNodes].map((n) => (n.nodeType === 3 ? n.textContent : (n as Element).tagName));
    const expected = (keys: string) => keys.split(", ").flatMap((_, i) => (i === 0 ? ["KBD"] : [", ", "KBD"]));
    expect([...keyList().querySelectorAll("dt")].map(parts)).toEqual(TEXTS.filter((_, i) => i % 2 === 1).map(expected));
  });

  test("(2) the panel exists only while the tree exists", async () => {
    const none = async (listed: unknown) => {
      await mount({ hints: { min: MIN.compact }, listed });
      expect(outer()).toBeNull();
      for (const unmount of roots.splice(0)) await unmount();
    };
    await none(null);
    await none({ requestId: fixtureId(30), state: "failed", code: "DEADLINE" });
    await none({ requestId: fixtureId(30), state: "failed", code: "TRUST_REQUIRED" });
    await none(reviewed({ rows: [planRow({ rowId: fixtureId(0x400), path: "a" }), planRow({ rowId: fixtureId(0x401), path: "a/b", depth: 1, parentRowId: fixtureId(0x499) })] }));
    await none(reviewed({ rows: [] }));
    // A closed group.
    await mount({ hints: { min: MIN.compact } });
    expect(outer()).not.toBeNull();
    await click(group().querySelector<HTMLButtonElement>("h3 button")!);
    expect(outer()).toBeNull();
    for (const unmount of roots.splice(0)) await unmount();

    const present = () => {
      expect(tree()).not.toBeNull();
      expect(outer() !== null && slot().contains(outer())).toBe(true);
    };
    // A failed later list keeps the rows.
    const later = await mount({ hints: { min: MIN.compact } });
    await act(async () => later.handle.update!.refreshed());
    await later.read(fixtureId(5));
    await answer(later.double.pending("reviewSubmodules"), { requestId: fixtureId(30), state: "failed", code: "DEADLINE" });
    expect(group().querySelector('[data-slot="list-failure"]')).not.toBeNull();
    present();
    for (const unmount of roots.splice(0)) await unmount();
    // The tree-bound line.
    const bound = folderRows(256);
    await mount({ hints: { min: MIN.compact }, listed: reviewed({ rows: [...bound, planRow({ rowId: fixtureId(0x2000), path: `${bound[0]!.path}/n/x`, depth: 1, parentRowId: bound[0]!.rowId })] }) });
    expect(group().querySelector('[data-slot="tree-bound"]')).not.toBeNull();
    present();
    for (const unmount of roots.splice(0)) await unmount();
    // A virtual tree of 201 rows: 40 submodules under 4 folders each, and one top-level submodule.
    const rows201 = [...folderRows(40), planRow({ rowId: fixtureId(0x3000), path: "z" })];
    expect(buildSubmoduleTree({ rows: rows201, found: [], marks: new Map(), closed: new Set() }).state === "tree" && (buildSubmoduleTree({ rows: rows201, found: [], marks: new Map(), closed: new Set() }) as { rows: unknown[] }).rows.length).toBe(201);
    await mount({ hints: { min: MIN.compact }, listed: reviewed({ rows: rows201 }) });
    present();
    for (const unmount of roots.splice(0)) await unmount();
    // A host line, a refusal line, and a running update.
    const hosts = await mount({ hints: { min: MIN.compact } });
    await click(button("Update submodules", group()));
    await answer(hosts.double.pending("reviewSubmodules"), reviewed({ hosts: [SubmoduleHostLine.parse({ path: "vendor/b", fetch: { kind: "host", name: "git.example.net" }, settings: { kind: "host", name: "github.com" } })] }));
    expect(group().querySelector('[data-slot="host-line"]')).not.toBeNull();
    present();
    for (const unmount of roots.splice(0)) await unmount();
    const refused = await mount({ hints: { min: MIN.compact } });
    await click(button("Update submodules", group()));
    await answer(refused.double.pending("reviewSubmodules"), reviewed({ refusals: [{ code: "UNSUPPORTED_SUBMODULE", reason: "inactive", path: "libs/a", text: "Submodule libs/a is not active.", remedy: null }] }));
    expect(group().querySelector('[data-slot="refusal-line"]')).not.toBeNull();
    present();
    for (const unmount of roots.splice(0)) await unmount();
    const running = await mount({ hints: { min: MIN.compact } });
    await click(button("Update submodules", group()));
    await answer(running.double.pending("reviewSubmodules"), reviewed());
    expect(running.double.pending("updateSubmodules")).toBeDefined();
    present();
  });

  test("(3) the tree takes the button and the key list as its description, with the 13 texts in each form", async () => {
    await mount({ hints: { min: MIN.compact } });
    const ids = (tree().getAttribute("aria-describedby") ?? "").split(/\s+/);
    expect(ids).toEqual([hintsButton().id, keyList().id]);
    expect(ids.every((id) => id !== "")).toBe(true);
    // Before the first feed: the hidden form.
    expect(describedTexts()).toBe(TEXTS.join(" "));
    await feed(...COMPACT);
    expect(hintsButton().getAttribute("aria-expanded")).toBe("true");
    expect(describedTexts()).toBe(TEXTS.join(" "));
    await click(hintsButton());
    expect(hintsButton().getAttribute("aria-expanded")).toBe("false");
    expect(describedTexts()).toBe(TEXTS.join(" "));
    await feed(720, 623, 28);
    expect(hintsButton().getAttribute("aria-disabled")).toBe("true");
    expect(describedTexts()).toBe(TEXTS.join(" "));
    await feed(189.99, 441, 24);
    expect(outer()!.style.height).toBe("0px");
    expect(describedTexts()).toBe(TEXTS.join(" "));
  });

  test("(4) the heading is a native disclosure button with the open chevron, and the panel's only focusable element", async () => {
    await shown();
    const b = hintsButton();
    expect([b.tagName, b.getAttribute("type"), text(b), b.getAttribute("aria-expanded"), b.getAttribute("aria-controls")]).toEqual(["BUTTON", "button", "Keys in the tree", "true", keyList().id]);
    expect(b.hasAttribute("disabled")).toBe(false);
    expect(chevron()).toEqual([shapeOf(ArrowDown01Icon)]);
    expect([...b.querySelectorAll("svg")].every((svg) => svg.getAttribute("aria-hidden") === "true")).toBe(true);
    const focusable = [...outer()!.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]")];
    expect(focusable).toEqual([b]);
  });

  test("(5) a click closes the open form and a second click opens it again", async () => {
    const view = await shown();
    await click(hintsButton());
    expect(view.hintCalls).toEqual([false]);
    expect(hintsButton().getAttribute("aria-expanded")).toBe("false");
    expect(chevron()).toEqual([shapeOf(ArrowRight01Icon)]);
    expect(keyList().style.visibility).toBe("hidden");
    expect(outer()!.style.height).toBe(`${21 + COMPACT[2]}px`);
    expect(outer()!.style.overflow).toBe("hidden");
    await click(hintsButton());
    expect(view.hintCalls).toEqual([false, true]);
    expect(hintsButton().getAttribute("aria-expanded")).toBe("true");
    expect(chevron()).toEqual([shapeOf(ArrowDown01Icon)]);
    expect(keyList().style.visibility).not.toBe("hidden");
  });

  test("(6) the panel is in the slot, not inside the Submodules group", async () => {
    await shown();
    expect(slot().contains(outer())).toBe(true);
    expect(outer()!.closest('[data-slot="submodules-group"]')).toBeNull();
  });

  test("(7) without a slot, the panel uses the hidden form inside the group section", async () => {
    await mount();
    expect(group().contains(outer())).toBe(true);
    expect([outer()!.style.height, outer()!.style.overflow, outer()!.style.visibility]).toEqual(["0px", "hidden", "hidden"]);
    expect(describedTexts()).toBe(TEXTS.join(" "));
  });

  test("(8) keyHintsForm applies the D20 fit rule", async () => {
    printOrigin("../../src/frontend/submodules/TreeKeyHints.tsx", import.meta.dir);
    const { keyHintsForm } = await import("../../src/frontend/submodules/TreeKeyHints");
    expect(keyHintsForm(728, 441, 45, 58, true)).toBe("open");
    expect(keyHintsForm(728, 441, 45, 58, false)).toBe("closed");
    expect(keyHintsForm(720, 623, 49, 70, true)).toBe("noRoom");
    expect(keyHintsForm(720, 623, 49, 70, false)).toBe("noRoom");
    expect(keyHintsForm(189.99, 441, 45, 58, true)).toBe("hidden");
    expect(keyHintsForm(190, 441, 45, 58, true)).toBe("noRoom");
    // 0.4 × (H − P_open) = 58 exactly at H − P_open = 145.
    expect(keyHintsForm(586, 441, 45, 58, true)).toBe("open");
    expect(keyHintsForm(585.99, 441, 45, 58, true)).toBe("noRoom");
  });

  test("(9) the noRoom form keeps the stored open state, refuses a click, and gives the reason", async () => {
    const view = await mount({ hints: { min: MIN.comfortable, open: true } });
    await feed(...COMFORTABLE);
    const b = hintsButton();
    expect([b.getAttribute("aria-expanded"), b.getAttribute("aria-disabled"), b.hasAttribute("disabled")]).toEqual(["false", "true", false]);
    expect(outer()!.style.height).toBe(`${21 + COMFORTABLE[2]}px`);
    expect(keyList().style.visibility).toBe("hidden");
    expect(describedText(b)).toBe(NO_ROOM);
    const reason = document.getElementById(b.getAttribute("aria-describedby")!)!;
    expect([reason.classList.contains("sr-only"), b.contains(reason), keyList().contains(reason)]).toEqual([true, false, false]);
    expect(await hoverTooltip(b)).toEqual([NO_ROOM]);
    expect(describedTexts()).toBe(TEXTS.join(" "));
    await click(b);
    expect(view.hintCalls).toEqual([]);
    expect(b.getAttribute("aria-expanded")).toBe("false");
    await feed(1020, 623, 28);
    expect(hintsButton()).toBe(b);
    expect([b.getAttribute("aria-expanded"), b.hasAttribute("aria-disabled"), b.hasAttribute("aria-describedby")]).toEqual(["true", false, false]);
    expect(await hoverTooltip(b)).toBeNull();
    expect(view.hintCalls).toEqual([]);
  });

  test("(10) the hidden form keeps the content layout, and the panel starts hidden", async () => {
    await mount({ hints: { min: MIN.compact } });
    const hidden = () => {
      expect([outer()!.style.height, outer()!.style.overflow, outer()!.style.visibility]).toEqual(["0px", "hidden", "hidden"]);
      expect([keyList().id !== "", text(keyList())]).toEqual([true, TEXTS.slice(1).join(" ")]);
    };
    hidden();
    await feed(...COMPACT);
    expect(outer()!.style.height).toBe(`${COMPACT[1]}px`);
    await feed(189.99, 441, 24);
    hidden();
  });

  test("(11) the closed outer block is 21 DIPs plus the fed button height", async () => {
    await shown(false);
    expect(outer()!.style.height).toBe("45px");
    await feed(728, 441, 31.5);
    expect(outer()!.style.height).toBe("52.5px");
  });

  test("(12) the button is the first focusable element after the tree in document order", async () => {
    await shown();
    const stops = [...document.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]")].filter((e) => e.tabIndex >= 0 && !e.hasAttribute("disabled"));
    expect(stops[stops.indexOf(tabStopRow()) + 1]).toBe(hintsButton());
  });

  test("(15) when the button loses its box, the focus goes to the tree's Tab-stop row", async () => {
    const view = await shown();
    await act(async () => hintsButton().focus());
    expect(document.activeElement).toBe(hintsButton());
    await feed(189.99, 441, 24);
    expect(document.activeElement).toBe(tabStopRow());
    // The slot unmounts, as at a switch to the constrained profile.
    await feed(...COMPACT);
    await act(async () => hintsButton().focus());
    expect(document.activeElement).toBe(hintsButton());
    await view.showSlot(false);
    expect(outer()!.closest('[data-slot="submodules-group"]')).not.toBeNull();
    expect(document.activeElement).toBe(tabStopRow());
  });
});
