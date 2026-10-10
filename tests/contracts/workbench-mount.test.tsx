// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import type { Environment, HistoryPage, WorkspaceSnapshot } from "../../src/contracts/envelope";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";

printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
// `Workbench.tsx` loads Base UI. Base UI must first evaluate with a DOM (tests/dom.ts).
registerDom();
const { createRoot } = await import("react-dom/client");
const { ChangesPaneMount, ComparisonViewMount, HistoryViewMount, INTERIM_HELP_LINE, LATER, Workbench } = await import("../../src/frontend/app/Workbench");

// tasks.md T330: the interim read-only mount. plan.md "Measurements and budgets" (History-ready frame) and "Required visible states".

type Call = { operation: string; args: unknown[]; resolve(response: unknown): void };
// Each request stays pending until the test resolves it.
function bridgeDouble() {
  const calls: Call[] = [];
  const bridge = new Proxy(
    {},
    {
      get: (_, name) =>
        (...args: unknown[]) =>
          new Promise((resolve) => calls.push({ operation: String(name), args, resolve })),
    },
  );
  const pending = (operation: string) => calls.find((c) => c.operation === operation)!;
  return { bridge, calls, pending };
}

const REGISTRATION = { repositoryId: crypto.randomUUID(), generation: 1, worktreeKey: "a".repeat(64) };
const succeeded = (result: unknown) => ({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "succeeded", repositoryGeneration: 1, result });
const HEAD = "1".repeat(40);
function snapshot(fields: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    generation: 1,
    snapshotId: crypto.randomUUID(),
    identity: { worktreeRoot: "C:\\repo", gitDirectory: "C:\\repo\\.git", commonDirectory: "C:\\repo\\.git", indexPath: "C:\\repo\\.git\\index", objectFormat: "sha1", refFormat: "files" },
    head: { state: "branch", target: "refs/heads/main", oid: HEAD },
    operationState: "normal",
    recoveryState: "ready",
    completeness: { state: "complete" },
    hunkEligibility: { eligible: true },
    submoduleNotice: { count: 0, paths: [], filter: "applied" },
    entryCount: 0,
    entries: [],
    cursor: null,
    ...fields,
  };
}
const PAGE: HistoryPage = {
  generation: 1,
  scope: "current-checkout",
  head: { state: "branch", target: "refs/heads/main", oid: HEAD },
  shallowFingerprint: null,
  rows: [{ oid: HEAD, parents: [], subject: "First", author: { name: "A", email: "a@example.invalid" }, date: 1_700_000_000, encoding: null }],
  boundaries: { page: [], shallow: [] },
  completeness: { state: "complete" },
};

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  localStorage.clear();
});
// Lets the responses settle, React commit, and the next animation frame run.
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 50))));
const text = () => (document.body.textContent ?? "").replace(/\s+/g, " ");

async function mount(restore: unknown, environment: Environment | null = null) {
  const double = bridgeDouble();
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <Workbench
        bridge={double.bridge as never}
        environment={environment}
        restored={Promise.resolve(restore) as never}
        ChangesPane={ChangesPaneMount}
        ComparisonView={ComparisonViewMount}
        HistoryView={HistoryViewMount}
      />,
    ),
  );
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await settle();
  return double;
}
async function resolve(call: Call, response: unknown) {
  await act(async () => call.resolve(response));
  await settle();
}

describe("start", () => {
  test("a canceled restoreWorkspace, which means no stored repository, shows No repository and no refusal", async () => {
    const double = await mount({ requestId: null, state: "canceled" });
    expect(text()).toContain("No repository");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(double.calls.map((c) => c.operation)).toEqual([]);
  });

  test("a restoreWorkspace registration opens History and sends the full read, readHistory, and readTrust", async () => {
    const double = await mount(succeeded(REGISTRATION));
    expect(double.calls.map((c) => c.operation).sort()).toEqual(["readHistory", "readTrust", "readWorkspace"]);
    expect(double.pending("readWorkspace").args[1]).toEqual({ refresh: false, check: "full" });
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("History");
  });

  test("a refused restoreWorkspace shows the Repository refused state with its code", async () => {
    await mount({ requestId: crypto.randomUUID(), state: "failed", code: "UNSUPPORTED_REPOSITORY" });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("UNSUPPORTED_REPOSITORY");
  });
});

describe("History", () => {
  test("the history-painted mark waits for the counts of a complete read", async () => {
    const mark = spyOn(performance, "mark");
    try {
      const double = await mount(succeeded(REGISTRATION));
      await resolve(double.pending("readHistory"), succeeded(PAGE));
      expect(mark.mock.calls.filter(([name]) => name === "arbareto:history-painted")).toHaveLength(0);
      await resolve(double.pending("readWorkspace"), succeeded(snapshot()));
      expect(mark.mock.calls.filter(([name]) => name === "arbareto:history-painted")).toHaveLength(1);
    } finally {
      mark.mockRestore();
    }
  });

  test("a limited read gives no history-painted mark", async () => {
    const mark = spyOn(performance, "mark");
    try {
      const double = await mount(succeeded(REGISTRATION));
      await resolve(double.pending("readHistory"), succeeded(PAGE));
      await resolve(double.pending("readWorkspace"), { ...succeeded(snapshot({ completeness: { state: "limited", code: "WORKTREE_CHANGING" } })), state: "limited" });
      expect(mark.mock.calls.filter(([name]) => name === "arbareto:history-painted")).toHaveLength(0);
    } finally {
      mark.mockRestore();
    }
  });

  test("History shows one inspector and no bottom region splitter of its own", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await resolve(double.pending("readHistory"), succeeded(PAGE));
    await resolve(double.pending("readWorkspace"), succeeded(snapshot()));
    const history = document.querySelector('section[aria-label="History"]')!;
    expect(history.querySelectorAll('[role="listbox"]')).toHaveLength(1);
    expect((history.textContent ?? "").split("Select a commit to see its details")).toHaveLength(2);
    expect(history.querySelector('[role="separator"]')).toBeNull();
  });
});

describe("read-only places", () => {
  test("the commit place states that commit is available after batch 3", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await resolve(double.pending("readWorkspace"), succeeded(snapshot()));
    expect(document.querySelector('section[aria-label="Changes"]')?.textContent).toContain(LATER.commit);
  });

  test("the submodule row shows the service count and no Update submodules button", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await resolve(double.pending("readWorkspace"), succeeded(snapshot({ submoduleNotice: { count: 2, paths: ["a", "b"], filter: "applied" } })));
    const band = document.querySelector('[data-slot="notice-band"]')!;
    expect(band.textContent).toContain("Count: 2.");
    expect(band.textContent).toContain(LATER.submodules);
    expect(band.querySelector("button")).toBeNull();
  });
});

describe("trust", () => {
  const report = (state: string, reads: boolean) => ({
    generation: 1,
    fingerprint: "f".repeat(64),
    state,
    persistence: "stored",
    approvalRequired: { reads, commit: false },
    entries: [],
    hooks: [],
  });

  test("the Trust required dialog opens when reads need an approval", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await resolve(double.pending("readTrust"), succeeded(report("untrusted", true)));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Trust required");
  });

  test("no dialog opens when reads need no approval", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await resolve(double.pending("readTrust"), succeeded(report("untrusted", false)));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

// Contract §3 `getEnvironment` and §6 "Dismissal".
describe("recovery markers", () => {
  const environment = (fields: Partial<Environment> = {}): Environment => ({
    buildIdentity: { version: "0.1.0", commit: "c".repeat(40), signing: "unsigned" },
    platformScope: "qualification-target",
    detectedVersion: "2.55.0.windows.3",
    minimumVersion: "2.55.0.windows.3",
    qualification: "unverified",
    markers: [],
    damagedMarkers: [],
    ...fields,
  });
  const MARKER = { markerId: crypto.randomUUID(), kind: "commit", startedAt: "2026-10-01T10:00:00Z", worktreeRoot: "C:\repo" } as Environment["markers"][number];
  const section = () => document.querySelector('[data-slot="recovery-markers"]');

  test("markers show with Dismiss above a mounted workbench", async () => {
    await mount(succeeded(REGISTRATION), environment({ markers: [MARKER] }));
    const markers = section();
    expect(markers?.textContent).toContain("Recovery markers");
    expect([...markers!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Dismiss"]);
    expect(markers!.compareDocumentPosition(document.querySelector("header")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector('[role="menubar"]')).not.toBeNull();
  });

  test("a dismissal re-reads the environment, and a result without markers removes the section", async () => {
    const double = await mount(succeeded(REGISTRATION), environment({ markers: [MARKER] }));
    await act(async () => section()!.querySelector("button")!.click());
    await settle();
    const dismissal = double.pending("dismissRecoveryMarker");
    expect(dismissal.args[0]).toEqual({ markerId: MARKER.markerId });
    await resolve(dismissal, succeeded({}));
    await resolve(double.pending("getEnvironment"), succeeded(environment()));
    expect(section()).toBeNull();
  });

  test("no section shows without markers", async () => {
    await mount(succeeded(REGISTRATION), environment());
    expect(section()).toBeNull();
  });
});

describe("help line", () => {
  test("the No selection help line states the interim staging sentence", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await resolve(double.pending("readWorkspace"), succeeded(snapshot()));
    const changes = document.querySelector('section[aria-label="Changes"]')!.textContent ?? "";
    expect(changes).toContain(INTERIM_HELP_LINE);
    expect(changes).not.toContain("Space stages or unstages it");
  });
});
