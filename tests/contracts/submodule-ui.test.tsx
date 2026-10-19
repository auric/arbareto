// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T234: the submodule notice and the submodule copy of the status area. Feature 004 T073 removed the review dialog. `workbench-submodules.test.tsx` covers the Submodules group.
// plan.md "Notice band", "Required visible states" (Submodule notice, Updating submodules), and "Status area". Contract §12 "Progress" and "Reconciliation and outcome".
//
// - `SubmoduleNotice` ({ count, onUpdate }): the submodule row of the notice band.
// - `OperationStatus`: a `StatusOperation` of kind `updateSubmodules` carries `submoduleRows`, the plan rows of its review.
//   Each outcome row icon carries `data-icon` "added", "warning", or "removed".
// The stall notice of a submodule step is a T257 case in `stall-notice.test.tsx`.

import { afterEach, describe, expect, test } from "bun:test";
import { act, useState, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { contractChecked } from "./bridge-contract";

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

// ---- Texts (plan.md "Required visible states" and contract §12). ----
const NOTICE = (n: number) => `Some submodules are not initialized or not at their recorded commit. Count: ${n}.`;
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
const UNSAVED_TEXT = "Submodule libs/b is at commit 111111111111, which the update can leave without a branch, tag, or other ref. Save it with the command, then use Refresh.";
const UNSAVED_COMMAND = `& 'C:\\Git\\cmd\\git.exe' --no-lazy-fetch -C 'C:\\work\\super\\libs\\b' --git-dir=.git branch 'arbareto-saved-111111111111' '${OLD}'`;

// ---- DOM helpers. ----
const text = (element: Element | null | undefined) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();
const buttons = (label: string, root: ParentNode = document) => [...root.querySelectorAll("button")].filter((b) => text(b) === label);
const button = (label: string, root: ParentNode = document) => {
  const found = buttons(label, root);
  expect(found).toHaveLength(1);
  return found[0]!;
};
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

  test("B4-2: a blocking workbench state disables Update submodules, which stays focusable with the visible reason as its accessible description", async () => {
    const { SubmoduleNotice } = await submoduleNotice();
    const updates: number[] = [];
    const reason = "A Git operation is running. Wait for its result, or select Cancel.";
    await render(<SubmoduleNotice count={2} onUpdate={() => void updates.push(1)} blockedReason={reason} />);
    const update = button("Update submodules");
    expect(update.getAttribute("aria-disabled")).toBe("true");
    expect(update.tabIndex).toBe(0);
    expect(describedText(update)).toBe(reason);
    expect(text(document.body)).toContain(reason);
    await click(update);
    expect(updates).toEqual([]);
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
  return { bridge: contractChecked(bridge) as never, calls };
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

  test("B4-3: the status region handle gives Cancel by its element while the operation runs, and null after the outcome", async () => {
    const handle: { current: { cancel(): HTMLElement | null } | null } = { current: null };
    const double = statusBridge();
    const op = updating();
    const props = { bridge: double.bridge, worktreeRoot: ROOT, head: null, trusted: false, panel: "details" as const, modalOpen: false, refusal: null, onFocusMessageField() {}, onClearMessage() {}, onRefresh() {} };
    let set!: (op: Operation) => void;
    function Harness() {
      const [current, setCurrent] = useState(op);
      set = setCurrent;
      return <OperationStatus ref={handle as never} operation={current} {...props} />;
    }
    await render(<Harness />);
    expect(handle.current!.cancel()).toBe(button("Cancel", document.querySelector("footer")!));
    await act(async () => set(ended(op, "succeeded", { rows: [] })));
    expect(handle.current!.cancel()).toBeNull();
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
