// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { BookPlusIcon, Copy01Icon, ScissorIcon, TextSelectIcon, ViewOffSlashIcon } from "@hugeicons/core-free-icons";
import { useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import { PERSONAL_WORDS } from "../../contracts/limits";
import type { WordRange } from "../../contracts/spell-words";
import { ActionMenu, type ActionItem } from "../components/action-menu";
import type { Spelling } from "./engine";
import { markSpans } from "./SpellMirror";
import { SPELLING_TEXTS as T } from "./texts";
import { wordFits } from "./word-list";

// 006 plan.md D15 "Menu opening", "Suggestion", "Cut and Copy"; D16 "Spelling menu"; D17 texts. Spec FR-005.

type Open = { mark: WordRange; anchor: HTMLElement; byKey: boolean; list: string[]; pending: boolean; selection: boolean };
const noSubscribe = () => () => {};
const noState = () => null;

/** The spelling menu of a marked word. `box` holds the mirror. Every event outside a mark keeps its default, so the built-in menu opens. */
export function useSpellMenu(spelling: Spelling | undefined, field: RefObject<HTMLTextAreaElement | null>, box: RefObject<HTMLElement | null>, notify: (text: string) => void) {
  const [menu, setMenu] = useState<Open | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const state = useSyncExternalStore(spelling?.store.subscribe ?? noSubscribe, spelling?.store.state ?? noState);

  function close() {
    stop.current?.();
    stop.current = null;
    setMenu(null);
  }
  function open(mark: WordRange, anchor: HTMLElement, byKey: boolean) {
    const area = field.current;
    if (spelling === undefined || area === null) return;
    stop.current?.();
    setMenu({ mark, anchor, byKey, list: [], pending: true, selection: area.selectionStart !== area.selectionEnd });
    stop.current = spelling.engine.suggest(mark.word, (list, pending) => setMenu((m) => (m?.mark === mark ? { ...m, list, pending } : m)));
  }

  function onContextMenu(event: MouseEvent<HTMLTextAreaElement>) {
    if (spelling === undefined) return;
    const marks = spelling.engine.view().marks;
    const { clientX: x, clientY: y } = event;
    const spans = markSpans(box.current);
    const hit = spans.findIndex((span) => [...span.getClientRects()].some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom));
    if (hit === -1 || marks[hit] === undefined) return;
    event.preventDefault();
    open(marks[hit], spans[hit]!, false);
  }

  /** Shift+F10 or the Menu key with the caret in a mark. True when it opened the menu. */
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    const area = field.current;
    if (spelling === undefined || area === null) return false;
    const menuKey = (event.key === "F10" && event.shiftKey && !event.ctrlKey && !event.altKey) || (event.key === "ContextMenu" && !event.shiftKey);
    if (!menuKey || area.selectionStart !== area.selectionEnd) return false;
    const caret = area.selectionStart;
    const marks = spelling.engine.view().marks;
    const index = marks.findIndex((m) => m.start <= caret && caret <= m.end);
    const span = markSpans(box.current)[index];
    if (index === -1 || span === undefined) return false;
    event.preventDefault();
    open(marks[index]!, span, true);
    return true;
  }

  /** Plan.md D15: the text in the range must still equal the raw text of the mark. `insertText` keeps one undo step. */
  function replace(mark: WordRange, suggestion: string) {
    const area = field.current;
    if (area === null) return;
    if (area.value.slice(mark.start, mark.end) !== mark.raw) return notify(T.replaceFailed);
    area.focus();
    area.setSelectionRange(mark.start, mark.end);
    if (!document.execCommand("insertText", false, suggestion)) notify(T.replaceFailed);
  }
  function edit(command: "cut" | "copy") {
    field.current?.focus();
    document.execCommand(command);
  }

  let node: ReactNode = null;
  if (spelling !== undefined && menu !== null && state !== null) {
    const { mark } = menu;
    const words = state.words;
    const addReason =
      words.kind === "unreadable" ? T.unreadable : words.kind === "unavailable" ? T.unavailable : words.kind === "loaded" && words.words.length >= PERSONAL_WORDS ? T.full : wordFits(mark.word) ? null : T.long;
    const selectReason = menu.selection ? null : T.selectFirst;
    const first: ActionItem[] = menu.list.map((suggestion) => ({ label: suggestion, onSelect: () => replace(mark, suggestion) }));
    if (menu.pending) first.push({ label: T.finding, reason: "", placeholder: true, onSelect() {} });
    const groups: ActionItem[][] = [
      ...(first.length > 0 ? [first] : []),
      [
        { label: T.ignore, icon: ViewOffSlashIcon, onSelect: () => spelling.store.ignore(mark.word) },
        { label: T.add, icon: BookPlusIcon, reason: addReason, onSelect: () => void spelling.store.add(mark.word).then((outcome) => outcome === "added" || outcome === "listed" || notify(T.addFailed)) },
      ],
      [
        { label: T.cut, icon: ScissorIcon, keys: { aria: "Control+X", text: "Ctrl+X" }, reason: selectReason, onSelect: () => edit("cut") },
        { label: T.copy, icon: Copy01Icon, keys: { aria: "Control+C", text: "Ctrl+C" }, reason: selectReason, onSelect: () => edit("copy") },
        { label: T.selectAll, icon: TextSelectIcon, keys: { aria: "Control+A", text: "Ctrl+A" }, onSelect: () => (field.current?.focus(), field.current?.select()) },
      ],
    ];
    node = <ActionMenu label={T.menu(mark.raw)} groups={groups} open anchor={menu.anchor} byKey={menu.byKey} onOpenChange={(next) => next || close()} finalFocus={field} />;
  }
  return { onContextMenu, onKeyDown, menu: node };
}
