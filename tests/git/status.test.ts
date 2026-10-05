// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect } from "bun:test";
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as LIMITS from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import { FIXTURE_ROOT, ownedGit, useFixtureRoot } from "./fixture-root";
import { buildF01, buildF02, buildF03, buildF05, buildF06, buildF10, buildF16Status, F16_STATUS_RECORDS, type Built } from "./fixtures";
import { GIT } from "./git-binary";
import type { CallMatch } from "./bun-runner";
import { indexEntries, rawIndexDigest } from "./git-oracle";
import { caseTest, once, openService, type ChangeEntry, type Service, type ServiceResponse, type WorkspaceResult } from "./service-harness";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/git-service/status.ts", import.meta.dir);

const TASK = "T069";
const PAGING = "T284";
const TIMEOUT_MS = 120_000;
const F16_TIMEOUT_MS = 600_000;
const HELD_WAIT_MS = 30_000;

useFixtureRoot();

const gitPath = (): string => {
  if (GIT === null) throw new Error("Git executable absent");
  return GIT;
};

// Contract §9: a `limited` result carries `OUTPUT_LIMIT` with the reached §5 bound as its reason. The reason is the export name in `limits.ts`.
const limitName = <K extends keyof typeof LIMITS>(name: K): K => name;

async function withService(name: string, body: (service: Service) => Promise<void>): Promise<void> {
  const service = await openService({ git: gitPath(), name });
  try {
    await body(service);
  } finally {
    await service.dispose();
  }
}

async function read(service: Service, repo: string): Promise<ServiceResponse<WorkspaceResult>> {
  const { repositoryId } = await service.register(repo);
  return service.readWorkspace(repositoryId);
}

async function readSucceeded(service: Service, repo: string): Promise<WorkspaceResult> {
  const response = await read(service, repo);
  expect({ state: response.state, code: response.code }).toEqual({ state: "succeeded", code: undefined });
  return response.result!;
}

// F05 holds a local `filter.custom.clean`, which blocks reads until approval (contract §7).
async function approve(service: Service, repositoryId: string): Promise<void> {
  const trust = await service.readTrust(repositoryId);
  expect(trust.state).toBe("succeeded");
  expect((await service.approveTrust(repositoryId, trust.result!.fingerprint, trust.result!.generation)).state).toBe("succeeded");
}

const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64");
const outcome = (response: ServiceResponse) => ({ state: response.state, code: response.code });

// Contract §5 "Status page": the encoded result of one page.
const pageBytes = (result: unknown) => Buffer.byteLength(JSON.stringify(result));

// Contract §3: `readWorkspace` returns the first page, and `readEntries` serves each later page from the retained snapshot.
// Each page must hold an entry, so the loop ends after at most `entryCount` pages.
async function allEntries(service: Service, repositoryId: string, first: WorkspaceResult, pageStates: readonly string[]): Promise<ChangeEntry[]> {
  expect(pageBytes(first)).toBeLessThanOrEqual(LIMITS.STATUS_PAGE_BYTES);
  const entries = [...first.entries];
  for (let cursor = first.cursor; cursor !== null; ) {
    const page = await service.readEntries(repositoryId, first.generation, first.snapshotId, cursor);
    expect(pageStates).toContain(page.state);
    expect(page.result!.entries.length).toBeGreaterThan(0);
    expect(pageBytes(page.result)).toBeLessThanOrEqual(LIMITS.STATUS_PAGE_BYTES);
    entries.push(...page.result!.entries);
    expect(entries.length).toBeLessThanOrEqual(first.entryCount);
    cursor = page.result!.cursor;
  }
  expect(entries.length).toBe(first.entryCount);
  expect(new Set(entries.map((e) => e.entryId)).size).toBe(entries.length);
  return entries;
}

const statusCall: CallMatch = (call) => call.arguments.includes("status");
const revListCall: CallMatch = (call) => call.arguments.includes("rev-list");

// Waits until the double records a call of `operationId` that `match` accepts.
async function heldCall(service: Service, operationId: string, match: CallMatch): Promise<void> {
  const until = performance.now() + HELD_WAIT_MS;
  while (!service.runner.calls.some((c) => c.operationId === operationId && match(c))) {
    if (performance.now() > until) throw new Error(`no held call of ${operationId} within ${HELD_WAIT_MS} ms`);
    await Bun.sleep(10);
  }
}

type Category = ChangeEntry["category"];

// The categories of each path, keyed by the base64 of the literal path bytes.
function byPath(entries: { pathBytes: string; category: Category }[]): Record<string, Category[]> {
  const out: Record<string, Category[]> = {};
  for (const e of entries) (out[e.pathBytes] ??= []).push(e.category);
  for (const list of Object.values(out)) list.sort();
  return out;
}

// git-status(1) "Porcelain Format Version 2": the space-separated fields before the path of each record type.
const FIELDS_BEFORE_PATH: Record<string, number> = { "1": 8, "2": 9, u: 10 };

// Oracle: Git's own porcelain v2 records of the same status options, parsed by the git-status(1) record rules.
function oracleCategories(git: string, repo: string, pre: string[] = []): Record<string, Category[]> {
  const out = ownedGit(git, FIXTURE_ROOT, repo, [...pre, "--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--find-renames", "--ignore-submodules=dirty"]);
  const records: Buffer[] = [];
  for (let at = 0; at < out.length; ) {
    const nul = out.indexOf(0, at);
    records.push(out.subarray(at, nul));
    at = nul + 1;
  }
  const entries: { pathBytes: string; category: Category }[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    const kind = String.fromCharCode(record[0]!);
    if (kind === "#" || kind === "!") continue;
    if (kind === "?") {
      entries.push({ pathBytes: b64(record.subarray(2)), category: "untracked" });
      continue;
    }
    const fields = FIELDS_BEFORE_PATH[kind];
    if (fields === undefined) throw new Error(`oracle: unknown status record ${JSON.stringify(record.toString("utf8"))}`);
    let start = 0;
    for (let f = 0; f < fields; f++) start = record.indexOf(0x20, start) + 1;
    const pathBytes = b64(record.subarray(start));
    if (kind === "2") i++;
    if (kind === "u") {
      entries.push({ pathBytes, category: "conflicted" });
      continue;
    }
    const [x, y] = record.subarray(2, 4).toString("latin1");
    if (x !== ".") entries.push({ pathBytes, category: "staged" });
    if (y !== ".") entries.push({ pathBytes, category: "unstaged" });
  }
  return byPath(entries);
}

const f = (built: Built, repo = "repo") => join(built.root, repo);

describe("categories (data-model §5)", () => {
  caseTest(
    TASK,
    "F02: one path appears in Staged and in Unstaged",
    ["shell-double"],
    () =>
      withService("t069-f02", async (service) => {
        const git = gitPath();
        const built = buildF02(git, "t069-f02");
        const result = await readSucceeded(service, f(built));
        const categories = byPath(result.entries);
        expect(categories[b64("multi.txt")]).toEqual(["staged", "unstaged"]);
        expect(categories).toEqual(oracleCategories(git, f(built)));
        const multi = result.entries.filter((e) => e.path === "multi.txt");
        expect(new Set(multi.map((e) => e.entryId)).size).toBe(2);
        expect(result.completeness.state).toBe("complete");
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "F06: a staged deletion and an untracked replacement are separate entries",
    ["shell-double"],
    () =>
      withService("t069-f06", async (service) => {
        const git = gitPath();
        const built = buildF06(git, "t069-f06");
        const result = await readSucceeded(service, f(built));
        const replaced = result.entries.filter((e) => e.pathBytes === b64("replaced.txt"));
        expect(replaced.map((e) => e.category).sort()).toEqual(["staged", "untracked"]);
        expect(replaced[0]!.entryId).not.toBe(replaced[1]!.entryId);
        expect(byPath(result.entries)).toEqual(oracleCategories(git, f(built)));
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "F01: an empty repository gives a complete clean result",
    ["shell-double"],
    () =>
      withService("t069-f01", async (service) => {
        const built = buildF01(gitPath(), "t069-f01", "empty");
        const result = await readSucceeded(service, f(built));
        expect({ completeness: result.completeness.state, entries: result.entries, head: result.head }).toEqual({
          completeness: "complete",
          entries: [],
          head: { state: "unborn", target: "refs/heads/main" },
        });
      }),
    TIMEOUT_MS,
  );
});

describe("F03 path identity (data-model §5)", () => {
  // The F03 builder names: Unicode with a space, a bracket name, and the changed option-like name.
  const LITERAL = ["space dir/雪 café.txt", "[abc].txt", "-rf"];

  caseTest(
    TASK,
    "F03: Unicode, spaced, bracket, and option-like names keep their literal identity",
    ["shell-double"],
    () =>
      withService("t069-f03-names", async (service) => {
        const git = gitPath();
        const built = buildF03(git, "t069-f03-names");
        const result = await readSucceeded(service, f(built));
        const oracle = oracleCategories(git, f(built));
        const categories = byPath(result.entries);
        for (const name of LITERAL) {
          const entries = result.entries.filter((e) => e.pathBytes === b64(name));
          expect({ name, count: entries.length > 0 }).toEqual({ name, count: true });
          expect({ name, paths: entries.map((e) => e.path), categories: categories[b64(name)] }).toEqual({
            name,
            paths: entries.map(() => name),
            categories: oracle[b64(name)],
          });
        }
        // `[abc].txt` stays literal, so its glob match `a.txt` gets no entry. The unchanged `--output=x` gets none either.
        expect({ glob: categories[b64("a.txt")], option: categories[b64("--output=x")] }).toEqual({ glob: oracle[b64("a.txt")], option: oracle[b64("--output=x")] });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "F03: an index path with invalid UTF-8 bytes displays \\xNN escapes and keeps its raw bytes",
    ["shell-double"],
    () =>
      withService("t069-f03-invalid", async (service) => {
        const git = gitPath();
        const built = buildF03(git, "t069-f03-invalid");
        const raw = Buffer.from(built.facts.notes.invalidUtf8IndexPath as string, "hex");
        expect(raw.includes(0xff)).toBe(true);
        const result = await readSucceeded(service, f(built));
        const entries = result.entries.filter((e) => e.pathBytes === b64(raw));
        expect(entries.map((e) => e.category).sort()).toEqual(oracleCategories(git, f(built))[b64(raw)]!);
        // Data-model §5 fixes the `\xNN` form, not the letter case of the hex digits.
        for (const e of entries) expect(e.path).toMatch(/^bad-\\x(ff|FF)\.txt$/);
      }),
    TIMEOUT_MS,
  );
});

describe("F10 conflicts and index flags", () => {
  // Data-model §2 lists the `operationState` values. It fixes no precedence between "conflicted" and the operation value.
  const OPERATIONS = [
    ["merge", "merging"],
    ["rebase", "rebasing"],
    ["cherry-pick", "cherry-picking"],
    ["revert", "reverting"],
  ] as const;

  for (const [variant, operation] of OPERATIONS) {
    caseTest(
      TASK,
      `F10 ${variant}: conflicted entries go to Conflicted, and operationState names the unfinished operation`,
      ["shell-double"],
      () =>
        withService(`t069-f10-${variant}`, async (service) => {
          const git = gitPath();
          const built = buildF10(git, `t069-f10-${variant}`, variant);
          const result = await readSucceeded(service, f(built));
          const categories = byPath(result.entries);
          for (const path of built.facts.repos.repo!.conflicted) expect({ path, categories: categories[b64(path)] }).toEqual({ path, categories: ["conflicted"] });
          expect(categories).toEqual(oracleCategories(git, f(built)));
          expect(["conflicted", operation]).toContain(result.operationState);
        }),
      TIMEOUT_MS,
    );
  }

  caseTest(
    TASK,
    "F10 flags: intent-to-add, assume-unchanged, and skip-worktree entries show their Git status and flags",
    ["shell-double"],
    () =>
      withService("t069-f10-flags", async (service) => {
        const git = gitPath();
        const built = buildF10(git, "t069-f10-flags", "flags");
        const repo = f(built);
        // Git status hides an assume-unchanged or skip-worktree change. The service must follow Git, not the file system.
        writeFileSync(join(repo, "keep.txt"), "keep changed\n");
        rmSync(join(repo, "conflict.txt"), { force: true });
        const result = await readSucceeded(service, repo);
        expect(byPath(result.entries)).toEqual(oracleCategories(git, repo));
        const oracle = new Map(indexEntries(git, repo).filter((e) => e.stage === 0).map((e) => [b64(e.path), e]));
        for (const e of result.entries) {
          const index = oracle.get(e.pathBytes);
          if (index === undefined) continue;
          expect({ path: e.path, flags: e.flags }).toEqual({
            path: e.path,
            flags: { intentToAdd: index.intentToAdd, assumeUnchanged: index.assumeUnchanged, skipWorktree: index.skipWorktree },
          });
        }
        expect(result.entries.find((e) => e.path === "ita.txt")?.flags.intentToAdd).toBe(true);
      }),
    TIMEOUT_MS,
  );
});

describe("F05 submodules (contract §7)", () => {
  const submoduleCanaries = (built: Built) =>
    Object.entries(built.facts.canaries)
      .filter(([name]) => name.startsWith("super-sub-"))
      .map(([, log]) => join(built.root, log));

  caseTest(
    TASK,
    "F05: a gitlink appears only when its checked-out or staged commit differs from the recorded commit, and no submodule canary runs",
    ["shell-double"],
    () =>
      withService("t069-f05", async (service) => {
        const git = gitPath();
        const built = buildF05(git, "t069-f05");
        const repo = f(built, "super");
        const logs = submoduleCanaries(built);
        expect(logs.length).toBe(4);
        const subs = built.facts.notes.submodules as Record<"sub-same" | "sub-moved", { recorded: string; checkedOut: string }>;
        const { repositoryId } = await service.register(repo);
        await approve(service, repositoryId);
        const first = await service.readWorkspace(repositoryId);
        expect(first.state).toBe("succeeded");
        expect(logs.filter((log) => existsSync(log))).toEqual([]);
        const categories = byPath(first.result!.entries);
        // `sub-moved` has another checked-out commit, so it is unstaged. `sub-same` matches.
        expect({ moved: categories[b64("sub-moved")], same: b64("sub-same") in categories }).toEqual({ moved: ["unstaged"], same: false });

        // A staged gitlink commit that differs from HEAD. `update-index --cacheinfo` starts no Git inside the submodule.
        ownedGit(git, FIXTURE_ROOT, repo, ["update-index", "--cacheinfo", `160000,${subs["sub-moved"].checkedOut},sub-moved`]);
        const second = await service.readWorkspace(repositoryId);
        expect(second.state).toBe("succeeded");
        expect(logs.filter((log) => existsSync(log))).toEqual([]);
        const after = byPath(second.result!.entries);
        expect({ moved: after[b64("sub-moved")], same: b64("sub-same") in after }).toEqual({ moved: ["staged"], same: false });
        for (const call of service.runner.calls.filter((c) => c.arguments.includes("status") || c.arguments.includes("diff-files"))) {
          expect(call.arguments).toContain("--ignore-submodules=dirty");
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "OBSERVATION: whether diff-files -z --ignore-submodules=dirty starts no child when the submodule HEAD matches",
    [],
    () => {
      const git = gitPath();
      const built = buildF05(git, "t069-trace2");
      const repo = f(built, "super");
      const version = ownedGit(git, FIXTURE_ROOT, repo, ["version"]).toString().trim();
      // `facts.disarm` keeps the superproject clean filter canary from starting a child.
      const childStarts = (label: string, args: string[]) => {
        const trace = join(built.root, `trace2-${label}.json`);
        ownedGit(git, FIXTURE_ROOT, repo, [...built.facts.disarm, "--no-optional-locks", "--literal-pathspecs", ...args], { env: { GIT_TRACE2_EVENT: trace } });
        const events = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { event: string; argv?: string[] });
        expect(events.some((e) => e.event === "start")).toBe(true);
        return events.filter((e) => e.event === "child_start").map((e) => (e.argv ?? []).join(" "));
      };
      const matched = childStarts("matched", ["diff-files", "-z", "--ignore-submodules=dirty", "--", "sub-same"]);
      const whole = childStarts("whole", ["diff-files", "-z", "--ignore-submodules=dirty"]);
      // Control: without the option, Git checks the submodule worktree through a child, so the trace sees children.
      const control = childStarts("control", ["diff-files", "-z", "--", "sub-same"]);
      expect(control.length).toBeGreaterThan(0);
      console.log(`OBSERVATION ${TASK}: ${version}: diff-files -z --ignore-submodules=dirty on F05 sub-same (submodule HEAD matches) started ${matched.length} child processes${matched.length > 0 ? `: ${matched.join(" | ")}` : ""}`);
      console.log(`OBSERVATION ${TASK}: ${version}: diff-files -z --ignore-submodules=dirty on all of F05 (sub-moved HEAD differs) started ${whole.length} child processes`);
      console.log(`OBSERVATION ${TASK}: ${version}: control diff-files -z without --ignore-submodules=dirty on sub-same started ${control.length} child processes`);
    },
    TIMEOUT_MS,
  );
});

describe("F16 status bounds (contract §5)", () => {
  caseTest(
    TASK,
    `F16: more than ${LIMITS.STATUS_LISTING_RECORDS} records give completeness limited with reason STATUS_LISTING_RECORDS, never an empty success, in pages within the Status page bound`,
    ["shell-double"],
    () =>
      withService("t069-f16-over", async (service) => {
        const built = buildF16Status(gitPath(), "t069-f16-over", "over-limit");
        expect(built.facts.notes.records).toBe(LIMITS.STATUS_LISTING_RECORDS + 1);
        const { repositoryId } = await service.register(f(built));
        const response = await service.readWorkspace(repositoryId);
        expect(outcome(response)).toEqual({ state: "limited", code: "OUTPUT_LIMIT" });
        expect(response.result!.completeness).toMatchObject({ state: "limited", reason: limitName("STATUS_LISTING_RECORDS") });
        // Contract §3 fixes no page state for a limited snapshot.
        const entries = await allEntries(service, repositoryId, response.result!, ["succeeded", "limited"]);
        expect(entries.length).toBeGreaterThan(0);
        expect(entries.length).toBeLessThanOrEqual(LIMITS.STATUS_LISTING_RECORDS);
      }),
    F16_TIMEOUT_MS,
  );

  caseTest(
    TASK,
    `F16: exactly ${LIMITS.STATUS_LISTING_RECORDS} records give a complete result in pages within the Status page bound; each readEntries page ends succeeded while a readHistory and a readWorkspace of the workspace wait at the stdout barrier`,
    ["shell-double"],
    () =>
      withService("t069-f16-at", async (service) => {
        const built = buildF16Status(gitPath(), "t069-f16-at", "at-limit");
        expect(F16_STATUS_RECORDS).toBe(LIMITS.STATUS_LISTING_RECORDS);
        const { repositoryId } = await service.register(f(built));
        const first = await service.readWorkspace(repositoryId);
        expect(outcome(first)).toEqual({ state: "succeeded", code: undefined });
        const result = first.result!;
        expect({ completeness: result.completeness.state, entryCount: result.entryCount }).toEqual({ completeness: "complete", entryCount: LIMITS.STATUS_LISTING_RECORDS });
        // Contract §5 "Concurrent reads": the two held reads take both read slots of the workspace. `readEntries` takes no slot and never waits in the pending queue.
        const releaseStatus = service.runner.pauseStdout(once(statusCall));
        const releaseHistory = service.runner.pauseStdout(once(revListCall));
        let held: string[] = [];
        try {
          held = [
            service.send("readHistory", {}, { repositoryId, repositoryGeneration: result.generation }),
            service.send("readWorkspace", { refresh: false, check: "full" }, { repositoryId }),
          ];
          const [history, workspace] = await Promise.all(held.map((requestId) => service.operationId(requestId)));
          await heldCall(service, history!, revListCall);
          await heldCall(service, workspace!, statusCall);
          const calls = service.runner.calls.length;
          const entries = await allEntries(service, repositoryId, result, ["succeeded"]);
          expect(entries.length).toBe(LIMITS.STATUS_LISTING_RECORDS);
          // Contract §3: `readEntries` starts no Git process.
          expect(service.runner.calls.slice(calls).filter((c) => c.operationId !== history && c.operationId !== workspace)).toEqual([]);
          expect(held.map((requestId) => service.responseAt.has(requestId))).toEqual([false, false]);
        } finally {
          releaseStatus();
          releaseHistory();
        }
        for (const requestId of held) expect(outcome(await service.response(requestId))).toEqual({ state: "succeeded", code: undefined });
      }),
    F16_TIMEOUT_MS,
  );

  // Real Git headers of the repository, so only the injected records differ from a real listing.
  const headers = (git: string, repo: string): Buffer => {
    const out = ownedGit(git, FIXTURE_ROOT, repo, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=no"]);
    return Buffer.concat(out.toString("latin1").split("\0").filter((r) => r.startsWith("# ")).map((r) => Buffer.from(`${r}\0`, "latin1")));
  };
  const isStatus = (args: readonly string[]) => args.includes("status") && args.includes("--porcelain=v2");

  caseTest(
    TASK,
    `a status listing of ${LIMITS.STATUS_LISTING_BYTES} bytes plus one gives completeness limited with reason STATUS_LISTING_BYTES`,
    ["shell-double"],
    () =>
      withService("t069-bytes", async (service) => {
        const git = gitPath();
        const built = buildF02(git, "t069-bytes");
        const head = headers(git, f(built));
        // Untracked records of 4,096 bytes each stay far below the record bound. The last record fills the total to the bound plus one byte.
        const RECORD = 4096;
        const body = LIMITS.STATUS_LISTING_BYTES + 1 - head.length;
        const count = Math.floor(body / RECORD) - 1;
        const records: Buffer[] = [head];
        for (let i = 0; i < count; i++) records.push(Buffer.from(`? u/${String(i).padStart(6, "0")}${"a".repeat(RECORD - 11)}\0`));
        records.push(Buffer.from(`? v/${"b".repeat(body - count * RECORD - 5)}\0`));
        const listing = Buffer.concat(records);
        expect(listing.length).toBe(LIMITS.STATUS_LISTING_BYTES + 1);
        expect(count + 1).toBeLessThan(LIMITS.STATUS_LISTING_RECORDS);
        let injected = 0;
        service.runner.inject.stdout = (call) => (isStatus(call.arguments) ? (injected++, listing) : undefined);
        const response = await read(service, f(built));
        expect(injected).toBeGreaterThan(0);
        expect({ state: response.state, code: response.code }).toEqual({ state: "limited", code: "OUTPUT_LIMIT" });
        expect(response.result!.completeness).toMatchObject({ state: "limited", reason: limitName("STATUS_LISTING_BYTES") });
      }),
    TIMEOUT_MS,
  );

  // git-status(1) porcelain v2: each malformed record breaks one record rule.
  const MALFORMED: [string, string][] = [
    ["an unknown record type", "Z junk\0"],
    ["a changed record with non-hex object IDs", "1 .M N... 100644 100644 100644 zzzz yyyy multi.txt\0"],
    ["a changed record with too few fields", "1 .M N...\0"],
    ["a final record without its NUL terminator", "? unterminated.txt"],
  ];

  for (const [label, record] of MALFORMED) {
    caseTest(
      TASK,
      `a malformed status record (${label}) gives MALFORMED_GIT_OUTPUT, never a clean result`,
      ["shell-double"],
      () =>
        withService(`t069-malformed-${label.replaceAll(" ", "-")}`, async (service) => {
          const git = gitPath();
          const built = buildF02(git, `t069-malformed-${label.replaceAll(" ", "-")}`);
          const listing = Buffer.concat([headers(git, f(built)), Buffer.from(record)]);
          service.runner.inject.stdout = (call) => (isStatus(call.arguments) ? listing : undefined);
          const response = await read(service, f(built));
          expect({ state: response.state, code: response.code }).toEqual({ state: "failed", code: "MALFORMED_GIT_OUTPUT" });
          if (response.result !== undefined) expect(response.result.completeness.state).not.toBe("complete");
        }),
      TIMEOUT_MS,
    );
  }
});

describe("readEntries (contract §3, data-model §4)", () => {
  caseTest(
    PAGING,
    "readEntries checks the generation first, then the snapshot, then the cursor, and starts no Git process",
    ["shell-double"],
    () =>
      withService("t284-checks", async (service) => {
        const git = gitPath();
        const repo = f(buildF02(git, "t284-checks"));
        const { repositoryId } = await service.register(repo);
        const fullRead = async () => {
          const response = await service.readWorkspace(repositoryId);
          expect(outcome(response)).toEqual({ state: "succeeded", code: undefined });
          return response.result!;
        };
        const old = await fullRead();
        expect({ cursor: old.cursor, entryCount: old.entryCount }).toEqual({ cursor: null, entryCount: old.entries.length });
        const entries = async (generation: number, snapshotId: string) => {
          const calls = service.runner.calls.length;
          const response = await service.readEntries(repositoryId, generation, snapshotId, crypto.randomUUID());
          expect(service.runner.calls.length).toBe(calls);
          return response.code;
        };
        // An equal full read replaces the retained snapshot and keeps the generation.
        const same = await fullRead();
        expect(same.generation).toBe(old.generation);
        expect(await entries(same.generation, old.snapshotId)).toBe("UNKNOWN_TARGET");
        // Contract §2: a well-formed cursor that this snapshot did not issue.
        expect(await entries(same.generation, same.snapshotId)).toBe("UNKNOWN_TARGET");
        // A staged change advances the generation. The generation check comes before the snapshot check.
        writeFileSync(join(repo, "keep.txt"), "keep staged\n");
        ownedGit(git, FIXTURE_ROOT, repo, ["add", "--", "keep.txt"]);
        const changed = await fullRead();
        expect(changed.generation).toBe(same.generation + 1);
        expect(await entries(same.generation, changed.snapshotId)).toBe("REPOSITORY_CHANGED");
        expect(await entries(same.generation, crypto.randomUUID())).toBe("REPOSITORY_CHANGED");
      }),
    TIMEOUT_MS,
  );
});

describe("index bytes (contract §7)", () => {
  caseTest(
    TASK,
    "a status read leaves the raw index bytes unchanged, also with stat-dirty files that Git could refresh",
    ["shell-double"],
    () =>
      withService("t069-index-bytes", async (service) => {
        const git = gitPath();
        const built = buildF02(git, "t069-index-bytes");
        const repo = f(built);
        // Same content with a new time: a status without --no-optional-locks would rewrite the index.
        const later = new Date(Date.now() + 60_000);
        for (const path of ["keep.txt", "other-a.txt"]) utimesSync(join(repo, path), later, later);
        const before = rawIndexDigest(git, repo);
        expect(before).not.toBeNull();
        const { repositoryId } = await service.register(repo);
        for (let i = 0; i < 2; i++) expect((await service.readWorkspace(repositoryId, { refresh: i === 1, check: "full" })).state).toBe("succeeded");
        expect(rawIndexDigest(git, repo)).toBe(before);
      }),
    TIMEOUT_MS,
  );
});
