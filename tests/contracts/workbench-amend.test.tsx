// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { ReviewCommitResult } from "../../src/contracts/envelope";
import type { BridgeResponse } from "../../src/frontend/bridge";
import type { Amend } from "../../src/frontend/state/workbench";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { contractChecked, fixtureId } from "./bridge-contract";

// tasks.md T069 (feature 004, WP29). Story US11. Spec FR-098 to FR-100, SC-014. Plan D8 "Amend last commit", D15 "Amend last commit".
// Contract Δ3 `reviewCommit` and `commit` with `amend`, and "Untracked upstream".

const trayPath = printOrigin("../../src/frontend/commit/CommitTray.tsx", import.meta.dir);
registerDom();
const { createRoot } = await import("react-dom/client");
const { CommitTray } = await import("../../src/frontend/commit/CommitTray");
const { STALE_TEXT } = await import("../../src/frontend/changes/HunkControls");
const { createDrafts } = await import("../../src/frontend/state/drafts");

type Call = { operation: string; target: Record<string, unknown>; payload: Record<string, unknown>; done?: true; resolve(response: BridgeResponse): void };
const KEY = "a".repeat(64);
const TARGET = { repositoryId: fixtureId(1), repositoryGeneration: 1 };
const SNAPSHOT = fixtureId(2);
const TOKEN = fixtureId(3);
const HEAD = { state: "branch", target: "refs/heads/main", oid: "1".repeat(40) } as const;
const SHORT = "1".repeat(12);
const ok = (result: unknown): BridgeResponse => ({ requestId: fixtureId(0x100), operationId: fixtureId(0x101), state: "succeeded", result }) as BridgeResponse;
const report = (state = "untrusted") => ({ generation: 1, programs: {}, state, persistence: "stored", approvalRequired: { reads: false, commit: false, sync: false, workbench: false, mergetool: false }, entries: [], hooks: [] });
type AmendPart = { headOid?: string; upstream?: { name: string | null; present: boolean } | null; rewritesUpstream?: boolean | "unknown" };
/** Contract Δ3: an amend review result. `approvalRequired` is the review disclosure. `raw` builds any shape, and `review` passes the result schema. */
const raw = (part: AmendPart = {}, disclosure: { approvalRequired: boolean; trust: string } = { approvalRequired: false, trust: "untrusted" }) => ({
  generation: 1,
  head: { ...HEAD, oid: part.headOid ?? HEAD.oid },
  scope: [],
  disclosure,
  limitations: ["Git will run approved hooks. They or other Git tools can change the result during execution."],
  reviewToken: TOKEN,
  amend: { headOid: HEAD.oid, message: "Add login form", upstream: null, rewritesUpstream: false, ...part },
});
const review = (...args: Parameters<typeof raw>) => ReviewCommitResult.parse(raw(...args));
const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});

async function mount(fields: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const bridge = contractChecked(
    new Proxy({}, { get: (_, operation) => (target: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) => new Promise<BridgeResponse>((resolve) => calls.push({ operation: String(operation), target, payload, resolve })) }),
  );
  const drafts = createDrafts({ write: async () => "saved", remove: async () => "saved", read: async () => null } as never);
  const trustRequests: ((approved: boolean) => void)[] = [];
  const props = {
    bridge,
    target: TARGET,
    snapshotId: SNAPSHOT,
    worktreeKey: KEY,
    drafts,
    head: HEAD,
    staged: 1,
    status: null,
    requestTrust: () => new Promise<boolean>((resolve) => trustRequests.push(resolve)),
    ...fields,
  };
  // The window session holds the box state (data-model §14).
  function Session() {
    const [amend, setAmend] = useState<Amend | null>(null);
    return <CommitTray {...(props as unknown as Parameters<typeof CommitTray>[0])} amend={{ value: amend, onChange: setAmend }} />;
  }
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(<Session />));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const field = host.querySelector("textarea")!;
  const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const commit = [...host.querySelectorAll("button")].find((b) => b.textContent === "Commit (Ctrl+Enter)")!;
  const type = async (text: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const click = async (element: HTMLElement) => {
    await act(async () => element.click());
    await flush();
  };
  const pending = (operation: string) => calls.filter((c) => c.operation === operation);
  const open = (operation: string) => calls.some((c) => c.operation === operation && c.done === undefined);
  const answer = async (operation: string, response: BridgeResponse) => {
    const call = calls.findLast((c) => c.operation === operation && c.done === undefined);
    if (call === undefined) throw new Error(`no open ${operation} call`);
    call.done = true;
    await act(async () => call.resolve(response));
    await flush();
  };
  /** Clicks Commit and answers its amend review. A readTrust before the review gets a report that needs no approval for commit. */
  const commitWith = async (result: unknown, trustState = "untrusted") => {
    await click(commit);
    if (open("readTrust")) await answer("readTrust", ok(report(trustState)));
    await answer("reviewCommit", ok(result));
  };
  /** Checks the box and answers its review with `part`. */
  const check = async (part: AmendPart = {}) => {
    await click(box);
    await answer("reviewCommit", ok(review(part)));
  };
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const dialogButton = (name: string) => [...(dialog()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === name)!;
  return { host, field, box, commit, type, click, calls, pending, open, answer, commitWith, check, dialog, dialogButton, trustRequests };
}
const describedBy = (element: Element) => (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");

describe("Amend last commit box (FR-098)", () => {
  test("the box is unavailable with its reason for an unborn branch and during a merge or a rebase, and a click sends nothing", async () => {
    const unborn = await mount({ head: { state: "unborn", target: "refs/heads/main" } });
    expect(unborn.box.closest("label")!.textContent).toBe("Amend last commit");
    expect(describedBy(unborn.box)).toBe("Amend last commit is unavailable: The branch has no commits yet.");
    await unborn.click(unborn.box);
    expect(unborn.calls).toEqual([]);
    expect(unborn.box.checked).toBe(false);
    for (const operationState of ["merging", "rebasing"]) {
      const t = await mount({ operationState });
      expect(describedBy(t.box)).toBe("Amend last commit is unavailable: A merge or a rebase is in progress.");
      await t.click(t.box);
      expect(t.calls).toEqual([]);
    }
  });

  test("checking loads the HEAD message and states Commit replaces commit <short ID>, and clearing restores the draft", async () => {
    const t = await mount();
    await t.type("My draft");
    await t.click(t.box);
    expect(t.calls.map((c) => [c.operation, c.payload])).toEqual([["reviewCommit", { snapshotId: SNAPSHOT, amend: true }]]);
    // A draft typed while the message loads stays the draft.
    await t.type("My later draft");
    await t.answer("reviewCommit", ok(review()));
    expect(t.box.checked).toBe(true);
    expect(t.field.value).toBe("Add login form");
    expect(t.host.textContent).toContain(`Commit replaces commit ${SHORT}.`);
    await t.click(t.box);
    expect(t.box.checked).toBe(false);
    expect(t.field.value).toBe("My later draft");
    expect(t.host.textContent).not.toContain("Commit replaces commit");
  });

  test("a refused amend review leaves the box clear and shows the code", async () => {
    const t = await mount();
    await t.click(t.box);
    await t.answer("reviewCommit", { requestId: fixtureId(0x102), state: "failed", code: "COMMIT_ENCODING_UNSUPPORTED" } as BridgeResponse);
    expect(t.box.checked).toBe(false);
    expect(t.host.textContent).toContain("Amend last commit did not start: COMMIT_ENCODING_UNSUPPORTED");
  });

  for (const [name, result] of [
    ["without the amend part", { ...review(), amend: undefined }],
    ["with an amend part of another shape", raw({ rewritesUpstream: "maybe" as never })],
    ["with an upstream fact that breaks the schema", raw({ upstream: { name: "refs/remotes/origin/main", present: true }, rewritesUpstream: "unknown" })],
  ] as const) {
    test(`a succeeded review ${name} leaves the box clear and names the unknown form`, async () => {
      const t = await mount();
      await t.type("My draft");
      await t.click(t.box);
      await t.answer("reviewCommit", ok(result));
      expect(t.box.checked).toBe(false);
      expect(t.field.value).toBe("My draft");
      expect(t.host.querySelector('[role="status"]')!.textContent).toBe("Amend last commit did not complete: the result has an unknown form.");
    });
  }

  test("no renderer state for a review without the amend part remains", async () => {
    expect((await Bun.file(trayPath).text()).includes("The review result holds no HEAD message.")).toBe(false);
  });
});

describe("Commit with Amend last commit (FR-099, FR-100)", () => {
  test("rewritesUpstream false commits with amend and without the confirmation", async () => {
    const t = await mount({ staged: 0 });
    await t.check();
    await t.commitWith(review({ upstream: { name: "refs/remotes/origin/main", present: true }, rewritesUpstream: false }));
    expect(t.dialog()).toBeNull();
    expect(t.pending("commit").map((c) => c.payload)).toEqual([{ reviewToken: TOKEN, message: "Add login form", confirmFullScope: true, amend: true }]);
  });

  test("rewritesUpstream true opens the modal confirmation with Cancel first, and sends confirmRewrite only after Amend", async () => {
    const t = await mount();
    await t.check();
    await t.commitWith(review({ upstream: { name: "refs/remotes/origin/main", present: true }, rewritesUpstream: true }));
    expect(t.dialog()!.textContent).toContain("Amend last commit?");
    expect(t.dialog()!.textContent).toContain(`Amend rewrites commit ${SHORT}, which origin/main already has. The next push needs Force push with lease.`);
    expect(document.activeElement?.textContent).toBe("Cancel");
    await t.click(t.dialogButton("Cancel"));
    expect(t.dialog()).toBeNull();
    expect(t.pending("commit")).toEqual([]);

    await t.commitWith(review({ upstream: { name: "refs/remotes/origin/main", present: true }, rewritesUpstream: true }));
    expect(t.pending("commit")).toEqual([]);
    await t.click(t.dialogButton("Amend"));
    expect(t.pending("commit").map((c) => c.payload)).toEqual([{ reviewToken: TOKEN, message: "Add login form", confirmFullScope: true, amend: true, confirmRewrite: true }]);
  });

  for (const [name, upstream, shown] of [
    ["an upstream that the repository does not hold", { name: "refs/remotes/origin/gone", present: false }, "the upstream branch refs/remotes/origin/gone"],
    ["an untracked upstream with its remote-side ref", { name: "refs/heads/main", present: false }, "the upstream branch refs/heads/main"],
    ["an untracked upstream without an exact name", { name: null, present: false }, "the upstream branch"],
  ] as const) {
    test(`rewritesUpstream unknown with ${name} needs the same confirmation with the unknown text`, async () => {
      const t = await mount();
      await t.check();
      await t.commitWith(review({ upstream, rewritesUpstream: "unknown" }));
      expect(t.dialog()!.textContent).toContain(`Arbareto cannot check whether ${shown} holds this commit. Amend rewrites it if it was pushed.`);
      expect(document.activeElement?.textContent).toBe("Cancel");
      expect(t.pending("commit")).toEqual([]);
      await t.click(t.dialogButton("Amend"));
      expect(t.pending("commit").map((c) => c.payload.confirmRewrite)).toEqual([true]);
    });
  }

  test("a commit review without a valid amend part names the unknown form, not the Stale text, and sends no commit", async () => {
    const t = await mount();
    await t.check();
    await t.commitWith({ ...review(), amend: undefined });
    expect(t.pending("commit")).toEqual([]);
    expect(t.host.querySelector('[role="status"]')!.textContent).toBe("Commit did not complete: the result has an unknown form.");
  });

  test("a review with a moved HEAD refuses with the Stale text and sends no commit", async () => {
    const t = await mount();
    await t.check();
    await t.commitWith(review({ headOid: "2".repeat(40) }));
    expect(t.pending("commit")).toEqual([]);
    expect(t.host.textContent).toContain(STALE_TEXT);
  });
});

describe("Amend trust (contract Δ3 disclosure)", () => {
  test("a commit review whose disclosure breaks the result schema names the unknown form, asks no trust, and sends no commit", async () => {
    const t = await mount();
    await t.check();
    const result = { ...review(), disclosure: { approvalRequired: "yes", trust: "untrusted" } };
    expect(ReviewCommitResult.safeParse(result).success).toBe(false);
    await t.commitWith(result);
    expect(t.trustRequests.length).toBe(0);
    expect(t.pending("commit")).toEqual([]);
    expect(t.host.querySelector('[role="status"]')!.textContent).toBe("Commit did not complete: the result has an unknown form.");
  });

  test("the amend review disclosure asks for approval even when readTrust needs none for commit, and a refused approval sends no commit", async () => {
    const t = await mount();
    await t.check();
    // A readTrust before the review needs no approval for commit, so it alone never asks.
    await t.commitWith(review({}, { approvalRequired: true, trust: "untrusted" }));
    if (t.open("readTrust")) await t.answer("readTrust", ok(report()));
    expect(t.trustRequests.length).toBe(1);
    await act(async () => t.trustRequests[0]!(false));
    await flush();
    expect(t.pending("commit")).toEqual([]);
  });

  test("after an approval the commit reviews again and commits with the new token", async () => {
    const t = await mount();
    await t.check();
    await t.commitWith(review({}, { approvalRequired: true, trust: "untrusted" }));
    if (t.open("readTrust")) await t.answer("readTrust", ok(report()));
    const reviews = t.pending("reviewCommit").length;
    await act(async () => t.trustRequests[0]!(true));
    await flush();
    expect(t.pending("commit")).toEqual([]);
    expect(t.pending("reviewCommit").length).toBe(reviews + 1);
    expect(t.pending("reviewCommit").at(-1)!.payload).toEqual({ snapshotId: SNAPSHOT, amend: true });
    await t.answer("reviewCommit", ok({ ...review({}, { approvalRequired: true, trust: "approved" }), reviewToken: fixtureId(4) }));
    expect(t.trustRequests.length).toBe(1);
    expect(t.pending("commit").map((c) => c.payload.reviewToken)).toEqual([fixtureId(4)]);
  });

  test("an approved workspace commits the amend without the Trust dialog", async () => {
    const t = await mount();
    await t.check();
    await t.commitWith(review({}, { approvalRequired: true, trust: "approved" }), "approved");
    expect(t.trustRequests).toEqual([]);
    expect(t.pending("commit").length).toBe(1);
  });
});
