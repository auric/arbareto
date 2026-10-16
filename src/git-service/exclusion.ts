// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T106: contract §5 "Mutations" and §6 "Recovery markers", "Cross-instance exclusion", and "Mutation frames".
// `applyHunk`, `applyFile`, and `commit` enter a mutation only through this module.

import type { MarkerFailure, MutationStarted } from "../contracts/channel";
import { RunnerRefusal, type GitRunner, type RefusedCode } from "./git-runner";
import { sameIdentity } from "./identity";
import type { Workspace } from "./registration";

// Contract §6 "Cross-instance exclusion".
export const CROSS_INSTANCE_REMEDY = "Another Arbareto window runs a change in this repository. Wait until it ends, then try again.";
// Contract §9.
export const MARKER_FAILED_REMEDY = "Arbareto could not save its recovery record. Free disk space or restore write access to this folder, then try again.";

export interface MutationEntry {
  operationId: string;
  kind: MutationStarted["kind"];
  // Only `applyHunk` and `applyFile` carry it (contract §6 "Mutation frames").
  direction?: MutationStarted["direction"];
  // Only `sync` carries it (feature 003 contract Δ6).
  action?: MutationStarted["action"];
  workspace: Pick<Workspace, "repositoryId" | "worktreeRoot" | "commonDirectory" | "commonIdentity">;
}

// `end` sends the `ended` frame after the terminal response and releases the exclusion.
export type Entered = { ok: true; markerId: string; end(endProcesses: boolean): void };
export type NotEntered =
  | { ok: false; code: "BUSY"; remedy?: { text: string } }
  | { ok: false; code: "RECOVERY_MARKER_FAILED"; failure: MarkerFailure; folder: string; remedy: { text: string } }
  | { ok: false; code: "DEADLINE" }
  | { ok: false; code: "STATE_UNKNOWN" }
  | { ok: false; code: RefusedCode };

// Contract §8 and §9 (T114): `blocked` refuses entry with STATE_UNKNOWN. `settled` records the outcome before the slot frees.
export interface RecoveryGate {
  blocked(w: MutationEntry["workspace"]): boolean;
  settled(entry: MutationEntry, markerId: string): void;
}

type Slot = Pick<Workspace, "repositoryId" | "commonIdentity"> & { operationId: string };

export function createExclusion(runner: Pick<GitRunner, "started" | "ended" | "closeJob">, gate?: RecoveryGate) {
  // Contract §5: one mutation per common repository. A slot lives from `enter` to `end` or to a refusal.
  const slots = new Set<Slot>();

  async function enter(entry: MutationEntry): Promise<Entered | NotEntered> {
    const w = entry.workspace;
    // Contract §9: the refusal comes before `started`, so no approval, lock, or Git process follows.
    if (gate?.blocked(w)) return { ok: false, code: "STATE_UNKNOWN" };
    if ([...slots].some((s) => sameIdentity(s.commonIdentity, w.commonIdentity))) return { ok: false, code: "BUSY" };
    const slot: Slot = { repositoryId: w.repositoryId, commonIdentity: w.commonIdentity, operationId: entry.operationId };
    slots.add(slot);
    // Contract §6: a reply without a marker ID holds no mutex and no marker, so the service sends `closeJob`, not `ended`.
    const refuse = (result: NotEntered): NotEntered => {
      slots.delete(slot);
      runner.closeJob(entry.operationId);
      return result;
    };
    let reply;
    try {
      reply = await runner.started({
        operationId: entry.operationId,
        repositoryId: w.repositoryId,
        kind: entry.kind,
        ...(entry.direction === undefined ? {} : { direction: entry.direction }),
        ...(entry.action === undefined ? {} : { action: entry.action }),
        worktreeRoot: w.worktreeRoot,
        commonDirectory: w.commonDirectory,
      });
    } catch (error) {
      if (error instanceof RunnerRefusal) return refuse({ ok: false, code: error.code });
      slots.delete(slot);
      throw error;
    }
    if ("stop" in reply) return refuse({ ok: false, code: "DEADLINE" });
    if ("busy" in reply) return refuse({ ok: false, code: "BUSY", remedy: { text: CROSS_INSTANCE_REMEDY } });
    if ("failure" in reply) return refuse({ ok: false, code: "RECOVERY_MARKER_FAILED", failure: reply.failure, folder: reply.folder, remedy: { text: MARKER_FAILED_REMEDY } });
    let ended = false;
    return {
      ok: true,
      markerId: reply.markerId,
      end(endProcesses: boolean): void {
        if (ended) return;
        ended = true;
        runner.ended(entry.operationId, endProcesses);
        gate?.settled(entry, reply.markerId);
        slots.delete(slot);
      },
    };
  }

  return {
    enter,
    // Contract §6 "Registration reuse and release" `unfinishedMutation`: a mutation of this workspace holds its slot.
    holds: (repositoryId: string): boolean => [...slots].some((s) => s.repositoryId === repositoryId),
    // The operation IDs that hold a slot of this common-directory identity.
    running: (commonIdentity: Workspace["commonIdentity"]): string[] => [...slots].filter((s) => sameIdentity(s.commonIdentity, commonIdentity)).map((s) => s.operationId),
  };
}

export type Exclusion = ReturnType<typeof createExclusion>;
