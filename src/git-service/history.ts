// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The 001 history steps that feature 002 reuses: the HEAD capture, the commit text, contract §7 "Shared listing", and "Missing objects".

import { isUtf8 } from "node:buffer";
import type { HistoryRow } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, HISTORY_COMMIT_OBJECT_BYTES, SHALLOW_METADATA_BYTES } from "../contracts/limits";
import { batchCommandArgs, headOidArgs, headRefExistsArgs, headTargetArgs, isObjectId, isRefName, objectCheckArgs, type ObjectFormat } from "./commands";
import type { ReadInstallation } from "./snapshot";
import { createCollector, exitKind, type GitExit, type GitRunner, type WalkStop } from "./git-runner";
import { boundedBody, HEADER_BYTES, isSpace, messageBody, parseCommitObjects, type CommitObject, type CommitObjects } from "./history-parser";
import { latin1, objectCheckInput, objectCheckOutcome, readBounded, runRead, type ReadStep } from "./read-steps";
import type { Workspace } from "./registration";
import type { Head } from "./snapshot";
import type { ListingOutcome, Trust } from "./trust";

// Contract §7 "Missing objects": a failed history read with a missing object and without a promisor remote.
export const DAMAGED_STORE_REMEDY =
  "Git could not read objects that this history needs. This repository has no promisor remote, so its object store can be damaged. Run git fsck in a terminal to check it.";

export interface ReadHistoryTarget {
  operationId: string;
  signal: AbortSignal;
  installation: ReadInstallation;
  workspace: Workspace;
  // The envelope `repositoryGeneration`. The page binds it, and a shared listing must belong to it (contract §7 "Shared listing").
  generation: number;
}

export interface HistoryReaderOptions {
  runner: GitRunner;
  trust: Trust;
  // The contract §8 change tuple of the last listing of the workspace (`WorkspaceReader.listingTuple`). Its `fileFacts` requests belong to `operationId`.
  // Null: no compare can prove that nothing changed. A walk stop ends the listing with its stop.
  listingTuple(w: Workspace, operationId: string, signal: AbortSignal): Promise<string | WalkStop | null>;
  // Data-model §2 `unavailable` (`WorkspaceReader.markUnavailable`).
  markUnavailable(repositoryId: string): void;
}

type ProcessTarget = Pick<ReadHistoryTarget, "operationId" | "signal" | "workspace">;
type Bytes = ReturnType<typeof createCollector>;
type Ran = { exit: GitExit; stdout: Bytes; stderrBytes: number };
type Step = Ran | { refused: ErrorCode } | { aborted: true };

// A held step chain that ends without a page. Only a passed gate lets it reach a response.
export type Stop = { stop: "canceled" | "deadline" } | { failed: ErrorCode };

// Contract §6 "Process replies": a step that a Job close ended. Its exit has no cause, and its cut output decides nothing. Compare it by identity.
export const CLOSED: Stop = { failed: "GIT_FAILED" };

export type Shallow = { kind: "absent" } | { kind: "file"; commits: ReadonlySet<string>; fingerprint: string } | { kind: "over" };

const LF = 0x0a;
// git-show-ref(1) `--exists`: the status for a missing reference.
const REF_MISSING_STATUS = 2;
// Spec FR-008: invalid UTF-8 shows replacement characters. A byte order mark stays text.
const lossy = new TextDecoder("utf-8", { ignoreBOM: true });
const exact = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export const isStop = (value: unknown): value is Stop => typeof value === "object" && value !== null && ("stop" in value || "failed" in value);
const isDigit = (byte: number) => byte >= 0x30 && byte <= 0x39;
// The `encoding` label shows no C0 control, DEL, or C1 control.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

// The first step that ends the chain. Null: each step ran to its exit.
function stepStop(signal: AbortSignal, steps: readonly Step[]): Stop | null {
  if (signal.aborted || steps.some((s) => "aborted" in s)) return { stop: "canceled" };
  for (const s of steps) if ("refused" in s) return { failed: s.refused };
  const exits = steps.map((s) => (s as Ran).exit);
  if (exits.some((e) => e.deadline !== undefined)) return { stop: "deadline" };
  // Contract §9: unexpected diagnostic output above 4 MiB ends a read `failed` with OUTPUT_LIMIT.
  if (exits.some((e) => e.diagnosticLimit)) return { failed: "OUTPUT_LIMIT" };
  if ((steps as readonly Ran[]).some((s) => exitKind(s.exit, "read", s.stdout) === "jobClosed")) return CLOSED;
  return null;
}

// One LF-ended line of exact UTF-8. Null for every other output.
function oneLine(out: Bytes): string | null {
  if (out.limited) return null;
  const bytes = out.take();
  if (bytes.length < 2 || bytes[bytes.length - 1] !== LF || bytes.indexOf(LF) !== bytes.length - 1) return null;
  try {
    return exact.decode(bytes.subarray(0, -1));
  } catch {
    return null;
  }
}

// Git `shallow.c` `is_repository_shallow` reads one object ID per line, and Git writes each line in lowercase hex with LF. Null for another form.
function shallowCommits(bytes: Uint8Array, objectFormat: ObjectFormat): Set<string> | null {
  const lines = latin1(bytes).split("\n");
  if (lines.pop() !== "") return null;
  const commits = new Set<string>();
  for (const line of lines) {
    if (!isObjectId(line, objectFormat)) return null;
    commits.add(line);
  }
  return commits;
}

// Contract §5 "Shallow-boundary metadata".
export async function readShallow(path: string, objectFormat: ObjectFormat): Promise<Shallow | Stop> {
  const read = await readBounded(path, SHALLOW_METADATA_BYTES);
  if (read === "unavailable") return { failed: "REPOSITORY_UNAVAILABLE" };
  if (read === "absent" || read === "over") return { kind: read };
  const commits = shallowCommits(read, objectFormat);
  if (commits === null) return { failed: "MALFORMED_GIT_OUTPUT" };
  return { kind: "file", commits, fingerprint: new Bun.CryptoHasher("sha256").update(read).digest("hex") };
}

const join = (parts: readonly Uint8Array[]) => Buffer.concat(parts.flatMap((part, i) => (i === 0 ? [part] : [Buffer.from(" "), part])));

// Git `pretty.c` `parse_commit_header`: the header ends at the first empty line, and the last `author` and `committer` lines count. A NUL byte ends the buffer.
function commitText(content: Uint8Array): { author: Uint8Array | null; committer: Uint8Array | null; message: Uint8Array } {
  const nul = content.indexOf(0);
  const buffer = nul === -1 ? content : content.subarray(0, nul);
  const authorPrefix = Buffer.from("author ");
  const committerPrefix = Buffer.from("committer ");
  let author: Uint8Array | null = null;
  let committer: Uint8Array | null = null;
  let at = 0;
  while (at < buffer.length) {
    const lf = buffer.indexOf(LF, at);
    const end = lf === -1 ? buffer.length : lf;
    if (end === at) break;
    const line = Buffer.from(buffer.buffer, buffer.byteOffset + at, end - at);
    if (line.subarray(0, authorPrefix.length).equals(authorPrefix)) author = line.subarray(authorPrefix.length);
    else if (line.subarray(0, committerPrefix.length).equals(committerPrefix)) committer = line.subarray(committerPrefix.length);
    at = end + 1;
  }
  return { author, committer, message: buffer.subarray(Math.min(at, buffer.length)) };
}

// Git `pretty.c` `skip_blank_lines` and `format_subject`: the first paragraph, each line without trailing white space, joined by one space.
function subjectOf(message: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let at = 0; at < message.length; ) {
    const lf = message.indexOf(LF, at);
    const next = lf === -1 ? message.length : lf + 1;
    let end = next;
    while (end > at && isSpace(message[end - 1]!)) end--;
    if (end > at) parts.push(message.subarray(at, end));
    else if (parts.length > 0) break;
    at = next;
  }
  return join(parts);
}

// Git `ident.c` `split_ident_line`: the name ends before the first `<` without trailing white space, and the mail runs to the next `>`.
// The date follows the last `>`, and a time zone must follow it. Null: Git finds no name, mail, or date, or the date is not a safe integer.
function identOf(line: Uint8Array): { name: Uint8Array; email: Uint8Array; date: number } | null {
  const lt = line.indexOf(0x3c);
  if (lt === -1) return null;
  const gt = line.indexOf(0x3e, lt + 1);
  if (gt === -1) return null;
  let nameEnd = lt;
  while (nameEnd > 0 && isSpace(line[nameEnd - 1]!)) nameEnd--;
  let at = line.lastIndexOf(0x3e) + 1;
  while (at < line.length && isSpace(line[at]!)) at++;
  const dateStart = at;
  while (at < line.length && isDigit(line[at]!)) at++;
  const dateEnd = at;
  while (at < line.length && isSpace(line[at]!)) at++;
  const sign = line[at];
  const zone = at + 1;
  if (dateEnd === dateStart || (sign !== 0x2b && sign !== 0x2d) || zone >= line.length || !isDigit(line[zone]!)) return null;
  const date = Number(latin1(line.subarray(dateStart, dateEnd)));
  if (!Number.isSafeInteger(date)) return null;
  return { name: line.subarray(0, nameEnd), email: line.subarray(lt + 1, gt), date };
}

export type CommitText = Omit<HistoryRow, "oid" | "parents" | "shallow">;

// Contract §3 "HistoryPage result" text fields of one commit object. `invalidUtf8` checks the raw bytes, before the lossy decode.
// Feature 002 `readHistoryRows` uses the same fields. Null: Git finds no author or committer ident.
export function commitTextOf(object: Pick<CommitObject, "content" | "encoding">): CommitText | null {
  const { author, committer, message } = commitText(object.content);
  const ident = author === null ? null : identOf(author);
  const committed = committer === null ? null : identOf(committer);
  if (ident === null || committed === null) return null;
  const subject = subjectOf(message);
  const body = messageBody(message);
  return {
    subject: lossy.decode(subject),
    author: { name: lossy.decode(ident.name), email: lossy.decode(ident.email) },
    date: ident.date,
    encoding: object.encoding === null ? null : object.encoding.replace(CONTROLS, ""),
    invalidUtf8: [subject, ident.name, ident.email, committed.name, committed.email, body].some((bytes) => !isUtf8(bytes)),
    committer: { name: lossy.decode(committed.name), email: lossy.decode(committed.email) },
    committerDate: committed.date,
    ...boundedBody(lossy.decode(body)),
  };
}

async function runStep(runner: GitRunner, t: ProcessTarget, args: string[], stdout: Bytes, input?: Uint8Array): Promise<Step> {
  if (t.signal.aborted) return { aborted: true };
  let step: ReadStep;
  try {
    step = await runRead(runner, t, args, stdout, input);
  } catch (error) {
    if (t.signal.aborted) return { aborted: true };
    throw error;
  }
  if (t.signal.aborted) return { aborted: true };
  return "refused" in step ? step : { ...step, stdout };
}

export const small = () => createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });

// One read-policy Git step. A refusal, an abort, a deadline, a diagnostic limit, or a Job close gives its `Stop`.
export async function readStep(runner: GitRunner, t: ProcessTarget, args: string[], stdout: Bytes): Promise<GitExit | Stop> {
  const step = await runStep(runner, t, args, stdout);
  return stepStop(t.signal, [step]) ?? (step as Ran).exit;
}

// Contract §7 "Held history steps": `symbolic-ref` and `rev-parse --verify`. git-symbolic-ref(1) `-q`: only exit 1 without output is a detached HEAD.
// A failed `rev-parse` with a symbolic target is an unborn branch only when `show-ref --exists` gives the missing status.
export async function captureHead(runner: GitRunner, t: ProcessTarget): Promise<Head | Stop> {
  const objectFormat = t.workspace.objectFormat;
  const steps = await Promise.all([runStep(runner, t, headTargetArgs(), small()), runStep(runner, t, headOidArgs(), small())]);
  const stop = stepStop(t.signal, steps);
  if (stop !== null) return stop;
  const [symbolic, resolved] = steps as [Ran, Ran];
  let target: string | null = null;
  if (symbolic.exit.exitCode === 0) {
    target = oneLine(symbolic.stdout);
    if (target === null || !isRefName(target)) return { failed: "MALFORMED_GIT_OUTPUT" };
  } else if (symbolic.exit.exitCode !== 1 || symbolic.stdout.bytes > 0 || symbolic.stderrBytes > 0) {
    return { failed: "GIT_FAILED" };
  }
  if (resolved.exit.exitCode === 0) {
    const oid = oneLine(resolved.stdout);
    if (oid === null || !isObjectId(oid, objectFormat)) return { failed: "MALFORMED_GIT_OUTPUT" };
    return target === null ? { state: "detached", oid } : { state: "branch", target, oid };
  }
  if (target === null) return { failed: "GIT_FAILED" };
  const exists = await runStep(runner, t, headRefExistsArgs(target), small());
  const existsStop = stepStop(t.signal, [exists]);
  if (existsStop !== null) return existsStop;
  const found = exists as Ran;
  return found.exit.exitCode === REF_MISSING_STATUS && found.stdout.bytes === 0 ? { state: "unborn", target } : { failed: "GIT_FAILED" };
}

// Contract §7 "Shared listing": the listing of a `readWorkspace` of the request generation, after the tuple recheck. Otherwise an own listing.
// `openHistory` and `readRefs` use it.
export async function sharedListing(
  { trust, listingTuple }: Pick<HistoryReaderOptions, "trust" | "listingTuple">,
  t: Pick<ReadHistoryTarget, "operationId" | "signal" | "workspace" | "generation">,
): Promise<ListingOutcome> {
  const w = t.workspace;
  // Contract §11 "Trust and environment": a WSL repository never shares a trust listing.
  const tuple = w.wsl === undefined ? await listingTuple(w, t.operationId, t.signal) : null;
  if (tuple !== null && typeof tuple === "object") return { ok: false, stop: tuple.stop };
  const shared = tuple === null ? null : await trust.shared.reuse(w.repositoryId, t.generation, tuple, t.signal);
  if (shared !== null) {
    // The tuple is read again after the shared listing ends, so an edit during that listing also forces an own listing.
    const again = await listingTuple(w, t.operationId, t.signal);
    if (again !== null && typeof again === "object") return { ok: false, stop: again.stop };
    if (again === tuple) return { ok: true, listing: shared };
  }
  if (t.signal.aborted) return { ok: false, stop: "canceled" };
  return trust.listTrust({ operationId: t.operationId, signal: t.signal, workspace: w });
}

// `cat-file --batch-command -Z` with one `contents <oid>` command per object ID.
async function readObjects(runner: GitRunner, t: ProcessTarget, oids: readonly string[], maxBytes: number): Promise<{ objects: CommitObjects; exitFailed: boolean } | Stop> {
  const out = createCollector({ maxBytes });
  const step = await runStep(runner, t, batchCommandArgs(), out, new TextEncoder().encode(oids.map((oid) => `contents ${oid}\0`).join("")));
  const stop = stepStop(t.signal, [step]);
  if (stop !== null) return stop;
  const objects = parseCommitObjects(out.take(), oids, t.workspace.objectFormat);
  // Contract §5: the first reached bound wins, also over a later Git failure. A cut output always reaches a bound first.
  return { objects, exitFailed: !out.limited && (step as Ran).exit.exitCode !== 0 && objects.completeness.state !== "limited" };
}

// Contract §7 "Missing objects": `cat-file --batch-check` on the history commit IDs. The service never parses the Git message.
async function objectCheck(runner: GitRunner, t: ProcessTarget, oids: readonly string[]): Promise<"missing" | "present" | "failed" | "canceled" | "deadline"> {
  const out = createCollector({ maxBytes: oids.length * (HEADER_BYTES + 1) });
  const step = await runStep(runner, t, objectCheckArgs(), out, objectCheckInput(oids));
  if ("aborted" in step) return "canceled";
  return objectCheckOutcome(step, out, oids);
}

// The input of `checkFailedRead`. `anchors`: the commits where the walk starts, the start points of a feature 002 view.
// `named`: the rows and the parents that `rev-list` named. `objects`: the commit objects that `cat-file` read.
export interface FailedRead {
  anchors: readonly string[];
  shallow: Shallow;
  named: Iterable<string>;
  objects: readonly CommitObject[];
  failedStep: "rev-list" | "cat-file";
}

// A failed `rev-list` or `cat-file`. The check input holds the anchors, the rows, and the parents that `rev-list` named.
// It also holds the raw parents of each read commit that the shallow file does not list. After a failed `rev-list`, the read commits are the anchors.
// A shallow file above its bound hides which commits it lists, so no raw parent joins. Raw parents are check input only.
export async function checkFailedRead(runner: GitRunner, t: ProcessTarget, read: FailedRead): Promise<"missing" | Stop> {
  const { shallow } = read;
  const rawParents = (object: CommitObject) => (shallow.kind === "over" || (shallow.kind === "file" && shallow.commits.has(object.oid)) ? [] : object.parents);
  const oids = new Set<string>(read.anchors);
  for (const oid of read.named) oids.add(oid);
  for (const object of read.objects) for (const oid of rawParents(object)) oids.add(oid);
  if (read.failedStep === "rev-list" && read.anchors.length > 0) {
    const anchor = await readObjects(runner, t, read.anchors, read.anchors.length * (HISTORY_COMMIT_OBJECT_BYTES + HEADER_BYTES + 2));
    if (isStop(anchor)) return anchor;
    const answer = anchor.objects.completeness;
    if (answer.state === "limited" && answer.code === "OBJECT_MISSING") return "missing";
    for (const object of anchor.objects.objects) for (const oid of rawParents(object)) oids.add(oid);
  }
  const checked = await objectCheck(runner, t, [...oids]);
  if (checked === "canceled" || checked === "deadline") return { stop: checked };
  return checked === "missing" ? "missing" : { failed: "GIT_FAILED" };
}
