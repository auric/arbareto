// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 008 T020: the revert frame of `src/git-service/revert.ts` (plan.md D2, D5a, D10; contract Δ3, Δ6, Δ9; data-model §2, §7, §8).
// The frame drives `revert-unstaged` end to end: the review binds every fact, and the run writes each file through Git's temporary file
// and the shell double of `bun-runner.ts`. Synthetic double replies (`inject.workingReply`) give the per-file outcomes of data-model §8.
// Spec FR-031, FR-003, and FR-049 hold across every run of this file (the last case).

import { describe, expect } from "bun:test";
import { linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunWorkbenchResult } from "../../src/contracts/envelope";
import { GIT_PROCESS_DEADLINE_MS, REGISTERED_DEADLINE_CAP_MS } from "../../src/contracts/limits";
import { LOCKED_REMEDY } from "../../src/git-service/index-lock";
import { printOrigin } from "../origin";
import { faGit, write } from "./file-actions-fixtures";
import { fixtureDir, useFixtureRoot } from "./fixture-root";
import { workingFileDigests } from "./git-oracle";
import { copyRepo, gitPath, gitPathOf, outcome, readOk, SUCCEEDED, TIMEOUT_MS, until, withService } from "./hunk-harness";
import { caseTest, type Capability, type RegistrationResult, type Service, type ServiceResponse, type WorkspaceResult } from "./service-harness";

for (const module of ["revert", "workbench-review", "hunk-publish", "session"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
useFixtureRoot();

const TASK = "T020";
const SHELL: Capability[] = ["shell-double"];
const WINDOWS = process.platform === "win32";

type FileOutcome = { entryId: string; outcome: string; code?: string; reason?: string };
type RevertRun = { action: string; files: FileOutcome[]; foldersCreated: string[]; index: string };
type Reviewed = { action: string; plan: { count: number; paths: string[]; submodules?: number }; workbenchToken: string };

// Every argument array and stdin of every run of this file, for the spec FR-031 and FR-003 case.
const recorded: { arguments: string[]; input: string }[] = [];
const logs: string[] = [];

let builds = 0;
const g = (repo: string, args: string[]) => faGit(gitPath(), repo, args).toString("utf8");

// Three tracked files and two unstaged changes. `extra` runs before the commit, `after` after the changes.
function build(extra?: (repo: string) => void, after?: (repo: string) => void): string {
  const repo = join(fixtureDir(`t020-${++builds}`), "repo");
  mkdirSync(repo, { recursive: true });
  g(repo, ["init", "-q", "-b", "main"]);
  for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"], ["core.filemode", "false"]]) g(repo, ["config", key!, value!]);
  write(repo, "a.txt", "a\n");
  write(repo, "sub/c.txt", "c\n");
  write(repo, "keep.txt", "keep\n");
  extra?.(repo);
  g(repo, ["add", "-A"]);
  g(repo, ["commit", "-q", "--no-verify", "-m", "base"]);
  write(repo, "a.txt", "a changed\n");
  write(repo, "sub/c.txt", "c changed\n");
  after?.(repo);
  return repo;
}

// Git's own `restore .` on a copy (plan.md D13).
function restored(repo: string): Record<string, string> {
  const copy = copyRepo(repo, `t020-oracle-${++builds}`);
  g(copy, ["restore", "."]);
  return workingFileDigests(copy);
}

const indexOf = (repo: string) => g(repo, ["ls-files", "--stage", "-z"]);
const rawIndex = (repo: string) => new Bun.CryptoHasher("sha256").update(readFileSync(gitPathOf(repo, "index"))).digest("hex");
const state = (repo: string) => ({ index: indexOf(repo), raw: rawIndex(repo), files: workingFileDigests(repo) });
const b64 = (path: string) => Buffer.from(path).toString("base64");
const gitTemps = (repo: string) => readdirSync(repo).filter((name) => name.startsWith(".merge_file_"));

async function open(service: Service, repo: string): Promise<{ r: RegistrationResult; read: WorkspaceResult }> {
  const r = await service.register(repo);
  return { r, read: await readOk(service, r.repositoryId) };
}

const review = (service: Service, r: RegistrationResult, read: WorkspaceResult, payload: object = { action: "revert-unstaged" }) =>
  service.request<Reviewed>("reviewWorkbench", { snapshotId: read.snapshotId, ...payload }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });

async function reviewOk(service: Service, r: RegistrationResult, read: WorkspaceResult, payload?: object): Promise<Reviewed> {
  const response = await review(service, r, read, payload);
  expect({ ...outcome(response), result: response.state === "succeeded" ? "plan" : response.result }).toEqual({ ...SUCCEEDED, result: "plan" });
  return response.result!;
}

const sendRun = (service: Service, r: RegistrationResult, token: string) => service.send("runWorkbench", { workbenchToken: token, start: true }, { repositoryId: r.repositoryId });
async function run(service: Service, r: RegistrationResult, token: string): Promise<ServiceResponse<RevertRun>> {
  const response = await service.response<RevertRun>(sendRun(service, r, token));
  if (response.result !== undefined) expect(RunWorkbenchResult.safeParse(response.result).success).toBe(true);
  return response;
}

const idOf = (read: WorkspaceResult, path: string) => read.entries.find((e) => e.path === path && e.category === "unstaged")!.entryId;
const refusal = (response: ServiceResponse<unknown>) => ({ state: response.state, code: response.code, result: response.result });

// Each case keeps its calls and its log for the last case.
async function serviced(name: string, body: (service: Service) => Promise<void>, seams: { approvalClock?: () => number } = {}): Promise<void> {
  await withService({ name, ...seams }, async (service) => {
    try {
      await body(service);
    } finally {
      for (const call of service.runner.calls) recorded.push({ arguments: [...call.arguments], input: call.input === undefined ? "" : Buffer.from(call.input).toString("latin1") });
      logs.push(JSON.stringify(service.log()));
    }
  });
}

describe("revert frame: registration and common refusals (plan.md D2, contract Δ3)", () => {
  caseTest(TASK, "revert-unstaged reviews and runs without trust approval, writes Git's restore bytes, keeps the index, and leaves no Git temporary file", SHELL, () =>
    serviced("t020-run", async (service) => {
      // A registered hook makes the trust listing ask for workbench approval. The revert actions take no class (contract Δ7).
      const repo = build(undefined, (r) => write(r, ".git/hooks/post-checkout", "#!/bin/sh\nexit 0\n"));
      const { r, read } = await open(service, repo);
      expect((await service.readTrust(r.repositoryId)).result?.approvalRequired.workbench).toBe(true);
      const oracle = restored(repo);
      const before = state(repo);
      const reviewed = await reviewOk(service, r, read);
      // The 005 tree order puts the files of a folder before the files beside it (005 FR-015).
      expect(reviewed.plan).toEqual({ count: 2, paths: [b64("sub/c.txt"), b64("a.txt")], submodules: 0 });
      const done = await run(service, r, reviewed.workbenchToken);
      expect({ ...outcome(done), result: done.result }).toEqual({
        ...SUCCEEDED,
        result: { action: "revert-unstaged", files: [{ entryId: idOf(read, "sub/c.txt"), outcome: "reverted" }, { entryId: idOf(read, "a.txt"), outcome: "reverted" }], foldersCreated: [], index: "none" },
      });
      expect(workingFileDigests(repo)).toEqual(oracle);
      expect({ index: indexOf(repo), raw: rawIndex(repo) }).toEqual({ index: before.index, raw: before.raw });
      expect(gitTemps(repo)).toEqual([]);
      const started = service.runner.frames.filter((f) => f.type === "started" && f.kind === "workbench").map((f) => f.action);
      expect(started).toEqual(["revert-unstaged"]);
      // Contract Δ2: the phase `revert-files` carries `fileIndex` and `fileCount`.
      const phases = (service.progress as { phase?: string; counters?: Record<string, number> }[]).filter((p) => p.phase === "revert-files").map((p) => p.counters);
      expect(phases.at(0)).toEqual({ fileIndex: 0, fileCount: 2 });
      expect(phases.at(-1)).toEqual({ fileIndex: 2, fileCount: 2 });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a deletion binds absent with its missing folders, and the run creates them as Git's restore does", SHELL, () =>
    serviced("t020-deleted", async (service) => {
      const repo = build((r) => write(r, "deep/er/d.txt", "d\n"), (r) => rmSync(join(r, "deep"), { recursive: true }));
      const { r, read } = await open(service, repo);
      const oracle = restored(repo);
      const reviewed = await reviewOk(service, r, read);
      const done = await run(service, r, reviewed.workbenchToken);
      expect({ ...outcome(done), folders: done.result?.foldersCreated, outcomes: done.result?.files.map((f) => f.outcome) }).toEqual({ ...SUCCEEDED, folders: [b64("deep"), b64("deep/er")], outcomes: ["reverted", "reverted", "reverted"] });
      expect(workingFileDigests(repo)).toEqual(oracle);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "OPERATION_IN_PROGRESS, unknown-operation, and CONFLICTED refuse the three actions before any token", SHELL, () =>
    serviced("t020-states", async (service) => {
      const repo = build();
      const { r, read } = await open(service, repo);
      const head = g(repo, ["rev-parse", "HEAD"]).trim();
      const payloads = [{ action: "revert-unstaged" }, { action: "revert-files", entryIds: [idOf(read, "a.txt")] }, { action: "revert-lines", comparisonId: crypto.randomUUID(), hunkId: crypto.randomUUID() }];
      writeFileSync(gitPathOf(repo, "MERGE_HEAD"), `${head}\n`);
      for (const p of payloads) expect(outcome(await review(service, r, read, p))).toEqual({ state: "failed", code: "OPERATION_IN_PROGRESS" });
      rmSync(gitPathOf(repo, "MERGE_HEAD"));
      mkdirSync(gitPathOf(repo, "rebase-apply"), { recursive: true });
      writeFileSync(join(gitPathOf(repo, "rebase-apply"), "applying"), "");
      for (const p of payloads) expect(refusal(await review(service, r, read, p))).toEqual({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason: "unknown-operation" } });
      rmSync(gitPathOf(repo, "rebase-apply"), { recursive: true });
      // An unmerged index without a marker: the shown read lists the conflicted path.
      const blob = faGit(gitPath(), repo, ["hash-object", "-w", "--stdin"], { input: "side\n" }).toString("utf8").trim();
      faGit(gitPath(), repo, ["update-index", "--index-info"], { input: `0 ${"0".repeat(40)}\tkeep.txt\n100644 ${blob} 1\tkeep.txt\n100644 ${blob} 2\tkeep.txt\n` });
      const conflicted = await readOk(service, r.repositoryId);
      for (const p of payloads) expect(refusal(await review(service, r, conflicted, { ...p, ...(p.action === "revert-files" ? { entryIds: [idOf(conflicted, "a.txt")] } : {}) }))).toEqual({ state: "failed", code: "CONFLICTED", result: { unmerged: 1 } });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "an index.lock at the review or at the run start gives LOCKED with the lock path and the 001 remedy, and nothing changes", SHELL, () =>
    serviced("t020-locked", async (service) => {
      const repo = build();
      const { r, read } = await open(service, repo);
      const lock = `${gitPathOf(repo, "index")}.lock`;
      writeFileSync(lock, "");
      const locked = { state: "failed", code: "LOCKED", result: { path: expect.stringMatching(/index\.lock$/), remedy: { text: LOCKED_REMEDY } } };
      expect(refusal(await review(service, r, read))).toEqual(locked);
      rmSync(lock);
      const reviewed = await reviewOk(service, r, read);
      const before = state(repo);
      writeFileSync(lock, "");
      const done = await run(service, r, reviewed.workbenchToken);
      // Contract Δ3 `runWorkbench`: the run gives the lock path and the 001 remedy, as the review does (001 FR-016).
      expect(refusal(done)).toEqual(locked);
      rmSync(lock);
      expect(state(repo)).toEqual(before);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a batch whose blob sizes pass the registered cap gets the size-rule deadline for checkout-index --temp (contract Δ3)", SHELL, () =>
    serviced("t020-size-rule", async (service) => {
      const repo = build();
      const { r, read } = await open(service, repo);
      // `cat-file --batch-check` names each source blob 7 GB, so the batch deadline passes REGISTERED_DEADLINE_CAP_MS. The review and the run read the same sizes.
      const BIG = 7_000_000_000;
      service.runner.inject.stdout = (call) =>
        call.arguments.includes("--batch-check") && call.input !== undefined
          ? Buffer.from(
              Buffer.from(call.input)
                .toString("latin1")
                .split("\n")
                .filter((oid) => oid.length > 0)
                .map((oid) => `${oid} blob ${BIG}\n`)
                .join(""),
            )
          : undefined;
      try {
        const reviewed = await reviewOk(service, r, read);
        expect(outcome(await run(service, r, reviewed.workbenchToken))).toEqual(SUCCEEDED);
      } finally {
        service.runner.inject.stdout = undefined;
      }
      const deadlines = service.runner.calls.filter((c) => c.arguments.includes("checkout-index")).map((c) => c.limits?.deadlineMs);
      expect(deadlines).toEqual([GIT_PROCESS_DEADLINE_MS + Math.ceil((2 * BIG) / (64 * 1024 * 1024)) * 1000]);
      expect(deadlines[0]).toBeGreaterThan(REGISTERED_DEADLINE_CAP_MS);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a running revert makes a second one BUSY", SHELL, () =>
    serviced("t020-busy", async (service) => {
      const repo = build();
      const { r, read } = await open(service, repo);
      const first = await reviewOk(service, r, read);
      const second = await reviewOk(service, r, read);
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      service.runner.inject.holdWalk = (kind) => (kind === "fileReplace" ? gate : Promise.resolve());
      try {
        const held = sendRun(service, r, first.workbenchToken);
        await until(() => service.runner.frames.some((f) => f.type === "fileReplace"), "the first fileReplace frame");
        expect(outcome(await run(service, r, second.workbenchToken))).toEqual({ state: "rejected", code: "BUSY" });
        release();
        expect(outcome(await service.response(held))).toEqual(SUCCEEDED);
      } finally {
        release();
        service.runner.inject.holdWalk = null;
      }
    }),
    TIMEOUT_MS,
  );
});

describe("revert frame: the refusal order and the bound (plan.md D2, data-model §2 and §7)", () => {
  caseTest(TASK, "per file the 001 support reasons come before the file facts, and the file facts before attributes; the value names each file in tree order", SHELL, () =>
    serviced("t020-order", async (service) => {
      // `*.txt eol=crlf` in the working `.gitattributes` differs from the index, so every `.txt` file has the `attributes` reason too.
      const repo = build(
        (r) => {
          write(r, ".gitattributes", "\n");
          for (const name of ["f.txt", "h.txt", "k.txt"]) write(r, name, `${name}\n`);
        },
        (r) => {
          write(r, ".gitattributes", "*.txt eol=crlf\nf.txt filter=foo\n");
          for (const name of ["f.txt", "h.txt", "k.txt"]) write(r, name, `${name} changed\n`);
          linkSync(join(r, "h.txt"), join(fixtureDir(`t020-link-${builds}`), "h-link.txt"));
        },
      );
      const { r, read } = await open(service, repo);
      const before = state(repo);
      // The first file in tree order names the code and the reason (contract Δ3 "Refusal value").
      expect(refusal(await review(service, r, read))).toEqual({
        state: "failed",
        code: "WORKBENCH_UNAVAILABLE",
        result: {
          reason: "attributes",
          files: [
            { path: b64("sub/c.txt"), reason: "attributes" },
            { path: b64("a.txt"), reason: "attributes" },
            { path: b64("f.txt"), reason: "filter" },
            { path: b64("h.txt"), reason: "hard-link" },
            { path: b64("k.txt"), reason: "attributes" },
          ],
          more: 0,
        },
      });
      expect(state(repo)).toEqual(before);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a file changed between the review and the run gives STALE_REVIEW with revert-changed, and nothing changes", SHELL, () =>
    serviced("t020-stale", async (service) => {
      const repo = build();
      const { r, read } = await open(service, repo);
      const reviewed = await reviewOk(service, r, read);
      write(repo, "a.txt", "a changed again\n");
      const before = state(repo);
      expect(refusal(await run(service, r, reviewed.workbenchToken))).toEqual({ state: "failed", code: "STALE_REVIEW", result: { action: "revert-unstaged", reason: "revert-changed" } });
      expect(state(repo)).toEqual(before);
    }),
    TIMEOUT_MS,
  );

  let clock = 0;
  caseTest(TASK, "a run after the 60 s token lifetime gives APPROVAL_EXPIRED, and nothing changes (the approval clock seam)", SHELL, () =>
    serviced(
      "t020-expired",
      async (service) => {
        const repo = build();
        const { r, read } = await open(service, repo);
        clock = 1_000;
        const reviewed = await reviewOk(service, r, read);
        clock += 60_001;
        const before = state(repo);
        expect(outcome(await run(service, r, reviewed.workbenchToken))).toEqual({ state: "rejected", code: "APPROVAL_EXPIRED" });
        expect(state(repo)).toEqual(before);
      },
      { approvalClock: () => clock },
    ),
    TIMEOUT_MS,
  );
});

describe("revert frame: per-file outcomes and response states (data-model §8, plan.md D10)", () => {
  // `reply` gives the synthetic shell reply of each path, or undefined for the real double write.
  async function runWith(name: string, reply: (path: string) => object | undefined, check: (done: ServiceResponse<RevertRun>, repo: string, read: WorkspaceResult, before: ReturnType<typeof state>) => void) {
    await serviced(name, async (service) => {
      const repo = build();
      const { r, read } = await open(service, repo);
      const reviewed = await reviewOk(service, r, read);
      const before = state(repo);
      service.runner.inject.workingReply = (request) => reply(request.path) as never;
      try {
        check(await run(service, r, reviewed.workbenchToken), repo, read, before);
      } finally {
        service.runner.inject.workingReply = null;
      }
      // D5a step 6: every Git temporary file that no write consumed goes through `tempRemove`.
      expect(gitTemps(repo)).toEqual([]);
    });
  }
  const isA = (path: string) => path.endsWith("a.txt");

  caseTest(TASK, "a failed write of one file and a reverted second file give failed-with-effects with each fresh outcome", SHELL, () =>
    runWith(
      "t020-mixed",
      (path) => (isA(path) ? { result: "error", code: "sharing-violation" } : undefined),
      (done, repo, read, before) => {
        expect({ state: done.state, code: done.code, files: done.result?.files }).toEqual({
          state: "failed-with-effects",
          code: "FAILED_WITH_EFFECTS",
          files: [
            { entryId: idOf(read, "sub/c.txt"), outcome: "reverted" },
            { entryId: idOf(read, "a.txt"), outcome: "not-changed", code: "error", reason: "sharing-violation" },
          ],
        });
        expect(workingFileDigests(repo)["a.txt"]).toBe(before.files["a.txt"]);
      },
    ),
    TIMEOUT_MS,
  );

  caseTest(TASK, "no file changed: stale gives failed STALE_REVIEW, a refusal gives failed WORKBENCH_UNAVAILABLE, and every outcome is not-changed with its code", SHELL, async () => {
    await runWith(
      "t020-stale-replies",
      () => ({ result: "stale" }),
      (done, repo, _read, before) => {
        expect({ state: done.state, code: done.code, outcomes: done.result?.files.map((f) => [f.outcome, f.code]) }).toEqual({ state: "failed", code: "STALE_REVIEW", outcomes: [["not-changed", "stale"], ["not-changed", "stale"]] });
        expect(state(repo)).toEqual(before);
      },
    );
    await runWith(
      "t020-refused-replies",
      () => ({ result: "refused", reason: "security" }),
      (done, repo, _read, before) => {
        expect({ state: done.state, code: done.code, outcomes: done.result?.files.map((f) => [f.outcome, f.code, f.reason]) }).toEqual({
          state: "failed",
          code: "WORKBENCH_UNAVAILABLE",
          outcomes: [
            ["not-changed", "refused", "security"],
            ["not-changed", "refused", "security"],
          ],
        });
        expect(state(repo)).toEqual(before);
      },
    );
  }, TIMEOUT_MS);

  caseTest(TASK, "a write that leaves other bytes gives changed-outside and failed-with-effects", SHELL, () =>
    runWith(
      "t020-outside",
      (path) => {
        if (!isA(path)) return undefined;
        writeFileSync(path, "another writer\n");
        // A `replaced` reply always consumes Git's temporary file (contract Δ6 `source`), so the synthetic reply removes it too.
        for (const name of gitTemps(join(path, ".."))) rmSync(join(path, "..", name));
        return { result: "replaced" };
      },
      (done) => {
        expect({ state: done.state, outcomes: done.result?.files.map((f) => f.outcome) }).toEqual({ state: "failed-with-effects", outcomes: ["reverted", "changed-outside"] });
      },
    ),
    TIMEOUT_MS,
  );

  caseTest(TASK, "Cancel during the first write gives canceled with not-changed and not-started; Cancel after it gives failed-with-effects", SHELL, async () => {
    for (const late of [false, true]) {
      await serviced(`t020-cancel-${late}`, async (service) => {
        const repo = build();
        const { r, read } = await open(service, repo);
        const reviewed = await reviewOk(service, r, read);
        const before = state(repo);
        let release = () => {};
        const gate = new Promise<void>((resolve) => (release = resolve));
        let writes = 0;
        service.runner.inject.holdWalk = (kind) => (kind === "fileReplace" && ++writes === (late ? 2 : 1) ? gate : Promise.resolve());
        try {
          const requestId = sendRun(service, r, reviewed.workbenchToken);
          await until(() => service.runner.frames.filter((f) => f.type === "fileReplace").length === (late ? 2 : 1), "the held fileReplace frame");
          await service.cancel(await service.operationId(requestId));
          const done = await service.response<RevertRun>(requestId);
          if (late) {
            expect({ state: done.state, outcomes: done.result?.files.map((f) => f.outcome) }).toEqual({ state: "failed-with-effects", outcomes: ["reverted", "not-changed"] });
          } else {
            expect({ state: done.state, code: done.code, outcomes: done.result?.files.map((f) => f.outcome) }).toEqual({ state: "canceled", code: "CANCELED", outcomes: ["not-changed", "not-started"] });
            expect(state(repo)).toEqual(before);
          }
          expect(gitTemps(repo)).toEqual([]);
        } finally {
          release();
          service.runner.inject.holdWalk = null;
        }
      });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "a shell end during a write leaves the recovery marker, and the outcome stays unknown", SHELL, () =>
    serviced("t020-crash", async (service) => {
      const repo = build();
      const { r, read } = await open(service, repo);
      const reviewed = await reviewOk(service, r, read);
      service.runner.inject.replaceStep = (step) => (step === "written" ? "crash" : undefined);
      try {
        const done = await run(service, r, reviewed.workbenchToken);
        expect({ state: done.state, code: done.code }).toEqual({ state: "unknown", code: "STATE_UNKNOWN" });
      } finally {
        service.runner.inject.replaceStep = null;
      }
      expect([...service.runner.markers.values()].filter((m) => m.kind === "workbench").map((m) => m.action)).toEqual(["revert-unstaged"]);
      for (const name of gitTemps(repo)) rmSync(join(repo, name));
    }),
    TIMEOUT_MS,
  );

  // Review of batch 1, finding 4: after a Cancel, a request whose reply did not come within the service wait can still write. Only the shell's own `stopped` means stopped.
  caseTest(TASK, "Cancel during a slow source copy whose reply comes too late gives an unknown outcome, and the marker stays", SHELL, () =>
    serviced("t020-late-reply", async (service) => {
      const repo = build();
      const { r, read } = await open(service, repo);
      const reviewed = await reviewOk(service, r, read);
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reached = () => {};
      const atWrite = new Promise<void>((resolve) => (reached = resolve));
      service.runner.inject.cancelWaitMs = 0;
      service.runner.inject.replaceStep = async (step) => {
        if (step !== "written") return undefined;
        reached();
        await gate;
        return undefined;
      };
      try {
        const requestId = sendRun(service, r, reviewed.workbenchToken);
        await atWrite;
        await service.cancel(await service.operationId(requestId));
        const done = await service.response<RevertRun>(requestId);
        expect({ state: done.state, code: done.code }).toEqual({ state: "unknown", code: "STATE_UNKNOWN" });
        expect([...service.runner.markers.values()].filter((m) => m.kind === "workbench").map((m) => m.action)).toEqual(["revert-unstaged"]);
        release();
        // The write lands after the response, which is why the outcome had to stay unknown.
        await until(() => readFileSync(join(repo, "sub", "c.txt"), "utf8") === "c\n", "the late write");
      } finally {
        release();
        service.runner.inject.cancelWaitMs = null;
        service.runner.inject.replaceStep = null;
      }
      await until(() => gitTemps(repo).length === 0, "the late source removal");
    }),
    TIMEOUT_MS,
  );

  // Review of batch 1, finding 6: the digest of the sent bytes decides `reverted`, also after a reply that does not say `replaced`.
  caseTest(TASK, "an interrupted reply after a landed rename gives reverted; a shell deadline before the writes gives failed DEADLINE", SHELL, async () => {
    await runWith(
      "t020-interrupted",
      (path) => {
        if (!path.endsWith("a.txt")) return undefined;
        // The synthetic shell copies Git's temporary file over the target, then loses its output.
        const name = gitTemps(join(path, ".."))[0]!;
        writeFileSync(path, readFileSync(join(path, "..", name)));
        rmSync(join(path, "..", name));
        return { result: "interrupted" };
      },
      (done) => {
        expect({ ...outcome(done), outcomes: done.result?.files.map((f) => f.outcome) }).toEqual({ ...SUCCEEDED, outcomes: ["reverted", "reverted"] });
      },
    );
    await runWith(
      "t020-deadline",
      () => ({ result: "stopped" }),
      (done, repo, _read, before) => {
        expect({ state: done.state, code: done.code, outcomes: done.result?.files.map((f) => f.outcome) }).toEqual({ state: "failed", code: "DEADLINE", outcomes: ["not-changed", "not-started"] });
        expect(state(repo)).toEqual(before);
      },
    );
  }, TIMEOUT_MS);

  // Review of batch 1, finding 2: only a complete record `<name> TAB <batch path> NUL` names a file that the run may remove.
  caseTest(TASK, "a truncated or a stray checkout-index record never removes a named root file", SHELL, async () => {
    for (const [name, output] of [
      ["t020-truncated", "keep.txt\tsub/c.txt"],
      ["t020-stray", "keep.txt\tother.txt\0"],
    ] as const) {
      await serviced(name, async (service) => {
        const repo = build();
        const { r, read } = await open(service, repo);
        const reviewed = await reviewOk(service, r, read);
        const before = state(repo);
        service.runner.inject.stdout = (call) => (call.arguments.includes("checkout-index") ? Buffer.from(output, "latin1") : undefined);
        try {
          const done = await run(service, r, reviewed.workbenchToken);
          expect(outcome(done)).toEqual({ state: "failed", code: "MALFORMED_GIT_OUTPUT" });
        } finally {
          service.runner.inject.stdout = undefined;
        }
        expect(state(repo)).toEqual(before);
        expect(readFileSync(join(repo, "keep.txt"), "utf8")).toBe("keep\n");
      });
    }
  }, TIMEOUT_MS);
});

describe("revert frame: Git arguments and logs (spec FR-031, FR-003, FR-049)", () => {
  caseTest(TASK, "the option-like path -x and the path :(glob)* pass after -- or on stdin", SHELL, () =>
    serviced("t020-paths", async (service) => {
      const repo = build((r) => write(r, "-x", "x\n"), (r) => write(r, "-x", "x changed\n"));
      if (!WINDOWS) {
        write(repo, ":(glob)*", "glob\n");
        g(repo, ["--literal-pathspecs", "add", "--", ":(glob)*"]);
        g(repo, ["commit", "-q", "--no-verify", "-m", "glob"]);
        write(repo, ":(glob)*", "glob changed\n");
      }
      const { r, read } = await open(service, repo);
      const reviewed = await reviewOk(service, r, read);
      expect(outcome(await run(service, r, reviewed.workbenchToken))).toEqual(SUCCEEDED);
      expect(workingFileDigests(repo)["-x"]).toBe(new Bun.CryptoHasher("sha256").update("x\n").digest("hex"));
    }),
    TIMEOUT_MS,
  );

  // This case runs last, so it sees the calls and the logs of every case before it.
  caseTest(TASK, "across every run of this file: no Git command writes a target, every array starts with --no-lazy-fetch, a path follows --, and no log holds bytes or paths", SHELL, () => {
    // Spec FR-031: no Git command writes a target. Spec FR-003: every array starts with `--no-lazy-fetch`, and a path is a literal after `--` or on stdin.
    const forbidden = recorded.filter(({ arguments: a }) => {
      const sub = a.find((arg, i) => i > 0 && !arg.startsWith("-"));
      return (sub === "apply" && !a.includes("--cached")) || sub === "checkout" || sub === "restore" || (sub === "checkout-index" && !a.includes("--temp")) || sub === "reset" || sub === "stash";
    });
    expect(forbidden).toEqual([]);
    expect(recorded.length).toBeGreaterThan(0);
    // Only the `gitProbe` arrays of the Git selection omit it (src/git-service/commands.ts `NO_LAZY_FETCH`).
    expect(recorded.filter(({ arguments: a }) => a[0] !== "--no-lazy-fetch" && !(a.length <= 2 && (a[0] === "version" || a[0] === "--exec-path")))).toEqual([]);
    for (const path of ["-x", ":(glob)*", "a.txt", "sub/c.txt"]) {
      const misplaced = recorded.filter(({ arguments: a }) => a.includes(path) && !(a.indexOf("--") >= 0 && a.indexOf("--") < a.indexOf(path)));
      expect({ path, misplaced }).toEqual({ path, misplaced: [] });
    }
    // Spec FR-049: no log entry holds file bytes, patch text, or a path.
    for (const text of ["a changed", "c changed", "x changed", "a.txt", "sub/c.txt", b64("a.txt"), "-x\"", "@@ "]) {
      expect({ text, logged: logs.some((log) => log.includes(text)) }).toEqual({ text, logged: false });
    }
  });
});
