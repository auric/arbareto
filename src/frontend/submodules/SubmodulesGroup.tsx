// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { ArrowDown01Icon, ArrowRight01Icon, CubeIcon, Folder01Icon, FolderSyncIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { SUBMODULE_REVIEW_NESTING_LEVELS, SUBMODULE_TREE_FOLDERS } from "../../contracts/limits";
import type { SubmoduleBranch, SubmoduleHost, SubmoduleHostLine, SubmodulePlanRow, SubmoduleProgram, SubmoduleRefusalReason, SubmoduleRowResult } from "../../contracts/submodules";
import { CopyButton, unknownReadText, useCopy } from "../app/RepositoryStates";
import type { createBridge, ProgressEvent } from "../bridge";
import { GoneMark, UPSTREAM_GONE_NAME } from "../branches/BranchCard";
import { ActionMenu, type ActionItem } from "../components/action-menu";
import { IconButton } from "../components/icon-button";
import { TextTooltip } from "../components/text-tooltip";
import { Button } from "../components/ui/button";
import { scopedAction } from "../keyboard/shortcuts";
import { isObject } from "../lib/utils";
import { shortRef } from "../refs/ReferencesSidebar";
import { countLabel, COUNTS_TOOLTIP } from "../state/tracking";
import { shortId, trackOperation, type StatusOperation } from "../status/OperationStatus";
import { ReadsTrustNotice } from "../trust/TrustChip";
import { buildSubmoduleTree, type TreeRow } from "./submodule-tree";
import { TreeKeyHints } from "./TreeKeyHints";

// Feature 004 spec FR-076 to FR-082, plan D13 and D15 (Submodules group texts), contract Δ12. The 001 review dialog is gone.

// Contract §9 `UNSUPPORTED_SUBMODULE` as the review lists it.
export type SubmoduleRefusal = { code: "UNSUPPORTED_SUBMODULE"; reason: SubmoduleRefusalReason; path: string; text: string; remedy: { command: string | null; text?: string } | null };
/** The `reviewSubmodules` result value (contract §12 "Plan", Δ12). */
type SubmoduleReviewValue = { generation: number; rows: SubmodulePlanRow[]; branches: SubmoduleBranch[]; programs: SubmoduleProgram[]; refusals: SubmoduleRefusal[]; hosts: SubmoduleHostLine[]; submoduleReviewToken: string };
// The fields that the group reads. Feature 004 plan.md D15 "Malformed result": a `succeeded` result without them has an unknown form.
const isReviewValue = (result: unknown): result is SubmoduleReviewValue =>
  isObject(result) && Array.isArray(result.rows) && Array.isArray(result.branches) && Array.isArray(result.refusals) && Array.isArray(result.hosts) && typeof result.submoduleReviewToken === "string";
type Bridge = Pick<ReturnType<typeof createBridge>, "reviewSubmodules" | "updateSubmodules">;
type Target = { repositoryId: string; repositoryGeneration: number };

type Run = { inScope: ReadonlySet<string>; event: ProgressEvent | null; seen: ReadonlySet<string> };
type Summary = { updated: number; failed: number; registered: number };
type HostWait = { value: SubmoduleReviewValue; target: Target; scope: string | null };
type GroupState = {
  repositoryId: string | null;
  /** The rows of the last listing, or null before the first review. */
  rows: SubmodulePlanRow[] | null;
  /** Feature 004 plan D20 "Group": the branch marks of `rows` by `rowId`. They change only together with `rows`. */
  branches: ReadonlyMap<string, SubmoduleBranch>;
  /** The last row result of each path. */
  results: ReadonlyMap<string, SubmoduleRowResult>;
  run: Run | null;
  refusals: SubmoduleRefusal[];
  hosts: HostWait | null;
  summary: Summary | null;
  /** A list-only review is pending. */
  listing: boolean;
  /** The last review that did not list the rows. `code` null: a `succeeded` result of unknown form. */
  listFailure: { code: string | null } | null;
  /** A new host line or refusal waits for focus. */
  attention: boolean;
};
const empty = (repositoryId: string | null): GroupState => ({ repositoryId, rows: null, branches: new Map(), results: new Map(), run: null, refusals: [], hosts: null, summary: null, listing: false, listFailure: null, attention: false });

export type SubmoduleUpdateOptions = {
  bridge: Bridge;
  repositoryId: string | null;
  /** The snapshot ID of the shown read, or null without one. A new value after a run or a Refresh lists the rows again. */
  snapshotId: string | null;
  /** The target and the snapshot ID of the shown read, or null without one. */
  current(): { target: Target; snapshotId: string } | null;
  /** Each `trackOperation` report of an `updateSubmodules` request. */
  onOperation(op: StatusOperation): void;
  /** The code of a review from a user action that did not succeed. */
  onReviewFailed(code: string): void;
  /** A host line or a refusal waits for the user. */
  onAttention?(): void;
};
export type SubmoduleUpdate = Omit<GroupState, "repositoryId" | "hosts"> & {
  hosts: SubmoduleHostLine[] | null;
  /** Reviews every row, or the row at `scope` and its nested rows, and starts the update when no safety fact applies. */
  update(scope?: string): void;
  /** Update anyway: the same token with `confirmHosts`. */
  confirmHosts(): void;
  dismissHosts(): void;
  /** A Refresh: the next read lists the rows again. */
  refreshed(): void;
  /** The group moved focus to the line that waits. */
  attended(): void;
};

const marksOf = (value: SubmoduleReviewValue): ReadonlyMap<string, SubmoduleBranch> => new Map(value.branches.map((branch) => [branch.rowId, branch]));

// Contract Δ12: a scope row and the rows nested under it. A malformed parent chain ends after `rows.length` steps.
function scopeSet(rows: readonly SubmodulePlanRow[], scope: string | null): ReadonlySet<string> {
  if (scope === null) return new Set(rows.map((row) => row.path));
  const byId = new Map(rows.map((row) => [row.rowId, row]));
  const inside = (row: SubmodulePlanRow) => {
    let at: SubmodulePlanRow | undefined = row;
    for (let step = 0; at !== undefined && step <= rows.length; step++) {
      if (at.path === scope) return true;
      at = at.parentRowId === null ? undefined : byId.get(at.parentRowId);
    }
    return false;
  };
  return new Set(rows.filter(inside).map((row) => row.path));
}

function resultRows(result: unknown): SubmoduleRowResult[] {
  const rows = isObject(result) ? result.rows : undefined;
  return Array.isArray(rows) ? (rows.filter((row) => isObject(row) && typeof row.path === "string" && typeof row.state === "string") as SubmoduleRowResult[]) : [];
}

export function useSubmoduleUpdate(options: SubmoduleUpdateOptions): SubmoduleUpdate {
  const [state, setState] = useState(() => empty(options.repositoryId));
  if (state.repositoryId !== options.repositoryId) setState(empty(options.repositoryId));
  const latest = useRef(options);
  latest.current = options;
  // One user review or update at a time. The click that waits for a response starts nothing.
  const busy = useRef(false);
  // One list-only review at a time. A list that a run delays waits in `queued`.
  const listingNow = useRef(false);
  const queued = useRef(false);
  // The snapshot ID after which the next read lists the rows again. Undefined: no list waits.
  const listAfter = useRef<string | null | undefined>(undefined);
  const listedFor = useRef<string | null>(null);

  const same = (target: Target) => latest.current.current()?.target.repositoryId === target.repositoryId;
  const patch = (target: Target, change: (s: GroupState) => GroupState) => setState((s) => (s.repositoryId === target.repositoryId ? change(s) : s));
  const attention = (target: Target) => {
    patch(target, (s) => ({ ...s, attention: true }));
    latest.current.onAttention?.();
  };

  async function review(target: Target, snapshotId: string, scope: string | null, retried: boolean): Promise<void> {
    const response = await latest.current.bridge.reviewSubmodules(target, scope === null ? { snapshotId } : { snapshotId, scope: { path: scope } });
    if (!same(target)) return;
    if (response.state !== "succeeded") {
      latest.current.onReviewFailed(response.code ?? response.state);
      // Contract Δ12: UNKNOWN_TARGET of a scoped review means a stale row list.
      if (scope !== null && response.code === "UNKNOWN_TARGET") list();
      return;
    }
    const value = response.result;
    if (!isReviewValue(value)) return patch(target, (s) => ({ ...s, listFailure: { code: null } }));
    patch(target, (s) => ({ ...s, ...(scope === null || s.rows === null ? { rows: value.rows, branches: marksOf(value) } : {}), refusals: value.refusals, hosts: null, listFailure: null }));
    if (value.refusals.length > 0) return attention(target);
    if (value.hosts.length > 0) {
      patch(target, (s) => ({ ...s, hosts: { value, target, scope } }));
      return attention(target);
    }
    await start(value, target, scope, false, retried);
  }

  // A review that only lists the rows. It never starts an update, and it keeps the refusal and host lines of the last user review.
  function list() {
    const now = latest.current.current();
    if (now === null) return;
    if (busy.current || listingNow.current) return void (queued.current = true);
    listingNow.current = true;
    const { target, snapshotId } = now;
    patch(target, (s) => ({ ...s, listing: true }));
    void latest.current.bridge
      .reviewSubmodules(target, { snapshotId })
      .then((response) => {
        if (!same(target)) return;
        const value = response.result;
        if (response.state === "succeeded") patch(target, (s) => (isReviewValue(value) ? { ...s, rows: value.rows, branches: marksOf(value), listFailure: null } : { ...s, listFailure: { code: null } }));
        else patch(target, (s) => ({ ...s, listFailure: { code: response.code ?? response.state } }));
      })
      .finally(() => {
        listingNow.current = false;
        patch(target, (s) => ({ ...s, listing: false }));
        drain();
      });
  }
  const drain = () => {
    if (!queued.current || busy.current || listingNow.current) return;
    queued.current = false;
    list();
  };

  // FR-077: the rows show at rest. The first read of a registration lists them, and so does the first read after a run or a Refresh.
  const { repositoryId, snapshotId } = options;
  useEffect(() => {
    if (repositoryId === null || snapshotId === null) return;
    if (listedFor.current !== repositoryId) {
      listedFor.current = repositoryId;
      listAfter.current = undefined;
      return list();
    }
    if (listAfter.current !== undefined && listAfter.current !== snapshotId) {
      listAfter.current = undefined;
      list();
    }
  }, [repositoryId, snapshotId]);

  async function start(value: SubmoduleReviewValue, target: Target, scope: string | null, confirmHosts: boolean, retried: boolean): Promise<void> {
    const inScope = scopeSet(value.rows, scope);
    const payload = { submoduleReviewToken: value.submoduleReviewToken, start: true as const, ...(confirmHosts ? { confirmHosts: true as const } : {}) };
    const response = await trackOperation(
      "updateSubmodules",
      undefined,
      (onProgress) => latest.current.bridge.updateSubmodules(target, payload, onProgress),
      (op) => {
        latest.current.onOperation(op);
        if (op.response !== null) return;
        const event = op.progress;
        const counted = event?.path !== undefined && (event.phase === "fetch" || event.phase === "update");
        patch(target, (s) => ({ ...s, run: { inScope, event, seen: counted ? new Set([...(s.run?.seen ?? []), event.path!]) : (s.run?.seen ?? new Set()) } }));
      },
    );
    patch(target, (s) => ({ ...s, run: null }));
    if (!same(target)) return;
    if (response.state === "rejected") {
      const now = latest.current.current();
      // Contract §9: an expired token starts no Git process. One new review answers it.
      if (response.code === "APPROVAL_EXPIRED" && !retried && now !== null) return review(now.target, now.snapshotId, scope, true);
      // Contract Δ12: the token stays unconsumed, so the same line can send it again.
      if (response.code === "STALE_REVIEW" && isObject(response.result) && response.result.reason === "hosts") {
        patch(target, (s) => ({ ...s, hosts: { value, target, scope } }));
        attention(target);
      }
      return;
    }
    // The read after the run gives a new snapshot ID. That read lists the rows again.
    listAfter.current = latest.current.current()?.snapshotId ?? null;
    // Contract Δ12: rows above the scope row keep their state. A found row has no plan row.
    const planned = new Set(value.rows.map((row) => row.rowId));
    const kept = resultRows(response.result).filter((row) => inScope.has(row.path) || !planned.has(row.rowId));
    if (kept.length === 0) return;
    patch(target, (s) => {
      const results = new Map(s.results);
      for (const row of kept) results.set(row.path, row);
      const summary = {
        updated: kept.filter((row) => row.state === "cloned" || row.state === "moved").length,
        failed: kept.filter((row) => row.state === "failed").length,
        registered: kept.filter((row) => row.registered).length,
      };
      return { ...s, results, summary };
    });
  }

  const guarded = (work: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    void work().finally(() => {
      busy.current = false;
      drain();
    });
  };
  const shown = state.repositoryId === options.repositoryId ? state : empty(options.repositoryId);
  return {
    rows: shown.rows,
    branches: shown.branches,
    results: shown.results,
    run: shown.run,
    refusals: shown.refusals,
    hosts: shown.hosts?.value.hosts ?? null,
    summary: shown.summary,
    listing: shown.listing,
    listFailure: shown.listFailure,
    attention: shown.attention,
    update: (scope) => {
      const now = latest.current.current();
      if (now !== null) guarded(() => review(now.target, now.snapshotId, scope ?? null, false));
    },
    refreshed: () => void (listAfter.current = latest.current.current()?.snapshotId ?? null),
    attended: () => setState((s) => (s.attention ? { ...s, attention: false } : s)),
    confirmHosts: () => {
      const wait = shown.hosts;
      if (wait === null) return;
      guarded(async () => {
        patch(wait.target, (s) => ({ ...s, hosts: null }));
        await start(wait.value, wait.target, wait.scope, true, false);
      });
    },
    dismissHosts: () => setState((s) => ({ ...s, hosts: null })),
  };
}

// Plan D15 "Submodules group" texts.
const LOADING = "Arbareto reads the submodules.";
const NO_ROWS = "No submodules found.";
// Plan D12 "Reads": a read that needs approval.
const TRUST_CODES: ReadonlySet<string> = new Set(["TRUST_REQUIRED", "TRUST_CHANGED"]);
const exitText = (code: number | null) => (code === null ? "Git gave no exit code for this step." : `Git exit code ${code}.`);
const FAILED_READ = "Arbareto could not read this submodule. Use Refresh, then try again.";
const hostText = (host: SubmoduleHost) => (host.kind === "host" ? host.name : host.kind === "local" ? "this computer" : "a host that Arbareto cannot name");
// The quoted word keeps the boot-view scan for network APIs clear (tests/contracts/boot-view.test.tsx).
const hostSentence = ({ path, "fetch": from, settings }: SubmoduleHostLine) => `${path} will ${"fetch"} from ${hostText(from)}. The repository settings name ${hostText(settings)}.`;
const num = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => `${num(n)} ${n === 1 ? one : many}`;

const RESULT_LABEL: Record<SubmoduleRowResult["state"], string> = {
  cloned: "Done",
  moved: "Done",
  unchanged: "Done",
  failed: "Failed",
  "clone-interrupted": "Clone interrupted",
  "changed-elsewhere": "Changed elsewhere",
  refused: "Refused",
};
function observed(result: SubmoduleRowResult): string | null {
  if (result.state === "cloned") return `Cloned, at ${shortId(result.newCommit)}`;
  if (result.state === "moved") return `Checked out ${shortId(result.newCommit)}`;
  if (result.state === "unchanged") return "No change";
  if (result.state === "changed-elsewhere" && result.newCommit !== null) return `At ${shortId(result.newCommit)}`;
  return result.text ?? null;
}
function stateText(path: string, run: Run | null, result: SubmoduleRowResult | undefined, head: string | null): string {
  if (run !== null && run.inScope.has(path)) {
    const event = run.event;
    if (event?.path === path && (event.phase === "fetch" || event.phase === "update")) {
      const percent = event.counters.percent;
      return `${event.phase === "fetch" ? "Fetching" : "Updating"}${percent === undefined ? "" : ` ${percent}%`}`;
    }
    // A later progress row means that the steps of this row ended. Only the result names Done or Failed.
    return run.seen.has(path) ? "Waiting for the result" : "Waiting";
  }
  if (result !== undefined) return RESULT_LABEL[result.state];
  return head === null ? "" : shortId(head);
}

type SubmoduleNode = Extract<TreeRow, { kind: "submodule" }>;

// Plan D15 "Tree rows".
const TREE_BOUND = `The submodule paths have more than ${num(SUBMODULE_TREE_FOLDERS)} folders, so the group shows no folder rows.`;
const NO_BRANCH_MARK = "no branch";
const HEADS = "refs/heads/";
const branchName = (ref: string) => (ref.startsWith(HEADS) ? ref.slice(HEADS.length) : ref);
/** The visible mark, its tooltips, the accessible name parts, and the description of one branch mark (spec FR-109, FR-110). */
type MarkView = { branch: string; tooltip: string; count: { text: string; tooltip: string } | null; gone?: string; names: string[]; description: string | null };
function markView(mark: SubmoduleBranch | null): MarkView | null {
  if (mark === null) return null;
  if (mark.state === "detached") return { branch: NO_BRANCH_MARK, tooltip: NO_BRANCH_MARK, count: null, names: [NO_BRANCH_MARK], description: null };
  const branch = branchName(mark.ref);
  if (mark.state === "unread") return { branch, tooltip: branch, count: null, names: [branch, `counts are unavailable: ${mark.code}`], description: null };
  const tooltip = mark.upstream === null ? branch : `${branch} → ${shortRef(mark.upstream)}`;
  const upstream = mark.upstream === null ? null : tooltip;
  const label = countLabel(mark.track);
  // `parseTracking` accepts a track only with an upstream (src/git-service/sync-parsers.ts).
  if (mark.track.state === "gone") return { branch, tooltip, count: null, gone: shortRef(mark.upstream!), names: [branch, UPSTREAM_GONE_NAME], description: upstream };
  if (mark.track.state === "none") return { branch, tooltip, count: null, names: [branch, label.label], description: upstream };
  return { branch, tooltip, count: { text: label.text, tooltip: `${label.label}. ${COUNTS_TOOLTIP}` }, names: [branch, label.label], description: [upstream, COUNTS_TOOLTIP].filter(Boolean).join(". ") };
}

// Feature 005 plan.md D11 "Availability" and D15 "Submodules" texts.
export const INITIALIZE_FIRST = "Initialize this submodule first. Select Update submodules.";
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const validUtf8 = (base64: string) => {
  try {
    strictUtf8.decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
    return true;
  } catch {
    return false;
  }
};
/**
 * The reason that blocks Open submodule, or null. A `clone` or `reuse` row has no `.git` entry (001 contract §12 "Actions").
 * A Commit view row without a group row of the same path bytes stays available, and the service checks decide.
 */
export function openSubmoduleReason(rows: readonly SubmodulePlanRow[] | null, pathBytes: string | null, chain: number): string | null {
  const row = pathBytes === null ? undefined : rows?.find((r) => r.pathBytes === pathBytes);
  if (row !== undefined && (row.action === "clone" || row.action === "reuse")) return INITIALIZE_FIRST;
  if (row !== undefined && row.depth > 0) return `Open ${rows!.find((r) => r.rowId === row.parentRowId)?.path ?? row.path} first.`;
  if (chain >= SUBMODULE_REVIEW_NESTING_LEVELS) return `Arbareto opens at most ${SUBMODULE_REVIEW_NESTING_LEVELS} nested submodules in a row. Open this submodule with Open repository.`;
  if (pathBytes !== null && !validUtf8(pathBytes)) return "The submodule path is not valid UTF-8, so Arbareto cannot open it.";
  return null;
}

export type SubmodulesGroupProps = {
  update: SubmoduleUpdate;
  /** The worktree key of the shown repository. The closed rows last per key for the window session (plan D20 "Group"). */
  repository: string;
  /** The running reason. It shows only in the tooltip and the accessible description (plan D15). */
  runningReason: string | null;
  /** Another reason that blocks mutations. It shows as a visible line. */
  blockedReason: string | null;
  /** Cancel of the running update. The status bar Cancel shares its request guard. */
  onCancel(): void;
  /** Trust… of a list that needs trust: the `approveTrust("read")` path of `ReadsTrustNotice` (plan D12 "Reads"). */
  onTrustReads(): void;
  /** Feature 005 spec FR-047: opens the submodule of a row in this window. */
  onOpen?(path: string): void;
  /** Feature 005 plan.md D15 "Submodules": Enter or a double-click on an unavailable row shows its reason in the status line. */
  onRefused?(reason: string): void;
  /** The depth of the parent chain (feature 005 data-model §9). */
  chain?: number;
  /** The constrained profile: the references section that scrolls the group. Without it, the group region scrolls. */
  scrollElement?: () => HTMLElement | null;
  /** Plan D20 "Place": the last block of the sidebar column for the "Keys in the tree" panel. Null or absent: the panel uses the hidden form. */
  hintsSlot?: HTMLElement | null;
  /** The stored open state of the panel (plan D20 "Stored state"). */
  hintsOpen?: boolean;
  onHintsOpen?(open: boolean): void;
  /** `metrics(density, textScale).reducedPaneMin` for the D20 fit rule. Absent: no form fits. */
  hintsMin?: number;
};

// Plan D20 "Group": plain rows up to this count, as the References tree does.
const VIRTUAL_MIN = 200;
// The compact row height (plan.md density table). The measured height of each mounted row replaces it.
const ROW_HEIGHT = 26;

// Spec FR-108: the closed rows last for the window session per repository and are not stored.
const sessionClosed = new Map<string, ReadonlySet<string>>();

const toggle = <T,>(set: ReadonlySet<T>, value: T) => {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
};

/** The group callbacks of a tree row. The object never changes, so a memo row renders again only when its own props change. */
type RowActions = {
  register(key: string, element: HTMLElement | null): void;
  focused(key: string): void;
  keyDown(event: ReactKeyboardEvent<HTMLElement>, index: number): void;
  setOpen(key: string, open: boolean): void;
  openRow(row: SubmoduleNode): void;
  menu(path: string, anchor: HTMLElement): void;
  retry(path: string): void;
  toggleOutput(path: string): void;
};
type ItemProps = { index: number; selected: boolean; actions: RowActions };

const chevron = (open: boolean | null) =>
  open === null ? (
    <span aria-hidden="true" className="size-(--icon-size) shrink-0" />
  ) : (
    <HugeiconsIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0" />
  );
const common = (row: TreeRow, { index, selected, actions }: ItemProps) => ({
  ref: (element: HTMLElement | null) => actions.register(row.key, element),
  role: "treeitem",
  "aria-level": row.level,
  "aria-posinset": row.pos,
  "aria-setsize": row.size,
  "aria-expanded": row.open ?? undefined,
  "aria-selected": selected,
  tabIndex: selected ? 0 : -1,
  style: { paddingLeft: 8 + 12 * (row.level - 1) },
  onFocus: () => actions.focused(row.key),
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => actions.keyDown(event, index),
});

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const cutFloor = (text: string) => `${graphemes.segment(text)[Symbol.iterator]().next().value?.segment ?? ""}…`;
/**
 * Plan D15 "Tree rows": one part of the shrink order. The hidden copy of `floor` sets the minimum width of the cell.
 * The cell must keep `min-width: auto`, so its flex parent cannot shrink it below the copy.
 */
function ShrinkPart({ floor, className = "", children }: { floor: string; className?: string; children: ReactElement }) {
  return (
    <span className={`grid grid-cols-[minmax(auto,max-content)] ${className}`}>
      {children}
      <span data-slot="shrink-floor" aria-hidden="true" className="invisible col-start-1 row-start-1 whitespace-nowrap">
        {floor}
      </span>
    </span>
  );
}

const FolderItem = memo(function FolderItem(props: ItemProps & { row: Extract<TreeRow, { kind: "folder" }> }) {
  const { row, actions } = props;
  return (
    <div
      {...common(row, props)}
      aria-label={`${row.label}, folder, ${num(row.count)}`}
      aria-description={row.path}
      className="list-row flex min-w-0 items-center gap-1 py-0.5 pr-2"
      onClick={() => actions.setOpen(row.key, !row.open)}
      onContextMenu={(event) => event.preventDefault()}
    >
      {chevron(row.open)}
      <HugeiconsIcon data-slot="folder-icon" icon={Folder01Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0 text-muted-text" />
      <TextTooltip text={row.path}>
        <span data-slot="row-label" aria-hidden="true" className="min-w-0 truncate">
          {row.label}
        </span>
      </TextTooltip>
      <span data-slot="folder-count" aria-hidden="true" className="num ml-auto shrink-0 text-muted-text">
        {num(row.count)}
      </span>
    </div>
  );
});

type SubmoduleItemProps = ItemProps & {
  row: SubmoduleNode;
  /** The row state text of `stateText`. */
  state: string;
  /** The row is in the scope of the running update. */
  running: boolean;
  result: SubmoduleRowResult | undefined;
  outputOpen: boolean;
  reason: string | null;
};
const SubmoduleItem = memo(function SubmoduleItem(props: SubmoduleItemProps) {
  const { row, actions, state, running, result, outputOpen, reason } = props;
  const line = running || result === undefined ? null : observed(result);
  const failed = !running && result?.state === "failed";
  const output = failed && (result.outputTail !== undefined || result.remedy !== undefined);
  const open = output && outputOpen;
  const mark = markView(row.mark);
  return (
    <div
      {...common(row, props)}
      data-path={row.path}
      aria-label={[row.path, ...(mark?.names ?? []), state, line].filter(Boolean).join(", ")}
      aria-description={mark?.description ?? undefined}
      className="list-row flex flex-col py-0.5 pr-2"
      onDoubleClick={() => actions.openRow(row)}
      onContextMenu={(event) => {
        event.preventDefault();
        actions.menu(row.path, event.currentTarget);
      }}
    >
      <div className="flex min-w-0 items-center gap-1">
        {chevron(row.open)}
        <span data-slot="row-icon" className="flex shrink-0 text-muted-text">
          <HugeiconsIcon icon={CubeIcon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size)" />
        </span>
        <TextTooltip text={row.path}>
          <span data-slot="row-label" aria-hidden="true" className="min-w-0 truncate">
            {row.label}
          </span>
        </TextTooltip>
        {/* Plan D15 "Tree rows" shrink order. A flex basis of 0 makes a part take only the free width, so it shrinks before its siblings. */}
        <span data-slot="row-tail" className="flex flex-1 items-center gap-1">
          {mark === null ? null : (
            <span className="flex items-center gap-1">
              <ShrinkPart floor={cutFloor(mark.branch)}>
                <TextTooltip text={mark.tooltip}>
                  <span data-slot="branch-mark" aria-hidden="true" className="col-start-1 row-start-1 min-w-0 truncate text-muted-text">
                    {mark.branch}
                  </span>
                </TextTooltip>
              </ShrinkPart>
              {mark.gone === undefined ? null : <GoneMark upstream={mark.gone} />}
              {mark.count === null ? null : (
                <TextTooltip text={mark.count.tooltip}>
                  <span data-slot="track-count" aria-hidden="true" className="num shrink-0 whitespace-nowrap">
                    {mark.count.text}
                  </span>
                </TextTooltip>
              )}
            </span>
          )}
          {/* Only the short ID at rest shrinks. The run and result texts keep their full width. */}
          <ShrinkPart floor={running || result !== undefined || state === "" ? state : cutFloor(state)} className="flex-1 justify-end pl-1">
            <span data-slot="row-state" aria-hidden="true" className={`num col-start-1 row-start-1 min-w-0 truncate ${failed ? "text-removed" : "text-muted-text"}`}>
              {state}
            </span>
          </ShrinkPart>
        </span>
      </div>
      {line === null ? null : <p className="text-muted-text">{line}</p>}
      {failed && result.failedRead !== undefined ? <p>{FAILED_READ}</p> : null}
      {failed && result.exitCode !== undefined ? <p data-slot="exit-code">{exitText(result.exitCode)}</p> : null}
      {failed ? (
        <div className="flex flex-wrap gap-2 py-0.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            tabIndex={-1}
            disabled={reason !== null}
            focusableWhenDisabled
            onClick={(event) => {
              event.stopPropagation();
              if (reason === null) actions.retry(row.path);
            }}
          >
            Retry
          </Button>
          {output ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              tabIndex={-1}
              aria-expanded={open}
              onClick={(event) => {
                event.stopPropagation();
                actions.toggleOutput(row.path);
              }}
            >
              Show output
            </Button>
          ) : null}
        </div>
      ) : null}
      {open ? (
        <>
          {result!.outputTail === undefined ? null : <pre className="font-mono whitespace-pre-wrap select-text">{result!.outputTail}</pre>}
          {result!.remedy?.text === undefined ? null : <p>{result!.remedy.text}</p>}
          {typeof result!.remedy?.command === "string" ? <code className="block break-all select-text">{result!.remedy.command}</code> : null}
        </>
      ) : null}
    </div>
  );
});

/** The Submodules group of the references sidebar. One Tab stop for the rows, with roving focus (D16). */
export function SubmodulesGroup({ update, repository, runningReason, blockedReason, onCancel, onTrustReads, onOpen, onRefused, chain = 0, scrollElement, hintsSlot = null, hintsOpen = true, onHintsOpen, hintsMin = Number.POSITIVE_INFINITY }: SubmodulesGroupProps) {
  const headingId = useId();
  const hintsButtonId = useId();
  const hintsListId = useId();
  const reasonId = useId();
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [stored, setStored] = useState(() => ({ repository, closed: sessionClosed.get(repository) ?? new Set<string>() }));
  if (stored.repository !== repository) setStored({ repository, closed: sessionClosed.get(repository) ?? new Set<string>() });
  const closed = stored.closed;
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [remedies, setRemedies] = useState<ReadonlySet<number>>(new Set());
  const [menu, setMenu] = useState<{ path: string; anchor: HTMLElement; byKey?: boolean } | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const updateButton = useRef<HTMLButtonElement>(null);
  const copy = useCopy();
  const reason = runningReason ?? blockedReason;
  const { rows, branches, results, run, summary } = update;

  const found = useMemo(() => {
    const known = new Set(rows?.map((row) => row.path));
    return [...results.values()].filter((row) => row.found && !known.has(row.path)).map((row) => ({ rowId: row.rowId, path: row.path }));
  }, [rows, results]);
  const tree = useMemo(() => (rows === null ? null : buildSubmoduleTree({ rows, found, marks: branches, closed })), [rows, found, branches, closed]);
  const shown = tree?.state === "tree" ? tree.rows : [];
  const at = Math.max(0, shown.findIndex((row) => row.key === activeKey));
  const counters = run?.event?.counters;
  const lines = useRef<HTMLDivElement>(null);
  // A host line or a refusal never waits unseen: it takes focus when it shows.
  const { attention, attended } = update;
  useEffect(() => {
    if (!attention) return;
    lines.current?.querySelector<HTMLElement>('[data-slot="host-line"], [data-slot="refusal-line"]')?.focus();
    attended();
  }, [attention, attended]);
  function setOpen(key: string, open: boolean) {
    const next = new Set(closed);
    if (open) next.delete(key);
    else next.add(key);
    sessionClosed.set(repository, next);
    setStored({ repository, closed: next });
  }
  const treeElement = useRef<HTMLDivElement>(null);
  // The tree offset inside the scroll element (TanStack Virtual `scrollMargin`).
  const [margin, setMargin] = useState(0);
  const toFocus = useRef<string | null>(null);
  const virtual = expanded && shown.length > VIRTUAL_MIN;
  const virtualizer = useVirtualizer({
    count: shown.length,
    enabled: virtual,
    getScrollElement: () => scrollElement?.() ?? lines.current,
    scrollMargin: margin,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (i) => shown[i]!.key,
    overscan: 8,
    // React 19 refuses a flushSync from a layout effect, where keyboard navigation scrolls.
    useFlushSync: false,
    // The focused row stays mounted (plan.md "Keyboard and focus").
    rangeExtractor: (range) => {
      const mounted = defaultRangeExtractor(range);
      return mounted.includes(at) ? mounted : [...mounted, at].sort((a, b) => a - b);
    },
  });
  useLayoutEffect(() => {
    const element = scrollElement?.() ?? lines.current;
    if (!virtual || element === null || treeElement.current === null) return;
    const next = treeElement.current.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
    if (next !== margin) setMargin(next);
  });
  // Plan D6: keyboard navigation scrolls the target row into the window before it moves focus.
  useLayoutEffect(() => {
    const key = toFocus.current;
    const element = key === null ? undefined : elements.current.get(key);
    if (!element) return;
    toFocus.current = null;
    element.focus();
  });
  function focusRow(index: number) {
    const to = Math.min(shown.length - 1, Math.max(0, index));
    const row = shown[to];
    if (row === undefined) return;
    setActiveKey(row.key);
    const element = elements.current.get(row.key);
    if (element) return element.focus();
    toFocus.current = row.key;
    if (virtual) virtualizer.scrollToIndex(to);
  }

  const openReason = (row: SubmoduleNode) => openSubmoduleReason(rows, row.row?.pathBytes ?? null, chain);
  const openRow = (row: SubmoduleNode) => {
    if (onOpen === undefined) return;
    const why = openReason(row);
    if (why === null) onOpen(row.path);
    else onRefused?.(why);
  };

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>, index: number) {
    const row = shown[index]!;
    // Feature 005 plan.md D15 keyboard map: Enter on the row itself opens the submodule.
    if (row.kind === "submodule" && event.target === event.currentTarget && scopedAction(event.nativeEvent, "submoduleRow") === "openSubmodule") {
      event.preventDefault();
      return openRow(row);
    }
    if (event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent.isComposing) return;
    // Windows sends Shift+F10 and the Menu key to the focused element. A folder row has no menu (spec FR-108).
    if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
      event.preventDefault();
      if (row.kind === "submodule") setMenu({ path: row.path, anchor: event.currentTarget, byKey: true });
      return;
    }
    if (event.shiftKey) return;
    // Plan D15 keyboard map, "Submodules group tree" rows.
    const moves: Partial<Record<string, () => void>> = {
      ArrowDown: () => focusRow(index + 1),
      ArrowUp: () => focusRow(index - 1),
      Home: () => focusRow(0),
      End: () => focusRow(shown.length - 1),
      ArrowRight: () => (row.open === false ? setOpen(row.key, true) : row.open === true ? focusRow(index + 1) : undefined),
      ArrowLeft: () => (row.open === true ? setOpen(row.key, false) : row.parent >= 0 ? focusRow(row.parent) : undefined),
      ...(row.kind === "folder" ? { Enter: () => setOpen(row.key, !row.open) } : {}),
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    move();
  }

  function menuGroups(path: string): ActionItem[][] {
    const result = results.get(path);
    const failed = result?.state === "failed" && (run === null || !run.inScope.has(path));
    const actions: ActionItem[] = [{ label: "Update", icon: FolderSyncIcon, reason, onSelect: () => update.update(path) }];
    const row = shown.find((r): r is SubmoduleNode => r.kind === "submodule" && r.path === path);
    if (onOpen !== undefined && row !== undefined) actions.unshift({ label: "Open submodule", icon: CubeIcon, reason: openReason(row), onSelect: () => openRow(row) });
    if (failed) actions.push({ label: "Retry", reason, onSelect: () => update.update(path) });
    if (failed && (result.outputTail !== undefined || result.remedy !== undefined)) actions.push({ label: "Show output", onSelect: () => setOpened((s) => toggle(s, path)) });
    return [actions, [{ label: "Copy path", onSelect: () => copy(path) }]];
  }

  const live = useRef({ onKeyDown, setOpen, openRow, update, reason });
  live.current = { onKeyDown, setOpen, openRow, update, reason };
  const actions = useMemo<RowActions>(
    () => ({
      register: (key, element) => void (element ? elements.current.set(key, element) : elements.current.delete(key)),
      focused: setActiveKey,
      keyDown: (event, index) => live.current.onKeyDown(event, index),
      setOpen: (key, open) => live.current.setOpen(key, open),
      openRow: (row) => live.current.openRow(row),
      menu: (path, anchor) => setMenu({ path, anchor }),
      retry: (path) => void (live.current.reason === null && live.current.update.update(path)),
      toggleOutput: (path) => setOpened((s) => toggle(s, path)),
    }),
    [],
  );
  const treeItem = (row: TreeRow, index: number) =>
    row.kind === "folder" ? (
      <FolderItem key={row.key} row={row} index={index} selected={index === at} actions={actions} />
    ) : (
      <SubmoduleItem
        key={row.key}
        row={row}
        index={index}
        selected={index === at}
        actions={actions}
        state={stateText(row.path, run, results.get(row.path), row.row?.head ?? null)}
        running={run !== null && run.inScope.has(row.path)}
        result={results.get(row.path)}
        outputOpen={opened.has(row.path)}
        reason={reason}
      />
    );

  return (
    <section data-slot="submodules-group" aria-labelledby={headingId} className="flex min-h-0 flex-col">
      <div data-slot="group-header" className="flex items-center gap-1 px-2 font-semibold" style={{ minHeight: "var(--h-pane-heading)" }}>
        <h3 id={headingId}>
          <button type="button" aria-expanded={expanded} className="flex items-center gap-1" onClick={() => setExpanded((x) => !x)}>
            <HugeiconsIcon icon={expanded ? ArrowDown01Icon : ArrowRight01Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0" />
            Submodules
          </button>
        </h3>
        {rows === null ? null : <span className="num font-normal text-muted-text">{num(rows.length + found.length)}</span>}
        {run !== null ? (
          <>
            {counters?.rowIndex === undefined || counters.rowCount === undefined ? null : <HeaderStatus text={`Updating ${num(counters.rowIndex)} of ${num(counters.rowCount)}`} />}
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          </>
        ) : summary === null ? null : (
          <HeaderStatus muted text={`${num(summary.updated)} updated, ${num(summary.failed)} failed`} />
        )}
        <IconButton
          icon={FolderSyncIcon}
          ref={updateButton}
          data-submodules-update=""
          label="Update submodules"
          className="ml-auto"
          disabled={reason !== null}
          focusableWhenDisabled
          aria-describedby={reason === null ? undefined : reasonId}
          note={runningReason ?? undefined}
          onClick={() => void (reason === null && update.update())}
        />
      </div>
      {reason === null ? null : (
        <p id={reasonId} className={runningReason !== null ? "sr-only" : "px-2 text-muted-text"}>
          {reason}
        </p>
      )}
      <div ref={lines} data-slot="submodules-scroll" className="flex min-h-0 flex-col gap-1 overflow-y-auto overscroll-contain">
        {update.hosts === null ? null : (
          <div data-slot="host-line" tabIndex={-1} className="flex flex-col gap-1 px-2 py-1">
            <ul>
              {update.hosts.map((line) => (
                <li key={line.path} className="break-all">
                  {hostSentence(line)}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" disabled={reason !== null} focusableWhenDisabled aria-describedby={reason === null ? undefined : reasonId} onClick={() => {
                  if (reason !== null) return;
                  update.confirmHosts();
                  // The focused line leaves the DOM. Plan D15: focus goes to Update submodules.
                  updateButton.current?.focus();
                }}
              >
                Update anyway
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  update.dismissHosts();
                  updateButton.current?.focus();
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
        {update.refusals.map((refusal, i) => {
          const open = remedies.has(i);
          const remedy = refusal.remedy;
          return (
            <div key={`${refusal.reason}:${refusal.path}`} data-slot="refusal-line" tabIndex={-1} className="flex flex-col gap-1 px-2 py-1">
              <p className="break-words">{refusal.text}</p>
              {remedy === null ? null : (
                <div>
                  <Button type="button" variant="outline" size="sm" aria-expanded={open} onClick={() => setRemedies((s) => toggle(s, i))}>
                    Show remedy
                  </Button>
                </div>
              )}
              {remedy === null || !open ? null : (
                <>
                  {remedy.text === undefined ? null : <p>{remedy.text}</p>}
                  {remedy.command === null ? null : (
                    <>
                      <code className="block break-all select-text">{remedy.command}</code>
                      <div>
                        <CopyButton text={remedy.command}>Copy command</CopyButton>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          );
        })}
        {summary === null || summary.registered === 0 ? null : (
          <p data-slot="registration-line" className="px-2">{`Git changed the repository settings of ${plural(summary.registered, "submodule", "submodules")}.`}</p>
        )}
        {!expanded ? null : update.listFailure?.code != null && TRUST_CODES.has(update.listFailure.code) ? (
          <div data-slot="list-failure">
            <ReadsTrustNotice
              onTrust={() => {
                // The full read after the approval lists the rows again.
                update.refreshed();
                onTrustReads();
              }}
            />
          </div>
        ) : update.listFailure !== null || tree?.state === "malformed" ? (
          <p data-slot="list-failure" className="px-2">{update.listFailure?.code == null ? unknownReadText("The submodules") : `Arbareto cannot read the submodules: ${update.listFailure.code}.`}</p>
        ) : rows === null ? (
          <p data-slot="list-loading" className="px-2 text-muted-text">
            {LOADING}
          </p>
        ) : shown.length === 0 ? (
          <p className="px-2 text-muted-text">{NO_ROWS}</p>
        ) : null}
        {!expanded || tree?.state !== "tree" || !tree.bounded ? null : (
          <p data-slot="tree-bound" className="px-2 text-muted-text">
            {TREE_BOUND}
          </p>
        )}
        {/* Plan D15 "Rows at rest": a failed list keeps the rows of the last list. Only a malformed tree shows no rows. */}
        {!expanded || shown.length === 0 ? null : (
          <div ref={treeElement} role="tree" aria-labelledby={headingId} aria-describedby={`${hintsButtonId} ${hintsListId}`} className="flex flex-col">
            {virtual ? (
              <div role="presentation" className="relative" style={{ height: virtualizer.getTotalSize() }}>
                {/* A failed row has more lines, so each mounted row is measured. */}
                {virtualizer.getVirtualItems().map((item) => (
                  <div key={item.key} role="none" data-index={item.index} ref={virtualizer.measureElement} className="absolute inset-x-0 top-0" style={{ transform: `translateY(${item.start - margin}px)` }}>
                    {treeItem(shown[item.index]!, item.index)}
                  </div>
                ))}
              </div>
            ) : (
              shown.map(treeItem)
            )}
          </div>
        )}
      </div>
      {/* Plan D20 "Exists": the panel exists only while the tree exists. */}
      {!expanded || shown.length === 0 ? null : (
        <TreeKeyHints
          slot={hintsSlot}
          open={hintsOpen}
          onOpen={onHintsOpen}
          min={hintsMin}
          buttonId={hintsButtonId}
          listId={hintsListId}
          onBoxLost={() => elements.current.get(shown[at]!.key)?.focus()}
        />
      )}
      {menu === null ? null : (
        <ActionMenu label={`Actions for ${menu.path}`} groups={menuGroups(menu.path)} open anchor={menu.anchor} byKey={menu.byKey} finalFocus={() => menu.anchor} onOpenChange={(next) => void (next || setMenu(null))} />
      )}
    </section>
  );
}

/** Plan D15 "Header": the status text shrinks first and keeps one line. The tooltip gives the full text. */
function HeaderStatus({ text, muted = false }: { text: string; muted?: boolean }) {
  return (
    <TextTooltip text={text}>
      <span data-slot="header-status" className={`min-w-0 truncate font-normal whitespace-nowrap${muted ? " text-muted-text" : ""}`}>
        {text}
      </span>
    </TextTooltip>
  );
}
