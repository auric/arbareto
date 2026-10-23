// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { ChangeEntry, WorkspaceSnapshot } from "../../contracts/envelope";
import { MULTI_FILE_ACTION_FILES } from "../../contracts/limits";
import type { BridgeResponse, createBridge } from "../bridge";
import { TEXTS } from "../integrate/texts";
import { trackOperation, type StatusOperation } from "../status/OperationStatus";
import { folderEntries, formatCount, type FilesRequest } from "./file-tree";
import { LIMITATION_TEXT } from "./limitation-text";

// Feature 004 contract Δ3 `applyFiles` and `revealPath`; feature 005 contract Δ3 `reviewWorkbench` and `runWorkbench` with action `delete`, plan.md D5, D6, D15; spec FR-018 to FR-033.

type Bridge = ReturnType<typeof createBridge>;
export type IgnoreTarget = "gitignore" | "exclude";

// Feature 005 plan.md D15 "Commit view row menu" and "Ignore editor".
export const IGNORE_LABEL: Record<IgnoreTarget, string> = { gitignore: "Add to .gitignore…", exclude: "Add to info/exclude…" };
export const IGNORE_FILE: Record<IgnoreTarget, string> = { gitignore: ".gitignore", exclude: "info/exclude" };
// Feature 004 plan.md D9: the `ignoreLine` refusals.
export const IGNORE_LINE_REASON = { path: "The path holds a control character or bytes that are not UTF-8.", limit: "The ignore line is longer than 4,096 bytes." } as const;
export const LIMIT_TEXT = "One action covers at most 10,000 files and 512 MiB of working files.";
export const CUT_REASON = "Git lists more untracked files than Arbareto reads.";
// Feature 003 data-model §9 `missing` and the contract Δ9 `blob-proof` reason of a file action.
const FILE_REASONS: Record<string, string> = { ...LIMITATION_TEXT, missing: "The working file of this conflicted path is missing.", "blob-proof": "Git did not store the exact bytes of this file." };

// Feature 005 plan.md D15 "Delete unavailable reasons".
export const DELETE_REASON: Record<string, string> = {
  conflicted: "Arbareto does not delete a file with a conflict.",
  submodule: "Arbareto does not delete a submodule.",
  "nested-repository": "This folder holds another Git repository.",
  limit: "Delete covers at most 10,000 files.",
  "long-path": "Arbareto does not move a path of 260 or more characters to the Recycle Bin. Use Delete permanently…",
  "nothing-to-delete": "This file is already deleted from the working tree.",
  path: "Windows does not allow this file name.",
};
export const NO_HISTORY = "Git has no history for this file.";
export const DELETE_TEXTS: [string, string, string] = ["Delete files", "Deleting files", "Delete files details"];

const reasonOf = (response: BridgeResponse) => {
  const r = response.result as { reason?: unknown } | undefined;
  return typeof r?.reason === "string" ? r.reason : undefined;
};
const codeOf = (response: BridgeResponse) => response.code ?? response.state;
const coded = (response: BridgeResponse) => {
  const reason = reasonOf(response);
  return `${codeOf(response)}${reason === undefined ? "" : ` ${reason}`}`;
};

/** Spec FR-038: a refused set names the file and its reason. Another refusal gives the contract §9 code and the reason value. */
export function filesRefusal(response: BridgeResponse, entries: readonly ChangeEntry[], label: string): string {
  const result = (response.result ?? {}) as { entryId?: unknown; reason?: unknown };
  const reason = reasonOf(response);
  if (response.code === "WORKBENCH_UNAVAILABLE" && reason === "limit") return `${label} did not start: ${LIMIT_TEXT}`;
  const entry = typeof result.entryId === "string" ? entries.find((e) => e.entryId === result.entryId) : undefined;
  const text = reason !== undefined ? FILE_REASONS[reason] : undefined;
  if (entry !== undefined) return `${label} did not start: ${entry.path}. ${text ?? coded(response)}`;
  return `${label} did not start: ${coded(response)}`;
}

/** Spec FR-021 and plan D6: the reason of a Delete set from the status read, in the review order, or null. Porcelain v2 `<sub>` starts with `S` for a submodule, and an untracked record ends with `/` only for a nested repository. */
export function deleteReason(entries: readonly ChangeEntry[]): string | null {
  if (entries.some((e) => e.category === "conflicted")) return DELETE_REASON.conflicted!;
  if (entries.some((e) => e.submodule?.startsWith("S") === true)) return DELETE_REASON.submodule!;
  if (entries.some((e) => e.category === "untracked" && atob(e.pathBytes).endsWith("/"))) return DELETE_REASON["nested-repository"]!;
  if (entries.length > MULTI_FILE_ACTION_FILES) return DELETE_REASON.limit!;
  if (entries.length > 0 && entries.every((e) => e.xy?.[1] === "D")) return DELETE_REASON["nothing-to-delete"]!;
  return null;
}
/** The 004 common refusals of a mutation (feature 004 plan D15): the conflicted count first, then an unfinished operation. */
export function deleteBlock(operationState: WorkspaceSnapshot["operationState"], conflicted: number): string | null {
  if (conflicted > 0) return TEXTS.conflicted(conflicted);
  return operationState === "normal" ? null : TEXTS.operationInProgress;
}
/** The Changes entries of a Delete: the folder covers every Changes entry below it (plan D6 "Folder"). */
export const deleteEntries = (entries: readonly ChangeEntry[], folder: string) => folderEntries(entries, folder, "stage");

export type DeletePlan = { mode: "recycle" | "permanent"; entryIds: string[]; files: { count: number; paths: string[] }; tracked: number; folder: string | null; wsl: boolean };
export type DeleteReview = { ok: true; token: string; plan: DeletePlan } | { ok: false; text: string };

const utf8 = new TextDecoder("utf-8");
/** The display text of base64 path bytes. */
export const pathText = (base64: string) => utf8.decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
const many = (n: number, one: string, more: string) => `${formatCount(n)} ${n === 1 ? one : more}`;

// Feature 005 plan.md D15 "Delete run texts".
const OUTCOME_PART: [string, string][] = [
  ["recycled", "moved to the Recycle Bin"],
  ["deleted", "deleted"],
  ["kept", "kept"],
  ["changed", "changed"],
  ["absent", "not on disk"],
  ["not-regular", "not regular"],
  ["error", "failed"],
  ["stopped", "stopped"],
];
const OUTCOME_LINE: Record<string, string> = {
  recycled: "Moved to the Recycle Bin",
  deleted: "Deleted",
  kept: "Kept",
  changed: "Changed, not deleted",
  absent: "Not on disk",
  "not-regular": "Not a regular file, not deleted",
  stopped: "Stopped, not deleted",
};
type FileOutcome = { entryId: string; outcome: string; code?: string };
const isOutcomes = (result: unknown): result is { action: "delete"; entries: FileOutcome[] } =>
  typeof result === "object" && result !== null && (result as { action?: unknown }).action === "delete" && Array.isArray((result as { entries?: unknown }).entries);

/** The status line and the detail lines of a Delete run (plan D15 "Delete run texts"). */
export function deleteOutcome(response: BridgeResponse, paths: ReadonlyMap<string, string>): { text: string; lines: string[] } {
  const reason = reasonOf(response);
  if (response.code === "STALE_REVIEW" && reason === "files-changed") return { text: "The files changed after the review. Arbareto deleted nothing. Select Refresh (F5), then delete again.", lines: [] };
  if (response.code === "APPROVAL_EXPIRED") return { text: "The review expired. Select Delete again.", lines: [] };
  const result = response.result;
  if (!isOutcomes(result)) return { text: `${DELETE_TEXTS[0]} did not complete: ${coded(response)}`, lines: [] };
  const count = (outcome: string) => result.entries.filter((e) => e.outcome === outcome).length;
  const all = result.entries.length;
  const lines = result.entries.map((e) => `${paths.get(e.entryId) ?? e.entryId}: ${e.outcome === "error" ? `Not deleted: ${e.code ?? "error"}` : (OUTCOME_LINE[e.outcome] ?? e.outcome)}`);
  const parts = OUTCOME_PART.flatMap(([outcome, word]) => (count(outcome) === 0 ? [] : [`${formatCount(count(outcome))} ${word}`])).join(", ");
  if (response.state === "canceled") return { text: `Delete stopped: ${parts}.`, lines };
  if (all > 0 && count("recycled") === all) return { text: `Moved ${many(all, "file", "files")} to the Recycle Bin.`, lines };
  if (all > 0 && count("deleted") === all) return { text: `Deleted ${many(all, "file", "files")} permanently.`, lines };
  return { text: `Delete finished: ${parts}.`, lines };
}

export type FilesDeps = {
  bridge: Pick<Bridge, "applyFiles" | "reviewWorkbench" | "runWorkbench" | "revealPath">;
  /** The repository and the generation of the shown read, or null. */
  target: { repositoryId: string; repositoryGeneration: number } | null;
  snapshotId: string | null;
  entries: readonly ChangeEntry[];
  onOperation(op: StatusOperation): void;
  /** The 004 store `ended` (contract Δ8). */
  ended(operation: "applyFiles" | "runWorkbench", response: BridgeResponse): void;
  /** The second live element of the status bar. */
  onStatus(text: string | null): void;
};

const LABELS: Record<"stage" | "unstage", [string, string, string]> = {
  stage: ["Stage files", "Staging files", "Stage files details"],
  unstage: ["Unstage files", "Unstaging files", "Unstage files details"],
};

/** The bridge calls of the file lists. Each call binds the shown read. */
export function fileActions(deps: FilesDeps) {
  return {
    async run(request: FilesRequest): Promise<BridgeResponse | null> {
      const { target, snapshotId } = deps;
      if (target === null || snapshotId === null) return null;
      const payload = { snapshotId, entryIds: request.entryIds, direction: request.direction, kind: request.kind, ...(request.folder === undefined ? {} : { folder: request.folder }) };
      const report = (op: StatusOperation) => deps.onOperation({ ...op, texts: LABELS[request.direction] });
      const response = await trackOperation("applyFiles", request.direction, (onProgress) => deps.bridge.applyFiles({ repositoryId: target.repositoryId }, payload, onProgress), report);
      deps.ended("applyFiles", response);
      deps.onStatus(response.state === "succeeded" ? null : filesRefusal(response, deps.entries, LABELS[request.direction][0]));
      return response;
    },
    /** Feature 005 contract Δ3 `reviewWorkbench` `delete`. A refusal gives the plan D15 text. */
    async reviewDelete(entryIds: string[], folder: string | undefined, mode: DeletePlan["mode"]): Promise<DeleteReview> {
      const { target, snapshotId } = deps;
      // The 001 Loading reason (HunkControls `BLOCKED_TEXT.loading`).
      if (target === null || snapshotId === null) return { ok: false, text: "A status page is still loading." };
      const response = await deps.bridge.reviewWorkbench(target, { action: "delete", snapshotId, entryIds, ...(folder === undefined ? {} : { folder }), mode });
      const result = response.result as { action?: unknown; workbenchToken?: unknown; plan?: DeletePlan; unmerged?: unknown } | undefined;
      if (response.state === "succeeded" && result?.action === "delete" && typeof result.workbenchToken === "string" && result.plan !== undefined) return { ok: true, token: result.workbenchToken, plan: result.plan };
      const reason = reasonOf(response);
      if (response.code === "WORKBENCH_UNAVAILABLE" && reason !== undefined && DELETE_REASON[reason] !== undefined) return { ok: false, text: DELETE_REASON[reason]! };
      if (response.code === "OPERATION_IN_PROGRESS") return { ok: false, text: TEXTS.operationInProgress };
      if (response.code === "CONFLICTED" && typeof result?.unmerged === "number") return { ok: false, text: TEXTS.conflicted(result.unmerged) };
      return { ok: false, text: `${DELETE_TEXTS[0]} did not start: ${coded(response)}` };
    },
    /** Feature 005 contract Δ3 `runWorkbench` `delete`. The outcome names each file (plan D15 "Delete run texts"). */
    async runDelete(review: Extract<DeleteReview, { ok: true }>): Promise<BridgeResponse | null> {
      if (deps.target === null) return null;
      const paths = new Map(deps.entries.map((e) => [e.entryId, e.path]));
      const target = { repositoryId: deps.target.repositoryId };
      const report = (op: StatusOperation) => {
        const outcome = op.response === null ? undefined : deleteOutcome(op.response, paths);
        deps.onOperation({ ...op, texts: DELETE_TEXTS, ...(outcome === undefined ? {} : { outcome: outcome.text, lines: outcome.lines }) });
      };
      const response = await trackOperation("runWorkbench", undefined, (onProgress) => deps.bridge.runWorkbench(target, { workbenchToken: review.token, start: true }, onProgress), report);
      deps.ended("runWorkbench", response);
      return response;
    },
    /** Feature 005 plan D5: `folder` reveals the folder of a folder row. `path` names the row in the absent text. */
    reveal(entryId: string, path: string, folder?: string) {
      if (deps.target === null) return;
      void deps.bridge.revealPath({ repositoryId: deps.target.repositoryId, entryId, ...(folder === undefined ? {} : { folder }) }).then((response) => {
        if (response.state === "succeeded") return;
        deps.onStatus(response.code === "UNKNOWN_TARGET" && reasonOf(response) === "absent" ? `${path} does not exist. Select Refresh (F5).` : `Show in Explorer did not complete: ${codeOf(response)}`);
      });
    },
  };
}
export type FileActions = ReturnType<typeof fileActions>;
