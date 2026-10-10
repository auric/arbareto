// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HISTORY_BODY_BYTES } from "../../src/contracts/envelope";
import * as LIMITS from "../../src/contracts/limits";
import { batchCommandArgs, configListArgs, headOidArgs, headTargetArgs, hooksPathArgs, revListArgs, shallowPathArgs } from "../../src/git-service/commands";
import { probeGit } from "../../src/git-service/git-installation";
import { createHistoryReader, DAMAGED_STORE_REMEDY } from "../../src/git-service/history";
import { createRegistrations } from "../../src/git-service/registration";
import { createWorkspaceReader } from "../../src/git-service/status";
import { createTrust } from "../../src/git-service/trust";
import { printOrigin } from "../origin";
import { FIXED_IDENTITY, FIXTURE_ROOT, fixtureDir, fixtureEnv, ownedGit, serviceEnv, useFixtureRoot } from "./fixture-root";
import { cachedF16History } from "../windows/fixture-cache";
import { buildF01, buildF17, buildF19, F16_OBJECT_LIMIT, type Built, type F16HistoryVariant, type F19Variant } from "./fixtures";
import { GIT } from "./git-binary";
import { refState } from "./git-oracle";
import { caseTest, once, openService, type HistoryResult, type Service, type ServiceResponse } from "./service-harness";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/git-service/history.ts", import.meta.dir);

const TASK = "T070";
const TIMEOUT_MS = 120_000;
const WAIT_MS = 30_000;

useFixtureRoot();

const gitPath = (): string => {
  if (GIT === null) throw new Error("Git executable absent");
  return GIT;
};

// Contract §9: a `limited` result carries `OUTPUT_LIMIT` with the reached §5 bound as its reason. The reason is the export name in `limits.ts`.
const limitName = <K extends keyof typeof LIMITS>(name: K): K => name;

async function withService(name: string, body: (service: Service) => Promise<void>): Promise<void> {
  const service = await openService({ git: gitPath(), name, watchHints: false });
  try {
    await body(service);
  } finally {
    await service.dispose();
  }
}

async function history(service: Service, repo: string): Promise<ServiceResponse<HistoryResult>> {
  const { repositoryId, generation } = await service.register(repo);
  return service.readHistory(repositoryId, generation);
}

const repoOf = (built: Built, repo = "repo") => join(built.root, repo);
const git = (repo: string, args: string[], input?: string | Buffer) =>
  ownedGit(gitPath(), FIXTURE_ROOT, repo, ["--no-lazy-fetch", ...args], input === undefined ? {} : { input: Buffer.from(input) });

type Row = HistoryResult["rows"][number];

// Oracle: the exact Git traversal of the task text.
function oracleTraversal(repo: string, tip: string): { oid: string; parents: string[] }[] {
  const out = git(repo, ["--no-optional-locks", "rev-list", "--parents", "--max-count=100", "--date-order", tip]).toString("utf8");
  return out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [oid, ...parents] = line.split(" ");
      return { oid: oid!, parents };
    });
}

// Raw commit objects through `cat-file --batch`, in input order.
function rawCommits(repo: string, oids: string[]): Buffer[] {
  if (oids.length === 0) return [];
  const out = git(repo, ["cat-file", "--batch"], `${oids.join("\n")}\n`);
  const objects: Buffer[] = [];
  for (let at = 0; at < out.length; ) {
    const eol = out.indexOf(0x0a, at);
    const size = Number(out.subarray(at, eol).toString("latin1").split(" ")[2]);
    objects.push(out.subarray(eol + 1, eol + 1 + size));
    at = eol + 1 + size + 1;
  }
  return objects;
}

const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: false }).decode(bytes);
const fatal = new TextDecoder("utf-8", { fatal: true });
// Latin-1 text holds one character per raw byte.
const validUtf8 = (latin1: string) => {
  try {
    fatal.decode(Buffer.from(latin1, "latin1"));
    return true;
  } catch {
    return false;
  }
};

// The commits that the shallow file of the repository lists. Empty without the file.
function shallowFile(repo: string): Set<string> {
  const path = join(repo, git(repo, ["rev-parse", "--git-path", "shallow"]).toString().trim());
  return new Set(existsSync(path) ? readFileSync(path, "latin1").split("\n").filter((l) => l !== "") : []);
}

// T341 oracle: Git's own `%cn`, `%ce`, `%ct`, and `%b` bytes. git-log(1) `--encoding`: an object that claims the output encoding is output verbatim.
// A commit without an `encoding` header claims UTF-8. With `-z`, NUL ends each field and each commit. No field holds NUL, because Git reads the message as a C string.
type CommitterFields = { name: Buffer; email: Buffer; date: number; body: Buffer };
function oracleCommitter(repo: string, commits: { oid: string; encoding: string | null }[]): Map<string, CommitterFields> {
  const found = new Map<string, CommitterFields>();
  const groups = Map.groupBy(commits, (c) => c.encoding ?? "UTF-8");
  for (const [encoding, group] of groups) {
    const oids = group.map((c) => c.oid);
    const out = git(repo, ["log", "--no-walk=unsorted", `--encoding=${encoding}`, "-z", "--format=%H%x00%cn%x00%ce%x00%ct%x00%b", ...oids]);
    const fields: Buffer[] = [];
    for (let at = 0; at < out.length; ) {
      const nul = out.indexOf(0, at);
      fields.push(out.subarray(at, nul));
      at = nul + 1;
    }
    expect(fields.length).toBe(5 * oids.length);
    for (let i = 0; i < fields.length; i += 5) {
      found.set(fields[i]!.toString("latin1"), { name: fields[i + 1]!, email: fields[i + 2]!, date: Number(fields[i + 3]!.toString("latin1")), body: fields[i + 4]! });
    }
  }
  return found;
}

// Contract §5 "History message body": the decoded text ends at the last whole UTF-8 character within the bound.
function oracleBody(raw: Buffer): { body: string; bodyCut: boolean } {
  const text = Buffer.from(new TextDecoder("utf-8", { ignoreBOM: true }).decode(raw), "utf8");
  if (text.length <= HISTORY_BODY_BYTES) return { body: text.toString("utf8"), bodyCut: false };
  let end = HISTORY_BODY_BYTES;
  while ((text[end]! & 0xc0) === 0x80) end--;
  return { body: text.subarray(0, end).toString("utf8"), bodyCut: true };
}

const validBytes = (bytes: Buffer) => validUtf8(bytes.toString("latin1"));

// Contract §3 "HistoryPage result" row fields from the raw object. Invalid UTF-8 decodes to U+FFFD. The subject is Git's first paragraph joined by spaces.
function oracleRow(oid: string, parents: string[], raw: Buffer, shallow: boolean, committer: CommitterFields): Row {
  const split = raw.indexOf("\n\n");
  const headers = raw.subarray(0, split).toString("latin1").split("\n");
  const latin = (name: string) => headers.find((l) => l.startsWith(`${name} `))?.slice(name.length + 1) ?? null;
  const header = (name: string) => {
    const line = latin(name);
    return line === null ? null : decode(Buffer.from(line, "latin1"));
  };
  const rawAuthor = latin("author")!;
  const rawSubject = raw.subarray(split + 2).toString("latin1").split(/\n[ \t]*\n/)[0]!;
  const rawName = rawAuthor.slice(0, rawAuthor.lastIndexOf("<"));
  const rawEmail = rawAuthor.slice(rawAuthor.lastIndexOf("<") + 1, rawAuthor.lastIndexOf(">"));
  const invalidUtf8 = ![rawSubject, rawName, rawEmail].every(validUtf8) || ![committer.name, committer.email, committer.body].every(validBytes);
  const author = header("author")!;
  const email = author.slice(author.lastIndexOf("<") + 1, author.lastIndexOf(">"));
  const name = author.slice(0, author.lastIndexOf("<")).trimEnd();
  const date = Number(author.slice(author.lastIndexOf(">") + 1).trim().split(" ")[0]);
  const encoding = header("encoding");
  const message = decode(raw.subarray(split + 2));
  const subject = message.split(/\n[ \t]*\n/)[0]!.split("\n").map((l) => l.trim()).join(" ").trim();
  return {
    oid,
    parents,
    subject,
    author: { name, email },
    date,
    encoding,
    shallow,
    invalidUtf8,
    committer: { name: decode(committer.name), email: decode(committer.email) },
    committerDate: committer.date,
    ...oracleBody(committer.body),
  };
}

function oracleRows(repo: string, tip: string): Row[] {
  const traversal = oracleTraversal(repo, tip);
  const raws = rawCommits(repo, traversal.map((r) => r.oid));
  const shallow = shallowFile(repo);
  const encodingOf = (raw: Buffer) => raw.subarray(0, raw.indexOf("\n\n")).toString("latin1").split("\n").find((l) => l.startsWith("encoding "))?.slice("encoding ".length) ?? null;
  const committers = oracleCommitter(repo, traversal.map((r, i) => ({ oid: r.oid, encoding: encodingOf(raws[i]!) })));
  return traversal.map((r, i) => oracleRow(r.oid, r.parents, raws[i]!, shallow.has(r.oid), committers.get(r.oid)!));
}

const parentLines = (raw: Buffer) => raw.toString("latin1").slice(0, raw.indexOf("\n\n")).split("\n").filter((l) => l.startsWith("parent ")).map((l) => l.slice(7));
const sorted = (list: string[]) => [...list].sort();

// Parents that the rows name but that are no row of the page.
const outsidePage = (rows: { oid: string; parents: string[] }[]) => {
  const inPage = new Set(rows.map((r) => r.oid));
  return [...new Set(rows.flatMap((r) => r.parents).filter((p) => !inPage.has(p)))];
};

const HEX = { sha1: /^[0-9a-f]{40}$/, sha256: /^[0-9a-f]{64}$/ };

describe("F19 history shapes (contract §3 \"HistoryPage result\")", () => {
  const VARIANTS: F19Variant[] = ["linear", "merge", "octopus", "skewed", "roots", "long", "wide", "encoding", "shallow", "sha256"];

  for (const variant of VARIANTS) {
    caseTest(
      TASK,
      `F19 ${variant}: rows equal git rev-list --parents --max-count=100 --date-order <OID>, with full row fields and separate boundaries`,
      ["shell-double"],
      () =>
        withService(`t070-f19-${variant}`, async (service) => {
          const built = buildF19(gitPath(), `t070-f19-${variant}`, variant);
          const repo = repoOf(built);
          const tip = built.facts.notes.tip as string;
          const response = await history(service, repo);
          expect({ state: response.state, code: response.code }).toEqual({ state: "succeeded", code: undefined });
          const page = response.result!;
          const expected = oracleRows(repo, tip);
          expect(page.scope).toBe("current-checkout");
          expect(page.rows.length).toBeLessThanOrEqual(LIMITS.HISTORY_STREAM_ROWS);
          expect(page.rows).toEqual(expected);
          const format = variant === "sha256" ? "sha256" : "sha1";
          for (const row of page.rows) for (const oid of [row.oid, ...row.parents]) expect(oid).toMatch(HEX[format]);
          expect(page.completeness.state).toBe("complete");
          expect(page.head).toEqual({ state: "branch", target: "refs/heads/main", oid: tip });

          // Contract §3: shallow-unavailable parents come from the raw parent headers of the shallow commits.
          const shallowCommits = (built.facts.notes.shallow as string[] | undefined) ?? [];
          const shallowParents = rawCommits(repo, shallowCommits).flatMap(parentLines);
          expect({ page: sorted(page.boundaries.page), shallow: sorted(page.boundaries.shallow) }).toEqual({
            page: sorted(outsidePage(expected)),
            shallow: sorted(shallowParents),
          });
          for (const parent of shallowParents) expect(page.boundaries.page).not.toContain(parent);
          if (variant === "long") expect(page.boundaries.page.length).toBe(1);
          if (variant === "shallow") {
            expect(shallowParents.length).toBe(1);
            // The shallow commit stays a row with no effective parent, and its boundary keeps it from reading as a root.
            const boundaryRow = page.rows.find((r) => r.oid === shallowCommits[0]);
            expect(boundaryRow?.parents).toEqual([]);
          }
          // T336: only a commit that the shallow file lists is shallow. A root is never shallow.
          expect(page.rows.filter((r) => r.shallow).map((r) => r.oid)).toEqual(shallowCommits);
          if (variant === "roots") expect(page.rows.filter((r) => r.parents.length === 0).length).toBe(2);
          // T336: only the legacy commit holds bytes that are not valid UTF-8.
          expect(page.rows.filter((r) => r.invalidUtf8).map((r) => r.oid)).toEqual(variant === "encoding" ? [tip] : []);
        }),
      TIMEOUT_MS,
    );
  }

  caseTest(
    TASK,
    "F19 encoding: an invalid UTF-8 subject or author gives replacement characters and the encoding value",
    ["shell-double"],
    () =>
      withService("t070-encoding", async (service) => {
        const built = buildF19(gitPath(), "t070-encoding", "encoding");
        const page = (await history(service, repoOf(built))).result!;
        const legacy = page.rows[0]!;
        expect(legacy.oid).toBe(built.facts.notes.tip as string);
        expect({ subject: legacy.subject, author: legacy.author.name, encoding: legacy.encoding }).toEqual({
          subject: "Caf� r�sum�",
          author: "Jos�",
          encoding: "ISO-8859-1",
        });
        for (const row of page.rows.slice(1)) expect(row.encoding).toBeNull();
      }),
    TIMEOUT_MS,
  );

  caseTest(
    "T336",
    "F19 encoding: bytes that are not valid UTF-8 in the subject, author name, or author email without an encoding header give invalidUtf8",
    ["shell-double"],
    () =>
      withService("t336-invalid-utf8", async (service) => {
        const built = buildF19(gitPath(), "t336-invalid-utf8", "encoding");
        const repo = repoOf(built);
        const tip = built.facts.notes.tip as string;
        const tree = git(repo, ["rev-parse", `${tip}^{tree}`]).toString("utf8").trim();
        const ident = (name: string, email: string) => `${name} <${email}> 1767225604 +0000`;
        // Each of the first three commits holds one ISO-8859-1 byte in one field. The last commit holds valid UTF-8 only. No commit has an encoding header.
        const shapes: [string, string, string][] = [
          ["Caf\xe9\n", FIXED_IDENTITY.name, FIXED_IDENTITY.email],
          ["name\n", "Jos\xe9", FIXED_IDENTITY.email],
          ["email\n", FIXED_IDENTITY.name, "jos\xe9@arbareto.invalid"],
          ["Caf\xc3\xa9\n", "Jos\xc3\xa9", FIXED_IDENTITY.email],
        ];
        let parent = tip;
        const oids: string[] = [];
        for (const [message, name, email] of shapes) {
          const raw = Buffer.from(`tree ${tree}\nparent ${parent}\nauthor ${ident(name, email)}\ncommitter ${ident(FIXED_IDENTITY.name, FIXED_IDENTITY.email)}\n\n${message}`, "latin1");
          parent = git(repo, ["hash-object", "-t", "commit", "-w", "--stdin"], raw).toString("utf8").trim();
          oids.unshift(parent);
        }
        git(repo, ["update-ref", "refs/heads/main", parent, tip]);
        // Oracle: the stored objects hold the raw bytes and no encoding header.
        const stored = rawCommits(repo, oids);
        for (const object of stored) expect(object.includes(Buffer.from("\nencoding "))).toBe(false);
        expect(stored[3]!.includes(Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x0a]))).toBe(true);
        const rows = (await history(service, repo)).result!.rows.slice(0, 4);
        expect(rows.map((r) => ({ oid: r.oid, encoding: r.encoding, invalidUtf8: r.invalidUtf8 }))).toEqual([
          { oid: oids[0]!, encoding: null, invalidUtf8: false },
          { oid: oids[1]!, encoding: null, invalidUtf8: true },
          { oid: oids[2]!, encoding: null, invalidUtf8: true },
          { oid: oids[3]!, encoding: null, invalidUtf8: true },
        ]);
        expect(rows).toEqual(oracleRows(repo, parent).slice(0, 4));
      }),
    TIMEOUT_MS,
  );

  caseTest(
    "T322",
    "F19 encoding: an encoding header with an ESC and a DEL byte gives the label without them",
    ["shell-double"],
    () =>
      withService("t322-encoding-control", async (service) => {
        const built = buildF19(gitPath(), "t322-encoding-control", "encoding");
        const repo = repoOf(built);
        const tip = built.facts.notes.tip as string;
        const tree = git(repo, ["rev-parse", `${tip}^{tree}`]).toString("utf8").trim();
        const ident = `${FIXED_IDENTITY.name} <${FIXED_IDENTITY.email}> 1767225604 +0000`;
        const raw = `tree ${tree}\nparent ${tip}\nauthor ${ident}\ncommitter ${ident}\nencoding ISO\x1b-8859\x7f-1\n\ncontrol\n`;
        const oid = git(repo, ["hash-object", "-t", "commit", "-w", "--stdin"], raw).toString("utf8").trim();
        git(repo, ["update-ref", "refs/heads/main", oid, tip]);
        // Oracle: the stored header holds both control bytes.
        expect(rawCommits(repo, [oid])[0]!.includes(Buffer.from("encoding ISO\x1b-8859\x7f-1\n"))).toBe(true);
        const row = (await history(service, repo)).result!.rows[0]!;
        expect({ oid: row.oid, encoding: row.encoding }).toEqual({ oid, encoding: "ISO-8859-1" });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "F01 unborn gives an empty complete page with the unborn head",
    ["shell-double"],
    () =>
      withService("t070-unborn", async (service) => {
        const built = buildF01(gitPath(), "t070-unborn", "empty");
        const response = await history(service, repoOf(built));
        expect(response.state).toBe("succeeded");
        expect({ rows: response.result!.rows, boundaries: response.result!.boundaries, head: response.result!.head, completeness: response.result!.completeness.state }).toEqual({
          rows: [],
          boundaries: { page: [], shallow: [] },
          head: { state: "unborn", target: "refs/heads/main" },
          completeness: "complete",
        });
      }),
    TIMEOUT_MS,
  );
});

describe("committer and message body (contract §3 \"HistoryPage result\", §5 \"History message body\")", () => {
  const ROW_TASK = "T341";

  // A commit on top of the F19 linear tip, from the raw object text. Returns the repository and the new commit ID.
  function oneCommit(name: string, text: (tree: string, parent: string) => Buffer): { repo: string; oid: string } {
    const built = buildF19(gitPath(), name, "linear");
    const repo = repoOf(built);
    const tip = built.facts.notes.tip as string;
    const tree = git(repo, ["rev-parse", `${tip}^{tree}`]).toString("utf8").trim();
    const oid = git(repo, ["hash-object", "-t", "commit", "-w", "--stdin"], text(tree, tip)).toString("utf8").trim();
    git(repo, ["update-ref", "refs/heads/main", oid, tip]);
    return { repo, oid };
  }

  test("the contract §5 body bound is 16 KiB", () => {
    expect(HISTORY_BODY_BYTES).toBe(16 * 1024);
  });

  caseTest(
    ROW_TASK,
    "a committer other than the author gives its own name, email, and time, and the body is the message after the subject paragraph",
    ["shell-double"],
    () =>
      withService("t341-committer", async (service) => {
        const author = `${FIXED_IDENTITY.name} <${FIXED_IDENTITY.email}> 1767225604 +0000`;
        const committer = "Commit Ter <commit.ter@arbareto.invalid> 1767229204 +0100";
        // Git `pretty.c` `format_subject`: the subject ends at the first blank line. `skip_blank_lines` then skips the blank lines before the body.
        const message = "first line\nsecond line\n\n  \n\nbody line 1\n\nbody line 2\n";
        const { repo, oid } = oneCommit("t341-committer", (tree, parent) =>
          Buffer.from(`tree ${tree}\nparent ${parent}\nauthor ${author}\ncommitter ${committer}\n\n${message}`, "utf8"),
        );
        const row = (await history(service, repo)).result!.rows[0]!;
        expect(row).toEqual(oracleRows(repo, oid)[0]!);
        expect({ oid: row.oid, subject: row.subject, committer: row.committer, committerDate: row.committerDate, body: row.body, bodyCut: row.bodyCut, date: row.date }).toEqual({
          oid,
          subject: "first line second line",
          committer: { name: "Commit Ter", email: "commit.ter@arbareto.invalid" },
          committerDate: 1767229204,
          body: "body line 1\n\nbody line 2\n",
          bodyCut: false,
          date: 1767225604,
        });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    ROW_TASK,
    "a 20 KiB body gives at most 16 KiB that ends at a UTF-8 character boundary with bodyCut true, and the read starts no added Git process",
    ["shell-double"],
    () =>
      withService("t341-body-cut", async (service) => {
        const ident = `${FIXED_IDENTITY.name} <${FIXED_IDENTITY.email}> 1767225604 +0000`;
        // U+20AC takes 3 bytes, and 16,384 is not a multiple of 3. So the bound falls inside a character.
        const body = "€".repeat(Math.ceil((20 * 1024) / 3));
        const { repo, oid } = oneCommit("t341-body-cut", (tree, parent) => Buffer.from(`tree ${tree}\nparent ${parent}\nauthor ${ident}\ncommitter ${ident}\n\nlong body\n\n${body}`, "utf8"));
        const { repositoryId, generation } = await service.register(repo);
        const first = service.runner.calls.length;
        const response = await service.readHistory(repositoryId, generation);
        expect({ state: response.state, code: response.code }).toEqual({ state: "succeeded", code: undefined });
        const row = response.result!.rows[0]!;
        expect(row.oid).toBe(oid);
        const bytes = Buffer.byteLength(row.body);
        expect(bytes).toBeLessThanOrEqual(HISTORY_BODY_BYTES);
        expect(bytes).toBe(HISTORY_BODY_BYTES - (HISTORY_BODY_BYTES % 3));
        expect(body.startsWith(row.body)).toBe(true);
        expect(row.bodyCut).toBe(true);
        expect(row.invalidUtf8).toBe(false);
        expect(row).toEqual(oracleRows(repo, oid)[0]!);
        // Contract §3: the fields come from the `cat-file --batch-command -Z` object. The read runs only its listing and its held steps, each once.
        const expected = [configListArgs(), hooksPathArgs(), headTargetArgs(), headOidArgs(), shallowPathArgs(), revListArgs(oid, "sha1"), batchCommandArgs()].map((a) => a.join(" "));
        const ran = service.runner.calls.slice(first).filter((c) => c.refused === undefined).map((c) => c.arguments.join(" "));
        expect(ran.toSorted()).toEqual(expected.toSorted());
      }),
    TIMEOUT_MS,
  );

  caseTest(
    ROW_TASK,
    "bytes that are not valid UTF-8 in only the committer name, the committer email, or the body give invalidUtf8 and replacement characters",
    ["shell-double"],
    () =>
      withService("t341-invalid-utf8", async (service) => {
        const built = buildF19(gitPath(), "t341-invalid-utf8", "linear");
        const repo = repoOf(built);
        const tip = built.facts.notes.tip as string;
        const tree = git(repo, ["rev-parse", `${tip}^{tree}`]).toString("utf8").trim();
        const ident = (name: string, email: string) => `${name} <${email}> 1767225604 +0000`;
        const valid = ident(FIXED_IDENTITY.name, FIXED_IDENTITY.email);
        // Each commit holds one ISO-8859-1 byte in one field. No commit has an encoding header.
        const shapes: [committer: string, message: string][] = [
          [ident("Jos\xe9", FIXED_IDENTITY.email), "name\n"],
          [ident(FIXED_IDENTITY.name, "jos\xe9@arbareto.invalid"), "email\n"],
          [valid, "body\n\nCaf\xe9\n"],
        ];
        let parent = tip;
        const oids: string[] = [];
        for (const [committer, message] of shapes) {
          const raw = Buffer.from(`tree ${tree}\nparent ${parent}\nauthor ${valid}\ncommitter ${committer}\n\n${message}`, "latin1");
          parent = git(repo, ["hash-object", "-t", "commit", "-w", "--stdin"], raw).toString("utf8").trim();
          oids.unshift(parent);
        }
        git(repo, ["update-ref", "refs/heads/main", parent, tip]);
        const rows = (await history(service, repo)).result!.rows.slice(0, 3);
        expect(rows.map((r) => ({ oid: r.oid, invalidUtf8: r.invalidUtf8, committer: r.committer, body: r.body }))).toEqual([
          { oid: oids[0]!, invalidUtf8: true, committer: FIXED_IDENTITY, body: "Caf�\n" },
          { oid: oids[1]!, invalidUtf8: true, committer: { name: FIXED_IDENTITY.name, email: "jos�@arbareto.invalid" }, body: "" },
          { oid: oids[2]!, invalidUtf8: true, committer: { name: "Jos�", email: FIXED_IDENTITY.email }, body: "" },
        ]);
        expect(rows).toEqual(oracleRows(repo, parent).slice(0, 3));
      }),
    TIMEOUT_MS,
  );
});

describe("F16 history bounds (contract §5)", () => {
  // Each F16 history variant with its reached bound, or null at the bound.
  const CASES: [F16HistoryVariant, keyof typeof LIMITS | null][] = [
    ["parents-64", null],
    ["parents-65", limitName("HISTORY_PARENTS_PER_COMMIT")],
    ["parent-refs", limitName("HISTORY_PARENTS_PER_PAGE")],
    ["object-at-limit", null],
    ["object-over-limit", limitName("HISTORY_COMMIT_OBJECT_BYTES")],
    // The traversal stream holds object IDs only, so 100 commits stay below HISTORY_STREAM_BYTES, as in T286.
    ["traversal", null],
  ];

  for (const [variant, reason] of CASES) {
    caseTest(
      TASK,
      reason === null ? `F16 ${variant}: a page at the bound is complete` : `F16 ${variant}: the bound gives limited with reason ${reason}, never a truncated complete page`,
      ["shell-double"],
      () =>
        withService(`t070-f16-${variant}`, async (service) => {
          const built = cachedF16History(gitPath(), `t070-f16-${variant}`, variant).built;
          const repo = repoOf(built);
          const tip = (built.facts.notes.commits as Record<string, string>).tip!;
          const expected = oracleRows(repo, tip);
          if (variant === "object-at-limit" || variant === "object-over-limit") {
            expect(F16_OBJECT_LIMIT).toBe(LIMITS.HISTORY_COMMIT_OBJECT_BYTES);
            expect(Number(git(repo, ["cat-file", "-s", tip]).toString().trim())).toBe(built.facts.notes.objectBytes as number);
          }
          const response = await history(service, repo);
          const page = response.result!;
          if (reason === null) {
            expect({ state: response.state, completeness: page.completeness.state }).toEqual({ state: "succeeded", completeness: "complete" });
            expect(page.rows).toEqual(expected);
            return;
          }
          expect({ state: response.state, code: response.code }).toEqual({ state: "limited", code: "OUTPUT_LIMIT" });
          expect(page.completeness).toMatchObject({ state: "limited", reason });
          // Bounded data stays a prefix of the Git traversal.
          expect(page.rows.length).toBeLessThan(expected.length);
          expect(page.rows).toEqual(expected.slice(0, page.rows.length));
        }),
      TIMEOUT_MS,
    );
  }

  // Contract §5 "History page": the page keeps the rows before the first row that passes the 8 MiB encoded result bound.
  caseTest(
    TASK,
    "History page: F16 page-bytes gives limited with reason HISTORY_PAGE_BYTES, its rows are a prefix of the oracle, and its encoded result is at most 8 MiB",
    ["shell-double"],
    () =>
      withService("t070-f16-page-bytes", async (service) => {
        const built = cachedF16History(gitPath(), "t070-f16-page-bytes", "page-bytes").built;
        const repo = repoOf(built);
        const tip = (built.facts.notes.commits as Record<string, string>).tip!;
        const expected = oracleRows(repo, tip);
        expect(expected.length).toBe(10);
        const response = await history(service, repo);
        const page = response.result!;
        expect({ state: response.state, code: response.code }).toEqual({ state: "limited", code: "OUTPUT_LIMIT" });
        expect(page.completeness).toMatchObject({ state: "limited", reason: limitName("HISTORY_PAGE_BYTES") });
        // JSON escapes each 0x01 byte as 6 bytes, so one row holds about 1.2 MB and the bound keeps at least one row.
        expect(page.rows.length).toBeGreaterThan(0);
        expect(page.rows.length).toBeLessThan(expected.length);
        expect(page.rows).toEqual(expected.slice(0, page.rows.length));
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(LIMITS.HISTORY_PAGE_BYTES);
      }),
    TIMEOUT_MS,
  );

  // Contract §5: the first reached bound wins. The page bound still cuts the rows.
  caseTest(
    TASK,
    "F16 page-bytes with a shallow file above its bound keeps reason SHALLOW_METADATA_BYTES, and the page bound still cuts the rows to at most 8 MiB",
    ["shell-double"],
    () =>
      withService("t070-f16-first-bound", async (service) => {
        const built = cachedF16History(gitPath(), "t070-f16-first-bound", "page-bytes").built;
        const repo = repoOf(built);
        const tip = (built.facts.notes.commits as Record<string, string>).tip!;
        const expected = oracleRows(repo, tip);
        const shallow = join(repo, git(repo, ["rev-parse", "--git-path", "shallow"]).toString().trim());
        // Valid object ID lines that name no commit of the fixture. Git keeps them as grafts, so the traversal stays the same.
        const line = (i: number) => `${new Bun.CryptoHasher("sha1").update(`t070-first-bound-${i}`).digest("hex")}\n`;
        appendFileSync(shallow, Array.from({ length: Math.ceil((LIMITS.SHALLOW_METADATA_BYTES + 1) / line(0).length) }, (_, i) => line(i)).join(""));
        const response = await history(service, repo);
        const page = response.result!;
        expect({ state: response.state, code: response.code }).toEqual({ state: "limited", code: "OUTPUT_LIMIT" });
        expect(page.completeness).toMatchObject({ state: "limited", reason: limitName("SHALLOW_METADATA_BYTES") });
        // Without the full shallow list, the root row is unknown, so at most 9 rows remain. Their encoded bytes pass the page bound.
        expect(Buffer.byteLength(JSON.stringify(expected.slice(0, 9)))).toBeGreaterThan(LIMITS.HISTORY_PAGE_BYTES);
        expect(page.rows.length).toBeGreaterThan(0);
        expect(page.rows).toEqual(expected.slice(0, page.rows.length));
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(LIMITS.HISTORY_PAGE_BYTES);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    `a shallow file above ${LIMITS.SHALLOW_METADATA_BYTES} bytes gives limited with reason SHALLOW_METADATA_BYTES`,
    ["shell-double"],
    () =>
      withService("t070-shallow-limit", async (service) => {
        const built = buildF19(gitPath(), "t070-shallow-limit", "shallow");
        const repo = repoOf(built);
        const shallow = join(repo, git(repo, ["rev-parse", "--git-path", "shallow"]).toString().trim());
        // Valid object ID lines. Git keeps an unknown shallow ID as a graft, so the file stays readable.
        const line = (i: number) => `${new Bun.CryptoHasher("sha1").update(`t070-${i}`).digest("hex")}\n`;
        const missing = LIMITS.SHALLOW_METADATA_BYTES + 1 - statSync(shallow).size;
        appendFileSync(shallow, Array.from({ length: Math.ceil(missing / line(0).length) }, (_, i) => line(i)).join(""));
        expect(statSync(shallow).size).toBeGreaterThan(LIMITS.SHALLOW_METADATA_BYTES);
        const response = await history(service, repo);
        expect({ state: response.state, code: response.code }).toEqual({ state: "limited", code: "OUTPUT_LIMIT" });
        expect(response.result!.completeness).toMatchObject({ state: "limited", reason: limitName("SHALLOW_METADATA_BYTES") });
      }),
    TIMEOUT_MS,
  );
});

describe("missing objects (contract §7 \"Missing objects\")", () => {
  caseTest(
    TASK,
    "F17 partial clone: a missing commit gives limited with OBJECT_MISSING, git cat-file -e still fails, and the uploadpack canary never runs",
    ["shell-double"],
    () =>
      withService("t070-partial", async (service) => {
        const built = buildF17(gitPath(), "t070-partial", "partial-read-tree");
        const source = join(built.root, "source");
        const clone = join(built.root, "clone");
        // A source commit that the clone never fetched. The new clone tip names it as its parent.
        git(source, ["commit", "-q", "--allow-empty", "--no-verify", "-m", "unfetched"]);
        const missing = git(source, ["rev-parse", "HEAD"]).toString().trim();
        const tree = git(clone, ["rev-parse", "HEAD^{tree}"]).toString().trim();
        const ident = `${FIXED_IDENTITY.name} <${FIXED_IDENTITY.email}> 1767225600 +0000`;
        const tip = git(clone, ["hash-object", "-t", "commit", "-w", "--stdin"], `tree ${tree}\nparent ${missing}\nauthor ${ident}\ncommitter ${ident}\n\nmissing parent\n`).toString().trim();
        git(clone, ["update-ref", "refs/heads/main", tip]);
        const catFile = () => Bun.spawnSync([gitPath(), "--no-lazy-fetch", "cat-file", "-e", missing], { cwd: clone, env: fixtureEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" }).exitCode;
        expect(catFile()).not.toBe(0);
        const response = await history(service, clone);
        expect({ state: response.state, code: response.code }).toEqual({ state: "limited", code: "OBJECT_MISSING" });
        expect(response.result?.completeness).toMatchObject({ state: "limited", code: "OBJECT_MISSING" });
        expect(catFile()).not.toBe(0);
        expect(existsSync(join(built.root, built.facts.canaries.uploadpack!))).toBe(false);
        // Contract §7: only the `gitProbe` probes run without `--no-lazy-fetch`.
        for (const call of service.runner.calls.filter((c) => c.contextKind !== "gitProbe")) expect(call.arguments[0]).toBe("--no-lazy-fetch");
      }),
    TIMEOUT_MS,
  );
});

// Bounded poll of the shell double's call list.
async function waitFor(what: string, found: () => boolean): Promise<void> {
  const until = performance.now() + WAIT_MS;
  while (!found()) {
    if (performance.now() > until) throw new Error(`${what}: not seen within ${WAIT_MS} ms`);
    await Bun.sleep(10);
  }
}

const isStatus = (call: { arguments: readonly string[] }) => call.arguments.includes("status");
const isRevList = (call: { arguments: readonly string[] }) => call.arguments.includes("rev-list");
const isConfigList = (call: { arguments: readonly string[] }) => call.arguments.join("\0") === configListArgs().join("\0");

describe("history without a status snapshot (contract §3 readHistory)", () => {
  caseTest(
    TASK,
    "right after registration, readHistory returns the page with the registration generation, and the runner sees no status call",
    ["shell-double"],
    () =>
      withService("t070-no-status", async (service) => {
        const built = buildF19(gitPath(), "t070-no-status", "linear");
        const { repositoryId, generation } = await service.register(repoOf(built));
        const response = await service.readHistory(repositoryId, generation);
        expect(response.state).toBe("succeeded");
        expect(response.result!.generation).toBe(generation);
        expect(service.runner.calls.filter(isStatus)).toEqual([]);
        expect(service.runner.calls.filter(isRevList).length).toBe(1);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    `readHistory runs beside a held readWorkspace within the ${LIMITS.CONCURRENT_READS_PER_WORKSPACE}-read cap`,
    ["shell-double"],
    () =>
      withService("t070-beside", async (service) => {
        const built = buildF19(gitPath(), "t070-beside", "linear");
        const { repositoryId, generation } = await service.register(repoOf(built));
        const release = service.runner.holdStart(once(isStatus));
        try {
          const workspace = service.send("readWorkspace", { refresh: false, check: "full" }, { repositoryId });
          await waitFor("status call", () => service.runner.calls.some(isStatus));
          const page = await service.readHistory(repositoryId, generation);
          expect(page.state).toBe("succeeded");
          expect(service.responseAt.has(workspace)).toBe(false);
          release();
          expect((await service.response(workspace)).state).toBe("succeeded");
        } finally {
          release();
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "the page binds the captured HEAD OID and target",
    ["shell-double"],
    () =>
      withService("t070-head", async (service) => {
        const built = buildF19(gitPath(), "t070-head", "linear");
        const repo = repoOf(built);
        const { repositoryId, generation } = await service.register(repo);
        const first = (await service.readHistory(repositoryId, generation)).result!;
        expect(first.head).toEqual({ state: "branch", target: "refs/heads/main", oid: built.facts.notes.tip as string });
        expect(first.shallowFingerprint).toBeNull();
        git(repo, ["commit", "-q", "--allow-empty", "--no-verify", "-m", "next"]);
        const next = refState(gitPath(), repo).headOid!;
        const second = (await service.readHistory(repositoryId, generation)).result!;
        expect({ head: second.head, first: second.rows[0]?.oid }).toEqual({ head: { state: "branch", target: "refs/heads/main", oid: next }, first: next });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "the page binds the shallow fingerprint, and a shallow file change gives another fingerprint",
    ["shell-double"],
    () =>
      withService("t070-shallow-fingerprint", async (service) => {
        const built = buildF19(gitPath(), "t070-shallow-fingerprint", "shallow");
        const repo = repoOf(built);
        const { repositoryId, generation } = await service.register(repo);
        const first = (await service.readHistory(repositoryId, generation)).result!;
        expect(first.shallowFingerprint).toBeString();
        const shallow = join(repo, git(repo, ["rev-parse", "--git-path", "shallow"]).toString().trim());
        appendFileSync(shallow, `${new Bun.CryptoHasher("sha1").update("t070-graft").digest("hex")}\n`);
        const second = (await service.readHistory(repositoryId, generation)).result!;
        expect(second.shallowFingerprint).toBeString();
        expect(second.shallowFingerprint).not.toBe(first.shallowFingerprint);
        expect(second.rows).toEqual(first.rows);
      }),
    TIMEOUT_MS,
  );
});

describe("trust gate (contract §7)", () => {
  caseTest(
    TASK,
    "an F17 copy without read approval gives TRUST_REQUIRED, the refused gate stops the held rev-list, no response holds a commit ID of the fixture, and no canary runs",
    ["shell-double"],
    () =>
      withService("t070-trust", async (service) => {
        const built = buildF17(gitPath(), "t070-trust", "trust");
        const repo = repoOf(built);
        const tip = refState(gitPath(), repo).headOid!;
        const commits = oracleTraversal(repo, tip).flatMap((row) => [row.oid, ...row.parents]);
        expect(commits.length).toBeGreaterThan(0);
        const { repositoryId, generation } = await service.register(repo);
        // A real `rev-list` writes less than one pipe buffer, so it can exit before the gate decides. The double sends the real Git bytes as the `rev-list` output.
        const traversal = git(repo, ["--no-optional-locks", "rev-list", "--parents", "--max-count=100", "--date-order", tip]);
        service.runner.inject.stdout = (call) => (isRevList(call) ? traversal : undefined);
        // The listing waits until `rev-list` starts. The injected `rev-list` waits at its stdout barrier. So only the refused gate can end `rev-list`.
        const releaseListing = service.runner.pauseStdout(once(isConfigList));
        const releaseRevList = service.runner.pauseStdout(once(isRevList));
        try {
          const request = service.send("readHistory", {}, { repositoryId, repositoryGeneration: generation });
          await waitFor("rev-list call", () => service.runner.calls.some(isRevList));
          releaseListing();
          const response = await service.response(request);
          // Contract §9 fixes the code. The read starts its trust listing first, so the terminal state is not fixed as `rejected`.
          expect({ code: response.code, succeeded: response.state === "succeeded" }).toEqual({ code: "TRUST_REQUIRED", succeeded: false });
          // Contract §7 "Held history steps": the refused gate ends every held step. The recorded `rev-list` ended without an exit status.
          expect(service.runner.calls.filter(isRevList).map((c) => c.exit?.exitCode)).toEqual([null]);
          expect(service.runner.calls.filter((c) => c.arguments.includes("cat-file"))).toEqual([]);
        } finally {
          releaseListing();
          releaseRevList();
        }
        // Contract §7 "Held history steps": the history steps can run beside the listing, but no held row reaches a response.
        const text = JSON.stringify(service.responses);
        expect(commits.filter((oid) => text.includes(oid))).toEqual([]);
        const logs = Object.values(built.facts.canaries).map((log) => join(built.root, log));
        expect(logs.filter((log) => existsSync(log))).toEqual([]);
      }),
    TIMEOUT_MS,
  );
});

// Hand-made commits with fixed author and committer times, so `rev-list --date-order` lists them in a known order.
// R <- H1 <- H2 <- H3 <- M and R <- S <- M. S is older than H2, so the date order is M, H3, H2, S, H1, R.
function handHistory(name: string): { repo: string; oids: Record<"R" | "H1" | "H2" | "S" | "H3" | "M", string>; loose: (oid: string) => string } {
  const repo = fixtureDir(`${name}/repo`);
  git(repo, ["init", "-q", "-b", "main"]);
  const tree = git(repo, ["hash-object", "-t", "tree", "-w", "--stdin"], "").toString().trim();
  const commit = (time: number, parents: string[], message: string) => {
    const ident = `${FIXED_IDENTITY.name} <${FIXED_IDENTITY.email}> ${time} +0000`;
    const text = `tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join("")}author ${ident}\ncommitter ${ident}\n\n${message}\n`;
    return git(repo, ["hash-object", "-t", "commit", "-w", "--stdin"], text).toString().trim();
  };
  const R = commit(1_767_225_600, [], "R");
  const H1 = commit(1_767_225_700, [R], "H1");
  const H2 = commit(1_767_225_900, [H1], "H2");
  const S = commit(1_767_225_800, [R], "S");
  const H3 = commit(1_767_226_000, [H2], "H3");
  const M = commit(1_767_226_100, [H3, S], "M");
  git(repo, ["update-ref", "refs/heads/main", M]);
  const loose = (oid: string) => join(repo, ".git", "objects", oid.slice(0, 2), oid.slice(2));
  return { repo, oids: { R, H1, H2, S, H3, M }, loose };
}

// Flips the last byte of a loose object, the zlib check value. `cat-file --batch-check` still reads the header. A full read dies (research probe D16).
function corrupt(path: string): void {
  chmodSync(path, 0o644);
  const bytes = readFileSync(path);
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
  writeFileSync(path, bytes);
}

const isBatchCommand = (call: { arguments: readonly string[] }) => call.arguments.includes("--batch-command");

describe("failed history steps (contract §7 \"Missing objects\")", () => {
  // D33: the shell identity of the origin file decides that `extensions.partialclone` comes from `<commondir>/config`, never the path text.
  caseTest(
    TASK,
    "a repository with only extensions.partialclone, whose listing spells the common config through a junction alias, gives limited with OBJECT_MISSING for a missing parent",
    ["shell-double"],
    () =>
      withService("t070-promisor-alias", async (service) => {
        const { repo, oids, loose } = handHistory("t070-promisor-alias");
        git(repo, ["config", "core.repositoryformatversion", "1"]);
        git(repo, ["config", "extensions.partialclone", "origin"]);
        rmSync(loose(oids.H3), { force: true });
        const alias = join(repo, "..", "alias");
        symlinkSync(repo, alias, "junction");
        const spelled = `file:${join(alias, ".git", "config").replaceAll("\\", "/")}`;
        expect(spelled.toLowerCase()).not.toBe(`file:${join(repo, ".git", "config").replaceAll("\\", "/").toLowerCase()}`);
        // The listing as Git prints it, with the local origin spelled through the alias. Only the origin text differs.
        const listing = Buffer.from(ownedGit(gitPath(), FIXTURE_ROOT, repo, configListArgs()).toString("utf8").replaceAll("\0file:.git/config\0", `\0${spelled}\0`));
        expect(listing.includes(Buffer.from(`\0${spelled}\0extensions.partialclone\norigin\0`))).toBe(true);
        service.runner.inject.stdout = (call) => (isConfigList(call) ? listing : undefined);
        const response = await history(service, repo);
        expect({ state: response.state, code: response.code }).toEqual({ state: "limited", code: "OBJECT_MISSING" });
      }),
    TIMEOUT_MS,
  );

  // Contract §7: raw parents of a commit that the shallow file lists are no check input. Here only such a parent is missing.
  caseTest(
    TASK,
    "a shallow commit with a missing raw parent and a failed cat-file --batch-command give GIT_FAILED, not a damaged store",
    ["shell-double"],
    () =>
      withService("t070-shallow-cat-file", async (service) => {
        const { repo, oids, loose } = handHistory("t070-shallow-cat-file");
        writeFileSync(join(repo, ".git", "shallow"), `${oids.H2}\n`);
        rmSync(loose(oids.H1), { force: true });
        expect(oracleTraversal(repo, oids.M).map((row) => row.oid)).toEqual([oids.M, oids.H3, oids.H2, oids.S, oids.R]);
        const { repositoryId, generation } = await service.register(repo);
        const release = service.runner.holdStart(once(isBatchCommand));
        try {
          const request = service.send("readHistory", {}, { repositoryId, repositoryGeneration: generation });
          await waitFor("cat-file --batch-command call", () => service.runner.calls.some(isBatchCommand));
          corrupt(loose(oids.S));
          release();
          const response = await service.response(request);
          expect({ state: response.state, code: response.code }).toEqual({ state: "failed", code: "GIT_FAILED" });
          expect(service.runner.calls.filter(isBatchCommand).map((c) => c.exit?.exitCode)).toEqual([128]);
        } finally {
          release();
        }
      }),
    TIMEOUT_MS,
  );

  // Data-model §2 `unavailable`: the last read got REPOSITORY_UNAVAILABLE. A later complete `readWorkspace` resets the mark, so the case observes the history reader call alone.
  caseTest(
    TASK,
    "a commit object that disappears before cat-file --batch-command, without a promisor remote, ends REPOSITORY_UNAVAILABLE, and the history reader marks the workspace state unavailable",
    ["shell-double"],
    () =>
      withService("t070-damaged-store", async (service) => {
        const { repo, oids, loose } = handHistory("t070-damaged-store");
        const signal = new AbortController().signal;
        const probed = await probeGit(service.runner, { bootstrapId: service.runner.addContext("gitProbe", gitPath()), executablePath: gitPath() });
        if (!("installation" in probed)) throw new Error(`probe failed: ${JSON.stringify(probed)}`);
        const registrations = createRegistrations({ runner: service.runner, unfinishedMutation: () => false });
        const registered = await registrations.register({ operationId: crypto.randomUUID(), bootstrapId: service.runner.addContext("repositoryDiscovery", repo), installation: probed.installation, signal });
        if (!registered.ok || !("repositoryId" in registered.result)) throw new Error(`registration failed: ${JSON.stringify(registered)}`);
        const workspace = registrations.get(registered.result.repositoryId)!;
        const trust = createTrust({ runner: service.runner, environment: serviceEnv() });
        const reader = createWorkspaceReader({ runner: service.runner, trust });
        const marked: string[] = [];
        const reads = createHistoryReader({ runner: service.runner, trust, listingTuple: reader.listingTuple, markUnavailable: (id) => void marked.push(id) });
        const release = service.runner.holdStart(once(isBatchCommand));
        try {
          const outcome = reads.readHistory({ operationId: crypto.randomUUID(), signal, installation: probed.installation, workspace, generation: workspace.generation });
          await waitFor("cat-file --batch-command call", () => service.runner.calls.some(isBatchCommand));
          rmSync(loose(oids.H1), { force: true });
          release();
          expect(await outcome).toEqual({ result: "failed", code: "REPOSITORY_UNAVAILABLE", value: { completeness: { state: "failed", code: "REPOSITORY_UNAVAILABLE" }, remedy: { text: DAMAGED_STORE_REMEDY } } });
          expect(marked).toEqual([workspace.repositoryId]);
        } finally {
          release();
        }
      }),
    TIMEOUT_MS,
  );
});

describe("shallow file change during a read (contract §8 \"Changing working file\")", () => {
  const shallowOf = (repo: string) => join(repo, git(repo, ["rev-parse", "--git-path", "shallow"]).toString().trim());
  const graft = (repo: string, label: string) => appendFileSync(shallowOf(repo), `${new Bun.CryptoHasher("sha1").update(label).digest("hex")}\n`);

  caseTest(
    TASK,
    "one shallow file change during readHistory discards the attempt, the held steps run once more, and the page binds the new fingerprint and the request generation",
    ["shell-double"],
    () =>
      withService("t070-shallow-restart", async (service) => {
        const repo = repoOf(buildF19(gitPath(), "t070-shallow-restart", "shallow"));
        const { repositoryId, generation } = await service.register(repo);
        const release = service.runner.pauseStdout(once(isRevList));
        try {
          const request = service.send("readHistory", {}, { repositoryId, repositoryGeneration: generation });
          await waitFor("rev-list call", () => service.runner.calls.some(isRevList));
          graft(repo, "t070-restart");
          release();
          const response = await service.response<HistoryResult>(request);
          expect({ state: response.state, code: response.code, generation: response.result?.generation }).toEqual({ state: "succeeded", code: undefined, generation });
          expect(response.result!.shallowFingerprint).toBe(new Bun.CryptoHasher("sha256").update(readFileSync(shallowOf(repo))).digest("hex"));
          expect(service.runner.calls.filter(isRevList)).toHaveLength(2);
        } finally {
          release();
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a second shallow file change ends readHistory limited with WORKTREE_CHANGING, never REPOSITORY_CHANGED",
    ["shell-double"],
    () =>
      withService("t070-shallow-changing", async (service) => {
        const repo = repoOf(buildF19(gitPath(), "t070-shallow-changing", "shallow"));
        const { repositoryId, generation } = await service.register(repo);
        // Each barrier holds one `rev-list` call in start order. `once` would take the first call again after the first barrier opens.
        const nth = (index: number) => {
          const seen: object[] = [];
          return (call: { arguments: readonly string[] }) => {
            if (!isRevList(call)) return false;
            if (!seen.includes(call)) seen.push(call);
            return seen.indexOf(call) === index;
          };
        };
        const releaseFirst = service.runner.pauseStdout(nth(0));
        const releaseSecond = service.runner.pauseStdout(nth(1));
        try {
          const request = service.send("readHistory", {}, { repositoryId, repositoryGeneration: generation });
          for (const [i, release] of [releaseFirst, releaseSecond].entries()) {
            await waitFor(`rev-list call ${i + 1}`, () => service.runner.calls.filter(isRevList).length > i);
            graft(repo, `t070-changing-${i}`);
            release();
          }
          const response = await service.response<HistoryResult>(request);
          expect({ state: response.state, code: response.code }).toEqual({ state: "limited", code: "WORKTREE_CHANGING" });
          expect(response.result!.completeness).toEqual({ state: "limited", code: "WORKTREE_CHANGING" });
        } finally {
          releaseFirst();
          releaseSecond();
        }
      }),
    TIMEOUT_MS,
  );
});
