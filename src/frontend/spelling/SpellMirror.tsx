// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import type { SpellView } from "./engine";

// 006 plan.md D8 "Box", "Mirror content", and "Mark style". The mirror sits behind the textarea and copies its layout, so each mark lies under its word.

const COPIED = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontStretch",
  "fontKerning",
  "fontFeatureSettings",
  "fontVariantLigatures",
  "fontVariantNumeric",
  "letterSpacing",
  "wordSpacing",
  "lineHeight",
  "textTransform",
  "textIndent",
  "whiteSpace",
  "overflowWrap",
  "wordBreak",
  "direction",
  "unicodeBidi",
  "tabSize",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
] as const;
// Forced colors: the wave takes CanvasText, so the shape stays the cue (plan.md D16).
const MARK = "underline decoration-wavy decoration-removed decoration-1 underline-offset-3 [text-decoration-skip-ink:none] forced-colors:decoration-[CanvasText]";

/** A shown text line: its text with the line feed, and its marks as offsets in the line. */
type Line = { text: string; marks: string; element: HTMLDivElement };
type Next = { text: string; marks: string; start: number; from: number; to: number };
const same = (a: { text: string; marks: string }, b: { text: string; marks: string }) => a.text === b.text && a.marks === b.marks;

function fill(element: HTMLDivElement, line: Next, view: SpellView, last: boolean) {
  const nodes: (Node | string)[] = [];
  let at = line.start;
  for (let k = line.from; k < line.to; k++) {
    const mark = view.marks[k]!;
    if (mark.start > at) nodes.push(view.text.slice(at, mark.start));
    const span = document.createElement("span");
    span.dataset.slot = "spell-mark";
    span.className = MARK;
    span.textContent = view.text.slice(mark.start, mark.end);
    nodes.push(span);
    at = mark.end;
  }
  // A final line feed makes no line box in a block, but the textarea shows that empty line. U+200B fills it.
  const rest = view.text.slice(at, line.start + line.text.length);
  if (last) nodes.push(`${rest}​`);
  else if (rest !== "") nodes.push(rest);
  element.replaceChildren(...nodes);
}

/**
 * Plan.md D8 "Mirror content": one block per text line. Only the lines whose text or marks changed get new nodes.
 * A line feed also ends a bidi paragraph in the textarea, so the blocks keep its bidi layout (SC-009). Only the first block keeps `text-indent`.
 */
function update(box: HTMLDivElement, old: Line[], view: SpellView): Line[] {
  const { text, marks } = view;
  const next: Next[] = [];
  for (let start = 0, k = 0; ; ) {
    const feed = text.indexOf("\n", start);
    const end = feed === -1 ? text.length : feed + 1;
    const from = k;
    let offsets = "";
    // A mark never crosses a line feed (data-model §11).
    for (; k < marks.length && marks[k]!.start < end; k++) offsets += `${marks[k]!.start - start},${marks[k]!.end - start};`;
    next.push({ text: text.slice(start, end), marks: offsets, start, from, to: k });
    if (feed === -1) break;
    start = end;
  }
  let head = 0;
  while (head < old.length && head < next.length && same(old[head]!, next[head]!)) head++;
  let tail = 0;
  while (tail < old.length - head && tail < next.length - head && same(old[old.length - 1 - tail]!, next[next.length - 1 - tail]!)) tail++;
  const lines: Line[] = [...old.slice(0, head), ...new Array<Line>(next.length - head - tail), ...old.slice(old.length - tail)];
  const last = next.length - 1;
  if (old.length === next.length) {
    for (let i = head; i < next.length - tail; i++) {
      const line = next[i]!;
      const element = old[i]!.element;
      if (!same(old[i]!, line)) fill(element, line, view, i === last);
      lines[i] = { text: line.text, marks: line.marks, element };
    }
    return lines;
  }
  for (let i = head; i < old.length - tail; i++) old[i]!.element.remove();
  const added = document.createDocumentFragment();
  for (let i = head; i < next.length - tail; i++) {
    const line = next[i]!;
    const element = document.createElement("div");
    fill(element, line, view, i === last);
    added.append(element);
    lines[i] = { text: line.text, marks: line.marks, element };
  }
  box.insertBefore(added, tail > 0 ? old[old.length - tail]!.element : null);
  return lines;
}

/** The D8 box:the border, the fill, and the focus ring. With `view`, it holds the mirror behind `children`, the textarea of `field`. */
export function SpellMirror({ view, field, children }: { view: SpellView | null; field: RefObject<HTMLTextAreaElement | null>; children: ReactNode }) {
  const mirror = useRef<HTMLDivElement>(null);
  const shown = useRef<{ box: HTMLDivElement | null; lines: Line[] }>({ box: null, lines: [] });
  const on = view !== null;

  useLayoutEffect(() => {
    const area = field.current;
    const box = mirror.current;
    if (area === null || box === null) return;
    // The width is the textarea `clientWidth`, so a scrollbar changes both wraps alike.
    const fit = () => {
      const style = getComputedStyle(area);
      for (const key of COPIED) box.style[key] = style[key];
      box.style.width = `${area.clientWidth}px`;
      box.style.height = `${area.clientHeight}px`;
      box.scrollTop = area.scrollTop;
    };
    const scroll = () => void (box.scrollTop = area.scrollTop);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(area);
    area.addEventListener("input", fit);
    area.addEventListener("scroll", scroll);
    return () => {
      observer.disconnect();
      area.removeEventListener("input", fit);
      area.removeEventListener("scroll", scroll);
    };
  }, [field, on]);

  // React owns the mirror element, not its children. The effect reads no layout, so an input forces none.
  useLayoutEffect(() => {
    const box = mirror.current;
    if (box === null || view === null) return;
    if (shown.current.box !== box) shown.current = { box, lines: [] };
    shown.current.lines = update(box, shown.current.lines, view);
  }, [view]);

  return (
    <div data-slot="spell-box" className="relative min-h-0 rounded-[4px] border border-control-border bg-surface has-[textarea:focus-visible]:ring-2 has-[textarea:focus-visible]:ring-ring/30">
      {on ? <div ref={mirror} data-slot="spell-mirror" aria-hidden="true" className="pointer-events-none absolute top-0 left-0 overflow-hidden border-0 text-transparent forced-color-adjust-none [&>div]:[unicode-bidi:inherit] [&>div+div]:indent-0" /> : null}
      {children}
    </div>
  );
}

/** The mark spans of the mirror, in the order of `view.marks`. */
export const markSpans = (box: Element | null) => [...(box?.querySelectorAll<HTMLElement>('[data-slot="spell-mark"]') ?? [])];
