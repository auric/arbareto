// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { ArrowDown01Icon, ArrowUp01Icon, Delete02Icon, Download04Icon, InformationCircleIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
// Type-only imports keep zod out of the renderer bundle.
import type { Catalog } from "../../contracts/dictionaries";
import { DICTIONARY_CHUNK_BYTES, PERSONAL_WORDS, SPELLING_LANGUAGES } from "../../contracts/limits";
import { sizeText } from "../../contracts/spell-words";
import { compareNames } from "../../contracts/tree-order";
import { codeText, failureText, unknownReadText } from "../app/RepositoryStates";
import type { BridgeResponse, createBridge, ProgressEvent } from "../bridge";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { englishLicence } from "../spelling/english";
import type { RowMessage, SpellingSetting, SpellingStore } from "../spelling/store";
import { SPELLING_TEXTS } from "../spelling/texts";
import { TEXTS } from "./git/texts";
import { LICENCE_TEXTS, LicencePanel, TipButton, type LicenceDocument } from "./LicencePanel";
import type { Change } from "./SettingsDialog";

// 006 plan.md D10 to D12, D15 to D17, data-model §4, §8, §9, §18. Spec FR-009, FR-012 to FR-016, FR-026. Contract Δ3, Δ8.

const count = (n: number) => n.toLocaleString("en-US");

// Plan.md D17 "Spelling page".
/** Plan.md D16: a folder path in a message row uses the code font. */
const folderCode = (folder: string) => <code className="font-mono break-all">{folder}</code>;

export const SPELLING_PAGE = {
  page: "Spelling",
  spellCheck: "Spell check",
  loading: "The dictionary states are still loading…",
  loadFailed: "The dictionary states did not load: ",
  languages: "Languages",
  acceptance: "Download counts as acceptance of the licence.",
  columns: ["Selected", "Language", "Size", "Licence", "State", "Actions", "Remove"],
  licenceTip: "Full licence text",
  bundled: "Bundled",
  notDownloaded: "Not downloaded",
  downloading: (n: number) => `Downloading ${n}%`,
  importing: "Importing…",
  ready: "Ready",
  changed: "Changed",
  failed: "Failed",
  download: "Download",
  retry: "Retry",
  cancel: "Cancel",
  import: "Import…",
  showLicence: "Show licence",
  remove: "Remove",
  name: {
    download: (l: string) => `Download ${l}`,
    retry: (l: string) => `Retry ${l}`,
    cancel: (l: string) => `Cancel the ${l} download`,
    import: (l: string) => `Import… ${l}`,
    showLicence: (l: string) => `Show licence of ${l}`,
    remove: (l: string) => `Remove ${l}`,
    select: (l: string) => `Select ${l}`,
    progress: (l: string) => `Download ${l}`,
  },
  readme: LICENCE_TEXTS.readme,
  transport: (l: string) => `Arbareto could not download the ${l} dictionary. Check the connection, then select Retry, or use Import.`,
  notFound: (l: string) => `The download host has no ${l} dictionary file at the pinned source. Use Import, or update Arbareto.`,
  rateLimit: "The download host limits downloads now (HTTP 429). Select Retry later, or use Import.",
  httpStatus: (l: string, status: number) => `The download host answered HTTP ${status} for the ${l} dictionary. Arbareto kept no file.`,
  redirect: (l: string) => `The download host moved the ${l} dictionary file. Arbareto stopped the download. Use Import, or update Arbareto.`,
  notHttps: (l: string) => `The ${l} catalog entry has no HTTPS URL. Arbareto did not download it.`,
  deadline: (l: string) => `The ${l} download did not end within 120 seconds. Arbareto kept no file. Select Retry, or use Import.`,
  mismatch: (l: string) => `The downloaded ${l} file does not match the catalog. Arbareto deleted it.`,
  canceled: "Download canceled. Arbareto kept no file.",
  save: (l: string, folder: string) => <>Arbareto could not save the {l} dictionary in {folderCode(folder)}.</>,
  changedFiles: (l: string) => `The ${l} dictionary files changed. Download the dictionary again.`,
  importMismatch: (l: string) => `These files are not the ${l} files of the catalog. Arbareto did not import them.`,
  catalogChanged: (l: string) => `This Arbareto release has new ${l} dictionary files. Download the dictionary again.`,
  catalogRemoved: (l: string) => `This Arbareto release has no ${l} dictionary. Arbareto removed it.`,
  // Proposed 2026-10-25, pending user confirmation (plan.md D17).
  catalogRemovedMore: (n: number) => (n === 1 ? "This Arbareto release has no 1 other dictionary. Arbareto removed it." : `This Arbareto release has no ${count(n)} other dictionaries. Arbareto removed them.`),
  importDeadline: (l: string) => `The ${l} import did not end within 120 seconds. Arbareto did not import the files. Select Import… again.`,
  pickerFailed: "Arbareto could not open the folder picker. Select Import… again.",
  busy: "Another dictionary download or import runs. Wait for it to end.",
  importUnreadable: (l: string, folder: string) => <>Arbareto could not read the {l} files in {folderCode(folder)}.</>,
  removeFailed: (l: string, folder: string) => <>Arbareto could not remove the {l} dictionary from {folderCode(folder)}.</>,
  link: (url: string) => `Windows could not open the link. The address is ${url}.`,
  note: "Select at most 3 languages. English counts as one.",
  limit: "You can select at most 3 languages. Clear one first.",
  notReady: (l: string) => `Download or import the ${l} dictionary first.`,
  selected: "Selected languages",
  moveUp: (l: string) => `Move ${l} up`,
  moveUpTip: "Move up (Alt+Up)",
  first: (l: string) => `${l} is already first.`,
  moveDown: (l: string) => `Move ${l} down`,
  moveDownTip: "Move down (Alt+Down)",
  last: (l: string) => `${l} is already last.`,
  preview: (names: readonly string[]) => `Chip: ${SPELLING_TEXTS.chip(names)}`,
  noneSelected: "No language is selected. Spell check marks no word.",
  words: "Personal word list",
  wordCount: (n: number) => `${count(n)} of ${count(PERSONAL_WORDS)} words`,
  removeWord: (w: string) => `Remove ${w}`,
  noWords: "No words yet. Add a word from the spelling menu of the commit message.",
  wordRemoveFailed: (w: string) => `Arbareto could not remove ${w} from the personal word list.`,
};

export type SpellingBridge = Pick<ReturnType<typeof createBridge>, "listDictionaries" | "readDictionary" | "downloadDictionary" | "importDictionary" | "removeDictionary" | "setSpelling" | "openLicenceLink" | "cancel">;
type Entry = Pick<Catalog["bundled"], "id" | "name" | "license" | "files" | "licences">;
type Listed = { languages: ReadonlyMap<string, { state: string; notice?: string }>; removed: readonly { language: string; name: string }[]; more: number };
type ListRead = { state: "loading" } | { state: "loaded"; value: Listed } | { state: "failed"; text: ReactNode };
type Refusal = { reason?: unknown; status?: unknown; folder?: unknown; url?: unknown } | undefined;
type Action = "download" | "retry" | "cancel" | "importFolder" | "licence";

const encoder = new TextEncoder();
const VIRTUAL_MIN = 200;
const WORD_ROW = 28;

function listedOf(response: BridgeResponse): Listed | null {
  const r = response.result as { languages?: unknown; removed?: unknown; more?: unknown } | undefined;
  if (response.state !== "succeeded" || !Array.isArray(r?.languages) || !Array.isArray(r.removed) || typeof r.more !== "number") return null;
  return { languages: new Map((r.languages as { language: string; state: string; notice?: string }[]).map((l) => [l.language, l])), removed: r.removed as Listed["removed"], more: r.more };
}

/** Plan.md D17: the fallback text of any other code, "<item> did not complete: <code>." */
const otherText = (item: string, response: BridgeResponse): ReactNode => (response.state === "succeeded" ? failureText(item, response) : <>{failureText(item, response)}.</>);

/** Contract Δ3 and Δ9: the D17 text of a run end. The reason and the code decide, never a message text (spec FR-016). */
function runMessage(kind: "download" | "importFolder", name: string, response: BridgeResponse): RowMessage | null {
  if (response.state === "succeeded" && (response.result as { state?: unknown } | undefined)?.state === "ready") return null;
  const item = kind === "download" ? SPELLING_PAGE.name.download(name) : SPELLING_PAGE.name.import(name);
  if (response.state === "canceled") return kind === "download" ? { text: SPELLING_PAGE.canceled, failed: false, retry: false } : null;
  const download = kind === "download";
  const failed = (text: ReactNode, retry = download): RowMessage => ({ text, failed: download, retry });
  if (response.code === "DEADLINE") return download ? failed(SPELLING_PAGE.deadline(name)) : { text: SPELLING_PAGE.importDeadline(name), failed: false, retry: false };
  if (response.code === "PICKER_FAILED" && !download) return { text: SPELLING_PAGE.pickerFailed, failed: false, retry: false };
  const refusal = response.code === "DICTIONARY_UNAVAILABLE" ? (response.result as Refusal) : undefined;
  const folder = typeof refusal?.folder === "string" ? refusal.folder : "";
  switch (refusal?.reason) {
    case "transport":
      return failed(SPELLING_PAGE.transport(name));
    case "http-not-found":
      return failed(SPELLING_PAGE.notFound(name));
    case "http-rate-limit":
      return failed(SPELLING_PAGE.rateLimit);
    case "http-status":
      return failed(SPELLING_PAGE.httpStatus(name, refusal.status as number));
    case "redirect":
      return failed(SPELLING_PAGE.redirect(name));
    case "not-https":
      return failed(SPELLING_PAGE.notHttps(name), false);
    case "mismatch":
      return failed(SPELLING_PAGE.mismatch(name));
    case "save":
      return failed(SPELLING_PAGE.save(name, folder));
    case "import-mismatch":
      return { text: SPELLING_PAGE.importMismatch(name), failed: false, retry: false };
    case "import-unreadable":
      return { text: SPELLING_PAGE.importUnreadable(name, folder), failed: false, retry: false };
    case "busy":
      return { text: SPELLING_PAGE.busy, failed: false, retry: false };
  }
  return { text: otherText(item, response), failed: false, retry: false };
}

const decode = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

/** Plan.md D16 "Keys": one Tab stop per list with roving focus. Up, Down, Home, and End move between rows, Left and Right between the controls of a row. */
function useGrid(rows: number, scrollTo?: (row: number) => void, external?: RefObject<HTMLDivElement | null>) {
  const own = useRef<HTMLDivElement>(null);
  const root = external ?? own;
  const at = useRef({ row: 0, col: 0 });
  const pending = useRef<{ row: number; col: number } | null>(null);
  // The focused cell. A render that removes it moves focus to the Tab stop, so focus never falls to the page.
  const last = useRef<HTMLElement | null>(null);
  const rowElement = (row: number) => root.current?.querySelector<HTMLElement>(`[data-grid-row="${row}"]`) ?? null;
  const cells = (row: Element | null) => (row === null ? [] : [...row.querySelectorAll<HTMLElement>("[data-cell]")]);
  const cellAt = (row: number, col: number) => {
    const all = cells(rowElement(row));
    return all[Math.min(col, all.length - 1)] ?? null;
  };
  useLayoutEffect(() => {
    const container = root.current;
    if (container === null) return;
    for (const cell of container.querySelectorAll<HTMLElement>("[data-cell]")) cell.tabIndex = -1;
    at.current.row = Math.max(0, Math.min(at.current.row, rows - 1));
    const stop = cellAt(at.current.row, at.current.col) ?? cells(container.querySelector("[data-grid-row]"))[0] ?? null;
    if (stop !== null) stop.tabIndex = 0;
    const want = pending.current;
    if (want !== null) {
      const target = cellAt(Math.min(want.row, rows - 1), want.col);
      if (target !== null) {
        pending.current = null;
        target.focus();
      }
    } else if (last.current !== null && !last.current.isConnected && (document.activeElement === null || document.activeElement === document.body)) stop?.focus();
    last.current = container.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
  });
  function focus(row: number, col = at.current.col) {
    at.current = { row, col };
    const target = cellAt(row, col);
    if (target !== null && rowElement(row) !== null) return target.focus();
    pending.current = { row, col };
    scrollTo?.(row);
  }
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-cell]");
    const row = cell?.closest<HTMLElement>("[data-grid-row]");
    if (!cell || !row) return;
    const r = Number(row.dataset.gridRow);
    const c = cells(row).indexOf(cell);
    const last = rows - 1;
    const to = event.key === "ArrowDown" ? [r + 1, c] : event.key === "ArrowUp" ? [r - 1, c] : event.key === "Home" ? [0, c] : event.key === "End" ? [last, c] : event.key === "ArrowRight" ? [r, c + 1] : event.key === "ArrowLeft" ? [r, c - 1] : null;
    if (to === null) return;
    event.preventDefault();
    focus(Math.max(0, Math.min(last, to[0]!)), Math.max(0, to[1]!));
  }
  function onFocus(event: { target: EventTarget }) {
    const cell = (event.target as HTMLElement).closest?.<HTMLElement>("[data-cell]");
    const row = cell?.closest<HTMLElement>("[data-grid-row]");
    if (!cell || !row) return;
    at.current = { row: Number(row.dataset.gridRow), col: cells(row).indexOf(cell) };
    for (const other of root.current?.querySelectorAll<HTMLElement>("[data-cell]") ?? []) other.tabIndex = other === cell ? 0 : -1;
    last.current = cell;
  }
  return { root, focus, onKeyDown, onFocus };
}

function Panel({ heading, count: n, extra, className, children }: { heading: string; count?: number; extra?: ReactNode; className?: string; children: (headingId: string) => ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={`flex min-h-0 min-w-0 flex-col rounded-[4px] border border-divider bg-canvas ${className ?? ""}`}>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-divider pr-2 pl-3">
        <h4 id={id} className="font-semibold">
          {heading}
        </h4>
        {n === undefined ? null : <span className="text-muted-text tabular-nums">{count(n)}</span>}
        <span className="flex-1" />
        {extra}
      </div>
      {children(id)}
    </section>
  );
}

function RowButton({ icon, label, name, ...props }: { icon?: IconSvgElement; label: string; name: string; onClick(): void; className?: string; "data-licence"?: string }) {
  return (
    <Button variant="outline" size="sm" data-cell aria-label={name} {...props}>
      {icon === undefined ? null : <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size)" />}
      {label}
    </Button>
  );
}

export type SpellingPageProps = {
  bridge: SpellingBridge;
  store: SpellingStore;
  /** The Settings view change path: one settings operation at a time, and the 004 failure text. */
  change: Change;
};

export function SpellingPage({ bridge, store, change }: SpellingPageProps) {
  const state = useSyncExternalStore(store.subscribe, store.state);
  const [catalog, setCatalog] = useState<readonly Entry[] | null | "failed">(null);
  const [list, setList] = useState<ListRead>({ state: "loading" });
  const [licence, setLicence] = useState<{ entry: Entry; documents: LicenceDocument[] | null; failure: ReactNode } | null>(null);
  const [wordFailure, setWordFailure] = useState<string | null>(null);
  const listSeq = useRef(0);
  const licenceSeq = useRef(0);
  const mounted = useRef(true);
  const reopen = useRef<string | null>(null);
  const page = useRef<HTMLDivElement>(null);
  const ids = { switchLabel: useId(), limit: useId() };

  const reload = useRef(() => {});
  reload.current = () => {
    const mine = ++listSeq.current;
    void bridge.listDictionaries().then((response) => {
      if (!mounted.current || mine !== listSeq.current) return;
      const value = listedOf(response);
      setList(value !== null ? { state: "loaded", value } : { state: "failed", text: response.state === "succeeded" ? unknownReadText("The dictionary states") : <>{codeText(SPELLING_PAGE.loadFailed, response.code ?? response.state)}.</> });
    });
  };
  useEffect(() => {
    mounted.current = true;
    reload.current();
    void store.readWords();
    void import("../../contracts/dictionaries.json").then(
      ({ default: c }) => mounted.current && setCatalog([c.bundled as Entry, ...(c.entries as Entry[])]),
      () => mounted.current && setCatalog("failed"),
    );
    return () => void (mounted.current = false);
  }, [bridge, store]);
  useLayoutEffect(() => {
    const id = reopen.current;
    if (id === null) return;
    reopen.current = null;
    page.current?.querySelector<HTMLElement>(`[data-licence="${id}"]`)?.focus();
  });

  const setting = state.setting;
  const entries = Array.isArray(catalog) ? catalog : null;
  const byId = useMemo(() => new Map((entries ?? []).map((e) => [e.id, e])), [entries]);
  const languages = useGrid(entries?.length ?? 0);
  const chosen = useGrid(setting?.languages.length ?? 0);
  const words = state.words.kind === "loaded" ? state.words.words : null;
  const sorted = useMemo(() => (words === null ? [] : [...words].sort((a, b) => compareNames(encoder.encode(a), encoder.encode(b)))), [words]);
  const scroller = useRef<HTMLDivElement>(null);
  const virtual = sorted.length > VIRTUAL_MIN;
  const virtualizer = useVirtualizer({ count: sorted.length, enabled: virtual, getScrollElement: () => scroller.current, estimateSize: () => WORD_ROW, overscan: 8 });
  const wordGrid = useGrid(sorted.length, (row) => virtualizer.scrollToIndex(row), scroller);
  const countLine = useRef<HTMLParagraphElement>(null);
  // Move up and Move down: focus follows the language once the new order shows.
  const follow = useRef<{ id: string; to: number; col: number } | null>(null);
  useLayoutEffect(() => {
    const moved = follow.current;
    if (moved === null || chosen.root.current?.querySelector(`[data-grid-row="${moved.to}"]`)?.getAttribute("data-language") !== moved.id) return;
    follow.current = null;
    chosen.focus(moved.to, moved.col);
  });

  if (catalog === "failed") return <p role="alert">{unknownReadText("The dictionary states")}</p>;
  if (list.state === "failed") return <p role="alert">{list.text}</p>;
  if (entries === null || list.state === "loading" || setting === null) return <p className="text-muted-text">{SPELLING_PAGE.loading}</p>;
  const listed = list.value;
  const selection = setting;
  const nameOf = (id: string) => byId.get(id)?.name ?? id;

  const send = (next: SpellingSetting) =>
    void change(async () => {
      const response = await bridge.setSpelling({ enabled: next.enabled, languages: [...next.languages] });
      if (response.state === "succeeded") store.settings(Promise.resolve(response));
      return response;
    });

  async function run(kind: "download" | "importFolder", entry: Entry) {
    const id = entry.id;
    const tracked = store.state().run === null;
    store.setMessage(id, null);
    const total = entry.files.reduce((sum, f) => sum + f.size, 0);
    if (tracked) store.setRun({ language: id, kind, cancel: false, received: 0, total });
    const onProgress = (event: ProgressEvent) => {
      const before = store.state().run;
      if (!tracked || (before !== null && before.language !== id)) return;
      const counters = event.phase === "dictionary" ? (event.counters as { received?: number; total?: number }) : {};
      store.setRun({ language: id, kind, cancel: before?.cancel ?? false, received: counters.received ?? before?.received ?? 0, total: counters.total ?? before?.total ?? total, operationId: event.operationId });
      // A Cancel before the first event waits for the operation ID.
      if (before?.cancel && before.operationId === undefined) void bridge.cancel({ operationId: event.operationId });
    };
    const response = await (kind === "download" ? bridge.downloadDictionary({ language: id }, onProgress) : bridge.importDictionary({ language: id }, onProgress));
    if (tracked) store.setRun(null);
    const message = runMessage(kind, entry.name, response);
    store.setMessage(id, message);
    // Data-model §4: a run of the row ends the load failure of this window session, so the engine loads the new files.
    if (message === null && response.state === "succeeded" && store.state().languages.get(id) === "failed") store.setLanguage(id, null);
    if (mounted.current) reload.current();
  }
  function cancel() {
    const current = store.state().run;
    if (current === null || current.cancel) return;
    store.setRun({ ...current, cancel: true });
    if (current.operationId !== undefined) void bridge.cancel({ operationId: current.operationId });
  }
  async function remove(entry: Entry) {
    const response = await bridge.removeDictionary({ language: entry.id });
    const refusal = response.code === "DICTIONARY_UNAVAILABLE" ? (response.result as Refusal) : undefined;
    if (response.state === "succeeded") {
      store.setMessage(entry.id, null);
      // Spec FR-014: Remove takes the language out of the selection.
      const now = store.state().setting;
      if (now !== null && now.languages.includes(entry.id)) send({ enabled: now.enabled, languages: now.languages.filter((l) => l !== entry.id) });
    } else
      store.setMessage(entry.id, {
        text: refusal?.reason === "busy" ? SPELLING_PAGE.busy : refusal?.reason === "remove" ? SPELLING_PAGE.removeFailed(entry.name, String(refusal.folder)) : otherText(SPELLING_PAGE.name.remove(entry.name), response),
        failed: false,
        retry: false,
      });
    if (mounted.current) reload.current();
  }
  async function openLink(entry: Entry) {
    const response = await bridge.openLicenceLink({ language: entry.id });
    if (response.state === "succeeded") return;
    const refusal = response.result as Refusal;
    store.setMessage(entry.id, { text: refusal?.reason === "link" && typeof refusal.url === "string" ? SPELLING_PAGE.link(refusal.url) : otherText(SPELLING_PAGE.licenceTip, response), failed: false, retry: false });
  }
  /** Plan.md D12: the chunks of one licence document, decoded as UTF-8. */
  async function readDocument(entry: Entry, file: Entry["licences"][number]): Promise<{ doc: LicenceDocument } | { failure: ReactNode }> {
    const parts: Uint8Array[] = [];
    for (let offset = 0, size = 1; offset < size; offset += DICTIONARY_CHUNK_BYTES) {
      const response = await bridge.readDictionary({ language: entry.id, file, offset });
      const chunk = response.result as { size?: unknown; bytes?: unknown } | undefined;
      if (response.state !== "succeeded") return { failure: <>{codeText(LICENCE_TEXTS.failed, response.code ?? response.state)}.</> };
      if (typeof chunk?.bytes !== "string" || typeof chunk.size !== "number") return { failure: unknownReadText("The licence text") };
      size = chunk.size;
      parts.push(decode(chunk.bytes));
    }
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((at, p) => (bytes.set(p, at), at + p.length), 0);
    return { doc: { file, text: new TextDecoder("utf-8").decode(bytes), bytes: bytes.length } };
  }
  async function showLicence(entry: Entry) {
    const mine = ++licenceSeq.current;
    setLicence({ entry, documents: null, failure: null });
    let documents: LicenceDocument[] = [];
    let failure: ReactNode = null;
    if (entry.id === "en") {
      try {
        const text = await englishLicence();
        documents = [{ file: entry.licences[0]!, text, bytes: encoder.encode(text).length }];
      } catch {
        failure = unknownReadText("The licence text");
      }
    } else
      for (const file of entry.licences) {
        const read = await readDocument(entry, file);
        if ("doc" in read) documents.push(read.doc);
        else {
          failure = read.failure;
          break;
        }
      }
    if (mounted.current && mine === licenceSeq.current) setLicence({ entry, documents: failure === null ? documents : null, failure });
  }
  function closeLicence() {
    if (licence === null) return;
    licenceSeq.current++;
    reopen.current = licence.entry.id;
    setLicence(null);
  }

  /** Data-model §4: the row state, its actions, and its message row. */
  function rowOf(entry: Entry) {
    const id = entry.id;
    const service = listed.languages.get(id);
    const selected = selection.languages.includes(id);
    const message = state.messages.get(id);
    const loadFailed = selected && state.languages.get(id) === "failed";
    const running = state.run?.language === id ? state.run : null;
    let label: ReactNode;
    let tone = "";
    let actions: Action[] = [];
    let removable = false;
    let ready = false;
    if (id === "en") {
      label = SPELLING_PAGE.bundled;
      actions = ["licence"];
      ready = true;
    } else if (running?.kind === "download" || service?.state === "downloading") {
      const percent = running === null || running.total === 0 ? 0 : Math.floor((100 * running.received) / running.total);
      label = (
        <span className="flex items-center gap-2">
          <span role="progressbar" aria-label={SPELLING_PAGE.name.progress(entry.name)} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} className="h-1 w-16 overflow-hidden rounded-[2px] bg-hover-fill [forced-color-adjust:auto]">
            <span className="block h-1 bg-accent-role" style={{ width: `${percent}%` }} />
          </span>
          <span className="tabular-nums">{SPELLING_PAGE.downloading(percent)}</span>
        </span>
      );
      actions = running === null ? [] : ["cancel"];
    } else if (running?.kind === "importFolder" || service?.state === "importing") label = SPELLING_PAGE.importing;
    else if (message?.failed) {
      label = SPELLING_PAGE.failed;
      tone = "text-warning";
      actions = message.retry ? ["retry", "importFolder"] : ["importFolder"];
      removable = service?.state === "ready" || service?.state === "changed";
    } else if (loadFailed && service?.state === "ready") {
      label = SPELLING_PAGE.failed;
      tone = "text-warning";
      removable = true;
    } else if (service?.state === "ready") {
      label = SPELLING_PAGE.ready;
      actions = ["licence"];
      removable = true;
      ready = true;
    } else if (service?.state === "changed") {
      label = SPELLING_PAGE.changed;
      tone = "text-warning";
      actions = ["download", "importFolder"];
      removable = true;
    } else {
      label = SPELLING_PAGE.notDownloaded;
      tone = "text-muted-text";
      actions = ["download", "importFolder"];
    }
    const status: ReactNode =
      message?.text ??
      (loadFailed ? SPELLING_TEXTS.cannotLoad(entry.name) : service?.notice === "catalog-changed" ? SPELLING_PAGE.catalogChanged(entry.name) : service?.state === "changed" && running === null ? SPELLING_PAGE.changedFiles(entry.name) : null);
    // Data-model §4 "Selection checkbox".
    const full = selection.languages.length >= SPELLING_LANGUAGES;
    const reason = selected ? null : !ready ? SPELLING_PAGE.notReady(entry.name) : full ? SPELLING_PAGE.limit : null;
    return { entry, selected, label, tone, actions, removable, ready, status, reason, readme: entry.licences[0] === "readme.md" };
  }

  function actionButton(row: ReturnType<typeof rowOf>, action: Action) {
    const { entry } = row;
    const name = entry.name;
    switch (action) {
      case "download":
        return <RowButton key={action} icon={Download04Icon} label={SPELLING_PAGE.download} name={SPELLING_PAGE.name.download(name)} onClick={() => void run("download", entry)} />;
      case "retry":
        return <RowButton key={action} icon={RefreshIcon} label={SPELLING_PAGE.retry} name={SPELLING_PAGE.name.retry(name)} onClick={() => void run("download", entry)} />;
      case "cancel":
        return <RowButton key={action} label={SPELLING_PAGE.cancel} name={SPELLING_PAGE.name.cancel(name)} onClick={cancel} />;
      case "importFolder":
        return <RowButton key={action} label={SPELLING_PAGE.import} name={SPELLING_PAGE.name.import(name)} onClick={() => void run("importFolder", entry)} />;
      case "licence":
        return <RowButton key={action} label={SPELLING_PAGE.showLicence} name={SPELLING_PAGE.name.showLicence(name)} data-licence={entry.id} onClick={() => void showLicence(entry)} />;
    }
  }

  const rows = entries.map(rowOf);
  const compact = licence !== null;
  const toggle = (row: ReturnType<typeof rowOf>) => {
    if (row.reason !== null) return;
    const next = row.selected ? selection.languages.filter((l) => l !== row.entry.id) : [...selection.languages, row.entry.id];
    send({ enabled: selection.enabled, languages: next });
  };
  const move = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= selection.languages.length) return;
    const next = [...selection.languages];
    [next[index], next[to]] = [next[to]!, next[index]!];
    const li = chosen.root.current?.querySelector(`[data-grid-row="${index}"]`);
    const col = li ? [...li.querySelectorAll("[data-cell]")].indexOf(document.activeElement as Element) : -1;
    follow.current = { id: next[to]!, to, col: Math.max(0, col) };
    send({ enabled: selection.enabled, languages: next });
  };
  async function removeWord(word: string, index: number) {
    setWordFailure(null);
    const outcome = await store.remove(word);
    if (outcome !== "removed") setWordFailure(SPELLING_PAGE.wordRemoveFailed(word));
    else if (!mounted.current) return;
    // The empty list has no cell, so focus goes to the count line, never to the page.
    else if (sorted.length <= 1) countLine.current?.focus();
    else wordGrid.focus(Math.max(0, Math.min(index, sorted.length - 2)), 0);
  }

  const languagesPanel = (
    <Panel heading={SPELLING_PAGE.languages} count={entries.length} extra={compact ? null : <span className="truncate text-muted-text">{SPELLING_PAGE.acceptance}</span>} className="min-h-0 flex-1">
      {(headingId) => (
        <div ref={languages.root} className="min-h-0 overflow-y-auto" onKeyDown={languages.onKeyDown} onFocus={languages.onFocus}>
          {listed.removed.map((r) => (
            <p key={r.language} className="flex items-start gap-2 border-b border-divider bg-warning-fill px-3 py-2">
              <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} aria-hidden="true" className="mt-px size-(--icon-size) shrink-0" />
              {SPELLING_PAGE.catalogRemoved(r.name)}
            </p>
          ))}
          {listed.more === 0 ? null : (
            <p className="flex items-start gap-2 border-b border-divider bg-warning-fill px-3 py-2">
              <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} aria-hidden="true" className="mt-px size-(--icon-size) shrink-0" />
              {SPELLING_PAGE.catalogRemovedMore(listed.more)}
            </p>
          )}
          <table aria-labelledby={headingId} className="w-full border-collapse">
            <thead>
              <tr>
                {(compact ? [1, 4, 5] : [0, 1, 2, 3, 4, 5, 6]).map((i) => (
                  <th key={i} className={`h-7 border-b border-divider px-1.5 text-left font-semibold whitespace-nowrap text-muted-text ${i === 0 ? "w-7" : ""}`}>
                    {i === 0 || i === 5 || i === 6 ? <span className="sr-only">{SPELLING_PAGE.columns[i]}</span> : SPELLING_PAGE.columns[i]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const { entry } = row;
                const licenceUrl = entry.files.find((f) => f.name === entry.licences[0])!.url;
                const lines = [row.readme && !compact ? <p key="readme" className="text-muted-text">{SPELLING_PAGE.readme}</p> : null, row.status !== null ? <p key="status" role="status">{row.status}</p> : null].filter((l) => l !== null);
                const rule = lines.length > 0 && !compact ? "" : "border-b border-divider";
                const cell = `h-8 px-1.5 py-1 align-middle ${rule}`;
                const reasonId = `${ids.limit}-${entry.id}`;
                const nameCell = <td className={`${cell} ${row.selected ? "font-semibold" : ""}`}>{entry.name}</td>;
                const stateCell = <td className={`${cell} ${row.tone}`}>{row.label}{!compact && row.reason !== null && row.ready ? <span id={reasonId} className="block text-muted-text">{row.reason}</span> : null}</td>;
                return [
                  <tr key={entry.id} data-grid-row={index}>
                    {compact ? (
                      <>
                        {nameCell}
                        {stateCell}
                        <td className={cell}>{row.actions.includes("licence") ? actionButton(row, "licence") : null}</td>
                      </>
                    ) : (
                      <>
                        <td className={cell}>
                          <Tooltip disabled={row.reason === null}>
                            <TooltipTrigger
                              render={
                                <input
                                  type="checkbox"
                                  data-cell
                                  aria-label={SPELLING_PAGE.name.select(entry.name)}
                                  checked={row.selected}
                                  aria-disabled={row.reason === null ? undefined : true}
                                  aria-describedby={row.reason === null ? undefined : reasonId}
                                  onChange={() => toggle(row)}
                                  className="m-0 accent-(--accent-role)"
                                />
                              }
                            />
                            <TooltipContent>{row.reason}</TooltipContent>
                          </Tooltip>
                          {row.reason !== null && !row.ready ? (
                            <span id={reasonId} hidden>
                              {row.reason}
                            </span>
                          ) : null}
                        </td>
                        {nameCell}
                        <td className={`${cell} tabular-nums`}>{sizeText(entry.files.reduce((sum, f) => sum + f.size, 0))}</td>
                        <td className={cell}>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <a
                                  data-cell
                                  href={licenceUrl}
                                  className="text-accent-role underline-offset-2 hover:underline"
                                  onClick={(event) => {
                                    // Plan.md D12: the shell opens the catalog URL. The page never navigates.
                                    event.preventDefault();
                                    void openLink(entry);
                                  }}
                                />
                              }
                            >
                              {entry.license}
                            </TooltipTrigger>
                            <TooltipContent>
                              {SPELLING_PAGE.licenceTip}
                              <span className="block">{licenceUrl}</span>
                            </TooltipContent>
                          </Tooltip>
                        </td>
                        {stateCell}
                        <td className={cell}>
                          <span className="flex gap-1">{row.actions.map((a) => actionButton(row, a))}</span>
                        </td>
                        <td className={cell}>
                          {row.removable ? (
                            <Button variant="outline" size="sm" data-cell aria-label={SPELLING_PAGE.name.remove(entry.name)} className="text-removed" onClick={() => void remove(entry)}>
                              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size)" />
                              {SPELLING_PAGE.remove}
                            </Button>
                          ) : null}
                        </td>
                      </>
                    )}
                  </tr>,
                  lines.length === 0 || compact ? null : (
                    <tr key={`${entry.id}:message`}>
                      <td colSpan={7} className="border-b border-divider pr-1.5 pb-2 pl-10">
                        {lines}
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );

  const selectedPanel = (
    <Panel heading={SPELLING_PAGE.selected} count={selection.languages.length}>
      {(headingId) => (
        <>
          <p className="px-3 pt-2 pb-1">{SPELLING_PAGE.note}</p>
          {selection.languages.length === 0 ? (
            <p className="px-3 pb-2 text-muted-text">{SPELLING_PAGE.noneSelected}</p>
          ) : (
            <>
              <div ref={chosen.root} onKeyDown={chosen.onKeyDown} onFocus={chosen.onFocus}>
                <ol aria-labelledby={headingId} className="m-0 list-none py-1">
                  {selection.languages.map((id, index) => {
                    const name = nameOf(id);
                    return (
                      <li
                        key={id}
                        data-grid-row={index}
                        data-language={id}
                        className="group relative flex h-7 items-center gap-2 pr-1 pl-3 focus-within:bg-selected-row"
                        onKeyDown={(event) => {
                          if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                          event.preventDefault();
                          move(index, event.key === "ArrowUp" ? -1 : 1);
                        }}
                      >
                        <span aria-hidden="true" className="absolute top-1.5 left-px hidden h-4 w-0.5 rounded-[1px] bg-accent-role group-focus-within:block forced-colors:bg-[CanvasText]" />
                        <span className="w-4 text-muted-text tabular-nums">{index + 1}</span>
                        <span className="min-w-0 flex-1 truncate">{name}</span>
                        <TipButton data-cell icon={ArrowUp01Icon} label={SPELLING_PAGE.moveUp(name)} tip={SPELLING_PAGE.moveUpTip} aria-keyshortcuts="Alt+ArrowUp" reason={index === 0 ? SPELLING_PAGE.first(name) : null} onClick={() => move(index, -1)} />
                        <TipButton data-cell icon={ArrowDown01Icon} label={SPELLING_PAGE.moveDown(name)} tip={SPELLING_PAGE.moveDownTip} aria-keyshortcuts="Alt+ArrowDown" reason={index === selection.languages.length - 1 ? SPELLING_PAGE.last(name) : null} onClick={() => move(index, 1)} />
                      </li>
                    );
                  })}
                </ol>
              </div>
              <p className="px-3 pb-2 text-muted-text">{SPELLING_PAGE.preview(selection.languages.map(nameOf))}</p>
            </>
          )}
        </>
      )}
    </Panel>
  );

  const wordRow = (word: string, index: number, style?: CSSProperties) => (
    <li key={word} data-grid-row={index} className="flex h-7 items-center gap-2 pr-1 pl-3" style={style}>
      <span className="min-w-0 flex-1 truncate font-mono">{word}</span>
      <TipButton data-cell icon={Delete02Icon} label={SPELLING_PAGE.removeWord(word)} tip={SPELLING_PAGE.remove} className="text-removed" onClick={() => void removeWord(word, index)} />
    </li>
  );
  const wordsPanel = (
    <Panel heading={SPELLING_PAGE.words} count={words?.length} className="min-h-0 flex-1">
      {(headingId) => (
        <>
          {state.words.kind === "unreadable" ? <p className="px-3 py-2">{SPELLING_TEXTS.unreadable}</p> : null}
          {state.words.kind === "unavailable" ? <p className="px-3 py-2">{SPELLING_TEXTS.unavailable}</p> : null}
          {words === null ? null : (
            <p ref={countLine} tabIndex={-1} className="px-3 pt-2 pb-1 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-role">
              {SPELLING_PAGE.wordCount(words.length)}
            </p>
          )}
          {words !== null && words.length === 0 ? <p className="px-3 pb-2 text-muted-text">{SPELLING_PAGE.noWords}</p> : null}
          <div role="status" className={wordFailure === null ? "" : "px-3 pb-1"}>
            {wordFailure}
          </div>
          {sorted.length === 0 ? null : (
            <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto" onKeyDown={wordGrid.onKeyDown} onFocus={wordGrid.onFocus}>
              <ul aria-labelledby={headingId} className="relative m-0 list-none py-1" style={virtual ? { height: virtualizer.getTotalSize() } : undefined}>
                {virtual
                  ? virtualizer.getVirtualItems().map((item) => wordRow(sorted[item.index]!, item.index, { position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${item.start}px)` }))
                  : sorted.map((word, index) => wordRow(word, index))}
              </ul>
            </div>
          )}
        </>
      )}
    </Panel>
  );

  return (
    <div
      ref={page}
      data-slot="spelling-page"
      className="flex h-full min-h-0 flex-col gap-3 pt-2 pr-4 pb-2 pl-1"
      onKeyDown={(event) => {
        // Plan.md D16 "Keys": the licence panel takes Escape before Settings.
        if (event.key !== "Escape" || licence === null || event.defaultPrevented) return;
        event.preventDefault();
        closeLicence();
      }}
    >
      <div className="flex shrink-0 items-center gap-4">
        <h3 className="text-[14px] font-semibold">{SPELLING_PAGE.page}</h3>
        <span className="inline-flex items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={selection.enabled}
            aria-labelledby={ids.switchLabel}
            onClick={() => send({ enabled: !selection.enabled, languages: selection.languages })}
            className={`relative h-5 w-10 rounded-full border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-role ${selection.enabled ? "border-accent-role bg-accent-role" : "border-control-border bg-canvas"}`}
          >
            <span aria-hidden="true" className={`absolute top-[3px] size-3 rounded-full ${selection.enabled ? "left-[23px] bg-surface" : "left-[3px] bg-muted-text"} forced-colors:bg-[CanvasText]`} />
          </button>
          <span id={ids.switchLabel}>{SPELLING_PAGE.spellCheck}</span>
          <span className="text-muted-text">{selection.enabled ? TEXTS.on : TEXTS.off}</span>
        </span>
      </div>
      <p className="shrink-0 text-muted-text">{TEXTS.appSetting}</p>
      <div className="grid min-h-0 flex-1 gap-4" style={{ gridTemplateColumns: compact ? "340px minmax(0, 1fr)" : "minmax(0, 1fr) 312px" }}>
        {compact ? (
          <>
            <div className="flex min-h-0 flex-col gap-3">
              {languagesPanel}
              {selectedPanel}
              {wordsPanel}
            </div>
            <LicencePanel name={licence.entry.name} licence={licence.entry.license} documents={licence.documents} failure={licence.failure} onClose={closeLicence} />
          </>
        ) : (
          <>
            {languagesPanel}
            <div className="flex min-h-0 flex-col gap-3">
              {selectedPanel}
              {wordsPanel}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
