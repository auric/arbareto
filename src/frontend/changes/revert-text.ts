// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { ChangeEntry, RevertFileOutcome, RevertFilesPlan } from "../../contracts/envelope";
import { MULTI_FILE_ACTION_FILES } from "../../contracts/limits";
import { compareKeys, treeKey } from "../../contracts/tree-order";
import type { BridgeResponse } from "../bridge";
import { TEXTS } from "../integrate/texts";
import { pathText } from "./file-actions";
import { formatCount } from "./file-tree";
import { LIMITATION_TEXT } from "./limitation-text";

// Feature 008 plan.md D11 (texts approved with the T022 mockup on 2026-10-31), spec FR-009, FR-011, FR-017, FR-038 to FR-041.

const lineCount = (n: number) => (n === 1 ? "1 line" : `${formatCount(n)} lines`);
const fileCount = (n: number) => (n === 1 ? "1 file" : `${formatCount(n)} files`);

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
export const revertFilesLabel = (n: number) => (n === 1 ? "Revert file…" : `Revert ${formatCount(n)} files…`);
export const FOLDER_REASON = "Arbareto does not revert a folder. Select its files.";
/** Feature 005 FR-026 form. */
export const MORE_FILES = (m: number) => (m === 1 ? "and 1 more file." : `and ${formatCount(m)} more files.`);

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

/** Spec FR-009 and FR-010: the texts of a files plan. `newFiles` is the added line, or null. */
export function revertFilesTexts(plan: RevertFilesPlan): { title: string; body: string; button: string; newFiles: string | null; more: number } {
  const one = plan.count === 1;
  const k = plan.newFiles;
  return {
    title: `Revert ${fileCount(plan.count)}?`,
    body: one
      ? "Arbareto sets the file to its version in the last commit, in the index and in the working file. Its staged and unstaged changes are lost."
      : "Arbareto sets each file to its version in the last commit, in the index and in the working file. Their staged and unstaged changes are lost.",
    button: one ? "Revert file" : "Revert files",
    newFiles:
      k === 0 ? null
      : k === 1 ? "The last commit does not have 1 of these files. Arbareto unstages it and keeps the file. Git then shows it as untracked."
      : `The last commit does not have ${formatCount(k)} of these files. Arbareto unstages them and keeps the files. Git then shows them as untracked.`,
    more: plan.count - plan.paths.length,
  };
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

// The FR-038 texts that name their file. BLOCKED_BY adds no path prefix to them (plan D11).
const NAMES_FILE: ReadonlySet<string> = new Set(["attributes", "not-regular", "hard-link", "read-only", "owner", "in-the-way", "encrypted", "file-attributes", "security", "xattr", "stale"]);
/** Plan D11 `BLOCKED_BY`: "<path>: <reason>" for one file of several. */
export function blockedBy(path: string, reason: string): string {
  const text = revertReason(reason, path) ?? reason;
  return NAMES_FILE.has(reason) ? text : `${path}: ${text}`;
}
/** The FR-038 reason of an entry from the status read alone: porcelain v2 `?` (untracked) and `<sub>` that starts with `S` (submodule). */
export const entryRevertReason = (e: ChangeEntry): string | null => (e.category === "untracked" ? "untracked" : e.submodule?.startsWith("S") === true ? "submodule" : null);
/** Feature 005 FR-015 tree order. A submodule and a nested repository (a path that ends with `/`) sort as folders. */
// Spec FR-022 (orchestrator text of 2026-10-31, for plan.md D11).
export const REVERT_LIMIT = "Arbareto reverts at most 10,000 files at a time. Select fewer files.";
/** Spec FR-022 and FR-023: the reason of a Revert file set from the status read, or null. With several files, it names the first blocking file in tree order. */
export function revertSetReason(set: readonly ChangeEntry[]): string | null {
  if (set.length > MULTI_FILE_ACTION_FILES) return REVERT_LIMIT;
  const first = inTreeOrder(set.filter((e) => entryRevertReason(e) !== null))[0];
  if (first === undefined) return null;
  return set.length > 1 ? blockedBy(first.path, entryRevertReason(first)!) : revertReason(entryRevertReason(first)!, first.path)!;
}
export function inTreeOrder<T extends { pathBytes: string; submodule?: string | null }>(entries: readonly T[]): T[] {
  return entries
    .map((entry) => {
      const raw = Uint8Array.from(atob(entry.pathBytes), (c) => c.charCodeAt(0));
      const nested = raw.at(-1) === 0x2f;
      return { entry, key: treeKey(nested ? raw.subarray(0, -1) : raw, nested || entry.submodule?.startsWith("S") === true) };
    })
    .sort((a, b) => compareKeys(a.key, b.key))
    .map((k) => k.entry);
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

type FileOutcome = RevertFileOutcome;
type RevertRun = { action: string; files: FileOutcome[]; index: string };
const isRun = (result: unknown): result is RevertRun => typeof result === "object" && result !== null && Array.isArray((result as { files?: unknown }).files);

// Spec FR-039 labels (board Result-mixed).
const OUTCOME_LABEL: Record<string, string> = { "unstaged-only": "Unstaged only.", "not-changed": "Not changed.", "changed-outside": "Changed outside Arbareto.", "not-started": "Not started." };

/** Spec FR-039 and FR-041: the line of a file that did not revert. */
export function outcomeLine(file: string, o: FileOutcome, lines: boolean): string {
  // Spec FR-017: the index part stays. Plan D11 `REVERT_PARTIAL` gives "another program has it open" for a sharing violation.
  if (o.outcome === "unstaged-only" && o.code !== undefined) {
    const why =
      o.code === "error" ? (o.reason === "sharing-violation" ? "another program has it open" : `the write failed: ${o.reason ?? "error"}`)
      : o.code === "stale" ? revertReason("stale", file, lines)!
      : ((o.reason === undefined ? undefined : revertReason(o.reason, file)) ?? o.code);
    return `Arbareto removed the changes from the index. It did not change ${file}, because ${why.replace(/\.$/, "")}.`;
  }
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

/** Spec FR-022 and plan D11 `REVERT_UNAVAILABLE`: the status-area lines of a refused files review. */
export function revertFilesRefusal(response: BridgeResponse): string[] {
  const r = (response.result ?? {}) as Refusal & { more?: unknown };
  if (r.files === undefined) return [reviewRefusal(response, "", false)];
  const lines = r.files.map((f) => blockedBy(pathText(f.path), f.reason));
  return typeof r.more === "number" && r.more > 0 ? [...lines, MORE_FILES(r.more)] : lines;
}

// Plan D11 `REVERT_COUNTS`, in the FR-039 order.
const COUNT_PART: [RevertFileOutcome["outcome"], string][] = [
  ["reverted", "reverted"],
  ["unstaged-only", "unstaged only"],
  ["not-changed", "not changed"],
  ["changed-outside", "changed outside Arbareto"],
  ["not-started", "not started"],
];
/** Spec FR-040: the status line and the status-area lines of a files run. Undefined keeps the 001 coded line. */
export function revertFilesOutcome(response: BridgeResponse, entries: ReadonlyMap<string, ChangeEntry>, entryIds: readonly string[]): { text: string; lines: string[] } | undefined {
  const reason = (response.result as { reason?: unknown } | undefined)?.reason;
  if (response.code === "APPROVAL_EXPIRED") return { text: REVERT_EXPIRED, lines: [] };
  // The STALE_REVIEW value names no file, so only a one-file run can name it.
  const only = entryIds.length === 1 ? entries.get(entryIds[0]!) : undefined;
  if (response.code === "STALE_REVIEW" && reason === "revert-changed") return only === undefined ? undefined : { text: revertReason("stale", only.path)!, lines: [] };
  const result = response.result;
  if (!isRun(result)) return undefined;
  const all = result.files;
  if (response.state === "succeeded" && all.every((o) => o.outcome === "reverted")) return { text: `Arbareto reverted ${fileCount(all.length)}.`, lines: [] };
  const text = COUNT_PART.flatMap(([outcome, word]) => {
    const n = all.filter((o) => o.outcome === outcome).length;
    return n === 0 ? [] : [`${fileCount(n)} ${word}.`];
  }).join(" ");
  const missed = all.filter((o) => o.outcome !== "reverted").map((o) => ({ o, entry: entries.get(o.entryId) }));
  const known = inTreeOrder(missed.flatMap((m) => (m.entry === undefined ? [] : [{ ...m, pathBytes: m.entry.pathBytes, submodule: m.entry.submodule }])));
  const ordered = [...known, ...missed.filter((m) => m.entry === undefined)];
  const lines = ordered.slice(0, 20).map(({ o, entry }) => outcomeLine(entry?.path ?? o.entryId, o, false));
  return { text, lines: ordered.length > 20 ? [...lines, MORE_FILES(ordered.length - 20)] : lines };
}
