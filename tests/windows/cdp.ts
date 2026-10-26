// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// A small Chrome DevTools Protocol client for the WebView2 page of the installed app. It sends no OS input.
// WebView2 opens the CDP endpoint only with `--remote-debugging-port` in WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS.

// Tauri 2 on Windows serves the frontend from this origin when `useHttpsScheme` is false (src-tauri/tauri.conf.json sets no value).
const PAGE_ORIGIN = "http://tauri.localhost";
// Tauri 2 on Windows sends each `invoke` as a POST to this origin, and the path is the command name. CDP `Network` shows each call.
export const IPC_ORIGIN = "http://ipc.localhost";
const CALL_MS = 10_000;
const POLL_MS = 50;

// The CDP `Input.dispatchKeyEvent` modifier bits.
export const MOD = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 } as const;

// DOM `key` and `code`, the winuser.h virtual-key code, and the text of a key that types one.
const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", vk: 0x0d, text: "\r" },
  Escape: { key: "Escape", code: "Escape", vk: 0x1b },
  Tab: { key: "Tab", code: "Tab", vk: 0x09 },
  Delete: { key: "Delete", code: "Delete", vk: 0x2e },
  Home: { key: "Home", code: "Home", vk: 0x24 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 0x25 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 0x26 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 0x27 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 0x28 },
  F5: { key: "F5", code: "F5", vk: 0x74 },
  F6: { key: "F6", code: "F6", vk: 0x75 },
  F10: { key: "F10", code: "F10", vk: 0x79 },
  a: { key: "a", code: "KeyA", vk: 0x41 },
  s: { key: "s", code: "KeyS", vk: 0x53 },
};
const MODIFIER_KEYS = [
  { bit: MOD.Alt, key: "Alt", code: "AltLeft", vk: 0x12 },
  { bit: MOD.Ctrl, key: "Control", code: "ControlLeft", vk: 0x11 },
  { bit: MOD.Shift, key: "Shift", code: "ShiftLeft", vk: 0x10 },
];

// The parameters of one CDP `Input.dispatchKeyEvent` call.
export type KeyEvent = { type: "rawKeyDown" | "keyDown" | "keyUp"; key: string; code: string; windowsVirtualKeyCode: number; modifiers: number; commands?: string[]; text?: string; unmodifiedText?: string };

// One key press: each held modifier down, the key down and up, then each modifier up in reverse order.
// `commands` names the editing commands that the native key binding gives the key, as CDP needs them.
// `typed` sends a key with text and no modifier as `keyDown`, so Chromium also fires the activation of a focused button (Puppeteer `Keyboard.down`).
export function keyEvents(name: string, modifiers = 0, options: { commands?: string[]; typed?: boolean } = {}): KeyEvent[] {
  const k = KEYS[name];
  if (k === undefined) throw new Error(`no CDP key ${JSON.stringify(name)}`);
  const held = MODIFIER_KEYS.filter((m) => modifiers & m.bit);
  const typed = options.typed === true && k.text !== undefined && modifiers === 0;
  const event = (type: KeyEvent["type"], m: { key: string; code: string; vk: number }, bits: number): KeyEvent => ({ type, key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, modifiers: bits });
  return [
    ...held.map((m) => event("rawKeyDown", m, modifiers)),
    { ...event(typed ? "keyDown" : "rawKeyDown", k, modifiers), ...(options.commands ? { commands: options.commands } : {}), ...(typed ? { text: k.text, unmodifiedText: k.text } : {}) },
    event("keyUp", k, modifiers),
    ...held.toReversed().map((m) => event("keyUp", m, 0)),
  ];
}

// A free loopback TCP port at the moment of the call.
export function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

export interface Cdp {
  url: string;
  send(method: string, params?: object): Promise<Record<string, unknown>>;
  evaluate<T>(expression: string): Promise<T>;
  // The last value, whether `done` holds or the bound passes.
  poll<T>(expression: string, done: (value: T) => boolean, ms: number): Promise<T>;
  key(name: string, modifiers?: number, commands?: string[]): Promise<void>;
  // Calls `listener` with the `params` of each CDP event `method`. The result removes the listener.
  on(method: string, listener: (params: Record<string, unknown>) => void): () => void;
  close(): void;
}

export type IpcCall = { command: string; requestId: string };
export interface IpcLog {
  // The calls of `command` whose reply has fully arrived, in arrival order.
  finished(command: string): IpcCall[];
  // Waits until `count` calls of `command` have their reply, at most `ms`.
  wait(command: string, count: number, ms: number): Promise<IpcCall[]>;
  // The JSON reply of the call, as `invoke` resolves it.
  body<T>(call: IpcCall): Promise<T>;
  // The CDP `Network` request IDs of the calls of `command` that have no reply yet.
  pending(command: string): string[];
}

export interface IpcHold {
  // Continues each held call, then ends the hold.
  release(): Promise<void>;
}

// Holds each new call of `command` in the page network layer (CDP `Fetch` at the request stage).
// It returns when each call of `command` that `ipc` records in flight is held, and at least one call is held, at most `ms`.
// A call sent before `watchIpc` started is not in `ipc`, so the caller starts `watchIpc` before the calls it must see.
export async function holdIpc(c: Cdp, ipc: IpcLog, command: string, ms: number): Promise<IpcHold> {
  // `networkId` is the `Network` request ID of the held call.
  const held: { requestId: string; networkId: unknown }[] = [];
  let preflightError: unknown;
  // WebView2 also pauses the CORS preflight (method OPTIONS) and sends the POST only after the preflight continues.
  const off = c.on("Fetch.requestPaused", (p) => {
    if ((p.request as { method: string }).method === "OPTIONS") void c.send("Fetch.continueRequest", { requestId: p.requestId }).catch((error) => void (preflightError ??= error));
    else held.push({ requestId: p.requestId as string, networkId: p.networkId });
  });
  async function release(): Promise<void> {
    try {
      for (const h of held) await c.send("Fetch.continueRequest", { requestId: h.requestId });
      // Chromium `FetchHandler::Disable` drops the interceptor, and `InterceptionJob::Detach` continues each call still held.
      await c.send("Fetch.disable");
    } finally {
      off();
    }
  }
  await c.send("Fetch.enable", { patterns: [{ urlPattern: `${IPC_ORIGIN}/${command}*`, requestStage: "Request" }] });
  const free = () => ipc.pending(command).filter((id) => !held.some((h) => h.networkId === id));
  for (const end = performance.now() + ms; held.length === 0 || free().length > 0; await Bun.sleep(POLL_MS)) {
    if (performance.now() < end) continue;
    const state = `held ${held.length}, in flight and not held ${JSON.stringify(free())}`;
    await release();
    throw new Error(`the ${command} calls were not held within ${ms} ms: ${state}`, { cause: preflightError });
  }
  return { release };
}

// Records the IPC calls of the page from now on. `onFinished` runs when the reply of a call has fully arrived.
export async function watchIpc(c: Cdp, onFinished?: (call: IpcCall) => void): Promise<IpcLog> {
  const open = new Map<string, string>();
  const done: IpcCall[] = [];
  c.on("Network.requestWillBeSent", (p) => {
    const request = p.request as { url: string; method: string };
    // The cross-origin call first sends a CORS preflight (method OPTIONS). Only the POST carries the reply.
    if (request.method === "POST" && request.url.startsWith(`${IPC_ORIGIN}/`)) open.set(p.requestId as string, decodeURIComponent(new URL(request.url).pathname.slice(1)));
  });
  c.on("Network.loadingFailed", (p) => void open.delete(p.requestId as string));
  c.on("Network.loadingFinished", (p) => {
    const requestId = p.requestId as string;
    const command = open.get(requestId);
    if (command === undefined) return;
    open.delete(requestId);
    const call = { command, requestId };
    done.push(call);
    onFinished?.(call);
  });
  await c.send("Network.enable");
  const finished = (command: string) => done.filter((d) => d.command === command);
  return {
    finished,
    async wait(command, count, ms) {
      for (const end = performance.now() + ms; finished(command).length < count; await Bun.sleep(POLL_MS)) if (performance.now() >= end) throw new Error(`${count} ${command} replies did not arrive within ${ms} ms: ${finished(command).length}`);
      return finished(command);
    },
    async body<T>(call: IpcCall) {
      const r = (await c.send("Network.getResponseBody", { requestId: call.requestId })) as { body: string; base64Encoded: boolean };
      return JSON.parse(r.base64Encoded ? Buffer.from(r.body, "base64").toString("utf8") : r.body) as T;
    },
    pending: (command) => [...open].filter(([, c]) => c === command).map(([id]) => id),
  };
}

export async function connectPage(port: number, ms: number): Promise<Cdp> {
  let url: string | undefined;
  let socketUrl: string | undefined;
  for (const end = performance.now() + ms; socketUrl === undefined; await Bun.sleep(POLL_MS)) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(CALL_MS) })).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
      const page = list.find((t) => t.type === "page" && t.url.startsWith(`${PAGE_ORIGIN}/`));
      url = page?.url;
      socketUrl = page?.webSocketDebuggerUrl;
    } catch (error) {
      if (performance.now() >= end) throw new Error(`no CDP endpoint on port ${port} within ${ms} ms`, { cause: error });
    }
    if (socketUrl === undefined && performance.now() >= end) throw new Error(`no ${PAGE_ORIGIN} page target on port ${port} within ${ms} ms`);
  }
  const ws = new WebSocket(socketUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`the CDP socket ${socketUrl} did not open`));
  });
  let id = 0;
  const waiting = new Map<number, (reply: Record<string, unknown>) => void>();
  const listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  // A CDP event has `method` and no `id`.
  ws.onmessage = (message) => {
    const reply = JSON.parse(String(message.data)) as Record<string, unknown>;
    if (typeof reply.id === "number") waiting.get(reply.id)?.(reply);
    else if (typeof reply.method === "string") for (const listener of listeners.get(reply.method) ?? []) listener((reply.params ?? {}) as Record<string, unknown>);
  };
  function on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
    const set = listeners.get(method) ?? new Set();
    listeners.set(method, set.add(listener));
    return () => void set.delete(listener);
  }

  async function send(method: string, params: object = {}): Promise<Record<string, unknown>> {
    const n = ++id;
    let timer: Timer | undefined;
    try {
      const reply = await Promise.race([
        new Promise<Record<string, unknown>>((resolve) => {
          waiting.set(n, resolve);
          ws.send(JSON.stringify({ id: n, method, params }));
        }),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`CDP ${method} gave no reply within ${CALL_MS} ms`)), CALL_MS))),
      ]);
      if (reply.error !== undefined) throw new Error(`CDP ${method} failed: ${JSON.stringify(reply.error)}`);
      return reply.result as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
      waiting.delete(n);
    }
  }

  async function evaluate<T>(expression: string): Promise<T> {
    const result = (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as { result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
    if (result.exceptionDetails) throw new Error(`page exception: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value as T;
  }

  async function poll<T>(expression: string, done: (value: T) => boolean, ms: number): Promise<T> {
    for (const end = performance.now() + ms; ; await Bun.sleep(POLL_MS)) {
      const value = await evaluate<T>(expression);
      if (done(value) || performance.now() >= end) return value;
    }
  }

  async function key(name: string, modifiers = 0, commands?: string[]): Promise<void> {
    for (const params of keyEvents(name, modifiers, { commands })) await send("Input.dispatchKeyEvent", params);
  }

  return { url: url!, send, evaluate, poll, key, on, close: () => ws.close() };
}
