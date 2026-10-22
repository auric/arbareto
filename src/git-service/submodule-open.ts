// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 005 contract Δ3 `openSubmodule`, plan.md D11 steps 2 to 5, data-model §9 (spec FR-047 to FR-052).
// The checks run in the parent. The 001 discovery and registration of the bound folder follow in `session.ts`.

import type { ErrorCode, SubmoduleUnavailableReason } from "../contracts/errors";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM } from "../contracts/limits";
import { OID_HEX } from "./commands";
import { createCollector, RunnerRefusal, type FileFact, type GitRunner } from "./git-runner";
import { contextOf, runRead } from "./read-steps";
import type { RegistrationOutcome, Workspace } from "./registration";
import type { ReadInstallation } from "./snapshot";
import type { Trust } from "./trust";

export interface SubmoduleTarget {
  runner: GitRunner;
  trust: Trust;
  operationId: string;
  signal: AbortSignal;
  workspace: Workspace;
  installation: ReadInstallation;
}

// Contract Δ3 `openSubmodule`: only SUBMODULE_UNAVAILABLE carries a reason.
export type SubmoduleRefusal = { ok: false; code: ErrorCode; result?: { reason: SubmoduleUnavailableReason } };

const refusal = (reason: SubmoduleUnavailableReason): SubmoduleRefusal => ({ ok: false, code: "SUBMODULE_UNAVAILABLE", result: { reason } });
// The two records of a gitlink listing that names more than one entry fit this bound.
const STAGE_RECORDS = 2;

// git-ls-files(1) `--stage` `-z`: `<mode> SP <object> SP <stage> TAB <path> NUL`.
export function submoduleStageArgs(path: string): string[] {
  return ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs", "ls-files", "-z", "--stage", "--", path];
}

// Plan.md D11 steps 2 to 4. Null: the folder may be opened. The parent gate comes first, because `ls-files` loads the parent index (research R10).
export async function checkSubmodule(t: SubmoduleTarget, path: string): Promise<SubmoduleRefusal | null> {
  const w = t.workspace;
  const listed = await t.trust.listTrust({ operationId: t.operationId, signal: t.signal, workspace: w });
  if (!listed.ok) return { ok: false, code: "stop" in listed ? (listed.stop === "deadline" ? "DEADLINE" : "CANCELED") : listed.code };
  const gate = t.trust.gate(w, listed.listing, t.installation, "reads");
  if (gate !== null) return { ok: false, code: gate };

  // Step 3: exactly one stage-0 gitlink record at exactly `path`.
  const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, maxRecords: STAGE_RECORDS, separator: 0x00 });
  const step = await runRead(t.runner, t, submoduleStageArgs(path), out);
  if (t.signal.aborted) return { ok: false, code: "CANCELED" };
  if ("refused" in step) return { ok: false, code: step.refused };
  if (step.exit.deadline !== undefined) return { ok: false, code: "DEADLINE" };
  if (step.exit.exitCode !== 0) return { ok: false, code: "GIT_FAILED" };
  const record = new RegExp(`^160000 ${OID_HEX[w.objectFormat]} 0\t`);
  // The header is ASCII. The path after the TAB compares by its bytes.
  const bytes = Buffer.from(out.take());
  const tab = bytes.indexOf(0x09);
  const one = !out.limited && out.records === 1 && bytes.at(-1) === 0 && record.test(bytes.toString("latin1")) && bytes.subarray(tab + 1, -1).equals(Buffer.from(path));
  if (!one) return refusal("not-submodule");

  // Step 4: the folder and its `.git` entry, without following a link (contract §6 "File facts").
  const names = path.split("/");
  let facts: FileFact[] | { stop: string };
  try {
    facts = await t.runner.fileFacts({ operationId: t.operationId, ...contextOf(w), digest: false, files: [{ root: "worktreeRoot", path: names }, { root: "worktreeRoot", path: [...names, ".git"] }] }, t.signal);
  } catch (error) {
    if (error instanceof RunnerRefusal) return { ok: false, code: error.code };
    throw error;
  }
  if ("stop" in facts) return { ok: false, code: facts.stop === "deadline" ? "DEADLINE" : "CANCELED" };
  const [folder, git] = facts as [FileFact, FileFact];
  if (folder.kind === "link" || git.kind === "link") return refusal("path");
  if (folder.kind === "error" || git.kind === "error") return { ok: false, code: "REPOSITORY_UNAVAILABLE" };
  // 001 contract §12 "Actions": an uninitialized submodule has no `.git` entry.
  if (folder.kind !== "directory" || (git.kind !== "file" && git.kind !== "directory")) return refusal("submodule-not-initialized");
  return null;
}

// Plan.md D11 step 5: the discovered worktree root must be the submodule folder. The registration gives REPOSITORY_UNAVAILABLE
// when Git found no repository there (discovery call 1 exited nonzero, F16) or when the top level differs from the bound folder.
export function submoduleOutcome(outcome: RegistrationOutcome): RegistrationOutcome | SubmoduleRefusal {
  return !outcome.ok && outcome.code === "REPOSITORY_UNAVAILABLE" ? refusal("submodule-not-initialized") : outcome;
}
