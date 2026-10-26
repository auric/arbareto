// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T020: SHA256SUMS.txt in `sha256sum` format (plan.md D5, contracts/release.md §2 and §3).

import { readdirSync } from "node:fs";
import { join } from "node:path";

export const SUMS_FILE = "SHA256SUMS.txt";
const NAME = /^[A-Za-z0-9._-]+$/;
const LINE = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]+)$/;

async function sha256(path: string): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");
}

function order(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The entries of `dir` except the sums file. A non-file entry is listed with `file: false`. */
function entries(dir: string): { name: string; file: boolean }[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.name !== SUMS_FILE)
    .map((e) => ({ name: e.name, file: e.isFile() }))
    .sort((a, b) => order(a.name, b.name));
}

/** Writes the sums file. Returns null, or the refusal line. */
export async function writeSums(dir: string): Promise<string | null> {
  const lines: string[] = [];
  for (const entry of entries(dir)) {
    if (!entry.file || !NAME.test(entry.name)) return `RELEASE_SUMS name ${JSON.stringify(entry.name)}`;
    lines.push(`${await sha256(join(dir, entry.name))}  ${entry.name}\n`);
  }
  await Bun.write(join(dir, SUMS_FILE), lines.join(""));
  return null;
}

/** Checks every line and every file of `dir`. Returns null, or the first refusal line. */
export async function verifySums(dir: string): Promise<string | null> {
  const sums = Bun.file(join(dir, SUMS_FILE));
  if (!(await sums.exists())) return `RELEASE_SUMS missing ${SUMS_FILE}`;
  const text = await sums.text();
  if (text === "" || !text.endsWith("\n")) return `RELEASE_SUMS format ${SUMS_FILE}`;
  const listed = new Map<string, string>();
  let previous = "";
  for (const line of text.slice(0, -1).split("\n")) {
    const match = LINE.exec(line);
    if (match === null || order(match[2]!, previous) <= 0) return `RELEASE_SUMS format ${SUMS_FILE}`;
    previous = match[2]!;
    listed.set(match[2]!, match[1]!);
  }
  const present = new Map(entries(dir).map((e) => [e.name, e.file]));
  for (const [name, hash] of listed) {
    if (present.get(name) !== true) return `RELEASE_SUMS missing ${name}`;
    if ((await sha256(join(dir, name))) !== hash) return `RELEASE_SUMS mismatch ${name}`;
  }
  for (const name of present.keys()) if (!listed.has(name)) return `RELEASE_SUMS extra ${name}`;
  return null;
}

async function main(argv: string[]): Promise<number> {
  const [command, dir, ...rest] = argv;
  if ((command !== "write" && command !== "verify") || dir === undefined || rest.length > 0) {
    console.error("RELEASE_SUMS usage sums.ts write|verify <dir>");
    return 1;
  }
  const refusal = command === "write" ? await writeSums(dir) : await verifySums(dir);
  if (refusal !== null) {
    console.error(refusal);
    return 1;
  }
  if (command === "write") console.log(join(dir, SUMS_FILE));
  return 0;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
