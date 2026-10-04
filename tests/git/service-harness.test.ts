// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { PIPE_FRAME_BYTES } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import { checkFrame } from "./service-harness";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);

// A `public` response frame whose JSON encoding has exactly `bytes` bytes. `unit` is one result character.
function frameOf(bytes: number, unit = "x") {
  const frame = { kind: "public", response: { requestId: crypto.randomUUID(), state: "succeeded", result: "" } };
  const rest = bytes - Buffer.byteLength(JSON.stringify(frame));
  const size = Buffer.byteLength(unit);
  frame.response.result = unit.repeat(Math.floor(rest / size)) + "x".repeat(rest % size);
  expect(Buffer.byteLength(JSON.stringify(frame))).toBe(bytes);
  return frame;
}

// T284: the harness writer runs this check on each frame that the service writes (contract §5 "Private/reply frame").
describe("harness frame check", () => {
  test("a frame of exactly 16 MiB passes", () => {
    expect(() => checkFrame(frameOf(PIPE_FRAME_BYTES))).not.toThrow();
  });

  test("a frame of 16 MiB plus one byte throws", () => {
    expect(() => checkFrame(frameOf(PIPE_FRAME_BYTES + 1))).toThrow(RangeError);
  });

  test("the check counts UTF-8 bytes, not UTF-16 units", () => {
    const frame = frameOf(PIPE_FRAME_BYTES + 2, "é");
    expect(JSON.stringify(frame).length).toBeLessThan(PIPE_FRAME_BYTES);
    expect(() => checkFrame(frame)).toThrow(RangeError);
  });
});
