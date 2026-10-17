// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// FR-011, plan.md D3, and research.md R4: the untracked-in-the-way check of Discard. Pure logic; `switch.ts` runs the reads.
// Paths are byte strings: `latin1` maps each byte to one code unit, so equal strings mean equal bytes.

import type { FileFact } from "../contracts/channel";
import { DISCARD_CHECK_PATHS } from "../contracts/limits";
import { isObjectId, type ObjectFormat } from "./commands";
import { latin1 } from "./read-steps";
import { checkIgnoreArgs } from "./workbench-commands";

// Contract Δ5 "In-the-way paths in a result".
export const IN_THE_WAY_PATHS = 100;

// NUL-ended fields. Null when the output does not end with NUL.
function fields(stdout: Uint8Array): string[] | null {
  const raw = latin1(stdout);
  if (raw === "") return [];
  return raw.endsWith("\0") ? raw.slice(0, -1).split("\0") : null;
}

export interface DiscardCandidates {
  // Candidate order: each path, then its leading folders.
  paths: string[];
  // The paths where the target writes a file.
  writes: ReadonlySet<string>;
}

// `diff-tree -r -z --no-renames --name-status <HEAD> <target>`: a status field and a path field per record.
// A, M, and T paths and their leading folders are candidates. A D path is a candidate.
export function discardCandidates(stdout: Uint8Array): DiscardCandidates | "malformed" | "limit" {
  const f = fields(stdout);
  if (f === null || f.length % 2 !== 0) return "malformed";
  const paths = new Set<string>();
  const writes = new Set<string>();
  for (let i = 0; i < f.length; i += 2) {
    const [status, path] = [f[i]!, f[i + 1]!];
    if (!["A", "D", "M", "T"].includes(status) || path.split("/").includes("")) return "malformed";
    paths.add(path);
    if (status !== "D") {
      writes.add(path);
      for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1)) paths.add(path.slice(0, at));
    }
    if (paths.size > DISCARD_CHECK_PATHS) return "limit";
  }
  return { paths: [...paths], writes };
}

// `facts` holds one `fileFacts` reply per candidate, in candidate order, read without following links.
// `entries` need the index read. A folder counts only where the target writes a file.
// Git's checkout refuses any untracked entry in the way that is no folder, so `other` counts as an entry (unpack-trees.c `verify_absent`).
export function sortFacts(c: DiscardCandidates, facts: readonly FileFact[]): { entries: string[]; folders: string[] } | "unknown" {
  if (facts.length !== c.paths.length) throw new TypeError("fact count refused");
  const entries: string[] = [];
  const folders: string[] = [];
  for (const [i, path] of c.paths.entries()) {
    const fact = facts[i]!;
    if (fact.kind === "error") return "unknown";
    // A link at a leading folder hides the path. That folder is a candidate of its own.
    if (fact.kind === "file" || fact.kind === "other" || (fact.kind === "link" && fact.component === path.split("/").length)) entries.push(path);
    else if (fact.kind === "directory" && c.writes.has(path)) folders.push(path);
  }
  return { entries, folders };
}

// git-ls-files(1) OUTPUT, `--stage` with `-z`: `<mode> SP <object> SP <stage> TAB <file> NUL`.
// Research.md R21 F7: an entry counts only when the index has no stage-0 entry at its path.
export function untrackedOf(entries: readonly string[], stdout: Uint8Array, objectFormat: ObjectFormat): string[] | "malformed" {
  const records = fields(stdout);
  if (records === null) return "malformed";
  const tracked = new Set<string>();
  for (const record of records) {
    const m = /^[0-7]{6} ([0-9a-f]+) ([0-3])\t([^]+)$/.exec(record);
    if (m === null || !isObjectId(m[1]!, objectFormat)) return "malformed";
    if (m[2] === "0") tracked.add(m[3]!);
  }
  return entries.filter((path) => !tracked.has(path));
}

// Research.md R21 F1: the read has no `--literal-pathspecs`. Each path goes on stdin with NUL.
export function ignoreRead(counted: readonly string[]): { args: string[]; input: Uint8Array } {
  return { args: checkIgnoreArgs(), input: Buffer.from(counted.map((path) => `${path}\0`).join(""), "latin1") };
}

// git-check-ignore(1) EXIT STATUS: 0 when one or more paths are ignored, 1 when none is. With `-z`, each ignored path ends with NUL.
// Git treats ignored files as replaceable (spec Assumptions). Null: no candidate is left. `paths` is UTF-8 text for display.
export function inTheWay(counted: readonly string[], result: { exitCode: number | null; stdout: Uint8Array }): { paths: string[]; more: number } | null | "malformed" | "failed" {
  if (result.exitCode !== 0 && result.exitCode !== 1) return "failed";
  const ignored = fields(result.stdout);
  const input = new Set(counted);
  if (ignored === null || (result.exitCode === 0) !== (ignored.length > 0) || !ignored.every((path) => input.has(path))) return "malformed";
  const skip = new Set(ignored);
  const left = counted.filter((path) => !skip.has(path));
  if (left.length === 0) return null;
  return { paths: left.slice(0, IN_THE_WAY_PATHS).map((path) => Buffer.from(path, "latin1").toString("utf8")), more: Math.max(0, left.length - IN_THE_WAY_PATHS) };
}
