// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T019: the third-party notices release file from the notices.json of the same build (plan.md D6, contracts/release.md §2).

import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { Notices } from "../../src/frontend/build/notices";

const ROOT = join(import.meta.dir, "..", "..");
const DEFAULT_INPUT = join(ROOT, "src", "frontend", "generated", "notices.json");

const NoticesSchema = z.strictObject({
  repositoryUrl: z.string(),
  project: z.strictObject({ license: z.string(), notice: z.string() }),
  texts: z.array(z.string()),
  groups: z.array(
    z.strictObject({
      license: z.string(),
      packages: z.array(z.strictObject({ name: z.string(), version: z.string().optional(), files: z.array(z.strictObject({ name: z.string(), text: z.number().int().nonnegative() })) })),
    }),
  ),
});

/** Each package and each licence text once, in JSON order. A file names its text by number. */
export function renderNotices(notices: Notices): string {
  const out = [
    "Arbareto third-party notices",
    `Source: ${notices.repositoryUrl}`,
    "",
    "== Arbareto licence ==",
    notices.project.license,
    "== Arbareto notice ==",
    notices.project.notice,
  ];
  for (const group of notices.groups) {
    out.push(`== Licence: ${group.license} ==`);
    for (const p of group.packages) {
      out.push(p.version === undefined ? p.name : `${p.name} ${p.version}`);
      for (const f of p.files) out.push(`  ${f.name}: text ${f.text + 1}`);
    }
    out.push("");
  }
  out.push("== Licence texts ==");
  notices.texts.forEach((text, i) => out.push(`--- Text ${i + 1} ---`, text));
  return `${out.join("\n")}\n`;
}

/** Reads and checks the inventory. Returns null when the file is absent or does not match the notices.json shape. */
export async function readNotices(path: string): Promise<Notices | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch {
    return null;
  }
  const parsed = NoticesSchema.safeParse(json);
  if (!parsed.success || parsed.data.groups.some((g) => g.packages.some((p) => p.files.some((f) => f.text >= parsed.data.texts.length)))) return null;
  return parsed.data as Notices;
}

async function main(argv: string[]): Promise<number> {
  let values: { out?: string; input?: string };
  try {
    ({ values } = parseArgs({ args: argv, options: { out: { type: "string" }, input: { type: "string" } }, strict: true }));
  } catch {
    values = {};
  }
  if (values.out === undefined) {
    console.error("RELEASE_NOTICES usage notices-text.ts --out <dir> [--input <notices.json>]");
    return 1;
  }
  const input = values.input ?? DEFAULT_INPUT;
  const notices = await readNotices(input);
  if (notices === null) {
    console.error(`RELEASE_NOTICES input ${input}`);
    return 1;
  }
  const { version } = (await Bun.file(join(ROOT, "package.json")).json()) as { version: string };
  const path = join(values.out, `arbareto-${version}-third-party-notices.txt`);
  await Bun.write(path, renderNotices(notices));
  console.log(path);
  return 0;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
