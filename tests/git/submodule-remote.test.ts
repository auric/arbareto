// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T253: the fallback remote rule of contract §12 "Update protocol" step 5, against real superprojects.
// Oracles: the `submodule.<name>.url` that `git submodule init` writes in a copy, and `git submodule--helper get-default-remote <path>` (research.md R14 S23, S32).
// The helper is a test-only oracle. The product never runs it.

import { describe, expect, test } from "bun:test";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { fallbackRemote, resolveGitmodulesUrl, type GitPlatform, type RemoteContext } from "../../src/git-service/submodule-remote";
import { parseConfigListing } from "../../src/git-service/trust";
import { printOrigin } from "../origin";
import { FIXTURE_ROOT, fixtureDir, ownedGit, useFixtureRoot } from "./fixture-root";
import { gitPath, TIMEOUT_MS } from "./hunk-harness";
import { configMap, miniGit, miniWorld, type MiniSub, type MiniWorld } from "./submodule-harness";

printOrigin("../../src/git-service/submodule-remote.ts", import.meta.dir);

useFixtureRoot();

// The native Git of the run: Git for Windows on Windows, else a POSIX Git.
const PLATFORM: GitPlatform = process.platform === "win32" ? "windows" : "posix";

const line = (text: string) => text.replace(/\n$/, "");
const configOf = (w: MiniWorld, dir: string, extra: string[] = []) => configMap(miniGit(w, dir, ["config", "list", ...extra, "-z"]));

// The inputs of the product: `config list --show-scope --show-origin -z` and `symbolic-ref -q HEAD`.
function contextOf(w: MiniWorld, dir: string): RemoteContext {
  const listing = parseConfigListing(ownedGit(gitPath(), FIXTURE_ROOT, dir, ["config", "list", "--show-scope", "--show-origin", "-z"], { env: w.env }), false);
  if (listing === null) throw new Error("config listing refused");
  return { listing, headRef: line(miniGit(w, dir, ["symbolic-ref", "-q", "HEAD"], [0, 1])) || null };
}

const worktreeRoot = (w: MiniWorld, dir: string) => line(miniGit(w, dir, ["rev-parse", "--show-toplevel"]));

// The version text of the Git that runs the fixture, such as `2.56.0.windows.1`.
function versionOf(w: MiniWorld): string {
  const m = /^git version (\S+)$/.exec(line(miniGit(w, w.root, ["version"])));
  if (m === null) throw new Error("git version output refused");
  return m[1]!;
}

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
      test(`${parent}: the ${form.label} form resolves to the submodule.<name>.url that git submodule init writes`, () => {
        const w = world(parent);
        const name = formName(i);
        const url = configOf(w, w.sup.dir, ["--file", ".gitmodules"])[`submodule.${name}.url`]![0]!;
        // Git resolves against its current folder, so the product reads the same disposable copy that `git submodule init` runs in.
        const copy = join(w.root, `init-${slug(parent)}-${i}`);
        cpSync(w.sup.dir, copy, { recursive: true });
        expect(miniGit(w, copy, ["config", "--local", "--get-regexp", "^submodule\\."], [0, 1])).toBe("");
        const resolved = resolveGitmodulesUrl(url, contextOf(w, copy), worktreeRoot(w, copy), PLATFORM);
        miniGit(w, copy, ["submodule", "init"]);
        const written = configOf(w, copy, ["--local"])[`submodule.${name}.url`];
        expect({ form: form.label, url: [resolved] }).toEqual({ form: form.label, url: written });
      }, TIMEOUT_MS);
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
    test(`${c.label}: the chosen remote equals the helper output, and the resolved URL equals the registered URL`, () => {
      const name = `t253-remote-${i}`;
      const w = miniWorld(name, [{ name: "solo", path: "solo", url: "../solo.git" }], c.global);
      if (c.label.startsWith("a parent")) miniGit(w, w.sup.dir, ["config", "remote.origin.url", "fake:super.git"]);
      const gitmodulesUrl = configOf(w, w.sup.dir, ["--file", ".gitmodules"])["submodule.solo.url"]![0]!;
      miniGit(w, w.sup.dir, ["submodule", "update", "--init", "-q", "--", "solo"]);
      const sub = join(w.sup.dir, "solo");
      c.setup(w, sub);
      const registered = configOf(w, w.sup.dir, ["--local"])["submodule.solo.url"]![0]!;
      const helper = line(miniGit(w, w.sup.dir, ["submodule--helper", "get-default-remote", "solo"]));
      const names = miniGit(w, sub, ["remote"]).split("\n").filter((n) => n !== "");
      const remoteUrls = new Map(names.map((n) => [n, miniGit(w, sub, ["remote", "get-url", "--all", "--", n]).split("\n").filter((u) => u !== "")]));
      const resolved = resolveGitmodulesUrl(gitmodulesUrl, contextOf(w, w.sup.dir), worktreeRoot(w, w.sup.dir), PLATFORM);
      const chosen = fallbackRemote(resolved, contextOf(w, sub), remoteUrls, versionOf(w));
      expect({ case: c.label, resolved, chosen }).toEqual({ case: c.label, resolved: registered, chosen: helper });
    }, TIMEOUT_MS);
  });
});
