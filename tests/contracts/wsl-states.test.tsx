// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import type { WorkspaceSnapshot } from "../../src/contracts/envelope";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { contractChecked } from "./bridge-contract";

printOrigin("../../src/frontend/app/RepositoryStates.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
// These modules load Base UI. Base UI must first evaluate with a DOM, because test files share one module cache (tests/dom.ts).
registerDom();
const { createRoot } = await import("react-dom/client");
const { Workbench } = await import("../../src/frontend/app/Workbench");
const { RepositoryRefused, WslStarting, WSL_START_CANCELED_TEXT } = await import("../../src/frontend/app/RepositoryStates");
type Location = WorkspaceSnapshot["location"];

// tasks.md T216. plan.md "Header layout" and "Required visible states" (WSL location, Starting WSL distro, Repository refused). Contract §9 and §11.

type Call = { operation: string; args: unknown[]; resolve(response: unknown): void };
// Each request stays pending until the test resolves it.
function bridgeDouble() {
  const calls: Call[] = [];
  const bridge = new Proxy(
    {},
    {
      get: (_, name) =>
        (...args: unknown[]) =>
          new Promise((resolve) => calls.push({ operation: String(name), args, resolve })),
    },
  );
  const pending = (operation: string) => calls.find((c) => c.operation === operation)!;
  return { bridge: contractChecked(bridge), calls, pending };
}

const DISTRO = "Ubuntu-24.04";
// 30 characters: WSL `s_ValidateDistroName` admits `[a-zA-Z0-9._-]`.
const LONG_DISTRO = "Arbareto-Qualification-Distro1";
const REGISTRATION = { repositoryId: crypto.randomUUID(), generation: 1, worktreeKey: "a".repeat(64) };
const succeeded = (result: unknown) => ({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "succeeded", repositoryGeneration: 1, result });
// Contract §11 "Route": a WSL identity is the normalized UNC path with the `\\wsl.localhost\` prefix and the listed distro spelling.
const wslRoot = (distro: string) => `\\\\wsl.localhost\\${distro}\\home\\tester\\repo`;
const DISTRO_GIT = { path: "/usr/bin/git", version: "2.55.0" };
// Data-model §2 `location`: the service states it, and the renderer never derives it from the identity path.
const wslAt = (distro: string): Location => ({ kind: "wsl", distro, git: DISTRO_GIT });
const NATIVE: Location = { kind: "native" };
function snapshot(root: string, location: Location): WorkspaceSnapshot {
  return {
    generation: 1,
    snapshotId: crypto.randomUUID(),
    readKind: "full",
    identity: { worktreeRoot: root, gitDirectory: `${root}\\.git`, commonDirectory: `${root}\\.git`, indexPath: `${root}\\.git\\index`, objectFormat: "sha1", refFormat: "files" },
    head: { state: "branch", target: "refs/heads/main", oid: "1".repeat(40) },
    operationState: "normal",
    recoveryState: "ready",
    completeness: { state: "complete" },
    hunkEligibility: { eligible: true },
    location,
    submoduleNotice: { count: 0, paths: [], filter: "applied" },
    entryCount: 0,
    entries: [],
    cursor: null,
  };
}

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  localStorage.clear();
});
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));
const text = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ").trim();
const noop = () => {};

async function show(node: ReactNode): Promise<HTMLElement> {
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

const Empty = () => null;
// Mounts the workbench, restores one registration, and answers its first full read with a snapshot at `root`.
async function workbench(root: string, location: Location, textScale = 1) {
  const double = bridgeDouble();
  const host = await show(
    <Workbench
      bridge={double.bridge as never}
      restored={Promise.resolve(succeeded(REGISTRATION)) as never}
      textScale={textScale}
      ChangesPane={Empty}
      ComparisonView={Empty}
      HistoryView={Empty}
    />,
  );
  await act(async () => double.pending("readWorkspace").resolve(succeeded(snapshot(root, location))));
  await settle();
  return { ...double, host };
}
const wslWorkbench = (distro: string, textScale = 1) => workbench(wslRoot(distro), wslAt(distro), textScale);

const badge = (host: ParentNode) => host.querySelector<HTMLElement>("header [data-slot='wsl-badge']");

async function openRepositoryMenu(host: HTMLElement): Promise<string> {
  const trigger = [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) => text(e) === "Repository")!;
  await act(async () => trigger.focus());
  await act(async () => trigger.click());
  await settle();
  return text(document.querySelector('[data-slot="menubar-content"]')!);
}

describe("WSL location", () => {
  // T339 (a): data-model §2 `location`.
  test("the snapshot location decides the badge, never the identity path", async () => {
    expect(text(badge((await workbench(wslRoot(DISTRO), wslAt("Other-Distro"))).host)!)).toContain("WSL: Other-Distro");
    expect(badge((await workbench(wslRoot(DISTRO), NATIVE)).host)).toBeNull();
  });

  // T339 (c): the snapshot location carries the approved distro Git; the status bar shows its version.
  test("the status bar shows the distro Git version of the location", async () => {
    const { host } = await wslWorkbench(DISTRO);
    expect(text(host.querySelector('footer [data-slot="git-version"]')!)).toBe(`Git ${DISTRO_GIT.version} (WSL: ${DISTRO})`);
  });

  test("a WSL workspace shows the outline badge WSL: <distro> after the path, as text", async () => {
    const { host } = await wslWorkbench(DISTRO);
    const found = badge(host);
    expect(found).not.toBeNull();
    expect(text(found!)).toContain(`WSL: ${DISTRO}`);
    expect(found!.classList.contains("badge")).toBe(true);
    expect(found!.classList.contains("badge-wsl")).toBe(true);
    const identity = found!.parentElement!;
    const children = [...identity.children];
    expect(children.indexOf(found!)).toBeGreaterThan(children.findIndex((c) => text(c).includes("home")));
  });

  test("a Windows workspace shows no WSL badge", async () => {
    const { host } = await workbench("C:\\repo", NATIVE);
    expect(badge(host)).toBeNull();
    expect(text(host.querySelector("header")!)).not.toContain("WSL:");
  });

  test("the header badge has the fixed 160 DIP width times the text factor, at factors 1 and 2.25", async () => {
    expect(badge((await wslWorkbench(DISTRO, 1)).host)!.style.width).toBe("160px");
    expect(badge((await wslWorkbench(DISTRO, 2.25)).host)!.style.width).toBe("360px");
  });

  test("a 30-character distro name gets an end ellipsis, WSL: stays whole, and the accessible name holds the full label", async () => {
    expect(LONG_DISTRO).toHaveLength(30);
    const found = badge((await wslWorkbench(LONG_DISTRO)).host)!;
    const label = found.querySelector(".sr-only");
    expect(label?.textContent).toBe(`WSL: ${LONG_DISTRO}`);
    const visible = [...found.querySelectorAll<HTMLElement>("[aria-hidden='true']")];
    expect(visible.map((e) => e.textContent)).toEqual(["WSL: ", LONG_DISTRO]);
    expect(visible[0]!.classList.contains("shrink-0")).toBe(true);
    expect(visible[1]!.classList.contains("truncate")).toBe(true);
  });

  // T362: the repository menu holds actions only. The status bar Git segment holds the full distro name.
  test("the status bar Git segment holds the full WSL: <distro> name, and the repository menu holds no label, path, or Git version", async () => {
    const { host } = await wslWorkbench(LONG_DISTRO);
    expect(text(host.querySelector('footer [data-slot="git-version"]')!)).toBe(`Git ${DISTRO_GIT.version} (WSL: ${LONG_DISTRO})`);
    const menu = await openRepositoryMenu(host);
    for (const absent of [`WSL: ${LONG_DISTRO}`, `Git: ${DISTRO_GIT.path}`, `Version ${DISTRO_GIT.version}`, "HEAD:"]) expect(menu).not.toContain(absent);
  });
});

describe("Starting WSL distro", () => {
  test("phase wsl-starting shows the static text and a focusable Cancel, with no spinner, animation, or percentage", async () => {
    const host = await show(<WslStarting name={DISTRO} operationId={crypto.randomUUID()} cancel={async () => ({ requestId: null, state: "succeeded" })} />);
    expect(text(host)).toContain(`Starting WSL distro ${DISTRO}…`);
    expect(text(host)).not.toContain("%");
    expect(host.querySelector('[role="progressbar"], progress, [class*="animate-"], [class*="spin"]')).toBeNull();
    const cancel = [...host.querySelectorAll("button")].find((b) => text(b) === "Cancel")!;
    expect(cancel).toBeDefined();
    expect(cancel.disabled).toBe(false);
    expect(cancel.tabIndex).toBeGreaterThanOrEqual(0);
  });

  test("Cancel calls cancel for that operation", async () => {
    const operationId = crypto.randomUUID();
    const sent: unknown[] = [];
    const host = await show(<WslStarting name={DISTRO} operationId={operationId} cancel={async (payload) => (sent.push(payload), { requestId: null, state: "succeeded" })} />);
    const cancel = [...host.querySelectorAll("button")].find((b) => text(b) === "Cancel")!;
    await act(async () => cancel.click());
    expect(sent).toEqual([{ operationId }]);
  });

  test("the canceled text is the plan.md sentence", () => {
    expect(WSL_START_CANCELED_TEXT).toBe("WSL start canceled. The distro can keep starting.");
  });
});

// T218 and T339 (b): the workbench mounts WslStarting for phase `wsl-starting` of a registration or restore (contract §11 "Distro start").
describe("Starting WSL distro in the workbench", () => {
  const OPERATION = crypto.randomUUID();
  const starting = (requestId: string) => ({ requestId, operationId: OPERATION, state: "running", phase: "wsl-starting", counters: {}, distro: DISTRO });
  const accepted = (requestId: string) => ({ requestId, operationId: OPERATION, state: "accepted", counters: {} });
  const area = (host: ParentNode) => host.querySelector("[data-slot='status-area']")!;
  const statusBar = (host: ParentNode) => host.querySelector("footer [role='status']")!;
  const button = (host: ParentNode, label: string) => [...host.querySelectorAll("button")].find((b) => text(b) === label);
  const STARTING_TEXT = `Starting WSL distro ${DISTRO}…`;

  async function mount(props: Record<string, unknown> = {}) {
    const double = bridgeDouble();
    const host = await show(<Workbench bridge={double.bridge as never} ChangesPane={Empty} ComparisonView={Empty} HistoryView={Empty} {...props} />);
    return { ...double, host };
  }

  async function startOpen() {
    const mounted = await mount();
    await settle();
    const open = [...mounted.host.querySelectorAll<HTMLElement>('section[aria-label="Start page"] [role="option"]')].find((o) => text(o) === "Open folder… (Ctrl+O)")!;
    await act(async () => open.click());
    const call = mounted.pending("chooseRepository");
    const onProgress = call.args[0] as (event: unknown) => void;
    const requestId = crypto.randomUUID();
    await act(async () => onProgress(accepted(requestId)));
    expect(text(area(mounted.host))).toBe("");
    await act(async () => onProgress(starting(requestId)));
    await settle();
    expect(text(area(mounted.host))).toContain(STARTING_TEXT);
    return { ...mounted, call };
  }

  test("chooseRepository in phase wsl-starting shows the distro name with Cancel in the status region", async () => {
    const { host } = await startOpen();
    expect(text(area(host))).toContain(STARTING_TEXT);
    expect(button(area(host), "Cancel")).toBeDefined();
    // plan.md "Status area": the status bar text is the live region, so the start is one announced event.
    expect(text(statusBar(host))).toBe(STARTING_TEXT);
  });

  test("Cancel cancels the registration operation, focus returns to the repository switcher, and canceled shows the plan.md text", async () => {
    const { host, call, pending } = await startOpen();
    await act(async () => button(area(host), "Cancel")!.click());
    expect(pending("cancel").args[0]).toEqual({ operationId: OPERATION });
    expect(document.activeElement).toBe(host.querySelector('header button[aria-keyshortcuts="Control+R"]'));
    await act(async () => call.resolve({ requestId: crypto.randomUUID(), operationId: OPERATION, state: "canceled", code: "CANCELED" }));
    await settle();
    expect(text(area(host))).not.toContain(STARTING_TEXT);
    expect(text(statusBar(host))).toBe(WSL_START_CANCELED_TEXT);
    expect(host.querySelector('section[aria-label="Start page"]')).not.toBeNull();
  });

  test("a start deadline removes the state and shows the DEADLINE error with Open repository", async () => {
    const { host, call } = await startOpen();
    await act(async () => call.resolve({ requestId: crypto.randomUUID(), operationId: OPERATION, state: "failed", code: "DEADLINE" }));
    await settle();
    expect(text(area(host))).not.toContain(STARTING_TEXT);
    expect(text(statusBar(host))).not.toContain(STARTING_TEXT);
    const alert = host.querySelector("[role='alert']")!;
    expect(text(alert)).toContain("DEADLINE");
    expect(button(alert, "Open repository")).toBeDefined();
  });

  test("the restore at page start shows the state from its progress events, and its response removes it", async () => {
    let resolve: (response: unknown) => void = () => {};
    const restored = new Promise((r) => (resolve = r));
    const requestId = crypto.randomUUID();
    const { host } = await mount({ restored, restoreProgress: (listener: (event: unknown) => void) => listener(starting(requestId)) });
    expect(text(area(host))).toContain(STARTING_TEXT);
    await act(async () => resolve({ ...succeeded(REGISTRATION), operationId: OPERATION }));
    await settle();
    expect(text(area(host))).not.toContain(STARTING_TEXT);
  });

  // Contract §11 "Distro start": a marker dismissal in a stopped distro reports phase `wsl-starting`. Contract §11 defines Cancel only for a registration or restore.
  test("a marker dismissal in phase wsl-starting shows the state without Cancel, and its response removes it", async () => {
    const marker = { markerId: crypto.randomUUID(), kind: "commit", startedAt: "2026-10-01T10:00:00Z", worktreeRoot: `\\\\wsl.localhost\\${DISTRO}\\home\\me\\repo` };
    const environment = { buildIdentity: { version: "0.1.0", commit: "c".repeat(40), channel: "local" }, platformScope: "qualification-target", detectedVersion: "2.55.0.windows.3", minimumVersion: "2.55.0.windows.3", qualification: "unverified", markers: [marker], damagedMarkers: [] };
    const { host, pending } = await mount({ environment });
    await settle();
    await act(async () => button(host, "Dismiss")!.click());
    const call = pending("dismissRecoveryMarker");
    expect(call.args[0]).toEqual({ markerId: marker.markerId });
    const requestId = crypto.randomUUID();
    await act(async () => (call.args[1] as (event: unknown) => void)(starting(requestId)));
    await settle();
    expect(text(area(host))).toContain(STARTING_TEXT);
    expect(text(statusBar(host))).toBe(STARTING_TEXT);
    expect(button(area(host), "Cancel")).toBeUndefined();
    await act(async () => call.resolve({ requestId, operationId: OPERATION, state: "succeeded", result: {} }));
    await settle();
    expect(text(area(host))).not.toContain(STARTING_TEXT);
    expect(pending("getEnvironment")).toBeDefined();
  });

  test("the restore after a service-session event shows the state too", async () => {
    const double = bridgeDouble();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const render = (session: number) => root.render(<Workbench bridge={double.bridge as never} session={session} ChangesPane={Empty} ComparisonView={Empty} HistoryView={Empty} />);
    unmounts.push(async () => {
      await act(async () => root.unmount());
      host.remove();
    });
    await act(async () => render(0));
    await act(async () => render(1));
    await settle();
    const call = double.pending("restoreWorkspace");
    const requestId = crypto.randomUUID();
    await act(async () => (call.args[0] as (event: unknown) => void)(starting(requestId)));
    expect(text(area(host))).toContain(STARTING_TEXT);
    await act(async () => call.resolve({ requestId, operationId: OPERATION, state: "failed", code: "DEADLINE" }));
    await settle();
    expect(text(area(host))).not.toContain(STARTING_TEXT);
  });
});

describe("WSL refusals", () => {
  // Contract §9 and §11 texts. The service puts each text into the result (`src/git-service/wsl.ts`).
  const REFUSALS = [
    { code: "WSL_UNAVAILABLE", reason: "wsl-missing", text: "WSL is not available on this computer. Install WSL2, then open the folder again." },
    { code: "WSL_UNAVAILABLE", reason: "distro-missing", text: "No registered WSL distro has the name Ubuntu. Open the folder through a listed distro." },
    { code: "WSL_UNAVAILABLE", reason: "not-wsl2", text: "Distro Ubuntu is not a WSL2 distro. Arbareto opens repositories only in WSL2 distros." },
    {
      code: "WSL_UNAVAILABLE",
      reason: "no-user-manager",
      text: "Arbareto needs the systemd user manager in this distro to end the processes that Git starts. Set systemd=true under [boot] in /etc/wsl.conf, then restart the distro.",
    },
    { code: "WSL_UNAVAILABLE", reason: "no-setsid", text: "Arbareto needs the setsid program in Ubuntu. Install the util-linux package in the distro, then open the folder again." },
    { code: "WSL_UNAVAILABLE", reason: "no-coreutils", text: "Arbareto needs the stat, env, and sha256sum programs in /usr/bin of Ubuntu. Install the coreutils package in the distro, then open the folder again." },
    { code: "WSL_UNAVAILABLE", reason: "start-failed", text: "WSL could not start distro Ubuntu. Start it in a terminal, then open the folder again." },
    { code: "WSL_UNAVAILABLE", reason: "scope-arguments", text: "systemd-run in Ubuntu does not pass Git arguments unchanged. Update systemd in the distro to version 254 or later." },
    { code: "GIT_UNSUPPORTED", reason: "windows-git", text: "The git command in Ubuntu is Git for Windows. Install Linux Git 2.55.0 or later in the distro." },
    { code: "GIT_UNSUPPORTED", reason: "no-fs-uuid", text: "Arbareto cannot read a file-system UUID for Git in Ubuntu. Install Git on the distro's own disk." },
    { code: "UNSUPPORTED_REPOSITORY", reason: "wsl-path", text: "This path holds a name that Windows cannot show. Open another folder." },
    { code: "UNSUPPORTED_REPOSITORY", reason: "mixed-location", text: "The worktree and its Git directories must all lie inside one WSL distro, or all on Windows." },
    { code: "UNSUPPORTED_REPOSITORY", reason: "no-fs-uuid", text: "Arbareto cannot read a file-system UUID for this folder. Open a folder on the distro's own disk." },
  ] as const;

  for (const refusal of REFUSALS) {
    test(`${refusal.code} ${refusal.reason} shows the error icon, its code, its text, and Open repository`, async () => {
      const host = await show(<RepositoryRefused code={refusal.code} result={{ reason: refusal.reason, text: refusal.text }} onOpenRepository={noop} />);
      expect(host.querySelector('[role="alert"] svg[aria-hidden="true"]')).not.toBeNull();
      expect(text(host)).toContain(refusal.code);
      expect(text(host)).toContain(refusal.text);
      expect([...host.querySelectorAll("button")].map((b) => text(b))).toEqual(["Open repository"]);
    });
  }

  test("start-failed shows the bounded wsl.exe text as plain text", async () => {
    const detail = "Wsl/Service/WSL_E_DISTRO_NOT_FOUND\n";
    const host = await show(<RepositoryRefused code="WSL_UNAVAILABLE" result={{ reason: "start-failed", text: REFUSALS[6].text, detail }} onOpenRepository={noop} />);
    expect(host.querySelector("pre")?.textContent).toBe(detail);
  });

  test("the version refusal names the found and the required version, and its Ubuntu command gets Copy command", async () => {
    const result = {
      reason: "version" as const,
      text: "Git 2.43.0 in Ubuntu is older than 2.55.0. Install Git 2.55.0 or later in the distro. This command adds the official git-core PPA and installs its Git.",
      detectedVersion: "2.43.0",
      minimumVersion: "2.55.0",
      command:
        "& 'C:\\Windows\\System32\\wsl.exe' --distribution 'Ubuntu' --user root --cd / --exec /bin/sh -c 'add-apt-repository -y ppa:git-core/ppa && apt-get update && apt-get install -y git'",
    };
    const host = await show(<RepositoryRefused code="GIT_UNSUPPORTED" result={result} onOpenRepository={noop} />);
    expect(text(host)).toContain("2.43.0");
    expect(text(host)).toContain("2.55.0");
    expect(text(host)).toContain(result.command);
    expect([...host.querySelectorAll("button")].map((b) => text(b))).toEqual(["Copy command", "Open repository"]);
  });
});
