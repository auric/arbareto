// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import type { WorkspaceSnapshot } from "../../src/contracts/envelope";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";

printOrigin("../../src/frontend/app/RepositoryStates.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
// These modules load Base UI. Base UI must first evaluate with a DOM, because test files share one module cache (tests/dom.ts).
registerDom();
const { createRoot } = await import("react-dom/client");
const { Workbench } = await import("../../src/frontend/app/Workbench");
const { RepositoryMenu } = await import("../../src/frontend/app/RepositoryMenu");
const { RepositoryRefused, WslStarting, WSL_START_CANCELED_TEXT } = await import("../../src/frontend/app/RepositoryStates");
const { Menubar } = await import("../../src/frontend/components/ui/menubar");

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
  return { bridge, calls, pending };
}

const DISTRO = "Ubuntu-24.04";
// 30 characters: WSL `s_ValidateDistroName` admits `[a-zA-Z0-9._-]`.
const LONG_DISTRO = "Arbareto-Qualification-Distro1";
const REGISTRATION = { repositoryId: crypto.randomUUID(), generation: 1, worktreeKey: "a".repeat(64) };
const succeeded = (result: unknown) => ({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "succeeded", repositoryGeneration: 1, result });
// Contract §11 "Route": a WSL identity is the normalized UNC path with the `\\wsl.localhost\` prefix and the listed distro spelling.
const wslRoot = (distro: string) => `\\\\wsl.localhost\\${distro}\\home\\tester\\repo`;
function snapshot(root: string): WorkspaceSnapshot {
  return {
    generation: 1,
    snapshotId: crypto.randomUUID(),
    identity: { worktreeRoot: root, gitDirectory: `${root}\\.git`, commonDirectory: `${root}\\.git`, indexPath: `${root}\\.git\\index`, objectFormat: "sha1", refFormat: "files" },
    head: { state: "branch", target: "refs/heads/main", oid: "1".repeat(40) },
    operationState: "normal",
    recoveryState: "ready",
    completeness: { state: "complete" },
    hunkEligibility: { eligible: true },
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
async function workbench(root: string, textScale = 1) {
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
  await act(async () => double.pending("readWorkspace").resolve(succeeded(snapshot(root))));
  await settle();
  return { ...double, host };
}

const badge = (host: ParentNode) => host.querySelector<HTMLElement>("header [data-slot='wsl-badge']");

describe("WSL location", () => {
  test("a WSL workspace shows the outline badge WSL: <distro> after the path, as text", async () => {
    const { host } = await workbench(wslRoot(DISTRO));
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
    const { host } = await workbench("C:\\repo");
    expect(badge(host)).toBeNull();
    expect(text(host.querySelector("header")!)).not.toContain("WSL:");
  });

  test("the header badge has the fixed 160 DIP width times the text factor, at factors 1 and 2.25", async () => {
    expect(badge((await workbench(wslRoot(DISTRO), 1)).host)!.style.width).toBe("160px");
    expect(badge((await workbench(wslRoot(DISTRO), 2.25)).host)!.style.width).toBe("360px");
  });

  test("a 30-character distro name gets an end ellipsis, WSL: stays whole, and the accessible name holds the full label", async () => {
    expect(LONG_DISTRO).toHaveLength(30);
    const found = badge((await workbench(wslRoot(LONG_DISTRO))).host)!;
    const label = found.querySelector(".sr-only");
    expect(label?.textContent).toBe(`WSL: ${LONG_DISTRO}`);
    const visible = [...found.querySelectorAll<HTMLElement>("[aria-hidden='true']")];
    expect(visible.map((e) => e.textContent)).toEqual(["WSL: ", LONG_DISTRO]);
    expect(visible[0]!.classList.contains("shrink-0")).toBe(true);
    expect(visible[1]!.classList.contains("truncate")).toBe(true);
  });

  test("the repository menu shows the full WSL: <distro> label", async () => {
    const { host } = await workbench(wslRoot(LONG_DISTRO));
    const trigger = [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) => text(e) === "Repository")!;
    await act(async () => trigger.focus());
    await act(async () => trigger.click());
    await settle();
    const menu = document.querySelector('[data-slot="menubar-content"]');
    expect(menu).not.toBeNull();
    expect(text(menu!)).toContain(`WSL: ${LONG_DISTRO}`);
  });

  test("the repository menu shows the label above the distro Git path and version", async () => {
    const host = await show(
      <Menubar>
        <RepositoryMenu
          environment={null}
          path={wslRoot(DISTRO)}
          head="main"
          distro={DISTRO}
          wslGit={{ path: "/usr/bin/git", version: "2.55.0" }}
          trustId={null}
          onOpenRepository={noop}
          onSelectGit={noop}
          onReviewTrust={noop}
          revokeTrust={async () => ({ requestId: null, state: "succeeded" })}
        />
      </Menubar>,
    );
    const trigger = [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) => text(e) === "Repository")!;
    await act(async () => trigger.focus());
    await act(async () => trigger.click());
    await settle();
    const menu = text(document.querySelector('[data-slot="menubar-content"]')!);
    const label = menu.indexOf(`WSL: ${DISTRO}`);
    expect(label).toBeGreaterThanOrEqual(0);
    expect(menu.indexOf("Git: /usr/bin/git")).toBeGreaterThan(label);
    expect(menu.indexOf("Version 2.55.0")).toBeGreaterThan(label);
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
