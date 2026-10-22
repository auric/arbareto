// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T033: the ignore editor read and Save, service part (feature 005 plan.md D8 and D10, contract Δ3 `readIgnoreFile` and `reviewWorkbench` `ignore-save`,
// Δ6 `fileReplace`, data-model §6 and §8, quickstart.md Q23 and Q24). The shell test double of `bun-runner.ts` serves `fileReplace` by the contract Δ6 rules.

import { describe, expect } from "bun:test";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReadIgnoreFileResult, ReviewWorkbenchResult, RunWorkbenchResult } from "../../src/contracts/envelope";
import { PUBLIC_REQUEST_BYTES } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import { buildConflicted, buildIgnoreForm, buildLinkedWorktree, faGit, type FaFixture, type IgnoreForm } from "./file-actions-fixtures";
import { useFixtureRoot } from "./fixture-root";
import { workingFileDigests } from "./git-oracle";
import { gitPath, outcome, readOk, SUCCEEDED, subcommand, until, withService } from "./hunk-harness";
import { caseTest, type Capability, type RegistrationResult, type Service, type ServiceResponse } from "./service-harness";

for (const module of ["ignore", "ignore-text", "workbench-review", "native-runner", "session"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
useFixtureRoot();

const TASK = "T033";
const SHELL: Capability[] = ["shell-double"];
const TIMEOUT_MS = 120_000;

let builds = 0;
const form = (f: IgnoreForm): FaFixture => buildIgnoreForm(gitPath(), `t033-${f}-${++builds}`, f);
const sha = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const b64 = (text: string | Uint8Array) => Buffer.from(text).toString("base64");

type IgnoreFile = { target: string; file: string; state: "absent" | "file"; text: string; lineEnding: string; bom: boolean; expected: "absent" | { size: number; sha256: string } };
type SaveReview = { action: "ignore-save"; plan: { target: string; file: string; size: number; sha256: string }; workbenchToken: string };

async function readIgnore(service: Service, r: RegistrationResult, target: "gitignore" | "exclude"): Promise<ServiceResponse<IgnoreFile>> {
  const response = await service.request<IgnoreFile>("readIgnoreFile", { target }, { repositoryId: r.repositoryId, repositoryGeneration: r.generation });
  if (response.result !== undefined) expect(ReadIgnoreFileResult.safeParse(response.result).success).toBe(true);
  return response;
}

function reviewSave(service: Service, r: RegistrationResult, target: "gitignore" | "exclude", text: string | Uint8Array, expected: IgnoreFile["expected"]): Promise<ServiceResponse<SaveReview>> {
  return service.request<SaveReview>("reviewWorkbench", { action: "ignore-save", target, text: b64(text), expected }, { repositoryId: r.repositoryId, repositoryGeneration: r.generation });
}

const sendRun = (service: Service, r: RegistrationResult, token: string) => service.send("runWorkbench", { workbenchToken: token, start: true }, { repositoryId: r.repositoryId });
async function save(service: Service, r: RegistrationResult, target: "gitignore" | "exclude", text: string, expected: IgnoreFile["expected"]): Promise<ServiceResponse<{ action: string; outcome?: string; reason?: string }>> {
  const review = await reviewSave(service, r, target, text, expected);
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

  caseTest(TASK, "a folder, a file above 1 MiB, invalid UTF-8, a NUL, mixed endings, and a lone CR each refuse with its reason and change no byte", SHELL, () =>
    withService({ name: "t033-read-refusals" }, async (service) => {
      const cases: [IgnoreForm, string][] = [
        ["folder", "ignore-folder"],
        ["big", "ignore-size"],
        ["not-utf8", "ignore-not-utf8"],
        ["nul", "ignore-nul"],
        ["mixed", "mixed-line-endings"],
        ["lone-cr", "mixed-line-endings"],
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

  caseTest(TASK, "new bytes above 1 MiB give ignore-size; a NUL gives ignore-nul; a CR in the text gives mixed-line-endings; a 1 MiB text of short lines fits one request", SHELL, () =>
    withService({ name: "t033-save-bounds" }, async (service) => {
      const f = form("crlf");
      const r = await service.register(f.repo);
      const read = await readIgnore(service, r, "gitignore");
      // 400,000 lines of "a" give 800,000 bytes with LF and 1,200,000 bytes with the CRLF of the file.
      expect(refusal(await reviewSave(service, r, "gitignore", "a\n".repeat(400_000), read.result!.expected))).toEqual(unavailable("ignore-size"));
      expect(refusal(await reviewSave(service, r, "gitignore", "a\n\0\n", read.result!.expected))).toEqual(unavailable("ignore-nul"));
      expect(refusal(await reviewSave(service, r, "gitignore", "a\r\nb\n", read.result!.expected))).toEqual(unavailable("mixed-line-endings"));
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
