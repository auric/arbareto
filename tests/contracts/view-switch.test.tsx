// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { printOrigin } from "../origin";
import { Workbench } from "../../src/frontend/app/Workbench";

printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);

// A pending case fails under `bun test --todo` until a mounted-DOM test can run it.
const pending = (name: string) => test.todo(name, () => {
  throw new Error("needs a mounted DOM");
});

// plan.md "Selection, scroll, and stored context". T128 takes the changes pane and the comparison view as injected components.
function bridgeDouble() {
  const calls: string[] = [];
  const bridge = new Proxy({}, { get: (_, name) => () => (calls.push(String(name)), new Promise(() => {})) });
  return { bridge, calls };
}
const ChangesPaneDouble = () => <div>changes pane double</div>;
const ComparisonViewDouble = () => <div>comparison view double</div>;

describe("View menu", () => {
  test("the menu bar holds the View menu, and rendering sends no bridge request", () => {
    const { bridge, calls } = bridgeDouble();
    const html = renderToStaticMarkup(<Workbench bridge={bridge as never} ChangesPane={ChangesPaneDouble} ComparisonView={ComparisonViewDouble} />);
    const menubar = html.indexOf('role="menubar"');
    expect(menubar).toBeGreaterThanOrEqual(0);
    expect(html.slice(menubar)).toMatch(/<button[^>]*role="menuitem"[^>]*>View<\/button>/);
    expect(calls).toEqual([]);
  });

  // These cases open a Base UI menu, enter Changes, and read the root attributes. They need a DOM, and the repository has no DOM test library.
  pending("Light, Dark, and System from the View menu each change the root theme attribute and keep the selected entry");
  pending("Comfortable and Compact from the View menu each change the root density attribute and keep the selected entry");
  pending("a theme or density choice sends no bridge request");
  pending("a theme or density choice keeps the component key of the comparison, so it does not remount");
  // T148 cases: they need T145 and T146.
  pending("a theme or density choice keeps the draft text, the caret offset, and the selected hunk");
  pending("after the menu closes, the reported focus target is the message field again");
  pending("a theme or density choice keeps the component key of the composer, so it does not remount");
});
