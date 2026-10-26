// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Alert02Icon, ArrowDown01Icon, ArrowRight01Icon, FileEditIcon, InformationCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Loading } from "../app/RepositoryStates";
import { formatCount } from "../changes/file-tree";
import { pathText } from "../changes/file-actions";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { scopedAction } from "../keyboard/shortcuts";
import { Splitter } from "../layout/Splitter";
import { IGNORE_FILE, type IgnoreEditor as IgnoreStore, type IgnoreEditorState, type IgnorePreview, type LineEnding } from "../state/workbench";
import { ReadsTrustNotice } from "../trust/TrustChip";

// Feature 005 spec FR-034 to FR-046, FR-068, plan.md D8 to D10, D15 ("Ignore editor", "Ignore editor keys", "Ignore editor texts"), the IgnoreEditor board.

// Plan D15 "Ignore editor texts".
const OPEN_REFUSAL: Record<string, (file: string) => string> = {
  "ignore-link": (f) => `${f} is a symbolic link. Arbareto edits only a regular file.`,
  "ignore-folder": (f) => `${f} is a folder. Arbareto edits only a regular file.`,
  "ignore-not-regular": (f) => `${f} is a special file. Arbareto edits only a regular file.`,
  "ignore-size": (f) => `${f} is larger than 1 MiB. Arbareto does not edit it.`,
  "ignore-not-utf8": (f) => `${f} is not valid UTF-8 text. Arbareto does not edit it.`,
  "ignore-nul": (f) => `${f} holds a NUL character. Arbareto does not edit it.`,
  "ignore-lone-cr": (f) => `${f} holds a CR without an LF. Arbareto does not edit it.`,
  unreadable: (f) => `Arbareto cannot read ${f}.`,
  path: () => "Git names an info/exclude path outside the Git folder. Arbareto does not edit it.",
};
const PREVIEW_REASON: Record<string, string> = {
  paths: "the preview checks more than 100,000 paths",
  listing: "Git lists more paths or ignore files than the preview reads",
  "name-case": "a file name differs from .gitignore only in letter case",
  "shadow-copy": "Arbareto cannot copy the ignore files for the preview",
  "self-check": "the preview does not match Git for the saved text",
  unreadable: "Arbareto cannot read an ignore file of this repository",
  deadline: "the preview took longer than 30 seconds",
};
const IDLE = "Change the text to see its effect on ignored files.";
const NO_SNAPSHOT = "The preview needs a file status read. Press F5, then change the text.";
const LINE_ENDINGS = "Line endings";
const FORMS: readonly [LineEnding, string][] = [
  ["lf", "LF"],
  ["crlf", "CRLF"],
];
const SELECT_FORM = "Select LF or CRLF before Save.";
export const INVALID_TEXT = "The text holds an invalid character. Arbareto cannot save it or show a preview.";
const NOTICE: Record<string, string> = { link: "is a symbolic link. Git does not read it.", "inside-ignored": "is inside an ignored folder. Git does not read it." };
// Plan D15: 18 px editor lines with 8 px padding, 22 px preview rows, and the 340 px preview with the 001 file lane bounds.
const LINE = 18;
const PAD = 8;
const ROW = 22;
const PREVIEW_WIDTH = { start: 340, min: 240, max: 400 };

function refusalText(refusal: string, file: string): string {
  if (refusal.startsWith("code:")) return `Arbareto cannot read ${file}: ${refusal.slice("code:".length)}.`;
  return OPEN_REFUSAL[refusal]?.(file) ?? `Arbareto cannot read ${file}: ${refusal}.`;
}

export type IgnoreEditorProps = {
  store: IgnoreStore;
  /** Trust… of a preview that needs trust: the 004 D12 read approval. */
  onTrust(): void;
};

/** The docked editor of `.gitignore` or `info/exclude` in the Commit view diff region. The text is plain text in a `textarea` (FR-045). */
export function IgnoreEditor({ store, onTrust }: IgnoreEditorProps) {
  const editor = useSyncExternalStore(store.subscribe, () => store.getState().editor, () => store.getState().editor);
  const headingId = useId();
  const reasonId = useId();
  const [width, setWidth] = useState(PREVIEW_WIDTH.start);
  if (editor === null) return null;
  const file = IGNORE_FILE[editor.target];
  const heading = editor.target === "gitignore" ? "Edit .gitignore" : "Edit info/exclude";
  const invalid = editor.preview.state === "invalid";
  // Plan D8: Save of a `mixed` file waits for a "Line endings" choice.
  const reason = editor.loaded !== null && editor.lineEnding === null ? SELECT_FORM : null;

  // Plan D15 "Ignore editor keys": Ctrl+S and Escape act in the panel. An IME composition takes no key (`scopedAction`).
  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    const action = scopedAction(event.nativeEvent, "ignoreEditor");
    if (action === "save") {
      event.preventDefault();
      store.save();
    } else if (action === "closeEditor") {
      event.preventDefault();
      // A real key press can mount the discard modal during this keydown. Its dismiss listener on `document` must not get the same Escape.
      event.stopPropagation();
      store.close();
    }
  }

  return (
    <section data-slot="ignore-editor" aria-labelledby={headingId} className="flex h-full min-h-0 flex-col bg-surface" onKeyDown={onKeyDown}>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-divider px-3">
        <HugeiconsIcon icon={FileEditIcon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0 text-accent-role" />
        <h2 id={headingId} className="shrink-0 text-sm font-semibold whitespace-nowrap">
          {heading}
        </h2>
        {editor.loaded === null ? null : (
          <span data-slot="ignore-path" title={editor.loaded.file} className="min-w-0 truncate font-mono text-muted-text">
            {editor.loaded.file}
          </span>
        )}
      </div>
      {editor.refusal !== null ? (
        <p role="alert" className="p-2">
          {refusalText(editor.refusal, file)}
        </p>
      ) : editor.loaded === null ? (
        <Loading hasContent={false} refreshing={false} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <TextPane editor={editor} label={heading} onEdit={store.edit} />
          <Splitter label="Resize editor and preview" orientation="vertical" value={width} min={PREVIEW_WIDTH.min} max={PREVIEW_WIDTH.max} reverse onChange={setWidth} />
          <div role="region" aria-label="Preview" data-section="ignorePreview" tabIndex={-1} className="flex min-h-0 shrink-0 flex-col" style={{ width }}>
            <Preview preview={editor.preview} onTrust={onTrust} />
          </div>
        </div>
      )}
      {editor.stale ? (
        <div className="flex shrink-0 items-center gap-2 bg-warning-fill p-2">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0 text-warning" />
          <span className="min-w-0 flex-1">{`${file} changed on disk after Arbareto loaded it. Arbareto did not save your text.`}</span>
          <Button variant="outline" size="sm" onClick={store.reload}>
            Reload
          </Button>
        </div>
      ) : null}
      <p role="status" className={editor.notice === null ? "sr-only" : "shrink-0 px-3 pt-2"}>
        {editor.notice}
      </p>
      <div data-slot="ignore-actions" className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-divider px-3 py-2">
        {editor.loaded === null ? null : <LineEndings editor={editor} onChange={store.setLineEnding} />}
        {reason === null ? null : (
          <span id={reasonId} className="text-muted-text">
            {reason}
          </span>
        )}
        <Button variant="outline" onClick={store.close}>
          Close
        </Button>
        {/* Plan D9: a text that fails `isWellFormed()` gets no Save. Save stays available while a preview runs or is not available (FR-041). */}
        <Button disabled={editor.loaded === null || invalid || editor.saving || reason !== null} focusableWhenDisabled aria-describedby={reason === null ? undefined : reasonId} onClick={store.save}>
          Save
        </Button>
      </div>
    </section>
  );
}

/** Plan D15 "Line endings": native radios give one Tab stop and arrow-key selection. A `mixed` file has no checked radio. */
function LineEndings({ editor, onChange }: { editor: IgnoreEditorState; onChange(form: LineEnding): void }) {
  const name = useId();
  const labelId = useId();
  const noteId = useId();
  const counts = editor.loaded?.lineCounts;
  return (
    <div className="flex items-center gap-3">
      <span id={labelId}>{LINE_ENDINGS}</span>
      <div role="radiogroup" aria-labelledby={labelId} aria-describedby={counts === undefined ? undefined : noteId} className="flex items-center gap-3">
        {FORMS.map(([form, label]) => (
          <label key={form} className="flex items-center gap-1.5">
            <input type="radio" name={name} checked={editor.lineEnding === form} onChange={() => onChange(form)} />
            {label}
          </label>
        ))}
      </div>
      {counts === undefined ? null : (
        <span id={noteId} className="text-muted-text">
          {`Mixed (${formatCount(counts.lf)} LF, ${formatCount(counts.crlf)} CRLF)`}
        </span>
      )}
    </div>
  );
}

/** The editor: a 44 px line-number gutter that renders only the visible numbers, and the `textarea` without wrap. */
function TextPane({ editor, label, onEdit }: { editor: IgnoreEditorState; label: string; onEdit(text: string): void }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [view, setView] = useState({ top: 0, height: 0, caret: 0 });
  const { selection } = editor;
  // A programmatic selection (open, added line) moves the caret and the focus to the field.
  useLayoutEffect(() => {
    const element = field.current;
    if (element === null) return;
    element.focus();
    element.setSelectionRange(selection.start, selection.end);
    setView((v) => ({ ...v, caret: selection.start }));
  }, [selection.seq]);
  useEffect(() => {
    const element = field.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setView((v) => ({ ...v, height: element.clientHeight })));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const lines = editor.text.split("\n").length;
  const first = Math.min(lines - 1, Math.floor(view.top / LINE));
  const count = Math.min(lines - first, Math.ceil(view.height / LINE) + 1);
  const caretLine = editor.text.slice(0, view.caret).split("\n").length - 1;
  const sync = () => {
    const element = field.current;
    if (element !== null) setView({ top: element.scrollTop, height: element.clientHeight, caret: element.selectionStart });
  };
  return (
    <div className="relative flex min-w-0 flex-1 bg-canvas">
      <div data-slot="line-numbers" aria-hidden="true" className="relative shrink-0 overflow-hidden border-r border-divider font-mono text-muted-text" style={{ width: 44 }}>
        {Array.from({ length: count }, (_, i) => first + i).map((line) => (
          <span key={line} className={`absolute right-2 ${line === caretLine ? "text-text" : ""}`} style={{ top: PAD + line * LINE - view.top, lineHeight: `${LINE}px` }}>
            {line + 1}
          </span>
        ))}
      </div>
      {/* Plan D15: the fill below the visible text must not extend the comparison region. */}
      <div className="relative min-w-0 flex-1 overflow-hidden">
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bg-selected-row" style={{ top: PAD + caretLine * LINE - view.top, height: LINE }} />
        <textarea
          ref={field}
          aria-label={label}
          spellCheck={false}
          wrap="off"
          autoComplete="off"
          className="relative h-full w-full resize-none overflow-auto bg-transparent p-2 font-mono whitespace-pre outline-none"
          style={{ lineHeight: `${LINE}px` }}
          value={editor.text}
          onChange={(event) => {
            onEdit(event.target.value);
            sync();
          }}
          onScroll={sync}
          onSelect={sync}
        />
      </div>
    </div>
  );
}

function warningOf(preview: IgnorePreview): string | null {
  if (preview.state === "invalid") return INVALID_TEXT;
  if (preview.state === "unavailable" && preview.reason === "no-snapshot") return NO_SNAPSHOT;
  if (preview.state === "unavailable") return `Preview not available: ${PREVIEW_REASON[preview.reason] ?? preview.reason}.`;
  if (preview.state === "failed") return `Preview not available: Git failed with ${preview.code}.`;
  return null;
}

function Preview({ preview, onTrust }: { preview: IgnorePreview; onTrust(): void }) {
  const warning = warningOf(preview);
  // One status element stays mounted across the states, so each new text is announced.
  const status = (
    <p role="status" className={warning !== null ? "flex items-start gap-2 bg-warning-fill p-2" : preview.state === "updating" ? "p-2" : "sr-only"}>
      {warning !== null ? (
        <>
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden="true" className="mt-px size-(--icon-size) shrink-0 text-warning" />
          <span>{warning}</span>
        </>
      ) : preview.state === "updating" ? (
        "Updating preview…"
      ) : null}
    </p>
  );
  if (preview.state !== "shown")
    return (
      <>
        {status}
        {preview.state === "idle" ? <p className="p-2 text-muted-text">{IDLE}</p> : null}
        {preview.state === "trust" ? <ReadsTrustNotice onTrust={onTrust} /> : null}
      </>
    );
  const { newlyIgnored, noLongerIgnored, trackedMatched, notices } = preview.result;
  return (
    <>
      {status}
      {trackedMatched === 0 ? null : (
        <p data-slot="tracked-note" className="flex items-center gap-2 border-b border-divider p-2">
          <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0 text-muted-text" />
          <span>Tracked files stay tracked.</span>
          <span className="num ml-auto text-muted-text">{formatCount(trackedMatched)}</span>
        </p>
      )}
      {notices.entries.length === 0 ? null : (
        <ul className="border-b border-divider p-2">
          {notices.entries.map((notice) => (
            <li key={`${notice.kind}:${notice.pathBytes}`} className="break-all">{`${pathText(notice.pathBytes)} ${NOTICE[notice.kind]}`}</li>
          ))}
          {notices.more > 0 ? <li className="text-muted-text">{`and ${formatCount(notices.more)} more`}</li> : null}
        </ul>
      )}
      {/* Each row takes at most its content height, so the second group starts below the first list. */}
      <div data-slot="preview-groups" className="grid min-h-0 flex-1 content-start grid-rows-[minmax(0,max-content)_minmax(0,max-content)]">
        <Group title="Newly ignored" group={newlyIgnored} />
        <Group title="No longer ignored" group={noLongerIgnored} />
      </div>
    </>
  );
}

/** One preview group. Spec FR-068: the path rows render only near the visible area. */
function Group({ title, group }: { title: string; group: { count: number; paths: string[] } }) {
  const [open, setOpen] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const virtualizer = useVirtualizer({ count: group.paths.length, getScrollElement: () => scroller.current, estimateSize: () => ROW, overscan: 8 });
  const more = group.count - group.paths.length;
  return (
    <div className="flex min-h-0 flex-col border-t border-divider">
      <h3 id={headingId} className="flex h-7 shrink-0 items-center px-2 font-semibold">
        <button type="button" aria-expanded={open} className="flex items-center gap-1" onClick={() => setOpen((o) => !o)}>
          <HugeiconsIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size)" />
          {`${title} (${formatCount(group.count)})`}
        </button>
      </h3>
      {open ? (
        <div ref={scroller} data-slot="preview-list" className="min-h-0 flex-1 overflow-y-auto">
          <ul aria-labelledby={headingId} className="relative font-mono" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => (
              <li key={item.key} data-slot="preview-path" className="absolute inset-x-0 truncate pr-2 pl-7" style={{ top: item.start, height: ROW, lineHeight: `${ROW}px` }} title={pathText(group.paths[item.index]!)}>
                {pathText(group.paths[item.index]!)}
              </li>
            ))}
          </ul>
          {more > 0 ? <p className="px-2 py-1 text-muted-text">{`and ${formatCount(more)} more paths`}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Plan D15 "Discard modal". Keep editing has the first focus. */
export function DiscardConfirm({ file, onKeep, onDiscard }: { file: string; onKeep(): void; onDiscard(): void }) {
  const keep = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open onOpenChange={(next) => void (next || onKeep())}>
      <DialogContent showCloseButton={false} initialFocus={keep} className="flex flex-col gap-0 p-0">
        <DialogTitle className="px-4 pt-4 pb-3 text-sm/5 font-semibold">{`Discard changes to ${file}?`}</DialogTitle>
        <div className="flex justify-end gap-2 border-t border-divider px-3 py-2">
          <Button ref={keep} variant="outline" onClick={onKeep}>
            Keep editing
          </Button>
          <Button className="bg-removed text-surface hover:bg-removed/80" onClick={onDiscard}>
            Discard
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
