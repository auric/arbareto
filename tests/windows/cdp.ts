// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// A small Chrome DevTools Protocol client for the WebView2 page of the installed app. It sends no OS input.
// WebView2 opens the CDP endpoint only with `--remote-debugging-port` in WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS.

// Tauri 2 on Windows serves the frontend from this origin when `useHttpsScheme` is false (src-tauri/tauri.conf.json sets no value).
const PAGE_ORIGIN = "http://tauri.localhost";
const CALL_MS = 10_000;
const POLL_MS = 50;

// The CDP `Input.dispatchKeyEvent` modifier bits.
export const MOD = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 } as const;

// DOM `key` and `code`, and the winuser.h virtual-key code.
const KEYS: Record<string, { key: string; code: string; vk: number }> = {
  Enter: { key: "Enter", code: "Enter", vk: 0x0d },
  Escape: { key: "Escape", code: "Escape", vk: 0x1b },
  Home: { key: "Home", code: "Home", vk: 0x24 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 0x26 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 0x28 },
  F6: { key: "F6", code: "F6", vk: 0x75 },
  a: { key: "a", code: "KeyA", vk: 0x41 },
};
const MODIFIER_KEYS = [
  { bit: MOD.Alt, key: "Alt", code: "AltLeft", vk: 0x12 },
  { bit: MOD.Ctrl, key: "Control", code: "ControlLeft", vk: 0x11 },
];

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
  close(): void;
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
  ws.onmessage = (message) => {
    const reply = JSON.parse(String(message.data)) as Record<string, unknown>;
    if (typeof reply.id === "number") waiting.get(reply.id)?.(reply);
  };

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

  // `commands` names the editing commands that the native key binding gives the key, as CDP needs them (CDP `Input.dispatchKeyEvent`).
  async function key(name: string, modifiers = 0, commands?: string[]): Promise<void> {
    const k = KEYS[name];
    if (k === undefined) throw new Error(`no CDP key ${JSON.stringify(name)}`);
    const held = MODIFIER_KEYS.filter((m) => modifiers & m.bit);
    for (const m of held) await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, modifiers });
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers, ...(commands ? { commands } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers });
    for (const m of held.toReversed()) await send("Input.dispatchKeyEvent", { type: "keyUp", key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, modifiers: 0 });
  }

  return { url: url!, send, evaluate, poll, key, close: () => ws.close() };
}
