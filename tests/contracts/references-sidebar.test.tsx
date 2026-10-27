// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T358 and T362: the read-only references sidebar of `src/frontend/refs/ReferencesSidebar.tsx` (FR-057; plan.md "References sidebar", "Long text",
// "Keyboard and focus" References sidebar row, "Task flow and command placement" Browse references row, "Required visible states" References, and "Status and fallback texts").

import { ArrowDown01Icon, ArrowRight01Icon, Folder01Icon, FolderGitIcon, GitBranchIcon, Tag01Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import type { RefEntry, RefsResult } from "../../src/contracts/envelope";
import type { BranchEntry } from "../../src/frontend/state/workbench";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { stubLayout } from "./history-fake";
import { hoverTooltip } from "./sync-fake";

printOrigin("../../src/frontend/refs/ReferencesSidebar.tsx", import.meta.dir);
registerDom();
const { createRoot } = await import("react-dom/client");
const { ReferencesSidebar } = await import("../../src/frontend/refs/ReferencesSidebar");

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});
async function show(node: ReactNode) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(node));
  const unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  unmounts.push(unmount);
  return { host, unmount };
}
const text = (element: Element | null | undefined) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const ref = (kind: RefEntry["kind"], name: string, commitId: string | null, fields: Partial<RefEntry> = {}): RefEntry => ({
  kind,
  name,
  invalidUtf8: false,
  objectId: commitId ?? C,
  objectType: "commit",
  peeledId: null,
  peeledType: null,
  symref: null,
  upstream: null,
  upstreamPresent: false,
  commitId,
  ...fields,
});
// Git refname order. `feature/x` and the `release/...` names give folders; `main` has none.
const REFS: RefsResult = {
  generation: 1,
  refs: [
    ref("branch", "feature/x", B, { upstream: "refs/remotes/origin/feature/x", upstreamPresent: false }),
    ref("branch", "main", A, { upstream: "refs/remotes/origin/main", upstreamPresent: true }),
    ref("branch", "release/1.0", C),
    ref("branch", "release/2.0", C),
    ref("remote", "origin/HEAD", A, { symref: "refs/remotes/origin/main" }),
    ref("remote", "origin/main", A),
    ref("remote", "origin/release/1.0", C),
    ref("remote", "upstream/main", C),
    ref("tag", "v1.0", B, { objectType: "tag", peeledId: B, peeledType: "commit" }),
  ],
  current: { name: "main", objectId: A },
  refsDigest: "0".repeat(64),
  completeness: { state: "complete" },
};
// The history list reads A and B. C is not loaded yet (contract Δ3 target `unknown`).
const LOADED = new Set([A, B]);
// Feature 005 spec FR-064: the 003 track state `gone` of feature/x gives the gone mark.
const GONE = new Map([["feature/x", { text: "Upstream gone", label: "Upstream gone", state: "gone" as const }]]);

type Props = Partial<Parameters<typeof ReferencesSidebar>[0]>;
let repositories = 0;
async function sidebar(props: Props = {}) {
  const selected: string[] = [];
  const refreshes: number[] = [];
  // A new repository key for each mount, unless a case passes one: the expansion lasts per repository.
  const repository = props.repository ?? `repository-${++repositories}`;
  const shown = await show(
    <ReferencesSidebar refs={REFS} failure={null} onSelectCommit={async (oid: string) => (LOADED.has(oid) ? (selected.push(oid), "found" as const) : "unknown" as const)} onRefresh={() => void refreshes.push(1)} repository={repository} {...props} />,
  );
  return { ...shown, selected, refreshes, repository };
}
const tree = (host: HTMLElement) => host.querySelector<HTMLElement>('[role="tree"]')!;
const items = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')];
const names = (host: HTMLElement) => items(host).map((i) => i.getAttribute("aria-label")!);
const item = (host: HTMLElement, start: string) => {
  const found = items(host).filter((i) => (i.getAttribute("aria-label") ?? "").startsWith(start));
  expect(found.map((f) => f.getAttribute("aria-label"))).toHaveLength(1);
  return found[0]!;
};
async function key(target: HTMLElement, name: string) {
  await act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { key: name, code: name, bubbles: true, cancelable: true })));
}
async function type(host: HTMLElement, value: string) {
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const click = (element: HTMLElement) => act(async () => element.click());

describe("heading and filter field (004 plan.md:528, Main board, T075)", () => {
  test("the heading row shows References and the reference count; the heading names the tree without the count", async () => {
    const { host } = await sidebar();
    const heading = host.querySelector("h2")!;
    expect(text(heading)).toBe("References");
    expect(text(heading.parentElement!.querySelector('[data-slot="references-count"]')!)).toBe("9");
    expect(tree(host).getAttribute("aria-labelledby")).toBe(heading.id);
    expect(host.querySelector<HTMLInputElement>('input[type="search"]')!.placeholder).toBe("Filter references");
    // Before the first result, no count shows.
    const loading = await sidebar({ refs: null });
    expect(loading.host.querySelector('[data-slot="references-count"]')).toBeNull();
  });
});

describe("groups and folders", () => {
  test("three groups carry their counts and aria-expanded; by default Branches is open and Remotes and Tags are closed", async () => {
    const { host } = await sidebar();
    const groups = items(host).filter((i) => i.getAttribute("aria-level") === "1");
    expect(groups.map((g) => [g.getAttribute("aria-label"), g.getAttribute("aria-expanded")])).toEqual([
      ["Branches, 4", "true"],
      ["Remotes, 4", "false"],
      ["Tags, 1", "false"],
    ]);
  });

  test("each / of a name starts a folder level, folders come first (feature 005 spec FR-015), and closed folders hide their entries", async () => {
    const { host } = await sidebar();
    expect(names(host)).toEqual(["Branches, 4", "feature, folder, 1", "release, folder, 2", "main, local branch, Current, → origin/main", "Remotes, 4", "Tags, 1"]);
    expect(item(host, "feature, folder").getAttribute("aria-expanded")).toBe("false");
    expect(item(host, "feature, folder").getAttribute("aria-level")).toBe("2");
    expect(item(host, "main,").getAttribute("aria-level")).toBe("2");
  });

  test("a folder with one child stays a folder, and an entry shows its last segment while its name holds the full name", async () => {
    const { host } = await sidebar({ tracking: GONE });
    await click(item(host, "feature, folder"));
    const entry = item(host, "feature/x,");
    expect(entry.getAttribute("aria-level")).toBe("3");
    expect(text(entry).startsWith("x")).toBe(true);
    expect(entry.getAttribute("aria-label")).toBe("feature/x, local branch, → origin/feature/x, upstream gone");
  });

  test("the folders on the path to the current branch start open", async () => {
    const { host } = await sidebar({ refs: { ...REFS, current: { name: "release/2.0", objectId: C } } });
    expect(item(host, "release, folder").getAttribute("aria-expanded")).toBe("true");
    expect(item(host, "feature, folder").getAttribute("aria-expanded")).toBe("false");
    expect(item(host, "release/2.0,").getAttribute("aria-current")).toBe("true");
  });

  test("remote folders come from the name segments only: the first segment is a folder like any other", async () => {
    const { host } = await sidebar();
    await click(item(host, "Remotes"));
    expect(names(host).filter((n) => n.includes("folder")).slice(2)).toEqual(["origin, folder, 3", "upstream, folder, 1"]);
    await click(item(host, "origin, folder"));
    await click(item(host, "release, folder, 1"));
    expect(item(host, "origin/release/1.0,").getAttribute("aria-level")).toBe("4");
  });

  test("a symbolic reference reads <name> → <target>, with the last segment as its name", async () => {
    const { host } = await sidebar();
    await click(item(host, "Remotes"));
    await click(item(host, "origin, folder"));
    expect(text(item(host, "origin/HEAD"))).toBe("HEAD → origin/main");
    expect(item(host, "origin/HEAD").getAttribute("aria-label")).toBe("origin/HEAD, remote-tracking branch, → origin/main");
  });

  test("the current branch name is bold with aria-current and no Current text, other rows are not bold, and an upstream shows → <upstream> and the gone mark (feature 005 spec FR-064)", async () => {
    const { host } = await sidebar({ tracking: GONE });
    const main = item(host, "main,");
    expect(main.getAttribute("aria-current")).toBe("true");
    expect(main.getAttribute("aria-label")).toContain("Current");
    expect(text(main)).not.toMatch(/current/i);
    expect(main.querySelector(".font-semibold")?.textContent).toBe("main");
    expect(text(main)).toContain("→ origin/main");
    await click(item(host, "feature, folder"));
    const marked = (h: HTMLElement) => items(h).filter((i) => i.hasAttribute("aria-current") || i.querySelector(".font-semibold") !== null);
    expect(marked(host)).toEqual([main]);
    expect(text(item(host, "feature/x,"))).toContain("→ origin/feature/x");
    expect(item(host, "feature/x,").querySelector("[data-slot=\"gone-mark\"]")).not.toBeNull();
  });

  test("a detached HEAD has no current branch, so no row is bold", async () => {
    const { host } = await sidebar({ refs: { ...REFS, current: null } });
    expect(items(host).filter((i) => i.hasAttribute("aria-current") || i.querySelector(".font-semibold") !== null)).toEqual([]);
  });

  test("an empty group reads its plan.md text", async () => {
    const { host } = await sidebar({ refs: { ...REFS, refs: REFS.refs.filter((r) => r.kind === "branch") } });
    expect(text(host)).toContain("No remote-tracking branches");
    expect(text(host)).toContain("No tags");
    const empty = await sidebar({ refs: { ...REFS, refs: [], current: null } });
    expect(text(empty.host)).toContain("No branches");
  });

  test("an empty group shows its text below its own heading, and the heading names it (T116)", async () => {
    const { host } = await sidebar({ refs: { ...REFS, refs: REFS.refs.filter((r) => r.kind === "branch") } });
    const heading = (label: string) => host.querySelector<HTMLElement>(`[role="treeitem"][aria-label="${label}, 0"]`)!;
    const note = (words: string) => [...host.querySelectorAll("p")].find((p) => text(p) === words)!;
    const after = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(after(heading("Remotes"), note("No remote-tracking branches"))).toBe(true);
    expect(after(note("No remote-tracking branches"), heading("Tags"))).toBe(true);
    expect(after(heading("Tags"), note("No tags"))).toBe(true);
    expect(document.getElementById(heading("Remotes").getAttribute("aria-describedby")!)).toBe(note("No remote-tracking branches"));
    expect(document.getElementById(heading("Tags").getAttribute("aria-describedby")!)).toBe(note("No tags"));
  });

  test("no control changes a reference: the sidebar holds no button, and no context menu opens", async () => {
    const { host } = await sidebar();
    expect(host.querySelectorAll("button")).toHaveLength(0);
    await act(async () => void item(host, "main,").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});

// T080: the row icons and the worktree mark of the Main and BranchCard boards. The icons are Hugeicons, hidden from assistive technology.
describe("row icons and the worktree mark (Main and BranchCard boards, T080)", () => {
  // The drawn shapes of an icon: each path `d` or circle `r`, in order, as `@hugeicons/react` renders the icon data.
  const shapeOf = (icon: IconSvgElement) => icon.map(([, attributes]) => String(attributes.d ?? attributes.r));
  const shapes = (row: HTMLElement) => [...row.querySelectorAll<SVGElement>(":scope > svg, :scope > span > svg")].map((svg) => [...svg.children].map((c) => c.getAttribute("d") ?? c.getAttribute("r") ?? ""));
  const hidden = (row: HTMLElement) => [...row.querySelectorAll("svg")].every((svg) => svg.closest('[aria-hidden="true"]') !== null);
  const held = (name: string, heldBy: string | null, current = false): BranchEntry => ({ ref: `refs/heads/${name}`, kind: "local", name, invalidUtf8: false, oid: A, upstream: null, tracking: null, heldBy, current, localName: null, upstreamPresent: false });

  test("a folder row shows the Muted folder icon after its chevron; group rows show only the chevron", async () => {
    const { host } = await sidebar();
    const folder = item(host, "feature, folder");
    expect(shapes(folder)).toEqual([shapeOf(ArrowRight01Icon), shapeOf(Folder01Icon)]);
    expect(folder.querySelectorAll("svg")[1]!.getAttribute("class")).toContain("text-muted-text");
    expect(shapes(item(host, "Branches"))).toEqual([shapeOf(ArrowDown01Icon)]);
    expect(hidden(folder)).toBe(true);
  });

  test("a local and a remote-tracking branch row show the branch icon, and a tag row the tag icon, after a chevron-wide space", async () => {
    const { host } = await sidebar();
    await click(item(host, "Remotes"));
    await click(item(host, "origin, folder"));
    await click(item(host, "Tags"));
    for (const [start, icon] of [["main,", GitBranchIcon], ["origin/main,", GitBranchIcon], ["origin/HEAD,", GitBranchIcon], ["v1.0,", Tag01Icon]] as const) {
      const row = item(host, start);
      const space = row.firstElementChild!;
      expect({ start, space: [space.tagName, space.getAttribute("aria-hidden"), text(space)], shapes: shapes(row) }).toEqual({ start, space: ["SPAN", "true", ""], shapes: [shapeOf(icon)] });
      expect(hidden(row)).toBe(true);
    }
    // The icons hold no text, so the visible name stays the last segment.
    expect(text(item(host, "main,"))).toStartWith("main");
  });

  test("a local branch that another worktree holds shows the Muted worktree mark of the card at the row end, and its name says where (spec FR-066)", async () => {
    const branches = [held("main", "C:/Repos/sample-repo", true), held("release/1.0", "C:/Repos/sample-repo-release"), held("release/2.0", null)];
    const { host } = await sidebar({ branches });
    await click(item(host, "release, folder"));
    const row = item(host, "release/1.0,");
    const mark = row.querySelector<HTMLElement>('[data-slot="worktree-mark"]')!;
    expect({ last: row.lastElementChild === mark, hidden: mark.getAttribute("aria-hidden"), title: mark.getAttribute("title"), muted: mark.className.includes("text-muted-text") }).toEqual({ last: true, hidden: "true", title: null, muted: true });
    expect(await hoverTooltip(mark)).toEqual(["Checked out in C:/Repos/sample-repo-release"]);
    expect(shapes(row).at(-1)).toEqual(shapeOf(FolderGitIcon));
    expect(row.getAttribute("aria-label")).toBe("release/1.0, local branch, No upstream, Checked out in C:/Repos/sample-repo-release");
    // The open worktree holds the current branch, and a branch that no worktree holds has no mark.
    for (const start of ["main,", "release/2.0,"]) {
      expect({ start, mark: item(host, start).querySelector('[data-slot="worktree-mark"]') }).toEqual({ start, mark: null });
      expect(item(host, start).getAttribute("aria-label")).not.toContain("Checked out in");
    }
    // Without a `readBranches` result, no row shows the mark.
    const unread = await sidebar();
    await click(item(unread.host, "release, folder"));
    expect(unread.host.querySelector('[data-slot="worktree-mark"]')).toBeNull();
  });
});

describe("one scroll container with sticky group headings", () => {
  test("the tree scrolls inside one container, and each group heading row sticks to its top", async () => {
    const { host } = await sidebar();
    const scrollers = [...host.querySelectorAll(".overflow-y-auto, .overflow-auto")];
    expect(scrollers).toHaveLength(1);
    expect(scrollers[0]!.contains(tree(host))).toBe(true);
    for (const group of items(host).filter((i) => i.getAttribute("aria-level") === "1")) {
      const classes = group.className.split(/\s+/);
      expect(classes).toContain("sticky");
      expect(classes).toContain("top-0");
    }
  });
});

describe("session expansion", () => {
  test("the expansion lasts per repository for the session, and another repository starts from the default", async () => {
    const first = await sidebar({ repository: "repository-x" });
    await click(item(first.host, "Tags"));
    await click(item(first.host, "release, folder"));
    await first.unmount();
    const again = await sidebar({ repository: "repository-x" });
    expect(item(again.host, "Tags").getAttribute("aria-expanded")).toBe("true");
    expect(item(again.host, "release, folder").getAttribute("aria-expanded")).toBe("true");
    const other = await sidebar({ repository: "repository-y" });
    expect(item(other.host, "Tags").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("filter", () => {
  test("the filter keeps each entry whose name contains the text, without regard to letter case, with its folder path open", async () => {
    const { host } = await sidebar();
    await type(host, "MAIN");
    const entries = items(host).filter((i) => !/^(Branches|Remotes|Tags),|, folder,/.test(i.getAttribute("aria-label")!));
    expect(entries.map((i) => i.getAttribute("aria-label")!.split(",")[0])).toEqual(["main", "origin/main", "upstream/main"]);
    for (const open of [item(host, "Remotes"), item(host, "origin, folder"), item(host, "upstream, folder")]) expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(names(host).some((n) => n.startsWith("Tags"))).toBe(false);
  });

  test("clearing the filter restores the earlier expansion", async () => {
    const { host } = await sidebar();
    await click(item(host, "release, folder"));
    await type(host, "main");
    await type(host, "");
    expect(item(host, "Remotes").getAttribute("aria-expanded")).toBe("false");
    expect(item(host, "release, folder").getAttribute("aria-expanded")).toBe("true");
    expect(item(host, "feature, folder").getAttribute("aria-expanded")).toBe("false");
  });

  test("no match reads No reference matches the filter.", async () => {
    const { host } = await sidebar();
    await type(host, "zzz");
    expect(text(host)).toContain("No reference matches the filter.");
  });

  test("the filter field comes first and typing in the tree types nothing", async () => {
    const { host } = await sidebar();
    const input = host.querySelector('input[type="search"]')!;
    expect(input.compareDocumentPosition(tree(host)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => item(host, "Branches").focus());
    await key(item(host, "Branches"), "m");
    expect((input as HTMLInputElement).value).toBe("");
  });
});

describe("tree keys", () => {
  test("the tree is one Tab stop with roving focus", async () => {
    const { host } = await sidebar();
    expect(items(host).filter((i) => i.tabIndex === 0)).toHaveLength(1);
  });

  test("Right opens a closed node and then enters it, Left closes an open node and then returns to the parent, and Home and End reach the ends", async () => {
    const { host } = await sidebar();
    await act(async () => item(host, "Branches").focus());
    await key(item(host, "Branches"), "ArrowRight");
    expect(document.activeElement).toBe(item(host, "feature, folder"));
    await key(item(host, "feature, folder"), "ArrowRight");
    expect(item(host, "feature, folder").getAttribute("aria-expanded")).toBe("true");
    await key(item(host, "feature, folder"), "ArrowRight");
    expect(document.activeElement).toBe(item(host, "feature/x,"));
    await key(item(host, "feature/x,"), "ArrowLeft");
    expect(document.activeElement).toBe(item(host, "feature, folder"));
    await key(item(host, "feature, folder"), "ArrowLeft");
    expect(item(host, "feature, folder").getAttribute("aria-expanded")).toBe("false");
    await key(item(host, "feature, folder"), "ArrowDown");
    expect(document.activeElement).toBe(item(host, "release, folder"));
    await key(item(host, "release, folder"), "End");
    expect(document.activeElement).toBe(item(host, "Tags"));
    await key(item(host, "Tags"), "Home");
    expect(document.activeElement).toBe(item(host, "Branches"));
    await key(item(host, "Branches"), "ArrowLeft");
    expect(item(host, "Branches").getAttribute("aria-expanded")).toBe("false");
  });

  test("Enter or a click on an entry on the page selects its row and keeps focus; another entry selects nothing and says why", async () => {
    const { host, selected } = await sidebar();
    const main = item(host, "main,");
    await act(async () => main.focus());
    await key(main, "Enter");
    expect(selected).toEqual([A]);
    expect(document.activeElement).toBe(main);
    await click(item(host, "Tags"));
    await click(item(host, "v1.0,"));
    expect(selected).toEqual([A, B]);
    await click(item(host, "Remotes"));
    await click(item(host, "upstream, folder"));
    const outside = item(host, "upstream/main,");
    await click(outside);
    await key(outside, "Enter");
    expect(selected).toEqual([A, B]);
    expect(text(host.querySelector(`#${CSS.escape(outside.getAttribute("aria-describedby")!)}`))).toBe("Not in the loaded history rows");
    expect(main.hasAttribute("aria-describedby")).toBe(false);
  });

  // Plan.md D15 "Action menu" and spec FR-014: a key-opened row menu focuses its first item; a right-click keeps the focus on the menu.
  const menuSettle = () =>
    act(async () => {
      for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    });
  for (const [name, init] of [
    ["Shift+F10", { key: "F10", shiftKey: true }],
    ["the Menu key", { key: "ContextMenu" }],
  ] as const)
    test(`${name} on the current branch row moves the focus to the first item of its menu`, async () => {
      const { host } = await sidebar({ onShowBranchHistory: () => {} });
      const main = item(host, "main,");
      await act(async () => main.focus());
      await act(async () => void main.dispatchEvent(new KeyboardEvent("keydown", { ...init, code: init.key, bubbles: true, cancelable: true })));
      await menuSettle();
      const first = document.querySelector<HTMLElement>('[role="menu"] [role="menuitem"]');
      expect(text(first)).toStartWith("Show only this branch's history");
      expect(document.activeElement === first).toBe(true);
    });

  test("a right-click on the current branch row keeps the focus on the menu, not on its first item", async () => {
    const { host } = await sidebar({ onShowBranchHistory: () => {} });
    await act(async () => void item(host, "main,").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await menuSettle();
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(menu === null).toBe(false);
    expect(document.activeElement === menu!.querySelector('[role="menuitem"]')).toBe(false);
  });
});

describe("states", () => {
  test("before the first result, the sidebar reads Loading references…", async () => {
    const { host } = await sidebar({ refs: null });
    expect(text(host)).toContain("Loading references…");
  });

  for (const [name, response, sentence] of [
    ["REF_LISTING_RECORDS", { state: "limited", code: "OUTPUT_LIMIT", result: { completeness: { state: "limited", code: "OUTPUT_LIMIT", reason: "REF_LISTING_RECORDS" } } }, "This repository has more than 10,000 references. This version does not list them."],
    ["REF_LISTING_BYTES", { state: "limited", code: "OUTPUT_LIMIT", result: { completeness: { state: "limited", code: "OUTPUT_LIMIT", reason: "REF_LISTING_BYTES" } } }, "The reference list is larger than this version can show."],
    ["another refusal", { state: "failed", code: "GIT_FAILED", result: { completeness: { state: "failed", code: "GIT_FAILED" } } }, "Arbareto cannot read the references: GIT_FAILED."],
    // Feature 004 plan D15 "Malformed result".
    ["succeeded of unknown form", { state: "succeeded", result: {} }, "The references did not load: the result has an unknown form."],
  ] as const) {
    test(`a ${name} refusal shows its text with the error icon and Refresh`, async () => {
      const { host, refreshes } = await sidebar({ refs: null, failure: { requestId: crypto.randomUUID(), ...response } as never });
      expect(text(host)).toContain(sentence);
      expect(host.querySelector("svg")).not.toBeNull();
      const refresh = [...host.querySelectorAll("button")].filter((b) => text(b) === "Refresh (F5)");
      expect(refresh).toHaveLength(1);
      await click(refresh[0]!);
      expect(refreshes).toEqual([1]);
    });
  }
});

describe("constrained profile", () => {
  test("the collapsed section shows only the References heading and the Show references toggle; the toggle expands it", async () => {
    const { host } = await sidebar({ collapsible: true });
    expect(text(host.querySelector("h2"))).toBe("References");
    const toggle = host.querySelector<HTMLElement>('button[aria-label="Show references"]')!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('[role="tree"]')).toBeNull();
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('[role="tree"]')).not.toBeNull();
  });
});

// T062: the virtual references tree (feature 002 spec FR-055, plan.md D6 "References sidebar").
describe("virtual tree", () => {
  let restore: () => void = () => {};
  beforeAll(() => void (restore = stubLayout(800)));
  afterAll(() => restore());
  const many = (n: number): RefsResult => ({
    ...REFS,
    // The branches, then the 5 remote and tag refs of REFS, in Git's refname order. `n` is the record count.
    refs: [...Array.from({ length: n - 5 }, (_, i) => ref("branch", `branch-${String(i).padStart(5, "0")}`, i % 2 === 0 ? A : B)), ...REFS.refs.filter((r) => r.kind !== "branch")],
    current: { name: "branch-00000", objectId: A },
  });
  const settle = () =>
    act(async () => {
      for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const focused = () => document.activeElement?.getAttribute("aria-label") ?? "";

  test("the DOM holds only the rows near the visible area, and the element count is equal for 1,000 and 10,000 refs", async () => {
    const counts: number[] = [];
    for (const n of [1_000, 10_000]) {
      const { host } = await sidebar({ refs: many(n) });
      await settle();
      counts.push(items(host).length);
    }
    expect(counts[0]).toBe(counts[1]!);
    expect(counts[0]!).toBeLessThan(80);
  });

  test("each treeitem carries aria-level, aria-posinset, and aria-setsize", async () => {
    const { host } = await sidebar({ refs: many(10_000) });
    await settle();
    expect(item(host, "Branches").getAttribute("aria-level")).toBe("1");
    expect(item(host, "Branches").getAttribute("aria-posinset")).toBe("1");
    expect(item(host, "Branches").getAttribute("aria-setsize")).toBe("3");
    const entry = item(host, "branch-00003,");
    expect([entry.getAttribute("aria-level"), entry.getAttribute("aria-posinset"), entry.getAttribute("aria-setsize")]).toEqual(["2", "4", "9995"]);
  });

  test("End, Home, ArrowUp, and ArrowLeft to a parent reach rows outside the window, and the focused row exists and has focus", async () => {
    const { host } = await sidebar({ refs: many(10_000) });
    await settle();
    await act(async () => item(host, "Branches").focus());
    await key(item(host, "Branches"), "End");
    await settle();
    expect(focused()).toBe("Tags, 1");
    await key(document.activeElement as HTMLElement, "ArrowUp");
    await key(document.activeElement as HTMLElement, "ArrowUp");
    await settle();
    expect(focused()).toStartWith("branch-09994,");
    await key(document.activeElement as HTMLElement, "ArrowLeft");
    await settle();
    expect(focused()).toBe("Branches, 9995");
    await key(document.activeElement as HTMLElement, "End");
    await settle();
    await key(document.activeElement as HTMLElement, "Home");
    await settle();
    expect(focused()).toBe("Branches, 9995");
  });

  test("an empty group shows its text below its own heading, and the heading names it (T118)", async () => {
    const all = many(1_000);
    const { host } = await sidebar({ refs: { ...all, refs: all.refs.filter((r) => r.kind !== "tag") } });
    await settle();
    await act(async () => item(host, "Branches").focus());
    // End moves to the Tags heading, and the focused row stays mounted.
    await key(item(host, "Branches"), "End");
    await settle();
    const heading = item(host, "Tags, 0");
    const note = [...host.querySelectorAll("p")].find((p) => text(p) === "No tags")!;
    expect(heading.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(host.querySelector('[role="tree"]')!.contains(note)).toBe(true);
    expect(document.getElementById(heading.getAttribute("aria-describedby")!)).toBe(note);
    // The heading and the text share one virtual item of two rows, so the next item starts below the text.
    expect(note.parentElement!.style.height).toBe(`${2 * parseFloat(heading.style.height)}px`);
  });

  test("the filter and the expanded state cover refs outside the window", async () => {
    const { host } = await sidebar({ refs: many(10_000) });
    await settle();
    await type(host, "09994");
    await settle();
    expect(names(host)).toContain("branch-09994, local branch, No upstream");
    await type(host, "");
    await settle();
    await click(item(host, "Branches"));
    await settle();
    expect(names(host)).toEqual(["Branches, 9995", "Remotes, 4", "Tags, 1"]);
  });
});
