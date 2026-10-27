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
  | { type: "chunk"; file: "aff" | "dic"; size: number; offset: number; data: Uint8Array<ArrayBuffer> }
  | { type: "build"; script: string }
  | { type: "check"; round: number; lines: { start: number; text: string }[] }
  | { type: "suggest"; id: number; word: string };
export type WorkerReply =
  | { type: "loaded" }
  | { type: "load-failed"; reason: LoadFailure }
  | { type: "checked"; round: number; ranges: Uint32Array }
  | { type: "suggested"; id: number; list: string[] };

/** Plan.md D9 "A downloaded language". */
export type LoadFailure = "chunk" | "short" | "utf-8" | "engine";
export type SpellCore = { testSpelling(word: string): boolean; getSpellingSuggestions(word: string): string[] };
export type WorkerDeps = { english(): Promise<{ aff: string; dic: string }>; create(aff: string | Uint8Array, dic: string | Uint8Array): Promise<SpellCore> };

// One file in transfer: the bytes written so far and the streaming UTF-8 check. No decoded text stays.
type Incoming = { bytes: Uint8Array; written: number; decoder: TextDecoder };
class Refused extends Error {
  constructor(readonly reason: LoadFailure) {
    super(reason);
  }
}

function receive(file: Incoming | undefined, message: Extract<WorkerMessage, { type: "chunk" }>): Incoming {
  if (file === undefined) {
    if (message.offset !== 0 || !Number.isSafeInteger(message.size) || message.size < 0) throw new Refused("chunk");
    file = { bytes: new Uint8Array(message.size), written: 0, decoder: new TextDecoder("utf-8", { fatal: true }) };
  }
  const data = message.data;
  if (message.size !== file.bytes.length || message.offset !== file.written || !(data instanceof Uint8Array) || data.length > file.bytes.length - file.written) throw new Refused("chunk");
  try {
    file.decoder.decode(data, { stream: true });
  } catch {
    throw new Refused("utf-8");
  }
  file.bytes.set(data, file.written);
  file.written += data.length;
  return file;
}

function complete(file: Incoming | undefined): Uint8Array {
  if (file === undefined || file.written !== file.bytes.length) throw new Refused("short");
  try {
    file.decoder.decode();
  } catch {
    throw new Refused("utf-8");
  }
  // `TextDecoder` removed a leading BOM before T058, so Hunspell never got it.
  const bom = file.bytes[0] === 0xef && file.bytes[1] === 0xbb && file.bytes[2] === 0xbf;
  return bom ? file.bytes.subarray(3) : file.bytes;
}

/** The message handler of one worker. `post` sends a reply; `transfer` lists its transferable buffers. */
export function createSpellWorker(post: (reply: WorkerReply, transfer?: Transferable[]) => void, deps: WorkerDeps) {
  let core: SpellCore | null = null;
  let own: string[] = [];
  let incoming: Partial<Record<"aff" | "dic", Incoming>> = {};
  let refused: LoadFailure | null = null;

  async function load(files: () => Promise<{ aff: string | Uint8Array; dic: string | Uint8Array }>) {
    try {
      const { aff, dic } = await files();
      core = await deps.create(aff, dic);
      post({ type: "loaded" });
    } catch (error) {
      post({ type: "load-failed", reason: error instanceof Refused ? error.reason : "engine" });
    }
  }

  return (message: WorkerMessage) => {
    switch (message.type) {
      case "init":
        own = [message.script];
        void load(deps.english);
        return;
      case "chunk":
        if (refused !== null) return;
        try {
          incoming[message.file] = receive(incoming[message.file], message);
        } catch (error) {
          refused = error instanceof Refused ? error.reason : "engine";
          incoming = {};
        }
        return;
      case "build": {
        // Plan.md D9: a byte sequence that is not UTF-8 fails the load.
        own = [message.script];
        const files = incoming;
        const failure = refused;
        incoming = {};
        refused = null;
        void load(async () => {
          if (failure !== null) throw new Refused(failure);
          return { aff: complete(files.aff), dic: complete(files.dic) };
        });
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
  // `hunspell.js` `FS.writeFile` takes a byte array as it is (its `ArrayBuffer.isView` branch), so a downloaded file needs no text form.
  const create = (aff: string | Uint8Array, dic: string | Uint8Array) => createHunspellFromStrings(aff as string, dic as string);
  const handle = createSpellWorker((reply, transfer) => scope.postMessage(reply, transfer ?? []), { english: englishFiles, create });
  scope.onmessage = (event) => handle(event.data);
}
