// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { join } from "node:path";
import { createNativeRunner } from "./native-runner";
import { createSession } from "./session";
import { createFrameWriter, readFrames } from "./transport";

// Stdout carries only frames. No other code may write to it.
const writer = createFrameWriter(Bun.stdout.writer());
let failed = false;
const session = createSession({
  writer,
  runner: createNativeRunner(writer),
  fail: () => {
    failed = true;
  },
  // Feature 006 contract Δ7: the shell starts the service in the launch directory.
  dictionaryFolder: join(process.cwd(), "dictionaries"),
});

for await (const incoming of readFrames(Bun.stdin.stream())) {
  session.receive(incoming);
  if (failed) break;
}
await writer.flush();
process.exit(failed ? 1 : 0);
