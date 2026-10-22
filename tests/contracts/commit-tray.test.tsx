// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { ReviewCommitResult } from "../../src/contracts/envelope";
import type { BridgeResponse } from "../../src/frontend/bridge";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { commitReviewed, contractChecked } from "./bridge-contract";

// tasks.md T239. plan.md "Task flow and command placement" (Compose a commit, Commit, Commit outcome) and "Keyboard and focus" (Message, Unavailable control).

printOrigin("../../src/frontend/commit/CommitTray.tsx", import.meta.dir);
registerDom();
const { createRoot } = await import("react-dom/client");
const { CommitTray, HOOK_DISCLOSURE } = await import("../../src/frontend/commit/CommitTray");
const { BLOCKED_TEXT, STALE_TEXT } = await import("../../src/frontend/changes/HunkControls");
const { createDrafts } = await import("../../src/frontend/state/drafts");

type Call = { operation: string; target: Record<string, unknown>; payload: Record<string, unknown>; resolve(response: BridgeResponse): void };
function bridgeDouble() {
  const calls: Call[] = [];
  const bridge = new Proxy(
    {},
    { get: (_, operation) => (target: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) => new Promise<BridgeResponse>((resolve) => calls.push({ operation: String(operation), target, payload, resolve })) },
  );
  return { bridge: contractChecked(bridge) as never, calls };
}

const KEY = "a".repeat(64);
const TARGET = { repositoryId: crypto.randomUUID(), repositoryGeneration: 1 };
const SNAPSHOT = crypto.randomUUID();
const TOKEN = crypto.randomUUID();
const HEAD = { state: "branch", target: "refs/heads/main", oid: "1".repeat(40) } as const;
const ok = (result: unknown): BridgeResponse => ({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "succeeded", result }) as BridgeResponse;
const report = (commit: boolean, state = "untrusted") => ({ generation: 1, programs: {}, state, persistence: "repository", approvalRequired: { reads: false, commit }, entries: [], hooks: [] });
const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});

async function mount(fields: Record<string, unknown> = {}) {
  const double = bridgeDouble();
  const drafts = createDrafts({ write: async () => "saved", remove: async () => "saved", read: async () => null } as never);
  const ended: BridgeResponse[] = [];
  const trustRequests: ((approved: boolean) => void)[] = [];
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const props = {
    bridge: double.bridge,
    target: TARGET,
    snapshotId: SNAPSHOT,
    worktreeKey: KEY,
    drafts,
    head: HEAD,
    staged: 2,
    status: null,
    requestTrust: () => new Promise<boolean>((resolve) => trustRequests.push(resolve)),
    onEnded: (response: BridgeResponse) => void ended.push(response),
    ...fields,
  };
  await act(async () => root.render(<CommitTray {...(props as unknown as Parameters<typeof CommitTray>[0])} />));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const field = host.querySelector("textarea")!;
  const commit = [...host.querySelectorAll("button")].find((b) => b.textContent === "Commit (Ctrl+Enter)")!;
  const type = async (text: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const key = async (init: KeyboardEventInit) => act(async () => void field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", ctrlKey: true, bubbles: true, cancelable: true, ...init })));
  const ops = () => double.calls.map((c) => c.operation);
  const answer = async (operation: string, response: BridgeResponse) => {
    const call = double.calls.findLast((c) => c.operation === operation)!;
    await act(async () => call.resolve(response));
    await flush();
  };
  return { ...double, host, field, commit, type, key, ops, answer, ended, trustRequests, drafts };
}
const reason = (button: HTMLElement) => document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent ?? null;

describe("tray", () => {
  test("it shows the message field, Commit (Ctrl+Enter), the hook disclosure beside it, and the summary line", async () => {
    const t = await mount();
    expect(t.field).not.toBeNull();
    expect(t.commit.getAttribute("aria-keyshortcuts")).toBe("Control+Enter");
    expect(t.host.textContent).toContain(HOOK_DISCLOSURE);
    expect(t.host.textContent).toContain("main, 2 staged files");
  });

  test("a detached HEAD and one staged file read Detached HEAD, 1 staged file", async () => {
    const t = await mount({ head: { state: "detached", oid: "1".repeat(40) }, staged: 1 });
    expect(t.host.textContent).toContain("Detached HEAD, 1 staged file");
  });

  for (const [name, fields, text, expected] of [
    ["an empty Staged list", { staged: 0 }, "Message", "The Staged list is empty."],
    ["a blank message", {}, " \n\t", "The commit message is empty."],
    ["an incomplete status read", { status: "incomplete" }, "Message", "The status read is incomplete, so changes stay blocked."],
    ["a loading status page", { status: "loading" }, "Message", "A status page is still loading."],
  ] as const) {
    test(`${name} disables Commit with its visible reason, and Commit stays focusable`, async () => {
      const t = await mount(fields);
      await t.type(text);
      expect(t.commit.getAttribute("aria-disabled")).toBe("true");
      expect(t.commit.hasAttribute("disabled")).toBe(false);
      expect(reason(t.commit)).toBe(expected);
      await act(async () => t.commit.click());
      expect(t.calls).toEqual([]);
    });
  }

  test("the reason kind places the reason: a block reason with the trust reason text stays under the editor, without the shield (tasks.md T113)", async () => {
    const shared = BLOCKED_TEXT.operation;
    const t = await mount({ blocked: "operation", trustReason: shared });
    await t.type("Message");
    const line = document.getElementById(t.commit.getAttribute("aria-describedby")!)!;
    expect(line.textContent).toBe(shared);
    expect(line.querySelector("svg")).toBeNull();
    expect(line.parentElement!.contains(t.commit)).toBe(false);
    const trust = await mount({ trustReason: shared });
    await trust.type("Message");
    const trustLine = document.getElementById(trust.commit.getAttribute("aria-describedby")!)!;
    expect(trustLine.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(trustLine.parentElement!.contains(trust.commit)).toBe(true);
  });

  test("the reason kind places the Commit and push reason, also when both reasons share one text (tasks.md T113)", async () => {
    const shared = "The Staged list is empty.";
    const push = (host: HTMLElement) => [...host.querySelectorAll("button")].find((b) => b.textContent === "Commit and push")!;
    const both = await mount({ staged: 0, pushReason: shared, onPush: () => {} });
    await both.type("Message");
    expect(push(both.host).getAttribute("aria-describedby")).toBe(both.commit.getAttribute("aria-describedby"));
    expect(both.host.textContent).not.toContain(`Commit and push: ${shared}`);
    const own = await mount({ pushReason: shared, onPush: () => {} });
    await own.type("Message");
    expect(own.commit.getAttribute("aria-describedby")).toBeNull();
    expect(reason(push(own.host))).toBe(`Commit and push: ${shared}`);
  });

  test("Enter inserts no commit, and the draft text stays in the draft store", async () => {
    const t = await mount();
    await t.type("Line one\nLine two");
    await t.key({ ctrlKey: false });
    expect(t.calls).toEqual([]);
    expect(t.drafts.draft(KEY)?.text).toBe("Line one\nLine two");
  });
});

describe("commit flow", () => {
  async function ready() {
    const t = await mount();
    await t.type("Fix the parser");
    return t;
  }
  async function runToCommit(t: Awaited<ReturnType<typeof ready>>) {
    await t.answer("readTrust", ok(report(false)));
    await t.answer("reviewCommit", ok(commitReviewed(TOKEN)));
  }

  test("one Commit activation sends one reviewCommit with the shown snapshot ID, then one commit with its token and confirmFullScope true", async () => {
    const t = await ready();
    await act(async () => t.commit.click());
    await runToCommit(t);
    expect(t.calls.map((c) => [c.operation, c.target, c.payload])).toEqual([
      ["readTrust", { repositoryId: TARGET.repositoryId }, {}],
      ["reviewCommit", TARGET, { snapshotId: SNAPSHOT }],
      ["commit", TARGET, { reviewToken: TOKEN, message: "Fix the parser", confirmFullScope: true }],
    ]);
  });

  test("one Ctrl+Enter in the message field does the same", async () => {
    const t = await ready();
    await t.key({});
    await runToCommit(t);
    expect(t.ops()).toEqual(["readTrust", "reviewCommit", "commit"]);
  });

  test("a second activation while the commit runs sends nothing, and focus stays on Commit", async () => {
    const t = await ready();
    await act(async () => t.commit.focus());
    await act(async () => t.commit.click());
    await act(async () => t.commit.click());
    await t.key({});
    await runToCommit(t);
    await act(async () => t.commit.click());
    expect(t.ops()).toEqual(["readTrust", "reviewCommit", "commit"]);
    expect(document.activeElement).toBe(t.commit);
    expect(t.commit.getAttribute("aria-disabled")).toBe("true");
  });

  test("a key with repeat true sends nothing, and so does a key during IME composition", async () => {
    const t = await ready();
    await t.key({ repeat: true });
    await t.key({ isComposing: true } as KeyboardEventInit);
    await act(async () => void t.field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await t.key({});
    expect(t.calls).toEqual([]);
    expect(reason(t.commit)).toBe("Text input is still composing.");
    await act(async () => void t.field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    await t.key({});
    expect(t.ops()).toEqual(["readTrust"]);
  });

  test("when readTrust reports approvalRequired for commit, the Trust dialog opens first, and no reviewCommit goes out before the approval", async () => {
    const t = await ready();
    await act(async () => t.commit.click());
    await t.answer("readTrust", ok(report(true)));
    expect(t.trustRequests).toHaveLength(1);
    expect(t.ops()).toEqual(["readTrust"]);
    await act(async () => t.trustRequests[0]!(true));
    await flush();
    expect(t.ops()).toEqual(["readTrust", "reviewCommit"]);
  });

  test("a canceled Trust dialog sends no reviewCommit and returns focus to the message field", async () => {
    const t = await ready();
    await act(async () => t.commit.click());
    await t.answer("readTrust", ok(report(true)));
    await act(async () => t.trustRequests[0]!(false));
    await flush();
    expect(t.ops()).toEqual(["readTrust"]);
    expect(document.activeElement).toBe(t.field);
  });

  test("an approved commit trust opens no dialog", async () => {
    const t = await ready();
    await act(async () => t.commit.click());
    await t.answer("readTrust", ok(report(true, "approved")));
    expect(t.trustRequests).toHaveLength(0);
    expect(t.ops()).toEqual(["readTrust", "reviewCommit"]);
  });

  test("STALE_REVIEW shows the Stale selection text and requests a refresh, and the draft stays", async () => {
    const t = await ready();
    await act(async () => t.commit.click());
    await runToCommit(t);
    const stale = { requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "failed", code: "STALE_REVIEW" } as BridgeResponse;
    await t.answer("commit", stale);
    expect(t.host.textContent).toContain(STALE_TEXT);
    expect(t.ended).toEqual([stale]);
    expect(t.field.value).toBe("Fix the parser");
  });

  test("a review without a token, which means an empty staged scope, shows the Stale selection text, sends no commit, and returns focus to the message field", async () => {
    const t = await ready();
    await act(async () => t.commit.click());
    await t.answer("readTrust", ok(report(false)));
    await t.answer("reviewCommit", ok(commitReviewed(null)));
    expect(t.ops()).toEqual(["readTrust", "reviewCommit"]);
    expect(t.host.textContent).toContain(STALE_TEXT);
    expect(t.ended).toHaveLength(1);
    expect(document.activeElement).toBe(t.field);
  });

  for (const [state, code] of [
    ["rejected", "TRUST_REQUIRED"],
    ["failed", "GIT_FAILED"],
  ] as const) {
    test(`a ${state} reviewCommit with ${code} sends no commit, shows "Commit did not start: ${code}", and returns focus to the message field`, async () => {
      const t = await ready();
      await act(async () => t.commit.click());
      await t.answer("readTrust", ok(report(false)));
      await t.answer("reviewCommit", { requestId: crypto.randomUUID(), state, code } as BridgeResponse);
      expect(t.ops()).toEqual(["readTrust", "reviewCommit"]);
      expect(t.host.querySelector('[role="status"]')?.textContent).toBe(`Commit did not start: ${code}`);
      // B4-4: plan.md "Status and fallback texts": each code shows in the code font.
      expect(t.host.querySelector('[role="status"] code')?.textContent).toBe(code);
      expect(document.activeElement).toBe(t.field);
      expect(t.field.value).toBe("Fix the parser");
    });
  }

  test("B4-4 and B4-5: a failed trust read at Commit shows the code in the code font, with no final period", async () => {
    const t = await ready();
    await act(async () => t.commit.click());
    await t.answer("readTrust", { requestId: crypto.randomUUID(), state: "failed", code: "DEADLINE" } as BridgeResponse);
    expect(t.ops()).toEqual(["readTrust"]);
    expect(t.host.querySelector('[role="status"]')?.textContent).toBe("Trust review did not complete: DEADLINE");
    expect(t.host.querySelector('[role="status"] code')?.textContent).toBe("DEADLINE");
  });

  test("T372: a trust read above a report row bound shows OUTPUT_LIMIT with the bound name", async () => {
    const t = await ready();
    await act(async () => t.commit.click());
    await t.answer("readTrust", { requestId: crypto.randomUUID(), state: "failed", code: "OUTPUT_LIMIT", result: { reason: "TRUST_REPORT_ENTRIES" } } as BridgeResponse);
    expect(t.ops()).toEqual(["readTrust"]);
    expect(t.host.querySelector('[role="status"]')?.textContent).toBe("Trust review did not complete: OUTPUT_LIMIT TRUST_REPORT_ENTRIES");
  });

  test("a succeeded review that breaks the result schema shows the unknown-form text, not the Stale text, and sends no commit", async () => {
    for (const result of [commitReviewed(TOKEN), commitReviewed(null)]) expect(ReviewCommitResult.safeParse(result).success).toBe(true);
    const malformed = { reviewToken: TOKEN };
    expect(ReviewCommitResult.safeParse(malformed).success).toBe(false);
    const t = await ready();
    await act(async () => t.commit.click());
    await t.answer("readTrust", ok(report(false)));
    await t.answer("reviewCommit", ok(malformed));
    expect(t.ops()).toEqual(["readTrust", "reviewCommit"]);
    expect(t.host.querySelector('[role="status"]')!.textContent).toBe("Commit did not complete: the result has an unknown form.");
  });

  test("the live element stays mounted and only its text changes", async () => {
    const t = await ready();
    const live = t.host.querySelector('[role="status"]');
    expect(live?.textContent).toBe("");
    await act(async () => t.commit.click());
    await t.answer("readTrust", ok(report(false)));
    await t.answer("reviewCommit", ok(commitReviewed(null)));
    expect(t.host.querySelector('[role="status"]')).toBe(live);
    expect(live?.textContent).toBe(STALE_TEXT);
  });

  test("a succeeded commit clears the unchanged submitted draft, and a later edit survives", async () => {
    const t = await ready();
    await act(async () => t.commit.click());
    await runToCommit(t);
    await t.answer("commit", ok({ commitOid: "2".repeat(40) }));
    expect(t.field.value).toBe("");
    const u = await ready();
    await act(async () => u.commit.click());
    await runToCommit(u);
    await u.type("Edited while Git ran");
    await u.answer("commit", ok({ commitOid: "2".repeat(40) }));
    expect(u.field.value).toBe("Edited while Git ran");
  });

  // tasks.md T389: the commit sends the message that the disable rules checked before the review.
  test("T389: an edit during the review keeps the checked message for the commit, and the edit stays as the draft", async () => {
    const t = await ready();
    await act(async () => t.commit.click());
    await t.answer("readTrust", ok(report(false)));
    await t.type(" \n");
    await t.answer("reviewCommit", ok(commitReviewed(TOKEN)));
    expect(t.calls.at(-1)!.payload).toEqual({ reviewToken: TOKEN, message: "Fix the parser", confirmFullScope: true });
    await t.answer("commit", ok({ commitOid: "2".repeat(40) }));
    expect(t.field.value).toBe(" \n");
  });

  test("T389: a draft cleared during the review still commits the checked message", async () => {
    const t = await ready();
    await act(async () => t.commit.click());
    await t.answer("readTrust", ok(report(false)));
    await act(async () => t.drafts.clear(KEY));
    await t.answer("reviewCommit", ok(commitReviewed(TOKEN)));
    expect(t.ops()).toEqual(["readTrust", "reviewCommit", "commit"]);
    expect(t.calls.at(-1)!.payload.message).toBe("Fix the parser");
  });

  test("a failed commit keeps the draft", async () => {
    const t = await ready();
    await act(async () => t.commit.click());
    await runToCommit(t);
    await t.answer("commit", { requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "failed", code: "HOOK_FAILED", result: { outputTail: "hook said no\n" } } as BridgeResponse);
    expect(t.field.value).toBe("Fix the parser");
    expect(t.ended).toHaveLength(1);
  });
});
