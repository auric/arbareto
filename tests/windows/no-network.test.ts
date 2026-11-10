// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 003 T079: no network use without a user network action in the installed package. Spec FR-041, SC-013; plan.md P12. `Local: package`.
// Counters decide, never log text: the `git daemon` access-hook lines, the HTTP request counter, and the SSH connection counter (tasks.md "Test harness rules").
// A focus return counts only as a trusted DOM `focus` event on `window` after the app process owns the foreground window again. `window` focus is the FR-041 trigger of src/frontend/app/Workbench.tsx and src/frontend/state/requests.ts.
// The cases send no OS input. UI Automation SetFocus moves the foreground between an owned WPF window and the app window.
// The case takes the foreground and runs 30 minutes, so it runs only with `ARBARETO_LIVE_INPUT=1` in the 001 T165 measurement account. Otherwise it skips with a reason.
// The closing control runs Git with the app environment against the same remote names, so a proxy or URL rewrite that hides a request turns the case red.
// Control mutation: let the Workbench.tsx `onFocus` handler also start Fetch all remotes; the counter assertion must fail.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { fixtureDir, FIXTURE_ROOT, useFixtureRoot } from "../git/fixture-root";
import { fixtureGitPath, GIT } from "../git/git-binary";
import { buildCredentialRemote, credentialHelper, gitOut, gitRun, HTTP_PASSWORD, HTTP_USER, nativeEnv, nativeHost, type GitHost } from "../git/remote-fixtures";
import { printOrigin } from "../origin";
import { startGitDaemon } from "../support/git-daemon";
import { startHttpRemote, within } from "../support/http-remote";
import { makeKeyPair, sshCommand, sshTools, startSshServer, type SshTools } from "../support/ssh-server";
import { connectPage, freePort, keyEvents, MOD, watchIpc, type Cdp, type IpcLog } from "./cdp";
import { appEnv, findInstalledApp, PROBE_TIMEOUT_MS, processRecords, startInstalledApp, WAIT_MS, waitExit, type AppEnv, type OwnedProcess } from "./installed-app";
import { withProbe } from "./probe-window";
import { close, ControlType, find, findWindow, focus, foregroundPid, foregroundSkip, inputDesktopSkip, invoke, MAX_CALL_MS, MAX_WAIT_MS, setValue, UiaError, type Element } from "./uia";

for (const helper of ["./cdp.ts", "./uia.ts", "./installed-app.ts", "./probe-window.ts", "../support/git-daemon.ts", "../support/http-remote.ts", "../support/ssh-server.ts"]) printOrigin(helper, import.meta.dir);
// The package under test holds these sources. The `ORIGIN` line of `findInstalledApp` names the installed binary and its SHA-256.
for (const source of ["../../src/frontend/app/Workbench.tsx", "../../src/frontend/state/requests.ts"]) printOrigin(source, import.meta.dir);

const TASK = "T079";
// Spec SC-013: 30 minutes and several focus returns; tasks.md T079: at least five.
const IDLE_MS = 30 * 60_000;
const RETURNS = 5;
const STEP_MS = MAX_WAIT_MS + MAX_CALL_MS;
const KEY_WAIT_MS = 10_000;
// An open and its reads, or the end of every IPC call in flight.
const ACTION_WAIT_MS = 30_000;
const GIT_WAIT_MS = 60_000;
// The bound of each server stop (tests/support).
const STOP_MS = 10_000;
// Key generation, the bare remote, and two clones with their configuration.
const SETUP_MS = 5 * 60_000;
const FOREGROUND_POLL_MS = 20;
// The start: 7 UIA steps and the CDP connect. The second open: the folder picker. Each focus return: 2 window finds, 2 foreground waits, 2 page waits.
const CASE_MS = IDLE_MS + SETUP_MS + (10 + RETURNS * 6) * STEP_MS + 3 * ACTION_WAIT_MS + 3 * GIT_WAIT_MS + 3 * STOP_MS + 2 * PROBE_TIMEOUT_MS + 2 * WAIT_MS;

const OPEN_FOLDER = "Open folder… (Ctrl+O)";
const REMOTES = ["daemon", "http", "ssh"] as const;
type RemoteName = (typeof REMOTES)[number];
const PROBE_TITLE = "T079 away";
// An owned WPF window off screen. It takes the foreground only on the UIA SetFocus of the case.
const PROBE = `
Add-Type -AssemblyName PresentationFramework
$w = New-Object Windows.Window
$w.Title = '${PROBE_TITLE}'
$w.ShowActivated = $false
$w.ShowInTaskbar = $false
$w.WindowStartupLocation = 'Manual'
$w.Left = -20000
$w.Top = -20000
$w.Width = 200
$w.Height = 100
$w.Show()
[Windows.Threading.Dispatcher]::Run()
`;

const js = (value: unknown) => JSON.stringify(value);

async function press(c: Cdp, name: string, modifiers = 0): Promise<void> {
  for (const params of keyEvents(name, modifiers, { typed: true })) await c.send("Input.dispatchKeyEvent", params);
  console.log(`KEY ${TASK}: ${name} mods=${modifiers}`);
}

async function until<T>(c: Cdp, what: string, expression: string, done: (value: T) => boolean, ms = KEY_WAIT_MS): Promise<T> {
  const value = await c.poll<T>(expression, done, ms);
  if (!done(value)) throw new Error(`${what} did not happen within ${ms} ms: ${js(value)}`);
  return value;
}

// Counts the trusted `focus` and `blur` events whose target is `window`. A script `dispatchEvent` has `isTrusted` false.
const FOCUS_COUNTER = `(() => {
  if (!window.__t079) {
    const n = { focus: 0, blur: 0 };
    window.__t079 = n;
    addEventListener('focus', (e) => { if (e.isTrusted && e.target === window) n.focus++; });
    addEventListener('blur', (e) => { if (e.isTrusted && e.target === window) n.blur++; });
  }
  return true;
})()`;
const FOCUS_COUNT = "window.__t079?.focus ?? -1";
const switcher = `document.querySelector('button[aria-keyshortcuts="Control+R"]')?.getAttribute('aria-label') ?? null`;

describe.skipIf(process.platform !== "win32")("T079 packaged no network without a user action", () => {
  // Bun 1.4.4 runs `afterAll` hooks in declaration order. This hook must come before the fixture root removal.
  const owned = new Set<OwnedProcess>();
  const sockets = new Set<Cdp>();
  const stopOwned = async () => {
    for (const c of sockets) c.close();
    sockets.clear();
    for (const app of owned) {
      owned.delete(app);
      app.stop();
      if ((await waitExit(app)) === null) throw new Error(`the app PID ${app.pid} did not exit within ${WAIT_MS} ms of the end`);
    }
  };
  afterEach(stopOwned, 2 * WAIT_MS + PROBE_TIMEOUT_MS);
  afterAll(async () => {
    await stopOwned();
    close();
  }, 2 * WAIT_MS + PROBE_TIMEOUT_MS);
  useFixtureRoot();

  const discovery = findInstalledApp();
  const installed = "app" in discovery ? discovery.app : null;
  if (installed !== null) console.log(`APP ${TASK}: exe=${installed.exe} sha256=${installed.sha256}`);
  const others = installed === null ? [] : processRecords().filter((r) => r.name.toLowerCase() === installed.mainBinaryName.toLowerCase());
  const TOOLS: SshTools | null = GIT === null ? null : sshTools(GIT);
  const reason =
    installed === null
      ? (discovery as { skip: string }).skip
      : GIT === null
        ? "Git executable absent"
        : others.length > 0
          ? `another-instance: ${installed.mainBinaryName} runs as PID ${others.map((r) => r.pid).join(", ")}`
          : process.env.ARBARETO_LIVE_INPUT !== "1"
            ? "live input needs the measurement account: set ARBARETO_LIVE_INPUT=1 (001 T165); the case takes the foreground and runs 30 minutes"
            : TOOLS === null
              ? "missing capability local-ssh-server"
              : inputDesktopSkip();
  if (reason !== null) console.log(`SKIP ${TASK}: ${reason}`);

  async function use<T>(element: Promise<Element>, body: (element: Element) => T): Promise<T> {
    const found = await element;
    try {
      return body(found);
    } finally {
      found.release();
    }
  }
  const uia = <T>(pid: number, name: string, type: number | undefined, body: (element: Element) => T) => use(find(pid, name, MAX_WAIT_MS, type), body);

  // Git answers through servers on this event loop, so the control Git runs asynchronously.
  async function runGit(args: string[], cwd: string, env: Record<string, string>): Promise<number> {
    const proc = Bun.spawn([GIT!, ...args], { cwd, env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return within(proc.exited, GIT_WAIT_MS, `git ${args.join(" ")}`).catch((error) => {
      proc.kill();
      throw error;
    });
  }

  // A clone of the bare remote by its plain path, so the build reaches no server. `main` tracks `daemon/main`, `http-main` tracks `http/main`, and `ssh-main` tracks `ssh/main`.
  function build(h: GitHost, bare: string, name: string, urls: Record<RemoteName, string>): string {
    const repo = `${h.root}/${name}`;
    gitRun(h, h.root, ["clone", "-q", "--", bare, repo]);
    for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"]] as const) gitRun(h, repo, ["config", key, value]);
    gitRun(h, repo, ["remote", "rename", "origin", "daemon"]);
    gitRun(h, repo, ["remote", "set-url", "daemon", urls.daemon]);
    for (const remote of ["http", "ssh"] as const) {
      gitRun(h, repo, ["remote", "add", remote, urls[remote]]);
      gitRun(h, repo, ["fetch", "-q", "--", bare, `+refs/heads/*:refs/remotes/${remote}/*`]);
      gitRun(h, repo, ["branch", "-q", "--track", `${remote}-main`, `refs/remotes/${remote}/main`]);
    }
    expect(gitOut(h, repo, ["for-each-ref", "--format=%(refname) %(upstream)", "refs/heads"]).trim().split("\n").toSorted()).toEqual(
      ["refs/heads/http-main refs/remotes/http/main", "refs/heads/main refs/remotes/daemon/main", "refs/heads/ssh-main refs/remotes/ssh/main"],
    );
    expect(Object.fromEntries(REMOTES.map((r) => [r, gitOut(h, repo, ["remote", "get-url", r]).trim()]))).toEqual(urls);
    return repo;
  }

  type Session = { app: OwnedProcess; c: Cdp; ipc: IpcLog; env: AppEnv };
  const top = (h: GitHost, repo: string) => gitOut(h, repo, ["rev-parse", "--show-toplevel"]).trim();
  const label = (h: GitHost, repo: string) => `${basename(top(h, repo))}, ${top(h, repo)}`;

  // The Windows folder picker: the Edit has the Name of its label, and its dialog window has the Name of the OK button.
  async function pickFolder(pid: number, repo: string): Promise<void> {
    const path = resolve(repo);
    if (!isAbsolute(path) || relative(FIXTURE_ROOT, path).startsWith("..")) throw new Error(`the repository is outside the fixture root: ${js(path)}`);
    await uia(pid, "Folder:", ControlType.Edit, (field) => setValue(field, path));
    await uia(pid, "Select Folder", ControlType.Button, invoke);
  }

  async function session(h: GitHost, repo: string): Promise<Session> {
    const env = appEnv(fixtureDir(`${TASK}-app`), false);
    const port = freePort();
    env.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port}`;
    const app = startInstalledApp(installed!, env);
    owned.add(app);
    console.log(`STARTED ${TASK}: ${app.pid} port=${port} profile=${env.set.ARBARETO_PROFILE_ROOT}`);
    // A new profile holds no Git selection, so the boot view offers Select Git (uia.test.ts T241).
    await uia(app.pid, "Select Git", ControlType.Button, invoke);
    const c = await connectPage(port, MAX_WAIT_MS);
    sockets.add(c);
    const ipc = await watchIpc(c);
    await c.evaluate(FOCUS_COUNTER);
    await uia(app.pid, "Use this Git", undefined, invoke);
    await uia(app.pid, OPEN_FOLDER, undefined, invoke);
    const expected = label(h, repo);
    await pickFolder(app.pid, repo);
    await until<string | null>(c, `the open ${repo}`, switcher, (v) => v === expected, ACTION_WAIT_MS);
    return { app, c, ipc, env };
  }

  // The keyboard handler takes Ctrl+O only outside an editable element (src/frontend/keyboard/shortcuts.ts).
  async function openFolder(h: GitHost, s: Session, repo: string): Promise<void> {
    const expected = label(h, repo);
    await s.c.evaluate(`(document.activeElement?.blur?.(), true)`);
    await press(s.c, "o", MOD.Ctrl);
    await pickFolder(s.app.pid, repo);
    await until<string | null>(s.c, `the open ${repo}`, switcher, (v) => v === expected, ACTION_WAIT_MS);
  }

  async function foregroundTo(pid: number): Promise<boolean> {
    for (const end = performance.now() + MAX_WAIT_MS; ; await Bun.sleep(FOREGROUND_POLL_MS)) {
      if (foregroundPid() === pid) return true;
      if (performance.now() >= end) return false;
    }
  }

  // UIA SetFocus on the top-level window `title` of `pid`. Returns null when `pid` then owns the foreground window, else the SKIP facts.
  // Microsoft Learn `SetForegroundWindow`: the system can refuse the foreground change, for example after recent user input.
  async function activate(pid: number, title: string): Promise<string | null> {
    const win = await findWindow(pid, title, MAX_WAIT_MS);
    try {
      focus(win);
    } catch (error) {
      if (!(error instanceof UiaError)) throw error;
      console.log(`UIA ${TASK}: SetFocus on ${js(title)} failed: ${error.message}`);
    } finally {
      win.release();
    }
    return (await foregroundTo(pid)) ? null : (foregroundSkip(pid) ?? `missing capability foreground: ${js(title)} lost the foreground`);
  }

  // One focus return: the owned window takes the foreground, then the app window takes it back and the page gets a trusted `focus` event.
  async function focusReturn(s: Session, probePid: number, appTitle: string): Promise<string | null> {
    const away = await activate(probePid, PROBE_TITLE);
    if (away !== null) return away;
    await until<boolean>(s.c, "the page without focus", "document.hasFocus()", (v) => v === false);
    const before = await s.c.evaluate<number>(FOCUS_COUNT);
    const back = await activate(s.app.pid, appTitle);
    if (back !== null) return back;
    await until<number>(s.c, "a trusted window focus event", FOCUS_COUNT, (v) => v > before);
    expect(await s.c.evaluate<boolean>("document.hasFocus()")).toBe(true);
    return null;
  }

  // Waits until every IPC call that the page sent has its reply.
  async function ipcIdle(s: Session): Promise<void> {
    const open = () => [...new Set(s.ipc.calls().map((call) => call.command))].flatMap((command) => s.ipc.pending(command));
    for (const end = performance.now() + ACTION_WAIT_MS; open().length > 0; await Bun.sleep(50)) {
      if (performance.now() >= end) throw new Error(`IPC calls still run after ${ACTION_WAIT_MS} ms: ${js(open())}`);
    }
  }

  test.skipIf(reason !== null)(
    "SC-013, FR-041: two repositories with remotes on git daemon, HTTP, and SSH open, 30 minutes pass with five focus returns, and the access-hook, request, and connection counters stay at 0; Git with the app environment then raises each counter",
    async () => {
      const git = GIT!;
      const tools = TOOLS!;
      const h = nativeHost(git, "t079");
      const served = `${h.root}/served`;
      mkdirSync(served, { recursive: true });
      const bare = buildCredentialRemote(h, served);
      const hostKey = makeKeyPair(tools, `${h.root}/host_ed25519`);
      const clientKey = makeKeyPair(tools, `${h.root}/client_ed25519`);
      const serverEnv = nativeEnv();
      const servers: { stop(): Promise<void>; ended(): boolean }[] = [];
      try {
        const daemon = await startGitDaemon({ git: fixtureGitPath(git), basePath: served, hookFile: `${h.root}/daemon-hook.sh`, counterFile: `${h.root}/daemon-count.txt`, env: serverEnv });
        servers.push(daemon);
        const http = startHttpRemote({ git: fixtureGitPath(git), projectRoot: served, user: HTTP_USER, password: HTTP_PASSWORD, env: serverEnv });
        servers.push(http);
        const ssh = await startSshServer({ git, root: served, hostKey: hostKey.privateKey, clientKey: clientKey.publicKey, env: serverEnv });
        servers.push(ssh);
        console.log(`SERVERS ${TASK}: daemon pid=${daemon.pid} port=${daemon.port}; http port=${http.port}; ssh port=${ssh.port}`);
        const counts = () => ({ daemon: daemon.accessCount(), http: http.requests(), ssh: ssh.connections() });
        const urls: Record<RemoteName, string> = { daemon: `${daemon.url}/cred.git`, http: `${http.url}/cred.git`, ssh: ssh.url("cred.git") };
        const repos = [build(h, bare, "repo-a", urls), build(h, bare, "repo-b", urls)];
        expect(counts()).toEqual({ daemon: 0, http: 0, ssh: 0 });

        const s = await session(h, repos[0]!);
        await openFolder(h, s, repos[1]!);
        const appTitle = await s.c.evaluate<string>("document.title");
        const run: { skip: string | null; returns: number } = { skip: null, returns: 0 };
        await withProbe(PROBE, async (probe) => {
          const start = performance.now();
          for (let k = 1; k <= RETURNS && run.skip === null; k++) {
            const at = start + (k * IDLE_MS) / RETURNS;
            for (let left = at - performance.now(); left > 0; left = at - performance.now()) await Bun.sleep(Math.min(60_000, left));
            run.skip = await focusReturn(s, probe.pid, appTitle);
            if (run.skip === null) run.returns = k;
            console.log(`RETURN ${TASK}: ${k} at ${((performance.now() - start) / 60_000).toFixed(1)} min ${run.skip === null ? "done" : "skipped"} counts=${js(counts())}`);
          }
        });
        const { skip, returns } = run;
        if (skip !== null) {
          console.log(`SKIP ${TASK} focus return ${returns + 1}: ${skip}`);
          console.log(`OBSERVATION ${TASK}: SC-013 unverified; counts=${js(counts())}`);
          return;
        }
        await ipcIdle(s);
        const trusted = await s.c.evaluate<number>(FOCUS_COUNT);
        const after = counts();
        console.log(`OBSERVATION ${TASK}: focus returns ${returns}, trusted window focus events ${trusted}, counts ${js(after)}`);
        expect(trusted).toBeGreaterThanOrEqual(RETURNS);
        expect(after).toEqual({ daemon: 0, http: 0, ssh: 0 });

        // Control: the same remote names and the app environment reach each counter.
        const knownHosts = `${h.root}/known_hosts`;
        writeFileSync(knownHosts, ssh.knownHostsLine());
        const sshConfig = `${h.root}/ssh_config`;
        writeFileSync(sshConfig, "");
        const env = { ...s.env.env, GIT_TERMINAL_PROMPT: "0" };
        const helper = ["-c", `credential.helper=${credentialHelper(HTTP_USER, HTTP_PASSWORD)}`];
        const repo = repos[0]!;
        const exits = {
          daemon: await runGit(["ls-remote", "--heads", "daemon"], repo, env),
          http: await runGit([...helper, "ls-remote", "--heads", "http"], repo, env),
          ssh: await runGit(["ls-remote", "--heads", "ssh"], repo, { ...env, GIT_SSH_COMMAND: sshCommand(tools, { key: clientKey.privateKey, knownHosts, config: sshConfig }) }),
        };
        const control = counts();
        console.log(`CONTROL ${TASK}: exits ${js(exits)} counts ${js(control)}`);
        expect({ exits, daemon: control.daemon, http: control.http > 0, ssh: control.ssh }).toEqual({ exits: { daemon: 0, http: 0, ssh: 0 }, daemon: 1, http: true, ssh: 1 });
      } finally {
        const errors: unknown[] = [];
        for (const server of servers.toReversed()) await server.stop().catch((error) => void errors.push(error));
        if (errors.length > 0) throw new AggregateError(errors, "a local server did not stop");
        expect(servers.map((server) => server.ended())).toEqual(servers.map(() => true));
      }
    },
    CASE_MS,
  );
});
