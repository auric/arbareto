// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T253: the fallback remote rule of contract §12 "Update protocol" step 5. `src/git-service/submodule-remote.ts` comes with T254.
// Oracles: the `submodule.<name>.url` that `git submodule init` writes in a copy, and `git submodule--helper get-default-remote <path>` (research.md R14 S23, S32).
// The helper is a test-only oracle. The product never runs it.

import { describe, expect } from "bun:test";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { fixtureDir, useFixtureRoot } from "./fixture-root";
import { todoCase } from "./hunk-harness";
import { configMap, miniGit, miniWorld, underTestSubmodule, type MiniSub, type MiniWorld } from "./submodule-harness";

const TASK = "T253";
const NEEDS = "(needs T254)";

useFixtureRoot();

// Assumed T254 API. The inputs are exact parses of Git output: `config list -z`, `symbolic-ref -q --short HEAD`, and `remote get-url --all -- <name>`.
interface SubmoduleRemote {
  // Contract §12: a relative URL resolves against the raw parent `remote.<default remote>.url`, else against the parent worktree root.
  resolveSubmoduleUrl(input: { url: string; parentConfig: Record<string, string[]>; parentBranch: string | null; parentWorktree: string }): string;
  // Contract §12: the first remote whose rewritten URL equals the resolved URL, else the default remote.
  chooseFallbackRemote(input: { resolvedUrl: string; config: Record<string, string[]>; branch: string | null; remoteUrls: Record<string, string[]> }): string;
}

const remoteModule = async () => (await underTestSubmodule("submodule-remote")) as unknown as SubmoduleRemote;

const headBranch = (w: MiniWorld, dir: string) => miniGit(w, dir, ["symbolic-ref", "-q", "--short", "HEAD"], [0, 1]).trim() || null;
const configOf = (w: MiniWorld, dir: string, extra: string[] = []) => configMap(miniGit(w, dir, ["config", "list", ...extra, "-z"]));

// ---- Resolved URL ----

// The `.gitmodules` URL forms of contract §12 and the task text. `root` is the fixture folder with `/`.
const FORMS: { label: string; url: (root: string) => string; relative: boolean }[] = [
  { label: "absolute URL", url: () => "https://host.example/x.git", relative: false },
  { label: "local path", url: (root) => `${root}/solo.git`, relative: false },
  { label: "scp-like host:path", url: () => "host.example:x.git", relative: false },
  { label: "./x", url: () => "./x", relative: true },
  { label: "../x", url: () => "../x", relative: true },
  { label: "../../x", url: () => "../../x", relative: true },
  { label: "trailing /", url: () => "../x/", relative: true },
  { label: "Windows path with \\ (relative)", url: () => "..\\x", relative: true },
  { label: "Windows path with \\ (absolute)", url: (root) => `${root}/solo.git`.replaceAll("/", "\\"), relative: false },
];

type Parent = "default remote" | "no default remote" | "insteadOf parent";
const PARENTS: Parent[] = ["default remote", "no default remote", "insteadOf parent"];
const slug = (text: string) => text.replaceAll(" ", "-");
const formName = (i: number) => `form${i}`;

// `git submodule init` in a disposable copy. Each `submodule.<name>.url` key is unset before that run.
function initOracle(w: MiniWorld, copyName: string): Record<string, string[]> {
  const copy = join(w.root, copyName);
  cpSync(w.sup.dir, copy, { recursive: true });
  expect(miniGit(w, copy, ["config", "--local", "--get-regexp", "^submodule\\."], [0, 1])).toBe("");
  miniGit(w, copy, ["submodule", "init"]);
  return configOf(w, copy, ["--local"]);
}

describe("resolved URL equals `git submodule init` (contract §12, research.md R14 S32)", () => {
  const worlds = new Map<Parent, MiniWorld>();
  // One superproject per parent form, built once. The `insteadOf` parent keeps the raw `fake:` value of `remote.origin.url`, as a clone from `fake:super.git` writes it.
  function world(parent: Parent): MiniWorld {
    const found = worlds.get(parent);
    if (found !== undefined) return found;
    const name = `t253-${slug(parent)}`;
    const root = fixtureDir(name).replaceAll("\\", "/");
    const subs: MiniSub[] = FORMS.map((f, i) => ({ name: formName(i), path: formName(i), url: f.url(root) }));
    const w = miniWorld(name, subs, parent === "insteadOf parent" ? (r) => `[url "${r}/"]\n\tinsteadOf = fake:\n` : undefined);
    if (parent === "no default remote") miniGit(w, w.sup.dir, ["remote", "remove", "origin"]);
    if (parent === "insteadOf parent") miniGit(w, w.sup.dir, ["config", "remote.origin.url", "fake:super.git"]);
    worlds.set(parent, w);
    return w;
  }

  for (const parent of PARENTS) {
    FORMS.forEach((form, i) => {
      if (parent !== "default remote" && !form.relative) return;
      todoCase(TASK, `${parent}: the ${form.label} form resolves to the submodule.<name>.url that git submodule init writes ${NEEDS}`, [], async () => {
        const w = world(parent);
        const name = formName(i);
        const url = configOf(w, w.sup.dir, ["--file", ".gitmodules"])[`submodule.${name}.url`]![0]!;
        const written = initOracle(w, `init-${slug(parent)}-${i}`)[`submodule.${name}.url`];
        const m = await remoteModule();
        const resolved = m.resolveSubmoduleUrl({ url, parentConfig: configOf(w, w.sup.dir), parentBranch: headBranch(w, w.sup.dir), parentWorktree: w.sup.dir });
        expect({ form: form.label, url: [resolved] }).toEqual({ form: form.label, url: written });
      });
    });
  }
});

// ---- Chosen remote ----

interface RemoteCase {
  label: string;
  // Global lines of the world. `root` is the fixture folder with `/`.
  global?: (root: string) => string;
  // Runs after the clone of `solo` into the superproject. `sub` is the submodule worktree.
  setup: (w: MiniWorld, sub: string) => void;
}

const CASES: RemoteCase[] = [
  { label: "one remote", setup: () => {} },
  {
    label: "two remotes with a match through url.<base>.insteadOf",
    global: (root) => `[url "${root}/"]\n\tinsteadOf = fake:\n`,
    setup: (w, sub) => {
      miniGit(w, sub, ["remote", "set-url", "origin", `${w.root.replaceAll("\\", "/")}/elsewhere.git`]);
      miniGit(w, sub, ["remote", "add", "second", "fake:solo.git"]);
    },
  },
  {
    label: "two remotes without a match",
    setup: (w, sub) => {
      miniGit(w, sub, ["remote", "set-url", "origin", `${w.root.replaceAll("\\", "/")}/elsewhere.git`]);
      miniGit(w, sub, ["remote", "add", "second", `${w.root.replaceAll("\\", "/")}/other.git`]);
    },
  },
  {
    label: "a branch remote",
    setup: (w, sub) => {
      miniGit(w, sub, ["remote", "set-url", "origin", `${w.root.replaceAll("\\", "/")}/elsewhere.git`]);
      miniGit(w, sub, ["remote", "add", "second", `${w.root.replaceAll("\\", "/")}/other.git`]);
      miniGit(w, sub, ["switch", "-q", "-c", "work"]);
      miniGit(w, sub, ["config", "branch.work.remote", "second"]);
    },
  },
  {
    // research.md R14 S32: the resolved URL keeps the raw parent value, so it differs from the rewritten remote URL.
    label: "a parent remote.origin.url that an insteadOf rule rewrites, with two submodule remotes",
    global: (root) => `[url "${root}/"]\n\tinsteadOf = fake:\n`,
    setup: (w, sub) => {
      miniGit(w, sub, ["remote", "add", "second", `${w.root.replaceAll("\\", "/")}/other.git`]);
    },
  },
];

describe("chosen remote equals `git submodule--helper get-default-remote` (contract §12, research.md R14 S23)", () => {
  CASES.forEach((c, i) => {
    todoCase(TASK, `${c.label}: the chosen remote equals the helper output, and the resolved URL equals the registered URL ${NEEDS}`, [], async () => {
      const name = `t253-remote-${i}`;
      const w = miniWorld(name, [{ name: "solo", path: "solo", url: "../solo.git" }], c.global);
      if (c.label.startsWith("a parent")) miniGit(w, w.sup.dir, ["config", "remote.origin.url", "fake:super.git"]);
      const gitmodulesUrl = configOf(w, w.sup.dir, ["--file", ".gitmodules"])["submodule.solo.url"]![0]!;
      miniGit(w, w.sup.dir, ["submodule", "update", "--init", "-q", "--", "solo"]);
      const sub = join(w.sup.dir, "solo");
      c.setup(w, sub);
      const registered = configOf(w, w.sup.dir, ["--local"])["submodule.solo.url"]![0]!;
      const helper = miniGit(w, w.sup.dir, ["submodule--helper", "get-default-remote", "solo"]).trim();
      const config = configOf(w, sub);
      const names = Object.keys(config)
        .filter((key) => key.startsWith("remote.") && key.endsWith(".url"))
        .map((key) => key.slice("remote.".length, -".url".length));
      const remoteUrls = Object.fromEntries(names.map((n) => [n, miniGit(w, sub, ["remote", "get-url", "--all", "--", n]).split("\n").filter((u) => u !== "")]));
      const m = await remoteModule();
      const resolved = m.resolveSubmoduleUrl({ url: gitmodulesUrl, parentConfig: configOf(w, w.sup.dir), parentBranch: headBranch(w, w.sup.dir), parentWorktree: w.sup.dir });
      const chosen = m.chooseFallbackRemote({ resolvedUrl: resolved, config, branch: headBranch(w, sub), remoteUrls });
      expect({ case: c.label, resolved, chosen }).toEqual({ case: c.label, resolved: registered, chosen: helper });
    });
  });
});
