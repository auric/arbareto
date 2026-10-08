// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T212 (gaps.md W3): the fixed Perl `fileFacts` probe of `src/contracts/wsl-process.json` in the distro. It needs no Git 2.55.0.
// The facts come from the construction and from `/usr/bin/stat` and `sha256sum` in the distro, never from `src/git-service/`.

import { describe, expect } from "bun:test";
import { printOrigin } from "../origin";
import { writeLinux } from "./fixtures";
import type { WslFileResult, WslFilesCall } from "../../src/contracts/channel";
import {
  FACTS_TEXT,
  factsInput,
  IDENTITY_TEXT,
  inDistro,
  parseFactRecords,
  parseIndexedFacts,
  useWslFolder,
  WSL_FILES_TEXT,
  wslExec,
  wslFilesInput,
  wslFilesResults,
  wslTest,
  type FactEntry,
  type FactRecord,
  type WslHost,
} from "./wsl-host";

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

// ---- T325: the `wslFiles` Perl text and the `fileFacts` index part (contract §6 "WSL file work", "Index digest in a read") ----
// The oracles are `sha256sum`, `stat`, and Git in the distro, and digests of bytes that the test wrote.

const GIT_NEEDS = [...NEEDS, "distro-git-2.55"] as const;
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

interface FilesTree {
  roots: [string, string, string];
  git: string;
  sha: string;
}

// The owned repository of the `wslFiles` cases. Each call builds it once.
let filesTree: FilesTree | undefined;
function files(host: WslHost): FilesTree {
  if (filesTree) return filesTree;
  const root = `${host.folder}/wf`;
  const git = host.probe.paths.git!;
  const sha = host.probe.paths.sha256sum!;
  const run = (program: string[], input?: Uint8Array) => inDistro(host.distro, program, input ? { input } : {});
  writeLinux(host, `${root}/empty`, "");
  writeLinux(host, `${root}/sub/f.txt`, "line\r\nline2\n");
  writeLinux(host, `${root}/.gitattributes`, "*.txt text\n*.bin -text\n");
  // A stand-in for sha256sum that prints its line without the mode character.
  writeLinux(host, `${root}/tools/short-sha`, `#!/bin/sh\ncat >/dev/null\nprintf '%s -\\n' ${EMPTY_SHA}\n`, "755");
  run(["/usr/bin/truncate", "-s", String(MIB), "--", `${root}/one`]);
  run(["/usr/bin/truncate", "-s", String(MIB + 1), "--", `${root}/onemore`]);
  run(["/usr/bin/ln", "-s", "--", "sub", `${root}/rel`]);
  run(["/usr/bin/perl", "-e", 'symlink("\\xff", $ARGV[0]) or die', "--", `${root}/bad`]);
  run([git, "init", "-q", "--", root]);
  run([git, "-C", root, "add", "--", "sub/f.txt", ".gitattributes"]);
  filesTree = { roots: [root, `${root}/.git`, `${root}/.git`], git, sha };
  return filesTree;
}

const callOf = (fields: Record<string, unknown>) => ({ operationId: crypto.randomUUID(), contextKind: "registeredOperation", gitInstallationId: crypto.randomUUID(), repositoryId: crypto.randomUUID(), ...fields }) as WslFilesCall;
const worktree = (...path: string[]) => ({ root: "worktreeRoot" as const, path });

// Runs the text as the shell does, without the wrapper. `prefix` runs Perl code before the text (a test seam), and `sha` replaces sha256sum.
function wslFiles(host: WslHost, request: WslFilesCall, options: { sha?: string; prefix?: string[]; seam?: string } = {}): WslFileResult[] {
  const t = files(host);
  const text = options.prefix ? ["-e", options.seam ?? SEAM, "--", ...options.prefix, WSL_FILES_TEXT] : ["-e", WSL_FILES_TEXT, "--"];
  const args = ["--distribution", host.distro, "--cd", "/", "--exec", "/usr/bin/perl", ...text, request.mode, ...t.roots, t.git, options.sha ?? t.sha];
  const result = wslExec(args, { input: wslFilesInput(request) });
  return wslFilesResults(result.exitCode, result.bytes, request);
}

// The seam renames its first argument over the name `target` just before the text opens that name.
const SEAM =
  "BEGIN { *CORE::GLOBAL::sysopen = sub (*$$;$) { rename($::swap, $_[1]) if $_[1] eq q(target); @_ > 3 ? CORE::sysopen($_[0], $_[1], $_[2], $_[3]) : CORE::sysopen($_[0], $_[1], $_[2]) } } ($::swap, $::text) = splice(@ARGV, 0, 2); eval $::text; die $@ if $@;";
// With a first argument of 1, `lstat` of the name `index.lock` fails with `EACCES`.
const LSTAT_SEAM =
  "BEGIN { *CORE::GLOBAL::lstat = sub (;*) { if ($_[0] eq q(index.lock) && $::fail) { require POSIX; $! = POSIX::EACCES(); return } CORE::lstat($_[0]) } } ($::fail, $::text) = splice(@ARGV, 0, 2); eval $::text; die $@ if $@;";

const stat = (host: WslHost, format: string, path: string) => inDistro(host.distro, ["/usr/bin/stat", `--format=${format}`, "--", path]).trim();
const exists = (host: WslHost, path: string) => wslExec(["--distribution", host.distro, "--cd", "/", "--exec", "/usr/bin/test", "-e", path]).exitCode === 0;
// The service passes 32 random bytes as 64 hex digits (contract §4 "WSL index publication").
const newToken = () => crypto.getRandomValues(new Uint8Array(32)).toHex();
const lockOf = (host: WslHost, token = newToken()) => {
  const [result] = wslFiles(host, callOf({ mode: "lock", bound: "MUTATION_RAW_INDEX_BYTES", token }));
  if (result?.kind !== "lock") throw new Error(`lock: ${JSON.stringify(result)}`);
  return { device: result.device, inode: result.inode, token };
};
const content = (host: WslHost, path: string) => inDistro(host.distro, ["/usr/bin/cat", "--", path]);

describe("the WSL wslFiles Perl text (T325)", () => {
  wslTest(
    "digest equals sha256sum for an empty, a 1 MiB, and a 1 MiB plus 1 byte file, and a link gives its raw bytes",
    NEEDS,
    (host) => {
      const t = files(host);
      const compared = wslFiles(
        host,
        callOf({
          mode: "digest",
          bound: "COMPARED_RAW_VERSION_BYTES",
          files: [worktree("empty"), worktree("one"), worktree("onemore"), worktree("rel"), worktree("bad"), worktree("rel", "f.txt"), worktree("missing"), worktree("sub")],
        }),
      );
      expect(compared).toEqual([
        { kind: "file", size: 0, changed: false, sha256: sha256(host, `${t.roots[0]}/empty`) },
        { kind: "file", size: MIB, changed: false, sha256: sha256(host, `${t.roots[0]}/one`) },
        { kind: "file", size: MIB + 1, changed: false, bound: "COMPARED_RAW_VERSION_BYTES" },
        { kind: "link", component: 1, targetBytes: new TextEncoder().encode("sub").toBase64(), sha256: hex(new TextEncoder().encode("sub")) },
        { kind: "link", component: 1, targetBytes: new Uint8Array([0xff]).toBase64(), sha256: hex(new Uint8Array([0xff])) },
        { kind: "link", component: 1 },
        { kind: "absent" },
        { kind: "directory" },
      ]);
      const whole = wslFiles(host, callOf({ mode: "digest", bound: "WHOLE_FILE_STAGE_INPUT_BYTES", files: [worktree("onemore")] }));
      expect(whole).toEqual([{ kind: "file", size: MIB + 1, changed: false, sha256: sha256(host, `${t.roots[0]}/onemore`) }]);
      // A sha256sum line without the mode character is no digest.
      const short = wslFiles(host, callOf({ mode: "digest", bound: "COMPARED_RAW_VERSION_BYTES", files: [worktree("empty")] }), { sha: `${t.roots[0]}/tools/short-sha` });
      expect(short).toEqual([{ kind: "error", component: 1, code: "other-error" }]);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "a rename over the final name between lstat and open gives changed and the digest of the new file",
    NEEDS,
    (host) => {
      const t = files(host);
      writeLinux(host, `${t.roots[0]}/target`, "old\n");
      writeLinux(host, `${t.roots[0]}/swap`, "newer\n");
      const request = callOf({ mode: "digest", bound: "COMPARED_RAW_VERSION_BYTES", files: [worktree("target")] });
      expect(wslFiles(host, request, { prefix: [`${t.roots[0]}/swap`] })).toEqual([{ kind: "file", size: 6, changed: true, sha256: hex(new TextEncoder().encode("newer\n")) }]);
      // Without the rename, the same seam text gives changed false.
      expect(wslFiles(host, request, { prefix: [`${t.roots[0]}/no-swap`] })).toEqual([{ kind: "file", size: 6, changed: false, sha256: hex(new TextEncoder().encode("newer\n")) }]);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "indexDigest equals sha256sum of index, and of sharedindex.<hash> when the request names it",
    GIT_NEEDS,
    (host) => {
      const t = files(host);
      const shared = "0".repeat(40);
      writeLinux(host, `${t.roots[1]}/sharedindex.${shared}`, "shared\n");
      const index = { kind: "digest" as const, size: Number(stat(host, "%s", `${t.roots[1]}/index`)), sha256: sha256(host, `${t.roots[1]}/index`) };
      expect(wslFiles(host, callOf({ mode: "indexDigest", bound: "MUTATION_RAW_INDEX_BYTES" }))).toEqual([{ kind: "index", index }]);
      expect(wslFiles(host, callOf({ mode: "indexDigest", bound: "MUTATION_RAW_INDEX_BYTES", sharedIndex: shared }))).toEqual([
        { kind: "index", index, sharedIndex: { kind: "digest", size: 7, sha256: sha256(host, `${t.roots[1]}/sharedindex.${shared}`) } },
      ]);
      expect(wslFiles(host, callOf({ mode: "indexDigest", bound: "MUTATION_RAW_INDEX_BYTES", sharedIndex: "1".repeat(64) }))).toEqual([{ kind: "index", index, sharedIndex: { kind: "absent" } }]);
      // The fileFacts text gives the same result after its facts, in the same process.
      const result = wslExec(["--distribution", host.distro, "--cd", "/", "--exec", "/usr/bin/perl", "-e", FACTS_TEXT, "--", "0", ...t.roots, t.sha, shared], {
        input: factsInput([{ root: 1, path: ["hooks"] }]),
      });
      expect(result.exitCode).toBe(0);
      expect(parseIndexedFacts(result.bytes, 1, true)?.index).toEqual({ kind: "index", index, sharedIndex: { kind: "digest", size: 7, sha256: sha256(host, `${t.roots[1]}/sharedindex.${shared}`) } });
      const plain = wslExec(["--distribution", host.distro, "--cd", "/", "--exec", "/usr/bin/perl", "-e", FACTS_TEXT, "--", "0", ...t.roots, t.sha], { input: factsInput([{ root: 1, path: ["hooks"] }]) });
      expect(parseIndexedFacts(plain.bytes, 1, false)?.index).toEqual({ kind: "index", index });
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "hashObject gives the git hash-object --path object ID, the raw digest, and both exit statuses",
    GIT_NEEDS,
    (host) => {
      const t = files(host);
      const oid = inDistro(host.distro, [t.git, "-C", t.roots[0], "hash-object", "--path=sub/f.txt", "--", "sub/f.txt"]).trim();
      const [result] = wslFiles(host, callOf({ mode: "hashObject", bound: "WHOLE_FILE_STAGE_INPUT_BYTES", files: [worktree("sub", "f.txt")] }));
      expect(result).toEqual({ kind: "object", size: 12, sha256: sha256(host, `${t.roots[0]}/sub/f.txt`), oid, gitExit: { exitCode: 0 }, hashExit: { exitCode: 0 } });
      expect(oid).not.toBe(inDistro(host.distro, [t.git, "-C", t.roots[0], "hash-object", "--no-filters", "--", "sub/f.txt"]).trim());
      expect(wslFiles(host, callOf({ mode: "hashObject", bound: "WHOLE_FILE_STAGE_INPUT_BYTES", files: [worktree("missing")] }))).toEqual([{ kind: "absent" }]);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "catFile gives the filtered blob digest, and over with a signal exit for a blob above size",
    GIT_NEEDS,
    (host) => {
      const t = files(host);
      const blob = new Uint8Array(2_000_000).map((_, i) => (i * 7) % 251);
      const oid = inDistro(host.distro, [t.git, "-C", t.roots[0], "hash-object", "-w", "--stdin"], { input: blob }).trim();
      const cat = (size: number) => wslFiles(host, callOf({ mode: "catFile", bound: "WHOLE_FILE_STAGE_INPUT_BYTES", files: [worktree("data.bin")], oid, size }));
      expect(cat(blob.length)).toEqual([{ kind: "blob", size: blob.length, sha256: hex(blob), over: false, gitExit: { exitCode: 0 }, hashExit: { exitCode: 0 } }]);
      // Perl keeps one byte above size and closes the pipe. Git then ends by SIGPIPE.
      expect(cat(0)).toEqual([{ kind: "blob", size: 1, sha256: hex(blob.subarray(0, 1)), over: true, gitExit: { signal: 13 }, hashExit: { exitCode: 0 } }]);
      // A missing object: Git's own exit status, as the same command gives it in the distro.
      const absent = "1".repeat(40);
      const status = wslExec(["--distribution", host.distro, "--cd", "/", "--exec", t.git, "--no-lazy-fetch", "-C", t.roots[0], "cat-file", "--filters", "--path=data.bin", absent]).exitCode;
      expect(status).not.toBe(0);
      const missing = wslFiles(host, callOf({ mode: "catFile", bound: "WHOLE_FILE_STAGE_INPUT_BYTES", files: [worktree("data.bin")], oid: absent, size: 1 }));
      expect(missing).toEqual([{ kind: "blob", size: 0, sha256: EMPTY_SHA, over: false, gitExit: { exitCode: status! }, hashExit: { exitCode: 0 } }]);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "lock gives locked for an existing index.lock and keeps it, and candidate gets a time at or before the canonical time",
    GIT_NEEDS,
    (host) => {
      const t = files(host);
      const lockPath = `${t.roots[1]}/index.lock`;
      try {
        const lock = lockOf(host);
        expect(stat(host, "%d %i %s", lockPath)).toBe(`${lock.device} ${lock.inode} 64`);
        expect(content(host, lockPath)).toBe(lock.token);
        expect(wslFiles(host, callOf({ mode: "lock", bound: "MUTATION_RAW_INDEX_BYTES", token: newToken() }))).toEqual([{ kind: "locked" }]);
        expect(stat(host, "%d %i %s", lockPath)).toBe(`${lock.device} ${lock.inode} 64`);
        expect(content(host, lockPath)).toBe(lock.token);
      } finally {
        inDistro(host.distro, ["/usr/bin/rm", "-f", "--", lockPath]);
      }
      const name = `arbareto-candidate-${crypto.randomUUID()}`;
      const [result] = wslFiles(host, callOf({ mode: "candidate", bound: "MUTATION_RAW_INDEX_BYTES", candidate: name }));
      const digest = sha256(host, `${t.roots[1]}/index`);
      expect(result).toMatchObject({ kind: "candidate", index: { sha256: digest }, candidate: { sha256: digest } });
      if (result?.kind !== "candidate") return;
      expect(result.index.mtime).toBe(stat(host, "%Y", `${t.roots[1]}/index`));
      expect(result.candidate.mtime).toBe(stat(host, "%Y", `${t.roots[1]}/${name}`));
      expect(BigInt(result.candidate.mtime) <= BigInt(result.index.mtime)).toBe(true);
      // A second create of the same name fails, and an absent index gives absent.
      expect(wslFiles(host, callOf({ mode: "candidate", bound: "MUTATION_RAW_INDEX_BYTES", candidate: name }))).toEqual([{ kind: "error", component: 0, code: "other-error" }]);
      inDistro(host.distro, ["/usr/bin/mv", "--", `${t.roots[1]}/index`, `${t.roots[1]}/index.away`]);
      try {
        expect(wslFiles(host, callOf({ mode: "candidate", bound: "MUTATION_RAW_INDEX_BYTES", candidate: `${name}-2` }))).toEqual([{ kind: "absent" }]);
      } finally {
        inDistro(host.distro, ["/usr/bin/mv", "--", `${t.roots[1]}/index.away`, `${t.roots[1]}/index`]);
      }
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "publish gives mismatch and notOwned with no rename, and otherwise renames the owned lock over index",
    GIT_NEEDS,
    (host) => {
      const t = files(host);
      const index = `${t.roots[1]}/index`;
      const lockPath = `${t.roots[1]}/index.lock`;
      const name = `arbareto-candidate-${crypto.randomUUID()}`;
      wslFiles(host, callOf({ mode: "candidate", bound: "MUTATION_RAW_INDEX_BYTES", candidate: name }));
      const expected = sha256(host, `${t.roots[1]}/${name}`);
      const publish = ({ device, inode, token }: ReturnType<typeof lockOf>, digest = expected) =>
        wslFiles(host, callOf({ mode: "publish", bound: "MUTATION_RAW_INDEX_BYTES", candidate: name, lock: { device, inode }, token, expected: digest }));
      const before = stat(host, "%i", index);
      try {
        // A wrong expected digest: nothing is renamed, and the lock holds the token again.
        let lock = lockOf(host);
        expect(publish(lock, "0".repeat(64))).toEqual([{ kind: "mismatch" }]);
        expect(stat(host, "%i", index)).toBe(before);
        expect(stat(host, "%i", lockPath)).toBe(lock.inode);
        expect(content(host, lockPath)).toBe(lock.token);
        // A replaced lock. The first lock keeps its inode under another name, so the new lock gets another inode.
        inDistro(host.distro, ["/usr/bin/mv", "--", lockPath, `${lockPath}.first`]);
        const replaced = lockOf(host);
        expect(replaced.inode).not.toBe(lock.inode);
        expect(publish(lock)).toEqual([{ kind: "notOwned" }]);
        expect(stat(host, "%i %s", lockPath)).toBe(`${replaced.inode} 64`);
        expect(stat(host, "%i", index)).toBe(before);
        // A deleted lock that another writer creates again. ext4 gives the free inode again, so dev and inode match.
        // The new lock holds 64 bytes of Git index data, not the token.
        inDistro(host.distro, ["/usr/bin/rm", "--", lockPath]);
        inDistro(host.distro, ["/usr/bin/perl", "-e", 'use Fcntl; sysopen(my $f, $ARGV[0], O_WRONLY|O_CREAT|O_EXCL, 0666) or die; print $f "DIRC", "\\0" x 60', "--", lockPath]);
        expect(stat(host, "%d %i %s", lockPath)).toBe(`${replaced.device} ${replaced.inode} 64`);
        expect(publish(replaced)).toEqual([{ kind: "notOwned" }]);
        expect(stat(host, "%i %s", lockPath)).toBe(`${replaced.inode} 64`);
        expect(content(host, lockPath).startsWith("DIRC")).toBe(true);
        expect(stat(host, "%i", index)).toBe(before);
        // The same after `touch`: a size-0 lock with the reused inode.
        inDistro(host.distro, ["/usr/bin/rm", "--", lockPath]);
        inDistro(host.distro, ["/usr/bin/touch", "--", lockPath]);
        expect(publish(replaced)).toEqual([{ kind: "notOwned" }]);
        expect(stat(host, "%s", lockPath)).toBe("0");
        expect(stat(host, "%i", index)).toBe(before);
        inDistro(host.distro, ["/usr/bin/rm", "--", lockPath]);
        // The owned lock with the verified digest replaces index.
        lock = lockOf(host);
        expect(publish(lock)).toEqual([{ kind: "published", size: Number(stat(host, "%s", `${t.roots[1]}/${name}`)), sha256: expected }]);
        expect(stat(host, "%i", index)).toBe(lock.inode);
        expect(sha256(host, index)).toBe(expected);
        expect(stat(host, "%Y", index)).toBe(stat(host, "%Y", `${t.roots[1]}/${name}`));
        expect(exists(host, lockPath)).toBe(false);
        // No lock gives notOwned.
        expect(publish(lock)).toEqual([{ kind: "notOwned" }]);
      } finally {
        inDistro(host.distro, ["/usr/bin/rm", "-f", "--", lockPath, `${lockPath}.first`]);
      }
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "publish gives error for an lstat failure other than ENOENT, renames nothing, and writes the token back",
    GIT_NEEDS,
    (host) => {
      const t = files(host);
      const index = `${t.roots[1]}/index`;
      const lockPath = `${t.roots[1]}/index.lock`;
      const name = `arbareto-candidate-${crypto.randomUUID()}`;
      wslFiles(host, callOf({ mode: "candidate", bound: "MUTATION_RAW_INDEX_BYTES", candidate: name }));
      const expected = sha256(host, `${t.roots[1]}/${name}`);
      const before = stat(host, "%i", index);
      try {
        const { device, inode, token } = lockOf(host);
        const request = callOf({ mode: "publish", bound: "MUTATION_RAW_INDEX_BYTES", candidate: name, lock: { device, inode }, token, expected });
        expect(wslFiles(host, request, { seam: LSTAT_SEAM, prefix: ["1"] })).toEqual([{ kind: "error", component: 0, code: "access-denied" }]);
        expect(stat(host, "%i", index)).toBe(before);
        expect(content(host, lockPath)).toBe(token);
        // A directory at index.lock is no lock: publish and remove give error, and the directory stays.
        inDistro(host.distro, ["/usr/bin/rm", "--", lockPath]);
        inDistro(host.distro, ["/usr/bin/mkdir", "--", lockPath]);
        expect(wslFiles(host, request)).toEqual([{ kind: "error", component: 0, code: "other-error" }]);
        expect(wslFiles(host, callOf({ mode: "remove", bound: "MUTATION_RAW_INDEX_BYTES", token }))).toEqual([{ kind: "error", component: 0, code: "other-error" }]);
        expect(stat(host, "%F", lockPath)).toBe("directory");
      } finally {
        inDistro(host.distro, ["/usr/bin/rm", "-rf", "--", lockPath]);
      }
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "remove deletes an owned lock or candidate and keeps every other file",
    GIT_NEEDS,
    (host) => {
      const t = files(host);
      const lockPath = `${t.roots[1]}/index.lock`;
      const remove = (fields: Record<string, unknown>) => wslFiles(host, callOf({ mode: "remove", bound: "MUTATION_RAW_INDEX_BYTES", ...fields }));
      try {
        const owned = lockOf(host);
        expect(remove({ token: owned.token })).toEqual([{ kind: "removed" }]);
        expect(exists(host, lockPath)).toBe(false);
        expect(remove({ token: owned.token })).toEqual([{ kind: "notOwned" }]);
        // A deleted lock that another writer creates again with the same inode and 64 bytes of Git index data stays.
        const first = lockOf(host);
        inDistro(host.distro, ["/usr/bin/rm", "--", lockPath]);
        inDistro(host.distro, ["/usr/bin/perl", "-e", 'use Fcntl; sysopen(my $f, $ARGV[0], O_WRONLY|O_CREAT|O_EXCL, 0666) or die; print $f "DIRC", "\\0" x 60', "--", lockPath]);
        expect(stat(host, "%d %i %s", lockPath)).toBe(`${first.device} ${first.inode} 64`);
        expect(remove({ token: first.token })).toEqual([{ kind: "notOwned" }]);
        expect(content(host, lockPath).startsWith("DIRC")).toBe(true);
        inDistro(host.distro, ["/usr/bin/rm", "--", lockPath]);
        // A candidate goes only with the digest that the service verified last.
        const name = `arbareto-candidate-${crypto.randomUUID()}`;
        wslFiles(host, callOf({ mode: "candidate", bound: "MUTATION_RAW_INDEX_BYTES", candidate: name }));
        const digest = sha256(host, `${t.roots[1]}/${name}`);
        expect(remove({ candidate: name, expected: "0".repeat(64) })).toEqual([{ kind: "notOwned" }]);
        expect(exists(host, `${t.roots[1]}/${name}`)).toBe(true);
        expect(remove({ candidate: name, expected: digest })).toEqual([{ kind: "removed" }]);
        expect(exists(host, `${t.roots[1]}/${name}`)).toBe(false);
      } finally {
        inDistro(host.distro, ["/usr/bin/rm", "-f", "--", lockPath]);
      }
    },
    CASE_TIMEOUT_MS,
  );
});
