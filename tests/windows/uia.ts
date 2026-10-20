// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T240: test-only UI Automation driver. UI Automation does not connect processes that different users start, so run it under the account of the app.

import { CFunction, dlopen, FFIType, ptr, read, toArrayBuffer, type Pointer } from "bun:ffi";

export type UiaErrorCode = "NOT_WINDOWS" | "BAD_ARGUMENT" | "COM_FAILED" | "TIMEOUT" | "NO_PATTERN" | "RELEASED";

export class UiaError extends Error {
  constructor(
    readonly code: UiaErrorCode,
    detail: string,
    readonly hresult?: number,
  ) {
    super(`${code}: ${detail}`);
  }
}

export const MAX_WAIT_MS = 10_000;
// `IUIAutomation2` bounds of one call. A call to a provider that does not answer fails with UIA_E_TIMEOUT or HRESULT_FROM_WIN32(ERROR_TIMEOUT) after the bound. Both stay below MAX_WAIT_MS.
const CONNECTION_TIMEOUT_MS = 2_000;
const TRANSACTION_TIMEOUT_MS = 5_000;
// A poll can pass its bound by one call.
export const MAX_CALL_MS = Math.max(CONNECTION_TIMEOUT_MS, TRANSACTION_TIMEOUT_MS);
const POLL_MS = 1;

const { ptr: P, u32, i32 } = FFIType;
const open = () => ({
  ole32: dlopen("ole32.dll", {
    CoInitializeEx: { args: [P, u32], returns: i32 },
    CoCreateInstance: { args: [P, P, u32, P, P], returns: i32 },
  }).symbols,
  oleaut32: dlopen("oleaut32.dll", {
    SysAllocString: { args: [P], returns: P },
    SysFreeString: { args: [P], returns: FFIType.void },
  }).symbols,
  kernel32: dlopen("kernel32.dll", {
    QueryPerformanceCounter: { args: [P], returns: i32 },
    GetLastError: { args: [], returns: u32 },
    GetTickCount: { args: [], returns: u32 },
    OpenProcess: { args: [u32, i32, u32], returns: P },
    QueryFullProcessImageNameW: { args: [P, u32, P, P], returns: i32 },
    CloseHandle: { args: [P], returns: i32 },
  }).symbols,
  user32: dlopen("user32.dll", {
    GetForegroundWindow: { args: [], returns: P },
    GetLastInputInfo: { args: [P], returns: i32 },
    SystemParametersInfoW: { args: [u32, u32, P, u32], returns: i32 },
    FindWindowExW: { args: [P, P, P, P], returns: P },
    GetWindowThreadProcessId: { args: [P, P], returns: u32 },
    OpenInputDesktop: { args: [u32, i32, u32], returns: P },
    GetUserObjectInformationW: { args: [P, i32, P, u32, P], returns: i32 },
    CloseDesktop: { args: [P], returns: i32 },
  }).symbols,
  wtsapi32: dlopen("wtsapi32.dll", {
    WTSQuerySessionInformationW: { args: [P, u32, i32, P, P], returns: i32 },
    WTSFreeMemory: { args: [P], returns: FFIType.void },
  }).symbols,
  winmm: dlopen("winmm.dll", {
    timeBeginPeriod: { args: [u32], returns: u32 },
    timeEndPeriod: { args: [u32], returns: u32 },
  }).symbols,
});
let dlls: ReturnType<typeof open> | undefined;

// The DLLs exist only on Windows, so the import of this file must not open them.
function lib(): ReturnType<typeof open> {
  if (process.platform !== "win32") throw new UiaError("NOT_WINDOWS", "UI Automation needs Windows");
  return (dlls ??= open());
}

// Windows SDK 10.0.19041.0 `UIAutomationClient.h`: GUIDs, IDs, and the C vtable slot of each method.
// The Windows 7 `CUIAutomation` has no connection bound, so `ElementFromHandle` on a stuck window thread can block for more than 60 s.
const CLSID_CUIAutomation8 = "e22ad333-b25f-460c-83d0-0581107395c9";
const IID_IUIAutomation2 = "34723aff-0c9d-49d0-9896-7ab52df8cd8a";
const IID_IUIAutomationInvokePattern = "fb377fbe-8ea6-46d5-9c73-6499642d3059";
const IID_IUIAutomationTextPattern = "32eba289-3583-42c9-9c59-3b6d9a1e9b6a";
const IID_IUIAutomationSelectionItemPattern = "a8efa66a-0fda-421a-9194-38021f3578ea";
const IID_IUIAutomationValuePattern = "a94cd8b1-0844-4cd6-9d2d-640537ab39e9";
const IID_IUIAutomationExpandCollapsePattern = "619be086-1f4e-4ee4-bafa-210128738730";
const UIA_InvokePatternId = 10000;
const UIA_ValuePatternId = 10002;
const UIA_ExpandCollapsePatternId = 10005;
const UIA_SelectionItemPatternId = 10010;
const UIA_TextPatternId = 10014;
const UIA_ControlTypePropertyId = 30003;
const UIA_NamePropertyId = 30005;
const UIA_LiveSettingPropertyId = 30135;
// `UIAutomationCore.h` enum LiveSetting.
const Polite = 1;
// `UIAutomationClient.h` control type IDs for the `controlType` argument of `find`.
export const ControlType = { Button: 50000, Edit: 50004, MenuItem: 50011, Tree: 50023 } as const;
const TreeScope_Descendants = 0x4;
const SLOT = {
  // IUnknown
  Release: 2,
  // IUIAutomation
  ElementFromHandle: 6,
  GetFocusedElement: 8,
  get_RawViewWalker: 16,
  CreateTrueCondition: 21,
  CreatePropertyCondition: 23,
  CreateAndCondition: 25,
  // IUIAutomation2
  put_ConnectionTimeout: 61,
  put_TransactionTimeout: 63,
  // IUIAutomationTreeWalker
  GetParentElement: 3,
  // IUIAutomationElement
  SetFocus: 3,
  FindFirst: 5,
  FindAll: 6,
  GetCurrentPatternAs: 14,
  get_CurrentProcessId: 20,
  get_CurrentName: 23,
  get_CurrentIsEnabled: 28,
  // IUIAutomationElementArray
  get_Length: 3,
  GetElement: 4,
  // IUIAutomationInvokePattern
  Invoke: 3,
  // IUIAutomationSelectionItemPattern
  Select: 3,
  get_CurrentIsSelected: 6,
  // IUIAutomationExpandCollapsePattern
  Expand: 3,
  Collapse: 4,
  // IUIAutomationValuePattern
  SetValue: 3,
  get_CurrentValue: 4,
  // IUIAutomationTextPattern
  get_DocumentRange: 7,
  // IUIAutomationTextRange
  GetText: 12,
} as const;
const CLSCTX_INPROC_SERVER = 0x1;
const COINIT_MULTITHREADED = 0x0;
const RPC_E_CHANGED_MODE = 0x8001_0106;
// `UIAutomationCoreApi.h`: the element is gone, or the provider did not answer in time. A poll treats all three codes as no match yet.
// UI Automation does not document 0x800705b4 (HRESULT_FROM_WIN32(ERROR_TIMEOUT)) for `ElementFromHandle`. The 004 verification run of 2026-10-20 got it from the app while its main thread waited for the service handshake.
// shortcut: no case can produce it on demand; add one when a reproducible trigger is known.
const RETRY = new Set([0x8004_0201, 0x8013_1505, 0x8007_05b4]);
const VT_I4 = 3;
const VT_BSTR = 8;
// x64 VARIANT: `vt` at offset 0, the value at offset 8. A by-value VARIANT goes as a pointer to a copy (x64 ABI, size above 8 bytes).
const VARIANT_BYTES = 24;

function guid(text: string): Buffer {
  const hex = text.replaceAll("-", "");
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(parseInt(hex.slice(0, 8), 16), 0);
  bytes.writeUInt16LE(parseInt(hex.slice(8, 12), 16), 4);
  bytes.writeUInt16LE(parseInt(hex.slice(12, 16), 16), 6);
  Buffer.from(hex.slice(16), "hex").copy(bytes, 8);
  return bytes;
}

const methods = new Map<string, (...args: unknown[]) => number>();

// Calls slot `slot` of the vtable of `self`. Every method returns an HRESULT, except Release.
function slotCall(self: Pointer, slot: number, args: FFIType[], values: unknown[]): number {
  const fn = read.ptr(read.ptr(self, 0) as Pointer, slot * 8) as Pointer;
  const key = `${fn}:${args.join(",")}`;
  let method = methods.get(key);
  if (!method) methods.set(key, (method = CFunction({ ptr: fn, args: [P, ...args], returns: slot === SLOT.Release ? u32 : i32 }) as never));
  return method(self, ...values);
}

function hr(name: string, result: number): void {
  if (result < 0) throw new UiaError("COM_FAILED", `${name} returned 0x${(result >>> 0).toString(16)}`, result >>> 0);
}

// Calls a method whose last parameter receives an interface pointer. Returns null for a null result.
function outCall(self: Pointer, name: keyof typeof SLOT, args: FFIType[], values: unknown[]): Pointer | null {
  const out = new BigUint64Array(1);
  hr(name, slotCall(self, SLOT[name], [...args, P], [...values, ptr(out)]));
  return out[0] === 0n ? null : (Number(out[0]) as Pointer);
}

function release(self: Pointer | null): void {
  if (self !== null) slotCall(self, SLOT.Release, [], []);
}

function bstr(name: "get_CurrentName" | "GetText" | "get_CurrentValue", self: Pointer, args: FFIType[], values: unknown[]): string {
  const text = outCall(self, name, args, values);
  if (text === null) return "";
  try {
    // The 4 bytes before a BSTR hold its length in bytes.
    const bytes = read.u32(text, -4);
    return bytes === 0 ? "" : Buffer.from(toArrayBuffer(text, 0, bytes)).toString("utf16le");
  } finally {
    lib().oleaut32.SysFreeString(text);
  }
}

let automation: Pointer | null = null;

function uia(): Pointer {
  if (automation !== null) return automation;
  const { ole32 } = lib();
  const init = ole32.CoInitializeEx(null, COINIT_MULTITHREADED);
  if (init < 0 && init >>> 0 !== RPC_E_CHANGED_MODE) hr("CoInitializeEx", init);
  const out = new BigUint64Array(1);
  hr("CoCreateInstance", ole32.CoCreateInstance(ptr(guid(CLSID_CUIAutomation8)), null, CLSCTX_INPROC_SERVER, ptr(guid(IID_IUIAutomation2)), ptr(out)));
  // `IUIAutomation2` extends `IUIAutomation`, so the same pointer serves both vtables.
  const created = Number(out[0]) as Pointer;
  try {
    hr("put_ConnectionTimeout", slotCall(created, SLOT.put_ConnectionTimeout, [u32], [CONNECTION_TIMEOUT_MS]));
    hr("put_TransactionTimeout", slotCall(created, SLOT.put_TransactionTimeout, [u32], [TRANSACTION_TIMEOUT_MS]));
  } catch (error) {
    release(created);
    throw error;
  }
  automation = created;
  return automation;
}

// Releases the CUIAutomation8 object. A later call creates a new one.
export function close(): void {
  release(automation);
  automation = null;
}

// Owns one IUIAutomationElement reference. The caller must call `release`.
export class Element {
  #self: Pointer | null;
  constructor(self: Pointer) {
    this.#self = self;
  }
  get self(): Pointer {
    if (this.#self === null) throw new UiaError("RELEASED", "the element is released");
    return this.#self;
  }
  get name(): string {
    return bstr("get_CurrentName", this.self, [], []);
  }
  release(): void {
    release(this.#self);
    this.#self = null;
  }
}

// The caller frees the result with SysFreeString.
function allocBstr(value: string): Pointer {
  const allocated = lib().oleaut32.SysAllocString(ptr(Buffer.from(`${value}\0`, "utf16le")));
  if (typeof allocated !== "number") throw new UiaError("COM_FAILED", "SysAllocString returned null");
  return allocated;
}

function propertyCondition(property: number, value: number | string): Pointer {
  const variant = Buffer.alloc(VARIANT_BYTES);
  let text: Pointer | null = null;
  if (typeof value === "number") {
    variant.writeUInt16LE(VT_I4, 0);
    variant.writeInt32LE(value, 8);
  } else {
    text = allocBstr(value);
    variant.writeUInt16LE(VT_BSTR, 0);
    variant.writeBigUInt64LE(BigInt(text), 8);
  }
  try {
    return outCall(uia(), "CreatePropertyCondition", [i32, P], [property, ptr(variant)])!;
  } finally {
    // The condition keeps its own copy of the VARIANT.
    if (text !== null) lib().oleaut32.SysFreeString(text);
  }
}

function qpc(): bigint {
  const value = new BigInt64Array(1);
  lib().kernel32.QueryPerformanceCounter(ptr(value));
  return value[0]!;
}

function checkArgs(processId: number, name: string, timeoutMs: number): void {
  if (!Number.isInteger(processId) || processId <= 0) throw new UiaError("BAD_ARGUMENT", `processId ${processId}`);
  if (typeof name !== "string" || name === "") throw new UiaError("BAD_ARGUMENT", "name is empty");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) throw new UiaError("BAD_ARGUMENT", `timeoutMs ${timeoutMs} is outside 0..${MAX_WAIT_MS}`);
}

// Polls `probe` every POLL_MS until it returns a value or the bound passes. The 1 ms timer period keeps each sleep below 5 ms. A probe in progress at the bound runs to its end.
async function poll<T>(timeoutMs: number, what: string | (() => string), probe: () => T | null): Promise<T> {
  const { winmm } = lib();
  const deadline = performance.now() + timeoutMs;
  winmm.timeBeginPeriod(1);
  try {
    for (;;) {
      try {
        const found = probe();
        if (found !== null) return found;
      } catch (error) {
        if (!(error instanceof UiaError && error.hresult !== undefined && RETRY.has(error.hresult))) throw error;
      }
      if (performance.now() >= deadline) throw new UiaError("TIMEOUT", `${typeof what === "string" ? what : what()} after ${timeoutMs} ms`);
      await Bun.sleep(POLL_MS);
    }
  } finally {
    winmm.timeEndPeriod(1);
  }
}

function length(array: Pointer): number {
  const value = new Int32Array(1);
  hr("get_Length", slotCall(array, SLOT.get_Length, [P], [ptr(value)]));
  return value[0]!;
}

function processIdOf(self: Pointer): number {
  const value = new Int32Array(1);
  hr("get_CurrentProcessId", slotCall(self, SLOT.get_CurrentProcessId, [P], [ptr(value)]));
  return value[0]!;
}

// Calls `search` with each top-level window of the process in Z order until it returns a value. A UI Automation search of all desktop children reads every window of every process, so the process windows come from `FindWindowExW`.
function eachWindow<T>(processId: number, search: (window: Pointer) => T | null): T | null {
  const { user32 } = lib();
  const owner = new Uint32Array(1);
  for (let hwnd = user32.FindWindowExW(null, null, null, null); typeof hwnd === "number" && hwnd !== 0; hwnd = user32.FindWindowExW(null, hwnd, null, null)) {
    user32.GetWindowThreadProcessId(hwnd, ptr(owner));
    if (owner[0] !== processId) continue;
    const window = outCall(uia(), "ElementFromHandle", [P], [hwnd]);
    if (window === null) continue;
    try {
      const found = search(window);
      if (found !== null) return found;
    } finally {
      release(window);
    }
  }
  return null;
}

// The first descendant in tree order whose Name equals `name`, and whose control type equals `controlType` when given. UI Automation also shows an owned dialog as a descendant of its owner window.
export async function find(processId: number, name: string, timeoutMs: number, controlType?: number): Promise<Element> {
  checkArgs(processId, name, timeoutMs);
  if (controlType !== undefined && !Object.values(ControlType).includes(controlType as never)) throw new UiaError("BAD_ARGUMENT", `controlType ${controlType}`);
  const byName = propertyCondition(UIA_NamePropertyId, name);
  let condition = byName;
  if (controlType !== undefined) {
    let byType: Pointer | null = null;
    try {
      byType = propertyCondition(UIA_ControlTypePropertyId, controlType);
      condition = outCall(uia(), "CreateAndCondition", [P, P], [byName, byType])!;
    } finally {
      // The And condition holds its own references.
      release(byType);
      release(byName);
    }
  }
  try {
    return await poll(timeoutMs, `no element named ${JSON.stringify(name)} in process ${processId}`, () =>
      eachWindow(processId, (window) => {
        const found = outCall(window, "FindFirst", [i32, P], [TreeScope_Descendants, condition]);
        return found === null ? null : new Element(found);
      }),
    );
  } finally {
    release(condition);
  }
}

// Every descendant with LiveSetting Polite, in tree order. ARIA `role="status"` implies `aria-live="polite"` and has no Name.
export async function findLiveRegions(processId: number, timeoutMs: number): Promise<Element[]> {
  checkArgs(processId, "live", timeoutMs);
  const polite = propertyCondition(UIA_LiveSettingPropertyId, Polite);
  try {
    return await poll(timeoutMs, `no polite live region in process ${processId}`, () =>
      eachWindow(processId, (window) => {
        const found = outCall(window, "FindAll", [i32, P], [TreeScope_Descendants, polite]);
        if (found === null) return null;
        const elements: Element[] = [];
        try {
          for (let i = 0, n = length(found); i < n; i++) elements.push(new Element(outCall(found, "GetElement", [i32], [i])!));
          return elements.length === 0 ? null : elements;
        } catch (error) {
          for (const element of elements) element.release();
          throw error;
        } finally {
          release(found);
        }
      }),
    );
  } finally {
    release(polite);
  }
}

function pattern(element: Element, id: number, iid: string): Pointer | null {
  return outCall(element.self, "GetCurrentPatternAs", [i32, P], [id, ptr(guid(iid))]);
}

function withPattern<T>(element: Element, id: number, iid: string, label: string, body: (self: Pointer) => T): T {
  const self = pattern(element, id, iid);
  if (self === null) throw new UiaError("NO_PATTERN", `${JSON.stringify(element.name)} has no ${label} pattern`);
  try {
    return body(self);
  } finally {
    release(self);
  }
}

export function invoke(element: Element): void {
  withPattern(element, UIA_InvokePatternId, IID_IUIAutomationInvokePattern, "Invoke", (self) => hr("Invoke", slotCall(self, SLOT.Invoke, [], [])));
}

export function expand(element: Element): void {
  withPattern(element, UIA_ExpandCollapsePatternId, IID_IUIAutomationExpandCollapsePattern, "ExpandCollapse", (self) => hr("Expand", slotCall(self, SLOT.Expand, [], [])));
}

export function collapse(element: Element): void {
  withPattern(element, UIA_ExpandCollapsePatternId, IID_IUIAutomationExpandCollapsePattern, "ExpandCollapse", (self) => hr("Collapse", slotCall(self, SLOT.Collapse, [], [])));
}

export function focus(element: Element): void {
  hr("SetFocus", slotCall(element.self, SLOT.SetFocus, [], []));
}

export function select(element: Element): void {
  withPattern(element, UIA_SelectionItemPatternId, IID_IUIAutomationSelectionItemPattern, "SelectionItem", (self) => hr("Select", slotCall(self, SLOT.Select, [], [])));
}

export function isSelected(element: Element): boolean {
  return withPattern(element, UIA_SelectionItemPatternId, IID_IUIAutomationSelectionItemPattern, "SelectionItem", (self) => {
    const value = new Int32Array(1);
    hr("get_CurrentIsSelected", slotCall(self, SLOT.get_CurrentIsSelected, [P], [ptr(value)]));
    return value[0] !== 0;
  });
}

export function setValue(element: Element, text: string): void {
  if (typeof text !== "string") throw new UiaError("BAD_ARGUMENT", "text is not a string");
  withPattern(element, UIA_ValuePatternId, IID_IUIAutomationValuePattern, "Value", (self) => {
    const value = allocBstr(text);
    try {
      hr("SetValue", slotCall(self, SLOT.SetValue, [P], [value]));
    } finally {
      lib().oleaut32.SysFreeString(value);
    }
  });
}

// Chromium maps `disabled` and `aria-disabled="true"` to IsEnabled false.
export function isEnabled(element: Element): boolean {
  const value = new Int32Array(1);
  hr("get_CurrentIsEnabled", slotCall(element.self, SLOT.get_CurrentIsEnabled, [P], [ptr(value)]));
  return value[0] !== 0;
}

export function readValue(element: Element): string {
  return withPattern(element, UIA_ValuePatternId, IID_IUIAutomationValuePattern, "Value", (self) => bstr("get_CurrentValue", self, [], []));
}

// The Text pattern text, or else the Names of all descendants in tree order, joined without a separator.
export function readText(element: Element): string {
  const text = pattern(element, UIA_TextPatternId, IID_IUIAutomationTextPattern);
  if (text !== null) {
    let range: Pointer | null = null;
    try {
      range = outCall(text, "get_DocumentRange", [], [])!;
      return bstr("GetText", range, [i32], [-1]);
    } finally {
      release(range);
      release(text);
    }
  }
  const all = outCall(uia(), "CreateTrueCondition", [], [])!;
  let found: Pointer | null = null;
  try {
    found = outCall(element.self, "FindAll", [i32, P], [TreeScope_Descendants, all]);
    if (found === null) return "";
    const names: string[] = [];
    for (let i = 0, n = length(found); i < n; i++) {
      const item = new Element(outCall(found, "GetElement", [i32], [i])!);
      try {
        names.push(item.name);
      } finally {
        item.release();
      }
    }
    return names.join("");
  } finally {
    release(found);
    release(all);
  }
}

// The process of the top-level window above `self` in the raw view. WebView2 content belongs to the msedgewebview2.exe browser process, and its top-level window to the app.
function topLevelProcessId(self: Pointer): number | null {
  const walker = outCall(uia(), "get_RawViewWalker", [], [])!;
  let child: Pointer | null = null;
  let parent: Pointer | null = null;
  try {
    parent = outCall(walker, "GetParentElement", [P], [self]);
    if (parent === null) return null;
    for (;;) {
      const grand = outCall(walker, "GetParentElement", [P], [parent]);
      if (grand === null) return processIdOf(child ?? self);
      release(child);
      child = parent;
      parent = grand;
    }
  } finally {
    release(parent);
    release(child);
    release(walker);
  }
}

// Returns the QueryPerformanceCounter value read right after the focused element first has that Name below a top-level window of the process.
export async function waitFocus(processId: number, name: string, timeoutMs: number): Promise<bigint> {
  checkArgs(processId, name, timeoutMs);
  return poll(timeoutMs, () => `no focus on ${JSON.stringify(name)} in process ${processId} (${foregroundFacts()})`, () => {
    const focused = outCall(uia(), "GetFocusedElement", [], []);
    if (focused === null) return null;
    const element = new Element(focused);
    try {
      if (element.name !== name || topLevelProcessId(focused) !== processId) return null;
      return qpc();
    } finally {
      element.release();
    }
  });
}

// The process of the foreground window, or null when no window is in the foreground.
export function foregroundPid(): number | null {
  const hwnd = lib().user32.GetForegroundWindow();
  if (typeof hwnd !== "number" || hwnd === 0) return null;
  const pid = new Uint32Array(1);
  lib().user32.GetWindowThreadProcessId(hwnd, ptr(pid));
  return pid[0]!;
}

// Microsoft Learn `OpenProcess` and `QueryFullProcessImageNameW`.
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const IMAGE_UNITS = 32_768;

function imageName(pid: number): string {
  const { kernel32 } = lib();
  const handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (typeof handle !== "number" || handle === 0) return `unreadable (error ${kernel32.GetLastError()})`;
  try {
    const path = new Uint16Array(IMAGE_UNITS);
    const units = new Uint32Array([IMAGE_UNITS]);
    if (!kernel32.QueryFullProcessImageNameW(handle, 0, ptr(path), ptr(units))) return `unreadable (error ${kernel32.GetLastError()})`;
    return Buffer.from(path.buffer, 0, units[0]! * 2).toString("utf16le").split("\\").pop()!;
  } finally {
    kernel32.CloseHandle(handle);
  }
}

// Microsoft Learn `SetForegroundWindow`: a process takes the foreground only after no input came for the lock time-out. x64 LASTINPUTINFO is `cbSize` and `dwTime`.
const SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000;

function foregroundFacts(): string {
  const { kernel32, user32 } = lib();
  const pid = foregroundPid();
  const owner = pid === null ? "none" : `${imageName(pid)} pid ${pid}`;
  const timeout = new Uint32Array(1);
  const lock = user32.SystemParametersInfoW(SPI_GETFOREGROUNDLOCKTIMEOUT, 0, ptr(timeout), 0) ? `${timeout[0]}` : `unreadable (error ${kernel32.GetLastError()})`;
  const input = new Uint32Array([8, 0]);
  // Both tick values wrap at 2^32 ms.
  const idle = user32.GetLastInputInfo(ptr(input)) ? `${(kernel32.GetTickCount() - input[1]!) >>> 0}` : `unreadable (error ${kernel32.GetLastError()})`;
  return `foreground owner ${owner}, lock timeout ${lock}, idle ${idle}`;
}

// Keyboard focus sits only in a window of the foreground process. Returns null when `processId` owns the foreground window, or the facts for the SKIP line.
export function foregroundSkip(processId: number): string | null {
  return foregroundPid() === processId ? null : `missing capability foreground: ${foregroundFacts()}`;
}

// Microsoft Learn `OpenInputDesktop`, `GetUserObjectInformationW`, and "Desktop Security and Access Rights".
const DESKTOP_READOBJECTS = 0x0001;
const UOI_NAME = 2;
const NAME_BYTES = 512;

// The name of the desktop that receives user input, or null and the `GetLastError` value of the failed call.
export function inputDesktop(): { name: string | null; error: number | null } {
  const { user32, kernel32 } = lib();
  const desktop = user32.OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
  if (!desktop) return { name: null, error: kernel32.GetLastError() };
  try {
    const name = Buffer.alloc(NAME_BYTES);
    const needed = new Uint32Array(1);
    if (!user32.GetUserObjectInformationW(desktop, UOI_NAME, ptr(name), NAME_BYTES, ptr(needed))) return { name: null, error: kernel32.GetLastError() };
    return { name: name.toString("utf16le").split("\u0000")[0]!, error: null };
  } finally {
    user32.CloseDesktop(desktop);
  }
}

// Microsoft Learn `WTSQuerySessionInformationW` and `WTSINFOEX_LEVEL1_W`. The union after `Level` holds a LARGE_INTEGER, so it starts at byte 8.
const WTS_CURRENT_SESSION = 0xffff_ffff;
const WTS_SESSION_INFO_EX = 25;
const SESSION_FLAGS_OFFSET = 16;
export const WTS_SESSIONSTATE_UNLOCK = 1;

// The `SessionFlags` value of the current session, or null and the `GetLastError` value of the failed call.
// Windows 7 reverses the lock flags. Tauri 2 needs Windows 10 or later.
export function sessionFlags(): { flags: number | null; error: number | null } {
  const { wtsapi32, kernel32 } = lib();
  const buffer = new BigUint64Array(1);
  const bytes = new Uint32Array(1);
  if (!wtsapi32.WTSQuerySessionInformationW(null, WTS_CURRENT_SESSION, WTS_SESSION_INFO_EX, ptr(buffer), ptr(bytes))) return { flags: null, error: kernel32.GetLastError() };
  const info = Number(buffer[0]) as Pointer;
  try {
    return { flags: read.u32(info, SESSION_FLAGS_OFFSET), error: null };
  } finally {
    wtsapi32.WTSFreeMemory(info);
  }
}

// Keyboard focus needs an unlocked session whose input desktop is `Default`. A locked Windows 11 session can keep `Default` as the input desktop, with LockApp in the foreground.
// Returns null when both facts hold, or the facts for the SKIP line.
export function inputDesktopSkip(): string | null {
  const desktop = inputDesktop();
  const session = sessionFlags();
  if (desktop.name === "Default" && session.flags === WTS_SESSIONSTATE_UNLOCK) return null;
  const name = desktop.name === null ? `unreadable (error ${desktop.error})` : JSON.stringify(desktop.name);
  const flags = session.flags === null ? `unreadable (error ${session.error})` : `0x${session.flags.toString(16)}`;
  return `missing capability input-desktop: input desktop ${name}, session flags ${flags}`;
}
