// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T304: contract §6 "File facts" against the shell double. T305 adds `fileFacts` to `bun-runner.ts` on Linux, and T306 adds the Windows host calls.
// The double request is the `FileFacts` frame without `type` and `callId`, as for the other `GitRunner` calls. The reply is the `facts` list.

import { afterAll, beforeAll, describe, expect } from "bun:test";
import { accessSync, chmodSync, constants, lstatSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { FileFact, ProcessRequest } from "../../src/contracts/channel";
import { FILE_FACT_COMPONENT_UNITS, FILE_FACT_ENTRIES, TRUST_DIGEST_FILE_BYTES as FILE_BYTES, TRUST_DIGEST_TOTAL_BYTES as TOTAL_BYTES } from "../../src/contracts/limits";
import { isWindows } from "../../src/contracts/native-path";
import { RunnerRefusal, type FileFactsRequest } from "../../src/git-service/git-runner";
import { printOrigin } from "../origin";
import { createBunRunner, type BunRunner } from "./bun-runner";
import { fixtureDir, fixtureGit, fixturePath, serviceEnv, useFixtureRoot } from "./fixture-root";
import { GIT } from "./git-binary";
import { sha256 } from "./git-oracle";
import { caseTest, type Capability } from "./service-harness";

printOrigin("../../src/contracts/channel.ts", import.meta.dir);
printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/contracts/native-path.ts", import.meta.dir);
printOrigin("../../src/git-service/git-runner.ts", import.meta.dir);

useFixtureRoot();

const TASK = "T304";
const W: Capability[] = ["shell-double"];
const CASE_TIMEOUT_MS = 60_000;
// FIPS 180-2 Appendix B.1: the SHA-256 of "abc".
const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
// Microsoft Learn "FILETIME": 100-ns intervals since 1601-01-01. 11,644,473,600 seconds lie between 1601-01-01 and 1970-01-01.
const EPOCH_1601_TICKS = 116_444_736_000_000_000n;
// The FIFO case ends within this bound. A helper opens the write end at the bound, so a blocked open or read in the double returns.
const FIFO_BOUND_MS = 5000;
const HELPER_EXIT_MS = 5000;

const id = () => crypto.randomUUID();

type Entry = FileFactsRequest["files"][number];

const tree = (...path: string[]): Entry => ({ root: "worktreeRoot", path });
const gitDir = (...path: string[]): Entry => ({ root: "gitDirectory", path });
const common = (...path: string[]): Entry => ({ root: "commonDirectory", path });

// Contract §6 "File facts": `executable` is the result of an `X_OK` check, and only POSIX sends it.
function executable(path: string): { executable?: boolean } {
  if (isWindows) return {};
  try {
    accessSync(path, constants.X_OK);
    return { executable: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EACCES") return { executable: false };
    throw error;
  }
}

// Contract §6 "File facts" `lastWrite`: 100-ns units since 1601 on Windows, nanoseconds since 1970 on POSIX.
// POSIX also sends `ownerExecute`, the `S_IXUSR` bit (0100) of `st_mode`.
function file(path: string, extra: { digest?: string; bound?: "file-bytes" | "total-bytes" } = {}): FileFact {
  const stat = statSync(path, { bigint: true });
  const lastWrite = isWindows ? stat.mtimeNs / 100n + EPOCH_1601_TICKS : stat.mtimeNs;
  const ownerExecute = isWindows ? {} : { ownerExecute: (stat.mode & 0o100n) !== 0n };
  return { kind: "file", size: Number(stat.size), lastWrite: lastWrite.toString(), ...executable(path), ...ownerExecute, ...extra };
}

const directory = (path: string): FileFact => ({ kind: "directory", ...executable(path) });
const ABSENT: FileFact = { kind: "absent" };
const OTHER: FileFact = { kind: "other" };

// Contract §6 "File facts" `error` codes and the `absent` open results, by POSIX `errno` and by the libuv names of the Win32 errors.
function oracle(path: string, component: number): FileFact {
  let code: string | undefined;
  try {
    lstatSync(path);
  } catch (error) {
    code = (error as NodeJS.ErrnoException).code;
  }
  if (code === undefined) throw new Error(`the fixture path exists: ${path}`);
  if (code === "ENOENT" || code === "ENOTDIR") return ABSENT;
  const known: Record<string, "access-denied" | "io-error"> = { EACCES: "access-denied", EIO: "io-error" };
  return { kind: "error", component, code: known[code] ?? "other-error" };
}

describe("file facts (contract §6 \"File facts\")", () => {
  let runner: BunRunner;
  let gitInstallationId: string;
  let repositoryId: string;
  let main: string;
  let hooks: string;
  let outside: string;

  function registerRoots(discovery: string, worktreeRoot: string, gitDirectory: string, commonDirectory: string): Promise<string> {
    const repository = id();
    const request = { operationId: id(), bootstrapId: runner.addContext("repositoryDiscovery", discovery), gitInstallationId, repositoryId: repository, worktreeRoot, gitDirectory, commonDirectory };
    return runner.register(request).then((reply) => {
      expect(reply).toEqual({ result: "approved" });
      return repository;
    });
  }

  const request = (digest: boolean, files: Entry[], repository = repositoryId): FileFactsRequest => ({
    operationId: id(),
    contextKind: "registeredOperation",
    gitInstallationId,
    repositoryId: repository,
    digest,
    files,
  });

  // Sends one valid request. The reply holds one contract fact per entry.
  async function facts(digest: boolean, files: Entry[], repository = repositoryId): Promise<FileFact[]> {
    const call = request(digest, files, repository);
    expect(ProcessRequest.safeParse({ type: "fileFacts", callId: id(), ...call }).success).toBe(true);
    const reply = await runner.fileFacts(call);
    expect(reply).toHaveLength(files.length);
    for (const fact of reply) expect(FileFact.safeParse(fact).success).toBe(true);
    return reply;
  }

  const lastReads = () => runner.fileFactCalls.at(-1)!.bytesRead;

  // The refused code, or "replied". Any other error fails the case.
  async function outcome(call: unknown): Promise<string> {
    try {
      await runner.fileFacts(call as FileFactsRequest);
      return "replied";
    } catch (error) {
      if (error instanceof RunnerRefusal) return error.code;
      throw error;
    }
  }

  beforeAll(async () => {
    if (GIT === null) return;
    main = fixtureDir("main");
    fixtureGit(GIT, main, ["init", "-q"]);
    writeFileSync(join(main, "tracked.txt"), "tracked\n");
    fixtureGit(GIT, main, ["add", "tracked.txt"]);
    fixtureGit(GIT, main, ["commit", "-q", "-m", "fixture"]);
    hooks = join(main, ".git", "hooks");
    writeFileSync(join(hooks, "pre-commit"), "abc", { mode: 0o644 });
    writeFileSync(join(hooks, "run"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(join(hooks, "run"), 0o755);
    outside = fixtureDir("outside");
    writeFileSync(join(outside, "pre-commit"), "outside");
    runner = createBunRunner({ git: GIT, directory: fixtureDir("runner"), environment: serviceEnv() });
    gitInstallationId = id();
    const probe = runner.addContext("gitProbe", GIT);
    expect(await runner.register({ operationId: id(), bootstrapId: probe, gitInstallationId, version: "2.55.0", digest: "c".repeat(64), confirm: false })).toEqual({ result: "approved" });
    repositoryId = await registerRoots(main, main, join(main, ".git"), join(main, ".git"));
  });

  afterAll(async () => {
    await runner?.dispose();
  });

  caseTest(
    TASK,
    "a file gives its size, lastWrite, and SHA-256, and each other kind follows the open result",
    W,
    async () => {
      const preCommit = join(hooks, "pre-commit");
      const run = join(hooks, "run");
      expect(
        await facts(true, [
          gitDir("hooks", "pre-commit"),
          gitDir("hooks", "run"),
          gitDir("hooks"),
          gitDir("hooks", "missing"),
          gitDir("missing", "pre-commit"),
          gitDir("hooks", "pre-commit", "x"),
          tree(".git", "hooks", "pre-commit"),
        ]),
      ).toEqual([
        file(preCommit, { digest: ABC }),
        file(run, { digest: sha256(new TextEncoder().encode("#!/bin/sh\nexit 0\n")) }),
        directory(hooks),
        ABSENT,
        ABSENT,
        ABSENT,
        file(preCommit, { digest: ABC }),
      ]);
      // Contract §6 "File facts": Windows opens each component with a case-insensitive lookup. The Linux fixture file systems compare names exactly.
      expect(await facts(true, [gitDir("HOOKS", "PRE-COMMIT")])).toEqual([isWindows ? file(preCommit, { digest: ABC }) : ABSENT]);
      const gone = fixturePath("gone");
      expect(await facts(true, [gitDir("hooks")], await registerRoots(main, gone, gone, gone))).toEqual([ABSENT]);
    },
    CASE_TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "digest false reads no file data, and digest true reads each file within the bound",
    W,
    async () => {
      const entries = [gitDir("hooks", "pre-commit"), gitDir("hooks")];
      expect(await facts(false, entries)).toEqual([file(join(hooks, "pre-commit")), directory(hooks)]);
      expect(lastReads()).toEqual([0, 0]);
      expect(await facts(true, entries)).toEqual([file(join(hooks, "pre-commit"), { digest: ABC }), directory(hooks)]);
      expect(lastReads()).toEqual([3, 0]);
    },
    CASE_TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a file above 1 MiB gets bound file-bytes, and the double reads at most 1 MiB plus 1 byte of it",
    W,
    async () => {
      const exact = new Uint8Array(FILE_BYTES).fill(0x61);
      writeFileSync(join(hooks, "exact"), exact);
      writeFileSync(join(hooks, "over"), new Uint8Array(FILE_BYTES + 1).fill(0x61));
      writeFileSync(join(hooks, "large"), new Uint8Array(3 * FILE_BYTES).fill(0x61));
      expect(await facts(true, [gitDir("hooks", "over"), gitDir("hooks", "exact"), gitDir("hooks", "large")])).toEqual([
        file(join(hooks, "over"), { bound: "file-bytes" }),
        file(join(hooks, "exact"), { digest: sha256(exact) }),
        file(join(hooks, "large"), { bound: "file-bytes" }),
      ]);
      const reads = lastReads();
      expect(reads[0]).toBeLessThanOrEqual(FILE_BYTES + 1);
      expect(reads[1]).toBe(FILE_BYTES);
      expect(reads[2]).toBeLessThanOrEqual(FILE_BYTES + 1);
      expect(await facts(false, [gitDir("hooks", "over")])).toEqual([file(join(hooks, "over"))]);
      expect(lastReads()).toEqual([0]);
    },
    CASE_TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "the per-file bound comes first, and only files within it count toward the 8 MiB request total",
    W,
    async () => {
      const oneMib = new Uint8Array(FILE_BYTES).fill(0x61);
      const bounds = join(hooks, "bounds");
      const names: string[] = [];
      const write = (name: string, bytes: Uint8Array) => {
        writeFileSync(join(bounds, name), bytes);
        names.push(name);
      };
      fixtureDir(join("main", ".git", "hooks", "bounds"));
      write("big", new Uint8Array(FILE_BYTES + 1).fill(0x61));
      for (let n = 0; n < 8; n++) write(`m${n}`, oneMib);
      write("two-before", new Uint8Array(2 * FILE_BYTES).fill(0x61));
      write("m8", oneMib);
      write("two-after", new Uint8Array(2 * FILE_BYTES).fill(0x61));
      write("tiny", new TextEncoder().encode("abc"));
      expect(9 * FILE_BYTES).toBeGreaterThan(TOTAL_BYTES);
      const at = (name: string, extra: Parameters<typeof file>[1]) => file(join(bounds, name), extra);
      expect(await facts(true, names.map((name) => gitDir("hooks", "bounds", name)))).toEqual([
        at("big", { bound: "file-bytes" }),
        ...Array.from({ length: 8 }, (_, n) => at(`m${n}`, { digest: sha256(oneMib) })),
        at("two-before", { bound: "file-bytes" }),
        at("m8", { bound: "total-bytes" }),
        at("two-after", { bound: "file-bytes" }),
        at("tiny", { bound: "total-bytes" }),
      ]);
    },
    CASE_TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a request that breaks a field rule gets refused INVALID_REQUEST",
    W,
    async () => {
      const valid = request(true, [gitDir("hooks")]);
      const files = (...path: unknown[]) => ({ ...valid, files: [{ root: "gitDirectory", path }] });
      const { digest: _digest, ...noDigest } = valid;
      const cases: [string, unknown][] = [
        ["component ..", files("hooks", "..")],
        ["component .", files("hooks", ".")],
        ["empty component", files("hooks", "")],
        ["component a/b", files("a/b")],
        [`component of ${FILE_FACT_COMPONENT_UNITS + 1} UTF-16 units`, files("\u{1f600}".repeat((FILE_FACT_COMPONENT_UNITS + 1) / 2))],
        ["component with a lone surrogate", files("\ud800")],
        ["component with NUL", files("a\u0000b")],
        ["no component", files()],
        ["a component that is no string", files(1)],
        ["root home", { ...valid, files: [{ root: "home", path: ["h.sh"] }] }],
        ["an entry with another key", { ...valid, files: [{ root: "gitDirectory", path: ["hooks"], x: 1 }] }],
        ["an absolute path entry", { ...valid, files: [{ path: [hooks] }] }],
        ["no entry", { ...valid, files: [] }],
        [`${FILE_FACT_ENTRIES + 1} entries`, { ...valid, files: Array.from({ length: FILE_FACT_ENTRIES + 1 }, () => gitDir("hooks")) }],
        ["no digest", noDigest],
        ["digest that is no boolean", { ...valid, digest: 1 }],
        ["a discovery context", { ...valid, contextKind: "repositoryDiscovery", bootstrapId: id() }],
        ["an unknown field", { ...valid, extra: 1 }],
        ["an operation ID that is no identifier", { ...valid, operationId: "x" }],
      ];
      for (const [name, call] of cases) {
        expect([name, ProcessRequest.safeParse({ type: "fileFacts", callId: id(), ...(call as object) }).success]).toEqual([name, false]);
        expect([name, await outcome(call)]).toEqual([name, "INVALID_REQUEST"]);
      }
    },
    CASE_TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "the native component rule refuses a\\b, x:y, nul, and x. only on Windows",
    W,
    async () => {
      // Contract §6 "File facts" component rule: the Windows rule of `isComponent`, or the POSIX rule, which permits these names.
      for (const name of ["a\\b", "x:y", "nul", "x.", "COM1.txt", "x "]) {
        const call = request(true, [gitDir("hooks", name)]);
        expect([name, await outcome(call)]).toEqual([name, isWindows ? "INVALID_REQUEST" : "replied"]);
        if (!isWindows) expect([name, await facts(true, [gitDir("hooks", name)])]).toEqual([name, [ABSENT]]);
      }
    },
    CASE_TIMEOUT_MS,
  );

  caseTest(
    TASK,
    `a request of ${FILE_FACT_ENTRIES} entries gets one fact per entry in request order`,
    W,
    async () => {
      const files = Array.from({ length: FILE_FACT_ENTRIES }, (_, n) => (n % 2 === 0 ? gitDir("hooks", "pre-commit") : gitDir("hooks", "missing")));
      const preCommit = file(join(hooks, "pre-commit"), { digest: ABC });
      expect(await facts(true, files)).toEqual(files.map((_, n) => (n % 2 === 0 ? preCommit : ABSENT)));
    },
    CASE_TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "an unbound or released repositoryId gets refused UNKNOWN_TARGET",
    W,
    async () => {
      expect(await outcome(request(true, [gitDir("hooks")], id()))).toBe("UNKNOWN_TARGET");
      const released = await registerRoots(main, main, join(main, ".git"), join(main, ".git"));
      expect(await facts(true, [gitDir("hooks")], released)).toEqual([directory(hooks)]);
      runner.release({ repositoryId: released });
      expect(await outcome(request(true, [gitDir("hooks")], released))).toBe("UNKNOWN_TARGET");
    },
    CASE_TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "commonDirectory reads below the main Git directory after a linked-worktree registration",
    W,
    async () => {
      const linked = fixturePath("linked");
      fixtureGit(GIT!, main, ["worktree", "add", "-q", linked]);
      // Git resolves the three roots. A linked worktree has a `.git` file, and its Git directory lies below the common directory.
      const lines = fixtureGit(GIT!, linked, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"]).split("\n");
      const [worktreeRoot, gitDirectory, commonDirectory] = lines.slice(0, 3).map((line) => resolve(line));
      const repository = await registerRoots(linked, worktreeRoot!, gitDirectory!, commonDirectory!);
      expect(
        await facts(true, [common("hooks", "pre-commit"), gitDir("hooks", "pre-commit"), gitDir("commondir"), tree(".git"), tree("hooks")], repository),
      ).toEqual([
        file(join(commonDirectory!, "hooks", "pre-commit"), { digest: ABC }),
        ABSENT,
        file(join(gitDirectory!, "commondir"), { digest: sha256(readFileSync(join(gitDirectory!, "commondir"))) }),
        file(join(worktreeRoot!, ".git"), { digest: sha256(readFileSync(join(worktreeRoot!, ".git"))) }),
        ABSENT,
      ]);
    },
    CASE_TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a symlink gives link with its component index and stored text, and the double never follows it",
    [...W, "symlink"],
    async () => {
      const unc = "\\\\nonexistent.invalid\\share";
      symlinkSync(outside, join(main, "share"), "dir");
      symlinkSync(unc, join(main, "unc"), "dir");
      symlinkSync("pre-commit", join(hooks, "relative"), "file");
      // Contract §6 "File facts" `target`: the `SubstituteName` on Windows, the `readlink` text on POSIX.
      // POSIX.1-2024 XBD 4.16 "Pathname Resolution": a pathname that begins with a slash is absolute.
      const share: FileFact = { kind: "link", component: 1, tag: "symlink", target: isWindows ? `\\??\\${outside}` : outside, relative: false };
      const uncLink: FileFact = isWindows
        ? { kind: "link", component: 1, tag: "symlink", target: "\\??\\UNC\\nonexistent.invalid\\share", relative: false }
        : { kind: "link", component: 1, tag: "symlink", target: unc, relative: true };
      expect(
        await facts(true, [tree("share"), tree("share", "pre-commit"), gitDir("hooks", "relative"), tree("unc"), tree("unc", "hooks")]),
      ).toEqual([share, share, { kind: "link", component: 2, tag: "symlink", target: "pre-commit", relative: true }, uncLink, uncLink]);
      expect(lastReads()).toEqual([0, 0, 0, 0, 0]);
    },
    CASE_TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a junction gives link with tag junction and its \\??\\ target, also as a middle component",
    [...W, "ntfs-junction"],
    async () => {
      symlinkSync(outside, join(hooks, "linked"), "junction");
      symlinkSync(outside, join(main, "scripts"), "junction");
      const link = (component: number): FileFact => ({ kind: "link", component, tag: "junction", target: `\\??\\${outside}`, relative: false });
      expect(await facts(true, [gitDir("hooks", "linked"), gitDir("hooks", "linked", "pre-commit"), tree("scripts", "pre-commit")])).toEqual([link(2), link(2), link(1)]);
      expect(lastReads()).toEqual([0, 0, 0]);
    },
    CASE_TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a component that exists but cannot be read gives error with its index and the contract code",
    [...W, "read-denial"],
    async () => {
      const denied = join(hooks, "denied");
      writeFileSync(denied, "abc");
      denyRead(denied);
      try {
        expect(await facts(true, [gitDir("hooks", "denied")])).toEqual([{ kind: "error", component: 2, code: "access-denied" }]);
        // Contract §6 "File facts": the Windows shell opens a final component with attribute access only when `digest` is false.
        if (isWindows) expect(await facts(false, [gitDir("hooks", "denied")])).toEqual([file(denied)]);
      } finally {
        allowRead(denied);
      }
    },
    CASE_TIMEOUT_MS,
  );

  // 200 UTF-16 units pass the component rule. NTFS holds 255 UTF-16 units per name, so the Windows open gives a not-found result.
  // Their 400 UTF-8 bytes pass the 255-byte NAME_MAX of Linux file systems, so the POSIX open gives ENAMETOOLONG.
  caseTest(
    TASK,
    isWindows ? "Windows: a 200-unit component that does not exist gives absent" : "POSIX: a 200-unit component of 400 UTF-8 bytes gives error with code other-error from ENAMETOOLONG",
    W,
    async () => {
      const name = "é".repeat(200);
      const expected: FileFact = isWindows ? ABSENT : { kind: "error", component: 2, code: "other-error" };
      // Oracle: `lstat` in the test process gives the same open result.
      expect(oracle(join(hooks, name), 2)).toEqual(expected);
      expect(await facts(true, [gitDir("hooks", name)])).toEqual([expected]);
    },
    CASE_TIMEOUT_MS,
  );

  // Contract §6 "File facts": a root that exists but cannot be opened gives `error` with component 0.
  // `CreateFileW` always asks for `SYNCHRONIZE`, and the generic read right `R` holds it. POSIX mode 0 denies the directory open.
  caseTest(
    TASK,
    "a root that exists but cannot be opened gives error with component 0 and code access-denied",
    [...W, "read-denial"],
    async () => {
      const root = fixtureDir("denied-root");
      const repository = await registerRoots(main, root, root, root);
      if (isWindows) icacls([root, "/deny", `${userInfo().username}:(R)`]);
      else chmodSync(root, 0);
      try {
        const denied: FileFact = { kind: "error", component: 0, code: "access-denied" };
        expect(await facts(true, [gitDir("hooks"), tree("x", "y")], repository)).toEqual([denied, denied]);
      } finally {
        if (isWindows) icacls([root, "/remove:d", userInfo().username]);
        else chmodSync(root, 0o755);
      }
    },
    CASE_TIMEOUT_MS,
  );

  // Contract §6 "File facts" `other`: a FIFO is no regular file, directory, or link.
  caseTest(
    TASK,
    "a FIFO gives other, and the request returns without a hang",
    [...W, "fifo"],
    async () => {
      const fifo = join(hooks, "fifo");
      const mkfifo = Bun.spawnSync(["mkfifo", "-m", "0644", fifo], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      if (mkfifo.exitCode !== 0) throw new Error(`mkfifo exited ${mkfifo.exitCode}: ${mkfifo.stderr.toString()}`);
      // A writer at the bound ends a blocked open or read in this process. The elapsed time then shows the hang.
      const helper = Bun.spawn(
        [process.execPath, "-e", "await Bun.sleep(Number(process.env.BOUND_MS)); require('node:fs').closeSync(require('node:fs').openSync(process.env.FIFO, 'w'));"],
        { env: { ...process.env, FIFO: fifo, BOUND_MS: String(FIFO_BOUND_MS) }, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      );
      try {
        const started = performance.now();
        const entries = [gitDir("hooks", "fifo"), gitDir("hooks", "fifo", "x")];
        expect(await facts(true, entries)).toEqual([OTHER, ABSENT]);
        expect(await facts(false, entries)).toEqual([OTHER, ABSENT]);
        expect(lastReads()).toEqual([0, 0]);
        expect(performance.now() - started).toBeLessThan(FIFO_BOUND_MS);
      } finally {
        helper.kill("SIGKILL");
        await Promise.race([helper.exited, Bun.sleep(HELPER_EXIT_MS)]);
      }
    },
    CASE_TIMEOUT_MS,
  );
});

// POSIX mode 0100 denies the read and keeps the execute bit. On Windows, an ACL entry denies the data read (`RD`).
// The generic read right `R` also holds `FILE_READ_ATTRIBUTES` and `SYNCHRONIZE`, so it would deny the attribute open too.
function denyRead(path: string): void {
  if (isWindows) icacls([path, "/deny", `${userInfo().username}:(RD)`]);
  else chmodSync(path, 0o100);
}

function allowRead(path: string): void {
  if (isWindows) icacls([path, "/remove:d", userInfo().username]);
  else chmodSync(path, 0o644);
}

function icacls(args: string[]): void {
  const proc = Bun.spawnSync(["icacls", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`icacls ${args.join(" ")} exited ${proc.exitCode}`);
}
