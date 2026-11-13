// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ChangeEntry, RequestOf, SubmoduleChange, SubmoduleWork } from "../../contracts/envelope";
import type { BridgeResponse, OnProgress } from "../bridge";
import { TextTooltip } from "../components/text-tooltip";
import { Button } from "../components/ui/button";
import { INITIALIZE_FIRST } from "../submodules/SubmodulesGroup";
import { NOT_LOCATED_TEXT } from "./limitation-text";

// Feature 005 plan.md D19 (Layout, Keyboard, Texts), spec FR-069 to FR-076, data-model §15 and §16, contract Δ3 `readSubmoduleChange` and `readSubmoduleWork`.

export type SubmoduleSource = RequestOf<"readSubmoduleChange">["payload"]["source"];
type WorkEntry = SubmoduleWork["entries"][number];

/** The reads and the open of the preview. The Workbench binds them to the open repository. */
export type SubmoduleReader = {
  read(source: SubmoduleSource, onProgress: OnProgress): Promise<BridgeResponse>;
  cancel(operationId: string): void;
  open(path: string): void;
  /** Feature 005 plan.md D11 "Availability" of Open submodule, or null. */
  reason(pathBytes: string): string | null;
};
type WorkRow = { entry: WorkEntry; extra: SubmoduleWork["extraRows"][number] | null; snapshotId: string };
/**
 * The `readSubmoduleWork` pages of the open repository (plan D19 "Page cycle", "Rows across snapshots").
 * `snapshotId`: the snapshot of the newest cycle. `more`: that cycle has not ended. `rows`: the newest entry of each path.
 * `work`: the rows as one result, or null after a failed page with the code `failure`.
 */
export type WorkRead = { snapshotId: string; more: boolean; rows: ReadonlyMap<string, WorkRow>; work: SubmoduleWork | null; failure: string };
/** A `readSubmoduleChange` read: "pending", or its response. */
export type ChangeRead = "pending" | BridgeResponse;

export const PENDING_TEXT = "Arbareto reads the Git facts.";
export const MISSING_TEXT = "Fetch the submodule first.";
export const NESTED_TEXT = "The .gitmodules file does not name this repository.";
export const PROGRAMS_TEXT = "Arbareto does not read the working tree of this submodule. Its settings name a program that a status read can run.";
export const WORK_LIMIT_TEXT = "Arbareto checks at most 256 submodules for local edits.";
export const NO_EDITS = "No local edits.";
export const LOCAL_EDITS_TOOLTIP = "The submodule has local edits. Its commit is unchanged.";
export const STAGE_UNCHANGED = "The submodule commit is unchanged. Commit the local edits inside the submodule first.";

const count = new Intl.NumberFormat("en-US");
// 001 plan.md "History graph design": a short ID is the first 12 hex digits.
const shortId = (oid: string) => oid.slice(0, 12);
const commitsText = (n: number, word: "new" | "removed") => `${count.format(n)} ${word} ${n === 1 ? "commit" : "commits"}`;

/** Plan D19 Change row: "<n> new commits", "<n> removed commits", or both. Null when neither side has a commit. */
export function changeText(change: SubmoduleChange): string | null {
  if (change.state.state !== "commits") return null;
  const parts = [change.state.added > 0 ? commitsText(change.state.added, "new") : null, change.state.removed > 0 ? commitsText(change.state.removed, "removed") : null].filter((p) => p !== null);
  return parts.length === 0 ? null : parts.join(", ");
}

/** The change of a succeeded read, else null. A `{reason}` refusal and a failure carry no change. */
export function changeOf(read: ChangeRead | null): SubmoduleChange | null {
  if (read === null || read === "pending" || read.state !== "succeeded") return null;
  const result = read.result as Partial<SubmoduleChange> | undefined;
  return result?.state === undefined ? null : (result as SubmoduleChange);
}

/** The shown rows and marks, else null. Plan D19 "Rows across snapshots": an older entry stays until a page of a newer cycle replaces it or that cycle ends. */
export function workOf(read: WorkRead | null): SubmoduleWork | null {
  return read?.work ?? null;
}

/** A succeeded page of `snapshotId`, else null. Contract Δ3 "Pages": `next` is `page` + 1, or null on the last page. */
function pageOf(response: BridgeResponse, snapshotId: string, page: number): SubmoduleWork | null {
  if (response.state !== "succeeded") return null;
  const result = response.result as SubmoduleWork | undefined;
  return result?.snapshotId === snapshotId && Array.isArray(result.entries) && Array.isArray(result.extraRows) && (result.next === null || result.next === page + 1) ? result : null;
}

/** Plan D19 row marks of a `checked` entry, in order. */
export function marksOf(entry: WorkEntry | undefined): string[] {
  if (entry?.state !== "checked") return [];
  return [entry.modified ? "modified content" : null, entry.untracked ? "untracked content" : null].filter((m) => m !== null);
}

// The renderer key of a row with only local edits. It never reaches the service, which knows no entry for the row.
export const EXTRA_ID = "extra:";

/**
 * Plan D19 "Rows": the Changes rows of `extraRows`. A path with a record in the shown status keeps that record, because the result can be of an older snapshot.
 * `xy` `.M` gives the plan letter "M", and `submodule` `S...` the submodule icon and sort. No request sends these entries.
 */
export function extraEntries(work: SubmoduleWork | null, shown: readonly ChangeEntry[]): ChangeEntry[] {
  if (work === null || work.extraRows.length === 0) return [];
  const paths = new Set(shown.map((e) => e.pathBytes));
  return work.extraRows.filter((row) => !paths.has(row.pathBytes)).map((row) => ({ entryId: `${EXTRA_ID}${row.pathBytes}`, category: "unstaged", path: row.path, pathBytes: row.pathBytes, xy: ".M", submodule: "S..." }) as ChangeEntry);
}

/** Spec FR-074: the Working tree row applies to a record whose index side holds a gitlink (porcelain v2 `1` or `2` record, mode `mI` 160000). */
export const indexGitlink = (entry: ChangeEntry) => entry.entryId.startsWith(EXTRA_ID) || (entry.modes?.length === 3 && entry.modes[1] === "160000");

/** Plan D19 Working tree row of the gitlink with `pathBytes` in the index of `snapshotId`. */
function workText(read: WorkRead | null, snapshotId: string | undefined, pathBytes: string): string {
  if (read === null || read.snapshotId !== snapshotId) return PENDING_TEXT;
  if (read.work === null) return `Working tree is unavailable: ${read.failure}`;
  const row = read.rows.get(pathBytes);
  const entry = row?.snapshotId === snapshotId ? row.entry : undefined;
  if (entry === undefined && read.more) return PENDING_TEXT;
  // Contract Δ3: each of the first 256 stage-0 gitlinks has one entry, and `limited` counts the rest. No entry with `limited` 0 breaks the contract.
  if (entry === undefined) return read.work.limited > 0 ? WORK_LIMIT_TEXT : "Working tree is unavailable: STATE_UNKNOWN";
  if (entry.state === "not-initialized") return INITIALIZE_FIRST;
  if (entry.state === "not-located") return NOT_LOCATED_TEXT;
  if (entry.state === "unchecked") return entry.reason === "programs" ? PROGRAMS_TEXT : `Working tree is unavailable: ${entry.code}`;
  return marksOf(entry).join(", ") || NO_EDITS;
}

type WorkTarget = { repositoryId: string; repositoryGeneration: number; snapshotId: string };
/** One page cycle: its start page, its pages by index, and the rows shown when it started. */
type Cycle = { t: WorkTarget; start: number; pages: (SubmoduleWork | undefined)[]; older: ReadonlyMap<string, WorkRow> };
// Plan D19 "Page failures": a newer snapshot or generation replaced the target, and its cycle follows.
const REPLACED = new Set(["UNKNOWN_TARGET", "REPOSITORY_CHANGED"]);

/**
 * Contract Δ3 "Page cycle" after each complete `readWorkspace` result. At most one page runs.
 * A newer snapshot stops the cycle after its running page. The result of another repository never shows.
 */
export function useSubmoduleWork(read: (target: WorkTarget, page: number) => Promise<BridgeResponse>, repositoryId: string | null, snapshot: { snapshotId: string; generation: number } | null): WorkRead | null {
  const [shown, setShown] = useState<{ repositoryId: string; read: WorkRead } | null>(null);
  const flight = useRef<{ running: WorkTarget | null; due: WorkTarget | null; repositoryId: string | null; mounted: boolean; resume: number; rows: ReadonlyMap<string, WorkRow> }>({
    running: null,
    due: null,
    repositoryId: null,
    mounted: true,
    resume: 0,
    rows: new Map(),
  });
  useEffect(() => {
    const f = flight.current;
    f.mounted = true;
    return () => void (f.mounted = false);
  }, []);
  useEffect(() => {
    const f = flight.current;
    if (f.repositoryId !== repositoryId) {
      f.resume = 0;
      f.rows = new Map();
    }
    f.repositoryId = repositoryId;
    if (repositoryId === null || snapshot === null) return void (f.due = null);
    const target = { repositoryId, repositoryGeneration: snapshot.generation, snapshotId: snapshot.snapshotId };
    const show = (t: WorkTarget, more: boolean, rows: ReadonlyMap<string, WorkRow>, limited: number | null, failure: string) => {
      f.rows = rows;
      const all = [...rows.values()];
      const work = limited === null ? null : { snapshotId: t.snapshotId, entries: all.map((r) => r.entry), extraRows: all.flatMap((r) => (r.extra === null ? [] : [r.extra])), limited, next: null };
      setShown({ repositoryId: t.repositoryId, read: { snapshotId: t.snapshotId, more, rows, work, failure } });
    };
    const start = (t: WorkTarget, page: number) => run({ t, start: page, pages: [], older: f.rows }, page);
    const run = (c: Cycle, page: number) => {
      f.running = c.t;
      void read(c.t, page).then((response) => {
        f.running = null;
        if (!f.mounted) return;
        const due = f.due;
        f.due = null;
        const later = due !== null && due.repositoryId === f.repositoryId ? due : null;
        if (f.repositoryId !== c.t.repositoryId) return void (later !== null && start(later, f.resume));
        const got = pageOf(response, c.t.snapshotId, page);
        let next: number | null = null;
        let restart = false;
        if (got !== null) {
          c.pages[page] = got;
          const following = got.next ?? 0;
          // Contract Δ3 "Page cycle": one cycle reads each page once, so it ends before its start page.
          const ended = c.pages[following] !== undefined;
          f.resume = ended ? 0 : following;
          if (!ended) next = following;
          // Data-model §16 "Join": the pages join in page order. Plan D19 "Rows across snapshots": older rows stay until the cycle ends.
          const rows = new Map<string, WorkRow>();
          for (const p of c.pages) {
            if (p === undefined) continue;
            const extra = new Map(p.extraRows.map((r) => [r.pathBytes, r]));
            for (const entry of p.entries) rows.set(entry.pathBytes, { entry, extra: extra.get(entry.pathBytes) ?? null, snapshotId: c.t.snapshotId });
          }
          if (!ended) for (const [path, row] of c.older) if (!rows.has(path)) rows.set(path, row);
          show(c.t, !ended, rows, got.limited, "");
        } else if (response.code === "INVALID_REQUEST" && page > 0 && page === c.start && c.pages.length === 0) {
          // Contract Δ3 "Page cycle": a resumed start page past the page count of the newer snapshot. The restart at page 0 runs once.
          f.resume = 0;
          restart = true;
        } else if (REPLACED.has(response.code ?? "")) {
          f.resume = page;
        } else {
          f.resume = 0;
          show(c.t, false, new Map(), null, response.code ?? response.state);
        }
        if (later !== null) return start(later, f.resume);
        if (restart) return start(c.t, 0);
        if (next !== null) run(c, next);
      });
    };
    if (f.running === null) return start(target, f.resume);
    f.due = f.running.snapshotId === target.snapshotId && f.running.repositoryId === target.repositoryId ? null : target;
  }, [repositoryId, snapshot]);
  return shown !== null && shown.repositoryId === repositoryId ? shown.read : null;
}

/**
 * Sends `readSubmoduleChange` for `source` and cancels a running read when the source changes (spec FR-076).
 * `row` names the selected row across snapshots. The earlier result of the same row stays shown until the new one arrives.
 */
export function useSubmoduleChange(reader: SubmoduleReader | undefined, source: SubmoduleSource | null, row: string | null): ChangeRead | null {
  return useSubmoduleChangeRead(reader, source, row).read;
}

/** `useSubmoduleChange` with `fresh`: false while the earlier result of the same row stands in. A new `attempt` sends the read again. */
export function useSubmoduleChangeRead(reader: SubmoduleReader | undefined, source: SubmoduleSource | null, row: string | null, attempt = 0): { read: ChangeRead | null; fresh: boolean } {
  const key = source === null ? null : JSON.stringify([source, attempt]);
  const [read, setRead] = useState<{ key: string; row: string | null; response: BridgeResponse } | null>(null);
  useEffect(() => {
    if (reader === undefined || key === null) return;
    let current = true;
    let ended = false;
    let operationId: string | null = null;
    void reader
      .read((JSON.parse(key) as [SubmoduleSource, number])[0], (event) => {
        if (operationId !== null) return;
        operationId = event.operationId;
        if (!current && !ended) reader.cancel(operationId);
      })
      .then((response) => {
        ended = true;
        if (current) setRead({ key, row, response });
      });
    return () => {
      current = false;
      if (!ended && operationId !== null) reader.cancel(operationId);
    };
  }, [reader, key]);
  if (key === null) return { read: null, fresh: true };
  if (read?.key === key) return { read: read.response, fresh: true };
  return { read: row !== null && read?.row === row ? read.response : "pending", fresh: false };
}

export type SubmodulePreviewProps = {
  path: string;
  pathBytes: string;
  /** The change read, or null for a row without a change (spec FR-075 rows with only local edits). */
  change: ChangeRead | null;
  /** The Commit view work state. Undefined in History, which shows no Working tree row (spec FR-074). */
  work?: { read: WorkRead | null; snapshotId: string | undefined };
  reader: SubmoduleReader | undefined;
  /** The Commit view reason line of the stage controls (feature 005 plan.md D20 "Refusal texts"). */
  reasonLine?: ReactNode;
};

/** Plan D19 "Layout": the diff area of a selected submodule row. The region scrolls by itself. Open submodule is its one Tab stop. */
export function SubmodulePreview({ path, pathBytes, change, work, reader, reasonLine }: SubmodulePreviewProps) {
  const reasonId = useId();
  const result = changeOf(change);
  const reason = reader === undefined ? null : reader.reason(pathBytes);
  const failure = change === null || change === "pending" || result !== null ? null : `Submodule change is unavailable: ${change.code ?? change.state}`;
  const ids = result === null ? null : [result.old, result.new].filter((id) => id !== null);
  const changed = result === null ? null : changeText(result);
  const note =
    result === null ? null
    : result.state.state === "missing" ? MISSING_TEXT
    : result.state.state === "not-initialized" ? INITIALIZE_FIRST
    : result.state.state === "not-located" ? NOT_LOCATED_TEXT
    : null;
  const commits = result?.state.state === "commits" ? result.state : null;
  return (
    <section aria-label={`Submodule ${path}`} data-slot="submodule-preview" className="flex h-full min-h-0 flex-col overflow-y-auto select-text">
      <div className="flex shrink-0 items-center gap-2 border-b border-divider px-2" style={{ minHeight: 32 }}>
        <TextTooltip text={path}>
          <h2 className="min-w-0 truncate font-mono font-semibold">{path}</h2>
        </TextTooltip>
        {result === null ? null : <span className="badge border-control-border shrink-0">{result.kind === "nested" ? "Nested repository" : "Submodule"}</span>}
        <span className="ml-auto flex shrink-0 items-center">
          <Button
            variant="outline"
            size="sm"
            style={{ height: 24 }}
            disabled={reason !== null || reader === undefined}
            focusableWhenDisabled
            aria-describedby={reason === null ? undefined : reasonId}
            onClick={() => reason === null && reader?.open(path)}
          >
            Open submodule
          </Button>
        </span>
      </div>
      {reason === null ? null : (
        <p id={reasonId} className="shrink-0 px-2 pt-1 text-muted-text">
          {`Open submodule is unavailable: ${reason}`}
        </p>
      )}
      {reasonLine === undefined ? null : <div className="flex shrink-0 px-2 pt-1">{reasonLine}</div>}
      <dl className="grid shrink-0 gap-x-4 gap-y-1 p-2" style={{ gridTemplateColumns: "96px minmax(0, 1fr)" }}>
        {change === null ? null : (
          <>
            <dt className="text-muted-text">Commit</dt>
            <dd>
              {change === "pending" ? PENDING_TEXT
              : failure !== null ? failure
              : ids!.length < 2 ? ids!.map((id) => <code key={id}>{shortId(id)}</code>)
              : (
                <>
                  <code>{shortId(ids![0]!)}</code>
                  <span aria-hidden="true"> → </span>
                  <span className="sr-only"> to </span>
                  <code>{shortId(ids![1]!)}</code>
                </>
              )}
            </dd>
          </>
        )}
        {changed === null ? null : (
          <>
            <dt className="text-muted-text">Change</dt>
            <dd>{changed}</dd>
          </>
        )}
        {work === undefined ? null : (
          <>
            <dt className="text-muted-text">Working tree</dt>
            <dd>{workText(work.read, work.snapshotId, pathBytes)}</dd>
          </>
        )}
      </dl>
      {result?.kind === "nested" ? <p className="shrink-0 px-2">{NESTED_TEXT}</p> : null}
      {note === null ? null : <p className="shrink-0 px-2">{note}</p>}
      {commits === null ? null : (
        <>
          <CommitList heading="New commits" total={commits.added} list={commits.addedCommits} />
          <CommitList heading="Removed commits" total={commits.removed} list={commits.removedCommits} />
        </>
      )}
    </section>
  );
}

/** Plan D19 "Lists": one 20 px row per commit, then "and <n> more". The list is plain text, not a focus stop. */
function CommitList({ heading, total, list }: { heading: string; total: number; list: readonly { oid: string; subject: string }[] }) {
  if (total === 0) return null;
  const more = total - list.length;
  return (
    <div className="flex shrink-0 flex-col gap-1 p-2">
      <h3 className="font-semibold">{heading}</h3>
      <ul>
        {list.map((c) => (
          <li key={c.oid} className="flex items-center gap-4" style={{ height: 20 }}>
            <code className="shrink-0">{shortId(c.oid)}</code>{" "}
            <TextTooltip text={c.subject}>
              <span className="min-w-0 truncate">{c.subject}</span>
            </TextTooltip>
          </li>
        ))}
        {more > 0 ? (
          <li className="text-muted-text" style={{ height: 20 }}>
            {`and ${count.format(more)} more`}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
