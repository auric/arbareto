// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { ArrowLeft01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import type { Blame } from "../../contracts/envelope";
import type { BlameUnavailableReason } from "../../contracts/errors";
import { OutputTail, unknownFormText } from "../app/RepositoryStates";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { LOCAL_DATE } from "../history/CommitDetails";
import { groupAt, textOf, type BlameState, type Inspection } from "../state/history-view";
import { ageSteps, relativeDate } from "./blame-time";

// Feature 005 plan.md D12, D15 "Blame view", "Blame keys", "Blame texts", and D16 age shades. Spec FR-053 to FR-063, FR-068.

const ROW_HEIGHT = 20;
const VIRTUAL_MIN = 200;
const count = new Intl.NumberFormat("en-US");
// 001 plan.md "History graph design": a short ID is the first 12 hex digits.
const shortId = (oid: string) => oid.slice(0, 12);
const NO_PREVIOUS = "Git names no earlier version of this line.";
const SHALLOW = "Earlier history is not in this clone.";
const STOPPED = "Blame stopped before Git finished.";
const IGNORED = "Ignored. Git skipped the commit of this line.";
const UNBLAMABLE = "Unblamable. Git found no commit for this line after the skip.";
const LEGEND = "The shade ranks the commits of this file by author date. Today's date has no effect.";
const REFUSAL: Record<BlameUnavailableReason, (path?: string) => string> = {
  "no-history": () => "Git has no history for this file.",
  binary: () => "Arbareto does not blame a binary file.",
  submodule: () => "This path is a submodule. Open the submodule to blame its files.",
  size: () => "Arbareto does not blame a file larger than 4 MiB.",
  lines: () => "Arbareto does not blame a file with more than 100,000 lines.",
  "ignore-revs-file-missing": (path) => `Git cannot run blame. The file ${path ?? ""} that blame.ignoreRevsFile names does not exist.`,
  "no-previous": () => NO_PREVIOUS,
  path: () => "Arbareto cannot pass this file name to Git, because it is not valid UTF-8.",
};
const TOGGLES = [
  ["ignoreWhitespace", "Ignore whitespace"],
  ["detectMoves", "Detect moved lines"],
  ["detectCopies", "Detect lines from other files"],
] as const;
const linesText = (n: number) => `${count.format(n)} ${n === 1 ? "line" : "lines"}`;

/** The gutter facts of one commit of the result, computed once per result. */
type CommitFacts = { short: string; author: string; date: string; title: string; age: number; shallow: boolean };
function commitFacts(result: Blame, now: number): CommitFacts[] {
  const ages = ageSteps(result.commits.map((c) => c.authorTime));
  return result.commits.map((c, i) => {
    const filename = c.filenameBytes === result.pathBytes ? null : textOf(c.filenameBytes);
    return {
      short: shortId(c.oid),
      author: textOf(c.author),
      date: relativeDate(c.authorTime, now),
      title: [LOCAL_DATE.format(c.authorTime * 1000), ...(filename === null ? [] : [`Path in this commit: ${filename}`])].join("\n"),
      age: ages[i]!,
      shallow: c.shallow,
    };
  });
}

export type BlameViewProps = {
  inspection: Inspection;
  /** Back and Escape (spec FR-054). */
  onBack(): void;
  /** Enter or a click selects the line's commit in History (spec FR-056). */
  onSelectCommit(oid: string): void;
  /** The clock in milliseconds. */
  now?: () => number;
};

/** The blame view. It takes the place of the History list (plan.md D15 "Blame view"). */
export function BlameView({ inspection, onBack, onSelectCommit, now = Date.now }: BlameViewProps) {
  const blame = useSyncExternalStore(inspection.subscribe, () => inspection.getState().blame, () => inspection.getState().blame);
  const headingId = useId();
  const reasonId = useId();
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => back.current?.focus(), []);
  if (blame === null) return null;
  const result = blame.run.state === "done" ? blame.run.result : null;
  const path = result === null ? blame.request.path : textOf(result.pathBytes);
  const oid = result === null ? blame.request.oid : result.commit;
  const previous = result === null ? null : inspection.previousOf();
  const beforeReason = result !== null && previous === null ? NO_PREVIOUS : null;
  const showSkip = blame.ignoreList === "on" || blame.ignoreList === "off";

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && !event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey) {
      event.preventDefault();
      return onBack();
    }
    // WebView2 maps Alt+Left to back navigation (plan.md D15 "Blame keys").
    if (event.key === "ArrowLeft" && event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey) {
      event.preventDefault();
      if (previous !== null) inspection.blameBefore();
    }
  }

  return (
    <section aria-labelledby={headingId} data-slot="blame-view" className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-divider px-2" style={{ minHeight: "var(--h-pane-heading)" }}>
        <IconButton ref={back} icon={ArrowLeft01Icon} label="Back" keys={{ aria: "Escape", text: "Esc" }} onClick={onBack} />
        <h2 id={headingId} className="min-w-0 flex-1 truncate font-semibold" title={path}>
          Blame: <code>{path}</code> at <code>{shortId(oid)}</code>
        </h2>
        <Button
          variant="outline"
          size="sm"
          style={{ height: 24 }}
          aria-keyshortcuts="Alt+ArrowLeft"
          disabled={previous === null}
          focusableWhenDisabled
          aria-describedby={beforeReason === null ? undefined : reasonId}
          onClick={() => inspection.blameBefore()}
        >
          Blame before this commit (Alt+Left)
        </Button>
        {beforeReason === null ? null : (
          <span id={reasonId} className="basis-full pb-1 text-right text-muted-text">
            {beforeReason}
          </span>
        )}
      </div>
      <div role="toolbar" aria-label="Blame options" className="flex shrink-0 items-center gap-2 border-b border-divider px-2" style={{ minHeight: "var(--h-pane-heading)" }}>
        {TOGGLES.map(([option, label]) => (
          <Button key={option} variant="outline" size="sm" style={{ height: 24 }} aria-pressed={blame.options[option]} onClick={() => inspection.setBlameOptions({ [option]: !blame.options[option] })}>
            {label}
          </Button>
        ))}
        {showSkip ? (
          <>
            <span aria-hidden="true" className="h-5 w-px bg-divider" />
            <Button variant="outline" size="sm" style={{ height: 24 }} aria-pressed={blame.options.ignoreList} onClick={() => inspection.setBlameOptions({ ignoreList: !blame.options.ignoreList })}>
              {blame.options.ignoreList ? <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) text-accent-role" /> : null}
              Skip commits in the ignore list
            </Button>
          </>
        ) : null}
        {result === null ? null : <span className="num ml-auto text-muted-text">{linesText(result.lines)}</span>}
      </div>
      <Body blame={blame} inspection={inspection} headingId={headingId} now={now} onSelectCommit={onSelectCommit} />
      <div role="group" aria-label="Commit age, older to newer" title={LEGEND} className="flex shrink-0 items-center gap-2 border-t border-divider px-2" style={{ minHeight: 28 }}>
        <span className="text-muted-text">Older</span>
        <span aria-hidden="true" className="flex">
          {[1, 2, 3, 4, 5, 6, 7].map((age) => (
            <span key={age} data-age={age} className="age-bar block h-3 w-4" style={{ background: `var(--age-${age})` }} />
          ))}
        </span>
        <span className="text-muted-text">Newer</span>
      </div>
    </section>
  );
}

function Body({ blame, inspection, headingId, now, onSelectCommit }: { blame: BlameState; inspection: Inspection; headingId: string; now: () => number; onSelectCommit(oid: string): void }) {
  const [output, setOutput] = useState(false);
  const run = blame.run;
  if (run.state === "running")
    return (
      <div className="flex min-h-0 flex-1 flex-col items-start gap-2 p-2">
        <p role="status">{run.blamed !== undefined && run.total !== undefined ? `Blaming… ${count.format(run.blamed)} of ${linesText(run.total)}` : "Blaming…"}</p>
        <Button variant="outline" size="sm" onClick={() => inspection.cancelBlame()}>
          Cancel
        </Button>
      </div>
    );
  if (run.state === "stopped") return <p className="min-h-0 flex-1 p-2">{STOPPED}</p>;
  if (run.state === "refused") return <p className="min-h-0 flex-1 p-2">{REFUSAL[run.reason](run.path)}</p>;
  if (run.state === "failed")
    return (
      <div className="flex min-h-0 flex-1 flex-col items-start gap-2 overflow-auto p-2">
        <p>{run.remedy?.text ?? (run.code === null ? unknownFormText("Blame") : `Blame did not complete: ${run.code}.`)}</p>
        {run.code === "GIT_FAILED" && run.outputTail !== undefined ? (
          <>
            <Button variant="outline" size="sm" aria-expanded={output} onClick={() => setOutput((v) => !v)}>
              Show output
            </Button>
            {output ? <OutputTail text={run.outputTail} /> : null}
          </>
        ) : null}
      </div>
    );
  return <Lines result={run.result} line={blame.line} inspection={inspection} headingId={headingId} now={now} onSelectCommit={onSelectCommit} />;
}

type LinesProps = { result: Blame; line: number; inspection: Inspection; headingId: string; now: () => number; onSelectCommit(oid: string): void };

/** The line list: one Tab stop with roving focus (plan.md D15 "Blame keys"). TanStack Virtual renders only the rows near the view (spec FR-068). */
function Lines({ result, line, inspection, headingId, now, onSelectCommit }: LinesProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<number, HTMLElement>());
  const focusWanted = useRef(false);
  const facts = useMemo(() => commitFacts(result, now()), [result]);
  const text = useMemo(() => textOf(result.content).split("\n"), [result]);
  const virtual = result.lines > VIRTUAL_MIN;
  const virtualizer = useVirtualizer({ count: result.lines, enabled: virtual, getScrollElement: () => scroller.current, estimateSize: () => ROW_HEIGHT, overscan: 8 });

  // A new result (Blame before this commit, an option) shows its selected line. Focus stays in the list when it was there.
  useLayoutEffect(() => {
    if (virtual) virtualizer.scrollToIndex(line - 1);
    if (scroller.current?.contains(document.activeElement) || focusWanted.current) {
      focusWanted.current = false;
      elements.current.get(line)?.focus();
    }
  }, [result]);

  function select(next: number) {
    const to = Math.min(result.lines, Math.max(1, next));
    inspection.selectLine(to);
    const element = elements.current.get(to);
    if (element) element.focus();
    else {
      focusWanted.current = true;
      if (virtual) virtualizer.scrollToIndex(to - 1);
    }
  }
  useLayoutEffect(() => {
    if (!focusWanted.current) return;
    const element = elements.current.get(line);
    if (!element) return;
    focusWanted.current = false;
    element.focus();
  });
  const commitOf = (n: number) => {
    const group = groupAt(result, n);
    return group === undefined ? null : result.commits[group.commit]!.oid;
  };

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      const oid = commitOf(line);
      if (oid !== null) onSelectCommit(oid);
      return;
    }
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 0) / ROW_HEIGHT));
    const to =
      event.key === "ArrowDown" ? line + 1
      : event.key === "ArrowUp" ? line - 1
      : event.key === "Home" ? 1
      : event.key === "End" ? result.lines
      : event.key === "PageDown" ? line + page
      : event.key === "PageUp" ? line - page
      : null;
    if (to === null) return;
    event.preventDefault();
    select(to);
  }

  const latest = useRef({ select, commitOf, onSelectCommit });
  latest.current = { select, commitOf, onSelectCommit };
  const [events] = useState<LineEvents>(() => ({
    ref: (n, element) => void (element ? elements.current.set(n, element) : elements.current.delete(n)),
    click: (n) => {
      latest.current.select(n);
      const oid = latest.current.commitOf(n);
      if (oid !== null) latest.current.onSelectCommit(oid);
    },
  }));
  const items = virtual ? virtualizer.getVirtualItems() : Array.from({ length: result.lines }, (_, index) => ({ index, start: index * ROW_HEIGHT }));
  return (
    <div ref={scroller} role="listbox" aria-labelledby={headingId} className="relative min-h-0 flex-1 overflow-auto font-mono" onKeyDown={onKeyDown}>
      <div role="presentation" className="relative" style={{ height: virtual ? virtualizer.getTotalSize() : result.lines * ROW_HEIGHT }}>
        {items.map((item) => {
          const n = item.index + 1;
          const group = groupAt(result, n)!;
          return <Line key={n} n={n} group={group} facts={facts[group.commit]!} content={text[item.index] ?? ""} selected={n === line} top={item.start} events={events} />;
        })}
      </div>
    </div>
  );
}

type LineEvents = { ref(n: number, element: HTMLElement | null): void; click(n: number): void };
type LineProps = { n: number; group: Blame["groups"][number]; facts: CommitFacts; content: string; selected: boolean; top: number; events: LineEvents };

const Line = memo(function Line({ n, group, facts, content, selected, top, events }: LineProps) {
  const first = n === group.finalStart;
  // Plan.md D15: the shallow text goes on the second line of the run, or into the tooltip of a run of one line.
  const shallowLine = facts.shallow && n === group.finalStart + 1;
  const title = first ? (facts.shallow && group.count === 1 ? `${facts.title}\n${SHALLOW}` : facts.title) : undefined;
  const mark = group.ignored ? "?" : group.unblamable ? "*" : null;
  const style: CSSProperties = { position: "absolute", top: 0, left: 0, right: 0, height: ROW_HEIGHT, minHeight: ROW_HEIGHT, transform: `translateY(${top}px)`, gridTemplateColumns: "4px 236px 16px 40px minmax(0, 1fr)" };
  return (
    <div
      ref={(element) => events.ref(n, element)}
      role="option"
      data-line={n}
      tabIndex={selected ? 0 : -1}
      aria-selected={selected}
      aria-label={`Line ${n}, ${facts.short}, ${facts.author}, ${facts.date}${group.ignored ? ", ignored" : group.unblamable ? ", unblamable" : ""}`}
      aria-description={content}
      className={`list-row grid items-center ${first ? "border-t border-divider" : ""}`}
      style={style}
      onClick={(event: MouseEvent) => (event.preventDefault(), events.click(n))}
    >
      <span aria-hidden="true" data-slot="age-bar" data-age={facts.age} className="age-bar h-full" style={{ background: `var(--age-${facts.age})` }} />
      <span aria-hidden="true" data-slot="blame-gutter" title={title} className="flex min-w-0 gap-2 truncate px-2 font-sans">
        {first ? (
          <>
            <span className="font-mono">{facts.short}</span>
            <span className="min-w-0 truncate">{facts.author}</span>
            <span className="ml-auto shrink-0 text-muted-text">{facts.date}</span>
          </>
        ) : shallowLine ? (
          <span className="truncate text-muted-text">{SHALLOW}</span>
        ) : null}
      </span>
      <span aria-hidden="true" data-slot="blame-mark" title={mark === "?" ? IGNORED : mark === "*" ? UNBLAMABLE : undefined} className="text-center">
        {mark}
      </span>
      <span aria-hidden="true" className={`num pr-2 ${selected ? "text-text" : "text-muted-text"}`}>
        {n}
      </span>
      <span aria-hidden="true" className="min-w-0 truncate whitespace-pre">
        {content}
      </span>
    </div>
  );
});
