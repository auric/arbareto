// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Copy01Icon } from "@hugeicons/core-free-icons";
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import type { HistoryRow } from "../../contracts/envelope";
import { useCopy } from "../app/RepositoryStates";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import type { Details, HistoryView } from "../state/history-view";

// plan.md "History graph design" (commit details rules), "Keyboard and focus" (Roles), and "Selection, scroll, and stored context".

const NO_FILES = "Changed files are not shown in this version.";
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
      <span>
        {person.name} &lt;{person.email}&gt;
      </span>
      <time dateTime={isoText(seconds)}>{dateFormat.format(seconds * 1000)}</time>
      <span className="num">{isoText(seconds)}</span>
    </dd>
  );
}

function CommitLink({ oid, onSelect }: { oid: string; onSelect(oid: string): void }) {
  return (
    <Button variant="outline" size="sm" className="font-mono" onClick={() => onSelect(oid)}>
      {oid}
    </Button>
  );
}

// Feature 002 spec FR-017, FR-018: the details pane reads the body through `readHistoryRows` with `text: "details"`. Texts follow the approved mockup canvas of plan.md D6.
const NO_BODY = "This commit has no message body.";
const ROOT_TEXT = "None. This is a root commit.";
const SHALLOW_TEXT = "Not in this shallow clone.";
const TEXT_LIMIT = "Arbareto does not show this commit, because its commit object is larger than 256 KiB.";
const LABEL_WORD = { branch: "branch", remote: "remote-tracking branch", tag: "tag", stash: "stash" } as const;

/** Contract Δ3 targets and outcomes other than `found`. Only target `none` says that the list lacks the commit. */
function absentText(details: Details): string {
  if (details.state === "none") return "This commit is not in the history list.";
  if (details.state === "unknown") return "This commit is not in the loaded history rows.";
  return `Arbareto cannot read this commit: ${(details as { code: string }).code}.`;
}

export type ViewCommitDetailsProps = {
  view: HistoryView;
  /** The selected commit. */
  oid: string;
  dateFormat?: Intl.DateTimeFormat;
  /** Runs after a `found` details read of `oid` rendered. A failed or absent target never runs it. */
  onRead?: () => void;
};

/** The docked "Selected commit" region of a feature 002 view. It reads the commit when it shows, and it holds no Git action. */
export function ViewCommitDetails({ view, oid, dateFormat = LOCAL_DATE, onRead }: ViewCommitDetailsProps) {
  const headingId = useId();
  const copy = useCopy();
  const [read, setRead] = useState<{ oid: string; details: Details } | null>(null);
  // A canceled read shows Loading… and reads again. The store runs one text read at a time, so the list never cancels it.
  const [attempt, setAttempt] = useState(0);
  // A new view (Refresh, a scope switch) reads the commit again.
  const viewId = useSyncExternalStore(view.subscribe, () => view.getState().view?.viewId ?? null);
  useEffect(() => {
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
  return (
    <section aria-labelledby={headingId} className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-divider px-2" style={{ minHeight: "var(--h-pane-heading)" }}>
        <h2 id={headingId} className="mr-auto font-semibold">
          Selected commit
        </h2>
        <IconButton icon={Copy01Icon} label="Copy commit ID" onClick={() => copy(oid)} />
        {row?.subject === undefined ? null : <IconButton icon={Copy01Icon} label="Copy message" onClick={() => copy(messageText({ subject: row.subject!, body: row.body ?? "" }))} />}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-2">
        {row === undefined ? (
          <p className="text-muted-text">Loading…</p>
        ) : row === null ? (
          <p className="text-muted-text">{absentText(details!)}</p>
        ) : row.textLimit ? (
          <>
            <p className="font-mono break-all">{row.oid}</p>
            <p>{TEXT_LIMIT}</p>
          </>
        ) : (
          <>
            <p className="break-words font-semibold">{row.subject}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
              <dt className="text-muted-text">ID</dt>
              <dd className="font-mono break-all">{row.oid}</dd>
              <dt className="text-muted-text">Author</dt>
              <Person person={row.author!} seconds={row.date!} dateFormat={dateFormat} />
              <dt className="text-muted-text">Committer</dt>
              <Person person={row.committer!} seconds={row.committerDate!} dateFormat={dateFormat} />
              <dt className="text-muted-text">Parents</dt>
              <dd>
                <ol className="flex flex-col items-start gap-1">
                  {row.parents.map((parent) => (
                    <li key={parent}>
                      <CommitLink oid={parent} onSelect={(o) => void view.selectOid(o)} />
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
            <p className="text-muted-text">{NO_FILES}</p>
          </>
        )}
      </div>
    </section>
  );
}
