// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T005: fact F14 of 006 research.md R12. A throwaway Vite build of one module worker that imports hunspell-wasm.

import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { printOrigin } from "../origin";

const REPO = join(import.meta.dir, "..", "..");
const HUNSPELL = printOrigin("hunspell-wasm", import.meta.dir);
printOrigin("../../src/frontend/highlight/guard.ts", import.meta.dir);
const WASM_SHA256 = "72152324049c9215da17abceb12555b3ef9094c0524327e660f8145aaa9c68e0";
const BUILD_TIMEOUT_MS = 120_000;

test(
  "F14: the Vite build emits hunspell.wasm with the reviewed bytes, and the worker chunk names it through new URL(…, import.meta.url)",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "arbareto-f14-"));
    try {
      writeFileSync(join(root, "index.html"), `<!doctype html><script type="module" src="./main.js"></script>\n`);
      writeFileSync(join(root, "main.js"), `new Worker(new URL("./worker.js", import.meta.url), { type: "module" });\n`);
      writeFileSync(join(root, "worker.js"), `import { createHunspellFromStrings } from ${JSON.stringify(pathToFileURL(HUNSPELL).href)};\nself.onmessage = async (e) => self.postMessage((await createHunspellFromStrings(e.data[0], e.data[1])).testSpelling(e.data[2]));\n`);
      // The probe records the app bundle check of vite.config.ts on this output. It does not decide F14.
      writeFileSync(
        join(root, "vite.config.mjs"),
        `import { bundleProblems } from ${JSON.stringify(pathToFileURL(join(REPO, "src/frontend/highlight/guard.ts")).href)};
const guard = { name: "probe-guard", generateBundle(_o, bundle) {
  const ids = [], texts = [];
  for (const item of Object.values(bundle)) {
    if (item.type === "chunk") { ids.push(...item.moduleIds); texts.push({ file: item.fileName, text: item.code }); }
    else if (typeof item.source === "string") texts.push({ file: item.fileName, text: item.source });
    else texts.push({ file: item.fileName, text: new TextDecoder().decode(item.source), bytes: item.source });
  }
  console.log("GUARD " + JSON.stringify(bundleProblems(ids, texts, false)));
} };
export default { root: ${JSON.stringify(root)}, logLevel: "warn", worker: { format: "es", plugins: () => [guard] }, build: { outDir: ${JSON.stringify(join(root, "dist"))}, emptyOutDir: true } };
`,
      );
      const build = Bun.spawn([process.execPath, "x", "--bun", "vite", "build", "--config", join(root, "vite.config.mjs")], { cwd: REPO, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: BUILD_TIMEOUT_MS });
      const [out, err] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
      if (build.exitCode === null) process.kill(build.pid);
      console.log(out.replace(/^/gm, "vite> "));
      console.error(err.replace(/^/gm, "vite> "));
      const vite = (JSON.parse(readFileSync(join(REPO, "node_modules", "vite", "package.json"), "utf8")) as { version: string }).version;
      const guard = /^GUARD (.*)$/m.exec(out)?.[1] ?? "none";
      const files = build.exitCode === 0 ? (readdirSync(join(root, "dist"), { recursive: true }) as string[]).map((f) => f.replaceAll("\\", "/")) : [];
      const wasm = files.filter((f) => f.endsWith(".wasm"));
      const digests = wasm.map((f) => new Bun.CryptoHasher("sha256").update(readFileSync(join(root, "dist", f))).digest("hex"));
      const names = wasm.map((f) => f.split("/").at(-1)!);
      // Vite 8 writes the base as `new URL("<path>", "" + import.meta.url)`, with any of the three JavaScript quote forms.
      const reference = names.length === 1 ? new RegExp(`new URL\\(\\s*["'\`][^"'\`]*/${names[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]\\s*,\\s*(?:(?:""|''|\`\`)\\s*\\+\\s*)?import\\.meta\\.url\\s*\\)`) : null;
      const namedIn = files.filter((f) => f.endsWith(".js") && reference !== null && reference.test(readFileSync(join(root, "dist", f), "utf8")));
      const named = namedIn.length > 0;
      console.log(`OBSERVATION T005: F14 exit=${build.exitCode} wasm=${JSON.stringify(wasm)} sha256=${JSON.stringify(digests)} newUrl=${JSON.stringify(namedIn)} appGuard=${guard} vite=${vite} bun=${Bun.version}`);
      expect(build.exitCode).toBe(0);
      expect(digests).toEqual([WASM_SHA256]);
      expect(named).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  BUILD_TIMEOUT_MS + 10_000,
);
