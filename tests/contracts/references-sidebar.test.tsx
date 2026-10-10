// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T358: the read-only references sidebar of `src/frontend/refs/ReferencesSidebar.tsx` (FR-057; plan.md "References sidebar", "Long text",
// "Keyboard and focus" References sidebar row, "Task flow and command placement" Browse references row, "Required visible states" References, and "Status and fallback texts").

import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import type { RefEntry, RefsResult } from "../../src/contracts/envelope";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";

printOrigin("../../src/frontend/refs/ReferencesSidebar.tsx", import.meta.dir);
registerDom();
const { createRoot } = await import("react-dom/client");
const { ReferencesSidebar } = await import("../../src/frontend/refs/ReferencesSidebar");

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
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
const REFS: RefsResult = {
  generation: 1,
  refs: [
    ref("branch", "feature/x", B, { upstream: "refs/remotes/origin/feature/x", upstreamPresent: false }),
    ref("branch", "main", A, { upstream: "refs/remotes/origin/main", upstreamPresent: true }),
    ref("remote", "origin/HEAD", A, { symref: "refs/remotes/origin/main" }),
    ref("remote", "origin/main", A),
    ref("remote", "upstream/main", C),
    ref("tag", "v1.0", B, { objectType: "tag", peeledId: B, peeledType: "commit" }),
  ],
  current: { name: "main", objectId: A },
  completeness: { state: "complete" },
};
// The loaded history page holds A and B, not C.
const LOADED = new Set([A, B]);

type Props = Partial<Parameters<typeof ReferencesSidebar>[0]>;
async function sidebar(props: Props = {}) {
  const selected: string[] = [];
  const refreshes: number[] = [];
  const host = await show(
    <ReferencesSidebar refs={REFS} failure={null} unpaired={0} loaded={LOADED} onSelectCommit={(oid: string) => void selected.push(oid)} onRefresh={() => void refreshes.push(1)} {...props} />,
  );
  return { host, selected, refreshes };
}
const tree = (host: HTMLElement) => host.querySelector<HTMLElement>('[role="tree"]')!;
const items = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')];
const item = (host: HTMLElement, start: string) => {
  const found = items(host).filter((i) => (i.getAttribute("aria-label") ?? "").startsWith(start));
  expect(found).toHaveLength(1);
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

describe("groups and entries", () => {
  test("the tree holds the groups Branches, Remotes, and Tags with their counts, and Remotes is a flat list", async () => {
    const { host } = await sidebar();
    const groups = items(host).filter((i) => i.getAttribute("aria-level") === "1");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Branches, 2", "Remotes, 3", "Tags, 1"]);
    expect(items(host).filter((i) => i.getAttribute("aria-level") === "2")).toHaveLength(6);
    expect(items(host).some((i) => i.getAttribute("aria-level") === "3")).toBe(false);
  });

  test("the current branch shows the Current mark as text, from current of the result", async () => {
    const { host } = await sidebar();
    expect(text(item(host, "main,"))).toContain("Current");
    expect(text(item(host, "feature/x,"))).not.toContain("Current");
    expect(item(host, "main,").getAttribute("aria-label")).toBe("main, local branch, Current, → origin/main");
  });

  test("an upstream shows → <upstream>, and a missing one adds not present", async () => {
    const { host } = await sidebar();
    expect(text(item(host, "main,"))).toContain("→ origin/main");
    expect(text(item(host, "feature/x,"))).toContain("→ origin/feature/x, not present");
  });

  test("a symbolic reference reads <name> → <target>", async () => {
    const { host } = await sidebar();
    expect(text(item(host, "origin/HEAD"))).toBe("origin/HEAD → origin/main");
  });

  test("an empty group reads its plan.md text", async () => {
    const { host } = await sidebar({ refs: { ...REFS, refs: REFS.refs.filter((r) => r.kind === "branch"), current: REFS.current } });
    expect(text(host)).toContain("No remote-tracking branches");
    expect(text(host)).toContain("No tags");
    const empty = await sidebar({ refs: { ...REFS, refs: [], current: null } });
    expect(text(empty.host)).toContain("No branches");
  });

  test("no control changes a reference: the sidebar holds no button except Refresh in a refusal, and no context menu", async () => {
    const { host } = await sidebar();
    expect(host.querySelectorAll("button")).toHaveLength(0);
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => void item(host, "main,").dispatchEvent(menu));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});

describe("filter", () => {
  test("the filter keeps each entry whose name contains the text, without regard to letter case", async () => {
    const { host } = await sidebar();
    await type(host, "MAIN");
    expect(items(host).filter((i) => i.getAttribute("aria-level") === "2").map((i) => i.getAttribute("aria-label")!.split(",")[0])).toEqual(["main", "origin/main", "upstream/main"]);
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

  test("Down and Up move focus, Right enters a group, Left returns to it and then collapses it, and Home and End reach the ends", async () => {
    const { host } = await sidebar();
    const branches = item(host, "Branches");
    await act(async () => branches.focus());
    await key(branches, "ArrowRight");
    expect(document.activeElement).toBe(item(host, "feature/x,"));
    await key(document.activeElement as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(item(host, "main,"));
    await key(document.activeElement as HTMLElement, "ArrowLeft");
    expect(document.activeElement).toBe(item(host, "Branches"));
    await key(item(host, "Branches"), "ArrowLeft");
    expect(item(host, "Branches").getAttribute("aria-expanded")).toBe("false");
    expect(items(host).some((i) => (i.getAttribute("aria-label") ?? "").startsWith("main,"))).toBe(false);
    await key(item(host, "Branches"), "End");
    expect(document.activeElement).toBe(item(host, "v1.0,"));
    await key(document.activeElement as HTMLElement, "Home");
    expect(document.activeElement).toBe(item(host, "Branches"));
    await key(item(host, "Branches"), "ArrowRight");
    expect(item(host, "Branches").getAttribute("aria-expanded")).toBe("true");
  });

  test("Enter or a click on an entry on the page selects its row and keeps focus; another entry selects nothing and says why", async () => {
    const { host, selected } = await sidebar();
    const main = item(host, "main,");
    await act(async () => main.focus());
    await key(main, "Enter");
    expect(selected).toEqual([A]);
    expect(document.activeElement).toBe(main);
    await act(async () => item(host, "v1.0,").click());
    expect(selected).toEqual([A, B]);
    const outside = item(host, "upstream/main,");
    await act(async () => outside.click());
    await key(outside, "Enter");
    expect(selected).toEqual([A, B]);
    expect(text(host.querySelector(`#${CSS.escape(outside.getAttribute("aria-describedby")!)}`))).toBe("Not in the loaded history page");
    expect(main.hasAttribute("aria-describedby")).toBe(false);
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
  ] as const) {
    test(`a ${name} refusal shows its text with the error icon and Refresh`, async () => {
      const { host, refreshes } = await sidebar({ refs: null, failure: { requestId: crypto.randomUUID(), ...response } as never });
      expect(text(host)).toContain(sentence);
      expect(host.querySelector("svg")).not.toBeNull();
      const refresh = [...host.querySelectorAll("button")].filter((b) => text(b) === "Refresh (F5)");
      expect(refresh).toHaveLength(1);
      await act(async () => refresh[0]!.click());
      expect(refreshes).toEqual([1]);
    });
  }

  test("an unpaired result keeps the list and adds the reading note; a second one asks for Refresh", async () => {
    const first = await sidebar({ unpaired: 1 });
    expect(text(first.host)).toContain("References changed. Arbareto is reading them again.");
    expect(items(first.host).length).toBeGreaterThan(3);
    const second = await sidebar({ unpaired: 2 });
    expect(text(second.host)).toContain("The history and the references show different HEAD states. Select Refresh (F5).");
    expect(text(second.host)).not.toContain("References changed.");
  });

  test("each pane scrolls by itself: the tree region has its own scroll container", async () => {
    const { host } = await sidebar();
    expect(tree(host).closest(".overflow-y-auto")).not.toBeNull();
  });
});

describe("constrained profile", () => {
  test("the collapsed section shows only the References heading and the Show references toggle; the toggle expands it", async () => {
    const { host } = await sidebar({ collapsible: true });
    expect(text(host.querySelector("h2"))).toBe("References");
    const toggle = host.querySelector<HTMLElement>('button[aria-label="Show references"]')!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('[role="tree"]')).toBeNull();
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('[role="tree"]')).not.toBeNull();
  });
});
