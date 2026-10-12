// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T244: test-only external-change helper (plan.md "Measurements and budgets", "Restore start state").
// Usage:
//   bun tests/windows/external-change.ts <file|index|ref> <fixture path> [--git <exe>] [--wsl <distro>]
//   bun tests/windows/external-change.ts --restore <fixture path> [--git <exe>] [--wsl <distro>]
//   bun tests/windows/external-change.ts --snapshot <fixture path> [--git <exe>]
//   bun tests/windows/external-change.ts --restore-state <fixture path> [--git <exe>]
// Git runs without the global and system configuration, so no user hook or setting applies to a change.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { qpc } from "./inject";

type Code = "BAD_ARGUMENT" | "REFUSED" | "STATE" | "GIT_FAILED" | "RESTORE_MISMATCH" | "LINK";
const EXIT: Record<Code, number> = { BAD_ARGUMENT: 2, REFUSED: 3, STATE: 4, GIT_FAILED: 5, RESTORE_MISMATCH: 6, LINK: 7 };

export class ChangeError extends Error {
  constructor(
    readonly code: Code,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

export type Kind = "file" | "index" | "ref";
const KINDS = new Set<string>(["file", "index", "ref"]);
const ROOT_PREFIX = "arbareto-fixtures-";
const TEST_BRANCH = "refs/heads/arbareto-external-change";
const LINE = Buffer.from("arbareto external change\n");

// The file system and Git of the place that holds the fixture. Paths use that place's form.
interface Host {
  repo: string;
  join(rel: string): string;
  // Refuses with LINK when the path or a folder on it below the fixture is a link or a reparse point.
  plain(rel: string): void;
  git(args: string[], input?: Uint8Array, allow?: number[]): { exitCode: number; stdout: Buffer };
  read(path: string): Buffer | null;
  write(path: string, bytes: Uint8Array): void;
  append(path: string, bytes: Uint8Array): void;
  remove(path: string): void;
}

function spawn(argv: string[], env: Record<string, string> | undefined, cwd: string | undefined, input: Uint8Array | undefined, allow: number[], what: string) {
  const proc = Bun.spawnSync(argv, { cwd, env, stdin: input ?? "ignore", stdout: "pipe", stderr: "pipe" });
  if (!allow.includes(proc.exitCode)) throw new ChangeError("GIT_FAILED", `${what} exited ${proc.exitCode}: ${proc.stderr.toString().trim()}`);
  return { exitCode: proc.exitCode, stdout: proc.stdout };
}

// `winnt.h` FILE_ATTRIBUTE_REPARSE_POINT covers symbolic links, junctions, and every other reparse tag. `GetFileAttributesW` does not follow the reparse point.
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const INVALID_FILE_ATTRIBUTES = 0xffff_ffff;
let kernel32: { GetFileAttributesW: (path: unknown) => number } | undefined;

function attributes(path: string): number {
  kernel32 ??= dlopen("kernel32.dll", { GetFileAttributesW: { args: [FFIType.ptr], returns: FFIType.u32 } }).symbols as never;
  return kernel32!.GetFileAttributesW(ptr(Buffer.from(`${path}\0`, "utf16le")));
}

function windowsHost(git: string, path: string): Host {
  let repo: string;
  try {
    repo = realpathSync.native(path);
  } catch {
    throw new ChangeError("REFUSED", `no such fixture: ${path}`);
  }
  // The real path must lie below `<temp>/arbareto-fixtures-<name>`, never at the root itself.
  const rel = relative(realpathSync.native(tmpdir()), repo);
  const segments = rel.split(sep);
  if (isAbsolute(rel) || segments.length < 2 || !segments[0]!.startsWith(ROOT_PREFIX) || segments[0] === ROOT_PREFIX || segments.includes("..")) {
    throw new ChangeError("REFUSED", `outside an ${ROOT_PREFIX} root: ${repo}`);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/^GIT_/i.test(key)) env[key] = value;
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
  return {
    repo,
    join: (r) => join(repo, r),
    plain: (r) => {
      let at = repo;
      for (const segment of r.split("/")) {
        at = join(at, segment);
        const attrs = attributes(at);
        if (attrs === INVALID_FILE_ATTRIBUTES) return;
        if ((attrs & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) throw new ChangeError("LINK", `link or reparse point: ${at}`);
      }
    },
    git: (args, input, allow = [0]) => spawn([git, ...args], env, repo, input, allow, `git ${args[0]}`),
    read: (p) => (existsSync(p) ? readFileSync(p) : null),
    write: (p, bytes) => writeFileSync(p, bytes),
    append: (p, bytes) => writeFileSync(p, bytes, { flag: "a" }),
    remove: (p) => unlinkSync(p),
  };
}

// Each call is one `wsl.exe --exec` process. The distro Git runs.
function wslHost(distro: string, path: string): Host {
  const wsl = (argv: string[], input?: Uint8Array, allow = [0]) => spawn(["wsl.exe", "-d", distro, "--exec", ...argv], undefined, undefined, input, allow, `wsl ${argv[0]}`);
  const out = wsl(["sh", "-c", 'realpath -e -- "$1" && printf "%s\\n" "$HOME"', "sh", path], undefined, [0, 1]);
  const [repo, home] = out.stdout.toString("utf8").split("\n");
  if (out.exitCode !== 0 || !repo || !home) throw new ChangeError("REFUSED", `no such fixture in ${distro}: ${path}`);
  const rest = repo.startsWith(`${home}/${ROOT_PREFIX}`) ? repo.slice(home.length + 1).split("/") : [];
  if (rest.length < 2 || rest[0] === ROOT_PREFIX || rest.includes("..")) throw new ChangeError("REFUSED", `outside ${home}/${ROOT_PREFIX}<name>: ${repo}`);
  return {
    repo,
    join: (r) => `${repo}/${r}`,
    plain: (r) => {
      const got = wsl(["sh", "-c", 'p="$1"; shift; for s; do p="$p/$s"; if [ -h "$p" ]; then exit 7; fi; done', "sh", repo, ...r.split("/")], undefined, [0, 7]);
      if (got.exitCode === 7) throw new ChangeError("LINK", `symbolic link on ${repo}/${r}`);
    },
    git: (args, input, allow = [0]) => wsl(["env", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "git", "-C", repo, ...args], input, allow),
    read: (p) => {
      const got = wsl(["sh", "-c", '[ -e "$1" ] || exit 3; cat -- "$1"', "sh", p], undefined, [0, 3]);
      return got.exitCode === 3 ? null : got.stdout;
    },
    write: (p, bytes) => void wsl(["sh", "-c", 'cat > "$1"', "sh", p], bytes),
    append: (p, bytes) => void wsl(["sh", "-c", 'cat >> "$1"', "sh", p], bytes),
    remove: (p) => void wsl(["rm", "--", p]),
  };
}

// `git status --porcelain=v2 -z` records (git-status(1)): "1" has 8 fields before the path, "2" has 9 and then the original path, "u" has 10.
export function statusPaths(out: Buffer): string[] {
  const records = out.toString("utf8").split("\0");
  const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record === "") continue;
    const fields = { "1": 8, "2": 9, u: 10, "?": 1, "!": 1 }[record[0]!];
    if (fields === undefined || record[1] !== " ") throw new ChangeError("STATE", `unknown status record ${JSON.stringify(record)}`);
    paths.push(record.split(" ").slice(fields).join(" "));
    if (record[0] === "2") paths.push(records[++i]!);
  }
  return paths;
}

const status = (host: Host) => host.git(["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all"]).stdout;

interface Entry {
  mode: string;
  oid: string;
  path: string;
}

// The first index entry, in index order, with stage 0, mode 100644, LF-only text in the index and the work tree (`ls-files --eol`), and no status record.
function cleanTextFile(host: Host): Entry {
  const listed = new Set(statusPaths(status(host)));
  const eol = new Map<string, string[]>();
  for (const record of host.git(["--no-optional-locks", "ls-files", "-z", "--eol"]).stdout.toString("utf8").split("\0")) {
    const tab = record.indexOf("\t");
    if (tab >= 0) eol.set(record.slice(tab + 1), record.slice(0, tab).trim().split(/ +/));
  }
  for (const record of host.git(["--no-optional-locks", "ls-files", "-z", "-s"]).stdout.toString("utf8").split("\0")) {
    const match = /^(\d{6}) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(record);
    if (!match) continue;
    const [, mode, oid, stage, path] = match;
    const info = eol.get(path!);
    if (stage === "0" && mode === "100644" && info?.[0] === "i/lf" && info[1] === "w/lf" && !listed.has(path!)) return { mode: mode!, oid: oid!, path: path! };
  }
  throw new ChangeError("STATE", `no clean tracked LF text file in ${host.repo}`);
}

type Record_ = { kind: "file"; path: string; bytes: string } | { kind: "index"; path: string; mode: string; oid: string } | { kind: "ref"; oid: string };

const recordPath = (host: Host) => `${host.repo}.external-change.json`;

export function makeChange(host: Host, kind: Kind): { start: bigint; end: bigint; path: string | null } {
  const record = recordPath(host);
  if (host.read(record) !== null) throw new ChangeError("STATE", `restore first: ${record} exists`);
  if (kind === "ref") {
    const head = host.git(["rev-parse", "--verify", "HEAD"]).stdout.toString().trim();
    host.write(record, Buffer.from(JSON.stringify({ kind, oid: head } satisfies Record_)));
    const start = qpc();
    // The empty old value makes Git refuse when the branch exists (git-update-ref(1)).
    host.git(["update-ref", TEST_BRANCH, head, ""]);
    return { start, end: qpc(), path: null };
  }
  const entry = cleanTextFile(host);
  if (kind === "file") {
    host.plain(entry.path);
    const file = host.join(entry.path);
    host.write(record, Buffer.from(JSON.stringify({ kind, path: entry.path, bytes: host.read(file)!.toString("base64") } satisfies Record_)));
    const start = qpc();
    host.append(file, LINE);
    return { start, end: qpc(), path: entry.path };
  }
  // Without `--path`, hash-object applies no filter, so the blob holds these exact bytes.
  const blob = Buffer.concat([host.git(["cat-file", "blob", entry.oid]).stdout, LINE]);
  const oid = host.git(["hash-object", "-w", "--stdin"], blob).stdout.toString().trim();
  host.write(record, Buffer.from(JSON.stringify({ kind, path: entry.path, mode: entry.mode, oid: entry.oid } satisfies Record_)));
  const start = qpc();
  host.git(["update-index", "--add", "--cacheinfo", `${entry.mode},${oid},${entry.path}`]);
  return { start, end: qpc(), path: entry.path };
}

export function restoreChange(host: Host): Kind {
  const file = recordPath(host);
  const bytes = host.read(file);
  if (bytes === null) throw new ChangeError("STATE", `no change record: ${file}`);
  const record = JSON.parse(bytes.toString("utf8")) as Record_;
  if (record.kind === "file") host.write(host.join(record.path), Buffer.from(record.bytes, "base64"));
  else if (record.kind === "index") host.git(["update-index", "--cacheinfo", `${record.mode},${record.oid},${record.path}`]);
  else {
    // A crash before the change leaves the branch absent; then nothing needs a delete.
    const exists = host.git(["show-ref", "--verify", "--quiet", TEST_BRANCH], undefined, [0, 1]).exitCode === 0;
    if (exists) host.git(["update-ref", "-d", TEST_BRANCH, record.oid]);
  }
  host.remove(file);
  return record.kind;
}

interface Ref {
  name: string;
  oid: string;
  symref: string;
}

interface Snapshot {
  index: string;
  head: { target: string | null; oid: string | null };
  refs: Ref[];
  files: Record<string, string | null>;
}

const indexPath = (host: Host) => resolve(host.repo, host.git(["rev-parse", "--git-path", "index"]).stdout.toString("utf8").trimEnd());

function readRefs(host: Host): Ref[] {
  // Ref names hold no NUL and no line end (git-check-ref-format(1)).
  return host
    .git(["--no-optional-locks", "for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)"])
    .stdout.toString("utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [name, oid, symref] = line.split("\0");
      return { name: name!, oid: oid!, symref: symref! };
    });
}

export function readState(host: Host): Snapshot {
  const index = host.read(indexPath(host));
  if (index === null) throw new ChangeError("STATE", `no index file in ${host.repo}`);
  // `symbolic-ref -q` exits 1 for a detached HEAD, and `rev-parse --verify -q` exits 1 for an unborn branch.
  const target = host.git(["symbolic-ref", "-q", "HEAD"], undefined, [0, 1]).stdout.toString().trim();
  const oid = host.git(["rev-parse", "--verify", "-q", "HEAD"], undefined, [0, 1]).stdout.toString().trim();
  const files: Record<string, string | null> = {};
  for (const path of statusPaths(status(host))) {
    host.plain(path);
    files[path] = host.read(host.join(path))?.toString("base64") ?? null;
  }
  return { index: index.toString("base64"), head: { target: target || null, oid: oid || null }, refs: readRefs(host), files };
}

const snapshotPath = (host: Host) => `${host.repo}.snapshot.json`;

export function snapshot(host: Host): void {
  host.write(snapshotPath(host), Buffer.from(JSON.stringify(readState(host))));
}

// Writes contents only. The top-level folder and the `.git` folder keep their file IDs.
export function restoreState(host: Host): void {
  const bytes = host.read(snapshotPath(host));
  if (bytes === null) throw new ChangeError("STATE", `no snapshot: ${snapshotPath(host)}`);
  const saved = JSON.parse(bytes.toString("utf8")) as Snapshot;
  for (const path of statusPaths(status(host))) {
    if (!(path in saved.files)) throw new ChangeError("STATE", `${path} has a status record that the snapshot lacks`);
  }
  // Git's own lock protocol: create `index.lock` exclusively, write it, and rename it over the index. The lock is held while the files change.
  const index = indexPath(host);
  const lock = `${index}.lock`;
  let fd: number;
  try {
    fd = openSync(lock, "wx");
  } catch (error) {
    throw new ChangeError("STATE", `cannot create ${lock}: ${(error as Error).message}`);
  }
  let renamed = false;
  try {
    try {
      writeSync(fd, Buffer.from(saved.index, "base64"));
    } finally {
      closeSync(fd);
    }
    for (const [path, content] of Object.entries(saved.files)) {
      host.plain(path);
      const file = host.join(path);
      if (content === null) {
        if (host.read(file) !== null) host.remove(file);
        continue;
      }
      mkdirSync(dirname(file), { recursive: true });
      host.write(file, Buffer.from(content, "base64"));
    }
    try {
      renameSync(lock, index);
      renamed = true;
    } catch (error) {
      throw new ChangeError("STATE", `cannot rename ${lock}: ${(error as Error).message}`);
    }
  } finally {
    if (!renamed) unlinkSync(lock);
  }
  if (saved.head.target !== null) host.git(["symbolic-ref", "HEAD", saved.head.target]);
  else host.git(["update-ref", "--no-deref", "HEAD", saved.head.oid!]);
  const keep = new Map(saved.refs.map((r) => [r.name, r]));
  let commands = "";
  for (const ref of readRefs(host)) {
    if (keep.has(ref.name)) continue;
    if (ref.symref !== "") host.git(["symbolic-ref", "--delete", ref.name]);
    else commands += `delete ${ref.name}\0\0`;
  }
  for (const ref of saved.refs) {
    if (ref.symref !== "") host.git(["symbolic-ref", ref.name, ref.symref]);
    else commands += `update ${ref.name}\0${ref.oid}\0\0`;
  }
  host.git(["update-ref", "--stdin", "-z"], Buffer.from(commands));
  const now = readState(host);
  const differs = (["index", "head", "refs", "files"] as const).filter((key) => JSON.stringify(now[key]) !== JSON.stringify(saved[key]));
  if (differs.length > 0) throw new ChangeError("RESTORE_MISMATCH", `${differs.join(", ")} differ from the snapshot`);
}

function parse(argv: string[]): { mode: string; path: string; git: string | null; wsl: string | null } {
  const rest: string[] = [];
  let git: string | null = null;
  let wsl: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--git" || arg === "--wsl") {
      const value = argv[++i];
      if (value === undefined || value === "") throw new ChangeError("BAD_ARGUMENT", `${arg} needs a value`);
      if (arg === "--git") git = value;
      else wsl = value;
    } else rest.push(arg);
  }
  const [mode, path] = rest;
  const modes = ["--restore", "--snapshot", "--restore-state"];
  if (rest.length !== 2 || !(KINDS.has(mode!) || modes.includes(mode!))) throw new ChangeError("BAD_ARGUMENT", "usage: <file|index|ref|--restore|--snapshot|--restore-state> <fixture path> [--git <exe>] [--wsl <distro>]");
  if (wsl !== null && (mode === "--snapshot" || mode === "--restore-state")) throw new ChangeError("BAD_ARGUMENT", `${mode} supports Windows fixtures only`);
  return { mode: mode!, path: path!, git, wsl };
}

if (import.meta.main) {
  try {
    const args = parse(process.argv.slice(2));
    let host: Host;
    if (args.wsl !== null) host = wslHost(args.wsl, args.path);
    else {
      // The matched Git executable must be named. PATH lookup is refused.
      const git = args.git ?? process.env.ARBARETO_TEST_GIT;
      if (!git) throw new ChangeError("BAD_ARGUMENT", "no Git executable: pass --git <exe> or set ARBARETO_TEST_GIT");
      console.log(`GIT ${git}`);
      host = windowsHost(git, args.path);
    }
    console.log(`FIXTURE ${host.repo}`);
    if (args.mode === "--restore") console.log(`RESTORED kind=${restoreChange(host)}`);
    else if (args.mode === "--snapshot") {
      snapshot(host);
      console.log(`SNAPSHOT ${snapshotPath(host)}`);
    } else if (args.mode === "--restore-state") {
      restoreState(host);
      console.log(`RESTORED_STATE ${snapshotPath(host)}`);
    } else {
      const { start, end, path } = makeChange(host, args.mode as Kind);
      console.log(`EXTERNAL_CHANGE kind=${args.mode} start=${start} end=${end}${path === null ? "" : ` path=${path}`}`);
    }
  } catch (error) {
    if (!(error instanceof ChangeError)) throw error;
    console.error(error.message);
    process.exit(EXIT[error.code]);
  }
}
