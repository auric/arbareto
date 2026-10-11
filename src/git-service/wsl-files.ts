// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T214: the WSL file steps of the mutations (contract §4 "WSL index publication", §6 "WSL file work", §11 "Paths and file access").
// A refusal gives a `Failure`, and a walk stop gives a `Stop`. A result outside the contract form of its mode gives `PROCESS_OWNERSHIP_FAILED`.

import { randomBytes } from "node:crypto";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, GIT_PROCESS_DEADLINE_MS } from "../contracts/limits";
import { processEndArgs } from "./commands";
import { IndexFormatError, rawIndexEntries } from "./eligibility";
import { createCollector, RunnerRefusal, wslResultsFit, type GitExit, type GitRunner, type WslFileResult, type WslFilesCall, type WslRunner } from "./git-runner";
import type { CandidateFailure } from "./hunk-candidate";
import type { Fact, Failure, Stop } from "./hunk-publish";
import { LOCKED_REMEDY } from "./index-lock";
import { contextOf } from "./read-steps";
import type { Workspace } from "./registration";
import type { RawIndexPart } from "./snapshot";
import { readRawIndex } from "./status";

export interface WslContext {
  runner: Pick<GitRunner, "run"> & Pick<WslRunner, "wslFiles">;
  operationId: string;
  signal: AbortSignal;
  workspace: Workspace;
}

type Fields = WslFilesCall extends infer F ? (F extends unknown ? Omit<F, "operationId" | "contextKind" | "gitInstallationId" | "repositoryId"> : never) : never;
type Result<K extends WslFileResult["kind"]> = Extract<WslFileResult, { kind: K }>;
type Whole = { size: number; sha256: string };

const UNFIT: Failure = { code: "PROCESS_OWNERSHIP_FAILED" };
const INDEX_LIMIT: Failure = { code: "OUTPUT_LIMIT", reason: "MUTATION_RAW_INDEX_BYTES" };
const CHANGED = { changed: true } as const;
const INDEX_BOUND = "MUTATION_RAW_INDEX_BYTES";
const WHOLE_BOUND = "WHOLE_FILE_STAGE_INPUT_BYTES";
const NS_PER_S = 1_000_000_000n;
const POLL_MS = 1000;
// Contract §4 "Process end": removals and the process-end run follow a cancel, so no signal stops them. The §5 walk deadline still bounds a removal.
const LIVE = new AbortController().signal;

const isResult = (r: WslFileResult | Failure | Stop): r is WslFileResult => "kind" in r;
const exitedZero = (e: Result<"blob">["gitExit"]) => "exitCode" in e && e.exitCode === 0;
const entry = (parts: readonly string[]) => [{ root: "worktreeRoot" as const, path: [...parts] }];

async function send(ctx: WslContext, fields: Fields, signal: AbortSignal): Promise<WslFileResult | Failure | Stop> {
  const request = { operationId: ctx.operationId, ...contextOf(ctx.workspace), ...fields } as WslFilesCall;
  let results;
  try {
    results = await ctx.runner.wslFiles(request, signal);
  } catch (error) {
    if (error instanceof RunnerRefusal) return { code: error.code };
    throw error;
  }
  if (!Array.isArray(results)) return { stop: results.stop };
  return wslResultsFit(request, results) ? results[0]! : UNFIT;
}

// ---- Index ----

export type WslIndexDigest = Result<"index">;

// Contract §6 `indexDigest`. `sharedIndex`: the `link` hash whose shared file the walk also digests.
// After a stopped walk, the caller must pass a `ctx` with a signal that is not aborted. An aborted signal sends no walk.
export async function wslIndexDigest(ctx: WslContext, sharedIndex?: string): Promise<{ value: WslIndexDigest } | Failure | Stop> {
  const r = await send(ctx, { mode: "indexDigest", bound: INDEX_BOUND, ...(sharedIndex === undefined ? {} : { sharedIndex }) }, ctx.signal);
  if (!isResult(r)) return r;
  if (r.kind === "index") return { value: r };
  return r.kind === "error" ? { code: "GIT_FAILED" } : UNFIT;
}

// `raw` holds only the `link` hash, which `hunkEligibility` takes. `reply` holds both digest parts for the commit preflight.
export interface WslIndexFacts {
  raw: { link: string | null };
  // Null: the index file is absent.
  digest: string | null;
  unmerged: boolean;
  reply: WslIndexDigest;
}

// Contract §4 "WSL index publication": the canonical index against the bound raw index part.
export async function wslIndexOf(ctx: WslContext, bound: RawIndexPart): Promise<Fact<WslIndexFacts>> {
  const shared = bound.sharedIndex?.digest == null ? undefined : bound.sharedIndex.hash;
  const read = await wslIndexDigest(ctx, shared);
  if (!("value" in read)) return read;
  const reply = read.value;
  const parts = [reply.index, ...(reply.sharedIndex === undefined ? [] : [reply.sharedIndex])];
  if (parts.some((p) => p.kind === "error")) return { code: "GIT_FAILED" };
  if (parts.some((p) => p.kind === "bound")) return INDEX_LIMIT;
  const digest = reply.index.kind === "digest" ? reply.index.sha256 : null;
  // Acceptance refused a conflicted index, so the bound index holds no entry above stage 0.
  if (digest === bound.rawIndexDigest) return { value: { raw: { link: bound.sharedIndex?.hash ?? null }, digest, unmerged: false, reply } };
  if (digest === null) return { value: { raw: { link: null }, digest, unmerged: false, reply } };
  // Contract §11 "Paths and file access": only a changed digest reads the index bytes through UNC, once.
  const raw = await readRawIndex(ctx.workspace.indexPath);
  if (raw === "unavailable") return { code: "GIT_FAILED" };
  if (raw === "over") return INDEX_LIMIT;
  if (raw === null) return { value: { raw: { link: null }, digest, unmerged: false, reply } };
  try {
    const parsed = rawIndexEntries(raw, ctx.workspace.objectFormat);
    return { value: { raw: { link: parsed.link }, digest, unmerged: parsed.entries.some((e) => e.stage > 0), reply } };
  } catch (error) {
    if (error instanceof IndexFormatError) return { code: "MALFORMED_GIT_OUTPUT" };
    throw error;
  }
}

// ---- Working file and blob proofs ----

// `other`: a directory, a final link, or another file type.
export type WslWhole = Whole | "absent" | "other";

// Contract §6 `digest` with the whole-file bound. `changed` reads once more, as `readWorkingVersion` does for an atomic save.
export async function wslWhole(ctx: WslContext, parts: readonly string[]): Promise<Fact<WslWhole> | { changed: true }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await send(ctx, { mode: "digest", bound: WHOLE_BOUND, files: entry(parts) }, ctx.signal);
    if (!isResult(r)) return r;
    switch (r.kind) {
      case "file":
        if (r.changed) continue;
        // A file above the bound differs from every binding, as a `limited` read in `workingOf` does.
        return r.sha256 === undefined ? CHANGED : { value: { size: r.size, sha256: r.sha256 } };
      case "directory":
      case "other":
        return { value: "other" };
      // diff-lib.c `check_removed`: a link before the last component counts as removed.
      case "link":
        return { value: r.component === parts.length ? "other" : "absent" };
      case "absent":
        return { value: "absent" };
      case "error":
        return { code: "REPOSITORY_UNAVAILABLE" };
      default:
        return UNFIT;
    }
  }
  return CHANGED;
}

// Contract §4 "Blob proof" A through `catFile`. True: the filtered blob has the verified size and SHA-256.
export async function wslProofA(ctx: WslContext, parts: readonly string[], oid: string, bound: Whole): Promise<Fact<boolean>> {
  const r = await send(ctx, { mode: "catFile", bound: WHOLE_BOUND, files: entry(parts), oid, size: bound.size }, ctx.signal);
  if (!isResult(r)) return r;
  if (r.kind === "blob") return { value: !r.over && exitedZero(r.gitExit) && exitedZero(r.hashExit) && r.size === bound.size && r.sha256 === bound.sha256 };
  return r.kind === "error" ? { code: "GIT_FAILED" } : UNFIT;
}

// Contract §4 "Blob proof" B through `hashObject`. True: the working file has the verified size and SHA-256, and Git hashes it to `oid`.
export async function wslProofB(ctx: WslContext, parts: readonly string[], oid: string, bound: Whole): Promise<Fact<boolean>> {
  const r = await send(ctx, { mode: "hashObject", bound: WHOLE_BOUND, files: entry(parts) }, ctx.signal);
  if (!isResult(r)) return r;
  switch (r.kind) {
    case "object":
      return { value: exitedZero(r.gitExit) && exitedZero(r.hashExit) && r.size === bound.size && r.sha256 === bound.sha256 && r.oid === oid };
    case "file":
    case "directory":
    case "link":
    case "absent":
    case "other":
      return { value: false };
    case "error":
      return { code: "GIT_FAILED" };
    default:
      return UNFIT;
  }
}

// ---- Lock, candidate, publication, and removal ----

// `remove-failed`: the `remove` result `error`. Ownership stays unknown.
export type WslRemoved = "removed" | "notOwned" | "remove-failed";

export type WslPublishResult =
  | { published: true; size: number; sha256: string }
  | { published: false; reason: "notOwned" | "mismatch" }
  // Contract §4 "Outcome after a stopped walk": a `publish` result `error` is a typed failure of the `replace` step.
  | { published: false; reason: "replace-failed"; errno: string };

// The lock of a `lock` reply.
export interface WslIndexLock {
  path: string;
  token: string;
  identity: { device: string; inode: string };
  publish(candidate: string, expected: string, signal: AbortSignal): Promise<WslPublishResult | Failure | Stop>;
  // The lock form of `remove`.
  release(): Promise<WslRemoved | Failure | Stop>;
}

// A lock without a `lock` reply. Its ownership is unknown.
export interface UnknownLock {
  path: string;
  token: string;
  // Contract §4 "Lock token": send the token-only form only after the process-end fact.
  removeByToken(): Promise<WslRemoved | Failure | Stop>;
}

// `path` is the UNC form of `index.lock`. Every result after the request but `lock` and `locked` leaves the ownership unknown (contract §4 "Stopped or failed `lock`").
export type WslLockResult =
  | { ok: true; lock: WslIndexLock }
  | { ok: false; code: "LOCKED"; path: string; remedy: { text: string } }
  | { ok: false; reason: "create-failed"; errno: string; path: string; unknown: UnknownLock }
  | ((Stop | Failure) & { unknown: UnknownLock });

async function remove(ctx: WslContext, fields: Omit<Extract<Fields, { mode: "remove" }>, "mode" | "bound">): Promise<WslRemoved | Failure | Stop> {
  const r = await send(ctx, { mode: "remove", bound: INDEX_BOUND, ...fields }, LIVE);
  if (!isResult(r)) return r;
  if (r.kind === "removed" || r.kind === "notOwned") return r.kind;
  return r.kind === "error" ? "remove-failed" : UNFIT;
}

async function publish(ctx: WslContext, fields: Omit<Extract<Fields, { mode: "publish" }>, "mode" | "bound">, signal: AbortSignal): Promise<WslPublishResult | Failure | Stop> {
  const r = await send(ctx, { mode: "publish", bound: INDEX_BOUND, ...fields }, signal);
  if (!isResult(r)) return r;
  switch (r.kind) {
    // Contract §6 `publish`: another digest gives `mismatch`, so `published` carries the expected digest.
    case "published":
      return r.sha256 === fields.expected ? { published: true, size: r.size, sha256: r.sha256 } : UNFIT;
    case "mismatch":
    case "notOwned":
      return { published: false, reason: r.kind };
    case "error":
      return { published: false, reason: "replace-failed", errno: r.code };
    default:
      return UNFIT;
  }
}

// Contract §4 "Lock token": a new token of 32 random bytes for each `lock` request.
export async function wslLock(ctx: WslContext): Promise<WslLockResult> {
  const token = randomBytes(32).toString("hex");
  const path = `${ctx.workspace.indexPath}.lock`;
  const unknown: UnknownLock = { path, token, removeByToken: () => remove(ctx, { token }) };
  const r = await send(ctx, { mode: "lock", bound: INDEX_BOUND, token }, ctx.signal);
  // A refusal and a malformed reply share one error type, so the service cannot tell whether the walk ran.
  if (!isResult(r)) return { ...r, unknown };
  switch (r.kind) {
    case "lock": {
      const identity = { device: r.device, inode: r.inode };
      return {
        ok: true,
        lock: {
          path,
          token,
          identity,
          publish: (candidate, expected, signal) => publish(ctx, { candidate, lock: identity, token, expected }, signal),
          release: () => remove(ctx, { lock: identity, token }),
        },
      };
    }
    case "locked":
      return { ok: false, code: "LOCKED", path, remedy: { text: LOCKED_REMEDY } };
    case "error":
      return { ok: false, reason: "create-failed", errno: r.code, path, unknown };
    default:
      return { ...UNFIT, unknown };
  }
}

export type WslCopied = Pick<Result<"candidate">, "index" | "candidate">;
export type WslCopyFailure = Extract<CandidateFailure, { reason: "index-changed" | "bound" | "unavailable" | "candidate-time" | "verification" }>;

// Contract §4 "Candidate time", §6 `candidate`. Null: the index is absent, and Git creates the candidate. `boundDigest`: the bound raw index digest.
// `copied`: the walk created the candidate, and the reply holds its read-back facts.
export async function wslCopy(
  ctx: WslContext,
  name: string,
  boundDigest: string | null,
): Promise<{ value: WslCopied | null } | { failure: WslCopyFailure; copied?: WslCopied } | Failure | Stop> {
  const r = await send(ctx, { mode: "candidate", bound: INDEX_BOUND, candidate: name }, ctx.signal);
  if (!isResult(r)) return r;
  switch (r.kind) {
    case "candidate": {
      const copied = { index: r.index, candidate: r.candidate };
      const { index, candidate } = copied;
      if (index.sha256 !== boundDigest) return { failure: { reason: "index-changed" }, copied };
      if (candidate.size !== index.size || candidate.sha256 !== index.sha256) return { failure: { reason: "verification", detail: "content" }, copied };
      const canonicalNs = BigInt(index.mtime) * NS_PER_S;
      const candidateNs = BigInt(candidate.mtime) * NS_PER_S;
      if (candidateNs > canonicalNs) return { failure: { reason: "candidate-time", canonicalNs, candidateNs }, copied };
      return { value: copied };
    }
    case "absent":
      return boundDigest === null ? { value: null } : { failure: { reason: "index-changed" } };
    case "bound":
      return { failure: { reason: "bound" } };
    case "error":
      return { failure: { reason: "unavailable", errno: r.code } };
    default:
      return UNFIT;
  }
}

// Contract §4: the candidate form of `remove`, with the digest that the service verified last.
export const removeCandidate = (ctx: WslContext, name: string, digest: string) => remove(ctx, { candidate: name, expected: digest });

// ---- Process end ----

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
const SYSTEM_CLOCK: Clock = { now: () => performance.now(), sleep: (ms) => Bun.sleep(ms) };

// Contract §4 "Process end": `fact` when an `exit` reply carries `activeDescendants` 0 and an `exitCode` that is not null. The runs repeat once
// per second, and the §5 Git process deadline bounds them together. `noFact`: the deadline passed, or the runner refused the run (for example after `closeJob`).
export async function processEnd(ctx: Pick<WslContext, "operationId" | "workspace"> & { runner: Pick<GitRunner, "run"> }, clock: Clock = SYSTEM_CLOCK): Promise<"fact" | "noFact"> {
  const start = clock.now();
  for (;;) {
    const began = clock.now();
    const left = Math.ceil(start + GIT_PROCESS_DEADLINE_MS - began);
    if (left < 1) return "noFact";
    let exit: GitExit;
    try {
      exit = await ctx.runner.run({
        operationId: ctx.operationId,
        context: contextOf(ctx.workspace),
        arguments: processEndArgs(),
        environmentPolicy: "mutation",
        limits: { deadlineMs: left },
        stdout: createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }),
        stderr: createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }),
        signal: LIVE,
      });
    } catch (error) {
      if (error instanceof RunnerRefusal) return "noFact";
      throw error;
    }
    if (exit.deadline !== undefined || exit.diagnosticLimit) return "noFact";
    // Contract §6: `exitCode` null means a Job close or no start, so its count is no fact.
    if (exit.exitCode !== null && exit.activeDescendants === 0) return "fact";
    await clock.sleep(Math.max(0, began + POLL_MS - clock.now()));
  }
}
