// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Usage: bun .claude/skills/ponytail-review/update.ts [--check]
// Exit codes: 0 current or updated, 3 behind (only with --check), 1 error.
// Upstream publishes GitHub releases. The latest release is the authoritative version.
// The script only writes downloaded files. It never runs them.
const REPO = "DietrichGebert/ponytail";
const UPSTREAM_DIR = "skills/ponytail-review";
const MAX_BYTES = 256 * 1024;
const SHA_RE = /^[0-9a-f]{40}$/;
const dir = import.meta.dir;
const sourcePath = `${dir}/SOURCE.md`;

async function get(url: string, accept?: string): Promise<Uint8Array> {
  if (!url.startsWith("https://")) throw new Error(`refused non-HTTPS URL ${url}`);
  const headers: Record<string, string> = { "User-Agent": "arbareto-ponytail-update" };
  if (accept) headers.Accept = accept;
  const res = await fetch(url, { headers, redirect: "error" });
  if (!res.ok || !res.body) throw new Error(`GET ${url} returned HTTP ${res.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > MAX_BYTES) throw new Error(`GET ${url} exceeds ${MAX_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function latest(): Promise<{ tag: string; sha: string }> {
  const release = JSON.parse(text(await get(`https://api.github.com/repos/${REPO}/releases/latest`, "application/vnd.github+json")));
  const tag = release.tag_name;
  if (typeof tag !== "string" || !/^v?\d+\.\d+\.\d+$/.test(tag)) throw new Error(`unexpected release tag ${JSON.stringify(tag)}`);
  // The commits endpoint peels annotated tags to the commit.
  const sha = text(await get(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(tag)}`, "application/vnd.github.sha")).trim();
  if (!SHA_RE.test(sha)) throw new Error(`unexpected commit SHA for ${tag}`);
  return { tag, sha };
}

async function recorded(): Promise<{ version: string; sha: string }> {
  const match = /Version: ponytail plugin (\S+), commit ([0-9a-f]{40})\./.exec(await Bun.file(sourcePath).text());
  if (!match) throw new Error(`no version line in ${sourcePath}`);
  return { version: match[1]!, sha: match[2]! };
}

async function main(): Promise<number> {
  const check = process.argv.includes("--check");
  const old = await recorded();
  const next = await latest();
  const oldLabel = `${old.version} (${old.sha.slice(0, 7)})`;
  const newLabel = `${next.tag} (${next.sha.slice(0, 7)})`;
  if (check) {
    if (old.sha === next.sha) {
      console.log("current");
      return 0;
    }
    console.log(`behind: ${oldLabel} -> ${newLabel}`);
    return 3;
  }
  const base = `https://raw.githubusercontent.com/${REPO}/${next.sha}`;
  const skill = await get(`${base}/${UPSTREAM_DIR}/SKILL.md`);
  const license = await get(`${base}/LICENSE`);
  const hash = new Bun.CryptoHasher("sha256").update(skill).digest("hex");
  await Bun.write(`${dir}/SKILL.md`, skill);
  await Bun.write(`${dir}/LICENSE`, license);
  await Bun.write(
    sourcePath,
    `Origin: https://github.com/${REPO}/blob/${next.sha}/${UPSTREAM_DIR}/SKILL.md (MIT, see LICENSE).\n` +
      `Version: ponytail plugin ${next.tag}, commit ${next.sha}. SHA-256 of SKILL.md: ${hash}. Updated on ${new Date().toISOString().slice(0, 10)}.\n` +
      "Do not edit SKILL.md here. Run `bun .claude/skills/ponytail-review/update.ts` and review the diff.\n",
  );
  console.log(`${oldLabel} -> ${newLabel}`);
  return 0;
}

try {
  process.exit(await main());
} catch (error) {
  console.error(`ponytail-review update failed: ${String(error instanceof Error ? error.message : error).replace(/\s+/g, " ")}`);
  process.exit(1);
}
