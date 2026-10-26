// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T022: the release notes from the CHANGELOG.md section and the fixed blocks (plan.md D9, contracts/release.md §2).

import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dir, "..", "..");
export const BLOCKS_DIR = join(ROOT, ".github", "release-notes");
export type Signing = "off" | "signpath";

/** The `## [<version>]` section of the changelog, heading included, up to the next `## ` heading. Null when the section is absent or empty. */
export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.replaceAll("\r\n", "\n").split("\n");
  const heading = `## [${version}]`;
  const start = lines.findIndex((l) => l === heading || l.startsWith(`${heading} - `));
  if (start === -1) return null;
  const next = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  const section = lines.slice(start, next === -1 ? undefined : next).join("\n").trimEnd();
  return section.includes("\n") ? `${section}\n` : null;
}

/** The block file names in release-note order. */
export function blockNames(signing: Signing): string[] {
  return ["preview.md", "prerequisites.md", signing === "off" ? "unsigned.md" : "signed.md"];
}

/** The notes text, or null when the changelog has no section for `version`. */
export function releaseNotes(changelog: string, version: string, blocks: Record<string, string>, signing: Signing): string | null {
  const section = changelogSection(changelog, version);
  if (section === null) return null;
  return [section, ...blockNames(signing).map((name) => blocks[name] ?? "")].join("\n");
}

async function main(argv: string[]): Promise<number> {
  let values: { version?: string; signing?: string; out?: string };
  try {
    ({ values } = parseArgs({ args: argv, options: { version: { type: "string" }, signing: { type: "string" }, out: { type: "string" } }, strict: true }));
  } catch {
    values = {};
  }
  const { version, signing, out } = values;
  if (version === undefined || out === undefined || (signing !== "off" && signing !== "signpath")) {
    console.error("RELEASE_NOTES usage notes.ts --version <v> --signing off|signpath --out <dir>");
    return 1;
  }
  const blocks: Record<string, string> = {};
  for (const name of blockNames(signing)) blocks[name] = await Bun.file(join(BLOCKS_DIR, name)).text();
  const notes = releaseNotes(await Bun.file(join(ROOT, "CHANGELOG.md")).text(), version, blocks, signing);
  if (notes === null) {
    console.error(`RELEASE_NOTES missing ${version}`);
    return 1;
  }
  const path = join(out, `arbareto-${version}-release-notes.md`);
  await Bun.write(path, notes);
  console.log(path);
  return 0;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
