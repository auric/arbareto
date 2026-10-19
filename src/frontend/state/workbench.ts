// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Type-only imports keep zod out of the renderer bundle.
import type { z } from "zod";
import type { ReadBranchesResult } from "../../contracts/envelope";
import type { BridgeResponse, createBridge } from "../bridge";
import type { Layout } from "../changes/file-tree";

// Feature 004 plan.md D15 "State" and "Views", data-model §1 and §14, contract Δ8.

export type View = "history" | "commit" | "settings";
type BranchList = Extract<z.infer<typeof ReadBranchesResult>, { entries: unknown }>;
export type BranchEntry = BranchList["entries"][number];
type Target = { repositoryId: string; repositoryGeneration: number };
/** The newest `readBranches` result of one repository generation. `code` is the response code or state of a failed read. */
export type Branches = { repositoryId: string; repositoryGeneration: number; entries: BranchEntry[] | null; code: string | null };
/** Contract Δ3 `reviewCommit` with `amend`: the HEAD commit and its message at the check, and the text that the editor shows while the box is checked. */
export type Amend = { headOid: string; message: string; text: string };
/** Data-model §14: the Commit view state of one worktree for the window session. */
export type CommitViewState = { layout: Layout; untrackedOpen: boolean; amend: Amend | null };
const COMMIT_VIEW: CommitViewState = { layout: "tree", untrackedOpen: false, amend: null };
export type WorkbenchState = {
  /** Per worktree key: the shown view, and the view that Settings returns to. */
  views: Readonly<Record<string, { view: View; before: View }>>;
  branches: Branches | null;
  commit: Readonly<Record<string, CommitViewState>>;
};

export type WorkbenchDeps = {
  bridge: Pick<ReturnType<typeof createBridge>, "readBranches">;
  /** The repository and its newest generation, or null. */
  target(): Target | null;
  /** The 001 reconcile read after a mutation outcome (`Requests.mutationEnded`). It also starts `readRefs`. */
  mutationEnded(operation: string, response: BridgeResponse): Promise<void>;
  /** Opens a new 002 view. The view keeps the selected commit by its OID. */
  refreshHistory(): void;
};

/** One store per window. It holds the renderer state of feature 004 by the 001 latest-wins and generation rules. */
export function createWorkbench({ bridge, target, mutationEnded, refreshHistory }: WorkbenchDeps) {
  let state: WorkbenchState = { views: {}, branches: null, commit: {} };
  const listeners = new Set<() => void>();
  const set = (next: Partial<WorkbenchState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  let branchSeq = 0;
  const shown = (key: string) => state.views[key] ?? { view: "history" as View, before: "history" as View };

  function setView(key: string, view: View) {
    const current = shown(key);
    if (current.view === view) return;
    set({ views: { ...state.views, [key]: { view, before: view === "settings" ? current.view : current.before } } });
  }

  function readBranches() {
    const t = target();
    if (t === null) return;
    const seq = ++branchSeq;
    void bridge.readBranches(t).then((response) => {
      const now = target();
      // Latest wins, and a response of an older generation or another repository is dropped.
      if (seq !== branchSeq || now === null || now.repositoryId !== t.repositoryId || now.repositoryGeneration !== t.repositoryGeneration) return;
      const result = response.result as Partial<BranchList> | undefined;
      const entries = response.state === "succeeded" && Array.isArray(result?.entries) ? result.entries : null;
      set({ branches: { ...t, entries, code: entries === null ? (response.code ?? response.state) : null } });
    });
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getState: () => state,
    view: (key: string) => shown(key).view,
    setView,
    /** Spec FR-068: Close returns to the view before Settings. */
    closeSettings(key: string) {
      if (shown(key).view === "settings") setView(key, shown(key).before);
    },
    readBranches,
    commitView: (key: string): CommitViewState => state.commit[key] ?? COMMIT_VIEW,
    setCommitView(key: string, patch: Partial<CommitViewState>) {
      set({ commit: { ...state.commit, [key]: { ...(state.commit[key] ?? COMMIT_VIEW), ...patch } } });
    },
    /** Contract Δ8: the reads after a `runWorkbench` or `applyFiles` outcome. The new view shows no refs-changed notice (002 FR-005 change). */
    ended(operation: "runWorkbench" | "applyFiles", response: BridgeResponse) {
      refreshHistory();
      void mutationEnded(operation, response);
      readBranches();
    },
  };
}

export type Workbench = ReturnType<typeof createWorkbench>;
