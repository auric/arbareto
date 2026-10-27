// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T079: the CDP key events of `cdp.ts`, without a package. The fields are those of CDP `Input.dispatchKeyEvent`.
// The virtual-key codes are the winuser.h values: VK_SHIFT 0x10, VK_F5 0x74, VK_F10 0x79. The CDP modifier bit of Shift is 8.

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { connectPage, holdIpc, keyEvents, MOD, watchIpc } from "./cdp";

printOrigin("./cdp.ts", import.meta.dir);

describe("T079 cdp.ts key events", () => {
  test("F5 gives one rawKeyDown and one keyUp with virtual key 116", () => {
    expect(keyEvents("F5")).toEqual([
      { type: "rawKeyDown", key: "F5", code: "F5", windowsVirtualKeyCode: 116, modifiers: 0 },
      { type: "keyUp", key: "F5", code: "F5", windowsVirtualKeyCode: 116, modifiers: 0 },
    ]);
  });

  test("Shift+F10 holds Shift (modifier bit 8, virtual key 16) around F10 (virtual key 121), and the Shift up clears the bits", () => {
    expect(MOD.Shift).toBe(8);
    expect(keyEvents("F10", MOD.Shift)).toEqual([
      { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 },
      { type: "rawKeyDown", key: "F10", code: "F10", windowsVirtualKeyCode: 121, modifiers: 8 },
      { type: "keyUp", key: "F10", code: "F10", windowsVirtualKeyCode: 121, modifiers: 8 },
      { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0 },
    ]);
  });

  test("Ctrl+A carries its editing command on the key down only", () => {
    expect(keyEvents("a", MOD.Ctrl, { commands: ["selectAll"] }).map((e) => [e.type, e.key, e.commands])).toEqual([
      ["rawKeyDown", "Control", undefined],
      ["rawKeyDown", "a", ["selectAll"]],
      ["keyUp", "a", undefined],
      ["keyUp", "Control", undefined],
    ]);
  });

  test("a typed key with text and no modifier goes as keyDown with its text; with a modifier it stays rawKeyDown", () => {
    expect(keyEvents("Enter", 0, { typed: true })[0]).toEqual({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r", unmodifiedText: "\r" });
    expect(keyEvents("Enter")[0]).toEqual({ type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0 });
    expect(keyEvents("Enter", MOD.Ctrl, { typed: true })[1]).toEqual({ type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 2 });
  });

  test("a key outside the table throws", () => {
    expect(() => keyEvents("F11")).toThrow('no CDP key "F11"');
  });
});

// T085: a local double of the WebView2 CDP endpoint. Its events follow the CDP `Network` domain: a CORS preflight, then the POST of the IPC call.
describe("T085 cdp.ts events and the IPC record", () => {
  // A loaded parallel run can need more than the 5 s default to start the local CDP server and connect.
  test("events reach their subscribers, and watchIpc keeps only the finished POST calls to ipc.localhost with their JSON body", async () => {
    const reply = { state: "succeeded", result: { action: "delete" } };
    const event = (method: string, params: object) => JSON.stringify({ method, params });
    const request = (requestId: string, method: string, url: string) => event("Network.requestWillBeSent", { requestId, request: { method, url } });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (new URL(req.url).pathname === "/ws") return srv.upgrade(req) ? undefined : new Response("no upgrade", { status: 400 });
        return Response.json([{ type: "page", url: "http://tauri.localhost/", webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/ws` }]);
      },
      websocket: {
        message(ws, data) {
          const { id, method, params } = JSON.parse(String(data)) as { id: number; method: string; params: { requestId?: string } };
          if (method === "Network.getResponseBody") return void ws.send(JSON.stringify({ id, result: params.requestId === "2" ? { body: Buffer.from(JSON.stringify(reply)).toString("base64"), base64Encoded: true } : { body: "null", base64Encoded: false } }));
          ws.send(JSON.stringify({ id, result: {} }));
          if (method !== "Network.enable") return;
          for (const m of [
            request("1", "OPTIONS", "http://ipc.localhost/run_workbench"),
            event("Network.loadingFinished", { requestId: "1" }),
            request("2", "POST", "http://ipc.localhost/run_workbench"),
            request("3", "POST", "http://tauri.localhost/assets/a.js"),
            request("4", "POST", "http://ipc.localhost/read_workspace"),
            event("Network.loadingFailed", { requestId: "4" }),
            event("Network.loadingFinished", { requestId: "3" }),
            event("Network.loadingFinished", { requestId: "4" }),
            event("Network.loadingFinished", { requestId: "2" }),
          ])
            ws.send(m);
        },
      },
    });
    const c = await connectPage(server.port!, 5_000);
    try {
      const seen: unknown[] = [];
      const off = c.on("Network.loadingFinished", (p) => seen.push(p.requestId));
      const finished: string[] = [];
      const ipc = await watchIpc(c, (call) => finished.push(call.command));
      const calls = await ipc.wait("run_workbench", 1, 5_000);
      expect(calls).toEqual([{ command: "run_workbench", requestId: "2" }]);
      expect(seen).toEqual(["1", "3", "4", "2"]);
      expect({ finished, reads: ipc.finished("read_workspace") }).toEqual({ finished: ["run_workbench"], reads: [] });
      expect(await ipc.body(calls[0]!)).toEqual(reply);
      off();
      const again: unknown[] = [];
      c.on("Network.loadingFinished", (p) => again.push(p.requestId));
      await c.send("Network.enable");
      await ipc.wait("run_workbench", 2, 5_000);
      expect({ seen: seen.length, again }).toEqual({ seen: 4, again: ["1", "3", "4", "2"] });
      await expect(ipc.wait("read_workspace", 1, 200)).rejects.toThrow("1 read_workspace replies did not arrive within 200 ms: 0");
    } finally {
      c.close();
      server.stop(true);
    }
  }, 30_000);
});

// The double follows the CDP `Fetch` domain: `requestPaused` names the held call by `networkId`, and `continueRequest` lets its reply arrive.
describe("holdIpc", () => {
  // A loaded parallel run can need more than the 5 s default to start the local CDP server and connect.
  test("holdIpc returns only when every pending call of the command is held and one is held; release continues each held call, then disables Fetch", async () => {
    const event = (method: string, params: object) => JSON.stringify({ method, params });
    const sent = (requestId: string, method: string, command: string) => event("Network.requestWillBeSent", { requestId, request: { method, url: `http://ipc.localhost/${command}` } });
    const paused = (n: string) => event("Fetch.requestPaused", { requestId: `f${n}`, networkId: n, request: { method: "POST", url: "http://ipc.localhost/read_workspace" } });
    const calls: [string, unknown][] = [];
    let enables = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (new URL(req.url).pathname === "/ws") return srv.upgrade(req) ? undefined : new Response("no upgrade", { status: 400 });
        return Response.json([{ type: "page", url: "http://tauri.localhost/", webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/ws` }]);
      },
      websocket: {
        message(ws, data) {
          const { id, method, params } = JSON.parse(String(data)) as { id: number; method: string; params: { requestId?: string; patterns?: unknown } };
          calls.push([method, method === "Fetch.enable" ? params.patterns : params.requestId]);
          // Call 1 is in flight before the hold. Call 4 is another command. The events go before the reply, so they arrive before the call returns.
          const events: Record<string, string[]> = {
            "Network.enable": [sent("0", "OPTIONS", "read_workspace"), sent("1", "POST", "read_workspace")],
            "Fetch.enable": [[sent("2", "POST", "read_workspace"), paused("2")], [event("Network.loadingFinished", { requestId: "1" })], [sent("4", "POST", "read_refs"), sent("3", "POST", "read_workspace"), paused("3")]][enables] ?? [],
            "Fetch.continueRequest": [event("Network.loadingFinished", { requestId: params.requestId?.slice(1) })],
          };
          if (method === "Fetch.enable") enables++;
          for (const m of events[method] ?? []) ws.send(m);
          ws.send(JSON.stringify({ id, result: {} }));
        },
      },
    });
    const c = await connectPage(server.port!, 5_000);
    try {
      const ipc = await watchIpc(c);
      expect(ipc.pending("read_workspace")).toEqual(["1"]);
      // Call 2 is held, but call 1 still runs outside the hold.
      await expect(holdIpc(c, ipc, "read_workspace", 300)).rejects.toThrow('the read_workspace calls were not held within 300 ms: held 1, in flight and not held ["1"]');
      // No call is held.
      await expect(holdIpc(c, ipc, "read_workspace", 300)).rejects.toThrow("the read_workspace calls were not held within 300 ms: held 0, in flight and not held []");
      const hold = await holdIpc(c, ipc, "read_workspace", 5_000);
      expect({ pending: ipc.pending("read_workspace"), refs: ipc.pending("read_refs") }).toEqual({ pending: ["3"], refs: ["4"] });
      await hold.release();
      const pattern = [{ urlPattern: "http://ipc.localhost/read_workspace*", requestStage: "Request" }];
      expect(calls).toEqual([
        ["Network.enable", undefined],
        ["Fetch.enable", pattern],
        ["Fetch.continueRequest", "f2"],
        ["Fetch.disable", undefined],
        ["Fetch.enable", pattern],
        ["Fetch.disable", undefined],
        ["Fetch.enable", pattern],
        ["Fetch.continueRequest", "f3"],
        ["Fetch.disable", undefined],
      ]);
      expect(ipc.finished("read_workspace").map((call) => call.requestId)).toEqual(["2", "1", "3"]);
    } finally {
      c.close();
      server.stop(true);
    }
  }, 30_000);
});

// WebView2 pauses the CORS preflight (method OPTIONS) of a held call too, and sends the POST only after the preflight continues.
describe("holdIpc and the CORS preflight", () => {
  test("holdIpc continues a paused OPTIONS request at once and does not count it as held; the POST that follows is held", async () => {
    const event = (method: string, params: object) => JSON.stringify({ method, params });
    const sent = (n: string, method: string) => event("Network.requestWillBeSent", { requestId: n, request: { method, url: "http://ipc.localhost/read_workspace" } });
    const paused = (n: string, method: string) => event("Fetch.requestPaused", { requestId: `f${n}`, networkId: n, request: { method, url: "http://ipc.localhost/read_workspace" } });
    const calls: [string, unknown][] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (new URL(req.url).pathname === "/ws") return srv.upgrade(req) ? undefined : new Response("no upgrade", { status: 400 });
        return Response.json([{ type: "page", url: "http://tauri.localhost/", webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/ws` }]);
      },
      websocket: {
        message(ws, data) {
          const { id, method, params } = JSON.parse(String(data)) as { id: number; method: string; params: { requestId?: string } };
          calls.push([method, params.requestId]);
          const events: Record<string, string[]> = {
            "Fetch.enable": [sent("5", "OPTIONS"), paused("5", "OPTIONS")],
            "Fetch.continueRequest": params.requestId === "f5" ? [event("Network.loadingFinished", { requestId: "5" }), sent("6", "POST"), paused("6", "POST")] : [event("Network.loadingFinished", { requestId: "6" })],
          };
          ws.send(JSON.stringify({ id, result: {} }));
          for (const m of events[method] ?? []) ws.send(m);
        },
      },
    });
    const c = await connectPage(server.port!, 5_000);
    try {
      const ipc = await watchIpc(c);
      const hold = await holdIpc(c, ipc, "read_workspace", 5_000);
      expect(ipc.pending("read_workspace")).toEqual(["6"]);
      await hold.release();
      expect(calls).toEqual([
        ["Network.enable", undefined],
        ["Fetch.enable", undefined],
        ["Fetch.continueRequest", "f5"],
        ["Fetch.continueRequest", "f6"],
        ["Fetch.disable", undefined],
      ]);
      expect(ipc.finished("read_workspace").map((call) => call.requestId)).toEqual(["6"]);
    } finally {
      c.close();
      server.stop(true);
    }
  }, 30_000);
});
