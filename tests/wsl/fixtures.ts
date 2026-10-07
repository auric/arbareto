// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The WSL builders of the plan.md fixture matrix (F21, F24, F25, F26). Each Git call runs the distro Git through `wsl.exe --exec` with an argument array.
// Each builder works only under the owned `<home>/arbareto-fixtures-<random>` folder, or for F26 under the Windows fixture root.
// Facts come from the construction, never from `src/git-service/`.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { createSession, type SessionOptions } from "../../src/git-service/session";
import type { BunRunner } from "../git/bun-runner";
import { FIXTURE_ROOT, fixtureDir, ownedGit } from "../git/fixture-root";
import { inDistro, uncPath, type WslHost } from "./wsl-host";

printOrigin("../../src/git-service/session.ts", import.meta.dir);

const FIXED = { name: "Arbareto Fixture", email: "fixture@arbareto.invalid", date: "2026-01-01T00:00:00+0000" } as const;

export interface WslRepo {
  host: WslHost;
  // The Linux worktree root.
  dir: string;
}

// The owned global configuration of every fixture Git call. `env` sets it for one program without a shell.
export function globalConfig(host: WslHost): string {
  return `${host.folder}/home/.gitconfig`;
}

function gitEnv(host: WslHost): string[] {
  return [
    "/usr/bin/env",
    `HOME=${host.folder}/home`,
    `GIT_CONFIG_GLOBAL=${globalConfig(host)}`,
    "GIT_CONFIG_NOSYSTEM=1",
    `GIT_AUTHOR_DATE=${FIXED.date}`,
    `GIT_COMMITTER_DATE=${FIXED.date}`,
  ];
}

// Writes bytes to a Linux file through `dd`, so no shell parses the path.
export function writeLinux(host: WslHost, path: string, content: string | Uint8Array, mode?: string): void {
  if (!path.startsWith(`${host.folder}/`)) throw new Error(`outside the owned folder: ${path}`);
  inDistro(host.distro, ["/usr/bin/mkdir", "-p", "--", path.slice(0, path.lastIndexOf("/"))]);
  inDistro(host.distro, ["/usr/bin/dd", `of=${path}`, "status=none"], { input: typeof content === "string" ? Buffer.from(content) : content });
  if (mode) inDistro(host.distro, ["/usr/bin/chmod", mode, "--", path]);
}

export function distroGit(r: WslRepo, args: string[], options: { input?: Uint8Array; allowExit?: number[] } = {}): string {
  const git = r.host.probe.paths.git;
  if (!git) throw new Error("no distro Git");
  return inDistro(r.host.distro, [...gitEnv(r.host), git, "-C", r.dir, ...args], options);
}

function prepareHome(host: WslHost): void {
  writeLinux(host, globalConfig(host), `[user]\n\tname = ${FIXED.name}\n\temail = ${FIXED.email}\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n`);
}

function init(host: WslHost, dir: string): WslRepo {
  prepareHome(host);
  inDistro(host.distro, ["/usr/bin/mkdir", "-p", "--", dir]);
  const r = { host, dir };
  distroGit(r, ["init", "-q", "-b", "main"]);
  for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"]] as const) distroGit(r, ["config", key, value]);
  return r;
}

function put(r: WslRepo, rel: string, content: string | Uint8Array, mode?: string): void {
  writeLinux(r.host, `${r.dir}/${rel}`, content, mode);
}

function commit(r: WslRepo, message: string): string {
  distroGit(r, ["commit", "-q", "--no-verify", "--allow-empty", "-m", message]);
  return distroGit(r, ["rev-parse", "HEAD"]).trim();
}

const lines = (count: number, changed: number[]) => Array.from({ length: count }, (_, i) => (changed.includes(i + 1) ? `line ${i + 1} changed\n` : `line ${i + 1}\n`)).join("");

export interface F21 {
  repo: WslRepo;
  linked: WslRepo;
  // The four path forms of contract §11 "Route" and T207, all of the main worktree.
  paths: string[];
  head: string;
  canary: string;
}

// F21: a path with spaces, `$`, and `é`; a linked worktree, the F02 changes, a binary file, and a `pre-commit` hook.
export function buildF21(host: WslHost): F21 {
  const base = `${host.folder}/f21-${crypto.randomUUID().slice(0, 8)} a$b é`;
  const repo = init(host, `${base}/repo`);
  put(repo, "multi.txt", lines(40, []));
  put(repo, "other-a.txt", "a\n");
  put(repo, "keep.txt", "keep\n");
  put(repo, "binary.dat", new Uint8Array([0, 1, 2, 0xff, 0, 10, 13, 0]));
  distroGit(repo, ["--literal-pathspecs", "add", "--", "multi.txt", "other-a.txt", "keep.txt", "binary.dat"]);
  const head = commit(repo, "base");
  put(repo, "multi.txt", lines(40, [3]));
  put(repo, "other-a.txt", "a changed\n");
  put(repo, "other-b.txt", "b\n");
  distroGit(repo, ["--literal-pathspecs", "add", "--", "multi.txt", "other-a.txt", "other-b.txt"]);
  put(repo, "multi.txt", lines(40, [3, 20, 36]));
  const canary = `${base}/pre-commit.log`;
  put(repo, ".git/hooks/pre-commit", `#!/bin/sh\necho run >> '${canary}'\n`, "755");
  const linkedDir = `${base}/linked`;
  distroGit(repo, ["worktree", "add", "-q", "-b", "side", linkedDir, head]);
  const linuxPrefix = repo.dir.split("/").filter((s) => s !== "");
  const lowerDistro = host.distro.toLowerCase();
  const paths = [
    uncPath(host, repo.dir, "wsl$"),
    uncPath(host, repo.dir, "wsl.localhost"),
    uncPath(host, repo.dir, "WSL.LOCALHOST"),
    [`\\\\wsl$\\${lowerDistro}`, ...linuxPrefix].join("\\"),
  ];
  return { repo, linked: { host, dir: linkedDir }, paths, head, canary };
}

export interface F24 {
  repo: WslRepo;
  path: string;
  // The `git --version` text of the distro Git.
  versionText: string;
}

// F24: the distro Git below 2.55.0. The reference distro has 2.43.0.
export function buildF24(host: WslHost): F24 {
  const repo = init(host, `${host.folder}/f24/repo`);
  put(repo, "a.txt", "a\n");
  distroGit(repo, ["add", "--", "a.txt"]);
  commit(repo, "base");
  const versionText = distroGit(repo, ["--version"]).trim();
  return { repo, path: uncPath(host, repo.dir), versionText };
}

export interface F25 {
  linger: WslRepo;
  slow: WslRepo;
  tty: WslRepo;
  // A clean filter whose canary starts a detached child during a read.
  filter: WslRepo;
  // `pgrep -f` with this pattern finds every child that a hook or the filter started.
  pattern: string;
}

// F25: hooks that start a plain, a `nohup`, and a `setsid` child; a slow hook; a `pre-commit` hook that reads `/dev/tty`.
export function buildF25(host: WslHost): F25 {
  const base = `${host.folder}/f25`;
  const script = `${base}/linger.sh`;
  writeLinux(host, script, "#!/bin/sh\nexec sleep 300\n", "755");
  const filter = init(host, `${base}/filter`);
  put(filter, "clean.sh", `#!/bin/sh\nsetsid '${script}' filter >/dev/null 2>&1 &\nexec cat\n`, "755");
  put(filter, ".gitattributes", "*.txt filter=canary\n");
  distroGit(filter, ["config", "filter.canary.clean", `'${filter.dir}/clean.sh'`]);
  put(filter, "a.txt", "a\n");
  distroGit(filter, ["-c", "filter.canary.clean=cat", "add", "--", ".gitattributes", "a.txt"]);
  commit(filter, "base");
  // Keep the size. Git hashes the file through the clean filter only when the size matches (read-cache.c `ie_modified`).
  put(filter, "a.txt", "b\n");
  const linger = init(host, `${base}/linger`);
  put(
    linger,
    ".git/hooks/post-commit",
    `#!/bin/sh\n'${script}' plain >/dev/null 2>&1 &\nnohup '${script}' nohup >/dev/null 2>&1 &\nsetsid '${script}' setsid >/dev/null 2>&1 &\nexit 0\n`,
    "755",
  );
  const slow = init(host, `${base}/slow`);
  put(slow, ".git/hooks/pre-commit", `#!/bin/sh\nexec '${script}' slow\n`, "755");
  const tty = init(host, `${base}/tty`);
  put(tty, ".git/hooks/pre-commit", "#!/bin/sh\necho reading the terminal >&2\nread answer </dev/tty\n", "755");
  for (const r of [linger, slow, tty]) {
    put(r, "a.txt", "a\n");
    distroGit(r, ["add", "--", "a.txt"]);
  }
  return { linger, slow, tty, filter, pattern: script };
}

export interface F26 {
  // A repository under the distro's `/mnt/c` mount, opened through the WSL prefix.
  mounted: { dir: string; path: string };
  // A Windows worktree whose Git directory lies in WSL.
  windowsWorktree: string;
  // A Linux folder name with `:`, as WSL shows it in a UNC path.
  colonPath: string;
  // A repository with an entry name that holds `\`.
  entries: { repo: WslRepo; path: string; entry: string };
}

// ---- Seam probe results (test harness rules: seam cases inject the probe result) ----

export interface ProbeChange {
  version?: string;
  absent?: string[];
  gitfs?: string;
  gitfile?: string;
  scope?: string;
  osid?: string;
  // Another resolved Git path. No process runs it in a seam case.
  git?: string;
  // The context path lines (gaps.md W1). The defaults give the seam identity of `SEAM_INODE` on the disk of the distro Git.
  selfs?: string;
  selino?: string;
  selstat?: string;
}

// The seam inode of a context folder, and of the Git directory below it.
export const SEAM_INODE = "4242";
export const SEAM_GIT_INODE = "4243";

// A Git probe output in the `src/contracts/wsl-process.json` line format. It starts from the real facts of the distro.
export function seamProbe(host: WslHost, change: ProbeChange = {}): string {
  const facts = host.probe;
  const out: string[] = [];
  for (const name of ["git", "systemd-run", "systemctl", "setsid", "stat", "env", "perl", "sha256sum"]) {
    const path = name === "git" ? (change.git ?? facts.paths.git) : facts.paths[name];
    if (change.absent?.includes(name) || !path) out.push(`absent ${name}`);
    else out.push(`path ${name} ${path}`, `magic ${name} ${facts.magic[name] ?? "-"}`);
  }
  out.push(`pathenv ${facts.pathEnv ?? ""}`);
  if (!change.absent?.includes("git")) {
    out.push(`version ${change.version ?? facts.version ?? ""}`);
    if (!change.absent?.includes("stat")) out.push(`gitfs ${change.gitfs ?? facts.gitfs ?? ""}`, `gitfile ${change.gitfile ?? facts.gitfile ?? ""}`);
  }
  if (!change.absent?.includes("stat")) out.push(`selfs ${change.selfs ?? facts.gitfs ?? ""}`, `selino ${change.selino ?? SEAM_INODE}`);
  if (!change.absent?.includes("perl")) out.push(`selstat ${change.selstat ?? "ok"}`);
  out.push(`scope ${change.scope ?? facts.scope ?? "1"}`);
  const osid = change.osid ?? facts.osid;
  if (osid !== undefined) out.push(`osid ${osid}`);
  return `${out.join("\n")}\n`;
}

// ---- A WSL registration without a process (gaps.md W1 and W2) ----

export interface SeamRepo {
  // The UNC path of the worktree root, and its Linux path.
  path: string;
  linux: string;
  gitDirectory: string;
}

// The seam probe, the discovery outputs, and the identity replies of a repository at `linux` (default: the owned folder).
// The trust listing reads `config` as its `config list -z` output. Only the `fileFacts` probe and unmatched calls start processes.
export function seamRepository(host: WslHost, runner: BunRunner, options: { linux?: string; probe?: ProbeChange; config?: string } = {}): SeamRepo {
  const linux = options.linux ?? host.folder;
  const fileSystem = host.probe.gitfs ?? "";
  runner.inject.wslProbe = { stdout: seamProbe(host, { version: "git version 2.55.0", ...options.probe }) };
  runner.inject.wslStat.set(uncPath(host, linux), { inode: SEAM_INODE, fileSystem });
  runner.inject.wslStat.set(uncPath(host, `${linux}/.git`), { inode: SEAM_GIT_INODE, fileSystem });
  const outputs: [string, string][] = [
    ["rev-parse --is-bare-repository --is-inside-git-dir", "false\nfalse\n"],
    ["rev-parse --show-toplevel", `${linux}\n${linux}/.git\n${linux}/.git\n${linux}/.git/index\nsha1\nfiles\n`],
    ["symbolic-ref", "refs/heads/main\n"],
    ["show-ref --head --verify HEAD", `${"1".repeat(40)} HEAD\n`],
    ["config list", options.config ?? ""],
    ["rev-parse --git-path hooks", ".git/hooks\n"],
  ];
  runner.inject.stdout = ({ arguments: args }) => {
    const text = args.join(" ");
    const found = outputs.find(([marker]) => text.includes(marker));
    return found ? new TextEncoder().encode(found[1]) : undefined;
  };
  return { path: uncPath(host, linux), linux, gitDirectory: uncPath(host, `${linux}/.git`) };
}

// ---- A service session over the T206 double, as the shell drives it ----

export interface PublicResponse {
  requestId: string | null;
  operationId?: string;
  state: string;
  code?: string;
  result?: Record<string, unknown>;
}

export interface PublicProgress {
  requestId: string;
  operationId: string;
  state: string;
  phase?: string;
}

const RESPONSE_WAIT_MS = 120_000;

export function startSession(runner: BunRunner) {
  const responses: PublicResponse[] = [];
  const progress: PublicProgress[] = [];
  const session = createSession({
    writer: {
      write: (frame) => {
        if ("response" in frame) responses.push(frame.response as PublicResponse);
        if ("progress" in frame) progress.push(frame.progress as PublicProgress);
      },
      flush: async () => {},
    },
    runner: { ...runner, receive: () => false } as unknown as SessionOptions["runner"],
    fail: () => {},
  });
  const send = (frame: object) => session.receive({ type: "frame", body: new TextEncoder().encode(JSON.stringify(frame)) });
  const handshake = {
    version: 1,
    restarted: false,
    platformScope: "qualification-target",
    osBuild: 26200,
    webView2Version: "140.0.0.0",
    buildIdentity: { version: "0.1.0", commit: "0".repeat(40), signing: "unsigned" },
    markers: [],
    unloadedMarkers: 0,
    damagedMarkers: [],
    trustRecords: [],
  };
  send({ kind: "handshake", handshake });
  const sessionId = session.sessionId as string;
  // `extra` holds envelope fields such as `repositoryId` and `repositoryGeneration`.
  const request = (operation: string, payload: object, extra: object = {}): string => {
    const requestId = crypto.randomUUID();
    send({ kind: "public", request: { version: 1, sessionId, requestId, operation, payload, ...extra } });
    return requestId;
  };
  const response = async (requestId: string, timeoutMs = RESPONSE_WAIT_MS): Promise<PublicResponse> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = responses.find((r) => r.requestId === requestId);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no response for ${requestId}`);
      await Bun.sleep(10);
    }
  };
  const progressOf = (requestId: string) => progress.filter((p) => p.requestId === requestId);
  // Registration as the shell sends it after the folder picker: only the native bootstrap ID.
  const chooseRepository = (path: string) => request("chooseRepository", { bootstrapId: runner.addContext("repositoryDiscovery", path) });
  return { session, request, response, progressOf, chooseRepository };
}

export type WslSession = ReturnType<typeof startSession>;

// F26 needs the Windows fixture root (`useFixtureRoot`) and the Windows Git for the Windows worktree.
export function buildF26(host: WslHost, windowsGit: string): F26 {
  const windowsDir = fixtureDir("f26-mnt");
  const mountedDir = inDistro(host.distro, ["/usr/bin/wslpath", "-u", windowsDir]).trim();
  if (!mountedDir.startsWith("/mnt/")) throw new Error(`not a drive mount: ${mountedDir}`);
  const mounted = init(host, mountedDir);
  commit(mounted, "base");

  const separate = `${host.folder}/f26/separate.git`;
  inDistro(host.distro, ["/usr/bin/mkdir", "-p", "--", `${host.folder}/f26`]);
  const worktree = join(FIXTURE_ROOT, "f26-windows");
  mkdirSync(worktree);
  ownedGit(windowsGit, FIXTURE_ROOT, worktree, ["init", "-q", "-b", "main", `--separate-git-dir=${uncPath(host, separate)}`]);
  writeFileSync(join(worktree, "a.txt"), "a\n");

  const colonDir = `${host.folder}/f26/a:b`;
  init(host, colonDir);

  const entries = init(host, `${host.folder}/f26/entries`);
  put(entries, "a\\b.txt", "backslash\n");
  put(entries, "plain.txt", "plain\n");
  distroGit(entries, ["--literal-pathspecs", "add", "--", "a\\b.txt", "plain.txt"]);
  commit(entries, "base");
  put(entries, "a\\b.txt", "backslash changed\n");
  return {
    mounted: { dir: mountedDir, path: uncPath(host, mountedDir, "wsl$") },
    windowsWorktree: worktree,
    colonPath: uncPath(host, colonDir).replace(":", ""),
    entries: { repo: entries, path: uncPath(host, entries.dir), entry: "a\\b.txt" },
  };
}
