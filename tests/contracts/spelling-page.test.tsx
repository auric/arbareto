// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import catalog from "../../src/contracts/dictionaries.json";
import { DictionaryRunResult, ListDictionariesResult, OpenLicenceLinkResult, ReadDictionaryResult, RemoveDictionaryResult, SyncSettings } from "../../src/contracts/envelope";
import { sizeText } from "../../src/contracts/spell-words";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { contractChecked, fixtureId } from "./bridge-contract";
import { button, click, press, settings, settle, text, tooltipText, type Call } from "./sync-fake";
import type { SettingsViewProps } from "../../src/frontend/settings/SettingsView";
import type { WordList, WordListState } from "../../src/frontend/spelling/word-list";

// 006 tasks.md T035. Quickstart.md Q19 to Q21 and Q26 (page part). Spec FR-009, FR-012 to FR-016, FR-026, SC-007. Plan.md D10 to D12, D16, D17. Data-model §4, §8, §9.

printOrigin("../../src/frontend/settings/SpellingPage.tsx", import.meta.dir);
printOrigin("../../src/frontend/settings/LicencePanel.tsx", import.meta.dir);
printOrigin("../../src/frontend/settings/SettingsView.tsx", import.meta.dir);
printOrigin("../../src/frontend/spelling/store.ts", import.meta.dir);
// Bun has no Vite `?raw` loader, so the bundled English licence comes from this double.
const EN_LICENCE = "MIT License\n\n<b>Markup stays text.</b>\n";
mock.module("../../src/frontend/spelling/english", () => ({ englishFiles: async () => ({ aff: "", dic: "" }), englishLicence: async () => EN_LICENCE }));
registerDom();
const { createRoot } = await import("react-dom/client");
const { SettingsView } = await import("../../src/frontend/settings/SettingsView");
const { createSpellingStore } = await import("../../src/frontend/spelling/store");

type Entry = (typeof catalog.entries)[number];
const ENTRIES = new Map<string, Entry>([["en", catalog.bundled as unknown as Entry], ...catalog.entries.map((e) => [e.id, e] as const)]);
const entry = (id: string) => ENTRIES.get(id)!;
const nameOf = (id: string) => entry(id).name;
const total = (id: string) => entry(id).files.reduce((sum, f) => sum + f.size, 0);
const licenceUrl = (id: string) => entry(id).files.find((f) => f.name === entry(id).licences[0])!.url;
const OP = fixtureId(40);

const ok = (result: unknown) => ({ requestId: fixtureId(41), operationId: OP, state: "succeeded", result });
const failed = (code: string, result?: unknown) => ({ requestId: fixtureId(42), operationId: OP, state: "failed", code, ...(result === undefined ? {} : { result }) });
const canceled = () => ({ requestId: fixtureId(43), operationId: OP, state: "canceled", code: "CANCELED" });
const refused = (reason: string, extra: Record<string, unknown> = {}) => failed("DICTIONARY_UNAVAILABLE", DictionaryRunResult.parse({ reason, ...extra }));
const ready = (id: string) => ok(DictionaryRunResult.parse({ language: id, state: "ready" }));
const sync = (spelling: { enabled: boolean; languages: string[] }) => ok(SyncSettings.parse({ ...settings("pull"), spelling }));

type States = Record<string, { state: string; notice?: string }>;
function listed(states: States = {}, removed: { language: string; name: string }[] = [], more = 0) {
  const languages = catalog.entries.map((e) => ({ language: e.id, ...(states[e.id] ?? { state: "not-downloaded" }) }));
  return ok(ListDictionariesResult.parse({ languages, removed, more }));
}
const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const chunk = (id: string, file: string, body: string) => ok(ReadDictionaryResult.parse({ language: id, file, size: Buffer.byteLength(body), offset: 0, bytes: base64(body) }));

function wordListDouble(initial: WordListState = { kind: "loaded", words: [] }, outcome?: "failed") {
  const state = { current: initial };
  const removed: string[] = [];
  const list: WordList = {
    read: async () => state.current,
    add: async () => "added",
    remove: async (word) => {
      removed.push(word);
      if (outcome !== undefined) return outcome;
      if (state.current.kind === "loaded") state.current = { kind: "loaded", words: state.current.words.filter((w) => w !== word) };
      return "removed";
    },
  };
  return { list, removed };
}

type World = { spelling: { enabled: boolean; languages: string[] }; list: unknown };
function createDouble(world: World) {
  const calls: Call[] = [];
  const make =
    (operation: string) =>
    (...args: unknown[]) =>
      new Promise((resolve) => {
        const call: Call = { operation, args, done: false, resolve: (r) => void ((call.done = true), resolve(r)) };
        calls.push(call);
        if (operation === "readSyncSettings") setTimeout(() => call.resolve(sync(world.spelling)), 0);
        if (operation === "listDictionaries") setTimeout(() => call.resolve(world.list), 0);
      });
  const names = [
    "readSyncSettings", "setSshClient", "chooseSyncPath", "clearSyncPath", "launchPuttygen", "setDefaultPullAction", "setSwitchChoice", "readGitSettings", "reviewWorkbench", "runWorkbench",
    "listDictionaries", "readDictionary", "downloadDictionary", "importDictionary", "removeDictionary", "setSpelling", "openLicenceLink", "cancel",
  ];
  const bridge = contractChecked(Object.fromEntries(names.map((n) => [n, make(n)]))) as unknown as SettingsViewProps["bridge"];
  const of = (operation: string) => calls.filter((c) => c.operation === operation);
  return { bridge, calls, of, pending: (operation: string) => of(operation).find((c) => !c.done), writes: () => calls.filter((c) => !["readSyncSettings", "listDictionaries", "readDictionary"].includes(c.operation)).map((c) => c.operation) };
}

const roots: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of roots.splice(0)) await unmount();
});
type Options = { languages?: string[]; enabled?: boolean; states?: States; removed?: { language: string; name: string }[]; more?: number; words?: WordListState; removeOutcome?: "failed" };
async function render(options: Options = {}) {
  const world: World = { spelling: { enabled: options.enabled ?? true, languages: options.languages ?? ["en"] }, list: listed(options.states, options.removed, options.more) };
  const double = createDouble(world);
  const words = wordListDouble(options.words, options.removeOutcome);
  const store = createSpellingStore(words.list);
  let closed = 0;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <SettingsView bridge={double.bridge} target={null} wslDistro={null} spelling={store} repository={null} operationRunning={false} onOperation={() => {}} onEnded={() => {}} page="Spelling" onClose={() => void (closed += 1)} />,
    ),
  );
  roots.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await settle();
  await settle();
  return { double, world, store, words, closed: () => closed };
}

const page = () => document.querySelector<HTMLElement>('[data-slot="spelling-page"]')!;
const rows = () => [...page().querySelectorAll<HTMLTableRowElement>("tr[data-grid-row]")];
function row(id: string): HTMLTableRowElement {
  const found = rows().find((r) => [...r.cells].some((c) => text(c) === nameOf(id)));
  if (found === undefined) throw new Error(`no row for ${id}: ${text(page()).slice(0, 400)}`);
  return found;
}
/** The message row under a row, or null. */
const messageOf = (id: string) => {
  const next = row(id).nextElementSibling;
  return next !== null && !next.hasAttribute("data-grid-row") ? next : null;
};
const parts = (element: Element) => [...element.children].map((c) => text(c)).filter((t) => t !== "");
const cellTexts = (id: string) => [...row(id).cells].map((c) => text(c));
const rowButtons = (id: string) => [...row(id).querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
const checkbox = (id: string) => row(id).querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const panel = (heading: string) => [...page().querySelectorAll<HTMLElement>("section")].find((s) => s.querySelector("h4")?.textContent === heading)!;
const describedBy = (element: Element) => (element.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
async function answer(call: Call | undefined, response: unknown) {
  if (call === undefined) throw new Error("no pending call");
  await act(async () => call.resolve(response));
  await settle();
}
async function hover(element: Element) {
  await act(async () => {
    element.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mouseenter"));
    element.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  });
  await act(async () => void (await new Promise((done) => setTimeout(done, 700))));
  await settle();
}

describe("rows (data-model §4, FR-009, FR-015)", () => {
  test("the page shows the heading, the switch, the app setting note, and every catalog language after English", async () => {
    await render({ states: { uk: { state: "ready" } } });
    expect(text(page())).toContain("Arbareto setting for all repositories. Not stored in Git configuration.");
    const toggle = page().querySelector<HTMLElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(document.getElementById(toggle.getAttribute("aria-labelledby")!)!.textContent).toBe("Spell check");
    expect(text(toggle.parentElement!)).toContain("On");
    expect(rows().length).toBe(catalog.entries.length + 1);
    expect(text(rows()[0]!)).toContain("English");
    const languages = panel("Languages");
    expect(text(languages.querySelector("div")!)).toContain(String(catalog.entries.length + 1));
    expect(text(languages)).toContain("Download counts as acceptance of the licence.");
    expect([...languages.querySelectorAll("th")].map((th) => th.textContent)).toEqual(["Selected", "Language", "Size", "Licence", "State", "Actions", "Remove"]);
  });

  test("Bundled, Not downloaded, Ready, Changed, and Importing rows show their size, licence value, state, and actions", async () => {
    await render({ states: { uk: { state: "ready" }, pl: { state: "changed" }, nl: { state: "importing" } } });
    expect(cellTexts("en").slice(1, 5)).toEqual(["English", sizeText(total("en")), catalog.bundled.license, "Bundled"]);
    expect(rowButtons("en")).toEqual(["Show licence of English"]);
    expect(cellTexts("cs").slice(1, 5)).toEqual(["Czech", sizeText(total("cs")), "GPL-2.0", "Not downloaded"]);
    expect(rowButtons("cs")).toEqual(["Download Czech", "Import… Czech"]);
    expect(cellTexts("uk")[4]).toBe("Ready");
    expect(rowButtons("uk")).toEqual(["Show licence of Ukrainian", "Remove Ukrainian"]);
    expect(cellTexts("pl")[4]).toBe("Changed");
    expect(rowButtons("pl")).toEqual(["Download Polish", "Import… Polish", "Remove Polish"]);
    expect(text(messageOf("pl")!)).toBe("The Polish dictionary files changed. Download the dictionary again.");
    expect(messageOf("pl")!.querySelector('[role="status"]')).not.toBeNull();
    expect(cellTexts("nl")[4]).toBe("Importing…");
    expect(rowButtons("nl")).toEqual([]);
    expect(messageOf("cs")).toBeNull();
  });

  test("the size text is x.xx MB with x.xx = floor((bytes + 5,000) / 10,000) / 100", () => {
    expect(sizeText(4_999)).toBe("0.00 MB");
    expect(sizeText(5_000)).toBe("0.01 MB");
    expect(sizeText(8_694_999)).toBe("8.69 MB");
    expect(sizeText(8_695_000)).toBe("8.70 MB");
  });

  test("the eu and et rows state that the readme names the licence", async () => {
    await render();
    for (const id of ["eu", "et"]) expect(text(messageOf(id)!)).toBe("This dictionary has no licence file. Its readme names the licence.");
    expect(messageOf("cs")).toBeNull();
  });

  test("a catalog-changed notice shows its text, and the release removal notice shows above the table", async () => {
    await render({ states: { sv: { state: "not-downloaded", notice: "catalog-changed" } }, removed: [{ language: "xx", name: "Klingon" }] });
    expect(text(messageOf("sv")!)).toBe("This Arbareto release has new Swedish dictionary files. Download the dictionary again.");
    const notice = [...panel("Languages").querySelectorAll("p")].find((p) => text(p) === "This Arbareto release has no Klingon dictionary. Arbareto removed it.")!;
    expect(notice).not.toBeUndefined();
    expect(notice.compareDocumentPosition(panel("Languages").querySelector("table")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notice.className.split(" ")).toContain("bg-warning-fill");
  });

  // 006 T055: the `more` count of removed languages (plan.md D17, proposed 2026-10-25).
  test("the more count of removed languages follows the named notices, in the plural and the singular", async () => {
    await render({ removed: [{ language: "xx", name: "Klingon" }], more: 1_204 });
    const notices = () => [...panel("Languages").querySelectorAll("p")].map((p) => text(p));
    expect(notices().slice(0, 2)).toEqual(["This Arbareto release has no Klingon dictionary. Arbareto removed it.", "This Arbareto release has no 1,204 other dictionaries. Arbareto removed them."]);
    for (const unmount of roots.splice(0)) await unmount();
    await render({ removed: [{ language: "xx", name: "Klingon" }], more: 1 });
    expect(notices()[1]).toBe("This Arbareto release has no 1 other dictionary. Arbareto removed it.");
    for (const unmount of roots.splice(0)) await unmount();
    await render({ removed: [{ language: "xx", name: "Klingon" }] });
    expect(notices().filter((t) => t.includes("other dictionar"))).toEqual([]);
  });

  test("a failed load of a selected Ready language shows Failed with the load text and offers only Remove", async () => {
    const r = await render({ languages: ["en", "uk"], states: { uk: { state: "ready" } } });
    await act(async () => r.store.setLanguage("uk", "failed"));
    await settle();
    expect(cellTexts("uk")[4]).toBe("Failed");
    expect(rowButtons("uk")).toEqual(["Remove Ukrainian"]);
    expect(text(messageOf("uk")!)).toBe("Arbareto cannot load the Ukrainian dictionary. Spell check uses the other languages.");
  });

  test("the loading text shows until the states load, and a failed listing names its code", async () => {
    const world: World = { spelling: { enabled: true, languages: ["en"] }, list: failed("DEADLINE") };
    const double = createDouble(world);
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () =>
      root.render(<SettingsView bridge={double.bridge} target={null} wslDistro={null} spelling={createSpellingStore(wordListDouble().list)} repository={null} operationRunning={false} onOperation={() => {}} onEnded={() => {}} page="Spelling" onClose={() => {}} />),
    );
    roots.push(async () => {
      await act(async () => root.unmount());
      host.remove();
    });
    await settle();
    await settle();
    expect(text(document.querySelector('[data-section="pageContent"]')!)).toBe("The dictionary states did not load: DEADLINE.");
  });
});

describe("download, import, and their texts (FR-010 to FR-012, FR-016)", () => {
  test("Download shows Downloading <n>% with the progress bar and Cancel; Cancel sends cancel; the end reads the states again", async () => {
    const r = await render();
    await click(button("Download French"));
    const call = r.double.pending("downloadDictionary")!;
    expect(call.args[0]).toEqual({ language: "fr" });
    expect(cellTexts("fr")[4]).toBe("Downloading 0%");
    await act(async () => (call.args[1] as (e: unknown) => void)({ requestId: fixtureId(44), operationId: OP, phase: "dictionary", state: "running", counters: { received: Math.floor(total("fr") * 0.425), total: total("fr") } }));
    await settle();
    expect(cellTexts("fr")[4]).toBe("Downloading 42%");
    const bar = row("fr").querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-label")).toBe("Download French");
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    expect(rowButtons("fr")).toEqual(["Cancel the French download"]);
    const lists = r.double.of("listDictionaries").length;
    await click(button("Cancel the French download"));
    expect(r.double.pending("cancel")!.args[0]).toEqual({ operationId: OP });
    await answer(call, canceled());
    expect(cellTexts("fr")[4]).toBe("Not downloaded");
    expect(text(messageOf("fr")!)).toBe("Download canceled. Arbareto kept no file.");
    expect(r.double.of("listDictionaries").length).toBe(lists + 1);
  });

  test("a Cancel before the first progress event waits for the operation ID", async () => {
    const r = await render();
    await click(button("Download French"));
    await click(button("Cancel the French download"));
    expect(r.double.of("cancel").length).toBe(0);
    await act(async () => (r.double.pending("downloadDictionary")!.args[1] as (e: unknown) => void)({ requestId: fixtureId(44), operationId: OP, phase: "dictionary", state: "running", counters: { received: 0, total: 1 } }));
    await settle();
    expect(r.double.of("cancel").map((c) => c.args[0])).toEqual([{ operationId: OP }]);
  });

  const failures: [string, unknown, string, string[]][] = [
    ["transport", refused("transport"), "Arbareto could not download the German dictionary. Check the connection, then select Retry, or use Import.", ["Retry German", "Import… German"]],
    ["HTTP 404", refused("http-not-found"), "The download host has no German dictionary file at the pinned source. Use Import, or update Arbareto.", ["Retry German", "Import… German"]],
    ["HTTP 429", refused("http-rate-limit"), "The download host limits downloads now (HTTP 429). Select Retry later, or use Import.", ["Retry German", "Import… German"]],
    ["HTTP 503", refused("http-status", { status: 503 }), "The download host answered HTTP 503 for the German dictionary. Arbareto kept no file.", ["Retry German", "Import… German"]],
    ["a redirect", refused("redirect"), "The download host moved the German dictionary file. Arbareto stopped the download. Use Import, or update Arbareto.", ["Retry German", "Import… German"]],
    ["a non-HTTPS URL", refused("not-https"), "The German catalog entry has no HTTPS URL. Arbareto did not download it.", ["Import… German"]],
    ["the deadline", failed("DEADLINE"), "The German download did not end within 120 seconds. Arbareto kept no file. Select Retry, or use Import.", ["Retry German", "Import… German"]],
    ["a mismatch", refused("mismatch"), "The downloaded German file does not match the catalog. Arbareto deleted it.", ["Retry German", "Import… German"]],
    ["a save failure", refused("save", { folder: "C:/Sample/dictionaries" }), "Arbareto could not save the German dictionary in C:/Sample/dictionaries.", ["Retry German", "Import… German"]],
  ];
  for (const [cause, response, message, actions] of failures)
    test(`a download that ends with ${cause} shows Failed, its FR-016 text, and its actions`, async () => {
      const r = await render();
      await click(button("Download German"));
      await answer(r.double.pending("downloadDictionary"), response);
      expect(cellTexts("de")[4]).toBe("Failed");
      expect(rowButtons("de")).toEqual(actions);
      expect(text(messageOf("de")!.querySelector('[role="status"]')!)).toBe(message);
    });

  test("Retry downloads again and a ready end clears the Failed text", async () => {
    const r = await render();
    await click(button("Download German"));
    await answer(r.double.pending("downloadDictionary"), refused("transport"));
    r.world.list = listed({ de: { state: "ready" } });
    await click(button("Retry German"));
    expect(r.double.pending("downloadDictionary")!.args[0]).toEqual({ language: "de" });
    await answer(r.double.pending("downloadDictionary"), ready("de"));
    expect(cellTexts("de")[4]).toBe("Ready");
    expect(messageOf("de")).toBeNull();
  });

  test("a failed run of a row with files offers Remove", async () => {
    const r = await render({ states: { pl: { state: "changed" } } });
    await click(button("Download Polish"));
    await answer(r.double.pending("downloadDictionary"), refused("mismatch"));
    expect(rowButtons("pl")).toEqual(["Retry Polish", "Import… Polish", "Remove Polish"]);
  });

  const kept: [string, unknown, string][] = [
    ["import-mismatch", refused("import-mismatch"), "These files are not the Ukrainian files of the catalog. Arbareto did not import them."],
    ["import-unreadable", refused("import-unreadable", { folder: "D:/Offline/uk" }), "Arbareto could not read the Ukrainian files in D:/Offline/uk."],
    ["busy", refused("busy"), "Another dictionary download or import runs. Wait for it to end."],
    // 006 T055: plan.md D17 texts proposed 2026-10-25.
    ["DEADLINE", failed("DEADLINE"), "The Ukrainian import did not end within 120 seconds. Arbareto did not import the files. Select Import… again."],
    ["PICKER_FAILED", { requestId: fixtureId(45), operationId: OP, state: "rejected", code: "PICKER_FAILED" }, "Arbareto could not open the folder picker. Select Import… again."],
    ["another code", failed("INVALID_REQUEST"), "Import… Ukrainian did not complete: INVALID_REQUEST."],
  ];
  for (const [cause, response, message] of kept)
    test(`an import that ends with ${cause} keeps the row state and shows its text`, async () => {
      const r = await render();
      await click(button("Import… Ukrainian"));
      expect(r.double.pending("importDictionary")!.args[0]).toEqual({ language: "uk" });
      await answer(r.double.pending("importDictionary"), response);
      expect(cellTexts("uk")[4]).toBe("Not downloaded");
      expect(rowButtons("uk")).toEqual(["Download Ukrainian", "Import… Ukrainian"]);
      expect(text(messageOf("uk")!)).toBe(message);
    });

  // 006 T055: data-model §4 "Importing… | importing" for the import of this window.
  test("the own import shows Importing… with no actions until it ends", async () => {
    const r = await render({ states: { pl: { state: "changed" } } });
    await click(button("Import… Polish"));
    expect(cellTexts("pl")[4]).toBe("Importing…");
    expect(rowButtons("pl")).toEqual([]);
    expect(rowButtons("cs")).toEqual(["Download Czech", "Import… Czech"]);
    r.world.list = listed({ pl: { state: "ready" } });
    await answer(r.double.pending("importDictionary"), ready("pl"));
    expect(cellTexts("pl")[4]).toBe("Ready");
  });

  test("a canceled import picker shows no text", async () => {
    const r = await render();
    await click(button("Import… Ukrainian"));
    await answer(r.double.pending("importDictionary"), canceled());
    expect(messageOf("uk")).toBeNull();
  });
});

describe("licence link and licence text (FR-015, plan.md D12)", () => {
  test("the licence value is a link to the catalog URL of the first licence document; activation sends openLicenceLink and prevents navigation", async () => {
    const r = await render();
    const link = row("uk").querySelector("a")!;
    expect(link.textContent).toBe("GPL-3.0");
    expect(link.getAttribute("href")).toBe(licenceUrl("uk"));
    expect(row("eu").querySelector("a")!.getAttribute("href")).toBe(licenceUrl("eu"));
    expect(licenceUrl("eu").endsWith("/eu/readme.md")).toBe(true);
    expect(row("oc").querySelector("a")!.getAttribute("href")!.endsWith("/oc/license")).toBe(true);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => void link.dispatchEvent(event));
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(r.double.pending("openLicenceLink")!.args[0]).toEqual({ language: "uk" });
    await answer(r.double.pending("openLicenceLink"), failed("DICTIONARY_UNAVAILABLE", OpenLicenceLinkResult.parse({ reason: "link", url: licenceUrl("uk") })));
    expect(text(messageOf("uk")!)).toBe(`Windows could not open the link. The address is ${licenceUrl("uk")}.`);
    await hover(row("cs").querySelector("a")!);
    expect(tooltipText()).toBe(`Full licence text${licenceUrl("cs")}`);
  });

  test("Show licence shows the text as plain textContent in the compact layout; Escape closes the licence before Settings", async () => {
    const r = await render({ states: { uk: { state: "ready" } } });
    await click(button("Show licence of Ukrainian"));
    expect(r.double.pending("readDictionary")!.args[0]).toEqual({ language: "uk", file: "license", offset: 0 });
    // 006 T055: plan.md D17 loading text, proposed 2026-10-25.
    expect(text(page().querySelector('[data-slot="licence-panel"] [role="status"]')!)).toBe("Arbareto reads the licence text…");
    const body = "GNU GENERAL PUBLIC LICENSE\n<b>sample</b> **bold**\n";
    await answer(r.double.pending("readDictionary"), chunk("uk", "license", body));
    const licence = page().querySelector<HTMLElement>('[data-slot="licence-panel"]')!;
    const region = licence.querySelector<HTMLElement>('[role="document"]')!;
    expect(region.getAttribute("aria-label")).toBe("Licence text of Ukrainian");
    expect(region.textContent).toBe(body);
    expect(region.querySelector("b")).toBeNull();
    expect(region.tabIndex).toBe(0);
    expect(parts(licence.querySelector("div")!)).toEqual(["Ukrainian", "GPL-3.0", "license", `${Buffer.byteLength(body)} bytes`]);
    expect(document.activeElement).toBe(region);
    expect([...panel("Languages").querySelectorAll("th")].map((th) => th.textContent)).toEqual(["Language", "State", "Actions"]);
    const close = button("Close the licence text (Esc)");
    expect(close.getAttribute("aria-keyshortcuts")).toBe("Escape");
    await press(region, "Escape");
    expect(page().querySelector('[data-slot="licence-panel"]')).toBeNull();
    expect(r.closed()).toBe(0);
    expect(document.activeElement).toBe(button("Show licence of Ukrainian"));
    await press(document.activeElement!, "Escape");
    expect(r.closed()).toBe(1);
  });

  test("oc shows both licence documents, each with its file name and byte count", async () => {
    const r = await render({ states: { oc: { state: "ready" } } });
    await click(button("Show licence of Occitan"));
    await answer(r.double.pending("readDictionary"), chunk("oc", "license", "first"));
    expect(r.double.pending("readDictionary")!.args[0]).toEqual({ language: "oc", file: "licence", offset: 0 });
    await answer(r.double.pending("readDictionary"), chunk("oc", "licence", "x"));
    const regions = [...page().querySelectorAll('[data-slot="licence-panel"] [role="document"]')];
    expect(regions.map((r) => r.textContent)).toEqual(["first", "x"]);
    const metas = [...page().querySelectorAll('[data-slot="licence-panel"] [role="document"]')].map((d) => parts(d.previousElementSibling!));
    expect(metas).toEqual([["license", "5 bytes"], ["licence", "1 byte"]]);
  });

  test("the et readme shows as the readme text with the readme note", async () => {
    const r = await render({ states: { et: { state: "ready" } } });
    await click(button("Show licence of Estonian"));
    await answer(r.double.pending("readDictionary"), chunk("et", "readme.md", "# dictionary-et\n"));
    const licence = page().querySelector('[data-slot="licence-panel"]')!;
    expect(licence.querySelector('[role="document"]')!.getAttribute("aria-label")).toBe("Readme text of Estonian");
    expect(text(licence)).toContain("This dictionary has no licence file. Its readme names the licence.");
  });

  test("English reads the bundled licence text; a failed read names its code", async () => {
    const r = await render({ states: { uk: { state: "ready" } } });
    await click(button("Show licence of English"));
    await settle();
    expect(page().querySelector('[data-slot="licence-panel"] [role="document"]')!.textContent).toBe(EN_LICENCE);
    expect(r.double.of("readDictionary").length).toBe(0);
    await click(button("Show licence of Ukrainian"));
    await answer(r.double.pending("readDictionary"), failed("DICTIONARY_UNAVAILABLE", ReadDictionaryResult.parse({ reason: "changed" })));
    expect(text(page().querySelector('[data-slot="licence-panel"] [role="alert"]')!)).toBe("Arbareto could not read the licence text: DICTIONARY_UNAVAILABLE.");
  });
});

describe("selection (FR-009, data-model §8)", () => {
  test("each change sends setSpelling at once: a checkbox adds the language at the end or clears it", async () => {
    const r = await render({ languages: ["en"], states: { uk: { state: "ready" } } });
    await click(checkbox("uk"));
    expect(r.double.pending("setSpelling")!.args[0]).toEqual({ enabled: true, languages: ["en", "uk"] });
    await answer(r.double.pending("setSpelling"), sync({ enabled: true, languages: ["en", "uk"] }));
    expect(checkbox("uk").checked).toBe(true);
    expect(row("uk").cells[1]!.className.split(" ")).toContain("font-semibold");
    await click(checkbox("en"));
    expect(r.double.pending("setSpelling")!.args[0]).toEqual({ enabled: true, languages: ["uk"] });
  });

  test("the switch sends setSpelling with enabled false and keeps the languages", async () => {
    const r = await render({ languages: ["en", "uk"], states: { uk: { state: "ready" } } });
    await click(page().querySelector('[role="switch"]')!);
    expect(r.double.pending("setSpelling")!.args[0]).toEqual({ enabled: false, languages: ["en", "uk"] });
    await answer(r.double.pending("setSpelling"), sync({ enabled: false, languages: ["en", "uk"] }));
    expect(page().querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("false");
    expect(text(page().querySelector('[role="switch"]')!.parentElement!)).toContain("Off");
  });

  test("a failed setSpelling shows the 004 setting text and keeps the selection", async () => {
    const r = await render({ languages: ["en"], states: { uk: { state: "ready" } } });
    await click(checkbox("uk"));
    await answer(r.double.pending("setSpelling"), failed("INVALID_REQUEST"));
    expect(text(document.querySelector('[data-section="pageContent"] [role="alert"]')!)).toBe("The setting did not change: INVALID_REQUEST.");
    expect(checkbox("uk").checked).toBe(false);
  });

  test("with 3 languages selected, an unselected Ready row states the limit reason and sends nothing", async () => {
    const r = await render({ languages: ["en", "uk", "ru"], states: { uk: { state: "ready" }, ru: { state: "ready" }, he: { state: "ready" } } });
    expect(text(panel("Selected languages"))).toContain("Select at most 3 languages. English counts as one.");
    const he = checkbox("he");
    expect(he.getAttribute("aria-disabled")).toBe("true");
    expect(describedBy(he)).toBe("You can select at most 3 languages. Clear one first.");
    expect(cellTexts("he")[4]).toBe("ReadyYou can select at most 3 languages. Clear one first.");
    await click(he);
    expect(r.double.of("setSpelling").length).toBe(0);
    expect(he.checked).toBe(false);
    expect(describedBy(checkbox("cs"))).toBe("You can select at most 3 languages. Clear one first.");
    expect(checkbox("uk").getAttribute("aria-disabled")).toBeNull();
  });

  test("a row that is not ready states the not-ready reason in the checkbox description", async () => {
    const r = await render({ languages: ["en"] });
    const cs = checkbox("cs");
    expect(cs.getAttribute("aria-disabled")).toBe("true");
    expect(describedBy(cs)).toBe("Download or import the Czech dictionary first.");
    expect(cellTexts("cs")[4]).toBe("Not downloaded");
    await click(cs);
    expect(r.double.of("setSpelling").length).toBe(0);
    // 006 T055: plan.md D16, constitution VII: the reason also shows as the tooltip.
    await hover(cs);
    expect(tooltipText()).toBe("Download or import the Czech dictionary first.");
    expect(describedBy(cs)).toBe("Download or import the Czech dictionary first.");
  });

  test("Selected languages lists the order with Move up and Move down, their tooltips, the first and last reasons, and the chip preview", async () => {
    const r = await render({ languages: ["en", "uk", "ru"], states: { uk: { state: "ready" }, ru: { state: "ready" } } });
    const selected = panel("Selected languages");
    expect(parts(selected.querySelector("div")!)).toEqual(["Selected languages", "3"]);
    expect([...selected.querySelectorAll("li")].map((li) => parts(li).slice(0, 2))).toEqual([["1", "English"], ["2", "Ukrainian"], ["3", "Russian"]]);
    expect(text(selected)).toContain("Chip: Spelling: English, Ukrainian, Russian");
    const up = button("Move English up", selected);
    expect(up.hasAttribute("data-disabled") || up.getAttribute("aria-disabled") === "true").toBe(true);
    expect(describedBy(up)).toBe("English is already first.");
    expect(describedBy(button("Move Russian down", selected))).toBe("Russian is already last.");
    expect(button("Move Ukrainian up", selected).getAttribute("aria-describedby")).toBeNull();
    await hover(button("Move Ukrainian up", selected));
    expect(tooltipText()).toBe("Move up (Alt+Up)");
    await click(button("Move English up", selected));
    expect(r.double.of("setSpelling").length).toBe(0);
    await click(button("Move Ukrainian down", selected));
    expect(r.double.pending("setSpelling")!.args[0]).toEqual({ enabled: true, languages: ["en", "ru", "uk"] });
    await answer(r.double.pending("setSpelling"), sync({ enabled: true, languages: ["en", "ru", "uk"] }));
    expect(text(panel("Selected languages"))).toContain("Chip: Spelling: English, Russian, Ukrainian");
  });

  test("Alt+Up and Alt+Down move the language of the focused row", async () => {
    const r = await render({ languages: ["en", "uk", "ru"], states: { uk: { state: "ready" }, ru: { state: "ready" } } });
    const down = button("Move Ukrainian down", panel("Selected languages"));
    await act(async () => down.focus());
    await press(down, "ArrowUp", { altKey: true });
    expect(r.double.pending("setSpelling")!.args[0]).toEqual({ enabled: true, languages: ["uk", "en", "ru"] });
    await answer(r.double.pending("setSpelling"), sync({ enabled: true, languages: ["uk", "en", "ru"] }));
    await press(document.activeElement!, "ArrowDown", { altKey: true });
    expect(r.double.pending("setSpelling")!.args[0]).toEqual({ enabled: true, languages: ["en", "uk", "ru"] });
  });

  test("an empty selection states that spell check marks no word", async () => {
    await render({ languages: [] });
    expect(text(panel("Selected languages"))).toContain("No language is selected. Spell check marks no word.");
  });

  test("Remove of a selected language sends removeDictionary with no confirmation, then setSpelling without it; the word list stays", async () => {
    const r = await render({ languages: ["en", "uk"], states: { uk: { state: "ready" } }, words: { kind: "loaded", words: ["kubectl"] } });
    await click(button("Remove Ukrainian"));
    expect(r.double.pending("removeDictionary")!.args[0]).toEqual({ language: "uk" });
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
    r.world.list = listed();
    await answer(r.double.pending("removeDictionary"), ok(RemoveDictionaryResult.parse({ language: "uk", removed: true })));
    expect(r.double.pending("setSpelling")!.args[0]).toEqual({ enabled: true, languages: ["en"] });
    expect(r.double.writes()).toEqual(["removeDictionary", "setSpelling"]);
    expect(r.words.removed).toEqual([]);
    expect(cellTexts("uk")[4]).toBe("Not downloaded");
  });

  test("a refused Remove names its folder and keeps the selection", async () => {
    const r = await render({ languages: ["en", "uk"], states: { uk: { state: "ready" } } });
    await click(button("Remove Ukrainian"));
    await answer(r.double.pending("removeDictionary"), failed("DICTIONARY_UNAVAILABLE", RemoveDictionaryResult.parse({ reason: "remove", folder: "C:/Sample/dictionaries/uk" })));
    expect(text(messageOf("uk")!)).toBe("Arbareto could not remove the Ukrainian dictionary from C:/Sample/dictionaries/uk.");
    expect(r.double.of("setSpelling").length).toBe(0);
  });
});

describe("personal word list (FR-006, plan.md D10)", () => {
  test("the panel lists the words in byte order with the count; Remove removes at once and reads the list again", async () => {
    const r = await render({ words: { kind: "loaded", words: ["nspell", "Tauri", "kubectl"] } });
    const words = panel("Personal word list");
    expect(parts(words.querySelector("div")!)).toEqual(["Personal word list", "3"]);
    expect(text(words)).toContain("3 of 10,000 words");
    expect([...words.querySelectorAll("li")].map((li) => text(li))).toEqual(["kubectl", "nspell", "Tauri"]);
    const remove = button("Remove nspell", words);
    await hover(remove);
    expect(tooltipText()).toBe("Remove");
    await click(remove);
    expect(r.words.removed).toEqual(["nspell"]);
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
    expect([...panel("Personal word list").querySelectorAll("li")].map((li) => text(li))).toEqual(["kubectl", "Tauri"]);
    expect(text(panel("Personal word list"))).toContain("2 of 10,000 words");
  });

  test("an empty list states how to add a word", async () => {
    await render({ words: { kind: "loaded", words: [] } });
    expect(text(panel("Personal word list"))).toContain("No words yet. Add a word from the spelling menu of the commit message.");
  });

  test("an unreadable list and missing storage show their texts", async () => {
    await render({ words: { kind: "unreadable" } });
    expect(text(panel("Personal word list"))).toContain("Arbareto could not read the personal word list.");
    for (const unmount of roots.splice(0)) await unmount();
    await render({ words: { kind: "unavailable" } });
    expect(text(panel("Personal word list"))).toContain("Arbareto cannot save words, because the app storage is not available.");
  });

  // 006 T055: focus never falls to the page when the list becomes empty.
  test("Remove of the last word moves focus to the count line", async () => {
    await render({ words: { kind: "loaded", words: ["kubectl"] } });
    const remove = button("Remove kubectl", panel("Personal word list"));
    await act(async () => remove.focus());
    await click(remove);
    const line = [...panel("Personal word list").querySelectorAll("p")].find((p) => text(p) === "0 of 10,000 words")!;
    expect(document.activeElement).toBe(line);
    expect(line.tabIndex).toBe(-1);
  });

  test("a failed Remove names the word", async () => {
    await render({ words: { kind: "loaded", words: ["kubectl"] }, removeOutcome: "failed" });
    await click(button("Remove kubectl", panel("Personal word list")));
    expect(text(panel("Personal word list"))).toContain("Arbareto could not remove kubectl from the personal word list.");
  });
});

describe("keyboard (FR-026, SC-007, plan.md D16 \"Keys\")", () => {
  const stops = (root: Element) => [...root.querySelectorAll<HTMLElement>("[data-cell]")].filter((c) => c.tabIndex === 0);

  test("each list is one Tab stop; Up, Down, Home, and End move between rows, Left and Right between the controls of a row", async () => {
    await render({ languages: ["en", "uk"], states: { uk: { state: "ready" } }, words: { kind: "loaded", words: ["a", "b"] } });
    const languages = panel("Languages");
    expect(stops(languages).length).toBe(1);
    expect(stops(panel("Selected languages")).length).toBe(1);
    expect(stops(panel("Personal word list")).length).toBe(1);
    const first = stops(languages)[0]!;
    expect(first).toBe(checkbox("en"));
    await act(async () => first.focus());
    await press(first, "ArrowDown");
    expect(document.activeElement).toBe(rows()[1]!.querySelector('input[type="checkbox"]'));
    expect(stops(languages)).toEqual([document.activeElement as HTMLElement]);
    await press(document.activeElement!, "ArrowRight");
    expect(document.activeElement).toBe(rows()[1]!.querySelector("a"));
    await press(document.activeElement!, "End");
    expect(document.activeElement).toBe(rows().at(-1)!.querySelector("a"));
    await press(document.activeElement!, "Home");
    expect(document.activeElement).toBe(row("en").querySelector("a"));
    await press(document.activeElement!, "ArrowLeft");
    expect(document.activeElement).toBe(checkbox("en"));
    const words = panel("Personal word list");
    await act(async () => stops(words)[0]!.focus());
    await press(document.activeElement!, "ArrowDown");
    expect(document.activeElement).toBe(button("Remove b", words));
  });

  // 006 T055: plan.md D16 "Forced colors": the knob and the focus bar draw in CanvasText; an unavailable checkbox keeps the GrayText rule at full opacity.
  test("forced colors keep the switch knob, the focus bar, and the unavailable checkbox", async () => {
    await render({ languages: ["en", "uk"], states: { uk: { state: "ready" } } });
    const classes = (e: Element) => e.className.split(" ");
    expect(classes(page().querySelector('[role="switch"] > span')!)).toContain("forced-colors:bg-[CanvasText]");
    expect(classes(panel("Selected languages").querySelector('li > span[aria-hidden="true"]')!)).toContain("forced-colors:bg-[CanvasText]");
    expect(classes(checkbox("cs"))).toContain("forced-colors:aria-disabled:opacity-100");
  });

  test("every row control has an accessible name", async () => {
    await render({ states: { uk: { state: "ready" } } });
    for (const control of page().querySelectorAll<HTMLElement>("[data-cell]")) expect((control.getAttribute("aria-label") ?? control.textContent ?? "").length > 0).toBe(true);
  });
});
