// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 008 T044: races and interruptions of `src/git-service/revert.ts` (plan.md D2, D5a, D8, D10; spec FR-011, FR-036, SC-003, SC-005).
// Seams: the `revertCheckpoint` steps (`workbench-review.ts` `RevertCheckpoint`) and the `replaceStep` steps of the shell double (`bun-runner.ts`).
// A fresh read decides each outcome (plan.md D10).

import { describe, expect } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { RunWorkbenchResult } from "../../src/contracts/envelope";
import type { RevertCheckpoint } from "../../src/git-service/workbench-review";
import { printOrigin } from "../origin";
import type { ReplaceStep } from "./bun-runner";
import { faGit, write } from "./file-actions-fixtures";
import { fixtureDir, useFixtureRoot } from "./fixture-root";
import { workingFileDigests } from "./git-oracle";
import { compare, copyRepo, entryOf, gitPath, gitPathOf, outcome, readOk, subcommand, SUCCEEDED, TIMEOUT_MS, withService } from "./hunk-harness";
import { caseTest, type Capability, type ChangeEntry, type RegistrationResult, type Service, type ServiceResponse, type WorkspaceResult } from "./service-harness";

for (const module of ["revert", "workbench-review", "hunk-publish", "multi-publish"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
useFixtureRoot();

const TASK = "T044";
const SHELL: Capability[] = ["shell-double"];

// The line-ending keys and `core.filemode` of `tests/git/fixtures.ts` `lineEndings`.
const LINE_ENDINGS: [string, string][] = [
  ["core.autocrlf", "false"],
  ["core.eol", "lf"],
  ["core.safecrlf", "false"],
  ["core.filemode", "false"],
];

type Category = ChangeEntry["category"];
type FileOutcome = { entryId: string; outcome: string; code?: string; reason?: string };
type RevertRun = { action: string; files: FileOutcome[]; foldersCreated: string[]; index: string; reason?: string };

let builds = 0;
const g = (repo: string, args: string[], input?: string) => faGit(gitPath(), repo, args, input === undefined ? {} : { input });
const add = (repo: string, ...paths: string[]) => g(repo, ["--literal-pathspecs", "add", "--", ...paths]);
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

const BASE = { ".gitattributes": "\n", "f.txt": "a\nb\nc\nd\n", "sub/g.txt": "g\n", "gone.txt": "gone\n", "keep.txt": "keep\n" };
const F_OLD = "a\nB\nc\nd\n";

interface Target {
  path: string;
  // Null: no file at the path.
  old: string | null;
  new: string | null;
}

interface Variant {
  id: string;
  action: "revert-lines" | "revert-files" | "revert-unstaged";
  change(repo: string): void;
  // In tree order, as the run writes them and the result lists them (005 FR-015).
  targets: Target[];
  rows?: [string, Category][];
  comparison?: [string, Category];
  index: "published" | "none";
  // False for a staged new file: the run writes no working file (spec FR-021).
  writes: boolean;
}

const F: Target = { path: "f.txt", old: F_OLD, new: BASE["f.txt"] };
const G: Target = { path: "sub/g.txt", old: "G\n", new: BASE["sub/g.txt"] };
const unstagedFG = (r: string) => {
  write(r, "f.txt", F.old!);
  write(r, "sub/g.txt", G.old!);
};

const VARIANTS: Variant[] = [
  { id: "lines", action: "revert-lines", change: (r) => write(r, "f.txt", F_OLD), targets: [F], comparison: ["f.txt", "unstaged"], index: "none", writes: true },
  {
    id: "staged-lines",
    action: "revert-lines",
    change: (r) => {
      write(r, "f.txt", F_OLD);
      add(r, "f.txt");
    },
    targets: [F],
    comparison: ["f.txt", "staged"],
    index: "published",
    writes: true,
  },
  { id: "files", action: "revert-files", change: unstagedFG, targets: [G, F], rows: [["f.txt", "unstaged"], ["sub/g.txt", "unstaged"]], index: "none", writes: true },
  {
    id: "staged-files",
    action: "revert-files",
    change: (r) => {
      unstagedFG(r);
      add(r, "f.txt", "sub/g.txt");
    },
    targets: [G, F],
    rows: [["f.txt", "staged"], ["sub/g.txt", "staged"]],
    index: "published",
    writes: true,
  },
  {
    id: "new-file",
    action: "revert-files",
    change: (r) => {
      write(r, "n.txt", "n\n");
      add(r, "n.txt");
    },
    targets: [{ path: "n.txt", old: "n\n", new: "n\n" }],
    rows: [["n.txt", "staged"]],
    index: "published",
    writes: false,
  },
  { id: "unstaged", action: "revert-unstaged", change: unstagedFG, targets: [G, F], index: "none", writes: true },
  // An unstaged deletion: the write creates an absent target (plan.md D8 `link`).
  { id: "restore", action: "revert-unstaged", change: (r) => rmSync(join(r, "gone.txt")), targets: [{ path: "gone.txt", old: null, new: "gone\n" }], index: "none", writes: true },
];
const variant = (id: string) => VARIANTS.find((v) => v.id === id)!;

// One template per variant. Each case works on its own copy.
const templates = new Map<string, string>();
function fixture(v: Variant): string {
  let template = templates.get(v.id);
  if (template === undefined) {
    template = join(fixtureDir(`t044-template-${v.id}`), "repo");
    mkdirSync(template, { recursive: true });
    g(template, ["init", "-q", "-b", "main"]);
    for (const [key, value] of LINE_ENDINGS) g(template, ["config", key, value]);
    for (const [path, content] of Object.entries(BASE)) write(template, path, content);
    g(template, ["add", "-A"]);
    g(template, ["commit", "-q", "--no-verify", "-m", "base"]);
    v.change(template);
    templates.set(v.id, template);
  }
  return copyRepo(template, `t044-${v.id}-${++builds}`);
}

const state = (repo: string) => ({ index: g(repo, ["ls-files", "--stage", "-z"]).toString("latin1"), raw: sha256(readFileSync(gitPathOf(repo, "index"))), files: workingFileDigests(repo) });
const bytesOf = (repo: string, path: string) => {
  const file = join(repo, ...path.split("/"));
  return existsSync(file) ? readFileSync(file).toString("latin1") : null;
};
const refusal = (response: ServiceResponse<unknown>) => ({ state: response.state, code: response.code, result: response.result });
const writeFrames = (service: Service) => service.runner.frames.filter((f) => f.type === "fileReplace" || f.type === "tempRemove").length;
const writers = (service: Service, from: number) => service.runner.calls.slice(from).flatMap((c) => subcommand(c.arguments) ?? []).filter((s) => s === "update-index" || s === "checkout-index");
// The request path of the shell double is native, so a target matches by its native tail.
const nativeTail = (path: string) => sep + join(...path.split("/"));

// Git's temporary files in the worktree root and the shell temporary files beside each target (contract "Known limits").
function leftovers(repo: string): { merge: number; replace: number } {
  const names: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (dir === repo && e.name === ".git") continue;
      if (e.isDirectory()) walk(join(dir, e.name));
      else names.push(e.name);
    }
  };
  walk(repo);
  return { merge: names.filter((n) => n.startsWith(".merge_file_")).length, replace: names.filter((n) => /^\.arbareto-[0-9a-f]+\.tmp$/.test(n)).length };
}

async function payloadOf(service: Service, r: RegistrationResult, read: WorkspaceResult, v: Variant): Promise<object> {
  if (v.action === "revert-unstaged") return { action: v.action };
  if (v.action === "revert-files") return { action: v.action, entryIds: v.rows!.map(([path, category]) => entryOf(read, path, category).entryId) };
  const c = await compare(service, r.repositoryId, v.comparison![0], v.comparison![1], read);
  expect({ variant: v.id, ...outcome(c.response) }).toEqual({ variant: v.id, ...SUCCEEDED });
  return { action: v.action, comparisonId: c.comparisonId, hunkId: c.hunkIds[0] };
}

const review = (service: Service, r: RegistrationResult, read: WorkspaceResult, payload: object) =>
  service.request<{ workbenchToken: string }>("reviewWorkbench", { snapshotId: read.snapshotId, ...payload }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });

// A registered copy of the variant fixture and its review token.
async function reviewed(service: Service, v: Variant): Promise<{ repo: string; r: RegistrationResult; read: WorkspaceResult; token: string }> {
  const repo = fixture(v);
  const r = await service.register(repo);
  const read = await readOk(service, r.repositoryId);
  const response = await review(service, r, read, await payloadOf(service, r, read, v));
  expect({ variant: v.id, ...outcome(response), result: response.state === "succeeded" ? "plan" : response.result }).toEqual({ variant: v.id, ...SUCCEEDED, result: "plan" });
  return { repo, r, read, token: response.result!.workbenchToken };
}

async function run(service: Service, r: RegistrationResult, token: string): Promise<ServiceResponse<RevertRun>> {
  const response = await service.response<RevertRun>(service.send("runWorkbench", { workbenchToken: token, start: true }, { repositoryId: r.repositoryId }));
  if (response.result !== undefined) expect(RunWorkbenchResult.safeParse(response.result).success).toBe(true);
  return response;
}

// SC-003: the bound facts that a review binds. Each change comes after the review and before the run.
const blob = (repo: string, content: string) => g(repo, ["hash-object", "-w", "--stdin"], content).toString("utf8").trim();
const FACTS: { id: string; apply(repo: string, v: Variant): void }[] = [
  { id: "file", apply: (repo, v) => void write(repo, v.targets[0]!.path, "outside\n") },
  { id: "index entry", apply: (repo, v) => void g(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob(repo, "index\n")},${v.targets[0]!.path}`]) },
  { id: "attributes", apply: (repo) => void write(repo, ".gitattributes", "*.txt eol=crlf\n") },
  { id: "configuration", apply: (repo) => void g(repo, ["config", "--local", "test.race", "changed"]) },
];
// A new commit with the same tree: HEAD moves, and the index and the working files stay.
const moveHead = (repo: string) => g(repo, ["update-ref", "HEAD", g(repo, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "moved"]).toString("utf8").trim()]);

describe("revert races: a bound fact that changes between the review and the run (SC-003, spec FR-011)", () => {
  for (const v of VARIANTS) {
    caseTest(TASK, `${v.id}: a change of the file, the index entry, the attributes, or the configuration gives STALE_REVIEW with revert-changed, and nothing changes`, SHELL, () =>
      withService({ name: `t044-stale-${v.id}` }, async (service) => {
        for (const fact of FACTS) {
          const { repo, r, token } = await reviewed(service, v);
          fact.apply(repo, v);
          const before = state(repo);
          const calls = service.runner.calls.length;
          const frames = writeFrames(service);
          const label = { variant: v.id, fact: fact.id };
          expect({ ...label, ...refusal(await run(service, r, token)) }).toEqual({ ...label, state: "failed", code: "STALE_REVIEW", result: { action: v.action, reason: "revert-changed" } });
          expect({ ...label, state: state(repo), writes: writeFrames(service) - frames, writers: writers(service, calls) }).toEqual({ ...label, state: before, writes: 0, writers: [] });
        }
      }),
      TIMEOUT_MS,
    );
  }

  // Data-model §6 step 5: the working bytes no longer hold the hunk context, so the review refuses as stale.
  caseTest(TASK, "staged-lines: a working change in the hunk context after the status read gives STALE_SELECTION, and nothing changes", SHELL, () =>
    withService({ name: "t044-staged-context" }, async (service) => {
      const repo = fixture(variant("staged-lines"));
      const r = await service.register(repo);
      const read = await readOk(service, r.repositoryId);
      const c = await compare(service, r.repositoryId, "f.txt", "staged", read);
      write(repo, "f.txt", "a\nB\nC\nd\n");
      const before = state(repo);
      expect(refusal(await review(service, r, read, { action: "revert-lines", comparisonId: c.comparisonId, hunkId: c.hunkIds[0] }))).toEqual({ state: "failed", code: "STALE_SELECTION", result: undefined });
      expect(state(repo)).toEqual(before);
    }),
    TIMEOUT_MS,
  );
});

describe("revert races: an external writer during the run gives changed-outside (plan.md D10, data-model §8)", () => {
  for (const v of VARIANTS) {
    // `before-write`: the shell gets the bound facts as `expected` and finds other bytes. `renamed`: the writer comes after the rename.
    // A staged new file gets no write, so its writer comes before the index part. The Unstage files `prepare` compares the status record of the path (004 contract Δ4 step 7), so the index part refuses.
    const seams = v.writes ? ["before-write", "renamed"] : ["before-index"];
    caseTest(TASK, `${v.id}: another writer at ${seams.join(" and at ")} gives changed-outside for its file, and every other file reverts`, SHELL, async () => {
      let hook: ((c: RevertCheckpoint) => void) | null = null;
      await withService({ name: `t044-writer-${v.id}`, revertCheckpoint: (c: RevertCheckpoint) => hook?.(c) }, async (service) => {
        for (const seam of seams) {
          const { repo, r, token } = await reviewed(service, v);
          const first = v.targets[0]!;
          let wrote = false;
          const writer = () => {
            if (wrote) return;
            wrote = true;
            write(repo, first.path, "outside\n");
          };
          if (seam === "renamed") service.runner.inject.replaceStep = (step, path) => void (step === "renamed" && path.endsWith(nativeTail(first.path)) && writer());
          else hook = (c) => void (c.step === seam && Buffer.from(c.path, "base64").toString("utf8") === first.path && writer());
          let done: ServiceResponse<RevertRun>;
          try {
            done = await run(service, r, token);
          } finally {
            service.runner.inject.replaceStep = null;
            hook = null;
          }
          const label = { variant: v.id, seam };
          expect({ ...label, wrote, state: done.state, code: done.code, index: done.result?.index, outcomes: done.result?.files.map((f) => f.outcome) }).toEqual({
            ...label,
            wrote: true,
            state: "failed-with-effects",
            code: "FAILED_WITH_EFFECTS",
            index: seam === "before-index" ? "refused" : v.index,
            outcomes: v.targets.map((_, i) => (i === 0 ? "changed-outside" : "reverted")),
          });
          expect({ ...label, bytes: v.targets.map((t) => bytesOf(repo, t.path)), temps: leftovers(repo) }).toEqual({ ...label, bytes: v.targets.map((t, i) => (i === 0 ? "outside\n" : t.new)), temps: { merge: 0, replace: 0 } });
        }
      });
    }, TIMEOUT_MS);
  }
});

describe("revert interruptions: the double stops or ends at each write step (SC-005, spec FR-036)", () => {
  const STEPS: ReplaceStep[] = ["checked", "written", "cleared", "renamed"];
  for (const v of VARIANTS.filter((x) => x.writes)) {
    const tail = nativeTail(v.targets[0]!.path);
    const whole = v.action !== "revert-lines";

    // Contract Δ3: a stop after `checked` is no stop, because a started write runs to its end. Data-model §8: a `stopped` reply without a Cancel is the shell deadline.
    caseTest(TASK, `${v.id}: a stop at checked keeps every old byte, and a stop at a later step gives the new bytes; no temporary file stays`, SHELL, () =>
      withService({ name: `t044-stop-${v.id}` }, async (service) => {
        for (const step of STEPS) {
          const { repo, r, token } = await reviewed(service, v);
          service.runner.inject.replaceStep = (s, path) => (s === step && path.endsWith(tail) ? "stop" : undefined);
          let done: ServiceResponse<RevertRun>;
          try {
            done = await run(service, r, token);
          } finally {
            service.runner.inject.replaceStep = null;
          }
          const stopped = step === "checked";
          const expected = !stopped
            ? { state: "succeeded", code: undefined, outcomes: v.targets.map(() => "reverted") }
            : v.index === "published"
              ? { state: "failed-with-effects", code: "FAILED_WITH_EFFECTS", outcomes: v.targets.map(() => "unstaged-only") }
              : { state: "failed", code: "DEADLINE", outcomes: v.targets.map((_, i) => (i === 0 ? "not-changed" : "not-started")) };
          const label = { variant: v.id, step };
          expect({ ...label, state: done.state, code: done.code, outcomes: done.result?.files.map((f) => f.outcome) }).toEqual({ ...label, ...expected });
          expect({ ...label, bytes: v.targets.map((t) => bytesOf(repo, t.path)), temps: leftovers(repo) }).toEqual({ ...label, bytes: v.targets.map((t) => (stopped ? t.old : t.new)), temps: { merge: 0, replace: 0 } });
        }
      }),
      TIMEOUT_MS,
    );

    for (const step of STEPS) {
      // Contract "Known limits": a shell end keeps Git's temporary files, and a shell end after `cleared` keeps the shell temporary file.
      // The shell end also ends the run, so no `tempRemove` follows, and every Git temporary file of the batch stays.
      caseTest(TASK, `${v.id}: a shell end at ${step} leaves each target with its old or its new bytes, keeps the recovery marker, and leaves only the known temporary files`, SHELL, () =>
        withService({ name: `t044-crash-${v.id}-${step}` }, async (service) => {
          const { repo, r, token } = await reviewed(service, v);
          const kept = Object.keys(workingFileDigests(repo)).filter((p) => !v.targets.some((t) => t.path === p));
          service.runner.inject.replaceStep = (s, path) => (s === step && path.endsWith(tail) ? "crash" : undefined);
          let done: ServiceResponse<RevertRun>;
          try {
            done = await run(service, r, token);
          } finally {
            service.runner.inject.replaceStep = null;
          }
          const label = { variant: v.id, step };
          expect({ ...label, ...outcome(done), markers: [...service.runner.markers.values()].filter((m) => m.kind === "workbench").map((m) => m.action) }).toEqual({ ...label, state: "unknown", code: "STATE_UNKNOWN", markers: [v.action] });
          // Only the target of the shell end can hold its new bytes, and only after the rename. No other file is missing.
          const bytes = v.targets.map((t, i) => (i === 0 && step === "renamed" ? t.new : t.old));
          const present = Object.keys(workingFileDigests(repo));
          expect({ ...label, bytes: v.targets.map((t) => bytesOf(repo, t.path)), missing: kept.filter((p) => !present.includes(p)), temps: leftovers(repo) }).toEqual({
            ...label,
            bytes,
            missing: [],
            temps: { merge: whole ? v.targets.length : 0, replace: step === "cleared" ? 1 : 0 },
          });
        }),
        TIMEOUT_MS,
      );
    }
  }
});

// T045: a HEAD change gave STALE_REVIEW without a result (`workbench-review.ts` `staleOf`).
describe("revert races: a HEAD change between the review and the run gives STALE_REVIEW with revert-changed (SC-003, contract Δ3 runWorkbench)", () => {
  caseTest(TASK, "every action names revert-changed after a HEAD change, and nothing changes", SHELL, () =>
    withService({ name: "t044-head" }, async (service) => {
      const observed: unknown[] = [];
      const expected: unknown[] = [];
      for (const v of VARIANTS) {
        const { repo, r, token } = await reviewed(service, v);
        moveHead(repo);
        const before = state(repo);
        const done = await run(service, r, token);
        observed.push({ variant: v.id, ...refusal(done), unchanged: Bun.deepEquals(state(repo), before) });
        expected.push({ variant: v.id, state: "failed", code: "STALE_REVIEW", result: { action: v.action, reason: "revert-changed" }, unchanged: true });
      }
      expect(observed).toEqual(expected);
    }),
    TIMEOUT_MS,
  );
});

// T045: the proof of data-model §4 failed with line-endings here, because a staged comparison binds no working version.
describe("revert races: a working change after the status read gives a staged-lines review STALE_SELECTION (plan.md D4)", () => {
  // The shown read says that the file has no unstaged change. The fresh status record of the path says that it has one.
  caseTest(TASK, "a line appended outside the hunk after the status read gives STALE_SELECTION, and nothing changes", SHELL, () =>
    withService({ name: "t044-staged-read" }, async (service) => {
      const repo = fixture(variant("staged-lines"));
      const r = await service.register(repo);
      const read = await readOk(service, r.repositoryId);
      const c = await compare(service, r.repositoryId, "f.txt", "staged", read);
      write(repo, "f.txt", `${F_OLD}E\n`);
      const before = state(repo);
      expect(refusal(await review(service, r, read, { action: "revert-lines", comparisonId: c.comparisonId, hunkId: c.hunkIds[0] }))).toEqual({ state: "failed", code: "STALE_SELECTION", result: undefined });
      expect(state(repo)).toEqual(before);
    }),
    TIMEOUT_MS,
  );
});
