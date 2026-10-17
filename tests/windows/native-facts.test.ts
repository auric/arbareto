// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T005: the native facts N1 to N6 of research.md R21. A fact prints `OBSERVATION T005:` lines. A `match=false` line is a finding for research.md "Results", not a failure.
// The file is also its own probe process. `ARBARETO_NATIVE_PROBE` selects the probe mode. A probe loads no fixture helper, so it starts no Git and prints no ORIGIN line.
// No case sends keyboard or pointer input. A fact that needs input prints `OBSERVATION T005: unverified <Nn>` with its capability.

import { afterAll, describe, expect, test } from "bun:test";
import { CFunction, dlopen, FFIType, ptr, read, type Pointer } from "bun:ffi";
import { readdirSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { processCreationTime, terminateRecorded } from "../git/win32";
import { close, find, focus, foregroundPid, foregroundSkip, inputDesktopSkip, invoke, MAX_WAIT_MS, UiaError, waitFocus, type Element } from "./uia";

const PROBE_VARIABLE = "ARBARETO_NATIVE_PROBE";

const { ptr: P, u32, i32, u64 } = FFIType;
const open = () => ({
  kernel32: dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [P, P], returns: P },
    SetInformationJobObject: { args: [P, i32, P, u32], returns: i32 },
    QueryInformationJobObject: { args: [P, i32, P, u32, P], returns: i32 },
    CreateFileW: { args: [P, u32, u32, P, u32, u32, P], returns: P },
    InitializeProcThreadAttributeList: { args: [P, u32, u32, P], returns: i32 },
    UpdateProcThreadAttribute: { args: [P, u32, u64, P, u64, P, P], returns: i32 },
    DeleteProcThreadAttributeList: { args: [P], returns: FFIType.void },
    CreateProcessW: { args: [P, P, P, P, i32, u32, P, P, P, P], returns: i32 },
    ResumeThread: { args: [P], returns: u32 },
    GetExitCodeProcess: { args: [P, P], returns: i32 },
    CloseHandle: { args: [P], returns: i32 },
    GetLastError: { args: [], returns: u32 },
    GetCurrentThreadId: { args: [], returns: u32 },
    GetTickCount: { args: [], returns: u32 },
    CreateActCtxW: { args: [P], returns: P },
    ActivateActCtx: { args: [P, P], returns: i32 },
    LoadLibraryW: { args: [P], returns: P },
    GetProcAddress: { args: [P, P], returns: P },
  }).symbols,
  user32: dlopen("user32.dll", {
    CreateWindowExW: { args: [u32, P, P, u32, i32, i32, i32, i32, P, P, P, P], returns: P },
    ShowWindow: { args: [P, i32], returns: i32 },
    GetMessageW: { args: [P, P, u32, u32], returns: i32 },
    PeekMessageW: { args: [P, P, u32, u32, u32], returns: i32 },
    TranslateMessage: { args: [P], returns: i32 },
    DispatchMessageW: { args: [P], returns: P },
    GetForegroundWindow: { args: [], returns: P },
    GetWindowThreadProcessId: { args: [P, P], returns: u32 },
    AllowSetForegroundWindow: { args: [u32], returns: i32 },
    GetGUIThreadInfo: { args: [u32, P], returns: i32 },
    GetWindowTextW: { args: [P, P, i32], returns: i32 },
    GetClassNameW: { args: [P, P, i32], returns: i32 },
    FindWindowExW: { args: [P, P, P, P], returns: P },
    SendMessageW: { args: [P, u32, P, P], returns: P },
    GetLastInputInfo: { args: [P], returns: i32 },
    SystemParametersInfoW: { args: [u32, u32, P, u32], returns: i32 },
  }).symbols,
  ole32: dlopen("ole32.dll", { CoInitializeEx: { args: [P, u32], returns: i32 } }).symbols,
  shell32: dlopen("shell32.dll", {
    ILCreateFromPathW: { args: [P], returns: P },
    SHOpenFolderAndSelectItems: { args: [P, u32, P, u32], returns: i32 },
    ILFree: { args: [P], returns: FFIType.void },
  }).symbols,
});
let dlls: ReturnType<typeof open> | undefined;

// The DLLs exist only on Windows, so the import of this file must not open them.
function win(): ReturnType<typeof open> {
  if (process.platform !== "win32") throw new Error("the native facts need Windows");
  return (dlls ??= open());
}

// `INVALID_HANDLE_VALUE` comes back as a bigint, and a null handle as null.
const valid = (handle: unknown): handle is Pointer => typeof handle === "number" && handle !== 0;
const wide = (text: string) => new Uint8Array(Buffer.from(`${text}\0`, "utf16le"));
// A structure field holds a raw address that the garbage collector cannot see, so each such buffer stays reachable here.
const PINNED: Uint8Array[] = [];
const pinned = (bytes: Uint8Array) => {
  PINNED.push(bytes);
  return ptr(bytes);
};
const address = (bytes: Uint8Array) => BigInt(pinned(bytes));
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const slash = (path: string) => path.replaceAll("\\", "/");

function fail(call: string): never {
  throw new Error(`${call} failed: ${win().kernel32.GetLastError()}`);
}

// ---- The trust task dialog of plan.md D14 ----

const TITLE = "Arbareto";
const MAIN = "Do you trust this repository?";
const CONTENT = "This repository has its own programs. Git runs them when you commit. Trust it only if you know where it comes from.";
const DETAILS = "Folder: C:\\Repos\\sample\nHooks in C:\\Repos\\sample\\.git\\hooks: pre-commit, commit-msg\nFilters: lfs (global)";
const COLLAPSED = "Show details";
const EXPANDED = "Hide details";
const TRUST = "Trust";
const NOT_NOW = "Not now";
// plan.md D14: Trust is ID 100, and Not now is `IDCANCEL`.
const TRUST_ID = 100;
const IDCANCEL = 2;

// Windows SDK `CommCtrl.h`: TASKDIALOGCONFIG and TASKDIALOG_BUTTON are in a `pshpack1.h` block, so the x64 fields have no padding.
const CONFIG_BYTES = 160;
const BUTTON_BYTES = 12;
const CONFIG = { cbSize: 0, dwFlags: 20, pszWindowTitle: 28, pszMainInstruction: 44, pszContent: 52, cButtons: 60, pButtons: 64, nDefaultButton: 72, pszExpandedInformation: 100, pszExpandedControlText: 108, pszCollapsedControlText: 116 } as const;
const TDF_ALLOW_DIALOG_CANCELLATION = 0x8;
// TaskDialogIndirect exists only in Common Controls 6, so the probe activates that assembly first.
const MANIFEST = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/></dependentAssembly></dependency>
</assembly>
`;
// x64 ACTCTXW: `cbSize` at 0, `lpSource` at 8.
const ACTCTX_BYTES = 56;

// ---- Process and Job constants (Microsoft Learn) ----

// The shell Job of src-tauri/src/jobs.rs: kill-on-close, no breakaway. x64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION holds `LimitFlags` at byte 16.
const JOB_EXTENDED_LIMIT_CLASS = 9;
const JOB_EXTENDED_LIMIT_BYTES = 144;
const JOB_LIMIT_FLAGS_OFFSET = 16;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
// JOBOBJECT_BASIC_PROCESS_ID_LIST: two DWORD counts, then ULONG_PTR process IDs from byte 8.
const JOB_PID_LIST_CLASS = 3;
const JOB_PID_CAPACITY = 256;
// src-tauri/src/spawn.rs `creation_flags(false)` and `create_suspended`.
const CREATE_SUSPENDED = 0x4;
const DETACHED_PROCESS = 0x8;
const CREATE_UNICODE_ENVIRONMENT = 0x400;
const EXTENDED_STARTUPINFO_PRESENT = 0x8_0000;
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x2_0002n;
const PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x2_000dn;
// x64 STARTUPINFOEXW: `dwFlags` at 60, the three standard handles at 80, 88, and 96, `lpAttributeList` at 104.
const STARTUPINFOEX_BYTES = 112;
const STARTF_USESTDHANDLES = 0x100;
const PROCESS_INFORMATION_BYTES = 24;
const GENERIC_READ_WRITE = 0xc000_0000;
const FILE_SHARE_READ_WRITE = 0x3;
const OPEN_EXISTING = 3;
// x64 SECURITY_ATTRIBUTES: `nLength` at 0, `bInheritHandle` at 16.
const SECURITY_ATTRIBUTES_BYTES = 24;
const STILL_ACTIVE = 259;

// ---- Window constants (Microsoft Learn) ----

const WS_OVERLAPPEDWINDOW = 0x00cf_0000;
const WS_CHILD = 0x4000_0000;
const WS_VISIBLE = 0x1000_0000;
const WS_TABSTOP = 0x0001_0000;
const SW_SHOWNORMAL = 1;
const SW_SHOWNOACTIVATE = 4;
const PM_REMOVE = 1;
const MSG_BYTES = 48;
const ASFW_ANY = 0xffff_ffff;
// x64 GUITHREADINFO: `cbSize` at 0, `hwndFocus` at 16.
const GUITHREADINFO_BYTES = 72;
const GUITHREADINFO_FOCUS = 16;
const TEXT_UNITS = 256;
const COINIT_APARTMENTTHREADED = 0x2;
const COINIT_DISABLE_OLE1DDE = 0x4;
// The windows stay off screen, so the desktop stays usable during the run.
const OFF_SCREEN = -20_000;
const PUMP_MS = 5;

const SHELL_TITLE = "Native facts probe shell";
const SHELL_BUTTON = "Probe shell button";
const TOOL_TITLE = "Native facts merge tool";

// ---- Probe side ----

const reply = (value: unknown) => writeSync(1, `PROBE ${JSON.stringify(value)}\n`);

function pump(): void {
  const { user32 } = win();
  const message = new Uint8Array(MSG_BYTES);
  while (user32.PeekMessageW(ptr(message), null, 0, 0, PM_REMOVE)) {
    user32.TranslateMessage(ptr(message));
    user32.DispatchMessageW(ptr(message));
  }
}

function createWindow(className: string, title: string, style: number, parent: Pointer | null, id: number): Pointer {
  const handle = win().user32.CreateWindowExW(0, ptr(wide(className)), ptr(wide(title)), style, parent === null ? OFF_SCREEN : 10, parent === null ? OFF_SCREEN : 10, 400, 120, parent, id === 0 ? null : (id as Pointer), null, null);
  if (!valid(handle)) fail("CreateWindowExW");
  return handle;
}

// The dialog of plan.md D14 without an owner window. It replies with its thread, then with the TaskDialogIndirect result.
function dialogProbe(manifest: string): never {
  const { kernel32 } = win();
  const source = wide(manifest);
  const context = new Uint8Array(ACTCTX_BYTES);
  view(context).setUint32(0, ACTCTX_BYTES, true);
  view(context).setBigUint64(8, address(source), true);
  const activation = kernel32.CreateActCtxW(ptr(context));
  if (!valid(activation)) fail("CreateActCtxW");
  const cookie = new BigUint64Array(1);
  if (!kernel32.ActivateActCtx(activation, ptr(cookie))) fail("ActivateActCtx");
  const comctl = kernel32.LoadLibraryW(ptr(wide("comctl32.dll")));
  if (!valid(comctl)) fail("LoadLibraryW");
  const entry = kernel32.GetProcAddress(comctl, ptr(new Uint8Array(Buffer.from("TaskDialogIndirect\0", "latin1"))));
  if (!valid(entry)) fail("GetProcAddress");
  const taskDialogIndirect = CFunction({ ptr: entry, args: [P, P, P, P], returns: i32 });
  const [title, main, content, details, expanded, collapsed, trust, notNow] = [TITLE, MAIN, CONTENT, DETAILS, EXPANDED, COLLAPSED, TRUST, NOT_NOW].map(wide);
  const buttons = new Uint8Array(2 * BUTTON_BYTES);
  view(buttons).setInt32(0, TRUST_ID, true);
  view(buttons).setBigUint64(4, address(trust!), true);
  view(buttons).setInt32(BUTTON_BYTES, IDCANCEL, true);
  view(buttons).setBigUint64(BUTTON_BYTES + 4, address(notNow!), true);
  const config = new Uint8Array(CONFIG_BYTES);
  const c = view(config);
  c.setUint32(CONFIG.cbSize, CONFIG_BYTES, true);
  c.setUint32(CONFIG.dwFlags, TDF_ALLOW_DIALOG_CANCELLATION, true);
  c.setBigUint64(CONFIG.pszWindowTitle, address(title!), true);
  c.setBigUint64(CONFIG.pszMainInstruction, address(main!), true);
  c.setBigUint64(CONFIG.pszContent, address(content!), true);
  c.setUint32(CONFIG.cButtons, 2, true);
  c.setBigUint64(CONFIG.pButtons, address(buttons), true);
  c.setInt32(CONFIG.nDefaultButton, IDCANCEL, true);
  c.setBigUint64(CONFIG.pszExpandedInformation, address(details!), true);
  c.setBigUint64(CONFIG.pszExpandedControlText, address(expanded!), true);
  c.setBigUint64(CONFIG.pszCollapsedControlText, address(collapsed!), true);
  reply({ thread: kernel32.GetCurrentThreadId() });
  const pressed = new Int32Array(1);
  const hr = taskDialogIndirect(ptr(config), ptr(pressed), null, null);
  reply({ hr, button: pressed[0] });
  process.exit(0);
}

// One inheritable NUL handle serves as all three standard handles. NUL reads give end of file, so Git gets an empty standard input (plan.md D14).
function startInJob(job: Pointer, program: string, args: readonly string[], cwd: string): { process: Pointer; pid: number } {
  const { kernel32 } = win();
  for (const arg of args) if (!/^[^\s"\\]+$/.test(arg)) throw new Error(`the probe command line takes no quoting: ${arg}`);
  const security = new Uint8Array(SECURITY_ATTRIBUTES_BYTES);
  view(security).setUint32(0, SECURITY_ATTRIBUTES_BYTES, true);
  view(security).setUint32(16, 1, true);
  const nul = kernel32.CreateFileW(ptr(wide("NUL")), GENERIC_READ_WRITE, FILE_SHARE_READ_WRITE, ptr(security), OPEN_EXISTING, 0, null);
  if (!valid(nul)) fail("CreateFileW NUL");
  const size = new BigUint64Array(1);
  // A size query without a list fails with ERROR_INSUFFICIENT_BUFFER and sets `size`.
  kernel32.InitializeProcThreadAttributeList(null, 2, 0, ptr(size));
  const list = new Uint8Array(Number(size[0]));
  if (!kernel32.InitializeProcThreadAttributeList(ptr(list), 2, 0, ptr(size))) fail("InitializeProcThreadAttributeList");
  try {
    // Microsoft Learn `UpdateProcThreadAttribute`: each value must persist until the list is deleted.
    const handles = new Uint8Array(new BigUint64Array([BigInt(nul)]).buffer);
    const jobs = new Uint8Array(new BigUint64Array([BigInt(job)]).buffer);
    if (!kernel32.UpdateProcThreadAttribute(ptr(list), 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, pinned(handles), 8n, null, null)) fail("UpdateProcThreadAttribute HANDLE_LIST");
    if (!kernel32.UpdateProcThreadAttribute(ptr(list), 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, pinned(jobs), 8n, null, null)) fail("UpdateProcThreadAttribute JOB_LIST");
    const startup = new Uint8Array(STARTUPINFOEX_BYTES);
    const s = view(startup);
    s.setUint32(0, STARTUPINFOEX_BYTES, true);
    s.setUint32(60, STARTF_USESTDHANDLES, true);
    for (const at of [80, 88, 96]) s.setBigUint64(at, BigInt(nul), true);
    s.setBigUint64(104, address(list), true);
    const info = new Uint8Array(PROCESS_INFORMATION_BYTES);
    const application = wide(program);
    const line = wide([`"${program}"`, ...args].join(" "));
    const directory = wide(cwd);
    const flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | DETACHED_PROCESS;
    if (!kernel32.CreateProcessW(ptr(application), ptr(line), null, null, 1, flags, null, ptr(directory), ptr(startup), ptr(info))) fail("CreateProcessW");
    const process = Number(view(info).getBigUint64(0, true)) as Pointer;
    const thread = Number(view(info).getBigUint64(8, true)) as Pointer;
    const resumed = kernel32.ResumeThread(thread);
    kernel32.CloseHandle(thread);
    if (resumed === 0xffff_ffff) fail("ResumeThread");
    return { process, pid: view(info).getUint32(16, true) };
  } finally {
    kernel32.DeleteProcThreadAttributeList(ptr(list));
    kernel32.CloseHandle(nul);
  }
}

function jobPids(job: Pointer): number[] {
  const list = new Uint8Array(8 + 8 * JOB_PID_CAPACITY);
  if (!win().kernel32.QueryInformationJobObject(job, JOB_PID_LIST_CLASS, ptr(list), list.byteLength, null)) fail("QueryInformationJobObject");
  const assigned = view(list).getUint32(0, true);
  const listed = view(list).getUint32(4, true);
  if (assigned !== listed) throw new Error(`the Job lists ${listed} of ${assigned} processes`);
  return Array.from({ length: listed }, (_, i) => Number(view(list).getBigUint64(8 + 8 * i, true)));
}

interface StartCommand {
  cmd: "start";
  allow: boolean;
  git: string;
  cwd: string;
  args: string[];
}
type ShellCommand = StartCommand | { cmd: "pids" } | { cmd: "cancel" };

// The service-started process of plan.md D14: one window that can hold the foreground, and Git in a new operation Job.
async function shellProbe(): Promise<never> {
  const { kernel32, user32 } = win();
  const top = createWindow("STATIC", SHELL_TITLE, WS_OVERLAPPEDWINDOW, null, 0);
  createWindow("BUTTON", SHELL_BUTTON, WS_CHILD | WS_VISIBLE | WS_TABSTOP, top, 1);
  user32.ShowWindow(top, SW_SHOWNOACTIVATE);
  setInterval(pump, PUMP_MS);
  reply({ hwnd: Number(top) });
  let run: { job: Pointer; process: Pointer; pid: number } | null = null;
  for await (const line of console) {
    const command = JSON.parse(line) as ShellCommand;
    if (command.cmd === "start") {
      if (run !== null) throw new Error("a run is open");
      const allowed = command.allow ? user32.AllowSetForegroundWindow(ASFW_ANY) !== 0 : null;
      const foreground = user32.GetForegroundWindow() === top;
      const job = kernel32.CreateJobObjectW(null, null);
      if (!valid(job)) fail("CreateJobObjectW");
      const limits = new Uint8Array(JOB_EXTENDED_LIMIT_BYTES);
      view(limits).setUint32(JOB_LIMIT_FLAGS_OFFSET, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
      if (!kernel32.SetInformationJobObject(job, JOB_EXTENDED_LIMIT_CLASS, ptr(limits), JOB_EXTENDED_LIMIT_BYTES)) fail("SetInformationJobObject");
      run = { job, ...startInJob(job, command.git, command.args, command.cwd) };
      reply({ pid: run.pid, foreground, allowed });
    } else if (command.cmd === "pids") {
      if (run === null) throw new Error("no run is open");
      const code = new Uint32Array(1);
      if (!kernel32.GetExitCodeProcess(run.process, ptr(code))) fail("GetExitCodeProcess");
      // The creation time at the Job query binds each PID to its process. A PID that Windows reuses later gets a newer time.
      const members = jobPids(run.job).map((pid) => ({ pid, created: processCreationTime(pid)?.toString() ?? null }));
      reply({ members, gitRunning: code[0] === STILL_ACTIVE, gitExit: code[0] });
    } else {
      // The close of the last Job handle ends every process in the Job (kill-on-close), as the shell Cancel does.
      if (run !== null) {
        kernel32.CloseHandle(run.job);
        kernel32.CloseHandle(run.process);
      }
      run = null;
      reply({ closed: true });
    }
  }
  process.exit(0);
}

// The fixture merge tool. It shows one window, records whether that window is the foreground window right after `ShowWindow`, and waits.
function toolProbe(readyDir: string): never {
  const { user32 } = win();
  try {
    const hwnd = createWindow("STATIC", TOOL_TITLE, WS_OVERLAPPEDWINDOW, null, 0);
    user32.ShowWindow(hwnd, SW_SHOWNORMAL);
    const foreground = user32.GetForegroundWindow() === hwnd;
    const file = join(readyDir, `${process.pid}`);
    writeFileSync(`${file}.tmp`, JSON.stringify({ pid: process.pid, hwnd: Number(hwnd), foreground }));
    renameSync(`${file}.tmp`, file);
    const message = new Uint8Array(MSG_BYTES);
    while (user32.GetMessageW(ptr(message), null, 0, 0) > 0) {
      user32.TranslateMessage(ptr(message));
      user32.DispatchMessageW(ptr(message));
    }
  } catch (error) {
    writeFileSync(join(readyDir, `${process.pid}.error`), String(error));
  }
  process.exit(0);
}

// plan.md D14 `revealPath`. The probe uses an STA thread, as the shell pickers do (src-tauri/src/dialogs.rs).
async function revealProbe(path: string): Promise<never> {
  const { ole32, shell32 } = win();
  const init = ole32.CoInitializeEx(null, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
  const pidl = shell32.ILCreateFromPathW(ptr(wide(path)));
  if (!valid(pidl)) fail("ILCreateFromPathW");
  const hr = shell32.SHOpenFolderAndSelectItems(pidl, 0, null, 0);
  shell32.ILFree(pidl);
  setInterval(pump, PUMP_MS);
  reply({ init, hr });
  // The probe stays until the test ends it, so the shell can still call into this apartment.
  for await (const _ of console);
  process.exit(0);
}

const PROBE = process.env[PROBE_VARIABLE];
if (PROBE === "dialog") dialogProbe(process.argv[2]!);
else if (PROBE === "shell") await shellProbe();
else if (PROBE === "tool") toolProbe(process.argv[2]!);
else if (PROBE === "reveal") await revealProbe(process.argv[2]!);
else if (PROBE !== undefined) throw new Error(`unknown probe mode ${PROBE}`);

// ---- Test side ----

const { printOrigin } = await import("../origin");
const { GIT } = await import("../git/git-binary");
const { fixtureDir, fixtureEnv, useFixtureRoot } = await import("../git/fixture-root");
const { buildWorkbench, repoOf, wb } = await import("../git/workbench-fixtures");
const { obs, observationLine } = await import("../git/fact-runner");
const { appEnv, findInstalledApp, processRecords, startInstalledApp, WAIT_MS, waitExit } = await import("./installed-app");

for (const helper of ["./uia.ts", "./installed-app.ts", "../git/win32.ts", "../git/workbench-fixtures.ts"]) printOrigin(helper, import.meta.dir);

const TASK = "T005";
const TEST_TIMEOUT_MS = 120_000;
const TOOL_READY_MS = 60_000;
const POLL_MS = 20;
const OS = release();

const observe = (fact: string, expected: unknown, observed: unknown, match?: boolean) => console.log(observationLine(TASK, obs(fact, expected, observed, match), `os=${OS}`));
const unverified = (fact: string, reason: string) => console.log(`OBSERVATION ${TASK}: unverified ${fact}: ${reason}`);

async function use<T>(element: Promise<Element>, body: (element: Element) => T | Promise<T>): Promise<T> {
  const found = await element;
  try {
    return await body(found);
  } finally {
    found.release();
  }
}

// A UIA search result. A timeout of 0 reads the tree once.
async function present(pid: number, name: string, timeoutMs: number): Promise<boolean> {
  try {
    (await find(pid, name, timeoutMs)).release();
    return true;
  } catch (error) {
    if (error instanceof UiaError && error.code === "TIMEOUT") return false;
    throw error;
  }
}

const uiaCode = async (body: () => unknown) => {
  try {
    await body();
    return "ok";
  } catch (error) {
    if (error instanceof UiaError) return error.code;
    throw error;
  }
};

function lineReader(stream: ReadableStream<Uint8Array>): (deadline: number) => Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let pending: ReturnType<typeof reader.read> | null = null;
  return async (deadline) => {
    for (;;) {
      const end = buffered.indexOf("\n");
      if (end >= 0) {
        const line = buffered.slice(0, end).replace(/\r$/, "");
        buffered = buffered.slice(end + 1);
        return line;
      }
      const left = deadline - performance.now();
      if (left <= 0) throw new Error("no probe reply in time");
      pending ??= reader.read();
      const result = await Promise.race([pending, Bun.sleep(left).then(() => null)]);
      if (result === null) continue;
      pending = null;
      if (result.done) throw new Error("the probe closed its output");
      buffered += decoder.decode(result.value, { stream: true });
    }
  };
}

interface Probe {
  pid: number;
  reply<T>(timeoutMs: number): Promise<T>;
  send(command: ShellCommand): void;
  stop(): Promise<void>;
}

function spawnProbe(mode: string, args: string[], env: Record<string, string | undefined>): Probe {
  const child = Bun.spawn([process.execPath, import.meta.path, ...args], { env: { ...env, [PROBE_VARIABLE]: mode }, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const next = lineReader(child.stdout);
  return {
    pid: child.pid,
    async reply<T>(timeoutMs: number) {
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        const line = await next(deadline);
        if (line.startsWith("PROBE ")) return JSON.parse(line.slice("PROBE ".length)) as T;
      }
    },
    send(command) {
      child.stdin.write(`${JSON.stringify(command)}\n`);
      child.stdin.flush();
    },
    async stop() {
      child.kill();
      await child.exited;
    },
  };
}

// Microsoft Learn `SetForegroundWindow`: the foreground lock ends when no input came for the lock time-out. x64 LASTINPUTINFO is `cbSize` and `dwTime`.
const SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000;
function foregroundLock(): { idleMs: number; lockTimeoutMs: number } {
  const { kernel32, user32 } = win();
  const input = new Uint32Array([8, 0]);
  if (!user32.GetLastInputInfo(ptr(input))) fail("GetLastInputInfo");
  const timeout = new Uint32Array(1);
  if (!user32.SystemParametersInfoW(SPI_GETFOREGROUNDLOCKTIMEOUT, 0, ptr(timeout), 0)) fail("SystemParametersInfoW");
  // Both tick values wrap at 2^32 ms.
  return { idleMs: (kernel32.GetTickCount() - input[1]!) >>> 0, lockTimeoutMs: timeout[0]! };
}

// The window that has the keyboard focus of `thread`. It needs no foreground and no input.
function threadFocus(thread: number): Pointer | null {
  const info = new Uint8Array(GUITHREADINFO_BYTES);
  view(info).setUint32(0, GUITHREADINFO_BYTES, true);
  if (!win().user32.GetGUIThreadInfo(thread, ptr(info))) return null;
  const focused = Number(view(info).getBigUint64(GUITHREADINFO_FOCUS, true));
  return focused === 0 ? null : (focused as Pointer);
}

function windowString(call: "GetWindowTextW" | "GetClassNameW", hwnd: Pointer): string {
  const text = new Uint16Array(TEXT_UNITS);
  const length = win().user32[call](hwnd, ptr(text), TEXT_UNITS);
  return Buffer.from(text.buffer, 0, length * 2).toString("utf16le");
}

// The Folder box of the Windows folder picker of process `pid`. The picker gives the focus of its thread to that box when it opens (capture.test.ts waits for it).
function folderBox(pid: number): Pointer {
  const { user32 } = win();
  const owner = new Uint32Array(1);
  for (let hwnd = user32.FindWindowExW(null, null, null, null); valid(hwnd); hwnd = user32.FindWindowExW(null, hwnd, null, null)) {
    const thread = user32.GetWindowThreadProcessId(hwnd, ptr(owner));
    if (owner[0] !== pid || windowString("GetClassNameW", hwnd) !== "#32770") continue;
    const focused = threadFocus(thread);
    if (focused !== null && windowString("GetClassNameW", focused) === "Edit") return focused;
  }
  throw new Error(`process ${pid} has no folder picker with a focused Edit box`);
}
const WM_SETTEXT = 0x000c;

// Windows SDK 10.0.19041.0 `UIAutomationClient.h`: IUIAutomationElement3 and the C vtable slot of ShowContextMenu.
const IID_IUIAutomationElement3 = "8471df34-aee0-4a01-a7de-7db9af12c296";
const SLOT_QUERY_INTERFACE = 0;
const SLOT_RELEASE = 2;
const SLOT_SHOW_CONTEXT_MENU = 91;

function guid(text: string): Uint8Array {
  const hex = text.replaceAll("-", "");
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(parseInt(hex.slice(0, 8), 16), 0);
  bytes.writeUInt16LE(parseInt(hex.slice(8, 12), 16), 4);
  bytes.writeUInt16LE(parseInt(hex.slice(12, 16), 16), 6);
  Buffer.from(hex.slice(16), "hex").copy(bytes, 8);
  return new Uint8Array(bytes);
}

function slotCall(self: Pointer, slot: number, args: FFIType[], values: unknown[]): number {
  const fn = read.ptr(read.ptr(self, 0) as Pointer, slot * 8) as Pointer;
  const method = CFunction({ ptr: fn, args: [P, ...args], returns: slot === SLOT_RELEASE ? u32 : i32 }) as unknown as (...a: unknown[]) => number;
  return method(self, ...values);
}

// The HRESULT of IUIAutomationElement3::ShowContextMenu. Chromium dispatches the page `contextmenu` event for it, as for the keyboard menu key.
function showContextMenu(element: Element): number {
  const out = new BigUint64Array(1);
  const iid = guid(IID_IUIAutomationElement3);
  const hr = slotCall(element.self, SLOT_QUERY_INTERFACE, [P, P], [ptr(iid), ptr(out)]);
  if (hr < 0) return hr;
  const element3 = Number(out[0]) as Pointer;
  try {
    return slotCall(element3, SLOT_SHOW_CONTEXT_MENU, [], []);
  } finally {
    slotCall(element3, SLOT_RELEASE, [], []);
  }
}

// Microsoft PE format: `e_lfanew` at 0x3C, the optional header after the 4-byte signature and the 20-byte COFF header, and `Subsystem` at byte 68 of it.
// The merge tools of git-mergetool(1) are GUI programs, so the copy of the Bun runtime gets the GUI subsystem.
const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;
function writeGuiCopy(from: string, to: string): void {
  const image = readFileSync(from);
  const header = image.readUInt32LE(0x3c);
  const subsystem = header + 4 + 20 + 68;
  if (image.toString("latin1", header, header + 4) !== "PE\0\0" || image.readUInt16LE(subsystem) !== IMAGE_SUBSYSTEM_WINDOWS_CUI) throw new Error(`${from} is not a console PE image`);
  image.writeUInt16LE(IMAGE_SUBSYSTEM_WINDOWS_GUI, subsystem);
  writeFileSync(to, image);
}

interface ToolReady {
  pid: number;
  hwnd: number;
  foreground: boolean;
}

async function waitReady(dir: string): Promise<ToolReady | null> {
  for (const end = performance.now() + TOOL_READY_MS; performance.now() < end; await Bun.sleep(POLL_MS)) {
    const names = readdirSync(dir);
    const error = names.find((n) => n.endsWith(".error"));
    if (error !== undefined) throw new Error(`the fixture tool failed: ${readFileSync(join(dir, error), "utf8")}`);
    const ready = names.find((n) => /^\d+$/.test(n));
    if (ready !== undefined) return JSON.parse(readFileSync(join(dir, ready), "utf8")) as ToolReady;
  }
  return null;
}

interface Member {
  pid: number;
  name: string | null;
  created: bigint | null;
}

const running = (members: Member[]) => members.filter((m) => m.created !== null && processCreationTime(m.pid) === m.created);

async function waitEnded(members: Member[]): Promise<Member[]> {
  for (const end = performance.now() + WAIT_MS; running(members).length > 0 && performance.now() < end; ) await Bun.sleep(POLL_MS);
  return running(members);
}

// plan.md D7: `mergetool --tool=<tool> --no-prompt -- <path>` with the global `--literal-pathspecs`.
const MERGETOOL_ARGS = ["--no-lazy-fetch", "--literal-pathspecs", "mergetool", "--tool=window", "--no-prompt", "--", "uu.txt"];
const TOOL_NAME = "native-merge-tool.exe";

// The start page option text, `OPEN_FOLDER` in src/frontend/app/RepositorySwitcher.tsx.
const OPEN_FOLDER = "Open folder… (Ctrl+O)";
// The accessible name of the current branch row in src/frontend/refs/ReferencesSidebar.tsx, for a branch without an upstream.
const CURRENT_ROW = "main, local branch, Current";
// `SHOW_BRANCH_HISTORY` and its shortcut text in src/frontend/refs/ReferencesSidebar.tsx. WebView2 joins the two texts with one space in the item name.
const MENU_ITEM = "Show only this branch's history Ctrl+Shift+B";

function powershell(script: string): unknown {
  const shell = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const proc = Bun.spawnSync([shell, "-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n${script}`], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: TEST_TIMEOUT_MS / 2 });
  if (proc.exitCode !== 0) throw new Error(`powershell exited ${proc.exitCode}: ${proc.stderr.toString()}`);
  return JSON.parse(proc.stdout.toString());
}
const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`;

describe.skipIf(process.platform !== "win32")("T005 native facts N1 to N6", () => {
  useFixtureRoot();
  afterAll(() => close());
  const noFocus = inputDesktopSkip();
  if (noFocus !== null) console.log(`SKIP focus cases: ${noFocus}`);

  test(
    "N1: UI Automation reads the trust task dialog, and Not now returns IDCANCEL",
    async () => {
      const manifest = join(fixtureDir("native-dialog"), "common-controls-6.manifest");
      writeFileSync(manifest, MANIFEST);
      const dialog = spawnProbe("dialog", [manifest], process.env);
      try {
        const { thread } = await dialog.reply<{ thread: number }>(MAX_WAIT_MS);
        observe("N1.main-instruction", true, await present(dialog.pid, MAIN, MAX_WAIT_MS));
        observe("N1.content", true, await present(dialog.pid, CONTENT, MAX_WAIT_MS));
        observe("N1.collapsed-control", true, await present(dialog.pid, COLLAPSED, MAX_WAIT_MS));
        observe("N1.details-while-collapsed", "record", await present(dialog.pid, DETAILS, 0), true);
        if (noFocus !== null) unverified("N1.initial-focus", noFocus);
        else {
          const focused = threadFocus(thread);
          observe("N1.initial-focus", NOT_NOW, focused === null ? null : windowString("GetWindowTextW", focused));
        }
        unverified("N1.enter-escape", "missing capability live-input: Enter and Escape need keyboard input");
        const expand = await uiaCode(() => use(find(dialog.pid, COLLAPSED, MAX_WAIT_MS), invoke));
        const details = expand === "ok" && (await present(dialog.pid, DETAILS, MAX_WAIT_MS));
        const hide = expand === "ok" && (await present(dialog.pid, EXPANDED, MAX_WAIT_MS));
        observe("N1.details-after-show-details", { invoke: "ok", details: true, expandedControl: true }, { invoke: expand, details, expandedControl: hide });
        const pressed = await uiaCode(() => use(find(dialog.pid, NOT_NOW, MAX_WAIT_MS), invoke));
        const result = pressed === "ok" ? await dialog.reply<{ hr: number; button: number }>(MAX_WAIT_MS) : null;
        observe("N1.not-now-result", { invoke: "ok", hr: 0, button: IDCANCEL }, { invoke: pressed, hr: result?.hr ?? null, button: result?.button ?? null });
      } finally {
        await dialog.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "N5: SHOpenFolderAndSelectItems opens the folder with the path selected",
    async () => {
      const folder = fixtureDir("native-reveal");
      const target = join(folder, "reveal target.txt");
      writeFileSync(target, "reveal\n");
      const before = powershell("ConvertTo-Json -Compress -InputObject @(@((New-Object -ComObject Shell.Application).Windows() | ForEach-Object { [int64]$_.HWND }))") as number[];
      const reveal = spawnProbe("reveal", [target], process.env);
      try {
        const call = await reveal.reply<{ init: number; hr: number }>(MAX_WAIT_MS);
        // Shell.Application gives the folder path and the selected items of each Explorer window. Only a window that this call opened closes.
        const state = powershell(`$dir = ${quoted(folder)}
$before = @(${before.join(",")})
$shell = New-Object -ComObject Shell.Application
$found = $null
$selected = @()
$end = [DateTime]::UtcNow.AddMilliseconds(${TOOL_READY_MS / 4})
while ([DateTime]::UtcNow -lt $end) {
  foreach ($w in @($shell.Windows())) { try { if ($w.Document.Folder.Self.Path -eq $dir) { $found = $w } } catch {} }
  if ($null -ne $found) { $selected = @($found.Document.SelectedItems() | ForEach-Object { $_.Path }); if ($selected.Count -gt 0) { break } }
  Start-Sleep -Milliseconds ${POLL_MS}
}
$hwnd = if ($null -ne $found) { [int64]$found.HWND } else { $null }
$preexisting = $null -ne $found -and $before -contains $hwnd
if ($null -ne $found -and -not $preexisting) { $found.Quit() }
ConvertTo-Json -Compress -InputObject @{ found = $null -ne $found; selected = $selected; preexisting = $preexisting }`) as { found: boolean; selected: string[]; preexisting: boolean };
        if (state.preexisting) console.log(`NOTE ${TASK}: the reveal opened a tab in an existing Explorer window. The test leaves that window open.`);
        // Windows paths ignore case.
        const selected = state.selected.map((p) => p.toLowerCase());
        observe("N5.reveal-selects-path", { hr: 0, window: true, selected: [target.toLowerCase()] }, { hr: call.hr, window: state.found, selected });
      } finally {
        await reveal.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  if (GIT === null) for (const fact of ["N3.tool-in-job", "N4.cancel-ends-tree", "N6.plain", "N6.allow"]) unverified(fact, "missing capability git: Git executable absent");

  test.skipIf(GIT === null)(
    "N3, N4, N6: the fixture merge tool runs in the operation Job, Cancel ends the tree, and the tool window foreground",
    async () => {
      const tool = join(fixtureDir("native-tool"), TOOL_NAME);
      writeGuiCopy(process.execPath, tool);
      const shell = spawnProbe("shell", [], fixtureEnv({ GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: ":" }));
      const tools: Member[] = [];
      try {
        await shell.reply<{ hwnd: number }>(MAX_WAIT_MS);
        for (const variant of ["plain", "allow"] as const) {
          // The allow run needs the foreground precondition. Without it, only the plain run gives N3 and N4.
          if (variant === "allow" && noFocus !== null) {
            unverified(`N6.${variant}`, noFocus);
            continue;
          }
          const fixture = buildWorkbench(GIT!, "conflict-merge", `native-conflict-${variant}`);
          const ready = fixtureDir(`native-ready-${variant}`);
          wb(repoOf(fixture), ["config", "mergetool.window.cmd", `${PROBE_VARIABLE}=tool '${slash(tool)}' '${slash(import.meta.path)}' '${slash(ready)}' "$MERGED"`]);
          // plan.md D14: the user starts the tool from the Arbareto window, so the starting process holds the foreground.
          const focusCall = noFocus === null ? await uiaCode(() => use(find(shell.pid, SHELL_BUTTON, MAX_WAIT_MS), focus)) : null;
          const focusWait = focusCall === "ok" ? await uiaCode(() => waitFocus(shell.pid, SHELL_BUTTON, MAX_WAIT_MS)) : null;
          const focused = focusWait === "ok";
          const noForeground = focusWait === "TIMEOUT" ? foregroundSkip(shell.pid) : null;
          const lock = foregroundLock();
          shell.send({ cmd: "start", allow: variant === "allow", git: GIT!, cwd: fixture.repo, args: MERGETOOL_ARGS });
          const started = await shell.reply<{ pid: number; foreground: boolean; allowed: boolean | null }>(MAX_WAIT_MS);
          const facts = await waitReady(ready);
          shell.send({ cmd: "pids" });
          const job = await shell.reply<{ members: { pid: number; created: string | null }[]; gitRunning: boolean; gitExit: number }>(MAX_WAIT_MS);
          const names = new Map(processRecords().map((r) => [r.pid, r.name]));
          if (facts === null) throw new Error(`the fixture tool did not start within ${TOOL_READY_MS} ms; Git running ${job.gitRunning}, exit ${job.gitExit}; Job members ${job.members.map((m) => names.get(m.pid) ?? `pid ${m.pid}`).join(", ") || "none"}`);
          tools.push({ pid: facts.pid, name: TOOL_NAME, created: processCreationTime(facts.pid) });
          const owner = foregroundPid();
          const later = owner === null ? null : (names.get(owner) ?? `pid ${owner}`);
          if (noFocus !== null) unverified(`N6.${variant}`, noFocus);
          else if (noForeground !== null) unverified(`N6.${variant}`, noForeground);
          else if (!started.foreground) unverified(`N6.${variant}`, `missing capability foreground: the probe shell was not the foreground window at the start (UIA focus ${focused})`);
          else observe(`N6.${variant}`, { foreground: true }, { foreground: facts.foreground, foregroundOwnerAtReady: later, allowed: started.allowed, ...lock }, facts.foreground);
          const members = job.members.map((m) => ({ pid: m.pid, name: names.get(m.pid) ?? null, created: m.created === null ? null : BigInt(m.created) }));
          shell.send({ cmd: "cancel" });
          await shell.reply(MAX_WAIT_MS);
          const left = await waitEnded(members);
          if (variant === "plain") {
            observe("N3.tool-in-job", true, members.some((m) => m.pid === facts.pid));
            const listed = [...new Set(members.map((m) => m.name))].sort();
            const required = ["git.exe", "sh.exe", TOOL_NAME];
            observe("N4.cancel-ends-tree", { contains: required, remaining: [] }, { names: listed, remaining: left.map((m) => m.name) }, left.length === 0 && required.every((n) => listed.includes(n)));
          }
        }
      } finally {
        await shell.stop();
        // The fixture root holds the tool image, so its removal needs every tool process gone.
        for (const m of await waitEnded(tools)) {
          console.log(`LEFT ${TASK}: fixture tool PID ${m.pid} still runs`);
          terminateRecorded(m.pid, m.created!);
        }
        expect(running(tools)).toEqual([]);
      }
    },
    TEST_TIMEOUT_MS * 2,
  );

  describe("installed app", () => {
    const found = findInstalledApp();
    const app = "app" in found ? found.app : null;
    const reason = app === null ? (found as { skip: string }).skip : GIT === null ? "Git executable absent" : noFocus;
    if (reason !== null) {
      console.log(`SKIP installed app: ${reason}`);
      unverified("N2.app-menu-by-uia-show-context-menu", reason);
    }
    unverified("N2.right-click-and-shift-f10", "missing capability live-input: a right-click and Shift+F10 need pointer and keyboard input");

    test.skipIf(reason !== null)(
      "N2: a page contextmenu handler with preventDefault shows the app menu in the package",
      async () => {
        const fixture = buildWorkbench(GIT!, "amend-no-upstream", "native-app-repo");
        const owned = startInstalledApp(app!, appEnv(fixtureDir("native-app"), false));
        try {
          // As in uia.test.ts: the focus brings the app to the foreground, so its task dialog opens active.
          const noForeground = await use(find(owned.pid, "Select Git", MAX_WAIT_MS), async (button) => {
            focus(button);
            try {
              await waitFocus(owned.pid, "Select Git", MAX_WAIT_MS);
            } catch (error) {
              const skip = error instanceof UiaError && error.code === "TIMEOUT" ? foregroundSkip(owned.pid) : null;
              if (skip === null) throw error;
              return skip;
            }
            invoke(button);
            return null;
          });
          if (noForeground !== null) {
            unverified("N2.app-menu-by-uia-show-context-menu", noForeground);
            return;
          }
          await use(find(owned.pid, "Use this Git", MAX_WAIT_MS), invoke);
          await use(find(owned.pid, OPEN_FOLDER, MAX_WAIT_MS), invoke);
          // The OK button of the Windows folder picker. The first element named "Folder:" is not the Edit box, so a window message sets the box text.
          const select = await find(owned.pid, "Select Folder", MAX_WAIT_MS);
          try {
            win().user32.SendMessageW(folderBox(owned.pid), WM_SETTEXT, null, ptr(wide(fixture.repo)));
            invoke(select);
          } finally {
            select.release();
          }
          const hr = await use(find(owned.pid, CURRENT_ROW, MAX_WAIT_MS), showContextMenu);
          const menu = await present(owned.pid, MENU_ITEM, MAX_WAIT_MS);
          observe("N2.app-menu-by-uia-show-context-menu", { hr: 0, menu: true }, { hr, menu });
        } finally {
          owned.stop();
          expect(await waitExit(owned)).not.toBeNull();
        }
      },
      TEST_TIMEOUT_MS,
    );
  });
});
