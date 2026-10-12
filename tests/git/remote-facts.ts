// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The Git facts (a) to (l) of plan.md P0.2 (tasks.md T005, T006). Each fact runs on a `GitHost`, so Windows and WSL share the cases.
// Exit codes, porcelain fields, and repository reads decide each fact, never message text. A failed fact is a finding: it prints `match=false` and the test stays green.

import {
  buildCounts,
  buildFetchAll,
  buildFetchFlags,
  buildHooks,
  buildMany,
  buildMergeConflict,
  buildPull,
  buildPush,
  buildRebaseSkip,
  buildSubmodule,
  FETCH_ALL_REMOTES,
  gitOut,
  gitPaths,
  gitRun,
  hexLength,
  leftRight,
  MANY_BRANCHES,
  markers,
  PULL_ROWS,
  pullRowCopy,
  PUSH_VARIANTS,
  pushVariant,
  refMap,
  revParse,
  stageEntries,
  type GitHost,
  type GitResult,
  type PullDecision,
  type PullRow,
} from "./remote-fixtures";

export interface Observation {
  fact: string;
  expected: unknown;
  observed: unknown;
  match: boolean;
}

export interface Fact {
  id: string;
  title: string;
  run(h: GitHost): Observation[];
}

// JSON without spaces, so each `key=value` field of an OBSERVATION line is one token.
const token = (v: unknown): string => JSON.stringify(v ?? null).replaceAll(" ", "\\u0020");

export function observationLine(task: string, version: string, o: Observation): string {
  return `OBSERVATION ${task} ${o.fact} expected=${token(o.expected)} observed=${token(o.observed)} match=${o.match} git=${version}`;
}

export function gitVersion(h: GitHost): string {
  const out = gitOut(h, h.root, ["version"]).trim();
  const m = /^git version (\S+)$/.exec(out);
  if (m === null) throw new Error(`git version output refused: ${JSON.stringify(out)}`);
  return m[1]!;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const obs = (fact: string, expected: unknown, observed: unknown, match = same(expected, observed)): Observation => ({ fact, expected, observed, match });
const slug = (text: string) => text.replaceAll(" ", "_");
const stdoutLines = (r: GitResult) => r.stdout.toString("utf8").split("\n").filter((l) => l !== "");

// One fixture set per host and builder.
const fixtures = new WeakMap<GitHost, Map<string, unknown>>();
function once<T>(h: GitHost, key: string, build: () => T): T {
  let map = fixtures.get(h);
  if (map === undefined) fixtures.set(h, (map = new Map()));
  if (!map.has(key)) map.set(key, build());
  return map.get(key) as T;
}

let copies = 0;
function copyOf(h: GitHost, from: string): string {
  const to = `${h.root}/copy-${++copies}`;
  h.copy(from, to);
  return to;
}

const ANY_EXIT = Array.from({ length: 256 }, (_, i) => i).concat([-1]);
const run = (h: GitHost, repo: string, args: string[], env: Record<string, string | undefined> = {}) => gitRun(h, repo, args, { allowExit: ANY_EXIT, env });
// The `integrate` policy of plan.md D2 adds `GIT_EDITOR=:`.
const INTEGRATE_ENV = { GIT_EDITOR: ":" };
const D3_FETCH = ["--no-lazy-fetch", "fetch", "--porcelain", "--progress", "--no-recurse-submodules", "--", "origin"];

// ---- (a) fetch --porcelain ----

// Contract Δ3 fetch line grammar.
const FETCH_LINE = /^([ +\-t*!=]) ([0-9a-f]+) ([0-9a-f]+) (\S+)$/;
// progress.c: "%3u%% (%"PRIuMAX"/%"PRIuMAX")", untranslated.
const COUNTER = /\d+% \(\d+\/\d+\)/;
const FLAG_NAMES: Record<string, string> = { " ": "space", "+": "plus", "-": "minus", t: "t", "*": "star", "!": "bang", "=": "equal" };

function factA(h: GitHost): Observation[] {
  const f = once(h, "flags", () => buildFetchFlags(h));
  const hex = hexLength(h, f.clone);
  const a = copyOf(h, f.clone);
  const d3 = run(h, a, D3_FETCH);
  const verbose = run(h, a, ["--no-lazy-fetch", "fetch", "--porcelain", "--verbose", "--no-recurse-submodules", "--", "origin"]);
  const prune = run(h, copyOf(h, f.clone), ["--no-lazy-fetch", "fetch", "--porcelain", "--prune", "--tags", "--force", "--no-recurse-submodules", "--", "origin"]);
  const reject = run(h, copyOf(h, f.clone), ["--no-lazy-fetch", "fetch", "--porcelain", "--no-recurse-submodules", "--", "origin", "refs/heads/rewound:refs/remotes/origin/rewound"]);
  const lines = [d3, verbose, prune, reject].flatMap(stdoutLines);
  const bad = lines.filter((l) => {
    const m = FETCH_LINE.exec(l);
    return m === null || m[2]!.length !== hex || m[3]!.length !== hex;
  });
  const flags = new Set(lines.map((l) => FETCH_LINE.exec(l)?.[1]).filter((x) => x !== undefined));
  const exits = { d3: d3.exitCode, verbose: verbose.exitCode, prune: prune.exitCode, reject: reject.exitCode };
  return [
    obs("a.grammar", [], bad),
    ...Object.entries(FLAG_NAMES).map(([flag, name]) => obs(`a.flag-${name}`, "present", flags.has(flag) ? "present" : "absent")),
    obs("a.progress-counter-on-stderr", "present", COUNTER.test(d3.stderr.toString("latin1")) ? "present" : "absent"),
    obs("a.exit-codes", { d3: 0, verbose: 0, prune: 0, reject: "nonzero" }, exits, exits.d3 === 0 && exits.verbose === 0 && exits.prune === 0 && exits.reject !== 0),
  ];
}

// ---- (b) push --porcelain ----

interface PushLine {
  flag: string;
  from: string;
  to: string;
  summary: string;
}

// git-push(1) OUTPUT: "<flag> TAB <from>:<to> TAB <summary>[ (<reason>)]". The summary token ends at " (".
function pushLines(r: GitResult): PushLine[] {
  return stdoutLines(r).flatMap((l) => {
    const m = /^(.)\t([^\t]*):([^\t]*)\t(.*)$/.exec(l);
    if (m === null) return [];
    const paren = m[4]!.indexOf(" (");
    return [{ flag: m[1]!, from: m[2]!, to: m[3]!, summary: paren === -1 ? m[4]! : m[4]!.slice(0, paren) }];
  });
}

function factB(h: GitHost): Observation[] {
  const pull = once(h, "pull", () => buildPull(h));
  const hooks = once(h, "hooks", () => buildHooks(h));
  const remote = copyOf(h, pull.origin);
  const repo = copyOf(h, pull.clone);
  const base = revParse(h, repo, "refs/heads/p-equal");
  const created = run(h, repo, ["--no-lazy-fetch", "push", "--porcelain", "--no-recurse-submodules", "--no-follow-tags", "--", remote, "p-equal:created"]);
  const createdLines = stdoutLines(created);
  const rejected = run(h, repo, ["--no-lazy-fetch", "push", "--porcelain", "--no-recurse-submodules", "--no-follow-tags", "--", remote, "refs/heads/p-diverged:refs/heads/p-diverged"]);
  const refused = run(h, repo, ["--no-lazy-fetch", "push", "--porcelain", "--no-recurse-submodules", "--no-follow-tags", "--", hooks.refuse, "refs/heads/p-equal:refs/heads/x"]);
  const lease = run(h, repo, ["--no-lazy-fetch", "push", "--porcelain", "--no-recurse-submodules", "--no-follow-tags", `--force-with-lease=refs/heads/p-diverged:${base}`, "--", remote, "refs/heads/p-diverged:refs/heads/p-diverged"]);
  const one = (r: GitResult, from: string) => {
    const l = pushLines(r).find((x) => x.from === from);
    return l === undefined ? `none(exit=${r.exitCode})` : `${l.flag}${l.summary}`;
  };
  const names = pushLines(created).map((l) => `${l.from}:${l.to}`);
  return [
    obs("b.full-ref-names", ["refs/heads/p-equal:refs/heads/created"], names),
    obs("b.to-line-first", true, createdLines[0]?.startsWith("To ") ?? false),
    obs("b.done-line-last", "Done", createdLines.at(-1) ?? null),
    obs("b.rejected", "![rejected]", one(rejected, "refs/heads/p-diverged"), one(rejected, "refs/heads/p-diverged") === "![rejected]" && rejected.exitCode !== 0),
    obs("b.remote-rejected", "![remote rejected]", one(refused, "refs/heads/p-equal"), one(refused, "refs/heads/p-equal") === "![remote rejected]" && refused.exitCode !== 0),
    obs("b.lease-refusal", "![rejected]", one(lease, "refs/heads/p-diverged"), one(lease, "refs/heads/p-diverged") === "![rejected]" && lease.exitCode !== 0),
    // R16 (b): Git prints `Done` after a rejected push too, so `Done` decides nothing.
    obs("b.done-line-last-on-rejection", "Done", stdoutLines(rejected).at(-1) ?? null),
  ];
}

// ---- (c) track grammar under a German locale ----

// Contract Δ3 track pattern.
const TRACK = /^(?:|gone|ahead [1-9][0-9]*|behind [1-9][0-9]*|ahead [1-9][0-9]*, behind [1-9][0-9]*)$/;
const GERMAN = { LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8" };
const TRACK_FORMAT = "--format=%(refname)%00%(upstream)%00%(upstream:track,nobracket)";

function trackText(ahead: number, behind: number): string {
  if (ahead > 0 && behind > 0) return `ahead ${ahead}, behind ${behind}`;
  if (ahead > 0) return `ahead ${ahead}`;
  return behind > 0 ? `behind ${behind}` : "";
}

function trackMismatches(h: GitHost, repo: string): string[] {
  const listing = gitRun(h, repo, ["--no-lazy-fetch", "--no-optional-locks", "for-each-ref", TRACK_FORMAT, "refs/heads"], { env: GERMAN }).stdout.toString("utf8");
  const refs = refMap(h, repo);
  const bad: string[] = [];
  for (const line of listing.split("\n")) {
    if (line === "") continue;
    const [ref, upstream, track] = line.split("\0") as [string, string, string];
    if (!TRACK.test(track)) bad.push(`${ref}:grammar:${track}`);
    let expected = "";
    if (upstream !== "") expected = refs[upstream] === undefined ? "gone" : trackText(...leftRight(h, repo, ref, upstream));
    if (track !== expected) bad.push(`${ref}:count:${track}!=${expected}`);
  }
  return bad;
}

function factC(h: GitHost): Observation[] {
  const counts = once(h, "counts", () => buildCounts(h));
  const many = once(h, "many", () => buildMany(h));
  // `git branch` loads the translated messages (builtin/branch.c `setup_ref_filter_porcelain_msg`); different bytes show an active translation.
  const branch = gitRun(h, counts.clone, ["branch", TRACK_FORMAT], { env: GERMAN }).stdout;
  const plumbing = gitRun(h, counts.clone, ["for-each-ref", TRACK_FORMAT, "refs/heads"], { env: GERMAN }).stdout;
  const listed = gitOut(h, many.clone, ["for-each-ref", "--format=%(refname)", "refs/heads"]).split("\n").filter((r) => /^refs\/heads\/b\d{3}$/.test(r)).length;
  return [
    obs("c.translation-active", true, !branch.equals(plumbing)),
    obs("c.counts-fixture", [], trackMismatches(h, counts.clone)),
    obs("c.many-fixture", { mismatches: [], branches: MANY_BRANCHES }, { mismatches: trackMismatches(h, many.clone), branches: listed }),
  ];
}

// ---- (d) push destination (plan.md D4) ----

interface D4Result {
  dst: string | null;
  // The push URL of the destination remote.
  url: string | null;
  reason: string | null;
  panel: boolean;
  // A difference from Git that the plan chooses on purpose (R16 d).
  deliberate: string | null;
}

const configValue = (h: GitHost, repo: string, args: string[]): string | null => {
  const r = run(h, repo, ["config", ...args]);
  if (r.exitCode === 1) return null;
  if (r.exitCode !== 0) throw new Error(`git config ${args.join(" ")} exited ${r.exitCode}`);
  return r.stdout.toString("utf8").replace(/\n$/, "");
};

// plan.md D4 steps 0 to 5 and the push URL rule (O-11), from Git's own fields. A panel pre-fill counts as the destination.
function d4(h: GitHost, repo: string, branch: string): D4Result {
  const ref = `refs/heads/${branch}`;
  const none = (reason: string | null, panel: boolean, deliberate: string | null = null): D4Result => ({ dst: null, url: null, reason, panel, deliberate });
  const read = run(h, repo, ["--no-lazy-fetch", "--no-optional-locks", "for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(push)%00%(push:remotename)%00%(push:remoteref)", ref]);
  if (read.exitCode !== 0) return none(`read-exit-${read.exitCode}`, false);
  const record = read.stdout.toString("utf8").split("\n").map((l) => l.split("\0")).find((f) => f[0] === ref);
  if (record === undefined) return none("no-record", false);
  const [, , upstream, upRemote, upRef, push, pushRemote, pushRef] = record as string[];
  const panel = upstream === "";
  const remotes = gitOut(h, repo, ["remote"]).split("\n").filter((r) => r !== "");
  const R = pushRemote === "" ? "origin" : pushRemote!;
  if (pushRemote === "" && !remotes.includes(R)) return none(null, true);
  if (!remotes.includes(R)) return none("remote-missing", panel);
  if (configValue(h, repo, ["--type=bool", "--get", `remote.${R}.mirror`]) === "true") return none("mirror", panel, "mirror");
  let dst: string | null;
  const mode = configValue(h, repo, ["--get", "push.default"]) ?? "simple";
  if (pushRef !== "") dst = pushRef!;
  else if (mode === "current") dst = ref;
  else if (mode === "simple") dst = (configValue(h, repo, ["--get", `branch.${branch}.remote`]) ?? "origin") !== R || push !== "" ? ref : null;
  else if (mode === "upstream" || mode === "tracking") {
    if (upRemote !== R) return none("push-remote-differs", panel);
    dst = upstream === "" ? null : upRef!;
  } else if (mode === "matching") return none(null, true, "matching");
  else return none("invalid-config", panel);
  if (dst === null) return none(null, true);
  const urls = stdoutLines(run(h, repo, ["remote", "get-url", "--push", "--all", "--", R]));
  if (urls.length !== 1) return none("push-urls", panel, "push-urls");
  return { dst, url: urls[0]!, reason: null, panel, deliberate: null };
}

function factD(h: GitHost): Observation[] {
  const f = once(h, "push", () => buildPush(h));
  return PUSH_VARIANTS.map((v) => {
    const repo = pushVariant(h, f, v, `${h.root}/copy-${++copies}`);
    const rule = d4(h, repo, v.branch);
    const dry = run(h, repo, ["--no-lazy-fetch", "push", "--dry-run", "--porcelain", "--no-recurse-submodules", "--no-follow-tags"]);
    const line = pushLines(dry).find((l) => l.from === `refs/heads/${v.branch}`);
    // transport.c prints `To <url>` before the status lines of each URL.
    const to = stdoutLines(dry).find((l) => l.startsWith("To "))?.slice(3) ?? null;
    const expected = rule.dst !== null ? { dst: rule.dst, url: rule.url } : `none(${rule.reason ?? "panel"})`;
    const observed = line === undefined ? `none(exit=${dry.exitCode})` : { dst: line.to, url: to };
    return obs(`d.${slug(v.name)}`, { d4: expected, panel: rule.panel, deliberate: rule.deliberate }, { git: observed, lines: pushLines(dry).length }, rule.dst !== null ? same(expected, observed) : line === undefined);
  });
}

// ---- (e) pull: Git's own pull against the D6 steps ----

// data-model §6. The payload maps to a rebase value first, then `branch.<name>.rebase`, then `pull.rebase`.
export function d6Decide(ahead: number, behind: number, ff: string | null, rebase: string | null, payload?: "merge" | "rebase"): PullDecision {
  if (behind === 0) return "up-to-date";
  const value = payload === "rebase" ? "true" : payload === "merge" ? "false" : rebase;
  if (ahead === 0) {
    if (value === "true" || value === "merges" || value === "interactive") return "fast-forward";
    if (ff === "false") return "merge-no-ff";
    // Git's pull passes no ff option without `pull.ff`, so `merge.ff` applies.
    return ff === null ? "merge" : "fast-forward";
  }
  if (ff === "only") {
    if (payload === undefined) return "refuse:ff-only";
    return payload === "rebase" ? "rebase" : "merge-ff";
  }
  if (ff === null && value === null) return "refuse:mode-required";
  if (value === "true") return "rebase";
  if (value === "merges") return "rebase-merges";
  if (value === "interactive") return "refuse:interactive-rebase";
  if (ff === "true") return "merge-ff";
  if (ff === "false") return "merge-no-ff";
  return "merge";
}

const INTEGRATE: Record<string, (ref: string) => string[]> = {
  "fast-forward": (u) => ["merge", "--ff-only", "--no-autostash", u],
  merge: (u) => ["merge", "--no-edit", "--no-autostash", u],
  "merge-ff": (u) => ["merge", "--no-edit", "--no-autostash", "--ff", u],
  "merge-no-ff": (u) => ["merge", "--no-edit", "--no-autostash", "--no-ff", u],
  rebase: (u) => ["rebase", "--no-autostash", "--fork-point", u],
  "rebase-merges": (u) => ["rebase", "--no-autostash", "--fork-point", "--rebase-merges", u],
};

// Commit OIDs differ by message, so trees and parent trees decide (plan.md D14).
function repoState(h: GitHost, repo: string) {
  const log = gitOut(h, repo, ["log", "--topo-order", "--format=%H%x00%T%x00%P", "HEAD"]).split("\n").filter((l) => l !== "").map((l) => l.split("\0"));
  const trees = new Map(log.map(([oid, tree]) => [oid!, tree!]));
  return {
    head: gitOut(h, repo, ["symbolic-ref", "-q", "HEAD"]).trim(),
    shape: log.map(([, tree, parents]) => `${tree}<${(parents ?? "").split(" ").filter((p) => p !== "").map((p) => trees.get(p) ?? p).join(",")}`),
    index: stageEntries(h, repo),
    files: h.digests(repo),
    markers: markers(h, repo),
    remotes: refMap(h, repo, ["refs/remotes"]),
  };
}

function diffKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return Object.keys(a).filter((k) => !same(a[k], b[k]));
}

function pullRow(h: GitHost, row: PullRow): Observation[] {
  const f = once(h, "pull", () => buildPull(h));
  const gitCopy = pullRowCopy(h, f, row, `${h.root}/copy-${++copies}`);
  const appCopy = pullRowCopy(h, f, row, `${h.root}/copy-${++copies}`);
  const upstream = `refs/remotes/origin/${row.branch}`;
  const fetch = run(h, appCopy, D3_FETCH);
  const [ahead, behind] = leftRight(h, appCopy, "HEAD", revParse(h, appCopy, upstream));
  const ff = configValue(h, appCopy, ["--get", "pull.ff"]);
  const rebase = configValue(h, appCopy, ["--get", `branch.${row.branch}.rebase`]) ?? configValue(h, appCopy, ["--get", "pull.rebase"]);
  const decision = d6Decide(ahead, behind, ff, rebase, row.payload);
  const name = slug(row.name);
  const out = [obs(`e.decision.${name}`, row.expect, decision)];
  if (decision === "refuse:interactive-rebase") return out;
  const integrate = INTEGRATE[decision];
  const step = integrate === undefined ? null : run(h, appCopy, ["--no-lazy-fetch", ...integrate(upstream)], INTEGRATE_ENV);
  const pull = run(h, gitCopy, ["pull", ...(row.payload === "rebase" ? ["--rebase"] : row.payload === "merge" ? ["--no-rebase"] : [])], INTEGRATE_ENV);
  const differs = diffKeys(repoState(h, gitCopy), repoState(h, appCopy));
  const refused = decision.startsWith("refuse:");
  const exits = { fetch: fetch.exitCode, integrate: step?.exitCode ?? null, gitPull: pull.exitCode };
  const exitsAgree = fetch.exitCode === 0 && (refused ? pull.exitCode !== 0 : pull.exitCode === 0 && (step === null || step.exitCode === 0));
  out.push(obs(`e.equal.${name}`, { differs: [], exitsAgree: true }, { differs, exitsAgree, exits }, differs.length === 0 && exitsAgree));
  return out;
}

function factE(h: GitHost): Observation[] {
  return PULL_ROWS.flatMap((row) => pullRow(h, row));
}

// ---- (f) GIT_EDITOR=: with commit --quiet in a merge ----

function factF(h: GitHost): Observation[] {
  const f = once(h, "merge", () => buildMergeConflict(h));
  const repo = copyOf(h, f.repo);
  gitRun(h, repo, ["add", "-A"]);
  const [msgPath] = gitPaths(h, repo, ["MERGE_MSG"]);
  const msg = h.read(msgPath!) ?? Buffer.alloc(0);
  const stripped = gitRun(h, repo, ["stripspace", "--strip-comments"], { input: msg }).stdout.toString("utf8");
  const commit = run(h, repo, ["commit", "--quiet"], INTEGRATE_ENV);
  const raw = commit.exitCode === 0 ? gitRun(h, repo, ["cat-file", "commit", "HEAD"]).stdout.toString("utf8") : "";
  const message = raw.slice(raw.indexOf("\n\n") + 2);
  const parents = commit.exitCode === 0 ? gitOut(h, repo, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ").length - 1 : 0;
  return [
    obs("f.merge-msg-had-comments", true, msg.toString("utf8").split("\n").some((l) => l.startsWith("#"))),
    obs("f.commit-message", { exit: 0, message: stripped, parents: 2, markers: [] }, { exit: commit.exitCode, message, parents, markers: markers(h, repo) }),
  ];
}

// ---- (g) GIT_PROTOCOL_FROM_USER and a local-path remote ----

function factG(h: GitHost): Observation[] {
  const f = once(h, "pull", () => buildPull(h));
  const repo = copyOf(h, f.clone);
  const blocked = run(h, repo, D3_FETCH, { GIT_PROTOCOL_FROM_USER: "0" });
  const passed = run(h, repo, D3_FETCH, { GIT_PROTOCOL_FROM_USER: undefined });
  return [obs("g.from-user-0-blocks", { zero: "nonzero", unset: 0 }, { zero: blocked.exitCode, unset: passed.exitCode }, blocked.exitCode !== 0 && passed.exitCode === 0)];
}

// ---- (h) merge and rebase with submodule.recurse=true ----

function factH(h: GitHost): Observation[] {
  const f = once(h, "submodule", () => buildSubmodule(h));
  const merged = copyOf(h, f.clone);
  const merge = run(h, merged, ["-c", "submodule.recurse=true", "merge", "--ff-only", "--no-autostash", "refs/remotes/origin/main"], INTEGRATE_ENV);
  const rebased = copyOf(h, f.clone);
  const rebase = run(h, rebased, ["-c", "submodule.recurse=true", "rebase", "--no-autostash", "refs/remotes/origin/main"], INTEGRATE_ENV);
  const state = (repo: string, r: GitResult) => ({ exit: r.exitCode, head: revParse(h, repo, "HEAD"), sub: revParse(h, `${repo}/sub`, "HEAD") });
  const expected = { exit: 0, head: f.c2, sub: f.s1 };
  return [obs("h.merge-ignores-recurse", expected, state(merged, merge)), obs("h.rebase-ignores-recurse", expected, state(rebased, rebase))];
}

// ---- (i) update-index --add --remove on each unmerged kind ----

// porcelain v2 `u` record: "u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>" (git-status(1)).
function worktreeModes(h: GitHost, repo: string): Record<string, string> {
  const modes: Record<string, string> = {};
  for (const record of gitRun(h, repo, ["status", "--porcelain=v2", "-z", "--untracked-files=no"]).stdout.toString("utf8").split("\0")) {
    const m = /^u \S\S \S{4} \d{6} \d{6} \d{6} (\d{6}) [0-9a-f]+ [0-9a-f]+ [0-9a-f]+ ([\s\S]+)$/.exec(record);
    if (m) modes[m[2]!] = m[1]!;
  }
  return modes;
}

function factI(h: GitHost): Observation[] {
  const f = once(h, "merge", () => buildMergeConflict(h));
  const modes = worktreeModes(h, f.repo);
  const viaAdd = copyOf(h, f.repo);
  const viaIndex = copyOf(h, f.repo);
  return Object.entries(f.kinds).flatMap(([path, kind]) => {
    const add = run(h, viaAdd, ["--literal-pathspecs", "add", "--", path]);
    const updated = gitRun(h, viaIndex, ["update-index", "--add", "--remove", "-z", "--stdin"], { input: Buffer.from(`${path}\0`), allowExit: ANY_EXIT });
    const a = stageEntries(h, viaAdd, [path]);
    const b = stageEntries(h, viaIndex, [path]);
    return [
      obs(`i.entries.${kind}.${path}`, { exit: add.exitCode, entries: a }, { exit: updated.exitCode, entries: b }),
      obs(`i.mode.${kind}.${path}`, modes[path] ?? null, b.find((e) => e.stage === 0)?.mode ?? "000000"),
    ];
  });
}

// ---- (i2) hash-object and update-index --index-info with mW (plan.md D7) ----

function factI2(h: GitHost): Observation[] {
  const f = once(h, "merge", () => buildMergeConflict(h));
  const modes = worktreeModes(h, f.repo);
  const viaAdd = copyOf(h, f.repo);
  const viaIndex = copyOf(h, f.repo);
  const config = { symlinks: configValue(h, viaIndex, ["--type=bool", "--get", "core.symlinks"]), filemode: configValue(h, viaIndex, ["--type=bool", "--get", "core.filemode"]) };
  const out = [obs("i2.repository-config", "recorded", config, true)];
  for (const [path, kind] of Object.entries(f.kinds)) {
    // data-model §9 refuses a path without a working file (mW 000000) and a path with mode 120000. No copy changes it, so the whole-index check holds it on both sides.
    if (modes[path] === "000000") {
      out.push(obs(`i2.missing.${kind}.${path}`, "000000", modes[path]));
      continue;
    }
    if (modes[path] === "120000" || stageEntries(h, f.repo, [path]).some((e) => e.mode === "120000")) {
      // Recorded only: Git for Windows with core.symlinks=false hashes the link file; a real link makes hash-object follow it.
      out.push(obs(`i2.symlink-refused.${kind}.${path}`, "recorded", { hashObjectExit: run(h, f.repo, ["hash-object", "--", path]).exitCode }, true));
      continue;
    }
    const add = run(h, viaAdd, ["--literal-pathspecs", "add", "--", path]);
    const hash = run(h, viaIndex, ["hash-object", "-w", "--", path]);
    const record = Buffer.from(`${modes[path]} ${hash.stdout.toString("utf8").trim()}\t${path}\0`);
    const update = hash.exitCode === 0 ? gitRun(h, viaIndex, ["update-index", "-z", "--index-info"], { input: record, allowExit: ANY_EXIT }).exitCode : hash.exitCode;
    out.push(obs(`i2.entries.${kind}.${path}`, { exit: add.exitCode, entries: stageEntries(h, viaAdd, [path]) }, { exit: update, entries: stageEntries(h, viaIndex, [path]) }));
  }
  out.push(obs("i2.whole-index", stageEntries(h, viaAdd), stageEntries(h, viaIndex)));
  return out;
}

// ---- (j) %(upstream) with an unconfigured remote ----

function factJ(h: GitHost): Observation[] {
  const f = once(h, "counts", () => buildCounts(h));
  const upstream = gitOut(h, f.clone, ["for-each-ref", "--format=%(upstream)", "refs/heads/ghost-remote"]).replace(/\n$/, "");
  return [obs("j.upstream-empty-for-unconfigured-remote", "", upstream)];
}

// ---- (k) fetch --all and skipFetchAll ----

function factK(h: GitHost): Observation[] {
  const repo = copyOf(h, once(h, "fetch-all", () => buildFetchAll(h)));
  const fetch = run(h, repo, ["--no-lazy-fetch", "fetch", "--all", "--no-recurse-submodules"]);
  const fetched = Object.keys(refMap(h, repo, ["refs/remotes"])).map((r) => r.split("/")[2]!);
  const observed = Object.keys(FETCH_ALL_REMOTES).filter((r) => fetched.includes(r));
  // O-4: Git skips a remote when the last value over `skipFetchAll` and `skipDefaultUpdate` is true. `--get-regexp` lists the values in file order.
  const lastSkip = (r: string) => stdoutLines(run(h, repo, ["config", "--type=bool", "--get-regexp", `^remote\\.${r}\\.(skipfetchall|skipdefaultupdate)$`])).at(-1)?.split(" ")[1];
  const expected = Object.keys(FETCH_ALL_REMOTES).filter((r) => lastSkip(r) !== "true");
  return [obs("k.fetch-all-remote-set", { remotes: expected, exit: 0 }, { remotes: observed, exit: fetch.exitCode })];
}

// ---- (l) rebase --skip ----

function factL(h: GitHost): Observation[] {
  const f = once(h, "rebase-skip", () => buildRebaseSkip(h));
  const clean = copyOf(h, f.clean);
  const skipClean = run(h, clean, ["rebase", "--skip"], INTEGRATE_ENV);
  const cleanState = {
    exit: skipClean.exitCode,
    markers: markers(h, clean),
    indexEqualsHead: run(h, clean, ["diff-index", "--quiet", "--cached", "HEAD", "--"]).exitCode,
    filesEqualIndex: run(h, clean, ["diff-files", "--quiet"]).exitCode,
    untracked: gitOut(h, clean, ["ls-files", "-z", "--others", "--exclude-standard"]),
    parentIsUpstream: revParse(h, clean, "HEAD^") === f.upstream,
  };
  const stops = copyOf(h, f.stops);
  const skipStops = run(h, stops, ["rebase", "--skip"], INTEGRATE_ENV);
  const aEntries = stageEntries(h, stops, ["a.txt"]);
  const aBlob = run(h, stops, ["hash-object", "--", "a.txt"]).stdout.toString("utf8").trim();
  const headA = run(h, stops, ["rev-parse", "--verify", "-q", "HEAD:a.txt"]).stdout.toString("utf8").trim();
  const stopsState = {
    exit: skipStops.exitCode === 0 ? 0 : "nonzero",
    markers: markers(h, stops),
    aIndexEqualsHead: aEntries.length === 1 && aEntries[0]!.stage === 0 && aEntries[0]!.oid === headA,
    aFileEqualsHead: aBlob === headA,
    cStages: stageEntries(h, stops, ["c.txt"]).map((e) => e.stage),
  };
  return [
    obs("l.skip-then-clean-step", { exit: 0, markers: [], indexEqualsHead: 0, filesEqualIndex: 0, untracked: "", parentIsUpstream: true }, cleanState),
    obs("l.skip-then-stopping-step", { exit: "nonzero", markers: ["rebase-merge"], aIndexEqualsHead: true, aFileEqualsHead: true, cStages: [1, 2, 3] }, stopsState),
  ];
}

export const FACTS: Fact[] = [
  { id: "a", title: "fetch --porcelain line grammar and the progress counter", run: factA },
  { id: "b", title: "push --porcelain names, To and Done lines, rejections", run: factB },
  { id: "c", title: "track grammar under de_DE.UTF-8 equals rev-list counts", run: factC },
  { id: "d", title: "D4 destination equals push --dry-run --porcelain", run: factD },
  { id: "e", title: "D6 pull equals Git's own pull on copies", run: factE },
  { id: "f", title: "GIT_EDITOR=: with commit --quiet strips MERGE_MSG comments", run: factF },
  { id: "g", title: "GIT_PROTOCOL_FROM_USER=0 blocks a local-path remote", run: factG },
  { id: "h", title: "merge and rebase ignore submodule.recurse=true", run: factH },
  { id: "i", title: "update-index --add --remove equals git add on unmerged kinds", run: factI },
  { id: "i2", title: "hash-object and update-index --index-info with mW equal git add on unmerged kinds", run: factI2 },
  { id: "j", title: "%(upstream) is empty for an unconfigured remote", run: factJ },
  { id: "k", title: "fetch --all remote set with skipFetchAll and skipDefaultUpdate", run: factK },
  { id: "l", title: "rebase --skip leaves the index and files equal to HEAD", run: factL },
];

