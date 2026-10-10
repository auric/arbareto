// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T260: the status area of `src/frontend/status/OperationStatus.tsx` (plan.md "Status area", "Keyboard and focus", "Required visible states", and the Confirm row of "Task flow and command placement").

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { act, createRef, useState, type Dispatch, type SetStateAction } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";

const MODULE = printOrigin("../../src/frontend/status/OperationStatus.tsx", import.meta.dir);
registerDom();
const { renderToStaticMarkup } = await import("react-dom/server");
const { createRoot } = await import("react-dom/client");
const { OperationStatus, outcomeFocus } = await import("../../src/frontend/status/OperationStatus");
type Props = Parameters<typeof OperationStatus>[0];
type Operation = NonNullable<Props["operation"]>;
type Handle = { entry(): HTMLElement | null };

// plan.md "Status area", "Long text", and "Required visible states" (Succeeded, Busy); contract §6 "Activity and stall notice"; contract §9; research.md R4.
const COMMITTED = "Committed 0123456789ab to main";
const OID = "0123456789abcdef0123456789abcdef01234567";
const lingering = (n: number) => (n === 1 ? "1 process that Git or a hook started still runs." : `${n} processes that Git or a hook started still run.`) + " Closing Arbareto ends them.";
const REVOKE = "Revoke trust also ends them.";
const STALL_SENTENCE = "Git may be waiting for input.";
const STALL_NOTICE = "Git may be waiting for a prompt that Arbareto cannot show, or for a sign-in window. To answer a hidden prompt, select Cancel and run this command in a terminal.";
const STALL_REMEDY = { command: "& 'C:\\Git\\cmd\\git.exe' --no-lazy-fetch -C 'C:\\repo' hook run --ignore-missing pre-commit", text: "This command runs only the pre-commit hook and does not commit. It cannot repeat a prompt from another hook or from signing." };
const HOOK_REMEDY = { command: "& 'C:\\Git\\cmd\\git.exe' --no-lazy-fetch -C 'C:\\repo' hook run --ignore-missing pre-commit", text: "This command runs the pre-commit hook in a terminal and does not commit. Other hooks show their output only here. Arbareto keeps your message." };
const SUGGESTED = `Git created commit ${OID}. Repository state changed during execution. Review the resulting commit and staged changes.`;
const TAIL = "pre-commit: <b>refused</b> & stopped\nline 2\n";
const REFUSAL = "Stage file is unavailable: the file has a conflict";
const HEAD = { state: "branch", target: "refs/heads/main", oid: OID } as const;
// The text gaps that tasks.md:616 needs and plan.md does not define.
const GAP = "(text gap, plan.md:747 and plan.md:754 to plan.md:757)";

const id = () => crypto.randomUUID();
const running = (fields: Partial<Operation> = {}): Operation => ({ requestId: id(), kind: "commit", progress: null, response: null, ...fields }) as Operation;
const progress = (op: Operation, fields: Record<string, unknown> = {}) => ({ requestId: op.requestId, operationId: OPERATION_ID, state: "running", counters: {}, ...fields }) as never;
const respond = (op: Operation, state: string, result: Record<string, unknown> = {}, code?: string): Operation =>
  ({ ...op, response: { requestId: op.requestId, operationId: OPERATION_ID, state, ...(code === undefined ? {} : { code }), result } }) as Operation;
const OPERATION_ID = "6f9619ff-8b86-4011-b42d-00cf4fc964ff";

function bridgeDouble(stallRemedy: unknown = STALL_REMEDY) {
  const calls: { name: string; payload: unknown }[] = [];
  const bridge = {
    cancel: (payload: unknown) => (calls.push({ name: "cancel", payload }), new Promise(() => {})),
    getOperation: (payload: unknown) => (
      calls.push({ name: "getOperation", payload }),
      Promise.resolve({ requestId: id(), state: "succeeded", result: { operationId: OPERATION_ID, operation: "commit", state: "running", stalled: true, stallRemedy } })
    ),
  };
  return { bridge: bridge as never, calls };
}

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});

type Fields = Omit<Props, "bridge" | "onFocusMessageField" | "onClearMessage" | "onRefresh" | "ref">;
const BASE: Fields = { operation: null, head: HEAD, trusted: false, mode: "history", modalOpen: false, refusal: null };

async function mount(fields: Partial<Fields> = {}, stallRemedy?: unknown) {
  const double = bridgeDouble(stallRemedy);
  const handle = createRef<Handle>();
  const cleared: number[] = [];
  let set!: Dispatch<SetStateAction<Fields>>;
  function Harness() {
    const [props, setProps] = useState<Fields>({ ...BASE, ...fields });
    set = setProps;
    return (
      <>
        <button type="button" data-double="history-row">
          History row
        </button>
        <textarea data-double="message" />
        <div role="dialog" data-double="dialog">
          <button type="button">Dialog button</button>
        </div>
        <OperationStatus
          {...props}
          ref={handle}
          bridge={double.bridge}
          onFocusMessageField={() => document.querySelector<HTMLTextAreaElement>('[data-double="message"]')!.focus()}
          onClearMessage={() => void cleared.push(1)}
          onRefresh={() => {}}
        />
      </>
    );
  }
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(<Harness />));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return {
    calls: double.calls,
    handle,
    cleared,
    update: (next: Partial<Fields>) => act(async () => set((p) => ({ ...p, ...next }))),
  };
}

const text = (element: Element | null | undefined) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();
const buttons = (label: string) => [...document.querySelectorAll("button")].filter((b) => text(b) === label);
const button = (label: string) => {
  const found = buttons(label);
  expect(found).toHaveLength(1);
  return found[0]!;
};
const area = () => document.querySelector('[data-slot="status-area"]');
const areaHeading = () => area()?.querySelector("h1, h2, h3, h4, h5, h6") ?? null;
const live = () => [...document.querySelectorAll('[role="status"]')];
const toggle = () => [...buttons("Show details"), ...buttons("Hide details")].filter((b) => !area()?.contains(b));
const double = (name: string) => document.querySelector<HTMLElement>(`[data-double="${name}"]`)!;
const focus = (element: HTMLElement) => act(async () => element.focus());
const click = (element: HTMLElement) => act(async () => element.click());
async function press(target: Element, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key, code: key, bubbles: true, cancelable: true }));
  });
}
const settle = () => act(async () => await new Promise((resolve) => setImmediate(resolve)));
// The elements that Tab reaches, in document order.
const tabStops = (from: Element) => [...from.querySelectorAll<HTMLElement>("button, [tabindex], textarea, input, a[href]")].filter((e) => e.tabIndex >= 0 && !e.hasAttribute("disabled"));

// A commit that ends with `lingeringDescendants` 2 while focus is on a History row.
async function lingeringOutcome(fields: Partial<Fields> = {}) {
  const op = running();
  const view = await mount({ operation: op, ...fields });
  await focus(double("history-row"));
  await view.update({ operation: respond(op, "succeeded", { commitOid: OID, lingeringDescendants: 2 }) });
  return view;
}

describe("lingering sentence and the details toggle", () => {
  test("a commit outcome with a nonzero lingering count opens the area and moves no focus; the live text holds the whole sentence, and the area repeats it", async () => {
    await lingeringOutcome();
    expect(document.activeElement).toBe(double("history-row"));
    const sentence = `${COMMITTED}. ${lingering(2)}`;
    expect(text(live()[0])).toBe(sentence);
    expect(text(areaHeading())).toBe("Commit details");
    expect(text(area())).toContain(sentence);
  });

  test("a count of 1 takes the singular, and a current trust ID adds the Revoke trust sentence", async () => {
    const op = running();
    const view = await mount({ operation: op, trusted: true });
    await view.update({ operation: respond(op, "succeeded", { commitOid: OID, lingeringDescendants: 1 }) });
    expect(text(live()[0])).toBe(`${COMMITTED}. 1 process that Git or a hook started still runs. Closing Arbareto ends them. ${REVOKE}`);
  });

  test("the toggle reads Hide details or Show details, carries aria-expanded, and its activation collapses and reopens the area", async () => {
    await lingeringOutcome();
    expect(toggle()).toHaveLength(1);
    expect(text(toggle()[0])).toBe("Hide details");
    expect(toggle()[0]!.getAttribute("aria-expanded")).toBe("true");
    await click(toggle()[0]!);
    expect(area()).toBeNull();
    expect(text(toggle()[0])).toBe("Show details");
    expect(toggle()[0]!.getAttribute("aria-expanded")).toBe("false");
    await click(toggle()[0]!);
    expect(text(areaHeading())).toBe("Commit details");
    expect(toggle()[0]!.getAttribute("aria-expanded")).toBe("true");
  });

  test("the area heading holds a second Hide details button", async () => {
    await lingeringOutcome();
    const inside = [...area()!.querySelectorAll("button")].filter((b) => text(b) === "Hide details");
    expect(inside).toHaveLength(1);
    await click(inside[0]!);
    expect(area()).toBeNull();
  });

  test("Escape inside the area collapses it and moves focus to the toggle", async () => {
    await lingeringOutcome();
    const region = tabStops(area()!)[0]!;
    await focus(region);
    await press(region, "Escape");
    expect(area()).toBeNull();
    expect(document.activeElement).toBe(toggle()[0]!);
  });

  test("the content region is one Tab stop, and its Copy buttons follow it; Hide details comes last", async () => {
    const op = running();
    const view = await mount({ operation: op });
    await view.update({ operation: respond(op, "failed", { outputTail: TAIL, remedy: HOOK_REMEDY, foreign: ["C:\\repo\\.git\\HEAD.lock"], lingeringDescendants: 0 }, "GIT_FAILED") });
    const stops = tabStops(area()!);
    const region = stops[0]!;
    expect(region.tagName).not.toBe("BUTTON");
    expect(region.tabIndex).toBe(0);
    expect(tabStops(region)).toHaveLength(0);
    expect(region.textContent).toContain("pre-commit:");
    expect(stops.slice(1).map(text)).toEqual(["Copy command", "Copy path", "Hide details"]);
  });

  test("a new operation clears the area and removes the toggle", async () => {
    const view = await lingeringOutcome();
    expect(area()).not.toBeNull();
    await view.update({ operation: running({ kind: "applyHunk", direction: "stage" }) });
    expect(area()).toBeNull();
    expect(toggle()).toHaveLength(0);
  });

  test("another repository clears the area and the outcome text", async () => {
    const view = await lingeringOutcome();
    await view.update({ operation: null });
    expect(area()).toBeNull();
    expect(toggle()).toHaveLength(0);
    expect(text(live()[0])).toBe("");
  });

  test("no timer collapses or clears the area", async () => {
    const source = readFileSync(MODULE, "utf8");
    expect(source).not.toMatch(/\b(setTimeout|setInterval|requestAnimationFrame|requestIdleCallback)\b/);
    await lingeringOutcome();
    await settle();
    await settle();
    expect(text(areaHeading())).toBe("Commit details");
  });

  test("a truncated status text shows the toggle", async () => {
    const prototype = HTMLElement.prototype as unknown as Record<string, unknown>;
    const saved = ["scrollWidth", "clientWidth"].map((key) => [key, Object.getOwnPropertyDescriptor(prototype, key)] as const);
    Object.defineProperty(prototype, "scrollWidth", { configurable: true, get: () => 900 });
    Object.defineProperty(prototype, "clientWidth", { configurable: true, get: () => 300 });
    try {
      const op = running();
      const view = await mount({ operation: op });
      await view.update({ operation: respond(op, "succeeded", { commitOid: OID, lingeringDescendants: 0 }) });
      expect(toggle()).toHaveLength(1);
      expect(text(toggle()[0])).toBe("Show details");
      await click(toggle()[0]!);
      expect(text(area())).toContain(COMMITTED);
    } finally {
      for (const [key, descriptor] of saved) {
        if (descriptor === undefined) delete prototype[key];
        else Object.defineProperty(prototype, key, descriptor);
      }
    }
  });

  test("a short outcome without details shows no toggle", async () => {
    const op = running();
    const view = await mount({ operation: op });
    await view.update({ operation: respond(op, "succeeded", { commitOid: OID, lingeringDescendants: 0 }) });
    expect(text(live()[0])).toBe(COMMITTED);
    expect(toggle()).toHaveLength(0);
  });
});

describe("stall notice", () => {
  async function stalled(stallRemedy?: unknown) {
    const op = running();
    const view = await mount({ operation: op }, stallRemedy);
    await view.update({ operation: { ...op, progress: progress(op, { stalled: true }) } });
    await settle();
    return { ...view, op };
  }
  const activity = (view: Awaited<ReturnType<typeof stalled>>) => view.update({ operation: { ...view.op, progress: progress(view.op, { stalled: false }) } });

  test("a stall opens the area with the notice, the stallRemedy command, its text, and Copy command; one getOperation call", async () => {
    const view = await stalled();
    await view.update({ operation: { ...view.op, progress: progress(view.op, { stalled: true, counters: { bytes: 1 } }) } });
    await settle();
    expect(view.calls.filter((c) => c.name === "getOperation")).toEqual([{ name: "getOperation", payload: { operationId: OPERATION_ID } }]);
    expect(text(live()[0])).toContain(STALL_SENTENCE);
    expect(text(areaHeading())).toBe("Commit details");
    const content = text(area());
    for (const part of [STALL_NOTICE, STALL_REMEDY.command, STALL_REMEDY.text]) expect(content).toContain(part);
    expect(buttons("Copy command")).toHaveLength(1);
    expect(area()!.querySelector("svg")).not.toBeNull();
    expect(buttons("Cancel")).toHaveLength(1);
  });

  test("without a command, only the texts show", async () => {
    await stalled({ text: STALL_REMEDY.text });
    expect(text(area())).toContain(STALL_REMEDY.text);
    expect(buttons("Copy command")).toHaveLength(0);
  });

  test("an area that opened only for a stall notice collapses when the notice hides", async () => {
    const view = await stalled();
    await activity(view);
    expect(text(live()[0])).not.toContain(STALL_SENTENCE);
    expect(area()).toBeNull();
    expect(toggle()).toHaveLength(0);
  });

  test("with focus inside the area, the area stays open when the notice hides", async () => {
    const view = await stalled();
    await focus(tabStops(area()!)[0]!);
    await activity(view);
    expect(text(area())).not.toContain(STALL_NOTICE);
    expect(text(areaHeading())).toBe("Commit details");
  });

  test("a notice whose Copy command holds focus stays after the next activity, and hides when focus leaves it, with no focus lost", async () => {
    const view = await stalled();
    const copy = button("Copy command");
    await focus(copy);
    await activity(view);
    expect(text(live()[0])).not.toContain(STALL_SENTENCE);
    expect(text(area())).toContain(STALL_NOTICE);
    expect(document.activeElement).toBe(copy);
    await focus(double("history-row"));
    expect(document.activeElement).toBe(double("history-row"));
    expect(area()).toBeNull();
  });
});

describe("F6 entry into the status region", () => {
  test("the first entry after the area opens targets the area heading; then the last Copy button that had focus", async () => {
    const op = running();
    const view = await mount({ operation: op });
    await view.update({ operation: respond(op, "failed", { outputTail: TAIL, remedy: HOOK_REMEDY, lingeringDescendants: 0 }, "HOOK_FAILED") });
    expect(view.handle.current!.entry()).toBe(areaHeading() as HTMLElement);
    const copy = button("Copy command");
    await focus(copy);
    await focus(double("history-row"));
    expect(view.handle.current!.entry()).toBe(copy);
  });

  test("with the area collapsed, the first entry targets the first status bar control", async () => {
    const view = await lingeringOutcome();
    await click(toggle()[0]!);
    await focus(double("history-row"));
    expect(view.handle.current!.entry()).toBe(toggle()[0]!);
  });

  test("while a commit runs, Cancel in the status bar is the focus target", async () => {
    const view = await mount({ operation: running() });
    expect(view.handle.current!.entry()).toBe(button("Cancel"));
  });

  test("a status region without text, toggle, and Cancel offers no F6 target", async () => {
    const view = await mount();
    expect(view.handle.current!.entry()).toBeNull();
  });
});

// plan.md "Status area", live text rules: an added node or a changed text inside a live element, between two consecutive states. A removed node is no change.
describe("live-node counts", () => {
  type Leaf = { path: string; text: string | null };
  // The nodes of each live element. A text node is a leaf with its text; an element is a leaf without text.
  function liveTrees(html: string): Leaf[][] {
    const host = document.createElement("div");
    host.innerHTML = html;
    const walk = (node: Node, path: string, out: Leaf[]) => {
      [...node.childNodes].forEach((child, i) => {
        const at = `${path}/${i}:${child.nodeName}`;
        out.push({ path: at, text: child.nodeType === 3 ? child.textContent : null });
        walk(child, at, out);
      });
    };
    return [...host.querySelectorAll('[role="status"]')].map((element) => {
      const out: Leaf[] = [];
      walk(element, "", out);
      return out;
    });
  }
  // Counts changes per live element. Nodes under an added node count once, with that node.
  function changes(before: string, after: string): number[] {
    const [a, b] = [liveTrees(before), liveTrees(after)];
    expect(b.length).toBe(a.length);
    return b.map((leaves, i) => {
      const old = new Map(a[i]!.map((l) => [l.path, l.text]));
      const added = leaves.filter((l) => !old.has(l.path)).map((l) => l.path);
      const roots = added.filter((p) => !added.some((q) => q !== p && p.startsWith(`${q}/`)));
      const changed = leaves.filter((l) => old.has(l.path) && l.text !== null && old.get(l.path) !== l.text);
      return roots.length + changed.length;
    });
  }
  const html = (fields: Partial<Fields>) => renderToStaticMarkup(<OperationStatus {...BASE} {...fields} bridge={bridgeDouble().bridge} onFocusMessageField={() => {}} onClearMessage={() => {}} onRefresh={() => {}} />);
  const visible = (markup: string) => {
    const host = document.createElement("div");
    host.innerHTML = markup;
    return host;
  };

  // T236 adds the step text "Fetching submodule <path> (<i> of <n>)…" and "Updating submodule <path> (<i> of <n>)…".
  test("a submodule step with five percentage events gives no change, and the visible text shows each <p>% outside every live element", () => {
    const op = running({ kind: "updateSubmodules" });
    const step = (percent?: number) => html({ operation: { ...op, progress: progress(op, { phase: "update", stalled: false, counters: { rowIndex: 1, rowCount: 2, ...(percent === undefined ? {} : { percent }) } }) } });
    const states = [step(), ...[10, 30, 50, 70, 90].map((p) => step(p))];
    for (let i = 1; i < states.length; i++) {
      expect(changes(states[i - 1]!, states[i]!)).toEqual([0, 0]);
      const shown = visible(states[i]!);
      const percent = `${[10, 30, 50, 70, 90][i - 1]}%`;
      expect(text(shown)).toContain(percent);
      expect([...shown.querySelectorAll('[role="status"]')].some((s) => text(s).includes(percent))).toBe(false);
    }
  });

  test.todo("a new submodule step gives one change, and the step text shows (needs T236)", () => {});

  test("a requested cancel keeps the label Cancel requested and Cancel until the outcome", () => {
    const op = running();
    const shown = visible(html({ operation: { ...op, progress: progress(op, { state: "cancel-requested" }) } }));
    expect(text(shown.querySelector('[role="status"]'))).toBe("Cancel requested");
    expect([...shown.querySelectorAll("button")].map(text)).toContain("Cancel");
  });

  test("the stall sentence gives one change, and its removal gives none", () => {
    const op = running();
    const at = (stalled: boolean) => html({ operation: { ...op, progress: progress(op, { stalled }) } });
    expect(changes(at(false), at(true))).toEqual([1, 0]);
    expect(text(visible(at(true)).querySelector('[role="status"]'))).toBe(STALL_SENTENCE);
    expect(changes(at(true), at(false))).toEqual([0, 0]);
  });

  test("a Space refusal changes only the second live element, once; its clearing changes none, and the outcome text shows again", () => {
    const op = respond(running({ kind: "applyHunk", direction: "stage" }), "succeeded", { lingeringDescendants: 0 });
    const outcome = html({ operation: op });
    const refused = html({ operation: op, refusal: REFUSAL });
    expect(changes(outcome, refused)).toEqual([0, 1]);
    const [first, second] = [...visible(refused).querySelectorAll('[role="status"]')];
    expect(text(first)).toBe("Hunk staged");
    // Hidden from view only: it stays in the accessibility tree.
    expect(first!.hasAttribute("hidden")).toBe(false);
    expect(first!.getAttribute("aria-hidden")).toBeNull();
    expect(first!.getAttribute("class")?.split(/\s+/)).toContain("sr-only");
    expect(text(second)).toBe(REFUSAL);
    expect(changes(refused, outcome)).toEqual([0, 0]);
    expect(visible(outcome).querySelector('[role="status"]')!.getAttribute("class")?.split(/\s+/)).not.toContain("sr-only");
  });

  test("the hunk and file outcomes read Hunk staged, Hunk unstaged, File staged, and File unstaged", () => {
    for (const [kind, direction, expected] of [
      ["applyHunk", "stage", "Hunk staged"],
      ["applyHunk", "unstage", "Hunk unstaged"],
      ["applyFile", "stage", "File staged"],
      ["applyFile", "unstage", "File unstaged"],
    ] as const) {
      const op = respond(running({ kind, direction }), "succeeded", { lingeringDescendants: 0 });
      expect(text(visible(html({ operation: op })).querySelector('[role="status"]'))).toBe(expected);
    }
  });

  test("a detached HEAD reads Committed <short ID> on detached HEAD", () => {
    const op = respond(running(), "succeeded", { commitOid: OID, lingeringDescendants: 0 });
    expect(text(visible(html({ operation: op, head: { state: "detached", oid: OID } })).querySelector('[role="status"]'))).toBe("Committed 0123456789ab on detached HEAD");
  });

  test("an unknown outcome shows State unknown and Refresh", () => {
    const op = respond(running(), "unknown", { lingeringDescendants: 0 }, "STATE_UNKNOWN");
    const shown = visible(html({ operation: op }));
    expect(text(shown.querySelector('[role="status"]'))).toBe("State unknown");
    expect([...shown.querySelectorAll("button")].map(text)).toContain("Refresh");
  });

  test.todo(`an operation start shows the operation and the repository ${GAP}`, () => {});
  test.todo(`Canceled, failed, completed-with-effects, and failed-with-effects outcomes show their outcome sentence ${GAP}`, () => {});
});

describe("commit outcomes in the area", () => {
  for (const code of ["HOOK_FAILED", "GIT_FAILED"]) {
    test(`a ${code} result opens the area with the output tail as plain text and the remedy with Copy command`, async () => {
      const op = running();
      const view = await mount({ operation: op });
      await focus(double("history-row"));
      await view.update({ operation: respond(op, "failed", { outputTail: TAIL, remedy: HOOK_REMEDY, lingeringDescendants: 0 }, code) });
      expect(text(areaHeading())).toBe("Commit details");
      expect(area()!.querySelector("b")).toBeNull();
      expect(area()!.textContent).toContain(TAIL.trimEnd());
      expect(text(area())).toContain(HOOK_REMEDY.text);
      expect(text(area())).toContain(HOOK_REMEDY.command);
      expect(buttons("Copy command")).toHaveLength(1);
      expect(document.activeElement).toBe(double("history-row"));
    });
  }

  test("a Git-reported lock failure shows each observed lock path with Copy path", async () => {
    const op = running();
    const view = await mount({ operation: op });
    const locks = ["C:\\repo\\.git\\HEAD.lock", "C:\\repo\\.git\\refs\\heads\\main.lock"];
    await view.update({ operation: respond(op, "failed", { outputTail: TAIL, remedy: { text: "Git could not take a lock." }, foreign: locks, lingeringDescendants: 1 }, "GIT_FAILED") });
    for (const lock of locks) expect(text(area())).toContain(lock);
    expect(buttons("Copy path")).toHaveLength(2);
    expect(text(live()[0])).toContain(lingering(1));
  });

  test("a completed-with-effects result opens the area with the commit ID, the suggested message, and Clear message", async () => {
    const op = running();
    const view = await mount({ operation: op });
    await view.update({ operation: respond(op, "completed-with-effects", { commitOid: OID, effects: { head: true, index: true, workingFiles: false, operationState: false }, lingeringDescendants: 0 }) });
    expect(text(areaHeading())).toBe("Commit details");
    expect(text(area())).toContain(SUGGESTED);
    await click(button("Clear message"));
    expect(view.cleared).toHaveLength(1);
  });

  test.todo("a completed-with-effects result shows the observed difference (text gap, plan.md:751 and data-model.md:244)", () => {});
});

describe("focus at the commit outcome (Confirm row)", () => {
  const OUTCOMES: [string, string | undefined, Record<string, unknown>][] = [
    ["succeeded", undefined, { commitOid: OID }],
    ["canceled", "CANCELED", {}],
    ["completed-with-effects", undefined, { commitOid: OID, effects: { head: true, index: false, workingFiles: false, operationState: false } }],
    ["failed-with-effects", "GIT_FAILED", { outputTail: TAIL }],
    ["unknown", "STATE_UNKNOWN", { outputTail: TAIL }],
    ["failed", "HOOK_FAILED", { outputTail: TAIL, remedy: HOOK_REMEDY }],
    ["failed", "GIT_FAILED", { outputTail: TAIL, remedy: HOOK_REMEDY }],
    ["failed", "SIGNING_FAILED", { outputTail: TAIL }],
    ["failed", "DEADLINE", { outputTail: TAIL }],
    ["failed", "STALE_REVIEW", {}],
    ["rejected", "BUSY", {}],
    ["rejected", "STATE_UNKNOWN", {}],
  ];

  test("the decision: Changes gives the message field, History with focus on Cancel gives the area heading, and a dialog keeps focus", () => {
    expect(outcomeFocus("changes", false, true)).toBe("message-field");
    expect(outcomeFocus("changes", false, false)).toBe("message-field");
    expect(outcomeFocus("history", false, true)).toBe("area-heading");
    expect(outcomeFocus("history", false, false)).toBe("stay");
    for (const mode of ["changes", "history"] as const) for (const cancel of [true, false]) expect(outcomeFocus(mode, true, cancel)).toBe("stay");
  });

  for (const [state, code, result] of OUTCOMES) {
    const name = `${state}${code === undefined ? "" : ` ${code}`}`;
    test(`${name}: from Cancel, Changes focuses the message field, and History opens the area and focuses its heading`, async () => {
      for (const mode of ["changes", "history"] as const) {
        const op = running();
        const view = await mount({ operation: op, mode });
        await focus(button("Cancel"));
        await view.update({ operation: respond(op, state, { ...result, lingeringDescendants: 0 }, code) });
        if (mode === "changes") expect(document.activeElement).toBe(double("message"));
        else {
          expect(text(areaHeading())).toBe("Commit details");
          expect(document.activeElement).toBe(areaHeading() as HTMLElement);
        }
        await unmounts.pop()!();
      }
    });

    test(`${name}: focus in an open dialog stays there in both modes`, async () => {
      for (const mode of ["changes", "history"] as const) {
        const op = running();
        const view = await mount({ operation: op, mode, modalOpen: true });
        const inside = double("dialog").querySelector("button")!;
        await focus(inside);
        await view.update({ operation: respond(op, state, { ...result, lingeringDescendants: 0 }, code) });
        expect(document.activeElement).toBe(inside);
        await unmounts.pop()!();
      }
    });
  }

  test("with focus on a History row, a HOOK_FAILED result keeps that focus, and the area opens", async () => {
    const op = running();
    const view = await mount({ operation: op, mode: "history" });
    await focus(double("history-row"));
    await view.update({ operation: respond(op, "failed", { outputTail: TAIL, remedy: HOOK_REMEDY, lingeringDescendants: 0 }, "HOOK_FAILED") });
    expect(document.activeElement).toBe(double("history-row"));
    expect(text(areaHeading())).toBe("Commit details");
  });
});

describe("Cancel", () => {
  test("Cancel sends one cancel with the operation ID of the progress events", async () => {
    const op = running();
    const view = await mount({ operation: op });
    await view.update({ operation: { ...op, progress: progress(op) } });
    await click(button("Cancel"));
    expect(view.calls.filter((c) => c.name === "cancel")).toEqual([{ name: "cancel", payload: { operationId: OPERATION_ID } }]);
  });
});
