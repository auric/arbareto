// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T034: the ignore preview, service part (feature 005 plan.md D9 and D14, contract Δ3 `previewIgnore`, Δ6 `shadow`, data-model §7 and §13, quickstart.md Q18 to Q20 and Q22).
// The oracle is Git's own listing after a real save of the same text on a copy (plan.md D18). The shell test double of `bun-runner.ts` serves `shadow` and the `ignorePreview` runs.

import { describe, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PreviewIgnoreResult } from "../../src/contracts/envelope";
import { PREVIEW_GROUP_PATHS } from "../../src/contracts/limits";
import { comparePaths } from "../../src/contracts/tree-order";
import type { GitCall } from "../../src/git-service/git-runner";
import { printOrigin } from "../origin";
import { buildCaseNames, buildPathsBound, buildReport, faGit, REPORT_ROOT_TEXT, write, type FaFixture } from "./file-actions-fixtures";
import { fixtureDir, useFixtureRoot } from "./fixture-root";
import { workingFileDigests } from "./git-oracle";
import { approve, gitPath, outcome, readOk, shortDeadline, SUCCEEDED, subcommand, until, withService } from "./hunk-harness";
import { caseTest, configDigests, siblingDeadline, type Capability, type RegistrationResult, type Service, type ServiceResponse, type WorkspaceResult } from "./service-harness";
import { canary, untrackedFixture } from "./workbench-fixtures";

for (const module of ["ignore-preview", "git-runner", "native-runner", "session"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
useFixtureRoot();

const TASK = "T034";
const SHELL: Capability[] = ["shell-double"];
const TIMEOUT_MS = 120_000;
const LARGE_TIMEOUT_MS = 20 * 60_000;
const NUL = "\0";
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

let builds = 0;
const report = (links = false): FaFixture => buildReport(gitPath(), `t034-report-${++builds}`, links);
const git = (repo: string, args: string[]) => faGit(gitPath(), repo, args);
const b64 = (text: string | Uint8Array) => Buffer.from(text).toString("base64");

type Group = { count: number; paths: string[] };
type Preview = { preview: { newlyIgnored: Group; noLongerIgnored: Group; trackedMatched: number; notices: { entries: { kind: string; pathBytes: string }[]; more: number } } } | { unavailable: { reason: string; bound?: string } };

const records = (out: Buffer) => out.toString("utf8").split(NUL).slice(0, -1);
const IGNORED = ["--no-optional-locks", "ls-files", "-o", "-i", "--exclude-standard", "-z"];
const MATCHED = ["--no-optional-locks", "ls-files", "-c", "-i", "--exclude-standard", "-z"];

// Data-model §7 groups: the full count and the first 1,000 paths by `comparePaths`. A record that ends with `/` is a folder row.
function group(paths: string[]): Group {
  const sorted = [...paths].sort((a, b) => comparePaths(Buffer.from(a.replace(/\/$/, "")), Buffer.from(b.replace(/\/$/, "")), a.endsWith("/"), b.endsWith("/")));
  return { count: paths.length, paths: sorted.slice(0, PREVIEW_GROUP_PATHS).map((p) => b64(p)) };
}

// Git's own answer: the change of the ignored set and of the matched tracked set after a real save of `bytes` on a copy.
function oracle(repo: string, name: string, file: string, bytes: Uint8Array): { newlyIgnored: Group; noLongerIgnored: Group; trackedMatched: number } {
  const copy = join(fixtureDir(name), "repo");
  cpSync(repo, copy, { recursive: true, verbatimSymlinks: true });
  writeFileSync(join(copy, ...file.split("/")), bytes);
  const before = new Set(records(git(repo, IGNORED)));
  const after = new Set(records(git(copy, IGNORED)));
  const matchedBefore = new Set(records(git(repo, MATCHED)));
  const matchedAfter = records(git(copy, MATCHED));
  return {
    newlyIgnored: group([...after].filter((p) => !before.has(p))),
    noLongerIgnored: group([...before].filter((p) => !after.has(p))),
    trackedMatched: matchedAfter.filter((p) => !matchedBefore.has(p)).length,
  };
}

async function preview(service: Service, r: RegistrationResult, read: WorkspaceResult, target: "gitignore" | "exclude", text: string): Promise<ServiceResponse<Preview>> {
  const response = await service.request<Preview>("previewIgnore", { target, text: b64(text), snapshotId: read.snapshotId }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });
  if (response.result !== undefined) expect(PreviewIgnoreResult.safeParse(response.result).success).toBe(true);
  return response;
}

async function previewed(service: Service, r: RegistrationResult, read: WorkspaceResult, target: "gitignore" | "exclude", text: string): Promise<Extract<Preview, { preview: unknown }>["preview"]> {
  const response = await preview(service, r, read, target, text);
  expect({ ...outcome(response), kind: response.result === undefined ? null : Object.keys(response.result)[0], result: response.result && "unavailable" in response.result ? response.result : null }).toEqual({ ...SUCCEEDED, kind: "preview", result: null });
  return (response.result as Extract<Preview, { preview: unknown }>).preview;
}

const unavailable = (response: ServiceResponse<Preview>) => ({ state: response.state, code: response.code, result: response.result });
const previewFolders = (service: Service) => (existsSync(service.runner.previewFolder) ? readdirSync(service.runner.previewFolder) : []);
const shadowCalls = (service: Service, from = 0) => service.runner.calls.slice(from).filter((c) => c.contextKind === "ignorePreview");
const isCheck = (call: { arguments: readonly string[] }) => subcommand(call.arguments) === "check-ignore";

async function open(service: Service, f: FaFixture): Promise<{ r: RegistrationResult; read: WorkspaceResult }> {
  const r = await service.register(f.repo);
  return { r, read: await readOk(service, r.repositoryId) };
}

// The report cases that the editor can reach: the root `.gitignore` and `info/exclude` (plan.md D8).
const CASES: [label: string, target: "gitignore" | "exclude", text: string][] = [
  ["US5-1 *.log on top", "gitignore", `${REPORT_ROOT_TEXT}emptyign/\n*.txt\n`],
  ["US5-3 !keep.log removed", "gitignore", `${REPORT_ROOT_TEXT.replace("!keep.log\n", "")}emptyign/\n`],
  ["US5-4 a deleted line", "gitignore", `${REPORT_ROOT_TEXT.replace("node_modules/\n", "")}emptyign/\n`],
  ["C0 unchanged root with one line more", "gitignore", `${REPORT_ROOT_TEXT}emptyign/\nx\n`],
  ["C1 root: drop folders, add *.txt and !a.txt", "gitignore", "*.log\n!keep.log\n**/tmp/**\n*.txt\n!a.txt\n"],
  ["C3 info/exclude", "exclude", "*.txt\n!untr/b.txt\nnode_modules/pkg/\n"],
  ["C4 case: *.LOG, DEEP/, nested/", "gitignore", "*.LOG\nDEEP/\nnested/\n"],
  ["C5 ignored folder with a negation inside, ** forms", "gitignore", "node_modules\n!node_modules/pkg/index.js\n**/sub/**/local\nuntr/**\n!untr/b.txt\n"],
  ["C7 empty root", "gitignore", ""],
  ["E1 gitlink mod/ and swt/", "gitignore", `${REPORT_ROOT_TEXT}mod/\nswt/\n`],
  ["the empty ignored folder dropped", "gitignore", REPORT_ROOT_TEXT],
  ["a nested repository and a folder of only ignored paths", "gitignore", `${REPORT_ROOT_TEXT}nested/\ndeep/\n`],
];

describe("each preview equals Git's listing after a real save (spec FR-038, SC-005)", () => {
  caseTest(TASK, "the report fixture R: US5-1, US5-3, US5-4, C0, C1, C3, C4, C5, C7, E1, the empty ignored folder, a nested repository, a skip-worktree .gitignore absent on disk, and gitlinks", SHELL, () =>
    withService({ name: "t034-cases" }, async (service) => {
      const f = report();
      const { r, read } = await open(service, f);
      for (const [label, target, text] of CASES) {
        const file = target === "gitignore" ? ".gitignore" : ".git/info/exclude";
        const got = await previewed(service, r, read, target, text);
        const want = oracle(f.repo, `t034-oracle-${++builds}`, file, Buffer.from(text));
        expect({ label, newlyIgnored: got.newlyIgnored, noLongerIgnored: got.noLongerIgnored, trackedMatched: got.trackedMatched }).toEqual({ label, ...want });
      }
    }),
    LARGE_TIMEOUT_MS,
  );

  caseTest(TASK, "C8: a BOM and CRLF file keeps its form in the candidate, and trailing spaces and an escaped space count as in Git", SHELL, () =>
    withService({ name: "t034-c8" }, async (service) => {
      const f = report();
      writeFileSync(join(f.repo, ".gitignore"), Buffer.concat([BOM, Buffer.from(`${REPORT_ROOT_TEXT}emptyign/\n`.replaceAll("\n", "\r\n"))]));
      const { r, read } = await open(service, f);
      const text = "*.log\n!keep.log  \nign/\\ \n";
      const got = await previewed(service, r, read, "gitignore", text);
      const want = oracle(f.repo, `t034-c8-oracle-${++builds}`, ".gitignore", Buffer.concat([BOM, Buffer.from(text.replaceAll("\n", "\r\n"))]));
      expect({ newlyIgnored: got.newlyIgnored, noLongerIgnored: got.noLongerIgnored, trackedMatched: got.trackedMatched }).toEqual(want);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a folder record and a nested repository that only the saved text ignores expand for one preview and leave the ignored set", SHELL, () =>
    withService({ name: "t034-reopen" }, async (service) => {
      const f = report();
      writeFileSync(join(f.repo, ".gitignore"), `${REPORT_ROOT_TEXT}emptyign/\nnested/\nuntr/\n`);
      const { r, read } = await open(service, f);
      const text = `${REPORT_ROOT_TEXT}emptyign/\n`;
      const got = await previewed(service, r, read, "gitignore", text);
      const want = oracle(f.repo, `t034-reopen-oracle-${++builds}`, ".gitignore", Buffer.from(text));
      expect({ newlyIgnored: got.newlyIgnored, noLongerIgnored: got.noLongerIgnored, trackedMatched: got.trackedMatched }).toEqual(want);
      expect(want.noLongerIgnored.paths).toContain(b64("nested/"));
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "W1: a folder link against folder patterns, and the notice for the linked sub2/.gitignore", ["shell-double", "symlink"], () =>
    withService({ name: "t034-w1" }, async (service) => {
      const f = report(true);
      const { r, read } = await open(service, f);
      const text = `${REPORT_ROOT_TEXT}emptyign/\nlinkdir/\nrealdir/\n\\[br].txt\n`;
      const got = await previewed(service, r, read, "gitignore", text);
      const want = oracle(f.repo, `t034-w1-oracle-${++builds}`, ".gitignore", Buffer.from(text));
      expect({ newlyIgnored: got.newlyIgnored, noLongerIgnored: got.noLongerIgnored, trackedMatched: got.trackedMatched }).toEqual(want);
      expect(got.notices.entries).toContainEqual({ kind: "link", pathBytes: b64("sub2/.gitignore") });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "US5-5: Tracked files stay tracked counts the tracked files that the text matches and the saved text does not", SHELL, () =>
    withService({ name: "t034-tracked" }, async (service) => {
      const f = report();
      const { r, read } = await open(service, f);
      const got = await previewed(service, r, read, "gitignore", `${REPORT_ROOT_TEXT}emptyign/\nb.txt\nswt/keep.txt\n`);
      expect(got.trackedMatched).toBe(2);
      const none = await previewed(service, r, read, "gitignore", `${REPORT_ROOT_TEXT}emptyign/\n`);
      expect(none.trackedMatched).toBe(0);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a group holds the full count and the first 1,000 paths in tree order; the notice names a .gitignore inside a folder that the text ignores", SHELL, () =>
    withService({ name: "t034-groups" }, async (service) => {
      const f = report();
      for (let i = 0; i < 1_200; i++) write(f.repo, `gen/${i % 3 === 0 ? "B" : "a"}${String(i).padStart(4, "0")}.dat`, "g");
      const { r, read } = await open(service, f);
      const text = `${REPORT_ROOT_TEXT}emptyign/\n*.dat\nuntr/\n`;
      const got = await previewed(service, r, read, "gitignore", text);
      const want = oracle(f.repo, `t034-groups-oracle-${++builds}`, ".gitignore", Buffer.from(text));
      expect(got.newlyIgnored).toEqual(want.newlyIgnored);
      expect(got.newlyIgnored.paths.length).toBe(PREVIEW_GROUP_PATHS);
      expect(got.notices).toEqual({ entries: [{ kind: "inside-ignored", pathBytes: b64("untr/.gitignore") }], more: 0 });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "FR-039: a folder that both texts ignore is one input of the check, and no path below it is checked", SHELL, () =>
    withService({ name: "t034-collapse" }, async (service) => {
      const f = report();
      for (let i = 0; i < 50; i++) write(f.repo, `node_modules/more/f${i}.js`, "");
      const { r, read } = await open(service, f);
      const from = service.runner.calls.length;
      await previewed(service, r, read, "gitignore", `${REPORT_ROOT_TEXT}emptyign/\n*.txt\n`);
      const inputs = shadowCalls(service, from).filter(isCheck).flatMap((c) => (c.input === undefined ? [] : records(Buffer.from(c.input))));
      expect(inputs.filter((p) => p === "node_modules")).not.toEqual([]);
      expect(inputs.filter((p) => p.startsWith("node_modules/"))).toEqual([]);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "FR-038: the repository worktree, index, and configuration bytes stay equal, and a new snapshotId builds a new base", SHELL, () =>
    withService({ name: "t034-untouched" }, async (service) => {
      const f = report();
      const files = workingFileDigests(f.repo);
      const index = readFileSync(join(f.repo, ".git", "index"));
      const configs = configDigests(f.repo);
      const { r, read } = await open(service, f);
      const from = service.runner.calls.length;
      await previewed(service, r, read, "gitignore", `${REPORT_ROOT_TEXT}emptyign/\n*.txt\n`);
      const riArgs = (c: { arguments: readonly string[] }) => c.arguments.includes("-i") && c.arguments.includes("--directory");
      expect(service.runner.calls.slice(from).filter(riArgs).length).toBe(1);
      const second = service.runner.calls.length;
      await previewed(service, r, read, "gitignore", `${REPORT_ROOT_TEXT}emptyign/\n*.md\n`);
      // A built base runs one C check and no repository listing.
      expect({ ri: service.runner.calls.slice(second).filter(riArgs).length, checks: shadowCalls(service, second).filter(isCheck).length }).toEqual({ ri: 0, checks: 1 });
      writeFileSync(join(f.repo, "new.txt"), "");
      const fresh = await readOk(service, r.repositoryId);
      expect(fresh.snapshotId).not.toBe(read.snapshotId);
      const third = service.runner.calls.length;
      await previewed(service, r, fresh, "gitignore", `${REPORT_ROOT_TEXT}emptyign/\n*.md\n`);
      expect(service.runner.calls.slice(third).filter(riArgs).length).toBe(1);
      rmSync(join(f.repo, "new.txt"));
      expect(workingFileDigests(f.repo)).toEqual(files);
      expect(Buffer.compare(readFileSync(join(f.repo, ".git", "index")), index)).toBe(0);
      expect(configDigests(f.repo)).toEqual(configs);
    }),
    TIMEOUT_MS,
  );
});

describe("typed limits (spec FR-039, contract Δ5)", () => {
  caseTest(TASK, "more than 100,000 inputs give paths with the bound PREVIEW_PATHS", SHELL, () =>
    withService({ name: "t034-paths" }, async (service) => {
      const f = untrackedFixture(gitPath());
      const r = await service.register(f.repo);
      const read = await readOk(service, r.repositoryId);
      const response = await preview(service, r, read, "gitignore", "*.md\n");
      expect(unavailable(response)).toEqual({ state: "succeeded", code: undefined, result: { unavailable: { reason: "paths", bound: "PREVIEW_PATHS" } } });
    }),
    LARGE_TIMEOUT_MS,
  );

  // Contract Δ5 `PREVIEW_PATHS` counts the inputs of the whole preview: T paths, U records, expansion files and folders, and nested repositories.
  // The folder probes above each `.gitignore` do not count.
  caseTest(TASK, "100,000 inputs and a folder probe stay below PREVIEW_PATHS, also with a built base", SHELL, () =>
    withService({ name: "t034-bound-probe" }, async (service) => {
      const f = buildPathsBound(gitPath(), `t034-bound-probe-${++builds}`);
      const { r, read } = await open(service, f);
      for (let i = 0; i < 2; i++) {
        const got = await previewed(service, r, read, "gitignore", "big/\n# same rules\n");
        expect({ i, newly: got.newlyIgnored.count, noLonger: got.noLongerIgnored.count }).toEqual({ i, newly: 0, noLonger: 0 });
      }
    }),
    LARGE_TIMEOUT_MS,
  );

  caseTest(TASK, "a folder record that only the saved text ignores adds its files to the 100,000 base inputs, which gives paths", SHELL, () =>
    withService({ name: "t034-bound-total" }, async (service) => {
      const f = buildPathsBound(gitPath(), `t034-bound-total-${++builds}`);
      const { r, read } = await open(service, f);
      const response = await preview(service, r, read, "gitignore", "");
      expect(unavailable(response)).toEqual({ state: "succeeded", code: undefined, result: { unavailable: { reason: "paths", bound: "PREVIEW_PATHS" } } });
    }),
    LARGE_TIMEOUT_MS,
  );

  caseTest(TASK, "a CR byte in the text gives INVALID_REQUEST before any Git process", SHELL, () =>
    withService({ name: "t034-cr" }, async (service) => {
      const f = report();
      const { r, read } = await open(service, f);
      const calls = service.runner.calls.length;
      for (const text of ["*.md\r\n", "*.md\r"]) expect(outcome(await preview(service, r, read, "gitignore", text))).toEqual({ state: "rejected", code: "INVALID_REQUEST" });
      expect(service.runner.calls.length).toBe(calls);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "an ignore file above 1 MiB gives listing", SHELL, () =>
    withService({ name: "t034-listing" }, async (service) => {
      const f = report();
      write(f.repo, "untr/.gitignore", Buffer.concat([Buffer.from("*.bak\n#"), Buffer.alloc(1_048_577, 0x23)]));
      const { r, read } = await open(service, f);
      const response = await preview(service, r, read, "gitignore", `${REPORT_ROOT_TEXT}emptyign/\n`);
      expect(unavailable(response)).toEqual({ state: "succeeded", code: undefined, result: { unavailable: { reason: "listing", bound: "IGNORE_TARGET_BYTES" } } });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "on Windows up/.GITIGNORE gives name-case; a folder with only dot/.gıtignore gives no limit, and its rules apply nowhere", SHELL, () =>
    withService({ name: "t034-name-case" }, async (service) => {
      const f = buildCaseNames(gitPath(), `t034-case-${++builds}`);
      const { r, read } = await open(service, f);
      const response = await preview(service, r, read, "gitignore", "*.md\n");
      if (process.platform === "win32") expect(unavailable(response)).toEqual({ state: "succeeded", code: undefined, result: { unavailable: { reason: "name-case" } } });
      rmSync(join(f.repo, "up"), { recursive: true });
      const again = await readOk(service, r.repositoryId);
      const got = await previewed(service, r, again, "gitignore", "*.md\n");
      expect({ newlyIgnored: got.newlyIgnored, noLongerIgnored: got.noLongerIgnored, trackedMatched: got.trackedMatched }).toEqual(oracle(f.repo, `t034-case-oracle-${++builds}`, ".gitignore", Buffer.from("*.md\n")));
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a written shadow file with another OID gives shadow-copy", SHELL, () =>
    withService({ name: "t034-shadow-copy" }, async (service) => {
      const f = report();
      const { r, read } = await open(service, f);
      // One wrong OID for each path that the check step names.
      const lines = (input: Uint8Array | undefined) => (input === undefined ? 0 : Buffer.from(input).toString("latin1").split("\n").length - 1);
      service.runner.inject.stdout = (call) => (call.arguments.includes("--stdin-paths") && !call.arguments.includes("-w") ? Buffer.from(`${"0".repeat(40)}\n`.repeat(lines(call.input))) : undefined);
      try {
        const response = await preview(service, r, read, "gitignore", "*.md\n");
        expect(unavailable(response)).toEqual({ state: "succeeded", code: undefined, result: { unavailable: { reason: "shadow-copy" } } });
      } finally {
        service.runner.inject.stdout = undefined;
      }
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a changed RI or RT record gives self-check", SHELL, () =>
    withService({ name: "t034-self-check" }, async (service) => {
      for (const listing of ["RI", "RT"] as const) {
        const f = report();
        const { r, read } = await open(service, f);
        const match = (args: readonly string[]) => args.includes("-i") && (listing === "RI" ? args.includes("-o") : args.includes("-c"));
        const real = records(git(f.repo, listing === "RI" ? ["--no-optional-locks", "ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"] : MATCHED));
        const changed = listing === "RI" ? real.filter((p) => p !== "x.log") : [...real, "a.txt"];
        service.runner.inject.stdout = (call) => (match(call.arguments) ? Buffer.from(changed.map((p) => `${p}${NUL}`).join("")) : undefined);
        try {
          const response = await preview(service, r, read, "gitignore", "*.md\n");
          expect({ listing, ...unavailable(response) }).toEqual({ listing, state: "succeeded", code: undefined, result: { unavailable: { reason: "self-check" } } });
        } finally {
          service.runner.inject.stdout = undefined;
        }
      }
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "an ignore file that the walk cannot read gives unreadable", ["shell-double", "read-denial"], () =>
    withService({ name: "t034-unreadable" }, async (service) => {
      const f = report();
      const target = join(f.repo, "untr", ".gitignore");
      const { r, read } = await open(service, f);
      denyRead(target, true);
      try {
        const response = await preview(service, r, read, "gitignore", "*.md\n");
        expect(unavailable(response)).toEqual({ state: "succeeded", code: undefined, result: { unavailable: { reason: "unreadable" } } });
      } finally {
        denyRead(target, false);
      }
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a step at its deadline gives deadline, and a failed Git step ends failed with its code", SHELL, () =>
    withService({ name: "t034-deadline" }, async (service) => {
      const f = report();
      const { r, read } = await open(service, f);
      shortDeadline(service, isCheck, 1).arm();
      try {
        const response = await preview(service, r, read, "gitignore", "*.md\n");
        expect(unavailable(response)).toEqual({ state: "succeeded", code: undefined, result: { unavailable: { reason: "deadline" } } });
      } finally {
        service.runner.inject.deadlineMs = null;
      }
      service.runner.inject.exit = (call) => (call.arguments.includes("check-ignore") ? 128 : undefined);
      try {
        const response = await preview(service, r, read, "gitignore", "*.txt\n");
        expect(outcome(response)).toEqual({ state: "failed", code: "GIT_FAILED" });
      } finally {
        service.runner.inject.exit = undefined;
      }
    }),
    TIMEOUT_MS,
  );

  // T081, 001 contract §5: the deadline closes the operation Job, so the sibling check ends with `exitCode` null and no `deadline`.
  // T399 `siblingDeadline`: the sibling check starts first, and only the Job close of the deadline check ends it. Each shadow is the sibling once.
  caseTest("T081", "a deadline in one of two parallel check-ignore steps gives deadline, also when the Job close ends the sibling first", SHELL, () =>
    withService({ name: "t081-sibling" }, async (service) => {
      const f = report();
      const { r, read } = await open(service, f);
      // The start barrier gets the GitCall, which holds the shadow context.
      const checkOf = (repo: "s" | "c") => (call: { arguments: readonly string[] }) => {
        const { context } = call as unknown as GitCall;
        return isCheck(call) && context.contextKind === "ignorePreview" && context.shadowRepository === repo;
      };
      for (const repo of ["s", "c"] as const) {
        const before = service.runner.calls.length;
        const release = siblingDeadline(service, checkOf(repo === "s" ? "c" : "s"), checkOf(repo));
        const response = await preview(service, r, read, "gitignore", "*.md\n").finally(release);
        // Contract §6 "Process replies": the deadline check carries `deadline`. The closed sibling has `exitCode` null and no `deadline`.
        const exits = service.runner.calls.slice(before).filter(isCheck).map(({ exit }) => exit?.deadline ?? (exit?.exitCode === null ? "closed" : String(exit?.exitCode)));
        console.log(`OBSERVATION T081: sibling=${repo} checks=${exits.join(",")} ${JSON.stringify(unavailable(response))}`);
        expect({ repo, exits: exits.sort(), ...unavailable(response) }).toEqual({ repo, exits: ["closed", "deadline"], state: "succeeded", code: undefined, result: { unavailable: { reason: "deadline" } } });
      }
    }),
    TIMEOUT_MS,
  );
});

// Windows `icacls /deny <user>:(R)` takes the read and attribute rights of the current account. The second call removes the deny entry.
function denyRead(path: string, deny: boolean): void {
  const { chmodSync } = require("node:fs") as typeof import("node:fs");
  if (process.platform !== "win32") return void chmodSync(path, deny ? 0o000 : 0o644);
  const { userInfo } = require("node:os") as typeof import("node:os");
  const args = deny ? [path, "/deny", `${userInfo().username}:(R)`] : [path, "/remove:d", userInfo().username];
  const proc = Bun.spawnSync(["icacls", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`icacls ${args.join(" ")} exited ${proc.exitCode}`);
}

describe("the read gate and the shadow lifetime (spec FR-003, FR-041, plan.md D14)", () => {
  caseTest(TASK, "an untrusted repository with a command-valued core.fsmonitor gives TRUST_REQUIRED, and the canary marker stays absent", SHELL, () =>
    withService({ name: "t034-gate" }, async (service) => {
      const f = report();
      const { r, read } = await open(service, f);
      const monitor = canary(join(f.repo, ".."), "t034-fsmonitor");
      git(f.repo, ["config", "core.fsmonitor", monitor.command]);
      const response = await preview(service, r, read, "gitignore", "*.md\n");
      expect(outcome(response)).toEqual({ state: "failed", code: "TRUST_REQUIRED" });
      expect(existsSync(monitor.log)).toBe(false);
      expect(shadowCalls(service)).toEqual([]);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "the operation end and Cancel remove the shadow folder; a leftover of a killed run goes at the next preview (Q22)", SHELL, () =>
    withService({ name: "t034-lifetime" }, async (service) => {
      const f = report();
      const { r, read } = await open(service, f);
      await previewed(service, r, read, "gitignore", "*.md\n");
      await until(() => previewFolders(service).length === 0, "the shadow folder of the finished preview");
      const release = service.runner.holdStart(isCheck);
      const from = service.runner.calls.length;
      const requestId = service.send("previewIgnore", { target: "gitignore", text: b64("*.txt\n"), snapshotId: read.snapshotId }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });
      try {
        await until(() => shadowCalls(service, from).some(isCheck), "the held check");
        expect(previewFolders(service).length).toBe(1);
        await service.cancel(await service.operationId(requestId));
      } finally {
        release();
      }
      expect(outcome(await service.response(requestId))).toEqual({ state: "canceled", code: "CANCELED" });
      await until(() => previewFolders(service).length === 0, "the shadow folder of the canceled preview");
      // A killed run leaves the folder of another process: this PID with another creation time.
      const leftover = join(service.runner.previewFolder, `${process.pid}-1-0123456789abcdef`);
      mkdirSync(join(leftover, "s"), { recursive: true });
      writeFileSync(join(leftover, "s", "left.txt"), "");
      await previewed(service, r, read, "gitignore", "*.md\n");
      await until(() => !existsSync(leftover), "the leftover shadow folder");
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "after trust approval the preview runs in a repository with a command-valued core.fsmonitor", SHELL, () =>
    withService({ name: "t034-approved" }, async (service) => {
      const f = report();
      const monitor = canary(join(f.repo, ".."), "t034-fsmonitor-approved");
      git(f.repo, ["config", "core.fsmonitor", monitor.command]);
      const r = await service.register(f.repo);
      await approve(service, r.repositoryId);
      const read = await readOk(service, r.repositoryId);
      const got = await previewed(service, r, read, "gitignore", `${REPORT_ROOT_TEXT}emptyign/\n*.txt\n`);
      expect(got.newlyIgnored.count).toBeGreaterThan(0);
    }),
    TIMEOUT_MS,
  );
});

describe("an equal full read keeps the snapshot (001 data-model §4 \"Status snapshot retention\")", () => {
  caseTest("T400", "a preview with the snapshot of the first of two equal full reads gives a preview", SHELL, () =>
    withService({ name: "t400-preview" }, async (service) => {
      const { r, read } = await open(service, report());
      const again = await readOk(service, r.repositoryId);
      await previewed(service, r, read, "gitignore", "*.log\n");
      expect({ generation: again.generation, snapshotId: again.snapshotId, entries: again.entries }).toEqual({ generation: read.generation, snapshotId: read.snapshotId, entries: read.entries });
    }),
    TIMEOUT_MS,
  );
});
