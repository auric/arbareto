// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import type { BridgeResponse, OnProgress } from "../../src/frontend/bridge";
import type { FileActionResult } from "../../src/frontend/changes/ChangesPane";
import { LIMITATION_TEXT } from "../../src/frontend/changes/limitation-text";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";

registerDom();
const { createRoot } = await import("react-dom/client");
const { BUSY_REASON } = await import("../../src/frontend/changes/ChangesPane");

// tasks.md T201. plan.md "Task flow and command placement" (File controls), "Limitation text", "Hunk toolbar layout",
// "Keyboard and focus" (Stage key row, File actions, Unavailable control), and contract §4 "File staging" and "Limitation remedies".

// T202 waits for T117. A template path keeps `tsc` from resolving the module before it exists.
const NEEDS = "(needs T202)";
type Props = Record<string, unknown>;
type FileModule = {
  FileControls: (props: Props) => ReactNode;
  runFileAction: (props: Props) => Promise<FileActionResult>;
};
async function fileControls(): Promise<FileModule> {
  const module = "FileControls";
  printOrigin(`../../src/frontend/changes/${module}.tsx`, import.meta.dir);
  return (await import(`../../src/frontend/changes/${module}.tsx`)) as FileModule;
}

type Call = { operation: string; target: Record<string, unknown>; payload: Record<string, unknown>; resolve(response: BridgeResponse): void };

// Each call stays pending until the test resolves it.
function bridgeDouble() {
  const calls: Call[] = [];
  const bridge = new Proxy(
    {},
    {
      get: (_, operation) => (target: Record<string, unknown> = {}, payload: Record<string, unknown> = {}, _onProgress?: OnProgress) =>
        new Promise<BridgeResponse>((resolve) => calls.push({ operation: String(operation), target, payload, resolve })),
    },
  );
  return { bridge: bridge as never, calls };
}

const TARGET = { repositoryId: crypto.randomUUID(), repositoryGeneration: 1 };
const REASON_ID = "hunk-toolbar-reason";
// Contract §4 "Limitation remedies": the `add` remedy form.
const ADD_REMEDY = { text: "This command stages or unstages the whole file with your Git settings. Run it in a terminal.", command: "& 'C:\\Program Files\\Git\\cmd\\git.exe' --literal-pathspecs -C 'C:\\repo' add -- 'a.txt'" };
const TAIL = "error: <b>CRLF</b> would be replaced by LF & stopped\nline 2\n";

// The T331 comparison value with a file-action decision (contract §4 "File staging").
function comparison(fileAction: string, remedy: typeof ADD_REMEDY | null = null) {
  return {
    comparisonId: crypto.randomUUID(),
    snapshotId: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
    scope: fileAction === "unstage" ? ("head-to-index" as const) : ("index-to-worktree" as const),
    completeness: { state: "complete" as const },
    patch: Buffer.from("diff --git a/a.txt b/a.txt\n").toString("base64"),
    hunks: [],
    support: "supported",
    fileAction,
    remedy,
  };
}

function trust(state: string, reads: boolean) {
  return { generation: 1, fingerprint: "f".repeat(64), state, persistence: "repository", approvalRequired: { reads, commit: false }, entries: [], hooks: [] };
}

function setup(fields: Partial<Props> = {}) {
  const double = bridgeDouble();
  const reasons: (string | null)[] = [];
  const outcomes: string[] = [];
  let refreshes = 0;
  let successes = 0;
  const props: Props = {
    bridge: double.bridge,
    target: TARGET,
    comparison: comparison("stage"),
    category: "unstaged",
    // One of "conflicted", "incomplete", "stale", "expired", or "busy", or null.
    blocked: null,
    trust: trust("approved", true),
    // T145 owns the reason line. The file button takes its ID as the accessible description and feeds its text.
    reasonId: REASON_ID,
    onReason: (text: string | null) => void reasons.push(text),
    onRefresh: () => void refreshes++,
    onOutcome: (text: string) => void outcomes.push(text),
    onSuccess: () => void successes++,
    ...fields,
  };
  return { ...double, props, reasons, outcomes, refreshes: () => refreshes, successes: () => successes };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function mount(FileControls: FileModule["FileControls"], props: Props) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(<FileControls {...props} />));
  const buttons = (label: string) => [...host.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === label);
  const button = (label: string) => {
    const found = buttons(label);
    expect(found).toHaveLength(1);
    return found[0]!;
  };
  const activate = async (label: string) => act(async () => button(label).click());
  const unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { host, buttons, button, activate, unmount };
}

// Base UI `focusableWhenDisabled` renders `aria-disabled="true"` and no `disabled` attribute, so the control keeps its Tab stop.
function expectFocusableDisabled(b: HTMLButtonElement) {
  expect(b.getAttribute("aria-disabled")).toBe("true");
  expect(b.hasAttribute("disabled")).toBe(false);
  expect(b.getAttribute("tabindex")).not.toBe("-1");
  expect(b.getAttribute("aria-describedby")?.split(/\s+/)).toContain(REASON_ID);
}
function expectEnabled(b: HTMLButtonElement) {
  expect(b.getAttribute("aria-disabled") ?? "false").toBe("false");
  expect(b.hasAttribute("disabled")).toBe(false);
}
const lastReason = (reasons: (string | null)[]) => reasons.at(-1) ?? null;

describe("decision", () => {
  test.todo(`a stage decision shows an enabled Stage file and no Unstage file ${NEEDS}`, async () => {
    const { FileControls } = await fileControls();
    const s = setup();
    const view = await mount(FileControls, s.props);
    try {
      expectEnabled(view.button("Stage file"));
      expect(view.buttons("Unstage file")).toHaveLength(0);
      expect(lastReason(s.reasons)).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test.todo(`an Untracked entry with a stage decision shows an enabled Stage file ${NEEDS}`, async () => {
    const { FileControls } = await fileControls();
    const s = setup({ category: "untracked", comparison: { ...comparison("stage"), scope: "empty-to-untracked" } });
    const view = await mount(FileControls, s.props);
    try {
      expectEnabled(view.button("Stage file"));
    } finally {
      await view.unmount();
    }
  });

  test.todo(`an unstage decision shows an enabled Unstage file and no Stage file ${NEEDS}`, async () => {
    const { FileControls } = await fileControls();
    const s = setup({ category: "staged", comparison: comparison("unstage") });
    const view = await mount(FileControls, s.props);
    try {
      expectEnabled(view.button("Unstage file"));
      expect(view.buttons("Stage file")).toHaveLength(0);
    } finally {
      await view.unmount();
    }
  });
});

describe("unavailable states", () => {
  test.todo(`a refusal reason disables Stage file, keeps it focusable, and feeds the plan.md limitation sentence to the reason line ${NEEDS}`, async () => {
    const { FileControls } = await fileControls();
    const s = setup({ comparison: comparison("size", ADD_REMEDY) });
    const view = await mount(FileControls, s.props);
    try {
      expectFocusableDisabled(view.button("Stage file"));
      expect(lastReason(s.reasons)).toBe(LIMITATION_TEXT.size);
    } finally {
      await view.unmount();
    }
  });

  test.todo(`a Conflicted entry (decision state) disables Stage file with the conflict sentence ${NEEDS}`, async () => {
    const { FileControls } = await fileControls();
    const s = setup({ category: "conflicted", comparison: comparison("state") });
    const view = await mount(FileControls, s.props);
    try {
      expectFocusableDisabled(view.button("Stage file"));
      expect(lastReason(s.reasons)).toBe(LIMITATION_TEXT.state);
    } finally {
      await view.unmount();
    }
  });

  // plan.md fixes the busy sentence only. The other states show a reason that the plan does not word.
  for (const blocked of ["conflicted", "incomplete", "stale", "expired", "busy"]) {
    test.todo(`a ${blocked} state disables Stage file, keeps it focusable, and feeds a reason to the reason line ${NEEDS}`, async () => {
      const { FileControls } = await fileControls();
      const s = setup({ blocked });
      const view = await mount(FileControls, s.props);
      try {
        expectFocusableDisabled(view.button("Stage file"));
        const reason = lastReason(s.reasons);
        expect(reason?.trim()).toBeTruthy();
        if (blocked === "busy") expect(reason).toBe(BUSY_REASON);
        await view.activate("Stage file");
        expect(s.calls).toEqual([]);
      } finally {
        await view.unmount();
      }
    });
  }

  test.todo(`required read trust that is not approved disables Stage file ${NEEDS}`, async () => {
    const { FileControls } = await fileControls();
    for (const state of ["untrusted", "changed", "revoked"]) {
      const s = setup({ trust: trust(state, true) });
      const view = await mount(FileControls, s.props);
      try {
        expectFocusableDisabled(view.button("Stage file"));
        expect(lastReason(s.reasons)?.trim()).toBeTruthy();
      } finally {
        await view.unmount();
      }
    }
  });

  // Contract §7 "Mutation trust": trust `changed` without required read approval disables nothing.
  test.todo(`trust changed without required read approval keeps Stage file enabled ${NEEDS}`, async () => {
    const { FileControls } = await fileControls();
    const s = setup({ trust: trust("changed", false) });
    const view = await mount(FileControls, s.props);
    try {
      expectEnabled(view.button("Stage file"));
    } finally {
      await view.unmount();
    }
  });

  test.todo(`activation of a disabled Stage file sends nothing ${NEEDS}`, async () => {
    const { FileControls } = await fileControls();
    const s = setup({ comparison: comparison("size", ADD_REMEDY) });
    const view = await mount(FileControls, s.props);
    try {
      await view.activate("Stage file");
      expect(s.calls).toEqual([]);
    } finally {
      await view.unmount();
    }
  });
});

describe("remedies and output", () => {
  // T134 shows the refused entry's remedy with Copy command (comparison-view.test.tsx). The reason sits beside it, so FileControls adds no second copy.
  test.todo(`a refused entry gets its reason beside the T134 remedy, and FileControls shows no second Copy command ${NEEDS}`, async () => {
    const { FileControls } = await fileControls();
    const s = setup({ comparison: comparison("size", ADD_REMEDY) });
    const view = await mount(FileControls, s.props);
    try {
      expect(lastReason(s.reasons)).toBe(LIMITATION_TEXT.size);
      expect(view.buttons("Copy command")).toHaveLength(0);
    } finally {
      await view.unmount();
    }
  });

  test.todo(`a stage GIT_FAILED shows its outputTail as plain text in a bounded read-only region, then the add remedy with Copy command ${NEEDS}`, async () => {
    const { FileControls } = await fileControls();
    const s = setup();
    const view = await mount(FileControls, s.props);
    try {
      await view.activate("Stage file");
      expect(s.calls).toHaveLength(1);
      await act(async () => {
        s.calls[0]!.resolve({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "failed", code: "GIT_FAILED", result: { remedy: ADD_REMEDY, outputTail: TAIL } });
        await flush();
      });
      expect(view.host.querySelector("b")).toBeNull();
      const region = [...view.host.querySelectorAll("pre")].find((p) => p.textContent === TAIL);
      expect(region).toBeDefined();
      expect(region!.closest("[contenteditable='true']")).toBeNull();
      const text = view.host.textContent ?? "";
      expect(text).toContain(ADD_REMEDY.command);
      expect(text.indexOf(ADD_REMEDY.command)).toBeGreaterThan(text.indexOf(TAIL.split("\n")[0]!));
      expect(view.buttons("Copy command")).toHaveLength(1);
      expect(s.successes()).toBe(0);
      expect(s.outcomes).toEqual([]);
    } finally {
      await view.unmount();
    }
  });
});

describe("activation", () => {
  test.todo(`Stage file sends one applyFile with the comparison ID, the snapshot ID, and the direction ${NEEDS}`, async () => {
    const { FileControls } = await fileControls();
    const s = setup();
    const value = s.props.comparison as ReturnType<typeof comparison>;
    const view = await mount(FileControls, s.props);
    try {
      await view.activate("Stage file");
      expect(s.calls.map((c) => [c.operation, c.target, c.payload])).toEqual([["applyFile", TARGET, { comparisonId: value.comparisonId, snapshotId: value.snapshotId, direction: "stage" }]]);
    } finally {
      await view.unmount();
    }
  });

  test.todo(`a second activation while the action runs sends nothing ${NEEDS}`, async () => {
    const { FileControls } = await fileControls();
    const s = setup();
    const view = await mount(FileControls, s.props);
    try {
      await view.activate("Stage file");
      await view.activate("Stage file");
      expect(s.calls).toHaveLength(1);
    } finally {
      await view.unmount();
    }
  });

  for (const [direction, label, outcome] of [["stage", "Stage file", "File staged"], ["unstage", "Unstage file", "File unstaged"]] as const) {
    test.todo(`after a succeeded ${direction}, it requests a refresh, reports "${outcome}", and calls the success callback once ${NEEDS}`, async () => {
      const { FileControls } = await fileControls();
      const s = setup(direction === "unstage" ? { category: "staged", comparison: comparison("unstage") } : {});
      const view = await mount(FileControls, s.props);
      try {
        await view.activate(label);
        expect(s.refreshes()).toBe(0);
        await act(async () => {
          s.calls[0]!.resolve({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "succeeded", result: {} });
          await flush();
        });
        expect(s.refreshes()).toBe(1);
        expect(s.outcomes).toEqual([outcome]);
        expect(s.successes()).toBe(1);
      } finally {
        await view.unmount();
      }
    });
  }

  // plan.md "Required visible states" fixes no sentence for the Stale selection notice.
  test.todo(`after STALE_SELECTION, it shows the Stale selection notice, requests a refresh, and reports no success ${NEEDS}`, async () => {
    const { FileControls } = await fileControls();
    const s = setup();
    const view = await mount(FileControls, s.props);
    try {
      const before = view.host.textContent ?? "";
      await view.activate("Stage file");
      await act(async () => {
        s.calls[0]!.resolve({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "failed", code: "STALE_SELECTION" });
        await flush();
      });
      const after = view.host.textContent ?? "";
      expect(after.length).toBeGreaterThan(before.length);
      expect(s.refreshes()).toBe(1);
      expect(s.successes()).toBe(0);
      expect(s.outcomes).toEqual([]);
    } finally {
      await view.unmount();
    }
  });
});

describe("runFileAction", () => {
  for (const [category, fileAction, reason, label] of [
    ["unstaged", "size", "size", "Stage file"],
    ["conflicted", "state", "state", "Stage file"],
    ["staged", "submodule", "submodule", "Unstage file"],
  ] as const) {
    test.todo(`a ${fileAction} decision in ${category} sends nothing and returns "${label} is unavailable: <reason>" ${NEEDS}`, async () => {
      const { runFileAction } = await fileControls();
      const s = setup({ category, comparison: comparison(fileAction, ADD_REMEDY) });
      const result = await runFileAction(s.props);
      expect(result).toEqual({ state: "refused", text: `${label} is unavailable: ${LIMITATION_TEXT[reason]}` });
      expect(s.calls).toEqual([]);
    });
  }

  test.todo(`an accepted decision sends one applyFile and returns succeeded after the service succeeds ${NEEDS}`, async () => {
    const { runFileAction } = await fileControls();
    const s = setup({ category: "staged", comparison: comparison("unstage") });
    const value = s.props.comparison as ReturnType<typeof comparison>;
    const pending = runFileAction(s.props);
    await flush();
    expect(s.calls.map((c) => [c.operation, c.target, c.payload])).toEqual([["applyFile", TARGET, { comparisonId: value.comparisonId, snapshotId: value.snapshotId, direction: "unstage" }]]);
    s.calls[0]!.resolve({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "succeeded", result: {} });
    expect(await pending).toEqual({ state: "succeeded" });
  });

  test.todo(`a failed applyFile returns failed ${NEEDS}`, async () => {
    const { runFileAction } = await fileControls();
    const s = setup();
    const pending = runFileAction(s.props);
    await flush();
    s.calls[0]!.resolve({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "failed", code: "GIT_FAILED", result: { remedy: ADD_REMEDY, outputTail: TAIL } });
    expect(await pending).toEqual({ state: "failed" });
  });
});
