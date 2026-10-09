// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";

printOrigin("../../src/frontend/app/RepositoryStates.tsx", import.meta.dir);
// `RepositoryStates.tsx` loads Base UI. Base UI must first evaluate with a DOM, because test files share one module cache (tests/dom.ts).
registerDom();
const { createRoot } = await import("react-dom/client");
const states = await import("../../src/frontend/app/RepositoryStates");

// plan.md "Required visible states". Every shown code, reason, and remedy comes from the input values.

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});
const original = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
afterEach(() => {
  if (original) Object.defineProperty(globalThis.navigator, "clipboard", original);
  else delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
});

async function show(node: ReactNode): Promise<HTMLElement> {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(node));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return host;
}
const text = (host: HTMLElement) => (host.textContent ?? "").replace(/\s+/g, " ").trim();
const buttons = (host: HTMLElement) => [...host.querySelectorAll("button")].map((b) => b.textContent);
function stubClipboard(): string[] {
  const written: string[] = [];
  Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => void written.push(value) } });
  return written;
}
const noop = () => {};

describe("repository states", () => {
  test("Repository refused with REPOSITORY_UNAVAILABLE shows the folder, the remedy text, and the output tail, without Copy command", async () => {
    const result = { path: "D:\\work\\plain-folder", remedy: { text: "Run `git status` in this folder" }, outputTail: "fatal: not a git repository\n" };
    const host = await show(<states.RepositoryRefused code="REPOSITORY_UNAVAILABLE" result={result} onOpenRepository={noop} />);
    for (const part of ["REPOSITORY_UNAVAILABLE", result.path, result.remedy.text, "fatal: not a git repository"]) expect(text(host)).toContain(part);
    expect(buttons(host)).toEqual(["Open repository"]);
  });

  test("another refusal shows its code, its remedy text, and its command with Copy command", async () => {
    const result = { remedy: { text: "Select another folder.", command: "git config --global --add safe.directory D:/x" } };
    const host = await show(<states.RepositoryRefused code="UNSUPPORTED_REPOSITORY" result={result} onOpenRepository={noop} />);
    for (const part of ["UNSUPPORTED_REPOSITORY", result.remedy.text, result.remedy.command]) expect(text(host)).toContain(part);
    expect(buttons(host)).toEqual(["Copy command", "Open repository"]);
  });

  test("Loading shows the placeholder without content, the Refreshing marker only for a user Refresh, and nothing for a poll", async () => {
    expect(text(await show(<states.Loading hasContent={false} refreshing={false} />))).toBe("Loading…");
    expect(text(await show(<states.Loading hasContent refreshing />))).toBe("Refreshing…");
    expect(text(await show(<states.Loading hasContent refreshing={false} />))).toBe("");
  });

  test("No selection shows the hint and the full Unstaged help line", async () => {
    const host = await show(<states.NoSelection />);
    expect(text(host)).toContain("Select a file to view its changes");
    expect(text(host)).toContain("Enter shows a file. Space stages or unstages it. The toolbar stages one hunk.");
  });

  test("Conflicted or unfinished operation names the state from the snapshot and offers only Refresh", async () => {
    const host = await show(<states.ConflictedState operationState="merging" conflicted={3} onRefresh={noop} />);
    expect(text(host)).toContain("A merge is in progress, with 3 conflicted files.");
    expect(buttons(host)).toEqual(["Refresh (F5)"]);
  });

  test("Error with LOCKED shows the lock path with Copy path, the result remedy text, and Refresh", async () => {
    const result = { path: "D:\\repo\\.git\\index.lock", remedy: { text: "Another Git process or a crash left this lock. Remove it only after all Git tools stop, including other Arbareto windows." } };
    const host = await show(<states.ErrorState code="LOCKED" result={result} onRefresh={noop} />);
    for (const part of ["LOCKED", result.path, result.remedy.text]) expect(text(host)).toContain(part);
    expect(buttons(host)).toEqual(["Copy path", "Refresh (F5)"]);
    const written = stubClipboard();
    await act(async () => host.querySelector("button")!.click());
    expect(written).toEqual([result.path]);
  });

  test("Limited output names the code and the reached bound", async () => {
    const host = await show(<states.LimitedOutput completeness={{ state: "limited", code: "OUTPUT_LIMIT", reason: "STATUS_LISTING_RECORDS" }} />);
    expect(text(host)).toContain("OUTPUT_LIMIT STATUS_LISTING_RECORDS");
    expect(text(await show(<states.LimitedOutput completeness={{ state: "complete" }} />))).toBe("");
  });

  test("Large history shows the scope limit", async () => {
    expect(text(await show(<states.LargeHistory />))).toBe("Up to 100 commits");
  });

  test("Unsupported or binary shows the support value, and the remedy with Copy command only for an entry that applyFile refuses", async () => {
    const remedy = { text: "Stage this file in a terminal.", command: "& 'C:\\Git\\cmd\\git.exe' --literal-pathspecs -C 'D:\\repo' add -- 'big.bin'" };
    const refused = await show(<states.UnsupportedState support="size" fileAction="size" remedy={remedy} />);
    for (const part of ["size", remedy.text, remedy.command]) expect(text(refused)).toContain(part);
    expect(buttons(refused)).toEqual(["Copy command"]);
    const accepted = await show(<states.UnsupportedState support="binary" fileAction="stage" remedy={remedy} />);
    expect(text(accepted)).toContain("binary");
    expect(text(accepted)).not.toContain(remedy.text);
    expect(buttons(accepted)).toEqual([]);
  });

  test("CopyButton writes the exact remedy text through navigator.clipboard.writeText", async () => {
    const command = "& 'C:\\Git\\cmd\\git.exe' -C 'D:\\Ünïcødé repo' restore --staged -- 'a b.txt'";
    const written = stubClipboard();
    const host = await show(<states.CopyButton text={command}>Copy command</states.CopyButton>);
    await act(async () => host.querySelector("button")!.click());
    expect(written).toEqual([command]);
  });
});
