// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Bridge doubles check each call against the renderer envelope (contract §2). The argument layout follows `createBridge`.

import { z } from "zod";
import { RendererEnvelope, validateRequest } from "../../src/contracts/envelope";

/** A fixed contract §2 identifier for fixture number `n`. */
export const fixtureId = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const SESSION = fixtureId(0xffff);
const FIXED = new Set(["version", "sessionId", "requestId", "operation", "payload"]);
const shapes = new Map(RendererEnvelope.options.map((option) => [option.shape.operation.value as string, option.shape as Record<string, z.ZodType>]));

/** Throws when the envelope that `createBridge` builds for `operation(...args)` fails `validateRequest(…, "renderer")`. */
export function checkBridgeCall(operation: string, args: unknown[]): void {
  const shape = shapes.get(operation);
  if (shape === undefined) throw new Error(`bridge double: no contract operation "${operation}"`);
  const hasTarget = Object.keys(shape).some((key) => !FIXED.has(key));
  const payloadSchema = shape.payload;
  const hasPayload = !(payloadSchema instanceof z.ZodObject && Object.keys(payloadSchema.shape).length === 0);
  const target = hasTarget ? args[0] : {};
  const payload = hasPayload ? args[hasTarget ? 1 : 0] : {};
  const fields = operation === "currentSession" ? { payload } : { sessionId: SESSION, ...(target as object), payload };
  // The bridge sends JSON bytes. A round trip drops `undefined` fields as the wire does.
  const request = JSON.parse(JSON.stringify({ version: 1, ...fields, requestId: crypto.randomUUID(), operation }));
  const checked = validateRequest(request, "renderer");
  if (!checked.ok) throw new Error(`bridge double: ${operation} request fails the contract with ${checked.code}: ${JSON.stringify(request)}`);
}

/** Wraps a bridge double. Each method call runs `checkBridgeCall` first. */
export function contractChecked<T extends object>(bridge: T): T {
  return new Proxy(bridge, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver);
      if (typeof value !== "function" || typeof name !== "string") return value;
      return (...args: unknown[]) => {
        checkBridgeCall(name, args);
        return value.apply(target, args);
      };
    },
  });
}
