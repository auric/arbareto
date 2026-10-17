// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import {
  createFetchParser,
  FETCH_FLAGS,
  type FetchFlag,
  holdsExec,
  parseAheadBehind,
  parsePushPorcelain,
  parsePushRecord,
  parsePushUrls,
  parseRevListCount,
  parseTracking,
  SYNC_FETCH_LISTED_REFS,
} from "../../src/git-service/sync-parsers";
import { RECORDED } from "./sync-recorded";

printOrigin("../../src/git-service/sync-parsers.ts", import.meta.dir);

// Contract Δ3 grammars, data-model §1, §4, and §5 (T015).

const bytes = (text: string | Uint8Array): Uint8Array => (typeof text === "string" ? new TextEncoder().encode(text) : text);
const Z1 = "0".repeat(40);
const A1 = "a".repeat(40);
const B1 = "b".repeat(40);
const A2 = "a".repeat(64);
const B2 = "b".repeat(64);

// Feeds the output in chunks at the given byte offsets.
function fetchList(output: string | Uint8Array, format: "sha1" | "sha256" = "sha1", cuts: number[] = []) {
  const all = bytes(output);
  const parser = createFetchParser(format);
  let at = 0;
  for (const cut of [...cuts, all.length]) {
    parser.push(all.subarray(at, cut));
    at = cut;
  }
  return parser.end();
}

const zeroCounts = (): Record<FetchFlag, number> => Object.fromEntries(FETCH_FLAGS.map((f) => [f, 0])) as Record<FetchFlag, number>;

describe("fetch porcelain", () => {
  test("the limit value", () => expect(SYNC_FETCH_LISTED_REFS).toBe(1000));

  test("recorded outputs hold each flag", () => {
    const seen = new Set<string>();
    for (const key of ["fetch.d3", "fetch.prune-tags-force", "fetch.rewound", "fetch.up-to-date-verbose"]) {
      const output = RECORDED[key]!.stdout;
      const result = fetchList(output);
      expect(result?.updates.map((u) => `${u.flag} ${u.oldObjectId} ${u.newObjectId} ${u.ref}`)).toEqual(output.split("\n").slice(0, -1));
      for (const u of result!.updates) seen.add(u.flag);
    }
    expect([...seen].sort()).toEqual([...FETCH_FLAGS].sort());
    expect(fetchList(RECORDED["fetch.prune-tags-force"]!.stdout)?.counts).toEqual({ ...zeroCounts(), "-": 1, " ": 1, "+": 2, "*": 1, t: 1 });
    expect(fetchList(RECORDED["fetch.prune-tags-force"]!.stdout)?.updates[0]).toEqual({ flag: "-", oldObjectId: "c53b5b9004fb3ec22e81c45a3966ff316fbf09cc", newObjectId: Z1, ref: "refs/remotes/origin/gone-soon" });
  });

  test("SHA-256 object IDs and a new ref with the zero OID", () => {
    expect(fetchList(`* ${"0".repeat(64)} ${B2} refs/tags/v1\n+ ${A2} ${B2} refs/remotes/origin/main\n`, "sha256")).toEqual({
      updates: [
        { flag: "*", oldObjectId: "0".repeat(64), newObjectId: B2, ref: "refs/tags/v1" },
        { flag: "+", oldObjectId: A2, newObjectId: B2, ref: "refs/remotes/origin/main" },
      ],
      counts: { ...zeroCounts(), "*": 1, "+": 1 },
    });
  });

  test("empty output gives no update", () => expect(fetchList("")).toEqual({ updates: [], counts: zeroCounts() }));

  test("a UTF-8 ref name passes as text", () => {
    expect(fetchList(`* ${Z1} ${B1} refs/remotes/origin/zweig-ä\n`)).toMatchObject({ updates: [{ ref: "refs/remotes/origin/zweig-ä" }] });
  });

  test("random frame splits give the same result", () => {
    const output = Array.from({ length: 50 }, (_, i) => `${FETCH_FLAGS[i % FETCH_FLAGS.length]} ${A1} ${B1} refs/remotes/o/ä${i}\n`).join("");
    const whole = fetchList(output);
    const size = bytes(output).length;
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let round = 0; round < 50; round++) {
      const cuts = Array.from({ length: 1 + Math.floor(random() * 20) }, () => Math.floor(random() * size)).sort((a, b) => a - b);
      expect(fetchList(output, "sha1", cuts)).toEqual(whole);
    }
    // Every single-byte frame.
    expect(fetchList(output, "sha1", Array.from({ length: size }, (_, i) => i))).toEqual(whole);
  });

  test("lists 1,000 lines and counts all lines", () => {
    const output = Array.from({ length: 1500 }, (_, i) => `${i % 2 ? "=" : " "} ${A1} ${B1} refs/remotes/o/b${i}\n`).join("");
    const result = fetchList(output);
    if (result === null) throw new Error("malformed");
    expect(result.updates.length).toBe(1000);
    expect(result.updates[999]!.ref).toBe("refs/remotes/o/b999");
    expect(result.counts).toEqual({ ...zeroCounts(), " ": 750, "=": 750 });
  });

  const broken: [string, string, ("sha1" | "sha256")?][] = [
    ["an unknown flag", `x ${A1} ${B1} refs/heads/a\n`],
    ["a short OID", `  ${"a".repeat(39)} ${B1} refs/heads/a\n`],
    ["a SHA-256 OID in a SHA-1 repository", `  ${A2} ${B2} refs/heads/a\n`],
    ["a SHA-1 OID in a SHA-256 repository", `  ${A1} ${B1} refs/heads/a\n`, "sha256"],
    ["mixed OID lengths", `  ${A1} ${B2} refs/heads/a\n`],
    ["uppercase hex", `  ${"A".repeat(40)} ${B1} refs/heads/a\n`],
    ["a missing ref", `  ${A1} ${B1} \n`],
    ["a space in the ref", `  ${A1} ${B1} refs/heads/a b\n`],
    ["a CR before the LF", `  ${A1} ${B1} refs/heads/a\r\n`],
    ["an unterminated last line", `  ${A1} ${B1} refs/heads/a`],
    ["an empty line", `  ${A1} ${B1} refs/heads/a\n\n`],
    ["a broken line after good lines", `  ${A1} ${B1} refs/heads/a\nFrom /x\n`],
  ];
  for (const [name, output, format] of broken) test(`${name} gives MALFORMED_GIT_OUTPUT`, () => expect(fetchList(output, format)).toBeNull());

  test("a broken line above the listing bound still refuses", () => {
    const output = Array.from({ length: 1200 }, (_, i) => `  ${A1} ${B1} refs/remotes/o/b${i}\n`).join("") + "broken\n";
    expect(fetchList(output)).toBeNull();
  });
});

describe("push porcelain", () => {
  const SPEC = "refs/heads/main:refs/heads/main";
  const push = (lines: string[], exit: number, spec = SPEC) => parsePushPorcelain(bytes(lines.map((l) => `${l}\n`).join("")), spec, exit);

  const recorded: [string, string, string, ReturnType<typeof parsePushPorcelain>][] = [
    ["a fast-forward", "push.fast-forward", "refs/heads/p-behind:refs/heads/p-equal", { status: "pushed", reasonText: null }],
    ["a forced update", "push.forced", "refs/heads/p-diverged:refs/heads/p-diverged", { status: "forced", reasonText: "forced update" }],
    ["a new branch", "push.created", "refs/heads/p-equal:refs/heads/created", { status: "created", reasonText: null }],
    ["up to date", "push.up-to-date", "refs/heads/p-equal:refs/heads/created", { status: "up-to-date", reasonText: null }],
    ["rejected, with Done after it", "push.rejected", "refs/heads/p-diverged:refs/heads/p-diverged", { status: "rejected", reasonText: "non-fast-forward" }],
    ["a stale lease", "push.lease-rejected", "refs/heads/p-diverged:refs/heads/p-diverged", { status: "rejected", reasonText: "stale info" }],
    ["remote rejected", "push.remote-rejected", "refs/heads/p-equal:refs/heads/x", { status: "remote-rejected", reasonText: "pre-receive hook declined" }],
  ];
  for (const [name, key, spec, expected] of recorded) {
    test(`recorded: ${name}`, () => expect(parsePushPorcelain(bytes(RECORDED[key]!.stdout), spec, RECORDED[key]!.exit)).toEqual(expected));
  }

  // No fixture produces these forms. They follow the git-push(1) grammar.
  const cases: [string, string, number, ReturnType<typeof parsePushPorcelain>][] = [
    ["rejected with another reason", `!\t${SPEC}\t[rejected] (fetch first)`, 1, { status: "rejected", reasonText: "fetch first" }],
    ["remote failure", `!\t${SPEC}\t[remote failure] (remote failed to report status)`, 1, { status: "remote-failure", reasonText: "remote failed to report status" }],
    ["a reason with parentheses", `!\t${SPEC}\t[remote rejected] (hook (x) said no)`, 1, { status: "remote-rejected", reasonText: "hook (x) said no" }],
  ];
  for (const [name, line, exit, expected] of cases) {
    test(name, () => expect(push(["To /srv/remote.git", line, "Done"], exit)).toEqual(expected));
  }

  test("the reason text changes no status (FR-015)", () => {
    expect(push(["To x", `!\t${SPEC}\t[rejected] (remote rejected)`], 1)).toEqual({ status: "rejected", reasonText: "remote rejected" });
    expect(push(["To x", `!\t${SPEC}\t[remote rejected] (non-fast-forward)`], 1)).toEqual({ status: "remote-rejected", reasonText: "non-fast-forward" });
  });

  test("only the line of the refspec decides", () => {
    expect(push(["To x", `!\trefs/heads/other:refs/heads/other\t[rejected] (non-fast-forward)`, `*\t${SPEC}\t[new branch]`, "Done"], 0)).toEqual({ status: "created", reasonText: null });
    expect(push(["To x", `=\t${SPEC}\t[up to date]`, "Done"], 0, "refs/heads/main:refs/heads/trunk")).toBeNull();
  });

  test("a missing line with a non-zero exit gives none", () => {
    expect(push([], 128)).toEqual({ status: "none", reasonText: null });
    expect(push(["To x"], 1)).toEqual({ status: "none", reasonText: null });
  });

  test("another line with a non-zero exit gives none", () => {
    expect(push(["To x", `!\t${SPEC}\t[no match]`], 1)).toEqual({ status: "none", reasonText: null });
    expect(push(["To x", `!\t${SPEC}\t[rejected] non-fast-forward`], 1)).toEqual({ status: "none", reasonText: null });
    expect(push(["To x", `X\t${SPEC}\t[no match]`], 1)).toEqual({ status: "none", reasonText: null });
    expect(push(["error text"], 1)).toEqual({ status: "none", reasonText: null });
  });

  test("an unknown form with exit 0 gives MALFORMED_GIT_OUTPUT", () => {
    expect(push(["To x", "Done"], 0)).toBeNull();
    expect(push(["To x", `!\t${SPEC}\t[no match]`, "Done"], 0)).toBeNull();
    expect(push(["To x", `=\t${SPEC}\t[up to date]`, "noise", "Done"], 0)).toBeNull();
  });

  test("two lines of the refspec give MALFORMED_GIT_OUTPUT", () => {
    expect(push(["To x", `=\t${SPEC}\t[up to date]`, "To y", `=\t${SPEC}\t[up to date]`, "Done"], 0)).toBeNull();
    expect(push(["To x", `=\t${SPEC}\t[up to date]`, `!\t${SPEC}\t[rejected] (fetch first)`], 1)).toBeNull();
  });

  test("an unterminated output gives MALFORMED_GIT_OUTPUT", () => {
    expect(parsePushPorcelain(bytes(`To x\n=\t${SPEC}\t[up to date]`), SPEC, 0)).toBeNull();
  });
});

describe("push URLs (O-11)", () => {
  test("exactly one URL", () => expect(parsePushUrls(bytes("https://example.test/r.git\n"))).toEqual({ url: "https://example.test/r.git" }));
  test("two URLs give push-urls", () => expect(parsePushUrls(bytes("a\nb\n"))).toEqual({ reason: "push-urls" }));
  test("no URL gives push-urls", () => expect(parsePushUrls(bytes(""))).toEqual({ reason: "push-urls" }));
  test("an unterminated line gives MALFORMED_GIT_OUTPUT", () => expect(parsePushUrls(bytes("a"))).toBeNull());
  test("an empty line gives MALFORMED_GIT_OUTPUT", () => expect(parsePushUrls(bytes("\n"))).toBeNull());
});

describe("tracking records", () => {
  const rec = (refname: string, oid: string, upstream: string, track: string, head: string) => `${refname}\0${oid}\0${upstream}\0${track}\0${head}\n`;
  const parse = (...records: string[]) => parseTracking(bytes(records.join("")), "sha1");

  test("the data-model §1 entries", () => {
    const result = parse(
      rec("refs/heads/main", A1, "refs/remotes/origin/main", "ahead 2, behind 3", "*"),
      rec("refs/heads/equal", A1, "refs/remotes/origin/main", "", " "),
      rec("refs/heads/ahead", A1, "refs/remotes/origin/main", "ahead 1", " "),
      rec("refs/heads/behind", A1, "refs/remotes/origin/main", "behind 10001", " "),
      rec("refs/heads/gone", A1, "refs/remotes/origin/gone", "gone", " "),
      rec("refs/heads/local", A1, "", "", " "),
      rec("refs/heads/on-local", A1, "refs/heads/local", "", " "),
      rec("refs/remotes/origin/main", B1, "", "", " "),
    );
    expect(result).toEqual([
      { name: "main", invalidUtf8: false, objectId: A1, upstream: "refs/remotes/origin/main", upstreamObjectId: B1, track: { state: "counts", ahead: 2, behind: 3 }, current: true },
      { name: "equal", invalidUtf8: false, objectId: A1, upstream: "refs/remotes/origin/main", upstreamObjectId: B1, track: { state: "counts", ahead: 0, behind: 0 }, current: false },
      { name: "ahead", invalidUtf8: false, objectId: A1, upstream: "refs/remotes/origin/main", upstreamObjectId: B1, track: { state: "counts", ahead: 1, behind: 0 }, current: false },
      { name: "behind", invalidUtf8: false, objectId: A1, upstream: "refs/remotes/origin/main", upstreamObjectId: B1, track: { state: "counts", ahead: 0, behind: 10001 }, current: false },
      { name: "gone", invalidUtf8: false, objectId: A1, upstream: "refs/remotes/origin/gone", upstreamObjectId: null, track: { state: "gone" }, current: false },
      { name: "local", invalidUtf8: false, objectId: A1, upstream: null, upstreamObjectId: null, track: { state: "none" }, current: false },
      { name: "on-local", invalidUtf8: false, objectId: A1, upstream: "refs/heads/local", upstreamObjectId: A1, track: { state: "counts", ahead: 0, behind: 0 }, current: false },
    ]);
  });

  test("a recorded listing", () => {
    const BASE = "c53b5b9004fb3ec22e81c45a3966ff316fbf09cc";
    const entry = (name: string, objectId: string, upstreamObjectId: string, ahead: number, behind: number, current = false) => ({ name, invalidUtf8: false, objectId, upstream: `refs/remotes/origin/${name}`, upstreamObjectId, track: { state: "counts" as const, ahead, behind }, current });
    expect(parseTracking(bytes(RECORDED.tracking!.stdout), "sha1")).toEqual([
      entry("main", BASE, BASE, 0, 0, true),
      entry("p-behind", "bbf1b244faad7c21296a5274dd2e24d9a46ca12b", "bbf1b244faad7c21296a5274dd2e24d9a46ca12b", 0, 0),
      entry("p-diverged", "eccb5595dfdb31d77b6b63703720c5b54194a2ac", "b8481fb7912c87754fa5f3baa1f5c684a99d0a8d", 1, 1),
      entry("p-equal", BASE, BASE, 0, 0),
      entry("rewrite", "7af04eb869d5507a766d0df9a6407dfe5f0868a9", "1488cccf42680f79afa72de87baf6cc5dce18433", 1, 0),
    ]);
  });

  test("empty output gives no entry", () => expect(parse()).toEqual([]));

  test("SHA-256 object IDs", () => {
    expect(parseTracking(bytes(rec("refs/heads/m", A2, "", "", "*")), "sha256")).toMatchObject([{ objectId: A2 }]);
    expect(parseTracking(bytes(rec("refs/heads/m", A1, "", "", "*")), "sha256")).toBeNull();
  });

  test("an invalid UTF-8 branch name", () => {
    const raw = new Uint8Array([...bytes("refs/heads/b"), 0xff, ...bytes(`\0${A1}\0\0\0 \n`)]);
    expect(parseTracking(raw, "sha1")).toEqual([{ name: "b�", invalidUtf8: true, objectId: A1, upstream: null, upstreamObjectId: null, track: { state: "none" }, current: false }]);
  });

  const refused: [string, string][] = [
    ["four fields", `refs/heads/a\0${A1}\0\0\n`],
    ["six fields", `refs/heads/a\0${A1}\0\0\0 \0\n`],
    ["no final LF", `refs/heads/a\0${A1}\0\0\0 `],
    ["an empty record", "\n"],
    ["a tag refname", rec("refs/tags/v1", A1, "", "", " ")],
    ["a short refname", rec("refs/heads", A1, "", "", " ")],
    ["a bad OID", rec("refs/heads/a", "x".repeat(40), "", "", " ")],
    ["an upstream outside refs/", rec("refs/heads/a", A1, "origin/main", "", " ")],
    ["a translated track", rec("refs/heads/a", A1, "refs/remotes/o/a", "vor 1", " ")],
    ["a bracketed track", rec("refs/heads/a", A1, "refs/remotes/o/a", "[ahead 1]", " ")],
    ["a zero count", rec("refs/heads/a", A1, "refs/remotes/o/a", "ahead 0", " ")],
    ["a leading zero", rec("refs/heads/a", A1, "refs/remotes/o/a", "behind 01", " ")],
    ["reversed counts", rec("refs/heads/a", A1, "refs/remotes/o/a", "behind 1, ahead 2", " ")],
    ["a track without an upstream", rec("refs/heads/a", A1, "", "ahead 1", " ")],
    ["a track on a remote record", rec("refs/remotes/o/a", A1, "refs/remotes/o/b", "ahead 1", " ")],
    ["another HEAD mark", rec("refs/heads/a", A1, "", "", "+")],
    ["an empty HEAD mark", rec("refs/heads/a", A1, "", "", "")],
    ["a HEAD mark on a remote record", rec("refs/remotes/o/a", A1, "", "", "*")],
    ["two HEAD marks", rec("refs/heads/a", A1, "", "", "*") + rec("refs/heads/b", A1, "", "", "*")],
  ];
  for (const [name, output] of refused) test(`${name} gives MALFORMED_GIT_OUTPUT`, () => expect(parseTracking(bytes(output), "sha1")).toBeNull());
});

describe("ahead and behind counts", () => {
  test("ahead TAB behind", () => {
    expect(parseAheadBehind(bytes(RECORDED["ahead-behind.rewrite"]!.stdout))).toEqual({ ahead: 1, behind: 0 });
    expect(parseAheadBehind(bytes("2\t3\n"))).toEqual({ ahead: 2, behind: 3 });
    expect(parseAheadBehind(bytes("0\t0\n"))).toEqual({ ahead: 0, behind: 0 });
    expect(parseAheadBehind(bytes("0\t20000\n"))).toEqual({ ahead: 0, behind: 20000 });
  });
  for (const output of ["", "2\t3", "2 3\n", "2\t3\n\n", "02\t3\n", "-1\t3\n", "2\t3\t4\n", "a\tb\n"]) {
    test(`${JSON.stringify(output)} gives MALFORMED_GIT_OUTPUT`, () => expect(parseAheadBehind(bytes(output))).toBeNull());
  }
});

describe("push review record (plan.md D4)", () => {
  const rec = (...f: string[]) => `${f.join("\0")}\n`;
  const TOPIC = rec("refs/heads/topic", A1, "refs/remotes/origin/topic", "origin", "refs/heads/topic", "refs/remotes/origin/topic", "origin", "");
  const parse = (output: string | Uint8Array, branch = "topic", format: "sha1" | "sha256" = "sha1") => parsePushRecord(bytes(output), branch, format);

  test("the record of the branch", () => {
    expect(parse(TOPIC)).toEqual({ branch: "topic", upstream: "refs/remotes/origin/topic", upstreamRemote: "origin", upstreamRemoteRef: "refs/heads/topic", push: "refs/remotes/origin/topic", pushRemote: "origin", pushRemoteRef: "" });
  });

  test("recorded records", () => {
    const recorded = (key: string, branch: string) => parse(RECORDED[`push-record.${key}`]!.stdout, branch);
    expect(recorded("push.default=unset/topic", "topic")).toEqual({ branch: "topic", upstream: "refs/remotes/origin/topic", upstreamRemote: "origin", upstreamRemoteRef: "refs/heads/topic", push: "refs/remotes/origin/topic", pushRemote: "origin", pushRemoteRef: "" });
    expect(recorded("push.default=current/noup", "noup")).toEqual({ branch: "noup", upstream: "", upstreamRemote: "", upstreamRemoteRef: "", push: "refs/remotes/origin/noup", pushRemote: "", pushRemoteRef: "" });
    expect(recorded("remote.origin.push/renamed", "renamed")).toEqual({ branch: "renamed", upstream: "refs/remotes/origin/other-name", upstreamRemote: "origin", upstreamRemoteRef: "refs/heads/other-name", push: "refs/remotes/origin/mapped", pushRemote: "origin", pushRemoteRef: "refs/heads/mapped" });
    expect(recorded("branch.pushRemote/topic", "topic")).toEqual({ branch: "topic", upstream: "refs/remotes/origin/topic", upstreamRemote: "origin", upstreamRemoteRef: "refs/heads/topic", push: "", pushRemote: "second", pushRemoteRef: "" });
    expect(recorded("push.default=upstream/renamed", "renamed")).toMatchObject({ push: "refs/remotes/origin/other-name", pushRemote: "origin" });
  });

  test("the prefix match keeps only the equal refname", () => {
    const below = rec("refs/heads/topic/sub", B1, "", "", "", "", "", "");
    expect(parse(below + TOPIC + below)).toMatchObject({ branch: "topic", upstream: "refs/remotes/origin/topic" });
  });

  test("a branch without an upstream has empty fields", () => {
    expect(parse(rec("refs/heads/topic", A1, "", "", "", "", "", ""))).toEqual({ branch: "topic", upstream: "", upstreamRemote: "", upstreamRemoteRef: "", push: "", pushRemote: "", pushRemoteRef: "" });
  });

  test("a UTF-8 branch name", () => {
    expect(parse(rec("refs/heads/zweig-ä", A1, "refs/remotes/o/zweig-ä", "o", "refs/heads/zweig-ä", "", "o", ""), "zweig-ä")).toMatchObject({ branch: "zweig-ä", upstream: "refs/remotes/o/zweig-ä" });
  });

  test("no equal record gives absent", () => {
    expect(parse("")).toBe("absent");
    expect(parse(rec("refs/heads/topic/sub", B1, "", "", "", "", "", ""))).toBe("absent");
  });

  test("SHA-256 object IDs", () => {
    expect(parse(rec("refs/heads/topic", A2, "", "", "", "", "", ""), "topic", "sha256")).toMatchObject({ branch: "topic" });
    expect(parse(rec("refs/heads/topic", A1, "", "", "", "", "", ""), "topic", "sha256")).toBeNull();
  });

  const refused: [string, string][] = [
    ["seven fields", rec("refs/heads/topic", A1, "", "", "", "", "")],
    ["nine fields", rec("refs/heads/topic", A1, "", "", "", "", "", "", "")],
    ["no final LF", rec("refs/heads/topic", A1, "", "", "", "", "", "").slice(0, -1)],
    ["an empty line", "\n"],
    ["a bad OID", rec("refs/heads/topic", "x".repeat(40), "", "", "", "", "", "")],
    ["a refname outside refs/heads/", rec("refs/remotes/origin/topic", A1, "", "", "", "", "", "")],
    ["an upstream outside refs/", rec("refs/heads/topic", A1, "origin/topic", "origin", "refs/heads/topic", "", "", "")],
    ["a push ref outside refs/", rec("refs/heads/topic", A1, "", "", "", "origin/topic", "", "")],
    ["a remote ref outside refs/", rec("refs/heads/topic", A1, "", "", "", "", "o", "topic")],
    ["two equal records", TOPIC + TOPIC],
  ];
  for (const [name, output] of refused) test(`${name} gives MALFORMED_GIT_OUTPUT`, () => expect(parse(output)).toBeNull());
});

describe("lease count (plan.md D5)", () => {
  test("rev-list --count", () => {
    expect(parseRevListCount(bytes(RECORDED["lease-count"]!.stdout))).toBe(1);
    expect(parseRevListCount(bytes("0\n"))).toBe(0);
    expect(parseRevListCount(bytes("3\n"))).toBe(3);
    expect(parseRevListCount(bytes("20000\n"))).toBe(20000);
  });
  for (const output of ["", "3", "03\n", "-1\n", "3\n\n", "3 \n", "3\t0\n", "a\n"]) {
    test(`${JSON.stringify(output)} gives MALFORMED_GIT_OUTPUT`, () => expect(parseRevListCount(bytes(output))).toBeNull());
  }
});

// Plan.md D7 and sequencer.c `parse_insn_line`, `is_command`, `todo_command_info`: the todo lines that Git runs with the shell.
describe("exec lines of a rebase todo", () => {
  const exec = (text: string) => holdsExec(new TextEncoder().encode(text));
  const yes = ["exec make test\n", "x make\n", "  x touch planted\n", "\tx\ttrue\n", "exec\n", "x", "exec\r\n", "pick 1234 a\nexec true\npick 5678 b\n", "x\0tail\n"];
  const no = ["# exec true\n", "pick 1234 exec\n", "execute true\n", "xx true\n", "  # x true\n", "edit 1234 x\n", "", "\n\n", "break\n", "e 1234 a\n"];
  for (const text of yes) test(`${JSON.stringify(text)} holds an exec line`, () => expect(exec(text)).toBe(true));
  for (const text of no) test(`${JSON.stringify(text)} holds no exec line`, () => expect(exec(text)).toBe(false));
});
