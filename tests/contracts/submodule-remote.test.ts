// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { defaultRemote, fallbackRemote, relativeUrl, resolveGitmodulesUrl, SubmoduleUrlError, type RemoteContext } from "../../src/git-service/submodule-remote";
import type { ConfigEntry } from "../../src/git-service/trust";
import { printOrigin } from "../origin";

printOrigin("../../src/git-service/submodule-remote.ts", import.meta.dir);

// T254 unit vectors for contract §12 "Update protocol" step 5. T253 holds the real-Git cases.
// Each expected value is the `submodule.s.url` that `git submodule init` wrote (Git 2.56.0.windows.1, and Git 2.55.0 in Ubuntu 26.04),
// or the `submodule--helper get-default-remote s` output of Git 2.56.0.windows.1 and of Git 2.55.0 in Ubuntu 26.04.
// The test oracle ran on 2026-10-08.

const DIES = null;

// [remote URL, `.gitmodules` URL, Git for Windows result].
const WINDOWS: [string, string, string | null][] = [
  ["https://h/a/b", "./s", "https://h/a/b/s"],
  ["https://h/a/b", "../s", "https://h/a/s"],
  ["https://h/a/b", "../../s", "https://h/s"],
  ["https://h/a/b", "./s/", "https://h/a/b/s"],
  ["https://h/a/b", "..\\s", "https://h/a/s"],
  ["https://h/a/b", ".\\s", "https://h/a/b/s"],
  ["https://h/a/b", "./../s", "https://h/a/s"],
  ["https://h/a/b/", "../s", "https://h/a/s"],
  ["git@h:a/b", "../s", "git@h:a/s"],
  ["git@h:a/b", "../../s", "git@h:s"],
  ["h:b", "./s", "h:b/s"],
  ["h:b", "../s", "h:s"],
  ["h:b", "../../s", ".:s"],
  ["/abs/x", "../../s", "/s"],
  ["//srv/share/x", "../../s", "//srv/s"],
  ["\\srv\\share\\x", "../s", "\\srv\\share/s"],
  ["file:///C:/x/y", "../s", "file:///C:/x/s"],
  ["C:/x/y", "../../s", "C:/s"],
  ["C:\\x\\y", "./s", "C:\\x\\y/s"],
  ["C:\\x\\y", "../s", "C:\\x/s"],
  ["C:\\x\\y", "../../s", "C:/s"],
  ["C:", "./s", "C:/s"],
  ["C:", "../s", "C:s"],
  ["C:x", "../../s", ".:s"],
  ["é:x", "../s", "é:s"],
  ["rel/x", "../../s", "s"],
  ["./rel/x", "../s", "rel/s"],
  ["../rel/x", "../../s", "../s"],
  [".", "./s", "./s"],
  [".", "../s", "s"],
  [".", "../../s", DIES],
  ["./", "../s", "s"],
  ["x", "../s", "s"],
  ["x", "../../s", DIES],
];

// [remote URL, `.gitmodules` URL, Linux Git result]. Only `/` separates there.
const POSIX: [string, string, string | null][] = [
  ["C:\\x\\y", "./s", "C:\\x\\y/s"],
  ["C:\\x\\y", "../s", "C:s"],
  ["C:\\x\\y", "../../s", ".:s"],
  ["C:\\x\\y", "..\\s", "C:\\x\\y/..\\s"],
  ["C:/x/y", "../../s", "C:/s"],
  ["a\\b\\c", "../s", "s"],
  ["a\\b\\c", "../../s", DIES],
  ["h:b", "..\\s", "h:b/..\\s"],
  ["/abs/x", "../../s", "/s"],
];

function entry(key: string, value: string | null, scope: ConfigEntry["scope"] = "local"): ConfigEntry {
  const bytes = new TextEncoder().encode(value === null ? key : `${key}\n${value}`);
  return { scope, origin: "file:.git/config", key, value, exact: true, originBytes: new TextEncoder().encode("file:.git/config"), keyValueBytes: bytes };
}

const context = (entries: [string, string | null][], headRef: string | null = "refs/heads/main"): RemoteContext => ({ listing: entries.map(([k, v]) => entry(k, v)), headRef });

describe("relative_url (remote.c)", () => {
  for (const [platform, rows] of [["windows", WINDOWS], ["posix", POSIX]] as const) {
    for (const [remote, url, expected] of rows) {
      test(`${platform}: ${remote} + ${url}`, () => {
        if (expected === DIES) expect(() => relativeUrl(remote, url, platform)).toThrow(SubmoduleUrlError);
        else expect(relativeUrl(remote, url, platform)).toBe(expected);
      });
    }
  }

  test("an absolute or scp-like URL stays as written", () => {
    for (const url of ["https://h/x.git", "git@h:x.git", "C:/x", "/x"]) expect(relativeUrl("https://h/a", url, "windows")).toBe(url);
  });

  test("an empty remote URL is a Git BUG, not a URL", () => {
    expect(() => relativeUrl("", "./s", "windows")).toThrow(SubmoduleUrlError);
  });
});

describe("resolve_relative_url (builtin/submodule--helper.c)", () => {
  const ROOT = "C:/Users/u/super";

  test("the branch remote is the default remote, and the last URL value wins", () => {
    const parent = context([["remote.origin.url", "https://h/o/x"], ["remote.up.url", "https://h/u/x"], ["remote.up.url", "https://h/v/x"], ["branch.main.remote", "up"]]);
    expect(resolveGitmodulesUrl("../s", parent, ROOT, "windows")).toBe("https://h/v/s");
  });

  test("a URL without a leading ./ or ../ stays as written", () => {
    const parent = context([["remote.origin.url", "https://h/o/x"]]);
    for (const url of ["s", "https://h/s.git", ".s", "...\\s"]) expect(resolveGitmodulesUrl(url, parent, ROOT, "windows")).toBe(url);
    // The gate accepts either separator on every platform.
    expect(resolveGitmodulesUrl("..\\s", parent, ROOT, "posix")).toBe("https://h/o/x/..\\s");
  });

  test("a resolution that Git cannot do throws", () => {
    expect(() => resolveGitmodulesUrl("../../s", context([["remote.origin.url", "x"]]), ROOT, "windows")).toThrow(SubmoduleUrlError);
    expect(() => resolveGitmodulesUrl("../s", context([["remote.origin.url", null]]), ROOT, "windows")).toThrow(SubmoduleUrlError);
  });
});

describe("repo_default_remote (remote.c)", () => {
  test("the current branch remote comes first", () => {
    expect(defaultRemote(context([["remote.a.url", "1"], ["remote.b.url", "2"], ["branch.main.remote", "b"]]))).toBe("b");
  });

  test("a detached HEAD or another branch uses the remote count", () => {
    const listing: [string, string][] = [["remote.a.url", "1"], ["branch.main.remote", "b"]];
    expect(defaultRemote(context(listing, null))).toBe("a");
    expect(defaultRemote(context(listing, "refs/heads/other"))).toBe("a");
  });

  test("any remote.<name> key makes a remote, and no single remote gives origin", () => {
    expect(defaultRemote(context([["remote.a.fetch", "+refs/heads/*:refs/remotes/a/*"]]))).toBe("a");
    expect(defaultRemote(context([["remote.a.url", "1"], ["remote.b.prune", "true"]]))).toBe("origin");
    expect(defaultRemote(context([["remote.pushdefault", "a"], ["remote./x.url", "1"]]))).toBe("origin");
    expect(defaultRemote(context([["remote.My.Name.url", "1"]]))).toBe("My.Name");
  });
});

// Git 2.56.0 rewrites the .gitmodules URL with the submodule `insteadOf` rules before the match. Git 2.55.0 does not.
const V255 = "2.55.0";
const V256 = "2.56.0.windows.1";

describe("get_default_remote_submodule: the probed version selects the rule", () => {
  test("an insteadOf rule of the submodule rewrites the .gitmodules URL only from 2.56.0", () => {
    const sub = context([["remote.a.url", "https://h/other.git"], ["remote.b.url", "C:/real/sub.git"], ["url.C:/real/.insteadof", "fake:"]]);
    const urls = new Map([["a", ["https://h/other.git"]], ["b", ["C:/real/sub.git"]]]);
    expect(fallbackRemote("fake:sub.git", sub, urls, V255)).toBe("origin");
    expect(fallbackRemote("fake:sub.git", sub, urls, V256)).toBe("b");
    expect(fallbackRemote("fake:sub.git", sub, urls, "2.56.0")).toBe("b");
    expect(fallbackRemote("fake:sub.git", sub, urls, "3.0.0")).toBe("b");
    expect(fallbackRemote("fake:sub.git", sub, urls, "2.55.9.windows.2")).toBe("origin");
  });

  test("the longest insteadOf prefix wins from 2.56.0, and a tie goes to the first base", () => {
    const urls = new Map([["a", ["A/x"]], ["b", ["B/x"]], ["c", ["C/rest"]]]);
    const names: [string, string][] = [["remote.a.url", "1"], ["remote.b.url", "2"], ["remote.c.url", "3"]];
    const tie = context([...names, ["url.A/.insteadof", "q"], ["url.B/.insteadof", "p:"], ["url.A/.insteadof", "p:"]]);
    const longest = context([...names, ["url.A/.insteadof", "p"], ["url.C/.insteadof", "p:"]]);
    expect(fallbackRemote("p:x", tie, urls, V256)).toBe("a");
    expect(fallbackRemote("p:rest", context([...names, ["url.A/.insteadof", "p:"], ["url.C/.insteadof", "p:"]]), urls, V256)).toBe("origin");
    expect(fallbackRemote("p:rest", longest, urls, V256)).toBe("c");
    expect(fallbackRemote("p:x", tie, urls, V255)).toBe("origin");
    expect(fallbackRemote("p:rest", longest, urls, V255)).toBe("origin");
  });

  test("a version text outside the probe form is refused", () => {
    for (const version of ["2.56", "v2.56.0", "2.56.0-rc1", ""]) expect(() => fallbackRemote("x", context([]), new Map(), version)).toThrow(TypeError);
  });

  for (const version of [V255, V256]) {
    describe(`the same result in ${version}`, () => {
      test("one remote without a match", () => {
        expect(fallbackRemote("https://h/x.git", context([["remote.upstream.url", "https://h/y.git"]]), new Map([["upstream", ["https://h/y.git"]]]), version)).toBe("upstream");
      });

      test("two remotes without a match give origin, even without such a remote", () => {
        expect(fallbackRemote("https://h/x.git", context([["remote.a.url", "1"], ["remote.b.url", "2"]]), new Map([["a", ["https://h/1.git"]], ["b", ["https://h/2.git"]]]), version)).toBe("origin");
      });

      test("without a match, the branch remote applies", () => {
        const sub = context([["remote.a.url", "1"], ["remote.b.url", "2"], ["branch.master.remote", "b"]], "refs/heads/master");
        expect(fallbackRemote("https://h/x.git", sub, new Map([["a", ["https://h/1.git"]], ["b", ["https://h/2.git"]]]), version)).toBe("b");
      });

      test("the first remote in listing order with the URL wins", () => {
        const sub = context([["remote.a.url", "1"], ["remote.c.url", "3"], ["remote.b.url", "2"]]);
        const urls = new Map([["a", ["https://h/1.git"]], ["b", ["https://h/x.git"]], ["c", ["https://h/0.git", "https://h/x.git"]]]);
        expect(fallbackRemote("https://h/x.git", sub, urls, version)).toBe("c");
      });

      test("the match compares the rewritten remote URLs with the raw resolved parent URL", () => {
        // Probe S32 and the 2026-10-08 oracle: a parent `insteadOf` rule does not reach the submodule.
        const parent = context([["remote.origin.url", "fake:super.git"], ["url.C:/real/.insteadof", "fake:"]]);
        const resolved = resolveGitmodulesUrl("../sub.git", parent, "C:/super", "windows");
        const sub = context([["remote.a.url", "https://h/1.git"], ["remote.b.url", "fake:sub.git"], ["remote.origin.url", "https://h/o.git"]]);
        expect(fallbackRemote(resolved, sub, new Map([["a", ["https://h/1.git"]], ["b", ["fake:sub.git"]], ["origin", ["https://h/o.git"]]]), version)).toBe("b");
      });
    });
  }
});
