// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { suggestCloneName } from "../../src/contracts/clone-name";

printOrigin("../../src/contracts/clone-name.ts", import.meta.dir);

// FR-054 and plan.md D10 (T017).

const W = "\\";
const suggest = (url: string, lastCloneParent: string | null = "D:\\src", defaultCloneFolder: string | null = null, separator: "\\" | "/" = W) =>
  suggestCloneName({ url, lastCloneParent, defaultCloneFolder, separator });

describe("suggestCloneName", () => {
  test("the last clone parent and the last URL segment", () => {
    expect(suggest("https://example.test/team/tool.git")).toBe("D:\\src\\tool");
  });

  test("the parent is the last clone parent, else the default clone folder, else empty", () => {
    expect(suggest("https://example.test/tool", "D:\\last", "E:\\default")).toBe("D:\\last\\tool");
    expect(suggest("https://example.test/tool", null, "E:\\default")).toBe("E:\\default\\tool");
    expect(suggest("https://example.test/tool", null, null)).toBe("tool");
  });

  test("a parent that ends with the separator gets no second one", () => {
    expect(suggest("https://example.test/tool", "D:\\")).toBe("D:\\tool");
    expect(suggest("https://example.test/tool", "/home/u/", null, "/")).toBe("/home/u/tool");
    expect(suggest("https://example.test/tool", "/home/u", null, "/")).toBe("/home/u/tool");
  });

  test("the name splits at /, \\, and :", () => {
    expect(suggest("git@host:team/tool.git")).toBe("D:\\src\\tool");
    expect(suggest("git@host:tool.git")).toBe("D:\\src\\tool");
    expect(suggest("D:\\repos\\tool")).toBe("D:\\src\\tool");
    expect(suggest("\\\\server\\share\\tool.git")).toBe("D:\\src\\tool");
    expect(suggest("file:///D:/repos/tool.git")).toBe("D:\\src\\tool");
    expect(suggest("ssh://git@host:22/~/tool.git")).toBe("D:\\src\\tool");
  });

  test("trailing separators and one .git leave", () => {
    expect(suggest("https://example.test/team/tool.git/")).toBe("D:\\src\\tool");
    expect(suggest("https://example.test/team/tool//")).toBe("D:\\src\\tool");
    expect(suggest("https://example.test/team/tool.git.git")).toBe("D:\\src\\tool.git");
    expect(suggest("https://example.test/team/tool.GIT")).toBe("D:\\src\\tool.GIT");
  });

  test("no path segment gives an empty name", () => {
    for (const url of ["https://example.test", "https://example.test/", "git@host:", "///", "\\\\", ":", ""]) expect(suggest(url)).toBe("D:\\src\\");
    expect(suggest("https://example.test", null, null)).toBe("");
  });

  test("the name keeps every character", () => {
    expect(suggest("https://example.test/a%20b?x=1#y")).toBe("D:\\src\\a%20b?x=1#y");
    expect(suggest("https://example.test/con.git")).toBe("D:\\src\\con");
    expect(suggest("https://example.test/nam e. ")).toBe("D:\\src\\nam e. ");
    expect(suggest("https://example.test/werkzeug-ä")).toBe("D:\\src\\werkzeug-ä");
  });
});
