// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerDom } from "../dom";

// `registerDom` gives DOM nodes a short inspect form, so a failed `toBe` between two elements prints its message fast.

console.log(`ORIGIN ${Bun.resolveSync("../dom.ts", import.meta.dir)}`);
registerDom();

const CHILD_TIMEOUT_MS = 60_000;
// Without the hook, one inspect of a large tree took about 20 GB. The tests check for the hook first and stop cheaply.
const CHILD_HOOK_CHECK = 'if (!Object.hasOwn(Node.prototype, Symbol.for("nodejs.util.inspect.custom"))) throw new Error("registerDom installed no inspect hook");';
const scratch = mkdtempSync(join(tmpdir(), "arbareto-dom-inspect-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function bigTree(): HTMLElement {
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Actions");
  for (let i = 0; i < 2000; i += 1) {
    const item = document.createElement("div");
    item.setAttribute("role", "menuitem");
    item.id = `item-${i}`;
    item.textContent = `Item ${i}`;
    menu.append(item);
  }
  document.body.append(menu);
  return menu;
}

test("Bun.inspect of a large DOM tree gives the short form", () => {
  if (!Object.hasOwn(Node.prototype, Symbol.for("nodejs.util.inspect.custom"))) throw new Error("registerDom installed no inspect hook");
  const menu = bigTree();
  expect(Bun.inspect(menu)).toBe('<DIV role="menu" aria-label="Actions" text="Item 0Item 1Item 2Item 3Item 4Item 5Item 6Item 7Item 8Item 9">');
  expect(Bun.inspect(menu.firstChild)).toBe('<DIV role="menuitem" id="item-0" text="Item 0">');
  expect(Bun.inspect(menu.firstChild!.firstChild)).toBe('<#text text="Item 0">');
  menu.remove();
});

test(
  "a failed toBe between two elements of a React tree fails with the short form",
  () => {
    const child = join(scratch, "fail.test.ts");
    writeFileSync(
      child,
      [
        'import { expect, test } from "bun:test";',
        `import { registerDom } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "..", "dom.ts")).href)};`,
        "registerDom();",
        `const { act, createElement } = await import(${JSON.stringify(Bun.resolveSync("react", import.meta.dir))});`,
        `const { createRoot } = await import(${JSON.stringify(Bun.resolveSync("react-dom/client", import.meta.dir))});`,
        'test("focus", async () => {',
        '  const host = document.createElement("div");',
        "  document.body.append(host);",
        "  const items = Array.from({ length: 2000 }, (_, i) => createElement(\"div\", { key: i, role: \"menuitem\", tabIndex: -1 }, `Item ${i}`));",
        '  await act(async () => createRoot(host).render(createElement("div", { role: "menu", "aria-label": "Actions", tabIndex: -1 }, items)));',
        '  const menu = host.querySelector<HTMLElement>("[role=menu]")!;',
        "  menu.focus();",
        `  ${CHILD_HOOK_CHECK}`,
        "  expect(document.activeElement).toBe(menu.firstElementChild);",
        "});",
      ].join("\n"),
    );
    const run = Bun.spawnSync([process.execPath, "test", "./fail.test.ts"], { cwd: scratch, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: CHILD_TIMEOUT_MS });
    const output = `${run.stdout.toString()}${run.stderr.toString()}`;
    console.log(output.replace(/^/gm, "child> "));
    expect(output).toContain('Expected: <DIV role="menuitem" text="Item 0">');
    expect(output).toContain('Received: <DIV role="menu" aria-label="Actions" text=');
    expect(output).toMatch(/\b1 fail\b/);
    expect(run.exitCode).toBe(1);
  },
  CHILD_TIMEOUT_MS + 10_000,
);
