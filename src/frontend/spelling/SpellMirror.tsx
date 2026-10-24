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

/** The D8 box: the border, the fill, and the focus ring. With `view`, it holds the mirror behind `children`, the textarea of `field`. */
export function SpellMirror({ view, field, children }: { view: SpellView | null; field: RefObject<HTMLTextAreaElement | null>; children: ReactNode }) {
  const mirror = useRef<HTMLDivElement>(null);
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

  // React owns the mirror element, not its children.
  useLayoutEffect(() => {
    const box = mirror.current;
    if (box === null || view === null) return;
    const nodes: (Node | string)[] = [];
    let at = 0;
    for (const mark of view.marks) {
      if (mark.start > at) nodes.push(view.text.slice(at, mark.start));
      const span = document.createElement("span");
      span.dataset.slot = "spell-mark";
      span.className = MARK;
      span.textContent = view.text.slice(mark.start, mark.end);
      nodes.push(span);
      at = mark.end;
    }
    // A final line feed makes no line box in a block, but the textarea shows that empty line. U+200B fills it.
    nodes.push(`${view.text.slice(at)}​`);
    box.replaceChildren(...nodes);
    box.scrollTop = field.current?.scrollTop ?? 0;
  }, [view, field]);

  return (
    <div data-slot="spell-box" className="relative min-h-0 rounded-[4px] border border-control-border bg-surface has-[textarea:focus-visible]:ring-2 has-[textarea:focus-visible]:ring-ring/30">
      {on ? <div ref={mirror} data-slot="spell-mirror" aria-hidden="true" className="pointer-events-none absolute top-0 left-0 overflow-hidden border-0 text-transparent forced-color-adjust-none" /> : null}
      {children}
    </div>
  );
}

/** The mark spans of the mirror, in the order of `view.marks`. */
export const markSpans = (box: Element | null) => [...(box?.querySelectorAll<HTMLElement>('[data-slot="spell-mark"]') ?? [])];
