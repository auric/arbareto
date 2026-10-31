// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T021: the Hunspell source archive (plan.md D6, contracts/release.md §2). Git checks the object IDs on fetch.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PINS } from "./pins";

const ROOT = join(import.meta.dir, "..", "..");
// plan.md D6 names the Windows tar.exe (bsdtar). The Linux path serves the portable tests only.
export const TAR = process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "/usr/bin/tar";
const TIMEOUT_MS = 600_000;

export type SourcePins = { hunspell: string; hunspellWasm: string };
export type SourceOptions = {
  version: string;
  out: string;
  /** The URL base of `<owner>/<repo>`. Tests give a local folder. */
  upstream?: string;
  pins?: SourcePins;
  git?: string;
  env?: Record<string, string | undefined>;
  /** The scratch folder. It is removed after the run. */
  work?: string;
};

// A process that a signal or the timeout ends has no exit code.
const code = (proc: Pick<ReturnType<typeof Bun.spawnSync>, "exitCode" | "signalCode">) => proc.exitCode ?? proc.signalCode;

export function archiveName(version: string): string {
  return `arbareto-${version}-hunspell-source.tar.gz`;
}

export function sourceText(version: string, pins: SourcePins): string {
  return [
    `Arbareto ${version}: Hunspell source`,
    "",
    "hunspell/",
    "  Repository: https://github.com/hunspell/hunspell",
    `  Commit: ${pins.hunspell}`,
    "hunspell-wasm/",
    "  Repository: https://github.com/rotemdan/hunspell-wasm",
    `  Commit: ${pins.hunspellWasm}`,
    "",
    "Licence: LGPL-2.1 (Hunspell is also available under GPL-2.0 and MPL-1.1).",
    "The 30 files of hunspell-wasm/lib/hunspell/ equal hunspell/src/hunspell/.",
    "The Emscripten version of the shipped hunspell.wasm is not recorded upstream.",
    "",
  ].join("\n");
}

/** Builds the archive. Returns its path, or the refusal line. */
export function hunspellSource(options: SourceOptions): { path: string } | { refusal: string } {
  const pins = options.pins ?? { hunspell: PINS.hunspell, hunspellWasm: PINS.hunspellWasm };
  const upstream = options.upstream ?? "https://github.com";
  const git = options.git ?? "git";
  const work = options.work ?? mkdtempSync(join(tmpdir(), "arbareto-hunspell-"));
  const run = (cmd: string[], cwd: string) =>
    Bun.spawnSync(cmd, { cwd, env: options.env ?? process.env, stdin: "ignore", stdout: "pipe", stderr: "inherit", timeout: TIMEOUT_MS });
  try {
    const staging = join(work, "staging");
    mkdirSync(staging, { recursive: true });
    const repos = [
      { repo: "hunspell/hunspell", prefix: "hunspell", commit: pins.hunspell },
      { repo: "rotemdan/hunspell-wasm", prefix: "hunspell-wasm", commit: pins.hunspellWasm },
    ];
    for (const { repo, prefix, commit } of repos) {
      const dir = join(work, prefix);
      const init = run([git, "init", "--quiet", dir], work);
      if (init.exitCode !== 0) return { refusal: `RELEASE_SOURCE fetch ${repo} ${code(init)}` };
      // gitattributes: `$GIT_DIR/info/attributes` wins over a tree `.gitattributes`. The LGPL archive must hold every file unchanged.
      const attributes = run([git, "rev-parse", "--git-path", "info/attributes"], dir);
      if (attributes.exitCode !== 0) return { refusal: `RELEASE_SOURCE fetch ${repo} ${code(attributes)}` };
      const attributesPath = resolve(dir, attributes.stdout.toString().trimEnd());
      mkdirSync(dirname(attributesPath), { recursive: true });
      writeFileSync(attributesPath, "* -export-ignore -export-subst\n");
      const fetch = run([git, "fetch", "--quiet", "--no-tags", "--depth", "1", `${upstream}/${repo}`, commit], dir);
      if (fetch.exitCode !== 0) return { refusal: `RELEASE_SOURCE fetch ${repo} ${code(fetch)}` };
      const parsed = run([git, "rev-parse", "--verify", "FETCH_HEAD^{commit}"], dir);
      const actual = parsed.exitCode === 0 ? parsed.stdout.toString().trimEnd() : "none";
      if (actual !== commit) return { refusal: `RELEASE_SOURCE commit ${repo} ${commit} ${actual}` };
      const tar = join(work, `${prefix}.tar`);
      const archive = run([git, "archive", "--format=tar", `--prefix=${prefix}/`, `--output=${tar}`, commit], dir);
      if (archive.exitCode !== 0) return { refusal: `RELEASE_SOURCE archive ${repo} ${code(archive)}` };
      const extract = run([TAR, "-xf", tar, "-C", staging], work);
      if (extract.exitCode !== 0) return { refusal: `RELEASE_SOURCE tar ${code(extract)}` };
    }
    writeFileSync(join(staging, "SOURCE.txt"), sourceText(options.version, pins));
    // tar runs in `work`, which the finally block removes.
    const path = join(resolve(options.out), archiveName(options.version));
    const pack = run([TAR, "-czf", path, "-C", staging, "hunspell", "hunspell-wasm", "SOURCE.txt"], work);
    if (pack.exitCode !== 0) return { refusal: `RELEASE_SOURCE tar ${code(pack)}` };
    return { path };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main(argv: string[]): Promise<number> {
  let values: { out?: string; upstream?: string };
  try {
    ({ values } = parseArgs({ args: argv, options: { out: { type: "string" }, upstream: { type: "string" } }, strict: true }));
  } catch {
    values = {};
  }
  if (values.out === undefined) {
    console.error("RELEASE_SOURCE usage hunspell-source.ts --out <dir> [--upstream <base>]");
    return 1;
  }
  const { version } = (await Bun.file(join(ROOT, "package.json")).json()) as { version: string };
  const result = hunspellSource({ version, out: values.out, upstream: values.upstream });
  if ("refusal" in result) {
    console.error(result.refusal);
    return 1;
  }
  console.log(result.path);
  return 0;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
