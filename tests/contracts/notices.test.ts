// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { cargoShipped, cssPackages, inventory, licenseFileNames, npmClosure, vendoredKey, type BunLock, type CargoMetadata } from "../../src/frontend/build/notices";
import { printOrigin } from "../origin";

printOrigin("../../src/frontend/build/notices.ts", import.meta.dir);

// bun.lock form: `packages` keys are node_modules paths, and each value starts with "<name>@<version>".
const LOCK: BunLock = {
  workspaces: {
    "": {
      dependencies: { app: "^1.0.0", "@scope/ui": "^2.0.0" },
      devDependencies: { tool: "^1.0.0", shadcn: "^4.0.0" },
    },
  },
  packages: {
    app: ["app@1.0.0", "", { dependencies: { shared: "^1.0.0", nested: "^2.0.0" }, optionalDependencies: { gone: "^1.0.0" } }, "sha512-a"],
    "@scope/ui": ["@scope/ui@2.0.0", "", { dependencies: { shared: "^1.0.0" }, peerDependencies: { peer: "*" } }, "sha512-b"],
    shared: ["shared@1.0.0", "", {}, "sha512-c"],
    nested: ["nested@1.0.0", "", {}, "sha512-d"],
    "app/nested": ["nested@2.0.0", "", {}, "sha512-e"],
    peer: ["peer@1.0.0", "", {}, "sha512-f"],
    tool: ["tool@1.0.0", "", { dependencies: { "tool-dep": "^1.0.0" } }, "sha512-g"],
    "tool-dep": ["tool-dep@1.0.0", "", {}, "sha512-h"],
    shadcn: ["shadcn@4.21.4", "", { dependencies: { "tool-dep": "^1.0.0" } }, "sha512-i"],
    tailwindcss: ["tailwindcss@4.3.3", "", {}, "sha512-j"],
  },
};

const CSS = `/* @import "commented-out"; */
@import "tailwindcss";
@import 'shadcn/tailwind.css';
@import url("./local.css");
.a { color: red; }
`;

// cargo metadata --format-version 1 form, reduced to the read fields.
const pkg = (name: string, version: string, license: string | null, kind = "lib") => ({
  id: `${name}@${version}`,
  name,
  version,
  license,
  license_file: null,
  manifest_path: `C:\\cargo\\${name}-${version}\\Cargo.toml`,
  targets: [{ kind: [kind] }],
});
const dep = (pkgId: string, kind: string | null) => ({ pkg: pkgId, dep_kinds: [{ kind, target: null }] });
const METADATA: CargoMetadata = {
  workspace_members: ["arbareto@0.1.0"],
  packages: [
    pkg("arbareto", "0.1.0", "AGPL-3.0-or-later", "bin"),
    pkg("tauri", "2.12.0", "Apache-2.0 OR MIT"),
    pkg("serde", "1.0.228", "MIT OR Apache-2.0"),
    pkg("serde_derive", "1.0.228", "MIT OR Apache-2.0", "proc-macro"),
    pkg("syn", "2.0.0", "MIT OR Apache-2.0"),
    pkg("tauri-build", "2.7.0", "Apache-2.0 OR MIT"),
    pkg("tempfile", "3.0.0", "MIT OR Apache-2.0"),
  ],
  resolve: {
    root: "arbareto@0.1.0",
    nodes: [
      { id: "arbareto@0.1.0", deps: [dep("tauri@2.12.0", null), dep("tauri-build@2.7.0", "build"), dep("tempfile@3.0.0", "dev")] },
      { id: "tauri@2.12.0", deps: [dep("serde@1.0.228", null), dep("serde_derive@1.0.228", null)] },
      { id: "serde@1.0.228", deps: [] },
      { id: "serde_derive@1.0.228", deps: [dep("syn@2.0.0", null)] },
      { id: "syn@2.0.0", deps: [] },
      { id: "tauri-build@2.7.0", deps: [] },
      { id: "tempfile@3.0.0", deps: [] },
    ],
  },
};

const PROJECT = { license: "GNU AFFERO GENERAL PUBLIC LICENSE", notice: "# Arbareto notice" };
const REPO = "https://github.com/auric/arbareto";

describe("npm shipped set (T130)", () => {
  test("the CSS imports name the bare packages, without comments and relative files", () => {
    expect(cssPackages(CSS)).toEqual(["tailwindcss", "shadcn"]);
  });

  test("the set holds the dependencies closure and the CSS-imported packages, and no devDependencies-only package", () => {
    const { packages, problems } = npmClosure(LOCK, ["tailwindcss", "shadcn"]);
    expect(problems).toEqual([]);
    const shown = packages.map((p) => `${p.path.join("/")} ${p.name}@${p.version}`).sort();
    expect(shown).toEqual(["@scope/ui @scope/ui@2.0.0", "app app@1.0.0", "app/nested nested@2.0.0", "shadcn shadcn@4.21.4", "shared shared@1.0.0", "tailwindcss tailwindcss@4.3.3"]);
    // A CSS-imported package adds its own files only, not its dependencies.
    expect(shown.some((s) => s.includes("tool"))).toBe(false);
    // The hoisted `nested@1.0.0` and the peer stay out: no shipped package resolves to them.
    expect(shown.some((s) => s.includes("peer") || s.includes("nested@1.0.0"))).toBe(false);
  });

  test("an unresolved dependency and an absent CSS package are problems", () => {
    const broken: BunLock = { ...LOCK, packages: { ...LOCK.packages, app: ["app@1.0.0", "", { dependencies: { lost: "^1.0.0" } }, "x"] } };
    expect(npmClosure(broken, ["missing-css"]).problems).toEqual(["npm app@1.0.0: dependency lost is not in bun.lock", "npm missing-css: CSS import is not in bun.lock"]);
  });
});

// `cargo tree -e normal,no-proc-macro --prefix none` form: "<name> v<version>", then an optional source and a "(*)" repeat marker.
const TREE = "arbareto v0.1.0 (C:\\src\\src-tauri)\ntauri v2.12.0\nserde v1.0.228\nserde v1.0.228 (*)\n";

describe("Cargo shipped set (T130, T338)", () => {
  test("the set holds the cargo tree crates without arbareto, with the cargo metadata licence and folder", () => {
    const { crates, problems } = cargoShipped(TREE, METADATA);
    expect(problems).toEqual([]);
    expect(crates.map((c) => `${c.name}@${c.version} ${c.license}`).sort()).toEqual(["serde@1.0.228 MIT OR Apache-2.0", "tauri@2.12.0 Apache-2.0 OR MIT"]);
    expect(crates.find((c) => c.name === "tauri")?.dir).toBe("C:\\cargo\\tauri-2.12.0");
  });

  test("a line of another form and a crate without one cargo metadata package are problems", () => {
    const { crates, problems } = cargoShipped("tauri v2.12.0\n├── serde v1.0.228\nunknown v9.9.9\n", METADATA);
    expect(crates.map((c) => c.name)).toEqual(["tauri"]);
    expect(problems).toEqual(['cargo tree line is not "<name> v<version>": ├── serde v1.0.228', "cargo unknown 9.9.9: cargo metadata holds 0 packages"]);
  });
});

describe("vendored licence texts (T338)", () => {
  const KEYS = new Set(["npm/lru_map@0.4.1", "cargo/alloc-stdlib@0.3.0"]);

  test("a vendored folder applies only to its exact ecosystem, name, and version", () => {
    expect(vendoredKey(KEYS, "npm", "lru_map", "0.4.1")).toBe("npm/lru_map@0.4.1");
    expect(vendoredKey(KEYS, "cargo", "alloc-stdlib", "0.3.0")).toBe("cargo/alloc-stdlib@0.3.0");
  });

  test("a version or ecosystem mismatch finds no folder, so the package stays a refusal", () => {
    expect(vendoredKey(KEYS, "npm", "lru_map", "0.4.2")).toBeUndefined();
    expect(vendoredKey(KEYS, "cargo", "lru_map", "0.4.1")).toBeUndefined();
    const result = inventory([{ name: "lru_map", version: "0.4.2", license: "MIT", files: [] }], REPO, PROJECT);
    expect(result.problems).toEqual(["lru_map 0.4.2: no licence text"]);
  });
});

describe("licence texts and inventory (T130)", () => {
  test("@hugeicons/react takes LICENSE.md, not PRO-LICENSE.md", () => {
    expect(licenseFileNames(["CHANGELOG.md", "LICENSE.md", "PRO-LICENSE.md", "README.md", "package.json"])).toEqual(["LICENSE.md"]);
  });

  test("a dual-licensed crate keeps every licence file, and NOTICE content stays", () => {
    expect(licenseFileNames(["Cargo.toml", "LICENSE-APACHE", "LICENSE-MIT", "LICENSE.spdx", "NOTICE.md", "src"])).toEqual(["LICENSE-APACHE", "LICENSE-MIT", "NOTICE.md"]);
  });

  test("the output groups full licence texts by licence name and holds repository.url", () => {
    const result = inventory(
      [
        { name: "react", version: "19.3.0", license: "MIT", files: [{ name: "LICENSE", text: "MIT License\nCopyright Meta" }] },
        { name: "serde", version: "1.0.228", license: "MIT OR Apache-2.0", files: [{ name: "LICENSE-MIT", text: "mit" }, { name: "LICENSE-APACHE", text: "apache" }] },
        { name: "clsx", version: "2.1.1", license: "MIT", files: [{ name: "license", text: "MIT License\nCopyright Luke" }] },
      ],
      REPO,
      PROJECT,
    );
    expect(result.code).toBe(0);
    expect(result.problems).toEqual([]);
    expect(result.notices.repositoryUrl).toBe(REPO);
    expect(result.notices.project).toEqual(PROJECT);
    expect(result.notices.groups.map((g) => [g.license, g.packages.map((p) => p.name)])).toEqual([
      ["MIT", ["clsx", "react"]],
      ["MIT OR Apache-2.0", ["serde"]],
    ]);
    expect(result.notices.groups[0]?.packages[1]?.files).toEqual([{ name: "LICENSE", text: "MIT License\nCopyright Meta" }]);
  });

  test("a shipped package without licence text gives a non-zero exit", () => {
    const result = inventory([{ name: "lru_map", version: "0.4.1", license: "MIT", files: [] }], REPO, PROJECT);
    expect(result.code).not.toBe(0);
    expect(result.problems).toEqual(["lru_map 0.4.1: no licence text"]);
  });

  test("an empty repository.url gives a non-zero exit", () => {
    const result = inventory([{ name: "react", version: "19.3.0", license: "MIT", files: [{ name: "LICENSE", text: "t" }] }], "", PROJECT);
    expect(result.code).not.toBe(0);
    expect(result.problems).toEqual(["package.json repository.url is empty"]);
  });
});
