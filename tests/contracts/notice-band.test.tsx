// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChangeEntry, RecoveryStatement, WorkspaceSnapshot } from "../../src/contracts/envelope";
import type { SubmoduleRowResult } from "../../src/contracts/submodules";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { NoticeBand } from "../../src/frontend/app/NoticeBand";
import { contractChecked } from "./bridge-contract";

printOrigin("../../src/frontend/app/NoticeBand.tsx", import.meta.dir);

printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
// Pierre and its worker need the Vite build (T160).
mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre data-slot="patch-double">{patch}</pre> }));
// `Workbench.tsx` loads Base UI. Base UI must first evaluate with a DOM (tests/dom.ts).
registerDom();
const { createRoot } = await import("react-dom/client");
const { ChangesPaneMount, ComparisonViewMount, HistoryViewMount, Workbench } = await import("../../src/frontend/app/Workbench");

// plan.md "Notice band" and "Long text".
const SECOND = "Arbareto blocks changes until you finish it outside Arbareto and select Refresh (F5).";
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const attr = (attrs: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)?.[1];
const count = (text: string, part: string) => text.split(part).length - 1;

type BandProps = Parameters<typeof NoticeBand>[0];
const band = (props: BandProps) => renderToStaticMarkup(<NoticeBand {...props} />);
const SUBMODULE_ROW = <p>submodule row double</p>;

describe("notice band", () => {
  for (const [operationState, conflicted, first] of [
    ["rebasing", 2, "A rebase is in progress, with 2 conflicted files."],
    ["rebasing", 1, "A rebase is in progress, with 1 conflicted file."],
    ["merging", 0, "A merge is in progress."],
    ["cherry-picking", 0, "A cherry-pick is in progress."],
    ["reverting", 0, "A revert is in progress."],
    ["sequencer-active", 0, "A cherry-pick or revert sequence is in progress."],
    ["sequencer-active", 3, "A cherry-pick or revert sequence is in progress, with 3 conflicted files."],
    ["unknown", 0, "Arbareto cannot identify the Git operation in progress."],
    ["unknown", 1, "Arbareto cannot identify the Git operation in progress, with 1 conflicted file."],
    ["conflicted", 2, "2 files have conflicts."],
    ["conflicted", 1, "1 file has conflicts."],
  ] as const) {
    test(`${operationState} with ${conflicted} conflicted files gives one blocking row: "${first}"`, () => {
      const text = plain(band({ operationState, conflicted }));
      expect(count(text, first)).toBe(1);
      // Feature 003 FR-030: a merge or a rebase in progress gets the conflict actions, so the 001 second sentence goes.
      if (operationState === "merging" || operationState === "rebasing") return expect(count(text, SECOND)).toBe(0);
      expect(count(text, SECOND)).toBe(1);
      expect(text.indexOf(SECOND)).toBeGreaterThan(text.indexOf(first));
    });
  }

  test("the submodule row follows the blocking row, and the blocking row has the Warning icon and its text", () => {
    const html = band({ operationState: "rebasing", conflicted: 2, submoduleRow: SUBMODULE_ROW });
    const blocking = html.indexOf("A rebase is in progress");
    expect(blocking).toBeGreaterThan(0);
    expect(html.indexOf("submodule row double")).toBeGreaterThan(blocking);
    expect(html.slice(0, blocking)).toContain("<svg");
  });

  test("without a notice, the band renders nothing", () => {
    expect(band({ operationState: "normal", conflicted: 0 })).toBe("");
  });

  test("a submodule row alone renders the band", () => {
    const html = band({ operationState: "normal", conflicted: 0, submoduleRow: SUBMODULE_ROW });
    expect(html).toContain("submodule row double");
    expect(plain(html)).not.toContain(SECOND);
  });

  test("with a row, the band is a region named by its visible heading Notices, which only code focuses and which precedes the rows", () => {
    for (const props of [{ operationState: "merging", conflicted: 0 }, { operationState: "normal", conflicted: 0, submoduleRow: SUBMODULE_ROW }] as BandProps[]) {
      const html = band(props);
      const headingOf = (attrs: string) => new RegExp(`<(\\w+)\\b([^>]*\\sid="${attr(attrs, "aria-labelledby")}"[^>]*)>([^<]*)</\\1>`).exec(html);
      const regions = [...html.matchAll(/<(\w+)\b([^>]*\saria-labelledby="[^"]*"[^>]*)>/g)].filter((m) => (m[1] === "section" || attr(m[2]!, "role") === "region") && headingOf(m[2]!)?.[3] === "Notices");
      expect(regions).toHaveLength(1);
      const heading = headingOf(regions[0]![2]!)!;
      expect(attr(heading[2]!, "tabindex")).toBe("-1");
      const firstRow = Math.min(...["A merge is in progress", "submodule row double"].map((t) => html.indexOf(t)).filter((i) => i >= 0));
      expect(heading.index).toBeLessThan(firstRow);
    }
  });
});

// plan.md "Required visible states", Recovery statement.
const OID = "0123456789abcdef0123456789abcdef01234567";
const NONE = "The earlier session ended, and Arbareto found nothing to reconcile.";
const FOREIGN = "Another Git process or a crash can have left these files. Remove them only after all Git tools stop, including other Arbareto windows.";
const LOCKS = ["C:\\repo\\.git\\index.lock", "C:\\repo\\.git\\arbareto-candidate-1"];
const recoveryText = (recovery: RecoveryStatement) => plain(band({ operationState: "normal", conflicted: 0, recovery }));

describe("recovery row", () => {
  for (const [name, recovery, sentence] of [
    ["outcome none", { outcome: "none" }, NONE],
    ["attribution identified", { outcome: "unknown", attribution: { result: "identified", commitOid: OID } }, "The interrupted commit exists as 0123456789ab."],
    ["attribution none", { outcome: "unknown", attribution: { result: "none" } }, "The interrupted operation made no commit."],
    [
      "attribution unknown, ambiguous",
      { outcome: "unknown", attribution: { result: "unknown", reason: "ambiguous" } },
      "Arbareto cannot tell if the interrupted operation made a commit, because the branch history does not identify one commit.",
    ],
    [
      "attribution unknown, evidence-limit",
      { outcome: "unknown", attribution: { result: "unknown", reason: "evidence-limit" } },
      "Arbareto cannot tell if the interrupted operation made a commit, because the branch history holds more records than Arbareto checks.",
    ],
    [
      "attribution unknown, no-retained-request",
      { outcome: "unknown", attribution: { result: "unknown", reason: "no-retained-request" } },
      "Arbareto cannot tell what the interrupted operation changed, because this Git service session has no record of its request.",
    ],
    ["indexMatch published", { outcome: "unknown", indexMatch: "published" }, "The interrupted hunk or file action reached the index."],
    ["indexMatch not-published", { outcome: "unknown", indexMatch: "not-published" }, "The interrupted hunk or file action did not reach the index."],
    ["indexMatch neither", { outcome: "unknown", indexMatch: "neither" }, "The index matches neither the state before nor the state after the interrupted hunk or file action."],
  ] as [string, RecoveryStatement, string][]) {
    test(`${name} reads "${sentence}"`, () => {
      const text = recoveryText(recovery);
      expect(count(text, sentence)).toBe(1);
    });
  }

  test("outcome unknown gives no sentence, and the sentences follow the field order", () => {
    const text = recoveryText({ outcome: "unknown", attribution: { result: "none" }, indexMatch: "published", foreign: [LOCKS[0]!] });
    const parts = ["The interrupted operation made no commit.", "The interrupted hunk or file action reached the index.", FOREIGN, LOCKS[0]!];
    expect(parts.map((p) => text.indexOf(p))).toEqual(parts.map((p) => text.indexOf(p)).toSorted((a, b) => a - b));
    expect(parts.every((p) => text.includes(p))).toBe(true);
    expect(text).not.toContain(NONE);
  });

  test("foreign shows its sentence and each path on its own line in the code font", () => {
    const html = band({ operationState: "normal", conflicted: 0, recovery: { outcome: "unknown", foreign: LOCKS } });
    expect(count(plain(html), FOREIGN)).toBe(1);
    const host = document.createElement("div");
    host.innerHTML = html;
    const codes = [...host.querySelectorAll("code")];
    expect(codes.map((c) => c.textContent)).toEqual(LOCKS);
    for (const code of codes) expect(code.getAttribute("class")?.split(/\s+/)).toContain("block");
    expect(plain(html)).not.toContain("more file");
  });

  test("foreignTotal ends the list with and <n> more files, and a count of 1 takes the singular", () => {
    const end = (foreignTotal: number) => recoveryText({ outcome: "unknown", foreign: LOCKS, foreignTotal });
    expect(end(9)).toEndWith(`${LOCKS[1]} and 7 more files`);
    expect(end(3)).toEndWith(`${LOCKS[1]} and 1 more file`);
  });

  // plan.md "Updating submodules" row state texts.
  const OLD = "fedcba9876543210fedcba9876543210fedcba98";
  const subRow = (path: string, state: SubmoduleRowResult["state"], extra: Partial<SubmoduleRowResult> = {}): SubmoduleRowResult => ({
    rowId: crypto.randomUUID(),
    path,
    state,
    oldCommit: OLD,
    newCommit: OID,
    fetched: false,
    connected: false,
    found: false,
    registered: false,
    ...extra,
  });
  const SUB_ROWS: [SubmoduleRowResult, string][] = [
    [subRow("lib/a", "cloned", { oldCommit: null }), "lib/a: Cloned"],
    [subRow("lib/b", "moved"), "lib/b: Moved from fedcba987654 to 0123456789ab"],
    [subRow("lib/c", "unchanged", { newCommit: OLD }), "lib/c: No change"],
    [subRow("lib/d", "failed", { failedRead: "check" }), "lib/d: Failed"],
    [subRow("lib/e", "clone-interrupted", { folderPath: "lib/e", text: "t", remedy: { command: null, text: "r" } }), "lib/e: Clone interrupted"],
    [subRow("lib/f", "changed-elsewhere"), "lib/f: Changed elsewhere to 0123456789ab"],
    [subRow("lib/g", "refused", { reason: "update-mode", text: "t" }), "lib/g: Refused"],
  ];
  const SUB_INTRO = "The interrupted submodule update left these rows:";

  test("submoduleResults adds its sentence, then one line per row with the row state text, in field order", () => {
    const html = band({ operationState: "normal", conflicted: 0, recovery: { outcome: "unknown", indexMatch: "published", submoduleResults: SUB_ROWS.map(([r]) => r), foreign: [LOCKS[0]!] } });
    const text = plain(html);
    const parts = ["The interrupted hunk or file action reached the index.", SUB_INTRO, ...SUB_ROWS.map(([, line]) => line), FOREIGN, LOCKS[0]!];
    expect(parts.every((p) => count(text, p) === 1)).toBe(true);
    expect(parts.map((p) => text.indexOf(p))).toEqual(parts.map((p) => text.indexOf(p)).toSorted((a, b) => a - b));
    const host = document.createElement("div");
    host.innerHTML = html;
    const lines = [...host.querySelectorAll("p")].map((p) => p.textContent);
    for (const [, line] of SUB_ROWS) expect(lines).toContain(line);
  });

  test("submoduleResults alone renders the row; without it the row has no submodule sentence", () => {
    expect(recoveryText({ outcome: "unknown", submoduleResults: [SUB_ROWS[0]![0]] })).toContain(`${SUB_INTRO} lib/a: Cloned`);
    expect(recoveryText({ outcome: "none" })).not.toContain(SUB_INTRO);
  });

  test("the row shows the Warning icon, has no control, and follows the submodule row; it alone renders the band", () => {
    const html = band({ operationState: "merging", conflicted: 0, submoduleRow: SUBMODULE_ROW, recovery: { outcome: "none" } });
    const row = html.indexOf(NONE);
    expect(row).toBeGreaterThan(html.indexOf("submodule row double"));
    expect(html.slice(html.indexOf("submodule row double"), row)).toContain("<svg");
    expect(band({ operationState: "normal", conflicted: 0, recovery: { outcome: "none" } })).not.toContain("<button");
    expect(plain(band({ operationState: "normal", conflicted: 0, recovery: { outcome: "none" } }))).toContain("Notices");
  });
});

describe("recovery row lifetime in the workbench", () => {
  type Call = { operation: string; args: unknown[]; resolve(response: unknown): void };
  const unmounts: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const unmount of unmounts.splice(0)) await unmount();
    localStorage.clear();
  });
  const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 50))));
  const succeeded = (result: unknown) => ({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "succeeded", repositoryGeneration: 1, result });
  const registration = () => ({ repositoryId: crypto.randomUUID(), generation: 1, worktreeKey: "a".repeat(64) });
  const snapshot = (fields: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot => ({
    generation: 1,
    snapshotId: crypto.randomUUID(),
    readKind: "full",
    identity: { worktreeRoot: "C:\\repo", gitDirectory: "C:\\repo\\.git", commonDirectory: "C:\\repo\\.git", indexPath: "C:\\repo\\.git\\index", objectFormat: "sha1", refFormat: "files" },
    head: { state: "branch", target: "refs/heads/main", oid: OID },
    operationState: "normal",
    recoveryState: "ready",
    completeness: { state: "complete" },
    hunkEligibility: { eligible: true },
    location: { kind: "native" },
    submoduleNotice: { count: 0, paths: [], filter: "applied" },
    entryCount: 0,
    entries: [],
    cursor: null,
    ...fields,
  });
  const shown = () => (document.body.textContent ?? "").includes(NONE);

  async function mount() {
    const calls: Call[] = [];
    const bridge = contractChecked(new Proxy({}, { get: (_, name) => (...args: unknown[]) => new Promise((resolve) => calls.push({ operation: String(name), args, resolve })) }));
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <Workbench bridge={bridge as never} environment={null} restored={Promise.resolve(succeeded(registration())) as never} ChangesPane={ChangesPaneMount} ComparisonView={ComparisonViewMount} HistoryView={HistoryViewMount} />,
      ),
    );
    unmounts.push(async () => {
      await act(async () => root.unmount());
      host.remove();
    });
    await settle();
    const resolved = new Set<Call>();
    // Resolves the one pending read whose payload has this `refresh` value.
    const resolveRead = async (refresh: boolean, result: WorkspaceSnapshot) => {
      const pending = calls.filter((c) => c.operation === "readWorkspace" && !resolved.has(c) && (c.args[1] as { refresh: boolean }).refresh === refresh);
      expect(pending).toHaveLength(1);
      resolved.add(pending[0]!);
      await act(async () => pending[0]!.resolve(succeeded(result)));
      await settle();
    };
    const click = async (label: string) => {
      const target = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent) === label)!;
      await act(async () => target.click());
      await settle();
    };
    return { calls, resolveRead, click };
  }

  test("a refresh: true read with recovery shows the row; a refresh: false read keeps it; the next refresh: true read removes it", async () => {
    const view = await mount();
    await view.resolveRead(false, snapshot());
    expect(shown()).toBe(false);
    await view.click("Refresh");
    await view.resolveRead(true, snapshot({ recovery: { outcome: "none" } }));
    expect(shown()).toBe(true);
    await act(async () => void (window.dispatchEvent(new Event("blur")), window.dispatchEvent(new Event("focus"))));
    await settle();
    await view.resolveRead(false, snapshot());
    expect(shown()).toBe(true);
    await view.click("Refresh");
    await view.resolveRead(true, snapshot());
    expect(shown()).toBe(false);
  });

  test("another repository removes the row", async () => {
    const view = await mount();
    await view.resolveRead(false, snapshot());
    await view.click("Refresh");
    await view.resolveRead(true, snapshot({ recovery: { outcome: "none" } }));
    expect(shown()).toBe(true);
    // Ctrl+O runs Open folder (plan.md "Keyboard and focus").
    await act(async () => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "o", code: "KeyO", keyCode: 79, ctrlKey: true, bubbles: true, cancelable: true })));
    await settle();
    const choose = view.calls.filter((c) => c.operation === "chooseRepository").at(-1)!;
    await act(async () => choose.resolve(succeeded({ ...registration(), worktreeKey: "b".repeat(64) })));
    await settle();
    await view.resolveRead(false, snapshot());
    expect(shown()).toBe(false);
  });
});
