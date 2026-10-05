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
  hookListArgs,
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
// Contract §7 "Mutation trust": the hooks that `git commit` can run.
const HOOKS = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-index-change", "reference-transaction", "pre-auto-gc"];
const SERVICE_TIMEOUT_MS = 120_000;

// Each T076 read builder with fixed valid inputs.
const READ_BUILDERS: [string, () => string[]][] = [
  ["configListArgs", () => configListArgs()],
  ["hooksPathArgs", () => hooksPathArgs()],
  ["shallowPathArgs", () => shallowPathArgs()],
  ["hookListArgs", () => hookListArgs("pre-commit")],
  ["statusArgs", () => statusArgs()],
  ["indexListArgs", () => indexListArgs()],
  ["indexFlagArgs", () => indexFlagArgs()],
  ["revListArgs", () => revListArgs(SHA1, "sha1")],
  ["batchCommandArgs", () => batchCommandArgs()],
  ["objectCheckArgs", () => objectCheckArgs()],
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

  test("batchCommandArgs uses -Z framing, and the object check takes object IDs only on stdin", () => {
    expect(batchCommandArgs()).toEqual([...R, "cat-file", "--batch-command", "-Z"]);
    expect(objectCheckArgs()).toEqual([...R, "cat-file", "--batch-check"]);
    expect(objectCheckArgs.length).toBe(0);
  });

  test.each(HOOKS.map((hook) => [hook]))("hookListArgs puts the hook event %s last as one item", (hook) => {
    expect(hookListArgs(hook)).toEqual([...R, "hook", "list", "-z", "--show-scope", hook]);
  });

  test.each([["--output=x"], ["x y"], [""]])("hookListArgs refuses %j with TypeError", (event) => {
    expect(() => hookListArgs(event)).toThrow(TypeError);
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
        for (const args of probes) expect([["--exec-path"], ["version", "--build-options"]]).toContainEqual(args);
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

// The builder families of T092, T101, T104, T199, and T227. No task fixes the names of builders with a path parameter yet, so those bodies name the gap.
const unnamed = (task: string) => () => {
  throw new Error(`${task}: no task fixes the name of this path builder yet`);
};
test.todo("`--` comes before any path, and option-like names such as `-rf` and `--output=x` stay single literal items after `--` (needs T101, T199, T227)", unnamed("T101, T199, T227"));
test.todo("the untracked read is the T092 form, and a `diff` form carries `--no-ext-diff --no-textconv`, such as `diff --no-index --no-ext-diff --no-textconv -- /dev/null <path>` (needs T092, T101)", unnamed("T092, T101"));
test.todo("diff reads carry `--ignore-submodules=dirty` and `--no-textconv --no-ext-diff` (needs T101)", unnamed("T101"));
test.todo("`hash-object` arrays hold `--stdin` and never `-w`, and `hash-object -t tree --stdin` exists (needs T101, T104, T199)", () => {
  const hashes = builderArrays().filter((args) => args.includes("hash-object"));
  expect(hashes.some((args) => args.includes("-t") && args.includes("tree") && args.includes("--stdin"))).toBe(true);
  for (const args of hashes) {
    expect(args).toContain("--stdin");
    expect(args).not.toContain("-w");
  }
});
const endsWith = (args: string[], tail: string[]) => args.length > tail.length && tail.every((item, i) => args[args.length - tail.length + i] === item);
test.todo("the applyHunk and applyFile steps start with `--no-lazy-fetch`, end with the contract §4 forms, and `apply --cached` reads the retained patch on stdin (needs T104, T199)", () => {
  const arrays = builderArrays();
  for (const tail of [["read-tree", "--empty"], ["update-index", "--add", "--remove", "-z", "--stdin"], ["update-index", "-z", "--index-info"], ["hash-object", "--no-filters", "--stdin"]]) {
    expect({ tail, found: arrays.some((args) => args[0] === "--no-lazy-fetch" && endsWith(args, tail)) }).toEqual({ tail, found: true });
  }
});
test.todo("the commit array is exactly `--no-lazy-fetch commit --quiet --file=-` (needs T104)", () => {
  expect(builderArrays()).toContainEqual(["--no-lazy-fetch", "commit", "--quiet", "--file=-"]);
});
test.todo("the submodule commands start with `--no-lazy-fetch`, list `.gitmodules` with `config --file .gitmodules --null --list`, and never add `--recursive` (needs T227)", () => {
  const arrays = builderArrays();
  expect(arrays.some((args) => ["config", "--file", ".gitmodules", "--null", "--list"].every((item) => args.includes(item)))).toBe(true);
  for (const args of arrays) expect(args).not.toContain("--recursive");
});
