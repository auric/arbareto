// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 008 T015: the `wslFiles` mode `replace` with the `working` target and the mode `tempRemove` in the distro of `ARBARETO_WSL_DISTRO`
// (contract Δ11, plan.md D9, research.md R9, R15). `Local: WSL`, alone.
// Each case runs the Perl text of `src/contracts/wsl-process.json` through the contract §11 wrapper, with the arguments of `src-tauri/src/wsl.rs`
// `files_perl` and the stdin tokens of `working_command`, `replace_command`, and `temp_remove_command`. The operation IDs start with `0f0f0f0f-0000-4000-8015-`.

import { describe, expect, test } from "bun:test";
import wslProcess from "../../src/contracts/wsl-process.json";
import { sha256 } from "../git/git-oracle";
import { printOrigin } from "../origin";
import { sh } from "./fixtures";
import { inDistro, listScopes, OWN_SCOPE_OPERATIONS, pgrep, useWslFolder, WSL_ENV, WSL_EXE, WSL_FILES_TEXT, wslExec, wslTest, type WslCapability, type WslHost } from "./wsl-host";

printOrigin("../../src/contracts/wsl-process.json", import.meta.dir);
useWslFolder();

const NEEDS: WslCapability[] = ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "distro-git-2.55", "perl"];
const CASE_MS = 300_000;
const RUN_MS = 120_000;
const HELD_MS = 60_000;
// Contract §11 "Process ownership": no Linux process of the operation remains 1 second after the Job close.
const AFTER_CLOSE_MS = 1_000;
const WRAPPER = wslProcess.wrapper.join("\n");
// `src-tauri/src/wsl.rs` `PERL`, `DELETE_OUTPUT_BYTES`, the start byte, and `IGNORE_TARGET_BYTES`.
const PERL = "/usr/bin/perl";
const OUTPUT_BYTES = 64 * (64 + 64);
const STARTED = 0x53;
const IGNORE_TARGET_BYTES = 1_048_576;
const NUL = "\0";

let operations = 0;
function operationId(): string {
  const id = `0f0f0f0f-0000-4000-8015-${(process.pid * 0x1000 + ++operations).toString(16).padStart(12, "0")}`;
  OWN_SCOPE_OPERATIONS.add(id);
  return id;
}

interface FilesRun {
  operation: string;
  proc: ReturnType<typeof Bun.spawn>;
}

// `wsl.rs` `files_perl`: the Perl text through the wrapper in mode `probe`, the three Linux roots, the Git and SHA-256 programs, and the stdin tokens.
function startFiles(w: WslHost, mode: "replace" | "tempRemove", root: string, tokens: readonly string[], sha = w.probe.paths.sha256sum!): FilesRun {
  const operation = operationId();
  const p = w.probe.paths;
  const roots = [root, `${root}/.git`, `${root}/.git`];
  const argv = [WSL_EXE, "--distribution", w.distro, "--cd", "/", "--exec", "/bin/sh", "-c", WRAPPER, "sh", `arbareto-${operation}-1.scope`, "probe", "", p["systemd-run"]!, p.systemctl!, p.setsid!, w.probe.noexpand === "0" ? "1" : "", PERL, "-e", WSL_FILES_TEXT, "--", mode, ...roots, p.git!, sha];
  const proc = Bun.spawn(argv, { env: WSL_ENV, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(Buffer.from(tokens.map((token) => `${token}${NUL}`).join("")));
  proc.stdin.end();
  return { operation, proc };
}

async function finish(run: FilesRun, ms = RUN_MS): Promise<{ exitCode: number | null; stdout: Uint8Array }> {
  const timer = setTimeout(() => run.proc.kill(), ms);
  try {
    const [stdout, exitCode] = await Promise.all([new Response(run.proc.stdout as ReadableStream<Uint8Array>).bytes(), run.proc.exited]);
    return { exitCode, stdout };
  } finally {
    clearTimeout(timer);
  }
}

// `wsl.rs` `started` and `Records`: exit 0, the start byte, then NUL-ended tokens within the cap. Null is the `interrupted` outcome.
function tokensOf(out: { exitCode: number | null; stdout: Uint8Array }): string[] | null {
  if (out.exitCode !== 0 || out.stdout[0] !== STARTED) return null;
  const body = Buffer.from(out.stdout.subarray(1));
  if (body.length > OUTPUT_BYTES || (body.length > 0 && body[body.length - 1] !== 0)) return null;
  return body.length === 0 ? [] : body.subarray(0, -1).toString("latin1").split(NUL);
}

// `wsl.rs` `working_reply`: `replaced` with the count of the created folders, `stale`, `refused <reason>`, or `error <code>`.
function workingReply(out: { exitCode: number | null; stdout: Uint8Array }): string {
  const tokens = tokensOf(out);
  if (tokens === null || tokens.length === 0) return "interrupted";
  const [kind, ...rest] = tokens;
  if (kind === "replaced" && rest.length === 1 && /^(0|[1-9][0-9]*)$/.test(rest[0]!)) return rest[0] === "0" ? "replaced" : `replaced ${rest[0]}`;
  if (kind === "stale" && rest.length === 0) return "stale";
  if ((kind === "refused" || kind === "error") && rest.length === 1) return `${kind} ${rest[0]}`;
  return "interrupted";
}

// `wsl.rs` `replace_reply` for an ignore target (feature 005): `replaced`, `stale`, `refused`, or `error <code>`.
function ignoreReply(out: { exitCode: number | null; stdout: Uint8Array }): string {
  const tokens = tokensOf(out);
  if (tokens === null) return "interrupted";
  if (tokens.length === 1 && ["replaced", "stale", "refused"].includes(tokens[0]!)) return tokens[0]!;
  return tokens.length === 2 && tokens[0] === "error" ? `error ${tokens[1]}` : "interrupted";
}

// `wsl.rs` `temp_remove_reply`.
function tempReply(out: { exitCode: number | null; stdout: Uint8Array }): string {
  const tokens = tokensOf(out);
  if (tokens === null) return "interrupted";
  if (tokens.length === 1 && ["removed", "stale", "absent"].includes(tokens[0]!)) return tokens[0]!;
  return tokens.length === 2 && tokens[0] === "error" ? `error ${tokens[1]}` : "interrupted";
}

// Data-model §3 `working` on WSL: the size, the SHA-256, `st_mode & 07777`, the uid, the gid, and the link count.
interface State {
  size: number;
  sha: string;
  mode: number;
  uid: number;
  gid: number;
  links: number;
}
type Content = { bytes: Buffer } | { source: { name: string; size: number; sha: string } };

// `wsl.rs` `working_command`.
function workingTokens(path: string[], state: State | null, folders: string[], content: Content): string[] {
  const head = ["0", "0", String(path.length), ...path, "working"];
  const at = state === null ? ["absent"] : ["present", String(state.size), state.sha, String(state.mode), String(state.uid), String(state.gid), String(state.links)];
  const body = "bytes" in content ? ["bytes", content.bytes.toString("hex")] : ["source", content.source.name, String(content.source.size), content.source.sha];
  return [...head, ...at, String(folders.length), ...folders, ...body];
}

const owned = (w: WslHost, path: string) => {
  if (!path.startsWith(`${w.folder}/`)) throw new Error(`outside the owned folder: ${path}`);
  return path;
};

let folders = 0;
// A fresh worktree folder with a `.git` folder below the owned folder.
function worktree(w: WslHost, name: string): string {
  const dir = owned(w, `${w.folder}/t015/${name}-${++folders}`);
  inDistro(w.distro, ["/usr/bin/mkdir", "-p", "--", `${dir}/.git`]);
  return dir;
}

function write(w: WslHost, path: string, bytes: string | Buffer, mode?: string): void {
  sh(w, 'cat > "$1" && if [ -n "$2" ]; then chmod -- "$2" "$1"; fi', [owned(w, path), mode ?? ""], { input: Buffer.from(bytes) });
}

function read(w: WslHost, path: string): Buffer | null {
  const r = sh(w, '[ -e "$1" ] || exit 3; cat -- "$1"', [owned(w, path)], { allowExit: [0, 3] });
  return r.exitCode === 3 ? null : Buffer.from(r.bytes);
}

// GNU stat `%s %a %u %g %h`, then `sha256sum`.
function stateOf(w: WslHost, path: string): State & { octal: string } {
  const r = sh(w, 'stat -c "%s %a %u %g %h" -- "$1" && sha256sum -- "$1"', [owned(w, path)]);
  const m = /^(\d+) ([0-7]+) (\d+) (\d+) (\d+)\n([0-9a-f]{64}) /.exec(r.stdout);
  if (m === null) throw new Error(`stat output refused: ${JSON.stringify(r.stdout)}`);
  return { size: Number(m[1]), octal: m[2]!, mode: parseInt(m[2]!, 8), uid: Number(m[3]), gid: Number(m[4]), links: Number(m[5]), sha: m[6]! };
}

// The names in `dir` that start with `.arbareto-`.
function temps(w: WslHost, dir: string): string[] {
  return sh(w, 'find "$1" -maxdepth 1 -name ".arbareto-*" -printf "%f\\n"', [owned(w, dir)]).stdout.split("\n").filter((n) => n !== "");
}

const umask = (w: WslHost): number => parseInt(sh(w, "umask").stdout.trim(), 8);

// One program as root in the distro, for fixture files owned by another user or group. False without root access.
function asRoot(w: WslHost, program: string[]): boolean {
  const r = wslExec(["--distribution", w.distro, "--user", "root", "--cd", "/", "--exec", ...program]);
  return r.exitCode === 0;
}

// Contract §11 "Process ownership": after a run, no scope and no process of its operation remains.
async function noneLeft(w: WslHost, operation: string, seamPath?: string): Promise<void> {
  await Bun.sleep(AFTER_CLOSE_MS);
  expect({ operation: pgrep(w, operation), seam: seamPath === undefined ? [] : pgrep(w, seamPath), scopes: listScopes(w) }).toEqual({ operation: [], seam: [], scopes: [] });
}

// A seam in place of `sha256sum`: the first call waits until the test creates `go`, then each call runs the real program. The wait has a 60-second bound.
function seam(w: WslHost, dir: string): { path: string; held: string; go: string } {
  const path = `${dir}/sha256sum-hold`;
  const held = `${dir}/held`;
  const go = `${dir}/go`;
  write(w, path, `#!/bin/sh\n: > '${held}'\ni=0\nwhile [ ! -e '${go}' ]; do\n  i=$((i + 1))\n  [ "$i" -gt 600 ] && exit 1\n  sleep 0.1\ndone\nexec '${w.probe.paths.sha256sum}' "$@"\n`, "755");
  return { path, held, go };
}

async function waitHeld(w: WslHost, held: string): Promise<void> {
  for (const end = performance.now() + HELD_MS; read(w, held) === null; await Bun.sleep(100)) {
    if (performance.now() >= end) throw new Error(`the seam did not hold within ${HELD_MS} ms`);
  }
}

// `checkout-index --temp` of the index entry of `path` in a repository with one commit (plan.md D5a step 2). The worktree file then changes.
function gitTemp(w: WslHost, dir: string, path: string, committed: string, changed: string): { name: string; size: number; sha: string } {
  const env = ["/usr/bin/env", `HOME=${w.folder}/home`, `GIT_CONFIG_GLOBAL=${w.folder}/home/.gitconfig`, "GIT_CONFIG_NOSYSTEM=1", "GIT_AUTHOR_NAME=Arbareto Fixture", "GIT_AUTHOR_EMAIL=fixture@arbareto.invalid", "GIT_COMMITTER_NAME=Arbareto Fixture", "GIT_COMMITTER_EMAIL=fixture@arbareto.invalid"];
  const git = [...env, w.probe.paths.git!];
  inDistro(w.distro, ["/usr/bin/mkdir", "-p", "--", `${w.folder}/home`]);
  sh(w, "rm -rf -- .git", [], { cwd: dir });
  inDistro(w.distro, [...git, "-C", dir, "init", "-q", "-b", "main"]);
  write(w, `${dir}/${path}`, committed);
  inDistro(w.distro, [...git, "-C", dir, "add", "--", path]);
  inDistro(w.distro, [...git, "-C", dir, "commit", "-q", "-m", "base"]);
  write(w, `${dir}/${path}`, changed);
  const out = wslExec(["--distribution", w.distro, "--cd", dir, "--exec", ...git, "--no-lazy-fetch", "checkout-index", "--temp", "--stdin", "-z"], { input: Buffer.from(`${path}\0`) });
  const m = /^([^\t\0/]+)\t([^\0]+)\0$/.exec(out.stdout);
  if (out.exitCode !== 0 || m === null || m[2] !== path) throw new Error(`checkout-index --temp: ${out.exitCode} ${JSON.stringify(out.stdout)} ${out.stderr}`);
  const bytes = Buffer.from(committed);
  return { name: m[1]!, size: bytes.length, sha: sha256(bytes) };
}

const W = (name: string, body: (w: WslHost) => Promise<void>) => wslTest(name, NEEDS, (w) => body(w), CASE_MS);

describe("T015 wslFiles replace working and tempRemove through the wrapper (contract Δ11, plan.md D9)", () => {
  W("the mode bits 0644, 0755, 0600, 02755, and 04755 stay after the gid copy, the write, and fchmod; the new bytes land and no temporary name stays", async (w) => {
    const dir = worktree(w, "modes");
    for (const octal of ["644", "755", "600", "2755", "4755"]) {
      const path = `${dir}/m${octal}.txt`;
      write(w, path, "old\n", octal);
      const before = stateOf(w, path);
      expect(before.octal).toBe(octal);
      const run = startFiles(w, "replace", dir, workingTokens([`m${octal}.txt`], before, [], { bytes: Buffer.from("new\n") }));
      expect(workingReply(await finish(run))).toBe("replaced");
      const after = stateOf(w, path);
      expect({ octal: after.octal, uid: after.uid, gid: after.gid, links: after.links, bytes: read(w, path)?.toString() }).toEqual({ octal, uid: before.uid, gid: before.gid, links: 1, bytes: "new\n" });
      await noneLeft(w, run.operation);
    }
    expect(temps(w, dir)).toEqual([]);
  });

  W("the gid copy runs before the write: a supplementary group stays, and a group outside the user's groups refuses with owner (EPERM)", async (w) => {
    const dir = worktree(w, "gid");
    const groups = sh(w, "id -G").stdout.trim().split(/\s+/).map(Number);
    const egid = Number(sh(w, "id -g").stdout.trim());
    const second = groups.find((g) => g !== egid);
    if (second === undefined) {
      console.log("SKIP supplementary-group: the distro user has one group (unverified)");
    } else {
      const path = `${dir}/second.txt`;
      write(w, path, "old\n", "2755");
      sh(w, 'chgrp -- "$1" "$2"', [String(second), path]);
      const before = stateOf(w, path);
      const run = startFiles(w, "replace", dir, workingTokens(["second.txt"], before, [], { bytes: Buffer.from("new\n") }));
      expect(workingReply(await finish(run))).toBe("replaced");
      expect(stateOf(w, path)).toMatchObject({ gid: second, octal: before.octal, size: 4 });
    }
    const foreign = `${dir}/foreign.txt`;
    write(w, foreign, "old\n", "644");
    const uid = sh(w, "id -u").stdout.trim();
    if (!asRoot(w, ["/usr/bin/chown", `${uid}:0`, "--", foreign])) {
      console.log("SKIP distro-root: no root access for the foreign group fixture (unverified)");
      return;
    }
    const before = stateOf(w, foreign);
    expect(before.gid).toBe(0);
    const run = startFiles(w, "replace", dir, workingTokens(["foreign.txt"], before, [], { bytes: Buffer.from("new\n") }));
    expect(workingReply(await finish(run))).toBe("refused owner");
    expect({ bytes: read(w, foreign)?.toString(), temps: temps(w, dir) }).toEqual({ bytes: "old\n", temps: [] });
  });

  W("another st_uid refuses with owner, an extended attribute with xattr, and a link count of 2 with hard-link; each target keeps its bytes", async (w) => {
    const dir = worktree(w, "refusals");
    const linked = `${dir}/linked.txt`;
    write(w, linked, "old\n", "644");
    sh(w, 'ln -- "$1" "$2"', [linked, `${dir}/second-name`]);
    let run = startFiles(w, "replace", dir, workingTokens(["linked.txt"], stateOf(w, linked), [], { bytes: Buffer.from("new\n") }));
    expect(workingReply(await finish(run))).toBe("refused hard-link");
    expect([read(w, linked)?.toString(), read(w, `${dir}/second-name`)?.toString()]).toEqual(["old\n", "old\n"]);
    const xattr = `${dir}/xattr.txt`;
    write(w, xattr, "old\n", "644");
    // `SYS_setxattr` from `syscall.ph`, as probe L6 sets `user.test` (research.md R15).
    const set = wslExec(["--distribution", w.distro, "--cd", "/", "--exec", PERL, "-e", 'require "syscall.ph"; my ($path, $name, $value) = (@ARGV, "user.test", "v"); syscall(main::SYS_setxattr(), $path, $name, $value, 1, 0) == 0 or exit 1', "--", xattr]);
    if (set.exitCode === 0) {
      run = startFiles(w, "replace", dir, workingTokens(["xattr.txt"], stateOf(w, xattr), [], { bytes: Buffer.from("new\n") }));
      expect(workingReply(await finish(run))).toBe("refused xattr");
      expect(read(w, xattr)?.toString()).toBe("old\n");
    } else {
      console.log(`SKIP user-xattr: setxattr failed (unverified): ${set.stderr}`);
    }
    const other = `${dir}/root-owned.txt`;
    write(w, other, "old\n", "644");
    if (asRoot(w, ["/usr/bin/chown", "0:0", "--", other])) {
      run = startFiles(w, "replace", dir, workingTokens(["root-owned.txt"], stateOf(w, other), [], { bytes: Buffer.from("new\n") }));
      expect(workingReply(await finish(run))).toBe("refused owner");
      expect(stateOf(w, other)).toMatchObject({ uid: 0, size: 4 });
      expect(read(w, other)?.toString()).toBe("old\n");
    } else {
      console.log("SKIP distro-root: no root access for the other-owner fixture (unverified)");
    }
    expect(temps(w, dir)).toEqual([]);
  });

  W("a state that differs from the frame is stale: size, SHA-256, mode, uid, gid, and links; an absent target with present facts too", async (w) => {
    const dir = worktree(w, "stale");
    const path = `${dir}/a.txt`;
    write(w, path, "old\n", "644");
    const state = stateOf(w, path);
    for (const [name, changed] of [
      ["size", { ...state, size: state.size + 1 }],
      ["sha256", { ...state, sha: sha256(Buffer.from("other\n")) }],
      ["mode", { ...state, mode: 0o600 }],
      ["uid", { ...state, uid: state.uid + 1 }],
      ["gid", { ...state, gid: state.gid + 1 }],
      ["links", { ...state, links: 2 }],
    ] as const) {
      const run = startFiles(w, "replace", dir, workingTokens(["a.txt"], changed, [], { bytes: Buffer.from("new\n") }));
      expect([name, workingReply(await finish(run))]).toEqual([name, "stale"]);
    }
    expect(read(w, path)?.toString()).toBe("old\n");
    const run = startFiles(w, "replace", dir, workingTokens(["gone.txt"], state, [], { bytes: Buffer.from("new\n") }));
    expect(workingReply(await finish(run))).toBe("stale");
    expect(read(w, `${dir}/gone.txt`)).toBeNull();
  });

  W("mkdir creates the missing folders with 0777 & ~umask; an absent target gets 0666 & ~umask (mode 100644); an existing name is stale", async (w) => {
    const dir = worktree(w, "folders");
    const mask = umask(w);
    let run = startFiles(w, "replace", dir, workingTokens(["a", "b", "n.txt"], null, ["a", "b"], { bytes: Buffer.from("new\n") }));
    expect(workingReply(await finish(run))).toBe("replaced 2");
    expect([stateOf(w, `${dir}/a/b/n.txt`).mode, read(w, `${dir}/a/b/n.txt`)?.toString()]).toEqual([0o666 & ~mask, "new\n"]);
    const folder = sh(w, 'stat -c "%a %a" -- "$1" "$2"', [`${dir}/a`, `${dir}/a/b`]).stdout.trim().split("\n");
    expect(folder.map((line) => parseInt(line.split(" ")[0]!, 8))).toEqual([0o777 & ~mask, 0o777 & ~mask]);
    run = startFiles(w, "replace", dir, workingTokens(["a", "b", "n.txt"], null, [], { bytes: Buffer.from("x") }));
    expect(workingReply(await finish(run))).toBe("stale");
    run = startFiles(w, "replace", dir, workingTokens(["a", "c", "n.txt"], null, ["a", "c"], { bytes: Buffer.from("x") }));
    expect(workingReply(await finish(run))).toBe("stale");
    expect(read(w, `${dir}/a/c/n.txt`)).toBeNull();
    expect([temps(w, `${dir}/a/b`), read(w, `${dir}/a/b/n.txt`)?.toString()]).toEqual([[], "new\n"]);
    await noneLeft(w, run.operation);
  });

  // Contract gap: the `fileReplace` frame carries no Git mode for an absent target, so the shell cannot choose 0777 & ~umask for mode 100755.
  test.todo("an absent target of mode 100755 gets 0777 & ~umask (contract gap: no mode field in the fileReplace frame)");

  W("the source copy: Git's temporary file of checkout-index --temp copies over the target with its digest, and the source goes after the fstat identity check", async (w) => {
    const dir = worktree(w, "source");
    const from = gitTemp(w, dir, "f.txt", "committed\n", "changed\n");
    sh(w, 'chmod 0640 -- "$1"', [`${dir}/f.txt`]);
    const before = stateOf(w, `${dir}/f.txt`);
    let run = startFiles(w, "replace", dir, workingTokens(["f.txt"], before, [], { source: from }));
    expect(workingReply(await finish(run))).toBe("replaced");
    expect({ bytes: read(w, `${dir}/f.txt`)?.toString(), octal: stateOf(w, `${dir}/f.txt`).octal, source: read(w, `${dir}/${from.name}`) }).toEqual({ bytes: "committed\n", octal: "640", source: null });
    // Another digest is stale, and the opened source goes.
    write(w, `${dir}/.merge_file_digest`, "other\n");
    run = startFiles(w, "replace", dir, workingTokens(["f.txt"], stateOf(w, `${dir}/f.txt`), [], { source: { name: ".merge_file_digest", size: 6, sha: sha256(Buffer.from("other!")) } }));
    expect(workingReply(await finish(run))).toBe("stale");
    expect([read(w, `${dir}/.merge_file_digest`), read(w, `${dir}/f.txt`)?.toString()]).toEqual([null, "committed\n"]);
    // A link at the source name fails its O_NOFOLLOW open, so it stays for `tempRemove`.
    sh(w, 'ln -s -- f.txt "$1"', [`${dir}/.merge_file_link`]);
    run = startFiles(w, "replace", dir, workingTokens(["f.txt"], stateOf(w, `${dir}/f.txt`), [], { source: { name: ".merge_file_link", size: 10, sha: sha256(Buffer.from("committed\n")) } }));
    expect(workingReply(await finish(run))).toBe("refused not-regular");
    expect(sh(w, '[ -L "$1" ] && echo link', [`${dir}/.merge_file_link`]).stdout.trim()).toBe("link");
    expect(temps(w, dir)).toEqual([]);
    await noneLeft(w, run.operation);
  });

  W("a kill -9 before linkat leaves no name, the reply is interrupted, and the source stays", async (w) => {
    const dir = worktree(w, "kill");
    const from = gitTemp(w, dir, "f.txt", "committed\n", "changed\n");
    sh(w, 'rm -- "$1"', [`${dir}/f.txt`]);
    const names = () => sh(w, 'ls -A -- "$1"', [dir]).stdout.split("\n").filter((n) => n !== "").sort();
    const before = names();
    // The target is absent, so the first SHA-256 run is the source copy into the O_TMPFILE file before linkat.
    const hold = seam(w, `${w.folder}/t015`);
    const run = startFiles(w, "replace", dir, workingTokens(["f.txt"], null, [], { source: from }), hold.path);
    try {
      await waitHeld(w, hold.held);
      run.proc.kill();
      expect(workingReply(await finish(run))).toBe("interrupted");
      await noneLeft(w, run.operation, hold.path);
    } finally {
      write(w, hold.go, "");
    }
    expect(names()).toEqual(before);
    expect(read(w, `${dir}/${from.name}`)?.toString()).toBe("committed\n");
  });

  W("tempRemove removes Git's temporary file only with its size and digest, and an absent name gives absent", async (w) => {
    const dir = worktree(w, "temp");
    const from = gitTemp(w, dir, "f.txt", "committed\n", "changed\n");
    let run = startFiles(w, "tempRemove", dir, [from.name, String(from.size), sha256(Buffer.from("other\n"))]);
    expect(tempReply(await finish(run))).toBe("stale");
    expect(read(w, `${dir}/${from.name}`)?.toString()).toBe("committed\n");
    run = startFiles(w, "tempRemove", dir, [from.name, String(from.size), from.sha]);
    expect(tempReply(await finish(run))).toBe("removed");
    expect(read(w, `${dir}/${from.name}`)).toBeNull();
    run = startFiles(w, "tempRemove", dir, [from.name, String(from.size), from.sha]);
    expect(tempReply(await finish(run))).toBe("absent");
    write(w, `${dir}/.merge_file_l`, "committed\n");
    sh(w, 'ln -- "$1" "$2"', [`${dir}/.merge_file_l`, `${dir}/other-name`]);
    run = startFiles(w, "tempRemove", dir, [".merge_file_l", "10", sha256(Buffer.from("committed\n"))]);
    expect(tempReply(await finish(run))).toBe("stale");
    await noneLeft(w, run.operation);
  });

  W("a setgid 02755 file keeps 02755 after a working replace and after a 005 ignore replace (probe L4)", async (w) => {
    const dir = worktree(w, "setgid");
    write(w, `${dir}/w.txt`, "old\n", "2755");
    let run = startFiles(w, "replace", dir, workingTokens(["w.txt"], stateOf(w, `${dir}/w.txt`), [], { bytes: Buffer.from("new\n") }));
    expect(workingReply(await finish(run))).toBe("replaced");
    expect(stateOf(w, `${dir}/w.txt`).octal).toBe("2755");
    write(w, `${dir}/.gitignore`, "/old\n", "2755");
    const ignore = Buffer.from("/old\n");
    run = startFiles(w, "replace", dir, [String(IGNORE_TARGET_BYTES), "0", "1", ".gitignore", "present", String(ignore.length), sha256(ignore), Buffer.from("/new\n").toString("hex")]);
    expect(ignoreReply(await finish(run))).toBe("replaced");
    expect({ octal: stateOf(w, `${dir}/.gitignore`).octal, bytes: read(w, `${dir}/.gitignore`)?.toString() }).toEqual({ octal: "2755", bytes: "/new\n" });
    expect(temps(w, dir)).toEqual([]);
    await noneLeft(w, run.operation);
  });
});
