// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T283 probe, not a test. Run: `bun tests/git/probe-discovery.ts`. It compares the separate T082 `rev-parse` calls with one combined call.

import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { printOrigin } from "../origin";
import { FIXTURE_GLOBAL_CONFIG, FIXTURE_HOME, FIXTURE_ROOT, fixtureEnv, ownedGit, realGlobalConfigDigests, removeFixtureRoot, removeTree } from "./fixture-root";
import { buildF07, buildF08, buildF15, buildF18, put } from "./fixtures";
import { GIT } from "./git-binary";

printOrigin("./fixture-root", import.meta.dir);
printOrigin("./fixtures", import.meta.dir);
printOrigin("./probe-discovery", import.meta.dir);

// T082 order. The first entry is one call. The combined form is one call with every option in this order.
const SEPARATE = [["--is-bare-repository", "--is-inside-git-dir"], ["--show-toplevel"], ["--absolute-git-dir"], ["--git-common-dir"], ["--git-path", "index"], ["--show-object-format"], ["--show-ref-format"]];
const COMBINED = SEPARATE.flat();
// The two-call form: the flags call, then one call with the remaining options when the flags call gives no refusal.
const REMAINING = SEPARATE.slice(1).flat();
const TIMING_RUNS = 20;
// Contract §5 probe deadline.
const DEADLINE_MS = 30_000;
const OTHER_OWNER = { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" };
const DUBIOUS_PREFIX = "fatal: detected dubious ownership in repository at '";
const NOT_A_REPOSITORY_PREFIX = "fatal: not a git repository (or any";
// githooks.adoc at the R2 Git revision lists these 28 names.
const HOOKS = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-commit",
  "pre-rebase", "post-checkout", "post-merge", "pre-push", "pre-receive", "update", "proc-receive", "post-receive", "post-update",
  "reference-transaction", "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate", "fsmonitor-watchman",
  "p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit", "post-index-change",
];

interface Result {
  exit: number | string;
  stdout: string;
  stderr: string;
}

if (GIT === null) throw new Error("Git executable absent");
const git = GIT;
const redact = (s: string) => s.replaceAll(FIXTURE_ROOT, "<root>").replaceAll(FIXTURE_ROOT.replaceAll("\\", "/"), "<root>");

function spawn(dir: string, args: string[], extra: Record<string, string> = {}): Result {
  try {
    const p = Bun.spawnSync([git, "--no-lazy-fetch", ...args], { cwd: dir, env: fixtureEnv({ LC_ALL: "C", ...extra }), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: DEADLINE_MS });
    return { exit: p.exitCode ?? `signal ${p.signalCode}`, stdout: redact(p.stdout.toString()), stderr: redact(p.stderr.toString()) };
  } catch (e) {
    return { exit: `spawn-failed ${(e as { code?: string }).code ?? "error"}`, stdout: "", stderr: "" };
  }
}

// Contract §6 classification of the first query output, or of the combined output.
function classify(r: Result): string {
  if (r.exit === 0) {
    const [bare, inside] = r.stdout.split("\n");
    return bare === "true" || inside === "true" ? "UNSUPPORTED_REPOSITORY" : "ok";
  }
  if (r.exit === 128 && r.stderr.split("\n").some((l) => l.startsWith(DUBIOUS_PREFIX))) return "DUBIOUS_OWNERSHIP";
  if (r.exit === 128 && r.stderr.startsWith(NOT_A_REPOSITORY_PREFIX)) return "NOT_A_REPOSITORY";
  return "REPOSITORY_UNAVAILABLE";
}

// A spawn failure starts no Git process.
const started = (rs: Result[]) => rs.filter((r) => typeof r.exit === "number" || r.exit.startsWith("signal")).length;
const joined = (rs: Result[], key: "stdout" | "stderr") => rs.map((r) => r[key]).join("");
const exitSet = (rs: Result[]) => [...new Set(rs.map((r) => String(r.exit)))].join("/");

// T082 rules: the flags call decides a refusal. A later failure gives REPOSITORY_UNAVAILABLE.
function sequenceClass(rs: Result[]): string {
  const first = classify(rs[0]!);
  if (first !== "ok") return first;
  return rs.slice(1).every((r) => r.exit === 0) ? "ok" : "REPOSITORY_UNAVAILABLE";
}

function twoCall(dir: string, extra?: Record<string, string>): Result[] {
  const flags = spawn(dir, ["rev-parse", ...SEPARATE[0]!], extra);
  return classify(flags) === "ok" ? [flags, spawn(dir, ["rev-parse", ...REMAINING], extra)] : [flags];
}

function separateSequence(dir: string, extra?: Record<string, string>): Result[] {
  const flags = spawn(dir, ["rev-parse", ...SEPARATE[0]!], extra);
  return classify(flags) === "ok" ? [flags, ...SEPARATE.slice(1).map((opts) => spawn(dir, ["rev-parse", ...opts], extra))] : [flags];
}

function medianMs(run: () => void): number {
  const times: number[] = [];
  for (let i = 0; i < TIMING_RUNS; i++) {
    const t = performance.now();
    run();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return Math.round(((times[TIMING_RUNS / 2 - 1]! + times[TIMING_RUNS / 2]!) / 2) * 10) / 10;
}

// Git runs the canaries through its POSIX shell, so paths use `/`. Each run appends one line with its name.
function installCanaries(root: string, repo: string): void {
  const log = join(root, "canaries", "canary.log").replaceAll("\\", "/");
  const program = (name: string) => put(root, `canaries/${name}.sh`, `#!/bin/sh\necho "${name} $*" >> '${log}'\nexit 1\n`).replaceAll("\\", "/");
  // Git starts the signing programs without a shell, so their paths stay unquoted. The fixture root holds no space.
  const script = (name: string) => `'${program(name)}'`;
  const tracked = ownedGit(git, FIXTURE_ROOT, repo, ["ls-files", "-z"]).toString().split("\0").filter((p) => p !== "");
  const gitPath = (name: string) => resolve(repo, ownedGit(git, FIXTURE_ROOT, repo, ["rev-parse", "--git-path", name]).toString().trim());
  const config: [string, string][] = [
    ["core.fsmonitor", script("fsmonitor")],
    ["filter.cc.clean", script("filter-clean")],
    ["filter.cc.smudge", script("filter-smudge")],
    ["filter.pp.process", script("filter-process")],
    ["diff.tc.textconv", script("textconv")],
    ["gpg.program", program("gpg-program")],
    ["gpg.openpgp.program", program("gpg-openpgp-program")],
    ["gpg.x509.program", program("gpg-x509-program")],
    ["gpg.ssh.program", program("gpg-ssh-program")],
    ["gpg.ssh.defaultKeyCommand", script("gpg-ssh-defaultKeyCommand")],
    ["hook.canary.command", script("hook-configured")],
    ["hook.canary.event", "pre-commit"],
  ];
  for (const [key, value] of config) ownedGit(git, FIXTURE_ROOT, repo, ["config", key, value]);
  const attributes = gitPath("info/attributes");
  mkdirSync(dirname(attributes), { recursive: true });
  writeFileSync(attributes, "* filter=cc diff=tc\n*.md filter=pp\n");
  const hooks = gitPath("hooks");
  mkdirSync(hooks, { recursive: true });
  for (const name of HOOKS) writeFileSync(join(hooks, name), `#!/bin/sh\necho "hook-${name} $*" >> '${log}'\nexit 1\n`);
  // Fixtures normalize file times to 2026-01-01, so a later time makes each tracked file stat-dirty.
  const now = Date.now() / 1000;
  for (const p of tracked) if (existsSync(join(repo, p))) utimesSync(join(repo, p), now, now);
}

function canaryLines(root: string): string[] {
  const log = join(root, "canaries", "canary.log");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l !== "") : [];
}

function fired(root: string, run: () => void): string[] {
  const before = canaryLines(root).length;
  run();
  return [...new Set(canaryLines(root).slice(before).map((l) => l.split(" ")[0]!))];
}

interface Case {
  name: string;
  root: string;
  dir: string;
  extra?: Record<string, string>;
}

const before = realGlobalConfigDigests(git);
mkdirSync(FIXTURE_ROOT);
console.log(`FIXTURE_ROOT ${FIXTURE_ROOT}`);
mkdirSync(join(FIXTURE_HOME, ".config"), { recursive: true });
writeFileSync(FIXTURE_GLOBAL_CONFIG, "[user]\n\tname = Arbareto Fixture\n\temail = fixture@arbareto.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n");
let verdictFailures = 0;
try {
  console.log(`GIT_VERSION ${spawn(FIXTURE_ROOT, ["version"]).stdout.trim()}`);
  const f07 = buildF07(git, "t283-f07");
  const f08 = buildF08(git, "t283-f08-sha256", "sha256");
  const f18 = buildF18(git, "t283-f18-reftable", "reftable");
  const f15 = buildF15(git, "t283-f15");
  for (const repo of ["main", "separate", "bare.git", "super", "super/sub"]) installCanaries(f07.root, join(f07.root, repo));
  installCanaries(f08.root, join(f08.root, "repo"));
  installCanaries(f18.root, join(f18.root, "repo"));
  const hostile = (f15.facts.notes.hostile as string[]).map((h) => join(f15.root, "hostile", h));
  for (const repo of [join(f15.root, "repo"), ...hostile]) installCanaries(f15.root, repo);
  const removed = join(f15.root, "removed");
  mkdirSync(removed);
  removeTree(removed);

  const cases: Case[] = [
    { name: "ordinary (F07 main)", root: f07.root, dir: join(f07.root, "main") },
    { name: "linked worktree (F07 wt-a)", root: f07.root, dir: join(f07.root, "wt-a") },
    { name: "separate Git directory (F07 separate)", root: f07.root, dir: join(f07.root, "separate") },
    { name: "bare (F07 bare.git)", root: f07.root, dir: join(f07.root, "bare.git") },
    { name: "administration folder (F07 main/.git)", root: f07.root, dir: join(f07.root, "main", ".git") },
    { name: "submodule opened directly (F07 super/sub)", root: f07.root, dir: join(f07.root, "super", "sub") },
    { name: "missing gitdir target (F07 broken)", root: f07.root, dir: join(f07.root, "broken") },
    { name: "SHA-256 (F08 sha256)", root: f08.root, dir: join(f08.root, "repo") },
    { name: "reftable (F18 reftable repo)", root: f18.root, dir: join(f18.root, "repo") },
    { name: "reftable linked worktree (F18 reftable wt)", root: f18.root, dir: join(f18.root, "wt") },
    { name: "plain folder (F15 plain)", root: f15.root, dir: join(f15.root, "plain") },
    { name: "removed path (F15)", root: f15.root, dir: removed },
    { name: "F15 repo", root: f15.root, dir: join(f15.root, "repo") },
    { name: "dubious ownership (F15 repo)", root: f15.root, dir: join(f15.root, "repo"), extra: OTHER_OWNER },
    ...hostile.map((dir, i) => ({ name: `dubious ownership (F15 hostile ${i + 1})`, root: f15.root, dir, extra: OTHER_OWNER })),
  ];

  const rows: string[] = [];
  const twoRows: string[] = [];
  let twoCallFailures = 0;
  for (const c of cases) {
    let separate: Result[] = [];
    let combined: Result = { exit: "", stdout: "", stderr: "" };
    const sepFired = fired(c.root, () => (separate = SEPARATE.map((opts) => spawn(c.dir, ["rev-parse", ...opts], c.extra))));
    const combFired = fired(c.root, () => (combined = spawn(c.dir, ["rev-parse", ...COMBINED], c.extra)));
    const sepClass = classify(separate[0]!);
    const combClass = classify(combined);
    const sepOut = separate.map((r) => r.stdout).join("");
    const success = sepClass === "ok";
    const outputEqual = sepOut === combined.stdout;
    const exitEqual = separate.every((r) => r.exit === combined.exit);
    const stderrEqual = separate.every((r) => r.stderr === combined.stderr);
    const ok = sepFired.length === 0 && combFired.length === 0 && (success ? outputEqual && exitEqual && combClass === "ok" : combClass === sepClass);
    if (!ok) verdictFailures++;
    console.log(`CASE ${c.name}`);
    separate.forEach((r, i) => console.log(`  SEPARATE ${SEPARATE[i]!.join(" ")} exit=${r.exit} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`));
    console.log(`  COMBINED exit=${combined.exit} stdout=${JSON.stringify(combined.stdout)} stderr=${JSON.stringify(combined.stderr)}`);
    console.log(`  CANARIES separate=[${sepFired.join(",")}] combined=[${combFired.join(",")}]`);
    console.log(`  CLASS separate=${sepClass} combined=${combClass} outputEqual=${outputEqual} exitEqual=${exitEqual} stderrEqual=${stderrEqual} allowed=${ok}`);
    // T082 runs the later separate calls only after a flags call without refusal.
    const t082 = classify(separate[0]!) === "ok" ? separate : [separate[0]!];
    let two: Result[] = [];
    const twoFired = fired(c.root, () => (two = twoCall(c.dir, c.extra)));
    const t082Class = sequenceClass(t082);
    const twoClass = sequenceClass(two);
    const twoOutputEqual = joined(t082, "stdout") === joined(two, "stdout");
    const twoExitEqual = exitSet(t082) === exitSet(two);
    const twoStderrEqual = joined(t082, "stderr") === joined(two, "stderr");
    const twoOk = sepFired.length === 0 && twoFired.length === 0 && twoOutputEqual && twoExitEqual && twoStderrEqual && twoClass === t082Class;
    if (!twoOk) twoCallFailures++;
    two.forEach((r, i) => console.log(`  TWO-CALL ${i === 0 ? SEPARATE[0]!.join(" ") : REMAINING.join(" ")} exit=${r.exit} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`));
    console.log(`  TWO-CALL class=${twoClass} t082Class=${t082Class} outputEqual=${twoOutputEqual} exitEqual=${twoExitEqual} stderrEqual=${twoStderrEqual} canaries=[${twoFired.join(",")}] processes separate=${started(t082)} combined=${started([combined])} two-call=${started(two)} allowed=${twoOk}`);
    twoRows.push(`| ${c.name} | ${exitSet(t082)} | ${exitSet(two)} | ${twoOutputEqual ? "equal" : "differs"} | ${twoStderrEqual ? "equal" : "differs"} | ${t082Class} | ${twoClass} | ${twoFired.join(", ") || "none"} | ${started(t082)} | ${started([combined])} | ${started(two)} |`);
    const exits = [...new Set(separate.map((r) => String(r.exit)))].join("/");
    rows.push(`| ${c.name} | ${exits} | ${combined.exit} | ${outputEqual ? "equal" : "differs"} | ${stderrEqual ? "equal" : "differs"} | ${sepClass} | ${combClass} | ${sepFired.join(", ") || "none"} | ${combFired.join(", ") || "none"} |`);
  }

  // Control: these commands must run the canaries in the ordinary repository.
  const main = join(f07.root, "main");
  const controls: [string, string[]][] = [
    ["status", ["status", "--porcelain"]],
    ["rev-parse --shared-index-path", ["rev-parse", "--shared-index-path"]],
    ["show --textconv HEAD", ["show", "--textconv", "HEAD"]],
    ["hook run pre-commit", ["hook", "run", "pre-commit"]],
    ["hash-object --stdin --path=control.md", ["hash-object", "--stdin", "--path=control.md"]],
    ["tag -s", ["tag", "-s", "-m", "control", "control"]],
  ];
  for (const [label, args] of controls) {
    let r: Result = { exit: "", stdout: "", stderr: "" };
    const names = fired(f07.root, () => (r = spawn(main, args)));
    console.log(`CONTROL ${label} exit=${r.exit} canaries=[${names.join(",")}] stderr=${JSON.stringify(r.stderr.slice(0, 200))}`);
    if (names.length === 0) verdictFailures++;
  }

  console.log("TABLE | Case | Separate exits | Combined exit | Output | Stderr | Separate class | Combined class | Separate canaries | Combined canaries |");
  console.log("TABLE | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of rows) console.log(`TABLE ${row}`);
  console.log("TWO_CALL_TABLE | Case | Separate exits (T082) | Two-call exits | Output | Stderr | Separate class | Two-call class | Two-call canaries | Separate processes | Combined processes | Two-call processes |");
  console.log("TWO_CALL_TABLE | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of twoRows) console.log(`TWO_CALL_TABLE ${row}`);
  // Informal timings, not qualification evidence.
  const timed: [string, () => void][] = [
    ["separate", () => separateSequence(main)],
    ["combined", () => spawn(main, ["rev-parse", ...COMBINED])],
    ["two-call", () => twoCall(main)],
  ];
  for (const [label, run] of timed) console.log(`TIMING informal ordinary (F07 main) ${label} median of ${TIMING_RUNS} runs: ${medianMs(run)} ms`);
  console.log(`VERDICT two-call form ${twoCallFailures === 0 ? "allowed" : "not allowed"} (${twoCallFailures} failing cases)`);
  console.log(`VERDICT combined form ${verdictFailures === 0 ? "allowed" : "not allowed"} (${verdictFailures} failing cases or controls)`);
} finally {
  removeFixtureRoot();
  const after = realGlobalConfigDigests(git);
  if (after.join("\n") !== before.join("\n")) throw new Error("the real global Git configuration changed");
  console.log("GLOBAL_CONFIG unchanged");
}
