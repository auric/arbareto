// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import type { ChangeEntry } from "../../src/contracts/envelope";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";

printOrigin("../../src/frontend/changes/ComparisonView.tsx", import.meta.dir);
printOrigin("../../src/frontend/changes/hunk-mapping.ts", import.meta.dir);
// `ComparisonView.tsx` loads Base UI. Base UI must first evaluate with a DOM (tests/dom.ts).
registerDom();
const { createRoot } = await import("react-dom/client");
const { ComparisonView } = await import("../../src/frontend/changes/ComparisonView");
const { mapHunks } = await import("../../src/frontend/changes/hunk-mapping");

// plan.md "Required visible states" and contract §4: the comparison pane of T134. The diff body (Pierre and its worker) needs the Vite build (T160).

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
const text = (host: HTMLElement) => (host.textContent ?? "").replace(/\s+/g, " ").trim();
const buttons = (host: HTMLElement) => [...host.querySelectorAll("button")].map((b) => b.textContent);
const noop = () => {};

const entry: ChangeEntry = { entryId: crypto.randomUUID(), category: "unstaged", path: "src/big.bin", pathBytes: Buffer.from("src/big.bin").toString("base64") } as ChangeEntry;
const ok = (result: unknown) => ({ state: "succeeded", result }) as never;
const limited = (result: unknown) => ({ state: "limited", result }) as never;
const base64 = (s: string) => Buffer.from(s).toString("base64");
const remedy = { text: "Stage this file in a terminal.", command: "& 'C:\\Git\\cmd\\git.exe' --literal-pathspecs -C 'D:\\repo' add -- 'src/big.bin'" };
const PATCH = "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n a\n+n\n b\n@@ -10 +11 @@\n-c\n+d\n";
const hunk = (ordinal: number, oldStart: number, oldCount: number, newStart: number, newCount: number) => ({ hunkId: crypto.randomUUID(), ordinal, oldStart, oldCount, newStart, newCount, digest: String(ordinal).repeat(64) });
const HUNKS = [hunk(0, 1, 2, 1, 3), hunk(1, 10, 1, 11, 1)];
const comparison = (fields: Record<string, unknown>) => ({
  comparisonId: crypto.randomUUID(),
  snapshotId: crypto.randomUUID(),
  entryId: entry.entryId,
  scope: "index-to-worktree",
  completeness: { state: "complete" },
  patch: base64(""),
  hunks: [],
  support: "binary",
  fileAction: "stage",
  remedy: null,
  ...fields,
});

describe("comparison view", () => {
  test("without a selected entry, it shows the hint", async () => {
    expect(text(await show(<ComparisonView entry={null} response={null} selectedHunk={null} onRefresh={noop} />))).toContain("Select a file to view its changes");
  });

  test("a pending read shows the heading with the path and scope, and the Loading placeholder", async () => {
    const host = await show(<ComparisonView entry={entry} response={null} selectedHunk={null} onRefresh={noop} />);
    for (const part of ["src/", "big.bin", "Unstaged", "Loading…"]) expect(text(host)).toContain(part);
  });

  test("the heading names the sides of the contract scope", async () => {
    const host = await show(<ComparisonView entry={entry} response={ok(comparison({}))} selectedHunk={null} onRefresh={noop} />);
    expect(host.querySelector("h2")!.getAttribute("aria-label")).toBe("src/big.bin, Unstaged, Index to working file");
  });

  test("an unsupported entry that applyFile refuses shows the limitation sentence beside the remedy with Copy command, and no diff", async () => {
    const host = await show(<ComparisonView entry={entry} response={ok(comparison({ support: "size", fileAction: "size", remedy }))} selectedHunk={null} onRefresh={noop} />);
    for (const part of ["This file is larger than the Arbareto size limit.", remedy.text, remedy.command]) expect(text(host)).toContain(part);
    expect(buttons(host)).toEqual(["Copy path", "Copy command"]);
    expect(host.querySelector("diffs-container")).toBeNull();
  });

  test("a limited supported comparison shows the limit, never a diff", async () => {
    const result = comparison({ support: "supported", completeness: { state: "limited", code: "OUTPUT_LIMIT", reason: "CANONICAL_DIFF_BYTES" }, patch: base64(PATCH), hunks: HUNKS });
    const host = await show(<ComparisonView entry={entry} response={limited(result)} selectedHunk={null} onRefresh={noop} />);
    expect(text(host)).toContain("OUTPUT_LIMIT CANONICAL_DIFF_BYTES");
    expect(host.querySelector("diffs-container")).toBeNull();
  });

  test("a missing object shows the limit and the object remedy text", async () => {
    const result = { completeness: { state: "limited", code: "OBJECT_MISSING" }, scope: "head-to-index", support: null, fileAction: "stage", remedy: null, objectRemedy: { text: "Run git fsck." } };
    const host = await show(<ComparisonView entry={{ ...entry, category: "staged" }} response={limited(result)} selectedHunk={null} onRefresh={noop} />);
    for (const part of ["OBJECT_MISSING", "Run git fsck.", "Current commit to index"]) expect(text(host)).toContain(part);
  });

  test("a failed read shows its code and Refresh", async () => {
    const host = await show(<ComparisonView entry={entry} response={{ state: "failed", code: "UNKNOWN_TARGET" } as never} selectedHunk={null} onRefresh={noop} />);
    expect(text(host)).toContain("UNKNOWN_TARGET");
    expect(buttons(host)).toEqual(["Copy path", "Refresh (F5)"]);
  });

  test("a display mapping disagreement shows DISPLAY_MAPPING_FAILED and no diff", async () => {
    const result = comparison({ support: "supported", patch: base64(PATCH), hunks: [HUNKS[0], hunk(1, 10, 1, 12, 1)] });
    const host = await show(<ComparisonView entry={entry} response={ok(result)} selectedHunk={null} onRefresh={noop} />);
    expect(text(host)).toContain("DISPLAY_MAPPING_FAILED");
    expect(host.querySelector("diffs-container")).toBeNull();
  });
});

describe("hunk mapping", () => {
  test("each Pierre hunk maps to the service hunk with the same ordinal and ranges, one-line headers included", () => {
    const mapping = mapHunks(PATCH, HUNKS);
    expect(mapping.ok && mapping.hunkIds).toEqual(HUNKS.map((h) => h.hunkId));
  });

  test("empty-side ranges map", () => {
    const added = "diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+a\n+b\n";
    expect(mapHunks(added, [hunk(0, 0, 0, 1, 2)]).ok).toBe(true);
    const deleted = "diff --git a/d b/d\ndeleted file mode 100644\n--- a/d\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n";
    expect(mapHunks(deleted, [hunk(0, 1, 2, 0, 0)]).ok).toBe(true);
  });

  for (const [name, patch, hunks] of [
    ["a missing service hunk", PATCH, HUNKS.slice(0, 1)],
    ["an extra service hunk", PATCH, [...HUNKS, hunk(2, 20, 1, 21, 1)]],
    ["a range shifted by one line", PATCH, [HUNKS[0]!, hunk(1, 11, 1, 11, 1)]],
    ["a wrong ordinal", PATCH, [HUNKS[0]!, hunk(2, 10, 1, 11, 1)]],
    ["a patch with two files", PATCH + PATCH.replaceAll(" a/x", " a/y").replaceAll(" b/x", " b/y"), HUNKS],
    ["text without a patch", "not a patch\n", HUNKS],
  ] as const) {
    test(`${name} gives DISPLAY_MAPPING_FAILED`, () => {
      expect(mapHunks(patch, hunks)).toEqual({ ok: false, code: "DISPLAY_MAPPING_FAILED" });
    });
  }
});
