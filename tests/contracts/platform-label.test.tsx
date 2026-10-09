// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import type { Environment } from "../../src/contracts/envelope";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";

printOrigin("../../src/frontend/app/RepositoryMenu.tsx", import.meta.dir);
// `RepositoryMenu.tsx` loads Base UI. Base UI must first evaluate with a DOM, because test files share one module cache (tests/dom.ts).
registerDom();
const { renderToStaticMarkup } = await import("react-dom/server");
const { GitVersionRow } = await import("../../src/frontend/app/RepositoryMenu");

// plan.md "Provisional prerequisite admission" and "About window": the label shows only with platform scope `other`.
const LABEL = "Unqualified platform";
const SCOPES: Environment["platformScope"][] = ["other", "qualification-target"];
const GIT = String.raw`C:\Program Files\Git\cmd\git.exe`;
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// T143 is not built. A template path keeps `tsc` from resolving the module before it exists.
const NEEDS = "(needs T143)";
async function aboutDialog(): Promise<{ AboutOverview: (props: { scope: Environment["platformScope"] }) => ReactNode }> {
  const module = "AboutDialog";
  printOrigin(`../../src/frontend/about/${module}.tsx`, import.meta.dir);
  return (await import(`../../src/frontend/about/${module}.tsx`)) as never;
}

describe("Unqualified platform label", () => {
  for (const scope of SCOPES) {
    test(`the repository menu Git version row with scope ${scope} ${scope === "other" ? "shows" : "does not show"} the label`, () => {
      const text = plain(renderToStaticMarkup(<GitVersionRow path={GIT} version="2.55.0.windows.1" scope={scope} />));
      expect(text).toContain(GIT);
      expect(text).toContain("2.55.0.windows.1");
      expect(text.includes(LABEL)).toBe(scope === "other");
    });

    test.todo(`the About overview with scope ${scope} ${scope === "other" ? "shows" : "does not show"} the label ${NEEDS}`, async () => {
      const { AboutOverview } = await aboutDialog();
      expect(plain(renderToStaticMarkup(<AboutOverview scope={scope} />)).includes(LABEL)).toBe(scope === "other");
    });
  }
});
