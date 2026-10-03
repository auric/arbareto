// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { printOrigin } from "../origin";
import { BootView, bootActions, markBootView, type BootProps, type Environment } from "../../src/frontend/boot/BootView";

printOrigin("../../src/frontend/boot/BootView.tsx", import.meta.dir);

const environment = (fields: Partial<Environment> = {}): Environment => ({
  buildIdentity: { version: "0.1.0", commit: "c".repeat(40) + "-dirty", signing: "unsigned" },
  platformScope: "other",
  detectedVersion: "2.43.0.windows.1",
  minimumVersion: "2.55.0.windows.3",
  qualification: "unverified",
  markers: [],
  damagedMarkers: [],
  ...fields,
});

const render = (env: Environment) => renderToStaticMarkup(<BootView state="facts" environment={env} onSelectGit={() => {}} onDismissMarker={() => {}} />);

describe("boot view", () => {
  test("the unavailable state names the code", () => {
    expect(renderToStaticMarkup(<BootView state="unavailable" code="SERVICE_UNAVAILABLE" />)).toContain("Git service not connected: SERVICE_UNAVAILABLE");
  });

  test("the facts state shows the build identity and the T064 labels", () => {
    const html = render(environment());
    expect(html).toContain("c".repeat(40) + "-dirty");
    expect(html).toContain("Unsigned local test package");
    expect(html).toContain("Unqualified platform");
    expect(html).not.toContain("Select Git");
  });

  test("each Git code shows a blocked state with both versions and Select Git", () => {
    for (const gitCode of ["GIT_UNAVAILABLE", "GIT_UNSUPPORTED", "GIT_CHANGED"]) {
      const html = render(environment({ gitCode }));
      expect(html).toContain(gitCode);
      expect(html).toContain("2.43.0.windows.1");
      expect(html).toContain("2.55.0.windows.3");
      expect(html).toContain("Select Git");
    }
  });

  test("any other Git code shows as plain text with Select Git", () => {
    for (const gitCode of ["DEADLINE", "OUTPUT_LIMIT", "UNKNOWN_TARGET", "PROCESS_OWNERSHIP_FAILED", "UNSUPPORTED_REPOSITORY", "GIT_FAILED"]) {
      const html = render(environment({ gitCode }));
      expect(html).toContain(gitCode);
      expect(html).toContain("Select Git");
    }
  });

  test("each recovery marker shows its facts and a Dismiss action", () => {
    const marker = { markerId: crypto.randomUUID(), kind: "commit", startedAt: "2026-10-02T10:00:00Z", worktreeRoot: "C:\\repo" };
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
    const markers = ["a", "b"].map((markerId) => ({ markerId, kind: "commit", startedAt: "2026-10-02T10:00:00Z", worktreeRoot: "C:\\repo" }));
    const calls: string[] = [];
    const damagedMarkers = [{ markerId: "c", fileName: "broken.json" }];
    const props: BootProps = { state: "facts", environment: environment({ gitCode: "GIT_UNAVAILABLE", markers, damagedMarkers }), onSelectGit: () => calls.push("select"), onDismissMarker: (id) => calls.push(`dismiss ${id}`) };
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
      {
        chooseGit: async () => (calls.push("chooseGit"), done),
        dismissRecoveryMarker: async (payload) => (calls.push(payload), done),
      },
      () => calls.push("reload"),
    );
    actions.onSelectGit();
    actions.onDismissMarker("m1");
    await Bun.sleep(0);
    expect(calls).toEqual(["chooseGit", { markerId: "m1" }, "reload", "reload"]);
  });

  test("the boot-view mark happens once", () => {
    markBootView();
    markBootView();
    expect(performance.getEntriesByName("arbareto:boot-view", "mark")).toHaveLength(1);
  });
});

describe("no network request", () => {
  test("no frontend source opens a network API", async () => {
    const network = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/;
    const sources = await Array.fromAsync(new Bun.Glob("src/frontend/**/*.{ts,tsx,html}").scan({ cwd: `${import.meta.dir}/../..` }));
    expect(sources.length).toBeGreaterThan(0);
    for (const path of sources) expect({ path, hit: network.exec(await Bun.file(`${import.meta.dir}/../../${path}`).text())?.[0] }).toEqual({ path, hit: undefined });
  });

  test("the CSP connect-src allows only the IPC origins", async () => {
    const config = await Bun.file(`${import.meta.dir}/../../src-tauri/tauri.conf.json`).json();
    expect(config.app.security.csp["connect-src"].split(" ")).toEqual(["ipc:", "http://ipc.localhost"]);
  });
});

function buttons(node: ReactNode): ReactElement<{ onClick: () => void }>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<{ children?: ReactNode; onClick: () => void }>(node)) return [];
  return node.type === "button" ? [node] : buttons(node.props.children);
}
