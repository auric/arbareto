// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import type { Environment } from "../../src/contracts/envelope";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";

printOrigin("../../src/frontend/app/RepositoryMenu.tsx", import.meta.dir);
printOrigin("../../src/frontend/about/AboutDialog.tsx", import.meta.dir);
// `RepositoryMenu.tsx` loads Base UI. Base UI must first evaluate with a DOM, because test files share one module cache (tests/dom.ts).
registerDom();
const { renderToStaticMarkup } = await import("react-dom/server");
const { GitVersionRow } = await import("../../src/frontend/app/RepositoryMenu");
const { AboutOverview } = await import("../../src/frontend/about/AboutDialog");

// plan.md "Provisional prerequisite admission" and "About window": the label shows only with platform scope `other`.
const LABEL = "Unqualified platform";
const SCOPES: Environment["platformScope"][] = ["other", "qualification-target"];
const GIT = String.raw`C:\Program Files\Git\cmd\git.exe`;
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const BUILD: Environment["buildIdentity"] = { version: "0.1.0", commit: "c950776a2b4e0c2f6f7e6b1d9a1f3c5e7d9b0a12", signing: "unsigned" };

describe("Unqualified platform label", () => {
  for (const scope of SCOPES) {
    test(`the repository menu Git version row with scope ${scope} ${scope === "other" ? "shows" : "does not show"} the label`, () => {
      const text = plain(renderToStaticMarkup(<GitVersionRow path={GIT} version="2.55.0.windows.1" scope={scope} />));
      expect(text).toContain(GIT);
      expect(text).toContain("2.55.0.windows.1");
      expect(text.includes(LABEL)).toBe(scope === "other");
    });

    test(`the About overview with scope ${scope} ${scope === "other" ? "shows" : "does not show"} the label`, () => {
      expect(plain(renderToStaticMarkup(<AboutOverview scope={scope} build={BUILD} repositoryUrl="https://github.com/auric/arbareto" />)).includes(LABEL)).toBe(scope === "other");
    });
  }
});
