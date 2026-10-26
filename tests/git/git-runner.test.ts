// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T233 (contract §6 "Process fields", §11 "Process launch"): the measured `wsl.exe` command line of a WSL Git process.
// The oracle is the argument array that the shell builds in `src-tauri/src/wsl.rs` `git_command` and `wrapped`.

import { describe, expect, test } from "bun:test";
import wslProcess from "../../src/contracts/wsl-process.json";
import { WINDOWS_COMMAND_LINE_UNITS } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import { commandLineUnits, exitKind, firstEnd, isDeadlineStop, settleSteps, wslCommandLineUnits, type EnvironmentPolicy, type GitExit, type WslLaunch } from "../../src/git-service/git-runner";
import { gitlinkPatchArgs } from "../../src/git-service/commands";
import { gitlinkBatches } from "../../src/git-service/submodule-review";

printOrigin("../../src/git-service/git-runner.ts", import.meta.dir);
printOrigin("../../src/git-service/submodule-review.ts", import.meta.dir);

const LAUNCH: WslLaunch = {
  wslExecutable: "C:\\Windows\\System32\\wsl.exe",
  distro: "Ubuntu-26.04",
  git: "/usr/bin/git",
  systemdRun: "/usr/bin/systemd-run",
  systemctl: "/usr/bin/systemctl",
  setsid: "/usr/bin/setsid",
  noexpand: true,
};
const OPERATION = "0b6f2f3e-5d43-4c47-9a39-2f1d4b0c1e77";
const ROOT = "/home/u/repo with space";

describe("wslCommandLineUnits (contract §6 \"Process fields\")", () => {
  // T378: the 7th wrapper argument `noexp` is `1` when the probe fact `noexpand` is 0, and empty otherwise.
  test("it measures the shell argument array with the widest unit number and the noexp argument", () => {
    const args = ["--no-lazy-fetch", "diff-files", "-p", "--", "a b", 'q"uote\\'];
    for (const [noexpand, noexp] of [[true, "1"], [false, ""]] as const) {
      const shell = [
        "--distribution", LAUNCH.distro, "--cd", "/", "--exec", "/bin/sh", "-c", wslProcess.wrapper.join("\n"), "sh",
        `arbareto-${OPERATION}-4294967295.scope`, "read", "", LAUNCH.systemdRun, LAUNCH.systemctl, LAUNCH.setsid, noexp, LAUNCH.git,
        "--no-lazy-fetch", "-C", ROOT, ...args.slice(1),
      ];
      const units = wslCommandLineUnits({ ...LAUNCH, noexpand }, OPERATION, "read", "", ROOT, args);
      expect({ noexpand, units }).toEqual({ noexpand, units: commandLineUnits(LAUNCH.wslExecutable, shell) });
      expect(units - commandLineUnits(LAUNCH.git, args)).toBeGreaterThan(wslProcess.wrapper.join("\n").length);
    }
  });

  test("the diff-files batches split under the measure, so a list that fits the Windows measure takes two WSL batches", () => {
    const wrapper = wslProcess.wrapper.join("\n").length;
    // Each path is long enough that the WSL overhead pushes the second half into a new batch.
    const paths = Array.from({ length: 4 }, (_, i) => `${i}`.padEnd(Math.floor((WINDOWS_COMMAND_LINE_UNITS - wrapper) / 4), "x"));
    const windows = gitlinkBatches(paths, (args) => commandLineUnits(LAUNCH.git, args));
    const wsl = gitlinkBatches(paths, (args) => wslCommandLineUnits(LAUNCH, OPERATION, "read", "", ROOT, args));
    expect({ windows: windows.length, wsl: wsl.length, all: wsl.flat() }).toEqual({ windows: 1, wsl: 2, all: paths });
    for (const batch of wsl) expect(wslCommandLineUnits(LAUNCH, OPERATION, "read", "", ROOT, gitlinkPatchArgs(batch))).toBeLessThanOrEqual(WINDOWS_COMMAND_LINE_UNITS);
  });
});

// T399, contract §5 "Deadline outcomes" and §6 "Process replies": a deadline closes the operation Job. Each sibling then ends with `exitCode` null and no `deadline`.
describe("exitKind (contract §6 \"Process replies\" and \"Byte caps\")", () => {
  const rows: [GitExit, EnvironmentPolicy, boolean, ReturnType<typeof exitKind>][] = [
    [{ exitCode: null, activeDescendants: null, deadline: "deadline" }, "read", false, "deadline"],
    [{ exitCode: 1, activeDescendants: 0, deadline: "inactivity" }, "network", false, "deadline"],
    [{ exitCode: null, activeDescendants: null, deadline: "ceiling", diagnosticLimit: true }, "mergetool", true, "deadline"],
    [{ exitCode: null, activeDescendants: null, diagnosticLimit: true }, "read", true, "diagnosticLimit"],
    [{ exitCode: 0, activeDescendants: 0 }, "read", false, "exited"],
    [{ exitCode: 1, activeDescendants: 0 }, "read", true, "exited"],
    [{ exitCode: null, activeDescendants: 0 }, "read", true, "stopped"],
    [{ exitCode: null, activeDescendants: 0 }, "probe", true, "stopped"],
    [{ exitCode: null, activeDescendants: 0 }, "search", true, "stopped"],
    [{ exitCode: null, activeDescendants: null }, "mutation", true, "jobClosed"],
    [{ exitCode: null, activeDescendants: null }, "read", false, "jobClosed"],
  ];
  test("it checks the deadline, the diagnostic limit, the exit code, and a stop at the bound, and then gives a Job close", () => {
    expect(rows.map(([exit, policy, limited]) => exitKind(exit, policy, { limited }))).toEqual(rows.map((row) => row[3]));
  });
});

describe("firstEnd and settleSteps (T399)", () => {
  const isDeadline = (end: unknown) => typeof end === "string" && end.startsWith("D");
  const isClosed = (end: unknown) => end === "C";

  test("firstEnd takes a deadline, then the first end that is no Job close in position order, then a Job close", () => {
    const rows: [(string | null | undefined)[], string | null][] = [
      [[], null],
      [[null, undefined], null],
      [["C", "X", "D1", "D2"], "D1"],
      [["C", "X", "Y"], "X"],
      [[null, "C", "C"], "C"],
      [[undefined, "Y"], "Y"],
    ];
    expect(rows.map(([ends]) => firstEnd(ends, isDeadline, isClosed))).toEqual(rows.map((row) => row[1]));
    expect(firstEnd(["C", "X"], isDeadline)).toBe("C");
  });

  test("isDeadlineStop is true only for the stop shape with `deadline`", () => {
    expect([{ stop: "deadline" }, { stop: "canceled" }, "deadline", null, undefined, {}].map(isDeadlineStop)).toEqual([true, false, false, false, false, false]);
  });

  const settle = (work: readonly Promise<unknown>[]) => settleSteps(work, isDeadline, isClosed).then((values) => ({ values }), (end: unknown) => ({ end }));

  test("settleSteps gives the values or throws the firstEnd rejection, and never turns an end into a success", async () => {
    const ok = (v: unknown) => Promise.resolve(v);
    const no = (v: unknown) => Promise.reject(v);
    expect(await settle([ok(1), ok("C")])).toEqual({ values: [1, "C"] });
    expect(await settle([no("C"), no("X"), no("D")])).toEqual({ end: "D" });
    expect(await settle([no("C"), ok(1), no("X")])).toEqual({ end: "X" });
    expect(await settle([no("C"), ok(1)])).toEqual({ end: "C" });
    expect(await settle([ok(1), no(undefined)])).toStrictEqual({ end: undefined });
  });

  test("settleSteps waits for a pending sibling before it throws", async () => {
    const sibling = Promise.withResolvers<number>();
    let done = false;
    const run = settle([Promise.reject("X"), sibling.promise]).finally(() => void (done = true));
    await Bun.sleep(5);
    expect(done).toBe(false);
    sibling.resolve(1);
    expect(await run).toEqual({ end: "X" });
  });
});
