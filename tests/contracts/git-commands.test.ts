// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { HISTORY_STREAM_ROWS } from "../../src/contracts/limits";
import * as commands from "../../src/git-service/commands";
import {
  batchCommandArgs,
  configListArgs,
  discoveryProfiles,
  hooksPathArgs,
  indexFlagArgs,
  indexListArgs,
  objectCheckArgs,
  revListArgs,
  shallowPathArgs,
  statusArgs,
} from "../../src/git-service/commands";
import { useFixtureRoot } from "../git/fixture-root";
import { buildF02 } from "../git/fixtures";
import { GIT } from "../git/git-binary";
import { caseTest, openService } from "../git/service-harness";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/git-service/commands.ts", import.meta.dir);

// Contract §7 "Missing objects": every array starts with `--no-lazy-fetch`. Reads also pass `--no-optional-locks`, and T067 adds `--literal-pathspecs`.
const R = ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs"];
const SHA1 = "0123456789abcdef0123456789abcdef01234567";
const SHA256 = "0123456789abcdef".repeat(4);
const SERVICE_TIMEOUT_MS = 120_000;

// Each T076 read builder with fixed valid inputs.
const READ_BUILDERS: [string, () => string[]][] = [
  ["configListArgs", () => configListArgs()],
  ["hooksPathArgs", () => hooksPathArgs()],
  ["shallowPathArgs", () => shallowPathArgs()],
  ["statusArgs", () => statusArgs()],
  ["indexListArgs", () => indexListArgs()],
  ["indexFlagArgs", () => indexFlagArgs()],
  ["revListArgs", () => revListArgs(SHA1, "sha1")],
  ["batchCommandArgs", () => batchCommandArgs()],
  ["objectCheckArgs", () => objectCheckArgs()],
  ["indexEntryArgs", () => commands.indexEntryArgs()],
  ["headTargetArgs", () => commands.headTargetArgs()],
  ["markerPathArgs", () => commands.markerPathArgs()],
  ["refPathArgs", () => commands.refPathArgs("refs/heads/main")],
  ["pseudorefExistsArgs", () => commands.pseudorefExistsArgs("CHERRY_PICK_HEAD")],
  ["recheckArgs", () => commands.recheckArgs()],
  ["stagedPatchArgs", () => commands.stagedPatchArgs(SHA1, "sha1", "a.txt")],
  ["stagedNameStatusArgs", () => commands.stagedNameStatusArgs(SHA1, "sha1")],
  ["unstagedPatchArgs", () => commands.unstagedPatchArgs("a.txt")],
  ["untrackedPatchArgs", () => commands.untrackedPatchArgs("a.txt")],
  ["stagedNumstatArgs", () => commands.stagedNumstatArgs(SHA1, "sha1", "a.txt")],
  ["unstagedNumstatArgs", () => commands.unstagedNumstatArgs("a.txt")],
  ["untrackedNumstatArgs", () => commands.untrackedNumstatArgs("a.txt")],
  ["attributeArgs", () => commands.attributeArgs()],
  ["lineEndingArgs", () => commands.lineEndingArgs()],
  ["emptyTreeArgs", () => commands.emptyTreeArgs()],
  ["commitTreeArgs", () => commands.commitTreeArgs(SHA1, "sha1")],
  ["reflogArgs", () => commands.reflogArgs()],
  ["reflogArgs(1)", () => commands.reflogArgs(1)],
  ["blobFilterProofArgs", () => commands.blobFilterProofArgs("a.txt", SHA1, "sha1")],
  ["blobHashProofArgs", () => commands.blobHashProofArgs("a.txt")],
  ["gitmodulesListArgs", () => commands.gitmodulesListArgs()],
  ["gitmodulesIndexArgs", () => commands.gitmodulesIndexArgs(SHA1, "sha1")],
  ["gitmodulesHeadArgs", () => commands.gitmodulesHeadArgs()],
  ["modulesPathArgs", () => commands.modulesPathArgs()],
  ["gitlinkPatchArgs", () => commands.gitlinkPatchArgs(["sub"])],
];

// The arrays of every exported builder without a parameter. `discoveryProfiles` gives several arrays.
function zeroParameterArrays(): { name: string; args: unknown }[] {
  const found: { name: string; args: unknown }[] = [];
  for (const [name, value] of Object.entries(commands)) {
    if (typeof value !== "function" || value.length !== 0) continue;
    const result: unknown = Reflect.apply(value, undefined, []);
    const arrays = Array.isArray(result) && result.length > 0 && result.every(Array.isArray) ? result : [result];
    for (const args of arrays) found.push({ name, args });
  }
  return found;
}

describe("read builders (contract §7)", () => {
  test("configListArgs lists the effective configuration with scopes and origins", () => {
    expect(configListArgs()).toEqual([...R, "config", "list", "--show-scope", "--show-origin", "-z"]);
  });

  // Contract §3 "References result": the one fixed array. It takes no pathspec, so it has no `--literal-pathspecs`.
  test("refsArgs is exactly the contract for-each-ref array", () => {
    expect(commands.refsArgs()).toEqual([
      "--no-lazy-fetch",
      "--no-optional-locks",
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(symref)%00%(upstream)%00%(HEAD)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
      "refs/stash",
    ]);
    expect(commands.refsArgs()).not.toBe(commands.refsArgs());
  });

  test("hooksPathArgs and shallowPathArgs are the exact rev-parse --git-path arrays", () => {
    expect(hooksPathArgs()).toEqual([...R, "rev-parse", "--git-path", "hooks"]);
    expect(shallowPathArgs()).toEqual([...R, "rev-parse", "--git-path", "shallow"]);
  });

  test("statusArgs is the exact porcelain v2 read and carries --ignore-submodules=dirty", () => {
    expect(statusArgs()).toEqual([...R, "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--find-renames", "--ignore-submodules=dirty"]);
    expect(statusArgs()).toContain("--ignore-submodules=dirty");
  });

  test("indexListArgs is exact, and indexFlagArgs reads the whole index without -- or a path", () => {
    expect(indexListArgs()).toEqual([...R, "ls-files", "-z", "--stage"]);
    const flags = indexFlagArgs();
    expect(flags.slice(0, 4)).toEqual([...R, "ls-files"]);
    expect(flags).not.toContain("--");
    for (const option of flags.slice(4)) expect(option).toStartWith("-");
  });

  test(`revListArgs takes one full OID of the object format and reads at most ${HISTORY_STREAM_ROWS} rows`, () => {
    expect(revListArgs(SHA1, "sha1")).toEqual([...R, "rev-list", "--parents", `--max-count=${HISTORY_STREAM_ROWS}`, "--date-order", SHA1]);
    expect(revListArgs(SHA256, "sha256")).toEqual([...R, "rev-list", "--parents", `--max-count=${HISTORY_STREAM_ROWS}`, "--date-order", SHA256]);
  });

  test.each([
    ["HEAD", "sha1"],
    ["main", "sha1"],
    ["--all", "sha1"],
    ["a..b", "sha1"],
    [`${SHA1}..${SHA1}`, "sha1"],
    ["-n1", "sha1"],
    [SHA1.toUpperCase(), "sha1"],
    [SHA1.slice(1), "sha1"],
    [`${SHA1}0`, "sha1"],
    [SHA256, "sha1"],
    [SHA1, "sha256"],
    [SHA256.toUpperCase(), "sha256"],
    ["", "sha1"],
  ] as const)("revListArgs refuses %j for %s with TypeError", (oid, objectFormat) => {
    expect(() => revListArgs(oid, objectFormat)).toThrow(TypeError);
  });

  test("refPathArgs asks Git for the absolute file of one ref (T088 decision E7)", () => {
    expect(commands.refPathArgs("refs/heads/main")).toEqual([...R, "rev-parse", "--path-format=absolute", "--git-path", "refs/heads/main"]);
    expect(commands.refPathArgs("refs/bisect/bad")).toEqual([...R, "rev-parse", "--path-format=absolute", "--git-path", "refs/bisect/bad"]);
  });

  test.each(["HEAD", "main", "--all", "-x", "refs/heads/", "refs/heads/a..b", "refs/heads/a b", "refs/heads/x.lock", ""])("refPathArgs refuses %j with TypeError", (name) => {
    expect(() => commands.refPathArgs(name)).toThrow(TypeError);
  });

  test("batchCommandArgs uses -Z framing, and the object check takes object IDs only on stdin", () => {
    expect(batchCommandArgs()).toEqual([...R, "cat-file", "--batch-command", "-Z"]);
    expect(objectCheckArgs()).toEqual([...R, "cat-file", "--batch-check"]);
    expect(objectCheckArgs.length).toBe(0);
  });

  test.each(READ_BUILDERS)("%s starts with --no-lazy-fetch, then --no-optional-locks and --literal-pathspecs", (_name, build) => {
    expect(build().slice(0, 3)).toEqual(R);
  });

  test.each(READ_BUILDERS)("%s returns a new array, and a change to it leaves the next call unchanged", (_name, build) => {
    const first = build();
    const copy = [...first];
    expect(build()).not.toBe(first);
    first.push("--output=x");
    first[0] = "-rf";
    expect(build()).toEqual(copy);
  });
});

describe("discovery profiles (contract §6 `repositoryDiscovery`, research.md R2)", () => {
  test("the first profile asks only whether the folder is bare or inside the Git directory", () => {
    expect(discoveryProfiles()[0]).toEqual(["--no-lazy-fetch", "rev-parse", "--is-bare-repository", "--is-inside-git-dir"]);
  });

  test("each profile starts with --no-lazy-fetch, and its command is rev-parse, symbolic-ref, or show-ref", () => {
    const profiles: string[][] = discoveryProfiles();
    expect(profiles.length).toBeGreaterThan(0);
    for (const profile of profiles) {
      expect(profile[0]).toBe("--no-lazy-fetch");
      expect(["rev-parse", "symbolic-ref", "show-ref"]).toContain(profile[1]);
    }
  });

  test("HEAD is read with symbolic-ref -q HEAD and show-ref --head --verify HEAD", () => {
    const profiles: string[][] = discoveryProfiles();
    expect(profiles).toContainEqual(["--no-lazy-fetch", "symbolic-ref", "-q", "HEAD"]);
    expect(profiles).toContainEqual(["--no-lazy-fetch", "show-ref", "--head", "--verify", "HEAD"]);
  });

  test("the profiles together ask for every identity query", () => {
    const profiles: string[][] = discoveryProfiles();
    const items = profiles.flat();
    for (const query of ["--show-toplevel", "--absolute-git-dir", "--git-common-dir", "--show-object-format", "--show-ref-format"]) expect(items).toContain(query);
    expect(profiles.some((p) => p.some((item, i) => item === "--git-path" && p[i + 1] === "index"))).toBe(true);
  });

  test("no profile loads the index or takes a read lock option", () => {
    for (const profile of discoveryProfiles()) {
      expect(profile).not.toContain("--shared-index-path");
      expect(profile).not.toContain("ls-files");
      expect(profile).not.toContain("--no-optional-locks");
    }
  });

  test("each call returns new arrays, and a change to them leaves the next call unchanged", () => {
    const first: string[][] = discoveryProfiles();
    const copy = first.map((p) => [...p]);
    expect(discoveryProfiles()).not.toBe(first);
    expect(discoveryProfiles()[0]).not.toBe(first[0]);
    first[0].push("--output=x");
    first.push(["-rf"]);
    expect(discoveryProfiles()).toEqual(copy);
  });
});

// T067: the version probe is the one array without `--no-lazy-fetch`. `src/git-service/git-installation.ts` already builds it, so `commands.ts` has no exception.
test("every builder of commands.ts without a parameter starts each array with --no-lazy-fetch", () => {
  const arrays = zeroParameterArrays();
  const names = new Set(arrays.map((a) => a.name));
  for (const name of ["discoveryProfiles", "configListArgs", "hooksPathArgs", "shallowPathArgs", "statusArgs", "indexListArgs", "indexFlagArgs", "batchCommandArgs", "objectCheckArgs"]) {
    expect(names).toContain(name);
  }
  for (const { name, args } of arrays) {
    expect({ name, first: Array.isArray(args) ? args[0] : args }).toEqual({ name, first: "--no-lazy-fetch" });
  }
});

const gitPath = (): string => {
  if (GIT === null) throw new Error("Git executable absent");
  return GIT;
};

// Contract §6 `gitProbe` and §7 "Missing objects": only the exec-path and version probes of `git-installation.ts` run without `--no-lazy-fetch`.
describe("service arrays", () => {
  useFixtureRoot();

  caseTest(
    "T067",
    "the service starts every Git array with --no-lazy-fetch except the gitProbe --exec-path and version --build-options probes, and reads add the read options",
    ["shell-double"],
    async () => {
      const git = gitPath();
      const repo = join(buildF02(git, "t067-f02").root, "repo");
      const service = await openService({ git, name: "t067-service" });
      try {
        const { repositoryId, generation } = await service.register(repo);
        expect((await service.readTrust(repositoryId)).state).toBe("succeeded");
        expect((await service.readWorkspace(repositoryId)).state).toBe("succeeded");
        expect((await service.readHistory(repositoryId, generation)).state).toBe("succeeded");
        const calls = service.runner.calls;
        const probes = calls.filter((c) => c.contextKind === "gitProbe").map((c) => [...c.arguments]);
        expect(probes).toContainEqual(["version", "--build-options"]);
        for (const args of probes) expect([["--exec-path"], ["version", "--build-options"], ["--no-lazy-fetch", "var", "GIT_CONFIG_SYSTEM"], ["--no-lazy-fetch", "var", "GIT_CONFIG_GLOBAL"]]).toContainEqual(args);
        const others = calls.filter((c) => c.contextKind !== "gitProbe");
        expect(others.map((c) => c.contextKind)).toEqual(expect.arrayContaining(["repositoryDiscovery", "registeredOperation"]));
        for (const c of others) expect({ args: c.arguments, first: c.arguments[0] }).toEqual({ args: c.arguments, first: "--no-lazy-fetch" });
        const reads = others.filter((c) => c.environmentPolicy === "read");
        expect(reads.length).toBeGreaterThan(0);
        for (const c of reads) expect({ args: c.arguments, global: c.arguments.slice(0, 3) }).toEqual({ args: c.arguments, global: R });
      } finally {
        await service.dispose();
      }
    },
    SERVICE_TIMEOUT_MS,
  );
});

// The string arrays of every builder without a parameter.
const builderArrays = (): string[][] =>
  zeroParameterArrays()
    .map((a) => a.args)
    .filter((args): args is string[] => Array.isArray(args) && args.every((item) => typeof item === "string"));

// The path builders of T101, T199, and T227. Each puts the literal item after `--`.
const LITERAL_AFTER_SEPARATOR: [string, (value: string) => string[], (value: string) => string][] = [
  ["stagedPatchArgs", (p) => commands.stagedPatchArgs(SHA1, "sha1", p), (p) => p],
  ["unstagedPatchArgs", (p) => commands.unstagedPatchArgs(p), (p) => p],
  ["untrackedPatchArgs", (p) => commands.untrackedPatchArgs(p), (p) => p],
  ["stagedNumstatArgs", (p) => commands.stagedNumstatArgs(SHA1, "sha1", p), (p) => p],
  ["unstagedNumstatArgs", (p) => commands.unstagedNumstatArgs(p), (p) => p],
  ["untrackedNumstatArgs", (p) => commands.untrackedNumstatArgs(p), (p) => p],
  ["gitlinkPatchArgs", (p) => commands.gitlinkPatchArgs([p]), (p) => p],
  ["activeSetArgs", (p) => commands.activeSetArgs([p]), (p) => p],
  ["submoduleCloneArgs", (p) => commands.submoduleCloneArgs("C:/repo", p), (p) => `:(literal)${p}`],
  ["submoduleCheckoutArgs", (p) => commands.submoduleCheckoutArgs("C:/repo", p), (p) => `:(literal)${p}`],
  ["submoduleRegisterArgs", (p) => commands.submoduleRegisterArgs("C:/repo", p), (p) => `:(literal)${p}`],
  ["submoduleFallbackFetchArgs", (p) => commands.submoduleFallbackFetchArgs("C:/repo/sub", p, SHA1, "sha1"), (p) => p],
  ["remoteUrlArgs", (p) => commands.remoteUrlArgs({ worktree: "C:/repo/sub" }, p), (p) => p],
];
test.each(LITERAL_AFTER_SEPARATOR)("%s puts `--` before the path, and option-like names stay single literal items after `--`", (_name, build, literal) => {
  for (const value of ["-rf", "--output=x", "a b/c d.txt"]) {
    const args = build(value);
    const at = args.indexOf(literal(value));
    expect(args.filter((item) => item === literal(value))).toHaveLength(1);
    expect(args.indexOf("--")).toBeGreaterThan(-1);
    expect(args.indexOf("--")).toBeLessThan(at);
  }
  for (const value of ["", "a\0b"]) expect(() => build(value)).toThrow(TypeError);
});
// Contract §4 and §7: Git runs in the worktree root, and the path is relative to that root (research R3).
test("the untracked read is the T092 form, and the path stays one literal item after `--`", () => {
  const form = ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--", "/dev/null"];
  expect(commands.untrackedPatchArgs("dir/u-crlf.txt")).toEqual([...R, ...form, "dir/u-crlf.txt"]);
  for (const path of ["-rf", "--output=x", "a b/c d.txt"]) expect(commands.untrackedPatchArgs(path)).toEqual([...R, ...form, path]);
  for (const path of ["", "a\0b"]) expect(() => commands.untrackedPatchArgs(path)).toThrow(TypeError);
});

// Contract §7: status and diff reads pass `--ignore-submodules=dirty`. The patch reads also carry `--no-textconv --no-ext-diff --no-relative` and fixed prefixes.
test("diff reads carry `--ignore-submodules=dirty`, and the patch reads carry `--no-textconv --no-ext-diff`", () => {
  const patch = ["-p", "--no-textconv", "--no-ext-diff", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "--ignore-submodules=dirty"];
  expect(commands.stagedPatchArgs(SHA1, "sha1", "-rf")).toEqual([...R, "diff-index", "--cached", ...patch, SHA1, "--", "-rf"]);
  expect(commands.stagedPatchArgs(SHA256, "sha256", "a.txt")).toEqual([...R, "diff-index", "--cached", ...patch, SHA256, "--", "a.txt"]);
  expect(commands.unstagedPatchArgs("--output=x")).toEqual([...R, "diff-files", ...patch, "--", "--output=x"]);
  expect(commands.stagedNameStatusArgs(SHA1, "sha1")).toEqual([...R, "diff-index", "--cached", "-z", "--name-status", "--ignore-submodules=dirty", SHA1]);
  for (const oid of ["HEAD", SHA256, "--all", ""]) {
    expect(() => commands.stagedPatchArgs(oid, "sha1", "a.txt")).toThrow(TypeError);
    expect(() => commands.stagedNameStatusArgs(oid, "sha1")).toThrow(TypeError);
  }
  for (const path of ["", "a\0b"]) {
    expect(() => commands.stagedPatchArgs(SHA1, "sha1", path)).toThrow(TypeError);
    expect(() => commands.unstagedPatchArgs(path)).toThrow(TypeError);
  }
});

// T103: reason `binary` comes from `--numstat -z`. git-diff(1) `--numstat`: "For binary files, outputs two `-` instead of saying `0 0`."
test("the numstat reads of the three comparison scopes are exact", () => {
  const options = ["--numstat", "-z", "--no-textconv", "--no-ext-diff", "--no-relative", "--ignore-submodules=dirty"];
  expect(commands.stagedNumstatArgs(SHA1, "sha1", "-rf")).toEqual([...R, "diff-index", "--cached", ...options, SHA1, "--", "-rf"]);
  expect(commands.unstagedNumstatArgs("a b.txt")).toEqual([...R, "diff-files", ...options, "--", "a b.txt"]);
  expect(commands.untrackedNumstatArgs("--output=x")).toEqual([...R, "diff", "--no-index", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--no-color", "--", "/dev/null", "--output=x"]);
  for (const oid of ["HEAD", SHA256, ""]) expect(() => commands.stagedNumstatArgs(oid, "sha1", "a.txt")).toThrow(TypeError);
  for (const path of ["", "a\0b"]) {
    expect(() => commands.stagedNumstatArgs(SHA1, "sha1", path)).toThrow(TypeError);
    expect(() => commands.unstagedNumstatArgs(path)).toThrow(TypeError);
    expect(() => commands.untrackedNumstatArgs(path)).toThrow(TypeError);
  }
});

// Contract §7 read list and T103: the attribute, line-ending, and empty-tree reads. Paths go only on stdin.
test("the attribute, line-ending, and empty-tree reads are exact", () => {
  expect(commands.attributeArgs()).toEqual([...R, "check-attr", "-z", "--stdin", "filter", "diff", "text", "eol", "crlf", "working-tree-encoding"]);
  expect(commands.lineEndingArgs()).toEqual([...R, "ls-files", "--eol", "-z"]);
  expect(commands.emptyTreeArgs()).toEqual([...R, "hash-object", "-t", "tree", "--stdin"]);
});
test("`hash-object` arrays hold `--stdin` and never `-w`, and `hash-object -t tree --stdin` exists", () => {
  const hashes = [...builderArrays(), commands.blobHashProofArgs("a.txt")].filter((args) => args.includes("hash-object"));
  expect(hashes.length).toBeGreaterThanOrEqual(3);
  expect(hashes.some((args) => args.includes("-t") && args.includes("tree") && args.includes("--stdin"))).toBe(true);
  for (const args of hashes) {
    expect(args).toContain("--stdin");
    expect(args).not.toContain("-w");
  }
});
const endsWith = (args: string[], tail: string[]) => args.length > tail.length && tail.every((item, i) => args[args.length - tail.length + i] === item);
test("the applyHunk and applyFile steps start with `--no-lazy-fetch`, end with the contract §4 forms, and `apply --cached` reads the retained patch on stdin", () => {
  const arrays = builderArrays();
  for (const tail of [["read-tree", "--empty"], ["update-index", "--add", "--remove", "-z", "--stdin"], ["update-index", "-z", "--index-info"], ["hash-object", "--no-filters", "--stdin"]]) {
    expect({ tail, found: arrays.some((args) => args[0] === "--no-lazy-fetch" && endsWith(args, tail)) }).toEqual({ tail, found: true });
  }
});
test("the commit array is exactly `--no-lazy-fetch commit --quiet --file=-`", () => {
  expect(builderArrays()).toContainEqual(["--no-lazy-fetch", "commit", "--quiet", "--file=-"]);
});
// T104: the mutation steps take only `--no-lazy-fetch`. The `mutation` policy and a `transactionId` select the candidate index, so no array names it.
test("the T104 mutation arrays are exact, and the ls-tree read takes one full commit OID", () => {
  const N = "--no-lazy-fetch";
  expect(commands.applyCachedArgs()).toEqual([N, "apply", "--cached"]);
  expect(commands.applyCachedReverseArgs()).toEqual([N, "apply", "--cached", "--reverse"]);
  expect(commands.readTreeEmptyArgs()).toEqual([N, "read-tree", "--empty"]);
  expect(commands.entryHashArgs()).toEqual([N, "hash-object", "--no-filters", "--stdin"]);
  expect(commands.authorIdentArgs()).toEqual([N, "var", "GIT_AUTHOR_IDENT"]);
  expect(commands.committerIdentArgs()).toEqual([N, "var", "GIT_COMMITTER_IDENT"]);
  expect(commands.commitArgs()).toEqual([N, "commit", "--quiet", "--file=-"]);
  expect(commands.processEndArgs()).toEqual([N, "version"]);
  expect(commands.commitTreeArgs(SHA1, "sha1")).toEqual([...R, "ls-tree", "-r", "-z", SHA1]);
  expect(commands.commitTreeArgs(SHA256, "sha256")).toEqual([...R, "ls-tree", "-r", "-z", SHA256]);
  for (const oid of ["HEAD", "--full-tree", SHA256, ""]) expect(() => commands.commitTreeArgs(oid, "sha1")).toThrow(TypeError);
  for (const args of builderArrays()) {
    expect(args).not.toContain("--index");
    expect(args.join("\0")).not.toContain("GIT_INDEX_FILE");
  }
});
// T199: the contract §4 "File staging" step 5 forms and the "Blob proof" reads. The update steps read their input on stdin.
test("the T199 file-staging arrays and blob proofs are exact", () => {
  const N = "--no-lazy-fetch";
  expect(commands.updateIndexAddArgs()).toEqual([N, "update-index", "--add", "--remove", "-z", "--stdin"]);
  expect(commands.updateIndexInfoArgs()).toEqual([N, "update-index", "-z", "--index-info"]);
  expect(commands.blobFilterProofArgs("dir/a b.txt", SHA1, "sha1")).toEqual([...R, "cat-file", "--filters", "--path=dir/a b.txt", SHA1]);
  expect(commands.blobFilterProofArgs("-rf", SHA256, "sha256")).toEqual([...R, "cat-file", "--filters", "--path=-rf", SHA256]);
  expect(commands.blobHashProofArgs("--output=x")).toEqual([...R, "hash-object", "--stdin", "--path=--output=x"]);
  for (const oid of ["HEAD", SHA256, "--all", ""]) expect(() => commands.blobFilterProofArgs("a.txt", oid, "sha1")).toThrow(TypeError);
  for (const path of ["", "a\0b"]) {
    expect(() => commands.blobFilterProofArgs(path, SHA1, "sha1")).toThrow(TypeError);
    expect(() => commands.blobHashProofArgs(path)).toThrow(TypeError);
  }
});

// T227: contract §12 "Review reads". Each read inside a submodule starts with `--no-lazy-fetch --no-optional-locks` and then `-C <worktree> --git-dir=.git`, or `--git-dir=<dir> --work-tree=<dir>` for a kept Git directory.
// T231: `--git-dir=.git` stops Git discovery in the parent folders (contract §12 "Review reads").
test("the T227 submodule review reads are exact for a worktree and for a kept Git directory", () => {
  const W = ["--no-lazy-fetch", "--no-optional-locks", "-C", "C:/repo/sub", "--git-dir=.git"];
  const K = ["--no-lazy-fetch", "--no-optional-locks", "--git-dir=C:/repo/.git/modules/a/b", "--work-tree=C:/repo/.git/modules/a/b"];
  for (const [location, prefix] of [[{ worktree: "C:/repo/sub" }, W], [{ gitDir: "C:/repo/.git/modules/a/b" }, K]] as const) {
    expect(commands.submoduleHeadOidArgs(location)).toEqual([...prefix, "rev-parse", "--verify", "-q", "HEAD"]);
    expect(commands.submoduleGitDirArgs(location)).toEqual([...prefix, "rev-parse", "--absolute-git-dir"]);
    expect(commands.submoduleHooksPathArgs(location)).toEqual([...prefix, "rev-parse", "--git-path", "hooks"]);
    expect(commands.submoduleHeadTargetArgs(location)).toEqual([...prefix, "symbolic-ref", "-q", "HEAD"]);
    expect(commands.submoduleRefExistsArgs(location, "refs/heads/main")).toEqual([...prefix, "show-ref", "--exists", "refs/heads/main"]);
    expect(commands.submoduleRefExistsArgs(location, "master")).toEqual([...prefix, "show-ref", "--exists", "master"]);
    expect(commands.submoduleHeadTargetNoRecurseArgs(location)).toEqual([...prefix, "symbolic-ref", "--no-recurse", "-q", "HEAD"]);
    expect(commands.submoduleRefFormatArgs(location, "refs/heads/.invalid")).toEqual([...prefix, "check-ref-format", "--allow-onelevel", "refs/heads/.invalid"]);
    expect(commands.submoduleConfigListArgs(location)).toEqual([...prefix, "config", "list", "--show-scope", "--show-origin", "-z"]);
    expect(commands.submoduleHeadRefArgs(location)).toEqual([...prefix, "for-each-ref", "--contains=HEAD", "--count=1", "--format=%(refname)"]);
    expect(commands.submoduleObjectCheckArgs(location)).toEqual([...prefix, "cat-file", "--batch-check"]);
    expect(commands.submoduleReachArgs(location, SHA1, "sha1")).toEqual([...prefix, "rev-list", "-n", "1", SHA1, "--not", "--all"]);
    expect(commands.submoduleTreeArgs(location, SHA256, "sha256")).toEqual([...prefix, "ls-tree", "-r", "-z", "--full-tree", SHA256]);
    expect(commands.submoduleGitmodulesBlobArgs(location, SHA1, "sha1")).toEqual([...prefix, "config", "--blob", `${SHA1}:.gitmodules`, "--null", "--list"]);
    expect(commands.remoteUrlArgs(location, "origin")).toEqual([...prefix, "remote", "get-url", "--all", "--", "origin"]);
  }
  for (const oid of ["HEAD", SHA256, "--all", ""]) {
    expect(() => commands.submoduleReachArgs({ worktree: "C:/repo/sub" }, oid, "sha1")).toThrow(TypeError);
    expect(() => commands.submoduleTreeArgs({ worktree: "C:/repo/sub" }, oid, "sha1")).toThrow(TypeError);
    expect(() => commands.submoduleGitmodulesBlobArgs({ worktree: "C:/repo/sub" }, oid, "sha1")).toThrow(TypeError);
  }
  // git-check-ref-format(1) `--allow-onelevel` refuses each name except `-x`; the service refuses a leading `-`.
  for (const name of ["@", "-x", "--all", "a\0b", "refs/heads/", "refs/heads/a..b", "a//b", ".a", "a.lock", "a@{b", ""]) expect(() => commands.submoduleRefExistsArgs({ worktree: "C:/repo/sub" }, name)).toThrow(TypeError);
  expect(() => commands.submoduleRefFormatArgs({ worktree: "C:/repo/sub" }, "refs/a\0b")).toThrow(TypeError);
  for (const location of [{ worktree: "" }, { gitDir: "" }, { worktree: "a\0b" }, {}, { worktree: "a", gitDir: "b" }]) {
    expect(() => commands.submoduleHeadOidArgs(location as never)).toThrow(TypeError);
  }
});

// T227: the superproject reads. `--literal-pathspecs` would turn off the pathspec magic of `submodule.active` values, so the active-set read omits it (git(1) `--literal-pathspecs`, git-config(1) `submodule.active`).
test("the T227 superproject submodule reads are exact", () => {
  expect(commands.gitmodulesListArgs()).toEqual([...R, "config", "--file", ".gitmodules", "--null", "--list"]);
  // Contract §7: `:.gitmodules` loads the index, so the index source is its stage-0 object ID.
  expect(commands.gitmodulesIndexArgs(SHA1, "sha1")).toEqual([...R, "config", "--blob", SHA1, "--null", "--list"]);
  expect(commands.gitmodulesIndexArgs(SHA256, "sha256")).toEqual([...R, "config", "--blob", SHA256, "--null", "--list"]);
  for (const oid of [":.gitmodules", "HEAD:.gitmodules", SHA256, "", SHA1.toUpperCase()]) expect(() => commands.gitmodulesIndexArgs(oid, "sha1")).toThrow(TypeError);
  expect(commands.gitmodulesHeadArgs()).toEqual([...R, "config", "--blob", "HEAD:.gitmodules", "--null", "--list"]);
  expect(commands.modulesPathArgs()).toEqual([...R, "rev-parse", "--path-format=absolute", "--git-path", "modules"]);
  expect(commands.gitlinkPatchArgs(["sub", "-rf"])).toEqual([...R, "diff-files", "-p", "--ignore-submodules=dirty", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "--", "sub", "-rf"]);
  expect(commands.activeSetArgs(["sub*", ":(glob)lib/**"])).toEqual(["--no-lazy-fetch", "--no-optional-locks", "ls-files", "-z", "--stage", "--", "sub*", ":(glob)lib/**"]);
  expect(commands.activeSetArgs(["x"], "C:/repo/sub")).toEqual(["--no-lazy-fetch", "--no-optional-locks", "-C", "C:/repo/sub", "--git-dir=.git", "ls-files", "-z", "--stage", "--", "x"]);
  for (const build of [commands.gitlinkPatchArgs, commands.activeSetArgs]) expect(() => build([])).toThrow(TypeError);
  for (const parent of ["", "a\0b"]) expect(() => commands.activeSetArgs(["x"], parent)).toThrow(TypeError);
});

// T227: contract §12 "Update protocol" step 5. The steps take only `--no-lazy-fetch`, as the T104 mutation steps do.
test("the T227 submodule step arrays are exact", () => {
  const N = "--no-lazy-fetch";
  expect(commands.submoduleCloneArgs("C:/repo", "lib/a[1]")).toEqual([N, "-c", "fetch.recurseSubmodules=no", "-C", "C:/repo", "submodule", "update", "--init", "--progress", "--", ":(literal)lib/a[1]"]);
  expect(commands.submoduleCheckoutArgs("C:/repo", "lib/a")).toEqual([N, "-C", "C:/repo", "submodule", "update", "--init", "--no-fetch", "--progress", "--", ":(literal)lib/a"]);
  expect(commands.submoduleRegisterArgs("C:/repo", "lib/a")).toEqual([N, "-C", "C:/repo", "submodule", "init", "--", ":(literal)lib/a"]);
  // T231: a nested row runs its steps in the worktree of its parent submodule (contract §12 "Update protocol" step 5).
  const S = ["-C", "C:/repo/mid", "--git-dir=.git"];
  expect(commands.submoduleCloneArgs("C:/repo/mid", "leaf", true)).toEqual([N, "-c", "fetch.recurseSubmodules=no", ...S, "submodule", "update", "--init", "--progress", "--", ":(literal)leaf"]);
  expect(commands.submoduleCheckoutArgs("C:/repo/mid", "leaf", true)).toEqual([N, ...S, "submodule", "update", "--init", "--no-fetch", "--progress", "--", ":(literal)leaf"]);
  expect(commands.submoduleRegisterArgs("C:/repo/mid", "leaf", true)).toEqual([N, ...S, "submodule", "init", "--", ":(literal)leaf"]);
  expect(commands.submoduleFetchArgs("C:/repo/lib/a")).toEqual([N, "-C", "C:/repo/lib/a", "--git-dir=.git", "fetch", "--progress", "--no-recurse-submodules"]);
  expect(commands.submoduleFallbackFetchArgs("C:/repo/lib/a", "origin", SHA256, "sha256")).toEqual([N, "-C", "C:/repo/lib/a", "--git-dir=.git", "fetch", "--progress", "--no-recurse-submodules", "--", "origin", SHA256]);
  for (const oid of ["HEAD", SHA256, "--all", ""]) expect(() => commands.submoduleFallbackFetchArgs("C:/repo/lib/a", "origin", oid, "sha1")).toThrow(TypeError);
  for (const dir of ["", "a\0b"]) {
    expect(() => commands.submoduleCloneArgs(dir, "a")).toThrow(TypeError);
    expect(() => commands.submoduleCheckoutArgs(dir, "a")).toThrow(TypeError);
    expect(() => commands.submoduleRegisterArgs(dir, "a")).toThrow(TypeError);
    expect(() => commands.submoduleFetchArgs(dir)).toThrow(TypeError);
  }
});

test("the submodule commands start with `--no-lazy-fetch`, list `.gitmodules` with `config --file .gitmodules --null --list`, and never add `--recursive`", () => {
  const location = { worktree: "C:/repo/sub" };
  const submodule = [
    commands.submoduleHeadOidArgs(location),
    commands.submoduleGitDirArgs(location),
    commands.submoduleHooksPathArgs(location),
    commands.submoduleHeadTargetArgs(location),
    commands.submoduleHeadTargetNoRecurseArgs(location),
    commands.submoduleRefFormatArgs(location, "refs/heads/main"),
    commands.submoduleConfigListArgs(location),
    commands.submoduleHeadRefArgs(location),
    commands.submoduleObjectCheckArgs(location),
    commands.submoduleReachArgs(location, SHA1, "sha1"),
    commands.submoduleTreeArgs(location, SHA1, "sha1"),
    commands.submoduleGitmodulesBlobArgs(location, SHA1, "sha1"),
    commands.remoteUrlArgs(location, "origin"),
    commands.gitlinkPatchArgs(["sub"]),
    commands.activeSetArgs(["sub"]),
    commands.submoduleCloneArgs("C:/repo", "sub"),
    commands.submoduleCheckoutArgs("C:/repo", "sub"),
    commands.submoduleRegisterArgs("C:/repo", "sub"),
    commands.submoduleFetchArgs("C:/repo/sub"),
    commands.submoduleFallbackFetchArgs("C:/repo/sub", "origin", SHA1, "sha1"),
  ];
  const arrays = [...builderArrays(), ...submodule];
  expect(arrays.some((args) => ["config", "--file", ".gitmodules", "--null", "--list"].every((item) => args.includes(item)))).toBe(true);
  for (const args of submodule) expect(args[0]).toBe("--no-lazy-fetch");
  for (const args of arrays) expect(args).not.toContain("--recursive");
});

// T021, feature 002 contract Δ3: the view arrays. Every array starts with `--no-lazy-fetch --no-optional-locks` (spec FR-045, FR-051).
describe("history view arrays (feature 002 contract Δ3)", () => {
  const FORMAT = "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(symref)%00%(upstream)%00%(HEAD)";

  test("the openHistory capture uses the 001 HEAD steps, the eight-field for-each-ref over the FR-047 namespaces and refs/replace, and one rev-parse for the topology files", () => {
    expect(commands.headTargetArgs()).toEqual([...R, "symbolic-ref", "-q", "HEAD"]);
    expect(commands.headOidArgs()).toEqual([...R, "rev-parse", "--verify", "-q", "HEAD"]);
    expect(commands.headRefExistsArgs("refs/heads/main")).toEqual([...R, "show-ref", "--exists", "refs/heads/main"]);
    expect(commands.historyRefsArgs()).toEqual(["--no-lazy-fetch", "--no-optional-locks", "for-each-ref", FORMAT, "refs/heads", "refs/remotes", "refs/tags", "refs/stash", "refs/replace"]);
    expect(commands.topologyPathArgs()).toEqual([...R, "rev-parse", "--git-path", "shallow", "--git-path", "info/grafts"]);
  });

  test("a later load step reads the replace records with the same record format", () => {
    expect(commands.replaceRefsArgs()).toEqual(["--no-lazy-fetch", "--no-optional-locks", "for-each-ref", FORMAT, "refs/replace"]);
  });

  test("every load step runs the same rev-list array with the start points on stdin, and no step adds --skip or --max-count", () => {
    const load = ["--no-lazy-fetch", "--no-optional-locks", "rev-list", "--parents", "--date-order", "--stdin"];
    expect(commands.historyLoadArgs()).toEqual(load);
    expect(commands.historyLoadArgs()).toEqual(commands.historyLoadArgs());
    expect(commands.historyLoadArgs().some((item) => item.startsWith("--skip") || item.startsWith("--max-count"))).toBe(false);
    expect(commands.historyLoadArgs.length).toBe(0);
  });

  test("the text read is one cat-file --batch-command -Z", () => {
    expect(commands.batchCommandArgs()).toEqual([...R, "cat-file", "--batch-command", "-Z"]);
  });

  test.each([
    ["historyRefsArgs", () => commands.historyRefsArgs()],
    ["replaceRefsArgs", () => commands.replaceRefsArgs()],
    ["topologyPathArgs", () => commands.topologyPathArgs()],
    ["historyLoadArgs", () => commands.historyLoadArgs()],
  ] as [string, () => string[]][])("%s starts with --no-lazy-fetch --no-optional-locks and returns a new array", (_name, build) => {
    const first = build();
    expect(first.slice(0, 2)).toEqual(["--no-lazy-fetch", "--no-optional-locks"]);
    const copy = [...first];
    first.push("--output=x");
    expect(build()).toEqual(copy);
  });
});
