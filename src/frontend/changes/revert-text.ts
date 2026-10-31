// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { BridgeResponse } from "../bridge";
import { TEXTS } from "../integrate/texts";
import { pathText } from "./file-actions";
import { formatCount } from "./file-tree";
import { LIMITATION_TEXT } from "./limitation-text";

// Feature 008 plan.md D11 (texts approved with the T022 mockup on 2026-10-31), spec FR-009, FR-011, FR-017, FR-038 to FR-041.

const lineCount = (n: number) => (n === 1 ? "1 line" : `${formatCount(n)} lines`);

export const NO_UNDO = "You cannot undo this.";
export const NO_HUNK = "No hunk is selected.";
export const MORE_ACTIONS = "More actions";
export const REVERT_EXPIRED = "The review expired. Arbareto changed nothing. Select Revert again.";
export const REVERT_CHECKING = (n: number) => `Checking ${n === 1 ? "1 file" : `${formatCount(n)} files`}…`;
export const REVERT_PROGRESS = (i: number, n: number) => `Reverting ${formatCount(i)} of ${formatCount(n)}…`;
/** `action` is the item label without the ellipsis. */
export const REVERT_UNAVAILABLE = (action: string) => `${action} is unavailable.`;

/** The item labels. `lines` null names the whole hunk. */
export const REVERT_HUNK_LABEL = "Revert hunk…";
export const revertLinesLabel = (n: number) => `Revert ${lineCount(n)}…`;
export const actionName = (label: string) => label.replace(/…$/, "");

export type RevertLinesPlan = { scope: "unstaged" | "staged"; fileBytes: string; lines: number | null };

const BODY = {
  unstaged: "Arbareto removes the selected changes from the working file. The index does not change.",
  staged: "Arbareto removes the selected changes from the index and from the working file.",
};
/** Spec FR-009: the title, the text, and the revert button of a lines or hunk plan. */
export function revertConfirmTexts(plan: RevertLinesPlan): { title: string; body: string; button: string } {
  const file = pathText(plan.fileBytes);
  const staged = plan.scope === "staged" ? "staged " : "";
  if (plan.lines === null) return { title: `Revert this ${staged}hunk in ${file}?`, body: BODY[plan.scope], button: "Revert hunk" };
  const n = plan.lines;
  return { title: `Revert ${n === 1 ? `1 ${staged}line` : `${formatCount(n)} ${staged}lines`} in ${file}?`, body: BODY[plan.scope], button: n === 1 ? "Revert line" : "Revert lines" };
}

/** Spec FR-038 line reasons, with the revert texts. */
export const LINE_REVERT_TEXT: Record<"context-only" | "several-hunks" | "deleted-file" | "new-file" | "eof-newline", string> = {
  "context-only": "The selection holds only context lines. Select added or removed lines.",
  "several-hunks": "The selection covers two hunks. Select lines of one hunk.",
  "deleted-file": "Arbareto does not revert lines or hunks of a deleted file. Use Revert file.",
  "new-file": "Arbareto does not revert lines or hunks of a staged new file. Use Revert file.",
  "eof-newline": 'This hunk holds the Git marker "No newline at end of file". Revert the whole hunk.',
};

/** Spec FR-038. A text with `file` names the display path. `lines` selects the stale text of a line selection. */
export function revertReason(reason: string, file: string, lines = false): string | undefined {
  const texts: Record<string, string> = {
    untracked: "Arbareto does not revert an untracked file. Use Delete.",
    attributes: `Git reads other attributes for ${file} from the working files than from the index. Commit or revert the .gitattributes change first.`,
    "not-regular": `${file} or a folder on its path is a link or a junction. Arbareto does not follow it.`,
    "hard-link": `${file} has more than one hard link. Arbareto does not change it.`,
    "read-only": `${file} is read-only. Arbareto does not change it.`,
    owner: `Another user owns ${file}. Arbareto does not change it.`,
    "in-the-way": `A file that Git does not track exists at ${file}. Delete it first, or keep the deletion.`,
    unreadable: "Arbareto cannot read one of these files, so Revert is unavailable.",
    encrypted: `${file} is encrypted. Arbareto does not change it.`,
    "file-attributes": `Arbareto cannot keep the file attributes of ${file}. It did not change the file.`,
    security: `Arbareto cannot keep the permissions of ${file}. It did not change the file.`,
    xattr: `${file} has extended attributes. Arbareto does not change it.`,
    stale: `${file} changed after the review. Arbareto changed nothing. Check the changes, then ${lines ? "select the lines again" : "try again"}.`,
    ident: "Arbareto does not revert part of a file with the ident attribute. Use Revert file.",
    "unstaged-changes": "This file also has unstaged changes. Revert or stage them first.",
  };
  return texts[reason] ?? LINE_REVERT_TEXT[reason as keyof typeof LINE_REVERT_TEXT] ?? LIMITATION_TEXT[reason as keyof typeof LIMITATION_TEXT];
}

type Refusal = { reason?: unknown; remedy?: { text?: unknown }; unmerged?: unknown; files?: { path: string; reason: string }[] };
const coded = (response: BridgeResponse, reason: unknown) => `${response.code ?? response.state}${typeof reason === "string" ? ` ${reason}` : ""}`;

/** The reason line of a refused review (plan D11 `REVERT_UNAVAILABLE`, contract Δ3 refusal value). */
export function reviewRefusal(response: BridgeResponse, file: string, lines: boolean): string {
  const r = (response.result ?? {}) as Refusal;
  const first = r.files?.[0];
  const reason = first?.reason ?? r.reason;
  if (typeof r.remedy?.text === "string") return r.remedy.text;
  if (response.code === "STALE_REVIEW" || response.code === "STALE_SELECTION") return revertReason("stale", file, lines)!;
  if (response.code === "OPERATION_IN_PROGRESS") return TEXTS.operationInProgress;
  if (response.code === "CONFLICTED" && typeof r.unmerged === "number") return TEXTS.conflicted(r.unmerged);
  const text = typeof reason === "string" ? revertReason(reason, first === undefined ? file : pathText(first.path), lines) : undefined;
  return text ?? coded(response, reason);
}

type FileOutcome = { entryId: string; outcome: string; code?: string; reason?: string };
type RevertRun = { action: string; files: FileOutcome[]; index: string };
const isRun = (result: unknown): result is RevertRun => typeof result === "object" && result !== null && Array.isArray((result as { files?: unknown }).files);

// Spec FR-039 labels (board Result-mixed).
const OUTCOME_LABEL: Record<string, string> = { "unstaged-only": "Unstaged only.", "not-changed": "Not changed.", "changed-outside": "Changed outside Arbareto.", "not-started": "Not started." };

/** Spec FR-039 and FR-041: the line of a file that did not revert. */
export function outcomeLine(file: string, o: FileOutcome, lines: boolean): string {
  if (o.code === "error" && o.reason === "sharing-violation") return `Another program has ${file} open. Arbareto did not change it. Close the file, then try again.`;
  if (o.code === "error") return `${file}: Not changed: ${o.reason ?? "error"}`;
  const reason = o.code === "stale" ? revertReason("stale", file, lines) : o.code === "refused" && o.reason !== undefined ? revertReason(o.reason, file) : undefined;
  return `${file}: ${OUTCOME_LABEL[o.outcome] ?? o.outcome}${reason === undefined ? "" : ` ${reason}`}`;
}

/** The status line of a lines or hunk run (spec FR-011, FR-017, FR-040). Undefined keeps the 001 coded line. */
export function revertLinesOutcome(response: BridgeResponse, plan: RevertLinesPlan): string | undefined {
  const file = pathText(plan.fileBytes);
  const reason = (response.result as { reason?: unknown } | undefined)?.reason;
  if (response.code === "APPROVAL_EXPIRED") return REVERT_EXPIRED;
  if (response.code === "STALE_REVIEW" && reason === "revert-changed") return revertReason("stale", file, plan.lines !== null);
  const result = response.result;
  if (!isRun(result) || result.files.length !== 1) return undefined;
  const o = result.files[0]!;
  if (o.outcome === "reverted" && response.state === "succeeded") return plan.lines === null ? `Arbareto reverted a hunk in ${file}.` : `Arbareto reverted ${lineCount(plan.lines)} in ${file}.`;
  if (o.outcome === "reverted") return undefined;
  return outcomeLine(file, o, plan.lines !== null);
}
