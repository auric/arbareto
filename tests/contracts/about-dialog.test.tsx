// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { Environment } from "../../src/contracts/envelope";
import type { BridgeResponse } from "../../src/frontend/bridge";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";

printOrigin("../../src/frontend/about/AboutDialog.tsx", import.meta.dir);
// tests/dom.ts: Base UI must first evaluate with a DOM, so the modules that load it come after registerDom().
registerDom();
const { createRoot } = await import("react-dom/client");
const { AboutDialog } = await import("../../src/frontend/about/AboutDialog");

// Feature 007 contracts/release.md §5 and §6, plan.md D7.
type Target = "hunspell-source" | "tag-source";
// The `bridge` prop of `AboutDialog`.
type ReleaseBridge = { openReleaseLink(payload: { target: Target }): Promise<BridgeResponse> };

const COMMIT = "c950776a2b4e0c2f6f7e6b1d9a1f3c5e7d9b0a12";
const NOTICES = { repositoryUrl: "https://github.com/auric/arbareto", project: { license: "AGPL text", notice: "NOTICE text" }, texts: [], groups: [] };
const LOCAL_TEXT = "Unsigned local test package";
const BUTTONS = ["Hunspell source", "Source at this commit"] as const;
const TARGETS: Record<(typeof BUTTONS)[number], Target> = { "Hunspell source": "hunspell-source", "Source at this commit": "tag-source" };
const SUCCEEDED = { requestId: null, state: "succeeded" } as unknown as BridgeResponse;
// Contract §5: the shell result value of `ShellExecuteW`.
const OPEN_FAILED = { requestId: null, state: "failed", code: "RELEASE_LINK_OPEN_FAILED", result: { shellExecuteResult: 2 } } as unknown as BridgeResponse;

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

async function renderAbout(channel: Environment["buildIdentity"]["channel"], reply: BridgeResponse | (() => Promise<BridgeResponse>) = SUCCEEDED) {
  const calls: { target: Target }[] = [];
  const bridge: ReleaseBridge = {
    openReleaseLink: async (payload) => {
      calls.push(payload);
      return typeof reply === "function" ? reply() : reply;
    },
  };
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const build = { version: "0.1.0", commit: COMMIT, channel };
  await act(async () =>
    root.render(<AboutDialog open scope="qualification-target" build={build} notices={NOTICES} client={{ width: 1280, height: 800 }} finalFocus={() => null} onClose={() => {}} bridge={bridge} />),
  );
  unmounts.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const panel = [...dialog.querySelectorAll<HTMLElement>('[role="tabpanel"]')].find((p) => !p.hidden)!;
  const button = (name: string) => [...dialog.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name);
  return { calls, dialog, panel, button };
}

// The browser activates a focused button with a click after Enter keydown or Space keyup (HTML "activation behavior").
async function press(element: HTMLElement, key: "Enter" | " ") {
  await act(async () => {
    element.focus();
    const down = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    element.dispatchEvent(down);
    if (key === "Enter" && !down.defaultPrevented) element.click();
    const up = new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true });
    element.dispatchEvent(up);
    if (key === " " && !down.defaultPrevented && !up.defaultPrevented) element.click();
  });
}

describe("About preview marker and release links", () => {
  test("channel local shows the unsigned local test package line and no release button", async () => {
    const { panel, button } = await renderAbout("local");
    expect(panel.textContent).toContain(LOCAL_TEXT);
    expect(panel.textContent).not.toMatch(/\bPreview\b/);
    for (const name of BUTTONS) expect(button(name)).toHaveLength(0);
  });

  test("channel preview shows the Preview line, no local package line, and both release buttons", async () => {
    const { panel, button } = await renderAbout("preview");
    expect([...panel.querySelectorAll("p")].some((p) => p.textContent?.trim() === "Preview")).toBe(true);
    expect(panel.textContent).not.toContain(LOCAL_TEXT);
    for (const name of BUTTONS) expect(button(name)).toHaveLength(1);
  });

  test("the scope line follows the channel: the test build line for local, the preview line for preview", async () => {
    const LOCAL_SCOPE = "This test build covers opening repositories";
    const PREVIEW_SCOPE = "This preview is not a qualified release. The qualification of Windows 11 x64 continues.";
    const local = await renderAbout("local");
    expect(local.panel.textContent).toContain(LOCAL_SCOPE);
    expect(local.panel.textContent).not.toContain(PREVIEW_SCOPE);
    for (const unmount of unmounts.splice(0)) unmount();
    const preview = await renderAbout("preview");
    expect(preview.panel.textContent).toContain(PREVIEW_SCOPE);
    expect(preview.panel.textContent).not.toContain(LOCAL_SCOPE);
  });

  test("Tab reaches each release button: a native button, enabled, in the tab order", async () => {
    const { button } = await renderAbout("preview");
    for (const name of BUTTONS) {
      const [element] = button(name);
      expect(element?.tagName).toBe("BUTTON");
      expect(element!.disabled).toBe(false);
      expect(element!.getAttribute("aria-disabled")).not.toBe("true");
      expect(element!.tabIndex).toBe(0);
      expect(element!.closest("[inert],[aria-hidden='true']")).toBeNull();
      element!.focus();
      expect(document.activeElement).toBe(element!);
    }
  });

  for (const key of ["Enter", " "] as const) {
    test(`${key === " " ? "Space" : key} on each release button calls openReleaseLink with only its target`, async () => {
      const { calls, button } = await renderAbout("preview");
      for (const name of BUTTONS) await press(button(name)[0]!, key);
      expect(calls).toEqual(BUTTONS.map((name) => ({ target: TARGETS[name] })));
    });
  }

  test("while one release request runs, both release buttons are disabled and a second press sends no request", async () => {
    let finish: (response: BridgeResponse) => void = () => {};
    const { calls, button } = await renderAbout("preview", () => new Promise((resolve) => (finish = resolve)));
    await press(button("Hunspell source")[0]!, "Enter");
    for (const name of BUTTONS) expect(button(name)[0]!.disabled).toBe(true);
    await press(button("Source at this commit")[0]!, "Enter");
    await press(button("Hunspell source")[0]!, " ");
    expect(calls).toEqual([{ target: "hunspell-source" }]);
    await act(async () => finish(SUCCEEDED));
    for (const name of BUTTONS) expect(button(name)[0]!.disabled).toBe(false);
  });

  test("a RELEASE_LINK_OPEN_FAILED result shows the failure text with its code", async () => {
    const { panel, button } = await renderAbout("preview", OPEN_FAILED);
    const codes = () => [...panel.querySelectorAll("code")].map((c) => c.textContent);
    expect(codes()).not.toContain("RELEASE_LINK_OPEN_FAILED");
    await press(button("Hunspell source")[0]!, "Enter");
    expect(codes()).toContain("RELEASE_LINK_OPEN_FAILED");
    // Plan.md D7 "Release link failure text".
    expect(panel.querySelector('[role="alert"]')?.textContent).toBe("Hunspell source did not complete: RELEASE_LINK_OPEN_FAILED.");
  });
});
