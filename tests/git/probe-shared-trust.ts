// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T281 probe, not a test. Run: `bun tests/git/probe-shared-trust.ts`. It shares one trust listing between a full read and a history read, and runs the history read in parallel with the listing.

import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { batchCommandArgs, configListArgs, hooksPathArgs, statusArgs } from "../../src/git-service/commands";
import { printOrigin } from "../origin";
import { copyPerfFixture, PERF_CACHE_ROOT, PERF_L, PERF_M, PERF_SEED, semanticDigest, type PerfManifest, type PerfSpec } from "../windows/perf-fixtures";
import { sha256 } from "./git-oracle";
import { FIXTURE_GLOBAL_CONFIG, FIXTURE_HOME, FIXTURE_ROOT, fixtureEnv, ownedGit, realGlobalConfigDigests, removeFixtureRoot, removeTree } from "./fixture-root";
import { buildF17, put, type Built, type F17Variant } from "./fixtures";
import { GIT } from "./git-binary";

printOrigin("../../src/git-service/commands", import.meta.dir);
printOrigin("../windows/perf-fixtures", import.meta.dir);
printOrigin("./fixture-root", import.meta.dir);
printOrigin("./fixtures", import.meta.dir);
printOrigin("./git-oracle", import.meta.dir);
printOrigin("./probe-shared-trust", import.meta.dir);

// Contract §5 ordinary read deadline is longer. The probe stops a stuck process sooner.
const DEADLINE_MS = 120_000;
const TIMING_RUNS = 10;
// No `commands.ts` builder captures HEAD yet. These use the T067 read options.
const READ = ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs"];
const symbolicRefArgs = () => [...READ, "symbolic-ref", "-q", "HEAD"];
const headArgs = () => [...READ, "rev-parse", "--verify", "HEAD"];

if (GIT === null) throw new Error("Git executable absent");
const git = GIT;
let spawned = 0;

interface Out {
  exit: number | string;
  stdout: Buffer;
  stderr: string;
}

function start(dir: string, args: string[], stdin: "ignore" | "pipe" = "ignore") {
  spawned++;
  const proc = Bun.spawn([git, ...args], { cwd: dir, env: fixtureEnv({ LC_ALL: "C" }), stdin, stdout: "pipe", stderr: "pipe", timeout: DEADLINE_MS });
  const out: Promise<Out> = Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]).then(([o, e, x]) => ({
    exit: proc.signalCode ? `signal ${proc.signalCode}` : x,
    stdout: Buffer.from(o),
    stderr: e,
  }));
  return { proc, out };
}

// Scope NUL origin NUL key, then LF and the value when it has one, then NUL.
interface Entry {
  scope: string;
  key: string;
  value: string | null;
}
function parseListing(out: Buffer): Entry[] {
  const fields = out.toString("utf8").split("\0");
  const entries: Entry[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const kv = fields[i + 2]!;
    const lf = kv.indexOf("\n");
    entries.push({ scope: fields[i]!, key: lf < 0 ? kv : kv.slice(0, lf), value: lf < 0 ? null : kv.slice(lf + 1) });
  }
  return entries;
}

// git_parse_maybe_bool (parse.c). Contract §7: a boolean `core.fsmonitor` names the built-in daemon, not a command.
function isBool(v: string | null): boolean {
  if (v === null) return true;
  return /^(|true|false|yes|no|on|off|[+-]?\d+[kmg]?)$/i.test(v);
}

// Contract §7 blocking class for these reads. The probe gate checks scope only, because every F17 canary key has local scope.
function blocking(e: Entry): boolean {
  if (e.scope !== "local" && e.scope !== "worktree") return false;
  if (/^filter\..+\.(clean|process)$/i.test(e.key)) return true;
  return e.key.toLowerCase() === "core.fsmonitor" && !isBool(e.value);
}

interface Listing {
  fingerprint: string;
  blocked: number;
  entries: number;
}

async function listing(dir: string): Promise<Listing> {
  const cfg = await start(dir, configListArgs()).out;
  const hooks = await start(dir, hooksPathArgs()).out;
  if (cfg.exit !== 0 || hooks.exit !== 0) throw new Error(`listing exit ${cfg.exit}/${hooks.exit}: ${cfg.stderr}${hooks.stderr}`);
  const entries = parseListing(cfg.stdout);
  const fingerprint = new Bun.CryptoHasher("sha256").update(cfg.stdout).update("\0").update(hooks.stdout).digest("hex");
  return { fingerprint, blocked: entries.filter(blocking).length, entries: entries.length };
}

let approved: string | null = null;
function gate(l: Listing): "pass" | "TRUST_REQUIRED" | "TRUST_CHANGED" {
  if (l.blocked === 0 || approved === l.fingerprint) return "pass";
  return approved === null ? "TRUST_REQUIRED" : "TRUST_CHANGED";
}

interface Held {
  head: string;
  rows: string[];
  objectBytes: number;
  exits: string;
}

// The T086 history steps. `cat-file` starts first and gets its input after `rev-list` ends.
async function history(dir: string, extraObjects: string[] = []): Promise<Held> {
  const cat = start(dir, batchCommandArgs(), "pipe");
  try {
    const sym = await start(dir, symbolicRefArgs()).out;
    const head = await start(dir, headArgs()).out;
    // The retired 001 `shallowPathArgs` and `revListArgs` arrays.
    const shallow = await start(dir, ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs", "rev-parse", "--git-path", "shallow"]).out;
    const oid = head.stdout.toString().trim();
    const list = await start(dir, ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs", "rev-list", "--parents", "--max-count=100", "--date-order", oid]).out;
    const rows = list.stdout.toString().split("\n").filter((l) => l !== "");
    const input = [...rows.map((r) => `contents ${r.split(" ")[0]}`), ...extraObjects.map((o) => `info ${o}`)];
    const sink = cat.proc.stdin as Bun.FileSink;
    sink.write(input.map((c) => `${c}\0`).join(""));
    sink.end();
    const objects = await cat.out;
    return { head: oid, rows, objectBytes: objects.stdout.length, exits: [sym, head, shallow, list, objects].map((o) => o.exit).join("/") };
  } finally {
    cat.proc.kill();
  }
}

interface ReadResponse {
  state: string;
  code?: string;
  rows?: string[];
}

// Current contract §7 order: the listing passes the gate before any history process starts.
async function historySequential(dir: string, shared?: Promise<Listing>): Promise<ReadResponse> {
  const g = gate(await (shared ?? listing(dir)));
  if (g !== "pass") return { state: "rejected", code: g };
  return { state: "succeeded", rows: (await history(dir)).rows };
}

// T281 order: the history processes run beside the listing. The gate decides whether the held result reaches the response.
async function historyParallel(dir: string, shared?: Promise<Listing>): Promise<ReadResponse> {
  const [l, held] = await Promise.all([shared ?? listing(dir), history(dir)]);
  const g = gate(l);
  if (g !== "pass") return { state: "rejected", code: g };
  return { state: "succeeded", rows: held.rows };
}

// The status part of a full read. T085 reads the raw index bytes without Git.
async function fullRead(dir: string, shared?: Promise<Listing>): Promise<ReadResponse> {
  const g = gate(await (shared ?? listing(dir)));
  if (g !== "pass") return { state: "rejected", code: g };
  const s = await start(dir, statusArgs()).out;
  return { state: s.exit === 0 ? "succeeded" : `git-exit-${s.exit}` };
}

// Canaries log one line per run. Logs are relative to the fixture folder.
function counts(b: Built): Record<string, number> {
  const c: Record<string, number> = {};
  for (const [name, log] of Object.entries(b.facts.canaries)) {
    const path = join(b.root, log);
    c[name] = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l !== "").length : 0;
  }
  return c;
}
const firedSince = (b: Built, before: Record<string, number>) => Object.entries(counts(b)).filter(([n, v]) => v > (before[n] ?? 0)).map(([n]) => n);

// Git runs the canaries through its POSIX shell, so paths use `/`.
function addCanary(b: Built, name: string, tail: string): string {
  const log = join(b.root, "canaries", `${name}.log`);
  const script = put(b.root, `canaries/${name}.sh`, `#!/bin/sh\necho "${name} $*" >> '${log.replaceAll("\\", "/")}'\n${tail}`);
  b.facts.canaries[name] = relative(b.root, log);
  return `'${script.replaceAll("\\", "/")}'`;
}

// A later time than the fixture time makes each file stat-dirty, so `status` runs its clean conversion.
function touch(dir: string, paths: string[]): void {
  const now = Date.now() / 1000;
  for (const p of paths) utimesSync(join(dir, p), now, now);
}

const pass = (ok: boolean) => (ok ? "" : " FAIL");
let failures = 0;
const check = (ok: boolean) => {
  if (!ok) failures++;
  return pass(ok);
};

async function f17Case(variant: F17Variant): Promise<string> {
  const b = buildF17(git, `t281-${variant}`, variant);
  const trust = variant === "trust";
  const dir = join(b.root, trust ? "repo" : "clone");
  const missing = trust ? [] : (b.facts.notes.missingBlobs as string[]);
  if (trust) touch(dir, ["data.dat", "data.prc"]);
  else {
    const set = (k: string, v: string) => ownedGit(git, FIXTURE_ROOT, dir, ["--no-lazy-fetch", "config", k, v]);
    set("filter.t281.clean", addCanary(b, "clean", "exec cat\n"));
    set("filter.t281p.process", addCanary(b, "process", "exit 1\n"));
    set("core.fsmonitor", addCanary(b, "fsmonitor", "exit 1\n"));
    writeFileSync(join(dir, ".git", "info", "attributes"), "data.txt filter=t281\nother.txt filter=t281p\n");
    touch(dir, ["data.txt", "other.txt"]);
  }
  console.log(`CASE F17 ${variant} canaries=[${Object.keys(b.facts.canaries).join(",")}]`);
  approved = null;
  let row = `| F17 ${variant} |`;
  for (const phase of ["before approval", "after approval"] as const) {
    const before = counts(b);
    const first = spawned;
    // One listing for the generation. Both reads take it. The history processes run beside it.
    const shared = listing(dir);
    const [l, held] = await Promise.all([shared, history(dir, missing)]);
    const preGate = firedSince(b, before);
    const g = gate(l);
    const historyResponse: ReadResponse = g === "pass" ? { state: "succeeded", rows: held.rows } : { state: "rejected", code: g };
    const fullBefore = counts(b);
    const fullResponse = await fullRead(dir, shared);
    const afterGate = firedSince(b, fullBefore);
    const processes = spawned - first;
    const text = JSON.stringify([historyResponse, fullResponse]);
    const leaked = held.rows.some((r) => text.includes(r.slice(0, 40)));
    const refused = phase === "before approval";
    console.log(`  ${phase.toUpperCase()} listing entries=${l.entries} blocking=${l.blocked} gate=${g}${check(g === (refused ? "TRUST_REQUIRED" : "pass"))}`);
    console.log(`  ${phase.toUpperCase()} held rows=${held.rows.length} objectBytes=${held.objectBytes} exits=${held.exits} missingObjects=${missing.length}`);
    console.log(`  ${phase.toUpperCase()} canaries listing+history=[${preGate.join(",")}]${check(preGate.length === 0)} gated full read=[${afterGate.join(",")}]`);
    console.log(`  ${phase.toUpperCase()} responses history=${historyResponse.state}${historyResponse.code ? `/${historyResponse.code}` : ""} full=${fullResponse.state}${fullResponse.code ? `/${fullResponse.code}` : ""} heldRowsInResponse=${leaked}${check(held.rows.length > 0 && leaked === !refused)} processes=${processes}`);
    row += ` ${preGate.join(", ") || "none"} | ${afterGate.join(", ") || "none"} | ${historyResponse.state}${historyResponse.code ? ` ${historyResponse.code}` : ""}, ${held.rows.length} rows held, ${leaked ? "delivered" : "none in a response"} |`;
    if (refused) approved = l.fingerprint;
  }

  if (trust) {
    // Stale listing inside one generation: a configuration edit before the next full read.
    const stale = listing(dir);
    await stale;
    ownedGit(git, FIXTURE_ROOT, dir, ["config", "core.fsmonitor", addCanary(b, "late-fsmonitor", "exit 1\n")]);
    const before = counts(b);
    const response = await historyParallel(dir, stale);
    const fresh = gate(await listing(dir));
    const fired = firedSince(b, before);
    console.log(`  STALE shared listing history=${response.state} rows=${response.rows?.length ?? 0} canaries=[${fired.join(",")}]${check(fired.length === 0)} fresh listing gate=${fresh}${check(fresh === "TRUST_CHANGED")}`);
  } else {
    // Control: a lazy fetch of a missing blob runs `remote.origin.uploadpack`.
    const before = counts(b);
    const p = Bun.spawnSync([git, "--no-optional-locks", "cat-file", "--batch-check"], { cwd: dir, env: fixtureEnv({ LC_ALL: "C" }), stdin: Buffer.from(`${missing[0]}\n`), stdout: "pipe", stderr: "pipe", timeout: DEADLINE_MS });
    const fired = firedSince(b, before);
    console.log(`  CONTROL cat-file --batch-check without --no-lazy-fetch exit=${p.exitCode} canaries=[${fired.join(",")}]${check(fired.includes("uploadpack"))}`);
  }
  return row;
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return Math.round(((s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2) * 10) / 10;
};

async function timed(run: () => Promise<unknown>): Promise<number> {
  const t = performance.now();
  await run();
  return performance.now() - t;
}

async function perfCase(spec: PerfSpec, commitGraph: boolean): Promise<string> {
  const label = `${spec.name} ${commitGraph ? "commit-graph" : "no commit-graph"}`;
  // `ensurePerfFixture` rebuilds the shared cache when the builder digest differs. Other checkouts hold the builder with CRLF line ends.
  // So the probe never rebuilds. It accepts the builder bytes with LF or CRLF, then checks the semantic digest of its copy.
  const folder = join(PERF_CACHE_ROOT, `${spec.name}-seed${PERF_SEED}-${commitGraph ? "commit-graph" : "no-commit-graph"}`);
  const manifestPath = join(folder, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`${label}: no cached fixture`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PerfManifest;
  const lf = readFileSync(join(import.meta.dir, "..", "windows", "perf-fixtures.ts"), "utf8").replaceAll("\r\n", "\n");
  const builders = [lf, lf.replaceAll("\n", "\r\n")].map((t) => sha256(Buffer.from(t)));
  if (!builders.includes(manifest.builderDigest) || manifest.facts.commitGraph !== commitGraph) throw new Error(`${label}: cached fixture from another builder`);
  const dir = copyPerfFixture(git, { folder, repo: join(folder, "repo"), manifest, reused: true, stream: null }, `t281-${spec.name}-${commitGraph ? "cg" : "nocg"}`);
  const semantic = semanticDigest(git, dir) === manifest.facts.semanticDigest;
  try {
    approved = null;
    // Process counts of one generation: a full read and a history read, each with its own listing, or with one shared listing.
    let first = spawned;
    const sep = await Promise.all([fullRead(dir), historyParallel(dir)]);
    const separate = spawned - first;
    first = spawned;
    const shared = listing(dir);
    const one = await Promise.all([fullRead(dir, shared), historyParallel(dir, shared)]);
    const sharedCount = spawned - first;
    first = spawned;
    await historySequential(dir);
    const historyCount = spawned - first;
    const ok = [...sep, ...one].every((r) => r.state === "succeeded");
    // Interleaved runs after one warm-up of each order.
    const seq: number[] = [];
    const par: number[] = [];
    const lst: number[] = [];
    let sameRows = true;
    const reference = JSON.stringify((await historySequential(dir)).rows);
    await historyParallel(dir);
    for (let i = 0; i < TIMING_RUNS; i++) {
      let a: ReadResponse = { state: "" };
      let c: ReadResponse = { state: "" };
      seq.push(await timed(async () => (a = await historySequential(dir))));
      par.push(await timed(async () => (c = await historyParallel(dir))));
      lst.push(await timed(() => listing(dir)));
      sameRows &&= JSON.stringify(a.rows) === reference && JSON.stringify(c.rows) === reference;
    }
    const rows = (JSON.parse(reference) as string[]).length;
    console.log(`PERF ${label} builder=${manifest.builderDigest.slice(0, 12)} semanticDigestEqual=${semantic} rows=${rows}${check(semantic && rows === 100 && sameRows && ok)} processes separate=${separate} shared=${sharedCount} history=${historyCount}`);
    console.log(`TIMING informal ${label} median of ${TIMING_RUNS}: listing=${median(lst)} ms sequential=${median(seq)} ms parallel=${median(par)} ms`);
    return `| ${label} | ${median(lst)} | ${median(seq)} | ${median(par)} | ${separate} | ${sharedCount} |`;
  } finally {
    removeTree(dir);
  }
}

const before = realGlobalConfigDigests(git);
mkdirSync(FIXTURE_ROOT);
console.log(`FIXTURE_ROOT ${FIXTURE_ROOT}`);
mkdirSync(join(FIXTURE_HOME, ".config"), { recursive: true });
writeFileSync(FIXTURE_GLOBAL_CONFIG, "[user]\n\tname = Arbareto Fixture\n\temail = fixture@arbareto.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n");
try {
  console.log(`GIT_VERSION ${Bun.spawnSync([git, "version"]).stdout.toString().trim()}`);
  const rows: string[] = [];
  for (const v of ["trust", "partial-reset-soft", "partial-read-tree"] as const) rows.push(await f17Case(v));
  console.log("TABLE | Case | Canaries before approval: listing and held history | Gated full read | History response | Canaries after approval: listing and held history | Gated full read | History response |");
  console.log("TABLE | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of rows) console.log(`TABLE ${r}`);
  const perf: string[] = [];
  for (const spec of [PERF_M, PERF_L]) for (const cg of [true, false]) perf.push(await perfCase(spec, cg));
  console.log("PERF_TABLE | Fixture | Listing (ms) | Sequential history (ms) | Parallel history (ms) | Processes, two listings | Processes, one shared listing |");
  console.log("PERF_TABLE | --- | --- | --- | --- | --- | --- |");
  for (const r of perf) console.log(`PERF_TABLE ${r}`);
  console.log(`VERDICT ${failures === 0 ? "no canary ran before the gate, and no held result reached a refused response" : "failed"} (${failures} failing checks)`);
} finally {
  removeFixtureRoot();
  const after = realGlobalConfigDigests(git);
  if (after.join("\n") !== before.join("\n")) throw new Error("the real global Git configuration changed");
  console.log("GLOBAL_CONFIG unchanged");
}
