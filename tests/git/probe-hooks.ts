// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T280 probe, not a test. Run: `bun tests/git/probe-hooks.ts`. It compares a TypeScript derivation of hook registrations with `git hook list`.

import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configListArgs, hookListArgs, hooksPathArgs } from "../../src/git-service/commands";
import { printOrigin } from "../origin";
import { FIXTURE_GLOBAL_CONFIG, FIXTURE_HOME, FIXTURE_ROOT, fixtureDir, fixtureEnv, ownedGit, realGlobalConfigDigests, removeFixtureRoot } from "./fixture-root";
import { put } from "./fixtures";
import { GIT } from "./git-binary";

printOrigin("../../src/git-service/commands", import.meta.dir);
printOrigin("./fixture-root", import.meta.dir);
printOrigin("./fixtures", import.meta.dir);
printOrigin("./probe-hooks", import.meta.dir);

// hook-list.h at Git 49d759b (v2.56.0.windows.1), generated from githooks.adoc.
const EVENTS = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-commit",
  "pre-rebase", "post-checkout", "post-merge", "pre-push", "pre-receive", "update", "proc-receive", "post-receive", "post-update",
  "reference-transaction", "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate", "fsmonitor-watchman",
  "p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit", "post-index-change",
];
const KNOWN = new Set(EVENTS);
// Contract §5 probe deadline.
const DEADLINE_MS = 30_000;
const TIMING_RUNS = 10;

interface Result {
  exit: number | string;
  stdout: string;
  stderr: string;
}

if (GIT === null) throw new Error("Git executable absent");
const git = GIT;
const redact = (s: string) => s.replaceAll(FIXTURE_ROOT, "<root>").replaceAll(FIXTURE_ROOT.replaceAll("\\", "/"), "<root>");
let spawned = 0;

function spawn(dir: string, args: string[], extra: Record<string, string> = {}): Result {
  spawned++;
  const p = Bun.spawnSync([git, ...args], { cwd: dir, env: fixtureEnv({ LC_ALL: "C", ...extra }), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: DEADLINE_MS });
  return { exit: p.exitCode ?? `signal ${p.signalCode}`, stdout: p.stdout.toString(), stderr: redact(p.stderr.toString()) };
}

// Same parser as the trust test oracle: scope NUL origin NUL key, then LF and the value when it has one, then NUL.
interface Entry {
  scope: string;
  key: string;
  value: string | null;
}
function parseListing(out: string): Entry[] {
  const fields = out.split("\0");
  const entries: Entry[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const kv = fields[i + 2]!;
    const lf = kv.indexOf("\n");
    entries.push({ scope: fields[i]!, key: lf < 0 ? kv : kv.slice(0, lf), value: lf < 0 ? null : kv.slice(lf + 1) });
  }
  return entries;
}

// git_parse_maybe_bool (parse.c): the boolean words, then an integer with an optional unit. Other values give -1.
function maybeBool(v: string): number {
  const t = v.toLowerCase();
  if (t === "" || t === "false" || t === "no" || t === "off") return 0;
  if (t === "true" || t === "yes" || t === "on") return 1;
  const m = /^[+-]?(\d+)[kmg]?$/i.exec(v);
  return m ? (Number(m[1]) === 0 ? 0 : 1) : -1;
}

// string-list.c `unsorted_string_list_delete_item` moves the last item into the freed slot. So a re-added name does not keep the other names in order.
function swapRemove(list: { name: string }[], name: string): void {
  const i = list.findIndex((h) => h.name === name);
  if (i < 0) return;
  list[i] = list[list.length - 1]!;
  list.pop();
}

type Derived = { fatal: string } | { byEvent: (event: string) => string };

// hook.c `hook_config_lookup_all`, `build_hook_config_map`, `list_hooks`, and `find_hook` at Git 49d759b.
function derive(listing: Entry[], hooksDir: string): Derived {
  const commands = new Map<string, string>();
  const eventHooks = new Map<string, { name: string; scope: string }[]>();
  const disabled = new Set<string>();
  const parallel = new Set<string>();
  for (const { scope, key, value } of listing) {
    const first = key.indexOf(".");
    const last = key.lastIndexOf(".");
    if (key.slice(0, first) !== "hook" || first === last) continue;
    const name = key.slice(first + 1, last);
    const sub = key.slice(last + 1);
    if (value === null) return { fatal: `config_error_nonbool ${key}` };
    if (sub === "event") {
      if (value === "") {
        for (const list of eventHooks.values()) swapRemove(list, name);
        continue;
      }
      if (KNOWN.has(name)) return { fatal: `friendly-name ${name} collides with a known event` };
      const list = eventHooks.get(value) ?? [];
      swapRemove(list, name);
      list.push({ name, scope });
      eventHooks.set(value, list);
    } else if (sub === "command") commands.set(name, value);
    else if (sub === "enabled") {
      const b = maybeBool(value);
      if (b === 0) disabled.add(name);
      if (b === 1) disabled.delete(name);
    } else if (sub === "parallel" && maybeBool(value) >= 0) parallel.add(name);
  }
  const friendly = (n: string) => commands.has(n) || parallel.has(n) || [...eventHooks.values()].some((l) => l.some((h) => h.name === n));
  const disabledEvents = new Set([...disabled].filter((n) => !friendly(n)));
  for (const list of eventHooks.values()) for (const h of list) if (!commands.has(h.name) && !disabled.has(h.name)) return { fatal: `hook.${h.name}.command missing` };
  const byEvent = (event: string) => {
    let out = "";
    for (const h of eventHooks.get(event) ?? []) out += `${h.scope}\t${disabledEvents.has(event) ? "event-disabled\t" : disabled.has(h.name) ? "disabled\t" : ""}${h.name}\0`;
    // `find_hook` uses access(X_OK). Git for Windows drops X_OK (mingw_access), and so does libuv, so this matches on both platforms.
    // Git for Windows also tries the name plus STRIP_EXTENSION. This probe has no case for that suffix.
    try {
      accessSync(join(hooksDir, event), constants.X_OK);
      out += "hook from hookdir\0";
    } catch {}
    return out;
  };
  return { byEvent };
}

// Git runs the canaries through its POSIX shell, so paths use `/`.
const LOG = () => join(FIXTURE_ROOT, "canaries", "canary.log");
function canary(label: string): string {
  return put(FIXTURE_ROOT, `canaries/${label}.sh`, `#!/bin/sh\necho "${label}" >> '${LOG().replaceAll("\\", "/")}'\n`).replaceAll("\\", "/");
}
function hookFile(dir: string, name: string, label: string, mode = 0o755): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho "${label}" >> '${LOG().replaceAll("\\", "/")}'\n`);
  chmodSync(path, mode);
}
function canaryLines(): string[] {
  return existsSync(LOG()) ? readFileSync(LOG(), "utf8").split("\n").filter((l) => l !== "") : [];
}
function fired(run: () => void): string[] {
  const before = canaryLines().length;
  run();
  return [...new Set(canaryLines().slice(before))];
}

interface Case {
  name: string;
  dir: string;
  env: Record<string, string>;
  // Extra events outside hook-list.h. The oracle lists them with `--allow-unknown-hook-name`.
  unknown?: string[];
  // A control with `true` must run a canary. Other controls only record which canaries ran.
  controls?: [string, string[], boolean][];
}

// Each case gets its own repository and its own global file, so global keys stay in the case.
function newCase(name: string, commit = false): { dir: string; global: string; env: Record<string, string>; set: (where: string[], key: string, value: string) => void } {
  const base = fixtureDir(name);
  const dir = join(base, "repo");
  mkdirSync(dir);
  const global = put(base, "global.gitconfig", readFileSync(FIXTURE_GLOBAL_CONFIG, "utf8"));
  const env = { GIT_CONFIG_GLOBAL: global };
  ownedGit(git, FIXTURE_ROOT, dir, ["init", "-q"], { env });
  if (commit) {
    put(dir, "f.txt", "f\n");
    ownedGit(git, FIXTURE_ROOT, dir, ["add", "f.txt"], { env });
    ownedGit(git, FIXTURE_ROOT, dir, ["commit", "-q", "-m", "base"], { env });
  }
  const set = (where: string[], key: string, value: string) => void ownedGit(git, FIXTURE_ROOT, dir, ["config", ...where, "--add", key, value], { env });
  return { dir, global, env, set };
}
const LOCAL = ["--local"];

const before = realGlobalConfigDigests(git);
mkdirSync(FIXTURE_ROOT);
console.log(`FIXTURE_ROOT ${FIXTURE_ROOT}`);
mkdirSync(join(FIXTURE_HOME, ".config"), { recursive: true });
writeFileSync(FIXTURE_GLOBAL_CONFIG, "[user]\n\tname = Arbareto Fixture\n\temail = fixture@arbareto.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n");
let failures = 0;
try {
  console.log(`GIT_VERSION ${spawn(FIXTURE_ROOT, ["version"]).stdout.trim()}`);
  const cases: Case[] = [];

  // Event set and arity.
  {
    const c = newCase("events");
    const rejected = EVENTS.filter((e) => /unknown hook event/.test(spawn(c.dir, hookListArgs(e)).stderr));
    console.log(`EVENTS accepted=${EVENTS.length - rejected.length}/${EVENTS.length} rejected=[${rejected.join(",")}]`);
    const unknown = spawn(c.dir, ["--no-lazy-fetch", "--no-optional-locks", "hook", "list", "-z", "--show-scope", "custom-event"]);
    console.log(`EVENTS unknown name exit=${unknown.exit} stderr=${JSON.stringify(unknown.stderr)}`);
    const two = spawn(c.dir, ["--no-lazy-fetch", "--no-optional-locks", "hook", "list", "-z", "--show-scope", "pre-commit", "commit-msg"]);
    console.log(`EVENTS two names exit=${two.exit} stderr=${JSON.stringify(two.stderr.split("\n")[0])}`);
    const none = spawn(c.dir, ["--no-lazy-fetch", "--no-optional-locks", "hook", "list", "-z", "--show-scope"]);
    console.log(`EVENTS no name exit=${none.exit}`);
    if (rejected.length !== 0 || two.exit === 0) failures++;
    cases.push({ name: "fresh repository, sample hooks only", dir: c.dir, env: c.env });
  }

  {
    const c = newCase("traditional");
    const hooks = join(c.dir, ".git", "hooks");
    for (const e of EVENTS) hookFile(hooks, e, `hookdir-${e}`);
    hookFile(hooks, "not-an-event", "hookdir-not-an-event");
    cases.push({ name: "every traditional name in .git/hooks, plus samples and an unknown name", dir: c.dir, env: c.env, controls: [["hook run pre-commit", ["hook", "run", "pre-commit"], true]] });
  }

  {
    const c = newCase("configured");
    const g = ["--file", c.global];
    c.set(g, "hook.g1.command", `'${canary("cfg-g1")}'`);
    c.set(g, "hook.g1.event", "pre-commit");
    c.set(g, "hook.shared.command", `'${canary("cfg-shared-global")}'`);
    c.set(g, "hook.shared.event", "pre-commit");
    c.set(g, "hook.shared.event", "commit-msg");
    c.set(g, "hook.cmdglobal.command", `'${canary("cfg-cmdglobal")}'`);
    c.set(g, "hook.evtglobal.event", "post-commit");
    c.set(g, "hook.r.command", `'${canary("cfg-r")}'`);
    c.set(g, "hook.r.event", "pre-push");
    c.set(g, "hook.jobs", "2");
    c.set(LOCAL, "hook.l1.command", `'${canary("cfg-l1")}'`);
    c.set(LOCAL, "hook.l1.event", "pre-commit");
    c.set(LOCAL, "hook.l1.event", "commit-msg");
    c.set(LOCAL, "hook.l1.parallel", "true");
    c.set(LOCAL, "hook.g1.event", "pre-commit");
    c.set(LOCAL, "hook.shared.command", `'${canary("cfg-shared-local")}'`);
    c.set(LOCAL, "hook.cmdglobal.event", "post-commit");
    c.set(LOCAL, "hook.evtglobal.command", `'${canary("cfg-evtglobal")}'`);
    c.set(LOCAL, "hook.r.event", "");
    c.set(LOCAL, "hook.r.event", "post-merge");
    c.set(LOCAL, "hook.Mixed.Case.Name.command", `'${canary("cfg-mixed")}'`);
    c.set(LOCAL, "hook.Mixed.Case.Name.event", "post-commit");
    c.set(LOCAL, "hook.u.command", `'${canary("cfg-u")}'`);
    c.set(LOCAL, "hook.u.event", "custom-event");
    c.set(LOCAL, "hook.pre-commit.jobs", "2");
    c.set(LOCAL, "extensions.worktreeConfig", "true");
    c.set(["--worktree"], "hook.w.command", `'${canary("cfg-w")}'`);
    c.set(["--worktree"], "hook.w.event", "pre-commit");
    hookFile(join(c.dir, ".git", "hooks"), "pre-commit", "hookdir-pre-commit");
    const command = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "hook.c1.command", GIT_CONFIG_VALUE_0: `'${canary("cfg-c1")}'`, GIT_CONFIG_KEY_1: "hook.c1.event", GIT_CONFIG_VALUE_1: "pre-commit" };
    cases.push({ name: "configured hooks from global, local, worktree, and command scopes", dir: c.dir, env: { ...c.env, ...command }, unknown: ["custom-event"], controls: [["hook run pre-commit", ["hook", "run", "pre-commit"], true]] });
  }

  {
    const c = newCase("disabled");
    const g = ["--file", c.global];
    for (const [n, v] of [["d1", "false"], ["d2", "0"], ["d3", "off"]] as const) {
      c.set(LOCAL, `hook.${n}.command`, `'${canary(`cfg-${n}`)}'`);
      c.set(LOCAL, `hook.${n}.event`, "pre-commit");
      c.set(LOCAL, `hook.${n}.enabled`, v);
    }
    c.set(LOCAL, "hook.d4.event", "pre-commit");
    c.set(LOCAL, "hook.d4.enabled", "false");
    c.set(g, "hook.d5.command", `'${canary("cfg-d5")}'`);
    c.set(g, "hook.d5.event", "pre-commit");
    c.set(g, "hook.d5.enabled", "false");
    c.set(LOCAL, "hook.d5.enabled", "true");
    c.set(LOCAL, "hook.e1.command", `'${canary("cfg-e1")}'`);
    c.set(LOCAL, "hook.e1.event", "pre-push");
    c.set(LOCAL, "hook.e2.command", `'${canary("cfg-e2")}'`);
    c.set(LOCAL, "hook.e2.event", "pre-push");
    c.set(LOCAL, "hook.e2.enabled", "false");
    c.set(LOCAL, "hook.pre-push.enabled", "false");
    c.set(LOCAL, "hook.post-merge.enabled", "false");
    const hooks = join(c.dir, ".git", "hooks");
    hookFile(hooks, "pre-push", "hookdir-pre-push");
    hookFile(hooks, "post-merge", "hookdir-post-merge");
    cases.push({
      name: "disabled registrations: per hook, without a command, re-enabled, and per event",
      dir: c.dir,
      env: c.env,
      controls: [
        ["hook run pre-commit", ["hook", "run", "pre-commit"], true],
        ["hook run pre-push", ["hook", "run", "pre-push", "--", "origin", "url"], false],
        ["hook run post-merge", ["hook", "run", "post-merge", "--", "0"], false],
      ],
    });
  }

  {
    const c = newCase("global-absolute");
    const shared = join(FIXTURE_ROOT, "global-absolute", "shared-hooks");
    hookFile(shared, "pre-commit", "abs-pre-commit");
    hookFile(shared, "post-checkout", "abs-post-checkout");
    hookFile(join(c.dir, ".git", "hooks"), "commit-msg", "hookdir-commit-msg");
    c.set(["--file", c.global], "core.hooksPath", shared.replaceAll("\\", "/"));
    cases.push({ name: "global absolute core.hooksPath", dir: c.dir, env: c.env, controls: [["hook run pre-commit", ["hook", "run", "pre-commit"], true]] });
  }

  {
    const c = newCase("global-relative");
    hookFile(join(c.dir, ".githooks"), "pre-commit", "rel-pre-commit");
    hookFile(join(c.dir, ".githooks"), "commit-msg", "rel-commit-msg");
    mkdirSync(join(c.dir, "sub"));
    put(c.dir, "sub/s.txt", "s\n");
    ownedGit(git, FIXTURE_ROOT, c.dir, ["add", "."], { env: c.env });
    ownedGit(git, FIXTURE_ROOT, c.dir, ["commit", "-q", "-m", "base"], { env: c.env });
    const wt = join(FIXTURE_ROOT, "global-relative", "wt");
    ownedGit(git, FIXTURE_ROOT, c.dir, ["worktree", "add", "-q", wt], { env: c.env });
    hookFile(join(wt, ".githooks"), "post-commit", "rel-wt-post-commit");
    hookFile(join(c.dir, ".git", "hooks"), "post-merge", "hookdir-post-merge");
    c.set(["--file", c.global], "core.hooksPath", ".githooks");
    const controls: [string, string[], boolean][] = [["hook run pre-commit", ["hook", "run", "pre-commit"], true]];
    cases.push({ name: "global relative core.hooksPath=.githooks, at the worktree root", dir: c.dir, env: c.env, controls });
    cases.push({ name: "global relative core.hooksPath=.githooks, in a subdirectory", dir: join(c.dir, "sub"), env: c.env, controls });
    cases.push({ name: "global relative core.hooksPath=.githooks, in a linked worktree", dir: wt, env: c.env, controls: [["hook run post-commit", ["hook", "run", "post-commit"], true]] });
  }

  {
    const c = newCase("local-relative");
    hookFile(join(c.dir, "hooks-local"), "pre-commit", "localrel-pre-commit");
    c.set(LOCAL, "core.hooksPath", "hooks-local");
    cases.push({ name: "local relative core.hooksPath=hooks-local", dir: c.dir, env: c.env });
  }

  {
    const c = newCase("edge-entries");
    const hooks = join(c.dir, ".git", "hooks");
    mkdirSync(join(hooks, "pre-commit"));
    hookFile(hooks, "commit-msg", "hookdir-commit-msg-0644", 0o644);
    cases.push({ name: "hooks folder: a folder named pre-commit, a commit-msg file with mode 0644", dir: c.dir, env: c.env });
  }

  {
    const c = newCase("fatal-missing-command");
    c.set(LOCAL, "hook.orphan.event", "pre-commit");
    cases.push({ name: "fatal: hook.orphan.event without a command", dir: c.dir, env: c.env });
  }

  {
    const c = newCase("fatal-event-name");
    c.set(LOCAL, "hook.pre-commit.command", `'${canary("cfg-event-name")}'`);
    c.set(LOCAL, "hook.pre-commit.event", "pre-commit");
    cases.push({ name: "fatal: friendly name equals the event name pre-commit", dir: c.dir, env: c.env });
  }

  const rows: string[] = [];
  let lastDerived: Case | null = null;
  for (const c of cases) {
    let derived: Derived = { fatal: "not run" };
    let derivedProcesses = 0;
    const derivationFired = fired(() => {
      const start = spawned;
      const listing = spawn(c.dir, configListArgs(), c.env);
      const hooksPath = spawn(c.dir, hooksPathArgs(), c.env);
      derivedProcesses = spawned - start;
      if (listing.exit !== 0 || hooksPath.exit !== 0) throw new Error(`${c.name}: listing exit ${listing.exit}, hooks path exit ${hooksPath.exit}: ${listing.stderr}${hooksPath.stderr}`);
      console.log(`CASE ${c.name}`);
      console.log(`  HOOKS_PATH ${JSON.stringify(redact(hooksPath.stdout.trimEnd()))}`);
      derived = derive(parseListing(listing.stdout), resolve(c.dir, hooksPath.stdout.replace(/\n$/, "")));
    });
    const events = [...EVENTS, ...(c.unknown ?? [])];
    const oracle = new Map<string, Result>();
    const start = spawned;
    const oracleFired = fired(() => {
      for (const e of events) oracle.set(e, spawn(c.dir, KNOWN.has(e) ? hookListArgs(e) : ["--no-lazy-fetch", "--no-optional-locks", "hook", "list", "--allow-unknown-hook-name", "-z", "--show-scope", e], c.env));
    });
    const oracleProcesses = spawned - start;
    const d = derived as Derived;
    let differing: string[] = [];
    let listed = 0;
    for (const e of events) {
      const o = oracle.get(e)!;
      if ("fatal" in d) {
        if (o.exit !== 128) differing.push(e);
        continue;
      }
      const out = d.byEvent(e);
      const expectedExit = out === "" ? 1 : 0;
      if (o.stdout !== out || o.exit !== expectedExit) differing.push(e);
      if (out !== "") {
        listed++;
        console.log(`  EVENT ${e} exit=${o.exit} oracle=${JSON.stringify(o.stdout)} derived=${JSON.stringify(out)}`);
      }
    }
    if ("fatal" in d) console.log(`  FATAL derived=${JSON.stringify(d.fatal)} oracle exits=${[...new Set([...oracle.values()].map((r) => r.exit))].join("/")} stderr=${JSON.stringify(oracle.get("pre-commit")!.stderr.trim())}`);
    const warnings = [...new Set([...oracle.values()].flatMap((r) => r.stderr.split("\n")).filter((l) => l.startsWith("warning:") && !l.includes("no hooks found")))];
    for (const w of warnings) console.log(`  STDERR ${w}`);
    for (const e of differing) console.log(`  DIFFERS ${e} oracle exit=${oracle.get(e)!.exit} stdout=${JSON.stringify(oracle.get(e)!.stdout)} stderr=${JSON.stringify(oracle.get(e)!.stderr)}`);
    const equal = differing.length === 0;
    if (!equal || derivationFired.length > 0 || oracleFired.length > 0) failures++;
    console.log(`  RESULT equal=${equal} eventsWithHooks=${"fatal" in d ? "fatal" : listed} canaries derivation=[${derivationFired.join(",")}] oracle=[${oracleFired.join(",")}] processes derivation=${derivedProcesses} oracle=${oracleProcesses}`);
    rows.push(`| ${c.name} | ${"fatal" in d ? "all exit 128" : listed} | ${equal ? "equal" : `differs: ${differing.join(", ")}`} | ${derivationFired.join(", ") || "none"} | ${oracleFired.join(", ") || "none"} | ${derivedProcesses} | ${oracleProcesses} |`);
    for (const [label, args, mustFire] of c.controls ?? []) {
      let r: Result = { exit: "", stdout: "", stderr: "" };
      const names = fired(() => (r = spawn(c.dir, ["--no-lazy-fetch", ...args], c.env)));
      console.log(`  CONTROL ${label} exit=${r.exit} canaries=[${names.join(",")}]`);
      if (mustFire && names.length === 0) failures++;
    }
    if (c.unknown) lastDerived = c;
  }

  console.log("TABLE | Case | Events with hooks | Derivation against oracle | Derivation canaries | Oracle canaries | Derivation processes | Oracle processes |");
  console.log("TABLE | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of rows) console.log(`TABLE ${row}`);

  // Informal timings, not qualification evidence.
  if (lastDerived) {
    const c = lastDerived;
    const median = (run: () => void) => {
      const times: number[] = [];
      for (let i = 0; i < TIMING_RUNS; i++) {
        const t = performance.now();
        run();
        times.push(performance.now() - t);
      }
      times.sort((a, b) => a - b);
      return Math.round(((times[TIMING_RUNS / 2 - 1]! + times[TIMING_RUNS / 2]!) / 2) * 10) / 10;
    };
    console.log(`TIMING informal configured case, ${EVENTS.length} hook list runs, median of ${TIMING_RUNS}: ${median(() => EVENTS.forEach((e) => spawn(c.dir, hookListArgs(e), c.env)))} ms`);
    console.log(`TIMING informal configured case, config list plus --git-path hooks, median of ${TIMING_RUNS}: ${median(() => [configListArgs(), hooksPathArgs()].forEach((a) => spawn(c.dir, a, c.env)))} ms`);
  }
  console.log(`VERDICT derivation ${failures === 0 ? "equals the oracle in every case" : "differs"} (${failures} failing cases or controls); k=${EVENTS.length}`);
} finally {
  removeFixtureRoot();
  const after = realGlobalConfigDigests(git);
  if (after.join("\n") !== before.join("\n")) throw new Error("the real global Git configuration changed");
  console.log("GLOBAL_CONFIG unchanged");
}
