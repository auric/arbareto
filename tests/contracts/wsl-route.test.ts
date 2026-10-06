// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { ERROR_CODES, WSL_UNAVAILABLE_REASONS as ERROR_REASONS } from "../../src/contracts/errors";
import {
  buildWslRemedy,
  checkWslGit,
  isWindowsProgram,
  routeWslPath,
  WSL_MINIMUM_GIT_VERSION,
  WSL_UNAVAILABLE_REASONS,
  wslIdentityPath,
  wslUnitName,
  type WslDistroFacts,
} from "../../src/contracts/wsl-route";

printOrigin("../../src/contracts/errors.ts", import.meta.dir);
printOrigin("../../src/contracts/wsl-route.ts", import.meta.dir);

const BS = "\\";
const GUID = "{c6d24ae9-40f2-40bf-b35d-bf0b6ca4ea00}";
const OTHER_GUID = "{8f51b15e-5f05-4b6d-8d78-5765530f558a}";
const FACTS: WslDistroFacts = {
  listed: ["Ubuntu-24.04", "Ubuntu"],
  registry: [
    { name: "Ubuntu-24.04", guid: GUID, version: 2 },
    { name: "Ubuntu", guid: OTHER_GUID, version: 2 },
  ],
};
const unc = (prefix: string, ...segments: string[]) => [`${BS}${BS}${prefix}`, ...segments].join(BS);

// Each Linux path is the `wslpath -u` output of its UNC path on the reference distro (2026-10-04, Ubuntu 24.04).
// Research R13 P3: `wslpath -u` equals the string conversion.
const WSLPATH_U: [string, string][] = [
  [unc("wsl$", "Ubuntu-24.04", "home", "user", "r a$b \u00e9"), "/home/user/r a$b \u00e9"],
  [unc("wsl.localhost", "Ubuntu-24.04", "home", "user", "r"), "/home/user/r"],
  [unc("WSL.LOCALHOST", "Ubuntu-24.04", "home", "user", "r"), "/home/user/r"],
  [unc("WSL$", "ubuntu-24.04", "home", "user", "r"), "/home/user/r"],
  [unc("wsl.localhost", "Ubuntu-24.04"), "/"],
  [unc("wsl.localhost", "Ubuntu-24.04", ""), "/"],
  [`${unc("wsl.localhost", "Ubuntu-24.04", "home")}${BS}${BS}user`, "/home/user"],
  [`${unc("wsl.localhost", "Ubuntu-24.04", "home")}/user`, "/home/user"],
  [unc("wsl.localhost", "Ubuntu-24.04", "home", ".", "user", "..", "x"), "/home/x"],
];

describe("WSL route (T204, contract §11 Route)", () => {
  test("both prefixes in any letter case route to WSL, and the Linux path equals wslpath -u", () => {
    for (const [path, linux] of WSLPATH_U) {
      const route = routeWslPath(path, FACTS);
      expect(route).toMatchObject({ kind: "wsl", distro: "Ubuntu-24.04", guid: GUID, linuxPath: linux });
    }
  });

  test("both prefixes of one folder give one normalized identity with the listed distro spelling", () => {
    const identities = new Set(
      [
        unc("wsl$", "Ubuntu-24.04", "home", "user", "r"),
        unc("wsl.localhost", "Ubuntu-24.04", "home", "user", "r"),
        unc("WSL.LOCALHOST", "ubuntu-24.04", "home", "user", "r"),
        unc("Wsl$", "UBUNTU-24.04", "home", "user", "r"),
      ].map((path) => {
        const route = routeWslPath(path, FACTS);
        if (route.kind !== "wsl") throw new Error(`not routed: ${path}`);
        return route.identityPath;
      }),
    );
    expect([...identities]).toEqual([unc("wsl.localhost", "Ubuntu-24.04", "home", "user", "r")]);
    const root = routeWslPath(unc("wsl$", "Ubuntu-24.04", ""), FACTS);
    expect(root).toMatchObject({ kind: "wsl", identityPath: unc("wsl.localhost", "Ubuntu-24.04") });
  });

  test("a / after the distro segment also ends the segment", () => {
    expect(routeWslPath(`${BS}${BS}wsl$${BS}Ubuntu/home`, FACTS)).toEqual({ kind: "wsl", distro: "Ubuntu", guid: OTHER_GUID, identityPath: unc("wsl.localhost", "Ubuntu", "home"), linuxPath: "/home" });
    expect(routeWslPath(`${BS}${BS}wsl.localhost${BS}Ubuntu-24.04/home${BS}user/r`, FACTS)).toMatchObject({ kind: "wsl", distro: "Ubuntu-24.04", linuxPath: "/home/user/r" });
  });

  test("either separator in the two prefix positions routes to WSL", () => {
    const identityPath = unc("wsl.localhost", "Ubuntu-24.04", "home", "user", "r");
    for (const path of [
      "//wsl$/Ubuntu-24.04/home/user/r",
      `${BS}${BS}wsl.localhost/Ubuntu-24.04/home/user/r`,
      `/${BS}WSL$${BS}Ubuntu-24.04/home/user/r`,
      `${BS}/Wsl.Localhost/Ubuntu-24.04${BS}home${BS}user${BS}r`,
    ]) {
      expect(routeWslPath(path, FACTS)).toEqual({ kind: "wsl", distro: "Ubuntu-24.04", guid: GUID, identityPath, linuxPath: "/home/user/r" });
    }
  });

  test("an exact distro match wins, then one match that ignores letter case", () => {
    const facts: WslDistroFacts = {
      listed: ["ubuntu", "Ubuntu", "Debian"],
      registry: [
        { name: "ubuntu", guid: "{00000000-0000-4000-8000-000000000001}", version: 2 },
        { name: "Ubuntu", guid: "{00000000-0000-4000-8000-000000000002}", version: 2 },
        { name: "Debian", guid: "{00000000-0000-4000-8000-000000000003}", version: 2 },
      ],
    };
    expect(routeWslPath(unc("wsl$", "Ubuntu", "r"), facts)).toMatchObject({ kind: "wsl", distro: "Ubuntu", guid: "{00000000-0000-4000-8000-000000000002}" });
    expect(routeWslPath(unc("wsl$", "ubuntu", "r"), facts)).toMatchObject({ kind: "wsl", distro: "ubuntu", guid: "{00000000-0000-4000-8000-000000000001}" });
    expect(routeWslPath(unc("wsl$", "DEBIAN", "r"), facts)).toMatchObject({ kind: "wsl", distro: "Debian" });
    // Two matches that ignore letter case and no exact match.
    expect(routeWslPath(unc("wsl$", "UBUNTU", "r"), facts)).toEqual({ kind: "refused", code: "WSL_UNAVAILABLE", reason: "distro-missing", distro: "UBUNTU" });
  });

  test("no match, or a key without Version 2, gives WSL_UNAVAILABLE with its reason", () => {
    expect(routeWslPath(unc("wsl.localhost", "Fedora", "r"), FACTS)).toEqual({ kind: "refused", code: "WSL_UNAVAILABLE", reason: "distro-missing", distro: "Fedora" });
    const keyless: WslDistroFacts = { listed: ["Ubuntu"], registry: [] };
    expect(routeWslPath(unc("wsl$", "Ubuntu", "r"), keyless)).toEqual({ kind: "refused", code: "WSL_UNAVAILABLE", reason: "distro-missing", distro: "Ubuntu" });
    const wsl1: WslDistroFacts = { listed: ["Legacy"], registry: [{ name: "Legacy", guid: GUID, version: 1 }] };
    expect(routeWslPath(unc("wsl$", "Legacy", "r"), wsl1)).toEqual({ kind: "refused", code: "WSL_UNAVAILABLE", reason: "not-wsl2", distro: "Legacy" });
    // A key whose name differs in letter case is not the key of the listed name.
    const caseKey: WslDistroFacts = { listed: ["Ubuntu"], registry: [{ name: "ubuntu", guid: GUID, version: 2 }] };
    expect(routeWslPath(unc("wsl$", "Ubuntu", "r"), caseKey)).toEqual({ kind: "refused", code: "WSL_UNAVAILABLE", reason: "distro-missing", distro: "Ubuntu" });
  });

  test("a segment with a character in U+F000 to U+F0FF gives reason wsl-path", () => {
    for (const name of ["a\uF05Cb", "a\uF03Ab", "\uF000", "x\uF0FF"]) {
      expect(routeWslPath(unc("wsl.localhost", "Ubuntu-24.04", "home", name), FACTS)).toEqual({ kind: "refused", code: "UNSUPPORTED_REPOSITORY", reason: "wsl-path" });
    }
    expect(routeWslPath(unc("wsl.localhost", "Ubuntu-24.04", "home", "a\uEFFFb\uF100"), FACTS)).toMatchObject({ kind: "wsl" });
  });

  test("every other path stays a Windows path", () => {
    const windows = [
      "C:\\repo",
      "Z:\\home\\user\\r",
      "\\\\server\\share\\r",
      "\\\\wsl\\Ubuntu-24.04\\r",
      "\\\\wsl.localhostx\\Ubuntu-24.04\\r",
      "\\\\wsl$x\\Ubuntu-24.04\\r",
      "//wsl$x/Ubuntu-24.04/r",
      "//server/share/r",
      "\\\\?\\UNC\\wsl$\\Ubuntu-24.04\\r",
      "//?/UNC/wsl$/Ubuntu-24.04/r",
      "\\\\wsl$",
      "//wsl.localhost",
    ];
    for (const path of windows) expect(routeWslPath(path, FACTS)).toEqual({ kind: "windows" });
  });

  test("a Linux path converts back to its UNC identity", () => {
    const cases: [string, string][] = [
      ["/home/user/r a$b \u00e9", unc("wsl.localhost", "Ubuntu-24.04", "home", "user", "r a$b \u00e9")],
      ["/home/user/r/.git", unc("wsl.localhost", "Ubuntu-24.04", "home", "user", "r", ".git")],
      ["/", unc("wsl.localhost", "Ubuntu-24.04")],
      ["/mnt/c/Users", unc("wsl.localhost", "Ubuntu-24.04", "mnt", "c", "Users")],
    ];
    for (const [linux, identity] of cases) {
      expect(wslIdentityPath("Ubuntu-24.04", linux)).toBe(identity);
      const route = routeWslPath(identity, FACTS);
      expect(route).toMatchObject({ kind: "wsl", identityPath: identity, linuxPath: linux });
    }
    // `wslpath -w` maps these names into U+F000 to U+F0FF, which the route refuses (reference distro, 2026-10-04).
    for (const name of ["a\\b", "a:b", "a*b", "a?b", "a<b", "a>b", "a|b", 'a"b', "a\u0001b", "a\u001fb"]) {
      expect(wslIdentityPath("Ubuntu-24.04", `/home/${name}`)).toBeNull();
    }
    // A Linux name that already holds such a character cannot be told apart from a mapped name.
    expect(wslIdentityPath("Ubuntu-24.04", "/home/ab")).toBeNull();
    expect(wslIdentityPath("Ubuntu-24.04", "home/user")).toBeNull();
  });

  test("the unit name is arbareto-<operationId>-<n>.scope", () => {
    const operationId = "0f0f0f0f-0000-4000-8000-0000000000aa";
    expect(wslUnitName(operationId, 1)).toBe(`arbareto-${operationId}-1.scope`);
    expect(wslUnitName(operationId, 12)).toBe(`arbareto-${operationId}-12.scope`);
  });
});

describe("WSL_UNAVAILABLE (T204, contract §9)", () => {
  test("the code exists and carries exactly the seven reasons", () => {
    expect(ERROR_CODES).toContain("WSL_UNAVAILABLE");
    expect([...WSL_UNAVAILABLE_REASONS]).toEqual(["wsl-missing", "distro-missing", "not-wsl2", "no-user-manager", "no-setsid", "no-coreutils", "no-perl", "start-failed"]);
  });

  test("the reasons live in the contract error types (T210)", () => {
    expect(ERROR_REASONS).toBe(WSL_UNAVAILABLE_REASONS);
  });
});

describe("WSL remedy commands (T204, contract §11 Remedy commands)", () => {
  const WSL_EXE = "C:\\Windows\\System32\\wsl.exe";
  // Contract §4: PowerShell ends a single-quoted string at these five characters.
  const QUOTES = ["'", "\u2018", "\u2019", "\u201A", "\u201B"];
  const base = { wslExecutable: WSL_EXE, distro: "Ubuntu-24.04", gitPath: "/usr/local/bin/git", worktreeRoot: "/home/user/r" };

  test("the add, restore --staged, rm --cached, and hook forms", () => {
    const head = `& 'C:\\Windows\\System32\\wsl.exe' --distribution 'Ubuntu-24.04' --cd / --exec '/usr/local/bin/git'`;
    expect(buildWslRemedy("add", { ...base, path: "src/a b.txt" })).toEqual({ command: `${head} --literal-pathspecs -C '/home/user/r' add -- 'src/a b.txt'` });
    expect(buildWslRemedy("restore-staged", { ...base, path: "src/a.txt" })).toEqual({ command: `${head} --literal-pathspecs -C '/home/user/r' restore --staged -- 'src/a.txt'` });
    expect(buildWslRemedy("rm-cached", { ...base, path: "src/a.txt" })).toEqual({ command: `${head} --literal-pathspecs -C '/home/user/r' rm --cached -- 'src/a.txt'` });
    expect(buildWslRemedy("hook", base)).toEqual({ command: `${head} --no-lazy-fetch -C '/home/user/r' hook run --ignore-missing pre-commit` });
  });

  test("each form doubles all five PowerShell quote characters in every value", () => {
    for (const q of QUOTES) {
      const values = { wslExecutable: WSL_EXE, distro: `Ub${q}untu`, gitPath: `/opt/g${q}it/git`, worktreeRoot: `/home/user/r${q}x`, path: `src/a${q}b.txt` };
      const d = `${q}${q}`;
      const head = `& 'C:\\Windows\\System32\\wsl.exe' --distribution 'Ub${d}untu' --cd / --exec '/opt/g${d}it/git'`;
      expect(buildWslRemedy("add", values)).toEqual({ command: `${head} --literal-pathspecs -C '/home/user/r${d}x' add -- 'src/a${d}b.txt'` });
      expect(buildWslRemedy("restore-staged", values)).toEqual({ command: `${head} --literal-pathspecs -C '/home/user/r${d}x' restore --staged -- 'src/a${d}b.txt'` });
      expect(buildWslRemedy("rm-cached", values)).toEqual({ command: `${head} --literal-pathspecs -C '/home/user/r${d}x' rm --cached -- 'src/a${d}b.txt'` });
      expect(buildWslRemedy("hook", values)).toEqual({ command: `${head} --no-lazy-fetch -C '/home/user/r${d}x' hook run --ignore-missing pre-commit` });
    }
  });

  test("Linux values keep a trailing slash", () => {
    expect(buildWslRemedy("hook", { ...base, worktreeRoot: "/home/user/r/" }).command).toContain("-C '/home/user/r/' hook");
  });

  test("a value after --distribution with U+005C gives no command", () => {
    expect(buildWslRemedy("add", { ...base, path: "src/a\\b.txt" })).toMatchObject({ command: null });
    expect(buildWslRemedy("add", { ...base, gitPath: "/opt/g\\it" })).toMatchObject({ command: null });
    expect(buildWslRemedy("hook", { ...base, worktreeRoot: "/home/a\\b" })).toMatchObject({ command: null });
    expect(buildWslRemedy("hook", { ...base, distro: "Ub\\untu" })).toMatchObject({ command: null });
  });

  test("the §4 refusals hold for WSL values", () => {
    for (const bad of ['a"b', "a\u201Cb", "a\u0007b", "a\u0085b"]) {
      expect(buildWslRemedy("add", { ...base, path: bad })).toMatchObject({ command: null });
    }
    expect(buildWslRemedy("add", { ...base, path: new Uint8Array([0x61, 0xff, 0x62]) })).toMatchObject({ command: null });
  });
});

describe("WSL Git PPA remedy (T212, contract §11 Git per distro)", () => {
  const WSL_EXE = "C:\\Windows\\System32\\wsl.exe";
  const QUOTES = ["'", "\u2018", "\u2019", "\u201A", "\u201B"];
  // The command runs the distro as root with a fixed script literal.
  const SCRIPT = "'add-apt-repository -y ppa:git-core/ppa && apt-get update && apt-get install -y git'";
  const ppa = (distro: string) => buildWslRemedy("git-ppa", { wslExecutable: WSL_EXE, distro });

  test("the Git PPA form", () => {
    expect(ppa("Ubuntu-24.04")).toEqual({ command: `& 'C:\\Windows\\System32\\wsl.exe' --distribution 'Ubuntu-24.04' --user root --cd / --exec /bin/sh -c ${SCRIPT}` });
  });

  test("the Git PPA form doubles each PowerShell quote character in the distro name", () => {
    for (const q of QUOTES) {
      expect(ppa(`Ub${q}untu`)).toEqual({ command: `& 'C:\\Windows\\System32\\wsl.exe' --distribution 'Ub${q}${q}untu' --user root --cd / --exec /bin/sh -c ${SCRIPT}` });
    }
  });

  test("a distro name with U+005C or a §4 refused character gives no PPA command", () => {
    for (const bad of ["Ub\\untu", 'Ub"untu', "Ub\u0007untu"]) expect(ppa(bad)).toMatchObject({ command: null });
  });
});

describe("WSL Git version rule (T204, contract §11 Git per distro)", () => {
  const git = (versionText: string, path = "/usr/bin/git", mz = false) => checkWslGit({ path, mz, versionText });

  test("the floor is 2.55.0", () => {
    expect(WSL_MINIMUM_GIT_VERSION).toBe("2.55.0");
  });

  test("admits 2.55.0 and later", () => {
    expect(git("git version 2.55.0")).toEqual({ ok: true, version: "2.55.0" });
    expect(git("git version 2.55.1")).toEqual({ ok: true, version: "2.55.1" });
    expect(git("git version 3.0.0")).toEqual({ ok: true, version: "3.0.0" });
    expect(git("git version 2.100.0")).toEqual({ ok: true, version: "2.100.0" });
  });

  test("refuses 2.54.9 and 2.43.0 with reason version and both versions", () => {
    expect(git("git version 2.54.9")).toEqual({ ok: false, code: "GIT_UNSUPPORTED", reason: "version", detectedVersion: "2.54.9", minimumVersion: "2.55.0" });
    expect(git("git version 2.43.0")).toEqual({ ok: false, code: "GIT_UNSUPPORTED", reason: "version", detectedVersion: "2.43.0", minimumVersion: "2.55.0" });
  });

  test("an unparseable version gives reason version", () => {
    for (const text of ["", "git version", "git version two", "version 2.55.0", "git version 2.55"]) {
      expect(git(text)).toMatchObject({ ok: false, code: "GIT_UNSUPPORTED", reason: "version" });
    }
  });

  test("an unparseable version carries its raw text as the detected version", () => {
    const refused = { ok: false, code: "GIT_UNSUPPORTED", reason: "version", minimumVersion: "2.55.0" } as const;
    expect(git("git version two")).toEqual({ ...refused, detectedVersion: "two" });
    expect(git("git version 2.55")).toEqual({ ...refused, detectedVersion: "2.55" });
    expect(git("version 2.55.0")).toEqual({ ...refused, detectedVersion: "version 2.55.0" });
    expect(git("")).toEqual(refused);
  });

  // T212 review S5: the shell parses each part as an unsigned 64-bit number, so a larger part is an unparseable version.
  test("a version part above 2^64 - 1 gives reason version with its raw text", () => {
    for (const found of ["2.18446744073709551616.0", "18446744073709551616.0.0", "2.55.18446744073709551616"]) {
      expect(git(`git version ${found}`)).toEqual({ ok: false, code: "GIT_UNSUPPORTED", reason: "version", detectedVersion: found, minimumVersion: "2.55.0" });
    }
    expect(git("git version 2.18446744073709551615.0")).toEqual({ ok: true, version: "2.18446744073709551615.0" });
  });

  test("a .windows. version, a path under /mnt/, and a file that starts with MZ give reason windows-git", () => {
    expect(git("git version 2.55.0.windows.3")).toEqual({ ok: false, code: "GIT_UNSUPPORTED", reason: "windows-git" });
    expect(git("git version 2.56.0", "/mnt/c/Git/mingw64/bin/git.exe")).toEqual({ ok: false, code: "GIT_UNSUPPORTED", reason: "windows-git" });
    expect(git("git version 2.56.0", "/usr/bin/git", true)).toEqual({ ok: false, code: "GIT_UNSUPPORTED", reason: "windows-git" });
  });

  test("the same rule marks a helper program as a Windows program", () => {
    expect(isWindowsProgram("/mnt/c/Windows/system32/systemctl.exe", false)).toBe(true);
    expect(isWindowsProgram("/usr/bin/systemctl", true)).toBe(true);
    expect(isWindowsProgram("/usr/bin/systemctl", false)).toBe(false);
    expect(isWindowsProgram("/mnt", false)).toBe(false);
    expect(isWindowsProgram("/mntx/bin/setsid", false)).toBe(false);
  });
});
