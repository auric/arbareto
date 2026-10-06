// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PIPE_FRAME_BYTES } from "../../src/contracts/limits";
import type { Frame } from "../../src/git-service/transport";
import { printOrigin } from "../origin";
import { useFixtureRoot } from "./fixture-root";
import { buildF02 } from "./fixtures";
import { GIT } from "./git-binary";
import { caseTest, checkFrame, openService, type WorkspaceResult } from "./service-harness";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/git-service/session.ts", import.meta.dir);
printOrigin("../../src/git-service/operations.ts", import.meta.dir);

useFixtureRoot();

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

// T089, contract §2: a response that the writer refuses at the frame bound becomes a terminal `failed` response with OUTPUT_LIMIT.
describe("frame bound (contract §2)", () => {
  caseTest(
    "T089",
    "a readWorkspace response above the frame bound ends failed with OUTPUT_LIMIT, and getOperation reports the same state",
    ["shell-double"],
    async () => {
      if (GIT === null) throw new Error("Git executable absent");
      let target: string | null = null;
      const refuse = (frame: Frame) => {
        const response = frame.response as { requestId?: unknown; result?: unknown } | undefined;
        return frame.kind === "public" && response?.requestId === target && response.result !== undefined;
      };
      const service = await openService({ git: GIT, name: "t089-frame-bound", refuseFrame: refuse });
      try {
        const repo = join(buildF02(GIT, "t089-frame-bound").root, "repo");
        const { repositoryId, generation } = await service.register(repo);
        target = service.send("readWorkspace", { refresh: false, check: "full" }, { repositoryId, repositoryGeneration: generation });
        const operationId = await service.operationId(target);
        const response = await service.response<WorkspaceResult>(target, 20_000);
        expect(service.refused).toHaveLength(1);
        expect(response).toEqual({ requestId: target, operationId, state: "failed", code: "OUTPUT_LIMIT", repositoryGeneration: generation });
        expect(service.responses.filter((r) => r.requestId === target)).toHaveLength(1);
        expect(service.runner.frames).toContainEqual({ type: "closeJob", operationId });
        expect(service.log()).toContainEqual(expect.objectContaining({ kind: "readWorkspace", operationId, code: "OUTPUT_LIMIT" }));
        const view = await service.getOperation(operationId);
        expect(view.result).toMatchObject({ operationId, state: "failed", code: "OUTPUT_LIMIT" });
      } finally {
        await service.dispose();
      }
    },
    60_000,
  );
});
