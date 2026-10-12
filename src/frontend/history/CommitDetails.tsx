// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Copy01Icon } from "@hugeicons/core-free-icons";
import { useEffect, useId, useState } from "react";
import type { HistoryPage, HistoryRow } from "../../contracts/envelope";
import { useCopy } from "../app/RepositoryStates";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import type { HistoryView, ViewRow } from "../state/history-view";
import { BOUNDARY_TEXT, type Layout } from "./lanes";

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

export type CommitDetailsProps = {
  page: HistoryPage;
  layout: Layout;
  /** The selected commit. It must be a row of `page`. */
  oid: string;
  /** Selects a loaded commit. It never checks out or moves a reference. */
  onSelect(oid: string): void;
  dateFormat?: Intl.DateTimeFormat;
};

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

/** The docked "Selected commit" region. It holds no Git action. */
export function CommitDetails({ page, layout, oid, onSelect, dateFormat = LOCAL_DATE }: CommitDetailsProps) {
  const headingId = useId();
  const copy = useCopy();
  const index = page.rows.findIndex((r) => r.oid === oid);
  const row = page.rows[index];
  const cell = layout.cells[index];
  if (row === undefined || cell === undefined) return null;
  const loaded = new Set(page.rows.map((r) => r.oid));
  // Every HEAD-reachable child precedes its parent, so the page holds all children of a page row.
  const children = page.rows.filter((r) => r.parents.includes(oid));
  return (
    <section aria-labelledby={headingId} className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-divider px-2" style={{ minHeight: "var(--h-pane-heading)" }}>
        <h2 id={headingId} className="mr-auto font-semibold">
          Selected commit
        </h2>
        <IconButton icon={Copy01Icon} label="Copy commit ID" onClick={() => copy(row.oid)} />
        <IconButton icon={Copy01Icon} label="Copy message" onClick={() => copy(messageText(row))} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-2">
        <p className="break-words font-semibold">{row.subject}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
          <dt className="text-muted-text">ID</dt>
          <dd className="font-mono break-all">{row.oid}</dd>
          <dt className="text-muted-text">Author</dt>
          <Person person={row.author} seconds={row.date} dateFormat={dateFormat} />
          <dt className="text-muted-text">Committer</dt>
          <Person person={row.committer} seconds={row.committerDate} dateFormat={dateFormat} />
          <dt className="text-muted-text">Parents</dt>
          <dd>
            <ol className="flex flex-col items-start gap-1">
              {row.parents.map((parent) => (
                <li key={parent} className="flex flex-wrap items-center gap-2">
                  {loaded.has(parent) ? (
                    <CommitLink oid={parent} onSelect={onSelect} />
                  ) : (
                    <>
                      <code className="break-all">{parent}</code>
                      <span>{BOUNDARY_TEXT.outside}</span>
                    </>
                  )}
                </li>
              ))}
              {cell.marks
                .filter((m) => m.parent === null)
                .map((m) => (
                  <li key={m.kind}>{m.text}</li>
                ))}
            </ol>
          </dd>
          <dt className="text-muted-text">Children on this checkout</dt>
          <dd>
            <ol className="flex flex-col items-start gap-1">
              {children.map((child) => (
                <li key={child.oid}>
                  <CommitLink oid={child.oid} onSelect={onSelect} />
                </li>
              ))}
            </ol>
          </dd>
        </dl>
        {row.body === "" ? null : (
          <p data-slot="message" className="break-words whitespace-pre-wrap">
            {row.body}
          </p>
        )}
        {row.bodyCut ? <p className="text-muted-text">{CUT_TEXT}</p> : null}
        {row.encoding === null && !row.invalidUtf8 ? null : (
          <p>{row.encoding === null ? INVALID_UTF8_TEXT : `${encodingText(row.encoding)}. ${ENCODING_NOTE}${row.invalidUtf8 ? ` ${INVALID_UTF8_TEXT}` : ""}`}</p>
        )}
        <p className="text-muted-text">{NO_FILES}</p>
      </div>
    </section>
  );
}

// Feature 002 spec FR-017, FR-018: the details pane reads the body through `readHistoryRows` with `text: "details"`. Texts follow the approved mockup canvas of plan.md D6.
const NO_BODY = "This commit has no message body.";
const ROOT_TEXT = "None. This is a root commit.";
const SHALLOW_TEXT = "Not in this shallow clone.";
const TEXT_LIMIT = "Arbareto does not show this commit, because its commit object is larger than 256 KiB.";
const LABEL_WORD = { branch: "branch", remote: "remote-tracking branch", tag: "tag", stash: "stash" } as const;

export type ViewCommitDetailsProps = {
  view: HistoryView;
  /** The selected commit. */
  oid: string;
  dateFormat?: Intl.DateTimeFormat;
};

/** The docked "Selected commit" region of a feature 002 view. It reads the commit when it shows, and it holds no Git action. */
export function ViewCommitDetails({ view, oid, dateFormat = LOCAL_DATE }: ViewCommitDetailsProps) {
  const headingId = useId();
  const copy = useCopy();
  const [read, setRead] = useState<{ oid: string; row: ViewRow | null } | null>(null);
  useEffect(() => {
    let current = true;
    void view.readDetails(oid).then((result) => {
      if (current) setRead({ oid, row: result?.target === "found" ? result.rows[0]! : null });
    });
    return () => void (current = false);
  }, [view, oid]);
  const row = read?.oid === oid ? read.row : undefined;
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
          <p className="text-muted-text">This commit is not in the history list.</p>
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
