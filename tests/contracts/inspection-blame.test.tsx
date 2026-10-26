// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 005 T044: the blame view (spec FR-053 to FR-063, FR-067, FR-068, plan.md D12, D15 "Blame view", D16 age shades).

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { act, useEffect, type ReactNode } from "react";
import type { BridgeResponse, OnProgress } from "../../src/frontend/bridge";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { contractChecked, fixtureId } from "./bridge-contract";
import { stubLayout, TARGET } from "./history-fake";
import { latinKeyCode } from "./key-codes";

printOrigin("../../src/frontend/blame/BlameView.tsx", import.meta.dir);
printOrigin("../../src/frontend/blame/blame-time.ts", import.meta.dir);
printOrigin("../../src/frontend/views/HistoryView.tsx", import.meta.dir);
printOrigin("../../src/frontend/state/history-view.ts", import.meta.dir);
registerDom();
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre data-slot="patch-double">{patch}</pre> }));
// The pool double counts its live providers. Pierre ends its worker pool when the last provider unmounts (@pierre/diffs 1.5.1 WorkerPoolContext.js).
const pool = { live: 0 };
function PoolDouble({ children }: { children?: ReactNode }) {
  useEffect(() => {
    pool.live++;
    return () => void pool.live--;
  }, []);
  return <>{children}</>;
}
mock.module("../../src/frontend/changes/PatchPool", () => ({ default: PoolDouble }));

const { createRoot } = await import("react-dom/client");
const { BlameView } = await import("../../src/frontend/blame/BlameView");
const { relativeDate, ageSteps } = await import("../../src/frontend/blame/blame-time");
const { HistoryListSlot } = await import("../../src/frontend/views/HistoryView");
const { createInspection } = await import("../../src/frontend/state/history-view");
type Inspection = import("../../src/frontend/state/history-view").Inspection;

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});
async function show(node: ReactNode) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(node));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return host;
}
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
const text = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ").trim();
const key = async (element: Element, k: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key: k, keyCode: latinKeyCode(k), bubbles: true, cancelable: true, ...init });
  await act(async () => void element.dispatchEvent(event));
  return event;
};
const click = (element: Element) => act(async () => (element as HTMLElement).click());
let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());

// ---- Fixtures ----

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const C1 = "c".repeat(40);
const C2 = "d".repeat(40);
const C3 = "e".repeat(40);
const P = "f".repeat(40);
const DAY = 86_400;
// The fixed clock of the tests: 2026-10-22T00:00:00Z.
const NOW = Date.UTC(2026, 9, 22);
const NOW_S = NOW / 1000;

type Call = { operation: string; payload: Record<string, unknown>; operationId: string; resolve(response: BridgeResponse): void; onProgress?: OnProgress };
function double() {
  const calls: Call[] = [];
  const canceled: string[] = [];
  let n = 0;
  const bridge = contractChecked({
    readCommitChanges: () => new Promise<BridgeResponse>(() => {}),
    readCommitFile: () => new Promise<BridgeResponse>(() => {}),
    readBlame: (_target: unknown, payload: Record<string, unknown>, onProgress?: OnProgress) =>
      new Promise<BridgeResponse>((resolve) => {
        const operationId = fixtureId(0x3000 + ++n);
        calls.push({ operation: "readBlame", payload, operationId, resolve, onProgress });
        queueMicrotask(() => onProgress?.({ requestId: "r", operationId, state: "accepted", counters: {} } as never));
      }),
    cancel: (payload: { operationId: string }) => {
      canceled.push(payload.operationId);
      calls.find((c) => c.operationId === payload.operationId)?.resolve({ requestId: null, operationId: payload.operationId, state: "canceled" } as BridgeResponse);
      return Promise.resolve({ requestId: null, state: "succeeded" } as BridgeResponse);
    },
  });
  return { bridge, calls, canceled, last: () => calls.at(-1)! };
}
const succeeded = (result: unknown): BridgeResponse => ({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "succeeded", repositoryGeneration: 1, result }) as BridgeResponse;
const failed = (code: string, result?: unknown): BridgeResponse => ({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "failed", code, ...(result === undefined ? {} : { result }) }) as BridgeResponse;

type CommitSpec = { oid: string; author?: string; time: number; previous?: string | null; filename?: string; shallow?: boolean };
type GroupSpec = { commit: number; count: number; orig?: number; ignored?: boolean; unblamable?: boolean };
function blameResult(commits: CommitSpec[], groups: GroupSpec[], fields: Record<string, unknown> = {}) {
  let next = 1;
  const lines = groups.reduce((s, g) => s + g.count, 0);
  return {
    blameId: fixtureId(0x9000 + Math.floor(Math.random() * 0xfff)),
    commit: C1,
    pathBytes: b64("src/login.ts"),
    content: b64(Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n") + "\n"),
    lines,
    ignoreList: "none",
    groups: groups.map((g) => {
      const out = { commit: g.commit, origStart: g.orig ?? next, finalStart: next, count: g.count, ignored: g.ignored ?? false, unblamable: g.unblamable ?? false };
      next += g.count;
      return out;
    }),
    commits: commits.map((c) => ({
      oid: c.oid,
      author: b64(c.author ?? "Ann Lee"),
      authorMail: b64("<ann@example.invalid>"),
      authorTime: c.time,
      authorTz: "+0000",
      summary: b64("summary"),
      previous: c.previous === undefined || c.previous === null ? null : { oid: c.previous, pathBytes: b64("src/login.ts") },
      filenameBytes: b64(c.filename ?? "src/login.ts"),
      shallow: c.shallow ?? false,
    })),
    ...fields,
  };
}
const SOURCE = { changesId: fixtureId(0x500), fileId: 0 };
const THREE = () =>
  blameResult(
    [
      { oid: C1, author: "Ann Lee", time: NOW_S - 2 * DAY, previous: P },
      { oid: C2, author: "Bo Chen", time: NOW_S - 400 * DAY, filename: "src/auth.ts" },
    ],
    [
      { commit: 0, count: 2 },
      { commit: 1, count: 3 },
      { commit: 0, count: 1 },
    ],
  );

type Mounted = { host: HTMLElement; inspection: Inspection; d: ReturnType<typeof double>; selected: string[]; backs: number[] };
async function mountBlame(): Promise<Mounted> {
  const d = double();
  const inspection = createInspection(d.bridge, TARGET);
  const selected: string[] = [];
  const backs: number[] = [];
  const host = await show(
    <HistoryListSlot inspection={inspection} onSelectCommit={async (oid) => (selected.push(oid), "found")} onBack={() => backs.push(1)} now={() => NOW}>
      <div data-slot="history-list-double" tabIndex={0}>
        History list
      </div>
    </HistoryListSlot>,
  );
  await act(async () => inspection.openBlame({ source: SOURCE, path: "src/login.ts", oid: C1 }));
  await settle();
  return { host, inspection, d, selected, backs };
}
async function answered(result: unknown = THREE()) {
  const m = await mountBlame();
  await act(async () => m.d.last().resolve(succeeded(result)));
  await settle();
  return { ...m, result: result as ReturnType<typeof blameResult> };
}
const view = (host: HTMLElement) => host.querySelector<HTMLElement>('section[data-slot="blame-view"]')!;
const lines = (host: HTMLElement) => [...view(host).querySelectorAll<HTMLElement>('[role="option"]')];
const line = (host: HTMLElement, n: number) => lines(host).find((e) => e.dataset.line === String(n))!;
const button = (host: HTMLElement, name: string) => [...view(host).querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.getAttribute("aria-label") ?? text(b)) === name)!;

describe("blame-time.ts (plan.md D12 Relative date text)", () => {
  const ago = (seconds: number) => relativeDate(NOW_S - seconds, NOW);
  test("every range, with the singular for 1", () => {
    expect(ago(0)).toBe("Less than a minute ago");
    expect(ago(59)).toBe("Less than a minute ago");
    expect(ago(60)).toBe("1 minute ago");
    expect(ago(59 * 60 + 59)).toBe("59 minutes ago");
    expect(ago(3600)).toBe("1 hour ago");
    expect(ago(23 * 3600 + 3599)).toBe("23 hours ago");
    expect(ago(DAY)).toBe("1 day ago");
    expect(ago(13 * DAY + 86_399)).toBe("13 days ago");
    expect(ago(14 * DAY)).toBe("2 weeks ago");
    expect(ago(59 * DAY + 86_399)).toBe("8 weeks ago");
    expect(ago(60 * DAY)).toBe("2 months ago");
    expect(ago(364 * DAY + 86_399)).toBe("12 months ago");
    expect(ago(365 * DAY)).toBe("1 year ago");
    expect(ago(3 * 365 * DAY + 5)).toBe("3 years ago");
  });
  test("a time after now shows the full date", () => {
    const later = NOW_S + 60;
    expect(relativeDate(later, NOW)).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(later * 1000));
  });
  test("the age step is floor(7 × r / c) + 1 over the distinct author times, oldest first", () => {
    expect(ageSteps([100, 300, 200, 100])).toEqual([1, 5, 3, 1]);
    expect(ageSteps([5])).toEqual([1]);
    const many = Array.from({ length: 14 }, (_, i) => i);
    expect(ageSteps(many)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7]);
  });
});

describe("the view (spec FR-054, US7-1, US7-2, Blame board)", () => {
  test("the blame view replaces the History list, with its heading, Back (Esc), and Blame before this commit (Alt+Left)", async () => {
    const m = await answered();
    expect(m.host.querySelector<HTMLElement>('[data-slot="history-list-double"]')!.closest("[hidden]")).not.toBeNull();
    expect(text(view(m.host).querySelector("h2")!)).toBe(`Blame: src/login.ts at ${C1.slice(0, 12)}`);
    expect(button(m.host, "Back").getAttribute("aria-keyshortcuts")).toBe("Escape");
    expect(button(m.host, "Blame before this commit (Alt+Left)").getAttribute("aria-keyshortcuts")).toBe("Alt+ArrowLeft");
    expect(m.d.last().payload).toEqual({ source: SOURCE, options: { ignoreWhitespace: false, detectMoves: false, detectCopies: false, ignoreList: true } });
  });

  test("Escape and Back return to the History list", async () => {
    const m = await answered();
    await key(line(m.host, 1), "Escape");
    expect(m.host.querySelector('section[data-slot="blame-view"]')).toBeNull();
    expect(m.host.querySelector<HTMLElement>('[data-slot="history-list-double"]')!.closest("[hidden]")).toBeNull();
    expect(m.backs.length).toBe(1);
    await act(async () => m.inspection.openBlame({ source: SOURCE, path: "src/login.ts", oid: C1 }));
    await act(async () => m.d.last().resolve(succeeded(THREE())));
    await settle();
    await click(button(m.host, "Back"));
    expect(m.host.querySelector('section[data-slot="blame-view"]')).toBeNull();
    expect(m.backs.length).toBe(2);
  });

  test("Escape with the focus on Back returns at once", async () => {
    const m = await answered();
    const back = button(m.host, "Back");
    await act(async () => back.focus());
    expect(document.activeElement).toBe(back);
    await key(back, "Escape");
    expect(m.backs.length).toBe(1);
    expect(m.host.querySelector('section[data-slot="blame-view"]')).toBeNull();
  });
});

describe("forced colors (plan.md D16, T072)", () => {
  test("the selected line number takes HighlightText, and the selected age bar takes Highlight", () => {
    const css = readFileSync(printOrigin("../../src/frontend/index.css", import.meta.dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const block = css.slice(css.indexOf("@media (forced-colors: active)"));
    const rules = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.replace(/\s+/g, " ").trim(), body: m[2]!.replace(/\s+/g, " ").trim() }));
    const selected = rules.find((r) => r.selector.startsWith('.list-row[aria-selected="true"] :is(') && r.selector.includes(".text-muted-text"));
    expect(selected?.selector).toContain(".text-text");
    expect(selected?.body).toBe("color: HighlightText;");
    expect(rules.find((r) => r.selector === '.list-row[aria-selected="true"] .age-bar')?.body).toBe("forced-color-adjust: none; background: Highlight !important;");
  });
});

describe("gutter and age (spec FR-055)", () => {
  test("the first line of each run shows the short ID, the author, and the relative date; the tooltip gives the author, the date, and the other path (T071)", async () => {
    const m = await answered();
    const gutter = (n: number) => line(m.host, n).querySelector<HTMLElement>('[data-slot="blame-gutter"]')!;
    const parts = (n: number) => [...gutter(n).children].map((e) => e.textContent);
    expect(parts(1)).toEqual([C1.slice(0, 12), "Ann Lee", "2 days ago"]);
    expect(parts(2)).toEqual([]);
    expect(parts(3)).toEqual([C2.slice(0, 12), "Bo Chen", "1 year ago"]);
    expect(parts(6)).toEqual([C1.slice(0, 12), "Ann Lee", "2 days ago"]);
    const date = (s: number) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(s * 1000);
    expect(gutter(1).title).toBe(`Ann Lee\n${date(NOW_S - 2 * DAY)}`);
    expect(gutter(3).title).toBe(`Bo Chen\n${date(NOW_S - 400 * DAY)}\nPath in this commit: src/auth.ts`);
    // Two distinct times: the older gets step 1, the newer step floor(7 × 1 / 2) + 1 = 4.
    expect(line(m.host, 1).querySelector<HTMLElement>('[data-slot="age-bar"]')!.dataset.age).toBe("4");
    expect(line(m.host, 3).querySelector<HTMLElement>('[data-slot="age-bar"]')!.dataset.age).toBe("1");
    expect(line(m.host, 1).getAttribute("aria-label")).toBe(`Line 1, ${C1.slice(0, 12)}, Ann Lee, 2 days ago`);
    expect(line(m.host, 1).getAttribute("aria-description")).toBe("line 1");
  });

  test("the legend and its group name", async () => {
    const m = await answered();
    const legend = view(m.host).querySelector<HTMLElement>('[role="group"][aria-label="Commit age, older to newer"]')!;
    expect([...legend.children].filter((e) => !e.hasAttribute("aria-hidden")).map((e) => e.textContent)).toEqual(["Older", "Newer"]);
    expect(legend.querySelectorAll('[data-age]').length).toBe(7);
    expect(legend.title).toBe("The shade ranks the commits of this file by author date. Today's date has no effect.");
  });

  test("the shallow text on the second line of the run, or in the tooltip of a run of one line", async () => {
    const m = await answered(
      blameResult(
        [
          { oid: C1, time: NOW_S - DAY, shallow: true },
          { oid: C2, time: NOW_S - 2 * DAY, shallow: true },
        ],
        [
          { commit: 0, count: 2 },
          { commit: 1, count: 1 },
        ],
      ),
    );
    expect(text(line(m.host, 2).querySelector('[data-slot="blame-gutter"]')!)).toBe("Earlier history is not in this clone.");
    expect(line(m.host, 3).querySelector<HTMLElement>('[data-slot="blame-gutter"]')!.title).toContain("Earlier history is not in this clone.");
  });
});

describe("keys (spec FR-056, US7-3, US7-10)", () => {
  test("one Tab stop with roving focus; Up and Down select a line and show its commit; Enter selects the commit in History", async () => {
    const m = await answered();
    expect(lines(m.host).filter((e) => e.tabIndex === 0).length).toBe(1);
    const first = line(m.host, 1);
    expect(first.getAttribute("aria-selected")).toBe("true");
    await act(async () => first.focus());
    await key(first, "ArrowDown");
    await key(document.activeElement!, "ArrowDown");
    expect(document.activeElement).toBe(line(m.host, 3));
    expect(line(m.host, 3).getAttribute("aria-selected")).toBe("true");
    expect(m.inspection.getState().blame!.line).toBe(3);
    expect(m.inspection.lineCommit()).toBe(C2);
    await key(document.activeElement!, "ArrowUp");
    expect(m.inspection.lineCommit()).toBe(C1);
    await key(document.activeElement!, "Enter");
    expect(m.selected).toEqual([C1]);
  });

  test("Alt+Left runs Blame before this commit and calls preventDefault", async () => {
    const m = await answered();
    const result = THREE();
    await act(async () => line(m.host, 1).focus());
    const event = await key(line(m.host, 1), "ArrowLeft", { altKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(m.d.last().payload).toEqual({ source: { blameId: m.result.blameId, line: 1 }, options: { ignoreWhitespace: false, detectMoves: false, detectCopies: false, ignoreList: true } });
    // Plan.md D15 "Blame focus": the running state takes the focus to Cancel.
    expect(document.activeElement).toBe(button(m.host, "Cancel"));
    // The result of the earlier version selects its `focusLine`, and the new blame focuses that line (quickstart Q28).
    await act(async () => m.d.last().resolve(succeeded({ ...result, commit: P, focusLine: 2 })));
    await settle();
    expect(line(m.host, 2).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(line(m.host, 2));
    expect(text(view(m.host).querySelector("h2")!)).toBe(`Blame: src/login.ts at ${P.slice(0, 12)}`);
  });

  test("a line without previous makes Blame before this commit unavailable with its reason", async () => {
    const m = await answered();
    await act(async () => line(m.host, 3).focus());
    await click(line(m.host, 3));
    const before = button(m.host, "Blame before this commit (Alt+Left)");
    expect(before.getAttribute("aria-disabled") === "true" || before.disabled).toBe(true);
    expect(text(view(m.host))).toContain("Git names no earlier version of this line.");
    const calls = m.d.calls.length;
    const event = await key(line(m.host, 3), "ArrowLeft", { altKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(m.d.calls.length).toBe(calls);
  });
});

describe("options (spec FR-057, FR-059)", () => {
  test("the three toggles with aria-pressed, all off at start; a toggle runs blame again", async () => {
    const m = await answered();
    const toolbar = view(m.host).querySelector<HTMLElement>('[role="toolbar"][aria-label="Blame options"]')!;
    const toggles = [...toolbar.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")];
    expect(toggles.map((t) => [text(t), t.getAttribute("aria-pressed")])).toEqual([
      ["Ignore whitespace", "false"],
      ["Detect moved lines", "false"],
      ["Detect lines from other files", "false"],
    ]);
    expect(text(toolbar)).toContain("6 lines");
    await click(toggles[0]!);
    expect(m.d.last().payload).toEqual({ source: { blameId: m.result.blameId }, options: { ignoreWhitespace: true, detectMoves: false, detectCopies: false, ignoreList: true } });
  });

  test("Skip commits in the ignore list shows only with an effective list and starts on; the marks ? and *", async () => {
    const m = await answered(
      blameResult(
        [{ oid: C1, time: NOW_S - DAY }],
        [
          { commit: 0, count: 1, ignored: true },
          { commit: 0, count: 1, unblamable: true },
          { commit: 0, count: 1 },
        ],
        { ignoreList: "on" },
      ),
    );
    const skip = button(m.host, "Skip commits in the ignore list");
    expect(skip.getAttribute("aria-pressed")).toBe("true");
    const mark = (n: number) => line(m.host, n).querySelector<HTMLElement>('[data-slot="blame-mark"]')!;
    expect(mark(1).textContent).toBe("?");
    expect(mark(1).title).toBe("Ignored. Git skipped the commit of this line.");
    expect(mark(2).textContent).toBe("*");
    expect(mark(2).title).toBe("Unblamable. Git found no commit for this line after the skip.");
    expect(line(m.host, 1).getAttribute("aria-label")).toEndWith(", ignored");
    expect(line(m.host, 2).getAttribute("aria-label")).toEndWith(", unblamable");
    await click(skip);
    expect((m.d.last().payload.options as { ignoreList: boolean }).ignoreList).toBe(false);
    const none = await answered();
    expect([...view(none.host).querySelectorAll("button")].some((b) => text(b) === "Skip commits in the ignore list")).toBe(false);
  });
});

describe("refusals, progress, and stop (spec FR-060 to FR-063, US7-6 to US7-8)", () => {
  test("the refusal texts of plan.md D15", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ reason: "no-history" }, "Git has no history for this file."],
      [{ reason: "binary" }, "Arbareto does not blame a binary file."],
      [{ reason: "submodule" }, "This path is a submodule. Open the submodule to blame its files."],
      [{ reason: "size" }, "Arbareto does not blame a file larger than 4 MiB."],
      [{ reason: "lines" }, "Arbareto does not blame a file with more than 100,000 lines."],
      [{ reason: "ignore-revs-file-missing", path: ".git-blame-ignore-revs" }, "Git cannot run blame. The file .git-blame-ignore-revs that blame.ignoreRevsFile names does not exist."],
      [{ reason: "no-previous" }, "Git names no earlier version of this line."],
      [{ reason: "path" }, "Arbareto cannot pass this file name to Git, because it is not valid UTF-8."],
    ];
    for (const [result, expected] of cases) {
      const m = await mountBlame();
      await act(async () => m.d.last().resolve(failed("BLAME_UNAVAILABLE", result)));
      await settle();
      expect(text(view(m.host))).toContain(expected);
      for (const unmount of unmounts.splice(0)) await unmount();
    }
  });

  test("a failure with Show output for GIT_FAILED", async () => {
    const m = await mountBlame();
    await act(async () => m.d.last().resolve(failed("GIT_FAILED", { outputTail: "fatal: bad revision" })));
    await settle();
    expect(text(view(m.host))).toContain("Blame did not complete: GIT_FAILED.");
    await click(button(m.host, "Show output"));
    expect(text(view(m.host))).toContain("fatal: bad revision");
  });

  test("progress with counts and Cancel, and the stopped text", async () => {
    const m = await mountBlame();
    await act(async () => m.d.last().onProgress!({ requestId: "r", operationId: m.d.last().operationId, state: "running", phase: "blame", counters: { blamed: 1200, total: 5000 } } as never));
    expect(text(view(m.host))).toContain("Blaming… 1,200 of 5,000 lines");
    await click(button(m.host, "Cancel"));
    await settle();
    expect(m.d.canceled).toEqual([m.d.last().operationId]);
    expect(text(view(m.host))).toContain("Blame stopped before Git finished.");
  });

  test("progress without counts with an ignore list", async () => {
    const m = await mountBlame();
    await act(async () => m.d.last().onProgress!({ requestId: "r", operationId: m.d.last().operationId, state: "running", phase: "blame", counters: {} } as never));
    expect(text(view(m.host))).toContain("Blaming…");
    expect(text(view(m.host))).not.toContain(" of ");
    expect(button(m.host, "Cancel")).not.toBeUndefined();
  });
});

describe("focus after a state change (001 spec FR-005, plan.md D15 Blame focus)", () => {
  async function cancelFocused() {
    const m = await mountBlame();
    const cancel = button(m.host, "Cancel");
    await act(async () => cancel.focus());
    expect(document.activeElement).toBe(cancel);
    return m;
  }

  test("Cancel takes the focus to Back, and Escape then returns to History", async () => {
    const m = await cancelFocused();
    await click(button(m.host, "Cancel"));
    await settle();
    expect(text(view(m.host))).toContain("Blame stopped before Git finished.");
    expect(document.activeElement).toBe(button(m.host, "Back"));
    await key(document.activeElement!, "Escape");
    expect(m.backs.length).toBe(1);
    expect(m.host.querySelector('section[data-slot="blame-view"]')).toBeNull();
  });

  test("a result that arrives while Cancel has the focus focuses the selected line", async () => {
    const m = await cancelFocused();
    await act(async () => m.d.last().resolve(succeeded(THREE())));
    await settle();
    expect(document.activeElement).toBe(line(m.host, 1));
  });

  test("a failure that arrives while Cancel has the focus focuses Back", async () => {
    const m = await cancelFocused();
    await act(async () => m.d.last().resolve(failed("GIT_FAILED", { outputTail: "fatal: bad revision" })));
    await settle();
    expect(document.activeElement).toBe(button(m.host, "Back"));
  });
});

describe("virtual rows (spec FR-068)", () => {
  test("a 100,000-line blame creates rows only near the visible area", async () => {
    const m = await answered(blameResult([{ oid: C3, time: NOW_S - DAY }], [{ commit: 0, count: 100_000 }]));
    expect(lines(m.host).length).toBeLessThan(200);
    expect(text(view(m.host).querySelector('[role="toolbar"]')!)).toContain("100,000 lines");
  });
});

describe("workbench dock swap", () => {
  test("Blame in the History diff replaces the History list; the dock shows the commit of the selected line; Escape returns", async () => {
    const { mountWorkbench, HEAD } = await import("./inspection-workbench");
    const w = await mountWorkbench(() => blameResult([{ oid: HEAD, time: NOW_S - DAY }], [{ commit: 0, count: 2 }], { commit: HEAD, pathBytes: b64("src/a.txt") }));
    unmounts.push(w.unmount);
    await w.selectCommit();
    const blame = [...document.querySelectorAll<HTMLButtonElement>('[data-slot="history-diff"] button')].find((b) => text(b) === "Blame")!;
    await click(blame);
    await w.serve();
    const section = document.querySelector<HTMLElement>('section[aria-label="History"]')!;
    expect(section.querySelector('section[data-slot="blame-view"]')).not.toBeNull();
    expect(section.querySelector<HTMLElement>("[data-history-list]")!.closest("[hidden]")).not.toBeNull();
    expect(text(section.querySelector('section[data-slot="blame-view"] h2')!)).toBe(`Blame: src/a.txt at ${HEAD.slice(0, 12)}`);
    expect(text(document.querySelector('section[aria-label="Dock"]')!)).toContain("Selected commit");
    const first = section.querySelector<HTMLElement>('[data-slot="blame-view"] [role="option"]')!;
    await act(async () => first.focus());
    await key(first, "Escape");
    expect(section.querySelector('section[data-slot="blame-view"]')).toBeNull();
    expect(section.querySelector<HTMLElement>("[data-history-list]")!.closest("[hidden]")).toBeNull();
    // T071, plan.md D15 "Blame keys": the focus returns to the History list, whose active option is the selected row.
    const list = section.querySelector<HTMLElement>("[data-history-list]")!;
    expect(document.activeElement === list).toBe(true);
    const active = document.getElementById(list.getAttribute("aria-activedescendant") ?? "");
    expect(active?.getAttribute("aria-selected")).toBe("true");
  });
});

// ---- Review fixes of WP6 (2, 3, 4, 6, 7) ----

describe("select the line's commit (spec FR-056)", () => {
  test("a commit 5,000 rows down while the view holds 1,000 rows loads, then gets selected", async () => {
    const { createFake, oid } = await import("./history-fake");
    const { createHistoryView } = await import("../../src/frontend/state/history-view");
    const fake = createFake({ total: 10_000, loaded: 1_000 });
    const history = createHistoryView(fake.bridge, TARGET);
    await act(async () => void (await history.open("all", false)));
    // The loaded rows lack the commit, so the plain row read cannot select it.
    expect(await history.selectOid(oid(5_000))).toBe("unknown");
    let target: unknown;
    await act(async () => void (target = await history.revealOid(oid(5_000))));
    expect(target).toBe("found");
    expect(history.getState().selection).toEqual({ id: oid(5_000), index: 5_000, mode: "full" });
  });
});

const harness = async () => {
  const { mountWorkbench, HEAD } = await import("./inspection-workbench");
  const w = await mountWorkbench(() => blameResult([{ oid: HEAD, time: NOW_S - DAY }], [{ commit: 0, count: 2 }], { commit: HEAD, pathBytes: b64("src/a.txt") }));
  unmounts.push(w.unmount);
  await w.selectCommit();
  const openBlame = async () => {
    await click([...document.querySelectorAll<HTMLButtonElement>('[data-slot="history-diff"] button')].find((b) => text(b) === "Blame")!);
    await w.serve();
  };
  const blameShown = () => document.querySelector('section[aria-label="History"] section[data-slot="blame-view"]') !== null;
  return { w, openBlame, blameShown };
};

describe("workbench state across the blame view", () => {
  test("the Pierre pool stays mounted when the History diff leaves the dock", async () => {
    const { openBlame } = await harness();
    expect(pool.live).toBeGreaterThan(0);
    await openBlame();
    // The dock shows only the line details now, so the History diff and its region are gone.
    expect(document.querySelector('[data-slot="history-diff"]')).toBeNull();
    expect(pool.live).toBeGreaterThan(0);
  });

  test("a service session closes the blame view", async () => {
    const { w, openBlame, blameShown } = await harness();
    await openBlame();
    expect(blameShown()).toBe(true);
    await w.setSession(1);
    // The same repository shows again, so the History section is back. The blame view of the ended session is gone.
    expect(document.querySelector('section[aria-label="History"] [data-history-list]')).not.toBeNull();
    expect(blameShown()).toBe(false);
  });

  test("another repository closes the blame view", async () => {
    const other = await harness();
    await other.openBlame();
    expect(other.blameShown()).toBe(true);
    // Ctrl+O runs chooseRepository. Its registration opens another repository.
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "o", keyCode: latinKeyCode("o"), ctrlKey: true, bubbles: true, cancelable: true })));
    await other.w.openOther();
    expect(other.blameShown()).toBe(false);
  });

  test("Changed files keeps its layout across Back", async () => {
    const { openBlame } = await harness();
    const flat = () => document.querySelector<HTMLElement>('[data-slot="changed-files"] button[aria-label="Flat layout"]')!;
    await click(flat());
    expect(flat().getAttribute("aria-pressed")).toBe("true");
    await openBlame();
    await key(document.querySelector('section[data-slot="blame-view"] [role="option"]')!, "Escape");
    expect(flat().getAttribute("aria-pressed")).toBe("true");
  });

  test("Ctrl+F does not move the focus to the hidden History filter while the blame view shows", async () => {
    const { openBlame } = await harness();
    await openBlame();
    const line = document.querySelector<HTMLElement>('section[data-slot="blame-view"] [role="option"]')!;
    await act(async () => line.focus());
    await key(line, "f", { ctrlKey: true });
    expect(document.activeElement).toBe(line);
  });
});

// ---- Finding 1 (T065 contract source `{blameId}`): an option change re-blames the shown result ----

describe("options re-blame the shown result (plan.md D12)", () => {
  const OFF = { ignoreWhitespace: false, detectMoves: false, detectCopies: false, ignoreList: true };
  test("after Blame before this commit, each toggle sends the shown result's blameId and shows the new result", async () => {
    const m = await answered();
    await key(line(m.host, 1), "ArrowLeft", { altKey: true });
    const before = { ...THREE(), commit: P, focusLine: 2 };
    await act(async () => m.d.last().resolve(succeeded(before)));
    await settle();
    let shown: { blameId: string } = before;
    const toggles = [
      ["Ignore whitespace", "ignoreWhitespace"],
      ["Detect moved lines", "detectMoves"],
      ["Detect lines from other files", "detectCopies"],
    ] as const;
    const options: Record<string, boolean> = { ...OFF };
    for (const [label, option] of toggles) {
      await click(button(m.host, label));
      options[option] = true;
      expect(m.d.last().payload).toEqual({ source: { blameId: shown.blameId }, options });
      const next = { ...THREE(), commit: P };
      await act(async () => m.d.last().resolve(succeeded(next)));
      await settle();
      expect(text(view(m.host).querySelector("h2")!)).toBe(`Blame: src/login.ts at ${P.slice(0, 12)}`);
      expect(text(view(m.host))).not.toContain("UNKNOWN_TARGET");
      expect(lines(m.host).length).toBe(6);
      shown = next;
    }
  });

  test("a toggle before any result keeps the original source", async () => {
    const m = await mountBlame();
    await click(button(m.host, "Ignore whitespace"));
    expect(m.d.last().payload).toEqual({ source: SOURCE, options: { ...OFF, ignoreWhitespace: true } });
  });

  test("a toggle after a History refresh sends the shown result's blameId", async () => {
    const { mountWorkbench, HEAD } = await import("./inspection-workbench");
    const results: { blameId: string }[] = [];
    const w = await mountWorkbench(() => {
      const r = blameResult([{ oid: HEAD, time: NOW_S - DAY }], [{ commit: 0, count: 2 }], { commit: HEAD, pathBytes: b64("src/a.txt") });
      results.push(r);
      return r;
    });
    unmounts.push(w.unmount);
    await w.selectCommit();
    await click([...document.querySelectorAll<HTMLButtonElement>('[data-slot="history-diff"] button')].find((b) => text(b) === "Blame")!);
    await w.serve();
    // F5 refreshes the History view. Its new view drops the listing, not the retained blame.
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true })));
    await w.serve();
    const toggle = [...document.querySelectorAll<HTMLButtonElement>('section[data-slot="blame-view"] button')].find((b) => text(b) === "Detect moved lines")!;
    await click(toggle);
    const reads = w.calls.filter((c) => c.operation === "readBlame");
    expect(reads.at(-1)!.args[1]).toEqual({ source: { blameId: results.at(-1)!.blameId }, options: { ...OFF, detectMoves: true } });
  });
});
