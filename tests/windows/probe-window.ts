// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { join } from "node:path";
import type { Subprocess } from "bun";

export type Probe = Subprocess<"ignore", "pipe", "pipe">;

// Runs a PowerShell probe script and ends the probe by PID after the body.
export async function withProbe(script: string, body: (probe: Probe) => Promise<void>): Promise<void> {
  const shell = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const probe = Bun.spawn([shell, "-NoProfile", "-NonInteractive", "-Command", script], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  try {
    await body(probe);
  } finally {
    probe.kill();
    await probe.exited;
  }
}
