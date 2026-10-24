// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { COMMIT_MESSAGE_BYTES, DICTIONARY_CHUNK_BYTES, DICTIONARY_LOAD_DEADLINE_MS } from "../../contracts/limits";
import { changedLines, createRounds, mergeMarks, mergeSuggestions, scriptsOf, shiftRanges, type LineChange, type WordRange } from "../../contracts/spell-words";
import type { BridgeResponse, OnProgress } from "../bridge";
import type { WorkerMessage, WorkerReply } from "./spell-worker";
import type { SpellingStore } from "./store";

// 006 plan.md D9, data-model §13 to §15: the workers, the loads and their deadline, the rounds, the merge, and the suggestions.

export type WorkerLike = {
  postMessage(message: WorkerMessage, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: WorkerReply }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};
type Clock = { setTimeout(run: () => void, ms: number): unknown; clearTimeout(id: unknown): void };
type DictionaryFile = "index.aff" | "index.dic";
export type EngineDeps = {
  bridge: {
    readDictionary(payload: { language: string; file: DictionaryFile; offset: number }, onProgress?: OnProgress): Promise<BridgeResponse>;
    cancel(payload: { operationId: string }): Promise<BridgeResponse>;
  };
  createWorker?: () => Promise<WorkerLike>;
  clock?: Clock;
};
/** The mirror input: the editor text and the shown marks. No mark shows during a composition or above 64 KiB. */
export type SpellView = { text: string; marks: readonly WordRange[]; composing: boolean; limited: boolean };

type Asked = { id: number; word: string; sent: boolean; deliver(list: string[] | null): void };
type Slot = {
  id: string;
  kind: "check" | "suggest";
  /** The catalog Script value, or null for an ID outside the catalog. */
  script: string | null;
  worker: WorkerLike | null;
  loaded: boolean;
  ended: boolean;
  busy: boolean;
  timer: unknown;
  done: (() => void) | null;
  read: { operationId?: string; cancel: boolean; sent: boolean } | null;
  /** A check worker: the newest round that waits for its last reply. */
  pending: WorkerMessage | null;
  /** A check worker: its refused ranges in the current text. */
  refused: WordRange[];
  /** A check worker: its first round merged. */
  ready: boolean;
  /** A suggestion worker: the newest request. */
  asked: Asked | null;
};

const encoder = new TextEncoder();
const FILES: readonly DictionaryFile[] = ["index.aff", "index.dic"];

const defaultWorker = async (): Promise<WorkerLike> => {
  const { default: url } = await import("./worker-url");
  return new Worker(url, { type: "module" }) as unknown as WorkerLike;
};
const browserClock: Clock = { setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: (id) => clearTimeout(id as number) };

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}
const lineEnd = (text: string, starts: number[], i: number) => (i + 1 < starts.length ? starts[i + 1]! - 1 : text.length);
// A UTF-16 code unit takes at most 3 UTF-8 bytes, so a short text needs no encode.
const aboveLimit = (text: string) => text.length * 3 > COMMIT_MESSAGE_BYTES && encoder.encode(text).length > COMMIT_MESSAGE_BYTES;

export function createSpellEngine(store: SpellingStore, deps: EngineDeps) {
  const createWorker = deps.createWorker ?? defaultWorker;
  const clock = deps.clock ?? browserClock;
  const checks = new Map<string, Slot>();
  const suggesters = new Map<string, Slot>();
  const rounds = createRounds();
  let round = { id: 0, lines: [] as number[], replies: new Map<string, Uint32Array>() };
  let text = "";
  let composing = false;
  let composedFrom: string | null = null;
  // `limited`: the text is above 64 KiB. `stale`: the refused sets do not belong to the text. `full`: the next round checks every line.
  let limited = false;
  let stale = false;
  let full = true;
  let shown: WordRange[] = [];
  let showing = false;
  let loads: Promise<void> = Promise.resolve();
  let requests = 0;
  let view: SpellView = { text, marks: [], composing, limited };
  const listeners = new Set<() => void>();

  function emit() {
    view = { text, marks: composing || limited ? [] : shown, composing, limited };
    for (const listener of [...listeners]) listener();
  }
  const selected = () => {
    const setting = store.state().setting;
    return setting?.enabled ? setting.languages : [];
  };
  const inSelection = (map: Map<string, Slot>, test: (slot: Slot) => boolean) => selected().flatMap((id) => (map.has(id) && test(map.get(id)!) ? [map.get(id)!] : []));
  // Data-model §13 "Merge": a mark needs the refusal of every responsible language. A language joins after its first round merged.
  const remerge = () => void (shown = limited ? [] : mergeMarks(inSelection(checks, (s) => s.ready).map((s) => ({ script: s.script!, refused: s.refused })), store.accepts));

  function send(slot: Slot, message: WorkerMessage) {
    if (slot.busy) return void (slot.pending = message);
    slot.busy = true;
    slot.worker!.postMessage(message);
  }

  /** Data-model §13 "Round": the changed lines from `prev`, or every line after a load, a removal, or the 64 KiB limit. False when no round starts. */
  function startRound(prev: string | null): boolean {
    const loaded = inSelection(checks, (s) => s.loaded);
    if (loaded.length === 0 || composing || limited) return false;
    const starts = lineStarts(text);
    let lines: number[];
    let change: LineChange | undefined;
    if (full || prev === null) {
      lines = starts.map((_, i) => i);
      full = false;
    } else {
      change = changedLines(prev, text);
      lines = Array.from({ length: change.lastB - change.first + 1 }, (_, k) => change!.first + k);
    }
    const started = rounds.start(
      loaded.map((s) => s.id),
      lines,
      change,
    );
    const inText = started.lines.filter((i) => i < starts.length);
    round = { id: started.round, lines: inText, replies: new Map() };
    const message: WorkerMessage = { type: "check", round: started.round, lines: inText.map((i) => ({ start: starts[i]!, text: text.slice(starts[i]!, lineEnd(text, starts, i)) })) };
    for (const slot of loaded) send(slot, message);
    return true;
  }

  function onChecked(slot: Slot, reply: Extract<WorkerReply, { type: "checked" }>) {
    slot.busy = false;
    const next = slot.pending;
    slot.pending = null;
    if (next !== null) send(slot, next);
    if (reply.round !== round.id) return;
    round.replies.set(slot.id, reply.ranges);
    if (!rounds.reply(reply.round, slot.id)) return;
    const starts = lineStarts(text);
    const spans = round.lines.map((i) => [starts[i]!, lineEnd(text, starts, i)] as const);
    const inRound = (r: WordRange) => spans.some(([s, e]) => r.start >= s && r.start <= e);
    for (const [id, ranges] of round.replies) {
      const target = checks.get(id);
      if (target === undefined) continue;
      const added: WordRange[] = [];
      for (let k = 0; k + 1 < ranges.length; k += 2) {
        const raw = text.slice(ranges[k], ranges[k + 1]);
        added.push({ start: ranges[k]!, end: ranges[k + 1]!, raw, word: raw.normalize("NFC") });
      }
      target.refused = target.refused.filter((r) => !inRound(r)).concat(added).sort((a, b) => a.start - b.start);
      target.ready = true;
    }
    remerge();
    emit();
  }

  function cancelRead(slot: Slot) {
    const read = slot.read;
    if (read === null || read.cancel) return;
    read.cancel = true;
    if (read.operationId !== undefined && !read.sent) {
      read.sent = true;
      void deps.bridge.cancel({ operationId: read.operationId });
    }
  }

  function end(slot: Slot) {
    slot.ended = true;
    clock.clearTimeout(slot.timer);
    cancelRead(slot);
    if (slot.worker !== null) {
      slot.worker.onmessage = null;
      slot.worker.onerror = null;
      slot.worker.terminate();
    }
    slot.done?.();
    slot.done = null;
  }

  /** Plan.md D9: a failed load, an `error` event, or the deadline fails the language for the window session. */
  function fail(slot: Slot) {
    if (slot.ended) return;
    const wasLoaded = slot.loaded;
    end(slot);
    if (slot.kind === "suggest") {
      slot.asked?.deliver(null);
      slot.asked = null;
      return;
    }
    checks.delete(slot.id);
    store.setLanguage(slot.id, "failed");
    if (wasLoaded) {
      full = true;
      startRound(null);
    }
    remerge();
    emit();
  }

  function ask(slot: Slot) {
    const asked = slot.asked;
    if (!slot.loaded || slot.busy || slot.ended || asked === null || asked.sent) return;
    asked.sent = true;
    slot.busy = true;
    slot.worker!.postMessage({ type: "suggest", id: asked.id, word: asked.word });
  }

  function onReply(slot: Slot, reply: WorkerReply) {
    switch (reply.type) {
      case "loaded":
        if (slot.loaded) return;
        clock.clearTimeout(slot.timer);
        slot.loaded = true;
        slot.done?.();
        slot.done = null;
        if (slot.kind === "suggest") return ask(slot);
        full = true;
        store.setLanguage(slot.id, "loaded");
        startRound(null);
        return emit();
      case "load-failed":
        return fail(slot);
      case "checked":
        return onChecked(slot, reply);
      case "suggested": {
        slot.busy = false;
        const asked = slot.asked;
        if (asked?.sent && asked.id === reply.id) {
          slot.asked = null;
          asked.deliver(reply.list);
        }
        return ask(slot);
      }
    }
  }

  async function readFiles(slot: Slot, worker: WorkerLike) {
    for (const file of FILES) {
      for (let offset = 0, size = 1; offset < size; offset += DICTIONARY_CHUNK_BYTES) {
        const read: NonNullable<Slot["read"]> = { cancel: false, sent: false };
        slot.read = read;
        const response = await deps.bridge.readDictionary({ language: slot.id, file, offset }, (event) => {
          read.operationId ??= event.operationId;
          if (read.cancel && !read.sent) {
            read.sent = true;
            void deps.bridge.cancel({ operationId: event.operationId });
          }
        });
        slot.read = null;
        if (slot.ended) return;
        const chunk = response.result as { size?: unknown; bytes?: unknown } | undefined;
        if (response.state !== "succeeded" || typeof chunk?.bytes !== "string" || typeof chunk.size !== "number") return fail(slot);
        size = chunk.size;
        worker.postMessage({ type: "chunk", file: file === "index.aff" ? "aff" : "dic", data: chunk.bytes });
      }
    }
    worker.postMessage({ type: "build", script: slot.script! });
  }

  /** Plan.md D9 "Load order": one load at a time. The deadline runs from `init`, or from the first `readDictionary` call. */
  async function load(slot: Slot): Promise<void> {
    if (slot.ended) return;
    if (slot.script === null) return fail(slot);
    let worker: WorkerLike;
    try {
      worker = await createWorker();
    } catch {
      return fail(slot);
    }
    if (slot.ended) return worker.terminate();
    slot.worker = worker;
    await new Promise<void>((done) => {
      slot.done = done;
      worker.onmessage = (event) => onReply(slot, event.data);
      worker.onerror = () => fail(slot);
      slot.timer = clock.setTimeout(() => fail(slot), DICTIONARY_LOAD_DEADLINE_MS);
      if (slot.id === "en") worker.postMessage({ type: "init", language: "en", script: slot.script! });
      else void readFiles(slot, worker);
    });
  }

  function start(id: string, kind: Slot["kind"]): Slot {
    const script = store.state().catalog?.get(id)?.script ?? null;
    const slot: Slot = { id, kind, script, worker: null, loaded: false, ended: false, busy: false, timer: undefined, done: null, read: null, pending: null, refused: [], ready: false, asked: null };
    loads = loads.then(() => load(slot)).catch(() => fail(slot));
    return slot;
  }

  /** Plan.md D9: Off, Remove, or a cleared selection terminates both workers of a language. */
  function sync() {
    // A worker needs the catalog Script of its language (data-model §14).
    if (!showing || store.state().catalog === null) return;
    const wanted = selected();
    let removed = false;
    for (const [id, slot] of suggesters) if (!wanted.includes(id)) (end(slot), suggesters.delete(id));
    for (const [id, slot] of checks) {
      if (wanted.includes(id)) continue;
      removed ||= slot.loaded;
      end(slot);
      checks.delete(id);
      store.setLanguage(id, null);
    }
    for (const id of wanted) {
      if (checks.has(id) || store.state().languages.get(id) === "failed") continue;
      checks.set(id, start(id, "check"));
      store.setLanguage(id, "loading");
    }
    if (removed) {
      full = true;
      startRound(null);
    }
  }

  const unsubscribe = store.subscribe(() => {
    sync();
    remerge();
    emit();
  });

  return {
    view: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Plan.md D9: the check workers start when the commit editor first shows with spell check on. */
    show() {
      if (showing) return;
      showing = true;
      store.open();
      sync();
    },
    setText(next: string) {
      if (next === text) return;
      const prev = text;
      text = next;
      if (aboveLimit(next)) {
        limited = true;
        stale = true;
        shown = [];
        emit();
        return;
      }
      limited = false;
      if (stale) {
        stale = false;
        full = true;
        for (const slot of checks.values()) slot.refused = [];
        shown = [];
      } else {
        for (const slot of checks.values()) slot.refused = shiftRanges(slot.refused, prev, next);
        shown = shiftRanges(shown, prev, next);
      }
      if (!startRound(prev)) {
        // Data-model §13: the reply of the running round holds offsets of the old text, so it never merges.
        round = { id: -1, lines: [], replies: new Map() };
        full = true;
      }
      emit();
    },
    /** Plan.md D8 "IME": `compositionstart` hides every mark, and `compositionend` starts a round for the changed lines. */
    setComposing(on: boolean) {
      if (on === composing) return;
      composing = on;
      if (on) composedFrom = text;
      else {
        const from = composedFrom ?? text;
        composedFrom = null;
        if (from !== text || full) startRound(full ? null : from);
      }
      emit();
    },
    /** Data-model §15: `onList` gets the joined list and whether a worker still computes. The result stops the updates. */
    suggest(word: string, onList: (list: string[], pending: boolean) => void): () => void {
      const loaded = inSelection(checks, (s) => s.loaded);
      const own = scriptsOf(word, loaded.map((s) => s.script!));
      const order = loaded.filter((s) => own.has(s.script!)).map((s) => s.id);
      const lists = new Map<string, string[] | null>(order.map((id) => [id, null]));
      const id = ++requests;
      let open = true;
      const report = () => open && onList(mergeSuggestions(order.map((l) => lists.get(l) ?? [])), order.some((l) => lists.get(l) === null));
      for (const language of order) {
        let slot = suggesters.get(language);
        if (slot === undefined) suggesters.set(language, (slot = start(language, "suggest")));
        if (slot.ended) {
          lists.set(language, []);
          continue;
        }
        slot.asked = { id, word, sent: false, deliver: (list) => (lists.set(language, list ?? []), report()) };
        ask(slot);
      }
      report();
      return () => {
        open = false;
        for (const language of order) {
          const slot = suggesters.get(language);
          if (slot?.asked?.id === id && !slot.asked.sent) slot.asked = null;
        }
      };
    },
    dispose() {
      unsubscribe();
      for (const slot of [...checks.values(), ...suggesters.values()]) end(slot);
      checks.clear();
      suggesters.clear();
    },
  };
}

export type SpellEngine = ReturnType<typeof createSpellEngine>;
export type Spelling = { store: SpellingStore; engine: SpellEngine };
