// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { TerminalState } from "../../contracts/errors";
import type { DraftStore } from "./draft-store";

// plan.md "Stored drafts" and the commit submission rules; data-model §2 "Stored draft". Drafts live in renderer memory, keyed by `worktreeKey`.
// A service restart does not touch them, because the page does not reload (contract §2).

export const SAVE_FAILURE = "The draft could not be saved. It stays until Arbareto closes.";

export type Draft = Readonly<{ text: string; revision: number }>;
/** Binds a commit submission in renderer memory. It never enters the commit payload. */
export type Submission = Readonly<{ worktreeKey: string; draftRevision: number; text: string }>;

export function createDrafts(store: DraftStore) {
  const drafts = new Map<string, Draft>();
  // Revisions outlive a cleared draft, so a later draft never reuses a submitted revision.
  const revisions = new Map<string, number>();
  const failures = new Set<string>();
  // Only the result of the latest store call for a key sets its failure state.
  const latest = new Map<string, number>();
  const listeners = new Set<() => void>();
  let calls = 0;

  const notify = () => {
    for (const listener of listeners) listener();
  };
  const begin = (key: string) => {
    latest.set(key, ++calls);
    return calls;
  };
  const report = (key: string, call: number, failed: boolean) => {
    if (latest.get(key) !== call || failures.has(key) === failed) return;
    if (failed) failures.add(key);
    else failures.delete(key);
    notify();
  };
  const forget = (key: string) => {
    drafts.delete(key);
    failures.delete(key);
    begin(key);
    notify();
  };

  return {
    draft(worktreeKey: string): Draft | null {
      return drafts.get(worktreeKey) ?? null;
    },
    /** The plan.md save-failure text while the stored copy of this draft is not current. */
    failure(worktreeKey: string): string | null {
      return failures.has(worktreeKey) ? SAVE_FAILURE : null;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async change(worktreeKey: string, text: string): Promise<void> {
      const revision = (revisions.get(worktreeKey) ?? 0) + 1;
      revisions.set(worktreeKey, revision);
      drafts.set(worktreeKey, { text, revision });
      const call = begin(worktreeKey);
      notify();
      report(worktreeKey, call, (await store.write(worktreeKey, text, revision)) !== "saved");
    },
    submit(worktreeKey: string): Submission | null {
      const draft = drafts.get(worktreeKey);
      return draft ? Object.freeze({ worktreeKey, draftRevision: draft.revision, text: draft.text }) : null;
    },
    /** Only a reconciled `succeeded` clears, and only the unchanged submitted draft. Every other state keeps the draft. */
    async complete(submission: Submission, state: TerminalState): Promise<void> {
      if (state !== "succeeded") return;
      if (drafts.get(submission.worktreeKey)?.revision === submission.draftRevision) forget(submission.worktreeKey);
      await store.remove(submission.worktreeKey, submission.draftRevision);
    },
    /** Clear message: the explicit user action. */
    async clear(worktreeKey: string): Promise<void> {
      forget(worktreeKey);
      await store.remove(worktreeKey);
    },
    /** Runs after each `restoreWorkspace` or registration result. A memory draft that already exists wins. */
    async restore(worktreeKey: string): Promise<void> {
      // A read must not drop the result of a write that started before it.
      const call = latest.get(worktreeKey) ?? begin(worktreeKey);
      const record = await store.read(worktreeKey);
      if (record === "failed") return report(worktreeKey, call, true);
      if (record === null || drafts.has(worktreeKey)) return;
      drafts.set(worktreeKey, { text: record.message, revision: record.draftRevision });
      revisions.set(worktreeKey, Math.max(revisions.get(worktreeKey) ?? 0, record.draftRevision));
      notify();
    },
  };
}
