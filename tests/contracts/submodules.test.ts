// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { ProgressEvent } from "../../src/contracts/envelope";
import { COMMIT_OUTPUT_TAIL_BYTES, COMMIT_OUTPUT_TAIL_LINES } from "../../src/contracts/limits";
import {
  buildRefusalRemedy,
  buildSubmoduleOutputTail,
  buildSubmoduleRemedy,
  parseSubmoduleProgress,
  redactUrlUserInfo,
  StallRemedy,
  SUBMODULE_ACTIONS,
  SUBMODULE_PROGRESS_PHASES,
  SUBMODULE_REFUSAL_REASONS,
  SUBMODULE_ROW_STATES,
  SUBMODULE_RUN_REFUSAL_REASONS,
  SubmodulePlanRow,
  SubmoduleProgram,
  SubmoduleProgress,
  SubmoduleRowResult,
  type SubmoduleRemedyRequest,
} from "../../src/contracts/submodules";
import { printOrigin } from "../origin";

printOrigin("../../src/contracts/submodules.ts", import.meta.dir);
printOrigin("../../src/contracts/limits.ts", import.meta.dir);

// Data-model §9 and contract §12 (T221, T226). Contract §4 "Quoting rule" and §11 "Remedy commands" shape every command.

const BS = "\\";
const ROW = "6f1c2e4a-8b3d-4c5e-9f60-7a8b9c0d1e2f";
const PARENT_ROW = "0a1b2c3d-4e5f-4061-8273-8495a6b7c8d9";
const REQUEST = "11111111-2222-4333-8444-555555555555";
const OPERATION = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const OLD = "0123456789abcdef0123456789abcdef01234567";
const NEW = "89abcdef0123456789abcdef0123456789abcdef";
const DIGEST = "c".repeat(64);
const b64 = (text: string) => Buffer.from(text).toString("base64");

const GIT = `C:${BS}Program Files${BS}Git${BS}mingw64${BS}bin${BS}git.exe`;
const ROOT = `C:${BS}Users${BS}u${BS}repo`;
const SUB = `${ROOT}${BS}libs${BS}sub`;
const GITDIR = `${ROOT}${BS}.git${BS}modules${BS}sub`;
const WSL = { wslExecutable: `C:${BS}Windows${BS}System32${BS}wsl.exe`, distro: "Ubuntu-24.04" };
const WSL_HEAD = `& 'C:${BS}Windows${BS}System32${BS}wsl.exe' --distribution 'Ubuntu-24.04' --cd / --exec`;
const LGIT = "/usr/bin/git";
const LROOT = "/home/u/repo";
const LSUB = "/home/u/repo/libs/sub";

// Contract §12 "Remedies": the text of each step.
const FETCH_TEXT = "This command fetches this submodule in a terminal, where Git and SSH can ask for input. Then use Update submodules again.";
const CHECKOUT_TEXT = "This command checks out this submodule in a terminal, where Git can ask for input. Then use Update submodules again.";
const CLONE_TEXT = "This command clones this submodule in a terminal, where Git and SSH can ask for input. Then use Update submodules again.";
const REGISTER_TEXT = "This command registers this submodule in a terminal. Then use Update submodules again.";
const UPDATE_TEXT =
  "This command runs Git's own recursive update without Arbareto's checks. Git can leave submodule commits without a ref. It can overwrite files in reused submodule folders and run a configured update command. Resolve every other refusal first.";

const fetchScript = (git: string, sub: string, tail: string) =>
  `& { $p = $env:GIT_PROTOCOL_FROM_USER; $env:GIT_PROTOCOL_FROM_USER = '0'; try { & '${git}' --no-lazy-fetch -C '${sub}' fetch --no-recurse-submodules${tail} } finally { $env:GIT_PROTOCOL_FROM_USER = $p } }`;

const remedy = (request: SubmoduleRemedyRequest) => buildSubmoduleRemedy(request);

describe("closed lists (data-model §9, contract §9 and §12)", () => {
  test("actions", () => {
    expect([...SUBMODULE_ACTIONS]).toEqual(["clone", "reuse", "checkout", "fetch-checkout", "none", "skip"]);
  });

  test("UNSUPPORTED_SUBMODULE reasons, and the two run-only reasons", () => {
    expect([...SUBMODULE_REFUSAL_REASONS]).toEqual(["unsaved-commits", "update-mode", "clone-interrupted", "folder-not-empty", "no-url", "path", "active-value", "remote-name", "gitdir-config", "limit"]);
    expect([...SUBMODULE_RUN_REFUSAL_REASONS]).toEqual(["programs", "changed-after-review"]);
  });

  test("row states and progress phases", () => {
    expect([...SUBMODULE_ROW_STATES]).toEqual(["cloned", "moved", "unchanged", "failed", "clone-interrupted", "changed-elsewhere", "refused"]);
    expect([...SUBMODULE_PROGRESS_PHASES]).toEqual(["fetch", "update"]);
  });
});

describe("plan row validator (data-model §9 'Plan row')", () => {
  const row = {
    rowId: ROW,
    pathBytes: b64("libs/sub"),
    path: "libs/sub",
    name: "libs/sub",
    depth: 0,
    parentRowId: null,
    url: "https://<redacted>@host.example/x.git",
    head: OLD,
    target: NEW,
    remotes: [
      { name: "origin", url: "https://host.example/x.git", default: true },
      { name: "mirror", url: "https://<redacted>@mirror.example/x.git", default: false },
    ],
    action: "fetch-checkout",
    notes: ["Git fetches in this submodule before the checkout."],
    refusal: null,
  };

  test("accepts each action, a nested row, an absent HEAD, and an unknown target", () => {
    for (const action of SUBMODULE_ACTIONS) expect(SubmodulePlanRow.safeParse({ ...row, action }).success).toBe(true);
    expect(SubmodulePlanRow.safeParse({ ...row, depth: 1, parentRowId: PARENT_ROW, head: null, target: null, remotes: [] }).success).toBe(true);
  });

  test("accepts each review refusal reason and refuses the run-only reasons", () => {
    for (const refusal of SUBMODULE_REFUSAL_REASONS) expect(SubmodulePlanRow.safeParse({ ...row, refusal }).success).toBe(true);
    for (const refusal of SUBMODULE_RUN_REFUSAL_REASONS) expect(SubmodulePlanRow.safeParse({ ...row, refusal }).success).toBe(false);
  });

  test("rejects unknown fields, an unknown action, and a malformed row ID", () => {
    expect(SubmodulePlanRow.safeParse({ ...row, command: "git submodule update" }).success).toBe(false);
    expect(SubmodulePlanRow.safeParse({ ...row, action: "merge" }).success).toBe(false);
    expect(SubmodulePlanRow.safeParse({ ...row, rowId: "row-1" }).success).toBe(false);
    expect(SubmodulePlanRow.safeParse({ ...row, remotes: [{ name: "origin", url: "u", default: true, extra: 1 }] }).success).toBe(false);
  });
});

describe("program entry validator (data-model §9 'Submodule program')", () => {
  const entry = { rowId: ROW, key: "core.hooksPath", scope: "local", origin: "file:.git/modules/sub/config", program: ".githooks", digest: DIGEST };

  test("accepts a digest, absent, and unchecked, and a kept Git directory in place of a row", () => {
    expect(SubmoduleProgram.safeParse(entry).success).toBe(true);
    expect(SubmoduleProgram.safeParse({ ...entry, digest: "absent" }).success).toBe(true);
    expect(SubmoduleProgram.safeParse({ ...entry, digest: "unchecked" }).success).toBe(true);
    const { rowId: _row, ...kept } = entry;
    expect(SubmoduleProgram.safeParse({ ...kept, gitDirectory: GITDIR }).success).toBe(true);
  });

  test("rejects unknown fields and another digest form", () => {
    expect(SubmoduleProgram.safeParse({ ...entry, value: "rm -rf /" }).success).toBe(false);
    expect(SubmoduleProgram.safeParse({ ...entry, digest: "abc" }).success).toBe(false);
    expect(SubmoduleProgram.safeParse({ ...entry, digest: DIGEST.toUpperCase() }).success).toBe(false);
  });
});

describe("row result validator (data-model §9 'Row result', contract §12 'Reconciliation and outcome')", () => {
  const flags = { fetched: false, connected: false, found: false, registered: false };
  const base = { rowId: ROW, path: "libs/sub", oldCommit: OLD, newCommit: NEW, ...flags };

  test("accepts every state with the four flags", () => {
    expect(SubmoduleRowResult.safeParse({ ...base, state: "cloned", oldCommit: null }).success).toBe(true);
    expect(SubmoduleRowResult.safeParse({ ...base, state: "moved", fetched: true, connected: true, found: true, registered: true }).success).toBe(true);
    expect(SubmoduleRowResult.safeParse({ ...base, state: "unchanged", newCommit: OLD }).success).toBe(true);
    expect(SubmoduleRowResult.safeParse({ ...base, state: "changed-elsewhere" }).success).toBe(true);
  });

  test("a refused row carries any review or run reason, programs and changed-after-review included", () => {
    for (const reason of [...SUBMODULE_REFUSAL_REASONS, ...SUBMODULE_RUN_REFUSAL_REASONS]) {
      const result = { ...base, state: "refused", newCommit: OLD, reason, text: "Submodule libs/sub needs programs." };
      expect(SubmoduleRowResult.safeParse(result).success).toBe(true);
    }
    expect(SubmoduleRowResult.safeParse({ ...base, state: "refused", reason: "bogus", text: "x" }).success).toBe(false);
  });

  test("a refused row carries a remedy or none", () => {
    const refused = { ...base, state: "refused", reason: "unsaved-commits", text: "Submodule libs/sub is at commit 0123456789ab." };
    expect(SubmoduleRowResult.safeParse({ ...refused, remedy: { command: `& '${GIT}' --no-lazy-fetch -C '${SUB}' branch 'arbareto-saved-0123456789ab' '${OLD}'` } }).success).toBe(true);
  });

  test("a failed process row carries its output tail and remedy", () => {
    const failed = { ...base, state: "failed", newCommit: OLD, fetched: true, outputTail: "fatal: could not read from remote\n", remedy: { command: null, text: FETCH_TEXT } };
    expect(SubmoduleRowResult.safeParse(failed).success).toBe(true);
  });

  test("a failed read names the read and carries no remedy", () => {
    const failedRead = { ...base, state: "failed", newCommit: OLD, failedRead: "remote-get-url" };
    expect(SubmoduleRowResult.safeParse(failedRead).success).toBe(true);
    expect(SubmoduleRowResult.safeParse({ ...failedRead, remedy: { command: "x", text: CHECKOUT_TEXT } }).success).toBe(false);
  });

  test("a moved row carries its old and its new commit", () => {
    expect(SubmoduleRowResult.safeParse({ ...base, state: "moved", oldCommit: null }).success).toBe(false);
    expect(SubmoduleRowResult.safeParse({ ...base, state: "moved", newCommit: null }).success).toBe(false);
    expect(SubmoduleRowResult.safeParse({ ...base, state: "moved", oldCommit: null, newCommit: null }).success).toBe(false);
  });

  test("an interrupted clone carries its folder path", () => {
    expect(SubmoduleRowResult.safeParse({ ...base, state: "clone-interrupted", connected: true, folderPath: SUB }).success).toBe(true);
  });

  test("rejects a missing flag, an unknown state, and unknown fields", () => {
    const { registered: _r, ...noFlag } = { ...base, state: "moved" };
    expect(SubmoduleRowResult.safeParse(noFlag).success).toBe(false);
    expect(SubmoduleRowResult.safeParse({ ...base, state: "merged" }).success).toBe(false);
    expect(SubmoduleRowResult.safeParse({ ...base, state: "moved", stderr: "fatal" }).success).toBe(false);
  });
});

describe("progress event validator (data-model §9 'Progress', contract §2 and §12 'Progress')", () => {
  // The row index names the row in the ordered row list; no row ID goes out.
  const event = { requestId: REQUEST, operationId: OPERATION, state: "running", phase: "fetch", counters: { rowIndex: 2, rowCount: 5, percent: 45 }, stalled: false };
  const accepted = [
    event,
    { ...event, phase: "update", counters: { rowIndex: 2, rowCount: 5 }, stalled: true },
    { ...event, counters: { rowIndex: 1, rowCount: 1, percent: 0 } },
    { ...event, counters: { rowIndex: 5, rowCount: 5, percent: 100 } },
  ];

  test("accepts the phase fetch or update, a percentage or none, and the stalled flag", () => {
    for (const value of accepted) expect(SubmoduleProgress.safeParse(value).success).toBe(true);
  });

  test("every accepted event is a contract §2 progress event", () => {
    for (const value of accepted) expect(ProgressEvent.safeParse(value).success).toBe(true);
  });

  test("the row index lies within the row count", () => {
    expect(SubmoduleProgress.safeParse({ ...event, counters: { rowIndex: 0, rowCount: 5 } }).success).toBe(false);
    expect(SubmoduleProgress.safeParse({ ...event, counters: { rowIndex: 6, rowCount: 5 } }).success).toBe(false);
    expect(SubmoduleProgress.safeParse({ ...event, counters: { rowCount: 5 } }).success).toBe(false);
    expect(SubmoduleProgress.safeParse({ ...event, phase: undefined }).success).toBe(false);
  });

  test("never carries a command or Git text", () => {
    expect(SubmoduleProgress.safeParse({ ...event, command: `& '${GIT}' fetch` }).success).toBe(false);
    expect(SubmoduleProgress.safeParse({ ...event, stallRemedy: { text: FETCH_TEXT } }).success).toBe(false);
    expect(SubmoduleProgress.safeParse({ ...event, text: "Receiving objects:  45% (45/100)" }).success).toBe(false);
    expect(SubmoduleProgress.safeParse({ ...event, phase: "Receiving objects" }).success).toBe(false);
    expect(SubmoduleProgress.safeParse({ ...event, counters: { ...event.counters, percent: "45% (45/100)" } }).success).toBe(false);
    expect(SubmoduleProgress.safeParse({ ...event, rowId: ROW }).success).toBe(false);
    expect(SubmoduleProgress.safeParse({ ...event, counters: { ...event.counters, objects: 45 } }).success).toBe(false);
    expect(SubmoduleProgress.safeParse({ ...event, phase: "reconciliation" }).success).toBe(false);
    expect(SubmoduleProgress.safeParse({ ...event, counters: { ...event.counters, percent: 101 } }).success).toBe(false);
  });
});

describe("stallRemedy field (data-model §7, contract §6 'Activity and stall notice')", () => {
  test("holds the command and its text, or the text alone when the quoting rule refuses a value", () => {
    expect(StallRemedy.safeParse({ command: fetchScript(GIT, SUB, ""), text: FETCH_TEXT }).success).toBe(true);
    expect(StallRemedy.safeParse({ text: FETCH_TEXT }).success).toBe(true);
    expect(StallRemedy.safeParse({ command: "x" }).success).toBe(false);
    expect(StallRemedy.safeParse({ command: "x", text: FETCH_TEXT, outputTail: "y" }).success).toBe(false);
  });
});

describe("progress parser (contract §12 'Progress')", () => {
  test("takes the counter of the newest segment, split at CR and LF", () => {
    expect(parseSubmoduleProgress("Receiving objects:  10% (10/100)\rReceiving objects:  45% (45/100), 1.00 MiB | 2.00 MiB/s\r")).toBe(45);
    expect(parseSubmoduleProgress("Counting objects: 100% (3/3), done.\nReceiving objects:   5% (1/20)\r")).toBe(5);
    expect(parseSubmoduleProgress("Receiving objects: 100% (20/20), done.\n")).toBe(100);
  });

  test("takes the last match of the newest segment", () => {
    expect(parseSubmoduleProgress("x  10% (1/10) y  20% (2/10)\r")).toBe(20);
  });

  test("returns none for a translated title without a counter", () => {
    expect(parseSubmoduleProgress("Empfange Objekte:  45% (45/100)\rKlone nach 'libs/sub' ...\n")).toBeNull();
    expect(parseSubmoduleProgress("Klone nach 'libs/sub' ...\n")).toBeNull();
    expect(parseSubmoduleProgress("")).toBeNull();
  });

  test("parses only the untranslated counter format", () => {
    expect(parseSubmoduleProgress("Empfange Objekte:  45% (45/100)\r")).toBe(45);
    expect(parseSubmoduleProgress("Receiving objects: 45 %\r")).toBeNull();
  });
});

describe("output tail builder (contract §9 'Commit failure output', §12 'Output tail')", () => {
  const tail = (text: string | Uint8Array, dropped = false) => buildSubmoduleOutputTail(typeof text === "string" ? new TextEncoder().encode(text) : text, dropped);

  test("a segment that ends with a lone CR replaces the earlier text of its line", () => {
    expect(tail("Receiving objects:  10% (1/10)\rReceiving objects:  50% (5/10)\rReceiving objects: 100% (10/10), done.\nfatal: x\n")).toBe(
      "Receiving objects: 100% (10/10), done.\nfatal: x\n",
    );
    expect(tail("abcdef\rxy\n")).toBe("xy\n");
    expect(tail("x  10% (1/10)\rx  20% (2/10)\r")).toBe("x  20% (2/10)");
  });

  test("CR LF becomes LF", () => {
    expect(tail("error: a\r\nerror: b\r\n")).toBe("error: a\nerror: b\n");
  });

  test("decodes UTF-8 with U+FFFD and removes escape sequences and controls except TAB and LF", () => {
    expect(tail(new Uint8Array([0x61, 0xff, 0x62, 0x0a]))).toBe("a�b\n");
    expect(tail("\u001b[31mred\u001b[0m\tok\u0007\u007f\u0085\u009b\n")).toBe("red\tok\n");
    const out = tail("a\u001b]0;title\u0007b\u001b(Bc\u0000d\u0008e\u000bf\n");
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(out.endsWith("\n")).toBe(true);
  });

  test("redacts URL user information after sanitizing", () => {
    expect(tail("fatal: unable to access 'https://u:TOKEN@host.example/x.git/'\n")).toBe("fatal: unable to access 'https://<redacted>@host.example/x.git/'\n");
    expect(tail("https://u:TO\u001b[0mKEN@host.example/x.git\n")).toBe("https://<redacted>@host.example/x.git\n");
  });

  test("keeps the last 100 lines", () => {
    expect(COMMIT_OUTPUT_TAIL_LINES).toBe(100);
    const text = Array.from({ length: 150 }, (_v, i) => `line ${i + 1}\n`).join("");
    const out = tail(text);
    expect(out).toContain("line 150\n");
    expect(out).toContain("line 52\n");
    expect(out).not.toContain("line 50\n");
    expect(out.split("\n").filter((line) => line !== "").length).toBeLessThanOrEqual(100);
  });

  test("keeps the last 16 KiB and drops the first partial line, so a URL is never cut at its start", () => {
    expect(COMMIT_OUTPUT_TAIL_BYTES).toBe(16 * 1024);
    // The user information is longer than `<redacted>`. The §9 order cuts raw bytes before the redaction, so a shorter one can grow the text past 16 KiB.
    const line = `remote: https://user:TOKEN-0123456789@host.example/${"p".repeat(150)}\n`;
    const text = line.repeat(Math.ceil((20 * 1024) / line.length));
    const out = tail(text);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(16 * 1024);
    expect(out).not.toContain("TOKEN");
    expect(out.startsWith("remote: https://<redacted>@host.example/")).toBe(true);
    const partial = tail(`ps://u:TOKEN@host.example/x\nfatal: y\n`, true);
    expect(partial).toBe("fatal: y\n");
  });
});

describe("URL redaction (contract §7 'URL user information')", () => {
  test("text before the last @ of each authority becomes <redacted>", () => {
    expect(redactUrlUserInfo("https://u:TOKEN@host.example/x.git")).toBe("https://<redacted>@host.example/x.git");
    expect(redactUrlUserInfo("ssh://git@a@host.example:22/x")).toBe("ssh://<redacted>@host.example:22/x");
    expect(redactUrlUserInfo("a https://t@h/x and http://u:p@g?q#f")).toBe("a https://<redacted>@h/x and http://<redacted>@g?q#f");
  });

  test("an @ after the authority stays", () => {
    expect(redactUrlUserInfo("https://host.example/a@b")).toBe("https://host.example/a@b");
    expect(redactUrlUserInfo("https://host.example?u=a@b")).toBe("https://host.example?u=a@b");
    expect(redactUrlUserInfo("git@host.example:x.git")).toBe("git@host.example:x.git");
  });
});

describe("Windows step remedies (contract §12 'Remedies', §4 quoting rule)", () => {
  test("fetch: the script block sets GIT_PROTOCOL_FROM_USER=0 in try and restores it in finally", () => {
    expect(remedy({ step: "fetch", gitPath: GIT, submoduleWorktree: SUB })).toEqual({ command: fetchScript(GIT, SUB, ""), text: FETCH_TEXT });
  });

  test("fallback fetch passes -- before the remote name and the full target ID", () => {
    expect(remedy({ step: "fallback-fetch", gitPath: GIT, submoduleWorktree: SUB, remote: "origin", target: NEW })).toEqual({
      command: fetchScript(GIT, SUB, ` -- 'origin' '${NEW}'`),
      text: FETCH_TEXT,
    });
  });

  test("fallback fetch with a target that is not a full object ID gives no command", () => {
    for (const target of ["HEAD", "main", NEW.slice(0, 12), NEW.toUpperCase(), `${NEW}0`, "--upload-pack=x", ""]) {
      expect(remedy({ step: "fallback-fetch", gitPath: GIT, submoduleWorktree: SUB, remote: "origin", target })).toEqual({ command: null, text: FETCH_TEXT });
      expect(remedy({ step: "fallback-fetch", gitPath: LGIT, submoduleWorktree: LSUB, remote: "origin", target, wsl: WSL })).toEqual({ command: null, text: FETCH_TEXT });
    }
  });

  test("connect and checkout, clone, and register use ':(literal)<path>'", () => {
    const at = { gitPath: GIT, parentWorktree: ROOT, path: "sub[1]" };
    const checkout = `& '${GIT}' --no-lazy-fetch -C '${ROOT}' submodule update --init --no-fetch -- ':(literal)sub[1]'`;
    expect(remedy({ step: "checkout", ...at })).toEqual({ command: checkout, text: CHECKOUT_TEXT });
    expect(remedy({ step: "connect", ...at })).toEqual({ command: checkout, text: CHECKOUT_TEXT });
    expect(remedy({ step: "clone", ...at })).toEqual({ command: `& '${GIT}' --no-lazy-fetch -C '${ROOT}' submodule update --init -- ':(literal)sub[1]'`, text: CLONE_TEXT });
    expect(remedy({ step: "register", ...at })).toEqual({ command: `& '${GIT}' --no-lazy-fetch -C '${ROOT}' submodule init -- ':(literal)sub[1]'`, text: REGISTER_TEXT });
  });

  test("no step command passes --recursive or -c fetch.recurseSubmodules=no", () => {
    const requests: SubmoduleRemedyRequest[] = [
      { step: "fetch", gitPath: GIT, submoduleWorktree: SUB },
      { step: "fallback-fetch", gitPath: GIT, submoduleWorktree: SUB, remote: "origin", target: NEW },
      { step: "connect", gitPath: GIT, parentWorktree: ROOT, path: "libs/sub" },
      { step: "checkout", gitPath: GIT, parentWorktree: ROOT, path: "libs/sub" },
      { step: "clone", gitPath: GIT, parentWorktree: ROOT, path: "libs/sub" },
      { step: "register", gitPath: GIT, parentWorktree: ROOT, path: "libs/sub" },
    ];
    for (const request of requests) {
      const { command } = remedy(request);
      expect(command).not.toBeNull();
      expect(command).not.toContain("--recursive");
      expect(command).not.toContain("fetch.recurseSubmodules");
      expect(command).toContain(`'${GIT}' --no-lazy-fetch `);
    }
  });

  test("each value doubles the five PowerShell quote characters, and the path form drops a trailing separator", () => {
    for (const q of ["'", "‘", "’", "‚", "‛"]) {
      const d = `${q}${q}`;
      const out = remedy({ step: "clone", gitPath: GIT, parentWorktree: `${ROOT}${q}x${BS}`, path: `a${q}b` });
      expect(out.command).toBe(`& '${GIT}' --no-lazy-fetch -C '${ROOT}${d}x' submodule update --init -- ':(literal)a${d}b'`);
    }
  });

  test("a value that the §4 rule refuses gives no command, and the text stays", () => {
    const refusedValues: SubmoduleRemedyRequest[] = [
      { step: "clone", gitPath: GIT, parentWorktree: ROOT, path: 'a"b' },
      { step: "checkout", gitPath: GIT, parentWorktree: ROOT, path: "a“b" },
      { step: "register", gitPath: GIT, parentWorktree: ROOT, path: "a\u0001b" },
      { step: "checkout", gitPath: GIT, parentWorktree: ROOT, path: new Uint8Array([0x61, 0xff]) },
      { step: "fetch", gitPath: GIT, submoduleWorktree: `${SUB}"x` },
      { step: "fallback-fetch", gitPath: GIT, submoduleWorktree: SUB, remote: "or\u0000igin", target: NEW },
      { step: "fallback-fetch", gitPath: GIT, submoduleWorktree: SUB, remote: `origin${BS}`, target: NEW },
    ];
    const texts: Record<string, string> = { fetch: FETCH_TEXT, "fallback-fetch": FETCH_TEXT, checkout: CHECKOUT_TEXT, clone: CLONE_TEXT, register: REGISTER_TEXT };
    for (const request of refusedValues) {
      const out = remedy(request);
      expect(out.command).toBeNull();
      expect(out.text).toBe(texts[request.step]!);
    }
  });
});

describe("refusal remedies (contract §12 'Refusals' and 'Remedies')", () => {
  test("update-mode names its path in Git's own recursive update, with the skipped-checks text", () => {
    expect(buildRefusalRemedy({ reason: "update-mode", gitPath: GIT, parentWorktree: ROOT, path: "libs/sub" })).toEqual({
      command: `& '${GIT}' --no-lazy-fetch -C '${ROOT}' submodule update --init --recursive -- ':(literal)libs/sub'`,
      text: UPDATE_TEXT,
    });
  });

  test("a submodule gitdir-config names its path; a superproject gitdir-config and limit end before --", () => {
    expect(buildRefusalRemedy({ reason: "gitdir-config", gitPath: GIT, parentWorktree: SUB, path: "nested" })).toEqual({
      command: `& '${GIT}' --no-lazy-fetch -C '${SUB}' submodule update --init --recursive -- ':(literal)nested'`,
      text: UPDATE_TEXT,
    });
    const bare = { command: `& '${GIT}' --no-lazy-fetch -C '${ROOT}' submodule update --init --recursive`, text: UPDATE_TEXT };
    expect(buildRefusalRemedy({ reason: "gitdir-config", gitPath: GIT, parentWorktree: ROOT })).toEqual(bare);
    expect(buildRefusalRemedy({ reason: "limit", gitPath: GIT, parentWorktree: ROOT })).toEqual(bare);
  });

  test("unsaved-commits gives the branch command with --no-lazy-fetch first and a 12-digit short ID", () => {
    const out = buildRefusalRemedy({ reason: "unsaved-commits", source: "review", gitPath: GIT, submoduleWorktree: SUB, commit: OLD });
    expect(out).toMatchObject({ command: `& '${GIT}' --no-lazy-fetch -C '${SUB}' branch 'arbareto-saved-0123456789ab' '${OLD}'` });
    const run = buildRefusalRemedy({ reason: "unsaved-commits", source: "run", gitPath: GIT, submoduleWorktree: SUB, commit: OLD });
    expect(run).toMatchObject({ command: `& '${GIT}' --no-lazy-fetch -C '${SUB}' branch 'arbareto-saved-0123456789ab' '${OLD}'` });
  });

  test("unsaved-commits in a kept Git directory uses --git-dir and --work-tree in place of -C", () => {
    const out = buildRefusalRemedy({ reason: "unsaved-commits", source: "review", gitPath: GIT, gitDirectory: GITDIR, commit: OLD });
    expect(out).toMatchObject({ command: `& '${GIT}' --no-lazy-fetch --git-dir='${GITDIR}' --work-tree='${GITDIR}' branch 'arbareto-saved-0123456789ab' '${OLD}'` });
  });

  test("the clone-check unsaved-commits refusal gives no command", () => {
    const out = buildRefusalRemedy({ reason: "unsaved-commits", source: "clone-check", gitPath: GIT, submoduleWorktree: SUB, commit: OLD });
    expect(out?.command ?? null).toBeNull();
  });

  test("remote-name, programs, changed-after-review, no-url, path, active-value, clone-interrupted, and folder-not-empty give no command", () => {
    for (const reason of ["remote-name", "programs", "changed-after-review", "no-url", "path", "active-value", "clone-interrupted", "folder-not-empty"] as const) {
      const out = buildRefusalRemedy({ reason, gitPath: GIT, parentWorktree: ROOT, path: "libs/sub" });
      expect(out?.command ?? null).toBeNull();
    }
  });

  test("a refused value gives no command for the update and branch forms", () => {
    expect(buildRefusalRemedy({ reason: "update-mode", gitPath: GIT, parentWorktree: ROOT, path: 'a"b' })).toEqual({ command: null, text: UPDATE_TEXT });
    expect(buildRefusalRemedy({ reason: "limit", gitPath: GIT, parentWorktree: `${ROOT}\u0007a` })).toEqual({ command: null, text: UPDATE_TEXT });
    expect(buildRefusalRemedy({ reason: "unsaved-commits", source: "review", gitPath: `${GIT}”`, submoduleWorktree: SUB, commit: OLD })?.command ?? null).toBeNull();
  });
});

describe("WSL remedies (contract §11 'Remedy commands', §12 'Remedies')", () => {
  test("fetch starts with /usr/bin/env GIT_PROTOCOL_FROM_USER=0 after --exec", () => {
    expect(remedy({ step: "fetch", gitPath: LGIT, submoduleWorktree: LSUB, wsl: WSL })).toEqual({
      command: `${WSL_HEAD} /usr/bin/env GIT_PROTOCOL_FROM_USER=0 '${LGIT}' --no-lazy-fetch -C '${LSUB}' fetch --no-recurse-submodules`,
      text: FETCH_TEXT,
    });
    expect(remedy({ step: "fallback-fetch", gitPath: LGIT, submoduleWorktree: LSUB, remote: "origin", target: NEW, wsl: WSL })).toEqual({
      command: `${WSL_HEAD} /usr/bin/env GIT_PROTOCOL_FROM_USER=0 '${LGIT}' --no-lazy-fetch -C '${LSUB}' fetch --no-recurse-submodules -- 'origin' '${NEW}'`,
      text: FETCH_TEXT,
    });
  });

  test("checkout, clone, register, update, and branch use the §11 form with Linux paths", () => {
    const at = { gitPath: LGIT, parentWorktree: LROOT, path: "libs/sub", wsl: WSL };
    expect(remedy({ step: "checkout", ...at }).command).toBe(`${WSL_HEAD} '${LGIT}' --no-lazy-fetch -C '${LROOT}' submodule update --init --no-fetch -- ':(literal)libs/sub'`);
    expect(remedy({ step: "clone", ...at }).command).toBe(`${WSL_HEAD} '${LGIT}' --no-lazy-fetch -C '${LROOT}' submodule update --init -- ':(literal)libs/sub'`);
    expect(remedy({ step: "register", ...at }).command).toBe(`${WSL_HEAD} '${LGIT}' --no-lazy-fetch -C '${LROOT}' submodule init -- ':(literal)libs/sub'`);
    expect(buildRefusalRemedy({ reason: "update-mode", ...at })).toEqual({
      command: `${WSL_HEAD} '${LGIT}' --no-lazy-fetch -C '${LROOT}' submodule update --init --recursive -- ':(literal)libs/sub'`,
      text: UPDATE_TEXT,
    });
    expect(buildRefusalRemedy({ reason: "limit", gitPath: LGIT, parentWorktree: LROOT, wsl: WSL })?.command).toBe(
      `${WSL_HEAD} '${LGIT}' --no-lazy-fetch -C '${LROOT}' submodule update --init --recursive`,
    );
    expect(buildRefusalRemedy({ reason: "unsaved-commits", source: "review", gitPath: LGIT, submoduleWorktree: LSUB, commit: OLD, wsl: WSL })).toMatchObject({
      command: `${WSL_HEAD} '${LGIT}' --no-lazy-fetch -C '${LSUB}' branch 'arbareto-saved-0123456789ab' '${OLD}'`,
    });
  });

  test("Linux paths keep a trailing slash", () => {
    expect(remedy({ step: "fetch", gitPath: LGIT, submoduleWorktree: `${LSUB}/`, wsl: WSL }).command).toContain(`-C '${LSUB}/' fetch`);
  });

  test("an approved distro Git path with = gives no WSL fetch command; other steps still build", () => {
    const git = "/opt/g=it/bin/git";
    expect(remedy({ step: "fetch", gitPath: git, submoduleWorktree: LSUB, wsl: WSL })).toEqual({ command: null, text: FETCH_TEXT });
    expect(remedy({ step: "fallback-fetch", gitPath: git, submoduleWorktree: LSUB, remote: "origin", target: NEW, wsl: WSL })).toEqual({ command: null, text: FETCH_TEXT });
    expect(remedy({ step: "checkout", gitPath: git, parentWorktree: LROOT, path: "libs/sub", wsl: WSL }).command).toBe(
      `${WSL_HEAD} '${git}' --no-lazy-fetch -C '${LROOT}' submodule update --init --no-fetch -- ':(literal)libs/sub'`,
    );
  });

  test("a WSL remote name with U+005C gives no WSL command", () => {
    expect(remedy({ step: "fallback-fetch", gitPath: LGIT, submoduleWorktree: LSUB, remote: `or${BS}igin`, target: NEW, wsl: WSL })).toEqual({ command: null, text: FETCH_TEXT });
  });

  test("any other WSL value after --distribution with U+005C gives no command", () => {
    expect(remedy({ step: "clone", gitPath: LGIT, parentWorktree: LROOT, path: `a${BS}b`, wsl: WSL }).command).toBeNull();
    expect(remedy({ step: "fetch", gitPath: LGIT, submoduleWorktree: `/home/u/r${BS}x`, wsl: WSL }).command).toBeNull();
    expect(remedy({ step: "register", gitPath: LGIT, parentWorktree: LROOT, path: "libs/sub", wsl: { ...WSL, distro: `Ub${BS}untu` } }).command).toBeNull();
  });

  test("the WSL clone-check unsaved-commits refusal gives no command", () => {
    const out = buildRefusalRemedy({ reason: "unsaved-commits", source: "clone-check", gitPath: LGIT, submoduleWorktree: LSUB, commit: OLD, wsl: WSL });
    expect(out?.command ?? null).toBeNull();
  });
});
