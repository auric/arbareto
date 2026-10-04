// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { NATIVE, PATH_RULES } from "../../src/contracts/native-path";

printOrigin("../../src/contracts/native-path.ts", import.meta.dir);

describe("the Windows rule set", () => {
  const rules = PATH_RULES.windows;

  test.each(["C:\\x", "c:/x", "\\\\server\\share", "//server/share"])("isAbsolute accepts %p", (path) => {
    expect(rules.isAbsolute(path)).toBe(true);
  });

  // Rust `Path::is_absolute` also refuses `\\server`, `\\server\`, and `\\.`.
  test.each(["x", "C:x", "\\x", "/x", "\\\\server", "\\\\server\\", "\\\\.", "\\\\.\\pipe\\x", "\\\\?\\C:\\x", "//./pipe/x", "//?/C:/x"])(
    "isAbsolute refuses %p",
    (path) => {
      expect(rules.isAbsolute(path)).toBe(false);
    },
  );

  test("isGitExecutable accepts git.exe in any letter case and refuses git.cmd", () => {
    expect(rules.isGitExecutable("C:\\Git\\cmd\\GIT.EXE")).toBe(true);
    expect(rules.isGitExecutable("C:\\Git\\cmd\\git.cmd")).toBe(false);
  });

  test("fold changes only the ASCII letters A to Z", () => {
    expect(rules.fold("C:\\Git\\\u212A")).toBe("c:\\git\\\u212A");
  });
});

describe("the POSIX rule set", () => {
  const rules = PATH_RULES.posix;

  test.each(["/", "/x"])("isAbsolute accepts %p", (path) => {
    expect(rules.isAbsolute(path)).toBe(true);
  });

  test.each(["x", "C:\\x", "\\\\server\\share"])("isAbsolute refuses %p", (path) => {
    expect(rules.isAbsolute(path)).toBe(false);
  });

  test("isGitExecutable accepts git and refuses git.exe", () => {
    expect(rules.isGitExecutable("/usr/bin/git")).toBe(true);
    expect(rules.isGitExecutable("/usr/bin/git.exe")).toBe(false);
  });

  test("fold changes nothing", () => {
    expect(rules.fold("/Git/\u212A")).toBe("/Git/\u212A");
  });
});

test("NATIVE is the Windows rule set exactly when the host is win32", () => {
  expect(NATIVE === PATH_RULES.windows).toBe(process.platform === "win32");
  expect(NATIVE === PATH_RULES.posix).toBe(process.platform !== "win32");
});

test("no exported schema holds the Windows drive-letter pattern", () => {
  const root = join(import.meta.dir, "..", "..", "src", "contracts", "schemas");
  const hits = readdirSync(root).filter((name) => readFileSync(join(root, name), "utf8").includes("A-Za-z]:"));
  expect(hits).toEqual([]);
});
