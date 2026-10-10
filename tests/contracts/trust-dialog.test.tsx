// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, test } from "bun:test";
import { act, useRef, useState } from "react";
import type { TrustReport } from "../../src/frontend/trust/TrustDialog";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";

printOrigin("../../src/frontend/trust/TrustDialog.tsx", import.meta.dir);
registerDom();
const { createRoot } = await import("react-dom/client");
const { SAVE_FAILED_TEXT, SaveFailedNotice, TrustDialog, trustBeforeReview } = await import("../../src/frontend/trust/TrustDialog");

type Report = TrustReport;
// Contract §3 `readTrust` field values for the dialog input.
const REPORT: Report = {
  generation: 3,
  fingerprint: "a".repeat(64),
  state: "untrusted",
  persistence: "stored",
  approvalRequired: { reads: true, commit: true },
  entries: [{ key: "core.hooksPath", scope: "local", origin: "file:.git/config", value: ".githooks" }],
  hooks: [{ event: "pre-commit", path: ".githooks/pre-commit", repositoryControlled: true }],
};
const SESSION = "Arbareto cannot check these program files for later edits. This approval lasts until Arbareto closes or its Git service restarts.";

// The bridge double answers `approveTrust` with the queued responses in order and records each call.
function bridgeDouble(...responses: unknown[]) {
  const calls: unknown[][] = [];
  return { calls, bridge: { approveTrust: (...args: unknown[]) => (calls.push(args), Promise.resolve(responses.shift())) } };
}

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
async function press(target: Element, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key, code: key, bubbles: true, cancelable: true }));
  });
  await settle();
}
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)!;
const popup = () => document.querySelector<HTMLElement>('[role="dialog"]');
const heading = () => popup()!.querySelector<HTMLElement>("h2")!;

// An opener button opens the dialog, as the repository menu or the review action does.
async function mount(report: Report, bridge: ReturnType<typeof bridgeDouble>["bridge"], client = { width: 1280, height: 800 }) {
  const events: string[] = [];
  const approved: unknown[] = [];
  const failed: unknown[] = [];
  function Host() {
    const [open, setOpen] = useState(false);
    const opener = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button type="button" ref={opener} onClick={() => setOpen(true)}>
          Review repository trust
        </button>
        <TrustDialog
          open={open}
          report={report}
          repositoryId="repository-1"
          bridge={bridge as never}
          client={client}
          finalFocus={opener}
          onCancel={() => (events.push("cancel"), setOpen(false))}
          onApproved={(result) => (approved.push(result), setOpen(false))}
          onFailed={(response) => void failed.push(response)}
        />
      </>
    );
  }
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(<Host />));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const opener = button("Review repository trust");
  opener.focus();
  await act(async () => opener.click());
  await settle();
  return { opener, events, approved, failed };
}
const mountWithFailure = (response: unknown) => mount(REPORT, bridgeDouble(response).bridge);

const tabbable = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>("*")].filter((e) => e.tabIndex >= 0 && !e.hasAttribute("disabled"));

describe("trust dialog (plan.md \"Keyboard and focus\" Trust dialog row)", () => {
  test("Trust required: initial focus goes to the heading, never to Approve, and the Tab order is policy text, Cancel, Approve", async () => {
    await mount(REPORT, bridgeDouble().bridge);
    expect(heading().textContent).toBe("Trust required");
    expect(document.activeElement).toBe(heading());
    const order = tabbable(popup()!);
    expect(order.map((e) => (e.tagName === "BUTTON" ? e.textContent!.trim() : e.getAttribute("aria-labelledby") === heading().id ? "policy" : e.outerHTML))).toEqual([
      "policy",
      "Cancel",
      "Approve",
    ]);
  });

  test("Trust changed takes its heading from state changed", async () => {
    await mount({ ...REPORT, state: "changed", trustId: "trust-1" }, bridgeDouble().bridge);
    expect(heading().textContent).toBe("Trust changed");
  });

  test("Enter on the heading activates nothing, and Escape cancels and returns focus to the opener", async () => {
    const double = bridgeDouble();
    const { opener, events } = await mount(REPORT, double.bridge);
    await press(heading(), "Enter");
    expect(double.calls).toEqual([]);
    expect(popup()).not.toBeNull();
    await press(heading(), "Escape");
    expect(events).toEqual(["cancel"]);
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test("Approve sends approveTrust with the issued fingerprint; a declined native confirmation keeps the dialog and focuses Approve", async () => {
    const double = bridgeDouble({ requestId: "r1", state: "canceled" });
    const { approved } = await mount(REPORT, double.bridge);
    await act(async () => button("Approve").click());
    await settle();
    expect(double.calls).toEqual([[{ repositoryId: "repository-1", repositoryGeneration: 3 }, { fingerprint: REPORT.fingerprint, approve: true }]]);
    expect(approved).toEqual([]);
    expect(popup()).not.toBeNull();
    expect(document.activeElement).toBe(button("Approve"));
  });

  test("after an approval, the result reaches onApproved and focus returns to the opener", async () => {
    const result = { trustId: "trust-1", persistence: "session", saveFailed: true };
    const { opener, approved } = await mount(REPORT, bridgeDouble({ requestId: "r1", state: "succeeded", result }).bridge);
    await act(async () => button("Approve").click());
    await settle();
    expect(approved).toEqual([result]);
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test("a changed fingerprint (failed with TRUST_CHANGED) keeps the dialog open and reaches onFailed, never onApproved", async () => {
    const failed = { requestId: "r1", state: "failed", code: "TRUST_CHANGED" };
    const host = await mountWithFailure(failed);
    await act(async () => button("Approve").click());
    await settle();
    expect(host.approved).toEqual([]);
    expect(host.failed).toEqual([failed]);
    expect(popup()).not.toBeNull();
  });

  test("the save-failed notice holds the contract §7 text", () => {
    expect(SAVE_FAILED_TEXT).toBe("Arbareto could not save this approval. This approval lasts until Arbareto closes or its Git service restarts.");
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<SaveFailedNotice />));
    expect(host.textContent).toContain(SAVE_FAILED_TEXT);
    act(() => root.unmount());
    host.remove();
  });

  test("the dialog is 560x440 DIPs, clamped to the client minus 16 DIPs a side, and only the policy text scrolls", async () => {
    await mount(REPORT, bridgeDouble().bridge, { width: 500, height: 400 });
    expect([popup()!.style.width, popup()!.style.height]).toEqual(["468px", "368px"]);
    // `cn` merges conflicts, so no generated width cap or grid layout stays.
    expect(popup()!.className.split(" ").filter((c) => /^(sm:)?max-w-(?!none)|^grid$/.test(c))).toEqual([]);
    const scrolling = [...popup()!.querySelectorAll<HTMLElement>("*")].filter((e) => /\boverflow-(y-)?auto\b/.test(e.className));
    expect(scrolling).toHaveLength(1);
    expect(scrolling[0]!.contains(button("Approve"))).toBe(false);
    expect(scrolling[0]!.contains(button("Cancel"))).toBe(false);
  });

  test("the policy text shows each entry and hook, and the code-execution sentence", async () => {
    await mount(REPORT, bridgeDouble().bridge);
    const text = popup()!.textContent!;
    expect(text).toContain("Approval lets Git run the programs that this repository's configuration names.");
    expect(text).toContain("core.hooksPath=.githooks");
    expect(text).toContain("file:.git/config");
    expect(text).toContain(".githooks/pre-commit");
    expect(text).not.toContain(SESSION);
  });

  test("persistence session names the reached digest bound and states the session-only text", async () => {
    await mount({ ...REPORT, persistence: "session", bound: "file-count" }, bridgeDouble().bridge);
    const text = popup()!.textContent!;
    expect(text).toContain("Reached bound: 64 files.");
    expect(text).toContain(SESSION);
  });

  test("commit review shows the dialog first only when approval is required for commit and not approved", () => {
    expect(trustBeforeReview({ ...REPORT, approvalRequired: { reads: false, commit: true } })).toBe(true);
    expect(trustBeforeReview({ ...REPORT, state: "changed", trustId: "t" })).toBe(true);
    expect(trustBeforeReview({ ...REPORT, approvalRequired: { reads: true, commit: false } })).toBe(false);
    expect(trustBeforeReview({ ...REPORT, state: "approved", trustId: "t" })).toBe(false);
  });

  test.todo("the dialog explains that approval persists across launches until Revoke trust, or a repository, selected Git path, or policy change (needs a contract §7 text)", () => {});
});
