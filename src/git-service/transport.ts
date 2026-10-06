// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { PIPE_FRAME_BYTES } from "../contracts/limits";

// Contract §1: four-byte unsigned little-endian length, then UTF-8 JSON with a top-level `kind`.

export const FRAME_KINDS = ["public", "process", "mutation", "trust", "handshake"] as const;
export type FrameKind = (typeof FRAME_KINDS)[number];
export type Frame = { kind: FrameKind } & Record<string, unknown>;

export function isFrameKind(value: unknown): value is FrameKind {
  return typeof value === "string" && (FRAME_KINDS as readonly string[]).includes(value);
}

// `oversize`: the length header was above the frame bound. The reader discards that many body bytes and stores none.
export type Incoming = { type: "frame"; body: Uint8Array } | { type: "oversize" };

export async function* readFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<Incoming> {
  const reader = stream.getReader();
  const header = new Uint8Array(4);
  const headerView = new DataView(header.buffer);
  let headerFill = 0;
  let body: Uint8Array | null = null;
  let bodyFill = 0;
  let discard = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      let at = 0;
      while (at < value.length) {
        if (discard > 0) {
          const n = Math.min(discard, value.length - at);
          discard -= n;
          at += n;
          continue;
        }
        if (body) {
          const n = Math.min(body.length - bodyFill, value.length - at);
          body.set(value.subarray(at, at + n), bodyFill);
          bodyFill += n;
          at += n;
          if (bodyFill === body.length) {
            const complete = body;
            body = null;
            yield { type: "frame", body: complete };
          }
          continue;
        }
        header[headerFill++] = value[at++];
        if (headerFill < 4) continue;
        headerFill = 0;
        const length = headerView.getUint32(0, true);
        if (length > PIPE_FRAME_BYTES) {
          discard = length;
          yield { type: "oversize" };
        } else if (length === 0) {
          yield { type: "frame", body: new Uint8Array(0) };
        } else {
          body = new Uint8Array(length);
          bodyFill = 0;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const encoder = new TextEncoder();

// `encodeFrame` throws it for a body above the frame bound. Contract §2 turns such a response into `failed` with OUTPUT_LIMIT.
export class FrameBoundError extends RangeError {}

export function encodeFrame(frame: Frame): Uint8Array {
  if (!isFrameKind(frame.kind)) throw new TypeError("frame kind refused");
  const body = encoder.encode(JSON.stringify(frame));
  if (body.length > PIPE_FRAME_BYTES) throw new FrameBoundError("frame above the pipe frame bound");
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, true);
  out.set(body, 4);
  return out;
}

export interface FrameSink {
  write(bytes: Uint8Array): unknown;
  flush(): unknown;
}

export function createFrameWriter(sink: FrameSink) {
  return {
    write(frame: Frame): void {
      sink.write(encodeFrame(frame));
      void Promise.resolve(sink.flush());
    },
    async flush(): Promise<void> {
      await sink.flush();
    },
  };
}

export type FrameWriter = ReturnType<typeof createFrameWriter>;
