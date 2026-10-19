// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { ReviewWorkbenchResult, RunWorkbenchResult, type ChangeEntry } from "../../src/contracts/envelope";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { contractChecked, fixtureId } from "./bridge-contract";
import { stubLayout } from "./history-fake";
import { answer, button, buttons, click, createWorld, keyboardFocus, mountWorkbench, oid, settle, succeeded, text, tooltipText, unmountAll, type Call } from "./sync-fake";
import type { ResolveViewProps } from "../../src/frontend/resolve/ResolveView";
import type { StatusOperation } from "../../src/frontend/status/OperationStatus";

// tasks.md T068 (feature 004, WP25). Story US9. Spec FR-089 to FR-096. Plan D7, D15 "Resolve view texts". Contract Δ3 `choose-side` and `mergetool`. Data-model §11.

printOrigin("../../src/frontend/resolve/ResolveView.tsx", import.meta.dir);
printOrigin("../../src/frontend/resolve/texts.ts", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre>{patch}</pre> }));
registerDom();
const { createRoot } = await import("react-dom/client");
const { ResolveView } = await import("../../src/frontend/resolve/ResolveView");
const workbench = await import("../../src/frontend/app/Workbench");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());

const TARGET = { repositoryId: fixtureId(1), repositoryGeneration: 1 };
const PATH = "src/app.ts";
const B64 = Buffer.from(PATH).toString("base64");
const SNAPSHOT = fixtureId(40);
const TOKEN = fixtureId(10);
const MAIN = { oid: oid(1), refs: ["refs/heads/main"] };
const LOGIN = { oid: oid(2), refs: ["refs/heads/feature/login"] };
const STAGES = [
  { stage: 1, mode: "100644", oid: oid(5) },
  { stage: 2, mode: "100644", oid: oid(6) },
  { stage: 3, mode: "100644", oid: oid(7) },
];
type Xy = "UU" | "UD" | "DU";
const KIND: Record<Xy, string> = { UU: "Both modified", UD: "Deleted by them", DU: "Deleted by us" };

function conflicted(xy: Xy = "UU"): ChangeEntry {
  const modes = xy === "UU" ? ["100644", "100644", "100644", "100644"] : xy === "UD" ? ["100644", "100644", "000000", "100644"] : ["100644", "000000", "100644", "100644"];
  const oids = [oid(5), xy === "DU" ? oid(0) : oid(6), xy === "UD" ? oid(0) : oid(7)];
  return { entryId: fixtureId(30), category: "conflicted", path: PATH, pathBytes: B64, xy, modes, oids } as ChangeEntry;
}
const plan = (xy: Xy, names: { ours: unknown; theirs: unknown } = { ours: MAIN, theirs: LOGIN }) => ({
  path: B64,
  kind: { xy, text: KIND[xy] },
  stages: STAGES.filter((s) => !(xy === "UD" && s.stage === 3) && !(xy === "DU" && s.stage === 2)),
  names,
  operation: "merging",
});
// Each fixture result passes the contract result schema.
function chosen(side: "ours" | "theirs", xy: Xy = "UU", names?: { ours: unknown; theirs: unknown }) {
  const result = ReviewWorkbenchResult.parse({ action: "choose-side", plan: { ...plan(xy, names), side }, workbenchToken: TOKEN });
  return { requestId: fixtureId(20), operationId: fixtureId(21), state: "succeeded", repositoryGeneration: 1, result };
}
function tooled(name = "vscode", xy: Xy = "UU") {
  const result = ReviewWorkbenchResult.parse({ action: "mergetool", plan: { ...plan(xy), tool: { name, scope: "global", origin: "file:C:/Users/me/.gitconfig" } }, workbenchToken: TOKEN });
  return { requestId: fixtureId(20), operationId: fixtureId(21), state: "succeeded", repositoryGeneration: 1, result };
}
function refused(code: string, reason?: string) {
  const result = reason === undefined ? {} : { reason };
  ReviewWorkbenchResult.parse(result);
  return { requestId: fixtureId(20), state: code === "WORKBENCH_UNAVAILABLE" ? "failed" : "rejected", code, result };
}
function ran(action: "choose-side" | "mergetool", staged: boolean, state = "succeeded", fields: Record<string, unknown> = {}) {
  const result = RunWorkbenchResult.parse({ action, staged, operationState: staged ? "merging" : "merging", ...fields });
  return { requestId: fixtureId(22), operationId: fixtureId(23), state, repositoryGeneration: 1, result, ...(state === "succeeded" ? {} : { code: "GIT_FAILED" }) };
}
const COMPARISON = { comparisonId: fixtureId(50), snapshotId: SNAPSHOT, entryId: fixtureId(30), scope: "index-to-worktree", completeness: { state: "complete" }, patch: Buffer.from("diff --cc src/app.ts\n").toString("base64"), hunks: [], support: "state", fileAction: "resolve", remedy: null };

function createDouble() {
  const calls: Call[] = [];
  const make = (operation: string) => (...args: unknown[]) =>
    new Promise((resolve) => {
      const call: Call = { operation, args, done: false, resolve: (r) => void ((call.done = true), resolve(r)) };
      calls.push(call);
    });
  const bridge = contractChecked({ reviewWorkbench: make("reviewWorkbench"), runWorkbench: make("runWorkbench"), applyFile: make("applyFile"), cancel: make("cancel") }) as unknown as ResolveViewProps["bridge"];
  const of = (operation: string) => calls.filter((c) => c.operation === operation);
  return { bridge, calls, of, pending: (operation: string) => of(operation).find((c) => !c.done) };
}
type Double = ReturnType<typeof createDouble>;
const reviews = (d: Double) => d.of("reviewWorkbench").map((c) => c.args[1]);

const roots: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of roots.splice(0)) await unmount();
  await unmountAll();
});
type Mount = { double: Double; ops: StatusOperation[]; ended: unknown[]; fileEnded: unknown[]; statuses: (string | null)[]; settings: number[]; rerender(next: Partial<ResolveViewProps>): Promise<void> };
async function mount(fields: Partial<ResolveViewProps> = {}): Promise<Mount> {
  const double = createDouble();
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const draw = (props: Partial<ResolveViewProps>) =>
    root.render(
      <ResolveView
        entry={conflicted()}
        snapshotId={SNAPSHOT}
        comparison={COMPARISON as never}
        bridge={double.bridge}
        target={TARGET}
        blocked="operation"
        onOperation={(op) => m.ops.push(op)}
        onEnded={(r) => m.ended.push(r)}
        onFileEnded={(r) => m.fileEnded.push(r)}
        onStatus={(t) => m.statuses.push(t)}
        onOpenSettings={() => m.settings.push(1)}
        {...props}
      />,
    );
  const m: Mount = { double, ops: [], ended: [], fileEnded: [], statuses: [], settings: [], rerender: (next) => act(async () => draw({ ...fields, ...next })) };
  await act(async () => draw(fields));
  roots.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await settle();
  return m;
}
/** Answers the three display reviews in their order: ours, theirs, then the merge tool. */
async function answerReviews(d: Double, ours: unknown, theirs: unknown, tool: unknown) {
  await answer(d.pending("reviewWorkbench"), ours);
  await answer(d.pending("reviewWorkbench"), theirs);
  await answer(d.pending("reviewWorkbench"), tool);
}
const view = () => document.querySelector(`section[aria-label="Resolve ${PATH}"]`)!;
const disabled = (b: HTMLElement) => b.getAttribute("aria-disabled") === "true" || b.hasAttribute("disabled");
/** The accessible description of a control. */
const described = (b: HTMLElement) =>
  (b.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter((id) => id !== "")
    .map((id) => text(document.getElementById(id)!))
    .join(" ");

describe("Resolve view facts (FR-089, FR-090)", () => {
  test("names the path, the kind from the status code, and both sides in the item labels", async () => {
    const { double } = await mount();
    expect(text(view())).toContain("Arbareto reads the Git facts.");
    // The kind comes from the porcelain v2 code before any review answers (data-model §11).
    expect(text(view())).toContain("Both modified");
    expect(reviews(double)).toEqual([{ action: "choose-side", snapshotId: SNAPSHOT, entryId: fixtureId(30), side: "ours" }]);
    await answerReviews(double, chosen("ours"), chosen("theirs"), tooled());
    expect(reviews(double)).toEqual([
      { action: "choose-side", snapshotId: SNAPSHOT, entryId: fixtureId(30), side: "ours" },
      { action: "choose-side", snapshotId: SNAPSHOT, entryId: fixtureId(30), side: "theirs" },
      { action: "mergetool", snapshotId: SNAPSHOT, entryId: fixtureId(30) },
    ]);
    expect(text(view())).toContain(PATH);
    expect(text(view())).not.toContain("Arbareto reads the Git facts.");
    for (const label of ["Choose ours (main)", "Choose theirs (feature/login)", "Open in merge tool", "Mark resolved"]) expect(disabled(button(label, view()))).toBe(false);
    expect(text(view())).toContain("vscode, from merge.tool");
    // No run, no file action, and no comparison text decide the view.
    expect(double.of("runWorkbench")).toHaveLength(0);
    expect(text(view())).not.toContain("diff --cc");
  });

  test("a side without a ref shows its short ID, and a side without a commit fact shows no name", async () => {
    const { double } = await mount();
    const names = { ours: { oid: oid(1), refs: [] }, theirs: null };
    await answerReviews(double, chosen("ours", "UU", names), chosen("theirs", "UU", names), tooled());
    expect(buttons("Choose ours (000000000000)", view())).toHaveLength(1);
    expect(buttons("Choose theirs", view())).toHaveLength(1);
  });
});

describe("Unavailable items (FR-092 to FR-094)", () => {
  test("a deleted side and a missing stage give each item its reason, from the review reason only", async () => {
    const { double } = await mount({ entry: conflicted("UD") });
    expect(text(view())).toContain("Deleted by them");
    await answerReviews(double, chosen("ours", "UD"), refused("WORKBENCH_UNAVAILABLE", "side-missing"), refused("WORKBENCH_UNAVAILABLE", "stages-missing"));
    const theirs = button("Choose theirs (feature/login)", view());
    expect(disabled(theirs)).toBe(true);
    expect(described(theirs)).toBe("The index has no version of this side.");
    const tool = button("Open in merge tool", view());
    expect(disabled(tool)).toBe(true);
    expect(described(tool)).toBe("The merge tool needs both sides. The index has only one side.");
    expect(disabled(button("Choose ours (main)", view()))).toBe(false);
    expect(disabled(button("Mark resolved", view()))).toBe(false);
  });

  test("a stage that is no regular file gives the side-not-regular reason", async () => {
    const { double } = await mount();
    await answerReviews(double, refused("WORKBENCH_UNAVAILABLE", "side-not-regular"), chosen("theirs"), refused("WORKBENCH_UNAVAILABLE", "side-not-regular"));
    expect(described(button("Choose ours (main)", view()))).toBe("This side is not a regular file in the index.");
    expect(described(button("Open in merge tool", view()))).toBe("A side is not a regular file in the index.");
  });

  test("without merge.tool the item gives the spec reason and offers the page Editor and tools", async () => {
    const m = await mount();
    await answerReviews(m.double, chosen("ours"), chosen("theirs"), refused("WORKBENCH_UNAVAILABLE", "no-merge-tool"));
    const tool = button("Open in merge tool", view());
    expect(disabled(tool)).toBe(true);
    expect(described(tool)).toBe("Set a merge tool in Git settings");
    await click(button("Open Editor and tools", view()));
    expect(m.settings).toEqual([1]);
  });

  test("a merge.tool path and a repository tool without trust give their reasons", async () => {
    const { double } = await mount();
    await answerReviews(double, chosen("ours"), chosen("theirs"), refused("WORKBENCH_UNAVAILABLE", "merge-tool-name"));
    expect(described(button("Open in merge tool", view()))).toBe("The merge.tool value is a path. Git accepts only a tool name here.");
    await unmountRoots();
    const again = await mount();
    await answerReviews(again.double, chosen("ours"), chosen("theirs"), refused("TRUST_REQUIRED"));
    expect(described(button("Open in merge tool", view()))).toBe("This action runs programs of this repository. Trust the repository first with the trust chip in the status bar.");
  });

  test("an unmapped code shows the item label and the code", async () => {
    const { double } = await mount();
    await answerReviews(double, chosen("ours"), chosen("theirs"), refused("GIT_FAILED"));
    expect(described(button("Open in merge tool", view()))).toBe("Open in merge tool is unavailable: GIT_FAILED");
  });

  test("while an operation runs, the reason shows only in the tooltip (D15 running rule)", async () => {
    const { double } = await mount({ blocked: "running" });
    await answerReviews(double, chosen("ours"), chosen("theirs"), tooled());
    const ours = button("Choose ours (main)", view());
    expect(disabled(ours)).toBe(true);
    // The accessible description holds the reason, and no visible line repeats it.
    expect(described(ours)).toBe("A Git operation is running. Its progress and Cancel are in the status bar.");
    const ids = (ours.getAttribute("aria-describedby") ?? "").split(" ");
    for (const id of ids) expect(document.getElementById(id)!.classList.contains("sr-only")).toBe(true);
    await keyboardFocus(ours);
    expect(tooltipText()).toBe("A Git operation is running. Its progress and Cancel are in the status bar.");
  });
});

async function unmountRoots() {
  for (const unmount of roots.splice(0)) await unmount();
}

describe("Choose ours and Choose theirs (FR-091, FR-092)", () => {
  test("reviews again, asks with Cancel first, and runs only with the token of that review", async () => {
    const m = await mount();
    await answerReviews(m.double, chosen("ours"), chosen("theirs"), tooled());
    await click(button("Choose theirs (feature/login)", view()));
    expect(reviews(m.double).at(-1)).toEqual({ action: "choose-side", snapshotId: SNAPSHOT, entryId: fixtureId(30), side: "theirs" });
    await answer(m.double.pending("reviewWorkbench"), chosen("theirs"));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(text(dialog)).toContain(`Replace ${PATH} with the feature/login version. Your edits to this file are lost.`);
    expect(document.activeElement).toBe(button("Cancel", dialog));
    await click(button("Cancel", dialog));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(m.double.of("runWorkbench")).toHaveLength(0);

    await click(button("Choose theirs (feature/login)", view()));
    await answer(m.double.pending("reviewWorkbench"), chosen("theirs"));
    await click(button("Choose theirs", document.querySelector('[role="dialog"]')!));
    const run = m.double.pending("runWorkbench")!;
    expect(run.args[1]).toEqual({ workbenchToken: TOKEN, start: true });
    expect(m.ops.at(-1)?.kind).toBe("runWorkbench");
    expect(m.ops.at(-1)?.texts).toEqual(["Choose theirs", "Choosing theirs", "Choose theirs details"]);
    await answer(run, ran("choose-side", false));
    expect(m.ended).toHaveLength(1);
    // Spec FR-091: the path stays unmerged until Mark resolved.
    expect(m.statuses.at(-1)).toBe(`Git wrote the feature/login version to ${PATH}. The file stays conflicted until you select Mark resolved.`);
  });

  test("a stale binding at the click refuses the action and asks for a refresh", async () => {
    const m = await mount();
    await answerReviews(m.double, chosen("ours"), chosen("theirs"), tooled());
    await click(button("Choose ours (main)", view()));
    await answer(m.double.pending("reviewWorkbench"), refused("STALE_SELECTION"));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(text(view())).toContain("The file or its index stages changed. Select Refresh (F5) and try again.");
    expect(m.double.of("runWorkbench")).toHaveLength(0);
  });

  test("a failed run states the code", async () => {
    const m = await mount();
    await answerReviews(m.double, chosen("ours"), chosen("theirs"), tooled());
    await click(button("Choose ours (main)", view()));
    await answer(m.double.pending("reviewWorkbench"), chosen("ours"));
    await click(button("Choose ours", document.querySelector('[role="dialog"]')!));
    await answer(m.double.pending("runWorkbench"), { requestId: fixtureId(22), operationId: fixtureId(23), state: "failed", code: "GIT_FAILED", repositoryGeneration: 1, result: { action: "choose-side" } });
    expect(text(view())).toContain("Choose ours did not complete: GIT_FAILED");
  });
});

describe("Open in merge tool (FR-093 to FR-096)", () => {
  test("states Open in <tool> with Cancel while the tool runs, and Cancel ends the operation", async () => {
    const m = await mount();
    await answerReviews(m.double, chosen("ours"), chosen("theirs"), tooled());
    await click(button("Open in merge tool", view()));
    expect(reviews(m.double).at(-1)).toEqual({ action: "mergetool", snapshotId: SNAPSHOT, entryId: fixtureId(30) });
    await answer(m.double.pending("reviewWorkbench"), tooled());
    const run = m.double.pending("runWorkbench")!;
    expect(run.args[1]).toEqual({ workbenchToken: TOKEN, start: true });
    expect(m.ops.at(-1)?.texts).toEqual(["Merge tool", "Open in vscode", "Merge tool details"]);
    expect(text(view())).toContain("Open in vscode");
    await act(async () => (run.args[2] as (e: unknown) => void)({ requestId: fixtureId(22), operationId: fixtureId(23), state: "running", phase: "mergetool", counters: {} }));
    await settle();
    await click(button("Cancel", view()));
    expect(m.double.pending("cancel")!.args[0]).toEqual({ operationId: fixtureId(23) });
    await answer(run, ran("mergetool", false, "canceled"));
    // Spec FR-096: the fresh index read decides. The path stays, with Mark resolved.
    expect(m.statuses.at(-1)).toBe(`${PATH} stays conflicted. Select Mark resolved when the file is ready.`);
    expect(buttons("Cancel", view())).toHaveLength(0);
    expect(disabled(button("Mark resolved", view()))).toBe(false);
  });

  test("staged true from the fresh index read states that Git staged the path, whatever the exit or the output says", async () => {
    const m = await mount();
    await answerReviews(m.double, chosen("ours"), chosen("theirs"), tooled());
    await click(button("Open in merge tool", view()));
    await answer(m.double.pending("reviewWorkbench"), tooled());
    await answer(m.double.pending("runWorkbench"), ran("mergetool", true, "completed-with-effects", { outputTail: "merge failed, nothing staged\n" }));
    expect(m.statuses.at(-1)).toBe(`Git staged ${PATH}.`);
    expect(m.ended).toHaveLength(1);
  });

  test("staged false with an output that claims success keeps the path conflicted", async () => {
    const m = await mount();
    await answerReviews(m.double, chosen("ours"), chosen("theirs"), tooled());
    await click(button("Open in merge tool", view()));
    await answer(m.double.pending("reviewWorkbench"), tooled());
    await answer(m.double.pending("runWorkbench"), ran("mergetool", false, "failed", { outputTail: "Git staged src/app.ts.\n" }));
    expect(m.statuses.at(-1)).toBe(`${PATH} stays conflicted. Select Mark resolved when the file is ready.`);
  });

  test("a refused review at the click starts no run", async () => {
    const m = await mount();
    await answerReviews(m.double, chosen("ours"), chosen("theirs"), tooled());
    await click(button("Open in merge tool", view()));
    await answer(m.double.pending("reviewWorkbench"), refused("TRUST_CHANGED"));
    expect(m.double.of("runWorkbench")).toHaveLength(0);
    expect(text(view())).toContain("This action runs programs of this repository.");
  });
});

describe("Mark resolved in the resolve view (FR-089, FR-096)", () => {
  test("sends the 003 applyFile resolve of the shown comparison", async () => {
    const m = await mount();
    await answerReviews(m.double, chosen("ours"), chosen("theirs"), tooled());
    await click(button("Mark resolved", view()));
    const call = m.double.pending("applyFile")!;
    expect(call.args[1]).toEqual({ comparisonId: fixtureId(50), snapshotId: SNAPSHOT, direction: "resolve" });
    await answer(call, succeeded({}));
    expect(m.fileEnded).toHaveLength(1);
  });

  test("a refusing file-action decision shows Mark resolved unavailable with its reason before any request", async () => {
    const m = await mount({ comparison: { ...COMPARISON, fileAction: "missing" } as never });
    await answerReviews(m.double, chosen("ours"), chosen("theirs"), tooled());
    const b = button("Mark resolved", view());
    expect(disabled(b)).toBe(true);
    expect(described(b)).toBe("The working file of this conflicted path is missing.");
    // FR-089: the item stays in the view, and its label shows once.
    expect(text(view()).split("Mark resolved")).toHaveLength(2);
    await click(b);
    expect(m.double.of("applyFile")).toHaveLength(0);
  });

  test("without a comparison, Mark resolved states that the comparison still loads", async () => {
    const m = await mount({ comparison: null });
    await answerReviews(m.double, chosen("ours"), chosen("theirs"), tooled());
    const b = button("Mark resolved", view());
    expect(disabled(b)).toBe(true);
    expect(described(b)).toBe("Its comparison is still loading.");
  });
});

describe("Trust ask of the resolve items (plan D12 \"Ask\", spec US6 scenario 5)", () => {
  const TOKEN2 = fixtureId(11);
  const withToken = (response: ReturnType<typeof tooled>) => ({ ...response, result: { ...response.result, workbenchToken: TOKEN2 } });

  test("a trust refusal keeps the merge tool available; the click asks before the tool starts and runs with the token of the new review", async () => {
    const asks: string[] = [];
    const m = await mount({ askTrust: async (action) => (asks.push(action), true) });
    await answerReviews(m.double, chosen("ours"), chosen("theirs"), refused("TRUST_REQUIRED"));
    const tool = button("Open in merge tool", view());
    expect(disabled(tool)).toBe(false);
    await click(tool);
    await answer(m.double.pending("reviewWorkbench"), refused("TRUST_REQUIRED"));
    expect(asks).toEqual(["mergetool"]);
    expect(m.double.of("runWorkbench")).toHaveLength(0);
    expect(reviews(m.double).at(-1)).toEqual({ action: "mergetool", snapshotId: SNAPSHOT, entryId: fixtureId(30) });
    await answer(m.double.pending("reviewWorkbench"), withToken(tooled()));
    expect(m.double.pending("runWorkbench")!.args[1]).toEqual({ workbenchToken: TOKEN2, start: true });
  });

  test("Choose ours asks with the action resolve, and the second review takes the snapshot of the full read", async () => {
    const asks: string[] = [];
    const NEW_TARGET = { ...TARGET, repositoryGeneration: 2 };
    let approve: (approved: boolean) => void = () => {};
    const m = await mount({
      askTrust: (action) => {
        asks.push(action);
        return new Promise((resolve) => void (approve = resolve));
      },
    });
    await answerReviews(m.double, chosen("ours"), chosen("theirs"), tooled());
    await click(button("Choose ours (main)", view()));
    await answer(m.double.pending("reviewWorkbench"), refused("TRUST_CHANGED"));
    expect(asks).toEqual(["resolve"]);
    // The full read after the approval shows the same entry in a new snapshot and generation.
    await m.rerender({ snapshotId: fixtureId(41), entry: { ...conflicted(), entryId: fixtureId(31) }, target: NEW_TARGET });
    await act(async () => approve(true));
    await settle();
    const second = m.double.of("reviewWorkbench").at(-1)!;
    expect(second.args.slice(0, 2)).toEqual([NEW_TARGET, { action: "choose-side", snapshotId: fixtureId(41), entryId: fixtureId(31), side: "ours" }]);
    await answer(second, chosen("ours"));
    expect(text(document.querySelector('[role="dialog"]')!)).toContain("Replace");
  });

  test("Not now keeps the D15 trust text and starts no run", async () => {
    const m = await mount({ askTrust: async () => false });
    await answerReviews(m.double, chosen("ours"), chosen("theirs"), refused("TRUST_REQUIRED"));
    await click(button("Open in merge tool", view()));
    await answer(m.double.pending("reviewWorkbench"), refused("TRUST_REQUIRED"));
    expect(m.double.pending("reviewWorkbench")).toBeUndefined();
    expect(m.double.of("runWorkbench")).toHaveLength(0);
    expect(text(view())).toContain("This action runs programs of this repository. Trust the repository first with the trust chip in the status bar.");
  });
});

describe("Malformed results (plan D15 \"Malformed result\")", () => {
  test("a succeeded review without a token names the unknown form, never the state", async () => {
    const { double } = await mount();
    await answerReviews(double, chosen("ours"), chosen("theirs"), { requestId: fixtureId(20), state: "succeeded", repositoryGeneration: 1, result: {} });
    expect(described(button("Open in merge tool", view()))).toBe("Open in merge tool did not complete: the result has an unknown form.");
  });

  test("a succeeded merge tool run without the staged fact names the unknown form", async () => {
    const m = await mount();
    await answerReviews(m.double, chosen("ours"), chosen("theirs"), tooled());
    await click(button("Open in merge tool", view()));
    await answer(m.double.pending("reviewWorkbench"), tooled());
    await answer(m.double.pending("runWorkbench"), { requestId: fixtureId(22), operationId: fixtureId(23), state: "succeeded", repositoryGeneration: 1, result: { action: "mergetool" } });
    expect(text(view())).toContain("Merge tool did not complete: the result has an unknown form.");
    expect(text(view())).not.toContain("succeeded");
  });
});

describe("Resolve view mount (FR-089, plan D15 P2 regions)", () => {
  test("a selected Conflicted entry in the Commit view shows the resolve view in the diff area", async () => {
    const file = conflicted();
    const world = createWorld({ operationState: "merging", entries: [file] });
    world.answers.readComparison = (args) => {
      const payload = args[1] as { snapshotId: string; entryId: string };
      return { ...succeeded({ ...COMPARISON, comparisonId: crypto.randomUUID(), snapshotId: payload.snapshotId, entryId: payload.entryId }), entryId: payload.entryId };
    };
    const d = await mountWorkbench(workbench, world);
    await click(button("Commit", document.querySelector('header nav[aria-label="Views"]')!));
    await click(document.querySelector<HTMLElement>(`[role="treeitem"][data-entry-id="${file.entryId}"]`)!);
    await settle();
    const region = document.querySelector('[data-section="comparison"]')!;
    expect(region.querySelector(`section[aria-label="Resolve ${PATH}"]`)).not.toBeNull();
    expect(text(region)).not.toContain("diff --cc");
    const review = d.pending("reviewWorkbench")!;
    expect((review.args[1] as Record<string, unknown>).action).toBe("choose-side");
    expect((review.args[1] as Record<string, unknown>).entryId).toBe(file.entryId);
  });

  test("Open Editor and tools opens Settings on that page and focuses the view heading", async () => {
    const file = conflicted();
    const world = createWorld({ operationState: "merging", entries: [file] });
    world.answers.readComparison = (args) => {
      const payload = args[1] as { snapshotId: string; entryId: string };
      return { ...succeeded({ ...COMPARISON, comparisonId: crypto.randomUUID(), snapshotId: payload.snapshotId, entryId: payload.entryId }), entryId: payload.entryId };
    };
    const d = await mountWorkbench(workbench, world);
    await click(button("Commit", document.querySelector('header nav[aria-label="Views"]')!));
    await click(document.querySelector<HTMLElement>(`[role="treeitem"][data-entry-id="${file.entryId}"]`)!);
    await settle();
    await answer(d.pending("reviewWorkbench"), chosen("ours"));
    await answer(d.pending("reviewWorkbench"), chosen("theirs"));
    await answer(d.pending("reviewWorkbench"), refused("WORKBENCH_UNAVAILABLE", "no-merge-tool"));
    await click(button("Open Editor and tools", document.querySelector('[data-section="comparison"]')!));
    await settle();
    const settings = document.querySelector<HTMLElement>('[data-view="settings"]')!;
    expect(text(settings.querySelector('[role="tab"][aria-selected="true"]')!)).toBe("Editor and tools");
    expect(document.activeElement).toBe(settings.querySelector("h2"));
  });
});
