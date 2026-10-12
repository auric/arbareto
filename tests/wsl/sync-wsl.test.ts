// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T006: the T005 Git facts (a) to (l) inside the WSL distro (plan.md P0.2). The fixtures live in the owned distro folder and use the distro Git, never `/mnt`.
// Each fact prints `OBSERVATION T006` lines. A `match=false` line is a finding for research.md, not a failure.

import { expect } from "bun:test";
import { FACTS, gitVersion, observationLine } from "../git/remote-facts";
import type { GitHost } from "../git/remote-fixtures";
import { sha256 } from "../git/git-oracle";
import { useWslFolder, WSL_MINIMUM_GIT, wslExec, wslTest, type WslHost } from "./wsl-host";

useWslFolder();

const TASK = "T006";
const FACT_MS = 1_800_000;
const NEEDS = ["distro-git-2.55", "wsl-fixture-fs-id"] as const;
const FIXED_DATE = "2026-01-01T00:00:00+0000";
const GLOBAL_TEXT = "[user]\n\tname = Arbareto Fixture\n\temail = fixture@arbareto.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n";

// A `GitHost` for the distro. Each call is one `wsl.exe --exec` with an argument array; `env -i` starts the program with only the listed variables.
function distroHost(w: WslHost): GitHost {
  const git = w.probe.paths.git;
  if (!git) throw new Error("no distro Git");
  const root = `${w.folder}/remote`;
  const home = `${w.folder}/home`;
  const globalConfig = `${home}/.gitconfig`;
  const systemConfig = `${home}/system.gitconfig`;
  const owned = (path: string) => {
    if (!path.startsWith(`${w.folder}/`)) throw new Error(`outside the owned folder: ${path}`);
    return path;
  };
  const sh = (script: string, args: string[], input?: Uint8Array) => wslExec(["--distribution", w.distro, "--cd", "/", "--exec", "/bin/sh", "-c", script, "sh", ...args], { input, timeoutMs: 300_000 });
  const must = (r: ReturnType<typeof sh>, what: string) => {
    if (r.exitCode !== 0) throw new Error(`${what} exited ${r.exitCode}: ${r.stderr}`);
    return r;
  };
  const write = (path: string, content: string | Uint8Array) => {
    const bytes = Buffer.from(content);
    const script = 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1" && if [ "$2" = x ]; then chmod 755 -- "$1"; fi';
    must(sh(script, [owned(path), bytes.subarray(0, 2).toString("latin1") === "#!" ? "x" : "-"], bytes), `write ${path}`);
  };
  must(sh('mkdir -p -- "$1" "$2"', [owned(root), owned(home)]), "mkdir");
  write(globalConfig, GLOBAL_TEXT);
  write(systemConfig, "");
  return {
    label: w.distro,
    root,
    systemConfig,
    globalConfig,
    run(cwd, args, options = {}) {
      const env: Record<string, string> = {
        HOME: home,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_SYSTEM: systemConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_DATE: FIXED_DATE,
        GIT_COMMITTER_DATE: FIXED_DATE,
      };
      for (const [key, value] of Object.entries(options.env ?? {})) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
      const vars = Object.entries(env).map(([k, v]) => `${k}=${v}`);
      const r = wslExec(["--distribution", w.distro, "--cd", owned(cwd), "--exec", "/usr/bin/env", "-i", ...vars, git, ...args], { input: options.input, timeoutMs: options.timeoutMs ?? 120_000 });
      return { exitCode: r.exitCode ?? -1, stdout: Buffer.from(r.bytes), stderr: Buffer.from(r.stderr) };
    },
    write,
    read(path) {
      const r = sh('[ -e "$1" ] || exit 3; cat -- "$1"', [owned(path)]);
      if (r.exitCode === 3) return null;
      return Buffer.from(must(r, `read ${path}`).bytes);
    },
    existing(paths) {
      const r = must(sh('for p; do [ -e "$p" ] && printf \'%s\\0\' "$p"; done; exit 0', paths.map(owned)), "existing");
      return Buffer.from(r.bytes).toString("utf8").split("\0").filter((p) => p !== "");
    },
    copy(from, to) {
      must(sh('cp -a -- "$1" "$2"', [owned(from), owned(to)]), `copy ${from}`);
    },
    digests(worktree) {
      const digests: Record<string, string> = {};
      // GNU sha256sum -z ends each record with NUL and turns off file name escaping.
      const files = must(sh('cd -- "$1" && find . -path ./.git -prune -o -type f -print0 | xargs -0 -r sha256sum -z --', [owned(worktree)]), "sha256sum");
      for (const record of Buffer.from(files.bytes).toString("utf8").split("\0")) {
        if (record === "") continue;
        const m = /^([0-9a-f]{64}) [ *]\.\/([\s\S]+)$/.exec(record);
        if (m === null) throw new Error(`sha256sum record refused: ${JSON.stringify(record)}`);
        digests[m[2]!] = m[1]!;
      }
      const links = Buffer.from(must(sh('cd -- "$1" && find . -path ./.git -prune -o -type l -printf \'%P\\0%l\\0\'', [owned(worktree)]), "links").bytes).toString("utf8").split("\0");
      for (let i = 0; i + 1 < links.length; i += 2) digests[links[i]!] = `link:${sha256(Buffer.from(links[i + 1]!))}`;
      return Object.fromEntries(Object.entries(digests).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    },
  };
}

function atLeastFloor(version: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (m === null) return false;
  for (let i = 0; i < 3; i++) if (Number(m[i + 1]) !== WSL_MINIMUM_GIT[i]) return Number(m[i + 1]) > WSL_MINIMUM_GIT[i]!;
  return true;
}

let host: GitHost | undefined;
const h = (w: WslHost) => (host ??= distroHost(w));

wslTest("distro Git version", NEEDS, (w) => {
  const version = gitVersion(h(w));
  console.log(observationLine(TASK, version, { fact: "version", expected: `>=${WSL_MINIMUM_GIT.join(".")}`, observed: version, match: atLeastFloor(version) }));
});

for (const fact of FACTS) {
  wslTest(`(${fact.id}) ${fact.title}`, NEEDS, (w) => {
    const version = gitVersion(h(w));
    const observations = fact.run(h(w));
    expect(observations.length).toBeGreaterThan(0);
    for (const o of observations) console.log(observationLine(TASK, `${version}@${w.distro}`, o));
  }, FACT_MS);
}
