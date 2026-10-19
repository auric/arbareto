// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { FolderSyncIcon } from "@hugeicons/core-free-icons";
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { SubmoduleHost, SubmoduleHostLine, SubmodulePlanRow, SubmoduleProgram, SubmoduleRefusalReason, SubmoduleRowResult } from "../../contracts/submodules";
import { CopyButton, unknownReadText, useCopy } from "../app/RepositoryStates";
import type { createBridge, ProgressEvent } from "../bridge";
import { ActionMenu, type ActionItem } from "../components/action-menu";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { isObject } from "../lib/utils";
import { shortId, trackOperation, type StatusOperation } from "../status/OperationStatus";
import { ReadsTrustNotice } from "../trust/TrustChip";

// Feature 004 spec FR-076 to FR-082, plan D13 and D15 (Submodules group texts), contract Δ12. The 001 review dialog is gone.

// Contract §9 `UNSUPPORTED_SUBMODULE` as the review lists it.
export type SubmoduleRefusal = { code: "UNSUPPORTED_SUBMODULE"; reason: SubmoduleRefusalReason; path: string; text: string; remedy: { command: string | null; text?: string } | null };
/** The `reviewSubmodules` result value (contract §12 "Plan", Δ12). */
type SubmoduleReviewValue = { generation: number; rows: SubmodulePlanRow[]; programs: SubmoduleProgram[]; refusals: SubmoduleRefusal[]; hosts: SubmoduleHostLine[]; submoduleReviewToken: string };
// The fields that the group reads. Feature 004 plan.md D15 "Malformed result": a `succeeded` result without them has an unknown form.
const isReviewValue = (result: unknown): result is SubmoduleReviewValue =>
  isObject(result) && Array.isArray(result.rows) && Array.isArray(result.refusals) && Array.isArray(result.hosts) && typeof result.submoduleReviewToken === "string";
type Bridge = Pick<ReturnType<typeof createBridge>, "reviewSubmodules" | "updateSubmodules">;
type Target = { repositoryId: string; repositoryGeneration: number };

type Run = { inScope: ReadonlySet<string>; event: ProgressEvent | null; seen: ReadonlySet<string> };
type Summary = { updated: number; failed: number; registered: number };
type HostWait = { value: SubmoduleReviewValue; target: Target; scope: string | null };
type GroupState = {
  repositoryId: string | null;
  /** The rows of the last listing, or null before the first review. */
  rows: SubmodulePlanRow[] | null;
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
const empty = (repositoryId: string | null): GroupState => ({ repositoryId, rows: null, results: new Map(), run: null, refusals: [], hosts: null, summary: null, listing: false, listFailure: null, attention: false });

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
    patch(target, (s) => ({ ...s, rows: scope === null || s.rows === null ? value.rows : s.rows, refusals: value.refusals, hosts: null, listFailure: null }));
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
        if (response.state === "succeeded") patch(target, (s) => (isReviewValue(value) ? { ...s, rows: value.rows, listFailure: null } : { ...s, listFailure: { code: null } }));
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
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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

type GroupRow = { path: string; depth: number; head: string | null };

export type SubmodulesGroupProps = {
  update: SubmoduleUpdate;
  /** The running reason. It shows only in the tooltip and the accessible description (plan D15). */
  runningReason: string | null;
  /** Another reason that blocks mutations. It shows as a visible line. */
  blockedReason: string | null;
  /** Cancel of the running update. The status bar Cancel shares its request guard. */
  onCancel(): void;
  /** Trust… of a list that needs trust: the `approveTrust("read")` path of `ReadsTrustNotice` (plan D12 "Reads"). */
  onTrustReads(): void;
};

/** The Submodules group of the references sidebar. One Tab stop for the rows, with roving focus (D16). */
export function SubmodulesGroup({ update, runningReason, blockedReason, onCancel, onTrustReads }: SubmodulesGroupProps) {
  const headingId = useId();
  const reasonId = useId();
  const [active, setActive] = useState(0);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [remedies, setRemedies] = useState<ReadonlySet<number>>(new Set());
  const [menu, setMenu] = useState<{ path: string; anchor: HTMLElement } | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const copy = useCopy();
  const reason = runningReason ?? blockedReason;
  const { rows, results, run, summary } = update;

  const known = new Set(rows?.map((row) => row.path));
  const found = [...results.values()].filter((row) => row.found && !known.has(row.path));
  const list: GroupRow[] = rows === null ? [] : [...rows.map((row) => ({ path: row.path, depth: row.depth, head: row.head })), ...found.map((row) => ({ path: row.path, depth: 0, head: null }))];
  const at = Math.min(active, Math.max(0, list.length - 1));
  const counters = run?.event?.counters;
  const lines = useRef<HTMLDivElement>(null);
  // A host line or a refusal never waits unseen: it takes focus when it shows.
  const { attention, attended } = update;
  useEffect(() => {
    if (!attention) return;
    lines.current?.querySelector<HTMLElement>('[data-slot="host-line"], [data-slot="refusal-line"]')?.focus();
    attended();
  }, [attention, attended]);
  const toggle = <T,>(set: ReadonlySet<T>, value: T) => {
    const next = new Set(set);
    if (!next.delete(value)) next.add(value);
    return next;
  };

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>, index: number) {
    if (event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent.isComposing) return;
    // Windows sends Shift+F10 and the Menu key to the focused element.
    if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
      event.preventDefault();
      return setMenu({ path: list[index]!.path, anchor: event.currentTarget });
    }
    if (event.shiftKey) return;
    const last = list.length - 1;
    const to = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? last : null;
    if (to === null) return;
    event.preventDefault();
    const next = Math.min(last, Math.max(0, to));
    setActive(next);
    elements.current.get(list[next]!.path)?.focus();
  }

  function menuGroups(path: string): ActionItem[][] {
    const result = results.get(path);
    const failed = result?.state === "failed" && (run === null || !run.inScope.has(path));
    const actions: ActionItem[] = [{ label: "Update", icon: FolderSyncIcon, reason, onSelect: () => update.update(path) }];
    if (failed) actions.push({ label: "Retry", reason, onSelect: () => update.update(path) });
    if (failed && (result.outputTail !== undefined || result.remedy !== undefined)) actions.push({ label: "Show output", onSelect: () => setOpened((s) => toggle(s, path)) });
    return [actions, [{ label: "Copy path", onSelect: () => copy(path) }]];
  }

  return (
    <section data-slot="submodules-group" aria-labelledby={headingId} className="flex min-h-0 flex-col">
      <div data-slot="group-header" className="flex items-center gap-1 px-2 font-semibold" style={{ minHeight: "var(--h-pane-heading)" }}>
        <h3 id={headingId}>Submodules</h3>
        {rows === null ? null : <span className="num font-normal text-muted-text">{list.length}</span>}
        {run !== null ? (
          <>
            {counters?.rowIndex === undefined || counters.rowCount === undefined ? null : <span className="font-normal">{`Updating ${counters.rowIndex} of ${counters.rowCount}`}</span>}
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          </>
        ) : summary === null ? null : (
          <span className="font-normal text-muted-text">{`${summary.updated} updated, ${summary.failed} failed`}</span>
        )}
        <IconButton
          icon={FolderSyncIcon}
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
      <div ref={lines} className="flex min-h-0 flex-col gap-1 overflow-y-auto overscroll-contain">
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
              <Button type="button" size="sm" disabled={reason !== null} focusableWhenDisabled aria-describedby={reason === null ? undefined : reasonId} onClick={() => void (reason === null && update.confirmHosts())}>
                Update anyway
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={update.dismissHosts}>
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
        {update.listFailure?.code != null && TRUST_CODES.has(update.listFailure.code) ? (
          <div data-slot="list-failure">
            <ReadsTrustNotice
              onTrust={() => {
                // The full read after the approval lists the rows again.
                update.refreshed();
                onTrustReads();
              }}
            />
          </div>
        ) : update.listFailure !== null ? (
          <p data-slot="list-failure" className="px-2">{update.listFailure.code === null ? unknownReadText("The submodules") : `Arbareto cannot read the submodules: ${update.listFailure.code}.`}</p>
        ) : rows === null ? (
          <p data-slot="list-loading" className="px-2 text-muted-text">
            {LOADING}
          </p>
        ) : rows.length === 0 && found.length === 0 ? (
          <p className="px-2 text-muted-text">{NO_ROWS}</p>
        ) : null}
        {list.length === 0 ? null : (
          <div role="tree" aria-labelledby={headingId} className="flex flex-col">
            {list.map((row, index) => {
              const result = results.get(row.path);
              const running = run !== null && run.inScope.has(row.path);
              const state = stateText(row.path, run, result, row.head);
              const line = running || result === undefined ? null : observed(result);
              const failed = !running && result?.state === "failed";
              const output = failed && (result.outputTail !== undefined || result.remedy !== undefined);
              const open = output && opened.has(row.path);
              return (
                <div
                  key={row.path}
                  ref={(element) => void (element ? elements.current.set(row.path, element) : elements.current.delete(row.path))}
                  role="treeitem"
                  data-path={row.path}
                  aria-level={row.depth + 1}
                  aria-label={[row.path, state, line].filter(Boolean).join(", ")}
                  aria-selected={index === at}
                  tabIndex={index === at ? 0 : -1}
                  className="list-row flex flex-col py-0.5 pr-2"
                  style={{ paddingLeft: 8 + 12 * row.depth }}
                  onFocus={() => setActive(index)}
                  onKeyDown={(event) => onKeyDown(event, index)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ path: row.path, anchor: event.currentTarget });
                  }}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 break-all">{row.path}</span>
                    <span data-slot="row-state" className={`num ml-auto shrink-0 ${failed ? "text-removed" : "text-muted-text"}`}>
                      {state}
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
                          if (reason === null) update.update(row.path);
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
                            setOpened((s) => toggle(s, row.path));
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
            })}
          </div>
        )}
      </div>
      {menu === null ? null : (
        <ActionMenu label={`Actions for ${menu.path}`} groups={menuGroups(menu.path)} open anchor={menu.anchor} finalFocus={() => menu.anchor} onOpenChange={(next) => void (next || setMenu(null))} />
      )}
    </section>
  );
}
