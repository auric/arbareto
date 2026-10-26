// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The sample parser and the seen and gone decisions of `process-poller.ts`, from recorded sample lines. The last case runs the poller against a real Git process.

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { GIT } from "../git/git-binary";
import { goneAt, parseSample, seen, startPoller } from "./process-poller";

printOrigin("./process-poller.ts", import.meta.dir);

// Recorded with the poller script: PID 100 is the app service, PID 200 runs a blame, PID 300 is another Git command.
const LINES = [
  `{"time":"134000000000000000","records":[]}`,
  `{"time":"134000000001000000","records":[{"pid":200,"parent":100,"name":"git.exe","commandLine":"git.exe -c core.quotepath=false blame --incremental -- big.txt","created":"134000000000500000"},{"pid":300,"parent":100,"name":"git.exe","commandLine":"git.exe status","created":"134000000000600000"}]}`,
  `{"time":"134000000002000000","records":[{"pid":200,"parent":100,"name":"git.exe","commandLine":"git.exe -c core.quotepath=false blame --incremental -- big.txt","created":"134000000000500000"}]}`,
  // PID 200 names a later process here: its creation time differs.
  `{"time":"134000000003000000","records":[{"pid":200,"parent":100,"name":"git.exe","commandLine":"git.exe -c core.quotepath=false blame --incremental -- big.txt","created":"134000000002500000"}]}`,
];
const samples = LINES.map(parseSample);
const blame = (r: { commandLine: string | null }) => / blame /.test(r.commandLine ?? "");

describe("process-poller decisions", () => {
  test("parseSample reads the FILETIME as a bigint and keeps each record", () => {
    expect(samples.map((s) => [s.time, s.records.length])).toEqual([
      [134000000000000000n, 0],
      [134000000001000000n, 2],
      [134000000002000000n, 1],
      [134000000003000000n, 1],
    ]);
    expect(() => parseSample("Get-CimInstance : Access denied")).toThrow();
  });

  test("seen gives each process once by PID and creation time, in the order of its first sample", () => {
    expect(seen(samples, blame).map((r) => [r.pid, r.created])).toEqual([
      [200, "134000000000500000"],
      [200, "134000000002500000"],
    ]);
    expect(seen(samples.slice(0, 1), blame)).toEqual([]);
  });

  test("goneAt gives the first sample after the time that holds none of the processes; a reused PID does not count as the same process", () => {
    const first = seen(samples, blame).slice(0, 1);
    expect(goneAt(samples, first, 134000000001500000n)).toBe(134000000003000000n);
    expect(goneAt(samples, seen(samples, blame), 134000000001500000n)).toBeNull();
    expect(goneAt(samples.slice(0, 3), first, 134000000001500000n)).toBeNull();
  });
});

describe.skipIf(process.platform !== "win32" || GIT === null)("process-poller against Git", () => {
  test("the poller sees a waiting Git process and then sees it gone after the kill", async () => {
    const poller = await startPoller("git.exe", 60_000, 30_000);
    // `git hash-object --stdin` waits for the end of its input, so it runs until the kill.
    const git = Bun.spawn([GIT!, "hash-object", "--stdin"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    try {
      const mine = await poller.until((s) => {
        const found = seen(s, (r) => r.pid === git.pid && / hash-object --stdin/.test(r.commandLine ?? ""));
        return found.length > 0 ? found : null;
      }, 10_000);
      const before = mine.length;
      git.kill();
      await git.exited;
      const at = poller.samples().at(-1)!.time;
      expect(await poller.until((s) => goneAt(s, mine, at), 10_000)).toBeGreaterThan(at);
      expect(before).toBe(1);
    } finally {
      git.kill();
      poller.stop();
    }
  }, 60_000);
});
