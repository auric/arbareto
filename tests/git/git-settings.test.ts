// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T050: `readGitSettings` and the `reviewWorkbench` action `config-save` (contract Δ3, Δ6, data-model §9, plan.md D11, quickstart Q21, SC-009).
// The oracle is a second build of the same fixture with Git's own `config set` and `config unset`.

import { expect } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { useFixtureRoot } from "./fixture-root";
import { sha256 } from "./git-oracle";
import { nativeEnv } from "./remote-fixtures";
import { caseTest, type RegistrationResult, type Service, type ServiceResponse } from "./service-harness";
import { gitExe, native, TIMEOUT_MS, until, withSync } from "./sync-harness";
import { buildWorkbench, canary, repoOf, wb, type WbFixture, type WbFixtureName } from "./workbench-fixtures";
import type { GitCall } from "../../src/git-service/git-runner";
import { readGitSettings, SETTINGS_KEYS, type GitSettings } from "../../src/git-service/git-settings";

for (const module of ["git-settings", "workbench-parsers", "workbench-review", "session"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
useFixtureRoot();

const TASK = "T050";
const SHELL = ["shell-double"] as const;
const L = "--no-lazy-fetch";
const LIST = [L, "--no-optional-locks", "--literal-pathspecs", "config", "list", "--show-scope", "--show-origin", "-z"];
const outcome = (r: { state: string; code?: string }) => ({ state: r.state, code: r.code });
const refusal = (r: ServiceResponse<unknown>) => ({ ...outcome(r), result: r.result });

// Spec FR-060 in Git's canonical form, from git-config(1). The test keeps its own copy, so a wrong module list fails.
const FR060 = ["user.name", "user.email", "core.editor", "commit.template", "credential.helper", "diff.tool", "merge.tool", "core.autocrlf", "i18n.filesencoding", "pull.rebase", "fetch.prune", "merge.autostash", "rebase.autostash", "rebase.autosquash", "rebase.updaterefs", "rerere.enabled", "rerere.autoupdate", "pull.ff", "push.default", "push.autosetupremote"];
const BOOLS = new Set(["fetch.prune", "merge.autostash", "rebase.autostash", "rebase.autosquash", "rebase.updaterefs", "rerere.enabled", "rerere.autoupdate", "push.autosetupremote"]);
const ENUMS: Record<string, string[]> = { "core.autocrlf": ["true", "false", "input"], "pull.rebase": ["true", "false", "merges", "interactive"], "pull.ff": ["true", "false", "only"], "push.default": ["nothing", "current", "upstream", "simple", "matching"] };

interface Reviewed {
  action: string;
  plan: { scope: string; changes: { key: string; value: string | null; earlier: { origin: string; value: string | null } | null }[] };
  workbenchToken: string;
}

interface SaveResult {
  action: "config-save";
  scope: string;
  written: string[];
  failed?: { key: string; exitCode: number | null; reason?: string };
  stale?: string;
  outputTail?: string;
}

let builds = 0;
const build = (fixture: WbFixtureName): WbFixture => buildWorkbench(gitExe(), fixture, `t050-${fixture}-${++builds}`);
const git = (f: WbFixture, args: string[], allowExit: number[] = [0]) => wb(repoOf(f), args, { allowExit }).stdout.toString("utf8");
const slashed = (p: string) => (process.platform === "win32" ? p.replaceAll("\\", "/").toLowerCase() : p);
const digests = (f: WbFixture) => Object.fromEntries(Object.entries(f.configs).map(([label, path]) => [label, existsSync(path) ? sha256(readFileSync(path)) : "absent"]));

// The service gets the owned files of the fixture: HOME, the global file, and the system file.
async function withConfig(name: string, f: WbFixture, body: (service: Service) => Promise<void>): Promise<void> {
  await withSync(name, body, { environment: nativeEnv(f.env) });
}

// The Git installation ID of the registered repository, from the `run` requests of the service. The hook refuses nothing.
async function open(service: Service, dir: string): Promise<{ r: RegistrationResult; gitInstallationId: string }> {
  let gitInstallationId = "";
  service.runner.inject.refuse = (call) => {
    const context = (call as Partial<GitCall>).context;
    if (context !== undefined && "gitInstallationId" in context) gitInstallationId = context.gitInstallationId;
    return undefined;
  };
  const r = await service.register(native(dir));
  service.runner.inject.refuse = undefined;
  expect(gitInstallationId).not.toBe("");
  return { r, gitInstallationId };
}

const target = (service: Service, gitInstallationId: string, f: WbFixture | null, repositoryId = "") => ({
  runner: service.runner,
  operationId: crypto.randomUUID(),
  signal: new AbortController().signal,
  gitInstallationId,
  environment: f === null ? {} : nativeEnv(f.env),
  workspace: f === null ? null : { repositoryId, gitInstallationId, commonDirectory: join(f.repo, ".git"), wsl: undefined },
});

async function settings(service: Service, gitInstallationId: string, f: WbFixture | null, repositoryId = ""): Promise<GitSettings> {
  const read = await readGitSettings(target(service, gitInstallationId, f, repositoryId));
  if (!("value" in read)) throw new Error(`readGitSettings: ${JSON.stringify(read)}`);
  return read.value;
}

const value = (s: GitSettings, key: string) => {
  const v = s.values.find((x) => x.key === key);
  if (v === undefined) throw new Error(`no value for ${key}`);
  return v;
};

const review = (service: Service, r: RegistrationResult, payload: object): Promise<ServiceResponse<Reviewed>> => service.request("reviewWorkbench", payload, { repositoryId: r.repositoryId, repositoryGeneration: r.generation });
const sendRun = (service: Service, r: RegistrationResult, token: string) => service.send("runWorkbench", { workbenchToken: token, start: true }, { repositoryId: r.repositoryId });
const save = (scope: "local" | "global", changes: { key: string; value: string | null }[]) => ({ action: "config-save", scope, changes });

async function reviewed(service: Service, r: RegistrationResult, payload: object): Promise<Reviewed> {
  const response = await review(service, r, payload);
  expect({ ...outcome(response), result: response.state === "succeeded" ? "result" : response.result }).toEqual({ state: "succeeded", code: undefined, result: "result" });
  return response.result!;
}

async function run(service: Service, r: RegistrationResult, payload: object): Promise<ServiceResponse<SaveResult>> {
  return service.response<SaveResult>(sendRun(service, r, (await reviewed(service, r, payload)).workbenchToken));
}

const writes = (service: Service, from = 0) =>
  service.runner.calls
    .slice(from)
    .filter((c) => c.environmentPolicy === "integrate")
    .map((c) => ({ contextKind: c.contextKind, arguments: [...c.arguments] }));

// A value that differs from the current one and that Git reads for the key type.
function newValue(key: string, current: string | null): string {
  if (BOOLS.has(key)) return current === "true" ? "false" : "true";
  const values = ENUMS[key];
  if (values !== undefined) return values.find((v) => v !== current)!;
  return `saved ${key}`;
}

const scopeValues = (f: WbFixture, scope: string, key: string) => git(f, ["config", "get", "--all", `--${scope}`, key], [0, 1]).split("\n").filter((l) => l !== "");

caseTest(TASK, "FR-058, FR-059, and plan.md D11: with a repository, each FR-060 key lists every entry with its scope and origin, the effective value is the last entry, an include names its file, and the header files follow git-config(1)", SHELL, async () => {
  const f = build("config-scopes");
  const before = digests(f);
  await withConfig("t050-read", f, async (service) => {
    const { r, gitInstallationId } = await open(service, f.repo);
    const from = service.runner.calls.length;
    const s = await settings(service, gitInstallationId, f, r.repositoryId);
    expect<string[]>([...SETTINGS_KEYS]).toEqual(FR060);
    // Contract Δ3: the FR-060 keys, then the tool keys of the effective `diff.tool` and `merge.tool`.
    expect(s.values.map((v) => v.key)).toEqual([...FR060, "difftool.local-diff.path", "difftool.local-diff.cmd", "mergetool.local-merge.path", "mergetool.local-merge.cmd"]);
    const name = value(s, "user.name");
    expect(name.entries.map((e) => [e.scope, e.value])).toEqual([["system", "system name"], ["global", "global name"], ["local", "local name"]]);
    expect(name.entries.map((e) => slashed(e.origin))).toEqual([`file:${slashed(f.configs.system!)}`, `file:${slashed(f.configs.global!)}`, "file:.git/config"]);
    expect(name.effective).toEqual({ scope: "local", origin: "file:.git/config", value: "local name", reading: "local name" });
    expect(name.scopes.local.map((e) => e.value)).toEqual(["local name"]);
    expect(name.scopes.worktree).toEqual([]);
    // The local `core.editor` comes from the include, and its origin names the included file.
    const editor = value(s, "core.editor");
    expect(editor.effective).toEqual({ scope: "local", origin: "file:.git/included.gitconfig", value: "included-editor", reading: "included-editor" });
    // FR-063: two local `credential.helper` values make that scope read-only.
    const helper = value(s, "credential.helper");
    expect(helper.scopes.local.map((e) => e.value)).toEqual(["local-helper-1", "local-helper-2"]);
    expect(helper.readOnly).toEqual({ local: true, global: false });
    expect(value(s, "fetch.prune").type).toEqual({ kind: "bool" });
    expect(value(s, "fetch.prune").scopes.global.map((e) => e.reading)).toEqual(["false"]);
    expect(value(s, "pull.rebase").effective?.reading).toBe("false");
    expect(value(s, "difftool.local-diff.cmd").entries).toEqual([]);
    expect({ local: slashed(s.files.local!), global: slashed(s.files.global!), system: slashed(s.files.system!) }).toEqual({ local: slashed(f.configs.local!), global: slashed(f.configs.global!), system: slashed(f.configs.system!) });
    // The read runs the listing and the two git-var(1) reads, and no write.
    expect(service.runner.calls.slice(from).map((c) => [c.contextKind, c.environmentPolicy, ...c.arguments])).toEqual([
      ["registeredOperation", "read", ...LIST],
      ["registeredOperation", "read", L, "var", "GIT_CONFIG_SYSTEM"],
      ["registeredOperation", "read", L, "var", "GIT_CONFIG_GLOBAL"],
    ]);
  });
  expect(digests(f)).toEqual(before);
}, TIMEOUT_MS);

caseTest(TASK, "plan.md D11: an XDG global file is the header and the save target when ~/.gitconfig does not exist; an existing ~/.gitconfig takes its place", SHELL, async () => {
  const f = build("config-xdg");
  const o = build("config-xdg");
  const home = join(f.root, "home", ".gitconfig");
  await withConfig("t050-xdg", f, async (service) => {
    const { r, gitInstallationId } = await open(service, f.repo);
    const s = await settings(service, gitInstallationId, f, r.repositoryId);
    expect(slashed(s.files.global!)).toBe(slashed(f.configs.xdg!));
    expect(value(s, "user.name").scopes.global.map((e) => [slashed(e.origin), e.value])).toEqual([[`file:${slashed(f.configs.xdg!)}`, "xdg name"]]);
    expect(s.files.system).toBeNull();
    const response = await run(service, r, save("global", [{ key: "user.name", value: "saved xdg" }]));
    expect(outcome(response)).toEqual({ state: "succeeded", code: undefined });
    expect(response.result).toEqual({ action: "config-save", scope: "global", written: ["user.name"] });
    wb(repoOf(o), ["config", "set", "--global", "--", "user.name", "saved xdg"]);
    expect(Object.values(digests(f))).toEqual(Object.values(digests(o)));
    expect(existsSync(home)).toBe(false);
    // git-config(1) `--global`: an existing ~/.gitconfig wins over the XDG file.
    writeFileSync(home, "");
    expect(slashed((await settings(service, gitInstallationId, f, r.repositoryId)).files.global!)).toBe(slashed(home));
    rmSync(home);
  });
}, TIMEOUT_MS);

caseTest(TASK, "FR-058 and contract Δ6: without a repository, the listing runs in the globalConfig context and lists only system, global, and command entries", SHELL, async () => {
  const f = build("config-scopes");
  await withConfig("t050-global-config", f, async (service) => {
    const { gitInstallationId } = await open(service, f.repo);
    const from = service.runner.calls.length;
    const s = await settings(service, gitInstallationId, null);
    expect(service.runner.calls.slice(from).map((c) => [c.contextKind, c.environmentPolicy, c.refused ?? null, ...c.arguments])).toEqual([["globalConfig", "read", null, ...LIST]]);
    const scopes = new Set(s.values.flatMap((v) => v.entries.map((e) => e.scope)));
    expect([...scopes].sort()).toEqual(["global", "system"]);
    expect(value(s, "user.name").effective?.value).toBe("global name");
    // Plan.md D15: without a repository, no save target exists.
    expect(s.files).toEqual({ local: null, global: null, system: null });
  });
}, TIMEOUT_MS);

for (const scope of ["local", "global"] as const) {
  caseTest(TASK, `SC-009 and FR-064: Save each FR-060 key in ${scope}; only that key changes in only the ${scope} file, and every other configuration byte equals Git's own config set on a copy`, SHELL, async () => {
    const f = build("config-scopes");
    const o = build("config-scopes");
    await withConfig(`t050-save-${scope}`, f, async (service) => {
      const { r } = await open(service, f.repo);
      // The tool keys of the effective tools go first, because a later `diff.tool` or `merge.tool` save changes those tools.
      for (const key of ["difftool.local-diff.path", "difftool.local-diff.cmd", "mergetool.local-merge.path", "mergetool.local-merge.cmd", ...FR060]) {
        const current = scopeValues(f, scope, key);
        const before = digests(f);
        if (current.length > 1) {
          // FR-063 and contract Δ3: several entries in the scope.
          expect(refusal(await review(service, r, save(scope, [{ key, value: "x" }])))).toEqual({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason: "multi-value" } });
          expect(digests(f)).toEqual(before);
          continue;
        }
        const next = newValue(key, current[0] ?? null);
        const from = service.runner.calls.length;
        const response = await run(service, r, save(scope, [{ key, value: next }]));
        // The included local `core.editor` stays the last local entry, so the saved value is not the effective one.
        const differing = scope === "local" && key === "core.editor";
        expect({ key, ...outcome(response) }).toEqual({ key, ...(differing ? { state: "completed-with-effects", code: "COMPLETED_WITH_EFFECTS" } : { state: "succeeded", code: undefined }) });
        expect(response.result).toEqual({ action: "config-save", scope, written: [key] });
        expect(writes(service, from)).toEqual([{ contextKind: scope === "global" ? "globalConfig" : "registeredOperation", arguments: [L, "config", "set", `--${scope}`, "--", key, next] }]);
        wb(repoOf(o), ["config", "set", `--${scope}`, "--", key, next]);
        expect({ key, digests: Object.values(digests(f)) }).toEqual({ key, digests: Object.values(digests(o)) });
        for (const [label, digest] of Object.entries(digests(f))) if (label !== scope) expect({ key, label, digest }).toEqual({ key, label, digest: before[label]! });
      }
      expect(f.digests.included).toBe(digests(f).included!);
    });
  }, TIMEOUT_MS);
}

caseTest(TASK, "FR-064 and contract Δ2: an unset removes only that key, the counters count the keys, and a review without a run writes nothing (Cancel)", SHELL, async () => {
  const f = build("config-scopes");
  const o = build("config-scopes");
  await withConfig("t050-unset-cancel", f, async (service) => {
    const { r } = await open(service, f.repo);
    const before = digests(f);
    const from = service.runner.calls.length;
    const shown = await reviewed(service, r, save("local", [{ key: "pull.ff", value: "only" }]));
    expect(shown.plan).toEqual({ scope: "local", changes: [{ key: "pull.ff", value: "only", earlier: { origin: "file:.git/config", value: "false" } }] });
    expect(writes(service, from)).toEqual([]);
    expect(digests(f)).toEqual(before);
    const response = await run(service, r, save("local", [{ key: "user.email", value: null }, { key: "rebase.updateRefs", value: "false" }]));
    expect(outcome(response)).toEqual({ state: "succeeded", code: undefined });
    expect(response.result!.written).toEqual(["user.email", "rebase.updaterefs"]);
    for (const args of [["config", "unset", "--local", "--", "user.email"], ["config", "set", "--local", "--", "rebase.updaterefs", "false"]]) wb(repoOf(o), args);
    expect(digests(f)).toEqual(digests(o));
    const counters = (service.progress as { phase?: string; counters?: Record<string, number> }[]).filter((p) => p.phase === "config").map((p) => p.counters);
    expect(counters).toEqual(expect.arrayContaining([{ keyIndex: 1, keyCount: 2 }, { keyIndex: 2, keyCount: 2 }]));
  });
}, TIMEOUT_MS);

caseTest(TASK, "data-model §2: an entry set that changed after the review gives STALE_REVIEW and writes nothing", SHELL, async () => {
  const f = build("config-scopes");
  await withConfig("t050-stale", f, async (service) => {
    const { r } = await open(service, f.repo);
    const shown = await reviewed(service, r, save("local", [{ key: "user.name", value: "mine" }]));
    git(f, ["config", "set", "--local", "user.name", "theirs"]);
    const after = digests(f);
    const from = service.runner.calls.length;
    expect(outcome(await service.response(sendRun(service, r, shown.workbenchToken)))).toEqual({ state: "failed", code: "STALE_REVIEW" });
    expect(writes(service, from)).toEqual([]);
    expect(digests(f)).toEqual(after);
  });
}, TIMEOUT_MS);

caseTest(TASK, "research.md F22: a value that starts with - is written as that value", SHELL, async () => {
  const f = build("config-xdg");
  await withConfig("t050-dash", f, async (service) => {
    const { r } = await open(service, f.repo);
    const response = await run(service, r, save("local", [{ key: "user.name", value: "-value" }]));
    expect(outcome(response)).toEqual({ state: "succeeded", code: undefined });
    expect(git(f, ["config", "get", "--local", "user.name"])).toBe("-value\n");
  });
}, TIMEOUT_MS);

caseTest(TASK, "plan.md D11: Git's exit codes 1 and 5 name the key; 3 and 4 name the key through the double; a failure after a write reports the written key from a fresh listing", SHELL, async () => {
  const f = build("config-xdg");
  await withConfig("t050-exits", f, async (service) => {
    const { r } = await open(service, f.repo);
    // Exit 1: Git refuses a key with a newline in the subsection (git-config(1)).
    git(f, ["config", "set", "--local", "merge.tool", "bad\nname"]);
    let response = await run(service, r, save("local", [{ key: "mergetool.bad\nname.cmd", value: "x" }]));
    expect({ ...outcome(response), result: response.result }).toEqual({ state: "failed", code: "GIT_FAILED", result: { action: "config-save", scope: "local", written: [], failed: { key: "mergetool.bad\nname.cmd", exitCode: 1, reason: "invalid-key" }, outputTail: expect.any(String) } });
    git(f, ["config", "unset", "--local", "merge.tool"]);
    // Exit 5: the local file holds no `user.name` line to remove.
    response = await run(service, r, save("local", [{ key: "user.name", value: null }]));
    expect({ ...outcome(response), failed: response.result!.failed }).toEqual({ state: "failed", code: "GIT_FAILED", failed: { key: "user.name", exitCode: 5, reason: "nothing-set" } });
    // Exits 3 and 4: Git reads every configuration file before `config set`, so no real file gives them. The double replaces the process.
    for (const [exit, reason] of [[3, "invalid-file"], [4, "cannot-write"]] as const) {
      service.runner.inject.exit = (call) => (call.arguments[2] === "set" ? exit : undefined);
      response = await run(service, r, save("local", [{ key: "user.email", value: "e@invalid" }]));
      service.runner.inject.exit = undefined;
      expect({ ...outcome(response), failed: response.result!.failed, written: response.result!.written }).toEqual({ state: "failed", code: "GIT_FAILED", failed: { key: "user.email", exitCode: exit, reason }, written: [] });
    }
    // A held lock makes the second write exit 255, which git-config(1) does not document. The fresh listing names the first key.
    const lock = join(f.repo, ".git", "config.lock");
    const release = service.runner.holdStart((call) => call.arguments.includes("user.email"));
    const shown = await reviewed(service, r, save("local", [{ key: "user.name", value: "first" }, { key: "user.email", value: "second@invalid" }]));
    const from = service.runner.calls.length;
    const id = sendRun(service, r, shown.workbenchToken);
    await until(() => service.runner.calls.slice(from).some((c) => c.environmentPolicy === "integrate" && c.arguments.includes("user.email")), "the held user.email write");
    writeFileSync(lock, "");
    release();
    response = await service.response<SaveResult>(id);
    rmSync(lock);
    expect({ ...outcome(response), written: response.result!.written, failed: response.result!.failed }).toEqual({ state: "failed-with-effects", code: "FAILED_WITH_EFFECTS", written: ["user.name"], failed: { key: "user.email", exitCode: 255 } });
    expect(git(f, ["config", "get", "--local", "user.name"])).toBe("first\n");
    expect(git(f, ["config", "get", "--local", "user.email"], [1])).toBe("");
  });
}, TIMEOUT_MS);

caseTest(TASK, "contract Δ3: a key outside FR-060 and the effective tools, a repeated key, and a value that Git cannot read for the key type get INVALID_REQUEST before any write", SHELL, async () => {
  const f = build("config-scopes");
  const before = digests(f);
  await withConfig("t050-invalid", f, async (service) => {
    const { r } = await open(service, f.repo);
    const from = service.runner.calls.length;
    // The payload rules reject before any Git process. Only the listing names the effective tools, so a wrong tool key fails after it.
    for (const [changes, state] of [
      [[{ key: "core.fsmonitor", value: "x" }], "rejected"],
      [[{ key: "user.name", value: "a" }, { key: "User.Name", value: "b" }], "rejected"],
      [[{ key: "fetch.prune", value: "maybe" }], "rejected"],
      [[{ key: "pull.ff", value: "never" }], "rejected"],
      [[{ key: "mergetool.fixture.cmd", value: "x" }], "failed"],
    ] as const) {
      expect({ changes, ...outcome(await review(service, r, save("local", [...changes]))) }).toEqual({ changes, state, code: "INVALID_REQUEST" });
    }
    expect(writes(service, from)).toEqual([]);
  });
  expect(digests(f)).toEqual(before);
}, TIMEOUT_MS);

caseTest(TASK, "FR-067 and contract §7: the read and the save run no configured program, and no credential or URL user information reaches the result or the log", SHELL, async () => {
  const f = build("config-xdg");
  const editor = canary(f.root, "editor");
  const helper = canary(f.root, "helper");
  const tool = canary(f.root, "tool");
  for (const [key, v] of [["core.editor", editor.command], ["credential.helper", `!${helper.command}`], ["merge.tool", "canary"], ["mergetool.canary.cmd", tool.command], ["mergetool.canary.path", tool.command], ["commit.template", "https://user:secret@host.invalid/t"]]) git(f, ["config", "set", "--local", key!, v!]);
  await withConfig("t050-programs", f, async (service) => {
    const { r, gitInstallationId } = await open(service, f.repo);
    const s = await settings(service, gitInstallationId, f, r.repositoryId);
    expect(value(s, "commit.template").effective?.value).toBe("https://<redacted>@host.invalid/t");
    expect(value(s, "mergetool.canary.cmd").effective?.value).toBe(tool.command);
    const shown = await reviewed(service, r, save("local", [{ key: "commit.template", value: "t.txt" }, { key: "mergetool.canary.cmd", value: "true" }]));
    expect(shown.plan.changes[0]!.earlier).toEqual({ origin: "file:.git/config", value: "https://<redacted>@host.invalid/t" });
    const response = await service.response<SaveResult>(sendRun(service, r, shown.workbenchToken));
    expect(outcome(response)).toEqual({ state: "succeeded", code: undefined });
    expect(JSON.stringify([s, shown, response, service.log()])).not.toContain("secret");
  });
  for (const c of [editor, helper, tool]) expect({ log: c.log, exists: existsSync(c.log) }).toEqual({ log: c.log, exists: false });
}, TIMEOUT_MS);
