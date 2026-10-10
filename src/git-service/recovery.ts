// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T114: the `unknown` gate and the recovery refresh, contract §5, §6 "Recovery markers", §8, and §9. The Windows path.
// Recovery removes no file. A WSL workspace gets no recovery read and no foreign scan until T214 (contract §11).

import { opendir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Handshake } from "../contracts/channel";
import { RECOVERY_FOREIGN_CAP, type RecoveryStatement } from "../contracts/envelope";
import { TERMINAL_STATES } from "../contracts/errors";
import { attribute, readWindow, type Window } from "./attribution";
import type { RetainedCommit } from "./commit";
import type { MutationEntry } from "./exclusion";
import type { GitRunner } from "./git-runner";
import { besideIndex, indexOf, observedLocks, type Fact, type Failure, type ObserveContext, type RetainedPublication, type Stop } from "./hunk-publish";
import { sameIdentity, type PhysicalIdentity } from "./identity";
import type { DiagnosticCause } from "./log";
import type { OperationRegistry } from "./operations";
import { parentsOf } from "./reconcile";
import type { Workspace } from "./registration";
import type { Head, ReadInstallation } from "./snapshot";
import type { ReadOutcome, WorkspaceReader } from "./status";
import type { Trust } from "./trust";

// Contract §8: the fixed prefix of every candidate file.
const CANDIDATE_PREFIX = "arbareto-candidate-";
const NO_REQUEST = { outcome: "unknown", attribution: { result: "unknown", reason: "no-retained-request" } } as const;
const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// One unresolved marker. `own`: a mutation of this session with its worktree identity. A handshake marker has none.
interface Pending {
  commonIdentity: PhysicalIdentity;
  own?: { operationId: string; worktreeIdentity: Workspace["worktreeIdentity"] };
}

type Blockable = Pick<Workspace, "repositoryId" | "commonIdentity">;

export interface RecoveryTarget {
  operationId: string;
  // The work signal of the read slot, so the read deadline also stops recovery.
  signal: AbortSignal;
  workspace: Workspace;
  installation: ReadInstallation;
}

export interface RecoveryOptions {
  runner: GitRunner;
  registry: Pick<OperationRegistry, "get">;
  trust: Trust;
  reader: Pick<WorkspaceReader, "operationState" | "recoveryState">;
  publications: Pick<Map<string, RetainedPublication>, "get" | "delete">;
  commits: Pick<Map<string, RetainedCommit>, "get" | "delete">;
}

export function createRecovery({ runner, registry, trust, reader, publications, commits }: RecoveryOptions) {
  const pending = new Map<string, Pending>();
  // Contract §8 "Service restart": the workspaces of a `restarted` session without a complete refresh yet.
  const restart = new Set<string>();
  let restarted = false;
  // Contract §5 "Recovery markers": above the marker limit, every mutation stays blocked for the whole session.
  let limit = false;
  // One recovery at a time, so each marker gets one `resolved` frame.
  let tail: Promise<unknown> = Promise.resolve();

  const unknown = (w: Blockable): boolean => restart.has(w.repositoryId) || [...pending.values()].some((p) => sameIdentity(p.commonIdentity, w.commonIdentity));

  // Contract §8 "Recovery statement": the match of the canonical index with the retained digests. No attribution step runs.
  async function indexMatch(w: Workspace, kept: RetainedPublication): Promise<RecoveryStatement | Failure | Stop> {
    const index = await indexOf(w);
    if (!("value" in index)) return index;
    const digest = index.value.digest;
    return { outcome: "unknown", indexMatch: kept.candidate !== null && digest === kept.candidate ? "published" : digest === kept.before ? "not-published" : "neither" };
  }

  // Contract §8 "Attribution window": one attempt from the retained preflight tip. `h1` is the HEAD of the complete snapshot.
  async function attribution(ctx: ObserveContext, kept: RetainedCommit, h1: Head): Promise<RecoveryStatement | Failure | Stop> {
    const window: Fact<Window> = h1.state === "unborn" ? { value: { records: [] } } : await readWindow(ctx, kept.tip);
    if (!("value" in window)) return window;
    const records = "records" in window.value ? window.value.records : [];
    let parents: string[] | null = null;
    // Only one record whose commit is the observed HEAD can identify a commit, so only it needs its parents.
    if (records.length === 1 && h1.state !== "unborn" && records[0]!.oid === h1.oid) {
      const read = await parentsOf(ctx, h1.oid);
      if (!("value" in read)) return read;
      parents = read.value;
    }
    const a = attribute(window.value, kept.binding.head, h1, parents);
    return { outcome: "unknown", attribution: "identified" in a ? { result: "identified", commitOid: a.identified } : "none" in a ? { result: "none" } : { result: "unknown", reason: a.unknown } };
  }

  // Contract §8 "Service restart": the existing locks of the "Observed locks" set, then the candidate files in byte order of their names.
  // `total` counts all of them. The scan keeps at most the names that fit the list.
  async function foreignFiles(ctx: ObserveContext, head: Head): Promise<{ files: string[]; total: number } | Failure | Stop> {
    const locks = await observedLocks(ctx, head);
    if (!Array.isArray(locks)) return locks;
    const room = RECOVERY_FOREIGN_CAP - locks.length;
    const names: string[] = [];
    let count = 0;
    try {
      for await (const entry of await opendir(dirname(ctx.workspace.indexPath))) {
        if (ctx.signal.aborted) return { stop: "canceled" };
        if (!entry.name.startsWith(CANDIDATE_PREFIX)) continue;
        count++;
        names.push(entry.name);
        if (names.length > room) names.sort(byBytes).pop();
      }
    } catch {
      return { code: "GIT_FAILED" };
    }
    return { files: [...locks, ...names.sort(byBytes).map((name) => besideIndex(ctx.workspace, name))], total: locks.length + count };
  }

  async function statement(ctx: ObserveContext, markers: Pending[], head: Head): Promise<RecoveryStatement | Failure | Stop> {
    const w = ctx.workspace;
    if (w.wsl !== undefined) return NO_REQUEST;
    // Contract §8: a retained request belongs to the worktree identity of its mutation.
    const own = markers.map((p) => p.own).find((o) => o !== undefined && o.worktreeIdentity.every((identity, i) => sameIdentity(identity, w.worktreeIdentity[i]!)));
    const publication = own && publications.get(own.operationId);
    const commit = own && commits.get(own.operationId);
    if (publication) return indexMatch(w, publication);
    if (commit) return attribution(ctx, commit, head);
    const found = await foreignFiles(ctx, head);
    if (!("files" in found)) return found;
    return { ...NO_REQUEST, ...(found.files.length > 0 ? { foreign: found.files } : {}), ...(found.total > found.files.length ? { foreignTotal: found.total } : {}) };
  }

  // Contract §8: recovery after a `readWorkspace` with `refresh: true`. Only a complete snapshot and successful recovery reads release the block.
  // A failed recovery read keeps the read result and the block. Its code goes to the session log as `cause`.
  async function recover(t: RecoveryTarget, outcome: ReadOutcome): Promise<ReadOutcome & { cause?: DiagnosticCause }> {
    const w = t.workspace;
    if (outcome.result !== "succeeded" || !unknown(w)) return outcome;
    const markers = [...pending].filter(([, p]) => sameIdentity(p.commonIdentity, w.commonIdentity));
    const ctx: ObserveContext = { runner, trust, reader, operationId: t.operationId, signal: t.signal, workspace: w, installation: t.installation };
    const stated = markers.length === 0 ? ({ outcome: "none" } as const) : await statement(ctx, markers.map(([, p]) => p), outcome.value.head);
    if ("code" in stated) return { ...outcome, cause: stated.code };
    if ("stop" in stated) return { ...outcome, cause: stated.stop === "deadline" ? "DEADLINE" : "CANCELED" };
    // A cancel or the read deadline ends the read without a result, so the block stays.
    if (t.signal.aborted) return outcome;
    for (const [markerId, p] of markers) {
      runner.resolved(markerId);
      pending.delete(markerId);
      if (p.own === undefined) continue;
      publications.delete(p.own.operationId);
      commits.delete(p.own.operationId);
    }
    restart.delete(w.repositoryId);
    return { ...outcome, value: { ...outcome.value, recovery: stated, recoveryState: reader.recoveryState(w) } };
  }

  return {
    // Contract §6 "Startup handshake": the markers from earlier sessions, `restarted`, and the marker limit.
    load(handshake: Pick<Handshake, "markers" | "unloadedMarkers" | "restarted">): void {
      restarted = handshake.restarted;
      limit = handshake.unloadedMarkers > 0;
      for (const m of handshake.markers) pending.set(m.markerId, { commonIdentity: m.commonIdentity });
    },
    // Contract §8 "Service restart": every registration of a `restarted` session starts `unknown`.
    register(w: Workspace): void {
      if (restarted) restart.add(w.repositoryId);
    },
    release(w: Workspace): void {
      restart.delete(w.repositoryId);
    },
    unknown,
    // Contract §9: STATE_UNKNOWN at mutation exclusion entry.
    blocked: (w: Blockable): boolean => limit || unknown(w),
    // Contract §6: a mutation without a known outcome sent no `resolved`, so its marker blocks the common directory.
    settled(entry: MutationEntry, markerId: string, worktreeIdentity: Workspace["worktreeIdentity"] | undefined): void {
      const state = registry.get(entry.operationId)?.state;
      if (state !== undefined && state !== "unknown" && (TERMINAL_STATES as readonly string[]).includes(state)) return;
      pending.set(markerId, { commonIdentity: entry.workspace.commonIdentity, ...(worktreeIdentity === undefined ? {} : { own: { operationId: entry.operationId, worktreeIdentity } }) });
    },
    refresh(t: RecoveryTarget, outcome: ReadOutcome): Promise<ReadOutcome & { cause?: DiagnosticCause }> {
      const next = tail.then(() => recover(t, outcome));
      tail = next.catch(() => {});
      return next;
    },
  };
}

export type Recovery = ReturnType<typeof createRecovery>;
