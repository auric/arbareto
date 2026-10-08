// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T097: races at the research.md R3 protocol points 5, 11, and 13, through the in-process checkpoint observer of `src/git-service/hunk-publish.ts` (T110).

import { describe, expect, spyOn } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { useFixtureRoot } from "./fixture-root";
import { buildChanged, put } from "./fixtures";
import { indexEntries, rawIndexDigest } from "./git-oracle";
import { applyHunk, blobOf, candidateFiles, copyRepo, git, gitDirOf, gitPath, gitPathOf, outcome, repoOf, scriptedPatch, selectHunks, SUCCEEDED, TIMEOUT_MS, underTest, withService } from "./hunk-harness";
import { caseTest, type Capability, type HunkCheckpoint, type Service, type ServiceResponse } from "./service-harness";

const TASK = "T097";
const SHELL: Capability[] = ["shell-double"];
// Contract §8: a fixed prefix names candidate files. This one belongs to no operation of the service.
const FOREIGN = "arbareto-candidate-foreign";

useFixtureRoot();

interface Race {
  repo: string;
  // A copy where scripted `git add -p` staged the same hunk before the race.
  oracle: string;
  response: ServiceResponse<{ effects?: Record<string, boolean> }>;
  // The candidate files that the observer saw at step 11.
  candidatesAt11: string[];
}

// Stages the first unstaged hunk of F09 `multi.txt`. `at` runs inside the observer at its step.
// A refusal at step 11 never reaches the step 11 observer, so `reaches11` is false then.
async function race(name: string, at: Partial<Record<HunkCheckpoint["step"], (service: Service, operationId: string, repo: string) => Promise<void> | void>>, reaches11 = true): Promise<Race> {
  const repo = repoOf(buildChanged(gitPath(), name, "F09"));
  const oracle = scriptedPatch(repo, `${name}-oracle`, "add", "multi.txt", ["y", "n"]);
  writeFileSync(join(gitDirOf(repo), FOREIGN), "foreign\n");
  let candidatesAt11: string[] = [];
  let current: Service | null = null;
  const hunkCheckpoint = async ({ step, operationId }: HunkCheckpoint) => {
    if (step === 11) candidatesAt11 = candidateFiles(repo);
    await at[step]?.(current!, operationId, repo);
  };
  let response: Race["response"] | null = null;
  await withService({ name, hunkCheckpoint }, async (service) => {
    current = service;
    await underTest("hunk-publish");
    const { repositoryId } = await service.register(repo);
    const c = await selectHunks(service, repositoryId, "multi.txt", "unstaged");
    const calls = service.runner.calls.length;
    response = (await applyHunk(service, repositoryId, c, c.hunkIds[0]!, "stage")) as Race["response"];
    // Owned candidates disappear only after their processes stop: every process of the operation has exited at the outcome.
    expect(service.runner.calls.slice(calls).filter((call) => call.exit === undefined && call.refused === undefined)).toEqual([]);
    expect(candidateFiles(repo)).toEqual([FOREIGN]);
  });
  // The observer saw the owned candidate beside the foreign one.
  if (reaches11) {
    expect(candidatesAt11.length).toBe(2);
    expect(candidatesAt11).toContain(FOREIGN);
  }
  return { repo, oracle, response: response!, candidatesAt11 };
}

const EXTERNAL = (repo: string) => `${readFileSync(join(repo, "multi.txt"), "utf8")}external line\n`;

// A valid index with other bytes: the index of a copy with `staged.txt` unstaged. The copy drops the lock that the operation holds.
function otherIndex(repo: string, name: string): Uint8Array {
  const copy = copyRepo(repo, name);
  rmSync(gitPathOf(copy, "index.lock"), { force: true });
  git(copy, ["reset", "-q", "--", "staged.txt"]);
  return readFileSync(gitPathOf(copy, "index"));
}

describe("protocol races (research.md R3 steps 5, 11, and 13)", () => {
  caseTest(TASK, `a working-file change before the final recheck refuses publication with STALE_SELECTION, and the external bytes stay`, SHELL, async () => {
    let written = "";
    let index: string | null = null;
    const { repo, response } = await race("t097-before-recheck", {
      5: (_s, _o, repo) => {
        index = rawIndexDigest(gitPath(), repo);
        written = EXTERNAL(repo);
        put(repo, "multi.txt", written);
      },
    }, false);
    expect(response.code).toBe("STALE_SELECTION");
    expect(rawIndexDigest(gitPath(), repo)).toBe(index);
    expect(readFileSync(join(repo, "multi.txt"), "utf8")).toBe(written);
  }, TIMEOUT_MS);

  caseTest(TASK, `a working-file change after the final recheck lets publication finish: completed-with-effects with the observed change, the external bytes intact, and no undo`, SHELL, async () => {
    let written = "";
    const { repo, oracle, response } = await race("t097-after-recheck", {
      11: (_s, _o, repo) => {
        written = EXTERNAL(repo);
        put(repo, "multi.txt", written);
      },
    });
    expect({ state: response.state, code: response.code, workingFiles: response.result?.effects?.workingFiles }).toEqual({ state: "completed-with-effects", code: "COMPLETED_WITH_EFFECTS", workingFiles: true });
    expect(readFileSync(join(repo, "multi.txt"), "utf8")).toBe(written);
    expect(blobOf(repo, "multi.txt")).toBe(blobOf(oracle, "multi.txt"));
  }, TIMEOUT_MS);

  caseTest(TASK, `cancellation before publication gives canceled with the canonical index unchanged`, SHELL, async () => {
    let index: string | null = null;
    const { repo, response } = await race("t097-cancel-before", {
      11: async (service, operationId, repo) => {
        index = rawIndexDigest(gitPath(), repo);
        expect((await service.cancel(operationId)).state).toBe("succeeded");
      },
    });
    expect(outcome(response)).toEqual({ state: "canceled", code: "CANCELED" });
    expect(rawIndexDigest(gitPath(), repo)).toBe(index);
  }, TIMEOUT_MS);

  caseTest(TASK, `cancellation after publication gives succeeded`, SHELL, async () => {
    const { repo, oracle, response } = await race("t097-cancel-after", {
      13: async (service, operationId) => {
        expect((await service.cancel(operationId)).state).toBe("succeeded");
      },
    });
    expect(outcome(response)).toEqual(SUCCEEDED);
    expect(indexEntries(gitPath(), repo)).toEqual(indexEntries(gitPath(), oracle));
  }, TIMEOUT_MS);

  // Contract §9: a `publish` that returned success while the later canonical digest is not the verified candidate digest gives completed-with-effects.
  for (const kind of ["old", "other"] as const) {
    caseTest(TASK, `an index write after publication with ${kind === "old" ? "the old index bytes" : "other valid index bytes"} gives completed-with-effects with effects.index true`, SHELL, async () => {
      const name = `t097-after-publication-${kind}`;
      let bytes: Uint8Array | null = null;
      const { repo, response } = await race(name, {
        5: (_s, _o, repo) => {
          bytes = kind === "old" ? readFileSync(gitPathOf(repo, "index")) : otherIndex(repo, `${name}-other`);
        },
        13: (_s, _o, repo) => writeFileSync(gitPathOf(repo, "index"), bytes!),
      });
      expect({ state: response.state, code: response.code, index: response.result?.effects?.index }).toEqual({ state: "completed-with-effects", code: "COMPLETED_WITH_EFFECTS", index: true });
      expect(Buffer.compare(readFileSync(gitPathOf(repo, "index")), bytes!)).toBe(0);
    }, TIMEOUT_MS);
  }

  // A throw from `publish()` after the rename leaves publication open. An index that matches neither retained digest gives unknown (contract §9 "publish without a typed result").
  caseTest(TASK, `a throw from publish after the rename, with other index bytes later, ends unknown, not failed`, SHELL, async () => {
    const name = "t097-publish-throws";
    const probe = await open(fileURLToPath(import.meta.url), "r");
    const handles = Object.getPrototypeOf(probe) as { close(): Promise<void> };
    await probe.close();
    const close = handles.close;
    let armed: { lock: string; index: string; bytes: Uint8Array } | null = null;
    // Test seam: the `close` of the owned lock handle runs after the rename (`index-lock.ts` `publish`).
    const spy = spyOn(handles, "close").mockImplementation(async function (this: unknown) {
      await close.call(this);
      const a = armed;
      if (a === null || existsSync(a.lock)) return;
      armed = null;
      writeFileSync(a.index, a.bytes);
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    });
    let raced: Race;
    let bytes: Uint8Array = new Uint8Array();
    try {
      raced = await race(name, {
        11: (_s, _o, repo) => {
          bytes = otherIndex(repo, `${name}-other`);
          armed = { lock: gitPathOf(repo, "index.lock"), index: gitPathOf(repo, "index"), bytes };
        },
      });
    } finally {
      spy.mockRestore();
    }
    expect({ thrown: armed === null, ...outcome(raced.response) }).toEqual({ thrown: true, state: "unknown", code: "STATE_UNKNOWN" });
    expect(Buffer.compare(readFileSync(gitPathOf(raced.repo, "index")), bytes)).toBe(0);
  }, TIMEOUT_MS);
});
