// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T130: the third-party notice inventory (plan.md "Tool and runtime boundaries" and "About window", research.md R7 and R9).
// This build script runs under Bun and never enters the renderer bundle. tests/git/portable-imports.test.ts permits no runtime import under src/frontend, so it uses Bun globals only.

import { TM_GRAMMARS_VERSION, TM_THEMES_VERSION } from "../highlight/set";

type LockEntry = [string, ...unknown[]];
type LockMeta = { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
export type BunLock = { workspaces: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>; packages: Record<string, LockEntry> };
/** One npm package. `path` is the bun.lock key as package names, so the install folder is `node_modules/<path joined by /node_modules/>`. */
export type NpmPackage = { path: string[]; name: string; version: string };

type CargoPackage = { id: string; name: string; version: string; license: string | null; license_file: string | null; manifest_path: string; targets: { kind: string[] }[] };
export type CargoMetadata = {
  workspace_members: string[];
  packages: CargoPackage[];
  resolve: { root?: string | null; nodes: { id: string; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }[] };
};
export type Crate = { name: string; version: string; license: string | undefined; licenseFile: string | undefined; dir: string };

export type LicenseFile = { name: string; text: string };
export type Shipped = { name: string; version?: string; license: string | undefined; files: LicenseFile[]; note?: string };
/** A licence file of the output. `text` is the index of its text in `Notices.texts`. */
export type NoticeFile = { name: string; text: number };
export type Notices = {
  repositoryUrl: string;
  project: { license: string; notice: string };
  /** Each distinct licence text once. Files share a text only when the texts are byte-identical. */
  texts: string[];
  groups: { license: string; packages: { name: string; version?: string; files: NoticeFile[]; note?: string }[] }[];
};

// "<name>@<version>": a scoped name starts with "@", so the version separator is the last "@".
function ident(entry: LockEntry): { name: string; version: string } {
  const at = entry[0].lastIndexOf("@");
  return { name: entry[0].slice(0, at), version: entry[0].slice(at + 1) };
}

/** The bare package names that `@import` rules name, in source order. Comments and relative or absolute URLs give none. */
export function cssPackages(css: string): string[] {
  const names: string[] = [];
  for (const [, , specifier] of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/@import\s+(?:url\(\s*)?(["'])([^"']+)\1/g)) {
    if (specifier === undefined || /^(?:[./]|[a-z][a-z0-9+.-]*:)/i.test(specifier)) continue;
    const segments = specifier.split("/");
    const name = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? "");
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * The `dependencies` and `optionalDependencies` closure of the root workspace, plus the CSS-imported packages without their dependencies.
 * A bun.lock key is a node_modules path, so a dependency resolves as Node does: the nearest `<ancestor>/<name>` key, then `<name>`.
 */
export function npmClosure(lock: BunLock, cssImported: string[]): { packages: NpmPackage[]; problems: string[] } {
  const packages = new Map<string, NpmPackage>();
  const problems: string[] = [];
  const resolve = (from: string[], name: string): string[] | undefined => {
    for (let depth = from.length; depth >= 0; depth -= 1) {
      const path = [...from.slice(0, depth), name];
      if (lock.packages[path.join("/")]) return path;
    }
    return undefined;
  };
  const visit = (path: string[]) => {
    const key = path.join("/");
    const entry = lock.packages[key];
    if (packages.has(key) || !entry) return;
    packages.set(key, { path, ...ident(entry) });
    const meta = (entry[2] ?? {}) as LockMeta;
    for (const name of Object.keys(meta.dependencies ?? {})) {
      const found = resolve(path, name);
      if (found) visit(found);
      else problems.push(`npm ${entry[0]}: dependency ${name} is not in bun.lock`);
    }
    // An optional dependency without a bun.lock entry is not installed.
    for (const name of Object.keys(meta.optionalDependencies ?? {})) {
      const found = resolve(path, name);
      if (found) visit(found);
    }
  };
  for (const name of Object.keys(lock.workspaces[""]?.dependencies ?? {})) {
    if (lock.packages[name]) visit([name]);
    else problems.push(`npm root: dependency ${name} is not in bun.lock`);
  }
  for (const name of cssImported) {
    const entry = lock.packages[name];
    if (entry) packages.set(name, { path: [name], ...ident(entry) });
    else problems.push(`npm ${name}: CSS import is not in bun.lock`);
  }
  return { packages: [...packages.values()], problems };
}

const parentDir = (file: string) => file.slice(0, Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")));

/**
 * The crates in `cargo tree -e normal,no-proc-macro --prefix none` output, without workspace members, joined to `cargo metadata` by name and version.
 * `cargo metadata` unifies features across build and normal dependencies, so its resolve graph also holds build-only crates.
 */
export function cargoShipped(tree: string, metadata: CargoMetadata): { crates: Crate[]; problems: string[] } {
  const crates = new Map<string, Crate>();
  const problems: string[] = [];
  for (const line of tree.split(/\r?\n/)) {
    if (line === "") continue;
    const match = /^(\S+) v(\S+)(?: .*)?$/.exec(line);
    if (!match) {
      problems.push(`cargo tree line is not "<name> v<version>": ${line}`);
      continue;
    }
    const [, name, version] = match as unknown as [string, string, string];
    const found = metadata.packages.filter((p) => p.name === name && p.version === version);
    const p = found[0];
    if (found.length !== 1 || !p) problems.push(`cargo ${name} ${version}: cargo metadata holds ${found.length} packages`);
    else if (!metadata.workspace_members.includes(p.id) && !crates.has(p.id)) {
      crates.set(p.id, { name, version, license: p.license ?? undefined, licenseFile: p.license_file ?? undefined, dir: parentDir(p.manifest_path) });
    }
  }
  return { crates: [...crates.values()], problems };
}

/** The `third-party-licenses` folder key for one exact ecosystem, name, and version, when that folder exists. */
export function vendoredKey(keys: ReadonlySet<string>, ecosystem: "npm" | "cargo" | "runtime" | "tools", name: string, version: string): string | undefined {
  const key = `${ecosystem}/${name}@${version}`;
  return keys.has(key) ? key : undefined;
}

// research.md R10 (T366, T390): Bun 1.4.4 embeds the typescript-go type checker, so Apache-2.0 §4(d) requires its NOTICE.txt.
export const BUN_RUNTIME_FILES = ["LICENSE.md", "typescript-go-NOTICE.txt"] as const;

/** The required Bun runtime files that the vendored runtime folder does not hold. */
export function missingRuntimeFiles(names: readonly string[]): string[] {
  return BUN_RUNTIME_FILES.filter((name) => !names.includes(name));
}

// No npm or Cargo manifest field names the licence file of a package (cargo `license_file` is empty for every shipped crate).
// So this exact name set is the contract. It holds the names that the shipped packages use. A package without a match is refused.
// NOTICE files stay with the package: research.md R9 requires supplied NOTICE content.
const LICENSE_NAMES = new Set([
  "copying",
  "copying.lesser",
  "copying.mpl",
  "licence",
  "license",
  "license.md",
  "license.txt",
  "license.mit",
  "license.bsd-3-clause",
  "license-apache",
  "license-apache.md",
  "license-apache-2.0",
  "license_apache-2.0",
  "license-libm-mit",
  "license-mit",
  "license-mit.md",
  "license-mit.txt",
  "license_mit",
  "license-third-party",
  "license-unicode",
  "license-zlib.md",
  "notice",
  "notice.md",
  "unlicense",
]);

/** The licence and notice files among the file names at a package root, in sorted order. */
export function licenseFileNames(names: string[]): string[] {
  return names.filter((name) => LICENSE_NAMES.has(name.toLowerCase())).sort();
}

/** Groups the full licence texts by licence name. `code` is the process exit code. */
export function inventory(shipped: Shipped[], repositoryUrl: string, project: Notices["project"]): { notices: Notices; problems: string[]; code: 0 | 1 } {
  const problems: string[] = [];
  if (repositoryUrl.trim() === "") problems.push("package.json repository.url is empty");
  const groups = new Map<string, { name: string; version?: string; files: LicenseFile[]; note?: string }[]>();
  for (const item of shipped) {
    const label = item.version === undefined ? item.name : `${item.name} ${item.version}`;
    if (item.license === undefined || item.license.trim() === "") problems.push(`${label}: no licence name`);
    if (item.files.length === 0) problems.push(`${label}: no licence text`);
    const license = item.license ?? "";
    const group = groups.get(license) ?? [];
    group.push({ name: item.name, ...(item.version === undefined ? {} : { version: item.version }), files: item.files, ...(item.note === undefined ? {} : { note: item.note }) });
    groups.set(license, group);
  }
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  // Map keys compare strings by exact code units, so only identical texts share an index.
  const ids = new Map<string, number>();
  const texts: string[] = [];
  const id = (text: string) => {
    let n = ids.get(text);
    if (n === undefined) {
      n = texts.push(text) - 1;
      ids.set(text, n);
    }
    return n;
  };
  const sorted = [...groups]
    .sort(([a], [b]) => order(a, b))
    .map(([license, packages]) => ({
      license,
      packages: packages
        .sort((a, b) => order(a.name, b.name) || order(a.version ?? "", b.version ?? ""))
        .map((p) => ({ ...p, files: p.files.map((f) => ({ name: f.name, text: id(f.text) })) })),
    }));
  const notices: Notices = { repositoryUrl, project, texts, groups: sorted };
  return { notices, problems, code: problems.length === 0 ? 0 : 1 };
}

/** `named` undefined: the licence file names at `dir`. `named` null: every file at `dir`. */
async function readLicenseFiles(dir: string, named: string | undefined | null): Promise<LicenseFile[]> {
  const all = [...new Bun.Glob("*").scanSync({ cwd: dir, onlyFiles: true, dot: true })];
  const names = named === null ? all.sort() : named !== undefined ? [named] : licenseFileNames(all);
  return Promise.all(names.map(async (name) => ({ name, text: await Bun.file(`${dir}/${name}`).text() })));
}

// 006 plan.md D18: no tarball file names the Hunspell source, so this fixed note joins its entry.
export const PACKAGE_NOTES: Record<string, string> = {
  "hunspell-wasm":
    "Arbareto uses Hunspell under LGPL-2.1. Source: https://github.com/rotemdan/hunspell-wasm (commit 8f755ef64e8b047b77b676f9698b3dfa5cb1887d) and https://github.com/hunspell/hunspell.",
};

/** The npm entries with their installed licence files, a vendored folder when the package has none, and the fixed notes. */
export async function npmShipped(root: string, packages: NpmPackage[], vendoredKeys: ReadonlySet<string>): Promise<{ shipped: Shipped[]; problems: string[] }> {
  const shipped: Shipped[] = [];
  const problems: string[] = [];
  for (const p of packages) {
    const dir = `${root}/node_modules/${p.path.join("/node_modules/")}`;
    const installed = (await Bun.file(`${dir}/package.json`).json()) as { version?: string; license?: unknown };
    if (installed.version !== p.version) problems.push(`npm ${p.name}: node_modules holds ${String(installed.version)}, bun.lock holds ${p.version}`);
    const own = await readLicenseFiles(dir, undefined);
    const key = vendoredKey(vendoredKeys, "npm", p.name, p.version);
    const files = own.length > 0 || key === undefined ? own : await readLicenseFiles(`${root}/third-party-licenses/${key}`, null);
    const note = PACKAGE_NOTES[p.name];
    shipped.push({ name: p.name, version: p.version, license: typeof installed.license === "string" ? installed.license : undefined, files, ...(note === undefined ? {} : { note }) });
  }
  return { shipped, problems };
}

// Tauri bundler 2.10.0 nsis/mod.rs:38-41 pins nsis-3.11.zip. research.md R10 records the vendored COPYING.
export const NSIS_VERSION = "3.11";
// tauri-cli 2.12.0 Cargo.toml pins `tauri-bundler = "=2.10.0"`. Another CLI release can bring another NSIS.
export const TAURI_CLI_VERSION = "tauri-cli 2.12.0\n";

/** A problem unless `cargo tauri --version` printed exactly `TAURI_CLI_VERSION`. */
export function tauriCliProblem(stdout: string): string[] {
  return stdout === TAURI_CLI_VERSION ? [] : [`cargo tauri --version printed ${JSON.stringify(stdout)}, the NSIS ${NSIS_VERSION} pin needs ${JSON.stringify(TAURI_CLI_VERSION)}`];
}

/** True when the Tauri CLI runs this build for a Windows target. tauri-cli 2.12.0 sets `TAURI_ENV_PLATFORM` for `beforeBuildCommand`. */
export function needsCliPin(env: Record<string, string | undefined>): boolean {
  return env.TAURI_ENV_PLATFORM === "windows";
}

/** A problem unless `makensis.exe /VERSION` printed exactly `v<NSIS_VERSION>`. */
export function makensisProblem(stdout: string): string[] {
  return stdout === `v${NSIS_VERSION}` ? [] : [`NSIS ${NSIS_VERSION}: %LOCALAPPDATA%\\tauri\\NSIS\\makensis.exe /VERSION printed ${JSON.stringify(stdout)}`];
}

/**
 * The NSIS entry from `third-party-licenses/tools/nsis@<NSIS_VERSION>`. `beforeBuildCommand` runs before the bundler downloads NSIS, so the build cannot read the bundler copy.
 * A bundler copy at `<localAppData>/tauri/NSIS/COPYING` that differs from the vendored text is a problem: a bundler upgrade brought another NSIS.
 * A `makensis.exe` in that folder that does not print `v<NSIS_VERSION>` is also a problem.
 */
export async function nsisShipped(vendored: string, keys: ReadonlySet<string>, localAppData: string | undefined): Promise<{ shipped: Shipped; problems: string[] }> {
  const key = vendoredKey(keys, "tools", "nsis", NSIS_VERSION);
  const files = key === undefined ? [] : await readLicenseFiles(`${vendored}/${key}`, null);
  const problems: string[] = [];
  // Tauri bundler 2.10.0 nsis/mod.rs:81-86: the NSIS toolset folder is `dirs::cache_dir()/tauri/NSIS`, which is %LOCALAPPDATA% on Windows.
  const bundlerCopy = localAppData === undefined ? undefined : Bun.file(`${localAppData}/tauri/NSIS/COPYING`);
  const copying = files.find((f) => f.name === "COPYING")?.text;
  if (copying !== undefined && bundlerCopy !== undefined && (await bundlerCopy.exists()) && (await bundlerCopy.text()) !== copying) {
    problems.push(`NSIS ${NSIS_VERSION}: %LOCALAPPDATA%\\tauri\\NSIS\\COPYING differs from third-party-licenses/tools/nsis@${NSIS_VERSION}/COPYING`);
  }
  // The bundler reuses an existing NSIS folder whatever its version.
  const makensis = localAppData === undefined ? undefined : `${localAppData}/tauri/NSIS/makensis.exe`;
  if (makensis !== undefined && (await Bun.file(makensis).exists())) {
    const version = Bun.spawnSync([makensis, "/VERSION"], { stdin: "ignore", stdout: "pipe", stderr: "inherit", timeout: 120_000 });
    problems.push(...(version.exitCode === 0 ? makensisProblem(version.stdout.toString()) : [`NSIS ${NSIS_VERSION}: makensis.exe /VERSION exit code ${version.exitCode}`]));
  }
  return { shipped: { name: "NSIS", license: "zlib/libpng, bzip2, CPL-1.0", files }, problems };
}

async function main(): Promise<number> {
  const root = `${import.meta.dir}/../../..`;
  const manifest = (await Bun.file(`${root}/package.json`).json()) as { repository?: { url?: string } };
  const lock = Bun.JSONC.parse(await Bun.file(`${root}/bun.lock`).text()) as BunLock;
  const css = await Bun.file(`${root}/src/frontend/index.css`).text();
  // `--offline` keeps the build off the network. Cargo then fails when a locked crate is not in the local registry cache.
  const cargo = Bun.spawnSync(
    ["cargo", "metadata", "--manifest-path", "src-tauri/Cargo.toml", "--format-version", "1", "--locked", "--offline", "--filter-platform", "x86_64-pc-windows-msvc"],
    { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "inherit", timeout: 120_000 },
  );
  // T149 uses this command as the oracle for the linked crate set.
  const tree = Bun.spawnSync(
    ["cargo", "tree", "-e", "normal,no-proc-macro", "--target", "x86_64-pc-windows-msvc", "--prefix", "none", "--locked", "--offline", "--manifest-path", "src-tauri/Cargo.toml"],
    { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "inherit", timeout: 120_000 },
  );
  if (cargo.exitCode !== 0 || tree.exitCode !== 0) {
    console.error(`cargo metadata exit code ${cargo.exitCode}, cargo tree exit code ${tree.exitCode}`);
    return 1;
  }
  // Each folder third-party-licenses/<ecosystem>/<name>@<version> holds the texts that one package release does not carry. research.md R10 records their sources.
  const vendored = `${root}/third-party-licenses`;
  const vendoredKeys = new Set([...new Bun.Glob("**/*").scanSync({ cwd: vendored, onlyFiles: true })].map((file) => parentDir(file).replaceAll("\\", "/")));
  const filesOf = async (packageFiles: LicenseFile[], key: string | undefined) =>
    packageFiles.length > 0 || key === undefined ? packageFiles : readLicenseFiles(`${vendored}/${key}`, null);
  const { packages, problems: npmProblems } = npmClosure(lock, cssPackages(css));
  const npm = await npmShipped(root, packages, vendoredKeys);
  const shipped: Shipped[] = npm.shipped;
  const problems = [...npmProblems, ...npm.problems];
  const cargoSet = cargoShipped(tree.stdout.toString(), JSON.parse(cargo.stdout.toString()) as CargoMetadata);
  problems.push(...cargoSet.problems);
  for (const c of cargoSet.crates) {
    const files = await filesOf(await readLicenseFiles(c.dir, c.licenseFile), vendoredKey(vendoredKeys, "cargo", c.name, c.version));
    shipped.push({ name: c.name, version: c.version, license: c.license, files });
  }
  // The NSIS bundle builds only for a Tauri Windows target, so only that build needs the CLI pin.
  if (needsCliPin(process.env)) {
    const cli = Bun.spawnSync(["cargo", "tauri", "--version"], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "inherit", timeout: 120_000 });
    problems.push(...(cli.exitCode === 0 ? tauriCliProblem(cli.stdout.toString()) : [`cargo tauri --version exit code ${cli.exitCode}`]));
  }
  const nsis = await nsisShipped(vendored, vendoredKeys, process.env.LOCALAPPDATA);
  shipped.push(nsis.shipped);
  problems.push(...nsis.problems);
  // research.md R7: Bun is MIT, and it statically links LGPL-2 JavaScriptCore and WebKit and other libraries. Its LICENSE.md lists them.
  const bunKey = vendoredKey(vendoredKeys, "runtime", "bun", Bun.version);
  const bunFiles = await filesOf([], bunKey);
  for (const name of missingRuntimeFiles(bunFiles.map((f) => f.name))) problems.push(`Bun runtime ${Bun.version}: no ${name}`);
  shipped.push({ name: "Bun runtime and linked components", version: Bun.version, license: "MIT, LGPL-2.0 (JavaScriptCore, WebKit), and linked-library licences", files: bunFiles });
  // research.md R9 and R10: the shipped Shiki grammars and themes come from these releases, and every shipped entry is MIT.
  // The vite.config.ts bundle check refuses Oniguruma WASM in the build, so it needs no notice.
  for (const [name, version] of [["tm-grammars", TM_GRAMMARS_VERSION], ["tm-themes", TM_THEMES_VERSION]] as const) {
    shipped.push({ name, version, license: "MIT", files: await filesOf([], vendoredKey(vendoredKeys, "npm", name, version)) });
  }

  const project = { license: await Bun.file(`${root}/LICENSE`).text(), notice: await Bun.file(`${root}/NOTICE.md`).text() };
  const result = inventory(shipped, manifest.repository?.url ?? "", project);
  problems.push(...result.problems);
  // The file holds the inventory also after a refusal, so the About window and its tests still build. The exit code stops `bun run build`.
  await Bun.write(`${root}/src/frontend/generated/notices.json`, `${JSON.stringify(result.notices)}\n`);
  const count = result.notices.groups.reduce((n, g) => n + g.packages.length, 0);
  console.log(`notices.json: ${count} entries in ${result.notices.groups.length} licence groups`);
  for (const problem of problems) console.error(`NOTICE_PROBLEM ${problem}`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
