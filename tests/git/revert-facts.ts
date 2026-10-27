// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The Git facts G3 to G10 of research.md R14 (tasks.md T001, T004). Each fact runs on a `RevertHost`, so Windows and the WSL distro share the cases.
// Exit codes, `-z` records, and file bytes decide each fact, never message text. A `match=false` line is a finding for research.md R15, not a failure.

import { obs, observationLine, type Observation } from "./fact-runner";
import { sha256 } from "./git-oracle";
import { gitOut, gitRun, type GitHost, type GitResult } from "./remote-fixtures";

export interface FileState {
  size: number;
  sha256: string;
  // The exact modification time text of the host stat.
  mtime: string;
  // The octal permission bits.
  mode: string;
}

// One host for the revert facts. Paths use `/` and lie under `git.root`.
export interface RevertHost {
  git: GitHost;
  // Every regular file below `dir`, also below `.git`, with its SHA-256. Keys are relative to `dir` with `/`.
  tree(dir: string): Record<string, string>;
  // Null when the path does not exist.
  stat(path: string): FileState | null;
  remove(path: string): void;
  // The names in one folder, without `.` and `..`.
  names(dir: string): string[];
  // The plan.md D8 and D9 write: a new file in the target folder, then a rename over the target.
  swap(target: string, bytes: Uint8Array): void;
}

export interface RevertFact {
  id: string;
  title: string;
  // A capability that the host must have (tasks.md T001 `git-lfs`).
  needs?: "git-lfs";
  // One OBSERVATION line for the whole case, and one DETAIL line per check (`caseLines`).
  group?: string;
  run(x: RevertHost): Observation[];
}

// One OBSERVATION line with the count of checks that hold, each "record" value, and each check that differs. Each check also prints a DETAIL line.
export function caseLines(task: string, group: string, observations: Observation[], host: string): string[] {
  const differs = observations.filter((o) => !o.match);
  const records = observations.filter((o) => o.expected === "record");
  const observed: Record<string, unknown> = { holds: observations.length - differs.length };
  if (records.length > 0) observed.records = Object.fromEntries(records.map((o) => [o.fact, o.observed]));
  if (differs.length > 0) observed.differs = Object.fromEntries(differs.map((o) => [o.fact, { expected: o.expected, observed: o.observed }]));
  const summary: Observation = { fact: group, expected: { holds: observations.length }, observed, match: differs.length === 0 };
  return [observationLine(task, summary, host), ...observations.map((o) => observationLine(task, o, host).replace(/^OBSERVATION/, "DETAIL"))];
}

// Prints the lines of one fact: per check, or per case with `group`.
export function factLines(task: string, fact: RevertFact, observations: Observation[], host: string): string[] {
  return fact.group === undefined ? observations.map((o) => observationLine(task, o, host)) : caseLines(task, fact.group, observations, host);
}

// plan.md D2 and contract Δ3: every argument array starts with `--no-lazy-fetch`. Reads add `--no-optional-locks` and `--literal-pathspecs`.
const STEP = ["--no-lazy-fetch"];
const READ = ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs"];
const TEMP = [...STEP, "checkout-index", "--temp", "--stdin", "-z"];
// research.md R7: the attributes that the review reads.
const ATTRS = ["text", "eol", "crlf", "ident", "filter", "working-tree-encoding", "diff"];
const NUL = "\0";
const HOOKS = ["post-checkout", "post-index-change"];
const ANY_EXIT = Array.from({ length: 256 }, (_, i) => i).concat([-1]);

const enc = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));
const run = (x: RevertHost, cwd: string, args: string[], input?: Uint8Array | string, env: Record<string, string | undefined> = {}): GitResult =>
  gitRun(x.git, cwd, args, { input: input === undefined ? undefined : typeof input === "string" ? enc(input) : input, allowExit: ANY_EXIT, env });
const must = (x: RevertHost, cwd: string, args: string[], input?: Uint8Array | string): GitResult =>
  gitRun(x.git, cwd, args, { input: input === undefined ? undefined : typeof input === "string" ? enc(input) : input });
const out = (x: RevertHost, cwd: string, args: string[], input?: Uint8Array | string) => must(x, cwd, args, input).stdout.toString("utf8");
const digestOf = (bytes: Uint8Array | null) => (bytes === null ? null : { size: bytes.length, sha256: sha256(bytes) });

let counter = 0;
const fresh = (x: RevertHost, name: string) => `${x.git.root}/${name}-${++counter}`;

function init(x: RevertHost, name: string, format: "sha1" | "sha256" = "sha1"): string {
  const dir = fresh(x, name);
  must(x, x.git.root, ["init", "-q", "-b", "main", `--object-format=${format}`, dir]);
  return dir;
}

const hookText = (name: string) => `#!/bin/sh\necho ran >> .git/${name}.marker\n`;
function installHooks(x: RevertHost, dir: string): void {
  for (const hook of HOOKS) x.git.write(`${dir}/.git/hooks/${hook}`, hookText(hook));
}
const markers = (x: RevertHost, dir: string) => x.git.existing(HOOKS.map((h) => `${dir}/.git/${h}.marker`)).map((p) => p.slice(p.lastIndexOf("/") + 1));
function clearMarkers(x: RevertHost, dir: string): void {
  for (const hook of HOOKS) x.remove(`${dir}/.git/${hook}.marker`);
}

const blob = (x: RevertHost, dir: string, bytes: Uint8Array) => out(x, dir, ["hash-object", "-w", "--no-filters", "--stdin"], bytes).trim();
function cacheinfo(x: RevertHost, dir: string, mode: string, oid: string, path: string): void {
  must(x, dir, ["update-index", "--add", "--cacheinfo", `${mode},${oid},${path}`]);
}
function commitIndex(x: RevertHost, dir: string, message: string): string {
  const tree = out(x, dir, ["write-tree"]).trim();
  const commit = out(x, dir, ["commit-tree", "-m", message, tree]).trim();
  must(x, dir, ["update-ref", "refs/heads/main", commit]);
  return commit;
}

// The blob ID of `content` in the object format (gitformat-loose(5): `blob <size>\0<content>`).
export function blobId(format: "sha1" | "sha256", content: Uint8Array): string {
  const hasher = new Bun.CryptoHasher(format);
  hasher.update(Buffer.from(`blob ${content.length}\0`));
  hasher.update(content);
  return hasher.digest("hex");
}

// ---- checkout-index --temp records (plan.md D5a step 2) ----

interface TempRecord {
  name: string;
  path: string;
}

// `<temp> TAB <path> NUL` per path (Git `builtin/checkout-index.c` `write_tempfile_record` with `-z`). Null for any other output.
function tempRecords(stdout: Buffer): TempRecord[] | null {
  const text = stdout.toString("utf8");
  if (!text.endsWith(NUL)) return null;
  const records: TempRecord[] = [];
  for (const record of text.slice(0, -1).split(NUL)) {
    const m = /^([^\t\0]+)\t([^\t\0]+)$/.exec(record);
    if (m === null) return null;
    records.push({ name: m[1]!, path: m[2]! });
  }
  return records;
}
const oneComponent = (name: string) => !name.includes("/") && !name.includes("\\") && name !== "." && name !== "..";

function checkoutTemp(x: RevertHost, dir: string, paths: string[], pre: string[] = [], extra: string[] = []): { exit: number; records: TempRecord[] | null } {
  const r = run(x, dir, [...pre, ...TEMP, ...extra], paths.map((p) => `${p}${NUL}`).join(""));
  return { exit: r.exitCode, records: r.exitCode === 0 ? tempRecords(r.stdout) : null };
}

// The size and SHA-256 of each temporary file by its index path, sorted by path.
function digestsByPath(x: RevertHost, dir: string, records: TempRecord[] | null): Record<string, ReturnType<typeof digestOf>> {
  const sorted = [...(records ?? [])].sort((p, q) => (p.path < q.path ? -1 : p.path > q.path ? 1 : 0));
  return Object.fromEntries(sorted.map((r) => [r.path, digestOf(x.git.read(`${dir}/${r.name}`))]));
}

function removeTemps(x: RevertHost, dir: string, records: TempRecord[] | null): void {
  for (const r of records ?? []) if (oneComponent(r.name)) for (const at of [dir, `${dir}/sub`]) x.remove(`${at}/${r.name}`);
}

const without = (tree: Record<string, string>, names: string[]) => Object.fromEntries(Object.entries(tree).filter(([k]) => !names.includes(k)));
function changedKeys(a: Record<string, string>, b: Record<string, string>): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.filter((k) => a[k] !== b[k]);
}

// `status --porcelain=v2 -z`: the record type, the XY field, and the path of each record (git-status(1) "Porcelain Format Version 2").
function statusPaths(stdout: Buffer): string[] {
  const records = stdout.toString("utf8").split(NUL);
  const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (r === "") continue;
    const fields = r.split(" ");
    if (fields[0] === "1") paths.push(`1 ${fields[1]} ${fields.slice(8).join(" ")}`);
    else if (fields[0] === "2") {
      paths.push(`2 ${fields[1]} ${fields.slice(9).join(" ")}`);
      i++;
    } else if (fields[0] === "u") paths.push(`u ${fields[1]} ${fields.slice(10).join(" ")}`);
    else paths.push(`${fields[0]} ${fields.slice(1).join(" ")}`);
  }
  return paths;
}

// ---- G9 and G10 fixtures ----

export interface TempCase {
  id: string;
  path: string;
  mode: "100644" | "100755";
  config: [string, string][];
  attributes: string | null;
  // Raw blob bytes. With `porcelain`, the working-tree forms that `git add` cleans.
  head: Uint8Array;
  staged: Uint8Array;
  // Working bytes that differ from both forms.
  working: Uint8Array;
  porcelain?: boolean;
  needs?: "git-lfs";
  // A test program in the fixture, at `.git/t-filter.sh`.
  filter?: boolean;
}

const FILTER_SCRIPT = "#!/bin/sh\nif [ \"$1\" = smudge ]; then exec sed 's/^clean/SMUDGED/'; else exec sed 's/^SMUDGED/clean/'; fi\n";
const LF3 = enc("one\ntwo\nthree\n");
const LF3B = enc("one\nTWO\nthree\n");
const MOD = enc("modified working bytes\n");

export const TEMP_CASES: TempCase[] = [
  { id: "none", path: "f.txt", mode: "100644", config: [], attributes: null, head: LF3, staged: LF3B, working: MOD },
  { id: "autocrlf-true", path: "f.txt", mode: "100644", config: [["core.autocrlf", "true"]], attributes: null, head: LF3, staged: LF3B, working: MOD },
  { id: "autocrlf-input", path: "f.txt", mode: "100644", config: [["core.autocrlf", "input"]], attributes: null, head: LF3, staged: LF3B, working: MOD },
  { id: "text-eol-crlf", path: "f.txt", mode: "100644", config: [], attributes: "f.txt text eol=crlf\n", head: LF3, staged: LF3B, working: MOD },
  { id: "text-auto-lf-blob", path: "f.txt", mode: "100644", config: [], attributes: "* text=auto\n", head: LF3, staged: LF3B, working: MOD },
  { id: "text-auto-crlf-blob", path: "f.txt", mode: "100644", config: [], attributes: "* text=auto\n", head: enc("one\r\ntwo\r\n"), staged: enc("one\r\nTWO\r\n"), working: MOD },
  { id: "ident", path: "f.txt", mode: "100644", config: [], attributes: "f.txt ident\n", head: enc("$Id$\none\n"), staged: enc("$Id$\nTWO\n"), working: MOD },
  {
    id: "working-tree-encoding",
    path: "f.txt",
    mode: "100644",
    config: [],
    attributes: "f.txt text working-tree-encoding=UTF-16LE-BOM\n",
    head: enc("héllo\n"),
    staged: enc("héllo TWO\n"),
    working: new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("modified\n", "utf16le")])),
  },
  {
    id: "clean-smudge-filter",
    path: "f.txt",
    mode: "100644",
    config: [
      ["filter.t.clean", "sh .git/t-filter.sh clean"],
      ["filter.t.smudge", "sh .git/t-filter.sh smudge"],
      ["filter.t.required", "true"],
    ],
    attributes: "f.txt filter=t\n",
    head: enc("clean one\nplain\n"),
    staged: enc("clean two\nplain\n"),
    working: MOD,
    filter: true,
  },
  {
    id: "lfs",
    path: "f.bin",
    mode: "100644",
    // `git lfs install` would write the global configuration, so the fixture sets the local filter only. `lfs.url` names a closed local port, so no network request can succeed.
    config: [
      ["filter.lfs.clean", "git-lfs clean -- %f"],
      ["filter.lfs.smudge", "git-lfs smudge -- %f"],
      ["filter.lfs.process", "git-lfs filter-process"],
      ["filter.lfs.required", "true"],
      ["lfs.url", "http://127.0.0.1:9/"],
    ],
    attributes: "*.bin filter=lfs diff=lfs merge=lfs -text\n",
    head: enc("lfs head content\n"),
    staged: enc("lfs staged content\n"),
    working: MOD,
    porcelain: true,
    needs: "git-lfs",
  },
  {
    id: "binary",
    path: "f.bin",
    mode: "100644",
    config: [["core.autocrlf", "true"]],
    attributes: null,
    head: new Uint8Array([0, 1, 2, 0x0a, 0x62, 0x0d, 0x0a, 0xff]),
    staged: new Uint8Array([0, 1, 3, 0x0a, 0x62, 0x0d, 0x0a, 0xfe]),
    working: MOD,
  },
  { id: "empty", path: "f.txt", mode: "100644", config: [], attributes: null, head: new Uint8Array(), staged: enc("staged\n"), working: MOD },
  // The working bytes start with `#!`, so `GitHost.write` gives the file mode 0755 off Windows, and only the content differs from the index.
  { id: "mode-100755", path: "run.sh", mode: "100755", config: [], attributes: null, head: enc("#!/bin/sh\necho head\n"), staged: enc("#!/bin/sh\necho staged\n"), working: enc("#!/bin/sh\necho modified\n") },
];

const SUB = "sub/s.txt";
const SUB_BYTES = enc("sub file\n");

function buildTempCase(x: RevertHost, c: TempCase): string {
  const dir = init(x, `g9-${c.id}`);
  for (const [key, value] of c.config) must(x, dir, ["config", key, value]);
  installHooks(x, dir);
  if (c.filter) x.git.write(`${dir}/.git/t-filter.sh`, FILTER_SCRIPT);
  if (c.porcelain) {
    if (c.attributes !== null) x.git.write(`${dir}/.gitattributes`, c.attributes);
    x.git.write(`${dir}/${SUB}`, SUB_BYTES);
    x.git.write(`${dir}/${c.path}`, c.head);
    must(x, dir, ["add", "--", ...(c.attributes !== null ? [".gitattributes"] : []), SUB, c.path]);
    must(x, dir, ["commit", "-q", "--no-verify", "-m", "head"]);
    x.git.write(`${dir}/${c.path}`, c.staged);
    must(x, dir, ["add", "--", c.path]);
  } else {
    if (c.attributes !== null) cacheinfo(x, dir, "100644", blob(x, dir, enc(c.attributes)), ".gitattributes");
    cacheinfo(x, dir, "100644", blob(x, dir, SUB_BYTES), SUB);
    cacheinfo(x, dir, c.mode, blob(x, dir, c.head), c.path);
    commitIndex(x, dir, "head");
    cacheinfo(x, dir, c.mode, blob(x, dir, c.staged), c.path);
    if (c.attributes !== null) x.git.write(`${dir}/.gitattributes`, c.attributes);
    x.git.write(`${dir}/${SUB}`, SUB_BYTES);
  }
  x.git.write(`${dir}/${c.path}`, c.working);
  return dir;
}

let copies = 0;
function copyOf(x: RevertHost, dir: string): string {
  const to = `${x.git.root}/copy-${++copies}`;
  x.git.copy(dir, to);
  return to;
}

// G9, G10, and G8 for one fixture.
function tempCase(x: RevertHost, c: TempCase): Observation[] {
  const o: Observation[] = [];
  const id = c.id;
  const dir = buildTempCase(x, c);
  const index = `${dir}/.git/index`;
  const lock = `${dir}/.git/index.lock`;
  clearMarkers(x, dir);
  const copyIndex = copyOf(x, dir);
  const copyHead = copyOf(x, dir);

  // G10 run A: the batch of two paths in the worktree root.
  const treeBefore = x.tree(dir);
  const indexBefore = x.stat(index);
  const a = checkoutTemp(x, dir, [c.path, SUB]);
  const names = a.records?.map((r) => r.name) ?? [];
  const rootNames = x.names(dir);
  o.push(obs(`G10.${id}.exit`, 0, a.exit));
  o.push(obs(`G10.${id}.records`, [c.path, SUB], a.records?.map((r) => r.path) ?? null));
  o.push(obs(`G10.${id}.name-one-component`, true, names.length === 2 && names.every(oneComponent)));
  o.push(obs(`G10.${id}.name-form`, "record", names.map((n) => n.replace(/[A-Za-z0-9]{6}$/, "XXXXXX")), true));
  o.push(obs(`G10.${id}.lands-in-root`, true, names.length === 2 && names.every((n) => rootNames.includes(n))));
  o.push(obs(`G10.${id}.other-files-unchanged`, [], changedKeys(treeBefore, without(x.tree(dir), names))));
  o.push(obs(`G10.${id}.index-unchanged`, indexBefore, x.stat(index)));
  o.push(obs(`G10.${id}.no-index-lock`, null, x.stat(lock)));
  o.push(obs(`G10.${id}.no-hook-ran`, [], markers(x, dir)));
  const tempIndex = a.records?.find((r) => r.path === c.path);
  const tempBytes = tempIndex ? x.git.read(`${dir}/${tempIndex.name}`) : null;
  const tempMode = tempIndex ? (x.stat(`${dir}/${tempIndex.name}`)?.mode ?? null) : null;
  const byPath = digestsByPath(x, dir, a.records);
  removeTemps(x, dir, a.records);

  // G10 run B: an `index.lock` exists. A command that takes the lock exits 128 (lockfile.c `unable_to_lock_die`).
  x.git.write(lock, "held\n");
  const heldBefore = x.stat(lock);
  const b = checkoutTemp(x, dir, [c.path]);
  o.push(obs(`G10.${id}.runs-with-held-lock`, { exit: 0, lock: heldBefore }, { exit: b.exit, lock: x.stat(lock) }));
  removeTemps(x, dir, b.records);
  x.remove(lock);

  // G10 run C: `-C sub`. The stdin path is relative to the subfolder.
  const cRun = checkoutTemp(x, dir, ["s.txt"], ["-C", "sub"]);
  const cName = cRun.records?.[0]?.name ?? "";
  o.push(
    obs(`G10.${id}.subfolder`, { exit: 0, path: "s.txt", lands: "root" }, {
      exit: cRun.exit,
      path: cRun.records?.[0]?.path ?? null,
      lands: cName === "" ? null : x.names(dir).includes(cName) ? "root" : x.names(`${dir}/sub`).includes(cName) ? "sub" : "absent",
    }),
  );
  removeTemps(x, dir, cRun.records);

  // G10 run D: `--prefix=pre/` (research.md R4: `write_entry` returns before the prefix applies).
  const d = checkoutTemp(x, dir, [c.path], [], ["--prefix=pre/"]);
  const dName = d.records?.[0]?.name ?? "";
  o.push(
    obs(`G10.${id}.prefix`, { exit: 0, lands: "root", prefixFolder: false }, {
      exit: d.exit,
      lands: dName === "" ? null : x.names(dir).includes(dName) ? "root" : "absent",
      prefixFolder: x.git.existing([`${dir}/pre`]).length > 0,
    }),
  );
  removeTemps(x, dir, d.records);

  // G10 run E: parallel checkout settings (git-config(1) `checkout.workers`, `checkout.thresholdForParallelism`).
  const e = checkoutTemp(x, dir, [c.path, SUB], ["-c", "checkout.workers=4", "-c", "checkout.thresholdForParallelism=1"]);
  o.push(obs(`G10.${id}.workers-same-files`, byPath, digestsByPath(x, dir, e.records)));
  removeTemps(x, dir, e.records);

  // G9 index form against `git restore --worktree` on a copy.
  const restored = run(x, copyIndex, [...STEP, "restore", "--worktree", "--", c.path]);
  const oracle = restored.exitCode === 0 ? x.git.read(`${copyIndex}/${c.path}`) : null;
  o.push(obs(`G9.${id}.index-form`, digestOf(oracle), digestOf(tempBytes)));
  // Controls: the hooks of the fixture run for Git's own restore and update-index, so their absence above is a fact.
  o.push(obs(`G10.${id}.control-restore-runs-post-checkout`, true, markers(x, copyIndex).includes("post-checkout.marker")));
  if (c.mode === "100755") o.push(obs(`G9.${id}.modes`, "record", { temp: tempMode, restored: x.stat(`${copyIndex}/${c.path}`)?.mode ?? null }, true));

  // G8: the Arbareto-style write of the G9 bytes, then a status read without optional locks.
  if (tempBytes !== null) {
    x.swap(`${dir}/${c.path}`, tempBytes);
    const before = x.stat(index);
    const status = run(x, dir, [...READ, "status", "--porcelain=v2", "-z", "--untracked-files=no"]);
    // The staged change stays (X = M), and the worktree column shows no change (Y = .).
    o.push(obs(`G8.${id}.index-form`, { exit: 0, records: [`1 M. ${c.path}`], index: before }, { exit: status.exitCode, records: statusPaths(status.stdout), index: x.stat(index) }));
  }

  // The HEAD entry in the index (plan.md D5 index part), then the G9 head form against `git restore --source=HEAD --staged --worktree` on a copy.
  const headEntry = out(x, dir, ["ls-tree", "-z", "HEAD", "--", c.path]);
  run(x, dir, ["update-index", "-z", "--index-info"], headEntry);
  o.push(obs(`G10.${id}.control-update-index-runs-post-index-change`, true, markers(x, dir).includes("post-index-change.marker")));
  clearMarkers(x, dir);
  const h = checkoutTemp(x, dir, [c.path]);
  const headTemp = h.records?.[0];
  const headBytes = headTemp ? x.git.read(`${dir}/${headTemp.name}`) : null;
  removeTemps(x, dir, h.records);
  const restoredHead = run(x, copyHead, [...STEP, "restore", "--source=HEAD", "--staged", "--worktree", "--", c.path]);
  const headOracle = restoredHead.exitCode === 0 ? x.git.read(`${copyHead}/${c.path}`) : null;
  o.push(obs(`G9.${id}.head-form`, digestOf(headOracle), digestOf(headBytes)));
  if (headBytes !== null) {
    x.swap(`${dir}/${c.path}`, headBytes);
    const before = x.stat(index);
    const status = run(x, dir, [...READ, "status", "--porcelain=v2", "-z", "--untracked-files=no"]);
    o.push(obs(`G8.${id}.head-form`, { exit: 0, records: [], index: before }, { exit: status.exitCode, records: statusPaths(status.stdout), index: x.stat(index) }));
  }
  return o;
}

// ---- G3 hash-object --path ----

const FSMONITOR = "#!/bin/sh\necho ran >> .git/fsmonitor.marker\nexit 1\n";

function g3(x: RevertHost): Observation[] {
  const o: Observation[] = [];
  for (const format of ["sha1", "sha256"] as const) {
    const dir = init(x, `g3-${format}`, format);
    const marker = `${dir}/.git/fsmonitor.marker`;
    must(x, dir, ["config", "core.autocrlf", "true"]);
    x.git.write(`${dir}/.git/fsmonitor.sh`, FSMONITOR);
    must(x, dir, ["config", "core.fsmonitor", ".git/fsmonitor.sh"]);
    cacheinfo(x, dir, "100644", blob(x, dir, enc("a\n")), "f.txt");
    x.git.write(`${dir}/f.txt`, "a\r\n");
    const objectsBefore = Object.keys(x.tree(`${dir}/.git/objects`)).sort();
    const countBefore = out(x, dir, ["count-objects", "-v"]);
    // `update-index` above loads the index, so the fsmonitor command already ran once.
    x.remove(marker);
    const proof = run(x, dir, [...READ, "hash-object", "--path=f.txt", "--stdin"], "x\r\ny\r\n");
    const ranForProof = x.git.existing([marker]).length > 0;
    o.push(obs(`G3.${format}.blob-id-of-check-in-form`, { exit: 0, id: blobId(format, enc("x\ny\n")) }, { exit: proof.exitCode, id: proof.stdout.toString("utf8").trim() }));
    o.push(obs(`G3.${format}.no-object-written`, { loose: objectsBefore, count: countBefore }, { loose: Object.keys(x.tree(`${dir}/.git/objects`)).sort(), count: out(x, dir, ["count-objects", "-v"]) }));
    o.push(obs(`G3.${format}.fsmonitor-not-run`, false, ranForProof));
    // Control: a status read runs the fsmonitor command (git-config(1) `core.fsmonitor`).
    x.remove(marker);
    run(x, dir, ["status", "--porcelain=v2", "-z"]);
    o.push(obs(`G3.${format}.control-status-runs-fsmonitor`, true, x.git.existing([marker]).length > 0));
  }
  return o;
}

// ---- G4 check-attr against check-attr --cached ----

// `check-attr -z`: `<path> NUL <attribute> NUL <info> NUL` (git-check-attr(1) "OUTPUT").
function attrs(x: RevertHost, dir: string, cached: boolean): Record<string, string> | null {
  const r = run(x, dir, [...READ, "check-attr", ...(cached ? ["--cached"] : []), "-z", "--stdin", ...ATTRS], `a.txt${NUL}`);
  if (r.exitCode !== 0) return null;
  const parts = r.stdout.toString("utf8").split(NUL);
  if (parts.pop() !== "" || parts.length % 3 !== 0) return null;
  const values: Record<string, string> = {};
  for (let i = 0; i < parts.length; i += 3) values[parts[i + 1]!] = parts[i + 2]!;
  return values;
}
const differing = (a: Record<string, string> | null, b: Record<string, string> | null) => (a === null || b === null ? null : ATTRS.filter((k) => a[k] !== b[k]));

function g4(x: RevertHost): Observation[] {
  const dir = init(x, "g4");
  const base = "a.txt text eol=lf\n";
  cacheinfo(x, dir, "100644", blob(x, dir, enc(base)), ".gitattributes");
  cacheinfo(x, dir, "100644", blob(x, dir, enc("a\n")), "a.txt");
  commitIndex(x, dir, "head");
  x.git.write(`${dir}/.gitattributes`, base);
  x.git.write(`${dir}/a.txt`, "a\n");
  const o: Observation[] = [];
  const w0 = attrs(x, dir, false);
  const c0 = attrs(x, dir, true);
  o.push(obs("G4.same-without-change", { differ: [], text: "set", eol: "lf" }, { differ: differing(w0, c0), text: w0?.text, eol: w0?.eol }));
  // An unstaged change sets eol=crlf and ident in the working file only.
  x.git.write(`${dir}/.gitattributes`, "a.txt text eol=crlf ident\n");
  const w1 = attrs(x, dir, false);
  const c1 = attrs(x, dir, true);
  o.push(obs("G4.unstaged-change", { differ: ["eol", "ident"], working: { eol: "crlf", ident: "set" }, cached: { eol: "lf", ident: "unspecified" } }, {
    differ: differing(w1, c1),
    working: { eol: w1?.eol, ident: w1?.ident },
    cached: { eol: c1?.eol, ident: c1?.ident },
  }));
  // A staged change unsets text, drops eol, and sets a filter in the index only.
  cacheinfo(x, dir, "100644", blob(x, dir, enc("a.txt -text filter=x\n")), ".gitattributes");
  x.git.write(`${dir}/.gitattributes`, base);
  const w2 = attrs(x, dir, false);
  const c2 = attrs(x, dir, true);
  o.push(obs("G4.staged-change", { differ: ["text", "eol", "filter"], working: { text: "set", eol: "lf", filter: "unspecified" }, cached: { text: "unset", eol: "unspecified", filter: "x" } }, {
    differ: differing(w2, c2),
    working: { text: w2?.text, eol: w2?.eol, filter: w2?.filter },
    cached: { text: c2?.text, eol: c2?.eol, filter: c2?.filter },
  }));
  return o;
}

// ---- G5 ls-files --eol and the R5 rule with the hash-object proof ----

// `ls-files --eol -z`: `i/<eol> SP+ w/<eol> SP+ attr/<attr> TAB <path> NUL` (git-ls-files(1) `--eol`).
function eolOf(x: RevertHost, dir: string, paths: string[]): Record<string, string> | null {
  const r = run(x, dir, [...READ, "ls-files", "--eol", "-z", "--", ...paths]);
  if (r.exitCode !== 0) return null;
  const values: Record<string, string> = {};
  for (const record of r.stdout.toString("utf8").split(NUL)) {
    if (record === "") continue;
    const m = /^i\/(\S*) +w\/(\S*) +attr\/[^\t]*\t(.+)$/.exec(record);
    if (m === null) return null;
    values[m[3]!] = m[2]!;
  }
  return values;
}

// data-model.md §6 steps 1 to 4 for a whole-hunk revert. Each hunk of a `-U0` diff replaces its new-side lines with its old-side lines.
function reverseHunks(working: Buffer, diff: string, eol: string): Buffer {
  const lines = working.toString("latin1").match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const hunks: { at: number; count: number; restored: string[] }[] = [];
  let current: (typeof hunks)[number] | null = null;
  for (const line of diff.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m !== null) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      current = { at: count === 0 ? start : start - 1, count, restored: [] };
      hunks.push(current);
    } else if (current !== null && line.startsWith("-")) current.restored.push(line.slice(1));
  }
  for (const hunk of hunks.reverse()) {
    const restored = hunk.restored.map((comparison) => {
      if (!comparison.endsWith("\n")) return comparison;
      const body = comparison.replace(/\r?\n$/, "");
      return eol === "crlf" ? `${body}\r\n` : eol === "lf" ? `${body}\n` : comparison;
    });
    lines.splice(hunk.at, hunk.count, ...restored);
  }
  return Buffer.from(lines.join(""), "latin1");
}

interface EolCase {
  id: string;
  config: [string, string][];
  attributes: string | null;
  index: string;
  working: string;
  // The data-model.md §6 row. `null` marks a case that another reason refuses first, so the proof result is a record only.
  expected: { eol: string; proof: "pass" | "fail" | null };
}

const EOL_CASES: EolCase[] = [
  { id: "lf-none", config: [], attributes: null, index: "a\nb\nc\n", working: "a\nB\nc\n", expected: { eol: "lf", proof: "pass" } },
  { id: "crlf-none-index-crlf", config: [], attributes: null, index: "a\r\nb\r\nc\r\n", working: "a\r\nB\r\nc\r\n", expected: { eol: "crlf", proof: "pass" } },
  { id: "crlf-autocrlf-true", config: [["core.autocrlf", "true"]], attributes: null, index: "a\nb\nc\n", working: "a\r\nB\r\nc\r\n", expected: { eol: "crlf", proof: "pass" } },
  { id: "crlf-text-eol-crlf", config: [], attributes: "f.txt text eol=crlf\n", index: "a\nb\nc\n", working: "a\r\nB\r\nc\r\n", expected: { eol: "crlf", proof: "pass" } },
  { id: "lf-autocrlf-true", config: [["core.autocrlf", "true"]], attributes: null, index: "a\nb\nc\n", working: "a\nB\nc\n", expected: { eol: "lf", proof: "pass" } },
  { id: "crlf-none-index-lf", config: [], attributes: null, index: "a\nb\nc\n", working: "a\r\nB\r\nc\r\n", expected: { eol: "crlf", proof: "fail" } },
  { id: "mixed", config: [], attributes: null, index: "a\nb\nc\n", working: "a\nB\r\nc\n", expected: { eol: "mixed", proof: null } },
  { id: "ident", config: [], attributes: "f.txt ident\n", index: "a\n$Id$\nc\n", working: "a\nX\nc\n", expected: { eol: "lf", proof: null } },
];

function g5(x: RevertHost): Observation[] {
  const o: Observation[] = [];
  // The `w/` value of each working form (support.ts `EOL_STATS`). Git `convert.c` `gather_convert_stats_ascii` gives `none` for a file without a line ending,
  // also an empty one, and `get_wt_convert_stats_ascii` gives an empty value for a file that it cannot read, such as a deleted one.
  const forms: [string, Uint8Array | null, string][] = [
    ["lf.txt", enc("a\nb\n"), "lf"],
    ["crlf.txt", enc("a\r\nb\r\n"), "crlf"],
    ["mixed.txt", enc("a\nb\r\n"), "mixed"],
    ["none.txt", enc("abc"), "none"],
    ["bin.dat", new Uint8Array([0x61, 0, 0x62, 0x0a]), "-text"],
    ["empty.txt", new Uint8Array(), "none"],
    ["deleted.txt", null, ""],
  ];
  const dir = init(x, "g5-forms");
  for (const [name, bytes] of forms) {
    cacheinfo(x, dir, "100644", blob(x, dir, bytes ?? enc("deleted\n")), name);
    if (bytes !== null) x.git.write(`${dir}/${name}`, bytes);
  }
  const eols = eolOf(x, dir, forms.map(([n]) => n));
  o.push(obs("G5.working-forms", Object.fromEntries(forms.map(([n, , w]) => [n, w])), eols === null ? null : Object.fromEntries(forms.map(([n]) => [n, eols[n] ?? null]))));

  for (const c of EOL_CASES) {
    const repo = init(x, `g5-${c.id}`);
    for (const [key, value] of c.config) must(x, repo, ["config", key, value]);
    if (c.attributes !== null) {
      cacheinfo(x, repo, "100644", blob(x, repo, enc(c.attributes)), ".gitattributes");
      x.git.write(`${repo}/.gitattributes`, c.attributes);
    }
    const indexOid = blob(x, repo, enc(c.index));
    cacheinfo(x, repo, "100644", indexOid, "f.txt");
    commitIndex(x, repo, "head");
    x.git.write(`${repo}/f.txt`, c.working);
    const eol = eolOf(x, repo, ["f.txt"])?.["f.txt"] ?? null;
    const diff = out(x, repo, [...READ, "diff", "--no-color", "--no-ext-diff", "--no-renames", "-U0", "--", "f.txt"]);
    const bytes = reverseHunks(Buffer.from(c.working, "latin1"), diff, eol ?? "");
    const proof = out(x, repo, [...READ, "hash-object", "--path=f.txt", "--stdin"], bytes).trim();
    const observed = { eol, proof: proof === indexOid ? "pass" : "fail" };
    o.push(obs(`G5.${c.id}`, c.expected.proof === null ? { eol: c.expected.eol } : c.expected, c.expected.proof === null ? { eol } : observed));
    if (c.expected.proof === null) {
      // research.md R6: for `ident`, compare the proof with the bytes that Git's own checkout writes.
      const copy = copyOf(x, repo);
      run(x, copy, [...STEP, "restore", "--worktree", "--", "f.txt"]);
      o.push(obs(`G5.${c.id}.record`, "record", { proof: observed.proof, sameAsRestore: Buffer.compare(bytes, x.git.read(`${copy}/f.txt`) ?? Buffer.alloc(0)) === 0 }, true));
    }
  }
  return o;
}

// ---- G7 restore of a staged new file ----

function g7(x: RevertHost): Observation[] {
  const dir = init(x, "g7");
  cacheinfo(x, dir, "100644", blob(x, dir, enc("a\n")), "a.txt");
  commitIndex(x, dir, "head");
  x.git.write(`${dir}/a.txt`, "a\n");
  x.git.write(`${dir}/new.txt`, "new\n");
  must(x, dir, ["add", "--", "new.txt"]);
  const r = run(x, dir, [...STEP, "restore", "--source=HEAD", "--staged", "--worktree", "--", "new.txt"]);
  const entry = out(x, dir, [...READ, "ls-files", "-z", "--stage", "--", "new.txt"]);
  return [obs("G7.staged-new-file", { exit: 0, working: false, index: false }, { exit: r.exitCode, working: x.git.existing([`${dir}/new.txt`]).length > 0, index: entry !== "" })];
}

export const REVERT_FACTS: RevertFact[] = [
  { id: "G3", title: "hash-object --path --stdin writes no object and runs no fsmonitor command", run: g3 },
  { id: "G4", title: "check-attr and check-attr --cached before and after a .gitattributes change", run: g4 },
  { id: "G5", title: "ls-files --eol values and the R5 rule with the hash-object proof", run: g5 },
  { id: "G7", title: "restore --source=HEAD --staged --worktree removes a staged new file", run: g7 },
  ...TEMP_CASES.map((c): RevertFact => ({ id: `G9 G10 G8 ${c.id}`, title: "checkout-index --temp against git restore, the temporary file facts, and a status read after the write", needs: c.needs, group: `G9-G10-G8.${c.id}`, run: (x) => tempCase(x, c) })),
];

export function revertGitVersion(x: RevertHost): string {
  const text = gitOut(x.git, x.git.root, ["version"]).trim();
  const m = /^git version (\S+)$/.exec(text);
  if (m === null) throw new Error(`git version output refused: ${JSON.stringify(text)}`);
  return m[1]!;
}
