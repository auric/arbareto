// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { ChangeEntry } from "../../contracts/envelope";
import type { BridgeResponse, createBridge } from "../bridge";
import { trackOperation, type StatusOperation } from "../status/OperationStatus";
import type { FilesRequest } from "./file-tree";
import { LIMITATION_TEXT } from "./limitation-text";

// Feature 004 contract Δ3 `applyFiles`, `reviewWorkbench` and `runWorkbench` with action `ignore`, `revealPath`; plan.md D8, D9, D15; spec FR-034 to FR-040, FR-045, FR-046.

type Bridge = ReturnType<typeof createBridge>;
export type IgnoreTarget = "gitignore" | "exclude";
export type IgnoreReview = { ok: true; token: string; line: string; target: IgnoreTarget } | { ok: false; text: string };

// Plan.md D15 "Commit view texts".
export const TARGET_TEXT: Record<IgnoreTarget, string> = { gitignore: ".gitignore in the worktree folder", exclude: "info/exclude in the Git folder" };
export const IGNORE_LABEL: Record<IgnoreTarget, string> = { gitignore: "Add to .gitignore", exclude: "Add to info/exclude" };
const IGNORE_FILE: Record<IgnoreTarget, string> = { gitignore: ".gitignore", exclude: "info/exclude" };
export const LIMIT_TEXT = "One action covers at most 10,000 files and 512 MiB of working files.";
export const CUT_REASON = "Git lists more untracked files than Arbareto reads.";
const IGNORE_REASONS: Record<string, (file: string) => string> = {
  "ignore-exists": (f) => `${f} already holds this line.`,
  "ignore-not-text": (f) => `${f} is not UTF-8 text, or it holds a NUL character.`,
  "ignore-size": (f) => `${f} is larger than 1 MiB.`,
  "ignore-not-regular": (f) => `${f} is a symbolic link, a folder, or another special file.`,
  path: () => "The path holds a control character or bytes that are not UTF-8.",
  limit: () => "The ignore line is longer than 4,096 bytes.",
  unreadable: (f) => `Arbareto cannot read ${f} in a WSL distro.`,
};
// Feature 003 data-model §9 `missing` and the contract Δ9 `blob-proof` reason of a file action.
const FILE_REASONS: Record<string, string> = { ...LIMITATION_TEXT, missing: "The working file of this conflicted path is missing.", "blob-proof": "Git did not store the exact bytes of this file." };

const reasonOf = (response: BridgeResponse) => {
  const r = response.result as { reason?: unknown } | undefined;
  return typeof r?.reason === "string" ? r.reason : undefined;
};
const codeOf = (response: BridgeResponse) => response.code ?? response.state;

/** Spec FR-038: a refused set names the file and its reason. Another refusal gives the contract §9 code and the reason value. */
export function filesRefusal(response: BridgeResponse, entries: readonly ChangeEntry[], label: string): string {
  const result = (response.result ?? {}) as { entryId?: unknown; reason?: unknown };
  const reason = reasonOf(response);
  if (response.code === "WORKBENCH_UNAVAILABLE" && reason === "limit") return `${label} did not start: ${LIMIT_TEXT}`;
  const entry = typeof result.entryId === "string" ? entries.find((e) => e.entryId === result.entryId) : undefined;
  const text = reason !== undefined ? FILE_REASONS[reason] : undefined;
  if (entry !== undefined) return `${label} did not start: ${entry.path}. ${text ?? `${codeOf(response)}${reason === undefined ? "" : ` ${reason}`}`}`;
  return `${label} did not start: ${codeOf(response)}${reason === undefined ? "" : ` ${reason}`}`;
}

/** Plan.md D9: the text of an ignore review refusal. */
export function ignoreRefusal(response: BridgeResponse, target: IgnoreTarget): string {
  const reason = reasonOf(response);
  const known = response.code === "WORKBENCH_UNAVAILABLE" && reason !== undefined ? IGNORE_REASONS[reason] : undefined;
  return `${IGNORE_LABEL[target]} is unavailable: ${known !== undefined ? known(IGNORE_FILE[target]) : `${codeOf(response)}${reason === undefined ? "" : ` ${reason}`}`}`;
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
    async reviewIgnore(entryId: string, target: IgnoreTarget, folder: string | undefined): Promise<IgnoreReview> {
      const { snapshotId } = deps;
      // The 001 Loading reason (HunkControls `BLOCKED_TEXT.loading`).
      if (deps.target === null || snapshotId === null) return { ok: false, text: `${IGNORE_LABEL[target]} is unavailable: A status page is still loading.` };
      const response = await deps.bridge.reviewWorkbench(deps.target, { action: "ignore", snapshotId, entryId, target, ...(folder === undefined ? {} : { folder }) });
      const result = response.result as { action?: unknown; workbenchToken?: unknown; plan?: { line?: unknown } } | undefined;
      if (response.state === "succeeded" && result?.action === "ignore" && typeof result.workbenchToken === "string" && typeof result.plan?.line === "string") {
        return { ok: true, token: result.workbenchToken, line: result.plan.line, target };
      }
      return { ok: false, text: ignoreRefusal(response, target) };
    },
    async runIgnore(review: Extract<IgnoreReview, { ok: true }>): Promise<BridgeResponse | null> {
      if (deps.target === null) return null;
      const label = IGNORE_LABEL[review.target];
      const report = (op: StatusOperation) => deps.onOperation({ ...op, texts: [label, label, `${label} details`] });
      const target = { repositoryId: deps.target.repositoryId };
      const response = await trackOperation("runWorkbench", undefined, (onProgress) => deps.bridge.runWorkbench(target, { workbenchToken: review.token, start: true }, onProgress), report);
      deps.ended("runWorkbench", response);
      const reason = reasonOf(response);
      deps.onStatus(response.state === "succeeded" ? null : `${label} did not complete: ${reason === "ignore-not-regular" ? IGNORE_REASONS[reason]!(IGNORE_FILE[review.target]) : `${codeOf(response)}${reason === undefined ? "" : ` ${reason}`}`}`);
      return response;
    },
    reveal(entryId: string) {
      if (deps.target === null) return;
      void deps.bridge.revealPath({ repositoryId: deps.target.repositoryId, entryId }).then((response) => {
        if (response.state !== "succeeded") deps.onStatus(`Show in Explorer did not complete: ${codeOf(response)}`);
      });
    },
  };
}
export type FileActions = ReturnType<typeof fileActions>;
