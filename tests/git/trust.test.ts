// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { foldAscii } from "../../src/contracts/fold-ascii";
import { TRUST_DIGEST_FILE_BYTES, TRUST_DIGEST_FILES, TRUST_DIGEST_TOTAL_BYTES, TRUST_INPUT_BYTES } from "../../src/contracts/limits";
import { redactUrlUserInfo } from "../../src/git-service/trust";
import { printOrigin } from "../origin";
import { FIXTURE_GLOBAL_CONFIG, FIXTURE_ROOT, fixtureEnv, ownedGit, serviceEnv, useFixtureRoot, type OwnedGitOptions } from "./fixture-root";
import { buildF02, buildF07, buildF08, buildF17, put, type Built } from "./fixtures";
import { GIT } from "./git-binary";
import { sha256 } from "./git-oracle";
import { caseTest, once, openService, withPath, type ApproveResult, type OpenOptions, type Service, type ServiceResponse, type TrustResult } from "./service-harness";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/git-service/trust.ts", import.meta.dir);

const TASK = "T071";
const TIMEOUT_MS = 120_000;
const WAIT_MS = 30_000;
const W = ["windows-shell-double"] as const;

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
const readCalls = (service: Service) =>
  service.runner.calls.filter((c) => READ_COMMANDS.has(subcommand(c.arguments)) || (subcommand(c.arguments) === "config" && c.arguments.includes("--file"))).map((c) => c.arguments.join(" "));

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

// Oracle: `git hook list -z --show-scope <event>`. A configured hook prints its scope, `disabled` when off, and its name. A hooks-directory hook prints one field.
function hookList(repo: string, event: string): { scope?: string; disabled: boolean; name: string }[] {
  const out = git(repo, ["hook", "list", "-z", "--show-scope", event], { allowExit: [0, 1] });
  return out
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => {
      const parts = line.split("\t");
      if (parts.length === 1) return { disabled: false, name: parts[0]! };
      return { scope: parts[0]!, disabled: parts.length === 3 && parts[1] === "disabled", name: parts[parts.length - 1]! };
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
      `F17: a repository-scope ${key} canary makes readWorkspace and readHistory return TRUST_REQUIRED before any status, diff, or history read, and no canary runs`,
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

  test.todo("F17 partial clone: readComparison never runs the remote.origin.uploadpack canary, before or after approval (needs T105/T115)", async () => {
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
  });

  test.todo("F17 partial-read-tree: an unstaged comparison whose index blob is missing gives OBJECT_MISSING and no hunk, although ls-files --eol exits 0 with i/none (needs T105/T115)", async () => {
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
  });
});

describe("untracked reads (contract §4)", () => {
  test.todo("F17: with local diff.external and diff.<driver>.textconv canaries on an untracked file, readComparison runs neither canary (needs T105/T115)", async () => {
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
  });

  test.todo("F17: an untracked file with a local filter attribute gives reason filter, and its clean canary never runs, also after approval (needs T105/T115)", async () => {
    const built = buildF17(gitPath(), "t071-untracked-filter", "trust");
    const service = await openService({ git: gitPath(), name: "t071-untracked-filter" });
    try {
      const { repositoryId, generation } = await service.register(repoOf(built));
      expect(gate(await service.readWorkspace(repositoryId, undefined, generation))).toEqual(TRUST_REQUIRED);
      await approve(service, repositoryId);
      const read = (await service.readWorkspace(repositoryId)).result!;
      const entry = read.entries.find((e) => e.path === "untracked.dat" && e.category === "untracked")!;
      const comparison = await service.request("readComparison", { snapshotId: read.snapshotId, entryId: entry.entryId }, { repositoryId, repositoryGeneration: read.generation, selectionId: crypto.randomUUID() });
      expect(valuesOf(comparison.result, "reason")).toContain("filter");
      expect(existsSync(join(built.root, built.facts.canaries.clean!))).toBe(false);
    } finally {
      await service.dispose();
    }
  });
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

  test.todo("a configuration change after approval invalidates a dependent hunk approval: applyHunk gives TRUST_CHANGED (needs T105/T115)", async () => {
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
  });

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

  test.todo("without required approval, a changed fingerprint gives TRUST_CHANGED at a hunk checkpoint, and it clears after the next readWorkspace and a new selection (needs T105/T115)", async () => {
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
  });
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
    W,
    () =>
      withSessions("t071-git-path-ascii-case", {}, async (first, set) => {
        const built = buildF17(gitPath(), "t071-git-path-ascii-case", "trust");
        const repo = repoOf(built);
        await approve(first, (await first.register(repo)).repositoryId);
        // Contract §7 follows the §6 "Startup contexts" case rule: only ASCII letters fold.
        const other = gitPath().replace(/[A-Za-z]/g, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
        expect(other).not.toBe(gitPath());
        const second = set(await nextSession(first, "t071-git-path-ascii-case-next", { gitSelectedPath: other }));
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
    ["windows-shell-double", "git-for-windows"],
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
        expect(outcome(await second.readWorkspace(repositoryId))).toEqual(SUCCEEDED);
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
});

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
    W,
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
    W,
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
    ["windows-shell-double", "git-for-windows"],
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
    W,
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

  test.todo("stale record: after the next readWorkspace and a new selection, applyHunk runs without TRUST_CHANGED (needs T105/T115)", async () => {
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
  });
});
