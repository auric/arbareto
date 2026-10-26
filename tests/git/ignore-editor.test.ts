// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T033: the ignore editor read and Save, service part (feature 005 plan.md D8 and D10, contract Δ3 `readIgnoreFile` and `reviewWorkbench` `ignore-save`,
// Δ6 `fileReplace`, data-model §6 and §8, quickstart.md Q23 and Q24). The shell test double of `bun-runner.ts` serves `fileReplace` by the contract Δ6 rules.

import { describe, expect } from "bun:test";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReadIgnoreFileResult, ReviewWorkbenchResult, RunWorkbenchResult } from "../../src/contracts/envelope";
import { ignoreLine } from "../../src/contracts/ignore-line";
import { PUBLIC_REQUEST_BYTES } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import { buildConflicted, buildIgnoreForm, buildLinkedWorktree, faGit, type FaFixture, type IgnoreForm } from "./file-actions-fixtures";
import { fixtureEnv, useFixtureRoot } from "./fixture-root";
import { fixtureGitPath } from "./git-binary";
import { workingFileDigests } from "./git-oracle";
import { gitPath, outcome, readOk, SUCCEEDED, subcommand, until, withService } from "./hunk-harness";
import { caseTest, type Capability, type RegistrationResult, type Service, type ServiceResponse } from "./service-harness";
import { canary } from "./workbench-fixtures";

for (const module of ["ignore", "ignore-text", "workbench-review", "native-runner", "session"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
printOrigin("../../src/contracts/ignore-line.ts", import.meta.dir);
useFixtureRoot();

const TASK = "T033";
const MIXED_TASK = "T095";
const SHELL: Capability[] = ["shell-double"];
const TIMEOUT_MS = 120_000;

let builds = 0;
const form = (f: IgnoreForm): FaFixture => buildIgnoreForm(gitPath(), `t033-${f}-${++builds}`, f);
const sha = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const b64 = (text: string | Uint8Array) => Buffer.from(text).toString("base64");

type IgnoreFile = { target: string; file: string; state: "absent" | "file"; text: string; lineEnding: string; lineCounts?: { lf: number; crlf: number }; bom: boolean; expected: "absent" | { size: number; sha256: string } };
type SaveReview = { action: "ignore-save"; plan: { target: string; file: string; size: number; sha256: string }; workbenchToken: string };

async function readIgnore(service: Service, r: RegistrationResult, target: "gitignore" | "exclude"): Promise<ServiceResponse<IgnoreFile>> {
  const response = await service.request<IgnoreFile>("readIgnoreFile", { target }, { repositoryId: r.repositoryId, repositoryGeneration: r.generation });
  if (response.result !== undefined) expect(ReadIgnoreFileResult.safeParse(response.result).success).toBe(true);
  return response;
}

function reviewSave(service: Service, r: RegistrationResult, target: "gitignore" | "exclude", text: string | Uint8Array, expected: IgnoreFile["expected"], lineEnding?: "lf" | "crlf"): Promise<ServiceResponse<SaveReview>> {
  return service.request<SaveReview>("reviewWorkbench", { action: "ignore-save", target, text: b64(text), expected, ...(lineEnding === undefined ? {} : { lineEnding }) }, { repositoryId: r.repositoryId, repositoryGeneration: r.generation });
}

const sendRun = (service: Service, r: RegistrationResult, token: string) => service.send("runWorkbench", { workbenchToken: token, start: true }, { repositoryId: r.repositoryId });
async function save(service: Service, r: RegistrationResult, target: "gitignore" | "exclude", text: string, expected: IgnoreFile["expected"], lineEnding?: "lf" | "crlf"): Promise<ServiceResponse<{ action: string; outcome?: string; reason?: string }>> {
  const review = await reviewSave(service, r, target, text, expected, lineEnding);
  expect({ ...outcome(review), result: review.state === "succeeded" ? "plan" : review.result }).toEqual({ ...SUCCEEDED, result: "plan" });
  expect(ReviewWorkbenchResult.safeParse(review.result).success).toBe(true);
  const response = await service.response<{ action: string; outcome?: string }>(sendRun(service, r, review.result!.workbenchToken));
  if (response.result !== undefined) expect(RunWorkbenchResult.safeParse(response.result).success).toBe(true);
  return response;
}

const refusal = (response: ServiceResponse<unknown>) => ({ state: response.state, code: response.code, result: response.result });
const unavailable = (reason: string) => ({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason } });
const replaceFrames = (service: Service) => service.runner.frames.filter((f) => f.type === "fileReplace");
const bytesOf = (path: string) => (lstatSync(path, { throwIfNoEntry: false }) === undefined ? null : readFileSync(path));

describe("readIgnoreFile (plan.md D8, contract Δ3)", () => {
  caseTest(TASK, "each regular form loads its text in LF form with its line ending and BOM; an absent file gives state absent", SHELL, () =>
    withService({ name: "t033-read" }, async (service) => {
      const cases: [IgnoreForm, Partial<IgnoreFile>][] = [
        ["lf", { state: "file", text: "*.log\n/out/\n", lineEnding: "lf", bom: false }],
        ["crlf", { state: "file", text: "*.log\n/out/\n", lineEnding: "crlf", bom: false }],
        ["bom", { state: "file", text: "*.log\n", lineEnding: "lf", bom: true }],
        ["none", { state: "file", text: "*.log", lineEnding: "none", bom: false }],
        ["empty", { state: "file", text: "", lineEnding: "none", bom: false }],
        ["absent", { state: "absent", text: "", lineEnding: "none", bom: false, expected: "absent" }],
        ["mixed", { state: "file", text: "*.log\n/out/\n", lineEnding: "mixed", lineCounts: { lf: 1, crlf: 1 }, bom: false }],
      ];
      for (const [name, want] of cases) {
        const f = form(name);
        const r = await service.register(f.repo);
        const read = await readIgnore(service, r, "gitignore");
        expect({ name, state: read.state }).toEqual({ name, state: "succeeded" });
        const bytes = bytesOf(join(f.repo, ".gitignore"));
        const expected = bytes === null ? "absent" : { size: bytes.length, sha256: sha(bytes) };
        expect({ name, ...read.result }).toEqual({ name, target: "gitignore", file: `${read.result!.file}`, expected, ...want });
        expect(read.result!.file.replaceAll("\\", "/").endsWith("/repo/.gitignore")).toBe(true);
      }
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a folder, a file above 1 MiB, invalid UTF-8, a NUL, and a lone CR each refuse with its reason and change no byte", SHELL, () =>
    withService({ name: "t033-read-refusals" }, async (service) => {
      const cases: [IgnoreForm, string][] = [
        ["folder", "ignore-folder"],
        ["big", "ignore-size"],
        ["not-utf8", "ignore-not-utf8"],
        ["nul", "ignore-nul"],
        ["lone-cr", "ignore-lone-cr"],
      ];
      for (const [name, reason] of cases) {
        const f = form(name);
        const before = workingFileDigests(f.repo);
        const r = await service.register(f.repo);
        expect({ name, ...refusal(await readIgnore(service, r, "gitignore")) }).toEqual({ name, ...unavailable(reason) });
        expect({ name, after: workingFileDigests(f.repo) }).toEqual({ name, after: before });
      }
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a linked .gitignore refuses with ignore-link", ["shell-double", "symlink"], () =>
    withService({ name: "t033-read-link" }, async (service) => {
      const f = form("link");
      const r = await service.register(f.repo);
      expect(refusal(await readIgnore(service, r, "gitignore"))).toEqual(unavailable("ignore-link"));
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a FIFO .gitignore refuses with ignore-not-regular", ["shell-double", "fifo"], () =>
    withService({ name: "t033-read-fifo" }, async (service) => {
      const f = form("absent");
      expect(Bun.spawnSync(["mkfifo", join(f.repo, ".gitignore")]).exitCode).toBe(0);
      const r = await service.register(f.repo);
      expect(refusal(await readIgnore(service, r, "gitignore"))).toEqual(unavailable("ignore-not-regular"));
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "info/exclude comes from rev-parse --git-path, also in a linked worktree (F18); a path outside the common folder refuses with path", SHELL, () =>
    withService({ name: "t033-exclude" }, async (service) => {
      const f = buildLinkedWorktree(gitPath(), `t033-linked-${++builds}`);
      writeFileSync(join(f.repo, ".git", "info", "exclude"), "secret\r\n");
      const r = await service.register(f.linked);
      const read = await readIgnore(service, r, "exclude");
      expect(outcome(read)).toEqual(SUCCEEDED);
      expect({ file: read.result!.file.replaceAll("\\", "/"), text: read.result!.text, lineEnding: read.result!.lineEnding }).toEqual({ file: `${faGit(gitPath(), f.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim()}/info/exclude`, text: "secret\n", lineEnding: "crlf" });
      service.runner.inject.stdout = (call) => (call.arguments.includes("--git-path") && call.arguments.includes("info/exclude") ? Buffer.from(`${f.root.replaceAll("\\", "/")}/elsewhere/info/exclude\n`) : undefined);
      try {
        expect(refusal(await readIgnore(service, r, "exclude"))).toEqual(unavailable("path"));
      } finally {
        service.runner.inject.stdout = undefined;
      }
    }),
    TIMEOUT_MS,
  );
});

describe("ignore-save (plan.md D10, contract Δ3 and Δ6)", () => {
  caseTest(TASK, "US5-8: a CRLF file saves with CRLF; a BOM stays; an absent file saves with LF; the run sends one fileReplace, then a fresh digest and the status read", SHELL, () =>
    withService({ name: "t033-save-forms" }, async (service) => {
      const cases: [IgnoreForm, string, Uint8Array][] = [
        ["crlf", "*.log\n/out/\n/new/\n", Buffer.from("*.log\r\n/out/\r\n/new/\r\n")],
        ["bom", "*.log\n/new/\n", Buffer.from("\u{feff}*.log\n/new/\n")],
        ["absent", "/new/\n", Buffer.from("/new/\n")],
        ["none", "*.log\n/new/", Buffer.from("*.log\n/new/")],
        ["lf", "", Buffer.from("")],
      ];
      for (const [name, text, bytes] of cases) {
        const f = form(name);
        const r = await service.register(f.repo);
        const read = await readIgnore(service, r, "gitignore");
        const from = service.runner.frames.length;
        const calls = service.runner.calls.length;
        const response = await save(service, r, "gitignore", text, read.result!.expected);
        expect({ name, ...outcome(response), result: response.result }).toEqual({ name, ...SUCCEEDED, result: { action: "ignore-save", outcome: "replaced" } });
        expect({ name, bytes: [...readFileSync(join(f.repo, ".gitignore"))] }).toEqual({ name, bytes: [...bytes] });
        const frames = service.runner.frames.slice(from).filter((frame) => frame.type === "fileReplace");
        expect({ name, frames: frames.length }).toEqual({ name, frames: 1 });
        const operationId = response.operationId!;
        expect(service.runner.calls.slice(calls).some((call) => call.operationId === operationId && subcommand(call.arguments) === "status")).toBe(true);
      }
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "US5-6: a state other than expected gives STALE_REVIEW ignore-changed at the review, and at the run without a fileReplace; the other program's bytes stay", SHELL, () =>
    withService({ name: "t033-save-stale" }, async (service) => {
      const f = form("lf");
      const r = await service.register(f.repo);
      const read = await readIgnore(service, r, "gitignore");
      writeFileSync(join(f.repo, ".gitignore"), "other program\n");
      expect(refusal(await reviewSave(service, r, "gitignore", "/x/\n", read.result!.expected))).toEqual({ state: "failed", code: "STALE_REVIEW", result: { reason: "ignore-changed" } });
      const again = await readIgnore(service, r, "gitignore");
      const review = await reviewSave(service, r, "gitignore", "/y/\n", again.result!.expected);
      expect(outcome(review)).toEqual(SUCCEEDED);
      writeFileSync(join(f.repo, ".gitignore"), "other program again\n");
      const response = await service.response(sendRun(service, r, review.result!.workbenchToken));
      expect(refusal(response)).toEqual({ state: "failed", code: "STALE_REVIEW", result: { action: "ignore-save", reason: "ignore-changed" } });
      expect(replaceFrames(service)).toEqual([]);
      expect(readFileSync(join(f.repo, ".gitignore"), "utf8")).toBe("other program again\n");
    }),
    TIMEOUT_MS,
  );

  // Plan.md D10 and the user request of 2026-10-25: the request form applies to all lines, and a mixed file requires it.
  async function saveForm(service: Service, r: RegistrationResult, path: string, text: string, lineEnding: "lf" | "crlf", want: string) {
    const read = await readIgnore(service, r, "gitignore");
    const review = await reviewSave(service, r, "gitignore", text, read.result!.expected, lineEnding);
    expect({ lineEnding, ...outcome(review) }).toEqual({ lineEnding, ...SUCCEEDED });
    const response = await service.response<{ action: string; outcome?: string }>(sendRun(service, r, review.result!.workbenchToken));
    expect({ lineEnding, ...outcome(response), result: response.result }).toEqual({ lineEnding, ...SUCCEEDED, result: { action: "ignore-save", outcome: "replaced" } });
    const bytes = readFileSync(path);
    expect({ lineEnding, text: bytes.toString("latin1"), plan: review.result!.plan.sha256 }).toEqual({ lineEnding, text: want, plan: sha(bytes) });
  }

  caseTest(MIXED_TASK, "US5-11: a mixed file without lineEnding gives INVALID_REQUEST at the review; each chosen form writes all lines, the after digest matches, and the file then reads in that form", SHELL, () =>
    withService({ name: "t095-save-mixed" }, async (service) => {
      for (const [lineEnding, want] of [["crlf", "*.log\r\n/out/\r\n/new/\r\n"], ["lf", "*.log\n/out/\n/new/\n"]] as const) {
        const f = form("mixed");
        const path = join(f.repo, ".gitignore");
        const r = await service.register(f.repo);
        const read = await readIgnore(service, r, "gitignore");
        const frames = replaceFrames(service).length;
        expect(refusal(await reviewSave(service, r, "gitignore", "*.log\n/out/\n/new/\n", read.result!.expected))).toEqual({ state: "failed", code: "INVALID_REQUEST", result: undefined });
        expect(replaceFrames(service).length).toBe(frames);
        await saveForm(service, r, path, "*.log\n/out/\n/new/\n", lineEnding, want);
        const again = await readIgnore(service, r, "gitignore");
        expect({ lineEnding: again.result!.lineEnding, counts: again.result!.lineCounts }).toEqual({ lineEnding, counts: undefined });
      }
    }),
    TIMEOUT_MS,
  );

  caseTest(MIXED_TASK, "US5-12: an LF file with crlf and a CRLF file with lf convert all lines, with the matching after digest", SHELL, () =>
    withService({ name: "t095-save-convert" }, async (service) => {
      for (const [name, lineEnding, want] of [["lf", "crlf", "*.log\r\n/out/\r\n"], ["crlf", "lf", "*.log\n/out/\n"]] as const) {
        const f = form(name);
        const r = await service.register(f.repo);
        await saveForm(service, r, join(f.repo, ".gitignore"), "*.log\n/out/\n", lineEnding, want);
      }
    }),
    TIMEOUT_MS,
  );

  caseTest(MIXED_TASK, "a mixed file changed on disk gives STALE_REVIEW ignore-changed before the line-ending check", SHELL, () =>
    withService({ name: "t095-save-mixed-stale" }, async (service) => {
      const f = form("mixed");
      const r = await service.register(f.repo);
      const read = await readIgnore(service, r, "gitignore");
      writeFileSync(join(f.repo, ".gitignore"), "a\nb\r\n");
      expect(refusal(await reviewSave(service, r, "gitignore", "/x/\n", read.result!.expected))).toEqual({ state: "failed", code: "STALE_REVIEW", result: { reason: "ignore-changed" } });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "new bytes above 1 MiB give ignore-size; a NUL gives ignore-nul; a CR in the text gives INVALID_REQUEST before any Git process; a 1 MiB text of short lines fits one request", SHELL, () =>
    withService({ name: "t033-save-bounds" }, async (service) => {
      const f = form("crlf");
      const r = await service.register(f.repo);
      const read = await readIgnore(service, r, "gitignore");
      // 400,000 lines of "a" give 800,000 bytes with LF and 1,200,000 bytes with the CRLF of the file.
      expect(refusal(await reviewSave(service, r, "gitignore", "a\n".repeat(400_000), read.result!.expected))).toEqual(unavailable("ignore-size"));
      expect(refusal(await reviewSave(service, r, "gitignore", "a\n\0\n", read.result!.expected))).toEqual(unavailable("ignore-nul"));
      // Contract Δ3: a CR byte in `text` gives INVALID_REQUEST for `previewIgnore` and `ignore-save`.
      const calls = service.runner.calls.length;
      for (const text of ["a\r\nb\n", "a\rb\n"]) expect(outcome(await reviewSave(service, r, "gitignore", text, read.result!.expected))).toEqual({ state: "rejected", code: "INVALID_REQUEST" });
      expect(service.runner.calls.length).toBe(calls);
      const lf = form("lf");
      const lr = await service.register(lf.repo);
      const lread = await readIgnore(service, lr, "gitignore");
      const text = "a\n".repeat(524_288);
      expect(Buffer.byteLength(text)).toBe(1_048_576);
      const frame = JSON.stringify({ kind: "public", request: { version: 1, sessionId: crypto.randomUUID(), requestId: crypto.randomUUID(), operation: "reviewWorkbench", repositoryId: crypto.randomUUID(), repositoryGeneration: 1, payload: { action: "ignore-save", target: "gitignore", text: b64(text), expected: lread.result!.expected } } });
      expect(Buffer.byteLength(frame)).toBeLessThan(PUBLIC_REQUEST_BYTES);
      const response = await save(service, lr, "gitignore", text, lread.result!.expected);
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect(readFileSync(join(lf.repo, ".gitignore")).length).toBe(1_048_576);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "FR-046: Save during a merge with conflicts succeeds for .gitignore and info/exclude, and the merge state stays", SHELL, () =>
    withService({ name: "t033-save-merge" }, async (service) => {
      const f = buildConflicted(gitPath(), `t033-merging-${++builds}`, "merging");
      const r = await service.register(f.repo);
      for (const target of ["gitignore", "exclude"] as const) {
        const read = await readIgnore(service, r, target);
        expect({ target, ...outcome(read) }).toEqual({ target, ...SUCCEEDED });
        const response = await save(service, r, target, `${read.result!.text}/free.txt\n`, read.result!.expected);
        expect({ target, ...outcome(response) }).toEqual({ target, ...SUCCEEDED });
      }
      expect(faGit(gitPath(), f.repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).toString().trim()).toMatch(/^[0-9a-f]{40}$/);
      expect(faGit(gitPath(), f.repo, ["ls-files", "-u", "-z"]).length).toBeGreaterThan(0);
      expect(existsSync(join(f.repo, ".git", "info", "exclude"))).toBe(true);
      const fresh = await readOk(service, r.repositoryId);
      expect(fresh.entries.some((e) => e.path === "free.txt")).toBe(false);
    }),
    TIMEOUT_MS,
  );

  // Contract Δ3: the shell walk deadline replies `stopped`, which names no cause, so only a service deadline gives DEADLINE.
  caseTest(TASK, "a shell stop before the write without a Cancel gives failed GIT_FAILED with outcome stopped, and the file stays", SHELL, () =>
    withService({ name: "t033-save-shell-stop" }, async (service) => {
      const f = form("lf");
      const r = await service.register(f.repo);
      const read = await readIgnore(service, r, "gitignore");
      const review = await reviewSave(service, r, "gitignore", "/z/\n", read.result!.expected);
      expect(outcome(review)).toEqual(SUCCEEDED);
      // The walk takes this deadline at its start. The Git processes after it take the 001 deadline again.
      service.runner.inject.deadlineMs = 1_500;
      service.runner.inject.holdWalk = (kind) => {
        if (kind !== "fileReplace") return Promise.resolve();
        service.runner.inject.deadlineMs = null;
        return new Promise<void>(() => {});
      };
      try {
        const response = await service.response(sendRun(service, r, review.result!.workbenchToken));
        expect(refusal(response)).toEqual({ state: "failed", code: "GIT_FAILED", result: { action: "ignore-save", outcome: "stopped" } });
        expect(readFileSync(join(f.repo, ".gitignore"), "utf8")).toBe("*.log\n/out/\n");
      } finally {
        service.runner.inject.holdWalk = null;
        service.runner.inject.deadlineMs = null;
      }
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "in a repository whose command-valued core.fsmonitor needs trust, the review and the run of Save never run it", SHELL, () =>
    withService({ name: "t033-save-canary" }, async (service) => {
      const f = form("lf");
      const r = await service.register(f.repo);
      const read = await readIgnore(service, r, "gitignore");
      const monitor = canary(f.root, "t033-fsmonitor");
      faGit(gitPath(), f.repo, ["config", "core.fsmonitor", monitor.command]);
      const review = await reviewSave(service, r, "gitignore", "/canary/\n", read.result!.expected);
      expect(outcome(review)).toEqual(SUCCEEDED);
      expect(existsSync(monitor.log)).toBe(false);
      const response = await service.response(sendRun(service, r, review.result!.workbenchToken));
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect([readFileSync(join(f.repo, ".gitignore"), "utf8"), existsSync(monitor.log)]).toEqual(["/canary/\n", false]);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a running mutation gives BUSY for the Save run", SHELL, () =>
    withService({ name: "t033-save-busy" }, async (service) => {
      const f = form("lf");
      const r = await service.register(f.repo);
      const read = await readIgnore(service, r, "gitignore");
      const first = await reviewSave(service, r, "gitignore", "/a/\n", read.result!.expected);
      const second = await reviewSave(service, r, "gitignore", "/b/\n", read.result!.expected);
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      service.runner.inject.holdWalk = (kind) => (kind === "fileReplace" ? gate : Promise.resolve());
      const requestId = sendRun(service, r, first.result!.workbenchToken);
      try {
        await until(() => replaceFrames(service).length === 1, "fileReplace frame");
        expect(outcome(await service.response(sendRun(service, r, second.result!.workbenchToken)))).toEqual({ state: "rejected", code: "BUSY" });
      } finally {
        release();
        service.runner.inject.holdWalk = null;
      }
      expect(outcome(await service.response(requestId))).toEqual(SUCCEEDED);
      expect(readFileSync(join(f.repo, ".gitignore"), "utf8")).toBe("/a/\n");
    }),
    TIMEOUT_MS,
  );
});

// Feature 004 T026 line cases that hold for the editor (spec FR-034, 004 FR-046). `git check-ignore` and the file bytes are the oracle.
describe("the 004 line in the saved text (spec FR-034, 004 FR-046 and plan.md D9)", () => {
  const LINE_TASK = "T057";

  // The editor text after "Add to .gitignore…": an LF first when the text does not end with one, then the line and LF (src/frontend/state/workbench.ts `addLine`).
  function withLine(text: string, path: string, folder = false): { line: string; text: string } {
    const line = ignoreLine(Buffer.from(path), folder);
    if (!line.ok) throw new Error(`ignoreLine refused ${path}: ${line.reason}`);
    return { line: line.line, text: `${text === "" || text.endsWith("\n") ? text : `${text}\n`}${line.line}\n` };
  }

  // git-check-ignore(1) `-v -z`: exit 0 and `<source> NUL <line> NUL <pattern> NUL <path> NUL` for an ignored path, exit 1 for none.
  function checkIgnore(repo: string, path: string): { exit: number; pattern?: string; source?: string } {
    const result = Bun.spawnSync([fixtureGitPath(gitPath()), "--no-optional-locks", "check-ignore", "-v", "-z", "--no-index", "--stdin"], { cwd: repo, env: fixtureEnv(), stdin: Buffer.from(`${path}\0`), stdout: "pipe", stderr: "pipe" });
    const [source, , pattern] = result.stdout.toString("utf8").split("\0");
    return { exit: result.exitCode ?? -1, ...(result.exitCode === 0 ? { pattern, source } : {}) };
  }

  async function saveLine(service: Service, r: RegistrationResult, target: "gitignore" | "exclude", path: string, folder = false): Promise<string> {
    const read = await readIgnore(service, r, target);
    expect(outcome(read)).toEqual(SUCCEEDED);
    const added = withLine(read.result!.text, path, folder);
    const response = await save(service, r, target, added.text, read.result!.expected);
    expect({ path, ...outcome(response), result: response.result }).toEqual({ path, ...SUCCEEDED, result: { action: "ignore-save", outcome: "replaced" } });
    return added.line;
  }

  caseTest(LINE_TASK, "a file and a folder go into the root .gitignore with the anchored line and LF, check-ignore matches each path, and the fresh status leaves them out", SHELL, () =>
    withService({ name: "t057-gitignore" }, async (service) => {
      const f = form("absent");
      const r = await service.register(f.repo);
      expect(await saveLine(service, r, "gitignore", "a.log")).toBe("/a.log");
      expect(readFileSync(join(f.repo, ".gitignore"), "latin1")).toBe("/a.log\n");
      expect(checkIgnore(f.repo, "a.log")).toEqual({ exit: 0, pattern: "/a.log", source: ".gitignore" });
      expect(await saveLine(service, r, "gitignore", "out", true)).toBe("/out/");
      expect(readFileSync(join(f.repo, ".gitignore"), "latin1")).toBe("/a.log\n/out/\n");
      expect(checkIgnore(f.repo, "out/x.txt")).toEqual({ exit: 0, pattern: "/out/", source: ".gitignore" });
      const fresh = await readOk(service, r.repositoryId);
      expect(fresh.entries.filter((e) => e.path === "a.log" || e.path.startsWith("out/"))).toEqual([]);
    }),
    TIMEOUT_MS,
  );

  caseTest(LINE_TASK, "a text without a final LF gets one LF before the line; a name with [ and a name with *, ?, and trailing spaces get backslash escapes that check-ignore matches", SHELL, () =>
    withService({ name: "t057-escapes" }, async (service) => {
      const f = form("none");
      writeFileSync(join(f.repo, "br[ack]et.txt"), "bracket\n");
      const r = await service.register(f.repo);
      expect(await saveLine(service, r, "gitignore", "br[ack]et.txt")).toBe("/br\\[ack]et.txt");
      expect(readFileSync(join(f.repo, ".gitignore"), "latin1")).toBe("*.log\n/br\\[ack]et.txt\n");
      expect(checkIgnore(f.repo, "br[ack]et.txt")).toEqual({ exit: 0, pattern: "/br\\[ack]et.txt", source: ".gitignore" });
      expect((await readOk(service, r.repositoryId)).entries.some((e) => e.path === "br[ack]et.txt")).toBe(false);
      // NTFS cannot hold this name. check-ignore --no-index matches the path text alone.
      const odd = "odd/a*b?c  ";
      expect(await saveLine(service, r, "gitignore", odd)).toBe("/odd/a\\*b\\?c\\ \\ ");
      expect(checkIgnore(f.repo, odd)).toEqual({ exit: 0, pattern: "/odd/a\\*b\\?c\\ \\ ", source: ".gitignore" });
      // Without the escapes, `*` and `?` would match this name too.
      expect(checkIgnore(f.repo, "odd/aXbYc  ")).toEqual({ exit: 1 });
    }),
    TIMEOUT_MS,
  );

  caseTest(LINE_TASK, "info/exclude takes the line at the path that Git names; in a linked worktree that is the file of the common folder, and check-ignore and the fresh status there honor it", SHELL, () =>
    withService({ name: "t057-exclude" }, async (service) => {
      const f = buildLinkedWorktree(gitPath(), `t057-linked-${++builds}`);
      const exclude = join(f.repo, ".git", "info", "exclude");
      const before = existsSync(exclude) ? readFileSync(exclude, "latin1") : "";
      writeFileSync(join(f.linked, "linked-only.txt"), "linked\n");
      const r = await service.register(f.linked);
      expect(await saveLine(service, r, "exclude", "linked-only.txt")).toBe("/linked-only.txt");
      expect(readFileSync(exclude, "latin1")).toBe(`${before}${before === "" || before.endsWith("\n") ? "" : "\n"}/linked-only.txt\n`);
      expect(checkIgnore(f.linked, "linked-only.txt").exit).toBe(0);
      expect((await readOk(service, r.repositoryId)).entries.some((e) => e.path === "linked-only.txt")).toBe(false);
    }),
    TIMEOUT_MS,
  );
});
