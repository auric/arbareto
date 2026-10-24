// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Copy01Icon } from "@hugeicons/core-free-icons";
import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import type { HistoryRow } from "../../contracts/envelope";
import { unknownReadText, useCopy } from "../app/RepositoryStates";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { FILE_LANE, type Profile } from "../layout/profiles";
import { Splitter } from "../layout/Splitter";
import type { Details, HistoryView } from "../state/history-view";

// plan.md "History graph design" (commit details rules), "Keyboard and focus" (Roles), and "Selection, scroll, and stored context".

const CUT_TEXT = "Arbareto shows the first 16 KiB of this message.";
const encodingText = (encoding: string) => `Declared encoding: ${encoding}`;
const ENCODING_NOTE = "Arbareto shows the subject and the author as UTF-8 without conversion. Bytes that are not valid UTF-8 show as replacement characters.";
export const INVALID_UTF8_TEXT = "Some bytes of this commit are not valid UTF-8 and show as replacement characters.";

/** The time in the local time zone and the system locale, to the minute. */
export const LOCAL_DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
// `date` and `committerDate` are times in seconds (contract §3).
const isoText = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Copy message copies the subject, a blank line, and the body. A commit without a body copies the subject. */
export const messageText = (row: Pick<HistoryRow, "subject" | "body">) => (row.body === "" ? row.subject : `${row.subject}\n\n${row.body}`);

function Person({ person, seconds, dateFormat }: { person: HistoryRow["author"]; seconds: number; dateFormat: Intl.DateTimeFormat }) {
  return (
    <dd className="flex flex-wrap gap-x-2 break-words">
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {person.name} &lt;{person.email}&gt;
      </span>
      <time dateTime={isoText(seconds)}>{dateFormat.format(seconds * 1000)}</time>
      <span className="num">{isoText(seconds)}</span>
    </dd>
  );
}

/** Feature 005 plan.md D15 "History view" (Main board): the 268 px region shows the short ID. The name and the tooltip give the full ID. */
function CommitLink({ oid, onSelect }: { oid: string; onSelect(oid: string): void }) {
  return (
    <Button variant="outline" size="sm" className="font-mono" aria-label={oid} title={oid} onClick={() => onSelect(oid)}>
      {shortId(oid)}
    </Button>
  );
}

// Feature 002 spec FR-017, FR-018: the details pane reads the body through `readHistoryRows` with `text: "details"`. Texts follow the approved mockup canvas of plan.md D6.
const NO_BODY = "This commit has no message body.";
const ROOT_TEXT = "None. This is a root commit.";
const SHALLOW_TEXT = "Not in this shallow clone.";
const TEXT_LIMIT = "Arbareto does not show this commit, because its commit object is larger than 256 KiB.";
// 001 plan.md "History graph design": a short ID is the first 12 hex digits.
const shortId = (oid: string) => oid.slice(0, 12);
const LABEL_WORD = { branch: "branch", remote: "remote-tracking branch", tag: "tag", stash: "stash" } as const;

/** Contract Δ3 targets and outcomes other than `found`. Only target `none` says that the list lacks the commit. */
function absentText(details: Details): string {
  if (details.state === "none") return "This commit is not in the history list.";
  if (details.state === "unknown") return "This commit is not in the loaded history rows.";
  const code = (details as { code: string | null }).code;
  return code === null ? unknownReadText("The commit") : `Arbareto cannot read this commit: ${code}.`;
}

export type ViewCommitDetailsProps = {
  view: HistoryView;
  /** The selected commit. */
  oid: string;
  dateFormat?: Intl.DateTimeFormat;
  /** Runs after a `found` details read of `oid` rendered. A failed or absent target never runs it. */
  onRead?: () => void;
  /** Feature 005 spec FR-005: the Changed files and diff regions beside the details. Without them, the region shows the details only. */
  changes?: ReactNode;
  /** The constrained profile shows the details and the changes as the tabs "Commit" and "Changes". */
  profile?: Profile;
  /** The details width. The Workbench keeps it, so it survives the blame view. Without it, the region keeps its own. */
  width?: number;
  onWidth?(width: number): void;
};

// Feature 005 plan.md D15 "History view": the Commit details region is 268 px wide.
export const DETAILS_WIDTH = 268;

/** The docked "Selected commit" region of a feature 002 view. It reads the commit when it shows, and it holds no Git action. */
export function ViewCommitDetails({ view, oid, dateFormat = LOCAL_DATE, onRead, changes, profile = "wide", width: given, onWidth }: ViewCommitDetailsProps) {
  const [own, setOwn] = useState(DETAILS_WIDTH);
  const width = given ?? own;
  const setWidth = onWidth ?? setOwn;
  const headingId = useId();
  const copy = useCopy();
  const [read, setRead] = useState<{ oid: string; details: Details } | null>(null);
  // A canceled read shows Loading… and reads again. The store runs one text read at a time, so the list never cancels it.
  const [attempt, setAttempt] = useState(0);
  // A new view (Refresh, a scope switch) reads the commit again. The History selection reads only after the new view selects it again,
  // because the view holds its row only then (feature 005 T068). Another commit, such as a blame line commit, reads at once.
  const viewIdOf = () => {
    const s = view.getState();
    return s.selection?.id === oid && s.selectedIn !== s.view?.viewId ? null : (s.view?.viewId ?? null);
  };
  const viewId = useSyncExternalStore(view.subscribe, viewIdOf);
  useEffect(() => {
    if (viewId === null) return;
    let current = true;
    void view.readDetails(oid).then((details) => {
      if (!current) return;
      if (details.state === "canceled") setAttempt((n) => n + 1);
      else setRead({ oid, details });
    });
    return () => void (current = false);
  }, [view, oid, attempt, viewId]);
  const details = read?.oid === oid ? read.details : undefined;
  useEffect(() => {
    if (details?.state === "found") onRead?.();
  }, [details]);
  const row = details?.state === "found" ? details.row : details === undefined || details.state === "canceled" || details.state === "ended" ? undefined : null;
  const head = view.getState().view?.head;
  const references = row === undefined || row === null ? [] : [...(row.checkout && head !== undefined ? [head.state === "detached" ? "HEAD, detached" : "HEAD"] : []), ...row.labels.map((l) => `${LABEL_WORD[l.kind]} ${l.name}`)];
  const body = (
    <>
        {row === undefined ? (
          <p className="text-muted-text">Loading…</p>
        ) : row === null ? (
          <p className="text-muted-text">{absentText(details!)}</p>
        ) : row.textLimit ? (
          <>
            <p className="flex items-start gap-1">
              <span className="min-w-0 font-mono break-all">{row.oid}</span>
              <IconButton icon={Copy01Icon} label="Copy commit ID" onClick={() => copy(row.oid)} />
            </p>
            <p>{TEXT_LIMIT}</p>
          </>
        ) : (
          <>
            <p className="flex items-start gap-1">
              <span className="min-w-0 break-words font-semibold">{row.subject}</span>
              {row.subject === undefined ? null : <IconButton icon={Copy01Icon} label="Copy message" onClick={() => copy(messageText({ subject: row.subject!, body: row.body ?? "" }))} />}
            </p>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
              <dt className="text-muted-text">ID</dt>
              <dd className="flex items-start gap-1">
                <span className="min-w-0 font-mono break-all">{row.oid}</span>
                <IconButton icon={Copy01Icon} label="Copy commit ID" onClick={() => copy(row.oid)} />
              </dd>
              <dt className="text-muted-text">Author</dt>
              <Person person={row.author!} seconds={row.date!} dateFormat={dateFormat} />
              <dt className="text-muted-text">Committer</dt>
              <Person person={row.committer!} seconds={row.committerDate!} dateFormat={dateFormat} />
              <dt className="text-muted-text">Parents</dt>
              <dd>
                <ol className="flex flex-col items-start gap-1">
                  {row.parents.map((parent) => (
                    <li key={parent} className="flex items-center gap-1">
                      <CommitLink oid={parent} onSelect={(o) => void view.selectOid(o)} />
                      <IconButton icon={Copy01Icon} label={`Copy parent ID ${shortId(parent)}`} onClick={() => copy(parent)} />
                    </li>
                  ))}
                  {row.cell?.marks.includes("root") ? <li>{ROOT_TEXT}</li> : null}
                  {row.cell?.marks.includes("shallow") ? <li>{SHALLOW_TEXT}</li> : null}
                </ol>
              </dd>
              <dt className="text-muted-text">Children</dt>
              <dd>
                <ol className="flex flex-col items-start gap-1">
                  {(row.children ?? []).map((child) => (
                    <li key={child}>
                      <CommitLink oid={child} onSelect={(o) => void view.selectOid(o)} />
                    </li>
                  ))}
                </ol>
              </dd>
              {references.length === 0 ? null : (
                <>
                  <dt className="text-muted-text">References</dt>
                  <dd className="break-words">{references.join("; ")}</dd>
                </>
              )}
            </dl>
            {row.body === "" ? (
              <p className="text-muted-text">{NO_BODY}</p>
            ) : (
              <p data-slot="message" className="break-words whitespace-pre-wrap">
                {row.body}
              </p>
            )}
            {row.bodyCut ? <p className="text-muted-text">{CUT_TEXT}</p> : null}
            {row.encoding == null && !row.invalidUtf8 ? null : (
              <p>{row.encoding == null ? INVALID_UTF8_TEXT : `${encodingText(row.encoding)}. ${ENCODING_NOTE}${row.invalidUtf8 ? ` ${INVALID_UTF8_TEXT}` : ""}`}</p>
            )}
          </>
        )}
    </>
  );
  const bodyClass = "flex min-h-0 flex-col gap-1 overflow-auto select-text";
  return (
    <section aria-labelledby={headingId} className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-divider px-2" style={{ minHeight: "var(--h-pane-heading)" }}>
        <h2 id={headingId} className="font-semibold">
          Selected commit
        </h2>
      </div>
      {changes === undefined ? (
        <div data-slot="commit-details-body" className={`${bodyClass} flex-1 p-2`}>
          {body}
        </div>
      ) : profile === "constrained" ? (
        // Feature 005 spec FR-005 (HistoryStates board, cell 8): two tabs. The Changes panel stays mounted, so its reads follow the selection.
        <Tabs defaultValue="commit" className="min-h-0 flex-1 gap-0">
          <TabsList variant="line" className="shrink-0 px-2">
            <TabsTrigger value="commit">Commit</TabsTrigger>
            <TabsTrigger value="changes">Changes</TabsTrigger>
          </TabsList>
          <TabsContent value="commit" data-slot="commit-details-body" className={`${bodyClass} p-3`}>
            {body}
          </TabsContent>
          <TabsContent value="changes" keepMounted className="flex min-h-0 flex-col data-[hidden]:hidden">
            {changes}
          </TabsContent>
        </Tabs>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div data-slot="commit-details-body" className={`${bodyClass} shrink-0 p-3`} style={{ width }}>
            {body}
          </div>
          <Splitter label="Resize commit details" orientation="vertical" value={width} min={FILE_LANE.min} max={FILE_LANE.max} onChange={setWidth} />
          {changes}
        </div>
      )}
    </section>
  );
}
