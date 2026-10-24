// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Type-only imports keep zod out of the renderer bundle.
import type { z } from "zod";
import type { IgnoreFile, PreviewIgnoreResult, ReadBranchesResult } from "../../contracts/envelope";
import type { BridgeResponse, createBridge } from "../bridge";
import type { Layout } from "../changes/file-tree";
import { RUNNING_REASON } from "../components/running-tooltip";
import { trackOperation, type StatusOperation } from "../status/OperationStatus";

// Feature 004 plan.md D15 "State" and "Views", data-model §1 and §14, contract Δ8.

export type View = "history" | "commit" | "settings";
type BranchList = Extract<z.infer<typeof ReadBranchesResult>, { entries: unknown }>;
export type BranchEntry = BranchList["entries"][number];
type Target = { repositoryId: string; repositoryGeneration: number };
/** The newest `readBranches` result of one repository generation. `code` is the response code or state of a failed read. Null `entries` with a null `code` is a `succeeded` read with a result of unknown form. */
export type Branches = { repositoryId: string; repositoryGeneration: number; entries: BranchEntry[] | null; code: string | null };
/** Contract Δ3 `reviewCommit` with `amend`: the HEAD commit and its message at the check, and the text that the editor shows while the box is checked. */
export type Amend = { headOid: string; message: string; text: string };
/** Data-model §14: the Commit view state of one worktree for the window session. */
export type CommitViewState = { layout: Layout; untrackedOpen: boolean; amend: Amend | null };
const COMMIT_VIEW: CommitViewState = { layout: "tree", untrackedOpen: false, amend: null };
/** Feature 005 data-model §9: one parent of the open submodule. `entryId` is the recent entry that was current before the open, or null. */
export type Parent = { entryId: string | null; name: string; path: string };
export type WorkbenchState = {
  /** Per worktree key: the shown view, the view that Settings returns to, and the Settings page that the view opens on. */
  views: Readonly<Record<string, { view: View; before: View; page?: string }>>;
  branches: Branches | null;
  commit: Readonly<Record<string, CommitViewState>>;
  /** Feature 005 data-model §9: the parent chain of the window session, at most 8 entries. */
  parents: readonly Parent[];
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
  let state: WorkbenchState = { views: {}, branches: null, commit: {}, parents: [] };
  const listeners = new Set<() => void>();
  const set = (next: Partial<WorkbenchState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  let branchSeq = 0;
  const shown = (key: string) => state.views[key] ?? { view: "history" as View, before: "history" as View };

  /** `page` names the Settings page to open on, such as "Editor and tools" (spec FR-093). Without it, Settings opens on its first page. */
  function setView(key: string, view: View, options: { page?: string } = {}) {
    const current = shown(key);
    if (current.view === view) return;
    set({ views: { ...state.views, [key]: { view, before: view === "settings" ? current.view : current.before, ...(options.page === undefined ? {} : { page: options.page }) } } });
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
      set({ branches: { ...t, entries, code: entries === null && response.state !== "succeeded" ? (response.code ?? response.state) : null } });
    });
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getState: () => state,
    view: (key: string) => shown(key).view,
    /** The Settings page of the last `setView`, or undefined. */
    settingsPage: (key: string) => shown(key).page,
    setView,
    /** Spec FR-068: Close returns to the view before Settings. */
    closeSettings(key: string) {
      if (shown(key).view === "settings") setView(key, shown(key).before);
    },
    readBranches,
    /** Feature 005 data-model §9 "Transitions": Open submodule pushes, Open parent repository pops, and every other open clears. */
    setParents: (parents: readonly Parent[]) => set({ parents }),
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

// ---- Feature 005 plan.md D8 to D10 and D15 "State": the ignore editor ----

export type IgnoreTarget = "gitignore" | "exclude";
type Loaded = Pick<IgnoreFile, "target" | "file" | "state" | "text" | "expected">;
type PreviewResult = Extract<z.infer<typeof PreviewIgnoreResult>, { preview: unknown }>["preview"];
/** `invalid`: the text fails `isWellFormed()` (plan D9). `trust`: the read gate refused (contract Δ7). */
export type IgnorePreview =
  | { state: "idle" }
  | { state: "updating" }
  | { state: "shown"; result: PreviewResult }
  | { state: "unavailable"; reason: string }
  | { state: "failed"; code: string }
  | { state: "trust" }
  | { state: "invalid" };
/** `refusal` names the open refusal reason, or `code:<code>` for a failed read. A programmatic selection takes a new `seq`. */
export type IgnoreEditorState = {
  target: IgnoreTarget;
  loaded: Loaded | null;
  refusal: string | null;
  text: string;
  selection: { start: number; end: number; seq: number };
  preview: IgnorePreview;
  stale: boolean;
  notice: string | null;
  saving: boolean;
};
export type IgnoreState = { editor: IgnoreEditorState | null; discard: { file: string; then: () => void } | null };

// Plan D15 "Ignore editor texts".
export const IGNORE_FILE: Record<IgnoreTarget, string> = { gitignore: ".gitignore", exclude: "info/exclude" };
export const SAVE_TEXTS = (target: IgnoreTarget): [string, string, string] => [`Save ${IGNORE_FILE[target]}`, `Saving ${IGNORE_FILE[target]}`, `Save ${IGNORE_FILE[target]} details`];
const SAVE_REFUSAL: Record<string, string> = {
  "ignore-size": "The text is larger than 1 MiB. Arbareto did not save it.",
  "ignore-nul": "The text holds a NUL character. Arbareto did not save it.",
};
// Contract Δ5 "Preview pause (renderer)".
const PREVIEW_PAUSE_MS = 400;

export type IgnoreEditorDeps = {
  bridge: Pick<ReturnType<typeof createBridge>, "readIgnoreFile" | "previewIgnore" | "reviewWorkbench" | "runWorkbench" | "cancel">;
  target(): Target | null;
  /** The snapshot ID of the shown `readWorkspace` read, or null. */
  snapshotId(): string | null;
  onOperation(op: StatusOperation): void;
  /** Contract Δ8: the reads after a `runWorkbench` outcome. */
  ended(response: BridgeResponse): void;
};

const encoder = new TextEncoder();
/** Contract Δ1: the editor text crosses as base64 of its UTF-8 bytes. */
function base64(text: string): string {
  const bytes = encoder.encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
const reasonOf = (response: BridgeResponse) => (response.result as { reason?: unknown } | undefined)?.reason;
/** Git dir.c `trim_trailing_spaces`: drops the trailing U+0020 run unless a backslash quotes it. A final lone backslash keeps the line. */
export function trimTrailingSpaces(line: string): string {
  let lastSpace = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === " ") {
      if (lastSpace < 0) lastSpace = i;
    } else if (c === "\\") {
      if (++i === line.length) return line;
      lastSpace = -1;
    } else lastSpace = -1;
  }
  return lastSpace < 0 ? line : line.slice(0, lastSpace);
}
const TRUST = new Set(["TRUST_REQUIRED", "TRUST_CHANGED"]);

/** One store per window: the docked ignore editor and its discard modal (spec FR-034 to FR-046). */
export function createIgnoreEditor(deps: IgnoreEditorDeps) {
  let state: IgnoreState = { editor: null, discard: null };
  const listeners = new Set<() => void>();
  const set = (next: Partial<IgnoreState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const patch = (next: Partial<IgnoreEditorState>) => void (state.editor !== null && set({ editor: { ...state.editor, ...next } }));
  let seq = 0;
  let readSeq = 0;
  // The 001 latest-wins rule of the preview: a new edit drops the running preview and cancels its operation.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: { operationId: string | null } | null = null;
  const stopPreview = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (running?.operationId) void deps.bridge.cancel({ operationId: running.operationId });
    running = null;
  };
  const dirty = () => state.editor?.loaded != null && state.editor.text !== state.editor.loaded.text;

  async function load(target: IgnoreTarget, line?: string) {
    stopPreview();
    const t = deps.target();
    const mine = ++readSeq;
    set({ editor: { target, loaded: null, refusal: null, text: "", selection: { start: 0, end: 0, seq: ++seq }, preview: { state: "idle" }, stale: false, notice: null, saving: false } });
    if (t === null) return;
    const response = await deps.bridge.readIgnoreFile(t, { target });
    if (mine !== readSeq || state.editor?.target !== target) return;
    const result = response.result as (Partial<IgnoreFile> & { reason?: unknown }) | undefined;
    if (response.state === "succeeded" && typeof result?.text === "string" && typeof result.file === "string" && result.expected !== undefined && result.state !== undefined) {
      const loaded = { target, file: result.file, state: result.state, text: result.text, expected: result.expected };
      patch({ loaded, text: loaded.text, selection: { start: loaded.text.length, end: loaded.text.length, seq: ++seq } });
      if (line !== undefined) addLine(line);
      return;
    }
    const reason = reasonOf(response);
    patch({ refusal: response.code === "WORKBENCH_UNAVAILABLE" && typeof reason === "string" ? reason : `code:${response.code ?? response.state}` });
  }

  /** Spec FR-034 and plan D8: a line of the text equal to `line` by Git's trailing-space rule adds nothing and is selected. Otherwise a LF first when the text does not end with one, then the line and LF. */
  function addLine(line: string) {
    const e = state.editor;
    if (e === null) return;
    for (let at = 0; at <= e.text.length; ) {
      const end = e.text.indexOf("\n", at);
      const stop = end < 0 ? e.text.length : end;
      if (trimTrailingSpaces(e.text.slice(at, stop)) === line) return patch({ selection: { start: at, end: stop, seq: ++seq } });
      if (end < 0) break;
      at = end + 1;
    }
    const base = e.text === "" || e.text.endsWith("\n") ? e.text : `${e.text}\n`;
    edit(`${base}${line}\n`, { start: base.length, end: base.length + line.length });
  }

  function edit(text: string, selection?: { start: number; end: number }) {
    const e = state.editor;
    if (e === null || e.loaded === null) return;
    stopPreview();
    const valid = text.isWellFormed();
    const preview: IgnorePreview = !valid ? { state: "invalid" } : e.preview.state === "invalid" ? { state: "idle" } : e.preview;
    patch({ text, preview, ...(selection === undefined ? {} : { selection: { ...selection, seq: ++seq } }) });
    if (valid) timer = setTimeout(() => void runPreview(), PREVIEW_PAUSE_MS);
  }

  async function runPreview() {
    timer = null;
    const e = state.editor;
    const t = deps.target();
    const snapshotId = deps.snapshotId();
    if (e === null || t === null || snapshotId === null) return;
    const mine = { operationId: null as string | null };
    running = mine;
    patch({ preview: { state: "updating" } });
    const response = await deps.bridge.previewIgnore(t, { target: e.target, text: base64(e.text), snapshotId }, (event) => void (mine.operationId = event.operationId));
    if (running !== mine) return;
    running = null;
    const result = response.result as { preview?: PreviewResult; unavailable?: { reason?: unknown } } | undefined;
    if (response.state === "succeeded" && result?.preview !== undefined) patch({ preview: { state: "shown", result: result.preview } });
    else if (response.state === "succeeded" && typeof result?.unavailable?.reason === "string") patch({ preview: { state: "unavailable", reason: result.unavailable.reason } });
    else if (TRUST.has(response.code ?? "")) patch({ preview: { state: "trust" } });
    else patch({ preview: { state: "failed", code: response.code ?? response.state } });
  }

  /** Spec FR-044: unsaved text asks "Discard changes to <file>?" before `then`. */
  function guard(then: () => void) {
    const e = state.editor;
    if (e === null || !dirty()) return then();
    set({ discard: { file: IGNORE_FILE[e.target], then } });
  }

  function refused(response: BridgeResponse) {
    const reason = reasonOf(response);
    if (response.code === "STALE_REVIEW" && reason === "ignore-changed") return patch({ saving: false, stale: true });
    const known = response.code === "WORKBENCH_UNAVAILABLE" && typeof reason === "string" ? SAVE_REFUSAL[reason] : undefined;
    patch({ saving: false, notice: known ?? (response.code === "BUSY" ? RUNNING_REASON : `Save did not complete: ${response.code ?? response.state}.`) });
  }

  async function save() {
    const e = state.editor;
    const t = deps.target();
    if (e === null || e.loaded === null || e.saving || t === null || !e.text.isWellFormed()) return;
    const text = e.text;
    patch({ saving: true, notice: null, stale: false });
    const review = await deps.bridge.reviewWorkbench(t, { action: "ignore-save", target: e.target, text: base64(text), expected: e.loaded.expected });
    const reviewed = (review.result ?? {}) as { action?: unknown; workbenchToken?: unknown; plan?: { size: number; sha256: string } };
    const token = reviewed.workbenchToken;
    const plan = reviewed.plan;
    if (review.state !== "succeeded" || reviewed.action !== "ignore-save" || typeof token !== "string" || plan === undefined) return refused(review);
    const texts = SAVE_TEXTS(e.target);
    const report = (op: StatusOperation) => deps.onOperation({ ...op, texts, ...(op.response?.state === "succeeded" ? { outcome: `Saved ${IGNORE_FILE[e.target]}.` } : {}) });
    const response = await trackOperation("runWorkbench", undefined, (onProgress) => deps.bridge.runWorkbench({ repositoryId: t.repositoryId }, { workbenchToken: token, start: true }, onProgress), report);
    deps.ended(response);
    const now = state.editor;
    if (now === null || now.target !== e.target || now.loaded === null) return;
    const outcome = (response.result as { outcome?: unknown } | undefined)?.outcome;
    if (response.state === "succeeded") return patch({ saving: false, loaded: { ...now.loaded, state: "file", text, expected: { size: plan.size, sha256: plan.sha256 } } });
    if (outcome === "stale") return patch({ saving: false, stale: true });
    refused(response);
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getState: () => state,
    /** A row item or a Repository menu item. A row action for the open file adds its line; another file asks first (spec FR-044). */
    open(target: IgnoreTarget, line?: string) {
      const e = state.editor;
      if (e !== null && e.target === target && e.loaded !== null) return void (line === undefined || addLine(line));
      guard(() => void load(target, line));
    },
    edit: (text: string) => edit(text),
    guard,
    keepEditing: () => set({ discard: null }),
    discard() {
      const then = state.discard?.then;
      set({ discard: null, editor: state.editor === null || state.editor.loaded === null ? state.editor : { ...state.editor, text: state.editor.loaded.text } });
      then?.();
    },
    close: () =>
      guard(() => {
        stopPreview();
        readSeq++;
        set({ editor: null });
      }),
    /** Plan D15 "Stale save": Reload asks first with unsaved text. */
    reload: () => guard(() => void (state.editor === null ? undefined : load(state.editor.target))),
    save: () => void save(),
    /** Another repository closes the editor without a question. */
    reset() {
      stopPreview();
      readSeq++;
      set({ editor: null, discard: null });
    },
  };
}
export type IgnoreEditor = ReturnType<typeof createIgnoreEditor>;
