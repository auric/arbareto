// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Data-model §4 "Change snapshot" and "Status snapshot retention".

import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { UtcTime } from "../contracts/channel";
import { codeFitsState, type ErrorCode } from "../contracts/errors";
import * as limits from "../contracts/limits";
import { COMPARED_RAW_VERSION_BYTES, MUTATION_RAW_INDEX_BYTES, WHOLE_FILE_STAGE_INPUT_BYTES } from "../contracts/limits";
import { Count, Fingerprint, Identifier } from "../contracts/operations";
import { IndexFormatError, splitIndexLink, type ObjectFormat } from "./eligibility";
import type { GitInstallation } from "./git-installation";

export type { ObjectFormat } from "./eligibility";

// The contracts hold no schema for these planned values yet. T085 adds the `readWorkspace` result schemas.
export type Head = { state: "branch"; target: string; oid: string } | { state: "detached"; oid: string } | { state: "unborn"; target: string };

// Data-model §2 `operationState`.
export type OperationState = "normal" | "conflicted" | "merging" | "rebasing" | "cherry-picking" | "reverting" | "sequencer-active" | "unknown";

// Contract §9: `limited` carries `OUTPUT_LIMIT` with the reached §5 bound, `OBJECT_MISSING`, or `WORKTREE_CHANGING`. `failed` carries the specific code.
export type LimitName = Exclude<keyof typeof limits, "default">;
export type Completeness =
  | { state: "complete" }
  | { state: "limited"; code: "OUTPUT_LIMIT"; reason: LimitName }
  | { state: "limited"; code: "OBJECT_MISSING" | "WORKTREE_CHANGING" }
  | { state: "failed"; code: ErrorCode };

const failed = (code: ErrorCode) => ({ ok: false as const, completeness: { state: "failed" as const, code } });
const limited = (reason: LimitName) => ({ ok: false as const, completeness: { state: "limited" as const, code: "OUTPUT_LIMIT" as const, reason } });

// Data-model §4 `indexEntries`. `path` holds the literal path bytes.
export interface IndexEntry {
  path: Uint8Array;
  stage: 0 | 1 | 2 | 3;
  mode: string;
  oid: string;
  intentToAdd: boolean;
  assumeUnchanged: boolean;
  skipWorktree: boolean;
}

// gitformat-index: regular files (0644, 0755), symbolic links, gitlinks, and sparse directories.
const INDEX_MODES = new Set(["100644", "100755", "120000", "160000", "040000"]);
const OID_HEX: Record<ObjectFormat, RegExp> = { sha1: /^[0-9a-f]{40}$/, sha256: /^[0-9a-f]{64}$/ };

// SHA-256 over tagged, length-prefixed fields. No field can shift into the next one.
class Digest {
  private readonly hasher = new Bun.CryptoHasher("sha256");
  private length(n: number): this {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(n));
    this.hasher.update(bytes);
    return this;
  }
  field(tag: string, value: string | Uint8Array | number | boolean | null): this {
    const tagBytes = Buffer.from(tag, "utf8");
    this.length(tagBytes.length).hasher.update(tagBytes);
    if (value === null) return this.length(0).length(0);
    const bytes = value instanceof Uint8Array ? value : Buffer.from(String(value), "utf8");
    this.length(1).length(bytes.length).hasher.update(bytes);
    return this;
  }
  hex(): string {
    return this.hasher.digest("hex");
  }
}

// Data-model §4 `indexFingerprint`. `sharedIndex.digest` is null for an all-zero link hash, which needs no shared file.
export interface IndexFingerprint {
  digest: string;
  rawIndexDigest: string | null;
  sharedIndex: { hash: string; digest: string | null } | null;
}

export interface IndexFingerprintInput {
  // Null when the index file does not exist. Git then reads an empty index (read-cache.c `do_read_index`).
  rawIndex: Uint8Array | null;
  objectFormat: ObjectFormat;
  // The Git-resolved worktree Git directory (data-model §2 `gitDirectory`).
  gitDirectory: string;
  entries: readonly IndexEntry[];
}

export type Checked<T> = { ok: true; value: T } | { ok: false; completeness: Completeness };

// The `lstat` identity of the path. Node.js and Bun give 64-bit file IDs only as bigint.
type FileIdentity = Pick<BigIntStats, "dev" | "ino">;

// Opens a regular file without following a final link. O_NONBLOCK keeps a file replaced by a FIFO from blocking the open.
// Bun on Windows defines neither flag, so the open follows a final reparse point. `expected` then detects a swapped path.
async function openRegular(path: string | Buffer, expected?: FileIdentity) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const stat = await handle.stat({ bigint: true });
  if (!stat.isFile()) {
    await handle.close();
    return null;
  }
  if (expected !== undefined && (stat.dev !== expected.dev || stat.ino !== expected.ino)) {
    await handle.close();
    return "swapped" as const;
  }
  return { handle, stat };
}

// Reads at most `bound + 1` bytes. Returns null above `bound`.
async function boundedDigest(
  path: string | Buffer,
  bound: number,
  trailerBytes = 0,
  expected?: FileIdentity,
): Promise<{ digest: string; size: number; trailer: Uint8Array } | null | "absent" | "swapped"> {
  const opened = await openRegular(path, expected).catch((error: NodeJS.ErrnoException) => {
    // O_NOFOLLOW gives ELOOP for a final symbolic link. `expected` comes from an `lstat` that found a regular file.
    if (error.code === "ELOOP" && expected !== undefined) return "swapped" as const;
    if (error.code === "ENOENT" || error.code === "ELOOP" || error.code === "ENOTDIR") return "absent" as const;
    throw error;
  });
  if (opened === "absent" || opened === null) return "absent";
  if (opened === "swapped") return opened;
  const { handle, stat } = opened;
  try {
    if (stat.size > BigInt(bound)) return null;
    const hasher = new Bun.CryptoHasher("sha256");
    const chunk = new Uint8Array(64 * 1024);
    let size = 0;
    let tail = new Uint8Array(0);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, bound + 1 - size));
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > bound) return null;
      const part = chunk.subarray(0, bytesRead);
      hasher.update(part);
      if (trailerBytes > 0) tail = Buffer.concat([tail, part]).subarray(-trailerBytes);
    }
    return { digest: hasher.digest("hex"), size, trailer: tail };
  } finally {
    await handle.close();
  }
}

// Data-model §4 `indexFingerprint`: "Full-index content digest and Git-derived entries. Include referenced split-index state when applicable."
// Contract §5 "Raw index eligible for mutation": the bound covers the raw index and its shared index file together.
export async function indexFingerprint(input: IndexFingerprintInput): Promise<Checked<IndexFingerprint>> {
  const { rawIndex, objectFormat, gitDirectory, entries } = input;
  if (!validEntries(entries, objectFormat)) return failed("MALFORMED_GIT_OUTPUT");
  if (rawIndex !== null && rawIndex.length > MUTATION_RAW_INDEX_BYTES) return limited("MUTATION_RAW_INDEX_BYTES");
  let link: string | null = null;
  try {
    link = rawIndex === null ? null : splitIndexLink(rawIndex, objectFormat);
  } catch (error) {
    if (error instanceof IndexFormatError) return failed("MALFORMED_GIT_OUTPUT");
    throw error;
  }
  let sharedIndex: IndexFingerprint["sharedIndex"] = null;
  if (link !== null) {
    sharedIndex = { hash: link, digest: null };
    if (/[^0]/.test(link)) {
      // research.md R2: the shared file is `sharedindex.<hash>` in the worktree Git directory (read-cache.c:2384).
      const hashBytes = link.length / 2;
      let shared: Awaited<ReturnType<typeof boundedDigest>>;
      try {
        shared = await boundedDigest(join(gitDirectory, `sharedindex.${link}`), MUTATION_RAW_INDEX_BYTES - rawIndex!.length, hashBytes);
      } catch {
        return failed("REPOSITORY_UNAVAILABLE");
      }
      if (shared === "absent" || shared === "swapped") return failed("REPOSITORY_UNAVAILABLE");
      if (shared === null) return limited("MUTATION_RAW_INDEX_BYTES");
      // read-cache.c `read_index_from`: Git refuses a shared file whose trailing hash differs from the link hash.
      if (Buffer.from(shared.trailer).toString("hex") !== link) return failed("MALFORMED_GIT_OUTPUT");
      sharedIndex.digest = shared.digest;
    }
  }
  const rawIndexDigest = rawIndex === null ? null : new Bun.CryptoHasher("sha256").update(rawIndex).digest("hex");
  return { ok: true, value: fingerprintOf({ rawIndexDigest, sharedIndex }, objectFormat, entries) };
}

const validEntries = (entries: readonly IndexEntry[], objectFormat: ObjectFormat) =>
  entries.every((e) => OID_HEX[objectFormat].test(e.oid) && INDEX_MODES.has(e.mode) && [0, 1, 2, 3].includes(e.stage) && e.path.length > 0);

// The raw-index part of `indexFingerprint`: the raw index digest, the `link` hash, and the shared index digest.
export type RawIndexPart = Omit<IndexFingerprint, "digest">;

// Contract §11 "Change polling": the fingerprint from a retained raw-index part and the entries of this read.
export function retainedIndexFingerprint(part: RawIndexPart, objectFormat: ObjectFormat, entries: readonly IndexEntry[]): Checked<IndexFingerprint> {
  return validEntries(entries, objectFormat) ? { ok: true, value: fingerprintOf(part, objectFormat, entries) } : failed("MALFORMED_GIT_OUTPUT");
}

function fingerprintOf({ rawIndexDigest, sharedIndex }: RawIndexPart, objectFormat: ObjectFormat, entries: readonly IndexEntry[]): IndexFingerprint {
  const digest = new Digest()
    .field("objectFormat", objectFormat)
    .field("rawIndex", rawIndexDigest)
    .field("link", sharedIndex?.hash ?? null)
    .field("sharedIndex", sharedIndex?.digest ?? null)
    .field("entries", entries.length);
  for (const e of entries) {
    digest.field("path", e.path).field("stage", e.stage).field("mode", e.mode).field("oid", e.oid);
    digest.field("intentToAdd", e.intentToAdd).field("assumeUnchanged", e.assumeUnchanged).field("skipWorktree", e.skipWorktree);
  }
  return { digest: digest.hex(), rawIndexDigest, sharedIndex };
}

// Data-model §3 `state` and `trustId`.
export interface TrustApproval {
  state: "untrusted" | "approved" | "changed" | "revoked";
  trustId: string | null;
}

// Data-model §4 `policyFingerprint`: "Relevant attributes, trust approval, configuration, and Git installation identity."
export interface PolicyInput {
  // Bounded Git output that states the relevant attributes. The caller selects the paths and attributes.
  attributes: Uint8Array;
  trust: TrustApproval;
  // Data-model §3 `configurationFingerprint`.
  configurationFingerprint: string;
  // Data-model §1 `executablePath` and `executableIdentity`.
  git: Pick<GitInstallation, "gitInstallationId" | "executablePath" | "executableIdentity">;
}

// The WSL Git of a WSL workspace: the contract §11 Git file identity and the version token. It has no digest.
export type WslPolicyGit = { gitInstallationId: string; executablePath: string; wsl: { identity: string; version: string } };

// The Git of a read: the policy fingerprint fields and the trust record path (contract §7 `gitSelectedPath`).
// Null: a WSL Git path without a UNC form (contract §11 `wslIdentityPath`). No trust record can name it.
export type ReadInstallation = (PolicyInput["git"] | WslPolicyGit) & { selectedPath: string | null };

export function policyFingerprint(input: Omit<PolicyInput, "git"> & { git: PolicyInput["git"] | WslPolicyGit }): string {
  const { attributes, trust, configurationFingerprint, git } = input;
  if (!Fingerprint.safeParse(configurationFingerprint).success) throw new TypeError("configurationFingerprint");
  if (trust.trustId !== null && !Identifier.safeParse(trust.trustId).success) throw new TypeError("trustId");
  const hash = new Digest()
    .field("attributes", attributes)
    .field("trustState", trust.state)
    .field("trustId", trust.trustId)
    .field("configuration", configurationFingerprint)
    .field("gitInstallationId", git.gitInstallationId)
    .field("executablePath", git.executablePath);
  if ("wsl" in git) return hash.field("wslGitIdentity", git.wsl.identity).field("wslGitVersion", git.wsl.version).hex();
  const { file, versionOutput, digest } = git.executableIdentity;
  return hash
    .field("volumeSerial", "volumeSerial" in file ? file.volumeSerial : null)
    .field("fileId", "fileId" in file ? file.fileId : null)
    .field("identityCode", "code" in file ? file.code : null)
    .field("versionOutput", versionOutput)
    .field("executableDigest", digest)
    .hex();
}

// Data-model §4 `workingVersions`: "Selected-path existence, type, mode, raw-byte digest, and normalized content identity."
// `mode` is the `lstat` mode. `normalized` is the Git-derived content identity that the caller supplies.
export type WorkingVersion =
  | { path: Uint8Array; exists: false }
  | { path: Uint8Array; exists: true; type: "file"; mode: number; size: number; rawDigest: string; normalized: string | null }
  | { path: Uint8Array; exists: true; type: "symlink"; mode: number; rawDigest: string; normalized: null }
  | { path: Uint8Array; exists: true; type: "directory" | "other"; mode: number };

// Contract §5: the compared raw version bound, or the whole-file stage input bound of a `stage` file approval.
export type WorkingBound = "COMPARED_RAW_VERSION_BYTES" | "WHOLE_FILE_STAGE_INPUT_BYTES";
const WORKING_BOUNDS: Record<WorkingBound, number> = { COMPARED_RAW_VERSION_BYTES, WHOLE_FILE_STAGE_INPUT_BYTES };

// gitformat-index: a path has no leading or trailing slash and no `.` or `..` component.
// A component that `basename` changes holds a platform separator or a drive prefix, so it could leave the worktree.
function components(path: Uint8Array): Buffer[] | null {
  if (path.length === 0 || path.includes(0)) return null;
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i <= path.length; i++) {
    if (i < path.length && path[i] !== 0x2f) continue;
    const part = Buffer.from(path.subarray(start, i));
    const name = part.toString("utf8");
    if (part.length === 0 || name === "." || name === ".." || basename(name) !== name) return null;
    parts.push(part);
    start = i + 1;
  }
  return parts;
}

const typeOf = (stat: BigIntStats) => (stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "other");

// Test seam only. Production never sets it.
export interface ReadWorkingVersionOptions {
  afterLstat?: () => Promise<void>;
}

// An atomic save replaces the file between the `lstat` and the open, so one swap gets one retry.
// REPOSITORY_CHANGED reports a second swap. `readWorkspace` maps it by contract §8 "Changing working file".
export async function readWorkingVersion(
  worktreeRoot: string,
  path: Uint8Array,
  bound: WorkingBound,
  normalized: string | null,
  options: ReadWorkingVersionOptions = {},
): Promise<Checked<WorkingVersion>> {
  const parts = components(path);
  if (parts === null) return failed("MALFORMED_GIT_OUTPUT");
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await readOnce(worktreeRoot, parts, path, bound, normalized, options);
    if (result !== "swapped") return result;
  }
  return failed("REPOSITORY_CHANGED");
}

async function readOnce(
  worktreeRoot: string,
  parts: Buffer[],
  path: Uint8Array,
  bound: WorkingBound,
  normalized: string | null,
  options: ReadWorkingVersionOptions,
): Promise<Checked<WorkingVersion> | "swapped"> {
  const absent = { ok: true as const, value: { path, exists: false as const } };
  const separator = Buffer.from("/");
  let current = Buffer.from(worktreeRoot, "utf8");
  let stat: BigIntStats | null = null;
  try {
    for (const [i, part] of parts.entries()) {
      current = Buffer.concat([current, separator, part]);
      stat = await lstat(current, { bigint: true });
      // diff-lib.c `check_removed`: a path behind a symbolic link or a non-directory counts as removed.
      if (i < parts.length - 1 && !stat.isDirectory()) return absent;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return absent;
    return failed("REPOSITORY_UNAVAILABLE");
  }
  const type = typeOf(stat!);
  const mode = Number(stat!.mode);
  if (type === "directory" || type === "other") return { ok: true, value: { path, exists: true, type, mode } };
  if (type === "symlink") {
    let target: Buffer;
    try {
      target = await readlink(current, { encoding: "buffer" });
    } catch {
      return failed("REPOSITORY_UNAVAILABLE");
    }
    if (target.length > WORKING_BOUNDS[bound]) return limited(bound);
    const rawDigest = new Bun.CryptoHasher("sha256").update(target).digest("hex");
    return { ok: true, value: { path, exists: true, type, mode, rawDigest, normalized: null } };
  }
  await options.afterLstat?.();
  let read: Awaited<ReturnType<typeof boundedDigest>>;
  try {
    read = await boundedDigest(current, WORKING_BOUNDS[bound], 0, stat!);
  } catch {
    return failed("REPOSITORY_UNAVAILABLE");
  }
  if (read === "absent") return absent;
  if (read === "swapped") return read;
  if (read === null) return limited(bound);
  return { ok: true, value: { path, exists: true, type: "file", mode, size: read.size, rawDigest: read.digest, normalized } };
}

// Data-model §4 without `snapshotId` and `generation`. The store assigns both.
export interface Observation {
  repositoryId: string;
  head: Head;
  indexFingerprint: IndexFingerprint | null;
  indexEntries: readonly IndexEntry[];
  workingVersions: readonly WorkingVersion[];
  policyFingerprint: string | null;
  operationState: OperationState;
  completeness: Completeness;
  // Number of status entries in the snapshot, all pages included.
  entryCount: number;
  // Observation time as UTC RFC 3339. It is not a transaction timestamp.
  observedAt: string;
}

export interface ChangeSnapshot extends Observation {
  snapshotId: string;
  generation: number;
}

// Contract §8 "Token invalidation": HEAD, `indexFingerprint`, `policyFingerprint`, `operationState`, and the bound `workingVersions`.
function observationDigest(o: Observation): string {
  const d = new Digest()
    .field("headState", o.head.state)
    .field("headTarget", "target" in o.head ? o.head.target : null)
    .field("headOid", "oid" in o.head ? o.head.oid : null)
    .field("index", o.indexFingerprint?.digest ?? null)
    .field("policy", o.policyFingerprint)
    .field("operationState", o.operationState)
    .field("workingVersions", o.workingVersions.length);
  for (const w of o.workingVersions) {
    d.field("path", w.path).field("exists", w.exists);
    if (!w.exists) continue;
    d.field("type", w.type).field("mode", w.mode);
    if (w.type === "file" || w.type === "symlink") d.field("rawDigest", w.rawDigest).field("normalized", w.normalized);
  }
  return d.hex();
}

function checkObservation(o: Observation): void {
  if (!Identifier.safeParse(o.repositoryId).success) throw new TypeError("repositoryId");
  if (!Count.safeParse(o.entryCount).success) throw new TypeError("entryCount");
  if (!UtcTime.safeParse(o.observedAt).success) throw new TypeError("observedAt");
  const c = o.completeness;
  if (c.state !== "complete" && !codeFitsState(c.state, c.code)) throw new TypeError("completeness");
  if (c.state === "limited" && c.code === "OUTPUT_LIMIT" && !Object.hasOwn(limits, c.reason)) throw new TypeError("completeness reason");
  // Contract §5: a bound cannot turn an incomplete result into a complete result.
  if (c.state === "complete" && (o.indexFingerprint === null || o.policyFingerprint === null)) throw new TypeError("complete observation without fingerprints");
}

export type SnapshotLookup<S> = { ok: true; snapshot: S } | { ok: false; code: "REPOSITORY_CHANGED" | "UNKNOWN_TARGET" };

// One store per service session, so a new session holds no snapshot (contract §8 "Service restart").
export function createSnapshotStore<S extends ChangeSnapshot = ChangeSnapshot>() {
  const workspaces = new Map<string, { generation: number; snapshot: S | null; digest: string | null }>();
  const workspace = (repositoryId: string) => {
    const w = workspaces.get(repositoryId);
    if (!w) throw new TypeError("unregistered repositoryId");
    return w;
  };
  return {
    // Returns the current generation. A registration of a known workspace keeps its state.
    register(repositoryId: string): number {
      if (!workspaces.has(repositoryId)) workspaces.set(repositoryId, { generation: 0, snapshot: null, digest: null });
      return workspace(repositoryId).generation;
    },
    generation(repositoryId: string): number {
      return workspace(repositoryId).generation;
    },
    // A full read replaces the retained snapshot. A changed observation advances the generation. The first one does not.
    // `advance` gives a new generation also to an equal observation (contract §8 "Changing working file").
    record(observation: Observation, extra?: Omit<S, keyof ChangeSnapshot>, advance = false): S {
      checkObservation(observation);
      const w = workspace(observation.repositoryId);
      const digest = observationDigest(observation);
      if (advance || (w.digest !== null && w.digest !== digest)) w.generation += 1;
      w.digest = digest;
      w.snapshot = { ...observation, ...extra, snapshotId: crypto.randomUUID(), generation: w.generation } as S;
      return w.snapshot;
    },
    // A `check: "changes"` read with an equal tuple and no hint returns this snapshot (contract §8 "Change check").
    retained(repositoryId: string): S | null {
      return workspaces.get(repositoryId)?.snapshot ?? null;
    },
    // The retained snapshot when it holds an observation equal to `observation`, else null. A late read returns it (contract §2 and §8).
    retainedEqual(observation: Observation): S | null {
      const w = workspaces.get(observation.repositoryId);
      return w !== undefined && w.digest === observationDigest(observation) ? w.snapshot : null;
    },
    // `readEntries` checks the generation first, then the snapshot (data-model §4).
    lookup(repositoryId: string, repositoryGeneration: number, snapshotId: string): SnapshotLookup<S> {
      const w = workspaces.get(repositoryId);
      if (!w) return { ok: false, code: "UNKNOWN_TARGET" };
      if (repositoryGeneration !== w.generation) return { ok: false, code: "REPOSITORY_CHANGED" };
      if (w.snapshot === null || w.snapshot.snapshotId !== snapshotId) return { ok: false, code: "UNKNOWN_TARGET" };
      return { ok: true, snapshot: w.snapshot };
    },
    // Contract §6 "Registration reuse and release".
    release(repositoryId: string): void {
      workspaces.delete(repositoryId);
    },
    releaseAll(): void {
      workspaces.clear();
    },
  };
}
