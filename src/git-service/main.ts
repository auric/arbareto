// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

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
});

for await (const incoming of readFrames(Bun.stdin.stream())) {
  session.receive(incoming);
  if (failed) break;
}
await writer.flush();
process.exit(failed ? 1 : 0);
