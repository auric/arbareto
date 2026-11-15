// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T079: the CDP key events of `cdp.ts`, without a package. The fields are those of CDP `Input.dispatchKeyEvent`.
// The virtual-key codes are the winuser.h values: VK_SHIFT 0x10, VK_F5 0x74, VK_F10 0x79. The CDP modifier bit of Shift is 8.

import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
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

  test("R gives virtual key 82 with the code KeyR, as feature 008 scopedAction matches it by keyCode", () => {
    expect(keyEvents("r", 0, { typed: true })).toEqual([
      { type: "rawKeyDown", key: "r", code: "KeyR", windowsVirtualKeyCode: 82, modifiers: 0 },
      { type: "keyUp", key: "r", code: "KeyR", windowsVirtualKeyCode: 82, modifiers: 0 },
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

// The page double of the hold probe. It runs the `Runtime.evaluate` expression with a recording `fetch` and gives the probe URL.
function probeUrl(expression: string): string {
  const seen: unknown[][] = [];
  new Function("fetch", expression)((...args: unknown[]) => (seen.push(args), Promise.resolve()));
  expect(seen).toEqual([[expect.stringMatching(/^http:\/\/ipc\.localhost\/__hold_probe\?\d+$/), { mode: "no-cors" }]]);
  return seen[0]![0] as string;
}
// Fetch pauses the probe GET.
const probePaused = (url: string, requestId = "fprobe") => JSON.stringify({ method: "Fetch.requestPaused", params: { requestId, networkId: "probe", request: { method: "GET", url } } });
// The `Runtime.evaluate` reply to the probe expression.
const evaluated = (id: number) => JSON.stringify({ id, result: { result: { type: "boolean", value: true } } });

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
          const { id, method, params } = JSON.parse(String(data)) as { id: number; method: string; params: { requestId?: string; patterns?: unknown; expression?: string } };
          calls.push([method, method === "Fetch.enable" ? params.patterns : params.requestId]);
          if (method === "Runtime.evaluate") return void [probePaused(probeUrl(params.expression!)), evaluated(id)].forEach((m) => ws.send(m));
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
      const pattern = [
        { urlPattern: "http://ipc.localhost/read_workspace*", requestStage: "Request" },
        { urlPattern: "http://ipc.localhost/__hold_probe*", requestStage: "Request" },
      ];
      const probe: [string, unknown][] = [
        ["Runtime.evaluate", undefined],
        ["Fetch.failRequest", "fprobe"],
      ];
      expect(calls).toEqual([
        ["Network.enable", undefined],
        ["Fetch.enable", pattern],
        ...probe,
        ["Fetch.continueRequest", "f2"],
        ["Fetch.disable", undefined],
        ["Fetch.enable", pattern],
        ...probe,
        ["Fetch.disable", undefined],
        ["Fetch.enable", pattern],
        ...probe,
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
          const { id, method, params } = JSON.parse(String(data)) as { id: number; method: string; params: { requestId?: string; expression?: string } };
          calls.push([method, params.requestId]);
          if (method === "Runtime.evaluate") return void [probePaused(probeUrl(params.expression!)), evaluated(id)].forEach((m) => ws.send(m));
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
      // The probe calls and the preflight continue can interleave.
      const probe = (m: string) => m === "Runtime.evaluate" || m === "Fetch.failRequest";
      expect(calls.filter(([m]) => probe(m))).toEqual([
        ["Runtime.evaluate", undefined],
        ["Fetch.failRequest", "fprobe"],
      ]);
      expect(calls.filter(([m]) => !probe(m))).toEqual([
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

// A call that goes out before the `Fetch.enable` reply can pass the hold.
describe("holdIpc start", () => {
  test("holdIpc runs start only after the Fetch.enable reply, and holds the call that start sends", async () => {
    const event = (method: string, params: object) => JSON.stringify({ method, params });
    const calls: string[] = [];
    let enabled = false;
    let socket: { send(m: string): unknown } | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (new URL(req.url).pathname === "/ws") return srv.upgrade(req) ? undefined : new Response("no upgrade", { status: 400 });
        return Response.json([{ type: "page", url: "http://tauri.localhost/", webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/ws` }]);
      },
      websocket: {
        message(ws, data) {
          socket = ws;
          const { id, method, params } = JSON.parse(String(data)) as { id: number; method: string; params: { expression?: string } };
          calls.push(method);
          const reply = () => ws.send(JSON.stringify({ id, result: {} }));
          if (method === "Runtime.evaluate") [probePaused(probeUrl(params.expression!)), evaluated(id)].forEach((m) => ws.send(m));
          else if (method === "Fetch.enable")
            setTimeout(() => {
              enabled = true;
              reply();
            }, 200);
          else {
            if (method === "Fetch.continueRequest") ws.send(event("Network.loadingFinished", { requestId: "7" }));
            reply();
          }
        },
      },
    });
    const c = await connectPage(server.port!, 5_000);
    try {
      const ipc = await watchIpc(c);
      const started: boolean[] = [];
      const hold = await holdIpc(c, ipc, "run_workbench", 5_000, async () => {
        started.push(enabled);
        socket!.send(event("Network.requestWillBeSent", { requestId: "7", request: { method: "POST", url: "http://ipc.localhost/run_workbench" } }));
        socket!.send(event("Fetch.requestPaused", { requestId: "f7", networkId: "7", request: { method: "POST", url: "http://ipc.localhost/run_workbench" } }));
      });
      expect({ started, pending: ipc.pending("run_workbench") }).toEqual({ started: [true], pending: ["7"] });
      await hold.release();
      expect(calls).toEqual(["Network.enable", "Fetch.enable", "Runtime.evaluate", "Fetch.failRequest", "Fetch.continueRequest", "Fetch.disable"]);
      expect(ipc.finished("run_workbench").map((call) => call.requestId)).toEqual(["7"]);
    } finally {
      c.close();
      server.stop(true);
    }
  }, 30_000);
});

// The `Fetch.enable` reply can come before the page intercepts. The hold opens only on a paused probe GET.
describe("holdIpc probe gate", () => {
  const event = (method: string, params: object) => JSON.stringify({ method, params });
  const sent = (n: string, method = "POST") => event("Network.requestWillBeSent", { requestId: n, request: { method, url: "http://ipc.localhost/run_workbench" } });
  const paused = (n: string, method = "POST") => event("Fetch.requestPaused", { requestId: `f${n}`, networkId: n, request: { method, url: "http://ipc.localhost/run_workbench" } });
  const probeRe = /^http:\/\/ipc\.localhost\/__hold_probe\?\d+$/;
  // A CDP endpoint double. `answer` gets each CDP call of the client.
  function serve(answer: (ws: ServerWebSocket<unknown>, id: number, method: string, params: { requestId?: string; expression?: string }) => void) {
    return Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (new URL(req.url).pathname === "/ws") return srv.upgrade(req) ? undefined : new Response("no upgrade", { status: 400 });
        return Response.json([{ type: "page", url: "http://tauri.localhost/", webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/ws` }]);
      },
      websocket: {
        message(ws, data) {
          const { id, method, params } = JSON.parse(String(data)) as { id: number; method: string; params: { requestId?: string; expression?: string } };
          answer(ws, id, method, params);
        },
      },
    });
  }

  test("holdIpc runs start only after the probe pause and the Fetch.failRequest reply of the probe", async () => {
    const calls: string[] = [];
    let probeSeen = false;
    let probeFailed = false;
    let socket: ServerWebSocket<unknown> | undefined;
    // The probe pause and the failRequest reply come late, so a start that does not wait sees neither.
    const server = serve((ws, id, method, params) => {
      socket = ws;
      calls.push(method);
      const reply = () => ws.send(JSON.stringify({ id, result: {} }));
      if (method === "Runtime.evaluate") {
        const url = probeUrl(params.expression!);
        ws.send(evaluated(id));
        setTimeout(() => {
          probeSeen = true;
          ws.send(probePaused(url));
        }, 200);
      } else if (method === "Fetch.failRequest")
        setTimeout(() => {
          probeFailed = true;
          reply();
        }, 200);
      else {
        if (method === "Fetch.continueRequest") ws.send(event("Network.loadingFinished", { requestId: "7" }));
        reply();
      }
    });
    const c = await connectPage(server.port!, 5_000);
    try {
      const ipc = await watchIpc(c);
      const started: boolean[][] = [];
      const hold = await holdIpc(c, ipc, "run_workbench", 5_000, async () => {
        started.push([probeSeen, probeFailed]);
        socket!.send(sent("7"));
        socket!.send(paused("7"));
      });
      expect({ started, probes: hold.probes, pending: ipc.pending("run_workbench") }).toEqual({ started: [[true, true]], probes: 1, pending: ["7"] });
      await hold.release();
      expect(calls).toEqual(["Network.enable", "Fetch.enable", "Runtime.evaluate", "Fetch.failRequest", "Fetch.continueRequest", "Fetch.disable"]);
    } finally {
      c.close();
      server.stop(true);
    }
  }, 30_000);

  test("a probe pause never counts as a held call: the hold returns only after the POST pauses", async () => {
    const calls: [string, unknown][] = [];
    let socket: ServerWebSocket<unknown> | undefined;
    const server = serve((ws, id, method, params) => {
      socket = ws;
      calls.push([method, params.requestId]);
      if (method === "Runtime.evaluate") return void [probePaused(probeUrl(params.expression!)), evaluated(id)].forEach((m) => ws.send(m));
      if (method === "Fetch.continueRequest") ws.send(event("Network.loadingFinished", { requestId: "8" }));
      ws.send(JSON.stringify({ id, result: {} }));
    });
    const c = await connectPage(server.port!, 5_000);
    try {
      const ipc = await watchIpc(c);
      // The POST goes out after start returns.
      const hold = await holdIpc(c, ipc, "run_workbench", 5_000, async () =>
        setTimeout(() => {
          socket!.send(sent("8"));
          socket!.send(paused("8"));
        }, 200),
      );
      expect({ pending: ipc.pending("run_workbench"), probes: hold.probes, paused: hold.paused }).toEqual({
        pending: ["8"],
        probes: 1,
        paused: [
          { method: "GET", url: expect.stringMatching(probeRe), networkId: "probe", requestId: "fprobe", probe: true },
          { method: "POST", url: "http://ipc.localhost/run_workbench", networkId: "8", requestId: "f8", probe: false },
        ],
      });
      await hold.release();
      expect(calls).toEqual([
        ["Network.enable", undefined],
        ["Fetch.enable", undefined],
        ["Runtime.evaluate", undefined],
        ["Fetch.failRequest", "fprobe"],
        ["Fetch.continueRequest", "f8"],
        ["Fetch.disable", undefined],
      ]);
    } finally {
      c.close();
      server.stop(true);
    }
  }, 30_000);

  test("a probe that does not pause leads to a new probe, and the pause of the second probe opens the hold; no pause within the bound ends the hold", async () => {
    const urls: string[] = [];
    const failed: unknown[] = [];
    let probes = 0;
    let socket: ServerWebSocket<unknown> | undefined;
    // Only the second probe after each Fetch.enable pauses.
    const server = serve((ws, id, method, params) => {
      socket = ws;
      if (method === "Fetch.enable") probes = 0;
      if (method === "Fetch.failRequest") failed.push(params.requestId);
      if (method === "Fetch.continueRequest") ws.send(event("Network.loadingFinished", { requestId: "9" }));
      if (method !== "Runtime.evaluate") return void ws.send(JSON.stringify({ id, result: {} }));
      const url = probeUrl(params.expression!);
      urls.push(url);
      ws.send(evaluated(id));
      if (++probes === 2) ws.send(probePaused(url, `f-${url}`));
    });
    const c = await connectPage(server.port!, 5_000);
    try {
      const ipc = await watchIpc(c);
      await expect(holdIpc(c, ipc, "run_workbench", 300)).rejects.toThrow("the run_workbench calls were not held within 300 ms: the hold probe never paused, probes sent 1, paused []");
      const started: number[] = [];
      const hold = await holdIpc(c, ipc, "run_workbench", 5_000, async () => {
        started.push(probes);
        socket!.send(sent("9"));
        socket!.send(paused("9"));
      });
      expect({ started, probes: hold.probes, urls: new Set(urls).size, failed }).toEqual({ started: [2], probes: 2, urls: 3, failed: [`f-${urls[2]}`] });
      await hold.release();
    } finally {
      c.close();
      server.stop(true);
    }
  }, 30_000);

  test("a miss names each paused request and the error of the preflight Fetch.continueRequest", async () => {
    let socket: ServerWebSocket<unknown> | undefined;
    const server = serve((ws, id, method, params) => {
      socket = ws;
      if (method === "Runtime.evaluate") return void [probePaused(probeUrl(params.expression!)), evaluated(id)].forEach((m) => ws.send(m));
      ws.send(JSON.stringify(method === "Fetch.continueRequest" ? { id, error: { code: -32000, message: "Invalid InterceptionId." } } : { id, result: {} }));
    });
    const c = await connectPage(server.port!, 5_000);
    try {
      const ipc = await watchIpc(c);
      // The preflight pauses, its continue fails, and the POST goes out without a pause.
      const error = await holdIpc(c, ipc, "run_workbench", 300, async () => {
        socket!.send(paused("10", "OPTIONS"));
        socket!.send(sent("11"));
      }).then(
        () => null,
        (e: Error) => e,
      );
      const [head, list] = error!.message.split(", paused ");
      expect(head).toBe('the run_workbench calls were not held within 300 ms: held 0, in flight and not held ["11"], probes sent 1');
      expect(JSON.parse(list!)).toEqual([
        { method: "GET", url: expect.stringMatching(probeRe), networkId: "probe", requestId: "fprobe", probe: true },
        { method: "OPTIONS", url: "http://ipc.localhost/run_workbench", networkId: "10", requestId: "f10", probe: false, error: 'Error: CDP Fetch.continueRequest failed: {"code":-32000,"message":"Invalid InterceptionId."}' },
      ]);
    } finally {
      c.close();
      server.stop(true);
    }
  }, 30_000);
});
