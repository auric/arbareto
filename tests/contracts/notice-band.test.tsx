// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChangeEntry } from "../../src/contracts/envelope";
import { printOrigin } from "../origin";
import { NoticeBand } from "../../src/frontend/app/NoticeBand";
import { ScopeLine, fitScopeLine } from "../../src/frontend/history/HistoryView";

printOrigin("../../src/frontend/app/NoticeBand.tsx", import.meta.dir);
printOrigin("../../src/frontend/history/HistoryView.tsx", import.meta.dir);

// plan.md "Notice band", "Long text", and "History graph design" (scope line).
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
    ["conflicted", 2, "2 files have conflicts."],
    ["conflicted", 1, "1 file has conflicts."],
  ] as const) {
    test(`${operationState} with ${conflicted} conflicted files gives one blocking row: "${first}"`, () => {
      const text = plain(band({ operationState, conflicted }));
      expect(count(text, first)).toBe(1);
      expect(count(text, SECOND)).toBe(1);
      expect(text.indexOf(SECOND)).toBeGreaterThan(text.indexOf(first));
    });
  }

  test("the submodule row follows the blocking row, and the blocking row has the Warning icon and its text", () => {
    const html = band({ operationState: "rebasing", conflicted: 2, submoduleRow: SUBMODULE_ROW });
    const blocking = html.indexOf("A rebase is in progress");
    expect(blocking).toBeGreaterThan(0);
    expect(html.indexOf("submodule row double")).toBeGreaterThan(html.indexOf(SECOND));
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

const entries = (counts: Partial<Record<ChangeEntry["category"], number>>) =>
  Object.entries(counts).flatMap(([category, n]) => Array.from({ length: n }, () => ({ category: category as ChangeEntry["category"] })));

describe("History scope line", () => {
  const checkout = "main";

  test("conflicts come first with the Warning icon, and working changes count Unstaged and Untracked entries", () => {
    const html = renderToStaticMarkup(<ScopeLine checkout={checkout} entries={entries({ conflicted: 2, unstaged: 12, untracked: 7, staged: 11 })} />);
    expect(plain(html)).toContain("2 conflicted, 19 working changes, 11 staged");
    expect(html).toContain("<svg");
  });

  test("without conflicts, the line has no conflicted prefix and no icon", () => {
    const html = renderToStaticMarkup(<ScopeLine checkout={checkout} entries={entries({ unstaged: 12, untracked: 7, staged: 11 })} />);
    expect(plain(html)).toContain("19 working changes, 11 staged");
    expect(plain(html)).not.toContain("conflicted");
    expect(html).not.toContain("<svg");
  });

  test("a count of 1 takes the singular noun", () => {
    expect(plain(renderToStaticMarkup(<ScopeLine checkout={checkout} entries={entries({ untracked: 1, staged: 1 })} />))).toContain("1 working change, 1 staged");
  });

  test("before a complete read, the line shows the Loading placeholder", () => {
    const text = plain(renderToStaticMarkup(<ScopeLine checkout={checkout} entries={null} />));
    expect(text).toContain("Loading…");
    expect(text).not.toContain("working change");
  });

  test("the accessible name holds the full checkout name, the scope, both counts, and the limit text", () => {
    const name = "feature/" + "x".repeat(52);
    expect(name).toHaveLength(60);
    const limit = "Graph layout limited: more than 24 lanes";
    const html = renderToStaticMarkup(<ScopeLine checkout={name} entries={entries({ unstaged: 19, staged: 11 })} limit={limit} />);
    const label = [...html.matchAll(/\saria-label="([^"]*)"/g)].map((m) => m[1]!).find((l) => l.includes(name));
    expect(label).toBeDefined();
    for (const part of ["Up to 100 commits", "19 working changes", "11 staged", limit]) expect(label).toContain(part);
    expect(html).toContain("<svg");
  });

  test("the fit function shrinks the checkout name, then Up to 100 commits, then the limit text, and never the fixed parts", () => {
    const parts = { fixed: 200, checkout: { full: 300, min: 30 }, commits: { full: 120, min: 20 }, limit: { full: 250, min: 20 } };
    expect(fitScopeLine({ ...parts, width: 900 })).toEqual({ checkout: 300, commits: 120, limit: 250 });
    expect(fitScopeLine({ ...parts, width: 700 })).toEqual({ checkout: 130, commits: 120, limit: 250 });
    expect(fitScopeLine({ ...parts, width: 500 })).toEqual({ checkout: 30, commits: 20, limit: 250 });
    expect(fitScopeLine({ ...parts, width: 400 })).toEqual({ checkout: 30, commits: 20, limit: 150 });
    expect(fitScopeLine({ ...parts, width: 200 })).toEqual({ checkout: 30, commits: 20, limit: 20 });
  });
});
