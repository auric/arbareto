// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// A warm process poller: one PowerShell process lists the CIM `Win32_Process` records of one image name in a loop.
// A cold `powershellJson` probe needs 0.7 s to 1.4 s, so it can miss a Git process of about 1.4 s.

import { join } from "node:path";
import type { ProcessRecord } from "./installed-app";

// One CIM query. `time` is the system time as a FILETIME, taken after the query ends.
export interface Sample {
  time: bigint;
  records: ProcessRecord[];
}

export const parseSample = (line: string): Sample => {
  const s = JSON.parse(line) as { time: string; records: ProcessRecord[] };
  return { time: BigInt(s.time), records: s.records };
};

// A PID and its creation time name one process. A PID alone can name a later process.
const same = (a: ProcessRecord, b: ProcessRecord) => a.pid === b.pid && a.created !== null && a.created === b.created;

// Each process that `keep` accepts in a sample, once, in the order of the first sample that holds it.
export function seen(samples: Sample[], keep: (r: ProcessRecord, sample: Sample) => boolean): ProcessRecord[] {
  const found: ProcessRecord[] = [];
  for (const s of samples) for (const r of s.records) if (keep(r, s) && !found.some((f) => same(f, r))) found.push(r);
  return found;
}

// The time of the first sample after `after` that holds none of `procs`, or null when no such sample exists yet.
export const goneAt = (samples: Sample[], procs: ProcessRecord[], after: bigint): bigint | null =>
  samples.find((s) => s.time > after && !s.records.some((r) => procs.some((p) => same(p, r))))?.time ?? null;

export interface Poller {
  samples(): Sample[];
  // Waits until `pick` gives a value other than null, at most `ms`.
  until<T>(pick: (samples: Sample[]) => T | null, ms: number): Promise<T>;
  stop(): void;
}

const SLEEP_MS = 50;
const WAIT_POLL_MS = 10;

// The loop ends by itself after `lifetimeMs`, so a killed test leaves no poller behind.
export async function startPoller(imageName: string, lifetimeMs: number, readyMs: number): Promise<Poller> {
  if (!/^[\w.-]+$/.test(imageName)) throw new Error(`not an image name: ${JSON.stringify(imageName)}`);
  const root = process.env.SystemRoot;
  if (!root) throw new Error("SystemRoot is not set");
  const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$end = [DateTime]::UtcNow.AddMilliseconds(${lifetimeMs})
while ([DateTime]::UtcNow -lt $end) {
  $r = @(Get-CimInstance Win32_Process -Filter "Name='${imageName}'" | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; name = $_.Name; commandLine = $_.CommandLine; created = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc().ToString() } else { $null } } })
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ time = [DateTime]::UtcNow.ToFileTimeUtc().ToString(); records = $r })))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds ${SLEEP_MS}
}`;
  const proc = Bun.spawn([join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const samples: Sample[] = [];
  let failure: unknown;
  const reading = (async () => {
    let rest = "";
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      const lines = (rest + decoder.decode(chunk, { stream: true })).split(/\r?\n/);
      rest = lines.pop()!;
      for (const line of lines) if (line !== "") samples.push(parseSample(line));
    }
  })().catch((error) => void (failure ??= error));
  // Bun `Subprocess.kill` acts on the process handle that Bun holds, so it cannot reach a later process with the same PID.
  const stop = () => proc.kill();
  async function until<T>(pick: (samples: Sample[]) => T | null, ms: number): Promise<T> {
    for (const end = performance.now() + ms; ; await Bun.sleep(WAIT_POLL_MS)) {
      const value = pick(samples);
      if (value !== null) return value;
      if (failure !== undefined) throw new Error("the process poller output is not a sample", { cause: failure });
      if (proc.exitCode !== null) {
        await reading;
        throw new Error(`the process poller exited ${proc.exitCode}: ${await new Response(proc.stderr).text()}`);
      }
      if (performance.now() >= end) throw new Error(`the process poller gave no matching sample within ${ms} ms (${samples.length} samples)`);
    }
  }
  try {
    await until((s) => (s.length > 0 ? true : null), readyMs);
  } catch (error) {
    stop();
    throw error;
  }
  return { samples: () => samples, until, stop };
}
