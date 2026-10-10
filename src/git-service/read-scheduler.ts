// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract §5 "Concurrent reads", "Pending reads", and "Ordinary read deadline", and the read rows of data-model §7.
// `readEntries` never comes here: it takes no read slot and never waits (contract §5).

import { CONCURRENT_READS_GLOBAL, CONCURRENT_READS_PER_WORKSPACE, PENDING_READS_GLOBAL, READ_DEADLINE_MS, RECONCILIATION_TARGET_MS } from "../contracts/limits";

export interface RereadTarget {
  operationId: string;
  signal: AbortSignal;
}

// `reread` holds the re-read result after a failed outcome. It is null when no re-read result exists.
export type ReadEnd<O, S> = { kind: "outcome"; outcome: O; reread: S | null } | { kind: "canceled" } | { kind: "deadline" };

export interface ReadJob<O, S> {
  operationId: string;
  repositoryId: string;
  // The registry signal of the operation. Only `cancel` aborts it.
  signal: AbortSignal;
  // A superseding read: a new read with the same key in the same workspace cancels each unfinished one (contract §5 "Pending reads").
  // `readComparison` and `readRefs` use their operation names as keys.
  selection?: string;
  // The read work under `operationId`. It never rejects.
  run(signal: AbortSignal): Promise<O>;
  // True for an outcome that ends the read `failed`.
  failed(outcome: O): boolean;
  // Re-reads the relevant state in its own operation Job (data-model §7). It never rejects.
  reread(target: RereadTarget): Promise<S>;
  // Called once. A read that took a slot calls it before the slot is released.
  end(end: ReadEnd<O, S>): void;
}

export interface ReadSchedulerOptions {
  closeJob(operationId: string): void;
  // Cancels an issued operation as `cancel` does.
  cancel(operationId: string): void;
  // Test seam. Production keeps the contract §5 value.
  readDeadlineMs?: number;
}

type Job = ReadJob<unknown, unknown>;

// `end` reports the terminal result. A throw there has no other report path, so it must not stop the slot release.
function report(job: Job, end: ReadEnd<unknown, unknown>): void {
  try {
    job.end(end);
  } catch {
    // `respond` sends OUTPUT_LIMIT for a response above the frame bound (contract §2). Another throw is a failed pipe write, which no response can reach.
  }
}

export function createReadScheduler({ closeJob, cancel, readDeadlineMs = READ_DEADLINE_MS }: ReadSchedulerOptions) {
  // The waiting reads in arrival order, each with its abort listener.
  const pending = new Map<Job, () => void>();
  const running = new Set<Job>();
  const perWorkspace = new Map<string, number>();
  // The release step of each running read. After it, the read ends `canceled` without a re-read.
  const releases = new Map<Job, () => void>();

  const hasSlot = (repositoryId: string) => running.size < CONCURRENT_READS_GLOBAL && (perWorkspace.get(repositoryId) ?? 0) < CONCURRENT_READS_PER_WORKSPACE;

  // Admits the waiting reads in arrival order. A read of a workspace at its cap lets later reads of other workspaces pass.
  function pump(): void {
    for (const [job, leave] of pending) {
      if (!hasSlot(job.repositoryId)) continue;
      pending.delete(job);
      job.signal.removeEventListener("abort", leave);
      admit(job);
    }
  }

  // The read deadline starts when the read takes its slot.
  function admit(job: Job): void {
    running.add(job);
    perWorkspace.set(job.repositoryId, (perWorkspace.get(job.repositoryId) ?? 0) + 1);
    const work = new AbortController();
    const stopWork = () => work.abort();
    job.signal.addEventListener("abort", stopWork, { once: true });
    let ended = false;
    let expired = false;
    let released = false;
    let current: { operationId: string; controller: AbortController } | null = null;

    const stopReread = () => {
      if (current === null) return;
      current.controller.abort();
      closeJob(current.operationId);
    };
    releases.set(job, () => {
      released = true;
      stopReread();
    });

    const finish = (end: ReadEnd<unknown, unknown>) => {
      if (ended) return;
      ended = true;
      clearTimeout(deadline);
      releases.delete(job);
      job.signal.removeEventListener("abort", stopWork);
      report(job, end);
      running.delete(job);
      perWorkspace.set(job.repositoryId, perWorkspace.get(job.repositoryId)! - 1);
      if (perWorkspace.get(job.repositoryId) === 0) perWorkspace.delete(job.repositoryId);
      pump();
    };

    // Data-model §7: the re-read after a cancel, a failure, or the deadline. Contract §5 "Cancellation/reconciliation target" bounds each one.
    // Null when the target or `stopReread` ended the re-read first.
    const reread = async (): Promise<unknown> => {
      const mine = { operationId: crypto.randomUUID(), controller: new AbortController() };
      current = mine;
      let target: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((resolve) => {
        target = setTimeout(() => {
          mine.controller.abort();
          resolve(null);
        }, RECONCILIATION_TARGET_MS);
      });
      try {
        const value = await Promise.race([job.reread({ operationId: mine.operationId, signal: mine.controller.signal }), late]);
        return mine.controller.signal.aborted ? null : value;
      } finally {
        clearTimeout(target);
        if (current === mine) current = null;
        closeJob(mine.operationId);
      }
    };

    // Data-model §7: close the operation Job, re-read the relevant state, then end `failed` with DEADLINE.
    const deadline = setTimeout(() => {
      if (ended) return;
      expired = true;
      work.abort();
      closeJob(job.operationId);
      stopReread();
      if (released) return finish({ kind: "canceled" });
      void reread().then(() => finish({ kind: "deadline" }));
    }, readDeadlineMs);

    void (async () => {
      const outcome = await job.run(work.signal);
      if (expired) return;
      // Data-model §7 `cancel-requested` (read): after the owned processes stop, re-read the relevant state. A released workspace has no state to re-read.
      if (job.signal.aborted) {
        if (!released) await reread();
        if (!expired) finish({ kind: "canceled" });
        return;
      }
      if (!job.failed(outcome)) return finish({ kind: "outcome", outcome, reread: null });
      const value = await reread();
      if (expired) return;
      finish(job.signal.aborted ? { kind: "canceled" } : { kind: "outcome", outcome, reread: value });
    })();
  }

  return {
    // Contract §5 "Pending reads": false when the read can neither start nor wait.
    accepts(repositoryId: string): boolean {
      return hasSlot(repositoryId) || pending.size < PENDING_READS_GLOBAL;
    },

    schedule<O, S>(job: ReadJob<O, S>): void {
      if (job.selection !== undefined) {
        for (const other of [...running, ...pending.keys()]) {
          if (other.selection === job.selection && other.repositoryId === job.repositoryId && !other.signal.aborted) cancel(other.operationId);
        }
      }
      // A canceled read that still waits leaves the queue at once and ends `canceled` without a re-read. The microtask lets `cancel` answer first.
      const leave = () => {
        if (pending.delete(job as Job)) queueMicrotask(() => report(job as Job, { kind: "canceled" }));
      };
      pending.set(job as Job, leave);
      job.signal.addEventListener("abort", leave, { once: true });
      pump();
    },

    // Contract §6 "Registration reuse and release": a release cancels every unfinished read of the workspace. None of them re-reads.
    release(repositoryId: string): void {
      for (const job of [...running, ...pending.keys()]) {
        if (job.repositoryId !== repositoryId) continue;
        releases.get(job)?.();
        cancel(job.operationId);
      }
    },
  };
}

export type ReadScheduler = ReturnType<typeof createReadScheduler>;
