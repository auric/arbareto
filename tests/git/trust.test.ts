// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
import type { FileFact } from "../../src/contracts/channel";
import { foldAscii } from "../../src/contracts/fold-ascii";
import { NATIVE, PATH_RULES } from "../../src/contracts/native-path";
import { RECONCILIATION_TARGET_MS, TRUST_DIGEST_FILE_BYTES, TRUST_DIGEST_FILES, TRUST_DIGEST_TOTAL_BYTES, TRUST_INPUT_BYTES, TRUST_LINK_HOPS, TRUST_REPORT_ENTRIES, TRUST_REPORT_HOOKS } from "../../src/contracts/limits";
import { configListArgs, hooksPathArgs } from "../../src/git-service/commands";
import { probeGit, type GitInstallation } from "../../src/git-service/git-installation";
import { RunnerRefusal, type GitRunner } from "../../src/git-service/git-runner";
import { createRegistrations, type Workspace } from "../../src/git-service/registration";
import { createTrust, parseMaybeBool, readProgramFiles, redactUrlUserInfo, relativePathEntries, type ChangeFiles } from "../../src/git-service/trust";
import { printOrigin } from "../origin";
import { FIXTURE_GLOBAL_CONFIG, FIXTURE_ROOT, fixtureEnv, ownedGit, serviceEnv, useFixtureRoot, type OwnedGitOptions } from "./fixture-root";
import { buildF02, buildF07, buildF08, buildF17, put, type Built } from "./fixtures";
import { GIT } from "./git-binary";
import { hookListArgs, sha256 } from "./git-oracle";
import { caseTest, once, openService, withFsCalls, withPath, type ApproveResult, type Capability, type OpenOptions, type Service, type ServiceResponse, type TrustResult } from "./service-harness";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/git-service/commands.ts", import.meta.dir);
printOrigin("../../src/git-service/trust.ts", import.meta.dir);
printOrigin("../../src/git-service/git-installation.ts", import.meta.dir);
printOrigin("../../src/git-service/registration.ts", import.meta.dir);
printOrigin("../../src/git-service/status.ts", import.meta.dir);

const TASK = "T071";
const TIMEOUT_MS = 120_000;
const WAIT_MS = 30_000;
const W = ["shell-double"] as const;

const SUCCEEDED = { state: "succeeded", code: undefined };
// Contract §9 fixes the code. A blocked read can start its trust listing first, so the terminal state is not fixed.
const TRUST_REQUIRED = { code: "TRUST_REQUIRED", succeeded: false };
const TRUST_CHANGED = { code: "TRUST_CHANGED", succeeded: false };
// Contract §7 "Missing objects".
const OBJECT_MISSING_REMEDY = "This partial clone lacks objects that Git needs here. Arbareto never downloads objects. Download them in a terminal, for example with git backfill, then use Refresh.";
// Contract §6 "Startup handshake" `trustRecords` and §7 "Trust approval store".
const RECORD_FIELDS = ["approvedAt", "commonDirectory", "commonIdentity", "configurationFingerprint", "gitDirectory", "gitSelectedPath", "worktreeIdentity", "worktreeRoot"];
// An identity reply that no fixture path has. Contract §6 refuses only all-zero and all-ones file IDs.
const OTHER_IDENTITY = { volumeSerial: "00000000000000a7", fileId: "000000000000000000000000000071a7" };

useFixtureRoot();

const gitPath = (): string => {
  if (GIT === null) throw new Error("Git executable absent");
  return GIT;
};
const slash = (path: string) => path.replaceAll("\\", "/");
const repoOf = (built: Built, name = "repo") => join(built.root, name);
const git = (cwd: string, args: string[], options: OwnedGitOptions = {}) => ownedGit(gitPath(), FIXTURE_ROOT, cwd, args, options).toString("utf8");
const config = (repo: string, ...args: string[]) => git(repo, ["config", ...args]);
const outcome = (response: ServiceResponse) => ({ state: response.state, code: response.code });
const gate = (response: ServiceResponse) => ({ code: response.code, succeeded: response.state === "succeeded" });
// The handshake record form of `TrustRecord` follows the contract field names, so the tests read it by name.
const fieldsOf = (record: object): Record<string, unknown> => Object.fromEntries(Object.entries(record));

// Windows paths ignore case, and Git prints `/` where Windows prints `\`.
const samePath = (path: unknown) => (typeof path !== "string" ? path : process.platform === "win32" ? slash(path).replace(/\/$/, "").toLowerCase() : slash(path).replace(/\/$/, ""));

// Git prints a local origin relative to the worktree root, such as `file:.git/config`. The service can print the resolved path.
const originPath = (origin: string | undefined, repo: string) => (origin === undefined ? undefined : samePath(resolve(repo, origin.startsWith("file:") ? origin.slice("file:".length) : origin)));

// A program file that ends in a comment line, so a changed byte keeps the script valid.
const SCRIPT = (log: string) => `#!/bin/sh\necho "$0 $*" >> '${slash(log)}'\nexec cat\n# t071\n`;

// A logging program outside every worktree, named by its absolute path.
function outsideProgram(built: Built, name: string): { command: string; path: string; log: string } {
  const log = join(built.root, "canaries", `t071-${name}.log`);
  const path = put(built.root, `canaries/t071-${name}.sh`, SCRIPT(log));
  chmodSync(path, 0o755);
  return { command: `'${slash(path)}'`, path, log };
}

// A logging program inside the worktree, named by a relative path with `/`.
function insideProgram(built: Built, repo: string, rel: string, size?: number): { command: string; path: string; log: string } {
  mkdirSync(join(built.root, "canaries"), { recursive: true });
  const log = join(built.root, "canaries", `t071-${rel.replaceAll("/", "-")}.log`);
  const path = put(repo, rel, SCRIPT(log));
  if (size !== undefined) padTo(path, size);
  chmodSync(path, 0o755);
  return { command: `./${rel}`, path, log };
}

// Pads a script with one comment line to exactly `size` bytes.
function padTo(path: string, size: number): void {
  const head = readFileSync(path);
  const fill = size - head.length - 2;
  if (fill < 0) throw new Error(`${path} is already above ${size} bytes`);
  writeFileSync(path, Buffer.concat([head, Buffer.from(`#${"x".repeat(fill)}\n`)]));
  expect(statSync(path).size).toBe(size);
}

// Changes one byte. A second call at the same position restores it.
function flipByte(path: string, at?: number): void {
  const bytes = readFileSync(path);
  const index = at ?? bytes.length - 2;
  bytes[index] = bytes[index]! ^ 0x01;
  writeFileSync(path, bytes);
}

const ran = (logs: string[]) => logs.filter((log) => existsSync(log));
const f17Ran = (built: Built) =>
  Object.entries(built.facts.canaries)
    .filter(([, log]) => existsSync(join(built.root, log)))
    .map(([name]) => name);

// Contract §7: the read commands of this slice. The trust listing and discovery use none of them.
const READ_COMMANDS = new Set(["status", "diff-files", "diff-index", "diff", "ls-files", "rev-list", "cat-file", "check-attr", "hash-object"]);
const subcommand = (args: readonly string[]) => args.find((a) => !a.startsWith("-")) ?? "";
// Contract §7 "Held history steps": `rev-list` and `cat-file --batch-command` can start beside the trust listing. The `cat-file --batch-check` object check cannot.
const heldHistoryStep = (args: readonly string[]) => subcommand(args) === "rev-list" || (subcommand(args) === "cat-file" && args.includes("--batch-command"));
const readCalls = (service: Service) =>
  service.runner.calls
    .filter((c) => !heldHistoryStep(c.arguments) && (READ_COMMANDS.has(subcommand(c.arguments)) || (subcommand(c.arguments) === "config" && c.arguments.includes("--file"))))
    .map((c) => c.arguments.join(" "));

// Contract §7 "Held history steps": a refused gate returns no history row, so no response holds a commit ID of the fixture history.
function expectNoHeldRow(service: Service, repo: string): void {
  const commits = git(repo, ["--no-lazy-fetch", "rev-list", "--parents", "--max-count=100", "--date-order", "HEAD"]).split(/\s+/).filter((oid) => oid !== "");
  expect(commits.length).toBeGreaterThan(0);
  const text = JSON.stringify(service.responses);
  expect(commits.filter((oid) => text.includes(oid))).toEqual([]);
}

// Each string or key in `value` that holds `needle`, with its path.
function leaks(value: unknown, needle: string, at = "$"): string[] {
  if (typeof value === "string") return value.includes(needle) ? [`${at}: ${value}`] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => leaks(item, needle, `${at}[${i}]`));
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([key, item]) => [...(key.includes(needle) ? [`${at} key ${key}`] : []), ...leaks(item, needle, `${at}.${key}`)]);
  return [];
}

// Every value of the fields named `key` in `value`, at any depth.
function valuesOf(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => valuesOf(item, key));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([k, item]) => (k === key ? [item, ...valuesOf(item, key)] : valuesOf(item, key)));
}

interface ConfigEntry {
  scope: string;
  origin: string;
  key: string;
  value: string | null;
}

// Oracle: Git's own scoped listing. With `-z`, each entry is scope NUL origin NUL key, then LF and the value when it has one, then NUL.
function configListing(repo: string, env: Record<string, string> = {}): ConfigEntry[] {
  const fields = git(repo, ["--no-optional-locks", "config", "list", "--show-scope", "--show-origin", "-z"], { env }).split("\0");
  const entries: ConfigEntry[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const kv = fields[i + 2]!;
    const lf = kv.indexOf("\n");
    entries.push({ scope: fields[i]!, origin: fields[i + 1]!, key: lf < 0 ? kv : kv.slice(0, lf), value: lf < 0 ? null : kv.slice(lf + 1) });
  }
  return entries;
}

// Oracle: `git hook list -z --show-scope <event>`. A configured hook prints its scope, `disabled` or `event-disabled` when off, and its name. A hooks-directory hook prints one field.
// Research R5 "T280 record": `event-disabled` wins over `disabled`, and both hooks stay off.
function hookList(repo: string, event: string, env: Record<string, string> = {}): { scope?: string; disabled: boolean; name: string }[] {
  const out = git(repo, hookListArgs(event), { allowExit: [0, 1], env });
  return out
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => {
      const parts = line.split("\t");
      if (parts.length === 1) return { disabled: false, name: parts[0]! };
      return { scope: parts[0]!, disabled: parts.length === 3 && (parts[1] === "disabled" || parts[1] === "event-disabled"), name: parts[parts.length - 1]! };
    });
}

function gitPaths(repo: string): { worktreeRoot: string; gitDirectory: string; commonDirectory: string } {
  const [worktreeRoot, gitDirectory, commonDirectory] = git(repo, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]).trimEnd().split("\n");
  return { worktreeRoot: worktreeRoot!, gitDirectory: gitDirectory!, commonDirectory: commonDirectory! };
}

// The owned global file serves every fixture of a run, so a case with global keys writes its own global file (fixtures.ts `buildF10` notes).
function ownGlobal(built: Built, entries: [string, string][]): { file: string; environment: Record<string, string> } {
  const file = put(built.root, "home/.gitconfig", readFileSync(FIXTURE_GLOBAL_CONFIG, "utf8"));
  for (const [key, value] of entries) git(built.root, ["config", "--file", file, key, value]);
  return { file, environment: serviceEnv({ GIT_CONFIG_GLOBAL: file }) };
}

async function withService(options: Omit<OpenOptions, "git">, body: (service: Service) => Promise<void>): Promise<void> {
  const service = await openService({ git: gitPath(), ...options });
  try {
    await body(service);
  } finally {
    await service.dispose();
  }
}

// A new service session at application start with the same record store. The handshake carries `restarted: false`.
async function nextSession(service: Service, name: string, overrides: Partial<OpenOptions> = {}): Promise<Service> {
  await service.dispose();
  return openService({ git: gitPath(), name, trustStore: service.trustStore, ...overrides });
}

// Runs `body` with a service that it can replace, and disposes the last one.
async function withSessions(name: string, options: Partial<OpenOptions>, body: (first: Service, set: (next: Service) => Service) => Promise<void>): Promise<void> {
  let current = await openService({ git: gitPath(), name, ...options });
  try {
    await body(current, (next) => (current = next));
  } finally {
    await current.dispose();
  }
}

async function trustOf(service: Service, repositoryId: string): Promise<TrustResult> {
  const response = await service.readTrust(repositoryId);
  expect(outcome(response)).toEqual(SUCCEEDED);
  return response.result!;
}

async function approve(service: Service, repositoryId: string, issued?: TrustResult): Promise<ApproveResult> {
  const trust = issued ?? (await trustOf(service, repositoryId));
  const response = await service.approveTrust(repositoryId, trust.fingerprint, trust.generation);
  expect(outcome(response)).toEqual(SUCCEEDED);
  return response.result!;
}

async function readBoth(service: Service, repositoryId: string, generation: number): Promise<{ workspace: ServiceResponse; history: ServiceResponse }> {
  const workspace = await service.readWorkspace(repositoryId);
  const history = await service.readHistory(repositoryId, workspace.result?.generation ?? generation);
  return { workspace, history };
}

async function waitFor(what: string, found: () => boolean): Promise<void> {
  const until = performance.now() + WAIT_MS;
  while (!found()) {
    if (performance.now() > until) throw new Error(`${what}: not seen within ${WAIT_MS} ms`);
    await Bun.sleep(10);
  }
}

describe("URL user information redaction (contract §7 \"URL user information\") (L)", () => {
  // Each pair follows the rule: for each `://`, the authority runs to the next `/`, `?`, `#`, or the end. When it holds `@`, the text before its last `@` becomes `<redacted>`.
  const RULE: [string, string, string][] = [
    ["user and password", "https://u:secret@host.example/repo.git", "https://<redacted>@host.example/repo.git"],
    ["the last @ of the authority", "https://a@b:c@host.example/x", "https://<redacted>@host.example/x"],
    ["an empty user part", "https://@host.example/", "https://<redacted>@host.example/"],
    ["an authority that runs to the end", "ssh://git@host.example", "ssh://<redacted>@host.example"],
    ["an authority that ends at ?", "https://u@host.example?q=a@b", "https://<redacted>@host.example?q=a@b"],
    ["an authority that ends at #", "https://u@host.example#f@g", "https://<redacted>@host.example#f@g"],
    ["an @ after the authority only", "https://host.example/a@b?c@d#e@f", "https://host.example/a@b?c@d#e@f"],
    ["no user information", "https://host.example/repo.git", "https://host.example/repo.git"],
    ["text without ://", "git@host.example:repo.git", "git@host.example:repo.git"],
    ["each :// of the text", "a https://u:t@h1/ b ftp://x@h2/ c", "a https://<redacted>@h1/ b ftp://<redacted>@h2/ c"],
    ["a key subsection without a path", "credential.https://u:TOKEN@host.example.helper", "credential.https://<redacted>@host.example.helper"],
    ["a redacted text", "https://<redacted>@host.example/", "https://<redacted>@host.example/"],
  ];

  caseTest(
    TASK,
    "redactUrlUserInfo replaces the text before the last @ of each URL authority with <redacted> and keeps every other byte",
    [],
    () => {
      for (const [label, input, expected] of RULE) expect({ label, redacted: redactUrlUserInfo(input) }).toEqual({ label, redacted: expected });
    },
    TIMEOUT_MS,
  );
});

const TOKEN = "ARBARETO-T071-TOKEN";
const TOKEN_URL = `https://u:${TOKEN}@host.example`;
// Key-name canaries of the task text. The third field is the key that Git prints, with the user information redacted. Git lowercases section and variable names.
const KEY_CANARIES: [key: string, value: string, shown: string][] = [
  [`url.${TOKEN_URL}/.insteadOf`, "https://host.example/", "url.https://<redacted>@host.example/.insteadof"],
  [`http.${TOKEN_URL}/.extraheader`, "X-T071: header", "http.https://<redacted>@host.example/.extraheader"],
  [`credential.${TOKEN_URL}.helper`, "store", "credential.https://<redacted>@host.example.helper"],
  [`includeIf.hasconfig:remote.*.url:${TOKEN_URL}/**.path`, "t071-missing.gitconfig", "includeif.hasconfig:remote.*.url:https://<redacted>@host.example/**.path"],
];
const HOOK_COMMAND = { key: "hook.t071url.command", value: `echo ${TOKEN_URL}/`, shown: "echo https://<redacted>@host.example/" };

function armKeyCanaries(repo: string): void {
  for (const [key, value] of KEY_CANARIES) config(repo, key, value);
  config(repo, HOOK_COMMAND.key, HOOK_COMMAND.value);
  config(repo, "hook.t071url.event", "pre-commit");
}

describe("key-name canaries (contract §7 \"URL user information\")", () => {
  caseTest(
    TASK,
    "redactUrlUserInfo gives each key-name canary key of the real Git listing with <redacted> in place of the user information, and the hook command value too (L)",
    [],
    () => {
      const repo = repoOf(buildF02(gitPath(), "t071-redact-listing"));
      armKeyCanaries(repo);
      const listing = configListing(repo);
      for (const [, , shown] of KEY_CANARIES) {
        const raw = listing.filter((e) => e.key.includes(TOKEN) && e.key.toLowerCase() === shown.replace("<redacted>", `u:${TOKEN}`).toLowerCase());
        expect({ shown, count: raw.length }).toEqual({ shown, count: 1 });
        expect(redactUrlUserInfo(raw[0]!.key)).toBe(shown);
      }
      const hook = listing.find((e) => e.key === HOOK_COMMAND.key);
      expect(hook?.value).toBe(HOOK_COMMAND.value);
      expect(redactUrlUserInfo(hook!.value!)).toBe(HOOK_COMMAND.shown);
      for (const entry of listing) expect({ key: redactUrlUserInfo(entry.key), origin: redactUrlUserInfo(entry.origin) }).toEqual({ key: expect.not.stringContaining(TOKEN), origin: entry.origin });
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "readTrust shows each key-name canary key with <redacted>, and TOKEN appears in no response, progress event, or session log",
    W,
    () =>
      withService({ name: "t071-key-canaries" }, async (service) => {
        const built = buildF02(gitPath(), "t071-key-canaries");
        const repo = repoOf(built);
        armKeyCanaries(repo);
        const { repositoryId, generation } = await service.register(repo);
        const trust = await trustOf(service, repositoryId);
        const keys = trust.entries.map((e) => e.key);
        for (const [, , shown] of KEY_CANARIES) expect({ shown, listed: keys.includes(shown) }).toEqual({ shown, listed: true });
        expect(trust.entries.find((e) => e.key === HOOK_COMMAND.key)?.value).toBe(HOOK_COMMAND.shown);
        await readBoth(service, repositoryId, generation);
        expect(leaks(service.responses, TOKEN)).toEqual([]);
        expect(leaks(service.progress, TOKEN)).toEqual([]);
        expect(leaks(service.log(), TOKEN)).toEqual([]);
      }),
    TIMEOUT_MS,
  );
});

describe("read gate (contract §7)", () => {
  // The F17 keys of the blocking class. Each case keeps one of them.
  const BLOCKING = ["filter.canary.clean", "filter.proc.process", "core.fsmonitor"];

  for (const key of BLOCKING) {
    caseTest(
      TASK,
      `F17: a repository-scope ${key} canary makes readWorkspace and readHistory return TRUST_REQUIRED before any status or diff read, no response holds a commit ID of the fixture, and no canary runs`,
      W,
      () =>
        withService({ name: `t071-gate-${key.replaceAll(".", "-")}` }, async (service) => {
          const built = buildF17(gitPath(), `t071-gate-${key.replaceAll(".", "-")}`, "trust");
          const repo = repoOf(built);
          for (const other of BLOCKING) if (other !== key) config(repo, "--unset", other);
          const { repositoryId, generation } = await service.register(repo);
          const { workspace, history } = await readBoth(service, repositoryId, generation);
          expect({ workspace: gate(workspace), history: gate(history) }).toEqual({ workspace: TRUST_REQUIRED, history: TRUST_REQUIRED });
          expect(readCalls(service)).toEqual([]);
          expectNoHeldRow(service, repo);
          expect((await trustOf(service, repositoryId)).approvalRequired.reads).toBe(true);
          expect(f17Ran(built)).toEqual([]);
        }),
      TIMEOUT_MS,
    );
  }

  caseTest(
    TASK,
    "the same keys in the owned global configuration do not block reads when their program is absolute and outside the repository",
    W,
    async () => {
      const built = buildF02(gitPath(), "t071-global-absolute");
      const keys = ["filter.t071.clean", "filter.t071.process", "core.fsmonitor"];
      const { environment } = ownGlobal(
        built,
        keys.map((key) => [key, outsideProgram(built, key.replaceAll(".", "-")).command]),
      );
      await withService({ name: "t071-global-absolute", environment }, async (service) => {
        const { repositoryId, generation } = await service.register(repoOf(built));
        const trust = await trustOf(service, repositoryId);
        for (const key of keys) expect({ key, scopes: trust.entries.filter((e) => e.key === key).map((e) => e.scope) }).toEqual({ key, scopes: ["global"] });
        expect(trust.approvalRequired.reads).toBe(false);
        const { workspace, history } = await readBoth(service, repositoryId, generation);
        expect({ workspace: outcome(workspace), history: outcome(history) }).toEqual({ workspace: SUCCEEDED, history: SUCCEEDED });
      });
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "filter.<driver>.smudge, filter.<driver>.required, diff.<driver>.textconv, diff.<driver>.command, and diff.external do not block reads",
    W,
    () =>
      withService({ name: "t071-nonblocking" }, async (service) => {
        const built = buildF02(gitPath(), "t071-nonblocking");
        const repo = repoOf(built);
        const programs = ["smudge", "textconv", "diff-command", "diff-external"].map((name) => outsideProgram(built, name));
        config(repo, "filter.t071.smudge", programs[0]!.command);
        config(repo, "filter.t071.required", "true");
        config(repo, "diff.t071.textconv", programs[1]!.command);
        config(repo, "diff.t071.command", programs[2]!.command);
        config(repo, "diff.external", programs[3]!.command);
        const { repositoryId, generation } = await service.register(repo);
        expect((await trustOf(service, repositoryId)).approvalRequired.reads).toBe(false);
        const { workspace, history } = await readBoth(service, repositoryId, generation);
        expect({ workspace: outcome(workspace), history: outcome(history) }).toEqual({ workspace: SUCCEEDED, history: SUCCEEDED });
        expect(ran(programs.map((p) => p.log))).toEqual([]);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "with GIT_CONFIG pointing to an owned file, a local filter canary still gives TRUST_REQUIRED, and the canary never runs",
    W,
    async () => {
      const built = buildF17(gitPath(), "t071-git-config", "trust");
      const file = put(built.root, "git-config-file", "[t071]\n\tnote = owned\n");
      await withService({ name: "t071-git-config", environment: serviceEnv({ GIT_CONFIG: file }) }, async (service) => {
        const { repositoryId, generation } = await service.register(repoOf(built));
        const { workspace, history } = await readBoth(service, repositoryId, generation);
        expect({ workspace: gate(workspace), history: gate(history) }).toEqual({ workspace: TRUST_REQUIRED, history: TRUST_REQUIRED });
        expect(readCalls(service)).toEqual([]);
        expectNoHeldRow(service, repoOf(built));
        expect(f17Ran(built)).toEqual([]);
      });
    },
    TIMEOUT_MS,
  );

  for (const [key, label] of [
    ["filter.t071g.clean", "filter"],
    ["core.fsmonitor", "monitor"],
  ] as const) {
    caseTest(
      TASK,
      `a global ${key} with a relative program blocks reads with TRUST_REQUIRED, and its canary never runs`,
      W,
      async () => {
        const built = buildF08(gitPath(), `t071-global-relative-${label}`, "sha1");
        const repo = repoOf(built);
        const program = insideProgram(built, repo, `tools/${label}.sh`);
        const { environment } = ownGlobal(built, [[key, program.command]]);
        await withService({ name: `t071-global-relative-${label}`, environment }, async (service) => {
          const { repositoryId, generation } = await service.register(repo);
          const { workspace, history } = await readBoth(service, repositoryId, generation);
          expect({ workspace: gate(workspace), history: gate(history) }).toEqual({ workspace: TRUST_REQUIRED, history: TRUST_REQUIRED });
          expect(readCalls(service)).toEqual([]);
          expectNoHeldRow(service, repo);
          expect(ran([program.log])).toEqual([]);
        });
      },
      TIMEOUT_MS,
    );
  }

  caseTest(
    TASK,
    "a global include.path to a file inside the worktree makes its keys repository-controlled",
    W,
    async () => {
      const built = buildF08(gitPath(), "t071-global-include", "sha1");
      const repo = repoOf(built);
      const program = outsideProgram(built, "include-clean");
      const included = put(repo, "t071-include.gitconfig", `[filter "t071inc"]\n\tclean = ${program.command}\n`);
      const { environment } = ownGlobal(built, [["include.path", slash(included)]]);
      await withService({ name: "t071-global-include", environment }, async (service) => {
        const { repositoryId, generation } = await service.register(repo);
        const trust = await trustOf(service, repositoryId);
        const entry = trust.entries.find((e) => e.key === "filter.t071inc.clean");
        expect({ scope: entry?.scope, origin: originPath(entry?.origin, repo) }).toEqual({ scope: "global", origin: samePath(included) });
        expect(trust.approvalRequired.reads).toBe(true);
        const { workspace, history } = await readBoth(service, repositoryId, generation);
        expect({ workspace: gate(workspace), history: gate(history) }).toEqual({ workspace: TRUST_REQUIRED, history: TRUST_REQUIRED });
        expect(ran([program.log])).toEqual([]);
      });
    },
    TIMEOUT_MS,
  );
});

describe("partial clone (contract §7 \"Missing objects\")", () => {
  const noLazyFetchFirst = (service: Service) => service.runner.calls.filter((c) => c.contextKind !== "gitProbe" && c.arguments[0] !== "--no-lazy-fetch").map((c) => c.arguments.join(" "));

  for (const variant of ["partial-reset-soft", "partial-read-tree"] as const) {
    caseTest(
      TASK,
      `F17 ${variant}: readWorkspace and readHistory never run the remote.origin.uploadpack canary, before or after approval, and every argument array starts with --no-lazy-fetch`,
      W,
      () =>
        withService({ name: `t071-${variant}` }, async (service) => {
          const built = buildF17(gitPath(), `t071-${variant}`, variant);
          const clone = repoOf(built, "clone");
          const uploadpack = join(built.root, built.facts.canaries.uploadpack!);
          // Oracle: these reads need no missing object.
          git(clone, ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--find-renames", "--ignore-submodules=dirty"]);
          const { repositoryId, generation } = await service.register(clone);
          const before = await readBoth(service, repositoryId, generation);
          expect({ workspace: outcome(before.workspace), history: outcome(before.history) }).toEqual({ workspace: SUCCEEDED, history: SUCCEEDED });
          await approve(service, repositoryId);
          const after = await readBoth(service, repositoryId, generation);
          expect({ workspace: outcome(after.workspace), history: outcome(after.history) }).toEqual({ workspace: SUCCEEDED, history: SUCCEEDED });
          expect(existsSync(uploadpack)).toBe(false);
          expect(noLazyFetchFirst(service)).toEqual([]);
        }),
      TIMEOUT_MS,
    );
  }

  caseTest(
    TASK,
    "F17 partial-read-tree: a status read that needs a missing blob ends limited with OBJECT_MISSING and the remedy text, its cat-file --batch-check object check starts with --no-lazy-fetch, and git cat-file -e still fails",
    W,
    () =>
      withService({ name: "t071-missing-blob" }, async (service) => {
        const built = buildF17(gitPath(), "t071-missing-blob", "partial-read-tree");
        const clone = repoOf(built, "clone");
        const uploadpack = join(built.root, built.facts.canaries.uploadpack!);
        // A staged rename of a path whose index blob is missing. Status rename detection then reads that blob.
        const missing = git(clone, ["--no-lazy-fetch", "ls-files", "-s", "--", "data.txt"]).split(" ")[1]!;
        expect((built.facts.notes.missingBlobs as string[]).includes(missing)).toBe(true);
        git(clone, ["--no-lazy-fetch", "update-index", "--force-remove", "--", "data.txt"]);
        git(clone, ["--no-lazy-fetch", "update-index", "--add", "--cacheinfo", `100644,${missing},renamed.txt`]);
        const catFile = () => Bun.spawnSync([gitPath(), "--no-lazy-fetch", "cat-file", "-e", missing], { cwd: clone, env: fixtureEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" }).exitCode;
        expect(catFile()).not.toBe(0);
        // Oracle: Git's own status with these options fails on the missing blob.
        git(clone, ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--find-renames", "--ignore-submodules=dirty"], { allowExit: [128] });

        const { repositoryId } = await service.register(clone);
        const read = await service.readWorkspace(repositoryId);
        expect(outcome(read)).toEqual({ state: "limited", code: "OBJECT_MISSING" });
        expect(read.result?.completeness).toMatchObject({ state: "limited", code: "OBJECT_MISSING" });
        expect(JSON.stringify(read)).toContain(OBJECT_MISSING_REMEDY);
        const checks = service.runner.calls.filter((c) => subcommand(c.arguments) === "cat-file" && c.arguments.includes("--batch-check"));
        expect(checks.length).toBeGreaterThan(0);
        expect(checks.some((c) => c.input !== undefined && new TextDecoder().decode(c.input).split(/\s/).includes(missing))).toBe(true);
        expect(noLazyFetchFirst(service)).toEqual([]);
        expect(catFile()).not.toBe(0);
        expect(existsSync(uploadpack)).toBe(false);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    "T319",
    "F17 partial-tree-none: a status read that needs the missing HEAD tree ends limited with OBJECT_MISSING and the remedy text, and its object check input holds that tree ID",
    W,
    () =>
      withService({ name: "t319-missing-tree" }, async (service) => {
        const built = buildF17(gitPath(), "t319-missing-tree", "partial-tree-none");
        const clone = repoOf(built, "clone");
        const uploadpack = join(built.root, built.facts.canaries.uploadpack!);
        const tree = built.facts.notes.missingTree as string;
        const catFile = (oid: string) => Bun.spawnSync([gitPath(), "--no-lazy-fetch", "cat-file", "-e", oid], { cwd: clone, env: fixtureEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" }).exitCode;
        // Oracle: the HEAD commit is present, and its root tree is missing.
        expect(catFile("HEAD")).toBe(0);
        expect(git(clone, ["--no-lazy-fetch", "cat-file", "commit", "HEAD"])).toStartWith(`tree ${tree}\n`);
        expect(catFile(tree)).not.toBe(0);
        // Oracle: Git's own status with these options fails on the missing tree.
        git(clone, ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--find-renames", "--ignore-submodules=dirty"], { allowExit: [128] });

        const { repositoryId } = await service.register(clone);
        const read = await service.readWorkspace(repositoryId);
        expect(outcome(read)).toEqual({ state: "limited", code: "OBJECT_MISSING" });
        expect(read.result?.completeness).toMatchObject({ state: "limited", code: "OBJECT_MISSING" });
        expect(JSON.stringify(read)).toContain(OBJECT_MISSING_REMEDY);
        const checks = service.runner.calls.filter((c) => subcommand(c.arguments) === "cat-file" && c.arguments.includes("--batch-check"));
        expect(checks.some((c) => c.input !== undefined && new TextDecoder().decode(c.input).split(/\s/).includes(tree))).toBe(true);
        expect(noLazyFetchFirst(service)).toEqual([]);
        expect(catFile(tree)).not.toBe(0);
        expect(existsSync(uploadpack)).toBe(false);
      }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "F17 partial clone: readComparison never runs the remote.origin.uploadpack canary, before or after approval", ["shell-double"], async () => {
    for (const variant of ["partial-reset-soft", "partial-read-tree"] as const) {
      const built = buildF17(gitPath(), `t071-${variant}-comparison`, variant);
      const service = await openService({ git: gitPath(), name: `t071-${variant}-comparison` });
      try {
        const { repositoryId } = await service.register(repoOf(built, "clone"));
        for (const approved of [false, true]) {
          if (approved) await approve(service, repositoryId);
          const read = (await service.readWorkspace(repositoryId)).result!;
          for (const entry of read.entries) {
            await service.request("readComparison", { snapshotId: read.snapshotId, entryId: entry.entryId }, { repositoryId, repositoryGeneration: read.generation, selectionId: crypto.randomUUID() });
          }
          expect({ variant, approved, ran: existsSync(join(built.root, built.facts.canaries.uploadpack!)) }).toEqual({ variant, approved, ran: false });
        }
      } finally {
        await service.dispose();
      }
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "F17 partial-read-tree: an unstaged comparison whose index blob is missing gives OBJECT_MISSING and no hunk, although ls-files --eol exits 0 with i/none", ["shell-double"], async () => {
    const built = buildF17(gitPath(), "t071-missing-index-blob", "partial-read-tree");
    const clone = repoOf(built, "clone");
    // Oracle: `ls-files --eol` exits 0 and reports `i/none` for the missing index blob (contract §4).
    expect(git(clone, ["--no-lazy-fetch", "--no-optional-locks", "ls-files", "--eol", "--", "data.txt"])).toStartWith("i/none");
    const service = await openService({ git: gitPath(), name: "t071-missing-index-blob" });
    try {
      const { repositoryId } = await service.register(clone);
      const read = (await service.readWorkspace(repositoryId)).result!;
      const entry = read.entries.find((e) => e.path === "data.txt" && e.category === "unstaged")!;
      const comparison = await service.request("readComparison", { snapshotId: read.snapshotId, entryId: entry.entryId }, { repositoryId, repositoryGeneration: read.generation, selectionId: crypto.randomUUID() });
      expect(comparison.code).toBe("OBJECT_MISSING");
      expect(valuesOf(comparison.result, "hunkId")).toEqual([]);
      expect(existsSync(join(built.root, built.facts.canaries.uploadpack!))).toBe(false);
    } finally {
      await service.dispose();
    }
  }, TIMEOUT_MS);
});

describe("untracked reads (contract §4)", () => {
  caseTest(TASK, "F17: with local diff.external and diff.<driver>.textconv canaries on an untracked file, readComparison runs neither canary", ["shell-double"], async () => {
    const built = buildF17(gitPath(), "t071-untracked-diff", "trust");
    const service = await openService({ git: gitPath(), name: "t071-untracked-diff" });
    try {
      const { repositoryId } = await service.register(repoOf(built));
      await approve(service, repositoryId);
      const read = (await service.readWorkspace(repositoryId)).result!;
      const entry = read.entries.find((e) => e.path === "untracked.tcv" && e.category === "untracked")!;
      const comparison = await service.request("readComparison", { snapshotId: read.snapshotId, entryId: entry.entryId }, { repositoryId, repositoryGeneration: read.generation, selectionId: crypto.randomUUID() });
      expect(comparison.state).toBe("succeeded");
      expect(f17Ran(built).filter((name) => name === "diff-external" || name === "textconv")).toEqual([]);
    } finally {
      await service.dispose();
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "F17: an untracked file with a local filter attribute gives reason filter, and its clean canary never runs, also after approval", ["shell-double"], async () => {
    const built = buildF17(gitPath(), "t071-untracked-filter", "trust");
    const service = await openService({ git: gitPath(), name: "t071-untracked-filter" });
    try {
      const { repositoryId, generation } = await service.register(repoOf(built));
      expect(gate(await service.readWorkspace(repositoryId, undefined, generation))).toEqual(TRUST_REQUIRED);
      await approve(service, repositoryId);
      const read = (await service.readWorkspace(repositoryId)).result!;
      const entry = read.entries.find((e) => e.path === "untracked.dat" && e.category === "untracked")!;
      const comparison = await service.request("readComparison", { snapshotId: read.snapshotId, entryId: entry.entryId }, { repositoryId, repositoryGeneration: read.generation, selectionId: crypto.randomUUID() });
      expect(valuesOf(comparison.result, "support")).toEqual(["filter"]);
      expect(existsSync(join(built.root, built.facts.canaries.clean!))).toBe(false);
    } finally {
      await service.dispose();
    }
  }, TIMEOUT_MS);
});

describe("readTrust listing (contract §7)", () => {
  // Contract §7 "Value display allowlist" keys of this case, as Git prints them.
  const SHOWN = new Set([
    "filter.t071.clean",
    "filter.t071.process",
    "filter.t071.smudge",
    "filter.t071wt.clean",
    "core.fsmonitor",
    "diff.t071.textconv",
    "diff.t071.command",
    "diff.external",
    "gpg.program",
    "gpg.ssh.program",
    "gpg.ssh.defaultkeycommand",
  ]);

  caseTest(
    TASK,
    "readTrust lists traditional hooks, git hook list registrations with disabled ones, conditional includes, worktree configuration, filters, monitors, diff tools, and signing programs",
    W,
    () =>
      withService({ name: "t071-listing" }, async (service) => {
        const built = buildF02(gitPath(), "t071-listing");
        const repo = repoOf(built);
        const program = (name: string) => outsideProgram(built, name).command;
        for (const hook of ["pre-commit", "post-checkout"]) chmodSync(put(repo, `.git/hooks/${hook}`, `#!/bin/sh\nexec ${program(`hook-${hook}`)}\n`), 0o755);
        config(repo, "hook.t071.command", program("registered"));
        config(repo, "hook.t071.event", "pre-commit");
        config(repo, "hook.t071off.command", program("disabled"));
        config(repo, "hook.t071off.event", "post-commit");
        config(repo, "hook.t071off.enabled", "false");
        const include = `includeIf.gitdir:${slash(join(built.root, "elsewhere"))}/.path`;
        config(repo, include, slash(join(built.root, "included.gitconfig")));
        config(repo, "extensions.worktreeConfig", "true");
        config(repo, "--worktree", "filter.t071wt.clean", program("worktree-clean"));
        for (const key of ["filter.t071.clean", "filter.t071.process", "filter.t071.smudge", "core.fsmonitor", "diff.t071.textconv", "diff.t071.command", "diff.external", "gpg.program", "gpg.ssh.program", "gpg.ssh.defaultKeyCommand"]) {
          config(repo, key, program(key.replaceAll(".", "-")));
        }
        const oracle = configListing(repo);
        const keys = [...SHOWN, include.replace("includeIf", "includeif")];
        expect(oracle.find((e) => e.key === "filter.t071wt.clean")?.scope).toBe("worktree");

        const { repositoryId } = await service.register(repo);
        const trust = await trustOf(service, repositoryId);
        for (const key of keys) {
          const expected = oracle.filter((e) => e.key === key);
          expect({ key, oracle: expected.length }).toEqual({ key, oracle: 1 });
          const got = trust.entries.filter((e) => e.key === key);
          expect({ key, count: got.length, scope: got[0]?.scope, origin: originPath(got[0]?.origin, repo), value: got[0]?.value }).toEqual({
            key,
            count: 1,
            scope: expected[0]!.scope,
            origin: originPath(expected[0]!.origin, repo),
            value: SHOWN.has(key) ? (expected[0]!.value ?? undefined) : undefined,
          });
        }
        // Per event, the service lists one hook for each oracle hook: the scope of a configured hook, or none for a hooks-directory hook, and the disabled flag.
        const shape = (hooks: { scope?: string; disabled?: boolean }[]) => hooks.map((h) => `${h.scope ?? "hookdir"} ${h.disabled === true ? "disabled" : "enabled"}`).sort();
        for (const event of ["pre-commit", "post-checkout", "post-commit"]) {
          const expected = hookList(repo, event);
          expect({ event, oracle: expected.length > 0 }).toEqual({ event, oracle: true });
          expect({ event, hooks: shape(trust.hooks.filter((h) => h.event === event)) }).toEqual({ event, hooks: shape(expected) });
        }
        expect(trust.hooks.some((h) => h.event === "post-commit" && h.disabled === true)).toBe(true);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "F17: readTrust returns the key, scope, and origin of http.extraheader and of a remote URL with user information, and neither secret value appears",
    W,
    () =>
      withService({ name: "t071-secrets" }, async (service) => {
        const built = buildF17(gitPath(), "t071-secrets", "trust");
        const repo = repoOf(built);
        const oracle = configListing(repo);
        const { repositoryId } = await service.register(repo);
        const trust = await trustOf(service, repositoryId);
        for (const key of ["http.extraheader", "remote.origin.url"]) {
          const expected = oracle.find((e) => e.key === key)!;
          const got = trust.entries.filter((e) => e.key === key);
          expect({ key, count: got.length, scope: got[0]?.scope, origin: originPath(got[0]?.origin, repo), value: got[0]?.value }).toEqual({
            key,
            count: 1,
            scope: expected.scope,
            origin: originPath(expected.origin, repo),
            value: undefined,
          });
        }
        for (const secret of built.facts.notes.secrets as string[]) {
          expect({ secret, responses: leaks(service.responses, secret), progress: leaks(service.progress, secret), log: leaks(service.log(), secret) }).toEqual({ secret, responses: [], progress: [], log: [] });
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a core.hooksPath from GIT_CONFIG_COUNT appears in readTrust with scope command",
    W,
    async () => {
      const built = buildF02(gitPath(), "t071-command-scope");
      const repo = repoOf(built);
      const hooks = slash(join(built.root, "command-hooks"));
      const command = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooks };
      const expected = configListing(repo, command).find((e) => e.key === "core.hookspath");
      expect({ scope: expected?.scope, value: expected?.value }).toEqual({ scope: "command", value: hooks });
      await withService({ name: "t071-command-scope", environment: serviceEnv(command) }, async (service) => {
        const { repositoryId } = await service.register(repo);
        const got = (await trustOf(service, repositoryId)).entries.filter((e) => e.key === "core.hookspath");
        expect(got.map((e) => ({ scope: e.scope, value: e.value }))).toEqual([{ scope: "command", value: hooks }]);
      });
    },
    TIMEOUT_MS,
  );
});

describe("approval required for reads and for commit (contract §7 \"Mutation trust\")", () => {
  caseTest(
    TASK,
    "readTrust reports approvalRequired separately: a repository pre-commit hook sets it for commit only, and reads run",
    W,
    () =>
      withService({ name: "t071-pre-commit" }, async (service) => {
        const built = buildF02(gitPath(), "t071-pre-commit");
        const repo = repoOf(built);
        const hook = outsideProgram(built, "pre-commit");
        chmodSync(put(repo, ".git/hooks/pre-commit", `#!/bin/sh\nexec ${hook.command}\n`), 0o755);
        const { repositoryId, generation } = await service.register(repo);
        expect((await trustOf(service, repositoryId)).approvalRequired).toEqual({ reads: false, commit: true });
        const { workspace, history } = await readBoth(service, repositoryId, generation);
        expect({ workspace: outcome(workspace), history: outcome(history) }).toEqual({ workspace: SUCCEEDED, history: SUCCEEDED });
        expect(ran([hook.log])).toEqual([]);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a local gpg.ssh.defaultKeyCommand with gpg.format=ssh, commit.gpgsign=true, and no user.signingKey sets approvalRequired for commit only, and readTrust shows its value",
    W,
    () =>
      withService({ name: "t071-signing" }, async (service) => {
        const built = buildF02(gitPath(), "t071-signing");
        const repo = repoOf(built);
        const program = outsideProgram(built, "default-key-command");
        config(repo, "gpg.format", "ssh");
        config(repo, "commit.gpgsign", "true");
        config(repo, "gpg.ssh.defaultKeyCommand", program.command);
        expect(configListing(repo).filter((e) => e.key === "user.signingkey")).toEqual([]);
        const { repositoryId } = await service.register(repo);
        const trust = await trustOf(service, repositoryId);
        expect(trust.approvalRequired).toEqual({ reads: false, commit: true });
        expect(trust.entries.filter((e) => e.key === "gpg.ssh.defaultkeycommand").map((e) => e.value)).toEqual([program.command]);
        expect(ran([program.log])).toEqual([]);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "an owned global core.hooksPath=.githooks with a committed pre-commit canary makes readTrust report commit approval required, and the canary never runs before approval",
    W,
    async () => {
      const built = buildF08(gitPath(), "t071-global-hooks-path", "sha1");
      const repo = repoOf(built);
      const canary = outsideProgram(built, "githooks-pre-commit");
      chmodSync(put(repo, ".githooks/pre-commit", `#!/bin/sh\nexec ${canary.command}\n`), 0o755);
      git(repo, ["add", "--", ".githooks/pre-commit"]);
      git(repo, ["commit", "-q", "--no-verify", "-m", "hooks"]);
      const { environment } = ownGlobal(built, [["core.hooksPath", ".githooks"]]);
      await withService({ name: "t071-global-hooks-path", environment }, async (service) => {
        const { repositoryId, generation } = await service.register(repo);
        expect((await trustOf(service, repositoryId)).approvalRequired).toEqual({ reads: false, commit: true });
        const { workspace } = await readBoth(service, repositoryId, generation);
        expect(outcome(workspace)).toEqual(SUCCEEDED);
        expect(ran([canary.log])).toEqual([]);
      });
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a global hook.<name>.command with a relative program makes readTrust report commit approval required, and the canary never runs before approval",
    W,
    async () => {
      const built = buildF08(gitPath(), "t071-global-hook-command", "sha1");
      const repo = repoOf(built);
      const program = insideProgram(built, repo, "tools/hook.sh");
      const { environment } = ownGlobal(built, [
        ["hook.t071g.command", program.command],
        ["hook.t071g.event", "pre-commit"],
      ]);
      await withService({ name: "t071-global-hook-command", environment }, async (service) => {
        const { repositoryId, generation } = await service.register(repo);
        expect((await trustOf(service, repositoryId)).approvalRequired).toEqual({ reads: false, commit: true });
        const { workspace } = await readBoth(service, repositoryId, generation);
        expect(outcome(workspace)).toEqual(SUCCEEDED);
        expect(ran([program.log])).toEqual([]);
      });
    },
    TIMEOUT_MS,
  );
});

describe("trust state (data-model §3)", () => {
  caseTest(
    TASK,
    "trust state is untrusted, approved, changed, or revoked",
    W,
    () =>
      withService({ name: "t071-states" }, async (service) => {
        const built = buildF17(gitPath(), "t071-states", "trust");
        const repo = repoOf(built);
        const { repositoryId } = await service.register(repo);
        const first = await trustOf(service, repositoryId);
        expect(first.state).toBe("untrusted");
        const approved = await approve(service, repositoryId, first);
        expect((await trustOf(service, repositoryId)).state).toBe("approved");
        config(repo, "filter.canary.clean", "./tools/clean.sh --t071");
        const changed = await trustOf(service, repositoryId);
        expect({ state: changed.state, same: changed.fingerprint === first.fingerprint }).toEqual({ state: "changed", same: false });
        // The original value gives the approved fingerprint again.
        config(repo, "filter.canary.clean", "./tools/clean.sh");
        expect(await trustOf(service, repositoryId)).toMatchObject({ state: "approved", fingerprint: first.fingerprint });
        expect(outcome(await service.revokeTrust(repositoryId, approved.trustId))).toEqual(SUCCEEDED);
        expect((await trustOf(service, repositoryId)).state).toBe("revoked");
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a configuration change after approval gives TRUST_CHANGED, and the approval of the old fingerprint no longer applies",
    W,
    () =>
      withService({ name: "t071-config-change" }, async (service) => {
        const built = buildF17(gitPath(), "t071-config-change", "trust");
        const repo = repoOf(built);
        const { repositoryId, generation } = await service.register(repo);
        const issued = await trustOf(service, repositoryId);
        await approve(service, repositoryId, issued);
        expect(outcome(await service.readWorkspace(repositoryId))).toEqual(SUCCEEDED);
        config(repo, "filter.canary.clean", "./tools/clean.sh --t071");
        const { workspace, history } = await readBoth(service, repositoryId, generation);
        expect({ workspace: gate(workspace), history: gate(history) }).toEqual({ workspace: TRUST_CHANGED, history: TRUST_CHANGED });
        expect((await trustOf(service, repositoryId)).state).toBe("changed");
        // Contract §9: an approveTrust fingerprint-generation mismatch gives TRUST_CHANGED.
        const persists = service.trustStore.persists.length;
        expect(gate(await service.approveTrust(repositoryId, issued.fingerprint, issued.generation))).toEqual(TRUST_CHANGED);
        expect(service.trustStore.persists.length).toBe(persists);
      }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a configuration change after approval invalidates a dependent hunk approval: applyHunk gives TRUST_CHANGED", ["shell-double"], async () => {
    const built = buildF17(gitPath(), "t071-hunk-invalidated", "trust");
    const repo = repoOf(built);
    put(repo, "README.md", "# changed\n");
    const service = await openService({ git: gitPath(), name: "t071-hunk-invalidated" });
    try {
      const { repositoryId } = await service.register(repo);
      await approve(service, repositoryId);
      const read = (await service.readWorkspace(repositoryId)).result!;
      const entry = read.entries.find((e) => e.path === "README.md" && e.category === "unstaged")!;
      const comparison = await service.request("readComparison", { snapshotId: read.snapshotId, entryId: entry.entryId }, { repositoryId, repositoryGeneration: read.generation, selectionId: crypto.randomUUID() });
      const [comparisonId] = valuesOf(comparison.result, "comparisonId");
      const [hunkId] = valuesOf(comparison.result, "hunkId");
      config(repo, "filter.canary.clean", "./tools/clean.sh --t071");
      const applied = await service.request("applyHunk", { comparisonId, hunkId, snapshotId: read.snapshotId, direction: "stage" }, { repositoryId, repositoryGeneration: read.generation });
      expect(applied.code).toBe("TRUST_CHANGED");
    } finally {
      await service.dispose();
    }
  }, TIMEOUT_MS);

  caseTest(
    TASK,
    "with required approval, only an approval of the new fingerprint clears TRUST_CHANGED",
    W,
    () =>
      withService({ name: "t071-new-fingerprint" }, async (service) => {
        const built = buildF17(gitPath(), "t071-new-fingerprint", "trust");
        const repo = repoOf(built);
        const { repositoryId } = await service.register(repo);
        const old = await trustOf(service, repositoryId);
        await approve(service, repositoryId, old);
        config(repo, "filter.canary.clean", "./tools/clean.sh --t071");
        expect(gate(await service.readWorkspace(repositoryId))).toEqual(TRUST_CHANGED);
        expect(gate(await service.readWorkspace(repositoryId, { refresh: true, check: "full" }))).toEqual(TRUST_CHANGED);
        expect(gate(await service.readWorkspace(repositoryId))).toEqual(TRUST_CHANGED);
        expect(gate(await service.approveTrust(repositoryId, old.fingerprint, old.generation))).toEqual(TRUST_CHANGED);
        const current = await trustOf(service, repositoryId);
        expect({ state: current.state, reads: current.approvalRequired.reads }).toEqual({ state: "changed", reads: true });
        await approve(service, repositoryId, current);
        expect(outcome(await service.readWorkspace(repositoryId))).toEqual(SUCCEEDED);
        expect((await trustOf(service, repositoryId)).state).toBe("approved");
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "without required approval, a changed fingerprint blocks no read: readTrust reports changed with both approvalRequired flags false, and the next readWorkspace runs",
    W,
    () =>
      withService({ name: "t071-not-required" }, async (service) => {
        const built = buildF02(gitPath(), "t071-not-required");
        const repo = repoOf(built);
        config(repo, "diff.external", outsideProgram(built, "diff-external-a").command);
        const { repositoryId, generation } = await service.register(repo);
        const first = await trustOf(service, repositoryId);
        expect(first.approvalRequired).toEqual({ reads: false, commit: false });
        await approve(service, repositoryId, first);
        config(repo, "diff.external", outsideProgram(built, "diff-external-b").command);
        const changed = await trustOf(service, repositoryId);
        expect({ state: changed.state, approvalRequired: changed.approvalRequired }).toEqual({ state: "changed", approvalRequired: { reads: false, commit: false } });
        const { workspace, history } = await readBoth(service, repositoryId, generation);
        expect({ workspace: outcome(workspace), history: outcome(history) }).toEqual({ workspace: SUCCEEDED, history: SUCCEEDED });
        expect(service.trustStore.records.length).toBe(1);
      }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "without required approval, a changed fingerprint gives TRUST_CHANGED at a hunk checkpoint, and it clears after the next readWorkspace and a new selection", ["shell-double"], async () => {
    const built = buildF02(gitPath(), "t071-not-required-hunk");
    const repo = repoOf(built);
    config(repo, "diff.external", outsideProgram(built, "diff-external-a").command);
    const service = await openService({ git: gitPath(), name: "t071-not-required-hunk" });
    try {
      const { repositoryId } = await service.register(repo);
      await approve(service, repositoryId);
      const select = async () => {
        const read = (await service.readWorkspace(repositoryId)).result!;
        const entry = read.entries.find((e) => e.path === "multi.txt" && e.category === "unstaged")!;
        const comparison = await service.request("readComparison", { snapshotId: read.snapshotId, entryId: entry.entryId }, { repositoryId, repositoryGeneration: read.generation, selectionId: crypto.randomUUID() });
        const [comparisonId] = valuesOf(comparison.result, "comparisonId");
        const [hunkId] = valuesOf(comparison.result, "hunkId");
        return () => service.request("applyHunk", { comparisonId, hunkId, snapshotId: read.snapshotId, direction: "stage" }, { repositoryId, repositoryGeneration: read.generation });
      };
      const old = await select();
      config(repo, "diff.external", outsideProgram(built, "diff-external-b").command);
      expect((await old()).code).toBe("TRUST_CHANGED");
      const fresh = await select();
      expect(outcome(await fresh())).toEqual(SUCCEEDED);
    } finally {
      await service.dispose();
    }
  }, TIMEOUT_MS);
});

describe("trust approval store (contract §7 \"Trust approval store\")", () => {
  caseTest(
    TASK,
    "approveTrust sends confirm, and a declined confirmation ends canceled with no record",
    W,
    () =>
      withService({ name: "t071-declined" }, async (service) => {
        const built = buildF17(gitPath(), "t071-declined", "trust");
        const { repositoryId } = await service.register(repoOf(built));
        const trust = await trustOf(service, repositoryId);
        service.runner.inject.confirmResult = "declined";
        expect(outcome(await service.approveTrust(repositoryId, trust.fingerprint, trust.generation))).toEqual({ state: "canceled", code: "CANCELED" });
        expect({ persists: service.trustStore.persists, records: service.trustStore.records }).toEqual({ persists: [true], records: [] });
        expect((await trustOf(service, repositoryId)).state).toBe("untrusted");
        expect(gate(await service.readWorkspace(repositoryId))).toEqual(TRUST_REQUIRED);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "after an accepted approval, the store holds one record in the handshake form with the selected Git path, and a new service session with the same store needs no approval",
    W,
    () =>
      withSessions("t071-stored", {}, async (first, set) => {
        const built = buildF17(gitPath(), "t071-stored", "trust");
        const repo = repoOf(built);
        const { repositoryId } = await first.register(repo);
        const trust = await trustOf(first, repositoryId);
        expect(await approve(first, repositoryId, trust)).toMatchObject({ persistence: "stored", saveFailed: false });
        expect(first.trustStore.persists).toEqual([true]);
        expect(first.trustStore.records.length).toBe(1);
        const record = fieldsOf(first.trustStore.records[0]!);
        const paths = gitPaths(repo);
        expect(Object.keys(record).sort()).toEqual(RECORD_FIELDS);
        expect({
          fingerprint: record.configurationFingerprint,
          git: record.gitSelectedPath,
          worktreeRoot: samePath(record.worktreeRoot),
          gitDirectory: samePath(record.gitDirectory),
          commonDirectory: samePath(record.commonDirectory),
        }).toEqual({
          fingerprint: trust.fingerprint,
          git: gitPath(),
          worktreeRoot: samePath(paths.worktreeRoot),
          gitDirectory: samePath(paths.gitDirectory),
          commonDirectory: samePath(paths.commonDirectory),
        });

        const second = set(await nextSession(first, "t071-stored-next"));
        const next = await second.register(repo);
        const stored = await trustOf(second, next.repositoryId);
        expect({ state: stored.state, persistence: stored.persistence, fingerprint: stored.fingerprint }).toEqual({ state: "approved", persistence: "stored", fingerprint: trust.fingerprint });
        const { workspace, history } = await readBoth(second, next.repositoryId, next.generation);
        expect({ workspace: outcome(workspace), history: outcome(history) }).toEqual({ workspace: SUCCEEDED, history: SUCCEEDED });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a changed fingerprint gives TRUST_CHANGED in a new service session",
    W,
    () =>
      withSessions("t071-changed-fingerprint", {}, async (first, set) => {
        const built = buildF17(gitPath(), "t071-changed-fingerprint", "trust");
        const repo = repoOf(built);
        await approve(first, (await first.register(repo)).repositoryId);
        const second = set(await nextSession(first, "t071-changed-fingerprint-next"));
        config(repo, "filter.canary.clean", "./tools/clean.sh --t071");
        const { repositoryId } = await second.register(repo);
        expect((await trustOf(second, repositoryId)).state).toBe("changed");
        expect(gate(await second.readWorkspace(repositoryId))).toEqual(TRUST_CHANGED);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a changed selected Git path gives TRUST_CHANGED",
    W,
    () =>
      withSessions("t071-changed-git-path", {}, async (first, set) => {
        const built = buildF17(gitPath(), "t071-changed-git-path", "trust");
        const repo = repoOf(built);
        await approve(first, (await first.register(repo)).repositoryId);
        // The file that `--exec-path` names is the same Git under another path.
        const other = join(git(built.root, ["--exec-path"]).trim(), process.platform === "win32" ? "git.exe" : "git");
        expect({ exists: existsSync(other), same: foldAscii(other) === foldAscii(gitPath()) }).toEqual({ exists: true, same: false });
        const second = set(await nextSession(first, "t071-changed-git-path-next", { gitSelectedPath: other }));
        const { repositoryId } = await second.register(repo);
        expect((await trustOf(second, repositoryId)).state).toBe("changed");
        expect(gate(await second.readWorkspace(repositoryId))).toEqual(TRUST_CHANGED);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a selected Git path that differs only in ASCII letter case keeps the approval",
    [...W, "windows-path-rules"],
    () =>
      // Git prints the system file origin in the letter case of the path that started it (`file:C:/gIT/etc/gitconfig`), and the fingerprint covers origin bytes.
      // So the case reads no system file, and only the selected-path compare differs.
      withSessions("t071-git-path-ascii-case", { environment: serviceEnv({ GIT_CONFIG_NOSYSTEM: "1" }) }, async (first, set) => {
        const built = buildF17(gitPath(), "t071-git-path-ascii-case", "trust");
        const repo = repoOf(built);
        await approve(first, (await first.register(repo)).repositoryId);
        // Contract §7 follows the §6 "Startup contexts" case rule: only ASCII letters fold.
        // Git for Windows finds its runtime prefix from the `<prefix>\bin\git.exe` names in their own case, so only the folders above them change.
        const kept = join(basename(dirname(dirname(gitPath()))), basename(dirname(gitPath())), basename(gitPath()));
        const above = gitPath().slice(0, -kept.length);
        const other = above.replace(/[A-Za-z]/g, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())) + kept;
        expect(other).not.toBe(gitPath());
        const second = set(await nextSession(first, "t071-git-path-ascii-case-next", { gitSelectedPath: other, environment: serviceEnv({ GIT_CONFIG_NOSYSTEM: "1" }) }));
        const { repositoryId } = await second.register(repo);
        expect((await trustOf(second, repositoryId)).state).toBe("approved");
        expect(outcome(await second.readWorkspace(repositoryId))).toEqual(SUCCEEDED);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a selected Git path with U+212A KELVIN SIGN in place of K gives TRUST_CHANGED",
    [...W, "ntfs-junction"],
    () =>
      withSessions("t071-git-path-kelvin", {}, async (first, set) => {
        const built = buildF17(gitPath(), "t071-git-path-kelvin", "trust");
        const repo = repoOf(built);
        // Two junctions to the Git installation root. NTFS keeps both names apart, because U+212A does not fold to K.
        const install = dirname(dirname(dirname(gitPath())));
        const tail = relative(install, gitPath());
        const viaK = join(built.root, "gitK");
        const viaKelvin = join(built.root, "git\u212A");
        symlinkSync(install, viaK, "junction");
        symlinkSync(install, viaKelvin, "junction");
        const second = set(await nextSession(first, "t071-git-path-kelvin-k", { gitSelectedPath: join(viaK, tail) }));
        await approve(second, (await second.register(repo)).repositoryId);
        const third = set(await nextSession(second, "t071-git-path-kelvin-next", { gitSelectedPath: join(viaKelvin, tail) }));
        const { repositoryId } = await third.register(repo);
        expect((await trustOf(third, repositoryId)).state).toBe("changed");
        expect(gate(await third.readWorkspace(repositoryId))).toEqual(TRUST_CHANGED);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "an injected common-directory identity gives TRUST_CHANGED",
    W,
    () =>
      withSessions("t071-changed-identity", {}, async (first, set) => {
        const built = buildF17(gitPath(), "t071-changed-identity", "trust");
        const repo = repoOf(built);
        await approve(first, (await first.register(repo)).repositoryId);
        const common = fieldsOf(first.trustStore.records[0]!).commonDirectory as string;
        const second = set(await nextSession(first, "t071-changed-identity-next"));
        for (const spelling of new Set([common, slash(common), common.replaceAll("/", "\\")])) second.runner.inject.identities.set(spelling, OTHER_IDENTITY);
        const { repositoryId } = await second.register(repo);
        expect(second.runner.identityCalls.some((c) => c.replies.some((r) => JSON.stringify(r) === JSON.stringify(OTHER_IDENTITY)))).toBe(true);
        expect((await trustOf(second, repositoryId)).state).toBe("changed");
        expect(gate(await second.readWorkspace(repositoryId))).toEqual(TRUST_CHANGED);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a changed Git digest behind the same selected path keeps the approval",
    ["shell-double", "git-for-windows"],
    () =>
      withSessions("t071-changed-digest", {}, async (first, set) => {
        const built = buildF17(gitPath(), "t071-changed-digest", "trust");
        const repo = repoOf(built);
        await approve(first, (await first.register(repo)).repositoryId);
        // Git for Windows layout: `<root>\mingw64\libexec\git-core` holds the resolved file. The `cmd` and `bin` wrappers hold other bytes.
        const execDir = git(built.root, ["--exec-path"]).trim();
        const resolved = join(execDir, "git.exe");
        const root = resolve(execDir, "..", "..", "..");
        const digest = (path: string) => sha256(readFileSync(path));
        const otherDir = ["cmd", "bin"].map((d) => join(root, d)).find((d) => existsSync(join(d, "git.exe")) && digest(join(d, "git.exe")) !== digest(resolved));
        if (otherDir === undefined) throw new Error(`no git.exe with other bytes beside ${resolved}`);

        const second = set(await nextSession(first, "t071-changed-digest-next"));
        // The injected `--exec-path` output names another file behind the same selected path, as after a Git upgrade.
        second.runner.inject.stdout = (call) => (call.arguments.length === 1 && call.arguments[0] === "--exec-path" ? new TextEncoder().encode(`${slash(otherDir)}\n`) : undefined);
        const chosen = await second.request<{ selectedPath: string; executablePath: string; digest: string }>("chooseGit", { bootstrapId: second.runner.addContext("gitProbe", gitPath()), executablePath: gitPath() });
        second.runner.inject.stdout = undefined;
        expect(outcome(chosen)).toEqual(SUCCEEDED);
        expect({ selected: chosen.result!.selectedPath, executable: samePath(chosen.result!.executablePath), digest: chosen.result!.digest }).toEqual({
          selected: gitPath(),
          executable: samePath(join(otherDir, "git.exe")),
          digest: digest(join(otherDir, "git.exe")),
        });
        const { repositoryId } = await second.register(repo);
        expect((await trustOf(second, repositoryId)).state).toBe("approved");
        const read = await second.readWorkspace(repositoryId);
        if (outcome(read).state !== "succeeded") {
          // `RecordedCall` holds no stderr byte count. `exit` is the recorded GitExit.
          const dump = {
            response: read,
            calls: second.runner.calls.map((c) => ({ operationId: c.operationId, contextKind: c.contextKind, arguments: c.arguments, refused: c.refused, exit: c.exit })),
            identityReplies: second.runner.identityCalls.map((c) => ({ operationId: c.operationId, paths: c.paths, replies: c.replies })),
            fileFacts: second.runner.fileFactCalls.map((c) => ({ operationId: c.operationId, facts: c.facts })),
          };
          console.log(`OBSERVATION t071-changed-digest readWorkspace\n${JSON.stringify(dump, null, 2)}\nEND OBSERVATION`);
        }
        expect(outcome(read)).toEqual(SUCCEEDED);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "revokeTrust deletes the record, and the next session reports untrusted",
    W,
    () =>
      withSessions("t071-revoke", {}, async (first, set) => {
        const built = buildF17(gitPath(), "t071-revoke", "trust");
        const repo = repoOf(built);
        const { repositoryId } = await first.register(repo);
        const { trustId } = await approve(first, repositoryId);
        expect(first.trustStore.records.length).toBe(1);
        const revoked = await first.revokeTrust(repositoryId, trustId);
        expect(outcome(revoked)).toEqual(SUCCEEDED);
        expect(first.trustStore.records).toEqual([]);
        const second = set(await nextSession(first, "t071-revoke-next"));
        const next = await second.register(repo);
        expect((await trustOf(second, next.repositoryId)).state).toBe("untrusted");
        expect(gate(await second.readWorkspace(next.repositoryId))).toEqual(TRUST_REQUIRED);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "revokeTrust does not cancel running work, and it returns the process count of the revoke reply",
    W,
    () =>
      withService({ name: "t071-revoke-running" }, async (service) => {
        const built = buildF02(gitPath(), "t071-revoke-running");
        const repo = repoOf(built);
        config(repo, "filter.t071.clean", insideProgram(built, repo, "tools/clean.sh").command);
        // Untracked records above the 64 KiB pipe buffer of the shell double, so the held status process waits on its write.
        for (let i = 0; i < 2600; i++) put(repo, `untracked/${"u".repeat(100)}-${i}.txt`, "");
        const { repositoryId } = await service.register(repo);
        const { trustId } = await approve(service, repositoryId);
        const isStatus = (c: { arguments: readonly string[] }) => c.arguments.includes("status");
        const release = service.runner.pauseStdout(once(isStatus));
        try {
          const read = service.send("readWorkspace", { refresh: false, check: "full" }, { repositoryId });
          const operationId = await service.operationId(read);
          await waitFor("held status call", () => service.runner.calls.some((c) => c.operationId === operationId && isStatus(c)));
          const revoked = await service.revokeTrust(repositoryId, trustId);
          expect(outcome(revoked)).toEqual(SUCCEEDED);
          // The double ends only processes of tagged mutation Jobs. A read has no tag, so the revoke reply is 0 (T100 covers lingering Jobs).
          expect(revoked.result!.endedProcesses).toBe(0);
          expect(((await service.getOperation(operationId)).result as { state: string }).state).toBe("running");
          expect(service.responseAt.has(read)).toBe(false);
          release();
          const done = await service.response(read);
          expect(done.state).not.toBe("canceled");
          expect(service.runner.calls.find((c) => c.operationId === operationId && isStatus(c))?.exit?.exitCode).toBe(0);
        } finally {
          release();
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a configuration listing above 4 MiB blocks approval",
    W,
    () =>
      withService({ name: "t071-input-limit" }, async (service) => {
        const built = buildF02(gitPath(), "t071-input-limit");
        const repo = repoOf(built);
        const file = resolve(repo, git(repo, ["rev-parse", "--git-path", "config"]).trim());
        const value = "v".repeat(80_000);
        writeFileSync(file, `${readFileSync(file, "utf8")}[t071]\n${Array.from({ length: Math.ceil(TRUST_INPUT_BYTES / value.length) + 1 }, (_, i) => `\tk${i} = ${value}\n`).join("")}`);
        const listing = git(repo, ["--no-optional-locks", "config", "list", "--show-scope", "--show-origin", "-z"]);
        expect(Buffer.byteLength(listing)).toBeGreaterThan(TRUST_INPUT_BYTES);
        const { repositoryId, generation } = await service.register(repo);
        const trust = await service.readTrust(repositoryId);
        // Contract §9: an over-bound read ends `limited` with OUTPUT_LIMIT.
        expect(outcome(trust)).toEqual({ state: "limited", code: "OUTPUT_LIMIT" });
        const approved = await service.approveTrust(repositoryId, trust.result?.fingerprint ?? "0".repeat(64), trust.result?.generation ?? generation);
        expect(approved.state).not.toBe("succeeded");
        expect({ persists: service.trustStore.persists, records: service.trustStore.records }).toEqual({ persists: [], records: [] });
      }),
    TIMEOUT_MS,
  );

  // Contract §5 "Trust report rows": a report above a row bound is refused whole, with no entry.
  for (const [rows, reason, bound, record] of [
    ["entries", "TRUST_REPORT_ENTRIES", TRUST_REPORT_ENTRIES, (i: number) => `[t372]\n\tk${i} = v\n`],
    ["hooks", "TRUST_REPORT_HOOKS", TRUST_REPORT_HOOKS, (i: number) => `[hook "t372-${i}"]\n\tevent = pre-commit\n`],
  ] as const)
    caseTest("T372", `${rows}: a report at the bound passes, and one more row gives OUTPUT_LIMIT with reason ${reason}`, W, () => withService({ name: `t372-${rows}` }, async (service) => {
      const repo = repoOf(buildF02(gitPath(), `t372-${rows}`));
      const file = resolve(repo, git(repo, ["rev-parse", "--git-path", "config"]).trim());
      const { repositoryId } = await service.register(repo);
      const base = (await service.readTrust(repositoryId)).result![rows].length;
      const original = readFileSync(file, "utf8");
      const write = (count: number) => writeFileSync(file, original + Array.from({ length: count }, (_, i) => record(i)).join(""));
      write(bound - base);
      const at = await service.readTrust(repositoryId);
      expect({ ...outcome(at), rows: at.result?.[rows].length }).toEqual({ state: "succeeded", code: undefined, rows: bound });
      write(bound - base + 1);
      const above = await service.readTrust(repositoryId);
      expect({ ...outcome(above), result: above.result }).toEqual({ state: "failed", code: "OUTPUT_LIMIT", result: { reason } as never });
    }), TIMEOUT_MS);
});

describe("program file digests (contract §7 \"Program file digests\")", () => {
  caseTest(
    TASK,
    "F17: one changed byte of an approved pre-commit hook gives state changed with commit approval required, restoring it in a new session matches the stored approval, and one changed byte of the clean filter program gives TRUST_CHANGED",
    W,
    () =>
      withSessions("t071-hook-byte", {}, async (first, set) => {
        const built = buildF17(gitPath(), "t071-hook-byte", "trust");
        const repo = repoOf(built);
        const hook = join(repo, ".git", "hooks", "pre-commit");
        const clean = join(repo, "tools", "clean.sh");
        const { repositoryId } = await first.register(repo);
        await approve(first, repositoryId);
        flipByte(hook);
        const changed = await trustOf(first, repositoryId);
        expect({ state: changed.state, commit: changed.approvalRequired.commit }).toEqual({ state: "changed", commit: true });

        flipByte(hook);
        const second = set(await nextSession(first, "t071-hook-byte-next"));
        const next = await second.register(repo);
        expect((await trustOf(second, next.repositoryId)).state).toBe("approved");
        expect(outcome(await second.readWorkspace(next.repositoryId))).toEqual(SUCCEEDED);
        flipByte(clean);
        const { workspace, history } = await readBoth(second, next.repositoryId, next.generation);
        expect({ workspace: gate(workspace), history: gate(history) }).toEqual({ workspace: TRUST_CHANGED, history: TRUST_CHANGED });
      }),
    TIMEOUT_MS,
  );

  // Each over-bound fixture with the `bound` name of contract §7.
  const OVER: [bound: "file-bytes" | "file-count" | "total-bytes", label: string, build: (name: string) => string][] = [
    [
      "file-bytes",
      "a repository-controlled program file above 1 MiB",
      (name) => {
        const built = buildF17(gitPath(), name, "trust");
        padTo(join(repoOf(built), "tools", "clean.sh"), TRUST_DIGEST_FILE_BYTES + 1);
        return repoOf(built);
      },
    ],
    ["file-count", `${TRUST_DIGEST_FILES + 1} repository-controlled program files`, (name) => withPrograms(name, TRUST_DIGEST_FILES + 1)],
    [
      "total-bytes",
      `${TRUST_DIGEST_TOTAL_BYTES / TRUST_DIGEST_FILE_BYTES + 1} files of 1 MiB each (above the 8 MiB total)`,
      (name) => withPrograms(name, TRUST_DIGEST_TOTAL_BYTES / TRUST_DIGEST_FILE_BYTES + 1, TRUST_DIGEST_FILE_BYTES),
    ],
  ];

  // An F02 copy with `count` local clean filters, each naming its own program file inside the worktree.
  function withPrograms(name: string, count: number, size?: number): string {
    const built = buildF02(gitPath(), name);
    const repo = repoOf(built);
    for (let i = 0; i < count; i++) config(repo, `filter.p${i}.clean`, insideProgram(built, repo, `tools/p${String(i).padStart(2, "0")}.sh`, size).command);
    return repo;
  }

  for (const [bound, label, build] of OVER) {
    caseTest(
      TASK,
      `${label} makes readTrust report bound ${bound} and persistence session; approveTrust sends confirm with persist false, the store writes no record, and reads run in that session`,
      W,
      () =>
        withService({ name: `t071-over-${bound}` }, async (service) => {
          const repo = build(`t071-over-${bound}`);
          const { repositoryId, generation } = await service.register(repo);
          expect(gate(await service.readWorkspace(repositoryId))).toEqual(TRUST_REQUIRED);
          const trust = await trustOf(service, repositoryId);
          expect({ bound: trust.bound, persistence: trust.persistence, state: trust.state }).toEqual({ bound, persistence: "session", state: "untrusted" });
          expect(await approve(service, repositoryId, trust)).toMatchObject({ persistence: "session", saveFailed: false });
          expect({ persists: service.trustStore.persists, records: service.trustStore.records }).toEqual({ persists: [false], records: [] });
          const { workspace, history } = await readBoth(service, repositoryId, generation);
          expect({ workspace: outcome(workspace), history: outcome(history) }).toEqual({ workspace: SUCCEEDED, history: SUCCEEDED });
          expect(await trustOf(service, repositoryId)).toMatchObject({ state: "approved", persistence: "session" });
        }),
      TIMEOUT_MS,
    );
  }

  caseTest(
    TASK,
    `${TRUST_DIGEST_FILES} program files, and ${TRUST_DIGEST_TOTAL_BYTES / TRUST_DIGEST_FILE_BYTES} files of 1 MiB each, stay within the bounds: no bound, and persistence stored`,
    W,
    () =>
      withService({ name: "t071-at-bounds" }, async (service) => {
        for (const [label, repo] of [
          ["file-count", withPrograms("t071-at-file-count", TRUST_DIGEST_FILES)],
          ["total-bytes", withPrograms("t071-at-total-bytes", TRUST_DIGEST_TOTAL_BYTES / TRUST_DIGEST_FILE_BYTES, TRUST_DIGEST_FILE_BYTES)],
        ] as const) {
          const { repositoryId } = await service.register(repo);
          const trust = await trustOf(service, repositoryId);
          expect({ label, bound: trust.bound, persistence: trust.persistence }).toEqual({ label, bound: undefined, persistence: "stored" });
        }
      }),
    TIMEOUT_MS,
  );

  // Contract §7 "Program file digests": the 64-file bound counts only `file` facts. An absent program takes no slot.
  caseTest(
    "T309",
    `${TRUST_DIGEST_FILES + 6} absent program paths and one program file stay within the bounds: no bound, persistence stored, and an edit of the file gives TRUST_CHANGED`,
    W,
    () =>
      withService({ name: "t309-absent-slots" }, async (service) => {
        const built = buildF02(gitPath(), "t309-absent-slots");
        const repo = repoOf(built);
        for (let i = 0; i < TRUST_DIGEST_FILES + 6; i++) config(repo, `filter.a${i}.clean`, `./tools/missing-${i}.sh`);
        const program = insideProgram(built, repo, "tools/present.sh");
        config(repo, "filter.present.clean", program.command);
        const { repositoryId } = await service.register(repo);
        const trust = await trustOf(service, repositoryId);
        expect({ bound: trust.bound, persistence: trust.persistence }).toEqual({ bound: undefined, persistence: "stored" });
        await approve(service, repositoryId, trust);
        flipByte(program.path);
        expect(gate(await service.readWorkspace(repositoryId))).toEqual(TRUST_CHANGED);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "an edit of an unchecked program file keeps the session approval",
    W,
    () =>
      withService({ name: "t071-unchecked-edit" }, async (service) => {
        const repo = OVER[0]![2]("t071-unchecked-edit");
        const clean = join(repo, "tools", "clean.sh");
        const { repositoryId } = await service.register(repo);
        const trust = await trustOf(service, repositoryId);
        await approve(service, repositoryId, trust);
        flipByte(clean, Math.floor(TRUST_DIGEST_FILE_BYTES / 2));
        expect(await trustOf(service, repositoryId)).toMatchObject({ state: "approved", persistence: "session", fingerprint: trust.fingerprint });
        expect(outcome(await service.readWorkspace(repositoryId))).toEqual(SUCCEEDED);
      }),
    TIMEOUT_MS,
  );

  for (const restarted of [false, true]) {
    caseTest(
      TASK,
      `after an over-bound session approval, a new service session with a handshake of restarted: ${restarted}${restarted ? " (Restart service)" : ""} reports untrusted and gives TRUST_REQUIRED again`,
      W,
      () =>
        withSessions(`t071-session-only-${restarted}`, {}, async (first, set) => {
          const repo = OVER[0]![2](`t071-session-only-${restarted}`);
          await approve(first, (await first.register(repo)).repositoryId);
          const second = set(restarted ? await first.restart() : await nextSession(first, `t071-session-only-${restarted}-next`));
          expect(second.trustStore.records).toEqual([]);
          const { repositoryId } = await second.register(repo);
          expect((await trustOf(second, repositoryId)).state).toBe("untrusted");
          expect(gate(await second.readWorkspace(repositoryId))).toEqual(TRUST_REQUIRED);
        }),
      TIMEOUT_MS,
    );
  }

  caseTest(
    TASK,
    "an over-bound approval after an earlier stored approval deletes that stale record, so the next session reports untrusted, not changed",
    W,
    () =>
      withSessions("t071-stale-over-bound", {}, async (first, set) => {
        const built = buildF17(gitPath(), "t071-stale-over-bound", "trust");
        const repo = repoOf(built);
        const { repositoryId } = await first.register(repo);
        await approve(first, repositoryId);
        expect(first.trustStore.records.length).toBe(1);
        padTo(join(repo, "tools", "clean.sh"), TRUST_DIGEST_FILE_BYTES + 1);
        const over = await trustOf(first, repositoryId);
        expect({ bound: over.bound, persistence: over.persistence }).toEqual({ bound: "file-bytes", persistence: "session" });
        await approve(first, repositoryId, over);
        expect({ persists: first.trustStore.persists, records: first.trustStore.records }).toEqual({ persists: [true, false], records: [] });
        const second = set(await nextSession(first, "t071-stale-over-bound-next"));
        expect((await trustOf(second, (await second.register(repo)).repositoryId)).state).toBe("untrusted");
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a listed in-repository program path that is absent or not a regular file enters the fingerprint as absent, and creating that file gives TRUST_CHANGED",
    W,
    () =>
      withService({ name: "t071-absent" }, async (service) => {
        const built = buildF02(gitPath(), "t071-absent");
        const repo = repoOf(built);
        const program = join(repo, "tools", "program.sh");
        config(repo, "filter.t071.clean", "./tools/program.sh");
        expect(existsSync(program)).toBe(false);
        const { repositoryId } = await service.register(repo);
        const absent = await trustOf(service, repositoryId);
        await approve(service, repositoryId, absent);
        mkdirSync(program, { recursive: true });
        expect(await trustOf(service, repositoryId)).toMatchObject({ state: "approved", fingerprint: absent.fingerprint });
        expect(outcome(await service.readWorkspace(repositoryId))).toEqual(SUCCEEDED);
        rmdirSync(program);
        writeFileSync(program, "#!/bin/sh\nexec cat\n");
        expect(gate(await service.readWorkspace(repositoryId))).toEqual(TRUST_CHANGED);
        expect((await trustOf(service, repositoryId)).fingerprint).not.toBe(absent.fingerprint);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a local filter program with an absolute owned-root path outside the repository gets no digest, and an edit of that file keeps the fingerprint",
    W,
    () =>
      withService({ name: "t071-outside-program" }, async (service) => {
        const built = buildF02(gitPath(), "t071-outside-program");
        const repo = repoOf(built);
        const program = outsideProgram(built, "outside-clean");
        config(repo, "filter.t071.clean", program.command);
        const { repositoryId } = await service.register(repo);
        const trust = await trustOf(service, repositoryId);
        expect(trust.approvalRequired.reads).toBe(true);
        await approve(service, repositoryId, trust);
        flipByte(program.path);
        expect(await trustOf(service, repositoryId)).toMatchObject({ state: "approved", fingerprint: trust.fingerprint });
        expect(outcome(await service.readWorkspace(repositoryId))).toEqual(SUCCEEDED);
        expect(ran([program.log])).toEqual([]);
      }),
    TIMEOUT_MS,
  );

  // Contract §7 "Program file digests": only an `absent` fact means absent. An `error` fact ends the listing `failed`, and the text names its `code`.
  // POSIX mode 0100 keeps the execute bit, so Git still lists and runs the hook.
  caseTest(
    TASK,
    "a .git/hooks/pre-commit hook that the service cannot read ends readTrust failed with REPOSITORY_UNAVAILABLE, never with the hook absent",
    [...W, "read-denial"],
    () =>
      withService({ name: "t071-unreadable-hook" }, async (service) => {
        const built = buildF02(gitPath(), "t071-unreadable-hook");
        const repo = repoOf(built);
        const hook = put(repo, ".git/hooks/pre-commit", "#!/bin/sh\nexit 0\n");
        chmodSync(hook, 0o755);
        const { repositoryId } = await service.register(repo);
        const issued = await trustOf(service, repositoryId);
        denyRead(hook);
        try {
          // Oracle: the test process cannot open the hook for reading. Contract §6 "File facts": EACCES and ERROR_ACCESS_DENIED give `access-denied`.
          expect(errnoOf(() => closeSync(openSync(hook, "r")))).not.toBeNull();
          const expected: ListingRefusal = { state: "failed", code: "REPOSITORY_UNAVAILABLE", text: { path: samePath(hook), errno: "access-denied" } };
          expect(refusal(await service.readTrust(repositoryId))).toEqual(expected);
          expect(refusal(await service.approveTrust(repositoryId, issued.fingerprint, issued.generation))).toEqual(expected);
        } finally {
          allowRead(hook);
        }
      }),
    TIMEOUT_MS,
  );

  // Contract §6 "File facts" refuses a component above 255 UTF-16 units, and on Windows a trailing period. Contract §7 gives such a path bound `name`.
  // The service sends no `fileFacts` entry for it, so the case needs no file system premise.
  caseTest(
    TASK,
    "a local filter program path with a component that breaks the component rule gives bound name and persistence session, never a failed listing, and no fileFacts entry names it",
    W,
    () =>
      withService({ name: "t071-bad-component" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t071-bad-component"));
        const { repositoryId } = await service.register(repo);
        for (const name of ["a".repeat(256), ...(NATIVE.isComponent("x.") ? [] : ["x."])]) {
          config(repo, "filter.t071.clean", `./tools/${name}`);
          const factFrom = service.runner.fileFactCalls.length;
          const trust = await trustOf(service, repositoryId);
          expect({ name, bound: trust.bound, persistence: trust.persistence, reads: trust.approvalRequired.reads }).toEqual({ name, bound: "name", persistence: "session", reads: true });
          expect(entriesSince(service, factFrom).filter((entry) => entry.path.includes(name))).toEqual([]);
          expect(gate(await service.readWorkspace(repositoryId))).toEqual(TRUST_REQUIRED);
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a .git/hooks/pre-commit directory enters the fingerprint as absent, and readTrust succeeds",
    W,
    () =>
      withService({ name: "t071-hook-directory" }, async (service) => {
        const built = buildF02(gitPath(), "t071-hook-directory");
        const repo = repoOf(built);
        const folder = join(repo, ".git", "hooks", "pre-commit");
        mkdirSync(folder, { mode: 0o755 });
        const { repositoryId } = await service.register(repo);
        const trust = await trustOf(service, repositoryId);
        expect(trust.hooks.filter((h) => h.event === "pre-commit").map((h) => samePath(h.path))).toEqual([samePath(folder)]);
        writeFileSync(join(folder, "inside"), "t071\n");
        expect((await trustOf(service, repositoryId)).fingerprint).toBe(trust.fingerprint);
      }),
    TIMEOUT_MS,
  );

  // Contract §7 "Program file digests": an absolute link target inside the worktree resolves to a new phase-1 entry, and phase 2 digests the script.
  caseTest(
    TASK,
    "a .git/hooks/pre-commit symbolic link to a worktree script resolves to the script: no bound, persistence stored, and approveTrust stores a record",
    W,
    () =>
      withService({ name: "t071-hook-link" }, async (service) => {
        const built = buildF02(gitPath(), "t071-hook-link");
        const repo = repoOf(built);
        const target = insideProgram(built, repo, "tools/hook.sh");
        const hook = join(repo, ".git", "hooks", "pre-commit");
        try {
          symlinkSync(target.path, hook, "file");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
          console.log(`SKIP ${TASK} hook link: symlink creation gives EPERM for this account`);
          return;
        }
        expect(lstatSync(hook).isSymbolicLink()).toBe(true);
        const { repositoryId } = await service.register(repo);
        const trust = await trustOf(service, repositoryId);
        expect({ bound: trust.bound, persistence: trust.persistence, commit: trust.approvalRequired.commit }).toEqual({ bound: undefined, persistence: "stored", commit: true });
        expect(await approve(service, repositoryId, trust)).toMatchObject({ persistence: "stored", saveFailed: false });
        expect({ persists: service.trustStore.persists, records: service.trustStore.records.length }).toEqual({ persists: [true], records: 1 });
        expect(ran([target.log])).toEqual([]);
      }),
    TIMEOUT_MS,
  );
});

// Contract §7 "Program file digests": the refusal text names the path and the `code` of the fact. Null: the result holds no such text.
interface ListingRefusal {
  state: string;
  code: string | undefined;
  text: { path: unknown; errno: string | null } | null;
}

function refusal(response: ServiceResponse<unknown>): ListingRefusal {
  const text = (response.result as { remedy?: { text?: unknown } } | undefined)?.remedy?.text;
  const match = typeof text === "string" ? /^Arbareto cannot read (.+): ([a-z-]+)\.$/s.exec(text) : null;
  return { ...outcome(response), text: match === null ? null : { path: samePath(match[1]!), errno: match[2]! } };
}

// The errno name that the test process gets for the same path. The test runs as the same user as the service.
function errnoOf(read: () => unknown): string | null {
  try {
    read();
    return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? null;
  }
}

// POSIX mode 0100 denies the read and keeps the execute bit. On Windows, an ACL entry denies the read.
function denyRead(path: string): void {
  if (process.platform === "win32") icacls([path, "/deny", `${userInfo().username}:(R)`]);
  else chmodSync(path, 0o100);
}

function allowRead(path: string): void {
  if (process.platform === "win32") icacls([path, "/remove:d", userInfo().username]);
  else chmodSync(path, 0o755);
}

function icacls(args: string[]): void {
  const proc = Bun.spawnSync(["icacls", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`icacls ${args.join(" ")} exited ${proc.exitCode}`);
}

describe("bare-name lookup (contract §7 \"Program file digests\")", () => {
  // The child PATH of the task text: the relative entry `tools`, then an absolute owned bin directory.
  function bareName(name: string): { repo: string; bin: string; environment: Record<string, string> } {
    const built = buildF17(gitPath(), name, "trust");
    const repo = repoOf(built);
    const bin = join(built.root, "bin");
    mkdirSync(bin, { recursive: true });
    config(repo, "filter.bare.clean", "cleaner");
    return { repo, bin, environment: withPath(serviceEnv(), ["tools", bin].join(delimiter)) };
  }
  const program = "#!/bin/sh\nexec cat\n# t071\n";

  caseTest(
    TASK,
    "without tools\\cleaner.exe and tools\\cleaner the fingerprint records absent for tools, and creating tools\\cleaner gives TRUST_CHANGED",
    [...W, "windows-path-rules"],
    async () => {
      const { repo, environment } = bareName("t071-bare-absent");
      await withService({ name: "t071-bare-absent", environment }, async (service) => {
        const { repositoryId } = await service.register(repo);
        await approve(service, repositoryId);
        put(repo, "tools/cleaner", program);
        expect(gate(await service.readWorkspace(repositoryId))).toEqual(TRUST_CHANGED);
        expect((await trustOf(service, repositoryId)).state).toBe("changed");
      });
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "after approval, one changed byte of tools\\cleaner gives TRUST_CHANGED",
    [...W, "windows-path-rules"],
    async () => {
      const { repo, environment } = bareName("t071-bare-byte");
      const cleaner = put(repo, "tools/cleaner", program);
      await withService({ name: "t071-bare-byte", environment }, async (service) => {
        const { repositoryId } = await service.register(repo);
        await approve(service, repositoryId);
        flipByte(cleaner);
        expect(gate(await service.readWorkspace(repositoryId))).toEqual(TRUST_CHANGED);
      });
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "with both tools\\cleaner.exe and tools\\cleaner present, the digest covers tools\\cleaner.exe, as Git for Windows tries .exe first",
    ["shell-double", "git-for-windows"],
    async () => {
      const { repo, environment } = bareName("t071-bare-exe");
      const cleaner = put(repo, "tools/cleaner", program);
      const exe = put(repo, "tools/cleaner.exe", program);
      await withService({ name: "t071-bare-exe", environment }, async (service) => {
        const { repositoryId } = await service.register(repo);
        const trust = await trustOf(service, repositoryId);
        await approve(service, repositoryId, trust);
        flipByte(cleaner);
        expect(await trustOf(service, repositoryId)).toMatchObject({ state: "approved", fingerprint: trust.fingerprint });
        flipByte(exe);
        expect(gate(await service.readWorkspace(repositoryId))).toEqual(TRUST_CHANGED);
      });
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a file in the absolute owned bin directory gets no digest",
    [...W, "windows-path-rules"],
    async () => {
      const { repo, bin, environment } = bareName("t071-bare-bin");
      const owned = put(bin, "cleaner", program);
      await withService({ name: "t071-bare-bin", environment }, async (service) => {
        const { repositoryId } = await service.register(repo);
        const trust = await trustOf(service, repositoryId);
        await approve(service, repositoryId, trust);
        flipByte(owned);
        expect(await trustOf(service, repositoryId)).toMatchObject({ state: "approved", fingerprint: trust.fingerprint });
      });
    },
    TIMEOUT_MS,
  );

  // run-command.c `is_executable`: POSIX Git counts a PATH candidate only with the owner execute bit. Mode 0010 sets only the group bit.
  // `access(X_OK)` passes for root with any execute bit. So a rule that reads `executable` turns this case red only in a run as root.
  describe.skipIf(process.platform === "win32")("POSIX", () => {
    caseTest(
      "T309",
      "POSIX: a tools/cleaner candidate with mode 0010 does not count, so the fingerprint stays the same; the owner execute bit gives TRUST_CHANGED",
      W,
      async () => {
        const { repo, environment } = bareName("t309-bare-owner-bit");
        await withService({ name: "t309-bare-owner-bit", environment }, async (service) => {
          const { repositoryId } = await service.register(repo);
          const trust = await trustOf(service, repositoryId);
          await approve(service, repositoryId, trust);
          const cleaner = put(repo, "tools/cleaner", program);
          chmodSync(cleaner, 0o010);
          expect(await trustOf(service, repositoryId)).toMatchObject({ state: "approved", fingerprint: trust.fingerprint });
          chmodSync(cleaner, 0o710);
          expect(gate(await service.readWorkspace(repositoryId))).toEqual(TRUST_CHANGED);
        });
      },
      TIMEOUT_MS,
    );
  });
});

// Contract §7 "Repository-controlled resolution" and "Program file digests". The rule set comes from native-path.ts `emptyPathEntry`.
describe("relative child PATH entries (contract §7 \"Program file digests\")", () => {
  test("Windows rules skip an empty entry, as Git for Windows path_lookup does: C:\\a;C:\\b; gives no relative entry", () => {
    expect(relativePathEntries("C:\\a;C:\\b;", PATH_RULES.windows)).toEqual([]);
    expect(relativePathEntries(";C:\\a;;tools;.", PATH_RULES.windows)).toEqual(["tools", "."]);
  });

  test("POSIX rules take an empty entry as the current folder, as run-command.c locate_in_PATH does: /a:/b: gives .", () => {
    expect(relativePathEntries("/a:/b:", PATH_RULES.posix)).toEqual(["."]);
    expect(relativePathEntries(":/a::tools", PATH_RULES.posix)).toEqual([".", ".", "tools"]);
  });

  test("an absent or empty PATH gives no entry, as locate_in_PATH and path_lookup return no program", () => {
    for (const rules of [PATH_RULES.windows, PATH_RULES.posix]) {
      expect(relativePathEntries(undefined, rules)).toEqual([]);
      expect(relativePathEntries("", rules)).toEqual([]);
    }
  });
});

describe("empty child PATH entry with a global bare-name filter (contract §7 \"Repository-controlled resolution\")", () => {
  // Two absolute owned folders, then an empty entry from the trailing delimiter. A global `filter.lfs.process` names the bare program `git-lfs`.
  async function readsWith(name: string, trailing: boolean): Promise<boolean> {
    const built = buildF02(gitPath(), name);
    const repo = repoOf(built);
    const bins = ["bin1", "bin2"].map((folder) => join(built.root, folder));
    for (const bin of bins) mkdirSync(bin, { recursive: true });
    const { environment } = ownGlobal(built, [["filter.lfs.process", "git-lfs filter-process"]]);
    const path = bins.join(delimiter) + (trailing ? delimiter : "");
    let reads = true;
    await withService({ name, environment: withPath(environment, path) }, async (service) => {
      const { repositoryId } = await service.register(repo);
      reads = (await trustOf(service, repositoryId)).approvalRequired.reads;
    });
    return reads;
  }

  caseTest(
    TASK,
    "Windows: a child PATH of absolute owned entries that ends with ; holds no relative entry, so a global bare-name filter.lfs.process needs no read approval",
    [...W, "windows-path-rules"],
    async () => {
      expect(await readsWith("t071-empty-entry-windows", true)).toBe(false);
    },
    TIMEOUT_MS,
  );

  // POSIX `locate_in_PATH` takes the empty entry as the current folder. Git starts the filter from the worktree root, so `./git-lfs` is a repository candidate.
  describe.skipIf(process.platform === "win32")("POSIX", () => {
    caseTest(
      TASK,
      "POSIX: a child PATH that ends with : holds the relative entry ., so a global bare-name filter.lfs.process needs read approval, and the same PATH without : needs none",
      W,
      async () => {
        expect(await readsWith("t071-empty-entry-posix", true)).toBe(true);
        expect(await readsWith("t071-empty-entry-posix-none", false)).toBe(false);
      },
      TIMEOUT_MS,
    );
  });
});

describe("F07 per-worktree records (contract §7 \"Trust approval store\")", () => {
  caseTest(
    TASK,
    "with extensions.worktreeConfig=true, approvals of linked worktrees A and B keep separate records; a changed byte of the B program changes B only; revokeTrust from A makes both untrusted in the next session",
    W,
    () =>
      withSessions("t071-per-worktree", {}, async (first, set) => {
        const built = buildF07(gitPath(), "t071-per-worktree");
        const [a, b] = [join(built.root, "wt-a"), join(built.root, "wt-b")];
        config(join(built.root, "main"), "extensions.worktreeConfig", "true");
        config(a, "--worktree", "filter.wt.clean", insideProgram(built, a, "tools/a.sh").command);
        const programB = insideProgram(built, b, "tools/b.sh");
        config(b, "--worktree", "filter.wt.clean", programB.command);

        const A = await first.register(a);
        const B = await first.register(b);
        await approve(first, A.repositoryId);
        const recordA = structuredClone(first.trustStore.records);
        expect(recordA.length).toBe(1);
        await approve(first, B.repositoryId);
        expect(first.trustStore.records.length).toBe(2);
        expect(first.trustStore.records.filter((r) => samePath(fieldsOf(r).worktreeRoot) === samePath(fieldsOf(recordA[0]!).worktreeRoot))).toEqual(recordA);

        const second = set(await nextSession(first, "t071-per-worktree-next"));
        const A2 = await second.register(a);
        const B2 = await second.register(b);
        expect({ a: (await trustOf(second, A2.repositoryId)).state, b: (await trustOf(second, B2.repositoryId)).state }).toEqual({ a: "approved", b: "approved" });
        flipByte(programB.path);
        expect({ a: (await trustOf(second, A2.repositoryId)).state, b: (await trustOf(second, B2.repositoryId)).state }).toEqual({ a: "approved", b: "changed" });
        expect({ a: outcome(await second.readWorkspace(A2.repositoryId)), b: gate(await second.readWorkspace(B2.repositoryId)) }).toEqual({ a: SUCCEEDED, b: TRUST_CHANGED });

        const trustIdA = (await trustOf(second, A2.repositoryId)).trustId;
        expect(typeof trustIdA).toBe("string");
        expect(outcome(await second.revokeTrust(A2.repositoryId, trustIdA!))).toEqual(SUCCEEDED);
        const third = set(await nextSession(second, "t071-per-worktree-third"));
        const A3 = await third.register(a);
        const B3 = await third.register(b);
        expect({ a: (await trustOf(third, A3.repositoryId)).state, b: (await trustOf(third, B3.repositoryId)).state }).toEqual({ a: "untrusted", b: "untrusted" });
      }),
    TIMEOUT_MS,
  );
});

describe("stale record (contract §7 \"Mutation trust\")", () => {
  // Every repository-controlled integration of F17: filters, monitor, diff tools, and the pre-commit hook.
  function removeIntegrations(repo: string): void {
    for (const key of ["filter.canary.clean", "filter.proc.process", "core.fsmonitor", "diff.external", "diff.tcv.textconv"]) config(repo, "--unset", key);
    rmSync(join(repo, ".git", "hooks", "pre-commit"));
  }

  caseTest(
    TASK,
    "approve F17, then remove every repository-controlled integration: the stored record keeps state changed, approvalRequired is false for reads and commit, and reads run",
    W,
    () =>
      withService({ name: "t071-stale-record" }, async (service) => {
        const built = buildF17(gitPath(), "t071-stale-record", "trust");
        const repo = repoOf(built);
        const { repositoryId, generation } = await service.register(repo);
        await approve(service, repositoryId);
        removeIntegrations(repo);
        const trust = await trustOf(service, repositoryId);
        expect({ state: trust.state, approvalRequired: trust.approvalRequired }).toEqual({ state: "changed", approvalRequired: { reads: false, commit: false } });
        expect(service.trustStore.records.length).toBe(1);
        const { workspace, history } = await readBoth(service, repositoryId, generation);
        expect({ workspace: outcome(workspace), history: outcome(history) }).toEqual({ workspace: SUCCEEDED, history: SUCCEEDED });
      }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "stale record: after the next readWorkspace and a new selection, applyHunk runs without TRUST_CHANGED", ["shell-double"], async () => {
    const built = buildF17(gitPath(), "t071-stale-hunk", "trust");
    const repo = repoOf(built);
    put(repo, "README.md", "# changed\n");
    const service = await openService({ git: gitPath(), name: "t071-stale-hunk" });
    try {
      const { repositoryId } = await service.register(repo);
      await approve(service, repositoryId);
      removeIntegrations(repo);
      const read = (await service.readWorkspace(repositoryId)).result!;
      const entry = read.entries.find((e) => e.path === "README.md" && e.category === "unstaged")!;
      const comparison = await service.request("readComparison", { snapshotId: read.snapshotId, entryId: entry.entryId }, { repositoryId, repositoryGeneration: read.generation, selectionId: crypto.randomUUID() });
      const [comparisonId] = valuesOf(comparison.result, "comparisonId");
      const [hunkId] = valuesOf(comparison.result, "hunkId");
      const applied = await service.request("applyHunk", { comparisonId, hunkId, snapshotId: read.snapshotId, direction: "stage" }, { repositoryId, repositoryGeneration: read.generation });
      expect(outcome(applied)).toEqual(SUCCEEDED);
    } finally {
      await service.dispose();
    }
  }, TIMEOUT_MS);
});

// T080 cases. A configured hook result also names the friendly name, the scope of its command entry, and the classification.
type ClassifiedHook = TrustResult["hooks"][number] & { name?: string; commandScope?: string; repositoryControlled?: boolean };

describe("hook classification (contract §7 \"Hook registrations\")", () => {
  caseTest(
    "T080",
    "a global hook.<name>.event and a local hook.<name>.command canary: readTrust reports the hook repository-controlled by its command entry, commit approval is required, and the canary never runs",
    W,
    async () => {
      const built = buildF02(gitPath(), "t080-hook-scope");
      const repo = repoOf(built);
      const canary = outsideProgram(built, "t080-hook-command");
      config(repo, "hook.t080.command", canary.command);
      const { file, environment } = ownGlobal(built, [["hook.t080.event", "pre-commit"]]);
      // Oracle: `git hook list` shows the scope of the event entry, but Git runs the local command (research R5 "T280 record").
      expect(hookList(repo, "pre-commit", { GIT_CONFIG_GLOBAL: file })).toEqual([{ scope: "global", disabled: false, name: "t080" }]);
      await withService({ name: "t080-hook-scope", environment }, async (service) => {
        const { repositoryId } = await service.register(repo);
        const trust = await trustOf(service, repositoryId);
        const hooks = (trust.hooks as ClassifiedHook[]).filter((h) => h.event === "pre-commit");
        expect(hooks.map((h) => ({ name: h.name, scope: h.scope, commandScope: h.commandScope, repositoryControlled: h.repositoryControlled }))).toEqual([
          { name: "t080", scope: "global", commandScope: "local", repositoryControlled: true },
        ]);
        expect(trust.approvalRequired).toEqual({ reads: false, commit: true });
      });
      expect(ran([canary.log])).toEqual([]);
    },
    TIMEOUT_MS,
  );
});

describe("shared listing (contract §7 \"Shared listing\")", () => {
  const same = (args: readonly string[], expected: string[]) => args.length === expected.length && args.every((arg, i) => arg === expected[i]);
  // The two Git processes of one trust listing (contract §7 "Hook registrations"), counted from the runner calls after `from`.
  const listings = (service: Service, from: number) => {
    const calls = service.runner.calls.slice(from);
    return { configList: calls.filter((c) => same(c.arguments, configListArgs())).length, hooksPath: calls.filter((c) => same(c.arguments, hooksPathArgs())).length };
  };

  caseTest(
    "T080",
    "a readHistory before any readWorkspace of its generation lists itself; a full readWorkspace and then a readHistory of its generation start one config list and one rev-parse --git-path hooks; a local configuration edit between them starts a second listing",
    W,
    () =>
      withService({ name: "t080-shared-listing" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t080-shared-listing"));
        const registered = await service.register(repo);
        const { repositoryId } = registered;

        let from = service.runner.calls.length;
        const firstHistory = await service.readHistory(repositoryId, registered.generation);
        const firstWorkspace = await service.readWorkspace(repositoryId);
        expect({ history: outcome(firstHistory), workspace: outcome(firstWorkspace) }).toEqual({ history: SUCCEEDED, workspace: SUCCEEDED });
        expect(listings(service, from)).toEqual({ configList: 2, hooksPath: 2 });

        from = service.runner.calls.length;
        const workspace = await service.readWorkspace(repositoryId);
        const history = await service.readHistory(repositoryId, workspace.result!.generation);
        expect({ history: outcome(history), workspace: outcome(workspace) }).toEqual({ history: SUCCEEDED, workspace: SUCCEEDED });
        expect(listings(service, from)).toEqual({ configList: 1, hooksPath: 1 });

        // The edit changes the local configuration file in the contract §8 change tuple, so the history read cannot reuse the listing.
        from = service.runner.calls.length;
        const edited = await service.readWorkspace(repositoryId);
        config(repo, "t080.note", "edited");
        const afterEdit = await service.readHistory(repositoryId, edited.result!.generation);
        expect({ history: outcome(afterEdit), workspace: outcome(edited) }).toEqual({ history: SUCCEEDED, workspace: SUCCEEDED });
        expect(listings(service, from)).toEqual({ configList: 2, hooksPath: 2 });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    "T322",
    "a missing include.path target that appears between a full readWorkspace and a readHistory of its generation makes the readHistory start its own config list",
    W,
    () =>
      withService({ name: "t322-new-candidate" }, async (service) => {
        const built = buildF02(gitPath(), "t322-new-candidate");
        const repo = repoOf(built);
        const target = join(built.root, "t322-include.gitconfig");
        config(repo, "include.path", slash(target));
        expect(existsSync(target)).toBe(false);
        const { repositoryId } = await service.register(repo);
        // The first read after registration keeps no tuple (contract §7 "Shared listing").
        expect(outcome(await service.readWorkspace(repositoryId))).toEqual(SUCCEEDED);

        let from = service.runner.calls.length;
        let workspace = await service.readWorkspace(repositoryId);
        let history = await service.readHistory(repositoryId, workspace.result!.generation);
        expect({ history: outcome(history), workspace: outcome(workspace) }).toEqual({ history: SUCCEEDED, workspace: SUCCEEDED });
        expect(listings(service, from)).toEqual({ configList: 1, hooksPath: 1 });

        from = service.runner.calls.length;
        workspace = await service.readWorkspace(repositoryId);
        writeFileSync(target, "[t322]\n\tnote = new\n");
        // Oracle: Git reads the new target with the scope of the file that names it.
        expect(configListing(repo).filter((e) => e.key === "t322.note").map((e) => ({ scope: e.scope, origin: originPath(e.origin, repo) }))).toEqual([{ scope: "local", origin: samePath(target) }]);
        history = await service.readHistory(repositoryId, workspace.result!.generation);
        expect({ history: outcome(history), workspace: outcome(workspace) }).toEqual({ history: SUCCEEDED, workspace: SUCCEEDED });
        expect(listings(service, from)).toEqual({ configList: 2, hooksPath: 2 });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    "T080",
    "a readHistory that waits for the shared listing of a held readWorkspace ends canceled after cancel, while the readWorkspace still waits",
    W,
    () =>
      withService({ name: "t080-shared-cancel" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t080-shared-cancel"));
        const { repositoryId } = await service.register(repo);
        const first = await service.readWorkspace(repositoryId);
        expect(outcome(first)).toEqual(SUCCEEDED);
        const generation = first.result!.generation;
        const from = service.runner.calls.length;
        const isConfigList = (c: { arguments: readonly string[] }) => same(c.arguments, configListArgs());
        const release = service.runner.pauseStdout(once(isConfigList));
        try {
          // The request generation makes the listing shareable at once (contract §7 "Shared listing").
          const workspace = service.send("readWorkspace", { refresh: false, check: "full" }, { repositoryId, repositoryGeneration: generation });
          await waitFor("held config list", () => service.runner.calls.slice(from).some(isConfigList));
          const history = service.send("readHistory", {}, { repositoryId, repositoryGeneration: generation });
          const operationId = await service.operationId(history);
          // The listing reuse starts after a few file facts, and `rev-list` starts after three Git processes. So the cancel finds the read waiting for the shared listing.
          await waitFor("history rev-list call", () => service.runner.calls.some((c) => c.operationId === operationId && c.arguments.includes("rev-list")));
          expect((await service.cancel(operationId)).state).toBe("succeeded");
          expect(outcome(await service.response(history, RECONCILIATION_TARGET_MS * 2))).toEqual({ state: "canceled", code: "CANCELED" });
          expect(service.responseAt.has(workspace)).toBe(false);
          expect(listings(service, from)).toEqual({ configList: 1, hooksPath: 1 });
        } finally {
          release();
        }
      }),
    TIMEOUT_MS,
  );
});

describe("absent candidate configuration files (contract §8 \"Change check\")", () => {
  caseTest(
    "T080",
    "after approval with extensions.worktreeConfig, a new config.worktree and then a missing include.path target that gets a command-valued core.fsmonitor canary each make the next check: \"changes\" read list again and refuse with TRUST_CHANGED, and no canary runs",
    W,
    async () => {
      const built = buildF02(gitPath(), "t080-candidates");
      const repo = repoOf(built);
      const canary = outsideProgram(built, "t080-fsmonitor");
      const target = join(built.root, "t080-include.gitconfig");
      config(repo, "extensions.worktreeConfig", "true");
      config(repo, "include.path", slash(target));
      const worktreeConfig = resolve(repo, git(repo, ["rev-parse", "--git-path", "config.worktree"]).trim());
      expect({ worktreeConfig: existsSync(worktreeConfig), target: existsSync(target) }).toEqual({ worktreeConfig: false, target: false });
      const monitor = `[core]\n\tfsmonitor = ${canary.command}\n`;
      const configLists = (service: Service) => service.runner.calls.filter((c) => subcommand(c.arguments) === "config" && c.arguments.includes("list")).length;

      // Hints off: only the contract §8 stat tuple can detect the new file.
      await withService({ name: "t080-candidates", watchHints: false }, async (service) => {
        const { repositoryId } = await service.register(repo);
        await approve(service, repositoryId);
        expect(outcome(await service.readWorkspace(repositoryId))).toEqual(SUCCEEDED);
        // T088 decision E3: the first read after registration keeps no stat tuple. This poll leaves one, so a later poll lists again only for a changed tuple.
        expect(outcome(await service.readWorkspace(repositoryId, { refresh: false, check: "changes" }))).toEqual(SUCCEEDED);
        const idle = configLists(service);
        expect(outcome(await service.readWorkspace(repositoryId, { refresh: false, check: "changes" }))).toEqual(SUCCEEDED);
        expect(configLists(service)).toBe(idle);

        writeFileSync(worktreeConfig, monitor);
        // Oracle: Git reads the new file with worktree scope.
        expect(configListing(repo).filter((e) => e.key === "core.fsmonitor").map((e) => e.scope)).toEqual(["worktree"]);
        let before = configLists(service);
        expect(gate(await service.readWorkspace(repositoryId, { refresh: false, check: "changes" }))).toEqual(TRUST_CHANGED);
        expect(configLists(service)).toBeGreaterThan(before);

        rmSync(worktreeConfig);
        expect(outcome(await service.readWorkspace(repositoryId))).toEqual(SUCCEEDED);
        writeFileSync(target, monitor);
        // Oracle: Git reads the include target with the scope of the file that names it.
        expect(configListing(repo).filter((e) => e.key === "core.fsmonitor").map((e) => ({ scope: e.scope, origin: originPath(e.origin, repo) }))).toEqual([
          { scope: "local", origin: samePath(target) },
        ]);
        before = configLists(service);
        expect(gate(await service.readWorkspace(repositoryId, { refresh: false, check: "changes" }))).toEqual(TRUST_CHANGED);
        expect(configLists(service)).toBeGreaterThan(before);
      });
      expect(ran([canary.log])).toEqual([]);
    },
    TIMEOUT_MS,
  );
});

// kernel32 `GetShortPathNameW` (Microsoft Learn): the path with the 8.3 name of each component that has one.
function shortPath(path: string): string {
  const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
  const UNITS = 32_768;
  const kernel32 = dlopen("kernel32.dll", { GetShortPathNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 } });
  try {
    const out = new Uint16Array(UNITS);
    const units = kernel32.symbols.GetShortPathNameW(Buffer.from(`${path}\0`, "utf16le"), out, UNITS);
    if (units === 0 || units >= UNITS) throw new Error(`GetShortPathNameW failed for ${path}`);
    return Buffer.from(out.buffer, 0, units * 2).toString("utf16le");
  } finally {
    kernel32.close();
  }
}

describe("inside and outside (contract §7 \"Inside and outside\")", () => {
  // A global core.hooksPath names the `.githooks` folder of the worktree through `spell(alias)`. The worktree holds a committed pre-commit canary there.
  // `symlinkSync` with type "junction" makes a junction on Windows and a symbolic link on other platforms.
  async function aliasHooks(name: string, aliasName: string, spell: (alias: string) => string): Promise<void> {
    const built = buildF08(gitPath(), name, "sha1");
    const repo = repoOf(built);
    const canary = outsideProgram(built, `${name}-pre-commit`);
    chmodSync(put(repo, ".githooks/pre-commit", `#!/bin/sh\nexec ${canary.command}\n`), 0o755);
    git(repo, ["add", "--", ".githooks/pre-commit"]);
    git(repo, ["commit", "-q", "--no-verify", "-m", "hooks"]);
    const alias = join(built.root, aliasName);
    symlinkSync(repo, alias, "junction");
    const hooksPath = `${slash(spell(alias))}/.githooks`;
    // No text comparison places the folder under the worktree.
    expect(String(samePath(hooksPath)).startsWith(`${String(samePath(repo))}/`)).toBe(false);
    const { file, environment } = ownGlobal(built, [["core.hooksPath", hooksPath]]);
    // Oracle: Git lists the committed hook through the alias.
    expect(hookList(repo, "pre-commit", { GIT_CONFIG_GLOBAL: file }).map((h) => h.scope ?? "hookdir")).toEqual(["hookdir"]);
    await withService({ name, environment }, async (service) => {
      const { repositoryId } = await service.register(repo);
      const from = service.runner.calls.length;
      const trust = await trustOf(service, repositoryId);
      // Contract §7 "Hook registrations": the identity requests add no Git process to the listing.
      expect(service.runner.calls.slice(from).map((c) => c.arguments.join(" ")).sort()).toEqual([configListArgs().join(" "), hooksPathArgs().join(" ")].sort());
      const hooks = (trust.hooks as ClassifiedHook[]).filter((h) => h.event === "pre-commit");
      expect(hooks.map((h) => ({ folder: h.path !== undefined, repositoryControlled: h.repositoryControlled }))).toEqual([{ folder: true, repositoryControlled: true }]);
      expect(trust.approvalRequired).toEqual({ reads: false, commit: true });
      // A hooks-folder hook blocks no read (contract §7 "Mutation trust").
      expect(outcome(await service.readWorkspace(repositoryId))).toEqual(SUCCEEDED);
    });
    expect(ran([canary.log])).toEqual([]);
  }

  caseTest(
    "T080",
    "a global core.hooksPath through a junction alias of the worktree folder: readTrust reports the folder hook repository-controlled and commit approval required, and the hook never runs",
    W,
    () => aliasHooks("t080-alias-hooks", "alias", (alias) => alias),
    TIMEOUT_MS,
  );

  caseTest(
    "T080",
    "a global core.hooksPath through the 8.3 short name of a junction alias of the worktree folder: the folder hook is repository-controlled and commit approval is required",
    [...W, "ntfs-junction"],
    () =>
      aliasHooks("t080-alias-hooks-short", "worktree-alias-long-name", (alias) => {
        const short = shortPath(alias);
        // A volume without 8.3 names keeps the long name, and the case cannot run there.
        expect({ short: basename(short) === basename(alias) }).toEqual({ short: false });
        return short;
      }),
    TIMEOUT_MS,
  );

  caseTest(
    "T080",
    "a global core.hooksPath through a junction alias of the worktree folder in another non-ASCII letter case: the folder hook is repository-controlled and commit approval is required",
    [...W, "ntfs-junction", "windows-path-rules"],
    // NTFS folds U+00C9 and U+00E9 to one name through its upcase table. The contract §7 text rule folds only ASCII letters.
    () => aliasHooks("t080-alias-hooks-case", "alias-\u00e9", (alias) => `${alias.slice(0, -1)}\u00c9`),
    TIMEOUT_MS,
  );
});

// The service steps without the session: an admitted installation, and a registration with it.
async function admitted(service: Service): Promise<GitInstallation> {
  const probed = await probeGit(service.runner, { bootstrapId: service.runner.addContext("gitProbe", gitPath()), executablePath: gitPath() });
  if (!("installation" in probed)) throw new Error(`probe failed: ${JSON.stringify(probed)}`);
  return probed.installation;
}

async function registerIn(registrations: ReturnType<typeof createRegistrations>, service: Service, repo: string, installation: GitInstallation): Promise<string> {
  const signal = new AbortController().signal;
  const result = await registrations.register({ operationId: crypto.randomUUID(), bootstrapId: service.runner.addContext("repositoryDiscovery", repo), installation, signal });
  if (!result.ok || !("repositoryId" in result.result)) throw new Error(`registration failed: ${JSON.stringify(result)}`);
  return result.result.repositoryId;
}

describe("workspace release (contract §6 \"Registration reuse and release\")", () => {
  // An F17 copy whose clean filter program is above the file bound, so an approval is session-only.
  function sessionOnly(name: string): string {
    const built = buildF17(gitPath(), name, "trust");
    padTo(join(repoOf(built), "tools", "clean.sh"), TRUST_DIGEST_FILE_BYTES + 1);
    return repoOf(built);
  }

  caseTest(
    TASK,
    "a release clears the session approval: after another repository releases the workspace, its re-registration needs a new approval",
    W,
    () =>
      withService({ name: "t071-release" }, async (service) => {
        const repo = sessionOnly("t071-release");
        const first = await service.register(repo);
        await approve(service, first.repositoryId);
        expect(outcome(await service.readWorkspace(first.repositoryId))).toEqual(SUCCEEDED);
        await service.register(repoOf(buildF02(gitPath(), "t071-release-other")));
        expect(outcome(await service.readWorkspace(first.repositoryId))).toEqual({ state: "rejected", code: "UNKNOWN_TARGET" });
        const again = await service.register(repo);
        expect(gate(await service.readWorkspace(again.repositoryId))).toEqual(TRUST_REQUIRED);
        expect((await trustOf(service, again.repositoryId)).state).toBe("untrusted");
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a registration of the same worktree with another gitInstallationId never reuses the workspace of the first one",
    W,
    () =>
      withService({ name: "t071-reuse-installation" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t071-reuse-installation"));
        const probe = async () => {
          const probed = await probeGit(service.runner, { bootstrapId: service.runner.addContext("gitProbe", gitPath()), executablePath: gitPath() });
          if (!("installation" in probed)) throw new Error(`probe failed: ${JSON.stringify(probed)}`);
          return probed.installation;
        };
        const [a, b] = [await probe(), await probe()];
        const registrations = createRegistrations({ runner: service.runner, unfinishedMutation: () => false });
        const register = async (installation: GitInstallation) => {
          const signal = new AbortController().signal;
          const result = await registrations.register({ operationId: crypto.randomUUID(), bootstrapId: service.runner.addContext("repositoryDiscovery", repo), installation, signal });
          if (!result.ok || !("repositoryId" in result.result)) throw new Error(`registration failed: ${JSON.stringify(result)}`);
          return result.result.repositoryId;
        };
        const first = await register(a);
        expect(await register(a)).toBe(first);
        const other = await register(b);
        expect(other).not.toBe(first);
        expect(registrations.get(other)?.gitInstallationId).toBe(b.gitInstallationId);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "chooseGit releases every workspace of the previous Git; a re-registration binds a new workspace to the new Git and needs a new approval",
    W,
    () =>
      withService({ name: "t071-choose-git" }, async (service) => {
        const repo = sessionOnly("t071-choose-git");
        const first = await service.register(repo);
        await approve(service, first.repositoryId);
        expect(outcome(await service.readWorkspace(first.repositoryId))).toEqual(SUCCEEDED);
        const chosen = await service.request("chooseGit", { bootstrapId: service.runner.addContext("gitProbe", gitPath()), executablePath: gitPath() });
        expect(chosen.state).toBe("succeeded");
        expect(outcome(await service.readWorkspace(first.repositoryId))).toEqual({ state: "rejected", code: "UNKNOWN_TARGET" });
        const second = await service.register(repo);
        expect(second.repositoryId).not.toBe(first.repositoryId);
        expect(gate(await service.readWorkspace(second.repositoryId))).toEqual(TRUST_REQUIRED);
        await approve(service, second.repositoryId);
        expect(outcome(await service.readWorkspace(second.repositoryId))).toEqual(SUCCEEDED);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "releaseInstallation gives busy and changes nothing while a workspace of that Git has an unfinished mutation",
    W,
    () =>
      withService({ name: "t071-release-busy" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t071-release-busy"));
        const installation = await admitted(service);
        let unfinished = true;
        const registrations = createRegistrations({ runner: service.runner, unfinishedMutation: () => unfinished });
        const id = await registerIn(registrations, service, repo, installation);
        expect(await registrations.releaseInstallation(installation.gitInstallationId, () => true)).toBe("busy");
        expect(registrations.has(id)).toBe(true);
        // The shell keeps the installation binding, so the same registration still runs its discovery.
        expect(await registerIn(registrations, service, repo, installation)).toBe(id);
        unfinished = false;
        expect(await registrations.releaseInstallation(installation.gitInstallationId, () => true)).toBe("released");
        expect(registrations.has(id)).toBe(false);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "releaseInstallation waits for a registration that commits with that Git, then releases the new workspace",
    W,
    () =>
      withService({ name: "t071-release-lock" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t071-release-lock"));
        const installation = await admitted(service);
        let open = () => {};
        const gate = new Promise<void>((resolve) => (open = resolve));
        let approved = false;
        // The shell approved the `register` frame. Its reply reaches the service only after the gate opens.
        const runner: GitRunner = {
          ...service.runner,
          async register(request) {
            const reply = await service.runner.register(request);
            if ("repositoryId" in request) {
              approved = true;
              await gate;
            }
            return reply;
          },
        };
        const registrations = createRegistrations({ runner, unfinishedMutation: () => false });
        const signal = new AbortController().signal;
        const registering = registrations.register({ operationId: crypto.randomUUID(), bootstrapId: service.runner.addContext("repositoryDiscovery", repo), installation, signal });
        await waitFor("approved register frame", () => approved);
        const releasing = registrations.releaseInstallation(installation.gitInstallationId, () => true);
        open();
        const registered = await registering;
        if (!registered.ok || !("repositoryId" in registered.result)) throw new Error(`registration failed: ${JSON.stringify(registered)}`);
        expect(await releasing).toBe("released");
        expect(registrations.has(registered.result.repositoryId)).toBe(false);
      }),
    TIMEOUT_MS,
  );

  // Contract §3 `approveTrust`: the approval binds the `repositoryId` of the request.
  caseTest(
    TASK,
    "an approveTrust whose confirmation ends after a release of its workspace sets nothing and gives UNKNOWN_TARGET; a re-registration starts untrusted",
    W,
    () =>
      withService({ name: "t071-approve-release" }, async (service) => {
        const repo = repoOf(buildF17(gitPath(), "t071-approve-release", "trust"));
        const installation = await admitted(service);
        let open = () => {};
        const gate = new Promise<void>((resolve) => (open = resolve));
        let asked = false;
        // The Git selection dialog stays open until the gate opens.
        const runner: GitRunner = {
          ...service.runner,
          async trust(request) {
            if (request.type === "confirm") {
              asked = true;
              await gate;
            }
            return service.runner.trust(request);
          },
        };
        const trust = createTrust({ runner, environment: serviceEnv() });
        const registrations = createRegistrations({ runner: service.runner, unfinishedMutation: () => false, onRelease: (w) => trust.release(w) });
        const id = await registerIn(registrations, service, repo, installation);
        const target = (workspace: Workspace) => ({ operationId: crypto.randomUUID(), signal: new AbortController().signal, workspace, installation });
        const read = await trust.readTrust(target(registrations.get(id)!), 0);
        if (read.result !== "succeeded") throw new Error(`readTrust: ${JSON.stringify(read)}`);
        expect(read.value.state).toBe("untrusted");
        const approving = trust.approveTrust(target(registrations.get(id)!), read.value.fingerprint);
        await waitFor("confirm request", () => asked);
        await registerIn(registrations, service, repoOf(buildF02(gitPath(), "t071-approve-release-other")), installation);
        expect(registrations.has(id)).toBe(false);
        open();
        expect(await approving).toEqual({ result: "failed", code: "UNKNOWN_TARGET" });
        const again = registrations.get(await registerIn(registrations, service, repo, installation))!;
        const next = await trust.readTrust(target(again), 0);
        expect({ result: next.result, state: next.result === "succeeded" ? next.value.state : undefined }).toEqual({ result: "succeeded", state: "untrusted" });
      }),
    TIMEOUT_MS,
  );

  // Contract §6 "Registration reuse and release": a read that a release cancels issues nothing.
  caseTest(
    TASK,
    "a readTrust whose signal aborts during its file facts issues no fingerprint for approveTrust",
    W,
    () =>
      withService({ name: "t071-read-trust-abort" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t071-read-trust-abort"));
        const installation = await admitted(service);
        const registrations = createRegistrations({ runner: service.runner, unfinishedMutation: () => false });
        const workspace = registrations.get(await registerIn(registrations, service, repo, installation))!;
        const controller = new AbortController();
        // The first `fileFacts` request reads the hooks folder, after both listing processes ended (contract §7 "Program file digests").
        const runner: GitRunner = {
          ...service.runner,
          fileFacts(request, signal) {
            controller.abort();
            return service.runner.fileFacts(request, signal);
          },
        };
        const trust = createTrust({ runner, environment: serviceEnv() });
        const value = await trust.readTrust({ operationId: crypto.randomUUID(), signal: controller.signal, workspace, installation }, 0);
        expect(value).toEqual({ result: "canceled" });
        const listed = await trust.listTrust({ operationId: crypto.randomUUID(), signal: new AbortController().signal, workspace });
        if (!listed.ok) throw new Error(`listing: ${JSON.stringify(listed)}`);
        expect(trust.acceptApprove(workspace.repositoryId, listed.listing.fingerprint, 0)).toBe("TRUST_CHANGED");
      }),
    TIMEOUT_MS,
  );

  // Contract §5 "Deadline outcomes": a walk deadline has the outcome of a Git process deadline in the same step.
  caseTest(
    "T312",
    "a walk deadline ends the listing with the deadline stop and readTrust with deadline, and readProgramFiles passes the stop up",
    W,
    () =>
      withService({ name: "t312-walk-deadline" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t312-walk-deadline"));
        const installation = await admitted(service);
        const registrations = createRegistrations({ runner: service.runner, unfinishedMutation: () => false });
        const workspace = registrations.get(await registerIn(registrations, service, repo, installation))!;
        const signal = new AbortController().signal;
        const listing = () => ({ operationId: crypto.randomUUID(), signal, workspace });
        let asked = 0;
        const identityDeadline: GitRunner = { ...service.runner, identities: async () => (asked++, { stop: "deadline" }) };
        const factsDeadline: GitRunner = { ...service.runner, fileFacts: async () => ({ stop: "deadline" }) };
        // The global configuration file of the fixture lies outside the roots, so its origin gets an identity request.
        const factCalls = service.runner.fileFactCalls.length;
        const identityTrust = createTrust({ runner: identityDeadline, environment: serviceEnv() });
        const stoppedListing = await identityTrust.listTrust(listing());
        expect(asked).toBeGreaterThan(0);
        expect(stoppedListing).toEqual({ ok: false, stop: "deadline" });
        expect(service.runner.fileFactCalls.length).toBe(factCalls);
        for (const runner of [identityDeadline, factsDeadline]) {
          const trust = createTrust({ runner, environment: serviceEnv() });
          expect(await trust.listTrust(listing())).toEqual({ ok: false, stop: "deadline" });
          expect(await trust.readTrust({ ...listing(), installation }, 0)).toEqual({ result: "deadline" });
        }
        const hooksFolder = { root: "gitDirectory" as const, path: ["hooks"], fact: { kind: "directory" as const } };
        expect(await readProgramFiles(factsDeadline, crypto.randomUUID(), workspace, [hooksFolder], signal)).toEqual({ stop: "deadline" });
      }),
    TIMEOUT_MS,
  );

  // Contract §11 "Trust and environment" (W11): a WSL Git path without a UNC form. `readTrust` gives the `approveTrust` refusal, so no approval is offered.
  caseTest(
    "T318",
    "readTrust of a WSL Git path without a UNC form gives the approveTrust refusal before any listing",
    W,
    () =>
      withService({ name: "t318-git-path" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t318-git-path"));
        const installation = await admitted(service);
        const registrations = createRegistrations({ runner: service.runner, unfinishedMutation: () => false });
        const registered = registrations.get(await registerIn(registrations, service, repo, installation))!;
        // Only the distro and the Git path of the WSL Git enter the refusal text.
        const workspace = { ...registered, wsl: { distro: "Ubuntu-24.04", path: "/opt/a:b/git" } } as Workspace;
        const runner: GitRunner = { ...service.runner, run: () => Promise.reject(new Error("the listing ran")) };
        const trust = createTrust({ runner, environment: serviceEnv() });
        const target = { operationId: crypto.randomUUID(), signal: new AbortController().signal, workspace, installation: { ...installation, selectedPath: null } };
        const refused = {
          result: "failed",
          code: "UNSUPPORTED_REPOSITORY",
          value: { remedy: { text: "The Git path /opt/a:b/git in Ubuntu-24.04 holds a name that Windows cannot show. Install Git in another folder of the distro, then approve again." } },
        } as const;
        expect(await trust.readTrust(target, 0)).toEqual(refused);
        expect(await trust.approveTrust(target, "0".repeat(64))).toEqual(refused);
      }),
    TIMEOUT_MS,
  );

  // Contract §5 "Deadline outcomes" (T314): a `revoke` deadline ends revokeTrust failed with DEADLINE.
  caseTest(
    "T314",
    "a revoke deadline reply ends revokeTrust failed with DEADLINE",
    W,
    () =>
      withService({ name: "t314-revoke-deadline" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t314-revoke-deadline"));
        const installation = await admitted(service);
        const registrations = createRegistrations({ runner: service.runner, unfinishedMutation: () => false });
        const workspace = registrations.get(await registerIn(registrations, service, repo, installation))!;
        const runner: GitRunner = { ...service.runner, trust: async (request) => (request.type === "revoke" ? { stop: "deadline" } : service.runner.trust(request)) };
        const trust = createTrust({ runner, environment: serviceEnv() });
        expect(await trust.revokeTrust({ operationId: crypto.randomUUID(), signal: new AbortController().signal, workspace })).toEqual({ result: "failed", code: "DEADLINE" });
      }),
    TIMEOUT_MS,
  );

  // Every identity chunk of one decision settles before the listing ends, so no walk call stays pending past `closeJob`.
  caseTest(
    "T312",
    "a refused identity chunk ends the listing only after every other chunk of that decision settles",
    W,
    () => {
      const built = buildF02(gitPath(), "t312-identity-chunks");
      const repo = repoOf(built);
      // The listing asks the global file and each ancestor. Nine folders below the fixture root give more than 8 paths on every host.
      const global = put(built.root, "1/2/3/4/5/6/7/8/.gitconfig", readFileSync(FIXTURE_GLOBAL_CONFIG, "utf8"));
      const environment = serviceEnv({ GIT_CONFIG_GLOBAL: global });
      return withService({ name: "t312-identity-chunks", environment }, async (service) => {
        const installation = await admitted(service);
        const registrations = createRegistrations({ runner: service.runner, unfinishedMutation: () => false });
        const workspace = registrations.get(await registerIn(registrations, service, repo, installation))!;
        let [started, settled] = [0, 0];
        let release = () => {};
        const held = new Promise<void>((resolve) => (release = resolve));
        const runner: GitRunner = {
          ...service.runner,
          identities: async (...args) => {
            const first = started++ === 0;
            try {
              if (first) throw new RunnerRefusal("UNKNOWN_TARGET");
              await held;
              return await service.runner.identities(...args);
            } finally {
              settled++;
            }
          },
        };
        const trust = createTrust({ runner, environment });
        // The calls still open when the listing ends.
        let open = -1;
        const listing = trust.listTrust({ operationId: crypto.randomUUID(), signal: new AbortController().signal, workspace }).then((outcome) => {
          open = started - settled;
          return outcome;
        });
        for (const until = performance.now() + 30_000; started < 2 && performance.now() < until; ) await Bun.sleep(10);
        // The global file and its ancestors need more than one identity chunk of 8 paths.
        expect(started).toBeGreaterThanOrEqual(2);
        release();
        expect(await listing).toEqual({ ok: false, code: "UNKNOWN_TARGET" });
        expect(open).toBe(0);
      });
    },
    TIMEOUT_MS,
  );
});

describe("hook commands and the enabled flag (contract §7 \"Hook registrations\")", () => {
  caseTest(
    "T080",
    "a local configured hook with an empty command has no program record: readTrust reports it repository-controlled, and commit approval is required",
    W,
    () =>
      withService({ name: "t080-empty-command" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t080-empty-command"));
        config(repo, "hook.t080empty.event", "pre-commit");
        config(repo, "hook.t080empty.command", "");
        const { repositoryId } = await service.register(repo);
        const trust = await trustOf(service, repositoryId);
        const hooks = (trust.hooks as ClassifiedHook[]).filter((h) => h.name === "t080empty");
        expect({ hooks: hooks.map((h) => h.repositoryControlled), commit: trust.approvalRequired.commit }).toEqual({ hooks: [true], commit: true });
      }),
    TIMEOUT_MS,
  );

  // Research probe D8 (Git 2.56.0.windows.1): `git hook list` and `git hook run` exit 0 for a value that is no boolean, and that entry changes no flag.
  for (const values of [["maybe"], ["false", "maybe"], ["maybe", "false"]]) {
    caseTest(
      "T080",
      `hook.<name>.enabled entries ${JSON.stringify(values)} give the disabled flag of git hook list`,
      W,
      () =>
        withService({ name: `t080-enabled-${values.join("-")}` }, async (service) => {
          const built = buildF02(gitPath(), `t080-enabled-${values.join("-")}`);
          const repo = repoOf(built);
          const canary = outsideProgram(built, `enabled-${values.join("-")}`);
          config(repo, "hook.t080on.event", "pre-commit");
          config(repo, "hook.t080on.command", canary.command);
          for (const value of values) config(repo, "--add", "hook.t080on.enabled", value);
          const expected = hookList(repo, "pre-commit").map((h) => h.disabled);
          expect(expected).toHaveLength(1);
          const { repositoryId } = await service.register(repo);
          const trust = await trustOf(service, repositoryId);
          expect((trust.hooks as ClassifiedHook[]).filter((h) => h.name === "t080on").map((h) => h.disabled === true)).toEqual(expected);
          expect(ran([canary.log])).toEqual([]);
        }),
      TIMEOUT_MS,
    );
  }
});

describe("listing internals (contract §7)", () => {
  // Git `parse.c` `git_parse_int` accepts only the units k, m, and g. A unit text must never index an object prototype.
  test("a boolean value with a prototype name as its unit is no boolean", () => {
    for (const value of ["1constructor", "1__proto__", "1toString", "1hasOwnProperty"]) expect({ value, parsed: parseMaybeBool(value) }).toEqual({ value, parsed: -1 });
    expect(parseMaybeBool("1k")).toBe(1);
  });

  // Git `parse.c` compares the boolean words and the units with `strcasecmp`, which folds only ASCII letters.
  test("a unit or a word folds only ASCII letters, so U+212A KELVIN SIGN is no unit", () => {
    for (const value of ["1K", "0K", "2K"]) expect({ value, parsed: parseMaybeBool(value) }).toEqual({ value, parsed: -1 });
    for (const [value, parsed] of [["1K", 1], ["0k", 0], ["0M", 0], ["1G", 1], ["TRUE", 1], ["Off", 0], ["yEs", 1], ["NO", 0]] as const) expect({ value, parsed: parseMaybeBool(value) }).toEqual({ value, parsed });
  });

  test("a refused config listing call still waits for the hooks path call, so no listing process outlives the listing", async () => {
    let releaseHooks = () => {};
    const hooksHeld = new Promise<void>((resolve) => (releaseHooks = resolve));
    let hooksEnded = false;
    const runner = {
      async run(call: { arguments: readonly string[] }) {
        if (call.arguments.join(" ") === configListArgs().join(" ")) throw new RunnerRefusal("UNKNOWN_TARGET", "test refusal");
        await hooksHeld;
        hooksEnded = true;
        return { exitCode: 0, activeDescendants: 0 };
      },
    } as unknown as GitRunner;
    const trust = createTrust({ runner, environment: {} });
    const workspace = { repositoryId: crypto.randomUUID(), gitInstallationId: crypto.randomUUID(), worktreeRoot: FIXTURE_ROOT } as unknown as Workspace;
    let settled = false;
    const listing = trust.listTrust({ operationId: crypto.randomUUID(), signal: new AbortController().signal, workspace });
    void listing.then(() => (settled = true));
    await Bun.sleep(100);
    expect({ settled, hooksEnded }).toEqual({ settled: false, hooksEnded: false });
    releaseHooks();
    expect(await listing).toEqual({ ok: false, code: "UNKNOWN_TARGET" });
    expect(hooksEnded).toBe(true);
  });
});

describe("identity errors (contract §6 \"Process fields\", §7 \"Inside and outside\")", () => {
  // Only a not-found identity reply means a missing path. Another identity error leaves the place unknown.
  caseTest(
    "T080",
    "an identity error that is not a not-found result for a global program path outside the roots ends readTrust failed with REPOSITORY_UNAVAILABLE",
    W,
    async () => {
      const built = buildF02(gitPath(), "t080-identity-error");
      const repo = repoOf(built);
      // An absent program in an owned folder outside the worktree. Only its own identity request fails.
      const program = join(built.root, "outside-bin", "cleaner");
      mkdirSync(dirname(program), { recursive: true });
      const { environment } = ownGlobal(built, [["filter.t080.clean", slash(program)]]);
      await withService({ name: "t080-identity-error", environment }, async (service) => {
        const { repositoryId } = await service.register(repo);
        expect((await trustOf(service, repositoryId)).approvalRequired.reads).toBe(false);
        const asked = service.runner.identityCalls.flatMap((c) => c.paths).filter((p) => samePath(p) === samePath(program));
        expect(asked.length).toBeGreaterThan(0);
        for (const path of new Set(asked)) service.runner.inject.identities.set(path, { code: "UNSUPPORTED_REPOSITORY" });
        expect(outcome(await service.readTrust(repositoryId))).toEqual({ state: "failed", code: "REPOSITORY_UNAVAILABLE" });
      });
    },
    TIMEOUT_MS,
  );
});

describe("hooks folder outside the roots (contract §7 \"Inside and outside\")", () => {
  caseTest(
    "T080",
    "a local core.hooksPath that names an owned folder outside the worktree needs commit approval without a listed hook, and the service lists no hook there",
    W,
    () =>
      withService({ name: "t080-outside-hooks" }, async (service) => {
        const built = buildF02(gitPath(), "t080-outside-hooks");
        const repo = repoOf(built);
        const folder = join(built.root, "outside-hooks");
        mkdirSync(folder, { recursive: true });
        config(repo, "core.hooksPath", slash(folder));
        const { repositoryId } = await service.register(repo);
        const folderHooks = (trust: TrustResult) => (trust.hooks as ClassifiedHook[]).filter((h) => h.path !== undefined);
        const empty = await trustOf(service, repositoryId);
        expect({ commit: empty.approvalRequired.commit, folder: folderHooks(empty) }).toEqual({ commit: true, folder: [] });
        // Oracle: Git lists a hook in that folder. The service never opens the folder, so it lists none.
        const canary = outsideProgram(built, "outside-hooks-pre-commit");
        chmodSync(put(folder, "pre-commit", `#!/bin/sh\nexec ${canary.command}\n`), 0o755);
        expect(hookList(repo, "pre-commit").map((h) => h.scope ?? "hookdir")).toEqual(["hookdir"]);
        const listed = await trustOf(service, repositoryId);
        expect({ commit: listed.approvalRequired.commit, folder: folderHooks(listed) }).toEqual({ commit: true, folder: [] });
        expect(ran([canary.log])).toEqual([]);
      }),
    TIMEOUT_MS,
  );

  // A UNC folder gets no file system call. Any call there would wait on the network.
  caseTest(
    "T080",
    "a local core.hooksPath on a UNC path needs commit approval, and readTrust ends without a file system call there",
    W,
    () =>
      withService({ name: "t080-unc-hooks" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t080-unc-hooks"));
        config(repo, "core.hooksPath", "//arbareto.invalid/share/hooks");
        const { repositoryId } = await service.register(repo);
        const from = service.runner.identityCalls.length;
        const { value: trust, calls } = await withFsCalls(() => trustOf(service, repositoryId));
        expect({ commit: trust.approvalRequired.commit, folder: (trust.hooks as ClassifiedHook[]).filter((h) => h.path !== undefined) }).toEqual({ commit: true, folder: [] });
        const reached = [...calls.map((c) => c.path), ...service.runner.identityCalls.slice(from).flatMap((c) => c.paths)].filter((path) => below(path, UNC_SHARE));
        expect(reached).toEqual([]);
      }),
    TIMEOUT_MS,
  );
});

// The test UNC share. `.invalid` is a reserved top-level domain (RFC 2606), so no host answers.
const UNC_SHARE = "//arbareto.invalid/share";
// True for `path` or a path below `base`, by the samePath text rule of these tests.
const below = (path: string, base: string) => String(samePath(path)) === String(samePath(base)) || String(samePath(path)).startsWith(`${String(samePath(base))}/`);

// Contract §7 "Program file digests": the service reads the hooks folder and each hook entry only through `fileFacts`, and the shell never follows a link.
describe("hooks folder links (contract §7 \"Hook registrations\")", () => {
  // A directory link or a file link to the test UNC share. Windows needs the symbolic link privilege for it.
  function linkOrSkip(target: string, path: string, type: "dir" | "file"): boolean {
    try {
      symlinkSync(target, path, type);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      console.log(`SKIP T080 hooks link: symlink creation gives EPERM for this account`);
      return false;
    }
  }

  caseTest(
    "T080",
    "a .git/hooks folder that is a link to the UNC share lists no hook, needs commit approval with bound link, and no file call or identity request reaches below the link",
    W,
    () =>
      withService({ name: "t080-hooks-folder-link" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t080-hooks-folder-link"));
        const hooks = join(repo, ".git", "hooks");
        rmSync(hooks, { recursive: true, force: true });
        if (!linkOrSkip(UNC_SHARE, hooks, "dir")) return;
        const { repositoryId } = await service.register(repo);
        const from = service.runner.identityCalls.length;
        const { value: trust, calls } = await withFsCalls(() => trustOf(service, repositoryId));
        expect({ commit: trust.approvalRequired.commit, bound: trust.bound, folder: (trust.hooks as ClassifiedHook[]).filter((h) => h.path !== undefined) }).toEqual({
          commit: true,
          bound: "link",
          folder: [],
        });
        const paths = [...calls.map((c) => c.path), ...service.runner.identityCalls.slice(from).flatMap((c) => c.paths)];
        expect(paths.filter((path) => (below(path, hooks) && !below(hooks, path)) || below(path, UNC_SHARE))).toEqual([]);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    "T080",
    "a .git/hooks/pre-commit entry that is a link to the UNC share is listed with bound link, needs commit approval, and the service makes no file call there",
    W,
    () =>
      withService({ name: "t080-hook-entry-link" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t080-hook-entry-link"));
        const hook = join(repo, ".git", "hooks", "pre-commit");
        if (!linkOrSkip(`${UNC_SHARE}/pre-commit`, hook, "file")) return;
        const { repositoryId } = await service.register(repo);
        const { value: trust, calls } = await withFsCalls(() => trustOf(service, repositoryId));
        expect({
          commit: trust.approvalRequired.commit,
          bound: trust.bound,
          folder: (trust.hooks as ClassifiedHook[]).filter((h) => h.path !== undefined).map((h) => ({ event: h.event, path: samePath(h.path) })),
        }).toEqual({ commit: true, bound: "link", folder: [{ event: "pre-commit", path: samePath(hook) }] });
        expect(calls.filter((c) => below(c.path, hook))).toEqual([]);
      }),
    TIMEOUT_MS,
  );
});

describe("configuration file paths (contract §7 \"Configuration file paths\")", () => {
  const VAR_SYSTEM = ["--no-lazy-fetch", "var", "GIT_CONFIG_SYSTEM"];
  const VAR_GLOBAL = ["--no-lazy-fetch", "var", "GIT_CONFIG_GLOBAL"];
  const isVar = (args: readonly string[]) => [VAR_SYSTEM, VAR_GLOBAL].some((v) => v.join("\0") === args.join("\0"));
  const varCalls = (service: Service) => service.runner.calls.filter((c) => c.contextKind === "gitProbe" && c.refused === undefined && isVar(c.arguments)).map((c) => c.arguments.join(" "));

  // Oracle: git-var(1) in `env`. Exit 0 prints one path per line. Exit 1 without output means no file of that kind.
  function gitVar(name: string, env: Record<string, string>): { exitCode: number | null; lines: string[] } {
    const proc = Bun.spawnSync([gitPath(), "var", name], { cwd: FIXTURE_ROOT, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const out = proc.stdout.toString("utf8");
    return { exitCode: proc.exitCode, lines: out === "" ? [] : out.replace(/\n$/, "").split("\n") };
  }

  // The service steps of one installation without the session: probe, registration, and one trust listing.
  async function changeFilesOf(service: Service, repo: string, environment: Record<string, string>, runner: GitRunner = service.runner): Promise<{ installation: GitInstallation; changeFiles: ChangeFiles }> {
    const signal = new AbortController().signal;
    const probed = await probeGit(runner, { bootstrapId: service.runner.addContext("gitProbe", gitPath()), executablePath: gitPath() });
    if (!("installation" in probed)) throw new Error(`probe failed: ${JSON.stringify(probed)}`);
    const { installation } = probed;
    const registrations = createRegistrations({ runner: service.runner, unfinishedMutation: () => false });
    const registered = await registrations.register({ operationId: crypto.randomUUID(), bootstrapId: service.runner.addContext("repositoryDiscovery", repo), installation, signal });
    if (!registered.ok || !("repositoryId" in registered.result)) throw new Error(`registration failed: ${JSON.stringify(registered)}`);
    const workspace = registrations.get(registered.result.repositoryId)!;
    const trust = createTrust({ runner: service.runner, environment, configFiles: (id) => (id === installation.gitInstallationId ? installation.configFiles : undefined) });
    const listed = await trust.listTrust({ operationId: crypto.randomUUID(), signal, workspace });
    if (!listed.ok) throw new Error(`listing failed: ${JSON.stringify(listed)}`);
    return { installation, changeFiles: listed.listing.changeFiles };
  }

  caseTest(
    "T080",
    "without HOME in the service environment, the git var lines name the system and the owned global file, the change files stay complete, git var runs once per installation, and each listing starts 2 Git processes",
    W,
    async () => {
      const repo = repoOf(buildF02(gitPath(), "t080-var-no-home"));
      const environment = serviceEnv();
      for (const key of Object.keys(environment)) if (key.toUpperCase() === "HOME") delete environment[key];
      const system = gitVar("GIT_CONFIG_SYSTEM", environment);
      const global = gitVar("GIT_CONFIG_GLOBAL", environment);
      // Git prints the path with `/` (`C:/…` on Windows).
      expect({ system: system.exitCode, global }).toEqual({ system: 0, global: { exitCode: 0, lines: [slash(FIXTURE_GLOBAL_CONFIG)] } });
      await withService({ name: "t080-var-no-home", environment }, async (service) => {
        expect(varCalls(service)).toEqual([VAR_SYSTEM.join(" "), VAR_GLOBAL.join(" ")]);
        const { repositoryId } = await service.register(repo);
        const listing = [configListArgs().join(" "), hooksPathArgs().join(" ")].sort();
        for (let i = 0; i < 2; i++) {
          const from = service.runner.calls.length;
          expect(outcome(await service.readTrust(repositoryId))).toEqual(SUCCEEDED);
          expect(service.runner.calls.slice(from).map((c) => c.arguments.join(" ")).sort()).toEqual(listing);
        }
        const from = service.runner.calls.length;
        expect(outcome(await service.readWorkspace(repositoryId))).toEqual(SUCCEEDED);
        expect(service.runner.calls.slice(from).map((c) => c.arguments.join(" ")).filter((args) => listing.includes(args) || isVar(args.split(" "))).sort()).toEqual(listing);
        expect(varCalls(service)).toHaveLength(2);

        const { installation, changeFiles } = await changeFilesOf(service, repo, environment);
        expect(installation.configFiles).toEqual([...system.lines, ...global.lines]);
        expect(changeFiles.complete).toBe(true);
        const paths = changeFiles.configPaths.map(samePath);
        for (const file of [...system.lines, FIXTURE_GLOBAL_CONFIG]) expect(paths).toContain(samePath(file));
      });
    },
    TIMEOUT_MS,
  );

  caseTest(
    "T080",
    "GIT_CONFIG_NOSYSTEM=1 makes git var GIT_CONFIG_SYSTEM exit 1 without output, so no system candidate exists and the change files stay complete",
    W,
    async () => {
      const repo = repoOf(buildF02(gitPath(), "t080-var-nosystem"));
      const environment = serviceEnv({ GIT_CONFIG_NOSYSTEM: "1" });
      expect(gitVar("GIT_CONFIG_SYSTEM", environment)).toEqual({ exitCode: 1, lines: [] });
      const systemFiles = gitVar("GIT_CONFIG_SYSTEM", serviceEnv()).lines;
      expect(systemFiles.length).toBeGreaterThan(0);
      await withService({ name: "t080-var-nosystem", environment }, async (service) => {
        const { installation, changeFiles } = await changeFilesOf(service, repo, environment);
        expect(installation.configFiles).toEqual([slash(FIXTURE_GLOBAL_CONFIG)]);
        expect(changeFiles.complete).toBe(true);
        const paths = changeFiles.configPaths.map(samePath);
        expect(paths).toContain(samePath(FIXTURE_GLOBAL_CONFIG));
        for (const file of systemFiles) expect(paths).not.toContain(samePath(file));
      });
    },
    TIMEOUT_MS,
  );

  caseTest(
    "T080",
    "a git var call with another exit status, or exit 1 with output, refuses the Git with GIT_UNSUPPORTED, and the probe stops at the first such call",
    W,
    async () => {
      const environment = serviceEnv();
      await withService({ name: "t080-var-status", environment }, async (service) => {
        // Exit 1 with output and exit 2 are no git-var(1) result.
        for (const [args, exitCode, later] of [
          [VAR_SYSTEM, 1, [VAR_GLOBAL]],
          [VAR_GLOBAL, 2, []],
        ] as const) {
          const ran: string[] = [];
          const wrapped: GitRunner = {
            ...service.runner,
            async run(call) {
              ran.push(call.arguments.join(" "));
              const exit = await service.runner.run(call);
              return call.arguments.join(" ") === args.join(" ") ? { ...exit, exitCode } : exit;
            },
          };
          const probed = await probeGit(wrapped, { bootstrapId: service.runner.addContext("gitProbe", gitPath()), executablePath: gitPath() });
          expect({ args, probed }).toMatchObject({ args, probed: { ok: false, gitCode: "GIT_UNSUPPORTED" } });
          expect({ args, later: later.filter((v) => ran.includes(v.join(" "))) }).toEqual({ args, later: [] });
          expect(ran).toContain(args.join(" "));
        }
      });
    },
    TIMEOUT_MS,
  );
});

// The test UNC share of T307. `.invalid` is a reserved top-level domain (RFC 2606), so no host answers.
const NONEXISTENT_SHARE = "//nonexistent.invalid/share";
// A junction needs Windows. Off Windows, `symlinkSync` with type "junction" makes a symbolic link.
const ALIAS_LINK: Capability = process.platform === "win32" ? "ntfs-junction" : "symlink";

// The facts of each `fileFacts` request after call index `from`.
const factsSince = (service: Service, from: number): FileFact[] => service.runner.fileFactCalls.slice(from).flatMap((c) => c.facts);

const FACT_ROOTS = ["worktreeRoot", "gitDirectory", "commonDirectory"] as const;

// Contract §6 "File facts": each entry names a root of `repositoryId` and native components only.
// Each entry path, joined to its root, stays below that root and never reaches a path below `forbidden`.
function entryBreaks(service: Service, from: number, repo: string, repositoryId: string, forbidden: string): unknown[] {
  const roots = gitPaths(repo);
  const breaks: unknown[] = [];
  for (const call of service.runner.fileFactCalls.slice(from)) {
    if (call.repositoryId !== repositoryId) breaks.push({ repositoryId: call.repositoryId });
    for (const entry of call.files) {
      const rootName = entry.root as string;
      if (!(FACT_ROOTS as readonly string[]).includes(rootName)) {
        breaks.push({ root: rootName });
        continue;
      }
      const base = roots[entry.root];
      const joined = join(base, ...entry.path);
      if (entry.path.length === 0 || !entry.path.every((name) => NATIVE.isComponent(name))) breaks.push({ components: entry.path });
      if (!below(joined, base) || below(joined, forbidden)) breaks.push({ walks: joined });
    }
  }
  return breaks;
}
const entriesSince = (service: Service, from: number) => service.runner.fileFactCalls.slice(from).flatMap((c) => c.files);

// Replaces the link at `path`. Windows removes a directory link with `rmdir`.
function relink(target: string, path: string, type: "dir" | "file"): void {
  if (type === "dir" && process.platform === "win32") rmdirSync(path);
  else unlinkSync(path);
  symlinkSync(target, path, type);
}

// Contract §7 "Inside and outside" and "Program file digests" (T309): the service reads hook and program paths only through `fileFacts` below a root.
describe("file facts for hooks (contract §7 \"Inside and outside\", \"Program file digests\")", () => {
  const folderHooks = (trust: TrustResult) => (trust.hooks as ClassifiedHook[]).filter((h) => h.path !== undefined);
  const reached = (calls: { path: string }[], service: Service, identityFrom: number, base: string) =>
    [...calls.map((c) => c.path), ...service.runner.identityCalls.slice(identityFrom).flatMap((c) => c.paths)].filter((path) => below(path, base));

  // A repository-controlled path outside the roots gets no identity request and no `fileFacts` entry.
  caseTest(
    "T307",
    "a local core.hooksPath=//nonexistent.invalid/share needs commit approval, lists no folder hook, and no file call, identity request, or fileFacts entry reaches the share",
    W,
    () =>
      withService({ name: "t307-unc-hooks-path" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t307-unc-hooks-path"));
        config(repo, "core.hooksPath", NONEXISTENT_SHARE);
        const { repositoryId } = await service.register(repo);
        const identityFrom = service.runner.identityCalls.length;
        const factFrom = service.runner.fileFactCalls.length;
        const { value: trust, calls } = await withFsCalls(() => trustOf(service, repositoryId));
        expect({ commit: trust.approvalRequired.commit, folder: folderHooks(trust) }).toEqual({ commit: true, folder: [] });
        expect(reached(calls, service, identityFrom, NONEXISTENT_SHARE)).toEqual([]);
        // The folder lies outside every root, so phase 1 asks no fact for it or for its entries.
        expect({ entries: entriesSince(service, factFrom), facts: factsSince(service, factFrom) }).toEqual({ entries: [], facts: [] });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    "T307",
    "a .git/hooks folder link to //nonexistent.invalid/share needs commit approval and lists no folder hook; phase 1 reads the link through fileFacts, nothing reaches the share, and a new link target text changes the fingerprint",
    [...W, "symlink"],
    () =>
      withService({ name: "t307-hooks-folder-link" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t307-hooks-folder-link"));
        const hooks = join(repo, ".git", "hooks");
        rmSync(hooks, { recursive: true, force: true });
        symlinkSync(NONEXISTENT_SHARE, hooks, "dir");
        const { repositoryId } = await service.register(repo);
        const identityFrom = service.runner.identityCalls.length;
        const factFrom = service.runner.fileFactCalls.length;
        const { value: first, calls } = await withFsCalls(() => trustOf(service, repositoryId));
        expect({ commit: first.approvalRequired.commit, folder: folderHooks(first) }).toEqual({ commit: true, folder: [] });
        expect(reached(calls, service, identityFrom, NONEXISTENT_SHARE)).toEqual([]);
        // Phase 1 reads the hooks folder (contract §7 "Program file digests"). The shell reports the link and never follows it.
        expect(factsSince(service, factFrom).filter((f) => f.kind === "link").length).toBeGreaterThan(0);
        expect(entryBreaks(service, factFrom, repo, repositoryId, NONEXISTENT_SHARE)).toEqual([]);
        expect((await trustOf(service, repositoryId)).fingerprint).toBe(first.fingerprint);
        // Contract §7 fact table: the fingerprint holds each hop's target text.
        relink("//nonexistent.invalid/other", hooks, "dir");
        expect((await trustOf(service, repositoryId)).fingerprint).not.toBe(first.fingerprint);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    "T307",
    "a hook link .git/hooks/pre-commit -> ../../scripts/h.sh resolves inside the worktree: commit approval is required, the approval is stored, and one changed byte of scripts/h.sh gives state changed and TRUST_CHANGED",
    [...W, "symlink"],
    async () => {
      const built = buildF02(gitPath(), "t307-hook-link-inside");
      const repo = repoOf(built);
      const log = join(built.root, "canaries", "t307-hook-link-inside.log");
      const script = put(repo, "scripts/h.sh", SCRIPT(log));
      const hook = join(repo, ".git", "hooks", "pre-commit");
      mkdirSync(dirname(hook), { recursive: true });
      symlinkSync("../../scripts/h.sh", hook, "file");
      // Oracle: Git lists the hook through the link.
      expect(hookList(repo, "pre-commit").map((h) => h.scope ?? "hookdir")).toEqual(["hookdir"]);
      await withService({ name: "t307-hook-link-inside" }, async (service) => {
        const { repositoryId } = await service.register(repo);
        const factFrom = service.runner.fileFactCalls.length;
        const trust = await trustOf(service, repositoryId);
        expect({
          commit: trust.approvalRequired.commit,
          bound: trust.bound,
          persistence: trust.persistence,
          folder: folderHooks(trust).map((h) => h.event),
        }).toEqual({ commit: true, bound: undefined, persistence: "stored", folder: ["pre-commit"] });
        // Phase 2 digests the resolved file below the worktree root.
        expect(factsSince(service, factFrom).some((f) => f.kind === "file" && f.digest === sha256(readFileSync(script)))).toBe(true);
        expect(entryBreaks(service, factFrom, repo, repositoryId, NONEXISTENT_SHARE)).toEqual([]);
        expect(await approve(service, repositoryId, trust)).toMatchObject({ persistence: "stored" });
        flipByte(script);
        const changed = await trustOf(service, repositoryId);
        expect({ state: changed.state, commit: changed.approvalRequired.commit }).toEqual({ state: "changed", commit: true });
        // Contract §9: the approval of the old fingerprint gives TRUST_CHANGED.
        expect(gate(await service.approveTrust(repositoryId, trust.fingerprint, trust.generation))).toEqual(TRUST_CHANGED);
      });
      expect(ran([log])).toEqual([]);
    },
    TIMEOUT_MS,
  );

  // Contract §7 "Program file digests": a relative target with `..` after a normal component cannot be resolved.
  caseTest(
    "T307",
    "a hook link with the target x/../h.sh is listed with bound link and persistence session, and a new target text y/../h.sh changes the fingerprint",
    [...W, "symlink"],
    () =>
      withService({ name: "t307-hook-link-dotdot" }, async (service) => {
        const repo = repoOf(buildF02(gitPath(), "t307-hook-link-dotdot"));
        const hook = join(repo, ".git", "hooks", "pre-commit");
        mkdirSync(dirname(hook), { recursive: true });
        symlinkSync("x/../h.sh", hook, "file");
        const { repositoryId } = await service.register(repo);
        const factFrom = service.runner.fileFactCalls.length;
        const trust = await trustOf(service, repositoryId);
        // Phase 1 reads the hooks folder and its entries (contract §7 "Program file digests").
        expect(entriesSince(service, factFrom).length).toBeGreaterThan(0);
        expect(entryBreaks(service, factFrom, repo, repositoryId, NONEXISTENT_SHARE)).toEqual([]);
        expect({
          commit: trust.approvalRequired.commit,
          bound: trust.bound,
          persistence: trust.persistence,
          folder: folderHooks(trust).map((h) => h.event),
        }).toEqual({ commit: true, bound: "link", persistence: "session", folder: ["pre-commit"] });
        // Contract §7 fact table: an unresolved link enters the fingerprint with each hop's target text.
        relink("y/../h.sh", hook, "file");
        expect((await trustOf(service, repositoryId)).fingerprint).not.toBe(trust.fingerprint);
      }),
    TIMEOUT_MS,
  );

  // The identity request maps the alias to the worktree root. The service then reads the hook only through `fileFacts` below that root.
  caseTest(
    "T307",
    "a global core.hooksPath through a junction or symlink alias of the worktree maps to the worktree root: the tracked hook needs commit approval, fileFacts gives its digest, and the service makes no file call below the worktree or the alias",
    [...W, ALIAS_LINK],
    async () => {
      const built = buildF08(gitPath(), "t307-alias-hooks", "sha1");
      const repo = repoOf(built);
      const canary = outsideProgram(built, "t307-alias-pre-commit");
      const tracked = put(repo, ".githooks/pre-commit", `#!/bin/sh\nexec ${canary.command}\n`);
      chmodSync(tracked, 0o755);
      git(repo, ["add", "--", ".githooks/pre-commit"]);
      git(repo, ["commit", "-q", "--no-verify", "-m", "hooks"]);
      const alias = join(built.root, "alias");
      symlinkSync(repo, alias, "junction");
      const hooksPath = `${slash(alias)}/.githooks`;
      expect(String(samePath(hooksPath)).startsWith(`${String(samePath(repo))}/`)).toBe(false);
      const { file, environment } = ownGlobal(built, [["core.hooksPath", hooksPath]]);
      // Oracle: Git lists the tracked hook through the alias.
      expect(hookList(repo, "pre-commit", { GIT_CONFIG_GLOBAL: file }).map((h) => h.scope ?? "hookdir")).toEqual(["hookdir"]);
      await withService({ name: "t307-alias-hooks", environment }, async (service) => {
        const { repositoryId } = await service.register(repo);
        const factFrom = service.runner.fileFactCalls.length;
        const { value: trust, calls } = await withFsCalls(() => trustOf(service, repositoryId));
        const hooks = (trust.hooks as ClassifiedHook[]).filter((h) => h.event === "pre-commit");
        expect(hooks.map((h) => ({ folder: h.path !== undefined, repositoryControlled: h.repositoryControlled }))).toEqual([{ folder: true, repositoryControlled: true }]);
        expect(trust.approvalRequired.commit).toBe(true);
        expect(factsSince(service, factFrom).some((f) => f.kind === "file" && f.digest === sha256(readFileSync(tracked)))).toBe(true);
        // The alias maps to the worktree root, so no entry names a path below the alias.
        expect(entryBreaks(service, factFrom, repo, repositoryId, alias)).toEqual([]);
        expect(calls.filter((c) => below(c.path, repo) || below(c.path, alias))).toEqual([]);
      });
      expect(ran([canary.log])).toEqual([]);
    },
    TIMEOUT_MS,
  );

  caseTest(
    "T307",
    "a global core.hooksPath folder outside every root keeps its location only: no folder hook, no commit approval, no file call or fileFacts fact for it, and a changed hook byte there keeps the fingerprint",
    W,
    async () => {
      const built = buildF02(gitPath(), "t307-outside-global-hooks");
      const repo = repoOf(built);
      const folder = join(built.root, "outside-hooks");
      const canary = outsideProgram(built, "t307-outside-pre-commit");
      const hook = put(folder, "pre-commit", `#!/bin/sh\nexec ${canary.command}\n# t307\n`);
      chmodSync(hook, 0o755);
      const { file, environment } = ownGlobal(built, [["core.hooksPath", slash(folder)]]);
      // Oracle: Git lists the hook in that folder.
      expect(hookList(repo, "pre-commit", { GIT_CONFIG_GLOBAL: file }).map((h) => h.scope ?? "hookdir")).toEqual(["hookdir"]);
      await withService({ name: "t307-outside-global-hooks", environment }, async (service) => {
        const { repositoryId } = await service.register(repo);
        const factFrom = service.runner.fileFactCalls.length;
        const { value: trust, calls } = await withFsCalls(() => trustOf(service, repositoryId));
        expect({ commit: trust.approvalRequired.commit, folder: folderHooks(trust) }).toEqual({ commit: false, folder: [] });
        expect(calls.filter((c) => below(c.path, folder))).toEqual([]);
        expect({ entries: entriesSince(service, factFrom), facts: factsSince(service, factFrom) }).toEqual({ entries: [], facts: [] });
        flipByte(hook);
        expect((await trustOf(service, repositoryId)).fingerprint).toBe(trust.fingerprint);
      });
      expect(ran([canary.log])).toEqual([]);
    },
    TIMEOUT_MS,
  );

  // Contract §7 fact table: a link that resolves outside the roots is listed, and the fingerprint keeps its location and hop text only.
  caseTest(
    "T307",
    "a hook link .git/hooks/pre-commit to a file outside the roots is listed by location: commit approval is required, the approval is stored, an edit of the target keeps the fingerprint, and a new target changes it",
    [...W, "symlink"],
    async () => {
      const built = buildF02(gitPath(), "t307-hook-link-outside");
      const repo = repoOf(built);
      const target = outsideProgram(built, "t307-link-outside");
      const other = outsideProgram(built, "t307-link-outside-other");
      const hook = join(repo, ".git", "hooks", "pre-commit");
      mkdirSync(dirname(hook), { recursive: true });
      symlinkSync(target.path, hook, "file");
      // Oracle: Git lists the hook through the link.
      expect(hookList(repo, "pre-commit").map((h) => h.scope ?? "hookdir")).toEqual(["hookdir"]);
      await withService({ name: "t307-hook-link-outside" }, async (service) => {
        const { repositoryId } = await service.register(repo);
        const factFrom = service.runner.fileFactCalls.length;
        const { value: trust, calls } = await withFsCalls(() => trustOf(service, repositoryId));
        expect({
          commit: trust.approvalRequired.commit,
          bound: trust.bound,
          persistence: trust.persistence,
          folder: folderHooks(trust).map((h) => h.event),
        }).toEqual({ commit: true, bound: undefined, persistence: "stored", folder: ["pre-commit"] });
        expect(calls.filter((c) => below(c.path, target.path))).toEqual([]);
        expect(entryBreaks(service, factFrom, repo, repositoryId, dirname(target.path))).toEqual([]);
        expect(await approve(service, repositoryId, trust)).toMatchObject({ persistence: "stored" });
        flipByte(target.path);
        expect(await trustOf(service, repositoryId)).toMatchObject({ state: "approved", fingerprint: trust.fingerprint });
        relink(other.path, hook, "file");
        expect((await trustOf(service, repositoryId)).fingerprint).not.toBe(trust.fingerprint);
      });
      expect(ran([target.log, other.log])).toEqual([]);
    },
    TIMEOUT_MS,
  );

  // Contract §5 and §7: link resolution follows at most 8 hops. A junction stores an absolute `\??\` target, and `symlinkSync` off Windows stores the absolute path.
  caseTest(
    "T307",
    `a program path through ${TRUST_LINK_HOPS} chained folder links resolves to the file and gets its digest; ${TRUST_LINK_HOPS + 1} links give bound link and persistence session`,
    [...W, ALIAS_LINK],
    () =>
      withService({ name: "t307-link-hops" }, async (service) => {
        const built = buildF02(gitPath(), "t307-link-hops");
        const repo = repoOf(built);
        const program = insideProgram(built, repo, "real/clean.sh");
        // l1 -> l2 -> ... -> l9 -> real.
        for (let n = TRUST_LINK_HOPS + 1; n >= 1; n--) symlinkSync(join(repo, n > TRUST_LINK_HOPS ? "real" : `l${n + 1}`), join(repo, `l${n}`), "junction");
        const { repositoryId } = await service.register(repo);
        config(repo, "filter.hops.clean", "./l2/clean.sh");
        const resolved = await trustOf(service, repositoryId);
        expect({ bound: resolved.bound, persistence: resolved.persistence }).toEqual({ bound: undefined, persistence: "stored" });
        flipByte(program.path);
        expect((await trustOf(service, repositoryId)).fingerprint).not.toBe(resolved.fingerprint);
        flipByte(program.path);
        config(repo, "filter.hops.clean", "./l1/clean.sh");
        const capped = await trustOf(service, repositoryId);
        expect({ bound: capped.bound, persistence: capped.persistence }).toEqual({ bound: "link", persistence: "session" });
      }),
    TIMEOUT_MS,
  );

  // Contract §7 "Program file digests": a link whose target is exactly a root gives a `directory` fact. Git then reads hooks from that root.
  caseTest(
    "T309",
    "a .git/hooks folder link to .. resolves to the worktree root: its pre-commit hook is listed with a digest, no bound, and one changed byte gives state changed",
    [...W, ALIAS_LINK],
    async () => {
      const built = buildF02(gitPath(), "t309-hooks-root-link");
      const repo = repoOf(built);
      const log = join(built.root, "canaries", "t309-hooks-root-link.log");
      mkdirSync(dirname(log), { recursive: true });
      const hook = put(repo, "pre-commit", SCRIPT(log));
      chmodSync(hook, 0o755);
      const hooks = join(repo, ".git", "hooks");
      rmSync(hooks, { recursive: true, force: true });
      // A junction needs an absolute target. A symbolic link `..` in `.git` names the worktree root.
      symlinkSync(process.platform === "win32" ? repo : "..", hooks, "junction");
      // Oracle: Git lists the hook through the link.
      expect(hookList(repo, "pre-commit").map((h) => h.scope ?? "hookdir")).toEqual(["hookdir"]);
      await withService({ name: "t309-hooks-root-link" }, async (service) => {
        const { repositoryId } = await service.register(repo);
        const trust = await trustOf(service, repositoryId);
        expect({
          commit: trust.approvalRequired.commit,
          bound: trust.bound,
          persistence: trust.persistence,
          folder: folderHooks(trust).map((h) => h.event),
        }).toEqual({ commit: true, bound: undefined, persistence: "stored", folder: ["pre-commit"] });
        await approve(service, repositoryId, trust);
        flipByte(hook);
        expect((await trustOf(service, repositoryId)).state).toBe("changed");
      });
      expect(ran([log])).toEqual([]);
    },
    TIMEOUT_MS,
  );

  // Contract §6 "File facts": the Windows walk opens each component case-insensitively. `factKey` folds ASCII letters, so both texts share one entry.
  caseTest(
    "T309",
    "program paths ./TOOLS/CLEAN.SH and ./tools/clean.sh name one file: each phase sends one entry in the first spelling, the walk finds the file, and one changed byte gives TRUST_CHANGED",
    [...W, "windows-path-rules"],
    () =>
      withService({ name: "t309-ascii-case" }, async (service) => {
        const built = buildF02(gitPath(), "t309-ascii-case");
        const repo = repoOf(built);
        const program = insideProgram(built, repo, "tools/clean.sh");
        config(repo, "filter.upper.clean", "./TOOLS/CLEAN.SH");
        config(repo, "filter.lower.clean", "./tools/clean.sh");
        const { repositoryId } = await service.register(repo);
        const factFrom = service.runner.fileFactCalls.length;
        const trust = await trustOf(service, repositoryId);
        expect({ bound: trust.bound, persistence: trust.persistence }).toEqual({ bound: undefined, persistence: "stored" });
        const sent = service.runner.fileFactCalls
          .slice(factFrom)
          .map((call) => ({ digest: call.digest, paths: call.files.filter((e) => foldAscii(e.path.join("/")) === "tools/clean.sh").map((e) => e.path.join("/")) }));
        expect(sent).toEqual([
          { digest: false, paths: ["TOOLS/CLEAN.SH"] },
          { digest: true, paths: ["TOOLS/CLEAN.SH"] },
        ]);
        expect(factsSince(service, factFrom).some((f) => f.kind === "file" && f.digest === sha256(readFileSync(program.path)))).toBe(true);
        await approve(service, repositoryId, trust);
        flipByte(program.path);
        expect(gate(await service.readWorkspace(repositoryId))).toEqual(TRUST_CHANGED);
      }),
    TIMEOUT_MS,
  );
});
