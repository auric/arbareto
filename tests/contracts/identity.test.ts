// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T212 (gaps.md W2): the canonical WSL identity form, the identity union of records and markers, and the `no-perl` reason.

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { IdentityReply, Marker, PhysicalIdentity, TrustRecord, WslIdentity } from "../../src/contracts/channel";
import { WSL_UNAVAILABLE_REASONS } from "../../src/contracts/errors";
import { isWindows } from "../../src/contracts/native-path";
import wslProcess from "../../src/contracts/wsl-process.json";
import { worktreeKey } from "../../src/git-service/registration";

printOrigin("../../src/contracts/channel.ts", import.meta.dir);
printOrigin("../../src/contracts/errors.ts", import.meta.dir);
printOrigin("../../src/contracts/wsl-process.json", import.meta.dir);

const GUID = "{c6d24ae9-40f2-40bf-b35d-bf0b6ca4ea00}";
const OTHER_GUID = "{8f51b15e-5f05-4b6d-8d78-5765530f558a}";
const WSL = { distroGuid: GUID, fileSystemId: "fedc9aa3bd65bc57", inode: "2" };
const WINDOWS = { volumeSerial: "0123456789abcdef", fileId: "0123456789abcdef0123456789abcdef" };
const fits = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) => schema.safeParse(value).success;

describe("WSL identity form (gaps.md W2)", () => {
  test("the canonical form fits WslIdentity, PhysicalIdentity, and IdentityReply", () => {
    for (const identity of [WSL, { ...WSL, fileSystemId: "1", inode: "18446744073709551615" }]) {
      expect(fits(WslIdentity, identity)).toBe(true);
      expect(fits(PhysicalIdentity, identity)).toBe(true);
      expect(fits(IdentityReply, identity)).toBe(true);
    }
    expect(fits(PhysicalIdentity, WINDOWS)).toBe(true);
  });

  test("any other text is a failed probe", () => {
    const refused = [
      { ...WSL, distroGuid: GUID.toUpperCase() },
      { ...WSL, distroGuid: GUID.slice(1, -1) },
      { ...WSL, fileSystemId: "0fedc9aa3bd65bc57" },
      { ...WSL, fileSystemId: "0" },
      { ...WSL, fileSystemId: "fedc9aa3bd65bc57a" },
      { ...WSL, inode: "0" },
      { ...WSL, inode: "018" },
      { ...WSL, inode: "18446744073709551616" },
      { ...WSL, fileSystemType: "ef53" },
    ];
    for (const identity of refused) {
      expect(fits(WslIdentity, identity)).toBe(false);
      expect(fits(IdentityReply, identity)).toBe(false);
    }
  });

  test("a WSL refusal can carry absent, no-fs-uuid, or mixed-location", () => {
    for (const reason of ["absent", "no-fs-uuid", "mixed-location"]) expect(fits(IdentityReply, { code: "UNSUPPORTED_REPOSITORY", reason })).toBe(true);
    expect(fits(IdentityReply, { code: "UNSUPPORTED_REPOSITORY", reason: "wsl-path" })).toBe(false);
  });
});

describe("records and markers hold one identity form (gaps.md W2)", () => {
  const record = (common: object, worktree: object[]) => ({
    commonDirectory: isWindows ? "C:\\repo\\.git" : "/repo/.git",
    commonIdentity: common,
    worktreeRoot: isWindows ? "C:\\repo" : "/repo",
    gitDirectory: isWindows ? "C:\\repo\\.git" : "/repo/.git",
    worktreeIdentity: worktree,
    configurationFingerprint: "a".repeat(64),
    approvedAt: "2026-10-06T08:00:00Z",
    gitSelectedPath: isWindows ? "C:\\Git\\cmd\\git.exe" : "/usr/bin/git",
  });
  const other = { ...WSL, inode: "3" };

  test("a Windows record and a WSL record of one distro fit", () => {
    expect(fits(TrustRecord, record(WINDOWS, [WINDOWS, WINDOWS]))).toBe(true);
    expect(fits(TrustRecord, record(WSL, [WSL, other]))).toBe(true);
  });

  test("a record with mixed forms or two distro GUIDs is refused", () => {
    expect(fits(TrustRecord, record(WSL, [WINDOWS, WSL]))).toBe(false);
    expect(fits(TrustRecord, record(WINDOWS, [WSL, WSL]))).toBe(false);
    expect(fits(TrustRecord, record(WSL, [WSL, { ...WSL, distroGuid: OTHER_GUID }]))).toBe(false);
  });

  test("a marker holds a Windows or a WSL common identity", () => {
    const marker = (commonIdentity: object) => ({
      markerId: "0f0f0f0f-0000-4000-8000-000000000001",
      kind: "commit",
      startedAt: "2026-10-06T08:00:00Z",
      worktreeRoot: isWindows ? "C:\\repo" : "/repo",
      commonDirectory: isWindows ? "C:\\repo\\.git" : "/repo/.git",
      commonIdentity,
    });
    expect(fits(Marker, marker(WINDOWS))).toBe(true);
    expect(fits(Marker, marker(WSL))).toBe(true);
    expect(fits(Marker, marker({ ...WSL, fileSystemType: "ef53" }))).toBe(false);
  });
});

describe("WSL worktree key (gaps.md W2)", () => {
  test("worktreeKey is the SHA-256 of the UTF-8 text <distroGuid>:<fileSystemId>:<inode>", () => {
    expect(worktreeKey(WSL)).toBe("d35b7df970a300771b81b46358abc1283b4307e394398f6097f740d0b6c495f6");
  });
});

describe("Perl requirement (gaps.md W3 and W4)", () => {
  test("WSL_UNAVAILABLE has the reason no-perl", () => {
    expect(WSL_UNAVAILABLE_REASONS).toContain("no-perl");
  });

  test("wsl-process.json holds the fileFacts and identity texts, and the probe takes the context path and resolves /usr/bin/perl", () => {
    expect(wslProcess.perlHead.join("\n")).toContain("use Fcntl qw(:mode O_RDONLY O_WRONLY O_RDWR O_CREAT O_EXCL O_NONBLOCK O_NOCTTY O_NOFOLLOW O_DIRECTORY);");
    expect(wslProcess.fileFacts.join("\n")).toContain("sub fact {");
    expect(wslProcess.identity.join("\n")).toContain("printf 'id %s %s\\n'");
    const probe = wslProcess.probe.join("\n");
    expect(probe).toContain("sel=$1");
    expect(probe).toContain('found perl "$(readlink -f -- /usr/bin/perl)"');
    for (const line of ["selfs", "selino", "selstat"]) expect(probe).toContain(`printf '${line} %s\\n'`);
  });
});
