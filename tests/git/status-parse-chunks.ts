// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { ObjectFormat } from "../../src/git-service/commands";
import { createStatusParser, type StatusParseResult } from "../../src/git-service/status-parser";

// Pushes the listing in chunks of `size` bytes, then ends the input.
export function parseChunks(listing: Uint8Array, size: number, objectFormat: ObjectFormat = "sha1"): StatusParseResult {
  const parser = createStatusParser(objectFormat);
  for (let at = 0; at < listing.length; at += size) parser.push(listing.subarray(at, Math.min(at + size, listing.length)));
  return parser.end();
}
