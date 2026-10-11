// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T234: the submodule notice, the submodule review, and the submodule copy of the status area.
// plan.md "Notice band", "Required visible states" (Submodule notice, Submodule review, Updating submodules), "Status area", "Dialog sizes",
// "Keyboard and focus" (Submodule review dialog row), and the Update submodules row of "Task flow and command placement". Contract §12 "Plan", "Refusals", "Progress", and "Reconciliation and outcome".
//
// The props below are the interface that T235 and T236 build:
// - `SubmoduleNotice` ({ count, onUpdate }): the submodule row of the notice band.
// - `SubmoduleReview` ({ open, bridge, target, snapshotId, review, client, finalFocus, startFocus, onCancel, onOperation }):
//   `review` is the `reviewSubmodules` result value. `finalFocus` gives the opener, or the nearest surviving logical control.
//   `startFocus` gives Cancel in the status bar. `onOperation` gets each `trackOperation` report of the `updateSubmodules` request.
//   The service accepts a request or rejects it before the first progress event (contract §9: an expired token gives `APPROVAL_EXPIRED` at acceptance).
//   So the dialog closes at the first progress event, and a rejection before it keeps the dialog open.
// - `OperationStatus`: a `StatusOperation` of kind `updateSubmodules` carries `submoduleRows`, the plan rows of its review.
//   Each outcome row icon carries `data-icon` "added", "warning", or "removed".
// The stall notice of a submodule step is a T257 case in `stall-notice.test.tsx`.

import { afterEach, describe, expect, test } from "bun:test";
import { act, useState, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";

printOrigin("../../src/frontend/status/OperationStatus.tsx", import.meta.dir);
registerDom();
const { createRoot } = await import("react-dom/client");
const { OperationStatus } = await import("../../src/frontend/status/OperationStatus");

// T235 and T236 wait for T117. A template path keeps `tsc` from resolving the modules before they exist.
// Each case names its implementing task. That task turns `test.todo` into `test`.
const NEEDS_NOTICE = "(needs T235)";
const NEEDS = "(needs T236)";
type Props = Record<string, unknown>;
async function submoduleNotice(): Promise<{ SubmoduleNotice: (props: Props) => ReactNode }> {
  const module = "SubmoduleNotice";
  printOrigin(`../../src/frontend/submodules/${module}.tsx`, import.meta.dir);
  return await import(`../../src/frontend/submodules/${module}.tsx`);
}
async function submoduleReview(): Promise<{ SubmoduleReview: (props: Props) => ReactNode }> {
  const module = "SubmoduleReview";
  printOrigin(`../../src/frontend/submodules/${module}.tsx`, import.meta.dir);
  return await import(`../../src/frontend/submodules/${module}.tsx`);
}

// ---- Texts (plan.md "Required visible states" and contract §12). ----
const NOTICE = (n: number) => `Some submodules are not initialized or not at their recorded commit. Count: ${n}.`;
const DISCLOSURE = "Git connects to each URL. Your credential helper can show its own window.";
const PROGRAMS = "Programs from submodule settings and hooks that Git can run";
const UNCHECKED = "Arbareto cannot check this file before the run.";
const INACTIVITY = "Git sent no output and transferred no data for 5 minutes, so Arbareto stopped it.";
const FLAGS = {
  fetched: "Git fetched in this submodule.",
  found: "Found during the update.",
  connected: "Git connected the submodule folder.",
  registered: "Git changed the settings of this submodule.",
  failedRead: "Arbareto could not read this submodule. Use Refresh, then try again.",
};

const OLD = "1111111111111111111111111111111111111111";
const NEW = "2222222222222222222222222222222222222222";
const ELSEWHERE = "3333333333333333333333333333333333333333";
const short = (oid: string) => oid.slice(0, 12);
const id = () => crypto.randomUUID();
const OPERATION_ID = "6f9619ff-8b86-4011-b42d-00cf4fc964ff";
const TARGET = { repositoryId: id(), repositoryGeneration: 3 };
const SNAPSHOT = id();
const CLIENT = { width: 1280, height: 800 };
const ROOT = "C:\\work\\super";

const ROW_A = id();
const ROW_B = id();
const planRow = (fields: Record<string, unknown>) => ({
  rowId: id(),
  pathBytes: btoa(String(fields.path)),
  name: String(fields.path),
  depth: 0,
  parentRowId: null,
  url: null,
  head: null,
  target: NEW,
  remotes: [],
  action: "none",
  notes: [],
  refusal: null,
  ...fields,
});
const CLONE_ROW = planRow({ rowId: ROW_A, path: "libs/a", url: "https://example.invalid/a.git", action: "clone", notes: ["Git registers the URL in the repository settings."] });
const FETCH_ROW = planRow({
  rowId: ROW_B,
  path: "libs/b",
  url: "https://example.invalid/b.git",
  head: OLD,
  action: "fetch-checkout",
  remotes: [
    { name: "origin", url: "https://example.invalid/b.git", default: true },
    { name: "mirror", url: "https://mirror.invalid/b.git", default: false },
  ],
  notes: ["Git fetches in this submodule before the checkout."],
});
const PROGRAM = { rowId: ROW_B, key: "core.fsmonitor", scope: "local", origin: "C:\\work\\super\\.git\\modules\\libs\\b\\config", program: "fsmon.exe", digest: "unchecked" };
const review = (fields: Record<string, unknown> = {}) => ({ generation: 3, rows: [CLONE_ROW, FETCH_ROW], programs: [PROGRAM], refusals: [], submoduleReviewToken: id(), ...fields });
const UNSAVED_TEXT = "Submodule libs/b is at commit 111111111111, which the update can leave without a branch, tag, or other ref. Save it with the command, then use Refresh.";
const UNSAVED_COMMAND = `& 'C:\\Git\\cmd\\git.exe' --no-lazy-fetch -C 'C:\\work\\super\\libs\\b' --git-dir=.git branch 'arbareto-saved-111111111111' '${OLD}'`;
const NOT_EMPTY_TEXT = "Submodule libs/a has no Git link, but its folder is not empty. Git would overwrite those files. Move the folder out of the repository, then use Refresh.";
const refusal = (reason: string, path: string, text: string, command: string | null) => ({ code: "UNSUPPORTED_SUBMODULE", reason, path, text, remedy: command === null ? null : { command } });

// ---- DOM helpers. ----
const text = (element: Element | null | undefined) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();
const buttons = (label: string, root: ParentNode = document) => [...root.querySelectorAll("button")].filter((b) => text(b) === label);
const button = (label: string, root: ParentNode = document) => {
  const found = buttons(label, root);
  expect(found).toHaveLength(1);
  return found[0]!;
};
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const click = (element: HTMLElement) => act(async () => element.click());
const settle = () => act(async () => await new Promise((resolve) => setImmediate(resolve)));
const describedText = (element: Element) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((ref) => text(document.getElementById(ref)))
    .join(" ");

const written: string[] = [];
const clipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  written.length = 0;
  if (clipboard) Object.defineProperty(globalThis.navigator, "clipboard", clipboard);
  else delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
});
function stubClipboard() {
  Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => void written.push(value) } });
}

async function render(node: ReactNode) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(node));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
}

// ---- Submodule notice (T235). ----
describe("submodule notice", () => {
  test(`it shows the plan.md text with the count, the Warning icon, and Update submodules with its icon ${NEEDS_NOTICE}`, async () => {
    const { SubmoduleNotice } = await submoduleNotice();
    const updates: number[] = [];
    await render(<SubmoduleNotice count={2} onUpdate={() => void updates.push(1)} />);
    expect(text(document.body)).toContain(NOTICE(2));
    // Never color alone: the text carries the state, and the icon sits beside it.
    expect(document.querySelector('[data-icon="warning"]')).not.toBeNull();
    const update = button("Update submodules");
    expect(update.querySelector("svg")).not.toBeNull();
    await click(update);
    expect(updates).toEqual([1]);
  });
});

// ---- Submodule review (T236). ----
type Call = { name: string; target: unknown; payload: unknown; onProgress?: (event: unknown) => void; resolve(response: unknown): void };
function reviewBridge() {
  const calls: Call[] = [];
  const call = (name: string) => (target: unknown, payload: unknown, onProgress?: (event: unknown) => void) =>
    new Promise((resolve) => void calls.push({ name, target, payload, onProgress, resolve }));
  const bridge = { reviewSubmodules: call("reviewSubmodules"), updateSubmodules: call("updateSubmodules") };
  return { bridge, calls, of: (name: string) => calls.filter((c) => c.name === name) };
}

async function mountReview(value = review()) {
  const { SubmoduleReview } = await submoduleReview();
  const double = reviewBridge();
  const operations: { progress: unknown; response: unknown }[] = [];
  const status = statusBridge();
  let setOpen!: (open: boolean) => void;
  // The controls outside the dialog are plain DOM nodes, so a case can remove the opener without breaking the React unmount.
  const outside = document.body.appendChild(document.createElement("div"));
  for (const [role, label] of [["opener", "Update submodules"], ["status-cancel", "Cancel"], ["fallback", "Refresh"]] as const) {
    const control = outside.appendChild(document.createElement("button"));
    control.type = "button";
    control.dataset.double = role;
    control.textContent = label;
  }
  unmounts.push(async () => outside.remove());
  const opener = () => document.querySelector<HTMLElement>('[data-double="opener"]');
  // The status region owns the outcome focus, so the review and the status region mount together, as in the workbench.
  function Harness() {
    const [open, set] = useState(true);
    const [op, setOp] = useState<Operation | null>(null);
    setOpen = set;
    return (
      <>
        <textarea data-double="message" />
        <OperationStatus
          bridge={status.bridge}
          operation={op}
          worktreeRoot={ROOT}
          head={null}
          trusted={false}
          panel="details"
          modalOpen={false}
          refusal={null}
          onFocusMessageField={() => {}}
          onClearMessage={() => {}}
          onRefresh={() => {}}
          declinedFocus={opener}
        />
        <SubmoduleReview
          open={open}
          bridge={double.bridge}
          target={TARGET}
          snapshotId={SNAPSHOT}
          review={value}
          client={CLIENT}
          finalFocus={opener}
          startFocus={() => document.querySelector<HTMLElement>('[data-double="status-cancel"]')}
          onCancel={() => set(false)}
          onOperation={(next: Operation) => {
            operations.push(next);
            setOp(next);
          }}
        />
      </>
    );
  }
  await render(<Harness />);
  await settle();
  return { ...double, operations, setOpen, statusCalls: status.calls, opener: () => opener()! };
}
const accepted = (call: Call) => act(async () => call.onProgress?.({ requestId: id(), operationId: OPERATION_ID, state: "accepted", phase: "update", path: "libs/a", counters: { rowIndex: 1, rowCount: 2 }, stalled: false }));
const answer = (call: Call, response: unknown) => act(async () => call.resolve({ requestId: id(), operationId: OPERATION_ID, ...(response as object) }));

describe("submodule review", () => {
  test(`the dialog lists each row with its path, redacted URL in the code font, action text, and notes, and the program list ${NEEDS}`, async () => {
    await mountReview();
    const root = dialog()!;
    expect(root).not.toBeNull();
    expect(text(root.querySelector("h1, h2, h3"))).toBe("Update submodules");
    const [rows, programs] = [...root.querySelectorAll<HTMLElement>('[role="listbox"]')];
    const options = [...rows!.querySelectorAll('[role="option"]')];
    expect(options).toHaveLength(2);
    expect(text(options[0])).toContain("libs/a");
    expect([...options[0]!.querySelectorAll("code")].map(text)).toContain("https://example.invalid/a.git");
    expect(text(options[0])).toContain("Clone");
    expect(text(options[0])).toContain("Git registers the URL in the repository settings.");
    expect(text(options[1])).toContain("libs/b");
    expect(text(options[1])).toContain(`Fetch, then move from ${short(OLD)} to ${short(NEW)}`);
    expect(text(options[1])).toContain("Git fetches in this submodule before the checkout.");
    expect(text(root)).toContain(DISCLOSURE);
    expect(text(root)).toContain(PROGRAMS);
    expect(text(programs)).toContain("core.fsmonitor");
    expect(text(programs)).toContain("fsmon.exe");
    // plan.md "Task flow and command placement", Update submodules: the `unchecked` program text.
    expect(text(programs)).toContain(UNCHECKED);
  });

  test(`a fetching row lists each redacted remote URL, with (default) after the default remote only ${NEEDS}`, async () => {
    await mountReview();
    const row = [...dialog()!.querySelectorAll('[role="option"]')].find((o) => text(o).includes("libs/b"))!;
    expect(text(row)).toContain("https://example.invalid/b.git (default)");
    expect(text(row)).toContain("https://mirror.invalid/b.git");
    expect(text(row)).not.toContain("https://mirror.invalid/b.git (default)");
  });

  test(`the reuse and checkout actions read their plan.md texts ${NEEDS}`, async () => {
    const reuse = planRow({ path: "libs/c", url: "https://example.invalid/c.git", action: "reuse" });
    const checkout = planRow({ path: "libs/d", url: "https://example.invalid/d.git", head: OLD, action: "checkout" });
    const none = planRow({ path: "libs/e", url: "https://example.invalid/e.git", head: NEW, action: "none" });
    const skip = planRow({ path: "libs/f", url: "https://example.invalid/f.git", action: "skip" });
    await mountReview(review({ rows: [reuse, checkout, none, skip], programs: [] }));
    const options = [...dialog()!.querySelectorAll('[role="option"]')].map(text);
    expect(options[0]).toContain("Reuse the existing Git folder");
    expect(options[1]).toContain(`Check out ${short(NEW)}`);
    expect(options[2]).toContain("No change");
    expect(options[3]).toContain("Skip");
  });

  test("a review without rows shows the plan.md text in place of the submodule list", async () => {
    await mountReview(review({ rows: [], programs: [] }));
    expect(text(dialog())).toContain("No submodules found.");
    expect(dialog()!.querySelectorAll('[role="listbox"]')).toHaveLength(0);
  });

  test("a nested row names its parent path only when the parent row exists", async () => {
    const parent = planRow({ path: "mid", url: "https://example.invalid/mid.git", action: "none", head: NEW });
    const leaf = planRow({ path: "mid/leaf", url: "https://example.invalid/leaf.git", action: "clone", depth: 1, parentRowId: parent.rowId });
    const orphan = planRow({ path: "x/y", url: "https://example.invalid/y.git", action: "clone", depth: 1, parentRowId: id() });
    await mountReview(review({ rows: [parent, leaf, orphan], programs: [] }));
    const options = [...dialog()!.querySelectorAll('[role="option"]')].map(text);
    expect(options[1]).toStartWith("mid/leaf, in mid");
    expect(options[2]).not.toContain(", in");
  });

  test(`a refusal disables Start update, which stays focusable with the refusal as its accessible description ${NEEDS}`, async () => {
    await mountReview(review({ refusals: [refusal("unsaved-commits", "libs/b", UNSAVED_TEXT, UNSAVED_COMMAND)] }));
    const start = button("Start update", dialog()!);
    expect(start.getAttribute("aria-disabled")).toBe("true");
    expect(start.hasAttribute("disabled")).toBe(false);
    expect(start.tabIndex).toBe(0);
    expect(describedText(start)).toContain(UNSAVED_TEXT);
    expect(text(dialog())).toContain(UNSAVED_TEXT);
  });

  test(`each refusal offers Copy command or Copy path, and the refusals keep the service order ${NEEDS}`, async () => {
    stubClipboard();
    const modeText = "Submodule libs/a uses the update mode merge. Arbareto updates only submodules that Git checks out. Use the command in a terminal.";
    const modeCommand = "& 'C:\\Git\\cmd\\git.exe' --no-lazy-fetch -C 'C:\\work\\super' submodule update --init --recursive -- 'libs/a'";
    await mountReview(
      review({
        refusals: [refusal("unsaved-commits", "libs/b", UNSAVED_TEXT, UNSAVED_COMMAND), refusal("folder-not-empty", "libs/a", NOT_EMPTY_TEXT, null), refusal("update-mode", "libs/a", modeText, modeCommand)],
      }),
    );
    const content = text(dialog());
    expect(content.indexOf(UNSAVED_TEXT)).toBeLessThan(content.indexOf(NOT_EMPTY_TEXT));
    expect(content.indexOf(NOT_EMPTY_TEXT)).toBeLessThan(content.indexOf(modeText));
    const commands = buttons("Copy command", dialog()!);
    expect(commands).toHaveLength(2);
    await click(commands[0]!);
    await click(button("Copy path", dialog()!));
    await click(commands[1]!);
    expect(written).toEqual([UNSAVED_COMMAND, "libs/a", modeCommand]);
    expect(button("Start update", dialog()!).getAttribute("aria-disabled")).toBe("true");
  });

  test(`initial focus is on the dialog heading, never on Start update ${NEEDS}`, async () => {
    await mountReview();
    const heading = dialog()!.querySelector<HTMLElement>("h1, h2, h3")!;
    expect(document.activeElement === heading).toBe(true);
    expect(document.activeElement === button("Start update", dialog()!)).toBe(false);
  });

  test(`the Tab stops are the submodule list, the program list, Cancel, and Start update, and the heading takes focus only from code ${NEEDS}`, async () => {
    await mountReview();
    const root = dialog()!;
    const heading = root.querySelector<HTMLElement>("h1, h2, h3")!;
    expect(heading.getAttribute("tabindex")).toBe("-1");
    const stops = [...root.querySelectorAll<HTMLElement>("button, [tabindex], input, textarea, select, a[href]")].filter((e) => e.tabIndex >= 0 && !e.hasAttribute("disabled"));
    const lists = [...root.querySelectorAll('[role="listbox"]')];
    const named = stops.map((e) => ["list:submodules", "list:programs"][lists.indexOf(e.closest('[role="listbox"]')!)] ?? text(e));
    expect(named).toEqual(["list:submodules", "list:programs", "Cancel", "Start update"]);
  });

  test(`Enter outside a button sends nothing, because the dialog has no default button ${NEEDS}`, async () => {
    const t = await mountReview();
    const root = dialog()!;
    for (const target of [root.querySelector<HTMLElement>("h1, h2, h3")!, root.querySelector<HTMLElement>('[role="listbox"]')!]) {
      await act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true })));
    }
    expect(t.of("updateSubmodules")).toHaveLength(0);
  });

  test(`Start update sends one updateSubmodules with the review token, and a second activation sends nothing ${NEEDS}`, async () => {
    const value = review();
    const t = await mountReview(value);
    const start = button("Start update", dialog()!);
    await click(start);
    await click(start);
    expect(t.of("updateSubmodules").map((c) => [c.target, c.payload])).toEqual([[TARGET, { submoduleReviewToken: value.submoduleReviewToken, start: true }]]);
  });

  test(`Start update closes the dialog at acceptance and moves focus to Cancel in the status bar ${NEEDS}`, async () => {
    const t = await mountReview();
    await click(button("Start update", dialog()!));
    await accepted(t.of("updateSubmodules")[0]!);
    await settle();
    expect(dialog()).toBeNull();
    expect(document.activeElement === document.querySelector('[data-double="status-cancel"]')).toBe(true);
    expect(t.operations.length).toBeGreaterThan(0);
  });

  test(`an expired token makes one new reviewSubmodules and keeps the dialog open; Start update then uses the new token ${NEEDS}`, async () => {
    const t = await mountReview();
    await click(button("Start update", dialog()!));
    await answer(t.of("updateSubmodules")[0]!, { state: "rejected", code: "APPROVAL_EXPIRED" });
    await settle();
    expect(dialog()).not.toBeNull();
    expect(t.of("reviewSubmodules").map((c) => [c.target, c.payload])).toEqual([[TARGET, { snapshotId: SNAPSHOT }]]);
    const fresh = review();
    await answer(t.of("reviewSubmodules")[0]!, { state: "succeeded", result: fresh });
    await settle();
    expect(t.of("reviewSubmodules")).toHaveLength(1);
    await click(button("Start update", dialog()!));
    expect(t.of("updateSubmodules")).toHaveLength(2);
    expect(t.of("updateSubmodules").at(-1)!.payload).toEqual({ submoduleReviewToken: fresh.submoduleReviewToken, start: true });
  });

  test("a failed new review after an expired token shows its code and keeps Start update disabled", async () => {
    const t = await mountReview();
    await click(button("Start update", dialog()!));
    await answer(t.of("updateSubmodules")[0]!, { state: "rejected", code: "APPROVAL_EXPIRED" });
    await settle();
    await answer(t.of("reviewSubmodules")[0]!, { state: "failed", code: "DEADLINE" });
    await settle();
    const text0 = "Submodule review did not complete: DEADLINE";
    expect(text(dialog())).toContain(text0);
    const start = button("Start update", dialog()!);
    expect(start.getAttribute("aria-disabled")).toBe("true");
    expect(describedText(start)).toContain(text0);
    await click(start);
    expect(t.of("updateSubmodules")).toHaveLength(1);
  });

  test("Escape and Cancel after Start update and before acceptance keep the dialog open", async () => {
    const t = await mountReview();
    await click(button("Start update", dialog()!));
    await click(button("Cancel", dialog()!));
    await act(async () => void dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })));
    await settle();
    expect(dialog()).not.toBeNull();
    await accepted(t.of("updateSubmodules")[0]!);
    await settle();
    expect(dialog()).toBeNull();
  });

  test("after a Cancel from the status bar, a canceled outcome keeps focus in the message field", async () => {
    const t = await mountReview();
    await click(button("Start update", dialog()!));
    const call = t.of("updateSubmodules")[0]!;
    await accepted(call);
    await settle();
    await click(button("Cancel", document.querySelector("footer")!));
    expect(t.statusCalls).toEqual(["cancel"]);
    const field = document.querySelector<HTMLTextAreaElement>('[data-double="message"]')!;
    await act(async () => field.focus());
    await answer(call, { state: "canceled", result: {} });
    await settle();
    expect(document.activeElement === field).toBe(true);
  });

  test("after a Cancel from the status bar, a canceled outcome moves focus to the area heading, not to the opener", async () => {
    const t = await mountReview();
    await click(button("Start update", dialog()!));
    const call = t.of("updateSubmodules")[0]!;
    await accepted(call);
    await settle();
    await click(button("Cancel", document.querySelector("footer")!));
    await answer(call, { state: "canceled", result: {} });
    await settle();
    expect(document.activeElement === area()?.querySelector("h2")).toBe(true);
  });

  test(`a canceled outcome after a declined Run confirmation returns focus to the opener ${NEEDS}`, async () => {
    const t = await mountReview();
    await click(button("Start update", dialog()!));
    const call = t.of("updateSubmodules")[0]!;
    await accepted(call);
    await answer(call, { state: "canceled", result: {} });
    await settle();
    expect(document.activeElement === t.opener()).toBe(true);
  });

  test(`without the opener, a canceled outcome moves focus to the control that finalFocus gives ${NEEDS}`, async () => {
    const t = await mountReview();
    await click(button("Start update", dialog()!));
    const call = t.of("updateSubmodules")[0]!;
    await accepted(call);
    t.opener().remove();
    const fallback = document.querySelector<HTMLElement>('[data-double="fallback"]')!;
    fallback.setAttribute("data-double", "opener");
    await answer(call, { state: "canceled", result: {} });
    await settle();
    expect(document.activeElement === fallback).toBe(true);
  });
});

// ---- Submodule copy of the status area (T236). ----
type Operation = NonNullable<Parameters<typeof OperationStatus>[0]["operation"]>;
const PLAN_ROWS = [CLONE_ROW, FETCH_ROW];
const updating = (fields: Record<string, unknown> = {}) => ({ requestId: id(), kind: "updateSubmodules", progress: null, response: null, submoduleRows: PLAN_ROWS, ...fields }) as unknown as Operation;
const step = (phase: "fetch" | "update", rowIndex: number, percent?: number) =>
  ({ requestId: id(), operationId: OPERATION_ID, state: "running", phase, path: ["libs/a", "libs/b"][rowIndex - 1], counters: { rowIndex, rowCount: 2, ...(percent === undefined ? {} : { percent }) }, stalled: false }) as never;
const ended = (op: Operation, state: string, result: Record<string, unknown>, code?: string) =>
  ({ ...op, response: { requestId: op.requestId, operationId: OPERATION_ID, state, ...(code === undefined ? {} : { code }), result } }) as Operation;
const result = (fields: Record<string, unknown>) => ({ rowId: id(), oldCommit: null, newCommit: null, fetched: false, connected: false, found: false, registered: false, ...fields });

function statusBridge() {
  const calls: string[] = [];
  const bridge = { cancel: () => (calls.push("cancel"), new Promise(() => {})), getOperation: () => (calls.push("getOperation"), new Promise(() => {})) };
  return { bridge: bridge as never, calls };
}

async function mountStatus(operation: Operation, modalOpen = false) {
  const double = statusBridge();
  let set!: (op: Operation) => void;
  function Harness() {
    const [op, setOp] = useState(operation);
    set = setOp;
    return (
      <>
        <textarea data-double="message" />
        <OperationStatus
          bridge={double.bridge}
          operation={op}
          worktreeRoot={ROOT}
          head={null}
          trusted={false}
          panel="details"
          modalOpen={modalOpen}
          refusal={null}
          onFocusMessageField={() => {}}
          onClearMessage={() => {}}
          onRefresh={() => {}}
        />
      </>
    );
  }
  await render(<Harness />);
  return { calls: double.calls, update: (op: Operation) => act(async () => set(op)) };
}
const area = () => document.querySelector<HTMLElement>('[data-slot="status-area"]');
const areaHeading = () => area()?.querySelector<HTMLElement>("h1, h2, h3, h4, h5, h6") ?? null;
const live = () => [...document.querySelectorAll('[role="status"]')].map(text).join(" | ");

describe("updating submodules", () => {
  test(`the fetch phase shows the fetch step text with <i> of <n>, the percentage outside the live text, and Cancel ${NEEDS}`, async () => {
    const op = updating();
    const view = await mountStatus(op);
    await view.update({ ...op, progress: step("fetch", 2, 40) });
    // The path comes from the contract §12 progress event.
    expect(live()).toContain("Fetching submodule libs/b (2 of 2)…");
    expect(live()).not.toContain("40%");
    expect(text(document.querySelector("footer") ?? document.body)).toContain("40%");
    expect(buttons("Cancel")).toHaveLength(1);
  });

  test(`the update phase shows the update step text ${NEEDS}`, async () => {
    const op = updating();
    const view = await mountStatus(op);
    await view.update({ ...op, progress: step("update", 1) });
    // The path comes from the contract §12 progress event.
    expect(live()).toContain("Updating submodule libs/a (1 of 2)…");
  });

  test(`the outcome lists each row with its plan.md state text and icon, in the status area and in no dialog ${NEEDS}`, async () => {
    const op = updating();
    const view = await mountStatus(op);
    const rows = [
      result({ path: "libs/a", state: "cloned", newCommit: NEW }),
      result({ path: "libs/b", state: "moved", oldCommit: OLD, newCommit: NEW }),
      result({ path: "libs/c", state: "unchanged", oldCommit: NEW, newCommit: NEW }),
      result({ path: "libs/d", state: "changed-elsewhere", newCommit: ELSEWHERE }),
    ];
    await view.update(ended(op, "succeeded", { rows }));
    const items = [...area()!.querySelectorAll("li")];
    expect(items.map(text)).toEqual([expect.stringContaining("libs/a"), expect.stringContaining("libs/b"), expect.stringContaining("libs/c"), expect.stringContaining("libs/d")]);
    expect(text(items[0])).toContain("Cloned");
    expect(text(items[1])).toContain(`Moved from ${short(OLD)} to ${short(NEW)}`);
    expect(text(items[2])).toContain("No change");
    expect(text(items[3])).toContain(`Changed elsewhere to ${short(ELSEWHERE)}`);
    expect(items.map((i) => i.querySelector("[data-icon]")?.getAttribute("data-icon") ?? null)).toEqual(["added", "added", null, "warning"]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  test(`failed, refused, and interrupted rows use their icons; the refusals keep the service order ${NEEDS}`, async () => {
    stubClipboard();
    const op = updating();
    const view = await mountStatus(op);
    const tail = "error: <b>refused</b> & stopped\n";
    const failCommand = "& 'C:\\Git\\cmd\\git.exe' --no-lazy-fetch -C 'C:\\work\\super' submodule update --init -- 'libs/a'";
    const interruptedText = "Git stopped while it cloned submodule libs/e. Move the folder libs/e out of the repository after all Git tools stop. Then use Update submodules again.";
    const modeText = "Submodule libs/c uses the update mode rebase. Arbareto updates only submodules that Git checks out. Use the command in a terminal.";
    const rows = [
      result({ path: "libs/a", state: "failed", outputTail: tail, remedy: { command: failCommand } }),
      result({ path: "libs/b", state: "refused", reason: "unsaved-commits", text: UNSAVED_TEXT, remedy: { command: UNSAVED_COMMAND } }),
      result({ path: "libs/c", state: "refused", reason: "update-mode", text: modeText }),
      result({ path: "libs/e", state: "clone-interrupted", text: interruptedText, folderPath: "C:\\work\\super\\libs\\e" }),
    ];
    await view.update(ended(op, "failed", { rows }, "GIT_FAILED"));
    const items = [...area()!.querySelectorAll("li")];
    expect(items.map((i) => i.querySelector("[data-icon]")?.getAttribute("data-icon"))).toEqual(["removed", "warning", "warning", "warning"]);
    expect(text(items[0])).toContain("Failed");
    // The output tail is plain text: its markup shows as characters.
    expect(text(items[0])).toContain("error: <b>refused</b> & stopped");
    expect(items[0]!.querySelector("b")).toBeNull();
    expect(text(items[1])).toContain("Refused");
    expect(text(items[1])).toContain(UNSAVED_TEXT);
    expect(text(items[2])).toContain(modeText);
    expect(text(items[3])).toContain("Clone interrupted");
    expect(text(items[3])).toContain(interruptedText);
    expect(text(items[3])).toContain("C:\\work\\super\\libs\\e");
    await click(button("Copy command", items[0]!));
    await click(button("Copy command", items[1]!));
    expect(buttons("Copy command", items[2]!)).toHaveLength(0);
    await click(button("Copy path", items[3]!));
    expect(written).toEqual([failCommand, UNSAVED_COMMAND, "C:\\work\\super\\libs\\e"]);
  });

  test(`the flags add their plan.md sentences, and a failed read adds its sentence without Copy command ${NEEDS}`, async () => {
    const op = updating();
    const view = await mountStatus(op);
    const rows = [
      result({ path: "libs/a", state: "cloned", newCommit: NEW, fetched: true, found: true }),
      result({ path: "libs/b", state: "unchanged", oldCommit: NEW, newCommit: NEW, connected: true, registered: true }),
      result({ path: "libs/c", state: "failed", failedRead: "check" }),
    ];
    await view.update(ended(op, "failed-with-effects", { rows }, "GIT_FAILED"));
    const items = [...area()!.querySelectorAll("li")];
    expect(text(items[0])).toContain(FLAGS.fetched);
    expect(text(items[0])).toContain(FLAGS.found);
    expect(text(items[1])).toContain(FLAGS.connected);
    expect(text(items[1])).toContain(FLAGS.registered);
    expect(text(items[2])).toContain(FLAGS.failedRead);
    expect(buttons("Copy command", items[2]!)).toHaveLength(0);
  });

  test("a changed-elsewhere row without a new commit reads Changed elsewhere, and each row reads <path>: <state>", async () => {
    const op = updating();
    const view = await mountStatus(op);
    await view.update(ended(op, "completed-with-effects", { rows: [result({ path: "libs/d", state: "changed-elsewhere" }), result({ path: "libs/a", state: "cloned", newCommit: NEW })] }));
    const items = [...area()!.querySelectorAll("li")].map(text);
    expect(items[0]).toBe("libs/d: Changed elsewhere");
    expect(items[1]).toBe("libs/a: Cloned");
  });

  test(`an inactivity deadline shows the plan.md inactivity text in the status area ${NEEDS}`, async () => {
    const op = updating();
    const view = await mountStatus(op);
    await view.update(ended(op, "failed", { reason: "inactivity", rows: [result({ path: "libs/a", state: "failed" })] }, "DEADLINE"));
    expect(text(area())).toContain(INACTIVITY);
  });

  test(`at the outcome, focus moves to the area heading ${NEEDS}`, async () => {
    const op = updating();
    const view = await mountStatus(op);
    await act(async () => buttons("Cancel")[0]?.focus());
    await view.update(ended(op, "succeeded", { rows: [result({ path: "libs/a", state: "cloned", newCommit: NEW })] }));
    await settle();
    expect(text(areaHeading())).toBe("Update submodules details");
    expect(document.activeElement === areaHeading()).toBe(true);
  });

  test("with focus in the message field, focus stays there at the outcome", async () => {
    const op = updating();
    const view = await mountStatus(op);
    const field = document.querySelector<HTMLTextAreaElement>('[data-double="message"]')!;
    await act(async () => field.focus());
    await view.update(ended(op, "succeeded", { rows: [result({ path: "libs/a", state: "cloned", newCommit: NEW })] }));
    await settle();
    expect(document.activeElement === field).toBe(true);
    expect(area()).not.toBeNull();
  });

  test(`with a dialog open, focus stays in the dialog, and the outcome waits in the status area ${NEEDS}`, async () => {
    const op = updating();
    const view = await mountStatus(op, true);
    const other = document.body.appendChild(document.createElement("div"));
    other.setAttribute("role", "dialog");
    const inside = other.appendChild(document.createElement("button"));
    try {
      await act(async () => inside.focus());
      await view.update(ended(op, "succeeded", { rows: [result({ path: "libs/a", state: "cloned", newCommit: NEW })] }));
      await settle();
      expect(document.activeElement === inside).toBe(true);
      expect(text(area())).toContain("libs/a");
    } finally {
      other.remove();
    }
  });
});
