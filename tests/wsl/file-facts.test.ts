// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T212 (gaps.md W3): the fixed Perl `fileFacts` probe of `src/contracts/wsl-process.json` in the distro. It needs no Git 2.55.0.
// The facts come from the construction and from `/usr/bin/stat` and `sha256sum` in the distro, never from `src/git-service/`.

import { describe, expect } from "bun:test";
import { printOrigin } from "../origin";
import { writeLinux } from "./fixtures";
import { FACTS_TEXT, factsInput, IDENTITY_TEXT, inDistro, parseFactRecords, useWslFolder, wslExec, wslTest, type FactEntry, type FactRecord, type WslHost } from "./wsl-host";

printOrigin("../../src/contracts/wsl-process.json", import.meta.dir);

const CASE_TIMEOUT_MS = 180_000;
const MIB = 1_048_576;
const NEEDS = ["wsl-fixture-fs-id", "perl"] as const;

useWslFolder();

interface Tree {
  base: string;
  roots: [string, string, string];
}

// The owned tree of the probe cases. Each call builds it once.
let built: Tree | undefined;
function tree(host: WslHost): Tree {
  if (built) return built;
  const base = `${host.folder}/ff`;
  const roots: [string, string, string] = [`${base}/root`, `${base}/git`, `${base}/common`];
  const run = (program: string[]) => inDistro(host.distro, program);
  writeLinux(host, `${roots[0]}/plain.txt`, "plain\n", "644");
  writeLinux(host, `${roots[0]}/exec.sh`, "#!/bin/sh\nexit 0\n", "755");
  writeLinux(host, `${roots[0]}/noexec`, "#!/bin/sh\n", "644");
  writeLinux(host, `${roots[0]}/fileparent`, "x\n");
  writeLinux(host, `${roots[0]}/sub/inner.txt`, "inner\n");
  writeLinux(host, `${roots[0]}/locked/inner`, "secret\n");
  writeLinux(host, `${roots[2]}/config`, "[core]\n");
  run(["/usr/bin/mkdir", "-p", "--", `${roots[1]}/hooks`]);
  run(["/usr/bin/mkfifo", "--", `${roots[0]}/fifo`]);
  run(["/usr/bin/ln", "-s", "--", "plain.txt", `${roots[0]}/rel`]);
  run(["/usr/bin/ln", "-s", "--", "/etc/hostname", `${roots[0]}/abs`]);
  // A link text that is no UTF-8. Windows argument arrays carry only Unicode, so Perl writes the byte.
  run(["/usr/bin/perl", "-e", 'symlink("\\xff", $ARGV[0]) or die', "--", `${roots[0]}/bad`]);
  run(["/usr/bin/truncate", "-s", String(MIB + 1), "--", `${roots[0]}/big`]);
  for (let i = 1; i <= 9; i++) run(["/usr/bin/truncate", "-s", String(MIB), "--", `${roots[0]}/m${i}`]);
  built = { base, roots };
  return built;
}

function probe(host: WslHost, roots: readonly string[], digest: boolean, entries: FactEntry[]): { exitCode: number | null; records: FactRecord[] | null } {
  const result = wslExec(["--distribution", host.distro, "--cd", "/", "--exec", "/usr/bin/perl", "-e", FACTS_TEXT, "--", digest ? "1" : "0", ...roots], { input: factsInput(entries) });
  return { exitCode: result.exitCode, records: result.exitCode === 0 ? parseFactRecords(result.bytes) : null };
}

// `%f` is the raw mode in hex, `%s` the size, and `%Y` the modification time in seconds.
function statOf(host: WslHost, path: string): { mode: number; size: bigint; mtime: bigint } {
  const [mode, size, mtime] = inDistro(host.distro, ["/usr/bin/stat", "--printf=%f %s %Y", "--", path]).split(" ");
  return { mode: Number.parseInt(mode!, 16), size: BigInt(size!), mtime: BigInt(mtime!) };
}

const sha256 = (host: WslHost, path: string) => inDistro(host.distro, ["/usr/bin/sha256sum", "--", path]).split(" ")[0]!;
const hex = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

describe("the WSL fileFacts Perl probe (T212, gaps.md W3)", () => {
  wslTest(
    "each fact kind without digests matches the distro stat facts",
    NEEDS,
    (host) => {
      const t = tree(host);
      const file = (path: string, ownerExecute: boolean, executable: boolean) => {
        const st = statOf(host, `${t.roots[0]}/${path}`);
        expect(Boolean(st.mode & 0o100)).toBe(ownerExecute);
        return { kind: "file", size: st.size, mtime: st.mtime, ownerExecute, executable, content: "none" };
      };
      const entries: FactEntry[] = [
        { root: 0, path: ["plain.txt"] },
        { root: 0, path: ["exec.sh"] },
        { root: 0, path: ["noexec"] },
        { root: 0, path: ["missing"] },
        { root: 0, path: ["fileparent", "x"] },
        { root: 0, path: ["fifo"] },
        { root: 0, path: ["rel"] },
        { root: 0, path: ["abs"] },
        { root: 0, path: ["bad"] },
        { root: 0, path: ["sub"] },
        { root: 0, path: ["sub", "inner.txt"] },
        { root: 1, path: ["hooks", "pre-commit"] },
        { root: 2, path: ["config"] },
      ];
      const { exitCode, records } = probe(host, t.roots, false, entries);
      expect(exitCode).toBe(0);
      const config = statOf(host, `${t.roots[2]}/config`);
      expect(records).toEqual([
        file("plain.txt", false, false),
        file("exec.sh", true, true),
        file("noexec", false, false),
        { kind: "absent" },
        { kind: "absent" },
        { kind: "other" },
        { kind: "link", component: 1, target: new TextEncoder().encode("plain.txt") },
        { kind: "link", component: 1, target: new TextEncoder().encode("/etc/hostname") },
        { kind: "link", component: 1, target: new Uint8Array([0xff]) },
        { kind: "directory", executable: true },
        file("sub/inner.txt", false, false),
        { kind: "absent" },
        { kind: "file", size: config.size, mtime: config.mtime, ownerExecute: false, executable: false, content: "none" },
      ] as FactRecord[]);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "a mode-000 folder gives access-denied at its component",
    [...NEEDS, "non-root-user"],
    (host) => {
      const t = tree(host);
      inDistro(host.distro, ["/usr/bin/chmod", "000", "--", `${t.roots[0]}/locked`]);
      try {
        const { exitCode, records } = probe(host, t.roots, false, [{ root: 0, path: ["locked", "inner"] }]);
        expect(exitCode).toBe(0);
        expect(records).toEqual([{ kind: "error", component: 1, code: "access-denied" }]);
      } finally {
        inDistro(host.distro, ["/usr/bin/chmod", "755", "--", `${t.roots[0]}/locked`]);
      }
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "digests equal sha256sum, and the 1 MiB file bound and the 8 MiB request bound apply in request order",
    NEEDS,
    (host) => {
      const t = tree(host);
      const content = (names: string[]) => {
        const { exitCode, records } = probe(host, t.roots, true, names.map((name) => ({ root: 0, path: [name] })));
        expect(exitCode).toBe(0);
        expect(records).toHaveLength(names.length);
        return records!.map((r) => (r.kind === "file" ? (typeof r.content === "string" ? r.content : hex(r.content)) : r.kind));
      };
      const digestOf = (name: string) => sha256(host, `${t.roots[0]}/${name}`);
      // big is 1 MiB + 1 byte, so it gets the file bound and counts toward no total.
      expect(content(["plain.txt", "big"])).toEqual([digestOf("plain.txt"), "file-bytes"]);
      // Eight 1 MiB files fill 8 MiB. The ninth and each later file within 1 MiB get the request bound. big still gets the file bound.
      const ones = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"];
      expect(content([...ones, "big", "plain.txt"])).toEqual([...ones.slice(0, 8).map(digestOf), "total-bytes", "file-bytes", "total-bytes"]);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "the identity probe prints one id line per path, and Perl absent for a missing path (gaps.md W4)",
    NEEDS,
    (host) => {
      const t = tree(host);
      const paths = [t.roots[0], `${t.roots[0]}/missing`, `${t.roots[0]}/fileparent/x`, `${t.roots[0]}/rel`];
      const result = wslExec(["--distribution", host.distro, "--cd", "/", "--exec", "/bin/sh", "-c", IDENTITY_TEXT, "sh", "/usr/bin/stat", "/usr/bin/perl", ...paths]);
      expect(result.exitCode).toBe(0);
      const inode = (path: string) => inDistro(host.distro, ["/usr/bin/stat", "--dereference", "--format=%i", "--", path]).trim();
      const fileSystem = inDistro(host.distro, ["/usr/bin/stat", "--dereference", "--file-system", "--format=%t:%i", "--", t.roots[0]]).trim();
      // `rel` names plain.txt, and the identity probe follows a link, as `stat --dereference` does.
      expect(result.stdout).toBe(`id ${inode(t.roots[0])} ${fileSystem}\nabsent\nabsent\nid ${inode(`${t.roots[0]}/plain.txt`)} ${fileSystem}\n`);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "a missing root gives absent, and malformed input exits 3",
    NEEDS,
    (host) => {
      const t = tree(host);
      const missing = [t.roots[0], t.roots[1], `${t.base}/no-such-root`];
      expect(probe(host, missing, false, [{ root: 2, path: ["config"] }]).records).toEqual([{ kind: "absent" }]);
      // A component count without its components ends the input early.
      const result = wslExec(["--distribution", host.distro, "--cd", "/", "--exec", "/usr/bin/perl", "-e", FACTS_TEXT, "--", "0", ...t.roots], { input: new TextEncoder().encode("0\x002\x00plain.txt\x00") });
      expect(result.exitCode).toBe(3);
    },
    CASE_TIMEOUT_MS,
  );
});
