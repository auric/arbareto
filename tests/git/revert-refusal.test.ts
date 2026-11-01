// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 008 T043: the refusal matrix of `src/git-service/revert.ts` (data-model §7, spec FR-005, FR-038, SC-004).
// Each case gives one reason to every action where it applies. A refusal changes no index byte and no working-file byte, and it sends no write.
// No case here: `state` (CONFLICTED refuses first, `revert-frame.test.ts`), `limit` (`revert-unstaged.test.ts`; the `revert-files` payload bound refuses first),
// `several-hunks` (the renderer only, contract Δ4), `encrypted` (needs an EFS key of the account), and `xattr` and `shared-repository` (WSL, `tests/wsl`).

import { describe, expect } from "bun:test";
import { chmodSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { RunWorkbenchResult } from "../../src/contracts/envelope";
import { PROFILE_TEXTS } from "../../src/git-service/hunk-publish";
import { LOCKED_REMEDY } from "../../src/git-service/index-lock";
import { OBJECT_MISSING_REMEDY } from "../../src/git-service/status";
import { printOrigin } from "../origin";
import { faGit, write } from "./file-actions-fixtures";
import { fixtureDir, useFixtureRoot } from "./fixture-root";
import { workingFileDigests } from "./git-oracle";
import { approve, gitPath, gitPathOf, hunksOf, outcome, readOk, subcommand, SUCCEEDED, TIMEOUT_MS, valuesOf, withService } from "./hunk-harness";
import { caseTest, type Capability, type ChangeEntry, type RegistrationResult, type Service, type ServiceResponse, type WorkspaceResult } from "./service-harness";

for (const module of ["revert", "revert-bytes", "workbench-review", "eligibility", "support"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
useFixtureRoot();

const TASK = "T043";
const SHELL: Capability[] = ["shell-double"];
const WINDOWS = process.platform === "win32";

// The line-ending keys and `core.filemode` of `tests/git/fixtures.ts` `lineEndings`. A case adds its own keys after them.
const LINE_ENDINGS: [string, string][] = [
  ["core.autocrlf", "false"],
  ["core.eol", "lf"],
  ["core.safecrlf", "false"],
  ["core.filemode", "false"],
];

type Act = "lines" | "staged-lines" | "files" | "staged-files" | "unstaged";
type Category = ChangeEntry["category"];
type Expected = { code: string; result?: unknown };
type Files = Record<string, string | Uint8Array>;

let builds = 0;
const g = (repo: string, args: string[], input?: string | Uint8Array) => faGit(gitPath(), repo, args, input === undefined ? {} : { input });
const b64 = (path: string | Uint8Array) => Buffer.from(path).toString("base64");
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const add = (repo: string, ...paths: string[]) => g(repo, ["--literal-pathspecs", "add", "--", ...paths]);
const blob = (repo: string, content: string) => g(repo, ["hash-object", "-w", "--stdin"], content).toString("utf8").trim();

// `files` is the committed content. `after` runs after the commit, and the case config comes last, so no fixture step writes under it.
function build(name: string, files: Files, after?: (repo: string) => void, config: [string, string][] = []): string {
  const repo = join(fixtureDir(`t043-${name}-${++builds}`), "repo");
  mkdirSync(repo, { recursive: true });
  g(repo, ["init", "-q", "-b", "main"]);
  for (const [key, value] of LINE_ENDINGS) g(repo, ["config", key, value]);
  for (const [path, content] of Object.entries(files)) write(repo, path, content);
  g(repo, ["add", "-A"]);
  g(repo, ["commit", "-q", "--no-verify", "-m", "base"]);
  after?.(repo);
  for (const [key, value] of config) g(repo, ["config", key, value]);
  return repo;
}

// SC-004: the index bytes, the raw index digest, and every working-file byte.
const state = (repo: string) => ({ index: g(repo, ["ls-files", "--stage", "-z"]).toString("latin1"), raw: sha256(readFileSync(gitPathOf(repo, "index"))), files: workingFileDigests(repo) });
const writeFrames = (service: Service) => service.runner.frames.filter((f) => f.type === "fileReplace" || f.type === "tempRemove").length;
const WRITERS: ReadonlySet<string> = new Set(["update-index", "checkout-index", "apply", "read-tree", "write-tree", "commit"]);
const writers = (service: Service, from: number) => service.runner.calls.slice(from).flatMap((c) => subcommand(c.arguments) ?? []).filter((s) => WRITERS.has(s));
const refusal = (response: ServiceResponse<unknown>) => ({ state: response.state, code: response.code, result: response.result });

function rowOf(read: WorkspaceResult, path: string | Uint8Array, category: Category): ChangeEntry {
  const entry = read.entries.find((e) => e.pathBytes === b64(path) && e.category === category);
  expect({ path: b64(path), category, listed: entry !== undefined }).toEqual({ path: b64(path), category, listed: true });
  return entry!;
}

// The 1-based ordinals of the `+` and `-` lines of the first hunk of a comparison result (004 data-model §6).
function ordinalsOf(result: unknown): number[] {
  const patch = valuesOf(result, "patch")[0];
  const hunk = typeof patch === "string" ? hunksOf(Buffer.from(patch, "base64"))[0] : undefined;
  return hunk === undefined ? [] : hunk.split("\n").slice(1).flatMap((line, i) => (line[0] === "+" || line[0] === "-" ? [i + 1] : []));
}

const isLines = (act: Act) => act === "lines" || act === "staged-lines";
const categoryOf = (act: Act): Category => (act === "staged-lines" || act === "staged-files" ? "staged" : "unstaged");

// The review payload of `act` for `path`. A line action reads the comparison of the row first.
async function payloadOf(service: Service, r: RegistrationResult, read: WorkspaceResult, act: Act, path: string | Uint8Array, category: Category, lines?: (ordinals: number[]) => number[]): Promise<object> {
  if (act === "unstaged") return { action: "revert-unstaged" };
  const row = rowOf(read, path, category);
  if (!isLines(act)) return { action: "revert-files", entryIds: [row.entryId] };
  const response = await service.request("readComparison", { snapshotId: read.snapshotId, entryId: row.entryId }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation, selectionId: crypto.randomUUID() });
  const comparisonId = valuesOf(response.result, "comparisonId")[0];
  expect({ path: b64(path), act, comparison: typeof comparisonId }).toEqual({ path: b64(path), act, comparison: "string" });
  // A comparison that the 001 support refuses has no hunk, so the request names a hunk ID that no comparison holds.
  const hunkId = (valuesOf(response.result, "hunkId")[0] as string | undefined) ?? crypto.randomUUID();
  return { action: "revert-lines", comparisonId, hunkId, ...(lines === undefined ? {} : { lines: lines(ordinalsOf(response.result)) }) };
}

const review = (service: Service, r: RegistrationResult, read: WorkspaceResult, payload: object) =>
  service.request("reviewWorkbench", { snapshotId: read.snapshotId, ...payload }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });

interface RefusalCase {
  name: string;
  reason: string;
  code: string;
  needs?: Capability[];
  files: Files;
  after?: (repo: string) => void;
  config?: [string, string][];
  // The path of each action where the reason applies.
  paths: Partial<Record<Act, string | Uint8Array>>;
  categories?: Partial<Record<Act, Category>>;
  lines?: (ordinals: number[]) => number[];
  // A repository-level value in place of the file value of contract Δ3, for every action.
  value?: Record<string, unknown>;
  // A function takes the shown read, for a value that depends on the rows of that read.
  expect?: Partial<Record<Act, Expected | ((read: WorkspaceResult) => Expected)>>;
  // Runs after the payload and the state read, right before the review. `disarm` runs after it.
  arm?: (repo: string) => void;
  disarm?: (repo: string) => void;
  trust?: boolean;
  // One status read before the matrix, for a host program that changes the repository at its first run.
  warm?: boolean;
  cleanup?: (repo: string) => void;
}

// Contract Δ3 "Refusal value": `{reason}` for a line action, and the file value for `revert-files` and `revert-unstaged`.
function expectedOf(k: RefusalCase, act: Act, read: WorkspaceResult): Expected {
  const own = k.expect?.[act];
  if (own !== undefined) return typeof own === "function" ? own(read) : own;
  if (k.value !== undefined) return { code: k.code, result: k.value };
  if (isLines(act)) return { code: k.code, result: { reason: k.reason } };
  return { code: k.code, result: { reason: k.reason, files: [{ path: b64(k.paths[act]!), reason: k.reason }], more: 0 } };
}

async function expectRefusal(service: Service, r: RegistrationResult, repo: string, k: RefusalCase, act: Act): Promise<void> {
  const path = k.paths[act]!;
  const read = await readOk(service, r.repositoryId);
  const payload = await payloadOf(service, r, read, act, path, k.categories?.[act] ?? categoryOf(act), k.lines);
  const before = state(repo);
  const frames = writeFrames(service);
  const calls = service.runner.calls.length;
  k.arm?.(repo);
  let response: ServiceResponse<unknown>;
  try {
    response = await review(service, r, read, payload);
  } finally {
    k.disarm?.(repo);
  }
  const label = { reason: k.reason, act };
  const expected = expectedOf(k, act, read);
  expect({ ...label, ...refusal(response) }).toEqual({ ...label, state: "failed", code: expected.code, result: expected.result });
  expect({ ...label, state: state(repo), writes: writeFrames(service) - frames, writers: writers(service, calls) }).toEqual({ ...label, state: before, writes: 0, writers: [] });
}

function refusalCase(k: RefusalCase): void {
  const acts = Object.keys(k.paths) as Act[];
  caseTest(TASK, `${k.name} refuses ${acts.join(", ")} with ${k.reason}, and the index and every working byte stay`, [...SHELL, ...(k.needs ?? [])], () =>
    withService({ name: `t043-${k.name}` }, async (service) => {
      const repo = build(k.name, k.files, k.after, k.config);
      try {
        const r = await service.register(repo);
        if (k.trust) await approve(service, r.repositoryId);
        if (k.warm) await readOk(service, r.repositoryId);
        for (const act of acts) await expectRefusal(service, r, repo, k, act);
      } finally {
        k.cleanup?.(repo);
      }
    }),
    TIMEOUT_MS,
  );
}

// Windows `icacls /deny <user>:(R)` takes the read right of the current account (`delete.test.ts`). The second call removes the deny entry.
function denyRead(path: string, deny: boolean): void {
  if (!WINDOWS) return void chmodSync(path, deny ? 0o000 : 0o644);
  const args = deny ? [path, "/deny", `${userInfo().username}:(R)`] : [path, "/remove:d", userInfo().username];
  const proc = Bun.spawnSync(["icacls", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`icacls ${args.join(" ")} exited ${proc.exitCode}`);
}

// `attrib +O` sets FILE_ATTRIBUTE_OFFLINE, which research.md R8 keeps out of the copied attributes (Microsoft Learn "File Attribute Constants").
function offline(path: string, on: boolean): void {
  const proc = Bun.spawnSync(["attrib", on ? "+O" : "-O", path], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`attrib ${path} exited ${proc.exitCode}`);
}

const ALL_FIVE = (unstaged: string, staged: string): Partial<Record<Act, string>> => ({ lines: unstaged, "staged-lines": staged, files: unstaged, "staged-files": staged, unstaged });
const KEEP = { "keep.txt": "keep\n" };
// `a.txt` has an unstaged change, and `b.txt` a staged change without an unstaged one.
const AB = { "a.txt": "a\nb\nc\n", "b.txt": "a\nb\nc\n", ...KEEP };
const changeAB = (repo: string) => {
  write(repo, "a.txt", "a\nB\nc\n");
  write(repo, "b.txt", "a\nB\nc\n");
  add(repo, "b.txt");
};
const both = (repo: string, f: (path: string) => void) => ["a.txt", "b.txt"].forEach((p) => f(join(repo, p)));
const bigText = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}\n`).join("");
const BINARY = Uint8Array.from({ length: 64 }, (_, i) => i % 8);

describe("revert refusals: the 001 support reasons (data-model §7, spec FR-038)", () => {
  refusalCase({
    name: "rename",
    reason: "rename",
    code: "UNSUPPORTED_COMPARISON",
    files: { "old.txt": "r1\nr2\nr3\nr4\nr5\n", ...KEEP },
    after: (r) => {
      g(r, ["--literal-pathspecs", "mv", "--", "old.txt", "new.txt"]);
      write(r, "new.txt", "r1\nR2\nr3\nr4\nr5\n");
    },
    paths: ALL_FIVE("new.txt", "new.txt"),
  });

  // `core.filemode=true`: the working file has no executable bit, and the index entry has mode 100755.
  refusalCase({
    name: "mode-unstaged",
    reason: "mode",
    code: "UNSUPPORTED_COMPARISON",
    files: { "mode.sh": "a\nb\n", ...KEEP },
    after: (r) => {
      g(r, ["config", "core.filemode", "true"]);
      g(r, ["update-index", "--chmod=+x", "--", "mode.sh"]);
      g(r, ["commit", "-q", "--no-verify", "-m", "mode"]);
      write(r, "mode.sh", "a\nB\n");
    },
    paths: { lines: "mode.sh", files: "mode.sh", unstaged: "mode.sh" },
  });

  // `core.filemode=false`: Git reports the index mode for the working file, so only the staged side changes its mode.
  refusalCase({
    name: "mode-staged",
    reason: "mode",
    code: "UNSUPPORTED_COMPARISON",
    files: { "x.sh": "a\nb\n", ...KEEP },
    after: (r) => g(r, ["update-index", "--chmod=+x", "--", "x.sh"]),
    paths: { "staged-lines": "x.sh", "staged-files": "x.sh" },
  });

  // A staged symlink entry at a file path. `core.symlinks=false` keeps the regular working file equal to the link blob.
  refusalCase({
    name: "type-staged",
    reason: "type",
    code: "UNSUPPORTED_COMPARISON",
    files: { "t.txt": "t\n", ...KEEP },
    after: (r) => {
      g(r, ["update-index", "--cacheinfo", `120000,${blob(r, "target")},t.txt`]);
      write(r, "t.txt", "target");
    },
    config: [["core.symlinks", "false"]],
    paths: { "staged-lines": "t.txt", "staged-files": "t.txt" },
  });

  // ce_match_stat_basic (Git `read-cache.c`): with `core.symlinks=true`, a regular file at a symlink entry is a type change.
  refusalCase({
    name: "type-unstaged",
    reason: "type",
    code: "UNSUPPORTED_COMPARISON",
    files: KEEP,
    after: (r) => {
      g(r, ["update-index", "--add", "--cacheinfo", `120000,${blob(r, "target")},link`]);
      g(r, ["commit", "-q", "--no-verify", "-m", "link"]);
      write(r, "link", "target");
    },
    config: [["core.symlinks", "true"]],
    paths: { lines: "link", files: "link", unstaged: "link" },
  });

  // `core.symlinks=false`: Git keeps the symlink mode for the regular working file, so `link1` has an unstaged and `link2` a staged change.
  refusalCase({
    name: "symlink",
    reason: "symlink",
    code: "UNSUPPORTED_COMPARISON",
    files: KEEP,
    after: (r) => {
      const target = blob(r, "target");
      g(r, ["update-index", "--add", "--cacheinfo", `120000,${target},link1`, "--cacheinfo", `120000,${target},link2`]);
      g(r, ["commit", "-q", "--no-verify", "-m", "links"]);
      write(r, "link1", "other");
      g(r, ["update-index", "--cacheinfo", `120000,${blob(r, "target2")},link2`]);
      write(r, "link2", "target2");
    },
    config: [["core.symlinks", "false"]],
    paths: ALL_FIVE("link1", "link2"),
  });

  // `gl` is a gitlink with a staged change and no folder. `sub` is a nested repository at another commit than its gitlink.
  // Plan.md D6: Revert all unstaged changes leaves a submodule entry unchanged, so only submodule entries give nothing-to-revert.
  refusalCase({
    name: "submodule",
    reason: "submodule",
    code: "UNSUPPORTED_COMPARISON",
    files: KEEP,
    after: (r) => {
      const first = g(r, ["rev-parse", "HEAD"]).toString("utf8").trim();
      g(r, ["update-index", "--add", "--cacheinfo", `160000,${first},gl`]);
      g(r, ["commit", "-q", "--no-verify", "-m", "gitlink"]);
      g(r, ["commit", "-q", "--no-verify", "--allow-empty", "-m", "two"]);
      g(r, ["update-index", "--cacheinfo", `160000,${g(r, ["rev-parse", "HEAD"]).toString("utf8").trim()},gl`]);
      const sub = join(r, "sub");
      mkdirSync(sub);
      g(sub, ["init", "-q", "-b", "main"]);
      write(sub, "s.txt", "s1\n");
      g(sub, ["add", "-A"]);
      g(sub, ["commit", "-q", "--no-verify", "-m", "s1"]);
      const s1 = g(sub, ["rev-parse", "HEAD"]).toString("utf8").trim();
      write(sub, "s.txt", "s2\n");
      g(sub, ["commit", "-q", "--no-verify", "-am", "s2"]);
      g(r, ["update-index", "--add", "--cacheinfo", `160000,${s1},sub`]);
    },
    paths: { lines: "sub", files: "sub", "staged-lines": "gl", "staged-files": "gl", unstaged: "sub" },
    expect: { unstaged: { code: "WORKBENCH_UNAVAILABLE", result: { reason: "nothing-to-revert" } } },
  });

  // `filterReason` reads the attribute value. The fixture Git reads no system configuration, so it runs no filter.
  // The service Git reads the host system configuration. At its first filter run, a host Git LFS writes `lfs.repositoryformatversion` and four hooks.
  // That changes the configuration of the shown read (observed with the Git for Windows 2.56.0 system `filter.lfs` entries). So the case reads once first.
  for (const [name, attribute, reason] of [
    ["lfs", "filter=lfs", "LFS"],
    ["filter", "filter=custom", "filter"],
  ] as const) {
    refusalCase({
      name,
      reason,
      code: "UNSUPPORTED_COMPARISON",
      files: { ".gitattributes": `*.bin ${attribute}\n`, ...AB, "a.bin": "a\nb\nc\n", "b.bin": "a\nb\nc\n" },
      after: (r) => {
        write(r, "a.bin", "a\nB\nc\n");
        write(r, "b.bin", "a\nB\nc\n");
        add(r, "b.bin");
      },
      warm: true,
      paths: ALL_FIVE("a.bin", "b.bin"),
      // A host filter can make the staged `b.bin` an unstaged row too, so the value names every unstaged row of the shown read.
      expect: {
        unstaged: (read) => {
          const rows = read.entries.filter((e) => e.category === "unstaged").map((e) => e.pathBytes);
          // Both rows sit in the root folder, so the tree order is the byte order.
          rows.sort((x, y) => Buffer.compare(Buffer.from(x, "base64"), Buffer.from(y, "base64")));
          return { code: "UNSUPPORTED_COMPARISON", result: { reason, files: rows.map((path) => ({ path, reason })), more: 0 } };
        },
      },
    });
  }

  // Intent-to-add gives `n.txt` an unstaged entry with the flag. `assume-unchanged` flags the staged `b.txt`.
  refusalCase({
    name: "index-flag",
    reason: "index-flag",
    code: "UNSUPPORTED_COMPARISON",
    files: AB,
    after: (r) => {
      write(r, "b.txt", "a\nB\nc\n");
      add(r, "b.txt");
      g(r, ["update-index", "--assume-unchanged", "--", "b.txt"]);
      write(r, "n.txt", "n\n");
      g(r, ["--literal-pathspecs", "add", "-N", "--", "n.txt"]);
    },
    paths: ALL_FIVE("n.txt", "b.txt"),
  });

  // An index path that is no UTF-8 text. Status lists it as added in the index and deleted in the worktree.
  const BAD = Buffer.from("bad\xff.txt", "latin1");
  refusalCase({
    name: "path",
    reason: "path",
    code: "UNSUPPORTED_COMPARISON",
    files: KEEP,
    after: (r) => g(r, ["update-index", "--index-info"], Buffer.concat([Buffer.from(`100644 ${blob(r, "x\n")}\t`), BAD, Buffer.from("\n")])),
    paths: { lines: BAD, "staged-lines": BAD, files: BAD, "staged-files": BAD, unstaged: BAD },
  });
});

describe("revert refusals: the line reasons (data-model §6 and §7, spec FR-013)", () => {
  // `b.dat` and the other `b.*` files have a staged change, and `a.*` files an unstaged change.
  const staged = (r: string, path: string, content: string | Uint8Array) => {
    write(r, path, content);
    add(r, path);
  };
  refusalCase({
    name: "binary",
    reason: "binary",
    code: "UNSUPPORTED_COMPARISON",
    files: { "a.dat": BINARY, "b.dat": BINARY, ...KEEP },
    after: (r) => {
      write(r, "a.dat", BINARY.map((b) => b ^ 1));
      staged(r, "b.dat", BINARY.map((b) => b ^ 2));
    },
    paths: { lines: "a.dat", "staged-lines": "b.dat" },
  });

  // Support `validContent`: a hunk line that is no UTF-8 text. It holds no NUL byte, so Git counts the file as text.
  const LATIN = Buffer.from("a\n\xffb\nc\n", "latin1");
  refusalCase({
    name: "encoding",
    reason: "encoding",
    code: "UNSUPPORTED_COMPARISON",
    files: AB,
    after: (r) => {
      write(r, "a.txt", LATIN);
      staged(r, "b.txt", LATIN);
    },
    paths: { lines: "a.txt", "staged-lines": "b.txt" },
  });

  // Above COMPARED_RAW_VERSION_BYTES (1 MiB).
  const BIG = bigText(120_000);
  refusalCase({
    name: "size",
    reason: "size",
    code: "UNSUPPORTED_COMPARISON",
    files: { "a.txt": BIG, "b.txt": BIG, ...KEEP },
    after: (r) => {
      write(r, "a.txt", BIG.replace("line 5\n", "LINE 5\n"));
      staged(r, "b.txt", BIG.replace("line 5\n", "LINE 5\n"));
    },
    paths: { lines: "a.txt", "staged-lines": "b.txt" },
  });

  // `ls-files --eol` `w/mixed` and `i/mixed`.
  refusalCase({
    name: "line-endings",
    reason: "line-endings",
    code: "UNSUPPORTED_COMPARISON",
    files: AB,
    after: (r) => {
      write(r, "a.txt", "a\r\nB\nc\n");
      staged(r, "b.txt", "a\r\nB\nc\n");
    },
    paths: { lines: "a.txt", "staged-lines": "b.txt" },
  });

  // A real line-ending mismatch of the proof: with `core.autocrlf=true`, `add` keeps the CRLF blob of an index that holds a CR (Git `convert.c` `has_crlf_in_index`).
  // Status then shows no unstaged change, so the status record of plan.md D4 passes. `hash-object --path` gives the LF blob ID for the same bytes (observed with Git 2.56.0), so the proof fails.
  refusalCase({
    name: "line-endings-proof",
    reason: "line-endings",
    code: "UNSUPPORTED_COMPARISON",
    files: { "b.txt": "a\r\nb\r\nc\r\nd\r\n", ...KEEP },
    after: (r) => {
      g(r, ["config", "core.autocrlf", "true"]);
      staged(r, "b.txt", "a\r\nB\r\nc\r\nd\r\n");
    },
    paths: { "staged-lines": "b.txt" },
  });

  refusalCase({
    name: "ident",
    reason: "ident",
    code: "WORKBENCH_UNAVAILABLE",
    files: { ".gitattributes": "*.id ident\n", "a.id": "a\n$Id$\nb\n", "b.id": "a\n$Id$\nb\n", ...KEEP },
    after: (r) => {
      write(r, "a.id", "a\n$Id$\nB\n");
      staged(r, "b.id", "a\n$Id$\nB\n");
    },
    paths: { lines: "a.id", "staged-lines": "b.id" },
  });

  // Contract Δ4 (004): `context-only` has no service form. A context ordinal is no line selection, and an empty selection breaks the payload schema.
  refusalCase({
    name: "context-only",
    reason: "context-only",
    code: "INVALID_REQUEST",
    files: AB,
    after: changeAB,
    paths: { lines: "a.txt", "staged-lines": "b.txt" },
    lines: () => [1],
    expect: { lines: { code: "INVALID_REQUEST" }, "staged-lines": { code: "INVALID_REQUEST" } },
  });

  refusalCase({
    name: "deleted-file",
    reason: "deleted-file",
    code: "UNSUPPORTED_COMPARISON",
    files: AB,
    after: (r) => {
      rmSync(join(r, "a.txt"));
      g(r, ["--literal-pathspecs", "rm", "-q", "--", "b.txt"]);
    },
    paths: { lines: "a.txt", "staged-lines": "b.txt" },
  });

  refusalCase({
    name: "new-file",
    reason: "new-file",
    code: "UNSUPPORTED_COMPARISON",
    files: KEEP,
    after: (r) => staged(r, "n.txt", "n1\nn2\n"),
    paths: { "staged-lines": "n.txt" },
  });

  // Body ` a -b \ +b +c +d`: a part of a hunk with Git's marker refuses.
  refusalCase({
    name: "eof-newline",
    reason: "eof-newline",
    code: "UNSUPPORTED_COMPARISON",
    files: { "a.txt": "a\nb", "b.txt": "a\nb", ...KEEP },
    after: (r) => {
      write(r, "a.txt", "a\nb\nc\nd\n");
      staged(r, "b.txt", "a\nb\nc\nd\n");
    },
    paths: { lines: "a.txt", "staged-lines": "b.txt" },
    lines: (ordinals) => [ordinals.at(-1)!],
  });

  refusalCase({
    name: "unstaged-changes",
    reason: "unstaged-changes",
    code: "WORKBENCH_UNAVAILABLE",
    files: AB,
    after: (r) => {
      staged(r, "b.txt", "a\nB\nc\n");
      write(r, "b.txt", "a\nB\nc\nD\n");
    },
    paths: { "staged-lines": "b.txt" },
  });

  caseTest(TASK, "an empty line selection breaks the payload schema: INVALID_REQUEST before any Git process", SHELL, () =>
    withService({ name: "t043-empty-lines" }, async (service) => {
      const repo = build("empty-lines", AB, changeAB);
      const r = await service.register(repo);
      const read = await readOk(service, r.repositoryId);
      const payload = await payloadOf(service, r, read, "lines", "a.txt", "unstaged");
      const calls = service.runner.calls.length;
      expect(outcome(await review(service, r, read, { ...payload, lines: [] }))).toEqual({ state: "rejected", code: "INVALID_REQUEST" });
      expect(service.runner.calls.length).toBe(calls);
    }),
    TIMEOUT_MS,
  );
});

describe("revert refusals: untracked, in-the-way, and attributes (data-model §7, spec FR-018, FR-020)", () => {
  refusalCase({
    name: "untracked",
    reason: "untracked",
    code: "WORKBENCH_UNAVAILABLE",
    files: KEEP,
    after: (r) => write(r, "u.txt", "u\n"),
    paths: { lines: "u.txt", files: "u.txt" },
    categories: { lines: "untracked", files: "untracked" },
  });

  // A staged deletion whose working file stays, so the file is untracked now.
  refusalCase({
    name: "in-the-way",
    reason: "in-the-way",
    code: "WORKBENCH_UNAVAILABLE",
    files: { "f.txt": "f\n", ...KEEP },
    after: (r) => g(r, ["--literal-pathspecs", "rm", "-q", "--cached", "--", "f.txt"]),
    paths: { "staged-files": "f.txt" },
  });

  // A file at the folder name of a staged deletion (plan.md D8 `folders`).
  refusalCase({
    name: "in-the-way-folder",
    reason: "in-the-way",
    code: "WORKBENCH_UNAVAILABLE",
    files: { "d/x.txt": "x\n", ...KEEP },
    after: (r) => {
      g(r, ["--literal-pathspecs", "rm", "-q", "--", "d/x.txt"]);
      write(r, "d", "blocker\n");
    },
    paths: { "staged-files": "d/x.txt" },
  });

  // The working `.gitattributes` gives `eol=crlf`, and the index `.gitattributes` gives no value (research.md R7).
  refusalCase({
    name: "attributes",
    reason: "attributes",
    code: "WORKBENCH_UNAVAILABLE",
    files: { ".gitattributes": "\n", ...AB },
    after: (r) => {
      changeAB(r);
      write(r, ".gitattributes", "*.txt eol=crlf\n");
    },
    paths: ALL_FIVE("a.txt", "b.txt"),
  });
});

describe("revert refusals: the file facts (plan.md D8, D9, data-model §7)", () => {
  const outside = () => fixtureDir(`t043-outside-${++builds}`);

  refusalCase({
    name: "hard-link",
    reason: "hard-link",
    code: "WORKBENCH_UNAVAILABLE",
    files: AB,
    after: changeAB,
    paths: ALL_FIVE("a.txt", "b.txt"),
    arm: (r) => {
      const dir = outside();
      both(r, (p) => linkSync(p, join(dir, `${p.slice(-5)}-link`)));
    },
  });

  // Windows only: FILE_ATTRIBUTE_READONLY. A Linux fact has no attribute word.
  refusalCase({
    name: "read-only",
    reason: "read-only",
    code: "WORKBENCH_UNAVAILABLE",
    needs: ["windows-path-rules"],
    files: AB,
    after: changeAB,
    paths: ALL_FIVE("a.txt", "b.txt"),
    arm: (r) => both(r, (p) => chmodSync(p, 0o444)),
    disarm: (r) => both(r, (p) => chmodSync(p, 0o644)),
  });

  refusalCase({
    name: "file-attributes",
    reason: "file-attributes",
    code: "WORKBENCH_UNAVAILABLE",
    needs: ["windows-path-rules"],
    files: AB,
    after: changeAB,
    paths: ALL_FIVE("a.txt", "b.txt"),
    arm: (r) => both(r, (p) => offline(p, true)),
    disarm: (r) => both(r, (p) => offline(p, false)),
  });

  // A folder at the path of a tracked file. Status lists the file as deleted.
  refusalCase({
    name: "not-regular-folder",
    reason: "not-regular",
    code: "WORKBENCH_UNAVAILABLE",
    files: { "d.txt": "d\n", ...KEEP },
    after: (r) => {
      rmSync(join(r, "d.txt"));
      write(r, "d.txt/inner.txt", "i\n");
    },
    paths: { files: "d.txt", unstaged: "d.txt" },
  });

  // Git for Windows follows a junction as a folder, and the no-follow walk of the shell does not (contract Δ6 `facts`).
  refusalCase({
    name: "not-regular-junction",
    reason: "not-regular",
    code: "WORKBENCH_UNAVAILABLE",
    needs: ["ntfs-junction"],
    files: { "j/a.txt": "a\nb\nc\n", "j/b.txt": "a\nb\nc\n", ...KEEP },
    after: (r) => {
      const target = outside();
      write(target, "a.txt", "a\nB\nc\n");
      write(target, "b.txt", "a\nB\nc\n");
      rmSync(join(r, "j"), { recursive: true });
      symlinkSync(target, join(r, "j"), "junction");
      add(r, "j/b.txt");
    },
    paths: ALL_FIVE("j/a.txt", "j/b.txt"),
  });

  // The fact read of the review fails for a file that the service cannot read. The value names the reason only (revert.ts `unavailable`).
  refusalCase({
    name: "unreadable",
    reason: "unreadable",
    code: "WORKBENCH_UNAVAILABLE",
    needs: ["read-denial"],
    files: AB,
    after: changeAB,
    paths: { files: "a.txt", unstaged: "a.txt" },
    value: { reason: "unreadable" },
    arm: (r) => denyRead(join(r, "a.txt"), true),
    disarm: (r) => denyRead(join(r, "a.txt"), false),
  });
});

describe("revert refusals: repository reasons (data-model §7, plan.md D2)", () => {
  refusalCase({
    name: "nothing-to-revert",
    reason: "nothing-to-revert",
    code: "WORKBENCH_UNAVAILABLE",
    files: AB,
    after: (r) => {
      write(r, "b.txt", "a\nB\nc\n");
      add(r, "b.txt");
    },
    paths: { unstaged: "b.txt" },
    value: { reason: "nothing-to-revert" },
  });

  // Spec Edge Cases: the lock refuses every revert, also one without an index part (001 FR-016).
  refusalCase({
    name: "locked",
    reason: "LOCKED",
    code: "LOCKED",
    files: AB,
    after: changeAB,
    paths: ALL_FIVE("a.txt", "b.txt"),
    value: { path: expect.stringMatching(/index\.lock$/), remedy: { text: LOCKED_REMEDY } },
    arm: (r) => writeFileSync(`${gitPathOf(r, "index")}.lock`, ""),
    disarm: (r) => rmSync(`${gitPathOf(r, "index")}.lock`, { force: true }),
  });

  // The 004 hunk profiles (`file-refusal.test.ts`). The monitor command logs nothing and exits 1, so Git scans the worktree itself.
  const profile = (name: string, reason: keyof typeof PROFILE_TEXTS, config: [string, string][], trust = false, cleanup?: (repo: string) => void) =>
    refusalCase({ name, reason, code: "UNSUPPORTED_HUNK_PROFILE", files: AB, after: changeAB, config, paths: ALL_FIVE("a.txt", "b.txt"), value: { reason, remedy: { text: PROFILE_TEXTS[reason] } }, trust, ...(cleanup === undefined ? {} : { cleanup }) });
  profile("sparse-index", "sparse-index", [["index.sparse", "true"]]);
  profile("split-index", "split-index", [["core.splitIndex", "true"]]);
  profile("executable-monitor", "executable-monitor", [["core.fsmonitor", "exit 1"]], true);
  // Research.md R3 (004): a read can start the built-in daemon. It must not outlive the case.
  profile("unqualified-monitor", "unqualified-monitor", [["core.fsmonitor", "true"]], false, (r) => void faGit(gitPath(), r, ["fsmonitor--daemon", "stop"], { allowExit: [0, 1, 128] }));

  // Plan.md D2 and D7: only an index part refuses with index-change-hook. The actions without one stay available.
  caseTest(TASK, "a post-index-change hook refuses staged-lines and staged-files with index-change-hook; lines, files, and unstaged stay available", SHELL, () =>
    withService({ name: "t043-hook" }, async (service) => {
      const repo = build("hook", AB, (r) => {
        changeAB(r);
        chmodSync(write(gitPathOf(r, "hooks"), "post-index-change", "#!/bin/sh\nexit 0\n"), 0o755);
      });
      const r = await service.register(repo);
      const k: RefusalCase = { name: "hook", reason: "index-change-hook", code: "UNSUPPORTED_HUNK_PROFILE", files: AB, paths: { "staged-lines": "b.txt", "staged-files": "b.txt" }, value: { reason: "index-change-hook", remedy: { text: PROFILE_TEXTS["index-change-hook"] } } };
      for (const act of ["staged-lines", "staged-files"] as const) await expectRefusal(service, r, repo, k, act);
      for (const act of ["lines", "files", "unstaged"] as const) {
        const read = await readOk(service, r.repositoryId);
        const response = await review(service, r, read, await payloadOf(service, r, read, act, "a.txt", "unstaged"));
        expect({ act, ...outcome(response) }).toEqual({ act, ...SUCCEEDED });
      }
    }),
    TIMEOUT_MS,
  );
});

describe("revert refusals: the shell refusals at the write (contract Δ6, plan.md D8, D9)", () => {
  // The double makes no owner and no DACL check (`bun-runner.ts` `replaceWorking`), so a synthetic reply stands for the shell (T012 to T014 test the shell).
  // An action with an index part publishes it first, so its write refusal gives `unstaged-only` (spec FR-017, `revert-staged.test.ts`).
  for (const reason of ["owner", "security"] as const) {
    caseTest(TASK, `a ${reason} refusal of the write changes nothing for lines, files, and unstaged, and names the reason`, SHELL, () =>
      withService({ name: `t043-shell-${reason}` }, async (service) => {
        const repo = build(`shell-${reason}`, AB, changeAB);
        const r = await service.register(repo);
        service.runner.inject.workingReply = () => ({ result: "refused", reason });
        try {
          for (const act of ["lines", "files", "unstaged"] as const) {
            const read = await readOk(service, r.repositoryId);
            const response = await review(service, r, read, await payloadOf(service, r, read, act, "a.txt", "unstaged"));
            expect({ act, ...outcome(response) }).toEqual({ act, ...SUCCEEDED });
            const before = state(repo);
            const token = valuesOf(response.result, "workbenchToken")[0];
            const done = await service.response<{ files: unknown[]; index: string }>(service.send("runWorkbench", { workbenchToken: token, start: true }, { repositoryId: r.repositoryId }));
            expect({ act, result: RunWorkbenchResult.safeParse(done.result).success }).toEqual({ act, result: true });
            expect({ act, ...outcome(done), index: done.result?.index, files: done.result?.files }).toEqual({
              act,
              state: "failed",
              code: "WORKBENCH_UNAVAILABLE",
              index: "none",
              files: [{ entryId: rowOf(read, "a.txt", "unstaged").entryId, outcome: "not-changed", code: "refused", reason }],
            });
            expect({ act, state: state(repo) }).toEqual({ act, state: before });
          }
        } finally {
          service.runner.inject.workingReply = null;
        }
      }),
      TIMEOUT_MS,
    );
  }
});

describe("revert refusals: a partial clone without the HEAD blob (spec FR-005)", () => {
  caseTest(TASK, "Revert file refuses with OBJECT_MISSING and the 001 remedy before any change; no process fetches, and every process has --no-lazy-fetch", SHELL, () =>
    withService({ name: "t043-partial" }, async (service) => {
      const origin = build("partial-origin", { "f.txt": "f1\n", ...KEEP });
      g(origin, ["config", "uploadpack.allowFilter", "true"]);
      const root = fixtureDir(`t043-partial-clone-${++builds}`);
      g(root, ["clone", "-q", "--no-local", "--filter=blob:none", "--no-checkout", `file://${origin.replaceAll("\\", "/")}`, "repo"]);
      const repo = join(root, "repo");
      for (const [key, value] of LINE_ENDINGS) g(repo, ["config", key, value]);
      // `read-tree` reads trees only, and the blob:none clone holds every tree.
      g(repo, ["--no-lazy-fetch", "read-tree", "HEAD"]);
      write(repo, "keep.txt", "keep\n");
      write(repo, "f.txt", "f2\n");
      const oid = g(repo, ["--no-lazy-fetch", "rev-parse", "HEAD:f.txt"]).toString("utf8").trim();
      const check = () => g(repo, ["--no-lazy-fetch", "cat-file", "--batch-check"], `${oid}\n`).toString("utf8");
      expect(check()).toBe(`${oid} missing\n`);
      const r = await service.register(repo);
      const k: RefusalCase = { name: "partial", reason: "object-missing", code: "OBJECT_MISSING", files: {}, paths: { files: "f.txt" }, value: { path: expect.stringMatching(/f\.txt$/), remedy: { text: OBJECT_MISSING_REMEDY } } };
      await expectRefusal(service, r, repo, k, "files");
      // The object stays missing, so no lazy fetch ran. Only the `gitProbe` arrays of the Git selection omit the option (`revert-frame.test.ts`).
      expect(check()).toBe(`${oid} missing\n`);
      const calls = service.runner.calls.map((c) => [...c.arguments]);
      expect({ fetches: calls.filter((a) => subcommand(a) === "fetch"), lazy: calls.filter((a) => a[0] !== "--no-lazy-fetch" && !(a.length <= 2 && (a[0] === "version" || a[0] === "--exec-path"))) }).toEqual({ fetches: [], lazy: [] });
      expect(calls.some((a) => a.includes("--batch-check"))).toBe(true);
    }),
    TIMEOUT_MS,
  );
});
