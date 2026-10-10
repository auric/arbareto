// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T130: the third-party notice inventory (plan.md "Tool and runtime boundaries" and "About window", research.md R7 and R9).
// This build script runs under Bun and never enters the renderer bundle. tests/git/portable-imports.test.ts permits no runtime import under src/frontend, so it uses Bun globals only.

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
export type Shipped = { name: string; version?: string; license: string | undefined; files: LicenseFile[] };
export type Notices = {
  repositoryUrl: string;
  project: { license: string; notice: string };
  groups: { license: string; packages: { name: string; version?: string; files: LicenseFile[] }[] }[];
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

/** The normal-dependency closure of the `arbareto` workspace member. Proc-macro crates and their dependencies run only at build time. */
export function cargoClosure(metadata: CargoMetadata): Crate[] {
  const byId = new Map(metadata.packages.map((p) => [p.id, p]));
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  const root = metadata.packages.find((p) => p.name === "arbareto" && metadata.workspace_members.includes(p.id));
  if (!root) throw new Error("cargo metadata holds no arbareto workspace member");
  const seen = new Set<string>([root.id]);
  const stack = [root.id];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    for (const dep of nodes.get(id)?.deps ?? []) {
      const target = byId.get(dep.pkg);
      if (!target || seen.has(dep.pkg) || !dep.dep_kinds.some((k) => k.kind === null)) continue;
      if (target.targets.some((t) => t.kind.includes("proc-macro"))) continue;
      seen.add(dep.pkg);
      stack.push(dep.pkg);
    }
  }
  seen.delete(root.id);
  return [...seen].map((id) => {
    const p = byId.get(id) as CargoPackage;
    return { name: p.name, version: p.version, license: p.license ?? undefined, licenseFile: p.license_file ?? undefined, dir: parentDir(p.manifest_path) };
  });
}

// No npm or Cargo manifest field names the licence file of a package (cargo `license_file` is empty for every shipped crate).
// So this exact name set is the contract. It holds the names that the shipped packages use. A package without a match is refused.
// NOTICE files stay with the package: research.md R9 requires supplied NOTICE content.
const LICENSE_NAMES = new Set([
  "copying",
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
  const groups = new Map<string, Notices["groups"][number]["packages"]>();
  for (const item of shipped) {
    const label = item.version === undefined ? item.name : `${item.name} ${item.version}`;
    if (item.license === undefined || item.license.trim() === "") problems.push(`${label}: no licence name`);
    if (item.files.length === 0) problems.push(`${label}: no licence text`);
    const license = item.license ?? "";
    const group = groups.get(license) ?? [];
    group.push({ name: item.name, ...(item.version === undefined ? {} : { version: item.version }), files: item.files });
    groups.set(license, group);
  }
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const notices: Notices = {
    repositoryUrl,
    project,
    groups: [...groups]
      .sort(([a], [b]) => order(a, b))
      .map(([license, packages]) => ({ license, packages: packages.sort((a, b) => order(a.name, b.name) || order(a.version ?? "", b.version ?? "")) })),
  };
  return { notices, problems, code: problems.length === 0 ? 0 : 1 };
}

async function readLicenseFiles(dir: string, named: string | undefined): Promise<LicenseFile[]> {
  const names = named !== undefined ? [named] : licenseFileNames([...new Bun.Glob("*").scanSync({ cwd: dir, onlyFiles: true, dot: true })]);
  return Promise.all(names.map(async (name) => ({ name, text: await Bun.file(`${dir}/${name}`).text() })));
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
  if (cargo.exitCode !== 0) {
    console.error(`cargo metadata failed with exit code ${cargo.exitCode}`);
    return 1;
  }
  const { packages, problems: npmProblems } = npmClosure(lock, cssPackages(css));
  const shipped: Shipped[] = [];
  const problems = [...npmProblems];
  for (const p of packages) {
    const dir = `${root}/node_modules/${p.path.join("/node_modules/")}`;
    const installed = (await Bun.file(`${dir}/package.json`).json()) as { version?: string; license?: unknown };
    if (installed.version !== p.version) problems.push(`npm ${p.name}: node_modules holds ${String(installed.version)}, bun.lock holds ${p.version}`);
    shipped.push({ name: p.name, version: p.version, license: typeof installed.license === "string" ? installed.license : undefined, files: await readLicenseFiles(dir, undefined) });
  }
  for (const c of cargoClosure(JSON.parse(cargo.stdout.toString()) as CargoMetadata)) {
    shipped.push({ name: c.name, version: c.version, license: c.license, files: await readLicenseFiles(c.dir, c.licenseFile) });
  }
  // Tauri bundler 2.10.0 nsis/mod.rs:81-86: the NSIS toolset folder is `dirs::cache_dir()/tauri/NSIS`, which is %LOCALAPPDATA% on Windows.
  const nsis = `${process.env.LOCALAPPDATA ?? ""}/tauri/NSIS`;
  const nsisCopying = process.env.LOCALAPPDATA !== undefined && (await Bun.file(`${nsis}/COPYING`).exists());
  shipped.push({ name: "NSIS", license: "zlib/libpng, bzip2, CPL-1.0", files: nsisCopying ? await readLicenseFiles(nsis, "COPYING") : [] });
  // research.md R7 and R9 name these notices. This build has no offline source for their texts, so each one stays a refusal.
  shipped.push({ name: "Bun runtime linked components (JavaScriptCore, WebKit)", version: Bun.version, license: undefined, files: [] });
  shipped.push({ name: "Shiki grammars, themes, and Oniguruma WASM", license: undefined, files: [] });

  const project = { license: await Bun.file(`${root}/LICENSE`).text(), notice: await Bun.file(`${root}/NOTICE.md`).text() };
  const result = inventory(shipped, manifest.repository?.url ?? "", project);
  problems.push(...result.problems);
  // The file holds the inventory also after a refusal, so the About window and its tests still build. The exit code stops `bun run build`.
  await Bun.write(`${root}/src/frontend/generated/notices.json`, `${JSON.stringify(result.notices, null, 2)}\n`);
  const count = result.notices.groups.reduce((n, g) => n + g.packages.length, 0);
  console.log(`notices.json: ${count} entries in ${result.notices.groups.length} licence groups`);
  for (const problem of problems) console.error(`NOTICE_PROBLEM ${problem}`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
