// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { button, buttons, click, press, settle, text } from "./sync-fake";
import { contractChecked, fixtureId } from "./bridge-contract";

// tasks.md T070 (feature 003). Spec FR-046 to FR-050, FR-054, SC-011. Plan D10, D12. Contract Δ3 `clone` and `connectInTerminal`. Data-model §8, §10, §11.

printOrigin("../../src/frontend/clone/CloneDialog.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/RepositoryMenu.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/RepositoryStates.tsx", import.meta.dir);
// These modules load Base UI. Base UI must first evaluate with a DOM (tests/dom.ts).
registerDom();
const { createRoot } = await import("react-dom/client");
const { CloneDialog } = await import("../../src/frontend/clone/CloneDialog");
const { RepositoryMenu } = await import("../../src/frontend/app/RepositoryMenu");
const { StartPage } = await import("../../src/frontend/app/RepositoryStates");
const { Menubar } = await import("../../src/frontend/components/ui/menubar");

type Call = { operation: string; args: unknown[]; resolve(response: unknown): void };
function bridgeDouble(answers: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const bridge = new Proxy(
    {},
    {
      get: (_, name) =>
        (...args: unknown[]) =>
          new Promise((resolve) => {
            const operation = String(name);
            calls.push({ operation, args, resolve });
            if (operation in answers) setTimeout(() => resolve(answers[operation]), 0);
          }),
    },
  );
  const pending = (operation: string) => calls.findLast((c) => c.operation === operation)!;
  return { bridge: contractChecked(bridge), calls, pending, names: () => calls.map((c) => c.operation) };
}

const settingsOf = (fields: Record<string, unknown> = {}) => ({
  requestId: "s",
  state: "succeeded",
  result: { sshClient: "git", defaultPullAction: "pull", switchChoice: "keep", plinkPath: null, programs: [], remoteKeyFiles: [], defaultCloneFolder: null, lastCloneParent: "D:\\src", ...fields },
});
const PLINK = { sshClient: "plink", plinkPath: "C:\\PuTTY\\plink.exe" };
const URL = "https://example.test/team/tool.git";

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});
async function show(node: ReactNode) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(node));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await settle();
  return host;
}

// `null` leaves `readSyncSettings` pending.
async function renderClone(settings: unknown = settingsOf()) {
  const double = bridgeDouble(settings === null ? {} : { readSyncSettings: settings });
  const opened: unknown[] = [];
  let closed = 0;
  const host = await show(<CloneDialog bridge={double.bridge as never} separator={"\\"} onOpened={(r) => void opened.push(r)} onClose={() => void (closed += 1)} />);
  return { ...double, host, opened, closed: () => closed };
}
const panel = () => document.querySelector<HTMLElement>('section[data-slot="clone-panel"]')!;
const field = (label: string) => {
  const found = [...panel().querySelectorAll<HTMLLabelElement>("label")].find((l) => text(l) === label);
  if (found === undefined) throw new Error(`no label "${label}"`);
  return (found.control ?? found.querySelector("input")) as HTMLInputElement;
};
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
const urlField = () => field("Remote URL");
const destinationField = () => field("Destination folder");
const cloneButton = () => button("Clone", panel());
async function started(settings: unknown = settingsOf()) {
  const r = await renderClone(settings);
  await type(urlField(), URL);
  await click(cloneButton());
  return r;
}
async function ended(response: unknown, settings: unknown = settingsOf()) {
  const r = await started(settings);
  await act(async () => r.pending("clone").resolve(response));
  await settle();
  return r;
}
const failed = (code: string, result?: unknown, state = "failed") => ({ requestId: "c", operationId: fixtureId(0x211), state, code, ...(result === undefined ? {} : { result }) });

describe("Clone entry points (FR-046)", () => {
  test("the start page shows Clone, and it opens the clone panel", async () => {
    let clones = 0;
    const double = bridgeDouble();
    const host = await show(<StartPage bridge={double.bridge as never} busy={false} onOpenFolder={() => {}} onOpened={() => {}} onClone={() => void (clones += 1)} />);
    await click(button("Clone…", host));
    expect(clones).toBe(1);
  });

  test("the repository menu holds Clone… and Settings…", async () => {
    const opened: string[] = [];
    const host = await show(
      <Menubar>
        <RepositoryMenu
          repositoryOpen={false}
          trustId={null}
          onOpenRepository={() => {}}
          onSelectGit={() => {}}
          onReviewTrust={() => {}}
          revokeTrust={async () => ({ requestId: null, state: "succeeded" })}
          onClone={() => void opened.push("clone")}
          onOpenSettings={() => void opened.push("settings")}
        />
      </Menubar>,
    );
    const trigger = [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) => text(e) === "Repository")!;
    await click(trigger);
    const item = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) => text(e) === label)!;
    await click(item("Clone…"));
    expect(opened).toEqual(["clone"]);
    await click(trigger);
    await click(item("Settings…"));
    expect(opened).toEqual(["clone", "settings"]);
  });
});

describe("clone panel destination (FR-054)", () => {
  test("the destination follows URL edits until the first destination edit, then stays", async () => {
    await renderClone();
    await type(urlField(), URL);
    expect(destinationField().value).toBe("D:\\src\\tool");
    await type(urlField(), "git@host:team/other.git");
    expect(destinationField().value).toBe("D:\\src\\other");
    await type(destinationField(), "E:\\work\\mine");
    await type(urlField(), URL);
    expect(destinationField().value).toBe("E:\\work\\mine");
  });

  test("without a last clone parent, the default clone folder is the parent", async () => {
    await renderClone(settingsOf({ lastCloneParent: null, defaultCloneFolder: "E:\\clones" }));
    await type(urlField(), URL);
    expect(destinationField().value).toBe("E:\\clones\\tool");
  });

  test("Clone sends only the destination that the panel shows, and only at the explicit start", async () => {
    const r = await renderClone();
    await type(urlField(), URL);
    await type(destinationField(), "E:\\edited\\tool");
    expect(r.names()).toEqual(["readSyncSettings"]);
    await click(cloneButton());
    expect(r.names()).toEqual(["readSyncSettings", "clone"]);
    expect(r.pending("clone").args[0]).toEqual({ url: URL, destination: "E:\\edited\\tool", keyFile: "none" });
  });

  test("Clone stays unavailable while the settings load and states the reason", async () => {
    const r = await renderClone(null);
    await type(urlField(), URL);
    expect(text(panel())).toContain("The clone settings are still loading…");
    await click(cloneButton());
    expect(r.names()).toEqual(["readSyncSettings"]);
  });

  test("a failed settings read names its code", async () => {
    await renderClone({ requestId: "s", state: "rejected", code: "SERVICE_UNAVAILABLE" });
    expect(text(panel())).toContain("The clone settings did not load: SERVICE_UNAVAILABLE.");
  });

  test("Escape closes the panel", async () => {
    const r = await renderClone();
    await press(urlField(), "Escape");
    expect(r.closed()).toBe(1);
  });
});

describe("clone PuTTY key file (FR-049)", () => {
  test("under git, the panel offers no key file", async () => {
    await renderClone();
    expect(text(panel())).not.toContain("PuTTY key file");
  });

  test("under plink, one optional key file goes with the start and is saved nowhere", async () => {
    const r = await renderClone(settingsOf(PLINK));
    await type(urlField(), URL);
    await click(field("Pick a PuTTY key file at the start"));
    await click(cloneButton());
    expect(r.pending("clone").args[0]).toEqual({ url: URL, destination: "D:\\src\\tool", keyFile: "picked" });
    expect(r.names()).toEqual(["readSyncSettings", "clone"]);
  });
});

describe("clone run and result (FR-048, FR-050)", () => {
  test("a running clone shows Cloning into <folder>… with Cancel, and Cancel sends the operation", async () => {
    const r = await started();
    expect(text(panel())).toContain("Cloning into D:\\src\\tool…");
    const onProgress = r.pending("clone").args[1] as (event: unknown) => void;
    await act(async () => onProgress({ requestId: "c", operationId: fixtureId(0x211), state: "running", phase: "clone", counters: { percent: 40 }, stalled: false }));
    await settle();
    expect(text(panel())).toContain("40%");
    await click(button("Cancel", panel()));
    expect(r.pending("cancel").args[0]).toEqual({ operationId: fixtureId(0x211) });
  });

  test("DESTINATION_NOT_EMPTY names the destination", async () => {
    await ended(failed("DESTINATION_NOT_EMPTY", { reason: "not-empty", path: "D:\\src\\tool" }));
    expect(text(panel())).toContain("Clone did not complete: DESTINATION_NOT_EMPTY");
    expect(text(panel())).toContain("The destination folder is not empty: D:\\src\\tool");
  });

  test("a canceled clone that left files states that Arbareto deleted and moved no file", async () => {
    await ended(failed("CANCELED", { exists: true, empty: false, outputTail: "", remedy: { text: "Run it in a terminal.", command: null } }, "canceled"));
    expect(text(panel())).toContain("Clone canceled");
    expect(text(panel())).toContain("The folder is not empty. Arbareto deleted and moved no file.");
  });

  test("exists and empty name the folder state", async () => {
    await ended(failed("GIT_FAILED", { exists: false, empty: false, outputTail: "fatal: x", remedy: { text: "Run it in a terminal.", command: null } }));
    expect(text(panel())).toContain("The folder does not exist.");
    expect(text(panel())).toContain("fatal: x");
    await unmounts.pop()!();
    await ended(failed("GIT_FAILED", { exists: true, empty: true, outputTail: "", remedy: { text: "Run it in a terminal.", command: null } }));
    expect(text(panel())).toContain("The folder is empty.");
  });

  test("a result without exists and empty states that the folder state is unknown", async () => {
    await ended(failed("GIT_FAILED"));
    expect(text(panel())).toContain("The folder state is unknown.");
    expect(text(panel())).not.toContain("The folder is empty.");
    expect(text(panel())).not.toContain("The folder does not exist.");
  });

  test("data-model §11: a result with connectTarget offers Connect in a terminal for its operation", async () => {
    const r = await ended(failed("GIT_FAILED", { connectTarget: true }));
    await click(button("Connect in a terminal", panel()));
    expect(r.pending("connectInTerminal").args.slice(0, 2)).toEqual([{}, { operationId: fixtureId(0x211) }]);
  });

  test("data-model §11: a failed clone without connectTarget offers no Connect in a terminal, also under plink", async () => {
    await ended(failed("GIT_FAILED"), settingsOf(PLINK));
    expect(buttons("Connect in a terminal", panel()).length).toBe(0);
    await unmounts.pop()!();
    await ended(failed("DESTINATION_NOT_EMPTY", { reason: "not-empty", path: "E:\\clones\\full" }), settingsOf(PLINK));
    expect(buttons("Connect in a terminal", panel()).length).toBe(0);
  });

  test("a succeeded clone goes to the registration flow", async () => {
    const response = { requestId: "c", operationId: fixtureId(0x211), state: "succeeded", repositoryGeneration: 1, result: { repositoryId: "r", generation: 1, worktreeKey: "a".repeat(64) } };
    const r = await ended(response);
    expect(r.opened).toEqual([response]);
  });

  test("the panel never shows the URL user information outside the URL field", async () => {
    const r = await renderClone();
    await type(urlField(), "https://user:secret@example.test/team/tool.git");
    await click(cloneButton());
    expect(text(panel())).not.toContain("secret");
    await act(async () => r.pending("clone").resolve(failed("GIT_FAILED")));
    await settle();
    expect(text(panel())).not.toContain("secret");
  });
});
