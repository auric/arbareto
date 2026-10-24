// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { createHunspellFromStrings } from "hunspell-wasm";
import { SPELLING_SUGGESTIONS } from "../../contracts/limits";
import { scriptsOf, words } from "../../contracts/spell-words";
import { englishFiles } from "./english";

// 006 plan.md D9, data-model §14: one module worker per loaded language and kind. The engine sends `check` only to a check worker and `suggest` only to a suggestion worker.

// `script`: the catalog Script value of the language. A check worker checks only the words that hold a letter of it (data-model §13, §14).
export type WorkerMessage =
  | { type: "init"; language: string; script: string }
  | { type: "chunk"; file: "aff" | "dic"; data: string }
  | { type: "build"; script: string }
  | { type: "check"; round: number; lines: { start: number; text: string }[] }
  | { type: "suggest"; id: number; word: string };
export type WorkerReply =
  | { type: "loaded" }
  | { type: "load-failed" }
  | { type: "checked"; round: number; ranges: Uint32Array }
  | { type: "suggested"; id: number; list: string[] };

export type SpellCore = { testSpelling(word: string): boolean; getSpellingSuggestions(word: string): string[] };
export type WorkerDeps = { english(): Promise<{ aff: string; dic: string }>; create(aff: string, dic: string): Promise<SpellCore> };

const base64Bytes = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
function joined(parts: Uint8Array[]): Uint8Array {
  const all = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) all.set(part, (at += part.length) - part.length);
  return all;
}

/** The message handler of one worker. `post` sends a reply; `transfer` lists its transferable buffers. */
export function createSpellWorker(post: (reply: WorkerReply, transfer?: Transferable[]) => void, deps: WorkerDeps) {
  let core: SpellCore | null = null;
  let own: string[] = [];
  const chunks: Record<"aff" | "dic", Uint8Array[]> = { aff: [], dic: [] };

  async function load(files: () => Promise<{ aff: string; dic: string }>) {
    try {
      const { aff, dic } = await files();
      core = await deps.create(aff, dic);
      post({ type: "loaded" });
    } catch {
      post({ type: "load-failed" });
    }
  }

  return (message: WorkerMessage) => {
    switch (message.type) {
      case "init":
        own = [message.script];
        void load(deps.english);
        return;
      case "chunk":
        chunks[message.file].push(base64Bytes(message.data));
        return;
      case "build": {
        // Plan.md D9: a byte sequence that is not UTF-8 fails the load.
        own = [message.script];
        const decoder = new TextDecoder("utf-8", { fatal: true });
        void load(async () => ({ aff: decoder.decode(joined(chunks.aff)), dic: decoder.decode(joined(chunks.dic)) }));
        chunks.aff = [];
        chunks.dic = [];
        return;
      }
      case "check": {
        const refused: number[] = [];
        for (const line of message.lines) for (const w of words(line.text, line.start)) if (scriptsOf(w.word, own).size > 0 && !core!.testSpelling(w.word)) refused.push(w.start, w.end);
        const ranges = Uint32Array.from(refused);
        post({ type: "checked", round: message.round, ranges }, [ranges.buffer]);
        return;
      }
      case "suggest":
        post({ type: "suggested", id: message.id, list: core!.getSpellingSuggestions(message.word).slice(0, SPELLING_SUGGESTIONS) });
    }
  };
}

// HTML: `WorkerGlobalScope` exists only in worker scopes. The tests import `createSpellWorker` in a window scope.
declare const WorkerGlobalScope: { new (): unknown } | undefined;
if (typeof WorkerGlobalScope === "function" && globalThis instanceof WorkerGlobalScope) {
  const scope = globalThis as unknown as { postMessage(reply: WorkerReply, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null };
  const handle = createSpellWorker((reply, transfer) => scope.postMessage(reply, transfer ?? []), { english: englishFiles, create: createHunspellFromStrings });
  scope.onmessage = (event) => handle(event.data);
}
