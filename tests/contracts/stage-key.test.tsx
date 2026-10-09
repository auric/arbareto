// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChangeEntry } from "../../src/contracts/envelope";
import { printOrigin } from "../origin";
import { ChangesPane } from "../../src/frontend/changes/ChangesPane";

printOrigin("../../src/frontend/changes/ChangesPane.tsx", import.meta.dir);

// A pending case fails under `bun test --todo` until a mounted-DOM test can run it.
const pending = (name: string) => test.todo(name, () => {
  throw new Error("needs a mounted DOM");
});

// plan.md "Task flow and command placement" (Stage or unstage), "Long text", and "Keyboard and focus" (Stage key row).
const HELP = "Enter shows a file. Space stages or unstages it. The toolbar stages one hunk.";

const entry = (category: ChangeEntry["category"], path: string): ChangeEntry => ({
  entryId: crypto.randomUUID(),
  category,
  path,
  pathBytes: Buffer.from(path).toString("base64"),
});
const entries = [entry("unstaged", "src/a.ts"), entry("unstaged", "src/b.ts"), entry("untracked", "notes.txt"), entry("staged", "src/a.ts")];
const render = () => renderToStaticMarkup(<ChangesPane entries={entries} selection={null} onSelect={() => {}} onFileAction={() => new Promise(() => {})} />);

const attr = (attrs: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)?.[1];
function textById(html: string, id: string): string {
  const open = new RegExp(`<(\\w+)\\b[^>]*\\sid="${id}"[^>]*>`).exec(html);
  expect(open).not.toBeNull();
  return html.slice(open!.index + open![0].length, html.indexOf(`</${open![1]}>`, open!.index)).replace(/<[^>]+>/g, "");
}
// The accessible name of an element: its `aria-label`, or the text of its `aria-labelledby` targets.
const nameOf = (html: string, attrs: string) => attr(attrs, "aria-label") ?? (attr(attrs, "aria-labelledby") ?? "").split(/\s+/).filter(Boolean).map((id) => textById(html, id)).join(" ");

describe("Unstaged help line", () => {
  test("the help line shows the plan.md text on one line with an end ellipsis", () => {
    const html = render();
    const line = [...html.matchAll(/<(\w+)\b([^>]*)>([^<]*)<\/\1>/g)].filter((m) => m[3] === HELP);
    expect(line).toHaveLength(1);
    expect(attr(line[0]![2]!, "class")?.split(/\s+/)).toContain("truncate");
    // The 18/20 DIP help line height (plan.md density table, T124 token).
    expect(line[0]![2]).toContain("--h-help-line");
  });

  test("the Unstaged listbox carries the help text as its accessible description, and no other listbox does", () => {
    const html = render();
    const listboxes = [...html.matchAll(/<\w+\b([^>]*\srole="listbox"[^>]*)>/g)].map((m) => m[1]!);
    for (const name of ["Unstaged", "Untracked", "Staged"]) expect(listboxes.some((attrs) => nameOf(html, attrs).includes(name))).toBe(true);
    const described = listboxes.filter((attrs) => (attr(attrs, "aria-describedby") ?? "").split(/\s+/).filter(Boolean).some((id) => textById(html, id).includes(HELP)));
    expect(described).toHaveLength(1);
    expect(nameOf(html, described[0]!)).toContain("Unstaged");
  });
});

// The Stage key cases need focus, timed comparison arrival, and keyboard events on a mounted pane. The repository has no DOM test library.
describe("Stage key", () => {
  pending("Space on a focused, selected Unstaged or Untracked entry calls the callback once with direction stage and the shown comparison ID, and starts no read");
  pending("Space on a focused, selected Staged entry calls the callback once with direction unstage");
  pending("Space on an unselected focused entry first selects it, and the callback runs after its comparison arrives with the new comparison ID");
  pending("a focus or selection change before the comparison arrives cancels the pending action");
  pending("after succeeded, a second Space on the next entry with a pending comparison starts no second read and runs the callback once after it arrives");
  pending("a selection change before that comparison arrives cancels the second Space");
  pending("while an injected file action runs, Space calls nothing and the pane reports the busy reason, and the role=status text stays unchanged");
  pending("the busy reason clears when the action ends");
  pending("after succeeded, focus and selection move to the next entry, else the previous entry, else the category heading, and the new entry requests its comparison");
  pending("an injected toolbar button success moves focus and selection the same way");
  pending("a failed result keeps focus and selection");
  pending("without a running operation, a refusal shows in the status bar and keeps focus; with a running operation, the status bar keeps the operation text");
  pending("a Conflicted entry gives a refusal");
  pending("Space with Ctrl, Shift, or Alt, with repeat true, in an editable target, during composition, or with a dialog or menu open calls nothing");
  pending("a second Space while the callback runs calls nothing");
  pending("Enter selects and calls no callback");
});
