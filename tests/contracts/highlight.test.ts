// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// research.md R9: the shipped highlight set and the Vite module swap for Pierre 1.5.1.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bundleProblems } from "../../src/frontend/highlight/guard";
import { diffLanguage, shippedLanguage } from "../../src/frontend/highlight/language";
import * as oniguruma from "../../src/frontend/highlight/oniguruma";
import { LANGUAGES, SHIKI_VERSION, THEMES, TM_GRAMMARS_VERSION, TM_THEMES_VERSION } from "../../src/frontend/highlight/set";
import * as shiki from "../../src/frontend/highlight/shiki";
import * as themes from "../../src/frontend/highlight/themes";
import { OnigurumaUnavailableError } from "../../src/frontend/highlight/unavailable";
import * as wasm from "../../src/frontend/highlight/wasm";
import { printOrigin } from "../origin";

const ROOT = join(import.meta.dir, "..", "..");
printOrigin("../../src/frontend/highlight/shiki.ts", import.meta.dir);

// research.md R9: the chosen set after the licence review. yaml, toml, cpp, and ruby are not in it.
const CHOSEN = ["bat", "c", "csharp", "css", "diff", "docker", "go", "html", "ini", "java", "javascript", "json", "jsonc", "jsx", "kotlin", "make", "markdown", "php", "powershell", "python", "rust", "scss", "shellscript", "sql", "swift", "tsx", "typescript", "xml"];

describe("highlight set (research.md R9)", () => {
  test("the set lists exactly the chosen languages and the two themes", () => {
    expect(Object.keys(LANGUAGES).sort()).toEqual(CHOSEN);
    expect(Object.entries(THEMES).map(([name, t]) => `${name} ${t.colorScheme}`)).toEqual(["github-light light", "github-dark dark"]);
    const names = Object.entries(LANGUAGES).flatMap(([id, l]) => [id, ...l.aliases]);
    expect(Object.keys(shiki.bundledLanguages).sort()).toEqual(names.sort());
  });

  test("each grammar declares its id and exactly the listed aliases, and its embedded grammars are in the set", async () => {
    for (const [id, { aliases, load }] of Object.entries(LANGUAGES)) {
      const grammars = (await load()).default;
      const own = grammars.find((g) => g.name === id);
      expect(own?.aliases ?? []).toEqual(aliases);
      for (const g of grammars) expect(Object.keys(LANGUAGES)).toContain(g.name);
    }
  });

  test("the highlighter uses the JavaScript engine and tokenizes every language with both themes", async () => {
    const highlighter = await shiki.createHighlighter({ langs: Object.keys(LANGUAGES), themes: Object.keys(THEMES) });
    try {
      expect(highlighter.getLoadedThemes().sort()).toEqual(["github-dark", "github-light"]);
      for (const lang of Object.keys(LANGUAGES)) {
        const tokens = highlighter.codeToTokens("a = 1", { lang, themes: { light: "github-light", dark: "github-dark" } });
        expect(tokens.tokens.length).toBe(1);
      }
    } finally {
      highlighter.dispose();
    }
  });

  test("the Oniguruma engine refuses with a typed error, and the WASM module is inert", () => {
    expect(() => shiki.createOnigurumaEngine()).toThrow(OnigurumaUnavailableError);
    expect(wasm.default).toBeUndefined();
  });

  test("the theme collections hold only the two themes, and a theme loads with its own name", async () => {
    expect(themes.pierreThemes.getThemes()).toEqual([]);
    expect(themes.shikiThemes.getThemes().map((d) => d.name)).toEqual(["github-light", "github-dark"]);
    expect(themes.shikiThemes.getTheme("pierre-dark")).toBeUndefined();
    expect((await themes.shikiThemes.getTheme("github-dark")?.load())?.name).toBe("github-dark");
  });

  test("the installed Shiki packages are the release whose content research.md R10 compared with tm-grammars and tm-themes", () => {
    for (const name of ["@shikijs/langs", "@shikijs/themes", "shiki"]) {
      const manifest = JSON.parse(readFileSync(join(ROOT, "node_modules", name, "package.json"), "utf8")) as { version: string };
      expect(`${name}@${manifest.version}`).toBe(`${name}@${SHIKI_VERSION}`);
    }
  });

  test("the vendored notices name exactly the shipped grammar and theme files", () => {
    const files = (key: string) =>
      [...readFileSync(join(ROOT, "third-party-licenses", "npm", key, "NOTICE"), "utf8").matchAll(/^Files:\s+(.*)$/gm)].flatMap(([, list]) => (list ?? "").split(", ")).sort();
    expect(files(`tm-grammars@${TM_GRAMMARS_VERSION}`)).toEqual(CHOSEN.map((id) => `${id}.json`));
    expect(files(`tm-themes@${TM_THEMES_VERSION}`)).toEqual(["github-dark.json", "github-light.json"]);
  });
});

// The import clauses of Pierre's ES modules. worker-portable.js bundles its own Shiki copy and stays unused.
function pierreImports(): Map<string, Set<string>> {
  const dist = join(dirname(Bun.resolveSync("@pierre/diffs/package.json", ROOT)), "dist");
  const found = new Map<string, Set<string>>();
  for (const file of new Bun.Glob("**/*.js").scanSync({ cwd: dist })) {
    if (file.replaceAll("\\", "/") === "worker/worker-portable.js") continue;
    const source = readFileSync(join(dist, file), "utf8");
    for (const [, names, from] of source.matchAll(/^import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/gm)) {
      const set = found.get(from!) ?? new Set<string>();
      for (const name of names!.split(",")) if (name.trim() !== "") set.add(name.trim().split(/\s+as\s+/)[0]!);
      found.set(from!, set);
    }
    for (const [, from] of source.matchAll(/\bimport\("([^"]+)"\)/g)) found.set(from!, found.get(from!) ?? new Set(["default"]));
  }
  return found;
}

describe("file language (research.md R9)", () => {
  test("a name that Pierre maps outside the shipped set gives text; a shipped name stays", () => {
    expect(["a.yml", "Cargo.toml", "x/a.h", "src/a.ts", "run.sh", "Dockerfile"].map(shippedLanguage)).toEqual(["text", "text", "text", "typescript", "zsh", "dockerfile"]);
  });

  test("a diff is text when one side has no shipped language, else Pierre keeps its own choice per side", () => {
    expect(diffLanguage({ name: "a.ts", prevName: "a.yml" })).toBe("text");
    expect(diffLanguage({ name: "a.h" })).toBe("text");
    expect(diffLanguage({ name: "a.tsx", prevName: "a.jsx" })).toBeUndefined();
    expect(diffLanguage({ name: "a.ts" })).toBeUndefined();
  });
});

describe("Pierre module swap (research.md R9)", () => {
  printOrigin("@pierre/diffs/package.json", ROOT);
  const imports = pierreImports();

  test("each swapped module exports exactly the names that Pierre imports", () => {
    const exported = (m: object) => Object.keys(m).sort();
    expect([...(imports.get("shiki") ?? [])].sort()).toEqual(exported(shiki));
    expect([...(imports.get("shiki/engine/oniguruma") ?? [])].sort()).toEqual(exported(oniguruma));
    expect([...(imports.get("shiki/wasm") ?? [])].sort()).toEqual(exported(wasm));
    expect([...(imports.get("@pierre/theming/themes") ?? [])].sort()).toEqual(exported(themes));
  });

  test("Pierre imports no other Shiki entry that loads grammars, themes, or WASM", () => {
    const shikiSpecifiers = [...imports.keys()].filter((s) => s === "shiki" || s.startsWith("shiki/") || s.startsWith("@shikijs/") || s.startsWith("@pierre/theme") || s.startsWith("@pierre/theming")).sort();
    expect(shikiSpecifiers).toEqual(["@pierre/theming", "@pierre/theming/color", "@pierre/theming/themes", "@shikijs/transformers", "shiki", "shiki/core", "shiki/engine/javascript", "shiki/engine/oniguruma", "shiki/textmate", "shiki/wasm"]);
  });
});

describe("bundle check (research.md R9)", () => {
  const nm = "D:/repo/node_modules";
  const all = [...Object.keys(LANGUAGES).map((l) => `${nm}/@shikijs/langs/dist/${l}.mjs`), ...Object.keys(THEMES).map((t) => `${nm}/@shikijs/themes/dist/${t}.mjs`)];

  test("the shipped set without WASM passes", () => {
    expect(bundleProblems([...all, `${nm}/shiki/dist/core.mjs`, `${nm}/shiki/dist/langs/bat.mjs`], [{ file: "assets/a.js", text: "x" }], true)).toEqual([]);
  });

  test("an unlisted grammar or theme, a refused module, and WASM markers are problems", () => {
    const problems = bundleProblems(
      [...all, `${nm}/@shikijs/langs/dist/yaml.mjs`, `${nm}\\@shikijs\\themes\\dist\\nord.mjs`, `${nm}/@shikijs/engine-oniguruma/dist/index.mjs`, `${nm}/@pierre/theme/themes/pierre-dark.json`, `${nm}/shiki/dist/langs-bundle-full-xQVO1Cek.mjs`],
      [{ file: "assets/wasm-1.js", text: 'const w="AGFzbQEAAAAB"; loadWasm(w)' }, { file: "assets/onig.wasm", text: "\0asm\x01\0\0\0", bytes: new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]) }],
      true,
    );
    expect(problems).toEqual([
      `grammar yaml is not in the shipped set: ${nm}/@shikijs/langs/dist/yaml.mjs`,
      `theme nord is not in the shipped set: ${nm}\\@shikijs\\themes\\dist\\nord.mjs`,
      `refused module: ${nm}/@shikijs/engine-oniguruma/dist/index.mjs`,
      `refused module: ${nm}/@pierre/theme/themes/pierre-dark.json`,
      `refused module: ${nm}/shiki/dist/langs-bundle-full-xQVO1Cek.mjs`,
      "assets/wasm-1.js holds AGFzbQ",
      "assets/wasm-1.js holds loadWasm",
      "WebAssembly file: assets/onig.wasm",
    ]);
  });

  test("an asset with the WebAssembly magic passes only with the reviewed hunspell.wasm bytes, under any name (006 plan.md D9)", () => {
    const reviewed = new Uint8Array(readFileSync(join(ROOT, "node_modules", "hunspell-wasm", "wasm", "hunspell.wasm")));
    const changed = reviewed.slice();
    changed[changed.length - 1] ^= 1;
    const asset = (file: string, bytes: Uint8Array) => ({ file, text: new TextDecoder().decode(bytes), bytes });
    const names = ["assets/hunspell-B7u9vk2r.wasm", "assets/x.bin", "X.WASM"];
    expect(bundleProblems([], names.map((name) => asset(name, reviewed)), false)).toEqual([]);
    expect(bundleProblems([], names.map((name) => asset(name, changed)), false)).toEqual(names.map((name) => `WebAssembly file: ${name}`));
    // Bytes without the magic at offset 0 are no WebAssembly module, whatever the name.
    expect(bundleProblems([], [asset("assets/a.wasm", new Uint8Array([0x01, 0x00, 0x61, 0x73, 0x6d]))], false)).toEqual([]);
  });

  test("the page build must hold every shipped grammar and theme; the worker build need not", () => {
    expect(bundleProblems([], [], true)).toEqual([...Object.keys(LANGUAGES).map((l) => `grammar ${l} is not in the build`), ...Object.keys(THEMES).map((t) => `theme ${t} is not in the build`)]);
    expect(bundleProblems([], [], false)).toEqual([]);
  });
});
