// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import type { BridgeResponse } from "../../src/frontend/bridge";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { commitReviewed, contractChecked } from "./bridge-contract";
import { click, itemLabel, menuItem } from "./sync-fake";
import type { WordList, WordListState } from "../../src/frontend/spelling/word-list";

// tasks.md T025. 006 quickstart.md Q6, Q7, Q9 to Q11; plan.md D8, D9, D10, D15 to D17; data-model §9 to §15; spec FR-001 to FR-008, SC-001.
// The workers run in this process: each double wraps the real worker handler of spell-worker.ts with a synthetic Hunspell.

printOrigin("../../src/frontend/spelling/engine.ts", import.meta.dir);
printOrigin("../../src/frontend/spelling/spell-worker.ts", import.meta.dir);
printOrigin("../../src/frontend/commit/CommitTray.tsx", import.meta.dir);
registerDom();
const { createRoot } = await import("react-dom/client");
const { CommitTray } = await import("../../src/frontend/commit/CommitTray");
const { createDrafts } = await import("../../src/frontend/state/drafts");
const { createSpellingStore } = await import("../../src/frontend/spelling/store");
const { createSpellEngine } = await import("../../src/frontend/spelling/engine");
const { createSpellWorker } = await import("../../src/frontend/spelling/spell-worker");

const ROOT = join(import.meta.dir, "../..");
const KEY = "a".repeat(64);
const TARGET = { repositoryId: crypto.randomUUID(), repositoryGeneration: 1 };
const HEAD = { state: "branch", target: "refs/heads/main", oid: "1".repeat(40) } as const;
const ok = (result: unknown): BridgeResponse => ({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "succeeded", result }) as BridgeResponse;
const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
async function settle() {
  for (let i = 0; i < 12; i++) await flush();
}
// A real Hunspell load ends after wall time, not after a fixed count of event-loop turns. The timeout bounds the wait.
async function until(done: () => boolean, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > end) throw new Error(`wait: ${timeoutMs} ms`);
    await flush();
  }
  await settle();
}

// The English fixture message (SC-001): three misspellings, correct words, and skipped tokens.
const FIXTURE = "Fix the sync job so it does not recieve stale data\n\nThe parser now handels `fixtureName` in src/app.ts for v1.2.3.\nAsk user@host about snake_case and teh results.";
const MISSPELT = ["recieve", "handels", "teh"];
const CORRECT = ["Fix", "the", "sync", "job", "so", "it", "does", "not", "stale", "data", "The", "parser", "now", "in", "for", "Ask", "about", "and", "results"];
const SKIPPED = ["fixtureName", "src", "app", "ts", "v1", "user", "host", "snake_case"];

// A synthetic Hunspell: the `.dic` lines after the count are the accepted words. A `.aff` line `SUG <word> <a,b,…>` gives its suggestions.
function synthetic(aff: string, dic: string) {
  const accepted = new Set(dic.split("\n").slice(1).filter(Boolean));
  const suggestions = new Map(aff.split("\n").flatMap((line) => (line.startsWith("SUG ") ? [[line.split(" ")[1]!, line.split(" ")[2]!.split(",")] as const] : [])));
  return { testSpelling: (word: string) => accepted.has(word), getSpellingSuggestions: (word: string) => [...(suggestions.get(word) ?? [])] };
}
const asText = (file: string | Uint8Array) => (typeof file === "string" ? file : new TextDecoder().decode(file));
const dicOf = (words: string[]) => `${words.length}\n${words.join("\n")}\n`;
const ENGLISH = { aff: "SET UTF-8\nSUG recieve receive,relieve\nSUG zzq a,b,c,d,e,f,g\n", dic: dicOf([...CORRECT, "receive"]) };
const UKRAINIAN = { "index.aff": "SET UTF-8\nSUG recieve отримати\n", "index.dic": dicOf(["привіт", "світ"]) };

type Message = { type: string; [key: string]: unknown };
class WorkerDouble {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  posted: Message[] = [];
  terminated = false;
  held: boolean;
  private queue: Message[] = [];
  private handle: (message: Message) => void;
  constructor(held: boolean, create: (aff: string | Uint8Array, dic: string | Uint8Array) => Promise<ReturnType<typeof synthetic>>, english: () => Promise<{ aff: string; dic: string }>) {
    this.held = held;
    this.handle = createSpellWorker((reply) => setTimeout(() => this.terminated || this.onmessage?.({ data: reply })), { english, create }) as never;
  }
  postMessage(message: Message) {
    this.posted.push(message);
    if (this.held) this.queue.push(message);
    else this.handle(message);
  }
  release() {
    this.held = false;
    for (const message of this.queue.splice(0)) this.handle(message);
  }
  terminate() {
    this.terminated = true;
  }
  checks() {
    return this.posted.filter((m) => m.type === "check") as unknown as { round: number; lines: { start: number; text: string }[] }[];
  }
}

function fakeClock() {
  const timers: { at: number; run: () => void; id: number }[] = [];
  let now = 0;
  let next = 1;
  return {
    setTimeout: (run: () => void, ms: number) => (timers.push({ at: now + ms, run, id: next }), next++),
    clearTimeout: (id: unknown) => void timers.splice(timers.findIndex((t) => t.id === id) >>> 0, timers.some((t) => t.id === id) ? 1 : 0),
    advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
    },
  };
}

function wordListDouble(initial: WordListState = { kind: "loaded", words: [] }, outcome?: string) {
  const state = { current: initial };
  const added: string[] = [];
  const list: WordList = {
    read: async () => state.current,
    add: async (word: string) => {
      added.push(word);
      if (outcome !== undefined) return outcome as never;
      if (state.current.kind === "loaded") state.current = { kind: "loaded", words: [...state.current.words, word] };
      return "added";
    },
    remove: async () => "removed",
  };
  return { list, added };
}

type Setup = {
  languages?: string[];
  enabled?: boolean;
  files?: Record<string, Record<string, string>>;
  /** Languages whose check worker holds its messages until the test releases it. */
  hold?: string[];
  holdSuggestions?: boolean;
  failCreate?: string[];
  hangRead?: string[];
  clock?: ReturnType<typeof fakeClock>;
  words?: ReturnType<typeof wordListDouble>;
  real?: boolean;
};

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});

async function mount(setup: Setup = {}, extra: Record<string, unknown> = {}) {
  const files: Record<string, Record<string, string>> = { uk: UKRAINIAN, ...setup.files };
  const reads: { language: string; file: string; offset: number }[] = [];
  const cancels: string[] = [];
  const bridge = contractChecked({
    readDictionary(payload: { language: string; file: string; offset: number }, onProgress?: (event: never) => void): Promise<BridgeResponse> {
      reads.push(payload);
      const operationId = crypto.randomUUID();
      onProgress?.({ requestId: crypto.randomUUID(), operationId, state: "running", phase: "dictionary", counters: {} } as never);
      if (setup.hangRead?.includes(payload.language)) {
        hung.push(operationId);
        return new Promise(() => {});
      }
      const bytes = Buffer.from(files[payload.language]![payload.file]!, "utf8");
      return Promise.resolve(ok({ language: payload.language, file: payload.file, size: bytes.length, offset: payload.offset, bytes: bytes.subarray(payload.offset, payload.offset + 1_048_576).toString("base64") }));
    },
    cancel(payload: { operationId: string }): Promise<BridgeResponse> {
      cancels.push(payload.operationId);
      return Promise.resolve(ok({}));
    },
  });
  const hung: string[] = [];
  const workers: { language: string; worker: WorkerDouble }[] = [];
  let created = 0;
  const realCreate = setup.real ? (await import("hunspell-wasm")).createHunspellFromStrings : null;
  const english = async () =>
    setup.real ? { aff: readFileSync(join(ROOT, "node_modules/dictionary-en/index.aff"), "utf8"), dic: readFileSync(join(ROOT, "node_modules/dictionary-en/index.dic"), "utf8") } : ENGLISH;
  const createWorker = async () => {
    created++;
    // The engine names no language at creation, so the double learns it from the first message.
    const slot = { language: "", worker: null as unknown as WorkerDouble };
    // A downloaded language gives bytes (plan.md D9); `hunspell.js` `FS.writeFile` takes them as they are.
    const worker = new WorkerDouble(false, async (aff, dic) => (realCreate ? ((await realCreate(aff as string, dic as string)) as never) : synthetic(asText(aff), asText(dic))), english);
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (message: Message) => {
      if (slot.language === "") {
        slot.language = message.type === "init" ? String(message.language) : "uk";
        const suggestion = workers.some((w) => w.language === slot.language && w.worker !== worker);
        if ((suggestion && setup.holdSuggestions) || (!suggestion && setup.hold?.includes(slot.language))) worker.held = true;
        if (setup.failCreate?.includes(slot.language)) {
          worker.held = true;
          setTimeout(() => worker.onerror?.(new Event("error")));
        }
      }
      post(message);
    };
    slot.worker = worker;
    workers.push(slot);
    return worker;
  };
  const words = setup.words ?? wordListDouble();
  const store = createSpellingStore(words.list);
  store.settings(Promise.resolve(ok({ spelling: { enabled: setup.enabled ?? true, languages: setup.languages ?? ["en"] } })));
  const engine = createSpellEngine(store, { bridge: bridge as never, createWorker: createWorker as never, ...(setup.clock ? { clock: setup.clock } : {}) });
  const drafts = createDrafts({ write: async () => "saved", remove: async () => "saved", read: async () => null } as never);
  const commits: { operation: string; payload: Record<string, unknown>; resolve(r: BridgeResponse): void }[] = [];
  const trayBridge = contractChecked(
    new Proxy({}, { get: (_, operation) => (_t: unknown, payload: Record<string, unknown> = {}) => new Promise<BridgeResponse>((resolve) => commits.push({ operation: String(operation), payload, resolve })) }),
  );
  const notices: string[] = [];
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const props = { bridge: trayBridge, target: TARGET, snapshotId: crypto.randomUUID(), worktreeKey: KEY, drafts, head: HEAD, staged: 1, status: null, requestTrust: async () => true, spelling: { store, engine }, ...extra };
  await act(async () => root.render(<CommitTray {...(props as unknown as Parameters<typeof CommitTray>[0])} />));
  const unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  unmounts.push(unmount);
  await settle();
  const field = host.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  const type = async (text: string) => {
    await act(async () => {
      setter.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
  };
  const marks = () => [...host.querySelectorAll('[data-slot="spell-mirror"] [data-slot="spell-mark"]')].map((e) => e.textContent);
  const described = () => (field.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "");
  const chip = () => host.querySelector('[data-slot="spell-chip"]')?.textContent ?? null;
  const worker = (language: string, index = 0) => workers.filter((w) => w.language === language)[index]?.worker;
  return { host, field, setter, type, marks, described, chip, worker, workers, reads, cancels, hung, store, engine, drafts, commits, notices, words, created: () => created, unmount };
}
type Tray = Awaited<ReturnType<typeof mount>>;

// The layout facts of a mark span: one client rect per span, at the place of its text.
const rects = new Map<string, DOMRect>();
let savedRects: PropertyDescriptor | undefined;
let elementProto: Element | undefined;
beforeAll(() => {
  elementProto = Element.prototype;
  savedRects = Object.getOwnPropertyDescriptor(Element.prototype, "getClientRects");
  Element.prototype.getClientRects = function (this: Element) {
    const rect = this.getAttribute("data-slot") === "spell-mark" ? rects.get(this.textContent ?? "") : undefined;
    return (rect ? [rect] : []) as unknown as DOMRectList;
  };
});
afterAll(() => {
  if (savedRects && elementProto) Object.defineProperty(elementProto, "getClientRects", savedRects);
});

const menuName = () => document.querySelector('[role="menu"]')?.getAttribute("aria-label") ?? null;
const menuLabels = () => [...document.querySelectorAll('[role="menuitem"]')].map(itemLabel);
const separators = () => document.querySelectorAll('[role="menu"] [role="separator"]').length;
async function rightClick(t: Tray, x: number, y: number) {
  const event = new MouseEvent("contextmenu", { clientX: x, clientY: y, bubbles: true, cancelable: true });
  await act(async () => void t.field.dispatchEvent(event));
  await settle();
  return event;
}
async function keyAt(t: Tray, offset: number, init: KeyboardEventInit) {
  t.field.focus();
  t.field.setSelectionRange(offset, offset);
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => void t.field.dispatchEvent(event));
  await settle();
  return event;
}
const reasonOf = (item: Element) => document.getElementById(item.getAttribute("aria-describedby") ?? "")?.textContent ?? null;
async function closeMenu() {
  await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await act(async () => void (document.querySelector('[role="menu"]') as HTMLElement | null)?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await settle();
}

// SC-001 no-network evidence: every network entry point counts its calls.
const network = { count: 0 };
const saved: [object, string, PropertyDescriptor | undefined][] = [];
beforeAll(() => {
  const stub = (owner: object, name: string) => {
    saved.push([owner, name, Object.getOwnPropertyDescriptor(owner, name)]);
    Object.defineProperty(owner, name, { configurable: true, writable: true, value: function () { network.count++; throw new Error(`network: ${name}`); } });
  };
  stub(globalThis, "fetch");
  stub(globalThis, "XMLHttpRequest");
  stub(globalThis, "WebSocket");
  stub(globalThis, "EventSource");
  stub(navigator, "sendBeacon");
});
afterAll(() => {
  for (const [owner, name, descriptor] of saved) if (descriptor) Object.defineProperty(owner, name, descriptor);
  expect(network.count).toBe(0);
});

describe("marks (Q6, SC-001)", () => {
  test("the English fixture message marks every listed misspelling, and no correct word or skipped token", async () => {
    const t = await mount();
    await t.type(FIXTURE);
    expect(t.marks()).toEqual(MISSPELT);
    for (const word of [...CORRECT, ...SKIPPED]) expect(t.marks()).not.toContain(word);
    expect(t.chip()).toBe("Spelling: English");
    expect(t.described()).toContain("3 possible misspellings");
    expect(network.count).toBe(0);
  });

  test("the mirror holds the editor text, sits aria-hidden, and React keeps the textarea text and its guide", async () => {
    const t = await mount();
    await t.type(FIXTURE);
    const mirror = t.host.querySelector('[data-slot="spell-mirror"]')!;
    expect(mirror.getAttribute("aria-hidden")).toBe("true");
    expect(mirror.textContent!.startsWith(FIXTURE)).toBe(true);
    expect(t.field.value).toBe(FIXTURE);
    expect(t.field.getAttribute("data-guide-column")).toBe("72");
    expect(t.field.style.backgroundImage).toContain("linear-gradient");
    expect(t.field.getAttribute("spellcheck")).toBe("false");
  });

  for (const [text, count] of [
    ["Fix the job", "No possible misspellings"],
    ["Fix teh job", "1 possible misspelling"],
    [Array(1_200).fill("zzq").join(" "), "1,200 possible misspellings"],
  ] as const) {
    test(`the count reads "${count}"`, async () => {
      const t = await mount();
      await t.type(text);
      expect(t.described()).toContain(count);
    });
  }

  test("a typed character sends a round of its changed line only", async () => {
    const t = await mount();
    await t.type(FIXTURE);
    const before = t.worker("en")!.checks().length;
    const typed = FIXTURE.replace("teh results", "teh resultsx");
    await t.type(typed);
    const rounds = t.worker("en")!.checks().slice(before);
    expect(rounds.length).toBe(1);
    expect(rounds[0]!.lines).toEqual([{ start: typed.lastIndexOf("\n") + 1, text: typed.slice(typed.lastIndexOf("\n") + 1) }]);
    expect(t.marks()).toEqual([...MISSPELT, "resultsx"]);
  });

  test("marks in later lines move with an edit of an earlier line", async () => {
    const t = await mount();
    await t.type(FIXTURE);
    await t.type(`Fixed ${FIXTURE.slice(4)}`);
    expect(t.marks()).toEqual(["Fixed", ...MISSPELT]);
  });

  test("compositionstart hides every mark and the count; compositionend starts a round", async () => {
    const t = await mount();
    await t.type(FIXTURE);
    await act(async () => void t.field.dispatchEvent(new Event("compositionstart", { bubbles: true })));
    await settle();
    expect(t.marks()).toEqual([]);
    expect(t.described().some((d) => d.includes("possible misspelling"))).toBe(false);
    await t.type(`${FIXTURE} zzq`);
    expect(t.marks()).toEqual([]);
    const before = t.worker("en")!.checks().length;
    await act(async () => void t.field.dispatchEvent(new Event("compositionend", { bubbles: true })));
    await settle();
    expect(t.worker("en")!.checks().length).toBe(before + 1);
    expect(t.marks()).toEqual([...MISSPELT, "zzq"]);
  });

  test("a message above 65,536 UTF-8 bytes runs no round and shows the limit text", async () => {
    const t = await mount();
    await t.type(FIXTURE);
    const before = t.worker("en")!.checks().length;
    await t.type(`${FIXTURE}\n${"я".repeat(32_768)}`);
    expect(t.worker("en")!.checks().length).toBe(before);
    expect(t.marks()).toEqual([]);
    expect(t.described().join("\n")).toContain("Spell check covers at most 64 KiB of text.");
  });

  test("with English and a synthetic Ukrainian, привіт has no mark, recieve has one, and the chip names both (Q10)", async () => {
    const t = await mount({ languages: ["en", "uk"] });
    await t.type("привіт recieve");
    expect(t.marks()).toEqual(["recieve"]);
    expect(t.chip()).toBe("Spelling: English, Ukrainian");
    expect(t.reads.map((r) => [r.language, r.file, r.offset])).toEqual([
      ["uk", "index.aff", 0],
      ["uk", "index.dic", 0],
    ]);
  });

  test("each language checks only the words of its Script: a wrong-layout word gets a mark, a Greek word gets none (Q10)", async () => {
    const t = await mount({ languages: ["en", "uk"] });
    await t.type("привіт recieve cир Ελλάδα");
    expect(t.marks()).toEqual(["recieve", "cир"]);
  });

  test("a wrong-layout word that one responsible language accepts gets no mark", async () => {
    const t = await mount({ languages: ["en", "uk"], files: { uk: { ...UKRAINIAN, "index.dic": dicOf(["привіт", "cир"]) } } });
    await t.type("привіт recieve cир");
    expect(t.marks()).toEqual(["recieve"]);
  });

  test("a round merges only when every check worker of the round replied (data-model §13)", async () => {
    const t = await mount({ languages: ["en", "uk"], hold: ["uk"] });
    await t.type("привіт прывіт recieve");
    // Only English has loaded. It checks no Cyrillic word, so only its Latin refusal decides.
    expect(t.marks()).toEqual(["recieve"]);
    // Ukrainian loads, and its first round goes to both workers. English holds its reply.
    await act(async () => {
      t.worker("en")!.held = true;
      t.worker("uk")!.release();
    });
    await settle();
    expect(t.worker("uk")!.checks().length).toBe(1);
    expect(t.marks()).toEqual(["recieve"]);
    await act(async () => t.worker("en")!.release());
    await settle();
    expect(t.marks()).toEqual(["прывіт", "recieve"]);
  });

  test("a text change during a composition drops the running round, so its old offsets never merge (data-model §13)", async () => {
    const t = await mount();
    await t.type("Fix the\nrecieve it");
    expect(t.marks()).toEqual(["recieve"]);
    const text = "Fix the\nrecieve it\nteh data";
    await act(async () => void (t.worker("en")!.held = true));
    await t.type(text);
    await act(async () => void t.field.dispatchEvent(new Event("compositionstart", { bubbles: true })));
    const composed = `abc${text}`;
    await t.type(composed);
    // The reply of the round of `text` arrives during the composition.
    await act(async () => t.worker("en")!.release());
    await settle();
    await act(async () => void t.field.dispatchEvent(new Event("compositionend", { bubbles: true })));
    await settle();
    expect(t.marks()).toEqual(["abcFix", "recieve", "teh"]);
  });

  test("the merge message field, the diff views, and the file lists get no mirror (FR-002)", () => {
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && /from "[./]*\/spelling\/SpellMirror"/.test(readFileSync(path, "utf8"))) importers.push(path.slice(ROOT.length + 1).replaceAll("\\", "/"));
      }
    };
    walk(join(ROOT, "src/frontend"));
    expect(importers).toEqual(["src/frontend/commit/CommitTray.tsx"]);
  });
});

describe("chip and load states (Q11, FR-008)", () => {
  test("spell check Off shows Spelling: Off with no marks, no count, and no worker", async () => {
    const t = await mount({ enabled: false });
    await t.type(FIXTURE);
    expect(t.chip()).toBe("Spelling: Off");
    expect(t.marks()).toEqual([]);
    expect(t.described().some((d) => d.includes("possible misspelling"))).toBe(false);
    expect(t.created()).toBe(0);
  });

  test("every selected language fails: Spelling: No language loaded with the load text, no marks, and no count", async () => {
    const t = await mount({ failCreate: ["en"] });
    await t.type(FIXTURE);
    expect(t.chip()).toBe("Spelling: No language loaded");
    expect(t.described().join("\n")).toContain("Arbareto cannot load the English dictionary. Spell check uses the other languages.");
    expect(t.marks()).toEqual([]);
    expect(t.described().some((d) => d.includes("possible misspelling"))).toBe(false);
  });

  test("one failed language: the chip names the loaded ones, and its tooltip holds the load text", async () => {
    const t = await mount({ languages: ["en", "uk"], failCreate: ["uk"] });
    await t.type(FIXTURE);
    expect(t.chip()).toBe("Spelling: English");
    expect(t.described().join("\n")).toContain("Arbareto cannot load the Ukrainian dictionary. Spell check uses the other languages.");
    expect(t.marks()).toEqual(MISSPELT);
  });

  test("a language that still loads: the chip names the loaded ones, and its tooltip holds the loading text", async () => {
    const t = await mount({ languages: ["en", "uk"], hold: ["uk"] });
    await t.type(FIXTURE);
    expect(t.chip()).toBe("Spelling: English");
    expect(t.described().join("\n")).toContain("Arbareto still loads the Ukrainian dictionary.");
    expect(t.marks()).toEqual(MISSPELT);
  });

  test("the 30 s load deadline terminates the English worker and shows the load text", async () => {
    const clock = fakeClock();
    const t = await mount({ hold: ["en"], clock });
    await t.type(FIXTURE);
    await act(async () => clock.advance(29_999));
    expect(t.worker("en")!.terminated).toBe(false);
    await act(async () => clock.advance(1));
    await settle();
    expect(t.worker("en")!.terminated).toBe(true);
    expect(t.chip()).toBe("Spelling: No language loaded");
    expect(t.described().join("\n")).toContain("Arbareto cannot load the English dictionary. Spell check uses the other languages.");
  });

  test("the deadline of a downloaded language cancels its running read and terminates its worker", async () => {
    const clock = fakeClock();
    const t = await mount({ languages: ["en", "uk"], hangRead: ["uk"], clock });
    await t.type(FIXTURE);
    await act(async () => clock.advance(30_000));
    await settle();
    expect(t.cancels).toEqual(t.hung);
    // The read never answered, so the Ukrainian worker got no message. The engine starts the workers in selection order.
    expect(t.workers.map((w) => [w.language, w.worker.terminated])).toEqual([
      ["en", false],
      ["", true],
    ]);
    expect(t.described().join("\n")).toContain("Arbareto cannot load the Ukrainian dictionary. Spell check uses the other languages.");
    expect(t.marks()).toEqual(MISSPELT);
  });

  test("spell check Off after a load terminates the worker and removes the marks", async () => {
    const t = await mount();
    await t.type(FIXTURE);
    await act(async () => t.store.settings(Promise.resolve(ok({ spelling: { enabled: false, languages: ["en"] } }))));
    await settle();
    expect(t.worker("en")!.terminated).toBe(true);
    expect(t.marks()).toEqual([]);
    expect(t.chip()).toBe("Spelling: Off");
  });

  test("the newest settings response wins over an older one that answers later", async () => {
    const t = await mount({ enabled: false });
    let older!: (r: BridgeResponse) => void;
    await act(async () => {
      t.store.settings(new Promise((resolve) => (older = resolve)));
      t.store.settings(Promise.resolve(ok({ spelling: { enabled: false, languages: [] } })));
    });
    await settle();
    await act(async () => older(ok({ spelling: { enabled: true, languages: ["en"] } })));
    await settle();
    expect(t.chip()).toBe("Spelling: Off");
  });
});

describe("spelling menu (Q7, FR-005)", () => {
  async function ready(setup: Setup = {}) {
    const t = await mount(setup);
    await t.type(FIXTURE);
    rects.clear();
    rects.set("recieve", new DOMRect(100, 20, 50, 18));
    return t;
  }

  test("right-click inside a mark span opens Spelling of <word>: suggestions, Ignore and Add to dictionary, then Cut, Copy, and Select all", async () => {
    const t = await ready();
    const event = await rightClick(t, 120, 30);
    expect(event.defaultPrevented).toBe(true);
    expect(menuName()).toBe("Spelling of recieve");
    expect(menuLabels()).toEqual(["receive", "relieve", "Ignore", "Add to dictionary", "Cut", "Copy", "Select all"]);
    expect(separators()).toBe(2);
    expect(menuLabels()).not.toContain("Paste");
    const keys = [...document.querySelectorAll('[role="menuitem"]')].map((e) => e.getAttribute("aria-keyshortcuts"));
    expect(keys.slice(4)).toEqual(["Control+X", "Control+C", "Control+A"]);
  });

  test("right-click outside every mark keeps the default", async () => {
    const t = await ready();
    const event = await rightClick(t, 10, 5);
    expect(event.defaultPrevented).toBe(false);
    expect(menuName()).toBeNull();
  });

  for (const [name, init] of [
    ["Shift+F10", { key: "F10", code: "F10", shiftKey: true }],
    ["the Menu key", { key: "ContextMenu", code: "ContextMenu" }],
  ] as const) {
    test(`${name} with the caret at start ≤ o ≤ end opens the menu; elsewhere it keeps the default`, async () => {
      const t = await ready();
      const start = FIXTURE.indexOf("recieve");
      for (const offset of [start, start + 3, start + 7]) {
        const event = await keyAt(t, offset, init);
        expect(event.defaultPrevented).toBe(true);
        expect(menuName()).toBe("Spelling of recieve");
        await closeMenu();
      }
      const event = await keyAt(t, start - 2, init);
      expect(event.defaultPrevented).toBe(false);
      expect(menuName()).toBeNull();
    });
  }

  test("the menu shows at most 5 suggestions", async () => {
    const t = await mount();
    await t.type("Fix zzq");
    rects.clear();
    rects.set("zzq", new DOMRect(40, 0, 20, 18));
    await rightClick(t, 45, 5);
    expect(menuLabels().slice(0, 6)).toEqual(["a", "b", "c", "d", "e", "Ignore"]);
  });

  test("a word without suggestions opens the menu without the first group", async () => {
    const t = await ready();
    rects.set("handels", new DOMRect(200, 60, 50, 18));
    await rightClick(t, 210, 65);
    expect(menuLabels()).toEqual(["Ignore", "Add to dictionary", "Cut", "Copy", "Select all"]);
    expect(separators()).toBe(1);
  });

  test("a suggestion replaces only the word through insertText, after the raw text of its range compared equal", async () => {
    const t = await ready();
    const calls: unknown[][] = [];
    const saved = document.execCommand;
    document.execCommand = ((command: string, _ui: boolean, value: string) => {
      calls.push([command, value, t.field.selectionStart, t.field.selectionEnd]);
      const { selectionStart: s, selectionEnd: e } = t.field;
      t.setter.call(t.field, t.field.value.slice(0, s) + value + t.field.value.slice(e));
      t.field.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }) as never;
    try {
      await rightClick(t, 120, 30);
      await click(menuItem("receive"));
      await settle();
      const start = FIXTURE.indexOf("recieve");
      expect(calls).toEqual([["insertText", "receive", start, start + 7]]);
      expect(t.field.value).toBe(FIXTURE.replace("recieve", "receive"));
      expect(t.drafts.draft(KEY)?.text).toBe(FIXTURE.replace("recieve", "receive"));
      expect(t.marks()).toEqual(["handels", "teh"]);
    } finally {
      document.execCommand = saved;
    }
  });

  test("a changed range or a false insertText return changes nothing and shows the replace text", async () => {
    const t = await ready();
    const calls: string[] = [];
    const saved = document.execCommand;
    document.execCommand = ((command: string) => (calls.push(command), false)) as never;
    try {
      await rightClick(t, 120, 30);
      await t.type(FIXTURE.replace("recieve", "recievx"));
      await click(menuItem("receive"));
      expect(calls).toEqual([]);
      expect(t.host.querySelector('[role="status"]')?.textContent).toBe("Arbareto could not replace the word. The text stays unchanged.");
      await t.type(FIXTURE);
      await rightClick(t, 120, 30);
      await click(menuItem("receive"));
      expect(calls).toEqual(["insertText"]);
      expect(t.field.value).toBe(FIXTURE);
      expect(t.host.querySelector('[role="status"]')?.textContent).toBe("Arbareto could not replace the word. The text stays unchanged.");
    } finally {
      document.execCommand = saved;
    }
  });

  test("Finding suggestions… shows while the suggestion worker computes, and a typed round merges meanwhile", async () => {
    const t = await ready({ holdSuggestions: true });
    await rightClick(t, 120, 30);
    expect(menuLabels()[0]).toBe("Finding suggestions…");
    expect(menuItem("Finding suggestions…").getAttribute("aria-disabled")).toBe("true");
    await t.type(`${FIXTURE} zzq`);
    expect(t.marks()).toEqual([...MISSPELT, "zzq"]);
    expect(menuLabels()[0]).toBe("Finding suggestions…");
    await act(async () => t.worker("en", 1)!.release());
    await settle();
    expect(menuLabels().slice(0, 3)).toEqual(["receive", "relieve", "Ignore"]);
  });

  // Spec FR-014 opens a key menu on its first item. The placeholder is not an item of the word, so the focus skips it.
  test("Shift+F10 never focuses Finding suggestions…, and focus stays on an item when the suggestions replace it", async () => {
    const t = await ready({ holdSuggestions: true });
    await keyAt(t, FIXTURE.indexOf("recieve"), { key: "F10", code: "F10", shiftKey: true });
    expect(menuLabels()[0]).toBe("Finding suggestions…");
    expect(document.activeElement).toBe(menuItem("Ignore"));
    await act(async () => t.worker("en", 1)!.release());
    await settle();
    expect(menuLabels().slice(0, 3)).toEqual(["receive", "relieve", "Ignore"]);
    expect(document.activeElement).toBe(menuItem("Ignore"));
  });

  test("a key menu whose popup holds the focus when the list changes focuses its first enabled item", async () => {
    const t = await ready({ holdSuggestions: true });
    await keyAt(t, FIXTURE.indexOf("recieve"), { key: "F10", code: "F10", shiftKey: true });
    const popup = document.querySelector<HTMLElement>('[role="menu"]')!;
    await act(async () => popup.focus());
    expect(document.activeElement).toBe(popup);
    await act(async () => t.worker("en", 1)!.release());
    await settle();
    expect(document.activeElement).toBe(menuItem("receive"));
  });

  test("the menu asks only the suggestion workers of the languages responsible for the word (data-model §15)", async () => {
    const t = await ready({ languages: ["en", "uk"] });
    await rightClick(t, 120, 30);
    expect(menuLabels().slice(0, 3)).toEqual(["receive", "relieve", "Ignore"]);
    expect(t.workers.filter((w) => w.language === "uk").length).toBe(1);
  });

  test("the suggestion worker loads at the first menu only", async () => {
    const t = await ready();
    expect(t.workers.filter((w) => w.language === "en").length).toBe(1);
    await rightClick(t, 120, 30);
    expect(t.workers.filter((w) => w.language === "en").length).toBe(2);
    await closeMenu();
    await rightClick(t, 120, 30);
    expect(t.workers.filter((w) => w.language === "en").length).toBe(2);
  });

  test("Ignore removes the mark of the word and its case forms for the window session", async () => {
    const t = await ready();
    await rightClick(t, 120, 30);
    await click(menuItem("Ignore"));
    expect(t.marks()).toEqual(["handels", "teh"]);
    await t.type(`${FIXTURE} Recieve RECIEVE ReCieve`);
    expect(t.marks()).toEqual(["handels", "teh", "ReCieve"]);
    await t.unmount();
    unmounts.splice(unmounts.indexOf(t.unmount), 1);
    const again = await mount();
    await again.type(FIXTURE);
    expect(again.marks()).toEqual(MISSPELT);
  });

  test("Add to dictionary saves the word, and the case rule accepts its capital and upper forms", async () => {
    const words = wordListDouble();
    const t = await mount({ words });
    await t.type("Fix kubectl Kubectl KUBECTL KubeCtl");
    rects.clear();
    rects.set("kubectl", new DOMRect(30, 0, 50, 18));
    expect(t.marks()).toEqual(["kubectl", "Kubectl", "KUBECTL", "KubeCtl"]);
    await rightClick(t, 40, 5);
    await click(menuItem("Add to dictionary"));
    await settle();
    expect(words.added).toEqual(["kubectl"]);
    expect(t.marks()).toEqual(["KubeCtl"]);
  });

  for (const [name, state, word, reason] of [
    ["10,000 words", { kind: "loaded", words: Array.from({ length: 10_000 }, (_, i) => `w${i}`) }, "recieve", "The personal word list holds 10,000 words. Remove a word first."],
    ["a word above 100 code points", { kind: "loaded", words: [] }, "q".repeat(101), "A word in the personal word list can have at most 100 characters."],
    ["an unreadable list", { kind: "unreadable" }, "recieve", "Arbareto could not read the personal word list."],
    ["no storage", { kind: "unavailable" }, "recieve", "Arbareto cannot save words, because the app storage is not available."],
  ] as const) {
    test(`Add to dictionary is unavailable with ${name}`, async () => {
      const words = wordListDouble(state as WordListState);
      const t = await mount({ words });
      await t.type(`Fix ${word}`);
      rects.clear();
      rects.set(word, new DOMRect(30, 0, 50, 18));
      await rightClick(t, 40, 5);
      const item = menuItem("Add to dictionary");
      expect(item.getAttribute("aria-disabled")).toBe("true");
      expect(reasonOf(item)).toBe(reason);
      await click(item);
      expect(words.added).toEqual([]);
    });
  }

  test("a failed Add shows its notice, and the text and the draft stay", async () => {
    const words = wordListDouble({ kind: "loaded", words: [] }, "failed");
    const t = await ready({ words });
    await rightClick(t, 120, 30);
    await click(menuItem("Add to dictionary"));
    await settle();
    expect(t.host.querySelector('[role="status"]')?.textContent).toBe("Arbareto could not save the word. The commit and the draft are not affected.");
    expect(t.field.value).toBe(FIXTURE);
    expect(t.drafts.draft(KEY)?.text).toBe(FIXTURE);
  });

  test("Cut and Copy without a selection are unavailable with Select text first.; Select all selects the text", async () => {
    const t = await ready();
    const commands: string[] = [];
    const saved = document.execCommand;
    document.execCommand = ((command: string) => (commands.push(command), true)) as never;
    try {
      const start = FIXTURE.indexOf("recieve");
      await keyAt(t, start, { key: "F10", code: "F10", shiftKey: true });
      for (const label of ["Cut", "Copy"]) expect(reasonOf(menuItem(label))).toBe("Select text first.");
      await click(menuItem("Select all"));
      expect([t.field.selectionStart, t.field.selectionEnd]).toEqual([0, FIXTURE.length]);
      await closeMenu();
      t.field.setSelectionRange(start, start + 7);
      await rightClick(t, 120, 30);
      expect(menuItem("Copy").getAttribute("aria-disabled")).toBeNull();
      await click(menuItem("Copy"));
      expect(commands).toEqual(["copy"]);
    } finally {
      document.execCommand = saved;
    }
  });

  test("Ctrl+V keeps its default in the editor", async () => {
    const t = await ready();
    const event = new KeyboardEvent("keydown", { key: "v", code: "KeyV", keyCode: 86, ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => void t.field.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("commit with marks (FR-007, US1-6)", () => {
  test("Commit sends the message with the marked words unchanged", async () => {
    const t = await mount();
    await t.type(FIXTURE);
    expect(t.marks()).toEqual(MISSPELT);
    const commit = [...t.host.querySelectorAll("button")].find((b) => b.textContent === "Commit (Ctrl+Enter)")!;
    await act(async () => commit.click());
    await settle();
    const answer = async (operation: string, response: BridgeResponse) => {
      await act(async () => t.commits.findLast((c) => c.operation === operation)!.resolve(response));
      await settle();
    };
    await answer("readTrust", ok({ generation: 1, programs: {}, state: "untrusted", persistence: "repository", approvalRequired: { reads: false, commit: false }, entries: [], hooks: [] }));
    await answer("reviewCommit", ok(commitReviewed(crypto.randomUUID())));
    expect(t.commits.findLast((c) => c.operation === "commit")!.payload.message).toBe(FIXTURE);
  });
});

describe("real engine (F15)", () => {
  // research.md R13 records F15 as passed: `OBSERVATION T004: F15 receive=true recieve=false bun=1.4.4`.
  test("hunspell-wasm with the bundled English files marks the fixture misspellings and suggests receive", async () => {
    const t = await mount({ real: true });
    await t.type(FIXTURE);
    await until(() => t.store.state().languages.get("en") !== "loading", 20_000);
    expect(t.store.state().languages.get("en")).toBe("loaded");
    expect(t.marks()).toEqual(MISSPELT);
    rects.clear();
    rects.set("recieve", new DOMRect(100, 20, 50, 18));
    await rightClick(t, 120, 30);
    expect(menuLabels()[0]).toBe("receive");
  }, 30_000);
});

describe("dictionary bytes (T058, plan.md D9)", () => {
  type Given = { aff: unknown; dic: unknown };
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
  const utf8 = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));
  const AFF = utf8("SET UTF-8\n");
  // "привіт" holds 2-byte UTF-8 sequences, so a 7-byte chunk splits the second letter.
  const DIC = utf8("1\nпривіт\n");
  function worker() {
    const replies: { type: string; reason?: string }[] = [];
    const given: Given[] = [];
    const handle = createSpellWorker((reply) => void replies.push(reply as never), {
      english: async () => ENGLISH,
      create: async (aff, dic) => (given.push({ aff, dic }), synthetic("", "0\n")),
    });
    const send = (file: "aff" | "dic", bytes: Uint8Array, step: number, size = bytes.length) => {
      for (let offset = 0; offset === 0 || offset < bytes.length; offset += step) handle({ type: "chunk", file, size, offset, data: b64(bytes.subarray(offset, offset + step)) });
    };
    const build = async () => {
      handle({ type: "build", script: "Cyrillic" });
      for (let i = 0; i < 50 && replies.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 0));
      return replies;
    };
    return { handle, send, build, given };
  }
  let atobCalls = 0;
  const savedAtob = globalThis.atob;
  beforeAll(() => {
    globalThis.atob = (data: string) => (atobCalls++, savedAtob(data));
  });
  afterAll(() => {
    globalThis.atob = savedAtob;
    expect(atobCalls).toBe(0);
  });

  test("the chunk messages carry the file size and the chunk offset", async () => {
    const big = dicOf(Array.from({ length: 120_000 }, (_, i) => `слово${i}`));
    const t = await mount({ languages: ["uk"], files: { uk: { "index.aff": UKRAINIAN["index.aff"], "index.dic": big } } });
    await t.type("привіт");
    await until(() => t.store.state().languages.get("uk") !== "loading", 5_000);
    expect(t.store.state().languages.get("uk")).toBe("loaded");
    const size = Buffer.byteLength(big, "utf8");
    expect(size).toBeGreaterThan(1_048_576);
    const chunks = t.worker("uk")!.posted.filter((m) => m.type === "chunk").map(({ file, size, offset }) => ({ file, size, offset }));
    expect(chunks).toEqual([
      { file: "aff", size: Buffer.byteLength(UKRAINIAN["index.aff"], "utf8"), offset: 0 },
      { file: "dic", size, offset: 0 },
      { file: "dic", size, offset: 1_048_576 },
    ]);
  });

  test("a multi-byte character split across two chunks loads, and Hunspell gets the file bytes", async () => {
    const w = worker();
    w.send("aff", AFF, 4);
    w.send("dic", DIC, 7);
    expect(await w.build()).toEqual([{ type: "loaded" }]);
    expect(w.given).toEqual([{ aff: AFF, dic: DIC }]);
    expect(w.given[0]!.aff).toBeInstanceOf(Uint8Array);
  });

  test("a leading UTF-8 BOM loads, and Hunspell gets the bytes without it", async () => {
    const w = worker();
    w.send("aff", new Uint8Array([0xef, 0xbb, 0xbf, ...AFF]), 2);
    w.send("dic", new Uint8Array([0xef, 0xbb, 0xbf, ...DIC]), 1_048_576);
    expect(await w.build()).toEqual([{ type: "loaded" }]);
    expect(w.given).toEqual([{ aff: AFF, dic: DIC }]);
  });

  test("invalid base64 refuses the load with reason base64", async () => {
    const w = worker();
    w.handle({ type: "chunk", file: "aff", size: 3, offset: 0, data: "A!B=" });
    w.send("dic", DIC, 1_048_576);
    expect(await w.build()).toEqual([{ type: "load-failed", reason: "base64" }]);
    expect(w.given).toEqual([]);
  });

  test("an invalid UTF-8 sequence split across two chunks refuses the load with reason utf-8", async () => {
    const w = worker();
    w.send("aff", AFF, 1_048_576);
    // E2 82 starts a 3-byte sequence; 41 is no continuation byte.
    w.send("dic", new Uint8Array([0x31, 0x0a, 0xe2, 0x82, 0x41, 0x0a]), 4);
    expect(await w.build()).toEqual([{ type: "load-failed", reason: "utf-8" }]);
  });

  test("a file that ends inside a UTF-8 sequence refuses the load with reason utf-8", async () => {
    const w = worker();
    w.send("aff", AFF, 1_048_576);
    w.send("dic", new Uint8Array([0x31, 0x0a, 0xd0]), 2);
    expect(await w.build()).toEqual([{ type: "load-failed", reason: "utf-8" }]);
  });

  test("a truncated last chunk refuses the load with reason short", async () => {
    const w = worker();
    w.send("aff", AFF, 1_048_576);
    w.send("dic", DIC.subarray(0, DIC.length - 2), 1_048_576, DIC.length);
    expect(await w.build()).toEqual([{ type: "load-failed", reason: "short" }]);
  });

  test("a file without a chunk refuses the load with reason short", async () => {
    const w = worker();
    w.send("dic", DIC, 1_048_576);
    expect(await w.build()).toEqual([{ type: "load-failed", reason: "short" }]);
  });

  test("an oversized chunk refuses the load with reason chunk", async () => {
    const w = worker();
    w.send("aff", AFF, 1_048_576);
    w.send("dic", DIC, 1_048_576, DIC.length - 1);
    expect(await w.build()).toEqual([{ type: "load-failed", reason: "chunk" }]);
  });

  test("a chunk at a wrong offset or with another size refuses the load with reason chunk", async () => {
    const gap = worker();
    gap.send("aff", AFF, 1_048_576);
    gap.handle({ type: "chunk", file: "dic", size: DIC.length, offset: 2, data: b64(DIC.subarray(2)) });
    expect(await gap.build()).toEqual([{ type: "load-failed", reason: "chunk" }]);
    const resized = worker();
    resized.send("aff", AFF, 1_048_576);
    resized.handle({ type: "chunk", file: "dic", size: DIC.length, offset: 0, data: b64(DIC.subarray(0, 4)) });
    resized.handle({ type: "chunk", file: "dic", size: DIC.length + 1, offset: 4, data: b64(DIC.subarray(4)) });
    expect(await resized.build()).toEqual([{ type: "load-failed", reason: "chunk" }]);
  });

  test("a failed create refuses the load with reason engine, and the next load starts empty", async () => {
    const replies: unknown[] = [];
    let calls = 0;
    const handle = createSpellWorker((reply) => void replies.push(reply), {
      english: async () => ENGLISH,
      create: async () => {
        if (calls++ === 0) throw new Error("create");
        return synthetic("", "0\n");
      },
    });
    for (let round = 0; round < 2; round++) {
      handle({ type: "chunk", file: "aff", size: AFF.length, offset: 0, data: b64(AFF) });
      handle({ type: "chunk", file: "dic", size: DIC.length, offset: 0, data: b64(DIC) });
      handle({ type: "build", script: "Cyrillic" });
      for (let i = 0; i < 50 && replies.length === round; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(replies).toEqual([{ type: "load-failed", reason: "engine" }, { type: "loaded" }]);
  });

  test("hunspell-wasm loads a downloaded language from bytes", async () => {
    const en = { "index.aff": readFileSync(join(ROOT, "node_modules/dictionary-en/index.aff"), "utf8"), "index.dic": readFileSync(join(ROOT, "node_modules/dictionary-en/index.dic"), "utf8") };
    const t = await mount({ real: true, languages: ["uk"], files: { uk: en } });
    await t.type("привіт");
    await until(() => t.store.state().languages.get("uk") !== "loading", 20_000);
    expect(t.store.state().languages.get("uk")).toBe("loaded");
  }, 30_000);
});
