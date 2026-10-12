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

  test("a shell PICKER_FAILED refusal without a result shows its code and the folder dialog text", async () => {
    const host = await show(<states.RepositoryRefused code="PICKER_FAILED" result={undefined} onOpenRepository={noop} />);
    for (const part of ["The repository did not open: PICKER_FAILED", states.PICKER_FAILED_TEXT]) expect(text(host)).toContain(part);
    expect(buttons(host)).toEqual(["Open repository"]);
  });

  test("Loading shows the placeholder without content, the Refreshing marker only for a user Refresh, and nothing for a poll", async () => {
    expect(text(await show(<states.Loading hasContent={false} refreshing={false} />))).toBe("Loading…");
    expect(text(await show(<states.Loading hasContent refreshing />))).toBe("Refreshing…");
    expect(text(await show(<states.Loading hasContent refreshing={false} />))).toBe("");
  });

  test("No selection shows the hint and the full Unstaged help line", async () => {
    const host = await show(<states.NoSelection />);
    expect(text(host)).toContain("Select a file to view its changes");
    expect(text(host)).toContain("Arrow keys show a file. Space stages or unstages it.");
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

  test("Unsupported or binary shows the limitation sentence, and the remedy with Copy command only for an entry that applyFile refuses", async () => {
    const remedy = { text: "Stage this file in a terminal.", command: "& 'C:\\Git\\cmd\\git.exe' --literal-pathspecs -C 'D:\\repo' add -- 'big.bin'" };
    const refused = await show(<states.UnsupportedState support="size" fileAction="size" remedy={remedy} />);
    for (const part of ["This file is larger than the Arbareto size limit.", remedy.text, remedy.command]) expect(text(refused)).toContain(part);
    expect(buttons(refused)).toEqual(["Copy command"]);
    const accepted = await show(<states.UnsupportedState support="binary" fileAction="stage" remedy={remedy} />);
    expect(text(accepted)).toBe("Git reports binary content in this file.");
    expect(buttons(accepted)).toEqual([]);
  });

  // plan.md "Limitation text": one sentence per data-model §5 "Support decision" reason, never the raw value.
  for (const [support, sentence] of [
    ["binary", "Git reports binary content in this file."],
    ["encoding", "This file is not valid UTF-8 text, or Git converts its encoding."],
    ["size", "This file is larger than the Arbareto size limit."],
    ["rename", "This change is a rename."],
    ["mode", "This change alters the file mode."],
    ["type", "This change alters the file type, or the path is not a regular file."],
    ["symlink", "This entry is a symbolic link."],
    ["submodule", "This entry is a submodule or a nested repository."],
    ["LFS", "Git LFS manages this file."],
    ["filter", "A Git filter applies to this file."],
    ["state", "This file has conflicts."],
    ["line-endings", "This file has mixed line endings, or only the index holds its line-ending attributes."],
    ["index-flag", "This entry is intent-to-add, assume-unchanged, or skip-worktree."],
    ["path", "Arbareto cannot match this path to exactly one file."],
  ] as const) {
    test(`the ${support} reason shows its sentence and never the raw value`, async () => {
      const host = await show(<states.UnsupportedState support={support} fileAction="stage" remedy={null} />);
      expect(text(host)).toBe(sentence);
      expect(host.querySelector("code")).toBeNull();
    });
  }

  test("without a support decision, the unsupported state shows no reason line", async () => {
    expect(text(await show(<states.UnsupportedState support={null} fileAction="stage" remedy={null} />))).toBe("");
  });

  test("CopyButton writes the exact remedy text through navigator.clipboard.writeText", async () => {
    const command = "& 'C:\\Git\\cmd\\git.exe' -C 'D:\\Ünïcødé repo' restore --staged -- 'a b.txt'";
    const written = stubClipboard();
    const host = await show(<states.CopyButton text={command}>Copy command</states.CopyButton>);
    await act(async () => host.querySelector("button")!.click());
    expect(written).toEqual([command]);
  });

  test("a rejected or absent clipboard write reports the copy failure through the context", async () => {
    expect(states.COPY_FAILED_TEXT).toBe("Copy failed. Select the text and copy it with Ctrl+C.");
    let failures = 0;
    const copy = () => (
      <states.CopyFailed value={() => void failures++}>
        <states.CopyButton text="x">Copy path</states.CopyButton>
      </states.CopyFailed>
    );
    Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) } });
    const host = await show(copy());
    await act(async () => host.querySelector("button")!.click());
    expect(failures).toBe(1);
    Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: undefined });
    await act(async () => host.querySelector("button")!.click());
    expect(failures).toBe(2);
    stubClipboard();
    await act(async () => host.querySelector("button")!.click());
    expect(failures).toBe(2);
  });

  // plan.md "Required visible states", No repository (start page).
  describe("start page", () => {
    const SCOPE = "This test build covers opening repositories, recent repositories, status, diffs, hunk and file staging, local commits, submodule updates, one history page, and a read-only reference list.";
    const PATH = "D:\\work\\sample-app";
    function startPage(entries: unknown[]) {
      const calls: string[] = [];
      const reply = (name: string, result: unknown) => async () => (calls.push(name), { requestId: crypto.randomUUID(), state: "succeeded", result });
      const bridge = { listRecentRepositories: reply("listRecentRepositories", { entries }), openRecentRepository: reply("openRecentRepository", {}), removeRecentRepository: reply("removeRecentRepository", { entries }) };
      const folders: number[] = [];
      return { calls, folders, node: <states.StartPage bridge={bridge as never} busy={false} onOpenFolder={() => void folders.push(1)} onOpened={noop} /> };
    }
    const settle = () => act(async () => await new Promise((resolve) => setImmediate(resolve)));

    test("it reads the recent list once and shows each entry with its name and path only, and no branch text", async () => {
      const page = startPage([{ entryId: crypto.randomUUID(), path: PATH, location: { kind: "native" }, openedAt: "2026-10-10T08:00:00Z", current: false }]);
      const host = await show(page.node);
      await settle();
      expect(page.calls).toEqual(["listRecentRepositories"]);
      const options = [...host.querySelectorAll('[role="option"]')];
      expect(options.map((o) => o.getAttribute("aria-label") ?? text(o as HTMLElement))).toEqual(["Open folder… (Ctrl+O)", `sample-app, ${PATH}`]);
      expect(host.querySelector('[role="combobox"]')).not.toBeNull();
      expect(text(host)).toContain(SCOPE);
    });

    test("an empty list reads the empty text, and Open folder… (Ctrl+O) stays", async () => {
      const page = startPage([]);
      const host = await show(page.node);
      await settle();
      expect(text(host)).toContain("No recent repositories. Open a folder to start.");
      const open = [...host.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => text(o) === "Open folder… (Ctrl+O)")!;
      await act(async () => open.click());
      expect(page.folders).toEqual([1]);
    });
  });

  test("Limited output shows the code in the code font and the reason as text", async () => {
    const host = await show(<states.LimitedOutput completeness={{ state: "limited", code: "OUTPUT_LIMIT", reason: "STATUS_LISTING_RECORDS" }} />);
    expect(text(host)).toBe("Incomplete: OUTPUT_LIMIT STATUS_LISTING_RECORDS. Changes that depend on this view stay blocked.");
    expect(host.querySelector("code")!.textContent).toBe("OUTPUT_LIMIT");
  });
});
