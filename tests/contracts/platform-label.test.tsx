// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { Environment } from "../../src/contracts/envelope";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";

printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
printOrigin("../../src/frontend/about/AboutDialog.tsx", import.meta.dir);
// `RepositoryMenu.tsx` loads Base UI. Base UI must first evaluate with a DOM, because test files share one module cache (tests/dom.ts).
registerDom();
const { renderToStaticMarkup } = await import("react-dom/server");
const { GitSegment } = await import("../../src/frontend/app/Workbench");
const { createRoot } = await import("react-dom/client");
const { AboutDialog, AboutOverview } = await import("../../src/frontend/about/AboutDialog");

// plan.md "Provisional prerequisite admission" and "About window": the label shows only with platform scope `other`.
const LABEL = "Unqualified platform";
const SCOPES: Environment["platformScope"][] = ["other", "qualification-target"];
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const BUILD: Environment["buildIdentity"] = { version: "0.1.0", commit: "c950776a2b4e0c2f6f7e6b1d9a1f3c5e7d9b0a12", channel: "local" };
// A `local` build shows no release button, so these cases never call the bridge.
const BRIDGE = { openReleaseLink: () => Promise.reject(new Error("unused")) };

describe("Unqualified platform label", () => {
  for (const scope of SCOPES) {
    test(`the status bar Git segment with scope ${scope} ${scope === "other" ? "shows" : "does not show"} the label`, () => {
      const text = plain(renderToStaticMarkup(<GitSegment version="2.55.0.windows.1" distro={null} scope={scope} />));
      expect(text).toContain("Git 2.55.0.windows.1");
      expect(text.includes(LABEL)).toBe(scope === "other");
    });

    test(`the About overview with scope ${scope} ${scope === "other" ? "shows" : "does not show"} the label`, () => {
      expect(plain(renderToStaticMarkup(<AboutOverview scope={scope} build={BUILD} repositoryUrl="https://github.com/auric/arbareto" bridge={BRIDGE} />)).includes(LABEL)).toBe(scope === "other");
    });
  }
});

// 006 tasks.md T049, plan.md D18 "About source line" (user decision of 2026-10-24).
test("the About overview names the Hunspell source of the release of this version", () => {
  const text = plain(renderToStaticMarkup(<AboutOverview scope="qualification-target" build={BUILD} repositoryUrl="https://github.com/auric/arbareto" bridge={BRIDGE} />));
  expect(text).toContain("Hunspell source (LGPL-2.1): https://github.com/auric/arbareto/releases (release 0.1.0)");
});

// T123 (plan.md D15 "About window"): `index.css` sets `user-select: none` on the body, so copyable text needs `select-text`.
describe("About text selection", () => {
  const NOTICES = { repositoryUrl: "https://github.com/auric/arbareto", project: { license: "AGPL text", notice: "NOTICE text" }, texts: ["MIT text"], groups: [] };
  const unmounts: (() => void)[] = [];
  afterEach(() => {
    for (const unmount of unmounts.splice(0)) unmount();
    document.getSelection()?.removeAllRanges();
  });

  test("the Build line of the Overview is inside a select-text root", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<AboutOverview scope="qualification-target" build={BUILD} repositoryUrl={NOTICES.repositoryUrl} bridge={BRIDGE} />);
    const build = [...host.querySelectorAll("p")].find((p) => p.textContent?.startsWith("Build:"))!;
    expect(build.closest(".select-text")).not.toBeNull();
    expect(host.firstElementChild!.classList.contains("select-text")).toBe(true);
  });

  // Blink SelectAll matches `keyCode` 65 (`editing_behavior.cc`). The Ukrainian layout gives "ф" on that key; AZERTY puts VK_A on the physical Q key.
  for (const [layout, init] of [
    ["US", { key: "a", code: "KeyA", keyCode: 65 }],
    ["Ukrainian", { key: "ф", code: "KeyA", keyCode: 65 }],
    ["AZERTY", { key: "a", code: "KeyQ", keyCode: 65 }],
  ] as const)
  test(`Ctrl+A (${layout} layout) in the focused Overview panel selects only that panel and cancels the default action`, async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(<AboutDialog open scope="qualification-target" build={BUILD} notices={NOTICES} client={{ width: 1280, height: 800 }} finalFocus={() => null} onClose={() => {}} bridge={BRIDGE} />));
    unmounts.push(() => {
      act(() => root.unmount());
      host.remove();
    });
    const panel = [...document.querySelectorAll<HTMLElement>('[role="tabpanel"]')].find((p) => !p.hidden && p.textContent?.includes("Build:"))!;
    expect(panel !== undefined).toBe(true);
    await act(async () => panel.focus());
    const event = new KeyboardEvent("keydown", { ...init, ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => void panel.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    const selection = document.getSelection()!;
    expect(selection.rangeCount).toBe(1);
    expect(panel.contains(selection.getRangeAt(0).commonAncestorContainer)).toBe(true);
    expect(selection.toString()).toContain(`Build: 0.1.0 ${BUILD.commit}`);
  });
});

// 006 tasks.md T036, plan.md D18: About shows the fixed `hunspell-wasm` note beside its licence texts.
test("the Third-party notices tab shows the hunspell-wasm note beside its licence texts", async () => {
  const NOTE =
    "Arbareto uses Hunspell under LGPL-2.1. Source used: https://github.com/rotemdan/hunspell-wasm (commit 8f755ef64e8b047b77b676f9698b3dfa5cb1887d, lib/hunspell/ and Makefile). The lib/hunspell/ files equal https://github.com/hunspell/hunspell (commit edb619100791110d3e34f09ec35392ad327c1135).";
  const notices = {
    repositoryUrl: "https://github.com/auric/arbareto",
    project: { license: "AGPL text", notice: "NOTICE text" },
    texts: ["GPL 2 text", "LGPL 2.1 text", "MPL 1.1 text"],
    groups: [{ license: "(LGPL-2.0 OR GPL-2.0 OR MPL-1.1)", packages: [{ name: "hunspell-wasm", version: "0.3.0", note: NOTE, files: [{ name: "COPYING", text: 0 }, { name: "COPYING.LESSER", text: 1 }, { name: "COPYING.MPL", text: 2 }] }] }],
  };
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(<AboutDialog open scope="qualification-target" build={BUILD} notices={notices as never} client={{ width: 1280, height: 800 }} finalFocus={() => null} onClose={() => {}} bridge={BRIDGE} />));
  try {
    const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === "Third-party notices")!;
    await act(async () => tab.click());
    const panel = [...document.querySelectorAll<HTMLElement>('[role="tabpanel"]')].find((p) => !p.hidden && p.textContent?.includes("hunspell-wasm 0.3.0"))!;
    expect(panel !== undefined).toBe(true);
    const entry = [...panel.querySelectorAll("h4")].find((h) => h.textContent === "hunspell-wasm 0.3.0")!.parentElement!;
    expect([...entry.querySelectorAll("p")].map((p) => p.textContent)).toContain(NOTE);
    expect(entry.textContent).toContain("GPL 2 text");
    expect(entry.textContent).toContain("LGPL 2.1 text");
    expect(entry.textContent).toContain("MPL 1.1 text");
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
