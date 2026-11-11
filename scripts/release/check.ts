// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T009: the tag, version, main, tree, and signing checks (plan.md D3, contracts/release.md §2). The checks read the current working directory.

import { parseArgs } from "node:util";

const TAG = /^v(\d+\.\d+\.\d+)$/;
const SIGNPATH_NAMES = ["SIGNPATH_ORGANIZATION_ID", "SIGNPATH_PROJECT_SLUG", "SIGNPATH_POLICY_SLUG"] as const;
// Tauri merges the platform file and the --config overlay into tauri.conf.json, so none of them can set `version`.
const TAURI_CONFIGS = ["src-tauri/tauri.conf.json", "src-tauri/tauri.windows.conf.json", "src-tauri/tauri.preview.conf.json"] as const;
const PROCESS_TIMEOUT_MS = 120_000;
const USAGE = "RELEASE_CHECK usage check.ts --mode release --tag <name> --signing off|signpath | --mode dry-run --signing off|signpath";

class Refusal extends Error {}

function run(command: string[]): { code: number | string; stdout: string } {
  const proc = Bun.spawnSync(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: PROCESS_TIMEOUT_MS });
  return { code: proc.exitCode ?? proc.signalCode ?? "unknown", stdout: proc.stdout.toString() };
}

async function readJson(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Refusal(`RELEASE_CHECK input ${path}`);
  try {
    return JSON.parse(await file.text());
  } catch {
    throw new Refusal(`RELEASE_CHECK input ${path}`);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function cargoVersion(): string {
  const cargo = run(["cargo", "metadata", "--no-deps", "--format-version", "1", "--manifest-path", "src-tauri/Cargo.toml"]);
  if (cargo.code !== 0) throw new Refusal(`RELEASE_CHECK cargo-failed ${cargo.code}`);
  let metadata: unknown;
  try {
    metadata = JSON.parse(cargo.stdout);
  } catch {
    throw new Refusal("RELEASE_CHECK input cargo-metadata");
  }
  const packages = isObject(metadata) && Array.isArray(metadata.packages) ? metadata.packages.filter((p) => isObject(p) && p.name === "arbareto") : [];
  const version = packages.length === 1 ? (packages[0] as Record<string, unknown>).version : undefined;
  if (typeof version !== "string") throw new Refusal("RELEASE_CHECK input cargo-metadata");
  return version;
}

export async function check(argv: string[], env: Record<string, string | undefined>): Promise<void> {
  let values: { mode?: string; tag?: string; signing?: string };
  try {
    ({ values } = parseArgs({ args: argv, options: { mode: { type: "string" }, tag: { type: "string" }, signing: { type: "string" } }, strict: true }));
  } catch {
    throw new Refusal(USAGE);
  }
  const { mode, tag, signing } = values;
  if (signing === undefined || (mode === "release") !== (tag !== undefined) || (mode !== "release" && mode !== "dry-run")) throw new Refusal(USAGE);
  if (signing !== "off" && signing !== "signpath") throw new Refusal(`RELEASE_CHECK signing-value ${signing}`);
  if (signing === "signpath") {
    for (const name of SIGNPATH_NAMES) if (!env[name]) throw new Refusal(`RELEASE_CHECK signing-missing ${name}`);
    // The workflow sets SIGNPATH_TOKEN_SET to `${{ secrets.SIGNPATH_API_TOKEN != '' }}`, which is the text `true` or `false`.
    if (env.SIGNPATH_TOKEN_SET !== "true") throw new Refusal("RELEASE_CHECK signing-missing SIGNPATH_API_TOKEN");
  }

  const version = cargoVersion();
  const pkg = await readJson("package.json");
  if (!isObject(pkg) || typeof pkg.version !== "string") throw new Refusal("RELEASE_CHECK input package.json");
  if (pkg.version !== version) throw new Refusal(`RELEASE_CHECK version-mismatch ${version} ${pkg.version}`);
  for (const path of TAURI_CONFIGS) {
    if (path !== TAURI_CONFIGS[0] && !(await Bun.file(path).exists())) continue;
    const config = await readJson(path);
    if (!isObject(config)) throw new Refusal(`RELEASE_CHECK input ${path}`);
    if ("version" in config) throw new Refusal(`RELEASE_CHECK config-version ${path}`);
  }

  if (tag !== undefined) {
    if (TAG.exec(tag)?.[1] !== version) throw new Refusal(`RELEASE_CHECK tag-version ${tag} ${version}`);
    // git-merge-base(1): --is-ancestor exits 0 when the first commit is an ancestor, 1 when it is not. Other codes are errors.
    const ancestor = run(["git", "merge-base", "--is-ancestor", `refs/tags/${tag}^{commit}`, "refs/remotes/origin/main"]);
    if (ancestor.code === 1) throw new Refusal("RELEASE_CHECK not-on-main");
    if (ancestor.code !== 0) throw new Refusal(`RELEASE_CHECK git-failed ${ancestor.code}`);
    // Spec FR-014: the build identity is HEAD, so HEAD must be the tag commit.
    const [head, tagged] = ["HEAD^{commit}", `refs/tags/${tag}^{commit}`].map((rev) => {
      const parsed = run(["git", "rev-parse", "--verify", rev]);
      if (parsed.code !== 0) throw new Refusal(`RELEASE_CHECK git-failed ${parsed.code}`);
      return parsed.stdout.trimEnd();
    });
    if (head !== tagged) throw new Refusal("RELEASE_CHECK not-tag-commit");
  }

  const status = run(["git", "--no-optional-locks", "status", "--porcelain", "--untracked-files=all"]);
  if (status.code !== 0) throw new Refusal(`RELEASE_CHECK git-failed ${status.code}`);
  if (status.stdout !== "") throw new Refusal("RELEASE_CHECK dirty");
}

if (import.meta.main) {
  try {
    await check(Bun.argv.slice(2), process.env);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
