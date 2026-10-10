// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T233 (contract §6 "Process fields", §11 "Process launch"): the measured `wsl.exe` command line of a WSL Git process.
// The oracle is the argument array that the shell builds in `src-tauri/src/wsl.rs` `git_command` and `wrapped`.

import { describe, expect, test } from "bun:test";
import wslProcess from "../../src/contracts/wsl-process.json";
import { WINDOWS_COMMAND_LINE_UNITS } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import { commandLineUnits, wslCommandLineUnits, type WslLaunch } from "../../src/git-service/git-runner";
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
};
const OPERATION = "0b6f2f3e-5d43-4c47-9a39-2f1d4b0c1e77";
const ROOT = "/home/u/repo with space";

describe("wslCommandLineUnits (contract §6 \"Process fields\")", () => {
  test("it measures the shell argument array with the widest unit number", () => {
    const args = ["--no-lazy-fetch", "diff-files", "-p", "--", "a b", 'q"uote\\'];
    const shell = [
      "--distribution", LAUNCH.distro, "--cd", "/", "--exec", "/bin/sh", "-c", wslProcess.wrapper.join("\n"), "sh",
      `arbareto-${OPERATION}-4294967295.scope`, "read", "", LAUNCH.systemdRun, LAUNCH.systemctl, LAUNCH.setsid, LAUNCH.git,
      "--no-lazy-fetch", "-C", ROOT, ...args.slice(1),
    ];
    const units = wslCommandLineUnits(LAUNCH, OPERATION, "read", "", ROOT, args);
    expect(units).toBe(commandLineUnits(LAUNCH.wslExecutable, shell));
    expect(units - commandLineUnits(LAUNCH.git, args)).toBeGreaterThan(wslProcess.wrapper.join("\n").length);
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
