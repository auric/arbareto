// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T257: the stall notice of `src/frontend/status/OperationStatus.tsx` (contract §6 "Activity and stall notice", plan.md "Required visible states" Busy and "Status area").
// The bridge double answers `getOperation` with an `OperationResult` that the contract schema accepts.

import { afterEach, describe, expect, test } from "bun:test";
import { act, useState, type Dispatch, type SetStateAction } from "react";
import { OperationResult } from "../../src/contracts/envelope";
import { buildSubmoduleRemedy } from "../../src/contracts/submodules";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { contractChecked } from "./bridge-contract";

printOrigin("../../src/frontend/status/OperationStatus.tsx", import.meta.dir);
printOrigin("../../src/contracts/envelope.ts", import.meta.dir);
registerDom();
const { createRoot } = await import("react-dom/client");
const { OperationStatus } = await import("../../src/frontend/status/OperationStatus");
type Props = Parameters<typeof OperationStatus>[0];
type Operation = NonNullable<Props["operation"]>;
type Fields = Omit<Props, "bridge" | "onFocusMessageField" | "onClearMessage" | "onRefresh" | "ref">;
type Remedy = { command?: string; text: string };

// plan.md "Required visible states", Busy, and contract §6.
const STALL_SENTENCE = "Git may be waiting for input.";
const STALL_NOTICE = "Git may be waiting for a prompt that Arbareto cannot show, or for a sign-in window. To answer a hidden prompt, select Cancel and run this command in a terminal.";
const COMMIT_REMEDY: Remedy = { command: "& 'C:\\Git\\cmd\\git.exe' --no-lazy-fetch -C 'C:/work/repo' hook run --ignore-missing pre-commit", text: "This command runs only the pre-commit hook and does not commit. It cannot repeat a prompt from another hook or from signing." };
const CLONE = buildSubmoduleRemedy({ step: "clone", gitPath: "C:\\Git\\cmd\\git.exe", parentWorktree: "C:/work/repo", path: "libs/solo" });
const STEP_REMEDY: Remedy = { command: CLONE.command!, text: CLONE.text };
const OPERATION_ID = "6f9619ff-8b86-4011-b42d-00cf4fc964ff";
const ROOT = "C:\\work\\repo";
const BASE: Fields = { operation: null, worktreeRoot: ROOT, head: { state: "branch", target: "refs/heads/main", oid: "0123456789abcdef0123456789abcdef01234567" }, trusted: false, panel: "commit", modalOpen: false, refusal: null };

const KINDS = [
  { kind: "commit", remedy: COMMIT_REMEDY, progress: { phase: "commit-handoff", counters: {} } },
  { kind: "updateSubmodules", remedy: STEP_REMEDY, progress: { phase: "fetch", path: "libs/solo", counters: { rowIndex: 1, rowCount: 2 } } },
] as const;

const unmounts: (() => Promise<void>)[] = [];
const written: string[] = [];
const clipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  written.length = 0;
  if (clipboard) Object.defineProperty(globalThis.navigator, "clipboard", clipboard);
  else delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
});

const text = (element: Element | null | undefined) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();
const buttons = (label: string) => [...document.querySelectorAll("button")].filter((b) => text(b) === label);
const area = () => document.querySelector('[data-slot="status-area"]');
const footer = () => document.querySelector("footer")!;
const live = () => document.querySelector('[role="status"]')!;
const settle = () => act(async () => await new Promise((resolve) => setImmediate(resolve)));
const tabStops = (from: Element) => [...from.querySelectorAll<HTMLElement>("button, [tabindex], textarea, input, a[href]")].filter((e) => e.tabIndex >= 0 && !e.hasAttribute("disabled"));

async function mount(kind: (typeof KINDS)[number], remedy: Remedy = kind.remedy) {
  Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => void written.push(value) } });
  const calls: unknown[] = [];
  const bridge = contractChecked({
    cancel: () => new Promise(() => {}),
    getOperation: (payload: unknown) => {
      calls.push(payload);
      const result = OperationResult.parse({ operationId: OPERATION_ID, operation: kind.kind, state: "running", phase: kind.progress.phase, stalled: true, stallRemedy: remedy });
      return Promise.resolve({ requestId: crypto.randomUUID(), state: "succeeded", result });
    },
  });
  const op = { requestId: crypto.randomUUID(), kind: kind.kind, progress: null, response: null } as Operation;
  let set!: Dispatch<SetStateAction<Fields>>;
  function Harness() {
    const [props, setProps] = useState<Fields>({ ...BASE, operation: op });
    set = setProps;
    return <OperationStatus {...props} bridge={bridge as never} onFocusMessageField={() => {}} onClearMessage={() => {}} onRefresh={() => {}} />;
  }
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(<Harness />));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const event = async (stalled: boolean, counters: Record<string, number> = kind.progress.counters) => {
    const progress = { requestId: op.requestId, operationId: OPERATION_ID, state: "running", ...kind.progress, counters, stalled };
    await act(async () => set((p) => ({ ...p, operation: { ...op, progress } as never })));
    await settle();
  };
  await event(false);
  return { calls, event };
}

for (const kind of KINDS) {
  describe(`a running ${kind.kind}`, () => {
    test("a progress event with stalled makes one getOperation call; the notice shows the plan.md text, the Warning icon, and the stallRemedy command in the code font", async () => {
      const view = await mount(kind);
      await view.event(true);
      await view.event(true, { ...kind.progress.counters, ...(kind.kind === "updateSubmodules" ? { percent: 10 } : {}) });
      expect(view.calls).toEqual([{ operationId: OPERATION_ID }]);
      const shown = area()!;
      expect(text(shown)).toContain(STALL_NOTICE);
      expect(text(shown)).toContain(kind.remedy.text);
      expect([...shown.querySelectorAll("code")].map((c) => c.textContent)).toEqual([kind.remedy.command!]);
      expect(shown.querySelector('svg.text-warning[aria-hidden="true"]')).not.toBeNull();
      expect(buttons("Copy command")).toHaveLength(1);
    });

    test("a stallRemedy without a command shows only its text", async () => {
      const view = await mount(kind, { text: kind.remedy.text });
      await view.event(true);
      expect(text(area())).toContain(STALL_NOTICE);
      expect(text(area())).toContain(kind.remedy.text);
      expect(area()!.querySelectorAll("code")).toHaveLength(0);
      expect(buttons("Copy command")).toHaveLength(0);
    });

    test("Copy command calls navigator.clipboard.writeText with the exact command", async () => {
      const view = await mount(kind);
      await view.event(true);
      await act(async () => buttons("Copy command")[0]!.click());
      expect(written).toEqual([kind.remedy.command!]);
    });

    test("Cancel stays focusable in its place, and focus on Cancel stays through the stall", async () => {
      const view = await mount(kind);
      const cancel = buttons("Cancel")[0]!;
      expect(tabStops(footer()).at(-1)).toBe(cancel);
      await act(async () => cancel.focus());
      await view.event(true);
      expect(buttons("Cancel")).toEqual([cancel]);
      expect(tabStops(footer()).at(-1)).toBe(cancel);
      expect(document.activeElement).toBe(cancel);
    });

    test("the live region announces the notice once per stall", async () => {
      const view = await mount(kind);
      const added: string[] = [];
      const observer = new MutationObserver((records) => {
        for (const r of records) for (const node of r.addedNodes) if ((node.textContent ?? "").includes(STALL_SENTENCE)) added.push(node.textContent!);
      });
      observer.observe(live(), { childList: true, subtree: true, characterData: true });
      await view.event(true);
      await view.event(true, { ...kind.progress.counters });
      await view.event(false);
      await view.event(true);
      observer.disconnect();
      expect(added).toHaveLength(2);
      expect(view.calls).toHaveLength(2);
    });

    test("an event with stalled false hides the notice and the status sentence", async () => {
      const view = await mount(kind);
      await view.event(true);
      expect(text(live())).toContain(STALL_SENTENCE);
      await view.event(false);
      expect(text(live())).not.toContain(STALL_SENTENCE);
      expect(text(document.body)).not.toContain(STALL_NOTICE);
    });

    test("the notice never shows Git output: it holds only the notice text, the command, and the command text", async () => {
      const view = await mount(kind);
      await view.event(true);
      const notice = [...area()!.querySelectorAll("p")].find((p) => text(p) === STALL_NOTICE)!.parentElement!;
      expect([...notice.children].map((c) => c.textContent)).toEqual([STALL_NOTICE, kind.remedy.command!, kind.remedy.text]);
    });
  });
}
