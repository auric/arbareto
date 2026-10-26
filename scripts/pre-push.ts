// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The body of `.githooks/pre-push` (githooks(5) "pre-push"). Arguments: the remote name and the remote URL.
// Each stdin line is `<local ref> <local oid> <remote ref> <remote oid>`. An all-zero oid marks a missing side.
// Exit 0 permits the push. Exit 1 refuses it.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUILT_IN_RULES, privatePathHits } from "./private-paths";

const ZERO_OID = /^0+$/;
// git-diff(1) "Combined diff format": a merge hunk header has one `@` per parent plus one, and a line has one prefix column per parent.
const HUNK = /^(@@+) (?:-\d+(?:,\d+)? )+\+(\d+)(?:,\d+)? \1(?: |$)/;
// A commit record starts with NUL. Git shows a file with a NUL byte as binary, so patch lines hold no NUL.
const FORMAT = "--format=%x00%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x00";
// These options override user configuration that changes the patch form or adds lines.
const LOG_OPTIONS = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-show-signature", "--no-relative", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "--diff-merges=combined", "-p", FORMAT];

function refuse(message: string): never {
  console.error(`pre-push: ${message}`);
  process.exit(1);
}

function git(args: string[], allowExit: number[] = [0]): { exitCode: number; stdout: string } {
  const child = Bun.spawnSync(["git", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (!allowExit.includes(child.exitCode)) refuse(`git ${args[0]} exited ${child.exitCode}: ${child.stderr.toString().trim()}`);
  return { exitCode: child.exitCode, stdout: child.stdout.toString() };
}

// One regular expression per line. The line number is the pattern number. Output never shows the pattern text.
function privatePatterns(): [number, RegExp][] {
  const commonDir = resolve(git(["rev-parse", "--git-common-dir"]).stdout.replace(/\r?\n$/, ""));
  const file = join(commonDir, "info", "private-patterns");
  if (!existsSync(file)) return [];
  const patterns: [number, RegExp][] = [];
  readFileSync(file, "utf8").split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === "" || line.trimStart().startsWith("#")) return;
    try {
      patterns.push([index + 1, new RegExp(line)]);
    } catch {
      refuse(`line ${index + 1} of info/private-patterns is not a valid JavaScript regular expression. The push is refused.`);
    }
  });
  return patterns;
}

function rules(text: string, patterns: [number, RegExp][]): string[] {
  const found = privatePathHits(text).map((name) => `built-in ${BUILT_IN_RULES.indexOf(name) + 1} (${name})`);
  for (const [number, pattern] of patterns) if (pattern.test(text)) found.push(`<private pattern ${number}>`);
  return found;
}

// A commit that a remote-tracking ref of the named remote holds was checked when it was pushed.
// githooks(5): Git passes the URL as both arguments when the push does not use a named remote.
function rangeArgs(remote: string, url: string | undefined, localOid: string, remoteOid: string): string[] {
  const known = !ZERO_OID.test(remoteOid) && git(["cat-file", "-e", `${remoteOid}^{commit}`], [0, 1, 128]).exitCode === 0;
  if (remote !== url) return [localOid, "--not", `--remotes=${remote}`, ...(known ? [remoteOid] : [])];
  return known ? [localOid, "--not", remoteOid] : [localOid, "--not", `--remotes=${remote}`];
}

function scanLog(output: string, patterns: [number, RegExp][], seen: Set<string>, hits: string[]): void {
  const fields = output.split("\0");
  for (let i = 1; i + 6 < fields.length; i += 7) {
    const [commit, authorName, authorEmail, committerName, committerEmail, message, patch] = fields.slice(i, i + 7) as string[];
    if (seen.has(commit!)) continue;
    seen.add(commit!);
    const report = (where: string, text: string) => {
      for (const rule of rules(text, patterns)) hits.push(`${commit} ${where} ${rule}`);
    };
    report("author", `${authorName} <${authorEmail}>`);
    report("committer", `${committerName} <${committerEmail}>`);
    message!.split("\n").forEach((line, index) => report(`message:${index + 1}`, line));
    let path = "";
    let line = 0;
    // The number of prefix columns in the current hunk. Zero means outside a hunk.
    let columns = 0;
    for (const text of patch!.split("\n")) {
      const hunk = HUNK.exec(text);
      if (text.startsWith("diff --git ") || text.startsWith("diff --combined ")) {
        columns = 0;
        path = "";
      } else if (columns === 0 && text.startsWith("+++ ")) {
        const target = text.slice(4);
        path = target.startsWith("b/") ? target.slice(2) : target;
      } else if (hunk !== null) {
        columns = hunk[1]!.length - 1;
        line = Number(hunk[2]);
      } else if (columns > 0 && text === "") {
        // `diff.suppressBlankEmpty` prints an empty context line without its prefix.
        line += 1;
      } else if (columns > 0 && /^[ +]+$/.test(text.slice(0, columns)) && text.length >= columns) {
        // A line that a parent holds came from commits that this push scans or that a remote holds.
        if (!text.slice(0, columns).includes(" ")) report(`${path}:${line}`, text.slice(columns));
        line += 1;
      }
    }
  }
}

if (import.meta.main) {
  const [remote, url] = process.argv.slice(2);
  if (remote === undefined) refuse("Git passes the remote name as the first argument.");
  const patterns = privatePatterns();
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const entry of (await Bun.stdin.text()).split("\n")) {
    if (entry.trim() === "") continue;
    const fields = entry.replace(/\r$/, "").split(" ");
    if (fields.length !== 4) refuse("a stdin line does not have four fields.");
    const [, localOid, , remoteOid] = fields as [string, string, string, string];
    if (ZERO_OID.test(localOid)) continue;
    scanLog(git(["log", ...LOG_OPTIONS, ...rangeArgs(remote, url, localOid, remoteOid), "--"]).stdout, patterns, seen, hits);
  }
  for (const hit of hits) console.error(`pre-push: ${hit}`);
  if (hits.length > 0) refuse(`${hits.length} private string hits. Remove them from the commits, then push again.`);
}
