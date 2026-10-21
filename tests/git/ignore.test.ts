// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T026: Add to .gitignore and Add to info/exclude (spec FR-045, FR-046, contract Δ3 `ignore`, Δ6 `fileAppend`, data-model §7, quickstart.md Q17).
// `git check-ignore` and the file bytes are the oracle. `fileAppend` runs in the shell test double below, by the contract Δ6 Windows rules.

import { describe, expect } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChangeEntry } from "../../src/contracts/envelope";
import type { WalkStop } from "../../src/git-service/git-runner";
import type { FileAppender, FileAppendReply, FileAppendRequest, IgnorePlan } from "../../src/git-service/ignore";
import type { Workspace } from "../../src/git-service/registration";
import { printOrigin } from "../origin";
import { fixtureDir, fixtureEnv, useFixtureRoot } from "./fixture-root";
import { put } from "./fixtures";
import { git, gitPath, readOk, withService as hunkService } from "./hunk-harness";
import { caseTest, keepConfigs, type Capability, type Service, type WorkspaceResult } from "./service-harness";
import { buildWorkbench } from "./workbench-fixtures";

// SC-009 (T096): each case keeps the bytes of every configuration file of the repositories that it registers.
const withService = (options: Parameters<typeof hunkService>[0], body: (service: Service) => Promise<void>) => hunkService(options, (service) => keepConfigs(service, body));

const TASK = "T026";
const SHELL: Capability[] = ["shell-double"];
const TIMEOUT_MS = 120_000;

useFixtureRoot();

// Prints the ORIGIN line of the module under test and loads it. Before T032, the module is missing, and this throws.
async function underTest(): Promise<typeof import("../../src/git-service/ignore")> {
  printOrigin("../../src/git-service/ignore.ts", import.meta.dir);
  return import("../../src/git-service/ignore");
}

let builds = 0;
const tree = () => buildWorkbench(gitPath(), "staging-tree", `t026-tree-${++builds}`).repo;

interface Opened {
  service: Service;
  repositoryId: string;
  workspace: Workspace;
  read: WorkspaceResult;
}

// The registered workspace of `repo` as the service sees it. The double binds `gitInstallationId` to each registered run.
async function open(service: Service, repo: string): Promise<Opened> {
  const { repositoryId } = await service.register(repo);
  let gitInstallationId: string | undefined;
  const release = service.runner.holdStart((call) => {
    gitInstallationId ??= (call as unknown as { context: { gitInstallationId?: string } }).context.gitInstallationId;
    return false;
  });
  const read = await readOk(service, repositoryId);
  release();
  const { worktreeRoot, gitDirectory, commonDirectory, indexPath, objectFormat, refFormat } = read.identity;
  const workspace = { repositoryId, gitInstallationId: gitInstallationId!, worktreeRoot, gitDirectory, commonDirectory, indexPath, objectFormat, refFormat, generation: read.generation, head: read.head } as unknown as Workspace;
  return { service, repositoryId, workspace, read };
}

const context = (o: Opened) => ({ runner: o.service.runner, operationId: crypto.randomUUID(), signal: new AbortController().signal, workspace: o.workspace });
const entryOf = (read: WorkspaceResult, path: string) => read.entries.find((e) => e.path === path && e.category === "untracked") as ChangeEntry | undefined;
// An untracked entry for a name that NTFS cannot hold, such as `*`, `?`, or a trailing space. The review reads no file of the entry.
const nameEntry = (path: string): ChangeEntry => ({ entryId: crypto.randomUUID(), category: "untracked", path, pathBytes: Buffer.from(path).toString("base64"), flags: { intentToAdd: false, assumeUnchanged: false, skipWorktree: false } });

// Contract Δ6 `fileAppend` through the shell double of `bun-runner.ts`. The shell admits it only under a `started` marker of the target's action.
function appendDouble(o: Opened, order: string[]): FileAppender & { calls: FileAppendRequest[] } {
  const calls: FileAppendRequest[] = [];
  const runner = o.service.runner;
  return {
    calls,
    async fileAppend(request, signal): Promise<FileAppendReply | WalkStop> {
      calls.push(request);
      order.push("fileAppend");
      const action = request.target === "gitignore" ? "ignore-gitignore" : "ignore-exclude";
      const marked = await runner.started({ operationId: request.operationId, repositoryId: request.repositoryId, kind: "workbench", action, worktreeRoot: o.workspace.worktreeRoot, commonDirectory: o.workspace.commonDirectory });
      try {
        return await runner.fileAppend(request, signal);
      } finally {
        if ("markerId" in marked) runner.resolved(marked.markerId);
      }
    },
  };
}

// `git check-ignore -v -z` (git-check-ignore(1)): exit 0 and `<source> NUL <line> NUL <pattern> NUL <path> NUL` for an ignored path.
function checkIgnore(repo: string, path: string): { exit: number; pattern?: string; source?: string } {
  const result = Bun.spawnSync([gitPath(), "--no-optional-locks", "check-ignore", "-v", "-z", "--no-index", "--stdin"], { cwd: repo, env: fixtureEnv(), stdin: Buffer.from(`${path}\0`), stdout: "pipe", stderr: "pipe" });
  const [source, , pattern] = result.stdout.toString("utf8").split("\0");
  return { exit: result.exitCode ?? -1, ...(result.exitCode === 0 ? { pattern, source } : {}) };
}

const bytesOf = (path: string) => (lstatSync(path, { throwIfNoEntry: false }) === undefined ? null : readFileSync(path).toString("latin1"));

// One review and one run. Returns the plan, the outcome, and the order of the append and the status read.
async function addLine(o: Opened, entry: ChangeEntry, target: "gitignore" | "exclude", folder: string | null = null) {
  const { reviewIgnore, runIgnore } = await underTest();
  const review = await reviewIgnore(context(o), entry, target, folder === null ? null : Buffer.from(folder));
  if (!("plan" in review)) throw new Error(`review refused: ${JSON.stringify(review)}`);
  const order: string[] = [];
  const appender = appendDouble(o, order);
  const outcome = await runIgnore({ ...context(o), appender }, review.plan, async () => {
    order.push("status");
    return readOk(o.service, o.repositoryId);
  });
  return { plan: review.plan as IgnorePlan, outcome, order, calls: appender.calls };
}

describe("the line, the target, and the LF rule (spec FR-046, plan.md D9)", () => {
  caseTest(TASK, `a file and a folder go into the root .gitignore with the anchored line and LF, check-ignore matches each path, and the status read after the append leaves them out`, SHELL, () =>
    withService({ name: "t026-gitignore" }, async (service) => {
      const repo = tree();
      const o = await open(service, repo);
      const file = await addLine(o, entryOf(o.read, "top-new.txt")!, "gitignore");
      expect({ line: file.plan.line, bytes: bytesOf(join(repo, ".gitignore")), order: file.order, type: file.outcome.type }).toEqual({ line: "/top-new.txt", bytes: "/top-new.txt\n", order: ["fileAppend", "status"], type: "intended-effects-confirmed" });
      expect(checkIgnore(repo, "top-new.txt")).toEqual({ exit: 0, pattern: "/top-new.txt", source: ".gitignore" });
      const afterFile = file.outcome.status;
      expect(afterFile.entries.some((e) => e.path === "top-new.txt")).toBe(false);
      const o2 = await open(service, repo);
      const folder = await addLine(o2, entryOf(o2.read, "src/new-dir/n1.txt")!, "gitignore", "src/new-dir");
      expect({ line: folder.plan.line, folder: folder.plan.folder, bytes: bytesOf(join(repo, ".gitignore")) }).toEqual({ line: "/src/new-dir/", folder: true, bytes: "/top-new.txt\n/src/new-dir/\n" });
      for (const path of ["src/new-dir/n1.txt", "src/new-dir/n2.txt"]) expect({ path, ...checkIgnore(repo, path) }).toEqual({ path, exit: 0, pattern: "/src/new-dir/", source: ".gitignore" });
      expect(folder.outcome.status.entries.filter((e) => e.path.startsWith("src/new-dir/"))).toEqual([]);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `a file without a final LF gets one LF before the line; a name with [ and a name with *, ?, and trailing spaces get backslash escapes that check-ignore matches`, SHELL, () =>
    withService({ name: "t026-escapes" }, async (service) => {
      const repo = tree();
      put(repo, ".gitignore", "*.log");
      put(repo, "br[ack]et.txt", "bracket\n");
      const o = await open(service, repo);
      const bracket = await addLine(o, entryOf(o.read, "br[ack]et.txt")!, "gitignore");
      expect({ line: bracket.plan.line, prefix: bracket.plan.prefixNewline, bytes: bytesOf(join(repo, ".gitignore")) }).toEqual({ line: "/br\\[ack]et.txt", prefix: true, bytes: "*.log\n/br\\[ack]et.txt\n" });
      expect(checkIgnore(repo, "br[ack]et.txt")).toEqual({ exit: 0, pattern: "/br\\[ack]et.txt", source: ".gitignore" });
      expect(bracket.outcome.status.entries.some((e) => e.path === "br[ack]et.txt")).toBe(false);
      const odd = "odd/a*b?c  ";
      const o2 = await open(service, repo);
      const named = await addLine(o2, nameEntry(odd), "gitignore");
      expect({ line: named.plan.line, prefix: named.plan.prefixNewline }).toEqual({ line: "/odd/a\\*b\\?c\\ \\ ", prefix: false });
      expect(checkIgnore(repo, odd)).toEqual({ exit: 0, pattern: "/odd/a\\*b\\?c\\ \\ ", source: ".gitignore" });
      // Without the escapes, `*` and `?` would match this name too.
      expect(checkIgnore(repo, "odd/aXbYc  ")).toEqual({ exit: 1 });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `info/exclude takes the line at the path that Git names; in a linked worktree that is the main worktree file (research.md R21 F23), and check-ignore in the linked worktree honors it`, SHELL, () =>
    withService({ name: "t026-exclude" }, async (service) => {
      const repo = tree();
      const exclude = join(repo, ".git", "info", "exclude");
      const before = bytesOf(exclude) ?? "";
      const o = await open(service, repo);
      const main = await addLine(o, entryOf(o.read, "top-new.txt")!, "exclude");
      expect({ file: resolve(main.plan.file), bytes: bytesOf(exclude), type: main.outcome.type }).toEqual({ file: resolve(exclude), bytes: `${before}${before === "" || before.endsWith("\n") ? "" : "\n"}/top-new.txt\n`, type: "intended-effects-confirmed" });
      expect(checkIgnore(repo, "top-new.txt").exit).toBe(0);
      const linked = join(fixtureDir("t026-exclude-linked"), "wt");
      git(repo, ["worktree", "add", "-q", "--detach", "--", linked, "HEAD"]);
      put(linked, "linked-only.txt", "linked\n");
      const ol = await open(service, linked);
      const fromLinked = await addLine(ol, entryOf(ol.read, "linked-only.txt")!, "exclude");
      expect(resolve(fromLinked.plan.file)).toBe(resolve(exclude));
      expect(bytesOf(exclude)!.endsWith("/top-new.txt\n/linked-only.txt\n")).toBe(true);
      expect(checkIgnore(linked, "linked-only.txt").exit).toBe(0);
      expect(fromLinked.outcome.status.entries.some((e) => e.path === "linked-only.txt")).toBe(false);
    }),
    TIMEOUT_MS,
  );
});

describe("refusals change no byte (spec FR-046, contract Δ9)", () => {
  // The review refuses with WORKBENCH_UNAVAILABLE and `reason`. The target bytes stay.
  async function refusedReview(o: Opened, entry: ChangeEntry, target: "gitignore" | "exclude", expected: { code: string; reason?: string }) {
    const { reviewIgnore } = await underTest();
    const file = target === "gitignore" ? join(o.workspace.worktreeRoot, ".gitignore") : join(o.workspace.commonDirectory, "info", "exclude");
    const before = lstatSync(file, { throwIfNoEntry: false })?.isFile() ? readFileSync(file) : null;
    const review: unknown = await reviewIgnore(context(o), entry, target);
    expect({ path: entry.path, review }).toEqual({ path: entry.path, review: expected });
    expect(lstatSync(file, { throwIfNoEntry: false })?.isFile() ? readFileSync(file) : null).toEqual(before);
  }

  caseTest(TASK, `an existing equal line gives ignore-exists, also with CRLF, a UTF-8 BOM, and trailing spaces that Git trims`, SHELL, () =>
    withService({ name: "t026-exists" }, async (service) => {
      for (const [i, text] of ["/top-new.txt\n", "# x\r\n/top-new.txt\r\n", "﻿/top-new.txt", "a\n/top-new.txt   \n"].entries()) {
        const repo = tree();
        writeFileSync(join(repo, ".gitignore"), text);
        const o = await open(service, repo);
        await refusedReview(o, entryOf(o.read, "top-new.txt") ?? nameEntry("top-new.txt"), "gitignore", { code: "WORKBENCH_UNAVAILABLE", reason: "ignore-exists" });
        expect({ i, ignored: checkIgnore(repo, "top-new.txt").exit }).toEqual({ i, ignored: 0 });
      }
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `a folder named .gitignore gives ignore-not-regular, a file above 1 MiB gives ignore-size, and invalid UTF-8 or a NUL gives ignore-not-text`, SHELL, () =>
    withService({ name: "t026-refusals" }, async (service) => {
      const cases: [string, (repo: string) => void, string][] = [
        ["folder", (repo) => mkdirSync(join(repo, ".gitignore")), "ignore-not-regular"],
        ["size", (repo) => writeFileSync(join(repo, ".gitignore"), Buffer.alloc(1_048_577, 0x61)), "ignore-size"],
        ["utf8", (repo) => writeFileSync(join(repo, ".gitignore"), Uint8Array.of(0x2f, 0xff, 0x0a)), "ignore-not-text"],
        ["nul", (repo) => writeFileSync(join(repo, ".gitignore"), Uint8Array.of(0x2f, 0x61, 0x00, 0x0a)), "ignore-not-text"],
      ];
      for (const [name, make, reason] of cases) {
        const repo = tree();
        make(repo);
        const o = await open(service, repo);
        await refusedReview(o, nameEntry(`refused-${name}.txt`), "gitignore", { code: "WORKBENCH_UNAVAILABLE", reason });
      }
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `a symbolic link at .gitignore gives ignore-not-regular and its target stays`, [...SHELL, "symlink"], () =>
    withService({ name: "t026-link" }, async (service) => {
      const repo = tree();
      const target = join(fixtureDir("t026-link-target"), "outside.txt");
      writeFileSync(target, "/outside\n");
      symlinkSync(target, join(repo, ".gitignore"));
      const o = await open(service, repo);
      await refusedReview(o, nameEntry("linked.txt"), "gitignore", { code: "WORKBENCH_UNAVAILABLE", reason: "ignore-not-regular" });
      expect(readFileSync(target, "utf8")).toBe("/outside\n");
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `a tracked entry gives INVALID_REQUEST, and a path with a control character gives reason path`, SHELL, () =>
    withService({ name: "t026-invalid" }, async (service) => {
      const repo = tree();
      const o = await open(service, repo);
      const tracked = o.read.entries.find((e) => e.category === "unstaged")!;
      await refusedReview(o, tracked as ChangeEntry, "gitignore", { code: "INVALID_REQUEST" });
      await refusedReview(o, nameEntry("bad\tname.txt"), "gitignore", { code: "WORKBENCH_UNAVAILABLE", reason: "path" });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `a target that changes after the review gets the shell reply stale, no-effects with STALE_REVIEW, the changed bytes stay, and the status read still follows`, SHELL, () =>
    withService({ name: "t026-stale" }, async (service) => {
      const repo = tree();
      put(repo, ".gitignore", "*.log\n");
      const o = await open(service, repo);
      const { reviewIgnore, runIgnore } = await underTest();
      const review = await reviewIgnore(context(o), entryOf(o.read, "top-new.txt")!, "gitignore");
      if (!("plan" in review)) throw new Error(JSON.stringify(review));
      writeFileSync(join(repo, ".gitignore"), "*.log\n*.tmp\n");
      const order: string[] = [];
      const outcome = await runIgnore({ ...context(o), appender: appendDouble(o, order) }, review.plan, async () => {
        order.push("status");
        return null;
      });
      expect({ type: outcome.type, code: "code" in outcome ? outcome.code : undefined, order, bytes: bytesOf(join(repo, ".gitignore")) }).toEqual({ type: "no-effects", code: "STALE_REVIEW", order: ["fileAppend", "status"], bytes: "*.log\n*.tmp\n" });
    }),
    TIMEOUT_MS,
  );
});

describe("a canceled fileAppend reply (contract Δ6, T034)", () => {
  // The reply after a cancel is `stopped`, `interrupted`, or no reply within the walk deadline (`canceled`). The fresh target read cross-checks each one.
  // A `stopped` reply with changed bytes is a contract mismatch, so it also gives failed-with-effects.
  for (const [name, final] of [["stopped", { result: "stopped" }], ["interrupted", { result: "interrupted" }], ["canceled", { stop: "canceled" }]] as const) {
    for (const append of [true, false]) {
      caseTest("T034", `the target ${append ? "changed" : "stayed"} and the reply is ${name}: the fresh target read gives ${append ? "failed-with-effects" : "no-effects canceled"}`, SHELL, () =>
        withService({ name: `t034-${name}-${append}` }, async (service) => {
          const repo = tree();
          const o = await open(service, repo);
          const { reviewIgnore, runIgnore } = await underTest();
          const review = await reviewIgnore(context(o), entryOf(o.read, "top-new.txt")!, "gitignore");
          if (!("plan" in review)) throw new Error(JSON.stringify(review));
          const order: string[] = [];
          const shell = appendDouble(o, order);
          const canceled: FileAppender = {
            async fileAppend(request, signal) {
              if (append) expect(await shell.fileAppend(request, signal)).toEqual({ result: "appended" });
              else if (name === "stopped") expect(await shell.fileAppend(request, AbortSignal.abort())).toEqual(final);
              return final;
            },
          };
          const outcome = await runIgnore({ ...context(o), appender: canceled }, review.plan, async () => null);
          expect({ type: outcome.type, observed: "observed" in outcome ? outcome.observed : undefined, bytes: bytesOf(join(repo, ".gitignore")) }).toEqual(
            append ? { type: "failed-with-effects", observed: undefined, bytes: "/top-new.txt\n" } : { type: "no-effects", observed: "canceled", bytes: null },
          );
        }),
        TIMEOUT_MS,
      );
    }
  }
});
