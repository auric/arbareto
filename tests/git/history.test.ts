// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T070, T322, T336, and T341: the feature 001 history rules on the feature 002 operations (feature 002 tasks.md T049, plan.md P7).
// A case keeps its 001 assertion where feature 002 keeps the rule. Feature 002 replaces the 100-row page, its boundaries, and its page bounds.

import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HISTORY_BODY_BYTES } from "../../src/contracts/envelope";
import * as LIMITS from "../../src/contracts/limits";
import { batchCommandArgs, configListArgs, historyRefsArgs } from "../../src/git-service/commands";
import { probeGit } from "../../src/git-service/git-installation";
import { DAMAGED_STORE_REMEDY } from "../../src/git-service/history";
import { createHistoryViews } from "../../src/git-service/history-view";
import { createSessionLog } from "../../src/git-service/log";
import { createOperationRegistry } from "../../src/git-service/operations";
import { createRegistrations } from "../../src/git-service/registration";
import { createWorkspaceReader } from "../../src/git-service/status";
import { createTrust } from "../../src/git-service/trust";
import { printOrigin } from "../origin";
import { FIXED_IDENTITY, FIXTURE_ROOT, fixtureDir, fixtureEnv, ownedGit, serviceEnv, useFixtureRoot } from "./fixture-root";
import { cachedF16History } from "../windows/fixture-cache";
import { buildF01, buildF17, buildF19, F16_OBJECT_LIMIT, type Built, type F16HistoryVariant, type F19Variant } from "./fixtures";
import { GIT } from "./git-binary";
import { refState } from "./git-oracle";
import { isLoad, isTextRead, load, openView, rows, type Loaded, type Opened, type ViewRow } from "./history-view-harness";
import { caseTest, once, openService, type Service, type ServiceResponse } from "./service-harness";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/git-service/history.ts", import.meta.dir);
printOrigin("../../src/git-service/history-view.ts", import.meta.dir);

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

// The 001 scope: a current-checkout view, loaded to the end.
interface Checkout {
  repositoryId: string;
  generation: number;
  opened: ServiceResponse<Opened>;
  loaded: ServiceResponse<Loaded> | null;
}
async function checkout(service: Service, repo: string): Promise<Checkout> {
  const { repositoryId, generation } = await service.register(repo);
  const opened = await openView(service, repositoryId, generation, "current");
  const loaded = opened.state === "succeeded" ? await load(service, repositoryId, opened.result!.viewId, { end: true }) : null;
  return { repositoryId, generation, opened, loaded };
}

// Every loaded row with `text: "rows"`, and with `text: "details"` when `details` is set.
async function textRows(service: Service, c: Checkout, details = false): Promise<ViewRow[]> {
  const viewId = c.opened.result!.viewId;
  const total = c.loaded!.result!.rows;
  const out: ViewRow[] = [];
  while (out.length < total) {
    const page = await rows(service, c.repositoryId, viewId, { row: out.length }, details ? 1 : 512, details ? "details" : "rows");
    expect({ state: page.state, target: page.result?.target, cut: page.result?.cut }).toEqual({ state: "succeeded", target: "found", cut: false });
    out.push(...page.result!.rows!);
  }
  return out;
}

const repoOf = (built: Built, repo = "repo") => join(built.root, repo);
const git = (repo: string, args: string[], input?: string | Buffer) =>
  ownedGit(gitPath(), FIXTURE_ROOT, repo, ["--no-lazy-fetch", ...args], input === undefined ? {} : { input: Buffer.from(input) });

// The 001 row fields. `shallow` is the 002 cell mark (data-model §4).
interface Row {
  oid: string;
  parents: string[];
  subject: string;
  author: { name: string; email: string };
  date: number;
  encoding: string | null;
  shallow: boolean;
  invalidUtf8: boolean;
  committer: { name: string; email: string };
  committerDate: number;
  body: string;
  bodyCut: boolean;
}
const rowOf = (r: ViewRow): Row => ({
  oid: r.oid,
  parents: r.parents,
  subject: r.subject!,
  author: r.author!,
  date: r.date!,
  encoding: r.encoding!,
  shallow: r.cell?.marks.includes("shallow") ?? false,
  invalidUtf8: r.invalidUtf8!,
  committer: r.committer!,
  committerDate: r.committerDate!,
  body: r.body!,
  bodyCut: r.bodyCut!,
});
type TextRow = Pick<Row, "oid" | "parents" | "subject" | "author" | "date" | "encoding" | "invalidUtf8">;
const textOf = (r: Pick<Row, keyof TextRow> | ViewRow): TextRow => ({ oid: r.oid, parents: r.parents, subject: r.subject!, author: r.author!, date: r.date!, encoding: r.encoding!, invalidUtf8: r.invalidUtf8! });

// Oracle: the exact Git traversal of the current checkout, as one uninterrupted run.
function oracleTraversal(repo: string, tip: string): { oid: string; parents: string[] }[] {
  const out = git(repo, ["--no-optional-locks", "rev-list", "--parents", "--date-order", tip]).toString("utf8");
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

// The 001 row fields from the raw object. Invalid UTF-8 decodes to U+FFFD. The subject is Git's first paragraph joined by spaces.
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

const HEX = { sha1: /^[0-9a-f]{40}$/, sha256: /^[0-9a-f]{64}$/ };

describe("F19 history shapes (001 contract §3 \"HistoryPage result\" rows on readHistoryRows)", () => {
  const VARIANTS: F19Variant[] = ["linear", "merge", "octopus", "skewed", "roots", "long", "wide", "encoding", "shallow", "sha256"];

  for (const variant of VARIANTS) {
    caseTest(
      TASK,
      `F19 ${variant}: rows equal git rev-list --parents --date-order <OID>, with full row fields and the shallow mark`,
      ["shell-double"],
      () =>
        withService(`t070-f19-${variant}`, async (service) => {
          const built = buildF19(gitPath(), `t070-f19-${variant}`, variant);
          const repo = repoOf(built);
          const tip = built.facts.notes.tip as string;
          const c = await checkout(service, repo);
          expect({ state: c.loaded!.state, code: c.loaded!.code, complete: c.loaded!.result!.complete }).toEqual({ state: "succeeded", code: undefined, complete: true });
          const expected = oracleRows(repo, tip);
          const found = (await textRows(service, c, true)).map(rowOf);
          expect(c.opened.result!.scope).toBe("current");
          expect(found).toEqual(expected);
          const format = variant === "sha256" ? "sha256" : "sha1";
          for (const row of found) for (const oid of [row.oid, ...row.parents]) expect(oid).toMatch(HEX[format]);
          expect(c.opened.result!.head).toEqual({ state: "branch", target: "refs/heads/main", oid: tip });

          const shallowCommits = (built.facts.notes.shallow as string[] | undefined) ?? [];
          if (variant === "shallow") {
            // The shallow commit stays a row with no effective parent, and its mark keeps it from reading as a root.
            const boundaryRow = found.find((r) => r.oid === shallowCommits[0]);
            expect(boundaryRow?.parents).toEqual([]);
          }
          // T336: only a commit that the shallow file lists is shallow. A root is never shallow.
          expect(found.filter((r) => r.shallow).map((r) => r.oid)).toEqual(shallowCommits);
          if (variant === "roots") expect(found.filter((r) => r.parents.length === 0).length).toBe(2);
          // T336: only the legacy commit holds bytes that are not valid UTF-8.
          expect(found.filter((r) => r.invalidUtf8).map((r) => r.oid)).toEqual(variant === "encoding" ? [tip] : []);
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
        const found = await textRows(service, await checkout(service, repoOf(built)));
        const legacy = found[0]!;
        expect(legacy.oid).toBe(built.facts.notes.tip as string);
        expect({ subject: legacy.subject, author: legacy.author!.name, encoding: legacy.encoding }).toEqual({
          subject: "Caf� r�sum�",
          author: "Jos�",
          encoding: "ISO-8859-1",
        });
        for (const row of found.slice(1)) expect(row.encoding).toBeNull();
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
        const found = (await textRows(service, await checkout(service, repo))).slice(0, 4);
        expect(found.map((r) => ({ oid: r.oid, encoding: r.encoding, invalidUtf8: r.invalidUtf8 }))).toEqual([
          { oid: oids[0]!, encoding: null, invalidUtf8: false },
          { oid: oids[1]!, encoding: null, invalidUtf8: true },
          { oid: oids[2]!, encoding: null, invalidUtf8: true },
          { oid: oids[3]!, encoding: null, invalidUtf8: true },
        ]);
        expect(found.map(textOf)).toEqual(oracleRows(repo, parent).slice(0, 4).map(textOf));
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
        const row = (await textRows(service, await checkout(service, repo)))[0]!;
        expect({ oid: row.oid, encoding: row.encoding }).toEqual({ oid, encoding: "ISO-8859-1" });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "F01 unborn gives an empty complete view with the unborn head",
    ["shell-double"],
    () =>
      withService("t070-unborn", async (service) => {
        const built = buildF01(gitPath(), "t070-unborn", "empty");
        const c = await checkout(service, repoOf(built));
        expect(c.opened.state).toBe("succeeded");
        expect({ head: c.opened.result!.head, startCount: c.opened.result!.startCount, loaded: c.loaded!.result }).toEqual({
          head: { state: "unborn", target: "refs/heads/main" },
          startCount: 0,
          loaded: { rows: 0, complete: true },
        });
        expect((await rows(service, c.repositoryId, c.opened.result!.viewId, { row: 0 }, 1, "rows")).result).toMatchObject({ target: "none", rowCount: 0, complete: true });
      }),
    TIMEOUT_MS,
  );
});

describe("committer and message body (001 contract §3 \"HistoryPage result\", §5 \"History message body\")", () => {
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
        const c = await checkout(service, repo);
        const row = rowOf((await rows(service, c.repositoryId, c.opened.result!.viewId, { row: 0 }, 1, "details")).result!.rows![0]!);
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
    "a 20 KiB body gives at most 16 KiB that ends at a UTF-8 character boundary with bodyCut true, and the details read starts one cat-file --batch-command only",
    ["shell-double"],
    () =>
      withService("t341-body-cut", async (service) => {
        const ident = `${FIXED_IDENTITY.name} <${FIXED_IDENTITY.email}> 1767225604 +0000`;
        // U+20AC takes 3 bytes, and 16,384 is not a multiple of 3. So the bound falls inside a character.
        const body = "€".repeat(Math.ceil((20 * 1024) / 3));
        const { repo, oid } = oneCommit("t341-body-cut", (tree, parent) => Buffer.from(`tree ${tree}\nparent ${parent}\nauthor ${ident}\ncommitter ${ident}\n\nlong body\n\n${body}`, "utf8"));
        const c = await checkout(service, repo);
        const first = service.runner.calls.length;
        const response = await rows(service, c.repositoryId, c.opened.result!.viewId, { row: 0 }, 1, "details");
        expect({ state: response.state, code: response.code }).toEqual({ state: "succeeded", code: undefined });
        const row = rowOf(response.result!.rows![0]!);
        expect(row.oid).toBe(oid);
        const bytes = Buffer.byteLength(row.body);
        expect(bytes).toBeLessThanOrEqual(HISTORY_BODY_BYTES);
        expect(bytes).toBe(HISTORY_BODY_BYTES - (HISTORY_BODY_BYTES % 3));
        expect(body.startsWith(row.body)).toBe(true);
        expect(row.bodyCut).toBe(true);
        expect(row.invalidUtf8).toBe(false);
        expect(row).toEqual(oracleRows(repo, oid)[0]!);
        // Contract Δ3: the fields come from one `cat-file --batch-command -Z` object. A text read runs no fingerprint check.
        const ran = service.runner.calls.slice(first).filter((call) => call.refused === undefined).map((call) => call.arguments.join(" "));
        expect(ran).toEqual([batchCommandArgs().join(" ")]);
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
        const found = (await textRows(service, await checkout(service, repo), true)).slice(0, 3).map(rowOf);
        expect(found.map((r) => ({ oid: r.oid, invalidUtf8: r.invalidUtf8, committer: r.committer, body: r.body }))).toEqual([
          { oid: oids[0]!, invalidUtf8: true, committer: FIXED_IDENTITY, body: "Caf�\n" },
          { oid: oids[1]!, invalidUtf8: true, committer: { name: FIXED_IDENTITY.name, email: "jos�@arbareto.invalid" }, body: "" },
          { oid: oids[2]!, invalidUtf8: true, committer: { name: "Jos�", email: FIXED_IDENTITY.email }, body: "" },
        ]);
        expect(found).toEqual(oracleRows(repo, parent).slice(0, 3));
      }),
    TIMEOUT_MS,
  );
});

describe("F16 history bounds (001 contract §5 on the feature 002 bounds, contract Δ5)", () => {
  // Each F16 history variant with the 002 load reason, or null for a complete view. Feature 002 has no page, so the 001 page bounds no longer apply.
  const CASES: [F16HistoryVariant, keyof typeof LIMITS | null][] = [
    ["parents-64", null],
    ["parents-65", limitName("HISTORY_PARENTS_PER_COMMIT")],
    ["parent-refs", null],
    ["object-at-limit", null],
    ["object-over-limit", null],
    ["traversal", null],
  ];

  for (const [variant, reason] of CASES) {
    caseTest(
      TASK,
      reason === null ? `F16 ${variant}: the view loads complete and equals the oracle` : `F16 ${variant}: the bound gives limited with reason ${reason}, never a truncated complete view`,
      ["shell-double"],
      () =>
        withService(`t070-f16-${variant}`, async (service) => {
          const built = cachedF16History(gitPath(), `t070-f16-${variant}`, variant).built;
          const repo = repoOf(built);
          const tip = (built.facts.notes.commits as Record<string, string>).tip!;
          const expected = oracleTraversal(repo, tip);
          if (variant === "object-at-limit" || variant === "object-over-limit") {
            expect(F16_OBJECT_LIMIT).toBe(LIMITS.HISTORY_COMMIT_OBJECT_BYTES);
            expect(Number(git(repo, ["cat-file", "-s", tip]).toString().trim())).toBe(built.facts.notes.objectBytes as number);
          }
          const c = await checkout(service, repo);
          const loaded = c.loaded!;
          if (reason === null) {
            expect({ state: loaded.state, complete: loaded.result!.complete }).toEqual({ state: "succeeded", complete: true });
            const found = await textRows(service, c);
            expect(found.map((r) => ({ oid: r.oid, parents: r.parents }))).toEqual(expected);
            // Contract Δ3: an object above HISTORY_COMMIT_OBJECT_BYTES gives `textLimit` and no text.
            const limitedText = found.filter((r) => r.textLimit === true).map((r) => r.oid);
            expect(limitedText).toEqual(variant === "object-over-limit" ? [tip] : []);
            return;
          }
          expect({ state: loaded.state, code: loaded.code, reason: loaded.result!.reason, complete: loaded.result!.complete }).toEqual({ state: "limited", code: "OUTPUT_LIMIT", reason, complete: false });
          // Bounded data stays a prefix of the Git traversal.
          const held = loaded.result!.rows;
          expect(held).toBeLessThan(expected.length);
          const found = held === 0 ? [] : (await rows(service, c.repositoryId, c.opened.result!.viewId, { row: 0 }, held)).result!.rows!;
          expect(found.map((r) => ({ oid: r.oid, parents: r.parents }))).toEqual(expected.slice(0, held));
        }),
      TIMEOUT_MS,
    );
  }

  // Contract Δ3 `readHistoryRows`: the result keeps the rows before the first row that passes the 8 MiB encoded result bound, and sets `cut`.
  caseTest(
    TASK,
    "History rows: F16 page-bytes gives cut rows that are a prefix of the oracle, and the encoded result is at most 8 MiB",
    ["shell-double"],
    () =>
      withService("t070-f16-page-bytes", async (service) => {
        const built = cachedF16History(gitPath(), "t070-f16-page-bytes", "page-bytes").built;
        const repo = repoOf(built);
        const tip = (built.facts.notes.commits as Record<string, string>).tip!;
        const expected = oracleRows(repo, tip).map(textOf);
        expect(expected.length).toBe(10);
        const c = await checkout(service, repo);
        expect(c.loaded!.result).toEqual({ rows: 10, complete: true });
        const response = await rows(service, c.repositoryId, c.opened.result!.viewId, { row: 0 }, 10, "rows");
        expect({ state: response.state, cut: response.result!.cut }).toEqual({ state: "succeeded", cut: true });
        const found = response.result!.rows!;
        // JSON escapes each 0x01 byte as 6 bytes, so one row holds about 1.2 MB and the bound keeps at least one row.
        expect(found.length).toBeGreaterThan(0);
        expect(found.length).toBeLessThan(expected.length);
        expect(found.map(textOf)).toEqual(expected.slice(0, found.length));
        expect(Buffer.byteLength(JSON.stringify(response.result))).toBeLessThanOrEqual(LIMITS.HISTORY_PAGE_BYTES);
      }),
    TIMEOUT_MS,
  );

  // Contract "Contract gaps": a shallow file above 4 MiB has no view reason. The first reached bound wins, so no row leaves.
  caseTest(
    TASK,
    "F16 page-bytes with a shallow file above its bound gives OUTPUT_LIMIT at openHistory, and no row reaches a response",
    ["shell-double"],
    () =>
      withService("t070-f16-first-bound", async (service) => {
        const built = cachedF16History(gitPath(), "t070-f16-first-bound", "page-bytes").built;
        const repo = repoOf(built);
        const tip = (built.facts.notes.commits as Record<string, string>).tip!;
        const shallow = join(repo, git(repo, ["rev-parse", "--git-path", "shallow"]).toString().trim());
        // Valid object ID lines that name no commit of the fixture. Git keeps them as grafts, so the traversal stays the same.
        const line = (i: number) => `${new Bun.CryptoHasher("sha1").update(`t070-first-bound-${i}`).digest("hex")}\n`;
        appendFileSync(shallow, Array.from({ length: Math.ceil((LIMITS.SHALLOW_METADATA_BYTES + 1) / line(0).length) }, (_, i) => line(i)).join(""));
        const c = await checkout(service, repo);
        expect({ state: c.opened.state, code: c.opened.code, reason: (c.opened.result as { reason?: string } | undefined)?.reason }).toEqual({ state: "failed", code: "OUTPUT_LIMIT", reason: undefined });
        expect(service.runner.calls.filter(isLoad)).toEqual([]);
        const text = JSON.stringify(service.responses);
        expect(oracleTraversal(repo, tip).filter((r) => text.includes(r.oid))).toEqual([]);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    `a shallow file above ${LIMITS.SHALLOW_METADATA_BYTES} bytes gives OUTPUT_LIMIT without a reason`,
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
        const c = await checkout(service, repo);
        expect({ state: c.opened.state, code: c.opened.code, reason: (c.opened.result as { reason?: string } | undefined)?.reason }).toEqual({ state: "failed", code: "OUTPUT_LIMIT", reason: undefined });
      }),
    TIMEOUT_MS,
  );
});

describe("missing objects (001 contract §7 \"Missing objects\")", () => {
  caseTest(
    TASK,
    "F17 partial clone: a missing commit gives OBJECT_MISSING, git cat-file -e still fails, and the uploadpack canary never runs",
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
        const loaded = (await checkout(service, clone)).loaded!;
        expect({ state: loaded.state, code: loaded.code, reason: loaded.result?.reason }).toEqual({ state: "failed", code: "OBJECT_MISSING", reason: "object-missing" });
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
const isConfigList = (call: { arguments: readonly string[] }) => call.arguments.join("\0") === configListArgs().join("\0");
const isRefListing = (call: { arguments: readonly string[] }) => call.arguments.join("\0") === historyRefsArgs().join("\0");

describe("history without a status snapshot (001 contract §3, feature 002 openHistory)", () => {
  caseTest(
    TASK,
    "right after registration, openHistory returns the view with the registration generation, and the runner sees no status call",
    ["shell-double"],
    () =>
      withService("t070-no-status", async (service) => {
        const built = buildF19(gitPath(), "t070-no-status", "linear");
        const c = await checkout(service, repoOf(built));
        expect(c.opened.state).toBe("succeeded");
        expect(c.opened.result!.generation).toBe(c.generation);
        expect(c.loaded!.result!.complete).toBe(true);
        expect(service.runner.calls.filter(isStatus)).toEqual([]);
        expect(service.runner.calls.filter(isLoad).length).toBe(1);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    `openHistory runs beside a held readWorkspace within the ${LIMITS.CONCURRENT_READS_PER_WORKSPACE}-read cap`,
    ["shell-double"],
    () =>
      withService("t070-beside", async (service) => {
        const built = buildF19(gitPath(), "t070-beside", "linear");
        const { repositoryId, generation } = await service.register(repoOf(built));
        const release = service.runner.holdStart(once(isStatus));
        try {
          const workspace = service.send("readWorkspace", { refresh: false, check: "full" }, { repositoryId });
          await waitFor("status call", () => service.runner.calls.some(isStatus));
          const view = await service.openHistory(repositoryId, generation);
          expect(view.state).toBe("succeeded");
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
    "the view binds the captured HEAD OID and target",
    ["shell-double"],
    () =>
      withService("t070-head", async (service) => {
        const built = buildF19(gitPath(), "t070-head", "linear");
        const repo = repoOf(built);
        const first = await checkout(service, repo);
        expect(first.opened.result!.head).toEqual({ state: "branch", target: "refs/heads/main", oid: built.facts.notes.tip as string });
        expect(first.opened.result!.shallow).toBe(false);
        git(repo, ["commit", "-q", "--allow-empty", "--no-verify", "-m", "next"]);
        const next = refState(gitPath(), repo).headOid!;
        const second = await openView(service, first.repositoryId, first.generation, "current");
        await load(service, first.repositoryId, second.result!.viewId, { end: true });
        const row = (await rows(service, first.repositoryId, second.result!.viewId, { row: 0 }, 1)).result!.rows![0]!;
        expect({ head: second.result!.head, first: row.oid, checkout: row.checkout }).toEqual({ head: { state: "branch", target: "refs/heads/main", oid: next }, first: next, checkout: true });
      }),
    TIMEOUT_MS,
  );

  // Contract Δ8: a shallow file change makes the view stale with HISTORY_CHANGED reason `topology` before its next Git process.
  caseTest(
    TASK,
    "the view binds the shallow file, a shallow file change makes it stale, and a new view gives the same rows",
    ["shell-double"],
    () =>
      withService("t070-shallow-fingerprint", async (service) => {
        const built = buildF19(gitPath(), "t070-shallow-fingerprint", "shallow");
        const repo = repoOf(built);
        const { repositoryId, generation } = await service.register(repo);
        const first = await openView(service, repositoryId, generation, "current");
        expect(first.result!.shallow).toBe(true);
        const shallow = join(repo, git(repo, ["rev-parse", "--git-path", "shallow"]).toString().trim());
        appendFileSync(shallow, `${new Bun.CryptoHasher("sha1").update("t070-graft").digest("hex")}\n`);
        const stale = await load(service, repositoryId, first.result!.viewId, { end: true });
        expect({ state: stale.state, code: stale.code, reason: stale.result?.reason }).toEqual({ state: "failed", code: "HISTORY_CHANGED", reason: "topology" });
        const second = await openView(service, repositoryId, generation, "current");
        expect(second.result!.shallow).toBe(true);
        const loaded = await load(service, repositoryId, second.result!.viewId, { end: true });
        const found = (await rows(service, repositoryId, second.result!.viewId, { row: 0 }, loaded.result!.rows)).result!.rows!;
        expect(found.map((r) => ({ oid: r.oid, parents: r.parents }))).toEqual(oracleTraversal(repo, built.facts.notes.tip as string));
      }),
    TIMEOUT_MS,
  );
});

describe("trust gate (001 contract §7)", () => {
  caseTest(
    TASK,
    "an F17 copy without read approval gives TRUST_REQUIRED, the refused gate stops the held ref listing, no response holds a commit ID of the fixture, and no canary runs",
    ["shell-double"],
    () =>
      withService("t070-trust", async (service) => {
        const built = buildF17(gitPath(), "t070-trust", "trust");
        const repo = repoOf(built);
        const tip = refState(gitPath(), repo).headOid!;
        const commits = oracleTraversal(repo, tip).flatMap((row) => [row.oid, ...row.parents]);
        expect(commits.length).toBeGreaterThan(0);
        const { repositoryId, generation } = await service.register(repo);
        // A real `for-each-ref` writes less than one pipe buffer, so it can exit before the gate decides. The double sends the real Git bytes as its output.
        const listing = ownedGit(gitPath(), FIXTURE_ROOT, repo, historyRefsArgs());
        service.runner.inject.stdout = (call) => (isRefListing(call) ? listing : undefined);
        // The trust listing waits until the ref listing starts. The injected ref listing waits at its stdout barrier. So only the refused gate can end it.
        const releaseListing = service.runner.pauseStdout(once(isConfigList));
        const releaseRefs = service.runner.pauseStdout(once(isRefListing));
        try {
          const request = service.send("openHistory", { scope: "current" }, { repositoryId, repositoryGeneration: generation });
          await waitFor("for-each-ref call", () => service.runner.calls.some(isRefListing));
          releaseListing();
          const response = await service.response(request);
          // Contract §9 fixes the code. The read starts its trust listing first, so the terminal state is not fixed as `rejected`.
          expect({ code: response.code, succeeded: response.state === "succeeded" }).toEqual({ code: "TRUST_REQUIRED", succeeded: false });
          // Contract §7 "Held history steps": the refused gate ends every held step. The recorded ref listing ended without an exit status.
          expect(service.runner.calls.filter(isRefListing).map((c) => c.exit?.exitCode)).toEqual([null]);
          expect(service.runner.calls.filter((c) => isLoad(c) || isTextRead(c))).toEqual([]);
        } finally {
          releaseListing();
          releaseRefs();
        }
        // Contract §7 "Held history steps": the capture steps can run beside the listing, but no captured data reaches a response.
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

describe("failed history steps (001 contract §7 \"Missing objects\")", () => {
  // D33: the shell identity of the origin file decides that `extensions.partialclone` comes from `<commondir>/config`, never the path text.
  caseTest(
    TASK,
    "a repository with only extensions.partialclone, whose listing spells the common config through a junction alias, gives OBJECT_MISSING for a missing parent",
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
        const loaded = (await checkout(service, repo)).loaded!;
        expect({ state: loaded.state, code: loaded.code }).toEqual({ state: "failed", code: "OBJECT_MISSING" });
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
        const c = await checkout(service, repo);
        expect(c.loaded!.result).toEqual({ rows: 5, complete: true });
        const release = service.runner.holdStart(once(isTextRead));
        try {
          const request = service.send("readHistoryRows", { viewId: c.opened.result!.viewId, mode: "full", at: { row: 0 }, count: 5, text: "rows" }, { repositoryId: c.repositoryId });
          await waitFor("cat-file --batch-command call", () => service.runner.calls.some(isTextRead));
          corrupt(loose(oids.S));
          release();
          const response = await service.response(request);
          expect({ state: response.state, code: response.code }).toEqual({ state: "failed", code: "GIT_FAILED" });
          expect(service.runner.calls.filter(isTextRead).map((call) => call.exit?.exitCode)).toEqual([128]);
        } finally {
          release();
        }
      }),
    TIMEOUT_MS,
  );

  // Data-model §2 `unavailable`: the last read got REPOSITORY_UNAVAILABLE. A later complete `readWorkspace` resets the mark, so the case observes the view calls alone.
  caseTest(
    TASK,
    "a commit object that disappears before cat-file --batch-command, without a promisor remote, ends REPOSITORY_UNAVAILABLE, and the history view marks the workspace state unavailable",
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
        const responses = new Map<string, { state: string; code?: string; result?: unknown }>();
        // A response without `requestId` belongs to no request of this case.
        const registry = createOperationRegistry((response) => void (response.requestId !== null && responses.set(response.requestId, response as never)), () => {}, createSessionLog(), service.runner);
        const views = createHistoryViews({
          runner: service.runner,
          trust,
          listingTuple: reader.listingTuple,
          markUnavailable: (id) => void marked.push(id),
          registry,
          viewCommits: LIMITS.HISTORY_VIEW_COMMITS,
          reject: (requestId, code) => void responses.set(requestId, { state: "rejected", code }),
        });
        const opened = await views.open({ operationId: crypto.randomUUID(), signal, installation: probed.installation, workspace, generation: workspace.generation }, "current");
        expect(opened.result).toBe("succeeded");
        const { viewId } = opened.value as { viewId: string };
        const send = async (request: Record<string, unknown>, run: (request: never) => void) => {
          const requestId = crypto.randomUUID();
          run({ requestId, repositoryId: workspace.repositoryId, ...request } as never);
          await waitFor(`response ${requestId}`, () => responses.has(requestId));
          return responses.get(requestId)!;
        };
        expect(await send({ payload: { viewId, need: { end: true } } }, (r) => views.load(r))).toMatchObject({ state: "succeeded", result: { rows: 6, complete: true } });
        const release = service.runner.holdStart(once(isTextRead));
        try {
          const pending = send({ payload: { viewId, mode: "full", at: { row: 0 }, count: 6, text: "rows" } }, (r) => views.rows(r));
          await waitFor("cat-file --batch-command call", () => service.runner.calls.some(isTextRead));
          rmSync(loose(oids.H1), { force: true });
          release();
          expect(await pending).toMatchObject({ state: "failed", code: "REPOSITORY_UNAVAILABLE", result: { remedy: { text: DAMAGED_STORE_REMEDY, command: null } } });
          expect(marked).toEqual([workspace.repositoryId]);
        } finally {
          release();
        }
      }),
    TIMEOUT_MS,
  );
});
