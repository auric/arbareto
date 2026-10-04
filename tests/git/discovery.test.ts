// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { classifyDiscoveryFailure, safeDirectoryCommand } from "../../src/git-service/discovery";
import { printOrigin } from "../origin";
import { FIXTURE_GLOBAL_CONFIG, FIXTURE_ROOT, fixtureDir, fixtureEnv, ownedGit, realGlobalConfigDigests, removeTree, useFixtureRoot } from "./fixture-root";
import { buildF01, buildF07, buildF08, buildF10, buildF15, buildF17, F15_MARKER, POWERSHELL_QUOTES, put, type Built } from "./fixtures";
import { GIT } from "./git-binary";
import { sha256 } from "./git-oracle";
import { caseTest, openService, type Refusal, type RegistrationResult, type Service, type ServiceResponse } from "./service-harness";

printOrigin("../../src/git-service/discovery.ts", import.meta.dir);
printOrigin("../../src/git-service/registration.ts", import.meta.dir);

const TASK = "T068";
const TIMEOUT_MS = 120_000;
const SHELL_TIMEOUT_MS = 60_000;

// Research R2: the first discovery query. Contract §6: discovery runs under the fixed C locale.
const FIRST_QUERY = ["--no-lazy-fetch", "rev-parse", "--is-bare-repository", "--is-inside-git-dir"];
// Git `t/README`: this knob makes the ownership check fail for every repository.
const OTHER_OWNER = { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" };
// Contract §6 "Registration bootstrap" and research R2.
const DUBIOUS_PREFIX = "fatal: detected dubious ownership in repository at '";
const NOT_A_REPOSITORY_PREFIX = "fatal: not a git repository (or any";
// A fixed selected Git path. The classifier is pure, so it needs no real file.
const SELECTED_GIT = "C:\\Program Files\\Git\\cmd\\git.exe";

// Data-model §2 and contract §6 remedy texts.
const REMEDY = {
  bare: "Open a worktree of it, or clone it",
  administrationFolder: "Open the working folder that contains it",
  unavailable: "Run `git status` in this folder",
  notARepository: "Open a folder inside a Git repository.",
  fileId: "Open the repository from an NTFS or ReFS volume",
};

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

useFixtureRoot();

const gitPath = (): string => {
  if (GIT === null) throw new Error("Git executable absent");
  return GIT;
};
const slash = (path: string) => path.replaceAll("\\", "/");
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// Contract §4 "Quoting rule": PowerShell ends a single-quoted string at U+0027 and U+2018 to U+201B, so each is doubled. U+0022 and U+201C to U+201E refuse the value.
const SINGLE_QUOTES = /['\u2018\u2019\u201A\u201B]/g;
const REFUSED_QUOTES = /["\u201C-\u201E]/;
const psQuote = (value: string) => `'${value.replace(SINGLE_QUOTES, "$&$&")}'`;
function expectedSafeDirectory(gitSelectedPath: string, path: string): string | null {
  if (REFUSED_QUOTES.test(gitSelectedPath) || REFUSED_QUOTES.test(path)) return null;
  return `& ${psQuote(gitSelectedPath)} config --global --add safe.directory ${psQuote(path)}`;
}

function probeDiscovery(git: string, directory: string, extra: Record<string, string> = {}): { exitCode: number; stderr: Uint8Array } {
  const proc = Bun.spawnSync([git, ...FIRST_QUERY], { cwd: directory, env: fixtureEnv({ LC_ALL: "C", ...extra }), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { exitCode: proc.exitCode, stderr: new Uint8Array(proc.stderr) };
}

// `buildF15` makes the hostile folders only on Windows. Off Windows, this makes the same names in the F15 folder.
function hostileRepositories(git: string, built: Built): string[] {
  const names = built.facts.notes.hostile as string[];
  if (names.length > 0) return names.map((name) => join(built.root, "hostile", name));
  return POWERSHELL_QUOTES.map((q) => {
    const dir = fixtureDir(relative(FIXTURE_ROOT, join(built.root, "hostile", `x${q}$(ni ${F15_MARKER})${q}`)));
    ownedGit(git, FIXTURE_ROOT, dir, ["init", "-q"]);
    return dir;
  });
}

// Git's own suggestion, which Git quotes for a POSIX shell.
const gitSuggestion = (stderr: string) => stderr.split("\n").find((line) => line.includes("git config --global --add safe.directory"))?.trim() ?? null;

const markers = () => (readdirSync(FIXTURE_ROOT, { recursive: true }) as string[]).filter((p) => basename(p) === F15_MARKER);

describe("dubious ownership classifier (contract §6, plan.md F15)", () => {
  caseTest(
    TASK,
    "each hostile folder gives DUBIOUS_OWNERSHIP with the Git-reported path and the service-built safe.directory command, never Git's suggested command",
    [],
    () => {
      const git = gitPath();
      const repos = hostileRepositories(git, buildF15(git, "t068-hostile"));
      expect(repos.length).toBe(POWERSHELL_QUOTES.length);
      for (const repo of repos) {
        const failure = probeDiscovery(git, repo, OTHER_OWNER);
        const stderr = text(failure.stderr);
        const path = slash(repo);
        expect({ repo, exitCode: failure.exitCode, line: stderr.split("\n")[0] }).toEqual({ repo, exitCode: 128, line: `${DUBIOUS_PREFIX}${path}'` });
        const refusal = classifyDiscoveryFailure({ exitCode: failure.exitCode, stderr: failure.stderr, directory: repo, gitSelectedPath: SELECTED_GIT });
        const expected = expectedSafeDirectory(SELECTED_GIT, path);
        expect({ repo, code: refusal.code, path: refusal.path, command: refusal.remedy?.command ?? null }).toEqual({ repo, code: "DUBIOUS_OWNERSHIP", path, command: expected });
        expect({ repo, command: safeDirectoryCommand(SELECTED_GIT, path).command }).toEqual({ repo, command: expected });
        const suggestion = gitSuggestion(stderr);
        expect(suggestion).not.toBeNull();
        expect(JSON.stringify(refusal)).not.toContain(suggestion as string);
      }
      expect(markers()).toEqual([]);
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a stderr text without the C-locale prefix gives the path and no command",
    [],
    () => {
      const git = gitPath();
      const [repo] = hostileRepositories(git, buildF15(git, "t068-localized"));
      const failure = probeDiscovery(git, repo!, OTHER_OWNER);
      expect(text(failure.stderr)).toStartWith(DUBIOUS_PREFIX);
      // A localized Git prints another first line. The rest of the text stays.
      const localized = new TextEncoder().encode(text(failure.stderr).replace(DUBIOUS_PREFIX, "fatal: zweifelhafter Besitz im Repository unter '"));
      const refusal = classifyDiscoveryFailure({ exitCode: failure.exitCode, stderr: localized, directory: repo!, gitSelectedPath: SELECTED_GIT });
      expect([repo, slash(repo!)]).toContain(refusal.path);
      expect(refusal.remedy?.command ?? null).toBeNull();
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "PowerShell parses each built command without a subexpression, runs it with an owned GIT_CONFIG_GLOBAL, creates no marker, and adds the path as safe.directory",
    ["powershell"],
    () => {
      const git = gitPath();
      const shell = (Bun.which("pwsh") ?? Bun.which("powershell")) as string;
      const repos = hostileRepositories(git, buildF15(git, "t068-powershell"));
      const cwd = fixtureDir("t068-powershell-cwd");
      const owned = join(cwd, "owned.gitconfig");
      writeFileSync(owned, "");
      const added: string[] = [];
      for (const repo of repos) {
        const path = slash(text(probeDiscovery(git, repo, OTHER_OWNER).stderr).split("\n")[0]!.slice(DUBIOUS_PREFIX.length, -1));
        const command = safeDirectoryCommand(git, path).command;
        if (command === null) {
          expect({ repo, command }).toEqual({ repo, command: expectedSafeDirectory(git, path) });
          continue;
        }
        const parse = Bun.spawnSync([shell, "-NoProfile", "-Command", PARSE_SCRIPT], {
          env: { ...process.env, ARBARETO_CMD: Buffer.from(command, "utf8").toString("base64") },
          timeout: SHELL_TIMEOUT_MS,
        });
        expect(text(parse.stderr)).toBe("");
        const [errors, commands, subexpressions, lastType, quoting, last] = text(parse.stdout).trim().split("|");
        expect({ command, errors, commands, subexpressions, lastType, quoting, last: Buffer.from(last ?? "", "base64").toString("utf8") }).toEqual({
          command,
          errors: "0",
          commands: "1",
          subexpressions: "0",
          lastType: "StringConstantExpressionAst",
          quoting: "SingleQuoted",
          last: path,
        });
        const run = Bun.spawnSync([shell, "-NoProfile", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
          cwd,
          env: fixtureEnv({ GIT_CONFIG_GLOBAL: owned }),
          timeout: SHELL_TIMEOUT_MS,
        });
        expect({ command, exitCode: run.exitCode, stderr: text(run.stderr) }).toEqual({ command, exitCode: 0, stderr: "" });
        added.push(path);
      }
      expect(added.length).toBeGreaterThan(0);
      expect(markers()).toEqual([]);
      const listed = ownedGit(git, FIXTURE_ROOT, cwd, ["config", "--file", owned, "--get-all", "safe.directory"]).toString("utf8").split("\n").filter((l) => l !== "");
      expect(listed).toEqual(added);
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "OBSERVATION: whether Git for Windows honors the fixed C locale for the ownership message",
    ["git-for-windows"],
    () => {
      const git = gitPath();
      const repo = join(buildF15(git, "t068-locale").root, "repo");
      const version = ownedGit(git, FIXTURE_ROOT, repo, ["version"]).toString().trim();
      for (const [label, extra] of [
        ["LC_ALL=C LANG=de_DE.UTF-8 LANGUAGE=de", { LANG: "de_DE.UTF-8", LANGUAGE: "de" }],
        ["LC_ALL=C", {}],
      ] as const) {
        const failure = probeDiscovery(git, repo, { ...OTHER_OWNER, ...extra });
        expect(failure.exitCode).toBe(128);
        console.log(`OBSERVATION ${TASK}: ${version} with ${label}: ownership message starts with the C-locale prefix: ${text(failure.stderr).startsWith(DUBIOUS_PREFIX)}`);
      }
    },
    TIMEOUT_MS,
  );
});

// PowerShell's parser reports the error count, the command count, the subexpression and expandable string count, and the last command element.
const PARSE_SCRIPT = [
  "$c = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ARBARETO_CMD))",
  "$t = $null; $e = $null",
  "$ast = [System.Management.Automation.Language.Parser]::ParseInput($c, [ref]$t, [ref]$e)",
  "$cmd = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true))",
  "$sub = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.SubExpressionAst] -or $n -is [System.Management.Automation.Language.ExpandableStringExpressionAst] }, $true))",
  "$last = $cmd[0].CommandElements[$cmd[0].CommandElements.Count - 1]",
  "[Console]::Out.WriteLine([string]$e.Count + '|' + [string]$cmd.Count + '|' + [string]$sub.Count + '|' + $last.GetType().Name + '|' + [string]$last.StringConstantType + '|' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$last.Value)))",
].join(" ; ");

describe("other discovery failures (research R2)", () => {
  caseTest(
    TASK,
    "F15: a plain folder gives NOT_A_REPOSITORY from exit status 128 and the stderr prefix",
    ["no-enclosing-repository"],
    () => {
      const git = gitPath();
      const plain = join(buildF15(git, "t068-plain").root, "plain");
      const failure = probeDiscovery(git, plain);
      expect({ exitCode: failure.exitCode, prefix: text(failure.stderr).startsWith(NOT_A_REPOSITORY_PREFIX) }).toEqual({ exitCode: 128, prefix: true });
      const refusal = classifyDiscoveryFailure({ exitCode: failure.exitCode, stderr: failure.stderr, directory: plain, gitSelectedPath: SELECTED_GIT });
      expect({ code: refusal.code, text: refusal.remedy?.text }).toEqual({ code: "NOT_A_REPOSITORY", text: REMEDY.notARepository });
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "F07: a .git file with a missing target gives REPOSITORY_UNAVAILABLE, not NOT_A_REPOSITORY",
    [],
    () => {
      const git = gitPath();
      const broken = join(buildF07(git, "t068-broken").root, "broken");
      const failure = probeDiscovery(git, broken);
      expect({ exitCode: failure.exitCode, prefix: text(failure.stderr).startsWith(NOT_A_REPOSITORY_PREFIX) }).toEqual({ exitCode: 128, prefix: false });
      const refusal = classifyDiscoveryFailure({ exitCode: failure.exitCode, stderr: failure.stderr, directory: broken, gitSelectedPath: SELECTED_GIT });
      expect({ code: refusal.code, text: refusal.remedy?.text }).toEqual({ code: "REPOSITORY_UNAVAILABLE", text: REMEDY.unavailable });
    },
    TIMEOUT_MS,
  );
});

// Service cases. `bun-runner.ts` runs only on Windows.

async function withService(name: string, body: (service: Service) => Promise<void>): Promise<void> {
  const service = await openService({ git: gitPath(), name });
  try {
    await body(service);
  } finally {
    await service.dispose();
  }
}

function expectRefusal(response: ServiceResponse<RegistrationResult | Refusal>, code: string, remedy: string): void {
  const result = response.result as Refusal | undefined;
  expect({ state: response.state === "succeeded" ? "succeeded" : "refused", code: response.code, text: result?.remedy?.text }).toEqual({ state: "refused", code, text: remedy });
}

// The Git-resolved paths of a worktree, from the oracle.
function gitPaths(git: string, dir: string) {
  const out = ownedGit(git, FIXTURE_ROOT, dir, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir", "--git-path", "index"]);
  const [worktreeRoot, gitDirectory, commonDirectory, indexPath] = out.toString("utf8").trimEnd().split("\n").map(slash);
  return { worktreeRoot, gitDirectory, commonDirectory, indexPath };
}

// The identity reply that the service received for a Git-resolved path.
function identityReply(service: Service, path: string): unknown {
  for (const call of service.runner.identityCalls) {
    const at = call.paths.findIndex((p) => slash(p) === slash(path));
    if (at >= 0 && call.replies[at] !== undefined) return call.replies[at];
  }
  throw new Error(`no identity request for ${path}`);
}

const discoveryCalls = (service: Service) => service.runner.calls.filter((c) => c.contextKind === "repositoryDiscovery");

describe("F07 worktree identities (data-model §2, contract §3 \"Worktree key\")", () => {
  caseTest(
    TASK,
    "each linked worktree gets its own worktreeRoot, gitDirectory, indexPath, worktreeIdentity, and 64-hex worktreeKey, and all share one commonIdentity",
    ["windows-shell-double"],
    () =>
      withService("t068-f07-identity", async (service) => {
        const git = gitPath();
        const built = buildF07(git, "t068-f07-identity");
        const names = ["main", "wt-a", "wt-b"];
        const seen: Record<"worktreeRoot" | "gitDirectory" | "commonDirectory" | "indexPath" | "key" | "worktreeIdentity" | "commonIdentity", string | undefined>[] = [];
        for (const name of names) {
          const dir = join(built.root, name);
          const registered = await service.register(dir);
          expect(registered.worktreeKey).toMatch(HEX64);
          const read = await service.readWorkspace(registered.repositoryId);
          expect(read.state).toBe("succeeded");
          const identity = read.result!.identity;
          const oracle = gitPaths(git, dir);
          const paths = { worktreeRoot: slash(identity.worktreeRoot), gitDirectory: slash(identity.gitDirectory), commonDirectory: slash(identity.commonDirectory), indexPath: slash(identity.indexPath) };
          expect({ name, paths }).toEqual({ name, paths: oracle });
          seen.push({
            ...paths,
            key: registered.worktreeKey,
            worktreeIdentity: JSON.stringify([identityReply(service, paths.worktreeRoot), identityReply(service, paths.gitDirectory)]),
            commonIdentity: JSON.stringify(identityReply(service, paths.commonDirectory)),
          });
        }
        for (const field of ["worktreeRoot", "gitDirectory", "indexPath", "key", "worktreeIdentity"] as const) {
          expect({ field, distinct: new Set(seen.map((s) => s[field])).size }).toEqual({ field, distinct: names.length });
        }
        for (const field of ["commonDirectory", "commonIdentity"] as const) {
          expect({ field, distinct: new Set(seen.map((s) => s[field])).size }).toEqual({ field, distinct: 1 });
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "the worktreeKey stays equal after a new service session, and the repositoryId does not",
    ["windows-shell-double"],
    async () => {
      const git = gitPath();
      const built = buildF07(git, "t068-f07-restart");
      let service = await openService({ git, name: "t068-f07-restart" });
      try {
        const before: RegistrationResult[] = [];
        for (const name of ["main", "wt-a", "wt-b"]) before.push(await service.register(join(built.root, name)));
        service = await service.restart();
        const after: RegistrationResult[] = [];
        for (const name of ["main", "wt-a", "wt-b"]) after.push(await service.register(join(built.root, name)));
        expect(after.map((r) => r.worktreeKey)).toEqual(before.map((r) => r.worktreeKey));
        for (const [i, r] of after.entries()) expect(r.repositoryId).not.toBe(before[i]!.repositoryId);
      } finally {
        await service.dispose();
      }
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a junction alias gives the same identities, repositoryId, and worktreeKey",
    ["windows-shell-double", "ntfs-junction"],
    () =>
      withService("t068-f07-junction", async (service) => {
        const git = gitPath();
        const built = buildF07(git, "t068-f07-junction");
        const aliases = built.facts.notes.junctions as Record<string, string> | undefined;
        expect(aliases).toBeDefined();
        for (const [alias, target] of Object.entries(aliases!)) {
          const real = await service.register(join(built.root, target));
          const realRead = await service.readWorkspace(real.repositoryId);
          const viaAlias = await service.register(join(built.root, alias));
          const aliasRead = await service.readWorkspace(viaAlias.repositoryId);
          expect({ alias, repositoryId: viaAlias.repositoryId, key: viaAlias.worktreeKey }).toEqual({ alias, repositoryId: real.repositoryId, key: real.worktreeKey });
          const identities = (read: typeof realRead) => {
            const id = read.result!.identity;
            return [id.worktreeRoot, id.gitDirectory, id.commonDirectory].map((p) => identityReply(service, p));
          };
          expect({ alias, identities: identities(aliasRead) }).toEqual({ alias, identities: identities(realRead) });
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a submodule checkout opened directly and a separate Git directory open normally",
    ["windows-shell-double"],
    () =>
      withService("t068-f07-open", async (service) => {
        const git = gitPath();
        const built = buildF07(git, "t068-f07-open");
        for (const name of ["super/sub", "separate"]) {
          const dir = join(built.root, name);
          const registered = await service.register(dir);
          const read = await service.readWorkspace(registered.repositoryId);
          expect({ name, state: read.state }).toEqual({ name, state: "succeeded" });
          const identity = read.result!.identity;
          expect({ name, gitDirectory: slash(identity.gitDirectory), commonDirectory: slash(identity.commonDirectory) }).toEqual({
            name,
            gitDirectory: gitPaths(git, dir).gitDirectory,
            commonDirectory: gitPaths(git, dir).commonDirectory,
          });
        }
      }),
    TIMEOUT_MS,
  );
});

describe("registration refusals (contract §6, data-model §2)", () => {
  caseTest(
    TASK,
    "a bare repository, a Git administration folder, and a .git file with a missing target give their codes and remedy texts",
    ["windows-shell-double"],
    () =>
      withService("t068-refusals", async (service) => {
        const built = buildF07(gitPath(), "t068-refusals");
        const unopenable = built.facts.notes.unopenable as Record<"bare" | "missingGitdir" | "administrationFolder", string>;
        expectRefusal(await service.chooseRepository(join(built.root, unopenable.bare)), "UNSUPPORTED_REPOSITORY", REMEDY.bare);
        expectRefusal(await service.chooseRepository(join(built.root, unopenable.administrationFolder)), "UNSUPPORTED_REPOSITORY", REMEDY.administrationFolder);
        expectRefusal(await service.chooseRepository(join(built.root, unopenable.missingGitdir)), "REPOSITORY_UNAVAILABLE", REMEDY.unavailable);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "F15: a plain folder gives NOT_A_REPOSITORY with its remedy text through the service",
    ["windows-shell-double", "no-enclosing-repository"],
    () =>
      withService("t068-plain-service", async (service) => {
        const built = buildF15(gitPath(), "t068-plain-service");
        expectRefusal(await service.chooseRepository(join(built.root, built.facts.notes.plain as string)), "NOT_A_REPOSITORY", REMEDY.notARepository);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "F15: a removed path gives REPOSITORY_UNAVAILABLE",
    ["windows-shell-double"],
    () =>
      withService("t068-removed", async (service) => {
        const repo = join(buildF15(gitPath(), "t068-removed").root, "repo");
        removeTree(repo);
        expectRefusal(await service.chooseRepository(repo), "REPOSITORY_UNAVAILABLE", REMEDY.unavailable);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "dubious ownership gives DUBIOUS_OWNERSHIP with the path and the service-built command, and the service never runs it",
    ["windows-shell-double", "other-account-owner"],
    () =>
      withService("t068-dubious-service", async (service) => {
        const git = gitPath();
        const repo = join(buildF15(git, "t068-dubious-service").root, "repo");
        const response = await service.chooseRepository(repo);
        const result = response.result as Refusal | undefined;
        expect({ code: response.code, path: result?.path }).toEqual({ code: "DUBIOUS_OWNERSHIP", path: slash(repo) });
        expect(result?.remedy?.command).toBe(safeDirectoryCommand(git, slash(repo)).command);
        expect(service.runner.calls.filter((c) => c.arguments.includes("safe.directory") || c.arguments.some((a) => a.startsWith("safe.directory")))).toEqual([]);
        expect(JSON.stringify(service.responses)).not.toContain("git config --global --add safe.directory");
      }),
    TIMEOUT_MS,
  );

  for (const [label, fill] of [
    ["all-zero", 0x00],
    ["all-ones", 0xff],
  ] as const) {
    caseTest(
      TASK,
      `an injected ${label} file ID gives UNSUPPORTED_REPOSITORY with the NTFS or ReFS remedy`,
      ["windows-shell-double"],
      () =>
        withService(`t068-file-id-${label}`, async (service) => {
          const repo = join(buildF08(gitPath(), `t068-file-id-${label}`, "sha1").root, "repo");
          // The service sends Git-resolved paths, so each spelling gets the injected ID.
          for (const path of [repo, join(repo, ".git")]) for (const spelling of [path, slash(path)]) service.runner.inject.fileIds.set(spelling, new Uint8Array(16).fill(fill));
          expectRefusal(await service.chooseRepository(repo), "UNSUPPORTED_REPOSITORY", REMEDY.fileId);
        }),
      TIMEOUT_MS,
    );
  }
});

describe("F08 object format and HEAD (data-model §2)", () => {
  const HEX = { sha1: /^[0-9a-f]{40}$/, sha256: /^[0-9a-f]{64}$/ };

  for (const variant of ["sha1", "sha256"] as const) {
    caseTest(
      TASK,
      `${variant}: objectFormat is Git-reported, and head is the symbolic target plus an OID of that format`,
      ["windows-shell-double"],
      () =>
        withService(`t068-f08-${variant}`, async (service) => {
          const built = buildF08(gitPath(), `t068-f08-${variant}`, variant);
          const { second } = built.facts.notes.commits as { first: string; second: string };
          expect(second).toMatch(HEX[variant]);
          const { repositoryId } = await service.register(join(built.root, "repo"));
          const read = await service.readWorkspace(repositoryId);
          expect(read.result?.identity.objectFormat).toBe(variant);
          expect(read.result?.head).toEqual({ state: "branch", target: "refs/heads/main", oid: second });
        }),
      TIMEOUT_MS,
    );
  }

  caseTest(
    TASK,
    "detached: head is the detached object ID",
    ["windows-shell-double"],
    () =>
      withService("t068-f08-detached", async (service) => {
        const built = buildF08(gitPath(), "t068-f08-detached", "detached");
        const { first } = built.facts.notes.commits as { first: string; second: string };
        const { repositoryId } = await service.register(join(built.root, "repo"));
        expect((await service.readWorkspace(repositoryId)).result?.head).toEqual({ state: "detached", oid: first });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "F01 unborn: head is a validated unborn branch",
    ["windows-shell-double"],
    () =>
      withService("t068-f01-unborn", async (service) => {
        const built = buildF01(gitPath(), "t068-f01-unborn", "empty");
        const { repositoryId } = await service.register(join(built.root, "repo"));
        expect((await service.readWorkspace(repositoryId)).result?.head).toEqual({ state: "unborn", target: "refs/heads/main" });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "an unborn branch differs from a failed lookup: a corrupt branch ref never reads as unborn",
    ["windows-shell-double"],
    () =>
      withService("t068-f08-failed-lookup", async (service) => {
        const built = buildF08(gitPath(), "t068-f08-failed-lookup", "sha1");
        const repo = join(built.root, "repo");
        put(repo, ".git/refs/heads/main", "not an object ID\n");
        const response = await service.chooseRepository(repo);
        if (response.state !== "succeeded") return void expect(response.code).toBeString();
        const read = await service.readWorkspace((response.result as RegistrationResult).repositoryId);
        expect(read.state === "succeeded" ? read.result?.head.state : read.code).not.toBe("unborn");
      }),
    TIMEOUT_MS,
  );
});

// Every configuration file that Git reads for the F07 main worktree under the owned environment.
function configDigests(git: string, common: string): Record<string, string> {
  const files = [join(common, "config"), FIXTURE_GLOBAL_CONFIG];
  const worktrees = join(common, "worktrees");
  if (existsSync(worktrees)) for (const name of readdirSync(worktrees)) files.push(join(worktrees, name, "config.worktree"));
  const digests: Record<string, string> = {};
  for (const file of files) digests[file] = existsSync(file) ? sha256(readFileSync(file)) : "missing";
  for (const line of realGlobalConfigDigests(git)) digests[line] = "real global";
  return digests;
}

describe("registration effects", () => {
  caseTest(
    TASK,
    "repositoryId is a random session identifier, not a path or revision; opening creates no worktree and keeps every configuration file digest",
    ["windows-shell-double"],
    () =>
      withService("t068-effects", async (service) => {
        const git = gitPath();
        const built = buildF07(git, "t068-effects");
        const main = join(built.root, "main");
        const common = join(main, ".git");
        const worktrees = () => ownedGit(git, FIXTURE_ROOT, main, ["worktree", "list", "--porcelain", "-z"]).toString("utf8");
        const before = { worktrees: worktrees(), configs: configDigests(git, common) };
        const ids: string[] = [];
        for (const name of ["main", "wt-a", "super/sub", "separate"]) {
          const registered = await service.register(join(built.root, name));
          expect((await service.readWorkspace(registered.repositoryId)).state).toBe("succeeded");
          ids.push(registered.repositoryId);
          expect(registered.repositoryId).toMatch(UUID);
          expect(registered.repositoryId).not.toBe(registered.worktreeKey);
          const resolves = Bun.spawnSync([git, "rev-parse", "--verify", "-q", registered.repositoryId], { cwd: main, env: fixtureEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
          expect(resolves.exitCode).not.toBe(0);
        }
        expect(new Set(ids).size).toBe(ids.length);
        expect({ worktrees: worktrees(), configs: configDigests(git, common) }).toEqual(before);
      }),
    TIMEOUT_MS,
  );
});

// Research R2: the traditional hook names of githooks(5).
const TRADITIONAL_HOOKS = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-commit",
  "pre-rebase", "post-checkout", "post-merge", "pre-push", "pre-receive", "update", "proc-receive", "post-receive", "post-update",
  "reference-transaction", "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate", "fsmonitor-watchman",
  "p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit", "post-index-change",
];
// Git `Documentation/config/gpg.adoc`.
const SIGNING_KEYS = ["gpg.program", "gpg.openpgp.program", "gpg.x509.program", "gpg.ssh.program", "gpg.ssh.defaultKeyCommand"];

// Adds the research R2 canaries that F17 lacks. Returns every canary log path of the fixture.
function armDiscoveryCanaries(git: string, built: Built): string[] {
  const repo = join(built.root, "repo");
  const logs = Object.values(built.facts.canaries).map((log) => join(built.root, log));
  const canary = (name: string) => {
    const log = join(built.root, "canaries", `t068-${name}.log`);
    const script = put(built.root, `canaries/t068-${name}.sh`, `#!/bin/sh\necho "${name} $*" >> '${slash(log)}'\nexit 1\n`);
    chmodSync(script, 0o755);
    logs.push(log);
    return `'${slash(script)}'`;
  };
  const config = (key: string, value: string) => ownedGit(git, FIXTURE_ROOT, repo, ["config", key, value]);
  config("filter.canary.smudge", canary("smudge"));
  for (const key of SIGNING_KEYS) config(key, canary(key));
  config("hook.t068.command", canary("configured-hook"));
  config("hook.t068.event", "pre-commit");
  for (const hook of TRADITIONAL_HOOKS) {
    if (hook === "pre-commit") continue;
    chmodSync(put(repo, `.git/hooks/${hook}`, `#!/bin/sh\nexec ${canary(`hook-${hook}`)}\n`), 0o755);
  }
  // A stat-dirty file with the clean filter: its content stays, and its time changes.
  utimesSync(join(repo, "data.dat"), new Date(), new Date(Date.now() + 60_000));
  return logs;
}

describe("discovery canaries (research R2)", () => {
  caseTest(
    TASK,
    "registration and restoreWorkspace run no canary, never send rev-parse --shared-index-path, and use only the discovery commands",
    ["windows-shell-double"],
    async () => {
      const git = gitPath();
      const built = buildF17(git, "t068-canaries", "trust");
      const logs = armDiscoveryCanaries(git, built);
      const repo = join(built.root, "repo");
      let service = await openService({ git, name: "t068-canaries" });
      try {
        await service.register(repo);
        expect((await service.restoreWorkspace(repo)).state).toBe("succeeded");
        const first = service.runner.calls;
        service = await service.restart();
        expect((await service.restoreWorkspace(repo)).state).toBe("succeeded");
        const calls = [...first, ...service.runner.calls];
        expect(calls.filter((c) => c.arguments.includes("--shared-index-path"))).toEqual([]);
        const discovery = calls.filter((c) => c.contextKind === "repositoryDiscovery");
        expect(discovery.length).toBeGreaterThan(0);
        for (const c of discovery) expect({ args: c.arguments, command: c.arguments[1] }).toEqual({ args: c.arguments, command: expect.stringMatching(/^(rev-parse|symbolic-ref|show-ref)$/) });
        expect(logs.filter((log) => existsSync(log))).toEqual([]);
      } finally {
        await service.dispose();
      }
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "F10 split index registers, and its split state comes only from the raw link extension",
    ["windows-shell-double"],
    () =>
      withService("t068-split-index", async (service) => {
        const built = buildF10(gitPath(), "t068-split-index", "split-index");
        const { repositoryId } = await service.register(join(built.root, "repo"));
        const read = await service.readWorkspace(repositoryId);
        expect(read.result?.hunkEligibility).toEqual({ eligible: false, reason: "split-index" });
        expect(service.runner.calls.filter((c) => c.arguments.includes("--shared-index-path"))).toEqual([]);
        expect(discoveryCalls(service).filter((c) => c.arguments.includes("ls-files"))).toEqual([]);
      }),
    TIMEOUT_MS,
  );
});
