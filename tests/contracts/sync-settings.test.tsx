// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { stubLayout } from "./history-fake";
import { answer, button, buttons, click, createWorld, mountWorkbench, press, settle, settings, succeeded, text, unmountAll } from "./sync-fake";
import { contractChecked, fixtureId } from "./bridge-contract";

// tasks.md T071 (feature 003). Spec FR-032 to FR-037. Plan D9, D12, O-7, O-8, O-10. Contract Δ3 shell-only settings operations and `connectInTerminal`. Data-model §10, §11.

printOrigin("../../src/frontend/settings/SettingsDialog.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/NoticeBand.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre>{patch}</pre> }));
registerDom();
const { createRoot } = await import("react-dom/client");
const { SettingsDialog } = await import("../../src/frontend/settings/SettingsDialog");
const workbench = await import("../../src/frontend/app/Workbench");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());

type Call = { operation: string; args: unknown[]; resolve(response: unknown): void };
// `readSyncSettings` answers from `current`. Every other call waits for the test.
function bridgeDouble(current: Record<string, unknown>) {
  const calls: Call[] = [];
  const bridge = new Proxy(
    {},
    {
      get: (_, name) =>
        (...args: unknown[]) =>
          new Promise((resolve) => {
            const operation = String(name);
            calls.push({ operation, args, resolve });
            if (operation === "readSyncSettings") setTimeout(() => resolve(ok(current)), 0);
          }),
    },
  );
  const pending = (operation: string) => calls.findLast((c) => c.operation === operation)!;
  return { bridge: contractChecked(bridge), calls, pending, names: () => calls.map((c) => c.operation) };
}
const KEY = "a".repeat(64);
const base = (fields: Record<string, unknown> = {}) => ({ ...settings("pull"), ...fields });
const ok = (result: unknown) => ({ requestId: "s", state: "succeeded", result });
const PROGRAMS = [
  { program: "plink", path: "C:\\PuTTY\\plink.exe", present: true },
  { program: "pageant", path: "C:\\PuTTY\\pageant.exe", present: true },
  { program: "puttygen", path: "C:\\PuTTY\\puttygen.exe", present: false },
];
const WITH_PLINK = { plinkPath: "C:\\PuTTY\\plink.exe", programs: PROGRAMS };

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  await unmountAll();
});
async function renderSettings(current = base(), repository: { worktreeKey: string; proposals: { remote: string; path: string }[] } | null = null) {
  const double = bridgeDouble(current);
  let closed = 0;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(<SettingsDialog bridge={double.bridge as never} repository={repository} onClose={() => void (closed += 1)} />));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await settle();
  return { ...double, closed: () => closed };
}
const panel = () => document.querySelector<HTMLElement>('section[data-slot="settings-panel"]')!;
const radio = (label: string) => [...panel().querySelectorAll<HTMLLabelElement>("label")].find((l) => text(l) === label)!.querySelector<HTMLInputElement>("input")!;
async function resolve(call: Call, response: unknown) {
  await act(async () => call.resolve(response));
  await settle();
}

describe("SSH client (FR-032, FR-033)", () => {
  test("Git's own configuration is the default, and the settings state the WSL rule", async () => {
    await renderSettings();
    expect(radio("Git's own configuration").checked).toBe(true);
    expect(radio("PuTTY (plink)").checked).toBe(false);
    expect(text(panel())).toContain("PuTTY applies only to Windows repositories. A WSL repository uses the SSH setup of its distro.");
  });

  test("PuTTY (plink) without a plink program asks for it first, then sets the client", async () => {
    const r = await renderSettings();
    await click(radio("PuTTY (plink)"));
    expect(r.pending("chooseSyncPath").args[0]).toEqual({ target: "plink" });
    expect(r.names()).not.toContain("setSshClient");
    await resolve(r.pending("chooseSyncPath"), ok(base(WITH_PLINK)));
    expect(r.pending("setSshClient").args[0]).toEqual({ kind: "plink" });
    await resolve(r.pending("setSshClient"), ok(base({ ...WITH_PLINK, sshClient: "plink" })));
    expect(radio("PuTTY (plink)").checked).toBe(true);
  });

  // An arrow key moves the radio selection and fires `change` during its keydown (HTML "radio button state"). It must never open a file picker.
  test("an arrow key onto PuTTY (plink) without a plink program opens no picker; Space then opens it", async () => {
    const r = await renderSettings();
    const plink = radio("PuTTY (plink)");
    await act(async () => {
      radio("Git's own configuration").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      plink.click();
      plink.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    await settle();
    expect(r.names()).not.toContain("chooseSyncPath");
    expect(r.names()).not.toContain("setSshClient");
    expect(radio("Git's own configuration").checked).toBe(true);
    // Space activates a focused radio with a click on keyup (HTML "activation behavior").
    await act(async () => {
      plink.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
      plink.click();
      plink.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true, cancelable: true }));
    });
    await settle();
    expect(r.pending("chooseSyncPath").args[0]).toEqual({ target: "plink" });
  });

  test("Clear plink is unavailable with a reason while the client is PuTTY (plink)", async () => {
    const r = await renderSettings(base({ ...WITH_PLINK, sshClient: "plink" }));
    const clear = button("Clear plink", panel());
    expect(clear.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(clear.getAttribute("aria-describedby")!)?.textContent).toBe("Select Git's own configuration before you clear the plink program.");
    await click(clear);
    expect(r.names()).not.toContain("clearSyncPath");
  });

  test("a canceled plink picker keeps Git's own configuration", async () => {
    const r = await renderSettings();
    await click(radio("PuTTY (plink)"));
    await resolve(r.pending("chooseSyncPath"), { requestId: "s", state: "canceled" });
    expect(r.names()).not.toContain("setSshClient");
    expect(radio("Git's own configuration").checked).toBe(true);
  });

  test("the settings list the PuTTY programs of the plink folder and name a missing one", async () => {
    await renderSettings(base(WITH_PLINK));
    expect(text(panel())).toContain("C:\\PuTTY\\pageant.exe");
    expect(text(panel())).toContain("PuTTYgen: C:\\PuTTY\\puttygen.exe Not available");
  });

  test("Escape closes the settings", async () => {
    const r = await renderSettings();
    await press(radio("Git's own configuration"), "Escape");
    expect(r.closed()).toBe(1);
  });
});

describe("key files (FR-035, O-8)", () => {
  test("the remote.<name>.puttykeyfile value shows only as a proposal until the user saves a key file", async () => {
    const r = await renderSettings(base(WITH_PLINK), { worktreeKey: KEY, proposals: [{ remote: "origin", path: "C:\\keys\\ge.ppk" }] });
    expect(text(panel())).toContain("origin");
    expect(text(panel())).toContain("No key file");
    expect(text(panel())).toContain("Git Extensions setting: C:\\keys\\ge.ppk");
    expect(r.names()).toEqual(["readSyncSettings"]);
    await click(button("Choose key file for origin…", panel()));
    expect(r.pending("chooseSyncPath").args[0]).toEqual({ target: "remoteKey", worktreeKey: KEY, remote: "origin" });
    await resolve(r.pending("chooseSyncPath"), ok(base({ ...WITH_PLINK, remoteKeyFiles: [{ worktreeKey: KEY, remote: "origin", path: "C:\\keys\\mine.ppk" }] })));
    expect(text(panel())).toContain("C:\\keys\\mine.ppk");
  });

  test("a saved key file of another repository does not show, and Clear removes the saved one", async () => {
    const r = await renderSettings(base({ remoteKeyFiles: [{ worktreeKey: KEY, remote: "origin", path: "C:\\keys\\mine.ppk" }, { worktreeKey: "b".repeat(64), remote: "other", path: "C:\\keys\\other.ppk" }] }), { worktreeKey: KEY, proposals: [] });
    expect(text(panel())).toContain("C:\\keys\\mine.ppk");
    expect(text(panel())).not.toContain("C:\\keys\\other.ppk");
    await click(button("Clear key file for origin", panel()));
    expect(r.pending("clearSyncPath").args[0]).toEqual({ target: "remoteKey", worktreeKey: KEY, remote: "origin" });
  });

  test("without a repository, the settings show no key file list", async () => {
    await renderSettings(base({ remoteKeyFiles: [{ worktreeKey: KEY, remote: "origin", path: "C:\\keys\\mine.ppk" }] }));
    expect(text(panel())).toContain("Open a repository to set its key files.");
    expect(text(panel())).not.toContain("C:\\keys\\mine.ppk");
  });
});

describe("PuTTYgen (FR-036, FR-037)", () => {
  test("Generate or convert a key starts PuTTYgen, and PUTTY_UNAVAILABLE names the program and the path", async () => {
    const r = await renderSettings(base(WITH_PLINK));
    await click(button("Generate or convert a key", panel()));
    expect(r.pending("launchPuttygen")).toBeDefined();
    await resolve(r.pending("launchPuttygen"), { requestId: "g", state: "failed", code: "PUTTY_UNAVAILABLE", result: { reason: "missing", program: "puttygen", path: "C:\\PuTTY\\puttygen.exe" } });
    expect(text(panel())).toContain("PuTTYgen is not available: C:\\PuTTY\\puttygen.exe (missing)");
  });
});

describe("default clone folder (FR-054)", () => {
  test("the default clone folder can be set and cleared", async () => {
    const r = await renderSettings();
    expect(text(panel())).toContain("Default clone folder");
    await click(button("Choose default clone folder…", panel()));
    expect(r.pending("chooseSyncPath").args[0]).toEqual({ target: "cloneFolder" });
    await resolve(r.pending("chooseSyncPath"), ok(base({ defaultCloneFolder: "E:\\clones" })));
    expect(text(panel())).toContain("E:\\clones");
    await click(button("Clear default clone folder", panel()));
    expect(r.pending("clearSyncPath").args[0]).toEqual({ target: "cloneFolder" });
  });
});

describe("Connect in a terminal (FR-034, O-10)", () => {
  const band = () => document.querySelector('[data-slot="notice-band"]')!;
  async function failedFetch(sshClient: "git" | "plink", result: object) {
    const world = createWorld();
    world.answers.readSyncSettings = () => succeeded({ ...settings("pull"), sshClient, ...(sshClient === "plink" ? WITH_PLINK : {}) });
    const double = await mountWorkbench(workbench, world);
    await click(button("Fetch"));
    await answer(double.pending("reviewSync"), succeeded({ action: "fetch", plan: { remotes: ["origin"] }, syncReviewToken: fixtureId(0x101) }));
    await answer(double.pending("sync"), { requestId: "r", operationId: fixtureId(0x219), state: "failed", code: "GIT_FAILED", result });
    await settle();
    return double;
  }

  test("data-model §11: a result with connectTarget offers Connect in a terminal and names no cause", async () => {
    const double = await failedFetch("plink", { action: "fetch", connectTarget: true });
    expect(text(band())).toContain("Fetch did not complete with PuTTY (plink).");
    expect(text(band())).not.toMatch(/host key|passphrase|sign-in|SSH/);
    await click(button("Connect in a terminal", band()));
    expect(double.pending("connectInTerminal")!.args.slice(0, 2)).toEqual([{ repositoryId: fixtureId(1) }, { operationId: fixtureId(0x219) }]);
    await answer(double.pending("connectInTerminal"), { requestId: "x", state: "failed", code: "PUTTY_UNAVAILABLE", result: { reason: "missing", program: "plink", path: "C:\\PuTTY\\plink.exe" } });
    expect(text(band())).toContain("plink is not available: C:\\PuTTY\\plink.exe (missing)");
  });

  test("data-model §11: a failed network operation without connectTarget offers no Connect in a terminal, also under plink", async () => {
    await failedFetch("plink", { action: "fetch" });
    expect(buttons("Connect in a terminal").length).toBe(0);
  });
});
