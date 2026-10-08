// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract §3 `readHistory` and "HistoryPage result", the §5 history bounds, and contract §7 "Shared listing", "Held history steps", and "Missing objects".

import type { HistoryPage, HistoryRefusal, HistoryRow } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import {
  DIAGNOSTIC_RETAINED_BYTES_PER_STREAM,
  HISTORY_COMMIT_OBJECT_BYTES,
  HISTORY_PAGE_BYTES,
  HISTORY_STREAM_BYTES,
  HISTORY_STREAM_ROWS,
  SHALLOW_METADATA_BYTES,
} from "../contracts/limits";
import { NATIVE } from "../contracts/native-path";
import { batchCommandArgs, headOidArgs, headRefExistsArgs, headTargetArgs, isObjectId, isRefName, objectCheckArgs, revListArgs, shallowPathArgs, type ObjectFormat } from "./commands";
import type { ReadInstallation } from "./snapshot";
import { createCollector, isChannelPath, type GitExit, type GitRunner, type WalkStop } from "./git-runner";
import { HEADER_BYTES, parseCommitObjects, parseTraversal, type CommitObject, type CommitObjects, type Traversal } from "./history-parser";
import { contextOf, encodedBytes, latin1, objectCheckInput, objectCheckOutcome, readBounded, runRead, type ReadStep } from "./read-steps";
import type { Workspace } from "./registration";
import type { Completeness, Head, LimitName } from "./snapshot";
import { hasPromisor, OBJECT_MISSING_REMEDY } from "./status";
import type { ListingOutcome, Trust, TrustListing } from "./trust";

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

export type HistoryOutcome =
  | { result: "succeeded"; value: HistoryPage }
  | { result: "limited"; code: "OUTPUT_LIMIT" | "OBJECT_MISSING" | "WORKTREE_CHANGING"; value: HistoryPage }
  | { result: "failed"; code: ErrorCode; value: HistoryRefusal }
  | { result: "canceled" }
  | { result: "deadline" };

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
type Stop = { stop: "canceled" | "deadline" } | { failed: ErrorCode };

type Shallow = { kind: "absent" } | { kind: "file"; commits: ReadonlySet<string>; fingerprint: string } | { kind: "over" };

// The output of the held steps. `traversal` is null for an unborn HEAD. `failedStep` names a nonzero exit of `rev-list` or `cat-file` below every bound.
// `shallowChanged`: the shallow file changed between the first read and the recheck after the traversal.
interface Held {
  head: Head;
  shallow: Shallow;
  traversal: Traversal | null;
  objects: CommitObjects;
  failedStep: "rev-list" | "cat-file" | null;
  shallowChanged: boolean;
}

const LF = 0x0a;
// git-show-ref(1) `--exists`: the status for a missing reference.
const REF_MISSING_STATUS = 2;
// Contract §5: 100 objects at the object bound, each with its longest `-Z` header and two NUL bytes. So the cap never cuts a valid page.
const CAT_FILE_BYTES = HISTORY_STREAM_ROWS * (HISTORY_COMMIT_OBJECT_BYTES + HEADER_BYTES + 2);
const COMPLETE: Completeness = { state: "complete" };
const OBJECT_MISSING: Completeness = { state: "limited", code: "OBJECT_MISSING" };
const limited = (reason: LimitName): Completeness => ({ state: "limited", code: "OUTPUT_LIMIT", reason });
// Spec FR-008: invalid UTF-8 shows replacement characters. A byte order mark stays text.
const lossy = new TextDecoder("utf-8", { ignoreBOM: true });
const exact = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const isStop = (value: unknown): value is Stop => typeof value === "object" && value !== null && ("stop" in value || "failed" in value);
// Git `ctype.c` `sane_ctype`: `isspace` holds TAB, LF, CR, and SPACE only.
const isSpace = (byte: number) => byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20;
const isDigit = (byte: number) => byte >= 0x30 && byte <= 0x39;
// The `encoding` label shows no C0 control, DEL, or C1 control.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

const refusal = (code: ErrorCode, text?: string): HistoryOutcome => ({
  result: "failed",
  code,
  value: { completeness: { state: "failed", code }, ...(text === undefined ? {} : { remedy: { text } }) },
});

const endOf = (stop: Stop): HistoryOutcome => ("stop" in stop ? { result: stop.stop } : refusal(stop.failed));

const stoppedListing = (outcome: Exclude<ListingOutcome, { ok: true }>): HistoryOutcome =>
  "stop" in outcome ? { result: outcome.stop } : refusal(outcome.code, outcome.text);

// The first step that ends the chain. Null: each step ran to its exit.
function stepStop(signal: AbortSignal, steps: readonly Step[]): Stop | null {
  if (signal.aborted || steps.some((s) => "aborted" in s)) return { stop: "canceled" };
  for (const s of steps) if ("refused" in s) return { failed: s.refused };
  const exits = steps.map((s) => (s as Ran).exit);
  if (exits.some((e) => e.deadline !== undefined)) return { stop: "deadline" };
  // Contract §9: unexpected diagnostic output above 4 MiB ends a read `failed` with OUTPUT_LIMIT.
  if (exits.some((e) => e.diagnosticLimit)) return { failed: "OUTPUT_LIMIT" };
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
async function readShallow(path: string, objectFormat: ObjectFormat): Promise<Shallow | Stop> {
  const read = await readBounded(path, SHALLOW_METADATA_BYTES);
  if (read === "unavailable") return { failed: "REPOSITORY_UNAVAILABLE" };
  if (read === "absent" || read === "over") return { kind: read };
  const commits = shallowCommits(read, objectFormat);
  if (commits === null) return { failed: "MALFORMED_GIT_OUTPUT" };
  return { kind: "file", commits, fingerprint: new Bun.CryptoHasher("sha256").update(read).digest("hex") };
}

const sameShallow = (a: Shallow, b: Shallow) => a.kind === b.kind && (a.kind !== "file" || a.fingerprint === (b as typeof a).fingerprint);

const join = (parts: readonly Uint8Array[]) => Buffer.concat(parts.flatMap((part, i) => (i === 0 ? [part] : [Buffer.from(" "), part])));

// Git `pretty.c` `parse_commit_header`: the header ends at the first empty line, and the last `author` line counts. A NUL byte ends the buffer.
function commitText(content: Uint8Array): { author: Uint8Array | null; message: Uint8Array } {
  const nul = content.indexOf(0);
  const buffer = nul === -1 ? content : content.subarray(0, nul);
  const prefix = Buffer.from("author ");
  let author: Uint8Array | null = null;
  let at = 0;
  while (at < buffer.length) {
    const lf = buffer.indexOf(LF, at);
    const end = lf === -1 ? buffer.length : lf;
    if (end === at) break;
    const line = Buffer.from(buffer.buffer, buffer.byteOffset + at, end - at);
    if (line.subarray(0, prefix.length).equals(prefix)) author = line.subarray(prefix.length);
    at = end + 1;
  }
  return { author, message: buffer.subarray(Math.min(at, buffer.length)) };
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
function identOf(line: Uint8Array): { name: string; email: string; date: number } | null {
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
  return { name: lossy.decode(line.subarray(0, nameEnd)), email: lossy.decode(line.subarray(lt + 1, gt)), date };
}

// Contract §3 "HistoryPage result" row fields. The parents come from the traversal, never from the raw headers.
function rowOf(oid: string, parents: readonly string[], object: CommitObject): HistoryRow | null {
  const { author, message } = commitText(object.content);
  const ident = author === null ? null : identOf(author);
  if (ident === null) return null;
  return {
    oid,
    parents: [...parents],
    subject: lossy.decode(subjectOf(message)),
    author: { name: ident.name, email: ident.email },
    date: ident.date,
    encoding: object.encoding === null ? null : object.encoding.replace(CONTROLS, ""),
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

const small = () => createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });

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

export function createHistoryReader({ runner, trust, listingTuple, markUnavailable }: HistoryReaderOptions) {
  const run = (t: ProcessTarget, args: string[], stdout: Bytes, input?: Uint8Array) => runStep(runner, t, args, stdout, input);

  // Contract §3: Git resolves the shallow file. The path is relative to the worktree root, where Git ran.
  async function shallowPath(t: ProcessTarget): Promise<string | Stop> {
    const step = await run(t, shallowPathArgs(), small());
    const stop = stepStop(t.signal, [step]);
    if (stop !== null) return stop;
    const ran = step as Ran;
    if (ran.exit.exitCode !== 0) return { failed: "GIT_FAILED" };
    const text = oneLine(ran.stdout);
    const path = text === null ? null : NATIVE.path.resolve(t.workspace.worktreeRoot, text);
    if (path === null || !isChannelPath(path)) return { failed: "MALFORMED_GIT_OUTPUT" };
    return path;
  }

  // `cat-file --batch-command -Z` with one `contents <oid>` command per object ID.
  async function readObjects(t: ProcessTarget, oids: readonly string[], maxBytes: number): Promise<{ objects: CommitObjects; exitFailed: boolean } | Stop> {
    const out = createCollector({ maxBytes });
    const step = await run(t, batchCommandArgs(), out, new TextEncoder().encode(oids.map((oid) => `contents ${oid}\0`).join("")));
    const stop = stepStop(t.signal, [step]);
    if (stop !== null) return stop;
    const objects = parseCommitObjects(out.take(), oids, t.workspace.objectFormat);
    // Contract §5: the first reached bound wins, also over a later Git failure. A cut output always reaches a bound first.
    return { objects, exitFailed: !out.limited && (step as Ran).exit.exitCode !== 0 && objects.completeness.state !== "limited" };
  }

  // The held steps (contract §7 "Held history steps"). They run beside the trust listing and start no object check.
  async function heldSteps(t: ProcessTarget): Promise<Held | Stop> {
    const w = t.workspace;
    const [head, path] = await Promise.all([captureHead(runner, t), shallowPath(t)]);
    if (t.signal.aborted) return { stop: "canceled" };
    if (isStop(head)) return head;
    if (isStop(path)) return path;
    const shallow = await readShallow(path, w.objectFormat);
    if (isStop(shallow)) return shallow;
    if (head.state === "unborn") return { head, shallow, traversal: null, objects: { objects: [], completeness: COMPLETE }, failedStep: null, shallowChanged: false };

    // Contract §5 "History traversal stream": one byte above the bound shows a cut stream to the parser.
    const stream = createCollector({ maxBytes: HISTORY_STREAM_BYTES + 1 });
    const listed = await run(t, revListArgs(head.oid, w.objectFormat), stream);
    const stop = stepStop(t.signal, [listed]);
    if (stop !== null) return stop;
    const traversal = parseTraversal(stream.take(), w.objectFormat);
    // Contract §5: the first reached bound wins, also over a later Git failure.
    if (!stream.limited && (listed as Ran).exit.exitCode !== 0 && traversal.completeness.state !== "limited") {
      return { head, shallow, traversal: { rows: traversal.rows, completeness: COMPLETE }, objects: { objects: [], completeness: COMPLETE }, failedStep: "rev-list", shallowChanged: false };
    }
    if (traversal.completeness.state === "failed") return { failed: traversal.completeness.code };

    let objects: CommitObjects = { objects: [], completeness: COMPLETE };
    let failedStep: Held["failedStep"] = null;
    if (traversal.rows.length > 0) {
      const read = await readObjects(t, traversal.rows.map((row) => row.oid), CAT_FILE_BYTES);
      if (isStop(read)) return read;
      if (read.objects.completeness.state === "failed" && !read.exitFailed) return { failed: read.objects.completeness.code };
      objects = read.objects;
      if (read.exitFailed) failedStep = "cat-file";
    }

    // Contract §3: recheck the shallow fingerprint after the traversal. A changed file can give rows and boundaries from two states.
    const again = await readShallow(path, w.objectFormat);
    if (isStop(again)) return again;
    return { head, shallow, traversal, objects, failedStep, shallowChanged: !sameShallow(shallow, again) };
  }

  // Contract §7 "Shared listing": the listing of a `readWorkspace` of the request generation, after the tuple recheck. Otherwise an own listing.
  async function listingFor(t: ReadHistoryTarget): Promise<ListingOutcome> {
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

  // Contract §7 "Missing objects": `cat-file --batch-check` on the history commit IDs. The service never parses the Git message.
  async function objectCheck(t: ProcessTarget, oids: readonly string[]): Promise<"missing" | "present" | "failed" | "canceled" | "deadline"> {
    const out = createCollector({ maxBytes: oids.length * (HEADER_BYTES + 1) });
    const step = await run(t, objectCheckArgs(), out, objectCheckInput(oids));
    if ("aborted" in step) return "canceled";
    return objectCheckOutcome(step, out, oids);
  }

  // A failed `rev-list` or `cat-file`. The check input holds HEAD, the rows, and the parents that `rev-list` named.
  // It also holds the raw parents of each read commit that the shallow file does not list. After a failed `rev-list`, the read commit is the HEAD commit.
  // A shallow file above its bound hides which commits it lists, so no raw parent joins. Raw parents are check input only.
  async function checkFailedRead(t: ReadHistoryTarget, held: Held & { head: { oid: string } }): Promise<"missing" | Stop> {
    const { shallow } = held;
    const rawParents = (object: CommitObject) => (shallow.kind === "over" || (shallow.kind === "file" && shallow.commits.has(object.oid)) ? [] : object.parents);
    const oids = new Set<string>([held.head.oid]);
    for (const row of held.traversal?.rows ?? []) for (const oid of [row.oid, ...row.parents]) oids.add(oid);
    for (const object of held.objects.objects) for (const oid of rawParents(object)) oids.add(oid);
    if (held.failedStep === "rev-list") {
      const anchor = await readObjects(t, [held.head.oid], HISTORY_COMMIT_OBJECT_BYTES + HEADER_BYTES + 2);
      if (isStop(anchor)) return anchor;
      const answer = anchor.objects.completeness;
      if (answer.state === "limited" && answer.code === "OBJECT_MISSING") return "missing";
      for (const object of anchor.objects.objects) for (const oid of rawParents(object)) oids.add(oid);
    }
    const checked = await objectCheck(t, [...oids]);
    if (checked === "canceled" || checked === "deadline") return { stop: checked };
    return checked === "missing" ? "missing" : { failed: "GIT_FAILED" };
  }

  // The page after a passed gate.
  async function pageOf(t: ReadHistoryTarget, listing: TrustListing, held: Held): Promise<HistoryOutcome> {
    const { head, shallow } = held;
    const traversal = held.traversal ?? { rows: [], completeness: COMPLETE };
    let objects = held.objects;
    if (held.failedStep !== null && head.state !== "unborn") {
      const checked = await checkFailedRead(t, { ...held, head });
      if (checked !== "missing") return endOf(checked);
      objects = { objects: objects.objects, completeness: OBJECT_MISSING };
    }
    const missing = objects.completeness.state === "limited" && objects.completeness.code === "OBJECT_MISSING";
    if (missing) {
      const w = t.workspace;
      const promisor = await hasPromisor(listing.entries, w, (paths) => runner.identities(t.operationId, contextOf(w), paths, t.signal));
      // A release cancels the read (contract §6 "Registration reuse and release"). A canceled read marks nothing.
      if (t.signal.aborted) return { result: "canceled" };
      if (promisor === "canceled" || promisor === "deadline") return { result: promisor };
      // A promisor check that cannot complete gives GIT_FAILED, as an object check that cannot complete does.
      if (promisor === "unknown") return refusal("GIT_FAILED");
      if (!promisor) {
        markUnavailable(w.repositoryId);
        return refusal("REPOSITORY_UNAVAILABLE", DAMAGED_STORE_REMEDY);
      }
    }

    // Contract §5: the first reached bound wins. A cut object output keeps the rows before its first unread object.
    let count = Math.min(traversal.rows.length, objects.objects.length);
    let completeness = held.failedStep !== null || objects.objects.length < traversal.rows.length ? objects.completeness : traversal.completeness;
    if (shallow.kind === "over") {
      // The shallow read comes first. Without the full shallow list, a row without effective parents can be a root or a shallow commit.
      const unknown = traversal.rows.findIndex((row, i) => i < count && row.parents.length === 0);
      if (unknown !== -1) count = unknown;
      completeness = limited("SHALLOW_METADATA_BYTES");
    }
    // Contract §8 "Changing working file": a change during the second attempt ends the read `limited` with WORKTREE_CHANGING.
    if (held.shallowChanged && completeness.state === "complete") completeness = { state: "limited", code: "WORKTREE_CHANGING" };
    const rows: HistoryRow[] = [];
    for (let i = 0; i < count; i++) {
      const row = rowOf(traversal.rows[i]!.oid, traversal.rows[i]!.parents, objects.objects[i]!);
      if (row === null) return refusal("MALFORMED_GIT_OUTPUT");
      rows.push(row);
    }
    // Contract §3: raw parent headers explain only the shallow boundaries.
    const hidden = (i: number): readonly string[] => (shallow.kind === "file" && shallow.commits.has(rows[i]!.oid) ? objects.objects[i]!.parents : []);
    const boundaries = (kept: number) => {
      const inPage = new Set(rows.slice(0, kept).map((row) => row.oid));
      const page = new Set<string>();
      const hiddenParents = new Set<string>();
      for (let i = 0; i < kept; i++) {
        for (const parent of rows[i]!.parents) if (!inPage.has(parent)) page.add(parent);
        for (const parent of hidden(i)) hiddenParents.add(parent);
      }
      return { page: [...page], shallow: [...hiddenParents] };
    };
    const base = (kept: number, c: Completeness): HistoryPage => ({
      generation: t.generation,
      scope: "current-checkout",
      head,
      shallowFingerprint: shallow.kind === "file" ? shallow.fingerprint : null,
      rows: [],
      boundaries: boundaries(kept),
      completeness: c as HistoryPage["completeness"],
      ...(c.state === "limited" && c.code === "OBJECT_MISSING" ? { remedy: { text: OBJECT_MISSING_REMEDY } } : {}),
    });

    // Contract §5 "History page": count the encoded result bytes as rows join the page. Each row adds its bytes and one comma.
    const pageLimit = limited("HISTORY_PAGE_BYTES");
    const sizes = rows.map(encodedBytes);
    const size = (kept: number, c: Completeness) => encodedBytes(base(kept, c)) + sizes.slice(0, kept).reduce((sum, n) => sum + n, 0) + Math.max(0, kept - 1);
    // The page bound sets the completeness only when no earlier bound did. The rows always stay within the page bound.
    let kept = rows.length;
    if (size(kept, completeness) > HISTORY_PAGE_BYTES) {
      if (completeness.state === "complete") completeness = pageLimit;
      kept = 0;
      while (kept < rows.length - 1 && size(kept + 1, completeness) <= HISTORY_PAGE_BYTES) kept++;
    }
    const value: HistoryPage = { ...base(kept, completeness), rows: rows.slice(0, kept) };
    if (completeness.state === "complete") return { result: "succeeded", value };
    return { result: "limited", code: completeness.code as "OUTPUT_LIMIT" | "OBJECT_MISSING" | "WORKTREE_CHANGING", value };
  }

  return {
    // Contract §3 `readHistory`: no status snapshot. The held steps start beside the trust listing, and the gate decides before any row leaves.
    async readHistory(t: ReadHistoryTarget): Promise<HistoryOutcome> {
      const steps = new AbortController();
      const stopSteps = () => steps.abort();
      t.signal.addEventListener("abort", stopSteps, { once: true });
      if (t.signal.aborted) steps.abort();
      try {
        const pending = heldSteps({ operationId: t.operationId, signal: steps.signal, workspace: t.workspace });
        pending.catch(() => {});
        const listed = await listingFor(t);
        const gate = listed.ok ? trust.gate(t.workspace, listed.listing, t.installation, "reads") : null;
        if (!listed.ok || gate !== null) {
          // Contract §7 "Held history steps": a refused gate ends every held step, discards its output, and starts no object check.
          steps.abort();
          await pending.catch(() => null);
          if (t.signal.aborted) return { result: "canceled" };
          return listed.ok ? refusal(gate!) : stoppedListing(listed);
        }
        let held = await pending;
        // Contract §8 "Changing working file": a shallow file change discards the attempt, and the held steps run once more.
        // The page still binds the request generation (contract §3 `readHistory`).
        if (!isStop(held) && held.shallowChanged && !t.signal.aborted) held = await heldSteps({ operationId: t.operationId, signal: steps.signal, workspace: t.workspace });
        if (t.signal.aborted) return { result: "canceled" };
        if (isStop(held)) return endOf(held);
        return await pageOf(t, listed.listing, held);
      } finally {
        t.signal.removeEventListener("abort", stopSteps);
      }
    },
  };
}

export type HistoryReader = ReturnType<typeof createHistoryReader>;
