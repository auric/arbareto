// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { act, isValidElement, type ReactElement, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import type { BootProps, Environment } from "../../src/frontend/boot/BootView";
import { contractChecked, fixtureId } from "./bridge-contract";

printOrigin("../../src/frontend/boot/BootView.tsx", import.meta.dir);
// tests/dom.ts: Base UI must first evaluate with a DOM, so the modules that load it come after registerDom().
registerDom();
const { renderToStaticMarkup } = await import("react-dom/server");
const { createRoot } = await import("react-dom/client");
const { BootView, bootActions, markBootView } = await import("../../src/frontend/boot/BootView");
const { Button } = await import("../../src/frontend/components/ui/button");
const CANCELED = { requestId: null, state: "canceled" as const };

const environment = (fields: Partial<Environment> = {}): Environment => ({
  buildIdentity: { version: "0.1.0", commit: "c".repeat(40) + "-dirty", channel: "local" },
  platformScope: "other",
  detectedVersion: "2.43.0.windows.1",
  minimumVersion: "2.55.0.windows.3",
  qualification: "unverified",
  markers: [],
  damagedMarkers: [],
  ...fields,
});

const render = (env: Environment) => renderToStaticMarkup(<BootView state="facts" environment={env} onSelectGit={async () => CANCELED} onDismissMarker={() => {}} />);

const FRAME_HEADER = /<header\b[^>]*style="height:var\(--h-header\)"[^>]*><h1[^>]*>Arbareto<\/h1><\/header>/;

describe("boot view", () => {
  // T363: the one-view frame. plan.md "Compact token system" gives the header height and the Surface role.
  test("the facts state has one header row, one Surface panel, one definition list, and a primary Select Git", () => {
    const html = render(environment({ gitCode: "GIT_UNAVAILABLE", reason: "selected-missing", path: "C:\\Git\\git.exe", selectedPath: "C:\\Git\\git.exe", previousVersion: "2.42.0.windows.1", admission: "admitted" }));
    const count = (pattern: RegExp) => html.match(pattern)?.length ?? 0;
    expect(count(/<header\b/g)).toBe(1);
    expect(html).toMatch(FRAME_HEADER);
    expect(count(/class="[^"]*\bbg-surface\b/g)).toBe(1);
    expect(count(/<dl\b/g)).toBe(1);
    const labels = [...html.matchAll(/<dt>([^<]*)<\/dt>/g)].map((m) => m[1]);
    expect(labels).toEqual(["Build", "Platform scope", "Selected Git", "Detected Git version", "Git updated", "Minimum Git version", "Admission", "Qualification", "Reason", "Path"]);
    expect(count(/<dd>/g)).toBe(labels.length);
    expect(html).toMatch(/<dt>Build<\/dt><dd>0\.1\.0 c{40}-dirty<\/dd>/);
    for (const label of labels) expect(html).not.toContain(`<p>${label}`);
    // A screen reader reads the blocked line before its details.
    const blocked = html.search(/Git unavailable: <code[^>]*>GIT_UNAVAILABLE<\/code>/);
    expect(blocked).toBeGreaterThan(-1);
    expect(blocked).toBeLessThan(html.indexOf("<dl"));
    const select = html.match(/<button\b[^>]*>Select Git<\/button>/)?.[0] ?? "";
    expect(select).toContain('data-slot="button"');
    expect(select).toContain("bg-primary");
  });

  test("the loading and unavailable states use the same frame", () => {
    for (const html of [renderToStaticMarkup(<BootView state="loading" />), renderToStaticMarkup(<BootView state="unavailable" code="SERVICE_UNAVAILABLE" />)]) {
      expect(html).toMatch(FRAME_HEADER);
      expect(html.match(/class="[^"]*\bbg-surface\b/g)?.length).toBe(1);
    }
  });

  test("the unavailable state names the code", () => {
    // B4-4: plan.md "Status and fallback texts": each code shows in the code font.
    expect(renderToStaticMarkup(<BootView state="unavailable" code="SERVICE_UNAVAILABLE" />)).toMatch(/Git service not connected: <code[^>]*>SERVICE_UNAVAILABLE<\/code>/);
  });

  test("B4-4: the blocked Git state shows its code in the code font", () => {
    expect(render(environment({ gitCode: "GIT_UNSUPPORTED" }))).toMatch(/: <code[^>]*>GIT_UNSUPPORTED<\/code>/);
  });

  test("the facts state shows the build identity and the T064 labels", () => {
    const html = render(environment());
    expect(html).toContain("c".repeat(40) + "-dirty");
    expect(html).toContain("Unsigned local test package");
    expect(html).toContain("Unqualified platform");
    expect(html).not.toContain("Select Git");
  });

  test("the selected Git shows the selected path, and a Runs line only for another resolved path", () => {
    const wrapper = "C:\\Git\\cmd\\git.exe";
    const resolved = "C:\\Git\\mingw64\\libexec\\git-core\\git.exe";
    const viaWrapper = render(environment({ selectedPath: wrapper, executablePath: resolved }));
    expect(viaWrapper).toContain(`<dt>Selected Git</dt><dd>${wrapper}</dd><dt>Runs</dt><dd>${resolved}</dd>`);
    const direct = render(environment({ selectedPath: resolved, executablePath: resolved }));
    expect(direct).toContain(`<dt>Selected Git</dt><dd>${resolved}</dd>`);
    expect(direct).not.toContain("<dt>Runs</dt>");
    expect(render(environment())).not.toContain("Selected Git");
  });

  test("each Git code shows a blocked state with both versions and Select Git", () => {
    for (const gitCode of ["GIT_UNAVAILABLE", "GIT_UNSUPPORTED", "GIT_CHANGED"] as const) {
      const html = render(environment({ gitCode }));
      expect(html).toContain(gitCode);
      expect(html).toContain("2.43.0.windows.1");
      expect(html).toContain("2.55.0.windows.3");
      expect(html).toContain("Select Git");
    }
  });

  test("a Git reason and its path show in the blocked state", () => {
    const path = "C:\\Git\\mingw64\\bin\\git.exe";
    const html = render(environment({ gitCode: "GIT_UNAVAILABLE", reason: "selected-missing", path }));
    for (const text of ["GIT_UNAVAILABLE", "selected-missing", path, "Select Git"]) expect(html).toContain(text);
  });

  test("a startup upgrade shows a non-blocking update line, and no line without previousVersion", () => {
    const html = render(environment({ detectedVersion: "2.56.0.windows.1", previousVersion: "2.55.0.windows.3", admission: "admitted" }));
    expect(html).toContain("<dt>Git updated</dt><dd>2.55.0.windows.3 → 2.56.0.windows.1</dd>");
    expect(html).not.toContain("Select Git");
    expect(render(environment({ detectedVersion: "2.56.0.windows.1", admission: "admitted" }))).not.toContain("Git updated");
  });

  test("any other Git code shows as plain text with Select Git", () => {
    for (const gitCode of ["DEADLINE", "OUTPUT_LIMIT", "UNKNOWN_TARGET", "PROCESS_OWNERSHIP_FAILED", "UNSUPPORTED_REPOSITORY", "GIT_FAILED"] as const) {
      const html = render(environment({ gitCode }));
      expect(html).toContain(gitCode);
      expect(html).toContain("Select Git");
    }
  });

  test("each recovery marker shows its facts and a Dismiss action", () => {
    const marker = { markerId: crypto.randomUUID(), kind: "commit" as const, startedAt: "2026-10-02T10:00:00Z", worktreeRoot: "C:\\repo" };
    const html = render(environment({ platformScope: "qualification-target", markers: [marker], markerLimit: 64, unloadedMarkers: 3 }));
    expect(html).not.toContain("Unqualified platform");
    for (const text of ["commit", "C:\\repo", "2026-10-02T10:00:00Z", "Dismiss", "Marker limit: 64", "Unloaded marker files: 3"]) expect(html).toContain(text);
  });

  test("each damaged marker shows its label, its file name, and a Dismiss action", () => {
    const damagedMarkers = [{ markerId: crypto.randomUUID(), fileName: "broken.json" }];
    const html = render(environment({ damagedMarkers }));
    for (const text of ["Damaged recovery marker", "broken.json", "Dismiss"]) expect(html).toContain(text);
    expect(html).not.toContain("Marker limit");
    expect(render(environment())).not.toContain("Damaged recovery marker");
  });

  test("each button calls its action with the marker ID", () => {
    const markers = ["a", "b"].map((markerId) => ({ markerId, kind: "commit" as const, startedAt: "2026-10-02T10:00:00Z", worktreeRoot: "C:\\repo" }));
    const calls: string[] = [];
    const damagedMarkers = [{ markerId: "c", fileName: "broken.json" }];
    const props: BootProps = { state: "facts", environment: environment({ gitCode: "GIT_UNAVAILABLE", markers, damagedMarkers }), onSelectGit: async () => (calls.push("select"), CANCELED), onDismissMarker: (id) => calls.push(`dismiss ${id}`) };
    // A direct component call inside a render keeps the hooks valid and returns the element tree.
    let tree: ReactNode;
    const Probe = () => ((tree = BootView(props)), null);
    renderToStaticMarkup(<Probe />);
    for (const button of buttons(tree)) button.props.onClick();
    expect(calls).toEqual(["select", "dismiss a", "dismiss b", "dismiss c"]);
  });

  test("Select Git calls chooseGit and Dismiss calls dismissRecoveryMarker, then each reloads", async () => {
    const calls: unknown[] = [];
    const done = { requestId: null, state: "succeeded" as const };
    const actions = bootActions(
      contractChecked({
        chooseGit: async () => (calls.push("chooseGit"), done),
        dismissRecoveryMarker: async (payload: { markerId: string }) => (calls.push(payload), done),
      }),
      () => calls.push("reload"),
    );
    actions.onSelectGit();
    actions.onDismissMarker(fixtureId(0x501));
    await Bun.sleep(0);
    expect(calls).toEqual(["chooseGit", { markerId: fixtureId(0x501) }, "reload", "reload"]);
  });

  test("the boot-view mark happens once", () => {
    markBootView();
    markBootView();
    expect(performance.getEntriesByName("arbareto:boot-view", "mark")).toHaveLength(1);
  });
});

// A `chooseGit` result other than `succeeded` or `canceled` shows its code and text (contract §3, §9), as a refused repository does.
// Feature 007 contracts/release.md §6: the boot view takes the About marker rule and has no release button.
describe("build channel marker", () => {
  const host = (html: string) => Object.assign(document.createElement("div"), { innerHTML: html });
  const plain = (html: string) => [...host(html).querySelectorAll("p")].map((p) => p.textContent?.trim());
  const releaseButtons = (html: string) => [...host(html).querySelectorAll("button")].filter((b) => ["Hunspell source", "Source at this commit"].includes(b.textContent?.trim() ?? ""));

  test("channel local shows the unsigned local test package line, no Preview line, and no release button", () => {
    const html = render(environment());
    expect(plain(html)).toContain("Unsigned local test package");
    expect(plain(html)).not.toContain("Preview");
    expect(releaseButtons(html)).toHaveLength(0);
  });

  test.todo("channel preview shows the Preview line, no local package line, and no release button", () => {
    const html = render(environment({ buildIdentity: { version: "0.1.0", commit: "c".repeat(40), channel: "preview" } }));
    expect(plain(html)).toContain("Preview");
    expect(plain(html)).not.toContain("Unsigned local test package");
    expect(releaseButtons(html)).toHaveLength(0);
  });
});

describe("Select Git result", () => {
  async function mountBlocked(response: unknown) {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(<BootView state="facts" environment={environment({ gitCode: "GIT_UNAVAILABLE" })} onSelectGit={async () => response as never} onDismissMarker={() => {}} />));
    const select = [...host.querySelectorAll("button")].find((b) => b.textContent === "Select Git")!;
    await act(async () => select.click());
    return {
      host,
      done: async () => {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  }

  test("a rejected chooseGit shows its code and its text in an alert", async () => {
    const view = await mountBlocked({ requestId: crypto.randomUUID(), state: "rejected", code: "GIT_UNAVAILABLE", result: { text: "The selected file is not a Git executable.", path: "C:\Tools\other.exe", minimumVersion: "2.55.0.windows.3" } });
    try {
      const alert = view.host.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert!.textContent).toContain("Select Git did not complete: GIT_UNAVAILABLE");
      expect(alert!.querySelector("code")?.textContent).toBe("GIT_UNAVAILABLE");
      expect(alert!.textContent).toContain("The selected file is not a Git executable.");
      expect(alert!.textContent).toContain("C:\Tools\other.exe");
    } finally {
      await view.done();
    }
  });

  test("a canceled chooseGit shows nothing", async () => {
    const view = await mountBlocked(CANCELED);
    try {
      expect(view.host.querySelector('[role="alert"]')).toBeNull();
      expect(view.host.textContent).not.toContain("did not complete");
    } finally {
      await view.done();
    }
  });
});

// Contract §11 "Distro start": a dismissal of a marker in a stopped distro reports phase `wsl-starting`. The boot view has no Cancel for it.
describe("marker dismissal start", () => {
  test("a wsl-starting event shows the start text in a live region below the markers, without Cancel, until the dismissal ends", async () => {
    const marker = { markerId: crypto.randomUUID(), kind: "commit" as const, startedAt: "2026-10-02T10:00:00Z", worktreeRoot: "\\\\wsl.localhost\\Ubuntu-26.04\\home\\me\\repo" };
    let progress: ((event: never) => void) | undefined;
    let end: () => void = () => {};
    const onDismissMarker = (_: string, onProgress?: unknown) => {
      progress = onProgress as (event: never) => void;
      return new Promise<void>((resolve) => (end = resolve));
    };
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(<BootView state="facts" environment={environment({ markers: [marker] })} onSelectGit={async () => CANCELED} onDismissMarker={onDismissMarker} />));
      await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Dismiss")!.click());
      await act(async () => progress!({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "running", phase: "wsl-starting", counters: {}, distro: "Ubuntu-26.04" } as never));
      const live = host.querySelector('[role="status"]')!;
      expect(live.textContent).toBe("Starting WSL distro Ubuntu-26.04…");
      // The live region follows the marker list.
      expect(host.querySelector("ul")!.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Cancel")).toBe(false);
      await act(async () => end());
      expect(host.querySelector('[role="status"]')!.textContent).toBe("");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("no network request", () => {
  test("no frontend source opens a network API", async () => {
    // A network API used as an identifier or by bracket access. A quote, a hyphen, or a word character next to a bare name marks a contract string or another name.
    // Feature 003 FR-022 and FR-025 texts say "the last fetch".
    const network = /(?<![\w"'`-])(?<!last )(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)(?![\w"'`-])|\[\s*["'`](fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)["'`]\s*\]/;
    for (const source of ["fetch(url)", "window.fetch(url)", "const f = fetch;", "new WebSocket(u)", 'globalThis["fetch"]', "window['fetch']", "self[`fetch`]"]) expect({ source, hit: network.test(source) }).toEqual({ source, hit: true });
    for (const source of ['"fetch"', "'fetch-checkout'", "--no-lazy-fetch", "since the last fetch."]) expect({ source, hit: network.test(source) }).toEqual({ source, hit: false });
    const sources = await Array.fromAsync(new Bun.Glob("src/frontend/**/*.{ts,tsx,html}").scan({ cwd: `${import.meta.dir}/../..` }));
    expect(sources.length).toBeGreaterThan(0);
    for (const path of sources) expect({ path, hit: network.exec(await Bun.file(`${import.meta.dir}/../../${path}`).text())?.[0] }).toEqual({ path, hit: undefined });
  });

  // Feature 006 contract Δ7: `'self'` is the app origin, which serves the bundled `hunspell.wasm`.
  test("the CSP connect-src allows only the IPC origins and the app origin", async () => {
    const config = await Bun.file(`${import.meta.dir}/../../src-tauri/tauri.conf.json`).json();
    expect(config.app.security.csp["connect-src"].split(" ")).toEqual(["ipc:", "http://ipc.localhost", "'self'"]);
  });
});

function buttons(node: ReactNode): ReactElement<{ onClick: () => void }>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<{ children?: ReactNode; onClick: () => void }>(node)) return [];
  return node.type === "button" || node.type === Button ? [node] : buttons(node.props.children);
}
