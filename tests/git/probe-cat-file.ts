// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T282 probe, not a test. Run: `bun tests/git/probe-cat-file.ts`. It compares one `cat-file --batch-command -Z` per history page with one persistent process, and runs `repack -a -d` beside an open process.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { batchCommandArgs } from "../../src/git-service/commands";
import { printOrigin } from "../origin";
import { copyPerfFixture, ensurePerfFixture, PERF_M } from "../windows/perf-fixtures";
import { FIXTURE_GLOBAL_CONFIG, FIXTURE_HOME, FIXTURE_ROOT, fixtureEnv, ownedGit, realGlobalConfigDigests, removeFixtureRoot } from "./fixture-root";
import { GIT } from "./git-binary";

printOrigin("../../src/git-service/commands", import.meta.dir);
printOrigin("../windows/perf-fixtures", import.meta.dir);
printOrigin("./fixture-root", import.meta.dir);
printOrigin("./probe-cat-file", import.meta.dir);

// Contract §5 ordinary read deadline.
const DEADLINE_MS = 30_000;
// `repack -a -d` on M is no read. This bound only ends a hung probe.
const REPACK_DEADLINE_MS = 300_000;
const PAGES = 30;

if (GIT === null) throw new Error("Git executable absent");
const git = GIT;
const redact = (s: string) => s.replaceAll(FIXTURE_ROOT, "<root>").replaceAll(FIXTURE_ROOT.replaceAll("\\", "/"), "<root>");
let spawned = 0;

function run(dir: string, args: string[], deadline = DEADLINE_MS, input?: Uint8Array) {
  spawned++;
  const p = Bun.spawnSync([git, ...args], { cwd: dir, env: fixtureEnv({ LC_ALL: "C" }), stdin: input ?? "ignore", stdout: "pipe", stderr: "pipe", timeout: deadline });
  return { exit: p.exitCode ?? `signal ${p.signalCode}`, stdout: p.stdout, stderr: redact(p.stderr.toString()) };
}

interface Row {
  oid: string;
  parents: string[];
}
function page(dir: string, anchor: string): Row[] {
  // The retired 001 `revListArgs` array of one history page.
  const r = run(dir, ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs", "rev-list", "--parents", "--max-count=100", "--date-order", anchor]);
  if (r.exit !== 0) throw new Error(`rev-list exited ${r.exit}: ${r.stderr}`);
  return r.stdout.toString().trim().split("\n").map((l) => {
    const [oid, ...parents] = l.split(" ");
    return { oid: oid!, parents };
  });
}

const commands = (oids: string[]) => Buffer.from(oids.map((o) => `contents ${o}\0`).join(""));

// git-cat-file(1) with `-Z`: `<oid> SP <type> SP <size> NUL <contents> NUL`, or `<oid> SP missing NUL`.
interface Frame {
  header: string;
  body: Uint8Array | null;
}
class FrameReader {
  private buf = new Uint8Array(0);
  constructor(private next: () => Promise<Uint8Array | null>) {}
  private async fill(n: number): Promise<void> {
    while (this.buf.length < n) {
      const chunk = await this.next();
      if (chunk === null) throw new Error(`EOF with ${this.buf.length} of ${n} bytes`);
      const joined = new Uint8Array(this.buf.length + chunk.length);
      joined.set(this.buf);
      joined.set(chunk, this.buf.length);
      this.buf = joined;
    }
  }
  private take(n: number): Uint8Array {
    const out = this.buf.slice(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  async frame(): Promise<Frame> {
    let nul = this.buf.indexOf(0);
    while (nul < 0) {
      await this.fill(this.buf.length + 1);
      nul = this.buf.indexOf(0);
    }
    const header = Buffer.from(this.take(nul + 1).subarray(0, nul)).toString();
    const parts = header.split(" ");
    if (parts.length !== 3) return { header, body: null };
    const size = Number(parts[2]);
    await this.fill(size + 1);
    const body = this.take(size);
    if (this.take(1)[0] !== 0) throw new Error(`no NUL after the contents of ${header}`);
    return { header, body };
  }
}

function withDeadline<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: deadline`)), DEADLINE_MS)));
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

async function readFrames(reader: FrameReader, count: number): Promise<Frame[]> {
  const frames: Frame[] = [];
  for (let i = 0; i < count; i++) frames.push(await reader.frame());
  return frames;
}

const digest = (frames: Frame[]) => {
  const h = new Bun.CryptoHasher("sha256");
  for (const f of frames) h.update(f.header).update("\0").update(f.body ?? new Uint8Array(0));
  return h.digest("hex").slice(0, 16);
};
const missing = (frames: Frame[]) => frames.filter((f) => f.body === null).length;

// One process per page: stdin closes after the commands, so Git exits at EOF.
async function perRead(dir: string, oids: string[]): Promise<Frame[]> {
  const r = run(dir, batchCommandArgs(), DEADLINE_MS, commands(oids));
  if (r.exit !== 0) throw new Error(`cat-file exited ${r.exit}: ${r.stderr}`);
  const chunks = [new Uint8Array(r.stdout)];
  const reader = new FrameReader(async () => chunks.shift() ?? null);
  return readFrames(reader, oids.length);
}

interface Persistent {
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  read: (oids: string[]) => Promise<Frame[]>;
  close: () => Promise<number | string>;
}
function persistent(dir: string, extra: Record<string, string> = {}): Persistent {
  spawned++;
  // The spawn timeout ends a probe that hangs. Each page also has its own deadline.
  const proc = Bun.spawn([git, ...batchCommandArgs()], { cwd: dir, env: fixtureEnv({ LC_ALL: "C", ...extra }), stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: REPACK_DEADLINE_MS * 3 });
  const stderr = new Response(proc.stderr).text();
  const out = proc.stdout.getReader();
  const reader = new FrameReader(async () => {
    const r = await out.read();
    return r.done ? null : r.value;
  });
  return {
    proc,
    read: async (oids) => {
      proc.stdin.write(commands(oids));
      await proc.stdin.flush();
      return withDeadline(readFrames(reader, oids.length), "persistent page");
    },
    close: async () => {
      await proc.stdin.end();
      const code = await withDeadline(proc.exited, "persistent exit");
      const err = redact(await stderr);
      if (err !== "") console.log(`  PERSISTENT_STDERR ${JSON.stringify(err)}`);
      return code;
    },
  };
}

function packFiles(dir: string): string[] {
  const packDir = join(dir, ".git", "objects", "pack");
  return readdirSync(packDir).sort().map((n) => `${n}:${statSync(join(packDir, n)).size}`);
}
const looseCount = (dir: string, oids: string[]) => oids.filter((o) => existsSync(join(dir, ".git", "objects", o.slice(0, 2), o.slice(2)))).length;

// GIT_TRACE_PACK_ACCESS (packfile.c `write_pack_access_log`) writes one line with the pack path and the offset for each packed object read.
const traceLines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l !== "") : []);
function packAccess(path: string, from: number): string {
  const counts = new Map<string, number>();
  for (const l of traceLines(path).slice(from)) {
    const name = /pack-[0-9a-f]+\.pack/.exec(l)?.[0] ?? "unparsed";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return `pack reads=[${[...counts].map(([n, c]) => `${n}:${c}`).join(" ")}]`;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return Math.round((s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2) * 100) / 100;
};

const before = realGlobalConfigDigests(git);
mkdirSync(FIXTURE_ROOT);
console.log(`FIXTURE_ROOT ${FIXTURE_ROOT}`);
mkdirSync(join(FIXTURE_HOME, ".config"), { recursive: true });
writeFileSync(FIXTURE_GLOBAL_CONFIG, "[user]\n\tname = Arbareto Fixture\n\temail = fixture@arbareto.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n");
const open: Persistent[] = [];
let failures = 0;
try {
  console.log(`GIT_VERSION ${run(FIXTURE_ROOT, ["version"]).stdout.toString().trim()}`);
  const cached = ensurePerfFixture(git, PERF_M);
  const facts = cached.manifest.facts;
  console.log(`FIXTURE M reused=${cached.reused} commitGraph=${facts.commitGraph} commits=${facts.counts.commits} objects=${facts.counts.objects} tip=${facts.tip}`);

  // Timing on copy A, before its repack.
  const a = copyPerfFixture(git, cached, "m-open");
  const b = copyPerfFixture(git, cached, "m-closed");
  const pages: string[][] = [];
  const revListMs: number[] = [];
  let anchor = facts.tip;
  for (let i = 0; i < PAGES; i++) {
    const t = performance.now();
    const rows = page(a, anchor);
    revListMs.push(performance.now() - t);
    pages.push(rows.map((r) => r.oid));
    anchor = rows.at(-1)!.parents[0]!;
  }
  const pageOids = pages.flat();
  console.log(`PAGES ${pages.length} rows=${pageOids.length} loose=${looseCount(a, pageOids)}`);
  console.log(`PACKS_BEFORE ${packFiles(a).join(" ")}`);

  const p = persistent(a);
  open.push(p);
  const perReadMs: number[] = [];
  const persistentMs: number[] = [];
  let firstPersistentMs = 0;
  let unequal = 0;
  const startSpawned = spawned;
  for (let i = 0; i < pages.length; i++) {
    const oids = pages[i]!;
    // Alternate the order, so a warm file cache favours neither method.
    const order = i % 2 === 0 ? ["read", "persistent"] : ["persistent", "read"];
    const got: Record<string, Frame[]> = {};
    for (const m of order) {
      const t = performance.now();
      got[m] = m === "read" ? await perRead(a, oids) : await p.read(oids);
      const ms = performance.now() - t;
      if (m === "read") perReadMs.push(ms);
      else if (i === 0) firstPersistentMs = ms;
      else persistentMs.push(ms);
    }
    if (digest(got.read!) !== digest(got.persistent!) || missing(got.read!) !== 0) unequal++;
  }
  if (unequal !== 0) failures++;
  console.log(`CONTROL methods give equal frames on ${pages.length - unequal}/${pages.length} pages; missing=0`);
  console.log(`PROCESSES pages=${pages.length} per-read cat-file=${pages.length} persistent cat-file=1 (spawned in loop ${spawned - startSpawned}); rev-list per page=1 in both methods`);
  console.log(`TIMING informal, median of ${pages.length} pages: rev-list ${median(revListMs)} ms; cat-file per read ${median(perReadMs)} ms; persistent ${median(persistentMs)} ms (first page with spawn ${Math.round(firstPersistentMs * 100) / 100} ms)`);

  console.log(`  TIMING_PROCESS exit=${await p.close()}`);
  open.pop();

  // The repack arms. Each copy gets a new persistent process with a pack access trace. It reads the first and the last page.
  // Copy B closes its process before `repack`. Copy A keeps it open.
  const probe = [...pages[0]!, ...pages[PAGES - 1]!];
  const blob = ownedGit(git, FIXTURE_ROOT, a, ["rev-parse", ":perf/mixed.ts"]).toString().trim();
  console.log(`LOOSE staged blob ${blob} loose=${looseCount(a, [blob])}`);
  const traceA = join(FIXTURE_ROOT, "trace-open.txt");
  const traceB = join(FIXTURE_ROOT, "trace-closed.txt");
  const pa = persistent(a, { GIT_TRACE_PACK_ACCESS: traceA });
  open.push(pa);
  const beforeA = digest(await pa.read(probe));
  const q = persistent(b, { GIT_TRACE_PACK_ACCESS: traceB });
  open.push(q);
  const beforeB = digest(await q.read(probe));
  console.log(`  CLOSED_ARM persistent exit=${await q.close()} ${packAccess(traceB, 0)}`);
  open.pop();
  const traceLinesBefore = traceLines(traceA).length;
  console.log(`  OPEN_ARM before repack ${packAccess(traceA, 0)}`);

  const arms: [string, string][] = [["open", a], ["closed", b]];
  const rows: string[] = [];
  let openOldGone = false;
  let openExit: number | string = "";
  for (const [name, dir] of arms) {
    const old = packFiles(dir);
    console.log(`COUNT_OBJECTS_BEFORE ${name} ${run(dir, ["--no-lazy-fetch", "count-objects", "-v"]).stdout.toString().trim().replaceAll("\n", "; ")}`);
    const t = performance.now();
    const r = run(dir, ["repack", "-a", "-d"], REPACK_DEADLINE_MS);
    const ms = Math.round(performance.now() - t);
    const after = packFiles(dir);
    const kept = old.filter((f) => after.some((x) => x.split(":")[0] === f.split(":")[0]));
    console.log(`REPACK ${name} exit=${r.exit} ms=${ms} stderr=${JSON.stringify(r.stderr)}`);
    console.log(`  PACKS_AFTER ${after.join(" ")}`);
    console.log(`  OLD_FILES_KEPT ${kept.length}/${old.length} ${kept.join(" ")}`);
    const count = run(dir, ["--no-lazy-fetch", "count-objects", "-v"]);
    console.log(`  COUNT_OBJECTS ${count.stdout.toString().trim().replaceAll("\n", "; ")}`);
    const fresh = await perRead(dir, [...probe, blob]);
    console.log(`  NEW_PROCESS_READ missing=${missing(fresh)} equal=${digest(fresh.slice(0, probe.length)) === (name === "open" ? beforeA : beforeB)}`);
    if (name === "open") {
      openExit = r.exit;
      openOldGone = kept.length === 0;
      const afterRead = await pa.read([...probe, blob]);
      const equal = digest(afterRead.slice(0, probe.length)) === beforeA;
      console.log(`  OPEN_PROCESS_READ after repack: missing=${missing(afterRead)} equal=${equal} blob=${afterRead.at(-1)!.header} ${packAccess(traceA, traceLinesBefore)}`);
      if (!equal) failures++;
      console.log(`  OPEN_ARM persistent exit=${await pa.close()}`);
      open.pop();
      const leftover = packFiles(dir).filter((f) => old.includes(f));
      console.log(`  OLD_FILES_AFTER_CLOSE ${leftover.length} ${leftover.join(" ")}`);
      if (leftover.length > 0) {
        const again = run(dir, ["repack", "-a", "-d"], REPACK_DEADLINE_MS);
        const still = packFiles(dir).filter((f) => old.includes(f));
        console.log(`  SECOND_REPACK exit=${again.exit} stderr=${JSON.stringify(again.stderr)} old files left=${still.length} ${still.join(" ")}`);
        const gcCount = run(dir, ["--no-lazy-fetch", "count-objects", "-v"]);
        console.log(`  COUNT_OBJECTS ${gcCount.stdout.toString().trim().replaceAll("\n", "; ")}`);
      }
    }
    rows.push(`| ${name} | ${r.exit} | ${r.stderr.trim() === "" ? "empty" : `${r.stderr.trim().split("\n").length} lines`} | ${kept.length} of ${old.length} |`);
  }
  console.log("TABLE | Process during repack | Exit | Stderr | Old pack files kept |");
  console.log("TABLE | --- | --- | --- | --- |");
  for (const row of rows) console.log(`TABLE ${row}`);
  const allowed = openExit === 0 && openOldGone;
  console.log(`VERDICT T282 condition ${allowed ? "holds" : "fails, so T086 keeps one cat-file process per read"}: repack beside the open process exit=${openExit}, old packs removed=${openOldGone}; ${failures} failing controls`);
} finally {
  for (const p of open) {
    p.proc.kill();
    await p.proc.exited;
    console.log(`KILLED pid=${p.proc.pid}`);
  }
  removeFixtureRoot();
  const after = realGlobalConfigDigests(git);
  if (after.join("\n") !== before.join("\n")) throw new Error("the real global Git configuration changed");
  console.log("GLOBAL_CONFIG unchanged");
}
