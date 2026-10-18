// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { PATH_RULES } from "../../src/contracts/native-path";
import type { ConfigEntry } from "../../src/git-service/trust";
import { configView, localNameOf, parseBranches, parseTrackedStatus, parseWorktrees, sameHost, trackingRemotes, urlHost } from "../../src/git-service/workbench-parsers";

printOrigin("../../src/git-service/workbench-parsers.ts", import.meta.dir);

// Contract Δ3, data-model §1, §8, §9, research.md R2, and plan.md D11, D13 (T008).

const bytes = (text: string): Uint8Array => Buffer.from(text, "latin1");
const utf8 = (text: string): string => Buffer.from(text, "utf8").toString("latin1");
const A = "a".repeat(40);
const B = "b".repeat(40);
const A2 = "a".repeat(64);
const Z = "0".repeat(40);

describe("readBranches records (contract Δ3)", () => {
  const rec = (refname: string, oid: string, upstream: string, head: string, symref: string, type = "commit", peeled = "", peeledType = "") =>
    `${refname}\0${oid}\0${upstream}\0${head}\0${symref}\0${type}\0${peeled}\0${peeledType}\n`;
  const parse = (...records: string[]) => parseBranches(bytes(records.join("")), "sha1");

  test("local and remote entries in Git's order", () => {
    expect(
      parse(
        rec("refs/heads/feature/x", A, "refs/remotes/origin/feature/x", " ", ""),
        rec("refs/heads/main", B, "refs/remotes/origin/main", "*", ""),
        rec("refs/heads/no-up", A, "", " ", ""),
        rec("refs/remotes/origin/HEAD", B, "", " ", "refs/remotes/origin/main"),
        rec("refs/remotes/origin/main", B, "", " ", ""),
      ),
    ).toEqual([
      { ref: "refs/heads/feature/x", kind: "local", name: "feature/x", invalidUtf8: false, oid: A, object: A, upstream: "refs/remotes/origin/feature/x", current: false },
      { ref: "refs/heads/main", kind: "local", name: "main", invalidUtf8: false, oid: B, object: B, upstream: "refs/remotes/origin/main", current: true },
      { ref: "refs/heads/no-up", kind: "local", name: "no-up", invalidUtf8: false, oid: A, object: A, upstream: null, current: false },
      { ref: "refs/remotes/origin/main", kind: "remote", name: "origin/main", invalidUtf8: false, oid: B, object: B, upstream: null, current: false },
    ]);
  });

  test("a record with a non-empty symref is skipped", () => {
    expect(parse(rec("refs/remotes/origin/HEAD", B, "", " ", "refs/remotes/origin/main"))).toEqual([]);
    expect(parse(rec("refs/heads/alias", B, "", " ", "refs/heads/main"))).toEqual([]);
  });

  test("empty output gives no entry", () => expect(parse()).toEqual([]));

  // Data-model §1 `oid`: the commit of the ref. git-for-each-ref(1): a `*` field holds the value of the peeled object.
  test("a ref to an annotated tag gives its peeled commit, and a ref whose object peels to no commit is skipped", () => {
    expect(parse(rec("refs/remotes/origin/v1", B, "", " ", "", "tag", A, "commit"))).toMatchObject([{ ref: "refs/remotes/origin/v1", oid: A, object: B }]);
    expect(parse(rec("refs/remotes/origin/tree", A, "", " ", "", "tree"), rec("refs/remotes/origin/tree-tag", B, "", " ", "", "tag", A, "tree"))).toEqual([]);
  });

  test("UTF-8 and invalid UTF-8 names", () => {
    expect(parse(rec(utf8("refs/heads/zweig-ä"), A, "", " ", ""))).toMatchObject([{ ref: "refs/heads/zweig-ä", name: "zweig-ä", invalidUtf8: false }]);
    expect(parse(rec("refs/heads/b\xff", A, "", " ", ""))).toMatchObject([{ name: "b\ufffd", invalidUtf8: true }]);
  });

  test("SHA-256 object IDs", () => {
    expect(parseBranches(bytes(rec("refs/heads/m", A2, "", "*", "")), "sha256")).toMatchObject([{ oid: A2 }]);
    expect(parseBranches(bytes(rec("refs/heads/m", A, "", "*", "")), "sha256")).toBeNull();
  });

  const refused: [string, string][] = [
    ["seven fields", `refs/heads/a\0${A}\0\0 \0\0commit\0\n`],
    ["nine fields", `refs/heads/a\0${A}\0\0 \0\0commit\0\0\0\n`],
    ["no final LF", rec("refs/heads/a", A, "", " ", "").slice(0, -1)],
    ["an empty record", "\n"],
    ["a CR before the LF", `refs/heads/a\0${A}\0\0 \0\0commit\0\0\r\n`],
    ["an unknown object type", rec("refs/heads/a", A, "", " ", "", "note")],
    ["a tag without its peeled object", rec("refs/remotes/o/v1", A, "", " ", "", "tag")],
    ["a peeled type tag", rec("refs/remotes/o/v1", A, "", " ", "", "tag", B, "tag")],
    ["a commit with a peeled object", rec("refs/heads/a", A, "", " ", "", "commit", B, "commit")],
    ["a tag refname", rec("refs/tags/v1", A, "", " ", "")],
    ["a refname without a name", rec("refs/heads/", A, "", " ", "")],
    ["a bad OID", rec("refs/heads/a", "x".repeat(40), "", " ", "")],
    ["an upstream outside refs/", rec("refs/heads/a", A, "origin/a", " ", "")],
    ["a symref outside refs/", rec("refs/remotes/o/HEAD", A, "", " ", "o/main")],
    ["another HEAD mark", rec("refs/heads/a", A, "", "+", "")],
    ["an empty HEAD mark", rec("refs/heads/a", A, "", "", "")],
    ["a HEAD mark on a remote record", rec("refs/remotes/o/a", A, "", "*", "")],
    ["two HEAD marks", rec("refs/heads/a", A, "", "*", "") + rec("refs/heads/b", A, "", "*", "")],
  ];
  for (const [name, output] of refused) test(`${name} gives MALFORMED_GIT_OUTPUT`, () => expect(parse(output)).toBeNull());
});

describe("worktree records (data-model §8)", () => {
  // `worktree list --porcelain -z` of Git 2.56.0.windows.2, with the fixture root shortened to `D:/w`.
  const RECORDED =
    "worktree D:/w/repo\0HEAD 8e2f38fb0a85f3224292830b67d5e6e2dae15cd7\0branch refs/heads/main\0\0" +
    "worktree D:/w/wt space\0HEAD 8e2f38fb0a85f3224292830b67d5e6e2dae15cd7\0detached\0\0" +
    "worktree D:/w/wt-bare-lock\0HEAD 8e2f38fb0a85f3224292830b67d5e6e2dae15cd7\0branch refs/heads/nolock2\0locked\0\0" +
    "worktree D:/w/wt-gone\0HEAD 8e2f38fb0a85f3224292830b67d5e6e2dae15cd7\0branch refs/heads/gone\0prunable gitdir file points to non-existent location\0\0" +
    "worktree D:/w/wt-locked\0HEAD 8e2f38fb0a85f3224292830b67d5e6e2dae15cd7\0branch refs/heads/locked\0locked on a USB stick\0\0";
  const H = "8e2f38fb0a85f3224292830b67d5e6e2dae15cd7";
  const base = { invalidUtf8: false, head: H, bare: false, detached: false, locked: null, prunable: null, main: false };
  const parse = (text: string, format: "sha1" | "sha256" = "sha1") => parseWorktrees(bytes(text), format);

  test("a recorded listing", () => {
    expect(parse(RECORDED)).toEqual([
      { ...base, path: "D:/w/repo", branch: "refs/heads/main", main: true },
      { ...base, path: "D:/w/wt space", branch: null, detached: true },
      { ...base, path: "D:/w/wt-bare-lock", branch: "refs/heads/nolock2", locked: { reason: null } },
      { ...base, path: "D:/w/wt-gone", branch: "refs/heads/gone", prunable: { reason: "gitdir file points to non-existent location" } },
      { ...base, path: "D:/w/wt-locked", branch: "refs/heads/locked", locked: { reason: "on a USB stick" } },
    ]);
  });

  test("a bare main worktree", () => {
    expect(parse("worktree D:/w/bare.git\0bare\0\0")).toEqual([{ ...base, path: "D:/w/bare.git", head: null, branch: null, bare: true, main: true }]);
  });

  test("a prunable record without a reason and a locked reason with spaces and a quote", () => {
    expect(parse(`worktree /w/a\0HEAD ${A}\0detached\0locked "x" \\ y\0prunable\0\0`)).toEqual([
      { ...base, path: "/w/a", head: A, branch: null, detached: true, locked: { reason: '"x" \\ y' }, prunable: { reason: null }, main: true },
    ]);
  });

  test("an unborn branch and a record without branch or detached", () => {
    expect(parse(`worktree /w/a\0HEAD ${Z}\0branch refs/heads/main\0\0worktree /w/b\0HEAD ${A}\0\0`)).toEqual([
      { ...base, path: "/w/a", head: Z, branch: "refs/heads/main", main: true },
      { ...base, path: "/w/b", head: A, branch: null },
    ]);
  });

  test("UTF-8, invalid UTF-8, and SHA-256", () => {
    expect(parse(utf8(`worktree /w/ä\0HEAD ${A}\0detached\0\0`))).toMatchObject([{ path: "/w/ä", invalidUtf8: false }]);
    expect(parse(`worktree /w/\xff\0HEAD ${A}\0detached\0\0`)).toMatchObject([{ path: "/w/\ufffd", invalidUtf8: true }]);
    expect(parse(`worktree /w/a\0HEAD ${A2}\0detached\0\0`, "sha256")).toMatchObject([{ head: A2 }]);
  });

  test("empty output gives no record", () => expect(parse("")).toEqual([]));

  const refused: [string, string][] = [
    ["a record that does not start with worktree", `HEAD ${A}\0worktree /w/a\0\0`],
    ["an empty worktree path", `worktree \0HEAD ${A}\0\0`],
    ["no empty line at the end", `worktree /w/a\0HEAD ${A}\0`],
    ["no NUL at the end", `worktree /w/a\0HEAD ${A}`],
    ["an empty record", "\0"],
    ["two empty lines", `worktree /w/a\0HEAD ${A}\0\0\0`],
    ["a short OID", `worktree /w/a\0HEAD ${"a".repeat(39)}\0\0`],
    ["a SHA-1 OID in a SHA-256 repository", `worktree /w/a\0HEAD ${A}\0\0`],
    ["branch and detached", `worktree /w/a\0HEAD ${A}\0branch refs/heads/main\0detached\0\0`],
    ["two branch lines", `worktree /w/a\0HEAD ${A}\0branch refs/heads/a\0branch refs/heads/b\0\0`],
    ["a branch outside refs/", `worktree /w/a\0HEAD ${A}\0branch main\0\0`],
    ["a branch without HEAD", `worktree /w/a\0branch refs/heads/main\0\0`],
    ["bare with HEAD", `worktree /w/a\0bare\0HEAD ${A}\0\0`],
    ["no HEAD and not bare", `worktree /w/a\0locked\0\0`],
    ["two locked lines", `worktree /w/a\0HEAD ${A}\0locked\0locked x\0\0`],
    ["an empty locked reason", `worktree /w/a\0HEAD ${A}\0locked \0\0`],
    ["an empty prunable reason", `worktree /w/a\0HEAD ${A}\0prunable \0\0`],
    ["an unknown attribute", `worktree /w/a\0HEAD ${A}\0stale\0\0`],
    ["a second worktree line", `worktree /w/a\0worktree /w/b\0HEAD ${A}\0\0`],
  ];
  for (const [name, output] of refused) {
    test(`${name} gives MALFORMED_GIT_OUTPUT`, () => expect(parse(output, name.includes("SHA-256") ? "sha256" : "sha1")).toBeNull());
  }
});

describe("tracked status records (plan.md D3 and D6)", () => {
  const parse = (text: string, format: "sha1" | "sha256" = "sha1") => parseTrackedStatus(bytes(text), format);
  const ordinary = `1 .M N... 100644 100644 100644 ${A} ${A} f.txt`;
  const renamed = `2 R. N... 100644 100644 100644 ${A} ${A} R100 new name.txt`;
  const unmerged = `u UU N... 100644 100644 100644 100644 ${A} ${B} ${A} u.txt`;

  test("records, a rename with its original path, and an unmerged record", () => {
    expect(parse(`${ordinary}\0${renamed}\0old name.txt\0${unmerged}\0`)).toEqual({ records: 3, unmerged: 1 });
  });
  test("empty output gives no record", () => expect(parse("")).toEqual({ records: 0, unmerged: 0 }));
  // git-status(1): `status.showStash` adds `# stash <n>`, and `--branch` adds `# branch.*`. Parsers ignore headers they do not know.
  test("headers before the entries count as no record", () => {
    expect(parse(`# stash 1\0`)).toEqual({ records: 0, unmerged: 0 });
    expect(parse(`# branch.oid ${A}\0# branch.head main\0# stash 2\0${ordinary}\0`)).toEqual({ records: 1, unmerged: 0 });
  });
  test("SHA-256 object IDs", () => expect(parse(`1 .M N... 100644 100644 100644 ${A2} ${A2} f.txt\0`, "sha256")).toEqual({ records: 1, unmerged: 0 }));

  const refused: [string, string][] = [
    ["no NUL at the end", ordinary],
    ["a rename without its original path", `${renamed}\0`],
    ["an untracked record", "? new.txt\0"],
    ["a header after an entry", `${ordinary}\0# stash 1\0`],
    ["a header without a key", "# \0"],
    ["a SHA-1 OID in a SHA-256 repository", `${ordinary}\0`],
  ];
  for (const [name, output] of refused) {
    test(`${name} gives MALFORMED_GIT_OUTPUT`, () => expect(parse(output, name.includes("SHA-256") ? "sha256" : "sha1")).toBeNull());
  }
});

describe("configuration value view (data-model §9, plan.md D11)", () => {
  const entry = (scope: ConfigEntry["scope"], key: string, value: string | null): ConfigEntry => ({
    scope,
    origin: `file:${scope}.cfg`,
    key,
    value,
    exact: true,
    originBytes: new Uint8Array(),
    keyValueBytes: new Uint8Array(),
  });

  test("effective is the last entry in listing order", () => {
    const view = configView([entry("system", "user.name", "S"), entry("global", "user.name", "G"), entry("local", "user.name", "L"), entry("local", "user.email", "e")], "user.name");
    expect(view.type).toEqual({ kind: "text" });
    expect(view.entries.map((e) => [e.scope, e.value])).toEqual([["system", "S"], ["global", "G"], ["local", "L"]]);
    expect(view.effective).toEqual({ scope: "local", origin: "file:local.cfg", value: "L", reading: "L" });
    expect(view.readOnly).toEqual({ local: false, global: false });
  });

  test("a key without an entry", () => {
    const view = configView([entry("global", "user.email", "e")], "user.name");
    expect(view.entries).toEqual([]);
    expect(view.effective).toBeNull();
    expect(view.readOnly).toEqual({ local: false, global: false });
  });

  test("several entries in one scope make that scope read-only (FR-063)", () => {
    const view = configView([entry("global", "credential.helper", "a"), entry("global", "credential.helper", "b"), entry("local", "credential.helper", "c")], "credential.helper");
    expect(view.readOnly).toEqual({ local: false, global: true });
    expect(view.effective?.value).toBe("c");
  });

  test("a boolean reads by parseMaybeBool", () => {
    const reading = (value: string | null) => configView([entry("local", "fetch.prune", value)], "fetch.prune").effective?.reading;
    expect(configView([], "fetch.prune").type).toEqual({ kind: "bool" });
    for (const value of ["true", "YES", "on", "1", "0x10", null]) expect(reading(value)).toBe("true");
    for (const value of ["false", "No", "off", "0", ""]) expect(reading(value)).toBe("false");
    expect(reading("maybe")).toBeNull();
  });

  test("a boolean that Git cannot read makes its scope read-only", () => {
    expect(configView([entry("global", "rebase.autosquash", "maybe")], "rebase.autosquash").readOnly).toEqual({ local: false, global: true });
    expect(configView([entry("global", "rebase.autosquash", "yes")], "rebase.autosquash").readOnly).toEqual({ local: false, global: false });
  });

  test("the boolean keys of FR-060 in Git's canonical form", () => {
    for (const key of ["fetch.prune", "merge.autostash", "rebase.autostash", "rebase.autosquash", "rebase.updaterefs", "rerere.enabled", "rerere.autoupdate", "push.autosetupremote"]) {
      expect(configView([], key).type).toEqual({ kind: "bool" });
    }
  });

  test("the enumerations of plan.md D11", () => {
    const values = (key: string) => configView([], key).type;
    expect(values("core.autocrlf")).toEqual({ kind: "enum", values: ["true", "false", "input"] });
    expect(values("pull.rebase")).toEqual({ kind: "enum", values: ["true", "false", "merges", "interactive"] });
    expect(values("pull.ff")).toEqual({ kind: "enum", values: ["true", "false", "only"] });
    expect(values("push.default")).toEqual({ kind: "enum", values: ["nothing", "current", "upstream", "simple", "matching", "tracking"] });
  });

  test("enumeration readings follow Git's parsers", () => {
    const reading = (key: string, value: string | null) => configView([entry("local", key, value)], key).effective?.reading;
    expect([reading("core.autocrlf", "Input"), reading("core.autocrlf", "yes"), reading("core.autocrlf", "0"), reading("core.autocrlf", null), reading("core.autocrlf", "x")]).toEqual(["input", "true", "false", "true", null]);
    expect([reading("pull.rebase", "merges"), reading("pull.rebase", "m"), reading("pull.rebase", "i"), reading("pull.rebase", "on"), reading("pull.rebase", "Merges")]).toEqual(["merges", "merges", "interactive", "true", null]);
    expect([reading("pull.ff", "only"), reading("pull.ff", "false"), reading("pull.ff", "Only")]).toEqual(["only", "false", null]);
    expect([reading("push.default", "tracking"), reading("push.default", "simple"), reading("push.default", "Simple"), reading("push.default", null), reading("push.default", "true")]).toEqual(["tracking", "simple", null, null, null]);
  });

  test("an enumeration value that Git cannot read leaves the scope editable", () => {
    expect(configView([entry("local", "push.default", "bogus")], "push.default").readOnly).toEqual({ local: false, global: false });
  });

  test("a tool key is text and keeps its subsection case", () => {
    const view = configView([entry("global", "mergetool.MyTool.cmd", "tool \"$MERGED\"")], "mergetool.MyTool.cmd");
    expect(view.type).toEqual({ kind: "text" });
    expect(view.effective?.reading).toBe('tool "$MERGED"');
  });
});

describe("refspec map (research.md R2)", () => {
  const fetch = (remote: string, value: string | null): { key: string; value: string | null } => ({ key: `remote.${remote}.fetch`, value });
  const DEFAULT = fetch("origin", "+refs/heads/*:refs/remotes/origin/*");

  test("one mapping refspec gives the name", () => {
    expect(localNameOf("refs/remotes/origin/feature/x", [DEFAULT], "sha1")).toBe("feature/x");
    expect(localNameOf("refs/remotes/origin/main", [fetch("origin", "refs/heads/main:refs/remotes/origin/main")], "sha1")).toBe("main");
    expect(localNameOf("refs/remotes/my.remote/x", [fetch("my.remote", "+refs/heads/*:refs/remotes/my.remote/*")], "sha1")).toBe("x");
    expect(localNameOf("refs/remotes/origin/x", [{ key: "remote.origin.url", value: "u" }, DEFAULT, fetch("other", "+refs/heads/*:refs/remotes/other/*")], "sha1")).toBe("x");
  });

  test("a pattern with a prefix and a suffix", () => {
    expect(localNameOf("refs/remotes/origin/pre-x-post", [fetch("origin", "refs/heads/a/*/b:refs/remotes/origin/pre-*-post")], "sha1")).toBe("a/x/b");
  });

  test("zero mapping refspecs give null", () => {
    expect(localNameOf("refs/remotes/origin/x", [], "sha1")).toBeNull();
    expect(localNameOf("refs/remotes/upstream/x", [DEFAULT], "sha1")).toBeNull();
    expect(localNameOf("refs/remotes/origin/x", [fetch("origin", "refs/heads/main")], "sha1")).toBeNull();
    expect(localNameOf("refs/remotes/origin/x", [fetch("origin", "refs/heads/y:refs/remotes/origin/y")], "sha1")).toBeNull();
  });

  test("several mapping refspecs give null", () => {
    expect(localNameOf("refs/remotes/origin/x", [DEFAULT, fetch("second", "+refs/heads/*:refs/remotes/origin/*")], "sha1")).toBeNull();
    expect(localNameOf("refs/remotes/origin/pr/1", [DEFAULT, fetch("origin", "+refs/pull/*:refs/remotes/origin/pr/*")], "sha1")).toBeNull();
    expect(localNameOf("refs/remotes/origin/x", [DEFAULT, DEFAULT], "sha1")).toBeNull();
  });

  test("a mapping to a source outside refs/heads/ gives null", () => {
    expect(localNameOf("refs/remotes/origin/tags/v1", [fetch("origin", "+refs/tags/*:refs/remotes/origin/tags/*")], "sha1")).toBeNull();
    expect(localNameOf("refs/remotes/origin/main", [fetch("origin", "main:refs/remotes/origin/main")], "sha1")).toBeNull();
  });

  // remote.c `query_matches_negative_refspec`: a source that a negative refspec names maps nothing in that remote.
  test("a negative refspec removes the mapping of its remote", () => {
    expect(localNameOf("refs/remotes/origin/secret", [DEFAULT, fetch("origin", "^refs/heads/secret")], "sha1")).toBeNull();
    expect(localNameOf("refs/remotes/origin/wip/a", [DEFAULT, fetch("origin", "^refs/heads/wip/*")], "sha1")).toBeNull();
    expect(localNameOf("refs/remotes/origin/x", [DEFAULT, fetch("origin", "^refs/heads/secret")], "sha1")).toBe("x");
  });

  test("a refspec that Git refuses gives null", () => {
    expect(localNameOf("refs/remotes/origin/x", [DEFAULT, fetch("origin", null)], "sha1")).toBeNull();
    expect(localNameOf("refs/remotes/origin/x", [fetch("origin", "refs/heads/*:refs/remotes/origin/x")], "sha1")).toBeNull();
    expect(localNameOf("refs/remotes/origin/x", [fetch("origin", "refs/heads/*/*:refs/remotes/origin/*/*")], "sha1")).toBeNull();
    expect(localNameOf("refs/remotes/origin/x", [DEFAULT, fetch("origin", "^refs/heads/a:refs/remotes/origin/a")], "sha1")).toBeNull();
  });
});

// branch.c `dwim_branch_start` and `setup_tracking` with remote.c `query_refspecs`, refspec.c `parse_refspec`, and refs.c `check_refname_format` (Git 2.56).
describe("tracking remotes (plan.md D3 Track rule)", () => {
  const fetch = (remote: string, value: string | null) => ({ key: `remote.${remote}.fetch`, value });
  const DEFAULT = fetch("origin", "+refs/heads/*:refs/remotes/origin/*");
  const track = (ref: string, ...config: { key: string; value: string | null }[]) => trackingRemotes(ref, config, "sha1");

  test("one remote maps the ref, also with two of its refspecs", () => {
    expect(track("refs/remotes/origin/x", DEFAULT)).toEqual(["origin"]);
    expect(track("refs/remotes/origin/x/y", DEFAULT, fetch("origin", "+refs/heads/x/*:refs/remotes/origin/x/*"))).toEqual(["origin"]);
    expect(track("refs/remotes/origin/main", fetch("origin", "refs/heads/main:refs/remotes/origin/main"))).toEqual(["origin"]);
  });

  test("no refspec maps the ref, or a negative refspec removes the mapping", () => {
    expect(track("refs/remotes/zero/topic", fetch("zero", "+refs/heads/main:refs/remotes/zero/main"))).toEqual([]);
    expect(track("refs/remotes/origin/x", fetch("origin", "refs/heads/x"))).toEqual([]);
    expect(track("refs/remotes/origin/x", fetch("origin", "refs/heads/x:"))).toEqual([]);
    expect(track("refs/remotes/origin/x", DEFAULT, fetch("origin", "^refs/heads/x"))).toEqual([]);
  });

  test("two remotes that map the ref are both named", () => {
    expect(track("refs/remotes/o/topic", fetch("o", "+refs/heads/*:refs/remotes/o/*"), fetch("p", "+refs/heads/topic:refs/remotes/o/topic"))).toEqual(["o", "p"]);
  });

  test("a refspec that parse_refspec refuses gives null", () => {
    for (const bad of ["+refs/heads/a..b:refs/remotes/p/x", "refs/heads/*:refs/remotes/p/x", "refs/heads/x:refs/remotes/*", "refs/heads/*", "refs/heads/a*b*:refs/remotes/p/*", "refs/heads/x:refs/remotes/p/x.lock", "refs/heads/x:refs/remotes/p/a b", "^refs/heads/x:refs/remotes/p/x", "^", `^${"a".repeat(40)}`, "refs/heads/x:refs/remotes/p/@{x}", null]) {
      expect({ bad, remotes: track("refs/remotes/origin/x", DEFAULT, fetch("p", bad)) }).toEqual({ bad, remotes: null });
    }
  });

  test("forms that parse_refspec accepts", () => {
    for (const good of ["@:refs/remotes/p/head", ":refs/remotes/p/head", `${"a".repeat(40)}:refs/remotes/p/oid`, "refs/heads/*:refs/remotes/p/*", "^refs/heads/wip/*", `^${"a".repeat(40)}`]) {
      expect({ good, ok: trackingRemotes("refs/remotes/origin/x", [DEFAULT, fetch("p", good)], good === `^${"a".repeat(40)}` ? "sha256" : "sha1") !== null }).toEqual({ good, ok: true });
    }
  });
});

describe("URL host (plan.md D13, git-fetch(1) GIT URLS)", () => {
  const W = PATH_RULES.windows;
  const P = PATH_RULES.posix;

  test("the authority host of a scheme:// URL", () => {
    expect(urlHost("https://Example.TEST/team/tool.git", W)).toEqual({ host: "example.test" });
    expect(urlHost("ssh://git@host.xz:2222/~/repo.git", W)).toEqual({ host: "host.xz" });
    expect(urlHost("git://host.xz/repo", W)).toEqual({ host: "host.xz" });
    expect(urlHost("https://user:pw@host.xz", W)).toEqual({ host: "host.xz" });
    expect(urlHost("ssh://[::1]:22/repo", W)).toEqual({ host: "[::1]" });
  });

  test("the scp form without a slash before the first colon", () => {
    expect(urlHost("git@GitHub.com:team/tool.git", W)).toEqual({ host: "github.com" });
    expect(urlHost("host.xz:repo", W)).toEqual({ host: "host.xz" });
  });

  test("this computer for a local path and file://", () => {
    for (const url of ["file:///D:/repos/tool.git", "D:\\repos\\tool", "D:/repos/tool", "../sibling", "./a:b", "/srv/repo.git", "\\\\server\\share\\repo"]) expect(urlHost(url, W)).toEqual({ local: true });
    expect(urlHost("/srv/repo.git", P)).toEqual({ local: true });
  });

  // git-compat-util.h `has_dos_drive_prefix` is 0 outside Windows, so Linux Git reads `C:repo` as the scp form.
  test("a drive letter follows the Git platform", () => {
    expect(urlHost("C:repo", W)).toEqual({ local: true });
    expect(urlHost("C:repo", P)).toEqual({ host: "c" });
  });

  test("a remote helper URL has no host", () => {
    expect(urlHost("ext::ssh -i key host.xz %S repo", W)).toBeNull();
    expect(urlHost("hg::https://host.xz/repo", W)).toBeNull();
  });

  // transport.c `transport_get`: another `<scheme>://` runs `git remote-<scheme>`, and `rsync:` stops Git. url.c `is_urlschemechar` allows a leading digit.
  test("a scheme that Git does not handle itself has no host", () => {
    for (const url of ["foo://host.xz/repo", "rsync://host.xz/repo", "HTTPS://host.xz/repo", "1x://host.xz/repo", "1x::host.xz", "D://repos/tool"]) expect(urlHost(url, W)).toBeNull();
    for (const url of ["http://host.xz/r", "ftp://host.xz/r", "ftps://host.xz/r", "git+ssh://host.xz/r", "ssh+git://host.xz/r"]) expect(urlHost(url, W)).toEqual({ host: "host.xz" });
  });

  // connect.c `parse_connect_url` and `host_end`: an scp host that starts with `[`, also after `user@`, ends at `]`, and the path starts at the next `:`.
  test("an scp host in brackets ends at ] and needs : next", () => {
    expect(urlHost("[::1]:a", W)).toEqual({ host: "[::1]" });
    expect(urlHost("git@[::1]:a", W)).toEqual({ host: "[::1]" });
    expect(sameHost(urlHost("[::1]:a", W), urlHost("[::2]:b", W))).toBe(false);
    expect(sameHost(urlHost("[::1]:a", W), urlHost("ssh://[::1]/b", W))).toBe(true);
    for (const url of ["[::1", "[::1]x:a", "[::1]/a", "user:pw@[::1]:a"]) expect(urlHost(url, W)).toBeNull();
  });

  test("hosts compare without regard to ASCII case (RFC 4343)", () => {
    const same = (a: string, b: string) => sameHost(urlHost(a, W), urlHost(b, W));
    expect(same("https://Host.XZ/a", "ssh://git@host.xz/b")).toBe(true);
    expect(same("git@host.xz:a", "https://host.xz/b")).toBe(true);
    expect(same("D:\\a", "file:///D:/b")).toBe(true);
    expect(same("https://host.xz/a", "https://other.xz/a")).toBe(false);
    expect(same("https://host.xz/a", "D:\\a")).toBe(false);
    expect(same("https://xn--bcher-kva.example/a", "https://bücher.example/a")).toBe(false);
    expect(same("ext::x", "ext::x")).toBe(false);
  });
});
